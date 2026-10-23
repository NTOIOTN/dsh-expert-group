/**
 * 入口 agent/disposed 事件接线域（R4e · 票据 19）。
 *
 * 这是 `ctx.on("agent/disposed")` 的纯 handler：按 exact Agent 对象收敛该代际的
 * 全部运行期边界——child scoped guard、fan-out attempt、请求级重试状态、effort 注入、
 * root 代际表、等待账本、fan-out 登记、委派活动与恢复记录。
 *
 * 关键语义（与迁移前逐行一致）：
 * - 只有**当前** root generation 才能清理终止快照、delegation tracker、admission 与
 *   recovery record；迟到旧 disposed 事件不触碰新代际；
 * - child 的 disposed 不删除 durable recovery record（自动恢复仍需要它），只摘除
 *   请求级状态与 exact-Agent 覆盖；
 * - 仍属于 live root 的 child 不在 disposed 释放受影响范围保护，其保护只由
 *   turn/end 或终态反馈释放（既有可恢复语义）。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册事件：`ctx.on("agent/disposed")` 仍由 `index.js` 在原注册点执行。
 *
 * ## 状态唯一 owner
 * guard 释放函数表（F6）仍由 `index.js` 持有；本模块只经 `guards.getGuardCleanup` /
 * `guards.forgetGuardCleanup` 两个命令访问（删除发生在 cleanup 之后，与迁移前同序）。
 *
 * @module dsh-expert-group/host/index-agent-disposed
 */
import { isFanoutAgent, isFanoutIdentity } from "../fanout-host.js";

/**
 * 创建 agent/disposed handler。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与错误名）。
 * @param {object} deps.roots - 根代际面（identity + prelude + 等待/退休命令的同一关注点）：
 *   `isRootAgentIdentity`、`lineage`、`rootGenerationRegistry`、`notificationHost`、
 *   `markRootDisposed`、`forgetRootUserWait`、`rootTurnWaits.retire`、
 *   `releaseRetiredRootHandoffs`。
 * @param {object} deps.fanout - fan-out 面：`getFanoutHost`（晚绑定）。
 * @param {object} deps.guards - F6 guard 清理 adapter：`getGuardCleanup(agent)` /
 *   `forgetGuardCleanup(agent)`。
 * @param {object} deps.recovery - 恢复域：`forgetChildActivation`、`invalidateRequestRetryState`、
 *   `dropParentRecoveryRecords`、`dropModelFallbackState`。
 * @param {object} deps.effort - effort 域：`disposeEffortInjection(agent)`。
 * @param {object} deps.delegation - 委派跟踪器：`completeDetachedActiveTasksForChild(childId)`。
 * @param {object} deps.snapshot - child 快照域：`readChildModel(childId)`。
 * @returns {{handleAgentDisposed: (agent: object) => void}} handler 能力面。
 */
