/**
 * 请求重试策略与 recovery op 状态机。
 *
 * PI/AI 失败分类、请求级重试预算、recovery op 的创建/计时/接受与取代判定。
 * 本文件由原 `shared.js` 的 2290–2734 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/retry-policy
 */
import { AUTO_RECOVERY_LIMIT } from "./recovery-ledger.js";
import { resolveRunningStatusText } from "./status-dom.js";

/**
 * 自动恢复每次失败后的等待时长（毫秒）。索引从 1 开始，严格对应本次即将
 * 发出的恢复指令次数；超出预算或非法值返回 undefined，调用方应保守地终止
 * 该恢复而不是发出没有明确退避策略的第 6 次指令。
 */
export const RECOVERY_BACKOFF_DELAYS = Object.freeze([2000, 4000, 8000, 16000, 32000]);

export function recoveryDelayForCount(recoveryCount) {
  if (!Number.isSafeInteger(recoveryCount) || recoveryCount < 1 || recoveryCount > AUTO_RECOVERY_LIMIT) return void 0;
  return RECOVERY_BACKOFF_DELAYS[recoveryCount - 1];
}

/**
 * DSH 公开 agent/request-error payload 中允许自动重试的稳定错误码。
 * 这里只接受结构化 failure.code；message、stack 和 reason 文本不参与判定，
 * 因而未知的 upstream_unavailable 变体会 fail-closed。
 */
export const REQUEST_RETRYABLE_FAILURE_CODES = Object.freeze([
  "SERVER",
  "RATE_LIMIT",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  "upstream_unavailable",
  "UPSTREAM_UNAVAILABLE",
  "PI_AI_ERROR",
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "BAD_REQUEST",
  "NO_PROVIDER",
  "NO_ADAPTER",
  "UNKNOWN_MODEL",
  "MODEL_NOT_FOUND",
]);

// PI_AI_ERROR 的 message 来自上游/流传输层，必须匹配已知完整前缀或边界明确的短语。
// 不能用任意 contains：pending、认证、HTTP 4xx、quota 等文案必须保持终态。
const PI_AI_TRANSIENT_MESSAGE_PATTERNS = Object.freeze([
  /^\s*upstream_stream_incomplete(?:\s*:|\b)/i,
  /^\s*upstream_unavailable(?:\s*:|\b)/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?stream[\s_-]+ended[\s_-]+(?:before|without)\b/i,
  /^\s*(?:(?:error|cause|request|stream|upstream)\s*:\s*)?(?:network|connection|socket|fetch)[\s_-]+(?:error|failure|failed|reset|refused|closed|timeout)\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?(?:[A-Za-z][A-Za-z0-9_-]*\s+)?ECONN[A-Z0-9_]*\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?other\s+side\s+closed\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?HTTP2\s+request\s+did\s+not\s+get\s+a\s+response\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?WebSocket\s+closed\s+unexpectedly\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?(?:terminated|(?:the\s+)?(?:request|stream|connection|socket)(?:\s+was)?\s+terminated)\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?premature\s+close\b/i,
]);

const PI_AI_PERMANENT_MESSAGE_PATTERNS = Object.freeze([
  /\b(?:pending|deferred|unauthorized|forbidden|invalid[\s_-]+request|model[\s_-]+not[\s_-]+allowed|quota)\b/i,
  /(?:^|[^0-9])(?:400|401|403|413)(?=$|[^0-9])/i,
  /\b(?:authentication|authorization|credential)[\s_-]+(?:failed|invalid|missing|required|denied)\b/i,
]);

/**
 * PI_AI_ERROR 中已知的永久错误只按结构化 message 的明确边界匹配。
 * 未知 message 保持既有未知错误策略，不在这里擅自扩大终态集合。
 * @param {string} [message] - PI AI 错误消息。
 * @returns {boolean} 已知永久消息返回 true。
 */
export function isPermanentPiAiMessage(message) {
  return typeof message === "string"
    && PI_AI_PERMANENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * PI_AI_ERROR 只允许已知上游/流传输模式进入 request retry。
 * @param {object} [failure] - 公开 request-error payload 的结构化 failure。
 * @returns {boolean} 已知瞬态 PI AI 错误返回 true。
 */
export function isTransientPiAiFailure(failure) {
  if (failure === null || typeof failure !== "object" || failure.code !== "PI_AI_ERROR") return false;
  if (isPermanentPiAiMessage(failure.message)) return false;
  return typeof failure.message === "string"
    && PI_AI_TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(failure.message));
}

