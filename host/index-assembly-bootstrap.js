/**
 * 入口装配段 1（票据 21b · R4-21）：装配前言 / 通知、root 等待、handoff 与 finalize、
 * settings-storage 读源、role 工具同步命令、storageDomain 绑定与用量归属。
 *
 * ## 设计边界（与票据 21b 的三条铁律逐条对应）
 * 1. **注册点留在入口**：本模块**不调用** `ctx.on` / `ctx.effect` / `ctx.inject` /
 *    `tools.register`。每个 `assembleXxx` 只做「域构造 + 注册 adapter 的构造」，并以
 *    **有序数组**返回注册描述（`{kind, ...}`）；由入口按数组顺序逐项登记。数组顺序 =
 *    迁移前 `index.js` 中这些语句的出现顺序，因此事件名 / label / `{prepend:true}` /
 *    相对顺序逐项不变。
 * 2. **域构造外移**：`createXxxDomain({ ...长实参对象... })` 的实参组装整体搬到这里，
 *    入口只拿返回的域句柄。
 * 3. **不整包传 ctx**：本模块只接收 `state`（per-apply 装配状态容器）与 `caps`
 *    （入口具名能力面，≤8 项）。`caps.subscribe` 只服务「嵌套在 effect 工厂里的动态
 *    订阅」——它的调用点仍是入口的那一个箭头函数，本模块拿不到 ctx 本体。
 *
 * ## 为什么用 state 对象而不是模块级变量
 * 一个进程会并发装配多个插件实例（测试 Host 并行），任何模块级 `let` 都会让实例互
 * 相污染。state 由入口在每次 apply 时新建，等价于迁移前 apply 内的词法作用域。
 *
 * ## 晚绑定
 * `settingsSource` / `source` / `fanoutHost` / `expertCore` / `roleTools` 等指向
 * apply 后段才就绪的对象：它们只以 state 槽位或取值函数形式出现，绝不在构造期求值，
 * 与迁移前的闭包语义逐字等价。
 *
 * @module dsh-expert-group/host/index-assembly-bootstrap
 */
import { createIndexPrelude } from "./index-prelude.js";
import { createSystemToastChannel } from "./index-toast.js";
import { SETTINGS_NAMESPACE } from "./settings-schema.js";
import { shouldBlockGlobalExpertSendMessage } from "./expert-child-composition.js";
import { createRootWaitDomain } from "./index-root-wait.js";
import { createHandoffDomain } from "./index-handoff.js";
import { createFinalizeDomain } from "./index-finalize.js";
import { rootNotificationLabel } from "./expert-group-runtime.js";
import { createIndexSettingsStorageDomain, tableEntries } from "./index-settings-storage.js";
import { createIndexUsageAttributionDomain } from "./index-usage-attribution.js";

/**
 * 装配前言域 + 系统通知通道 + 目录代次观察点 + 生命周期清理 effect（票据 15 原注册顺序）。
 *
 * 注册顺序（迁移前逐项一致）：guard effect → 两个目录事件 → settings/document-updated →
 * settings 运行时 dispose → rpc 错误诊断清理 → toast 释放 → host 组合释放 →
 * root 代次清理。
 *
 * @param {object} state 装配状态容器（本段写入 prelude 能力面与通知通道能力面）。
 * @param {object} caps 入口具名能力面。
 * @returns {Array<object>} 有序注册描述。
 */
