/**
 * 入口 root 等待域（R4a · 票据 15）。
 *
 * 这一域持有 **root turn 等待登记表**及其外部事实来源：
 * - 账本 `rootTurnWaits`（host/turn-wait.js）——唯一 owner 在本模块；
 * - 活动作废表 `rootWaitInvalidators` / `rootWaitActivityListenersInstalled`；
 * - 用户等待 `pendingUserWaits` 与卸载闩 `turnWaitStopping`；
 * - 后代查询的权威/降级两条 seam；
 * - 收口结论投递诊断（`lastRootWaitDelivery` / `rootWaitAbandonCount`）。
 *
 * ## 组合根保留的职责（票据 15 铁律 1/2）
 * `ctx.on` / `ctx.effect` 的注册与 disposer 顺序仍留在 `index.js` 的原注册点：
 * 本模块通过 `registerActivityListeners` 把「三个 agent 事件的注册回调」交回组合根，
 * 自己只决定**何时**安装（首次查询前 + 只装一次）。域服务不接收 `ctx`。
 *
 * ## 语义边界（不得改变）
 * - 静止判定只认权威 listing 的干净完整回答；waterfall 只提供正向证据；
 * - 任何空数组（含 sentinel 透传、第三方 fresh `[]`）一律 `known:false`（fail-closed）；
 * - 提示（长等待 / 查询降级 / 投递失败）只影响投递，绝不改变等待与收口语义。
 *
 * @module dsh-expert-group/host/index-root-wait
 */
import { SESSION_ACTIVITY_NO_PROVIDER } from "./plugin-identity.js";
import { buildRootWaitNotificationText } from "./notification-text.js";
import { createRootTurnWaitRegistry } from "./turn-wait.js";
import { snapshotRunningRootDescendants, collectRuntimeRootDescendants } from "../shared/root-descendants.js";
import { messageIdsOfTurn } from "../shared/turn-settlement.js";
import { rootNotificationLabel } from "./expert-group-runtime.js";
import { PARENT_MARKER } from "./expert-guards.js";

/**
 * 创建 root 等待域能力面。
 *
 * ## 注入形态（票据 32 · C3 收窄：15 项 → 8 组）
 * 参数按**能力组**组织；每组单一关注点，组内成员之所以属于同一组写在段内注释里。
 * 收窄只改注入形态：installer 读到的扁平字段名、判定顺序与全部命令语义逐字不变。
 *
 * 1. `config`：插件 Config（只读 `waitLedgerNotifications` 开关）；
 * 2. `host`：**root 生命周期权威**——`host`（lineage 活性）、`notificationHost`（终止快照）、
 *    `rootGenerationRegistry`（代次）。三者共同回答「这个 root 代次是否还活着、本次终止是否
 *    由权威判定」，缺一不可且都必须来自宿主，故合并为一组；
 * 3. `agents`：**root-scoped 代理事实**——`agents`（live 查询面）与 `subagents`
 *    （权威 listDescendants seam）。二者是「宿主里到底还有谁在跑」的同一事实来源；
 * 4. `diagnostics`：`logger`（只记固定前缀 + 安全错误名）；
 * 5. `delegation`：**child 完成后的收口写面**——`delegationTracker`（释放活动范围）与
 *    `settleFinishedChildTurnWaits`（结算 root 等待账本里的 admission 工作）。两者都只在
 *    「某个 child 已经结束」时被触达，是同一收口关注点的两条写面；
 * 6. `notification`：**用户可见通知**——`locale`、`sendSystemToast`、
 *    `localizedTerminationToast`、`terminationNotificationEventType`。它们是同一条通知
 *    链路（文案 → 本地化 → 投递 → 事件类别），只影响提示、不影响等待语义；
 * 7. `hostEvents`：`registerActivityListeners`（组合根注册 adapter：由 `index.js` 在原注册点
 *    完成 `ctx.effect` + 三个 `ctx.on` 与逆序 disposer）；
 * 8. `waterfall`：**宿主扩展点访问**——`hasWaterfall`（安全探针）与 `invokeWaterfall`
 *    （以宿主 ctx 为 this 调用）。探针与调用必须成对出现，否则会退化成"探到就不能用"。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx），字段见上。
 * @returns {object} 等待域能力面（见文件末尾的返回对象）。
 */
