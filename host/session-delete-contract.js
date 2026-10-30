/**
 * 会话删除（票据 01）的两张表与其记录契约。
 *
 * ## 两张表
 * - **删除收敛日志**（`session_delete_queue`）：写前意图与待收敛队列的合一。键 = 会话 ID，
 *   值 = 状态（intent / cleanup / race）、登记时间、尝试次数、最近失败原因；
 *   另有一类**批量意图记录**（键形如 `batch:<时间戳36进制>-<随机 token>`）：值是状态恒为
 *   `intent` 的写前意图 + 成员集合 `sessions`，语义等价于「每个成员各一条 intent」。
 *   引入它的原因见 ADR 0011「批量写前意图」：收敛的分支判定只依赖「原始路径上的日志是否
 *   存在」，因此成功目标不需要各自持久化状态，一次作业一条意图就足以在崩溃后逐会话收敛；
 *   而 storage-json 的 `single` 布局里一次 `table.put` = 整份文档序列化 + fsync + rename，
 *   逐目标写两次会把 160 目标的批量删除放大成 320 次整份文档落盘。
 * - **删除残渣**（`session_delete_residue`）：收敛期清理失败的项目。键 = 会话 ID，
 *   值 = 失败项集合、次数、首次时间。
 *
 * 两张表都挂在既有 storage domain `dsh_expert_group`（version 仍为 1）里：新增表不是
 * 破坏性变更，与票据 28 的 `fanout_templates`、B3 的 `orchestrator_state` 同一处理方式。
 *
 * ## 为什么 durable 表值 schema 只约束「JSON 对象」
 * 宿主的 storage domain 在 `open()` 时会用 zod 校验**每一条**存储记录，任何一条非法就会让
 * 整个 domain 打不开（`invalid-record`，且本 spec 没有声明 `invalidRecords` 的降级策略）。
 * 会话删除的规格（决策 8）要求严格区分两种损坏形态：
 * - **整份文档不可解析** → 整体暂停收敛、删除入口不可用（由 storage domain 打开失败表达）；
 * - **记录体字段非法或状态未知但键可读** → 按 `intent` 语义处理，其余条目照常收敛。
 * 如果 durable schema 也做严格校验，第二种形态永远不可达——一条被外部篡改的记录会让整个
 * domain（连同 settings、child 模型等无关表）一起打不开，反而把删除能力连坐拖死。
 *
 * 因此边界这样切：
 * - **写入边界严格**：`DOMAIN_SESSION_DELETE_QUEUE_ENTRY` / `..._RESIDUE_ENTRY` 在
 *   `host/session-delete-store` 的写入原语里先 `parse`，非法记录根本落不了盘；
 * - **durable 形状宽松**：表值只要求「JSON 对象」，保证整份文档始终可解析；
 * - **读取面显式降级**：`normalizeQueueRecord` 把未知状态按 `intent` 归一（决策 8），
 *   `normalizeResidueRecord` 对无法解释的记录返回 null 并把键报给调用方。
 *
 * @module dsh-expert-group/host/session-delete-contract
 */
import { z as domainZ } from "zod";

/** 删除收敛日志表名（与 host/storage-domain-schema 的登记必须一致）。 */
export const SESSION_DELETE_QUEUE_TABLE = "session_delete_queue";

/** 删除残渣表名（与 host/storage-domain-schema 的登记必须一致）。 */
export const SESSION_DELETE_RESIDUE_TABLE = "session_delete_residue";

/**
 * 收敛日志的三个状态（决策 8）：
 * - `intent`：写前意图。它是唯一与「不知道发生过什么」相容的状态（在任何破坏性动作之前写入），
 *   因此未知状态一律按它处理；
 * - `cleanup`：日志已改名进隔离区、进入待清理；
 * - `race`：改名后发现会话被重新打开（内容已保留）。
 */
export const SESSION_DELETE_STATUS = Object.freeze({
  INTENT: "intent",
  CLEANUP: "cleanup",
  RACE: "race",
});

/** 最近失败原因的最大长度：只保留可展示的一行，绝不落盘堆栈或正文。 */
const MAX_QUEUE_ERROR_CHARS = 512;

