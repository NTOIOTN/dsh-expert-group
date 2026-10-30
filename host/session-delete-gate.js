/**
 * 会话删除的作业闸门（票据 01）。
 *
 * ## 判据（规格决策 9 / 11 的 S0；2026-10-30 按真机故障修正）
 * 某个会话**同时**满足下面两条，才不接受新的删除作业：
 * 1. 残留：它的隔离目录还存在（上一代的文件没收尾），**或**收敛队列里还留着它的条目
 *    （清理失败 / 残渣落盘失败都会把条目留下）；
 * 2. **且**原始路径上的会话日志**不存在**（`logExists !== true`，含「未提供」与「判不了」）。
 *
 * 只看第 1 条不够安全：无法区分「日志已经搬走」与「日志还在」。但只看第 1 条会**永久卡死**
 * 一批日志明明还能打开的会话，因为删除分两阶段——作业期把日志原子改名进隔离区并登记条目，
 * 清理推迟到插件启动时跑一次的收敛。收敛里的几条失败分支都会**永久保留**条目或目录：
 * - 日志状态判不了（例如 `SEGMENT_MISMATCH`，见 session-delete-convergence 的 FAIL_CLOSED）；
 * - 隔离目录删除失败（Windows 的 EBUSY 很常见）；
 * - 残渣落盘 / 条目删除失败；
 * 而且旧版本根本没有任何代码枚举隔离根，于是「隔离目录还在、队列条目已经没了」的孤儿目录
 * 永远没人处理。这几类现场的共性是：**日志仍在原路径，会话仍能正常打开**，但闸门因为残留
 * 事实永久阻塞，重启只是重跑同一条失败分支，用户连重试入口都没有。
 *
 * 为什么日志存在时旧残留无害：隔离文件名带毫秒时间戳（`<原文件名>.<毫秒>`），同名不会覆盖，
 * 所以原路径上的日志与隔离区里的副本属于不同代际；队列里那条旧记录唯一待办的是「收尾旧隔离
 * 目录 + 丢弃条目」，而新的删除作业本来就会做、且每一步都幂等（S1 重写意图条目、S4 重新搬
 * 一次当前代次、收敛期缺失即成功）。此时继续阻塞只会把用户卡死，所以放行，并用**非阻塞**字段
 * `staleResidueIgnored` 把这件事记进结论，便于诊断与断言。
 *
 * `logExists` 未提供时按「判不了」处理（仍然阻塞）——那是**旧行为**，保证还没接上日志存在性
 * 判定的调用点不会被意外放宽。日志存在性本身由调用方用**原始路径上的日志**判定，绝不看隔离区。
 *
 * 「残留」的两个来源之一是收敛队列里的条目。批量写前意图（键形如 `batch:<时间戳>`）把
 * 一次作业的 N 个目标合并成一条记录，因此批量成员**没有自己的键**——它们由记录里的
 * `sessions` 表达。闸门必须把「任一批量记录的 sessions 含该 ID」同样算作「有残留」，
 * 否则批量作业进行中（或崩溃后尚未收敛）的会话会被当成干净目标，开出第二代删除。
 * 单条读（`readQueueEntry`）与批量读（`checkMany`）都以这一口径取事实，判定函数本身未改。
 *
 * 另外两条 fail-closed 规则不变：
 * - 删除能力本身不可用（启动探测未通过）→ 一律阻塞（原因码来自探测）；
 * - 收敛队列读不出来（聚合文档不可解析）→ 一律阻塞，且意味着本轮收敛整体暂停。
 *
 * ## 两个查询入口，同一套判定
 * - {@link installDeletionGate} 的 `check(sessionId)`：作业入口 S0 用，单条读队列；
 * - `checkMany(sessionIds)`：候选查询与作业 S0 共用，**一次**读队列聚合文档再逐个判定。
 * 两条路径都把事实交给同一个纯函数 {@link evaluateDeletionGate}，因此候选与作业不会
 * 对「这个会话能不能删」给出不同答案。
 *
 * @module dsh-expert-group/host/session-delete-gate
 */
import { isBatchQueueKey } from "./session-delete-contract.js";

