/**
 * 入口 settings / storage 域（R4b · 票据 16）。
 *
 * 这一域持有**设置读源绑定**与**storage domain 生命周期 / 写命令**：
 * - 两个语义明确的读能力：readSettingsSource()（可被重绑定的归一读面）与
 *   readSnapshot()（一次读齐 settings + storage 各表的**一致快照**）；
 * - storage 初始化 gate 与写串行链（唯一 owner 在本模块）；
 * - child_models / fan-out 快照写命令（先 durable put，再裁剪 / 更新缓存）；
 * - settings 投影与 persona 解析（describeRolePrompts / resolvePersonaForAdmission*）；
 * - 冷启动事件历史恢复结果的可观察记录（诊断只读投影）。
 *
 * ## 组合根保留的职责（票据 16 铁律 1/2）
 * ctx.inject / ctx.effect 的注册与 disposer 顺序仍留在 `index.js` 的原注册点：
 * - installSettingsSection(host.settings, ctx, ...)（内部注册 settings 观察点）仍由
 *   `index.js` 调用，本模块只提供 defaultSettingsEntry() 与 bindSettingsSource()；
 * - storage domain 注入回调里的 ctx.effect 释放注册仍由 `index.js` 完成，本模块只返回
 *   attachStorageDomain() 给出的 dispose。
 * 域服务**不接收 ctx**，跨域依赖全部是窄能力面。
 *
 * ## 读源绑定语义（不得改变）
 * 迁移前 settingsSource 是一个**可被重新绑定**的取值函数：installSettingsSection 的
 * setSource 会把它换成「读一次 = 归一一次」的包装。因此域外只允许调用
 * readSettingsSource() / readSnapshot()，**不得**捕获函数值——重绑定后旧值即失效。
 * readSnapshot() 在入口读一次 settings 与各表，返回同一代的合并快照；需要一致性的路径
 * 必须整份使用这份返回值，不得在内部二次读取。
 *
 * @module dsh-expert-group/host/index-settings-storage
 */
import {
  CHILD_LRU_LIMIT,
  createInitializationGate,
  persistDomainEntry,
  persistLruEntry,
  readDomainSnapshot,
} from "../storage.js";
import { defaultExpertPersonaOf, resolveExpertPersona } from "../prompt-contracts.js";
import {
  PROMPT_OVERRIDES_SETTINGS_KEY,
  PROMPT_OVERRIDE_MAX_GRAPHEMES,
  promptOverrideFor,
} from "../shared/prompts.js";
import { DEFAULT_MODEL_FALLBACK_LIMIT } from "../shared/model-route.js";
import {
  DEFAULT_NOTIFICATION_EVENTS,
  DEFAULT_ROLE_CONCURRENCY_LIMIT,
  DEFAULT_ROLE_TIMEOUT_MS,
} from "./settings-schema.js";
import { normalizeSnapshot } from "./settings-read-projection.js";
import { EXPERT_STORAGE_DOMAIN_SPEC } from "./storage-domain-schema.js";

/**
 * 插件 settings 条目的默认值（= Config 投影的初值）。
 *
 * 每次调用返回**全新对象**：迁移前这里有两处独立字面量（读源初值与
 * installSettingsSection 的 entry），语义都是「每次取一份新的默认快照」，
 * 因此不能用共享的冻结对象替代。
 *
 * @returns {object} 默认 settings 快照。
 */
export function defaultSettingsEntry() {
  return {
    provider: "",
    defaults: {},
    candidates: {},
    fallbackLimit: DEFAULT_MODEL_FALLBACK_LIMIT,
    promptOverrides: {},
    notificationEnabled: true,
    notificationVolume: 100,
    notificationEvents: { ...DEFAULT_NOTIFICATION_EVENTS },
    roleConcurrencyLimit: DEFAULT_ROLE_CONCURRENCY_LIMIT,
    // 并发映射（票据 26）：默认空映射 = 全部落到 roleConcurrencyLimit / 不限制。
    roleLimits: {},
    providerLimits: {},
    roleTimeoutMs: DEFAULT_ROLE_TIMEOUT_MS,
    observerPreferred: false,
    taskManagementEnabled: true,
    autoOpenSubagentSidebar: false,
    // 左侧栏入口默认开启：与 schema 默认值、读取面归一必须同源。
    sidebarEntryEnabled: true,
    // 单价（票据 25）：旧配置/未配置 => 空数组（不估算成本）。
    modelPrices: [],
    // 上下文继承（票据 29）：旧配置/未配置 => 空映射（全部关闭）。
    inheritContext: {},
  };
}

    /**
     * root replacement/dispose 后移除旧 Agent 的 fan-out 所有权索引。task/result
     * 历史仍由 manager 保留；只有 ownership 被摘除，避免同 id 新 root 复用旧任务。
     */
