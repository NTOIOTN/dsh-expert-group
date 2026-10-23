/**
 * Expert Group Host 运行时适配器（票据 09 / R2：拆为 4 模块后的组合点）。
 *
 * 本模块只做**组合**与**快照构建**，不再持有缓存状态：
 * - 纯投影 / 归属判定 → `host/expert-group-projection.js`（含 per-build 的冷读协调器与
 *   `childOwnership` owner）；
 * - 阶段投影（`collectExperts` / fan-out 三件套）→ `host/expert-group-stage.js`；
 * - 两级快照缓存（`snapshotCache` / `snapshotInFlight` / generation / LRU / sortAnchor）→
 *   `host/snapshot-cache.js`；
 * - 本文件只保留：工厂依赖校验、per-build 装配（builder）与缓存组合。
 *
 * 首屏与权威快照（本次性能修复的核心契约，未变）：
 * - `snapshotForSession` 先返回**轻量（fast）**快照：它跳过全部冷读（`sessionQuery.readSession`），
 *   只用 DEG 自己的持久化记录与 live 对象投影，快照上带 `partial: true`；
 * - 每次请求都**幂等**地在后台启动**完整（full）**构建（同一 root 同时只允许一个在跑），完成后
 *   写入按 root 的内存缓存，供客户端 ≤2.5s 的轮询取回权威快照（`partial: false`）；
 * - 完整快照「只是过期、没有失效事件」时继续返回上一份权威快照（不降级，避免界面抖动）；
 *   一旦收到失效事件，则当次请求改用新的轻量快照，保证状态变化立刻可见；
 * - 缓存由事件挂点（`invalidateSnapshots`，见 index.js 的接线）与兜底 TTL 失效，并按 root 限制容量。
 *
 * per-build 状态（规格书 §状态所有权(4)、plan R2.2-a §5）：`coordinator`（含内部 `reads`）、
 * `childOwnership`（resolver 闭包内）每次 build 新建，build 结束即丢弃，不跨 build / 跨 root 复用。
 * builder **每次 build 只调一次** `createChildOwnershipResolver`，不构造 Map，也不持有
 * `childOwnership`。
 *
 * @module dsh-expert-group/host/expert-group-runtime
 */
import { buildExpertGroupSnapshot } from "./expert-group-snapshot.js";
import {
  catalogLabelsOf,
  createExpertProjectionContext,
  createProjectionTitleReader,
  createRoleLabelReader,
  createdAtOf,
  currentRoleLabels,
  expertProjection,
  fanoutTasksOwnedBy,
  firstText,
  modelMetadata,
  nonEmpty,
  recentUserRequest,
  recoveryInputFromRestoreStatus,
  runSummary,
  safeCall,
  sessionEvents,
  sessionTitle,
  turnDurationOf,
} from "./expert-group-projection.js";
import { collectExperts, firstRejection, projectFanoutTasks } from "./expert-group-stage.js";
import { createSnapshotCache } from "./snapshot-cache.js";

// index.js 与既有调用方仍从本模块读取这两个纯投影（R2.2 归属到 projection 后在此原样转出，
// 不改任何 import 路径）。
export { restoreFailureRetryable, rootNotificationLabel } from "./expert-group-projection.js";

