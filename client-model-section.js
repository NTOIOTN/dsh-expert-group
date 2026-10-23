/**
 * 折叠的「模型配置」区域（provider 目录、增删与删除确认）（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-model-section")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientModelSection(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-model-section");
  const clientModelViewsASymbol = Symbol.for("dsh-expert-group/client-model-views-a");
  const clientModelViewsA = global[clientModelViewsASymbol] || {};
  const clientModelViewsBSymbol = Symbol.for("dsh-expert-group/client-model-views-b");
  const clientModelViewsB = global[clientModelViewsBSymbol] || {};
  const clientProviderCardSymbol = Symbol.for("dsh-expert-group/client-provider-card");
  const clientProviderCard = global[clientProviderCardSymbol] || {};
  const clientFocusReturnSymbol = Symbol.for("dsh-expert-group/client-focus-return");
  const clientFocusReturn = global[clientFocusReturnSymbol] || {};
  const clientModelConfigHostSymbol = Symbol.for("dsh-expert-group/client-model-config-host");
  const clientModelConfigHost = global[clientModelConfigHostSymbol] || {};
  const { ModelConfigDisclosure, ModelProviderCard } = clientModelViewsA;
  const { focusableDialogControls } = clientModelViewsB;
  const { CustomProviderCard } = clientProviderCard;
  const {
    removeFocusDocument, readFocusedElement, closestRemoveFocusScope, isUsableRemoveFocusTarget,
    pickRemoveFocusTarget, observeRemoveFocusIntent, createRemoveFocusObservationLedger, restoreRemoveFocus,
  } = clientFocusReturn;
  const { CUSTOM_PROFILE_BASE_PATH, CUSTOM_PROVIDER_NS, CUSTOM_ROUTE_PROBE } = clientModelConfigHost;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

  /**
   * 删除确认弹窗的身份序号。
   *
   * 一次确认从"待确认"到"进行中"、失败回退、成功关闭会经历多次状态更新；每次都按这个
   * 序号配对当前弹窗，**绝不**用一个会被自身更新换掉的旧对象引用来做身份比较——那样
   * 失败回退与成功关闭都会静默失效（弹窗永远停在"删除中…"），并发的后来者也会被误伤。
   */
  let removeConfirmSeq = 0;

  /**
   * 删除确认弹窗：复用提示词弹窗的 `deg_prompt_dialog_backdrop` / `deg_prompt_dialog`
   * 样式与 `data-deg-dialog-action` / focusableDialogControls 的键位模式，但**非阻塞**：
   * 渲染在 React 树里，事件循环照常运转。
   *
   * 边界（每条都是修复的一部分）：
   * - 只显示 provider 名称与「确认 / 取消」两个操作；
   * - 打开后焦点落在「取消」（破坏性动作绝不能是默认焦点）；
   * - 取消、Escape、点击遮罩**本身**三条路径都只关弹窗：不删凭据、不写 settings、不刷目录；
   * - Tab / Shift+Tab 只在弹窗内**真正可聚焦**的控件之间循环，不漏到背景页面；
   * - 删除进行中（phase === "running"）按钮禁用、Escape 与 Tab 都不再受理：此刻写盘可能
   *   已经发生，关掉弹窗只会掩盖真实结果；
   * - 失败时弹窗保留，错误在弹窗内以 role=alert 可见，用户可以取消或重试。
   */
  function renderRemoveConfirmDialog(removeIntent, handlers) {
    const { dialogRef, onCancel, onConfirm } = handlers;
    if (removeIntent === null) return null;
    return react.createElement("div", {
        className: "deg_prompt_dialog_backdrop",
        // 点遮罩本身只取消（弹窗内部的点击在下面 stopPropagation，不会误触发）；
        // 删除进行中由 cancelRemoveConfirm 自己的守卫拒绝——这里绝不另写一套 phase 判断，
        // 三条关闭入口（遮罩 / Escape / 取消按钮）必须共用同一个守卫。
        onClick: () => onCancel(),
      },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "删除 provider 确认",
          ref: dialogRef,
          onClick: (event) => event?.stopPropagation?.(),
          onKeyDown: (event) => {
            // 删除进行中：不再受理取消与焦点环，避免用户以为"取消掉了"而实际已经写盘。
            if (removeIntent.phase === "running") return;
            if (event?.key === "Escape") {
              // 独占模态语义：阻止默认行为并停止冒泡，避免外层再处理同一个 Escape。
              event.preventDefault?.();
              event.stopPropagation?.();
              onCancel();
              return;
            }
            if (event?.key !== "Tab") return;
            // 与候选弹窗同一套焦点环：只取真正可聚焦（启用且可见）的控件，disabled 的
            // 「删除 / 取消」不能被 preventDefault 之后 focus 一个被忽略的元素而卡死焦点。
            const controls = focusableDialogControls(dialogRef.current ?? event?.currentTarget ?? null);
            // 没有任何可聚焦控件时不拦截 Tab：宁可让浏览器默认行为走，也不把焦点锁死。
            if (controls.length === 0) return;
            const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
            const nextIndex = event.shiftKey
              ? (current <= 0 ? controls.length - 1 : current - 1)
              : (current >= controls.length - 1 ? 0 : current + 1);
            event.preventDefault?.();
            try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
          },
        },
          react.createElement("h3", null, "删除 provider"),
          react.createElement("p", null, "确定删除 provider「" + removeIntent.label + "」及其配置吗？"),
          removeIntent.error === null ? null : react.createElement("p", {
            className: "deg_remove_confirm_error",
            role: "alert",
            "aria-live": "assertive",
          }, removeIntent.error),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              "data-deg-remove-cancel": "true",
              // 打开弹窗后焦点落在「取消」：破坏性动作不抢默认焦点。
              autoFocus: true,
              disabled: removeIntent.phase === "running",
              onClick: () => onCancel(),
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              "data-deg-dialog-action": "confirm",
              "data-deg-remove-confirm": "true",
              disabled: removeIntent.phase === "running",
              onClick: () => { void onConfirm(); },
            }, removeIntent.phase === "running" ? "删除中…" : "删除"))));
  }

