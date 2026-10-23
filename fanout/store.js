/**
 * fan-out 任务存储与派生索引（R3-13：从 fanout.js 的 manager 本体拆出）。
 *
 * ## 职责
 * - 父任务表与 requestId / continuation 幂等索引；
 * - 调度派生索引：role -> 父任务列表、三维 running 计数、attempt 影响范围索引、轮转游标；
 * - 任务/分片只读投影（taskSnapshot / shardSnapshot / activeShardView）与聚合计数；
 * - 回收墓碑（reclaimedTaskIds）与回收前置条件判定；
 * - 冲突检查配置（writeRoles / defaultAllowOverlap / conflictChecker）。
 *
 * ## 状态所有权（C5）
 * 本模块独占全部任务容器（tasks、requestIndex、continuationRequestOwners、parentsByRole、
 * runningCountsByRole/ByTask/ByProvider、activeShardEntries、activeShardsByPath、rotationCursors、
 * reclaimedTaskIds）与 nextActiveOrder / nextTaskNumber / nextExecutionGeneration 三个计数器。
 * Map / Set 不出本模块：对外只有语义化命令与只读投影。
 *
 * @module dsh-expert-group/fanout/store
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
 * 任务存储的模块级实现（每个函数显式接收 (s, deps)：s 是本模块独占的容器/计数器，
 * deps 是构造期注入的只读协作面）。实现全部在模块作用域，工厂只创建 s/deps 并绑定，
 * 因此单工厂行数与单闭包函数数都落在门槛内；容器仍只由 createTaskStore 创建、不出本模块。
 */
const RECLAIMED_TASK_MEMORY = 256;
const budgetPolicy = FANOUT_BUDGET;

function bindLimits(s, deps, limits) { deps.limits = limits; }

