/**
 * 客户端侧栏 · Panel 视图层（第二组：会话投影读取 / 用量摘要条 / 主行）— R6 / sidebar-views-b
 *
 * ## 职责边界（R6 票据 23）
 * Panel 渲染期**只读投影**的第二段：DSH 会话投影（sessionStats / tokenUsage / contextPressure）
 * 的读取与聚合、运行时间解析、任务行用量摘要条，以及行主体（任务名 + 元数据 + 打开箭头）。
 *
 * ## 视图层不持有可写状态
 * 本文件没有 state / ref / setter：
 * - 投影读取只依赖注入的 `sessionsSnapshot` / `config` 只读读面（第三读面走 try/catch）；
 * - 未在途动作/展开状态由调用方的锁投影与命令表达，本文件不接触任何容器。
 *
 * ## 与 React Hook 的关系
 * 本文件没有任何 Hook。Panel 仍在原位置调用自己的 Hook，然后每帧调用
 * `createSidebarViewsB(ctx, viewsA)` 取回绑定好当前帧上下文的渲染函数。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-views-b")]
 * 装配：依赖 client-sidebar-pure.js / client-sidebar-dom.js / client-sidebar-views-a.js 的检查点。
 */
(function installClientSidebarViewsB(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-b");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    finiteNumber, formatCompactDuration, isFailureStatusOf, latestShardChildIdOf, modelApi,
    object, retryWarningThreshold, statusOf, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { metadataOf, titleOf } = DOM;

  /** 会话摘要（sessions 快照 byId 投影）：只读、缺失返回 null（绝不造空对象）。 */
  const sessionSummaryOf = (ctx, sessionId) => {
    const { sessionsSnapshot } = ctx;
    if (sessionId === null) return null;
    const summary = object(object(sessionsSnapshot.byId)[sessionId]);
    return Object.keys(summary).length === 0 ? null : summary;
  };
  /**
   * 通用 DSH 会话投影读取（contextPressure / sessionStats / tokenUsage 共用）。
   *
   * 读面顺序与 contextPressure 完全一致，避免每种投影各写一套回退链：
   * 1. sessions 快照 byId[sessionId].projectionValues[key]（新宿主）；
   * 2. sessions 快照 projectionsBySession[sessionId].values[key]（目录投影容器）；
   * 3. config.sessions.projectionValues(sessionId)（旧宿主/注入式读面，try/catch）；
   *    该读面可能返回整个投影容器，也可能直接返回该投影值本身，两种形状都接受。
   * 三条都缺失时返回 null；形状与数值校验由调用方完成（绝不伪造）。
   */
  const projectionValueOf = (ctx, sessionId, key) => {
    const { sessionsSnapshot, config } = ctx;
    if (sessionId === null || key === null) return null;
    const summary = object(sessionSummaryOf(ctx, sessionId));
    const fromSummary = object(summary.projectionValues)[key];
    if (fromSummary !== undefined && fromSummary !== null) return fromSummary;
    const projection = object(object(object(sessionsSnapshot.projectionsBySession)[sessionId]).values);
    const fromProjection = projection[key];
    if (fromProjection !== undefined && fromProjection !== null) return fromProjection;
    const readProjection = config.sessions?.projectionValues;
    if (typeof readProjection !== "function") return null;
    try {
      const value = readProjection.call(config.sessions, sessionId);
      const container = object(value);
      if (container[key] !== undefined && container[key] !== null) return container[key];
      return value === undefined ? null : value;
    } catch {
      return null;
    }
  };
  /** contextPressure 投影的形状校验：至少一个数值字段才是合法形状，否则返回 null。 */
  const contextPressureOfValue = (value) => {
    const source = object(value);
    for (const field of ["projectedTokens", "pressureTokens", "contextWindow"]) {
      if (finiteNumber(source[field]) !== null) return source;
    }
    return null;
  };
  /**
   * 子会话的 contextPressure（上下文占用率的唯一来源）。
   * 三条读面统一走 projectionValueOf；缺失/非法时返回 null —— 摘要条整段省略，绝不伪造。
   */
  const contextPressureOf = (ctx, sessionId) => contextPressureOfValue(projectionValueOf(ctx, sessionId, "contextPressure"));
  /** DSH 投影里的有限数（允许 0，负数/非有限数一律 null）。 */
  const projectionNumber = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  /** DSH sessionStats 里参与「用时/输出速度」的字段。 */
  const DSH_STATS_FIELDS = Object.freeze(["llmMs", "toolMs", "decodeMs", "decodeTokens"]);
  /** DSH tokenUsage 的四项口径。 */
  const DSH_TOKEN_FIELDS = Object.freeze([
    "uncachedInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens",
  ]);
  /**
   * DSH 权威会话指标的聚合读取（sessionStats + tokenUsage）。
   *
   * - 单会话行传 [node.sessionId]；分片传最新 attempt 的 childId；
   * - fan-out 父任务传各 shard 最新 attempt 的 childId（按 childId 去重）；
   * - 同名字段逐会话相加，只有真的出现过数值才保留（缺失保持 null，绝不补 0）；
   * - 一条有效字段都没有时返回 null，调用方回退 DEG usage/duration。
   */
  const dshMetricsOf = (ctx, sessionIds) => {
    const ids = Array.isArray(sessionIds) ? sessionIds : [];
    const stats = {};
    const tokens = {};
    let contributors = 0;
    for (const rawId of ids) {
      const sessionId = text(rawId, null);
      if (sessionId === null) continue;
      const statsValue = object(projectionValueOf(ctx, sessionId, "sessionStats"));
      const tokensValue = object(projectionValueOf(ctx, sessionId, "tokenUsage"));
      let touched = false;
      for (const field of DSH_STATS_FIELDS) {
        const value = projectionNumber(statsValue[field]);
        if (value === null) continue;
        stats[field] = (stats[field] ?? 0) + value;
        touched = true;
      }
      for (const field of DSH_TOKEN_FIELDS) {
        const value = projectionNumber(tokensValue[field]);
        if (value === null) continue;
        tokens[field] = (tokens[field] ?? 0) + value;
        touched = true;
      }
      if (touched) contributors += 1;
    }
    if (contributors === 0) return null;
    const valueOf = (bag, field) => (bag[field] === undefined ? null : bag[field]);
    return {
      sessionCount: contributors,
      llmMs: valueOf(stats, "llmMs"),
      toolMs: valueOf(stats, "toolMs"),
      decodeMs: valueOf(stats, "decodeMs"),
      decodeTokens: valueOf(stats, "decodeTokens"),
      uncachedInputTokens: valueOf(tokens, "uncachedInputTokens"),
      cacheReadTokens: valueOf(tokens, "cacheReadTokens"),
      cacheWriteTokens: valueOf(tokens, "cacheWriteTokens"),
      outputTokens: valueOf(tokens, "outputTokens"),
    };
  };
  /**
   * 把 DSH tokenUsage 转成 summarizeUsageMetrics 认识的 usage 形状。
   *
   * billedInput / total 只在分母可证明（uncached/cacheRead/cacheWrite 全部存在）时计算：
   * 任何一项缺失都保持 null，让「命中」「tok」整段省略，绝不用部分和冒充总量。
   */
  const dshUsageOf = (metrics) => {
    if (metrics === null) return null;
    const { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens } = metrics;
    if (uncachedInputTokens === null && cacheReadTokens === null && cacheWriteTokens === null && outputTokens === null) {
      return null;
    }
    const complete = uncachedInputTokens !== null && cacheReadTokens !== null && cacheWriteTokens !== null;
    const billedInputTokens = complete ? uncachedInputTokens + cacheReadTokens + cacheWriteTokens : null;
    return {
      inputTokens: uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      billedInputTokens,
      totalTokens: billedInputTokens !== null && outputTokens !== null ? billedInputTokens + outputTokens : null,
    };
  };
  /** DSH 输出速度（tok/s）：decodeTokens ÷ (decodeMs/1000)，两端都必须是正数。 */
  const dshThroughputOf = (metrics) => {
    if (metrics === null || metrics.decodeMs === null || metrics.decodeTokens === null) return null;
    if (metrics.decodeMs <= 0 || metrics.decodeTokens <= 0) return null;
    return metrics.decodeTokens / (metrics.decodeMs / 1000);
  };
  /** fan-out 父任务的会话集合：每个 shard 最新 attempt 的 childId（按 childId 去重）。 */
  const fanoutSessionIdsOf = (task) => {
    const ids = [];
    const seen = new Set();
    const source = object(task);
    for (const shard of Array.isArray(source.shards) ? source.shards : []) {
      const childId = latestShardChildIdOf(shard);
      if (childId === null || seen.has(childId)) continue;
      seen.add(childId);
      ids.push(childId);
    }
    return ids;
  };
  /**
   * 该会话是否已经拿到了「可用的 sessionStats 投影」。
   *
   * 判定口径与 dshMetricsOf 的「有效字段」一致：至少一个数值字段才算存在。不能只判
   * 「非 null」——第三读面（旧宿主 config.sessions.projectionValues）可能返回整个投影容器，
   * 那样会把容器误当成 sessionStats，从而永远不触发按需加载。
   */
  const sessionStatsPresentOf = (ctx, sessionId) => {
    const value = object(projectionValueOf(ctx, sessionId, "sessionStats"));
    for (const field of DSH_STATS_FIELDS) {
      if (projectionNumber(value[field]) !== null) return true;
    }
    return false;
  };

  /**
   * 运行时间（毫秒）的唯一解析顺序：节点 durationMs → 用量 runMs → 起止时间差。
   *
   * 起止时间差（任何行都适用，包括没有 sessionId 的 fan-out 父任务）：
   * - 起点：节点 startedAt 优先（分片跨 attempt 时以分片起点为准），其次会话 createdAt；
   * - 运行中终点：**DEG Host 快照** snapshot.generatedAt 优先——生产环境的 sessions 列表
   *   快照（DSH getListSnapshot）只有 items/state/phase/error/projectionsBySession，没有
   *   generatedAt，因此 sessionsSnapshot.generatedAt 仅作旧宿主兼容兜底；
   * - 非运行中终点：会话 updatedAt，其次节点 lastActivityAt（fan-out/分片没有会话时用它）；
   * - 差值必须 > 0，否则 null（摘要条省略「用时」，绝不写 0）。
   */
  const durationOfNode = (ctx, source, runtimeStatus, sessionId) => {
    const { snapshot, sessionsSnapshot } = ctx;
    const direct = finiteNumber(source.durationMs);
    if (direct !== null) return direct;
    const usage = ctx.a.usageOf(source);
    const runMs = finiteNumber(usage === null ? null : usage.runMs);
    if (runMs !== null) return runMs;
    const summary = object(sessionSummaryOf(ctx, sessionId));
    const startedAt = finiteNumber(source.startedAt) ?? finiteNumber(summary.createdAt);
    if (startedAt === null) return null;
    const endedAt = runtimeStatus === "running"
      ? (finiteNumber(object(snapshot).generatedAt) ?? finiteNumber(sessionsSnapshot.generatedAt))
      : (finiteNumber(summary.updatedAt) ?? finiteNumber(source.lastActivityAt));
    if (endedAt === null) return null;
    const elapsed = endedAt - startedAt;
    return elapsed > 0 ? elapsed : null;
  };
  /**
   * 任务行的用量摘要条：用时 · tok/s · tok · 命中 · context 五段（异常提示另算）。
   *
   * 数字与文本全部由模型层 summarizeUsageMetrics 生成，这里只负责按固定顺序摆放：
   * 缺失段整段省略（不写 0/占位词）；五段全空且没有「多次重试」/失败摘要时整行不渲染。
   * 每段都带一个有界 title tooltip，tok 段复用 usageTitleOf 的完整用量摘要。
   */
  const renderMetrics = (ctx, node, options = {}) => {
    const { react } = ctx;
    const source = object(node);
    const status = statusOf(source);
    const kind = text(options.kind, text(source.kind, "expert"));
    const runtimeStatus = text(options.runtimeStatus, null);
    const sessionId = text(options.sessionId, null);
    const sessionIds = Array.isArray(options.sessionIds)
      ? options.sessionIds
      : (sessionId === null ? [] : [sessionId]);
    const api = modelApi();
    // DSH 权威投影优先：sessionStats（模型用时 / 输出速度）+ tokenUsage（tok / 命中）。
    // 投影缺失（旧宿主或尚未加载）时逐项回退 DEG usage 与 durationOfNode，绝不伪造。
    const dsh = dshMetricsOf(ctx, sessionIds);
    const dshUsage = dshUsageOf(dsh);
    const usage = dshUsage !== null ? dshUsage : ctx.a.usageOf(source);
    const measuredTps = dshThroughputOf(dsh);
    const dshLlmMs = dsh === null ? null : dsh.llmMs;
    const dshDuration = dshLlmMs !== null && dshLlmMs > 0 ? dshLlmMs : null;
    // 用时口径（用户要求）：优先使用 Host 由 turn/start → now（或 turn/end）计算的
    // 墙钟，与 DSH 状态行「用时 …」同源；旧快照没有该字段时才回退模型用时/会话时间。
    const turnDurationMs = finiteNumber(source.turnDurationMs);
    const durationMs = turnDurationMs !== null
      ? turnDurationMs
      : (dshDuration !== null ? dshDuration : durationOfNode(ctx, source, runtimeStatus, sessionId));
    const summary = typeof api?.summarizeUsageMetrics === "function"
      ? api.summarizeUsageMetrics(usage, {
        durationMs,
        contextPressure: contextPressureOf(ctx, sessionId),
        measuredTokensPerSecond: measuredTps,
      })
      : null;
    const segments = [];
    const pushSegment = (key, textValue, titleValue) => {
      if (typeof textValue !== "string" || textValue.length === 0) return;
      if (segments.length > 0) {
        segments.push(react.createElement("span", {
          key: key + "-separator",
          className: "deg_expert_group_metrics_separator",
          "aria-hidden": "true",
        }, " · "));
      }
      segments.push(react.createElement("span", {
        key,
        className: "deg_expert_group_metrics_part",
        title: typeof titleValue === "string" ? titleValue : textValue,
      }, textValue));
    };
    if (summary !== null) {
      // 用时 tooltip：DSH 显示「模型用时」，并补充工具调用用时；回退 DEG 时仍写「运行时间」。
      const toolDurationText = dsh === null || dsh.toolMs === null ? null : formatCompactDuration(dsh.toolMs);
      const modelDurationText = dshDuration === null ? null : formatCompactDuration(dshDuration);
      // 墙钟口径下 tooltip 主文案写「本轮用时」，并把模型/工具用时作为补充信息保留；
      // 旧快照仍沿用「模型用时 / 运行时间」的既有文案。
      const durationTitle = summary.durationText === null ? null
        : turnDurationMs !== null
          ? "本轮用时 " + summary.durationText
            + (modelDurationText === null ? "" : " · 模型用时 " + modelDurationText)
            + (toolDurationText === null ? "" : " · 工具调用用时 " + toolDurationText)
          : dshDuration !== null
            ? "模型用时 " + summary.durationText + (toolDurationText === null ? "" : " · 工具调用用时 " + toolDurationText)
            : "运行时间 " + summary.durationText;
      pushSegment("duration", summary.durationText === null ? null : "用时" + summary.durationText, durationTitle);
      pushSegment("throughput", summary.throughputText,
        summary.throughputText === null ? null : (measuredTps === null ? "平均吞吐 " : "输出速度 ") + summary.throughputText);
      // tok 段的 tooltip 用完整用量摘要（输入/输出/缓存/请求等），并做与结构化预览同级的 400 字符上限。
      const usageTitle = usage === null ? null : ctx.a.usageTitleOf(usage);
      pushSegment("tokens", summary.totalTokensText,
        usageTitle === null ? summary.totalTokensText : usageTitle.slice(0, 400));
      pushSegment("cache-hit", summary.cacheHitText,
        summary.cacheHitPercent === null ? null : "缓存命中率 " + summary.cacheHitPercent + "%（缓存读 ÷ 计费输入）");
      pushSegment("context", summary.contextText,
        summary.contextPercent === null ? null
          : "上下文占用 " + summary.contextPercent + "%（已用 " + summary.contextUsedTokens + " / 窗口 " + summary.contextWindow + "）");
    }
    const retryCount = finiteNumber(source.retryCount);
    const retryWarning = retryCount !== null && retryCount >= retryWarningThreshold()
      ? react.createElement("span", {
        key: "retry-warning",
        className: "deg_expert_group_retry_warning",
        "data-retry-warning": "true",
        role: "status",
        // 不写「接近尝试上限」：Host 不发布 maxAttempts，我们没有可证明的上限。
        title: "已重试 " + retryCount + " 次",
      }, "多次重试")
      : null;
    const failure = isFailureStatusOf(status) ? ctx.a.renderFailureSummary(source.failure) : null;
    // 五段全空且没有异常提示时整行不渲染：旧快照不会留下一条空白的摘要线。
    if (segments.length === 0 && retryWarning === null && failure === null) return null;
    return react.createElement("div", {
      className: "deg_expert_group_metrics",
      "data-metrics-kind": kind,
      role: "group",
      "aria-label": "任务用量摘要",
    }, ...segments, retryWarning, failure);
  };

  /**
   * 每个代理节点固定两行；行内容与折叠状态无关，永不因展开状态隐藏任何一行。
   * 第一行：任务名（根节点是固定「主代理」，专家是最新 dispatch 短描述）；
   * 第二行：角色 · provider · model · effort 元数据。
   *
   * 用户精简侧栏后，「标题 · 可继续｜一次性 · 正在运行｜当前未运行」摘要行已整体移除：
   * 运行状态仍由行首圆点表达，续接模式与权威标题不再单独占一行。
   *
   * 第一行文案完整交给 CSS 处理，渲染层不做任何 grapheme 硬截断——完整文本同时是
   * React 文本、title（悬浮提示）与无障碍标签的来源，用户始终能读到全名。
   * 省略行为按行粒度区分（options.oneLine）：
   * - 默认 true：普通专家/根节点维持单行省略（.deg_expert_group_line 的
   *   overflow:hidden + text-overflow:ellipsis + white-space:nowrap），节点行高与树线语义不变；
   * - false：fan-out 分片第一行是「分片代号  任务名称」的组合文本，代号会占满单行额度，
   *   因此改用可换行样式（见 .deg_expert_group_shard_task），在右栏窄宽度下完整展示多行名称。
   *
   * 可导航的第一行是 role=button 的 div（不是嵌套 <button>，避免无效 HTML）：
   * 鼠标点击行为不变，同时支持键盘 Enter/Space，并带 tabIndex 与 aria-label。
   *
   * 标题后的侧栏箭头是**独立**的 <button>（任务标题行的内联位置，绝不包在可导航 div 里）：
   * 它只打开右侧栏的 subagentchat 页，不参与主视图导航，因此点击必须拦下冒泡。
   */
  const renderRowMain = (ctx, node, options = {}) => {
    const { react, subagentAddressOfChild, handleOpen, navigation } = ctx;
    const source = object(node);
    const fullName = titleOf(source);
    const oneLine = options.oneLine !== false;
    const parentId = text(options.parentId, null);
    const clickableId = text(options.sessionId, text(source.sessionId, text(source.childId, null)));
    // 地址既决定主视图导航的目标形态（SubagentAddress 还是裸 session id），也决定侧栏
    // 箭头能否渲染；每行只解析一次，两条路径共用同一份结果。
    const address = subagentAddressOfChild(clickableId, parentId, source);
    // 工作区导航入口缺失（宿主未提供 uiWorkspace.openSession）时不渲染任何导航入口：
    // 行仍显示完整信息，但不再是 role=button，绝不留下点了没反应的按钮。
    const navigable = navigation.available === true && clickableId !== null;
    const onNavigate = navigable ? () => handleOpen(clickableId, address) : undefined;
    const onKeyDown = onNavigate === undefined ? undefined : (event) => {
      if (event?.key !== "Enter" && event?.key !== " ") return;
      // Space 默认会滚动页面，Enter 可能冒泡触发父级行为：两者都拦下。
      event.preventDefault?.();
      event.stopPropagation?.();
      onNavigate();
    };
    const taskLabel = "打开任务会话：" + fullName;
    const navigateProps = onNavigate === undefined ? {} : {
      role: "button",
      tabIndex: 0,
      "aria-label": taskLabel,
      onKeyDown,
    };
    const metadata = metadataOf(source, ctx.a.mergedRoleLabels);
    const taskClassName = "deg_expert_group_line deg_expert_group_task"
      + (oneLine ? "" : " deg_expert_group_shard_task");
    const trailing = options.trailing === undefined ? null : options.trailing;
    const taskChildren = [
      react.createElement("div", { className: taskClassName, title: fullName, onClick: onNavigate, ...navigateProps }, fullName),
      ctx.a.renderSidebarOpenAction(address, fullName),
    ];
    if (trailing !== null) taskChildren.push(trailing);
    const taskLine = react.createElement("div", {
      className: "deg_expert_group_task_line" + (trailing === null ? "" : " deg_expert_group_task_line_trailing"),
    }, ...taskChildren);
    // 主代理批量控件作为标题行的相邻 flex 项，标题收缩省略时控件仍固定在标题末尾。
    // 其它专家 / 分片 / 空闲成员不传 trailing，单会话箭头结构保持不变。
    // 两行主体必须保持恰好 2 个子节点（DOM 契约）：用量摘要条/attempt 时间线放在
    // 相邻块（.deg_expert_group_cell）里纵向排列，绝不改变两行网格的行数与顺序。
    const rowMain = react.createElement("div", { className: "deg_expert_group_row_main", "data-kind": source.kind || "expert", "data-expanded": true },
      taskLine,
      react.createElement("div", { className: "deg_expert_group_meta", title: metadata }, metadata));
    const extras = [];
    if (options.metrics !== undefined && options.metrics !== null) extras.push(options.metrics);
    if (options.footer !== undefined && options.footer !== null) extras.push(options.footer);
    if (extras.length === 0) return rowMain;
    return react.createElement("div", { className: "deg_expert_group_cell" }, rowMain, ...extras);
  };

  /**
   * 绑定「本帧视图上下文」的投影与渲染函数集合。
   *
   * ctx = Panel 本帧的只读投影（sessionsSnapshot / config / snapshot）+ 兄弟模块视图 API；
   * viewsA 提供用量归一、角色显示名、打开箭头与失败摘要（同属视图层，纯读）。
   * 每次渲染新建一份，绝不缓存（否则会看到上一帧的会话投影）。
   */
  function createSidebarViewsB(ctx, viewsA) {
    const deps = { ...ctx, a: viewsA };
    return Object.freeze({
      sessionStatsPresentOf: (sessionId) => sessionStatsPresentOf(deps, sessionId),
      durationOfNode: (source, runtimeStatus, sessionId) => durationOfNode(deps, source, runtimeStatus, sessionId),
      fanoutSessionIdsOf: (task) => fanoutSessionIdsOf(task),
      renderMetrics: (node, options) => renderMetrics(deps, node, options),
      renderRowMain: (node, options) => renderRowMain(deps, node, options),
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarViewsB });
})(globalThis);
