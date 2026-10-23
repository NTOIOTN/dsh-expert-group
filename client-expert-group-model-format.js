/**
 * 专家组客户端模型的「格式化 / 展示」族（R8 票据 29）。
 *
 * 票据 29 把原 1,881 行的 client-expert-group-model.js 按职责拆成两个模块，本文件承接
 * **格式化、展示、视图辅助与 locale** 这一半：
 * 1. 格式化与展示：时长/时间/计数/吞吐/用量速览、失败摘要展示、结构化预览与脱敏；
 * 2. 视图辅助：默认展开规则、任务 id、本地存储包装与折叠状态存储工厂；
 * 3. 过滤与导出：本地任务过滤器、过滤快照、Markdown/JSON 导出；
 * 4. locale 族：语言标识归一、候选解析、客户端 locale 解析顺序与文案插值。
 *
 * ## 依赖方向（单一，由 scripts/check-dependency-graph.mjs 验证）
 * 本模块读取 client-expert-group-model-normalize.js 的检查点（原语与归一函数、同源常量）；
 * 反向读取被禁止 —— normalize 模块不得出现对本文件的读取。门面只读取两者并重组公开面。
 *
 * ## 归属完整性
 * 拆出的 76 个顶层函数在本模块与 normalize 模块中各有唯一归属（38 + 38）。
 *
 * 硬上限（文件 ≤1,500 行 / 函数 ≤200 行）由 scripts/check-module-size.mjs 实测。
 */
