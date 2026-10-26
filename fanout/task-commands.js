/**
 * fan-out 任务命令（R3-13：从 fanout.js 的 manager 本体拆出）。
 *
 * ## 职责
 * - 公开写命令：submit / continueTask / retryShard / cancelShard / cancelParent；
 * - 结算与聚合：settleShard / completeShard / failShard / settleLaunchFailure / aggregateTask 等；
 * - 只读能力投影与查询：taskCapabilities / getTask / listTasks / getCounts。
 *
 * ## 状态所有权（C5）
 * 本模块不持有任何 Map / Set / 可写状态：任务表与计数在 store，调度闩在 scheduler，
 * 事件与持久化在 events / persistence，生命周期闸门与回收屏障由 ownerGate 只读投影或命令写入。
 *
 * ## 依赖方向
 * task-commands -> store / limits / scheduler / events / persistence（单向）。scheduler 反向调用本模块的
 * 结算入口经 bindCommands 晚绑定，构造期不存在 ESM 环。
 *
 * @module dsh-expert-group/fanout/task-commands
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
 * 任务命令的模块级实现（每个函数显式接收 (s, deps)）。本模块不持有可变状态：s 仅用于签名一致，
 * 全部状态经 deps 上的窄命令面读写。实现全部在模块作用域，工厂只组装 deps 并绑定。
 */
const budgetPolicy = FANOUT_BUDGET;

/**
 * 已结算（终态）父任务的状态集合：只有这些任务会被自动裁剪。
 *
 * 边界：pending（含 stop_pending 未确认停止的形态）是唯一的非终态，永不入列——裁剪
 * 一个仍可能产生状态变化的任务会把它从 role 索引、影响范围索引与快照里摘掉，执行体
 * 之后再写就跟内存表脱节了。
 *
 * 词表现状（fanout/errors.js 的 FANOUT_TASK_STATUSES）只有 completed /
 * completed_with_errors / cancelled 三个终态；failed / timed_out / interrupted 一并列出，
 * 是为将来扩展任务级状态时不必再改裁剪判定（当前状态下它们永不出现，不改变行为）。
 */
const SETTLED_TASK_STATUSES = new Set([
  "completed",
  "completed_with_errors",
  "cancelled",
  "failed",
  "timed_out",
  "interrupted",
]);

function rejectSettlement(s, deps, task, shard, attempt, requestedStatus, reason) {
  const event = deps.events.emit({
    type: "shard_settlement_rejected",
    parentTaskId: task.parentTaskId,
    shardId: shard.shardId,
    attempt: attempt.attempt,
    role: task.role,
    reason,
    currentStatus: attempt.status,
    requestedStatus,
  });
  deps.persistence.notifyPersistence();
  return { accepted: false, reason, event };
}

function reclaimInProgressResult(s, deps) {
  return {
    accepted: false,
    changed: false,
    code: RECLAIM_IN_PROGRESS_CODE,
    reason: "reclaim_in_progress",
  };
}

function taskReclaimedResult(s, deps, parentTaskId) {
  return {
    accepted: false,
    changed: false,
    code: TASK_RECLAIMED_CODE,
    reason: "task_reclaimed",
    ...(typeof parentTaskId === "string" && parentTaskId.length > 0 ? { parentTaskId } : {}),
  };
}

function settleShard(s, deps, task, shard, attempt, status, {
  result,
  error,
  violation: presetViolation,
  evidence,
  reason,
  watchStop = true,
  needsAttention = false,
  /** 受控的 queued→failed 通道（票据 03 派发前准备失败）；默认关闭，沿用旧转移规则。 */
  allowQueuedFailure = false,
} = {}) {
  // 已回收任务：任何迟到结算/证据都只做结构化 no-op（不复活、不改统计、不写事件/快照）。
  // 判定必须在预算/证据处理之前，否则迟到负载仍可能污染诊断与持久化。
  if (task?.reclaimed === true) return taskReclaimedResult(s, deps, task.parentTaskId);
  if (!SHARD_STATUS_SET.has(status) || !isTerminalShardStatus(status)) {
    return rejectSettlement(s, deps, task, shard, attempt, status, "invalid_status");
  }
  // 结果/错误的字节预算：超限必须显式失败并携带完整元数据，绝不写入被截断的内容，
  // 也不能把超限负载写进 attempt（否则事件、快照都会跟着无界增长）。
  // 判定发生在状态迁移之前，因此违规时该 shard 走同一条终态路径收敛为 failed。
  let payloadViolation = presetViolation ?? null;
  const payloadVerdict = presetViolation === undefined
    ? checkAttemptPayloadBudget({
      result,
      error,
      subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
    })
    : { ok: true };
  if (!payloadVerdict.ok) {
    payloadViolation = payloadVerdict.violation;
    deps.events.noteBudgetViolation(payloadViolation, "attempt", { parentTaskId: task.parentTaskId });
    status = "failed";
    result = undefined;
    error = budgetShardError(payloadViolation);
  }
  /**
   * 迟到停止证据（票据 07）：attempt 已终态时先补证据、再走拒绝路径。
   *
   * 场景：超时/取消已写终态，child 的 completion 随后才到。状态必须原样保留（迟到的
   * 成功/失败不得改写终态），但证据仍要落库——否则该 attempt 的影响范围永远占位、
   * 任务永远不能聚合。证据应用幂等，重复回调不会重复计数。
   */
  const preStatus = attempt.status;
  if (evidence !== undefined && isTerminalShardStatus(preStatus) && !isStopObserved(attempt)) {
    const verdict = deps.scheduler.normalizeStopEvidence(evidence);
    // 内部来源（completion/admission）形状异常按"没有证据"处理：不能因为一次归一化
    // 失败就阻断正常的拒绝/诊断路径。
    if (verdict.ok) deps.scheduler.applyStopEvidence(task, shard, attempt, verdict.evidence);
  }
  if (isTerminalShardStatus(attempt.status)) {
    const outcome = payloadViolation === null
      ? rejectSettlement(s, deps, task, shard, attempt, status, "already_terminal")
      : rejectSettlement(s, deps, task, shard, attempt, status, "attempt_budget_exceeded");
    /**
     * 迟到证据可能刚刚解除了聚合阻塞（该 attempt 的影响范围已释放）：补一次聚合，
     * 让"取消/超时 + 迟到 completion"也能正常结算，且 task_settled 仍只发一次。
     */
    if (evidence !== undefined) {
      aggregateTask(s, deps, task);
      deps.scheduler.schedule();
    }
    return outcome;
  }
  /**
   * 合法转移：running -> 任意终态；queued -> cancelled（从未 admission）或
   * interrupted（归属老化：这一轮从未真正开始，但也无法证明启动过）。
   *
   * queued -> failed 只在 allowQueuedFailure（派发前准备失败）下成立，其余来源仍拒绝。
   */
  if (preStatus !== "running"
    && !(preStatus === "queued" && (status === "cancelled" || status === "interrupted"
      || (status === "failed" && allowQueuedFailure === true)))) {
    return payloadViolation === null
      ? rejectSettlement(s, deps, task, shard, attempt, status, "invalid_transition")
      : rejectSettlement(s, deps, task, shard, attempt, status, "attempt_budget_exceeded");
  }
  attempt.status = status;
  attempt.finishedAt = deps.now();
  attempt.terminalReason = typeof reason === "string" && reason.length > 0 ? reason : defaultTerminalReason(status);
  if (result !== undefined) attempt.result = result;
  if (error !== undefined) attempt.error = error;
  if (attempt.timer !== undefined) {
    deps.clearTimeoutFn(attempt.timer);
    attempt.timer = undefined;
  }
  /**
   * 正常路径的停止证据（在终态写入之后应用，事件里的 status 才是真实的终态）：
   * - 成功/失败：用调用方给的 completion/admission 证据；
   * - queued 阶段取消：从未 admission，直接记 not-started 证据并释放范围。
   */
  if (!isStopObserved(attempt)) {
    const notStarted = status === "cancelled"
      && preStatus === "queued"
      && attempt.childId === undefined
      && attempt.handle === undefined;
    const finalEvidence = evidence ?? (notStarted
      ? { state: STOP_EVIDENCE_STATE_OBSERVED, source: "not-started", observedAt: deps.now() }
      : undefined);
    if (finalEvidence !== undefined) {
      const verdict = deps.scheduler.normalizeStopEvidence(finalEvidence);
      if (verdict.ok) deps.scheduler.applyStopEvidence(task, shard, attempt, verdict.evidence);
    }
  }
  /**
   * 超时/取消进入"已请求停止、等待证据"的状态：
   * - stopEvidence 保持 unknown（管理器自己的取消不算证据）；
   * - 记录 stopRequestedAt/stopDeadlineAt 并按宽限挂看门狗；
   * - close 传 watchStop=false：清内存定时器、保留 unknown（关闭后不再有调度）。
   * 成功/失败路径不会走到这里——它们总能给出 completion/admission 证据。
   */
  if ((status === "timed_out" || status === "cancelled") && !isStopObserved(attempt)) {
    deps.scheduler.markStopRequested(task, shard, attempt, { watch: watchStop && !deps.gate.closed });
  }
  /**
   * 释放 admission 句柄（内存去重）：句柄持有 child 的 completion promise 与 child 对象，
   * 而 completion 结果同时存在 attempt.result 与已 settle 的 promise 值里，长期持有等于
   * 每个终态 attempt 都多留一份结果。
   *
   * 边界的核对结论（写入前实测全仓库读写点）：
   * - completion 订阅已在 admission 落地时用局部变量注册（scheduler.consumeLaunchResult），
   *   结算路径不再读 handle.completion；
   * - canceller 只在仍在执行的那一侧读取 handle（超时/取消请求发生在写终态之前），
   *   Host 的 canceller 也是从自己的归属记录取 handle，不读这里；
   * - 只有下面两个已执行过的分支读过 attempt.handle：notStarted 证据判定（本函数上方）
   *   与 markStopRequested（紧随其前的停止证据收敛），因此置空点必须放在它们之后。
   *
   * 结算后仍需保留的标量（childId / messageId / attemptId / executionGeneration /
   * stopEvidence）原样保留，迟到回调与停止证据归属仍按既有语义识别。
   */
  attempt.handle = undefined;
  // 多轮复用安全边界：同一 shard 可以有多个 attempt（手工 retry / continuation），
  // shard 的**当前状态**只能由最新 attempt 决定。非最新 attempt 的迟到结算仍然写入它
  // 自己的 attempt 历史（审计可见）并发布 attempt 级事件，但绝不改写 shard.status，
  // 否则旧轮迟到结算会覆盖新轮状态，并可能重复发布旧轮 task_settled。
  const isLatestAttempt = shard.attempts[shard.attempts.length - 1] === attempt;
  if (isLatestAttempt) deps.store.setShardStatus(task, shard, status, attempt);
  // 非最新 attempt 不改变 shard.status，但它自己的范围索引仍要刷新（终态 + 证据决定释放）。
  else deps.store.syncAttemptScope(task, shard, attempt);
  shard.updatedAt = attempt.finishedAt;
  task.updatedAt = attempt.finishedAt;
  deps.events.emitShardStatus(task, shard, status, attempt.attempt, {
    ...(isLatestAttempt ? {} : { staleAttempt: true, shardStatus: shard.status }),
    ...(task.round === undefined ? {} : { round: task.round }),
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
    ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
    // 归属老化：终态事件必须显式带"需要人工处理"标记，消费方不能把它当成普通失败。
    ...(needsAttention === true ? { needs_attention: true } : {}),
    ...(result === undefined ? {} : { result: cloneJson(result) }),
    ...(error === undefined ? {} : { error: cloneJson(error) }),
    // 预算违规必须留下可检索的诊断（终态可观察，且不携带超限原始负载）。
    ...(payloadViolation === null ? {} : { violation: payloadViolation }),
  });
  aggregateTask(s, deps, task);
  deps.persistence.notifyPersistence();
  deps.scheduler.schedule();
  return true;
}

