/**
 * fan-out 调度、预约与 attempt 生命周期（R3-13：从 fanout.js 的 manager 本体拆出）。
 *
 * ## 职责
 * - dispatchAvailable：单轮派发（role 共享池 + 任务级上限 + provider 名额 + 父任务轮转 + 冲突判定），
 *   先读单一 epoch 的计数副本、再预约、最后才调外部 launcher；
 * - drain / schedule / whenIdle：一次调用 = 一个持久化批的调度闩与微任务收敛；
 * - 限流与排队诊断（throttleStats 唯一 owner）；
 * - attempt 创建、启动、取消请求、超时/停止看门狗与停止证据诊断。
 *
 * ## 状态所有权（C5）
 * 本模块独占 throttleStats（role/provider 两张 Map）、workRequested / drainScheduled / resolveDrain /
 * drainPromise、lastStopWatchdog、lastAttributionAged、stopDiagnosticsState。
 * 这些容器与句柄不出本模块；对外的 drain 视图只有 whenIdle()/isIdle() 与 schedule()。
 *
 * ## 依赖方向
 * scheduler -> store / limits / events / persistence（单向）；与 task-commands 的互递归（启动失败要结算、
 * 结算要再派发）用一次 bindCommands 晚绑定打断，构造期不存在 ESM 环。
 *
 * @module dsh-expert-group/fanout/scheduler
 */
import {
  DEFAULT_CONCURRENCY_LIMIT,
  MAX_CONCURRENCY_LIMIT,
  MIN_CONCURRENCY_LIMIT,
  MIN_PROVIDER_LIMIT,
  MAX_PROVIDER_LIMIT,
  THROTTLE_ETA_MIN_SAMPLES,
  THROTTLE_STATS_LIMIT,
  RECLAIM_IN_PROGRESS_CODE,
  TASK_RECLAIMED_CODE,
  PROVIDER_ROUTE_CHANGED,
  MAX_RECLAIM_BATCH,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TIMEOUT_STEP_MS,
  validateTimeoutMs,
  normalizeTimeoutMs,
  MAX_SHARD_NAME_BYTES,
  validateRestoredStopFields,
  validateRestoredTimeoutMs,
} from "./contracts.js";
import {
  SHARD_TERMINAL_STATUSES,
  FANOUT_TASK_STATUSES,
  STOP_EVIDENCE_STATE_UNKNOWN,
  STOP_EVIDENCE_STATE_OBSERVED,
  STOP_EVIDENCE_SOURCES,
  HOST_STOP_EVIDENCE_SOURCES,
  STOP_GRACE_MS,
  STOP_EVIDENCE_BOUNDARIES,
  PROCESS_INSTANCE,
  SNAPSHOT_VERSION,
  TIMEOUT_PROJECTION_VERSION,
  isTerminalShardStatus,
  SHARD_STATUS_SET,
  SHARD_STATUS_KEYS,
  RETRYABLE_SHARD_STATUSES,
} from "./errors.js";
import {
  deriveAttemptId,
  isStopObserved,
  defaultTerminalReason,
  FanoutValidationError,
  budgetShardError,
  toShardError,
  normalizeLaunchError,
  cloneJson,
  normalizeText,
  normalizeIdSet,
  validateConcurrencyLimit,
  validateProviderLimit,
  normalizeProviderLimits,
  normalizeRoleLimits,
  normalizeWriteRoles,
  validateShardName,
  createWriteRoleConflictChecker,
  normalizeConflict,
  validateSubmitInput,
  validationError,
  budgetVerdict,
} from "./validation.js";
import { providerOfAttempt } from "./provider-attribution.js";
import { ROUTE_SNAPSHOT_INVALID } from "../shared/route-snapshot.js";
import {
  FANOUT_BUDGET,
  checkAttemptPayloadBudget,
  checkBudget,
  checkRestoreBudget,
  createEventHistoryAccounting,
  describeBudgetViolation,
  measureJsonBytes,
} from "../resource-budget.js";


/**
 * 调度器的模块级实现（每个函数显式接收 (s, deps)：s 是本模块独占的调度状态切片，
 * deps 是构造期注入的协作面与晚绑定端口）。实现全部在模块作用域，工厂只创建 s/deps 并绑定。
 */
const budgetPolicy = FANOUT_BUDGET;

function bindCommands(s, deps, commands) { deps.bound = commands; }

function noteRestoreBoundary(s, deps, boundary, boundarySource) {
  s.stopDiagnosticsState.boundary = boundary;
  s.stopDiagnosticsState.boundarySource = boundarySource;
}

function clearPendingWork(s, deps) { s.workRequested = false; }

function throttleStatsFor(s, deps, kind, key) {
  const map = s.throttleStats[kind];
  let entry = map.get(key);
  if (entry !== undefined) return entry;
  entry = { lastThrottledAt: undefined, episodeStartedAt: undefined, samples: 0, totalWaitMs: 0 };
  map.set(key, entry);
  while (map.size > THROTTLE_STATS_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === key) break;
    map.delete(oldest);
  }
  return entry;
}

function noteThrottled(s, deps, kind, key) {
  const at = deps.now();
  const entry = throttleStatsFor(s, deps, kind, key);
  entry.lastThrottledAt = at;
  if (entry.episodeStartedAt === undefined) entry.episodeStartedAt = at;
}

function noteDispatchReleased(s, deps, kind, key) {
  const entry = s.throttleStats[kind]?.get(key);
  if (entry === undefined || entry.episodeStartedAt === undefined) return;
  entry.samples += 1;
  entry.totalWaitMs += Math.max(0, deps.now() - entry.episodeStartedAt);
  entry.episodeStartedAt = undefined;
}

function throttleDiagnostics(s, deps) {
  const roles = deps.limits.resolveRoleLimits();
  const providers = deps.limits.resolveProviderLimits();
  const defaultLimit = deps.limits.resolveDefaultConcurrencyLimit();
  const queuedByRole = new Map();
  const queuedByProvider = new Map();
  const roleKeys = new Set([...deps.store.roleKeys(), ...Object.keys(roles)]);
  /**
   * provider 行必须覆盖三类键（票据 05）：
   * - 设置里配置了上限的 provider；
   * - 当前**持有名额**的 provider（跨边界任务的归属可能不在 task.provider 上）；
   * - 当前有排队分片的 provider（按各自 attempt 的归属归桶）。
   */
  const providerKeys = new Set([...Object.keys(providers), ...deps.store.countsByProvider().keys()]);
  // 任务数与分片数都有预算上界（resource-budget），因此这里是常数级聚合。
  for (const task of deps.store.allTasks()) {
    for (const shard of task.shards) {
      if (shard.status !== "queued") continue;
      queuedByRole.set(task.role, (queuedByRole.get(task.role) ?? 0) + 1);
      // 排队分片按它当前这次执行的归属归桶：使用统一推导入口，不在诊断里另算一套。
      const provider = providerOfAttempt(task, shard.attempts[shard.attempts.length - 1]);
      if (provider === null) continue;
      providerKeys.add(provider);
      queuedByProvider.set(provider, (queuedByProvider.get(provider) ?? 0) + 1);
    }
  }
  const roleRows = {};
  for (const role of roleKeys) {
    roleRows[role] = throttleRow(s, deps, "role", role, {
      limit: typeof roles[role] === "number" ? roles[role] : defaultLimit,
      running: deps.store.roleRunCount(role) ?? 0,
      queued: queuedByRole.get(role) ?? 0,
    });
  }
  const providerRows = {};
  for (const provider of providerKeys) {
    providerRows[provider] = throttleRow(s, deps, "provider", provider, {
      // provider 限流用 0 表示「不限制」：诊断如实投影 0，而不是省略或改写成默认值。
      limit: typeof providers[provider] === "number" ? providers[provider] : 0,
      running: deps.store.providerRunCount(provider) ?? 0,
      queued: queuedByProvider.get(provider) ?? 0,
    });
  }
  return Object.freeze({
    roles: Object.freeze(roleRows),
    providers: Object.freeze(providerRows),
    etaMinSamples: THROTTLE_ETA_MIN_SAMPLES,
  });
}

