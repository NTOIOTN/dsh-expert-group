/**
 * 专家组客户端模型的「归一与状态推导」族（R8 票据 29）。
 *
 * 票据 29 把原 1,881 行的 client-expert-group-model.js 按职责拆成两个模块，本文件承接
 * **归一与状态推导**这一半：
 * 1. 无副作用原语：isObject / text / firstText / numberOrNull，以及有界归一原语
 *    （countOrNull / boundedText / durationBetween / collapseFailureMessage / redactFailurePaths）；
 * 2. 状态推导：normalizeStatus / statusFromTask / runningOf / activitySignalOf /
 *    runtimeStatusOf，以及运行摘要（normalizeRunSummary）与恢复块（normalizeRecovery）归一；
 * 3. 快照树归一：能力、时间线、attempt / shard / fanout / session 节点，直到
 *    normalizeExpertGroupSnapshot —— 快照树归一是状态推导的核心，不留在展示侧。
 *
 * ## 依赖方向（单一，由 scripts/check-dependency-graph.mjs 验证）
 * 本模块不读取任何兄弟 IIFE 的检查点；client-expert-group-model-format.js 读取本模块的
 * 检查点；门面 client-expert-group-model.js 读取本模块与 format 两者。
 * 因此 normalize → format → 门面 是唯一允许的方向，本文件**不得**出现对 format 的读取。
 *
 * ## 归属完整性
 * 拆出的 76 个顶层函数在本模块与 format 模块中各有唯一归属（38 + 38），
 * 公开导出面仍由门面按原键集合与键顺序重组，键与顺序均不变。
 *
 * 硬上限（文件 ≤1,500 行 / 函数 ≤200 行）由 scripts/check-module-size.mjs 实测。
 */
