/**
 * 设置页主组件（状态、草稿、保存动作；渲染尾段在 client-settings-main-b.js）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-settings-main-a")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientSettingsMainA(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-settings-main-a");
  const clientTextSymbol = Symbol.for("dsh-expert-group/client-text");
  const clientText = global[clientTextSymbol] || {};
  const clientSettingsNormalizeSymbol = Symbol.for("dsh-expert-group/client-settings-normalize");
  const clientSettingsNormalize = global[clientSettingsNormalizeSymbol] || {};
  const clientSettingsMainBSymbol = Symbol.for("dsh-expert-group/client-settings-main-b");
  const clientSettingsMainB = global[clientSettingsMainBSymbol] || {};
  const {
    resolveSettingsLocale, settingsExtraText, settingsText,
  } = clientText;
  const {
    DEFAULT_MODEL_FALLBACK_LIMIT, DEFAULT_PROMPT_MAX_GRAPHEMES, MAX_MODEL_PAGES, PROMPT_ROLE_IDS, SETTINGS_ROLE_LABELS, addModelCandidatePage,
    commitSettingsCandidate, compactModelCandidatesDraft, mergeSettingsDraftOverSource, modelCandidatesErrorMessage, modelLayerMapOf, modelPageCountOf,
    normalizeModelCandidatesDraft, normalizePromptOverrides, normalizeRolePromptProjection, normalizeSettingsCommitDraft, normalizeSettingsDraft, promptEntryOf,
    promptOverridesEqual, removeModelCandidatePage, reorderModelLayers, settingsDraftEqual, unifiedProviderOf, updateRolePromptProjection,
    useEnabledSettingsRoles, useHostMeta, validateModelCandidateRows, validatePromptText,
  } = clientSettingsNormalize;
  const {
    renderSettingsTail,
  } = clientSettingsMainB;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

  /**
   * 设置页「离开确认」的焦点 Hook（票据 35）。
   *
   * 票据 34 曾把这段 useEffect 提到 renderSettingsTail 的函数体顶部来修 loading → ready
   * 的 Hook 顺序（条件返回之后再调 Hook 会让 React 抛 "Rendered more hooks than during the
   * previous render"）。但静态形式仍然违规：renderSettingsTail 既不是组件、也不叫 `use*`，
   * 在它内部调用 react.use* 属于「Hook 写在普通 helper 里」——只要将来有人在它前面加一个
   * 条件返回，同类 bug 就会原样重现，静态检查（ESLint rules-of-hooks）也会一直报错。
   *
   * 票据 35 因此把它抽成正式的自定义 Hook，放在使用它的组件同一个模块里：
   * Hook 的归属（use* 函数）与调用位置（DshExpertGroupSettings 内、**所有条件返回之前**的
   * 无条件调用）都由组件保证，不再依赖 renderSettingsTail 每次都执行到那一行。
   *
   * 行为与票据 34 一致：effect 体对 `view.leaveIntent === null` 提前返回，焦点调用用可选链，
   * loading / unavailable 态下执行只是空操作（leaveIntent 恒为 null，或焦点目标尚未挂载）；
   * 依赖是 `[view.leaveIntent]`，只在离开确认打开/关闭时触发。
   */
  function useSettingsLeaveFocus(view) {
    react.useEffect(() => {
      if (view.leaveIntent === null) return;
      try { view.leaveCancelRef.current?.focus?.(); } catch {}
    }, [view.leaveIntent]);
  }

  /**
   * 设置页的保存动作（票据 31 从组件作用域外移）。
   *
   * view 就是组件每轮渲染交给渲染尾段的同一份读面/写面，因此这里读到的状态、回调和引用
   * 与渲染完全同源，不存在第二份草稿或第二套判定。保存分四个语义阶段：守卫 → 组装候选 →
   * 计算变更集 → 提交与回执归一，阶段顺序与拆分前逐字相同。
   */
  /**
   * 设置页的保存动作（票据 31 从组件作用域外移并按语义阶段拆分）。
   *
   * view 就是组件每轮渲染交给渲染尾段的同一份读面/写面，因此这里读到的状态、回调和引用
   * 与渲染完全同源，不存在第二份草稿或第二套判定。四个语义阶段：守卫 → 组装候选 → 变更集 →
   * 提交与回执归一；阶段顺序与拆分前逐字相同，只是把「计算」与「提交」分成了两个函数。
   */
  function createSettingsSaveAction(view) {
    return async ({ retry = false } = {}) => {
      const plan = deriveSettingsSavePlan(view, retry);
      if (plan === null) return false;
      return commitSettingsSavePlan(view, plan);
    };
  }

  /**
   * 保存的「守卫 + 组装候选 + 变更集」阶段；返回 null 表示被守卫或校验拦下（调用方直接返回 false）。
   */
  function deriveSettingsSavePlan(view, retry) {
    const {
      addModelPage, applyPromptNavigation, authorityValue, baselineProjection, beginModelTabDrag, cancelModelPageDelete, ctx,
      candidatesError, catalogAvailable, closePrompt, committedAuthorityRef, committedSnapshotLagging, confirmModelPageDelete,
      currentModelPage, directoryState, dismissLeaveDialog, draft, editDraft, editPromptText,
      error, externalSettingsChanged, hasUnsavedChanges, hostMeta, hostMetaError, leaveCancelRef,
      leaveIntent, leaveTriggerRef, modelConfigHost, modelFieldsChanged, modelPageCount, modelPageDeleteCancelRef,
      modelPageDeleteIntent, modelPageLabelOf, modelRowRoles, modelTabDrag, modelTabRefs, notificationEventsOpen,
      notificationEventsPanelRef, notificationEventsRootRef, notificationEventsTriggerRef, openPrompt, promptDirty, promptError,
      promptLoading, promptMaxGraphemes, promptProjection, promptRoleIds, promptTextOf, providerGroups,
      refreshHostMeta, requestModelPageDelete, roleLabelOf, roles, save, saved,
      saving, selectModelPage, selectedPromptRole, setCandidatesError, setDirty, setDraft,
      setEditorBaseline, setError, setExternalSettingsChanged, setLeaveIntent, setLocalPromptProjection, setNotificationEventsOpen,
      setPromptDrafts, setPromptError, setPromptTouched, setSaved, setSettingsConflict, settingsConflict,
      settingsForm, settingsReadOnly, settingsSnapshot, sourceDraftForSave, sourcePromptOverrides, t, tExtra, unifiedProvider,
      effectiveDraft, editorBaseline, promptTouchedRoles, setSaving,
    } = view;
        if (!hasUnsavedChanges || saving || settingsSnapshot.writable !== true) return null;
        // 票据 20：模型目录不可用只阻断「这次确实要改模型字段」的保存。与模型无关的
        // 字段（通知、任务开关、提示词、并发/超时）不依赖目录，必须照常保存——否则一次
        // 目录刷新失败就会让整页设置不可写。
        if (modelFieldsChanged && !catalogAvailable) return null;
        // 最新权威配置：快照滞后时用刚提交的 accepted（见 committedAuthorityRef）。
        const source = sourceDraftForSave;
        /**
         * 审查修复 P1：详情页提交「最新 source + 本地实际修改」，列表页保持整份草稿语义。
         *
         * 旧实现用 promptOnly 二分法：一旦提示词以外也有改动，就整份提交旧草稿，重试时
         * 还可能把外部已改的通知/降级/provider 写回旧值。合成草稿只在本地确实改过的
         * 字段上覆盖 source，因此提示词、候选、降级等修改都会保留，未修改字段沿用 source。
         */
        const normalizedDraft = effectiveDraft;
        const sourceProvider = unifiedProviderOf(source.defaults, roles, source.provider);
        // 顶层 provider 的遗留回退取自**合成草稿**（与 modelFieldsChanged 同一侧）：
        // 外部 provider 变化而本地只改了 defaults 时，绝不能拿旧 draft.provider 当回退。
        const draftProviderIntent = typeof effectiveDraft.provider === "string" ? effectiveDraft.provider : "";
        const draftProvider = unifiedProviderOf(normalizedDraft.defaults, roles, draftProviderIntent);
        // provider 的模型变化由行级 defaults 差异或用户明确改变统一选择器决定；通知字段单独
        // 保存时 draftProviderIntent 与 sourceProvider 相同，因此不会把旧顶层 provider 强行
        // 写回行级配置。目录门控与下拉同源（catalogAvailable）：缓存在手时用户从缓存里选出的
        // provider+model 是合法候选，必须能随这次保存一起提交，否则就成了"能选不能存"；
        // 反之没有任何目录时这里仍然不写，绝不凭空写入一个无法校验的 provider。
        // 判定与保存守卫/保存按钮同源（见 modelFieldsChanged），因此不存在"按钮可用但
        // save() 静默丢弃模型草稿"的分裂。
        const modelChanged = modelFieldsChanged && catalogAvailable;

        // 提示词是完整 settings 候选中的一个全局映射。只有被编辑过的角色才会从草稿
        // 覆盖 source；恢复默认通过删除对应键表达，避免把默认文本固化成冗余覆盖。
        const candidatePromptOverrides = { ...sourcePromptOverrides };
        if (promptTouchedRoles.length > 0) {
          if (promptProjection === null) {
            setPromptError(hostMetaError ?? "提示词配置加载中，请稍后重试");
            return null;
          }
          if (promptProjection.customizable !== true) {
            setPromptError("当前提示词设置为只读");
            return null;
          }
          for (const role of promptTouchedRoles) {
            const entry = promptEntryOf(baselineProjection, role);
            const text = promptTextOf(role);
            const validation = validatePromptText(text, promptMaxGraphemes);
            if (!validation.ok) {
              setPromptError(roleLabelOf(role) + "：" + validation.message);
              return null;
            }
            if (entry === null || typeof entry.defaultPersona !== "string") {
              setPromptError("提示词默认配置不可用，请刷新后重试");
              return null;
            }
            if (text === entry.defaultPersona) delete candidatePromptOverrides[role];
            else candidatePromptOverrides[role] = text;
          }
        }
        const sourceHasPromptOverrides = authorityValue !== null && authorityValue !== void 0
          && typeof authorityValue === "object"
          && Object.prototype.hasOwnProperty.call(authorityValue, "promptOverrides");
        const promptChanged = !promptOverridesEqual(candidatePromptOverrides, sourcePromptOverrides);
        const includePromptOverrides = sourceHasPromptOverrides || promptTouchedRoles.length > 0;
        /**
         * 票据 24：候选与降级上限只在**真正变化**时进入候选；校验也只覆盖本次变更
         * （未编辑角色的存量失效候选不得阻塞其它字段保存）。
         *
         * 页签草稿里的「空行」只是占位（中间层对齐用），提交前必须由
         * compactModelCandidatesDraft 按「该层该角色未配置 = 不写入」裁掉：
         * Host 会对变更角色的每一条候选做目录解析，空 selection 会被整次拒绝。
         */
        const sourceCandidates = normalizeModelCandidatesDraft(authorityValue?.candidates);
        const candidateCandidates = compactModelCandidatesDraft(normalizeModelCandidatesDraft(normalizedDraft.candidates));
        const candidatesChanged = !settingsDraftEqual(candidateCandidates, sourceCandidates);
        if (candidatesChanged) {
          const validation = validateModelCandidateRows(candidateCandidates);
          if (validation.ok !== true) { setCandidatesError(modelCandidatesErrorMessage(tExtra, roleLabelOf, validation)); return null; }
        }
        const sourceFallbackLimit = source.fallbackLimit;
        const candidateFallbackLimit = normalizedDraft.fallbackLimit;
        const fallbackLimitChanged = candidateFallbackLimit !== void 0 && candidateFallbackLimit !== sourceFallbackLimit;
        const candidate = {
          ...normalizedDraft,
          provider: modelChanged ? draftProvider : sourceProvider,
          ...(modelChanged ? {} : { defaults: source.defaults }),
          ...(includePromptOverrides ? { promptOverrides: candidatePromptOverrides } : {}),
          // 未变化的字段一律不提交：缺字段 = Host 保持已有值（旧客户端兼容语义）。
          ...(candidatesChanged ? { candidates: candidateCandidates } : {}),
          ...(fallbackLimitChanged
            ? { fallbackLimit: typeof candidateFallbackLimit === "number" ? candidateFallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT }
            : {}),
        };
        if (!candidatesChanged) delete candidate.candidates;
        if (!fallbackLimitChanged) delete candidate.fallbackLimit;
        const ops = [];
        if (modelChanged) {
          ops.push({ op: "set", path: ["provider"], value: candidate.provider });
          ops.push({ op: "set", path: ["defaults"], value: candidate.defaults });
        }
        if (candidate.notificationEnabled !== source.notificationEnabled) {
          ops.push({ op: "set", path: ["notificationEnabled"], value: candidate.notificationEnabled });
        }
        if (candidate.notificationVolume !== source.notificationVolume) {
          ops.push({ op: "set", path: ["notificationVolume"], value: candidate.notificationVolume });
        }
        // 通知事件过滤（票据 14）：三个类别是一组完整设置，只有真正变化才写 op；
        // 旧 Host 不认识该字段时会被提交端点按"未知字段"忽略，不会影响其它字段。
        if (!settingsDraftEqual(candidate.notificationEvents, source.notificationEvents)) {
          ops.push({ op: "set", path: ["notificationEvents"], value: candidate.notificationEvents });
        }
        if (candidate.observerPreferred !== source.observerPreferred) {
          ops.push({ op: "set", path: ["observerPreferred"], value: candidate.observerPreferred });
        }
        if (candidate.roleConcurrencyLimit !== source.roleConcurrencyLimit) {
          ops.push({ op: "set", path: ["roleConcurrencyLimit"], value: candidate.roleConcurrencyLimit });
        }
        // 角色默认超时（票据 06）：只有真正变化才写 op，避免一次无关保存把
        // 用户已保存的值重置回 0。
        if (candidate.roleTimeoutMs !== source.roleTimeoutMs) {
          ops.push({ op: "set", path: ["roleTimeoutMs"], value: candidate.roleTimeoutMs });
        }
        // 任务管理开关单独成一个保存 op，只用于判定「是否真的需要提交」；
        // 新客户端的完整候选始终显式携带该字段，Host 按「显式字段才写 patch」处理。
        if (candidate.taskManagementEnabled !== source.taskManagementEnabled) {
          ops.push({ op: "set", path: ["taskManagementEnabled"], value: candidate.taskManagementEnabled });
        }
        // 自动打开与任务管理同一形状：新客户端的完整候选始终显式携带该字段，
        // Host 按「显式字段才写 patch」处理，旧客户端缺字段因此不可能覆盖它。
        if (candidate.autoOpenSubagentSidebar !== source.autoOpenSubagentSidebar) {
          ops.push({ op: "set", path: ["autoOpenSubagentSidebar"], value: candidate.autoOpenSubagentSidebar });
        }
        if (promptChanged) {
          ops.push({ op: "set", path: ["promptOverrides"], value: candidatePromptOverrides });
        }
        /**
         * 变更集（票据 20，settings-commit 的可选协议字段 `changed`）。
         *
         * 顶层字段直接由 ops 推导（只有真的变化才会产生 op）；模型字段进一步细化到
         * 角色级 `defaults.<role>`，让 Host 只对真正变化的角色做真实目录解析，而不是把
         * 整份 defaults 重新解析一遍（存量失效模型因此不再阻塞无关字段的保存）。
         * 候选本身仍是**完整值**：`changed` 只描述"哪些字段变了"，不改变 replace 语义。
         */
        const changed = [];
        if (modelChanged) {
          // 顶层统一供应商只在值真的变了时报出（模型解析本身不需要它，它只是模型字段）。
          if (candidate.provider !== sourceProvider) changed.push("provider");
          for (const role of Object.keys(candidate.defaults)) {
            if (!settingsDraftEqual(candidate.defaults[role], source.defaults[role])) changed.push("defaults." + role);
          }
          // 被删除的角色默认行同样是一次模型变更（defaults 是整份映射替换）：列出来才能让
          // Host 区分「没有模型变更」与「删掉了一行」。
          for (const role of Object.keys(source.defaults)) {
            if (!Object.prototype.hasOwnProperty.call(candidate.defaults, role)) changed.push("defaults." + role);
          }
        }
        for (const op of ops) {
          const field = op.path[0];
          // provider/defaults 已按上面的模型字段粒度上报，避免同一变更重复出现。
          if (field === "defaults" || field === "provider") continue;
          changed.push(field);
        }
        // 票据 24：候选变更按角色上报（candidates + candidates.<role>），Host 因此只解析
        // 真正变化的角色；fallbackLimit 只在值真的变了才上报。
        if (candidatesChanged) {
          changed.push("candidates");
          for (const role of new Set([...Object.keys(candidateCandidates), ...Object.keys(sourceCandidates)])) {
            if (!settingsDraftEqual(candidateCandidates[role] ?? null, sourceCandidates[role] ?? null)) changed.push("candidates." + role);
          }
        }
        if (fallbackLimitChanged) changed.push("fallbackLimit");
        /**
         * 详情页的首次提交固定使用进入编辑器的 revision（审查修复 P1），不再只对提示词生效。
         *
         * 这样外部 revision 推进一定会先触发 CAS 冲突，而不是被实时 revision「追上」后
         * 静默覆盖外部修改；明确重试时才使用当前 snapshot revision（用户已看到冲突）。
         */
        const expectedRevision = retry === true || selectedPromptRole === null || !Number.isSafeInteger(editorBaseline?.revision)
          ? settingsSnapshot.revision
          : editorBaseline.revision;
    return {
      candidate, candidateCandidates, candidateFallbackLimit, candidatePromptOverrides, candidatesChanged, changed,
      expectedRevision, fallbackLimitChanged, ops, source, sourceCandidates, sourceFallbackLimit,
    };
  }

  /**
   * 保存的「提交 + 回执归一」阶段：调用 DEG 自有提交端点、合并 accepted 草稿、更新编辑基线。
   */
  async function commitSettingsSavePlan(view, plan) {
    const {
      addModelPage, applyPromptNavigation, authorityValue, baselineProjection, beginModelTabDrag, cancelModelPageDelete,
      candidatesError, catalogAvailable, closePrompt, committedAuthorityRef, committedSnapshotLagging, confirmModelPageDelete,
      currentModelPage, directoryState, dismissLeaveDialog, draft, editDraft, editPromptText,
      error, externalSettingsChanged, hasUnsavedChanges, hostMeta, hostMetaError, leaveCancelRef,
      leaveIntent, leaveTriggerRef, modelConfigHost, modelFieldsChanged, modelPageCount, modelPageDeleteCancelRef,
      modelPageDeleteIntent, modelPageLabelOf, modelRowRoles, modelTabDrag, modelTabRefs, notificationEventsOpen,
      notificationEventsPanelRef, notificationEventsRootRef, notificationEventsTriggerRef, openPrompt, promptDirty, promptError,
      promptLoading, promptMaxGraphemes, promptProjection, promptRoleIds, promptTextOf, providerGroups,
      refreshHostMeta, requestModelPageDelete, roleLabelOf, roles, save, saved,
      saving, selectModelPage, selectedPromptRole, setCandidatesError, setDirty, setDraft,
      setEditorBaseline, setError, setExternalSettingsChanged, setLeaveIntent, setLocalPromptProjection, setNotificationEventsOpen,
      setPromptDrafts, setPromptError, setPromptTouched, setSaved, setSettingsConflict, settingsConflict,
      settingsForm, settingsReadOnly, settingsSnapshot, sourceDraftForSave, sourcePromptOverrides, t, tExtra, unifiedProvider,
      ctx, effectiveDraft, editorBaseline, promptTouchedRoles, setSaving,
    } = view;
    const {
      candidate, candidateCandidates, candidateFallbackLimit, candidatePromptOverrides, candidatesChanged,
      changed, expectedRevision, fallbackLimitChanged, ops, source, sourceCandidates, sourceFallbackLimit,
    } = plan;

        setSaving(true);
        setSaved(false);
        setError(null);
        setPromptError(null);
        try {
          let accepted;
          let committed = null;
          // 票据 24：候选/降级不在 ops 里（它们不是默认值 op），但同样需要真实提交；
          // 任一特殊字段变化都必须走 settings-commit，而不是只把快照当成已保存。
          if (ops.length > 0 || candidatesChanged || fallbackLimitChanged) {
            // 角色配置唯一写入路径：DEG 自有提交端点（Host commitSettingsCandidate 完成
            // schema、语义与 revision CAS 校验）。绝不调用配置表单的 set/unset/mutate：
            // 那会绕过 DEG 的提示词语义校验与模型目录代次检测。
            // 共享镜像会随 settings/document-updated 自行刷新，无需本地推进 revision。
            committed = await commitSettingsCandidate(candidate, expectedRevision, globalThis.fetch, ctx?.connection, roles, changed);
            accepted = committed.settings;
          } else {
            accepted = normalizeSettingsCommitDraft(settingsForm.getSnapshot().value, roles);
          }
          // Host 已在同一提交边界完成 schema、模型和 revision 校验；200 响应中的
          // committed settings 是权威归一结果，不再与客户端草稿做易误报的 JSON 全量比较。
          // 响应里的 promptOverrides 可能被归一函数按**旧角色表**裁剪过：
          // 以本次候选为基底合并，保证刚保存的提示词覆盖不被丢弃。
          const acceptedPromptOverrides = normalizePromptOverrides(
            Object.prototype.hasOwnProperty.call(accepted ?? {}, "promptOverrides")
              ? { ...candidatePromptOverrides, ...accepted.promptOverrides }
              : candidatePromptOverrides,
            promptMaxGraphemes,
            promptRoleIds,
          );
          /**
           * Host 只回显本次真正写入的字段（未变化的字段被删掉），
           * 因此保存成功后要为新字段回落本次候选/源值，避免控件在下一次 settings
           * 快照到达前短暂变空——那会让用户以为自己的配置被抹掉了。
           */
          const acceptedDraft = accepted !== null && typeof accepted === "object" ? { ...accepted } : accepted;
          if (acceptedDraft !== null && typeof acceptedDraft === "object") {
            const keepNewField = (field, hadField, value) => {
              if (Object.prototype.hasOwnProperty.call(acceptedDraft, field)) return;
              if (hadField !== true) return;
              acceptedDraft[field] = value;
            };
            // 候选与降级上限（票据 24）：Host 只回显本次真正写入的字段，详情页的候选
            // 不能因此在快照追上之前短暂清空（沿用上面同一个 keepNewField 模式）。
            keepNewField("candidates",
              candidatesChanged || Object.prototype.hasOwnProperty.call(source, "candidates"),
              candidatesChanged ? candidateCandidates : sourceCandidates);
            keepNewField("fallbackLimit",
              fallbackLimitChanged || Object.prototype.hasOwnProperty.call(source, "fallbackLimit"),
              fallbackLimitChanged
                ? (typeof candidateFallbackLimit === "number" ? candidateFallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT)
                : sourceFallbackLimit);
          }
          setDraft(acceptedDraft);
          setPromptDrafts({});
          setPromptTouched({});
          setCandidatesError(null);
          const committedRevision = Number.isSafeInteger(committed?.revision)
            ? committed.revision
            : settingsSnapshot.revision;
          /**
           * 审查修复 P2：记录本次成功提交的权威文档。
           *
           * 共享镜像可能滞后于提交响应；滞后期间 dirty 比较、保存按钮与同步 effect
           * 都以这份 accepted 草稿为准，避免"刚保存就重新变脏"或旧快照把草稿重置。
           */
          committedAuthorityRef.current = { revision: committedRevision, value: acceptedDraft };
          const responseProjection = normalizeRolePromptProjection(committed?.rolePrompts, accepted, true, promptRoleIds);
          let acceptedProjection = responseProjection ?? promptProjection;
          if (acceptedProjection !== null) {
            for (const role of promptTouchedRoles) {
              const entry = promptEntryOf(acceptedProjection, role);
              const text = Object.prototype.hasOwnProperty.call(acceptedPromptOverrides, role)
                ? acceptedPromptOverrides[role]
                : entry?.defaultPersona ?? promptTextOf(role);
              acceptedProjection = updateRolePromptProjection(acceptedProjection, role, text);
            }
            setLocalPromptProjection({ revision: committedRevision, projection: acceptedProjection });
          }
          if (selectedPromptRole !== null) {
            // 提交响应已经是 Host 权威状态，立即更新编辑基线；共享镜像随后自行刷新，
            // 直到更高或相等的外部 snapshot 到达后再自然让位。不依赖投影是否可用：
            // 投影缺失时提示词区只读，但候选/降级等草稿仍需要正确的比较基线。
            setEditorBaseline({
              role: selectedPromptRole,
              // 与 setDraft 用同一份文档：keepNewField 补齐的字段也属于基线，
              // 否则"刚保存的候选"会被基线与草稿比较误判成本地改动。
              value: acceptedDraft,
              revision: committedRevision,
              projection: acceptedProjection ?? editorBaseline?.projection ?? null,
            });
          }
          setSettingsConflict(null);
          setExternalSettingsChanged(false);
          setDirty(false);
          setSaved(true);
          return true;
        } catch (cause) {
          // 冲突后绝不伪装“已同步”：必须等待共享镜像提供最新完整 snapshot，
          // 再由用户选择加载或明确重试，避免 revision 已变而候选仍是旧文档。
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message);
          if (cause?.code === "settings-conflict") {
            setSettingsConflict({ revision: cause.currentRevision, message });
          }
          if (promptTouchedRoles.length > 0) setPromptError(message);
          return false;
        } finally {
          setSaving(false);
        }
  }

  /**
   * 模型页签的纯 UI 动作（切页 / 新建候选页 / 删除确认）：只碰草稿与本地 UI 状态，
   * 不发请求、不落盘；从组件作用域外移（票据 31），行为与拆分前逐字相同。
   */
  function createModelPageActions(view) {
    const {
      editDraft, MAX_MODEL_PAGES, modelPageCount, modelPageDeleteIntent, modelTabSuppressClickRef, saving,
      setModelPageDeleteIntent, setSelectedModelPage, settingsReadOnly,
    } = view;

      /** 切换页签：纯 UI 状态（不写草稿、不落盘）。 */
      const selectModelPage = (page) => {
        if (modelTabSuppressClickRef.current === true) return;
        if (!Number.isSafeInteger(page) || page < 0 || page >= modelPageCount) return;
        setSelectedModelPage(page);
      };
      /** 「+」新建候选页：深拷贝主模型页的选择，并立刻切到新页。 */
      const addModelPage = () => {
        if (saving || settingsReadOnly || modelPageCount >= MAX_MODEL_PAGES) return;
        const nextIndex = modelPageCount;
        editDraft((previous) => addModelCandidatePage(previous));
        setSelectedModelPage(nextIndex);
      };
      /** 打开删除确认框：只有候选页有 ×，主模型页不可删除。 */
      const requestModelPageDelete = (page) => {
        if (saving || settingsReadOnly || !Number.isSafeInteger(page) || page < 1) return;
        setModelPageDeleteIntent({ page });
      };
      const cancelModelPageDelete = () => {
        setModelPageDeleteIntent(null);
      };
      /** 确认删除：所有角色同步删掉该索引项；删除当前页后回到主模型页。 */
      const confirmModelPageDelete = () => {
        const intent = modelPageDeleteIntent;
        if (intent === null) return;
        setModelPageDeleteIntent(null);
        editDraft((previous) => removeModelCandidatePage(previous, intent.page));
        setSelectedModelPage((previous) => (previous === intent.page
          ? 0
          : previous > intent.page ? previous - 1 : previous));
      };

    return {
      addModelPage, cancelModelPageDelete, confirmModelPageDelete, requestModelPageDelete, selectModelPage,
    };
  }

  /**
   * 页签拖动的指针手势控制器（自研 pointer 事件，不引入第三方依赖）：阈值判定、落点计算、
   * 松手重排与监听清理都封在这里；卸载清理仍由组件里的 effect 调用 detach。
   */
  function createModelTabDragController(view) {
    const {
      editDraft, modelPageCount, modelTabDragRef, modelTabRefs, modelTabSuppressClickRef, saving,
      setModelTabDrag, setSelectedModelPage, settingsReadOnly,
    } = view;

      /**
       * 页签拖动的指针手势（自研 pointer 事件，不引入第三方依赖）。
       *
       * 交互边界：
       * - 指针移动超过 4px 才进入拖拽，pointerdown 本身仍是普通点击；
       * - 拖动期间只更新落点指示，**不**切换当前页（切页只由 click 触发）；
       * - 松手时按插入边界整层重排：主模型页也能拖，落点决定新位置，其余页顺移；
       * - pointercancel 或卸载一律取消本次拖动，不写草稿。
       */
      const MODEL_TAB_DRAG_THRESHOLD = 4;
      /** 指针 x → 插入边界（0..页数）：落在某个页签前半区就插在它前面。 */
      const modelTabDropIndexOf = (clientX) => {
        const refs = modelTabRefs.current ?? {};
        for (let page = 0; page < modelPageCount; page += 1) {
          const element = refs[page];
          const rect = typeof element?.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
          if (rect === null || rect === void 0) continue;
          const left = Number(rect.left);
          const width = Number(rect.width);
          // 无布局信息（测试替身/隐藏容器）时跳过：落点退化为"不移动"，绝不猜一个位置。
          if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) continue;
          if (Number(clientX) < left + width / 2) return page;
        }
        return modelPageCount;
      };
      const beginModelTabDrag = (page, event) => {
        if (saving || settingsReadOnly) return;
        if (event === null || typeof event !== "object") return;
        // 只响应主键：右键/中键不进入拖拽，也不抢浏览器菜单。
        if (typeof event.button === "number" && event.button !== 0) return;
        const doc = typeof document === "undefined" ? null : document;
        if (doc === null || typeof doc.addEventListener !== "function") return;
        const startX = Number(event.clientX);
        const startY = Number(event.clientY);
        if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;
        const session = { page, startX, startY, active: false, dropIndex: page, detach: null };
        const onMove = (moveEvent) => {
          const current = modelTabDragRef.current;
          if (current === null) return;
          const x = Number(moveEvent?.clientX);
          const y = Number(moveEvent?.clientY);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (current.active !== true) {
            // 阈值内仍算点击：不 preventDefault，页签的 click 事件照常到达。
            if (Math.abs(x - current.startX) + Math.abs(y - current.startY) < MODEL_TAB_DRAG_THRESHOLD) return;
            current.active = true;
            modelTabSuppressClickRef.current = true;
          }
          // 只有真正进入拖拽后才阻止默认行为（文本选择/触屏滚动）。
          moveEvent?.preventDefault?.();
          current.dropIndex = modelTabDropIndexOf(x);
          setModelTabDrag({ page: current.page, dropIndex: current.dropIndex, active: true });
        };
        const onEnd = (endEvent) => {
          const current = modelTabDragRef.current;
          modelTabDragRef.current = null;
          try {
            doc.removeEventListener("pointermove", onMove);
            doc.removeEventListener("pointerup", onEnd);
            doc.removeEventListener("pointercancel", onEnd);
          } catch { /* 监听清理失败不影响后续手势。 */ }
          setModelTabDrag(null);
          if (current === null || current.active !== true) {
            // 未越过阈值：这是一次点击，交给 click 处理（绝不写草稿）。
            modelTabSuppressClickRef.current = false;
            return;
          }
          endEvent?.preventDefault?.();
          const from = current.page;
          // 插入边界 → 目标页：移走自己后，右侧边界整体左移一位；取消手势落回原页。
          const target = endEvent?.type === "pointercancel"
            ? from
            : (current.dropIndex > from ? current.dropIndex - 1 : current.dropIndex);
          if (target !== from) {
            editDraft((previous) => reorderModelLayers(previous, from, target));
            setSelectedModelPage(target);
          }
          // click 在 pointerup 之后派发：用一次宏任务清掉抑制标记，避免误切页签。
          if (typeof globalThis?.setTimeout === "function") globalThis.setTimeout(() => { modelTabSuppressClickRef.current = false; }, 0);
          else modelTabSuppressClickRef.current = false;
        };
        doc.addEventListener("pointermove", onMove);
        doc.addEventListener("pointerup", onEnd);
        doc.addEventListener("pointercancel", onEnd);
        session.detach = () => {
          doc.removeEventListener("pointermove", onMove);
          doc.removeEventListener("pointerup", onEnd);
          doc.removeEventListener("pointercancel", onEnd);
        };
        modelTabDragRef.current = session;
      };
    return { beginModelTabDrag };
  }

