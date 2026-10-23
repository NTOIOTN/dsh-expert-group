/**
 * fan-out 事件日志服务（R2 票据 10：fanout-host 拆为三服务 + coordinator）。
 *
 * ## 单一 owner
 * 本模块独占 manager 事件历史的全部可变状态：`events`（归一后的事件数组）、
 * `eventsAscending`（升序不变式）、`droppedEventCount`（保留窗口累计丢弃数）、
 * `lastEventViolation`（最近一次 restore 预算拒绝）与 `lastEventRestoreAccepted`
 * （最近一次 restore 是否被接受）。其它模块只能经本模块的命令 / 只读投影访问这些状态。
 *
 * ## 不发布事件
 * `rememberEvent()` 只把事件归一后写进日志并**返回**归一结果，不调用 onEvent。
 * 「先入日志、再广播」的发布顺序由 coordinator（`fanout-host.js`）唯一决定，
 * 三个服务都不自行发布或重排事件。
 *
 * ## 为什么事件读取原语也在这里
 * turn 提取 / 终态判定 / 结果提取都是只读 session 与事件对象的无状态纯函数；它们与日志
 * 归一（`normalizeEvent`）共用同一批 JSON 原语（`isObject` / `cloneJson`）。本模块是三个
 * 新服务里唯一没有 fan-out 内部依赖的叶子模块，把共用的 JSON 原语放在这里可以让
 * attribution / lifecycle 单向 import 本模块，而不会形成 ESM 环。
 */
import {
  FANOUT_BUDGET,
  checkEventBudget,
  checkEventHistoryBudget,
  describeBudgetViolation,
  measureJsonBytes,
} from "../resource-budget.js";

/** 事件日志保留窗口（条数）；超出后从队首丢弃并累计 droppedEventCount。 */
export const FANOUT_EVENT_LOG_LIMIT = 1000;

/** 终态 turn 原因词表（`hasTerminalTurnReason` 的只读查找表，初始化后从不修改）。 */
const TERMINAL_TURN_KINDS = new Set(["completed", "success", "succeeded", "ok", "error", "failed", "blocked", "max-tokens", "cancelled", "canceled", "interrupted", "aborted", "timeout", "timed_out"]);

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function eventData(event) {
  return isObject(event?.data) ? event.data : isObject(event) ? event : {};
}

export function turnOf(event) {
  const data = eventData(event);
  return Number.isSafeInteger(data.turn) ? data.turn : undefined;
}

function normalizeEvent(event) {
  return cloneJson(event) ?? {};
}

export function turnReason(event) {
  const data = eventData(event);
  return data.reason ?? data.outcome ?? data.error ?? data;
}

function reasonKind(reason) {
  if (typeof reason === "string") return reason.toLowerCase();
  if (!isObject(reason)) return "error";
  const kind = reason.kind ?? reason.type ?? reason.reason;
  return typeof kind === "string" ? kind.toLowerCase() : "error";
}

function reasonMessage(reason) {
  if (typeof reason === "string") return reason;
  if (isObject(reason)) {
    for (const value of [reason.message, reason.error, reason.detail]) {
      if (typeof value === "string" && value.trim().length > 0) return value;
      if (isObject(value) && typeof value.message === "string" && value.message.trim().length > 0) return value.message;
    }
  }
  return "fan-out child turn 未正常完成";
}

/**
 * 由 turn/end 的 reason 构造结构化完成错误。
 *
 * 放在事件模块是因为它只由「事件原因」推导（reason 归一 + 文案兜底 + 事件快照）；
 * attribution 与 lifecycle 都复用它，避免两处各写一份错误形状。
 */
export function fanoutCompletionError(reason, event) {
  const error = new Error(reasonMessage(reason));
  const kind = reasonKind(reason);
  error.name = "FanoutChildCompletionError";
  error.reason = kind;
  error.event = cloneJson(event);
  if (isObject(reason) && typeof reason.code === "string") error.code = reason.code;
  return error;
}

