/**
 * 会话删除的作业闸门（票据 01）。
 *
 * ## 判据（规格决策 9 / 11 的 S0）
 * 只要某个会话满足**任一**条件，就不接受新的删除作业：
 * 1. 它的隔离目录还存在（上一代的文件没收尾）；
 * 2. 收敛队列里还存在它的条目（清理失败 / 残渣落盘失败都会把条目留下）。
 *
 * 只看目录不够：「清理步骤失败 → 隔离目录已删 → 残渣写入也失败」会留下「目录已删、
 * 条目还在」的形态。两个条件合起来，才保证同一会话最多只有「一代」隔离文件、队列条目
 * 也不会被新作业覆盖（所以不需要代际 ID）。
 *
 * 另外两条 fail-closed 规则：
 * - 删除能力本身不可用（启动探测未通过）→ 一律阻塞（原因码来自探测）；
 * - 收敛队列读不出来（聚合文档不可解析）→ 一律阻塞，且意味着本轮收敛整体暂停。
 *
 * ## 两个查询入口，同一套判定
 * - {@link installDeletionGate} 的 `check(sessionId)`：作业入口 S0 用，单条读队列；
 * - `checkMany(sessionIds)`：候选查询用，**一次**读队列聚合文档再逐个判定。
 * 两条路径都把事实交给同一个纯函数 {@link evaluateDeletionGate}，因此候选与作业不会
 * 对「这个会话能不能删」给出不同答案。
 *
 * @module dsh-expert-group/host/session-delete-gate
 */

/** 闸门原因码（会进入候选查询的 `blockedBy` 与作业回执）。 */
export const DELETE_GATE_REASONS = Object.freeze({
  /** 不可处理：上一次删除的清理尚未完成（目录还在或队列条目还在）。 */
  PENDING_CLEANUP: "pending-cleanup",
  /** 具体判据：隔离目录仍存在。 */
  QUARANTINE_PRESENT: "quarantine-present",
  /** 具体判据：收敛队列里仍有该会话的条目。 */
  QUEUE_PENDING: "queue-pending",
  /** 收敛队列不可读：收敛整体暂停，删除入口不可用。 */
  QUEUE_UNREADABLE: "delete-queue-unreadable",
  /** 删除能力整体不可用（启动探测未通过）。 */
  DELETE_UNAVAILABLE: "delete-unavailable",
});

/**
 * 纯判定：把「隔离目录 / 队列 / 可用性」三个事实合成闸门结论。
 *
 * @param {object} facts
 * @param {boolean} facts.available - 删除能力是否可用（启动探测结果）。
 * @param {boolean} facts.quarantineExists - 该会话的隔离目录是否存在。
 * @param {boolean} facts.queueReadable - 收敛队列是否可读。
 * @param {boolean} facts.queuePresent - 收敛队列里是否有该会话的条目。
 * @returns {{blocked: boolean, blockedBy: string|null, reasons: string[],
 *   quarantinePresent: boolean, queuePending: boolean, available: boolean}} 闸门结论。
 */
export function evaluateDeletionGate({ available, quarantineExists, queueReadable, queuePresent }) {
  const reasons = [];
  if (quarantineExists === true) reasons.push(DELETE_GATE_REASONS.QUARANTINE_PRESENT);
  if (queuePresent === true) reasons.push(DELETE_GATE_REASONS.QUEUE_PENDING);
  if (queueReadable === false) reasons.push(DELETE_GATE_REASONS.QUEUE_UNREADABLE);
  if (available !== true) reasons.push(DELETE_GATE_REASONS.DELETE_UNAVAILABLE);
  let blockedBy = null;
  if (quarantineExists === true || queuePresent === true) blockedBy = DELETE_GATE_REASONS.PENDING_CLEANUP;
  else if (reasons.length > 0) blockedBy = DELETE_GATE_REASONS.DELETE_UNAVAILABLE;
  return {
    blocked: reasons.length > 0,
    blockedBy,
    reasons,
    quarantinePresent: quarantineExists === true,
    queuePending: queuePresent === true,
    available: available === true,
  };
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
 * @returns {{check: (sessionId: string) => Promise<object>, evaluate: Function}} 闸门能力面。
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

  return Object.freeze({
    evaluate: evaluateDeletionGate,
    /**
     * 批量查询（候选查询专用）：**一次**读取收敛队列聚合文档并建立会话 ID 集合，再逐个会话
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
     * @param {Iterable<string>} sessionIds - 待判定的会话 ID（保持输入顺序，去重由调用方决定）。
     * @returns {Promise<{available: boolean, queueReadable: boolean, unavailableReasons: string[],
     *   verdicts: Map<string, object>}>} 整批事实 + 逐会话结论（形状同 {@link check}）。
     */
    async checkMany(sessionIds) {
      const availability = readAvailabilityFresh();
      const available = availability?.available === true;
      const unavailableReasons = available ? [] : [...(availability?.reasons ?? [])];
      // 一次读文档：readQueue 内部只枚举一次 table.entries()（见 host/session-delete-store）。
      let queueReadable = false;
      let pending = new Set();
      try {
        const snapshot = await store.readQueue();
        if (snapshot?.readable === true) {
          queueReadable = true;
          pending = new Set(Array.isArray(snapshot.keys) ? snapshot.keys : []);
        }
      } catch {
        queueReadable = false;
      }
      const verdicts = new Map();
      for (const raw of sessionIds ?? []) {
        if (typeof raw !== "string" || raw.length === 0) continue;
        const verdict = evaluateDeletionGate({
          available,
          quarantineExists: readQuarantine(raw),
          queueReadable,
          queuePresent: pending.has(raw),
        });
        verdicts.set(raw, { sessionId: raw, ...verdict, unavailableReasons: [...unavailableReasons] });
      }
      return { available, queueReadable, unavailableReasons, verdicts };
    },
    /**
     * 查询某个会话能否开始新的删除作业。
     *
     * @param {string} sessionId - 会话 ID。
     * @returns {Promise<object>} 见 {@link evaluateDeletionGate}，另附 `sessionId` 与 `unavailableReasons`。
     */
    async check(sessionId) {
      const availability = readAvailabilityFresh();
      const queue = await readQueueFacts(sessionId);
      const verdict = evaluateDeletionGate({
        available: availability?.available === true,
        quarantineExists: readQuarantine(sessionId),
        queueReadable: queue.queueReadable,
        queuePresent: queue.queuePresent,
      });
      return {
        sessionId,
        ...verdict,
        unavailableReasons: availability?.available === true ? [] : [...(availability?.reasons ?? [])],
      };
    },
  });
}