/**
 * 判断 PI_AI_ERROR 是否是已知永久错误，以阻止 child turn/end continuation。
 * @param {object} [failure] - turn/end reason.error 或 request failure。
 * @returns {boolean} 已知永久 PI AI 错误返回 true。
 */
export function isPermanentPiAiFailure(failure) {
  return failure !== null
    && typeof failure === "object"
    && failure.code === "PI_AI_ERROR"
    && isPermanentPiAiMessage(failure.message);
}

/**
 * 判断一个 agent/request-error failure 是否属于插件允许接管的瞬态错误。
 * @param {object} [failure] - 公开 request-error payload 的结构化 failure。
 * @returns {boolean} code 和 PI_AI_ERROR message 均明确可重试时返回 true。
 */
export function isTransientRequestFailure(failure) {
  if (failure === null || typeof failure !== "object" || typeof failure.code !== "string") return false;
  if (failure.code === "PI_AI_ERROR") return isTransientPiAiFailure(failure);
  return REQUEST_RETRYABLE_FAILURE_CODES.includes(failure.code);
}

/**
 * 判断 Host 的 dsh-llm-retry 是否声明会处理该结构化错误。插件只用它避免
 * 另起并发退避；实际等待和 durable retry 事件仍由 Host 公开 hook 处理。
 * @param {object} [retryPolicy] - request-error payload 的 resolved retryPolicy。
 * @param {object} [failure] - request-error payload 的结构化 failure。
 * @returns {boolean} Host policy 覆盖该 code 时返回 true。
 */
export function requestRetryPolicyCoversFailure(retryPolicy, failure) {
  if (!isTransientRequestFailure(failure) || retryPolicy === null || typeof retryPolicy !== "object") return false;
  if (retryPolicy.mode === "always") return true;
  return retryPolicy.mode === "normal"
    && Array.isArray(retryPolicy.retryableCodes)
    && retryPolicy.retryableCodes.includes(failure.code);
}

/**
 * 创建一个 Agent/Session 绑定的请求级重试状态。WeakSet/WeakMap 只保存运行时
 * 对象身份，不把 payload 或 failure 写入持久日志；Set 仅保存不透明 requestId。
 */
export function createRequestRetryState(session) {
  return {
    session,
    turn: void 0,
    step: void 0,
    retryCount: 0,
    exhausted: false,
    generation: 0,
    seenPayloads: new WeakSet(),
    seenFailures: new WeakSet(),
    seenRequestIds: new Set(),
  };
}

/**
 * 切换到新的 Session/turn/step 前清空请求级去重和预算状态。
 * @param {object} state - createRequestRetryState 返回的状态。
 * @param {object} session - 当前 durable Session。
 * @param {number} [turn] - 新 turn。
 * @param {number} [step] - 新 step。
 * @returns {object} 原状态，便于调用方链式保存。
 */
export function resetRequestRetryState(state, session, turn, step) {
  if (state === null || typeof state !== "object") return state;
  if (typeof state.waitController?.abort === "function") state.waitController.abort();
  state.waitController = void 0;
  state.session = session;
  state.turn = Number.isSafeInteger(turn) ? turn : void 0;
  state.step = Number.isSafeInteger(step) ? step : void 0;
  state.retryCount = 0;
  state.exhausted = false;
  state.generation = Number.isSafeInteger(state.generation) ? state.generation + 1 : 1;
  state.activeKey = void 0;
  state.seenPayloads = new WeakSet();
  state.seenFailures = new WeakSet();
  state.seenRequestIds = new Set();
  return state;
}

/**
 * 标记一次 request-error 事件并按对象/requestId 去重。没有可靠对象身份或
 * requestId 时不猜测结构等价，允许后续真实请求尝试继续消耗独立预算。
 * @param {object} state - 请求级状态。
 * @param {object} payload - request-error payload。
 * @param {object} [failure] - payload.failure。
 * @returns {boolean} 已处理过同一事件对象时返回 true。
 */
