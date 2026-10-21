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

/** JSON 安全的只读拷贝；诊断面绝不能把内部对象引用交给调用方。 */
function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * 把恢复失败归一为稳定结构（code/message/field/violation）。
 *
 * - manager 抛出的 FanoutValidationError 自带 code/field/violation，直接透传；
 * - 其它异常统一归为 RESTORE_FAILED，避免把宿主内部错误类名当成稳定契约；
 * - message 只用于诊断文案（index 会再做长度/控制字符归一），不写入任何持久化。
 */
function describeRestoreFailure(error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "RESTORE_FAILED";
  const field = typeof error?.field === "string" && error.field.length > 0 ? error.field : null;
  const violation = error?.violation !== null && typeof error?.violation === "object" && !Array.isArray(error.violation)
    ? cloneJson(error.violation)
    : null;
  return Object.freeze({ code, message: describeError(error), field, violation });
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
  /**
   * 动态有效的角色级并发映射（票据 26）：settings.roleLimits 的解析函数。
   *
   * 与 concurrencyLimit 是两层关系，不是替代关系：concurrencyLimit 是「没有逐角色
   * 覆盖时」的默认值，roleLimits 是逐角色覆盖。两者都必须接线，否则设置页的映射
   * 会变成永不生效的配置项。
   */
  roleLimits,
  /**
   * 动态有效的 provider 级并发映射（票据 26）：settings.providerLimits 的解析函数。
   * {provider: 0..64}，0/未设置表示不限制；只约束真正进入 running 的分片数。
   */
  providerLimits,
  /**
   * 动态有效的角色级默认超时（settings 解析函数或静态毫秒数，票据 06）。
   * manager 在每次新建 attempt 时读一次；0 表示不启用。
   */
  roleTimeoutMs,
  /**
   * manager 事件只读观察钩子（票据 26）：每个 shard/task 事件都会回调一次。
   *
   * 组合根用它把「排队 shard」登记进 root turn 等待账本并在 running/终态时精确结算；
   * 钩子异常只记日志，绝不影响事件投递或调度状态机。
   */
  onFanoutEvent,
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
  /**
   * 已回收任务的**归属提示**：parentTaskId -> parentSessionId（有界、只在内存）。
   *
   * 为什么需要它：回收会同时移除任务与全部归属索引，之后 get/events/写动作若只看活动
   * 绑定与 settled 索引，就只能回答 "not-found"，无法把"这个任务曾属于你、但已被回收"
   * 收敛成票据 05/09 约定的 task_not_found。这份提示只含 id（不复制任务数据），
   * 有界（RECLAIMED_OWNER_MEMORY）、不写 storage、重启即消失，因此**不是**任务墓碑：
   * - 不进入快照/列表/事件，任何查询都不会看到已回收任务本身；
   * - 只回答"哪个 root 可以把自己的这个 id 视为 task_not_found"，对其他 root 一律
   *   仍是 not_owner/not-found（不泄露跨 root 存在性）。
   */
  const reclaimedTaskOwners = new Map();
  /** 归属提示上限：与 fanout.js 的迟到回调记忆同阶，远大于单次回收批量（maxTasks=64）。 */
  const RECLAIMED_OWNER_MEMORY = 256;
  /**
   * 恢复失败 / 持久化结果的内存诊断面（只读、不写 storage）。
   *
   * - lastRestore：最近一次真实执行过的恢复结果（ok / 结构化 error / 计数）；
   * - persistenceBlocked：恢复失败后的 fail-closed 闸门；只有成功恢复才清除；
   * - lastPersistOutcome：Host 层最近一次落盘结果（saved / skipped(reason) /
   *   failed(category)），失败分类的权威仍是 persistenceHealth。
   */
  let lastRestore = null;
  let persistenceBlocked = null;
  let lastPersistOutcome = null;

  /** 记录最近一次真实恢复结果（只读诊断；error 由 describeRestoreFailure 归一）。 */
  function recordRestoreOutcome({ ok, restored, deferred, pending, error }) {
    lastRestore = Object.freeze({
      ok: ok === true,
      at: Date.now(),
      restored: Number.isSafeInteger(restored) ? restored : 0,
      deferred: Number.isSafeInteger(deferred) ? deferred : 0,
      pending: pending === true,
      error: error ?? null,
    });
    return lastRestore;
  }

  /** 记录最近一次 Host 层落盘结果（只读诊断；不触发新的持久化回调）。 */
  function recordPersistOutcome(outcome) {
    lastPersistOutcome = Object.freeze({
      status: outcome?.status === "saved" || outcome?.status === "failed" ? outcome.status : "skipped",
      reason: typeof outcome?.reason === "string" ? outcome.reason : null,
      category: typeof outcome?.category === "string" ? outcome.category : null,
      sequence: Number.isSafeInteger(outcome?.sequence) ? outcome.sequence : null,
      at: Date.now(),
    });
    return lastPersistOutcome;
  }

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
  /**
   * 动态角色默认超时的解析来源：与并发上限同一形式。
   * 非法类型直接忽略（装配错误不能变成调度异常）；manager 侧还有一道校验兜底。
   */
  const dynamicRoleTimeoutMs = typeof roleTimeoutMs === "function" || typeof roleTimeoutMs === "number"
    ? roleTimeoutMs
    : undefined;
  /**
   * 动态角色级/provider 级并发映射（票据 26）。
   *
   * 两者都只接受函数：静态映射无法表达「设置页保存后立即生效」，而本票据的核心语义
   * 正是这一点。非法类型直接忽略（装配错误不能变成调度异常）；manager 侧还有一道
   * 归一与诊断兜底（非法条目回退默认值/不限制并产生一次性诊断）。
   */
  const dynamicRoleLimits = typeof roleLimits === "function" ? roleLimits : undefined;
  const dynamicProviderLimits = typeof providerLimits === "function" ? providerLimits : undefined;

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
   * 记一条已回收任务的归属提示（有界，插入序淘汰最旧项）。
   *
   * @param {string} parentTaskId
   * @param {string} ownerId
   */
  function rememberReclaimedOwner(parentTaskId, ownerId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    if (typeof ownerId !== "string" || ownerId.length === 0) return;
    reclaimedTaskOwners.delete(parentTaskId);
    reclaimedTaskOwners.set(parentTaskId, ownerId);
    while (reclaimedTaskOwners.size > RECLAIMED_OWNER_MEMORY) {
      const oldest = reclaimedTaskOwners.keys().next().value;
      reclaimedTaskOwners.delete(oldest);
    }
  }

  /** 已回收任务的归属提示（只读；没有记录返回 null）。 */
  function reclaimedOwnerOf(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return null;
    const owner = reclaimedTaskOwners.get(parentTaskId);
    return typeof owner === "string" && owner.length > 0 ? owner : null;
  }

  /**
   * 进程内「回收排除集合」：已进入回收流程的父任务 id（**落盘时**必须被排除）。
   *
   * 为什么需要它（票据 05 第三轮 blocking）：回收是三步——候选快照落盘、commit、最终快照。
   * 关闭路径会在候选落盘的 await 期间由 manager.close() 再生成一份**仍含待回收任务**的快照
   * 并落盘（它生成于 commit 之前）；如果最终快照写失败，磁盘就停在那份旧快照上，重启后
   * 已回收任务复活。把 id 登记在这里后，**任何**经由 api.persist 的写入（关闭快照、普通
   * 状态写入、最终快照）都会把它并入 omitParentTaskIds：即使快照正文生成于 commit 之前，
   * 落盘投影也已经排除这些 id。
   *
   * 生命周期与回收三步严格对应：
   * - 候选 persist **之前**登记：从此之后产生的任何快照在落盘时都被过滤；
   * - 候选落盘失败（abort）或 commit 失败：撤销登记，并做一次**绕过**排除的补偿写入
   *   （此时内存里任务还在，磁盘不能缺少它们）；
   * - commit 成功 + 最终快照成功：撤销登记；
   * - commit 成功 + 最终快照失败：**保留**登记，让后续写入继续排除这些 id（避免关闭期
   *   旧快照复活任务），直到同 id 被新任务复用（manager 的 task_registered 事件）或进程退出。
   *
   * 有界（DURABLE_RECLAIM_OMIT_LIMIT）、只存 id 字符串、不写 storage、不进快照/诊断：
   * 因此它不是任务墓碑；淘汰最旧项只会在"长期存储故障 + 大量回收"的极端情况下发生，
   * 且只会回到"最终快照失败"本身的 best-effort 语义，不会产生新的逻辑分叉。
   */
  const durableReclaimOmit = new Set();
  /** 排除集合上限：与已回收归属提示同阶，远大于单次回收批量（maxTasks=64）。 */
  const DURABLE_RECLAIM_OMIT_LIMIT = 256;

  /** 登记一个「落盘时必须排除」的 id（有界，插入序淘汰最旧项）。 */
  function rememberDurableReclaimOmit(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    // 先删后插：重复登记会刷新插入序，淘汰时优先淘汰真正最久未使用的 id。
    durableReclaimOmit.delete(parentTaskId);
    durableReclaimOmit.add(parentTaskId);
    while (durableReclaimOmit.size > DURABLE_RECLAIM_OMIT_LIMIT) {
      const oldest = durableReclaimOmit.values().next().value;
      durableReclaimOmit.delete(oldest);
    }
  }

  /** 撤销一个 id 的落盘排除登记（回收中止/成功，或同 id 被新任务复用）。 */
  function forgetDurableReclaimOmit(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    durableReclaimOmit.delete(parentTaskId);
  }

  /** 批量撤销（一次回收的全部 eligible id）。 */
  function forgetDurableReclaimOmitMany(parentTaskIds) {
    for (const parentTaskId of Array.isArray(parentTaskIds) ? parentTaskIds : []) {
      forgetDurableReclaimOmit(parentTaskId);
    }
  }

  /** 把可选排除集合归一成 Set（null 表示不过滤）。 */
  function omitIdSet(options) {
    const raw = options?.omitParentTaskIds;
    if (raw === null || raw === undefined) return null;
    const source = raw instanceof Set ? raw : (Array.isArray(raw) ? raw : null);
    if (source === null) return null;
    const set = new Set();
    for (const entry of source) {
      if (typeof entry === "string" && entry.length > 0) set.add(entry);
    }
    return set.size === 0 ? null : set;
  }

  /**
   * 落盘排除集合的最终裁决：显式 omitParentTaskIds ∪ 进程内回收排除集合。
   *
   * - 正常写入（manager 的关闭快照、普通状态落盘、每次显式 flush、回收的候选/最终快照）
   *   都必须继承 durableReclaimOmit：关闭快照生成于 commit 之前，只有在落盘投影里再过滤
   *   一次，才能保证"最终快照写失败"时磁盘仍然不包含已回收任务。
   * - `includeReclaimed: true` 是**内部旁路**，只给回收的补偿写入使用：候选落盘失败或
   *   commit 失败时，内存里任务仍然存在，磁盘必须被写回"含这些任务"的状态；若补偿也继承
   *   排除集合，就会把仍然在内存里的任务从磁盘删掉（新的分叉）。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>, includeReclaimed?: boolean}} [options]
   * @returns {Set<string>|null} null 表示不过滤。
   */
  function effectiveOmitSet(options) {
    const explicit = omitIdSet(options);
    if (options?.includeReclaimed === true) return explicit;
    if (durableReclaimOmit.size === 0) return explicit;
    const merged = explicit === null ? new Set() : new Set(explicit);
    for (const parentTaskId of durableReclaimOmit) merged.add(parentTaskId);
    return merged.size === 0 ? null : merged;
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
   * 该 root 的写入证据（票据 09）：live root + exact parent Agent + 绑定代际 token。
   *
   * 与 continuation 写路径复用**同一个**函数（activeBindingReplayEvidence），因此
   * 「读能力」与「写能力」不会出现两套规则。这里只按 sessionId 从 registry 解析 exact
   * Agent：同 id replacement 得到的是另一个对象，绑定证据自然失效（fail-closed）。
   */
  function liveWriteBindingFor(sessionId, parentTaskId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return false;
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
    const agent = typeof getAgent === "function" ? getAgent(sessionId) : undefined;
    if (agent === null || agent === undefined) return false;
    return activeBindingReplayEvidence(agent, parentTaskId) !== null;
  }

  /**
   * 逐动作能力项的白名单归一：只保留 { allowed, reason? }，拒绝路径必须带稳定原因码。
   *
   * manager 的能力投影是内部结构；Host 在这里再收敛一次，保证 RPC / 快照 / 客户端
   * 三处看到的是同一形状，且没有额外字段穿透到客户端。
   */
  function capabilityEntry(entry, fallbackReason = "not_supported") {
    if (entry === null || typeof entry !== "object" || typeof entry.allowed !== "boolean") {
      return { allowed: false, reason: fallbackReason };
    }
    if (entry.allowed === true) return { allowed: true };
    const reason = typeof entry.reason === "string" && entry.reason.length > 0 ? entry.reason : fallbackReason;
    return { allowed: false, reason };
  }

  function deniedCapability(reason) {
    return { allowed: false, reason };
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
        forgetDurableReclaimOmit(event?.parentTaskId);
        return false;
      }
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
    /**
     * guard/登记之前的 fan-out child 身份预检（只读转发）。
     *
     * 组合根必须在**任何副作用之前**调用它：handleAgentCreated 的 false 只表示「没有对应
     * live attempt」，不能作为身份证据。runtime 可以是测试替身（未实现该方法）——此时必须
     * 返回**结构化失败**而不是 undefined：调用方只认 `ok === true`，缺能力与「预检不通过」
     * 必须同形 fail-closed，绝不因转发返回 undefined 而被当成通过，也不因转发抛错而把正常
     * 的 created 事件打断。
     */
    precheckFanoutChildIdentity: (agent, persistedIdentity) => (
      typeof runtime.precheckFanoutChildIdentity === "function"
        ? runtime.precheckFanoutChildIdentity(agent, persistedIdentity)
        : { ok: false, reason: "fanout_precheck_unavailable" }
    ),
    handleAgentCreated: (agent, persistedIdentity) => runtime.handleAgentCreated(agent, persistedIdentity),
    handleAgentDisposed: (agent, persistedIdentity) => runtime.handleAgentDisposed(agent, persistedIdentity),
    handleSessionEvent: (session, event) => runtime.handleSessionEvent(session, event),
    /** 事件日志只读状态（保留窗口/最早序号/累计丢弃/最近恢复结果）；旧 runtime 缺能力时返回 null。 */
    eventLogStatus: () => (typeof runtime?.eventLogStatus === "function" ? runtime.eventLogStatus() : null),
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
     * 已回收任务的归属提示（只读，供 RPC 把查询/动作回执收敛为 task_not_found）。
     *
     * 只回答「哪个 root 曾拥有这个 id」，不回答任何任务状态；没有记录返回 null。
     * 它不参与授权（写动作仍要求 live 写绑定），也不进入快照/列表/事件。
     */
    reclaimedOwnerOf(parentTaskId) {
      if (closed) return null;
      return reclaimedOwnerOf(parentTaskId);
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
    /**
     * 「该 exact live root 是否仍拥有该父任务的写绑定」的只读判定（票据 09）。
     *
     * 授权条件与 continuation 写路径、ownsTask **同一套硬条件**
     * （activeBindingReplayEvidence）：活动绑定 + exact parent Agent + 绑定代际 token 仍 live。
     * 与 ownsTask 的唯一差别是**不排除终态任务**：终态任务的取消/重试/续作仍要由同一个
     * 归属证据授权（submit 任务的绑定按既有语义保留到 root 销毁/关闭）。
     *
     * 纯读：不改变状态、不注册凭据；没有证据时返回 false（fail-closed）。
     *
     * @param {object} parent - 调用方 exact root Agent。
     * @param {string} parentTaskId - fan-out 父任务 id。
     * @returns {boolean}
     */
    hasLiveWriteBinding(parent, parentTaskId) {
      if (closed) return false;
      if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") return false;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      return activeBindingReplayEvidence(parent, parentTaskId) !== null;
    },
    /**
     * 逐动作能力（票据 09）：归属判定 + manager 能力的唯一合并入口。
     *
     * 判定顺序固定：
     * 1. 归属不匹配（活动绑定与已结算索引都不指向该 root）→ 全部 not_owner；
     * 2. 归属匹配但任务不在 manager 里（含已回收）→ 全部 task_not_found；
     * 3. 归属匹配 → **读永远 allowed**（活动绑定或冷恢复的已结算任务都可读）；
     * 4. 写动作（cancel/retry/continue + shard 级）需要 live 写绑定：活动绑定、绑定的
     *    exact parent Agent 就是 registry 里这一代 root、且绑定代际 token 仍 live；
     *    否则一律 owner_not_live（冷恢复根、同 id replacement、绑定已释放都落在这里）。
     *
     * 因此读路径不会因为「可读」而获得任何写权限，冷恢复根也不会因为任务仍可读而
     * 被误认为可写。
     *
     * @param {string} sessionId - 调用方根会话 id。
     * @param {string} parentTaskId - fan-out 父任务 id。
     * @returns {object} { parentTaskId, read, cancel, retry, continue, shards }；永不抛错。
     */
    capabilitiesOf(sessionId, parentTaskId) {
      const taskId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";
      const denyAll = (reason) => ({
        parentTaskId: taskId,
        read: deniedCapability(reason),
        cancel: deniedCapability(reason),
        retry: deniedCapability(reason),
        continue: deniedCapability(reason),
        shards: {},
      });
      if (closed || taskId.length === 0) return denyAll("task_not_found");
      // 先判归属（票据 09 的固定顺序）：非归属 root 连「任务是否存在」都不进入能力判定。
      const owner = resolvedOwner(taskId);
      if (typeof owner !== "string" || owner !== sessionId) {
        // 已回收任务：把归属提示换算成 task_not_found（与票据 05/09 的查询语义一致），
        // 但仍不暴露任何任务数据；其它 root 一律 not_owner。
        if (reclaimedOwnerOf(taskId) === sessionId) return denyAll("task_not_found");
        return denyAll("not_owner");
      }
      const task = runtime.manager.getTask(taskId);
      if (task === null || task === void 0) return denyAll("task_not_found");
      // 归属匹配：读能力（含冷恢复的已结算任务）无条件成立。
      const canWrite = liveWriteBindingFor(sessionId, taskId);
      const managerCaps = typeof runtime.manager.taskCapabilities === "function"
        ? runtime.manager.taskCapabilities(taskId)
        : null;
      const shards = {};
      for (const shard of Array.isArray(task.shards) ? task.shards : []) {
        const shardId = typeof shard?.shardId === "string" && shard.shardId.length > 0 ? shard.shardId : null;
        if (shardId === null) continue;
        if (canWrite !== true) {
          shards[shardId] = {
            cancel: deniedCapability("owner_not_live"),
            retry: deniedCapability("owner_not_live"),
          };
          continue;
        }
        const source = managerCaps?.shards !== null && typeof managerCaps?.shards === "object"
          ? managerCaps.shards[shardId]
          : undefined;
        shards[shardId] = {
          cancel: capabilityEntry(source?.cancel),
          retry: capabilityEntry(source?.retry),
        };
      }
      const actionCapability = (name) => (canWrite === true
        ? capabilityEntry(managerCaps?.[name])
        : deniedCapability("owner_not_live"));
      return {
        parentTaskId: taskId,
        read: { allowed: true },
        cancel: actionCapability("cancel"),
        retry: actionCapability("retry"),
        continue: actionCapability("continue"),
        shards,
      };
    },
    getEvents: (options) => (closed
      ? { events: [], nextSequence: Number.isSafeInteger(options?.after) && options.after >= 0 ? options.after : 0 }
      : runtime.getEvents(options)),
    cancelParent: (parentTaskId) => (closed ? closedResult() : runtime.manager.cancelParent(parentTaskId)),
    cancelShard: (parentTaskId, shardId) => (closed ? closedResult() : runtime.manager.cancelShard(parentTaskId, shardId)),
    retryShard: (parentTaskId, shardId) => (closed ? closedResult() : runtime.manager.retryShard(parentTaskId, shardId)),
    /**
     * 显式回收本 root 已结算的父任务（票据 05）：两阶段 + 先落盘成功再移除。
     *
     * 职责边界：
     * 1. Host 做**归属 + 写绑定**过滤：owner 必须命中 parent.id，且必须能证明
     *    `activeBindingReplayEvidence(parent, id) !== null`（活动绑定 + exact parent Agent +
     *    绑定代际 token 仍 live，票据 09）。后一项是防御性复核：冷恢复的已结算任务与同 id
     *    replacement root 只有读权限，绝不能删除旧代际的终态任务，一律
     *    `skipped.reason="owner_not_live"`。任务能否回收仍由 manager 的统一前置条件判定
     *    （不存在/未终态/停止未确认 → 逐项 skipped，不泄露存在性）。
     * 2. Host 负责真实落盘：等待 api.persist 的**实际结果**（复用既有重试/健康/代次），
     *    只有 true 才 commit；失败或 false 一律 abortReclaim，内存状态不变。
     * 3. commit 成功后清理宿主侧全部归属索引（settled/ownershipSnapshot/读凭据/恢复记账）
     *    并释放 lineage 绑定；随后**无论是否 closed** 都再写一次"清理后的最终状态"
     *    （见第 4 点），保证磁盘与内存一致。
     * 4. 关闭竞态（票据 05 修复）：候选快照一旦**真实落盘成功**，回收在语义上已经成立。
     *    如果这次 await 期间 Host/manager 被 close，仍必须 commit——否则磁盘（候选已排除
     *    待回收任务）与内存（任务仍在）永久分叉，重启后任务“消失”。关闭后：
     *    - commit 由 manager 按 token + 屏障完成移除（不 emit / 不 notifyPersistence /
     *      不 schedule）；宿主侧归属索引清理是幂等 map 操作，照常执行；
     *    - **仍要写最终快照**：close 会收敛其它运行中的父任务，其 notifyPersistence 触发的
     *      写入快照生成于 commit 之前；生产写队列 FIFO，因此这次最终写入必然排在它之后；
     *    - 仍如实返回 accepted:true 与 reclaimed，绝不因为关闭而谎称失败。
     * 5. 进程内排除集合（票据 05 第三轮 blocking）：在候选 persist **之前**把 eligible id
     *    登记进 durableReclaimOmit，于是关闭期旧快照、普通写入与最终快照在落盘投影里都会
     *    被过滤。最终快照成功 → 撤销登记并返回 durable:true；最终快照失败 → **保留**登记
     *    （后续写入继续排除这些 id，防止关闭旧快照复活任务），返回
     *    `accepted:true, changed:true, durable:false, durabilityReason:"final_snapshot_failed"`，
     *    绝不报告耐久成功。
     * 6. commit 失败（残余的 token 失效路径）：候选已把待回收任务从磁盘排除，但内存未移除。
     *    必须用当前 manager.snapshot()（`includeReclaimed:true` 绕过排除集合，因此包含
     *    待回收任务）做一次 best-effort 写回恢复磁盘，再 abortReclaim，返回结构化失败；
     *    写回失败只 warn，不吞错。候选落盘失败的 abort 路径同理：撤销登记 + 同样的补偿写入。
     * 7. 同 id 恢复 × 最终快照（票据 05 第五轮 blocking）：最终快照**不传固定 omit**，
     *    排除只由动态集合承担；写后对账若发现同 id 任务在最终写入 await 期间重新出现
     *    （restore/task_registered），立即补写一笔最新投影并以其真实结果为准（最多两轮），
     *    因此不会出现"内存有任务、磁盘没有，却返回 durable:true"。
     *
     * 并发：manager 的屏障保证回收与 submit/cancel/retry/continue/restore 串行；
     * 宿主侧不需要第二把锁（所有写入口最终都进入 manager）。
     *
     * @param {object} parent - 调用方 exact root Agent。
     * @param {string[]} parentTaskIds - 待回收父任务 id（可含非归属/未知项，逐项跳过）。
     * @returns {Promise<object>} { accepted, reclaimed, skipped, count, ... }；永不抛错。
     */
    async reclaimTasks(parent, parentTaskIds) {
      const rejected = (code, reason, skipped = []) => ({
        accepted: false,
        changed: false,
        code,
        reason,
        reclaimed: [],
        skipped,
        count: 0,
        // 拒绝路径没有产生任何耐久变更：绝不宣称 durable。
        durable: false,
      });
      if (closed) return rejected("RUNTIME_CLOSED", "runtime_closed");
      if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") {
        return rejected("INVALID_RECLAIM_INPUT", "invalid_parent");
      }
      if (!Array.isArray(parentTaskIds)) return rejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");
      const ids = [];
      const seen = new Set();
      for (const raw of parentTaskIds) {
        const id = typeof raw === "string" ? raw.trim() : "";
        if (id.length === 0) return rejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      if (ids.length === 0) return rejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");

      // 归属过滤先于任何任务信息查询：非归属/未知 id 一律 not_owner（不泄露存在性）。
      const skipped = [];
      const owned = [];
      for (const id of ids) {
        const owner = resolvedOwner(id);
        if (typeof owner !== "string" || owner.length === 0 || owner !== parent.id) {
          skipped.push({ parentTaskId: id, reason: "not_owner" });
          continue;
        }
        /**
         * 防御性 exact live 写绑定校验（票据 09 写权限契约）：
         * 回收会**删除任务**，属于写操作，只有"live root + exact parent Agent + 绑定代际
         * token 仍 live"这一套硬条件成立时才允许。冷恢复的已结算任务（restore 时已归还
         * 归属、绑定释放）与同 id replacement root（owner 字符串相同，但绑定对象是旧代际）
         * 都只能读，这里必须跳过。
         */
        if (activeBindingReplayEvidence(parent, id) === null) {
          skipped.push({ parentTaskId: id, reason: "owner_not_live" });
          continue;
        }
        owned.push(id);
      }
      if (owned.length === 0) return rejected("NO_OWNED_TASKS", "no_owned_tasks", skipped);

      const prepared = runtime.manager.prepareReclaim(owned);
      if (prepared?.accepted !== true) {
        return rejected(
          typeof prepared?.code === "string" ? prepared.code : "RECLAIM_NOT_ACCEPTED",
          typeof prepared?.reason === "string" ? prepared.reason : "reclaim_not_accepted",
          [...skipped, ...(Array.isArray(prepared?.skipped) ? prepared.skipped : [])],
        );
      }
      const eligible = prepared.parentTaskIds;
      /**
       * 先登记排除集合，**再**发起候选落盘：候选 await 期间关闭路径可能触发一份"快照
       * 生成于 commit 之前、仍含待回收任务"的写入；只有在落盘投影里合并排除集合，那份
       * 关闭快照才不会把任务写回磁盘（这正是第三轮 blocking 的根因）。
       */
      for (const parentTaskId of eligible) rememberDurableReclaimOmit(parentTaskId);
      const persistOptions = { omitParentTaskIds: eligible };
      let written = false;
      try {
        written = (await api.persist(prepared.candidate, persistOptions)) === true;
      } catch (error) {
        // api.persist 自身不抛错；这里只是防御性收口，异常等价于落盘失败。
        warn("dsh-expert-group: fan-out reclaim persist failed: " + describeError(error));
        written = false;
      }
      if (written !== true) {
        // 落盘失败：必须回到"什么都没发生"，否则磁盘与内存会分叉。
        const aborted = runtime.manager.abortReclaim(prepared.token);
        const category = typeof runtime.manager.persistenceStatus === "function"
          ? runtime.manager.persistenceStatus()?.lastResult?.category ?? null
          : null;
        if (aborted?.accepted !== true) {
          warn("dsh-expert-group: fan-out reclaim abort failed: " + String(aborted?.reason));
        }
        // 撤销排除登记：任务仍在内存，之后的任何写入都必须重新包含它们。
        forgetDurableReclaimOmitMany(eligible);
        /**
         * 补偿写入（第三轮 blocking）：候选 await 期间关闭路径排入的旧快照，其落盘投影已被
         * 排除集合过滤——磁盘因此可能丢掉仍存在于内存的任务。这里用当前 manager.snapshot()
         * 补写一次，`includeReclaimed:true` 绕过排除集合（补偿绝不能继承排除集合）。
         * 失败只 warn：abort 已把内存恢复到原状，磁盘一致性交给后续成功写入。
         */
        try {
          const compensated = await api.persist(runtime.manager.snapshot(), { includeReclaimed: true });
          if (compensated !== true) {
            warn("dsh-expert-group: fan-out reclaim abort compensation write was not confirmed");
          }
        } catch (error) {
          warn("dsh-expert-group: fan-out reclaim abort compensation write failed: " + describeError(error));
        }
        return {
          ...rejected("RECLAIM_PERSIST_FAILED", "persist_failed", [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])]),
          ...(typeof category === "string" && category.length > 0 ? { category } : {}),
        };
      }
      /**
       * 候选快照已经真实落盘，回收从此不可回退：即使 closed 也必须 commit。
       * manager 在 closed 时仍按 token + 屏障移除任务（跳过 emit/notifyPersistence/schedule），
       * 因此这里不按 closed 提前返回，也不把结果改写成"关闭成功"之类的伪造形状。
       */
      const committed = runtime.manager.commitReclaim(prepared.token);
      if (committed?.accepted !== true) {
        /**
         * 候选已落盘但内存未能移除：磁盘此刻**已经排除**待回收任务，而内存仍持有它。
         * 若不补偿，磁盘与内存永久分叉——重启后任务“消失”，且再也无法被回收/查询。
         * 典型剩余原因只有 token 失效（屏障被并发 abort/回收覆盖），关闭本身不再是失败条件。
         *
         * 补偿顺序（票据 05 残余竞态修复）：先用当前 manager.snapshot()（**不带 omit**，
         * 因此包含待回收任务）做一次 best-effort 写回，把磁盘恢复成“候选落盘之前”的
         * 等价状态；写回失败只 warn（不伪造成功、不把结构化失败变成抛错），随后
         * abortReclaim 清屏障并返回结构化失败。
         */
        warn("dsh-expert-group: fan-out reclaim commit failed: " + String(committed?.reason));
        // 撤销排除登记：commit 未成立 → 任务仍在内存，补偿写入必须把它们写回磁盘。
        forgetDurableReclaimOmitMany(eligible);
        try {
          /**
           * `includeReclaimed:true` 是必须的：补偿快照正是"仍含待回收任务"的内存状态，
           * 如果继承排除集合，写回会把待回收任务也排除掉，制造新的磁盘/内存分叉。
           */
          const compensated = await api.persist(runtime.manager.snapshot(), { includeReclaimed: true });
          if (compensated !== true) {
            warn("dsh-expert-group: fan-out reclaim compensation write was not confirmed");
          }
        } catch (error) {
          warn("dsh-expert-group: fan-out reclaim compensation write failed: " + describeError(error));
        }
        const aborted = runtime.manager.abortReclaim(prepared.token);
        if (aborted?.accepted !== true) {
          warn("dsh-expert-group: fan-out reclaim abort after commit failure was not accepted: "
            + String(aborted?.reason));
        }
        return rejected(
          typeof committed?.code === "string" ? committed.code : "RECLAIM_COMMIT_FAILED",
          typeof committed?.reason === "string" ? committed.reason : "reclaim_commit_failed",
          [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])],
        );
      }
      const reclaimed = Array.isArray(committed.reclaimed) ? committed.reclaimed : eligible;
      for (const parentTaskId of reclaimed) {
        // 归属索引的全部出处都必须清理，否则重启后任务树/查询仍能寻址到已回收任务。
        settledParentSessions.delete(parentTaskId);
        ownershipSnapshot.delete(parentTaskId);
        restoreReadCredentials.delete(parentTaskId);
        restoredOwnership.delete(parentTaskId);
        rememberReclaimedOwner(parentTaskId, parent.id);
        try {
          lineage.releaseParentTask(parentTaskId);
        } catch (error) {
          warn("dsh-expert-group: fan-out reclaim lineage release failed: " + describeError(error));
        }
      }
      /**
       * 最终快照**必写**（票据 05，不再按 closed 跳过）。
       *
       * 关闭路径会调用 manager.close()，把仍在运行的其它父任务收敛为 cancelled，并因此
       * 触发一次 notifyPersistence → persistence.save → api.persist。那份快照生成于
       * commit **之前**；生产的写队列是 FIFO，因此这里无论是否 closed 都 await 一次最终
       * 快照：它在 FIFO 上必然排在那次关闭快照之后，磁盘最终不含已回收任务，同时保留
       * 其它任务的关闭终态（cancelled）。
       *
       * 第三轮 blocking（最终快照可能失败）：即便这次写入失败，上面的关闭快照在落盘投影里
       * 也已经被 durableReclaimOmit 过滤，因此磁盘不会复活任务。此时**必须**保留排除登记
       * （后续任何写入继续排除这些 id），并如实返回 durable:false —— 回收已经提交（内存
       * 与侧栏已移除），但"磁盘已耐久收敛"这件事没有得到确认，绝不能报告耐久成功。
       *
       * 第五轮 blocking（同 id 恢复 × 最终快照的固定 omit）：最终快照**不再传固定的
       * omitParentTaskIds**。
       *
       * commit 之后 manager 里已经没有待回收任务，正常投影天然不含它们；需要排除的 id 由
       * 进程内动态集合 durableReclaimOmit 承担（候选落盘前登记），而 restore()/task_registered
       * 会在同 id 任务重新出现的那一刻**同步**撤销该登记。若这里仍传固定的
       * omitParentTaskIds=[reclaimed]，那么"最终写入 await 期间同 id 任务被恢复/重新登记"时，
       * 落盘投影（首轮与所有重试都带同一份固定 omit）依旧会把这个真实存在于内存的任务过滤
       * 掉：内存有任务、磁盘没有，回收却返回 durable:true。
       *
       * 因此：投影只由动态集合决定（在写入那一刻已恢复的同 id 任务会正常进入快照），
       * 在写入**期间**才出现的同 id 任务由下面的写后对账补写。
       */
      const writeFinalSnapshot = async (phase) => {
        try {
          return (await api.persist(runtime.manager.snapshot())) === true;
        } catch (error) {
          warn("dsh-expert-group: fan-out reclaim " + phase + " failed: " + describeError(error));
          return false;
        }
      };
      /**
       * 某个 reclaimed id 是否仍在内存（写后恢复/重新登记的同 id 任务）。
       * 读取失败时按"仍然存在"处理：宁可如实返回 durable:false，也不谎称耐久成功。
       */
      const reclaimedIsLive = (parentTaskId) => {
        try {
          return runtime.manager.getTask(parentTaskId) !== null;
        } catch (error) {
          warn("dsh-expert-group: fan-out reclaim liveness check failed: " + describeError(error));
          return true;
        }
      };
      /** 当前仍在内存里的 reclaimed id 列表。 */
      const liveReclaimedIds = () => reclaimed.filter((parentTaskId) => reclaimedIsLive(parentTaskId));

      let durable = await writeFinalSnapshot("final snapshot");
      if (durable !== true) {
        warn("dsh-expert-group: fan-out reclaim final snapshot write was not confirmed");
      }
      /**
       * 写后对账（第五轮 blocking 的关键）：payload 在 api.persist **调用时**就完成了投影，
       * 同 id 任务若是在这笔写入的 await 期间才被 restore()/task_registered 重新登记，就不会
       * 出现在那份 payload 里——磁盘因此缺少一个内存里真实存在的任务。
       *
       * 规则：
       * - 只有最终写入成功才需要（也只有资格）对账；
       * - 每轮先记录"这一刻仍在内存里的同 id 任务"（本次投影会覆盖它们），再写一笔最新快照
       *   （**不带固定 omit**；动态集合已被 restore/task_registered 撤销）并 await 真实结果；
       * - 该笔写入成功 → 它覆盖到的 id 已确认在磁盘上；写入期间又出现的 id 进入下一轮；
       * - 该笔写入失败 → durable:false（保留动态 omit，绝不伪造成功）；
       * - 最多两轮，避免"恢复 × 写入"无限交错；两轮后仍有未被最后写入覆盖的同 id 任务时
       *   durable:false。
       */
      const RECLAIM_FINAL_RECONCILE_ROUNDS = 2;
      let pending = durable === true ? liveReclaimedIds() : [];
      let reconcileWriteFailed = false;
      for (let round = 1; round <= RECLAIM_FINAL_RECONCILE_ROUNDS && pending.length > 0; round += 1) {
        // 这些 id 此刻在内存 → 本次投影会包含它们（动态集合已撤销，显式 omit 已移除）。
        const covered = new Set(pending);
        const confirmed = await writeFinalSnapshot("final snapshot reconciliation");
        if (confirmed !== true) {
          warn("dsh-expert-group: fan-out reclaim final snapshot reconciliation write was not confirmed");
          durable = false;
          reconcileWriteFailed = true;
          break;
        }
        // 只关心"本笔写入期间才出现、因此没有被它覆盖"的同 id 任务。
        pending = liveReclaimedIds().filter((parentTaskId) => !covered.has(parentTaskId));
      }
      if (reconcileWriteFailed === false && pending.length > 0) {
        // 两轮对账后仍有未被最后写入覆盖的同 id 任务：无法确认磁盘耐久收敛。
        warn("dsh-expert-group: fan-out reclaim final snapshot reconciliation did not converge");
        durable = false;
      }
      if (durable === true) {
        for (const parentTaskId of reclaimed) {
          if (reclaimedIsLive(parentTaskId)) {
            /**
             * 写后重新存在的同 id 任务必须留在快照里：restore()/task_registered 已在任务出现
             * 的那一刻同步撤销了它的登记，这里不再"清理"它（也绝不重新登记）。
             */
            continue;
          }
          // 最终（或对账）写入已确认磁盘不含该 id：撤销登记，后续写入不再需要过滤。
          forgetDurableReclaimOmit(parentTaskId);
        }
      } else {
        // 保留排除登记：关闭期旧快照已经/即将落盘时，后续写入继续排除这些 id，防止复活。
        warn("dsh-expert-group: fan-out reclaim committed without a durable final snapshot");
      }
      return {
        accepted: true,
        changed: true,
        reclaimed: [...reclaimed],
        skipped: [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])],
        count: reclaimed.length,
        durable,
        ...(durable === true ? {} : { durabilityReason: "final_snapshot_failed" }),
      };
    },
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
       * 已回收任务：显式稳定的"任务已回收"拒绝（票据 05）。
       *
       * 回收释放了 lineage 绑定，若继续走下面的归属判定只会得到 not_owned_by_root，
       * 让调用方误以为"这是别人的任务"。归属提示命中本 root 时给出 task_reclaimed，
       * 并明确同一 requestId 重新提交会创建新任务（不保留旧任务墓碑）。
       */
      if (reclaimedOwnerOf(parentTaskId) === parent?.id) {
        return {
          accepted: false,
          changed: false,
          code: "TASK_RECLAIMED",
          reason: "task_reclaimed",
          parentTaskId,
          reclaimed: true,
        };
      }
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
    /**
     * @param {{stopEvidenceBoundary?:"unknown"|"process-restart"}} [restoreOptions] - 停止证据
     *   边界透传（票据 07）。缺省时由 manager 按快照 processInstance 自动判定：同进程重建
     *   → unknown，不同/缺失 → process-restart。Host 冷启动与 agent-created/runtime-wired
     *   恢复都走自动判定，绝不手工强制 process-restart。
     */
    restore(restoreOptions = {}) {
      if (closed) return { ...closedResult(), restored: 0, deferred: 0, pending: restorePending === true };
      if (typeof readSnapshot !== "function") return { restored: 0, deferred: 0, pending: restorePending === true };
      const snapshot = readSnapshot();
      if (snapshot === void 0 || snapshot === null || !Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) {
        return { restored: 0, deferred: 0, pending: restorePending === true };
      }
      const existingTaskIds = new Set(runtime.manager.listTasks().map((task) => task.parentTaskId));
      /**
       * 来源进程身份（票据 07）：延迟恢复的任务必须保留"它来自哪个进程"。
       *
       * 为什么：延迟任务会被合并进本进程稍后落盘的快照，顶层 processInstance 随之变成
       * 当前进程；若任务本身不携带来源身份，等 root 到达后再次 restore 就会被误判为
       * "同进程重建"，running attempt 只能停在 unknown 且无法自动续跑。缺失（旧版本
       * 快照）时用稳定的 unknown 哨兵，确保它绝不会等于当前进程身份。
       */
      const snapshotProcessInstance = typeof snapshot.processInstance === "string" && snapshot.processInstance.length > 0
        ? snapshot.processInstance
        : "proc:unknown@0";
      const restorableTasks = [];
      let deferredCount = 0;
      for (const task of snapshot.tasks) {
        if (existingTaskIds.has(task?.parentTaskId)) continue;
        const parentId = lineage.parentSessionOf(task?.parentTaskId);
        if (taskNeedsRoot(task) && (typeof parentId !== "string" || getAgent(parentId) === void 0)) {
          deferredCount += 1;
          const originProcessInstance = typeof task?.processInstance === "string" && task.processInstance.length > 0
            ? task.processInstance
            : snapshotProcessInstance;
          lineage.deferTask({
            parentTaskId: task.parentTaskId,
            parentId,
            // processInstance 是 manager 认可的恢复边界字段：延迟任务靠它保留来源进程。
            task: { ...task, processInstance: originProcessInstance },
          });
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
        const hasExplicitBoundary = restoreOptions !== null && typeof restoreOptions === "object"
          && restoreOptions.stopEvidenceBoundary !== undefined;
        runtime.manager.restore({ ...snapshot, tasks: restorableTasks }, {
          resume: true,
          merge: existingTaskIds.size > 0,
          // 显式边界只透传、不改写；缺省时交给 manager 的进程身份自动判定。
          ...(hasExplicitBoundary ? { stopEvidenceBoundary: restoreOptions.stopEvidenceBoundary } : {}),
        });
        const snapshotParents = snapshot.parentSessions !== null && typeof snapshot.parentSessions === "object"
          && !Array.isArray(snapshot.parentSessions) ? snapshot.parentSessions : {};
        for (const task of restorableTasks) {
          // 非终态任务保持 ownership：它仍可能被 RPC 查询、取消/重试、事件过滤或
          // 聚合反馈寻址，释放只能发生在真实终态或关闭路径。
          const parentTaskId = task?.parentTaskId;
          if (typeof parentTaskId !== "string") continue;
          /**
           * 同 id 复用的第二个等价入口：本进程确实从快照恢复了该任务 → 它重新存在于内存，
           * 必须立刻撤销落盘排除登记。manager.restore 不发布 task_registered，若不在这里
           * 撤销，恢复出来的真实任务会在下一次写入时被排除集合静默丢弃（磁盘丢任务）。
           */
          forgetDurableReclaimOmit(parentTaskId);
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
        const restoredCount = restorableTasks.length;
        recordRestoreOutcome({ ok: true, restored: restoredCount, deferred: deferredCount, pending: restorePending, error: null });
        // 只有成功恢复才清除 fail-closed 闸门：失败恢复后继续落盘会用当前（可能为空/
        // 不完整）的内存状态覆盖磁盘上的原快照，等于把唯一可重试的副本毁掉。
        persistenceBlocked = null;
        return { ok: true, restored: restoredCount, deferred: deferredCount, pending: restorePending };
      } catch (error) {
        const failure = describeRestoreFailure(error);
        recordRestoreOutcome({
          ok: false,
          restored: 0,
          deferred: deferredCount,
          pending: restorePending,
          error: failure,
        });
        persistenceBlocked = Object.freeze({ reason: "restore_failed", code: failure.code, at: Date.now() });
        warn("dsh-expert-group: fan-out snapshot restore failed [" + failure.code + "]: " + failure.message);
        // manager.restore 的既有契约是"非法/超预算快照原子失败且不写 eventHistory"，
        // 因此预算事件由 Host 在捕获后补发（recordBudgetViolation 只带元数据）。
        if (failure.violation !== null && typeof runtime?.manager?.recordBudgetViolation === "function") {
          try {
            runtime.manager.recordBudgetViolation(failure.violation, "restore");
          } catch (recordError) {
            warn("dsh-expert-group: fan-out restore budget event failed: " + describeError(recordError));
          }
        }
        return { ok: false, restored: 0, deferred: deferredCount, pending: restorePending, error: failure };
      } finally {
        restoring = false;
      }
    },
    /**
     * 持久化投影：合并 deferred 任务的 parentSessions，避免丢失不可寻址任务。
     *
     * @param {object} snapshot - manager 快照（回收候选可能已排除待回收任务）。
     * @param {{omitParentTaskIds?: string[]|Set<string>, includeReclaimed?: boolean}} [options]
     *   排除集合：待回收任务的 parentSessions/deferred 归属不得被合并回候选快照，否则
     *   "先落盘的候选"会重新带上已回收 id 的归属映射（重启后虽不会复活任务，但会留下脏归属）。
     *   除显式 omitParentTaskIds 外，这里**始终**合并进程内回收排除集合（effectiveOmitSet）：
     *   关闭期旧快照、普通写入与最终快照的落盘投影因此一致；只有 `includeReclaimed: true`
     *   的内部补偿写入可以绕过它。
     */
    snapshotForStorage(snapshot, options) {
      const omitted = effectiveOmitSet(options);
      const parentSessions = lineage.parentSessionsSnapshot();
      if (omitted !== null) {
        for (const key of Object.keys(parentSessions)) {
          if (omitted.has(key)) delete parentSessions[key];
        }
      }
      const tasksById = new Map();
      for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) {
        const parentTaskId = task?.parentTaskId;
        if (omitted !== null && omitted.has(parentTaskId)) continue;
        tasksById.set(parentTaskId, task);
      }
      for (const task of lineage.deferredTasks()) {
        const parentTaskId = task?.parentTaskId;
        if (omitted !== null && omitted.has(parentTaskId)) continue;
        if (!tasksById.has(parentTaskId)) tasksById.set(parentTaskId, task);
        const parentId = lineage.deferredParentOf(parentTaskId);
        if (typeof parentId === "string" && parentId.length > 0) parentSessions[parentTaskId] = parentId;
      }
      // 已终态任务的归属是**寻址索引**而非活动 ownership：lineage 已按既有语义释放
      // （或在 root 销毁时被整批摘除），但持久化必须保留它，否则重启后这些任务不再属于
      // 任何根（冷终态 fan-out 与 root 销毁后结算的任务都会从任务树消失）。
      for (const [parentTaskId, parentId] of settledParentSessions) {
        if (omitted !== null && omitted.has(parentTaskId)) continue;
        if (parentSessions[parentTaskId] === undefined) parentSessions[parentTaskId] = parentId;
      }
      return { ...snapshot, tasks: [...tasksById.values()], parentSessions };
    },
    /**
     * 落盘旁路：对同一次提交只做有界重试。
     *
     * 首次尝试使用调用方传入的 snapshot（既有 API 语义）；**每次重试（attempt > 1）都在
     * 写入前重新生成 payload**：读取当前 `runtime.manager.snapshot()`，再用
     * `api.snapshotForStorage(latest, options)` 重新投影。options 原样透传，因此当前的
     * durableReclaimOmit 与 `includeReclaimed:true` 内部旁路都照常生效。
     *
     * 为什么必须重新投影（票据 05 残余竞态：旧 transient 重试复活已回收任务）：
     * 一次**普通**快照写入 ETIMEDOUT 失败后会进入退避；退避期间回收可能已经完成并返回
     * durable:true（磁盘已不含该任务）。若重试原样重放**首轮 payload**，就会把已回收任务
     * 写回磁盘，而内存里它已被删除——重启后任务复活。重新投影保证重试写入的是**最新
     * 内存状态**：回收之后不含已回收任务；同 id 新任务登记之后包含新任务且不被旧 omit
     * 误伤；回收候选自身的重试仍靠排除集合把待回收任务挡在磁盘之外。
     *
     * generation-stale 与普通 transient 共用这一套重新投影（不再有第二套合并逻辑）。
     * 重新生成/投影失败时**绝不回退写旧 payload**（那正是复活路径）：按既有持久化失败
     * 分类记录并返回 false（fail-closed）。
     *
     * 健康记录（recordSuccess / recordFailure）一律使用**本次实际写入**的 payload.sequence。
     */
    async persist(snapshot, options) {
      if (typeof writeSnapshot !== "function") {
        recordPersistOutcome({ status: "skipped", reason: "no_writer" });
        return false;
      }
      /**
       * 恢复失败后的 fail-closed 闸门：绝不能把当前（可能为空/不完整）的内存快照写回
       * 磁盘——一次失败恢复就会覆盖磁盘上的原快照，重试也就无从读起。
       * 只有成功恢复（restore() 的成功分支）才清除 persistenceBlocked。
       */
      if (persistenceBlocked !== null) {
        recordPersistOutcome({ status: "skipped", reason: "restore_failed" });
        return false;
      }
      /**
       * payload 必须可重新赋值：重试会在**写入前**用最新内存状态重建它。
       * 首次尝试仍使用调用方传入的 snapshot，保持既有 API/测试语义。
       */
      let payload = api.snapshotForStorage(snapshot, options);
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
            recordPersistOutcome({ status: "saved", sequence: payload.sequence });
            return true;
          } catch (error) {
            const failure = persistenceHealth.recordFailure({ error, generation, sequence: payload.sequence, attempt });
            const decision = persistenceHealth.retryDecision({ category: failure.category, attempt });
            if (!decision.retry) {
              warn("dsh-expert-group: fan-out snapshot persistence failed [" + failure.category + "]: " + describeError(error));
              // 分类以 persistenceHealth 为权威；lastPersistOutcome 只做只读投影。
              recordPersistOutcome({
                status: "failed",
                reason: "save_failed",
                category: failure.category,
                sequence: payload.sequence,
              });
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
            /**
             * 重新投影：**每次重试写入前**都从当前内存状态重建 payload。
             *
             * - generation-stale 与普通 transient 走同一条路径，不再有第二套合并逻辑；
             * - 必须放在退避**之后**：回收正是在退避期间完成，提前投影会把"回收前"的
             *   状态写回磁盘，复活已回收任务；
             * - options 原样透传：snapshotForStorage 内部按**当前** durableReclaimOmit
             *   合并排除集合，`includeReclaimed:true` 的内部旁路也仍然有效。
             */
            try {
              const managerSnapshot = typeof runtime?.manager?.snapshot === "function"
                ? runtime.manager.snapshot()
                : null;
              if (managerSnapshot === null || typeof managerSnapshot !== "object" || Array.isArray(managerSnapshot)) {
                throw Object.assign(new Error("fan-out manager snapshot unavailable for persistence retry"), {
                  code: "PERSIST_RETRY_SNAPSHOT_UNAVAILABLE",
                });
              }
              payload = api.snapshotForStorage(managerSnapshot, options);
            } catch (reprojectError) {
              /**
               * fail-closed：宁可这次落盘失败，也**绝不回退写旧 payload**——旧 payload 可能
               * 仍含已回收任务，重放它正是本次要消除的复活路径。失败分类沿用
               * persistenceHealth 的既有归类，lastPersistOutcome 只做只读投影。
               */
              const reprojectFailure = persistenceHealth.recordFailure({
                error: reprojectError,
                generation: typeof getPersistenceGeneration === "function"
                  ? getPersistenceGeneration()
                  : payload?.generation,
                sequence: payload?.sequence,
                attempt,
              });
              warn("dsh-expert-group: fan-out snapshot reprojection failed ["
                + reprojectFailure.category + "]: " + describeError(reprojectError));
              recordPersistOutcome({
                status: "failed",
                reason: "reproject_failed",
                category: reprojectFailure.category,
                sequence: payload?.sequence,
              });
              return false;
            }
          }
        }
      } finally {
        persistenceHealth.endDrain(token);
      }
    },
    /**
     * 只读恢复状态：最近一次恢复结果 + fail-closed 闸门。
     *
     * 这是票据 04 要求的新只读面：侧栏/诊断不再只能从"任务为 0"猜测恢复失败，
     * 而是能拿到稳定 code、字段位置与预算违规（不含任何快照正文）。
     */
    restoreStatus: () => Object.freeze({
      blocked: persistenceBlocked === null ? null : cloneJson(persistenceBlocked),
      lastRestore: lastRestore === null ? null : cloneJson(lastRestore),
    }),
    /** 只读落盘状态：Host 层最近结果（分类权威仍在 persistenceHealth）。 */
    persistenceStatus: () => Object.freeze({
      lastResult: lastPersistOutcome === null ? null : cloneJson(lastPersistOutcome),
      blocked: persistenceBlocked === null ? null : cloneJson(persistenceBlocked),
    }),
    /**
     * 转发 manager 的预算事件补发入口（Host 恢复失败路径使用）。
     * 关闭后/旧 manager 缺少能力时返回结构化失败，绝不向上抛错。
     */
    recordBudgetViolation(violation, phase, options) {
      if (closed) return { recorded: false, reason: "runtime_closed" };
      const manager = runtime?.manager;
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
    describe: () => ({
      closed,
      restorePending: restorePending === true,
      activeAttempts: closed ? 0 : runtime.activeAttemptCount,
      tasks: closed ? 0 : runtime.manager.listTasks().length,
      // 已终态任务的归属索引（只读观测，不参与调度）：包含已释放活动 ownership 的恢复
      // 任务，以及 root 先销毁、任务后结算的任务。
      settledTasks: settledParentSessions.size,
      // 已回收任务的归属提示条数（只读诊断；不暴露任何 id 或任务数据）。
      reclaimedTasks: reclaimedTaskOwners.size,
      persistenceHealth: persistenceHealth.snapshot(),
      // Host 事件日志的保留窗口状态（与 manager 的事件历史是两份投影：前者服务 RPC
      // fanout-events，后者随快照持久化）；缺失时显式为 null。
      eventLog: typeof runtime?.eventLogStatus === "function" ? runtime.eventLogStatus() : null,
      /**
       * 持久化/恢复诊断块（票据 04）：
       * - lastResult/blocked/restore：Host 层最近一次真实结果（含失败原因码）；
       * - manager：manager 自己观察到的最近一次落盘结果（skipped 原因/实测字节）；
       * - eventHistory：manager 事件历史的丢弃计数与最早可用序号（gap 判定）。
       * 三者都只含标量/结构化元数据，不含任务负载或快照正文。
       */
      persistence: {
        lastResult: lastPersistOutcome === null ? null : cloneJson(lastPersistOutcome),
        blocked: persistenceBlocked === null ? null : cloneJson(persistenceBlocked),
        restore: lastRestore === null ? null : cloneJson(lastRestore),
        manager: typeof runtime?.manager?.persistenceStatus === "function"
          ? runtime.manager.persistenceStatus()
          : null,
        eventHistory: typeof runtime?.manager?.eventHistoryStatus === "function"
          ? runtime.manager.eventHistoryStatus()
          : null,
      },
      /**
       * 停止边界诊断块（票据 07）：
       * - stopPending / unconfirmed：已逻辑终态但停止未确认的 attempt 数；
       * - legacy：旧快照派生身份、没有停止证据的 attempt 数；
       * - boundary / boundarySource：最近一次 restore 使用的边界与来源（显式/自动）；
       * - watchdogExpired / lastWatchdog：宽限到期计数与最近一次明细；
       * - aging：Host 侧归属老化窗口（pending/aged/skipped/最近一次 aged）。
       * 全部是计数/固定枚举，不含 prompt、结果或会话正文。
       */
      stop: typeof runtime?.stopDiagnostics === "function"
        ? runtime.stopDiagnostics()
        : (typeof runtime?.manager?.stopDiagnostics === "function" ? runtime.manager.stopDiagnostics() : null),
      // 只读并发视图（有效默认值 / 各 role 与 provider 覆盖 / 解析来源）：让"设置页
      // 显示的并发上限"与实际调度值在同一处可诊断，不暴露任务负载。
      ...(typeof runtime?.manager?.concurrencyLimits === "function"
        ? { concurrencyLimits: runtime.manager.concurrencyLimits() }
        : {}),
      /**
       * 限流/排队诊断（票据 26）：按 role 与 provider 的 limit/running/queued/
       * lastThrottledAt/etaMs。数据源是 manager 的同一套 running 计数与 shard 状态，
       * Host 不复制计数器；旧 manager 缺能力时为 null（消费方必须视为不可用）。
       */
      throttle: typeof runtime?.manager?.throttleDiagnostics === "function"
        ? runtime.manager.throttleDiagnostics()
        : null,
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
      // 已回收归属提示只在进程内服务 task_not_found 语义，关闭后不再有意义。
      reclaimedTaskOwners.clear();
      /**
       * 注意：durableReclaimOmit **不**在关闭时清空。
       *
       * 关闭路径本身会触发 manager.close() 的最终持久化（收敛运行中任务）；若在关闭前就
       * 清空排除集合，那次写入会把"最终快照失败"的已回收任务重新写回磁盘，正好复原本轮
       * 修复要消除的复活路径。集合只含 id 字符串且有界，随模块实例一起被丢弃。
       */
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
    // 角色级映射（逐角色覆盖）与 provider 级映射（票据 26）同属「实时读取设置」层：
    // 只有动态解析函数才会接线，静态值继续由 runtimeOptions 表达（测试/静态部署）。
    ...(dynamicRoleLimits === undefined ? {} : { roleLimits: dynamicRoleLimits }),
    ...(dynamicProviderLimits === undefined ? {} : { providerLimits: dynamicProviderLimits }),
    // 角色级默认超时走同一优先级（票据 06）。
    ...(dynamicRoleTimeoutMs === undefined ? {} : { roleTimeoutMs: dynamicRoleTimeoutMs }),
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
    /**
     * 事件双消费入口（票据 26）。
     *
     * 顺序固定为「先账本、后父任务结算」：
     * 1. onFanoutEvent：组合根的 per-shard 等待账本。shard 进入 running 或任一终态时
     *    精确结算该 shard 的排队工作，task_settled 时兜底结算剩余工作；
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
