/**
 * 用量账本（票据 25，服务端部分）。
 *
 * 本模块把宿主已有的 session usage 事件收敛成**有界、可持久化、可投影**的聚合值。
 * 它不发起模型请求、不解析 prompt、不保存逐请求原文；所有对外输出都是白名单字段。
 *
 * 契约来源：docs/specs/03-host-contract-report.md §2
 * - usage 主位置是 assistant/message 的 data.usage；
 * - assistant/message 也可能只有 data.stream 里的 usage chunk；
 * - assistant/attempt 没有 message，只能读 data.stream 最后一个 usage chunk；
 * - 唯一键是 (sessionId, seq)：没有 event id、message.id 跨 fork 会重复；
 * - 事件可能迟到/重复，账本按每个 session 的 seq 水位丢弃旧样本；
 * - fork 子会话的继承前缀不会重新发布 session/event，账本只累计 live 自有事件。
 *
 * 状态机的有界性：
 * - 每个 session 只保留一个累积值 + lastSeq 水位（不保存事件集合/明细）；
 * - session 数超过 maxSessions 时按 LRU 淘汰（淘汰前把脏条目刷盘）；
 * - 聚合组数（role/provider/model）最多 64 组，溢出并入 "other"；
 * - provider+model 组合分组同样有界（最多 64 条），溢出并入 other/other；
 * - 所有字符串字段截断到 128 字符，所有数值只接受安全非负整数 / 有限非负时间。
 */
import * as dshLlm from "@deepseek-ai/dsh-llm";

/** 每个 session 账本条目的上限；超出后按 LRU 淘汰（淘汰前刷盘）。 */
export const MAX_LEDGER_SESSIONS = 256;
/** 聚合维度分组上限；溢出的样本并入 "other"，保证 meta 投影有界。 */
export const MAX_USAGE_GROUPS = 64;
/** 单价配置条数上限（读/写同一上限）。 */
export const MAX_MODEL_PRICES = 64;
/** 单次聚合读取的输入条数上限（防止异常输入把一次投影放大成无界工作）。 */
export const MAX_USAGE_ENTRIES = 1024;
/** 最近任务投影条数上限。 */
export const MAX_RECENT_USAGE_TASKS = 16;
/** provider/model/role/roleLabel 等标识字段的字符上限。 */
export const MAX_USAGE_TEXT_CHARS = 128;
/** 默认刷盘去抖窗口（毫秒）。 */
export const DEFAULT_USAGE_FLUSH_MS = 200;
/**
 * 单次落盘失败后允许的自动重试次数（每次失败计一次）。
 *
 * 为什么要上限：persist 可能是磁盘满、权限或存储 domain 不可用这类持续故障；
 * 无限重试只会把同一个失败放大成定时器风暴。用尽后**保留 dirty**，等下一次事件
 * （turn/end 的立即刷盘、agent/disposed、显式 flush）再尝试——用户数据不会因此丢失。
 */
export const MAX_USAGE_WRITE_RETRIES = 3;
/** 自动重试退避的上限（毫秒）：200ms 起翻倍，最多 2s 一次。 */
export const MAX_USAGE_RETRY_DELAY_MS = 2000;
/** 聚合维度词表。 */
export const USAGE_AGGREGATE_DIMENSIONS = Object.freeze(["role", "provider", "model"]);

const TOKEN_FIELDS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
]);

const COUNT_FIELDS = Object.freeze(["requests", "retries", "fallbacks"]);

/** 安全非负整数判定（账本只接受 token/计数的这一种数值形状）。 */
function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 有限非负时间戳/时长判定（epoch 毫秒可能不是安全整数，但必须有限且非负）。 */
function isTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textOrNull(value, max = MAX_USAGE_TEXT_CHARS) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.slice(0, max);
}

function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text !== null) return text;
  }
  return null;
}

/**
 * 归属文本（provider/model）里的 NUL 替换字符。
 *
 * provider+model 组合用 NUL 作为内部复合键分隔符：只要两部分都不含 NUL，键就是无歧义的。
 * 因此归属文本先做 NUL 归一（替换为 U+FFFD），公开字段也不再携带控制字符。选择替换而不是
 * 丢弃整条样本：归属脏数据不应让真实用量从账本里消失。
 */
const USAGE_ATTRIBUTION_NUL_REPLACEMENT = "\uFFFD";

/** 归属文本归一：去空白/限长（textOrNull），再把 NUL 替换为 U+FFFD。 */
function attributionText(value) {
  const text = textOrNull(value);
  if (text === null) return null;
  return text.includes("\u0000") ? text.replace(/\u0000/g, USAGE_ATTRIBUTION_NUL_REPLACEMENT) : text;
}

/** 与 firstText 同义，但每个候选都先经 attributionText 做 NUL 归一。 */
function firstAttributionText(...values) {
  for (const value of values) {
    const text = attributionText(value);
    if (text !== null) return text;
  }
  return null;
}

function maxOrNull(...values) {
  let result = null;
  for (const value of values) {
    if (!isTime(value)) continue;
    result = result === null ? value : Math.max(result, value);
  }
  return result;
}

function minOrNull(...values) {
  let result = null;
  for (const value of values) {
    if (!isTime(value)) continue;
    result = result === null ? value : Math.min(result, value);
  }
  return result;
}

/**
 * 归一一条宿主 TokenUsage 样本。
 *
 * 规则直接采用宿主 dsh-token-meter 的 normalizeUsage（契约报告 §2.1）：
 * - inputTokens / outputTokens 必填且必须是安全非负整数；
 * - cacheReadTokens / cacheWriteTokens / reasoningTokens 可选，存在时同样必须是安全非负整数；
 * - reasoningTokens 不得大于 outputTokens（reasoning 是 output 的子集）；
 * - totalTokens 若存在必须是安全非负整数，且：
 *   - 两个 cache 字段都存在时，totalTokens - outputTokens 必须**恰好**等于
 *     input + cacheRead + cacheWrite；
 *   - 否则 totalTokens - outputTokens 不得小于已知 prompt 桶之和。
 *
 * 任何无效样本都返回 { ok:false, reason }，调用方只需计 invalidSamples，绝不累加。
 * 返回的 usage 中 totalTokens 是**派生值**（billedInputTokens + outputTokens）：宿主
 * total 只用于校验，不参与计费，避免 cache 字段缺失时把总量算错。
 *
 * @param {unknown} raw - 事件里的 usage 候选。
 * @returns {{ok:true, usage:object}|{ok:false, reason:string}}
 */
