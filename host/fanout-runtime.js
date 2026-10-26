/**
 * Host 关注点模块：fan-out runtime 的**中心装配工厂**。
 *
 * 本模块只做三件事：校验依赖、创建 runtime、把三个窄服务装配成对外冻结面。
 * 真实状态全部在服务里，且每个服务是各自状态的唯一 owner（票据 11 / R2）：
 *
 * - `./fanout-ownership.js`：归属判定与全部归属索引（活动绑定解析、已结算索引、
 *   创建时快照、冷恢复读凭据、已回收归属提示）；命令面不含任何 Map/Set 引用；
 * - `./fanout-persistence.js`：落盘投影、重试旁路与显式回收（候选落盘 → 提交内存回收
 *   → 最终快照；先 persist 成功才 commit，失败一律 abort/补偿，不部分提交）；
 * - `./fanout-restore.js`：恢复 staging（plan-build → 交 manager 一次性提交；
 *   失败整批原子失败，不部分提交）。
 *
 * 本工厂不持有任何可变业务状态，只有 `runtime`（懒装配句柄）与 `closed`（生命周期闸门）。
 * 事件顺序仍是「先 onFanoutEvent 账本、后 parentSettled 结算」，由下面的 onEvent 固定。
 *
 * @module dsh-expert-group/host/fanout-runtime
 */
import { createFanoutOwnershipService } from "./fanout-ownership.js";
import { createFanoutPersistenceService } from "./fanout-persistence.js";
import { createFanoutRestoreService } from "./fanout-restore.js";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 关闭态的统一结果（fail-closed 形状；门面与服务共用同一份字面量）。 */
function closedResult() {
  return { accepted: false, changed: false, code: "RUNTIME_CLOSED", reason: "runtime_closed" };
}

/**
 * 只读诊断投影（票据 39 从门面抽出）：只有标量/结构化元数据，不含任务负载或快照正文。
 *
 * 与门面同源、同依赖，抽出只是为了把 buildRuntimeFacade 控制在「单函数 ≤200 行」以内；
 * 它不持有状态，也不改变任何关闭语义（关闭后同样返回结构化空投影）。
 *
 * @param {object} context 与 buildRuntimeFacade 相同的上下文（state / 三个服务）。
 * @returns {object} 诊断投影。
 */
function describeRuntimeView(context) {
  const { state, ownership, persistence, restore } = context;
  return {
    closed: state.closed,
    restorePending: restore.pending(),
    activeAttempts: state.closed ? 0 : state.runtime.activeAttemptCount,
    tasks: state.closed ? 0 : state.runtime.manager.listTasks().length,
    // 已终态/已回收任务的归属索引计数（只读观测，不参与调度）。
    ...ownership.diagnostics(),
    persistenceHealth: persistence.healthSnapshot(),
    // Host 事件日志的保留窗口状态（与 manager 的事件历史是两份投影）：缺失时显式为 null。
    eventLog: typeof state.runtime?.eventLogStatus === "function" ? state.runtime.eventLogStatus() : null,
    persistence: {
      // Host 层最近一次真实结果（含失败原因码）+ fail-closed 闸门 + manager 侧观测。
      ...persistence.diagnostics(),
      restore: restore.diagnostics().lastRestore,
      manager: typeof state.runtime?.manager?.persistenceStatus === "function"
        ? state.runtime.manager.persistenceStatus()
        : null,
      eventHistory: typeof state.runtime?.manager?.eventHistoryStatus === "function"
        ? state.runtime.manager.eventHistoryStatus()
        : null,
    },
    // 停止边界诊断（计数/固定枚举，不含 prompt、结果或会话正文）。
    stop: typeof state.runtime?.stopDiagnostics === "function"
      ? state.runtime.stopDiagnostics()
      : (typeof state.runtime?.manager?.stopDiagnostics === "function" ? state.runtime.manager.stopDiagnostics() : null),
    // 只读并发视图（有效默认值 / 各 role 与 provider 覆盖 / 解析来源）。
    ...(typeof state.runtime?.manager?.concurrencyLimits === "function"
      ? { concurrencyLimits: state.runtime.manager.concurrencyLimits() }
      : {}),
    // 限流/排队诊断（票据 26）：Host 不复制计数器；旧 manager 缺能力时为 null。
    throttle: typeof state.runtime?.manager?.throttleDiagnostics === "function"
      ? state.runtime.manager.throttleDiagnostics()
      : null,
    // provider 释放异常（票据 05 · F4）：Host 只做透传，旧 manager 缺能力时为 null。
    providerRelease: typeof state.runtime?.manager?.providerReleaseDiagnostics === "function"
      ? state.runtime.manager.providerReleaseDiagnostics()
      : null,
    ...(typeof state.runtime?.manager?.budget === "function" ? { budget: state.runtime.manager.budget() } : {}),
  };
}

