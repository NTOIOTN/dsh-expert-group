/**
 * 设置页渲染尾段（提示词详情页、未保存弹窗、角色表、页签与确认框）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-settings-main-b")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientSettingsMainB(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-settings-main-b");
  const clientSettingsNormalizeSymbol = Symbol.for("dsh-expert-group/client-settings-normalize");
  const clientSettingsNormalize = global[clientSettingsNormalizeSymbol] || {};
  const {
    DEFAULT_MODEL_FALLBACK_LIMIT, MAX_MODEL_CANDIDATES_PER_ROLE, MAX_MODEL_FALLBACK_LIMIT, MAX_MODEL_PAGES, NEXT_PEAK_VALLEY_PERIOD,
    NOTIFICATION_EVENT_TYPES, ORCHESTRATOR_ID, PROMPT_WARNING_RATIO,
    clampNotificationVolume, migrateSettingsSelection, modelLayerSelectionOf, normalizeRolePromptProjection, normalizeSettingsDraft, promptEntryOf,
    setModelLayerSelection, settingsRolesForProvider, validatePromptText,
  } = clientSettingsNormalize;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  let ModelConfigSection = null;
  /**
   * 主代理行的显示名：语言中性的专有名词，与侧栏「会话模型」弹窗第一行同一文案。
   *
   * 它不来自 roleLabelOf：那个映射只认识专家角色，未知键会回落成小写 id（orchestrator）。
   */
  const ORCHESTRATOR_ROW_LABEL = "Orchestrator";
  // 峰谷时段纯函数：与 Host 校验、保存前校验共用同一份构建期投影实现。
  let peakValleyTime = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
    ModelConfigSection = host.ModelConfigSection ?? null;
    peakValleyTime = host.peakValleyTime ?? null;
  }

  /**
   * 设置页渲染尾段的**调度器**：只负责三态判断、提示词详情页与主表单的分派。
   *
   * 票据 31 把原来一个 828 行的函数按渲染区块拆开：调用顺序与条件返回都与拆分前逐字相同。
   *
   * 票据 35：本函数是**纯渲染**——原来的那个 useEffect（离开确认的焦点）已抽成
   * `useSettingsLeaveFocus` 并由 DshExpertGroupSettings 无条件调用，这里不得再出现任何
   * `react.use*`（静态守卫用例 test/settings-hook-boundary.test.mjs 钉死）。
   */
  function renderSettingsTail(view) {
    const { closePrompt, selectedPromptRole, settingsSnapshot } = view;
    const actions = createSettingsTailActions(view);

      // 三态渲染（0.1.7-alpha.2 的 ConfigFormSnapshot.status）：
      // - `loading`：首次读取尚未落定（value 仍是 undefined），只给可读的加载提示，
      //   绝不用空值渲染整张表单（否则会把「还没读到」显示成「配置为空」）；
      // - `unavailable`：条目未暴露给本客户端或远端 memory 模式，给可读的不可用提示；
      // - `ready`（含远端 memory 但已读到值）：渲染完整表单，写权限由整页 writable 决定。
      if (settingsSnapshot.status === "loading") {
        return react.createElement("div", { className: "deg_settings" },
          selectedPromptRole === null ? null : react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("p", { className: "deg_settings_status", role: "status", "aria-live": "polite" }, "正在读取设置…"));
      }

      if (settingsSnapshot.status === "unavailable") {
        return react.createElement("div", { className: "deg_settings" },
          selectedPromptRole === null ? null : react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("p", { className: "deg_settings_error", role: "status" }, "设置 namespace 不可用"));
      }
    const promptEditor = renderSettingsPromptEditor(view, actions);
    const leaveDialog = renderSettingsLeaveDialog(view, actions);
    if (selectedPromptRole !== null) return react.createElement(react.Fragment, null, promptEditor, leaveDialog);
    // 峰谷子视图（票据 07）：设置页内的第二个视图，返回后回到原模型设置页。
    if (view.peakValleyOpen === true && typeof view.peakValleyViewOf === "function") {
      return renderPeakValleySettings(view.peakValleyViewOf(view));
    }

    return renderSettingsBody(view, actions);
  }

  /**
   * 尾段的四个派生 / 异步动作：放弃修改、加载最新配置、重试保存、恢复默认。
   */
  function createSettingsTailActions(view) {
    const {
      authorityValue, baselineProjection, committedAuthorityRef, committedSnapshotLagging, editPromptText, hostMeta,
      leaveTriggerRef, promptDirty, promptProjection, promptRoleIds, roles, save,
      saving, selectedPromptRole, setCandidatesError, setDirty, setDraft, setEditorBaseline,
      setError, setExternalSettingsChanged, setLeaveIntent, setLocalPromptProjection, setPromptDrafts, setPromptError,
      setPromptTouched, setSaved, setSettingsConflict, settingsConflict, settingsForm, settingsReadOnly,
      settingsSnapshot,
    } = view;

      const discard = () => {
        const snapshot = settingsForm.getSnapshot();
        // 放弃修改要回到"已保存"的状态：快照滞后时 authorityValue 才是刚提交的 accepted。
        const refreshedProjection = normalizeRolePromptProjection(hostMeta?.rolePrompts, authorityValue, true, promptRoleIds) ?? promptProjection;
        // 重新建草稿 = 读取面 → 草稿的入口，同样要播种默认峰段（与 main-a 的入口同一口径）。
        setDraft(normalizeSettingsDraft(authorityValue, roles, true, true));
        setCandidatesError(null);
        // 重新加载时清空局部草稿，让 Host 当前 effective/default 成为编辑初值。
        setPromptDrafts({});
        setPromptTouched({});
        if (selectedPromptRole !== null && refreshedProjection !== null) {
          setEditorBaseline({
            role: selectedPromptRole,
            value: authorityValue,
            revision: Number.isSafeInteger(committedAuthorityRef.current?.revision) && committedSnapshotLagging
              ? committedAuthorityRef.current.revision
              : (Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null),
            projection: refreshedProjection,
          });
        }
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      };

      const loadLatestPromptSettings = () => {
        const snapshot = settingsForm.getSnapshot();
        if (settingsConflict?.revision !== undefined
          && (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < settingsConflict.revision)) {
          setPromptError("最新配置尚未到达，请稍后再加载");
          return;
        }
        const projection = normalizeRolePromptProjection(hostMeta?.rolePrompts, snapshot.value, true, promptRoleIds) ?? promptProjection;
        if (selectedPromptRole === null || projection === null) {
          setPromptError("最新提示词配置不可用，请稍后重试");
          return;
        }
        setLocalPromptProjection(null);
        setDraft(normalizeSettingsDraft(snapshot.value, roles, true, true));
        setPromptDrafts({});
        setPromptTouched({});
        setEditorBaseline({ role: selectedPromptRole, value: snapshot.value, revision: snapshot.revision, projection });
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      };

      const retryPromptSave = async () => {
        if (settingsConflict?.revision !== undefined
          && (!Number.isSafeInteger(settingsSnapshot.revision) || settingsSnapshot.revision < settingsConflict.revision)) {
          setPromptError("最新配置尚未到达，请先加载最新配置");
          return false;
        }
        return save({ retry: true });
      };

      const restorePromptDefault = () => {
        const role = selectedPromptRole;
        const entry = promptEntryOf(baselineProjection, role);
        if (role === null || entry === null || settingsReadOnly || saving || baselineProjection?.customizable !== true) return;
        if (promptDirty) {
          leaveTriggerRef.current = typeof document === "undefined" ? null : document.activeElement;
          setLeaveIntent({ kind: "restore-default", role });
          return;
        }
        editPromptText(role, entry.defaultPersona);
      };
    return { discard, loadLatestPromptSettings, restorePromptDefault, retryPromptSave };
  }

  /**
   * 提示词详情页区块（标题、文本域、计数、状态行、冲突面与底部动作）。
   * 候选区块按要求整块删除：详情页只保留提示词编辑，候选统一在设置页页签里维护。
   */
  function renderSettingsPromptEditor(view, actions) {
    const {
      baselineProjection, closePrompt, editPromptText, error, externalSettingsChanged, hasUnsavedChanges,
      hostMetaError, promptError, promptLoading, promptMaxGraphemes, promptProjection, promptTextOf,
      refreshHostMeta, roleLabelOf, save, saved, saving, selectedPromptRole,
      settingsConflict, settingsReadOnly,
    } = view;

      const selectedPromptEntry = promptEntryOf(promptProjection, selectedPromptRole);
      const selectedPromptText = selectedPromptRole === null ? "" : promptTextOf(selectedPromptRole);
      const promptValidation = validatePromptText(selectedPromptText, promptMaxGraphemes);
      const promptCounterClass = promptValidation.count > promptMaxGraphemes
        ? " deg_prompt_counter_error"
        : promptValidation.count >= promptMaxGraphemes * PROMPT_WARNING_RATIO
          ? " deg_prompt_counter_warning"
          : "";
      const promptMetaMessage = hostMetaError
        ?? (promptProjection === null && !promptLoading ? "提示词配置不可用，请刷新后重试" : null);
      const promptStatusMessage = promptMetaMessage
        ?? (settingsReadOnly ? "当前设置为只读，可查看提示词但不能编辑或保存。" : null);
      // 文本变化即校验，不必点击保存才让辅助技术得知空值或超长输入。
      const promptValidationMessage = selectedPromptRole !== null && !promptValidation.ok ? promptValidation.message : null;
      const promptErrorMessage = promptError ?? promptValidationMessage ?? error ?? promptMetaMessage;
      const promptLabel = selectedPromptRole === null
        ? "专家"
        : roleLabelOf(selectedPromptRole);
      const promptEditor = selectedPromptRole === null ? null : react.createElement("div", { className: "deg_settings deg_settings_prompt_editor" },
        react.createElement("div", { className: "deg_prompt_header" },
          react.createElement("h2", { className: "deg_settings_title" }, promptLabel)),
        react.createElement("label", { className: "deg_prompt_label", htmlFor: "deg-prompt-textarea-" + selectedPromptRole }, "提示词"),
        promptProjection === null
          ? react.createElement(react.Fragment, null,
            react.createElement("p", { className: "deg_prompt_status", role: "status", "aria-live": "polite" }, promptStatusMessage ?? "提示词配置加载中…"),
            promptLoading ? null : react.createElement("button", {
              type: "button",
              className: "deg_btn",
              disabled: saving,
              onClick: refreshHostMeta,
            }, "重试加载提示词配置"))
          : react.createElement(react.Fragment, null,
            react.createElement("textarea", {
              id: "deg-prompt-textarea-" + selectedPromptRole,
              className: "deg_prompt_textarea",
              "data-deg-prompt-role": selectedPromptRole,
              "aria-label": promptLabel + "提示词",
              "aria-describedby": "deg-prompt-counter-" + selectedPromptRole
                + (promptErrorMessage === null ? "" : " deg-prompt-error-" + selectedPromptRole),
              "aria-invalid": !promptValidation.ok || promptErrorMessage !== null,
              value: selectedPromptText,
              disabled: settingsReadOnly || saving || promptProjection.customizable !== true,
              onChange: (event) => {
                const text = typeof event?.target?.value === "string" ? event.target.value : "";
                editPromptText(selectedPromptRole, text);
              },
            }),
            react.createElement("div", {
              id: "deg-prompt-counter-" + selectedPromptRole,
              className: "deg_prompt_counter" + promptCounterClass,
              role: "status",
              "aria-live": "polite",
            }, String(promptValidation.count) + " / " + String(promptMaxGraphemes)),
            promptStatusMessage === null ? null : react.createElement("p", { className: "deg_prompt_status", role: "status" }, promptStatusMessage)),
        // 候选区块按要求整块删除：详情页只保留提示词编辑，候选统一在设置页页签里维护。
        promptErrorMessage === null ? null : react.createElement("p", {
          id: "deg-prompt-error-" + selectedPromptRole,
          className: "deg_settings_error",
          role: "alert",
          "aria-live": "assertive",
        }, promptErrorMessage),
        externalSettingsChanged ? react.createElement("p", {
          className: "deg_prompt_status",
          role: "status",
          "aria-live": "polite",
        }, "配置已发生外部变化") : null,
        settingsConflict === null ? null : react.createElement("div", { className: "deg_prompt_conflict", role: "alert" },
          react.createElement("p", { className: "deg_settings_error" }, "保存遇到配置冲突，请选择下一步。"),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", { type: "button", className: "deg_btn", disabled: saving, onClick: actions.loadLatestPromptSettings }, "加载最新配置"),
            react.createElement("button", { type: "button", className: "deg_btn deg_btn_primary", disabled: saving, onClick: actions.retryPromptSave }, "继续使用当前修改重试"))),
        react.createElement("div", { className: "deg_prompt_footer" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            disabled: saving,
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("span", { className: "deg_prompt_status", role: "status", "aria-live": "polite" }, saved ? "已保存" : hasUnsavedChanges ? "有未保存的修改" : ""),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            // 详情页与列表页共用"有未保存修改"判定（提示词/候选/降级/通知等），其余门控不变。
            disabled: !hasUnsavedChanges || !promptValidation.ok || saving
              || settingsReadOnly || promptLoading || baselineProjection?.customizable !== true,
            onClick: save,
          }, saving ? "保存中…" : "保存"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: saving || settingsReadOnly || promptLoading || promptProjection?.customizable !== true
              || selectedPromptEntry === null || selectedPromptText === selectedPromptEntry.defaultPersona,
            onClick: actions.restorePromptDefault,
          }, "恢复默认")));
    return promptEditor;
  }

  /**
   * 弹窗焦点陷阱：Tab / Shift+Tab 在 [data-deg-dialog-action] 控件之间首尾相接循环。
   *
   * 为什么等价：离开确认弹窗与删除候选页确认框原先各写了一份逐字相同的实现（读取
   * event.currentTarget 的 action 控件、按 activeElement 的索引前进/后退、preventDefault 后
   * 聚焦下一个控件、无焦点环境静默兜底）。合并成一个模块级函数后，事件对象、控件选择器、
   * 循环算法与失败兜底全部不变；两处调用点仍只在 key === "Tab" 时进入（第二个弹窗为了
   * 容错用了 event?.key，调用前已保证 event 存在，因此行为一致）。
   *
   * @param {object} event 键盘事件（React 合成事件或 DOM 事件）。
   */
  function trapDialogTabFocus(event) {
    const controls = Array.from(event.currentTarget?.querySelectorAll?.("[data-deg-dialog-action]") ?? []);
    if (controls.length === 0) return;
    const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
    const nextIndex = event.shiftKey
      ? (current <= 0 ? controls.length - 1 : current - 1)
      : (current >= controls.length - 1 ? 0 : current + 1);
    event.preventDefault?.();
    try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
  }

  /**
   * 点时间输入框本身也唤出原生时间选择器（需求 2）。
   *
   * 宿主对 `<input type="time">` 的原生热区只覆盖钟表图案那块：点文本框其余部分只把焦点
   * 移进去，面板不会弹出，用户因此以为"必须点小图标"才能改时间。这里在 click 时显式调用
   * showPicker()，让输入框整块都是可点开的。
   *
   * 必须 try/catch，且失败一律忽略：
   * - 点钟表图案时原生已经打开/切换了选择器，再调一次会抛 InvalidStateError；
   * - 旧宿主没有 showPicker（或它要求更强的用户激活）同样可能抛错；
   * - 任何一种情况都只回到原生行为（点图案仍能打开），绝不让宿主差异冒泡成页面错误。
   * 用 onClick 而不是 onFocus + setTimeout：click 才是真实用户激活（showPicker 的准入条件），
   * 也不会在键盘 Tab 进入输入框时抢走焦点、打断键入。
   *
   * @param {object} event 输入框的 click 事件（React 合成事件或 DOM 事件）。
   */
  function showTimePickerOf(event) {
    const input = event?.currentTarget;
    // disabled 的输入框本身不会派发 click；这里只防御宿主/测试替身直接调用。
    if (input?.disabled === true || typeof input?.showPicker !== "function") return;
    try { input.showPicker(); } catch { /* 原生选择器已打开或该宿主不允许：保持原生行为。 */ }
  }

  /**
   * 未保存修改的离开确认弹窗：保存并离开 / 放弃修改 / 取消。
   */
  function renderSettingsLeaveDialog(view, actions) {
    const {
      applyPromptNavigation, baselineProjection, dismissLeaveDialog, editPromptText, leaveCancelRef, leaveIntent,
      save, saving,
    } = view;

      const leaveDialog = leaveIntent === null ? null : react.createElement("div", { className: "deg_prompt_dialog_backdrop" },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "未保存的修改",
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault?.();
              dismissLeaveDialog();
              return;
            }
            if (event.key !== "Tab") return;
            trapDialogTabFocus(event);
          },
        },
          react.createElement("h3", null, "未保存的修改"),
          react.createElement("p", null, "离开前请选择如何处理当前草稿。"),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            leaveIntent.kind === "restore-default"
              ? react.createElement("button", {
                type: "button",
                className: "deg_btn deg_btn_primary",
                "data-deg-dialog-action": "restore",
                disabled: saving,
                onClick: () => {
                  const role = leaveIntent.role;
                  const entry = promptEntryOf(baselineProjection, role);
                  dismissLeaveDialog();
                  if (entry !== null) editPromptText(role, entry.defaultPersona);
                },
              }, "恢复默认")
              : react.createElement("button", {
                type: "button",
                className: "deg_btn deg_btn_primary",
                "data-deg-dialog-action": "save",
                disabled: saving,
                onClick: async () => {
                  const savedNow = await save();
                  if (savedNow !== true) return;
                  const intent = leaveIntent;
                  dismissLeaveDialog();
                  applyPromptNavigation(intent?.role ?? null);
                },
              }, saving ? "保存中…" : "保存并离开"),
            leaveIntent.kind === "restore-default" ? null : react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "actions.discard",
              disabled: saving,
              onClick: () => {
                const intent = leaveIntent;
                actions.discard();
                dismissLeaveDialog();
                applyPromptNavigation(intent?.role ?? null);
              },
            }, "放弃修改"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              autoFocus: true,
              ref: leaveCancelRef,
              onClick: dismissLeaveDialog,
            }, "取消"))));
    return leaveDialog;
  }

  /**
   * 角色表区块（表头 + 每个角色的供应商 / 模型 / 思考深度三列），返回可直接放进 children 的
   * table_wrap 节点；列宽门控统一走 catalogAvailable，行读写的层由 currentModelPage 决定。
   */
  function renderSettingsRoleTable(view) {
    const {
      catalogAvailable, currentModelPage, draft, editDraft, error, modelRowRoles,
      openPrompt, promptProjection, promptRoleIds, providerGroups, roleLabelOf, roles,
      saving, selectedPromptRole, tExtra,
    } = view;

      const header = react.createElement(react.Fragment, null,
        react.createElement("span", { className: "deg_settings_table_head" }, "专家"),
        react.createElement("span", { className: "deg_settings_table_head" }, "供应商"),
        react.createElement("span", { className: "deg_settings_table_head" }, "模型选择"),
        react.createElement("span", { className: "deg_settings_table_head" }, "思考深度"));
      // 行级三个下拉的**目录门控**统一走 catalogAvailable（ready 或已有缓存目录）：
      // 刷新中的 loading、以及最新一次刷新失败后的 error，都只代表"内容可能不是最新"，
      // 只要缓存目录还在，里面的 provider/model/思考深度就仍然是用户可选的合法值；
      // 而首次挂载（还没有任何成功目录）与 connection/reset 清空目录之后 groups 为空，
      // catalogAvailable 为 false，三个下拉和保存按钮一并禁用。
      // 业务禁用条件（saving / roleEnabled / 没有 provider、model、reasoning）保持不变。
      const rows = modelRowRoles.map((role) => {
        /**
         * 主代理（保留键）与专家行走同一套渲染，但有三处刻意不同：
         * - 没有启用开关（不在 activeRoles 里，也不是被派发的角色）；
         * - 没有提示词入口（不是专家 persona 的承载者）；
         * - 空态文案写明「不干预主代理模型」，而不是留一个看起来坏掉的下拉。
         */
        const isOrchestrator = role === ORCHESTRATOR_ID;
        const roleLabel = isOrchestrator ? ORCHESTRATOR_ROW_LABEL : roleLabelOf(role);
        const roleEnabled = isOrchestrator || roles.includes(role);
        // 单元格一律读写**当前页**对应的层：主模型页 → defaults，候选页 → candidates[i - 1]。
        const selection = modelLayerSelectionOf(draft, role, currentModelPage);
        const rowProvider = typeof selection?.provider === "string" ? selection.provider : "";
        const rowProviderGroup = providerGroups.find((group) => group.id === rowProvider);
        const rowModels = rowProviderGroup?.models ?? [];
        const currentModel = rowModels.find((model) => model.id === selection?.model);
        const providerOptions = [
          react.createElement("option", { key: "__empty-provider", value: "" },
            isOrchestrator ? tExtra("settings.orchestrator.empty") : "未选择供应商"),
          ...(rowProvider && rowProviderGroup === undefined
            ? [react.createElement("option", { key: "__unavailable-provider", value: rowProvider, disabled: true }, rowProvider + "（不可用）")]
            : []),
          ...providerGroups.map((group) => react.createElement("option", { key: group.id, value: group.id }, group.name ?? group.id)),
        ];
        const modelOptions = [];
        if (!rowProvider) {
          modelOptions.push(react.createElement("option", { key: "__provider", value: "" }, "先选择供应商"));
        } else {
          modelOptions.push(react.createElement("option", { key: "__empty", value: "" }, "未选择模型"));
          if (selection?.model && currentModel === undefined) {
            modelOptions.push(react.createElement("option", { key: "__unavailable", value: selection.model, disabled: true }, selection.model + "（不可用）"));
          }
          for (const model of rowModels) {
            modelOptions.push(react.createElement("option", { key: model.id, value: model.id }, model.name ?? model.id));
          }
        }
        const reasoning = currentModel?.reasoning;
        const effortOptions = [];
        if (reasoning) {
          effortOptions.push(react.createElement("option", { key: "__default", value: "" }, "模型默认"));
          for (const effort of reasoning.efforts ?? []) {
            effortOptions.push(react.createElement("option", { key: effort.id, value: effort.id }, effort.name ?? effort.id));
          }
        } else {
          effortOptions.push(react.createElement("option", { key: "__unsupported", value: "" }, rowProvider ? "模型无思考深度" : "先选择模型"));
        }
        const updateProvider = (event) => {
          const provider = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            const currentProvider = typeof current?.provider === "string" ? current.provider : "";
            // 选中同一个供应商 = 没有变化：不制造脏值。
            if (provider === currentProvider) return previous;
            if (currentModelPage === 0) {
              // 主模型页：沿用历史语义——空值删掉该行，换供应商按显示名迁移同名模型。
              const next = !provider
                ? null
                : (migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" });
              const written = setModelLayerSelection(previous, role, 0, next);
              // 行级 provider 一旦存在就拥有优先权，顶层统一值顺带清空：主代理与专家行同一口径
              //（它同样是用户手改的单独一行），否则顶部会继续显示一个已经不成立的统一值。
              return { ...written, provider: "" };
            }
            // 候选页：与主模型页同一套联动，只作用于当前层；空值 = 清空该层该角色。
            const next = !provider
              ? { provider: "", model: "" }
              : (migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" });
            return setModelLayerSelection(previous, role, currentModelPage, next);
          });
        };
        const updateModel = (event) => {
          const modelId = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            const provider = typeof current?.provider === "string" ? current.provider : "";
            if (!provider) return previous;
            if (!modelId) {
              // 清空模型保留 provider（用户可以先选供应商再选模型）。
              if (typeof current?.model === "string" && current.model.length === 0) return previous;
              return setModelLayerSelection(previous, role, currentModelPage, { provider, model: "" });
            }
            const model = providerGroups.find((group) => group.id === provider)?.models?.find((candidate) => candidate.id === modelId);
            if (!model) return previous;
            const selected = { provider, model: model.id };
            // 与既有角色表一致：目录声明 defaultEffort 时才带思考深度，否则保持未指定。
            if (typeof model.reasoning?.defaultEffort === "string") selected.reasoningEffort = model.reasoning.defaultEffort;
            return setModelLayerSelection(previous, role, currentModelPage, selected);
          });
        };
        const updateReasoning = (event) => {
          const effort = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            if (current === null || typeof current.model !== "string" || current.model.length === 0) return previous;
            const next = { ...current };
            // 空值 = 删除字段（模型默认），与既有角色表一致。
            if (effort) next.reasoningEffort = effort;
            else delete next.reasoningEffort;
            if (next.reasoningEffort === current.reasoningEffort) return previous;
            return setModelLayerSelection(previous, role, currentModelPage, next);
          });
        };
        // 提示词入口只对 Host 投影声明的角色开放（只应是内置角色）；投影缺失时
        // 仍是内置六角色，历史行为不变。
        const promptEntryAvailable = promptRoleIds.includes(role);
        return react.createElement(react.Fragment, { key: role },
          react.createElement("div", { className: "deg_settings_table_cell deg_settings_role_cell" },
            promptEntryAvailable
              ? react.createElement("button", {
                type: "button",
                className: "deg_settings_role_button",
                "data-deg-prompt-role": role,
                "aria-label": roleLabel + "提示词"
                  + (promptEntryOf(promptProjection, role)?.customized === true ? "（已自定义提示词）" : ""),
                "aria-pressed": selectedPromptRole === role,
                // 读取失败仍可进入错误页并重试；只有正在提交时才锁住入口，避免永久死锁。
                disabled: saving,
                onClick: (event) => openPrompt(role, event),
              },
                react.createElement("span", null, roleLabel),
                promptEntryOf(promptProjection, role)?.customized === true
                  ? react.createElement("span", {
                    className: "deg_settings_prompt_customized_dot",
                    "aria-hidden": "true",
                  })
                  : null)
              : react.createElement("span", { className: "deg_settings_label", "data-deg-role-label": role }, roleLabel),
          ),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_provider_select",
              "aria-label": roleLabel + " 供应商",
              value: rowProvider,
              disabled: saving || !catalogAvailable || !roleEnabled,
              onChange: updateProvider,
            }, providerOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_model_select",
              "aria-label": roleLabel + " 模型选择",
              value: selection?.model ?? "",
              disabled: saving || !catalogAvailable || !roleEnabled || !rowProvider || rowProviderGroup === undefined,
              onChange: updateModel,
            }, modelOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_effort_select",
              "aria-label": roleLabel + " 思考深度",
              value: selection?.reasoningEffort ?? "",
              disabled: saving || !catalogAvailable || !roleEnabled || reasoning === undefined || !selection?.model,
              onChange: updateReasoning,
            }, effortOptions)));
      });
    return react.createElement("div", { className: "deg_settings_table_wrap" },
      react.createElement("div", { className: "deg_settings_table" }, header, rows));
  }

  /**
   * 峰时 / 谷时切换器：两个与页签同高（28px）的小按钮，只出现在峰谷子视图的页签行末尾。
   *
   * 为什么放在 tablist 之外：`role="tablist"` 的语义只容纳「模型页」页签，把时段切换器塞进去
   * 会被辅助技术读成又一个模型页，也会破坏方向键在页签间的移动模型；因此它和「峰谷模式」入口
   * 一样与 tablist 同层，靠 `margin-left:auto` 贴在同一行的最右侧。
   *
   * 为什么只在峰谷子视图渲染（view.peakValleyOpen === true）：主设置页——包括启用峰谷后锁定
   * 当前时段的主设置页——的时段由打开页面时采样并锁定（见 main-a 的 peakValleyPeriod 锁定逻辑），
   * 在那里放一个能切换时段的控件既不会改变本页编辑的 profile，又会让用户以为切换生效；
   * 主设置页保留「峰谷模式」入口按钮作为唯一出口，这是唯一可靠的判据。
   *
   * 视觉上沿用 deg_btn 的按钮外观（激活态用主色实心，与原来那一行一致），但高度与内边距
   * 对齐页签：两者同高才不会在同一行里一高一低。
   */
  function renderPeakValleyPeriodToggle(view) {
    const {
      peakValleyPeriod, saving, setPeakValleyPeriod, tExtra,
    } = view;

    const toggleButtons = ["peak", "valley"].map((period) => react.createElement("button", {
      key: period,
      type: "button",
      className: "deg_btn deg_settings_peak_valley_period" + (period === peakValleyPeriod ? " deg_btn_primary" : ""),
      "data-deg-peak-valley-period": period,
      "aria-pressed": period === peakValleyPeriod,
      disabled: saving,
      onClick: () => setPeakValleyPeriod(period),
    }, tExtra(period === "peak" ? "settings.pv.peak" : "settings.pv.valley")));
    // 外层容器只负责定位与间距；按钮本身继承 deg_btn 的语义（含 disabled 时的禁用样式）。
    return react.createElement("div", {
      // 容器 class 与「峰段区块」区分开（那是 deg_settings_peak_valley_periods）：
      // 这里只是页签行右侧的峰时/谷时按钮组，不能继承段落式布局。
      className: "deg_settings_pv_period_toggle",
      "data-deg-peak-valley-periods-toggle": "true",
    }, toggleButtons);
  }

  /**
   * 模型页签行（页签、落点竖条、× 与 +）：页签名只由位置推导，拖动只改渲染期落点提示。
   */
  function renderSettingsModelTabs(view) {
    const {
      addModelPage, beginModelTabDrag, currentModelPage, draft, modelPageCount, modelPageLabelOf, modelTabDrag,
      modelTabRefs, openPeakValley, peakValleyEntry, requestModelPageDelete, saving, selectModelPage,
      settingsReadOnly, tExtra,
    } = view;

      /**
       * 页签行（票据 24 重排）：主模型 / 候选1..3 / +。
       *
       * - 页签名只由位置推导，拖动重排不会改名；
       * - 候选页页签带 ×（主模型页不显示 ×），点击打开确认框；
       * - 拖动时在插入边界渲染一条 2px 落点竖条（data-deg-model-tab-drop）；
       * - 达到 4 页后 + 禁用（title 说明上限），与 MAX_MODEL_PAGES 同一口径。
       */
      const modelTabChildren = [];
      for (let page = 0; page < modelPageCount; page += 1) {
        if (modelTabDrag?.active === true && modelTabDrag.dropIndex === page) {
          modelTabChildren.push(react.createElement("span", {
            key: "drop-" + page,
            className: "deg_settings_model_tab_drop",
            "data-deg-model-tab-drop": String(page),
            "aria-hidden": "true",
          }));
        }
        const label = modelPageLabelOf(page);
        const selected = page === currentModelPage;
        const dragging = modelTabDrag?.active === true && modelTabDrag.page === page;
        modelTabChildren.push(react.createElement("div", {
          key: "page-" + page,
          ref: (node) => { modelTabRefs.current[page] = node; },
          className: "deg_settings_model_tab",
          role: "tab",
          // 页签是 div[role=tab]（内部还有 × 按钮，不能嵌套 button）；键盘用 Enter/Space 切换。
          tabIndex: selected ? 0 : -1,
          "aria-selected": selected,
          "data-deg-model-tab": page,
          "data-dragging": dragging ? "true" : void 0,
          title: label,
          onPointerDown: (event) => beginModelTabDrag(page, event),
          onClick: () => selectModelPage(page),
          onKeyDown: (event) => {
            if (event?.key !== "Enter" && event?.key !== " ") return;
            event.preventDefault?.();
            selectModelPage(page);
          },
        },
          react.createElement("span", { className: "deg_settings_model_tab_label" }, label),
          page === 0 ? null : react.createElement("button", {
            type: "button",
            className: "deg_settings_model_tab_remove",
            "data-deg-model-tab-remove": page,
            "aria-label": label + " " + tExtra("settings.modelTabs.remove"),
            disabled: saving || settingsReadOnly,
            // × 自己处理点击，绝不触发页签切换/拖动。
            onPointerDown: (event) => event?.stopPropagation?.(),
            onClick: (event) => {
              event?.stopPropagation?.();
              requestModelPageDelete(page);
            },
          }, "×")));
      }
      if (modelTabDrag?.active === true && modelTabDrag.dropIndex === modelPageCount) {
        modelTabChildren.push(react.createElement("span", {
          key: "drop-end",
          className: "deg_settings_model_tab_drop",
          "data-deg-model-tab-drop": String(modelPageCount),
          "aria-hidden": "true",
        }));
      }
      modelTabChildren.push(react.createElement("button", {
        key: "add-page",
        type: "button",
        className: "deg_settings_model_tab_add",
        "data-deg-model-tab-add": "true",
        "aria-label": tExtra("settings.modelTabs.add"),
        title: modelPageCount >= MAX_MODEL_PAGES ? tExtra("settings.modelTabs.limit") : tExtra("settings.modelTabs.add.title"),
        disabled: saving || settingsReadOnly || modelPageCount >= MAX_MODEL_PAGES,
        onClick: () => addModelPage(),
      }, "+"));
      /**
       * 「峰谷模式」入口（票据 07）：与 tablist 同层、但在 role=tablist **之外**——
       * tablist 的语义只容纳 tab，把普通按钮塞进去会让辅助技术读成页签。
       * 未启用为普通态；启用后加启用态 class，并用权威纯函数算出的当前时段作后缀。
       */
      // 投影视图（峰谷子视图 / 主设置页的周期视图）里 draft 已经是「某一套 profile」，
      // 峰谷状态在 view.peakValleyState 上；未投影时照旧从草稿读。
      const peakValleyState = view.peakValleyState ?? draft?.peakValley ?? {};
      const peakValleyEnabled = peakValleyState.enabled === true;
      /**
       * 后缀只读**已采样的时段 state**（页面打开时的锁定值 / 分钟级采样的当前时段），
       * 渲染期间因此不再读系统时间；与主设置页的提示行同源，两者不会互相矛盾。
       */
      const shownPeriod = view.livePeriod ?? view.mainPeriod;
      const peakValleySuffix = peakValleyEnabled
        ? " " + tExtra(shownPeriod === "peak" ? "settings.pv.peak" : "settings.pv.valley")
        : "";
      const peakValleyEntryButton = peakValleyEntry === false ? null : react.createElement("button", {
        type: "button",
        className: "deg_settings_model_tab deg_settings_peak_valley_entry" + (peakValleyEnabled ? " deg_settings_peak_valley_entry_active" : ""),
        "data-deg-peak-valley-entry": "true",
        "data-enabled": peakValleyEnabled ? "true" : "false",
        disabled: saving,
        // 需求 3：打开动作由 view.openPeakValley 提供——每次进入都按草稿启用态与墙钟
        // 重算默认时段（未启用 → 峰时；已启用 → 当前时段），见 main-a 的同名工厂。
        onClick: () => openPeakValley(),
      }, tExtra("settings.pv.entry") + peakValleySuffix);
      /**
       * 时段切换器插槽（峰时 / 谷时）：只在峰谷子视图里出现，且是页签行的**最后一个**子节点。
       * 子视图里入口按钮不渲染（投影把 peakValleyEntry 置为 false），所以切换器自然落在最右；
       * 判据只用 view.peakValleyOpen，避免主设置页（含锁定当前时段的主设置页）误渲染它。
       */
      const periodToggleSlot = view.peakValleyOpen === true ? renderPeakValleyPeriodToggle(view) : null;
      const modelTabRow = react.createElement("div", {
        className: "deg_settings_model_tabs",
        "data-deg-model-tabs": "true",
      },
        react.createElement("div", {
          className: "deg_settings_model_tablist",
          role: "tablist",
          "aria-label": tExtra("settings.modelTabs.primary") + " / " + tExtra("settings.modelTabs.candidate", { index: MAX_MODEL_CANDIDATES_PER_ROLE }),
        }, modelTabChildren),
        peakValleyEntryButton,
        periodToggleSlot);
    return modelTabRow;
  }

  /**
   * 删除候选页确认框：复用未保存弹窗的 backdrop / dialog 与 data-deg-dialog-action 键位模式；
   * 打开后焦点落在「取消」，文案说明会影响六个角色在该层的配置。
   */
  function renderSettingsModelDeleteDialog(view) {
    const {
      cancelModelPageDelete, confirmModelPageDelete, modelPageDeleteCancelRef, modelPageDeleteIntent, saving, tExtra,
    } = view;

      const modelPageDeleteDialog = modelPageDeleteIntent === null ? null : react.createElement("div", {
        className: "deg_prompt_dialog_backdrop",
        onClick: () => cancelModelPageDelete(),
      },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": tExtra("settings.modelTabs.remove.title"),
          onClick: (event) => event?.stopPropagation?.(),
          onKeyDown: (event) => {
            if (event?.key === "Escape") {
              event.preventDefault?.();
              event.stopPropagation?.();
              cancelModelPageDelete();
              return;
            }
            if (event?.key !== "Tab") return;
            trapDialogTabFocus(event);
          },
        },
          react.createElement("h3", null, tExtra("settings.modelTabs.remove.title")),
          react.createElement("p", null, tExtra("settings.modelTabs.remove.message", { index: modelPageDeleteIntent.page })),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              "data-deg-model-tab-delete-cancel": "true",
              // 破坏性动作不抢默认焦点。
              autoFocus: true,
              ref: modelPageDeleteCancelRef,
              disabled: saving,
              onClick: () => cancelModelPageDelete(),
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              "data-deg-dialog-action": "confirm",
              "data-deg-model-tab-delete-confirm": "true",
              disabled: saving,
              onClick: () => confirmModelPageDelete(),
            }, "删除"))));
    return modelPageDeleteDialog;
  }

  /**
   * 峰谷子视图（票据 07）：启用开关、最多三段峰段、峰/谷两套模型表与一次保存。
   *
   * 模型区直接复用 renderSettingsUnifiedRow / renderSettingsModelTabs / renderSettingsRoleTable：
   * 传给它们的 view 已把 draft.peakValley[period] 投影成顶层 settings 形状（见 main-a 的
   * peakValleyViewOf），因此页签、统一供应商、降级上限与拖动排序都不存在第二份实现。
   */
  function renderPeakValleySettings(view) {
    // peakValleyPeriod / setPeakValleyPeriod 不再由本函数消费：时段切换器改成在页签行里
    // 由 renderPeakValleyPeriodToggle 渲染（那里从同一个投影视图读这两个字段）。
    const {
      editPeakValley, error, hasUnsavedChanges, saved, saving,
      setPeakValleyOpen, settingsReadOnly, t, tExtra,
    } = view;
    const state = view.peakValleyState ?? {};
    const periods = Array.isArray(state.periods) ? state.periods : [];
    // 读取面 fail-closed 信号：已保存峰谷配置损坏时只能走「修复并保存」（显式 repair 意图位）。
    // 普通保存按钮在该状态下不发 peakValley，并由 Host 侧拒绝任何无修复意图的峰谷写入。
    const broken = typeof state.invalidCode === "string";
    const maxPeriods = peakValleyTime?.MAX_PEAK_VALLEY_PERIODS ?? 3;
    // 保存前校验与保存计划共用同一份权威归一：非法时段就地报错，且保存按钮/提交都被拦下。
    const check = peakValleyTime?.normalizePeakValleyPeriods?.(periods) ?? { ok: true };
    // 损坏态复用同一个错误横幅元素：提示"保存被阻止 + 如何修复"，不新增一块 DOM。
    const invalidMessage = check.ok !== true
      ? tExtra("settings.pv.invalid", { reason: check.reason })
      : broken ? tExtra("settings.pv.repairHint") : null;
    // 0 段 = 全天谷时、覆盖全天 = 全天峰时：两者都意味着"当前没有谷时"。
    const noValley = periods.length === 0 || peakValleyTime?.peakValleyPeriodsCoverFullDay?.(periods) === true;
    const editPeriod = (index, field, value) => editPeakValley((previous) => ({
      ...previous,
      periods: previous.periods.map((entry, position) => (position === index ? { ...entry, [field]: value } : entry)),
    }));
    const periodRows = periods.map((entry, index) => react.createElement("div", {
      key: "period-" + index,
      className: "deg_settings_task_row",
      "data-deg-peak-valley-period-row": String(index),
    },
      react.createElement("span", { className: "deg_settings_label" }, String(index + 1) + ". " + tExtra("settings.pv.start")),
      react.createElement("input", {
        type: "time",
        "aria-label": tExtra("settings.pv.start") + (index + 1),
        value: typeof entry?.start === "string" ? entry.start : "",
        disabled: saving || settingsReadOnly,
        // 需求 2：点输入框本身也能唤出时间选择器（不只是点钟表图案），见 showTimePickerOf。
        onClick: showTimePickerOf,
        onChange: (event) => editPeriod(index, "start", String(event?.target?.value ?? "")),
      }),
      react.createElement("span", { className: "deg_settings_label" }, tExtra("settings.pv.end")),
      react.createElement("input", {
        type: "time",
        "aria-label": tExtra("settings.pv.end") + (index + 1),
        value: typeof entry?.end === "string" ? entry.end : "",
        disabled: saving || settingsReadOnly,
        // 需求 2：结束时间与开始时间同一交互（点输入框即唤出选择器）。
        onClick: showTimePickerOf,
        onChange: (event) => editPeriod(index, "end", String(event?.target?.value ?? "")),
      }),
      react.createElement("button", {
        type: "button",
        className: "deg_btn",
        // 可见文字只有「删除」（行内已按位置排序，重复「峰段」太啰嗦）；可访问名称仍带序号，
        // 屏幕阅读器与既有自动化测试靠它定位具体行。
        "aria-label": tExtra("settings.pv.remove.aria") + (index + 1),
        disabled: saving || settingsReadOnly,
        onClick: () => editPeakValley((previous) => ({
          ...previous,
          periods: previous.periods.filter((unused, position) => position !== index),
        })),
      }, tExtra("settings.pv.remove"))));
    const enabled = state.enabled === true;
    /**
     * 标题行右侧的当前时段徽标（需求 1）：只在峰谷**已启用**时渲染「峰时」或「谷时」。
     *
     * - 未启用时整块不渲染（而不是显示「未启用」）：那样会暗示峰谷已经生效，而这一页的
     *   启用开关就在下方，用户在标题行读到「未启用」纯属误导；
     * - 时段来源与入口按钮同一口径：优先实时采样值 livePeriod（跨过峰谷边界随分钟级采样
     *   更新），其次页面打开时锁定的 mainPeriod，最后才回退到在编辑的 peakValleyPeriod
     *   （前两者都还没产生时的兜底）；都不是合法值时按峰时显示，徽标因此永远有确定文案。
     *   注意它**不跟随**峰时/谷时切换器：徽标表达"现在真实处于哪个时段"，切换器表达
     *   "本页正在编辑哪一套"，两者点在同一个页签行里却语义不同。
     * - data 属性刻意用新名字 data-deg-peak-valley-state：切换器用的是
     *   data-deg-peak-valley-period，主设置页的契约用例断言那里不得出现切换器控件，
     *   徽标绝不能复用那个属性——它只是只读状态标记，不表达任何可切换语义。
     */
    const statePeriod = view.livePeriod ?? view.mainPeriod ?? view.peakValleyPeriod;
    const stateBadge = enabled
      ? react.createElement("span", {
        className: "deg_settings_peak_valley_state",
        "data-deg-peak-valley-state": statePeriod === "valley" ? "valley" : "peak",
      }, tExtra(statePeriod === "valley" ? "settings.pv.valley" : "settings.pv.peak"))
      : null;
    // 峰时 / 谷时切换器不再独占一行：它由 renderSettingsModelTabs 渲染在页签行最右侧
    // （见 renderPeakValleyPeriodToggle 的注释），这里只保留启用开关与时段编辑。
    return react.createElement("div", { className: "deg_settings", "data-deg-peak-valley": "true" },
      react.createElement("div", { className: "deg_prompt_footer" },
        // 标题已经写明「峰谷模式」，返回键只需表达动作，因此文字简化为「← 返回」；
        // aria-label 仍是「返回模型设置」，与页脚返回按钮保持同一可访问名称。
        react.createElement("button", {
          type: "button",
          className: "deg_btn deg_prompt_back",
          "aria-label": "返回模型设置",
          disabled: saving,
          onClick: () => setPeakValleyOpen(false),
        }, "← " + tExtra("settings.pv.back")),
        react.createElement("h2", { className: "deg_settings_title" }, tExtra("settings.pv.entry")),
        // 需求 1：标题右侧的当前时段徽标（未启用时为 null，不占位）。
        stateBadge),
      // 只在未初始化时提示「首次启用会从普通配置复制两套模型」；已初始化后这句话不再提供
      // 任何可操作信息（客户端本就没有改回未初始化的入口），因此整段不渲染、不占位。
      state.initialized === true ? null : react.createElement("p", {
        className: "deg_settings_hint",
        "data-deg-peak-valley-uninit": "true",
      }, tExtra("settings.pv.uninit")),

      react.createElement("div", { className: "deg_settings_task_row" },
        react.createElement("label", { className: "deg_settings_checkbox" },
          react.createElement("input", {
            type: "checkbox",
            "aria-label": tExtra("settings.pv.enable"),
            checked: enabled,
            disabled: saving || settingsReadOnly,
            onChange: (event) => editPeakValley((previous) => ({ ...previous, enabled: event.target.checked === true })),
          }),
          react.createElement("span", { className: "deg_settings_label" }, tExtra("settings.pv.enable")))),
      /**
       * 峰段区块（两段式）：添加按钮是**固定首行**，峰段行整体在下方列表里。
       *
       * 这样峰段增减只改变列表高度，添加按钮的位置与宽度（.deg_btn 的 flex:1）都不动——
       * 原来按钮与时段行同排，峰段一多就被挤到第二行、与「当前没有谷时」提示错位。
       * 原来行首的「峰段时段」标签按 UI 精简要求删除（区块已有启用开关作为标题语义）。
       */
      react.createElement("div", { className: "deg_settings_peak_valley_periods", "data-deg-peak-valley-periods": "true" },
        react.createElement("div", { className: "deg_settings_task_row" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            "data-deg-peak-valley-add": "true",
            disabled: saving || settingsReadOnly || periods.length >= maxPeriods,
            onClick: () => editPeakValley((previous) => ({
              ...previous,
              periods: previous.periods.length >= maxPeriods
                ? previous.periods
                // 第三段默认值来自权威常量：与默认两条不重叠，否则保存前校验直接判非法。
                : [...previous.periods, { ...NEXT_PEAK_VALLEY_PERIOD }],
            })),
          }, tExtra("settings.pv.add")),
          noValley ? react.createElement("p", { className: "deg_settings_hint", role: "status" }, tExtra("settings.pv.noValley")) : null),
        react.createElement("div", { className: "deg_settings_peak_valley_period_list" }, periodRows)),
      renderSettingsUnifiedRow(view),
      renderSettingsModelTabs(view),
      renderSettingsRoleTable(view),
      invalidMessage === null ? null : react.createElement("p", { className: "deg_settings_error", role: "alert" }, invalidMessage),
      error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, error) : null,
      renderSettingsModelDeleteDialog(view),
      /**
       * 峰谷页脚（顺序即视觉顺序）：返回 → 状态 → （损坏态的）修复 → 保存。
       * - 左侧「返回」与左上角返回完全同一动作（setPeakValleyOpen(false)）与同一禁用语义，
       *   长页面滚到底部时不必再滚回顶部；
       * - 两键同宽：宽度份额由 .deg_settings_pv_footer 规则锁定（.deg_btn 本身是 flex:1，
       *   这里必须显式覆盖，否则会被状态文本挤成不同宽度）；
       * - 状态文本夹在两键之间用 margin-right:auto 吸收空白，保存因此恒在最右且不被遮挡。
       */
      react.createElement("div", { className: "deg_settings_footer deg_settings_pv_footer" },
        react.createElement("button", {
          type: "button",
          className: "deg_btn",
          "data-deg-peak-valley-back": "true",
          "aria-label": "返回模型设置",
          disabled: saving,
          onClick: () => setPeakValleyOpen(false),
        }, tExtra("settings.pv.back")),
        react.createElement("span", { className: "deg_settings_status", role: "status" }, saved ? t("settings.saved") : hasUnsavedChanges ? t("settings.unsaved") : ""),
        // 损坏态下普通保存被禁用：它只会把归一后的缺省值写回（Host 也会拒绝），
        // 唯一出口是紧邻保存按钮左侧的「修复并保存」（仍保证保存按钮在最右）。
        broken
          ? react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            "data-deg-peak-valley-repair": "true",
            disabled: saving || settingsReadOnly || check.ok !== true,
            onClick: view.saveRepair,
          }, tExtra("settings.pv.repair"))
          : null,
        react.createElement("button", {
          type: "button",
          className: "deg_btn deg_btn_primary",
          "data-deg-peak-valley-save": "true",
          disabled: !hasUnsavedChanges || saving || settingsReadOnly || check.ok !== true || broken,
          onClick: view.save,
        }, saving ? t("settings.saving") : t("settings.save"))));
  }

  /**
   * 任务管理、Auto 与左侧栏入口开关行：三个开关各自独立，绝不随模型配置的折叠内容一起消失。
   */
  function renderSettingsTaskRow(view) {
    const {
      draft, editDraft, saving, t,
    } = view;

    const taskRow = (
        react.createElement("div", { className: "deg_settings_row deg_settings_task_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": t("settings.taskManagement"),
              checked: draft.taskManagementEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, taskManagementEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.taskManagement"))),
          // 「Auto」自动打开运行中的子代理右侧栏会话；维持原悬浮说明与保存绑定。
          react.createElement("label", { className: "deg_settings_checkbox", title: t("settings.autoTitle") },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": t("settings.auto"),
              checked: draft.autoOpenSubagentSidebar,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, autoOpenSubagentSidebar: event.target.checked === true })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.auto"))),
          // 「左侧栏入口」：默认开启，只有显式取消勾选才隐藏入口；与上面两个开关同处一行
          // （行容器是 flex + wrap + 28px column-gap，第三个开关直接并入即可，无需改样式）。
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": t("settings.sidebarEntry"),
              checked: draft.sidebarEntryEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, sidebarEntryEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.sidebarEntry"))))
    );

    return taskRow;
  }

  /**
   * 通知开关、音量双控件与「通知事件」下拉：停留时长字段已按票据 14 移除。
   */
  function renderSettingsNotificationRow(view) {
    const {
      draft, editDraft, notificationEventsOpen, notificationEventsPanelRef, notificationEventsRootRef, notificationEventsTriggerRef,
      saving, setNotificationEventsOpen, t,
    } = view;

      // 「通知事件」下拉的实时计数与可访问名称：数字语言无关，只随勾选变化；展开/收起不参与计算。
      const notificationEventsEnabledCount = NOTIFICATION_EVENT_TYPES.filter(
        (type) => draft.notificationEvents[type] === true,
      ).length;
      const notificationEventsTriggerLabel = t("settings.notificationEvents") + " (" + notificationEventsEnabledCount + ")";

    const notificationRow = (
        react.createElement("div", { className: "deg_settings_row deg_settings_notification_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              checked: draft.notificationEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.notifications"))),
          // 停留时长字段已按票据 14 移除：Windows Toast 的展示时长由系统策略决定，
          // 旧配置里的该字段在读取/提交边界被忽略，不迁移、不报错。
          // 两个输入控件分别提供可访问名称，避免一个 label 同时包裹多个可标记控件。
          react.createElement("div", { className: "deg_settings_control" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.notificationVolume")),
            react.createElement("input", {
              id: "deg-settings-notification-volume-range",
              type: "range", min: 0, max: 100, step: 1,
              "aria-label": t("settings.notificationVolume.range"),
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            }),
            react.createElement("input", {
              id: "deg-settings-notification-volume-number",
              type: "number", min: 0, max: 100, step: 1,
              "aria-label": t("settings.notificationVolume.number"),
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            })),
          // 「通知事件」多选下拉（布局调整）：三个类别固定，展开后才渲染复选框。
          // 勾选只写 draft.notificationEvents；展开/收起不触碰草稿，也不触发保存。
          react.createElement("div", { className: "deg_settings_events_dropdown", ref: notificationEventsRootRef },
            react.createElement("button", {
              type: "button",
              className: "deg_settings_events_trigger",
              id: "deg-settings-notification-events-trigger",
              ref: notificationEventsTriggerRef,
              // 可访问名称与可见文字一致（含实时计数）；面板展开状态与归属用 ARIA 表达。
              "aria-label": notificationEventsTriggerLabel,
              "aria-haspopup": "true",
              "aria-expanded": notificationEventsOpen ? "true" : "false",
              "aria-controls": "deg-settings-notification-events-panel",
              disabled: saving,
              onClick: () => setNotificationEventsOpen((previous) => !previous),
            },
              react.createElement("span", { className: "deg_settings_events_label" }, t("settings.notificationEvents")),
              react.createElement("span", { className: "deg_settings_events_count", "aria-hidden": "true" }, "(" + notificationEventsEnabledCount + ")"),
              react.createElement("span", { className: "deg_settings_events_caret", "aria-hidden": "true" }, "▾")),
            notificationEventsOpen
              ? react.createElement("div", {
                className: "deg_settings_events_panel",
                id: "deg-settings-notification-events-panel",
                ref: notificationEventsPanelRef,
                role: "group",
                "aria-label": t("settings.notificationEvents"),
              }, NOTIFICATION_EVENT_TYPES.map((type) => react.createElement("label", { key: type, className: "deg_settings_checkbox" },
                react.createElement("input", {
                  type: "checkbox",
                  "aria-label": t("settings.notificationEvent." + type + ".aria"),
                  checked: draft.notificationEvents[type] === true,
                  disabled: saving,
                  onChange: (event) => editDraft((previous) => ({
                    ...previous,
                    notificationEvents: { ...previous.notificationEvents, [type]: event.target.checked === true },
                  })),
                }),
                react.createElement("span", { className: "deg_settings_label" }, t("settings.notificationEvent." + type)))))
              : null))
    );

    return notificationRow;
  }

  /**
   * 统一供应商与自动降级上限合为一行：统一供应商只作用于当前显示页。
   */
  function renderSettingsUnifiedRow(view) {
    const {
      catalogAvailable, currentModelPage, draft, editDraft, providerGroups, roles,
      saving, settingsReadOnly, t, tExtra, unifiedProvider,
    } = view;

      // 自动降级上限的展示值：草稿有合法整数就用草稿，否则显示默认 2（与草稿归一同一口径）。
      const fallbackLimitDraft = Number.isSafeInteger(draft.fallbackLimit) ? draft.fallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT;

    const unifiedRow = (
        react.createElement("div", { className: "deg_settings_row deg_settings_unified_row" },
          react.createElement("div", { className: "deg_settings_provider_group" },
            react.createElement("label", { className: "deg_settings_label", htmlFor: "deg-settings-provider" }, t("settings.unifiedProvider")),
            react.createElement("div", { className: "deg_settings_control" },
              react.createElement("select", {
                id: "deg-settings-provider",
                className: "deg_settings_provider_select",
                value: unifiedProvider,
                disabled: saving || !catalogAvailable,
                onChange: (event) => editDraft((previous) => {
                  const provider = event.target.value;
                  // 「统一供应商」是一次**整层**动作：主代理（保留键 Orchestrator，配置独立存于
                  // settings.orchestrator）与六个专家角色走同一个循环、同一套迁移规则——页 0 写
                  // defaults、页 i 写 candidates[i - 1]，由 setModelLayerSelection 按 role 分派。
                  // 因此这里没有主代理专用函数或分支，两边的跟随行为不可能再漂移。
                  const providerRoles = settingsRolesForProvider(roles);
                  if (!provider) {
                    // 「无」只清空顶层统一值：不删任何行；候选页连草稿都不写（与主模型页同语义）。
                    // 旧文档只有顶层 provider 且没有可见行时也保留它，避免选择器动作破坏迁移来源。
                    if (currentModelPage !== 0) return previous;
                    const hasVisibleProvider = providerRoles.some((role) => {
                      const value = previous.defaults?.[role]?.provider;
                      return typeof value === "string" && value.length > 0;
                    });
                    return hasVisibleProvider ? { ...previous, provider: "" } : previous;
                  }
                  // 选具体 provider：候选页只改当前层候选、绝不碰 defaults；主模型页写 defaults 并
                  // 把统一值写回顶层。两个分支共用同一循环，主代理与专家逐字同规则。
                  let next = currentModelPage === 0 ? { ...previous, provider } : previous;
                  for (const role of [...providerRoles, ORCHESTRATOR_ID]) {
                    const current = modelLayerSelectionOf(next, role, currentModelPage);
                    // 与单元格换供应商同一套显示名迁移；迁移不到（含该行原本未配置/半填）就只保留
                    // provider、清空 model——半填行正是「跟随」的可见结果，不能因半填而跳过。
                    const migrated = migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" };
                    next = setModelLayerSelection(next, role, currentModelPage, migrated);
                  }
                  return next;
                }),
              },
                react.createElement("option", { value: "" }, t("settings.noProvider")),
                providerGroups.map((group) => react.createElement("option", { key: group.id, value: group.id }, group.name ?? group.id))))),
          // 自动降级上限（票据 24 重排）：候选改在页签里按层维护，这里只保留启动失败时的
          // 全局降级次数上限；草稿/保存字段与校验语义保持原样。
          react.createElement("div", { className: "deg_settings_fallback_group" },
            react.createElement("label", { className: "deg_settings_label", htmlFor: "deg-settings-model-fallback-limit" }, tExtra("settings.modelCandidates.fallbackLimit")),
            react.createElement("div", { className: "deg_settings_control" },
              react.createElement("input", {
                id: "deg-settings-model-fallback-limit",
                type: "number", min: 0, max: MAX_MODEL_FALLBACK_LIMIT, step: 1, inputMode: "numeric",
                "aria-label": tExtra("settings.modelCandidates.fallbackLimit"),
                title: tExtra("settings.modelCandidates.fallbackLimit.title"),
                value: draft.fallbackLimit === void 0 ? fallbackLimitDraft : draft.fallbackLimit,
                disabled: saving || settingsReadOnly,
                onChange: (event) => {
                  const raw = event.target.value;
                  const number = raw === "" ? null : Number(raw);
                  editDraft((previous) => ({ ...previous, fallbackLimit: raw === "" ? "" : Number.isFinite(number) ? Math.round(number) : previous.fallbackLimit }));
                },
              }))))
    );

    return unifiedRow;
  }

  /**
   * 管理行：观察者优先开关、角色并发上限与角色默认超时（秒 ↔ 毫秒只在 UI 换算）。
   */
  function renderSettingsManagementRow(view) {
    const {
      draft, editDraft, saving, t,
    } = view;

    const managementRow = (
        react.createElement("div", { className: "deg_settings_row deg_settings_management_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", { type: "checkbox", "aria-label": t("settings.observerPreferred"), checked: draft.observerPreferred, disabled: saving, onChange: (event) => editDraft((previous) => ({ ...previous, observerPreferred: event.target.checked })) }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.observerPreferred"))),
          // 管理行三个部分都是直接子节点，间距由容器统一给出（与任务行/统一行同节奏）。
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-role-concurrency-limit" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.concurrencyLimit")),
            react.createElement("input", {
              id: "deg-settings-role-concurrency-limit",
              type: "number",
              "aria-label": t("settings.concurrencyLimit"),
              // 与相邻「角色默认超时」输入框一致：原生 title 说明取值范围与默认值（悬停可见）。
              title: t("settings.concurrencyLimit.title"),
              min: 1,
              max: 64,
              step: 1,
              inputMode: "numeric",
              value: draft.roleConcurrencyLimit,
              disabled: saving,
              onChange: (event) => {
                const raw = event.target.value;
                const number = raw === "" ? null : Number(raw);
                editDraft((previous) => ({
                  ...previous,
                  roleConcurrencyLimit: raw === ""
                    ? ""
                    : Number.isFinite(number) ? number : previous.roleConcurrencyLimit,
                }));
              },
            })),
          // 角色级默认超时（票据 06）：设置页以**秒**展示与编辑（0 = 不启用），提交时换算成
          // Host 的毫秒字段 roleTimeoutMs；与并发上限同一行的紧凑布局。
          // 精度与边界由 Host 与管理器共同保证；这里只提供步进与可访问名称。
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-role-timeout-ms" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.roleTimeout")),
            react.createElement("input", {
              id: "deg-settings-role-timeout-ms",
              type: "number",
              "aria-label": t("settings.roleTimeout.aria"),
              title: t("settings.roleTimeout.title"),
              min: 0,
              max: 86400,
              step: 1,
              inputMode: "numeric",
              value: draft.roleTimeoutMs === "" ? "" : draft.roleTimeoutMs / 1000,
              disabled: saving,
              onChange: (event) => {
                const raw = event.target.value;
                const seconds = raw === "" ? null : Number(raw);
                editDraft((previous) => ({
                  ...previous,
                  // 草稿与 Host 字段保持毫秒；UI 只做秒 ↔ 毫秒换算，整秒取整。
                  roleTimeoutMs: raw === ""
                    ? ""
                    : Number.isFinite(seconds) ? Math.round(seconds) * 1000 : previous.roleTimeoutMs,
                }));
              },
            })))
    );

    return managementRow;
  }


  /** 「峰时 / 谷时」标签：副标题后缀与跨边界提示共用这一份口径，避免两处三目各写一遍。 */
  function periodLabelOf(view, period) {
    return view.tExtra(period === "peak" ? "settings.pv.peak" : "settings.pv.valley");
  }

  /**
   * 主设置页副标题里的时段后缀（票据 08）：锁定的编辑目标紧跟副标题句末、同一行显示。
   *
   * 返回 null 表示当前不在峰谷时段视图（mainPeriod 为 null），此时副标题逐字保持旧行为。
   * 只读 view.mainPeriod：编辑目标在打开页面时锁定，不随系统时间变化。
   */
  function mainPeriodScopeOf(view, mainPeriod) {
    if (mainPeriod === null || mainPeriod === void 0) return null;
    // 前缀空格是句号之后的分隔；文案本体来自 i18n 的 settings.pv.mainScope。
    return " " + view.tExtra("settings.pv.mainScope", { period: periodLabelOf(view, mainPeriod) });
  }

  /**
   * 主设置页的跨边界常驻提示（票据 08）：进入另一个时段时补一句「当前已进入 X，本页仍在编辑 Y」。
   *
   * 只读 view.livePeriod 这个 state，**绝不读系统时间**：跨过边界时由分钟级定时器更新
   * livePeriod，这里只负责提示；编辑目标与保存目标都不随之改变。
   */
  function renderMainPeriodHint(view, mainPeriod) {
    const { livePeriod } = view;
    if (mainPeriod === null || mainPeriod === void 0) return null;
    // 定时器还没采样（null）时不算跨边界，避免首帧误报。
    if (livePeriod === null || livePeriod === void 0 || livePeriod === mainPeriod) return null;
    return react.createElement("p", {
      className: "deg_settings_hint",
      role: "status",
      "data-deg-main-period-hint": "true",
    }, view.tExtra("settings.pv.boundary", {
      current: periodLabelOf(view, livePeriod),
      editing: periodLabelOf(view, mainPeriod),
    }));
  }

  /**
   * 设置页主表单本体：按渲染顺序把各区块组装进根节点。
   * 区块顺序与拆分前的 children 顺序逐项一致（标题 / 说明 / 模型配置 / 任务行 / 通知行 /
   * 统一行 / 页签 / 角色表 / 管理行 / 三类错误行 / 删除确认框 / 页脚）。
   */
  function renderSettingsBody(view, actions) {
    const {
      candidatesError, catalogAvailable, directoryState, draft, error, hasUnsavedChanges, modelConfigHost, modelFieldsChanged,
      roleLabelOf, roles, save, saved, saving, settingsSnapshot, t,
    } = view;

      const modelConfigSection = typeof modelConfigHost === "undefined" || modelConfigHost === null
        ? null
        : react.createElement(ModelConfigSection, {
          host: modelConfigHost,
          roleDefaults: normalizeSettingsDraft(settingsSnapshot.value, roles).defaults,
          roleLabelOf,
          // 仅首次挂载的默认态：左侧栏全页入口为 true；settings.section 不传该 prop，恒为 false。
          defaultOpen: view.modelConfigDefaultOpen === true,
        });
    /**
     * 票据 08：启用峰谷后主设置页成为「当前时段」视图。
     *
     * 复用 07 的视图草稿映射，把 draft.peakValley[mainPeriod] 投影成顶层 settings 形状；
     * 统一供应商、页签、角色表与删除确认框因此仍是同一份实现。普通配置整块不渲染、
     * 也不可编辑：编辑目标锁定在 mainPeriod，保存只回写这一个 profile。
     * 未启用时 mainPeriod 为 null，modelView 就是 view 本身，主设置页逐字保持旧行为。
     */
    const lockedPeriod = view.mainPeriod === void 0 ? null : view.mainPeriod;
    // 草稿里已经关闭峰谷（例如在子视图里关掉后返回）时回到普通配置；锁定值本身保留，
    // 再次启用仍复用它，绝不重新采样系统时间。
    const mainPeriod = lockedPeriod !== null && draft?.peakValley?.enabled === true ? lockedPeriod : null;
    const modelView = mainPeriod === null
      ? view
      : view.peakValleyViewOf({ ...view, peakValleyPeriod: mainPeriod, peakValleyEntry: true });
    const modelTabRow = renderSettingsModelTabs(modelView);
    const modelPageDeleteDialog = renderSettingsModelDeleteDialog(modelView);

    return react.createElement("div", { className: "deg_settings" },
      react.createElement("h2", { className: "deg_settings_title" }, t("settings.title")),
      // 峰谷视图里「本页正在编辑 X 模型（打开页面时锁定）」拼在副标题句末，与副标题同一行；
      // 普通配置既不追加后缀也不渲染 data-deg-main-period，DOM 与旧行为逐字一致。
      react.createElement("p", {
        className: "deg_settings_hint",
        ...(mainPeriod === null ? {} : { "data-deg-main-period": mainPeriod }),
      }, t("settings.hint"), mainPeriodScopeOf(view, mainPeriod)),
      // 跨边界提示保持独立一行，只在打开页面期间真的跨过时段时才出现。
      renderMainPeriodHint(view, mainPeriod),
      // 已保存峰谷配置损坏：主设置页的保存一律不携带 peakValley（Host 侧同口径拒绝），
      // 这里把"为什么保存不生效、该去哪里修"直接讲清楚。
      view.peakValleyBroken
        ? react.createElement("p", { className: "deg_settings_error" }, view.tExtra("settings.pv.broken"))
        : null,
      mainPeriod === null ? modelConfigSection : null,
      renderSettingsTaskRow(view),
      renderSettingsNotificationRow(view),
      renderSettingsUnifiedRow(modelView),
      modelTabRow,
      renderSettingsRoleTable(modelView),
      renderSettingsManagementRow(view),
        candidatesError === null || candidatesError === void 0 ? null : react.createElement("p", {
          className: "deg_settings_error",
          role: "alert",
          "data-deg-model-candidates-error": "true",
        }, candidatesError),
        directoryState.error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, directoryState.error) : null,
        error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, error) : null,
      modelPageDeleteDialog,
        react.createElement("div", { className: "deg_settings_footer" },
          react.createElement("span", { className: "deg_settings_status", role: "status" }, saved ? t("settings.saved") : hasUnsavedChanges ? t("settings.unsaved") : ""),
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving, onClick: actions.discard }, t("settings.discard")),
          // 票据 20：目录不可用只在本次草稿含模型字段变更时禁用保存；通知、任务开关、
          // 提示词、并发/超时等与模型无关的字段必须照常可保存。
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving || (modelFieldsChanged && !catalogAvailable) || settingsSnapshot.writable !== true, onClick: save }, saving ? t("settings.saving") : t("settings.save"))));
  }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    bindClientRuntime, renderSettingsTail,
  });
})(globalThis);
