/**
 * provider 卡片与折叠区标题（模型视图 A）（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-model-views-a")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientModelViewsA(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-model-views-a");
  const clientModelViewsBSymbol = Symbol.for("dsh-expert-group/client-model-views-b");
  const clientModelViewsB = global[clientModelViewsBSymbol] || {};
  const {
    ModelDiscoveryDialog, renderModelRow, toggleCandidateOf, toggleIndexInSet, toggleVisibleCandidatesOf,
  } = clientModelViewsB;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

  /**
   * 模型行列表（含高级设置折叠）：纯渲染，不引入 Hook、不改变组件身份。
   *
   * 票据 40：行内容与自定义创建卡片共用 views-b 的 renderModelRow；这里只把卡片自己的
   * 草稿动作适配成共享回调。删除动作需要 config.removeModelRow 与 session.modelRows
   * （调用点确实传入了两者；漏解构会让「删除模型」抛 ReferenceError，已有回归用例）。
   */
  function renderProviderModelRows(card, handlers) {
    const { disabled, edit, patchRow, toggleRow, toggleEffort, toggleInput, config, session } = handlers;
    return card.models.map((model) => renderModelRow(model, {
      key: "model-" + String(model.index),
      attributes: { "data-deg-model-index": model.index },
      disabled,
      idLabel: "模型 ID ",
      nameLabel: "模型显示名 ",
      parseCapacity: config.parseCapacity,
      onChange: patchRow,
      onToggleAdvanced: toggleRow,
      onRemove: (index) => edit((draft) => ({ ...draft, models: config.removeModelRow(session.modelRows, index) })),
      onEffort: toggleEffort,
      onInput: toggleInput,
    }));
  }

    /** 折叠区标题行：整个标题是可点击按钮，展开状态由 aria-expanded 表达。 */
    function ModelConfigDisclosure({ section, onToggle, extra }) {
      return react.createElement("div", { className: "deg_mc_header" },
        react.createElement("button", {
          type: "button",
          className: "deg_mc_toggle",
          "aria-expanded": section.disclosure.expanded,
          "aria-controls": section.disclosure.bodyId,
          "data-deg-model-config-toggle": "true",
          onClick: onToggle,
        },
          react.createElement("span", { className: "deg_mc_chevron", "aria-hidden": "true" }, section.disclosure.expanded ? "▾" : "▸"),
          react.createElement("span", null, section.title)),
        extra);
    }

/**
 * 候选选择动作（票据 39 从卡片体提出）与折叠态渲染：两者都只依赖显式传入的值。
 *
 * 卡片体原本把 8 个候选动作箭头与折叠态 JSX（含删除按钮的 onClick）都写在闭包里，
 * 使 ModelProviderCard 的「单闭包内函数数」达到 62。这里按职责提出：渲染保持逐节点不变，
 * 动作的 setter 由调用方在每次渲染时传入。
 */

/**
 * 候选选择动作：勾选单个候选、全选/取消全选、关闭弹窗。
 *
 * 两个候选动作改为复用 client-model-views-b.js 的纯状态变换（本模块与 provider 卡片原先各
 * 写一份逐字相同的更新器）。为什么等价：这里只保留"把纯变换交给 setter"这一层包装，setter
 * 相同、无效状态返回原对象的语义相同、回调身份仍是每次渲染新建（与原内联箭头一致）。
 *
 * @param {object} context
 * @param {Function} context.setFetchState 候选/错误状态 setter。
 * @param {Function} context.setCandidateQuery 搜索词 setter。
 * @returns {{toggleCandidate: Function, toggleVisibleCandidates: Function, closeModelPicker: Function}}
 */
