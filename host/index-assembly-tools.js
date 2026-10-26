/**
 * 入口装配段 4（票据 21b · R4-21）：专家委派工具域（core / fan-out / role / surface）、
 * fan-out runtime 接线、专家群运行时投影与工具面挂载。
 *
 * ## 注册点归属
 * - `ctx.effect`（fan-out runtime 关闭、四条快照失效监听、provider-added/removed）由入口按
 *   本模块返回的有序数组登记。
 * - 工具挂载（`ctx.effect(() => tools.register(...))`）是**动态注册**：挂载时机由设置变更与
 *   provider 事件驱动，因此经入口提供的 `caps.registerTool` 能力注册；该能力的箭头函数
 *   （唯一调用 ctx.effect + tools.register 的位置）仍写在入口里。
 *
 * @module dsh-expert-group/host/index-assembly-tools
 */
import { createIndexExpertToolsCore } from "./index-expert-tools-core.js";
import {
  createFanoutWaitLedger,
  createFanoutShardWaits,
  createFanoutDeclarationCaches,
  createFanoutTaskCommands,
  createFanoutRequestBuilder,
  createFanoutChildHandlers,
  createFanoutToolHooks,
  createFanoutRuntimeWiring,
} from "./index-expert-tools-fanout.js";
import {
  createRoleToolHandles,
  createRoleToolRebuild,
  createRoleToolSteer,
  createRoleToolContinue,
  createRoleToolNewChild,
  createRoleToolRestoreChild,
  createRoleToolDelegatePaths,
  createRoleToolScopeAdmission,
  createRoleToolClosures,
} from "./index-expert-tools-admission.js";
import {
  createRoleToolExecute,
  createRoleToolDispatch,
  createRoleToolObserverRoute,
  createRoleToolDefinition,
  createIndexExpertRoleTools,
} from "./index-expert-tools-role.js";
import { createFanoutToolSurface, createRoutingPrompt } from "./index-expert-tools-surface.js";
import { createExpertGroupRuntime } from "./expert-group-runtime.js";