function throttleRow(s, deps, kind, key, { limit, running, queued }) {
  const entry = s.throttleStats[kind].get(key);
  const samples = entry?.samples ?? 0;
  const hasEta = samples >= THROTTLE_ETA_MIN_SAMPLES;
  return Object.freeze({
    limit,
    running,
    queued,
    lastThrottledAt: entry?.lastThrottledAt === undefined ? null : entry.lastThrottledAt,
    etaMs: hasEta ? Math.round(entry.totalWaitMs / samples) : null,
    etaSource: hasEta ? "historical-average" : "unknown",
    samples,
  });
}

function dispatchAvailable(s, deps) {
  if (deps.gate.closed || deps.gate.restoreDispatchSuppressed) return false;
  // 回收屏障期间暂停**派发**（不暂停既有 child 的 completion/超时收敛）：
  // 候选快照落盘窗口里不应再启动新的 child，否则候选与 commit 时的任务集合可能发散。
  if (deps.reclaim.current !== null) return false;
  const roleActiveCounts = deps.store.activeCountsByRole();
  const taskActiveCounts = deps.store.activeCountsByTask();
  /**
   * provider 份额的权威计数只在 setShardStatus 处更新，而判定点已经随票据 05 下移到
   * startShard（必须在快照冻结之后才知道归属），因此这里不再保留"本轮副本"：
   * startShard 直接读权威计数，天然包含同一轮里刚派发的分片。
   */
  // parentsByRole 保持首次注册 role 的顺序，避免每轮遍历整个 tasks 表。
  const roles = [...deps.store.roleKeys()];

  let dispatched = false;
  for (const role of roles) {
    // 本轮使用索引快照，避免 running 事件重入 submit 改变本轮公平序列。
    const parents = [...(deps.store.parentsForRole(role) ?? [])];
    if (parents.length === 0) continue;
    let cursor = deps.store.rotationCursor(role) ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= parents.length) cursor = 0;
    // 本 role 共享池当前已占用的槽位；每派发一个 shard 就 +1，直到达到池上限。
    let used = roleActiveCounts.get(role) ?? 0;
    // provider 级上限同样在一轮开始时解析一次：它是设置级配置，对同 role 下所有
    // 任务都相同；设置保存后下一轮 drain 立即读到新值（不做任何缓存）。
    const resolvedProviderLimits = deps.limits.resolveProviderLimits();
    /**
     * role 池已满的快速短路：本 role 本轮没有任何可派发的候选，直接进入下一个 role。
     *
     * 与「先 provider 后 role」不矛盾：role 名额是候选派发的最后一道闸门，池子已满时
     * 任何候选都不可能通过，因此跳过 provider 判定不改变任何派发决策，也不会占用或
     * 预留任何名额；它只是避免空转，并保留父任务轮转游标不被无意义推进。
     *
     * 必须放在轮转循环之前而不是只放在循环内：否则每次 drain 都会先把游标推进一格
     * 才因为池满 break，多轮 drain 累积下来就破坏了父任务轮转公平性（大型任务会
     * 抢占后来者的槽位）。这里只记录一次 role 限流事实，不推进游标。
     */
    if (used >= deps.limits.rolePoolLimitFor(parents[0])) {
      noteThrottled(s, deps, "role", role);
      continue;
    }
    // 轮转预算：一圈内每个父任务最多贡献一个 shard，保证公平性；
    // 若一圈后仍有空槽位（例如某个父任务已无排队 shard），允许再走一圈补齐，
    // 这样并发上限才真正被填满，而不是每轮只启动一个。
    let budget = parents.length;
    // 连续遇到「本轮无法产出」的父任务计数。只有轮转一整圈都没有任何产出才停止：
    // 某个父任务被**自身任务级上限**或 **provider 名额**卡住时仍有其它父任务可以派发，
    // 因此它只能算"本轮无产出"，不能直接终止整个 role 的派发（否则高上限的任务会被
    // 低上限的邻居饿死）。无排队 shard / 冲突判定失败同样属于"本轮无产出"。
    let blockedInARow = 0;
    while (budget > 0) {
      const task = parents[cursor % parents.length];
      cursor = (cursor + 1) % parents.length;
      budget -= 1;
      /**
       * provider 名额判定（票据 05）已下移到 startShard：归属键来自该次执行的派发快照，
       * 只有在 prepareAttempt 成功冻结之后才存在。因此本处只做 role / 任务级两道闸门，
       * 名额仍只在分片真正进入 running 时才占用——排队不占名额、不做预留。
       *
       * 判定失败（provider 满）时 startShard 返回 false，本循环按"本轮无产出"处理：
       * 绝不启动 child、绝不占 role 名额，也不把限流原因记到 role 名下。
       */
      // role 共享池上限只看 role 级设置/默认值，不读任何任务的 concurrencyLimit，
      // 因此同一 role 下所有父任务解析出的池上限必然相同（循环内重复求值成本极低）。
      // 池子满时整个 role 都不可能再派发：直接结束本 role，避免空转一圈。
      if (used >= deps.limits.rolePoolLimitFor(task)) {
        noteThrottled(s, deps, "role", role);
        break;
      }
      // 任务级上限只与**该父任务自身**的 running 数比较：其它父任务占用 role 槽位
      // 不再影响它（旧实现拿 role 全局计数比较，导致低上限任务被别的任务饿死）。
      const taskLimit = deps.limits.taskLimitFor(task);
      if (taskLimit !== undefined && (taskActiveCounts.get(task) ?? 0) >= taskLimit) {
        blockedInARow += 1;
        if (blockedInARow >= parents.length) break;
        continue;
      }
      const shard = task.shards.find((entry) => entry.status === "queued" && (
        entry.cancelRequested !== true
        || entry.attempts[entry.attempts.length - 1]?.attempt > 1
      ));
      if (shard === undefined) {
        // 该父任务已无排队 shard：本轮没有产出，但它的存在不应顺手终结整个 role。
        blockedInARow += 1;
        if (blockedInARow >= parents.length) break;
        continue;
      }
      // retryShard 会重新进入队列；重新 admission 前复用同一 conflictChecker，
      // 只阻止当前候选与其它活动 shard 的明显冲突，不引入路径解析语义。
      const otherShards = deps.store.collectConflictCandidates(task.role, shard, shard);
      const conflict = deps.store.findConflict(task.role, shard, otherShards);
      if (conflict !== null && !task.allowOverlap) {
        blockedInARow += 1;
        if (blockedInARow >= parents.length) break;
        continue;
      }
      // 本轮的 provider 上限映射随派发下传：startShard 在每个候选的实际归属上判定名额，
      // 因此同一 drain 里不同 provider 的连续派发各自读权威计数，不会超发也不会串账。
      if (startShard(s, deps, task, shard, resolvedProviderLimits)) {
        dispatched = true;
        used += 1;
        // 任务级计数必须在本轮内同步自增：入口快照只是基线（避免 running 事件
        // 重入改变公平序列），但本轮刚派发的 shard 若不立即计入本地计数，同一
        // 次 drain 的内层循环（budget 重置允许连续派发同一任务）会读到过期值，
        // 使任务越过自身任务级上限——快照要等下一次 dispatchAvailable 才刷新。
        taskActiveCounts.set(task, (taskActiveCounts.get(task) ?? 0) + 1);
        noteDispatchReleased(s, deps, "role", role);
        blockedInARow = 0;
        if (deps.gate.closed) break;
        // role 共享池在派发过程中可能刚好被填满（例如另一路径同步派发），逐次复核；
        // 一旦填满就停止本 role 的派发，保证 role 全局 running 不越过池上限。
        if (used >= deps.limits.rolePoolLimitFor(task)) break;
        // 有新 shard 进入 running 后，重新评估其它父任务的排队情况。
        budget = parents.length;
      }
    }
    deps.store.setRotationCursor(role, cursor % parents.length);
  }
  return dispatched;
}