/**
 * 文案函数绑定（票据 39）：把 locale 固定进一个 (key, vars) => string。
 *
 * 这些单行箭头本来直接写在组件体里，使 DshExpertGroupSettings 的「单闭包内函数数」到 48。
 * 它们不持有状态、只依赖一个显式参数，因此提到模块级工厂，组件内只保留一次绑定。
 *
 * @param {string} locale 已解析的界面语言。
 * @returns {(key: string, vars?: object) => string}
 */
function bindSettingsText(locale) {
  return (key, vars) => settingsText(locale, key, vars);
}

/** 扩展文案绑定（同上）。 @param {string} locale @returns {(key: string, vars?: object) => string} */
function bindSettingsExtraText(locale) {
  return (key, vars) => settingsExtraText(locale, key, vars);
}

/**
 * 角色显示名解析：Host meta.roleLabels 优先，缺失时回落内置静态表。
 *
 * @param {object|null|undefined} roleLabels Host 提供的角色显示名映射。
 * @returns {(role: string) => string}
 */
function bindRoleLabelOf(roleLabels) {
  return (role) => {
    const label = roleLabels?.[role];
    return typeof label === "string" && label.length > 0 ? label : (SETTINGS_ROLE_LABELS[role] ?? role);
  };
}

/**
 * 提示词编辑器取文本：已触碰的角色用草稿，否则用当前投影的生效值。
 *
 * @param {object} promptDrafts 已编辑的草稿文本（按角色）。
 * @param {object|null} baselineProjection 进入编辑时固定的提示词投影。
 * @returns {(role: string) => string}
 */
