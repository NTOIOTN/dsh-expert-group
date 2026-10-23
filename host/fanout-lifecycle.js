/**
 * fan-out attempt 生命周期服务（R2 票据 10：fanout-host 拆为三服务 + coordinator）。
 *
 * ## 职责（record 的「出生 -> 结算 -> 关闭」）
 * 1. **admission**：launcher / canceller / continueShard 的守卫、可控 admission 句柄、
 *    buildRequest -> startContinuable / continueMessage 的异步推进；
 * 2. **admission 期间的事件暂存与受限回放**：stageAdmissionEvent / takeAdmissionEvents /
 *    replayAdmissionEvents；
 * 3. **结算**：finishRecord（resolve/reject record 的 deferred，并释放暂存与老化定时器）；
 * 4. **agent 侧接线**：handleAgentCreated / handleAgentDisposed / deferDisposal；
 * 5. **会话事件路由**：handleSessionEvent（turn/end -> 归属判定 -> 结算）；
 * 6. **关闭**：close（先封锁 admission，再逐个收敛 record，最后关闭 manager）。
 *
 * ## 状态
 * 本服务**不持有任何 Map/Set**：attempt 注册表与归属索引归 attribution 服务，事件日志归
 * event-log 服务。record 上的字段（phase / cancelRequested / pendingAdmissionEvents /
 * pendingDisposal 等）是 admission 阶段的局部生命周期标记，随 record 一起由 attribution
 * 的注册表持有并在 finishRecord 时释放。
 *
 * ## 依赖方向
 * lifecycle -> attribution -> event-log，单向 import，无 ESM 环。
 * 事件广播（onEvent）只在 coordinator 发生；本服务发起的归属诊断经
 * `attribution.reportViolation` 转给 manager，不自行发布或重排事件。
 */
import {
  cloneJson,
  completionIsSuccess,
  eventIsTurnEnd,
  extractFanoutResult,
  fanoutCompletionError,
  hasTerminalTurnReason,
  isObject,
  turnOf,
  turnReason,
} from "./fanout-event-log.js";
import {
  childIdOf,
  fanoutAttemptKey,
  isFanoutAgent,
  isFanoutIdentity,
  nonEmptyText,
  sessionIdOf,
} from "./fanout-attribution.js";
import { checkTaskInputBudget } from "../resource-budget.js";

/**
 * continuation admission 期间暂存的终态事件上限。
 *
 * 为什么需要暂存：续作的 messageId 只有 `continueMessage()` resolve 之后才知道，而新轮的
 * turn/end 可能在那之前到达。没有暂存时这类事件会被 knownIds 当成旧 child 的迟到事件吞掉，
 * 且没有任何回放 -> 新 attempt 永久 running。
 *
 * 上限语义（有界 + 只保留最新的终态事实）：超过上限时丢弃**最旧**的一条。理由是最新的
 * 终态事件更可能属于新轮（旧轮的迟到事件通常更早到达）；丢弃是 fail-closed 方向——
 * attempt 保持 running，等下一次真正的 turn/end 或超时/取消收敛，绝不猜测归属。
 */
const CONTINUATION_ADMISSION_EVENT_LIMIT = 8;

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

/**
 * 输入预算拒绝的显式错误（launcher 与 continueShard 共用）。
 *
 * 字段与拆分前逐字一致（name/code/resource/receivedBytes/maxBytes/complete/recoverable）：
 * manager 与 RPC 都按这些字段分类，不能因为提取 helper 而丢字段。
 */
function inputBudgetError(violation) {
  const error = new Error(violation.message);
  error.name = "BudgetExceededError";
  error.code = violation.code;
  error.resource = violation.resource;
  error.receivedBytes = violation.receivedBytes;
  error.maxBytes = violation.maxBytes;
  error.complete = false;
  error.recoverable = violation.recoverable;
  return error;
}

/**
 * 结算单元：record 的终态收敛、admission 期间终态事件的暂存/取出/受限回放、disposal 待决标记。
 *
 * 这些逻辑只操作 record 自身的字段（pendingAdmissionEvents / pendingDisposal / finished…）
 * 与 attribution 暴露的命令；它们不持有新的 Map/Set，也不发布任何事件。
 */
