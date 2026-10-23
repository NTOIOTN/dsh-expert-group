/**
 * 客户端侧栏 · Panel 视图层（第一组：行内控件 / 用量与结构化结果 / attempt 时间线）— R6 / sidebar-views-a
 *
 * ## 职责边界（R6 票据 23）
 * 把 Panel 渲染期**纯投影**的子视图搬出主文件：标题行的批量关闭控件、右栏打开/关闭箭头、
 * 折叠箭头、行内动作按钮、attempt 用量与成本、结构化结果区、失败摘要、attempt 时间线。
 * 这些函数的输入全部是参数与一个只读视图上下文（`ctx`），输出是 React 元素。
 *
 * ## 视图层不持有可写状态
 * 本文件不持有任何 Panel 的 ref / state / setter：
 * - 在途锁、tab 记录 Map、时间线展开 Set 都是 Panel 的实例状态，经 `ctx` 只传**只读投影**
 *   （isBatchPending / isTabOpen / isTimelineExpanded）与**窄命令**（toggleTimelineExpanded、
 *   handleSidebarAction、handleSidebarBatchClose、toggle）。
 * - 因此「写入」永远发生在 Panel；本文件只发命令。
 *
 * ## 与 React Hook 的关系
 * 本文件没有任何 Hook：Panel 仍在原位置调用自己的 Hook，然后每帧调用
 * `createSidebarViewsA(ctx)` 取回绑定好当前帧上下文的渲染函数。工厂不缓存、不跨帧复用。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-views-a")]
 * 装配：依赖 client-sidebar-pure.js 与 client-sidebar-dom.js 的检查点（真实读取边）。
 */