export function createAgentDisposedHandler({ logger, roots, fanout, guards, recovery, effort, delegation, snapshot }) {
  /**
   * 执行并摘除某个 Agent 的 scoped guard 清理函数（删除发生在执行之后，单条抛错不阻断）。
   * @param {object} agent - exact Agent 对象。
   */
  function releaseGuardCleanup(agent) {
    const expertGuardCleanup = guards.getGuardCleanup(agent);
    if (expertGuardCleanup === void 0) return;
    try { expertGuardCleanup(); } catch (error) {
      logger.warn("dsh-expert-group: expert report guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      guards.forgetGuardCleanup(agent);
    }
  }

  /**
   * agent/disposed 的纯 handler。
   * @param {object} agent - 正在销毁的 Agent 对象。
   */
  function handleAgentDisposed(agent) {
    releaseGuardCleanup(agent);
    const recordedFanoutChild = typeof agent?.id === "string" ? snapshot.readChildModel(agent.id) : void 0;
    const fanoutHost = fanout.getFanoutHost();
    if (isFanoutAgent(agent) || isFanoutIdentity(recordedFanoutChild)) {
      // cold-resume child 可能没有 creation marker；disposed 仍必须让同一 attempt 收敛。
      fanoutHost?.handleAgentDisposed(agent, recordedFanoutChild);
      if (typeof agent?.id === "string") {
        recovery.forgetChildActivation(agent.id, agent);
      }
      recovery.invalidateRequestRetryState(agent);
      effort.disposeEffortInjection(agent);
      return;
    }
    const rootDisposed = roots.isRootAgentIdentity(agent) && roots.lineage.isKnownRoot(agent);
    const isCurrentRootGeneration = rootDisposed && roots.rootGenerationRegistry.isCurrent(agent.id, agent);
    // 先读取当前 exact Agent 的 generation，再退休完成状态；旧 disposed 事件不触碰新代次。
    const disposedGeneration = roots.rootGenerationRegistry.generationOf(agent.id);
    // 既有代码保留的只读状态探针（计算结果当前未被后续分支使用，但调用本身是纯读，
    // 迁移保持原样以免改变 handoff 域的读点序列）。
    const hasRootState = rootDisposed && roots.hasRootHandoffState(agent);
    if (rootDisposed) {
      roots.markRootDisposed(agent);
      roots.forgetRootUserWait(agent);
      const token = roots.lineage.tokenOf(agent);
      if (token !== void 0) token.active = false;
      if (isCurrentRootGeneration && Number.isSafeInteger(disposedGeneration)) {
        // root dispose 立即丢弃终止快照：没有新 run 就不可能再补发。
        roots.notificationHost.retireRoot(agent.id, disposedGeneration);
      }
      roots.rootGenerationRegistry.retire(agent.id, agent);
    }
    // 与 retireRootGeneration 同一语义：root dispose 后它的分片不会再产生
    // task_settled。取消该 root 的全部等待，并摘除它的 fan-out 登记（旧代际的登记
    // 绝不能被新代际继承）。
    if (agent !== void 0) roots.rootTurnWaits.retire(agent, "root-disposed");
    if (rootDisposed) roots.releaseRetiredRootHandoffs(agent);
    if (typeof agent?.id === "string") {
      recovery.forgetChildActivation(agent.id, agent);
    }
    if (rootDisposed) {
      const ownsCurrentRoot = roots.lineage.activeRoot(agent.id) === agent;
      if (ownsCurrentRoot) {
        roots.lineage.releaseAgent(agent);
        roots.lineage.releaseRoot(agent);
      }
      // 只有当前 root generation 才能清理 tracker、admission 和 recovery record；
      // child disposed 不得按 id 误删父状态，R1 迟到事件也不能污染 R2。
      if (roots.agents.get(agent.id) === agent) delegation.dropParent(agent.id);
      recovery.dropParentRecoveryRecords(agent);
    }
    // 权威 child disposal（票据 07）：root 已销毁/代际退休后，该 child 的 detached
    // 活动范围不会再有关联的 turn/end（record 已丢弃），disposal 是它的最终停止证据。
    // 仍属于 live root 的 child **不**在此释放：dispose 后它可能被 cold-resume 继续执行，
    // 其保护只能由 turn/end / terminal feedback 释放（既有可恢复语义）。
    if (typeof agent?.id === "string") delegation.completeDetachedActiveTasksForChild(agent.id);
    // child Activation 的 disposed 不删除 durable recovery record；自动恢复仍需它。
    // 请求级状态只绑定当前 Agent 对象，销毁时必须立即摘除，迟到 hook 不能复活。
    recovery.invalidateRequestRetryState(agent);
    effort.disposeEffortInjection(agent);
    // 运行期降级状态只绑定 exact Agent：销毁即摘除 listener 与链快照，迟到 hook
    // 既不会复活旧预算，也不会把覆盖应用到同 id 的新代际。
    recovery.dropModelFallbackState(agent);
  }

  return { handleAgentDisposed };
}
