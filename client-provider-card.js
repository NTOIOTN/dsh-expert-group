/**
 * 自定义 provider 创建卡片（模型视图 C）（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-provider-card")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientProviderCard(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-provider-card");
  const clientModelConfigHostSymbol = Symbol.for("dsh-expert-group/client-model-config-host");
  const clientModelConfigHost = global[clientModelConfigHostSymbol] || {};
  const clientModelViewsBSymbol = Symbol.for("dsh-expert-group/client-model-views-b");
  const clientModelViewsB = global[clientModelViewsBSymbol] || {};
  const { ModelDiscoveryDialog, clearsAllCandidateSelection, renderModelRow } = clientModelViewsB;
  const { CUSTOM_ROUTE_PROBE } = clientModelConfigHost;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

/**
 * 自定义 provider 卡片的「模型」分区（票据 39 从 renderCustomProviderCard 提出）。
 *
 * 拆出原因：整个卡片渲染函数带 22 个单行箭头后达到 247 行，超过「函数 ≤200 行」。
 * 这里只做纯渲染，依赖全部显式传入；渲染树与回调语义逐节点不变。
 *
 * @param {object} context
 * @param {object} context.card 卡片视图模型。
 * @param {object} context.config 模型配置纯函数面。
 * @param {object} context.schemaInfo 宿主 schema 信息（默认输入类型）。
 * @param {Array} context.modelRows 当前模型草稿行。
 * @param {boolean} context.profileDisabled profile 是否禁用。
 * @param {boolean} context.fetching 是否正在获取模型。
 * @param {boolean} context.canFetchModels 是否允许获取模型。
 * @param {Function} context.fetchModels 获取模型动作。
 * @param {Function} context.patchRow 修改单行草稿。
 * @param {Function} context.toggleRow 展开/收起单行高级设置。
 * @param {Function} context.setModels 整份模型草稿 setter。
 * @param {object|null} context.fetchState 候选/错误状态。
 * @returns {object} 模型分区元素。
 */
function renderCustomProviderModelSection(context) {
  const {
    card, config, schemaInfo, modelRows, profileDisabled, fetching, canFetchModels,
    fetchModels, patchRow, toggleRow, setModels, fetchState,
  } = context;
  return react.createElement("div", { className: "deg_mc_models" },
    react.createElement("div", { className: "deg_mc_models_head" },
      react.createElement("span", { className: "deg_mc_models_title" }, "模型"),
      react.createElement("span", { className: "deg_mc_models_meta" }, "至少配置一个模型"),
       react.createElement("button", {
         type: "button",
         className: "deg_btn",
         disabled: !canFetchModels || fetching,
         "data-deg-create-fetch-models": "true",
         onClick: () => { void fetchModels(); },
       }, fetching ? "获取中…" : "获取可用模型")),
    card.models.length === 0
      ? react.createElement("p", { className: "deg_mc_hint" }, "还没有模型。")
      : react.createElement("div", { className: "deg_mc_model" }, card.models.map((model) => renderModelRow(model, {
        key: "create-model-" + String(model.index),
        attributes: { "data-deg-create-model-index": model.index },
        idAttributes: { "data-deg-create-model-id": model.index },
        disabled: profileDisabled,
        idLabel: "自定义 provider 模型 ID ",
        nameLabel: "自定义 provider 模型显示名 ",
        parseCapacity: config.parseCapacity,
        onChange: patchRow,
        onToggleAdvanced: toggleRow,
        onRemove: (index) => setModels(config.removeModelRow(modelRows, index)),
        onEffort: (index, level) => {
          const selection = config.effortSelectionFor(modelRows[index]);
          setModels(config.setModelEffortSelection(modelRows, index, { ...selection, [level]: selection[level] !== true }));
        },
        onInput: (index, modality) => {
          const selected = config.modelInputOf(modelRows[index], schemaInfo.defaultInput);
          const next = selected.includes(modality) ? selected.filter((value) => value !== modality) : [...selected, modality];
          setModels(config.setModelInputSelection(modelRows, index, next));
        },
      }))),
    react.createElement("button", {
      type: "button",
      className: "deg_btn",
      disabled: profileDisabled,
      "data-deg-create-add-model": "true",
      onClick: () => setModels(config.appendModelRow(modelRows)),
    }, "添加模型"),
    config.isNonEmptyString(card.modelsError)
      ? react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-error": "models" }, card.modelsError)
      : null);
}

