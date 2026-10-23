/**
 * 入口装配段 3（票据 21b · R4-21）：会话覆盖 + 模型路由域、推理深度注入/root 退休域、
 * agent 事件接线（created / disposed / request-error）。
 *
 * 注册点仍由入口按本模块返回的**有序数组**登记；本模块只构造 adapter 与域实参对象。
 *
 * @module dsh-expert-group/host/index-assembly-agents
 */
import { createIndexModelRouteDomain } from "./index-model-route.js";
import { createEffortRetireDomain } from "./index-effort-retire.js";
import { createAgentRecordRegistration } from "./index-agent-records.js";
import { createAgentSnapshotDomain } from "./index-agent-snapshot.js";
import { createAgentCreatedHandler } from "./index-agent-created.js";
import { createAgentDisposedHandler } from "./index-agent-disposed.js";
import { createAgentRequestErrorHandler } from "./index-agent-request-error.js";

/**
 * 会话覆盖 + 模型路由 + 设置校验域（票据 16）。
 *
 * 域服务只返回纯能力面：没有 ctx 注册点，也不持有容器。ValidationError 由入口创建并
 * 放进状态容器（RPC 400 映射与图片路由共用同一个类身份），subagent provider 名归一
 * 是 R4d 域的纯函数（晚绑定，调用期解析）。
 *
 * @param {object} state 装配状态容器。
 */
export function assembleModelRoute(state) {
  const { logger, config } = state;
  const { llm, settings } = state.services;
  const { settingsRuntime, updateSettingsAtGeneration, configMigrationPending, roleCatalog, activeRoles } = state;

  const modelRoute = createIndexModelRouteDomain({
    llm,
    settings,
    settingsRuntime,
    updateSettingsAtGeneration,
    configMigrationPending,
    settingsRead: {
      readSettingsSource: state.readSettingsSource,
      readSnapshot: state.readSnapshot,
      describeRolePrompts: state.describeRolePrompts,
      defaultPersonaForRole: state.defaultPersonaForRole,
    },
    roles: { roleCatalog, activeRoles },
    getFanoutHost: () => state.fanoutHost,
    ValidationError: state.ValidationError,
    normalizeSubagentProvider: (value) => state.expertCore?.validSubagentProviderName(value),
  });
  Object.assign(state, modelRoute);
  state.modelRoute = modelRoute;

  const effortRetire = createEffortRetireDomain({
    identity: {
      isRootAgentIdentity: state.isRootAgentIdentity,
      lineage: state.host.lineage,
      rootGenerationRegistry: state.rootGenerationRegistry,
      notificationHost: state.notificationHost,
    },
    prelude: { markRootDisposed: state.markRootDisposed },
    rootWait: { rootTurnWaits: state.rootTurnWaits, forgetRootUserWait: state.forgetRootUserWait },
    handoff: {
      forgetParentTurnEnds: state.forgetParentTurnEnds,
      forgetFailedHandoffParent: state.forgetFailedHandoffParent,
      clearPendingHandoffAdmissions: state.clearPendingHandoffAdmissions,
    },
    recovery: {
      prunePendingCreationsForParent: state.prunePendingCreationsForParent,
      dropRebuildsFor: (...args) => state.recovery.dropRebuildsFor(...args),
      dropParentRecoveryRecords: state.dropParentRecoveryRecords,
    },
    delegation: { dropParent: (parentId) => state.delegationTracker.dropParent(parentId) },
    fanout: { releaseRetiredRootHandoffs: (agent) => state.fanoutWaits?.retireHandoffRecordsForRoot(agent) },
  });
  Object.assign(state, effortRetire);
  state.effortRetire = effortRetire;
}

