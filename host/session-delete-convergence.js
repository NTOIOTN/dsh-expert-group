/**
 * 会话删除的**收敛期**（票据 03 · 阶段二，规格决策 8/10/13–16）。
 *
 * ## 只在插件启动时执行一次
 * 收敛是「上一次删除没做完的收尾」，不是删除作业的一部分（决策 13）：作业期只把日志原子改名
 * 进隔离区并登记条目，其余清理全部推迟到这里。安全判据是**原始路径上的日志是否还在**，
 * 不做 live 检查、不等任何就绪信号——宿主只能从持久化清单加载会话，日志不在的会话根本打不开，
 * 所以收敛顺序与宿主的会话恢复顺序无关（ADR 0011 的「关键边界二」）。
 *
 * ## 六分支判定（状态 × 日志是否存在）
 * | 状态 | 日志存在 | 分支 | 动作 |
 * |---|---|---|---|
 * | `intent`（含未知状态 / 记录体非法） | 是 | SETTLE_ONLY | 先收尾隔离目录，再丢弃条目 |
 * | `intent` | 否 | FULL_CLEANUP | 完整清理 |
 * | `cleanup` / `race` | 否 | FULL_CLEANUP | 完整清理 |
 * | `cleanup` / `race` | 是 | PRESERVE_SESSION | 保留会话与数据，删隔离区旧日志，丢条目并记诊断 |
 * | 键非法 / 日志状态判不了 | — | FAIL_CLOSED | 不清理、不改文件、保留条目并写诊断 |
 *
 * 「`intent` + 日志存在」这一格同时覆盖两种崩溃：崩在改名之前，以及**改名成功但竞态状态
 * 推进失败**（票据 02 的 S5）。两者的处置相同——先收尾该会话的隔离目录（删掉旧代际文件），
 * 再丢弃条目；原路径上的日志是新代际内容，绝不触碰。
 *
 * ## 持久化顺序（决策 16，固定不变）
 * 1. 执行该分支要求的清理（只有完整清理分支才有）；
 * 2. 收尾该会话的隔离目录（缺失即成功）——两类分支共用，是**唯一**的隔离文件收尾步骤；
 * 3. 有失败项 → **先**写残渣并确认落盘；残渣落盘失败则保留条目（宁可重复清理，不可丢恢复记录）；
 * 4. 以上都成功后，才删除收敛日志条目。
 *
 * 任一步崩溃都只意味着「条目还在」：下次启动重复执行（每一步都幂等），因此不会出现
 * 「队列已删但清理未完成」的永久孤儿，也不会留下无引用的隔离文件。
 *
 * ## 文档不可解析 = 整体暂停
 * 存储域是「一个域一份聚合文档」，读不懂文档就拿不到**任何**一条记录（决策 8）。因此
 * `store.readQueue()` 报不可读时本模块什么都不做：不修改文件、不清理、保留全部条目，
 * 只写一条诊断；删除入口的不可用由启动探测与闸门另外保证。
 *
 * @module dsh-expert-group/host/session-delete-convergence
 */
import { isSafeSessionId } from "./session-delete-cleanup.js";
import { SESSION_DELETE_STATUS } from "./session-delete-contract.js";
import { SESSION_LOG_RESOLVE_FAILURES } from "./session-delete-paths.js";

/** 收敛期的稳定原因码（进入诊断，可展示、可断言；不含路径与堆栈）。 */
export const SESSION_DELETE_CONVERGENCE_REASONS = Object.freeze({
  /** 收敛文档不可解析：整体暂停（不修改文件、不清理、删除入口不可用）。 */
  QUEUE_UNREADABLE: "delete-queue-unreadable",
  /** 会话清单读不出来：判不了任何条目的日志状态，整体暂停。 */
  HEADERS_UNREADABLE: "delete-headers-unreadable",
  /** 单个条目的日志状态判不了（定位失败）：该条 fail-closed 并保留。 */
  LOG_STATE_UNKNOWN: "delete-log-state-unknown",
  /** 键不是合法会话身份：该条 fail-closed（不清理、保留记录）。 */
  INVALID_SESSION_ID: "delete-session-id-invalid",
  /** 记录体非法或状态未知但键可读：按 intent 处理（诊断只为可观测性）。 */
  RECORD_DEGRADED: "delete-queue-record-degraded",
  /** 日志被重新写入：保留会话与数据（「删除未完成，内容已保留」）。 */
  SESSION_PRESERVED: "delete-incomplete-content-preserved",
  /** 残渣落盘失败：保留收敛日志条目。 */
  RESIDUE_WRITE_FAILED: "delete-residue-write-failed",
  /** 删除收敛日志条目失败：条目仍在，下次启动重试（幂等）。 */
  QUEUE_DROP_FAILED: "delete-queue-entry-drop-failed",
  /** 删除已完成会话的残渣条目失败（只是诊断，由孤儿残渣清扫兜底）。 */
  RESIDUE_DROP_FAILED: "delete-residue-entry-drop-failed",
});

