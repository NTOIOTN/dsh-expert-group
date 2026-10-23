/**
 * fan-out 状态 owner（R3-13 建立；R3-14 把 restore / reclaim 的**实现**迁到独立模块）。
 *
 * ## 职责（规格书 状态所有权(2)）
 * 本模块是 fan-out 生命周期闸门的唯一 owner，并对外暴露三个原子能力：
 * - runDispatchCycle()      → 委托 scheduler.dispatchAvailable（单 epoch 派发，无 await）；
 * - commitRestorePlan(plan) → restore 的唯一提交点（实现见 fanout/restore.js）；
 * - commitReclaim(token)    → 回收第二阶段的原子提交（实现见 fanout/reclaim.js）。
 * 另外承载 close()（关闭竞态与停止语义的 owner 命令）。
 *
 * ## 状态所有权（C5，R3-14 之后）
 * - 本模块独占：closed / restoringSnapshot / restoreDispatchSuppressed 三个生命周期闸门；
 * - 回收屏障（屏障对象 + token 序号）：由 fanout/reclaim.js 独占，本模块只注入 isClosed 探针，
 *   并以 reclaimOwner.port 只读投影转出（scheduler / task-commands 只读 current）；
 * - restore 不持有可变状态：计划由 fanout/restore.js 组装，提交经 restoreDeps 的窄命令写入。
 * 任务表、限额、事件、持久化、调度各自归各自模块；本模块绝不接收或传递整包 state / Map / Set。
 *
 * ## 迁移说明（R3-14）
 * 回收三段与 restore 段（含 4 个 helper）原样迁出，语义逐行不变；本文件只剩生命周期闸门、
 * close 与装配。原 (s, deps) 形态的窄切片被拆成三份显式协作面（生命周期 / restore / 回收），
 * 各自只含对应模块真正使用的能力。
 *
 * @module dsh-expert-group/fanout/state
 */
import { isTerminalShardStatus } from "./errors.js";
import { toShardError } from "./validation.js";
import { createReclaimBarrier } from "./reclaim.js";
import { buildRestorePlan, commitRestorePlan, validateRestoreTasks } from "./restore.js";

function closeManager(s, deps) {
  if (s.closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "already_closed" };
  s.closed = true;
  s.restoreDispatchSuppressed = true;
  deps.boundScheduler.dispatchState.clearPendingWork();
  /**
   * 关闭竞态（票据 05 修复）：**不得**在这里清空回收屏障，也不得删除待回收任务。
   *
   * Host 的回收顺序是「prepare（生成排除待回收任务的候选）→ await 落盘成功 → commit」；
   * close 完全可能落在那次 await 里。候选快照已经把任务从磁盘排除，只有让同一 token 的
   * commit/abort 在关闭后继续生效，内存状态才能与磁盘一致；清空屏障会让 commit 得到
   * token 失效，磁盘/内存永久分叉（重启后任务“消失”，或被重新恢复出来）。
   *
   * 关闭后不会因此开启新的回收：prepareReclaim 仍先判 closed 并返回 MANAGER_CLOSED；
   * commit/abort 自身已跳过关闭后的 emit/notifyPersistence/schedule。
   */
  // （保持 reclaimState 原样，见上。）
  let changed = false;
  for (const task of deps.store.allTasks()) {
    const activeShards = task.shards.filter((shard) => {
      const attempt = deps.store.activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
      return attempt !== undefined && !isTerminalShardStatus(attempt.status);
    });
    if (activeShards.length === 0) continue;
    changed = true;
    task.parentCancelRequested = true;
    for (const shard of activeShards) {
      const attempt = deps.store.activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
      if (attempt === undefined || isTerminalShardStatus(attempt.status)) continue;
      const cancellationAlreadyRequested = attempt.cancelRequested === true;
      attempt.cancelRequested = true;
      shard.cancelRequested = true;
      if (attempt.status === "running" && !cancellationAlreadyRequested) {
        deps.boundScheduler.requestShardCancellation(task, shard, attempt, "manager_closed");
      }
      /**
       * close 的停止语义（票据 07）：逻辑终态写 cancelled，但**不**假定执行已停止
       * （watchStop=false：不再挂看门狗，因为 manager 已关闭、不会再有调度与聚合）。
       * stopEvidence 保持 unknown，影响范围随任务一起消失（进程即将结束）。
       */
      deps.boundCommands.settleShard(task, shard, attempt, "cancelled", {
        error: toShardError(
          { name: "FanoutClosedError", reason: "manager_closed", message: "fan-out manager 已关闭" },
          "fan-out manager 已关闭",
        ),
        reason: "manager_closed",
        watchStop: false,
      });
    }
    deps.boundCommands.aggregateTask(task);
    deps.persistence.notifyPersistence();
  }
  /**
   * 关闭时清除全部内存定时器（超时 + 停止看门狗），但保留 unknown 状态。
   * 不清理会让进程退出前仍有悬挂句柄（测试用假时钟能直接观察到）。
   */
  for (const task of deps.store.allTasks()) {
    for (const shard of task.shards) {
      for (const attempt of shard.attempts) {
        if (attempt.timer !== undefined) {
          deps.clearTimeoutFn(attempt.timer);
          attempt.timer = undefined;
        }
        deps.boundScheduler.clearAttemptStopTimer(attempt);
      }
    }
  }
  // 关闭后不再保留实时订阅者；历史诊断仍保留在 eventHistory/快照中。
  deps.ledger.clearSubscribers();
  // 不取消既有 drainPromise：已排队的 drain 会看到 closed 并自行结束，调用方可以安全 await。
  return { accepted: true, changed, code: "MANAGER_CLOSED", reason: "manager_closed" };
}

