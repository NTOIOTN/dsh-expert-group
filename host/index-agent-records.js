/**
 * 入口 agent/created 的恢复登记域（R4e · 票据 19，agent 事件接线拆分之一）。
 *
 * 这一域只负责 `agent/created` 里「这个 child 是不是可认证的插件专家、要不要为它建立
 * 恢复记录」的判定与登记：
 * - fan-out child 由 fan-out Host 预检（失败即 fail-closed，不登记、不回落普通专家路径）；
 * - 普通专家 child 按 marker / cold-resume 快照 / 当前 root 的 pending creation 三选一认证，
 *   并把 exact Agent 绑定到既有或新建的 recovery record；
 * - P3 acceptance 竞态预登记：把 pendingCreation 的 binding 立即写进 record，
 *   `messageId` 尚不确定时先标 pendingMessage，随后由 startContinuable 回填。
 *
 * ## 铁律（票据 19）
 * 本模块**不接收 ctx**、不注册任何事件：`ctx.on("agent/created")` 仍在 `index.js`
 * 原注册点（由 `host/index-agent-created.js` 的编排 handler 调用本域命令）。
 *
 * ## 状态唯一 owner
 * recovery record 子树（`recoveryRecords` / childActivationStates / pendingCreations）的
 * owner 仍是 `host/index-recovery.js`；本模块只通过它的命令面读写，**不持有任何容器**。
 * 记录对象上的 `agent` / `tasks` 字段写入与迁移前完全同形（同一批字段、同一顺序），
 * 属既有记录结构的公开写面，迁移未新增写点。
 *
 * ## 行为等价
 * 认证顺序（rebuild -> 当前 root pending -> durable record / cold-resume 快照）、
 * 迟到 child 的拒绝语义（不复活插件状态）、binding 事务回填与 LRU 淘汰完全不变。
 *
 * @module dsh-expert-group/host/index-agent-records
 */
import { ROLE_MARKER, PARENT_MARKER } from "./expert-guards.js";
import { TASK_BINDING_LIMIT, evictOldestEntries } from "../shared/recovery-ledger.js";
import { recoveryRebuildCanCommit } from "../shared/turn-settlement.js";

/**
 * 创建 agent/created 的专家恢复登记能力面。
 *
 * @param {object} deps - 窄能力面（5 组）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别与 child id）。
 * @param {object} deps.identity - 根身份面：`lineage`（activeRoot/tokenOf）。
 * @param {object} deps.recovery - 恢复域（records + rebuild ops 两半合并的同一关注点）：
 *   `getRecord`/`ensureRecoveryRecord`/`moveRecoveryRecordToChild`/`bindRecoverySession`/
 *   `recordsView`/`takeRebuild`/`hasPendingCreation`/`findPendingCreation`/
 *   `removePendingCreation`。
 * @param {object} deps.handoff - handoff 域：`retargetHandoffAdmissionActivation`、
 *   `bindPendingHandoffAdmission`。
 * @param {object} deps.delegation - 委派跟踪器：`bindActiveTask(activityId, childId)`。
 * @returns {object} `{ registerExpertRecovery }`。
 */