/**
 * 组装对外冻结面（票据 39）。
 *
 * 这里集中了 34 个 API 门面，其中绝大多数是单行箭头（getTask: () => ... 之类）。它们原本
 * 写在工厂体内，使 createFanoutRuntimeModule 的「单闭包内函数数」达到 48（上限 40）。
 * 门面本身不持有状态、也不捕获工厂局部变量，因此整体提到模块级、依赖经 context 显式传入
 * 即可：工厂内只保留一次调用。
 *
 * 可变的懒装配句柄与生命周期闸门挂在 context.state 上（state.runtime / state.closed），
 * 与原来那对 let 语义相同；门面里对 state.closed 的写入（close）仍会闸住所有入口。
 *
 * @param {object} context
 * @param {{runtime: object|undefined, closed: boolean}} context.state 懒装配句柄 + 关闭闸门。
 * @param {object} context.ownership 归属服务。
 * @param {object} context.persistence 落盘服务。
 * @param {object} context.restore 恢复服务。
 * @param {object} context.lineage 父任务 ownership 小接口。
 * @param {Function} context.buildFeedback (task) => 反馈文本。
 * @param {Function} context.injectFeedback (parent, text) => void。
 * @param {Function} [context.onParentSettled] 父任务真实终态回调。
 * @param {Function} context.getAgent agents.get(id)。
 * @param {Function} context.warn 统一告警出口。
 * @returns {object} 未冻结的对外面（由工厂 Object.freeze 后返回）。
 */