export function normalizeTokenUsage(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid-shape" };
  const inputTokens = raw.inputTokens;
  const outputTokens = raw.outputTokens;
  if (!isCount(inputTokens)) return { ok: false, reason: "invalid-input" };
  if (!isCount(outputTokens)) return { ok: false, reason: "invalid-output" };
  const optional = {};
  for (const field of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"]) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (!isCount(value)) return { ok: false, reason: "invalid-" + kebab(field) };
    optional[field] = value;
  }
  const reasoning = optional.reasoningTokens;
  if (reasoning !== undefined && reasoning > outputTokens) {
    return { ok: false, reason: "reasoning-exceeds-output" };
  }
  const cacheRead = optional.cacheReadTokens;
  const cacheWrite = optional.cacheWriteTokens;
  const knownPrompt = inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const reportedTotal = raw.totalTokens;
  if (reportedTotal !== undefined && reportedTotal !== null) {
    if (!isCount(reportedTotal)) return { ok: false, reason: "invalid-total" };
    const promptFromTotal = reportedTotal - outputTokens;
    if (promptFromTotal < 0 || promptFromTotal < knownPrompt) {
      return { ok: false, reason: "total-below-prompt" };
    }
    if (cacheRead !== undefined && cacheWrite !== undefined && promptFromTotal !== knownPrompt) {
      return { ok: false, reason: "total-cache-mismatch" };
    }
  }
  return {
    ok: true,
    usage: finalizeUsage({
      inputTokens,
      outputTokens,
      ...optional,
      sampleCount: 1,
    }),
  };
}

function kebab(field) {
  return field.replace(/[A-Z]/g, (char) => "-" + char.toLowerCase());
}

/**
 * 由分项 token 计算计费输入与总量。
 *
 * - 计费输入 = 未缓存输入 + cache read + cache write（cache 缺失视作 0）；
 * - 总消耗 = 计费输入 + outputTokens（reasoning 已包含在 output 内，不重复加）。
 * 两个派生字段总是从分项重算，不信任外部写入的旧值。
 */
function finalizeUsage(value) {
  const usage = { ...value };
  if (isCount(usage.inputTokens)) {
    usage.billedInputTokens = usage.inputTokens
      + (isCount(usage.cacheReadTokens) ? usage.cacheReadTokens : 0)
      + (isCount(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0);
    if (isCount(usage.outputTokens)) usage.totalTokens = usage.billedInputTokens + usage.outputTokens;
  } else if (isCount(usage.billedInputTokens) && isCount(usage.outputTokens)
    && !isCount(usage.totalTokens)) {
    usage.totalTokens = usage.billedInputTokens + usage.outputTokens;
  }
  return usage;
}

/**
 * 读取 assistant stream 里最后一个 usage chunk。
 *
 * 优先使用宿主公开的 lastAssistantStreamChunk（契约报告 §2.2 的推荐读法）；它不存在时
 * 用等价的保守读取：只认 type === "chunk" 且 chunk.type === "usage" 的压缩记录，
 * 绝不猜测其它形状。任何异常都收敛为 undefined。
 */
export function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return undefined;
  const reader = dshLlm.lastAssistantStreamChunk;
  if (typeof reader === "function") {
    try {
      const chunk = reader(stream, "usage");
      if (chunk !== undefined && chunk !== null) return chunk;
    } catch {
      // 宿主读者存在但拒绝该 stream（旧格式/脏数据）：回落到下面的安全读取。
    }
  }
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (!isPlainObject(record)) continue;
    if (record.type !== "chunk" || !isPlainObject(record.chunk)) continue;
    if (record.chunk.type === "usage") return record.chunk;
  }
  return undefined;
}

/**
 * 按宿主契约读取一条事件里的 usage 候选。
 *
 * 优先级（契约报告 §2.2）：
 * - assistant/message：data.usage 优先，其次 data.stream 最后一个 usage chunk；
 * - assistant/attempt：只有 data.stream；
 * - 其它事件类型：没有 usage。
 *
 * 返回 { source, usage } 表示“找到了候选”（是否有效交给 normalizeTokenUsage）；
 * 返回 undefined 表示“这条事件没有可用位置”。不在这里做校验，避免把两种事实混在一起。
 *
 * @param {object} event - session/event 的事件对象。
 * @returns {{source:"data.usage"|"stream.usage", usage:unknown}|undefined}
 */
export function usageOf(event) {
  if (!isPlainObject(event)) return undefined;
  const data = isPlainObject(event.data) ? event.data : undefined;
  if (data === undefined) return undefined;
  if (event.type === "assistant/message") {
    if (data.usage !== undefined && data.usage !== null) return { source: "data.usage", usage: data.usage };
    const chunk = lastUsageChunk(data.stream);
    return chunk === undefined || chunk.usage === undefined || chunk.usage === null
      ? undefined
      : { source: "stream.usage", usage: chunk.usage };
  }
  if (event.type === "assistant/attempt") {
    const chunk = lastUsageChunk(data.stream);
    return chunk === undefined || chunk.usage === undefined || chunk.usage === null
      ? undefined
      : { source: "stream.usage", usage: chunk.usage };
  }
  return undefined;
}

/**
 * 用量对象的**有界只读投影**（账本、快照、RPC meta 的唯一出口）。
 *
 * 只保留白名单字段：token/计数/角色/provider/model/时间。绝不透传 prompt、response、
 * 凭据、完整路径或任何未知键——即使有人把整份事件负载塞进 usage，投影也只会丢掉它。
 * 缺失指标一律省略（不补 0），调用方用 hasUsageMetrics 判断是否值得输出该节点。
 *
 * @param {unknown} value - 累积值或持久化记录里的 usage。
 * @returns {object|null} 投影对象；没有任何可识别字段时返回 null。
 */
export function projectUsage(value) {
  if (!isPlainObject(value)) return null;
  const projected = {};
  for (const field of TOKEN_FIELDS) {
    if (isCount(value[field])) projected[field] = value[field];
  }
  // 计费输入/总量：能从分项重算就重算，否则保留持久化里的安全旧值（旧版本记录）。
  if (isCount(projected.inputTokens)) {
    projected.billedInputTokens = projected.inputTokens
      + (isCount(projected.cacheReadTokens) ? projected.cacheReadTokens : 0)
      + (isCount(projected.cacheWriteTokens) ? projected.cacheWriteTokens : 0);
    if (isCount(projected.outputTokens)) projected.totalTokens = projected.billedInputTokens + projected.outputTokens;
  } else {
    if (isCount(value.billedInputTokens)) projected.billedInputTokens = value.billedInputTokens;
    if (isCount(value.totalTokens)) projected.totalTokens = value.totalTokens;
  }
  for (const field of COUNT_FIELDS) {
    if (isCount(value[field]) && value[field] > 0) projected[field] = value[field];
  }
  for (const field of ["provider", "model", "role", "roleLabel"]) {
    const text = textOrNull(value[field]);
    if (text !== null) projected[field] = text;
  }
  for (const field of ["startedAt", "finishedAt", "updatedAt"]) {
    if (isTime(value[field])) projected[field] = value[field];
  }
  // 运行时长优先由起止时间重算（账本只存投影，过期 runMs 不应覆盖真实区间）；
  // 只有缺少可用起止时间时才保留持久化里的安全旧值。
  if (isTime(projected.startedAt) && isTime(projected.finishedAt) && projected.finishedAt >= projected.startedAt) {
    projected.runMs = projected.finishedAt - projected.startedAt;
  } else if (isTime(value.runMs)) {
    projected.runMs = value.runMs;
  }
  for (const field of ["sampleCount", "invalidSamples"]) {
    if (isCount(value[field]) && value[field] > 0) projected[field] = value[field];
  }
  return Object.keys(projected).length === 0 ? null : projected;
}