export function assemblePrelude(state, caps) {
  const { config, logger, services } = state;
  const { tools, agents, settings } = services;
  const registrations = [];

  /**
   * 入口装配前言域（票据 15）：settings 提交边界、角色目录视图、委派跟踪器、
   * Host 组合、系统通知适配器、持久化健康与 root 代次表。
   *
   * 域服务只返回能力面；ctx.on / ctx.effect 的注册与 disposer 顺序由入口按本函数返回的
   * 数组顺序完成（票据 15 铁律 1），域服务不接收 ctx。
   */
  const prelude = createIndexPrelude({
    config,
    logger,
    settings,
    agents,
    // 晚绑定：root 身份判定、fan-out Host 与卸载闩都在 apply 后段才就绪。
    isRootAgent: (agent) => state.isRootAgentIdentity(agent),
    getFanoutHost: () => state.fanoutHost,
    isTurnWaitStopping: () => state.isRootWaitStopping(),
  });
  const {
    settingsRuntime,
    rpcErrorTracker,
    systemToast,
    host,
    rootGenerationRegistry,
  } = prelude;
  // 其余能力面（角色目录、委派跟踪器、持久化健康…）整份挂到状态容器，后续装配段按需解构。
  Object.assign(state, prelude);

  // RC1 PTC 的 nested dispatch 仍携带外层 execution.agent；全局 guard 必须在工具
  // body 前拦截 scope-local send_message，但只针对 lineage 匹配的插件专家 child。
  if (typeof tools?.guard === "function") {
    registrations.push({
      kind: "effect",
      label: "dsh-expert-group: expert child send_message guard",
      factory: () => {
        const disposeGuard = tools.guard((execution) => shouldBlockGlobalExpertSendMessage(execution));
        return () => disposeGuard?.();
      },
    });
  }
  // 目录代次观察点：0.1.7 的 `settings/document-updated` 只有 (ns, revision) 两个参数，
  // 注册世代事件已从宿主删除。任何外部 settings 文档变化都会推进代际。
  for (const event of ["llm/adapters-updated", "credentials/reference-updated"]) {
    registrations.push({ kind: "on", event, handler: () => settingsRuntime.bumpGeneration() });
  }
  registrations.push({
    kind: "on",
    event: "settings/document-updated",
    handler: (namespace, revision) => {
      // 本插件自己的 settings 写入不改变 LLM 目录，不能让它把本提交误判为过期。
      if (namespace === SETTINGS_NAMESPACE) return;
      settingsRuntime.noteDocumentUpdate(namespace, revision);
    },
  });
  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: model directory registration state",
    factory: () => () => settingsRuntime.dispose(),
  });
  // 生命周期清理：卸载后不再保留任何错误类别记录（诊断只是内存投影，不落盘）。
  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: rpc error diagnostics",
    factory: () => () => rpcErrorTracker.clear(),
  });

  /**
   * 系统通知（Toast）域（票据 15）：把已发布的结论渲染成固定文案并投递。
   * settingsSource 在后续装配段才就绪，因此以取值函数注入（保持原闭包语义）。
   */
  const notificationChannel = createSystemToastChannel({
    config,
    logger,
    systemToast,
    readSettings: () => state.settingsSource(),
    // 宿主 locale 兜底：Cordis 对未声明属性会抛，读取必须容错。
    readCtxLocale: () => caps.readCtxLocale(),
  });
  Object.assign(state, notificationChannel);

  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: windows system toast",
    factory: () => () => {
      if (typeof systemToast?.dispose === "function") void systemToast.dispose();
    },
  });
  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: host module composition",
    factory: () => () => { void host.dispose(); },
  });
  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: root generation state",
    factory: () => () => rootGenerationRegistry.clear(),
  });
  return registrations;
}