/**
 * 委派核心 + fan-out 域（票据 18）：声明缓存 → 等待账本 → 任务命令 → 请求构造/child 回调
 * → runtime 装配；装配完成后立即消费 runtime 的 restore 快照并交出一条关闭 effect。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleExpertTools(state) {
  const { logger } = state;
  const { tools, subagents, agents } = state.services;
  const {
    host,
    delegationTracker,
    storageBinding,
    persistenceHealth,
    activeRoles,
    roleCatalog,
    roleLabelOfRole,
  } = state;

  const expertToolsIdentity = {
    lineage: host.lineage,
    getAgent: (id) => agents.get(id),
    tokenFor: (agent) => host.lineage.tokenFor(agent),
    isLiveGeneration: (agent, token) => host.lineage.isLiveGeneration(agent, token),
    parentAgentOf: (id) => host.lineage.parentAgentOf(id),
    storageGeneration: () => host.storage.active()?.generation,
  };
  state.expertToolsIdentity = expertToolsIdentity;
  // 委派核心域：结构化声明/结果补丁、继承通道、启动适配器与 admission 事实。
  state.expertCore = createIndexExpertToolsCore({
    tools,
    subagents,
    storage: {
      readSettingsSource: state.readSettingsSource,
      readSnapshot: state.readSnapshot,
      writeChildModelPatch: state.writeChildModelPatch,
    },
    getAttachmentStore: () => state.attachmentStore,
    logger,
  });

  // fan-out 域：声明缓存 -> 等待账本 -> 任务命令 -> 请求构造/child 回调 -> runtime 装配。
  const fanoutRuntimeAccess = { getFanoutHost: () => state.fanoutHost };
  state.fanoutCaches = createFanoutDeclarationCaches({ storage: { readSnapshot: state.readSnapshot }, runtime: fanoutRuntimeAccess });
  const fanoutShardWaits = createFanoutShardWaits({
    rootWait: {
      isRootWaitStopping: state.isRootWaitStopping,
      isLiveRootAgent: state.isLiveRootAgent,
      track: (agent, work) => state.rootTurnWaits.track(agent, work),
      settle: (agent, work) => state.rootTurnWaits.settle(agent, work),
    },
    runtime: fanoutRuntimeAccess,
    caches: state.fanoutCaches,
  });
  state.fanoutWaits = createFanoutWaitLedger({
    rootWait: {
      isRootWaitStopping: state.isRootWaitStopping,
      isLiveRootAgent: state.isLiveRootAgent,
      track: (agent, work) => state.rootTurnWaits.track(agent, work),
      settle: (agent, work) => state.rootTurnWaits.settle(agent, work),
    },
    agents,
    runtime: fanoutRuntimeAccess,
    caches: state.fanoutCaches,
    shards: fanoutShardWaits,
  });
  const fanoutCommands = createFanoutTaskCommands({
    core: state.expertCore,
    models: { resolveRole: state.resolveRole },
    runtime: fanoutRuntimeAccess,
    waits: state.fanoutWaits,
    caches: state.fanoutCaches,
  });
  state.fanoutCommands = fanoutCommands;
  const fanoutRequestBuilder = createFanoutRequestBuilder({
    identity: expertToolsIdentity,
    models: {
      restoredFanoutModelRoute: state.restoredFanoutModelRoute,
      resolveRoleModelRoute: state.resolveRoleModelRoute,
      routeMarkerOf: state.routeMarkerOf,
      // 派发路由冻结快照 marker（票据 03）：与 attempt.route 同一份数据，随 child_models 落盘。
      routeSnapshotMarkerOf: state.routeSnapshotMarkerOf,
    },
    core: state.expertCore,
    roles: { require: (role) => roleCatalog().require(role) },
    storage: { resolvePersonaForAdmission: state.resolvePersonaForAdmission },
    caches: state.fanoutCaches,
  });
  const fanoutChildHandlers = createFanoutChildHandlers({
    childSurface: {
      installExpertReportGuardForAgent: state.installExpertReportGuardForAgent,
      installEffortInjection: state.installEffortInjection,
      installModelFallbackRouteOverride: state.installModelFallbackRouteOverride,
      resolveEffortOf: state.resolveEffortOf,
    },
    storage: { readSnapshot: state.readSnapshot, writeChildModel: state.writeChildModel },
    core: state.expertCore,
    roles: { roleLabelOfRole },
    recovery: { noteChildActivation: state.noteChildActivation },
  });
  const fanoutHooks = createFanoutToolHooks({
    identity: expertToolsIdentity,
    childIo: {
      sendMessageToExistingChild: state.sendMessageToExistingChild,
      interrupt: (childId, parentAgent) => subagents.interrupt(childId, { kind: "ancestor", agent: parentAgent }),
    },
    core: state.expertCore,
    waits: state.fanoutWaits,
    requestBuilder: fanoutRequestBuilder,
    childHandlers: fanoutChildHandlers,
    /**
     * 派发期路由冻结 seam（票据 03）：只交出两个**只读取值函数**（同一代读的设置快照 +
     * 只读时钟）。判定语义留在 fanout 域（host/fanout-dispatch-route.js），组合根不写
     * 第二套选路；时钟沿用 per-apply 的只读时钟，因此测试注入假时钟即可确定性断言。
     */
    dispatch: {
      readSettingsSnapshot: () => state.readSnapshot(),
      clock: state.clock,
    },
  });
  const fanoutRuntime = createFanoutRuntimeWiring({
    identity: expertToolsIdentity,
    roles: { activeRoles, roleCatalog },
    storage: {
      readSettingsSource: state.readSettingsSource,
      readFanoutSnapshot: () => storageBinding.fanoutSnapshot(),
      persistFanoutSnapshot: state.persistFanoutSnapshot,
      persistenceHealth,
    },
    waits: state.fanoutWaits,
    caches: state.fanoutCaches,
    hooks: fanoutHooks,
    commands: fanoutCommands,
    logger,
  });
  state.fanoutHost = fanoutRuntime.host;
  state.consumeFanoutRestore("runtime-wired", state.fanoutHost.restore());
  // 关闭/回收边界清理 Host 侧 schema 映射：关闭后不再有可复用的派发契约。
  return [{
    kind: "effect",
    label: "dsh-expert-group: fan-out runtime",
    factory: () => () => {
      fanoutRuntime.close();
    },
  }];
}