export function tableEntries(table) {
      if (table === void 0) return void 0;
      try { return [...table.entries()]; } catch { return void 0; }
    }

/**
 * 创建 settings / storage 域能力面。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx）。
 * @param {object} deps.logger - 宿主 logger（只记固定类别，绝不复述正文）。
 * @param {object} deps.storageBinding - host.storage（binding 代次 + domain/fan-out 快照缓存）。
 * @param {object} deps.lineage - host.lineage（只用到 restoreParentSessions）。
 * @param {object} deps.roles - 角色目录能力面 { roleCatalog, activeRoles }。
 * @param {object} deps.persistenceHealth - 共享持久化健康状态（只记录，不改变写入结果）。
 * @param {()=>object|undefined} deps.getFanoutHost - fan-out Host 的晚绑定取值（storage-ready 恢复）。
 * @param {()=>void} deps.onStorageRestored - storage-ready 后的组合根命令（goal handoff 冷恢复登记）。
 * @returns {object} settings / storage 域能力面（见各 installer 的返回对象）。
 */
export function createIndexSettingsStorageDomain(deps) {
  const api = {};
  Object.assign(api, installSettingsSource(deps, api));
  Object.assign(api, installStorageWrites(deps, api));
  Object.assign(api, installStorageDomainBinding(deps, api));
  Object.assign(api, installSettingsProjection(deps, api));
  return { ...api };
}

/**
 * S1：settings 读源与 snapshot 读能力。
 *
 * 状态唯一 owner：settingsSourceImpl（可重绑定）。域外只能经
 * readSettingsSource() / readSnapshot() 读取，**不得**捕获函数值。
 *
 * @param {object} deps - 见 createIndexSettingsStorageDomain。
 * @param {object} api - 域内能力面（跨组调用在运行期解析）。
 * @returns {object} S1 能力面。
 */
