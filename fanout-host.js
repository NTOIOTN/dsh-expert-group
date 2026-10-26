/**
 * Host 侧 fan-out 适配器的 **coordinator 壳**（R2 票据 10）。
 *
 * ## 拆分结果（源文件 1,893 行 -> 三服务 + 本壳）
 * - `host/fanout-attribution.js`：身份解析 + attempt 注册表 + 归属判定 + 归属老化；
 * - `host/fanout-lifecycle.js`：admission + 结算 + agent 侧接线 + close；
 * - `host/fanout-event-log.js`：事件日志（写入 / 恢复 / 游标差集 / 只读状态）+ 事件读取原语；
 * - 本文件：**只做装配与事件发布顺序**，不再持有任何 records/maps 状态。
 *
 * ## 为什么事件发布顺序留在这里
 * 拆分前 `rememberEvent()` 的顺序是「先归一入日志，再调用 onEvent 广播」。拆分后
 * event-log 服务只返回归一结果、**不发布**；本文件是唯一调用 `onEvent` 的地方，
 * 因此「入日志 -> 广播」的先后顺序、以及广播异常只记日志的边界都保持不变。
 * 三个服务都不自行发布或重排事件。
 *
 * ## 对外契约不变
 * `createFanoutRuntime` 的 options 与返回面、以及本文件 11 个导出键（8 个被 `index.js`
 * 消费的具名导出 + `fanoutAttemptKey` / `extractFanoutResult` / `FANOUT_EVENT_LOG_LIMIT`）
 * 与拆分前逐项相同。
 *
 * fanout.js 只负责可测试的调度状态机，本模块负责把一个 shard attempt 映射到独立的 DSH
 * continuable child。agent/created 只补齐 child/session 句柄；只有 session/event 的
 * turn/end 才能 resolve/reject completion。
 *
 * close() 与异步 admission 的竞态边界：关闭后不再进入 buildRequest/startContinuable；
 * 还在 buildRequest 阶段的 admission 会同步以关闭错误收敛，已经挂在 startContinuable
 * 上的 launcher 若之后才拿到 childId，只对该 child 发出一次 interrupt，并用显式关闭错误
 * （FanoutClosedError / runtime_closed）一次性收敛 completion。
 *
 * close() 同时复用 fanout.js 的 manager.close 作为共享关闭门：runtime 单独关闭后，
 * 通过公开 runtime.manager.submit/retryShard/restore 发起的新操作一律结构化失败
 * （MANAGER_CLOSED / manager_closed），不入队、不恢复、不新建 attempt。
 */
import { createFanoutManager } from "./fanout.js";
import {
  FANOUT_EVENT_LOG_LIMIT,
  createFanoutEventLog,
  extractFanoutResult,
  isObject,
} from "./host/fanout-event-log.js";
import {
  FANOUT_ATTEMPT_MARKER,
  FANOUT_MARKER,
  FANOUT_PARENT_AGENT_MARKER,
  FANOUT_PARENT_TASK_MARKER,
  FANOUT_SHARD_MARKER,
  createFanoutAttribution,
  fanoutAttemptKey,
  isFanoutAgent,
  isFanoutIdentity,
} from "./host/fanout-attribution.js";
import { createFanoutLifecycle } from "./host/fanout-lifecycle.js";

// 公开导出面（与拆分前逐项相同）：常量与纯身份函数由 attribution 拥有，事件日志上限与
// 结果提取由 event-log 拥有，本文件只做再导出，不复制实现。
export {
  FANOUT_ATTEMPT_MARKER,
  FANOUT_MARKER,
  FANOUT_PARENT_AGENT_MARKER,
  FANOUT_PARENT_TASK_MARKER,
  FANOUT_SHARD_MARKER,
  fanoutAttemptKey,
  isFanoutAgent,
  isFanoutIdentity,
} from "./host/fanout-attribution.js";
export { FANOUT_EVENT_LOG_LIMIT, extractFanoutResult } from "./host/fanout-event-log.js";

/** 归属老化默认窗口（毫秒）；0 表示显式禁用（测试/极端配置）。 */
const ATTRIBUTION_AGING_DEFAULT_MS = 60000;

