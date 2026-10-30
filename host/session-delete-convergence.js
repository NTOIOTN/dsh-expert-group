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
 * ## 单条异常隔离（2026-10-30 真机故障修正）
 * 逐条循环带 try/catch：某一条抛出未预期异常时，该条记 RETAINED + `delete-entry-failed`
 * 诊断，其余条目照常处理。旧实现让异常一路冒到装配段，整轮被折算成「整体暂停
 * delete-queue-unreadable」——既误导诊断（文档其实可读），又让后面的条目本轮不处理。
 * **崩溃注入钩子的抛错例外**：它代表「进程在这一点消失」，仍然原样上抛。
 *
 * ## 批量写前意图的展开（2026-10-30 真机性能故障修正）
 * 作业期不再为每个目标写两条记录，而是**每次作业写一条批量意图**（键满足 `isBatchQueueKey`，
 * 成员在 `sessions`）。收敛期因此要把队列快照的键分成两类：
 * - **单会话键**：完全按原有逻辑处理（一字未改）；
 * - **批量键**：对其成员逐个跑同一套 `convergeEntry`（状态按 `intent`：日志不存在 → 完整
 *   清理，日志存在 → 仅收尾，判不了 → fail-closed）。**单会话条目优先**：同一会话同时出现
 *   在两处时只按单会话条目处理，避免重复清理 / 重复收尾。
 *
 * 处理顺序固定为「先单会话、再批量」。某个成员展开失败（抛错）时：该成员按 RETAINED 处理，
 * 并**降级成单会话 `intent` 条目**（把 attempts / lastError 写回这条新条目），下次启动走标准
 * 重试路径；其余成员照常。只有**全部成员都收敛且成员集合完整**时才删除批量记录——部分失败
 * 时保留它，未收敛的成员下次仍会被展开（每一步都幂等）；已降级的成员因单会话条目优先而不会
 * 被重复处理。
 *
 * **跨批量记录去重**：多条批量意图可能同时覆盖同一会话（连续两次作业选中同一批）。整轮维护
 * 一个「已处理成员」集合，展开时跳过落在集合里的会话——否则同一会话会被清理两次（记账 detach
 * 幂等，但隔离区收尾与残渣计数会被重复执行，`expandedCount` 也会虚高）。每条记录处理完
 * （含降级成员）才把它的成员全部登记进集合。
 *
 * **成员集合不完整时禁止清扫**：归一函数在「有非法成员被丢弃」或「合法唯一成员数超过上限被
 * 截断」时会给出 `sessionsIncomplete`。此时这条记录**必须保留**（它是「不完整」的唯一证据，
 * 且下次仍要收尾已知成员），并且**整轮跳过孤儿隔离目录清扫**——漏掉的成员目录仍在磁盘上，
 * 用不完整集合清扫会把它们当孤儿删掉，那是丢失「未完成删除」的唯一现场。取舍明确：孤儿目录
 * 只有磁盘空间代价，误删不可逆。
 *
 * ## 只在持锁实例上执行（2026-10-30 oracle 复审必须修 1）
 * 收敛会删条目、扫隔离目录，都是破坏性动作。未持锁的实例（锁被另一个实例持有 / 锁文件不可读）
 * 如果照常收敛，就会按「原始路径上的日志还在」把**别人写到一半的批量意图**当成可丢弃记录删掉，
 * 并清扫对方正在使用的隔离目录——对方随后改名并崩溃时，那批会话的 DEG 数据与记账再也没有清理
 * 入口。锁门槛由装配段保证（`runConvergenceWhenLockHeld`）：`ok !== true` 时只调 `markPaused`
 * 留下 `delete-instance-lock-unavailable` 结论，**不 run、不扫隔离区**。本模块自身不读锁、
 * 不感知锁：它是纯收敛实现，锁门槛属于装配职责。
 *
 * ## 孤儿隔离目录清扫（同一次修正）
 * 处理完队列条目后枚举隔离根，把**名字不等于任何「在队列里仍有归属的会话」编码段**的目录整目录
 * 删掉。归属集合 = 单会话键 ∪ 全部批量意图记录的成员（批量成员没有自己的键，但它们的隔离目录
 * 正是本次批量删除产生的；漏掉这一半会把**正在删除中的目录当孤儿删掉**）。
 * 安全性：作业顺序是「先写意图（批量或单会话），再 mkdir/改名」，因此出现目录时必然有归属；
 * 没有归属的目录只可能是历史/存储重置遗留，删它只会清掉已删除会话的旧副本。编码失败时跳过该键，
 * 不清扫失败整轮（只记诊断）。
 *
 * ## 计数口径（批量展开）
 * `queueCount` 仍是**原始队列键数**（含批量记录），`batchCount` 是其中批量记录的条数，
 * `expandedCount` 是本轮实际处理的会话条目数（一个批量记录可产生多条）。守恒等式因此改为
 * 「converged + retained + blocked = expandedCount」；队列键数与展开数不再必然相等。
 *
 * ## 失败可观测性（同一次修正）
 * RETAINED / BLOCKED 的条目把 `attempts + 1` 与 `lastError`（稳定原因码串，≤512 字符）
 * 写回收敛日志条目，并用 `logger.info` 记一行「收敛保留条目：sessionId + 原因码」。
 * 这是让下次真机故障可诊断的关键：过去单条失败对用户完全不可见。
 *
 * ## 文档不可解析 = 整体暂停
 * 存储域是「一个域一份聚合文档」，读不懂文档就拿不到**任何**一条记录（决策 8）。因此
 * `store.readQueue()` 报不可读时本模块什么都不做：不修改文件、不清理、保留全部条目，
 * 只写一条诊断；删除入口的不可用由启动探测与闸门另外保证。
 *
 * @module dsh-expert-group/host/session-delete-convergence
 */