/**
 * 批量意图记录能覆盖的会话数上限（= 单次作业的目标上限，客户端批上限也是 200）。
 *
 * 批量记录必须是**有界**的：它是整份聚合文档里的一个值，一条无界记录会把每次写入的
 * 序列化成本与读取面的遍历成本一起放大；上限与作业上限对齐后，「一个作业一条记录」
 * 天然满足约束。
 */
const MAX_BATCH_SESSIONS = 200;

/**
 * 批量意图记录的键前缀。
 *
 * 宿主 session ID 是 UUID，不含冒号；清理侧的 isSafeSessionId 同样拒绝冒号，因此
 * 「batch:」前缀**不可能**与真实会话键冲突。前缀同时让读取面无需旁路元数据就能把
 * 「批量意图」与「单会话条目」区分开（收敛期分两类处理）。
 */
const BATCH_QUEUE_KEY_PREFIX = "batch:";

/** 批量键的总长度上限：远小于表键的安全范围，又足够放下「时间戳 + 随机 token」。 */
const MAX_BATCH_QUEUE_KEY_CHARS = 96;

/** 批量键去掉前缀之后的允许字符集：只允许 URL 安全字符，绝不产生分隔符或控制字符。 */
const BATCH_QUEUE_KEY_BODY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * 是否是一条批量意图记录的键（前缀 + 受控长度 + 受限字符集）。
 *
 * @param {unknown} key - 收敛日志表的键。
 * @returns {boolean} true 表示这是批量意图记录（**不是**会话 ID）。
 */
export function isBatchQueueKey(key) {
  if (typeof key !== "string") return false;
  if (key.length <= BATCH_QUEUE_KEY_PREFIX.length) return false;
  if (key.length > MAX_BATCH_QUEUE_KEY_CHARS) return false;
  if (key.startsWith(BATCH_QUEUE_KEY_PREFIX) !== true) return false;
  return BATCH_QUEUE_KEY_BODY_PATTERN.test(key.slice(BATCH_QUEUE_KEY_PREFIX.length));
}

/** 批量键随机段的位数：36^6 ≈ 21.8 亿，同毫秒内碰撞概率可忽略，且键长仍然很短。 */
const BATCH_KEY_TOKEN_CHARS = 6;

/**
 * 生成一条批量意图记录的键：「batch: + 毫秒时间戳的 36 进制 + - + 6 位随机 token」。
 *
 * 时间戳保持可读（排查时能一眼看出是哪次作业写的），随机段保证同一毫秒内的两次作业
 * 不会互相覆盖 —— 覆盖会让前一个作业尚未收敛的成员**凭空消失**（整份记录被替换）。
 *
 * **随机源缺省时退回 `Math.random`**：生产装配不注入它，若缺省退化成固定 token，同一毫秒内
 * 的两次写入会互相覆盖（时间戳粒度是毫秒，批量删除连续提交时完全可能撞上）。注入值只用于
 * 测试断言（函数返回值可以是字符串或数字，都会被归一成 6 位 base36 后缀）。
 *
 * @param {number} now - 毫秒时间戳（非法值退回系统时间：键的取值不承担安全性）。
 * @param {() => string|number|undefined} [random] - 随机 token 提供者；不是函数时退回 Math.random。
 * @returns {string} 满足 isBatchQueueKey 的键（长度 ≤ 96、字符集受限）。
 */
export function makeBatchQueueKey(now, random) {
  const stamp = Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();
  return BATCH_QUEUE_KEY_PREFIX + stamp.toString(36) + "-" + randomBatchToken(random);
}

/**
 * 归一随机 token（**纯函数、永不抛错**，随机源异常时退回 Math.random）。
 *
 * 三种输入形状：数字按 36 进制取值（注入 `0.5` 这类确定值便于断言）；字符串先清洗成
 * 安全字符；缺失/异常则真的取随机数。最后统一成固定 6 位：短则左补 `0`，长则取后 6 位。
 *
 * @param {unknown} random - 注入的随机源（期望是函数）。
 * @returns {string} 6 位 base36 风格 token（只含 `[a-z0-9]`）。
 */