function drainBatch(s, deps) {
  deps.persistence.withPersistenceBatch(drain.bind(null, s, deps));
}

function drain(s, deps) {
  try {
    // 派发可能同步完成一个 shard，从而释放槽位并产生新的可派发 shard，
    // 因此循环直到没有新的派发发生为止。
    while (dispatchAvailable(s, deps)) {
      // 循环体为空：runDispatchCycle 内部完成状态推进。
    }
  } finally {
    // 关键：只要 drain 期间又产生了新的调度请求，就再排一次微任务继续派发，并且不
    // resolve s.drainPromise。whenIdle(s, deps) 因此一定等到稳定态，不会让调用方看到中间态。
    if (s.workRequested) {
      s.workRequested = false;
      queueMicrotask(() => drainBatch(s, deps));
    } else {
      s.drainScheduled = false;
      const resolve = s.resolveDrain;
      s.resolveDrain = undefined;
      if (resolve !== undefined) resolve();
    }
  }
}

function schedule(s, deps) {
  if (deps.gate.closed) return Promise.resolve();
  deps.gate.resumeDispatch();
  s.workRequested = true;
  if (!s.drainScheduled) {
    s.drainScheduled = true;
    // 进入 drain 前先清掉请求标记；drain 期间再次 schedule(s, deps) 会重新置位，
    // 由 finally 决定是否再排一轮。
    s.workRequested = false;
    s.drainPromise = new Promise((resolve) => { s.resolveDrain = resolve; });
    queueMicrotask(() => drainBatch(s, deps));
  }
  return s.drainPromise;
}

function createAttempt(s, deps, task, shard, attemptNumber, extra = {}) {
  const timeoutMs = deps.limits.resolveAttemptTimeoutMs(task.timeoutMs, shard.timeoutMs);
  return {
    attempt: attemptNumber,
    status: "queued",
    /**
     * attempt 身份（票据 07）：attemptId 跨重启稳定，executionGeneration 单调递增。
     *
     * 二者共同构成停止证据的寻址键：Host 只能提交"父任务 + 分片 + attempt 序号 +
     * attemptId + executionGeneration"全部精确匹配的证据；任一不匹配就是 stale，
     * 不产生任何状态变更。只有 attemptId 是不够的——同一个 attemptId 的旧执行代次
     * 迟到回调仍可能携带旧代次，代次负责把这类迟到隔离在门外。
     */
    attemptId: deriveAttemptId(task.parentTaskId, shard.shardId, attemptNumber),
    executionGeneration: deps.store.allocateGeneration(),
    // 默认 unknown：管理器不因为"自己发了取消"就假定执行已停止。
    stopEvidence: { state: STOP_EVIDENCE_STATE_UNKNOWN },
    startedAt: undefined,
    finishedAt: undefined,
    affectedPaths: [...shard.affectedPaths],
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...extra,
  };
}

function attemptBudgetVerdict(s, deps, shard, field, hint) {
  const attempts = shard.attempts.length;
  const limit = budgetPolicy.maxAttemptsPerShard;
  const violation = budgetVerdict("attempts", limit, attempts + 1, field, hint);
  if (violation === null) return null;
  return { reason: "attempt_budget_exceeded", attempts, limit, violation: violation.violation };
}

function updateShardStatus(s, deps, task, shard, status) {
  deps.store.setShardStatus(task, shard, status);
  shard.updatedAt = deps.now();
  task.updatedAt = shard.updatedAt;
}

function previousMessageIdsFor(s, deps, shard) {
  const ids = [];
  for (let index = 0; index < shard.attempts.length - 1; index += 1) {
    const messageId = shard.attempts[index]?.messageId;
    if (typeof messageId === "string" && messageId.length > 0) ids.push(messageId);
  }
  return ids;
}

function clearAttemptStopTimer(s, deps, attempt) {
  if (attempt?.stopTimer === undefined) return;
  deps.clearTimeoutFn(attempt.stopTimer);
  attempt.stopTimer = undefined;
}

function normalizeStopEvidence(s, deps, raw, { allowedSources = STOP_EVIDENCE_SOURCES, nowMs } = {}) {
  const invalid = (message) => ({
    ok: false,
    code: "STOP_EVIDENCE_INVALID",
    reason: "stop_evidence_invalid",
    message,
  });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("停止证据必须是对象");
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (source.length === 0) return invalid("停止证据必须给出 source");
  if (!allowedSources.includes(source)) return invalid("不接受的停止证据来源: " + source);
  const observedAt = typeof raw.observedAt === "number" && Number.isFinite(raw.observedAt) && raw.observedAt >= 0
    ? raw.observedAt
    : (nowMs ?? deps.now());
  const evidence = { state: STOP_EVIDENCE_STATE_OBSERVED, source, observedAt };
  for (const field of ["childId", "messageId", "sessionId"]) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim().length === 0) return invalid("停止证据字段 " + field + " 必须是非空字符串");
    evidence[field] = value.trim();
  }
  if (raw.turn !== undefined && raw.turn !== null) {
    if (!Number.isSafeInteger(raw.turn) || raw.turn < 0) return invalid("停止证据字段 turn 必须是非负整数");
    evidence.turn = raw.turn;
  }
  return { ok: true, evidence };
}