/** 四类分支（六种「状态 × 日志存在」组合都映射到它们；见模块头注释的表格）。 */
export const CONVERGENCE_BRANCHES = Object.freeze({
  /** 只收尾隔离目录后丢弃条目（日志仍在原路径）。 */
  SETTLE_ONLY: "settle-only",
  /** 保留会话与数据、删隔离区旧日志、丢弃条目并记诊断。 */
  PRESERVE_SESSION: "preserve-session",
  /** 完整清理：记账、集合、派生缓存、DEG 数据 + 收尾隔离目录。 */
  FULL_CLEANUP: "full-cleanup",
  /** 该条 fail-closed：不清理、不改文件、保留条目并写诊断。 */
  FAIL_CLOSED: "fail-closed",
});

/** 单个条目的收敛结局。 */
export const CONVERGENCE_OUTCOMES = Object.freeze({
  /** 清理与收尾都成功，条目已删除。 */
  CONVERGED: "converged",
  /** 有失败项（或条目删除失败）：残渣已记、条目保留，下次启动重试。 */
  RETAINED: "retained",
  /** 判不了身份/日志状态：条目保留、什么都没动。 */
  BLOCKED: "blocked",
});

/** 崩溃注入钩子名（测试专用；生产装配不提供）。 */
export const CONVERGENCE_HOOKS = Object.freeze({
  /** 清理步骤执行之前。 */
  BEFORE_CLEANUP: "beforeCleanup",
  /** 清理步骤执行之后、隔离目录收尾之前。 */
  AFTER_CLEANUP: "afterCleanup",
  /** 隔离目录收尾之后、残渣落盘之前。 */
  BEFORE_RESIDUE: "beforeResidue",
  /** 删除收敛日志条目之前。 */
  BEFORE_DROP_ENTRY: "beforeDropEntry",
});

/** 残渣表的失败项上限（与 session-delete-contract 的写入边界一致）。 */
const MAX_RESIDUE_FAILURES = 32;

/**
 * 隔离区收尾失败的失败项码。
 *
 * 它是残渣里唯一不属于「清理步骤」的失败项：收尾是两类分支共用的第 2 步，因此单独命名，
 * 不与清理步骤码混在一起（诊断上要能一眼区分「数据没清掉」与「旧日志没收尾」）。
 */
const QUARANTINE_SETTLE_FAILURE = "quarantine-settle";

/** 诊断条目上限（收敛是后台动作，诊断只需要能解释失败，不做审计日志）。 */
const MAX_DIAGNOSTICS = 128;

/**
 * 六分支判定的**唯一实现**（纯函数，测试直接锁规则）。
 *
 * @param {object} params
 * @param {unknown} params.status - 收敛日志记录里的状态（未知/缺失按 `intent`）。
 * @param {unknown} params.logExists - 原始路径上的日志是否存在（true / false / 未知）。
 * @returns {{branch: string, runCleanup: boolean, settleQuarantine: boolean,
 *   preserveSession: boolean, diagnostic?: string}} 分支动作描述。
 */