export function createAgentRecordRegistration({ logger, identity, recovery, handoff, delegation }) {
  /**
   * 为一个已通过身份判定的专家 child 登记恢复记录。
   *
   * @param {object} agent - exact Agent 对象。
   * @param {{role: string, parentId: string, isContinuable: boolean, recordedExpert?: object}} expert
   *   已解析的专家身份（marker 或 cold-resume 快照）。
   * @returns {{pluginChildAuthenticated: boolean, ignoredLateRecoveryChild: boolean}} 认证结论。
   */
  function registerExpertRecovery(agent, { role, parentId, isContinuable, recordedExpert }) {
      let ignoredLateRecoveryChild = false;
      let pluginChildAuthenticated = false;
      if (typeof role === "string" && typeof parentId === "string" && typeof agent?.id === "string") {
        const rebuilding = recovery.takeRebuild(identity.lineage.activeRoot(parentId), parentId, role);
        const currentParent = identity.lineage.activeRoot(parentId);
        const pendingCreationForCurrentRoot = recovery.hasPendingCreation((item) => item.parent === currentParent
          && item.rootToken === identity.lineage.tokenOf(currentParent)
          && item.parentId === parentId && item.role === role);
        const existingRecord = recovery.getRecord(agent.id);
        let record;
        const hasCreationMarkers = typeof agent?.options?.[ROLE_MARKER] === "string"
          && typeof agent?.options?.[PARENT_MARKER] === "string";
        const isColdResumeSnapshot = recordedExpert !== void 0 && !hasCreationMarkers;
        if (rebuilding === void 0 && (existingRecord !== void 0 || pendingCreationForCurrentRoot || isColdResumeSnapshot)) {
          pluginChildAuthenticated = true;
          record = recovery.ensureRecoveryRecord(agent.id, parentId, role, currentParent, agent, isContinuable);
        } else if (rebuilding === void 0) {
          // marker child 没有当前 root 的 pending creation，也没有 durable snapshot/record，
          // 只能是已退休 root await 的迟到 accepted child；禁止它复活插件状态。
          ignoredLateRecoveryChild = true;
        } else if (recoveryRebuildCanCommit(recovery.recordsView, rebuilding.record, rebuilding.op)) {
          pluginChildAuthenticated = true;
          recovery.moveRecoveryRecordToChild(rebuilding.record, agent.id, agent);
          record = rebuilding.record;
        } else {
          ignoredLateRecoveryChild = true;
          logger.warn(`dsh-expert-group: ignoring late recovery rebuild child ${agent.id} after its record was cleared`);
        }
        if (record !== void 0) {
          // 记录当前 Activation 的 exact 身份；同 id 的旧 Session 事件不得接管新记录。
          const previousActivation = record.agent;
          record.agent = agent;
          if (agent.session !== void 0) recovery.bindRecoverySession(record, agent.session, previousActivation);
          else if (record.parentAgent !== void 0) {
            handoff.retargetHandoffAdmissionActivation(record.parentAgent, agent.id, agent, { previousActivation });
          }
        }
        // P3：新建路径（delegateBackground → startContinuable）的 binding
        // acceptance 竞态预登记——只消费带 ROLE/PARENT marker 的新建 child
        // （cold-resume 快照补全的旧 child 不参与）：agent/created 同步触发
        // 且早于 startContinuable resolve，立即写入 pendingMessage 绑定
        // （messageId 尚不确定），让 inbox claimed 补绑与 reused 反查都能命中；
        // startContinuable 返回后回填 messageId 并清 pendingMessage。
        if (record !== void 0 && rebuilding === void 0 && typeof agent?.options?.[ROLE_MARKER] === "string" && typeof agent?.options?.[PARENT_MARKER] === "string") {
          const pending = recovery.findPendingCreation((item) => item.parent === identity.lineage.activeRoot(parentId)
            && item.rootToken === identity.lineage.tokenOf(identity.lineage.activeRoot(parentId))
            && item.parentId === parentId && item.role === role);
          if (pending !== void 0) recovery.removePendingCreation(pending);
          if (pending !== void 0 && typeof pending.taskKey === "string") {
            const transaction = pending.transaction;
            if (transaction !== void 0) {
              transaction.agent = agent;
              transaction.childId = agent.id;
              transaction.record = record;
              transaction.recordOwned = existingRecord === void 0;
            }
            const previousBinding = record.tasks.get(pending.taskKey);
            const nextBinding = { messageId: null, childId: agent.id, pendingMessage: true };
            record.tasks.set(pending.taskKey, nextBinding);
            if (transaction !== void 0) {
              transaction.previousBinding = previousBinding;
              transaction.binding = nextBinding;
              // 即使覆盖了同 key 的旧 binding，nextBinding 仍是本事务写入；
              // rollback helper 会按 previousBinding 精确恢复旧 durable 状态。
              transaction.taskBindingOwned = true;
            }
            if (pending.activityId !== void 0) delegation.bindActiveTask(pending.activityId, agent.id);
            if (pending.handoffExpected === true) handoff.bindPendingHandoffAdmission(pending.handoffAdmission, agent.id, pending.messageId);
            evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
          }
        }
      }
    return { pluginChildAuthenticated, ignoredLateRecoveryChild };
  }

  return { registerExpertRecovery };
}