/**
 * 创建 Host 适配器和共享 fan-out manager。
 *
 * buildRequest 必须返回 { request, parentAgent?, role?, parentId? }，request 会
 * 原样交给 startContinuable。startContinuable 的返回值可用 childId 或 subagentId。
 *
 * 多轮复用（continuation）另需：
 * - `continueMessage({ childId, parentAgent, input, signal })`：把本轮 prompt 投递给**同一
 *   child** 并返回新的 messageId（生产走 subagents.sendMessage）；缺失时续作 admission
 *   一律失败，绝不静默新建 child；
 * - `resolveChildSession(childId)`：解析既有 child 的 session（用于把本轮 attempt 绑定到
 *   该 session，让它的 turn/end 结算本轮）。缺失时退回 runtime 内部的有界索引；
 * - `prepareAttempt({ task, shard, attempt, round, continuation })`（可选，票据 03）：
 *   在 attempt 进入 running **之前**同步冻结派发路由；返回 `{ok:true, snapshot, selection}`
 *   时快照写入 `attempt.route` 并由 buildRequest 直接消费（不再重新选路），返回
 *   `{ok:false, code}` 时该 attempt 走 queued→failed 终态，返回 null/缺省时保持旧路径；
 * - `parentAgentOf(parentTaskId)`：解析父任务所属的 exact root Agent（投递需要父权限）。
 *
 * @param {object} options - Host 注入的 fan-out 协作面（见上）。
 * @returns {object} runtime 面：manager、launcher/continuer/canceller、事件读写、诊断与 close。
 */
