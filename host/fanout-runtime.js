/**
 * Host 关注点模块：fan-out runtime 编排。
 *
 * 真正持有 createFanoutRuntime 实例、恢复标志（restoring/restorePending）、
 * 快照合并与父任务编排状态；fanout.js 的 manager 仍是唯一调度状态机。
 * 组合根只注入依赖并把工具/RPC/事件接线到本模块的小接口。
 *
 * @module dsh-expert-group/host/fanout-runtime
 */
import { createPersistenceHealth } from "./persistence-health.js";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function taskNeedsRoot(task) {
  return Array.isArray(task?.shards) && task.shards.some((shard) => (
    shard?.status === "queued" && shard?.cancelRequested !== true
  ));
}

const TERMINAL_SHARD_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/** 默认退避节奏：第 1 次失败后等 50ms，此后翻倍，封顶 2s。 */
const DEFAULT_RETRY_BACKOFF = Object.freeze({ baseDelayMs: 50, maxDelayMs: 2000 });

/**
 * manager 权威视角的父任务终态判定，与 snapshotTaskIsTerminal（只按恢复负载推导）互补。
 *
 * 为什么两套判定都要：恢复负载里的任务可能被 manager 在**同一个同步恢复窗口内**聚合到
 * 终态（例如无 shard 的恢复任务直接聚合为 completed，或恢复重排后立即收敛），此时
 * manager 因 restoringSnapshot 不再发布 task_settled，归属只能按这里的权威状态归还；
 * 只看恢复负载会让归属 id 一直滞留到 close（审核发现 04 的轻微泄漏）。
 *
 * 只接受 manager 的任务投影（getTask/taskSnapshot）：status 非 pending 或 settledAt 是
 * 数字即视为终态；stub/未知形态（null、缺字段）一律判非终态，宁可保留 binding 也不能
 * 误释放活动任务的 ownership。
 */
function managerTaskIsTerminal(taskView) {
  if (taskView === null || typeof taskView !== "object") return false;
  if (typeof taskView.settledAt === "number") return true;
  return typeof taskView.status === "string" && taskView.status !== "pending";
}

/**
 * 第 attempt 次持久化尝试失败后的退避等待时长（毫秒）：baseDelayMs * 2^(attempt-1)，
 * 并受 maxDelayMs 封顶。
 *
 * 纯函数：不读时钟、不 sleep、不持有状态，退避节奏因此可以被确定性断言；真实等待由
 * 注入的 sleep 完成（测试可换成延时记录器，不依赖真实定时器）。
 */
function retryDelayForAttempt(attempt, baseDelayMs, maxDelayMs) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : DEFAULT_RETRY_BACKOFF.baseDelayMs;
  const cap = Number.isFinite(maxDelayMs) && maxDelayMs >= base ? maxDelayMs : base;
  const raw = base * 2 ** (safeAttempt - 1);
  return Number.isFinite(raw) ? Math.min(cap, raw) : cap;
}