export function decideConvergenceBranch({ status, logExists }) {
  if (logExists !== true && logExists !== false) {
    return {
      branch: CONVERGENCE_BRANCHES.FAIL_CLOSED,
      runCleanup: false,
      settleQuarantine: false,
      preserveSession: true,
    };
  }
  // 未知状态 / 记录体非法 → 按 intent：它是唯一与「不知道发生过什么」相容的状态。
  const known = status === SESSION_DELETE_STATUS.CLEANUP || status === SESSION_DELETE_STATUS.RACE
    ? status
    : SESSION_DELETE_STATUS.INTENT;
  if (logExists === true) {
    return known === SESSION_DELETE_STATUS.INTENT
      ? {
        branch: CONVERGENCE_BRANCHES.SETTLE_ONLY,
        runCleanup: false,
        settleQuarantine: true,
        preserveSession: false,
      }
      : {
        branch: CONVERGENCE_BRANCHES.PRESERVE_SESSION,
        runCleanup: false,
        settleQuarantine: true,
        preserveSession: true,
        diagnostic: SESSION_DELETE_CONVERGENCE_REASONS.SESSION_PRESERVED,
      };
  }
  return {
    branch: CONVERGENCE_BRANCHES.FULL_CLEANUP,
    runCleanup: true,
    settleQuarantine: true,
    preserveSession: false,
  };
}

/** 读时钟：只接受有限非负数，否则退回系统时间（记录时间不承担安全性）。 */
function readNow(clock) {
  try {
    const now = clock?.now?.();
    return Number.isFinite(now) && now >= 0 ? now : Date.now();
  } catch {
    return Date.now();
  }
}

/** 读会话清单；抛错/形状非法都折算成「读不出来」。 */
async function readHeadersOf(logs) {
  try {
    const headers = await logs.readHeaders();
    return Array.isArray(headers) ? headers : undefined;
  } catch {
    return undefined;
  }
}

/** 会话 ID → header（身份取自 header.id，非字符串/空串一律忽略）。 */
function indexHeaders(headers) {
  const map = new Map();
  for (const header of headers ?? []) {
    const id = header !== null && typeof header === "object" ? header.id : undefined;
    if (typeof id !== "string" || id.length === 0) continue;
    map.set(id, header);
  }
  return map;
}

/** 收敛日志快照；读失败按「文档不可解析」处理（整体暂停）。 */
function readQueueOf(store) {
  try {
    const snapshot = store.readQueue();
    if (snapshot !== null && typeof snapshot === "object") return snapshot;
  } catch {
    // 落到下面的不可读结论：读不懂文档就不能清理任何一条。
  }
  return { readable: false, reason: SESSION_DELETE_CONVERGENCE_REASONS.QUEUE_UNREADABLE };
}

/** 残渣快照；读失败按「没有残渣」处理（残渣只影响诊断与合并计数，不参与安全判定）。 */
function readResidueOf(store) {
  try {
    const snapshot = store.readResidue();
    if (snapshot?.readable === true && snapshot.records instanceof Map) return snapshot;
  } catch {
    // 残渣读失败不影响本轮收敛：写入时按「首次失败」记录。
  }
  return { readable: false, keys: [], records: new Map() };
}

/**
 * 判定单个会话「原始路径上的日志是否存在」。
 *
 * 三级口径（与作业期的 absent 判定同一套事实）：
 * 1. 持久化清单里没有这个会话 → **没有日志**（宿主只能从清单加载会话）；
 * 2. 定位成功 → 有日志；
 * 3. 目录不存在 / 目录里没有日志文件 → 没有日志；其余定位失败 → **判不了**（fail-closed）。
 *
 * @param {string} sessionId - 会话 ID。
 * @param {Map} headers - 会话 ID → header。
 * @param {object} logs - 日志端口。
 * @returns {Promise<object>} `{known, exists, reason}` 判定结果。
 */
async function readLogState(sessionId, headers, logs) {
  const header = headers.get(sessionId);
  if (header === undefined) return { known: true, exists: false };
  let resolution;
  try {
    resolution = await logs.resolve(header);
  } catch {
    return { known: false, exists: true, reason: SESSION_DELETE_CONVERGENCE_REASONS.LOG_STATE_UNKNOWN };
  }
  if (resolution?.ok === true) return { known: true, exists: true };
  const reason = resolution?.reason;
  if (reason === SESSION_LOG_RESOLVE_FAILURES.DIRECTORY_MISSING
    || reason === SESSION_LOG_RESOLVE_FAILURES.LOG_MISSING) {
    return { known: true, exists: false };
  }
  return {
    known: false,
    exists: true,
    reason: SESSION_DELETE_CONVERGENCE_REASONS.LOG_STATE_UNKNOWN,
  };
}

