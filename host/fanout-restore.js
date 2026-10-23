/**
 * Host 关注点模块：fan-out 快照恢复（restore staging）。
 *
 * 本模块是恢复阶段状态的唯一 owner：\`restoring\`（恢复窗口标志）、\`restorePending\`
 * （是否仍有延迟任务）与最近一次恢复结果 \`lastRestore\`。
 *
 * 固定顺序（票据 11）：**plan-build → 交 owner 一次性提交**。
 * 先把快照任务分成「可恢复」「延迟」「已存在」三类并完成 lineage 绑定/defer，
 * 再调用 manager.restore 一次性提交；提交失败时整批原子失败（manager 契约），
 * 本模块只补齐诊断、预算事件与 fail-closed 闸门，**不做部分提交**。
 *
 * @module dsh-expert-group/host/fanout-restore
 */

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
  const violation = error?.violation !== null && typeof error.violation === "object" && !Array.isArray(error.violation)
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

/**
 * 快照任务是否已经全部终态：只有非终态恢复任务需要保留 ownership。
 * 参数命名为 snapshotTask，避免与外层恢复循环里的 \`task\` 同名（TDZ 陷阱）。
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
 * 创建 restore staging 服务。
 *
 * @param {object} deps
 * @param {object} deps.lineage - 绑定/延迟任务小接口：parentSessionOf / bindParentTask /
 *   deferTask / deferredTasks / releaseParentTask / tokenFor。
 * @param {Function} deps.getAgent - (sessionId) => exact root Agent 或 undefined。
 * @param {Function} deps.getManager - () => 唯一 manager（listTasks / restore / getTask /
 *   recordBudgetViolation）。
 * @param {Function} deps.readSnapshot - () => 最近一次持久化快照（可缺省）。
 * @param {object} deps.ownership - ownership 服务：归属解析、归属快照、读凭据、归还与终态判定。
 * @param {object} deps.persistence - persistence 服务：撤销回收排除登记、fail-closed 闸门。
 * @param {Function} deps.warn - 日志旁路，异常不得影响恢复结果形状。
 * @returns {Readonly<object>} 命令 restore + 只读投影 pending/isRestoring/status。
 */