function computeCounts(s, deps, task) {
  const counts = {};
  for (const key of SHARD_STATUS_KEYS) counts[key] = 0;
  for (const shard of task.shards) {
    const status = shard.status ?? "queued";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  // pending 是「尚未终态」的派生计数，方便调用方直接读聚合进度。
  counts.pending = counts.queued + counts.running;
  /**
   * stop_pending（票据 07）：**已逻辑终态但停止未确认**的 attempt 数。
   *
   * 它和 pending 是两个独立的聚合阻塞源：pending 回答"还有分片在跑吗"，stop_pending
   * 回答"有没有分片已经终态、但执行体可能还在写"。只有两者同时为 0 才允许聚合结算，
   * 否则任务保持 pending（不写 settledAt、不发 task_settled）。
   *
   * 非终态 attempt 不计入这里——它们由 pending 覆盖；把两者混在一起会让"停止未确认"
   * 这个诊断字段在正常运行时恒大于 0，失去意义。
   */
  counts.stop_pending = countStopPending(s, deps, task);
  return counts;
}

function countStopPending(s, deps, task) {
  let total = 0;
  for (const shard of task.shards) {
    for (const attempt of shard.attempts) {
      const status = attempt.status ?? "queued";
      if (!isTerminalShardStatus(status)) continue;
      if (isStopObserved(attempt)) continue;
      total += 1;
    }
  }
  return total;
}

function activeShard(s, deps, shard) {
  return shard.attempts.find((attempt) => attempt.status === "running");
}

function addRunningCount(s, deps, task, delta) {
  const role = task.role;
  const nextRoleCount = (roleRunCount(s, deps, role) ?? 0) + delta;
  if (nextRoleCount <= 0) dropRoleRunCount(s, deps, role);
  else setRoleRunCount(s, deps, role, nextRoleCount);
  const nextTaskCount = (taskRunCount(s, deps, task) ?? 0) + delta;
  if (nextTaskCount <= 0) dropTaskRunCount(s, deps, task);
  else setTaskRunCount(s, deps, task, nextTaskCount);
  // provider 计数（票据 26）与前两个维度同源同点更新：没有归属的任务不进入任何
  // provider 池（provider 限流对它们不生效），因此也不会在这里凭空创建条目。
  const provider = typeof task.provider === "string" ? task.provider : "";
  if (provider.length === 0) return;
  const nextProviderCount = (providerRunCount(s, deps, provider) ?? 0) + delta;
  if (nextProviderCount <= 0) dropProviderRunCount(s, deps, provider);
  else setProviderRunCount(s, deps, provider, nextProviderCount);
}

function addTaskToRoleIndex(s, deps, task, roleIndex) {
  let parents = parentsForRole(s, deps, task.role);
  if (parents === undefined) {
    parents = [];
    setParentsForRole(s, deps, task.role, parents);
  }
  if (Number.isInteger(roleIndex) && roleIndex >= 0 && roleIndex <= parents.length) parents.splice(roleIndex, 0, task);
  else parents.push(task);
}

function removeAttemptScope(s, deps, attempt) {
  const previous = shardEntry(s, deps, attempt);
  if (previous === undefined) return;
  for (const path of previous.affectedPaths) {
    const attempts = pathAttempts(s, deps, path);
    if (attempts === undefined) continue;
    attempts.delete(attempt);
    if (attempts.size === 0) dropPathAttempts(s, deps, path);
  }
  dropShardEntry(s, deps, attempt);
}

function syncAttemptScope(s, deps, task, shard, attempt) {
  const previous = shardEntry(s, deps, attempt);
  const affectedPaths = Array.isArray(attempt?.affectedPaths) ? attempt.affectedPaths : [];
  const released = isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
  if (released) {
    removeAttemptScope(s, deps, attempt);
    return;
  }
  if (affectedPaths.length === 0) {
    // 没有声明影响范围的 attempt 不占位（与旧语义一致：空路径不参与冲突判定）。
    removeAttemptScope(s, deps, attempt);
    return;
  }
  const entry = {
    parentTaskId: task.parentTaskId,
    role: task.role,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    status: attempt.status ?? "queued",
    stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
    affectedPaths: [...affectedPaths],
    order: previous?.order ?? s.nextActiveOrder++,
    // 内部引用只用于"排除自己这个 shard"的冲突判定，绝不进入任何对外视图/快照。
    task,
    shard,
  };
  setShardEntry(s, deps, attempt, entry);
  for (const path of affectedPaths) {
    let attempts = pathAttempts(s, deps, path);
    if (attempts === undefined) {
      attempts = new Set();
      setPathAttempts(s, deps, path, attempts);
    }
    attempts.add(attempt);
  }
}

function syncShardScopes(s, deps, task, shard) {
  for (const attempt of shard.attempts) syncAttemptScope(s, deps, task, shard, attempt);
}

function setShardStatus(s, deps, task, shard, status) {
  const previous = shard.status;
  if (previous !== status) {
    if (previous === "running") addRunningCount(s, deps, task, -1);
    if (status === "running") addRunningCount(s, deps, task, 1);
  }
  shard.status = status;
  syncShardScopes(s, deps, task, shard);
}

function indexTask(s, deps, task, roleIndex) {
  addTaskToRoleIndex(s, deps, task, roleIndex);
  for (const shard of task.shards) {
    if (shard.status === "running") addRunningCount(s, deps, task, 1);
    syncShardScopes(s, deps, task, shard);
  }
}

function removeTaskIndex(s, deps, task) {
  const parents = parentsForRole(s, deps, task.role);
  const roleIndex = parents?.indexOf(task) ?? -1;
  if (roleIndex >= 0) {
    parents.splice(roleIndex, 1);
    if (parents.length === 0) dropParentsForRole(s, deps, task.role);
  }
  for (const shard of task.shards) {
    if (shard.status === "running") addRunningCount(s, deps, task, -1);
    for (const attempt of shard.attempts) removeAttemptScope(s, deps, attempt);
  }
  // 任务级计数以任务对象身份为 key，删除索引后必须回收该条目，否则被销毁的父子任务
  // 会以"零 running 的空条目"形式滞留在 Map 里直到 close。
  dropTaskRunCount(s, deps, task);
  return roleIndex >= 0 ? roleIndex : undefined;
}

function rebuildIndexes(s, deps) {
  clearRoleIndex(s, deps, s, deps);
  clearRoleRunCounts(s, deps, s, deps);
  clearTaskRunCounts(s, deps, s, deps);
  clearProviderRunCounts(s, deps, s, deps);
  clearActiveShards(s, deps, s, deps);
  s.nextActiveOrder = 0;
  // continuation requestId 的跨任务索引同样从任务本体（持久化真相源）重建：
  // restore 后旧 requestId 仍然可查（不会因为进程重启或索引淘汰而丢失幂等性）。
  clearContinuationOwners(s, deps, s, deps);
  for (const task of allTasks(s, deps, s, deps)) {
    indexTask(s, deps, task);
    for (const requestId of Object.keys(task.continuationRequests ?? {})) {
      setContinuationOwner(s, deps, requestId, task.parentTaskId);
    }
  }
}

function continuationRequestCount(s, deps, task) {
  return task?.continuationRequests === undefined || task.continuationRequests === null
    ? 0
    : Object.keys(task.continuationRequests).length;
}

function continuationRequestBudgetExceeded(s, deps, task) {
  return continuationRequestCount(s, deps, task) >= budgetPolicy.maxAttemptsPerShard;
}

function activeShardView(s, deps, entry) {
  return {
    parentTaskId: entry.parentTaskId,
    role: entry.role,
    shardId: entry.shardId,
    attempt: entry.attempt,
    attemptId: entry.attemptId,
    status: entry.status,
    stopState: entry.stopState,
    ...(entry.affectedPaths.length === 0 ? {} : { affectedPaths: [...entry.affectedPaths] }),
  };
}

function collectActiveShards(s, deps, excludeShard) {
  const active = [];
  for (const [, entry] of activeShardEntryEntries(s, deps, s, deps)) {
    if (excludeShard !== undefined && entry.shard === excludeShard) continue;
    active.push(activeShardView(s, deps, entry));
  }
  return active;
}

function collectConflictCandidates(s, deps, role, shard, excludeShard) {
  if (!deps.usesDefaultConflictChecker) return collectActiveShards(s, deps, excludeShard);
  if (!s.writeRoles.includes(role)) return [];
  const paths = Array.isArray(shard?.affectedPaths) ? shard.affectedPaths : [];
  if (paths.length === 0) return [];
  const candidates = new Set();
  for (const path of paths) {
    for (const candidate of pathAttempts(s, deps, path) ?? []) {
      const entry = shardEntry(s, deps, candidate);
      if (entry === undefined) continue;
      // 按 shard 身份排除自己：同一 shard 的多个历史 attempt 都不算冲突对象
      //（重试/续作复用同一 child，天然不会与自己的旧 attempt 抢路径）。
      if (excludeShard !== undefined && entry.shard === excludeShard) continue;
      candidates.add(entry);
    }
  }
  return [...candidates]
    .sort((left, right) => left.order - right.order)
    .map((arg0) => activeShardView(s, deps, arg0));
}

function filterDefaultConflictCandidates(s, deps, shard, otherShards) {
  const paths = new Set(Array.isArray(shard?.affectedPaths) ? shard.affectedPaths : []);
  if (paths.size === 0) return [];
  return otherShards.filter((other) => (other.affectedPaths ?? []).some((path) => paths.has(path)));
}

function findConflict(s, deps, role, shard, otherShards) {
  const candidates = deps.usesDefaultConflictChecker
    ? filterDefaultConflictCandidates(s, deps, shard, otherShards)
    : otherShards;
  if (typeof deps.conflictObserver === "function") {
    try {
      deps.conflictObserver({ role, shard, otherShards: candidates });
    } catch {
      // 观测器是旁路，不能把诊断代码异常变成调度失败。
    }
  }
  if (candidates.length === 0) return null;
  const verdict = normalizeConflict(s.conflictChecker({ role, shard, otherShards: candidates }));
  if (!verdict.conflict) return null;
  return {
    ...(verdict.shardIds === undefined ? {} : { shardIds: verdict.shardIds }),
    ...(verdict.paths === undefined ? {} : { paths: verdict.paths }),
    ...(shard.shardId === undefined ? {} : { shardId: shard.shardId }),
    role,
  };
}

function attemptStopSnapshot(s, deps, attempt) {
  return {
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    stopEvidence: attempt.stopEvidence === undefined
      ? { state: STOP_EVIDENCE_STATE_UNKNOWN }
      : cloneJson(attempt.stopEvidence),
    ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
    ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
    ...(attempt.stopWatchdogExpiredAt === undefined ? {} : { stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt }),
    ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
    ...(attempt.legacy === true ? { legacy: true } : {}),
  };
}

function shardSnapshot(s, deps, task, shard) {
  return {
    shardId: shard.shardId,
    // 可选任务名称：Expert Group 用它作为分片第一行的任务名，缺失时由投影侧回退 shardId。
    ...(shard.name === undefined ? {} : { name: shard.name }),
    prompt: shard.prompt,
    status: shard.status,
    attemptCount: shard.attempts.length,
    createdAt: shard.createdAt,
    updatedAt: shard.updatedAt,
    affectedPaths: [...shard.affectedPaths],
    ...(shard.cancelRequested === true ? { cancelRequested: true } : {}),
    ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
    // 恢复续跑被 attempt 预算拦下时的稳定原因码（票据 08）。只在被拦下时出现，
    // 不含 prompt/结果，供投影与 Host 提示"该分片需手工提交新父任务"。
    ...(shard.resumeBlocked === undefined ? {} : { resumeBlocked: cloneJson(shard.resumeBlocked) }),
    attempts: shard.attempts.map((attempt) => ({
      attempt: attempt.attempt,
      status: attempt.status,
      startedAt: attempt.startedAt ?? null,
      finishedAt: attempt.finishedAt ?? null,
      affectedPaths: [...attempt.affectedPaths],
      ...(attempt.cancelRequested === true ? { cancelRequested: true } : {}),
      ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
      ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
      ...(attempt.messageId === undefined ? {} : { messageId: attempt.messageId }),
      ...(attempt.result === undefined ? {} : { result: attempt.result }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
      ...attemptStopSnapshot(s, deps, attempt),
    })),
  };
}

function allShardsTerminal(s, deps, task) {
  if (task === undefined || task === null) return false;
  const latestAllTerminal = task.shards.every((shard) => {
    const latest = shard.attempts[shard.attempts.length - 1];
    return latest !== undefined && isTerminalShardStatus(latest.status);
  });
  return latestAllTerminal && countStopPending(s, deps, task) === 0;
}

function taskSnapshot(s, deps, task) {
  const counts = computeCounts(s, deps, task);
  const shards = task.shards.map((shard) => shardSnapshot(s, deps, task, shard));
  return {
    parentTaskId: task.parentTaskId,
    ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
    role: task.role,
    basePrompt: task.basePrompt,
    status: task.status,
    // 逻辑轮次与「当前是否可复用续作」：工具回执与侧边栏投影都读这两个字段，
    // 不需要自己遍历 attempt 推断。
    round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
    continuable: !deps.isClosed() && task.parentCancelRequested !== true && allShardsTerminal(s, deps, task),
    // continuation 幂等记录（requestId -> 本轮结果）：随快照持久化，冷恢复后仍可查，
    // 消费方据此确认「同一个 requestId 曾经续作过哪一轮」。
    ...(continuationRequestCount(s, deps, task) === 0 ? {} : { continuationRequests: cloneJson(task.continuationRequests) }),
    allowOverlap: task.allowOverlap,
    concurrencyLimit: deps.limits.roleLimitFor(task),
    // 父任务级默认超时（票据 06）：只含**显式**值。它是「分片没有自己的
    // timeoutMs 时用什么」的唯一依据，因此必须在任务视图里如实暴露。
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    // provider 归属（票据 26）：任务视图如实投影，诊断与客户端只读展示据此把
    // 排队/运行分片归到某个 provider 名下（它不改变 prompt 或任何调度输入）。
    ...(task.provider === undefined ? {} : { provider: task.provider }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    settledAt: task.settledAt ?? null,
    parentCancelRequested: task.parentCancelRequested === true,
    counts,
    shards,
    // 结果按输入顺序排列，与 shards 同序；这是 wait-all 的对外主视图。
    results: shards.map((shard, index) => ({
      shardId: shard.shardId,
      status: shard.status,
      attempts: shard.attempts.length,
      ...(shard.attempts[shard.attempts.length - 1]?.result === undefined
        ? {}
        : { result: shard.attempts[shard.attempts.length - 1].result }),
      ...(shard.attempts[shard.attempts.length - 1]?.error === undefined
        ? {}
        : { error: shard.attempts[shard.attempts.length - 1].error }),
      index,
    })),
  };
}

function rememberReclaimedTask(s, deps, parentTaskId) {
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
  s.reclaimedTaskIds.delete(parentTaskId);
  s.reclaimedTaskIds.add(parentTaskId);
  while (s.reclaimedTaskIds.size > RECLAIMED_TASK_MEMORY) {
    const oldest = s.reclaimedTaskIds.values().next().value;
    s.reclaimedTaskIds.delete(oldest);
  }
}

function forgetReclaimedTask(s, deps, parentTaskId) {
  if (typeof parentTaskId === "string" && parentTaskId.length > 0) s.reclaimedTaskIds.delete(parentTaskId);
}

function reclaimBlockReason(s, deps, task) {
  if (task === undefined) return "task_not_found";
  // 仍有未终态分片：任务还会产生状态变化，绝不能在落盘候选里冻结它。
  if (task.shards.some((shard) => shard.status === "queued" || shard.status === "running")) {
    return "task_not_terminal";
  }
  // 停止未确认优先于"未结算"：原因更具体、处置方向明确（补证据或等待看门狗/老化）。
  if (countStopPending(s, deps, task) !== 0) return "stop_unconfirmed";
  const terminalStatus = task.status === "completed"
    || task.status === "completed_with_errors"
    || task.status === "cancelled";
  if (!terminalStatus || typeof task.settledAt !== "number") return "task_not_terminal";
  return null;
}

function countReclaimableTasks(s, deps) {
  let total = 0;
  for (const task of allTasks(s, deps, s, deps)) {
    if (reclaimBlockReason(s, deps, task) === null) total += 1;
  }
  return total;
}

function activeCountsByRole(s, deps) {
  // running 计数在状态转移处同步维护；返回副本避免 dispatch 修改派生索引。
  return countsByRole(s, deps, s, deps);
}

function activeCountsByTask(s, deps) {
  // 同上：任务级计数同样是派生索引，dispatch 只在副本上做本轮预算。
  return countsByTask(s, deps, s, deps);
}

function activeCountsByProvider(s, deps) {
  // provider 份额同样是派生索引：dispatch 在副本上累计本轮派发，避免边派发边改写
  // 权威计数（权威计数仍只在 setShardStatus 处更新）。
  return countsByProvider(s, deps, s, deps);
}

function taskById(s, deps, parentTaskId) { return s.tasks.get(parentTaskId); }

function hasTask(s, deps, parentTaskId) { return s.tasks.has(parentTaskId); }

function putTask(s, deps, parentTaskId, task) { s.tasks.set(parentTaskId, task); }

function dropTask(s, deps, parentTaskId) { s.tasks.delete(parentTaskId); }

function allTasks(s, deps) { return s.tasks.values(); }

function taskTableSize(s, deps) { return s.tasks.size; }

function clearTasks(s, deps) { s.tasks.clear(); }

function requestOwner(s, deps, requestId) { return s.requestIndex.get(requestId); }

function setRequestOwner(s, deps, requestId, parentTaskId) { s.requestIndex.set(requestId, parentTaskId); }

function dropRequestOwner(s, deps, requestId) { s.requestIndex.delete(requestId); }

function clearRequestOwners(s, deps) { s.requestIndex.clear(); }

function continuationOwner(s, deps, requestId) { return s.continuationRequestOwners.get(requestId); }

function setContinuationOwner(s, deps, requestId, parentTaskId) { s.continuationRequestOwners.set(requestId, parentTaskId); }

function dropContinuationOwner(s, deps, requestId) { s.continuationRequestOwners.delete(requestId); }

function clearContinuationOwners(s, deps) { s.continuationRequestOwners.clear(); }

function continuationOwnerEntries(s, deps) { return [...s.continuationRequestOwners]; }

function parentsForRole(s, deps, role) { return s.parentsByRole.get(role); }

function setParentsForRole(s, deps, role, parents) { s.parentsByRole.set(role, parents); }

function dropParentsForRole(s, deps, role) { s.parentsByRole.delete(role); }

function roleKeys(s, deps) { return s.parentsByRole.keys(); }

function clearRoleIndex(s, deps) { s.parentsByRole.clear(); }

function roleRunCount(s, deps, role) { return s.runningCountsByRole.get(role); }

function setRoleRunCount(s, deps, role, count) { s.runningCountsByRole.set(role, count); }

function dropRoleRunCount(s, deps, role) { s.runningCountsByRole.delete(role); }

function clearRoleRunCounts(s, deps) { s.runningCountsByRole.clear(); }

function countsByRole(s, deps) { return new Map(s.runningCountsByRole); }

function taskRunCount(s, deps, task) { return s.runningCountsByTask.get(task); }

function setTaskRunCount(s, deps, task, count) { s.runningCountsByTask.set(task, count); }

function dropTaskRunCount(s, deps, task) { s.runningCountsByTask.delete(task); }

function clearTaskRunCounts(s, deps) { s.runningCountsByTask.clear(); }

function countsByTask(s, deps) { return new Map(s.runningCountsByTask); }

function providerRunCount(s, deps, provider) { return s.runningCountsByProvider.get(provider); }

function setProviderRunCount(s, deps, provider, count) { s.runningCountsByProvider.set(provider, count); }

function dropProviderRunCount(s, deps, provider) { s.runningCountsByProvider.delete(provider); }

function clearProviderRunCounts(s, deps) { s.runningCountsByProvider.clear(); }

function countsByProvider(s, deps) { return new Map(s.runningCountsByProvider); }

function shardEntry(s, deps, attempt) { return s.activeShardEntries.get(attempt); }

function setShardEntry(s, deps, attempt, entry) { s.activeShardEntries.set(attempt, entry); }

function dropShardEntry(s, deps, attempt) { s.activeShardEntries.delete(attempt); }

function clearActiveShards(s, deps) { s.activeShardEntries.clear(); s.activeShardsByPath.clear(); }

function activeShardEntryEntries(s, deps) { return s.activeShardEntries; }

function pathAttempts(s, deps, affectedPath) { return s.activeShardsByPath.get(affectedPath); }

function setPathAttempts(s, deps, affectedPath, attempts) { s.activeShardsByPath.set(affectedPath, attempts); }

function dropPathAttempts(s, deps, affectedPath) { s.activeShardsByPath.delete(affectedPath); }

function rotationCursor(s, deps, role) { return s.rotationCursors.get(role); }

function dropRotationCursor(s, deps, role) { s.rotationCursors.delete(role); }

function setRotationCursor(s, deps, role, cursor) { s.rotationCursors.set(role, cursor); }

function clearRotationCursors(s, deps) { s.rotationCursors.clear(); }

function rotationCursorSnapshot(s, deps) { return Object.fromEntries(s.rotationCursors); }

function rotationCursorEntries(s, deps) { return [...s.rotationCursors]; }

function isReclaimed(s, deps, parentTaskId) { return s.reclaimedTaskIds.has(parentTaskId); }

function rememberReclaimed(s, deps, parentTaskId) { rememberReclaimedTask(s, deps, parentTaskId); }

function forgetReclaimed(s, deps, parentTaskId) { s.reclaimedTaskIds.delete(parentTaskId); }

function nextTaskNumberValue(s, deps) { return s.nextTaskNumber; }

function allocateTaskNumber(s, deps) { s.nextTaskNumber += 1; return s.nextTaskNumber; }

function setNextTaskNumber(s, deps, value) { s.nextTaskNumber = value; }

function nextExecutionGenerationValue(s, deps) { return s.nextExecutionGeneration; }

function allocateGeneration(s, deps) { s.nextExecutionGeneration += 1; return s.nextExecutionGeneration; }

function setNextExecutionGeneration(s, deps, value) { s.nextExecutionGeneration = value; }

function setConflictWriteRoles(s, deps, value) { s.writeRoles = value; }

function setConflictChecker(s, deps, value) { s.conflictChecker = value; }

function setAllowOverlap(s, deps, value) { s.defaultAllowOverlap = value; }

export function createTaskStore({ config }) {
  const initialWriteRoles = config.initialWriteRoles;
  const injectedConflictChecker = config.injectedConflictChecker;
  const usesDefaultConflictChecker = config.usesDefaultConflictChecker;
  const allowOverlap = config.allowOverlap;
  /** 本模块独占的状态切片（容器不出本模块；只在模块内以 s 形参传递）。 */
  const s = {
    tasks: new Map(),
    requestIndex: new Map(),
    continuationRequestOwners: new Map(),
    parentsByRole: new Map(),
    runningCountsByRole: new Map(),
    runningCountsByTask: new Map(),
    runningCountsByProvider: new Map(),
    activeShardEntries: new Map(),
    activeShardsByPath: new Map(),
    nextActiveOrder: 0,
    rotationCursors: new Map(),
    reclaimedTaskIds: new Set(),
    nextTaskNumber: 0,
    nextExecutionGeneration: 0,
    writeRoles: initialWriteRoles,
    defaultAllowOverlap: allowOverlap === true,
    conflictChecker: usesDefaultConflictChecker
      ? createWriteRoleConflictChecker({ writeRoles: initialWriteRoles })
      : injectedConflictChecker,
  };
  /** 构造期注入的只读协作面（晚绑定项由 bindLimits 补齐）。 */
  const deps = {
    usesDefaultConflictChecker: config.usesDefaultConflictChecker,
    isClosed: config.isClosed,
    conflictObserver: config.conflictObserver,
    limits: null,
  };
  function bindLimits(limits) { deps.limits = limits; }

  return Object.freeze({
    bindLimits,
    computeCounts: computeCounts.bind(null, s, deps),
    countStopPending: countStopPending.bind(null, s, deps),
    activeShard: activeShard.bind(null, s, deps),
    addRunningCount: addRunningCount.bind(null, s, deps),
    addTaskToRoleIndex: addTaskToRoleIndex.bind(null, s, deps),
    removeAttemptScope: removeAttemptScope.bind(null, s, deps),
    syncAttemptScope: syncAttemptScope.bind(null, s, deps),
    syncShardScopes: syncShardScopes.bind(null, s, deps),
    setShardStatus: setShardStatus.bind(null, s, deps),
    indexTask: indexTask.bind(null, s, deps),
    removeTaskIndex: removeTaskIndex.bind(null, s, deps),
    rebuildIndexes: rebuildIndexes.bind(null, s, deps),
    continuationRequestCount: continuationRequestCount.bind(null, s, deps),
    continuationRequestBudgetExceeded: continuationRequestBudgetExceeded.bind(null, s, deps),
    activeShardView: activeShardView.bind(null, s, deps),
    collectActiveShards: collectActiveShards.bind(null, s, deps),
    collectConflictCandidates: collectConflictCandidates.bind(null, s, deps),
    filterDefaultConflictCandidates: filterDefaultConflictCandidates.bind(null, s, deps),
    findConflict: findConflict.bind(null, s, deps),
    attemptStopSnapshot: attemptStopSnapshot.bind(null, s, deps),
    shardSnapshot: shardSnapshot.bind(null, s, deps),
    taskSnapshot: taskSnapshot.bind(null, s, deps),
    rememberReclaimedTask: rememberReclaimedTask.bind(null, s, deps),
    forgetReclaimedTask: forgetReclaimedTask.bind(null, s, deps),
    reclaimBlockReason: reclaimBlockReason.bind(null, s, deps),
    countReclaimableTasks: countReclaimableTasks.bind(null, s, deps),
    activeCountsByRole: activeCountsByRole.bind(null, s, deps),
    activeCountsByTask: activeCountsByTask.bind(null, s, deps),
    activeCountsByProvider: activeCountsByProvider.bind(null, s, deps),
    allShardsTerminal: allShardsTerminal.bind(null, s, deps),
    taskById: taskById.bind(null, s, deps),
    hasTask: hasTask.bind(null, s, deps),
    putTask: putTask.bind(null, s, deps),
    dropTask: dropTask.bind(null, s, deps),
    allTasks: allTasks.bind(null, s, deps),
    taskTableSize: taskTableSize.bind(null, s, deps),
    clearTasks: clearTasks.bind(null, s, deps),
    requestOwner: requestOwner.bind(null, s, deps),
    setRequestOwner: setRequestOwner.bind(null, s, deps),
    dropRequestOwner: dropRequestOwner.bind(null, s, deps),
    clearRequestOwners: clearRequestOwners.bind(null, s, deps),
    continuationOwner: continuationOwner.bind(null, s, deps),
    setContinuationOwner: setContinuationOwner.bind(null, s, deps),
    dropContinuationOwner: dropContinuationOwner.bind(null, s, deps),
    clearContinuationOwners: clearContinuationOwners.bind(null, s, deps),
    continuationOwnerEntries: continuationOwnerEntries.bind(null, s, deps),
    parentsForRole: parentsForRole.bind(null, s, deps),
    setParentsForRole: setParentsForRole.bind(null, s, deps),
    dropParentsForRole: dropParentsForRole.bind(null, s, deps),
    roleKeys: roleKeys.bind(null, s, deps),
    clearRoleIndex: clearRoleIndex.bind(null, s, deps),
    roleRunCount: roleRunCount.bind(null, s, deps),
    setRoleRunCount: setRoleRunCount.bind(null, s, deps),
    dropRoleRunCount: dropRoleRunCount.bind(null, s, deps),
    clearRoleRunCounts: clearRoleRunCounts.bind(null, s, deps),
    countsByRole: countsByRole.bind(null, s, deps),
    taskRunCount: taskRunCount.bind(null, s, deps),
    setTaskRunCount: setTaskRunCount.bind(null, s, deps),
    dropTaskRunCount: dropTaskRunCount.bind(null, s, deps),
    clearTaskRunCounts: clearTaskRunCounts.bind(null, s, deps),
    countsByTask: countsByTask.bind(null, s, deps),
    providerRunCount: providerRunCount.bind(null, s, deps),
    setProviderRunCount: setProviderRunCount.bind(null, s, deps),
    dropProviderRunCount: dropProviderRunCount.bind(null, s, deps),
    clearProviderRunCounts: clearProviderRunCounts.bind(null, s, deps),
    countsByProvider: countsByProvider.bind(null, s, deps),
    shardEntry: shardEntry.bind(null, s, deps),
    setShardEntry: setShardEntry.bind(null, s, deps),
    dropShardEntry: dropShardEntry.bind(null, s, deps),
    clearActiveShards: clearActiveShards.bind(null, s, deps),
    activeShardEntryEntries: activeShardEntryEntries.bind(null, s, deps),
    pathAttempts: pathAttempts.bind(null, s, deps),
    setPathAttempts: setPathAttempts.bind(null, s, deps),
    dropPathAttempts: dropPathAttempts.bind(null, s, deps),
    rotationCursor: rotationCursor.bind(null, s, deps),
    dropRotationCursor: dropRotationCursor.bind(null, s, deps),
    setRotationCursor: setRotationCursor.bind(null, s, deps),
    clearRotationCursors: clearRotationCursors.bind(null, s, deps),
    rotationCursorSnapshot: rotationCursorSnapshot.bind(null, s, deps),
    rotationCursorEntries: rotationCursorEntries.bind(null, s, deps),
    isReclaimed: isReclaimed.bind(null, s, deps),
    rememberReclaimed: rememberReclaimed.bind(null, s, deps),
    forgetReclaimed: forgetReclaimed.bind(null, s, deps),
    nextTaskNumberValue: nextTaskNumberValue.bind(null, s, deps),
    allocateTaskNumber: allocateTaskNumber.bind(null, s, deps),
    setNextTaskNumber: setNextTaskNumber.bind(null, s, deps),
    nextExecutionGenerationValue: nextExecutionGenerationValue.bind(null, s, deps),
    allocateGeneration: allocateGeneration.bind(null, s, deps),
    setNextExecutionGeneration: setNextExecutionGeneration.bind(null, s, deps),
    conflictConfig: Object.freeze({
      get writeRoles() { return s.writeRoles; },
      get defaultAllowOverlap() { return s.defaultAllowOverlap; },
      get conflictChecker() { return s.conflictChecker; },
      setWriteRoles: setConflictWriteRoles.bind(null, s, deps),
      setConflictChecker: setConflictChecker.bind(null, s, deps),
      setDefaultAllowOverlap: setAllowOverlap.bind(null, s, deps),
    }),
    setConflictChecker: setConflictChecker.bind(null, s, deps),
  });
}
