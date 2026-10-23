/**
 * fan-out 恢复（R3-14：从 fanout/state.js 的 restore 段整段迁出）。
 *
 * ## 职责（票据 14 / plan §3 R3）
 * restore 被拆成**两个**函数（原单函数 193 行，函数门槛 200 但语义上是两段）：
 * - buildRestorePlan(deps, snapshot, options)：只做校验、归一化与计划组装，不改任何状态；
 * - commitRestorePlan(deps, plan)：把已校验计划一次性写入（状态 owner 的唯一提交点）。
 * state owner 仍以 owner.commitRestorePlan 暴露该原子能力，restore 的对外入口是 state.restore。
 *
 * ## 状态所有权（C5）
 * 本模块**不持有**运行期可变状态：只读 plan / 快照输入，并通过 deps 中的窄命令写：
 *   setRestoringSnapshot / setRestoreDispatchSuppressed（生命周期闸门归 state owner）、
 *   store / ledger / limitConfig / boundScheduler / boundCommands（各自的 owner）。
 * 因此不存在第二份 restore 状态，也没有整包 state / Map / Set 跨模块传递。
 *
 * ## 迁移说明（R3-14）
 * 纯搬迁：校验顺序、错误码、原子提交语义、事件裁剪口径与代次种子全部逐行不变；
 * 仅把「读 s.closed / 写 s.restoringSnapshot、s.restoreDispatchSuppressed」替换为 deps 命令，
 * 并把原 restore() 尾部对 commitRestorePlan 的直接调用改成「返回计划」。
 *
 * @module dsh-expert-group/fanout/restore
 */
import { FANOUT_BUDGET, checkRestoreBudget, describeBudgetViolation } from "../resource-budget.js";
import { validateRestoredStopFields, validateRestoredTimeoutMs } from "./contracts.js";
import {
  FANOUT_TASK_STATUSES,
  PROCESS_INSTANCE,
  SHARD_STATUS_SET,
  SNAPSHOT_VERSION,
  STOP_EVIDENCE_BOUNDARIES,
  STOP_EVIDENCE_STATE_OBSERVED,
  STOP_EVIDENCE_STATE_UNKNOWN,
  TIMEOUT_PROJECTION_VERSION,
  isTerminalShardStatus,
} from "./errors.js";
import {
  FanoutValidationError,
  cloneJson,
  createWriteRoleConflictChecker,
  deriveAttemptId,
  isStopObserved,
  normalizeProviderLimits,
  normalizeRoleLimits,
  normalizeWriteRoles,
  toShardError,
  validateConcurrencyLimit,
  validateShardName,
  validationError,
} from "./validation.js";

/** 预算策略：与迁移前同源，默认全部取自 resource-budget.js 的冻结值。 */
const budgetPolicy = FANOUT_BUDGET;