function bindPromptTextOf(promptDrafts, baselineProjection) {
  return (role) => {
    if (Object.prototype.hasOwnProperty.call(promptDrafts, role)) return promptDrafts[role];
    return promptEntryOf(baselineProjection, role)?.effective ?? "";
  };
}

/**
 * 模型页签名称：第一页恒为「主模型」，其余按候选序号（只由位置推导）。
 *
 * @param {Function} tExtra 扩展文案函数。
 * @returns {(page: number) => string}
 */
function bindModelPageLabelOf(tExtra) {
  return (page) => (page === 0
    ? tExtra("settings.modelTabs.primary")
    : tExtra("settings.modelTabs.candidate", { index: page }));
}

/**
 * 「通知事件」下拉的关闭面（票据 39 从 effect body 提出）。
 *
 * Escape、点击面板外部（文档级 mousedown）与再次点击触发按钮三条入口共用同一个关闭动作；
 * 只在展开期间注册监听，嵌入宿主或测试环境没有 document 时不注册、不抛错。关闭后把焦点
 * 还给触发按钮。返回卸载函数，由调用方的 useEffect 负责调用时机（依赖仍只有展开态）。
 *
 * @param {object} context
 * @param {boolean} context.isOpen 下拉是否展开。
 * @param {object} context.rootRef 用于「点击外部」判定的根 ref。
 * @param {object} context.triggerRef 触发按钮 ref（关闭后还焦点）。
 * @param {Function} context.setOpen 展开态 setter。
 * @returns {Function|undefined} 清理函数；未展开/无 document 时为 undefined。
 */