function createRecordSettlement({ attribution }) {
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
   * `managerPort.attemptMessageIdOf()` 还读不到本轮 messageId，严格判定必然失败。
   */
  function replayAdmissionEvents(record) {
    const staged = takeAdmissionEvents(record);
    if (staged.length === 0 || record.finished === true) return;
    for (const stagedEvent of staged) {
      if (record.finished === true) break;
      const session = isObject(stagedEvent.session) ? stagedEvent.session : record.session;
      const event = { type: "turn/end", data: { turn: stagedEvent.turn, reason: stagedEvent.reason } };
      const verdict = attribution.continuationAttribution(record, session, event);
      if (verdict.ok !== true) {
        attribution.reportViolation(record, verdict);
        continue;
      }
      if (stagedEvent.success === true) finishRecord(record, true, extractFanoutResult(session, stagedEvent.turn));
      else finishRecord(record, false, fanoutCompletionError(stagedEvent.reason, event));
    }
  }

  function finishRecord(record, success, value) {
    if (record.finished) return false;
    record.finished = true;
    // 生命周期终点：老化窗口一并关闭，绝不让定时器在结算之后仍触发 manager 调用。
    attribution.releaseAgingTimer(record);
    // 生命周期终点：无论成功/失败/取消/关闭，admission 暂存与 disposal 待决标记都必须立刻
    // 释放（不持有 session 与终态事实，避免悬挂记录与内存泄漏）。
    takeAdmissionEvents(record);
    record.pendingDisposal = undefined;
    attribution.forgetRecord(record);
    if (success) record.deferred.resolve(cloneJson(value));
    else record.deferred.reject(value instanceof Error ? value : fanoutCompletionError(value));
    return true;
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

  return { stageAdmissionEvent, takeAdmissionEvents, replayAdmissionEvents, finishRecord, deferDisposal };
}

/**
 * 中断单元：parent-authorized interrupt 的唯一执行面 + 「同一 attempt 最多 interrupt 一次」判重。
 *
 * 判重状态（interruptedKeys / interruptedKeyOrder）由 attribution 注册表持有，本单元只调用
 * 它的命令（interruptKeyFor / isInterrupted / rememberInterrupted），不保留可写引用。
 */
function createAttemptInterrupt({ log, attribution, interrupt }) {
  function requestChildInterrupt(record, input, childId) {
    if (childId === undefined || typeof interrupt !== "function") return false;
    if (record?.interruptRequested === true) return false;
    // close 会清空 records；此时同一 attempt 的判重只能靠 key 集合，否则迟到的
    // canceller（manager 仍持有 attempt.childId）会重复 interrupt 同一个 child。
    const key = record?.key ?? attribution.interruptKeyFor(input);
    if (key !== undefined && attribution.isInterrupted(key)) return false;
    if (record !== undefined) record.interruptRequested = true;
    if (key !== undefined) attribution.rememberInterrupted(key);
    const parentAgent = record?.parentAgent;
    try {
      const result = interrupt({ childId, parentAgent, input, handle: record?.handle });
      if (result !== null && typeof result === "object" && typeof result.catch === "function") {
        result.catch((error) => log("fan-out interrupt failed", error));
      }
    } catch (error) {
      log("fan-out interrupt failed", error);
    }
    return true;
  }

  return { requestChildInterrupt };
}

/**
 * admission 单元：首轮 launcher / 续作 continuer / canceller 的守卫与异步推进。
 *
 * 返回的是可控 admission 句柄（thenable），manager 只按 Promise 语义消费；close() 能在同一
 * 同步栈内把关闭错误交给 manager（见 createAdmissionHandle）。
 */
function createAttemptAdmission({ log, attribution, buildRequest, startContinuable, continueMessage, settlement, requestInterrupt }) {
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
      if (attribution.hasAttempt(key)) throw new Error("fan-out attempt 已存在: " + key);
      // close 已经封锁 admission：manager 在 runtime 单独关闭时未必同时关闭，仍可能派发
      // queued shard。此时绝不能再进入 buildRequest/startContinuable——关闭后启动的 child
      // 已不在 records 里，没有任何路径能 interrupt 或结算它（会变成永久悬挂的 live child）。
      if (attribution.isClosed()) throw fanoutRuntimeClosedError();
      // admission 前的输入预算复核：prompt 超限必须显式失败，绝不以截断后的正文
      // 派发专家（manager 已在 submit 阶段拒绝；这里防的是运行期二次装配的差异）。
      const inputVerdict = checkTaskInputBudget({
        basePrompt: input.basePrompt,
        shardPrompt: input.prompt,
        subject: input.parentTaskId + "/" + input.shardId + "#" + input.attempt,
      });
      if (!inputVerdict.ok) throw inputBudgetError(inputVerdict.violation);
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
      attribution.registerAttempt(record);
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
      const prepared = await buildRequest(input, record.controller.signal);
      // close 可能落在 buildRequest 等待期间：此处必须停止 admission，否则会为一个已经
      // 关闭的 runtime 启动新 child。record 若已被 close 结算，finishRecord 不会再结算一次；
      // 关闭错误最终由 manager 按一次性的启动失败/取消语义收敛本次 attempt。
      if (attribution.isClosed()) throw fanoutRuntimeClosedError();
      record.phase = "start";
      const request = isObject(prepared) && Object.prototype.hasOwnProperty.call(prepared, "request") ? prepared.request : prepared;
      record.parentAgent = prepared?.parentAgent ?? request?.parent;
      record.parentId = prepared?.parentId ?? record.parentAgent?.id;
      record.role = prepared?.role ?? input.role;
      const started = await startContinuable({
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
      if (!record.finished) attribution.registerRoute(record, childId, record.sessionId);
      if (record.cancelRequested === true || record.finished === true) {
        requestInterrupt(record, { ...input, reason: record.finished ? "runtime_closed" : "cancelled" }, childId);
      }
      // 关闭已经把 admission 结算过时，这里是一次幂等的 no-op。
      record.admission.resolve(handle);
      return handle;
    } catch (error) {
      settlement.finishRecord(record, false, error);
      record.admission.reject(error);
      return undefined;
    }
  }

  function canceller(input) {
    const record = attribution.recordFor(fanoutAttemptKey(input.parentTaskId, input.shardId, input.attempt));
    if (record !== undefined) record.cancelRequested = true;
    try { record?.controller?.abort(); } catch (error) { log("fan-out admission abort failed", error); }
    requestInterrupt(record, input, input.childId ?? record?.childId);
  }

  /**
   * 多轮复用：把一个 continuation attempt 投递给**同一 child**。
   *
   * 与 launcher 的差别有三点：
   * 1. 不新建 child，通过注入的 `continueMessage` 把本轮 prompt 发给 input.childId；
   * 2. **admission 之前**就登记会话路由（childId/sessionId -> 本 record），让本轮 turn/end
   *    有明确投递目标；若等 messageId 落地后再登记，新轮的 turn/end 会落在"无人认领"窗口里
   *    被 knownIds 吞掉且无法回放 -> 新 attempt 永久 running（终审问题 2）；
   * 3. admission 期间的终态事件进**有界暂存**，绑定 messageId 后严格回放（见 replayAdmissionEvents）。
   * 守卫（重复 attempt / 已关闭 / 未接线 / 输入超预算）与 launcher 一致，都以 rejection 表达，
   * 由 manager 记为本轮 attempt 的启动失败（历史一致，不半写）。
   */
  function continueShard(input) {
    const admission = createAdmissionHandle();
    try {
      const key = fanoutAttemptKey(input.parentTaskId, input.shardId, input.attempt);
      if (attribution.hasAttempt(key)) throw new Error("fan-out attempt 已存在: " + key);
      if (attribution.isClosed()) throw fanoutRuntimeClosedError();
      const childId = nonEmptyText(input.childId);
      if (childId === "") throw new Error("fan-out continuation 需要既有 childId");
      if (typeof continueMessage !== "function") {
        throw new Error("fan-out continuation 未接线 continueMessage，拒绝复用既有 child");
      }
      const inputVerdict = checkTaskInputBudget({
        basePrompt: input.basePrompt,
        shardPrompt: input.prompt,
        subject: input.parentTaskId + "/" + input.shardId + "#" + input.attempt,
      });
      if (!inputVerdict.ok) throw inputBudgetError(inputVerdict.violation);
      // session 可能尚未加载（冷 child）：按 childId 绑定路由即可（DSH continuable child 的
      // session id 就是 childId）；真正的可继续性由 sendMessage 显式决定。
      const session = attribution.continuationSession(childId);
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
        // sessionId 先按 childId 兜底，随后由 bindSession 归一化；初始化 0 代次。
        sessionId: childId,
        sessionGeneration: 0,
        admission,
        pendingAdmissionEvents: [],
      };
      attribution.registerAttempt(record);
      // 关键顺序：先登记路由（含 session 实例），再进入异步投递——否则 admission 期间的
      // turn/end 无人认领（既不会被暂存也不会被回放），新 attempt 会永久 running。
      // 冷 child 没有实例时先按 childId 兜底登记，随后由 bindSession 用真实实例归一化。
      attribution.registerRoute(record, childId, record.sessionId);
      attribution.bindSession(record, session, childId);
      // 记下本 record 的初始 session 代次：runContinuation 在 await 之后只有代次未推进时
      // 才允许补写自己预解析到的实例（最新 session 优先，见 bindSession）。
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
      const parentAgent = attribution.resolveParentAgent(input.parentTaskId);
      record.parentAgent = parentAgent;
      record.parentId = parentAgent?.id;
      record.role = input.role;
      // 本轮正文由 Host 装配（与首轮 buildRequest 同一套文案/persona 纪律）：runtime 只
      // 把「同一 child 的新一轮」这件事连同分片/attempt/round 身份交给 Host。
      const sent = await continueMessage({
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
        attribution.bindSession(record, resolvedSession, childId);
      } else if (!isObject(record.session) && isObject(resolvedSession)) {
        // 代次推进但当前没有可用实例（异常形态）：仍以最新代次补一个可用实例，绝不落空。
        attribution.bindSession(record, resolvedSession, childId);
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
          attribution.registerRoute(record, childId, record.sessionId);
        }
      }
      if (record.cancelRequested === true || record.finished === true) {
        requestInterrupt(record, { ...input, reason: record.finished ? "runtime_closed" : "cancelled" }, childId);
      }
      record.admission.resolve(handle);
      /**
       * 绑定后受限回放：必须等 manager 消费 admission 句柄（attempt.messageId 落地）之后再
       * 做严格判定，否则 `attribution.continuationAttribution()` 里的 manager 读面还读不到
       * 本轮 messageId。
       * 排队顺序保证：admission.resolve 触发的 manager `.then` 回调先于本 microtask 执行。
       */
      if (record.finished !== true) queueMicrotask(() => settlement.replayAdmissionEvents(record));
      return handle;
    } catch (error) {
      // 失败同样释放暂存（finishRecord 内部 takeAdmissionEvents）：不留下悬挂的终态事实。
      settlement.finishRecord(record, false, error);
      record.admission.reject(error);
      return undefined;
    }
  }

  return { launcher, canceller, continueShard };
}