/**
 * 渲染自定义 provider 创建卡片（票据 39 从组件体机械外移）。
 *
 * 卡片体内的 JSX 带 22 个单行箭头（onChange/onClick/候选弹窗回调），全部放在组件闭包里会让
 * 「单闭包内函数数」到 52。JSX 本身是纯渲染（不调用 Hook、不读写 ref），整体提到模块级后
 * 组件只需要把**当次渲染的值与绑定**显式传进来；渲染树逐节点不变，回调身份仍按渲染产生。
 *
 * @param {object} context 本次渲染需要的全部外部值（见下方解构；不再有任何隐式捕获）。
 * @returns {object} 卡片元素。
 */
function renderCustomProviderCard(context) {
  const {
    card, config, schemaInfo, draft, profileDisabled, disabled, saving, fetching, canFetchModels,
    fetchModels, edit, patchRow, toggleRow, setModels, modelRows, fetchState, candidateQuery,
    setCandidateQuery, toggleCandidate, toggleVisibleCandidates, closeModelPicker, adoptFetchedModels,
    onClose, submit,
  } = context;
  return react.createElement("div", { className: "deg_mc_create", "data-deg-custom-provider": "true" },
    react.createElement("div", { className: "deg_mc_create_head" },
      react.createElement("span", { className: "deg_mc_create_title" }, card.title)),
    react.createElement("label", { className: "deg_mc_field_row" },
      react.createElement("span", { className: "deg_mc_field_label" }, "路由 ID"),
      react.createElement("input", {
        className: "deg_mc_input" + (card.routeId.error === null ? "" : " deg_mc_field_error"),
        type: "text",
        value: card.routeId.value,
        disabled: profileDisabled,
        placeholder: "例如 my-gateway",
        "data-deg-create-route": "true",
        "aria-label": "自定义 provider 路由 ID",
        onChange: (event) => edit({ routeId: event.target.value }),
      }),
      card.routeId.credentialRef.length === 0
        ? null
        : react.createElement("span", { className: "deg_mc_hint" }, "凭据引用：" + card.routeId.credentialRef),
      renderFieldMessage(config, card, "routeId")),
    react.createElement("label", { className: "deg_mc_field_row" },
      react.createElement("span", { className: "deg_mc_field_label" }, "显示名"),
      react.createElement("input", {
        className: "deg_mc_input" + (card.displayName.error === null ? "" : " deg_mc_field_error"),
        type: "text",
        value: card.displayName.value,
        disabled: profileDisabled,
        placeholder: "留空则使用路由 ID",
        "data-deg-create-name": "true",
        "aria-label": "自定义 provider 显示名",
        onChange: (event) => edit({ displayName: event.target.value }),
      }),
      renderFieldMessage(config, card, "displayName")),
    react.createElement("label", { className: "deg_mc_field_row" },
      react.createElement("span", { className: "deg_mc_field_label" }, "Base URL"),
      react.createElement("input", {
        className: "deg_mc_input" + (card.baseUrl.error === null ? "" : " deg_mc_field_error"),
        type: "text",
        value: card.baseUrl.value,
        disabled: profileDisabled,
        placeholder: card.baseUrl.placeholder,
        "data-deg-create-base-url": "true",
        "aria-label": "自定义 provider Base URL",
        onChange: (event) => edit({ baseURL: event.target.value }),
      }),
      renderFieldMessage(config, card, "baseUrl")),
    react.createElement("label", { className: "deg_mc_field_row" },
      react.createElement("span", { className: "deg_mc_field_label" }, "协议"),
      react.createElement("select", {
        className: "deg_mc_select" + (card.protocol.error === null ? "" : " deg_mc_field_error"),
        value: card.protocol.value,
        disabled: profileDisabled,
        "data-deg-create-protocol": "true",
        "aria-label": "自定义 provider 协议",
        onChange: (event) => edit({ api: event.target.value }),
      },
        react.createElement("option", { value: "" }, "选择协议"),
        card.protocol.options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label))),
      renderFieldMessage(config, card, "api")),
    react.createElement("label", { className: "deg_mc_field_row" },
      react.createElement("span", { className: "deg_mc_field_label" }, "API Key"),
      react.createElement("input", {
        className: "deg_mc_input",
        type: card.apiKey.type,
        autoComplete: card.apiKey.autoComplete,
        value: card.apiKey.value,
        disabled: disabled || card.apiKey.disabled,
        placeholder: card.apiKey.placeholder,
        "data-deg-create-api-key": "true",
        "aria-label": "自定义 provider API Key",
        onChange: (event) => edit({ apiKey: event.target.value }),
      }),
      react.createElement("span", { className: "deg_mc_hint" }, "API Key 只写入 credentials 服务，不进入 settings 快照，保存后不回显明文。")),
    renderCustomProviderModelSection(context),
    config.isNonEmptyString(fetchState?.error)
       ? react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-fetch-error": "true" }, fetchState.error)
       : null,
     card.error === null || card.modelsError === card.error
      ? null
      : react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-card-error": "true" }, card.error),
    react.createElement("div", { className: "deg_mc_create_footer" },
      react.createElement("span", { className: "deg_mc_status deg_settings_status", role: "status" },
        card.submitted ? "配置已保存" : ""),
      react.createElement("button", {
        type: "button",
        className: "deg_btn",
        // 发现请求在途时同样禁止取消：取消会丢弃草稿并收起卡片，而响应仍会回来，
        // 与 profile 锁定一起构成"在途期间不改变 endpoint 与草稿归属"的同一条边界。
        disabled: saving || fetching,
        "data-deg-create-cancel": "true",
        onClick: () => { onClose(draft.settingsCommitted); },
      }, "取消"),
      react.createElement("button", {
        type: "button",
        className: "deg_btn deg_btn_primary",
        disabled,
        "data-deg-create-submit": "true",
        onClick: () => { void submit(); },
      }, saving ? "创建中…" : (card.submitted ? "重试保存 API Key" : "创建")),
     fetchState !== null && Array.isArray(fetchState.candidates)
       ? react.createElement(ModelDiscoveryDialog, {
         candidates: fetchState.candidates,
         query: candidateQuery,
         onQueryChange: setCandidateQuery,
         onToggle: toggleCandidate,
         onToggleVisible: toggleVisibleCandidates,
         onClose: closeModelPicker,
         onAdopt: adoptFetchedModels,
       })
       : null));
}