function randomBatchToken(random) {
  let raw;
  try {
    raw = typeof random === "function" ? random() : undefined;
  } catch {
    raw = undefined;
  }
  const fallback = () => Math.abs(Math.floor(Math.random() * 36 ** BATCH_KEY_TOKEN_CHARS)).toString(36);
  let token;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    token = Math.abs(Math.floor(raw * 36 ** BATCH_KEY_TOKEN_CHARS)).toString(36);
  } else if (typeof raw === "string") {
    token = raw.toLowerCase().replace(/[^a-z0-9]/gu, "");
  } else {
    token = fallback();
  }
  if (token.length === 0) token = fallback();
  return token.length >= BATCH_KEY_TOKEN_CHARS
    ? token.slice(-BATCH_KEY_TOKEN_CHARS)
    : token.padStart(BATCH_KEY_TOKEN_CHARS, "0");
}

/** 残渣表的失败项上限与单项长度上限（残渣只是可重试记录，不是审计日志）。 */
const MAX_RESIDUE_FAILURES = 32;
const MAX_RESIDUE_FAILURE_CHARS = 200;

/**
 * 收敛日志记录（**写入边界**的严格契约）。
 *
 * `registeredAt` 是本条记录最近一次落盘的时间：状态推进时整体重写，因此它同时是
 * 「登记时间」与「最后一次状态写入时间」，不另外保存时间线。
 *
 * `sessions` 只属于**批量意图记录**（键满足 {@link isBatchQueueKey}）：它是「这些会话
 * 即将 / 已经进入删除」的**写前意图**，状态恒为 `intent`，语义等价于「每个成员各写一条
 * intent」，但把 N 次整份文档落盘压成 1 次。单会话条目的语义一字未改（必须省略该字段）；
 * 去重由写入方保证——作业的目标集合本来就已归一。
 */
export const DOMAIN_SESSION_DELETE_QUEUE_ENTRY = domainZ.object({
  status: domainZ.enum(Object.values(SESSION_DELETE_STATUS)),
  registeredAt: domainZ.number().nonnegative(),
  attempts: domainZ.number().int().nonnegative(),
  lastError: domainZ.string().min(1).max(MAX_QUEUE_ERROR_CHARS).optional(),
  /** 批量意图覆盖的会话集合（仅批量记录；单会话记录必须省略）。 */
  sessions: domainZ.array(domainZ.string().min(1)).min(1).max(MAX_BATCH_SESSIONS).optional(),
});

/**
 * 残渣记录（**写入边界**的严格契约）。
 *
 * `failures` 是失败项集合（稳定分类码或清理步骤名，不是自由文本）；`attempts` 是累计
 * 失败次数；`firstFailedAt` 是首次失败时间（后续重试不刷新它，便于判断残留时长）。
 */
export const DOMAIN_SESSION_DELETE_RESIDUE_ENTRY = domainZ.object({
  failures: domainZ.array(domainZ.string().min(1).max(MAX_RESIDUE_FAILURE_CHARS)).max(MAX_RESIDUE_FAILURES),
  attempts: domainZ.number().int().nonnegative(),
  firstFailedAt: domainZ.number().nonnegative(),
});

/**
 * durable 表值 schema：只要求「JSON 对象」（理由见模块头注释）。
 *
 * `object({}).passthrough()` 刻意保留未知字段：external 篡改或未来字段不该让整份文档打不开，
 * 语义解释统一交给读取面的归一函数。
 */
export const DOMAIN_SESSION_DELETE_RECORD = domainZ.object({}).passthrough();

/**
 * 把一条收敛日志记录归一成决策 8 允许的语义（**纯函数、永不抛错**）。
 *
 * - 未知状态 / 缺失状态 / 非对象记录 → `intent`（唯一与「不知道发生过什么」相容的状态）；
 * - `attempts` 非法 → 0（重试计数只影响诊断，不参与安全性）；
 * - `registeredAt` 非法 → 省略（绝不补 0：0 会被误读成「早已登记」）；
 * - `lastError` 非法 → 省略，合法值按上限截断；
 * - `sessions` 非法 / 为空 → 省略；合法值只保留非空字符串、去重、按上限截断。
 * - `sessionsIncomplete` 只在**成员集合真的丢了东西**时出现（有非法成员被丢弃，或合法唯一
 *   成员数超过上限被截断）；纯重复项不算。收敛期据此禁止孤儿清扫——被丢掉的成员其隔离
 *   目录仍在磁盘上，用不完整集合去清扫会把它们当孤儿删掉。
 *
 * @param {unknown} raw - 表里读到的原始值。
 * @returns {{status: string, attempts: number, registeredAt?: number, lastError?: string,
 *   sessions?: string[], sessionsIncomplete?: boolean, degraded: boolean}} 归一记录；
 *   `degraded` 表示原始值不能按契约解释。
 */
