/**
 * 会话删除的两张表读写原语（票据 01）。
 *
 * ## 职责边界
 * 只回答「这两张表怎么读、怎么写、怎么枚举」，不做任何删除判定、收敛决策或清理动作
 * （那是票据 02/03/04）。因此这里的每个函数都可以被闸门查询与收敛流程直接复用。
 *
 * ## 三条硬约束（规格决策 8）
 * 1. **写入走宿主的存储域写入口**：`table.put` / `table.delete` 由 storage domain 串行化，
 *    底层是「临时文件 + rename」的原子落盘；本模块不自己写文件，也不缓存第二份真相。
 * 2. **枚举只读一次文档**：`readQueue` / `readResidue` 各调用一次 `entries()` 并建集合，
 *    绝不对每个候选会话逐条读表。
 * 3. **写入边界严格、读取面显式降级**：写之前用严格 zod 校验（非法记录落不了盘）；
 *    读的时候未知状态按 `intent` 归一、无法解释的键单独报出（见 session-delete-contract）。
 *
 * ## 表句柄从哪来
 * 组合根把 `domain` 句柄挂在 storage binding 上（`storageBinding.install(binding, { domain, ... })`），
 * 表句柄通过 `binding.domain.table(name)` 按名解析：这样新增两张表不需要改动既有绑定装配，
 * 也不会与 `session_overrides` 等既有表的读取面互相牵连。
 *
 * @module dsh-expert-group/host/session-delete-store
 */
import { persistDomainEntry, removeDomainEntry } from "../storage.js";
import {
  DOMAIN_SESSION_DELETE_QUEUE_ENTRY,
  DOMAIN_SESSION_DELETE_RESIDUE_ENTRY,
  SESSION_DELETE_QUEUE_TABLE,
  SESSION_DELETE_RESIDUE_TABLE,
  normalizeQueueRecord,
  normalizeResidueRecord,
} from "./session-delete-contract.js";

/** 读写原语的稳定失败原因码（会作为 `error.code` 抛出或被返回）。 */
export const SESSION_DELETE_STORE_REASONS = Object.freeze({
  /** storage domain 未就绪 / 表不可读：此时任何判定都必须 fail-closed。 */
  STORAGE_UNAVAILABLE: "delete-store-unavailable",
  /** 写入边界拒绝：记录不符合表契约。 */
  INVALID_RECORD: "delete-store-invalid-record",
  /** 写入期间 binding 被替换（宿主重载 storage domain）：结果未知，按失败处理。 */
  GENERATION_STALE: "delete-store-generation-stale",
});

/** 两张表的内部标识（避免把表名散落在分支里）。 */
const QUEUE = "queue";
const RESIDUE = "residue";

/** 构造带稳定 `code` 的失败错误（不把 zod 的原始 issue 文本带进用户可见路径）。 */
function storeError(reason, cause) {
  const error = cause === undefined
    ? new Error("session delete store: " + reason)
    : new Error("session delete store: " + reason, { cause });
  error.code = reason;
  return error;
}

/** 表名 → 绑定的 domain 表句柄；未就绪/未声明时返回 undefined（调用方按不可读处理）。 */
function tableOf(binding, tableName) {
  if (binding === null || typeof binding !== "object" || binding.domain === undefined || binding.domain === null) {
    return undefined;
  }
  try {
    return binding.domain.table(tableName);
  } catch {
    return undefined;
  }
}

/** 一次读尽整张表（唯一允许的 `entries()` 调用点：枚举与单条读都走它）。 */
function readEntries(table) {
  try {
    return [...table.entries()];
  } catch {
    return undefined;
  }
}

/**
 * 创建会话删除的两张表读写原语。
 *
 * @param {object} deps - 窄能力面（不接收 ctx、不读全局状态）。
 * @param {() => object|undefined} deps.getBinding - 当前 storage binding（未就绪返回 undefined）。
 * @param {(binding: object) => boolean} deps.isCurrent - binding 代次判定。
 * @param {(task: Function) => Promise<unknown>} deps.enqueueWrite - 宿主写串行链入口。
 * @returns {object} 读写能力面（单条读/写/删、整表枚举、文档可解析性描述）。
 */
