/**
 * Host 关注点模块：Expert Group JSON 投影。
 *
 * 把「一个根会话 + 它的普通专家子代理 + 它的 fan-out 父任务」这套运行时对象，
 * 归一成一份**只读的 JSON 树**（schemaVersion:1），供右侧栏/客户端直接渲染。
 *
 * 设计边界：
 *
 * 1. 单向投影：本模块只读输入，绝不修改调用方对象（数组一律复制后处理，禁止原地排序）。
 * 2. 不重算状态：fan-out manager 已经给出 task/shard 明确状态时原样采用；只有在
 *    manager 没给 shard 状态时才回退到「最新 attempt」的状态。客户端不得再重算。
 * 3. 不猜内容：读不到的字段统一归一为 null，状态词表外的值统一归一为 "unknown"；
 *    缺失 taskName/content/contentSource 时不会用 id、prompt 或时间戳去拼凑。
 * 4. 幂等：同一份输入重复投影得到深度相等的输出，便于 RPC 缓存与差异比较。
 * 5. 可比较：顶层 revision 是「除 generatedAt 与 revision 自身之外全部内容」的摘要——
 *    内容相同则相同、内容变化则变化，客户端不必自己比较整棵树（票据 12）。
 * 6. 只搬运已证明的时间：节点的开始/结束/耗时全部来自 manager 或投影自身已有的字段；
 *    DSH 没有发布的能力（例如会话的完成时间）一律为 null，绝不用「最后一次活动」
 *    冒充完成时间，也不把未知耗时写成 0。
 *
 * @module dsh-expert-group/host/expert-group-snapshot
 */
import { createHash } from "node:crypto";
import { hasUsageMetrics, projectUsage, sumUsageByChildId } from "./usage-projection.js";
import { projectModelRouteFields } from "../shared/model-route.js";
import { projectStructuredResult, structuredProjectionFields } from "../shared/structured.js";

/** 投影 schema 版本；客户端只接受该版本的负载。 */
export const EXPERT_GROUP_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * 统一状态词表（Host 投影出口的唯一状态集合）。
 *
 * - queued/waiting：已登记但尚未真正执行；
 * - running：正在执行；
 * - succeeded/failed/cancelled/timed_out/interrupted：终态（interrupted 表示运行时
 *   句柄丢失，只能由重启后的 restore 判定）；
 * - idle/ready：DSH 的空闲语义（idle=已加载但当前无任务，ready=仅存在于存储中、可续接）；
 * - unknown：状态缺失或词表外的值，投影不猜测。
 */
export const EXPERT_GROUP_STATUSES = Object.freeze([
  "queued",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "idle",
  "ready",
  "unknown",
]);

const STATUS_SET = new Set(EXPERT_GROUP_STATUSES);

/**
 * 同义状态别名表：只收敛**拼写差异**（大小写、连字符、空格、常见同义词），
 * 不做语义推断。例如 "completed" 与 "succeeded" 在 fan-out 与 DSH 中含义一致，
 * 因此可安全归一；而 "paused"/"blocked" 之类没有对应词表项，一律落回 "unknown"。
 */
const STATUS_ALIASES = new Map([
  ["canceled", "cancelled"],
  ["timeout", "timed_out"],
  ["timedout", "timed_out"],
  ["timed-out", "timed_out"],
  ["success", "succeeded"],
  ["successful", "succeeded"],
  ["complete", "succeeded"],
  ["completed", "succeeded"],
  ["done", "succeeded"],
  ["error", "failed"],
  ["errored", "failed"],
  ["active", "running"],
  ["in_progress", "running"],
  ["in-progress", "running"],
  ["working", "running"],
  ["pending", "queued"],
  ["scheduled", "queued"],
  ["wait", "waiting"],
]);

/** 文本字段归一：只有非空字符串才算「有值」，其余（含数字/对象）统一为 null。 */
function textOrNull(value) {
  if (typeof value !== "string") return null;
  return value.length === 0 ? null : value;
}

/**
 * 分片任务名称归一：只有"去掉首尾空白后仍非空"的字符串才算有值。
 *
 * 与 textOrNull 的差别：纯空白名称在这里按缺失处理（回退分片代号），因为它是给用户
 * 看的任务名——一个只有空格的名称在侧栏上等价于空标签，还会多出一个悬空分隔符。
 * 名称内部的大小写与标点一律保留，返回值已 trim。
 */
function trimmedNameOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 时间字段归一：只接受有限数值（epoch 毫秒），其余统一为 null。 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ── 任务时间线与受限失败摘要（票据 12） ──────────────────────────────────────

/**
 * 终态词表（与模块顶部的状态注释一致）：只有这些状态才可能有 finishedAt/durationMs。
 *
 * 非终态（queued/waiting/running）以及 unknown 一律没有完成时间：时钟在走不代表任务结束。
 */
const TERMINAL_STATUS_SET = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/**
 * 「失败」语义的终态集合。
 *
 * cancelled 不算失败（用户主动取消不是错误）；只有 failed/timed_out/interrupted 才参与
 * 父任务级 failure 的挑选，避免把一次主动取消渲染成任务失败。
 */
const FAILURE_STATUS_SET = new Set(["failed", "timed_out", "interrupted"]);

/**
 * 「明确仍在进行中」的状态集合（与 client-expert-group-model.js 的 ACTIVE_STATUS_SET 同义）。
 *
 * 这些节点没有终点：即使输入误带 finishedAt/durationMs 也一律不采用，否则侧栏会把
 * 「正在运行」渲染成「已耗时 1.2s」。unknown / 缺失状态保持宽容——旧快照没有可靠状态时，
 * 显式给出的时间戳仍是唯一可用事实。
 */
const ACTIVE_STATUS_SET = new Set(["queued", "waiting", "running"]);

/**
 * 失败摘要 code 的字符上限：只作防御性闸门（允许列表内最长的码仅 19 位），
 * 客户端只展示不解析。
 */
export const FAILURE_CODE_MAX_LENGTH = 64;

/** 失败摘要 message 的字符上限：只给一行人类可读文案，绝不搬运整段错误/堆栈。 */
export const FAILURE_MESSAGE_MAX_LENGTH = 160;

/**
 * message 安全检查的总长度上限（多行文本；票据 12 第六轮）。
 *
 * 超限直接整条回退：既避免在超长输入（完整响应体/日志）上做昂贵检查，也保证
 * 「先截断再检查」不会把尾部凭据截成短而安全的残段。
 */
export const FAILURE_MESSAGE_SCAN_MAX_LENGTH = 8192;

/**
 * Unicode 格式字符 / 不可见字符 / 代理码位（票据 12 第七轮）。
 *
 * `\p{Cf}` 覆盖 U+200B/U+200C/U+200D/U+2060/U+FEFF/U+00AD 等零宽与格式字符；变体选择符
 * U+FE00–U+FE0F 与孤立代理码位 `\p{Cs}` 同样不可见。它们不属于 `\s`、也不是 Cc 控制字符，
 * 可能被用来拆分 Base64/hex（`AAECAwQFBgcICQoL\u200BA0ODxAREhMUFRYX`）。
 *
 * 正常错误消息不应包含这些字符，因此一旦出现**整条回退**，绝不做「删除后继续」处理。
 */
const INVISIBLE_FORMAT_PATTERN = /[\p{Cf}\p{Cs}\uFE00-\uFE0F]/u;