export function createFanoutRuntime(options = {}) {
  if (!isObject(options)) throw new TypeError("createFanoutRuntime 需要配置对象");
  if (typeof options.buildRequest !== "function") throw new TypeError("fan-out buildRequest 必须是函数");
  if (typeof options.startContinuable !== "function") throw new TypeError("fan-out startContinuable 必须是函数");
  if (options.continueMessage !== undefined && options.continueMessage !== null && typeof options.continueMessage !== "function") {
    throw new TypeError("fan-out continueMessage 必须是函数");
  }
  if (options.resolveChildSession !== undefined && options.resolveChildSession !== null && typeof options.resolveChildSession !== "function") {
    throw new TypeError("fan-out resolveChildSession 必须是函数");
  }
  // 派发前路由冻结 seam（票据 03）：可选，缺失时 manager 走旧的异步选路。
  if (options.prepareAttempt !== undefined && options.prepareAttempt !== null && typeof options.prepareAttempt !== "function") {
    throw new TypeError("fan-out prepareAttempt 必须是函数");
  }
  const rawAttributionAgingMs = options.attributionAgingMs;
  if (rawAttributionAgingMs !== undefined && rawAttributionAgingMs !== null
    && (typeof rawAttributionAgingMs !== "number" || !Number.isFinite(rawAttributionAgingMs) || rawAttributionAgingMs < 0)) {
    throw new TypeError("fan-out attributionAgingMs 必须是 0 或正有限数");
  }
  const attributionAgingMs = rawAttributionAgingMs === undefined || rawAttributionAgingMs === null
    ? ATTRIBUTION_AGING_DEFAULT_MS
    : rawAttributionAgingMs;

  const onEvent = typeof options.onEvent === "function" ? options.onEvent : undefined;
  const log = typeof options.log === "function" ? options.log : () => {};

  // 时钟 seam：与拆分前同一解析顺序（options.clock 优先，其次 options 上的裸函数）；
  // 归属老化（attribution）与 manager 的超时/停止看门狗共用它，但互不改变对方的状态机。
  const agingClock = isObject(options.clock) ? options.clock : undefined;
  const clock = {
    now: typeof agingClock?.now === "function"
      ? agingClock.now
      : (typeof options.now === "function" ? options.now : () => Date.now()),
    setTimeout: typeof agingClock?.setTimeout === "function"
      ? agingClock.setTimeout
      : (typeof options.setTimeout === "function" ? options.setTimeout : (fn, ms) => setTimeout(fn, ms)),
    clearTimeout: typeof agingClock?.clearTimeout === "function"
      ? agingClock.clearTimeout
      : (typeof options.clearTimeout === "function" ? options.clearTimeout : (handle) => clearTimeout(handle)),
  };

  /**
   * manager 端口（晚绑定）。
   *
   * manager 的构造需要三个服务的回调，而服务又需要 manager 的权威读面/关闭门，因此这里
   * 用 **let + 端口**打破构造环：端口只暴露归属权威读写（attemptMessageIdOf /
   * attemptIdentityOf / markAttributionAged / recordAttributionViolation）与关闭门 close，
   * 不暴露订阅/广播能力——事件广播仍然只在本文件发生。
   */
  let manager;
  const managerPort = {
    attemptMessageIdOf: (parentTaskId, shardId, attemptNumber) => (typeof manager.attemptMessageIdOf === "function"
      ? manager.attemptMessageIdOf(parentTaskId, shardId, attemptNumber)
      : null),
    attemptIdentityOf: (parentTaskId, shardId, attemptNumber) => (typeof manager.attemptIdentityOf === "function"
      ? manager.attemptIdentityOf(parentTaskId, shardId, attemptNumber)
      : null),
    markAttributionAged: (identity, agingOptions) => manager.markAttributionAged(identity, agingOptions),
    recordAttributionViolation: (payload) => manager.recordAttributionViolation(payload),
    close: () => manager.close(),
  };

  const eventLog = createFanoutEventLog();
  const attribution = createFanoutAttribution({
    log,
    managerPort,
    clock,
    attributionAgingMs,
    resolveChildSession: options.resolveChildSession,
    parentAgentOf: options.parentAgentOf,
    hasContinueRoute: () => typeof options.continueMessage === "function",
  });
  const lifecycle = createFanoutLifecycle({
    log,
    attribution,
    managerPort,
    buildRequest: options.buildRequest,
    startContinuable: options.startContinuable,
    continueMessage: options.continueMessage,
    interrupt: options.interrupt,
    onAgentCreated: options.onAgentCreated,
  });

  manager = createFanoutManager({
    launcher: lifecycle.launcher,
    // 多轮复用走 continuer（同一 child 的新一轮 prompt），其余 attempt 仍走 launcher。
    continuer: lifecycle.continueShard,
    canceller: lifecycle.canceller,
    // 派发前路由冻结（票据 03）：manager 在进入 running 之前同步调用它；缺失时保持旧行为。
    ...(typeof options.prepareAttempt === "function" ? { prepareAttempt: options.prepareAttempt } : {}),
    persistence: options.persistence,
    conflictChecker: options.conflictChecker,
    writeRoles: options.writeRoles,
    allowOverlap: options.allowOverlap,
    concurrencyLimit: options.concurrencyLimit,
    roleLimits: options.roleLimits,
    // provider 级并发上限（票据 26）：与 roleLimits 同形的解析函数/静态映射，
    // 直接透传给 manager；本模块不缓存、不做第二套判定。
    providerLimits: options.providerLimits,
    // 角色级默认超时（票据 06）：同 concurrencyLimit 一样支持解析函数，
    // 由 manager 在每次新建 attempt 时读一次当前 settings。
    roleTimeoutMs: options.roleTimeoutMs,
    // 时钟注入：老化的 Host 定时器与 manager 的超时/停止看门狗共用同一时钟 seam，
    // 直传原对象而不是上面归一后的 clock，保持「manager 自己解析时钟」的既有语义。
    ...(isObject(options.clock) ? { clock: options.clock } : {}),
  });

  /**
   * 事件发布的**唯一**决定点（顺序与拆分前 rememberEvent 内部逐字相同）：
   * 1. 先归一并写入事件日志；2. 再广播给宿主的 onEvent。
   * 广播异常只记日志，不能反向打断 manager 的事件投递。
   */
  const unsubscribeManager = manager.subscribe((event) => {
    const normalized = eventLog.rememberEvent(event);
    try { onEvent?.(normalized); } catch (error) { log("fan-out event callback failed", error); }
  });

  /**
   * 幂等关闭低层 runtime；返回 true 表示本次调用真正执行了关闭。
   *
   * record 收敛与 manager.close 由 lifecycle 服务完成（顺序不变）；本文件负责最后一步
   * 退订 manager（拆分前排在同一函数末尾），因此整体顺序与拆分前一致。
   */
  function close() {
    if (!lifecycle.close()) return false;
    try { unsubscribeManager?.(); } catch {}
    return true;
  }

  return {
    manager,
    launcher: lifecycle.launcher,
    /** 多轮复用的续作 admission（manager 的 continuer）。 */
    continuer: lifecycle.continueShard,
    /**
     * continuation 的执行前置条件（只读）：投递路由 + 每个分片既有 child 的 session 是否
     * 可解析。Host 必须在 manager 状态修改之前调用它，任何不满足都必须结构化拒绝。
     */
    continuationReadiness: attribution.continuationReadiness,
    canceller: lifecycle.canceller,
    isFanoutAgent,
    /**
     * guard/登记之前的 fan-out child 身份预检（只读）：index.js 必须在安装 scoped guard、
     * 登记 exact Agent 之前调用它；失败即终止该 created 路由（见 precheckChildIdentity）。
     */
    precheckFanoutChildIdentity: attribution.precheckChildIdentity,
    handleAgentCreated: lifecycle.handleAgentCreated,
    handleSessionEvent: lifecycle.handleSessionEvent,
    handleAgentDisposed: lifecycle.handleAgentDisposed,
    restoreEvents: eventLog.restoreEvents,
    getEvents: eventLog.getEvents,
    eventLogStatus: eventLog.eventLogStatus,
    /**
     * 停止/归属诊断投影（票据 07）：manager 的未确认停止视图 + Host 侧归属老化窗口。
     *
     * 只读：不触发调度、不改状态、不清理定时器。关闭后仍可读取（manager 的终态与 Host
     * 的计数都保留在内存里，供卸载前最后一次诊断/测试断言）。
     */
    stopDiagnostics() {
      const managerState = typeof manager.stopDiagnostics === "function" ? manager.stopDiagnostics() : null;
      return {
        ...(managerState ?? {}),
        aging: attribution.stopDiagnosticsAging(),
      };
    },
    /**
     * 限流/排队诊断（票据 26，只读转发）：manager 是计数与限流状态的唯一来源，
     * Host 只负责透出，不额外维护第二套 running/queued 计数。旧 manager 缺能力时
     * 返回 null（消费方必须按"不可用"处理，绝不伪造 0）。
     */
    throttleDiagnostics: () => (typeof manager.throttleDiagnostics === "function"
      ? manager.throttleDiagnostics()
      : null),
    close,
    /**
     * 只读预算视图：当前用量、冻结上限与最近一次违规。恢复事件（外部输入）的违规
     * 不属于 manager，因此在这里与 manager 的违规合并后返回（取更新的一方）。
     */
    budget: () => {
      const managerBudget = manager.budget();
      const lastEventViolation = eventLog.lastViolation();
      return lastEventViolation === null
        ? managerBudget
        : {
          ...managerBudget,
          eventLog: eventLog.count(),
          // 恢复事件历史属于 restore 阶段（manager 的 lastViolationPhase 不覆盖它）。
          lastViolationPhase: "restore",
          lastViolation: lastEventViolation,
        };
    },
    get activeAttemptCount() { return attribution.attemptCount; },
    /**
     * 只读诊断：某 attempt 当前的会话绑定状态（sessionId / 安装代次 / 是否有实例 / 阶段 /
     * 是否有 admission 期间的 disposal 待决标记 / 已忽略的迟到 disposal 数）。
     *
     * 用途是验证两轮终审修复的可观测不变式：latest-session 规则（replacement 后写回不得推进/
     * 回退代次）与 disposal 替换窗口（未绑定的 continuation admission 不得被旧实例 disposal
     * 提前终结）。返回普通标量，不暴露 session/Agent 对象引用。
     */
    sessionBindingOf: attribution.sessionBindingOf,
  };
}