/**
 * root 等待域（票据 15）：等待账本、活动作废索引、用户等待账记、后代查询 seam 与收口投递诊断。
 *
 * 三个 agent 事件的 `ctx.effect` + `ctx.on` 注册（created → status → disposed 按序注册、
 * 逆序释放，最后复位「已安装」标记）由域在**首次查询前**惰性安装，因此不能预先登记：
 * 域只把 handlers 交给入口能力面 `caps.registerRootWaitActivityListeners`，实际注册语句
 * 仍写在 index.js（迁移前的注册点就是那段闭包）。
 *
 * @param {object} state 装配状态容器。
 * @param {object} caps 入口具名能力面。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleRootWait(state, caps) {
  const { config, logger, services } = state;
  const { agents, subagents } = services;
  const {
    host,
    notificationHost,
    rootGenerationRegistry,
    delegationTracker,
    notificationLocale,
    sendSystemToast,
    localizedTerminationToast,
    terminationNotificationEventType,
  } = state;
  const registrations = [];

  // 注入形态按能力组组织（票据 32 · C3 收窄）：8 组，逐组聚合理由见 createRootWaitDomain 的注释。
  const rootWaitDomain = createRootWaitDomain({
    config,
    // ① 宿主生命周期权威：lineage 活性 / 终止快照 / root 代次。
    host: { host, notificationHost, rootGenerationRegistry },
    // ② root-scoped 代理事实：live Agent 表 + 权威 listDescendants seam。
    agents: { agents, subagents },
    // ③ 诊断日志。
    diagnostics: { logger },
    // ④ child 完成后的收口写面：活动范围释放 + 等待账本结算。
    delegation: {
      delegationTracker,
      // handoff 域的 child 结算入口在 apply 后段才就绪；构造期只保存取值函数，
      // 调用发生在运行期（与迁移前的 hoisted function 语义一致）。
      settleFinishedChildTurnWaits: (agent, snapshot) => state.settleFinishedChildTurnWaits(agent, snapshot),
    },
    // ⑤ 用户可见通知：文案语言 / 投递通道 / 终止文案与事件类别。
    notification: {
      locale: notificationLocale,
      sendSystemToast,
      localizedTerminationToast,
      terminationNotificationEventType,
    },
    // ⑥ 组合根注册 adapter（铁律 2）：域自己决定安装时机（首次查询前、只装一次），
    //    这里只把 handlers 交给入口能力面；ctx.effect + 三个 ctx.on 的实际调用点仍写在 index.js。
    hostEvents: {
      registerActivityListeners: (handlers) => caps.registerRootWaitActivityListeners(handlers),
    },
    // ⑦ 宿主扩展点访问：探针与调用必须在组合根完成——严格 Cordis Context 对未声明属性会抛，
    //    且调用需要以宿主 ctx 为 this。两者都保持迁移前的 try/catch 语义。
    waterfall: {
      hasWaterfall: () => caps.hasWaterfall(),
      invokeWaterfall: (payload, inner) => caps.invokeWaterfall(payload, inner),
    },
  });
  // 能力面整份挂到状态容器（后续装配段按需解构，等价于迁移前的同一闭包变量）。
  Object.assign(state, rootWaitDomain);
  state.rootWaitDomain = rootWaitDomain;
  const { isRootAgentIdentity } = rootWaitDomain;

  const roots = typeof agents?.roots === "function" ? agents.roots() : [];
  for (const root of roots) {
    if (isRootAgentIdentity(root) && typeof root.id === "string") {
      host.lineage.activateRoot(root);
      host.lineage.tokenFor(root);
      rootGenerationRegistry.activate(root.id, root);
      // 恢复出的 root 只建立空状态：不能继承同 id 旧 root 遗留的终止快照。
      notificationHost.activateRoot({ rootId: root.id, generation: rootGenerationRegistry.generationOf(root.id) });
    }
  }
  return registrations;
}

/**
 * handoff 域 + finalize 收口域（票据 15）。
 *
 * 状态唯一 owner 在各自模块；本段返回三个 root-only 工具注册与 turn-stopping 兜底注册。
 * F6（root/child guard 安装）不在本段，见 `index-assembly-guards.js`。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleHandoffAndFinalize(state) {
  const { logger } = state;
  const { agents } = state.services;
  const {
    host,
    rootTurnWaits,
    delegationTracker,
    isRootAgentIdentity,
    isLiveRootAgent,
    isRootWaitStopping,
    noteRootWaitDelivery,
    noteRootWaitAbandon,
    writeRootUserWait,
    snapshotRootTurnDescendants,
    logTurnWaitError,
    sendSystemToast,
    localizedUserWaitToast,
    rootGenerationRegistry,
  } = state;

  // 注入形态按能力组组织（票据 32 · C3 收窄）：7 组，逐组聚合理由见 createHandoffDomain 的注释。
  const handoffDomain = createHandoffDomain({
    host: { host },
    agents: { agents },
    diagnostics: { logger },
    // 自动恢复域的状态与入口在 apply 后段才就绪；这里只交出取值函数（调用期解析）。
    recovery: {
      getRecoveryRecord: (childId) => state.recoveryDomain.getRecord(childId),
      readChildActivation: (id) => state.recoveryDomain.readChildActivation(id),
      canAutoRecover: (record, reason, hasOutput) => state.recovery.canAutoRecover(record, reason, hasOutput),
    },
    // admission 工作项的结算写面（登记时 track、终态时 settle）。
    admission: { rootTurnWaits },
    // child turn/end 的后续处理：活动范围释放 + 恢复域统一入口。
    turnEnd: {
      delegationTracker,
      handleChildTurnEnd: (...args) => state.handleChildTurnEnd(...args),
    },
    identity: { isRootAgentIdentity, isLiveRootAgent },
  });
  Object.assign(state, handoffDomain);
  state.handoffDomain = handoffDomain;

  // 注入形态按能力组组织（票据 33 · C3 收窄）：7 组，逐组聚合理由见 createFinalizeDomain 的注释。
  const finalizeDomain = createFinalizeDomain({
    host: { host },
    // root 等待域的全部读写 seam（账本 / 卸载闩 / 登记 / 投递诊断 / 后代查询）。
    rootWait: {
      rootTurnWaits,
      isRootWaitStopping,
      writeRootUserWait,
      noteRootWaitDelivery,
      noteRootWaitAbandon,
      snapshotRootTurnDescendants,
    },
    // root 身份与代次：live 判定 / 结构身份 / 代次表。
    identity: { isLiveRootAgent, isRootAgentIdentity, rootGenerationRegistry },
    // 诊断日志：宿主 logger 与等待路径告警包装。
    diagnostics: { logger, logTurnWaitError },
    // admission 批次状态：暂停标记 + 批次只读读取。
    admission: {
      // handoff 域在本函数内刚刚装配：从状态容器取（等价于迁移前的局部 const）。
      markHandoffAdmissionPaused: handoffDomain.markHandoffAdmissionPaused,
      // 自动恢复域的 admission 批次表在 apply 后段才就绪；调用期解析（同一闭包语义）。
      getAdmissionBatch: (parent) => state.recoveryDomain.getAdmissionBatch(parent),
    },
    // 用户可见通知：投递 / 文案 / 标签。
    notification: { sendSystemToast, localizedUserWaitToast, rootNotificationLabel },
    delegation: { delegationTracker },
  });
  Object.assign(state, finalizeDomain);
  state.finalizeDomain = finalizeDomain;

  // 三个 root-only 工具的注册仍按原注册顺序（finalize → scope diagnosis → abandon wait）。
  return [
    { kind: "tool", definition: finalizeDomain.finalizeTool, label: "dsh-expert-group: root finalization tool" },
    { kind: "tool", definition: finalizeDomain.scopeDiagnosisTool, label: "dsh-expert-group: scope diagnosis tool" },
    { kind: "tool", definition: finalizeDomain.abandonWaitTool, label: "dsh-expert-group: abandon wait ledger tool" },
    // turn-stopping 兜底：handler 在域服务里，注册复用它。
    { kind: "on", event: "agent/turn-stopping", handler: finalizeDomain.onTurnStopping },
  ];
}

/**
 * settings 读源 + storage 写入域（票据 16）。
 *
 * 本段创建 settings/storage 域、两个晚绑定只读别名（`settingsSource` / `source` 由状态
 * 容器提供的稳定 wrapper 承担）与三个可选服务注入的注册描述。
 *
 * @param {object} state 装配状态容器。
 * @param {object} caps 入口具名能力面。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleSettingsStorage(state, caps) {
  const { logger } = state;
  // settings/storage 域的纯表读取面：模板存储与 fan-out RPC 读都复用它，由状态容器转发。
  state.tableEntries = tableEntries;
  const { host, storageBinding, persistenceHealth, roleCatalog, activeRoles } = state;
  const registrations = [];

  const settingsStorage = createIndexSettingsStorageDomain({
    logger,
    storageBinding,
    lineage: host.lineage,
    roles: { roleCatalog, activeRoles },
    persistenceHealth,
    getFanoutHost: () => state.fanoutHost,
    onStorageRestored: () => state.fanoutWaits?.reconcileFanoutGoalHandoffs(),
  });
  Object.assign(state, settingsStorage);
  state.settingsStorage = settingsStorage;

  // 冷根会话没有 live Agent；可选 sessionQuery 让 Expert Group 精确读取该会话日志。
  // 绑定跟随提供服务的 fiber 释放，getter 让后创建的 runtime 始终看到当前 generation。
  registrations.push({
    kind: "inject",
    deps: ["sessionQuery"],
    callback: (queryCtx) => {
      let service;
      try { service = queryCtx?.sessionQuery; } catch { return; }
      if (service === void 0 || service === null) return;
      state.expertGroupSessionQuery = service;
      const bindEffect = typeof queryCtx?.effect === "function" ? queryCtx.effect.bind(queryCtx) : caps.effect;
      bindEffect(() => () => {
        if (state.expertGroupSessionQuery === service) state.expertGroupSessionQuery = void 0;
      }, "dsh-expert-group: session query binding");
    },
  });
  // 附件服务是可选组合能力：没有挂载时不影响文本专家加载，但无扩展名图片
  // 必须在真正投递前明确失败，不能把原始 ref 伪装成 PNG。
  registrations.push({
    kind: "inject",
    deps: ["attachments"],
    callback: (attachmentCtx) => {
      // 严格/旧 Host 可能以可选注入回调传入没有该服务的 context；
      // 读取失败只代表能力缺失，不能让文本专家和设置页加载失败。
      let store;
      try { store = attachmentCtx?.attachments; } catch { return; }
      if (store === void 0 || store === null) return;
      state.attachmentStore = store;
      attachmentCtx.effect(() => () => {
        if (state.attachmentStore === store) state.attachmentStore = void 0;
      }, "dsh-expert-group: attachment service binding");
    },
  });
  // 没有任何写入者时也消费拒绝结果，避免未提供服务时产生未处理 rejection；写入者仍收到原错误。
  registrations.push({
    kind: "effect",
    label: "dsh-expert-group: storage initialization gate",
    factory: () => () => {
      state.failStorageInitialization(new Error("storage domain service was never provided"));
    },
  });
  return registrations;
}

/**
 * role 工具同步命令（票据 18）：让工具面与提示词与当前角色目录保持一致（幂等）。
 *
 * 命令本体在这里，但挂载/卸载与提示词刷新由装配后段（`index-assembly-tools.js`）注入到
 * 状态容器的 `mountRole` / `refreshRoutingPrompt` 等槽位；因此 `roleToolsReady` 之前
 * 调用恒为 no-op（与迁移前一致）。
 *
 * @param {object} state 装配状态容器。
 */