(function installClientSidebarViewsA(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-a");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    ATTEMPT_STATUS_LABELS, failureSummaryText, finiteNumber, formatClockText, formatDurationText,
    formatIsoText, mergedRoleLabelsOf, modelApi, modelFunction, object, roleLabelFor: roleLabelForBase, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    makeIcon, sidebarTabKey, subagentChatAddress,
  } = DOM;

  // ── 票据 25 / 30：用量与结构化结果的渲染助手 ─────────────────────────────
  const finiteToken = (value) => finiteNumber(value);
  const usageOf = (node) => {
    const api = modelApi();
    if (typeof api?.normalizeUsage !== "function") return null;
    return api.normalizeUsage(object(node).usage);
  };
  const findPriceOf = (ctx, provider, modelId) => {
    const { meta } = ctx;
    const api = modelApi();
    if (meta === null || typeof api?.findModelPrice !== "function") return null;
    return api.findModelPrice(meta.modelPrices, provider, modelId);
  };
  const estimateCostOf = (ctx, usage, provider, modelId) => {
    const api = modelApi();
    if (typeof api?.estimateUsageCost !== "function") return null;
    return api.estimateUsageCost(usage, findPriceOf(ctx, provider, modelId));
  };
  const formatCost = (value) => {
    const amount = finiteNumber(value);
    if (amount === null) return null;
    if (amount === 0) return "0";
    if (amount < 0.000001) return amount.toExponential(2);
    return amount >= 0.01 ? amount.toFixed(4) : amount.toFixed(6);
  };
  /** 完整用量 tooltip（有界）：只列已知项，缺失不补 0。 */
  const usageTitleOf = (usage) => {
    const source = usage;
    if (source === null) return "用量：—";
    const parts = [];
    const tokens = [["inputTokens", "输入"], ["outputTokens", "输出"], ["cacheReadTokens", "缓存读"], ["cacheWriteTokens", "缓存写"], ["reasoningTokens", "推理"]];
    for (const [field, label] of tokens) {
      const value = finiteToken(source[field]);
      if (value !== null) parts.push(label + " " + value);
    }
    for (const [field, label] of [["requests", "请求"], ["retries", "重试"], ["fallbacks", "降级"]]) {
      const value = finiteToken(source[field]);
      if (value !== null) parts.push(label + " " + value);
    }
    const duration = formatDurationText(source.runMs);
    if (duration !== null) parts.push("运行时长 " + duration);
    return parts.length === 0 ? "用量：—" : "用量：" + parts.join(" · ");
  };

  const renderChevron = (ctx, node, open) => {
    const { react, primitives, t, toggle } = ctx;
    // 折叠/展开文案走消息表（票据 19）：title 与 aria-label 同源，en 宿主下不再中文硬编码。
    const label = open ? t("sidebar.collapse") : t("sidebar.expand");
    return react.createElement("button", {
      type: "button", className: "deg_expert_group_chevron", title: label,
      "aria-label": label, "aria-expanded": open, onClick: (event) => { event?.stopPropagation?.(); toggle(node); },
    }, makeIcon(primitives, open ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", { size: 14 }));
  };

  /**
   * 行内动作按钮（取消 / 重试等）。pending 由 Panel 的在途锁投影而来，视图只渲染。
   */
  const renderAction = (ctx, label, Icon, onClick, pending) => {
    const { react, primitives } = ctx;
    return react.createElement("button", {
      type: "button", className: "deg_expert_group_action", title: pending ? label + "（处理中）" : label,
      "aria-label": pending ? label + "（处理中）" : label, "aria-busy": pending || undefined, disabled: pending, onClick,
    }, makeIcon(primitives, Icon, { size: 14 }));
  };

  /**
   * 标题行批量控件（主代理行与空闲分组标题行共用）。
   *
   * 三态渲染：
   * - 候选 > 0 且 close 可用：与单会话箭头同款的双左尖括号按钮（30×20），
   *   aria-label/title 说明会关闭几个 tab，type=button，preventDefault + stopPropagation 必须同时存在；
   * - inventory 已知且候选为 0：非交互蓝色实心圆（12px）占位，没有 button / hover / tabindex；
   * - inventory 不可读，或候选 > 0 但 close 不可用：什么都不渲染（未知态绝不假报「零」，
   *   「关不掉」也绝不退化成「零」）。
   *
   * 这里**不看 openResource**：批量关闭只读取公开 inventory 并调用 close()，不需要打开任何资源。
   * 以打开能力当门槛会让「宿主能关不能开」（或注入面只给了 close）的右栏整行失去控件。
   * 唯一的渲染能力门槛是左尖括号图标：缺它时连零占位也不渲染。
   *
   * 绝不使用 aria-pressed：这是批量命令，不是 toggle 状态。
   */
  const renderSidebarBatchSlot = (ctx, addresses, label) => {
    const { react, primitives, sidebarBatchStateFor, sidebarSessionId, rootSessionId, handleSidebarBatchClose, isBatchPending } = ctx;
    const state = sidebarBatchStateFor(addresses);
    if (state.kind === "none") return null;
    if (state.kind === "zero") {
      // 左箭头图标缺失时连零占位也不渲染：没有可用的批量按钮能力就不该出现「本行有批量入口」的暗示。
      if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
      return react.createElement("div", { className: "deg_expert_group_trailing" },
        react.createElement("span", {
          className: "deg_expert_group_sidebar_batch_zero",
          "data-zero": "true",
          "aria-hidden": "true",
        }));
    }
    if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
    const count = state.candidates.length;
    const accessibleName = "在侧边栏关闭 " + count + " 个" + label;
    // 只看**当前** scope 的锁：别的 root/session 的在途序列绝不影响这一行的按钮状态。
    // 在途批量序列的「可写 Set」归 Panel 所有；视图只问投影，不持有可写引用。
    const pending = isBatchPending() === true;
    return react.createElement("div", { className: "deg_expert_group_trailing" },
      react.createElement("button", {
        type: "button",
        className: "deg_expert_group_sidebar_batch_action",
        title: accessibleName,
        "aria-label": accessibleName,
        "aria-busy": pending || undefined,
        disabled: pending,
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          // 候选集合固定为这次渲染算出的那一份：点击后 inventory 再变也不影响本轮。
          return handleSidebarBatchClose(state.candidates);
        },
        onKeyDown: (event) => { event?.stopPropagation?.(); },
      }, react.createElement("span", {
        className: "deg_expert_group_double_arrow",
        "data-direction": "close",
        "aria-hidden": "true",
      },
      makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
      makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }))));
  };

  /**
   * 标题后「在右侧栏打开 / 关闭」箭头按钮：与 DSH 原生子代理行同款箭头图标。
   *
   * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名右箭头图标可用。
   * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
   *
   * 两种形态共用同一枚 20×20 按钮：
   * - `>>`（默认，橙色）：打开。可关闭能力齐备时额外带 aria-pressed=false / data-open=false；
   * - `<<`（打开态，青色）：关闭该行对应的那个 tab。只有「close + active + 左箭头图标」三件能力
   *   全部具备、且已经用 active() 证据记录过 tabId 时才出现；缺任何一件就退回静态 `>>`，
   *   绝不显示一个点了不会关的假 toggle 状态。
   *
   * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
   * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
   * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
   * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
   * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
   * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
   * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
   * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
   * 必须同时存在：鼠标事件不得冒泡到任务名的导航处理器，键盘 Enter/Space 在按钮上的
   * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
   * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
   */
  const renderSidebarOpenAction = (ctx, address, label) => {
    const { react, primitives, sidebarSessionId, rootSessionId, openSidebarResource, closeSidebarResource, readActiveSidebarResource, sidebarOpenTabsAvailable, handleSidebarAction, isTabOpen } = ctx;
    if (openSidebarResource === null) return null;
    const resourceAddress = subagentChatAddress(address);
    if (resourceAddress === null) return null;
    if (typeof primitives?.IconChevronRightOutlineRegular !== "function") return null;
    const toggleCapable = closeSidebarResource !== null
      && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
      && typeof primitives?.IconChevronLeftOutlineRegular === "function";
    // 键含 rootSessionId：两个子代理、两个 root 的状态互不影响。
    const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
    // tab 记录 Map 的唯一 owner 是 Panel（可写）；视图只接一个只读投影「这个 key 是否已打开」。
    const isOpen = toggleCapable === true && isTabOpen(key) === true;
    const accessibleName = (isOpen ? "在侧边栏关闭 " : "在侧边栏打开 ") + label;
    const buttonProps = {
      type: "button",
      className: "deg_expert_group_sidebar_action",
      title: accessibleName,
      "aria-label": accessibleName,
      onClick: (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return handleSidebarAction(key, resourceAddress);
      },
      onKeyDown: (event) => { event?.stopPropagation?.(); },
    };
    if (toggleCapable === true) {
      // aria-pressed 表达 toggle 语义；data-open 让主题样式精确命中打开态（青色 <<）。
      buttonProps["aria-pressed"] = isOpen;
      buttonProps["data-open"] = isOpen ? "true" : "false";
    }
    // 两个方向都是「两个同向图标」：打开是 >>，打开态是 <<。图标清单与 makeIcon 的具名图标
    // 契约一致，两条分支都已确认对应具名图标存在（右箭头在上面的渲染条件里，左箭头在能力判定里）。
    const arrowIcon = isOpen ? "IconChevronLeftOutlineRegular" : "IconChevronRightOutlineRegular";
    return react.createElement("button", buttonProps, react.createElement("span", {
      className: "deg_expert_group_double_arrow",
      "data-direction": isOpen ? "close" : "open",
      "aria-hidden": "true",
    },
    makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
    makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true })));
  };

  /**
   * attempt 详情（票据 25）：input/output/cache/reasoning tokens 与 requests/retries/fallbacks/runMs，
   * 以及按 meta.modelPrices 计算的估算成本；缺失字段显示「—」，无单价显示「未配置单价，不估算」。
   */
  const renderAttemptUsage = (ctx, entry, options) => {
    const { react } = ctx;
    const source = object(entry);
    const usage = usageOf(source);
    const fallbackProvider = text(object(options).provider, null);
    const fallbackModel = text(object(options).model, null);
    const value = (field) => (usage === null ? null : finiteToken(usage[field]));
    const pairs = [
      ["输入", value("inputTokens")],
      ["输出", value("outputTokens")],
      ["缓存读", value("cacheReadTokens")],
      ["缓存写", value("cacheWriteTokens")],
      ["推理", value("reasoningTokens")],
    ].map(([label, raw]) => label + " " + (raw === null ? "—" : String(raw)));
    pairs.push("请求 " + (value("requests") === null ? "—" : String(value("requests"))));
    pairs.push("重试 " + (value("retries") === null ? "—" : String(value("retries"))));
    pairs.push("降级 " + (value("fallbacks") === null ? "—" : String(value("fallbacks"))));
    pairs.push("运行时长 " + (formatDurationText(value("runMs")) ?? "—"));
    // 单价按 usage 自带的 provider/model 匹配；缺失时回退所属分片/任务（同一角色同一模型）。
    const provider = (usage === null ? null : text(usage.provider, null)) ?? fallbackProvider;
    const modelId = (usage === null ? null : text(usage.model, null)) ?? fallbackModel;
    const price = findPriceOf(ctx, provider, modelId);
    let costText = "估算成本：未配置单价，不估算";
    let currency = null;
    const cost = usage === null ? null : estimateCostOf(ctx, usage, provider, modelId);
    if (price !== null && cost !== null) {
      currency = cost.currency;
      costText = "估算成本 ≈ " + (formatCost(cost.totalCost) ?? "—") + " " + cost.currency + "（按每百万 token 单价估算）";
    } else if (price !== null) {
      costText = "估算成本：—（缺少计费 token）";
    }
    return react.createElement("div", {
      className: "deg_expert_group_attempt_usage",
      "data-cost-currency": currency === undefined ? undefined : currency,
      title: (usage === null ? "用量：—" : usageTitleOf(usage)) + " · " + costText,
    },
    react.createElement("span", { className: "deg_expert_group_attempt_usage_tokens" }, pairs.join(" · ")),
    react.createElement("span", { className: "deg_expert_group_attempt_cost", "data-cost-configured": price === null ? "false" : "true" }, costText));
  };

  /**
   * 结构化结果区（票据 30）：有 value 时有界 JSON 预览（超长截断并提示），回退时显示稳定原因；
   * 绝不显示 schema 原文（Host 本来就不投影它），也不改变既有文本总结的展示。
   */
  const renderStructuredBlock = (ctx, value, requested, options) => {
    const { react } = ctx;
    const api = modelApi();
    const preview = typeof api?.structuredPreviewOf === "function" ? api.structuredPreviewOf(value) : null;
    const asked = requested === true;
    if (preview === null && asked !== true) return null;
    const kind = text(object(options).kind, "expert");
    let textValue = "结构化结果：尚未返回（已请求输出契约）";
    let fallback = false;
    let truncated = false;
    let reason = null;
    if (preview !== null) {
      if (preview.text !== null) {
        textValue = "结构化结果：" + preview.text + (preview.truncated === true ? " …（预览已截断）" : "");
        truncated = preview.truncated === true;
      } else {
        fallback = true;
        reason = text(preview.reason, "result_unavailable");
        const reasonText = typeof api?.structuredFallbackText === "function"
          ? api.structuredFallbackText(reason)
          : "结构化结果不可用";
        textValue = "结构化结果回退：" + reasonText + "（" + reason + "）";
      }
    }
    return react.createElement("div", {
      className: "deg_expert_group_structured",
      "data-kind": kind,
      "data-fallback": fallback ? "true" : undefined,
      "data-reason": reason === null ? undefined : reason,
      "data-truncated": truncated ? "true" : undefined,
      // role=status 让回退/截断对辅助技术可见；完整预览仍受 title 的 400 字符上限约束。
      role: "status",
      title: textValue.length > 400 ? textValue.slice(0, 400) + "…" : textValue,
    }, textValue);
  };

  const renderFailureSummary = (ctx, failure) => {
    const { react } = ctx;
    const summary = failureSummaryText(failure);
    if (summary === null) return null;
    const content = summary.message === null ? summary.code : summary.code + " · " + summary.message;
    return react.createElement("span", {
      key: "failure",
      className: "deg_expert_group_failure",
      "data-failure-code": summary.code,
      role: "status",
      title: content,
    }, content);
  };

  /**
   * attempt 时间线（只读）：默认最近 N 条，可切换「查看全部 / 收起」。
   *
   * 只由展开的分片渲染（key 形如 shard:<root>:<parentTask>:<shard>）：同一个分片在轮询
   * 刷新后仍复用同一份展开状态，切换 root 后不会污染别的会话。父任务不再渲染跨分片聚合
   * 视图，因此条目不再携带分片归属单元格。
   * 时间线本体没有任何按钮/链接，只有条数切换按钮。
   */
  const renderAttemptTimeline = (ctx, node, options = {}) => {
    const { react, isTimelineExpanded, toggleTimelineExpanded } = ctx;
    const timelineOf = modelFunction("attemptTimelineOf");
    if (timelineOf === null) return null;
    const key = text(options.key, null);
    if (key === null) return null;
    // 展开选择是本帧实例状态（有界 Set + 重渲染），视图只读投影、不持有可写 Set。
    const expanded = isTimelineExpanded(key) === true;
    let timeline = null;
    try { timeline = timelineOf(node, { expanded }); } catch { return null; }
    if (timeline === null || !Array.isArray(timeline.entries)) return null;
    // 单价匹配的回退归属：分片/任务自身投影的 provider/model（attempt 上没有这两个字段）。
    const timelineProvider = text(object(node).provider, null);
    const timelineModel = text(object(node).model, null);
    const rows = timeline.entries.map((entry, index) => {
      const attemptStatus = text(entry.status, "unknown");
      const attemptNumber = finiteNumber(entry.attempt) ?? finiteNumber(entry.position) ?? index + 1;
      const duration = formatDurationText(entry.durationMs);
      const timestamp = finiteNumber(entry.finishedAt) ?? finiteNumber(entry.startedAt);
      const clock = formatClockText(timestamp);
      const durationLabel = duration === null ? (clock ?? "—") : duration;
      const cells = [
        react.createElement("span", { key: "index", className: "deg_expert_group_attempt_index" }, "#" + attemptNumber),
        react.createElement("span", {
          key: "status",
          className: "deg_expert_group_attempt_status",
          "data-status": attemptStatus,
        }, ATTEMPT_STATUS_LABELS[attemptStatus] ?? attemptStatus),
        react.createElement("span", {
          key: "duration",
          className: "deg_expert_group_attempt_duration",
          title: durationLabel,
        }, durationLabel),
      ];
      if (duration !== null && clock !== null) {
        cells.push(react.createElement("span", {
          key: "time",
          className: "deg_expert_group_attempt_time",
          title: formatIsoText(timestamp) ?? clock,
        }, clock));
      }
      return react.createElement("div", {
        key: key + ":" + attemptNumber + ":" + index,
        className: "deg_expert_group_attempt",
        role: "listitem",
        "data-status": attemptStatus,
        "data-attempt": String(attemptNumber),
      },
      // 第一行保持既有的序号/状态/耗时/时间单元格（文本顺序与旧结构逐字一致）。
      react.createElement("div", { className: "deg_expert_group_attempt_row" }, ...cells),
      // 票据 25/30：attempt 详情（用量/成本 + 结构化结果）。只读、无按钮，
      // 时间线唯一的交互仍是「查看全部/收起」。
      renderAttemptUsage(ctx, entry, {
        provider: text(entry.provider, null) ?? timelineProvider,
        model: text(entry.model, null) ?? timelineModel,
      }),
      renderStructuredBlock(ctx, entry.structured, entry.outputSchemaRequested, { kind: "attempt" }));
    });
    const toggle = timeline.total > timeline.limit
      ? react.createElement("button", {
        key: "toggle",
        type: "button",
        className: "deg_expert_group_attempts_toggle",
        "aria-expanded": expanded,
        "aria-label": expanded ? "收起尝试时间线" : "查看全部尝试时间线",
        title: expanded ? "只显示最近 " + timeline.limit + " 条" : "查看全部 " + timeline.total + " 条",
        onClick: (event) => {
          // 时间线在可导航行内部：按钮点击绝不触发行导航或折叠。
          event?.preventDefault?.();
          event?.stopPropagation?.();
          // 有界记账 + 重渲染由 Panel 的命令统一执行（视图不持有可写 Set）。
          toggleTimelineExpanded(key);
        },
      }, expanded ? "收起" : "查看全部")
      : null;
    return react.createElement("div", {
      className: "deg_expert_group_attempts",
      role: "list",
      "aria-label": "尝试时间线",
      "data-total": String(timeline.total),
      "data-expanded": expanded,
    }, ...rows, toggle);
  };

  /**
   * 绑定「本帧视图上下文」的渲染函数集合。
   *
   * ctx = Panel 本帧的只读投影 + 窄命令（字段清单见每个函数顶部的解构）。
   * 每次渲染新建一份：与拆分前「Panel 内每帧新建箭头函数」的闭包时序逐字等价，
   * 绝不缓存函数、绝不跨帧复用（否则会看到上一帧的 session/root）。
   */
  function createSidebarViewsA(ctx) {
    const deps = ctx;
    // 角色显示名表是本帧快照 + meta 的纯投影（渲染期只读），随 ctx 一起按帧重建。
    const mergedRoleLabels = mergedRoleLabelsOf(deps.snapshot, deps.meta);
    const roleLabelFor = (role, nodeLabel) => roleLabelForBase(role, nodeLabel, mergedRoleLabels);
    return Object.freeze({
      mergedRoleLabels,
      roleLabelFor,
      finiteToken,
      usageOf,
      usageTitleOf,
      renderChevron: (node, open) => renderChevron(deps, node, open),
      renderAction: (label, Icon, onClick, pending) => renderAction(deps, label, Icon, onClick, pending),
      renderSidebarBatchSlot: (addresses, label) => renderSidebarBatchSlot(deps, addresses, label),
      renderSidebarOpenAction: (address, label) => renderSidebarOpenAction(deps, address, label),
      renderAttemptUsage: (entry, options) => renderAttemptUsage(deps, entry, options),
      renderStructuredBlock: (value, requested, options) => renderStructuredBlock(deps, value, requested, options),
      renderFailureSummary: (failure) => renderFailureSummary(deps, failure),
      renderAttemptTimeline: (node, options) => renderAttemptTimeline(deps, node, options),
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarViewsA });
})(globalThis);
