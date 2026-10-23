/**
 * fan-out 事件总线（R3-14：从组合根 fanout.js 的 "event bus" 工厂整段迁出）。
 *
 * ## 职责与状态所有权（C5）
 * 独占事件序号、事件历史与其增量字节记账、订阅者集合、累计丢弃数与预算违规诊断。
 * 历史容器与订阅者集合不出本工厂：对外只有 emit / 只读投影 / 恢复期整段替换命令。
 *
 * ## 迁移说明（R3-14）
 * 只做**代码搬迁**：函数体、注释、返回面逐行不变，仅补充本文件所需的 import 与 export 关键字，
 * 使组合根 fanout.js 得以变成纯 re-export 门面（C4 兼容门面豁免）。
 *
 * @module dsh-expert-group/fanout/events
 */
import {
  FANOUT_BUDGET,
  checkBudget,
  createEventHistoryAccounting,
  measureJsonBytes,
} from "../resource-budget.js";
import { FanoutValidationError, cloneJson } from "./validation.js";

export function createFanoutEventBus({ store, clock, isClosed }) {
  const { now } = clock;
  const budgetPolicy = FANOUT_BUDGET;
  let sequence = 0;
  const eventHistory = [];
  const eventAccounting = createEventHistoryAccounting({
    maxCount: budgetPolicy.maxEventHistory,
    maxBytes: budgetPolicy.maxEventHistoryBytes,
  });
  const subscribers = new Set();
  let droppedEventCount = 0;
  let lastBudgetViolation = null;
  let lastBudgetViolationPhase = null;
  let budgetEventDepth = 0;

  /**
   * 发布一条事件。监听器抛错只影响自己，不能破坏调度。
   *
   * 单事件字节预算：原始负载过大时只发布"不含负载"的诊断事件，既不让事件历史
   * 无界增长，也不静默丢失事实（诊断保留 type/subject/resource 与实测字节）。
   *
   * 性能：内容与体积来自同一次 stringify；进入历史时把字节数交给增量记账器，
   * 之后不再对整段历史重复测量（旧的 O(n²) 测量已在票据 04 移除）。
   */
  function emit(event) {
    const candidate = { ...event, sequence: ++sequence, at: now() };
    // 单次序列化同时得到"内容"（parse 回来作为历史条目）与"体积"（单事件预算 +
    // 事件历史增量记账）。serialized=null 表示不可 JSON 序列化。
    let serialized;
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      serialized = null;
    }
    const candidateBytes = serialized === null ? null : Buffer.byteLength(serialized, "utf8");
    const verdict = checkBudget({
      resource: "event",
      limit: budgetPolicy.maxEventBytes,
      receivedBytes: candidateBytes,
      subject: candidate.type,
    });
    if (!verdict.ok) {
      // 事件超预算只发布不含原始负载的诊断事件。这里刻意**不**补发 budget_rejected：
      // 事件预算是热路径，"为超预算事件再发一条事件"会递归放大历史。
      noteBudgetViolation(verdict.violation, "event", { emitEvent: false });
      const diagnostic = {
        type: "event_budget_exceeded",
        subject: typeof candidate.type === "string" ? candidate.type : "event",
        parentTaskId: candidate.parentTaskId,
        violation: verdict.violation,
        sequence: sequence,
        at: now(),
      };
      appendEvent(diagnostic);
      notifyEventSubscribers(diagnostic);
      return diagnostic;
    }
    const stored = JSON.parse(serialized);
    appendEvent(stored, candidateBytes);
    notifyEventSubscribers(stored);
    return candidate;
  }

  /** 通知事件订阅者；单个订阅者异常必须被隔离，不能破坏调度。 */
  function notifyEventSubscribers(event) {
    for (const listener of [...subscribers]) {
      try {
        listener(cloneJson(event));
      } catch {
        // 订阅者异常必须被隔离：fan-out 的调度语义不依赖任何监听器。
      }
    }
  }

  /**
   * 追加事件并维护历史预算（条数 + 字节）。
   *
   * 事件对象进入历史后不再变更，因此 size 只测一次；trim 只从最旧一端丢弃，
   * 成本与丢弃条数成正比。裁剪本身不发布 budget_rejected（它由每条新事件触发，
   * 发事件会形成"事件→裁剪→事件"的无限反馈）；事实通过 dropped/最早序号暴露。
   */
  function appendEvent(event, knownBytes) {
    const bytes = knownBytes === undefined ? (measureJsonBytes(event) ?? 0) : knownBytes;
    eventHistory.push(event);
    eventAccounting.push(bytes);
    trimEventHistory();
  }

  /**
   * 记录预算违规（只读诊断 + 可选的结构化 budget_rejected 事件）。
   *
   * 统一事件契约（所有运行期入口共用）：
   * - type=budget_rejected、phase、violation（与错误/RPC 同源的结构化描述）；
   * - parentTaskId/subject 可选；sequence/at 由 emit 统一补齐；
   * - 事件只带元数据，绝不复述被拒绝的 prompt/result/error 原文或完整快照。
   *
   * @param {object} violation - describeBudgetViolation 产出的违规描述。
   * @param {string} phase - submit/retry/continue/attempt/event/snapshot/persist/serialize/restore/feedback。
   * @param {{emitEvent?:boolean, parentTaskId?:string}} [options]
   */
  function noteBudgetViolation(violation, phase = "runtime", { emitEvent = true, parentTaskId } = {}) {
    if (violation === null || violation === undefined) return;
    lastBudgetViolation = cloneJson(violation);
    lastBudgetViolationPhase = phase;
    if (!emitEvent) return;
    emitBudgetRejected(violation, phase, parentTaskId);
  }

  /** 发布一条 budget_rejected 事件（带递归闸；裁剪/事件预算路径以 emitEvent:false 跳过）。 */
  function emitBudgetRejected(violation, phase, parentTaskId) {
    if (budgetEventDepth > 0) return;
    budgetEventDepth += 1;
    try {
      emit({
        type: "budget_rejected",
        phase,
        violation: cloneJson(violation),
        ...(typeof parentTaskId === "string" && parentTaskId.length > 0 ? { parentTaskId } : {}),
        ...(typeof violation?.subject === "string" && violation.subject.length > 0 ? { subject: violation.subject } : {}),
      });
    } finally {
      budgetEventDepth -= 1;
    }
  }

  /**
   * 事件历史的条数/字节双预算：条数保留既有 1000 条契约，字节超出时继续丢弃最旧
   * 记录。两条预算同时生效，结果取更小的保留集合。
   */
  function trimEventHistory() {
    const verdict = eventAccounting.trim();
    if (verdict.droppedCount === 0) return;
    eventHistory.splice(0, verdict.droppedCount);
    droppedEventCount += verdict.droppedCount;
    noteBudgetViolation(verdict.violation, "event", { emitEvent: false });
  }

  /** 事件历史中最早仍可读的 sequence；空历史返回 null。 */
  function earliestAvailableSequence() {
    return eventHistory.length === 0 ? null : eventHistory[0].sequence ?? null;
  }

  /**
   * 整体替换事件历史后重建增量记账（restore 冷路径）。
   *
   * 每条事件只在这里测量一次；此后 emit 的增量记账与预算判定仍走同一套记账器，
   * 不会因为恢复而出现第二套字节口径。
   */
  function rebuildEventAccounting() {
    eventAccounting.reset();
    for (const event of eventHistory) eventAccounting.push(measureJsonBytes(event) ?? 0);
  }

  /** 事件历史只读状态：条数/字节/累计丢弃/最早可用序号（gap 判定用）。 */
  function eventHistoryStatus() {
    return Object.freeze({
      count: eventHistory.length,
      bytes: eventAccounting.bytes,
      dropped: droppedEventCount,
      earliestSequence: earliestAvailableSequence(),
    });
  }

  function emitShardStatus(task, shard, status, attempt, extra = {}) {
    return emit({
      type: "shard_status_changed",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt,
      status,
      role: task.role,
      counts: store.computeCounts(task),
      ...extra,
    });
  }

  /** 订阅状态变化事件；返回退订函数。事件按真实发生顺序同步发布。 */
  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new FanoutValidationError("INVALID_LISTENER", "listener 必须是函数");
    }
    if (isClosed()) return () => {};
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  }

  // ── 只读投影与恢复期命令（容器不出本工厂） ──
  function sequenceValue() { return sequence; }
  function setSequence(value) { sequence = value; }
  function historyCount() { return eventHistory.length; }
  function historyEvents() { return [...eventHistory]; }
  function historyBytes() { return eventAccounting.bytes; }
  function addDropped(count) { droppedEventCount += count; }
  function clearSubscribers() { subscribers.clear(); }
  function mergeRestoredHistory(restoredEvents) {
    const knownSequences = new Set(eventHistory.map((event) => event.sequence));
    for (const event of restoredEvents) {
      if (!knownSequences.has(event.sequence)) eventHistory.push(event);
    }
    eventHistory.sort((left, right) => left.sequence - right.sequence);
    rebuildEventAccounting();
    trimEventHistory();
  }
  function replaceRestoredHistory(restoredEvents) {
    eventHistory.splice(0, eventHistory.length, ...restoredEvents);
    rebuildEventAccounting();
    // 快照已由 checkRestoreBudget 校验过条数/字节，这里仍走同一条裁剪路径：
    // 防御旧快照/直接调用 restore 的输入，同时保持 dropped 统计与运行时一致。
    trimEventHistory();
  }
  function budgetDiagnostics() {
    return Object.freeze({
      lastViolation: lastBudgetViolation === null ? null : cloneJson(lastBudgetViolation),
      lastViolationPhase: lastBudgetViolationPhase,
    });
  }

  return Object.freeze({
    emit,
    notifyEventSubscribers,
    appendEvent,
    trimEventHistory,
    earliestAvailableSequence,
    rebuildEventAccounting,
    eventHistoryStatus,
    emitShardStatus,
    subscribe,
    noteBudgetViolation,
    emitBudgetRejected,
    sequenceValue,
    setSequence,
    historyCount,
    historyEvents,
    historyBytes,
    addDropped,
    clearSubscribers,
    mergeRestoredHistory,
    replaceRestoredHistory,
    budgetDiagnostics,
  });
}