export function eventIsTurnEnd(event) {
  return event?.type === "turn/end" || event?.type === "turn/ended";
}

export function completionIsSuccess(event) {
  const reason = turnReason(event);
  const kind = reasonKind(reason);
  return kind === "completed" || kind === "success" || kind === "succeeded" || kind === "ok";
}

export function hasTerminalTurnReason(event) {
  const reason = turnReason(event);
  const kind = reasonKind(reason);
  return kind === "" || TERMINAL_TURN_KINDS.has(kind) || isObject(reason) && (reason.error !== undefined || reason.code !== undefined);
}

function resultContent(message) {
  const content = message?.content;
  if (Array.isArray(content) && content.length > 0) return cloneJson(content);
  if (typeof content === "string" && content.trim().length > 0) return [{ type: "text", text: content }];
  return undefined;
}

function chunkText(chunk) {
  if (!isObject(chunk)) return "";
  const direct = typeof chunk.text === "string" ? chunk.text : "";
  if (direct !== "") return direct;
  const delta = typeof chunk.delta === "string" ? chunk.delta : "";
  if (delta !== "") return delta;
  const value = typeof chunk.textDelta === "string" ? chunk.textDelta : "";
  return value;
}

export function sessionEventLog(session) {
  // DSH 的真实 Session 通过 snapshotEvents() 暴露不可变日志；测试夹具与旧兼容对象
  // 可能仍提供 events 数组。续作归属与结果提取必须共用同一事实源，否则真实 child
  // 的 turn/end 会被看到，但找不到本轮 user/message，attempt 就会永久保持 running。
  if (typeof session?.snapshotEvents === "function") {
    const snapshot = session.snapshotEvents();
    if (Array.isArray(snapshot)) return snapshot;
  }
  return Array.isArray(session?.events) ? session.events : [];
}

function eventsForTurn(session, turn) {
  const events = sessionEventLog(session);
  if (!Number.isSafeInteger(turn)) return events;
  let start = -1;
  for (let index = 0; index < events.length; index += 1) {
    const eventTurn = turnOf(events[index]);
    if (eventTurn === turn && (events[index]?.type === "turn/start" || events[index]?.type === "request/header")) start = index;
  }
  return start < 0 ? events.filter((event) => turnOf(event) === turn) : events.slice(start);
}

/**
 * 按 DSH 最终 assistant 输出规则提取结果：最后一个非空 assistant/message
 * 优先；没有 assembled message 时再拼接本轮 assistant/chunk 文本。
 */
export function extractFanoutResult(session, turn) {
  const events = eventsForTurn(session, turn);
  let lastMessage;
  let chunks = "";
  for (const event of events) {
    if (event?.type === "assistant/message") {
      const message = eventData(event).message;
      const content = resultContent(message);
      if (content !== undefined) lastMessage = content;
      continue;
    }
    if (event?.type === "assistant/chunk") chunks += chunkText(eventData(event).chunk);
  }
  if (lastMessage !== undefined) return lastMessage;
  return chunks.trim().length > 0 ? [{ type: "text", text: chunks }] : null;
}

/**
 * 创建事件日志服务（无外部依赖：日志本体是唯一状态，时钟 / manager / logger 都不需要）。
 *
 * @returns {{
 *   rememberEvent: (event: object) => object,
 *   restoreEvents: (restoredEvents: unknown) => boolean,
 *   getEvents: (options?: {after?: number, parentTaskId?: string}) => object,
 *   eventLogStatus: () => object,
 *   count: () => number,
 *   lastViolation: () => object|null,
 * }}
 */