/** 闸门原因码（会进入候选查询的 `blockedBy` 与作业回执）。 */
export const DELETE_GATE_REASONS = Object.freeze({
  /** 不可处理：上一次删除的清理尚未完成，**且**原始路径上的日志已不存在。 */
  PENDING_CLEANUP: "pending-cleanup",
  /** 具体判据：隔离目录仍存在（与队列条目合起来构成「残留」）。 */
  QUARANTINE_PRESENT: "quarantine-present",
  /** 具体判据：收敛队列里仍有该会话的条目（与隔离目录合起来构成「残留」）。 */
  QUEUE_PENDING: "queue-pending",
  /** 收敛队列不可读：收敛整体暂停，删除入口不可用。 */
  QUEUE_UNREADABLE: "delete-queue-unreadable",
  /** 删除能力整体不可用（启动探测未通过）。 */
  DELETE_UNAVAILABLE: "delete-unavailable",
});

/**
 * 纯判定：把「隔离目录 / 队列 / 日志存在性 / 可用性」四个事实合成闸门结论。
 *
 * 残留（目录在或条目在）**只在日志不存在时**才阻塞（见模块头注释的判据与理由）：
 * - `logExists === true`：残留只是旧代际副本，不阻塞，并置 `staleResidueIgnored: true`；
 * - `logExists === false` 或未提供：维持旧的阻塞语义（未提供 = 老行为，绝不放宽）。
 *
 * `quarantinePresent` / `queuePending` 报告的是**原始事实**（目录在不在、条目在不在），
 * 不随 `logExists` 变化：诊断与断言需要能区分「有残留」与「残留被忽略」。
 *
 * @param {object} facts
 * @param {boolean} facts.available - 删除能力是否可用（启动探测结果）。
 * @param {boolean} facts.quarantineExists - 该会话的隔离目录是否存在。
 * @param {boolean} facts.queueReadable - 收敛队列是否可读。
 * @param {boolean} facts.queuePresent - 收敛队列里是否有该会话的条目。
 * @param {boolean|undefined} [facts.logExists] - 原始路径上的日志是否存在；未提供 = 判不了。
 * @returns {{blocked: boolean, blockedBy: string|null, reasons: string[],
 *   quarantinePresent: boolean, queuePending: boolean, staleResidueIgnored: boolean,
 *   available: boolean}} 闸门结论。
 */
export function evaluateDeletionGate({
  available,
  quarantineExists,
  queueReadable,
  queuePresent,
  logExists,
}) {
  const residue = quarantineExists === true || queuePresent === true;
  // 残留被忽略的唯一条件：日志**确实**还在原路径（判不了不算）。
  const staleResidueIgnored = residue === true && logExists === true;
  const reasons = [];
  if (residue === true && staleResidueIgnored !== true) {
    if (quarantineExists === true) reasons.push(DELETE_GATE_REASONS.QUARANTINE_PRESENT);
    if (queuePresent === true) reasons.push(DELETE_GATE_REASONS.QUEUE_PENDING);
  }
  if (queueReadable === false) reasons.push(DELETE_GATE_REASONS.QUEUE_UNREADABLE);
  if (available !== true) reasons.push(DELETE_GATE_REASONS.DELETE_UNAVAILABLE);
  let blockedBy = null;
  if (residue === true && staleResidueIgnored !== true) blockedBy = DELETE_GATE_REASONS.PENDING_CLEANUP;
  else if (reasons.length > 0) blockedBy = DELETE_GATE_REASONS.DELETE_UNAVAILABLE;
  return {
    blocked: reasons.length > 0,
    blockedBy,
    reasons,
    quarantinePresent: quarantineExists === true,
    queuePending: queuePresent === true,
    staleResidueIgnored,
    available: available === true,
  };
}

/**
 * 从队列快照里收集「尚未收敛完成」的会话 ID 集合（批量查询专用）。
 *
 * 两类来源：
 * 1. 表键本身（单会话条目，语义与修正前逐字一致）；
 * 2. 批量意图记录（键满足 isBatchQueueKey）的 `sessions` 成员——批量成员没有自己的键，
 *    但收敛期会按「日志是否存在」逐个处理它们，因此它们同样是待收敛目标。
 *
 * 只认批量键的 `sessions`：普通会话条目即使被外部塞进该字段也不算（否则一条被篡改的
 * 记录就能让别处的闸门永久阻塞）。
 *
 * @param {{keys?: string[], records?: Map}} snapshot - `store.readQueue()` 的快照。
 * @returns {Set<string>} 待收敛的会话 ID 集合 + 原始键集合。
 */
function collectPendingSessionIds(snapshot) {
  const pending = new Set();
  for (const key of Array.isArray(snapshot?.keys) ? snapshot.keys : []) {
    if (typeof key !== "string" || key.length === 0) continue;
    pending.add(key);
    if (!isBatchQueueKey(key)) continue;
    const sessions = snapshot?.records?.get?.(key)?.sessions;
    for (const sessionId of Array.isArray(sessions) ? sessions : []) {
      if (typeof sessionId === "string" && sessionId.length > 0) pending.add(sessionId);
    }
  }
  return pending;
}