/**
 * 渲染模型配置区的主体（票据 39 从组件体机械外移）。
 *
 * 主体 JSX 带 12 个单行箭头（卡片回调、添加 provider、自定义卡片开关），全部留在组件闭包
 * 里会让「单闭包内函数数」越过 40。它是纯渲染（不调用 Hook、不读写 ref）：依赖由调用方
 * 显式传入，渲染树与回调语义逐节点不变。CUSTOM_PROFILE_BASE_PATH / ModelProviderCard /
 * CustomProviderCard 是模块级绑定，直接按名使用，不需要经 context 传。
 *
 * @param {object} context 本次渲染的显式依赖（见下方解构）。
 * @returns {object|null} 展开时的主体元素或 null。
 */
function renderModelConfigBody(context) {
  const {
    section, directory, settingsError, editableRows, viewRevision, configured, host,
    roleDefaults, roleLabelOf, load, openRemoveConfirm, adding, addChoice, addable,
    setSettingsError, setAdding, setAddChoice, customOpen, customDraft, customProtocols,
    pageWritable, customNamespace, customFence, setCustomOpen, setCustomDraft, openCustomProvider,
  } = context;
return section.open ? react.createElement("div", { className: "deg_mc_body", id: section.disclosure.bodyId },
    react.createElement("p", { className: "deg_settings_hint" }, section.hint),
    directory.status === "error" ? react.createElement("p", { className: "deg_mc_error", role: "alert" }, directory.error) : null,
    settingsError === null ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, settingsError),
    directory.status === "ready" && editableRows.length === 0
      ? react.createElement("p", { className: "deg_mc_hint" }, "当前宿主没有可配置的 provider。")
      : null,
    react.createElement("ul", { className: "deg_mc_cards", "data-deg-view-revision": viewRevision },
      configured.map((row) => react.createElement(ModelProviderCard, {
        // 每次重新读取宿主视图都换 key：卡片用新的 user 层与 revision 重建基线，
        // 不会带着上一轮的旧草稿/旧栅栏继续编辑。
        key: row.provider + "#" + String(viewRevision),
        row,
        namespace: host.namespaceView(row.settingsNs),
        host,
        roleLabels: { defaults: roleDefaults, labelOf: roleLabelOf },
        onSaved: () => { void load(); },
        // 事件原样透传：openRemoveConfirm 只读取同步有效的 `currentTarget`（删除按钮本身），
        // 打开 DEG 自己的确认弹窗——确认之前不删凭据、不写 settings、不刷目录。
        onRemove: (event) => openRemoveConfirm(row, event),
      }))),
    react.createElement("div", { className: "deg_mc_add" },
      adding
        ? react.createElement(react.Fragment, null,
          react.createElement("select", {
            className: "deg_mc_select",
            value: addChoice,
            "aria-label": "选择要添加的 provider",
            disabled: directory.status !== "ready",
            onChange: (event) => setAddChoice(event.target.value),
          },
            react.createElement("option", { value: "" }, "选择 provider"),
            addable.map((row) => react.createElement("option", { key: row.provider, value: row.provider }, row.displayName))),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            disabled: addChoice === "" || directory.status !== "ready",
            "data-deg-confirm-add-provider": "true",
            onClick: async () => {
              const row = addable.find((candidate) => candidate.provider === addChoice);
              if (row === undefined) return;
              const written = await host.writeNamespace({
                ns: row.settingsNs,
                ops: [{ op: "set", path: [...row.settingsPath], value: {} }],
                expectedRevision: host.namespaceView(row.settingsNs)?.revision,
              });
              if (!written.ok) {
                setSettingsError(written.message);
                return;
              }
              setAdding(false);
              setAddChoice("");
              await load();
            },
          }, "添加"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            onClick: () => { setAdding(false); setAddChoice(""); },
          }, "取消"))
        : react.createElement("div", { className: "deg_mc_entries" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: section.actions.addProvider === "disabled",
            "data-deg-add-provider": "true",
            onClick: () => { setAdding(true); setCustomOpen(false); },
          }, section.entries.addProvider.label),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: section.actions.addCustom === "disabled",
            "data-deg-add-custom-provider": "true",
            onClick: openCustomProvider,
          }, section.entries.addCustom.label))),
    customOpen && customDraft !== null
      ? react.createElement(CustomProviderCard, {
        draft: customDraft,
        protocols: customProtocols,
        host,
        pageWritable,
        profileBasePath: [...CUSTOM_PROFILE_BASE_PATH],
        directoryRows: directory.rows,
        // 父区域每次渲染都从宿主视图读到的 revision：只用于"尚未贴出栅栏"时的纠正。
        liveRevision: customNamespace?.revision,
        fenceState: customFence.current,
        // settings 已经落盘的半完成 provider 必须立刻可见：取消时也主动重读目录。
        // 未提交的草稿取消不产生任何写入，重读只是幂等的视图刷新。
        onClose: (committed) => {
          setCustomOpen(false);
          setCustomDraft(null);
          if (committed === true) void load();
        },
        onCreated: () => {
          setCustomOpen(false);
          setCustomDraft(null);
          void load();
        },
      })
      : null,
    react.createElement("button", {
      type: "button",
      className: "deg_btn",
      disabled: section.actions.reload === "disabled",
      "data-deg-reload-providers": "true",
      onClick: () => { void load(); },
    }, directory.status === "loading" ? "读取中…" : "重新读取 provider 目录"))
    : null;
}

