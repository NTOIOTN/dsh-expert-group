/**
 * Expert Group 快照的**阶段投影**（票据 09 / R2 从 host/expert-group-runtime.js 拆出）。
 *
 * 唯一阶段：普通 expert 阶段（`collectExperts`）——按 child_models / recovery 记录收集本根
 * 专家，冷读走本次构建的共享协调器（受控并发），最后按输入顺序投影成快照节点。
 * fan-out 整体移除后，父任务 / 分片 / attempt 的三层阶段投影（`projectFanoutTasks` →
 * `projectFanoutTask` → `projectFanoutShard`）已随 fan-out 一并删除。
 *
 * 边界（plan R2.2-a §3/§6）：
 * - 本模块**不 import** `host/expert-group-projection.js` 与 `host/snapshot-cache.js`：纯投影 helper
 *   由 runtime 以 `deps.project`（冻结命令集合）注入，归属判定只经 `deps.resolveChildOwnership`
 *   调用。因此 stage 只持有**命令**，不持有 Map、不读任何 owner 的状态；
 * - `deps` 里**没有** `cache` / `snapshotCache` / entry / `sortAnchor`：阶段投影绝不写缓存。
 *
 * 首错契约（不得回归）：阶段内所有已调度的读取都 settle 之后才抛出**首个**错误（按输入顺序稳定，
 * 与完成时序无关），因此失败返回时不会有残留冷读。
 *
 * @module dsh-expert-group/host/expert-group-stage
 */
// 历史数据兼容判定与恢复选择器共用唯一来源（见 shared/fanout-history.js）：
// 投影与恢复必须对「哪些 child_models 记录属于已删除的 fan-out」给出同一结论，
// 否则旧记录会被恢复路径排除、却仍出现在普通专家树里。
import { isHistoricalFanoutChildRecord } from "../shared/fanout-history.js";

/**
 * 受控并发的遍历（彼此独立的项并行、并发数有上限）。
 *
 * 与 `for...of await` 的区别：互不依赖的项不再互相等待；与裸
 * `Promise.all(items.map(worker))` 的区别：同时进行的 worker 数有上限。
 *
 * 失败生命周期（与串行循环一致：错误原样上抛，且不留下仍在后台进行的读取）：
 * - 首个 worker 抛错时**立即停止领取新项**，但已经启动的 worker 不取消、不提前放弃；
 * - 仍然等待所有已启动 worker 全部 settle：迟到的成功照常写回，迟到的失败被收敛在这里
 *   （不覆盖首个错误、不重新抛出，因此不会产生未处理的 rejection）；
 * - 全部 settle 之后才向调用方**原样抛出首个错误对象**，所以本函数返回或抛出时都不会残留
 *   后台 worker：快照失败后同一 root 的立即重试不会与旧批次的读取重叠；
 * - 成功路径不变：受控并发 + 完成顺序无关（调用方按输入顺序取用结果）。
 *
 * `limit` 由调用方从本次构建的协调器（`coordinator.limit`）取，保证与真实 readSession 的
 * 全局上限是同一个数字（单一事实源，不复制常量）。
 */
async function forEachWithConcurrency(items, limit, worker) {
  if (items.length === 0) return;
  const size = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  let stopped = false;
  let failed = false;
  let firstError;
  const run = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        // 首个失败决定最终抛出的错误并立即停止领取新项；随后到达的失败只在这里被收敛。
        if (!failed) {
          failed = true;
          firstError = error;
          stopped = true;
        }
      }
    }
  };
  // run 从不在内部抛出：Promise.all 因而总会等到所有已启动 worker settle（含迟到的成功与失败），
  // 既不会留下仍在后台进行的读取，也不会产生未处理的 rejection。
  await Promise.all(Array.from({ length: size }, () => run()));
  if (failed) throw firstError;
}

/**
 * 普通专家阶段投影。
 *
 * @param {object} root - 本次构建的根（live / 冷读 / 占位三种形状）。
 * @param {object} deps - 窄依赖（见 runtime builder 的 stageDeps）。
 * @returns {Promise<object[]>} 按输入顺序排列的 expert 节点。
 */