/** 生产用的退避等待：真实定时器；delayMs <= 0 时立即返回，不占用事件循环。 */
function defaultRetrySleep(delayMs) {
  if (!(delayMs > 0)) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

/**
 * 快照任务是否已经全部终态：只有非终态恢复任务需要保留 ownership。
 * 参数命名为 snapshotTask，避免与外层恢复循环里的 `task` 同名（TDZ 陷阱）。
 *
 * 终态判定与 fanout.js 的 shard 状态集合保持一致：最后一个 attempt 是终态时，
 * 恢复后的 shard 仍是终态（running attempt 会被恢复流程改写为 interrupted）。
 */
function snapshotTaskIsTerminal(snapshotTask) {
  const shards = Array.isArray(snapshotTask?.shards) ? snapshotTask.shards : [];
  if (shards.length === 0) return typeof snapshotTask?.settledAt === "number";
  return shards.every((shard) => {
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    const latest = attempts[attempts.length - 1];
    const status = latest?.status ?? shard?.status;
    return TERMINAL_SHARD_STATUSES.has(status);
  });
}

/**
 * @param {object} options
 * @param {Function} options.createRuntime - (runtimeOptions) => createFanoutRuntime 实例。
 * @param {object} [options.runtimeOptions] - concurrencyLimit/writeRoles 等。
 *   concurrencyLimit 支持传解析函数：由 manager 在每次新建父任务读取一次当前 settings，
 *   这样设置变更只影响之后创建的任务，已存在（含恢复）任务沿用创建时的限制。
 * @param {Function} options.buildRequest - 每个 shard 的请求装配。
 * @param {Function} options.startContinuable
 * @param {Function} [options.interrupt]
 * @param {object} options.lineage - 父任务 ownership 小接口。
 * @param {Function} options.getAgent - agents.get(id)。
 * @param {Function} options.buildFeedback - (task) => 注入给父会话的反馈文本。
 * @param {Function} options.injectFeedback - (parent, text) => void。
 * @param {Function} [options.onParentSettled] - 父任务真实终态回调
 *   (parentTaskId, parentAgent, parentAgentId) => void；exact Agent 在 lineage 活动绑定
 *   释放前已捕获，回调本身在归还之后触发，宿主据此释放该 fan-out 任务登记的 goal
 *   等待原因。closed/restoring/非终态一律不调用。
 * @param {Function} [options.writeSnapshot] - 持久化合并后的快照。
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
  /** 动态有效的 per-role 默认并发上限（settings 解析函数）；缺省时沿用 runtimeOptions。 */
  concurrencyLimit,
  buildRequest,
  startContinuable,
  continueMessage,
  resolveChildSession,
  interrupt,
  onAgentCreated,
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

  let runtime;
  let closed = false;
  let restoring = false;
  let restorePending;
  /**
   * 本次进程内由 restore() 建立 ownership 的父任务 id。
   * 恢复任务的 ownership 必须保留到真实终态或关闭路径释放：RPC 查询、
   * 事件归属过滤与持久化投影都依赖 lineage 的 parentSessions 映射；
   * 恢复时立即释放会让任务无法寻址，并让后续 snapshot 丢掉 parentSessions。
   * 只跟踪本进程内恢复的任务，不使用“bind 时就记账”的写法——submit 的绑定由
   * manager 快照路径负责，避免在这里维护第二套所有权真相。
   */
  const restoredOwnership = new Set();
  /**
   * 已终态、且活动 ownership 已到期的恢复任务 -> 父会话 id。
   *
   * 只保存 parentSessions 索引（与持久化快照同形）：任务数据永远来自 manager 的权威
   * listTasks()/getTask()，这里不复制 task/result，也不做第二套任务数据库。
   *
   * 为什么需要它：lineage 的 parentSessions 只表达**活动**绑定（RPC 寻址、反馈投递、
   * 事件归属过滤都依赖它），终态任务在 restore()/真实终态时必须释放，这是既有语义。
   * 但任务树仍要按根列出「已恢复或持久化下来的终态 fan-out」，否则冷启动后这些任务
   * 会从任何根的任务树中消失。归属解析顺序：lineage 当前绑定 → 本索引。
   */
  const settledParentSessions = new Map();
  /**
   * 任务创建/恢复时快照的父会话归属：parentTaskId -> parentSessionId。
   *
   * 为什么需要第三份索引：lineage 的 parentSessions 只表达**活动**绑定，root 被销毁时
   * （index.js 走 lineage.releaseAgent）会按父会话整批摘除。若 root 先销毁、任务后结算，
   * 归还路径就再也解析不到归属——持久化投影丢映射，重启后该任务从任务树消失（审核发现 04）。
   *
   * 边界：这份快照只用于**归还路径的兜底**，绝不参与 resolvedOwner 的寻址与访问控制
   * （那必须 fail-closed 地只看活动绑定，见 index.js 的 sessionId 校验）；任务在归还
   * 路径结算后立即删除，因此长会话不会随历史任务无限增长。
   */
  const ownershipSnapshot = new Map();
  /**
   * 冷恢复读凭据：parentTaskId -> { agent, token, ownerId }。
   *
   * 只由 `restore()` 为一个**本进程确实恢复过**的任务写入，并绑定当时的 exact root Agent
   * 对象与它的 generation token。用途仅限 continuation 的只读幂等重放：让「冷恢复后同一
   * requestId 仍能回答 duplicate=true」有明确的恢复来源证据，而不是靠字符串 parent id 或
   * settledParentSessions 兜底（后者无法区分合法冷恢复与同 id replacement）。
   * 不参与任何授权写决策；close() 时整体丢弃。
   */
  const restoreReadCredentials = new Map();
  const persistenceHealth = injectedPersistenceHealth === undefined
    ? createPersistenceHealth()
    : injectedPersistenceHealth;
  if (persistenceHealth === null || typeof persistenceHealth !== "object"
    || typeof persistenceHealth.beginDrain !== "function"
    || typeof persistenceHealth.endDrain !== "function"
    || typeof persistenceHealth.recordSuccess !== "function"
    || typeof persistenceHealth.recordFailure !== "function"
    || typeof persistenceHealth.retryDecision !== "function"
    || typeof persistenceHealth.snapshot !== "function") {
    throw new TypeError("createFanoutRuntimeModule 需要 persistenceHealth 小接口");
  }

  /**
   * 瞬时/代际失效持久化失败的退避参数与等待实现。
   *
   * sleep 可注入：测试用延时记录器替代真实定时器，从而对退避节奏做确定性断言，不依赖
   * 真实等待；生产环境用真实 setTimeout。退避只作用于 transient / generation-stale 这类
   * 可重试失败，容量与永久失败在 retryDecision 处直接收口，不进入等待。
   */
  const retryBackoffConfig = {
    baseDelayMs: Number.isFinite(retryBackoff?.baseDelayMs) && retryBackoff.baseDelayMs >= 0
      ? retryBackoff.baseDelayMs
      : DEFAULT_RETRY_BACKOFF.baseDelayMs,
    maxDelayMs: Number.isFinite(retryBackoff?.maxDelayMs) && retryBackoff.maxDelayMs >= 0
      ? retryBackoff.maxDelayMs
      : DEFAULT_RETRY_BACKOFF.maxDelayMs,
    sleep: typeof retryBackoff?.sleep === "function" ? retryBackoff.sleep : defaultRetrySleep,
  };

  /**
   * 动态默认并发上限的解析函数。
   *
   * 只接受函数或数字：Host 传 settings 读取闭包，测试可传固定数字；非法类型直接
   * 忽略（不能让模块装配把配置错误变成运行期调度异常）。
   */
  const dynamicConcurrencyLimit = typeof concurrencyLimit === "function" || typeof concurrencyLimit === "number"
    ? concurrencyLimit
    : undefined;

  const warn = (message) => {
    try { logger?.warn?.(message); } catch { /* 日志失败不影响调度 */ }
  };
  const closedResult = () => ({ accepted: false, changed: false, code: "RUNTIME_CLOSED", reason: "runtime_closed" });

  /**
   * 父任务归属解析：优先当前代际的活动绑定，其次终态任务的持久化归属索引。
   * 两者都只回答「这个父任务属于哪个根会话」，不回答任务是否还在活动。
   */
  function resolvedOwner(parentTaskId) {
    const active = typeof lineage.resolveOwner === "function"
      ? lineage.resolveOwner(parentTaskId)
      : (typeof lineage.parentSessionOf === "function" ? lineage.parentSessionOf(parentTaskId) : undefined);
    if (typeof active === "string" && active.length > 0) return active;
    const settled = settledParentSessions.get(parentTaskId);
    return typeof settled === "string" && settled.length > 0 ? settled : null;
  }

  /**
   * 归还路径的归属解析：先活动绑定（与寻址/事件过滤同一语义），活动绑定已消失时
   * 回退到任务创建/恢复时快照的父会话归属。
   *
   * 回退只服务「写 settled 索引」这一件事：root 先被销毁时 lineage 已无绑定，若直接
   * 放弃，持久化投影就丢映射，重启后该任务从任务树消失。
   */
  function returnOwner(parentTaskId) {
    const active = resolvedOwner(parentTaskId);
    if (typeof active === "string" && active.length > 0) return active;
    const snapshotOwner = ownershipSnapshot.get(parentTaskId);
    return typeof snapshotOwner === "string" && snapshotOwner.length > 0 ? snapshotOwner : null;
  }

  /**
   * continuation 归属拒绝的可诊断分类（只读、不泄露任务负载）。
   *
   * 只用于 Host 侧日志/结构化解构，不参与任何授权决策：授权只看
   * 「活动绑定 + exact parent Agent + 绑定代际 token 仍 live」这三个硬条件。
   */
  function describeContinuationOwnership({ owner, boundAgent, parent, bindingToken }) {
    if (typeof owner !== "string" || owner.length === 0) return "no_active_binding";
    if (owner !== parent?.id) return "owner_mismatch";
    if (boundAgent === undefined) return "parent_agent_unresolved";
    if (boundAgent !== parent) return "parent_agent_replaced";
    if (bindingToken === undefined) return "generation_evidence_missing";
    if (bindingToken.agent !== parent) return "generation_owner_mismatch";
    return "generation_not_live";
  }

  /**
   * continuation 只读幂等重放的证据判定。
   *
   * 两级证据，都要求「exact Agent 对象 + 仍然 live 的 generation token」，绝不接受单纯的
   * 字符串 parent id 或 settledParentSessions 兜底：
   * 1. `active_binding`：同进程的活动绑定（owner 命中活动 parentSessions、绑定的 exact
   *    parent Agent 就是调用方、绑定时的 generation token 仍 live）；
   * 2. `restore_credential`：冷恢复时由 restore() 记录的 exact Agent + token（同 id 的
   *    replacement 不是凭据里的对象，因此拿不到读权限）。
   *
   * 返回 null 表示没有可证明的来源 → 调用方必须结构化拒绝（fail-closed）。
   */
  function continuationReplayEvidence(parent, parentTaskId, activeBinding) {
    if (parent === undefined || parent === null || typeof parent.id !== "string") return null;
    if (activeBinding !== null) return activeBinding;
    const credential = restoreReadCredentials.get(parentTaskId);
    if (credential === undefined || credential.agent !== parent || credential.token === undefined) return null;
    if (typeof credential.ownerId === "string" && credential.ownerId !== parent.id) return null;
    return lineage.isLiveGeneration(parent, credential.token) ? "restore_credential" : null;
  }

  /**
   * 活动绑定的读证据（与写路径同一套硬条件）：owner + exact parent Agent + 绑定代际 token。
   * 只回答「这次读取是否有可证明的来源」，不回答任务是否可写。
   */
  function activeBindingReplayEvidence(parent, parentTaskId) {
    const owner = typeof lineage.resolveOwner === "function" ? lineage.resolveOwner(parentTaskId) : undefined;
    if (typeof owner !== "string" || owner !== parent.id) return null;
    const boundAgent = typeof lineage.parentAgentOf === "function" ? lineage.parentAgentOf(parentTaskId) : undefined;
    if (boundAgent !== parent) return null;
    const bindingToken = typeof lineage.parentTokenOf === "function" ? lineage.parentTokenOf(parentTaskId) : undefined;
    if (bindingToken === undefined || bindingToken.agent !== parent) return null;
    return lineage.isLiveGeneration(parent, bindingToken) ? "active_binding" : null;
  }

  /**
   * 归还父任务归属：把归属写进 settled 索引并把创建/恢复时的快照用完即删。
   *
   * settled 索引是任务树与持久化投影的归属来源：lineage 释放活动绑定后，任务数据仍由
   * manager 权威持有，但只有靠这份索引才能按根找回（否则重启后丢节点）。
   *
   * @param {string} parentTaskId
   * @param {boolean} [releaseBinding] - 是否同时释放 lineage 的活动绑定。三个真实释放点
   *   （settle 事件的真实终态、restore 窗口内的同步收口、close）传 true；submit 的任务
   *   沿用既有语义不在这里释放——它的绑定由 root 销毁/关闭路径负责，保持 RPC 的
   *   fail-closed 行为不变，也避免二次释放。
   */
  function settleOwnership(parentTaskId, releaseBinding = false) {
    const owner = returnOwner(parentTaskId);
    if (typeof owner === "string" && owner.length > 0) settledParentSessions.set(parentTaskId, owner);
    ownershipSnapshot.delete(parentTaskId);
    if (releaseBinding) {
      restoredOwnership.delete(parentTaskId);
      lineage.releaseParentTask(parentTaskId);
    }
  }

  const api = {
    /** 提交父任务：分配 id、绑定 ownership、失败时释放。 */
    submit(parent, args = {}) {
      if (closed) return { ...closedResult(), shardIds: [] };
      const parentTaskId = lineage.allocateParentTaskId(parent);
      lineage.bindParentTask({ parentTaskId, parentId: parent.id, parentAgent: parent });
      // 创建时快照归属：root 早于任务结算被销毁时，lineage 的活动绑定已被整批摘除，
      // 归还路径只能靠这份快照把归属写回 settled 索引（任务树与重启投影都依赖它）。
      ownershipSnapshot.set(parentTaskId, parent.id);
      try {
        const result = runtime.manager.submit({ parentTaskId, ...args });
        if (result.parentTaskId !== parentTaskId) {
          lineage.releaseParentTask(parentTaskId);
          ownershipSnapshot.delete(parentTaskId);
        }
        return { ...result, task: runtime.manager.getTask(result.parentTaskId) };
      } catch (error) {
        lineage.releaseParentTask(parentTaskId);
        ownershipSnapshot.delete(parentTaskId);
        throw error;
      }
    },
    /** manager 事件回调：父任务终态后向父会话注入一次聚合反馈。 */
    parentSettled(event) {
      if (closed || restoring || event?.type !== "task_settled") return false;
      const parentTaskId = event.parentTaskId;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      // 父 Agent 必须**先**捕获：下面的归还路径会释放 lineage 绑定，释放后再查就只剩
      // undefined。反馈投递本身走 microtask，用捕获的 exact 对象与已算好的文本。
      const parent = lineage.parentAgentOf(parentTaskId);
      const task = runtime.manager.getTask(parentTaskId);
      if (task === null) return false;
      // 归属结算先于反馈投递，且不依赖父 Agent 是否还活着：root 先被销毁时 parentAgentOf
      // 返回 undefined，但归属仍必须写进 settled 索引。事件类型是终态边界，这里再用
      // manager 状态复核一次，避免外部误传 task_settled（测试 seam）把活动任务提前归还。
      // 恢复任务的 ownership 到这里才到期：aggregateTask 只对从 pending 进入终态的结算
      // 发布 task_settled，因此这是「真实终态」的唯一边界；已终态的恢复任务直接在
      // restore() 内归还（不会再有任何事件把它带回活动态）。
      if (managerTaskIsTerminal(task)) {
        // 归属 id 必须在归还前解析：settleOwnership 会消费 ownershipSnapshot 并清掉
        // 活动绑定，之后再查就只剩 settled 索引（root 已销毁时需要它兜底定位）。
        const ownerId = returnOwner(parentTaskId);
        // 恢复任务的活动 ownership 到真实终态才到期；submit 的任务保持既有绑定语义。
        settleOwnership(parentTaskId, restoredOwnership.has(parentTaskId));
        // goal 等待原因必须由真实终态边界释放。这里传的是已捕获的 exact Agent（而不是
        // 重新按 id 解析），因为宿主侧 release 需要对象身份一致才认；ownerId 只是
        // exact Agent 已不可用时的兜底根 id。非终态的伪 task_settled 走不到这里，
        // 因此不会提前释放仍在活动的等待原因。
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
        if (closed || restoring || getAgent(parent.id) !== parent) return;
        try { injectFeedback(parent, text); } catch (error) {
          warn("dsh-expert-group: fan-out parent feedback failed: " + describeError(error));
        }
      });
      return true;
    },
    // 关闭后的迟到 fan-out 事件仍交给 runtime 识别：已知 child/session 返回 true，
    // 这样 index.js 不会把它们误交给旧 recovery；未知对象仍返回 false，保留正常事件路由。
    handleAgentCreated: (agent, persistedIdentity) => runtime.handleAgentCreated(agent, persistedIdentity),
    handleAgentDisposed: (agent, persistedIdentity) => runtime.handleAgentDisposed(agent, persistedIdentity),
    handleSessionEvent: (session, event) => runtime.handleSessionEvent(session, event),
    restoreEvents: (events) => (closed ? false : runtime.restoreEvents(events)),
    whenIdle: () => runtime.manager.whenIdle(),
    /**
     * 只读预算投影（用量 / 冻结上限 / 最近一次违规）。不暴露任何调度内部状态，
     * 关闭后不再提供（与 getTask/listTasks 的关闭语义一致）。
     */
    budget: () => (closed || typeof runtime?.manager?.budget !== "function"
      ? null
      : runtime.manager.budget()),
    getTask: (parentTaskId) => (closed ? null : runtime.manager.getTask(parentTaskId)),
    listTasks: () => (closed ? [] : runtime.manager.listTasks()),
    /**
     * 按根会话过滤 manager 的权威任务（任务树的唯一数据来源）。
     *
     * 与 lineage.tasksOwnedBy 的差别只有一个：这里同时覆盖**活动 ownership 已到期**
     * 的已终态恢复任务。归属仍按 parentSessions 语义解析，因此不会把任务串到别的根，
     * 也不暴露任何跨根历史。
     */
    tasksOwnedBy(sessionId) {
      if (closed || typeof sessionId !== "string" || sessionId.length === 0) return [];
      return runtime.manager.listTasks().filter((task) => {
        const parentTaskId = task?.parentTaskId;
        return typeof parentTaskId === "string" && resolvedOwner(parentTaskId) === sessionId;
      });
    },
    /**
     * 单任务归属解析（C7 冷恢复用）：返回当前活动绑定，其次已终态任务的归属索引。
     *
     * 宿主据此判断「这个从快照恢复出来的父任务属于哪个 root，root 是否还存活」；
     * 它只回答归属，不回答任务是否活动（也不要暴露 manager 内部状态）。关闭后
     * 返回 null，与 getTask/listTasks 的关闭语义一致。
     */
    ownerOf(parentTaskId) {
      if (closed || typeof parentTaskId !== "string" || parentTaskId.length === 0) return null;
      return resolvedOwner(parentTaskId);
    },
    /**
     * 「该 exact live root 能否证明自己拥有这个父任务」的只读判定。
     *
     * 为什么需要它：root turn 等待只能由**任务真正归属的那一代 root**建立，
     * 否则同 id 的 replacement 或已销毁 root 就能替别人登记等待工作，让一个不会再产生
     * task_settled 的任务把 root 永久钉在等待中。
     *
     * 授权条件与 continuation 写路径**同一套硬条件**（activeBindingReplayEvidence），
     * 绝不接受单纯的字符串 parent id，也不使用 settledParentSessions 兜底：
     * 1. 活动绑定存在且 ownerId 精确等于调用方 id；
     * 2. 绑定的 exact parent Agent 就是调用方对象（同 id replacement 不是该对象）；
     * 3. 绑定当时的 generation token 仍是调用方的 live generation；
     * 4. 任务非终态 —— 终态任务不会再产生 task_settled，登记原因等于永久 paused。
     *
     * 只读：不改变任何状态、不注册任何凭据，返回 false 表示无法证明归属（fail-closed）。
     *
     * @param {object} parent - 调用方 exact root Agent。
     * @param {string} parentTaskId - fan-out 父任务 id。
     * @returns {boolean} 是否可证明归属。
     */
    ownsTask(parent, parentTaskId) {
      if (closed) return false;
      if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") return false;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      const task = runtime.manager.getTask(parentTaskId);
      if (task === null || managerTaskIsTerminal(task)) return false;
      return activeBindingReplayEvidence(parent, parentTaskId) !== null;
    },
    getEvents: (options) => (closed
      ? { events: [], nextSequence: Number.isSafeInteger(options?.after) && options.after >= 0 ? options.after : 0 }
      : runtime.getEvents(options)),
    cancelParent: (parentTaskId) => (closed ? closedResult() : runtime.manager.cancelParent(parentTaskId)),
    cancelShard: (parentTaskId, shardId) => (closed ? closedResult() : runtime.manager.cancelShard(parentTaskId, shardId)),
    retryShard: (parentTaskId, shardId) => (closed ? closedResult() : runtime.manager.retryShard(parentTaskId, shardId)),
    /**
     * 多轮复用：对**本 root 拥有的**父任务续作一轮（同一 parentTaskId / childId，新 attempt）。
     *
     * 全部前置条件都在 manager 状态修改**之前**判定，任一不满足即结构化拒绝、不追加 attempt、
     * 不改变任务状态（fail-closed）。判定顺序：
     * 1. 调用方必须是当前代际的 exact live root（同 id replacement / 已销毁 root 一律拒绝）；
     * 2. 父任务必须由**当前代际**的活动绑定拥有：仅当 `lineage.resolveOwner` 命中活动
     *    parentSessions、绑定的 exact parent Agent 就是调用方、且绑定当时的 generation token
     *    仍然 `isLiveGeneration(parent, token)` 时才成立。**不使用 settledParentSessions 兜底**
     *    （那只是冷恢复后的寻址索引，不构成可写权限证据），因此冷恢复后已终态、且 restore
     *    已归还 ownership 的任务不会被误接受后异步失败；
     * 3. 执行路由必须就绪：continueMessage 已接线，且每个分片既有 child 的 session 可解析
     *    （否则无法绑定本轮 turn 归属，也会在投递阶段失败）。
     *
     * manager 自己负责 role/shard 结构一致性、上一轮 wait-all 是否完成、attempt/requestId
     * 预算与幂等；这里不重复实现。
     *
     * @param {object} parent - 调用方的 exact root Agent。
     * @param {{parentTaskId:string, role:string, basePrompt:string, shards:object[], requestId?:string}} args
     * @returns {object} 结构化结果（accepted/reason/round/nextAttemptByShard/task）。
     */
    continueTask(parent, args = {}) {
      if (closed) return { ...closedResult() };
      const parentTaskId = typeof args?.parentTaskId === "string" ? args.parentTaskId.trim() : "";
      if (parentTaskId.length === 0) return { accepted: false, changed: false, reason: "missing_parent_task_id" };
      /**
       * 幂等重放（**只读**，不新增 attempt/child/事件）：已记录的 requestId 直接返回上次结果。
       *
       * 读权限边界（终审问题 1）：重放不是写操作，但同样必须有**明确的来源证据**，不能用
       * 「字符串 parent id 相同」或 settledParentSessions 兜底来授权——否则同 id
       * replacement root 可以读到旧代际的续作结果。只接受两类证据（见
       * continuationReplayEvidence）：
       * - 同进程活动绑定 + 绑定代际 token（同一 live root 的正常重放）；
       * - 冷恢复时 restore() 记录在案的 exact Agent + 其 generation token（恢复来源证据）。
       * 都没有时**不在这里返回**：继续走下面的写路径前置条件，最终以 `not_owned_by_root`
       * 结构化拒绝（fail-closed），且不产生任何状态修改。
       */
      const replayRequestId = typeof args?.requestId === "string" && args.requestId.length > 0 ? args.requestId : undefined;
      if (replayRequestId !== undefined) {
        const replayEvidence = continuationReplayEvidence(parent, parentTaskId, activeBindingReplayEvidence(parent, parentTaskId));
        if (replayEvidence !== null) {
          const currentTask = runtime.manager.getTask(parentTaskId);
          const recorded = currentTask?.continuationRequests?.[replayRequestId];
          if (recorded !== undefined && recorded !== null && typeof recorded.result === "object") {
            // 重放不触发任何等待工作重新登记（index.js 按 duplicate 标记跳过）。
            return { ...recorded.result, duplicate: true, ...(currentTask === null ? {} : { task: currentTask }) };
          }
        }
      }
      // 1. 调用方代际：token 必须已存在（activateRoot 时铸造）且仍是 exact live generation。
      const callerToken = typeof lineage.tokenOf === "function" ? lineage.tokenOf(parent) : undefined;
      if (callerToken === undefined || !lineage.isLiveGeneration(parent, callerToken)) {
        return { accepted: false, changed: false, reason: "not_live_root", parentTaskId, ownership: "caller_not_live" };
      }
      // 2. 活动 ownership + 绑定代际证据：不做 settled 兜底，也不接受 replacement 继承。
      //    与只读重放共用同一个证据函数（activeBindingReplayEvidence），保证读写边界一致：
      //    读能过 ⇒ exact Agent + 绑定 token 均 live；写还要额外满足执行路由就绪。
      const owner = typeof lineage.resolveOwner === "function" ? lineage.resolveOwner(parentTaskId) : undefined;
      const boundAgent = typeof lineage.parentAgentOf === "function" ? lineage.parentAgentOf(parentTaskId) : undefined;
      const bindingToken = typeof lineage.parentTokenOf === "function" ? lineage.parentTokenOf(parentTaskId) : undefined;
      if (activeBindingReplayEvidence(parent, parentTaskId) === null) {
        return {
          accepted: false,
          changed: false,
          reason: "not_owned_by_root",
          parentTaskId,
          ownership: describeContinuationOwnership({ owner, boundAgent, parent, bindingToken }),
        };
      }
      // 3. 任务存在 + 执行路由就绪（两者都只读）。
      const task = runtime.manager.getTask(parentTaskId);
      if (task === null) return { accepted: false, changed: false, reason: "unknown_parent_task", parentTaskId };
      const readiness = typeof runtime.continuationReadiness === "function"
        ? runtime.continuationReadiness(task)
        : { ok: false, reason: "continue_route_unavailable", shardIds: [] };
      if (readiness?.ok !== true) {
        return {
          accepted: false,
          changed: false,
          reason: typeof readiness?.reason === "string" ? readiness.reason : "continue_route_unavailable",
          parentTaskId,
          shardIds: Array.isArray(readiness?.shardIds) ? readiness.shardIds : [],
        };
      }
      const result = runtime.manager.continueTask({ ...args, parentTaskId });
      const nextTask = runtime.manager.getTask(parentTaskId);
      return { ...result, ...(nextTask === null ? {} : { task: nextTask }) };
    },
    /**
     * 恢复快照：只恢复当前已存在的 root 任务；缺失 root 的 queued 任务留在
     * lineage deferred 中，等 root 出现后再恢复。
     */
    restore() {
      if (closed) return { ...closedResult(), restored: 0, deferred: 0, pending: restorePending === true };
      if (typeof readSnapshot !== "function") return { restored: 0, deferred: 0, pending: restorePending === true };
      const snapshot = readSnapshot();
      if (snapshot === void 0 || snapshot === null || !Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) {
        return { restored: 0, deferred: 0, pending: restorePending === true };
      }
      const existingTaskIds = new Set(runtime.manager.listTasks().map((task) => task.parentTaskId));
      const restorableTasks = [];
      let deferredCount = 0;
      for (const task of snapshot.tasks) {
        if (existingTaskIds.has(task?.parentTaskId)) continue;
        const parentId = lineage.parentSessionOf(task?.parentTaskId);
        if (taskNeedsRoot(task) && (typeof parentId !== "string" || getAgent(parentId) === void 0)) {
          deferredCount += 1;
          lineage.deferTask({ parentTaskId: task.parentTaskId, parentId, task });
          continue;
        }
        if (typeof parentId === "string") {
          lineage.bindParentTask({ parentTaskId: task.parentTaskId, parentId, parentAgent: getAgent(parentId) });
        }
        restorableTasks.push(task);
      }
      // 快照被外部替换时移除已不存在的 deferred 条目；不能按字符串 id 复活旧代际。
      const snapshotTaskIds = new Set(snapshot.tasks.map((task) => task?.parentTaskId));
      for (const parentTaskId of lineage.deferredTasks().map((task) => task.parentTaskId)) {
        if (!snapshotTaskIds.has(parentTaskId)) lineage.releaseParentTask(parentTaskId);
      }
      restorePending = deferredCount > 0 || lineage.deferredTasks().length > 0;
      if (restorableTasks.length === 0) return { restored: 0, deferred: deferredCount, pending: restorePending };
      restoring = true;
      try {
        // resume: true 让唯一调度状态机按原规则继续执行未终态 work（queued attempt 复用、
        // running→interrupted 换新 attempt、role concurrency / affectedPaths / 取消意图
        // 全部由 manager 自己判定）；本模块只负责 ownership 与寻址。
        runtime.manager.restore({ ...snapshot, tasks: restorableTasks }, { resume: true, merge: existingTaskIds.size > 0 });
        const snapshotParents = snapshot.parentSessions !== null && typeof snapshot.parentSessions === "object"
          && !Array.isArray(snapshot.parentSessions) ? snapshot.parentSessions : {};
        for (const task of restorableTasks) {
          // 非终态任务保持 ownership：它仍可能被 RPC 查询、取消/重试、事件过滤或
          // 聚合反馈寻址，释放只能发生在真实终态或关闭路径。
          const parentTaskId = task?.parentTaskId;
          if (typeof parentTaskId !== "string") continue;
          // 顺序不可颠倒：必须在 lineage 释放之前取归属，否则只剩快照可查。
          const owner = resolvedOwner(parentTaskId) ?? snapshotParents[parentTaskId];
          if (typeof owner === "string" && owner.length > 0) ownershipSnapshot.set(parentTaskId, owner);
          /**
           * 冷恢复读凭据：本次 restore 究竟把该任务恢复给了**哪个 exact root Agent**。
           *
           * 只在「本进程确实从这个快照恢复过该任务」时记录，并把凭据绑定到当时的 exact
           * Agent 对象与它的 generation token。它只服务 continuation 的**只读幂等重放**
           * （duplicate 回执），不构成任何写权限证据：
           * - 同 id replacement R2 不是凭据里的 agent 对象 → 拒绝；
           * - 凭据 agent 被销毁/替换（token 失活）→ `isLiveGeneration` 为假 → 拒绝；
           * - 没有凭据（例如 RPC 读路径只看到 settledParentSessions）→ 拒绝。
           * 非终态任务另有活动绑定，重放优先走绑定证据；凭据对它们只是冗余兜底。
           */
          const parentId = typeof owner === "string" && owner.length > 0 ? owner : lineage.parentSessionOf(parentTaskId);
          const restoredAgent = typeof parentId === "string" ? getAgent(parentId) : undefined;
          if (restoredAgent !== undefined && typeof lineage.tokenFor === "function") {
            const token = lineage.tokenFor(restoredAgent);
            if (token !== undefined) {
              restoreReadCredentials.set(parentTaskId, { agent: restoredAgent, token, ownerId: parentId });
            }
          }
          // manager 可能在**恢复窗口内**就把任务聚合到终态（restoringSnapshot 会抑制
          // task_settled，此后不会再有事件把它带回来），因此这里按 manager 的权威状态
          // 复核一次并立即归还：否则归属 id 会一直滞留到 close（轻微泄漏），持久化
          // 投影也只能靠活动绑定而拿不到映射。
          const managerTask = typeof runtime?.manager?.getTask === "function"
            ? runtime.manager.getTask(parentTaskId)
            : null;
          if (snapshotTaskIsTerminal(task) || managerTaskIsTerminal(managerTask)) {
            // 这里释放的是本次 restore 刚建立的绑定，因此无条件释放（不依赖记账集合）。
            settleOwnership(parentTaskId, true);
          } else {
            restoredOwnership.add(parentTaskId);
          }
        }
        restorePending = lineage.deferredTasks().length > 0;
        return { restored: restorableTasks.length, deferred: deferredCount, pending: restorePending };
      } catch (error) {
        warn("dsh-expert-group: fan-out snapshot restore failed: " + describeError(error));
        return { restored: 0, deferred: deferredCount, pending: restorePending };
      } finally {
        restoring = false;
      }
    },
    /** 持久化投影：合并 deferred 任务的 parentSessions，避免丢失不可寻址任务。 */
    snapshotForStorage(snapshot) {
      const parentSessions = lineage.parentSessionsSnapshot();
      const tasksById = new Map((Array.isArray(snapshot?.tasks) ? snapshot.tasks : []).map((task) => [task?.parentTaskId, task]));
      for (const task of lineage.deferredTasks()) {
        const parentTaskId = task?.parentTaskId;
        if (!tasksById.has(parentTaskId)) tasksById.set(parentTaskId, task);
        const parentId = lineage.deferredParentOf(parentTaskId);
        if (typeof parentId === "string" && parentId.length > 0) parentSessions[parentTaskId] = parentId;
      }
      // 已终态任务的归属是**寻址索引**而非活动 ownership：lineage 已按既有语义释放
      // （或在 root 销毁时被整批摘除），但持久化必须保留它，否则重启后这些任务不再属于
      // 任何根（冷终态 fan-out 与 root 销毁后结算的任务都会从任务树消失）。
      for (const [parentTaskId, parentId] of settledParentSessions) {
        if (parentSessions[parentTaskId] === undefined) parentSessions[parentTaskId] = parentId;
      }
      return { ...snapshot, tasks: [...tasksById.values()], parentSessions };
    },
    /**
     * 落盘旁路：对同一次提交只做有界重试。generation stale 会重新读取 manager 最新快照
     * 合并后再写；健康记录只在内存中更新，不触发新的 persistence 回调。
     */
    async persist(snapshot) {
      if (typeof writeSnapshot !== "function") return false;
      let payload = api.snapshotForStorage(snapshot);
      const token = persistenceHealth.beginDrain({
        generation: typeof getPersistenceGeneration === "function" ? getPersistenceGeneration() : payload.generation,
        sequence: payload.sequence,
      });
      let attempt = 1;
      try {
        while (true) {
          const generation = typeof getPersistenceGeneration === "function" ? getPersistenceGeneration() : payload.generation;
          try {
            const written = await writeSnapshot(payload);
            if (written !== true && written?.ok !== true) {
              const writeError = written?.ok === false ? written.error : written;
              if (writeError instanceof Error) throw writeError;
              if (writeError !== null && typeof writeError === "object" && !Array.isArray(writeError)) throw writeError;
              throw { category: "permanent", message: "持久化写入未返回成功确认" };
            }
            persistenceHealth.recordSuccess({ generation, sequence: payload.sequence });
            return true;
          } catch (error) {
            const failure = persistenceHealth.recordFailure({ error, generation, sequence: payload.sequence, attempt });
            const decision = persistenceHealth.retryDecision({ category: failure.category, attempt });
            if (!decision.retry) {
              warn("dsh-expert-group: fan-out snapshot persistence failed [" + failure.category + "]: " + describeError(error));
              return false;
            }
            // 指数退避：第 attempt 次失败后等待 base * 2^(attempt-1)（封顶 maxDelayMs）。
            // 容量/永久失败在上面的分支直接收口，不会进入等待；这里的等待保证存储抖动时
            // 不形成无退避的重写紧循环。等待时长是纯计算量，sleep 可注入记录器以便测试
            // 对退避节奏做确定性断言（不依赖真实定时器）。
            const backoffMs = retryDelayForAttempt(attempt, retryBackoffConfig.baseDelayMs, retryBackoffConfig.maxDelayMs);
            try {
              await retryBackoffConfig.sleep(backoffMs);
            } catch (waitError) {
              // 注入的等待实现异常不能让持久化旁路变成未处理拒绝：退避失败等价于立即重试。
              warn("dsh-expert-group: fan-out persistence retry backoff failed: " + describeError(waitError));
            }
            attempt = decision.nextAttempt;
            if (decision.merge && typeof runtime?.manager?.snapshot === "function") {
              try {
                const previous = payload;
                const latest = api.snapshotForStorage(runtime.manager.snapshot());
                const previousSequence = Number.isSafeInteger(previous?.sequence) ? previous.sequence : 0;
                const latestSequence = Number.isSafeInteger(latest?.sequence) ? latest.sequence : 0;
                const events = new Map();
                for (const event of Array.isArray(previous?.events) ? previous.events : []) {
                  if (Number.isSafeInteger(event?.sequence)) events.set(event.sequence, event);
                }
                for (const event of Array.isArray(latest?.events) ? latest.events : []) {
                  if (Number.isSafeInteger(event?.sequence)) events.set(event.sequence, event);
                }
                payload = {
                  ...latest,
                  sequence: Math.max(previousSequence, latestSequence),
                  events: [...events.values()].sort((left, right) => left.sequence - right.sequence),
                };
              } catch (mergeError) {
                warn("dsh-expert-group: fan-out snapshot merge failed: " + describeError(mergeError));
              }
            }
          }
        }
      } finally {
        persistenceHealth.endDrain(token);
      }
    },
    describe: () => ({
      closed,
      restorePending: restorePending === true,
      activeAttempts: closed ? 0 : runtime.activeAttemptCount,
      tasks: closed ? 0 : runtime.manager.listTasks().length,
      // 已终态任务的归属索引（只读观测，不参与调度）：包含已释放活动 ownership 的恢复
      // 任务，以及 root 先销毁、任务后结算的任务。
      settledTasks: settledParentSessions.size,
      persistenceHealth: persistenceHealth.snapshot(),
      // 只读并发视图（有效默认值 / 各 role 覆盖 / 解析来源）：让"设置页显示的并发上限"
      // 与实际调度值在同一处可诊断，不暴露任务负载。
      ...(typeof runtime?.manager?.concurrencyLimits === "function"
        ? { concurrencyLimits: runtime.manager.concurrencyLimits() }
        : {}),
      // 只读预算视图（用量 / 冻结上限 / 最近一次违规）；关闭后不再有意义。
      ...(typeof runtime?.manager?.budget === "function" ? { budget: runtime.manager.budget() } : {}),
    }),
    /**
     * 显式落盘一次当前快照（由宿主在需要立刻持久化时调用）。
     *
     * 为什么需要显式入口：manager 的状态机只覆盖任务本身，宿主侧的登记（例如 fan-out
     * 等待代次）变化不会触发它落盘。这类变化频率与任务数量同阶，因此这里的显式 flush
     * 不会被高频调用；它复用既有 persist 旁路（合并、退避、健康记录、generation 校验
     * 都不复制）。
     *
     * 关闭后返回 false：卸载路径不得再发起新的 domain 写入。
     * @returns {Promise<boolean>} 是否成功落盘。
     */
    flushSnapshot() {
      if (closed) return Promise.resolve(false);
      try {
        return Promise.resolve(api.persist(runtime.manager.snapshot())).then((written) => written === true, (error) => {
          warn("dsh-expert-group: fan-out snapshot flush failed: " + describeError(error));
          return false;
        });
      } catch (error) {
        warn("dsh-expert-group: fan-out snapshot flush failed: " + describeError(error));
        return Promise.resolve(false);
      }
    },
    /**
     * 幂等关闭：先封锁本模块入口，再让 manager 写入关闭终态并由 runtime 处理中断。
     * manager 必须先收敛，避免 runtime 的 deferred reject 被误判成普通 failed。
     */
    close() {
      if (closed) return false;
      closed = true;
      // 关闭是 ownership 的另一个真实释放点：模块已封锁，不可能再有 settle 事件。
      // 归还走 settleOwnership：manager.close() 会把仍未终态的恢复任务写成 cancelled，
      // 且关闭时的最终持久化投影仍要按 settled 索引取归属，否则重启后这些任务丢节点。
      for (const parentTaskId of [...restoredOwnership]) settleOwnership(parentTaskId, true);
      restoredOwnership.clear();
      // 模块已封锁：创建时快照不再有任何归还路径可消费（未结算任务的归属随模块一起丢弃）。
      ownershipSnapshot.clear();
      // 读凭据同样随模块生命周期结束而丢弃（只读幂等重放不再可服务，读写都 fail-closed）。
      restoreReadCredentials.clear();
      try {
        const managerClose = typeof runtime.manager?.close === "function" ? runtime.manager.close() : undefined;
        if (managerClose !== null && typeof managerClose === "object" && typeof managerClose.catch === "function") {
          managerClose.catch((error) => warn("dsh-expert-group: fan-out manager close failed: " + describeError(error)));
        }
      } catch (error) {
        warn("dsh-expert-group: fan-out manager close failed: " + describeError(error));
      }
      try {
        const runtimeClose = runtime.close();
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

  runtime = createRuntime({
    ...runtimeOptions,
    // 模块级解析函数（settings 接线）优先于 runtimeOptions.concurrencyLimit 的静态默认值：
    // 静态值只是"没有动态来源时"的兜底，不能让组合根的历史常量把 settings 压住。
    ...(dynamicConcurrencyLimit === undefined ? {} : { concurrencyLimit: dynamicConcurrencyLimit }),
    buildRequest,
    startContinuable,
    interrupt,
    onAgentCreated,
    /**
     * 多轮复用接线：把本轮 prompt 投递给既有 child，并解析它的 session。
     *
     * 两者都只在 Host 提供时透传；缺失时 runtime 侧的 continuation admission 一律
     * fail-closed（绝不静默新建 child 顶替复用）。
     */
    ...(continueMessage === undefined ? {} : { continueMessage }),
    ...(resolveChildSession === undefined ? {} : { resolveChildSession }),
    // 多轮复用的父权限解析：continueMessage 需要 exact parent Agent 才能投递给同一 child。
    parentAgentOf: (parentTaskId) => lineage.parentAgentOf(parentTaskId),
    persistence: { save: (snapshot) => api.persist(snapshot) },
    onEvent: (event) => api.parentSettled(event),
    log: (message, error) => warn("dsh-expert-group: " + message + (error instanceof Error ? ": " + error.message : "")),
  });
  return Object.freeze(api);
}
