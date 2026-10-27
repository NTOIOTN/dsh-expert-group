/**
 * 入口装配段 6（票据 21b · R4-21）：RPC action 分发（会话域 + 核心域）、legacy HTTP
 * exact route、Connection 通道、只读能力矩阵与运行时诊断投影。
 *
 * - `ctx.inject(["connection"])` 与 `ctx.effect(webServer.register(...))` 的注册描述按原
 *   顺序返回；前者保留迁移前的「ctx.inject 可用才登记」守卫（`optional: true`）。
 * - legacy HTTP adapter（handleRpc）与 Connection 通道共用同一个 dispatchRpcAction 实例。
 *
 * @module dsh-expert-group/host/index-assembly-wire
 */
import { RPC_PATH } from "../shared/protocol.js";
import { createRpcRequestLifecycle } from "./rpc-request-lifecycle.js";
import { BadJsonError } from "./index-rpc-http.js";
import { createIndexRpcActionCore } from "./index-rpc-action-core.js";
import { createIndexRpcActionSession } from "./index-rpc-action-session.js";
import { createConnectionChannel } from "./index-connection-channel.js";
import { createHostCapabilityReport } from "./index-capability-report.js";
import { createRuntimeDiagnostics } from "./index-runtime-diagnostics.js";
import { installSessionDeleteCommandFace } from "./session-delete-rpc.js";

