(function installExpertGroupModel(global) {
  "use strict";

  // 版本写进存储键和快照边界，防止新旧页面把同一份折叠状态误读成不同语义。
  const SCHEMA_VERSION = 1;
  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");
  const STATUSES = new Set([
    "queued", "waiting", "running", "succeeded", "failed", "cancelled",
    "timed_out", "interrupted", "idle", "ready", "unknown",
  ]);
  const STATUS_ALIASES = Object.freeze({
    canceled: "cancelled", timeout: "timed_out", timedout: "timed_out", "timed-out": "timed_out",
    success: "succeeded", successful: "succeeded", complete: "succeeded", completed: "succeeded", done: "succeeded",
    error: "failed", errored: "failed", active: "running", in_progress: "running", "in-progress": "running",
    working: "running", pending: "queued", scheduled: "queued", wait: "waiting",
  });
  /**
   * 逐动作能力（票据 09）的动作词表与原因码上限。
   *
   * 客户端只接受声明过的动作与布尔 allowed；reason 只作为稳定机器 token 展示/诊断，
   * 超长内容截断，绝不把任意自由文本原样渲染进 UI。
   */
  const CAPABILITY_ACTIONS = Object.freeze(["read", "cancel", "retry", "continue"]);
  const SHARD_CAPABILITY_ACTIONS = Object.freeze(["cancel", "retry"]);
  const CAPABILITY_REASON_MAX_LENGTH = 64;

  const COUNT_FIELDS = Object.freeze([
    "queued", "waiting", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted", "pending",
  ]);

  // ── 任务时间线与受限失败摘要（票据 12） ──────────────────────────────────────
  //
  // Host 投影（host/expert-group-snapshot.js）已经给出权威的时间线字段；客户端这里保留
  // 同值常量做第二道防线：浏览器侧只加载装配后的 bundle，不能 import Host 模块，因此
  // 长度上限、状态分组与阈值各自持有一份副本（与本文件既有的 RECOVERY_* 同一模式）。
  // 破坏性改动必须两边同步，否则客户端会把 Host 已收敛的负载再次放大。

  /** 失败摘要 code 的字符上限（稳定机器 token，客户端只展示不解析）。 */
  const FAILURE_CODE_MAX_LENGTH = 64;
  /** 失败摘要 message 的归一上限（与 Host 的 FAILURE_MESSAGE_MAX_LENGTH 同值）。 */
  const FAILURE_MESSAGE_MAX_LENGTH = 160;
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
  /** 嵌套专家子树的最大归一深度：防御病态/恶意负载导致的深递归，正常快照远低于该值。 */
  const MAX_NESTED_EXPERT_DEPTH = 16;
  /**
   * 「明确仍在进行中」的协议状态：这三类节点即使输入误带 finishedAt/durationMs 也不采用。
   *
   * 只挡可证明的非终态：unknown / 缺失状态保持宽容（旧快照没有可靠状态时，
   * 显式给出的时间戳仍是唯一可用事实，不能因为状态不明就丢掉）。
   */
  const ACTIVE_STATUS_SET = new Set(["queued", "waiting", "running"]);
  /**
   * 恢复失败原因码的合法形态与文案上限（与 Host 投影同一契约，各自持有一份常量）。
   *
   * 客户端不 import Host 模块（浏览器侧只加载装配后的 bundle），因此这里保留同值副本；
   * 任何形态不符的 code 都退化为 RESTORE_FAILED，绝不在 UI 上渲染自由文本。
   */
  const RECOVERY_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
  const RECOVERY_MESSAGE_MAX_LENGTH = 200;
  /**
   * 右侧栏对外的**代理运行状态**只有这两个规范值。
   *
   * 官方源字段（DSH 子代理目录）用 activity=running/inactive、Agent status=running/idle
   * 两套词表；协议快照还带着 fan-out 的 queued/waiting/终态。展示层把它们全部收敛成
   * running|ready：只有「明确运行」才是 running，其余一律 ready。
   */
  const RUNTIME_STATUSES = Object.freeze(["running", "ready"]);
  /**
   * 默认折叠的状态词表：这四个状态代表「没有正在进行的工作」，默认收起。
   *
   * 提为模块级常量而不是在 defaultExpanded 里每次新建 Set：该函数位于渲染路径上，
   * 未手动覆盖展开状态的每个节点每帧都要判定一次，而词表内容恒定不变。
   */
  const DEFAULT_COLLAPSED_STATUSES = new Set(["idle", "ready", "succeeded", "cancelled"]);

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function text(value) {
    if (typeof value !== "string") return null;
    const valueText = value.trim();
    return valueText.length === 0 ? null : valueText;
  }

  function firstText() {
    for (const value of arguments) {
      const result = text(value);
      if (result !== null) return result;
    }
    return null;
  }

  function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  /**
   * 两个时间戳之间的耗时（毫秒）；任一缺失返回 null。
   *
   * 只用于「Host 没有投影 durationMs、但同一节点确实带着 startedAt/finishedAt」的旧快照：
   * 这是从可证明的时间戳算出来的事实，不是伪造；未知不写 0，时钟回拨按 0 处理。
   */
  function durationBetween(startedAt, finishedAt) {
    if (startedAt === null || finishedAt === null) return null;
    return Math.max(0, finishedAt - startedAt);
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
   * 失败摘要里的绝对路径脱敏（客户端侧的第二道防线）。
   *
   * Host 投影已经做过同样的事，但旧 Host、第三方负载或未来字段变化都可能绕过它；侧栏是
   * 信息外泄面最小的位置，宁可在客户端再脱敏一次。模式与 Host 保持同构：
   * 引号内含空格的路径 → 未加引号的盘符/UNC/POSIX 路径；刻意不匹配词中间的斜杠
   * （and/or、https://host/path 不误伤）。
   */
  const QUOTED_WINDOWS_PATH_PATTERN = /(["'])[A-Za-z]:[\\/][^"'\r\n]*\1/g;
  const QUOTED_POSIX_PATH_PATTERN = /(["'])\/[^"'\r\n]*\1/g;
  const WINDOWS_ABSOLUTE_PATH_PATTERN = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'\x60,;!?)\]}]*/g;
  const UNC_ABSOLUTE_PATH_PATTERN = /\\\\[^\s"'\x60,;!?)\]}]+/g;
  const POSIX_ABSOLUTE_PATH_PATTERN = /(^|[\s("'\x60=\[\]])\/(?:[^\s"'\x60/]+\/)+[^\s"'\x60,;!?)\]}]*/g;

  function redactFailurePaths(value) {
    return value
      .replace(QUOTED_WINDOWS_PATH_PATTERN, "$1<path>$1")
      .replace(QUOTED_POSIX_PATH_PATTERN, "$1<path>$1")
      .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "$1<path>")
      .replace(UNC_ABSOLUTE_PATH_PATTERN, "<path>")
      .replace(POSIX_ABSOLUTE_PATH_PATTERN, "$1<path>");
  }

  function collapseFailureMessage(value) {
    const raw = text(value);
    if (raw === null) return null;
    // 只保留首行：堆栈（"...\n    at ..."）的多行文本在这里被彻底截断，绝不进入 UI。
    const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
    const collapsed = firstLine
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (collapsed.length === 0) return null;
    const truncated = collapsed.length > FAILURE_MESSAGE_MAX_LENGTH
      ? collapsed.slice(0, FAILURE_MESSAGE_MAX_LENGTH)
      : collapsed;
    const redacted = redactFailurePaths(truncated).trim();
    return redacted.length === 0 ? null : redacted;
  }

  /**
   * 受限失败摘要归一：形状恒为 { code, message } 或 null。
   *
   * - 只有对象输入才可能产生摘要（字符串/数字等自由负载一律丢弃：没有错误就没有摘要）；
   * - code：非空稳定 token，剔除控制字符后限 64 字符，缺失回退 "error"（与 Host 同一 fallback）；
   * - message：首行、去控制字符、绝对路径脱敏、限 160 字符，缺失为 null（键始终存在）；
   * - 绝不读 stack/prompt/result/凭据字段：即使负载里带着它们也不会被复制。
   */
  function normalizeFailure(value) {
    if (!isObject(value)) return null;
    const rawCode = text(value.code);
    const cleanedCode = rawCode === null ? "" : rawCode.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "").trim();
    const code = cleanedCode.length === 0 ? "error" : cleanedCode.slice(0, FAILURE_CODE_MAX_LENGTH);
    return { code, message: collapseFailureMessage(value.message) };
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

  function normalizeStatus(value) {
    const source = text(value);
    if (source === null) return "unknown";
    const key = source.toLowerCase().replace(/\s+/g, "_");
    if (STATUSES.has(key)) return key;
    return STATUS_ALIASES[key] || "unknown";
  }

  function statusFromTask(value) {
    const source = text(value);
    if (source === "pending") return "running";
    if (source === "completed" || source === "complete") return "succeeded";
    if (source === "completed_with_errors") return "failed";
    return normalizeStatus(source);
  }

  function identityOf(value) {
    const source = isObject(value) ? value : {};
    return firstText(source.id, source.sessionId, source.childId, source.parentTaskId);
  }

  function runningOf(status, explicit) {
    if (typeof explicit === "boolean") return explicit;
    if (status === "unknown") return null;
    return status === "running" || status === "waiting";
  }

  /**
   * 活动证据链（圆点与第三行文案共用同一份判定，避免两者互相矛盾）。
   *
   * 优先级固定，先命中先返回：
   * 1. 官方目录项 `activity`：running / inactive——这是 DSH 实时活动轴，最高优先级，
   *    即使 Host snapshot 的旧 running/status 与之冲突也以它为准；
   * 2. 官方目录项可识别的 `status`：running / idle；
   * 3. Host 快照的 `running` 布尔；
   * 4. 协议 `status`：running 为运行，其余已知值（idle/queued/waiting/终态）为未运行。
   * 都不成立时返回 null：展示层不猜——没有明确运行证据就落回 ready、也不加活动文案。
   * @returns {"running"|"inactive"|null}
   */
  function activitySignalOf(node, entry) {
    const source = isObject(node) ? node : {};
    const catalog = isObject(entry) ? entry : {};
    const activity = text(catalog.activity);
    if (activity === "running") return "running";
    if (activity === "inactive") return "inactive";
    const catalogStatus = text(catalog.status);
    if (catalogStatus === "running") return "running";
    if (catalogStatus === "idle") return "inactive";
    if (typeof source.running === "boolean") return source.running ? "running" : "inactive";
    const protocolStatus = normalizeStatus(source.status);
    if (protocolStatus === "running") return "running";
    if (protocolStatus !== "unknown") return "inactive";
    return null;
  }

  /**
   * 轻量（partial）快照下的中性运行状态：既不声明运行，也不声明已结束。
   *
   * 与 ready 的区别：ready 是「有证据表明当前没在运行」（圆点渲染成绿色 done），
   * unknown 是「证据不足」——轻量快照跳过了冷读，此时既不能声明运行也不能声明结束，
   * 圆点与活动文案必须保持中性。它不是协议状态词表的一员，只用于展示层。
   */
  const UNKNOWN_RUNTIME_STATUS = "unknown";

  /**
   * 归一化代理运行状态：默认只有 running | ready；轻量快照下多一个中性值 unknown。
   *
   * 只用 activitySignalOf 的活动证据链：明确运行为 running，其余（inactive、缺失、
   * 目录未命中且无其它运行证据）一律 ready。目录 activity 与 Host 旧信号冲突时，
   * 以目录 activity 为准，不把真实 running 降级成 ready。
   *
   * partial 选项（Host 的轻量快照）：证据链返回 null（完全没有任何活动证据，既不是
   * running 也不是 inactive）时返回中性值 unknown，让圆点与活动文案保持中性；
   * 只要存在任何证据（目录 activity/status、节点 running 布尔、协议 status）就仍按原规则渲染。
   * 不传 options 时行为与旧实现逐字一致（旧 Host、测试与所有既有调用点不受影响）。
   *
   * @param {object} node - 快照节点（专家/根/fan-out 任务或分片）。
   * @param {object} [entry] - sessions 快照里的官方目录项。
   * @param {{partial?: boolean}} [options] - 展示层选项；partial 为 true 时才可能出现中性值。
   * @returns {"running"|"ready"|"unknown"}
   */
  function runtimeStatusOf(node, entry, options) {
    const signal = activitySignalOf(node, entry);
    if (signal === "running") return "running";
    if (isObject(options) && options.partial === true && signal === null) return UNKNOWN_RUNTIME_STATUS;
    return "ready";
  }

  function normalizeRunSummary(value) {
    if (!isObject(value)) return null;
    const mode = value.mode === "continuable" || value.mode === "one-shot" ? value.mode : "unknown";
    const activity = value.activity === "running" || value.activity === "idle" ? value.activity : "unknown";
    return { command: text(value.command), mode, activity };
  }

  /**
   * 恢复状态（recovery）块归一（票据 04）。
   *
   * Host 已在投影出口做了白名单与长度收敛；客户端仍做一次**只读、无猜测**的归一：
   * - 缺字段 / 非对象 ⇒ null（旧 Host 兼容：没有 recovery 就当作没有恢复错误，不渲染横幅）；
   * - status 只接受 ok/failed/none，其余落回 none；
   * - failed 才保留原因码；形态不符时用稳定兜底码 RESTORE_FAILED（与 Host 同一 fallback）；
   * - message 剔除控制字符并限制为一行（防御旧 Host / 第三方注入的负载）；
   * - retryable 只认明确 true，persistenceBlocked 同理（展示层不用它做判定）。
   */
  function normalizeRecovery(value) {
    if (!isObject(value)) return null;
    const status = value.status === "failed" || value.status === "ok" ? value.status : "none";
    const rawCode = text(value.code);
    const code = status === "failed"
      ? (rawCode !== null && RECOVERY_CODE_PATTERN.test(rawCode) ? rawCode : "RESTORE_FAILED")
      : null;
    const rawMessage = text(value.message);
    const message = status === "failed" && rawMessage !== null
      ? rawMessage.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, RECOVERY_MESSAGE_MAX_LENGTH) || null
      : null;
    return {
      status,
      code,
      message,
      at: numberOrNull(value.at),
      retryable: status === "failed" && value.retryable === true,
      persistenceBlocked: value.persistenceBlocked === true,
    };
  }

  // ── 票据 25 / 30 / 27：用量、结构化结果与角色标签的只读归一 ──────────────────
  //
  // 这些字段都来自 Host 快照投影（host/expert-group-snapshot.js）。客户端仍按「白名单 +
  // 有界」二次收敛：浏览器只信任明确形状的字段，缺失一律保持缺失（绝不补 0 / 补空对象），
  // 任何未知键都不会被复制进 normalized 快照（导出也随之一致）。

  /** 用量里的 token 字段（与 host/usage-ledger.js 的 TOKEN_FIELDS 同口径）。 */
  const USAGE_TOKEN_FIELDS = Object.freeze([
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens",
  ]);
  /** 用量里的计数类字段（Host 只投影 >0 的值；客户端同样不补 0）。 */
  const USAGE_COUNT_FIELDS = Object.freeze(["requests", "retries", "fallbacks"]);
  /** 用量归属文本（role/provider/model/roleLabel）的字符上限。 */
  const USAGE_TEXT_MAX_LENGTH = 128;
  /** 单条结构化结果 JSON 预览的字符上限：UI 只显示有界前缀，完整值仍留在导出 JSON 里。 */
  const STRUCTURED_PREVIEW_MAX_CHARS = 400;
  /**
   * 结构化结果回退原因的稳定词表与中文文案（与 shared.js 的
   * STRUCTURED_RESULT_FALLBACK_REASONS 一一对应；客户端不 import 共享模块，故持一份副本）。
   * 未知原因码不显示自由文本，统一回退到「结果不可用」。
   */
  const STRUCTURED_FALLBACK_REASONS = Object.freeze({
    missing_structured: "未收到结构化结果，已回退文本总结",
    result_unavailable: "结构化结果不可用，已回退文本总结",
    result_too_large: "结构化结果超过 64 KiB 上限，已回退文本总结",
    schema_not_restored: "冷恢复未恢复输出声明，本轮无法校验结构化结果",
  });
  const STRUCTURED_FALLBACK_REASON_SET = new Set(Object.keys(STRUCTURED_FALLBACK_REASONS));
  /** 顶层 roleLabels 映射的条目上限：角色目录本身上限 16 个自定义 + 内置 6 个，64 足够且防病态负载。 */
  const ROLE_LABEL_MAX_ENTRIES = 64;

  /** 安全非负整数（token/计数/字节/时间戳的唯一种合法形状）。 */
  function countOrNull(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  /** 有界文本：去空白、限长；非字符串/空白返回 null（绝不 String() 任意负载）。 */
  function boundedText(value, maxLength) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, maxLength);
  }

  /**
   * 用量投影归一（票据 25）。
   *
   * - token：只有安全非负整数才保留（真实的 0 是事实，保留；缺失不补 0）；
   * - billedInputTokens/totalTokens：能从分项重算就重算（与 Host projectUsage 同口径），
   *   否则保留持久化里合法的旧值；
   * - 计数（requests/retries/fallbacks）：只保留 >0 的值，缺失即未知；
   * - 归属文本（provider/model/role/roleLabel）与 runMs 有界保留；
   * - 没有任何 token/计数事实时返回 null —— 调用方据此显示「—」，绝不伪造零成本账目。
   */
  function normalizeUsage(value) {
    if (!isObject(value)) return null;
    const usage = {};
    for (const field of USAGE_TOKEN_FIELDS) {
      const count = countOrNull(value[field]);
      if (count !== null) usage[field] = count;
    }
    if (countOrNull(usage.inputTokens) !== null) {
      usage.billedInputTokens = usage.inputTokens
        + (countOrNull(usage.cacheReadTokens) ?? 0)
        + (countOrNull(usage.cacheWriteTokens) ?? 0);
      if (countOrNull(usage.outputTokens) !== null) {
        usage.totalTokens = usage.billedInputTokens + usage.outputTokens;
      }
    } else {
      const billed = countOrNull(value.billedInputTokens);
      if (billed !== null) usage.billedInputTokens = billed;
      const total = countOrNull(value.totalTokens);
      if (total !== null) usage.totalTokens = total;
    }
    for (const field of USAGE_COUNT_FIELDS) {
      const count = countOrNull(value[field]);
      if (count !== null && count > 0) usage[field] = count;
    }
    for (const field of ["provider", "model", "role", "roleLabel"]) {
      const textValue = boundedText(value[field], USAGE_TEXT_MAX_LENGTH);
      if (textValue !== null) usage[field] = textValue;
    }
    const runMs = countOrNull(value.runMs);
    if (runMs !== null) usage.runMs = runMs;
    const hasMetric = USAGE_TOKEN_FIELDS.concat(USAGE_COUNT_FIELDS)
      .some((field) => countOrNull(usage[field]) !== null && (usage[field] > 0 || field.endsWith("Tokens") === true));
    if (hasMetric !== true) return null;
    return usage;
  }

  /**
   * 结构化结果投影归一（票据 30）。
   *
   * - value 必须仍能被 JSON 序列化：序列化失败的负载按 result_unavailable 回退，不保留原文；
   * - 深拷贝一份纯 JSON 值（JSON.parse(JSON.stringify)），投影不把调用方对象引用带进快照；
   * - fallback/reason 只接受稳定词表，未知原因按「结果不可用」显示（见 structuredFallbackText）；
   * - 空对象返回 null（缺失 = 不渲染结构化区，绝不伪造 false）。
   */
  function normalizeStructured(value) {
    if (!isObject(value)) return null;
    const structured = {};
    let fallback = value.fallback === true;
    let reason = STRUCTURED_FALLBACK_REASON_SET.has(value.reason) ? value.reason : null;
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      let serialized;
      try { serialized = JSON.stringify(value.value); } catch { serialized = undefined; }
      if (serialized === undefined) {
        fallback = true;
        reason = reason ?? "result_unavailable";
      } else {
        try { structured.value = JSON.parse(serialized); } catch { fallback = true; reason = reason ?? "result_unavailable"; }
        structured.bytes = serialized.length;
      }
    }
    const bytes = countOrNull(value.bytes);
    if (bytes !== null) structured.bytes = bytes;
    const receivedAt = countOrNull(value.receivedAt);
    if (receivedAt !== null) structured.receivedAt = receivedAt;
    if (fallback === true) structured.fallback = true;
    if (reason !== null) structured.reason = reason;
    return Object.keys(structured).length === 0 ? null : structured;
  }

  /** 节点/attempt 上的 { usage } 可选字段（缺失整字段省略，绝不补空对象）。 */
  function usageFields(source) {
    const usage = normalizeUsage(isObject(source) ? source.usage : null);
    return usage === null ? {} : { usage };
  }

  /** 节点/attempt 上的结构化字段：{ structured?, outputSchemaRequested? }（缺失省略）。 */
  function structuredFields(source) {
    if (!isObject(source)) return {};
    const structured = normalizeStructured(source.structured);
    const requested = typeof source.outputSchemaRequested === "boolean" ? source.outputSchemaRequested : null;
    return {
      ...(structured === null ? {} : { structured }),
      ...(requested === null ? {} : { outputSchemaRequested: requested }),
    };
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
   * 顶层 roleLabels 归一（票据 27）：只保留「非空角色 id → 非空显示名」，超长截断、条数有界。
   * 没有任何合法条目时返回 null（调用方回退角色 id 显示）。
   */
  function normalizeRoleLabels(value) {
    if (!isObject(value)) return null;
    const labels = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= ROLE_LABEL_MAX_ENTRIES) break;
      const roleId = boundedText(key, 64);
      const label = boundedText(value[key], USAGE_TEXT_MAX_LENGTH);
      if (roleId === null || label === null) continue;
      labels[roleId] = label;
      count += 1;
    }
    return count === 0 ? null : labels;
  }

  /** 从 roleLabels 映射取显示名；没有合法映射项返回 null（调用方再回退角色 id）。 */
  function roleLabelFrom(role, labels) {
    const roleId = text(role);
    if (roleId === null || !isObject(labels)) return null;
    return boundedText(labels[roleId], USAGE_TEXT_MAX_LENGTH);
  }

  /** 角色显示名（票据 27）：roleLabels 优先，回退角色 id；两者都没有返回 null。 */
  function roleLabelOf(role, labels) {
    return roleLabelFrom(role, labels) ?? text(role);
  }

  /**
   * 按 provider+model 查找单价（票据 25）。
   *
   * 比较忽略大小写与首尾空白（Host 读取面保留用户原文，用户不必精确匹配大小写）；
   * 查不到返回 null —— 调用方显示「未配置单价，不估算」，绝不返回 0 成本。
   */
  function findModelPrice(prices, provider, model) {
    if (!Array.isArray(prices)) return null;
    const wantProvider = boundedText(provider, USAGE_TEXT_MAX_LENGTH);
    const wantModel = boundedText(model, USAGE_TEXT_MAX_LENGTH);
    if (wantProvider === null || wantModel === null) return null;
    for (const entry of prices) {
      if (!isObject(entry)) continue;
      const entryProvider = boundedText(entry.provider, USAGE_TEXT_MAX_LENGTH);
      const entryModel = boundedText(entry.model, USAGE_TEXT_MAX_LENGTH);
      if (entryProvider === null || entryModel === null) continue;
      if (entryProvider.toLowerCase() === wantProvider.toLowerCase()
        && entryModel.toLowerCase() === wantModel.toLowerCase()) return entry;
    }
    return null;
  }

  /**
   * 估算成本（纯函数，票据 25）：与 host/usage-ledger.js 的 estimateUsageCost 同规则。
   *
   * 只有 usage 有计费输入与输出 token、且单价同时给出合法的每百万输入/输出价格时才计算；
   * 缺单价返回 null（UI 显示「未配置单价，不估算」）。金额不四舍五入，展示精度由调用方决定。
   */
  function estimateUsageCost(usage, price) {
    const projected = normalizeUsage(usage);
    if (projected === null || !isObject(price)) return null;
    const billedInput = countOrNull(projected.billedInputTokens) ?? countOrNull(projected.inputTokens);
    const output = countOrNull(projected.outputTokens);
    const inputRate = numberOrNull(price.inputPerMillion);
    const outputRate = numberOrNull(price.outputPerMillion);
    if (billedInput === null || output === null) return null;
    if (inputRate === null || outputRate === null || inputRate < 0 || outputRate < 0) return null;
    const inputCost = (billedInput / 1000000) * inputRate;
    const outputCost = (output / 1000000) * outputRate;
    return Object.freeze({
      currency: boundedText(price.currency, 8) ?? "USD",
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    });
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

  /**
   * 单项能力归一（客户端侧的严格白名单）。
   *
   * Host 已做过一次收敛，但浏览器仍不能信任任意负载：
   * - 只有 allowed 是布尔才产生有效项，其它形状一律丢弃（旧 Host/第三方注入不获得按钮）；
   * - allowed=true 时丢弃 reason；allowed=false 时 reason 必须是字符串并截断，
   *   缺失时回退稳定 token not_supported（绝不渲染空原因）。
   */
  function normalizeCapabilityEntry(value) {
    if (!isObject(value) || typeof value.allowed !== "boolean") return null;
    if (value.allowed === true) return { allowed: true };
    const reason = text(value.reason);
    return {
      allowed: false,
      reason: reason === null ? "not_supported" : reason.slice(0, CAPABILITY_REASON_MAX_LENGTH),
    };
  }

  /** 按动作词表归一能力对象；没有任何有效动作时返回 null（调用方省略字段并回退旧行为）。 */
  function normalizeCapabilities(value, actions) {
    if (!isObject(value)) return null;
    const normalized = {};
    let any = false;
    for (const action of actions) {
      const entry = normalizeCapabilityEntry(value[action]);
      if (entry === null) continue;
      normalized[action] = entry;
      any = true;
    }
    return any ? normalized : null;
  }

  /**
   * 节点级时间线字段归一（fanout/shard 共用，票据 12）。
   *
   * Host 投影的字段恒存在；旧快照可能一个都没有。规则：
   * - startedAt：缺失时用 fallback（fanout/shard 都可回退 createdAt，与 Host 同义）；
   * - finishedAt：只取**输入里显式给出的值**，绝不按状态补一个完成时间（运行中的分片没有终点）；
   * - durationMs：缺失时由 startedAt/finishedAt 推导（旧快照仍带着两端时间戳），两者都缺就是 null；
   * - attemptCount：缺失时由调用方给出的可证明结构（attempts.length / 分片汇总）回退，再缺为 0；
   * - retryCount：缺失时按 max(0, attemptCount-1) 回退，绝不臆造 maxAttempts；
   * - failure：受限摘要或 null（形状见 normalizeFailure）。
   */
  function normalizeTimelineFields(source, fallback) {
    const defaults = isObject(fallback) ? fallback : {};
    const startedAt = numberOrNull(source.startedAt) ?? numberOrNull(defaults.startedAt);
    // 明确仍在进行中的节点没有完成时间：即使输入误带 finishedAt/durationMs 也不采用，
    // 否则侧栏会把「正在跑」渲染成「已耗时 X」。状态缺失/unknown 时保持宽容。
    const stillActive = ACTIVE_STATUS_SET.has(normalizeStatus(source.status));
    const finishedAt = stillActive ? null : numberOrNull(source.finishedAt);
    const attemptCount = numberOrNull(source.attemptCount) ?? (numberOrNull(defaults.attemptCount) ?? 0);
    return {
      startedAt,
      finishedAt,
      durationMs: stillActive ? null : (numberOrNull(source.durationMs) ?? durationBetween(startedAt, finishedAt)),
      lastActivityAt: numberOrNull(source.lastActivityAt) ?? numberOrNull(defaults.lastActivityAt),
      attemptCount,
      retryCount: numberOrNull(source.retryCount) ?? (numberOrNull(defaults.retryCount) ?? Math.max(0, attemptCount - 1)),
      failure: normalizeFailure(source.failure),
    };
  }

  function normalizeAttempt(value) {
    const source = isObject(value) ? value : {};
    const startedAt = numberOrNull(source.startedAt);
    // 运行/排队中的 attempt 没有完成时间：误带的 finishedAt 一律丢弃，避免时间线出现"运行中 1.2s"。
    const stillActive = ACTIVE_STATUS_SET.has(normalizeStatus(source.status));
    const finishedAt = stillActive ? null : numberOrNull(source.finishedAt);
    return {
      attempt: numberOrNull(source.attempt),
      status: normalizeStatus(source.status),
      childId: text(source.childId),
      // 角色显示名（票据 27）：Host 在 child_models/attempt 里保留 roleLabel，角色被删除后历史任务仍可读。
      roleLabel: text(source.roleLabel),
      // 票据 25/30：attempt 级的用量与结构化结果；缺失整字段省略（不伪造 0 / 不伪造空结果）。
      ...usageFields(source),
      ...structuredFields(source),
      startedAt,
      finishedAt,
      // 旧快照的 attempt 只有两端时间戳；从它们算出耗时是事实推导，不是伪造。
      durationMs: stillActive ? null : (numberOrNull(source.durationMs) ?? durationBetween(startedAt, finishedAt)),
      failure: normalizeFailure(source.failure),
    };
  }

  function normalizeShard(value, inherited) {
    const source = isObject(value) ? value : {};
    const defaults = isObject(inherited) ? inherited : {};
    const attempts = Array.isArray(source.attempts) ? source.attempts.map(normalizeAttempt) : [];
    const latest = attempts.length === 0 ? null : attempts[attempts.length - 1];
    const managerStatus = source.status === undefined ? "unknown" : normalizeStatus(source.status);
    // Host 已将 fan-out manager 与 attempt 历史归并成权威状态；客户端仅在旧 Host
    // 没有投影该字段时用最新 attempt 补全，避免浏览器再次解释协议并产生漂移。
    const status = managerStatus !== "unknown" ? managerStatus : (latest?.status ?? "unknown");
    return {
      shardId: text(source.shardId),
      // taskName 是 Host 投影的权威分片任务名（优先任务名称，旧数据回退分片代号）；
      // 客户端只在旧 Host 完全没有投影该字段时才用 shardId 兜底，绝不反过来覆盖已有名称。
      taskName: firstText(source.taskName, source.shardId),
      prompt: firstText(source.prompt, source.content),
      role: firstText(source.role, defaults.role),
      // 角色显示名（票据 27）：分片自身的 roleLabel 优先，缺失回退父任务继承值。
      roleLabel: firstText(source.roleLabel, defaults.roleLabel),
      provider: firstText(source.provider, defaults.provider),
      model: firstText(source.model, defaults.model),
      effort: firstText(source.effort, source.reasoningEffort, defaults.effort, defaults.reasoningEffort),
      status,
      // 票据 25/30：分片级用量与最新 attempt 的结构化结果（Host 已投影在分片上）。
      ...usageFields(source),
      ...structuredFields(source),
      running: runningOf(status, source.running),
      runSummary: normalizeRunSummary(source.runSummary),
      // 当前/最近一轮 turn 墙钟（与 DSH 状态行同源）；旧快照缺失时为 null。
      turnDurationMs: numberOrNull(source.turnDurationMs),
      continuable: typeof source.continuable === "boolean" ? source.continuable : null,
      // shard 能力（票据 09）：只有 Host 给出可判定项时才存在；缺失时渲染层回退状态推导。
      ...(() => {
        const capabilities = normalizeCapabilities(source.capabilities, SHARD_CAPABILITY_ACTIONS);
        return capabilities === null ? {} : { capabilities };
      })(),
      childId: latest?.childId ?? text(source.childId),
      createdAt: numberOrNull(source.createdAt),
      attempts,
      // 时间线（票据 12）：字段恒存在，旧快照缺失时为 null/0。startedAt 回退 createdAt 与
      // Host 的 projectShardTimeline 同义；attemptCount 在旧快照里可由 attempts 长度证明。
      ...normalizeTimelineFields(source, {
        startedAt: numberOrNull(source.createdAt),
        attemptCount: attempts.length,
      }),
    };
  }

  function normalizeCounts(value) {
    if (!isObject(value)) return null;
    const result = {};
    for (const field of COUNT_FIELDS) result[field] = numberOrNull(value[field]);
    return result;
  }

  function normalizeFanout(value) {
    const source = isObject(value) ? value : {};
    const parentTaskId = text(source.parentTaskId);
    const taskStatus = text(source.taskStatus) || text(source.status);
    const status = taskStatus === null ? "unknown" : statusFromTask(taskStatus);
    const rawShards = Array.isArray(source.shards) ? source.shards : [];
    // 先归一分片，父任务的 attemptCount/retryCount 才能用分片汇总做旧快照回退
    // （与 Host projectFanoutTimeline 的汇总口径一致：父任务不把同一份 attempts 再算一遍）。
    const shards = rawShards.map((shard) => normalizeShard(shard, source));
    let shardAttemptCount = 0;
    let shardRetryCount = 0;
    for (const shard of shards) {
      shardAttemptCount += numberOrNull(shard.attemptCount) ?? 0;
      shardRetryCount += numberOrNull(shard.retryCount) ?? 0;
    }
    return {
      id: parentTaskId,
      kind: "fanout",
      parentTaskId,
      taskName: firstText(source.taskName, source.title),
      content: firstText(source.content),
      basePrompt: firstText(source.basePrompt, source.content),
      contentSource: text(source.contentSource),
      role: text(source.role),
      // 角色显示名（票据 27）：父任务角色被删除后仍保留创建期标签。
      roleLabel: text(source.roleLabel),
      provider: text(source.provider),
      model: text(source.model),
      effort: firstText(source.effort, source.reasoningEffort),
      taskStatus,
      status,
      running: runningOf(status, source.running),
      createdAt: numberOrNull(source.createdAt),
      counts: normalizeCounts(source.counts),
      // 票据 25/30：父任务用量（按 childId 去重汇总）与逐 attempt 的结构化结果数组。
      ...usageFields(source),
      ...(() => {
        // task 级 structured 是逐 attempt 的数组（shardId/attempt/childId/structured），Host 明确
        // 不合并 value；这里只收敛每个条目的白名单字段，空数组按缺失处理（不渲染空结构化区）。
        if (!Array.isArray(source.structured)) return {};
        const entries = [];
        for (const entry of source.structured) {
          if (!isObject(entry)) continue;
          const inner = normalizeStructured(entry.structured);
          if (inner === null) continue;
          const shardId = boundedText(entry.shardId, USAGE_TEXT_MAX_LENGTH);
          const childId = boundedText(entry.childId, USAGE_TEXT_MAX_LENGTH);
          const attempt = countOrNull(entry.attempt);
          entries.push({
            ...(shardId === null ? {} : { shardId }),
            ...(attempt === null ? {} : { attempt }),
            ...(childId === null ? {} : { childId }),
            structured: inner,
          });
        }
        return entries.length === 0 ? {} : { structured: entries };
      })(),
      // 父任务能力：Host 权威投影；缺失（旧 Host）时省略字段，侧栏回退 ACTIVE/RETRY 状态推导。
      ...(() => {
        const capabilities = normalizeCapabilities(source.capabilities, CAPABILITY_ACTIONS);
        return capabilities === null ? {} : { capabilities };
      })(),
      shards,
      // 时间线（票据 12）：startedAt 回退 createdAt；旧快照的计数用分片汇总回退。
      ...normalizeTimelineFields(source, {
        startedAt: numberOrNull(source.createdAt),
        attemptCount: shardAttemptCount,
        retryCount: shardRetryCount,
      }),
    };
  }

  /**
   * 会话节点归一（root / 普通专家共用）。
   *
   * depth 只用于嵌套专家子树的递归归一（Host 当前投影是 flat 的：普通专家是叶子 worker，
   * 不会下发 children；旧快照或未来投影若带嵌套子节点，这里保留它，渲染层本来就有递归展示
   * 分支）。超过 MAX_NESTED_EXPERT_DEPTH 的子树直接截断为叶子，绝不让病态负载造成深递归。
   *
   * 时间线（票据 12）：DSH 只发布创建时间，finishedAt/durationMs 通常恒为 null——这里绝不
   * 用 createdAt 造完成时间；旧快照缺 startedAt/lastActivityAt 时回退 createdAt（Host 同义）。
   */
  function normalizeSessionNode(value, kind, fallbackId, depth) {
    const source = isObject(value) ? value : {};
    const id = firstText(source.id, source.sessionId, fallbackId);
    const status = normalizeStatus(source.status);
    const nestedDepth = numberOrNull(depth) ?? 0;
    const createdAt = numberOrNull(source.createdAt);
    const startedAt = numberOrNull(source.startedAt) ?? createdAt;
    const finishedAt = numberOrNull(source.finishedAt);
    const rawChildren = kind === "expert" && nestedDepth < MAX_NESTED_EXPERT_DEPTH && Array.isArray(source.children)
      ? source.children
      : [];
    return {
      id,
      kind,
      sessionId: firstText(source.sessionId, source.id, fallbackId),
      taskName: firstText(source.taskName, source.task, source.title, source.displayTitle, source.label, source.name),
      content: firstText(source.content, source.prompt),
      contentSource: text(source.contentSource),
      role: text(source.role),
      // 角色显示名（票据 27）：优先节点自带的 roleLabel，调用方再回退 snapshot.roleLabels / meta。
      roleLabel: text(source.roleLabel),
      provider: text(source.provider),
      model: text(source.model),
      effort: firstText(source.effort, source.reasoningEffort),
      status,
      running: runningOf(status, source.running),
      runSummary: normalizeRunSummary(source.runSummary),
      // 票据 25/30：专家/根节点的用量与结构化结果（缺失整字段省略）。
      ...usageFields(source),
      ...structuredFields(source),
      continuable: typeof source.continuable === "boolean" ? source.continuable : null,
      // 会话节点（root/普通专家）的能力对象：只描述 read/写动作是否适用，
      // 侧栏不会在这些节点上渲染 fan-out 管理按钮。
      ...(() => {
        const capabilities = normalizeCapabilities(source.capabilities, CAPABILITY_ACTIONS);
        return capabilities === null ? {} : { capabilities };
      })(),
      createdAt,
      startedAt,
      lastActivityAt: numberOrNull(source.lastActivityAt) ?? startedAt,
      finishedAt,
      durationMs: numberOrNull(source.durationMs) ?? durationBetween(startedAt, finishedAt),
      // 当前/最近一轮 turn 墙钟（与 DSH 状态行同源）；旧快照缺失时为 null。
      turnDurationMs: numberOrNull(source.turnDurationMs),
      children: rawChildren.map((child) => normalizeSessionNode(child, "expert", null, nestedDepth + 1)),
    };
  }

  function attemptChildIds(nodes) {
    const ids = new Set();
    for (const node of nodes) {
      if (node.kind !== "fanout") continue;
      for (const shard of node.shards) for (const attempt of shard.attempts) {
        if (attempt.childId !== null) ids.add(attempt.childId);
      }
    }
    return ids;
  }

  function childSourceList(raw, root) {
    if (Array.isArray(root?.children)) return root.children;
    const expertChildren = Array.isArray(raw?.experts) ? raw.experts : [];
    const fanoutChildren = Array.isArray(raw?.fanoutTasks)
      ? raw.fanoutTasks
      : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    return [...expertChildren, ...fanoutChildren];
  }

  /**
   * 快照归一。
   *
   * partial 是 Host 新增的快照级标记：true = **轻量快照**（Host 跳过了全部冷读，状态可能不完整），
   * false/缺失 = 完整权威快照。客户端只把它当成「状态证据不完整」的信号，渲染规则见
   * runtimeStatusOf 的 partial 选项；缺失时按完整快照处理（旧 Host 行为不变）。
   */
  function normalizeExpertGroupSnapshot(raw) {
    if (!isObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) return null;
    const sourceRoot = isObject(raw.root) ? raw.root : {};
    const rootSessionId = firstText(raw.rootSessionId, raw.sessionId, sourceRoot.sessionId, sourceRoot.id);
    if (rootSessionId === null) return null;
    const root = normalizeSessionNode(sourceRoot, "root", rootSessionId);
    root.sessionId = rootSessionId;
    root.id = rootSessionId;
    const rawChildren = childSourceList(raw, sourceRoot);
    const children = rawChildren.map((child) => {
      const kind = isObject(child) && child.kind === "fanout" ? "fanout" : "expert";
      return kind === "fanout" ? normalizeFanout(child) : normalizeSessionNode(child, "expert");
    });
    const fanoutIds = attemptChildIds(children);
    root.children = children.filter((child) => child.kind !== "expert" || child.sessionId === null || !fanoutIds.has(child.sessionId));
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId: rootSessionId,
      rootSessionId,
      generatedAt: numberOrNull(raw.generatedAt),
      // 顶层内容摘要（Host 新增，票据 12）：旧快照缺失时为 null。侧栏的 samePanelSnapshot
      // 语义不依赖它（generatedAt 仍被显式忽略），它只用于导出与诊断的稳定标识。
      revision: text(raw.revision),
      partial: raw.partial === true,
      // recovery 是 Host 新增的**可选**顶层块：缺失/非法时为 null（旧 Host 行为逐字不变，
      // 侧栏据此不渲染任何恢复错误横幅）。
      recovery: normalizeRecovery(raw.recovery),
      // 票据 27：角色显示名映射（含历史角色显示名，包括已删除角色的持久化标签）。
      // 缺失/非法为 null，侧栏回退角色 id。
      roleLabels: normalizeRoleLabels(raw.roleLabels),
      root,
    };
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
  "notify.waitLong.body": {
    zh: "专家任务已等待超过 30 分钟仍未结算。若权威查询确认没有运行中的后代，可用 dsh_expert_group_abandon_wait 手动关闭等待账本；它不会终止专家，也不会释放影响范围保护。",
    en: "The expert task has been waiting more than 30 minutes without settling. If an authoritative query confirms no running descendants, use dsh_expert_group_abandon_wait to close the wait ledger manually; it neither stops experts nor releases impact-scope protection.",
  },
  "notify.waitQueryDegraded.body": {
    zh: "无法确认专家后代的运行状态（后代查询降级或失败），root turn 会继续等待；未知状态不等于专家已完成。",
    en: "The running state of expert descendants cannot be confirmed (descendant query degraded or failed); the root turn keeps waiting. Unknown is not the same as completed.",
  },
  "notify.waitDeliveryFailed.body": {
    zh: "专家批次已静止，但收口结论投递失败；批次保持待收口，插件会在后续 root turn 重试。",
    en: "The expert batch is quiescent but delivering the finalization result failed; the batch remains pending and the plugin retries on later root turns.",
  },
});
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

  global[SYMBOL] = Object.freeze({
    SCHEMA_VERSION,
    RUNTIME_STATUSES,
    UNKNOWN_RUNTIME_STATUS,
    // 票据 12：客户端时间线/过滤/导出的公开常量与纯函数。
    // 常量供渲染层与测试共用（避免两处各存一份阈值/上限）。
    FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
    RETRY_WARNING_THRESHOLD,
    ATTEMPT_TIMELINE_LIMIT,
    FAILURE_STATUSES,
    STATUS_FILTER_GROUPS,
    normalizeExpertGroupSnapshot,
    normalizeCapabilities,
    normalizeStatus,
    normalizeFailure,
    formatFailureSummary,
    isFailureStatus,
    formatDuration,
    formatClockTime,
    formatIsoTime,
    attemptTimelineOf,
    // 票据 25 / 27 / 30：用量、结构化结果与角色显示名的纯函数与常量。
    STRUCTURED_PREVIEW_MAX_CHARS,
    STRUCTURED_FALLBACK_REASONS,
    normalizeUsage,
    normalizeStructured,
    structuredFallbackText,
    structuredPreviewOf,
    normalizeRoleLabels,
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
    formatExpertMetadata,
    defaultExpanded,
    createExpansionStore,
    // 票据 19：文案层投影与 locale 解析（权威实现语义见 shared.js）。
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