export async function collectExperts(root, deps) {
  const {
    project, recoveryRecords, agents, persisted, coordinator, recovery, now,
    usageFor, roleLabelOf, projectionTitleOf, fast,
    // 父会话 durable catalog 的 label 映射（Map<childId, 任务名>，可能为空）：历史 child_models
    // 的 lastDispatch 被写回抹掉时，用它与 lastDispatch 同语义地兜底任务名。
    catalogLabels,
    // 任务名兜底映射（Map<childId, 展示名> | undefined）：只由运行时在 **fast 构建**时传入，
    // 内容取自同一 root 上一份完整快照。这里只读它，绝不修改（deps 已 Object.freeze）。
    previousExpertTaskNames,
  } = deps;
  const {
    safeCall, firstText, sessionEvents, sessionTitle, dispatchedPrompt, expertStatus,
    runSummary, turnTimingOf, modelMetadata, createdAtOf, collectParentEvidence,
    parentEvidenceVerdict, usageOfChild, structuredOfChild, outputSchemaRequestedOfChild,
  } = project;

  const ids = new Set();
  for (const record of recoveryRecords.values()) {
    if (record?.parentId === root.id && typeof record?.childId === "string") ids.add(record.childId);
  }
  for (const [childId, child] of Object.entries(persisted)) {
    // 历史 fan-out child 不得进入普通专家树：判定与恢复选择器同一份（唯一来源），
    // 因此只带 fanoutAttempt / fanoutParentAgentId 等身份字段、没有 fanout:true 的旧记录
    // 在这里同样被排除，不会出现「恢复跳过但任务树仍显示」的不一致。
    if (child?.parentId === root.id && !isHistoricalFanoutChildRecord(child)) ids.add(childId);
  }

  // 第一步（同步，顺序 = ids）：只做筛选与归属判定，把需要投影的 child 按原顺序收进 candidates。
  // 跳过条件与归属语义（显式父证据冲突/缺失一律 fail-closed）与串行实现完全一致。
  const candidates = [];
  for (const childId of ids) {
    const record = recoveryRecords.get(childId);
    const childSnapshot = persisted[childId];
    // 第二道闸门：id 也可能来自 recovery 记录（上面的循环），因此这里再按同一判定过滤一次；
    // 两张表对历史 fan-out 记录的口径必须一致，绝不按字段子集各判一套。
    if (isHistoricalFanoutChildRecord(childSnapshot)) continue;
    const agent = safeCall(() => agents?.get?.(childId), undefined) ?? record?.agent;
    const cachedSession = record?.session;
    // 只按 record.parentId 就直接使用 record.session 是不安全的：record 可能停留在旧代际，
    // 而 live/cached session 的 header.parentSession 已经指向别的 root。这里要求所有显式
    // 父证据一致指向本根，否则（冲突或缺失）一律 fail-closed 拒绝投影。
    const evidence = collectParentEvidence({ agent, record, childSnapshot, session: cachedSession });
    if (parentEvidenceVerdict(evidence, root.id) !== "owned") continue;
    // live child（recovery 缓存会话或在线 agent 会话）已经有可投影的会话对象：不进并发池、
    // 不等待任何冷读，保持原有快速路径；两者都缺失时才在第二步补一次冷读。
    candidates.push({ childId, record, childSnapshot, agent, session: cachedSession ?? agent?.session });
  }

  // 第二步（受控并发）：冷读之间互不依赖（各自只读一份日志，不引用彼此结果），串行会让总等待
  // 时间随 child 数线性增长，因此交给受控并发池。每次读取都走本次构建的共享协调器，与 root
  // 全部冷读共用同一份 promise 缓存和同一个全局并发上限；这里的
  // forEachWithConcurrency 只负责本阶段的顺序与失败收敛语义。
  // 每个 child 读到的会话写回各自的 candidate，读取内容、归属校验与错误语义都不变；
  // live/cached 会话在上面已被快速跳过。
  // 失败时本阶段会先停止领取新项、等已启动的读取全部 settle，再把首个错误原样抛出，因此
  // 构建失败返回时不会有残留的冷读，snapshotInFlight 清理后同一 root 的立即重试也不会与
  // 旧批次重叠（并发上限仍然只有一个批次的量级）。
  // 轻量路径（fast）**完全跳过**这一步：没有 live/cached 会话的 candidate 保持 session 为
  // undefined，绝不触发任何 sessionQuery.readSession——这正是首屏 5~15s 的根因。
  if (fast !== true) {
    await forEachWithConcurrency(candidates, coordinator.limit, async (candidate) => {
      if (candidate.session !== undefined && candidate.session !== null) return;
      candidate.session = await coordinator.read(candidate.childId, root.id);
    });
  }

  // 第三步（同步，顺序 = candidates = ids）：投影顺序只由 candidates 决定，与冷读完成顺序无关，
  // 因此并发不会改变快照里 expert 的既有顺序。
  const experts = [];
  for (const candidate of candidates) {
    const { childId, record, childSnapshot, agent, session } = candidate;
    const events = sessionEvents(session);
    const context = safeCall(() => recovery?.contextFor?.(record), undefined) ?? record?.recoveryRequest;
    const sessionPrompt = dispatchedPrompt(session, events);
    const metadata = modelMetadata(agent, childSnapshot, context);
    const status = expertStatus({ agent, record, session, events });
    const mode = record?.continuable === true || childSnapshot?.continuable === true
      || agent?.options?.__degExpertContinuable === true ? "continuable" : "unknown";
    /**
     * 轻量路径的「证据不足」判定：既没有 live/cached 会话，也没有 live agent。
     *
     * 这种情况下 expertStatus 的 ready/idle 只是「读不到东西」的兜底值，客户端的活动证据链
     * 会把它读成「已结束/空闲」；因此降级为词表里的 unknown，并**省略 running 布尔**，
     * 让客户端落回「没有活动证据」，从而渲染中性圆点、不输出活动文案。
     * 注意：终态（succeeded/failed/…）本来就必须由 turn/end 证明，这里的降级不可能伪造终态；
     * 而 running/waiting 这类有真实证据的状态不受影响。
     */
    const evidenceFree = fast === true && (session === undefined || session === null)
      && (agent === undefined || agent === null);
    const projectedStatus = evidenceFree && (status === "ready" || status === "idle") ? "unknown" : status;
    // 用量（票据 25）：live 账本优先，其次 child_models.usage；无有效样本时省略整个字段。
    const usage = usageOfChild(childId, persisted, usageFor);
    // 结构化交付（票据 30）：只读投影；缺失省略，绝不伪造回退/空值。
    const structured = structuredOfChild(childId, persisted);
    const outputSchemaRequested = outputSchemaRequestedOfChild(childId, persisted);
    // 该会话全部 turn 的累计墙钟用时 + 最后一个 open turn 起点（与 DSH 状态行 "用时 …" 同源，
    // 但不含轮次之间的空闲）；一次扫描同时得到两者。没有可证明的区间时各自省略。
    const timing = turnTimingOf(events, now());
    experts.push({
      id: childId,
      kind: "expert",
      sessionId: childId,
      parentSessionId: root.id,
      // 全部 turn 的累计墙钟用时（与 DSH 状态行同源，空闲区间不计）；没有真实 turn 区间时省略。
      ...(timing.durationMs === null ? {} : { turnDurationMs: timing.durationMs }),
      // open turn 起点（additive）：客户端据此在两次权威快照之间锚定外推；闭合时省略。
      ...(timing.openSince === null ? {} : { turnOpenSince: timing.openSince }),
      // context.label 是最新 accepted dispatch 的短描述；冷恢复再读持久 child model。
      // 降级顺序：context.label → lastDispatch.description → catalogLabels → projectionTitleOf
      //           → sessionTitle → 上一份 full 的展示名。
      //
      // 为什么 catalogLabels 插在 lastDispatch 之后、sessionTitle 之前：它是父会话 durable
      // `subagent/catalog` 事件里的**派发 label**，语义与 lastDispatch.description 完全相同
      // （都是「这个任务叫什么」）。历史 child_models 的 lastDispatch 被旧实现整条写回抹掉后，
      // 这正是唯一还活着的名字；若把它排在 sessionTitle 之后，历史行仍会显示 prompt 首句，
      // 修复就失去意义。
      // 前四级（label → description → catalog → projectionTitleOf）在快照层是**只读展示**：
      // 不参与归属判定、状态推导或导航键；projectionTitleOf 仍是零 IO 的会话标题读面。
      // 最后一级 previousExpertTaskNames 只在 fast 构建时有值（同一 root 上一份 full 的
      // childId → taskName）：fast 不冷读会话，这是它唯一能拿到的、与 full 一致的展示名。
      // 它优先级最低——绝不覆盖真实标题、派发描述或 catalog label。
      taskName: firstText(
        context?.label,
        childSnapshot?.lastDispatch?.description,
        catalogLabels?.get?.(childId),
        projectionTitleOf(childId),
        sessionTitle(session, childId, events),
        previousExpertTaskNames?.get?.(childId),
      ),
      content: firstText(context?.promptText, childSnapshot?.lastDispatch?.prompt, sessionPrompt),
      contentSource: context?.promptText ? "dispatch-prompt" : sessionPrompt ? "session-log" : "unavailable",
      role: firstText(record?.role, childSnapshot?.role, agent?.options?.__degExpertRole),
      // 角色显示名（票据 27）：持久化快照优先，角色被删除后历史任务仍可显示标签。
      roleLabel: roleLabelOf(
        firstText(record?.role, childSnapshot?.role, agent?.options?.__degExpertRole),
        firstText(childSnapshot?.roleLabel),
      ),
      ...metadata,
      status: projectedStatus,
      ...(evidenceFree ? {} : { running: firstText(agent?.status, session?.status) === "running" }),
      runSummary: runSummary(session, projectedStatus, mode, events),
      continuable: mode === "continuable",
      ...(usage === null ? {} : { usage }),
      ...(structured === null ? {} : { structured }),
      ...(outputSchemaRequested ? { outputSchemaRequested: true } : {}),
      createdAt: createdAtOf(session?.createdAt, session?.header?.createdAt, childSnapshot?.createdAt),
    });
  }
  return experts;
}
