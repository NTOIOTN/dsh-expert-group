window.__ModuleLoader__.load({
  id: "dsh-expert-group",
  factory: (require) => {
    /**
     * freshness/RPC 纯逻辑的唯一实现位于 client-freshness.js（浏览器安全 ES 模块）。
     * 本文件是 Host 直接原样下发的 classic bundle，浏览器 classic script 解析不支持
     * import/export，因此这里只保留一个 ModuleLoader adapter：先用 client-freshness
     * 模块自己的登记函数把它放进同一张模块表，再按模块 id 取回唯一实现。
     * 宿主只加载包 exports["./client"] 指向的装配产物（scripts/assemble-client.mjs），
     * 该产物恒含 classic 投影片段，因此共享模块一定先于本 descriptor 登记；client.js
     * 不再内联第二份同语义实现（那份副本让安装体积双份，且两份代码会各自漂移）。
     * 取 specifier 时不做路径归一：DSH 的 require 命中同一张 id 表，只有
     * `<id>/client` 这种 exports 子路径会被 stripClientSuffix 归一。
     */
    const FRESHNESS_MODULE_ID = "dsh-expert-group/client-freshness";
    const freshnessModule = (() => {
      if (typeof require !== "function") return void 0;
      for (const specifier of [FRESHNESS_MODULE_ID, "./" + FRESHNESS_MODULE_ID, "./client-freshness.js"]) {
        try {
          const loaded = require(specifier);
          if (loaded !== null && typeof loaded === "object") return loaded;
        } catch { /* 未登记，尝试下一个 specifier 形式。 */ }
      }
      return void 0;
    })();
    if (typeof freshnessModule?.registerClientFreshnessModule === "function"
      && typeof globalThis !== "undefined" && globalThis.__ModuleLoader__ !== void 0) {
      // 由本模块把自己的 descriptor 登记回同一张表：client-freshness.js 不能被单独
      // serve（bundle 路由只服务 package exports["./client"]），登记是它进入运行期的唯一路径。
      freshnessModule.registerClientFreshnessModule(globalThis.__ModuleLoader__);
    }
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // assembler 保证两个浏览器安全 IIFE 先于唯一 ModuleLoader descriptor 执行；
    // 直接加载 client.js 的旧 Host/测试没有这些 Symbol 时保持无侧栏降级。
    const expertGroupModel = globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
    const expertGroupSidebar = globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];


    // ── 装配期检查点（R8 票据 26）────────────────────────────────────────────
    // 拆出的客户端模块各自先于本 descriptor 执行，只把「被后续段实际消费」的符号挂在
    // globalThis 的 public Symbol 上。这里按模块分组取回，语义与拆分前的工厂作用域一致
    // （同名、同值、同一批函数实例）。缺失检查点时保持 undefined：契约外直载 client.js 的
    // 旧宿主不会在装载期抛错，行为与既有的无侧栏降级一致。
    const clientTextLayer = globalThis[Symbol.for("dsh-expert-group/client-text")] || {};
    const {
      SETTINGS_EXTRA_MESSAGES, SETTINGS_ZH_FALLBACK, settingsExtraText,
    } = clientTextLayer;
    const clientStylesModule = globalThis[Symbol.for("dsh-expert-group/client-styles")] || {};
    const {
      ensurePluginStylesheet,
    } = clientStylesModule;
    const clientModelConfigHostModule = globalThis[Symbol.for("dsh-expert-group/client-model-config-host")] || {};
    const {
      CUSTOM_PROFILE_BASE_PATH, CUSTOM_PROVIDER_NS, CUSTOM_ROUTE_PROBE, createModelConfigHost,
    } = clientModelConfigHostModule;
    const clientFanoutModule = globalThis[Symbol.for("dsh-expert-group/client-fanout-normalize")] || {};
    const {
      fanoutCanCancelParent, fanoutCanCancelShard, fanoutCanRetryShard, fanoutStatusLabel, fanoutTaskLabel, mergeFanoutEvent,
      normalizeFanoutListResponse, normalizeFanoutTask,
    } = clientFanoutModule;
    const clientNativeStatusModule = globalThis[Symbol.for("dsh-expert-group/client-native-status")] || {};
    const {
      NATIVE_RUNNING_STATUS_PREFIX, NATIVE_RUNNING_STATUS_PREFIXES, STATUS_ROLE_IDS, STATUS_ROLE_LABELS, createNativeTextRewriter, findNativeConversationScope,
      findNativeStatusTextNode, replaceNativeStatusPrefix, resolveRunningStatusText,
    } = clientNativeStatusModule;
    const clientSettingsNormalizeModule = globalThis[Symbol.for("dsh-expert-group/client-settings-normalize")] || {};
    const {
      PROMPT_ROLE_IDS, addModelCandidatePage, commitSettingsCandidate, compactModelCandidatesDraft, countUnicodeGraphemes, createSettingsModelCatalog,
      migrateSettingsDefaults, migrateSettingsSelection, modelLayerSelectionOf, modelPageCountOf, normalizeModelCandidatesDraft, normalizeModelFallbackLimitDraft,
      normalizePromptOverrides, normalizeRolePromptProjection, normalizeSettingsDraft, normalizeSettingsModelGroups, removeModelCandidatePage, reorderModelLayers,
      resolveSettingsForm, setModelLayerSelection, syncSettingsDefaultsProvider, unifiedProviderOf, useHostMeta, validateModelCandidateRows, validatePromptText,
    } = clientSettingsNormalizeModule;
    const clientSubagentModule = globalThis[Symbol.for("dsh-expert-group/client-subagent-metadata")] || {};
    const {
      SubagentMetadataBridge, applySubagentMetadata, collectSubagentCatalog, expertGroupRootSessionIdOf, findNativeSubagentRowParts, findNativeSubagentTreeItems,
      findNativeSubagentTrees, formatSubagentMetadata, installNativeStatusBridge, normalizeSubagentMetadata, removeSubagentMetadata, requestSubagentMetadata,
    } = clientSubagentModule;
    const clientSettingsMainBModule = globalThis[Symbol.for("dsh-expert-group/client-settings-main-b")] || {};
    const clientSettingsMainAModule = globalThis[Symbol.for("dsh-expert-group/client-settings-main-a")] || {};
    const {
      DshExpertGroupSettings,
    } = clientSettingsMainAModule;
    const clientModelViewsAModule = globalThis[Symbol.for("dsh-expert-group/client-model-views-a")] || {};
    const clientModelViewsBModule = globalThis[Symbol.for("dsh-expert-group/client-model-views-b")] || {};
    const clientProviderCardModule = globalThis[Symbol.for("dsh-expert-group/client-provider-card")] || {};
    const clientModelSectionModule = globalThis[Symbol.for("dsh-expert-group/client-model-section")] || {};
    const {
      ModelConfigSection,
    } = clientModelSectionModule;
    const clientConversationAdaptersModule = globalThis[Symbol.for("dsh-expert-group/client-conversation-adapters")] || {};
    const {
      FullSystemPromptNode, installImageSubmissionRoute,
    } = clientConversationAdaptersModule;
    const clientNavIconModule = globalThis[Symbol.for("dsh-expert-group/client-nav-icon")] || {};
    const {
      DEG_SETTINGS_SECTION_ID, DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS, DEG_SETTINGS_NAV_ICON_PATHS,
      installDegSettingsNavIcon, isDegSettingsNavRow,
    } = clientNavIconModule;
    const clientPluginDetailModule = globalThis[Symbol.for("dsh-expert-group/client-plugin-detail")] || {};
    const {
      DEG_PLUGIN_DETAIL_ENTRY_KEY, DEG_PLUGIN_DETAIL_SLOT_NAME, DEG_SETTINGS_SECTION_SLOT_NAME,
      DegPluginDetailSummary, describeDegPluginDetailSummary, resolveDegSettingsSectionOpener,
    } = clientPluginDetailModule;
    // 样式表仍在原位置幂等注入（设置页导航与模型配置卡片共用同一份 css）。
    ensurePluginStylesheet();
    // 路由路径是插件固定接口，供 Host 与 Client 共享；纯内部标识，用户不可见。
    const RPC_PATH = "/api/dsh-expert-group";
    const RPC_CHANNEL = "/dsh-expert-group";
    const RPC_ENDPOINT = "rpc";

    /** RPC 路由常量打包成 seam，交由 client-freshness.js 使用（不在两处硬编码路径）。 */
    const RPC_TARGET = Object.freeze({ path: RPC_PATH, channel: RPC_CHANNEL, endpoint: RPC_ENDPOINT });

    /**
     * freshness/RPC 共享缝的**唯一实现**在 client-freshness.js（浏览器安全 ES 模块）。
     * 构建期投影片段已把同一份实现登记进本 bundle 的模块表，因此下面只保留转发壳：
     * 不再内联第二份同语义实现——那份副本既让安装体积双份，又会与权威实现各自漂移。
     * 共享模块缺失意味着契约外直载 client.js 或装配产物被裁剪（宿主只加载
     * exports["./client"] 的装配结果，其中投影恒在本 descriptor 之前执行），此时必须
     * 显式失败：静默降级成"看起来能用"的另一套实现，正是本波要消除的漂移风险。
     *
     * 每次调用都重新经过模块表解析（`require` 是 DSH 模块表的唯一入口）：HMR 换掉
     * client-freshness 的登记工厂后，本插件必须转发到**新的**那份实现，而不是记住
     * factory 执行瞬间的那一份。
     */
    function resolveFreshnessSurface() {
      if (typeof require === "function") {
        for (const specifier of [FRESHNESS_MODULE_ID, "./" + FRESHNESS_MODULE_ID, "./client-freshness.js"]) {
          try {
            const loaded = require(specifier);
            if (loaded !== null && typeof loaded === "object") return loaded;
          } catch { /* 未登记，尝试下一个 specifier 形式。 */ }
        }
      }
      return freshnessModule;
    }

    function requireFreshnessSurface() {
      const surface = resolveFreshnessSurface();
      if (surface === void 0) {
        throw new Error("dsh-expert-group: freshness 共享模块未装载（发布 bundle 缺少 client-freshness 投影片段）");
      }
      return surface;
    }

    /** 错误 code → status 映射由共享实现统一（Connection envelope 与 legacy fetch 同一份判定）。 */
    function rpcErrorStatus(error) {
      return requireFreshnessSurface().rpcErrorStatus(error);
    }

    /** 将 Connection envelope 归一为 fetch-like Response，保持两条传输的错误字段一致。 */
    function normalizePluginRpcResult(result) {
      return requireFreshnessSurface().normalizePluginRpcResult(result);
    }

    /**
     * 优先使用 DSH Connection 的独立插件 channel，认证和 envelope 由 Connection 统一处理；
     * 没有新 Connection 的旧 Host 才回落到同源 fetch，路由常量由这里注入（不在两处硬编码）。
     */
    async function requestPluginRpc(connection, request, init = {}, fetchImpl = globalThis.fetch) {
      return requireFreshnessSurface().requestPluginRpc(connection, request, init, fetchImpl, RPC_TARGET);
    }

    /**
     * Client 双面共享的 freshness seam：唯一实现位于 client-freshness.js，
     * 这里只做 ModuleLoader 投影转发（共享实现已在 bundle 内登记）。
     */
    function createClientFreshnessBoundary(options = {}) {
      return requireFreshnessSurface().createClientFreshnessBoundary(options);
    }


    // 已拆出模块在装配期先执行，拿不到 require() 之后的宿主面：这里一次性注入运行期依赖。
    // 全部是函数声明或已初始化的路由常量，注入本身无副作用（取值只发生在组件/桥运行期）。
    const clientRuntimeHost = Object.freeze({
      react, primitives, requestPluginRpc, requireFreshnessSurface, createClientFreshnessBoundary,
      RPC_PATH, RPC_CHANNEL, RPC_ENDPOINT, RPC_TARGET, ModelConfigSection,
    });
    clientSettingsNormalizeModule.bindClientRuntime?.(clientRuntimeHost);
    clientSubagentModule.bindClientRuntime?.(clientRuntimeHost);
    clientSettingsMainBModule.bindClientRuntime?.(clientRuntimeHost);
    clientSettingsMainAModule.bindClientRuntime?.(clientRuntimeHost);
    clientModelViewsAModule.bindClientRuntime?.(clientRuntimeHost);
    clientModelViewsBModule.bindClientRuntime?.(clientRuntimeHost);
    clientProviderCardModule.bindClientRuntime?.(clientRuntimeHost);
    clientModelSectionModule.bindClientRuntime?.(clientRuntimeHost);
    clientConversationAdaptersModule.bindClientRuntime?.(clientRuntimeHost);
    clientPluginDetailModule.bindClientRuntime?.(clientRuntimeHost);
    // ── 插件主体：注册设置页与状态/元数据桥（通知由 Host 投递，客户端不挂载通知组件）。
    function apply(ctx) {
      ctx.effect(() => installImageSubmissionRoute(ctx), "dsh-expert-group: image submission route");
      // 设置页导航行的图标由宿主按 section id 硬编码（未知 id 回退齿轮），插件侧只能做 DOM 适配。
      ctx.effect(() => installDegSettingsNavIcon(), "dsh-expert-group: settings nav brand icon");
      ctx.effect(() => installNativeStatusBridge(ctx), "dsh-expert-group: native status bridge");
      const slots = ctx.slots;
      // 原生 system-prompt renderer 会通过 boundedText 截断；该 keyed renderer 只替换显示层，注册生命周期由 slots.inject 绑定到插件上下文。
      slots.inject("conversation.chat.node", () => slots.register({
        name: "conversation.chat.node",
        key: "system-prompt",
        priority: -1,
      }, FullSystemPromptNode));
      /**
       * 设置表单服务的安全解析（0.1.7-alpha.2 契约）。
       *
       * 唯一来源是 `ctx.configForms`（已删除的 `settingsScope` 不再存在，不做任何回退）：
       * 宿主没提供该服务、或服务代理拒答时返回 null，调用方据此走「不可用」降级，
       * 绝不让整条客户端入口失败（插件仍需注册设置页、侧边栏与通知桥）。
       */
      const resolveConfigForms = () => {
        try {
          const service = typeof ctx?.get === "function" ? ctx.get("configForms") : ctx?.configForms;
          return service !== undefined && service !== null ? service : null;
        } catch {
          // 未声明服务读取即抛错（Cordis 门控）：按宿主没有该服务处理。
          return null;
        }
      };
      const configForms = resolveConfigForms();
      /**
       * 取本插件 profile 条目的配置表单；条目 id 由 bundle 补丁固定为 `dsh-expert-group`。
       *
       * 表单由宿主（settings 提供者）持有，DEG 只读取与订阅，绝不销毁、也绝不调用它的
       * set/unset/mutate。服务缺失或 `get` 抛错时返回一个**不可用替身**：快照形状与真实表单
       * 完全一致（status: unavailable），设置页因此显示可读的不可用提示而不是崩溃。
       */
      const SETTINGS_ENTRY_ID = DEG_SETTINGS_SECTION_ID;
      const UNAVAILABLE_SETTINGS_SNAPSHOT = Object.freeze({
        status: "unavailable",
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: "memory",
      });
      // 表单解析提到模块级（票据 39）：内联 IIFE 里的 7 个单行箭头（getSnapshot/subscribe
      // 各两份 + 外层 IIFE）会让 descriptor factory 的「单闭包内函数数」超过 40。
      const settingsForm = resolveSettingsForm(configForms, SETTINGS_ENTRY_ID, UNAVAILABLE_SETTINGS_SNAPSHOT);
      const modelCatalog = createSettingsModelCatalog(ctx);
      // 「模型配置」区域的数据流与宿主面适配层：唯一纯函数实现位于 client-model-config.js
      // （装配期先于本 descriptor 执行的 IIFE），这里只做公开 API 接线。
      // describe 面唯一来源是 configForms.describe()；服务缺失时传 null，该区域降级为只读提示。
      const modelConfigHost = createModelConfigHost(ctx, configForms);
      // 独立设置页由插件注册到 Host 的 settings.section ledger，导航和生命周期仍由设置 Shell 管理。
      slots.inject(DEG_SETTINGS_SECTION_SLOT_NAME, () => slots.register({
        name: DEG_SETTINGS_SECTION_SLOT_NAME,
        id: SETTINGS_ENTRY_ID,
        order: 25,
        label: () => SETTINGS_ENTRY_ID,
        inject: () => ({ settingsForm, modelCatalog, modelConfigHost, ctx }),
      }, DshExpertGroupSettings));

      // 插件详情摘要挂在插件管理器的组合包页上：keyed slot，key 必须是组合包的 npm 包名。
      // 摘要只读（配置表单 + 模型目录 + meta），入口按钮走严格能力适配器真实跳转设置分区。
      slots.inject(DEG_PLUGIN_DETAIL_SLOT_NAME, () => slots.register({
        name: DEG_PLUGIN_DETAIL_SLOT_NAME,
        key: DEG_PLUGIN_DETAIL_ENTRY_KEY,
        inject: () => ({ settingsForm, modelCatalog, ctx }),
      }, DegPluginDetailSummary));

      // shell.overlay 只保留原生子代理行元数据；
      // fan-out 的可见控制面迁入 Expert Group，避免固定浮层与右侧任务树重复。
      // 通知不再占用 overlay：**系统通知（Windows 右下角 Toast）是唯一通知界面**，由 Host 侧
      // 负责投递；客户端既不渲染页面内卡片，也不创建浏览器 Notification，更不轮询通知快照，
      // 因此这里没有任何通知组件，也不再声明 inject（设置表单只服务设置页）。
      // 注册账本（同一 slot、同一个 descriptor id）保持不变。
      slots.inject("shell.overlay", () => slots.register({
        name: "shell.overlay",
        id: "dsh-expert-group-overlay",
        order: 0,
      }, (props) => react.createElement(
        react.Fragment,
        null,
        react.createElement(SubagentMetadataBridge, { ...props, ctx }),
      )));

      installSettingsBoundSidebar(ctx, { settingsForm, modelCatalog });
    }

    /**
     * 设置驱动的侧栏安装编排（从 apply 外移：apply 必须守住单函数 ≤200 行）。
     *
     * 注册时机与顺序、settings 订阅与 disposer 栈的语义与拆分前逐字一致：helper 仍是
     * descriptor 闭包内的函数声明；settingsForm / modelCatalog 由 apply 显式传入（它们是
     * apply 内创建的对象），commitSettingsCandidate / requestPluginRpc 等直接从 descriptor
     * 作用域读取，不新增第二份实现。
     */
    function installSettingsBoundSidebar(ctx, { settingsForm, modelCatalog }) {
      if (typeof expertGroupSidebar?.installExpertGroupSidebar !== "function") return;
        /**
         * settings 的「任务管理」开关控制 Expert Group 是否注册到侧边栏。
         *
         * - 缺字段/读取失败一律按开启处理：默认必须是历史行为（插件注册自己的侧边栏页面，
         *   DSH 或 dsh-better-sidebar 的默认侧栏保持不变）；
         * - 关闭时调用当前 install 返回的 disposer 释放已有注册（不回退、不改动 better-sidebar
         *   的 tabsEnabled 偏好，也不新增 DSH 本体注册）；
         * - install 返回的 disposer 不可复用，重新开启必须重新 install；
         * - 插件销毁时取消 settings 订阅并释放当前 disposer。
         */
        const sidebarDeps = {
          react,
          primitives,
          requestPluginRpc,
          resolveRootSessionId: expertGroupRootSessionIdOf,
          sessions: ctx.sessions,
          slots: ctx.slots,
          /**
           * 侧边栏「会话模型」复用设置页**同一份**模型目录 store（provider/model 的 datalist
           * 与思考深度档位都来自它）。目录的加载/刷新仍由该 store 单飞管理，侧栏只读
           * getSnapshot/subscribe，绝不自己再建一份目录或发额外请求。
           */
          modelCatalog,
          // 浏览器 confirm 是同步 API，Panel 以 Promise/boolean 双兼容方式消费。
          confirm: (message) => typeof globalThis.confirm === "function" && globalThis.confirm(message) === true,
          /**
           * 「自动打开」的实时读面：面板每次同步都现读配置表单快照。
           *
           * 不在这里读取一次再当常量传下去：设置页保存后必须立刻生效，而重装整个侧边栏
           * （disposer 不可复用）只为跟随一个偏好是过度且会打断侧栏状态的做法。
           * 读取失败/字段缺失一律按关闭（历史行为）。
           */
          getAutoOpenSubagentSidebar: () => readAutoOpenSubagentSidebar(),
          /** 面板标题栏 Auto 开关的写面：必须显式提交布尔值，否则设置页会一直显示旧值。 */
          setAutoOpenSubagentSidebar: (next) => commitAutoOpenSubagentSidebar(next),
        };
        /**
         * 「自动打开运行中的子代理侧栏」读面：唯一来源是配置表单当前快照。
         *
         * 只有显式 true 才算开启——旧文档缺字段、非布尔值与读取异常全部按关闭处理，
         * 保证默认行为与历史逐字节一致（不做任何自动 open/close）。
         */
        const readAutoOpenSubagentSidebar = () => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            return snapshot?.value?.autoOpenSubagentSidebar === true;
          } catch {
            return false;
          }
        };
        /**
         * 写面：把表单快照原样作为整体候选，只翻转 autoOpenSubagentSidebar 一个字段。
         *
         * 走的是设置页同一条 settings-commit（完整候选 + expectedRevision CAS），因此
         * 宿主的语义校验与并发栅栏照常生效；这里**不**重放设置页草稿，避免把未保存的
         * 编辑顺带提交。只读文档、快照不可用、校验失败或传输失败都返回 false，面板据此
         * 回退到权威读面（开关不会停在错误状态）。
         */
        const commitAutoOpenSubagentSidebar = async (next) => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            if (snapshot?.writable !== true) return false;
            const value = snapshot.value;
            if (value === null || typeof value !== "object") return false;
            await commitSettingsCandidate(
              { ...value, autoOpenSubagentSidebar: next === true },
              snapshot.revision,
              globalThis.fetch,
              ctx?.connection,
              PROMPT_ROLE_IDS,
            );
            return true;
          } catch {
            // 失败原因（只读/目录校验/修订冲突）由设置页承担呈现；面板只回退开关状态。
            return false;
          }
        };
        const readTaskManagementEnabled = () => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            return snapshot?.value?.taskManagementEnabled !== false;
          } catch {
            // 读取配置表单异常（服务缺失/未就绪 store）不能导致侧边栏消失：按默认开启处理。
            return true;
          }
        };
        ctx.effect(() => {
          let disposer = null;
          const install = () => {
            if (disposer !== null) return;
            if (readTaskManagementEnabled() !== true) return;
            const release = expertGroupSidebar.installExpertGroupSidebar(ctx, {
              ...sidebarDeps,
              taskManagementEnabled: true,
            });
            disposer = typeof release === "function" ? release : null;
          };
          const uninstall = () => {
            const release = disposer;
            disposer = null;
            if (release === null) return;
            try {
              release();
            } catch {
              // 释放失败不能阻断后续重新安装，也不能让 settings 订阅清理失败。
            }
          };
          const sync = () => {
            if (readTaskManagementEnabled()) install();
            else uninstall();
          };
          // 初始化先同步读一次快照：缺字段/开启时必须在同步栈内完成注册，与历史行为一致。
          sync();
          let unsubscribe = () => {};
          if (typeof settingsForm?.subscribe === "function") {
            try {
              const release = settingsForm.subscribe(() => {
                try {
                  sync();
                } catch {
                  // 通知回调抛错不得污染配置表单；保持当前注册状态。
                }
              });
              if (typeof release === "function") unsubscribe = release;
            } catch {
              // 订阅不可用时保持首次快照决定的注册状态。
            }
          }
          return () => {
            try {
              unsubscribe();
            } catch {
              // 取消订阅失败不影响释放侧边栏注册。
            }
            unsubscribe = () => {};
            uninstall();
          };
        }, "dsh-expert-group-sidebar");
    }

    exports.normalizeSettingsModelGroups = normalizeSettingsModelGroups;
    exports.normalizeSettingsDraft = normalizeSettingsDraft;
    // 票据 24：设置页候选/降级上限的公开纯函数面（界面与测试共用同一实现）。
    exports.normalizeModelCandidatesDraft = normalizeModelCandidatesDraft;
    exports.normalizeModelFallbackLimitDraft = normalizeModelFallbackLimitDraft;
    exports.validateModelCandidateRows = validateModelCandidateRows;
    // 模型页签的「页 → 层」纯函数面（界面与测试共用同一实现，不复制数据语义）。
    exports.modelPageCountOf = modelPageCountOf;
    exports.modelLayerSelectionOf = modelLayerSelectionOf;
    exports.setModelLayerSelection = setModelLayerSelection;
    exports.reorderModelLayers = reorderModelLayers;
    exports.addModelCandidatePage = addModelCandidatePage;
    exports.removeModelCandidatePage = removeModelCandidatePage;
    exports.compactModelCandidatesDraft = compactModelCandidatesDraft;
    exports.SETTINGS_EXTRA_MESSAGES = SETTINGS_EXTRA_MESSAGES;
    exports.settingsExtraText = settingsExtraText;
    exports.countUnicodeGraphemes = countUnicodeGraphemes;
    exports.validatePromptText = validatePromptText;
    exports.normalizePromptOverrides = normalizePromptOverrides;
    exports.normalizeRolePromptProjection = normalizeRolePromptProjection;
    exports.unifiedProviderOf = unifiedProviderOf;
    exports.migrateSettingsSelection = migrateSettingsSelection;
    exports.syncSettingsDefaultsProvider = syncSettingsDefaultsProvider;
    exports.migrateSettingsDefaults = migrateSettingsDefaults;
    exports.commitSettingsCandidate = commitSettingsCandidate;
    exports.formatSubagentMetadata = formatSubagentMetadata;
    exports.normalizeSubagentMetadata = normalizeSubagentMetadata;
    exports.collectSubagentCatalog = collectSubagentCatalog;
    exports.requestSubagentMetadata = requestSubagentMetadata;
    exports.findNativeSubagentTrees = findNativeSubagentTrees;
    exports.findNativeSubagentTreeItems = findNativeSubagentTreeItems;
    exports.findNativeSubagentRowParts = findNativeSubagentRowParts;
    exports.applySubagentMetadata = applySubagentMetadata;
    exports.removeSubagentMetadata = removeSubagentMetadata;
    exports.findNativeConversationScope = findNativeConversationScope;
    /**
     * 原生运行状态投影的公开面（与 shared.js 的同名导出语义同步）：
     * - NATIVE_RUNNING_STATUS_PREFIX / replaceNativeStatusPrefix：只替换宿主文案里的运行前缀，
     *   逗号、用时与末尾省略号仍来自宿主原文；
     * - resolveRunningStatusText：当前会话 running + 角色已知时的前缀文案（不带省略号）；
     * - createNativeTextRewriter：单个字段前缀重写器的保存/替换/恢复语义；
     * - findNativeStatusTextNode：当前会话的可见主文本节点（RC1 返回 data-shimmer 非装饰子树
     *   的真实可见 Text，legacy 形态返回各自的可见 Text），与 shared.js 的选择语义一致；
     * - installNativeStatusBridge：把上面这些接进 DSH 原生运行行的 observer 生命周期。
     * 测试跨这些公开 seam 验证行为，不读取生产源码文本。
     */
    // 票据 19：设置页 zh 回退表（仅供契约测试对比权威消息表，不参与运行期业务判断）。
    exports.SETTINGS_ZH_FALLBACK = SETTINGS_ZH_FALLBACK;
    exports.NATIVE_RUNNING_STATUS_PREFIXES = NATIVE_RUNNING_STATUS_PREFIXES;
    exports.NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIX;
    exports.replaceNativeStatusPrefix = replaceNativeStatusPrefix;
    exports.resolveRunningStatusText = resolveRunningStatusText;
    exports.createNativeTextRewriter = createNativeTextRewriter;
    exports.findNativeStatusTextNode = findNativeStatusTextNode;
    exports.installNativeStatusBridge = installNativeStatusBridge;
    exports.normalizeFanoutTask = normalizeFanoutTask;
    exports.mergeFanoutEvent = mergeFanoutEvent;
    exports.fanoutTaskLabel = fanoutTaskLabel;
    exports.fanoutStatusLabel = fanoutStatusLabel;
    exports.fanoutCanCancelShard = fanoutCanCancelShard;
    exports.fanoutCanRetryShard = fanoutCanRetryShard;
    exports.fanoutCanCancelParent = fanoutCanCancelParent;
    exports.normalizeFanoutListResponse = normalizeFanoutListResponse;
    exports.createClientFreshnessBoundary = createClientFreshnessBoundary;
    exports.normalizePluginRpcResult = normalizePluginRpcResult;
    exports.requestPluginRpc = requestPluginRpc;
    exports.expertGroupModel = expertGroupModel;
    exports.expertGroupSidebar = expertGroupSidebar;
    /**
     * 「模型配置」区域的纯数据流实现（provider 目录装配、草稿/路径操作、七档
     * reasoningEfforts 映射、继承与恢复默认、revision 冲突与角色联动守卫）。
     *
     * 唯一实现位于 client-model-config.js（装配期先于本 descriptor 执行的 IIFE）；
     * 共享实现未装载时保持 undefined，设置页随即跳过整个区域，不影响角色配置。
     */
    exports.modelConfig = globalThis[Symbol.for("dsh-expert-group/client-model-config")];
    /**
     * 用公开 API 装配「模型配置」宿主面（remote.llm / remote.credentials / remote.settings，
     * 以及 configForms.describe()）。导出给设置页与测试共用同一实现，不复制数据流。
     */
    exports.createModelConfigHost = createModelConfigHost;
    exports.MODEL_REASONING_EFFORTS = Object.freeze([
      "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    /**
     * 设置页导航行品牌图标（DOM 适配）的公开面：
     * - DEG_SETTINGS_NAV_ICON_PATHS / DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS：artwork 常量，
     *   测试据此断言与 client-expert-group-sidebar.js 的 BRAND_ICON_PATHS 同值；
     * - isDegSettingsNavRow：导航行的匹配纯逻辑（label 严格相等 + 含 svg）；
     * - installDegSettingsNavIcon：observer 生命周期，apply 用 ctx.effect 绑定它。
     */
    /**
     * 插件详情摘要的公开面：
     * - describeDegPluginDetailSummary：六角色 / 活跃 provider 的纯投影（界面与测试共用同一实现）；
     * - resolveDegSettingsSectionOpener：唯一一处接触 Host 内部 sidebar.settings store 句柄的
     *   严格能力适配器（未文档化方案，用户已确认接受兼容风险）；
     * - DEG_PLUGIN_DETAIL_SLOT_NAME / DEG_PLUGIN_DETAIL_ENTRY_KEY：注册契约常量。
     */
    exports.describeDegPluginDetailSummary = describeDegPluginDetailSummary;
    exports.resolveDegSettingsSectionOpener = resolveDegSettingsSectionOpener;
    exports.DEG_PLUGIN_DETAIL_SLOT_NAME = DEG_PLUGIN_DETAIL_SLOT_NAME;
    exports.DEG_PLUGIN_DETAIL_ENTRY_KEY = DEG_PLUGIN_DETAIL_ENTRY_KEY;
    exports.DEG_SETTINGS_NAV_ICON_PATHS = DEG_SETTINGS_NAV_ICON_PATHS;
    exports.DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS = DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
    exports.isDegSettingsNavRow = isDegSettingsNavRow;
    exports.installDegSettingsNavIcon = installDegSettingsNavIcon;
    exports.apply = apply;
    exports.inject = [
      "slots", "sessions", "configForms", "remote", "remote.session", "remote.llm", "remote.credentials", "remote.settings", "conversation", "connection",
      // 「模型配置」区域使用公开的 settings schema 服务（rehydrate/validate/nodeAtPath）；
      // 未安装时该区域降级为"不本地校验"，仍由正式 settings API 做 schema 校验。
      "settingsSchema",
    ];
    return module.exports;
  }
});