/**
 * 是否含有值得输出的用量事实。
 *
 * 只有 role/provider 之类的归属字符串而没有 token/请求数时不算用量：客户端不应把
 * “知道用了哪个模型但从未拿到 usage”显示成一个 0 成本账目。
 */
export function hasUsageMetrics(usage) {
  const projected = isPlainObject(usage) ? usage : null;
  if (projected === null) return false;
  for (const field of TOKEN_FIELDS) if (isCount(projected[field])) return true;
  for (const field of COUNT_FIELDS) if (isCount(projected[field]) && projected[field] > 0) return true;
  return isCount(projected.sampleCount) && projected.sampleCount > 0;
}

/**
 * 合并两个用量聚合值（纯函数）。
 *
 * 语义：
 * - token：两边都有的字段相加；只有一边有时保留已知值（另一个样本未被计量，不能伪造 0）；
 * - 计数（requests/retries/fallbacks/sampleCount/invalidSamples）：缺失视作 0 相加；
 * - provider/model/role/roleLabel：取第一个非空（归属稳定，不因后续样本被改写）；
 * - startedAt 取最早、finishedAt 取最晚、updatedAt 取最新；
 * - runMs：两端都有起止时间时用 finishedAt - startedAt（墙钟），否则累加已知 runMs。
 *
 * @param {unknown} left - 聚合值。
 * @param {unknown} right - 聚合值。
 * @returns {object|null} 合并后的投影。
 */
export function mergeUsage(left, right) {
  const a = projectUsage(left) ?? {};
  const b = projectUsage(right) ?? {};
  if (Object.keys(a).length === 0) return Object.keys(b).length === 0 ? null : b;
  if (Object.keys(b).length === 0) return a;
  const merged = {};
  for (const field of TOKEN_FIELDS) {
    const hasA = isCount(a[field]);
    const hasB = isCount(b[field]);
    if (hasA || hasB) merged[field] = (hasA ? a[field] : 0) + (hasB ? b[field] : 0);
  }
  for (const field of COUNT_FIELDS) {
    const value = (isCount(a[field]) ? a[field] : 0) + (isCount(b[field]) ? b[field] : 0);
    if (value > 0) merged[field] = value;
  }
  const provider = firstText(a.provider, b.provider);
  const model = firstText(a.model, b.model);
  const role = firstText(a.role, b.role);
  const roleLabel = firstText(a.roleLabel, b.roleLabel);
  if (provider !== null) merged.provider = provider;
  if (model !== null) merged.model = model;
  if (role !== null) merged.role = role;
  if (roleLabel !== null) merged.roleLabel = roleLabel;
  const startedAt = minOrNull(a.startedAt, b.startedAt);
  const finishedAt = maxOrNull(a.finishedAt, b.finishedAt);
  if (startedAt !== null) merged.startedAt = startedAt;
  if (finishedAt !== null) merged.finishedAt = finishedAt;
  if (startedAt !== null && finishedAt !== null && finishedAt >= startedAt) {
    merged.runMs = finishedAt - startedAt;
  } else {
    const runA = isTime(a.runMs) ? a.runMs : 0;
    const runB = isTime(b.runMs) ? b.runMs : 0;
    if (runA + runB > 0) merged.runMs = runA + runB;
  }
  const updatedAt = maxOrNull(a.updatedAt, b.updatedAt);
  if (updatedAt !== null) merged.updatedAt = updatedAt;
  const sampleCount = (isCount(a.sampleCount) ? a.sampleCount : 0) + (isCount(b.sampleCount) ? b.sampleCount : 0);
  if (sampleCount > 0) merged.sampleCount = sampleCount;
  const invalidSamples = (isCount(a.invalidSamples) ? a.invalidSamples : 0) + (isCount(b.invalidSamples) ? b.invalidSamples : 0);
  if (invalidSamples > 0) merged.invalidSamples = invalidSamples;
  return Object.keys(merged).length === 0 ? null : finalizeUsage(merged);
}

/**
 * 汇总一组用量值（有界；超过 MAX_USAGE_ENTRIES 的部分忽略，避免异常输入放大工作）。
 *
 * @param {unknown[]} values - usage 投影或累积值。
 * @returns {object|null}
 */
export function sumUsage(values) {
  if (!Array.isArray(values)) return null;
  let total = null;
  const limit = Math.min(values.length, MAX_USAGE_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    total = mergeUsage(total, values[index]);
  }
  return total;
}

/**
 * 按 childId 去重后汇总（fan-out 多轮 attempt 复用同一 child 时只计一次）。
 *
 * child_models.usage 是**该 child 的累积值**，因此同一 child 出现在多个 attempt 时
 * 不能把同一份累计值加两遍。去重采用「后出现的记录优先」：最新一轮的持久化值更新。
 * 没有 childId 的条目无法去重，按原样累加。
 *
 * @param {Array<{childId?:string, usage?:unknown}>} entries - 条目列表。
 * @returns {object|null}
 */
export function sumUsageByChildId(entries) {
  if (!Array.isArray(entries)) return null;
  const byChild = new Map();
  const anonymous = [];
  const limit = Math.min(entries.length, MAX_USAGE_ENTRIES);
  for (let index = 0; index < limit; index += 1) {
    const entry = isPlainObject(entries[index]) ? entries[index] : {};
    const childId = textOrNull(entry.childId);
    if (childId === null) anonymous.push(entry.usage);
    else byChild.set(childId, entry.usage);
  }
  return sumUsage([...byChild.values(), ...anonymous]);
}

/**
 * 按维度（role/provider/model）聚合。
 *
 * 输出是普通对象（key → 合并后的 usage），最多 MAX_USAGE_GROUPS 个键；新出现的维度值
 * 在达到上限后并入 "other"，保证 meta 投影不会随模型数量无界增长。缺少归属的样本进入
 * "unknown" 组，便于客户端解释「为什么各组之和小于总量」。
 *
 * @param {Array<object>} entries - 至少含维度字段与 usage 的条目。
 * @param {"role"|"provider"|"model"} dimension - 聚合维度。
 * @returns {Record<string, object>}
 */