export function installSessionDeleteStore({ getBinding, isCurrent, enqueueWrite }) {
  /** 读取一张表的归一快照；不可读时返回带原因码的失败形状。 */
  function readTable(kind) {
    const tableName = kind === QUEUE ? SESSION_DELETE_QUEUE_TABLE : SESSION_DELETE_RESIDUE_TABLE;
    const table = tableOf(getBinding(), tableName);
    if (table === undefined) return { readable: false, reason: SESSION_DELETE_STORE_REASONS.STORAGE_UNAVAILABLE };
    const entries = readEntries(table);
    if (entries === undefined) return { readable: false, reason: SESSION_DELETE_STORE_REASONS.STORAGE_UNAVAILABLE };
    const keys = [];
    const records = new Map();
    // 降级/无法解释的键：收敛流程据此逐条 fail-closed（不清理、保留记录、写诊断）。
    const invalidKeys = [];
    for (const [key, raw] of entries) {
      if (typeof key !== "string" || key.length === 0) continue;
      keys.push(key);
      if (kind === QUEUE) {
        const record = normalizeQueueRecord(raw);
        records.set(key, record);
        if (record.degraded === true) invalidKeys.push(key);
        continue;
      }
      const record = normalizeResidueRecord(raw);
      if (record === null) {
        invalidKeys.push(key);
        continue;
      }
      records.set(key, record);
    }
    return { readable: true, keys, records, invalidKeys };
  }

  /** 写入一张表的一条记录：严格校验 → 写串行链 → 宿主原子落盘。 */
  async function writeEntry(kind, sessionId, entry) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw storeError(SESSION_DELETE_STORE_REASONS.INVALID_RECORD);
    }
    const schema = kind === QUEUE ? DOMAIN_SESSION_DELETE_QUEUE_ENTRY : DOMAIN_SESSION_DELETE_RESIDUE_ENTRY;
    let value;
    try {
      value = schema.parse(entry);
    } catch (error) {
      throw storeError(SESSION_DELETE_STORE_REASONS.INVALID_RECORD, error);
    }
    await enqueueWrite(async () => {
      const binding = getBinding();
      const table = tableOf(binding, kind === QUEUE ? SESSION_DELETE_QUEUE_TABLE : SESSION_DELETE_RESIDUE_TABLE);
      if (table === undefined) throw storeError(SESSION_DELETE_STORE_REASONS.STORAGE_UNAVAILABLE);
      const result = await persistDomainEntry({
        table,
        key: sessionId,
        value,
        isCurrent: () => binding !== undefined && isCurrent(binding) === true,
      });
      if (result.detached === true) throw storeError(SESSION_DELETE_STORE_REASONS.GENERATION_STALE);
    });
    return true;
  }

  /** 删除一张表的一条记录（缺失即成功：幂等）。 */
  async function deleteEntry(kind, sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw storeError(SESSION_DELETE_STORE_REASONS.INVALID_RECORD);
    }
    await enqueueWrite(async () => {
      const binding = getBinding();
      const table = tableOf(binding, kind === QUEUE ? SESSION_DELETE_QUEUE_TABLE : SESSION_DELETE_RESIDUE_TABLE);
      if (table === undefined) throw storeError(SESSION_DELETE_STORE_REASONS.STORAGE_UNAVAILABLE);
      const result = await removeDomainEntry({
        table,
        key: sessionId,
        isCurrent: () => binding !== undefined && isCurrent(binding) === true,
      });
      if (result.detached === true) throw storeError(SESSION_DELETE_STORE_REASONS.GENERATION_STALE);
    });
    return true;
  }

  return Object.freeze({
    /** 枚举全部收敛日志（一次读文档）：{readable, keys, records, invalidKeys}。 */
    readQueue: () => readTable(QUEUE),
    /** 枚举全部残渣（一次读文档）：{readable, keys, records, invalidKeys}。 */
    readResidue: () => readTable(RESIDUE),
    /**
     * 按会话 ID 读一条收敛日志。
     *
     * `present` 以**键是否存在**为准（不是「记录是否合法」）：队列里还有这个键就代表这次删除
     * 尚未收敛完成，闸门必须因此拒绝新作业。
     */
    readQueueEntry(sessionId) {
      const snapshot = readTable(QUEUE);
      if (snapshot.readable !== true) return { readable: false, present: false, reason: snapshot.reason };
      const present = snapshot.keys.includes(sessionId);
      return {
        readable: true,
        present,
        entry: present ? snapshot.records.get(sessionId) : undefined,
        degraded: present && snapshot.invalidKeys.includes(sessionId),
      };
    },
    /** 按会话 ID 读一条残渣（用于诊断与重试）。 */
    readResidueEntry(sessionId) {
      const snapshot = readTable(RESIDUE);
      if (snapshot.readable !== true) return { readable: false, present: false, reason: snapshot.reason };
      const present = snapshot.keys.includes(sessionId);
      return { readable: true, present, entry: present ? snapshot.records.get(sessionId) : undefined };
    },
    writeQueueEntry: (sessionId, entry) => writeEntry(QUEUE, sessionId, entry),
    deleteQueueEntry: (sessionId) => deleteEntry(QUEUE, sessionId),
    writeResidueEntry: (sessionId, entry) => writeEntry(RESIDUE, sessionId, entry),
    deleteResidueEntry: (sessionId) => deleteEntry(RESIDUE, sessionId),
    /**
     * 收敛文档可解析性描述（启动探测第五项）。
     *
     * 只有「两张表都读得出来」才算文档可解析：整份聚合文档打不开时 storage binding 本身
     * 就不会 ready，两条都会是 false；单表读失败同样意味着收敛无法开始。
     */
    describeDocument() {
      const queue = readTable(QUEUE);
      const residue = readTable(RESIDUE);
      const readable = queue.readable === true && residue.readable === true;
      return {
        readable,
        reason: readable ? undefined : (queue.reason ?? residue.reason),
        queueCount: queue.keys?.length ?? 0,
        residueCount: residue.keys?.length ?? 0,
        degradedKeys: [...(queue.invalidKeys ?? []), ...(residue.invalidKeys ?? [])].length,
      };
    },
  });
}
