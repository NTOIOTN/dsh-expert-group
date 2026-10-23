/**
 * 入口装配前言域（R4a · 票据 15）。
 *
 * 这里收纳 `apply` 最开头的一段**装配服务**：它们只负责创建跨域共享的运行时对象
 * （settings 提交边界、角色目录视图、委派跟踪器、Host 组合、系统通知适配器、持久化
 * 健康状态、root 代次登记表），不含任何等待/派发/收口语义。
 *
 * ## 为什么是工厂而不是模块级单例
 * 这些对象都必须**按插件实例**创建（测试 Host 会并发装配多个实例），因此由组合根在一次
 * `apply` 里调用一次工厂，再把返回的能力面分发给后续域。工厂本身不注册任何
 * `ctx.on` / `ctx.effect`：注册与 disposer 顺序仍留在 `index.js` 的原注册点执行
 * （票据 15 铁律 1）。工厂只接收**窄能力面**，绝不接收整个 `ctx`。
 *
 * ## 晚绑定的依赖
 * `getFanoutHost` / `isTurnWaitStopping` / `isRootAgent` 指向 `apply` 后段才就绪的
 * 状态或函数；它们在 `host` 组合里只以**回调**形式被调用，因此这里只保存取值函数，
 * 不在构造期求值——与迁移前的闭包语义逐字等价。
 *
 * @module dsh-expert-group/host/index-prelude
 */
import { RPC_PATH, RPC_CHANNEL, RPC_ENDPOINT, roleLabelsOf } from "../shared/protocol.js";
import { createDelegationTracker } from "../shared/delegation-tracker.js";
import { ROLE_REGISTRY } from "../role-registry.js";
import { createHostComposition } from "./composition.js";
import { createSettingsRuntimeModule } from "./settings-runtime.js";
import { findSettingsDescriptor } from "./settings-source.js";
import { createSystemToastModule } from "./system-toast.js";
import { createPersistenceHealth } from "./persistence-health.js";
import { createRootGenerationRegistry } from "./expert-child-composition.js";
import { SETTINGS_NAMESPACE, CONFIG_MIGRATION_VERSION } from "./settings-schema.js";
import { createRpcErrorTracker, RPC_ERROR_CATEGORY_LIMIT } from "./runtime-diagnostics.js";

/**
 * 创建入口装配前言的全部共享服务。
 *
 * @param {object} deps
 * @param {object} deps.config - 插件 Config 快照（`enableObserver`、`createSystemToast` 等注入 seam）。
 * @param {object} deps.logger - 宿主 logger（只用于固定类别告警）。
 * @param {object} deps.settings - 注入的 `ctx.settings`（提交边界需要 mutate）。
 * @param {object} deps.agents - 注入的 `ctx.agents`（Host 组合的 live 查询面）。
 * @param {(agent: object) => boolean} deps.isRootAgent - root 身份判定的晚绑定取值。
 * @param {() => object|undefined} deps.getFanoutHost - fan-out Host 的晚绑定取值。
 * @param {() => boolean} deps.isTurnWaitStopping - 卸载闩的晚绑定取值。
 * @returns {object} 装配前言能力面（见文件末尾的返回对象）。
 */