export function aggregateUsageBy(entries, dimension) {
  if (!USAGE_AGGREGATE_DIMENSIONS.includes(dimension)) {
    throw new TypeError("aggregateUsageBy 需要 role/provider/model 之一");
  }
  const groups = new Map();
  const limit = Array.isArray(entries) ? Math.min(entries.length, MAX_USAGE_ENTRIES) : 0;
  for (let index = 0; index < limit; index += 1) {
    const entry = isPlainObject(entries[index]) ? entries[index] : {};
    const usage = projectUsage(entry.usage);
    if (usage === null || !hasUsageMetrics(usage)) continue;
    let key = textOrNull(entry[dimension]) ?? "unknown";
    if (!groups.has(key) && groups.size >= MAX_USAGE_GROUPS) key = "other";
    groups.set(key, mergeUsage(groups.get(key), usage));
  }
  const result = {};
  for (const key of [...groups.keys()].sort()) {
    const merged = groups.get(key);
    if (merged !== null) result[key] = merged;
  }
  return result;
}

/**
 * 按 provider+model 组合聚合（票据 25：成本归属修复）。
 *
 * 为什么必须独立于 byModel：byModel 为了展示会把**不同 provider 的同名模型**合并成一行。
 * 成本估算若拿这行去匹配某个 provider 的单价，就等于把该 provider 的单价套到「A+B」的
 * 总量上；当 A、B 各自配置了同名模型单价时，同一份用量还会被计费两次。这里改用
 * (provider, model) 作为聚合键：不同 provider 的同名模型绝不合并。
 *
 * 语义与 aggregateUsageBy 保持一致：
 * - provider = entry.provider ?? usage.provider ?? "unknown"，model 同理；
 * - 缺少归属的样本进入 unknown/unknown，客户端因此能解释「为什么各组之和小于总量」；
 * - 只统计含 token/计数的有效样本，条目数与每条样本都受既有上限约束。
 *
 * 有界性：结果最多 MAX_USAGE_GROUPS 条，其中**预留唯一一个溢出槽位**——最多 63 个真实组合，
 * 之后的新组合并入 { provider: "other", model: "other", overflow: true }。真实组最多 63 条、
 * 溢出组最多 1 条，总数硬性 ≤ 64；totals 与分组无关，不受溢出影响。
 *
 * 溢出桶与真实 other/other 的区分：
 * - 公开字段 provider/model 可能恰好就是 other/other，因此**不能靠字段值识别溢出组**；
 *   只有溢出桶带 `overflow: true`，真实 other/other 组绝不带该字段。两者可以同时存在
 *   （真实组来自样本，溢出组来自超出上限的组合），客户端据此分别处理。
 *
 * NUL 安全：provider/model 先经 attributionText 归一（NUL → U+FFFD），再做
 * `provider + NUL + model` 复合键。两部分都不含 NUL，因此复合键无歧义；内部溢出键使用
 * 两个 NUL 前缀，真实键只含一个分隔 NUL，二者不可能相等。公开字段因此也不含 NUL。
 *
 * @param {Array<object>} entries - 至少含 usage 的条目；provider/model 可来自条目或 usage。
 * @returns {Array<{provider:string, model:string, usage:object, overflow?:true}>}
 */
export function aggregateUsageByProviderModel(entries) {
  const groups = new Map();
  // 溢出桶键带两个 NUL；真实键恰有一个分隔 NUL（两部分已剔除 NUL），永远不可能相等。
  const overflowKey = "\u0000\u0000overflow";
  // 真实组合计数与 Map 大小分开维护：溢出桶不占用真实组名额（真实组上限 63、溢出组 1）。
  let realGroups = 0;
  const limit = Array.isArray(entries) ? Math.min(entries.length, MAX_USAGE_ENTRIES) : 0;
  for (let index = 0; index < limit; index += 1) {
    const entry = isPlainObject(entries[index]) ? entries[index] : {};
    const usage = projectUsage(entry.usage);
    if (usage === null || !hasUsageMetrics(usage)) continue;
    const provider = firstAttributionText(entry.provider, usage.provider) ?? "unknown";
    const model = firstAttributionText(entry.model, usage.model) ?? "unknown";
    // usage 内部也投影了 provider/model；aggregateUsageByProviderModel 的整行都是公开字段，
    // 因此嵌套归属同样做 NUL 归一（否则 JSON 里仍会出现控制字符转义）。
    const usageProvider = attributionText(usage.provider);
    if (usageProvider !== null) usage.provider = usageProvider;
    const usageModel = attributionText(usage.model);
    if (usageModel !== null) usage.model = usageModel;
    const key = provider + "\u0000" + model;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.usage = mergeUsage(existing.usage, usage);
      continue;
    }
    // 真实组上限固定为 MAX_USAGE_GROUPS - 1：给溢出组预留唯一槽位，总数因此硬性 ≤ 上限。
    if (realGroups >= MAX_USAGE_GROUPS - 1) {
      const overflow = groups.get(overflowKey);
      if (overflow === undefined) {
        groups.set(overflowKey, { provider: "other", model: "other", overflow: true, usage });
      } else {
        overflow.usage = mergeUsage(overflow.usage, usage);
      }
      continue;
    }
    groups.set(key, { provider, model, usage });
    realGroups += 1;
  }
  const rows = [];
  let overflow = null;
  for (const [key, group] of groups) {
    if (key === overflowKey) overflow = group;
    else rows.push(group);
  }
  rows.sort((left, right) => (left.provider < right.provider ? -1
    : left.provider > right.provider ? 1
      : left.model < right.model ? -1
        : left.model > right.model ? 1 : 0));
  if (overflow !== null) rows.push(overflow);
  return rows.map((group) => (group.overflow === true
    // overflow 只在溢出桶上出现；真实 other/other 不带该字段，客户端可无歧义区分。
    ? { provider: "other", model: "other", overflow: true, usage: group.usage }
    : { provider: group.provider, model: group.model, usage: group.usage }));
}

/**
 * 汇总“最近任务”投影（meta 用；客户端只读展示，不进入事件历史）。
 *
 * 每个任务只保留角色/模型与 usage；不含 childId、prompt、response、凭据或路径。
 * 排序按 usage.updatedAt（其次 finishedAt/startedAt）倒序，最多 recentLimit 条。
 *
 * 除展示用的 byModel（不同 provider 的同名模型会合并）外，还输出 byProviderModel：
 * 成本估算必须按 (provider, model) 精确匹配，绝不把合并后的 byModel 套上 provider 单价。
 * 该字段是 additive 的：旧客户端可以忽略，既有字段语义不变。
 *
 * @param {Array<{role?:string, roleLabel?:string, provider?:string, model?:string, usage?:unknown}>} entries
 * @param {{recentLimit?:number}} [options]
 * @returns {{totals:object|null, byRole:object, byProvider:object, byModel:object, byProviderModel:object[], recentTasks:object[]}}
 */