/**
 * Expert Group 只读运行时投影（两级快照缓存）。
 *
 * 它不订阅或改变任务生命周期，RPC 调用时按需生成快照；所有读面都以取值函数注入，
 * 因此 settings / usage / 会话查询的晚绑定仍在调用期解析。
 *
 * @param {object} state 装配状态容器。
 */
export function assembleExpertGroupRuntime(state) {
  const { logger } = state;
  const { agents } = state.services;

  // 关于 host 侧的会话标题读面（可选依赖 projectionTitleFor）：轻量快照拿不到冷会话日志，
  // 理论上可用 ctx.sessionProjectionCache 的 cachedSnapshot(header) 零 I/O 补齐标题，
  // 但该服务只接受带 lifecycle 身份（version/createdAt/cwd/isSeeded）的权威 header，
  // 而 DEG 在"不冷读"的首屏里拿不到 cold child 的 header——唯一来源是 sessionQuery 的
  // 全量语料 listing，正是本次要消除的开销。因此这里故意不接线：轻量快照的 taskName
  // 直接降级到 child_models.lastDispatch.description（完整快照里的优先级本来就高于会话标题）。
  // 注入形态按能力组组织（票据 33 · C3 收窄）：8 组，逐组聚合理由见 createExpertGroupRuntime 的注释。
  state.expertGroupRuntime = createExpertGroupRuntime({
    agents: { agents },
    goals: { goals: state.goals },
    // 归属判定读面：血缘链 + 任务管理器（两者已作为单个聚合传给 fanoutTasksOwnedBy）。
    ownership: { lineage: state.host.lineage, fanoutHost: state.fanoutHost },
    // 恢复域读面：模块命令面 + 记录表（记录表同时供快照缓存复用）。
    recovery: { recovery: state.recovery, recoveryRecords: state.recordsView },
    sources: {
      source: state.source,
      sessionQuery: () => state.expertGroupSessionQuery,
      // 用量（票据 25）：live 账本优先于持久化记录，去抖窗口内的最新值也能进入快照；
      // runtime 只读该投影，不参与计量与刷盘。
      usageFor: (childId) => state.usageFor(childId),
    },
    labels: {
      // 角色显示名：每次构建现读内置角色目录；历史节点在角色仍存在时使用当前目录标签，
      // 角色不可用时回退 child_models 里的持久化 roleLabel。
      roleLabels: () => state.roleLabelsProjection(),
    },
    diagnostics: { logger },
  });
}

/**
 * 快照缓存失效接线（幂等、O(1)）。
 *
 * 快照缓存按 root 保存，必须跟随可观察的状态变化失效，否则 2.5s 轮询会一直复用同一份
 * 旧快照。复用既有事件挂点：
 * - session/event 只取真正改变快照内容的事件（turn/start、turn/end 与 user/message）；
 *   turn/start 必须包含：新 turn 开始后 turnOpenSince/turnDurationMs 的锚点变了，
 *   若继续复用旧缓存，客户端会晚一整轮（甚至更久）才看到新起点；
 * - agent/created / agent/status / agent/disposed。
 * 两个挂点都只做一次 Map 读并在必要时递增代次，不写任何持久状态，也不产生第二套事实源。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleSnapshotInvalidation(state) {
  const { logger } = state;

  const invalidateSnapshotFor = (sessionId) => {
    // 空/非字符串 id 直接丢弃：这不是「清空全部」，只是一次不携带身份的事件。
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) return;
    try { state.expertGroupRuntime.invalidateSnapshots(sessionId); } catch (error) {
      // 失效只是缓存优化：任何异常都不得影响事件派发本身。
      logger.warn("dsh-expert-group: snapshot cache invalidation failed: " + (error instanceof Error ? error.message : String(error)));
    }
  };
  return [
    {
      kind: "on",
      event: "session/event",
      handler: (session, event) => {
        const type = event?.type;
        if (type !== "turn/start" && type !== "turn/end" && type !== "user/message") return;
        invalidateSnapshotFor(session?.id);
      },
    },
    { kind: "on", event: "agent/created", handler: ({ agent } = {}) => invalidateSnapshotFor(agent?.id) },
    { kind: "on", event: "agent/status", handler: ({ agent } = {}) => invalidateSnapshotFor(agent?.id) },
    { kind: "on", event: "agent/disposed", handler: ({ agent } = {}) => invalidateSnapshotFor(agent?.id) },
  ];
}

/**
 * role 工具域（票据 18）：admission 分组 + 定义对象 + 挂载表（只构造成员，不注册）。
 *
 * @param {object} state 装配状态容器。
 */