function buildCandidateControls({ setFetchState, setCandidateQuery }) {
  const toggleCandidate = (id) => setFetchState((previous) => toggleCandidateOf(previous, id));
  /** 弹窗「全选/取消全选」：判定与改写仍同源（clearsAllCandidateSelection 在 views-b 内）。 */
  const toggleVisibleCandidates = (ids) => setFetchState((previous) => toggleVisibleCandidatesOf(previous, ids));
  const closeModelPicker = () => {
    setFetchState(null);
    setCandidateQuery("");
  };
  return { toggleCandidate, toggleVisibleCandidates, closeModelPicker };
}

/**
 * 折叠态卡片（票据 39）：只展示名称/路由/配置点与「编辑」按钮。
 *
 * 删除按钮元素（removeAction）与折叠态 JSX 一起提出：它只在这里使用，事件的
 * currentTarget 语义由 onRemove 原样透传，不改变任何行为。
 *
 * @param {object} context
 * @param {object} context.card 卡片视图模型。
 * @param {object} context.row provider 目录行。
 * @param {boolean} context.removable 是否允许删除。
 * @param {boolean} context.saving 是否正在保存。
 * @param {Function} context.onRemove 删除回调（接收原始事件）。
 * @param {Function} context.setOpen 展开态 setter。
 * @param {Function} context.setError 卡片错误 setter。
 * @param {Function} context.setSaved 已保存标记 setter。
 * @param {Function} context.setConflict 冲突标记 setter。
 * @returns {object} 折叠态元素。
 */
function renderProviderCardCollapsed(context) {
  const { card, row, removable, saving, onRemove, setOpen, setError, setSaved, setConflict } = context;
  const removeAction = removable && typeof onRemove === "function"
     ? react.createElement("button", {
       type: "button",
       className: "deg_btn deg_mc_delete_btn",
       disabled: saving || card.readOnly,
       "aria-label": card.displayName + " 删除",
       // 事件的 `currentTarget`（真实按钮）只在**同步派发期间**有效，因此原样交给父区域：
       // 删除成功后要按"点击那一刻的焦点归属 + 点击时捕获的区域作用域"决定是否把焦点还回
       // DEG 区域内的稳定控件（详见 REMOVE_FOCUS_TARGET_SELECTORS 上方的边界说明）。
       onClick: (event) => { void onRemove(event); },
     }, "删除")
     : null;
    return react.createElement("li", { className: "deg_mc_card" },
      react.createElement("div", { className: "deg_mc_card_head" },
        react.createElement("span", { className: "deg_mc_card_name" }, card.displayName),
        card.provider === card.displayName ? null : react.createElement("span", { className: "deg_mc_card_route" }, card.provider),
        card.apiKey.placeholder === "已配置（留空表示不修改）"
          ? react.createElement("span", {
            className: "deg_mc_dot",
            role: "img",
            "aria-label": "API Key 已配置",
            title: "API Key 已配置",
            "data-state": "available",
             style: { background: "var(--dsw-alias-state-success-primary,#22c55e)" },
          })
          : null,
        react.createElement("span", { className: "deg_mc_card_actions" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            "aria-label": card.displayName + " 编辑",
            onClick: () => { setOpen(true); setError(null); setSaved(false); setConflict(false); },
          }, "编辑"), removeAction)),
      row.error === undefined ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, row.error));
}

/**
 * 展开态卡片（票据 39）：API Key / Base URL / 协议 / 模型列表 / 冲突与页脚。
 *
 * JSX 逐节点原样搬移，不调用 Hook、不读写 ref；当次渲染的值与绑定由 context 显式传入，
 * 回调仍是每次渲染新建（与原内联箭头一致）。ModelDiscoveryDialog 是模块级绑定，直接使用。
 *
 * @param {object} context 本次渲染的显式依赖（见下方解构）。
 * @returns {object} 展开态元素。
 */