export function createFanoutRestoreService({
  lineage,
  getAgent,
  getManager,
  readSnapshot,
  ownership,
  persistence,
  warn,
}) {
  /** 恢复窗口标志：窗口内的事件回调不得提前结算/释放 ownership。 */
  let restoring = false;
  /** 是否仍有等待 root 出现的延迟任务（含本进程新建的 deferred 条目）。 */
  let restorePending;
  /** 最近一次真实执行过的恢复结果（只读诊断面，不写 storage）。 */
  let lastRestore = null;

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

  /**
   * 恢复快照：只恢复当前已存在的 root 任务；缺失 root 的 queued 任务留在
   * lineage deferred 中，等 root 出现后再恢复。
   *
   * 进程一律 resume: true —— 让唯一调度状态机按原规则继续执行未终态 work（queued attempt
   * 复用、running→interrupted 换新 attempt、role 并发 / affectedPaths / 取消意图都由 manager
   * 自己判定）；本模块只负责 ownership 与寻址。
   *
   * @param {{stopEvidenceBoundary?:"unknown"|"process-restart"}} [restoreOptions] - 停止证据
   *   边界透传（票据 07）。缺省时由 manager 按快照 processInstance 自动判定：同进程重建
   *   → unknown，不同/缺失 → process-restart。Host 冷启动与 agent-created/runtime-wired
   *   恢复都走自动判定，绝不手工强制 process-restart。
   */
  function restore(restoreOptions = {}) {
    if (typeof readSnapshot !== "function") return { restored: 0, deferred: 0, pending: restorePending === true };
    const snapshot = readSnapshot();
    if (snapshot === void 0 || snapshot === null || !Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) {
      return { restored: 0, deferred: 0, pending: restorePending === true };
    }
    const manager = getManager();
    const existingTaskIds = new Set(manager.listTasks().map((task) => task.parentTaskId));
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
    // ── plan-build 阶段：只做分类与 lineage 绑定/defer，不触碰 manager 的权威状态 ──
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
    // ── 一次性提交阶段：manager.restore 原子收敛；失败整批回滚，不做部分提交 ──
    restoring = true;
    try {
      const hasExplicitBoundary = restoreOptions !== null && typeof restoreOptions === "object"
        && restoreOptions.stopEvidenceBoundary !== undefined;
      manager.restore({ ...snapshot, tasks: restorableTasks }, {
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
        persistence.forgetDurableReclaimOmit(parentTaskId);
        // 顺序不可颠倒：必须在 lineage 释放之前取归属，否则只剩快照可查。
        const owner = ownership.resolvedOwner(parentTaskId) ?? snapshotParents[parentTaskId];
        ownership.rememberOwnerSnapshot(parentTaskId, owner);
        /**
         * 冷恢复读凭据：本次 restore 究竟把该任务恢复给了**哪个 exact root Agent**。
         * 只服务 continuation 的**只读幂等重放**（duplicate 回执），不构成任何写权限证据：
         * 同 id replacement 不是凭据里的对象、凭据 agent 被销毁/替换（token 失活）、没有凭据
         * （只看到 settledParentSessions）三种情况都拒绝。非终态任务另有活动绑定优先。
         */
        const parentId = typeof owner === "string" && owner.length > 0 ? owner : lineage.parentSessionOf(parentTaskId);
        const restoredAgent = typeof parentId === "string" ? getAgent(parentId) : undefined;
        if (restoredAgent !== undefined && typeof lineage.tokenFor === "function") {
          const token = lineage.tokenFor(restoredAgent);
          if (token !== undefined) {
            ownership.recordRestoreCredential(parentTaskId, { agent: restoredAgent, token, ownerId: parentId });
          }
        }
        // manager 可能在**恢复窗口内**就把任务聚合到终态（restoringSnapshot 会抑制
        // task_settled，此后不会再有事件把它带回来），因此这里按 manager 的权威状态
        // 复核一次并立即归还：否则归属 id 会一直滞留到 close（轻微泄漏），持久化
        // 投影也只能靠活动绑定而拿不到映射。
        const managerTask = typeof manager?.getTask === "function" ? manager.getTask(parentTaskId) : null;
        if (snapshotTaskIsTerminal(task) || ownership.taskIsTerminal(managerTask)) {
          // 这里释放的是本次 restore 刚建立的绑定，因此无条件释放（不依赖记账集合）。
          ownership.settleOwnership(parentTaskId, true);
        } else {
          ownership.markRestored(parentTaskId);
        }
      }
      restorePending = lineage.deferredTasks().length > 0;
      const restoredCount = restorableTasks.length;
      recordRestoreOutcome({ ok: true, restored: restoredCount, deferred: deferredCount, pending: restorePending, error: null });
      // 只有成功恢复才清除 fail-closed 闸门：失败恢复后继续落盘会用当前（可能为空/
      // 不完整）的内存状态覆盖磁盘上的原快照，等于把唯一可重试的副本毁掉。
      persistence.clearRestoreBlock();
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
      persistence.blockRestoreFailure(failure);
      warn("dsh-expert-group: fan-out snapshot restore failed [" + failure.code + "]: " + failure.message);
      // manager.restore 的既有契约是"非法/超预算快照原子失败且不写 eventHistory"，
      // 因此预算事件由 Host 在捕获后补发（recordBudgetViolation 只带元数据）。
      const managerForBudget = getManager();
      if (failure.violation !== null && typeof managerForBudget?.recordBudgetViolation === "function") {
        try {
          managerForBudget.recordBudgetViolation(failure.violation, "restore");
        } catch (recordError) {
          warn("dsh-expert-group: fan-out restore budget event failed: " + describeError(recordError));
        }
      }
      return { ok: false, restored: 0, deferred: deferredCount, pending: restorePending, error: failure };
    } finally {
      restoring = false;
    }
  }

  /**
   * 只读恢复状态：最近一次恢复结果 + fail-closed 闸门。
   *
   * 这是票据 04 要求的新只读面：侧栏/诊断不再只能从"任务为 0"猜测恢复失败，
   * 而是能拿到稳定 code、字段位置与预算违规（不含任何快照正文）。
   */
  function restoreStatus() {
    return Object.freeze({
      blocked: persistence.blockedProjection(),
      lastRestore: lastRestore === null ? null : cloneJson(lastRestore),
    });
  }

  return Object.freeze({
    restore,
    restoreStatus,
    /** 是否仍有等待 root 的延迟任务。 */
    pending: () => restorePending === true,
    /** 恢复窗口是否打开（窗口内事件回调不得结算 ownership）。 */
    isRestoring: () => restoring === true,
    /** describe() 用的只读投影（不含任何快照正文）。 */
    diagnostics: () => Object.freeze({ lastRestore: lastRestore === null ? null : cloneJson(lastRestore) }),
  });
}
