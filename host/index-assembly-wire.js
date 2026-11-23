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
 * 宿主子代理并发名额的只读窄命令（meta 投影）。
 *
 * 为什么放在装配层而不是 RPC 核心：名额缓存的唯一 owner 是 `host/settings-source`
 * 模块（composition 的 `settings` 槽位）。这里只交出**调用期解析**的窄命令，RPC 核心
 * 因此不需要新增本地 import，也不需要知道名额缓存在哪。
 *
 * 默认值 64 不再由运行期写入提供：它由 bundle 补丁（`cordis.patch.yml` 的
 * `- id: subagent` 覆盖项）在安装时声明，用户仍可在 profile / home patch / CLI overlay
 * 覆盖。这里只负责把「宿主当前名额」如实投影给 meta：读不到名额时 cap 为 null、
 * 生效值等于配置值（不封顶）。
 *
 * @param {object} host - 宿主模块装配记录（`createHostComposition` 的返回值）。
 * @returns {{hostCapacityProjection: Function}}
 */
function hostCapacityReadsOf(host) {
  // composition 的 settings 槽位在装配前同步创建（与本文件其它 host.* 用法同一前提）。
  const settingsSourceModule = host.settings;
  return {
    /**
     * meta 投影：只投影宿主子代理名额本身（`maxActiveSubagents`），读不到时为 null。
     *
     * 惰性兼容输入：fan-out 时代这里还会把「用户配置的默认并发」按名额封顶后一并投影
     * （effectiveRoleConcurrencyLimit）。roleConcurrencyLimit 已随 fan-out 退役，没有任何
     * 运行期上限来源，因此不再有可封顶的配置值——名额只按事实投影，不伪造「生效并发」。
     */
    hostCapacityProjection: () => {
      const hostConcurrencyCap = settingsSourceModule.hostConcurrencyCap();
      return {
        hostConcurrencyCap: hostConcurrencyCap === undefined ? null : hostConcurrencyCap,
      };
    },
  };
}

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
      isActiveRole: state.isActiveRole,
      // 会话覆盖读写的「该会话是否有 live root」判定。原实现来自已删除的 fan-out 读根解析
      // （createFanoutRpcReads.fanoutRpcRootSession），这里用 lineage 的当前代次 root 加上
      // 既有 live 判定组合出等价语义：在线且不是任何父会话的子代理时才返回该 root。
      liveRootSession: (sessionId) => {
        let root;
        try { root = host.lineage?.activeRoot?.(sessionId); } catch { root = void 0; }
        return root !== void 0 && root !== null && state.isLiveRootAgent?.(root) === true ? root : void 0;
      },
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
      isActiveRole: state.isActiveRole,
      // 宿主子代理名额的只读投影（meta），实现见本文件的 hostCapacityReadsOf；
      // owner 仍是 host/settings-source 模块（默认值 64 由 bundle 补丁声明）。
      ...hostCapacityReadsOf(host),
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
    // 动作共用同一个 deps 命名空间：这样 RPC 核心的能力组仍是已签核的 7 组，不新增第 8 个
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
    // settings 读面只交出提交代次/在途写入的只读投影。
    // 惰性兼容输入：fan-out 退役后不再有任何运行期并发上限来源，诊断面的 default/roles/
    // providers 因此固定为中性值（见 host/index-runtime-diagnostics.js），这里不再派生读面。
    settings: {
      describe: () => state.settingsRuntime.describe(),
    },
    storage: {
      describe: () => state.storageBinding.describe(),
      // 普通 session/child 写入（session_overrides / child_models）的健康快照：与
      // storageBinding 同属既有 storage 协作面，因此不新增能力组。fan-out 物理删除后
      // 装配不再提供 fanout 依赖；持久化诊断段（lastFailure/lastSuccess/失败分类/连续
      // 失败计数）改由这里读取组合根唯一持有的 persistenceHealth（只读 describe）。
      persistenceHealth: () => state.persistenceHealth.describe(),
    },
    recovery: { describe: () => state.recovery.describe(), activationCount: state.activationCount, recordCount: state.recordCount },
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