/**
 * agent 事件接线（票据 19）：created / disposed / request-error 三个 handler 分别由三个
 * 域模块提供构造；本段把组合根的窄能力装配进它们，并把三条注册描述按原顺序返回
 * （含 request-error 的 prepend）。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleAgentHandlers(state) {
  const { logger, services } = state;
  const { agents, subagents } = services;
  const { host, delegationTracker, recoveryDomain, recovery } = state;

  const agentRecords = createAgentRecordRegistration({
    logger,
    identity: { lineage: host.lineage },
    // recovery 组聚合恢复域的两半（record 生命周期 + rebuild ops）：同一关注点，
    // 容器 owner 仍是 host/index-recovery.js，这里只取命令。
    recovery: {
      getRecord: state.getRecord,
      ensureRecoveryRecord: state.ensureRecoveryRecord,
      moveRecoveryRecordToChild: state.moveRecoveryRecordToChild,
      bindRecoverySession: state.bindRecoverySession,
      recordsView: state.recordsView,
      hasPendingCreation: state.hasPendingCreation,
      findPendingCreation: state.findPendingCreation,
      removePendingCreation: state.removePendingCreation,
      takeRebuild: (...args) => recovery.takeRebuild(...args),
    },
    handoff: {
      retargetHandoffAdmissionActivation: state.retargetHandoffAdmissionActivation,
      bindPendingHandoffAdmission: state.bindPendingHandoffAdmission,
    },
    delegation: { bindActiveTask: (activityId, childId) => delegationTracker.bindActiveTask(activityId, childId) },
  });
  const agentSnapshot = createAgentSnapshotDomain({
    // child 模型快照写面：只交出只读快照与**浅合并**写命令（persistChildModel 不得整条替换，
    // 否则冷恢复重放会抹掉 lastDispatch/usage 等它不负责的持久字段）。
    storage: { readSnapshot: state.readSnapshot, writeChildModelPatch: state.writeChildModelPatch },
    roles: { roleLabelOfRole: state.roleLabelOfRole },
    // expertCore 是 apply 后段才装配的晚绑定值：只交出调用期解析的窄命令。
    core: {
      validSubagentProviderName: (...args) => state.expertCore.validSubagentProviderName(...args),
      flushPendingStructuredPatch: (...args) => state.expertCore.flushPendingStructuredPatch(...args),
    },
    modelRoute: { installFallbackOverride: (agent) => state.installModelFallbackRouteOverride(agent) },
    guards: { installExpertReportGuard: (agent, resolvedIdentity) => state.installExpertReportGuardForAgent(agent, resolvedIdentity) },
  });
  // root 生命周期面：身份/代际/等待/退休与 handoff 只读状态探针属于同一关注点
  // （回答「这个 exact root 当前处在哪个生命周期阶段」），因此合并为一组传入。
  const rootLifecycle = () => ({
    agents,
    lineage: host.lineage,
    rootGenerationRegistry: state.rootGenerationRegistry,
    notificationHost: state.notificationHost,
    isRootAgentIdentity: state.isRootAgentIdentity,
    retireRootGeneration: state.retireRootGeneration,
    markRootDisposed: state.markRootDisposed,
    forgetRootUserWait: state.forgetRootUserWait,
    rootTurnWaits: state.rootTurnWaits,
    releaseRetiredRootHandoffs: state.releaseFanoutHandoffRecordsForRetiredRoot,
    hasRootHandoffState: (agent) => host.handoff.some((entry) => entry.parent === agent)
      || state.hasParentTurnEnds(agent)
      || state.hasFailedHandoffParent(agent),
  });
  const agentCreatedHandler = createAgentCreatedHandler({
    logger,
    rootWait: { engageRootTurnWaitForCreatedAgent: state.engageRootTurnWaitForCreatedAgent },
    fanout: {
      consumeFanoutRestore: state.consumeFanoutRestore,
      getFanoutHost: () => state.fanoutHost,
      reconcileGoalHandoffs: () => state.fanoutWaits?.reconcileFanoutGoalHandoffs(),
    },
    roots: rootLifecycle(),
    guards: { installExpertReportGuard: (agent, resolvedIdentity) => state.installExpertReportGuardForAgent(agent, resolvedIdentity) },
    effort: { resolveEffortOf: state.resolveEffortOf, installEffortInjection: state.installEffortInjection },
    records: {
      registerExpertRecovery: agentRecords.registerExpertRecovery,
      getRecord: state.getRecord,
      readChildActivation: state.readChildActivation,
      noteChildActivation: state.noteChildActivation,
      invalidateRequestRetryState: state.invalidateRequestRetryState,
    },
    snapshot: agentSnapshot,
  });
  const agentDisposedHandler = createAgentDisposedHandler({
    logger,
    roots: rootLifecycle(),
    fanout: { getFanoutHost: () => state.fanoutHost },
    // F6 的 guard disposer 表仍由状态容器持有；域只经两个命令读取与摘除（同序、同容错）。
    guards: {
      getGuardCleanup: (agent) => state.expertReportGuardDisposers.get(agent),
      forgetGuardCleanup: (agent) => state.expertReportGuardDisposers.delete(agent),
    },
    recovery: {
      forgetChildActivation: state.forgetChildActivation,
      invalidateRequestRetryState: state.invalidateRequestRetryState,
      dropParentRecoveryRecords: state.dropParentRecoveryRecords,
      dropModelFallbackState: state.dropModelFallbackState,
    },
    effort: { disposeEffortInjection: state.disposeEffortInjection },
    delegation: {
      dropParent: (parentId) => delegationTracker.dropParent(parentId),
      completeDetachedActiveTasksForChild: (childId) => delegationTracker.completeDetachedActiveTasksForChild(childId),
    },
    snapshot: agentSnapshot,
  });
  const agentRequestErrorHandler = createAgentRequestErrorHandler({
    logger,
    recovery: {
      requestFallbackTarget: state.requestFallbackTarget,
      requestRetryStateFor: state.requestRetryStateFor,
      modelFallbackChainFor: state.modelFallbackChainFor,
      currentModelRouteOf: state.currentModelRouteOf,
      switchToNextModelCandidate: state.switchToNextModelCandidate,
      hostRetryCountFor: state.hostRetryCountFor,
      requestRetryStateIsCurrent: state.requestRetryStateIsCurrent,
      isRequestRetryState: state.isRequestRetryState,
    },
  });
  void recoveryDomain;

  return [
    { kind: "on", event: "agent/created", handler: ({ agent }) => agentCreatedHandler.handleAgentCreated(agent) },
    { kind: "on", event: "agent/disposed", handler: ({ agent }) => agentDisposedHandler.handleAgentDisposed(agent) },
    { kind: "on", event: "agent/request-error", handler: agentRequestErrorHandler.handleAgentRequestError, options: { prepend: true } },
  ];
}