export function validateRestoreTasks(deps, tasks) {
  let restoredMaxGeneration = 0;
  for (const task of tasks) {
    if (task === null || typeof task !== "object" || typeof task.parentTaskId !== "string" || task.parentTaskId.length === 0) {
      throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 parentTaskId", { field: "tasks" });
    }
    if (typeof task.role !== "string" || !Array.isArray(task.shards)) {
      throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 role/shards: " + task.parentTaskId, { field: "tasks" });
    }
    // provider 归属（票据 26）：存在时必须是可用的非空字符串；缺失是合法的（旧快照
    // 或角色未配置主模型），恢复后保持 undefined，provider 限流对它不生效。
    if (task.provider !== undefined && (typeof task.provider !== "string" || task.provider.trim().length === 0)) {
      throw new FanoutValidationError(
        "INVALID_SNAPSHOT",
        "快照任务 provider 必须是非空字符串: " + task.parentTaskId,
        { field: "tasks.provider" },
      );
    }
    if (task.status !== undefined && !FANOUT_TASK_STATUSES.includes(task.status)) {
      throw new FanoutValidationError(
        "INVALID_SNAPSHOT_STATUS",
        "快照任务状态非法: " + String(task.status),
        { field: "tasks.status", status: task.status },
      );
    }
    if (task.concurrencyLimit !== undefined) {
      const check = validateConcurrencyLimit(task.concurrencyLimit);
      if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "tasks.concurrencyLimit" });
    }
    // 超时（票据 06）：恢复路径对历史正有限值兼容（不做整秒收紧），
    // 但结构上必须是「0 或正有限数」——否则就是一份无法解释的快照。
    if (task.timeoutMs !== undefined) {
      const check = validateRestoredTimeoutMs(task.timeoutMs, "tasks.timeoutMs");
      if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "tasks.timeoutMs" });
    }
    // continuation 幂等记录（外部持久化输入）：结构必须严格合法，否则整体拒绝——
    // 静默丢弃会让「曾经续作过的 requestId」在恢复后被当成新请求而重复追加 attempt。
    if (task.continuationRequests !== undefined) {
      const requests = task.continuationRequests;
      if (requests === null || typeof requests !== "object" || Array.isArray(requests)) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 continuationRequests 必须是对象: " + task.parentTaskId, { field: "tasks.continuationRequests" });
      }
      const keys = Object.keys(requests);
      if (keys.length > budgetPolicy.maxAttemptsPerShard) {
        // 这条也是预算拒绝：补齐结构化 violation（旧实现只给 code/field），
        // 让 Host 能像其它恢复超限一样补发统一 budget 事件。
        const violation = describeBudgetViolation({
          resource: "attempts",
          limit: budgetPolicy.maxAttemptsPerShard,
          receivedBytes: keys.length,
          recoverable: false,
          subject: task.parentTaskId,
          hint: "快照中的 continuationRequests 条数超过 attempt 预算，请清理该任务的历史请求",
        });
        deps.events.noteBudgetViolation(violation, "restore", { emitEvent: false });
        throw new FanoutValidationError(
          "INVALID_BUDGET",
          "快照 continuationRequests 条数超过预算: " + task.parentTaskId,
          { field: "tasks.continuationRequests", violation },
        );
      }
      for (const requestId of keys) {
        const entry = requests[requestId];
        if (requestId.length === 0 || entry === null || typeof entry !== "object" || Array.isArray(entry)
          || entry.result === null || typeof entry.result !== "object" || Array.isArray(entry.result)) {
          throw new FanoutValidationError(
            "INVALID_SNAPSHOT",
            "快照 continuationRequests 记录非法: " + task.parentTaskId,
            { field: "tasks.continuationRequests" },
          );
        }
      }
    }
    for (let shardIndex = 0; shardIndex < task.shards.length; shardIndex += 1) {
      const shard = task.shards[shardIndex];
      const shardField = "tasks.shards[" + shardIndex + "]";
      if (shard === null || typeof shard !== "object" || typeof shard.shardId !== "string" || !Array.isArray(shard.attempts)) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 shard 结构非法: " + task.parentTaskId, { field: shardField });
      }
      const nameVerdict = validateShardName(shard.name, shardField + ".name");
      if (!nameVerdict.ok) throw validationError(nameVerdict);
      if (shard.status !== undefined && !SHARD_STATUS_SET.has(shard.status)) {
        throw new FanoutValidationError(
          "INVALID_SNAPSHOT_STATUS",
          "快照 shard 状态非法: " + String(shard.status),
          { field: shardField + ".status", status: shard.status },
        );
      }
      // 分片级超时同样按恢复语义校验：旧快照的任意正有限值必须可恢复。
      if (shard.timeoutMs !== undefined) {
        const check = validateRestoredTimeoutMs(shard.timeoutMs, shardField + ".timeoutMs");
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: shardField + ".timeoutMs" });
      }
      for (let attemptIndex = 0; attemptIndex < shard.attempts.length; attemptIndex += 1) {
        const rawAttempt = shard.attempts[attemptIndex];
        const attemptField = shardField + ".attempts[" + attemptIndex + "]";
        if (rawAttempt === null || typeof rawAttempt !== "object" || Array.isArray(rawAttempt)) {
          throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 attempt 结构非法: " + task.parentTaskId, { field: attemptField });
        }
        if (rawAttempt.status !== undefined && !SHARD_STATUS_SET.has(rawAttempt.status)) {
          throw new FanoutValidationError(
            "INVALID_SNAPSHOT_STATUS",
            "快照 attempt 状态非法: " + String(rawAttempt.status),
            { field: attemptField + ".status", status: rawAttempt.status },
          );
        }
        // 追加 attempt 前，旧 attempt 必须已经终态；否则恢复会把非法历史静默变成可派发队列。
        if (attemptIndex < shard.attempts.length - 1
          && rawAttempt.status !== undefined
          && !isTerminalShardStatus(rawAttempt.status)) {
          throw new FanoutValidationError(
            "INVALID_SNAPSHOT_TRANSITION",
            "快照 attempt 历史包含未终态转移: " + task.parentTaskId,
            { field: attemptField + ".status", status: rawAttempt.status },
          );
        }
        // 停止证据字段（票据 07）：结构非法整体拒绝，绝不静默降级。
        const stopFieldsVerdict = validateRestoredStopFields(rawAttempt, attemptField);
        if (!stopFieldsVerdict.ok) throw validationError(stopFieldsVerdict);
        // 代次种子：即使 attemptId/generation 缺失（旧快照）也要把派生值计入上界，
        // 保证恢复后新建的 attempt 代次严格大于所有历史值。
        const candidateGeneration = Number.isSafeInteger(rawAttempt.executionGeneration)
          ? rawAttempt.executionGeneration
          : (Number.isInteger(rawAttempt.attempt) && rawAttempt.attempt > 0 ? rawAttempt.attempt : attemptIndex + 1);
        if (candidateGeneration > restoredMaxGeneration) restoredMaxGeneration = candidateGeneration;
      }
    }
  }
  return restoredMaxGeneration;
}

/**
 * 校验并归一化快照里的配置字段（**不改状态**，失败即抛，保证不产生半套配置）。
 *
 * 从 buildRestorePlan 原样提出（R3-14 内的函数级拆分）：调用点仍是「逐任务结构校验之后、
 * 计划组装之前」，抛错顺序与错误码逐项不变。
 *
 * @param {object} deps - 构造期注入的协作面（limitConfig / store.conflictConfig）。
 * @param {object} snapshot - 已通过形状校验的快照。
 * @returns {object} 五项已校验的配置值：defaultConcurrencyLimit / roleLimits / providerLimits /
 *   writeRoles / defaultAllowOverlap（后两者来自 conflictConfig 的当前值或快照覆盖）。
 */