/**
 * RPC action 分发（票据 20）：分发器按 action 域拆成两个模块——核心域（共享响应适配器 +
 * dispatchRpcAction + 无会话域 handler）与会话域 handler。
 *
 * 组合根只做装配与晚绑定：两个模块之间没有 import 边（会话域 routes 以 deps.session 交给
 * 核心），因此共享 envelope/错误映射只有一份，也不会产生 ESM 环。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleRpcActions(state, caps) {
  const { logger, services, config } = state;
  const { agents, llm, settings, subagents, webServer } = services;
  const { host } = state;

  const rpcSessionActions = createIndexRpcActionSession({
    services: { agents, config, settings },
    reads: {
      source: state.source,
      settingsSource: state.settingsSource,
      notificationHost: state.notificationHost,
      rootGenerationRegistry: state.rootGenerationRegistry,
      activeRoles: state.activeRoles,
      roleCatalog: state.roleCatalog,
      roleLabelsProjection: state.roleLabelsProjection,
      describeRolePrompts: state.describeRolePrompts,
      usageSummaryFor: state.usageSummaryFor,
      usageFor: state.usageFor,
      routeFieldsOfMarker: state.routeFieldsOfMarker,
      candidateSelectionsOfRole: state.candidateSelectionsOfRole,
      preflightSelectionEntry: state.preflightSelectionEntry,
      sessionOverrideProjectionOf: state.sessionOverrideProjectionOf,
      fanoutRpcRootSession: state.fanoutRpcRootSession,
      isActiveRole: state.isActiveRole,
      // 主代理模型配置读面（批次 A）：调用期解析运行期 manager，避免装配顺序耦合。
      orchestratorStatusOf: (sessionId) => state.orchestratorModel.getStatus(sessionId),
      // 主代理模型配置的**显式写入**入口（B2）：会话覆盖 set/clear 落盘成功后，
      // 由 manager 用同一套预检 + 自写令牌把选择真正应用到根会话原生模型。
      orchestratorApplyOverride: (sessionId) => state.orchestratorModel?.applyOverride(sessionId) === true,
      orchestratorApplyOverrideCleared: (sessionId) => state.orchestratorModel?.applyOverrideCleared(sessionId) === true,
    },
    storage: {
      host,
      storageBinding: state.storageBinding,
      enqueueWrite: state.enqueueWrite,
      observeStorageWrite: state.observeStorageWrite,
      // 会话覆盖的唯一 durable 写入实现（RPC 端点与主代理运行期共用，B2）。
      sessionOverrideStore: state.sessionOverrideStore,
    },
    models: {
      settingsRuntime: state.settingsRuntime,
      updateSettingsAtGeneration: state.updateSettingsAtGeneration,
      sessionOverrideConflictError: state.sessionOverrideConflictError,
      validateSelection: state.validateSelection,
      validateSelectionWithSignal: state.validateSelectionWithSignal,
    },
  });

  /**
   * 会话删除的无会话域命令面（票据 04）。
   *
   * 命令面在更后段（会话删除 RPC 装配段）才创建，因此这里只交出**调用期解析**的窄命令，
   * 与 noteOrchestratorSettingsCommit 等晚绑定写法一致；段缺失/已卸载时该窄面按
   * `delete-unavailable` fail-closed（实现与测试共用同一个 installSessionDeleteCommandFace）。
   */
  const sessionDeleteCommands = installSessionDeleteCommandFace({ readCommands: () => state.sessionDeleteRpc });

  // 注意 capabilityReport / runtimeDiagnostics / systemToastDiagnosticToken 在更后段才装配：
  // 这里只交出调用期解析的窄命令（与其它域服务的晚绑定写法一致），绝不在装配期提前求值。
  const rpcCore = createIndexRpcActionCore({
    services: {
      agents,
      config,
      llm,
      roleTools: state.roleTools,
      settings,
      subagents,
      commitSettingsCandidate: state.commitSettingsCandidate,
    },
    reads: {
      source: state.source,
      activeRoles: state.activeRoles,
      roleCatalog: state.roleCatalog,
      roleLabelsProjection: state.roleLabelsProjection,
      describeRolePrompts: state.describeRolePrompts,
      usageSummaryFor: state.usageSummaryFor,
      expertGroupRuntime: state.expertGroupRuntime,
      fanoutHost: state.fanoutHost,
      isActiveRole: state.isActiveRole,
      // 设置页保存成功后的「未来新会话配置修订」：只重排边界定时器，绝不遍历会话。
      // 调用期解析：装配顺序不保证该域已经构造完成。
      noteOrchestratorSettingsCommit: () => state.orchestratorModel?.noteSettingsCommit(),
    },
    image: {
      resolveMainImageRoute: state.resolveMainImageRoute,
      normalizeUploadedImages: state.normalizeUploadedImages,
      resolveRole: state.resolveRole,
      imageRouteDiagnostics: state.imageRouteDiagnostics,
      issueRouteClaim: state.issueRouteClaim,
      verifyRouteClaim: state.verifyRouteClaim,
      revokeRouteClaim: state.revokeRouteClaim,
      routeClaimError: state.routeClaimError,
      markRouteClaimCommitting: state.markRouteClaimCommitting,
      reserveObserverCleanupSlot: state.reserveObserverCleanupSlot,
      releaseObserverCleanupSlot: state.releaseObserverCleanupSlot,
      issueObserverCleanupToken: state.issueObserverCleanupToken,
      revokeObserverCleanupToken: state.revokeObserverCleanupToken,
      consumeObserverCleanupToken: state.consumeObserverCleanupToken,
      interruptObserverChild: state.interruptObserverChild,
      responseDelivered: state.responseDelivered,
      validateImageRouteBody: state.validateImageRouteBody,
      validateImageRouteValidateBody: state.validateImageRouteValidateBody,
      validateImageRouteCommitBody: state.validateImageRouteCommitBody,
      validateImageRouteReleaseBody: state.validateImageRouteReleaseBody,
      validateImageRouteCancelBody: state.validateImageRouteCancelBody,
    },
    fanout: {
      fanoutRpcSessionId: state.fanoutRpcSessionId,
      fanoutRpcRootSession: state.fanoutRpcRootSession,
      fanoutRpcIsChildSession: state.fanoutRpcIsChildSession,
      fanoutRpcReadRootSession: state.fanoutRpcReadRootSession,
      fanoutRpcOwnerOf: state.fanoutRpcOwnerOf,
      fanoutRpcCapabilitiesOf: state.fanoutRpcCapabilitiesOf,
      fanoutRpcSendOwnerNotLive: state.fanoutRpcSendOwnerNotLive,
      fanoutRpcAfter: state.fanoutRpcAfter,
      fanoutRpcTaskWithCapabilities: state.fanoutRpcTaskWithCapabilities,
      fanoutCaches: state.fanoutCaches,
      fanoutWaits: state.fanoutWaits,
      consumeFanoutRestore: state.consumeFanoutRestore,
      refreshFanoutSnapshotFromStorage: state.refreshFanoutSnapshotFromStorage,
      rehydrateFanoutOwnership: state.rehydrateFanoutOwnership,
    },
    manualDispatch: {
      requireManualFanoutRoot: state.requireManualFanoutRoot,
      buildManualDispatchPlan: state.buildManualDispatchPlan,
      runManualFanoutDispatch: state.runManualFanoutDispatch,
      manualDispatchFailure: state.manualDispatchFailure,
      readFanoutTemplateDocument: state.readFanoutTemplateDocument,
      persistFanoutTemplateDocument: state.persistFanoutTemplateDocument,
      runFanoutTemplateMutation: state.runFanoutTemplateMutation,
      buildFanoutTemplatePlan: state.buildFanoutTemplatePlan,
      summarizeFanoutTemplate: state.summarizeFanoutTemplate,
      FANOUT_TEMPLATE_MAX_BYTES: state.FANOUT_TEMPLATE_MAX_BYTES,
    },
    notifications: {
      systemToast: state.systemToast,
      systemToastEnabled: state.systemToastEnabled,
      systemToastVolume: state.systemToastVolume,
      systemToastPlatformToken: state.systemToastPlatformToken,
      // runtimeDiagnostics 在更后段装配：只交出调用期解析的窄命令。
      systemToastDiagnosticToken: (...args) => state.systemToastDiagnosticToken(...args),
      testNotificationToast: state.testNotificationToast,
      logSystemToastFailure: state.logSystemToastFailure,
    },
    runtime: { host, rpcErrorTracker: state.rpcErrorTracker, logger, ValidationError: state.ValidationError },
    diagnostics: {
      // 能力矩阵与运行时诊断都在更后段装配：同样只交出调用期解析的窄命令。
      describeHostCapabilities: (...args) => state.capabilityReport.describeHostCapabilities(...args),
      describeRuntimeDiagnostics: (...args) => state.runtimeDiagnostics.describeRuntimeDiagnostics(...args),
    },
    // 会话域分发表：核心模块只读取，不复制共享适配器。
    //
    // 会话删除（票据 04）的两个 action 不需要 sessionId，但语义属于「删会话」，因此与会话域
    // 动作共用同一个 deps 命名空间：这样 RPC 核心的能力组仍是已签核的 8 组，不新增第 9 个
    // 协作方。命令面由后段（assembleSessionDeleteRpc）晚绑定，这里只在**调用期**解析。
    session: { ...rpcSessionActions, sessionDelete: sessionDeleteCommands },
  });
  // legacy HTTP adapter（handleRpc）与 Connection 通道都调用这两个绑定：
  // 它们与迁移前同为一个实例，只是定义从 index.js 搬到了 host/index-rpc-action-core.js。
  state.dispatchRpcAction = rpcCore.dispatch;
  state.mapRpcError = rpcCore.mapRpcError;

  // ── Connection RPC 通道（票据 19）────────────────────────────────────
  // 通道建立与 envelope 转换 owner 在 host/index-connection-channel.js；
  // ctx.inject 的注册点与顺序仍由入口登记（铁律 1/2）。
  const connectionChannel = createConnectionChannel({
    logger,
    hostRpc: host.rpc,
    webServer,
    http: state.rpcHttp,
    errorTracker: state.rpcErrorTracker,
    lifecycle: createRpcRequestLifecycle,
    // dispatchRpcAction 属票据 20（R4f）范围；只交出调用期解析的包装。
    dispatch: { dispatchRpcAction: (...args) => state.dispatchRpcAction(...args) },
    // 迁移前原样传 ctx.effect 的值（host 未提供 Connection 服务时的回落注册面）。
    fallbackEffect: caps.effectValue,
  });
  state.connectionChannel = connectionChannel;

  return [
    {
      // 迁移前的守卫：宿主没有 ctx.inject 时整条不登记（`optional` 由入口解释）。
      kind: "inject",
      optional: true,
      deps: ["connection"],
      callback: (connectionCtx) => connectionChannel.install(connectionCtx),
    },
  ];
}

