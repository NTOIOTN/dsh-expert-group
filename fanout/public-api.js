/**
 * fan-out 公开门面（R3-14：从组合根 fanout.js 整段迁出 manager 装配）。
 *
 * ## 职责
 * 只做**装配**：校验构造参数 → 按依赖方向创建 7 个领域模块与 3 个基础设施工厂 →
 * 晚绑定两处互递归端口 → 返回冻结的 manager 命令面（32 个键，逐项与迁移前一致）。
 * 领域实现全部在各自 owner 模块里，本文件不承载任何状态机。
 *
 * ## 状态所有权（C5）
 * 本模块**不持有**可变状态：所有可变值都在 store / events / persistence / serializer /
 * state / scheduler / task-commands 各自的 owner 内；这里只保存它们在闭包里的引用。
 *
 * ## 依赖方向（无环）
 * store -> events -> limits -> snapshot -> persistence -> state -> scheduler -> commands，
 * 两处互递归（scheduler<->commands、state<->scheduler）用构造后的 bind* 晚绑定打断。
 *
 * ## 迁移说明（R3-14）
 * 纯搬迁：参数校验顺序、错误码、budgetPolicy 冻结口径、装配顺序、返回值逐行不变。
 *
 * @module dsh-expert-group/fanout/public-api
 */
import { FANOUT_BUDGET } from "../resource-budget.js";
import { DEFAULT_CONCURRENCY_LIMIT, validateTimeoutMs } from "./contracts.js";
import { STOP_GRACE_MS } from "./errors.js";
import {
  FanoutValidationError,
  normalizeProviderLimits,
  normalizeRoleLimits,
  normalizeWriteRoles,
  validateConcurrencyLimit,
} from "./validation.js";
import { createTaskStore } from "./store.js";
import { createLimitResolver } from "./limits.js";
import { createFanoutEventBus } from "./events.js";
import { createFanoutSerializer } from "./snapshot.js";
import { createFanoutPersistence } from "./persistence.js";
import { createFanoutState } from "./state.js";
import { createScheduler } from "./scheduler.js";
import { createTaskCommands } from "./task-commands.js";

/**
 * 创建一个 fan-out 管理器（组合根：只装配，不再承载领域实现）。
 *
 * @param {object} options - 与原实现逐项相同（launcher/continuer/canceller/clock/persistence/
 *   conflictChecker/conflictObserver/writeRoles/allowOverlap/concurrencyLimit/roleLimits/
 *   providerLimits/roleTimeoutMs/maxSnapshotBytes/stopGraceMs）。
 * @returns {object} fan-out 管理器公共接口（命令面逐项不变）。
 */