export function createRootWaitDomain(deps) {
  // 账本由本工厂创建（唯一 owner）。它的回调需要三个 installer 的函数，因此先在
  // `getRootTurnWaits` 里留晚绑定占位；installer 依次装配后再实例化。
  let rootTurnWaits;

  /**
   * 命名空间 → 扁平依赖袋。
   *
   * 为什么保留这一层：三个 installer 是**同文件内**的装配层，它们的参数名（`host`、
   * `agents`、`sendSystemToast`…）与日志/快照语义一一对应，改成嵌套读取只会让
   * 2000+ 行内部实现四处变形、放大回归面。收窄的目标是**域工厂的注入面**（跨模块契约），
   * 内部装配层继续消费扁平袋，因此行为不可能改变。
   */
  const flat = {
    config: deps.config,
    host: deps.host.host,
    notificationHost: deps.host.notificationHost,
    rootGenerationRegistry: deps.host.rootGenerationRegistry,
    agents: deps.agents.agents,
    subagents: deps.agents.subagents,
    logger: deps.diagnostics.logger,
    delegationTracker: deps.delegation.delegationTracker,
    settleFinishedChildTurnWaits: deps.delegation.settleFinishedChildTurnWaits,
    notificationLocale: deps.notification.locale,
    sendSystemToast: deps.notification.sendSystemToast,
    localizedTerminationToast: deps.notification.localizedTerminationToast,
    terminationNotificationEventType: deps.notification.terminationNotificationEventType,
    registerActivityListeners: deps.hostEvents.registerActivityListeners,
    hasWaterfall: deps.waterfall.hasWaterfall,
    invokeWaterfall: deps.waterfall.invokeWaterfall,
  };

  const core = installRootWaitCore({ ...flat, getRootTurnWaits: () => rootTurnWaits });
  const queries = installDescendantQueries({ ...flat, logTurnWaitError: core.logTurnWaitError });

  /** 等待账本的用户可见提示开关（票据 11）：只影响提示，不影响等待/收口语义。 */
  const ledgerNotificationsEnabled = flat.config?.waitLedgerNotifications !== false;
  const rootWaitLongToast = () => buildRootWaitNotificationText(flat.notificationLocale, "long");
  const rootWaitQueryDegradedToast = () => buildRootWaitNotificationText(flat.notificationLocale, "queryDegraded");
  const rootWaitDeliveryFailedToast = () => buildRootWaitNotificationText(flat.notificationLocale, "deliveryFailed");

  /**
   * 唯一的 root turn 等待登记表：finalize 与 agent/turn-stopping 兜底共用。
   *
   * 释放条件见 host/turn-wait.js 的模块文档；本处只负责把宿主事实接进来。
   * onLongWait/onIssue 只做用户可见提示（票据 11）：提示失败绝不改变等待语义，
   * 去重与限流也全部由账本负责（记录级一次性 + 30 分钟时间桶）。
   */
  // 账本工厂的注入面同样按能力组组织（票据 32）：clock 与 notifications 是命名空间，
  // 提示开关关闭时整组缺省（与收窄前"不传 onLongWait/onIssue"语义一致）。
  rootTurnWaits = createRootTurnWaitRegistry({
    isLiveRoot: (agent) => core.isLiveRootAgent(agent),
    snapshotDescendants: (rootId) => queries.snapshotRootTurnDescendants(rootId),
    subscribe: (agent, invalidate) => core.subscribeRootActivity(agent, invalidate),
    onKnownSnapshot: (agent, snapshot) => flat.settleFinishedChildTurnWaits(agent, snapshot),
    onError: (error) => core.logTurnWaitError("check", error),
    ...(ledgerNotificationsEnabled ? {
      notifications: {
        onLongWait: () => { flat.sendSystemToast(rootWaitLongToast()); },
        onIssue: (issue) => {
          // kind 由账本固定枚举；未知 kind 静默忽略（绝不猜测文案）。
          if (issue?.kind === "descendant-query-degraded") flat.sendSystemToast(rootWaitQueryDegradedToast());
          else if (issue?.kind === "finalization-delivery-failed") flat.sendSystemToast(rootWaitDeliveryFailedToast());
        },
      },
    } : {}),
  });

  const registry = installRootWaitRegistry({ ...flat, ...core, ...queries, rootTurnWaits, ledgerNotificationsEnabled });

  return {
    ...core,
    ...queries,
    ...registry,
    rootTurnWaits,
  };
}

/**
 * A 组：等待登记表的身份判定、日志、活动作废与登记安装。
 *
 * 这里的可变状态是本模块的唯一 owner：`pendingUserWaits`（WeakMap）、
 * `turnWaitStopping`（卸载闩）、`rootWaitInvalidators`（root id → 作废回调集合）、
 * `rootWaitActivityListenersInstalled`（全局监听只装一次）。
 * 域外只经下方的窄命令读写（见返回对象）。
 *
 * @param {object} deps - 见 `createRootWaitDomain` 的参数说明。
 * @returns {object} A 组能力面。
 */