/**
 * 注入形态（票据 33 · C3 收窄：13 项 → 8 组）。参数按**能力组**组织、每组单一关注点；
 * 收窄只改注入形态——域内展开回同名局部绑定，下面 200 行构建/缓存逻辑逐字不变。
 *
 * 1. `agents`：live Agent 读面（`agents.get(id)`，root/child 对象身份来源）；
 * 2. `goals`：goal 阶段只读投影（`goals.get(root)`，仅用于根行 objective）；
 * 3. `ownership`：**归属判定读面**——`lineage`（血缘链 / activeRoot）与 `fanoutHost`
 *    （任务管理器 / restoreStatus）。两者在代码里**已经作为单个聚合**传给
 *    `fanoutTasksOwnedBy({ fanoutHost, lineage }, id)`，共同回答"这个 child/task 属于哪个
 *    root"，因此是一组；
 * 4. `recovery`：**恢复域读面**——恢复模块命令面 `recovery` 与记录表 `recoveryRecords`
 *    （同一 owner、同一关注点；记录表同时供快照缓存复用）；
 * 5. `sources`：**投影的只读数据来源**——`source`（settings 快照里的 child_models 持久化
 *    记录）、`sessionQuery`（冷读会话）、`usageFor`（用量账本投影）。三者是同一份投影的
 *    三种数据来源，只有读取成本不同：轻量快照刻意只读持久化/账本、完整快照才追加冷读，
 *    这正是同一关注点（数据来源）的两个档位；
 * 6. `labels`：**展示名读面**——`roleLabels`（角色 id → 显示名）与 `projectionTitleFor`
 *    （零 I/O 会话标题）。两者只影响文案，不参与归属与生命周期判定；
 * 7. `diagnostics`：`logger`（后台完整构建失败的告警出口，缺失时静默）；
 * 8. `clock`：`now`（快照生成时间与缓存 TTL 判定）。
 *
 * @param {object} dependencies
 * @param {object} [dependencies.agents] - `{ agents }`：live Agent 表。
 * @param {object} [dependencies.goals] - `{ goals }`：goal 服务（只读）。
 * @param {object} [dependencies.ownership] - `{ lineage, fanoutHost }`：归属判定读面。
 * @param {object} [dependencies.recovery] - `{ recovery, recoveryRecords }`：恢复域读面。
 * @param {object} [dependencies.sources] - `{ source, sessionQuery, usageFor }`：投影数据来源。
 * @param {object} [dependencies.labels] - `{ roleLabels, projectionTitleFor }`：展示名读面。
 * @param {object} [dependencies.diagnostics] - `{ logger }`：诊断出口。
 * @param {object} [dependencies.clock] - `{ now }`：时钟（默认 `Date.now`）。
 * @returns {{snapshotForSession(sessionId:string): Promise<object>,
 *   invalidateSnapshots(sessionId?:string): number,
 *   awaitFullBuild(sessionId:string): Promise<object|null>}}
 */