export function createFanoutEventLog() {
  /** 事件日志本体：按到达顺序保存归一后的事件，**不重排**（重排会改变既有返回顺序语义）。 */
  const events = [];
  /**
   * 事件日志是否已知按 sequence 升序（差集读取的快路径前提）。
   *
   * 正常路径下升序成立：实时事件来自 manager 的单一递增 sequence 计数器（按序投递），
   * restoreEvents 会先按 sequence 排序再整体替换。但存在一种真实的降级序列：restoreEvents
   * 已接受历史事件（例如 sequence 100+），而 manager 侧 restore 被推迟或校验失败，
   * 此时新代事件会从 1 重新开始并追加到日志尾部——日志不再升序。
   * 一旦检测到这种乱序，差集读取退回"全量扫描"（与旧实现逐字节等价，只是不再享受
   * 二分定位快路径），因此差集只是快路径，不是新的事实源。
   */
  let eventsAscending = true;
  /** 最近一次 restoreEvents 预算拒绝的结构化违规（只读诊断）。 */
  let lastEventViolation = null;
  /**
   * 事件日志因保留窗口（FANOUT_EVENT_LOG_LIMIT）被 shift 掉的累计条数。
   *
   * 这是"客户端请求的 cursor 已经早于最早可用序号"的 gap 判定的另一半：
   * earliestSequence 表示还能读到什么，dropped 表示已经永久缺失多少条。
   */
  let droppedEventCount = 0;
  /** 最近一次 restoreEvents 是否被接受；undefined 表示本进程尚未尝试恢复。 */
  let lastEventRestoreAccepted;

  /**
   * 归一后追加到日志，**只返回归一结果、不发布**（发布顺序归 coordinator）。
   *
   * 升序不变式：仅当新事件不小于末条时才继续保证升序（乱序即永久关闭快路径，见
   * eventsAscending 的说明；不重排日志，保持"事件按到达顺序返回"的既有语义）。
   */
  function rememberEvent(event) {
    const normalized = normalizeEvent(event);
    if (eventsAscending && events.length > 0) {
      const last = events[events.length - 1].sequence;
      const next = normalized.sequence;
      if (Number.isSafeInteger(last) && Number.isSafeInteger(next) && next < last) eventsAscending = false;
    }
    events.push(normalized);
    while (events.length > FANOUT_EVENT_LOG_LIMIT) {
      events.shift();
      // 保留窗口之外的旧事件永久缺失：getEvents 用 dropped/earliestSequence 暴露这个事实，
      // 客户端据此判断增量同步是否出现 gap（而不是把"读不到"误当成"没有新事件"）。
      droppedEventCount += 1;
    }
    return normalized;
  }

  /**
   * 从持久化快照恢复事件历史（外部输入）。
   *
   * 判定顺序（每一步都在产生大额临时副本之前）：
   * 1. 原始数组长度上限——外部数组可能极大，必须先看 length 再决定是否处理，
   *    否则 filter/sort/map/clone 会先复制一份同样量级的临时数组；
   * 2. 逐个事件的单条字节预算 + JSON 可测量性（不可序列化整体拒绝）；
   * 3. 归一化后的条数与字节总量预算。
   *
   * 任何一项超限都**整体拒绝**并且不改动现有事件（原子失败）——不能像运行时裁剪那样
   * 静默丢弃历史，也不能把超大事件直接写进 events。
   *
   * 既有契约保持不变：非数组返回 false；含非法项的数组仍按"过滤掉非法项"处理
   * （sequence 非正整数、非对象项、缺失 sequence 都被忽略）。
   *
   * @param {object[]} restoredEvents
   * @returns {boolean} 接受并替换返回 true；非法输入或超预算返回 false。
   */
  function restoreEvents(restoredEvents) {
    if (!Array.isArray(restoredEvents)) return finishRestoreEvents(false);
    // 1. 先看原始长度：超限立即拒绝，不进入任何逐元素处理。
    if (restoredEvents.length > FANOUT_EVENT_LOG_LIMIT) {
      lastEventViolation = describeRestoreEventsViolation(restoredEvents.length);
      return finishRestoreEvents(false);
    }
    // 2. 单条事件：字节预算 + 可测量性（不可序列化不能当"未知体积"放过）。
    for (const event of restoredEvents) {
      if (!isObject(event)) continue;
      if (measureJsonBytes(event) === null) {
        lastEventViolation = describeRestoreEventsUnmeasurableViolation();
        return finishRestoreEvents(false);
      }
      const single = checkEventBudget(event, { subject: "restoreEvents" });
      if (single.ok) continue;
      lastEventViolation = single.violation;
      return finishRestoreEvents(false);
    }
    const normalized = restoredEvents
      .filter((event) => isObject(event) && Number.isSafeInteger(event.sequence) && event.sequence > 0)
      .sort((left, right) => left.sequence - right.sequence)
      .map(normalizeEvent);
    // 3. 归一化后的字节总量：合法但超限的输入整体拒绝，不静默裁剪。
    const history = checkEventHistoryBudget(normalized, {
      maxCount: FANOUT_EVENT_LOG_LIMIT,
      maxBytes: FANOUT_BUDGET.maxEventHistoryBytes,
    });
    if (history.droppedCount > 0 || normalized.length > FANOUT_EVENT_LOG_LIMIT) {
      lastEventViolation = history.violation ?? describeRestoreEventsViolation(normalized.length);
      return finishRestoreEvents(false);
    }
    events.splice(0, events.length, ...normalized);
    // 归一化后是整体按 sequence 升序的日志，快路径前提重新成立。
    eventsAscending = true;
    lastEventViolation = null;
    return finishRestoreEvents(true);
  }

  /**
   * 记录 restoreEvents 的最终结果（供 index 冷启动消费 + 诊断读取）。
   *
   * 恢复失败的事实不再只藏在返回值里：lastEventRestoreAccepted 与 lastEventViolation
   * 会随 eventLogStatus() 暴露，index.js 也会在冷启动时记录告警。
   */
  function finishRestoreEvents(accepted) {
    lastEventRestoreAccepted = accepted === true;
    return lastEventRestoreAccepted;
  }

  /**
   * 恢复事件不可 JSON 序列化时的结构化违规（整体拒绝，不写原始负载）。
   *
   * 统一走 describeBudgetViolation：旧实现手写字段，缺 label/subject/hint，且把条数
   * 上限塞进 maxBytes，诊断消费者无法与其它预算违规归一处理。
   */
  function describeRestoreEventsUnmeasurableViolation() {
    return describeBudgetViolation({
      resource: "event_history",
      limit: FANOUT_BUDGET.maxEventHistory,
      receivedBytes: null,
      measured: false,
      recoverable: false,
      subject: "restoreEvents",
      hint: "恢复事件含不可 JSON 序列化的负载，已整体拒绝（不改动现有事件历史）",
    });
  }

  /** 恢复事件条数超限时的结构化违规（与 history 字节违规共用同一 code/resource）。 */
  function describeRestoreEventsViolation(count) {
    return describeBudgetViolation({
      resource: "event_history",
      limit: FANOUT_BUDGET.maxEventHistory,
      receivedBytes: count,
      recoverable: false,
      subject: "restoreEvents",
      hint: "恢复事件条数超过事件历史预算，已整体拒绝；请先清理持久化快照中的事件",
    });
  }

  /**
   * 二分定位第一条 sequence > cursor 的事件下标（调用方保证日志升序）。
   *
   * sequence 缺失/非整数的事件按 0 处理：它们本来就被 `sequence > cursor` 排除
   * （cursor 恒为非负整数），因此不会影响正确性。
   */
  function firstIndexAfterCursor(cursor) {
    let low = 0;
    let high = events.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((events[mid].sequence ?? 0) > cursor) high = mid;
      else low = mid + 1;
    }
    return low;
  }

  /**
   * 按游标读取事件差集。
   *
   * 与旧实现（对全部事件 filter + 逐条深拷贝）语义逐字段等价，但只扫描游标之后的事件、
   * 只对差集做深拷贝：升序日志下先二分定位起点，读取成本与"新增事件数"成正比，不再随
   * 历史长度线性增长（日志最多保留 FANOUT_EVENT_LOG_LIMIT 条）。
   *
   * 语义保持：
   * - 返回顺序仍是日志顺序（升序快路径下即 sequence 升序），不重排；
   * - parentTaskId 过滤、`sequence > cursor` 判定不变；
   * - nextSequence 仍取"传入游标"与"日志末条 sequence"的较大者：空日志返回游标本身，
   *   因此历史被截断后，游标 0 的新客户端依然会重读全部保留事件（不会因为首条 sequence
   *   大于游标而漏读），而已推进的游标不会倒退。
   * - 乱序日志（eventsAscending=false）退回从 0 开始的全量扫描，结果与旧实现一致。
   */
  function getEvents({ after = 0, parentTaskId } = {}) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    const start = eventsAscending ? firstIndexAfterCursor(cursor) : 0;
    const batch = [];
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      // 与旧实现的判定逐字一致（非整数/缺失 sequence 一律视为不满足 > cursor）；
      // 升序快路径下这里恒为真，只有乱序兜底路径才会真正过滤。
      if (!(event.sequence > cursor)) continue;
      if (parentTaskId !== undefined && event.parentTaskId !== parentTaskId) continue;
      batch.push(normalizeEvent(event));
    }
    // gap 判定基于**全局**日志（与 parentTaskId 过滤无关）：过滤只减少本次返回条数，
    // 不能改变"这段历史已经缺失"的事实。最早序号=1 时它前面不存在事件（sequence 从 1
    // 开始），因此 cursor=0 也不算缺口；只有确实裁剪过队首（earliest > 1）才标记 gap。
    const earliestSequence = earliestEventSequence();
    const gap = earliestSequence !== null && earliestSequence > 1 && cursor < earliestSequence;
    return {
      events: batch,
      nextSequence: events.length === 0 ? cursor : Math.max(cursor, events[events.length - 1].sequence ?? cursor),
      earliestSequence,
      gap,
      dropped: droppedEventCount,
    };
  }

  /** 当前事件日志中最早一条有效 sequence（日志为空/无有效序号时返回 null）。 */
  function earliestEventSequence() {
    if (eventsAscending) {
      for (const event of events) {
        if (Number.isSafeInteger(event?.sequence) && event.sequence > 0) return event.sequence;
      }
      return null;
    }
    // 乱序兜底路径：日志不再按到达顺序单调，必须全量取最小，否则 gap 会基于错误的
    // "最早序号"判断（只在降级模式下付出 O(n)，正常路径仍是 O(1)）。
    let earliest = null;
    for (const event of events) {
      const sequence = event?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
      if (earliest === null || sequence < earliest) earliest = sequence;
    }
    return earliest;
  }

  /**
   * 事件日志只读状态（诊断/契约测试用）。
   *
   * 与 getEvents 的区别：不触发差集扫描、不返回事件正文，只回答"保留窗口内最早能读到
   * 什么、累计丢了多少、最近一次恢复事件是否被接受"。
   */
  function eventLogStatus() {
    return Object.freeze({
      count: events.length,
      earliestSequence: earliestEventSequence(),
      dropped: droppedEventCount,
      ascending: eventsAscending,
      restoreAccepted: lastEventRestoreAccepted === undefined ? null : lastEventRestoreAccepted,
      lastViolation: lastEventViolation === null ? null : cloneJson(lastEventViolation),
    });
  }

  return {
    rememberEvent,
    restoreEvents,
    getEvents,
    eventLogStatus,
    /** 只读投影：当前日志条数（coordinator 的 budget 视图用）。 */
    count: () => events.length,
    /** 只读投影：最近一次 restore 预算违规（null 表示没有）。 */
    lastViolation: () => lastEventViolation,
  };
}
