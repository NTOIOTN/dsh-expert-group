/**
 * 插件详情（组合包页）上的 DEG 配置摘要（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-plugin-detail")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientPluginDetail(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-plugin-detail");
  const clientNativeStatusSymbol = Symbol.for("dsh-expert-group/client-native-status");
  const clientNativeStatus = global[clientNativeStatusSymbol] || {};
  const clientSettingsNormalizeSymbol = Symbol.for("dsh-expert-group/client-settings-normalize");
  const clientSettingsNormalize = global[clientSettingsNormalizeSymbol] || {};
  const clientNavIconSymbol = Symbol.for("dsh-expert-group/client-nav-icon");
  const clientNavIcon = global[clientNavIconSymbol] || {};
  const { STATUS_ROLE_IDS, STATUS_ROLE_LABELS } = clientNativeStatus;
  const { useHostMeta } = clientSettingsNormalize;
  const { DEG_SETTINGS_SECTION_ID } = clientNavIcon;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

    // ── 插件详情（DSH 插件管理器的组合包页）上的 DEG 配置摘要 ────────────────
    /**
     * 组合包详情页的配置 slot 名与 key。
     *
     * DSH 的 ui-plugin-manager 把 `plugins.bundle.config` 声明为 keyed slot，以组合包的
     * **npm 包名**为 key，并把 `view: 'page'` 渲染在组合包页面的描述与行之间——这正是
     * 本插件详情摘要的落点。key 与 settings 分区 id 同值（profile 条目 id 就是包名），
     * 因此复用同一份字面量，不新增第二处硬编码。
     */
    const DEG_PLUGIN_DETAIL_SLOT_NAME = "plugins.bundle.config";
    const DEG_PLUGIN_DETAIL_ENTRY_KEY = DEG_SETTINGS_SECTION_ID;
    /** 设置 Shell 的侧栏席位：openSection 能力句柄的唯一来源。 */
    const DEG_SETTINGS_SIDEBAR_SLOT_NAME = "sidebar.settings";
    /** DEG 自己注册的设置分区所在的 slot。 */
    const DEG_SETTINGS_SECTION_SLOT_NAME = "settings.section";

    /**
     * 「打开 DEG 设置」各失败原因的用户可见提示。
     *
     * 每条都表达「为什么不能跳转」，且都不包含宿主异常原文（异常只按 open-failed 归类），
     * 避免把宿主内部信息回显到界面上。
     */
    const DEG_SETTINGS_OPEN_FAILURE_TEXT = Object.freeze({
      "slots-unavailable": "宿主未提供 slot 账本读取面，暂时无法跳转到 DEG 设置",
      "sidebar-entry-missing": "未找到设置侧栏入口，暂时无法跳转到 DEG 设置",
      "sidebar-entry-ambiguous": "设置侧栏入口不唯一，已停用跳转",
      "store-missing": "设置侧栏入口缺少顶层导航 store，已停用跳转",
      "open-section-missing": "设置侧栏入口缺少 openSection 动作，已停用跳转",
      "section-missing": "DEG 设置分区尚未注册，暂时无法跳转",
      "section-ambiguous": "DEG 设置分区注册重复，已停用跳转",
      // 账本条目上的属性读取（entry/options/store/actions/create/instance.actions 的 getter）抛错：
      // 归到同一类泛化提示，既不回显宿主异常原文，也不假装能力可用。
      "ledger-unreadable": "Slot 账本读取异常，已停用跳转",
      "open-failed": "打开 DEG 设置失败，请手动打开设置页",
    });

    /** 读一个 slot 的账本；宿主没有该读面或读面抛错时返回 null（调用方 fail-closed）。 */
    function readSlotLedger(slots, name) {
      try {
        if (slots === null || typeof slots !== "object" || typeof slots.entries !== "function") return null;
        const entries = slots.entries(name);
        return Array.isArray(entries) ? entries : [];
      } catch {
        // 宿主替身 / 代理拒答：按"读不到账本"处理，绝不让摘要或设置页因此崩溃。
        return null;
      }
    }

    /**
     * 从设置侧栏条目的 store 句柄里解析 openSection。
     *
     * DSH 的 ui-settings-general 用 `defineStore` 造 shell store，再以
     * `{ ...handle, create: () => instance }` 的形式注册到 `sidebar.settings` 席位；DSH
     * 0.2.0-rc.2 把它投影为条目的**顶层 `store`**（不是 `entry.options.store`）。句柄本身
     * 没有 actions，实例（`create()` 的返回值，且恒为同一份壳实例）才带 `actions`。
     * 因此这里按「句柄 → 实例 → actions」解析，并兼容直接把 actions 挂在 store 上的形态。
     * 只有 `store.create()` 的**调用**在本函数内捕获（返回 null → open-section-missing）；
     * 属性 getter 抛错（store.actions / store.create / instance.actions / actions.openSection）
     * 刻意向外抛出，由调用方归到 ledger-unreadable 这一类——两种失败类别不能混为一谈。
     * 任一环节缺失都不猜、不回退到别的动作。
     */
    function resolveSettingsShellOpenSection(store) {
      if (store === null || typeof store !== "object") return null;
      const direct = store.actions;
      if (direct !== null && typeof direct === "object" && typeof direct.openSection === "function") {
        return direct.openSection.bind(direct);
      }
      if (typeof store.create !== "function") return null;
      let instance = null;
      try {
        instance = store.create();
      } catch {
        return null;
      }
      const actions = instance?.actions;
      if (actions === null || typeof actions !== "object" || typeof actions.openSection !== "function") return null;
      return actions.openSection.bind(actions);
    }

    /**
     * 「打开 DEG 设置」的严格能力适配器。
     *
     * 当前 DSH 不提供公开的设置分区跳转 API，唯一可达的链路是设置 Shell 注册在
     * `sidebar.settings` 席位上的 store 句柄（**未文档化的宿主内部句柄**，用户已确认接受
     * 该兼容风险）。本函数是本插件里**唯一**接触该句柄的地方，调用方只拿到一个已经验证过的
     * openSection 函数。
     *
     * 每次调用都重新读取账本（组件每帧渲染、每次点击都会再读一次），因此 HMR 或面板重挂载
     * 换掉 store 后不会继续调用旧句柄；任何一项校验不过都 fail-closed 并给出原因：
     * - 宿主缺少 `slots.entries` 读面 / 读面抛错 → slots-unavailable；
     * - 账本条目属性 getter 抛错（entry.options / **entry.store** / store.actions / store.create /
     *   instance.actions / actions.openSection）→ ledger-unreadable（同一类泛化提示）；
     * - `sidebar.settings` 没有条目 → sidebar-entry-missing；多于一条 → sidebar-entry-ambiguous；
     * - 条目**顶层**缺少 store（entry.store 非对象）→ store-missing；
     *   store 解不出 openSection → open-section-missing
     *   （含 `store.create()` 调用抛错这一既有覆盖）；
     * - DEG 自己的 `settings.section` 注册缺失 → section-missing；重复 → section-ambiguous。
     * 最后一项保证按钮不会把用户送到一个不存在的分区。
     *
     * @param {object} ctx 客户端插件上下文。
     * @returns {{available: boolean, reason: string|null, message: string|null, openSection: (Function|null)}}
     */
    function resolveDegSettingsSectionOpener(ctx) {
      const unavailable = (reason) => ({
        available: false,
        reason,
        message: DEG_SETTINGS_OPEN_FAILURE_TEXT[reason],
        openSection: null,
      });
      let slots = null;
      try {
        slots = ctx?.slots ?? null;
      } catch {
        slots = null;
      }
      const sectionEntries = readSlotLedger(slots, DEG_SETTINGS_SECTION_SLOT_NAME);
      const sidebarEntries = readSlotLedger(slots, DEG_SETTINGS_SIDEBAR_SLOT_NAME);
      if (sectionEntries === null || sidebarEntries === null) return unavailable("slots-unavailable");
      // 账本读取整段护栏：Host 的账本条目可能是代理对象，甚至 slots.entries 可以返回
      // Array.isArray 为真的**数组代理**。因此不只是 entry.options / entry.store 的 getter，
      // 数组自身的 length 与下标读取也可能抛错——它们必须一起归到同一类 fail-closed，
      // 绝不让一次渲染或一次点击把摘要打崩。
      let ownSectionCount = 0;
      let sidebarLength = 0;
      try {
        ownSectionCount = sectionEntries.filter((entry) => entry?.options?.id === DEG_SETTINGS_SECTION_ID).length;
        sidebarLength = sidebarEntries.length;
      } catch {
        return unavailable("ledger-unreadable");
      }
      if (ownSectionCount === 0) return unavailable("section-missing");
      if (ownSectionCount > 1) return unavailable("section-ambiguous");
      if (sidebarLength === 0) return unavailable("sidebar-entry-missing");
      if (sidebarLength > 1) return unavailable("sidebar-entry-ambiguous");
      let store = null;
      let openSection = null;
      try {
        // DSH 0.2.0-rc.2 的 StoredEntry 把 store 放在**条目顶层**（entry.store）；
        // entry.options 只承载 key/order/label/priority，读 options.store 只会拿到 undefined。
        store = sidebarEntries[0]?.store;
        if (store !== null && store !== undefined && typeof store === "object") {
          openSection = resolveSettingsShellOpenSection(store);
        }
      } catch {
        // entry.store / actions / create / instance.actions 的 getter 抛错：与"字段缺失"分开，
        // 统一报账本读取异常（泛化提示，不回显宿主异常原文）。
        return unavailable("ledger-unreadable");
      }
      if (store === null || store === undefined || typeof store !== "object") return unavailable("store-missing");
      if (openSection === null) return unavailable("open-section-missing");
      return { available: true, reason: null, message: null, openSection };
    }

    /**
     * 插件详情摘要的角色状态投影（与设置页的 `useEnabledSettingsRoles` **刻意分离**）。
     *
     * 设置页在 meta 缺失时回退历史默认五角色是既有行为，摘要不能借它：meta 没读到就不知道谁在跑，
     * 猜错会把未启用角色的 provider 写进"活跃 Provider"汇总，比留白更糟。因此只在 Host meta
     * **成功返回且带有效 activeRoles/roles 数组**时才认定启用角色；Observer 仍按 enableObserver
     * 合并（与设置页同一规则）。返回的 status 只表达"读到/读取中/不可用"三种事实。
     *
     * @param {object|null} hostMeta Host meta 响应体（useHostMeta 只在 ok:true 时落值）。
     * @param {string|null} hostMetaError 读取失败原因；仅用于区分"读取中"与"不可用"，不回显。
     * @returns {{status: "loading"|"ready"|"unavailable", roles: string[]|null}}
     */
    function resolvePluginDetailRoleStatus(hostMeta, hostMetaError) {
      if (hostMeta === null && hostMetaError === null) return { status: "loading", roles: null };
      const configured = hostMeta !== null && typeof hostMeta === "object"
        ? (Array.isArray(hostMeta.activeRoles) ? hostMeta.activeRoles : (Array.isArray(hostMeta.roles) ? hostMeta.roles : null))
        : null;
      if (configured === null) return { status: "unavailable", roles: null };
      const enabled = configured.filter((role) => STATUS_ROLE_IDS.includes(role));
      if (hostMeta.enableObserver === true && !enabled.includes("observer")) enabled.push("observer");
      return { status: "ready", roles: enabled.filter((role, index) => enabled.indexOf(role) === index) };
    }

    /**
     * 插件详情摘要的纯投影（界面与测试共用同一实现）。
     *
     * 输入只有已经读到的快照，不触发任何请求：
     * @param {object} [input]
     * @param {"ready"|"loading"|"unavailable"} [input.settingsStatus] 配置表单快照状态。
     * @param {object} [input.settingsValue] 配置表单值（`defaults[role] = { provider, model }`）。
     * @param {string} [input.catalogStatus] 模型目录状态（ready 之外的取值一律按"目录不可用"）。
     * @param {object[]} [input.catalogGroups] 模型目录 groups（`{ id, name }`）。
     * @param {string[]|null} [input.enabledRoles] 当前启用角色；null 表示角色表尚未读到。
     * @param {"ready"|"loading"|"unavailable"} [input.roleStatus] 角色表读取结论（见
     *   resolvePluginDetailRoleStatus）；缺省时按 enabledRoles 是否为数组推断。
     * @returns {{settingsStatus: string, roleStatus: string, statusText: string|null, roles: object[], activeProviders: object[], providerIds: string[], activeProviderText: string}}
     *
     * 角色状态判定顺序（前者优先）：
     * 1. 配置未就绪 → loading（文案区分"配置不可用"与"读取中"）；
     * 2. 角色表仍在读取 → loading；
     * 3. 角色表不可用（meta 失败/缺字段）→ unknown，不猜启用状态；
     * 4. 角色未启用 → disabled；
     * 5. 没有 provider 选择 → unconfigured；
     * 6. provider 已选但 model 为空（不完整配置）→ incomplete，不算"正在使用"；
     * 7. 其余（provider + model 都非空）→ configured。
     * 活跃 provider 只取「启用角色且 provider、model 都非空」的集合，按角色顺序去重；目录缺失或
     * 目录里没有该 id 时保留原始 id 并标记 `known: false`，绝不用目录里的其它 provider 冒充。
     */
    function describeDegPluginDetailSummary(input = {}) {
      const settingsStatus = typeof input.settingsStatus === "string" ? input.settingsStatus : "loading";
      const settingsValue = input.settingsValue;
      const catalogReady = input.catalogStatus === "ready";
      const catalogGroups = catalogReady && Array.isArray(input.catalogGroups) ? input.catalogGroups : [];
      const enabledRoles = Array.isArray(input.enabledRoles) ? input.enabledRoles : null;
      const requestedRoleStatus = input.roleStatus === "ready" || input.roleStatus === "unavailable" || input.roleStatus === "loading"
        ? input.roleStatus
        : (enabledRoles === null ? "loading" : "ready");
      // "已读到"却没有角色数组是矛盾输入（调用方读错了面）：按不可用处理，
      // 绝不当成"全部未启用"——后者会把未确认的默认角色配置从汇总里静默剔除。
      const roleStatus = requestedRoleStatus === "ready" && enabledRoles === null ? "unavailable" : requestedRoleStatus;
      const settingsPending = settingsStatus !== "ready";
      const defaults = settingsValue !== null && typeof settingsValue === "object" ? settingsValue.defaults : null;

      const providerInfoOf = (providerId) => {
        if (providerId.length === 0) return { label: "", known: false };
        const group = catalogGroups.find((candidate) => candidate?.id === providerId);
        const name = typeof group?.name === "string" && group.name.trim().length > 0 ? group.name : "";
        // 目录拿不到显示名（目录缺失 / 目录不含该 id / name 为空）时保留原始 id 并标注未知。
        return name.length > 0 ? { label: name, known: true } : { label: providerId, known: false };
      };

      const roles = [];
      const activeProviders = [];
      const seenProviders = new Set();
      for (const role of STATUS_ROLE_IDS) {
        const selection = defaults !== null && typeof defaults === "object" ? defaults[role] : null;
        const provider = typeof selection?.provider === "string" && selection.provider.length > 0 ? selection.provider : "";
        const model = typeof selection?.model === "string" ? selection.model : "";
        const { label: providerLabel, known: providerKnown } = providerInfoOf(provider);
        const enabledKnown = roleStatus === "ready";
        const enabled = enabledKnown && enabledRoles.includes(role) === true;
        let state;
        if (settingsPending || roleStatus === "loading") state = "loading";
        else if (roleStatus === "unavailable") state = "unknown";
        else if (enabled !== true) state = "disabled";
        else if (provider.length === 0) state = "unconfigured";
        else if (model.length === 0) state = "incomplete";
        else state = "configured";
        let stateText;
        if (state === "loading") stateText = settingsStatus === "unavailable" ? "配置不可用" : "读取中";
        else if (state === "unknown") stateText = "角色状态未知";
        else if (state === "disabled") stateText = "未启用";
        else if (state === "unconfigured") stateText = "未配置";
        else if (state === "incomplete") stateText = "待选模型";
        else stateText = "已配置";
        if (state === "configured" && seenProviders.has(provider) !== true) {
          seenProviders.add(provider);
          activeProviders.push({ id: provider, label: providerLabel, known: providerKnown });
        }
        roles.push({
          role,
          label: STATUS_ROLE_LABELS[role] ?? role,
          enabled,
          state,
          stateText,
          provider,
          providerLabel,
          providerKnown,
          model,
          // 角色行的 provider/model 展示面：没有 provider 时留空，由状态文案表达未配置。
          valueText: provider.length === 0 ? "" : (model.length > 0 ? providerLabel + " / " + model : providerLabel),
        });
      }
      // 卡片级状态行：只表达"读到/读取中/不可用"，绝不回显 Host 或 RPC 的错误原文。
      const statusText = settingsStatus === "unavailable"
        ? "配置表单不可用，无法读取角色配置。"
        : (settingsStatus !== "ready"
          ? "配置读取中…"
          : (roleStatus === "loading"
            ? "角色状态读取中…"
            : (roleStatus === "unavailable" ? "角色状态不可用，已停用活跃角色判定。" : null)));
      const providerIds = activeProviders.map((provider) => provider.id);
      return {
        settingsStatus,
        roleStatus,
        statusText,
        roles,
        activeProviders,
        providerIds,
        activeProviderText: activeProviders.length === 0
          ? "无"
          : activeProviders.map((provider) => provider.label).join("、"),
      };
    }

    /**
     * 插件详情摘要卡片：六角色表 + 活跃 provider + 真实设置跳转入口。
     *
     * 数据面全部来自公开 seam：配置表单（只读订阅）、模型目录（显示名），以及 Host meta
     * （活跃角色，与设置页同一个只读请求）。跳转能力每帧重算（见
     * resolveDegSettingsSectionOpener），点击时再算一次；调用抛异常时立即翻转成禁用，
     * 绝不把失败显示成成功，也绝不改成打开组合包详情。
     */
    function DegPluginDetailSummary({ settingsForm, modelCatalog, ctx }) {
      const subscribeSettings = react.useMemo(
        () => (typeof settingsForm?.subscribe === "function" ? settingsForm.subscribe.bind(settingsForm) : () => () => {}),
        [settingsForm],
      );
      const readSettings = react.useMemo(
        () => (typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot.bind(settingsForm) : () => void 0),
        [settingsForm],
      );
      const settingsSnapshot = react.useSyncExternalStore(subscribeSettings, readSettings);
      const subscribeCatalog = react.useMemo(
        () => (typeof modelCatalog?.subscribe === "function" ? modelCatalog.subscribe.bind(modelCatalog) : () => () => {}),
        [modelCatalog],
      );
      const readCatalog = react.useMemo(
        () => (typeof modelCatalog?.getSnapshot === "function" ? modelCatalog.getSnapshot.bind(modelCatalog) : () => void 0),
        [modelCatalog],
      );
      const catalogState = react.useSyncExternalStore(subscribeCatalog, readCatalog);
      // 只读一次 meta：活跃角色与设置页共用同一个请求，摘要不额外新增 RPC 形状。
      // 摘要刻意**不用**设置页的 useEnabledSettingsRoles：那条路径在 meta 缺失时会回退历史默认
      // 五角色（设置页既有行为，保持不变），而摘要一旦跟着回退就会把未确认启用角色的 provider
      // 写进"活跃 Provider"。这里只认 meta 的成功响应，其余情况显式标未知。
      const [hostMeta, , hostMetaError] = useHostMeta(ctx);
      const roleStatus = react.useMemo(
        () => resolvePluginDetailRoleStatus(hostMeta, hostMetaError),
        [hostMeta, hostMetaError],
      );
      const [failure, setFailure] = react.useState(null);
      react.useEffect(() => {
        // 目录调用是幂等的单飞请求，且与设置页共享同一实例：这里只为拿到 provider 显示名。
        try {
          void modelCatalog?.load?.();
        } catch {
          // 目录读取失败只影响显示名：原始 id 的回退路径照常工作。
        }
      }, [modelCatalog]);
      const model = describeDegPluginDetailSummary({
        settingsStatus: typeof settingsSnapshot?.status === "string" ? settingsSnapshot.status : "loading",
        settingsValue: settingsSnapshot?.value,
        catalogStatus: typeof catalogState?.status === "string" ? catalogState.status : "idle",
        catalogGroups: catalogState?.groups,
        roleStatus: roleStatus.status,
        enabledRoles: roleStatus.roles,
      });
      const capability = resolveDegSettingsSectionOpener(ctx);
      const noteText = failure?.message ?? (capability.available === true ? null : capability.message);
      const noteReason = failure?.reason ?? (capability.available === true ? null : capability.reason);
      /**
       * 点击处理：同步异常与异步拒绝都必须 fail-closed（禁用 + open-failed 提示）。
       *
       * 三段路径的边界：
       * 1. **同步返回**（当前 Host 的真实形态）：调用后立刻清提示并返回 undefined——
       *    绝不把同步路径包进 `Promise.resolve().then(...)`，那会给非 Promise 返回值平白加一次
       *    微任务延迟，也让点击的返回类型从 undefined 变成 Promise；
       * 2. **同步抛错**：按 open-failed 处理；
       * 3. **thenable（Promise/rejected Promise）**：只有真正的 thenable 才挂结算回调，且**在同一个
       *    tick 内**挂上 rejection 处理——否则未处理的 rejection 会冒到宿主页面，按钮还会错误地
       *    停在"看起来可用"的状态。成功结算不清提示：成功路径已经在第 1 步清过，而"后到的拒绝
       *    覆盖先到的成功"必须保持（fail-closed 只允许更保守，不允许被迟到的成功解锁）。
       * 任何一步失败都绝不回退到 openBundle 之类的替代动作。
       */
      const openSettings = () => {
        // 点击时重新读取：首帧渲染之后账本可能已经变化（HMR / 面板重挂载）。
        const current = resolveDegSettingsSectionOpener(ctx);
        if (current.available !== true) {
          setFailure({ reason: current.reason, message: current.message });
          return;
        }
        const failClosed = () => {
          setFailure({ reason: "open-failed", message: DEG_SETTINGS_OPEN_FAILURE_TEXT["open-failed"] });
        };
        let result;
        try {
          result = current.openSection(DEG_SETTINGS_SECTION_ID);
        } catch {
          failClosed();
          return;
        }
        setFailure(null);
        // 只对对象/函数探 then：原始值（undefined/void 返回值）连属性读取都不需要。
        if (result === null || (typeof result !== "object" && typeof result !== "function")) return;
        let then = null;
        try {
          then = result.then;
        } catch {
          // then 读取本身抛错的畸形 thenable：按调用失败处理，不当成功。
          failClosed();
          return;
        }
        if (typeof then !== "function") return;
        try {
          then.call(result, undefined, failClosed);
        } catch {
          failClosed();
        }
      };
      return react.createElement(
        "section",
        { className: "deg_pd", "data-deg-plugin-summary": "true", "aria-label": "DEG 配置摘要" },
        react.createElement("h4", { className: "deg_pd_title" }, "DEG 配置摘要"),
        react.createElement(
          "div",
          { className: "deg_pd_providers" },
          react.createElement("span", { className: "deg_pd_label" }, "活跃角色使用的 Provider"),
          react.createElement("span", {
            className: "deg_pd_providers_list",
            "data-deg-active-providers": model.providerIds.join("|"),
          }, model.activeProviders.length === 0
            ? react.createElement("span", { className: "deg_pd_empty" }, model.activeProviderText)
            : model.activeProviders.map((provider) => react.createElement("span", {
              key: provider.id,
              className: "deg_pd_tag",
              "data-deg-active-provider": provider.id,
              "data-deg-provider-known": provider.known ? "true" : "false",
              // 目录缺失或目录不含该 id 时的状态标注：保留原始 id，并说明为什么没有显示名。
              title: provider.known ? undefined : "模型目录未提供该 provider 的显示名，显示原始 id",
              "aria-label": provider.known ? undefined : provider.label + "（未知 Provider）",
            }, provider.label))),
        ),
        react.createElement("div", {
          className: "deg_pd_roles_header",
          "aria-hidden": "true",
        },
          react.createElement("span", null, "角色"),
          react.createElement("span", null, "Provider / 模型"),
          react.createElement("span", null, "状态"),
        ),
        react.createElement("ul", {
          className: "deg_pd_roles",
          "aria-label": "六个角色的 Provider、模型和配置状态",
          "data-deg-roles": model.roles.map((role) => role.role).join(","),
        }, model.roles.map((role) => react.createElement(
          "li",
          {
            key: role.role,
            className: "deg_pd_role",
            "data-deg-role": role.role,
            "data-deg-role-state": role.state,
            "data-deg-role-provider": role.provider,
            "data-deg-role-model": role.model,
          },
          react.createElement("span", { className: "deg_pd_role_name" }, role.label),
          react.createElement("span", { className: "deg_pd_role_value", title: role.valueText || undefined }, role.valueText),
          react.createElement("span", { className: "deg_pd_role_state" }, role.stateText),
        ))),
        model.statusText === null ? null : react.createElement("p", {
          className: "deg_pd_status",
          role: "status",
          // 角色状态结论（loading/ready/unavailable）的稳定标记：文案是可读面，这里给测试与自动化。
          "data-deg-role-status": model.roleStatus,
        }, model.statusText),
        react.createElement(
          "div",
          { className: "deg_pd_actions" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary deg_pd_open",
            "data-deg-open-settings": "true",
            disabled: capability.available !== true || failure !== null,
            "aria-describedby": noteText === null ? undefined : "deg-pd-open-note",
            onClick: openSettings,
          }, "打开 DEG 设置"),
          noteText === null ? null : react.createElement("span", {
            id: "deg-pd-open-note",
            className: "deg_pd_note",
            role: "status",
            "data-deg-open-note": noteReason,
          }, noteText),
        ),
      );
    }



  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    DEG_PLUGIN_DETAIL_SLOT_NAME, DEG_PLUGIN_DETAIL_ENTRY_KEY, DEG_SETTINGS_SECTION_SLOT_NAME, describeDegPluginDetailSummary, resolveDegSettingsSectionOpener, DegPluginDetailSummary, bindClientRuntime,
  });
})(globalThis);