/**
 * 创建闸门查询。
 *
 * 两个外部事实以端口注入：存储读取（异步、可能失败）与隔离目录存在性（同步文件系统）。
 * 判定本身是纯函数，适配器只负责取事实与把失败折成 fail-closed 事实。
 *
 * @param {object} deps
 * @param {{readQueueEntry: Function}} deps.store - 收敛日志读写原语。
 * @param {() => {available: boolean, reasons?: string[]}} deps.readAvailability - 启动探测快照。
 * @param {() => unknown} [deps.refreshAvailability] - 可用性重算端口（探测的 `refresh()`）：
 *   仅在缓存结论为「不可用」时调用一次，让启动期晚就绪的宿主服务可以自愈。
 * @param {(sessionId: string) => ({exists: boolean}|boolean)} deps.sessionQuarantineExists - 隔离目录探针。
 * @returns {{check: Function, checkMany: Function, evaluate: Function}} 闸门能力面。
 */
export function installDeletionGate({ store, readAvailability, refreshAvailability, sessionQuarantineExists }) {
  /**
   * 读一次可用性事实（**缓存不可用时先重算再读**）。
   *
   * 可用时原样返回缓存快照：零额外开销，也不触发任何检查项。
   * 不可用时调用一次 refreshAvailability 再读：启动期还没就绪的宿主服务（例如另一个插件
   * 晚于 DEG 激活 workspaceRegistry）因此能自愈；真正的故障重算后仍不可用，fail-closed 不变。
   * refresh 自身抛错（探测内部已兜底）时保留第一次的不可用结论，绝不把异常吞成「可用」。
   */
  function readAvailabilityFresh() {
    const first = readAvailability?.() ?? { available: false, reasons: [DELETE_GATE_REASONS.DELETE_UNAVAILABLE] };
    if (first?.available === true) return first;
    if (typeof refreshAvailability !== "function") return first;
    try {
      refreshAvailability();
    } catch {
      return first;
    }
    return readAvailability?.() ?? first;
  }

  /** 取隔离目录事实；探针抛错按「存在」处理（不能证明已收尾就不放行）。 */
  function readQuarantine(sessionId) {
    try {
      const outcome = sessionQuarantineExists(sessionId);
      if (outcome !== null && typeof outcome === "object") return outcome.exists === true;
      return outcome === true;
    } catch {
      return true;
    }
  }

  /** 取队列事实；读失败时 `queueReadable:false`，判定层据此整体阻塞。 */
  async function readQueueFacts(sessionId) {
    try {
      const outcome = await store.readQueueEntry(sessionId);
      return { queueReadable: outcome?.readable === true, queuePresent: outcome?.present === true };
    } catch {
      return { queueReadable: false, queuePresent: false };
    }
  }

  /**
   * 读「原始路径上的日志是否存在」，供残留判定使用。
   *
   * 三种取值严格区分：
   * - `true`：日志确实还在 → 旧残留无害，放行；
   * - `false`：日志确实不在 → 残留必须阻塞（旧的 fail-closed 语义）；
   * - `undefined`：**判不了**（端口缺失、返回非布尔、抛错）→ 与「未提供」同样按阻塞处理。
   *
   * 端口抛错绝不折成 `false`：把「读不出来」当成「日志不存在」会阻塞（安全侧），但折成
   * `true` 就会在本该阻塞时放行——因此异常一律返回 undefined。
   *
   * 只对**本来会 pending** 的会话调用（调用方负责先判残留），避免对每个候选都多做一次定位。
   */
  async function readLogExistence(options, sessionId) {
    if (typeof options?.logExists === "boolean") return options.logExists;
    const probe = options?.logExistsOf;
    if (typeof probe !== "function") return undefined;
    try {
      const outcome = await probe(sessionId);
      return typeof outcome === "boolean" ? outcome : undefined;
    } catch {
      return undefined;
    }
  }

  return Object.freeze({
    evaluate: evaluateDeletionGate,
    /**
     * 批量查询（候选查询与作业 S0 共用）：**一次**读取收敛队列聚合文档并建立会话 ID 集合，再逐个会话
     * 复用同一个纯判定 {@link evaluateDeletionGate}。
     *
     * 为什么不能复用 {@link check}：它对每个会话各调一次 `store.readQueueEntry`，而后者每次都会
     * 重新枚举整份聚合文档——候选查询有 N 个成员，逐条读就是 N 次文档读取（规格与票据 04 的
     * oracle 验收都明令禁止）。这里把「读文档」提到循环外，判定本身仍是**同一个纯函数**，
     * 因此候选查询与作业入口 S0 的 pending-cleanup 结论不会分叉。
     *
     * 可用性/可读性是**整批**事实（不是每个会话各自的）：任一项不成立都意味着删除入口必须
     * fail-closed，调用方据此整体拒绝候选查询，而不是把每个候选都标成 blocked。
     *
     * 日志存在性只对**本来会 pending** 的会话询问一次（`logExistsOf` 端口），
     * 因此 160 个成员里只有残留那几条会多做一次定位；队列表仍然只读一次。
     *
     * pending 集合包含「表键」与「批量意图记录的成员」两类（见 collectPendingSessionIds），
     * 所以批量作业进行中的会话与逐目标条目时代一样会被判成待收敛。
     *
     * @param {Iterable<string>} sessionIds - 待判定的会话 ID（保持输入顺序，去重由调用方决定）。
     * @param {{logExists?: boolean, logExistsOf?: (sessionId: string) => Promise<boolean|undefined>|boolean|undefined}}
     *   [options] - 日志存在性判据（见模块头注释）：只影响「有残留」的会话。
     * @returns {Promise<{available: boolean, queueReadable: boolean, unavailableReasons: string[],
     *   verdicts: Map<string, object>}>} 整批事实 + 逐会话结论（形状同 {@link check}）。
     */
    async checkMany(sessionIds, options) {
      const availability = readAvailabilityFresh();
      const available = availability?.available === true;
      const unavailableReasons = available ? [] : [...(availability?.reasons ?? [])];
      // 一次读文档：readQueue 内部只枚举一次 table.entries()（见 host/session-delete-store）。
      // pending 集合 = 全部键 ∪ 全部批量意图记录的成员：批量成员没有自己的键，但它同样
      // 「尚未收敛完成」，闸门不能因为「没有独立条目」就放行（否则会给同一会话开第二代
      // 删除作业）。判定函数与单条读完全相同，只是事实来自同一份快照。
      let queueReadable = false;
      let pending = new Set();
      try {
        const snapshot = await store.readQueue();
        if (snapshot?.readable === true) {
          queueReadable = true;
          pending = collectPendingSessionIds(snapshot);
        }
      } catch {
        queueReadable = false;
      }
      const verdicts = new Map();
      for (const raw of sessionIds ?? []) {
        if (typeof raw !== "string" || raw.length === 0) continue;
        const quarantineExists = readQuarantine(raw);
        const queuePresent = pending.has(raw);
        // 只有本来会被判成 pending 的会话才值得问一次「日志在不在」。
        const residue = quarantineExists === true || queuePresent === true;
        const logExists = residue ? await readLogExistence(options, raw) : undefined;
        const verdict = evaluateDeletionGate({
          available,
          quarantineExists,
          queueReadable,
          queuePresent,
          logExists,
        });
        verdicts.set(raw, { sessionId: raw, ...verdict, unavailableReasons: [...unavailableReasons] });
      }
      return { available, queueReadable, unavailableReasons, verdicts };
    },
    /**
     * 查询某个会话能否开始新的删除作业。
     *
     * `options.logExists` / `options.logExistsOf` 是可选的日志存在性判据：只对**有残留**的
     * 会话生效（见模块头注释）。不传时行为与修正前逐字一致（残留一律阻塞）。
     *
     * @param {string} sessionId - 会话 ID。
     * @param {{logExists?: boolean, logExistsOf?: (sessionId: string) => Promise<boolean|undefined>|boolean|undefined}}
     *   [options] - 日志存在性判据。
     * @returns {Promise<object>} 见 {@link evaluateDeletionGate}，另附 `sessionId` 与 `unavailableReasons`。
     */
    async check(sessionId, options) {
      const availability = readAvailabilityFresh();
      const queue = await readQueueFacts(sessionId);
      const quarantineExists = readQuarantine(sessionId);
      const residue = quarantineExists === true || queue.queuePresent === true;
      const verdict = evaluateDeletionGate({
        available: availability?.available === true,
        quarantineExists,
        queueReadable: queue.queueReadable,
        queuePresent: queue.queuePresent,
        logExists: residue ? await readLogExistence(options, sessionId) : undefined,
      });
      return {
        sessionId,
        ...verdict,
        unavailableReasons: availability?.available === true ? [] : [...(availability?.reasons ?? [])],
      };
    },
  });
}
