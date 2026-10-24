/**
 * Expert Group 快照的**阶段投影**（票据 09 / R2 从 host/expert-group-runtime.js 拆出）。
 *
 * 两个阶段：
 * - 普通 expert 阶段（`collectExperts`）：按 child_models / recovery 记录收集本根专家，冷读走本次
 *   构建的共享协调器（受控并发），最后按输入顺序投影成快照节点；
 * - fan-out 阶段（`projectFanoutTasks` → `projectFanoutTask` → `projectFanoutShard`）：先调度本
 *   shard 需要的全部归属证明，用 `Promise.allSettled` 收敛后按输入顺序选首错，最后按输入顺序
 *   重组输出。
 *
 * 边界（plan R2.2-a §3/§6）：
 * - 本模块**不 import** `host/expert-group-projection.js` 与 `host/snapshot-cache.js`：纯投影 helper
 *   由 runtime 以 `deps.project`（冻结命令集合）注入，归属判定只经 `deps.resolveChildOwnership`
 *   调用。因此 stage 只持有**命令**，不持有 Map、不读任何 owner 的状态；
 * - `deps` 里**没有** `cache` / `snapshotCache` / entry / `sortAnchor`：阶段投影绝不写缓存。
 *
 * 首错契约（不得回归）：shard 内按 proofIds 的稳定顺序选首错（attempts 输入顺序，末尾是导航回退），
 * 与读取完成时序无关；task 按 shards 输入顺序、tasks 按 rawTasks 输入顺序。
 *
 * @module dsh-expert-group/host/expert-group-stage
 */
import { projectModelRouteFields } from "../shared/model-route.js";
import { hasUsageMetrics, sumUsageByChildId } from "./usage-projection.js";

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
 * 从 Promise.allSettled 的结果数组里取**首个** rejection（按数组顺序，稳定），全部成功时返回 null。
 *
 * 用对象包住 reason，是因为 worker 可以 `throw undefined`：直接返回 reason 无法与「没有失败」
 * 区分。阶段投影统一用它收敛错误：所有已调度分支 settle 之后才向上抛错，且抛出的是同一个
 * 错误对象，重复构建得到的结果稳定（不依赖完成顺序）。
 *
 * 导出给 runtime 组合点使用：跨阶段收敛（fan-out 优先）复用同一套判定，不复制实现。
 */
export function firstRejection(results) {
  for (const result of results) {
    if (result.status === "rejected") return { reason: result.reason };
  }
  return null;
}

/**
 * fan-out 分片身份一致性校验（**只用廉价记录，绝不冷读**）。
 *
 * 归属证明回答的是「这个 child 属于本 root 吗」；本函数回答的是更强的「它属于**本分片的这些
 * attempt** 吗」。完整路径靠 `readSession` 的 header 证明前者，轻量路径没有这次读取，因此两种
 * 模式都用 `child_models` 记录自带的 fan-out 身份做**反证**：记录一旦声明了
 * fanoutParentTaskId / fanoutShardId / fanoutAttempt，就必须与当前父任务 / 分片一致，
 * 否则返回 true（调用方把该 childId 清空），保证 fast 与 full 的归属结论一致、都 fail-closed。
 *
 * attempt 号的两种判定及其适用前提（oracle 复审）：
 * - 号域成员判定只在记录**同时声明** fanoutParentTaskId 与 fanoutShardId 时成立：父任务与
 *   分片声明把号域锁定到「本分片该 child 的 attempts」，此时成员关系才有归属含义；
 * - 只声明 fanoutAttempt（或任一作用域字段缺失）的陈旧记录，其号域成员关系无法证明它属于
 *   当前父任务 / 分片，必须回退精确比较（declaredAttempt !== attempt 即矛盾）。
 *
 * 只有「记录存在且与之矛盾」才算反证：完全没有记录的 child（例如由 live agent 的
 * header.parentSession 证明归属）不受影响，避免把可用的导航键误删。
 *
 * fanoutAttempt 的口径（continuation 合法复用同一 child）：
 * child_models 里的 fanoutAttempt 记录的是 **child 创建时**的 attempt 号，只在创建 child 时
 * 写一次（host/index-expert-tools-fanout.js）。continuation 会复用同一个 child 进入新的逻辑
 * 轮次，于是该 child 的 attempt 号可以是 {1,2,…}（本分片 attempts 里出现的那些），而
 * fanoutAttempt 仍是 1。若继续用「等于最新 attempt 号」做精确比较，第 2 轮起就会被误判成
 * 身份矛盾、把导航键清空。因此在**作用域已声明**（见上）且号集合非空时，一致性口径是
 * 「declaredAttempt 属于本分片该 child 的 attempt 号集合」（attemptNumbers），而不是「等于
 * 传入的那一个 attempt 号」。号集合缺失 / 为空（没有 attempt 级证据）或作用域未声明时，
 * 一律回退精确比较，保持既有 fail-closed 行为不变。
 */