/**
 * 稳定错误码的**有限精确允许列表**（票据 12 第十二轮）：failure.code 与 recovery.code 共用。
 *
 * 历史：第十/十一轮按「形态」放行——长度 < 16 的任意全大写词、全大写+下划线机器码、
 * 长度 < 16 的 CamelCase。形态规则本质上是**开放集合**：任何满足形态的字符串都能进入
 * 快照。oracle 已复现 `recovery.code = "AbcdefGhijklmno"`（15 位、有效无填充 Base64URL，
 * 命中 CamelCase 形态）与 `failure.code = "YXBPPWFL_ZGFJZWFHAA"`（19 位、含下划线，
 * 命中全大写+下划线形态）被原样保留。只要还留一条形态规则，编码载荷通道就关不上。
 *
 * 本轮改为**精确字符串匹配的显式集合**：只有 `FAILURE_STABLE_CODES` 里的字面值会进入
 * 快照，其余一律回退（failure ⇒ "error"，recovery ⇒ "RESTORE_FAILED"）。判定过程没有
 * 任何正则、前缀/后缀或「像机器码」的形态放行路径，因此 Base64（标准/URL-safe/无填充/
 * 带下划线）、hex、随机串与凭据词都不可能通过——它们不是集合成员，与「形态是否安全」
 * 无关。
 *
 * 大小写：**不做**大小写归一。集合同时含 "ERROR"（运行时码）、"Error"（错误类名）与
 * 回退值 "error"（小写），折叠会把三者合并、让兜底值变成另一个码；精确匹配保证
 * 「输入 = 输出」，便于逐字审计。`eacces` / `Eacces` 这类大小写变体因此同样回退。
 *
 * 维护约束（新增稳定码必须同步三处，残余风险见 docs/tickets/12-task-timeline.md）：
 * 1. 本文件 `FAILURE_STABLE_CODES`；
 * 2. test/expert-group-snapshot.test.mjs 的集合完整性断言；
 * 3. 票据 12 文档的允许列表说明。
 * 集合只在发版时随代码增删，运行时不可扩展（有意的 fail-closed 设计）。
 *
 * 集合分四组，全部是**字面值**：
 * - POSIX/Node errno（17 项）；
 * - 插件/运行时稳定码（16 项）；
 * - CamelCase 错误类名（10 项）；
 * - 现有测试与运行时实际使用、但不属于前三组的稳定码（5 项：BUDGET_EXCEEDED 由 fan-out
 *   预算闸门产生并会进入 attempt.error.code；ERR_MODULE_NOT_FOUND / ERR_MODEL_NOT_FOUND
 *   是 Node 与模型解析失败的稳定短码；DivisionByZero / FIRST_FAILURE 是既有回归用例使用的
 *   稳定夹具码，保留它们只为继续验证「name 回退」与「attempt 级合法码保留」两条语义）。
 */
export const FAILURE_STABLE_CODES = Object.freeze([
  // POSIX/Node errno
  "EACCES",
  "EAGAIN",
  "EBADMSG",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "EPIPE",
  "ETIMEDOUT",
  "ABORT_ERR",
  "EAI_AGAIN",
  // 插件/运行时稳定码
  "ERROR",
  "UNKNOWN",
  "CANCELLED",
  "INTERRUPTED",
  "TIMEOUT",
  "ERROR_RATE_LIMIT",
  "RATE_LIMIT",
  "MODEL_NOT_FOUND",
  "AUTH_FAILED",
  "INVALID_SNAPSHOT",
  "RESTORE_FAILED",
  "PERSISTENCE_FAILED",
  "PERMISSION_DENIED",
  "QUOTA_EXCEEDED",
  "OVERLOADED",
  "INVALID_REQUEST",
  // CamelCase 错误类名
  "Error",
  "TypeError",
  "ValidationError",
  "AbortError",
  "TimeoutError",
  "RateLimitError",
  "AuthenticationError",
  "PermissionError",
  "ModelNotFoundError",
  "OverloadedError",
  // 现有测试/运行时实际使用的补充稳定码（集合外的机器码仍一律拒绝）
  "BUDGET_EXCEEDED",
  "ERR_MODULE_NOT_FOUND",
  "ERR_MODEL_NOT_FOUND",
  "DivisionByZero",
  "FIRST_FAILURE",
]);

/** 允许列表的精确查找索引：Set 命中即放行，不做任何归一（避免把兜底值 "error" 折进别的码）。 */
const FAILURE_STABLE_CODE_SET = new Set(FAILURE_STABLE_CODES);

/**
 * 无法安全判断时的通用失败文案：宁可少说，也不把可能含凭据的原文输出到客户端。
 */
export const FAILURE_REDACTED_MESSAGE = "操作失败（详情已省略）";

/**
 * 固定安全消息白名单（票据 12 第十一轮）：message 唯一允许保留的文本。
 *
 * 上一轮仍是「安全自由文本白名单」：只要文本通过字符集与可疑形态检查就原样保留，
 * 于是带编码语义的空白分段载荷（「BASE64 YXBPPWFL ZGFJZWFH」「encoded YXBp PWFl ZGFj ZWFh」）
 * 仍能整体通过并原样进入快照——它不是凭据、不是 URL、也不是长 token，但会把编码后的
 * 内容暴露给客户端。本轮不再尝试判断「这段自由文本是否安全」，而是**只保留精确命中
 * 固定白名单的文案**：其余任何文本（含上述载荷、长文本、自由文本）一律回退
 * FAILURE_REDACTED_MESSAGE。
 *
 * 匹配规则（唯一放宽的三点，且都不扩大可泄露内容）：
 * - 大小写不敏感；NFKC 归一（全角字符先变 ASCII）；
 * - 内部空白折叠为单空格（多行文本先把换行折叠为空格再整体匹配）；
 * - 结尾句号（可重复，ASCII "." 或中文 "。"）与首尾空白忽略。
 *
 * 命中后返回**白名单里的规范文案**而不是原始输入：客户端看到的永远是固定字符串，
 * 不随错误来源的大小写/标点变化。匹配是整体匹配——多行文本只有规范化后整体等于
 * 某条白名单文案才保留，因此「第一行安全、第二行是载荷」不再可能泄漏。
 *
 * 白名单只增不改：新增条目必须是「不含任何动态内容」的固定短语，绝不引入会话
 * 名称、模型名、路径或 token（否则等于重新打开自由文本通道）。
 */
export const FAILURE_SAFE_MESSAGES = Object.freeze([
  "rate limit exceeded",
  "model not found",
  "permission denied",
  "request timed out",
  "authentication failed",
  "authentication failed for model gpt-4",
  "restore failed",
  "shard failed",
  "shard failed (retry 2)",
  "模型不存在",
  "请求超时",
  "恢复失败",
  "快照 shard 结构非法",
]);

/** 白名单的规范化索引：key = 归一后的文案，value = 规范文案（输出用）。 */
const SAFE_FAILURE_MESSAGE_MAP = new Map(
  FAILURE_SAFE_MESSAGES.map((message) => [normalizeSafeMessageKey(message), message]),
);

/**
 * 白名单 key 归一：NFKC → 空白折叠 → 去首尾空白 → 去结尾句号 → 小写。
 *
 * `[.。]+$` 允许 "rate limit exceeded..."（重复句号）也归一为同一 key；除此之外
 * 不做任何改写（不删中间标点、不拆词），保持「精确匹配」的可证明性。
 */
function normalizeSafeMessageKey(value) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\u3002]+$/u, "")
    .trim()
    .toLowerCase();
}

/** 命中固定安全消息白名单时返回规范文案，否则返回 null（调用方整条回退）。 */
function canonicalSafeFailureMessage(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  return SAFE_FAILURE_MESSAGE_MAP.get(normalizeSafeMessageKey(text)) ?? null;
}

/**
 * 稳定错误码准入（failure.code / recovery.code 共用，票据 12 第十二轮）。
 *
 * 唯一判定是**精确成员检查**：`FAILURE_STABLE_CODES` 命中即放行，否则拒绝。返回 false 表示
 * 调用方必须回退各自的兜底值（failure ⇒ "error"，recovery ⇒ "RESTORE_FAILED"）。
 *
 * 保留长度闸门只是防御性一致（允许列表内最长的码为 19 位，远小于 64）：超长输入不必进入
 * 集合查找，且「上限」契约在集合将来扩充时仍然成立。
 *
 * 为什么不再做「不可见字符 / 编码凭据词 / 随机串 / hex / 纯字母串」检查：它们都是**形态**
 * 判定，而形态判定已被证明是开放集合（`AbcdefGhijklmno` 就是 15 位 CamelCase 形态的
 * Base64URL）。精确集合天然拒绝这些输入（它们不是集合成员）；保留形态检查反而会让读者
 * 误以为「形态安全」仍是放行条件。
 */
