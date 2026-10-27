/**
 * 会话删除（票据 01）的两张表与其记录契约。
 *
 * ## 两张表
 * - **删除收敛日志**（`session_delete_queue`）：写前意图与待收敛队列的合一。键 = 会话 ID，
 *   值 = 状态（intent / cleanup / race）、登记时间、尝试次数、最近失败原因；
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

/** 残渣表的失败项上限与单项长度上限（残渣只是可重试记录，不是审计日志）。 */
const MAX_RESIDUE_FAILURES = 32;
const MAX_RESIDUE_FAILURE_CHARS = 200;

/**
 * 收敛日志记录（**写入边界**的严格契约）。
 *
 * `registeredAt` 是本条记录最近一次落盘的时间：状态推进时整体重写，因此它同时是
 * 「登记时间」与「最后一次状态写入时间」，不另外保存时间线。
 */
export const DOMAIN_SESSION_DELETE_QUEUE_ENTRY = domainZ.object({
  status: domainZ.enum(Object.values(SESSION_DELETE_STATUS)),
  registeredAt: domainZ.number().nonnegative(),
  attempts: domainZ.number().int().nonnegative(),
  lastError: domainZ.string().min(1).max(MAX_QUEUE_ERROR_CHARS).optional(),
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
 * - `lastError` 非法 → 省略，合法值按上限截断。
 *
 * @param {unknown} raw - 表里读到的原始值。
 * @returns {{status: string, attempts: number, registeredAt?: number, lastError?: string,
 *   degraded: boolean}} 归一记录；`degraded` 表示原始值不能按契约解释。
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
  return {
    status,
    attempts,
    ...(registeredAt === undefined ? {} : { registeredAt }),
    ...(lastError === undefined ? {} : { lastError }),
    // 只有「状态可解释且关键字段齐全」才算未降级；未知状态本身就是降级信号。
    degraded: source === undefined || knownStatus !== true || registeredAt === undefined,
  };
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