/**
 * 只读能力矩阵与运行时诊断（meta 动作的投影）+ legacy HTTP exact route（票据 19）。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleDiagnosticsAndRoute(state, caps) {
  const { services } = state;
  const { agents, llm, settings, systemPrompt, tools, webServer, subagents } = services;
  const { host } = state;

  const capabilityReport = createHostCapabilityReport({
    services: { tools, subagents, agents, settings, webServer, systemPrompt, llm },
    ctxProbe: {
      // 严格 Cordis Context 对未声明属性会抛：探针的 try/catch 留在入口能力面，
      // 与迁移前「读取本身 fail-closed」的语义一致。
      hasWaterfall: () => caps.hasWaterfall(),
    },
    storage: { describe: () => state.storageBinding.describe() },
    attachments: { present: () => state.attachmentStore !== undefined },
    sessionQuery: { present: () => state.expertGroupSessionQuery !== undefined },
    connection: { describe: () => state.connectionChannel.describe() },
  });
  state.capabilityReport = capabilityReport;
  Object.assign(state, capabilityReport);

  const runtimeDiagnostics = createRuntimeDiagnostics({
    host: { lineage: host.lineage, handoff: host.handoff, notifications: host.notifications },
    settings: { describe: () => state.settingsRuntime.describe() },
    storage: {
      describe: () => state.storageBinding.describe(),
      readLastEventRestore: () => state.readLastFanoutEventRestore(),
    },
    recovery: { describe: () => state.recovery.describe(), activationCount: state.activationCount, recordCount: state.recordCount },
    fanout: { getFanoutHost: () => state.fanoutHost },
    roles: { activeRoles: state.activeRoles },
    delegation: {
      activeTaskCounts: () => state.delegationTracker.activeTaskCounts(),
      readLastRefusedScopeRelease: state.readLastRefusedScopeRelease,
    },
    observability: {
      rpcErrors: () => state.rpcErrorTracker.snapshot(),
      systemToast: () => state.systemToast,
      imageRoutes: () => state.describeImageRouteState(),
      rootWait: {
        describeAll: () => (typeof state.rootTurnWaits.describeAll === "function" ? state.rootTurnWaits.describeAll() : []),
        diagnostics: () => state.rootWaitDiagnostics(),
      },
    },
  });
  state.runtimeDiagnostics = runtimeDiagnostics;
  Object.assign(state, runtimeDiagnostics);

  /**
   * legacy HTTP 的 exact route handler（票据 20 R4f 范围）：
   * method / Origin / content-type / body 读取仍由 HTTP 传输负责，业务结果与
   * Connection 通道共用同一个 dispatchRpcAction。
   */
  async function handleRpc(req, res) {
    const requestLifecycle = createRpcRequestLifecycle(req, res);
    const { sendJson, sendError, sameOrigin, contentTypeAllowed } = state.rpcHttp;
    try {
      if (req.method !== "POST") { sendError(res, 405, "method-not-allowed", "仅支持 POST"); return; }
      if (!sameOrigin(req)) { sendError(res, 403, "forbidden", "仅允许 loopback 同源请求（Origin 与 Host 不一致或非 loopback）"); return; }
      if (!contentTypeAllowed(req)) { sendError(res, 415, "unsupported-media-type", "仅支持 application/json"); return; }

      const imageRequest = req.headers["x-dsh-expert-group-image"] === "1";
      const raw = await host.rpc.readBody(req, { imageRequest });
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        throw new BadJsonError("请求体不是合法 JSON");
      }
      await state.dispatchRpcAction(body, requestLifecycle.signal, (status, value) => sendJson(res, status, value), { imageRequest });
    } catch (error) {
      const mapped = state.mapRpcError(error, requestLifecycle.signal);
      sendError(res, mapped.status, mapped.code, mapped.message, mapped.details);
    } finally {
      requestLifecycle.dispose();
    }
  }
  state.handleRpc = handleRpc;

  return [{
    kind: "effect",
    label: "dsh-expert-group: rpc route",
    factory: () => webServer.register({
      kind: "exact",
      path: RPC_PATH,
      // Connection 已安装或安装失败时均拒绝 legacy route，避免旁路 browser-auth/token fence。
      handler: (req, res) => (state.connectionChannel.isActive() || state.connectionChannel.isRegistrationFailed())
        ? state.rpcHttp.sendError(res, state.connectionChannel.isRegistrationFailed() ? 503 : 404, "connection-required", "请通过 DSH Connection RPC 调用此 endpoint")
        : handleRpc(req, res),
    }),
  }];
}