/**
 * 字段级错误行（原本是组件内的单行箭头）：只有 card/config 两个输入，无状态。
 *
 * @param {object} config 模型配置纯函数面。
 * @param {object} card 卡片视图模型。
 * @param {string} key 字段键（routeId / displayName / baseUrl / api）。
 * @returns {object|null} 错误行元素或 null。
 */
function renderFieldMessage(config, card, key) {
  return config.isNonEmptyString(card[key]?.error) ? react.createElement(
    "span",
    { className: "deg_mc_field_message", role: "alert", "data-deg-create-error": key },
    card[key].error,
  ) : null;
}

    /**
     * 自定义 provider 创建卡片。
     *
     * 与 DSH 原生模型页的 CustomProviderCard 同层、同字段顺序（route id → 显示名 → Base URL
     * → 协议 → API Key → 模型），但不复制 DSH 源码：模型行复用 DEG 已有的模型草稿、容量、
     * 输入类型与七档 reasoning effort 语义。
     *
     * 提交是二阶段的：settings（profile）先写，API Key 再单独写 credentials。settings 成功后
     * 状态机把"profile 已写入"固定下来，因此 credentials 失败后的重试只重试 credentials。
     */
    function CustomProviderCard({ draft, protocols, host, onClose, onCreated, pageWritable, profileBasePath, directoryRows, liveRevision, fenceState }) {
      const [fetching, setFetching] = react.useState(false);
      const config = host.config;
      const [expandedRows, setExpandedRows] = react.useState(() => new Set());
      const [, setDraftRevision] = react.useState(0);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [errors, setErrors] = react.useState({});
      const [fetchState, setFetchState] = react.useState(null);
      const [candidateQuery, setCandidateQuery] = react.useState("");
      const schemaInfo = react.useMemo(() => {
        const info = host.settingsSchemaInfo("llm-pi-ai");
        return {
          ...info,
          protocols: config.protocolChoices(info.root, CUSTOM_ROUTE_PROBE, host.adapter, []),
        };
      }, [host, config]);
      const card = config.buildCustomCardModel({
        draft: draft.draft,
        protocols: Array.isArray(protocols) && protocols.length > 0 ? protocols : schemaInfo.protocols,
        errors,
        error,
        readOnly: pageWritable !== true,
        saving,
        submitted: draft.settingsCommitted,
        // 已提交时用状态机固定的引用，保证界面展示的引用与真正写凭据的一致。
        credentialRef: draft.credentialRef,
        defaultInput: schemaInfo.defaultInput,
        expandedRows,
      });
      const disabled = card.readOnly || saving;
      // 已提交后只允许重试 API Key：route 与凭据引用已经落盘，继续编辑会导致
      // "旧 profile + 新 route 的凭据"错配。其余字段与模型编辑统一禁用。
      //
      // fetching 一并锁定 profile：候选是用**点击那一刻**的 endpoint 参数探测出来的，
      // 请求在途时改 Base URL / 协议 / 模型行（或收起卡片丢弃草稿），就会让旧参数的
      // 结果被采纳进新配置。已有 provider 卡片用 saving 覆盖同一段窗口，这里保持同语义。
      const profileDisabled = card.profileLocked || saving || fetching;
      // 只同步已占用 route 词表；revision 由状态机一次性固定（rebase 内部只在 undefined 时初始化）。
      react.useEffect(() => {
        draft.rebase({
          takenRoutes: (Array.isArray(directoryRows) ? directoryRows : [])
            .map((row) => row.provider)
            .filter((id) => typeof id === "string"),
        });
      }, [draft, directoryRows]);

      // 一次提交前的栅栏处理：未贴出时用最新的 revision 纠正（覆盖"打开时 Describe 视图还没
      // 更新"）；贴出之后（用户已编辑或已有外部失效）保持陈旧栅栏，让宿主按 revision 语义拒绝。
      // 回调由父区域持有，卡片只负责在合适的时机通知。
      const fence = fenceState ?? { settled: true, external: true, epoch: 0 };
      const edit = (patch) => {
        draft.edit(patch);
        setDraftRevision((value) => value + 1);
        setErrors({});
        setError(null);
      };
      const modelRows = config.modelDraftsOf(draft.draft.models);
      const setModels = (models) => edit({ models });
       const customBaseURL = typeof draft.draft.baseURL === "string" ? draft.draft.baseURL.trim() : "";
       const canFetchModels = !card.readOnly && !profileDisabled && config.validateBaseUrl(customBaseURL) === null;
      const patchRow = (index, patch) => setModels(modelRows.map((model, at) => (
        at === index ? config.patchModelDraft(model, patch) : model
      )));
      const toggleRow = (index) => {
        setExpandedRows((previous) => {
          const next = new Set(previous);
          if (!next.delete(index)) next.add(index);
          return next;
        });
      };
      const closeModelPicker = () => {
         setFetchState(null);
         setCandidateQuery("");
       };
       const fetchModels = async () => {
         if (card.readOnly || profileDisabled) return;
         const current = draft.draft;
         const baseURL = typeof current.baseURL === "string" ? current.baseURL.trim() : "";
         if (config.validateBaseUrl(baseURL) !== null) {
           setFetchState({ error: "请先填写有效的 Base URL", candidates: null });
           return;
         }
         setFetching(true);
         setFetchState(null);
         setCandidateQuery("");
         try {
           const api = typeof current.api === "string" && current.api.length > 0 ? current.api : undefined;
           const apiKey = typeof current.apiKey === "string" ? current.apiKey.trim() : "";
           const answer = await host.operations.discoverModels(draft.settingsNs, {
             baseURL,
             ...(api === undefined ? {} : { api }),
             ...(apiKey.length === 0 ? {} : { apiKey }),
           });
           if (answer.kind === "refused") {
             setFetchState({ error: answer.message, candidates: null });
             return;
           }
           if (answer.models.length === 0) {
             setFetchState({ error: "该端点没有返回任何模型", candidates: null });
             return;
           }
           const known = new Set(config.modelDraftsOf(draft.draft.models)
             .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
             .filter((id) => id.length > 0));
           setFetchState({
             error: null,
             candidates: answer.models.map((model) => ({
               ...model,
               picked: typeof model.id === "string" && model.id.length > 0 && !known.has(model.id),
             })),
           });
         } finally {
           setFetching(false);
         }
       };
       const toggleCandidate = (id) => {
         setFetchState((previous) => previous === null || !Array.isArray(previous.candidates)
           ? previous
           : {
             ...previous,
             candidates: previous.candidates.map((candidate) => candidate.id === id
               ? { ...candidate, picked: candidate.picked !== true }
               : candidate),
           });
       };
       /**
        * 弹窗「全选/取消全选」的唯一实现（弹窗按钮文案也走同一个纯函数判定）。
        *
        * - 可见项已全选 → 清空**全部**选择（含被搜索隐藏的候选），与 DSH 模型页一致；
        * - 否则只把可见项追加为已选，隐藏候选保留原选择。
        */
       const toggleVisibleCandidates = (ids) => {
         const wanted = new Set(Array.isArray(ids) ? ids : []);
         setFetchState((previous) => {
           if (previous === null || !Array.isArray(previous.candidates)) return previous;
           if (clearsAllCandidateSelection(previous.candidates, wanted)) {
             return { ...previous, candidates: previous.candidates.map((candidate) => ({ ...candidate, picked: false })) };
           }
           return {
             ...previous,
             candidates: previous.candidates.map((candidate) => wanted.has(candidate.id)
               ? { ...candidate, picked: true }
               : candidate),
           };
         });
       };
       const adoptFetchedModels = () => {
         const candidates = fetchState?.candidates;
         const picked = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.picked === true);
         edit({ models: config.adoptModels(config.modelDraftsOf(draft.draft.models), picked) });
         closeModelPicker();
       };

       const submit = async () => {
        if (disabled) return false;
        setSaving(true);
        setError(null);
        setErrors({});
        try {
          // 栅栏定稿：只在"还没定稿、也还没写盘"时用父区域读到的最新 revision 纠正一次。
          // 定稿之后（用户开始编辑、或第一次提交之后）mirror/load 的推进都不再改写它，
          // 因此并发写入仍然由宿主的 revision 语义拒绝，而不是被静默覆盖。
          // 栅栏纠正：只在还没有外部并发失效时，用父区域读到的最新 revision 纠正一次
          // （覆盖"打开时 Describe 视图还没更新"）。栅栏贴出之后到达的外部写入必须保持
          // 陈旧栅栏，让宿主按 revision 语义拒绝，绝不静默覆盖别人的写入。
          if (fence.external !== true && !draft.settingsCommitted && Number.isSafeInteger(liveRevision)) {
            draft.rebase({ revision: liveRevision });
          }
          // 首次提交即定稿：此后再来的 mirror/load 都不允许改写栅栏。
          draft.rebase({ frozen: true });
          fence.settled = true;
          const plan = draft.plan();
          if (plan.ok !== true) {
            setErrors(plan.errors ?? {});
            setError(plan.error);
            return false;
          }
          if (plan.phase === "settings") {
            // 本地 schema 先拦一道：把新 profile 放进它自己的路径下，用命名空间 schema
            // 校验整段候选（`{ providers: { <route>: profile } }`），正式 settings API 仍会
            // 在持久化边界再校验一次。
            const op = Array.isArray(plan.ops) ? plan.ops[0] : undefined;
            if (op !== undefined) {
              const sectionCandidate = config.setPath({}, profileBasePath, {
                [op.path[op.path.length - 1]]: op.value,
              });
              const failure = host.adapter.validate(schemaInfo.root, sectionCandidate);
              if (failure !== undefined) {
                setError("设置校验未通过，已拒绝写入：" + failure);
                return false;
              }
            }
            const written = await host.writeNamespace({
              ns: draft.settingsNs,
              ops: plan.ops,
              expectedRevision: plan.expectedRevision,
            });
            if (!written.ok) {
              setError(written.message);
              return false;
            }
            draft.acceptSettings(written.view, plan.credentialRef);
            setDraftRevision((value) => value + 1);
          }
          if (plan.keyValue !== undefined && plan.phase !== "done") {
            const stored = await host.operations.storeKey(plan.credentialRef, plan.keyValue);
            if (stored !== null) {
              // settings 已经写成功；这里只报告凭据失败，重试只重试 credentials。
              setError("provider 配置已保存，但 API Key 写入失败：" + stored);
              return false;
            }
            draft.acceptCredential();
            setDraftRevision((value) => value + 1);
          }
          await host.refreshSettingsView();
          onCreated();
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        } finally {
          setSaving(false);
        }
      };


      return renderCustomProviderCard({
        card, config, schemaInfo, draft, profileDisabled, disabled, saving, fetching, canFetchModels,
        fetchModels, edit, patchRow, toggleRow, setModels, modelRows, fetchState, candidateQuery,
        setCandidateQuery, toggleCandidate, toggleVisibleCandidates, closeModelPicker, adoptFetchedModels,
        onClose, submit,
      });
    }

    // ── 删除 provider 之后的「区域内」焦点归还 ─────────────────────────────────
    //
    // 用户报告：在设置页删除一张 provider 卡片后，键盘焦点落回页面根，紧随其后的 DSH
    // 主输入框光标也随之消失。修复的边界是**只把焦点还给 DEG 区域内的稳定控件**。
    //
    // 这些边界是修复的一部分，不是实现细节：
    // - DEG **绝不**访问、也绝不 focus 宿主的任何控件（尤其是 DSH 主输入框）：那是宿主
    //   自己的焦点管理，插件越界只会制造新的抢焦点问题；
    // - 只有四个条件同时成立才尝试一次自己的恢复：
    //   ① 点击删除按钮那一刻焦点就在这个按钮上（这次交互确实来自 DEG 卡片），且这次读取
    //      **成功**——读面抛错只是"归属未知"，未知不得 arm；
    //   ② 用户接受了原生 confirm；
    //   ③ settings 里的 provider 配置删除成功（凭据阶段与写入阶段的失败都不算）；
    //   ④ 删除成功后的目录/视图刷新**整个加载事务**已经结算：`await load()` 等到的不只是
    //      自己那一轮，还包括在同一轮里被合并进来的所有尾随重跑。早一步恢复，随后的尾随
    //      React 更新就会把焦点又打回根节点（这正是本波修掉的时序缺陷）。
    //   于是"确认取消""角色联动守卫拦截""凭据删除失败""settings 写入失败"四条路径都不
    //   恢复焦点，与既有语义完全一致；
    // - 异步窗口（凭据 / settings / 刷新都可能长时间 pending）里在 document 捕获阶段观察
    //   pointerdown / keydown / focusin：任何用户或宿主动作把意图移走（例如用户点回 DSH
    //   输入框继续打字）都会把本次恢复标记为 abandoned，收尾时不再抢焦点；
    // - 恢复目标只在**点击时捕获的作用域**内查询（`trigger.closest(".deg_mc_section")`），
    //   绝不 document 全局查询：宿主输入框不可能被这里选中；
    // - 作用域或目标缺失、DOM 读面失败、目标已断开、hidden/disabled/aria-disabled、没有
    //   渲染矩形时静默跳过（并继续尝试下一个候选）：焦点问题绝不影响删除结果（删除已经
    //   写盘，不能因为焦点读面异常而变成失败）。


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    CustomProviderCard, bindClientRuntime,
  });
})(globalThis);