export function createIndexPrelude({
  config,
  logger,
  settings,
  agents,
  isRootAgent,
  getFanoutHost,
  isTurnWaitStopping,
}) {
  /**
   * settings 运行时状态（目录代次、document revision 去重、提交串行链）
   * 由 host/settings-runtime 持有；组合根只做事件接线与生命周期注册。
   */
  const settingsRuntime = createSettingsRuntimeModule({ settings, namespace: SETTINGS_NAMESPACE });

  /** settings 提交边界：目录代次栅栏与提交串行链由 host/settings-runtime 持有。 */
  const updateSettingsAtGeneration = (patch, expectedRevision, generation) =>
    settingsRuntime.updateAtGeneration(patch, expectedRevision, generation);

  /**
   * 本次 settings-commit 是否需要落下配置迁移标记（读取面别名的持久化开关）。
   *
   * 只在**真正保存**时读一次当前文档，因此不依赖启动期 describe 是否已投影本条目：
   * 桌面版 apply 阶段 describe 里可能还没有本插件条目，启动写回会静默跳过。
   * describe 不可读/条目缺失按缺省版本 0 处理——这一次保存顺手补上标记；
   * 读取路径永远不会触发写入。
   *
   * @returns {boolean} true = patch 里追加 configMigrationVersion。
   */
  function configMigrationPending() {
    const descriptor = findSettingsDescriptor(settings, SETTINGS_NAMESPACE);
    const rawVersion = descriptor?.value?.configMigrationVersion;
    const version = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
    return version < CONFIG_MIGRATION_VERSION;
  }

  /**
   * 最近 RPC 错误类别记录器：两条传输共用 mapRpcError，因此这里是同一份只读视图。
   * 记录只有结构化 code / 次数 / 时间戳，不含消息、请求体、prompt 或认证信息。
   */
  const rpcErrorTracker = createRpcErrorTracker({ limit: RPC_ERROR_CATEGORY_LIMIT });

  /** 角色目录：内置六角色注册表（模块常量，自定义角色能力已删除）。 */
  const roleCatalog = () => ROLE_REGISTRY;

  /**
   * 当前已启用的角色名：默认角色 + 显式启用的可选角色。
   * Observer 的裸 Config 默认禁用（Config.enableObserver 默认 false），
   * bundle patch 可以把它覆盖为 true。
   */
  const activeRoles = () => roleCatalog().enabledIds({ enableObserver: config.enableObserver === true });
  /** 角色是否在当前启用集合内（fan-out 派发、模型预检、设置保存共用）。 */
  const isActiveRole = (role) => activeRoles().includes(role);
  /** 角色显示名映射（供快照与 RPC 只读投影）。 */
  const roleLabelsProjection = () => roleLabelsOf(roleCatalog().records());
  /** 单个角色显示名；未知角色返回 undefined（历史标签由持久化快照提供）。 */
  const roleLabelOfRole = (role) => roleCatalog().get(role)?.label;

  /** 同父代理 + 同角色的委派跟踪器：串行临界区 / child 复用 / 任务去重（LRU 32）。 */
  const delegationTracker = createDelegationTracker({ taskLimit: 32 });

  // WeakSet 不持有 root；迟到 microtask 仍可按 exact 对象识别已销毁代际。
  const disposedRootAgents = new WeakSet();

  /**
   * Host 模块装配（expand 阶段）：六个关注点各自持有真实状态与行为，旧组合根
   * 通过它们接线；未迁移的旧逻辑仍保留在原处，任务 06 再收缩。
   */
  const host = createHostComposition({
    rpc: { path: RPC_PATH, channel: RPC_CHANNEL, endpoint: RPC_ENDPOINT },
    settings: {},
    storage: {},
    lineage: {
      disposedRoots: disposedRootAgents,
      isRootAgent,
      getAgent: (id) => agents.get(id),
      getTask: (id) => getFanoutHost()?.getTask(id) ?? null,
      listTasks: () => getFanoutHost()?.listTasks() ?? [],
      isGenerationBlocked: () => isTurnWaitStopping(),
    },
    notifications: {
      // 终止快照状态由 host/notifications 持有；Host 只注入 live Agent 查询，
      // 递归后代门控与 fail closed 判定都在模块内部完成。
      listAgents: () => agents.list(),
    },
    handoff: {},
  });
  const notificationHost = host.notifications;

  /**
   * Windows 系统 Toast 适配器（ADR 0005：系统通知是唯一通知界面）。
   *
   * 为什么由组合根直接持有、而不是组合层的新槽位：权威状态（每个 root run 的终止快照）
   * 仍由 host/notifications 持有，组合层的模块边界与释放顺序不变；适配器只负责把**已经
   * 发布的结论**交给 Windows，因此与 host 生命周期绑定在同一处释放。
   * config.createSystemToast 是可注入 seam（与 createPersistenceHealth 同一模式）：
   * 受控 Host/测试用它替换真实子进程，测试绝不真弹 Toast。
   */
  const systemToast = typeof config.createSystemToast === "function"
    ? config.createSystemToast()
    // 票据 33：注入面按能力组组织（宿主端口 / 宿主环境事实 / 投递预算配置）；这里只注入 logger。
    : createSystemToastModule({ hostPorts: { logger } });

  const storageBinding = host.storage;
  /**
   * 共享持久化健康状态：fan-out 快照走 manager sequence 的有界重试，session/child
   * 写入走独立观察通道（observeStorageWrite）。两者共用同一个内存状态对象，但通道
   * 互不覆盖，因此 session/child 失败不会改变 fan-out 的重试判定。
   * 只读投影：健康状态不写入 settings，也不写入任何 domain 快照。
   * config.createPersistenceHealth 是可选注入 seam（默认创建），供受控 Host/测试
   * 在执行任何写入前捕获同一个实例；未注入时行为与历史完全一致。
   */
  const persistenceHealth = typeof config.createPersistenceHealth === "function"
    ? config.createPersistenceHealth()
    : createPersistenceHealth();
  // Host RPC 需要可序列化且单调的 root generation；Map 只保存当前 Agent，序号不回退。
  const rootGenerationRegistry = createRootGenerationRegistry();

  /**
   * 标记一个 exact root 对象已销毁（WeakSet 的唯一写入口）。
   *
   * 为什么收成命令：\`disposedRootAgents\` 是插件级可写状态，域外一律不得持有 WeakSet
   * 本体（票据 15 铁律 3）；调用方只表达「这个 root 已销毁」这一事实。
   */
  function markRootDisposed(agent) {
    disposedRootAgents.add(agent);
  }

  /** 撤销「已销毁」标记（唯一删除入口；同样是命令，不外泄容器）。 */
  function forgetRootDisposed(agent) {
    disposedRootAgents.delete(agent);
  }

  return {
    settingsRuntime,
    updateSettingsAtGeneration,
    configMigrationPending,
    rpcErrorTracker,
    roleCatalog,
    activeRoles,
    isActiveRole,
    roleLabelsProjection,
    roleLabelOfRole,
    delegationTracker,
    markRootDisposed,
    forgetRootDisposed,
    host,
    notificationHost,
    systemToast,
    storageBinding,
    persistenceHealth,
    rootGenerationRegistry,
  };
}