function fanoutIdentityContradicts(nonEmpty, record, childSnapshot, { parentTaskId, shardId, attempt, attemptNumbers }) {
  for (const source of [record, childSnapshot]) {
    if (source === null || source === undefined) continue;
    const declaredTask = nonEmpty(source.fanoutParentTaskId);
    if (declaredTask !== null && declaredTask !== parentTaskId) return true;
    const declaredShard = nonEmpty(source.fanoutShardId);
    if (declaredShard !== null && shardId !== null && declaredShard !== shardId) return true;
    const declaredAttempt = Number.isSafeInteger(source.fanoutAttempt) ? source.fanoutAttempt : null;
    if (declaredAttempt === null) continue;
    // 号域成员判定的前提：该记录同时声明了父任务与分片，号集合才被锁定到「本分片该 child」。
    // 只声明 fanoutAttempt 的陈旧记录无法用成员关系证明归属（号可能来自别的父任务/分片），
    // 必须回退精确比较。作用域声明存在时仍按集合判定；集合 null/空（没有 attempt 级证据）
    // 同样回退精确比较，保持既有 fail-closed 行为。
    const declaresScope = declaredTask !== null && declaredShard !== null;
    if (declaresScope && attemptNumbers !== null && attemptNumbers !== undefined && attemptNumbers.size > 0) {
      if (!attemptNumbers.has(declaredAttempt)) return true;
    } else if (attempt !== null && declaredAttempt !== attempt) {
      return true;
    }
  }
  return false;
}

/**
 * 逐动作能力（票据 09）：唯一来源是 fanoutHost.capabilitiesOf（归属 + manager 能力）。
 *
 * 返回 undefined 表示**旧 Host 或测试替身没有该读面**：投影层据此完全省略 capabilities
 * 字段，客户端回退既有状态推导，绝不伪造一个「全部拒绝」的能力对象。
 */