function resolveRestoredConfig(deps, snapshot) {
  // 配置必须沿用创建 manager 时的校验边界；所有字段先完成校验，再一次性替换，
  // 避免半个快照生效后把当前 manager 留在不可用状态。
  //
  // 并发来源模型（票据 03「并发来源修复」）：
  // - 构造期注入了 live 解析函数：resolverSource 永远是 live。快照里的
  //   defaultConcurrencyLimit 只是诊断负载，**不得**覆盖当前设置——否则一次重启就会
  //   把 live settings 永久旁路（本票据修复的缺陷）；
  // - 没有 live resolver：进程读不到"当前设置"，冻结快照值（或构造默认值）并在诊断
  //   里标注 snapshot；
  // - 旧快照没有 concurrencySource 标记时按同一规则"尽量 live"：有 resolver 就 live，
  //   没有才冻结。标记只服务外部读者/诊断，不改变恢复决策。
  // 任务级 concurrencyLimit 不受这里影响：它始终优先，且由 task.concurrencyLimit 固化。
  const restoredDefaultConcurrencyLimit = snapshot.defaultConcurrencyLimit === undefined
    ? deps.limitConfig.defaultConcurrencyLimit
    : (() => {
        const check = validateConcurrencyLimit(snapshot.defaultConcurrencyLimit);
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "defaultConcurrencyLimit" });
        return check.value;
      })();
  const restoredRoleLimits = snapshot.roleLimits === undefined
    ? deps.limitConfig.roleLimits
    : normalizeRoleLimits(snapshot.roleLimits);
  // provider 级映射与 roleLimits 同一来源模型（票据 26）：结构非法时整体拒绝
  // 快照，绝不静默降级成「不限制」——那会把用户明确配置的名额悄悄放开。
  const restoredProviderLimits = snapshot.providerLimits === undefined
    ? deps.limitConfig.providerLimits
    : normalizeProviderLimits(snapshot.providerLimits);
  if (snapshot.writeRoles !== undefined
    && snapshot.writeRoles !== null
    && !Array.isArray(snapshot.writeRoles)
    && typeof snapshot.writeRoles !== "string") {
    throw new FanoutValidationError("INVALID_WRITE_ROLES", "快照 writeRoles 必须是字符串数组", { field: "writeRoles" });
  }
  if (Array.isArray(snapshot.writeRoles) && snapshot.writeRoles.some((role) => typeof role !== "string")) {
    throw new FanoutValidationError("INVALID_WRITE_ROLES", "快照 writeRoles 必须是字符串数组", { field: "writeRoles" });
  }
  const restoredWriteRoles = snapshot.writeRoles === undefined
    ? deps.store.conflictConfig.writeRoles
    : normalizeWriteRoles(snapshot.writeRoles);
  const restoredDefaultAllowOverlap = snapshot.defaultAllowOverlap === undefined
    ? deps.store.conflictConfig.defaultAllowOverlap
    : (() => {
        if (typeof snapshot.defaultAllowOverlap !== "boolean") {
          throw new FanoutValidationError("INVALID_ALLOW_OVERLAP", "快照 defaultAllowOverlap 必须是布尔值", { field: "defaultAllowOverlap" });
        }
        return snapshot.defaultAllowOverlap;
      })();
  return {
    restoredDefaultConcurrencyLimit,
    restoredRoleLimits,
    restoredProviderLimits,
    restoredWriteRoles,
    restoredDefaultAllowOverlap,
  };
}


/**
 * 组装恢复计划（**不改任何状态**）。
 *
 * 顺序与迁移前完全一致：闸门判定 → 快照形状 → 事件形状 → 规模预算 → 停止证据边界解析
 * → 逐任务结构校验 → 配置校验与归一化 → 事件裁剪/升序 → 计划。任何校验失败都在这里
 * 抛出，因此「非法快照不得产生部分提交」由「提交侧只在计划完整时被调用」保证。
 *
 * @param {object} deps - 构造期注入的协作面（isClosed / reclaimInProgress / store / events /
 *   limitConfig / boundCommands 等只读或窄命令）。
 * @param {object} snapshot - 外部持久化输入（未校验）。
 * @param {object} [restoreOptions] - resume / merge / stopEvidenceBoundary。
 * @returns {object} accepted:false 时 result 是两道闸门（已关闭 / 回收进行中）的原样返回；
 *   accepted:true 时 plan 是已校验的提交计划。其余失败一律抛结构化错误。
 */
