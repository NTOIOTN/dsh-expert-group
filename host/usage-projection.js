/**
 * 用量归一与投影（纯函数库；票据 08 / R2 从 host/usage-ledger.js 拆出）。
 *
 * 本文件只承载**无状态**的归一 / 投影 / 聚合 / 单价规则与常量：没有 Map、timer、
 * 可写模块状态，因此 Host 组合根、快照投影、设置读取投影、账本以及纯函数测试都可以
 * 直接复用它。账本的有界状态机（sessions / stats / disposed / 唯一 timer）留在
 * `host/usage-ledger.js`。
 *
 * 契约来源：docs/specs/03-host-contract-report.md §2
 * - usage 主位置是 assistant/message 的 data.usage；
 * - assistant/message 也可能只有 data.stream 里的 usage chunk；
 * - assistant/attempt 没有 message，只能读 data.stream 最后一个 usage chunk；
 * - 唯一键是 (sessionId, seq)：没有 event id、message.id 跨 fork 会重复；
 * - 事件可能迟到/重复，账本按每个 session 的 seq 水位丢弃旧样本；
 * - fork 子会话的继承前缀不会重新发布 session/event，账本只累计 live 自有事件。
 *
 * 有界性（纯函数侧）：聚合组数（role/provider/model）最多 64 组，溢出并入 "other"；
 * provider+model 组合分组同样有界（最多 64 条），溢出并入 other/other；所有字符串字段
 * 截断到 128 字符，所有数值只接受安全非负整数 / 有限非负时间。
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
export function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 有限非负时间戳/时长判定（epoch 毫秒可能不是安全整数，但必须有限且非负）。 */
export function isTime(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function textOrNull(value, max = MAX_USAGE_TEXT_CHARS) {
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

export function maxOrNull(...values) {
  let result = null;
  for (const value of values) {
    if (!isTime(value)) continue;
    result = result === null ? value : Math.max(result, value);
  }
  return result;
}

export function minOrNull(...values) {
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
export function finalizeUsage(value) {
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

// ── 账本 owner 复用的归一 helper（内部出口） ────────────────────────────────
//
// 下面三个函数原本嵌在 `createUsageLedger` 工厂内部。提到纯函数库是为了把工厂本体压到
// 400 行以内（票据 08），同时保证账本与投影**只有一套**归一实现；它们不读写任何状态，
// 只接收/返回普通值，因此放在这里不构成新的状态 owner。

/**
 * 把归属叠加到累积 usage 上（纯函数；就地写调用方传入的 usage，由调用方决定是否落盘）。
 *
 * - role / roleLabel / provider / model 取第一个非空（已有值优先，归属稳定）；
 * - fallbackCount 是 child 的**累计降级次数**，不是逐事件增量：取最大值，避免回退/重复
 *   读取让计数变小，也避免把同一份持久化值重复相加。
 *
 * @param {object} usage - 累积值（调用方持有）。
 * @param {unknown} attribution - 归属候选（非对象时整段跳过）。
 */
export function applyAttribution(usage, attribution) {
  if (!isPlainObject(attribution)) return;
  usage.role = firstText(usage.role, attribution.role) ?? undefined;
  usage.roleLabel = firstText(usage.roleLabel, attribution.roleLabel) ?? undefined;
  usage.provider = firstText(usage.provider, attribution.provider) ?? undefined;
  usage.model = firstText(usage.model, attribution.model) ?? undefined;
  if (isCount(attribution.fallbackCount)) {
    usage.fallbacks = Math.max(isCount(usage.fallbacks) ? usage.fallbacks : 0, attribution.fallbackCount);
  }
}

/**
 * 把一条已校验样本并入聚合值（纯函数）：token 相加、sampleCount +1、不影响归属。
 *
 * @param {object} aggregate - 当前聚合值。
 * @param {object} sample - normalizeTokenUsage 的 usage 输出。
 * @returns {object} 新的聚合值（经 finalizeUsage 重算派生字段）。
 */
export function mergeSampleIntoAggregate(aggregate, sample) {
  const merged = { ...aggregate };
  for (const field of TOKEN_FIELDS) {
    if (!isCount(sample[field])) continue;
    merged[field] = (isCount(merged[field]) ? merged[field] : 0) + sample[field];
  }
  merged.sampleCount = (isCount(merged.sampleCount) ? merged.sampleCount : 0)
    + (isCount(sample.sampleCount) ? sample.sampleCount : 1);
  return finalizeUsage(merged);
}

/**
 * 重试去重键：同 (turn, step) 的 assistant/attempt 与 llm/retry-started 只计一次。
 *
 * 没有合法 turn 时返回 null（调用方据此不做去重）。step 缺失时用 "*" 占位，保证同一
 * turn 的「未知 step」样本彼此去重。
 *
 * @param {object} event - session/event 事件对象。
 * @returns {string|null} 去重键。
 */
export function retryKeyOf(event) {
  const turn = event?.data?.turn;
  const step = event?.data?.step;
  if (!Number.isSafeInteger(turn)) return null;
  return String(turn) + ":" + (Number.isSafeInteger(step) ? String(step) : "*");
}