function installRootWaitCore(deps) {
    const { agents, host, logger, registerActivityListeners, getRootTurnWaits } = deps;

  // 自动完成通知只在 post-boundary 成功 turn/end 处提交；状态机由
  // host/notifications 持有并按 root generation 隔离。
  // 用户问题/计划确认在返回前可能长期等待；按 exact root/session/generation 保留其门控。
  const pendingUserWaits = new WeakMap();
  /**
   * 插件卸载闩：置位后所有等待登记/监听安装/结算路径一律 no-op，避免在
   * fiber 正在清理时又建立新的等待或监听。
   */
  let turnWaitStopping = false;
  /**
   * 异常的安全标签：只保留"看起来像常规错误名"的标识符，其余一律归为 Error/类型名。
   *
   * 为什么需要白名单：错误名同样可能被上游塞入任意文本（例如把整段响应当 name），
   * 因此只接受 ASCII 标识符（含 . 分隔的命名空间形），长度受限；控制字符、换行、
   * 路径分隔符与中文等一律不输出。
   */
  function safeErrorLabel(error) {
    const isObject = error !== null && typeof error === "object";
    const name = isObject ? error.name : undefined;
    if (typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(name)) return name;
    return isObject ? "Error" : typeof error;
  }

  /**
   * 等待登记表的统一异常记录：只输出固定前缀 + 安全错误名，绝不输出 message 原文。
   *
   * 为什么不再拼接 error.message/String(error)：等待路径的异常可能来自宿主 provider、
   * 会话读取器甚至文件系统，message 里可能夹带会话正文、prompt 片段、绝对路径或凭据；
   * 日志只用于回答"哪一步失败、错误类型是什么"，不需要、也不应该承载这些内容。
   */
  function logTurnWaitError(action, error) {
    logger.warn("dsh-expert-group: root turn wait " + action + " failed: " + safeErrorLabel(error));
  }
  function isRootAgentIdentity(agent) {
    return agent !== void 0
      && typeof agent.id === "string"
      && agent.session?.header?.parentSession === void 0
      && agent.options?.[PARENT_MARKER] === void 0;
  }

  function isLiveRootAgent(agent) {
    return host.lineage.isLiveRoot(agent);
  }

  // ── root turn 等待：root-scoped 后代查询与活动监听 ────────────────────────
  /**
   * rootId -> 该 root 等待记录的「作废」回调集合。
   *
   * 用一张按 root id 索引的表而不是「每个 root 装三份监听器」：全局监听只装一次，
   * 事件到达时按血缘链向上找出真正受影响的 root，因此 N 个并发 root 也只有一份监听。
   */
  const rootWaitInvalidators = new Map();
  let rootWaitActivityListenersInstalled = false;

  /** 通知某个 id 上登记的全部作废回调；回调异常不影响事件派发。 */
  function invalidateRootWaitId(id) {
    const listeners = rootWaitInvalidators.get(id);
    if (listeners === void 0) return;
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { logTurnWaitError("invalidate", error); }
    }
  }

  /**
   * 某个 live Agent 上发生活动（创建 / 转入 running / 销毁）时，作废**它自己及其
   * 全部祖先 root** 的等待结论。
   *
   * 为什么按血缘链向上而不是只看 id：child 的 parentSession 可能指向另一个 child
   * （fan-out 分片、嵌套委派），真正需要重新判定的是整条链上仍在等待的 root。
   * 链上出现环或父级不可解析时按 id 逐级命中后停止，绝不无限回溯。
   */
  function invalidateWaitersForAgentActivity(agent) {
    if (rootWaitInvalidators.size === 0) return;
    const visited = new Set();
    let currentId = typeof agent?.id === "string" ? agent.id : void 0;
    let parentId = agent?.session?.header?.parentSession;
    // 起点自身也要作废：root 自己的记录同样可能已经放行，需要重新判定。
    while (typeof currentId === "string" && currentId.length > 0 && !visited.has(currentId)) {
      visited.add(currentId);
      invalidateRootWaitId(currentId);
      if (typeof parentId !== "string" || parentId.length === 0) break;
      const parent = agents.get(parentId);
      currentId = parentId;
      parentId = parent?.session?.header?.parentSession;
    }
  }

  /**
   * 安装本 root 的活动监听（登记表的 subscribe 契约：必须在首次状态查询**之前**
   * 同步完成）。
   *
   * 监听面（全部是宿主公开事件）：
   * - `agent/created`：新 child 出现即作废静止结论；
   * - `agent/status`：转入 running 即作废（状态转 idle/ready 不产生新工作，但同样
   *   作废一次是安全且廉价的——判定会重新读 root-scoped 事实）；
   * - `agent/disposed`：child 消失后重新判定。
   *
   * @returns {() => void} 移除本次订阅（不动全局监听器：它们由插件 effect 统一释放）。
   */
  function subscribeRootActivity(agent, invalidate) {
    if (turnWaitStopping || typeof agent?.id !== "string" || agent.id.length === 0) return () => {};
    const rootId = agent.id;
    let listeners = rootWaitInvalidators.get(rootId);
    if (listeners === void 0) {
      listeners = new Set();
      rootWaitInvalidators.set(rootId, listeners);
    }
    listeners.add(invalidate);
    installRootWaitActivityListeners();
    return () => {
      const current = rootWaitInvalidators.get(rootId);
      if (current === undefined) return;
      current.delete(invalidate);
      if (current.size === 0) rootWaitInvalidators.delete(rootId);
    };
  }

  /**
   * 新建子代理时把它的祖先 root 登记进等待体系。
   *
   * 只沿 `session.header.parentSession` 血缘链向上找**最近的一个 root 身份 Agent**；
   * 链上出现环、父级不在 live registry 或链条结束都直接停止（绝不臆造归属）。
   * root 自身不 engage 自己（root 创建不意味着有子代理在跑）。
   *
   * @param {object} agent - 刚创建的 Agent。
   */
  function engageRootTurnWaitForCreatedAgent(agent) {
    if (turnWaitStopping) return;
    if (agent === null || typeof agent !== "object") return;
    if (isRootAgentIdentity(agent)) return;
    const visited = new Set();
    let parentId = agent.session?.header?.parentSession;
    while (typeof parentId === "string" && parentId.length > 0 && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = agents.get(parentId);
      if (parent === void 0) return;
      if (isRootAgentIdentity(parent)) {
        if (isLiveRootAgent(parent)) getRootTurnWaits().engage(parent);
        return;
      }
      parentId = parent.session?.header?.parentSession;
    }
  }

  /** 全局活动监听只装一次；由插件 effect 在卸载时释放。 */
  function installRootWaitActivityListeners() {
    if (rootWaitActivityListenersInstalled || turnWaitStopping) return;
    rootWaitActivityListenersInstalled = true;
    // 注册与 disposer 顺序由组合根在**原注册点**完成（票据 15 铁律 1/2）：
    // agent/created → agent/status → agent/disposed 按此顺序注册，释放时逆序，
    // 最后复位「已安装」标记（与迁移前的 disposer 顺序逐字一致）。
    registerActivityListeners({
      onActivity: invalidateWaitersForAgentActivity,
      onDispose: () => { rootWaitActivityListenersInstalled = false; },
    });
  }
    /**
   * 登记/覆盖一个 root 用户等待，返回被替换的旧登记。
   *
   * 为什么返回旧登记：唯一调用点（finalize 的 root 用户等待 guard）需要据此判断
   * 「同一次等待重复进入」不重复提示；语义与迁移前直接读写 WeakMap 完全一致。
   */
  function writeRootUserWait(agent, wait) {
    const previous = pendingUserWaits.get(agent);
    pendingUserWaits.set(agent, wait);
    return previous;
  }

  /** 只读取当前登记（不产生写入；供域外读点使用）。 */
  function readRootUserWait(agent) {
    return pendingUserWaits.get(agent);
  }

  /** 删除登记：域外清理点的唯一入口（避免出现第二份可写引用）。 */
  function forgetRootUserWait(agent) {
    pendingUserWaits.delete(agent);
  }

  /** 卸载闩只读取值（域外读点不得直接触碰 let 绑定）。 */
  function isRootWaitStopping() {
    return turnWaitStopping;
  }

  /**
   * 置位卸载闩。置位后所有等待登记 / 监听安装 / 结算路径一律 no-op，
   * 避免 fiber 正在清理时又建立新的等待或监听。
   */
  function stopRootWait() {
    turnWaitStopping = true;
  }

  /** 释放全部 root 的作废回调索引（卸载时唯一清理入口）。 */
  function clearRootWaitInvalidators() {
    rootWaitInvalidators.clear();
  }

  return {
    // 共享状态对象：C 组只读/删登记也走同一份 WeakMap（模块级唯一 owner 仍是本组）。
    pendingUserWaits,
    safeErrorLabel,
    logTurnWaitError,
    isRootAgentIdentity,
    isLiveRootAgent,
    invalidateRootWaitId,
    invalidateWaitersForAgentActivity,
    subscribeRootActivity,
    engageRootTurnWaitForCreatedAgent,
    installRootWaitActivityListeners,
    writeRootUserWait,
    readRootUserWait,
    forgetRootUserWait,
    isRootWaitStopping,
    stopRootWait,
    clearRootWaitInvalidators,
  };
}