export function buildRestorePlan(deps, snapshot, restoreOptions = {}) {
  if (deps.isClosed()) {
    return {
      accepted: false,
      result: { accepted: false, restored: 0, tasks: 0, code: "MANAGER_CLOSED", reason: "manager_closed" },
    };
  }
  // 回收屏障期间恢复会重建/覆盖任务表，直接破坏候选快照的一致性。
  if (deps.reclaimInProgress()) {
    return { accepted: false, result: { ...deps.boundCommands.reclaimInProgressResult(), restored: 0, tasks: 0 } };
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new FanoutValidationError("INVALID_SNAPSHOT", "restore 需要快照对象");
  }
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new FanoutValidationError("UNSUPPORTED_SNAPSHOT_VERSION", "不支持的快照版本: " + String(snapshot.version), { field: "version" });
  }
  if (!Array.isArray(snapshot.tasks)) {
    throw new FanoutValidationError("INVALID_SNAPSHOT", "快照缺少 tasks 数组", { field: "tasks" });
  }
  if (snapshot.events !== undefined && (!Array.isArray(snapshot.events) || snapshot.events.some((event) => (
    event === null || typeof event !== "object" || Array.isArray(event)
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1
  )))) {
    throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 deps.events 必须是带正序列号的对象数组", { field: "deps.events" });
  }
  // 规模预算先于逐项结构校验：超限的恢复输入必须给出 BUDGET_EXCEEDED（可定位到资源），
  // 而不是先被结构/历史转移校验拦成另一个错误。这里仍在任何状态修改与 clone 之前。
  // 外部持久化输入的规模预算：必须在任何状态修改与大规模 clone 之前判定。
  // 超限即原子失败（tasks/eventHistory/配置全部保持不变），并给出可定位的违规。
  const restoreBudget = checkRestoreBudget(snapshot, {
    existingTasks: restoreOptions.merge === true ? deps.store.taskTableSize() : 0,
    maxBytes: budgetPolicy.maxSnapshotBytes,
  });
  if (!restoreBudget.ok) {
    // restore 发生在 manager 状态恢复之前，且既有契约要求"超预算恢复原子失败、
    // 不写 eventHistory"。因此这里只记录 lastViolation（emitEvent:false），由 Host
    // 捕获结构化错误后调用 recordBudgetViolation() 补发 budget_rejected(phase=restore)。
    deps.events.noteBudgetViolation(restoreBudget.violation, "restore", { emitEvent: false });
    throw validationError({
      ok: false,
      code: "INVALID_BUDGET",
      message: restoreBudget.violation.message,
      field: "snapshot",
      violation: restoreBudget.violation,
    });
  }

  /**
   * 停止证据边界（票据 07）：决定"快照里未确认停止的 attempt"在恢复后怎么处理。
   *
   * 解析规则（显式优先，否则按进程身份自动判定）：
   * - 显式 stopEvidenceBoundary：调用方明确知道恢复语义时使用；非法值结构化拒绝。
   * - 自动：快照 processInstance 与当前进程相同 → unknown（进程内重建，不证明旧 child
   *   已停止）；不同或缺失（旧版本/旧进程快照）→ process-restart（规格允许的唯一其他
   *   释放边界）。缺失不能当成"同进程"：旧版本快照没有该字段，其执行体属于未知进程，
   *   只能按进程已终止处理，否则恢复后的任务会永久 pending 且无法自动收敛。
   *
   * 两种边界的语义：
   * - unknown：running -> interrupted/unknown，历史终态但无证据的一律保持 unknown 并
   *   标记 legacy；影响范围继续占用，任务保持 pending，重试/续作/续跑全部被
   *   stop_unconfirmed 挡住，直到 Host 提交证据。
   * - process-restart：快照内 attempt 一律 observed(source="process-restart")。
   */
  const explicitStopEvidenceBoundary = restoreOptions?.stopEvidenceBoundary === undefined
    || restoreOptions?.stopEvidenceBoundary === null
    ? undefined
    : restoreOptions.stopEvidenceBoundary;
  if (explicitStopEvidenceBoundary !== undefined
    && !STOP_EVIDENCE_BOUNDARIES.includes(explicitStopEvidenceBoundary)) {
    throw new FanoutValidationError(
      "INVALID_STOP_EVIDENCE_BOUNDARY",
      "stopEvidenceBoundary 必须是 " + STOP_EVIDENCE_BOUNDARIES.join(" / ") + " 之一",
      { field: "stopEvidenceBoundary" },
    );
  }
  const snapshotProcessInstance = typeof snapshot.processInstance === "string" && snapshot.processInstance.length > 0
    ? snapshot.processInstance
    : undefined;
  const stopEvidenceBoundary = explicitStopEvidenceBoundary ?? (
    snapshotProcessInstance !== undefined && snapshotProcessInstance === PROCESS_INSTANCE
      ? "unknown"
      : "process-restart"
  );
  const stopEvidenceBoundarySource = explicitStopEvidenceBoundary !== undefined
    ? "explicit"
    : "process-instance";
  /**
   * 本次恢复实际落到各任务上的边界集合。
   *
   * 大多数快照的任务边界一致；但 Host 会把"root 未到达"的任务延迟恢复，并在持久化
   * 投影里把旧任务与新进程快照合并。这类被延迟的任务会携带**来源进程**的
   * task.processInstance（见 Host 的 deferTask 投影），因此边界必须按任务解析：
   * 同一个快照里可能同时存在"本进程重建的任务"和"上一进程遗留的任务"。
   */
  // 恢复后新建 attempt 的代次必须大于全部历史代次（迟到证据隔离）。

  const restoredMaxGeneration = validateRestoreTasks(deps, snapshot.tasks);

  // 配置必须沿用创建 manager 时的校验边界；所有字段先完成校验，再一次性替换，
  // 避免半个快照生效后把当前 manager 留在不可用状态（口径见 resolveRestoredConfig）。
  const {
    restoredDefaultConcurrencyLimit,
    restoredRoleLimits,
    restoredProviderLimits,
    restoredWriteRoles,
    restoredDefaultAllowOverlap,
  } = resolveRestoredConfig(deps, snapshot);

  /**
   * 提交阶段：所有校验已完成。这里只组装「提交计划」，实际改写全部交给状态 owner 的
   * commitRestorePlan（原子提交：失败不产生部分提交，任务表/事件历史/配置都不留半成品）。
   */
  const resume = restoreOptions.resume === true;
  const merge = restoreOptions.merge === true;
  /**
   * 超时投影兼容（票据 06）：
   * - 新快照带 timeoutProjection 标记：分片覆盖只认 rawShard.timeoutMs（缺失 = 无覆盖）；
   * - 旧快照无标记：继续用最新 attempt 的 timeoutMs 反推分片覆盖。
   *   旧语义下 attempt.timeoutMs 恒等于 shard.timeoutMs，因此这是一致的历史恢复；
   *   新语义下 attempt.timeoutMs 可能来自父任务/角色默认值，所以新快照必须禁止反推。
   */
  const projectsShardTimeout = snapshot.timeoutProjection === TIMEOUT_PROJECTION_VERSION;
  // 快照事件在计划组装阶段一次读完：克隆/按条数预算裁剪/升序，提交侧不再触碰原始数组。
  // 裁剪丢掉的条数属于 gap 事实（不是静默丢失），随计划交给提交侧累加。
  const restoredEvents = Array.isArray(snapshot.events)
    ? snapshot.events.slice(-budgetPolicy.maxEventHistory).map((event) => cloneJson(event))
    : [];
  // 恢复输入可能是乱序（外部磁盘/旧版本）：按 sequence 升序落历史，既保证
  // earliestAvailableSequence 是真正的最旧一条，也让裁剪可以安全地从队首丢弃。
  restoredEvents.sort((left, right) => left.sequence - right.sequence);
  const droppedEvents = Array.isArray(snapshot.events) && snapshot.events.length > restoredEvents.length
    ? snapshot.events.length - restoredEvents.length
    : 0;
  return {
    accepted: true,
    plan: {
      // 已校验的快照输入与恢复决定（只读）。
      rawTasks: snapshot.tasks,
      snapshot,
      snapshotProcessInstance,
      explicitStopEvidenceBoundary,
      stopEvidenceBoundary,
      stopEvidenceBoundarySource,
      restoredMaxGeneration,
      // 校验并归一化后的配置：一次性写入，写坏不了半套。
      restoredDefaultConcurrencyLimit,
      restoredRoleLimits,
      restoredProviderLimits,
      restoredWriteRoles,
      restoredDefaultAllowOverlap,
      // 快照是否显式给出映射：决定「替换静态映射」还是「覆盖 live 的第二层回退」。
      hasSnapshotRoleLimits: snapshot.roleLimits !== undefined,
      hasSnapshotProviderLimits: snapshot.providerLimits !== undefined,
      projectsShardTimeout,
      restoredEvents,
      droppedEvents,
      resume,
      merge,
    },
  };
}

/**
 * restore 提交的配置/事件/计数改写面（从 commitRestorePlan 提出，语义逐行一致）。
 *
 * 只做「已校验计划」的写入：限额配置 → 冲突配置 → 任务表清空（非 merge）→ 事件历史与序号
 * → 任务编号 → 轮转游标 → 派发闩 → 代次种子 → 停止证据边界诊断。
 *
 * @param {object} deps - 构造期注入的协作面（含恢复闸门的写入命令）。
 * @param {object} plan - restore 组装好的提交计划（字段已校验）。
 * @param {Set<string>} resolvedBoundaries - 本次恢复实际落到的停止证据边界集合。
 */
