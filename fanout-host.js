/**
 * Host 侧 fan-out 适配器。
 *
 * fanout.js 只负责可测试的调度状态机，本模块负责把一个 shard attempt
 * 映射到独立的 DSH continuable child。agent/created 只补齐 child/session
 * 句柄；只有 session/event 的 turn/end 才能 resolve/reject completion。
 *
 * close() 与异步 admission 的竞态边界：关闭后不再进入 buildRequest/startContinuable；
 * 还在 buildRequest 阶段的 admission 会同步以关闭错误收敛，已经挂在 startContinuable
 * 上的 launcher 若之后才拿到 childId，只对该 child 发出一次 interrupt，并用显式关闭错误
 * （FanoutClosedError / runtime_closed）一次性收敛 completion。
 *
 * close() 同时复用 fanout.js 的 manager.close 作为共享关闭门：runtime 单独关闭后，
 * 通过公开 runtime.manager.submit/retryShard/restore 发起的新操作一律结构化失败
 * （MANAGER_CLOSED / manager_closed），不入队、不恢复、不新建 attempt。
 */
import { createFanoutManager } from "./fanout.js";
import { FANOUT_BUDGET, checkEventBudget, checkEventHistoryBudget, checkTaskInputBudget, describeBudgetViolation, measureJsonBytes } from "./resource-budget.js";
import { messageIdsOfTurn } from "./shared.js";

export const FANOUT_MARKER = "__degFanout";
export const FANOUT_PARENT_TASK_MARKER = "__degFanoutParentTaskId";
export const FANOUT_PARENT_AGENT_MARKER = "__degFanoutParentAgentId";
export const FANOUT_SHARD_MARKER = "__degFanoutShardId";
export const FANOUT_ATTEMPT_MARKER = "__degFanoutAttempt";
export const FANOUT_EVENT_LOG_LIMIT = 1000;