export function assembleRoleTools(state) {
  const { logger } = state;
  const { agents, subagents, llm } = state.services;
  const { delegationTracker, roleCatalog } = state;

  const roleToolHandles = createRoleToolHandles({
    delegation: delegationTracker,
    records: state.recoveryDomain,
    agents,
    storage: { readSnapshot: state.readSnapshot },
    subagents,
  });
  const roleToolRebuild = createRoleToolRebuild({
    records: state.recoveryDomain,
    core: state.expertCore,
    identity: state.expertToolsIdentity,
    delegation: delegationTracker,
    recovery: state.recovery,
    recoveryFlow: { supersedePendingRecoveryOps: state.supersedePendingRecoveryOps },
    usage: { persistChildDispatch: state.persistChildDispatch },
    storage: { readSnapshot: state.readSnapshot },
  });
  const roleToolSteer = createRoleToolSteer({
    delegation: delegationTracker,
    records: state.recoveryDomain,
    handoff: state.handoffDomain,
    recoveryFlow: { supersedePendingRecoveryOps: state.supersedePendingRecoveryOps },
    identity: state.expertToolsIdentity,
    childIo: { sendMessageToExistingChild: state.sendMessageToExistingChild },
  });
  const roleToolContinuation = createRoleToolContinue({
    records: state.recoveryDomain,
    recovery: state.recovery,
    identity: state.expertToolsIdentity,
  });
  const roleToolNewChild = createRoleToolNewChild({
    delegation: delegationTracker,
    records: state.recoveryDomain,
    handoff: state.handoffDomain,
    recovery: state.recovery,
    recoveryFlow: { supersedePendingRecoveryOps: state.supersedePendingRecoveryOps },
    core: state.expertCore,
    usage: { persistChildDispatch: state.persistChildDispatch },
    identity: state.expertToolsIdentity,
  });
  const roleToolRestoreChild = createRoleToolRestoreChild({
    delegation: delegationTracker,
    records: state.recoveryDomain,
    recovery: state.recovery,
    usage: { persistChildDispatch: state.persistChildDispatch },
    core: state.expertCore,
    identity: state.expertToolsIdentity,
  });
  const roleToolDelegatePaths = createRoleToolDelegatePaths({
    identity: state.expertToolsIdentity,
    delegation: delegationTracker,
    records: state.recoveryDomain,
  });
  const roleToolScopeAdmission = createRoleToolScopeAdmission({
    identity: state.expertToolsIdentity,
    delegation: delegationTracker,
    records: state.recoveryDomain,
    handoff: state.handoffDomain,
  });
  const roleToolClosures = createRoleToolClosures({
    handles: roleToolHandles,
    rebuild: roleToolRebuild,
    steer: roleToolSteer,
    continuation: roleToolContinuation,
    newChild: roleToolNewChild,
    restoreChild: roleToolRestoreChild,
    delegatePaths: roleToolDelegatePaths,
    scopeAdmission: roleToolScopeAdmission,
  });
  const roleToolDispatch = createRoleToolDispatch({
    core: state.expertCore,
    models: {
      resolveRoleModelRoute: state.resolveRoleModelRoute,
      routeMarkerOf: state.routeMarkerOf,
      // 派发路由冻结快照 marker（票据 03）：启用峰谷时随 child_models 落盘。
      routeSnapshotMarkerOf: state.routeSnapshotMarkerOf,
      resolveModelInfo: (...args) => llm.resolveModelInfo(...args),
    },
    roles: { require: (role) => roleCatalog().require(role) },
    storage: { resolvePersonaForAdmission: state.resolvePersonaForAdmission },
    records: state.recoveryDomain,
    identity: state.expertToolsIdentity,
  });
  const roleToolExecute = createRoleToolExecute({
    records: state.recoveryDomain,
    identity: state.expertToolsIdentity,
    dispatch: roleToolDispatch,
    core: state.expertCore,
  });
  const roleToolObserverRoute = createRoleToolObserverRoute({
    identity: state.expertToolsIdentity,
    models: {
      // Observer 自动图片路由复用 role tool 的**同一条**派发路由（票据 03）：
      // 峰谷时段选择、候选链（含 image 能力要求）与快照冻结都不再有第二套实现。
      resolveRoleModelRoute: state.resolveRoleModelRoute,
      routeSnapshotMarkerOf: state.routeSnapshotMarkerOf,
    },
    core: state.expertCore,
    storage: { resolvePersonaForAdmission: state.resolvePersonaForAdmission },
  });
  const roleToolDefinition = createRoleToolDefinition({
    roles: { roleCatalog },
    execute: roleToolExecute,
  });
  state.roleTools = createIndexExpertRoleTools({
    closures: roleToolClosures,
    definition: roleToolDefinition,
    observerRoute: roleToolObserverRoute,
    core: state.expertCore,
    roles: { roleCatalog },
    logger,
  });
}