function commitRestoreConfig(deps, plan, resolvedBoundaries) {
  const {
    snapshot, restoredMaxGeneration, restoredDefaultConcurrencyLimit, restoredRoleLimits,
    restoredProviderLimits, restoredWriteRoles, restoredDefaultAllowOverlap, hasSnapshotRoleLimits,
    hasSnapshotProviderLimits, restoredEvents, droppedEvents, resume, merge,
    explicitStopEvidenceBoundary, stopEvidenceBoundary, stopEvidenceBoundarySource,
  } = plan;
  /**
   * 本次恢复实际落到各任务上的边界集合。
   *
   * 大多数快照的任务边界一致；但 Host 会把"root 未到达"的任务延迟恢复，并在持久化
   * 投影里把旧任务与新进程快照合并。这类被延迟的任务会携带**来源进程**的
   * task.processInstance（见 Host 的 deferTask 投影），因此边界必须按任务解析：
   * 同一个快照里可能同时存在"本进程重建的任务"和"上一进程遗留的任务"。
   */
  // 校验全部通过后才修改内存状态：非法快照不得破坏现有任务或配置。
  //
  // 默认上限：只有"没有当前设置可读"时才冻结快照值；有 live resolver 时保持 live，
  // 快照值完全不参与调度（它最后一次生效值仍写回快照作诊断）。
  if (!deps.hasLiveConcurrencyResolver) {
    deps.limitConfig.defaultConcurrencyLimit = restoredDefaultConcurrencyLimit;
    deps.limitConfig.lastResolvedDefaultConcurrencyLimit = restoredDefaultConcurrencyLimit;
    deps.limitConfig.resolverSource = "snapshot";
  }
  // 角色级映射：静态映射沿用既有语义（快照替换构造配置）；live 解析函数优先，
  // 快照显式映射只作为第二层回退（见 resolveRoleLimits）。
  if (hasSnapshotRoleLimits) {
    if (typeof deps.limitConfig.roleLimits === "function") {
      deps.limitConfig.restoredRoleLimitOverrides = Object.freeze({ ...restoredRoleLimits });
    } else {
      deps.limitConfig.roleLimits = restoredRoleLimits;
    }
  } else if (typeof deps.limitConfig.roleLimits === "function") {
    // 快照没有角色级映射：清空上一轮的第二层回退，避免跨快照残留旧覆盖。
    deps.limitConfig.restoredRoleLimitOverrides = Object.freeze({});
  }
  // provider 级映射复用同一套两层语义（票据 26）：live 解析函数优先，快照映射只作
  // 第二层回退；静态映射沿用「快照替换构造配置」的既有语义。
  if (hasSnapshotProviderLimits) {
    if (typeof deps.limitConfig.providerLimits === "function") {
      deps.limitConfig.restoredProviderLimitOverrides = Object.freeze({ ...restoredProviderLimits });
    } else {
      deps.limitConfig.providerLimits = restoredProviderLimits;
    }
  } else if (typeof deps.limitConfig.providerLimits === "function") {
    deps.limitConfig.restoredProviderLimitOverrides = Object.freeze({});
  }
  deps.store.conflictConfig.setWriteRoles(restoredWriteRoles);
  deps.store.conflictConfig.setDefaultAllowOverlap(restoredDefaultAllowOverlap);
  if (typeof deps.injectedConflictChecker !== "function") {
    deps.store.conflictConfig.setConflictChecker(createWriteRoleConflictChecker({ writeRoles: deps.store.conflictConfig.writeRoles }));
  }
  if (!merge) {
    deps.store.clearTasks();
    deps.store.clearRequestOwners();
    deps.store.clearRotationCursors();
  }
  // 快照事件数超过条数预算时，slice 丢掉的最旧记录同样属于 gap 事实（不是静默丢失）。
  // 条数由 restore 组装计划时算好（droppedEvents），提交侧只负责累加。
  if (droppedEvents > 0) deps.ledger.addDropped(droppedEvents);
  // 恢复输入可能是乱序（外部磁盘/旧版本）：按 sequence 升序落历史，既保证
  // earliestAvailableSequence 是真正的最旧一条，也让裁剪可以安全地从队首丢弃。
  const highestEventSequence = restoredEvents.reduce((highest, event) => Math.max(highest, event.sequence), 0);
  deps.ledger.setSequence(merge
    ? Math.max(deps.ledger.sequenceValue(), Number.isInteger(snapshot.sequence) ? snapshot.sequence : 0, highestEventSequence)
    : Math.max(Number.isInteger(snapshot.sequence) ? snapshot.sequence : 0, highestEventSequence));
  if (merge) {
    deps.ledger.mergeRestoredHistory(restoredEvents);
  } else {
    deps.ledger.replaceRestoredHistory(restoredEvents);
  }
  deps.store.setNextTaskNumber(merge
    ? Math.max(deps.store.nextTaskNumberValue(), Number.isInteger(snapshot.nextTaskNumber) ? snapshot.nextTaskNumber : 0)
    : Number.isInteger(snapshot.nextTaskNumber) ? snapshot.nextTaskNumber : 0);
  if (snapshot.parentRotation !== null && typeof snapshot.parentRotation === "object") {
    for (const [role, cursor] of Object.entries(snapshot.parentRotation)) {
      if (Number.isInteger(cursor) && cursor >= 0) deps.store.setRotationCursor(role, cursor);
    }
  }
  deps.setRestoreDispatchSuppressed(!resume);
  deps.boundScheduler.dispatchState.clearPendingWork();
  // 代次种子：恢复后新建 attempt 的代次必须严格大于全部历史值（见 restoredMaxGeneration）。
  // 代次种子必须是数值：函数引用参与 Math.max 会被转成 NaN，导致恢复后每个新建
  // attempt 的 executionGeneration 都变成 NaN，停止证据校验永远失败、任务永久不可回收。
  deps.store.setNextExecutionGeneration(Math.max(
    Number.isSafeInteger(snapshot.nextExecutionGeneration) ? snapshot.nextExecutionGeneration : 0,
    restoredMaxGeneration,
    deps.store.nextExecutionGenerationValue(),
  ));
  // 记录本次恢复使用的停止证据边界（只读诊断；不写入快照——边界属于恢复进程的决定）。
  // 多任务混合边界（延迟恢复的旧任务 + 本进程任务）显式投影为 "mixed"。
  const effectiveBoundary = explicitStopEvidenceBoundary !== undefined
    ? explicitStopEvidenceBoundary
    : resolvedBoundaries.size === 0
      ? stopEvidenceBoundary
      : resolvedBoundaries.size === 1
        ? [...resolvedBoundaries][0]
        : "mixed";
  deps.boundScheduler.dispatchState.noteRestoreBoundary(effectiveBoundary, stopEvidenceBoundarySource);
}