function applyStopEvidence(s, deps, task, shard, attempt, evidence, { emitEvent = true } = {}) {
  if (isStopObserved(attempt)) return false;
  attempt.stopEvidence = { ...evidence, state: STOP_EVIDENCE_STATE_OBSERVED };
  clearAttemptStopTimer(s, deps, attempt);
  deps.store.syncAttemptScope(task, shard, attempt);
  if (emitEvent && !deps.gate.restoringSnapshot) {
    deps.events.emit({
      type: "attempt_stop_observed",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      role: task.role,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      status: attempt.status,
      source: attempt.stopEvidence.source,
      released: isTerminalShardStatus(attempt.status),
    });
  }
  return true;
}

function markStopRequested(s, deps, task, shard, attempt, { watch = true } = {}) {
  if (isStopObserved(attempt)) return;
  if (typeof attempt.stopRequestedAt !== "number") attempt.stopRequestedAt = deps.now();
  attempt.stopDeadlineAt = attempt.stopRequestedAt + deps.stopGraceMs;
  if (!watch) return;
  if (attempt.stopWatchdogExpiredAt !== undefined) return;
  if (attempt.stopTimer !== undefined) return;
  // 定时器回调是独立异步 tick，自成一个持久化批（诊断事件只序列化一次）。
  attempt.stopTimer = deps.setTimeoutFn(
    () => deps.persistence.withPersistenceBatch(() => expireStopWatchdog(s, deps, task, shard, attempt)),
    deps.stopGraceMs,
  );
  // unref：停止宽限只是诊断/看门狗，不是业务 deadline；生产进程不该被它钉住，测试进程
  // 也不该为每个未确认 attempt 多等 15 秒才退出。进程仍活跃时定时器照常触发。
  attempt.stopTimer?.unref?.();
}

function expireStopWatchdog(s, deps, task, shard, attempt) {
  attempt.stopTimer = undefined;
  if (isStopObserved(attempt)) return;
  if (attempt.stopWatchdogExpiredAt !== undefined) return;
  attempt.stopWatchdogExpiredAt = deps.now();
  // 原因码区分超时与取消：两者的人工处置不同（超时通常重试，取消通常放弃）。
  const reason = attempt.terminalReason === "timeout" ? "timeout" : "cancel";
  s.lastStopWatchdog = {
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    reason,
    at: attempt.stopWatchdogExpiredAt,
  };
  deps.events.emit({
    type: "attempt_stop_unconfirmed",
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    role: task.role,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    status: attempt.status,
    terminalReason: attempt.terminalReason,
    reason,
    stopRequestedAt: attempt.stopRequestedAt,
    stopDeadlineAt: attempt.stopDeadlineAt,
    stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt,
  });
  deps.persistence.notifyPersistence();
}

function unconfirmedStopAttempts(s, deps, shard) {
  return shard.attempts.filter((attempt) => !isStopObserved(attempt));
}

function unconfirmedStopSummary(s, deps, attempt) {
  return {
    attempt: attempt.attempt,
    status: attempt.status,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    stopRequestedAt: attempt.stopRequestedAt ?? null,
    stopDeadlineAt: attempt.stopDeadlineAt ?? null,
    stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt ?? null,
    terminalReason: attempt.terminalReason ?? null,
    legacy: attempt.legacy === true,
  };
}

function stopGateVerdict(s, deps, shard) {
  const unconfirmed = unconfirmedStopAttempts(s, deps, shard);
  if (unconfirmed.length === 0) return null;
  return {
    reason: "stop_unconfirmed",
    shardId: shard.shardId,
    attempts: unconfirmed.map((arg0) => unconfirmedStopSummary(s, deps, arg0)),
  };
}

function requestShardCancellation(s, deps, task, shard, attempt, reason) {
  if (deps.canceller === undefined || deps.canceller === null) return;
  try {
    const outcome = deps.canceller({
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
      reason,
      handle: attempt.handle,
    });
    if (outcome !== null && typeof outcome === "object" && typeof outcome.catch === "function") {
      outcome.catch(() => {});
    }
  } catch {
    // 取消器异常不能阻断取消状态机：状态仍由 completion/超时收敛。
  }
}

/**
 * 派发前准备失败的受控收敛（票据 03）：queued → failed，且**从未**进入 running。
 *
 * 只复用既有唯一状态机入口 settleShard（事件/聚合/落盘通知/调度重排都不复制），额外做两件事：
 * 1. 传 allowQueuedFailure：这是 queued→failed 的唯一受控来源；
 * 2. 带 admission_not_created 证据：没有证据时终态 attempt 的影响范围会永远占位。
 * 稳定 code 来自冻结入口（峰谷 invalidCode / ROUTE_SNAPSHOT_INVALID），错误体是**普通对象**
 * （不是 Error 实例）：normalizeLaunchError 只对普通对象保留自定义 code。
 */
function failPreparedDispatch(s, deps, task, shard, attempt, detail) {
  const code = typeof detail?.code === "string" && detail.code.length > 0 ? detail.code : "DISPATCH_PREPARE_FAILED";
  deps.bound.settleShard(task, shard, attempt, "failed", {
    error: {
      name: "FanoutDispatchPrepareError",
      code,
      reason: "dispatch_prepare_failed",
      message: "fan-out 派发前路由冻结失败（" + code + "），已拒绝启动 child",
      retryable: false,
    },
    evidence: deps.bound.admissionEvidence(attempt),
    reason: "dispatch_prepare_failed",
    allowQueuedFailure: true,
  });
}

/**
 * 启动一个排队分片（票据 03 冻结 → 票据 05 名额判定 → 置 running → 调 launcher）。
 *
 * @param {object} task - 父任务。
 * @param {object} shard - 排队分片。
 * @param {Readonly<Record<string, number>>} [roundProviderLimits] - 本轮已解析的
 *   provider -> limit 映射；缺省时现场解析一次（兼容测试/旧调用方）。
 * @returns {boolean} true 表示本次真正进入 running（可能已同步结算）；false 表示没有派发
 *   （准备失败或 provider 名额已满，状态与计数按各自语义保持不变）。
 */