function isStableFailureCode(raw) {
  if (raw.length === 0 || raw.length > FAILURE_CODE_MAX_LENGTH) return false;
  return FAILURE_STABLE_CODE_SET.has(raw);
}

/**
 * 失败摘要的 code：error.code || error.name || "error"，但只接受**有限精确允许列表**。
 *
 * 任何不在 `FAILURE_STABLE_CODES` 里的输入（自由文本、堆栈首行、含空格/冒号/引号、
 * 超长 token、编码载荷 `AbcdefGhijklmno` / `YXBPPWFL_ZGFJZWFHAA`、`BASE64`/`ENCODED`/
 * `SECRET`、随机串、hex、未登记的新机器码）都退化为稳定值 "error"，绝不像旧实现那样
 * 「清理控制字符后直接截断」——截断会把 "Authorization: Bearer xxx" 这类内容的前 64 个
 * 字符原样带进快照。
 */
function restrictedFailureCode(source) {
  const raw = firstText(source?.code, source?.name);
  if (raw === null) return "error";
  return isStableFailureCode(raw) ? raw : "error";
}

/**
 * 把原始 message 规范化为「多行扫描文本」（只规范化，不做取舍）。
 *
 * - 换行统一：\r\n、\r、\n、U+2028、U+2029 → \n（failure 与 recovery 共用同一份文本）；
 * - 其余控制字符折叠为空格；
 * - 行内空白折叠为单空格、逐行去首尾空白，并去掉整体首尾空白。
 *
 * 关键：这里**不**取首行、也不截断——白名单匹配必须在完整文本上做（票据 12 第六/十一轮：
 * 先取首行会让换行分隔的载荷首段绕过整体匹配）。
 */
function normalizeFailureMessage(value) {
  // 不可见格式字符闸门（票据 12 第七轮）：原文或其 NFKC 形态出现 \p{Cf}/\p{Cs}/变体选择符
  // ⇒ 返回 null，调用方整条回退。必须在折叠空白之前检查——例如 U+FEFF 属于 \s，先折叠就会
  // 变成「静默删除后继续」，正是本轮要禁止的行为。
  if (INVISIBLE_FORMAT_PATTERN.test(value) || INVISIBLE_FORMAT_PATTERN.test(value.normalize("NFKC"))) {
    return null;
  }
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * 失败摘要的 message：**唯一出口是固定安全消息白名单**（默认整条回退）。
 *
 * 处理顺序（票据 12 第十一轮收紧）：
 * 1. 不可见字符闸门：原文或 NFKC 形态出现 \p{Cf}/\p{Cs}/变体选择符 ⇒ 整条回退（不删除后继续）；
 * 2. 规范化：\r\n/\r/\n/U+2028/U+2029 统一为换行，其余控制字符折叠为空格；
 * 3. 长度闸门：规范化后的完整文本超过 FAILURE_MESSAGE_SCAN_MAX_LENGTH（8192）⇒ 整条回退；
 * 4. 把换行折叠为空格，在**完整文本**上做固定白名单匹配（大小写/结尾句号/空白归一后
 *    必须整体等于某条白名单文案）；
 * 5. 命中 ⇒ 返回白名单规范文案（防御性截断到 FAILURE_MESSAGE_MAX_LENGTH）；
 *    未命中 ⇒ 整条回退 FAILURE_REDACTED_MESSAGE（"操作失败（详情已省略）"）。
 *
 * 与上一轮的差异：不再对自由文本做字符集/模式判定，也**不再取首行**——多行文本只有
 * 规范化后整体命中白名单才保留，因此「第一行安全、第二行是载荷」不会泄漏任何一行。
 * 没有可用文案时返回 null（调用方保留 code）。
 */
function restrictedFailureMessage(value) {
  const raw = textOrNull(value);
  if (raw === null) return null;
  const normalized = normalizeFailureMessage(raw);
  // 不可见格式字符（零宽/BOM/变体选择符/孤立代理）⇒ 无法安全判断，整条回退。
  if (normalized === null) return FAILURE_REDACTED_MESSAGE;
  if (normalized.length === 0) return null;
  // ① 超长文本直接回退（不在超长输入上做白名单匹配）。
  if (normalized.length > FAILURE_MESSAGE_SCAN_MAX_LENGTH) return FAILURE_REDACTED_MESSAGE;
  // ② 完整文本整体匹配白名单：换行折叠为空格后必须整体等于某条固定文案。
  const canonical = canonicalSafeFailureMessage(normalized.replace(/\n/g, " "));
  if (canonical === null) return FAILURE_REDACTED_MESSAGE;
  return canonical.length > FAILURE_MESSAGE_MAX_LENGTH
    ? canonical.slice(0, FAILURE_MESSAGE_MAX_LENGTH)
    : canonical;
}

/**
 * 受限失败摘要投影（白名单出口）。
 *
 * 输入可能是 manager 的结构化错误对象（可能带 stack/result）、Error 实例或字符串；
 * 输出恒为 `{ code, message }` 或 null：
 * - 只读 code/name/message 三个字段，**绝不**搬运 stack、prompt、完整 result；
 * - 凭据边界：code 只接受有限精确允许列表（FAILURE_STABLE_CODES，否则 "error"）；message 默认整条回退
 *   `FAILURE_REDACTED_MESSAGE`，只有命中固定安全消息白名单的文案才保留
 *   （见 restrictedFailureCode / restrictedFailureMessage）；
 * - message 缺失时为 null（键仍然存在，客户端不需要判断存在性）；
 * - 输入为 null/undefined/其它原始值（数字、布尔）时返回 null：没有错误就没有摘要。
 */
function projectFailure(value) {
  if (value === null || value === undefined) return null;
  const source = typeof value === "string" ? { message: value } : asRecord(value);
  if (source === undefined) return null;
  return {
    code: restrictedFailureCode(source),
    message: restrictedFailureMessage(source.message),
  };
}

/**
 * 两个时间戳之间的耗时（毫秒）。
 *
 * 任一缺失 → null：「不知道多久」不能写成 0，否则客户端会把未知显示成瞬时完成。
 * 时钟回拨导致负值时按 0 处理，绝不向客户端输出负耗时。
 */
function durationBetween(startedAt, finishedAt) {
  if (startedAt === null || finishedAt === null) return null;
  return Math.max(0, finishedAt - startedAt);
}

/** 最新一次带错误 attempt 的受限失败摘要（attempts 按时间顺序追加，因此从后往前找）。 */
function latestAttemptFailure(attempts) {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index].failure !== null) return attempts[index].failure;
  }
  return null;
}

/**
 * shard 节点的时间线字段。
 *
 * - startedAt：第一个真正开始的 attempt 的 startedAt；旧快照完全没有 attempt 级时间时
 *   回退 createdAt（分片登记时刻即时间线起点），不凭空造一个时间；
 * - finishedAt：最后一个 attempt 的 finishedAt；**仍在运行的分片恒为 null**——历史
 *   attempt 的完成时间不是当前这一轮的终点；
 * - lastActivityAt：manager 的 updatedAt（任何状态推进都会刷新它），缺失为 null；
 * - attemptCount/retryCount：**两者语义不同**。attemptCount 统计总尝试数（attempts.length）；
 *   retryCount 只统计**真实重试**（retryShard 追加 attempt、不增 task.round），由调用方按
 *   「attempts.length − 本分片经历的轮次数（task.round）」算好传入。continuation 每个逻辑
 *   轮次都会给每个分片追加一个 attempt 并递增 task.round（fanout/task-commands.js），
 *   这类复用不是重试，因此不计入 retryCount——否则每复用一轮侧栏就会多出一个「重试」；
 * - failure：最新一次带 error 的 attempt 的受限摘要。
 */