/**
 * B 组：root-scoped running 后代查询（等待释放的唯一外部事实来源）。
 *
 * 两条 seam 的优先级与失败语义是**契约**：权威 listing 优先，waterfall 仅作降级回退，
 * 且只有权威 listing 的干净完整回答才能证明静止。本组不持有可变状态。
 *
 * @param {object} deps - 见 `createRootWaitDomain` 的参数说明。
 * @returns {object} B 组能力面（`snapshotRootTurnDescendants` 为唯一对外入口）。
 */
function installDescendantQueries(deps) {
    const { agents, subagents, logTurnWaitError, hasWaterfall, invokeWaterfall } = deps;
  /**
   * root-scoped 的 running 后代查询（等待释放的唯一外部事实来源）。
   *
   * 两条 seam，优先级严格：**权威 listing 优先，waterfall 仅作降级回退**。
   *
   * ### 1) 权威 seam：`subagents.listDescendants(rootSessionId)`
   * `@deepseek-ai/dsh-subagent` 在 `SubagentService` 上公开的递归后代枚举
   * （`listChildren`/`listDescendants`）：按 durable parent catalog 递归遍历，
   * child 行的必填字段是 `kind`、`id`、`mode: "one-shot" | "continuable"`、
   * `activity: "running" | "inactive"`、`hasChildren`、`parentId`、`depth`
   * （`mode: "continuable"` 时另有必填的 `label`）。
   * 它天然只覆盖被询问的 root，并且**失败语义是显式的**：
   * - 整条 listing reject（root catalog 不可读 / 缺少 sessionQuery、sessions、
   *   projection / 被取消）→ 未知；
   * - 某个分支不可读或 catalog 里 `mode: "unknown"` → 该行是
   *   `kind: "diagnostic"` → 无法证明那条分支里没有 running 后代 → 未知
   *   （fail-closed）；未知 `kind` 同样未知；
   * - child 行**不满足公开必填契约**（缺 `mode` / `mode` 非法 / 缺
   *   `hasChildren`、`parentId`、`depth` / continuable 行缺 `label`）→ 整次
   *   listing 不可信 → 未知（fail-closed）；
   * - 正常 resolve、行全部合法且没有任何 diagnostic 行 → `known:true`，此时
   *   「没有 running 后代」是**可证明**的结论。
   *
   * 为什么它是权威 seam：它是唯一一个「没有 provider」与「provider 明确报告空」
   * 在返回结构上就不同（reject / diagnostic vs. 干净的空列表）的公开 API。
   *
   * ### 2) 降级 seam：`workspace/session-activity` waterfall + 独特 sentinel
   * 宿主没有 listing 时退回 waterfall。这条链路**只能提供正向证据，永远不能证明静止**，
   * 两个独立原因都必须处理：
   *
   * **(a) 无 provider（P0）**：Cordis 的 `waterfall` 在**没有任何 listener** 时会
   * 直接调用调用方传入的最内层回调（`(cbs.shift() ?? inner)(...args)`），而宿主
   * subagent provider 在「没有 running 后代」时是 `return rest`（**原样透传**最内层
   * 返回值）。因此「没有 provider」与「provider 报告空」在返回值上完全同形——传空数组
   * 做兜底会把前者误判成 `known:true`。这里用**模块唯一的 sentinel**
   * （`SESSION_ACTIVITY_NO_PROVIDER`，冻结空数组）作为最内层返回值：
   * - 结果 **是** sentinel（对象身份相等）⟹ 没有任何 listener 产生新数组，即
   *   「链路没有贡献任何事实」——既可能是 topic 没有 provider，也可能是 provider
   *   原样透传。两者都无法证明「没有 running 后代」，一律 `known:false`；
   * - 结果 **不是** sentinel 的数组 ⟹ 至少有一个 listener 产出了新数组。注意：解析时
   *   必须跳过 sentinel 自身的元素（它可能被 spread 进结果）。
   *
   * **(b) 其他 listener 的空数组（P1）**：`workspace/session-activity` 是**非专属**
   * 扩展点，任何第三方 listener 都可以返回一个全新的空数组（既不 spread 最内层值，也
   * 不检查 subagent 血缘）。sentinel 只能识别「链路完全没有贡献」，识别不了「是谁贡献
   * 的」，因此非 sentinel 的空数组同样**不能**证明静止。判定层的口径必须是：
   * **任何**空数组（含 fresh `[]`）⟹ `known:false`。
   *
   * 综合结论（不夸大）：waterfall 回退只可能给出「known + running 非空」这一种明确
   * 结论，其余所有形状（sentinel、任意空数组、非空但无 subagent 族、malformed）都是
   * `known:false`。真正可证明的静止**只**来自权威 listing 的干净完整回答。
   *
   * @param {string} rootId - exact root session id。
   * @returns {Promise<{known:boolean,running:object[],runningIds?:Set<string>,reason:string}>}
   */
  /**
   * rc.2 的 Agent.status 只有 `idle` / `running`：只有 `idle` 表示「当前未运行」。
   * `ready` 等历史/非法状态一律走 shared.js 的「状态非法」分支 → `known:false`。
   */
  const TURN_WAIT_RUNTIME_STATUS_OPTIONS = Object.freeze({ idleStatuses: ["idle"] });

  /**
   * runtime agents.list() 的严格 fallback。它只在权威 listDescendants seam 不可用时
   * 使用，并沿用 shared.js 的完整血缘/状态校验；空数组只有在校验明确成功时才是
   * known:true，缺失父链、重复 id 或未知状态仍保持 fail-closed。
   */
  function snapshotRootTurnDescendantsFromRuntimeAgents(rootId) {
    let list;
    try {
      list = agents?.list;
    } catch {
      return void 0;
    }
    if (typeof list !== "function") return void 0;
    const snapshot = snapshotRunningRootDescendants(() => list.call(agents), rootId, TURN_WAIT_RUNTIME_STATUS_OPTIONS);
    return snapshot.known === true
      ? {
        known: true,
        running: snapshot.runningDescendants,
        // 复用既有 child settlement 回退：严格 runtime 快照不仅要告诉等待门控
        // 是否阻塞，还要提供 exact child id 集，才能在缺失完成通知时结算 admission。
        runningIds: new Set(snapshot.runningDescendants.map((agent) => agent.id)),
        ...(snapshot.reason === void 0 ? {} : { reason: snapshot.reason }),
      }
      : {
        known: false,
        running: [],
        reason: snapshot.reason ?? "runtime-descendant-query-unknown",
      };
  }

  async function snapshotRootTurnDescendants(rootId) {
    if (typeof rootId !== "string" || rootId.length === 0) {
    return { known: false, running: [], reason: "root-id-unknown" };
  }
  const listed = await snapshotRootTurnDescendantsFromListing(rootId);
  if (listed !== void 0) return listed;
  const runtime = snapshotRootTurnDescendantsFromRuntimeAgents(rootId);
  if (runtime !== void 0) return runtime;
  return snapshotRootTurnDescendantsFromActivity(rootId);
}

/**
 * `kind: "child"` 行是否满足公开契约（`SubagentDescendantListEntry`）。
 *
 * 公开 schema 定义在 `@deepseek-ai/dsh-subagent` 的 `control-types` 与
 * `list-children`：child 行 = `SubagentCatalogRow`（`id`、`mode`、`activity`，
 * 以及 `mode:"continuable"` 时**必填**的 `label`）
 * `& { kind:"child"; hasChildren:boolean }` `& { parentId; depth }`。因此这里只校验
 * **必填**字段，可选字段（`one-shot` 的 `label`）出现时必须是字符串，其余扩展字段
 * 一概不参与判定——避免把合法 listing 误判成非法而永久等待。
 *
 * **为什么 `mode` 必须校验（P2）**：`mode` 是这条行的生命周期判别字段
 * （`one-shot` | `continuable`）。真实 `listDescendants` 会把 catalog 里
 * `mode:"unknown"` 的条目转成 `kind:"diagnostic"`，所以 child 行出现**缺失**或
 * **非法** `mode` 只可能说明这份 listing 不是公开契约的形状（伪造 / 截断 / 跨版本
 * 错配）。此时 `activity:"inactive"` **不能**作为静止证据：整次结果按未知处理，
 * 等待继续。
 *
 * @param {object} row - listing 里 `kind:"child"` 的一行。
 * @returns {boolean} 满足必填字段契约时为 true。
 */
function isContractChildRow(row) {
  if (typeof row.id !== "string" || row.id.length === 0) return false;
  // mode 枚举：只有这两个取值属于公开契约；缺失 / "unknown" / 任意字符串都非法。
  if (row.mode !== "one-shot" && row.mode !== "continuable") return false;
  // activity 是二值枚举；任何其他取值都说明契约不成立。
  if (row.activity !== "running" && row.activity !== "inactive") return false;
  // label：continuable 行必填；one-shot 行可选，但出现时必须是字符串。
  if (row.mode === "continuable") {
    if (typeof row.label !== "string") return false;
  } else if (row.label !== void 0 && typeof row.label !== "string") {
    return false;
  }
  if (typeof row.hasChildren !== "boolean") return false;
  if (typeof row.parentId !== "string" || row.parentId.length === 0) return false;
  // depth 是从被询问 root 起算的边距离；直接子代为 1，因此必须是正整数。
  if (!Number.isInteger(row.depth) || row.depth < 1) return false;
  return true;
}

/**
 * 权威 seam：`subagents.listDescendants`。
 *
 * @returns {Promise<object|undefined>} 明确回答；seam 不可用时返回 undefined
 *   让调用方回退到 waterfall。
 */
/**
 * 读取 runtime 侧的后代索引（rc.2 严格状态：只有 idle 表示「当前未运行」）。
 *
 * - `agents.list()` 可用：返回同一份 exact runtime 快照里被 shared.js 严格校验过的
 *   后代索引（id → { parentSession, status, node }），逐行 status 判定与 live 后代
 *   覆盖校验都用它；
 * - 该 seam 缺失：`available:false`。此时**无法**用逐行 `agents.get()` 之类的方式补出
 *   等价事实（既拿不到同一份快照，也无法验证 runtime live descendants 是否被 catalog
 *   完整覆盖），调用方必须 fail-closed。真实 rc.2 宿主始终提供 `agents.list()`。
 *
 * @returns {{available:boolean, known?:boolean, reason?:string, descendants?:Map<string,object>}}
 */
function readTurnWaitRuntimeDescendants(rootId) {
  let list;
  try {
    list = agents?.list;
  } catch {
    return { available: false };
  }
  if (typeof list !== "function") return { available: false };
  let snapshot;
  try {
    snapshot = list.call(agents);
  } catch (error) {
    // 列表查询失败：未知，绝不当作「没有 running 后代」。
    logTurnWaitError("runtime-descendant-query", error);
    return { available: true, known: false, reason: "runtime-descendant-query-unknown" };
  }
  const collected = collectRuntimeRootDescendants(snapshot, rootId, TURN_WAIT_RUNTIME_STATUS_OPTIONS);
  return collected.known === true
    ? { available: true, known: true, descendants: collected.descendants }
    : { available: true, known: false, reason: collected.reason ?? "runtime-descendant-identity-unknown" };
}

async function snapshotRootTurnDescendantsFromListing(rootId) {
  let listing;
  try {
    listing = subagents?.listDescendants;
  } catch (error) {
    logTurnWaitError("descendant-listing-probe", error);
    return void 0;
  }
  if (typeof listing !== "function") return void 0;
  let rows;
  try {
    rows = await listing.call(subagents, rootId);
  } catch (error) {
    // root catalog 不可读 / 缺少依赖 / 被取消：**未知**，绝不当作「没人跑」。
    logTurnWaitError("descendant-listing", error);
    return { known: false, running: [], reason: "descendant-listing-failed" };
  }
  if (!Array.isArray(rows)) {
    return { known: false, running: [], reason: "descendant-listing-malformed" };
  }
  // ① 行级公开契约校验 + catalog 树自洽性（重复 id、parentId/depth 链）。
  const catalog = new Map();
  for (const row of rows) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      return { known: false, running: [], reason: "descendant-listing-malformed" };
    }
    // 分支不可读 / catalog 里 mode 未知：那条分支里是否有 running 后代无法证明
    // → 未知（fail-closed）。未知 kind 同样按 malformed 处理。
    if (row.kind === "diagnostic") {
      return { known: false, running: [], reason: "descendant-listing-diagnostic" };
    }
    if (row.kind !== "child") {
      return { known: false, running: [], reason: "descendant-listing-malformed" };
    }
    // child 行的公开契约校验（含 mode 枚举）：任一必填字段不成立 ⟹ 整次 listing
    // 都不可信，绝不能拿其中某行的 activity 当静止/运行证据。
    if (!isContractChildRow(row)) {
      return { known: false, running: [], reason: "descendant-listing-malformed" };
    }
    // 同一 child id 出现两次：无法区分代际，整次 listing 不可信。
    if (catalog.has(row.id)) {
      return { known: false, running: [], reason: "descendant-listing-duplicate-id" };
    }
    catalog.set(row.id, row);
  }
  for (const row of catalog.values()) {
    if (row.parentId === rootId) {
      if (row.depth !== 1) {
        return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
      }
      continue;
    }
    const parent = catalog.get(row.parentId);
    // 父级不在本次 listing 里（catalog 不完整）或 depth 与父级不衔接：血缘冲突 → 未知。
    if (parent === void 0 || parent.depth + 1 !== row.depth) {
      return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
    }
  }
  // ② 运行判定交叉校验：同一份 exact runtime 快照（rc.2 严格状态）。
  // runtime 必须提供**完整**的 agents.list() 快照：listing 只证明 residency，运行判定与
  // 「live 后代是否被 catalog 完整覆盖」都只能用同一份 exact runtime 快照验证。缺该 seam
  // 时不存在安全的兼容回退（逐行 agents.get() 拿不到同一份快照、也做不了覆盖校验）⇒ 未知。
  const runtime = readTurnWaitRuntimeDescendants(rootId);
  if (runtime.available !== true || runtime.known !== true) {
    return {
      known: false,
      running: [],
      reason: runtime.available === true
        ? (runtime.reason ?? "runtime-descendant-identity-unknown")
        : "runtime-agent-listing-unavailable",
    };
  }
  const running = [];
  const runningIds = new Set();
  for (const row of catalog.values()) {
    const live = runtime.descendants.get(row.id);
    if (row.activity === "running") {
      // 声称驻留：运行判定只认同一份 runtime 快照里的 rc.2 `Agent.status`。
      if (live === void 0) {
        return { known: false, running: [], reason: "descendant-listing-runtime-agent-missing" };
      }
      // catalog 血缘必须与 runtime 的直接父会话一致（任一侧缺失同样按冲突处理）。
      if (live.parentSession !== row.parentId) {
        return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
      }
      if (live.status === "running") {
        running.push({ id: row.id });
        runningIds.add(row.id);
        continue;
      }
      if (live.status === "idle") continue;
      // 缺失 / `ready` / 非字符串等非法状态：既不能当成空闲，也不能当成运行 ⇒ 未知。
      return { known: false, running: [], reason: "descendant-listing-runtime-status-invalid" };
    }
    // 自报非驻留（activity:"inactive"）：上游语义是 `sessions.get(id) === undefined`，
    // 即「没有 live Session」——这种 durable 历史行是**合法**的，按「当前未运行」接受。
    // 但只要 runtime 里存在任何 exact live Agent（idle 或 running），residency 就自相矛盾
    // ⇒ 未知（绝不提前放行）。
    if (live !== void 0) {
      return { known: false, running: [], reason: "descendant-listing-activity-conflict" };
    }
  }
  // ③ runtime 里仍 live 的后代必须被 catalog 完整覆盖、必须自报驻留，且血缘一致。
  for (const [id, live] of runtime.descendants) {
    const row = catalog.get(id);
    if (row === void 0) {
      return { known: false, running: [], reason: "descendant-listing-missing-live-descendant" };
    }
    if (row.activity !== "running") {
      return { known: false, running: [], reason: "descendant-listing-activity-conflict" };
    }
    if (row.parentId !== live.parentSession) {
      return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
    }
  }
  return {
    known: true,
    running,
    runningIds,
    reason: running.length > 0 ? "running-descendants" : "no-running-descendants",
  };
}