(function installExpertGroupModelFormat(global) {
  "use strict";

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（只服务装配期读取）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model-format");

  // ── 归一模块的检查点：同一次装配里由 normalize 先写入（顺序由 manifest 保证）────────
  // 只取本文件实际消费的符号：四个常量 + 六个原语 + 五个归一函数 + roleLabelFrom。
  const {
    SCHEMA_VERSION,
    MAX_NESTED_EXPERT_DEPTH,
    STRUCTURED_FALLBACK_REASONS,
    STRUCTURED_FALLBACK_REASON_SET,
    isObject,
    text,
    firstText,
    numberOrNull,
    countOrNull,
    redactFailurePaths,
    normalizeStatus,
    normalizeFailure,
    normalizeUsage,
    normalizeStructured,
    normalizeAttempt,
    roleLabelFrom,
  } = global[Symbol.for("dsh-expert-group/client-expert-group-model-normalize")];

  // ── 展示上限、重试阈值与失败状态/筛选分组（票据 12）──────────────────────────
  //
  // 这些常量只服务格式化/展示与过滤视图；归一层的同源常量（失败 code/message 归一上限、
  // 恢复原因码形态、能力原因码上限等）留在 normalize 模块，两处不重复定义。
  // 与 Host 投影的取值必须保持同值，破坏性改动需两边同步。

  /** UI 一行失败摘要的上限：比归一上限更紧，超长只保留可读前缀（见 formatFailureSummary）。 */
  const FAILURE_MESSAGE_DISPLAY_MAX_LENGTH = 120;

  /** 悬挂「多次重试」徽标的阈值。Host 不发布 maxAttempts，因此这里绝不用「接近上限」这类
   *  暗示存在已知上限的措辞；只表达「已经重试了很多次」这一可证明的事实。 */
  const RETRY_WARNING_THRESHOLD = 3;

  /** 展开时间线默认展示的最近 attempt 条数；「查看全部」由 UI 切换。 */
  const ATTEMPT_TIMELINE_LIMIT = 5;

  /**
   * 失败语义的状态集合（与 Host 的 FAILURE_STATUS_SET 同值）。
   *
   * cancelled 是用户主动取消，不算失败；只有 failed/timed_out/interrupted 才允许展示失败摘要。
   * 只在失败节点展示摘要，避免「重试后已成功」的分片把历史错误继续挂在行上。
   */
  const FAILURE_STATUSES = Object.freeze(["failed", "timed_out", "interrupted"]);

  /**
   * 状态筛选分组：UI 的下拉选项直接用这些键。
   *
   * 使用分组而不是逐状态，是为了不把协议词表暴露给用户：用户只关心
   * 「还在跑 / 失败了 / 成功 / 取消 / 空闲」这五类。unknown 归入空闲组（UI 本来就把
   * 证据不足的节点显示在空闲分组里）。
   */
  const STATUS_FILTER_GROUPS = Object.freeze({
    running: Object.freeze(["queued", "waiting", "running"]),
    failed: Object.freeze(["failed", "timed_out", "interrupted"]),
    succeeded: Object.freeze(["succeeded"]),
    cancelled: Object.freeze(["cancelled"]),
    idle: Object.freeze(["idle", "ready", "unknown"]),
  });

  /**
   * 默认折叠的状态词表：这四个状态代表「没有正在进行的工作」，默认收起。
   *
   * 提为模块级常量而不是在 defaultExpanded 里每次新建 Set：该函数位于渲染路径上，
   * 未手动覆盖展开状态的每个节点每帧都要判定一次，而词表内容恒定不变。
   */
  const DEFAULT_COLLAPSED_STATUSES = new Set(["idle", "ready", "succeeded", "cancelled"]);

  /** 单条结构化结果 JSON 预览的字符上限：UI 只显示有界前缀，完整值仍留在导出 JSON 里。 */
  const STRUCTURED_PREVIEW_MAX_CHARS = 400;

  // ── 文案层（票据 19）────────────────────────────────────────────────────
  //
  // 权威消息表在 shared.js（Host 与客户端共享语义）；浏览器 classic bundle 无法 import
  // ESM，因此这里保留一份**逐键同值**的投影。两份漂移由 test/expert-group-model.test.mjs
  // 直接对比 shared.MESSAGE_CATALOG 守住（不是靠注释约定）。
  const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);
  const DEFAULT_LOCALE = "zh";
  const MISSING_MESSAGE_TEXT = "—";
const MESSAGE_CATALOG = Object.freeze({
  "sidebar.title": { zh: "Expert Group", en: "Expert Group" },
  "sidebar.empty": { zh: "暂无 Expert Group 任务", en: "No Expert Group tasks yet" },
  "sidebar.error.snapshot": { zh: "快照读取失败", en: "Snapshot read failed" },
  "sidebar.error.action": { zh: "操作失败", en: "Action failed" },
  "sidebar.error.rpc": { zh: "请求失败", en: "Request failed" },
  "sidebar.refresh": { zh: "刷新", en: "Refresh" },
  "sidebar.retry": { zh: "重试", en: "Retry" },
  "sidebar.partial": { zh: "数据不完整", en: "Incomplete data" },
  "sidebar.partial.title": {
    zh: "数据不完整：轻量快照已先上屏，状态与任务名可能尚未读取完整",
    en: "Incomplete data: a lightweight snapshot is shown first; statuses and task names may not be fully loaded yet",
  },
  "sidebar.updated": { zh: "更新于 {time}", en: "Updated {time}" },
  "sidebar.updated.title": {
    zh: "最后更新时间（本次数据上屏的时刻）",
    en: "Last update time (when this data was rendered)",
  },
  "sidebar.idleGroup": { zh: "空闲子代理（{count}）", en: "Idle subagents ({count})" },
  "sidebar.idleGroup.name": { zh: "空闲子代理", en: "Idle subagents" },
  "sidebar.search.label": { zh: "任务过滤", en: "Filter tasks" },
  "sidebar.search.aria": { zh: "搜索任务", en: "Search tasks" },
  "sidebar.search.placeholder": { zh: "搜索任务名 / 角色 / 模型", en: "Search task name / role / model" },
  "sidebar.filter.role": { zh: "按角色筛选", en: "Filter by role" },
  "sidebar.filter.status": { zh: "按状态筛选", en: "Filter by status" },
  "sidebar.filter.allRoles": { zh: "全部角色", en: "All roles" },
  "sidebar.filter.allStatuses": { zh: "全部状态", en: "All statuses" },
  "sidebar.filter.empty": { zh: "没有匹配的任务", en: "No matching tasks" },
  "sidebar.collapse": { zh: "收起", en: "Collapse" },
  "sidebar.expand": { zh: "展开", en: "Expand" },
  "sidebar.timeline.showAll": { zh: "查看全部", en: "Show all" },
  "sidebar.recovery.retry": { zh: "重试恢复", en: "Retry recovery" },
  "sidebar.recovery.retrying": { zh: "重试中…", en: "Retrying…" },
  "sidebar.recovery.failed": { zh: "任务恢复失败（{code}）", en: "Task recovery failed ({code})" },
  "sidebar.recovery.retryFailed": { zh: "重试未恢复（{code}）", en: "Retry did not recover ({code})" },
  "sidebar.sessionModel.open": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.title": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.hint": {
    zh: "只影响本会话的专家派发，不改变全局默认；清除后恢复跟随全局默认。",
    en: "Affects expert dispatch in this session only; global defaults are unchanged. Clear an override to follow the global default again.",
  },
  "sidebar.sessionModel.openTitle": {
    zh: "按会话修改专家模型，不影响全局默认",
    en: "Change expert models for this session; global defaults are unchanged",
  },
  "sidebar.sessionModel.close": { zh: "关闭会话模型", en: "Close session models" },
  "sidebar.sessionModel.noSession": {
    zh: "未打开会话：打开一个会话后可在此临时覆盖角色模型。",
    en: "No open session: open a session to temporarily override role models here.",
  },
  "sidebar.sessionModel.child": {
    zh: "当前是子代理会话，会话级模型覆盖只读。",
    en: "This is a subagent session; session model overrides are read-only.",
  },
  "sidebar.sessionModel.loading": { zh: "正在读取本会话覆盖…", en: "Loading session overrides…" },
  "sidebar.sessionModel.unavailable": {
    zh: "本会话覆盖读取失败，请稍后重试。",
    en: "Failed to read session overrides; please retry later.",
  },
  "sidebar.sessionModel.unsupported": {
    zh: "当前宿主版本不支持会话级模型覆盖。",
    en: "This host version does not support session model overrides.",
  },
  "sidebar.sessionModel.offline": {
    zh: "会话未运行：会话级覆盖只读。",
    en: "The session is not running; session overrides are read-only.",
  },
  "sidebar.sessionModel.followGlobal": { zh: "跟随全局默认", en: "Follow global default" },
  "sidebar.sessionModel.override": { zh: "本会话覆盖", en: "Session override" },
  "sidebar.sessionModel.revision": { zh: "代次 {revision}", en: "Revision {revision}" },
  "sidebar.sessionModel.provider": { zh: "供应商", en: "Provider" },
  "sidebar.sessionModel.model": { zh: "模型", en: "Model" },
  "sidebar.sessionModel.effort": { zh: "思考深度", en: "Reasoning effort" },
  "sidebar.sessionModel.effortDefault": { zh: "模型默认", en: "Model default" },
  "sidebar.sessionModel.save": { zh: "保存覆盖", en: "Save override" },
  "sidebar.sessionModel.clear": { zh: "清除", en: "Clear" },
  "sidebar.sessionModel.saving": { zh: "保存中…", en: "Saving…" },
  "sidebar.sessionModel.saved": { zh: "已保存本会话覆盖", en: "Session override saved" },
  "sidebar.sessionModel.cleared": { zh: "已清除，恢复全局默认", en: "Cleared; global default restored" },
  "sidebar.sessionModel.conflict": {
    zh: "其他页面已修改本会话覆盖（当前代次 {revision}）；你的输入已保留，请确认后重试。",
    en: "Another page changed this session's overrides (current revision {revision}); your input was kept, please review and retry.",
  },
  "sidebar.sessionModel.failed": { zh: "保存失败：{message}", en: "Save failed: {message}" },
  "sidebar.sessionModel.retry": { zh: "重新读取", en: "Reload" },
  "sidebar.sessionModel.globalSummary": { zh: "全局：{provider} / {model}", en: "Global: {provider} / {model}" },
  "sidebar.sessionModel.emptyGlobal": { zh: "未配置全局默认", en: "No global default configured" },
  "sidebar.sessionModel.emptyRoles": { zh: "没有可配置的专家角色。", en: "No configurable expert roles." },
  "sidebar.sessionModel.columnRole": { zh: "专家", en: "Expert" },
  "sidebar.sessionModel.columnModel": { zh: "模型选择", en: "Model" },
  "sidebar.sessionModel.tableLabel": { zh: "会话模型覆盖", en: "Session model overrides" },
  "sidebar.sessionModel.saveChanges": { zh: "保存", en: "Save" },
  "sidebar.sessionModel.invalidDraft": {
    zh: "请为已修改的角色选择供应商和模型。",
    en: "Choose a provider and model for every edited role.",
  },
  "sidebar.sessionModel.clearRole": {
    zh: "清除{role}的本会话覆盖",
    en: "Clear the session override for {role}",
  },
  "settings.title": { zh: "dsh-expert-group", en: "dsh-expert-group" },
  "settings.hint": {
    zh: "专家模型使用 DSH 当前已配置的 provider 和模型目录。",
    en: "Expert models use the providers and model catalog configured in DSH.",
  },
  "settings.taskManagement": { zh: "任务管理", en: "Task management" },
  "settings.auto": { zh: "Auto", en: "Auto" },
  "settings.autoTitle": {
    zh: "自动打开运行中的子代理侧栏会话",
    en: "Automatically open running subagent sidebar sessions",
  },
  "settings.notifications": { zh: "通知弹窗", en: "Notifications" },
  "settings.notificationVolume": { zh: "通知音量", en: "Notification volume" },
  "settings.notificationEvents": { zh: "通知事件", en: "Notification events" },
  "settings.notificationVolume.range": { zh: "通知音量滑块", en: "Notification volume slider" },
  "settings.notificationVolume.number": { zh: "通知音量数值", en: "Notification volume value" },
  "settings.notificationEvent.completed": { zh: "任务完成", en: "Task completed" },
  "settings.roleTimeout.aria": { zh: "角色默认超时", en: "Default role timeout" },
  "settings.notificationEvent.completed.aria": { zh: "通知任务完成", en: "Notify on task completed" },
  "settings.notificationEvent.waiting.aria": { zh: "通知等待用户", en: "Notify on waiting for user" },
  "settings.notificationEvent.failed.aria": { zh: "通知任务失败", en: "Notify on task failed" },

  "settings.notificationEvent.waiting": { zh: "等待用户", en: "Waiting for user" },
  "settings.notificationEvent.failed": { zh: "任务失败", en: "Task failed" },

  "settings.unifiedProvider": { zh: "统一供应商", en: "Unified provider" },
  "settings.noProvider": { zh: "无", en: "None" },
  "settings.observerPreferred": { zh: "Observer优先", en: "Prefer Observer" },
  "settings.concurrencyLimit": { zh: "单个角色并发上限", en: "Per-role concurrency limit" },
  "settings.concurrencyLimit.title": {
    zh: "取值范围 1–64 的整数；默认 20；保存后生效",
    en: "An integer from 1–64; defaults to 20; takes effect after saving",
  },
  "settings.roleTimeout": { zh: "角色默认超时 (s)", en: "Default role timeout (s)" },
  "settings.roleTimeout.title": {
    zh: "默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
    en: "Defaults to 10 hours (36000 s); 0 disables it; enabled values are 1–86400 s (integer, 1 s precision). Applies only to attempts created after saving; running shards are unchanged.",
  },
  "settings.save": { zh: "保存", en: "Save" },
  "settings.saving": { zh: "保存中…", en: "Saving…" },
  "settings.discard": { zh: "放弃修改", en: "Discard changes" },
  "settings.saved": { zh: "已保存", en: "Saved" },
  "settings.unsaved": { zh: "有未保存的修改", en: "Unsaved changes" },
  "announce.start": { zh: "任务开始：{name}", en: "Task started: {name}" },
  "announce.finish": { zh: "任务完成：{name}", en: "Task finished: {name}" },
  "announce.fail": { zh: "任务失败：{name}", en: "Task failed: {name}" },
  "announce.cancel": { zh: "任务取消：{name}", en: "Task cancelled: {name}" },
  "announce.more": { zh: "等 {count} 项", en: "and {count} more" },
  "notify.termination.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.termination.completed": { zh: "任务已完成。", en: "Task completed." },
  "notify.termination.blocked": { zh: "任务被阻塞，需要你处理。", en: "Task blocked; your input is needed." },
  "notify.termination.error": { zh: "任务因错误终止。", en: "Task terminated with an error." },
  "notify.termination.aborted": { zh: "任务已中止。", en: "Task aborted." },
  "notify.termination.interrupted": { zh: "任务被中断。", en: "Task interrupted." },
  "notify.termination.max-tokens": { zh: "任务达到 token 上限。", en: "Task reached the token limit." },
  "notify.termination.unknown": { zh: "任务已终止。", en: "Task terminated." },
  "notify.test.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.body": { zh: "需要你操作", en: "Your action is required" },
  "notify.test.body": {
    zh: "测试通知：系统通知通道可用。",
    en: "Test notification: the system notification channel is available.",
  },
  // 说明：客户端表必须与 shared.MESSAGE_CATALOG 逐键同值，因此长等待与后代查询降级
  // 两条文案同步移除（插件已不再把这两类事件变成系统通知）。
  "notify.waitDeliveryFailed.body": {
    zh: "专家批次已静止，但收口结论投递失败；批次保持待收口，插件会在后续 root turn 重试。",
    en: "The expert batch is quiescent but delivering the finalization result failed; the batch remains pending and the plugin retries on later root turns.",
  },
});

  /** 两位补零：本地墙钟时间（formatClockTime）的分钟/秒格式化。 */
  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /**
   * 耗时的人类可读格式（票据 12）：<1s、1.2s、1m 5s、1h 2m。
   *
   * - null/非有限数 ⇒ null（调用方省略或显示占位，绝不把未知写成 0）；
   * - 负数按 0 处理（时钟回拨的防御，与 Host 的 durationBetween 同语义）；
   * - 1 秒以内的真实耗时显示 "<1s"：保留「很快但非零」的信息，又不假装精确到毫秒。
   */
  function formatDuration(value) {
    const ms = numberOrNull(value);
    if (ms === null) return null;
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return "<1s";
    if (clamped < 60000) {
      const seconds = (clamped / 1000).toFixed(1);
      return (seconds.endsWith(".0") ? seconds.slice(0, -2) : seconds) + "s";
    }
    if (clamped < 3600000) {
      const minutes = Math.floor(clamped / 60000);
      const seconds = Math.floor((clamped % 60000) / 1000);
      return minutes + "m " + seconds + "s";
    }
    const hours = Math.floor(clamped / 3600000);
    const minutes = Math.floor((clamped % 3600000) / 60000);
    return minutes === 0 ? hours + "h" : hours + "h " + minutes + "m";
  }

  /**
   * 本地墙钟时间 HH:MM:SS（任务行/时间线用的紧凑展示）。
   *
   * 用本地时区而不是 UTC：侧栏回答的是「用户几点开始的」，跟随系统时区才符合直觉；
   * 需要绝对时间的地方（tooltip、导出）用 formatIsoTime 的 ISO 字符串。
   */
  function formatClockTime(value) {
    const timestamp = numberOrNull(value);
    if (timestamp === null) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
  }

  /** ISO-8601 时间串（tooltip 与导出使用）；缺失/非法返回 null。 */
  function formatIsoTime(value) {
    const timestamp = numberOrNull(value);
    if (timestamp === null) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
  }

  /**
   * UI 用的失败摘要：在归一结果上再截断到 120 字符（票据 12 的展示上限）。
   *
   * 截断用省略号收束且总长仍 ≤ 120：先留 119 个字符再加一个 "…"，既不超限也不丢可读性。
   * 返回 { code, message }（message 可为 null）或 null。
   */
  function formatFailureSummary(value) {
    const failure = normalizeFailure(value);
    if (failure === null) return null;
    const message = failure.message === null || failure.message.length <= FAILURE_MESSAGE_DISPLAY_MAX_LENGTH
      ? failure.message
      : failure.message.slice(0, FAILURE_MESSAGE_DISPLAY_MAX_LENGTH - 1) + "…";
    return { code: failure.code, message };
  }

  /** 是否为失败语义状态（决定是否展示失败摘要，与 Host 的集合同值）。 */
  function isFailureStatus(value) {
    return FAILURE_STATUSES.indexOf(normalizeStatus(value)) !== -1;
  }

  /** 结构化回退原因的展示文案；未知/缺失回退到「结果不可用」，绝不显示自由文本。 */
  function structuredFallbackText(reason) {
    return STRUCTURED_FALLBACK_REASON_SET.has(reason)
      ? STRUCTURED_FALLBACK_REASONS[reason]
      : STRUCTURED_FALLBACK_REASONS.result_unavailable;
  }

  /**
   * 结构化结果的**有界 JSON 预览**（票据 30）。
   *
   * 返回 { text, truncated, fallback, reason }：
   * - 有 value ⇒ 单行紧凑 JSON 前缀（超过上限截断并置 truncated）；
   * - 没有 value 但有回退原因 ⇒ text=null、fallback=true；
   * - 两者都没有 ⇒ null（调用方不渲染结构化区）。
   * 这里绝不接触 outputSchema 原文：客户端本来就没有该字段（Host 不投影）。
   */
  function structuredPreviewOf(value, options) {
    const structured = normalizeStructured(value);
    if (structured === null) return null;
    const optionSource = isObject(options) ? options : {};
    const rawLimit = numberOrNull(optionSource.maxChars);
    const limit = rawLimit !== null && rawLimit > 0 ? Math.floor(rawLimit) : STRUCTURED_PREVIEW_MAX_CHARS;
    if (structured.value !== undefined) {
      let serialized = "";
      try { serialized = JSON.stringify(structured.value); } catch { serialized = ""; }
      if (serialized.length === 0) {
        return { text: null, truncated: false, fallback: true, reason: structured.reason ?? "result_unavailable" };
      }
      const truncated = serialized.length > limit;
      return {
        text: truncated ? serialized.slice(0, limit) : serialized,
        truncated,
        fallback: structured.fallback === true,
        reason: structured.reason ?? null,
      };
    }
    if (structured.fallback === true || typeof structured.reason === "string") {
      return { text: null, truncated: false, fallback: true, reason: structured.reason ?? "missing_structured" };
    }
    return null;
  }

  /**
   * 有界 token 数展示（票据 25）：<1k 原样、<1M 用 k、其余用 M，最多 5 个有效字符。
   * 缺失返回 null（UI 显示「—」），绝不把未知写成 0。
   */
  function formatTokenCount(value) {
    const count = countOrNull(value);
    if (count === null) return null;
    if (count < 1000) return String(count);
    if (count < 1000000) {
      const thousands = count / 1000;
      return (thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))) + "k";
    }
    const millions = count / 1000000;
    return (millions < 10 ? millions.toFixed(1) : String(Math.round(millions))) + "M";
  }

  /**
   * 紧凑运行时长（用量速览行）：<1s、1.2s、1m、28m27s、1h、1h2m。
   *
   * 与 formatDuration 的区别是「更短、更贴近摘要条」：不插入空格；整分不补 "0s"、
   * 整点不补 "0m"；小时级忽略秒。缺失返回 null（调用方整段省略，绝不写 0/占位词）。
   */
  function formatDurationCompact(value) {
    const ms = numberOrNull(value);
    if (ms === null) return null;
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return "<1s";
    if (clamped < 60000) {
      const seconds = (clamped / 1000).toFixed(1);
      return (seconds.endsWith(".0") ? seconds.slice(0, -2) : seconds) + "s";
    }
    if (clamped < 3600000) {
      const minutes = Math.floor(clamped / 60000);
      const seconds = Math.floor((clamped % 60000) / 1000);
      // 整分只写 "1m"：补 "0s" 只会让窄右栏多占两个字符而不增加信息。
      return seconds === 0 ? minutes + "m" : minutes + "m" + seconds + "s";
    }
    const hours = Math.floor(clamped / 3600000);
    const minutes = Math.floor((clamped % 3600000) / 60000);
    // 整点只写 "1h"；有分钟才是 "1h2m"。
    return minutes === 0 ? hours + "h" : hours + "h" + minutes + "m";
  }

  /** 平均吞吐文本：≥10 取整，<10 保留一位小数并去掉 .0，统一追加 tok/s。 */
  function formatThroughputText(value) {
    const rounded = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
    return (rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded) + "tok/s";
  }

  /**
   * 任务行「用量速览」的纯函数投影（用时 · tok/s · tok · 命中 · context）。
   *
   * 所有数值与文本都在模型层完成，渲染层只按顺序摆放；任何缺失项返回 null，
   * 由调用方整段省略——绝不写 0 或占位词。百分比统一四舍五入并封顶 100。
   *
   * - 用时：调用方已解析好的 durationMs（DSH 模型用时优先，其次节点字段 → usage.runMs → 会话时间）；
   * - tok/s：measuredTokensPerSecond（DSH 输出速度）优先；其次 outputTokens ÷（durationMs/1000）。
   *   两种情况都要求吞吐 ≥0.1，且回退算法还要求运行时间 ≥1s、输出 token >0；
   * - tok：总 token（计费输入 + 输出），复用 formatTokenCount；
   * - 命中：cacheReadTokens ÷ billedInputTokens（cacheRead 为 0 是有效事实）；
   * - context：(projectedTokens ?? pressureTokens) ÷ contextWindow。
   *
   * @param {object|null} usage - normalizeUsage 的结果（DEG usage ledger 投影）。
   * @param {{durationMs?: number|null, contextPressure?: object|null, measuredTokensPerSecond?: number|null}} options
   * @returns {{durationMs:number|null, durationText:string|null, tokensPerSecond:number|null,
   *   throughputText:string|null, totalTokens:number|null, totalTokensText:string|null,
   *   cacheHitPercent:number|null, cacheHitText:string|null, contextPercent:number|null,
   *   contextText:string|null, contextUsedTokens:number|null, contextWindow:number|null}}
   */
  function summarizeUsageMetrics(usage, options) {
    const source = isObject(usage) ? usage : {};
    const settings = isObject(options) ? options : {};
    const durationMs = countOrNull(settings.durationMs);
    const durationText = formatDurationCompact(durationMs);
    const outputTokens = countOrNull(source.outputTokens);
    const billedInput = countOrNull(source.billedInputTokens);
    // 总 token：优先用 normalizeUsage 已重算的 totalTokens，其次在两端齐备时自行相加。
    let totalTokens = countOrNull(source.totalTokens);
    if (totalTokens === null && billedInput !== null && outputTokens !== null) {
      totalTokens = billedInput + outputTokens;
    }
    const totalTokensText = totalTokens === null ? null : (formatTokenCount(totalTokens) ?? null) + " tok";
    // 平均吞吐：DSH 输出速度（decodeTokens/decodeMs）优先，不再受 durationMs ≥1s 的限制；
    // 缺失时才回退 outputTokens/duration。两种情况都要求吞吐 ≥0.1
    // （一位小数会把更小的值四舍五入成 0，等于伪造「没有产出」）。
    let tokensPerSecond = null;
    let throughputText = null;
    const measured = numberOrNull(settings.measuredTokensPerSecond);
    if (measured !== null && measured >= 0.1) {
      tokensPerSecond = measured;
      throughputText = formatThroughputText(measured);
    } else if (durationMs !== null && durationMs >= 1000 && outputTokens !== null && outputTokens > 0) {
      const value = outputTokens / (durationMs / 1000);
      if (Number.isFinite(value) && value >= 0.1) {
        tokensPerSecond = value;
        throughputText = formatThroughputText(value);
      }
    }
    // 缓存命中：cacheRead 缺失不显示；0 是有效值（显示 命中0%）。
    const cacheRead = countOrNull(source.cacheReadTokens);
    let cacheHitPercent = null;
    if (cacheRead !== null && billedInput !== null && billedInput > 0) {
      cacheHitPercent = Math.min(100, Math.round((cacheRead / billedInput) * 100));
    }
    const cacheHitText = cacheHitPercent === null ? null : "命中" + cacheHitPercent + "%";
    // 上下文占用：projectedTokens 优先，其次 pressureTokens；窗口非正时整段省略。
    const pressure = isObject(settings.contextPressure) ? settings.contextPressure : {};
    const contextUsedTokens = countOrNull(pressure.projectedTokens) ?? countOrNull(pressure.pressureTokens);
    const contextWindow = countOrNull(pressure.contextWindow);
    let contextPercent = null;
    if (contextUsedTokens !== null && contextWindow !== null && contextWindow > 0) {
      contextPercent = Math.min(100, Math.round((contextUsedTokens / contextWindow) * 100));
    }
    const contextText = contextPercent === null ? null : "context " + contextPercent + "%";
    return {
      durationMs,
      durationText,
      tokensPerSecond,
      throughputText,
      totalTokens,
      totalTokensText,
      cacheHitPercent,
      cacheHitText,
      contextPercent,
      contextText,
      contextUsedTokens,
      contextWindow,
    };
  }

  /**
   * 展示用文本脱敏（票据 28）：折叠控制字符/空白、抹掉绝对路径并截断。
   *
   * 只用于客户端自造的提示（派发表单校验、模板操作错误摘要）；Host 已经对模板错误
   * 做了同样的保守处理（只回字段名与固定类别），这里是浏览器侧的第二道防线。
   */
  function redactDisplayText(value, maxLength) {
    const raw = typeof value === "string" ? value : (value instanceof Error ? value.message : "");
    const collapsed = raw
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (collapsed.length === 0) return "";
    const limit = numberOrNull(maxLength) !== null && maxLength > 0 ? Math.floor(maxLength) : 160;
    return redactFailurePaths(collapsed).slice(0, limit);
  }

  function titleCaseRole(value, fallback) {
    const source = text(value);
    if (source === null) return fallback;
    return source
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ") || fallback;
  }

  function formatExpertMetadata(node, options) {
    const source = isObject(node) ? node : {};
    const optionSource = isObject(options) ? options : {};
    // 票据 27：显式显示名优先（节点 roleLabel → 调用方给出的 roleLabels 映射；
    // 映射含历史角色显示名，包括已删除角色的持久化标签）；没有显示名时
    // 保持既有的 titleCase 角色 id 行为逐字不变（旧快照/旧 Host 兼容）。
    const explicitLabel = text(source.roleLabel) ?? roleLabelFrom(source.role, optionSource.roleLabels);
    const role = explicitLabel ?? titleCaseRole(source.role, source.kind === "root" ? "Orchestrator" : "Expert");
    const provider = text(source.provider) || "未知供应商";
    const model = text(source.model) || "未知模型";
    const rawEffort = firstText(source.effort, source.reasoningEffort);
    const effort = rawEffort === null ? "默认" : rawEffort.charAt(0).toUpperCase() + rawEffort.slice(1);
    return [role, provider, model, effort].join(" · ");
  }

  /**
   * attempt 时间线投影（票据 12）：只读、有序、可按「最近 N 条」截断。
   *
   * - shard 节点用自身的 attempts；fanout 父任务把各分片的 attempts 摊平后按时间排序，
   *   每条额外带 shardId/shardTaskName（内存里的只读视图，不会写回快照）；
   * - 排序键是 finishedAt → startedAt；两者都缺的旧 attempt 当作最旧（保留输入顺序），
   *   同键用原始下标兜底，结果不依赖引擎排序实现的稳定性；
   * - expanded=false 时取最近 limit 条（仍按时间升序展示，最新的在最后）；
   *   expanded=true 时返回全部（UI 的「查看全部」）。
   * @returns {{total:number, limit:number, expanded:boolean, hasMore:boolean, entries:object[]}}
   */
  function attemptTimelineOf(value, options) {
    const source = isObject(value) ? value : {};
    const optionSource = isObject(options) ? options : {};
    const limit = numberOrNull(optionSource.limit) !== null && optionSource.limit > 0
      ? Math.floor(optionSource.limit)
      : ATTEMPT_TIMELINE_LIMIT;
    const expanded = optionSource.expanded === true;
    const entries = [];
    const appendAttempts = (attempts, shard) => {
      if (!Array.isArray(attempts)) return;
      for (const attempt of attempts) {
        const normalized = normalizeAttempt(attempt);
        entries.push({
          ...normalized,
          position: entries.length + 1,
          shardId: shard === null ? null : text(shard.shardId),
          shardTaskName: shard === null ? null : firstText(shard.taskName, shard.shardId),
        });
      }
    };
    const shards = Array.isArray(source.shards) ? source.shards : [];
    if (shards.length > 0) {
      for (const shard of shards) {
        const shardSource = isObject(shard) ? shard : {};
        appendAttempts(shardSource.attempts, shardSource);
      }
    } else {
      appendAttempts(source.attempts, null);
    }
    const keyed = entries.map((entry, index) => ({
      entry,
      index,
      at: numberOrNull(entry.finishedAt) ?? numberOrNull(entry.startedAt) ?? Number.NEGATIVE_INFINITY,
    }));
    keyed.sort((left, right) => {
      if (left.at === right.at) return left.index - right.index;
      return left.at < right.at ? -1 : 1;
    });
    const ordered = keyed.map((item) => item.entry);
    const total = ordered.length;
    return {
      total,
      limit,
      expanded,
      hasMore: total > limit,
      entries: expanded ? ordered : ordered.slice(Math.max(0, total - limit)),
    };
  }

  function normalizeFilterKey(value) {
    const source = text(value);
    return source === null ? null : source.toLowerCase();
  }

  /** 状态筛选键：只有 STATUS_FILTER_GROUPS 里的分组名才算有效，其它值一律视为「不筛选」。 */
  function statusGroupOf(value) {
    const key = normalizeFilterKey(value);
    if (key === null) return null;
    return Object.prototype.hasOwnProperty.call(STATUS_FILTER_GROUPS, key) ? key : null;
  }

  function filterHaystackOf(value) {
    const source = isObject(value) ? value : {};
    return [source.taskName, source.role, source.model, source.provider, source.status, source.shardId]
      .filter((item) => typeof item === "string" && item.trim() !== "")
      .join(" ")
      .toLowerCase();
  }

  /**
   * 客户端本地过滤器（票据 12）：只读快照，不发任何 RPC、不写持久化。
   *
   * 匹配字段是任务名 / 角色 / 模型 / provider / 状态 / 分片代号；返回的谓词保留命中节点的
   * **祖先路径**：isVisible(node) 为真当且仅当节点自身命中，或其子节点/分片命中。UI 用
   * isVisible 决定整棵子树是否展示，用 shardsFor 决定 fan-out 分支里保留哪些分片
   * （只保留命中的分片，不因父任务命中而放宽——否则状态筛选会漏出同分支的其它状态）。
   *
   * active=false 时 matches 恒真、isVisible 恒真、shardsFor 原样返回，调用方可以统一走同一套
   * 分支而无需额外判断（同时也保证「不筛选」的路径零行为变化）。
   */
  function createTaskFilter(input) {
    const source = isObject(input) ? input : {};
    const query = normalizeFilterKey(source.query);
    const role = normalizeFilterKey(source.role);
    const statusGroup = statusGroupOf(source.status);
    const statuses = statusGroup === null ? null : new Set(STATUS_FILTER_GROUPS[statusGroup]);
    const active = query !== null || role !== null || statuses !== null;
    const matches = (value) => {
      if (active !== true) return true;
      const node = isObject(value) ? value : {};
      if (role !== null && normalizeFilterKey(node.role) !== role) return false;
      if (statuses !== null && statuses.has(normalizeStatus(node.status)) !== true) return false;
      if (query !== null && filterHaystackOf(node).indexOf(query) === -1) return false;
      return true;
    };
    const visible = (value, depth) => {
      if (matches(value) === true) return true;
      if (depth >= MAX_NESTED_EXPERT_DEPTH) return false;
      const node = isObject(value) ? value : {};
      if (Array.isArray(node.children) && node.children.some((child) => visible(child, depth + 1) === true)) return true;
      if (Array.isArray(node.shards) && node.shards.some((shard) => visible(shard, depth + 1) === true)) return true;
      return false;
    };
    return Object.freeze({
      query,
      role,
      status: statusGroup,
      active,
      matches,
      isVisible: (value) => visible(value, 0),
      shardsFor: (value) => {
        const node = isObject(value) ? value : {};
        const shards = Array.isArray(node.shards) ? node.shards : [];
        // 过滤启用时只保留命中的分片：父任务命中不代表它的全部子分片都命中
        // （否则「只看失败」会把同一分支里成功的分片也一起展示出来）。
        if (active !== true) return shards;
        return shards.filter((shard) => visible(shard, 1) === true);
      },
    });
  }

  /**
   * 过滤后的快照副本（纯函数，供导出/诊断与契约测试使用）。
   *
   * 只保留命中节点及其祖先；不修改输入对象（节点引用原样保留，数组是新数组）。
   * active=false 时原样返回同一个引用：调用方可以据此做引用相等的短路。
   */
  function filterSnapshot(snapshot, input) {
    if (!isObject(snapshot) || !isObject(snapshot.root)) return snapshot ?? null;
    const filter = createTaskFilter(input);
    if (filter.active !== true) return snapshot;
    const filterNode = (value) => {
      if (filter.isVisible(value) !== true) return null;
      const node = isObject(value) ? value : {};
      if (node.kind === "fanout") return { ...node, shards: filter.shardsFor(node) };
      if (Array.isArray(node.children) && node.children.length > 0) {
        return { ...node, children: node.children.map(filterNode).filter((child) => child !== null) };
      }
      return node;
    };
    const children = (Array.isArray(snapshot.root.children) ? snapshot.root.children : [])
      .map(filterNode)
      .filter((node) => node !== null);
    return { ...snapshot, root: { ...snapshot.root, children } };
  }

  /** 导出文件名里的 rootSessionId 片段：只保留文件名安全字符，避免路径穿越/非法字符。 */
  function sanitizeExportFilePart(value) {
    const cleaned = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.slice(0, 48) || "snapshot";
  }

  function markdownTextOf(value, fallback) {
    const source = text(value);
    if (source === null) return fallback;
    return source.replace(/[\r\n]+/g, " ").trim() || fallback;
  }

  function markdownAttemptLines(attempts) {
    const lines = [];
    const list = Array.isArray(attempts) ? attempts : [];
    list.forEach((value, index) => {
      const attempt = normalizeAttempt(value);
      const number = attempt.attempt === null ? index + 1 : attempt.attempt;
      const parts = ["#" + number, attempt.status];
      const duration = formatDuration(attempt.durationMs);
      if (duration !== null) parts.push(duration);
      const started = formatIsoTime(attempt.startedAt);
      const finished = formatIsoTime(attempt.finishedAt);
      if (started !== null) parts.push("started " + started);
      if (finished !== null) parts.push("finished " + finished);
      // 票据 25：attempt 的 token/请求数随 Markdown 导出一并导出（缺失不补 0）。
      const attemptUsage = normalizeUsage(attempt.usage);
      if (attemptUsage !== null) {
        const tokens = countOrNull(attemptUsage.totalTokens) ?? countOrNull(attemptUsage.inputTokens);
        if (tokens !== null) parts.push("tokens " + tokens);
        if (countOrNull(attemptUsage.requests) !== null) parts.push("requests " + attemptUsage.requests);
      }
      // 票据 30：结构化结果只导出有界预览或回退原因，schema 原文从不进入导出。
      const attemptStructured = structuredPreviewOf(attempt.structured);
      if (attemptStructured !== null) {
        parts.push(attemptStructured.text === null
          ? "structured fallback " + (attemptStructured.reason ?? "result_unavailable")
          : "structured " + attemptStructured.text + (attemptStructured.truncated ? " …" : ""));
      }
      if (attempt.failure !== null) {
        parts.push("failure " + attempt.failure.code + (attempt.failure.message === null ? "" : " · " + attempt.failure.message));
      }
      lines.push("  - " + parts.join(" · "));
    });
    return lines;
  }

  function markdownTimelineBullets(source) {
    const lines = [];
    const parts = [];
    const started = formatIsoTime(source.startedAt);
    const finished = formatIsoTime(source.finishedAt);
    const duration = formatDuration(source.durationMs);
    const lastActivity = formatIsoTime(source.lastActivityAt);
    if (started !== null) parts.push("开始 " + started);
    if (finished !== null) parts.push("完成 " + finished);
    if (duration !== null) parts.push("耗时 " + duration);
    if (lastActivity !== null) parts.push("最近活动 " + lastActivity);
    if (parts.length > 0) lines.push("- " + parts.join(" · "));
    const attempts = numberOrNull(source.attemptCount);
    const retries = numberOrNull(source.retryCount);
    if (attempts !== null || retries !== null) {
      const counts = [];
      if (attempts !== null) counts.push("尝试 " + attempts + " 次");
      if (retries !== null) counts.push("重试 " + retries + " 次");
      lines.push("- " + counts.join(" · "));
    }
    return lines;
  }

  /** 用量的一行 Markdown 文案（票据 25）：只列已知项，缺失返回「—」。 */
  function usageMarkdownText(value) {
    const usage = normalizeUsage(value);
    if (usage === null) return "—";
    const parts = [];
    const labels = [["inputTokens", "输入"], ["outputTokens", "输出"], ["cacheReadTokens", "缓存读"], ["cacheWriteTokens", "缓存写"], ["reasoningTokens", "推理"]];
    for (const [field, label] of labels) {
      if (countOrNull(usage[field]) !== null) parts.push(label + " " + usage[field]);
    }
    const counts = [["requests", "请求"], ["retries", "重试"], ["fallbacks", "降级"]];
    for (const [field, label] of counts) {
      if (countOrNull(usage[field]) !== null) parts.push(label + " " + usage[field]);
    }
    const duration = formatDuration(usage.runMs);
    if (duration !== null) parts.push("运行时长 " + duration);
    return parts.length === 0 ? "—" : parts.join(" · ");
  }

  /** 结构化结果的一行 Markdown 文案：有界预览或回退原因，绝不导出 schema 原文。 */
  function structuredMarkdownText(value) {
    const preview = structuredPreviewOf(value);
    if (preview === null) return "—";
    if (preview.text !== null) return preview.text + (preview.truncated ? "…（已截断）" : "");
    return structuredFallbackText(preview.reason) + "（" + (preview.reason ?? "result_unavailable") + "）";
  }

  function markdownNodeLines(node, level) {
    const source = isObject(node) ? node : {};
    const lines = [];
    const kind = source.kind === "fanout"
      ? "fanout"
      : (source.kind === "root" ? "root" : (source.kind === "shard" ? "shard" : "expert"));
    const name = markdownTextOf(firstText(source.taskName, source.shardId, source.sessionId, source.parentTaskId), "未命名任务");
    const heading = "#".repeat(Math.min(6, Math.max(1, level)));
    if (kind === "root") lines.push(heading + " 主代理");
    else if (kind === "fanout") lines.push(heading + " Fan-out 任务：" + name);
    else if (kind === "shard") lines.push(heading + " 分片：" + name);
    else lines.push(heading + " 专家：" + name);
    const meta = [];
    const role = text(source.role);
    const roleLabel = text(source.roleLabel);
    if (role !== null) meta.push("角色：" + (roleLabel === null ? role : roleLabel + "（" + role + "）"));
    const provider = text(source.provider);
    if (provider !== null) meta.push("provider：" + provider);
    const model = text(source.model);
    if (model !== null) meta.push("模型：" + model);
    const effort = firstText(source.effort, source.reasoningEffort);
    if (effort !== null) meta.push("effort：" + effort);
    if (meta.length > 0) lines.push("- " + meta.join(" · "));
    const statusParts = ["状态：" + normalizeStatus(source.status)];
    if (kind === "fanout" && text(source.taskStatus) !== null && source.taskStatus !== source.status) {
      statusParts.push("原始状态：" + text(source.taskStatus));
    }
    lines.push("- " + statusParts.join(" · "));
    // 票据 25：用量按节点导出（缺失显示「—」，绝不伪造 0）。
    lines.push("- 用量：" + usageMarkdownText(source.usage));
    // 票据 30：结构化结果只导出有界预览 / 回退原因。
    const structuredPreview = structuredPreviewOf(source.structured);
    if (structuredPreview !== null || source.outputSchemaRequested === true) {
      lines.push("- 结构化结果：" + (structuredPreview === null ? "尚未返回" : structuredMarkdownText(source.structured)));
    }
    lines.push(...markdownTimelineBullets(source));
    const failure = normalizeFailure(source.failure);
    if (failure !== null && isFailureStatus(source.status) === true) {
      lines.push("- 失败：" + failure.code + (failure.message === null ? "" : " · " + failure.message));
    }
    const shards = Array.isArray(source.shards) ? source.shards : [];
    const attempts = Array.isArray(source.attempts) ? source.attempts : [];
    if (attempts.length > 0) {
      lines.push("- 尝试时间线（" + attempts.length + " 条）：");
      lines.push(...markdownAttemptLines(attempts));
    }
    return { lines, shards, children: Array.isArray(source.children) ? source.children : [] };
  }

  function renderMarkdownSnapshot(snapshot) {
    const source = isObject(snapshot) ? snapshot : {};
    const lines = [];
    lines.push("# Expert Group 任务树", "");
    lines.push("- 根会话：" + markdownTextOf(firstText(source.rootSessionId, source.sessionId), "未命名会话"));
    const generated = formatIsoTime(source.generatedAt);
    lines.push("- 快照生成时间：" + (generated === null ? "未知" : generated));
    lines.push("- 快照完整性：" + (source.partial === true ? "轻量（partial）" : "完整"));
    const revision = text(source.revision);
    if (revision !== null) lines.push("- 内容摘要：" + revision);
    lines.push("- 导出范围：任务树元数据与时间线（不含提示词正文）", "");
    const emit = (value, level) => {
      const parsed = markdownNodeLines(value, level);
      lines.push(...parsed.lines, "");
      for (const shard of parsed.shards) {
        const shardSource = isObject(shard) ? shard : {};
        emit({
          ...shardSource,
          kind: "shard",
          taskName: firstText(shardSource.taskName, shardSource.shardId),
        }, level + 1);
      }
      for (const child of parsed.children) emit(child, level + 1);
    };
    emit(source.root, 1);
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  /**
   * 把当前 normalized 快照序列化为可下载的文本（票据 12）。
   *
   * - format="json"：JSON.stringify(snapshot, null, 2) —— 完整 normalized 快照，便于程序消费；
   * - format="markdown"：人类可读的任务树（不含提示词正文，只含任务名/元数据/时间线/受限失败摘要）。
   *
   * 纯函数：不读 DOM、不写宿主状态；now 只进入文件名，content 完全由快照决定（可断言、可 diff）。
   * DOM 不可用（Node 测试、无 Blob 的宿主）时调用方仍能用这里的 content 完成导出。
   * @returns {{format:string, filename:string, mimeType:string, content:string}|null}
   */
  function serializeSnapshot(snapshot, options) {
    if (!isObject(snapshot)) return null;
    const optionSource = isObject(options) ? options : {};
    const format = optionSource.format === "json" ? "json" : "markdown";
    const now = numberOrNull(optionSource.now) ?? Date.now();
    const rootPart = sanitizeExportFilePart(firstText(snapshot.rootSessionId, snapshot.sessionId) ?? "snapshot");
    const filename = "expert-group-" + rootPart + "-" + Math.floor(Math.max(0, now)) + (format === "json" ? ".json" : ".md");
    return Object.freeze({
      format,
      filename,
      mimeType: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8",
      content: format === "json" ? JSON.stringify(snapshot, null, 2) : renderMarkdownSnapshot(snapshot),
    });
  }

  function defaultExpanded(node) {
    // 根节点是任务树入口，默认展开；空闲分组也默认展示成员。
    if (isObject(node) && node.kind === "root") return true;
    if (isObject(node) && node.kind === "idle-group") return true;
    // fan-out 始终默认展示子代理，不因完成或取消自动收起；
    // 这里只改变缺省值，createExpansionStore 仍优先保留用户手动折叠的选择。
    if (isObject(node) && node.kind === "fanout") return true;
    const status = normalizeStatus(isObject(node) ? (node.status ?? node.taskStatus) : undefined);
    return !DEFAULT_COLLAPSED_STATUSES.has(status);
  }

  function taskIdOf(value) {
    if (typeof value === "string") return text(value) || "unknown";
    const source = isObject(value) ? value : {};
    return firstText(source.taskId, source.id, source.parentTaskId, source.sessionId, source.shardId) || "unknown";
  }

  function safeStorage(storage) {
    if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") return storage;
    try {
      const candidate = global.sessionStorage;
      if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") return candidate;
    } catch { /* 某些浏览器隐私模式访问 sessionStorage 会同步抛错，按无持久化降级。 */ }
    return null;
  }

  function createExpansionStore(options) {
    const config = isObject(options) ? options : {};
    const storage = safeStorage(config.storage);
    const rootSessionId = text(config.rootSessionId) || "unknown";
    const keyFor = (value) => "dsh-expert-group:expansion:v" + SCHEMA_VERSION + ":" + encodeURIComponent(rootSessionId) + ":" + encodeURIComponent(taskIdOf(value));
    const readOverride = (key) => {
      if (storage === null) return undefined;
      try {
        const raw = storage.getItem(key);
        if (raw === null || raw === undefined) return undefined;
        if (raw === "true") return true;
        if (raw === "false") return false;
        const parsed = JSON.parse(raw);
        if (typeof parsed === "boolean") return parsed;
        if (isObject(parsed) && typeof parsed.expanded === "boolean"
          && (parsed.schemaVersion === undefined || parsed.schemaVersion === SCHEMA_VERSION)) return parsed.expanded;
      } catch { /* 损坏内容和存储读错误都只表示没有手动 override。 */ }
      return undefined;
    };
    const isExpanded = (value) => {
      const override = readOverride(keyFor(value));
      return override === undefined ? defaultExpanded(value) : override;
    };
    const setExpanded = (value, expanded) => {
      const next = expanded === true;
      if (storage !== null) {
        try {
          storage.setItem(keyFor(value), JSON.stringify({ schemaVersion: SCHEMA_VERSION, rootSessionId, taskId: taskIdOf(value), expanded: next }));
        } catch { /* 配额或隐私策略拒绝写入时仍保留本次渲染的默认行为。 */ }
      }
      return next;
    };
    const toggle = (value) => setExpanded(value, !isExpanded(value));
    const clear = (value) => {
      if (storage === null || typeof storage.removeItem !== "function") return;
      try { storage.removeItem(keyFor(value)); } catch { /* 清理失败不影响页面。 */ }
    };
    return Object.freeze({
      rootSessionId, keyFor, isExpanded, get: isExpanded,
      setExpanded, set: setExpanded, toggle, clear,
    });
  }

  /**
   * 语言标识归一：`zh-CN` / `EN-us` / `zh_TW` → 主语言子标签；不支持的返回 null。
   * 与 shared.js 的 normalizeLocale 同语义（投影）。
   */
  function normalizeLocale(value) {
    if (typeof value !== "string") return null;
    const primary = value.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === "zh") return "zh";
    if (primary === "en") return "en";
    return null;
  }

  /** 按候选顺序解析语言；全部不可识别时回退 zh（纯函数，测试可注入任意候选）。 */
  function resolveLocale(candidates) {
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const normalized = normalizeLocale(candidate);
      if (normalized !== null) return normalized;
    }
    return DEFAULT_LOCALE;
  }

  /**
   * 客户端 locale 解析顺序（票据 19）：
   * ctx.locale → ctx.i18n.locale → props.useTabInfo().locale → document.documentElement.lang
   * → navigator.language → zh。
   *
   * 只接受显式传入的候选（不在这里读全局），因此同一个函数既能被侧栏调用，也能在
   * node:test 里用任意候选验证优先级。
   */
  function resolveClientLocale(sources = {}) {
    const source = isObject(sources) ? sources : {};
    const tabInfo = isObject(source.tabInfo) ? source.tabInfo : {};
    const documentLang = typeof source.documentLang === "string" ? source.documentLang : null;
    const navigatorLanguage = typeof source.navigatorLanguage === "string" ? source.navigatorLanguage : null;
    return resolveLocale([
      source.ctxLocale,
      source.i18nLocale,
      tabInfo.locale,
      tabInfo.tab?.locale,
      documentLang,
      navigatorLanguage,
    ]);
  }

  /**
   * 取一条文案并插值：缺失键回退 zh；两份都缺失返回中性占位（绝不返回空串或内部键名）。
   * 变量只支持 {name}；缺失变量保留占位符，便于发现调用方漏传。
   */
  function translateMessage(locale, key, vars = {}) {
    const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
    const entry = MESSAGE_CATALOG[key];
    if (entry === undefined || entry === null) return MISSING_MESSAGE_TEXT;
    const template = typeof entry[normalized] === "string" && entry[normalized].length > 0
      ? entry[normalized]
      : (typeof entry[DEFAULT_LOCALE] === "string" ? entry[DEFAULT_LOCALE] : "");
    if (template.length === 0) return MISSING_MESSAGE_TEXT;
    const values = isObject(vars) ? vars : {};
    return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
      const value = values[name];
      return value === undefined || value === null ? match : String(value);
    });
  }

  // 本文件贡献的全部公开面（门面按原键顺序重组；顺序本身就是导出契约的一部分）。
  global[SYMBOL] = Object.freeze({
    FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
    RETRY_WARNING_THRESHOLD,
    ATTEMPT_TIMELINE_LIMIT,
    FAILURE_STATUSES,
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
    formatExpertMetadata,
    defaultExpanded,
    createExpansionStore,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
    MISSING_MESSAGE_TEXT,
    MESSAGE_CATALOG,
    normalizeLocale,
    resolveLocale,
    resolveClientLocale,
    translateMessage,
  });
})(globalThis);