function projectShardTimeline(source, status, attempts, running, retryCount) {
  const createdAt = numberOrNull(source?.createdAt);
  let startedAt = createdAt;
  for (const attempt of attempts) {
    if (attempt.startedAt === null) continue;
    startedAt = attempt.startedAt;
    break;
  }
  const lastAttempt = attempts.length === 0 ? null : attempts[attempts.length - 1];
  // 明确仍在进行中的分片（queued/waiting/running，或 running 布尔为 true）没有终点：
  // 即使输入误带时间也不采用，与 attempt 级、客户端归一保持同一口径。
  const stillActive = running === true || ACTIVE_STATUS_SET.has(status);
  const finishedAt = stillActive || lastAttempt === null ? null : lastAttempt.finishedAt;
  const attemptCount = attempts.length;
  return {
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    lastActivityAt: numberOrNull(source?.updatedAt),
    attemptCount,
    // 真实重试数由调用方按 attempts 与 task.round 的差算出（见函数注释），这里原样输出。
    retryCount,
    failure: latestAttemptFailure(attempts),
  };
}

/**
 * 首个失败 shard 的受限失败摘要（父任务级 failure）。
 *
 * 只在**失败语义**的 shard 中挑选（failed/timed_out/interrupted）：某个分片重试后成功时，
 * 它的历史错误不应被当成任务级失败。命中失败状态但没有可用摘要（例如仅超时、从未写过
 * error）时继续往后找；全部没有则 null。
 */
function firstShardFailure(shards) {
  for (const shard of shards) {
    if (!FAILURE_STATUS_SET.has(shard.status)) continue;
    if (shard.failure !== null) return shard.failure;
  }
  return null;
}

/**
 * fan-out 父任务节点的时间线字段。
 *
 * - startedAt = createdAt（任务登记时刻就是时间线起点）；
 * - finishedAt 只给**终态**任务：优先 manager 的 settledAt；旧快照可能没有该字段，
 *   此时回退 updatedAt（manager 在结算时保证 updatedAt === settledAt，见 fanout.js 的
 *   aggregateTask）。非终态一律 null，绝不把「最后一次活动」伪装成完成时间；
 * - attemptCount/retryCount：所有 shard 的 attempt 总数与**真实重试**总数（分片内重试之和）。
 *   分片的 retryCount 已按 task.round 排除 continuation 复用轮次（见 projectShardTimeline），
 *   这里只是求和，不再对同一份 attempts 二次推导；
 * - failure：首个失败 shard 的受限摘要。
 */
function projectFanoutTimeline(source, status, shards) {
  const startedAt = numberOrNull(source?.createdAt);
  const updatedAt = numberOrNull(source?.updatedAt);
  const settledAt = numberOrNull(source?.settledAt) ?? updatedAt;
  const finishedAt = TERMINAL_STATUS_SET.has(status) ? settledAt : null;
  let attemptCount = 0;
  let retryCount = 0;
  for (const shard of shards) {
    attemptCount += shard.attemptCount;
    retryCount += shard.retryCount;
  }
  return {
    startedAt,
    finishedAt,
    durationMs: durationBetween(startedAt, finishedAt),
    lastActivityAt: updatedAt,
    attemptCount,
    retryCount,
    failure: firstShardFailure(shards),
  };
}

// ── 恢复状态（recovery）投影 ─────────────────────────────────────────────────

/**
 * recovery 块的固定状态集合（票据 04）。
 *
 * - none：本进程从未执行过恢复（没有持久化快照，或恢复入口尚未接线）；
 * - ok：最近一次恢复成功（此时必须清空 code/message，失败细节不得残留）；
 * - failed：最近一次恢复失败，原因码进 code，受限文案进 message。
 */
export const EXPERT_GROUP_RECOVERY_STATUSES = Object.freeze(["ok", "failed", "none"]);

/*
 * recovery.code 与 failure.code 共用同一份**有限精确允许列表**（isStableFailureCode，
 * 集合见 FAILURE_STABLE_CODES；票据 12 第十二轮）。集合外的任何字符串——包括满足旧形态
 * 规则的编码载荷（AbcdefGhijklmno、YXBPPWFL_ZGFJZWFHAA）、BASE64/ENCODED/SECRET、随机串
 * 与 hex——统一回退 `RESTORE_FAILED`（宁可只说「恢复失败」，也不透传无法证明安全的原因码）。
 * recovery 的状态/消息投影（status 三态、message 白名单、at/retryable/persistenceBlocked）
 * 不因本轮改动而变化。
 */

/** recovery.message 的字符上限：一行诊断文案，客户端横幅最多展示一行。 */
export const RECOVERY_MESSAGE_MAX_LENGTH = 200;

/**
 * 受限 message（票据 12 第四/六/十一轮）：与失败摘要**共用同一套固定安全消息白名单**。
 *
 * 恢复失败的 message 常来自异常 error.message（可能是 Bearer、签名 URL、长 token、
 * 键值对甚至完整响应体），只清控制字符 + 截断会把凭据原样带进快照。因此：
 * 1. 用与 failure message 相同的 `normalizeFailureMessage` 规范化多行文本
 *    （\r\n/\r/\n/U+2028/U+2029 统一换行，其余控制字符折叠）；
 * 2. 长度闸门：超过 FAILURE_MESSAGE_SCAN_MAX_LENGTH ⇒ 通用文案；
 * 3. 换行折叠为空格后，**整体**匹配固定白名单；
 * 4. 不命中 ⇒ 通用文案 `FAILURE_REDACTED_MESSAGE`（宁可少说，绝不原样输出）；
 * 5. 命中 ⇒ 返回白名单规范文案，防御性截断到 `RECOVERY_MESSAGE_MAX_LENGTH`。
 */
function recoveryMessageOrNull(value) {
  const raw = textOrNull(value);
  if (raw === null) return null;
  const normalized = normalizeFailureMessage(raw);
  // 不可见格式字符（零宽/BOM/变体选择符/孤立代理）⇒ 无法安全判断，整条回退。
  if (normalized === null) return FAILURE_REDACTED_MESSAGE;
  if (normalized.length === 0) return null;
  if (normalized.length > FAILURE_MESSAGE_SCAN_MAX_LENGTH) return FAILURE_REDACTED_MESSAGE;
  const canonical = canonicalSafeFailureMessage(normalized.replace(/\n/g, " "));
  if (canonical === null) return FAILURE_REDACTED_MESSAGE;
  return canonical.length > RECOVERY_MESSAGE_MAX_LENGTH
    ? canonical.slice(0, RECOVERY_MESSAGE_MAX_LENGTH)
    : canonical;
}

/**
 * 恢复状态块投影（白名单出口）。
 *
 * 入参是 Host 运行时从 fanoutHost.restoreStatus() 归一出来的**不可信候选**：
 * 本函数只保留声明字段，其余一律丢弃（字段白名单），并对 code/message 做边界收敛。
 * 恢复成功（status=ok）时强制清空 code/message；从未恢复过（none）同样不带任何
 * 失败细节。返回 null 表示调用方没有提供 recovery 信息（旧调用方/旧 Host 兼容）。
 */
function projectRecovery(value) {
  const source = asRecord(value);
  if (source === undefined) return null;
  const status = source.status === "failed" ? "failed" : source.status === "ok" ? "ok" : "none";
  const rawCode = textOrNull(source.code);
  // 只有 failed 才保留原因码；精确命中共享允许列表（FAILURE_STABLE_CODES）才保留，
  // 集合外的任何码（编码载荷/随机串/hex/凭据词/未登记机器码）统一退化为 RESTORE_FAILED。
  const code = status === "failed"
    ? (rawCode !== null && isStableFailureCode(rawCode) ? rawCode : "RESTORE_FAILED")
    : null;
  return {
    status,
    code,
    message: status === "failed" ? recoveryMessageOrNull(source.message) : null,
    at: numberOrNull(source.at),
    retryable: status === "failed" && source.retryable === true,
    // fail-closed 闸门状态是独立事实：即使最近一次恢复成功，也如实投影（正常应为 false）。
    persistenceBlocked: source.persistenceBlocked === true,
  };
}

