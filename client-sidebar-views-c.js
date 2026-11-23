/**
 * 客户端侧栏 · Panel 视图层（第三组：专家 / 空闲分组 / 工具条与「会话模型」弹窗）
 * — R6 / sidebar-views-c
 *
 * ## 职责边界（R6 票据 23）
 * Panel 渲染期最外层的任务树视图：专家行（含子级递归）、空闲分组、
 * 顶部工具条，以及「会话模型」弹窗（按角色编辑本会话覆盖）。
 *
 * ## 视图层不持有可写状态
 * 本文件没有 state / ref / setter：
 * - 在途动作锁、展开存储、弹窗开关、重读令牌都是 Panel 的实例状态，经 `ctx` 只传**只读投影**
 *   （isActionPending / expand / sessionModelOpen …）与**窄命令**（runAction、updateFilter、
 *   toggleSessionModelDialog、closeSessionModelDialog、retrySessionModelLoad、
 *   updateSessionModelDraft、clearSessionModelRole、commitSessionModelChanges）。
 * - 「会话模型」弹窗的行计算（sessionModelRowOf）是纯读：只读 state/meta/目录与草稿表。
 *
 * ## 与 React Hook / 组件形状的关系
 * 本文件没有任何 Hook，也不声明 React 组件：所有函数都是「上下文 → React 元素」的纯渲染助手，
 * 由 Panel 在原来的位置每帧调用。Hooks 的调用顺序与相对位置因此一字不动。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-views-c")]
 * 装配：依赖 pure / dom / views-a / views-b 的检查点（真实读取边）。
 */