/**
 * 渲染模型配置区外壳（票据 39）：折叠标题的 onToggle 是组件内的 setter 绑定，
 * 因此把外壳单独提出、由组件显式传入 section / body / open / 删除弹窗。
 *
 * @param {object} context 见下方解构。
 * @returns {object} 区域元素。
 */
function renderModelConfigSection(context) {
  const { section, body, open, removeConfirmDialog, setOpen } = context;
  return react.createElement("div", { className: "deg_mc_section" },
    react.createElement(ModelConfigDisclosure, { section, onToggle: () => setOpen((value) => !value) }),
    body,
    // 折叠时删除按钮已不在页面上，弹窗一并不渲染（确认状态由 open 的 effect 清掉）。
    open ? removeConfirmDialog : null);
}

    function ModelConfigSection({ host, roleDefaults, roleLabelOf }) {
      const config = host.config;
      const [open, setOpen] = react.useState(false);
      const [directory, setDirectory] = react.useState({ status: "idle", rows: [], error: null });
      const [adding, setAdding] = react.useState(false);
      const [addChoice, setAddChoice] = react.useState("");
      const [settingsError, setSettingsError] = react.useState(null);
      /**
       * 删除确认状态（DEG 自渲染的非阻塞弹窗，见 openRemoveConfirm / removeConfirmDialog）。
       *
       * 为什么不是原生 confirm：同步 `globalThis.confirm()` 会阻塞浏览器事件循环，弹窗存续
       * 期间页面脚本、遮罩与宿主（DSH 会话输入框）的输入处理全部停摆，用户看到的就是
       * "设置页与 DSH 会话输入框随后都不可用，重启才恢复"。DEG 因此自己渲染确认层，
       * 任何阶段都不再调用同步原生 confirm。
       */
      const [removeIntent, setRemoveIntent] = react.useState(null);
      // 宿主替身/host 对象自身不触发渲染，因此每次重新读取宿主视图时手动推进一个版本号，
      // 让 provider 卡片拿到最新的 user 层与 revision（而不是首次渲染时的那一份）。
      const [viewRevision, setViewRevision] = react.useState(0);
      const [hostRevision, setHostRevision] = react.useState(() => (
        typeof host.getSnapshot === "function" ? host.getSnapshot() : 0
      ));
      // 外部失效版本单独保存：区域的加载 effect 只依赖它。主动 load 会重读宿主视图并推进
      // hostRevision（memo 需要），但绝不再推进这里的计数，因此刷新不会自激。
      const [hostInvalidation, setHostInvalidation] = react.useState(() => (
        typeof host.getInvalidation === "function" ? host.getInvalidation() : 0
      ));
      react.useEffect(() => {
        if (typeof host.subscribe !== "function") return undefined;
        return host.subscribe(() => {
          setHostRevision((previous) => (
            typeof host.getSnapshot === "function" ? host.getSnapshot() : previous + 1
          ));
          setHostInvalidation((previous) => (
            typeof host.getInvalidation === "function" ? host.getInvalidation() : previous + 1
          ));
        });
      }, [host]);
      // 「已配置 / 可添加」的划分走同一份纯函数（用户层存在该 profile 才算已配置）；
      // viewRevision 让宿主视图刷新后重新划分。
      const providerSections = react.useMemo(() => config.providerListSections(
        directory.rows,
        (ns) => host.namespaceView(ns),
      ), [config, host, directory.rows, viewRevision, hostRevision]);
      // 自定义 provider 的协议来自宿主 schema 的 `providers.<route>.api` 联合类型；
      // 用一个探针 route 读出词表（DSH 的设置页也是从同一份 schema 读协议选项）。
      const customNamespace = host.namespaceView(CUSTOM_PROVIDER_NS);
      const customSchemaInfo = react.useMemo(
        () => host.settingsSchemaInfo(CUSTOM_PROVIDER_NS),
        [host, hostRevision],
      );
      const customProtocols = react.useMemo(
        () => (config.isPlainObject(customNamespace)
          ? config.protocolChoices(customSchemaInfo.root, CUSTOM_ROUTE_PROBE, host.adapter, [])
          : []),
        [config, customSchemaInfo, host.adapter, customNamespace],
      );
      const pageWritable = host.readView().writable === true;
      // 创建卡片的状态机与卡片本身同生命周期：打开入口时读一次 namespace，并用那一刻的
      // revision 作为 CAS 栅栏新建草稿；route 候选词表则随时刷新。
      //
      // revision 的漂移规则（两个方向都必须防）：
      // - Describe 视图在打开那一刻可能还没读到/已经过期（refreshSettingsView 是异步的），
      //   用陈旧栅栏会让每一次正常提交都被宿主误判成并发冲突；因此在**第一次提交之前**，
      //   允许用父区域读到的最新 revision 纠正一次。
      // - 栅栏贴出之后才到达的外部写入（mirror 事件）是真正的并发：此时绝不能自动跟随，
      //   否则会静默覆盖别人的写入。这种情况保持陈旧栅栏，由宿主按 revision 语义拒绝。
      const [customOpen, setCustomOpen] = react.useState(false);
      const [customDraft, setCustomDraft] = react.useState(null);
      const customFence = react.useRef({ settled: false, external: false, epoch: 0, openedAt: 0 });
      const openCustomProvider = () => {
        customFence.current = {
          settled: false,
          external: false,
          epoch: 0,
          openedAt: typeof host.getInvalidation === "function" ? host.getInvalidation() : 0,
        };
        if (typeof host.refreshSettingsView === "function") void host.refreshSettingsView();
        const namespace = host.namespaceView(CUSTOM_PROVIDER_NS);
        if (!config.isPlainObject(namespace) || !pageWritable) return;
        setAdding(false);
        setAddChoice("");
        setCustomDraft(config.createCustomProviderDraft({
          settingsNs: CUSTOM_PROVIDER_NS,
          profileBasePath: [...CUSTOM_PROFILE_BASE_PATH],
          revision: namespace.revision,
          protocols: config.protocolChoices(
            host.settingsSchemaInfo(CUSTOM_PROVIDER_NS).root,
            CUSTOM_ROUTE_PROBE,
            host.adapter,
          ),
          takenRoutes: directory.rows.map((row) => row.provider).filter((id) => typeof id === "string"),
          models: [],
        }));
        setCustomOpen(true);
      };
      // 栅栏打开之后到达的每一次外部失效才记一笔：提交时据此判断"revision 变化是不是并发"。
      // 打开那一刻的计数是基线，因此卡片刚挂载时不会误判成并发。
      react.useEffect(() => {
        if (!customOpen || customDraft === null) return;
        if (hostInvalidation <= customFence.current.openedAt) return;
        customFence.current.external = true;
        customFence.current.epoch += 1;
      }, [customOpen, customDraft, hostInvalidation]);
      // 栅栏尚未贴出（打开时 namespace 还没读到）：补一次初始化，之后按上面的规则冻结。
      react.useEffect(() => {
        if (!customOpen || customDraft === null) return;
        if (typeof customDraft.revision === "number") return;
        const namespace = host.namespaceView(CUSTOM_PROVIDER_NS);
        if (config.isPlainObject(namespace)) customDraft.rebase({ revision: namespace.revision });
      }, [config, customOpen, customDraft, customNamespace, hostRevision]);
      // 折叠区的渲染面由纯函数给出（标题、默认折叠、动作可用性）：界面与测试共用同一份判定。
      const section = config.buildSectionModel({
        open,
        status: directory.status,
        error: settingsError ?? directory.error,
        writable: pageWritable,
        configured: providerSections.configured,
        addable: providerSections.addable,
        protocols: customProtocols,
        canCreateCustom: config.canCreateCustomProvider({
          namespace: customNamespace,
          protocols: customProtocols,
          writable: pageWritable,
        }),
      });
      // 加载 effect 只依赖 open 与**外部失效**版本：主动 load 内部会 refreshSettingsView()，
      // 若这里依赖"任意视图版本"就会形成 load -> refresh -> notify -> load 的无限环。
      //
      // 并发用一个"尾随重跑"标记收口：正在加载时到来的请求不会并发跑两次，但一定会在
      // 当前这轮结束后再跑一轮，因此调用方（例如取消半完成创建的卡片）拿到的始终是新视图。
      //
      // 事务语义（删除后的焦点归还依赖它）：`running` 期间到达的每一次调用都返回**同一个**
      // 覆盖「当前轮 + 所有 again 尾随重跑」的 Promise。删除流程 `await load()` 因此会一直
      // 等到最后一轮结算，焦点恢复不会落在尾随轮次的 React 更新之前（那会把焦点又打回根节点）。
      // 少返回一次这个 Promise（例如直接 `return Promise.resolve()`）就等于把"刷新完成"提前
      // 宣布，这正是本波要修掉的时序缺陷。
      const loadStateRef = react.useRef({ running: false, again: false, promise: null });
      const runLoad = react.useCallback(async () => {
        setDirectory((previous) => ({ ...previous, status: "loading", error: null }));
        setSettingsError(null);
        try {
          const rows = await host.operations.listProviderDirectory();
          await host.refreshSettingsView();
          const refs = rows
            .filter((row) => config.providerEditable(row, host.namespaceView(row.settingsNs)))
            .map((row) => config.credentialRefOf(row, host.namespaceView(row.settingsNs)));
          await host.operations.describeCredentials(refs);
          setDirectory({ status: "ready", rows, error: null });
          setSettingsError(host.describeError());
        } catch (error) {
          setDirectory({ status: "error", rows: [], error: error instanceof Error ? error.message : String(error) });
        } finally {
          setViewRevision((value) => value + 1);
        }
      }, [config, host]);

      const load = react.useCallback(() => {
        const state = loadStateRef.current;
        if (state.running) {
          // 加入同一个事务：只置尾随标记（多个并发调用合并成**一个**尾随轮次），并把当前
          // 事务的 Promise 原样交回调用方——它覆盖到最后一次尾随重跑为止。
          state.again = true;
          return state.promise;
        }
        state.running = true;
        const transaction = (async () => {
          try {
            do {
              state.again = false;
              await runLoad();
            } while (state.again);
          } finally {
            // 任何出口（正常结束、runLoad 抛错）都必须同时清掉两个账本字段：
            // running 卡住会让后续调用永远只置一遍 again，promise 不清空则会让新调用拿到
            // 一个已经结算（甚至已经拒绝）的旧 Promise——两者都会变成静默的永久挂起。
            // 从"循环条件不成立"到这里的整段是同步的，因此不存在"刚好在收尾期间置 again
            // 却被丢弃"的窗口：那个窗口之外的新调用一定会开启一个新事务。
            state.running = false;
            state.again = false;
            state.promise = null;
          }
        })();
        // 赋值发生在事务体的第一个 await 之前（事务体只能在 await 之后进入 finally），
        // 因此 running 为真时 promise 一定已就绪。
        state.promise = transaction;
        return transaction;
      }, [runLoad]);

      react.useEffect(() => {
        if (!open) return;
        void load();
      }, [open, load, hostInvalidation]);

      // 删除后的焦点归还：在途观察器由账本统一记账（见 createRemoveFocusObservationLedger）。
      //
      // 账本在**渲染期**建立（useRef 初始化 + 惰性赋值），不放在 passive effect 里：真实
      // React 的 passive effect 在提交之后才异步执行，删除流程可能在那之前就登记，那条登记
      // 会落进 null 而永远无人清理。卸载时统一 close()——删除流程里有多个 await，远端
      // Promise 可能长时间不结算，捕获监听绝不能留在页面上（常规路径仍由
      // confirmRemoveProvider 的 finally 自己收尾，这里是额外的一层兜底）。
      const removeFocusObservations = react.useRef(null);
      if (removeFocusObservations.current === null) {
        removeFocusObservations.current = createRemoveFocusObservationLedger();
      }
      // 确认弹窗的根节点：Tab 焦点环只在这个子树里取控件（绝不用 document 全局查询）。
      const removeDialogRef = react.useRef(null);
      react.useEffect(() => () => {
        removeFocusObservations.current?.close();
      }, []);

      react.useEffect(() => {
        // 区域折叠（body 不再渲染）时清掉**待确认**状态：快照里挂着的是此刻已经不在页面上的
        // 删除按钮，重新展开时不得把它当成仍然有效的待确认操作弹出来。
        // 两个边界：
        // - 只在**折叠**方向清理，展开方向什么都不做（否则"折叠期间结算成失败"的状态会在
        //   重新展开的那一刻被自己抹掉）；
        // - **running 绝不清**：异步删除（凭据 / 写入 / 刷新）仍在继续，清掉它只会让进行中、
        //   失败与重试的可见入口永久消失——用户可以折叠，但这次删除的结果必须找得回来。
        if (open) return;
        setRemoveIntent((previous) => (previous !== null && previous.phase === "confirming" ? null : previous));
      }, [open]);

      const editableRows = directory.rows.filter((row) => config.providerEditable(row, host.namespaceView(row.settingsNs)));
      const configured = providerSections.configured.map((entry) => entry.row);
      const addable = providerSections.addable.map((entry) => entry.row);
      /**
       * 点击卡片「删除」：**只**捕获这次交互的上下文并打开 DEG 自渲染的确认弹窗。
       *
       * 这一阶段绝不能有任何远端副作用：确认前的凭据删除、settings 写入与目录刷新都必须为 0。
       * 也绝不能再调用同步原生 `confirm()`：它阻塞浏览器事件循环，弹窗存续期间页面脚本、
       * 遮罩与宿主（DSH 会话输入框）的输入处理全部停摆——这正是"删除后设置页与会话输入框
       * 都不可用、重启才恢复"的事故面。
       *
       * trigger / scope / ownsFocus 必须在**点击那一刻**捕获：删除成功的刷新会给卡片换 key，
       * 原按钮届时已从页面摘除，事后再算只能得到 null。
       */
      const openRemoveConfirm = (row, event) => {
        const label = typeof row.displayName === "string" && row.displayName.length > 0 ? row.displayName : row.provider;
        // `currentTarget` 只在同步派发期间有效：在这里读一次并存进确认状态。
        const trigger = event?.currentTarget ?? null;
        const documentStub = removeFocusDocument();
        // ① 只有"点击删除按钮那一刻焦点确实在这个按钮上"才登记恢复意图：否则这次交互的
        //    焦点不属于 DEG 卡片（宿主替身没有真实 DOM 焦点），绝不猜测、绝不抢焦点。
        //    读面失败（ok=false）时焦点归属**未知**，同样不得 arm：一条无法证明归属的流程
        //    在收尾时把焦点搬走，恰恰是"插件越过自己边界动焦点"的那类事故。
        const triggerFocusRead = readFocusedElement(documentStub);
        const ownsFocus = trigger !== null
          && triggerFocusRead.ok === true
          && triggerFocusRead.element === trigger;
        // 作用域必须在点击时捕获（见 closestRemoveFocusScope 的说明）。
        const scope = ownsFocus ? closestRemoveFocusScope(trigger) : null;
        removeConfirmSeq += 1;
        setRemoveIntent({ token: removeConfirmSeq, row, label, trigger, scope, ownsFocus, phase: "confirming", error: null });
      };

      /**
       * 取消确认：只关弹窗，并把焦点还给**仍可用**的已捕获删除按钮，或同一 DEG 区域内的
       * 安全回退目标。
       *
       * 取消路径不得读取当前 `document.activeElement` 去另找一个恢复目标：那是"把全局焦点
       * 当恢复目标"的错误做法，正好会把焦点交给宿主输入框。按钮与作用域都来自打开弹窗那一刻
       * 的快照，因此这条路径在结构上不可能触及 DEG 之外的控件。
       */
      const cancelRemoveConfirm = () => {
        const intent = removeIntent;
        // 进行中一律拒绝取消：此刻凭据与 settings 可能已经写盘，"取消"在语义上已经不存在，
        // 关掉弹窗只会把进行中 / 失败 / 重试的可见入口一起卸载，而异步删除仍在继续。
        // 遮罩、Escape 与「取消」按钮三条入口共用这一个守卫，任何一条都不得绕过它。
        if (intent !== null && intent.phase === "running") return;
        setRemoveIntent(null);
        if (intent === null || intent.ownsFocus !== true) return;
        try {
          // 删除按钮仍在页面上且可用 → 优先还给它（按 Escape / 取消后的直觉位置）。
          if (isUsableRemoveFocusTarget(intent.trigger)) {
            intent.trigger.focus();
            return;
          }
          // 按钮已不可用（断开 / 隐藏 / 禁用）→ 只在点击时捕获的 DEG 区域内找安全回退目标。
          if (intent.scope !== null && intent.scope.isConnected === true) {
            const target = pickRemoveFocusTarget(intent.scope);
            if (target !== null) target.focus();
          }
        } catch { /* 焦点不可用不影响"取消"语义：弹窗已经关掉。 */ }
      };

      /**
       * 用户点击弹窗「删除」：**从这里**才开始真正的删除链路。
       *
       * 顺序与错误语义与既有实现完全一致：角色联动守卫 → 凭据删除 → settings unset →
       * 完整 load 事务（含并发合并进来的尾随轮次）→ 区域内焦点恢复策略。唯一变化是它由 DEG
       * 自己的弹窗按钮触发，因此不再有同步原生 confirm 阻塞事件循环。
       *
       * 失败（守卫拦截 / 凭据失败 / 写入失败 / 异常）保留弹窗：错误同时留在弹窗内（role=alert）
       * 与区域级错误里，用户可以直接取消或重试；失败路径不做任何焦点恢复，也绝不把删除
       * 结果伪装成成功。删除进行中（phase === "running"）按钮禁用，防止重复提交。
       */
      const confirmRemoveProvider = async () => {
        const intent = removeIntent;
        if (intent === null || intent.phase !== "confirming") return;
        const { row, trigger, scope, ownsFocus } = intent;
        // 立刻转 running：此刻凭据与 settings 可能已经写盘，关掉弹窗只会掩盖真实结果，
        // 因此按钮禁用、取消/Escape 不再受理（见 removeConfirmDialog 的键位处理）。
        // 所有后续更新都按 token 配对：同一次确认换了对象也认得自己，后来者则不受影响。
        setRemoveIntent((previous) => (previous !== null && previous.token === intent.token
          ? { ...previous, phase: "running", error: null }
          : previous));
        const documentStub = removeFocusDocument();
        // ② 确认之后、任何 await 之前登记观察器：异步窗口里用户/宿主的任何操作都可能把
        //    意图移走，收尾时据 abandoned 决定是否还焦点。
        const observation = ownsFocus && scope !== null ? observeRemoveFocusIntent(documentStub) : null;
        if (observation !== null) removeFocusObservations.current?.add(observation);
        // 失败出口：区域级错误保持既有语义，同时在弹窗内可见（身份比较，绝不动后来者）。
        const fail = (message) => {
          setSettingsError(message);
          setRemoveIntent((previous) => (previous !== null && previous.token === intent.token
            ? { ...previous, phase: "confirming", error: message }
            : previous));
        };
        try {
          const affected = config.rolesAffectedByChange(roleDefaults, { provider: row.provider, removeProvider: true });
          if (affected.length > 0) {
            fail(config.reasoningGuardMessage(["（整个 provider）"], affected, roleLabelOf));
            return;
          }
          const namespace = host.namespaceView(row.settingsNs);
          const credentialRef = config.credentialRefOf(row, namespace);
          if (host.operations.credentialState(credentialRef)?.configured === true) {
            const removed = await host.operations.removeKey(credentialRef);
            if (removed !== null) {
              fail(removed);
              return;
            }
          }
          const written = await host.writeNamespace({
            ns: row.settingsNs,
            ops: [{ op: "unset", path: [...row.settingsPath] }],
            expectedRevision: namespace?.revision,
          });
          if (!written.ok) {
            fail(written.message);
            return;
          }
          // ③ + ④ 写入成功，且**整个加载事务**（当前轮 + 所有尾随重跑）已经结算：先摘观察器
          //    （自己的 focus 不该被自己记成"意图移走"），再按优先级把焦点还回区域内
          //    （目标不可用时静默跳过）。`await load()` 拿到的是共享事务的 Promise，
          //    不是"立刻结算的空壳"——见 loadStateRef 上方的时序说明。
          await load();
          observation?.dispose();
          // 成功：先关掉自己这一轮弹窗（按 token 配对：并发的后来者不受影响），再恢复焦点。
          setRemoveIntent((previous) => (previous !== null && previous.token === intent.token ? null : previous));
          restoreRemoveFocus({ documentStub, trigger, scope, observation });
        } catch (cause) {
          // 任何读面/写面抛错都必须可见，而不是静默变成一次"看起来成功"的删除。
          fail(cause instanceof Error ? cause.message : String(cause));
        } finally {
          // 所有出口（守卫拦截、凭据失败、写入失败、异常、成功）都在这里摘掉观察器；
          // 摘监听本身幂等，卸载兜底再摘一次也不会重复移除。
          observation?.dispose();
          removeFocusObservations.current?.delete(observation);
        }
      };

      const body = renderModelConfigBody({
        section, directory, settingsError, editableRows, viewRevision, configured, host,
        roleDefaults, roleLabelOf, load, openRemoveConfirm, adding, addChoice, addable,
        setSettingsError, setAdding, setAddChoice, customOpen, customDraft, customProtocols,
        pageWritable, customNamespace, customFence, setCustomOpen, setCustomDraft, openCustomProvider,
      });

      const removeConfirmDialog = renderRemoveConfirmDialog(removeIntent, {
        dialogRef: removeDialogRef, onCancel: cancelRemoveConfirm, onConfirm: confirmRemoveProvider,
      });

      return renderModelConfigSection({ section, body, open, removeConfirmDialog, setOpen });
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    ModelConfigSection, bindClientRuntime,
  });
})(globalThis);