/**
 * agent 事件接线单元：created / disposed / session turn-end 三条入口。
 *
 * 只做路由与结算，不发布事件；归属判定与诊断全部委托 attribution（唯一 owner）。
 */
function createAgentHandlers({ log, attribution, settlement, onAgentCreated }) {
  function handleSessionEvent(session, event) {
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    const record = attribution.recordForSession(session);
    // record 在成功/失败/超时后会立即删除，但该 child 的后续事件仍属于
    // fan-out；用 bounded known id 集合保持旧 recovery 路由的 fail-closed 边界。
    if (record === undefined) {
      if (sessionId === undefined) return false;
      // 1) 有界 id 索引：覆盖最近见过的 child，包括 cold-resume 后换了新 session
      //    实例但 id 相同的形态。
      if (attribution.isKnownSessionId(sessionId)) return true;
      // 2) 弱引用 session 索引：id 被 LRU 驱逐后，同一个 session 实例的迟到事件
      //    仍然 fail-closed（返回 true 由 fan-out 吞掉），不回落成普通恢复 child。
      //    顺序不可交换：id 判定在前，保住 id 索引能覆盖的、形态更宽的识别面。
      //    残余边界：驱逐后同 id 的全新 session 实例（重建/cold-resume）无从识别，
      //    此时仍返回 false——这是有界索引的固有代价，由回归测试显式固定。
      return attribution.isFanoutSessionInstance(session);
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
     * 判定 -> 找不到本轮 messageId -> 只留 `shard_attribution_unproven` 诊断，不会覆盖新轮。
     */
    const attributionSession = isObject(session) ? session : record.session;
    if (record.continuation === true) {
      // admission 期间（messageId 尚未绑定）：先放进有界暂存（含来源 session），绑定后严格回放。
      // 这样「新轮 turn/end 先到」不会被 knownIds 吞掉且无回放，也不会被当作已绑定的轮次结算。
      if (record.phase === "continue" && record.finished !== true) {
        settlement.stageAdmissionEvent(record, attributionSession, event);
        return true;
      }
      // 多轮复用：同一 child/session 承载多个 attempt，必须**严格证明**本轮归属才允许结算。
      // 任何一条证据缺失都保持 attempt 未结算，并留下结构化诊断（不沿用首轮的宽松 fallback）。
      const verdict = attribution.continuationAttribution(record, attributionSession, event);
      if (verdict.ok !== true) {
        attribution.reportViolation(record, verdict);
        return true;
      }
    } else if (!attribution.turnMatchesRecordMessage(record, attributionSession, event)) {
      // 首轮 launcher attempt：保持既有宽松 fallback（messageId/turn 不可读时按旧行为结算）。
      return true;
    }
    const turn = turnOf(event);
    if (completionIsSuccess(event)) settlement.finishRecord(record, true, extractFanoutResult(attributionSession, turn));
    else settlement.finishRecord(record, false, fanoutCompletionError(turnReason(event), event));
    return true;
  }

  function handleAgentCreated(agent, persistedIdentity) {
    if (!isFanoutAgent(agent) && !isFanoutIdentity(persistedIdentity)) return false;
    /**
     * 与 index.js 的 guard 安装前预检是**同一份判定**：直接调用方（测试替身、未来入口）
     * 也必须 fail-closed，不能让不一致的 marker 借「没有对应 record」的 false 绕过边界。
     */
    const precheckVerdict = attribution.precheckChildIdentity(agent, persistedIdentity);
    if (precheckVerdict.ok !== true) {
      log("fan-out agent/created identity precheck rejected: " + precheckVerdict.reason);
      return false;
    }
    // 预检通过时 identity 必然存在（ok:true 的唯一构造路径），不再重复判空。
    const { parentTaskId, parentAgentId, shardId, attempt } = precheckVerdict.identity;
    const key = fanoutAttemptKey(parentTaskId, shardId, attempt);
    const sessionId = sessionIdOf(agent);
    attribution.rememberKnownId(childIdOf(agent) ?? agent?.id);
    attribution.rememberKnownId(sessionId);
    // 弱引用登记 fan-out session 实例：id 索引被 LRU 驱逐后，同一个 session 实例的
    // 迟到事件仍能识别为 fan-out（见 handleSessionEvent 的 fail-closed 兜底）。
    // 只在标记/持久化身份完整可信时登记，因此不会把普通 child 的 session 误收进来。
    if (isObject(agent?.session)) {
      attribution.rememberSession(agent.session);
      attribution.rememberChildSession(childIdOf(agent) ?? agent.id, agent.session);
    }
    const record = attribution.recordFor(key);
    if (record !== undefined) {
      record.agent = agent;
      /**
       * latest-session：activation 边界安装的新 session 实例优先于 admission 起点预解析的
       * 实例（cold-resume/replacement 期间发生的就是这种替换）。bindSession 会推进
       * sessionGeneration，因此 `runContinuation()` 之后的写回不可能覆盖它。
       */
      const agentChildId = childIdOf(agent) ?? agent.id;
      attribution.bindSession(record, agent.session, typeof agentChildId === "string" ? agentChildId : record.childId);
      /**
       * 新 activation 到位即证明「旧实例 disposal -> cold-resume」替换窗口已经落地：
       * 把 admission 期间的 disposal 待决标记降级为「已知被替换」（只保留计数供诊断），
       * 后续由 runContinuation 的成功/失败结果收敛。
       */
      if (record.pendingDisposal !== undefined && isObject(agent?.session) && agent.session !== record.pendingDisposal.session) {
        record.replacedAfterDisposal = (Number.isSafeInteger(record.replacedAfterDisposal) ? record.replacedAfterDisposal : 0) + 1;
        record.pendingDisposal = undefined;
      }
      record.parentAgent ??= agent.parent;
      record.parentId ??= parentAgentId;
      attribution.registerRoute(record, agentChildId, sessionId);
      try {
        onAgentCreated?.({
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
          role: attribution.expertRoleOf(agent) ?? persistedIdentity?.role,
        });
      } catch (error) {
        log("fan-out agent/created callback failed", error);
      }
    }
    // marker 或可信持久化身份都必须在旧 recovery listener 之前被识别；即使对应
    // attempt 已经在 terminal 后清理，也不能让旧 handler 误认为它是普通恢复 child。
    return true;
  }

  /**
   * fan-out child（或可信持久化身份的 cold child）被销毁。
   *
   * 路由收紧（终审 disposal 竞态）：
   * 1. 未绑定 messageId 的 continuation admission（`phase === "continue"`）：旧实例 disposal
   *    属于「旧 Agent 关闭 -> 同一 child cold-resume」的替换窗口，**不立即终结**，只记待决标记；
   * 2. 已绑定 / 首轮 launcher：disposal 必须明确对应当前 attempt 的**当前 session 实例**
   *    （或无法比较实例时按 id 兜底）才收敛；否则视为迟到/别的实例的 disposal，忽略之
   *    （旧实例销毁不代表当前实例销毁，不能让迟到事件覆盖新 attempt）；
   * 3. 首轮 launcher 的既有 disposal 失败语义保持不变（其当前 session 被销毁 -> failed）。
   */
  function handleAgentDisposed(agent, persistedIdentity) {
    if (!isFanoutAgent(agent) && !isFanoutIdentity(persistedIdentity)) return false;
    const record = attribution.recordForChildId(agent?.id) ?? attribution.recordForSessionId(sessionIdOf(agent));
    if (record === undefined || record.finished === true) return true;
    const disposedSession = isObject(agent?.session) ? agent.session : undefined;
    // 1) 替换窗口：admission 还没绑定 messageId -> 记待决，等 runContinuation 的结果。
    if (record.continuation === true && record.phase === "continue") {
      settlement.deferDisposal(record, agent, disposedSession, sessionIdOf(agent));
      return true;
    }
    // 2) 迟到/别的实例的 disposal：不终结当前 attempt（例如旧实例在 cold-resume 之后才发出
    //    disposed；当前实例仍活着）。
    if (disposedSession !== undefined && isObject(record.session) && disposedSession !== record.session) {
      record.staleDisposalIgnored = (Number.isSafeInteger(record.staleDisposalIgnored) ? record.staleDisposalIgnored : 0) + 1;
      return true;
    }
    // 3) 当前 attempt 的当前 session 被销毁（或无法比较实例）：按既有语义收敛为 failed。
    settlement.finishRecord(record, false, fanoutCompletionError({ kind: "disposed", message: "fan-out child 已销毁" }));
    return true;
  }

  return { handleSessionEvent, handleAgentCreated, handleAgentDisposed };
}

/**
 * 关闭单元：record 收敛 + manager 关闭门。顺序不可交换（见函数内注释）。
 *
 * manager 的 unsubscribe 由 coordinator 在 close() 返回 true 后执行（拆分前排在同一函数
 * 末尾最后一步，因此整体顺序保持不变）。
 */
function createRuntimeClose({ log, attribution, managerPort, settlement, requestInterrupt }) {
  function close() {
    if (attribution.isClosed()) return false;
    attribution.closeGate();
    // 先封锁 admission，再让所有未终态 attempt 收敛：abort admission，对已经拿到
    // childId 的记录发出 best-effort interrupt（同步异常与 rejected Promise 都由
    // requestChildInterrupt 吞并记录），最后用显式关闭错误一次性结算 completion。
    for (const record of attribution.activeRecords()) {
      record.cancelRequested = true;
      // 关闭是老化窗口的终点：清除全部 Host 侧定时器，避免关闭后仍有回调进来。
      attribution.releaseAgingTimer(record);
      try { record.controller?.abort(); } catch (error) { log("fan-out admission abort failed", error); }
      requestInterrupt(record, { ...record.input, reason: "runtime_closed" }, record.childId);
      // 还停在 buildRequest 的 launcher admission（phase=build）与还没拿到 messageId 的
      // 续作 admission（phase=continue）都尚未产生任何 child 句柄：同步以关闭错误收敛，
      // 让 manager 在自身关闭前先看到 failed(runtime_closed)。已经进入 startContinuable /
      // continueMessage 且拿到句柄的 admission 保持原语义——迟到的 childId 仍会被 interrupt
      // 一次，且暂存（pendingAdmissionEvents）随 finishRecord 一并释放，不残留悬挂记录。
      if (record.phase === "build" || record.phase === "continue") {
        record.admission?.settleNow(fanoutRuntimeClosedError());
      }
      settlement.finishRecord(record, false, fanoutRuntimeClosedError());
    }
    // 仍挂在 buildRequest/startContinuable 的 launcher 靠 finished 标记与 interruptedKeys
    // 收敛；清空映射后，迟到的 agent/created、session event、agent disposed 找不到 record，
    // 既不复活记录也不会二次结算。
    attribution.clearRoutes();
    // 共享关闭门：关闭唯一调度状态机的全部写入入口。manager 已被外部（Host facade
    // manager-first 顺序）关闭时，这里只是幂等 no-op。
    try { managerPort.close(); } catch (error) { log("fan-out manager close failed", error); }
    return true;
  }

  return close;
}

/**
 * 创建生命周期服务。
 *
 * 参数是**协作方**而不是任意参数袋（口径见规格书 C3）：
 * - `log`：日志旁路；
 * - `attribution`：归属/注册表服务（唯一 owner，本服务只经其命令面读写）；
 * - `managerPort`：manager 关闭门（close）；
 * - `buildRequest` / `startContinuable`：首轮 admission 的执行 seam；
 * - `continueMessage`：多轮复用投递 seam；
 * - `interrupt`：parent-authorized 中断 seam；
 * - `onAgentCreated`：agent/created 通知 seam。
 *
 * 工厂本体只做单元装配（结算 / 中断 / admission / agent 接线 / 关闭）；每个单元都接收
 * 同一份 deps，不额外持有共享可变状态。
 *
 * @returns {{launcher:Function, continueShard:Function, canceller:Function,
 *   handleSessionEvent:Function, handleAgentCreated:Function, handleAgentDisposed:Function,
 *   close:Function}}
 */
export function createFanoutLifecycle(deps = {}) {
  const settlement = createRecordSettlement(deps);
  const interruption = createAttemptInterrupt(deps);
  const admission = createAttemptAdmission({
    ...deps,
    settlement,
    requestInterrupt: interruption.requestChildInterrupt,
  });
  const handlers = createAgentHandlers({ ...deps, settlement });
  const close = createRuntimeClose({
    ...deps,
    settlement,
    requestInterrupt: interruption.requestChildInterrupt,
  });
  return {
    /** 首轮 admission（manager 的 launcher）。 */
    launcher: admission.launcher,
    /** 多轮复用的续作 admission（manager 的 continuer）。 */
    continueShard: admission.continueShard,
    canceller: admission.canceller,
    handleSessionEvent: handlers.handleSessionEvent,
    handleAgentCreated: handlers.handleAgentCreated,
    handleAgentDisposed: handlers.handleAgentDisposed,
    close,
  };
}