function installSettingsSource(deps, api) {
  const { storageBinding, roles } = deps;
  const { activeRoles } = roles;

  /** 当前 settings 读源绑定；初值是未归一的默认快照（与迁移前一致，读时再归一）。 */
  let settingsSourceImpl = () => defaultSettingsEntry();

  /**
   * settingsSource() 的迁移等价物：**每次调用**都值取当前绑定，
   * 因此重绑定（installSettingsSection 的 setSource）之后立刻生效。
   */
  function readSettingsSource() {
    return settingsSourceImpl();
  }

  /**
   * 重绑定读源：与迁移前 settingsSource = () => normalizeSnapshot(next(), activeRoles())
   * 逐字等价（读一次归一一次，activeRoles 取调用时刻的启用集合）。
   */
  function bindSettingsSource(next) {
    settingsSourceImpl = () => normalizeSnapshot(next(), activeRoles());
  }


    /** source() 只读最后一次成功读取的 domain；没有 ready domain 时不覆盖既有快照。 */
    function readSnapshot() {
      // 读源本身已经是归一快照（含读取期丢弃诊断）；这里再归一是为了对旧结构做一次
      // 防御性收敛，但 limitDiagnostics 这类"一次性事实"必须在第二次归一前取出，
      // 否则合法值重新归一后诊断会被清空，设置页就再也看不到"哪些条目被丢弃"。
      const rawSettingsSnapshot = readSettingsSource();
      const settingsSnapshot = normalizeSnapshot(rawSettingsSnapshot, activeRoles());
      const binding = storageBinding.active();
      if (binding !== void 0) {
        const sessionEntries = tableEntries(binding.sessionTable);
        // 会话覆盖代次（票据 21）：读面必须与内容同源；缺表/读失败按“binding 不可用”
        // 处理（invalidate），绝不用空代次静默降级——那会让 CAS 永远从 0 通过。
        const sessionOverrideMetaEntries = tableEntries(binding.sessionOverrideMetaTable);
        const childEntries = tableEntries(binding.childTable);
        const fanoutEntries = tableEntries(binding.fanoutTable);
        // 模板表（票据 28）与运行数据同源读取：缺表/读失败与其它表同样按 binding
        // 不可用处理，绝不用空模板静默降级——那会让保存后的模板在读取面上“消失”。
        const templateEntries = tableEntries(binding.fanoutTemplateTable);
        if (sessionEntries !== void 0 && sessionOverrideMetaEntries !== void 0
          && childEntries !== void 0 && fanoutEntries !== void 0
          && templateEntries !== void 0) {
          storageBinding.setDomainSnapshot(readDomainSnapshot(sessionEntries, childEntries, sessionOverrideMetaEntries, templateEntries));
          storageBinding.setFanoutSnapshot(fanoutEntries.find(([key]) => key === "current")?.[1]);
        } else {
          storageBinding.invalidate(binding);
        }
      }
      return {
        provider: settingsSnapshot.provider,
        defaults: settingsSnapshot.defaults,
        // 模型候选/自动降级上限（票据 24）：与 defaults 同属全局 settings，必须随
        // 同一份快照进入 source()，否则运行期会静默退回“没有候选/默认 2”。
        candidates: settingsSnapshot.candidates,
        fallbackLimit: settingsSnapshot.fallbackLimit,
        // 自定义专家提示词属于全局 settings，必须随同一份快照进入 source()：
        // restore/重载期间缺失它会让运行时静默回落到默认 persona。
        promptOverrides: settingsSnapshot.promptOverrides,
        notificationEnabled: settingsSnapshot.notificationEnabled,
        notificationVolume: settingsSnapshot.notificationVolume,
        notificationEvents: settingsSnapshot.notificationEvents,
        roleConcurrencyLimit: settingsSnapshot.roleConcurrencyLimit,
        // 并发映射（票据 26）同理：缺少它们会让调度器悄悄退回「只有默认值」，
        // 设置页显示的逐角色/provider 上限与实际调度脱节。
        roleLimits: settingsSnapshot.roleLimits,
        providerLimits: settingsSnapshot.providerLimits,
        limitDiagnostics: rawSettingsSnapshot?.limitDiagnostics ?? settingsSnapshot.limitDiagnostics,
        // 上下文继承（票据 29）：必须随同一份快照进入 source()，否则 meta/get 与派发
        // 判定会悄悄退回“全部关闭”。诊断与 limitDiagnostics 同理使用原始快照的一次性事实。
        inheritContext: settingsSnapshot.inheritContext,
        inheritContextDiagnostics: rawSettingsSnapshot?.inheritContextDiagnostics
          ?? settingsSnapshot.inheritContextDiagnostics,
        // 角色默认超时属于全局 settings：必须随同一份快照进入 source()，
        // 否则冷恢复/服务重载之后读到的值会悄悄退回“不启用”。
        roleTimeoutMs: settingsSnapshot.roleTimeoutMs,
        observerPreferred: settingsSnapshot.observerPreferred,
        taskManagementEnabled: settingsSnapshot.taskManagementEnabled,
        // 自动打开属于全局 settings：必须随同一份快照进入 source()，否则冷恢复/服务重载
        // 之后 client 读到的值会悄悄退回默认关闭。
        autoOpenSubagentSidebar: settingsSnapshot.autoOpenSubagentSidebar,
        // 左侧栏入口同理：漏掉它会让冷恢复/服务重载之后的读源悄悄退回默认值，
        // 设置页与侧栏注册读到的事实就会与用户已保存的开关不一致。
        sidebarEntryEnabled: settingsSnapshot.sidebarEntryEnabled,
        // 单价（票据 25）：与 settings 同源进入运行期读源，RPC meta/get 与客户端设置页
        // 读到同一份归一值；诊断只服务 meta，不进入设置响应。
        modelPrices: settingsSnapshot.modelPrices,
        // 与 limitDiagnostics 同理：读取期丢弃诊断是“一次性事实”，必须在第二次归一前
        // 从原始快照取出，否则合法值重新归一后诊断会被清空，meta 再也看不到哪些条目被丢弃。
        modelPriceDiagnostics: rawSettingsSnapshot?.modelPriceDiagnostics ?? settingsSnapshot.modelPriceDiagnostics,
        ...storageBinding.snapshots(),
      };
    }

  return { readSettingsSource, bindSettingsSource, readSnapshot };
}

