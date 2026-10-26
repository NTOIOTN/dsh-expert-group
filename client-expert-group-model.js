/**
 * 专家组客户端模型的**公开检查点**（R8 票据 29 拆分后的薄门面）。
 *
 * 票据 29 把原 1,881 行的单一模块按职责拆成两个模块：
 * 1. `client-expert-group-model-normalize.js`：归一与状态推导族（原语、状态推导、快照树归一）；
 * 2. `client-expert-group-model-format.js`：格式化/展示、视图辅助、过滤与导出、locale 族。
 *
 * 本文件只做一件事：按**原始的键集合与键顺序**把两个子模块的检查点重组成同一份冻结对象，
 * 并通过原来的 `dsh-expert-group/client-expert-group-model` 检查点发布。因此
 * client.js / client-sidebar-pure.js / client-text.js 与全部既有测试都不需要改读取方式，
 * 公开导出面与拆分前逐项一致（键集合与顺序都一致）。
 *
 * ## 依赖方向（单一，由 scripts/check-dependency-graph.mjs 验证）
 * normalize → format → 本文件。两个子模块都不读取本文件；本文件只读它们的检查点。
 * 装配顺序见 scripts/client-source-manifest.mjs（normalize → format → 本文件，
 * 且都先于唯一 descriptor 与所有读取方）。
 *
 * ## 缺失子模块时 fail-closed
 * 本文件在装载期就解构两个子模块的检查点。任一检查点不存在时立即抛错（而不是静默发布
 * 一份全 undefined 的导出面）——装配顺序是硬前提，构建期与 test-support 都按 manifest 装载。
 */
(function installExpertGroupModel(global) {
  "use strict";

  /** 本次拆分的两个子模块检查点（同一次装配里由它们先写入）。 */
  const normalizeSymbol = Symbol.for("dsh-expert-group/client-expert-group-model-normalize");
  const formatSymbol = Symbol.for("dsh-expert-group/client-expert-group-model-format");
  const normalize = global[normalizeSymbol];
  const format = global[formatSymbol];
  if (!normalize || !format) {
    throw new Error("专家组客户端模型子模块未装载：normalize / format 检查点缺失（装配顺序见 client-source-manifest.mjs）");
  }

  // ── 归一与状态推导族（client-expert-group-model-normalize.js）────────────────
  const {
    RUNTIME_STATUSES,
    UNKNOWN_RUNTIME_STATUS,
    normalizeExpertGroupSnapshot,
    normalizeCapabilities,
    normalizeFailure,
    normalizeUsage,
    normalizeStructured,
    roleLabelFrom,
    roleLabelOf,
    findModelPrice,
    estimateUsageCost,
    runtimeStatusOf,
  } = normalize;

  // ── 格式化/展示、视图辅助、过滤导出与 locale 族（client-expert-group-model-format.js）──
  const {
    FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
    RETRY_WARNING_THRESHOLD,
    STATUS_FILTER_GROUPS,
    STRUCTURED_PREVIEW_MAX_CHARS,
    formatFailureSummary,
    isFailureStatus,
    formatDuration,
    formatClockTime,
    formatIsoTime,
    attemptTimelineOf,
    structuredFallbackText,
    structuredPreviewOf,
    formatTokenCount,
    redactDisplayText,
    createTaskFilter,
    filterSnapshot,
    serializeSnapshot,
    formatDurationCompact,
    summarizeUsageMetrics,
    isEmptyUsageMetrics,
    zeroFilledUsageMetrics,
    formatExpertMetadata,
    defaultExpanded,
    createExpansionStore,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
    MISSING_MESSAGE_TEXT,
    MESSAGE_CATALOG,
    normalizeLocale,
    resolveClientLocale,
    translateMessage,
  } = format;

  /**
   * 公开检查点键：与拆分前相同，只**减去**审计确认零读取的死导出（SCHEMA_VERSION /
   * ATTEMPT_TIMELINE_LIMIT / FAILURE_STATUSES / normalizeStatus / STRUCTURED_FALLBACK_REASONS /
   * normalizeRoleLabels / resolveLocale）。为什么等价：这些键在全仓库（含 test/、test-support/）
   * 没有任何读取点，删掉的只是对象字面量里的一行；实现在子模块内部若仍被使用则保有原实现与
   * 子模块导出（format 仍读 SCHEMA_VERSION / normalizeStatus / STRUCTURED_FALLBACK_REASONS，
   * 因此这些名字在子模块检查点里原样保留）。键顺序仍是导出契约。
   */
  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");

  global[SYMBOL] = Object.freeze({
    RUNTIME_STATUSES,
    UNKNOWN_RUNTIME_STATUS,
    // 票据 12：客户端时间线/过滤/导出的公开常量与纯函数。
    // 常量供渲染层与测试共用（避免两处各存一份阈值/上限）。
    FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
    RETRY_WARNING_THRESHOLD,
    STATUS_FILTER_GROUPS,
    normalizeExpertGroupSnapshot,
    normalizeCapabilities,
    normalizeFailure,
    formatFailureSummary,
    isFailureStatus,
    formatDuration,
    formatClockTime,
    formatIsoTime,
    attemptTimelineOf,
    // 票据 25 / 27 / 30：用量、结构化结果与角色显示名的纯函数与常量。
    STRUCTURED_PREVIEW_MAX_CHARS,
    normalizeUsage,
    normalizeStructured,
    structuredFallbackText,
    structuredPreviewOf,
    roleLabelFrom,
    roleLabelOf,
    findModelPrice,
    estimateUsageCost,
    formatTokenCount,
    redactDisplayText,
    createTaskFilter,
    filterSnapshot,
    serializeSnapshot,
    runtimeStatusOf,
    // 用量速览行（用户要求）：紧凑时长与「用时 · tok/s · tok · 命中 · context」五段投影。
    formatDurationCompact,
    summarizeUsageMetrics,
    // 用量速览：空摘要判定 + 「未开始 / 尚未投影」缺失段补 0（纯函数层，未知仍不写成 0）。
    isEmptyUsageMetrics,
    zeroFilledUsageMetrics,
    formatExpertMetadata,
    defaultExpanded,
    createExpansionStore,
    // 票据 19：文案层投影与 locale 解析（权威实现语义见 shared.js）。
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
    MISSING_MESSAGE_TEXT,
    MESSAGE_CATALOG,
    normalizeLocale,
    resolveClientLocale,
    translateMessage,
  });
})(globalThis);