(function installClientSidebarViewsC(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-c");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    STATUS_FILTER_OPTIONS,
    normalizeSessionModelSelection, object, sessionModelModelOptions, sessionModelOrchestratorOf, sessionModelRolesOf, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { statusIcon } = DOM;

  const renderExpert = (ctx, node, index, parentId, treeMeta) => {
    const { react, primitives, passesFilter, partialSnapshot, expand } = ctx;
    // 本地过滤：自身或其子节点都不命中时整棵子树隐藏（祖先由父级 isVisible 保留）。
    if (passesFilter(node) !== true) return null;
    // 轻量快照里没有活动证据的专家行渲染中性圆点（不声明已结束），完整快照不受影响。
    const runtimeStatus = ctx.runtimeStatusOfNode(node, parentId, undefined, { partial: partialSnapshot });
    const children = Array.isArray(node.children) ? node.children : [];
    const hasChildren = children.length > 0;
    // 只有真的有子节点时才渲染可折叠箭头：叶子专家行保留固定占位，
    // 绝不留下点了没有任何变化的按钮。有子节点时展开状态复用既有 chevron 机制与默认规则。
    const expertOpen = hasChildren ? expand(node) : true;
    const chevron = hasChildren
      ? ctx.a.renderChevron(node, expertOpen)
      : react.createElement("span", { className: "deg_expert_group_chevron_placeholder", "aria-hidden": "true" });
    // 树语义（票据 18）：行本身是 treeitem，层级位置来自父级传入的 treeMeta。
    // 位置/总数必须按**过滤后的可见集合**计算，否则辅助技术会读到不存在的兄弟项。
    const meta = treeMeta !== undefined && treeMeta !== null
      ? treeMeta
      : { level: 2, posinset: index + 1, setsize: index + 1 };
    const visibleChildNodes = children.filter((child) => passesFilter(child) === true);
    return react.createElement("div", { key: node.id || node.sessionId || "expert-" + index, className: "deg_expert_group_node", role: "none" },
      react.createElement("div", {
        className: "deg_expert_group_row",
        role: "treeitem",
        "aria-level": meta.level,
        "aria-posinset": meta.posinset,
        "aria-setsize": meta.setsize,
        ...(hasChildren ? { "aria-expanded": expertOpen } : {}),
        "data-status": runtimeStatus,
        "data-expanded": expertOpen,
      },
        statusIcon(react, primitives, runtimeStatus),
        chevron,
        react.createElement("div", null, ctx.b.renderRowMain(node, {
          sessionId: node.sessionId,
          parentId,
          // 会话节点只有 startedAt/lastActivityAt（Host 不发布完成时间），缺失片段自动省略。
          metrics: ctx.b.renderMetrics(node, { kind: node.kind || "expert", runtimeStatus, sessionId: node.sessionId, sessionIds: [node.sessionId] }),
          // 票据 30：专家自己的结构化结果区（有 value / 回退 / 已请求但未返回三种形态）。
          footer: ctx.a.renderStructuredBlock(node.structured, node.outputSchemaRequested, { kind: node.kind || "expert" }),
        }))),
      hasChildren && expertOpen
        ? react.createElement("div", { className: "deg_expert_group_children", role: "group" }, visibleChildNodes.map((child, childIndex) => renderExpert(ctx, child, childIndex, parentId, {
          level: meta.level + 1,
          posinset: childIndex + 1,
          setsize: visibleChildNodes.length,
        })))
        : null);
  };

  /**
   * 空闲分组是容器而非代理：它的圆点直接用规范值 ready（绿色静态圆点），
   * 分组内成员各自按官方目录证据决定 running/ready。
   */
  const renderIdleGroup = (ctx, nodes, trailing, treeMeta) => {
    const { react, primitives, t, rootSessionId, expand, partialSnapshot, neutralRuntimeStatus } = ctx;
    // 空列表同样要渲染：snapshot 已经加载（调用方只在有快照时调用）时「空闲子代理（0）」与零圆点
    // 是用户看得到的零状态；加载中 / 没有快照时调用方根本不会走到这里，绝不伪造零。
    const members = Array.isArray(nodes) ? nodes : [];
    const group = { kind: "idle-group", id: rootSessionId + "__idle__", taskName: t("sidebar.idleGroup.name"), status: "idle", children: members };
    const open = expand(group);
    const idleTitleChildren = [
      react.createElement("div", { className: "deg_expert_group_line deg_expert_group_task" }, t("sidebar.idleGroup", { count: members.length })),
    ];
    // 空闲分组的批量候选只来自当前 idleChildren；运行中的专家会被排除。
    // slot 与计数标题同属第三列的 inline flex，标题按可用宽度省略，slot 不会被推到行尾。
    if (trailing !== undefined && trailing !== null) idleTitleChildren.push(trailing);
    // 轻量快照下分组容器同样不声明「已结束」：它收纳的成员状态可能还没被完整读取，
    // 因此容器圆点跟随成员的中性态；完整快照仍按既有 ready 圆点渲染。
    const idleGroupStatus = partialSnapshot === true ? neutralRuntimeStatus : "ready";
    // 树语义：空闲分组是根的第 N 个可见子节点（treeitem），成员是它的下一级（role=group）。
    // 分组本身的展开/折叠由 aria-expanded 暴露，成员位置按当前 idleChildren 计算。
    const meta = treeMeta !== undefined && treeMeta !== null
      ? treeMeta
      : { level: 2, posinset: 1, setsize: 1 };
    return react.createElement("div", { className: "deg_expert_group_idle_group", "data-expanded": open, role: "none" },
      react.createElement("div", {
        className: "deg_expert_group_row deg_expert_group_idle_header",
        role: "treeitem",
        "aria-level": meta.level,
        "aria-posinset": meta.posinset,
        "aria-setsize": meta.setsize,
        "aria-expanded": open,
        "data-status": idleGroupStatus,
        "data-expanded": open,
      },
        statusIcon(react, primitives, idleGroupStatus),
        ctx.a.renderChevron(group, open),
        react.createElement("div", { className: "deg_expert_group_idle_title_line" }, ...idleTitleChildren)),
      open ? react.createElement("div", { className: "deg_expert_group_children deg_expert_group_idle_children", role: "group" }, members.map((node, index) => renderExpert(ctx, node, index, rootSessionId, { level: meta.level + 1, posinset: index + 1, setsize: members.length }))) : null);
  };

  /**
   * 侧栏「会话模型」弹窗：按角色编辑**本会话**的 provider/model/思考深度。
   *
   * 与设置页「角色模型」表同一套数据与视觉（专家 | 供应商 | 模型选择 | 思考深度）：
   * - 关闭时返回 null，且不发起任何 session-override-* RPC；
   * - 弹窗是原生 <dialog>，由 showModal() 放进 top layer（右栏容器的 overflow/transform
   *   裁剪不到它）；关闭按钮 / ESC / 点 backdrop / 状态同步都回到 sessionModelOpen；
   * - 每行显示值 = 草稿 ?? 本会话覆盖 ?? 全局默认（meta.roleDefaults）；
   * - 只有 status=ready 且 live=true（会话在运行）且没有写入在途时才可编辑；
   * - 底部「保存」整批提交改动（按角色展示顺序串行），行内「×」立即清除该角色覆盖。
   */
  /** 下拉选项：disabled 项只用于「目录外的历史值/占位说明」，不会被用户选中提交。 */
  const sessionModelOptionOf = (ctx, value, label, disabled) => {
    const { react } = ctx;
    return react.createElement("option", {
      key: "opt:" + (disabled === true ? "disabled:" : "") + value,
      value,
      ...(disabled === true ? { disabled: true } : {}),
    }, label);
  };

  /**
   * 主代理行的读面投影（纯读）：显示值与状态标记全部来自 Host 的 applyState **六态**。
   *
   * 客户端**不再**用 effective 猜测「是否实际生效」：旧判据把「配置存在但尚未应用」
   * 显示成「实际生效」，有旧 applied 时又会掩盖新配置未应用，stale 分支实际不可达。
   * 显示值语义见 PURE.sessionModelOrchestratorOf（applied / manual 显示实际套用值，
   * 其余显示期望配置）。marker 值就是六态本身，测试与样式都按它断言。
   */
  const sessionModelOrchestratorViewOf = (ctx) => {
    const { t } = ctx;
    const status = object(ctx.sessionModelState?.orchestrator);
    const { state, selection } = sessionModelOrchestratorOf(status, ctx.meta);
    const degraded = Number.isSafeInteger(status.degradedCandidate) && status.degradedCandidate > 0
      ? status.degradedCandidate
      : 0;
    const source = ["override", "period", "global"].includes(status.source) ? status.source : "none";
    // 文案键后缀 = applyState 取值（见 shared/i18n.js 的 sidebar.sessionModel.orchestrator.*）。
    const line = t("sidebar.sessionModel.orchestrator." + state, {
      value: selection === null
        ? ""
        : selection.provider + " / " + selection.model + (selection.reasoningEffort ? " · " + selection.reasoningEffort : ""),
      source: t("sidebar.sessionModel.orchestrator.source." + source),
    });
    return {
      // 下拉的可编辑基线：主代理自己的显示值（与其它行的「覆盖 ?? 全局默认」同构）。
      selection,
      // 宿主未就绪时该行只读：三个下拉统一按这一个判据禁用。
      hostReady: state !== "host-not-ready",
      // 降级位置只在「已实际生效」时追加：未生效的配置没有"降级到候选"这回事。
      text: degraded > 0 && state === "applied"
        ? line + " · " + t("sidebar.sessionModel.orchestrator.degraded", { index: degraded })
        : line,
      state,
    };
  };

  /**
   * 单个角色行的「显示值 + 三段选项」计算（纯读）。
   *
   * 只读本帧 state/meta/目录与草稿表；不写任何状态，也不发起 RPC。
   * 返回值里的 providerGroup 只在「当前 provider 不在目录里」时为 undefined，
   * 与拆分前逐字一致（JSX 用它决定 model 下拉是否禁用 + 是否插入 disabled 占位）。
   * 主代理行复用同一实现：只有基线（fallback）与显示名由调用方注入。
   */
  const sessionModelRowOf = (ctx, role, groups, fallback, label) => {
    const { t, meta, sessionModelState, sessionModelDrafts } = ctx;
    const current = sessionModelState.overrides[role] ?? null;
    // fallback 只由主代理行传入（它的基线来自 get().orchestrator，不在 meta.roleDefaults 里）。
    const globalDefault = fallback !== void 0
      ? fallback
      : normalizeSessionModelSelection(object(meta?.roleDefaults)[role]);
    const hasDraft = Object.prototype.hasOwnProperty.call(sessionModelDrafts, role);
    const baseline = current ?? globalDefault;
    const editable = hasDraft
      ? sessionModelDrafts[role]
      : {
        provider: baseline?.provider ?? "",
        model: baseline?.model ?? "",
        reasoningEffort: baseline?.reasoningEffort ?? "",
      };
    const providerValue = typeof editable.provider === "string" ? editable.provider : "";
    const modelValue = typeof editable.model === "string" ? editable.model : "";
    const effortValue = typeof editable.reasoningEffort === "string" ? editable.reasoningEffort : "";
    const roleLabel = label ?? ctx.a.roleLabelFor(role, null) ?? role;
    const providerGroup = groups.find((group) => text(object(group).id, null) === providerValue);
    const models = sessionModelModelOptions(providerValue, groups);
    const modelEntry = models.find((candidate) => text(object(candidate).id, null) === modelValue);
    // 只把「模型确实声明了 reasoning 对象」当成有档位：目录里没有该模型时绝不能
    // 用空对象占位，否则 effort 下拉会从「无思考深度」退化成可选的「模型默认」。
    const reasoningRaw = modelEntry?.reasoning;
    const reasoning = reasoningRaw !== null && typeof reasoningRaw === "object" && Array.isArray(reasoningRaw) !== true
      ? reasoningRaw
      : null;
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];

    // provider：空值 + 目录外的当前值（disabled）+ 目录项。
    const providerOptions = [sessionModelOptionOf(ctx, "", "未选择供应商")];
    if (providerValue !== "" && providerGroup === undefined) {
      providerOptions.push(sessionModelOptionOf(ctx, providerValue, providerValue + "（不可用）", true));
    }
    for (const group of groups) {
      const id = text(object(group).id, null);
      // 空 id 与「未选择供应商」同值，会生成重复 key/重复选项：目录坏项直接跳过。
      if (id === null || id === "") continue;
      providerOptions.push(sessionModelOptionOf(ctx, id, text(object(group).name, null) ?? id));
    }

    // model：未选 provider 时只有一个禁用占位；否则空值 + 目录外当前值（disabled）+ 该 provider 的目录项。
    const modelOptions = [];
    if (providerValue === "") {
      modelOptions.push(sessionModelOptionOf(ctx, "", "先选择供应商", true));
    } else {
      modelOptions.push(sessionModelOptionOf(ctx, "", "未选择模型"));
      if (modelValue !== "" && modelEntry === undefined) {
        modelOptions.push(sessionModelOptionOf(ctx, modelValue, modelValue + "（不可用）", true));
      }
      for (const candidate of models) {
        const id = text(object(candidate).id, null);
        if (id === null || id === "") continue;
        modelOptions.push(sessionModelOptionOf(ctx, id, text(object(candidate).name, null) ?? id));
      }
    }

    // effort：模型没声明 reasoning 时只有一个禁用占位（与设置页同文案规则）。
    const effortOptions = [];
    if (reasoning === null) {
      effortOptions.push(sessionModelOptionOf(ctx, "", providerValue === "" ? "先选择模型" : "模型无思考深度", true));
    } else {
      effortOptions.push(sessionModelOptionOf(ctx, "", t("sidebar.sessionModel.effortDefault")));
      for (const effort of efforts) {
        const id = text(object(effort).id, null);
        if (id === null || id === "") continue;
        effortOptions.push(sessionModelOptionOf(ctx, id, text(object(effort).name, null) ?? id));
      }
      // 历史/手写 effort 不在当前目录里时仍原样显示，避免下拉静默改值。
      if (effortValue !== ""
        && efforts.every((effort) => text(object(effort).id, null) !== effortValue)) {
        effortOptions.push(sessionModelOptionOf(ctx, effortValue, effortValue + "（不可用）", true));
      }
    }
    return {
      current, roleLabel, providerValue, modelValue, effortValue,
      providerOptions, modelOptions, effortOptions, reasoning, providerGroup,
    };
  };

  /** 单个角色行（角色 pill + 三个下拉）；只发 updateSessionModelDraft / clearSessionModelRole 两个命令。 */
  const renderSessionModelRow = (ctx, role, options) => {
    const { react, t, updateSessionModelDraft, clearSessionModelRole } = ctx;
    const writable = options.writable;
    const orchestrator = options.orchestrator === true;
    const row = sessionModelRowOf(ctx, role, options.groups, options.fallback, options.label);
    const {
      current, roleLabel, providerValue, modelValue, effortValue,
      providerOptions, modelOptions, effortOptions, reasoning, providerGroup,
    } = row;
    // 角色 pill：有本会话覆盖时额外渲染「×」（点击立即清除该角色覆盖）。
    const pillChildren = [
      react.createElement("span", {
        key: "label",
        className: "deg_expert_group_session_model_pill_label",
        title: roleLabel,
      }, roleLabel),
    ];
    if (current !== null) {
      pillChildren.push(react.createElement("button", {
        key: "clear",
        type: "button",
        className: "deg_expert_group_session_model_clear",
        "data-deg-session-model-clear": role,
        "aria-label": t("sidebar.sessionModel.clearRole", { role: roleLabel }),
        title: t("sidebar.sessionModel.clearRole", { role: roleLabel }),
        disabled: writable !== true,
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          void clearSessionModelRole(role);
        },
      }, "×"));
    }

    return (react.createElement("div", {
      key: role,
      className: "deg_expert_group_session_model_row",
      role: "row",
      "data-deg-session-model-role": role,
      "data-deg-session-model-state": current !== null ? "override" : "follow",
    }, [
      react.createElement("div", {
        key: "role",
        role: "cell",
        className: "deg_expert_group_session_model_cell",
      }, react.createElement("span", { className: "deg_expert_group_session_model_pill" }, pillChildren)),
      react.createElement("div", {
        key: "provider",
        role: "cell",
        className: "deg_expert_group_session_model_cell",
      }, react.createElement("select", {
        className: "deg_expert_group_session_model_select",
        "aria-label": roleLabel + " " + t("sidebar.sessionModel.provider"),
        "data-deg-session-model-field": "provider",
        value: providerValue,
        disabled: writable !== true,
        onChange: (event) => updateSessionModelDraft(role, "provider", event?.target?.value ?? ""),
      }, providerOptions)),
      react.createElement("div", {
        key: "model",
        role: "cell",
        className: "deg_expert_group_session_model_cell",
      }, react.createElement("select", {
        className: "deg_expert_group_session_model_select",
        "aria-label": roleLabel + " " + t("sidebar.sessionModel.columnModel"),
        "data-deg-session-model-field": "model",
        value: modelValue,
        disabled: writable !== true || providerValue === "" || providerGroup === undefined,
        onChange: (event) => updateSessionModelDraft(role, "model", event?.target?.value ?? ""),
      }, modelOptions)),
      react.createElement("div", {
        key: "effort",
        role: "cell",
        className: "deg_expert_group_session_model_cell",
      }, react.createElement("select", {
        className: "deg_expert_group_session_model_select",
        "aria-label": roleLabel + " " + t("sidebar.sessionModel.effort"),
        "data-deg-session-model-field": "effort",
        value: effortValue,
        // 模型没有 reasoning 时只有一个禁用占位：绝不提交非法 effort。
        disabled: writable !== true || reasoning === null || modelValue === "",
        onChange: (event) => updateSessionModelDraft(role, "reasoningEffort", event?.target?.value ?? ""),
      }, effortOptions)),
      // 主代理行多一行跨列状态说明（display:contents 的 grid 子项，grid-column 跨满整行）。
    ].concat(orchestrator && options.status ? [react.createElement("div", {
      className: "deg_expert_group_session_model_orchestrator",
      "data-deg-session-model-orchestrator": options.status.state,
    }, options.status.text)] : [])));
  };

  /** 弹窗底部：revision、草稿校验提示、恢复默认、关闭与整批保存。 */
  const renderSessionModelFooter = (ctx, options) => {
    const { react, t, sessionModelState, commitSessionModelChanges, restoreSessionModelDefaults } = ctx;
    const { canSave, canRestore, invalidDraft, closeDialog } = options;
    const footer = react.createElement("footer", {
      key: "footer",
      className: "deg_expert_group_session_model_footer",
    }, [
      react.createElement("span", {
        key: "revision",
        className: "deg_expert_group_session_model_revision",
        "data-deg-session-model-revision": sessionModelState.revision,
      }, t("sidebar.sessionModel.revision", { revision: sessionModelState.revision })),
      invalidDraft === true
        ? react.createElement("span", {
          key: "invalid",
          className: "deg_expert_group_session_model_invalid",
          role: "status",
          "data-deg-session-model-invalid": "true",
        }, t("sidebar.sessionModel.invalidDraft"))
        : null,
      react.createElement("span", { key: "spacer", className: "deg_expert_group_session_model_spacer" }),
      // 「恢复默认」：清除本会话全部角色覆盖并立即保存（不是把当前值写成覆盖）。
      // 没有可清除的覆盖、会话不可写或在途保存时禁用，避免一个点了没有任何效果的按钮。
      react.createElement("button", {
        key: "restore",
        type: "button",
        className: "deg_expert_group_session_model_secondary",
        "data-deg-session-model-restore": "true",
        "aria-label": t("sidebar.sessionModel.restore"),
        disabled: canRestore !== true,
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          void restoreSessionModelDefaults();
        },
      }, t("sidebar.sessionModel.restore")),
      // 底部「关闭」与「保存」同高（secondary 28px）；标题栏的「×」仍用工具条小按钮样式。
      react.createElement("button", {
        key: "close",
        type: "button",
        className: "deg_expert_group_session_model_secondary",
        "data-deg-session-model-close": "footer",
        onClick: closeDialog,
      }, t("sidebar.sessionModel.close")),
      react.createElement("button", {
        key: "save",
        type: "button",
        className: "deg_expert_group_session_model_primary",
        "data-deg-session-model-save": "true",
        "aria-label": t("sidebar.sessionModel.saveChanges"),
        disabled: canSave !== true,
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          void commitSessionModelChanges();
        },
      }, t("sidebar.sessionModel.saveChanges")),
    ]);
    return footer;
  };

  const renderSessionModelDialog = (ctx) => {
    const {
      react, t, meta, sessionModelOpen, sessionModelState, sessionModelCatalog, sessionModelSaving,
      sessionModelNotice, sessionModelHasInvalidDraft, sessionModelPendingChanges,
      closeSessionModelDialog, retrySessionModelLoad, sessionModelDialogRef,
    } = ctx;
    if (sessionModelOpen !== true) return null;
    const status = sessionModelState.status;
    const roles = sessionModelRolesOf(meta);
    const groups = Array.isArray(sessionModelCatalog.groups) ? sessionModelCatalog.groups : [];
    // 唯一可写判据：Host 读面成功、会话在运行、且没有批量写入在途。
    const writable = status === "ready" && sessionModelState.live === true && sessionModelSaving !== true;
    const readOnlyReasons = {
      "no-session": t("sidebar.sessionModel.noSession"),
      child: t("sidebar.sessionModel.child"),
      loading: t("sidebar.sessionModel.loading"),
      unsupported: t("sidebar.sessionModel.unsupported"),
      error: t("sidebar.sessionModel.unavailable"),
      unavailable: t("sidebar.sessionModel.unavailable"),
    };
    // ready + live=false 是「会话未运行」；其余按状态取固定文案。idle（刚打开、effect 还没跑）
    // 不提示，避免闪一行会被立刻替换掉的只读文案。
    const readOnlyHint = status === "ready"
      ? (sessionModelState.live === true ? null : t("sidebar.sessionModel.offline"))
      : (readOnlyReasons[status] ?? null);
    const noticeText = sessionModelNotice === null
      ? null
      : sessionModelNotice.kind === "saved"
        ? (sessionModelNotice.text ?? t("sidebar.sessionModel.saved"))
        : sessionModelNotice.kind === "cleared"
          ? t("sidebar.sessionModel.cleared")
          : sessionModelNotice.text;
    const noticeError = sessionModelNotice?.kind === "error" || sessionModelNotice?.kind === "conflict";
    // 底部保存按钮的可点条件：有可提交改动且所有草稿都合法（provider/model 都非空）。
    const changes = status === "ready" ? sessionModelPendingChanges() : [];
    const invalidDraft = status === "ready" && sessionModelHasInvalidDraft();
    const canSave = writable === true && changes.length > 0 && invalidDraft !== true;
    // 「恢复默认」的可点条件：可写 + 至少还有一个角色带着本会话覆盖（否则没有可清除的东西）。
    const canRestore = writable === true && Object.keys(sessionModelState.overrides).length > 0;
    const closeDialog = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      closeSessionModelDialog();
    };
    const headRow = react.createElement("div", {
      key: "__head",
      className: "deg_expert_group_session_model_row",
      role: "row",
      "data-deg-session-model-head": "true",
    }, [
      react.createElement("span", {
        key: "role",
        role: "columnheader",
        className: "deg_expert_group_session_model_head_cell",
      }, t("sidebar.sessionModel.columnRole")),
      react.createElement("span", {
        key: "provider",
        role: "columnheader",
        className: "deg_expert_group_session_model_head_cell",
      }, t("sidebar.sessionModel.provider")),
      react.createElement("span", {
        key: "model",
        role: "columnheader",
        className: "deg_expert_group_session_model_head_cell",
      }, t("sidebar.sessionModel.columnModel")),
      react.createElement("span", {
        key: "effort",
        role: "columnheader",
        className: "deg_expert_group_session_model_head_cell",
      }, t("sidebar.sessionModel.effort")),
    ]);
    const rows = [];
    if (status === "ready") {
      // 主代理固定第一行、常驻：它不在 meta.roles 里（未启用的角色不会出现在其它行），
      // 因此绝不能靠角色清单"顺带"渲染。hostReady=false 时该行只读（Host 尚未绑定服务）。
      const orchestratorView = sessionModelOrchestratorViewOf(ctx);
      rows.push(renderSessionModelRow(ctx, "orchestrator", {
        writable: writable === true && orchestratorView.hostReady === true,
        groups,
        fallback: orchestratorView.selection,
        label: "Orchestrator",
        status: orchestratorView,
        orchestrator: true,
      }));
      for (const role of roles) {
        rows.push(renderSessionModelRow(ctx, role, { writable, groups }));
      }
    }
    const bodyChildren = [
      react.createElement("p", { key: "hint", className: "deg_expert_group_session_model_hint" },
        t("sidebar.sessionModel.hint")),
    ];
    if (readOnlyHint !== null) {
      bodyChildren.push(react.createElement("div", {
        key: "readonly",
        className: "deg_expert_group_session_model_hint",
        "data-deg-session-model-readonly": status,
      }, readOnlyHint));
    }
    // 读取失败才给「重新读取」：它只递增重读令牌，不会把当前草稿冲掉。
    if (status === "error") {
      bodyChildren.push(react.createElement("button", {
        key: "retry",
        type: "button",
        className: "deg_expert_group_export_button",
        "data-deg-session-model-retry": "true",
        "aria-label": t("sidebar.sessionModel.retry"),
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          retrySessionModelLoad();
        },
      }, t("sidebar.sessionModel.retry")));
    }
    if (noticeText !== null) {
      bodyChildren.push(react.createElement("div", {
        key: "notice",
        className: noticeError
          ? "deg_expert_group_session_model_notice deg_expert_group_session_model_notice_error"
          : "deg_expert_group_session_model_notice",
        role: "status",
        "data-deg-session-model-notice": sessionModelNotice?.kind ?? "none",
      }, noticeText));
    }
    if (roles.length === 0) {
      bodyChildren.push(react.createElement("div", {
        key: "empty",
        className: "deg_expert_group_session_model_hint",
      }, t("sidebar.sessionModel.emptyRoles")));
    }
    if (status === "ready") {
      bodyChildren.push(react.createElement("div", {
        key: "table",
        className: "deg_expert_group_session_model_scroll",
      }, react.createElement("div", {
        role: "table",
        "aria-label": t("sidebar.sessionModel.tableLabel"),
        className: "deg_expert_group_session_model_table",
      }, [headRow, ...rows])));
    }
    const footer = renderSessionModelFooter(ctx, { canSave, canRestore, invalidDraft, closeDialog });
    /**
     * 标题右侧的峰谷时段徽标（复用侧栏标题栏同款 class 与配色）：只在峰谷启用时渲染。
     *
     * 读面缺失（旧宿主 / 直接 createSidebarViewsC）时两个入口都不存在，徽标不渲染，
     * 弹窗 DOM 逐字保持旧形状。marker 由 Panel 的 useState 持有，这里只在渲染期纯读。
     */
    const peakValleyMarker = typeof ctx.getPeakValleyMarker === "function" ? ctx.getPeakValleyMarker() : null;
    const peakValleyLabel = typeof ctx.peakValleyLabelOf === "function" ? ctx.peakValleyLabelOf(peakValleyMarker) : null;
    const peakValleyBadge = peakValleyLabel === null ? null : react.createElement("span", {
      key: "peakValley",
      className: "deg_expert_group_header_peak_valley",
      "data-peak-valley": peakValleyMarker?.period === "peak" ? "peak" : "valley",
    }, peakValleyLabel);
    return react.createElement("dialog", {
      id: "deg-session-model-dialog",
      className: "deg_expert_group_session_model_dialog",
      "aria-labelledby": "deg-session-model-title",
      "data-deg-session-model": "dialog",
      "data-deg-session-model-state": status,
      ref: sessionModelDialogRef,
      // ESC：dialog 会先派发 cancel，默认行为是关闭；这里接管成「同步本地状态」。
      onCancel: closeDialog,
      // 任何原因导致的关闭（含未来的 dialog.close()）都同步回本地状态。
      onClose: () => { closeSessionModelDialog(); },
      // 点 backdrop 时事件目标就是 dialog 自身；点内部内容不关闭。
      onClick: (event) => {
        if (sessionModelDialogRef.current !== null
          && event?.target === sessionModelDialogRef.current) {
          closeSessionModelDialog();
        }
      },
    },
      react.createElement("header", { className: "deg_expert_group_session_model_header" },
        // 标题与峰谷徽标同在一个左组里：徽标紧跟标题文字，关闭按钮仍贴右端。
        react.createElement("div", { className: "deg_expert_group_session_model_heading" }, [
          react.createElement("h2", {
            key: "title",
            id: "deg-session-model-title",
            className: "deg_expert_group_session_model_title",
          }, t("sidebar.sessionModel.title")),
          peakValleyBadge,
        ]),
        react.createElement("button", {
          type: "button",
          className: "deg_expert_group_export_button",
          "data-deg-session-model-close": "true",
          "aria-label": t("sidebar.sessionModel.close"),
          onClick: closeDialog,
        }, "×")),
      // 滚动只发生在这里；弹窗身份标记只在 dialog 根节点上（data-deg-session-model="dialog"）。
      react.createElement("div", {
        className: "deg_expert_group_session_model_body",
      }, bodyChildren),
      footer);
  };

  /**
   * 顶部工具条（票据 12）：搜索输入 + 角色筛选 + 状态筛选 + 「会话模型」入口。
   *
   * 只在快照已上屏时渲染（skeleton/空态没有可过滤的内容）；输入/下拉只改内存过滤状态，
   * 「会话模型」按钮只切换本地折叠状态（真正的读写都发生在它自己的 effect 里）。
   * 角色候选从当前快照里的普通专家现算，而不是写死词表。
   */
  const renderToolbar = (ctx) => {
    const { react, t, snapshot, root, filterSource, updateFilter, sessionModelOpen, sessionModelEntryRef, toggleSessionModelDialog } = ctx;
    if (snapshot === null) return null;
    const roles = [];
    const addRole = (value) => {
      const role = text(value, null);
      if (role !== null && roles.indexOf(role) === -1) roles.push(role);
    };
    const collectRoles = (nodes) => {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        addRole(node.role);
        collectRoles(node.children);
      }
    };
    // 刻意不把根会话角色放进候选：根行永远可见，选中它只会得到「根行 + 空结果」，
    // 对用户没有意义。候选只来自真正会被过滤的子节点。
    collectRoles(root?.children);
    roles.sort();
    return react.createElement("div", { className: "deg_expert_group_toolbar", role: "search", "aria-label": t("sidebar.search.label") },
      react.createElement("input", {
        type: "search",
        className: "deg_expert_group_search",
        "aria-label": t("sidebar.search.aria"),
        placeholder: t("sidebar.search.placeholder"),
        value: filterSource.query,
        onChange: (event) => { updateFilter({ query: event?.target?.value ?? "" }); },
      }),
      react.createElement("select", {
        className: "deg_expert_group_filter",
        "aria-label": t("sidebar.filter.role"),
        value: filterSource.role,
        onChange: (event) => { updateFilter({ role: event?.target?.value ?? "" }); },
      }, [
        react.createElement("option", { key: "__all_roles", value: "" }, t("sidebar.filter.allRoles")),
        // 票据 27：value 仍是角色 id（过滤按 id 匹配），显示名优先用 roleLabel；
        // 选项来自运行期角色列表，不按静态内置角色表过滤，因此保留历史显示名，
        // 不因角色表收缩而丢标签。
        ...roles.map((role) => react.createElement("option", { key: role, value: role }, ctx.a.roleLabelFor(role, null) ?? role)),
      ]),
      react.createElement("select", {
        className: "deg_expert_group_filter",
        "aria-label": t("sidebar.filter.status"),
        value: filterSource.status,
        onChange: (event) => { updateFilter({ status: event?.target?.value ?? "" }); },
      }, [
        react.createElement("option", { key: "__all_statuses", value: "" }, t("sidebar.filter.allStatuses")),
        ...STATUS_FILTER_OPTIONS.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)),
      ]),
      // 「会话模型」入口：只切换本地打开状态，弹窗自己的 effect 读写 session-override-*；
      // 按钮定位与原来的手动派发入口逐字对齐。
      react.createElement("button", {
        type: "button",
        className: "deg_expert_group_export_button",
        "aria-label": t("sidebar.sessionModel.open"),
        "aria-expanded": sessionModelOpen,
        // 弹窗语义：告诉辅助技术这个按钮会打开一个 dialog，并指向它的稳定 id。
        "aria-haspopup": "dialog",
        "aria-controls": "deg-session-model-dialog",
        // 关闭时由焦点归还 effect 把焦点放回这个节点。
        ref: sessionModelEntryRef,
        title: t("sidebar.sessionModel.openTitle"),
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          toggleSessionModelDialog();
        },
      }, t("sidebar.sessionModel.open")));
  };


  /**
   * 绑定「本帧视图上下文」的渲染函数集合。
   *
   * ctx = Panel 本帧的只读投影 + 窄命令；viewsA / viewsB 是兄弟视图模块的**同名同级**渲染函数
   * （纯读、无状态），专家行与空闲分组复用它们，绝不复制实现。
   * 每次渲染新建一份，绝不缓存（否则会看到上一帧的 root / 展开状态）。
   */
  function createSidebarViewsC(ctx, viewsA, viewsB) {
    const deps = { ...ctx, a: viewsA, b: viewsB };
    return Object.freeze({
      renderExpert: (node, index, parentId, treeMeta) => renderExpert(deps, node, index, parentId, treeMeta),
      renderIdleGroup: (nodes, trailing, treeMeta) => renderIdleGroup(deps, nodes, trailing, treeMeta),
      renderToolbar: () => renderToolbar(deps),
      renderSessionModelDialog: () => renderSessionModelDialog(deps),
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarViewsC });
})(globalThis);