import { isSafeSessionId } from "./session-delete-cleanup.js";
import { SESSION_DELETE_STATUS, isBatchQueueKey } from "./session-delete-contract.js";
import { SESSION_LOG_RESOLVE_FAILURES, encodePathSegment } from "./session-delete-paths.js";

/** 收敛期的稳定原因码（进入诊断，可展示、可断言；不含路径与堆栈）。 */
export const SESSION_DELETE_CONVERGENCE_REASONS = Object.freeze({
  /** 收敛文档不可解析：整体暂停（不修改文件、不清理、删除入口不可用）。 */
  QUEUE_UNREADABLE: "delete-queue-unreadable",
  /**
   * 本进程不持有实例锁：本轮收敛整体跳过（不清理、不扫隔离区，只记诊断）。
   *
   * 为什么收敛也要锁：未持锁的实例如果照常收敛，会按「日志还在」把别人写到一半的批量意图
   * 当成可丢弃记录删掉，并清扫对方正在使用的隔离目录——对方随后改名并崩溃时，那批会话的
   * DEG 数据与记账就再也没有清理入口。
   */
  LOCK_UNAVAILABLE: "delete-instance-lock-unavailable",
  /** 会话清单读不出来：判不了任何条目的日志状态，整体暂停。 */
  HEADERS_UNREADABLE: "delete-headers-unreadable",
  /** 单个条目的日志状态判不了（定位失败）：该条 fail-closed 并保留。 */
  LOG_STATE_UNKNOWN: "delete-log-state-unknown",
  /** 键不是合法会话身份：该条 fail-closed（不清理、保留记录）。 */
  INVALID_SESSION_ID: "delete-session-id-invalid",
  /** 记录体非法或状态未知但键可读：按 intent 处理（诊断只为可观测性）。 */
  RECORD_DEGRADED: "delete-queue-record-degraded",
  /**
   * 批量意图的成员集合不完整（字段缺失 / 非法成员被丢弃 / 超上限截断）：保留记录，且本轮
   * 禁止孤儿清扫——漏掉的成员目录仍在磁盘上，用不完整集合清扫会把它们当孤儿删掉。
   */
  BATCH_SESSIONS_INCOMPLETE: "delete-batch-sessions-incomplete",
  /** 日志被重新写入：保留会话与数据（「删除未完成，内容已保留」）。 */
  SESSION_PRESERVED: "delete-incomplete-content-preserved",
  /** 残渣落盘失败：保留收敛日志条目。 */
  RESIDUE_WRITE_FAILED: "delete-residue-write-failed",
  /** 删除收敛日志条目失败：条目仍在，下次启动重试（幂等）。 */
  QUEUE_DROP_FAILED: "delete-queue-entry-drop-failed",
  /** 删除已完成会话的残渣条目失败（只是诊断，由孤儿残渣清扫兜底）。 */
  RESIDUE_DROP_FAILED: "delete-residue-entry-drop-failed",
  /**
   * 单条收敛抛出了未预期的异常：该条按 RETAINED 处理并记诊断，其余条目照常。
   *
   * 为什么必须逐条兜住：旧实现让异常一路冒到装配段，整轮被折算成「整体暂停
   * delete-queue-unreadable」——既误导诊断（文档其实可读），又让后面的条目本轮不处理。
   */
  ENTRY_FAILED: "delete-entry-failed",
  /** 枚举隔离根失败：只影响孤儿目录清扫，不影响条目结论。 */
  QUARANTINE_LIST_FAILED: "delete-quarantine-list-failed",
  /**
   * 本轮存在成员集合不完整的批量记录：整轮跳过孤儿隔离目录清扫（其余收敛照常）。
   *
   * 这是「宁可留着孤儿目录，也不能删错」的取舍：孤儿目录只有磁盘空间代价，误删则是丢失
   * 未完成删除的唯一现场。
   */
  QUARANTINE_SWEEP_SKIPPED: "delete-quarantine-sweep-skipped",
  /** 孤儿隔离目录删除失败（或名字非法被跳过）：只记诊断，不失败整轮。 */
  QUARANTINE_DISCARD_FAILED: "delete-quarantine-discard-failed",
  /** 保留条目的 attempts / lastError 写回失败：只记诊断，不改变收敛结论。 */
  ENTRY_ATTEMPT_WRITE_FAILED: "delete-entry-attempt-write-failed",
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
 * 单条保留记录里 `lastError` 的最大长度（与 session-delete-contract 的写入边界一致）。
 *
 * 它只放**稳定原因码串**（可展示、可断言），绝不落路径或堆栈；超长按前缀截断即可，
 * 目的在于让下一次真机故障能一眼看出上次卡在哪个分支。
 */
const MAX_QUEUE_ERROR_CHARS = 512;

/** 保留条目的兜底失败码：条目确实没收敛，但拿不到更具体的原因（例如库内异常无诊断）。 */
const RETAINED_FALLBACK_CODE = "delete-convergence-retained";

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

/** 诊断只进诊断数组（不写残渣）：它不是恢复记录，也不该影响条目去留。 */
function recordDiagnostic(diagnostics, code) {
  if (diagnostics.length >= MAX_DIAGNOSTICS) return;
  diagnostics.push({ code });
}

/**
 * 单条收敛抛出未预期异常时的结论：该条 **RETAINED**（条目与文件都不动），其余条目照常。
 *
 * 与 BLOCKED 的区别：BLOCKED 是「判不了，什么都不做」，RETAINED 是「有失败项需要下次重试」；
 * 异常属于后者（我们确实尝试过，只是没做完），并且必须进残渣之外的诊断通道
 * （收敛日志条目的 attempts/lastError 由 recordRetainedAttempt 负责）。
 */
function failedEntry(sessionId) {
  return {
    sessionId,
    branch: CONVERGENCE_BRANCHES.FAIL_CLOSED,
    outcome: CONVERGENCE_OUTCOMES.RETAINED,
    failures: [SESSION_DELETE_CONVERGENCE_REASONS.ENTRY_FAILED],
    diagnostics: [{ code: SESSION_DELETE_CONVERGENCE_REASONS.ENTRY_FAILED }],
  };
}

/** 取一条保留条目的失败码串（写进 lastError；只取稳定原因码，不取异常文本/路径）。 */
function failureTextOf(entry) {
  const codes = Array.isArray(entry?.failures) && entry.failures.length > 0
    ? entry.failures
    : (Array.isArray(entry?.diagnostics) ? entry.diagnostics.map((diagnostic) => diagnostic?.code) : []);
  const text = codes.filter((code) => typeof code === "string" && code.length > 0).join(",");
  if (text.length === 0) return RETAINED_FALLBACK_CODE;
  return text.slice(0, MAX_QUEUE_ERROR_CHARS);
}

/**
 * 把「保留」这件事写回收敛日志条目：`attempts + 1` 与 `lastError`（故障可观测性的关键）。
 *
 * 为什么在收敛里做：单条失败过去对用户完全不可见（收敛结论被装配段丢弃、残渣表没有读面），
 * 导致真机上「为什么这个会话删不掉」无从诊断。把次数与最近原因写回条目本身，重启后仍然可读。
 *
 * 取值口径：
 * - 次数以**存储里的现有值**为准（`store.readQueueEntry`），读失败才退回本轮快照——
 *   否则并发/重复收敛会让计数倒退；
 * - `status` 原样保留（未知/非法按 `intent`，与决策 8 的归一一致）；
 * - `registeredAt` 原样保留；原记录缺这个字段（契约里非法）时用当前时间补一个，
 *   否则严格写入边界会拒绝写入（那会让计数与原因一起丢掉）。
 *
 * 任何失败只记诊断，**不改变**收敛结论：可观测性不能反过来影响收敛行为。
 */
async function recordRetainedAttempt(store, sessionId, record, entry, diagnostics, clock, logger) {
  const reason = failureTextOf(entry);
  try {
    logger?.info?.("dsh-expert-group: session delete convergence retained [" + sessionId + "] " + reason);
  } catch {
    // 日志失败不得影响收敛结论。
  }
  let current = record;
  try {
    const read = await store.readQueueEntry?.(sessionId);
    if (read?.readable === true && read.present === true && read.entry !== undefined) current = read.entry;
  } catch {
    // 读失败就用本轮快照：attempts 只影响诊断。
  }
  const attempts = (Number.isInteger(current?.attempts) && current.attempts >= 0 ? current.attempts : 0) + 1;
  const registeredAt = Number.isFinite(current?.registeredAt) && current.registeredAt >= 0
    ? current.registeredAt
    : readNow(clock);
  const status = current?.status === SESSION_DELETE_STATUS.CLEANUP
    || current?.status === SESSION_DELETE_STATUS.RACE
    ? current.status
    : SESSION_DELETE_STATUS.INTENT;
  try {
    await store.writeQueueEntry(sessionId, { status, registeredAt, attempts, lastError: reason });
  } catch {
    recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.ENTRY_ATTEMPT_WRITE_FAILED);
  }
}

/**
 * 批量展开需要的窄能力面（模块级实现，工厂只负责把闭包里的实现绑进来）。
 *
 * 显式端口的价值：模块级实现因此可复用、可被测试替身替换，而工厂内不出现「第二个实现」。
 *
 * @param {object} deps - 已绑定的实现。
 * @returns {{store: object, convergeEntry: Function, retainAttempt: Function,
 *   dropEntry: Function, consumeHookInterrupt: Function}} 端口面。
 */
function buildBatchPortsOf({
  store,
  convergeEntry,
  recordRetainedAttempt,
  dropQuietly,
  consumeHookInterrupt,
  clock,
  logger,
}) {
  return {
    store,
    convergeEntry,
    retainAttempt: (sessionId, record, entry, diagnostics) => (
      recordRetainedAttempt(store, sessionId, record, entry, diagnostics, clock, logger)
    ),
    dropEntry: (drop, diagnostics) => (
      dropQuietly(drop, diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.QUEUE_DROP_FAILED)
    ),
    consumeHookInterrupt,
  };
}

/**
 * 展开一条批量写前意图记录（模块级实现，收敛工厂只负责接线）。
 *
 * 为什么成员按 `intent` 处理：批量记录的状态是恒定的「这些会话即将 / 已经进入删除」，
 * 而分支判定只依赖「原始路径上的日志是否存在」——日志不在 → 完整清理，日志还在 → 仅收尾。
 * 这正是逐目标 `intent` 条目时代的语义，只是把 N 条记录合并成 1 条。
 *
 * 四条边界：
 * 1. **单会话条目优先**：成员若在 `sessionKeySet` 里（有自己的条目），这里直接跳过——
 *    它已由单会话循环处理过，重复展开会重复清理 / 重复收尾；
 * 2. **跨批量记录去重**：成员若已在 `processedMembers`（本轮更早的批量记录处理过），同样跳过。
 *    多条批量记录覆盖同一会话时（例如连续两次作业选中同一批），该会话的清理只能执行一次；
 * 3. 某个成员抛错：该成员按 RETAINED 处理并**降级成单会话 `intent` 条目**（把 attempts 与
 *    lastError 写回），下次走标准重试路径；其余成员照常，不影响本轮其它会话；
 * 4. 只有**全部成员收敛且成员集合完整**才删除批量记录。部分失败时保留它：未收敛的成员下次
 *    仍要展开（幂等）；集合不完整时也保留——它是「不完整」的唯一证据，且下次仍要收尾已知成员。
 *
 * @param {object} params
 * @param {string} params.batchKey - 批量记录的键。
 * @param {object|undefined} params.record - 归一后的批量记录（含 `sessions` / `sessionsIncomplete`）。
 * @param {{headers: Map, residueRecords: Map, sessionKeySet: Set<string>,
 *   processedMembers: Set<string>}} params.context - 本轮快照。
 * @param {object} params.ports - 工厂注入的能力面：
 *   `{convergeEntry, retainAttempt, dropEntry, consumeHookInterrupt}`。
 * @returns {Promise<{entries: object[], degraded: string[], diagnostics: object[],
 *   incomplete: boolean, allConverged: boolean}>} 展开结论。
 */
async function expandBatchQueueEntry({ batchKey, record, context, ports }) {
  const diagnostics = [];
  const sessions = Array.isArray(record?.sessions) ? record.sessions : [];
  // 成员集合不完整 = 「字段缺失 / 空集合」或归一阶段已经标记 `sessionsIncomplete`。
  // 这两种情况都必须保留记录（不删）并让调用方本轮禁止孤儿清扫：被丢弃的成员目录仍在磁盘上，
  // 用不完整集合清扫会把它们当孤儿删掉——那是丢失「未完成删除」的唯一现场。
  const incomplete = record?.sessionsIncomplete === true || sessions.length === 0;
  if (incomplete === true) {
    recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.BATCH_SESSIONS_INCOMPLETE);
    // 成员集合完全读不出来时再补一条「记录体降级」诊断（可观测性，不影响结论）。
    if (sessions.length === 0) recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.RECORD_DEGRADED);
  }
  const entries = [];
  const degraded = [];
  let allConverged = true;
  for (const sessionId of sessions) {
    if (context.sessionKeySet.has(sessionId)) continue;
    // 跨批量记录去重：同一会话在更早的批量记录里已经处理过（含降级），这里不得再清理一次。
    if (context.processedMembers?.has?.(sessionId) === true) continue;
    let entry;
    try {
      entry = await ports.convergeEntry(
        sessionId,
        { status: SESSION_DELETE_STATUS.INTENT, attempts: 0 },
        { headers: context.headers, residueRecords: context.residueRecords, ownsEntry: false },
      );
    } catch (error) {
      if (ports.consumeHookInterrupt() === true) throw error;
      entry = failedEntry(sessionId);
    }
    if (entry.outcome !== CONVERGENCE_OUTCOMES.CONVERGED) {
      allConverged = false;
      // 降级成单会话条目：批量记录无法表达「谁失败了」，而下次启动必须能定位到具体会话。
      await ports.retainAttempt(sessionId, record, entry, diagnostics);
      degraded.push(sessionId);
    }
    entries.push(entry);
  }
  if (allConverged === true && incomplete !== true) {
    await ports.dropEntry(() => ports.store.deleteQueueEntry(batchKey), diagnostics);
  }
  return { entries, degraded, diagnostics, incomplete, allConverged };
}