(function installExpertGroupModelNormalize(global) {
  "use strict";

  /**
   * classic 片段发布本模块导出面用的 globalThis Symbol 键。
   *
   * 公开面（dsh-expert-group/client-expert-group-model）仍由门面按原顺序重组；
   * 本键只服务装配期内部读取，因此只暴露被 format 与门面实际消费的符号。
   */
  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model-normalize");

  // 版本写进存储键和快照边界，防止新旧页面把同一份折叠状态误读成不同语义。
  // 快照边界（normalizeExpertGroupSnapshot，本模块）与折叠状态存储键（createExpansionStore，
  // format 模块经检查点读取）共用同一份值，因此定义留在归一模块。
  const SCHEMA_VERSION = 1;

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

  /**
   * 时段 / 层 / 跨层回退的只读词表（票据 06）。
   *
   * 客户端**绝不按当前设置或当前时钟推断**这三个字段：Host 快照里存在才透传，缺失不补默认
   * 值。词表与 shared/route-snapshot.js 的 ROUTE_PERIODS / ROUTE_TIERS 同值——浏览器侧只加载
   * 装配后的 bundle、不能 import Helper 模块，因此与其它客户端常量一样保留同值副本；
   * 破坏性改动必须两边同步（口径见文件头注释）。
   */
  const ROUTE_PERIOD_VALUES = Object.freeze(["peak", "valley", "none"]);
  const ROUTE_TIER_VALUES = Object.freeze(["peak", "valley", "normal-override", "normal-fallback"]);
  const ROUTE_TEXT_MAX_LENGTH = 64;

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
  // 展示侧的同源常量（失败摘要显示上限、重试阈值、时间线条数、失败状态集合与
  // 状态筛选分组）随 format 模块迁出，见 client-expert-group-model-format.js；
  // 两份定义必须保持同值，破坏性改动两边同步。

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
   * 轻量（partial）快照下的中性运行状态：既不声明运行，也不声明已结束。
   *
   * 与 ready 的区别：ready 是「有证据表明当前没在运行」（圆点渲染成绿色 done），
   * unknown 是「证据不足」——轻量快照跳过了冷读，此时既不能声明运行也不能声明结束，
   * 圆点与活动文案必须保持中性。它不是协议状态词表的一员，只用于展示层。
   */
  const UNKNOWN_RUNTIME_STATUS = "unknown";

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

  /**
   * 跨层回退白名单归一（票据 06）：形状不完整就整字段省略，绝不补默认值。
   *
   * 为什么逐字段校验：Host 已经收敛过一次，但旧 Host 或手工合成的负载仍可能夹带自由文本；
   * 客户端只承认固定枚举、稳定原因码与角色 id（均限长、去空白），不还原任何候选清单。
   */
  function normalizeRouteFallback(value) {
    if (!isObject(value)) return null;
    if (value.fromTier !== "peak" && value.fromTier !== "valley") return null;
    if (value.toTier !== "normal-fallback") return null;
    const reasonCode = boundedText(value.reasonCode, ROUTE_TEXT_MAX_LENGTH);
    if (reasonCode === null) return null;
    const role = boundedText(value.role, ROUTE_TEXT_MAX_LENGTH);
    return {
      fromTier: value.fromTier,
      toTier: "normal-fallback",
      reasonCode,
      ...(role === null ? {} : { role }),
    };
  }

  /**
   * attempt / shard / fanout / 会话节点的时段·层·跨层回退字段（票据 06）。
   *
   * 纯只读投影：存在才透传，缺失不写默认值（旧 Host 的快照因此不会凭空多出三个键）；
   * 客户端也不做任何「按当前时段补一个值」的推断。
   */
  function routeFields(value) {
    const source = isObject(value) ? value : {};
    const fallback = normalizeRouteFallback(source.ordinaryFallback);
    return {
      ...(ROUTE_PERIOD_VALUES.includes(source.routePeriod) ? { routePeriod: source.routePeriod } : {}),
      ...(ROUTE_TIER_VALUES.includes(source.routeTier) ? { routeTier: source.routeTier } : {}),
      ...(fallback === null ? {} : { ordinaryFallback: fallback }),
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
      // 时段/层/跨层回退（票据 06）：存在才透传，缺失不补默认值。
      ...routeFields(source),
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
      // 时段/层/跨层回退（票据 06）：来自 Host 投影，客户端只读透传。
      ...routeFields(source),
      status,
      // 票据 25/30：分片级用量与最新 attempt 的结构化结果（Host 已投影在分片上）。
      ...usageFields(source),
      ...structuredFields(source),
      running: runningOf(status, source.running),
      runSummary: normalizeRunSummary(source.runSummary),
      // 该会话全部 turn 的累计墙钟（与 DSH 状态行同源，轮次之间空闲不计）；旧快照缺失时为 null。
      turnDurationMs: numberOrNull(source.turnDurationMs),
      // 最后一个未闭合 turn 的起点（additive）：客户端锚定外推的唯一依据；闭合/旧快照为 null。
      turnOpenSince: numberOrNull(source.turnOpenSince),
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
      // 时段/层/跨层回退（票据 06）：父任务节点同样只读透传。
      ...routeFields(source),
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
      // 时段/层/跨层回退（票据 06）：会话节点（root/普通专家）同样只读透传，不做推断。
      ...routeFields(source),
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
      // 该会话全部 turn 的累计墙钟（与 DSH 状态行同源，轮次之间空闲不计）；旧快照缺失时为 null。
      turnDurationMs: numberOrNull(source.turnDurationMs),
      // 最后一个未闭合 turn 的起点（additive）：客户端锚定外推的唯一依据；闭合/旧快照为 null。
      turnOpenSince: numberOrNull(source.turnOpenSince),
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

  // 只暴露被实际消费的符号：门面要重组的公开常量与归一/状态推导族，加上 format 读取的
  // 原语与 normalizeAttempt（attemptTimelineOf 复用同一份 attempt 归一）。
  global[SYMBOL] = Object.freeze({
    // 常量：门面重组公开面、format 的展示/过滤/导出族都读同一份词表。
    SCHEMA_VERSION,
    RUNTIME_STATUSES,
    UNKNOWN_RUNTIME_STATUS,
    STRUCTURED_FALLBACK_REASONS,
    STRUCTURED_FALLBACK_REASON_SET,
    MAX_NESTED_EXPERT_DEPTH,
    // 归一与状态推导族（门面按原顺序发布）。
    normalizeExpertGroupSnapshot,
    normalizeCapabilities,
    normalizeStatus,
    normalizeFailure,
    normalizeUsage,
    normalizeStructured,
    roleLabelFrom,
    roleLabelOf,
    findModelPrice,
    estimateUsageCost,
    runtimeStatusOf,
    // format 模块读取的原语。
    isObject,
    text,
    firstText,
    numberOrNull,
    countOrNull,
    redactFailurePaths,
    normalizeAttempt,
  });
})(globalThis);