function bindNotificationEventsDismiss({ isOpen, rootRef, triggerRef, setOpen }) {
  if (!isOpen) return undefined;
  const restoreTriggerFocus = () => {
    try { triggerRef.current?.focus?.(); } catch { /* 无 DOM 的宿主忽略 */ }
  };
  const closeAndRestoreFocus = () => {
    setOpen(false);
    restoreTriggerFocus();
  };
  const onPointerDown = (event) => {
    const root = rootRef.current;
    const target = event?.target;
    // 面板与触发按钮都在 root 内；点它们不关闭（按钮自身的 onClick 负责切换）。
    if (root !== null && root !== void 0 && typeof root.contains === "function"
      && target !== null && target !== void 0 && root.contains(target)) return;
    closeAndRestoreFocus();
  };
  const onKeyDown = (event) => {
    if (event?.key !== "Escape") return;
    event.preventDefault?.();
    closeAndRestoreFocus();
  };
  const doc = typeof document === "undefined" ? null : document;
  if (doc === null || typeof doc.addEventListener !== "function") return undefined;
  doc.addEventListener("mousedown", onPointerDown);
  doc.addEventListener("keydown", onKeyDown);
  return () => {
    doc.removeEventListener?.("mousedown", onPointerDown);
    doc.removeEventListener?.("keydown", onKeyDown);
  };
}

    /**
     * 专家设置页。
     *
     * `settingsForm` 是 `configForms.get("dsh-expert-group")` 返回的配置表单：与旧 scope 快照
     * 同形状（status/value/base/user/revision/writable/mode），只用于**读取与订阅**。
     * 角色配置的保存一律走 DEG 自有提交端点（settings-commit → Host commitSettingsCandidate），
     * 绝不调用表单的 set/unset/mutate：那会绕过 DEG 的语义校验与目录代次检测。
     */
    function DshExpertGroupSettings({ settingsForm, modelCatalog, modelConfigHost, ctx }) {
      const subscribe = react.useMemo(() => settingsForm.subscribe.bind(settingsForm), [settingsForm]);
      const getSnapshot = react.useMemo(() => settingsForm.getSnapshot.bind(settingsForm), [settingsForm]);
      const settingsSnapshot = react.useSyncExternalStore(subscribe, getSnapshot);
      const catalogSubscribe = react.useMemo(() => modelCatalog.subscribe.bind(modelCatalog), [modelCatalog]);
      const catalogGetSnapshot = react.useMemo(() => modelCatalog.getSnapshot.bind(modelCatalog), [modelCatalog]);
      const directoryState = react.useSyncExternalStore(catalogSubscribe, catalogGetSnapshot);
      // 宿主 meta 同时提供角色表、提示词投影与运行诊断；因此这里不新增
      // 任何 RPC/轮询，也不会因为打开设置页而触碰通知权限或专家任务。
      const [hostMeta, refreshHostMeta, hostMetaError] = useHostMeta(ctx);
      const roles = useEnabledSettingsRoles(hostMeta);
      // 文案层（票据 19）：语言按宿主注入面解析一次；同一渲染内所有核心控件共用。
      const uiLocale = resolveSettingsLocale(ctx);
      const t = bindSettingsText(uiLocale);
      // 票据 24 新增区块的文案：本地 zh/en 表（权威消息表不在本票据的文件边界内）。
      const tExtra = bindSettingsExtraText(uiLocale);
      // 角色显示名以 Host meta.roleLabels 为准；缺失时回落内置静态表。
      const roleLabelOf = bindRoleLabelOf(hostMeta?.roleLabels);
      /**
       * 提示词编辑器的角色集合：Host 投影自己声明的 roles（只应是内置六角色）。
       * 未拿到投影时沿用内置六角色；因此旧 Host/旧夹具的按钮集合与语义完全不变。
       */
      const promptRoleIds = react.useMemo(() => {
        const declared = hostMeta?.rolePrompts?.roles;
        if (!Array.isArray(declared)) return PROMPT_ROLE_IDS;
        const roles = declared.filter((role) => typeof role === "string" && role.length > 0);
        return roles.length > 0 ? roles : PROMPT_ROLE_IDS;
      }, [hostMeta]);
      const hostPromptProjection = react.useMemo(
        () => normalizeRolePromptProjection(hostMeta?.rolePrompts, settingsSnapshot.value, true, promptRoleIds),
        [hostMeta, settingsSnapshot.value, promptRoleIds],
      );
      react.useEffect(() => {
        void modelCatalog.load();
      }, [modelCatalog]);
      const [draft, setDraft] = react.useState(() => normalizeSettingsDraft(settingsSnapshot.value, roles));
      const [candidatesError, setCandidatesError] = react.useState(null);
      /**
       * 模型页签的纯 UI 状态（绝不落盘）。
       *
       * - selectedModelPage：当前页（默认 0 = 主模型页），刷新/重挂载后回到主模型页；
       * - modelTabDrag：拖动反馈（是否在拖 + 插入边界），只影响渲染；
       * - modelPageDeleteIntent：删除候选页的确认框目标页，null = 未打开；
       * - 指针会话的原始数据放 ref：pointermove 高频，且拖动期间的中间值不参与渲染；
       * - modelTabSuppressClickRef：拖动结束后抑制一次 click，避免"松手同时切页"。
       */
      const [selectedModelPage, setSelectedModelPage] = react.useState(0);
      const [modelTabDrag, setModelTabDrag] = react.useState(null);
      const [modelPageDeleteIntent, setModelPageDeleteIntent] = react.useState(null);
      const modelTabRefs = react.useRef({});
      const modelTabDragRef = react.useRef(null);
      const modelTabSuppressClickRef = react.useRef(false);
      const modelPageDeleteCancelRef = react.useRef(null);
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const [selectedPromptRole, setSelectedPromptRole] = react.useState(null);
      const [promptDrafts, setPromptDrafts] = react.useState(() => ({}));
      const [promptTouched, setPromptTouched] = react.useState({});
      const [promptError, setPromptError] = react.useState(null);
      // 成功提交后共享镜像可能短暂滞后，临时投影只在其 revision 更高时生效；
      // snapshot 追上后立即回到 Host/meta + snapshot 的派生视图，绝不永久缓存旧结果。
      const [localPromptProjection, setLocalPromptProjection] = react.useState(null);
      const [editorBaseline, setEditorBaseline] = react.useState(null);
      const [settingsConflict, setSettingsConflict] = react.useState(null);
      const [externalSettingsChanged, setExternalSettingsChanged] = react.useState(false);
      const [leaveIntent, setLeaveIntent] = react.useState(null);
      const leaveTriggerRef = react.useRef(null);
      const leaveCancelRef = react.useRef(null);
      /**
       * 「通知事件」多选下拉的展开态（布局调整）：三个类别固定，展开只影响菜单可见性，
       * 绝不写入草稿；勾选变化仍只走 editDraft → draft.notificationEvents。
       * root/trigger/panel 三个 ref 分别用于"点击外部"判定、关闭后还焦点、打开后聚焦首项。
       */
      const [notificationEventsOpen, setNotificationEventsOpen] = react.useState(false);
      const notificationEventsRootRef = react.useRef(null);
      const notificationEventsTriggerRef = react.useRef(null);
      const notificationEventsPanelRef = react.useRef(null);
      const promptProjection = localPromptProjection !== null
        && Number.isSafeInteger(localPromptProjection.revision)
        && localPromptProjection.revision > settingsSnapshot.revision
        ? localPromptProjection.projection
        : hostPromptProjection;
      // 编辑期间固定 rolePrompts + settings revision：外部快照只能提示变化，不能悄悄
      // 改写正在编辑的默认值或把首次 CAS 提交升级为最新 revision。
      const baselineProjection = editorBaseline?.role === selectedPromptRole
        ? editorBaseline.projection
        : promptProjection;
      const promptMaxGraphemes = baselineProjection?.maxGraphemes ?? DEFAULT_PROMPT_MAX_GRAPHEMES;
      // 整页写权限的唯一来源是快照的 writable（远端 memory 模式永远不可写）。
      // 旧 scope 时代的 `status === "readonly"` 分支已删除：新契约的 status 只有
      // loading/ready/unavailable 三个取值，readonly 语义已由 writable 完整表达。
      const settingsReadOnly = settingsSnapshot.writable !== true;
      // meta 尚未返回才是加载中；meta 已返回但 rolePrompts 缺失属于 wire 不兼容，
      // 必须显示错误而不能让用户永久等待空编辑器。
      const promptLoading = hostMeta === null && hostMetaError === null;
      const promptTextOf = bindPromptTextOf(promptDrafts, baselineProjection);
      const promptTouchedRoles = Object.keys(promptTouched).filter((role) => promptRoleIds.includes(role));
      const promptDirty = baselineProjection !== null && promptRoleIds.some((role) => {
        if (!Object.prototype.hasOwnProperty.call(promptTouched, role)) return false;
        const entry = promptEntryOf(baselineProjection, role);
        return entry !== null && promptTextOf(role) !== entry.effective;
      });
      /**
       * 保存成功但共享镜像尚未追上时的权威值（审查修复 P2）。
       *
       * 共享镜像（settings/document-updated）可能滞后：此时若继续拿旧 snapshot 比较或
       * 重建草稿，刚保存的候选会被重置回去、页面也会立刻重新变脏。这里只记录最近一次
       * 成功提交的 revision 与 accepted 归一草稿，snapshot 追上后自动让位。
       */
      const committedAuthorityRef = react.useRef(null);
      const committedSnapshotLagging = committedAuthorityRef.current !== null
        && Number.isSafeInteger(committedAuthorityRef.current.revision)
        && (!Number.isSafeInteger(settingsSnapshot.revision)
          || settingsSnapshot.revision < committedAuthorityRef.current.revision);
      const authorityValue = committedSnapshotLagging ? committedAuthorityRef.current.value : settingsSnapshot.value;
      // 提示词覆盖同样以权威值为基底：保存成功后快照滞后时，旧 snapshot 的覆盖会把
      // 上一次刚提交的覆盖写回旧值（promptOverrides 是整份映射 replace）。
      const sourcePromptOverrides = normalizePromptOverrides(authorityValue?.promptOverrides, promptMaxGraphemes, promptRoleIds);
      // 共享一个 saved dirty 判定：模型/通知的既有草稿与提示词草稿可以独立变回基线，
      // 不把“曾经编辑过”误判为仍需提交，也不影响任务管理等历史控件的保存语义。
      // 比较对象是 authorityValue：刚提交而快照滞后时，用 accepted 草稿而不是旧快照，
      // 否则保存成功后会立刻被判成"仍有未保存修改"。
      const localDraft = normalizeSettingsDraft(draft, roles, false);
      const sourceDraftForDirty = normalizeSettingsDraft(authorityValue, roles, false);
      const settingsDirty = !settingsDraftEqual(localDraft, sourceDraftForDirty);
      const hasUnsavedChanges = settingsDirty || promptDirty;
      /**
       * 详情页与列表页共用同一份"有未保存修改"判定（审查修复 P1）。
       *
       * 详情页里的候选、降级上限、通知、模型等任何本地草稿都算修改：保存按钮、应用内
       * 离开确认与 beforeunload 因此不会漏掉提示词以外的字段。
       */
      const editorHasUnsavedChanges = hasUnsavedChanges;
      /**
       * 详情页保存的合成草稿（审查修复 P1）：最新 source + 本地相对编辑基线的差异。
       *
       * 详情页保存不再整份提交旧草稿，也不再用 source 整份替换：只有相对进入编辑器
       * （或上次成功保存）确实变化的字段才覆盖到最新 source，外部已改、本次未动的字段
       * 一律沿用 source。列表页保持既有整份草稿语义不变。
       */
      const sourceDraftForSave = normalizeSettingsDraft(authorityValue, roles);
      const editorEntryValue = selectedPromptRole !== null && editorBaseline?.role === selectedPromptRole
        ? editorBaseline.value
        : authorityValue;
      const editorEntryDraft = normalizeSettingsDraft(editorEntryValue, roles, false);
      // 详情页保存用「最新 source + 本地相对编辑基线的差异」合成草稿；列表页保持整份草稿语义。
      const effectiveDraft = selectedPromptRole !== null
        ? mergeSettingsDraftOverSource(sourceDraftForSave, localDraft, editorEntryDraft)
        : localDraft;
      /**
       * 本次草稿是否要改动「模型字段」（统一供应商 / 角色默认模型）——票据 20。
       *
       * 保存守卫、保存按钮与 settings-commit 的变更集共用**同一个**判定，避免出现
       * 「按钮禁用但 save() 允许」这类分裂：
       * - 判定对象是最终要提交的合成草稿（effectiveDraft）：只改提示词/候选时模型字段
       *   等于最新 source，因此不算模型字段变更；
       * - 顶层统一供应商或任一角色行级 defaults 与已保存快照不同即为变更；
       * - 模型目录不可用时**只有它为真**才阻断保存：通知、任务开关、提示词、并发/超时
       *   等与模型无关的字段必须照常保存。模型下拉本身已按目录可用性禁用，用户不可能
       *   在没有目录的情况下做出新的模型草稿，因此这里判定草稿差异而不是操作来源。
       */
      const modelFieldsChanged = react.useMemo(() => {
        if (!settingsDraftEqual(effectiveDraft.defaults, sourceDraftForSave.defaults)) return true;
        // 两侧都用各自草稿里的顶层 provider 作遗留回退，避免"本地未改 provider"被
        // 误判成模型字段变更（详情页合并后 effectiveDraft.provider 就是最新 source 的值）。
        return unifiedProviderOf(effectiveDraft.defaults, roles, effectiveDraft.provider)
          !== unifiedProviderOf(sourceDraftForSave.defaults, roles, sourceDraftForSave.provider);
      }, [effectiveDraft, sourceDraftForSave, roles]);

      react.useEffect(() => {
        if (dirty) return;
        // 已提交但共享镜像尚未追上：accepted 草稿才是权威，绝不用旧 snapshot 覆盖它
        // （否则候选会短暂消失、通知/降级等刚保存的值也会回退）。
        if (committedSnapshotLagging) return;
        setDraft(normalizeSettingsDraft(authorityValue, roles));
        // 未编辑角色必须继续从 Host rolePrompts 读 effective 值；不能仅按 settings
        // snapshot 填空对象，否则无覆盖时会把默认 persona 显示成空文本。
        setPromptDrafts({});
        setPromptTouched({});
        setPromptError(null);
        setCandidatesError(null);
      }, [dirty, settingsSnapshot.value, settingsSnapshot.revision, roles, promptMaxGraphemes, committedSnapshotLagging, authorityValue]);

      react.useEffect(() => {
        if (selectedPromptRole === null || editorBaseline?.role !== selectedPromptRole) return;
        if (editorBaseline.projection === null && hostPromptProjection !== null) {
          // 只补齐进入编辑器后异步返回的投影，保留 captureEditorBaseline 锁定的
          // settings value/revision，防止 meta 延迟期间的外部提交绕过首次 CAS。
          setEditorBaseline((previous) => previous?.role === selectedPromptRole && previous.projection === null
            ? { ...previous, projection: hostPromptProjection }
            : previous);
          return;
        }
        // 提交响应的 revision 高于滞后镜像时，响应是当前权威基线；
        // 不能被旧 meta 投影再次回写。
        if (Number.isSafeInteger(localPromptProjection?.revision)
          && localPromptProjection.revision > settingsSnapshot.revision) return;
        if (!Number.isSafeInteger(settingsSnapshot.revision)) return;
        if (settingsSnapshot.revision === editorBaseline.revision) return;
        // 快照落后于编辑基线（刚提交、共享镜像还在路上）：等它追上，绝不用旧快照重建。
        if (Number.isSafeInteger(editorBaseline.revision) && settingsSnapshot.revision < editorBaseline.revision) return;
        if (hasUnsavedChanges || dirty) {
          // 本地有未保存修改（提示词、候选或任何列表草稿）：只提示外部版本变化，
          // 绝不重建 draft/清 dirty，否则候选或提示词以外的草稿会被静默丢弃。
          setExternalSettingsChanged(true);
          return;
        }
        const refreshedProjection = hostPromptProjection;
        if (refreshedProjection === null) {
          setExternalSettingsChanged(true);
          return;
        }
        // 没有本地草稿时以最新完整 snapshot 重建编辑基线，圆点与有效内容同步更新。
        setLocalPromptProjection(null);
        setEditorBaseline({
          role: selectedPromptRole,
          value: settingsSnapshot.value,
          revision: settingsSnapshot.revision,
          projection: refreshedProjection,
        });
        setDraft(normalizeSettingsDraft(settingsSnapshot.value, roles));
        setPromptDrafts({});
        setPromptTouched({});
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      }, [selectedPromptRole, editorBaseline, localPromptProjection, settingsSnapshot.revision, settingsSnapshot.value, hostPromptProjection, hasUnsavedChanges, dirty, roles]);

      react.useEffect(() => {
        if (selectedPromptRole === null || !editorHasUnsavedChanges) return;
        // 同文档的角色/列表切换由上面的应用内确认处理；这里仅覆盖刷新、关闭和浏览器
        // 返回等跨文档离开。浏览器决定原生提示文案，且可能不拦截某些生命周期终止路径。
        const target = typeof globalThis?.addEventListener === "function"
          ? globalThis
          : (typeof globalThis?.window?.addEventListener === "function" ? globalThis.window : null);
        if (target === null) return;
        const onBeforeUnload = (event) => {
          event.preventDefault?.();
          event.returnValue = "";
          return "";
        };
        target.addEventListener("beforeunload", onBeforeUnload);
        return () => target.removeEventListener?.("beforeunload", onBeforeUnload);
      }, [selectedPromptRole, editorHasUnsavedChanges]);

      /**
       * 「通知事件」下拉的关闭面：Escape、点击面板外部（文档级 mousedown）与再次点击触发按钮。
       *
       * 只在展开期间注册监听；嵌入宿主或测试环境没有 document 时不注册、不抛错。
       * 关闭后把焦点还给触发按钮，键盘用户不会掉到页面开头。
       */
      react.useEffect(() => bindNotificationEventsDismiss({
        isOpen: notificationEventsOpen,
        rootRef: notificationEventsRootRef,
        triggerRef: notificationEventsTriggerRef,
        setOpen: setNotificationEventsOpen,
      }), [notificationEventsOpen]);

      // 打开后焦点落到第一个选项；无 DOM（测试/嵌入替身）时 ref 为空，静默跳过。
      react.useEffect(() => {
        if (!notificationEventsOpen) return;
        const panel = notificationEventsPanelRef.current;
        if (panel === null || panel === void 0 || typeof panel.querySelector !== "function") return;
        try { panel.querySelector("input[type=checkbox]")?.focus?.(); } catch { /* 忽略不可聚焦的宿主 */ }
      }, [notificationEventsOpen]);

      const editDraft = (update) => {
        setDirty(true);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setDraft((previous) => update(previous));
      };

      const captureEditorBaseline = (role) => {
        if (role === null) return null;
        // 即使 rolePrompts 仍在加载，也必须先锁定进入编辑器时的 revision；
        // 投影稍后到达时只能补齐内容，不能把首次 CAS 偷换成实时 revision。
        return {
          role,
          value: settingsSnapshot.value,
          revision: Number.isSafeInteger(settingsSnapshot.revision) && settingsSnapshot.revision >= 0
            ? settingsSnapshot.revision
            : null,
          projection: promptProjection,
        };
      };
      const applyPromptNavigation = (role) => {
        setSelectedPromptRole(role);
        setEditorBaseline(captureEditorBaseline(role));
        setPromptDrafts({});
        setPromptTouched({});
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
      };
      const requestPromptNavigation = (role, trigger) => {
        if (editorHasUnsavedChanges) {
          // 对话框关闭后返回触发控件；无法取得 DOM 焦点时安全降级，不影响导航语义。
          leaveTriggerRef.current = trigger?.currentTarget ?? (typeof document === "undefined" ? null : document.activeElement);
          setLeaveIntent({ kind: "navigate", role });
          return;
        }
        applyPromptNavigation(role);
      };
      const openPrompt = (role, event) => {
        if (!promptRoleIds.includes(role)) return;
        if (selectedPromptRole !== null && selectedPromptRole !== role) {
          requestPromptNavigation(role, event);
          return;
        }
        setSelectedPromptRole(role);
        setEditorBaseline(captureEditorBaseline(role));
        setPromptError(null);
        setError(null);
      };
      const closePrompt = (event) => requestPromptNavigation(null, event);
      const dismissLeaveDialog = () => {
        setLeaveIntent(null);
        const trigger = leaveTriggerRef.current;
        leaveTriggerRef.current = null;
        try { trigger?.focus?.(); } catch { /* 焦点恢复失败不应阻断编辑器。 */ }
      };
      const editPromptText = (role, text) => {
        const nextPromptDirty = baselineProjection !== null && promptRoleIds.some((candidate) => {
          const entry = promptEntryOf(baselineProjection, candidate);
          if (entry === null) return false;
          return (candidate === role ? text : promptTextOf(candidate)) !== entry.effective;
        });
        setPromptDrafts((previous) => ({ ...previous, [role]: text }));
        setPromptTouched((previous) => ({ ...previous, [role]: true }));
        // 仅提示词被改回已保存文本时要撤销 dirty；否则保存按钮会错误保持可用。
        setDirty(settingsDirty || nextPromptDirty);
        setSaved(false);
        setError(null);
        setPromptError(null);
      };

      const groups = Array.isArray(directoryState.groups) ? directoryState.groups : [];
      const providerGroups = groups.filter((group) => group && typeof group.id === "string");
      /**
       * 角色模型表的行集合：内置六角色（含未启用的 Observer，提示词入口历史行为）
       * + meta.activeRoles 里启用的内置角色。
       */
      const modelRowRoles = react.useMemo(() => {
        const next = [...PROMPT_ROLE_IDS];
        for (const role of roles) if (!next.includes(role)) next.push(role);
        return next;
      }, [roles]);

      /**
       * 目录可用性：`status === "ready"`，或**已有成功目录缓存**（groups 非空）。
       *
       * 角色的选择与保存只依赖目录**内容**，不依赖"此刻有没有在途刷新"：
       * - `startRequest` 每次只把 status 推到 loading、**刻意保留**上一次已知目录（见
       *   createSettingsModelCatalog 的注释），最新一次请求失败也只把 status 推到 error；
       *   这两种状态下下拉里的选项仍然完整可用，若按 status 硬门控就会出现"用户看得见选项
       *   却选不了、更保存不了"的死锁——"新增 provider 后立即删除"的刷新突发正是这个时序；
       * - 首次挂载还没有过任何成功目录（groups 为空）时仍然禁用：没有目录就没有合法选项；
       * - `connection/reset` 的 clear 语义会**立刻清空** groups（refresh(true)），清空期间
       *   同样必须禁用，直到新连接上的目录返回。缓存可用的判定因此只看"有没有目录"，
       *   绝不能用"曾经 ready 过"这类会跨 reset 残留的记忆。
       */
      const catalogAvailable = directoryState.status === "ready" || groups.length > 0;
      /**
       * 页签与当前层的派生视图（票据 24 重排：候选与子代理模型选择合并成多页签）。
       *
       * 页数由草稿推导，`currentModelPage` 永远收敛到合法页：删除最后一页或保存后数组变短时
       * 界面自动回落到主模型页，绝不去渲染一个不存在的层。
       */
      const modelPageCount = modelPageCountOf(draft);
      const currentModelPage = Math.min(selectedModelPage, modelPageCount - 1);
      const currentModelLayer = modelLayerMapOf(draft, currentModelPage);
      // 统一选择器只反映**当前页**的共同 provider；候选页没有历史顶层 provider 可回退。
      const unifiedProvider = unifiedProviderOf(currentModelLayer, roles, currentModelPage === 0 ? draft.provider : "");
      /** 页签名称只由位置推导：第一页恒为「主模型」，其余按候选序号。 */
      const modelPageLabelOf = bindModelPageLabelOf(tExtra);

      // 卸载时摘掉可能仍在监听中的指针监听（拖动中切 section / 关闭设置页）。
      react.useEffect(() => () => {
        const session = modelTabDragRef.current;
        modelTabDragRef.current = null;
        try { session?.detach?.(); } catch { /* 卸载路径不抛错。 */ }
      }, []);
      // 删除确认打开后焦点落在「取消」：破坏性动作不抢默认焦点（与删除 provider 同一模式）。
      react.useEffect(() => {
        if (modelPageDeleteIntent === null) return;
        try { modelPageDeleteCancelRef.current?.focus?.(); } catch { /* 不支持 focus 的嵌入宿主仍可键盘点击。 */ }
      }, [modelPageDeleteIntent]);

      /**
       * 渲染尾段与保存动作共享同一份 view：组件作用域的读面/写面只汇总一次（不复制、不重算）。
       * save 由 createSettingsSaveAction 在拿到 view 之后回填，避免自引用。
       */
      const view = {
         applyPromptNavigation, authorityValue, baselineProjection,  
        candidatesError, catalogAvailable, closePrompt, committedAuthorityRef, committedSnapshotLagging, 
        currentModelPage, directoryState, dismissLeaveDialog, draft, editDraft, editPromptText, effectiveDraft,
        error, externalSettingsChanged, hasUnsavedChanges, hostMeta, hostMetaError, leaveCancelRef,
        leaveIntent, leaveTriggerRef, modelConfigHost, modelFieldsChanged, modelPageCount, modelPageDeleteCancelRef,
        modelPageDeleteIntent, modelPageLabelOf, modelRowRoles, modelTabDrag, modelTabDragRef, modelTabRefs, modelTabSuppressClickRef, notificationEventsOpen,
        notificationEventsPanelRef, notificationEventsRootRef, notificationEventsTriggerRef, openPrompt, promptDirty, promptError,
        promptLoading, promptMaxGraphemes, promptProjection, promptRoleIds, promptTextOf, promptTouchedRoles, providerGroups,
        refreshHostMeta,  roleLabelOf, roles, saved,
        saving,  selectedPromptRole, setCandidatesError, setDirty, setDraft,
        setEditorBaseline, setError, setExternalSettingsChanged, setLeaveIntent, setLocalPromptProjection, setModelPageDeleteIntent,
        setModelTabDrag, setNotificationEventsOpen, setSelectedModelPage,
        setPromptDrafts, setPromptError, setPromptTouched, setSaved, setSettingsConflict, settingsConflict,
        settingsForm, settingsReadOnly, settingsSnapshot, sourceDraftForSave, sourcePromptOverrides, t, tExtra, unifiedProvider,
        ctx, editorBaseline, setSaving,
      };
      Object.assign(view, createModelPageActions(view), createModelTabDragController(view));
      // 离开确认的焦点 Hook（票据 35）：在**所有条件返回之前**无条件调用一次。
      useSettingsLeaveFocus(view);
      view.save = createSettingsSaveAction(view);
      return renderSettingsTail(view);
    }

  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    DshExpertGroupSettings, bindClientRuntime,
  });
})(globalThis);