function startShard(s, deps, task, shard, roundProviderLimits) {
  const attempt = shard.attempts[shard.attempts.length - 1];
  if (attempt === undefined || attempt.status !== "queued") return false;
  // 多轮 continuation：本轮 attempt 复用上一轮的 child，必须走 deps.continuer（把新 prompt
  // 投递给同一 child），不能重新走 deps.launcher 新建 child。
  const isContinuation = attempt.continuation === true;
  const launch = isContinuation ? deps.continuer : deps.launcher;
  /**
   * 派发期路由决定（票据 03 冻结 / 票据 04 复用）：**必须在 attempt 进入 running 之前**
   * 同步完成。
   *
   * 为什么顺序不能交换：一旦先置 running 再选路，设置就在这个窗口里被改写、或时钟跨过
   * 峰谷边界，同一次执行会用上另一套配置；而且失败时已经「计数 + 发过 running 事件」，
   * 只能在 running 之后收敛，计数与事件轨迹都会失真。
   *
   * 复用优先级由 host/fanout-dispatch-route.js 决定（恢复回来的 attempt 自身快照 → 同
   * shard 上一轮快照 → 新派发时刻冻结）；本处只负责把结果写进 attempt.route。因此恢复
   * 与续作**不会**按当前设置或当前时钟重选：它们在第一、二层就短路了。
   *
   * 三种返回：
   * - null：本次没有路由决定（峰谷未启用 / 两层都没配该角色 / 续作且上一轮也没有快照）
   *   → 逐字保持旧路径；
   * - {ok:false}：配置非法或复用的快照非法 → 该 attempt 直接 queued→failed，不置
   *   running、不计数、不发 running 事件，也不调用 launcher（fail-closed，绝不回退重建）；
   * - {ok:true}：把纯数据快照写进 attempt.route，随后 running 路径的 notifyPersistence
   *   会把它一并落盘（不额外通知，避免一次派发两次持久化批）。
   */
  let frozenRoute = null;
  if (typeof deps.prepareAttempt === "function") {
    let prepared;
    try {
      prepared = deps.prepareAttempt({ task, shard, attempt, round: task.round, continuation: isContinuation });
    } catch (error) {
      // 冻结入口自身抛错（例如读设置失败）：同样按受控失败收敛，绝不把异常抛回调度循环。
      prepared = { ok: false, code: error?.code, reason: error?.reason };
    }
    if (prepared !== null && prepared !== undefined) {
      if (prepared.ok !== true) {
        failPreparedDispatch(s, deps, task, shard, attempt, prepared);
        // 没有派发成功：dispatchAvailable 不得为本分片累加 role/provider 名额。
        return false;
      }
      frozenRoute = prepared;
      attempt.route = prepared.snapshot;
    }
  }
  /**
   * provider 名额判定（票据 05）：**必须在快照冻结之后、置 running 之前**。
   *
   * 归属键来自这次执行的快照（providerOfAttempt），所以跨峰谷边界的相邻分片各自占用
   * 自己 provider 的名额；父任务的单一 provider 只在没有快照时作为旧路径兼容值。
   *
   * 两种不派发的结果：
   * - 快照存在却无法归属（非法 / 活动候选缺 provider）→ 走准备失败路径：queued→failed，
   *   不置 running、不计数、不调 launcher（fail-closed，绝不回退 task.provider）；
   * - provider 名额已满 → 保留刚冻结的 attempt.route、**保持 queued**、不计数、不调
   *   launcher。下一轮 drain 的 prepare 在第一层直接复用该快照，不会重读时钟或设置。
   */
  const provider = providerOfAttempt(task, attempt);
  if (attempt.route !== undefined && provider === null) {
    failPreparedDispatch(s, deps, task, shard, attempt, { code: ROUTE_SNAPSHOT_INVALID });
    return false;
  }
  const providerLimit = deps.limits.providerLimitOf(
    task,
    roundProviderLimits === undefined ? deps.limits.resolveProviderLimits() : roundProviderLimits,
    provider,
  );
  if (providerLimit !== undefined && (deps.store.providerRunCount(provider) ?? 0) >= providerLimit) {
    noteThrottled(s, deps, "provider", provider);
    return false;
  }
  attempt.status = "running";
  attempt.startedAt = deps.now();
  deps.store.setShardStatus(task, shard, "running", attempt);
  // 真正派发成功 = 该 provider 的限流窗口结束，采样一次等待时长（诊断用）。
  if (providerLimit !== undefined) noteDispatchReleased(s, deps, "provider", provider);
  shard.updatedAt = attempt.startedAt;
  task.updatedAt = attempt.startedAt;
  deps.events.emitShardStatus(task, shard, "running", attempt.attempt, {
    ...(isContinuation ? { continuation: true } : {}),
    ...(task.round === undefined ? {} : { round: task.round }),
  });
  deps.persistence.notifyPersistence();
  // 订阅者可能在 running 事件中重入 close；此时不能再把本次 admission 交给 deps.launcher。
  if (deps.gate.closed || isTerminalShardStatus(attempt.status)) return true;

  const launchInput = {
    parentTaskId: task.parentTaskId,
    role: task.role,
    basePrompt: task.basePrompt,
    shardId: shard.shardId,
    // 名称随派发输入传给 Host：子代理任务标签与提示词都能显示"分片代号 + 任务名称"，
    // 缺失时不出现该字段，保持旧 Host 的输入形状。
    ...(shard.name === undefined ? {} : { name: shard.name }),
    prompt: shard.prompt,
    ...(attempt.affectedPaths.length === 0 ? {} : { affectedPaths: [...attempt.affectedPaths] }),
    ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
    attempt: attempt.attempt,
    // 逻辑轮次随派发输入传给 Host：续作正文用它标注「这是同一分片的第几轮」。
    ...(Number.isSafeInteger(task.round) && task.round >= 1 ? { round: task.round } : {}),
    // 续作必须带上原 childId：manager 只声明「复用哪个 child」，真正的投递由 deps.continuer 完成。
    ...(isContinuation && typeof attempt.childId === "string" && attempt.childId.length > 0
      ? { childId: attempt.childId }
      : {}),
    /**
     * 续作还要带上该 shard 之前各轮的 messageId：Host 用它们判定本轮 messageId 是否
     * 「新」——缺失、与本 child 旧轮重复都必须在启动阶段 fail-closed，否则一个重复的
     * messageId 会让旧轮 turn/end 直接结算新一轮（提前 task_settled / goal release）。
     */
    ...(isContinuation ? { previousMessageIds: previousMessageIdsFor(s, deps, shard) } : {}),
    /**
     * 派发期冻结的完整路由快照（票据 03）：buildRequest 看到它时**不再重新选路**，
     * 也不再跑 provider 一致性校验（逐 shard 的 provider 差异属票据 05）。
     * selection 只是同一决定的即时读面（排障/日志），权威仍是快照本身。
     */
    ...(frozenRoute === null
      ? {}
      : { precomputedRoute: frozenRoute.snapshot, selection: frozenRoute.selection }),
  };

  // 0 = 显式禁用超时（票据 06）：只有真正启用的正数才挂定时器。
  // 计时起点是 attempt 进入 running（上面已写入 startedAt），而不是队列等待时间。
  if (typeof attempt.timeoutMs === "number" && attempt.timeoutMs > 0) {
    // 超时通过注入时钟触发取消并标记 timed_out；若在此之前已经终态，
    // settleShard 会因幂等直接忽略这次超时。
    // 定时器回调是独立的异步 tick，自成一个持久化批（取消请求 + 终态写入只序列化一次）。
    attempt.timer = deps.setTimeoutFn(() => deps.persistence.withPersistenceBatch(() => {
      attempt.timer = undefined;
      requestShardCancellation(s, deps, task, shard, attempt, "timeout");
      deps.bound.settleShard(task, shard, attempt, "timed_out", {
        error: toShardError({ name: "ShardTimeoutError", reason: "timeout", timeoutMs: attempt.timeoutMs }, "shard 超时"),
        // 超时只落逻辑终态并请求停止：stopEvidence 保持 unknown，等 Host 的权威证据。
        reason: "timeout",
      });
    }), attempt.timeoutMs);
    // 超时定时器同样只是运行期看门狗：unref 避免测试/宿主进程被单个长超时钉住。
    attempt.timer?.unref?.();
  }

  let launched;
  try {
    // continuation 尝试但 runtime 未接线 deps.continuer 时 fail-closed 为启动失败：绝不静默
    // 换 child 顶替复用。attempt 此时已是 running，因此走既有启动失败通道收敛为 failed
    // （历史一致、shard 不会停留在 queued 造成重复派发）。
    if (typeof launch !== "function") {
      throw new Error("fan-out continuation 未接线 deps.continuer，拒绝复用既有 child: " + shard.shardId);
    }
    launched = launch(launchInput);
  } catch (error) {
    deps.bound.launchFailure(task, shard, attempt, error);
    return true;
  }
  if (launched !== null && typeof launched === "object" && typeof launched.then === "function") {
    // 异步 admission 的每个回调都是独立的异步 tick，各自成批：admission 落地带来的
    // 状态变化（句柄登记 / 启动失败终态）在该批内只序列化一次。
    launched.then(
      (value) => { deps.persistence.withPersistenceBatch(() => consumeLaunchResult(s, deps, task, shard, attempt, value)); },
      (error) => { deps.persistence.withPersistenceBatch(() => deps.bound.launchFailure(task, shard, attempt, error)); },
    );
  } else {
    consumeLaunchResult(s, deps, task, shard, attempt, launched);
  }
  return true;
}