/**
 * usage 字段的可选投影（票据 25）。
 *
 * 只输出有实际用量事实（token/请求数/重试数/有效样本）的投影；缺失时**省略整个字段**
 * 而不是输出 null/0，客户端因此能区分“没有用量数据”和“用量为 0”。
 * 投影本身由 usage-ledger 的白名单负责，不含 prompt/response/凭据/路径。
 *
 * @param {unknown} value - 节点上的 usage 候选。
 * @returns {object} 可直接展开进节点对象的 { usage } 或空对象。
 */
function usageField(value) {
  const usage = projectUsage(value);
  return usage !== null && hasUsageMetrics(usage) ? { usage } : {};
}

/** 从候选字段里取第一个非空字符串，全部缺失时返回 null（不拼接、不猜测）。 */
function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text !== null) return text;
  }
  return null;
}

/**
 * 状态归一。入参为空 → "unknown"；词表内原样通过；别名表命中则归一；
 * 其余值（包括任意自由文本）一律落回 "unknown"，绝不猜测。
 */
function normalizeStatus(value) {
  const text = textOrNull(value);
  if (text === null) return "unknown";
  const key = text.trim().toLowerCase().replace(/\s+/g, "_");
  if (STATUS_SET.has(key)) return key;
  return STATUS_ALIASES.get(key) ?? "unknown";
}

/**
 * running 布尔语义：
 * - 输入显式给了布尔 running 时以它为准（DSH 会话状态字段）；
 * - 否则由**已知**状态推导（running ⟺ true，其余已知状态 ⟺ false）；
 * - 状态缺失或未知时返回 null，而不是假的 false——「没写」与「明确没跑」不同。
 */
function runningOf(record, status) {
  if (typeof record?.running === "boolean") return record.running;
  if (status === "unknown") return null;
  return status === "running";
}

/** runSummary 是 Host 已派生的只读活动信息，未知值保持 unknown/null，不伪造空闲。 */
function projectRunSummary(value) {
  const source = asRecord(value);
  if (source === undefined) return null;
  const mode = source.mode === "continuable" || source.mode === "one-shot" ? source.mode : "unknown";
  const activity = source.activity === "running" || source.activity === "idle" ? source.activity : "unknown";
  return {
    command: textOrNull(source.command),
    mode,
    activity,
  };
}

/**
 * 顶层 roleLabels 投影（票据 27）：只保留「非空字符串 id → 非空字符串显示名」的条目。
 *
 * 非法条目静默丢弃：这份映射纯粹用于展示，丢弃不会影响任何权限或状态判定；
 * 一个条目都没有时返回 null（调用方整块省略），旧客户端保持原生文案。
 *
 * @param {unknown} value - 角色 id → 显示名候选。
 * @returns {Record<string,string>|null} 冻结前的普通对象或 null。
 */
function projectRoleLabels(value) {
  const source = asRecord(value);
  if (source === undefined) return null;
  const labels = {};
  let any = false;
  for (const [role, label] of Object.entries(source)) {
    if (typeof role !== "string" || role.length === 0) continue;
    if (typeof label !== "string" || label.trim().length === 0) continue;
    labels[role] = label;
    any = true;
  }
  return any ? labels : null;
}

/** 身份 id 归一：id → sessionId → childId，全部缺失时返回 null。 */
function identityOf(record) {
  return firstText(record?.id, record?.sessionId, record?.childId);
}

/** 参数校验：sessionId 必须是 Expert Group 的根会话键，否则拒绝投影。 */
function assertSessionId(sessionId) {
  if (!isNonEmpty(sessionId)) {
    throw new TypeError("buildExpertGroupSnapshot 需要非空字符串 sessionId");
  }
  return sessionId;
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 取记录的会话身份。非对象输入（字符串/数字/null）视为「没有记录」，
 * 而不是「用这个值当 id」——投影不允许从负载形状反推身份。
 */
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : undefined;
}

/**
 * root/expert 节点共用的字段归一。
 *
 * 字段来源固定为「已声明的同名词」，别名只收敛 DSH 侧真实存在的等价字段：
 * - taskName：taskName/task/title/displayTitle/label/name（与 client.js 的目录读取一致）；
 * - content：content/prompt（CONTEXT.md：专家任务内容使用派发 prompt）；
 * - effort：reasoningEffort/effort；
 * - contentSource **只认显式字段**：投影不推断内容来自 goal、用户请求还是 prompt。
 */
/**
 * 目标 subagent provider / 继承开关的只读投影（票据 29）。
 *
 * 输入是 runtime 已经归一好的 plain 字段（subagentProvider/inheritContext）。
 * 缺失时整体省略字段，绝不伪造 "spawn"/false：旧记录确实没有这个事实。
 *
 * @param {object|undefined} source - 待投影记录。
 * @returns {object} 可展开的投影字段。
 */
function projectSubagentContextFields(source) {
  const record = asRecord(source);
  const provider = textOrNull(record?.subagentProvider);
  return {
    ...(provider === null ? {} : { subagentProvider: provider }),
    ...(typeof record?.inheritContext === "boolean" ? { inheritContext: record.inheritContext } : {}),
  };
}

function projectSessionNode(record, { kind, id, sessionId }) {
  const source = asRecord(record);
  const status = normalizeStatus(source?.status);
  // 当前/最近一轮 turn 的墙钟用时（与 DSH 状态行同源，epoch ms）：缺失时省略字段，
  // 客户端回退模型用时，绝不补 0。
  const turnDurationMs = numberOrNull(source?.turnDurationMs);
  return {
    id,
    kind,
    sessionId,
    taskName: firstText(
      source?.taskName,
      source?.task,
      source?.title,
      source?.displayTitle,
      source?.label,
      source?.name,
    ),
    content: firstText(source?.content, source?.prompt),
    contentSource: textOrNull(source?.contentSource),
    role: textOrNull(source?.role),
    // 角色显示名（票据 27）：角色被删除后（包括历史上已删除的自定义角色），
    // 历史任务仍能显示标签；缺失为 null，客户端回退 role 或原生文案，绝不猜一个显示名。
    roleLabel: textOrNull(source?.roleLabel),
    ...(turnDurationMs === null ? {} : { turnDurationMs }),
    // 用量（票据 25）：root/expert 节点都可能带 usage；缺失时整字段省略。
    ...usageField(source?.usage),
    provider: textOrNull(source?.provider),
    model: textOrNull(source?.model),
    effort: firstText(source?.reasoningEffort, source?.effort),
    // 实际路由（票据 24）：只有确实记录过 candidateIndex/fallbackCount/
    // lastRouteErrorCode 时才输出，缺失字段整体省略（不补 0、不猜 primary）。
    ...projectModelRouteFields(source),
    // 目标 subagent provider / 继承开关（票据 29）：缺失省略，不伪造 false。
    ...projectSubagentContextFields(source),
    // 结构化交付（票据 30）：只读结果与“声明过 schema”的布尔；缺失整体省略。
    ...structuredProjectionFields(source),
    status,
    running: runningOf(source, status),
    runSummary: projectRunSummary(source?.runSummary),
    continuable: typeof source?.continuable === "boolean" ? source.continuable : null,
    // 会话节点（root/普通专家）也有能力对象：read 恒 allowed，写动作一律 not_supported。
    // 这样客户端可以用同一套「按能力渲染」逻辑处理所有节点，而不需要按 kind 特判。
    capabilities: sessionCapabilities(),
    createdAt: numberOrNull(source?.createdAt),
    // 会话节点的时间线（票据 12）：DSH 只发布创建时间，没有可信的完成时间。因此
    // startedAt/lastActivityAt 都取 createdAt，finishedAt/durationMs 恒为 null——客户端
    // 据此显示「已开始、耗时未知」，绝不用创建时间补一个假的完成时间。
    startedAt: numberOrNull(source?.createdAt),
    lastActivityAt: numberOrNull(source?.createdAt),
    finishedAt: null,
    durationMs: null,
  };
}

/** 单个普通专家节点：id/sessionId 都取会话身份（DSH 中 child agent id 即会话 id）。 */
function projectExpertNode(record) {
  const source = asRecord(record);
  const identity = identityOf(source);
  return {
    ...projectSessionNode(source, { kind: "expert", id: identity, sessionId: identity }),
    // 专家是叶子 worker，本切片不再向下展开子节点。
    children: [],
  };
}