/**
 * 孤儿残渣清扫（模块级实现）：残渣条目在对应收敛条目消失后即无意义（条目只会因失败而保留）。
 *
 * 它覆盖「条目已删、残渣没删掉」的崩溃窗口；不清会让残渣表无限增长。
 * 「仍有归属」的集合由调用方给出：单会话键 ∪ 本轮降级出的单会话条目（批量键本身不算归属，
 * 但降级后的成员算——否则它刚写下的恢复记录会被当成无主残渣删掉）。
 *
 * @param {object} store - 收敛日志读写原语。
 * @param {string[]} queueKeys - 本轮仍有条目的会话 ID。
 * @param {{keys?: string[]}} residue - 残渣快照。
 * @param {object[]} diagnostics - 本轮诊断数组。
 * @returns {Promise<number>} 清掉的孤儿残渣数。
 */
async function sweepOrphanResiduesOf(store, queueKeys, residue, diagnostics) {
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

/**
 * 孤儿隔离目录清扫：删掉隔离根下**没有任何「仍有归属的会话」对应**的目录。
 *
 * ## 安全性论证
 * 作业顺序固定为「先写意图条目、再 mkdir/改名」（票据 02 的 S1 → S4），因此只要出现隔离
 * 目录，它的会话 ID 就必然曾登记在队列里。没有对应键的目录只可能来自：
 * - 历史版本遗留（旧版本没有任何枚举隔离根的入口，条目被收敛丢弃后目录就无人引用）；
 * - 存储域被重置 / 条目被外部删除；
 * - S4 失败分支在「目录已删、条目还在」两点之间崩溃后又被人为删条目。
 * 这几种情况下目录里只有**已删除会话的旧副本**，删掉它只清残留，不会碰到任何仍在原路径的日志
 * （原路径与隔离区是两个位置，且本函数只按隔离根下的目录名删除）。
 *
 * ## 边界
 * - 端口缺失（旧装配/替身）→ 什么都不做（老行为）；
 * - 键的编码集合用 `encodePathSegment` 逐个算，**编码失败就跳过该键**（将来的非会话键
 *   不该让整轮清扫失效，也不该被误删）；
 * - 枚举失败只记诊断；单个目录删除失败/名字非法同样只记诊断——清扫是兜底动作，
 *   失败不得反噬条目结论。
 *
 * @param {object} quarantine - 隔离区端口（可含 `listNames` / `discardByName`）。
 * @param {string[]} referencedSessionIds - 本轮「仍有归属」的会话 ID：单会话键 ∪ 批量意图的
 *   全部成员。批量成员没有自己的键，但它们的隔离目录正是本次批量删除产生的——漏掉这一半
 *   会把**正在删除中的目录当孤儿删掉**。
 * @param {object[]} diagnostics - 本轮诊断数组。
 * @returns {Promise<number>} 成功删掉的孤儿目录数。
 */
async function sweepOrphanQuarantines(quarantine, referencedSessionIds, diagnostics) {
  if (typeof quarantine.listNames !== "function" || typeof quarantine.discardByName !== "function") return 0;
  let names;
  try {
    names = await quarantine.listNames();
  } catch {
    recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.QUARANTINE_LIST_FAILED);
    return 0;
  }
  const referenced = new Set();
  for (const sessionId of referencedSessionIds) {
    try {
      referenced.add(encodePathSegment(sessionId));
    } catch {
      // 编码不出来（空串/非字符串）：跳过，宁可不删也不猜映射关系。
    }
  }
  let removed = 0;
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || name.length === 0) continue;
    if (referenced.has(name)) continue;
    let outcome;
    try {
      outcome = await quarantine.discardByName(name);
    } catch {
      recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.QUARANTINE_DISCARD_FAILED);
      continue;
    }
    if (outcome?.settled === true) removed += 1;
    else recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.QUARANTINE_DISCARD_FAILED);
  }
  return removed;
}