/**
 * S2：storage 写入域（初始化 gate + 串行写链 + child_models / fan-out 快照写命令）。
 *
 * 状态唯一 owner：writeChain（写串行链）、storageInitializationGate 与
 * domainInitialization（代次闸门）。域外只经命令读写，绝不持有这些容器。
 * （admission 侧的 dispatchAcceptedClock 仍留在 index.js：它服务 persistChildDispatch。）
 *
 * @param {object} deps - 见 createIndexSettingsStorageDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} S2 能力面。
 */
function installStorageWrites(deps, api) {
  const { logger, storageBinding, persistenceHealth } = deps;

  let writeChain = Promise.resolve();
  // settings 提交与 domain 写入各自串行；settings 不等待可能永久 pending 的 domain gate。
  // ctx.inject 可能在插件 setup 之后才回调；首次回调前写入必须保持 pending。
  const storageInitializationGate = createInitializationGate();
  // 没有任何写入者时也消费拒绝结果，避免未提供服务时产生未处理 rejection；写入者仍收到原错误。
  storageInitializationGate.promise.catch(() => {});
  let domainInitialization = storageInitializationGate.promise;

  /**
   * 初始化失败 / 服务缺失的唯一拒绝入口。
   *
   * ctx.effect 的 disposer（迁移前直接 reject gate）仍注册在 index.js 原注册点，
   * 这里只暴露命令，保证「gate 只能被 owner 置为 rejected」这一所有权约束。
   */
  function failStorageInitialization(error) {
    storageInitializationGate.reject(error);
  }

  /**
   * 登记本次 generation 的 domain 初始化 promise（gate 只 resolve 一次）。
   * 调用方先在绑定安装处构造 Promise.race([initialize, cancelled]) 的错误收敛链。
   */
  function settleStorageInitialization(pending) {
    domainInitialization = pending;
    storageInitializationGate.resolve(domainInitialization);
  }

  /** 卸载路径等待已开始的写入 drain（不抛错：释放异常不得阻断其它 disposer）。 */
  function awaitPendingWrites() {
    return writeChain.catch(() => {});
  }


    /**
     * 记录一次 session/child domain 写入的健康结果。
     *
     * 只更新内存健康状态：不写 storage、不触发回调，因此失败记录不会形成
     * persistence feedback loop。generation 取当前 binding（未 ready 时为 undefined）。
     * 分类由 host/persistence-health 统一负责：同步 throw、异步 reject、generation
     * detached 都是同一批结构化错误，会落到 transient/generation-stale/capacity/permanent。
     */
    function observeStorageWrite(ok, error, source) {
      try {
        persistenceHealth.observeStorageWrite({
          ok: ok === true,
          error,
          generation: storageBinding.active()?.generation,
          source,
        });
      } catch { /* 健康记录失败不得影响真实写入结果。 */ }
    }


    /**
     * 消费一次 fan-out 恢复结果（票据 04）。
     *
     * restore 不再允许"失败即静默"：返回值里的结构化 error（code/field/violation）会
     * 进入日志，并通过 fanoutHost.describe().persistence 进入 RPC 诊断；fail-closed 的
     * persistenceBlocked 由 host/fanout-runtime 维护，这里只负责观测与告警。
     *
     * @param {string} label - 调用位置标签（storage-ready / agent-created / runtime-wired）。
     * @param {object|undefined} outcome - fanoutHost.restore() 的返回值。
     */
    function consumeFanoutRestore(label, outcome) {
      if (outcome === null || typeof outcome !== "object") return outcome;
      if (outcome.ok === true) return outcome;
      const error = outcome.error;
      if (error === undefined || error === null) return outcome;
      logger.warn("dsh-expert-group: fan-out snapshot restore failed (" + label + ") ["
        + (typeof error.code === "string" && error.code.length > 0 ? error.code : "RESTORE_FAILED") + "]: "
        + (typeof error.message === "string" ? error.message : "unknown"));
      return outcome;
    }


    /** domain 写入串行，并在执行前等待当前 storage-domain generation ready。 */
    function enqueueWrite(fn) {
      // 首次 ctx.inject 回调前等待 gate；之后再等待当前 generation 的 domain 初始化。
      const run = writeChain
        .then(() => storageInitializationGate.settled ? domainInitialization : storageInitializationGate.promise)
        .then(fn);
      writeChain = run.catch(() => {});
      return run;
    }


    function persistFanoutSnapshot(stored) {
      return enqueueWrite(async () => {
        const binding = storageBinding.active();
        if (binding?.fanoutAuthoritative !== true || binding.fanoutTable === void 0) {
          throw new Error("storage domain is not ready for fan-out snapshot write");
        }
        const result = await persistDomainEntry({
          table: binding.fanoutTable,
          key: "current",
          value: stored,
          isCurrent: () => storageBinding.isCurrent(binding),
        });
        if (result.detached === true) {
          const error = new Error("storage domain binding was replaced during fan-out snapshot write");
          error.code = "PERSISTENCE_GENERATION_STALE";
          error.category = "generation-stale";
          throw error;
        }
        storageBinding.setFanoutSnapshot(stored);
        return true;
      }).catch((error) => {
        logger.warn("dsh-expert-group: fan-out snapshot persistence failed: " + (error instanceof Error ? error.message : String(error)));
        // 日志是旁路；必须继续 reject，让 runtime 的 health seam 记录真实失败类别。
        throw error;
      });
    }


    /** 对 domain 表先 durable put，再按显式 lru 序号裁剪。 */
    async function putChildDomain(binding, childId, record) {
      if (!storageBinding.isCurrent(binding) || binding.childAuthoritative !== true) {
        throw new Error("storage domain binding is not ready for child model write");
      }
      const result = await persistLruEntry({
        table: binding.childTable,
        key: childId,
        value: record,
        limit: CHILD_LRU_LIMIT,
        isCurrent: () => storageBinding.isCurrent(binding),
      });
      if (result.error !== void 0) throw result.error;
      if (result.detached === true) throw new Error("storage domain binding was replaced during child model write");
      return true;
    }


    /** domain 未 ready 时显式失败，不创建 settings/进程内运行数据副本。 */
    function writeChildModel(childId, record) {
      return enqueueWrite(async () => {
        const binding = storageBinding.active();
        if (binding?.childAuthoritative !== true) {
          throw new Error("storage domain is not ready for child model write");
        }
        await putChildDomain(binding, childId, record);
      }).then(() => {
        observeStorageWrite(true, void 0, "child_models");
      }, (error) => {
        // 记录后仍然吞掉：child 模型快照是旁路持久化，不能把失败升级成调用方异常。
        observeStorageWrite(false, error, "child_models");
        logger.warn("dsh-expert-group: child model persistence failed: " + (error instanceof Error ? error.message : String(error)));
      });
    }


    /**
     * 在同一 domain 写临界区内合并 child_models 当前记录，避免迟到写入覆盖模型字段。
     *
     * options.rethrow=true 只给需要感知失败的调用方（用量账本的重试、结构化结果的
     * 有界重试）使用：默认仍是"记录健康度 + 告警后吞掉"，不允许旁路持久化失败升级成
     * child/task 生命周期异常。
     *
     * options.remove 是显式删除键（运行期降级清理旧 reasoningEffort）：浅合并无法表达
     * 「删除」（schema 不允许 null，写 undefined 又可能被序列化丢弃或保留半截键），
     * 因此在同一临界区内先合并再按键删除，保证 provider/model/candidateIndex/
     * fallbackCount/reasoningEffort 五者在一次 durable 写入里原子更新。
     */
    function writeChildModelPatch(childId, patch, options) {
      const rethrow = options?.rethrow === true;
      const removeKeys = Array.isArray(options?.remove)
        ? options.remove.filter((key) => typeof key === "string" && key.length > 0)
        : [];
      return enqueueWrite(async () => {
        const binding = storageBinding.active();
        if (binding?.childAuthoritative !== true) throw new Error("storage domain is not ready for child model write");
        const current = tableEntries(binding.childTable)?.find(([key]) => key === childId)?.[1] ?? {};
        const incomingAt = patch?.lastDispatch?.acceptedAt;
        const currentAt = current?.lastDispatch?.acceptedAt;
        if (Number.isSafeInteger(incomingAt) && Number.isSafeInteger(currentAt) && currentAt > incomingAt) return;
        const merged = { ...current, ...patch };
        for (const key of removeKeys) delete merged[key];
        await putChildDomain(binding, childId, merged);
      }).then(() => {
        observeStorageWrite(true, void 0, "child_models");
      }, (error) => {
        observeStorageWrite(false, error, "child_models");
        // 需要感知失败的调用方（usage ledger / structured retry）走 rethrow；它们
        // 负责保留 dirty 或重新排队，绝不让旁路持久化失败升级成调用方异常。
        if (rethrow) throw error;
        logger.warn("dsh-expert-group: child dispatch persistence failed: " + (error instanceof Error ? error.message : String(error)));
      });
    }

  return {
    failStorageInitialization,
    settleStorageInitialization,
    awaitPendingWrites,
    observeStorageWrite,
    consumeFanoutRestore,
    enqueueWrite,
    persistFanoutSnapshot,
    writeChildModel,
    writeChildModelPatch,
  };
}
/**
 * S3：storage domain 绑定与冷启动恢复（注入回调的初始化段）。
 *
 * 状态唯一 owner：lastFanoutEventRestore（最近一次 restoreEvents 结果，诊断只读投影）。
 * binding 的 begin/install/invalidate 全部经 storageBinding 命令；closeOpened / closed /
 * closePromise 只在本闭包内。
 *
 * @param {object} deps - 见 createIndexSettingsStorageDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} S3 能力面。
 */