/** 非数组输入降级为空集合：调用方给了半截数据时投影仍然可用，但不猜内容。 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 普通专家子节点投影。 */
function projectExpertChildren(experts) {
  return asArray(experts).map((record) => projectExpertNode(record));
}

// ── 逐动作能力投影（票据 09） ───────────────────────────────────────────────

/**
 * 能力动作词表（Host 投影出口的唯一集合）。
 *
 * - 普通专家/根节点只有 read 有意义：写动作属于 fan-out 管理层，对这些节点一律
 *   not_supported（客户端据此不渲染任何按钮）；
 * - fan-out 父节点带任务级四项，shard 节点只带 cancel/retry。
 */
export const EXPERT_GROUP_CAPABILITY_ACTIONS = Object.freeze(["read", "cancel", "retry", "continue"]);
export const EXPERT_GROUP_SHARD_CAPABILITY_ACTIONS = Object.freeze(["cancel", "retry"]);

/**
 * 能力原因码的最大长度：原因码是稳定的机器 token（如 task_not_found），客户端只做
 * 展示/判定，不解析自由文本。超长输入截断而不是丢弃，避免旧 Host 的长文案撑爆横幅。
 */
export const CAPABILITY_REASON_MAX_LENGTH = 64;

/** 会话节点（root/普通专家）的固定能力：只读可见，写动作不适用于会话。 */
function sessionCapabilities() {
  return {
    read: { allowed: true },
    cancel: { allowed: false, reason: "not_supported" },
    retry: { allowed: false, reason: "not_supported" },
    continue: { allowed: false, reason: "not_supported" },
  };
}

/**
 * 单项能力归一（白名单出口）：
 * - 只有 allowed 是布尔才算有效项；其它形状返回 null（调用方整体省略该动作）；
 * - allowed=true 时丢弃 reason（成功态不允许残留拒绝原因）；
 * - allowed=false 时保留稳定原因码；缺失/空/非字符串退回 not_supported，并限制长度。
 */
function projectCapabilityEntry(value) {
  const source = asRecord(value);
  if (source === undefined || typeof source.allowed !== "boolean") return null;
  if (source.allowed === true) return { allowed: true };
  const rawReason = textOrNull(source.reason);
  return {
    allowed: false,
    reason: rawReason === null ? "not_supported" : rawReason.slice(0, CAPABILITY_REASON_MAX_LENGTH),
  };
}

/** 按动作词表投影能力对象；一个有效项都没有时返回 null（调用方省略字段）。 */
function projectCapabilities(value, actions) {
  const source = asRecord(value);
  if (source === undefined) return null;
  const projected = {};
  let any = false;
  for (const action of actions) {
    const entry = projectCapabilityEntry(source[action]);
    if (entry === null) continue;
    projected[action] = entry;
    any = true;
  }
  return any ? projected : null;
}

// ── fan-out 分支投影 ────────────────────────────────────────────────────────

/** counts 的固定键集合，与 fanout.js 的 SHARD_STATUS_KEYS + pending 完全一致。 */
const COUNT_KEYS = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "pending",
]);

/**
 * fan-out manager 的**父任务**状态枚举到统一词表的显式映射。
 *
 * 这是 manager 自己的状态字（fanout.js FANOUT_TASK_STATUSES），不是客户端推断：
 * - pending（仍有未终态 shard）→ running（任务已派发且未收敛）；
 * - completed → succeeded；
 * - completed_with_errors → failed（部分成功在统一词表里没有独立项，原始字保留在
 *   taskStatus，消费方需要区分时读它）；
 * - cancelled → cancelled。
 */
const FANOUT_TASK_STATUS_MAP = new Map([
  ["pending", "running"],
  ["completed", "succeeded"],
  ["completed_with_errors", "failed"],
  ["cancelled", "cancelled"],
]);

/** 父任务状态归一：先走 manager 枚举表，再退回通用状态词表。 */
function normalizeTaskStatus(value) {
  const text = textOrNull(value);
  if (text === null) return "unknown";
  const mapped = FANOUT_TASK_STATUS_MAP.get(text.trim().toLowerCase());
  return mapped ?? normalizeStatus(text);
}

/**
 * 单次 attempt 投影（attempt 身份 = attempt 序号 + childId）。
 *
 * 只保留导航、状态与**受限**失败摘要：result 可能很大且有独立读取通道，投影不搬运；
 * error 只取 code/name 与 message 首行（见 projectFailure），stack 与完整负载绝不外传。
 */
function projectAttemptNode(attempt) {
  const source = asRecord(attempt);
  const status = normalizeStatus(source?.status);
  // 活动 attempt（queued/waiting/running，含 pending 归一后的 queued）没有完成时间：
  // 即使输入误带 finishedAt 也丢弃，与 client-expert-group-model.js 的 normalizeAttempt
  // 同一口径——否则侧栏会把「运行中」渲染成「运行中 已耗时 1.2s」。
  const stillActive = ACTIVE_STATUS_SET.has(status);
  const startedAt = numberOrNull(source?.startedAt);
  const finishedAt = stillActive ? null : numberOrNull(source?.finishedAt);
  return {
    attempt: numberOrNull(source?.attempt),
    status,
    childId: textOrNull(source?.childId),
    // 历史 attempt 的角色显示名快照（票据 27）：随 child_models 记录持久化，
    // 角色后来被删除时仍然可读。
    roleLabel: textOrNull(source?.roleLabel),
    // 每次 attempt 的实际路由（票据 24）：恢复/续作只读，不重新选择；缺失省略。
    ...projectModelRouteFields(source),
    // 目标 subagent provider / 继承开关（票据 29）：缺失省略，不伪造 false。
    ...projectSubagentContextFields(source),
    // 单次 attempt 的用量（票据 25）：来自该 attempt.childId 的 child_models/账本；
    // 归属未证明的 attempt 不会有 usage，缺失时整字段省略。
    ...usageField(source?.usage),
    // 结构化交付（票据 30）：同一 child 的只读结构化结果；缺失省略。
    ...structuredProjectionFields(source),
    startedAt,
    finishedAt,
    // 单次尝试的耗时与失败摘要：任一输入缺失即为 null（不填 0、不猜原因）。
    durationMs: stillActive ? null : durationBetween(startedAt, finishedAt),
    failure: projectFailure(source?.error),
  };
}

/**
 * 单 shard 投影。
 *
 * 状态优先级：manager 的明确 shard.status 优先；manager 没给（部分输入/旧快照）时，
 * 才取**最新一次 attempt**（输入数组最后一项，manager 保证追加顺序）的状态。
 * 因此「历史 attempt 失败、最新 attempt 成功」必须投影为 succeeded，反之亦然——
 * 历史 attempt 不覆盖当前有效结果，只作为审计信息保留在 attempts 里。
 * childId 同理只取最新 attempt 的，作为唯一导航键。
 */