const TERMINAL_TURN_KINDS = new Set(["completed", "success", "succeeded", "ok", "error", "failed", "blocked", "max-tokens", "cancelled", "canceled", "interrupted", "aborted", "timeout", "timed_out"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function nonEmptyText(value) {
  const text = textOf(value);
  return text.trim().length > 0 ? text : "";
}

function eventData(event) {
  return isObject(event?.data) ? event.data : isObject(event) ? event : {};
}

function turnOf(event) {
  const data = eventData(event);
  return Number.isSafeInteger(data.turn) ? data.turn : undefined;
}

function markerOptions(agent) {
  if (isObject(agent?.options)) return agent.options;
  if (isObject(agent?.agentOptions)) return agent.agentOptions;
  return {};
}

function markerText(options, key) {
  const value = options?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function attemptValue(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function markerAttempt(options) {
  return attemptValue(options?.[FANOUT_ATTEMPT_MARKER]);
}

export function fanoutAttemptKey(parentTaskId, shardId, attempt) {
  return [String(parentTaskId), String(shardId), String(attempt)].join("\u001f");
}

/**
 * fan-out 身份的四个可比较字段：预检要求 marker 与持久化身份在这些字段上逐字一致
 * （不做字段级合并，否则冲突会被静默取一方，等于放行伪造 marker）。
 */
const FANOUT_IDENTITY_FIELDS = Object.freeze(["parentTaskId", "parentAgentId", "shardId", "attempt"]);

function markerFanoutIdentity(options) {
  if (options?.[FANOUT_MARKER] !== true) return undefined;
  const parentTaskId = markerText(options, FANOUT_PARENT_TASK_MARKER);
  const parentAgentId = markerText(options, FANOUT_PARENT_AGENT_MARKER);
  const shardId = markerText(options, FANOUT_SHARD_MARKER);
  const attempt = markerAttempt(options);
  if (parentTaskId === undefined || parentAgentId === undefined || shardId === undefined || attempt === undefined) return undefined;
  return { parentTaskId, parentAgentId, shardId, attempt };
}

/**
 * 只信任显式标记且字段完整的持久化记录；普通 child 的 role/parentId 不足以证明
 * 它来自 fan-out，避免 cold-resume 把普通专家误路由到 fan-out 状态机。
 */
function persistedFanoutIdentity(record) {
  if (!isObject(record) || record.fanout !== true) return undefined;
  const parentTaskId = nonEmptyText(record.fanoutParentTaskId ?? record.parentTaskId);
  const parentAgentId = nonEmptyText(record.fanoutParentAgentId ?? record.parentId);
  const shardId = nonEmptyText(record.fanoutShardId ?? record.shardId);
  const attempt = attemptValue(record.fanoutAttempt ?? record.attempt);
  if (parentTaskId === "" || parentAgentId === "" || shardId === "" || attempt === undefined) return undefined;
  return { parentTaskId, parentAgentId, shardId, attempt };
}

export function isFanoutIdentity(record) {
  return persistedFanoutIdentity(record) !== undefined;
}

function fanoutIdentityOf(agent, persistedIdentity) {
  return markerFanoutIdentity(markerOptions(agent)) ?? persistedFanoutIdentity(persistedIdentity);
}

/** 判断 agent 是否携带完整 fan-out marker 或可信 cold-resume 身份。 */
export function isFanoutAgent(agent, persistedIdentity) {
  return fanoutIdentityOf(agent, persistedIdentity) !== undefined;
}

function resultContent(message) {
  const content = message?.content;
  if (Array.isArray(content) && content.length > 0) return cloneJson(content);
  if (typeof content === "string" && nonEmptyText(content) !== "") return [{ type: "text", text: content }];
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

function sessionEventLog(session) {
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

function turnReason(event) {
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

function fanoutCompletionError(reason, event) {
  const error = new Error(reasonMessage(reason));
  const kind = reasonKind(reason);
  error.name = "FanoutChildCompletionError";
  error.reason = kind;
  error.event = cloneJson(event);
  if (isObject(reason) && typeof reason.code === "string") error.code = reason.code;
  return error;
}

/**
 * 运行时关闭的显式错误。
 *
 * 与 fanout.js 的 manager_closed 语义对齐：runtime.close() 可能晚于 manager 关闭，
 * 也可能在 manager 仍开放时单独到达；launcher 拒绝与 completion 结算都使用可结构化
 * 分支的 name/code/reason，调用方不需要解析文案。
 */
function fanoutRuntimeClosedError(message = "fan-out runtime 已关闭") {
  const error = new Error(message);
  error.name = "FanoutClosedError";
  error.code = "RUNTIME_CLOSED";
  error.reason = "runtime_closed";
  return error;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // manager 会消费 completion，但 launch 失败时可能没有 handle；预先挂载 noop
  // rejection handler，避免取消/销毁竞态制造 unhandled rejection。
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * 在途 admission 句柄（可控 thenable）。
 *
 * manager 只按 Promise 语义消费 launcher 的返回值（fanout.js 的 startShard 会调用
 * `launched.then(onFulfilled, onRejected)`），而原生 Promise 的结算只能异步投递。
 * runtime.close() 必须在**同一个同步栈内**把关闭错误交给 manager：否则紧随其后的
 * manager.close()（共享关闭门）会先把仍处于 running 的 attempt 扫成
 * cancelled(manager_closed)，本模块的关闭原因（runtime_closed / FanoutClosedError）
 * 就丢了终态。
 *
 * 因此这里返回一个最小 thenable：
 * - 正常结算与守卫失败走 resolve/reject，按 Promise 语义（microtask）异步投递，
 *   与原来的 async launcher 时序一致；
 * - 关闭路径走 settleNow()，同步投递，保证仍在 buildRequest 阶段的 attempt 在 manager
 *   关闭前先进入 failed(runtime_closed) 终态；
 * - 同时提供 then/catch：await、Promise.race 与 assert.rejects 都按函数存在性识别
 *   Promise-like（assert.rejects 额外要求 catch 存在），缺少任何一个都会让调用方报错。
 */
function createAdmissionHandle() {
  let settled = false;
  let fulfilled = false;
  let value;
  let failure;
  let flushScheduled = false;
  /** 已注册的订阅者（manager 的启动结果回调）。 */
  const reactions = [];

  function deliver(reaction, ok, payload) {
    try {
      if (ok) {
        if (typeof reaction.onFulfilled === "function") reaction.onFulfilled(payload);
      } else if (typeof reaction.onRejected === "function") {
        reaction.onRejected(payload);
      }
    } catch {
      // 订阅者异常属于 manager 侧；不能反向破坏 runtime 的关闭流程。
    }
  }

  /** synchronous=true 立即投递（关闭路径），否则按 Promise 语义排到 microtask。 */
  function flush(synchronous) {
    if (!settled || reactions.length === 0) return;
    if (!synchronous) {
      if (flushScheduled) return;
      flushScheduled = true;
      queueMicrotask(() => {
        flushScheduled = false;
        flush(true);
      });
      return;
    }
    const pending = reactions.splice(0, reactions.length);
    for (const reaction of pending) deliver(reaction, fulfilled, fulfilled ? value : failure);
  }

  function settle(ok, payload) {
    if (settled) return false;
    settled = true;
    fulfilled = ok;
    if (ok) value = payload;
    else failure = payload;
    flush(false);
    return true;
  }

  return {
    then(onFulfilled, onRejected) {
      reactions.push({ onFulfilled, onRejected });
      flush(false);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
    resolve(payload) {
      return settle(true, payload);
    },
    reject(error) {
      return settle(false, error);
    },
    /**
     * 关闭路径专用：同步投递关闭错误。
     * 只在 admission 还没有把任何 child 句柄交给 manager 时调用（record.phase === "build"），
     * 否则会改变「迟到 childId 仍返回句柄」的既有语义。已结算时是幂等 no-op。
     */
    settleNow(error) {
      if (settled) return false;
      settled = true;
      fulfilled = false;
      failure = error;
      flush(true);
      return true;
    },
  };
}

function childIdOf(value) {
  if (!isObject(value)) return undefined;
  const childId = typeof value.childId === "string" ? value.childId : value.subagentId;
  return typeof childId === "string" && childId.length > 0 ? childId : undefined;
}

/**
 * 续作启动阶段的结构化失败（无有效 messageId / messageId 与旧轮重复 / 找不到既有 child）。
 *
 * 这些失败与 launcher 的启动失败走同一条路径（manager 记为本轮 attempt 的启动失败），
 * 但错误本身带 code/reason，便于 Host、RPC 与测试区分「没有真正开始的一轮」。
 */
function continuationStartupError(reason, childId, message) {
  const error = new Error(message + "（childId: " + String(childId) + "）");
  error.name = "FanoutContinuationStartupError";
  error.code = "FANOUT_CONTINUATION_STARTUP_FAILED";
  error.reason = reason;
  error.childId = childId;
  return error;
}

function messageIdOf(value) {
  return isObject(value) && typeof value.messageId === "string" && value.messageId.length > 0
    ? value.messageId
    : undefined;
}

function sessionIdOf(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  const agentId = agent?.id;
  return typeof agentId === "string" && agentId.length > 0 ? agentId : undefined;
}

function eventIsTurnEnd(event) {
  return event?.type === "turn/end" || event?.type === "turn/ended";
}

function completionIsSuccess(event) {
  const reason = turnReason(event);
  const kind = reasonKind(reason);
  return kind === "completed" || kind === "success" || kind === "succeeded" || kind === "ok";
}

function hasTerminalTurnReason(event) {
  const reason = turnReason(event);
  const kind = reasonKind(reason);
  return kind === "" || TERMINAL_TURN_KINDS.has(kind) || isObject(reason) && (reason.error !== undefined || reason.code !== undefined);
}

function normalizeEvent(event) {
  return cloneJson(event) ?? {};
}

/**
 * 创建 Host 适配器和共享 fan-out manager。
 *
 * buildRequest 必须返回 { request, parentAgent?, role?, parentId? }，request 会
 * 原样交给 startContinuable。startContinuable 的返回值可用 childId 或 subagentId。
 *
 * 多轮复用（continuation）另需：
 * - `continueMessage({ childId, parentAgent, input, signal })`：把本轮 prompt 投递给**同一
 *   child** 并返回新的 messageId（生产走 subagents.sendMessage）；缺失时续作 admission
 *   一律失败，绝不静默新建 child；
 * - `resolveChildSession(childId)`：解析既有 child 的 session（用于把本轮 attempt 绑定到
 *   该 session，让它的 turn/end 结算本轮）。缺失时退回 runtime 内部的有界索引；
 * - `parentAgentOf(parentTaskId)`：解析父任务所属的 exact root Agent（投递需要父权限）。
 */
export function createFanoutRuntime(options = {}) {
  if (!isObject(options)) throw new TypeError("createFanoutRuntime 需要配置对象");
  if (typeof options.buildRequest !== "function") throw new TypeError("fan-out buildRequest 必须是函数");
  if (typeof options.startContinuable !== "function") throw new TypeError("fan-out startContinuable 必须是函数");
  if (options.continueMessage !== undefined && options.continueMessage !== null && typeof options.continueMessage !== "function") {
    throw new TypeError("fan-out continueMessage 必须是函数");
  }
  if (options.resolveChildSession !== undefined && options.resolveChildSession !== null && typeof options.resolveChildSession !== "function") {
    throw new TypeError("fan-out resolveChildSession 必须是函数");
  }

  const records = new Map();
  const childRecords = new Map();
  const sessionRecords = new Map();
  /**
   * childId -> session 的有界索引（多轮复用解析既有 child 用）。
   *
   * 与 childRecords 的区别：childRecords 只覆盖**活动 attempt**（终态即摘除），而复用需要在
   * 上一轮已结算之后仍然找到同一个 child 的 session。索引有界：LRU 淘汰最旧的 child，
   * 淘汰后若宿主提供 resolveChildSession 仍可解析，否则续作 fail-closed。
   */
  const childSessions = new Map();
  const CHILD_SESSION_LIMIT = FANOUT_EVENT_LOG_LIMIT;
  // 终态后仍保留最近见过的 fan-out session/child id，确保迟到 turn/end
  // 继续短路旧 recovery listener，而不会因 record 已结算而误路由。
  const knownIds = new Set();
  const knownIdOrder = [];
  const KNOWN_ID_LIMIT = FANOUT_EVENT_LOG_LIMIT * 4;
  // id 索引有界：长时间会话里最早 child 的 id 会被 LRU 驱逐，驱逐后仅靠 id 无法再识别
  // 迟到事件（fail-open：旧 recovery listener 会把终态 fan-out child 当成普通恢复 child）。
  // session 实例是 WeakSet 的键——弱引用不阻止 GC、不随会话数量增长内存，只要事件还在
  // 投递，session 实例就一定可达，成员关系因此仍然成立。
  const fanoutSessions = new WeakSet();
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
  let closed = false;

  // 终态/关闭后 record 会被删除，但 manager 的迟到 canceller、或 admission 恢复路径
  // 仍可能带着同一个 childId 再次请求取消；用有界的 attempt key 集合维持
  // “同一 attempt 最多 interrupt 一次”的边界（record 存活时仍以 record 上的标记为准）。
  const interruptedKeys = new Set();
  const interruptedKeyOrder = [];

  function rememberInterruptedKey(key) {
    if (interruptedKeys.has(key)) return;
    interruptedKeys.add(key);
    interruptedKeyOrder.push(key);
    while (interruptedKeyOrder.length > KNOWN_ID_LIMIT) interruptedKeys.delete(interruptedKeyOrder.shift());
  }

  /** 从 launcher/canceller 的 input 还原 attempt key；字段不完整时返回 undefined。 */
  function attemptKeyFromInput(input) {
    const parentTaskId = nonEmptyText(input?.parentTaskId);
    const shardId = nonEmptyText(input?.shardId);
    const attempt = attemptValue(input?.attempt);
    return parentTaskId === "" || shardId === "" || attempt === undefined
      ? undefined
      : fanoutAttemptKey(parentTaskId, shardId, attempt);
  }

  function rememberKnownId(value) {
    if (typeof value !== "string" || value.length === 0 || knownIds.has(value)) return;
    knownIds.add(value);
    knownIdOrder.push(value);
    while (knownIdOrder.length > KNOWN_ID_LIMIT) knownIds.delete(knownIdOrder.shift());
  }

  /** 登记 childId -> session（有界 LRU），供多轮复用解析既有 child。 */
  function rememberChildSession(childId, session) {
    if (typeof childId !== "string" || childId.length === 0 || !isObject(session)) return;
    if (childSessions.has(childId)) childSessions.delete(childId);
    childSessions.set(childId, session);
    while (childSessions.size > CHILD_SESSION_LIMIT) {
      const oldest = childSessions.keys().next();
      if (oldest.done === true) break;
      childSessions.delete(oldest.value);
    }
  }

  /**
   * 解析既有 child 的 session：优先宿主注入的解析器（覆盖 cold-resume 换实例的形态），
   * 其次 runtime 自己的有界索引。都拿不到时返回 undefined——续作路径不因此失败，
   * 而是先按 childId 绑定会话路由，由 sendMessage 决定该 child 是否真的可继续。
   */
  function continuationSession(childId) {
    if (typeof options.resolveChildSession === "function") {
      let resolved;
      try {
        resolved = options.resolveChildSession(childId);
      } catch (error) {
        log("fan-out resolveChildSession failed", error);
        resolved = undefined;
      }
      if (isObject(resolved)) return resolved;
    }
    const indexed = childSessions.get(childId);
    return isObject(indexed) ? indexed : undefined;
  }

  /**
   * 首轮（launcher）attempt 的 turn 归属判定：**保持既有宽松 fallback**。
   *
   * 一个 child 只有一个 launcher attempt，会话级 turn/end 足以认领它；messageId 缺失或该
   * turn 没有可读 user/message 记录时按旧行为结算（不因为新增防线而让既有路径失效）。
   */
  function turnMatchesRecordMessage(record, session, event) {
    const messageId = nonEmptyText(record?.messageId);
    if (messageId === "") return true;
    const turn = turnOf(event);
    if (!Number.isSafeInteger(turn)) return true;
    const ids = messageIdsOfTurn(sessionEventLog(session), turn);
    if (ids.size === 0) return true;
    return ids.has(messageId);
  }

  /**
   * continuation attempt 的 turn 归属判定：**严格证明，不允许任何 fallback**。
   *
   * 多轮复用让多个 attempt 落在同一个 child/session 上，因此必须同时满足：
   * 1. event turn 是有效安全整数；
   * 2. 该 turn 的 user/message id 集合非空（可读的归属证据）；
   * 3. 集合明确包含本轮 admission 返回的 messageId；
   * 4. 该 messageId 与该 attempt 在 manager 里绑定的 messageId 完全一致。
   *
   * 任何一条不成立都返回结构化原因，由调用方保持 attempt 未结算并记录诊断——
   * 旧轮迟到 turn/end、缺 messageId、归属不可读都不会被当成新一轮的终态。
   */
  function continuationAttribution(record, session, event) {
    const turn = turnOf(event);
    if (!Number.isSafeInteger(turn) || turn <= 0) return { ok: false, reason: "invalid_turn" };
    const messageId = nonEmptyText(record?.messageId);
    if (messageId === "") return { ok: false, reason: "continuation_message_id_missing", turn };
    const ids = messageIdsOfTurn(sessionEventLog(session), turn);
    if (ids.size === 0) return { ok: false, reason: "turn_message_ids_unavailable", turn };
    if (!ids.has(messageId)) return { ok: false, reason: "message_id_mismatch", turn, messageId };
    // manager 是 attempt 绑定值的权威来源：读不到或读到别的 id 都按「无法证明归属」处理。
    const bound = typeof manager.attemptMessageIdOf === "function"
      ? manager.attemptMessageIdOf(record.input?.parentTaskId, record.input?.shardId, record.input?.attempt)
      : null;
    if (bound === null || bound !== messageId) return { ok: false, reason: "attempt_message_id_mismatch", turn, messageId };
    return { ok: true, turn, messageId };
  }

  /**
   * continuation 的真实执行前置条件（在**任何 manager 状态修改之前**判定）。
   *
   * 只有「投递路由 + 每个分片既有 child 的 session 都可解析」时，续作才可能真正执行；
   * 否则必须先结构化拒绝，不能先返回 accepted 再让 attempt 异步失败（那会破坏回执语义：
   * 用户看到的是一轮被接受的续作，实际上一轮都没跑起来）。
   * 注意：本函数只读，不产生任何副作用。
   */
  function continuationReadiness(task) {
    if (task === null || typeof task !== "object") return { ok: false, reason: "unknown_parent_task", shardIds: [] };
    if (typeof options.continueMessage !== "function") {
      return { ok: false, reason: "continue_route_unavailable", shardIds: [] };
    }
    const shardIds = [];
    for (const shard of Array.isArray(task.shards) ? task.shards : []) {
      const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
      const latest = attempts[attempts.length - 1];
      const childId = nonEmptyText(latest?.childId);
      if (childId === "" || continuationSession(childId) === undefined) {
        shardIds.push(typeof shard?.shardId === "string" ? shard.shardId : "unknown");
      }
    }
    return shardIds.length === 0
      ? { ok: true, shardIds: [] }
      : { ok: false, reason: "child_session_unavailable", shardIds };
  }
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : undefined;
  const log = typeof options.log === "function" ? options.log : () => {};

  /**
   * 归属老化（票据 07）：continuation attempt 的 turn 归属无法证明时，Host 记录首次
   * 观察时间并在宽限到期后调用 manager 的精确 API 标记 needs_attention。
   *
   * 默认 60 秒：足够覆盖一次 session replacement/cold-resume 的归属恢复窗口，又能在
   * 用户明显卡住时给出可操作结论。0 表示显式禁用（测试/极端配置）；非法值在构造期
   * 显式失败，绝不静默回退——配置写错不能变成"永不老化"。
   *
   * 时钟可注入（options.clock 或等价的 now/setTimeout/clearTimeout）：老化只是 Host
   * 侧观察窗口，不改变 manager 的状态机；测试用假时钟做确定性断言。
   */
  const ATTRIBUTION_AGING_DEFAULT_MS = 60000;
  const rawAttributionAgingMs = options.attributionAgingMs;
  if (rawAttributionAgingMs !== undefined && rawAttributionAgingMs !== null
    && (typeof rawAttributionAgingMs !== "number" || !Number.isFinite(rawAttributionAgingMs) || rawAttributionAgingMs < 0)) {
    throw new TypeError("fan-out attributionAgingMs 必须是 0 或正有限数");
  }
  const attributionAgingMs = rawAttributionAgingMs === undefined || rawAttributionAgingMs === null
    ? ATTRIBUTION_AGING_DEFAULT_MS
    : rawAttributionAgingMs;
  const agingClock = isObject(options.clock) ? options.clock : undefined;
  const agingNow = typeof agingClock?.now === "function"
    ? agingClock.now
    : (typeof options.now === "function" ? options.now : () => Date.now());
  const agingSetTimeout = typeof agingClock?.setTimeout === "function"
    ? agingClock.setTimeout
    : (typeof options.setTimeout === "function" ? options.setTimeout : (fn, ms) => setTimeout(fn, ms));
  const agingClearTimeout = typeof agingClock?.clearTimeout === "function"
    ? agingClock.clearTimeout
    : (typeof options.clearTimeout === "function" ? options.clearTimeout : (handle) => clearTimeout(handle));
  /** 仍挂着老化定时器的 record 数（tombstone 不计入这里）。 */
  let attributionAgingPending = 0;
  /** 真正把 attempt 标记为 aged 的次数（manager changed=true）。 */
  let attributionAgingAgedCount = 0;
  /** 到期时已终态/身份不可读而被跳过的次数（只读诊断）。 */
  let attributionAgingSkippedCount = 0;
  /** 最近一次成功老化（只读诊断；只含身份与结果，不含 prompt/结果负载）。 */
  let lastAttributionAged = null;

  /**
   * continuation admission 期间暂存的终态事件上限。
   *
   * 为什么需要暂存：续作的 messageId 只有 `continueMessage()` resolve 之后才知道，而新轮的
   * turn/end 可能在那之前到达。没有暂存时这类事件会被 knownIds 当成旧 child 的迟到事件吞掉，
   * 且没有任何回放 → 新 attempt 永久 running。
   *
   * 上限语义（有界 + 只保留最新的终态事实）：超过上限时丢弃**最旧**的一条。理由是最新的
   * 终态事件更可能属于新轮（旧轮的迟到事件通常更早到达）；丢弃是 fail-closed 方向——
   * attempt 保持 running，等下一次真正的 turn/end 或超时/取消收敛，绝不猜测归属。
   */
  const CONTINUATION_ADMISSION_EVENT_LIMIT = 8;

  /**
   * 安装/更新 record 的会话实例（**latest-session 规则**）。
   *
   * 只有两个可信来源会推进 `record.sessionGeneration`：
   * - activation 边界 `handleAgentCreated()`：cold-resume/replacement 带来的新 session 实例；
   * - admission 起点 `continueShard()`：预解析到的 session（作为初始代次）。
   *
   * `runContinuation()` 在 await 之后**只能在同一代次内补写**自己预解析到的实例，绝不能用
   * 旧实例覆盖 admission 期间安装的新实例（终审 session replacement 竞态的根因）。
   *
   * 路由一致性：每次安装都把「最新 sessionId」写进 sessionRecords（并保留历史 id 用于
   * finishRecord 清理），childId → childRecords 始终指向同一个 record，因此替换 session
   * 不会让事件路由到别的 record。
   *
   * session 不是对象（冷 child 暂无实例）时不做任何安装，返回 false：路由由调用方按 childId
   * 兜底登记（continueShard），之后 activation 边界会带来真实实例。
   *
   * @returns {boolean} 是否真的安装了新实例（代次 +1）。
   */
  function installRecordSession(record, session, childId) {
    if (!isObject(session)) return false;
    const fallbackChildId = typeof childId === "string" && childId.length > 0 ? childId : record.childId;
    const sessionId = sessionIdOf(session) ?? fallbackChildId;
    if (session === record.session && sessionId === record.sessionId) return false;
    record.session = session;
    record.sessionGeneration = (Number.isSafeInteger(record.sessionGeneration) ? record.sessionGeneration : 0) + 1;
    if (typeof sessionId === "string" && sessionId.length > 0) {
      record.sessionId = sessionId;
      const ids = record.sessionIds instanceof Set ? record.sessionIds : (record.sessionIds = new Set());
      ids.add(sessionId);
    }
    if (typeof fallbackChildId === "string" && fallbackChildId.length > 0) {
      record.childId = fallbackChildId;
      rememberRecord(record, fallbackChildId, record.sessionId);
      rememberChildSession(fallbackChildId, session);
    }
    return true;
  }

  /**
   * 暂存一条 admission 期间的终态事件（只保留判定所需的终态事实与**来源 session**）。
   *
   * 只记录 turn / reason / success / session：`extractFanoutResult` 读的是该 session 的日志，
   * 因此暂存不必复制消息正文；持有 session 引用是必要的——session replacement 之后事件与
   * 日志分属不同实例，回放必须按"事件来自哪个实例"判定，否则会去旧实例里找新 messageId。
   * 每个 record 上限 CONTINUATION_ADMISSION_EVENT_LIMIT 条，随 finishRecord 一并释放。
   */
  function stageAdmissionEvent(record, session, event) {
    const queue = Array.isArray(record.pendingAdmissionEvents)
      ? record.pendingAdmissionEvents
      : (record.pendingAdmissionEvents = []);
    if (queue.length >= CONTINUATION_ADMISSION_EVENT_LIMIT) queue.shift();
    queue.push({
      turn: turnOf(event),
      reason: turnReason(event),
      success: completionIsSuccess(event),
      session: isObject(session) ? session : undefined,
    });
  }

  /** 取出并清空暂存（生命周期终点：绑定成功回放、失败、取消、关闭都走这里）。 */
  function takeAdmissionEvents(record) {
    const staged = Array.isArray(record.pendingAdmissionEvents) ? record.pendingAdmissionEvents : [];
    record.pendingAdmissionEvents = undefined;
    return staged;
  }

  /**
   * 绑定新 messageId 之后，对 admission 期间暂存的终态事件做**受限回放**。
   *
   * 严格复用 continuationAttribution：只有「有效 turn + 该 turn 的 message id 集合非空 +
   * 包含本轮 messageId + 与 manager 中该 attempt 绑定的 messageId 一致」才允许结算；
   * 其余一律只记 `shard_attribution_unproven` 诊断并保持 running（fail-closed）。
   *
   * session 选择：逐事件使用**该事件来源的 session**（admission 期间最后一次可信 session，
   * 通常就是 replacement 之后的新实例），因此冷恢复换实例不会让回放去旧日志里找新 messageId；
   * 没有记录来源实例时退回 `record.session`。
   *
   * 调用时机必须在 manager 消费 admission 句柄之后（microtask 内），否则
   * `manager.attemptMessageIdOf()` 还读不到本轮 messageId，严格判定必然失败。
   */
  function replayAdmissionEvents(record) {
    const staged = takeAdmissionEvents(record);
    if (staged.length === 0 || record.finished === true) return;
    for (const stagedEvent of staged) {
      if (record.finished === true) break;
      const session = isObject(stagedEvent.session) ? stagedEvent.session : record.session;
      const event = { type: "turn/end", data: { turn: stagedEvent.turn, reason: stagedEvent.reason } };
      const verdict = continuationAttribution(record, session, event);
      if (verdict.ok !== true) {
        reportAttributionViolation(record, verdict);
        continue;
      }
      if (stagedEvent.success === true) finishRecord(record, true, extractFanoutResult(session, stagedEvent.turn));
      else finishRecord(record, false, fanoutCompletionError(stagedEvent.reason, event));
    }
  }

  function rememberEvent(event) {
    const normalized = normalizeEvent(event);
    // 维护升序不变式：仅当新事件不小于末条时才继续保证升序（乱序即永久关闭快路径，
    // 见 eventsAscending 的说明；不重排日志，保持"事件按到达顺序返回"的既有语义）。
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
    try { onEvent?.(normalized); } catch (error) { log("fan-out event callback failed", error); }
  }

  function rememberRecord(record, childId, sessionId) {
    if (childId !== undefined) {
      record.childId = childId;
      childRecords.set(childId, record);
    }
    if (sessionId !== undefined) {
      record.sessionId = sessionId;
      sessionRecords.set(sessionId, record);
    }
  }

  function forgetRecord(record) {
    if (records.get(record.key) === record) records.delete(record.key);
    if (record.childId !== undefined && childRecords.get(record.childId) === record) childRecords.delete(record.childId);
    // session replacement 会让同一个 record 关联过多个 session id（实例换了、id 可能同也可能
    // 不同）：终态时必须把**全部**历史 id 都摘掉，否则旧 id 的迟到事件还能找回一个已结算的
    // record（既留下悬挂引用，又会在严格判定里产生无意义诊断）。
    if (record.sessionIds instanceof Set) {
      for (const sessionId of record.sessionIds) {
        if (sessionRecords.get(sessionId) === record) sessionRecords.delete(sessionId);
      }
      record.sessionIds.clear();
    }
    if (record.sessionId !== undefined && sessionRecords.get(record.sessionId) === record) sessionRecords.delete(record.sessionId);
  }

  /**
   * 清除 record 的归属老化定时器（生命周期终点：finish/close）。
   *
   * 必须在 record 生命周期结束时调用：否则已结算的 attempt 仍会在宽限到期时触发一次
   * manager 调用（对已终态 attempt 是 no-op，但会留下无意义的诊断与悬挂句柄）。
   *
   * @returns {boolean} 是否真的清理了一个待决定时器。
   */
  function releaseAttributionAgingTimer(record) {
    if (record?.attributionAgingTimer === undefined) return false;
    try { agingClearTimeout(record.attributionAgingTimer); } catch (error) { log("fan-out attribution aging clear failed", error); }
    record.attributionAgingTimer = undefined;
    attributionAgingPending = Math.max(0, attributionAgingPending - 1);
    return true;
  }

  /**
   * 首次观察到"归属无法证明"时启动老化窗口（同一 record 只启动一次）。
   *
   * 语义边界：这只记录观察窗口，**不**改变 attempt 状态、不请求取消、不释放范围。
   * 到期后由 runAttributionAging 调用 manager 的精确 API；在此之前任何合法 completion /
   * disposal 仍按原路径收敛，并由 finishRecord 清掉定时器。
   */
  function scheduleAttributionAging(record) {
    if (attributionAgingMs <= 0) return false;
    if (record === undefined || record.finished === true) return false;
    if (record.attributionAgingTimer !== undefined) return false;
    const firstAt = agingNow();
    record.attributionUnprovenFirstAt = firstAt;
    record.attributionAgingDeadlineAt = firstAt + attributionAgingMs;
    // 先记账再注册：注入的 setTimeout 若是同步执行（测试替身/极端实现），回调里的
    // 递减必须能看到这一笔，否则 pending 会永久多 1。同步触发后不得再把句柄写回去。
    attributionAgingPending += 1;
    let firedSynchronously = false;
    try {
      const timer = agingSetTimeout(() => {
        firedSynchronously = true;
        // 假时钟可能在触发前不删除句柄；这里统一清账，保证 pending 计数不漂移。
        record.attributionAgingTimer = undefined;
        attributionAgingPending = Math.max(0, attributionAgingPending - 1);
        runAttributionAging(record);
      }, attributionAgingMs);
      // null 表示"已注册但宿主未返回可清除句柄"：仍算 pending，release 时会清账。
      record.attributionAgingTimer = firedSynchronously ? undefined : (timer === undefined ? null : timer);
      // unref：归属老化只是 fail-closed 诊断，不应把测试/宿主进程按 60 秒钉住。
      if (!firedSynchronously) timer?.unref?.();
    } catch (error) {
      // 定时器注册失败不能把事件处理打断：清账并保持 record 原状（等迟到证据/关闭）。
      attributionAgingPending = Math.max(0, attributionAgingPending - 1);
      record.attributionAgingTimer = undefined;
      log("fan-out attribution aging schedule failed", error);
      return false;
    }
    return true;
  }

  /**
   * 老化到期：用 manager 的权威身份把仍非终态的 attempt 标记为 needs_attention。
   *
   * 为什么不在到期时先 finishRecord：aging 只说明"归属无法证明且超过宽限"，**不**证明
   * 执行已停止。因此 record 作为 tombstone 保留，等迟到 completion/disposal 证据到达后
   * 再按正常路径收敛（manager 只会补证据、不改终态）。
   */
  function runAttributionAging(record) {
    if (closed || record.finished === true) return false;
    const input = isObject(record.input) ? record.input : {};
    const parentTaskId = nonEmptyText(input.parentTaskId);
    const shardId = nonEmptyText(input.shardId);
    const attemptNumber = attemptValue(input.attempt);
    if (parentTaskId === "" || shardId === "" || attemptNumber === undefined) {
      attributionAgingSkippedCount += 1;
      return false;
    }
    let identity = null;
    try {
      identity = typeof manager.attemptIdentityOf === "function"
        ? manager.attemptIdentityOf(parentTaskId, shardId, attemptNumber)
        : null;
    } catch (error) {
      log("fan-out attribution identity lookup failed", error);
      identity = null;
    }
    if (identity === null) {
      // 任务/分片/attempt 已不存在（例如被 close 清理）：没有可标记的对象，保持静默。
      attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = "attempt_identity_unavailable";
      return false;
    }
    let result;
    try {
      result = manager.markAttributionAged({
        parentTaskId,
        shardId,
        attempt: attemptNumber,
        attemptId: identity.attemptId,
        executionGeneration: identity.executionGeneration,
      }, { reason: "shard_attribution_unproven_aged" });
    } catch (error) {
      log("fan-out attribution aging failed", error);
      attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = "manager_call_failed";
      return false;
    }
    if (result?.changed !== true) {
      // 已终态（迟到 completion 先到）或身份过期：no-op，不产生任何状态变更。
      attributionAgingSkippedCount += 1;
      record.attributionAgedSkipReason = typeof result?.reason === "string" ? result.reason : "not_changed";
      return false;
    }
    attributionAgingAgedCount += 1;
    const agedAt = agingNow();
    record.attributionAgedAt = agedAt;
    record.attributionAgedReason = typeof result.terminalReason === "string"
      ? result.terminalReason
      : "shard_attribution_unproven_aged";
    lastAttributionAged = {
      parentTaskId,
      shardId,
      attempt: attemptNumber,
      attemptId: identity.attemptId,
      executionGeneration: identity.executionGeneration,
      at: agedAt,
      status: result.status,
      taskStatus: result.taskStatus,
      reason: "shard_attribution_unproven_aged",
      needsAttention: true,
    };
    log("fan-out attribution aged: " + JSON.stringify({
      parentTaskId,
      shardId,
      attempt: attemptNumber,
      status: result.status,
      taskStatus: result.taskStatus,
    }));
    return true;
  }

  function finishRecord(record, success, value) {
    if (record.finished) return false;
    record.finished = true;
    // 生命周期终点：老化窗口一并关闭，绝不让定时器在结算之后仍触发 manager 调用。
    releaseAttributionAgingTimer(record);
    // 生命周期终点：无论成功/失败/取消/关闭，admission 暂存与 disposal 待决标记都必须立刻
    // 释放（不持有 session 与终态事实，避免悬挂记录与内存泄漏）。
    takeAdmissionEvents(record);
    record.pendingDisposal = undefined;
    forgetRecord(record);
    if (success) record.deferred.resolve(cloneJson(value));
    else record.deferred.reject(value instanceof Error ? value : fanoutCompletionError(value));
    return true;
  }

  function requestChildInterrupt(record, input, childId) {
    if (childId === undefined || typeof options.interrupt !== "function") return false;
    if (record?.interruptRequested === true) return false;
    // close 会清空 records；此时同一 attempt 的判重只能靠 key 集合，否则迟到的
    // canceller（manager 仍持有 attempt.childId）会重复 interrupt 同一个 child。
    const key = record?.key ?? attemptKeyFromInput(input);
    if (key !== undefined && interruptedKeys.has(key)) return false;
    if (record !== undefined) record.interruptRequested = true;
    if (key !== undefined) rememberInterruptedKey(key);
    const parentAgent = record?.parentAgent;
    try {
      const result = options.interrupt({ childId, parentAgent, input, handle: record?.handle });
      if (result !== null && typeof result === "object" && typeof result.catch === "function") {
        result.catch((error) => log("fan-out interrupt failed", error));
      }
    } catch (error) {
      log("fan-out interrupt failed", error);
    }
    return true;
  }

  /**
   * 把一个 shard attempt 交给 buildRequest/startContinuable。
   *
   * 返回值是可控 admission 句柄（thenable）而不是原生 Promise：manager 只按 Promise
   * 语义消费 launcher 的返回值（见 fanout.js 的 startShard），可控句柄让 close() 能在
   * 同一个同步栈内把关闭错误交给 manager（见 createAdmissionHandle）。守卫失败（重复
   * attempt / 已关闭 / 超预算）仍以 rejection 表达，与原来的 async launcher 一致。
   *
   * record.phase 记录 admission 阶段，供 close() 区分「还没有产生 child 的在途 admission」：
   * build = 正在等 buildRequest，start = 正在等 startContinuable，done = 已结算。
   */
  function launcher(input) {
    const admission = createAdmissionHandle();
    try {
      const key = fanoutAttemptKey(input.parentTaskId, input.shardId, input.attempt);
      if (records.has(key)) throw new Error("fan-out attempt 已存在: " + key);
      // close 已经封锁 admission：manager 在 runtime 单独关闭时未必同时关闭，仍可能派发
      // queued shard。此时绝不能再进入 buildRequest/startContinuable——关闭后启动的 child
      // 已不在 records 里，没有任何路径能 interrupt 或结算它（会变成永久悬挂的 live child）。
      if (closed) throw fanoutRuntimeClosedError();
      // admission 前的输入预算复核：prompt 超限必须显式失败，绝不以截断后的正文
      // 派发专家（manager 已在 submit 阶段拒绝；这里防的是运行期二次装配的差异）。
      const inputVerdict = checkTaskInputBudget({
        basePrompt: input.basePrompt,
        shardPrompt: input.prompt,
        subject: input.parentTaskId + "/" + input.shardId + "#" + input.attempt,
      });
      if (!inputVerdict.ok) {
        const error = new Error(inputVerdict.violation.message);
        error.name = "BudgetExceededError";
        error.code = inputVerdict.violation.code;
        error.resource = inputVerdict.violation.resource;
        error.receivedBytes = inputVerdict.violation.receivedBytes;
        error.maxBytes = inputVerdict.violation.maxBytes;
        error.complete = false;
        error.recoverable = inputVerdict.violation.recoverable;
        throw error;
      }
      const record = {
        key,
        input: cloneJson(input),
        deferred: createDeferred(),
        controller: new AbortController(),
        finished: false,
        cancelRequested: false,
        phase: "build",
        admission,
      };
      records.set(key, record);
      // admission 主体异步推进，成功句柄与失败错误都通过可控句柄投递。
      runAdmission(record, input).catch((error) => log("fan-out admission failed", error));
    } catch (error) {
      admission.reject(error);
    }
    return admission;
  }

  /**
   * admission 主体：与原来的 async launcher 等价，只是结算改由可控句柄投递。
   *
   * close 落在任一步骤都必须停止 admission：buildRequest 之后还有一道 closed 检查，
   * 绝不为已关闭的 runtime 启动新 child。
   */
  async function runAdmission(record, input) {
    try {
      const prepared = await options.buildRequest(input, record.controller.signal);
      // close 可能落在 buildRequest 等待期间：此处必须停止 admission，否则会为一个已经
      // 关闭的 runtime 启动新 child。record 若已被 close 结算，finishRecord 不会再结算一次；
      // 关闭错误最终由 manager 按一次性的启动失败/取消语义收敛本次 attempt。
      if (closed) throw fanoutRuntimeClosedError();
      record.phase = "start";
      const request = isObject(prepared) && Object.prototype.hasOwnProperty.call(prepared, "request") ? prepared.request : prepared;
      record.parentAgent = prepared?.parentAgent ?? request?.parent;
      record.parentId = prepared?.parentId ?? record.parentAgent?.id;
      record.role = prepared?.role ?? input.role;
      const started = await options.startContinuable({
        request,
        input,
        parentAgent: record.parentAgent,
        signal: record.controller.signal,
      });
      const childId = childIdOf(started);
      if (childId === undefined) throw new Error("startContinuable 未返回 childId");
      const messageId = messageIdOf(started);
      const handle = {
        childId,
        ...(messageId === undefined ? {} : { messageId }),
        completion: record.deferred.promise,
      };
      record.handle = handle;
      record.phase = "done";
      // close/cancel 可能在 startContinuable 等待期间先发生；accepted child 仍必须
      // 由保存下来的 parentAgent 发出一次 parent-authorized interrupt，不能只 abort admission。
      if (!record.finished) rememberRecord(record, childId, record.sessionId);
      if (record.cancelRequested === true || record.finished === true) {
        requestChildInterrupt(record, { ...input, reason: record.finished ? "runtime_closed" : "cancelled" }, childId);
      }
      // 关闭已经把 admission 结算过时，这里是一次幂等的 no-op。
      record.admission.resolve(handle);
      return handle;
    } catch (error) {
      finishRecord(record, false, error);
      record.admission.reject(error);
      return undefined;
    }
  }

  function canceller(input) {
    const record = records.get(fanoutAttemptKey(input.parentTaskId, input.shardId, input.attempt));
    if (record !== undefined) record.cancelRequested = true;
    try { record?.controller?.abort(); } catch (error) { log("fan-out admission abort failed", error); }
    requestChildInterrupt(record, input, input.childId ?? record?.childId);
  }

  /**
   * 多轮复用：把一个 continuation attempt 投递给**同一 child**。
   *
   * 与 launcher 的差别有三点：
   * 1. 不新建 child，通过注入的 `continueMessage` 把本轮 prompt 发给 input.childId；
   * 2. **admission 之前**就登记会话路由（childId/sessionId → 本 record），让本轮 turn/end
   *    有明确投递目标；若等 messageId 落地后再登记，新轮的 turn/end 会落在"无人认领"窗口里
   *    被 knownIds 吞掉且无法回放 → 新 attempt 永久 running（终审问题 2）；
   * 3. admission 期间的终态事件进**有界暂存**，绑定 messageId 后严格回放（见 replayAdmissionEvents）。
   * 守卫（重复 attempt / 已关闭 / 未接线 / 输入超预算）与 launcher 一致，都以 rejection 表达，
   * 由 manager 记为本轮 attempt 的启动失败（历史一致，不半写）。
   */
  function continueShard(input) {
    const admission = createAdmissionHandle();
    try {
      const key = fanoutAttemptKey(input.parentTaskId, input.shardId, input.attempt);
      if (records.has(key)) throw new Error("fan-out attempt 已存在: " + key);
      if (closed) throw fanoutRuntimeClosedError();
      const childId = nonEmptyText(input.childId);
      if (childId === "") throw new Error("fan-out continuation 需要既有 childId");
      if (typeof options.continueMessage !== "function") {
        throw new Error("fan-out continuation 未接线 continueMessage，拒绝复用既有 child");
      }
      const inputVerdict = checkTaskInputBudget({
        basePrompt: input.basePrompt,
        shardPrompt: input.prompt,
        subject: input.parentTaskId + "/" + input.shardId + "#" + input.attempt,
      });
      if (!inputVerdict.ok) {
        const error = new Error(inputVerdict.violation.message);
        error.name = "BudgetExceededError";
        error.code = inputVerdict.violation.code;
        error.resource = inputVerdict.violation.resource;
        error.receivedBytes = inputVerdict.violation.receivedBytes;
        error.maxBytes = inputVerdict.violation.maxBytes;
        error.complete = false;
        error.recoverable = inputVerdict.violation.recoverable;
        throw error;
      }
      // session 可能尚未加载（冷 child）：按 childId 绑定路由即可（DSH continuable child 的
      // session id 就是 childId）；真正的可继续性由 sendMessage 显式决定。
      const session = continuationSession(childId);
      const record = {
        key,
        input: cloneJson(input),
        deferred: createDeferred(),
        controller: new AbortController(),
        finished: false,
        cancelRequested: false,
        phase: "continue",
        continuation: true,
        childId,
        // sessionId 先按 childId 兜底，随后由 installRecordSession 归一化；初始化 0 代次。
        sessionId: childId,
        sessionGeneration: 0,
        admission,
        pendingAdmissionEvents: [],
      };
      records.set(key, record);
      // 关键顺序：先登记路由（含 session 实例），再进入异步投递——否则 admission 期间的
      // turn/end 无人认领（既不会被暂存也不会被回放），新 attempt 会永久 running。
      // 冷 child 没有实例时先按 childId 兜底登记，随后由 installRecordSession 用真实实例归一化。
      rememberRecord(record, childId, record.sessionId);
      installRecordSession(record, session, childId);
      // 记下本 record 的初始 session 代次：runContinuation 在 await 之后只有代次未推进时
      // 才允许补写自己预解析到的实例（最新 session 优先，见 installRecordSession）。
      const admissionSessionGeneration = record.sessionGeneration;
      runContinuation(record, input, childId, session, admissionSessionGeneration)
        .catch((error) => log("fan-out continuation failed", error));
    } catch (error) {
      admission.reject(error);
    }
    return admission;
  }

  /** continuation admission 主体：复用同一 child 发送本轮 prompt，并等待该轮 turn/end。 */
  async function runContinuation(record, input, childId, resolvedSession, admissionSessionGeneration) {
    try {
      const parentAgent = typeof options.parentAgentOf === "function"
        ? options.parentAgentOf(input.parentTaskId)
        : undefined;
      record.parentAgent = parentAgent;
      record.parentId = parentAgent?.id;
      record.role = input.role;
      // 本轮正文由 Host 装配（与首轮 buildRequest 同一套文案/persona 纪律）：runtime 只
      // 把「同一 child 的新一轮」这件事连同分片/attempt/round 身份交给 Host。
      const sent = await options.continueMessage({
        childId,
        parentAgent,
        input,
        signal: record.controller.signal,
      });
      // 投递结果兼容两种形态：Host 直接回传 messageId 字符串（生产 sendMessage 契约），
      // 或回传 { messageId } 句柄；两种都归一为「本轮该结算的 turn」。
      const messageId = typeof sent === "string" && sent.length > 0 ? sent : messageIdOf(sent);
      // 严格启动门（fail-closed）：没有有效 messageId 就无法证明后续 turn 归属，
      // 绝不允许把本轮 attempt 挂成 running 再等一个可能属于旧轮的 turn/end。
      if (typeof messageId !== "string" || messageId.length === 0) {
        throw continuationStartupError("continuation_message_id_missing", childId, "续作投递未返回有效 messageId");
      }
      // 与同一 child 之前各轮的 messageId 重复：旧轮的 turn/end 会直接冒充新一轮，
      // 必须在启动阶段拒绝（同一 shard 的每轮投递必须是新的消息身份）。
      const previousMessageIds = Array.isArray(input.previousMessageIds) ? input.previousMessageIds : [];
      if (previousMessageIds.includes(messageId)) {
        throw continuationStartupError("continuation_message_id_reused", childId, "续作投递返回的 messageId 与旧轮重复");
      }
      record.messageId = messageId;
      // DSH continuable child 的 session id 就是 childId；admission 之前已按同一 sessionId
      /**
       * session 写回规则（终审 session replacement 竞态的核心修复）：
       * 只有**本 record 的 session 代次没有在 await 期间推进**时，才允许补写自己预解析到的
       * 实例；若 `handleAgentCreated()`（cold-resume/replacement）已安装更新的 session，则
       * 保持新实例——用旧实例覆盖会让后续严格判定去旧日志里找新 messageId，attempt 永久
       * running。
       */
      if (record.sessionGeneration === admissionSessionGeneration) {
        installRecordSession(record, resolvedSession, childId);
      } else if (!isObject(record.session) && isObject(resolvedSession)) {
        // 代次推进但当前没有可用实例（异常形态）：仍以最新代次补一个可用实例，绝不落空。
        installRecordSession(record, resolvedSession, childId);
      }
      const handle = {
        childId,
        messageId,
        completion: record.deferred.promise,
        continuation: true,
      };
      record.handle = handle;
      record.phase = "done";
      /**
       * admission 阶段观察到的旧实例 disposal 到此已不再是「未决」：messageId 已绑定，后续
       * 收敛由本轮 turn/end、取消、close 或对**当前** session 的 disposal 决定（迟到的旧实例
       * disposal 会被 stale-instance 规则忽略）。这里清掉待决标记，避免它跨阶段残留。
       */
      record.pendingDisposal = undefined;
      if (!record.finished) {
        // 路由保持一致：按 childId + 最新 sessionId 重新登记（id 可能因替换而变化）。
        if (typeof record.sessionId === "string" && record.sessionId.length > 0) {
          rememberRecord(record, childId, record.sessionId);
        }
      }
      if (record.cancelRequested === true || record.finished === true) {
        requestChildInterrupt(record, { ...input, reason: record.finished ? "runtime_closed" : "cancelled" }, childId);
      }
      record.admission.resolve(handle);
      /**
       * 绑定后受限回放：必须等 manager 消费 admission 句柄（attempt.messageId 落地）之后再
       * 做严格判定，否则 `manager.attemptMessageIdOf()` 还读不到本轮 messageId。
       * 排队顺序保证：admission.resolve 触发的 manager `.then` 回调先于本 microtask 执行。
       */
      if (record.finished !== true) queueMicrotask(() => replayAdmissionEvents(record));
      return handle;
    } catch (error) {
      // 失败同样释放暂存（finishRecord 内部 takeAdmissionEvents）：不留下悬挂的终态事实。
      finishRecord(record, false, error);
      record.admission.reject(error);
      return undefined;
    }
  }

  const manager = createFanoutManager({
    launcher,
    // 多轮复用走 continuer（同一 child 的新一轮 prompt），其余 attempt 仍走 launcher。
    continuer: continueShard,
    canceller,
    persistence: options.persistence,
    conflictChecker: options.conflictChecker,
    writeRoles: options.writeRoles,
    allowOverlap: options.allowOverlap,
    concurrencyLimit: options.concurrencyLimit,
    roleLimits: options.roleLimits,
    // 角色级默认超时（票据 06）：同 concurrencyLimit 一样支持解析函数，
    // 由 manager 在每次新建 attempt 时读一次当前 settings。
    roleTimeoutMs: options.roleTimeoutMs,
    // 时钟注入：老化的 Host 定时器与 manager 的超时/停止看门狗共用同一时钟 seam，
    // 测试可以用假时钟做确定性断言（两者互不改变对方的状态机）。
    ...(isObject(options.clock) ? { clock: options.clock } : {}),
  });
  const unsubscribeManager = manager.subscribe((event) => rememberEvent(event));

  /**
   * fan-out child 身份预检（只读、fail-closed）。
   *
   * 为什么必须独立于 handleAgentCreated：后者的 false 只表示「没有对应的 live attempt」，
   * 它不构成任何身份证据——把别人的 parentTaskId/shardId/attempt 复制过来、或把 parent
   * 指到另一个 root 的错误 marker 同样得到 false，却可能已经被上游当成 fan-out child
   * 登记了 exact Agent 并安装了 scoped guard。因此把一致性判定独立成显式预检，供
   * index.js 在**产生任何副作用之前**调用，handleAgentCreated 自身也复用同一份判定。
   *
   * 判定顺序（每一条不成立都 fail-closed，返回第一个原因）：
   * 1. marker 与持久化 fan-out 身份同时存在时，四个身份字段必须逐字一致；
   * 2. 实际 `agent.parent.id` 存在时必须等于 fan-out parentAgentId；缺失时（合法
   *    cold-resume 的 Agent 可能没有 parent 引用）按可信持久化身份继续判定；
   * 3. 该 attempt 的 active runtime record 存在时，先要求 record 的两个 canonical parent
   *    来源（record.parentId / record.parentAgent.id）彼此一致：两者都非空却不相等即
   *    `fanout_record_parent_conflict`，绝不用集合合并接受单边匹配；一致后再要求
   *    marker/实际 parentAgentId 等于该 canonical parent，覆盖「admission 由 root-a 预备、
   *    created marker/parent 却写 root-b」的 mismatch；record 尚未写入 canonical parent
   *    时同样无从证明，一并拒绝。
   *
   * 只读：不写 record、不登记 id、不安装任何 guard。
   *
   * @param {object} agent - agent/created 携带的 exact Agent。
   * @param {object} [persistedIdentity] - 该 child id 的持久化模型快照（可选）。
   * @returns {{ok:true, identity:object} | {ok:false, reason:string}}
   */
  function precheckFanoutChildIdentity(agent, persistedIdentity) {
    const markerIdentity = markerFanoutIdentity(markerOptions(agent));
    const persisted = persistedFanoutIdentity(persistedIdentity);
    if (markerIdentity === undefined && persisted === undefined) {
      return { ok: false, reason: "fanout_identity_missing" };
    }
    if (markerIdentity !== undefined && persisted !== undefined) {
      for (const field of FANOUT_IDENTITY_FIELDS) {
        if (markerIdentity[field] !== persisted[field]) {
          return { ok: false, reason: "fanout_identity_conflict:" + field };
        }
      }
    }
    const identity = markerIdentity ?? persisted;
    const actualParentId = nonEmptyText(agent?.parent?.id);
    if (actualParentId !== "" && actualParentId !== identity.parentAgentId) {
      return { ok: false, reason: "fanout_parent_agent_mismatch" };
    }
    const record = records.get(fanoutAttemptKey(identity.parentTaskId, identity.shardId, identity.attempt));
    if (record !== undefined) {
      // canonical parent 只取 admission 边界写入的两个来源（record.parentId / record.parentAgent.id）。
      const recordParentId = nonEmptyText(record.parentId);
      const recordParentAgentId = nonEmptyText(record.parentAgent?.id);
      // 两个来源都非空却不相等：record 自身的父归属自相矛盾。此时**不能**合并成集合后接受
      // 「单边匹配」——那等于让伪造方挑一个对自己有利的来源当证据。矛盾必须先于匹配拒绝。
      if (recordParentId !== "" && recordParentAgentId !== "" && recordParentId !== recordParentAgentId) {
        return { ok: false, reason: "fanout_record_parent_conflict" };
      }
      // 只有两个来源一致（或仅一个可用）时才存在唯一 canonical parent；两者都缺失时没有
      // 任何可证明的归属，同样 fail-closed（绝不用 marker 自己的值给自己作证）。
      const canonicalParentId = recordParentId !== "" ? recordParentId : recordParentAgentId;
      if (canonicalParentId === "") return { ok: false, reason: "fanout_record_parent_unproven" };
      if (canonicalParentId !== identity.parentAgentId) return { ok: false, reason: "fanout_record_parent_mismatch" };
      if (actualParentId !== "" && actualParentId !== canonicalParentId) {
        return { ok: false, reason: "fanout_record_parent_mismatch" };
      }
    }
    return { ok: true, identity };
  }

  function handleAgentCreated(agent, persistedIdentity) {
    if (!isFanoutAgent(agent) && !isFanoutIdentity(persistedIdentity)) return false;
    /**
     * 与 index.js 的 guard 安装前预检是**同一份判定**：直接调用方（测试替身、未来入口）
     * 也必须 fail-closed，不能让不一致的 marker 借「没有对应 record」的 false 绕过边界。
     */
    const precheckVerdict = precheckFanoutChildIdentity(agent, persistedIdentity);
    if (precheckVerdict.ok !== true) {
      log("fan-out agent/created identity precheck rejected: " + precheckVerdict.reason);
      return false;
    }
    const marker = markerOptions(agent);
    // 预检通过时 identity 必然存在（ok:true 的唯一构造路径），不再重复判空。
    const { parentTaskId, parentAgentId, shardId, attempt } = precheckVerdict.identity;
    const key = fanoutAttemptKey(parentTaskId, shardId, attempt);
    const sessionId = sessionIdOf(agent);
    rememberKnownId(childIdOf(agent) ?? agent?.id);
    rememberKnownId(sessionId);
    // 弱引用登记 fan-out session 实例：id 索引被 LRU 驱逐后，同一个 session 实例的
    // 迟到事件仍能识别为 fan-out（见 handleSessionEvent 的 fail-closed 兜底）。
    // 只在标记/持久化身份完整可信时登记，因此不会把普通 child 的 session 误收进来。
    if (isObject(agent?.session)) {
      fanoutSessions.add(agent.session);
      rememberChildSession(childIdOf(agent) ?? agent.id, agent.session);
    }
    const record = records.get(key);
    if (record !== undefined) {
      record.agent = agent;
      /**
       * latest-session：activation 边界安装的新 session 实例优先于 admission 起点预解析的
       * 实例（cold-resume/replacement 期间发生的就是这种替换）。installRecordSession 会推进
       * sessionGeneration，因此 `runContinuation()` 之后的写回不可能覆盖它。
       */
      const agentChildId = childIdOf(agent) ?? agent.id;
      installRecordSession(record, agent.session, typeof agentChildId === "string" ? agentChildId : record.childId);
      /**
       * 新 activation 到位即证明「旧实例 disposal → cold-resume」替换窗口已经落地：
       * 把 admission 期间的 disposal 待决标记降级为「已知被替换」（只保留计数供诊断），
       * 后续由 runContinuation 的成功/失败结果收敛。
       */
      if (record.pendingDisposal !== undefined && isObject(agent?.session) && agent.session !== record.pendingDisposal.session) {
        record.replacedAfterDisposal = (Number.isSafeInteger(record.replacedAfterDisposal) ? record.replacedAfterDisposal : 0) + 1;
        record.pendingDisposal = undefined;
      }
      record.parentAgent ??= agent.parent;
      record.parentId ??= parentAgentId;
      rememberRecord(record, agentChildId, sessionId);
      try {
        options.onAgentCreated?.({
          agent,
          record,
          parentTaskId,
          shardId,
          attempt,
          parentAgentId,
          // canonical parentId：record 在 admission 边界已由 buildRequest 归一
          // （缺少 prepared.parentId 时回落到 exact parentAgent.id），因此这里优先
          // 用它而不是 fan-out 专有 marker。下游据它写 child_models.parentId 并补装
          // scoped guard；漏掉字段会让 guard 身份解析 fail-closed 不安装。
          parentId: record.parentId ?? parentAgentId,
          role: markerText(marker, "__degExpertRole") ?? persistedIdentity?.role,
        });
      } catch (error) {
        log("fan-out agent/created callback failed", error);
      }
    }
    // marker 或可信持久化身份都必须在旧 recovery listener 之前被识别；即使对应
    // attempt 已经在 terminal 后清理，也不能让旧 handler 误认为它是普通恢复 child。
    return true;
  }

  function recordForSession(session) {
    if (typeof session?.id !== "string") return undefined;
    rememberChildSession(childIdForSessionIndex(session), session);
    return sessionRecords.get(session.id) ?? childRecords.get(session.id);
  }

  /** session 上的 child 身份：优先 session.header.id（DSH child session 的稳定 id）。 */
  function childIdForSessionIndex(session) {
    const headerId = nonEmptyText(session?.header?.id);
    if (headerId !== "") return headerId;
    return sessionIdOf(session);
  }

  function handleSessionEvent(session, event) {
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    const record = recordForSession(session);
    // record 在成功/失败/超时后会立即删除，但该 child 的后续事件仍属于
    // fan-out；用 bounded known id 集合保持旧 recovery 路由的 fail-closed 边界。
    if (record === undefined) {
      if (sessionId === undefined) return false;
      // 1) 有界 id 索引：覆盖最近见过的 child，包括 cold-resume 后换了新 session
      //    实例但 id 相同的形态。
      if (knownIds.has(sessionId)) return true;
      // 2) 弱引用 session 索引：id 被 LRU 驱逐后，同一个 session 实例的迟到事件
      //    仍然 fail-closed（返回 true 由 fan-out 吞掉），不回落成普通恢复 child。
      //    顺序不可交换：id 判定在前，保住 id 索引能覆盖的、形态更宽的识别面。
      //    残余边界：驱逐后同 id 的全新 session 实例（重建/cold-resume）无从识别，
      //    此时仍返回 false——这是有界索引的固有代价，由回归测试显式固定。
      return isObject(session) && fanoutSessions.has(session);
    }
    if (!eventIsTurnEnd(event)) return true;
    if (!hasTerminalTurnReason(event)) return true;
    /**
     * 归属判定使用的 session：优先**事件来源实例**（`session`，路由已按 id 命中本 record），
     * 只有来源不是对象时才退回 record 当前实例。
     *
     * 为什么按来源实例判定：session replacement/cold-resume 后，新轮的 user/message 与
     * turn/end 都写在**新实例**的日志里；若统一读 record.session（可能还是旧实例），严格
     * 判定会去旧日志里找新 messageId 而永远失败。反过来，旧实例的迟到事件仍然按旧实例
     * 判定 → 找不到本轮 messageId → 只留 `shard_attribution_unproven` 诊断，不会覆盖新轮。
     */
    const attributionSession = isObject(session) ? session : record.session;
    if (record.continuation === true) {
      // admission 期间（messageId 尚未绑定）：先放进有界暂存（含来源 session），绑定后严格回放。
      // 这样「新轮 turn/end 先到」不会被 knownIds 吞掉且无回放，也不会被当作已绑定的轮次结算。
      if (record.phase === "continue" && record.finished !== true) {
        stageAdmissionEvent(record, attributionSession, event);
        return true;
      }
      // 多轮复用：同一 child/session 承载多个 attempt，必须**严格证明**本轮归属才允许结算。
      // 任何一条证据缺失都保持 attempt 未结算，并留下结构化诊断（不沿用首轮的宽松 fallback）。
      const verdict = continuationAttribution(record, attributionSession, event);
      if (verdict.ok !== true) {
        reportAttributionViolation(record, verdict);
        return true;
      }
    } else if (!turnMatchesRecordMessage(record, attributionSession, event)) {
      // 首轮 launcher attempt：保持既有宽松 fallback（messageId/turn 不可读时按旧行为结算）。
      return true;
    }
    const turn = turnOf(event);
    if (completionIsSuccess(event)) finishRecord(record, true, extractFanoutResult(attributionSession, turn));
    else finishRecord(record, false, fanoutCompletionError(turnReason(event), event));
    return true;
  }

  /**
   * 记录一次「continuation 归属无法证明」的结构化诊断。
   *
   * 每个 record（= 一个 attempt 的一轮投递）对**同一种原因**最多报告一次，避免异常 child
   * 反复发 turn/end 造成事件抖动；不同原因（缺消息号 / 消息号不一致 / turn 非法 …）各自
   * 独立留证，便于定位竞态的真实形态。事件由 manager 发布（进事件历史/持久化/RPC）。
   */
  function reportAttributionViolation(record, verdict) {
    const reason = typeof verdict?.reason === "string" && verdict.reason.length > 0 ? verdict.reason : "unproven";
    const reported = record.attributionDiagnosticReasons instanceof Set
      ? record.attributionDiagnosticReasons
      : (record.attributionDiagnosticReasons = new Set());
    if (reported.has(reason)) return;
    reported.add(reason);
    const payload = {
      parentTaskId: record.input?.parentTaskId,
      shardId: record.input?.shardId,
      attempt: record.input?.attempt,
      reason,
      ...(Number.isSafeInteger(verdict?.turn) ? { turn: verdict.turn } : {}),
      ...(typeof verdict?.messageId === "string" ? { messageId: verdict.messageId } : {}),
    };
    try {
      manager.recordAttributionViolation(payload);
    } catch (error) {
      log("fan-out attribution diagnostic failed", error);
    }
    // 首次无法证明归属即启动老化窗口：到期后只标记 needs_attention，不猜测停止。
    scheduleAttributionAging(record);
    log("fan-out continuation attribution unproven: " + JSON.stringify(payload));
  }

  /**
   * 记录一次「admission 期间的旧实例 disposal」待决标记（有界：每个 record 至多一条）。
   *
   * 为什么需要它：DSH `sendMessage()` 在旧 activation 尚未关闭时会先关旧 Agent、再为**同一
   * child id** cold-resume。此时新的 continuation record 已经按 childId 注册到 childRecords，
   * 旧 Agent 的 `agent/disposed` 会命中这个**新** attempt；若立即 finish，合法的新一轮还没开始
   * 就被判 failed，随后 DSH 成功返回 messageId 也无法结算。
   *
   * 待决标记的作用只是「不立即终结」，不消耗任何授权：真正的收敛由 `runContinuation()` 的
   * 成功/失败结果、runtime close/cancel、或后续对**当前** session 的 disposal 决定。
   * 不保存 Agent 对象引用，只留可比较的实例与 id/代次（避免悬挂引用）。
   */
  function deferDisposal(record, agent, session, sessionId) {
    record.pendingDisposal = {
      session: isObject(session) ? session : undefined,
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined,
      agentId: typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : undefined,
      generation: Number.isSafeInteger(record.sessionGeneration) ? record.sessionGeneration : 0,
    };
    return true;
  }

  /**
   * fan-out child（或可信持久化身份的 cold child）被销毁。
   *
   * 路由收紧（终审 disposal 竞态）：
   * 1. 未绑定 messageId 的 continuation admission（`phase === "continue"`）：旧实例 disposal
   *    属于「旧 Agent 关闭 → 同一 child cold-resume」的替换窗口，**不立即终结**，只记待决标记；
   * 2. 已绑定 / 首轮 launcher：disposal 必须明确对应当前 attempt 的**当前 session 实例**
   *    （或无法比较实例时按 id 兜底）才收敛；否则视为迟到/别的实例的 disposal，忽略之
   *    （旧实例销毁不代表当前实例销毁，不能让迟到事件覆盖新 attempt）；
   * 3. 首轮 launcher 的既有 disposal 失败语义保持不变（其当前 session 被销毁 → failed）。
   */
  function handleAgentDisposed(agent, persistedIdentity) {
    if (!isFanoutAgent(agent) && !isFanoutIdentity(persistedIdentity)) return false;
    const record = childRecords.get(agent?.id) ?? sessionRecords.get(sessionIdOf(agent));
    if (record === undefined || record.finished === true) return true;
    const disposedSession = isObject(agent?.session) ? agent.session : undefined;
    // 1) 替换窗口：admission 还没绑定 messageId → 记待决，等 runContinuation 的结果。
    if (record.continuation === true && record.phase === "continue") {
      deferDisposal(record, agent, disposedSession, sessionIdOf(agent));
      return true;
    }
    // 2) 迟到/别的实例的 disposal：不终结当前 attempt（例如旧实例在 cold-resume 之后才发出
    //    disposed；当前实例仍活着）。
    if (disposedSession !== undefined && isObject(record.session) && disposedSession !== record.session) {
      record.staleDisposalIgnored = (Number.isSafeInteger(record.staleDisposalIgnored) ? record.staleDisposalIgnored : 0) + 1;
      return true;
    }
    // 3) 当前 attempt 的当前 session 被销毁（或无法比较实例）：按既有语义收敛为 failed。
    finishRecord(record, false, fanoutCompletionError({ kind: "disposed", message: "fan-out child 已销毁" }));
    return true;
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

  /**
   * 幂等关闭低层 runtime；返回 true 表示本次调用真正执行了关闭，false 表示已关闭。
   *
   * 两步顺序不可交换：
   * 1. 先把在途 admission 以 runtime_closed 同步收敛（settleNow），再关闭 manager。
   *    反序会让 manager.close() 先把仍在 running 的 attempt 扫成 cancelled(manager_closed)，
   *    丢掉本模块的关闭原因；先收敛则这些 attempt 在 manager 侧就是 failed(runtime_closed)。
   * 2. manager.close() 是 runtime 与 manager 共享的关闭门：关闭之后通过公开 manager API
   *    发起的 submit/retryShard/restore 一律结构化失败（MANAGER_CLOSED / manager_closed），
   *    不入队、不恢复、不新建 attempt。Host facade 的 manager-first 顺序下这次关闭是幂等
   *    no-op（already_closed），已有 manager_closed 终态不受影响。
   */
  function close() {
    if (closed) return false;
    closed = true;
    // 先封锁 admission，再让所有未终态 attempt 收敛：abort admission，对已经拿到
    // childId 的记录发出 best-effort interrupt（同步异常与 rejected Promise 都由
    // requestChildInterrupt 吞并记录），最后用显式关闭错误一次性结算 completion。
    for (const record of records.values()) {
      record.cancelRequested = true;
      // 关闭是老化窗口的终点：清除全部 Host 侧定时器，避免关闭后仍有回调进来。
      releaseAttributionAgingTimer(record);
      try { record.controller?.abort(); } catch (error) { log("fan-out admission abort failed", error); }
      requestChildInterrupt(record, { ...record.input, reason: "runtime_closed" }, record.childId);
      // 还停在 buildRequest 的 launcher admission（phase=build）与还没拿到 messageId 的
      // 续作 admission（phase=continue）都尚未产生任何 child 句柄：同步以关闭错误收敛，
      // 让 manager 在自身关闭前先看到 failed(runtime_closed)。已经进入 startContinuable /
      // continueMessage 且拿到句柄的 admission 保持原语义——迟到的 childId 仍会被 interrupt
      // 一次，且暂存（pendingAdmissionEvents）随 finishRecord 一并释放，不残留悬挂记录。
      if (record.phase === "build" || record.phase === "continue") {
        record.admission?.settleNow(fanoutRuntimeClosedError());
      }
      finishRecord(record, false, fanoutRuntimeClosedError());
    }
    // 仍挂在 buildRequest/startContinuable 的 launcher 靠 finished 标记与 interruptedKeys
    // 收敛；清空映射后，迟到的 agent/created、session event、agent disposed 找不到 record，
    // 既不复活记录也不会二次结算。
    records.clear();
    childRecords.clear();
    sessionRecords.clear();
    // 共享关闭门：关闭唯一调度状态机的全部写入入口。manager 已被外部（Host facade
    // manager-first 顺序）关闭时，这里只是幂等 no-op。
    try { manager.close(); } catch (error) { log("fan-out manager close failed", error); }
    try { unsubscribeManager?.(); } catch {}
    return true;
  }

  return {
    manager,
    launcher,
    /** 多轮复用的续作 admission（manager 的 continuer）。 */
    continuer: continueShard,
    /**
     * continuation 的执行前置条件（只读）：投递路由 + 每个分片既有 child 的 session 是否
     * 可解析。Host 必须在 manager 状态修改之前调用它，任何不满足都必须结构化拒绝。
     */
    continuationReadiness,
    canceller,
    isFanoutAgent,
    /**
     * guard/登记之前的 fan-out child 身份预检（只读）：index.js 必须在安装 scoped guard、
     * 登记 exact Agent 之前调用它；失败即终止该 created 路由（见 precheckFanoutChildIdentity）。
     */
    precheckFanoutChildIdentity,
    handleAgentCreated,
    handleSessionEvent,
    handleAgentDisposed,
    restoreEvents,
    getEvents,
    eventLogStatus,
    /**
     * 停止/归属诊断投影（票据 07）：manager 的未确认停止视图 + Host 侧归属老化窗口。
     *
     * 只读：不触发调度、不改状态、不清理定时器。关闭后仍可读取（manager 的终态与 Host
     * 的计数都保留在内存里，供卸载前最后一次诊断/测试断言）。
     */
    stopDiagnostics() {
      const managerState = typeof manager.stopDiagnostics === "function" ? manager.stopDiagnostics() : null;
      return {
        ...(managerState ?? {}),
        aging: {
          enabled: attributionAgingMs > 0,
          windowMs: attributionAgingMs,
          pending: attributionAgingPending,
          aged: attributionAgingAgedCount,
          skipped: attributionAgingSkippedCount,
          lastAged: lastAttributionAged === null ? null : cloneJson(lastAttributionAged),
        },
      };
    },
    close,
    /**
     * 只读预算视图：当前用量、冻结上限与最近一次违规。恢复事件（外部输入）的违规
     * 不属于 manager，因此在这里与 manager 的违规合并后返回（取更新的一方）。
     */
    budget: () => {
      const managerBudget = manager.budget();
      return lastEventViolation === null
        ? managerBudget
        : {
          ...managerBudget,
          eventLog: events.length,
          // 恢复事件历史属于 restore 阶段（manager 的 lastViolationPhase 不覆盖它）。
          lastViolationPhase: "restore",
          lastViolation: lastEventViolation,
        };
    },
    get activeAttemptCount() { return records.size; },
    /**
     * 只读诊断：某 attempt 当前的会话绑定状态（sessionId / 安装代次 / 是否有实例 / 阶段 /
     * 是否有 admission 期间的 disposal 待决标记 / 已忽略的迟到 disposal 数）。
     *
     * 用途是验证两轮终审修复的可观测不变式：latest-session 规则（replacement 后写回不得推进/
     * 回退代次）与 disposal 替换窗口（未绑定的 continuation admission 不得被旧实例 disposal
     * 提前终结）。返回普通标量，不暴露 session/Agent 对象引用。
     */
    sessionBindingOf(parentTaskId, shardId, attemptNumber) {
      const record = records.get(fanoutAttemptKey(parentTaskId, shardId, attemptNumber));
      if (record === undefined) return null;
      return {
        sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
        generation: Number.isSafeInteger(record.sessionGeneration) ? record.sessionGeneration : 0,
        hasInstance: isObject(record.session),
        phase: typeof record.phase === "string" ? record.phase : null,
        pendingDisposal: record.pendingDisposal !== undefined,
        staleDisposalIgnored: Number.isSafeInteger(record.staleDisposalIgnored) ? record.staleDisposalIgnored : 0,
        replacedAfterDisposal: Number.isSafeInteger(record.replacedAfterDisposal) ? record.replacedAfterDisposal : 0,
      };
    },
  };
}