function fanoutCapabilitiesFor(safeCall, fanoutHost, rootId, parentTaskId) {
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return undefined;
  if (typeof fanoutHost?.capabilitiesOf !== "function") return undefined;
  const capabilities = safeCall(() => fanoutHost.capabilitiesOf(rootId, parentTaskId), undefined);
  if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
  return capabilities;
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
    if (child?.parentId === root.id && child?.fanout !== true) ids.add(childId);
  }

  // 第一步（同步，顺序 = ids）：只做筛选与归属判定，把需要投影的 child 按原顺序收进 candidates。
  // 跳过条件与归属语义（显式父证据冲突/缺失一律 fail-closed）与串行实现完全一致。
  const candidates = [];
  for (const childId of ids) {
    const record = recoveryRecords.get(childId);
    const childSnapshot = persisted[childId];
    if (childSnapshot?.fanout === true) continue;
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
  // 冷读、fan-out attempt 共用同一份 promise 缓存和同一个全局并发上限；这里的
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

/**
 * 单个 fan-out shard 的投影。
 *
 * attempt 之间彼此独立，因此先把本 shard 需要的归属证明**全部调度**（同一 child 去重），
 * 再用 allSettled 收敛：任一次读取失败，也要等本 shard 的全部证明 settle 之后才向上抛首个
 * 错误，避免失败返回后仍有 readSession 在后台运行。真实并发由协调器统一限流，shard 内因此
 * 可以放心地一次性调度全部 attempt。输出仍按 attempts 的输入顺序重组，与完成顺序无关。
 * **首错契约**：shard 内的首错按 proofIds 的稳定顺序选取（attempts 输入顺序，末尾是导航回退），
 * 与读取完成时序无关——先调度但迟到的失败，仍然优先于后调度却更早返回的失败。
 */
async function projectFanoutShard(shard, task, deps) {
  const { project, rootId, persisted, recoveryRecords, resolveChildOwnership, usageFor, roleLabelOf, now } = deps;
  const {
    firstText, nonEmpty, sessionEvents, modelMetadata, runSummary, turnTimingOf,
    subagentContextFields, usageOfChild, structuredOfChild, outputSchemaRequestedOfChild,
  } = project;

  const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
  const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
  const shardId = firstText(shard?.shardId);
  // 导航目标是最新 attempt 的 child；manager 若在 shard 上直接给了 childId，则作为回退。
  const navigationChildId = firstText(latestAttempt?.childId, shard?.childId);
  const parentTaskId = firstText(task?.parentTaskId);
  // 去重后的归属证明请求：proofIds 决定错误与结果的稳定顺序（attempts 顺序 + 导航回退）。
  const proofIds = [];
  const proofPromises = new Map();
  const requestProof = (childId) => {
    if (childId === null || proofPromises.has(childId)) return;
    proofIds.push(childId);
    // 归属判定只经冻结的 resolver 命令；rootId / persisted / coordinator / fast 都在 owner 内。
    proofPromises.set(childId, resolveChildOwnership(childId, parentTaskId));
  };
  for (const attempt of attempts) requestProof(firstText(attempt?.childId));
  requestProof(navigationChildId);
  const settled = await Promise.allSettled(proofIds.map((childId) => proofPromises.get(childId)));
  const failure = firstRejection(settled);
  if (failure !== null) throw failure.reason;
  const proofs = new Map(proofIds.map((childId, index) => [childId, settled[index].value]));
  const navigationProof = navigationChildId === null ? undefined : proofs.get(navigationChildId);
  /**
   * childId → 本分片 attempts 中出现的 attempt 号集合（身份反证的「合法号域」）。
   *
   * 只收 Number.isSafeInteger(attempt.attempt) 且 childId 非空的行：缺少 attempt 号的记录
   * 不能证明任何号域，直接跳过。continuation 复用同一 child 时，同一 childId 会出现在多个
   * attempt 号上，集合因此可能有多个成员；导航 child 与逐 attempt 两处反证共用这份集合，
   * 保证「声明号属于本分片该 child 的号域」这一口径一致。
   */
  const attemptNumbersByChildId = new Map();
  for (const attempt of attempts) {
    const childId = firstText(attempt?.childId);
    if (childId === null) continue;
    if (!Number.isSafeInteger(attempt?.attempt)) continue;
    const numbers = attemptNumbersByChildId.get(childId) ?? new Set();
    numbers.add(attempt.attempt);
    attemptNumbersByChildId.set(childId, numbers);
  }
  /**
   * 廉价反证（两种模式都执行，保证 fast 与 full 的归属结论一致、且都 fail-closed）：
   * 记录里声明了别的父任务 / 别的分片，或声明的 attempt 号不在本分片该 child 的号域内时，
   * 即使归属证明还算通过，也必须把该 childId 从输出副本清空——否则本行会挂上不属于它的会话。
   * 反证只用已经在手的持久化记录与 recovery 记录，不产生任何额外 IO。
   */
  const contradicts = (childId, attemptNumber) => {
    if (childId === null) return false;
    return fanoutIdentityContradicts(nonEmpty, recoveryRecords.get(childId), persisted[childId], {
      parentTaskId,
      shardId,
      attempt: Number.isSafeInteger(attemptNumber) ? attemptNumber : null,
      attemptNumbers: attemptNumbersByChildId.get(childId) ?? null,
    });
  };
  const ownedChild = navigationProof?.owned === true
    && contradicts(navigationChildId, latestAttempt?.attempt) !== true
    ? navigationProof
    : undefined;
  // 归属未证明（或身份反证成立）的 childId 一律从**输出副本**清空：manager 的权威快照保持原样。
  const projectedAttempts = attempts.map((attempt) => {
    const childId = firstText(attempt?.childId);
    const proof = proofs.get(childId);
    const owned = (proof === undefined || proof.owned === true)
      && contradicts(childId, attempt?.attempt) !== true;
    if (!owned) return { ...attempt, childId: null };
    // 实际路由（票据 24）：尝试本身的持久化字段（未来管理器的快照扩展）优先，
    // 缺失时从同一 child 的 child_models 记录补齐 candidateIndex/fallbackCount/
    // lastRouteErrorCode；没有记录就省略字段，绝不伪造 0。
    const route = {
      ...projectModelRouteFields(attempt),
      ...projectModelRouteFields(persisted[childId]),
    };
    // 角色显示名（票据 27）：attempt 自身记录优先，其次同一 child 的 child_models 快照；
    // 两者都没有时省略字段（不猜显示名）。角色删除后历史 attempt 仍保留标签。
    const attemptRoleLabel = roleLabelOf(firstText(attempt?.role, task?.role), firstText(attempt?.roleLabel, persisted[childId]?.roleLabel));
    const labeled = attemptRoleLabel === null ? attempt : { ...attempt, roleLabel: attemptRoleLabel };
    // 目标 subagent provider / 继承开关（票据 29）：attempt 自身字段优先，其次同一
    // child 的 child_models 快照；都没有时省略字段，不伪造 false。
    const attemptSubagent = subagentContextFields(attempt, null, persisted[childId]);
    const settledAttempt = Object.keys(attemptSubagent).length === 0
      ? labeled
      : { ...labeled, ...attemptSubagent };
    // 用量（票据 25）：归属已证明的 attempt 才允许带 usage；缺失时省略整个字段，
    // 绝不把“没拿到 usage”渲染成 0 token。
    const attemptUsage = usageOfChild(childId, persisted, usageFor);
    // 结构化交付（票据 30）：只读结果/声明标记来自同一 child 的 child_models；
    // 归属已证明的 attempt 才补齐，缺失整体省略。
    const attemptStructured = structuredOfChild(childId, persisted);
    const attemptRequested = outputSchemaRequestedOfChild(childId, persisted);
    const settled = Object.keys(route).length === 0 ? labeled : { ...labeled, ...route };
    const withSubagent = Object.keys(attemptSubagent).length === 0 ? settled : { ...settled, ...attemptSubagent };
    return {
      ...withSubagent,
      ...(attemptUsage === null ? {} : { usage: attemptUsage }),
      ...(attemptStructured === null ? {} : { structured: attemptStructured }),
      ...(attemptRequested ? { outputSchemaRequested: true } : {}),
    };
  });
  // 分片用量 = 全部 attempt 的用量按 childId 去重汇总：续作复用同一 child 时，
  // child_models.usage 是累计值，不能被多轮 attempt 重复相加。
  const shardUsage = sumUsageByChildId(projectedAttempts.map((attempt) => ({
    childId: attempt?.childId,
    usage: attempt?.usage,
  })));
  const shardStatus = firstText(shard?.status, ownedChild?.agent?.status, ownedChild?.session?.status) ?? "unknown";
  // 分片级结构化结果取最新 attempt 的 child_models（与 usage 同一“最新 attempt”口径）；
  // 不跨 attempt 合并 value，每个 attempt 自己的 structured 保留在 attempts 里。
  const shardStructured = structuredOfChild(navigationChildId, persisted);
  const shardRequested = outputSchemaRequestedOfChild(navigationChildId, persisted);
  // 分片最新 child 会话内全部 turn 的累计墙钟 + 最后一个 open turn 起点（与 DSH 状态行同源，
  // 空闲区间不计）；无 live 会话或没有任何可证明的 turn 区间时各自省略。
  const shardTiming = turnTimingOf(sessionEvents(ownedChild?.session), now());
  return {
    ...shard,
    childId: ownedChild === undefined ? null : navigationChildId,
    role: firstText(shard?.role, task?.role),
    // 分片角色显示名（票据 27）：manager/分片记录优先，其次同一 child 快照，最后运行期目录。
    roleLabel: roleLabelOf(
      firstText(shard?.role, task?.role),
      firstText(shard?.roleLabel, persisted[navigationChildId]?.roleLabel),
    ),
    ...modelMetadata(ownedChild?.agent, ownedChild?.childSnapshot ?? null, null),
    runSummary: runSummary(ownedChild?.session, shardStatus, "continuable", sessionEvents(ownedChild?.session)),
    continuable: true,
    ...(shardUsage === null || !hasUsageMetrics(shardUsage) ? {} : { usage: shardUsage }),
    ...(shardStructured === null ? {} : { structured: shardStructured }),
    ...(shardRequested ? { outputSchemaRequested: true } : {}),
    ...(shardTiming.durationMs === null ? {} : { turnDurationMs: shardTiming.durationMs }),
    // open turn 起点（additive）：与 root/expert 同一口径，闭合时省略。
    ...(shardTiming.openSince === null ? {} : { turnOpenSince: shardTiming.openSince }),
    attempts: projectedAttempts,
  };
}

/**
 * 单个 fan-out 父任务的投影：shards 全部并行调度，等所有 shard settle 之后再抛首个错误；
 * 首错按 shards 的输入顺序选取（稳定，与完成时序无关）；成功时按 shards 的输入顺序重组，
 * 输出顺序与旧实现完全一致。
 */
async function projectFanoutTask(task, deps) {
  const { project, fanoutHost, rootId } = deps;
  const { firstText, safeCall } = project;
  const shards = Array.isArray(task?.shards) ? task.shards : [];
  const settled = await Promise.allSettled(shards.map((shard) => projectFanoutShard(shard, task, deps)));
  const failure = firstRejection(settled);
  if (failure !== null) throw failure.reason;
  const projectedShards = settled.map((result) => result.value);
  /**
   * 逐动作能力（票据 09）：父任务与每个 shard 都带上 Host 的权威能力投影。
   *
   * 能力只由 fanoutHost.capabilitiesOf 产生（归属 + manager 规则），快照层不做二次判定：
   * - 旧 Host/测试替身没有该读面时整个字段省略（客户端回退旧行为）；
   * - shard 能力按 shardId 对齐，缺失条目的 shard 不带字段，绝不补一个假的 allowed。
   * 这里写的是**投影副本**（projectFanoutShard 每次都返回新对象），不会改动 manager 的输入。
   */
  const capabilities = fanoutCapabilitiesFor(safeCall, fanoutHost, rootId, task?.parentTaskId);
  if (capabilities !== undefined) {
    const shardCapabilities = capabilities.shards !== null && typeof capabilities.shards === "object"
      && !Array.isArray(capabilities.shards)
      ? capabilities.shards
      : {};
    for (const projected of projectedShards) {
      const shardId = firstText(projected?.shardId);
      if (shardId === null) continue;
      const shardCapability = shardCapabilities[shardId];
      if (shardCapability !== null && typeof shardCapability === "object" && !Array.isArray(shardCapability)) {
        projected.capabilities = shardCapability;
      }
    }
  }
  // 父任务用量 = 全部分片 attempt 的用量按 childId 去重汇总（防止跨分片重复或
  // 续作多轮重复）。没有有效样本时省略字段，父任务不显示假成本。
  const taskUsage = sumUsageByChildId(projectedShards.flatMap((shard) => (
    Array.isArray(shard?.attempts) ? shard.attempts.map((attempt) => ({
      childId: attempt?.childId,
      usage: attempt?.usage,
    })) : []
  )));
  return {
    ...task,
    shards: projectedShards,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(taskUsage === null || !hasUsageMetrics(taskUsage) ? {} : { usage: taskUsage }),
  };
}

/**
 * fan-out 阶段：所有父任务并行调度（真实冷读由协调器全局限流），等所有已调度分支 settle
 * 之后再抛出**稳定**的首个错误；成功时按 rawTasks 的输入顺序重组，保持既有输出顺序。
 * **首错契约**：按「task → shard → attempt（含导航回退）」的输入顺序取第一个失败的 rejection，
 * 与完成时序无关，因此同一份输入重复构建得到同一个错误对象。
 */
export async function projectFanoutTasks(rawTasks, deps) {
  const tasks = Array.isArray(rawTasks) ? rawTasks : [];
  const settled = await Promise.allSettled(tasks.map((task) => projectFanoutTask(task, deps)));
  const failure = firstRejection(settled);
  if (failure !== null) throw failure.reason;
  return settled.map((result) => result.value);
}