export function summarizeUsage(entries, { recentLimit = MAX_RECENT_USAGE_TASKS } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const usable = [];
  for (const entry of list.slice(0, MAX_USAGE_ENTRIES)) {
    if (!isPlainObject(entry)) continue;
    const usage = projectUsage(entry.usage);
    if (usage === null || !hasUsageMetrics(usage)) continue;
    usable.push({
      role: textOrNull(entry.role),
      roleLabel: textOrNull(entry.roleLabel),
      provider: firstText(entry.provider, usage.provider),
      model: firstText(entry.model, usage.model),
      usage,
    });
  }
  const limit = Number.isSafeInteger(recentLimit) && recentLimit > 0
    ? Math.min(recentLimit, MAX_RECENT_USAGE_TASKS)
    : MAX_RECENT_USAGE_TASKS;
  const recentTasks = usable
    .map((entry, index) => ({ entry, index, at: isTime(entry.usage.updatedAt) ? entry.usage.updatedAt : 0 }))
    .sort((left, right) => right.at - left.at || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => ({
      role: entry.role,
      roleLabel: entry.roleLabel,
      provider: entry.provider,
      model: entry.model,
      usage: entry.usage,
    }));
  return {
    totals: sumUsage(usable.map((entry) => entry.usage)),
    byRole: aggregateUsageBy(usable, "role"),
    byProvider: aggregateUsageBy(usable, "provider"),
    // byModel 保持既有展示语义（同名模型跨 provider 合并），不再用于成本匹配。
    byModel: aggregateUsageBy(usable, "model"),
    // 成本估算的唯一聚合来源：provider+model 精确分组，永不合并不同 provider 的同名模型。
    byProviderModel: aggregateUsageByProviderModel(usable),
    recentTasks,
  };
}

/**
 * 估算成本（纯函数；仅在显式配置了单价时调用）。
 *
 * - usage 必须有可用的计费输入与输出 token；
 * - price 必须同时提供 inputPerMillion/outputPerMillion（有限非负数），否则返回 null；
 * - 缺失单价时绝不返回 0：返回 null 让调用方显示“未配置单价”；
 * - 显式配置 0 是真实价格（免费），会返回 0 成本，并通过 currency 标明币种。
 *
 * 精度：金额是原始浮点数，不做四舍五入；展示精度由客户端决定（规格要求标注估算精度）。
 *
 * @param {unknown} usage - usage 投影/累积值。
 * @param {unknown} price - {provider,model,inputPerMillion,outputPerMillion,currency}。
 * @returns {{currency:string, inputCost:number, outputCost:number, totalCost:number, billedInputTokens:number, outputTokens:number}|null}
 */
export function estimateUsageCost(usage, price) {
  const projected = projectUsage(usage);
  if (projected === null) return null;
  const billedInput = isCount(projected.billedInputTokens)
    ? projected.billedInputTokens
    : (isCount(projected.inputTokens) ? projected.inputTokens : null);
  const output = isCount(projected.outputTokens) ? projected.outputTokens : null;
  if (billedInput === null || output === null) return null;
  if (!isPlainObject(price)) return null;
  const inputRate = price.inputPerMillion;
  const outputRate = price.outputPerMillion;
  if (!isFiniteNonNegative(inputRate) || !isFiniteNonNegative(outputRate)) return null;
  const currency = textOrNull(price.currency, 8) ?? "USD";
  const inputCost = (billedInput / 1_000_000) * inputRate;
  const outputCost = (output / 1_000_000) * outputRate;
  return {
    currency,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    billedInputTokens: billedInput,
    outputTokens: output,
  };
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// ── 单价配置（票据 25） ─────────────────────────────────────────────────────

const PRICE_FIELDS = Object.freeze(["provider", "model", "inputPerMillion", "outputPerMillion", "currency"]);

/**
 * 单价条目的读取态归一（fail-soft）。
 *
 * 非法条目丢弃并返回诊断（最多 16 条），绝不让一个坏条目阻塞整份设置读取。
 * 合法条目也只保留白名单字段，currency 缺省 USD；同一 provider+model 只保留第一条。
 *
 * @param {unknown} value - settings.modelPrices 原始值。
 * @returns {{prices: object[], diagnostics: object[]}}
 */
export function normalizeModelPrices(value) {
  if (!Array.isArray(value)) {
    return { prices: [], diagnostics: value === undefined ? [] : [{ index: -1, reason: "invalid_shape" }] };
  }
  const prices = [];
  const diagnostics = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    if (prices.length >= MAX_MODEL_PRICES) {
      diagnostics.push({ index, reason: "too_many" });
      break;
    }
    const normalized = normalizePriceEntry(value[index], index, diagnostics);
    if (normalized === null) continue;
    const key = normalized.provider + "\u0000" + normalized.model;
    if (seen.has(key)) {
      diagnostics.push({ index, reason: "duplicate", provider: normalized.provider, model: normalized.model });
      continue;
    }
    seen.add(key);
    prices.push(normalized);
  }
  return { prices, diagnostics: diagnostics.slice(0, 16) };
}

function normalizePriceEntry(raw, index, diagnostics) {
  if (!isPlainObject(raw)) {
    diagnostics.push({ index, reason: "invalid_shape" });
    return null;
  }
  const provider = textOrNull(raw.provider);
  const model = textOrNull(raw.model);
  if (provider === null || model === null) {
    diagnostics.push({ index, reason: "missing_provider_model" });
    return null;
  }
  if (!isFiniteNonNegative(raw.inputPerMillion) || !isFiniteNonNegative(raw.outputPerMillion)) {
    diagnostics.push({ index, reason: "invalid_rate", provider, model });
    return null;
  }
  const currency = raw.currency === undefined || raw.currency === null ? "USD" : textOrNull(raw.currency, 8);
  if (currency === null) {
    diagnostics.push({ index, reason: "invalid_currency", provider, model });
    return null;
  }
  return {
    provider,
    model,
    inputPerMillion: raw.inputPerMillion,
    outputPerMillion: raw.outputPerMillion,
    currency,
  };
}

/**
 * 单价条目的写入态严格校验（保存时使用）。
 *
 * 与读取态的区别是 fail-closed：数组/字段/范围/未知字段/重复条目任何一项非法都抛错，
 * 绝不像读取态那样静默丢弃——单价是成本展示的输入，用户必须知道保存失败。
 *
 * @param {unknown} value - candidate.modelPrices。
 * @returns {object[]} 归一后的完整数组（用于 replace 写入）。
 * @throws {TypeError} 带 code="INVALID_MODEL_PRICES" 与中文消息。
 */