function buildRuntimeFacade(context) {
  const {
    state, ownership, persistence, restore, lineage,
    buildFeedback, injectFeedback, onParentSettled, getAgent, warn,
  } = context;
  const api = {
    /** 提交父任务：分配 id、绑定 ownership、失败时释放。 */
    submit(parent, args = {}) {
      if (state.closed) return { ...closedResult(), shardIds: [] };
      return ownership.submit(parent, args);
    },
    /**
     * manager 事件回调：父任务终态后向父会话注入一次聚合反馈；同时维护回收排除集合。
     *
     * `task_registered` 必须在这里（先于 closed/restoring 早退）处理：排除集合表达的是
     * "这个 id 在磁盘上必须被排除"，它只在"任务已不在内存"时成立。一旦 manager 重新登记
     * 同 id 的任务（新提交，或恢复窗口内重新落地的任务），任务就重新存在于内存，继续排除
     * 会让磁盘丢掉一个真实任务。这里只做一次有界的 Set 删除，不产生任何副作用。
     */
    parentSettled(event) {
      if (event?.type === "task_registered") {
        persistence.forgetDurableReclaimOmit(event?.parentTaskId);
        return false;
      }
      if (state.closed || restore.isRestoring() || event?.type !== "task_settled") return false;
      const parentTaskId = event.parentTaskId;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      // 父 Agent 必须**先**捕获：下面的归还路径会释放 lineage 绑定，释放后再查就只剩
      // undefined。反馈投递本身走 microtask，用捕获的 exact 对象与已算好的文本。
      const parent = lineage.parentAgentOf(parentTaskId);
      const task = state.runtime.manager.getTask(parentTaskId);
      if (task === null) return false;
      // 归属结算先于反馈投递，且不依赖父 Agent 是否还活着：root 先被销毁时 parentAgentOf
      // 返回 undefined，但归属仍必须写进 settled 索引。事件类型是终态边界，这里再用
      // manager 状态复核一次，避免外部误传 task_settled（测试 seam）把活动任务提前归还。
      // 恢复任务的 ownership 到这里才到期：aggregateTask 只对从 pending 进入终态的结算
      // 发布 task_settled，因此这是「真实终态」的唯一边界。
      if (ownership.taskIsTerminal(task)) {
        // 归属 id 必须在归还前解析：归还会消费 ownershipSnapshot 并清掉活动绑定。
        const ownerId = ownership.returnOwner(parentTaskId);
        ownership.settleRestoredOwnership(parentTaskId);
        // goal 等待原因必须由真实终态边界释放。这里传的是已捕获的 exact Agent（而不是
        // 重新按 id 解析），因为宿主侧 release 需要对象身份一致才认；ownerId 只是
        // exact Agent 已不可用时的兜底根 id。
        if (typeof onParentSettled === "function") {
          try {
            onParentSettled(parentTaskId, parent, typeof ownerId === "string" && ownerId.length > 0 ? ownerId : undefined);
          } catch (error) {
            warn("dsh-expert-group: fan-out parent settle hook failed: " + describeError(error));
          }
        }
      }
      if (parent === void 0 || typeof parent.inject !== "function") return false;
      const text = buildFeedback(task);
      // manager 在状态写入路径内同步发布事件；放到 microtask 避免重入 dispatch/Session.append。
      queueMicrotask(() => {
        if (state.closed || restore.isRestoring() || getAgent(parent.id) !== parent) return;
        try { injectFeedback(parent, text); } catch (error) {
          warn("dsh-expert-group: fan-out parent feedback failed: " + describeError(error));
        }
      });
      return true;
    },
    // 关闭后的迟到 fan-out 事件仍交给 runtime 识别：已知 child/session 返回 true，
    // 这样 index.js 不会把它们误交给旧 recovery；未知对象仍返回 false，保留正常事件路由。
    /**
     * guard/登记之前的 fan-out child 身份预检（只读转发）。
     *
     * 组合根必须在**任何副作用之前**调用它：handleAgentCreated 的 false 只表示「没有对应
     * live attempt」，不能作为身份证据。runtime 可以是测试替身（未实现该方法）——此时必须
     * 返回**结构化失败**而不是 undefined：调用方只认 `ok === true`，缺能力与「预检不通过」
     * 必须同形 fail-closed，绝不因转发返回 undefined 而被当成通过。
     */
    precheckFanoutChildIdentity: (agent, persistedIdentity) => (
      typeof state.runtime.precheckFanoutChildIdentity === "function"
        ? state.runtime.precheckFanoutChildIdentity(agent, persistedIdentity)
        : { ok: false, reason: "fanout_precheck_unavailable" }
    ),
    handleAgentCreated: (agent, persistedIdentity) => state.runtime.handleAgentCreated(agent, persistedIdentity),
    handleAgentDisposed: (agent, persistedIdentity) => state.runtime.handleAgentDisposed(agent, persistedIdentity),
    handleSessionEvent: (session, event) => state.runtime.handleSessionEvent(session, event),
    /** 事件日志只读状态（保留窗口/最早序号/累计丢弃/最近恢复结果）；旧 runtime 缺能力时返回 null。 */
    eventLogStatus: () => (typeof state.runtime?.eventLogStatus === "function" ? state.runtime.eventLogStatus() : null),
    restoreEvents: (events) => (state.closed ? false : state.runtime.restoreEvents(events)),
    whenIdle: () => state.runtime.manager.whenIdle(),
    /** 只读预算投影；关闭后不再提供（与 getTask/listTasks 的关闭语义一致）。 */
    budget: () => (state.closed || typeof state.runtime?.manager?.budget !== "function" ? null : state.runtime.manager.budget()),
    getTask: (parentTaskId) => (state.closed ? null : state.runtime.manager.getTask(parentTaskId)),
    listTasks: () => (state.closed ? [] : state.runtime.manager.listTasks()),
    // 归属解析 / 能力判定全部转交 ownership 服务（关闭语义与 fail-closed 都在服务内）。
    tasksOwnedBy: (sessionId) => ownership.tasksOwnedBy(sessionId),
    ownerOf: (parentTaskId) => ownership.ownerOf(parentTaskId),
    reclaimedOwnerOf: (parentTaskId) => ownership.reclaimedOwnerOf(parentTaskId),
    ownsTask: (parent, parentTaskId) => ownership.ownsTask(parent, parentTaskId),
    hasLiveWriteBinding: (parent, parentTaskId) => ownership.hasLiveWriteBinding(parent, parentTaskId),
    capabilitiesOf: (sessionId, parentTaskId) => ownership.capabilitiesOf(sessionId, parentTaskId),
    getEvents: (options) => (state.closed
      ? { events: [], nextSequence: Number.isSafeInteger(options?.after) && options.after >= 0 ? options.after : 0 }
      : state.runtime.getEvents(options)),
    cancelParent: (parentTaskId) => (state.closed ? closedResult() : state.runtime.manager.cancelParent(parentTaskId)),
    cancelShard: (parentTaskId, shardId) => (state.closed ? closedResult() : state.runtime.manager.cancelShard(parentTaskId, shardId)),
    retryShard: (parentTaskId, shardId) => (state.closed ? closedResult() : state.runtime.manager.retryShard(parentTaskId, shardId)),
    // 回收（两阶段 + 先落盘成功才 commit）与多轮复用授权都在服务内。
    reclaimTasks: (parent, parentTaskIds) => (state.closed
      ? persistence.reclaimClosedResult()
      : persistence.reclaimTasks(parent, parentTaskIds)),
    continueTask: (parent, args = {}) => ownership.continueTask(parent, args),
    restore: (restoreOptions = {}) => (state.closed
      ? { ...closedResult(), restored: 0, deferred: 0, pending: restore.pending() }
      : restore.restore(restoreOptions)),
    restoreStatus: () => restore.restoreStatus(),
    persistenceStatus: () => persistence.persistenceStatus(),
    /** 转发 manager 的预算事件补发入口（Host 恢复失败路径使用）；关闭/缺能力时结构化失败。 */
    recordBudgetViolation(violation, phase, options) {
      if (state.closed) return { recorded: false, reason: "runtime_closed" };
      const manager = state.runtime?.manager;
      if (typeof manager?.recordBudgetViolation !== "function") {
        return { recorded: false, reason: "unsupported" };
      }
      try {
        return manager.recordBudgetViolation(violation, phase, options);
      } catch (error) {
        warn("dsh-expert-group: fan-out budget violation record failed: " + describeError(error));
        return { recorded: false, reason: "error" };
      }
    },
    /** 只读诊断投影：只有标量/结构化元数据，不含任务负载或快照正文。 */
    describe: () => describeRuntimeView(context),
    /**
     * 显式落盘一次当前快照（宿主在需要立刻持久化时调用）。关闭后返回 false：卸载路径
     * 不得再发起新的 domain 写入。
     * @returns {Promise<boolean>} 是否成功落盘。
     */
    flushSnapshot: () => (state.closed ? Promise.resolve(false) : persistence.flush()),
    /** 落盘投影与落盘旁路（公开面保持不变；实现在 persistence 服务）。 */
    persist: (snapshot, options) => persistence.persist(snapshot, options),
    snapshotForStorage: (snapshot, options) => persistence.snapshotForStorage(snapshot, options),
    /**
     * 幂等关闭：先封锁本模块入口，再让 manager 写入关闭终态并由 runtime 处理中断。
     * manager 必须先收敛，避免 runtime 的 deferred reject 被误判成普通 failed。
     */
    close() {
      if (state.closed) return false;
      state.closed = true;
      // 关闭是 ownership 的另一个真实释放点：模块已封锁，不可能再有 settle 事件。
      // 归还在服务内完成（manager.close() 会把仍未终态的恢复任务写成 cancelled，
      // 关闭时的最终持久化投影仍要按 settled 索引取归属，否则重启后这些任务丢节点）。
      //
      // 注意：durableReclaimOmit **不**在关闭时清空。关闭路径本身会触发 manager.close()
      // 的最终持久化；若在关闭前清空排除集合，那次写入会把"最终快照失败"的已回收任务
      // 重新写回磁盘，正好复原票据 05 要消除的复活路径。集合只含 id 且有界，随模块丢弃。
      ownership.close();
      try {
        const managerClose = typeof state.runtime.manager?.close === "function" ? state.runtime.manager.close() : undefined;
        if (managerClose !== null && typeof managerClose === "object" && typeof managerClose.catch === "function") {
          managerClose.catch((error) => warn("dsh-expert-group: fan-out manager close failed: " + describeError(error)));
        }
      } catch (error) {
        warn("dsh-expert-group: fan-out manager close failed: " + describeError(error));
      }
      try {
        const runtimeClose = state.runtime.close();
        if (runtimeClose !== null && typeof runtimeClose === "object" && typeof runtimeClose.catch === "function") {
          runtimeClose.catch((error) => warn("dsh-expert-group: fan-out runtime close failed: " + describeError(error)));
        }
      } catch (error) {
        warn("dsh-expert-group: fan-out runtime close failed: " + describeError(error));
      }
      return true;
    },
    dispose() {
      api.close();
    },
  };
  return api;
}