function consumeLaunchResult(s, deps, task, shard, attempt, value) {
  // 回收后才落地的 admission：只丢弃，不登记 childId、不写快照、不订阅 completion。
  if (task?.reclaimed === true) return;
  const handle = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (typeof handle.childId === "string") attempt.childId = handle.childId;
  if (typeof handle.messageId === "string") attempt.messageId = handle.messageId;
  attempt.handle = handle;
  deps.persistence.notifyPersistence();
  // close 可能在 deps.launcher admission 等待期间完成；晚到的 child 仍要收到一次取消请求，
  // 但不能把已经写入的 cancelled 终态重新变成 running。
  if (deps.gate.closed || isTerminalShardStatus(attempt.status)) {
    requestShardCancellation(s, deps, task, shard, attempt, deps.gate.closed ? "manager_closed" : "already_terminal");
  }

  const completion = handle.completion !== undefined
    ? handle.completion
    : typeof handle.then === "function"
      ? handle
      : undefined;
  if (completion === undefined) {
    // 启动器只回传句柄：shard 保持 running，等待 cancel/timeout 收敛。
    return;
  }
  // 完成回调是独立的异步 tick：结算（可能连带聚合父任务）在该批内只序列化一次。
  Promise.resolve(completion).then(
    (result) => { deps.persistence.withPersistenceBatch(() => deps.bound.completeShard(task, shard, attempt, result)); },
    (error) => { deps.persistence.withPersistenceBatch(() => deps.bound.failShard(task, shard, attempt, error)); },
  );
}

function attemptMessageIdOf(s, deps, parentTaskId, shardId, attemptNumber) {
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) return null;
  const shard = task.shards.find((entry) => entry.shardId === shardId);
  if (shard === undefined) return null;
  const attempt = shard.attempts.find((entry) => entry.attempt === attemptNumber);
  if (attempt === undefined) return null;
  return typeof attempt.messageId === "string" && attempt.messageId.length > 0 ? attempt.messageId : null;
}

function attemptIdentityOf(s, deps, parentTaskId, shardId, attemptNumber) {
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) return null;
  const shard = task.shards.find((entry) => entry.shardId === shardId);
  if (shard === undefined) return null;
  const attempt = shard.attempts.find((entry) => entry.attempt === attemptNumber);
  if (attempt === undefined) return null;
  return {
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    status: attempt.status,
    terminal: isTerminalShardStatus(attempt.status),
  };
}

function recordAttributionViolation(s, deps, input) {
  const parentTaskId = normalizeText(input?.parentTaskId).trim();
  if (parentTaskId.length === 0) return { accepted: false, changed: false, reason: "missing_parent_task_id" };
  // 回收屏障/已回收任务都不得写事件：诊断事件同样会进快照，会打破回收的落盘一致性。
  if (deps.reclaim.current !== null) return deps.bound.reclaimInProgressResult();
  if (!deps.store.hasTask(parentTaskId) && deps.store.isReclaimed(parentTaskId)) return deps.bound.taskReclaimedResult(parentTaskId);
  const shardId = normalizeText(input?.shardId).trim();
  const attemptNumber = Number.isSafeInteger(input?.attempt) && input.attempt > 0 ? input.attempt : undefined;
  const reason = normalizeText(input?.reason).trim();
  const turn = Number.isSafeInteger(input?.turn) ? input.turn : undefined;
  const messageId = typeof input?.messageId === "string" && input.messageId.length > 0 ? input.messageId : undefined;
  deps.events.emit({
    type: "shard_attribution_unproven",
    parentTaskId,
    ...(shardId.length === 0 ? {} : { shardId }),
    ...(attemptNumber === undefined ? {} : { attempt: attemptNumber }),
    reason: reason.length === 0 ? "unproven" : reason,
    ...(turn === undefined ? {} : { turn }),
    ...(messageId === undefined ? {} : { messageId }),
  });
  deps.persistence.notifyPersistence();
  return { accepted: true, changed: true, parentTaskId, reason: reason.length === 0 ? "unproven" : reason };
}

function normalizeStopIdentity(s, deps, identity) {
  const invalid = (message) => ({ ok: false, code: "STOP_EVIDENCE_INVALID", reason: "stop_evidence_invalid", message });
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    return invalid("停止证据身份必须是对象");
  }
  const parentTaskId = typeof identity.parentTaskId === "string" ? identity.parentTaskId.trim() : "";
  const shardId = typeof identity.shardId === "string" ? identity.shardId.trim() : "";
  if (parentTaskId.length === 0) return invalid("身份缺少 parentTaskId");
  if (shardId.length === 0) return invalid("身份缺少 shardId");
  if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) return invalid("身份中的 attempt 必须是正整数");
  const attemptId = typeof identity.attemptId === "string" ? identity.attemptId.trim() : "";
  if (attemptId.length === 0) return invalid("身份缺少 attemptId");
  if (!Number.isSafeInteger(identity.executionGeneration) || identity.executionGeneration < 1) {
    return invalid("身份中的 executionGeneration 必须是正整数");
  }
  return {
    ok: true,
    parentTaskId,
    shardId,
    attempt: identity.attempt,
    attemptId,
    executionGeneration: identity.executionGeneration,
  };
}