/**
 * resume 恢复续跑：为 interrupted attempt 追加新 attempt（保留历史、清取消标记）。
 *
 * 从 commitRestorePlan 的逐任务循环中提出，语义逐行一致：预算与停止 gate 的判定仍走
 * scheduler 的同一实现，恢复期不发布实时 per-shard 事件。
 *
 * @param {object} deps - 构造期注入的协作面。
 * @param {object} task - 已重建的任务对象。
 * @param {boolean} resume - 是否显式续跑。
 * @param {Set<string>} rolesToSchedule - 有 queued 分片的 role 集合（用于末尾调度）。
 */
function resumeRestoredShardAttempts(deps, task, taskRole, resume, rolesToSchedule) {
    const blockedResume = [];
    if (resume) {
      for (const shard of task.shards) {
        const last = shard.attempts[shard.attempts.length - 1];
        if (last === undefined || last.status !== "interrupted") continue;
        if (shard.cancelRequested === true) continue;
        /**
         * 恢复续跑的停止 gate（票据 07）：unknown 边界下无法证明原执行体已停止，
         * 绝不自动追加新 attempt——否则旧 child（若仍在另一个进程/会话里）与新 attempt
         * 会并发写同一路径。这里只记录原因，由 Host 用 process-restart 边界或补交证据。
         */
        if (!isStopObserved(last)) {
          const unconfirmed = deps.boundScheduler.unconfirmedStopAttempts(shard).map((attempt) => deps.boundScheduler.unconfirmedStopSummary(attempt));
          shard.resumeBlocked = { reason: "stop_unconfirmed", attempts: unconfirmed };
          blockedResume.push({ shardId: shard.shardId, reason: "stop_unconfirmed", unconfirmed });
          continue;
        }
        /**
         * 恢复续跑必须先过 attempt 预算（票据 08），判定与 retry/continue 同源。
         *
         * 语义：新建后的 attempt 数超过 maxAttemptsPerShard 就不追加、不派发；
         * 保持最后一个 attempt 的 interrupted 终态与 shard 的终态视图，不自动重试。
         * 绝不能为"让恢复成功"而放宽——写入第 limit+1 个 attempt 后，下次 restore
         * 会被 checkRestoreBudget 整体拒绝，整份快照将永久不可恢复。
         * 原因码放在 shard.resumeBlocked（随 shard 快照持久化），同时发一条结构化
         * 诊断事件，供 Host/UI 提示"需手工提交新父任务"。
         */
        const budget = deps.boundScheduler.attemptBudgetVerdict(
          shard,
          "shard " + shard.shardId,
          "该 shard 已耗尽恢复续跑预算，请提交新的父任务或拆分工作",
        );
        if (budget !== null) {
          shard.resumeBlocked = {
            reason: budget.reason,
            attempts: budget.attempts,
            limit: budget.limit,
          };
          // 事件延后到任务登记 + 聚合之后再发（见下方 emit 循环）：订阅者收到
          // shard_resume_blocked 时 boundCommands.getTask() 必须已经能读到一致的终态。
          blockedResume.push({
            shardId: shard.shardId,
            attempts: budget.attempts,
            limit: budget.limit,
            reason: budget.reason,
          });
          continue;
        }
        // 恢复续跑的新 attempt 同样按三级优先级解析超时：快照里的分片/任务级显式值
        // 优先，否则取**当前** settings 的角色默认值（恢复不冻结角色级配置）。
        const attempt = deps.boundScheduler.createAttempt(task, shard, last.attempt + 1);
        shard.attempts.push(attempt);
        delete attempt.cancelRequested;
        shard.cancelRequested = false;
        deps.store.setShardStatus(task, shard, "queued");
        shard.updatedAt = deps.now();
        task.updatedAt = shard.updatedAt;
        rolesToSchedule.add(taskRole);
      }
    }
    deps.store.putTask(task.parentTaskId, task);
    // 快照里重新出现的同 id 任务覆盖旧的回收标记（迟到回调必须归新任务判定）。
    deps.store.forgetReclaimedTask(task.parentTaskId);
    if (task.requestId !== undefined) deps.store.setRequestOwner(task.requestId, task.parentTaskId);
    deps.boundCommands.aggregateTask(task);
    // 恢复续跑被预算拦下的诊断事件：只带元数据（不含 prompt/结果），
    // 且必须在任务登记与聚合之后发布——订阅者读 boundCommands.getTask() 时状态已一致。
    for (const blocked of blockedResume) {
      deps.events.emit({
        type: "shard_resume_blocked",
        parentTaskId: task.parentTaskId,
        shardId: blocked.shardId,
        role: task.role,
        // 预算拒绝带 attempts(数)+limit；停止 gate 带未确认 attempt 摘要（unconfirmed）。
        ...(blocked.limit === undefined ? {} : { attempts: blocked.attempts, limit: blocked.limit }),
        ...(blocked.unconfirmed === undefined ? {} : { unconfirmed: blocked.unconfirmed }),
        reason: blocked.reason,
      });
    }
}