/**
 * 创建收敛能力面。
 *
 * @param {object} deps - 窄能力面（本模块不读 ctx、不碰文件系统、不拼路径）。
 * @param {object} deps.store - 票据 01 的两张表读写原语（见 host/session-delete-store）。
 * @param {object} deps.logs - 会话事实端口 `{readHeaders, resolve}`。
 * @param {object} deps.cleanup - 票据 03 的清理步骤能力面（返回失败项码数组）。
 * @param {object} deps.quarantine - 隔离区端口：
 *   `{settle, listNames?, discardByName?}`。后两个用于孤儿目录清扫，缺失时跳过清扫（旧装配行为不变）；
 *   `listNames()` 返回隔离根下的目录名数组，`discardByName(name)` 只按名字删除一个目录。
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
        batchCount: 0,
        expandedCount: 0,
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

  /**
   * 「钩子抛错」的一次性标记。
   *
   * 崩溃注入钩子抛错等价于**进程在这一点消失**，必须原样上抛（`run()` reject）。但逐条收敛
   * 现在有 try/catch（单条异常隔离），所以钩子抛错要能被那个 catch 识别出来并继续上抛，
   * 而不是被折算成一条 RETAINED。标记放在闭包里（不是模块级）：多个收敛实例互不干扰。
   */
  let hookInterrupted = false;

  /** 调用崩溃注入钩子：钩子抛错原样上抛（等同于进程在这一点消失），并打上中断标记。 */
  function invokeHook(stage, context) {
    const hook = hooks?.[stage];
    if (typeof hook !== "function") return;
    try {
      hook(context);
    } catch (error) {
      hookInterrupted = true;
      throw error;
    }
  }

  /** 消费一次「钩子中断」标记：true 表示当前异常来自崩溃注入钩子，必须继续上抛。 */
  function consumeHookInterrupt() {
    if (hookInterrupted !== true) return false;
    hookInterrupted = false;
    return true;
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
   * @param {string} sessionId - 会话 ID（单会话键，或批量意图记录里的成员）。
   * @param {object|undefined} record - 归一后的队列记录（批量成员固定传 `{status: "intent"}`）。
   * @param {object} context - 本轮快照：`{headers, residueRecords, ownsEntry?}`。
   *   `ownsEntry === false` 表示这个会话在队列表里**没有自己的条目**（由批量意图记录覆盖），
   *   因此最后一步「丢弃条目」由批量记录统一完成，本函数只做清理与收尾。
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
    // 批量成员没有自己的条目：它的「条目」就是那条批量意图记录，由 expandBatchQueueEntry 在全部
    // 成员收敛后统一删除。这里跳过删除是必要的——removeDomainEntry 对不存在的键同样会触发
    // 一次整份文档落盘，160 个成员就是 160 次多余 fsync。
    // 只跳过「丢弃自己的条目」：清理步骤、隔离区收尾与残渣清理一律照常。
    if (context.ownsEntry === false) {
      return {
        sessionId,
        branch: decision.branch,
        outcome: CONVERGENCE_OUTCOMES.CONVERGED,
        failures: [],
        diagnostics,
      };
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
   * 汇总本轮收敛结论（守恒：converged + retained + blocked = **展开后的会话条目数**）。
   *
   * 计数口径（批量展开后）：`queueCount` 保持原语义「原始队列键数」（含批量记录），`batchCount`
   * 是其中批量记录的条数，`expandedCount` 是实际处理的会话条目数。一条批量记录可以展开成多条，
   * 因此「队列键数」与「处理的会话数」不再必然相等——两个数字都给出，读者不需要再推算。
   */
  function summarize(entries, scope, orphanResiduesRemoved, orphanQuarantinesRemoved, diagnostics) {
    const counts = { converged: 0, retained: 0, blocked: 0 };
    for (const entry of entries) {
      if (entry.outcome === CONVERGENCE_OUTCOMES.CONVERGED) counts.converged += 1;
      else if (entry.outcome === CONVERGENCE_OUTCOMES.RETAINED) counts.retained += 1;
      else counts.blocked += 1;
    }
    return {
      ran: true,
      paused: false,
      queueCount: scope.queueCount,
      batchCount: scope.batchCount,
      expandedCount: entries.length,
      counts,
      orphanResiduesRemoved,
      orphanQuarantinesRemoved,
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
      // 整体暂停时一条都没展开：两个计数与 queueCount 一样是 0（形状与正常结论保持一致）。
      batchCount: 0,
      expandedCount: 0,
      counts: { converged: 0, retained: 0, blocked: 0 },
      orphanResiduesRemoved: 0,
      orphanQuarantinesRemoved: 0,
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
    // 两类键分开：批量意图记录**不是**会话条目，必须先按成员展开再逐会话收敛。
    const sessionKeys = keys.filter((key) => isBatchQueueKey(key) !== true);
    const batchKeys = keys.filter((key) => isBatchQueueKey(key) === true);
    const sessionKeySet = new Set(sessionKeys);
    const entries = [];
    for (const sessionId of sessionKeys) {
      // 取归一记录也放进 try：它同样是「这一条」的读步骤，抛错只应影响这一条。
      let record;
      let entry;
      try {
        record = queue.records?.get(sessionId);
        entry = await convergeEntry(sessionId, record, { headers: headerIndex, residueRecords });
      } catch (error) {
        // 崩溃注入钩子的抛错 = 进程在这一点消失：必须继续上抛，而不是折算成一条结论。
        if (consumeHookInterrupt() === true) throw error;
        // 其余未预期异常逐条隔离：该条 RETAINED + 诊断，后面的条目照常处理。
        entry = failedEntry(sessionId);
      }
      // 可观测性：保留/阻塞的条目把尝试次数与最近原因写回条目本身（失败只记诊断）。
      if (entry.outcome !== CONVERGENCE_OUTCOMES.CONVERGED) {
        await recordRetainedAttempt(store, sessionId, record, entry, diagnostics, clock, logger);
      }
      entries.push(entry);
    }
    // 单会话条目处理完之后再展开批量（顺序固定：单会话条目优先，避免重复清理 / 重复收尾）。
    // `residueReferenced` 是「本轮仍有单会话条目」的集合：批量成员一旦降级成单会话条目就计入，
    // 否则孤儿残渣清扫会把它刚写下的恢复记录当成无主残渣删掉。
    const residueReferenced = new Set(sessionKeys);
    const batchSessionIds = [];
    // 跨批量记录去重：同一会话可能被多条批量意图同时覆盖（连续两次作业选中同一批）。
    // 集合在整轮内共享，保证它的清理 / 收尾只执行一次。
    const processedBatchMembers = new Set();
    // 是否允许本轮做孤儿隔离目录清扫：任一批量记录的成员集合不完整就必须整轮跳过
    // （漏掉的成员目录还在磁盘上，按不完整集合清扫会误删）。
    let sweepUnsafe = false;
    const ports = buildBatchPortsOf({
      store, convergeEntry, recordRetainedAttempt, dropQuietly, consumeHookInterrupt, clock, logger,
    });
    for (const batchKey of batchKeys) {
      const record = queue.records?.get(batchKey);
      const sessions = Array.isArray(record?.sessions) ? record.sessions : [];
      for (const sessionId of sessions) batchSessionIds.push(sessionId);
      const outcome = await expandBatchQueueEntry({
        batchKey,
        record,
        context: { headers: headerIndex, residueRecords, sessionKeySet, processedMembers: processedBatchMembers },
        ports,
      });
      for (const entry of outcome.entries) entries.push(entry);
      for (const sessionId of outcome.degraded) residueReferenced.add(sessionId);
      for (const diagnostic of outcome.diagnostics) recordDiagnostic(diagnostics, diagnostic.code);
      // 处理完（含降级成员）才把成员全部登记：下一条批量记录据此跳过已处理会话。
      for (const sessionId of sessions) processedBatchMembers.add(sessionId);
      if (outcome.incomplete === true) sweepUnsafe = true;
    }
    // 处理完队列条目之后再扫孤儿隔离目录：归属集合此刻才是「本轮真正还在排队」的集合；
    // 批量成员必须计入（否则正在批量删除中的目录会被当孤儿删掉）。
    // 成员集合不完整时整轮跳过清扫：宁可在磁盘上留孤儿目录（只占空间），也不能把仍在删除中
    // 的会话目录误删（那是丢失未完成删除的唯一现场）。
    let orphanQuarantinesRemoved = 0;
    if (sweepUnsafe === true) {
      recordDiagnostic(diagnostics, SESSION_DELETE_CONVERGENCE_REASONS.QUARANTINE_SWEEP_SKIPPED);
    } else {
      orphanQuarantinesRemoved = await sweepOrphanQuarantines(
        quarantine,
        [...sessionKeys, ...batchSessionIds],
        diagnostics,
      );
    }
    const orphanResiduesRemoved = await sweepOrphanResiduesOf(store, [...residueReferenced], residue, diagnostics);
    return summarize(
      entries,
      { queueCount: keys.length, batchCount: batchKeys.length },
      orphanResiduesRemoved,
      orphanQuarantinesRemoved,
      diagnostics,
    );
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