function observeStopEvidence(s, deps, identity, rawEvidence) {
  if (deps.gate.closed) {
    return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  }
  if (deps.reclaim.current !== null) return deps.bound.reclaimInProgressResult();
  const id = normalizeStopIdentity(s, deps, identity);
  if (!id.ok) {
    return { accepted: false, changed: false, code: id.code, reason: id.reason, message: id.message };
  }
  // 已回收任务的迟到证据：结构化 no-op，绝不复活任务或写事件/快照。
  if (!deps.store.hasTask(id.parentTaskId) && deps.store.isReclaimed(id.parentTaskId)) {
    return deps.bound.taskReclaimedResult(id.parentTaskId);
  }
  const task = deps.store.taskById(id.parentTaskId);
  const shard = task?.shards.find((entry) => entry.shardId === id.shardId);
  const attempt = shard?.attempts.find((entry) => entry.attempt === id.attempt);
  if (task === undefined || shard === undefined || attempt === undefined) {
    return {
      accepted: false,
      changed: false,
      code: "STOP_EVIDENCE_UNKNOWN_ATTEMPT",
      reason: "stop_evidence_unknown_attempt",
      parentTaskId: id.parentTaskId,
      shardId: id.shardId,
      attempt: id.attempt,
    };
  }
  if (attempt.attemptId !== id.attemptId || attempt.executionGeneration !== id.executionGeneration) {
    return {
      accepted: false,
      changed: false,
      code: "STOP_EVIDENCE_STALE",
      reason: "stop_evidence_stale",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      expectedAttemptId: attempt.attemptId,
      expectedExecutionGeneration: attempt.executionGeneration,
      receivedAttemptId: id.attemptId,
      receivedExecutionGeneration: id.executionGeneration,
    };
  }
  const verdict = normalizeStopEvidence(s, deps, rawEvidence, { allowedSources: HOST_STOP_EVIDENCE_SOURCES });
  if (!verdict.ok) {
    return {
      accepted: false,
      changed: false,
      code: verdict.code,
      reason: verdict.reason,
      message: verdict.message,
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
    };
  }
  const base = {
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
  if (isStopObserved(attempt)) {
    return {
      accepted: true,
      changed: false,
      reason: "stop_evidence_already_observed",
      ...base,
      stopEvidence: cloneJson(attempt.stopEvidence),
      taskStatus: task.status,
      counts: deps.store.computeCounts(task),
    };
  }
  applyStopEvidence(s, deps, task, shard, attempt, verdict.evidence);
  // 证据到达后补聚合：逻辑终态 + 全部 observed 的任务在这里才真正结算（task_settled 一次）。
  deps.bound.aggregateTask(task);
  deps.persistence.notifyPersistence();
  // 释放影响范围可能解开别的任务被冲突挡住的排队分片，因此重新请求一次派发。
  schedule(s, deps);
  return {
    accepted: true,
    changed: true,
    reason: "observed",
    ...base,
    source: attempt.stopEvidence.source,
    stopEvidence: cloneJson(attempt.stopEvidence),
    // released=true 表示该 attempt 的影响范围已释放（终态 + 证据齐备）。
    released: isTerminalShardStatus(attempt.status),
    taskStatus: task.status,
    counts: deps.store.computeCounts(task),
  };
}

function markAttributionAged(s, deps, identity, options = {}) {
  if (deps.gate.closed) {
    return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  }
  if (deps.reclaim.current !== null) return deps.bound.reclaimInProgressResult();
  const id = normalizeStopIdentity(s, deps, identity);
  if (!id.ok) {
    return { accepted: false, changed: false, code: id.code, reason: id.reason, message: id.message };
  }
  if (!deps.store.hasTask(id.parentTaskId) && deps.store.isReclaimed(id.parentTaskId)) {
    return deps.bound.taskReclaimedResult(id.parentTaskId);
  }
  const task = deps.store.taskById(id.parentTaskId);
  const shard = task?.shards.find((entry) => entry.shardId === id.shardId);
  const attempt = shard?.attempts.find((entry) => entry.attempt === id.attempt);
  if (task === undefined || shard === undefined || attempt === undefined) {
    return {
      accepted: false,
      changed: false,
      code: "ATTRIBUTION_AGED_UNKNOWN_ATTEMPT",
      reason: "attribution_aged_unknown_attempt",
      parentTaskId: id.parentTaskId,
      shardId: id.shardId,
      attempt: id.attempt,
    };
  }
  if (attempt.attemptId !== id.attemptId || attempt.executionGeneration !== id.executionGeneration) {
    return {
      accepted: false,
      changed: false,
      code: "ATTRIBUTION_AGED_STALE",
      reason: "attribution_aged_stale",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      expectedAttemptId: attempt.attemptId,
      expectedExecutionGeneration: attempt.executionGeneration,
      receivedAttemptId: id.attemptId,
      receivedExecutionGeneration: id.executionGeneration,
    };
  }
  const base = {
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
  // 已终态：可能是迟到 completion 已先一步收敛，或证据已到达。老化绝不能改写它。
  if (isTerminalShardStatus(attempt.status)) {
    return {
      accepted: true,
      changed: false,
      reason: "already_terminal",
      ...base,
      status: attempt.status,
      ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      taskStatus: task.status,
      counts: deps.store.computeCounts(task),
    };
  }
  // 原因码可由调用方覆盖，但默认固定值必须与诊断/测试契约一致。
  const reason = typeof options?.reason === "string" && options.reason.length > 0
    ? options.reason
    : "shard_attribution_unproven_aged";
  const settled = deps.bound.settleShard(task, shard, attempt, "interrupted", {
    error: {
      name: "ShardAttributionUnprovenError",
      reason: "shard_attribution_unproven_aged",
      message: "shard 归属无法证明且已超过人工处理宽限，需人工确认执行是否仍在写盘",
    },
    reason,
    // 不给停止证据：范围继续占用，聚合继续被 stop_pending 挡住。
    needsAttention: true,
  });
  if (settled !== true) {
    return {
      accepted: false,
      changed: false,
      reason: "invalid_transition",
      ...base,
      status: attempt.status,
      taskStatus: task.status,
    };
  }
  s.lastAttributionAged = {
    ...base,
    reason,
    at: attempt.finishedAt ?? deps.now(),
    needsAttention: true,
  };
  return {
    accepted: true,
    changed: true,
    reason: "aged",
    ...base,
    status: attempt.status,
    terminalReason: attempt.terminalReason,
    stopState: STOP_EVIDENCE_STATE_UNKNOWN,
    needsAttention: true,
    taskStatus: task.status,
    counts: deps.store.computeCounts(task),
  };
}

function stopDiagnostics(s, deps) {
  let unconfirmed = 0;
  let unobserved = 0;
  let requested = 0;
  let watchdogExpired = 0;
  let legacyAttempts = 0;
  /** 归属老化导致的 interrupted（理由码固定，独立计数便于诊断面直接展示）。 */
  let attributedAged = 0;
  /** 老化后仍未收到停止证据的 attempt 数（真正"需要人工处理"的活跃集合）。 */
  let needsAttention = 0;
  const summaries = [];
  for (const task of deps.store.allTasks()) {
    const attempts = [];
    let taskUnconfirmed = 0;
    for (const shard of task.shards) {
      for (const attempt of shard.attempts) {
        const observed = isStopObserved(attempt);
        const terminal = isTerminalShardStatus(attempt.status);
        if (!observed) unobserved += 1;
        if (terminal && !observed) { unconfirmed += 1; taskUnconfirmed += 1; }
        if (attempt.stopRequestedAt !== undefined) requested += 1;
        if (attempt.stopWatchdogExpiredAt !== undefined) watchdogExpired += 1;
        if (attempt.legacy === true) legacyAttempts += 1;
        const aged = attempt.terminalReason === "shard_attribution_unproven_aged";
        if (aged) attributedAged += 1;
        const attention = aged && !observed;
        if (attention) needsAttention += 1;
        const interesting = !observed
          || attempt.stopRequestedAt !== undefined
          || attempt.stopWatchdogExpiredAt !== undefined
          || attempt.legacy === true
          || aged;
        if (!interesting) continue;
        attempts.push({
          shardId: shard.shardId,
          attempt: attempt.attempt,
          attemptId: attempt.attemptId,
          executionGeneration: attempt.executionGeneration,
          status: attempt.status,
          stopState: observed ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
          ...(observed ? { stopSource: attempt.stopEvidence.source } : {}),
          ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
          ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
          ...(attempt.stopWatchdogExpiredAt === undefined ? {} : { stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt }),
          ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
          aged,
          needsAttention: attention,
          legacy: attempt.legacy === true,
        });
      }
    }
    if (attempts.length === 0) continue;
    summaries.push({
      parentTaskId: task.parentTaskId,
      role: task.role,
      status: task.status,
      unconfirmed: taskUnconfirmed,
      counts: { pending: deps.store.computeCounts(task).pending, stop_pending: deps.store.countStopPending(task) },
      attempts,
    });
  }
  return {
    processInstance: PROCESS_INSTANCE,
    boundary: s.stopDiagnosticsState.boundary,
    boundarySource: s.stopDiagnosticsState.boundarySource,
    // stopPending 是 unconfirmed 的对外别名（Host/meta 诊断按这个名字投影）。
    stopPending: unconfirmed,
    unconfirmed,
    unobserved,
    requested,
    watchdogExpired,
    legacyAttempts,
    legacy: legacyAttempts,
    attributedAged,
    needsAttention,
    lastWatchdog: s.lastStopWatchdog === null ? null : cloneJson(s.lastStopWatchdog),
    lastAttributionAged: s.lastAttributionAged === null ? null : cloneJson(s.lastAttributionAged),
    tasks: summaries,
  };
}

function whenIdle(s, deps) {
  // close 不会遗留新的调度工作；若 close 前已经排了 drain，仍等待该 drain 有界结束。
  return s.drainScheduled ? s.drainPromise : Promise.resolve();
}

function isIdle(s, deps) {
  return deps.gate.closed || (!s.drainScheduled && !s.workRequested);
}

export function createScheduler({ store, limits, events, persistence, agents, clock, ownerGate }) {
  const { gate, reclaim } = ownerGate;
  const { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn, stopGraceMs } = clock;
  // agents 袋里的执行 seam：启动器/续作器/取消器 + 派发前路由冻结（票据 03，可选）。
  // prepareAttempt 缺失（旧装配/测试替身）时 startShard 完全保持旧行为。
  const { launcher, continuer, canceller, prepareAttempt: prepareAttemptFn } = agents;
  const ledger = events;
  const limitConfig = limits.limitConfig;
  /** 本模块独占的可变绑定（唯一 owner；只在模块内以 s 形参传递）。 */
  const s = {
    throttleStats: { role: new Map(), provider: new Map() },
    workRequested: false,
    drainScheduled: false,
    resolveDrain: undefined,
    drainPromise: Promise.resolve(),
    lastStopWatchdog: null,
    lastAttributionAged: null,
    stopDiagnosticsState: { boundary: "unknown", boundarySource: "process-instance" },
  };
  const deps = {
    now, setTimeoutFn, clearTimeoutFn, stopGraceMs, launcher, continuer, canceller,
    // 派发前路由冻结（票据 03）：只在是函数时注入，其余情况一律按「未接线」处理。
    prepareAttempt: typeof prepareAttemptFn === "function" ? prepareAttemptFn : undefined,
    gate, reclaim, ledger, limitConfig, store, limits, events, persistence, bound: null,
  };
  function bindCommands(commands) { deps.bound = commands; }

  return Object.freeze({
    bindCommands,
    throttleStatsFor: throttleStatsFor.bind(null, s, deps),
    noteThrottled: noteThrottled.bind(null, s, deps),
    noteDispatchReleased: noteDispatchReleased.bind(null, s, deps),
    throttleDiagnostics: throttleDiagnostics.bind(null, s, deps),
    throttleRow: throttleRow.bind(null, s, deps),
    dispatchAvailable: dispatchAvailable.bind(null, s, deps),
    drainBatch: drainBatch.bind(null, s, deps),
    drain: drain.bind(null, s, deps),
    schedule: schedule.bind(null, s, deps),
    createAttempt: createAttempt.bind(null, s, deps),
    attemptBudgetVerdict: attemptBudgetVerdict.bind(null, s, deps),
    updateShardStatus: updateShardStatus.bind(null, s, deps),
    previousMessageIdsFor: previousMessageIdsFor.bind(null, s, deps),
    clearAttemptStopTimer: clearAttemptStopTimer.bind(null, s, deps),
    normalizeStopEvidence: normalizeStopEvidence.bind(null, s, deps),
    applyStopEvidence: applyStopEvidence.bind(null, s, deps),
    markStopRequested: markStopRequested.bind(null, s, deps),
    expireStopWatchdog: expireStopWatchdog.bind(null, s, deps),
    unconfirmedStopAttempts: unconfirmedStopAttempts.bind(null, s, deps),
    unconfirmedStopSummary: unconfirmedStopSummary.bind(null, s, deps),
    stopGateVerdict: stopGateVerdict.bind(null, s, deps),
    requestShardCancellation: requestShardCancellation.bind(null, s, deps),
    startShard: startShard.bind(null, s, deps),
    consumeLaunchResult: consumeLaunchResult.bind(null, s, deps),
    attemptMessageIdOf: attemptMessageIdOf.bind(null, s, deps),
    attemptIdentityOf: attemptIdentityOf.bind(null, s, deps),
    recordAttributionViolation: recordAttributionViolation.bind(null, s, deps),
    normalizeStopIdentity: normalizeStopIdentity.bind(null, s, deps),
    observeStopEvidence: observeStopEvidence.bind(null, s, deps),
    markAttributionAged: markAttributionAged.bind(null, s, deps),
    stopDiagnostics: stopDiagnostics.bind(null, s, deps),
    whenIdle: whenIdle.bind(null, s, deps),
    isIdle: isIdle.bind(null, s, deps),
    dispatchState: Object.freeze({
      noteRestoreBoundary: noteRestoreBoundary.bind(null, s, deps),
      clearPendingWork: clearPendingWork.bind(null, s, deps),
    }),
    noteRestoreBoundary: noteRestoreBoundary.bind(null, s, deps),
    clearPendingWork: clearPendingWork.bind(null, s, deps),
  });
}