function admissionEvidence(s, deps, attempt) {
  return {
    source: "admission_not_created",
    observedAt: deps.now(),
    ...(typeof attempt.childId === "string" && attempt.childId.length > 0 ? { childId: attempt.childId } : {}),
  };
}

function completionEvidence(s, deps, attempt) {
  return {
    source: "child_completion",
    observedAt: deps.now(),
    ...(typeof attempt.childId === "string" && attempt.childId.length > 0 ? { childId: attempt.childId } : {}),
    ...(typeof attempt.messageId === "string" && attempt.messageId.length > 0 ? { messageId: attempt.messageId } : {}),
  };
}

function lateCompletionEvidence(s, deps, attempt) {
  return isTerminalShardStatus(attempt.status) ? completionEvidence(s, deps, attempt) : undefined;
}

function isShutdownCompletionError(s, deps, error) {
  if (error === null || typeof error !== "object") return false;
  const reason = typeof error.reason === "string" ? error.reason : "";
  const code = typeof error.code === "string" ? error.code : "";
  return reason === "runtime_closed"
    || reason === "manager_closed"
    || code === "RUNTIME_CLOSED"
    || code === "MANAGER_CLOSED"
    || error.name === "FanoutClosedError";
}

function launchFailure(s, deps, task, shard, attempt, error) {
  settleLaunchFailure(s, deps, task, shard, attempt, error, {
    evidence: admissionEvidence(s, deps, attempt),
    reason: "launch_failure",
  });
}

function settleLaunchFailure(s, deps, task, shard, attempt, error, { evidence, reason = "launch_failure" } = {}) {
  if (task?.reclaimed === true) return;
  const rawVerdict = checkBudget({
    resource: "attempt_error",
    limit: budgetPolicy.maxAttemptErrorBytes,
    receivedBytes: measureJsonBytes(errorInstinctPayload(s, deps, error)),
    subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
    // 与 checkAttemptPayloadBudget 的 attempt_error 分支保持同一契约：
    // 完整错误仍留在子会话日志里（可恢复），并给出精简错误的可执行提示。
    recoverable: true,
    hint: "错误过大时请让专家回传精简摘要（name/message/关键 stack 帧），完整日志留在子会话",
  });
  if (!rawVerdict.ok) {
    deps.events.noteBudgetViolation(rawVerdict.violation, "attempt", { parentTaskId: task.parentTaskId });
    // violation 必须作为 preset 传进 settleShard：否则终态事件只带一个"小错误"，
    // 丢失 attempt_error 的超限元数据（票据 04 的可见性缺口）。
    settleShard(s, deps, task, shard, attempt, "failed", {
      error: budgetShardError(rawVerdict.violation),
      violation: rawVerdict.violation,
      evidence,
      reason,
    });
    return;
  }
  settleShard(s, deps, task, shard, attempt, "failed", {
    error: normalizeLaunchError(error),
    evidence,
    reason,
  });
}

function errorInstinctPayload(s, deps, error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack, ...error };
  }
  return error;
}

function completeShard(s, deps, task, shard, attempt, result) {
  if (task?.reclaimed === true) return;
  // 取消与完成竞态：取消请求先写入终态则完成被忽略，反之完成胜出。
  if (attempt.cancelRequested === true) {
    /**
     * 取消路径的证据边界（票据 07）：attempt 仍在 running 时，取消结算属于"请求停止"，
     * 由 child 回的"我取消了"不证明执行体退出，因此不附带证据；
     * 只有落在一个**已终态** attempt 上的迟到 completion 才补录证据（不改状态、不重复
     * 计数），这正是"取消后 child 真的结束"的可观察收敛。
     */
    settleShard(s, deps, task, shard, attempt, "cancelled", {
      error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
      // 关闭后到达的 completion 不能当作停止证据（见 isShutdownCompletionError）。
      evidence: deps.gate.closed ? undefined : lateCompletionEvidence(s, deps, attempt),
      reason: "cancelled",
    });
    return;
  }
  const rawResult = result === undefined ? null : result;
  // 不可 JSON 序列化的结果不能被 cloneJson 深拷贝（会抛 TypeError 并逃出 completion
  // 回调），因此在这里提前转成显式的预算失败；超限但仍可序列化的结果交给
  // settleShard 判定，以便它照常发出带 violation 的 shard 终态诊断事件。
  const measured = measureJsonBytes(rawResult);
  if (measured === null) {
    const violation = describeBudgetViolation({
      resource: "attempt_result",
      limit: budgetPolicy.maxAttemptResultBytes,
      receivedBytes: null,
      measured: false,
      recoverable: true,
      subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
      hint: "结果没有 JSON 表示；请让专家只回传可序列化的文本/结构化结果",
    });
    deps.events.noteBudgetViolation(violation, "attempt", { parentTaskId: task.parentTaskId });
    // completion 已落地（只是结果不可序列化），因此这一轮执行确实结束了：
    // 仍要带上完成证据，否则该 attempt 的影响范围会因"预算失败"而永远占位。
    settleShard(s, deps, task, shard, attempt, "failed", {
      error: budgetShardError(violation),
      violation,
      // 关闭后的 completion 不证明执行停止；正常路径才是可信证据。
      evidence: deps.gate.closed ? undefined : completionEvidence(s, deps, attempt),
      reason: "failed",
    });
    return;
  }
  settleShard(s, deps, task, shard, attempt, "succeeded", {
    result: rawResult === null ? null : cloneJson(rawResult),
    // 成功 = 该 attempt 自己的 completion 落地，这是"这一轮执行已经结束"的证据。
    evidence: deps.gate.closed ? undefined : completionEvidence(s, deps, attempt),
    reason: "completed",
  });
}

