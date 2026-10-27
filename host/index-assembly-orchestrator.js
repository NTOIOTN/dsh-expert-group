/**
 * 入口装配段：主代理（Orchestrator）模型配置的 Host 侧地基（批次 A）。
 *
 * 本段做四件事：
 * 1. 构造运行期 manager（host/orchestrator-model）并挂到状态容器 `state.orchestratorModel`；
 * 1b. 构造两块 DEG 持久化能力（B2/B3）：功能启用切点（host/orchestrator-epoch）与会话覆盖
 *     durable 写入（host/session-override-store）；后者同时挂到 `state.sessionOverrideStore`，
 *     供会话 RPC 域复用同一份写入实现（不复制第二套持久化顺序）；
 * 2. 返回**有序注册描述**：sessionController 的晚绑定注入、四个事件挂点与一个释放 effect；
 *    `ctx.on` / `ctx.inject` / `ctx.effect` 的调用点仍只在入口（铁律 1/2）；
 * 3. 不接收 ctx：所有宿主能力都通过状态容器的窄命令交出。
 *
 * ## 为什么 sessionController 用可选注入而不是加进 inject 列表
 * ``inject: ["tools", ...]`` 是**必需服务**：宿主缺一个整插件就不启动。sessionController 是
 * 后加的宿主服务，老宿主/无头部署可能完全没有；把它写进必需列表会让插件在那些部署上
 * 直接装不起来。这里沿用仓库既有的可选注入范式（见 host/index-assembly-bootstrap.js 的
 * sessionQuery / attachments / storageDomain）：服务出现时绑定、释放时解绑，读面通过
 * `orchestrator.hostReady` 如实表达"宿主没就绪 => 不自动套用"。
 *
 * ## 触发点（只有三个）
 * - `agent/created`：新建会话（判据在 manager 内，恢复的历史会话永不套用）；
 * - 边界定时器：由 manager 自己按峰谷时段排（`refreshPeriod`）；
 * - 设置页保存：`noteSettingsCommit`，只重排定时器，不遍历会话。
 *
 * `agent/disposed` 与 `session/event` 不是"触发点"，它们是**状态维护**：前者释放运行期
 * 记录，后者做防回环与手动接管判定。把它们写在一起只是为了挂点集中、便于审阅。
 *
 * @module dsh-expert-group/host/index-assembly-orchestrator
 */
import { persistDomainEntry } from "../storage.js";
import { createOrchestratorEpochStore } from "./orchestrator-epoch.js";
import { createOrchestratorModelManager } from "./orchestrator-model.js";
import { createSessionOverrideStore } from "./session-override-store.js";

/**
 * 装配主代理模型运行期（票据：主代理模型配置 · 批次 A）。
 *
 * @param {object} state 装配状态容器（index.js 的 createAssemblyState 产物）。
 * @param {object} caps 入口具名能力面（只需要 effect 回落）。
 * @returns {Array<object>} 有序注册描述。
 */
export function assembleOrchestratorModel(state, caps) {
  /**
   * DEG 持久化域的两块（B2/B3 的唯一落盘入口）：
   * - epoch 切点：`orchestrator_state` 表，首次初始化写一次，重启后沿用；
   * - 会话覆盖：与 RPC 端点**共用**同一份 durable 写入实现（先代次、后内容、失败回滚），
   *   picker 手动接管的持久化绝不另写一套。
   * 两者都走组合根同一条 storage 写串行链（enqueueWrite），卸载时同样被 drain。
   */
  const epochStore = createOrchestratorEpochStore({
    storageBinding: state.storageBinding,
    persistence: {
      enqueueWrite: (...args) => state.enqueueWrite(...args),
      persistDomainEntry: (...args) => persistDomainEntry(...args),
    },
    logger: state.logger,
  });
  const sessionOverrideStore = createSessionOverrideStore({
    storage: {
      enqueueWrite: (...args) => state.enqueueWrite(...args),
      observeStorageWrite: (...args) => state.observeStorageWrite(...args),
      storageBinding: state.storageBinding,
    },
    reads: {
      source: () => state.source(),
      sessionOverrideProjectionOf: (...args) => state.sessionOverrideProjectionOf(...args),
    },
    models: {
      sessionOverrideConflictError: (...args) => state.sessionOverrideConflictError(...args),
    },
  });
  // 会话覆盖写入在别处（RPC 域）也要用：只交出命令，不交出 deps。
  state.sessionOverrideStore = sessionOverrideStore;

  const manager = createOrchestratorModelManager({
    // 设置快照在调用期解析：读源会在 settings 段被重新绑定，构造期捕获会读到空快照。
    settings: { snapshot: () => state.source() },
    // 根会话判据复用既有身份判定（无 parentSession、无 PARENT_MARKER），绝不另写一份。
    host: { isRootAgent: (agent) => state.isRootAgentIdentity(agent) === true },
    // 预检复用既有 validateSelectionWithSignal（目录解析 + effort 归一），不复制目录规则。
    models: { resolveSelection: (selection) => state.validateSelectionWithSignal(selection) },
    // 时钟能力面：now 必有；setTimeout/clearTimeout 只有宿主显式提供时才有（缺则降级）。
    clock: state.clock,
    logger: state.logger,
    // 持久化能力面（B2/B3）：功能启用切点 + 手动接管的会话覆盖写入。
    persistence: {
      ensureEpoch: (nowMs) => epochStore.ensure(nowMs),
      writeOrchestratorOverride: (params) => sessionOverrideStore.writeOrchestratorOverride(params),
    },
  });
  state.orchestratorModel = manager;

  return [
    {
      kind: "inject",
      deps: ["sessionController"],
      callback: (serviceCtx) => {
        // 严格 Cordis Context 读到未声明属性会抛：读取失败等于"服务不可用"，不是装配失败。
        let next;
        try {
          next = serviceCtx?.sessionController;
        } catch {
          return;
        }
        if (next === undefined || next === null) return;
        manager.bindService(next);
        // 绑定跟随提供服务的 fiber 释放：卸载后读面 hostReady 变 false，且不再写入。
        const bindEffect = typeof serviceCtx?.effect === "function" ? serviceCtx.effect.bind(serviceCtx) : caps.effect;
        bindEffect(() => () => manager.unbindService(next), "dsh-expert-group: orchestrator session controller binding");
      },
    },
    // 新建会话触发点（判据：根 agent + 无请求头 + 无 applied 记录；全部在 manager 内）。
    { kind: "on", event: "agent/created", handler: ({ agent } = {}) => manager.noteAgentCreated(agent) },
    // 会话结束：释放运行期状态（含自写令牌与排队意图）。
    { kind: "on", event: "agent/disposed", handler: ({ agent } = {}) => manager.noteAgentDisposed(agent) },
    // 防回环 / 手动接管：只消费 model/selection，不改变任何其它事件路径的行为。
    { kind: "on", event: "session/event", handler: (session, event) => manager.noteSessionEvent(session, event) },
    {
      kind: "effect",
      label: "dsh-expert-group: orchestrator model runtime",
      factory: () => () => {
        // 卸载时清定时器与会话状态：运行期内存态绝不跨插件实例泄漏。
        manager.dispose();
      },
    },
  ];
}