/**
 * 降级 seam：`workspace/session-activity` waterfall + 独特 sentinel。
 *
 * **本路径只做正向证据**：唯一可能返回的明确结论是「确有 running 的 subagent 后代」
 * （`known:true` 且 `running` 非空），调用方据此**继续等待**。它**永远不返回**
 * `known:true` + 空 `running`——即永远不会证明静止：
 * - 结果 === sentinel ⟹ 链路没有贡献任何事实（无 provider / provider 原样透传）；
 * - 结果是非 sentinel 的**任意空数组** ⟹ 非专属扩展点上无法识别贡献者，可能是任何
 *   第三方 listener 返回的全新 `[]`，它并不保证检查过 subagent 血缘；
 * - 结果非空但没有 `kind === "subagent"` 的 running 条目 ⟹ 贡献事实的是别的族，
 *   或 subagent 族本身为空；
 * - 结果不是数组、或条目结构不合法 ⟹ malformed。
 * 以上四种一律 `known:false`（fail-closed，继续等待）。
 *
 * @returns {Promise<object>} 只有「known + running 非空」或 `known:false` 两种可能。
 */
async function snapshotRootTurnDescendantsFromActivity(rootId) {
  // 严格 Cordis Context 对未声明属性直接抛错，因此这里的读取也必须包在 try 内：
  // 「读取 waterfall 失败」与「宿主没有该服务」是同一件事（未知），一律继续等待。
  if (!hasWaterfall()) {
    return { known: false, running: [], reason: "session-activity-unavailable" };
  }
  let activity;
  try {
    activity = await invokeWaterfall({ sessionId: rootId }, () => SESSION_ACTIVITY_NO_PROVIDER);
  } catch (error) {
    // 任一 provider 抛错都会让整条 waterfall reject：这是**未知**，不是「没人跑」。
    logTurnWaitError("descendant-query", error);
    return { known: false, running: [], reason: "session-activity-failed" };
  }
  if (activity === SESSION_ACTIVITY_NO_PROVIDER) {
    // P0：没有任何 listener 贡献事实——既可能是没有 provider，也可能是 provider
    // 原样透传。两者都无法证明「没有 running 后代」，必须继续等待。
    return { known: false, running: [], reason: "session-activity-no-provider" };
  }
  if (!Array.isArray(activity)) {
    return { known: false, running: [], reason: "session-activity-malformed" };
  }
  if (activity.length === 0) {
    // P1：**任何**非 sentinel 的空数组都不能证明静止。`workspace/session-activity`
    // 是非专属扩展点，任意第三方 listener 都可以返回一个全新的 `[]`（既不 spread
    // 最内层值，也不检查 subagent 血缘）；sentinel 只能识别「链路没有贡献」，识别不了
    // 「贡献者是谁」。因此这里与 sentinel 同档 fail-closed，绝不能放行等待。
    return { known: false, running: [], reason: "session-activity-empty-not-authoritative" };
  }
  const running = [];
  for (const entry of activity) {
    // 数组同样不是合法的族条目：与权威 listing 的结构校验保持同一严格度。
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { known: false, running: [], reason: "session-activity-malformed" };
    }
    // 只消费 subagent 族；其他族（job/schedule/turn）不属于专家后代判定范围。
    if (entry.kind !== "subagent") continue;
    const items = entry.items;
    if (!Array.isArray(items)) {
      return { known: false, running: [], reason: "session-activity-malformed" };
    }
    for (const item of items) {
      if (item === null || typeof item !== "object"
        || typeof item.id !== "string" || item.id.length === 0) {
        return { known: false, running: [], reason: "session-activity-malformed" };
      }
      running.push(item);
    }
  }
  if (running.length > 0) {
    // 确有 running 后代：这是**正向**事实，可以放心作为「继续等待」的依据。
    // 注意这里只用于「继续等待」，绝不用作静止证明。
    const runningIds = new Set();
    for (const item of running) runningIds.add(item.id);
    return { known: true, running, runningIds, reason: "running-descendants" };
  }
  // 非空、但没有任何 running 的 subagent 条目：贡献事实的是别的族
  // （turn/job/schedule…），或者 subagent 族本身是空 items。由于 subagent provider
  // 在空闲时是**原样透传**，这里既无法证明它装载过，也无法证明它报告了空——
  // 必须 fail-closed 继续等待。
  return { known: false, running: [], reason: "session-activity-foreign-families" };
}
  return {
    snapshotRootTurnDescendantsFromRuntimeAgents,
    snapshotRootTurnDescendants,
    isContractChildRow,
    readTurnWaitRuntimeDescendants,
    snapshotRootTurnDescendantsFromListing,
    snapshotRootTurnDescendantsFromActivity,
    TURN_WAIT_RUNTIME_STATUS_OPTIONS,
  };
}