function failShard(s, deps, task, shard, attempt, error) {
  if (task?.reclaimed === true) return;
  if (attempt.cancelRequested === true && !isTerminalShardStatus(attempt.status)) {
    settleShard(s, deps, task, shard, attempt, "cancelled", {
      error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
      reason: "cancelled",
    });
    return;
  }
  // completion 失败同样证明这一轮执行结束；若 attempt 已终态（超时/取消），
  // settleShard 只补证据并保留原状态。
  // 例外：close/runtime_closed/manager_closed 只是"本进程不再等待"，必须保持 unknown，
  // 否则关闭会把所有未确认停止的 attempt 一次性"证明"为已停止。
  const shutdown = deps.gate.closed || isShutdownCompletionError(s, deps, error);
  settleLaunchFailure(s, deps, task, shard, attempt, error, {
    evidence: shutdown ? undefined : completionEvidence(s, deps, attempt),
    reason: "failed",
  });
}

/**
 * 读取一个已结算任务的裁剪排序时刻。
 *
 * 只用于「谁最旧」的比较，不参与任何对外投影：settledAt 是权威结算时刻；老快照/恢复
 * 出来的任务可能缺这个字段，因此按 updatedAt -> createdAt 逐级兜底；三者都不是有限数字
 * 时返回 +Infinity，让插入序成为最终判据（绝不因为时间戳缺失就把任务误判成最旧）。
 */