export function createExpertGroupRuntime(dependencies = {}) {
  // 命名空间 → 同名局部绑定（域内实现完全不变；只有注入面收窄）。
  const { agents: agentsGroup, goals: goalsGroup, ownership = {}, recovery: recoveryGroup = {},
    sources = {}, labels = {}, diagnostics = {}, clock = {} } = dependencies;
  const agents = agentsGroup?.agents;
  const goals = goalsGroup?.goals;
  const lineage = ownership.lineage;
  const fanoutHost = ownership.fanoutHost;
  const recovery = recoveryGroup.recovery;
  const recoveryRecords = recoveryGroup.recoveryRecords;
  const { source, sessionQuery, usageFor } = sources;
  const { roleLabels, projectionTitleFor } = labels;
  const { logger } = diagnostics;
  const now = clock.now ?? Date.now;
  if (!(recoveryRecords instanceof Map)) throw new TypeError("Expert Group runtime 需要 recoveryRecords Map");
  if (typeof now !== "function") throw new TypeError("Expert Group runtime 需要 now 函数");

  /** child_models 的只读读面：每次 build 重新读取，保证事件落下后的下一次构建可见。 */
  function persistedChildren() {
    const snapshot = safeCall(() => source?.(), null);
    return snapshot?.childModels && typeof snapshot.childModels === "object" ? snapshot.childModels : {};
  }

  // projection 的**组合上下文**：只在这里绑定 recoveryRecords / agents / sessionQuery 三份只读读面，
  // 之后每次 build 经它新建 coordinator 与 childOwnership owner（plan R2.2-a §1/§2）。
  const projection = createExpertProjectionContext({ recoveryRecords, agents, sessionQuery });
  // 运行期读命令：只绑定一次（纯读面，无 per-build 状态）。
  const projectionTitleOf = createProjectionTitleReader(projectionTitleFor);
  const roleLabelOf = createRoleLabelReader(roleLabels);

  /**
   * 用**排序锚点**给轻量快照补上 createdAt（修复 A）。
   *
   * 背景：唯一排序点（expert-group-snapshot.js 的 sortByCreatedAt）按 createdAt 升序、缺失兜底
   * Infinity 排到最后。普通专家的 createdAt 在完整路径由冷读到的 session.createdAt 补上，而真实
   * child_models 记录里没有这个字段，轻量路径又没有 session，因此 fast 下恒为 null；fan-out 任务的
   * createdAt 来自 manager，两条路径一致。于是同一个 fan-out 节点在 partial / full 之间相对位置
   * 会跳变（Explorer 因 createdAt 最小恒居第一，所以它稳定，Oracle 会来回跳）。
   *
   * 处理方式：完整构建成功后由 **cache owner** 把该快照里所有节点的 id → createdAt 记进锚点；
   * 轻量构建时只对 **createdAt 为 null** 的节点用锚点兜底填充，锚点里没有的保持 null（既有兜底
   * 行为不变）。这里只拿到 `sortAnchorFor(nodeId)` 只读查询，因此 builder 既读不到条目，
   * 也写不了锚点（plan R2.3 ④↔⑤）。
   *
   * 只按节点 id 匹配（专家节点 id 即 childId/sessionId，fan-out 节点 id 即 parentTaskId），
   * 因此锚点天然按 root 隔离：它挂在该 root 的缓存条目上，绝不跨 root 共享。
   */
  function applySortAnchor(nodes, sortAnchorFor) {
    if (typeof sortAnchorFor !== "function") return nodes;
    for (const node of nodes) {
      if (node === null || typeof node !== "object") continue;
      // 只补缺失值：已有真实 createdAt（完整路径 / manager 给出的任务时间）绝不被覆盖。
      if (node.createdAt !== null && node.createdAt !== undefined) continue;
      // 键与快照层一致：专家节点的 id 就是 childId/sessionId，fan-out 父任务的 id 由 parentTaskId
      // 派生（原始 manager 任务对象上没有 id 字段，因此这里按同一优先级回退）。
      const key = firstText(node.id, node.parentTaskId, node.sessionId, node.childId);
      if (key === null) continue;
      const anchored = sortAnchorFor(key);
      if (typeof anchored === "number" && Number.isFinite(anchored)) node.createdAt = anchored;
    }
    return nodes;
  }

  /**
   * 单次快照构建（轻量 / 完整共用）。
   *
   * per-build 状态（本次调用内新建、结束即丢弃）：
   * - `coordinator`：冷读协调器（内部 `reads` Map + 全局并发上限）；
   * - `resolver`：`childOwnership` owner（内部 Map，只暴露冻结的 `resolveChildOwnership`）。
   *
   * 阶段收敛（R2.5 第 10 条，不得回归）：
   * - 先启动 `collectExperts`，再启动 fan-out 阶段；两个阶段并行推进、共享同一个协调器；
   * - 两阶段都用 `allSettled` 收敛，**都 settle 之后**才返回或抛错，因此构建失败返回时不会有
   *   残留冷读，同一 root 的立即重试不会与旧批次重叠；
   * - 双失败时按**优化前的阶段顺序**（fan-out 优先）选错：`firstRejection([fanoutOutcome,
   *   expertOutcome])`，与谁先失败/谁先完成无关（否则错误会随负载抖动）。
   *
   * 参数 `previousExpertTaskNames`（可选，`Map<childId, 展示名>`）：只由 cache owner 在**轻量
   * 构建**时传入，内容取自同一 root 最近一份完整快照。fast 路径不冷读会话，拿不到 DSH 的
   * session/title，这是它唯一能得到的、与 full 一致的展示名来源；它随 stageDeps 只读传到
   * collectExperts，作为 taskName 降级链的**最后一级**（绝不覆盖真实标题/派发描述）。
   * 补名因此发生在投影内部，revision 摘要天然覆盖它；full 构建不传该参数（它的名字以冷读
   * 到的会话标题为准，不引入跨代展示名）。
   */
  async function buildSnapshotForSession(
    sessionId,
    { fast = false, sortAnchorFor = null, previousExpertTaskNames = undefined } = {},
  ) {
    const id = nonEmpty(sessionId);
    if (id === null) throw new TypeError("expert-group-snapshot 需要 sessionId");
    // 本次构建独有的冷读协调器：root 冷读、普通 expert 阶段与 fan-out 阶段共用同一份读取
    // promise 缓存与同一个全局并发上限；构建结束即回收，不会被后续快照或别的 root 复用。
    // 轻量构建（fast）不会调用它——那时它只是一个空协调器，不产生任何 IO。
    const coordinator = projection.createColdReadCoordinator();
    // 没有 ownership 证明时 fail-closed；fanoutHost 的全局 list 不能作为当前根的回退。
    const rawFanoutTasks = fanoutTasksOwnedBy({ fanoutHost, lineage }, id);
    const persisted = persistedChildren();
    const knownByChild = Object.values(persisted).some((child) => child?.parentId === id);
    const knownByFanout = Array.isArray(rawFanoutTasks) && rawFanoutTasks.length > 0;
    let root = safeCall(() => lineage?.activeRoot?.(id), undefined) ?? safeCall(() => agents?.get?.(id), undefined);
    // 轻量路径用占位 root 时，root 自身也没有任何运行证据；投影层据此把它降级为中性状态。
    let placeholderRoot = false;

    if (root === undefined || root === null || root.id !== id) {
      if (fast === true) {
        // 轻量路径不冷读 root 会话。首屏只要求「有内容」，而 root 行的显示并不依赖会话日志
        // （第一行固定「主代理」，标题由客户端自己的会话投影给出）；因此这里只做廉价的存在性判定：
        // - 有 DEG 记录或 fan-out 任务能证明该 id 被使用过 → 用占位 root 继续投影子节点；
        // - 完全没有证据 → 返回 null，让调用方回落到完整构建，从而保留「陌生 id 一律 404」
        //   以及「冷 root 会话仍能读到标题/内容」这两个既有契约。
        if (!knownByChild && !knownByFanout) return null;
        const session = { id, header: { id }, events: [], status: "ready", requestHeader: () => ({ config: {} }) };
        root = { id, status: "ready", session, options: {} };
        placeholderRoot = true;
      } else {
        const coldSession = await coordinator.read(id, null);
        if (coldSession !== undefined) {
          root = { id, status: "ready", session: coldSession, options: coldSession.header?.config ?? {} };
        }
      }
    }

    if (root === undefined || root === null || root.id !== id) {
      // sessionQuery 是可选服务。它缺失时，只允许已有 DEG 记录能够证明 ownership 的根；
      // 一个完全陌生的 id 仍返回 404，不能借任务视图枚举别的会话。
      if (!knownByChild && !knownByFanout) {
        const error = new Error("root session not found: " + id);
        error.code = "session-not-found";
        throw error;
      }
      const session = { id, header: { id }, events: [], status: "ready", requestHeader: () => ({ config: {} }) };
      root = { id, status: "ready", session, options: {} };
    }

    const session = root.session;
    const rootEvents = sessionEvents(session);
    // 父会话 durable catalog（`subagent/catalog` 事件）：childId → 派发 label。
    // rootEvents 已在手，因此这是**零额外 IO** 的读面；它用于救回历史记录里被写回抹掉的
    // 任务名（真实故障：child_models 只剩 persistChildModel 的字段集合）。
    // fast 路径若用占位 root，rootEvents 天然为空数组 ⇒ 空 Map，不影响轻量语义。
    const catalogLabels = catalogLabelsOf(rootEvents);
    const goal = safeCall(() => goals?.get?.(root), undefined) ?? safeCall(() => goals?.get?.(id), undefined);
    const userRequest = recentUserRequest(session, rootEvents);
    const content = firstText(goal?.objective, userRequest);
    const header = safeCall(() => session?.requestHeader?.(), null);
    const metadata = modelMetadata(root, null, null);
    const rootStatus = firstText(root?.status, session?.status) ?? "unknown";
    // 每个 shard 的第二行必须描述最新 attempt 对应的实际 child；重试可能更换模型，
    // 因此不能只读取父任务创建时的角色取值，也不能沿用历史 attempt 的 metadata。
    // 同一份投影还必须做归属隔离：只有能证明属于当前 root 的 childId 才允许进入快照，
    // 否则客户端会导航到跨根会话，并看到别的根的模型、命令与状态。
    //
    // per-build 的归属 owner：**每次 build 只调一次**工厂；返回值是冻结命令面，builder 不持有 Map、
    // 不构造 Map，也不把 Map 传给任何模块（plan R2.2-a §1/§2）。
    const resolver = projection.createChildOwnershipResolver({ rootId: id, persisted, coordinator, fast });
    // 阶段投影的窄依赖：纯投影命令集合（project）+ 本次构建的只读读面 + resolver 命令。
    // 显式冻结：阶段投影只能读，写不了 runtime 侧的任何一个绑定。
    const stageDeps = Object.freeze({
      rootId: id,
      persisted,
      coordinator,
      fast,
      resolveChildOwnership: resolver.resolveChildOwnership,
      recoveryRecords,
      agents,
      recovery,
      fanoutHost,
      now,
      usageFor,
      roleLabelOf,
      projectionTitleOf,
      // 父会话 catalog 的 label 映射（childId → 任务名）：只读传给学生产投影，作为任务名
      // 降级链中「派发描述」之后、会话标题之前的一级（详见 stage 的注释）。
      catalogLabels,
      // 任务名兜底映射（仅 fast 构建有值）：Map 只读传递，stage 侧只调用 get(childId)，
      // 不修改它、也不把它带出阶段（stageDeps 本身已 Object.freeze）。
      previousExpertTaskNames,
      project: expertProjection,
    });
    // 普通 expert 阶段先启动：它决定首屏的专家列表，理应优先占用冷读队列；fan-out 阶段紧随其后
    // 启动。两个阶段**并行**推进，但共享同一个冷读协调器，因此真实 readSession 全局最多
    // COLD_READ_CONCURRENCY 个同时在飞，同一个 child 也不会被两个阶段读两次。
    const expertsStage = collectExperts(root, stageDeps);
    const fanoutStage = projectFanoutTasks(rawFanoutTasks, stageDeps);
    // 两个阶段都用 allSettled 收敛：阶段内部已保证各自已调度的分支全部 settle，这里再保证跨阶段
    // 收敛，因此构建失败返回时不会有残留冷读，同一 root 的立即重试不会与旧批次重叠。
    const settledStages = await Promise.allSettled([expertsStage, fanoutStage]);
    const [expertOutcome, fanoutOutcome] = settledStages;
    // 顶层错误选择显式按 **fan-out 优先**，用于兼容优化前的阶段顺序：改动前 buildSnapshotForSession
    // 先 await fan-out 投影、之后才 await collectExperts，两个阶段都失败时外部只会收到 fan-out 的
    // 错误。并行化以后必须用显式顺序保留这个可观察契约，绝不能依赖谁先失败/谁先完成（否则错误会随
    // 负载抖动）。此处两个阶段都已 settle，所以提前 throw 不会留下后台读取。
    const stageFailure = firstRejection([fanoutOutcome, expertOutcome]);
    if (stageFailure !== null) throw stageFailure.reason;
    const experts = expertOutcome.value;
    const fanoutTasks = fanoutOutcome.value;
    // 修复 A：轻量路径用排序锚点补 createdAt，让同一节点在 partial / full 下拿到同一个排序键。
    // 完整路径不传锚点（它的 createdAt 本来就是权威值），因此这里只影响 fast。
    if (fast === true) applySortAnchor([...experts, ...fanoutTasks], sortAnchorFor);
    /**
     * 恢复状态（票据 04）：两条构建路径都投影同一份只读状态，且**不做任何冷读**——
     * 它来自 fanoutHost 内存里的 restoreStatus()，因此轻量快照也能立刻反映恢复失败，
     * 用户不必等完整快照就能看到错误横幅与重试入口。
     */
    const recoveryInput = recoveryInputFromRestoreStatus(safeCall(() => fanoutHost?.restoreStatus?.(), null));
    const generatedAt = now();
    // 根会话当前/最近一轮的墙钟用时（与 DSH 状态行同源）；placeholder root 没有事件时省略。
    const rootTurnDurationMs = turnDurationOf(rootEvents, generatedAt);
    return buildExpertGroupSnapshot({
      sessionId: id,
      generatedAt,
      recovery: recoveryInput,
      root: {
        id,
        kind: "root",
        sessionId: id,
        taskName: sessionTitle(session, id, rootEvents),
        content,
        contentSource: goal?.objective ? "goal" : userRequest ? "recent-user-request" : "unavailable",
        role: "orchestrator",
        ...metadata,
        // 占位 root（轻量路径且没有 live root）没有任何运行证据：状态降级为 unknown 并省略
        // running 布尔，客户端因此渲染中性圆点而不是「已结束」的绿色圆点。
        status: placeholderRoot ? "unknown" : rootStatus,
        ...(placeholderRoot ? {} : { running: rootStatus === "running" }),
        runSummary: runSummary(session, placeholderRoot ? "unknown" : rootStatus, "one-shot", rootEvents),
        continuable: false,
        ...(rootTurnDurationMs === null ? {} : { turnDurationMs: rootTurnDurationMs }),
        createdAt: createdAtOf(session?.createdAt, session?.header?.createdAt, header?.createdAt),
      },
      experts,
      fanoutTasks,
      // 角色显示名（票据 27）：含历史角色显示名（包括已删除角色的持久化标签）；
      // 只有至少一个条目时才出现在快照顶层。
      roleLabels: currentRoleLabels(roleLabels),
      // partial 是本次新增的快照级标记：true = 轻量快照（跳过了全部冷读，状态可能不完整），
      // false = 完整权威快照。客户端据此在轻量快照期间保持状态圆点/活动文案中性。
      partial: fast === true,
    });
  }

  // 缓存 owner：状态全部在 snapshot-cache 模块内，本工厂只交出「构建能力 + 窄读面」。
  // builder 收到的是只读的 sortAnchorFor(nodeId) 查询；锚点写回由 cache owner 自己完成。
  const cache = createSnapshotCache({
    buildSnapshotForSession,
    now,
    logger,
    recoveryRecords,
    persistedChildren,
    project: expertProjection,
  });
  return Object.freeze({
    snapshotForSession: cache.snapshotForSession,
    invalidateSnapshots: cache.invalidateSnapshots,
    awaitFullBuild: cache.awaitFullBuild,
  });
}