export function assembleRoleToolSync(state) {
  state.syncRoleTools = () => syncRoleTools(state);
}

/**
 * 幂等同步：#1 定义签名变化的角色先卸载；#2 不在启用集合里的角色卸载；
 * #3 逐个挂载启用角色；#4 fanout 工具按当前 role 枚举重挂载；#5 重建 routing 提示词。
 */
function syncRoleTools(state) {
  if (!state.roleToolsReady) return;
  const desired = new Set(state.activeRoles());
  // 定义变更先卸载：工具描述/静态元数据只在注册时生成，定义签名变化时
  // mountRole 的"已挂载"短路会让工具面陈旧。
  for (const role of desired) {
    if (!state.roleTools.isMounted(role)) continue;
    const entry = state.roleCatalog().get(role);
    if (entry === undefined) continue;
    if (state.roleTools.signatureOf(role) === state.roleTools.roleDefinitionSignature(entry)) continue;
    state.unmountRole(role);
  }
  for (const role of state.roleTools.mountedRoleIds()) {
    if (role === "fanout" || desired.has(role)) continue;
    state.unmountRole(role);
  }
  for (const role of desired) state.mountRole(role);
  // fanout 的 role 枚举与描述在注册时生成：重挂载保证枚举与当前启用集合同源。
  if (state.roleTools.isMounted("fanout")) {
    state.unmountFanoutTool();
    state.mountFanoutTool();
  }
  state.refreshRoutingPrompt();
}