/**
 * 工具面装配域（票据 18）：fanout 工具定义 + routing 提示词 + 挂载表 + provider 事件。
 *
 * 挂载/卸载函数写到状态容器：角色工具同步命令（bootstrap 段）与 provider 事件都通过
 * 它们走同一个注册 adapter（`caps.registerTool`）。
 *
 * @param {object} state 装配状态容器。
 * @param {object} caps 入口具名能力面。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleToolSurface(state, caps) {
  const { services, activeRoles, isActiveRole } = state;
  const { systemPrompt } = services;
  const fanoutSurface = createFanoutToolSurface({
    commands: state.fanoutCommands,
    models: { resolveRoleModelRoute: state.resolveRoleModelRoute },
    identity: state.expertToolsIdentity,
    core: state.expertCore,
    roles: { isActiveRole, activeRoles },
    toolMount: state.roleTools,
  });
  state.fanoutSurface = fanoutSurface;
  const routingPrompt = createRoutingPrompt({
    systemPrompt,
    config: state.config,
    roles: { activeRoles },
    core: state.expertCore,
    storage: { readSnapshot: state.readSnapshot },
  });

  /** 挂载 role 工具：域给出已构造定义对象，入口能力面负责 effect 注册与 disposer 回填。 */
  function mountRole(role) {
    const prepared = state.roleTools.prepareMount(role);
    if (prepared === null) return;
    const disposeTool = caps.registerTool(prepared.definition, prepared.label);
    state.roleTools.commitMount(role, disposeTool);
  }

  function unmountRole(role) {
    state.roleTools.release(role);
  }

  /** 挂载通用 fanout 工具（同样只走入口的注册 adapter）。 */
  function mountFanoutTool() {
    const prepared = fanoutSurface.prepareFanoutMount();
    if (prepared === null) return;
    const disposeTool = caps.registerTool(prepared.definition, prepared.label);
    fanoutSurface.commitFanoutMount(disposeTool);
  }

  function unmountFanoutTool() {
    fanoutSurface.unmountFanoutTool();
  }

  function refreshRoutingPrompt() {
    routingPrompt.refreshRoutingPrompt();
  }
  Object.assign(state, { mountRole, unmountRole, mountFanoutTool, unmountFanoutTool, refreshRoutingPrompt });

  for (const role of activeRoles()) mountRole(role);
  mountFanoutTool();
  refreshRoutingPrompt();
  // 工具面装配完成：此后任何目录重建（设置保存/外部编辑）都要同步挂载/卸载工具。
  state.roleToolsReady = true;

  return [
    {
      kind: "on",
      event: "subagent/provider-added",
      handler: (provider) => {
        if (provider?.name !== "spawn") return;
        for (const role of activeRoles()) mountRole(role);
        mountFanoutTool();
        refreshRoutingPrompt();
      },
    },
    // provider-removed 载荷是 provider 名字符串；清理对应工具并让提示词如实反映不可用状态。
    {
      kind: "on",
      event: "subagent/provider-removed",
      handler: (providerName) => {
        if (providerName !== "spawn") return;
        for (const role of activeRoles()) unmountRole(role);
        unmountFanoutTool();
        refreshRoutingPrompt();
      },
    },
  ];
}