export function createFanoutManager(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new FanoutValidationError("INVALID_OPTIONS", "createFanoutManager 需要配置对象");
  }
  const {
    launcher,
    continuer,
    canceller,
    clock,
    persistence,
    conflictChecker: injectedConflictChecker,
    conflictObserver,
    roleLimits: rawRoleLimits,
    providerLimits: rawProviderLimits,
    concurrencyLimit: rawConcurrencyLimit,
    roleTimeoutMs: rawRoleTimeoutMs,
    stopGraceMs: rawStopGraceMs,
  } = options;
  if (typeof launcher !== "function") {
    throw new FanoutValidationError("INVALID_LAUNCHER", "必须注入 launcher 函数");
  }
  if (continuer !== undefined && continuer !== null && typeof continuer !== "function") {
    throw new FanoutValidationError("INVALID_CONTINUER", "continuer 必须是函数");
  }
  if (canceller !== undefined && canceller !== null && typeof canceller !== "function") {
    throw new FanoutValidationError("INVALID_CANCELLER", "canceller 必须是函数");
  }
  if (persistence !== undefined && persistence !== null && typeof persistence.save !== "function") {
    throw new FanoutValidationError("INVALID_PERSISTENCE", "persistence.save 必须是函数");
  }
  if (conflictObserver !== undefined && conflictObserver !== null && typeof conflictObserver !== "function") {
    throw new FanoutValidationError("INVALID_CONFLICT_OBSERVER", "conflictObserver 必须是函数");
  }
  const now = typeof clock?.now === "function" ? clock.now : () => Date.now();
  const setTimeoutFn = typeof clock?.setTimeout === "function" ? clock.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn = typeof clock?.clearTimeout === "function" ? clock.clearTimeout : (handle) => clearTimeout(handle);

  /**
   * 停止宽限期（票据 07）：只驱动"停止未确认"看门狗，不改变逻辑状态。
   *
   * 非法值必须在构造期显式失败（配置写错不能静默回退），合法值为 0 或正有限数：
   * 0 表示看门狗立即到期（仅测试/极端配置使用）。
   */
  const stopGraceMs = rawStopGraceMs === undefined || rawStopGraceMs === null
    ? STOP_GRACE_MS
    : (() => {
        if (typeof rawStopGraceMs !== "number" || !Number.isFinite(rawStopGraceMs) || rawStopGraceMs < 0) {
          throw new FanoutValidationError("INVALID_STOP_GRACE", "stopGraceMs 必须是 0 或正有限数", { field: "stopGraceMs" });
        }
        return rawStopGraceMs;
      })();

  // 默认并发上限既可以是静态整数，也可以是"每次解析都读取一次"的解析函数。
  // 函数形式接入插件 settings 的 roleConcurrencyLimit：静态非法值必须在构造期显式
  // 失败（配置写错不能静默降级），函数返回值则按归一化规则回退默认值——settings 里
  // 的旧配置/非法值不能污染调度器。
  //
  // 来源模型（票据 03「并发来源修复」）：
  // - 构造期注入函数 ⇒ live：**始终**跟随当前设置，restore 绝不允许把来源改成
  //   snapshot。否则一次重启就会把"当前设置"永久旁路，设置页与真实并发脱节；
  // - 没有注入函数 ⇒ snapshot：使用构造时的静态值或恢复出来的快照值。这类进程读不到
  //   "当前设置"，只能冻结最后一次已知值，并在诊断里如实标注 snapshot。
  // 任务级显式 concurrencyLimit 是另一层，始终优先且随任务快照固化，不受本条影响。
  const hasLiveConcurrencyResolver = typeof rawConcurrencyLimit === "function";
  /**
   * 角色级默认超时（票据 06）：number | 解析函数 | undefined。
   *
   * 与并发上限的模式一致：
   * - 函数形式是「每次新建 attempt 时读一次当前 settings」的动态来源；
   * - 静态值在构造期显式校验（配置写错必须立刻失败）；
   * - 函数返回非法值/抛错时只能降级为「未启用」——超时配置
   *   错误不能让派发抛错；
   * - 0 是合法的「角色级显式禁用」，会原样作为解析结果传递。
   */
  const staticRoleTimeoutMs = typeof rawRoleTimeoutMs === "function" || rawRoleTimeoutMs === undefined || rawRoleTimeoutMs === null
    ? undefined
    : (() => {
        const check = validateTimeoutMs(rawRoleTimeoutMs, "roleTimeoutMs");
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "roleTimeoutMs" });
        return check.value;
      })();
  /**
   * 预算策略：默认全部取自 resource-budget.js 的冻结值；maxSnapshotBytes 可在
   * 组合根/测试里收紧，用于验证"超限不落盘"的显式拒绝路径。
   *
   * 构造期冻结、运行期只读，因此不进 state（state 只收纳可变值）。
   */
  const budgetPolicy = Object.freeze({
    ...FANOUT_BUDGET,
    ...(Number.isSafeInteger(options.maxSnapshotBytes) && options.maxSnapshotBytes > 0
      ? { maxSnapshotBytes: options.maxSnapshotBytes }
      : {}),
  });
  /** 冲突检查器是否为默认实现：restore 需要据此决定是否随 writeRoles 重建。 */
  const usesDefaultConflictChecker = typeof injectedConflictChecker !== "function";
  /** 已回收任务 id 的有界集合容量（常量，不属于运行期状态）。 */
  const RECLAIMED_TASK_MEMORY = 256;
  /**
   * 构造期初值：state 对象字面量内部无法互相引用，先算好再展开。
   *
   * 默认并发上限的来源模型（票据 03「并发来源修复」）：构造期注入函数 ⇒ live
   * （每次解析都读当前设置）；否则 snapshot（冻结最后一次已知值）。静态非法值必须
   * 在构造期显式失败（配置写错不能静默降级），函数返回值则按归一化规则回退默认值。
   */
  const initialDefaultConcurrencyLimit = typeof rawConcurrencyLimit === "function"
    ? DEFAULT_CONCURRENCY_LIMIT
    : (rawConcurrencyLimit === undefined
      ? DEFAULT_CONCURRENCY_LIMIT
      : (() => {
          const check = validateConcurrencyLimit(rawConcurrencyLimit);
          if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "concurrencyLimit" });
          return check.value;
        })());
  /** writeRoles 归一化结果同时供 state 与默认冲突检查器使用。 */
  const initialWriteRoles = normalizeWriteRoles(options.writeRoles);

  // ── 组合：按依赖方向装配（无环） ──
  const store = createTaskStore({
    config: {
      initialWriteRoles,
      injectedConflictChecker,
      usesDefaultConflictChecker,
      allowOverlap: options.allowOverlap === true,
      // 只读生命周期探针：延迟到调用时求值，构造期不触碰尚未创建的 state。
      isClosed: () => state.gate.closed,
      conflictObserver,
    },
  });
  const events = createFanoutEventBus({ store, clock: { now }, isClosed: () => state.gate.closed });
  const limits = createLimitResolver({
    config: {
      concurrencyLimit: rawConcurrencyLimit,
      hasLiveConcurrencyResolver,
      initialDefaultConcurrencyLimit,
      initialRoleLimits: normalizeRoleLimits(rawRoleLimits),
      initialProviderLimits: normalizeProviderLimits(rawProviderLimits),
      roleTimeoutSource: rawRoleTimeoutMs,
      staticRoleTimeoutMs,
    },
    events,
  });
  store.bindLimits(limits);
  const serializer = createFanoutSerializer({ store, limits, events, budget: budgetPolicy });
  const persist = createFanoutPersistence({
    clock: { now },
    events,
    budget: budgetPolicy,
    serialize: () => serializer.serializeSnapshotEnvelope(),
    save: persistence,
  });
  const state = createFanoutState({
    store,
    limits,
    events,
    persistence: persist,
    snapshot: serializer,
    clock: { now },
    budget: budgetPolicy,
    config: { hasLiveConcurrencyResolver, injectedConflictChecker },
  });
  const clockPort = { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, stopGraceMs };
  const scheduler = createScheduler({
    store,
    limits,
    events,
    persistence: persist,
    agents: { launcher, continuer, canceller },
    clock: clockPort,
    ownerGate: { gate: state.gate, reclaim: state.reclaim },
  });
  const commands = createTaskCommands({
    store,
    limits,
    scheduler,
    events,
    persistence: persist,
    agents: { launcher, continuer, canceller },
    clock: clockPort,
    ownerGate: { gate: state.gate, reclaim: state.reclaim },
  });
  // 晚绑定：打断 scheduler<->commands 与 state<->scheduler 的互递归。
  scheduler.bindCommands(commands);
  state.bindScheduler(scheduler);
  state.bindCommands(commands);
  state.bindDispatch(scheduler.dispatchAvailable);

  // 公开写入口一律包成"一次调用 = 一个持久化批"，读接口保持原样。
  return Object.freeze({
    submit: (input) => persist.withPersistenceBatch(() => commands.submit(input)),
    cancelShard: (parentTaskId, shardId) => persist.withPersistenceBatch(() => commands.cancelShard(parentTaskId, shardId)),
    cancelParent: (parentTaskId) => persist.withPersistenceBatch(() => commands.cancelParent(parentTaskId)),
    retryShard: (parentTaskId, shardId) => persist.withPersistenceBatch(() => commands.retryShard(parentTaskId, shardId)),
    continueTask: (input) => persist.withPersistenceBatch(() => commands.continueTask(input)),
    prepareReclaim: (parentTaskIds) => state.prepareReclaim(parentTaskIds),
    commitReclaim: (token) => persist.withPersistenceBatch(() => state.owner.commitReclaim(token)),
    abortReclaim: (token) => state.abortReclaim(token),
    reclaimableCount: () => store.countReclaimableTasks(),
    attemptMessageIdOf: scheduler.attemptMessageIdOf,
    attemptIdentityOf: scheduler.attemptIdentityOf,
    recordAttributionViolation: (input) => persist.withPersistenceBatch(() => scheduler.recordAttributionViolation(input)),
    observeStopEvidence: (identity, evidence) => persist.withPersistenceBatch(() => scheduler.observeStopEvidence(identity, evidence)),
    markAttributionAged: (identity, agedOptions) => persist.withPersistenceBatch(() => scheduler.markAttributionAged(identity, agedOptions)),
    stopDiagnostics: scheduler.stopDiagnostics,
    getTask: commands.getTask,
    listTasks: commands.listTasks,
    getCounts: commands.getCounts,
    taskCapabilities: commands.taskCapabilities,
    subscribe: events.subscribe,
    whenIdle: scheduler.whenIdle,
    isIdle: scheduler.isIdle,
    close: () => persist.withPersistenceBatch(() => state.close()),
    snapshot: () => serializer.serializeSnapshot(),
    restore: (snapshot, restoreOptions) => persist.withPersistenceBatch(() => state.restore(snapshot, restoreOptions)),
    persistSnapshot: persist.persistSnapshot,
    recordBudgetViolation: (violation, phase, rbvOptions = {}) => persist.withPersistenceBatch(() => {
      if (state.gate.closed) return { recorded: false, reason: "manager_closed" };
      if (violation === null || typeof violation !== "object" || Array.isArray(violation)) {
        return { recorded: false, reason: "invalid_violation" };
      }
      const normalizedPhase = typeof phase === "string" && phase.length > 0 ? phase : "restore";
      events.noteBudgetViolation(violation, normalizedPhase, {
        ...(typeof rbvOptions?.parentTaskId === "string" && rbvOptions.parentTaskId.length > 0
          ? { parentTaskId: rbvOptions.parentTaskId }
          : {}),
      });
      persist.notifyPersistence();
      return { recorded: true, phase: normalizedPhase };
    }),
    persistenceStatus: () => Object.freeze({ lastResult: persist.lastResult() }),
    eventHistoryStatus: events.eventHistoryStatus,
    concurrencyLimits: limits.concurrencyLimits,
    throttleDiagnostics: scheduler.throttleDiagnostics,
    budget: () => Object.freeze({
      limits: Object.freeze({ ...budgetPolicy }),
      tasks: store.taskTableSize(),
      events: events.historyCount(),
      eventBytes: events.historyBytes(),
      eventHistory: events.eventHistoryStatus(),
      lastViolation: events.budgetDiagnostics().lastViolation,
      lastViolationPhase: events.budgetDiagnostics().lastViolationPhase,
    }),
  });
}