function settledRetentionStamp(task) {
  for (const value of [task?.settledAt, task?.updatedAt, task?.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 移除一个已结算父任务，并复用显式回收 commit 的清理语义（fanout/reclaim.js）。
 *
 * 逐项对应 reclaim commit 的删除顺序，保证自动裁剪与用户主动回收留下的内存状态完全一致：
 * 1. dropTask：任务本体出表；
 * 2. dropRequestOwner：仅当 requestId 索引仍指向该任务（否则会误删别人的幂等键）；
 * 3. dropContinuationOwner：续作 requestId 索引按 owner 反查清理；
 * 4. removeTaskIndex：role 轮转索引 + 影响范围索引 + 任务级 running 计数一并收敛；
 * 5. task.reclaimed 墓碑 + rememberReclaimedTask：迟到回调持有的就是这个对象引用，
 *    据此按「任务已回收」的结构化 no-op 处理（不复活、不改统计、不发事件）。
 *
 * 不发布 tasks_reclaimed 事件：那是「用户主动回收」的语义，自动裁剪只是内存收敛，
 * 由调用方照常 notifyPersistence() 让磁盘快照跟着收敛即可。
 */
function dropSettledTask(s, deps, task) {
  const parentTaskId = task.parentTaskId;
  deps.store.dropTask(parentTaskId);
  if (task.requestId !== undefined && deps.store.requestOwner(task.requestId) === parentTaskId) {
    deps.store.dropRequestOwner(task.requestId);
  }
  for (const [requestId, ownerId] of [...deps.store.continuationOwnerEntries()]) {
    if (ownerId === parentTaskId) deps.store.dropContinuationOwner(requestId);
  }
  deps.store.removeTaskIndex(task);
  task.reclaimed = true;
  deps.store.rememberReclaimedTask(parentTaskId);
}

/**
 * 计算本次「已结算任务保留」的淘汰计划（纯函数，无副作用）。
 *
 * 为什么单独抽取：淘汰必须同时满足条数预算与字节预算，输入非法时还要 fail-safe；
 * 纯函数可以直接验证这些边界，不必每次都构造 1 MiB 的真实任务（集成路径另有用例）。
 *
 * 语义边界：
 * - 只统计 SETTLED_TASK_STATUSES 里的任务，活跃任务（pending）永不参与淘汰；
 * - 按 settledRetentionStamp 升序淘汰最旧的，时间戳相同则按任务表插入序（Map 迭代序）
 *   兜底，保证同毫秒结算的一批任务淘汰顺序可复现；
 * - protectedTask 是「刚刚结算、正要发布 task_settled」的当前任务：即使所有时间戳相同，
 *   也绝不把它自己裁掉（否则事件会指向一个已不存在的任务句柄）。它仍计入条数与字节
 *   合计——它同样是快照负担，只是不可淘汰；
 * - 每次淘汰当前最旧的一条，直到「条数 ≤ maxSettledTasks 且 字节合计 ≤ 字节预算」同时
 *   成立；任一预算超限都继续淘汰。字节预算是调用方算出的**有效预算**（默认静态 1 MiB，
 *   结算路径会按当前事件历史/活动任务收小）；**0 是合法的零预算**，仍必须继续淘汰；
 * - 字节口径 = measureJsonBytes(task)；null（不可序列化）按「不可测量 = 保守超限」
 *   处理：只有把它淘汰之后才可能回到预算内，绝不当成 0 字节放过；
 * - fail-safe：字节预算非法（undefined / 负数 / 小数）时不启用字节裁剪，只做既有条数
 *   裁剪；maxSettledTasks 非法时返回空计划（与既有 trim 语义一致，不抛错）。
 *
 * @param {Iterable<object>} tasks - deps.store.allTasks()（插入序）。
 * @param {{maxSettledTasks?:number, maxSettledTaskBytes?:number, protectedTask?:object}} [policy]
 * @returns {object[]} 需要淘汰的任务对象（最旧优先）；调用方负责真正删除。
 */
export function planSettledTaskEvictions(tasks, policy = {}) {
  const countLimit = policy.maxSettledTasks;
  // 条数常量非法时 fail-safe：宁可不裁剪，也不做无界淘汰（配置是编译期冻结的常量，
  // 走到这里只可能是打包/替换出错）。
  if (!Number.isSafeInteger(countLimit) || countLimit < 0) return [];
  // 字节预算只有「非负安全整数」才启用：0 表示动态余额已耗尽（仍要淘汰），
  // undefined/负数/小数表示无法判定（关闭字节裁剪，条数裁剪继续）。
  const hasByteBudget = Number.isSafeInteger(policy.maxSettledTaskBytes) && policy.maxSettledTaskBytes >= 0;
  const byteLimit = hasByteBudget ? policy.maxSettledTaskBytes : 0;
  const protectedTask = policy.protectedTask;
  const candidates = [];
  let order = 0;
  let protectedCount = 0;
  let measuredBytes = 0;
  let unmeasurableCount = 0;
  for (const task of tasks) {
    const insertionOrder = order;
    order += 1;
    if (task === null || typeof task !== "object") continue;
    if (!SETTLED_TASK_STATUSES.has(task.status)) continue;
    // 字节统计是每次结算 O(已结算任务数 × 序列化)：条数上限 32 量级可接受。这里刻意
    // 不做缓存——retry/续作会改写 shards，缓存失效比多算一遍更难发现。
    const bytes = measureJsonBytes(task);
    if (bytes === null) unmeasurableCount += 1;
    else measuredBytes += bytes;
    if (task === protectedTask) {
      protectedCount += 1;
      continue;
    }
    candidates.push({ task, bytes, insertionOrder });
  }
  const bytesExceeded = () => hasByteBudget && (unmeasurableCount > 0 || measuredBytes > byteLimit);
  if (candidates.length + protectedCount <= countLimit && !bytesExceeded()) return [];
  candidates.sort((left, right) => {
    const leftStamp = settledRetentionStamp(left.task);
    const rightStamp = settledRetentionStamp(right.task);
    if (leftStamp !== rightStamp) return leftStamp - rightStamp;
    return left.insertionOrder - right.insertionOrder;
  });
  const plan = [];
  for (let index = 0; index < candidates.length; index += 1) {
    // 剩余候选数 = 尚未淘汰的条数；protected 永不计入可淘汰集合，但计入合计。
    const remaining = candidates.length - index;
    if (remaining + protectedCount <= countLimit && !bytesExceeded()) break;
    const entry = candidates[index];
    plan.push(entry.task);
    if (entry.bytes === null) unmeasurableCount -= 1;
    else measuredBytes -= entry.bytes;
  }
  return plan;
}

/**
 * 快照封装、元数据与降级诊断事件的保留字节（约 260 KiB）：快照还含 envelope/version、
 * childModels 等元数据与降级诊断事件，它们不参与裁剪却占用 maxSnapshotBytes，算
 * 「已结算任务可用字节」时必须先扣掉，否则动态预算把余量算大、又会写满磁盘。
 */
const SNAPSHOT_RESERVE_BYTES = 260 * 1024;

/**
 * 读取当前事件历史的字节数（纯只读；不触发裁剪，也不发事件）。
 * - 读面存在且返回非负安全整数 → 直接采用；
 * - 读面缺失（旧装配 / 测试替身）→ 用 maxEventHistoryBytes 保守估计「可能已占满」；
 * - 读面抛错或返回非法值 → null，由调用方回落静态 maxSettledTaskBytes（不做过度淘汰）。
 *
 * @param {object} deps - 任务命令依赖（只用 events 只读面）。
 * @returns {number|null} 字节数；null 表示不可信。
 */
function readEventHistoryBytes(deps) {
  const readHistoryBytes = deps.events?.historyBytes;
  if (typeof readHistoryBytes !== "function") {
    const fallback = budgetPolicy.maxEventHistoryBytes;
    return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : null;
  }
  let value;
  try {
    value = readHistoryBytes();
  } catch {
    return null;
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 活动（非终态）任务的 JSON 字节合计：它们不参与淘汰却出现在快照里，因此要先从快照
 * 预算扣除，剩下的才是已结算任务可用空间。任一任务不可序列化时整体返回 null
 * （无法证明体积时宁可回落静态上限）。
 *
 * @param {Iterable<object>} tasks - 与淘汰计划同源的任务快照（插入序）。
 * @returns {number|null} 字节合计；null 表示不可测量。
 */
function measuredActiveTaskBytes(tasks) {
  let total = 0;
  try {
    for (const task of tasks) {
      if (task === null || typeof task !== "object") continue;
      if (SETTLED_TASK_STATUSES.has(task.status)) continue;
      const bytes = measureJsonBytes(task);
      if (bytes === null) return null;
      total += bytes;
    }
  } catch {
    return null;
  }
  return total;
}

/**
 * 计算本次「已结算任务字节」的动态有效预算：
 *   effective = min(maxSettledTaskBytes,
 *                   maxSnapshotBytes − 事件历史 − 活动任务 − SNAPSHOT_RESERVE_BYTES)
 *
 * 为什么动态：静态 1 MiB 是按「事件历史 ≤ 2 MiB」推导的；事件历史若已占掉大半预算，
 * 静态值仍会挤爆快照。动态值把当前真实占用算进去，保证任务 + 事件 + 活动任务 +
 * 预留能装进 maxSnapshotBytes。
 * 边界：结果 < 0 按 0（已结算历史清到只剩 protectedTask，活动任务永不淘汰）；静态
 * 常量为 0/非法 → undefined，交给 plan 关闭字节裁剪；快照上限非法、事件历史读数非法、
 * 活动任务不可测量 → 回落静态 maxSettledTaskBytes（宁可少淘汰，不按错误动态值过度淘汰）。
 * 不做缓存：结算频率低，O(已结算 + 活动) 次序列化可接受。
 *
 * @param {Iterable<object>} tasks - 与淘汰计划同源的任务快照。
 * @param {object} deps - 任务命令依赖。
 * @returns {number|undefined} 有效字节预算；undefined 表示关闭字节裁剪。
 */
function effectiveSettledTaskBudget(tasks, deps) {
  const staticLimit = budgetPolicy.maxSettledTaskBytes;
  if (!Number.isSafeInteger(staticLimit) || staticLimit <= 0) return void 0;
  const snapshotLimit = budgetPolicy.maxSnapshotBytes;
  if (!Number.isSafeInteger(snapshotLimit) || snapshotLimit <= 0) return staticLimit;
  const eventHistoryBytes = readEventHistoryBytes(deps);
  if (eventHistoryBytes === null) return staticLimit;
  const activeTaskBytes = measuredActiveTaskBytes(tasks);
  if (activeTaskBytes === null) return staticLimit;
  const remaining = snapshotLimit - eventHistoryBytes - activeTaskBytes - SNAPSHOT_RESERVE_BYTES;
  return Math.max(0, Math.min(staticLimit, remaining));
}

/**
 * 已结算任务的保留修剪（结算路径的内存收敛点）。
 *
 * 决策全部交给 planSettledTaskEvictions；条数预算固定为 maxSettledTasks，字节预算由
 * effectiveSettledTaskBudget 按当前快照占用动态收小（静态 maxSettledTaskBytes 只是上限）。
 * 本函数只负责执行删除并触发一次落盘通知。
 * 性能边界：只在确实淘汰了任务时才调用 notifyPersistence，避免每次结算都额外落盘。
 *
 * @returns {string[]} 本次被裁掉的 parentTaskId（供诊断/测试观察，不进入事件）。
 */
function trimSettledTasks(s, deps, protectedTask) {
  // 单次收集：活动任务字节与淘汰计划使用同一份任务快照，避免两次遍历之间状态漂移。
  const tasks = [...deps.store.allTasks()];
  const plan = planSettledTaskEvictions(tasks, {
    maxSettledTasks: budgetPolicy.maxSettledTasks,
    maxSettledTaskBytes: effectiveSettledTaskBudget(tasks, deps),
    protectedTask,
  });
  const dropped = [];
  for (const task of plan) {
    dropped.push(task.parentTaskId);
    dropSettledTask(s, deps, task);
  }
  // 裁剪改变了快照内容：按既有契约照常落盘（批内合并，批外立即落盘）。
  if (dropped.length > 0) deps.persistence.notifyPersistence();
  return dropped;
}

function aggregateTask(s, deps, task) {
  const counts = deps.store.computeCounts(task);
  const allTerminal = counts.pending === 0 && counts.stop_pending === 0;
  const previousStatus = task.status;
  const wasSettled = task.settledAt !== undefined;
  let status = task.status;
  if (!allTerminal) {
    // 逻辑终态但停止未确认：保持 pending，避免"管理器已结算、执行还在写"。
    status = "pending";
  } else if (counts.succeeded === task.shards.length) {
    status = "completed";
  } else if (task.parentCancelRequested === true && counts.succeeded === 0 && counts.failed === 0 && counts.timed_out === 0) {
    // 父级取消且没有任何 shard 成功或异常：未完成的 shard 都是因为父级取消而终止。
    status = "cancelled";
  } else {
    status = "completed_with_errors";
  }
  task.status = status;
  task.updatedAt = deps.now();
  if (!allTerminal) {
    task.settledAt = undefined;
    return;
  }
  task.settledAt = task.updatedAt;
  /**
   * 自动裁剪已结算任务（本函数是唯一的结算收敛点）：
   * - 位置在「写入 settledAt 之后、发布 task_settled 之前」：此刻本任务已是最新结算，
   *   被淘汰的只可能是更旧的历史任务，事件仍然指向真实存在的任务；
   * - restoringSnapshot 期间不裁剪：恢复必须原样装下快照内容，是否超限由
   *   checkRestoreBudget 判定；在恢复途中顺手删任务会让内存与磁盘分叉；
   * - 本任务作为 protectedTask 传入，即使整批任务时间戳相同也不会裁掉自己。
   */
  if (deps.gate.restoringSnapshot !== true) trimSettledTasks(s, deps, task);
  // 重复 cancel/aggregate 只刷新快照，不重复发布 task_settled；只有从 pending 进入
  // 终态，或终态因显式 retry / continuation 后再次结算，才产生新的聚合结算事件。
  if (deps.gate.restoringSnapshot || (wasSettled && previousStatus === status)) return;
  deps.events.emit({
    type: "task_settled",
    parentTaskId: task.parentTaskId,
    role: task.role,
    status,
    counts,
    // 轮次随聚合结算一起发布：多轮复用下消费方据此区分「哪一轮的 wait-all 完成」，
    // 旧轮迟到结算（非最新 attempt）不会走到这里（settleShard 已拒绝改写 shard 状态）。
    round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
    shards: task.shards.map((shard) => ({ shardId: shard.shardId, status: shard.status, attempts: shard.attempts.length })),
  });
}

function submit(s, deps, input) {
  if (deps.gate.closed) {
    return {
      accepted: false,
      changed: false,
      code: "MANAGER_CLOSED",
      reason: "manager_closed",
      shardIds: [],
    };
  }
  // 回收屏障：新增登记会破坏"候选快照 = 待落盘状态"的一致性，一律结构化拒绝。
  if (deps.reclaim.current !== null) return { ...reclaimInProgressResult(s, deps), shardIds: [] };
  const verdict = validateSubmitInput(input);
  if (!verdict.ok) {
    // 任务输入（basePrompt/shard prompt）与 shards 数量的预算拒绝属于 submit 阶段。
    if (verdict.violation !== undefined) deps.events.noteBudgetViolation(verdict.violation, "submit");
    throw validationError(verdict);
  }

  /**
   * requestId 幂等判定**先于**容量判定（票据 05 验收项）。
   *
   * 为什么顺序重要：满额时重复提交同一个 requestId 是"重放已知请求"，不是"新增任务"。
   * 若容量判定在前，调用方会收到容量错误并误以为需要先回收/等待——实际上它拿到的
   * 会是与首次完全相同的任务句柄。去重命中永远不占新槽位，因此这里可以安全地提前返回。
   */
  if (verdict.requestId !== undefined) {
    const existingId = deps.store.requestOwner(verdict.requestId);
    if (existingId !== undefined && deps.store.hasTask(existingId)) {
      const existing = deps.store.taskById(existingId);
      return {
        parentTaskId: existing.parentTaskId,
        duplicate: true,
        role: existing.role,
        status: existing.status,
        shardIds: existing.shards.map((shard) => shard.shardId),
        requestId: verdict.requestId,
      };
    }
  }

  // task 数量预算：快照里的 tasks 数组与内存表都按 task 线性增长，必须有上界。
  // 判定的是"本候选登记后的数量"，因此 +1。拒绝结构额外携带 current / reclaimable，
  // 提示指向真实可执行入口（RPC fanout-reclaim），而不是含糊的"等待或取消"。
  const taskCountViolation = budgetVerdict(
    "tasks",
    budgetPolicy.maxTasks,
    deps.store.taskTableSize() + 1,
    "tasks",
    "调用 fanout-reclaim 回收已结算的父任务，或等待尚未结算的任务收敛 / 调整 maxTasks 后再提交",
    { current: deps.store.taskTableSize(), reclaimable: deps.store.countReclaimableTasks() },
  );
  if (taskCountViolation !== null) {
    deps.events.noteBudgetViolation(taskCountViolation.violation, "submit");
    throw validationError(taskCountViolation);
  }

  const allowOverlap = verdict.allowOverlap || deps.store.conflictConfig.defaultAllowOverlap;
  {
    // 冲突判定是「整体拒绝」的一部分：任何一个 shard 冲突都不登记任务。
    // allowOverlap 只放行拒绝动作，注入的 checker 仍会被调用，便于 Host 观测重叠。
    const otherShards = deps.store.collectActiveShards();
    const withinSubmit = [];
    for (const shard of verdict.shards) {
      const conflict = deps.store.findConflict(verdict.role, shard, [...otherShards, ...withinSubmit]);
      if (conflict !== null && !allowOverlap) {
        throw new FanoutValidationError(
          "AFFECTED_PATHS_CONFLICT",
          "shard " + shard.shardId + " 的 affectedPaths 与活动任务冲突",
          { field: "shards[" + verdict.shards.indexOf(shard) + "].affectedPaths", conflict },
        );
      }
      withinSubmit.push({
        parentTaskId: "(submitting)",
        role: verdict.role,
        shardId: shard.shardId,
        affectedPaths: shard.affectedPaths,
      });
    }
  }

  const timestamp = deps.now();
  const allocatedTaskNumber = deps.store.allocateTaskNumber();
  const explicitParentTaskId = typeof input.parentTaskId === "string" && input.parentTaskId.trim().length > 0
    ? input.parentTaskId.trim()
    : undefined;
  const parentTaskId = explicitParentTaskId ?? "fanout-" + allocatedTaskNumber;
  if (deps.store.hasTask(parentTaskId)) {
    throw new FanoutValidationError("DUPLICATE_PARENT_TASK_ID", "parentTaskId 已存在: " + parentTaskId, { field: "parentTaskId" });
  }
  // 同 id 的旧回收标记必须清除：新任务的迟到回调不能被误判成"任务已回收"。
  deps.store.forgetReclaimedTask(parentTaskId);
  // 任务级限制只固化**显式**给出的值（submit 入参 / 快照里已有的 concurrencyLimit）。
  // 角色级设置与默认值不在创建时复制到任务上：它们描述的是"该角色的共享并发池"，必须
  // 继续按当前 settings 解析——否则快照生成时那次请求的临时配置（例如 roleLimits=1）
  // 会被写进任务并永久压低该任务，配置缺失时尤其错误。
  const task = {
    parentTaskId,
    ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
    role: verdict.role,
    basePrompt: verdict.basePrompt,
    status: "pending",
    // 逻辑轮次：首次提交 = 第 1 轮，每次 continuation 递增（attempt 序号独立递增）。
    round: 1,
    allowOverlap,
    ...(verdict.concurrencyLimit === undefined ? {} : { concurrencyLimit: verdict.concurrencyLimit }),
    // 父任务级默认超时（票据 06）：只写**显式**值，随任务快照固化。
    // 未设置时不出现该字段，交给角色级默认值动态解析；0 是合法的「显式禁用」。
    ...(verdict.timeoutMs === undefined ? {} : { timeoutMs: verdict.timeoutMs }),
    // provider 归属（票据 26）：提交时得到的稳定归属，随任务快照固化，供 provider
    // 级并发计数使用；缺失表示该角色没有主模型，provider 限流不生效。
    ...(verdict.provider === undefined ? {} : { provider: verdict.provider }),
    createdAt: timestamp,
    updatedAt: timestamp,
    settledAt: undefined,
    parentCancelRequested: false,
    shards: verdict.shards.map((shard) => {
      // 实效超时在创建第一个 attempt 时解析一次：分片 > 父任务 > 角色（含 0）。
      const attemptTimeoutMs = deps.limits.resolveAttemptTimeoutMs(verdict.timeoutMs, shard.timeoutMs);
      return {
        shardId: shard.shardId,
        // 任务名称进入运行时状态：快照投影与恢复都以它为唯一来源，不再从别处推导。
        ...(shard.name === undefined ? {} : { name: shard.name }),
        prompt: shard.prompt,
        status: "queued",
        affectedPaths: shard.affectedPaths ?? [],
        // 分片快照只保留**显式覆盖**：不把父任务/角色默认值复制成分片覆盖，
        // 否则恢复后的新 attempt 会拿到当年冻结的值而绕过当前角色设置。
        ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: [{
          attempt: 1,
          status: "queued",
          /**
           * 首个 attempt 同样携带身份与默认停止证据（票据 07）：
           * 影响的路径从 queued 起就要预留，而预留条目按 attempt 建索引，
           * 因此 attempt 身份必须在登记时就已经稳定存在。
           */
          attemptId: deriveAttemptId(parentTaskId, shard.shardId, 1),
          executionGeneration: deps.store.allocateGeneration(),
          stopEvidence: { state: STOP_EVIDENCE_STATE_UNKNOWN },
          startedAt: undefined,
          finishedAt: undefined,
          affectedPaths: shard.affectedPaths ?? [],
          ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
        }],
      };
    }),
  };
  deps.store.putTask(parentTaskId, task);
  deps.store.indexTask(task);
  if (verdict.requestId !== undefined) deps.store.setRequestOwner(verdict.requestId, parentTaskId);

  deps.events.emit({
    type: "task_registered",
    parentTaskId,
    role: task.role,
    shardIds: task.shards.map((shard) => shard.shardId),
    counts: deps.store.computeCounts(task),
    ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
  });
  deps.persistence.notifyPersistence();
  deps.scheduler.schedule();
  return {
    parentTaskId,
    duplicate: false,
    role: task.role,
    status: task.status,
    shardIds: task.shards.map((shard) => shard.shardId),
    ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
  };
}

function continueTask(s, deps, input) {
  if (deps.gate.closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  if (deps.reclaim.current !== null) return reclaimInProgressResult(s, deps);
  const verdict = validateSubmitInput(input);
  if (!verdict.ok) {
    // 续作的输入/shard 数量拒绝与提交共用同一契约，但 phase 必须可区分（continue）。
    if (verdict.violation !== undefined) {
      deps.events.noteBudgetViolation(verdict.violation, "continue", { parentTaskId: normalizeText(input?.parentTaskId).trim() || undefined });
    }
    throw validationError(verdict);
  }
  const parentTaskId = normalizeText(input?.parentTaskId).trim();
  if (parentTaskId.length === 0) {
    return { accepted: false, changed: false, reason: "missing_parent_task_id" };
  }
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) {
    return { accepted: false, changed: false, reason: "unknown_parent_task", parentTaskId };
  }
  /**
   * requestId 幂等（**持久化**，不是全局 LRU）：
   * - 命中同一父任务的记录 → 原样返回上次的 continuation result + duplicate=true；
   * - 记录在别的父任务上 → 拒绝（幂等键不能跨任务复用）；
   * - 未命中 → 正常走到下面的校验/写入。
   *
   * 真相源是 task.continuationRequests（随快照持久化 + restore 恢复），因此进程重启、
   * 快照恢复以及大量请求之后旧 requestId 仍然可查，绝不会被淘汰后追加新 attempt。
   */
  if (verdict.requestId !== undefined) {
    const recorded = task.continuationRequests?.[verdict.requestId];
    if (recorded !== undefined && recorded !== null && typeof recorded.result === "object") {
      return { ...cloneJson(recorded.result), duplicate: true };
    }
    const elsewhere = deps.store.continuationOwner(verdict.requestId);
    if (typeof elsewhere === "string" && elsewhere !== parentTaskId) {
      return { accepted: false, changed: false, reason: "duplicate_request_id", parentTaskId, requestId: verdict.requestId };
    }
    if (deps.store.continuationRequestBudgetExceeded(task)) {
      return { accepted: false, changed: false, reason: "request_budget_exceeded", parentTaskId, requestId: verdict.requestId };
    }
  }
  // 角色一致性：同一逻辑任务只允许同一专家角色续作。
  if (verdict.role !== task.role) {
    return { accepted: false, changed: false, reason: "role_mismatch", parentTaskId, role: verdict.role, expectedRole: task.role };
  }
  // 分片结构一致性：数量 + shardId 集合（顺序可不同，语义按 shardId 对齐）。
  if (verdict.shards.length !== task.shards.length) {
    return {
      accepted: false, changed: false, reason: "shard_count_mismatch", parentTaskId,
      expected: task.shards.length, received: verdict.shards.length,
    };
  }
  const expectedShardIds = task.shards.map((shard) => shard.shardId);
  const provided = new Map(verdict.shards.map((shard) => [shard.shardId, shard]));
  for (const shardId of expectedShardIds) {
    if (!provided.has(shardId)) {
      return { accepted: false, changed: false, reason: "shard_ids_mismatch", parentTaskId, missing: shardId };
    }
  }
  if (task.parentCancelRequested === true) {
    return { accepted: false, changed: false, reason: "parent_cancelled", parentTaskId };
  }
  // 忙碌判定：本轮 wait-all 尚未完成（任一分片最新 attempt 非终态）时拒绝，
  // 避免与运行中的 shard 竞争同一 child 的轮次。
  for (const shard of task.shards) {
    const latest = shard.attempts[shard.attempts.length - 1];
    if (latest === undefined || !isTerminalShardStatus(latest.status)) {
      return {
        accepted: false, changed: false, reason: "task_not_ready", parentTaskId,
        shardId: shard.shardId, shardStatus: shard.status, status: task.status,
      };
    }
  }
  /**
   * 停止 gate（票据 07）：上一轮已有 attempt 逻辑终态但执行未确认时拒绝续作。
   *
   * 续作会把新 prompt 投递给**同一个 child**：如果上一轮的 turn 还没真正结束，新一轮
   * 投递会与旧轮并发写同一路径。因此这里 fail-closed，并把未确认 attempt 摘要返回给
   * 调用方（Host 可据此等待/提交证据）。
   */
  const stopBlocked = [];
  for (const shard of task.shards) {
    const stopGate = deps.scheduler.stopGateVerdict(shard);
    if (stopGate !== null) stopBlocked.push(stopGate);
  }
  if (stopBlocked.length > 0) {
    return {
      accepted: false,
      changed: false,
      reason: "stop_unconfirmed",
      parentTaskId,
      shardId: stopBlocked[0].shardId,
      attempts: stopBlocked[0].attempts,
      shards: stopBlocked.map((entry) => ({ shardId: entry.shardId, attempts: entry.attempts })),
    };
  }
  // attempt 预算：**整体**判定（任一分片超限即整体拒绝），保证不会出现半写。
  // 判定走 attemptBudgetVerdict：retry / continue / restore resume 共用同一语义，
  // 避免某个入口把边界写成"新建前 >= limit"而放宽一档。
  for (const shard of task.shards) {
    const budget = deps.scheduler.attemptBudgetVerdict(
      shard,
      "shard " + shard.shardId,
      "该 shard 已耗尽多轮复用预算，请提交新的父任务或拆分工作",
    );
    if (budget !== null) {
      deps.events.noteBudgetViolation(budget.violation, "continue", { parentTaskId });
      return {
        accepted: false, changed: false, reason: budget.reason, parentTaskId,
        shardId: shard.shardId, violation: budget.violation,
      };
    }
  }

  // 全部校验通过后才修改状态：先构造本轮的全部 attempt，再统一提交（无半写）。
  const round = Number.isSafeInteger(task.round) && task.round >= 1 ? task.round + 1 : 2;
  const timestamp = deps.now();
  // 本轮显式给出的父任务默认超时立即成为任务级默认（票据 06）。
  // 它只影响本轮之后创建的 attempt；缺失时沿用既有默认值，绝不清空。
  if (verdict.timeoutMs !== undefined) task.timeoutMs = verdict.timeoutMs;
  const prepared = task.shards.map((shard) => {
    const previous = shard.attempts[shard.attempts.length - 1];
    const next = provided.get(shard.shardId);
    // 本轮分片规格里的显式超时成为该分片的新覆盖；缺失时保留原覆盖。
    // 新 attempt 的超时在 createAttempt 里按三级优先级重新解析一次。
    if (next.timeoutMs !== undefined) shard.timeoutMs = next.timeoutMs;
    return {
      shard,
      prompt: next.prompt,
      attempt: deps.scheduler.createAttempt(task, shard, previous.attempt + 1, {
        // 复用标记只存在于内存 attempt：冷恢复后原 child 可能已消失，恢复派发一律走 launcher（既有语义）。
        continuation: true,
        ...(typeof previous.childId === "string" && previous.childId.length > 0 ? { childId: previous.childId } : {}),
        // 续作沿用上一 attempt 的冻结路由快照（票据 04，只复制不重选）：缺失不补计划，非法由派发入口 fail-closed。
        ...(previous.route === void 0 ? {} : { route: previous.route }),
      }),
    };
  });
  for (const item of prepared) {
    item.shard.prompt = item.prompt;
    item.shard.attempts.push(item.attempt);
    // 复用是对取消的显式复活（与 retryShard 同语义）：清除该 shard 的取消标记，
    // 允许新一轮重新 admission。
    delete item.attempt.cancelRequested;
    item.shard.cancelRequested = false;
    deps.store.setShardStatus(task, item.shard, "queued", item.attempt);
    item.shard.updatedAt = timestamp;
  }
  task.basePrompt = verdict.basePrompt;
  task.round = round;
  task.status = "pending";
  task.settledAt = undefined;
  task.updatedAt = timestamp;
  for (const item of prepared) {
    deps.events.emitShardStatus(task, item.shard, "queued", item.attempt.attempt, {
      continuation: true,
      round,
      attemptCount: item.shard.attempts.length,
      ...(item.attempt.childId === undefined ? {} : { childId: item.attempt.childId }),
    });
  }
  const nextAttemptByShard = {};
  for (const item of prepared) nextAttemptByShard[item.shard.shardId] = item.attempt.attempt;
  deps.events.emit({
    type: "task_continued",
    parentTaskId,
    role: task.role,
    round,
    shardIds: expectedShardIds,
    nextAttemptByShard,
    counts: deps.store.computeCounts(task),
    ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
  });
  const result = {
    accepted: true,
    changed: true,
    parentTaskId,
    role: task.role,
    round,
    status: task.status,
    shardIds: expectedShardIds,
    nextAttemptByShard,
    ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
  };
  if (verdict.requestId !== undefined) {
    // 幂等记录写进**任务本体**（随快照持久化、restore 恢复）：不淘汰、不丢键。
    // 记录的是本次返回的完整 result 快照（深拷贝），因此重复请求能原样复现同一结果。
    task.continuationRequests = {
      ...(task.continuationRequests ?? {}),
      [verdict.requestId]: { result: cloneJson(result), recordedAt: timestamp },
    };
    deps.store.setContinuationOwner(verdict.requestId, parentTaskId);
  }
  deps.persistence.notifyPersistence();
  deps.scheduler.schedule();
  return result;
}

function cancelShard(s, deps, parentTaskId, shardId) {
  if (deps.gate.closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  if (deps.reclaim.current !== null) return reclaimInProgressResult(s, deps);
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
  const shard = task.shards.find((entry) => entry.shardId === shardId);
  if (shard === undefined) return { accepted: false, changed: false, reason: "unknown_shard" };

  const attempt = deps.store.activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
  if (isTerminalShardStatus(attempt.status)) {
    return {
      accepted: true,
      changed: false,
      shardStatus: shard.status,
      attempt: attempt.attempt,
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
    };
  }
  if (attempt.cancelRequested === true) {
    // 已接受过取消请求：幂等返回，不重复调用取消器。
    return {
      accepted: true,
      changed: false,
      shardStatus: shard.status,
      attempt: attempt.attempt,
      pending: true,
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
    };
  }
  attempt.cancelRequested = true;
  if (attempt.status === "queued") {
    settleShard(s, deps, task, shard, attempt, "cancelled", {
      error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 在排队阶段被取消" }, "shard 已取消"),
      reason: "shard_cancelled",
    });
    return {
      accepted: true,
      changed: true,
      shardStatus: shard.status,
      attempt: attempt.attempt,
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
    };
  }
  // running：先请求停止（把取消意图送达 child），再写逻辑终态；证据保持 unknown。
  deps.scheduler.requestShardCancellation(task, shard, attempt, "shard_cancelled");
  settleShard(s, deps, task, shard, attempt, "cancelled", {
    error: toShardError(
      { name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消，等待停止确认" },
      "shard 已取消",
    ),
    reason: "shard_cancelled",
  });
  return {
    accepted: true,
    changed: true,
    shardStatus: shard.status,
    attempt: attempt.attempt,
    pending: true,
    stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
    ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
    ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
  };
}

function cancelParent(s, deps, parentTaskId) {
  if (deps.gate.closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  if (deps.reclaim.current !== null) return reclaimInProgressResult(s, deps);
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
  /**
   * 只有"逻辑终态 **且** 停止已确认"才算真正结算。
   *
   * 旧判定只看逻辑终态，会把"终态但停止未确认"（任务仍是 pending、仍占着影响范围）
   * 误判为已结算，从而吞掉取消意图；新判定让这类任务继续走下面的取消登记，等证据到达
   * 后由聚合自然收敛为 cancelled。
   */
  const allTerminal = task.shards.every((shard) => {
    const attempt = shard.attempts[shard.attempts.length - 1];
    return attempt !== undefined && isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
  });
  if (allTerminal) {
    // 已结算父任务的取消请求是幂等 no-op，不能再写入 parentCancelRequested 或重复发布聚合事件。
    return {
      accepted: true,
      changed: false,
      taskStatus: task.status,
      cancelledShardIds: [],
      cancellingShardIds: [],
      alreadyTerminalShardIds: task.shards.map((shard) => shard.shardId),
    };
  }
  task.parentCancelRequested = true;
  const cancelledShardIds = [];
  const cancellingShardIds = [];
  const alreadyTerminalShardIds = [];
  for (const shard of task.shards) {
    const attempt = deps.store.activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
    if (isTerminalShardStatus(attempt.status)) {
      alreadyTerminalShardIds.push(shard.shardId);
      continue;
    }
    if (attempt.cancelRequested === true) {
      // 已经接受过取消请求的 shard 不再重复请求取消器。
      alreadyTerminalShardIds.push(shard.shardId);
      continue;
    }
    attempt.cancelRequested = true;
    // 在 shard 上留父级取消标记：retryShard 只有显式清除它才允许重新 admission。
    shard.cancelRequested = true;
    if (attempt.status === "queued") {
      // queued 直接进入 cancelled，永不 admission。
      cancelledShardIds.push(shard.shardId);
      settleShard(s, deps, task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "父任务取消，排队 shard 未 admission" }, "shard 已取消"),
        reason: "parent_cancelled",
      });
    } else {
      /**
       * running：先请求停止，再立即写逻辑终态（票据 07）。
       *
       * 与旧实现的关键差异：旧实现只把取消意图传给 child，等 completion 回调才收敛；
       * 一旦 child 永不回调（进程卡死/句柄丢失），父任务会永久停在 running。新语义下
       * 逻辑状态立刻收敛为 cancelled + stopEvidence=unknown，父任务保持 pending 直到
       * 权威停止证据到达——既不阻塞取消语义，也不谎称执行已停止。
       */
      cancellingShardIds.push(shard.shardId);
      deps.scheduler.requestShardCancellation(task, shard, attempt, "parent_cancelled");
      settleShard(s, deps, task, shard, attempt, "cancelled", {
        error: toShardError(
          { name: "ShardCancelledError", reason: "cancelled", message: "父任务取消，等待停止确认" },
          "shard 已取消",
        ),
        reason: "parent_cancelled",
      });
    }
  }
  aggregateTask(s, deps, task);
  deps.persistence.notifyPersistence();
  deps.scheduler.schedule();
  return {
    accepted: true,
    changed: cancelledShardIds.length > 0 || cancellingShardIds.length > 0,
    taskStatus: task.status,
    cancelledShardIds,
    cancellingShardIds,
    alreadyTerminalShardIds,
  };
}

function retryShard(s, deps, parentTaskId, shardId) {
  if (deps.gate.closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
  if (deps.reclaim.current !== null) return reclaimInProgressResult(s, deps);
  const task = deps.store.taskById(parentTaskId);
  if (task === undefined) return { accepted: false, reason: "unknown_parent_task" };
  const shard = task.shards.find((entry) => entry.shardId === shardId);
  if (shard === undefined) return { accepted: false, reason: "unknown_shard" };
  const previous = shard.attempts[shard.attempts.length - 1];
  const retryable = previous.status === "failed"
    || previous.status === "timed_out"
    || previous.status === "cancelled"
    || previous.status === "interrupted";
  if (!retryable) return { accepted: false, reason: "not_retryable", shardStatus: shard.status, attempt: previous.attempt };

  /**
   * 停止 gate（票据 07）：只要该 shard 还有 attempt 未确认停止，就绝不创建新 attempt。
   *
   * 原因：超时/取消 attempt 未停止时重试，旧 child 仍可能在写同一批路径；新 attempt
   * 一旦开始，两个执行体就会并发写。拒绝路径只读不写——不追加 attempt、不改状态、
   * 不发事件，调用方拿到未确认 attempt 摘要后可以提交证据或转人工。
   *
   * 判定必须先于 attempt 预算：预算耗尽与"停止未确认"同时成立时，真正阻塞执行的是
   * 后者（补预算不会让执行变安全），返回 stop_unconfirmed 才有可操作的处置方向。
   */
  const stopGate = deps.scheduler.stopGateVerdict(shard);
  if (stopGate !== null) {
    return {
      accepted: false,
      changed: false,
      reason: "stop_unconfirmed",
      shardId: shard.shardId,
      shardStatus: shard.status,
      attempt: previous.attempt,
      attempts: stopGate.attempts,
    };
  }

  // attempt 数量预算：attempt 历史随重试无界增长（每个 attempt 都会进快照与事件），
  // 因此超限必须结构化失败且不新建 attempt。判定走 attemptBudgetVerdict（与
  // continue / restore resume 同源），判定的是"新建后的 attempt 数"（+1），
  // 这样恰好允许 maxAttemptsPerShard 个 attempt 存在。
  const attemptBudget = deps.scheduler.attemptBudgetVerdict(
    shard,
    "attempt",
    "该 shard 已耗尽重试预算，请提交新的父任务或拆分工作",
  );
  if (attemptBudget !== null) {
    deps.events.noteBudgetViolation(attemptBudget.violation, "retry", { parentTaskId });
    return {
      accepted: false,
      changed: false,
      reason: attemptBudget.reason,
      shardStatus: shard.status,
      attempt: previous.attempt,
      violation: attemptBudget.violation,
    };
  }

  const nextAttempt = previous.attempt + 1;
  // 重试沿用分片/任务级超时配置，并重新读取一次当前角色默认值（票据 06）：
  // 新 attempt 按三级优先级解析，已经结束的旧 attempt 历史不受影响。
  const attempt = deps.scheduler.createAttempt(task, shard, nextAttempt);
  shard.attempts.push(attempt);
  // 手工重试是对取消的显式复活：清除该 shard 的取消请求标记，允许重新 admission。
  // 父任务的 parentCancelRequested 保持不变，剩余 queued shard 仍然不会自动派发。
  delete attempt.cancelRequested;
  shard.cancelRequested = false;
  deps.scheduler.updateShardStatus(task, shard, "queued");
  // 复活了一个非终态 shard，父任务立即回到 pending（不发布 task_settled 之外的新终态事件）。
  task.status = "pending";
  task.settledAt = undefined;
  deps.events.emitShardStatus(task, shard, "queued", nextAttempt, { retryOf: previous.attempt });
  deps.persistence.notifyPersistence();
  deps.scheduler.schedule();
  return { accepted: true, attempt: nextAttempt, shardStatus: shard.status, previousStatus: previous.status };
}

function shardCapabilities(s, deps, shard) {
  const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
  const latest = attempts.length === 0 ? undefined : attempts[attempts.length - 1];
  const shardId = typeof shard?.shardId === "string" && shard.shardId.length > 0 ? shard.shardId : null;
  // 取消：queued/running（含 stop 未确认但已逻辑终态之外的形态）可取消；终态不再提供入口。
  const cancel = latest === undefined
    ? { allowed: false, reason: "not_supported" }
    : isTerminalShardStatus(latest.status)
      ? { allowed: false, reason: "already_terminal" }
      : { allowed: true };
  /**
   * 重试：只允许四类可重试终态。
   * - 未终态 → task_not_terminal（还可能自然结束，不应引导重试）；
   * - 成功 → no_retryable_shard（没有可重试的失败面）；
   * - 停止未确认 → stop_unconfirmed（新 attempt 会与旧执行体并发写）；
   * - attempt 预算耗尽 → attempt_limit（再点只会被 manager 拒绝）。
   */
  let retry;
  if (latest === undefined) {
    retry = { allowed: false, reason: "no_retryable_shard" };
  } else if (!isTerminalShardStatus(latest.status)) {
    retry = { allowed: false, reason: "task_not_terminal" };
  } else if (!RETRYABLE_SHARD_STATUSES.has(latest.status)) {
    retry = { allowed: false, reason: "no_retryable_shard" };
  } else if (deps.scheduler.stopGateVerdict(shard) !== null) {
    retry = { allowed: false, reason: "stop_unconfirmed" };
  } else if (deps.scheduler.attemptBudgetVerdict(shard, "attempt", "该 shard 已耗尽重试预算") !== null) {
    retry = { allowed: false, reason: "attempt_limit" };
  } else {
    retry = { allowed: true };
  }
  return { shardId, cancel, retry };
}

function taskFullySettled(s, deps, task) {
  if (task.shards.length === 0) return typeof task.settledAt === "number";
  return task.shards.every((shard) => {
    const attempt = shard.attempts[shard.attempts.length - 1];
    return attempt !== undefined && isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
  });
}

function taskCancelCapability(s, deps, task) {
  return taskFullySettled(s, deps, task)
    ? { allowed: false, reason: "already_terminal" }
    : { allowed: true };
}

function taskRetryCapability(s, deps, shardCaps) {
  if (shardCaps.some((caps) => caps.retry.allowed === true)) return { allowed: true };
  const reasons = new Set(shardCaps.map((caps) => caps.retry.reason));
  for (const reason of ["stop_unconfirmed", "attempt_limit", "task_not_terminal", "no_retryable_shard"]) {
    if (reasons.has(reason)) return { allowed: false, reason };
  }
  return { allowed: false, reason: "no_retryable_shard" };
}

function taskContinueCapability(s, deps, task) {
  if (task.parentCancelRequested === true) return { allowed: false, reason: "parent_cancelled" };
  for (const shard of task.shards) {
    const latest = shard.attempts[shard.attempts.length - 1];
    if (latest === undefined || !isTerminalShardStatus(latest.status)) {
      return { allowed: false, reason: "task_not_terminal" };
    }
  }
  for (const shard of task.shards) {
    if (deps.scheduler.stopGateVerdict(shard) !== null) return { allowed: false, reason: "stop_unconfirmed" };
  }
  for (const shard of task.shards) {
    if (deps.scheduler.attemptBudgetVerdict(shard, "attempt", "该 shard 已耗尽多轮复用预算") !== null) {
      return { allowed: false, reason: "attempt_limit" };
    }
  }
  return { allowed: true };
}

function taskCapabilities(s, deps, parentTaskId) {
  const taskId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";
  const missing = () => ({
    parentTaskId: taskId,
    read: { allowed: false, reason: "task_not_found" },
    cancel: { allowed: false, reason: "task_not_found" },
    retry: { allowed: false, reason: "task_not_found" },
    continue: { allowed: false, reason: "task_not_found" },
    shards: {},
  });
  if (deps.gate.closed || taskId.length === 0) return missing();
  const task = deps.store.taskById(taskId);
  if (task === undefined) return missing();
  const shardCaps = task.shards.map((arg0) => shardCapabilities(s, deps, arg0));
  const shards = {};
  for (const caps of shardCaps) {
    if (caps.shardId === null) continue;
    shards[caps.shardId] = { cancel: caps.cancel, retry: caps.retry };
  }
  return {
    parentTaskId: taskId,
    read: { allowed: true },
    cancel: taskCancelCapability(s, deps, task),
    retry: taskRetryCapability(s, deps, shardCaps),
    continue: taskContinueCapability(s, deps, task),
    shards,
  };
}

function getTask(s, deps, parentTaskId) {
  const task = deps.store.taskById(parentTaskId);
  return task === undefined ? null : cloneJson(deps.store.taskSnapshot(task));
}

function listTasks(s, deps) {
  return cloneJson([...deps.store.allTasks()].map((task) => deps.store.taskSnapshot(task)));
}

function getCounts(s, deps, parentTaskId) {
  const task = deps.store.taskById(parentTaskId);
  return task === undefined ? null : cloneJson(deps.store.computeCounts(task));
}

export function createTaskCommands({ store, limits, scheduler, events, persistence, agents, clock, ownerGate }) {
  const { gate, reclaim } = ownerGate;
  const ledger = events;
  const limitConfig = limits.limitConfig;
  const batch = persistence;
  const { now, setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn } = clock;
  const { launcher, continuer, canceller } = agents;
  const s = Object.freeze({});
  const deps = { store, limits, scheduler, events, persistence, gate, reclaim, ledger, limitConfig, batch, now, setTimeoutFn, clearTimeoutFn, launcher, continuer, canceller };

  return Object.freeze({
    rejectSettlement: rejectSettlement.bind(null, s, deps),
    reclaimInProgressResult: reclaimInProgressResult.bind(null, s, deps),
    taskReclaimedResult: taskReclaimedResult.bind(null, s, deps),
    settleShard: settleShard.bind(null, s, deps),
    admissionEvidence: admissionEvidence.bind(null, s, deps),
    completionEvidence: completionEvidence.bind(null, s, deps),
    lateCompletionEvidence: lateCompletionEvidence.bind(null, s, deps),
    isShutdownCompletionError: isShutdownCompletionError.bind(null, s, deps),
    launchFailure: launchFailure.bind(null, s, deps),
    settleLaunchFailure: settleLaunchFailure.bind(null, s, deps),
    errorInstinctPayload: errorInstinctPayload.bind(null, s, deps),
    completeShard: completeShard.bind(null, s, deps),
    failShard: failShard.bind(null, s, deps),
    aggregateTask: aggregateTask.bind(null, s, deps),
    submit: submit.bind(null, s, deps),
    continueTask: continueTask.bind(null, s, deps),
    cancelShard: cancelShard.bind(null, s, deps),
    cancelParent: cancelParent.bind(null, s, deps),
    retryShard: retryShard.bind(null, s, deps),
    shardCapabilities: shardCapabilities.bind(null, s, deps),
    taskFullySettled: taskFullySettled.bind(null, s, deps),
    taskCancelCapability: taskCancelCapability.bind(null, s, deps),
    taskRetryCapability: taskRetryCapability.bind(null, s, deps),
    taskContinueCapability: taskContinueCapability.bind(null, s, deps),
    taskCapabilities: taskCapabilities.bind(null, s, deps),
    getTask: getTask.bind(null, s, deps),
    listTasks: listTasks.bind(null, s, deps),
    getCounts: getCounts.bind(null, s, deps),
  });
}