function installStorageDomainBinding(deps, api) {
  const { logger, storageBinding, lineage, getFanoutHost, onStorageRestored } = deps;

  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const failStorageInitialization = (...args) => api.failStorageInitialization(...args);
  const settleStorageInitialization = (...args) => api.settleStorageInitialization(...args);
  const awaitPendingWrites = (...args) => api.awaitPendingWrites(...args);
  const consumeFanoutRestore = (...args) => api.consumeFanoutRestore(...args);

    /**
     * 最近一次冷启动 restoreEvents 的结果（票据 04）。
     *
     * 事件历史恢复的布尔返回值过去被直接丢弃：快照里的历史因超预算被整体拒绝时，
     * 进程端 cursor 会从 0 重新开始，但没有任何日志/诊断说明原因。这里记录 accepted
     * 与是否真的存在待恢复事件，供 describeRuntimeDiagnostics 与告警使用。
     */
    let lastFanoutEventRestore = null;

  /** 只读投影：最近一次冷启动 restoreEvents 结果（诊断面使用，不交出可变包装）。 */
  function readLastFanoutEventRestore() {
    return lastFanoutEventRestore;
  }

  /**
   * 安装一次 storage domain 绑定。
   *
   * 由 index.js 的 ctx.inject(["storageDomain"], ...) 回调在**原注册点**调用；
   * 返回 null 表示本次不可用（gate 已被 owner 拒绝），否则返回 { dispose } 供组合根
   * 注册 ctx.effect。
   *
   * @param {object} storageDomain - 注入的 storage domain 服务。
   * @returns {{dispose: () => Promise<void>}|null}
   */
  function attachStorageDomain(storageDomain) {
      if (storageDomain === void 0 || storageDomain === null || typeof storageDomain.open !== "function") {
        failStorageInitialization(new Error("storage domain service is unavailable"));
        return null;
      }
      const binding = storageBinding.begin();
      let cancelInitialization;
      let closed = false;
      let closePromise;
      binding.cancelInitialization = () => cancelInitialization?.();
      const cancelled = new Promise((_, reject) => {
        cancelInitialization = () => reject(new Error("storage domain binding was invalidated before ready"));
      });
      binding.onInvalidate = () => {
        // 快照缓存由 host/storage-binding 在 invalidate/begin 时清空。
        cancelInitialization?.();
      };
      const opened = Promise.resolve().then(() => storageDomain.open(EXPERT_STORAGE_DOMAIN_SPEC));
      const closeOpened = async () => {
        if (closePromise !== void 0) return closePromise;
        closePromise = opened.then(async (domain) => {
          if (!closed) {
            closed = true;
            try { await domain.close(); } catch (error) {
              logger.warn("dsh-expert-group: stale storage domain close failed: " + (error instanceof Error ? error.message : String(error)));
            }
          }
        }).catch(() => {});
        return closePromise;
      };
      const initialize = opened.then(async (domain) => {
        if (!storageBinding.isCurrent(binding)) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        const sessionTable = domain.table("session_overrides");
        // 会话覆盖代次（票据 21）：与覆盖内容同代持久化；缺失表由 storage domain 按
        // EXPERT_STORAGE_DOMAIN_SPEC 创建，旧数据只意味着 revision 从 0 开始。
        const sessionOverrideMetaTable = domain.table("session_override_meta");
        const childTable = domain.table("child_models");
        const fanoutTable = domain.table("fanout_tasks");
        // 手动派发模板（票据 28）：与运行数据同域、独立表；domain version 保持 1。
        const fanoutTemplateTable = domain.table("fanout_templates");
        const sessionEntries = tableEntries(sessionTable);
        const sessionOverrideMetaEntries = tableEntries(sessionOverrideMetaTable);
        const childEntries = tableEntries(childTable);
        const fanoutEntries = tableEntries(fanoutTable);
        const templateEntries = tableEntries(fanoutTemplateTable);
        if (sessionEntries === void 0 || sessionOverrideMetaEntries === void 0
          || childEntries === void 0 || fanoutEntries === void 0
          || templateEntries === void 0) throw new Error("storage domain table read failed");
        if (!storageBinding.isCurrent(binding)) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        const installed = storageBinding.install(binding, {
          domain, sessionTable, sessionOverrideMetaTable, childTable, fanoutTable, fanoutTemplateTable,
          sessionAuthoritative: true, sessionOverrideMetaAuthoritative: true,
          childAuthoritative: true, fanoutAuthoritative: true,
          fanoutTemplateAuthoritative: true,
        });
        if (!installed) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        storageBinding.setDomainSnapshot(readDomainSnapshot(sessionEntries, childEntries, sessionOverrideMetaEntries, templateEntries));
        storageBinding.setFanoutSnapshot(fanoutEntries.find(([key]) => key === "current")?.[1]);
        const persistedFanoutSnapshot = storageBinding.fanoutSnapshot();
        // 事件历史与任务快照同代持久化；Host 自有查询缓存也必须先水合，避免冷启动 cursor 从 0 重置。
        const eventRestoreAccepted = getFanoutHost().restoreEvents(persistedFanoutSnapshot?.events);
        lastFanoutEventRestore = {
          accepted: eventRestoreAccepted === true,
          attempted: Array.isArray(persistedFanoutSnapshot?.events),
          at: Date.now(),
        };
        if (eventRestoreAccepted !== true && Array.isArray(persistedFanoutSnapshot?.events)) {
          // 恢复失败必须可见：布尔返回值 + 预算违规（只记资源名/字节，不记事件正文）。
          const violation = typeof getFanoutHost().budget === "function" ? getFanoutHost().budget()?.lastViolation : null;
          logger.warn("dsh-expert-group: fan-out event history restore rejected (events="
            + persistedFanoutSnapshot.events.length
            + (violation === null || violation === undefined
              ? ""
              : ", resource=" + String(violation.resource) + ", received=" + String(violation.receivedBytes)
                + ", limit=" + String(violation.maxBytes))
            + ")");
        }
        lineage.restoreParentSessions(persistedFanoutSnapshot);
        consumeFanoutRestore("storage-ready", getFanoutHost().restore());
        // 冷恢复：restore 之后为「已在运行、但本进程还没有登记」的 fan-out 父任务补登记
        // 等待工作。终态任务只标记已释放，绝不登记（它们不会再产生 task_settled）。
        onStorageRestored();
      });
      const pending = Promise.race([initialize, cancelled]).catch(async (error) => {
        if (storageBinding.isCurrent(binding)) {
          logger.warn("dsh-expert-group: storage domain initialization failed: " + (error instanceof Error ? error.message : String(error)));
          storageBinding.invalidate(binding);
        }
        await closeOpened();
        throw error;
      });
      settleStorageInitialization(pending);

    return {
      /**
       * 卸载时的释放：先让读写观察到 pending，再等待已开始的写入 drain/close。
       * 不能反过来（迁移前的 disposer 顺序契约）。
       */
      async dispose() {
        storageBinding.invalidate(binding);
        await awaitPendingWrites();
        await closeOpened();
      },
    };
  }

  return { attachStorageDomain, readLastFanoutEventRestore };
}
/**
 * S4：settings 只读投影与 persona 解析。
 *
 * 纯派生：每次调用都读**当前** settings 读源（经 api.readSettingsSource() 晚绑定），
 * 因此设置保存后的第一次新建 child 立刻使用新 persona，不存在缓存。
 *
 * @param {object} deps - 见 createIndexSettingsStorageDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} S4 能力面。
 */