export function normalizeQueueRecord(raw) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  const knownStatus = source !== undefined && Object.values(SESSION_DELETE_STATUS).includes(source.status);
  const status = knownStatus ? source.status : SESSION_DELETE_STATUS.INTENT;
  const attempts = Number.isInteger(source?.attempts) && source.attempts >= 0 ? source.attempts : 0;
  const registeredAt = Number.isFinite(source?.registeredAt) && source.registeredAt >= 0
    ? source.registeredAt
    : undefined;
  const lastError = typeof source?.lastError === "string" && source.lastError.length > 0
    ? source.lastError.slice(0, MAX_QUEUE_ERROR_CHARS)
    : undefined;
  const normalizedSessions = normalizeQueueSessions(source?.sessions);
  return {
    status,
    attempts,
    ...(registeredAt === undefined ? {} : { registeredAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(normalizedSessions.sessions === undefined ? {} : { sessions: normalizedSessions.sessions }),
    ...(normalizedSessions.incomplete === true ? { sessionsIncomplete: true } : {}),
    // 只有「状态可解释且关键字段齐全」才算未降级；未知状态本身就是降级信号。
    degraded: source === undefined || knownStatus !== true || registeredAt === undefined,
  };
}

/**
 * 归一批量意图的成员集合（**纯函数、永不抛错**）。
 *
 * 只保留非空字符串、去重、上限 200 条；空集合省略该字段（不是「空数组」）。
 * 单条成员本身不做 ID 合法性校验（非法成员由收敛期逐条 fail-closed，那是收敛的职责）。
 *
 * 返回值带 `incomplete`：只要有成员被丢弃或截断就是 true。为什么必须显式报出来：收敛期
 * 用这份集合决定「哪些隔离目录仍有归属」，不完整的集合会让漏掉的成员被当成孤儿删掉；
 * 纯重复项只是冗余，不算丢失。
 *
 * @param {unknown} raw - 原始 sessions 字段。
 * @returns {{sessions: string[]|undefined, incomplete: boolean}} 归一后的成员集合与是否不完整。
 */
function normalizeQueueSessions(raw) {
  if (!Array.isArray(raw)) return { sessions: undefined, incomplete: false };
  const sessions = [];
  const seen = new Set();
  let incomplete = false;
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) {
      incomplete = true;
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (sessions.length >= MAX_BATCH_SESSIONS) {
      // 已达上限且出现了新的唯一成员：集合被截断，调用方不得据此做孤儿清扫。
      incomplete = true;
      break;
    }
    sessions.push(entry);
  }
  return { sessions: sessions.length === 0 ? undefined : sessions, incomplete };
}

/**
 * 把一条残渣记录归一（**纯函数、永不抛错**）。
 *
 * 残渣只是「下次启动再试一次」的恢复记录，无法解释时直接返回 null，由读取面把它算作
 * 非法键：收敛流程可以安全地忽略它（残渣不影响任何破坏性动作的判定）。
 *
 * @param {unknown} raw - 表里读到的原始值。
 * @returns {{failures: string[], attempts: number, firstFailedAt: number}|null} 归一记录或 null。
 */
export function normalizeResidueRecord(raw) {
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
  if (source === undefined) return null;
  const attempts = source.attempts;
  const firstFailedAt = source.firstFailedAt;
  if (!Number.isInteger(attempts) || attempts < 0) return null;
  if (!Number.isFinite(firstFailedAt) || firstFailedAt < 0) return null;
  const failures = Array.isArray(source.failures)
    ? source.failures
      .filter((entry) => typeof entry === "string" && entry.length > 0)
      .map((entry) => entry.slice(0, MAX_RESIDUE_FAILURE_CHARS))
      .slice(0, MAX_RESIDUE_FAILURES)
    : [];
  return { failures, attempts, firstFailedAt };
}