/** 合并残渣记录：失败项取并集（有界）、次数累加、首次失败时间只保留最早的一次。 */
function mergeResidue(previous, failures, now) {
  const merged = [];
  for (const code of [...(previous?.failures ?? []), ...failures]) {
    if (typeof code !== "string" || code.length === 0 || merged.includes(code)) continue;
    merged.push(code);
    if (merged.length >= MAX_RESIDUE_FAILURES) break;
  }
  const attempts = (Number.isInteger(previous?.attempts) ? previous.attempts : 0) + 1;
  const firstFailedAt = Number.isFinite(previous?.firstFailedAt) ? previous.firstFailedAt : now;
  return { failures: merged, attempts, firstFailedAt };
}

/**
 * 创建收敛能力面。
 *
 * @param {object} deps - 窄能力面（本模块不读 ctx、不碰文件系统、不拼路径）。
 * @param {object} deps.store - 票据 01 的两张表读写原语（见 host/session-delete-store）。
 * @param {object} deps.logs - 会话事实端口 `{readHeaders, resolve}`。
 * @param {object} deps.cleanup - 票据 03 的清理步骤能力面（返回失败项码数组）。
 * @param {object} deps.quarantine - 隔离区收尾端口 `{settle}`。
 * @param {object} [deps.clock] - 只读时钟（记录残渣时间）。
 * @param {object} [deps.hooks] - 崩溃注入钩子（生产装配不提供）。
 * @param {object} [deps.logger] - 诊断日志出口（只记原因码）。
 * @returns {object} `{run, snapshot, markPaused}` 收敛能力面。
 */