function projectShardNode(shard, inherited = {}) {
  const source = asRecord(shard);
  const defaults = asRecord(inherited);
  // 分片当前/最近一轮的墙钟用时（与 DSH 状态行同源）：缺失时省略。
  const turnDurationMs = numberOrNull(source?.turnDurationMs);
  const attempts = asArray(source?.attempts).map((attempt) => projectAttemptNode(attempt));
  const latestAttempt = attempts.length === 0 ? null : attempts[attempts.length - 1];
  const shardId = textOrNull(source?.shardId);
  const managerStatus = textOrNull(source?.status);
  const status = managerStatus === null
    ? latestAttempt?.status ?? "unknown"
    : normalizeStatus(managerStatus);
  const running = runningOf(source, status);
  /**
   * 真实重试数（与 continuation 轮次区分开，见 projectShardTimeline 注释）。
   *
   * 依据是父任务的 round：continuation 每轮 +1 且给每个分片各追加一个 attempt；
   * retryShard 只追加 attempt、不增 round。因此「每个轮次基线一次尝试」，
   * retryCount = attempts.length − max(1, min(attempts.length, rounds))：
   * - rounds 缺失（旧快照）时默认 1，与改动前 max(0, length-1) 完全一致；
   * - rounds 大于 attempts.length 时基线被钳到 attempts.length，重试数钳到 0，绝不出现负数。
   */
  const rounds = Math.max(1, numberOrNull(defaults?.round) ?? 1);
  const baselineAttempts = Math.max(1, Math.min(attempts.length, rounds));
  const retryCount = Math.max(0, attempts.length - baselineAttempts);
  // 时间线字段一次性算出：startedAt/finishedAt/durationMs/lastActivityAt/attemptCount/
  // retryCount/failure 全部由 attempts、createdAt、updatedAt 与状态推导（见 projectShardTimeline）。
  const timeline = projectShardTimeline(source, status, attempts, running, retryCount);
  // 分片用量（票据 25）：runtime 已按 childId 去重汇总时直接采用；直接调用本投影
  // （没有 runtime 参与）时从 attempts 的 usage 汇总同一口径，绝不补零。
  const explicitUsage = projectUsage(source?.usage);
  const shardUsage = explicitUsage !== null && hasUsageMetrics(explicitUsage)
    ? explicitUsage
    : sumUsageByChildId(attempts.map((attempt) => ({ childId: attempt.childId, usage: attempt.usage })));
  return {
    shardId,
    // 主代理提供的分片任务名称优先（投影出的任务行第一行文本）；旧数据没有该字段或
    // 名称是空白串时回退分片代号，保持既有「分片标识即任务名称」的展示语义不变。
    taskName: trimmedNameOrNull(source?.name) ?? shardId,
    prompt: textOrNull(source?.prompt),
    // fan-out 一次提交使用同一专家角色；provider/model/effort 则由 runtime 按
    // 最新 attempt child 补齐。旧快照没有分片级字段时再继承父任务元数据。
    role: firstText(source?.role, defaults?.role),
    // 分片角色显示名：优先分片自己的记录，其次父任务元数据（票据 27）。
    roleLabel: firstText(source?.roleLabel, defaults?.roleLabel),
    provider: firstText(source?.provider, defaults?.provider),
    model: firstText(source?.model, defaults?.model),
    effort: firstText(source?.reasoningEffort, source?.effort, defaults?.reasoningEffort, defaults?.effort),
    ...(turnDurationMs === null ? {} : { turnDurationMs }),
    // 分片实际路由（票据 24）：来自最新 attempt child 的 child_models 记录；缺失省略。
    ...projectModelRouteFields(source),
    // 目标 subagent provider / 继承开关（票据 29）：来自同一 child 的 child_models；缺失省略。
    ...projectSubagentContextFields(source),
    // 分片用量（票据 25）：没有有效样本时整字段省略。
    ...(shardUsage === null || !hasUsageMetrics(shardUsage) ? {} : { usage: shardUsage }),
    // 结构化交付（票据 30）：分片取最新 attempt 的只读结果，不跨 attempt 合并 value。
    ...(latestAttempt?.structured === undefined ? {} : { structured: latestAttempt.structured }),
    ...(latestAttempt?.outputSchemaRequested === true ? { outputSchemaRequested: true } : {}),
    status,
    running,
    runSummary: projectRunSummary(source?.runSummary),
    continuable: typeof source?.continuable === "boolean" ? source.continuable : null,
    // shard 能力只覆盖管理层真正拥有的两个动作；缺失（旧 Host/直连投影）时整字段省略，
    // 客户端据此回退到既有状态推导。
    ...(() => {
      const capabilities = projectCapabilities(source?.capabilities, EXPERT_GROUP_SHARD_CAPABILITY_ACTIONS);
      return capabilities === null ? {} : { capabilities };
    })(),
    childId: latestAttempt?.childId ?? null,
    createdAt: numberOrNull(source?.createdAt),
    // 票据 12 时间线：字段恒存在（缺失值为 null/0），客户端不需要判断存在性。
    ...timeline,
    attempts,
  };
}

/** counts 归一：manager 没给 counts 就保持 null（投影不按 shards 重算）；给了则逐键取值，缺失键为 null。 */
function projectCounts(counts) {
  const source = asRecord(counts);
  if (source === undefined) return null;
  const projected = {};
  for (const key of COUNT_KEYS) projected[key] = numberOrNull(source[key]);
  return projected;
}

/**
 * fan-out 父任务节点投影。
 *
 * taskStatus 保留 manager 的原始字（便于区分 completed / completed_with_errors），
 * status 是统一词表出口。父任务状态**不做 shard 聚合**：manager 没给就是 unknown。
 */
function projectFanoutNode(task) {
  const source = asRecord(task);
  const parentTaskId = textOrNull(source?.parentTaskId);
  const taskStatus = textOrNull(source?.status);
  const status = normalizeTaskStatus(taskStatus);
  // 先投影 shards：父任务的 attemptCount/retryCount/failure 是对分片投影结果的汇总，
  // 因此两者不会出现「父任务与分片对同一份 attempts 各算一遍」的不一致。
  const shards = asArray(source?.shards).map((shard) => projectShardNode(shard, {
    role: source?.role,
    roleLabel: source?.roleLabel,
    provider: source?.provider,
    model: source?.model,
    reasoningEffort: source?.reasoningEffort,
    effort: source?.effort,
    // 逻辑轮次：manager 快照恒给 round>=1（fanout/store.js），分片据此把 continuation 追加的
    // attempt 从「重试」里排除；旧快照缺 round 时默认 1，退化为改动前的口径。
    // 只接受安全整数且 >=1：numberOrNull 仅校验有限性，1.5 这类值会让基线变成小数，
    // retryCount 随之出现 0.5 这种无法解释的「半次重试」；非整数一律按缺失（第 1 轮）处理。
    round: Number.isSafeInteger(source?.round) && source.round >= 1 ? source.round : 1,
  }));
  const timeline = projectFanoutTimeline(source, status, shards);
  /**
   * 结构化结果汇总（票据 30）：只保留每个 attempt 自己的只读结果，**绝不合并 value**。
   * task 节点的 structured 是数组（shardId/attempt/childId/structured），没有结果时整个
   * 字段省略；outputSchemaRequested 只在至少一个 attempt 声明过时为 true。
   */
  const structuredResults = [];
  let outputSchemaRequested = false;
  for (const shard of shards) {
    for (const attempt of Array.isArray(shard?.attempts) ? shard.attempts : []) {
      if (attempt?.outputSchemaRequested === true) outputSchemaRequested = true;
      if (attempt?.structured === undefined) continue;
      structuredResults.push({
        shardId: shard?.shardId ?? null,
        attempt: attempt?.attempt ?? null,
        childId: attempt?.childId ?? null,
        structured: projectStructuredResult(attempt.structured),
      });
    }
  }
  // 父任务用量（票据 25）：runtime 汇总值优先；直接调用本投影时按 attempts 的
  // (childId, usage) 去重汇总，与 runtime 完全同口径。没有有效样本时省略字段。
  const explicitUsage = projectUsage(source?.usage);
  const taskUsage = explicitUsage !== null && hasUsageMetrics(explicitUsage)
    ? explicitUsage
    : sumUsageByChildId(shards.flatMap((shard) => (
      Array.isArray(shard.attempts) ? shard.attempts.map((attempt) => ({ childId: attempt.childId, usage: attempt.usage })) : []
    )));
  return {
    // 父任务 id 本身就是稳定身份，可直接作为节点 id（kind 区分它与专家会话 id）。
    id: parentTaskId,
    kind: "fanout",
    parentTaskId,
    basePrompt: textOrNull(source?.basePrompt),
    role: textOrNull(source?.role),
    roleLabel: textOrNull(source?.roleLabel),
    status,
    taskStatus,
    running: runningOf(source, status),
    createdAt: numberOrNull(source?.createdAt),
    // 票据 12 时间线：startedAt/finishedAt/durationMs/lastActivityAt/attemptCount/
    // retryCount/failure。字段恒存在，缺失值为 null/0（旧输入向后兼容）。
    ...timeline,
    // 任务级用量（票据 25）：缺失时整字段省略，客户端显示“用量不可用”而不是 0。
    ...(taskUsage === null || !hasUsageMetrics(taskUsage) ? {} : { usage: taskUsage }),
    // 结构化交付（票据 30）：逐 attempt 保留、不合并 value；缺失整体省略。
    ...(structuredResults.length === 0 ? {} : { structured: structuredResults }),
    ...(outputSchemaRequested ? { outputSchemaRequested: true } : {}),
    counts: projectCounts(source?.counts),
    // 父任务能力：由 Host 注入（fanoutHost.capabilitiesOf）；旧调用方没有该字段时省略，
    // 保持「不伪造授权」的投影原则。
    ...(() => {
      const capabilities = projectCapabilities(source?.capabilities, EXPERT_GROUP_CAPABILITY_ACTIONS);
      return capabilities === null ? {} : { capabilities };
    })(),
    shards,
  };
}