function renderProviderCardExpanded(context) {
  const {
    card, row, config, session, host, disabled, saving, saved, error, conflict, keyDraft,
    fetchState, candidateQuery, modelRows, setKeyDraft, setOpen, setSaved, setError, setConflict,
    setExpandedRows, setFetchState, setDraftRevision, setCandidateQuery,
    edit, apply, cancel, fetchModels, toggleCandidate, toggleVisibleCandidates, closeModelPicker, adoptPicked,
  } = context;
  return react.createElement("li", { className: "deg_mc_card", "data-deg-provider": row.provider },
    react.createElement("div", { className: "deg_mc_card_head" },
      react.createElement("span", { className: "deg_mc_card_name" }, card.displayName),
      card.provider === card.displayName ? null : react.createElement("span", { className: "deg_mc_card_route" }, card.provider)),
    row.error === undefined ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, row.error),
    react.createElement("label", { className: "deg_mc_field" },
      react.createElement("span", { className: "deg_mc_field_label" }, "API Key"),
      react.createElement("input", {
        className: "deg_mc_input",
        type: card.apiKey.type,
        autoComplete: card.apiKey.autoComplete,
        value: keyDraft,
        disabled: disabled || card.apiKey.disabled,
        "data-deg-api-key": row.provider,
        "aria-label": card.displayName + " API Key",
        placeholder: card.apiKey.placeholder,
        onChange: (event) => { setKeyDraft(event.target.value); session.typeKey(event.target.value); },
      })),
    react.createElement("p", { className: "deg_mc_hint" }, card.apiKey.hint),
    react.createElement("label", { className: "deg_mc_field" },
      react.createElement("span", { className: "deg_mc_field_label" }, "Base URL"),
      react.createElement("input", {
        className: "deg_mc_input",
        type: "text",
        value: card.baseUrl.value,
        disabled,
        placeholder: card.baseUrl.placeholder,
        "data-deg-base-url": row.provider,
        "aria-label": card.displayName + " Base URL",
        onChange: (event) => {
          const value = event.target.value;
          edit((draft) => {
            const next = { ...draft };
            if (value.trim().length === 0) Reflect.deleteProperty(next, "baseURL");
            else next.baseURL = value;
            return next;
          });
        },
      })),
    react.createElement("label", { className: "deg_mc_field" },
      react.createElement("span", { className: "deg_mc_field_label" }, "协议"),
      react.createElement("select", {
        className: "deg_mc_select",
        value: card.protocol.value,
        disabled,
        "data-deg-protocol": row.provider,
        "aria-label": card.displayName + " 协议",
        onChange: (event) => {
          const value = event.target.value;
          edit((draft) => {
            const next = { ...draft };
            if (value.length === 0) Reflect.deleteProperty(next, "api");
            else next.api = value;
            return next;
          });
        },
      }, card.protocol.options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)))),

    react.createElement("div", { className: "deg_mc_models" },
      react.createElement("div", { className: "deg_mc_models_head" },
        react.createElement("span", { className: "deg_mc_models_title" }, "模型"),
        react.createElement("span", { className: "deg_mc_models_meta" }, card.modelCatalog.label),
        card.modelCatalog.canReset
          ? react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled,
            "data-deg-reset-models": row.provider,
            onClick: () => {
              session.resetModels();
              setDraftRevision((value) => value + 1);
              setExpandedRows(new Set());
              setFetchState(null);
              setSaved(false);
              setError(null);
            },
          }, "恢复默认")
          : null,
        react.createElement("button", {
          type: "button",
          className: "deg_btn",
          disabled: disabled || card.actions.fetchModels === "disabled",
          "data-deg-fetch-models": row.provider,
          onClick: () => { void fetchModels(); },
        }, "获取模型")),
      card.models.length === 0
        ? react.createElement("p", { className: "deg_mc_hint" }, card.modelCatalog.emptyHint)
        : react.createElement("div", { className: "deg_mc_model" }, modelRows),
      react.createElement("button", {
        type: "button",
        className: "deg_btn",
        disabled,
        "data-deg-add-model": row.provider,
        onClick: () => edit((draft) => ({ ...draft, models: config.appendModelRow(session.modelRows) })),
      }, "添加模型"),
      fetchState?.error === null || fetchState?.error === undefined
        ? null
        : react.createElement("p", { className: "deg_mc_error", role: "alert" }, fetchState.error)
      ),
    error === null ? null : react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-card-error": row.provider }, error),
    conflict
      ? react.createElement("div", { className: "deg_mc_conflict" },
        react.createElement("p", { className: "deg_mc_error" }, "配置冲突：本卡片的修改未提交。"),
        react.createElement("div", { className: "deg_mc_conflict_actions" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: saving,
            onClick: async () => {
              await host.refreshSettingsView();
              cancel();
            },
          }, "重新打开（加载最新配置）")))
      : null,
    react.createElement("div", { className: "deg_mc_card_footer" },
      react.createElement("span", { className: "deg_mc_status deg_settings_status", role: "status" }, saved ? "已保存" : ""),
      react.createElement("button", { type: "button", className: "deg_btn", disabled: saving, onClick: () => { setOpen(false); cancel(); } }, "取消"),
      react.createElement("button", {
        type: "button",
        className: "deg_btn deg_btn_primary",
        disabled,
        "data-deg-apply": row.provider,
        onClick: () => { void apply(); },
      }, saving ? "应用中…" : "应用")),
    fetchState !== null && Array.isArray(fetchState.candidates)
      ? react.createElement(ModelDiscoveryDialog, {
        candidates: fetchState.candidates,
        query: candidateQuery,
        onQueryChange: setCandidateQuery,
        onToggle: toggleCandidate,
        onToggleVisible: toggleVisibleCandidates,
        onClose: closeModelPicker,
        onAdopt: adoptPicked,
      })
      : null);
}

    /**
     * 一张 provider 卡片的编辑手感：草稿与"应用/取消"完全属于卡片自己。
     *
     * 进入编辑态时固定 baseline（user 层的 profile 子树 + revision），应用时先算最小路径操作，
     * 再做角色联动守卫与 revision 复核；任何拒绝都只更新卡片自己的错误行，不落盘、不改动其它卡片。
     */