/**
 * @param {object} options
 * @param {Function} options.createRuntime - (runtimeOptions) => createFanoutRuntime 实例。
 * @param {object} [options.runtimeOptions] - concurrencyLimit/writeRoles 等静态默认值。
 *   concurrencyLimit 支持传解析函数：由 manager 在每次新建父任务读取一次当前 settings，
 *   这样设置变更只影响之后创建的任务，已存在（含恢复）任务沿用创建时的限制。
 * @param {Function|number} [options.concurrencyLimit] - 动态 per-role 默认并发上限（settings 解析）。
 * @param {Function} [options.roleLimits] - 逐角色并发覆盖（settings.roleLimits 解析函数）。
 * @param {Function} [options.providerLimits] - provider 级并发映射（settings.providerLimits）。
 * @param {Function|number} [options.roleTimeoutMs] - 角色级默认超时（settings 解析）。
 * @param {Function} [options.onFanoutEvent] - manager 事件只读观察钩子（per-shard 等待账本）。
 * @param {Function} options.buildRequest - 每个 shard 的请求装配。
 * @param {Function} options.startContinuable
 * @param {Function} [options.continueMessage] - 多轮复用：把本轮 prompt 投递给既有 child。
 * @param {Function} [options.resolveChildSession] - 多轮复用：解析既有 child 的 session。
 * @param {Function} [options.interrupt]
 * @param {Function} [options.onAgentCreated]
 * @param {object} options.lineage - 父任务 ownership 小接口。
 * @param {Function} options.getAgent - agents.get(id)。
 * @param {Function} options.buildFeedback - (task) => 注入给父会话的反馈文本。
 * @param {Function} options.injectFeedback - (parent, text) => void。
 * @param {Function} [options.onParentSettled] - 父任务真实终态回调
 *   (parentTaskId, parentAgent, parentAgentId) => void；exact Agent 在 lineage 活动绑定
 *   释放前已捕获，回调本身在归还之后触发，宿主据此释放该 fan-out 任务登记的 goal
 *   等待原因。closed/restoring/非终态一律不调用。
 * @param {Function} [options.writeSnapshot] - 持久化合并后的快照（storage 写入面）。
 * @param {Function} [options.readSnapshot] - 读取最近一次快照。
 * @param {object} [options.persistenceHealth] - 持久化健康状态注入 seam。
 * @param {object} [options.retryBackoff] - 瞬时持久化失败的退避 seam：
 *   { baseDelayMs, maxDelayMs, sleep }；sleep 可注入记录器以确定性断言退避节奏。
 * @param {Function} [options.getPersistenceGeneration] - 获取当前 storage generation。
 * @param {object} [options.logger]
 */