export function commitRestorePlan(deps, plan) {
  const {
    // 已校验的快照输入与恢复决定。
    rawTasks,
    snapshot,
    snapshotProcessInstance,
    explicitStopEvidenceBoundary,
    stopEvidenceBoundary,
    stopEvidenceBoundarySource,
    restoredMaxGeneration,
    // 校验并归一化后的配置。
    restoredDefaultConcurrencyLimit,
    restoredRoleLimits,
    restoredProviderLimits,
    restoredWriteRoles,
    restoredDefaultAllowOverlap,
    hasSnapshotRoleLimits,
    hasSnapshotProviderLimits,
    projectsShardTimeout,
    // 事件计划与派发闩。
    restoredEvents,
    droppedEvents,
    resume,
    merge,
  } = plan;
  const resolvedBoundaries = new Set();
  commitRestoreConfig(deps, plan, resolvedBoundaries);
  const rolesToSchedule = new Set();
  deps.setRestoringSnapshot(true);
  for (const rawTask of rawTasks) {
    const parentCancelRequested = rawTask.parentCancelRequested === true;
    // 角色在构造 task 之前取出：shards.map 的回调在 task 对象字面量求值期间执行，
    // 此时 `task` 仍处于 TDZ，任何对 task.role 的引用都会抛 ReferenceError
    // （整个 restore 因此静默失败）。用已校验的 rawTask.role 作为本任务的 role 源。
    const taskRole = rawTask.role;
    /**
     * 任务级边界：显式边界优先；否则任务自身携带的来源进程身份优先于快照顶层值。
     * Host 延迟恢复的旧任务靠 task.processInstance 保留真实来源，避免被合并后的
     * 顶层"当前进程"身份误判为同进程重建。
     */
    const taskProcessInstance = typeof rawTask.processInstance === "string" && rawTask.processInstance.length > 0
      ? rawTask.processInstance
      : snapshotProcessInstance;
    const taskBoundary = explicitStopEvidenceBoundary ?? (
      taskProcessInstance !== undefined && taskProcessInstance === PROCESS_INSTANCE
        ? "unknown"
        : "process-restart"
    );
    resolvedBoundaries.add(taskBoundary);
    const task = {
      parentTaskId: rawTask.parentTaskId,
      ...(typeof rawTask.requestId === "string" ? { requestId: rawTask.requestId } : {}),
      role: taskRole,
      basePrompt: typeof rawTask.basePrompt === "string" ? rawTask.basePrompt : "",
      status: "pending",
      // 轮次随快照持久化：旧快照没有该字段时按第 1 轮（首次提交）归一。
      round: Number.isSafeInteger(rawTask.round) && rawTask.round >= 1 ? rawTask.round : 1,
      // continuation 幂等记录恢复：restore 后旧 requestId 仍然 duplicate=true，
      // 且绝不因为索引淘汰而把旧键当成新的一轮（幂等键的生命周期 = 任务生命周期）。
      ...(rawTask.continuationRequests === undefined || rawTask.continuationRequests === null
        ? {}
        : { continuationRequests: cloneJson(rawTask.continuationRequests) }),
      allowOverlap: rawTask.allowOverlap === true,
      ...(typeof rawTask.concurrencyLimit === "number" ? { concurrencyLimit: rawTask.concurrencyLimit } : {}),
      // 父任务级默认超时随快照恢复；缺字段（旧快照）等于「未设置」，
      // 之后创建的 attempt 依然能取到当前角色默认值。
      ...(typeof rawTask.timeoutMs === "number" ? { timeoutMs: rawTask.timeoutMs } : {}),
      // provider 归属随快照恢复（票据 26）；旧快照缺字段时保持 undefined，
      // provider 计数因此不会凭空给该任务建份额。
      ...(typeof rawTask.provider === "string" ? { provider: rawTask.provider.trim() } : {}),
      createdAt: typeof rawTask.createdAt === "number" ? rawTask.createdAt : deps.now(),
      updatedAt: typeof rawTask.updatedAt === "number" ? rawTask.updatedAt : deps.now(),
      settledAt: typeof rawTask.settledAt === "number" ? rawTask.settledAt : undefined,
      parentCancelRequested,
      shards: rawTask.shards.map((rawShard) => {
        const attempts = (rawShard.attempts.length === 0 ? [{ attempt: 1, status: "queued" }] : rawShard.attempts).map((rawAttempt, index) => {
          const attemptNumber = Number.isInteger(rawAttempt.attempt) ? rawAttempt.attempt : index + 1;
          /**
           * attempt 身份与停止证据恢复（票据 07）：
           * - 字段存在则原样使用（身份必须跨重启稳定，否则 Host 无法提交证据）；
           * - 旧快照缺字段时按确定性规则派生（attemptId = 父任务/分片/序号，
           *   executionGeneration = 序号），并标记 legacy=true，让诊断能区分
           *   "派生身份"与"创建身份"。
           */
          const hasAttemptId = typeof rawAttempt.attemptId === "string" && rawAttempt.attemptId.trim().length > 0;
          const hasGeneration = Number.isSafeInteger(rawAttempt.executionGeneration) && rawAttempt.executionGeneration >= 1;
          const hasStopEvidence = rawAttempt.stopEvidence !== undefined;
          const legacy = !hasAttemptId || !hasGeneration || !hasStopEvidence;
          return {
            attempt: attemptNumber,
            status: typeof rawAttempt.status === "string" ? rawAttempt.status : "queued",
            attemptId: hasAttemptId
              ? rawAttempt.attemptId.trim()
              : deriveAttemptId(rawTask.parentTaskId, rawShard.shardId, attemptNumber),
            executionGeneration: hasGeneration ? rawAttempt.executionGeneration : attemptNumber,
            stopEvidence: hasStopEvidence
              ? cloneJson(rawAttempt.stopEvidence)
              : { state: STOP_EVIDENCE_STATE_UNKNOWN },
            ...(typeof rawAttempt.stopRequestedAt === "number" ? { stopRequestedAt: rawAttempt.stopRequestedAt } : {}),
            ...(typeof rawAttempt.stopDeadlineAt === "number" ? { stopDeadlineAt: rawAttempt.stopDeadlineAt } : {}),
            ...(typeof rawAttempt.stopWatchdogExpiredAt === "number" ? { stopWatchdogExpiredAt: rawAttempt.stopWatchdogExpiredAt } : {}),
            ...(typeof rawAttempt.terminalReason === "string" ? { terminalReason: rawAttempt.terminalReason } : {}),
            ...(legacy || rawAttempt.legacy === true ? { legacy: true } : {}),
            startedAt: typeof rawAttempt.startedAt === "number" ? rawAttempt.startedAt : undefined,
            finishedAt: typeof rawAttempt.finishedAt === "number" ? rawAttempt.finishedAt : undefined,
            affectedPaths: Array.isArray(rawAttempt.affectedPaths) ? [...rawAttempt.affectedPaths] : [],
            ...(rawAttempt.cancelRequested === true ? { cancelRequested: true } : {}),
            // attempt 级超时是创建时已解析的**实效值**，恢复后原样使用（不重算）。
            // 对旧快照的非法字段保持旧行为：静默丢弃（不因它整体拒绝快照）。
            ...(typeof rawAttempt.timeoutMs === "number" && Number.isFinite(rawAttempt.timeoutMs) && rawAttempt.timeoutMs >= 0
              ? { timeoutMs: rawAttempt.timeoutMs }
              : {}),
            ...(typeof rawAttempt.childId === "string" ? { childId: rawAttempt.childId } : {}),
            ...(typeof rawAttempt.messageId === "string" ? { messageId: rawAttempt.messageId } : {}),
            ...(rawAttempt.result === undefined ? {} : { result: cloneJson(rawAttempt.result) }),
            ...(rawAttempt.error === undefined ? {} : { error: cloneJson(rawAttempt.error) }),
          };
        });
        // 恢复语义：running 的运行时句柄已经不存在，统一记为 interrupted。
        // 注意：这**不**代表执行已停止——unknown 边界下 stopEvidence 保持 unknown，
        // 影响范围继续占用，等 Host 证据或人工处置。
        for (const attempt of attempts) {
          if (attempt.status === "running") {
            attempt.status = "interrupted";
            attempt.terminalReason = attempt.terminalReason ?? "restore";
            attempt.finishedAt = attempt.finishedAt ?? deps.now();
            attempt.error = attempt.error ?? toShardError(
              { name: "ShardInterruptedError", reason: "restore", message: "运行时恢复后丢失原 child，需手工重试" },
              "shard 因恢复而中断",
            );
          }
        }
        /**
         * 停止证据边界（票据 07）：
         * - process-restart：重启确实终止了执行体所属进程，快照内 attempt 一律 observed；
         * - unknown：保留快照里的证据（新快照可能是 observed，也可能真的是 unknown）。
         *   绝不为"让恢复好看一点"而伪造证据。
         */
        if (taskBoundary === "process-restart") {
          for (const attempt of attempts) {
            if (isStopObserved(attempt)) continue;
            attempt.stopEvidence = {
              state: STOP_EVIDENCE_STATE_OBSERVED,
              source: "process-restart",
              observedAt: deps.now(),
            };
          }
        }
        /**
         * 恢复不重新挂停止看门狗：快照里没有执行句柄，恢复进程无法观察"这次停止是否
         * 在宽限内完成"（宽限属于上一条执行生命线）。未确认的停止交给 Host 证据或
         * 人工处置；stopDeadlineAt 仍随快照恢复，供诊断判断"早已超期"。
         */
        const last = attempts[attempts.length - 1];
        const latestTerminal = isTerminalShardStatus(last.status);
        // 分片覆盖的来源见 projectsShardTimeout：新快照只信 rawShard.timeoutMs，
        // 旧快照才用最新 attempt 的实效值反推（当年两者恒等）。
        const restoredShardTimeoutMs = typeof rawShard.timeoutMs === "number"
          ? rawShard.timeoutMs
          : (projectsShardTimeout ? undefined : last.timeoutMs);
        const shard = {
          shardId: rawShard.shardId,
          // 使用恢复阶段已校验并归一化的名称；旧快照没有该字段时保持"无名称"，
          // 由投影侧回退 shardId。
          ...(typeof rawShard.name === "string" ? { name: rawShard.name.trim() } : {}),
          prompt: typeof rawShard.prompt === "string" ? rawShard.prompt : "",
          status: latestTerminal ? last.status : "queued",
          affectedPaths: last.affectedPaths.length > 0 ? [...last.affectedPaths] : (Array.isArray(rawShard.affectedPaths) ? [...rawShard.affectedPaths] : []),
          ...(rawShard.cancelRequested === true || (parentCancelRequested && rawShard.status === "queued") ? { cancelRequested: true } : {}),
          ...(restoredShardTimeoutMs === undefined ? {} : { timeoutMs: restoredShardTimeoutMs }),
          createdAt: typeof rawShard.createdAt === "number" ? rawShard.createdAt : deps.now(),
          updatedAt: typeof rawShard.updatedAt === "number" ? rawShard.updatedAt : deps.now(),
          attempts,
        };
        // resume 的派发候选只来自"非终态且仍在 queued"的 shard：latestTerminal 的
        // shard 已经结算，重新派发等于重复执行，必须排除。
        if (resume && shard.status === "queued" && !latestTerminal) rolesToSchedule.add(taskRole);
        return shard;
      }),
    };
    // resume 语义：被中断的 running shard 只有换一个新 attempt 才可能继续执行——
    // 原来的 attempt 已经写成 interrupted 终态，调度器只派发 queued attempt。
    // 这里复用 retryShard 的语义（追加 attempt、保留历史、清取消标记），但只在
    // resume 时执行，且不触发 per-shard 事件重放（恢复期不发布实时事件）。
      resumeRestoredShardAttempts(deps, task, taskRole, resume, rolesToSchedule);
  }
  // restore 在所有任务重建完成后一次性刷新派生索引，确保 merge 替换任务时不留旧引用。
  deps.store.rebuildIndexes();
  deps.setRestoringSnapshot(false);
  deps.persistence.notifyPersistence();
  // boundScheduler.schedule() 会清除 restoreDispatchSuppressed 并排入一次 drain，因此 resume 的
  // 重派发仍由唯一调度状态机（dispatchAvailable + role concurrency + affectedPaths
  // 冲突判定）决定，restore 不复制任何调度规则。
  if (resume && rolesToSchedule.size > 0) deps.boundScheduler.schedule();
}