/**
 * 收集所有 fan-out attempt 的 childId。
 *
 * 这些会话已经在 fan-out 分支里以「分片 + attempt」的形式出现，属于同一个 Expert
 * Group 节点的另一种视图；如果同时再作为普通 expert 子节点输出，客户端会看到重复
 * 任务。注意是**任意** attempt（含历史失败 attempt），不只是最新那次。
 */
function collectAttemptChildIds(fanoutTasks) {
  const childIds = new Set();
  for (const task of asArray(fanoutTasks)) {
    for (const shard of asArray(asRecord(task)?.shards)) {
      for (const attempt of asArray(asRecord(shard)?.attempts)) {
        const childId = textOrNull(asRecord(attempt)?.childId);
        if (childId !== null) childIds.add(childId);
      }
    }
  }
  return childIds;
}

/**
 * 合并排序：普通专家与 fan-out 分支统一按 createdAt 升序。
 *
 * 缺失 createdAt 的节点表示「时间未知」，统一排在有序节点之后，并在它们之间保持
 * 输入顺序；相同时间戳也用输入下标兜底，结果不依赖引擎排序实现的稳定性。
 * fan-out 内部的 shards/attempts 不参与该排序，始终保留 manager 顺序。
 */
function sortByCreatedAt(nodes) {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftKey = left.node.createdAt === null ? Number.POSITIVE_INFINITY : left.node.createdAt;
      const rightKey = right.node.createdAt === null ? Number.POSITIVE_INFINITY : right.node.createdAt;
      if (leftKey !== rightKey) return leftKey - rightKey;
      return left.index - right.index;
    })
    .map((entry) => entry.node);
}

/**
 * root.children = 普通专家子节点 + fan-out 分支节点。
 * 先按 attempt.childId 去重，再按 createdAt 升序合并。
 */
function projectChildren(experts, fanoutTasks) {
  const fanoutChildIds = collectAttemptChildIds(fanoutTasks);
  const expertNodes = projectExpertChildren(experts)
    // 身份缺失的专家无法判定是否与 attempt 重复，保留原样而不是误删。
    .filter((node) => node.sessionId === null || !fanoutChildIds.has(node.sessionId));
  const fanoutNodes = asArray(fanoutTasks).map((task) => projectFanoutNode(task));
  return sortByCreatedAt([...expertNodes, ...fanoutNodes]);
}

// ── 顶层内容摘要 revision（票据 12） ────────────────────────────────────────

/**
 * 规范化 JSON：对象键按字典序排序，数组保持原序，其余值按 JSON 语义序列化。
 *
 * 不能直接用 JSON.stringify：revision 必须只由**内容**决定。投影构造的对象键序虽然稳定，
 * 但字段书写顺序的调整（或未来白名单增删）不应被误判成「内容变了」；排序后序列化让
 * revision 与键的书写顺序无关，只有真正的值变化才改变摘要。
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const parts = Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]));
    return "{" + parts.join(",") + "}";
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

/**
 * 快照内容摘要（顶层 revision，sha256 十六进制）。
 *
 * 只排除两个字段：
 * - `generatedAt`：每次投影都会变的生成时间，与内容无关；
 * - `revision` 自身：摘要不能包含自己（这里防御性删除，调用顺序改变时同样正确）。
 *
 * 其余字段（含 partial、recovery 与整棵 root 子树）全部参与摘要：等价内容得到相同
 * revision，任何内容变化都会改变它。客户端据此判断「这份快照与上一份是不是同一份内容」，
 * 不需要自己比较整棵树。
 */
function computeSnapshotRevision(snapshot) {
  const content = { ...snapshot };
  delete content.generatedAt;
  delete content.revision;
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

/**
 * 构建 Expert Group 快照。
 *
 * @param {object} input
 * @param {string} input.sessionId - Expert Group 的根会话 id（必填，非法即抛 TypeError）。
 * @param {object} [input.root] - 根会话/根 Agent 记录；声明的会话 id 必须与 sessionId 一致。
 * @param {Array} [input.experts] - 普通专家记录（自身状态由 DSH 给出）。
 * @param {Array} [input.fanoutTasks] - fan-out manager 的父任务快照。
 * @param {number} [input.generatedAt] - 投影生成时间（epoch 毫秒）。
 * @param {boolean} [input.partial] - 是否为**轻量快照**（跳过全部冷读、状态可能不完整）。
 *   true 时客户端必须保持状态圆点与活动文案中性，等完整快照（partial:false）替换。
 * @param {object} [input.recovery] - 可选的恢复状态候选（来自 fanoutHost.restoreStatus()）。
 *   提供时投影为顶层可选 recovery 块；未提供时**整块省略**（旧调用方/旧 Host 兼容，
 *   客户端按缺失回退为「没有恢复错误」）。
 * @param {object} [input.roleLabels] - 角色 id → 显示名（票据 27，含历史角色显示名，
 *   包括已删除角色的持久化标签）。
 *   提供时投影为顶层 roleLabels；未提供/为空时整块省略，客户端回退原生文案。
 * @returns {object} schemaVersion:1 的只读 JSON 树。
 */
export function buildExpertGroupSnapshot({ sessionId, root, experts, fanoutTasks, generatedAt, partial, recovery, roleLabels } = {}) {
  const rootSessionId = assertSessionId(sessionId);
  const declaredRootId = identityOf(root);
  if (declaredRootId !== null && declaredRootId !== rootSessionId) {
    throw new TypeError(
      "buildExpertGroupSnapshot 的 root 会话 id " + declaredRootId + " 与 sessionId " + rootSessionId + " 不一致",
    );
  }
  const projectedRecovery = projectRecovery(recovery);
  const projectedRoleLabels = projectRoleLabels(roleLabels);
  const snapshot = {
    schemaVersion: EXPERT_GROUP_SNAPSHOT_SCHEMA_VERSION,
    sessionId: rootSessionId,
    rootSessionId,
    generatedAt: numberOrNull(generatedAt),
    // 角色显示名（票据 27）：含历史角色显示名（包括已删除角色的持久化标签）；
    // schemaVersion 仍为 1（纯增量字段）。
    ...(projectedRoleLabels === null ? {} : { roleLabels: projectedRoleLabels }),
    // partial 只有明确 true 才为 true：完整快照与旧调用方一律是权威快照（false）。
    partial: partial === true,
    // recovery 是**可选**顶层块：只有调用方提供了恢复状态候选时才出现。它只含
    // 稳定原因码与受限文案，绝不携带快照正文、任务负载、堆栈或路径。
    ...(projectedRecovery === null ? {} : { recovery: projectedRecovery }),
    root: {
      ...projectSessionNode(root, {
        kind: "root",
        id: declaredRootId ?? rootSessionId,
        sessionId: rootSessionId,
      }),
      children: projectChildren(experts, fanoutTasks),
    },
  };
  // revision 最后写入：它覆盖除 generatedAt/revision 自身之外的全部内容
  // （见 computeSnapshotRevision）。schemaVersion 仍为 1 —— 新字段全部向后兼容。
  snapshot.revision = computeSnapshotRevision(snapshot);
  return snapshot;
}