/**
 * C 组：等待账本接线、诊断投影与收口结论投递。
 *
 * 本组只**消费**账本与宿主事实：账本实例由 `createRootWaitDomain` 创建并作为依赖传入，
 * 这里不再出现第二份登记表。`lastRootWaitDelivery` / `rootWaitAbandonCount` 是本组
 * 独有的诊断状态（域外只经 `rootWaitDiagnostics()` 只读投影与 `noteRootWaitAbandon()`
 * 命令访问）。
 *
 * @param {object} deps - 见 `createRootWaitDomain` 的参数说明。
 * @returns {object} C 组能力面。
 */
function installRootWaitRegistry(deps) {
    const {
      rootTurnWaits,
      notificationHost,
      rootGenerationRegistry,
      delegationTracker,
      sendSystemToast,
      localizedTerminationToast,
      terminationNotificationEventType,
      isLiveRootAgent,
      isRootAgentIdentity,
      logTurnWaitError,
      pendingUserWaits,
    } = deps;
  let lastRootWaitDelivery = null;
  /** 人工关闭等待账本的累计成功次数（诊断用，只计数）。 */
  let rootWaitAbandonCount = 0;

  /**
   * 记录一次收口结论投递结果，并同步到等待账本。
   *
   * 账本 noteDelivery 负责记录级 lastDelivery 与一次性提示；这里额外保留同一份结论，
   * 让诊断在记录销毁后仍能回答「最近一次投递是否成功、失败原因是什么」。
   * 任何异常都只告警：诊断/提示绝不影响投递路径的返回值与等待语义。
   */
  function noteRootWaitDelivery(parent, ok, reason) {
    const normalized = ok === true;
    const code = typeof reason === "string" && reason.length > 0
      ? reason
      : (normalized ? "delivered" : "delivery-failed");
    lastRootWaitDelivery = { ok: normalized, reason: code, at: Date.now() };
    try {
      rootTurnWaits.noteDelivery(parent, { ok: normalized, reason: code });
    } catch (error) {
      logTurnWaitError("delivery-note", error);
    }
  }

  /**
   * 真实用户输入会打断当前 root 的等待，但不退休 root 记录，也不清除专家工作。
   * 这样新消息能立即进入下一轮，旧 admission 仍由后续 turn 负责收口。
   */
  function cancelRootTurnWaitForUserInput(agent, reason = "user-message") {
    if (!isRootAgentIdentity(agent) || !isLiveRootAgent(agent)) return false;
    return rootTurnWaits.cancelWaiters(agent, reason);
  }

  /**
   * 释放一个已收到终态 feedback 但没有成功关联到 turn/messageId 的活动范围。
   *
   * DSH 的 durable child 在完成后会进入 ready；ready 不是新的 child turn，
   * 也不应要求 root 通过 notify/finalize 去“结束”它。这里按 parent + child
   * 精确清理插件登记的 activity，保留 child/recovery record，避免把可复用 child
   * 当作已销毁对象处理。role 过滤用于防止同一 childId 的历史 route 误清理。
   *
   * 证据边界（票据 07）：唯一调用点是 host 投递的 **terminal child feedback**
   * （settlement notice），且要求没有 pending recovery / gated feedback。root 结束、
   * 代际更新、人工动作（含 dsh_expert_group_release_scope）都不得走到这里。
   */
  function releaseActiveExpertScope(parent, { childId, role } = {}) {
    if (!isRootAgentIdentity(parent) || typeof childId !== "string" || childId.length === 0) return 0;
    const tasks = delegationTracker.listActiveTasks(parent.id).filter((task) =>
      task.childId === childId && (role === void 0 || task.role === role));
    return delegationTracker.completeActiveTasksByIds(tasks.map((task) => task.id));
  }

  /**
   * 已脱离 root 的活动范围只能由该 child 自己的权威停止信号释放（票据 07）。
   *
   * root 销毁/代际退休会丢弃 recovery record，正常的 handleChildTurnEnd 不再运行；
   * 但 detached 活动项仍在阻塞同路径任务。这里只处理仍被该 child 持有的 detached
   * 活动项，并且只认 **child turn/end**（本 turn 的稳定 messageId 命中）：
   * - 未绑定 messageId 的活动项（admission 竞态）保持保护，等 disposal 或其他 turn；
   * - 没有 detached 活动项时完全 no-op，普通 child/root session 不受影响。
   * @param {object} session - child Session。
   * @param {object} event - session/event 事件。
   * @returns {number} 释放条数。
   */
  function releaseDetachedActivitiesOnChildTurnEnd(session, event) {
    if (event?.type !== "turn/end" || typeof session?.id !== "string") return 0;
    const turn = event?.data?.turn;
    if (!Number.isSafeInteger(turn)) return 0;
    if (delegationTracker.activeTaskCounts().detached === 0) return 0;
    const events = Array.isArray(session.events) ? session.events : [];
    const turnMsgIds = messageIdsOfTurn(events, turn);
    if (turnMsgIds.size === 0) return 0;
    return delegationTracker.completeDetachedActiveTasksForChild(session.id, { turnMsgIds });
  }

  function pendingRootUserWait(agent, generation) {
    const wait = pendingUserWaits.get(agent);
    return wait?.agent === agent && wait.session === agent.session && wait.generation === generation
      ? [wait] : [];
  }

  function clearRootUserWait(agent, session) {
    const wait = pendingUserWaits.get(agent);
    if (wait?.agent !== agent || (session !== void 0 && wait.session !== session)) return false;
    pendingUserWaits.delete(agent);
    return true;
  }

  /**
   * authoritative root turn/end 之后提交终止快照。
   *
   * Host 是生命周期权威：递归后代是否仍在运行、live Agent 查询是否可信，全部由
   * host/notifications 内部判定并 fail closed（查询缺失/异常时绝不写入快照）。
   * 这里只负责把 exact root generation/turn 与 turn/end 的 reason 交给模块，
   * 因此 completed/blocked/error/aborted/interrupted/max-tokens 都会各自成为快照原因，
   * 不会再把异常折叠成"任务已完成"。
   */
  function commitRootTerminationSnapshot(agent, session, event) {
    if (!isLiveRootAgent(agent) || agent.session !== session) return;
    const generation = rootGenerationRegistry.generationOf(agent.id);
    if (!Number.isSafeInteger(generation)) return;
    const data = event?.data;
    // 非成功终止同样意味着本次用户等待已经结束；与旧实现保持一致，不留悬挂等待。
    if (data?.reason?.kind !== "completed") clearRootUserWait(agent, session);
    const published = notificationHost.recordTermination({
      rootId: agent.id,
      generation,
      reason: data?.reason,
      turn: data?.turn,
    });
    // 只有权威发布（published === true）才发送一次终态系统通知：
    // 身份未知 / 后代仍在运行 / 已发布 / 已释放等拒绝路径一律不发送，也不补发。
    // 文案只用固定 reason 类别（completed/blocked/error/aborted/interrupted/
    // max-tokens/unknown），异常正文与工具输出永不进入通知。
    if (published?.published === true) {
      const reason = published.snapshot?.reason;
      sendSystemToast(
        localizedTerminationToast(reason, rootNotificationLabel(session)),
        terminationNotificationEventType(reason),
      );
    }
  }
  /** 人工关闭等待账本成功后计数 +1（诊断用；唯一写入点）。 */
  function noteRootWaitAbandon() {
    rootWaitAbandonCount += 1;
  }

  /**
   * 诊断只读投影：最近一次收口投递与人工关闭次数。
   *
   * 只返回 ok / 固定原因码 / 时间戳与计数，不含消息正文、child id 或任务内容
   * （与迁移前 diagnostics 的读取面逐字一致）。
   */
  function rootWaitDiagnostics() {
    return {
      abandonedCount: rootWaitAbandonCount,
      lastDelivery: lastRootWaitDelivery,
    };
  }

  return {
    noteRootWaitDelivery,
    cancelRootTurnWaitForUserInput,
    releaseActiveExpertScope,
    releaseDetachedActivitiesOnChildTurnEnd,
    pendingRootUserWait,
    clearRootUserWait,
    commitRootTerminationSnapshot,
    noteRootWaitAbandon,
    rootWaitDiagnostics,
  };
}