export function markRequestRetryEvent(state, payload, failure) {
  if (state === null || typeof state !== "object") return false;
  const payloadObject = payload !== null && (typeof payload === "object" || typeof payload === "function");
  const failureObject = failure !== null && (typeof failure === "object" || typeof failure === "function");
  const requestId = typeof failure?.requestId === "string" && failure.requestId.length > 0
    ? failure.requestId : void 0;
  const duplicate = (payloadObject && state.seenPayloads.has(payload))
    || (failureObject && state.seenFailures.has(failure))
    || (requestId !== void 0 && state.seenRequestIds.has(requestId));
  if (payloadObject) state.seenPayloads.add(payload);
  if (failureObject) state.seenFailures.add(failure);
  if (requestId !== void 0) state.seenRequestIds.add(requestId);
  return duplicate;
}

/**
 * 清除某个 recovery op 自己持有的 timer（可重复调用）。先摘掉句柄并标记取消，
 * 再调用注入的 clearTimeout，确保迟到 callback 即使无法被宿主取消也不会 dispatch；
 * 不读取或改写其他 op 的状态。
 */
export function clearRecoveryOpTimer(op, clearTimeoutFn = globalThis.clearTimeout) {
  if (op === null || typeof op !== "object") return false;
  const timer = op.timer;
  if (timer === void 0) return false;
  op.timer = void 0;
  op.timerCancelled = true;
  if (typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  return true;
}

/**
 * 为一个 recovery op 安排唯一的退避 timer。scheduler、生命周期 guard 和错误
 * 收口均可注入，测试无需真实等待；生产调用使用宿主 setTimeout。timer 到期后
 * 只负责清除自身句柄并调用 onReady，具体 queueMicrotask、record/op 身份检查和
 * manager admission 仍由插件调用方完成。
 *
 * timerScheduled 一旦置 true 就不会再次安排同一 op；timerFired/timerCancelled
 * 处理重复、迟到和取消竞态。onReady 或 isActive 抛错/拒绝时交给 onError，避免
 * timer callback 产生未处理异常。
 */
export function scheduleRecoveryOpTimer(op, recoveryCount, onReady, options = {}) {
  if (op === null || typeof op !== "object" || typeof onReady !== "function") return false;
  if (op.done === true || recoveryOpIsAccepted(op) || op.timerScheduled === true) return false;
  const delay = recoveryDelayForCount(recoveryCount);
  if (delay === void 0) return false;
  const setTimeoutFn = typeof options?.setTimeout === "function" ? options.setTimeout : globalThis.setTimeout;
  const clearTimeoutFn = typeof options?.clearTimeout === "function" ? options.clearTimeout : globalThis.clearTimeout;
  const isActive = typeof options?.isActive === "function" ? options.isActive : () => true;
  const onError = typeof options?.onError === "function" ? options.onError : () => {};
  if (typeof setTimeoutFn !== "function") return false;

  op.timerScheduled = true;
  op.timerCancelled = false;
  let timer;
  const reportError = (error) => {
    try {
      onError(error);
    } catch {
      // 错误处理器本身不能把宿主 timer callback 变成未处理异常。
    }
  };
  const callback = () => {
    if (op.timerFired === true || op.timerCancelled === true) return;
    op.timerFired = true;
    // callback 开始即清空句柄；后续 admission/queue 只靠 op/record guard 防迟到。
    op.timer = void 0;
    let active;
    try {
      active = isActive() === true;
    } catch (error) {
      reportError(error);
      return;
    }
    if (!active) return;
    try {
      const result = onReady();
      if (result !== void 0 && result !== null && typeof result.then === "function") {
        Promise.resolve(result).catch(reportError);
      }
    } catch (error) {
      reportError(error);
    }
  };
  try {
    timer = setTimeoutFn(callback, delay);
  } catch (error) {
    reportError(error);
    return false;
  }
  // 处理测试 scheduler 或宿主替换实现意外同步触发 callback 的边界，避免把
  // 已到期的句柄重新写回 op，造成后续 clear/dispatch 误判。
  if (op.timerFired === true || op.timerCancelled === true) {
    if (timer !== void 0 && typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  } else {
    op.timer = timer;
  }
  return true;
}

/**
 * 创建一个自动恢复 op（B4）：每个触发恢复的 turn 一个**独立** op，互不串链、
 * 互不重复恢复——单个全局槽位无法区分并发恢复。普通 steer 与自动恢复
 * 交错时仍由插件统一 helper 管理：自动恢复和 queue=true continuation 都走公开
 * manager sendMessage；自动恢复不调用 interrupt，普通 queue=false 才先请求取消，最终仍由 sendMessage 完成 admission。
 * @param {number|string} id - op 唯一 id（调用方保证单调递增）。
 * @param {number} triggerTurn - 触发恢复的 turn 号。
 * @returns {object} 新的 op：{ id, triggerTurn, messageId:null, accepted:false,
 *   dispatching:false, taskKeys:Set, activityIds:Set, controller, done }——accepted
 *   表示 manager sendMessage 已越过 admission 边界，即使外围 callback 尚未消费
 *   messageId 也不可 supersede；dispatching 表示同 scope 锁内正在等待该边界。
 *   taskKeys 是本 op 对应的原任务 key；
 *   activityIds 是独立于 task binding LRU 的活动范围终态关联（恢复链跨 op
 *   传播，S1-C）；controller 供统一投递 helper 的 signal 使用，
 *   由 dispatchRecovery 填写、dropRecoveryRecord 清理时 abort。timer 由
 *   scheduleRecoveryOpTimer 填写，timerScheduled/timerFired/timerCancelled
 *   共同防止同一 op 重复安排、迟到 callback 和取消竞态。
 */
export function createRecoveryOp(id, triggerTurn) {
  return {
    id,
    triggerTurn,
    messageId: null,
    // manager sendMessage 返回 messageId 前为 false；即使 messageId 尚未被外层
    // 回调消费，accepted=true 也表示消息已经越过 manager admission 边界。
    accepted: false,
    // dispatchRecovery 持有同 scope 锁等待 manager admission 时置 true；
    // supersede 不应在未知 acceptance 的窗口强行取消它。
    dispatching: false,
    // S1-C：本 op 对应的原任务 key 集合。首个 op 由触发 turn 的消息 id 反查
    // record.tasks 填入；恢复链上后续 op 继承前一个 op 的 taskKeys——恢复 turn
    // 完结时据此把结局回写到原任务绑定（success/failed），不因消息 id 变化丢失。
    taskKeys: new Set(),
    // P1：即使 record.tasks 已淘汰原 binding，恢复投递失败或后续终态仍能
    // 精确撤销对应 affectedPaths 活动登记，不影响同 child 的其他任务。
    activityIds: new Set(),
    controller: void 0,
    // timer 生命周期由 shared.js seam 管理；未安排时句柄为空。
    timer: void 0,
    timerScheduled: false,
    timerFired: false,
    timerCancelled: false,
    done: false,
  };
}

/**
 * 判断 manager 是否已经接受恢复消息（纯函数）：
 * messageId 可能还没被外围回调消费，但 accepted=true 已经越过
 * manager sendMessage 的 admission 边界，不能再被普通新任务 supersede。
 * @param {object} [op] - recovery op。
 * @returns {boolean} 已接受返回 true。
 */
export function recoveryOpIsAccepted(op) {
  if (op === null || typeof op !== "object") return false;
  return op.accepted === true || (typeof op.messageId === "string" && op.messageId.length > 0);
}

/**
 * 判断 recovery op 是否仍可被新任务取代（纯函数）：
 * dispatching 表示同 scope 锁内正在等待 manager admission，状态尚未确定，
 * 也不能在锁外抢先取消；accepted/messageId 则明确表示已越过 acceptance 边界。
 * @param {object} [op] - recovery op。
 * @returns {boolean} 仍可 supersede 返回 true。
 */
export function recoveryOpCanBeSuperseded(op) {
  if (op === null || typeof op !== "object") return false;
  if (op.done === true || op.dispatching === true) return false;
  return !recoveryOpIsAccepted(op);
}

/**
 * 在 pending 恢复 op 中查找「恢复消息已落入该 turn」的 op（B4）：
 * 恢复 turn 结束时按恢复 messageId 找到对应 op 并完结（done）；
 * 随后该 turn 再失败时按正常规则创建新 op。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {Set<string>} [turnMsgIds] - 该 turn 的消息 id 集合（含 claimed 并集）。
 * @returns {object|undefined} 匹配的 op；无匹配返回 undefined。
 */
export function findRecoveryOpByMessage(pendingRecoveries, turnMsgIds) {
  if (!(pendingRecoveries instanceof Map) || !(turnMsgIds instanceof Set)) return void 0;
  for (const op of pendingRecoveries.values()) {
    if (typeof op?.messageId === "string" && turnMsgIds.has(op.messageId)) return op;
  }
  return void 0;
}

/**
 * 是否存在触发该 turn 的进行中恢复 op（扫描场景判定「恢复是否已发出」，B4）。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {number} turn - turn 号。
 * @returns {boolean} 存在未完结且 triggerTurn === turn 的 op 返回 true。
 */
export function recoveryOpPendingForTurn(pendingRecoveries, turn) {
  if (!(pendingRecoveries instanceof Map) || !Number.isSafeInteger(turn)) return false;
  for (const op of pendingRecoveries.values()) {
    if (op?.triggerTurn === turn && op?.done !== true) return true;
  }
  return false;
}

/**
 * op 是否仍挂在该记录的 pending 表里（B7）：steer 异步回调落地前必须校验
 * （记录被删除/插件卸载/父代理销毁后，回调必须丢弃，不能推进已失效的状态）。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {object} [op] - 要校验的 op。
 * @returns {boolean} 仍 pending 返回 true。
 */
export function recoveryOpIsPending(pendingRecoveries, op) {
  return pendingRecoveries instanceof Map && pendingRecoveries.get(op?.id) === op && op?.done !== true;
}

/**
 * 判断 recovery microtask 是否可以在创建 tracker scope 前开始 dispatch（纯函数）。
 * 必须同时确认 child 仍映射到同一 record，且 op 仍挂在 pending 表、尚未 accepted；
 * 这样父销毁/插件卸载后的迟到 microtask 会直接返回，不会由 serialize 的 entryOf
 * 重建一个空 scope。调用方在 guard 与 serialize 之间不得 await。
 * @param {Map<string, object>} [recoveryRecords] - childId -> recovery record。
 * @param {string} childId - microtask 捕获的 child session id。
 * @param {object} [record] - microtask 捕获的 recovery record。
 * @param {object} [op] - microtask 捕获的 recovery op。
 * @returns {boolean} 仍可开始 dispatch 返回 true。
 */
export function recoveryDispatchCanStart(recoveryRecords, childId, record, op) {
  return recoveryRecords instanceof Map
    && recoveryRecords.get(childId) === record
    && recoveryOpIsPending(record?.pendingRecoveries, op)
    && !recoveryOpIsAccepted(op);
}

/**
 * 把 turn/end 的 reason 转成面向子代理的中文原因说明。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {string} 中文原因文案。
 */
export function recoveryReasonText(reason) {
  const kind = reason?.kind;
  if (kind === "error") {
    const message = reason?.error?.message;
    if (typeof message === "string" && message.length > 0) return `执行出错：${message}`;
    return "执行出错";
  }
  if (kind === "max-tokens") return "达到输出 token 上限";
  if (kind === "completed") return "没有返回任何文本输出";
  if (kind === "aborted") return "执行被取消";
  // B9：blocked（pre-step 拒绝，消息被认领但未落盘）与 refusal 统一为「任务被拒绝」。
  if (kind === "refusal" || kind === "blocked") return "任务被拒绝";
  return `未知结束原因（${String(kind ?? "未知")}）`;
}

/**
 * 生成自动恢复的「继续执行」指令（以 user 消息文本发送给子代理）。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {string} 中文恢复指令文本。
 */
export function buildRecoveryMessage(reason) {
  return `你上一次执行没有返回有效结果（原因：${recoveryReasonText(reason)}）。请继续完成你收到的原始任务，并在完成后给出完整最终回复；不要重复已经成功的步骤。`;
}

/**
 * 从会话事件日志中读取最近一次 turn/end 的底层错误消息（纯函数形态的
 * childTurnError：只读 events，不依赖 Agent 对象）。
 * @param {Array} [events] - session.events。
 * @returns {string|null} 最近一次底层错误消息；无可用详情返回 null。
 */
export function lastTurnErrorMessage(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "turn/end") continue;
    const message = event?.data?.reason?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}