export function assertModelPrices(value) {
  if (!Array.isArray(value)) throw modelPricesError("modelPrices 必须是数组");
  if (value.length > MAX_MODEL_PRICES) throw modelPricesError("modelPrices 最多 " + MAX_MODEL_PRICES + " 条");
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!isPlainObject(raw)) throw modelPricesError("modelPrices[" + index + "] 必须是对象");
    for (const key of Object.keys(raw)) {
      if (!PRICE_FIELDS.includes(key)) throw modelPricesError("modelPrices[" + index + "] 含未知字段: " + key);
    }
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    if (provider.length === 0 || provider.length > MAX_USAGE_TEXT_CHARS) {
      throw modelPricesError("modelPrices[" + index + "].provider 必须是非空字符串（≤" + MAX_USAGE_TEXT_CHARS + "）");
    }
    if (model.length === 0 || model.length > MAX_USAGE_TEXT_CHARS) {
      throw modelPricesError("modelPrices[" + index + "].model 必须是非空字符串（≤" + MAX_USAGE_TEXT_CHARS + "）");
    }
    if (!isFiniteNonNegative(raw.inputPerMillion)) {
      throw modelPricesError("modelPrices[" + index + "].inputPerMillion 必须是 ≥0 的有限数字");
    }
    if (!isFiniteNonNegative(raw.outputPerMillion)) {
      throw modelPricesError("modelPrices[" + index + "].outputPerMillion 必须是 ≥0 的有限数字");
    }
    const currency = raw.currency === undefined || raw.currency === null
      ? "USD"
      : (typeof raw.currency === "string" ? raw.currency.trim() : "");
    if (currency.length < 1 || currency.length > 8) {
      throw modelPricesError("modelPrices[" + index + "].currency 必须是 1~8 字符的字符串");
    }
    const key = provider + "\u0000" + model;
    if (seen.has(key)) throw modelPricesError("modelPrices 存在重复的 provider+model: " + provider + "/" + model);
    seen.add(key);
    normalized.push({ provider, model, inputPerMillion: raw.inputPerMillion, outputPerMillion: raw.outputPerMillion, currency });
  }
  return normalized;
}

function modelPricesError(message) {
  const error = new TypeError(message);
  error.code = "INVALID_MODEL_PRICES";
  return error;
}

// ── 有界状态机 ──────────────────────────────────────────────────────────────

/**
 * 创建用量账本（有界状态机 + 去抖持久化）。
 *
 * 只接受 live 事件：调用方在 session/event 监听器里把 child 的 assistant/message、
 * assistant/attempt、turn/end 与可选的 llm/retry-started 交给 observe。账本不做任何
 * 快照/投影回填，因此 fork 子会话的继承前缀不会被重复累计。
 *
 * @param {object} [options]
 * @param {(childId:string, usage:object)=>unknown} [options.persist] - 刷盘回调；
 *   本模块只负责调用，失败由调用方告警（写失败不影响 child 生命周期）。
 * @param {(sessionId:string)=>object|undefined} [options.attributionOf] - 归属读取回退。
 * @param {{now:()=>number,setTimeout:Function,clearTimeout:Function}} [options.clock] - 可注入时钟。
 * @param {number} [options.debounceMs] - 普通事件后的合并写窗口（默认 200ms）。
 * @param {number} [options.maxSessions] - session 状态上限（默认 256）。
 * @param {{warn:Function}} [options.logger] - 可选告警出口。
 */