export function createFanoutRuntimeModule({
  createRuntime,
  runtimeOptions = {},
  concurrencyLimit,
  roleLimits,
  providerLimits,
  roleTimeoutMs,
  onFanoutEvent,
  buildRequest,
  startContinuable,
  continueMessage,
  resolveChildSession,
  interrupt,
  onAgentCreated,
  // 派发前路由冻结 seam（票据 03）：manager 在 attempt 进入 running 之前同步调用；
  // 缺失时完全保持旧行为（异步 buildRequest 里重新选路）。
  prepareAttempt,
  lineage,
  getAgent,
  buildFeedback,
  injectFeedback,
  onParentSettled,
  writeSnapshot,
  readSnapshot,
  persistenceHealth: injectedPersistenceHealth,
  retryBackoff,
  getPersistenceGeneration,
  logger,
} = {}) {
  if (typeof createRuntime !== "function") throw new TypeError("createFanoutRuntimeModule 需要 createRuntime");
  if (lineage === null || typeof lineage !== "object"
    || typeof lineage.bindParentTask !== "function" || typeof lineage.parentAgentOf !== "function"
    || typeof lineage.allocateParentTaskId !== "function" || typeof lineage.releaseParentTask !== "function"
    || typeof lineage.deferredTasks !== "function" || typeof lineage.parentSessionsSnapshot !== "function") {
    throw new TypeError("createFanoutRuntimeModule 需要 lineage 小接口");
  }
  if (typeof getAgent !== "function") throw new TypeError("createFanoutRuntimeModule 需要 getAgent");
  if (typeof buildRequest !== "function") throw new TypeError("createFanoutRuntimeModule 需要 buildRequest");

  /**
   * 懒装配句柄 + 生命周期闸门，用**显式对象**承载（票据 39）。
   *
   * 为什么不是两个 let：对外门面整体提到了模块级 buildRuntimeFacade，它不能再隐式捕获
   * 工厂局部变量；state 就是它显式接收的那份可变句柄。语义与原来的两个 let 完全一致：
   * runtime 在 createRuntime 返回之前是 undefined（服务只在这之后读 manager），closed 一旦
   * 置 true 就永久封锁入口。
   */
  const state = { runtime: undefined, closed: false };

  const warn = (message) => {
    try { logger?.warn?.(message); } catch { /* 日志失败不影响调度 */ }
  };

  // ── 三个窄服务：每个都是自己那份状态的唯一 owner ─────────────────────────────
  // 能力组（C3）：lineage(1) · getAgent(2) · getManager(3) · continuationReadiness(4) ·
  // isClosed(5) · warn(6) —— 6 组 ≤ 8。
  const ownership = createFanoutOwnershipService({
    lineage,
    getAgent,
    getManager: () => state.runtime?.manager,
    continuationReadiness: (task) => (typeof state.runtime?.continuationReadiness === "function"
      ? state.runtime.continuationReadiness(task)
      : undefined),
    isClosed: () => state.closed === true,
    warn,
  });
  // 能力组（C3）：lineage(1) · getManager(2) · storage(3) · persistenceHealth(4) ·
  // retryBackoff(5) · warn(6) · ownership(7) —— 7 组 ≤ 8。
  const persistence = createFanoutPersistenceService({
    lineage,
    getManager: () => state.runtime?.manager,
    storage: { write: writeSnapshot, generation: getPersistenceGeneration },
    persistenceHealth: injectedPersistenceHealth,
    retryBackoff,
    warn,
    ownership,
  });
  // 能力组（C3）：lineage(1) · getAgent(2) · getManager(3) · readSnapshot(4) ·
  // ownership(5) · persistence(6) · warn(7) —— 7 组 ≤ 8。
  const restore = createFanoutRestoreService({
    lineage,
    getAgent,
    getManager: () => state.runtime?.manager,
    readSnapshot,
    ownership,
    persistence,
    warn,
  });

  /**
   * 对外门面在**模块级**构造（票据 39）：34 个门面（多为单行箭头）若留在工厂里，会把
   * 「单闭包内函数数」抬到 48；提到模块级后它们按自身规模单独计数，工厂内只剩一次调用。
   * 门面不捕获任何工厂局部变量：可变的 runtime/closed 经 state 显式传入。
   */
  const api = buildRuntimeFacade({
    state,
    ownership,
    persistence,
    restore,
    lineage,
    buildFeedback,
    injectFeedback,
    onParentSettled,
    getAgent,
    warn,
  });


  /** 动态解析函数（settings 接线）优先于 runtimeOptions 的静态默认值；非法类型忽略。 */
  const dynamicConcurrencyLimit = typeof concurrencyLimit === "function" || typeof concurrencyLimit === "number"
    ? concurrencyLimit
    : undefined;
  const dynamicRoleTimeoutMs = typeof roleTimeoutMs === "function" || typeof roleTimeoutMs === "number"
    ? roleTimeoutMs
    : undefined;
  const dynamicRoleLimits = typeof roleLimits === "function" ? roleLimits : undefined;
  const dynamicProviderLimits = typeof providerLimits === "function" ? providerLimits : undefined;

  state.runtime = createRuntime({
    ...runtimeOptions,
    // 模块级解析函数优先于 runtimeOptions 的静态默认值：静态值只是"没有动态来源时"的兜底。
    ...(dynamicConcurrencyLimit === undefined ? {} : { concurrencyLimit: dynamicConcurrencyLimit }),
    ...(dynamicRoleLimits === undefined ? {} : { roleLimits: dynamicRoleLimits }),
    ...(dynamicProviderLimits === undefined ? {} : { providerLimits: dynamicProviderLimits }),
    ...(dynamicRoleTimeoutMs === undefined ? {} : { roleTimeoutMs: dynamicRoleTimeoutMs }),
    buildRequest,
    startContinuable,
    interrupt,
    onAgentCreated,
    ...(typeof prepareAttempt === "function" ? { prepareAttempt } : {}),
    // 多轮复用接线：两者都只在 Host 提供时透传；缺失时 runtime 侧 admission 一律
    // fail-closed（绝不静默新建 child 顶替复用）。
    ...(continueMessage === undefined ? {} : { continueMessage }),
    ...(resolveChildSession === undefined ? {} : { resolveChildSession }),
    // 多轮复用的父权限解析：continueMessage 需要 exact parent Agent 才能投递给同一 child。
    parentAgentOf: (parentTaskId) => lineage.parentAgentOf(parentTaskId),
    persistence: { save: (snapshot) => api.persist(snapshot) },
    /**
     * 事件双消费入口（票据 26）。顺序固定为「先账本、后父任务结算」：
     * 1. onFanoutEvent：组合根的 per-shard 等待账本（shard 进入 running 或任一终态时精确
     *    结算该 shard 的排队工作，task_settled 时兜底结算剩余工作）；
     * 2. api.parentSettled：任务级等待原因释放、回收排除集合维护与父会话反馈。
     *
     * 钩子必须**在关闭/恢复早退之外**执行：关闭时 manager 会把未终态分片收敛为
     * cancelled，这些事件同样需要结算账本，否则 root 会在卸载前永久悬挂一个排队工作。
     * 钩子异常只记日志——等待账本的问题不能反过来打断事件投递。
     */
    onEvent: (event) => {
      if (typeof onFanoutEvent === "function") {
        try {
          onFanoutEvent(event);
        } catch (error) {
          warn("dsh-expert-group: fan-out event observer failed: " + describeError(error));
        }
      }
      return api.parentSettled(event);
    },
    log: (message, error) => warn("dsh-expert-group: " + message + (error instanceof Error ? ": " + error.message : "")),
  });
  return Object.freeze(api);
}