/**
     * 一张 provider 卡片：草稿、应用/取消与凭据输入全部属于卡片自己。
     *
     * 所有判定都走 client-model-config.js 的纯函数面（`createCardSession` / `cardModel(…)`）：
     * 会话持有草稿、进入编辑态时固定的 user 基线、revision 栅栏与凭据输入，`plan()` 给出
     * 要提交的路径操作与守卫结论，`accept()` 接受宿主返回的权威视图作为新基线。
     * 因此"每个卡片独立应用/取消 + revision 冲突保护 + 角色联动守卫"与测试断言的是同一份实现。
     */
    function ModelProviderCard({ row, namespace, host, roleLabels, onSaved, onRemove }) {
      const config = host.config;
      const profilePath = Array.isArray(row.settingsPath) ? row.settingsPath : [];
      const [open, setOpen] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const [conflict, setConflict] = react.useState(false);
      const [expandedRows, setExpandedRows] = react.useState(() => new Set());
      const [fetchState, setFetchState] = react.useState(null);
      const [candidateQuery, setCandidateQuery] = react.useState("");
      const [keyDraft, setKeyDraft] = react.useState("");
      // createCardSession 是可变会话；版本号把会话草稿变化桥接到 React 渲染。
      const [, setDraftRevision] = react.useState(0);
      // 会话在卡片挂载时创建一次：revision 栅栏与 user 基线必须固定，外部提交只能被拒绝。
      const [session] = react.useState(() => config.createCardSession({
        provider: row.provider,
        settingsNs: namespace?.ns,
        profilePath,
        storedUser: namespace?.user,
        base: namespace?.base,
        value: namespace?.value,
        revision: namespace?.revision,
        roleDefaults: roleLabels.defaults,
      }));
      const schemaInfo = react.useMemo(() => {
        const info = host.settingsSchemaInfo(namespace?.ns);
        return {
          ...info,
          protocols: config.protocolChoices(info.root, row.provider, host.adapter, profilePath),
        };
      }, [host, namespace, row.provider, profilePath, config]);
      const credentialRef = config.credentialRefOf(row, namespace);
      // 写入权限继承模型配置宿主的**整页** writable：namespace 条目只提供 schema、
      // user/base/value、revision 与路径，不承担整页权限字段。
      const pageWritable = host.readView().writable === true;
      const card = session.cardModel({
        protocols: schemaInfo.protocols,
        defaultInput: schemaInfo.defaultInput,
        credentialRef,
        credential: host.operations.credentialState(credentialRef),
        typed: keyDraft,
        readOnly: !pageWritable,
        expandedRows,
        draft: session.draft,
      });
      const disabled = card.readOnly || saving;
      const removable = config.providerRemovable(row, namespace);

      const edit = (update) => {
        session.edit(update);
        setDraftRevision((value) => value + 1);
        setSaved(false);
        setError(null);
      };
      const patchRow = (index, patch) => {
        edit((draft) => ({
          ...draft,
          models: session.modelRows.map((model, at) => (
            at === index ? config.patchModelDraft(model, patch) : model
          )),
        }));
      };
      const toggleEffort = (index, level) => {
        edit((draft) => {
          const rows = session.modelRows;
          const selection = config.effortSelectionFor(rows[index]);
          return { ...draft, models: config.setModelEffortSelection(rows, index, { ...selection, [level]: selection[level] !== true }) };
        });
      };
      const toggleInput = (index, modality) => {
        edit((draft) => {
          const rows = session.modelRows;
          const selected = config.modelInputOf(rows[index], schemaInfo.defaultInput);
          const next = selected.includes(modality) ? selected.filter((value) => value !== modality) : [...selected, modality];
          return { ...draft, models: config.setModelInputSelection(rows, index, next) };
        });
      };
      // 展开/收起：纯变换在 views-b（与 provider 卡片共用同一份实现）。
      const toggleRow = (index) => setExpandedRows((previous) => toggleIndexInSet(previous, index));
      const cancel = () => {
        session.cancel();
        setExpandedRows(new Set());
        setFetchState(null);
        setCandidateQuery("");
        setError(null);
        setSaved(false);
        setConflict(false);
        setKeyDraft("");
      };
      const apply = async () => {
        if (disabled) return false;
        setSaving(true);
        setError(null);
        setSaved(false);
        setConflict(false);
        try {
          const plan = session.plan();
          if (plan.ok !== true) {
            setError(plan.error);
            return false;
          }
          if (config.hasOps(plan.ops)) {
            const schemaNode = profilePath.length === 0
              ? host.adapter.rehydrate(namespace?.schema)
              : host.adapter.nodeAtPath(host.adapter.rehydrate(namespace?.schema), profilePath);
            if (schemaNode !== undefined) {
              // 本地 schema 先拦一道；正式 settings API 仍会在持久化边界再校验一次。
              const failure = host.adapter.validate(schemaNode, session.draft);
              if (failure !== undefined) {
                setError("设置校验未通过，已拒绝写入：" + failure);
                return false;
              }
            }
            const written = await host.writeNamespace({
              ns: namespace.ns,
              ops: plan.ops,
              expectedRevision: plan.expectedRevision,
            });
            if (!written.ok) {
              setConflict(written.conflict === true);
              setError(written.message);
              return false;
            }
            // 提交边界把权威用户层与 revision 交回来：卡片立即接受它作为新基线，
            // 因此下一次应用是"相对权威状态"的最小 diff，而不是重放旧基线。
            if (written.view !== undefined) session.accept(written.view);
          }
          if (plan.keyValue !== undefined) {
            const stored = await host.operations.storeKey(credentialRef, plan.keyValue);
            if (stored !== null) {
              setError(stored);
              return false;
            }
            session.typeKey("");
            setKeyDraft("");
          }
          await host.refreshSettingsView();
          setSaved(true);
          onSaved();
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        } finally {
          setSaving(false);
        }
      };
      const fetchModels = async () => {
        // 手动意图必须在 await 之前同步置位：正在途中的自动探测回调据此放弃写草稿，
        // 否则自动结果可能晚于这次点击返回，把完整目录直接写进草稿绕过用户选择。
        discoveryIntent.manualIntent = true;
        setSaving(true);
        setError(null);
        setFetchState(null);
        setCandidateQuery("");
        try {
          const draft = session.draft;
          const baseURL = typeof draft.baseURL === "string" && draft.baseURL.length > 0 ? draft.baseURL : undefined;
          const api = typeof draft.api === "string" && draft.api.length > 0 ? draft.api : undefined;
          const typed = session.keyValue;
          const answer = await host.operations.discoverModels(namespace.ns, {
            provider: row.provider,
            ...(baseURL === undefined ? {} : { baseURL }),
            ...(api === undefined ? {} : { api }),
            ...(typed.length === 0 ? {} : { apiKey: typed }),
          });
          if (answer.kind === "refused") {
            setFetchState({ error: answer.message, candidates: null });
            return;
          }
          if (answer.models.length === 0) {
            setFetchState({ error: "该端点没有返回任何模型", candidates: null });
            return;
          }
          // 手动候选到达后先清掉"自动 fallback 写入且用户没改过"的行：这次手动发现
          // 取得候选选择权，自动填充的目录不得继续留在草稿里绕过用户勾选。
          // 用户在自动行上做过的修改（行内容已与快照不同）与其它手工行一律保留。
          const pruned = pruneUneditedAutoFallbackRows();
          if (pruned !== null) {
            session.edit((draft) => ({ ...draft, models: pruned }));
            setDraftRevision((value) => value + 1);
            setSaved(false);
          }
          // known 按清理后的草稿计算：被清掉的自动行不再算"已存在"，手动候选里同 id 的条目
          // 因此会作为可勾选候选出现，而不是被当成已有行静默跳过。
          const known = new Set(session.modelRows
            .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
            .filter((id) => id.length > 0));
          setFetchState({
            error: null,
            candidates: answer.models.map((model) => ({
              ...model,
              // 手动发现的候选默认只勾选"草稿里还没有"的模型；自动 fallback 已先写入的行
              // 在手动发现命中后（除非用户改过）已被上面清掉，因此这里会重新作为候选出现，
              // 由用户显式勾选决定是否保留，而不是被自动目录静默带入。
              picked: typeof model.id === "string" && model.id.trim().length > 0
                && !known.has(model.id.trim()),
            })),
          });
        } finally {
          setSaving(false);
        }
      };
      /**
       * 自动 fallback 探测与手动「获取模型」之间的共享意图状态。
       *
       * 挂在稳定的 `session` 依赖的 useMemo 上：卡片重渲染不会重建它，因此晚到的自动探测
       * 回调看到的是**同一次**手动意图，而不是快照里的旧值。两个字段各司其职：
       * - `manualIntent`：用户点过「获取模型」就置位。自动探测晚于点击返回时必须放弃，
       *   绝不能把完整目录直接写进草稿（否则用户还没选模型就被隐式写入了目录）。
       * - `autoFallback`：最近一次自动探测写进草稿的行快照。手动候选到达后据此只清掉
       *   "仍与该快照完全相同"的未编辑行，用户在自动 fallback 上做过的修改一律保留。
       */
      const discoveryIntent = react.useMemo(() => ({ manualIntent: false, autoFallback: null }), [session]);
      /** 记录自动 fallback 快照（同一批自动行只记一次，供之后的手动探测做"未编辑"判定）。 */
      const noteAutoFallback = (models) => {
        if (discoveryIntent.autoFallback !== null) return;
        discoveryIntent.autoFallback = Array.isArray(models) ? models.map((model) => ({ ...model })) : [];
      };
      /** 草稿行是否与自动 fallback 快照里同 id 的行逐字段相同（即"未编辑的自动填充行"）。 */
      const isUneditedAutoFallbackRow = (row) => {
        const snapshot = discoveryIntent.autoFallback;
        if (!Array.isArray(snapshot) || !config.isPlainObject(row)) return false;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (id.length === 0) return false;
        return snapshot.some((entry) => {
          if (!config.isPlainObject(entry)) return false;
          const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
          return entryId === id && config.jsonEqual(entry, row);
        });
      };
      /**
       * 手动候选到达后清理草稿：只移除仍与自动 fallback 快照完全相同的未编辑行。
       * 返回新行数组；没有任何行被移除时返回 null，调用方据此跳过无谓的草稿改写。
       */
      const pruneUneditedAutoFallbackRows = () => {
        const snapshot = discoveryIntent.autoFallback;
        if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
        const rows = session.modelRows;
        const kept = rows.filter((row) => !isUneditedAutoFallbackRow(row));
        return kept.length === rows.length ? null : kept;
      };
      react.useEffect(() => {
        if (!open || row.declared === true || namespace?.ns === "llm-deepseek") return undefined;
        let active = true;
        // 每一轮自动探测都重置快照：新的自动结果必须重新记录，否则手动清理会拿旧快照做判定。
        discoveryIntent.autoFallback = null;
        // 手动意图只屏蔽"当前打开周期"：走到这里说明已通过守卫、确定要发起一次全新的自动探测，
        // 所以清掉上一周期遗留的手动标记，卡片折叠后再展开才能恢复自动目录增强。
        // 同一打开周期内晚于手动点击返回的自动请求，仍会观察到 true 并放弃写草稿。
        discoveryIntent.manualIntent = false;
        void host.operations.discoverModels(namespace.ns, { provider: row.provider }).then((answer) => {
          // 手动意图优先：用户已经点过「获取模型」时，这次自动结果不得写入草稿，
          // 由手动候选的选择流程独占草稿的模型目录。
          if (discoveryIntent.manualIntent) return;
          if (!active || answer.kind !== "found" || answer.models.length === 0 || session.modelRows.length > 0) return;
          session.setFallbackModels(answer.models);
          noteAutoFallback(session.modelRows);
          setDraftRevision((value) => value + 1);
        }).catch(() => {
          // 自动目录探测是增强能力，失败时保留 settings 中的模型与手工编辑入口。
        });
        return () => { active = false; };
      }, [host, namespace?.ns, open, row.declared, row.provider, session]);

      const { toggleCandidate, toggleVisibleCandidates, closeModelPicker } = buildCandidateControls({ setFetchState, setCandidateQuery });
      const adoptPicked = () => {
        const picked = (fetchState?.candidates ?? []).filter((candidate) => candidate.picked === true);
        if (picked.length === 0) return;
        edit((draft) => ({
          ...draft,
          models: config.adoptModels(session.modelRows, picked),
        }));
        closeModelPicker();
      };

      if (!config.providerEditable(row, namespace)) return null;

      if (!open) {
        return renderProviderCardCollapsed({ card, row, removable, saving, onRemove, setOpen, setError, setSaved, setConflict });
      }

      const modelRows = renderProviderModelRows(card, {
        disabled, edit, patchRow, toggleRow, toggleEffort, toggleInput, config, session,
      });



      return renderProviderCardExpanded({
        card, row, config, session, host, disabled, saving, saved, error, conflict, keyDraft,
        fetchState, candidateQuery, modelRows, setKeyDraft, setOpen, setSaved, setError, setConflict,
        setExpandedRows, setFetchState, setDraftRevision, setCandidateQuery,
        edit, apply, cancel, fetchModels, toggleCandidate, toggleVisibleCandidates, closeModelPicker, adoptPicked,
      });
    }

  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    ModelConfigDisclosure, ModelProviderCard, bindClientRuntime,
  });
})(globalThis);