export function installSessionDeleteConvergence({ store, logs, cleanup, quarantine, clock, hooks, logger }) {
  let completed = null;
  let inFlight = null;
  let pausedReason = null;

  function snapshot() {
    if (pausedReason !== null) {
      return {
        ran: true,
        paused: true,
        reason: pausedReason,
        queueCount: 0,
        counts: { converged: 0, retained: 0, blocked: 0 },
        entries: [],
      };
    }
    return completed ?? { ran: false, paused: false };
  }

  /** 记录一次「整体暂停」结论（等待超时等外部路径使用）。 */
  function markPaused(reason) {
    if (pausedReason !== null) return snapshot();
    pausedReason = typeof reason === "string" && reason.length > 0
      ? reason
      : SESSION_DELETE_CONVERGENCE_REASONS.QUEUE_UNREADABLE;
    return snapshot();
  }

  /** 调用崩溃注入钩子：钩子抛错原样上抛（等同于进程在这一点消失）。 */
  function invokeHook(stage, context) {
    const hook = hooks?.[stage];
    if (typeof hook !== "function") return;
    hook(context);
  }

  /** 诊断只进诊断数组（不写残渣）：它不是恢复记录，也不该影响条目去留。 */
  function recordDiagnostic(diagnostics, code) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push({ code });
  }

  /** 收尾该会话的隔离目录（缺失即成功）；失败项进 failures。 */
  async function settleQuarantineOf(sessionId, failures) {
    let outcome;
    try {
      outcome = await quarantine.settle(sessionId);
    } catch {
      failures.push(QUARANTINE_SETTLE_FAILURE);
      return;
    }
    if (outcome?.settled === false) failures.push(QUARANTINE_SETTLE_FAILURE);
  }

  /** 执行完整清理；失败项合并进 failures（清理端口抛错同样记失败，不中断收敛）。 */
  async function runCleanupOf(sessionId, failures) {
    try {
      const codes = await cleanup.run(sessionId);
      if (Array.isArray(codes)) {
        for (const code of codes) {
          if (typeof code === "string" && code.length > 0) failures.push(code);
        }
      }
    } catch {
      failures.push("cleanup-failed");
    }
  }

  /**
   * 写残渣并持久化成功后才允许继续（决策 16 第 3 步）。
   *
   * @returns {Promise<boolean>} 落盘成功返回 true；false 表示必须保留收敛日志条目。
   */
  async function persistResidue(sessionId, failures, residueRecords, diagnostics) {
    const entry = mergeResidue(residueRecords.get(sessionId), failures, readNow(clock));
    try {
      await store.writeResidueEntry(sessionId, entry);
      return true;
    } catch {
      recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.RESIDUE_WRITE_FAILED);
      return false;
    }
  }

  /** 删除一条表记录；失败只记诊断（条目留下 = 下次启动重试，幂等）。 */
  async function dropQuietly(drop, diagnostics, failureCode) {
    try {
      await drop();
      return true;
    } catch {
      recordDiagnostic(diagnostics, failureCode);
      return false;
    }
  }

  /** 判不了身份或日志状态时的统一结论（不清理、不改文件、保留条目）。 */
  function blockedEntry(sessionId, code, diagnostics) {
    return {
      sessionId,
      branch: CONVERGENCE_BRANCHES.FAIL_CLOSED,
      outcome: CONVERGENCE_OUTCOMES.BLOCKED,
      failures: [],
      diagnostics: [...diagnostics, { code }],
    };
  }

  /**
   * 收敛单个条目（决策 14 的分支 + 决策 16 的固定顺序）。
   *
   * @param {string} sessionId - 队列表的键。
   * @param {object|undefined} record - 归一后的队列记录。
   * @param {object} context - 本轮快照：`{headers, residueRecords}`。
   * @returns {Promise<object>} 单条收敛结论。
   */
  async function convergeEntry(sessionId, record, context) {
    const diagnostics = [];
    // 键非法 → 该条 fail-closed：不清理、不改文件、保留记录并写诊断，其余条目照常。
    if (isSafeSessionId(sessionId) !== true) {
      return blockedEntry(sessionId, SESSION_DELETE_CONVERGENCE_REASONS.INVALID_SESSION_ID, diagnostics);
    }
    if (record?.degraded === true) {
      recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.RECORD_DEGRADED);
    }
    const logState = await readLogState(sessionId, context.headers, logs);
    if (logState.known !== true) {
      return blockedEntry(
        sessionId,
        logState.reason ?? SESSION_DELETE_CONVERGENCE_REASONS.LOG_STATE_UNKNOWN,
        diagnostics,
      );
    }
    const decision = decideConvergenceBranch({ status: record?.status, logExists: logState.exists });
    if (decision.diagnostic !== undefined) recordDiagnostic(diagnostics, decision.diagnostic);

    const failures = [];
    if (decision.runCleanup === true) {
      invokeHook(CONVERGENCE_HOOKS.BEFORE_CLEANUP, { sessionId });
      await runCleanupOf(sessionId, failures);
      invokeHook(CONVERGENCE_HOOKS.AFTER_CLEANUP, { sessionId, failures: [...failures] });
    }
    if (decision.settleQuarantine === true) await settleQuarantineOf(sessionId, failures);

    // 有失败项：先把失败写进残渣并确认落盘，然后保留条目（下次启动重试）。
    if (failures.length > 0) {
      invokeHook(CONVERGENCE_HOOKS.BEFORE_RESIDUE, { sessionId, failures: [...failures] });
      await persistResidue(sessionId, failures, context.residueRecords, diagnostics);
      return { sessionId, branch: decision.branch, outcome: CONVERGENCE_OUTCOMES.RETAINED, failures, diagnostics };
    }

    // 全部成功：先清掉自己的残渣（只是诊断记录），最后才删除收敛日志条目。
    if (context.residueRecords.has(sessionId)) {
      await dropQuietly(
        () => store.deleteResidueEntry(sessionId),
        diagnostics,
        SESSION_DELETE_CONVERGENCE_REASONS.RESIDUE_DROP_FAILED,
      );
    }
    invokeHook(CONVERGENCE_HOOKS.BEFORE_DROP_ENTRY, { sessionId });
    const dropped = await dropQuietly(
      () => store.deleteQueueEntry(sessionId),
      diagnostics,
      SESSION_DELETE_CONVERGENCE_REASONS.QUEUE_DROP_FAILED,
    );
    return {
      sessionId,
      branch: decision.branch,
      outcome: dropped ? CONVERGENCE_OUTCOMES.CONVERGED : CONVERGENCE_OUTCOMES.RETAINED,
      failures: [],
      diagnostics,
    };
  }

  /**
   * 孤儿残渣清扫：残渣条目在对应收敛条目消失后即无意义（条目只会因失败而保留）。
   *
   * 它覆盖「条目已删、残渣没删掉」的崩溃窗口；不清会让残渣表无限增长。
   */
  async function sweepOrphanResidues(queueKeys, residue, diagnostics) {
    let removed = 0;
    const remaining = new Set(queueKeys);
    for (const sessionId of residue.keys ?? []) {
      if (remaining.has(sessionId)) continue;
      try {
        await store.deleteResidueEntry(sessionId);
        removed += 1;
      } catch {
        recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.RESIDUE_DROP_FAILED);
      }
    }
    return removed;
  }

  /** 汇总本轮收敛结论（守恒：converged + retained + blocked = 队列条目数）。 */
  function summarize(entries, orphanResiduesRemoved, diagnostics) {
    const counts = { converged: 0, retained: 0, blocked: 0 };
    for (const entry of entries) {
      if (entry.outcome === CONVERGENCE_OUTCOMES.CONVERGED) counts.converged += 1;
      else if (entry.outcome === CONVERGENCE_OUTCOMES.RETAINED) counts.retained += 1;
      else counts.blocked += 1;
    }
    return {
      ran: true,
      paused: false,
      queueCount: entries.length,
      counts,
      orphanResiduesRemoved,
      entries,
      diagnostics,
    };
  }

  /**
   * 整体暂停结论：不修改任何文件、不清理任何条目。
   *
   * `reason` 固定取本模块自己的稳定码（而不是底层 store 的原因码）：调用方与诊断投影
   * 需要一个不随存储实现变化的判据；底层原因作为诊断 detail 保留，便于定位。
   */
  function pausedSummary(reason, diagnostics, detail) {
    try {
      logger?.info?.("dsh-expert-group: session delete convergence paused [" + reason + "]");
    } catch {
      // 诊断日志失败不得影响收敛结论。
    }
    // 「整体暂停」本身必须留下一条**结构化诊断**（规格决策 8 的要求），而不只是日志与 reason。
    if (diagnostics.length < MAX_DIAGNOSTICS) {
      diagnostics.push({ code: reason, ...(detail === undefined ? {} : { detail }) });
    }
    return {
      ran: true,
      paused: true,
      reason,
      ...(detail === undefined ? {} : { detail }),
      queueCount: 0,
      counts: { converged: 0, retained: 0, blocked: 0 },
      orphanResiduesRemoved: 0,
      entries: [],
      diagnostics,
    };
  }

  /** 一轮收敛的唯一实现（`run()` 保证它只被调用一次）。 */
  async function execute() {
    const diagnostics = [];
    const queue = readQueueOf(store);
    // 文档不可解析 → 整体暂停：读不懂文档就拿不到任何一条记录，没有「继续处理其他条目」。
    if (queue.readable !== true) {
      const detail = typeof queue.reason === "string" && queue.reason.length > 0 ? queue.reason : undefined;
      return pausedSummary(SESSION_DELETE_CONVERGENCE_REASONS.QUEUE_UNREADABLE, diagnostics, detail);
    }
    const headers = await readHeadersOf(logs);
    if (headers === undefined) {
      return pausedSummary(SESSION_DELETE_CONVERGENCE_REASONS.HEADERS_UNREADABLE, diagnostics);
    }
    const residue = readResidueOf(store);
    const residueRecords = residue.records instanceof Map ? residue.records : new Map();
    const headerIndex = indexHeaders(headers);
    const keys = Array.isArray(queue.keys)
      ? queue.keys.filter((key) => typeof key === "string" && key.length > 0)
      : [];
    const entries = [];
    for (const sessionId of keys) {
      entries.push(await convergeEntry(sessionId, queue.records?.get(sessionId), {
        headers: headerIndex,
        residueRecords,
      }));
    }
    const orphanResiduesRemoved = await sweepOrphanResidues(keys, residue, diagnostics);
    return summarize(entries, orphanResiduesRemoved, diagnostics);
  }

  return Object.freeze({
    /**
     * 执行一次收敛（**只执行一次**：重复与并发调用返回同一份结论）。
     *
     * 崩溃注入钩子抛出的错误原样上抛：那是「进程中断」，不是一次收敛结论。
     *
     * @returns {Promise<object>} 收敛结论。
     */
    async run() {
      if (pausedReason !== null) return snapshot();
      if (completed !== null) return completed;
      if (inFlight === null) inFlight = execute();
      try {
        completed = await inFlight;
      } finally {
        inFlight = null;
      }
      return completed;
    },
    snapshot,
    markPaused,
  });
}