/**
 * 创建 fan-out 状态 owner。
 *
 * @param {object} options - store / limits / events / persistence / snapshot / clock / budget / config
 *   （参数组与迁移前逐项相同，见 owner 台账 §C3）。
 * @returns {Readonly<object>} 三个原子能力、生命周期闸门、回收屏障投影与晚绑定端口。
 */
export function createFanoutState({ store, limits, events, persistence, snapshot, clock, budget, config }) {
  const { now, clearTimeout: clearTimeoutFn } = clock;
  const ledger = events;
  const limitConfig = limits.limitConfig;
  const { hasLiveConcurrencyResolver, injectedConflictChecker } = config;
  /** 本模块独占的生命周期闸门（唯一 owner，写点只有 close 与 restore 提交）。 */
  const s = { closed: false, restoringSnapshot: false, restoreDispatchSuppressed: false };
  /** 回收屏障归 fanout/reclaim.js 独占：这里只注入生命周期探针并转发三段命令。 */
  const reclaimOwner = createReclaimBarrier({ isClosed: () => s.closed });
  /**
   * restore 的窄协作面：只读协作方 + 两个恢复闸门写入命令。
   * boundScheduler / boundCommands 是晚绑定端口（构造期填 null，bind* 时替换）。
   */
  const restoreDeps = {
    store,
    events,
    persistence,
    ledger,
    limitConfig,
    now,
    hasLiveConcurrencyResolver,
    injectedConflictChecker,
    isClosed: () => s.closed,
    reclaimInProgress: () => reclaimOwner.port.current !== null,
    setRestoringSnapshot(value) { s.restoringSnapshot = value; },
    setRestoreDispatchSuppressed(value) { s.restoreDispatchSuppressed = value; },
    boundScheduler: null,
    boundCommands: null,
  };
  /** 回收的窄协作面：屏障 owner 只经这些命令读写任务表、候选快照与派发。 */
  const reclaimDeps = {
    store,
    events,
    persistence,
    snapshot,
    boundScheduler: null,
    boundCommands: null,
  };
  /** 生命周期命令（close）与派发周期端口所需的窄协作面。 */
  const deps = {
    store,
    persistence,
    ledger,
    clearTimeoutFn,
    dispatchCycle: undefined,
    boundScheduler: null,
    boundCommands: null,
  };

  function bindDispatch(runDispatchCycle) { deps.dispatchCycle = runDispatchCycle; }
  /** 三个协作面共享同一份晚绑定端口，避免各自持有副本后分叉。 */
  function bindScheduler(scheduler) {
    deps.boundScheduler = scheduler;
    restoreDeps.boundScheduler = scheduler;
    reclaimDeps.boundScheduler = scheduler;
  }
  function bindCommands(commands) {
    deps.boundCommands = commands;
    restoreDeps.boundCommands = commands;
    reclaimDeps.boundCommands = commands;
  }
  function runDispatchCycle() { return deps.dispatchCycle === undefined ? false : deps.dispatchCycle(); }
  /**
   * 对外唯一的恢复入口：先由 restore 模块组装计划（不改状态），
   * 再经 owner 的 commitRestorePlan 原子提交；闸门拒绝时原样返回迁移前的结构。
   */
  function restore(snapshot, restoreOptions) {
    const decided = buildRestorePlan(restoreDeps, snapshot, restoreOptions);
    if (decided.accepted === false) return decided.result;
    commitRestorePlan(restoreDeps, decided.plan);
    return { restored: true, tasks: store.taskTableSize() };
  }
  /** 生命周期闸门只读投影（写操作只有 close() 与本模块内部）。 */
  const gate = Object.freeze({
    get closed() { return s.closed; },
    get restoringSnapshot() { return s.restoringSnapshot; },
    get restoreDispatchSuppressed() { return s.restoreDispatchSuppressed; },
    resumeDispatch() { s.restoreDispatchSuppressed = false; },
  });
  const owner = Object.freeze({
    runDispatchCycle,
    commitRestorePlan: commitRestorePlan.bind(null, restoreDeps),
    commitReclaim: reclaimOwner.commit.bind(null, reclaimDeps),
  });

  return Object.freeze({
    bindDispatch, bindScheduler, bindCommands, owner, gate, reclaim: reclaimOwner.port,
    prepareReclaim: reclaimOwner.prepare.bind(null, reclaimDeps),
    commitReclaim: reclaimOwner.commit.bind(null, reclaimDeps),
    abortReclaim: reclaimOwner.abort.bind(null, reclaimDeps),
    validateRestoreTasks: validateRestoreTasks.bind(null, restoreDeps),
    restore,
    commitRestorePlan: commitRestorePlan.bind(null, restoreDeps),
    close: closeManager.bind(null, s, deps),
  });
}