function installSettingsProjection(deps, api) {
  const { roles } = deps;
  const { roleCatalog } = roles;

  const readSettingsSource = (...args) => api.readSettingsSource(...args);


    /**
     * 只读提示词自定义投影。
     *
     * 对六个注册角色（含当前未启用的 observer）返回：角色 id、代码维护的默认专家专属
     * persona、已保存的自定义覆盖（没有时字段缺失）与是否已自定义。设置页据此渲染
     * 角色按钮、编辑器初值和"已自定义"标识；运行时 persona 仍由 resolvePersonaForAdmission
     * 现算，投影只描述配置，不是运行期人格缓存。
     *
     * 投影里刻意不含固定执行纪律文本：那段纪律由代码追加，不是用户可编辑内容。
     *
     * @param {object} snapshot - 已归一的 settings 快照。
     * @returns {{roles: string[], maxGraphemes: number, customizable: boolean,
     *   entries: Array<{role: string, defaultPersona: string, override: (string|undefined), customized: boolean}>}}
     */
    function describeRolePrompts(snapshot) {
      // 角色集合 = 内置目录；「恢复默认」使用 defaultExpertPersonaOf 解析。
      const roles = roleCatalog().records();
      const overrides = snapshot?.[PROMPT_OVERRIDES_SETTINGS_KEY];
      const entries = roles.map((entry) => {
        const override = promptOverrideFor(overrides, entry.id);
        return {
          role: entry.id,
          defaultPersona: defaultExpertPersonaOf(entry),
          ...(override === void 0 ? {} : { override }),
          customized: override !== void 0,
        };
      });
      return {
        roles: roles.map((entry) => entry.id),
        maxGraphemes: PROMPT_OVERRIDE_MAX_GRAPHEMES,
        // 固定执行纪律始终由代码追加，用户只能覆盖专家专属部分。
        customizable: true,
        entries,
      };
    }


    /**
     * 解析一次专家 child 应使用的完整 persona（专家专属部分 + 固定执行纪律）。
     *
     * 必须在 **admission 边界**调用，而不是在模块加载期或工具注册期缓存结果：
     * settings 覆盖由设置页在运行期修改，缓存任何快照都会让保存后的第一次新建
     * child 继续使用旧 persona。读取走 readSettingsSource()——已归一化的当前权威快照，
     * 因此读取路径与设置页显示的是同一份配置。
     *
     * 只影响之后新建的 child：已存在的 running/idle/ready child 的 persona 由
     * DSH subagent 持久化在 continuation descriptor 上，保存设置不会改写它，
     * 也不会触发 steer/interrupt/销毁。
     *
     * @param {string} role - 专家角色 id。
     * @returns {string} 最终 persona（固定纪律恰好追加一次）。
     */
    function resolvePersonaForAdmission(role) {
      return resolveExpertPersona(role, promptOverrideFor(readSettingsSource()?.[PROMPT_OVERRIDES_SETTINGS_KEY], role), roleCatalog());
    }


    /**
     * 解析 admission 时的 persona；角色已不在内置目录时返回 undefined。
     *
     * 只服务历史 child 的恢复路径：调用方必须先尝试 child 创建时持久化的 persona 快照，
     * 只有快照缺失时才回落到当前目录；目录也没有该角色时由调用方 fail-closed
     * （绝不用通用人格启动专家）。
     *
     * @param {string} role - 专家角色 id。
     * @returns {string|undefined} 完整 persona；未知角色返回 undefined。
     */
    function resolvePersonaForAdmissionOrRecorded(role) {
      if (!roleCatalog().has(role)) return void 0;
      return resolvePersonaForAdmission(role);
    }


    /**
     * 角色可编辑默认 persona（不抛错；未知角色返回 undefined）。
     *
     * @param {string} role - 角色 id。
     * @returns {string|undefined} 默认 persona；未知角色返回 undefined。
     */
    function defaultPersonaForRole(role) {
      const entry = roleCatalog().get(role);
      return entry === void 0 ? void 0 : defaultExpertPersonaOf(entry);
    }

  return {
    describeRolePrompts,
    resolvePersonaForAdmission,
    resolvePersonaForAdmissionOrRecorded,
    defaultPersonaForRole,
  };
}