/**
 * storageDomain 绑定（票据 16）：每次回调建立独立 generation；失效先脱离旧 handle，
 * 再等待 open/close，迟到 Promise 不能安装或修改替代 binding。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleStorageDomainBinding(state, caps) {
  return [{
    kind: "inject",
    deps: ["storageDomain"],
    callback: (domainCtx) => {
      let storageDomain;
      try { storageDomain = domainCtx?.storageDomain; } catch (error) {
        state.failStorageInitialization(new Error("storage domain injection failed", { cause: error }));
        return;
      }
      const attachment = state.settingsStorage.attachStorageDomain(storageDomain);
      if (attachment === null) return;
      // 嵌套注册：外层 ctx.inject 的登记点仍在入口；这里的 effect 用入口绑定的能力面，
      // 与迁移前「在 inject 回调里直接 ctx.effect」逐字等价。
      caps.effect(() => attachment.dispose, "dsh-expert-group: storage domain lifecycle");
    },
  }];
}

/**
 * 用量归属 + 台账接线（票据 17）。
 *
 * @param {object} state 装配状态容器。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleUsage(state) {
  const { logger } = state;
  const { agents } = state.services;
  const { host, getRecord, roleLabelOfRole } = state;

  const usageDomain = createIndexUsageAttributionDomain({
    logger,
    records: { getRecord },
    // settings/storage 域与 modelRoute 在 apply 后段才就绪：只交出调用期解析的取值函数。
    storage: {
      readSnapshot: () => state.source(),
      writeChildModelPatch: (...args) => state.writeChildModelPatch(...args),
      domainSnapshot: () => host.storage.domainSnapshot(),
    },
    agents,
    lineage: host.lineage,
    roles: { roleLabelOfRole },
    childModelPatch: {
      routeFieldsOfMarker: (...args) => state.routeFieldsOfMarker(...args),
      structuredRequestedOfRequest: (...args) => state.expertCore?.structuredRequestedOfRequest(...args),
      validSubagentProviderName: (...args) => state.expertCore?.validSubagentProviderName(...args),
      flushPendingStructuredPatch: (...args) => state.expertCore?.flushPendingStructuredPatch(...args),
    },
  });
  Object.assign(state, usageDomain);
  const { observeUsageEvent, finishUsage, disposeUsageLedger } = usageDomain;

  return [
    {
      kind: "effect",
      label: "dsh-expert-group: usage ledger",
      factory: () => () => {
        // 卸载时清定时器并尽量把最后一个脏条目写出去；返回的 promise 不阻塞卸载。
        disposeUsageLedger();
      },
    },
    // 专用 session/event 与 agent/disposed 监听仍在原注册顺序。
    { kind: "on", event: "session/event", handler: (session, event) => observeUsageEvent(session, event) },
    { kind: "on", event: "agent/disposed", handler: ({ agent } = {}) => finishUsage(agent) },
  ];
}