export function createUsageLedger({
  persist,
  attributionOf,
  clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  debounceMs = DEFAULT_USAGE_FLUSH_MS,
  maxSessions = MAX_LEDGER_SESSIONS,
  logger,
} = {}) {
  if (clock === null || typeof clock !== "object"
    || typeof clock.now !== "function" || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
    throw new TypeError("createUsageLedger 需要可用的 clock");
  }
  const persistFn = typeof persist === "function" ? persist : null;
  const attributionFn = typeof attributionOf === "function" ? attributionOf : null;
  const sessionLimit = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : MAX_LEDGER_SESSIONS;
  const flushDelay = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_USAGE_FLUSH_MS;
  /**
   * sessionId → {
   *   lastSeq, usage, dirty, retryKeys,
   *   writeVersion,  // 单调递增的写入代次：只有覆盖当前代次的成功才允许清 dirty
   *   retryCount,    // 连续自动重试次数（成功清零；用于有界退避）
   * }（Map 插入序即 LRU 序）。
   */
  const sessions = new Map();
  const stats = {
    observedEvents: 0,
    acceptedEvents: 0,
    duplicateEvents: 0,
    lateEvents: 0,
    missingSeqEvents: 0,
    inheritedEvents: 0,
    gapEvents: 0,
    invalidSamples: 0,
    unmeteredSamples: 0,
    validSamples: 0,
    writes: 0,
    writeFailures: 0,
    // 自动重试与「重试预算耗尽」分开计数：诊断能区分瞬时抖动与持续故障。
    writeRetries: 0,
    writeRetriesExhausted: 0,
    evictions: 0,
    lastWriteAt: null,
    lastError: null,
  };
  let timer = null;
  let disposed = false;

  function warn(message, error) {
    stats.lastError = message;
    if (logger !== null && typeof logger?.warn === "function") {
      try { logger.warn("dsh-expert-group: usage ledger " + message + (error === undefined ? "" : ": " + (error instanceof Error ? error.message : String(error)))); } catch {}
    }
  }

  /** 取/建 session 状态，并维护 LRU 与上限。 */
  function stateOf(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created = {
      lastSeq: -1,
      usage: null,
      dirty: false,
      retryKeys: new Set(),
      writeVersion: 0,
      retryCount: 0,
    };
    sessions.set(sessionId, created);
    evictIfNeeded();
    return created;
  }

  function evictIfNeeded() {
    while (sessions.size > sessionLimit) {
      const oldestKey = sessions.keys().next().value;
      const oldest = sessions.get(oldestKey);
      sessions.delete(oldestKey);
      stats.evictions += 1;
      // 淘汰前先把脏条目刷盘：每个 session 的累积值仍然保留在持久化记录里。
      if (oldest?.dirty === true) void writeSession(oldestKey, oldest);
    }
  }

  /**
   * 安排一次去抖刷盘；delayMs 只在还没有定时器时生效。
   *
   * 失败重试复用同一个定时器通道（而不是新增第二套定时器）：已有更早的 flush 定时器时
   * 这次失败会被那次 flush 顺带重试，仍是有限的、事件驱动的重试节奏。
   */
  function scheduleFlush(delayMs = flushDelay) {
    if (persistFn === null || disposed || timer !== null) return;
    const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : flushDelay;
    timer = clock.setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    // 定时器不得阻止进程退出（Node unref 可用时）。
    try { timer?.unref?.(); } catch {}
  }

  /** 某次失败后的退避时长：base 起翻倍，封顶 MAX_USAGE_RETRY_DELAY_MS。 */
  function retryDelayMs(retryCount) {
    const base = flushDelay > 0 ? flushDelay : DEFAULT_USAGE_FLUSH_MS;
    const exponent = Math.max(0, (Number.isSafeInteger(retryCount) ? retryCount : 1) - 1);
    return Math.min(MAX_USAGE_RETRY_DELAY_MS, base * 2 ** exponent);
  }

  /**
   * 落盘成功：只有「这次写入仍是最新代次」时才清 dirty。
   *
   * 为什么按代次判断：persist 可能异步，await 期间又来了新事件（dirty=true 且代次 +1）；
   * 旧写入成功不得把新事件的值误标成已落盘，否则那份样本会永远丢失。
   */
  function handleWriteSuccess(state, version) {
    if (state.writeVersion !== version) return;
    state.dirty = false;
    state.retryCount = 0;
  }

  /**
   * 落盘失败：保留/重新标记 dirty，并在有界预算内安排重试。
   *
   * 失败可能是同步 throw，也可能是 Promise reject；两条路径都走这里。绝不因为写失败
   * 就丢弃内存里的累积值——它仍会被下一次 flush / turn/end / agent 结束路径再次写出。
   */
  function handleWriteFailure(sessionId, state, error, version) {
    stats.writeFailures += 1;
    warn("write failed for a child session", error);
    if (disposed) return;
    // dirty 必须保留：它表示「内存里有未成功落盘的值」，与是否正在重试无关。
    state.dirty = true;
    // 已有更新事件（代次前进）：那次写入会负责新值，这里不再重复调度。
    if (state.writeVersion !== version) return;
    // LRU 淘汰后的孤儿状态不再占用定时器/重试预算（值已随条目离开账本）。
    if (sessions.get(sessionId) !== state) return;
    if (state.retryCount >= MAX_USAGE_WRITE_RETRIES) {
      stats.writeRetriesExhausted += 1;
      return;
    }
    state.retryCount += 1;
    stats.writeRetries += 1;
    scheduleFlush(retryDelayMs(state.retryCount));
  }

  /**
   * 立即写一个 session 的当前累积值；同步捕获 usage，避免 await 期间被后续事件改写。
   *
   * 返回的 Promise 永不 reject（调用方都是 fire-and-forget / allSettled）：失败由内部
   * 保留 dirty 并调度有界重试，不把持久化故障升级成 child 生命周期异常。
   */
  function writeSession(sessionId, state) {
    if (persistFn === null || disposed) return Promise.resolve(undefined);
    const usage = projectUsage(state.usage);
    if (usage === null || !hasUsageMetrics(usage)) return Promise.resolve(undefined);
    // 代次在调用 persist 前递增：成功回调据此判断期间是否有更新事件写入。
    const version = state.writeVersion + 1;
    state.writeVersion = version;
    stats.writes += 1;
    stats.lastWriteAt = clock.now();
    let result;
    try {
      result = persistFn(sessionId, usage);
    } catch (error) {
      handleWriteFailure(sessionId, state, error, version);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(result).then(
      () => { handleWriteSuccess(state, version); },
      (error) => { handleWriteFailure(sessionId, state, error, version); },
    );
  }

  /**
   * 观察一条 live session 事件。
   *
   * 返回结构化判定供调用方/测试观察，绝不抛错：
   * - accepted：是否计入了账本；
   * - reason：inherited / missing-seq / late / unknown-session（turn/end 没有账本状态时）。
   *
   * @param {object} session - 事件所属 Session（只读 id 与 inheritedEventCount）。
   * @param {object} event - session/event 事件对象。
   * @param {object} [explicitAttribution] - 调用方已解析的归属（role/roleLabel/provider/model/fallbackCount）。
   */
  function observe(session, event, explicitAttribution) {
    if (disposed) return { accepted: false, reason: "disposed" };
    if (!isPlainObject(event) || typeof session?.id !== "string" || session.id.length === 0) {
      return { accepted: false, reason: "invalid-event" };
    }
    const type = event.type;
    const isUsageEvent = type === "assistant/message" || type === "assistant/attempt";
    const isRetryEvent = type === "llm/retry-started";
    const isTurnEnd = type === "turn/end";
    if (!isUsageEvent && !isRetryEvent && !isTurnEnd) return { accepted: false, reason: "ignored-type" };
    stats.observedEvents += 1;

    // fork 子会话的继承前缀可能被外部回放：只接受自有 seq。
    // 真实宿主的 seed 不会发布 session/event，因此这是第二道防线，不是必要条件。
    const inheritedEventCount = Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount > 0
      ? session.inheritedEventCount
      : 0;
    const seq = event.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      stats.missingSeqEvents += 1;
      return { accepted: false, reason: "missing-seq" };
    }
    if (inheritedEventCount > 0 && seq < inheritedEventCount) {
      stats.inheritedEvents += 1;
      return { accepted: false, reason: "inherited" };
    }

    if (isTurnEnd) {
      const state = sessions.get(session.id);
      if (state === undefined) return { accepted: false, reason: "unknown-session" };
      if (seq <= state.lastSeq) {
        stats.lateEvents += 1;
        return { accepted: false, reason: "late" };
      }
      state.lastSeq = seq;
      const time = isTime(event.time) ? event.time : clock.now();
      state.usage = finalizeUsage({
        ...(state.usage ?? {}),
        finishedAt: maxOrNull(state.usage?.finishedAt, time) ?? time,
        updatedAt: clock.now(),
      });
      state.dirty = true;
      // turn/end 是稳定结算边界：立即刷盘，不等待去抖窗口。
      void writeSession(session.id, state);
      return { accepted: true, counted: false };
    }

    const state = stateOf(session.id);
    if (seq <= state.lastSeq) {
      stats.lateEvents += 1;
      return { accepted: false, reason: "late" };
    }
    if (state.lastSeq >= 0 && seq > state.lastSeq + 1) stats.gapEvents += 1;
    state.lastSeq = seq;
    stats.acceptedEvents += 1;

    const attribution = isPlainObject(explicitAttribution)
      ? explicitAttribution
      : (attributionFn === null ? undefined : safeAttribution(session.id));
    const time = isTime(event.time) ? event.time : clock.now();
    let usage = state.usage;
    if (usage === null) {
      usage = {
        startedAt: time,
        updatedAt: clock.now(),
      };
    } else {
      usage = {
        ...usage,
        startedAt: minOrNull(usage.startedAt, time) ?? time,
        updatedAt: clock.now(),
      };
    }
    applyAttribution(usage, attribution);

    if (type === "assistant/message") {
      usage.requests = (isCount(usage.requests) ? usage.requests : 0) + 1;
      // 真实路由优先：message.source 是与 usage 同一条请求的权威来源。
      const sourceProvider = textOrNull(event.data?.message?.source?.provider);
      const sourceModel = textOrNull(event.data?.message?.source?.model);
      if (sourceProvider !== null) usage.provider = sourceProvider;
      if (sourceModel !== null) usage.model = sourceModel;
    } else if (type === "assistant/attempt") {
      const key = retryKeyOf(event);
      if (key === null || !state.retryKeys.has(key)) {
        usage.retries = (isCount(usage.retries) ? usage.retries : 0) + 1;
      }
      if (key !== null) state.retryKeys.add(key);
      if (state.retryKeys.size > 256) {
        // 有界：只保留最近的键（Set 插入序即时间序）。
        const oldest = state.retryKeys.values().next().value;
        state.retryKeys.delete(oldest);
      }
    } else if (type === "llm/retry-started") {
      const key = retryKeyOf(event);
      if (key !== null && state.retryKeys.has(key)) {
        state.usage = usage;
        state.dirty = true;
        scheduleFlush();
        return { accepted: true, counted: false };
      }
      if (key !== null) state.retryKeys.add(key);
      usage.retries = (isCount(usage.retries) ? usage.retries : 0) + 1;
    }

    if (isUsageEvent) {
      const found = usageOf(event);
      if (found === undefined) {
        // 有请求但宿主没有给 usage：只累计请求数/重试数，token 字段保持缺失（绝不伪造 0）。
        stats.unmeteredSamples += 1;
      } else {
        const normalized = normalizeTokenUsage(found.usage);
        if (normalized.ok === true) {
          usage = mergeSampleIntoAggregate(usage, normalized.usage);
          stats.validSamples += 1;
        } else {
          usage.invalidSamples = (isCount(usage.invalidSamples) ? usage.invalidSamples : 0) + 1;
          stats.invalidSamples += 1;
        }
      }
    }

    state.usage = finalizeUsage(usage);
    state.dirty = true;
    scheduleFlush();
    return { accepted: true, counted: true };
  }

  function safeAttribution(sessionId) {
    try {
      const value = attributionFn(sessionId);
      return isPlainObject(value) ? value : undefined;
    } catch (error) {
      warn("attribution read failed", error);
      return undefined;
    }
  }

  function applyAttribution(usage, attribution) {
    if (!isPlainObject(attribution)) return;
    usage.role = firstText(usage.role, attribution.role) ?? undefined;
    usage.roleLabel = firstText(usage.roleLabel, attribution.roleLabel) ?? undefined;
    usage.provider = firstText(usage.provider, attribution.provider) ?? undefined;
    usage.model = firstText(usage.model, attribution.model) ?? undefined;
    // fallbackCount 是 child 的累计降级次数，不是逐事件增量：取最大值，避免回退/重复读取
    // 让计数变小，也避免把同一份持久化值重复相加。
    if (isCount(attribution.fallbackCount)) {
      usage.fallbacks = Math.max(isCount(usage.fallbacks) ? usage.fallbacks : 0, attribution.fallbackCount);
    }
  }

  /** 把一条已校验样本并入聚合值（token 相加、sampleCount+1、不影响归属）。 */
  function mergeSampleIntoAggregate(aggregate, sample) {
    const merged = { ...aggregate };
    for (const field of TOKEN_FIELDS) {
      if (!isCount(sample[field])) continue;
      merged[field] = (isCount(merged[field]) ? merged[field] : 0) + sample[field];
    }
    merged.sampleCount = (isCount(merged.sampleCount) ? merged.sampleCount : 0)
      + (isCount(sample.sampleCount) ? sample.sampleCount : 1);
    return finalizeUsage(merged);
  }

  function retryKeyOf(event) {
    const turn = event?.data?.turn;
    const step = event?.data?.step;
    if (!Number.isSafeInteger(turn)) return null;
    return String(turn) + ":" + (Number.isSafeInteger(step) ? String(step) : "*");
  }

  /** 立刻刷全部脏 session。返回 Promise（persist 可能异步）。 */
  function flush() {
    const pending = [];
    for (const [sessionId, state] of sessions) {
      if (state.dirty !== true) continue;
      pending.push(writeSession(sessionId, state));
    }
    return Promise.allSettled(pending);
  }

  /** 刷指定 session（agent/disposed、turn/end 或测试显式调用）。 */
  function flushSession(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined || state.dirty !== true) return Promise.resolve(undefined);
    return writeSession(sessionId, state);
  }

  /**
   * 结束一个 child 的计量（agent/disposed）：补 finishedAt（缺失时）并立即刷盘。
   * 不删除内存状态：同一 id 的 replacement Agent 仍应沿用同一累积值（child_models 也是同一键）。
   */
  function finish(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined) return Promise.resolve(undefined);
    if (state.usage !== null) {
      const now = clock.now();
      // finishedAt 用**最后一次观察到的事件时间**（updatedAt），而不是 dispose 的时刻：
      // child 结束后可能很久才被回收，用回收时刻会把 runMs 拉长成空闲时长。
      // 只有完全没有事件时间时才退回到当前时钟。
      const finishedAt = maxOrNull(state.usage.finishedAt, state.usage.updatedAt, state.usage.startedAt) ?? now;
      state.usage = finalizeUsage({
        ...state.usage,
        finishedAt,
        updatedAt: now,
      });
      state.dirty = true;
    }
    return flushSession(sessionId);
  }

  /** 当前累积值的只读投影（RPC get / 快照优先读取 live 值）。 */
  function usageFor(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined || state.usage === null) return null;
    const usage = projectUsage(state.usage);
    return usage !== null && hasUsageMetrics(usage) ? usage : null;
  }

  /** 只读归属叠加：把既有持久化归属补到当前累积值上（测试/诊断用）。 */
  function entries() {
    const list = [];
    for (const [sessionId, state] of sessions) {
      const usage = usageFor(sessionId);
      if (usage !== null) list.push({ childId: sessionId, usage });
    }
    return list;
  }

  /** 有界诊断（不含 token 明细以外的用户内容）。 */
  function diagnostics() {
    return Object.freeze({
      sessions: sessions.size,
      maxSessions: sessionLimit,
      debounceMs: flushDelay,
      ...stats,
    });
  }

  /**
   * 卸载：先做最后一次 flush，再清定时器并停用后续写入。
   *
   * 顺序很重要：writeSession 在 disposed=true 时会直接返回，如果先置位再 flush，
   * 最后一个脏条目（尤其是刚收到的 turn/end / agent/disposed 样本）就永远写不出去。
   * 返回的 Promise 不阻塞卸载流程；flush 失败只按内部重试/保留 dirty 处理。
   */
  function dispose() {
    if (disposed) return Promise.resolve(undefined);
    const pending = flush();
    disposed = true;
    if (timer !== null) {
      try { clock.clearTimeout(timer); } catch {}
      timer = null;
    }
    return pending;
  }

  return Object.freeze({
    observe,
    flush,
    flushSession,
    finish,
    usageFor,
    entries,
    diagnostics,
    dispose,
  });
}
