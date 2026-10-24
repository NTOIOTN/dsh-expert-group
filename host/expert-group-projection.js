/**
 * Expert Group 快照的**纯投影 + 归属判定**库（票据 09 / R2 从 host/expert-group-runtime.js 拆出）。
 *
 * 本模块只承载两类东西：
 * 1. **无状态纯投影**：把不稳定的 DSH 对象形状（session / agent / event / child_models）收敛成
 *    快照层能直接消费的字段。它们没有 Map、timer 或可写模块状态，因此 Host 组合根、阶段投影与
 *    纯函数测试都可以直接复用；
 * 2. **归属判定与冷读的 per-build owner**：`createColdReadCoordinator`（本次构建的读取 promise
 *    缓存 + 全局并发上限）与 `createChildOwnershipResolver`（本次构建的 childOwnership Map）。
 *    后者的 Map **不越出本模块**：对外只有冻结的 `resolveChildOwnership` 命令，调用方读不到
 *    Map、entry 或任何可写引用（规格书 §状态所有权(4)、plan R2.2-a）。
 *
 * 边界（静态图）：
 * - 本模块**不** import `host/expert-group-stage.js` 与 `host/snapshot-cache.js`，因此投影 / 阶段 /
 *   缓存之间没有 import 边；
 * - 阶段投影只通过 runtime 注入的 `expertProjection` 命令集合使用这里的纯函数（stage 不 import
 *   本模块，只持有命令），归属判定则只经 `resolveChildOwnership(childId, parentTaskId)` 调用。
 *
 * @module dsh-expert-group/host/expert-group-projection
 */
import {
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  EXPERT_INHERIT_CONTEXT_MARKER,
  persistedModelRouteIsAuthoritative,
  projectModelRouteFields,
} from "../shared/model-route.js";
import { hasUsageMetrics, projectUsage } from "./usage-projection.js";
import { projectStructuredResult } from "../shared/structured.js";

export function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function firstText(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text !== null) return text;
  }
  return null;
}

export function safeCall(callback, fallback = undefined) {
  try {
    const value = callback();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * 恢复失败的**永久性**原因码集合（票据 04）。
 *
 * 判定语义只服务两处**纯展示**用途：快照 recovery 块里的 retryable 标志、
 * fanout-restore-retry RPC 回执里的 retryable。它**不**限制重试：重试 RPC 对任何原因码
 * 都允许执行（重试会重新读取当前持久化快照，磁盘内容可能已被外部修复）。这里把
 * 「同一份磁盘数据重试也不会变好」的结构性缺陷标成不可自动恢复，客户端据此给出
 * 不同提示；其余（IO/读取失败、未知异常）都可以通过重试自愈。
 */
const PERMANENT_RESTORE_CODES = new Set([
  "INVALID_SNAPSHOT",
  "INVALID_SNAPSHOT_STATUS",
  "INVALID_SNAPSHOT_TRANSITION",
  "UNSUPPORTED_SNAPSHOT_VERSION",
  "INVALID_BUDGET",
  "INVALID_CONCURRENCY_LIMIT",
  "INVALID_SHARD_NAME",
  "INVALID_WRITE_ROLES",
  "INVALID_ALLOW_OVERLAP",
]);

/**
 * 恢复失败原因码 → 是否值得重试（未知/缺失按可重试处理）。
 *
 * 参数是 Host 归一后的稳定 code（大写 token）；非字符串、空串与未登记 code 都返回 true，
 * 因为「不知道原因」永远不能等价于「永久不可恢复」。
 */
export function restoreFailureRetryable(code) {
  const token = nonEmpty(code);
  return token === null ? true : !PERMANENT_RESTORE_CODES.has(token);
}

/**
 * 把 fanoutHost.restoreStatus() 的只读结果归一成快照 recovery 块的候选输入。
 *
 * 投影边界（只读、无副作用）：
 * - lastRestore 为 null ⇒ status "none"（本进程从未执行过恢复）；
 * - lastRestore.ok === true ⇒ status "ok"，**清空** code/message（不残留历史失败细节）；
 * - 其余 ⇒ status "failed"，原因码优先取结构化 error.code，其次取 fail-closed 闸门
 *   记录的 code，最后退化为 RESTORE_FAILED；message 只取 error.message（Host 的
 *   describeRestoreFailure 已保证它不是堆栈），长度与控制字符由快照投影再收敛一次；
 * - persistenceBlocked 如实投影 fail-closed 闸门是否生效（诊断用，不参与渲染判定）。
 *
 * 任何异常/缺字段都收敛为 "none"，绝不影响快照构建本身。
 */
export function recoveryInputFromRestoreStatus(restoreStatus) {
  const source = restoreStatus !== null && typeof restoreStatus === "object" ? restoreStatus : {};
  const blocked = source.blocked !== null && typeof source.blocked === "object" ? source.blocked : null;
  const last = source.lastRestore !== null && typeof source.lastRestore === "object" ? source.lastRestore : null;
  const persistenceBlocked = blocked !== null;
  if (last === null) {
    return { status: "none", code: null, message: null, at: null, retryable: false, persistenceBlocked };
  }
  const at = typeof last.at === "number" && Number.isFinite(last.at) ? last.at : null;
  if (last.ok === true) {
    return { status: "ok", code: null, message: null, at, retryable: false, persistenceBlocked };
  }
  const error = last.error !== null && typeof last.error === "object" ? last.error : null;
  const code = nonEmpty(error?.code) ?? nonEmpty(blocked?.code) ?? "RESTORE_FAILED";
  return {
    status: "failed",
    code,
    message: nonEmpty(error?.message),
    at,
    retryable: restoreFailureRetryable(code),
    persistenceBlocked,
  };
}

/**
 * live Session 不暴露 events 数组，只能通过 snapshotEvents 读取已提交事件；
 * cold session 则由 sessionQuery 直接返回 events。一次快照只读取一次，避免标题、
 * 最近命令和状态分别读取时跨提交撕裂。
 */
export function sessionEvents(session) {
  const projected = safeCall(() => session?.snapshotEvents?.(), undefined);
  if (Array.isArray(projected)) return projected;
  return Array.isArray(session?.events) ? session.events : [];
}

/** 只提取真实文本片段；工具对象、图片和结构化附件不会被序列化进侧边栏。 */
function messageText(message) {
  const content = message?.content ?? message;
  if (typeof content === "string") return nonEmpty(content);
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text : null)
    .filter((part) => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** 最近请求只接受真实 user source，避免把插件反馈或 manager 注入文本误当用户目标。 */
export function recentUserRequest(session, events = sessionEvents(session)) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message" || event?.data?.source?.kind !== "user") continue;
    const text = messageText(event.data?.message ?? event.data?.content);
    if (text !== null) return text;
  }
  return null;
}

/** 冷 child 的首条 user/message 就是 manager 派发 prompt；后续恢复消息不能覆盖它。 */
export function dispatchedPrompt(session, events = sessionEvents(session)) {
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const text = messageText(event.data?.message ?? event.data?.content);
    if (text !== null) return text;
  }
  return null;
}

function latestSessionTitle(session, events = sessionEvents(session)) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "session/title") return firstText(events[index]?.data?.title);
  }
  return null;
}

function latestTurnReason(session, events = sessionEvents(session)) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn/end") return events[index]?.data?.reason ?? null;
  }
  return null;
}

function activityOf(status, events, state = toolCallState(events)) {
  for (const call of state.calls) {
    // turn 已结束的调用不可能还在执行：中断丢结果的孤儿 call 不算 running。
    if (state.turnEnded(call.identity.turn)) continue;
    if (!state.isSettled(call)) return "running";
  }
  if (status === "running" || status === "waiting" || status === "queued" || status === "pending") return "running";
  return status === "unknown" ? "unknown" : "idle";
}

/**
 * 普通专家没有 fan-out manager 的权威终态，因此只使用 runtime status、恢复队列和
 * 最新 turn/end。无法证明的旧会话保持 ready/unknown，不把 inactive 猜成成功。
 */
export function expertStatus({ agent, record, session, events = sessionEvents(session) }) {
  const runtime = firstText(agent?.status, session?.status);
  if (runtime === "running") return "running";
  if (record?.pendingRecoveries instanceof Map && record.pendingRecoveries.size > 0) return "waiting";
  const reason = latestTurnReason(session, events);
  const kind = firstText(reason?.kind)?.toLowerCase();
  if (kind === "completed") return "succeeded";
  if (kind === "aborted" || kind === "cancelled" || kind === "canceled") return "cancelled";
  if (kind === "timeout" || kind === "timed-out" || kind === "timed_out") return "timed_out";
  if (kind === "interrupted") return "interrupted";
  if (["error", "refusal", "blocked", "max-tokens"].includes(kind)) return "failed";
  if (runtime === "idle") return "idle";
  if (agent === undefined || agent === null) return "ready";
  return "unknown";
}

export function sessionTitle(session, sessionId, events = sessionEvents(session)) {
  // session/title 才是 DSH 的权威标题；SessionHeader 本身没有 title 字段。
  // sessionId 不作为标题回退，避免把内部身份误展示成用户任务名。
  return firstText(latestSessionTitle(session, events));
}

/**
 * 从父会话事件里取「childId → 派发 label」（纯函数，**只用于展示兜底**）。
 *
 * 为什么需要它：DSH 的父会话 catalog 是 **durable** 的（见 dsh-subagent 的
 * `lib/types/catalog.js`）：每个 continuable 子代理都会以 `subagent/catalog` 事件把
 * `{ version, childId, childCreatedAt, mode, label }` 落进父会话日志。label 是派发时由用户/
 * 调用方给出的任务名，语义等同 DEG 的 `lastDispatch.description`。因此即使 DEG 自有
 * child_models 的 lastDispatch 被历史写回抹掉（真实故障），父会话事件流里仍留着这份名字——
 * 不做任何 IO 就能救回历史行，不必回退到 DSH session title（那是 prompt 首句，不是任务名）。
 *
 * 只收 `type === "subagent/catalog"` 且 data.childId / data.label 都非空的记录；同一 child
 * 出现多次时**以后到者为准**（事件流是追加式日志，后出现的那行才是最新 label：续作/steer 会
 * 追加新的 catalog 行）。形状异常（非数组、null、非对象 data、非字符串字段）一律跳过，
 * 绝不抛错：投影侧的兜底数据永远不能让整棵快照构建失败。
 *
 * 本函数**不参与**归属判定、状态推导或导航键，只给任务名降级链提供一级候选。
 *
 * @param {Array} events - 父会话事件数组（`sessionEvents(root.session)`）。
 * @returns {Map<string, string>} trim 后的 childId → trim 后的非空 label。
 */
export function catalogLabelsOf(events) {
  const labels = new Map();
  if (!Array.isArray(events)) return labels;
  for (const event of events) {
    if (event === null || typeof event !== "object") continue;
    if (event.type !== "subagent/catalog") continue;
    const data = event.data;
    if (data === null || typeof data !== "object") continue;
    const childId = nonEmpty(data.childId);
    const label = nonEmpty(data.label);
    if (childId === null || label === null) continue;
    // 后到者覆盖：同一 child 的最新 catalog 行才代表当前 label。
    labels.set(childId, label);
  }
  return labels;
}

/**
 * 取系统通知第二行使用的 root 任务名称。
 *
 * 通知只能使用 DSH 已发布的 session/title；缺失时返回 null，不能用 session id、prompt
 * 或时间戳猜测任务名称。事件快照由调用方所在 Host Session 提供，不新增持久化状态。
 */
export function rootNotificationLabel(session) {
  return sessionTitle(session, session?.id, sessionEvents(session));
}

function asObject(value) {
  return value !== null && typeof value === "object" ? value : undefined;
}

function parseToolArguments(value) {
  if (value !== null && typeof value === "object") return value;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 单条 tool 事件的身份归一（真实 DSH 形状 + 旧形状兼容）。
 *
 * - `tool/call`：SessionEventMap 声明 `{ turn, step, callId, name, arguments }`，身份
 *   字段直接挂在 data 上；但模型输出的 tool-call block 也在消息封装里
 *   （`message.content[*]`），因此 name/arguments 允许从 block 读取。
 * - `tool/result`：声明 `{ turn, step, message, error?, meta? }`——**顶层没有 callId**，
 *   调用身份只在消息封装里：`message.source.callId`（kind:"tool" 的 ToolMessageSource）。
 * - 扁平 `data.callId` 仍被接受：快照、旧版本与插件自造事件用它。
 * 两处都读不到 callId 时返回 null——绝不按出现顺序猜测配对。
 */
function toolEventIdentity(data) {
  const source = asObject(data);
  const message = asObject(source?.message);
  const blocks = (Array.isArray(message?.content) ? message.content : []).filter((part) => asObject(part) !== undefined);
  // 多 block 消息（例如 text + tool-call）优先取真正携带调用身份的那一块。
  const block = blocks.find((part) => firstText(part?.callId, part?.name, part?.toolName) !== null) ?? blocks[0];
  return {
    callId: firstText(source?.callId, message?.source?.callId, block?.callId),
    name: firstText(source?.name, source?.toolName, source?.command, block?.name, block?.toolName),
    args: source?.arguments ?? block?.arguments,
    turn: Number.isSafeInteger(source?.turn) ? source.turn : null,
    step: Number.isSafeInteger(source?.step) ? source.step : null,
  };
}

/** 定位键 turn:step:callId：不同 step 复用同名 callId 时不会互相顶替。 */
function toolCallKey(identity) {
  return String(identity.turn ?? "?") + ":" + String(identity.step ?? "?") + ":" + String(identity.callId);
}

/**
 * tool 事件状态：calls/results 都保留原始身份，由 isSettled 决定是否配对成功。
 *
 * 配对优先级（callId 是权威身份，turn/step 只是消歧）：
 * 1. 两边都有 turn/step：必须 turn:step:callId 全等；
 * 2. 任一方缺 turn/step（旧快照/部分输入）：退化为裸 callId 配对。
 * 另外收集已 `turn/end` 的 turn：该 turn 的调用不可能仍在执行（中断时结果事件
 * 永远不会到达），因此不算 running，避免把已完成调用误判成进行中。
 */
function toolCallState(events) {
  const calls = [];
  const results = [];
  const endedTurns = new Set();
  for (const event of events) {
    if (event?.type === "turn/end") {
      const turn = asObject(event.data)?.turn;
      if (Number.isSafeInteger(turn)) endedTurns.add(turn);
      continue;
    }
    if (event?.type !== "tool/call" && event?.type !== "tool/result") continue;
    const identity = toolEventIdentity(event.data);
    if (identity.callId === null) continue;
    (event.type === "tool/call" ? calls : results).push({ identity, key: toolCallKey(identity) });
  }
  const resultKeys = new Set();
  const resultCallIds = new Set();
  const looseResultCallIds = new Set();
  for (const result of results) {
    resultKeys.add(result.key);
    resultCallIds.add(result.identity.callId);
    if (result.identity.turn === null || result.identity.step === null) looseResultCallIds.add(result.identity.callId);
  }
  return {
    calls,
    turnEnded: (turn) => turn !== null && endedTurns.has(turn),
    isSettled(call) {
      if (resultKeys.has(call.key)) return true;
      // 调用自己缺位置：按裸 callId 接受任意结果。
      if (call.identity.turn === null || call.identity.step === null) return resultCallIds.has(call.identity.callId);
      // 只有结果缺位置时才退化为裸 callId，避免跨 step 的同名 callId 误配对。
      return looseResultCallIds.has(call.identity.callId);
    },
  };
}

function toolCommandText(identity) {
  if (identity.name === null) return null;
  const args = parseToolArguments(identity.args);
  const detail = firstText(
    args.file_path, args.path, args.pattern, args.command, args.description, args.query, args.prompt,
  );
  const labels = { edit: "编辑", write: "写入", read: "读取", grep: "Grep", glob: "Glob", pwsh: "PowerShell", run_code: "运行代码" };
  return detail === null ? (labels[identity.name] || identity.name) : (labels[identity.name] || identity.name) + " " + detail;
}

/** 从最新提交的 tool/call 中提取命令；无专用 current-command 事件时不猜测其它文本。 */
function latestCommand(session, events = sessionEvents(session), state = toolCallState(events)) {
  for (let index = state.calls.length - 1; index >= 0; index -= 1) {
    const call = state.calls[index];
    // 所属 turn 已结束（含中断丢结果）的调用不再等待结果，也不算未完成命令。
    if (state.turnEnded(call.identity.turn)) continue;
    if (!state.isSettled(call)) return toolCommandText(call.identity);
  }
  return state.calls.length === 0 ? null : toolCommandText(state.calls[state.calls.length - 1].identity);
}

/** 时间戳是否可用来计算区间：必须是有限非负数（epoch ms）。 */
function isUsableTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * 事件携带的 turn 编号；缺失或不是有限数字时返回 null（旧日志/旧宿主可以不写编号）。
 *
 * 只有「有限数字」才算有编号：字符串、NaN、Infinity 一律按「没有编号」处理，
 * 让这类事件仍能按顺序配对，而不是被判成不匹配。
 */
function turnNumberOf(event) {
  const turn = event?.data?.turn;
  return typeof turn === "number" && Number.isFinite(turn) ? turn : null;
}

/**
 * 该会话**全部 turn** 的累计墙钟用时与最后一个 open turn 的起点（不含 turn 之间的空闲区间）。
 *
 * 调用方（侧栏任务行「用时」）要的是「这个会话一共真正跑了多久」，而不是「当前/最近一轮
 * 跑了多久」：一个 turn 结束后不清零，后续 turn 在其基础上继续累加。快照字段名仍是
 * turnDurationMs，另以 additive 字段 turnOpenSince 给出 open turn 起点，供客户端在两次
 * 权威快照之间做锚定外推（不新增 schemaVersion）。
 *
 * 计算规则（单次顺序 O(n) 扫描，顺序以事件数组顺序为准，不按时间戳排序、不复制数组、
 * 不做缓存）：
 * - 已闭合 turn：累加 turn/start.time → 对应 turn/end.time。
 * - 最后一个未闭合 turn：累加 turn/start.time → nowMs（构建快照时刻）；nowMs 非法时不加。
 * - 不同 turn 之间的空闲区间不计入：上一个 turn 的 end 到下一个 turn 的 start 之间的时间
 *   不是「用时」。
 * - 未闭合 turn 之后又出现合法 turn/start：丢弃前一个无法证明结束的区间（绝不隐式延长到
 *   新 start，否则空闲时间会被算成用时），新 start 成为当前 open turn。超出扫描窗口的旧
 *   open turn 同样只保留最后一段。
 * - turn 配对：两侧都带合法编号（有限数字）时要求相邻；任一侧缺编号的旧日志按顺序配对；
 *   编号不匹配时不结算该区间，且**不关闭**当前 open 状态（可能只是迟到/重复的 end）。
 * - 非法时间戳（非有限数或负数）：turn/end 非法 → 不结算并清空 open 状态（不能继续算到
 *   nowMs）；end 早于 start（时钟回拨/日志乱序）同样清空且不结算；非法 turn/start →
 *   先清空当前 open 状态再忽略该事件，避免把旧区间错误地接到后面的事件上。
 * - 扫描结束时仍有 open turn 且 nowMs 有限：累加 max(0, nowMs - openStart)（时钟回拨封底 0）。
 * - 没有任何可证明的有效区间时返回 null，调用方已有回退（模型用时/会话时间），绝不补 0；
 *   存在真实区间（即便长度为 0）时返回累计值，让「刚开始的一轮」显示 0 而不是伪造值。
 * - openSince 只在扫描结束时仍有 open turn（其 turn/start.time 必然合法）时给出该起点；
 *   全部闭合或没有任何 turn 时为 null。它与 durationMs 分开：nowMs 非法只是不加 open 段，
 *   不改变「这一轮是否仍打开」这一事实。
 *
 * @param {Array|undefined} events - 会话事件数组（形状同 session.snapshotEvents()）。
 * @param {number|undefined} nowMs - 构建快照时的 epoch ms；仅用于闭合未结束的 turn。
 * @returns {{durationMs: number|null, openSince: number|null}} 累计墙钟毫秒与 open turn 起点。
 */
export function turnTimingOf(events, nowMs) {
  const list = Array.isArray(events) ? events : [];
  // nowMs 只在「扫描结束仍有 open turn」时使用；非法时不加这一段（不猜结束时间）。
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : null;
  let total = 0;
  // 是否已经累加过至少一个可证明的区间：决定「返回 0」还是「返回 null」。
  let proved = false;
  // 当前 open turn 的起点与编号；两者一起维护，清空时必须同时清空。
  let openStart = null;
  let openTurn = null;
  for (const event of list) {
    const type = event?.type;
    if (type !== "turn/start" && type !== "turn/end") continue;
    const at = event?.time;
    if (type === "turn/start") {
      if (!isUsableTimestamp(at)) {
        // 非法起点无法证明任何区间：先丢弃当前 open 状态，再忽略本事件。
        openStart = null;
        openTurn = null;
        continue;
      }
      // 上一个 open turn 若没等到 end，就到此为止（不隐式延长到本 start）。
      openStart = at;
      openTurn = turnNumberOf(event);
      continue;
    }
    // 没有 open turn 时到达的 turn/end 无处可结算（孤儿 end），忽略。
    if (openStart === null) continue;
    if (!isUsableTimestamp(at)) {
      // end 非法：无法证明这一轮何时结束，也不能继续算到 nowMs。
      openStart = null;
      openTurn = null;
      continue;
    }
    const endTurn = turnNumberOf(event);
    // 两侧都有编号时必须一致；不匹配只跳过本 end，open 状态保持不变。
    if (openTurn !== null && endTurn !== null && endTurn !== openTurn) continue;
    const delta = at - openStart;
    if (delta < 0) {
      // end 早于 start：日志乱序/时钟回拨，不结算并清空，避免把后续事件接到坏区间上。
      openStart = null;
      openTurn = null;
      continue;
    }
    total += delta;
    proved = true;
    openStart = null;
    openTurn = null;
  }
  // 收尾：最后一个 turn 仍未闭合，就算到快照时刻（这是「正在跑的这一轮」的真实用时）。
  if (openStart !== null && now !== null) {
    total += Math.max(0, now - openStart);
    proved = true;
  }
  // openSince：扫描结束时仍未闭合的那一轮的起点；已全部闭合或没有 turn 时为 null。
  return { durationMs: proved ? total : null, openSince: openStart };
}

/**
 * 只取累计墙钟的薄包装（既有纯函数调用方与测试保持原签名）。
 *
 * @param {Array|undefined} events - 会话事件数组。
 * @param {number|undefined} nowMs - 构建快照时的 epoch ms。
 * @returns {number|null} 累计墙钟毫秒；无任何有效区间时为 null。
 */
export function turnDurationOf(events, nowMs) {
  return turnTimingOf(events, nowMs).durationMs;
}

export function runSummary(session, status, mode, events = sessionEvents(session)) {
  const state = toolCallState(events);
  return {
    command: latestCommand(session, events, state),
    mode: mode === "continuable" || mode === "one-shot" ? mode : "unknown",
    activity: activityOf(status, events, state),
  };
}

/**
 * 目标 subagent provider / 继承开关的只读投影（票据 29）。
 *
 * 持久化 child_models 是权威；live child 在持久化落地前可从 agentOptions marker
 * 或本次投影的恢复上下文读到同一份值。缺失时整体省略字段，绝不伪造 false。
 *
 * @param {object|undefined} persisted - child_models 记录。
 * @param {object|undefined} agent - live Agent。
 * @param {object|undefined} context - recovery 上下文。
 * @returns {object} 可展开的投影字段。
 */
export function subagentContextFields(persisted, agent, context) {
  const provider = firstText(
    persisted?.subagentProvider,
    agent?.options?.[EXPERT_SUBAGENT_PROVIDER_MARKER],
    context?.subagentProvider,
  );
  const inheritCandidates = [
    persisted?.inheritContext,
    agent?.options?.[EXPERT_INHERIT_CONTEXT_MARKER],
    context?.inheritContext,
  ];
  const inherit = inheritCandidates.find((value) => typeof value === "boolean");
  return {
    ...(provider === null ? {} : { subagentProvider: provider }),
    ...(inherit === void 0 ? {} : { inheritContext: inherit }),
  };
}

export function modelMetadata(agent, persisted, context) {
  const header = safeCall(() => agent?.session?.requestHeader?.(), null);
  const config = header?.config ?? {};
  // 实际路由（票据 24）：持久化 child_models 是权威；live child 在持久化落地前
  // 可从 agentOptions marker 读到同一份值。缺失字段整体省略，绝不补 0。
  const marker = safeCall(() => agent?.options?.[EXPERT_ROUTE_MARKER], undefined);
  /**
   * 运行期降级的原子性：持久化记录带实际路由快照时，provider/model/effort 必须与
   * candidateIndex/fallbackCount 一样整体取持久化值。请求头与 agent.options 在降级后
   * 仍是主模型（route 覆盖只影响 agent/request 的返回值，下一次请求前 header 不会变），
   * 混用会渲染成「候选索引 + 主模型」，候选未声明 effort 时还会把旧档位读回来。
   * 旧记录（无路由快照）继续沿用 header → options → 持久化 的既有优先级。
   */
  const routePinned = persistedModelRouteIsAuthoritative(persisted);
  return {
    provider: routePinned
      ? firstText(persisted?.provider)
      : firstText(config.provider, agent?.options?.provider, context?.provider, persisted?.provider),
    model: routePinned
      ? firstText(persisted?.model)
      : firstText(config.model, agent?.options?.model, context?.model, persisted?.model),
    effort: routePinned
      ? firstText(persisted?.reasoningEffort)
      : firstText(
        config.reasoningEffort,
        config.reasoning_effort,
        agent?.options?.reasoningEffort,
        agent?.options?.__degExpertEffort,
        context?.reasoningEffort,
        persisted?.reasoningEffort,
      ),
    // 先后顺序很重要：child_models 是**运行期**权威（启动前降级与运行期降级都会写它，
    // 后者只能改写持久化快照、绝不修改 agent.options），因此持久化字段必须覆盖
    // admission 时的 marker；marker 只在持久化字段缺失时（写入尚未落地/旧记录）补齐。
    ...projectModelRouteFields(marker),
    ...projectModelRouteFields(persisted),
    // 目标 subagent provider / 继承开关（票据 29）：缺失省略，不伪造 false。
    ...subagentContextFields(persisted, agent, context),
  };
}

export function createdAtOf(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * 单个 child 的用量投影（票据 25）。
 *
 * 优先读 live 账本（去抖窗口内的最新值），其次读 child_models.usage（重启/恢复后仍可读）。
 * 两条来源都只接受白名单投影；没有可用 token/请求数时返回 null，调用方据此**省略**字段，
 * 绝不补一个 0 成本的 usage 对象。
 *
 * 纯函数：`usageFor` 是 Host 注入的 live 读面，本函数不持有它。
 *
 * @param {string} childId - 会话/child id。
 * @param {object} persisted - 本次投影的 child_models 映射。
 * @param {Function} [usageFor] - 可选：live 账本读面。
 * @returns {object|null} 有界 usage 投影或 null。
 */
export function usageOfChild(childId, persisted, usageFor) {
  const live = typeof usageFor === "function" && typeof childId === "string" && childId.length > 0
    ? projectUsage(safeCall(() => usageFor(childId), null))
    : null;
  if (live !== null && hasUsageMetrics(live)) return live;
  const persistedRecord = persisted?.[childId];
  const stored = persistedRecord !== null && typeof persistedRecord === "object"
    ? projectUsage(persistedRecord.usage)
    : null;
  return stored !== null && hasUsageMetrics(stored) ? stored : null;
}

/**
 * 单个 child 的结构化投影（票据 30）。
 *
 * child_models.structured 是唯一持久化来源（值 <= 64KiB）；缺失返回 null，调用方
 * 据此整字段省略。绝不把“没有结果”伪造成空对象或回退标记。
 */
export function structuredOfChild(childId, persisted) {
  const record = typeof childId === "string" ? persisted?.[childId] : undefined;
  return projectStructuredResult(record?.structured);
}

/** 该 child 是否声明过 outputSchema：只有持久化 true 才输出，缺失不伪造 false。 */
export function outputSchemaRequestedOfChild(childId, persisted) {
  const record = typeof childId === "string" ? persisted?.[childId] : undefined;
  return record?.outputSchemaRequested === true;
}

/**
 * 运行期角色显示名映射（含历史角色显示名，包括已删除角色的持久化标签）。
 * 自定义角色能力已删除，它只服务历史任务/旧快照的可读标签；
 * 不可用时返回空对象，绝不猜显示名。
 */
export function currentRoleLabels(roleLabels) {
  if (typeof roleLabels !== "function") return {};
  const value = safeCall(() => roleLabels(), null);
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * 角色的显示名投影：运行期目录优先（角色改名/内置角色文案调整后，历史任务同步
 * 显示当前名称），其次持久化快照（角色已删除时历史任务仍可显示标签）。
 * 两者都没有时返回 null。
 */
export function roleLabelOf(role, persistedLabel, roleLabels) {
  const roleId = firstText(role);
  if (roleId !== null) {
    const current = firstText(currentRoleLabels(roleLabels)[roleId]);
    if (current !== null) return current;
  }
  return firstText(persistedLabel);
}

/**
 * 构造「角色显示名」读命令（runtime 组合点调用一次，非 per-build 状态）。
 *
 * 返回的函数只读 `roleLabels` 依赖，不含任何 Map；因此阶段投影可以只持有命令。
 */
export function createRoleLabelReader(roleLabels) {
  return (role, persistedLabel) => roleLabelOf(role, persistedLabel, roleLabels);
}

/**
 * 轻量快照专用的会话标题读面（可选能力，期望零 I/O）。
 *
 * 冷会话标题原本只能在 `readSession` 之后读到，而轻量路径不做任何冷读，因此这里留一个
 * **可选**依赖槽：宿主提供 `projectionTitleFor` 时用它替代冷会话标题；没有提供（或它读不到、
 * 抛错、返回空串）时返回 null，降级链继续落到 child_models.lastDispatch.description。
 *
 * 探测与调用都必须 fail-soft：可选服务缺失绝不能影响首屏，因此所有异常在这里被收敛成 null。
 * 返回的是只读命令（无 Map、无缓存），runtime 组合点调用一次即可。
 */
export function createProjectionTitleReader(projectionTitleFor) {
  return (childId) => {
    if (typeof projectionTitleFor !== "function") return null;
    return firstText(safeCall(() => projectionTitleFor(childId), null));
  };
}

/**
 * 当前根会话拥有的 fan-out 父任务。
 *
 * 归属查询优先问 fanout runtime：它按同一套 parentSessions 语义过滤 manager 的权威
 * 任务，并额外覆盖「活动 ownership 已释放、但持久化仍记录归属」的已终态恢复任务
 * （冷启动后这些任务必须继续出现在自己的根下）。两者都按根过滤，绝不退回全局
 * listTasks()——没有归属证明时保持 fail-closed，不借任务视图枚举别的会话。
 */
export function fanoutTasksOwnedBy({ fanoutHost, lineage } = {}, sessionId) {
  const fromRuntime = safeCall(() => fanoutHost?.tasksOwnedBy?.(sessionId), undefined);
  if (Array.isArray(fromRuntime)) return fromRuntime;
  const fromLineage = safeCall(() => lineage?.tasksOwnedBy?.(sessionId), undefined);
  return Array.isArray(fromLineage) ? fromLineage : [];
}

function isMissingSessionError(error) {
  const code = firstText(error?.code, error?.name)?.toLowerCase();
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  return code === "enoent" || code === "not_found" || code === "session_not_found"
    || message.includes("session not found") || message.includes("session-not-found");
}

async function readColdSession(sessionId, parentSessionId, sessionQuery) {
  const query = typeof sessionQuery === "function" ? safeCall(() => sessionQuery(), undefined) : sessionQuery;
  if (typeof query?.readSession !== "function") return undefined;
  let log;
  try {
    log = await query.readSession(sessionId);
  } catch (error) {
    // 只有明确的“不存在”才允许继续 ownership fallback；权限、存储和协议错误必须向上暴露。
    if (isMissingSessionError(error)) return undefined;
    throw error;
  }
  const header = log?.session;
  const actualParent = header?.parentSession ?? null;
  const expectedParent = parentSessionId ?? null;
  if (header?.id !== sessionId || actualParent !== expectedParent) return undefined;
  return {
    id: sessionId,
    header,
    events: Array.isArray(log.events) ? log.events : [],
    status: "ready",
    requestHeader: () => ({ config: header?.config ?? {} }),
  };
}

/**
 * 冷读并发上限（**全局**，由本次构建的冷读协调器统一执行）。
 *
 * 每个 `sessionQuery.readSession` 都可能完整解析一份大日志（文件 IO + 反序列化），
 * 一次性无界并发会在冷启动瞬间同时占用大量内存与文件句柄，因此只允许固定的小批量并行。
 * root 冷读、普通 expert 阶段、fan-out 的 task/shard/attempt 证明全部计入同一个上限；
 * 普通 expert 阶段的 forEachWithConcurrency 也用这个值作为 worker 数，两者叠加仍不超过 4。
 * 取值 4：足以把一个根下若干普通专家的等待时间从「逐个求和」压回「取最大值」，又明显低于
 * fan-out 的 per-role 默认并发（20）。live/cached 会话不进入这个并发池。
 */
export const COLD_READ_CONCURRENCY = 4;

/**
 * 本次构建专用的冷读协调器（**绝不跨 root、跨快照复用**）。
 *
 * 同一次投影会从多个入口读取同一份 child 会话：root 冷读、普通 expert 阶段、fan-out 的
 * task/shard/attempt 归属证明。这些入口分属不同阶段且可以并行，因此协调器负责两件事：
 * 1. 按 `parentSessionId + childId` 缓存**读取 promise 本身**：同一快照内同一 child 只会真正
 *    调用一次 `sessionQuery.readSession`；`undefined`（会话不存在/父子不符）与 rejection 同样
 *    被缓存复用，所以第二个调用者拿到的是同一个结果或同一个错误对象，不会触发第二次读取；
 * 2. 真实 readSession 全局最多 COLD_READ_CONCURRENCY 个同时在飞：请求按 FIFO 排队，
 *    各阶段自己再收敛顺序与错误，因此阶段并行也不会突破上限。
 * 缓存随本次构建回收，构建结束后不再被任何后续快照（含失败后的立即重试）共享。
 *
 * 返回值是冻结的只读命令面：
 * - `read(childId, parentSessionId)`：唯一的读取口；
 * - `limit`：本次构建的全局并发上限（阶段投影用它决定 worker 数，单一事实源，不复制常量）。
 * 内部的 `reads` Map 与队列**不**出现在返回值里，调用方无法读写它们。
 *
 * @param {Function} sessionQuery - Host 注入的 sessionQuery（函数或对象）。
 * @returns {Readonly<{limit:number, read:(childId:string, parentSessionId:string|null)=>Promise<object|undefined>}>}
 */
function createColdReadCoordinator(sessionQuery) {
  const reads = new Map();
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < COLD_READ_CONCURRENCY && queue.length > 0) {
      const request = queue.shift();
      active += 1;
      // 这两个回调只 settle 请求方自己的 promise，返回的链式 promise 总是 resolve，
      // 因此协调器内部不会产生未处理的 rejection；请求方的 rejection 由调用方负责处理。
      readColdSession(request.childId, request.parentSessionId, sessionQuery).then(
        (session) => { active -= 1; request.resolve(session); pump(); },
        (error) => { active -= 1; request.reject(error); pump(); },
      );
    }
  };
  const read = (childId, parentSessionId) => {
    const key = (parentSessionId ?? "") + "|" + childId;
    const cached = reads.get(key);
    if (cached !== undefined) return cached;
    const promise = new Promise((resolve, reject) => {
      queue.push({ childId, parentSessionId, resolve, reject });
      pump();
    });
    reads.set(key, promise);
    return promise;
  };
  return Object.freeze({ limit: COLD_READ_CONCURRENCY, read });
}

/**
 * 收集 child 的**显式父会话证据**（去重后的 id 集合）。
 *
 * 全部来自既有对象上的显式字段，不新建状态库：
 * - 在线 agent 的 session.header.parentSession（DSH 权威父子关系）；
 * - 缓存 session（record.session）的 header.parentSession；
 * - DEG record.parentId / record.parentAgent.id（record 持有的是 exact 父代际）；
 * - 持久化 childSnapshot.parentId。
 * 只有能读出非空字符串的字段才算证据；缺失字段不参与判定。
 */
export function collectParentEvidence({ agent, record, childSnapshot, session } = {}) {
  const evidence = new Set();
  const add = (value) => {
    const id = nonEmpty(value);
    if (id !== null) evidence.add(id);
  };
  add(safeCall(() => agent?.session?.header?.parentSession, undefined));
  add(safeCall(() => session?.header?.parentSession, undefined));
  add(record?.parentId);
  add(safeCall(() => record?.parentAgent?.id, undefined));
  add(childSnapshot?.parentId);
  return evidence;
}

/**
 * 归属判定（fail-closed）：
 * - 存在任何不等于 rootId 的显式父证据 → "foreign"：任一根查询都不得投影该 child，
 *   也不能读它的会话内容（旧 record 说本根、live session 说别的根属于冲突，必须拒绝）；
 * - 证据恰好只有 rootId → "owned"；
 * - 没有任何显式父证据 → "unknown"：由调用方决定（普通专家拒绝；fan-out 允许继续用
 *   父任务级证据或冷读校验判定）。
 */
export function parentEvidenceVerdict(evidence, rootId) {
  if (evidence.size === 0) return "unknown";
  for (const id of evidence) {
    if (id !== rootId) return "foreign";
  }
  return "owned";
}

/**
 * 证明某个 attempt child 属于当前 root，并给出可用于投影的会话。
 *
 * 三条独立证据，任一成立即可（全部读取既有 DEG/DSH 状态，不新建登记）：
 * 1. 在线 child agent 的会话头声明 `header.parentSession === rootId`；
 * 2. DEG 自己的 child 记录匹配：普通专家记录用 `parentId === rootId`，fan-out 子代理
 *    记录用 `fanoutParentTaskId === 当前父任务`（父任务本身已由 manager 的 ownership
 *    过滤证明属于本 root，任务 id 也按 root 唯一，因此这不是跨根推断）；
 * 3. 冷读 `sessionQuery.readSession(childId)` 的 header.id/parentSession 与预期一致
 *    （readColdSession 自带这两项校验）。
 * 三条都不成立时 owned=false：这个 childId 可能属于另一个 root，投影必须丢弃它，
 * 否则客户端一点就会导航到跨根会话，也会把别的根的模型/命令渲染进本根任务树。
 * 结果在同一次快照内按「父任务 + childId」缓存，避免重复的归属计算；真正的冷读一律交给
 * 本次构建的 `coordinator`，因此 fan-out attempt 与普通 expert 阶段对同一个 child 只会
 * 调用一次 readSession（同一 parentSessionId + childId 共享同一个读取 promise）。
 *
 * **owner-only**：`cache` 是 childOwnership Map，只由 `createChildOwnershipResolver` 的闭包
 * 传入，不越过本模块。
 */
async function resolveOwnedChild(childId, { rootId, parentTaskId, persisted, cache, coordinator, fast, records, agents }) {
  if (typeof childId !== "string" || childId.length === 0) {
    return { owned: false, childId: null, agent: undefined, session: undefined, childSnapshot: null };
  }
  // 缓存键带上父任务：同一次快照里 fan-out 归属是任务级的。
  const cacheKey = (typeof parentTaskId === "string" ? parentTaskId : "") + "|" + childId;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const record = records?.get?.(childId);
  const childSnapshot = persisted[childId] ?? null;
  const agent = safeCall(() => agents?.get?.(childId), undefined) ?? record?.agent;
  // 显式父证据一旦互相矛盾（例如旧 record 说本根、live session 说别的根），
  // 就一律拒绝：ownedByAgent/ownedByRecord 的 OR 语义不得绕过冲突检查。
  const evidence = collectParentEvidence({ agent, record, childSnapshot, session: record?.session });
  const verdict = parentEvidenceVerdict(evidence, rootId);
  const ownedByFanoutRecord = typeof parentTaskId === "string" && parentTaskId.length > 0
    && (nonEmpty(childSnapshot?.fanoutParentTaskId) === parentTaskId || nonEmpty(record?.fanoutParentTaskId) === parentTaskId);
  let resolved;
  if (verdict === "foreign") {
    resolved = { owned: false, childId, agent: undefined, session: undefined, childSnapshot: null };
  } else if (verdict === "owned" || ownedByFanoutRecord) {
    // 轻量路径（fast）不做冷读：只有 live/cached 会话可用，其余保持 undefined，
    // 由投影层按「证据不足」处理（childId 保留，但不会读到任何会话内容）。
    const session = record?.session ?? agent?.session
      ?? (fast === true ? undefined : await coordinator.read(childId, rootId));
    resolved = {
      owned: true,
      childId,
      agent,
      session,
      // 归属已由显式证据或父任务级记录证明，允许该记录提供 provider/model 回退。
      childSnapshot,
    };
  } else if (fast === true) {
    // 轻量路径的归属判定 fail-closed：没有任何显式父证据、也没有父任务级记录时，
    // 不读日志就无法证明这个 child 属于本根，因此按「不属于本根」处理，
    // 输出副本会把它的 childId 清空（绝不猜测，也绝不跨 root 泄漏条目）。
    //
    // ── partial 阶段与 full 阶段的行为差异（B4，**有意保留**）──────────────────
    // 完整构建在这里还会再冷读一次会话日志，用 header 的 id / parentSession 补证归属，
    // 因此同一份数据在 full 里可能「有」childId，而在 partial 里是 null：
    //   partial（首屏，无导航键）→ full 完成后恢复导航键。
    // 这是**保守方向**的差异（先无、后有）：partial 阶段宁可少一个可点击的导航目标，
    // 也不允许把来源不明的会话挂到本根任务树上（跨 root 泄漏比暂时少一个链接严重得多）。
    // 因此这里保留 fail-closed 隔离，不修改归属逻辑；该行为由
    // test/expert-group-runtime.test.mjs 的「partial 阶段无导航键、full 完成后恢复」用例锁定。
    resolved = { owned: false, childId, agent: undefined, session: undefined, childSnapshot: null };
  } else {
    const coldSession = await coordinator.read(childId, rootId);
    resolved = coldSession === undefined
      ? { owned: false, childId, agent: undefined, session: undefined, childSnapshot: null }
      : { owned: true, childId, agent, session: coldSession, childSnapshot: null };
  }
  cache.set(cacheKey, resolved);
  return resolved;
}

/**
 * **childOwnership 的唯一 owner**（规格书 §状态所有权(4)、plan R2.2-a）。
 *
 * runtime builder 每次 build 调**一次**；返回值是冻结的命令面：
 * `Readonly<{ resolveChildOwnership(childId, parentTaskId?) }>`。
 *
 * 不变量：
 * - 内部 `new Map()` 是本次 build 的 childOwnership（键 = `parentTaskId|childId`）；
 * - 唯一写入点是内部 `resolveOwnedChild`，写入与去重顺序与拆分前完全一致；
 * - 返回值**不含** Map、不含 entry、不含 `cache`；调用方只能读 `{ owned, childId, agent,
 *   session, childSnapshot }` 结论；
 * - 生命周期仅限当前 build：build 结束即丢弃，不跨 build / 跨 root 复用。
 *
 * 窄上下文（不可变）：对外只接受 `rootId` / `persisted`（只读读面）/ `coordinator`（只用它的
 * `read`）/ `fast` 四个键（plan R2.2-a §4）；`records` / `agents` 是本模块自身的绑定依赖，
 * 由 `createExpertProjectionContext` 的闭包提供，不来自 builder。
 *
 * @param {object} options
 * @param {string} options.rootId - 本次构建的 root id。
 * @param {object} options.persisted - 本次构建的 child_models 只读映射。
 * @param {object} options.coordinator - 本次构建的冷读协调器（只用 `read`）。
 * @param {boolean} [options.fast] - 是否轻量路径（轻量路径不做冷读）。
 * @param {Map} options.records - recoveryRecords（projection 自身绑定，只读）。
 * @param {object} [options.agents] - agents 读面（projection 自身绑定，只用 `get`）。
 * @returns {Readonly<{resolveChildOwnership:(childId:string, parentTaskId?:string)=>Promise<object>}>}
 */
function createChildOwnershipResolver({ rootId, persisted, coordinator, fast, records, agents } = {}) {
  // 本次 build 独占：Map 的生命周期止于返回的命令闭包，且只在本文件内可见。
  const childOwnership = new Map();
  const resolveChildOwnership = (childId, parentTaskId) => resolveOwnedChild(childId, {
    rootId, parentTaskId, persisted, cache: childOwnership, coordinator, fast, records, agents,
  });
  return Object.freeze({ resolveChildOwnership });
}

/**
 * 阶段投影可见的**纯投影命令集合**（冻结；只含无状态函数）。
 *
 * 为什么需要它：stage 不得 import 本模块（plan R2.2-a §6 的静态图要求），因此 runtime 组合点
 * 把这里的纯函数作为「命令」注入 stage 的 deps。集合里**没有** Map、缓存、协调器或归属缓存，
 * 阶段投影因此只能做投影，不能写入任何 owner 的状态。
 */
export const expertProjection = Object.freeze({
  nonEmpty,
  firstText,
  safeCall,
  sessionEvents,
  sessionTitle,
  catalogLabelsOf,
  dispatchedPrompt,
  expertStatus,
  runSummary,
  turnDurationOf,
  turnTimingOf,
  modelMetadata,
  createdAtOf,
  subagentContextFields,
  collectParentEvidence,
  parentEvidenceVerdict,
  usageOfChild,
  structuredOfChild,
  outputSchemaRequestedOfChild,
});

/**
 * projection 的**组合上下文**（runtime 组合点调用一次；plan R2.2-a §1「projection 构造时绑定
 * 不变量」）。
 *
 * 为什么需要它：`createChildOwnershipResolver` 的对外签名固定为
 * `{ rootId, persisted, coordinator, fast }`（plan R2.2-a §1/§2/§4），而 `recoveryRecords` /
 * `agents` / `sessionQuery` 是 projection **自身的绑定依赖**（§2：「recoveryRecords / agents
 * 由 projection 自己绑定，不由 builder 传入」）。本工厂只用闭包捕获这三份只读读面：
 * - **没有**模块级可变状态：不写任何模块作用域变量，两个 per-build 工厂每调用一次都新建
 *   自己的 Map（`reads` 在协调器里、`childOwnership` 在 resolver 里）；
 * - 返回值冻结，调用方看不到任何 Map / entry / 缓存，只能拿命令；
 * - per-build 状态（`coordinator`、`reads`、`childOwnership`）生命周期止于单次 build。
 *
 * @param {object} dependencies
 * @param {Map} dependencies.recoveryRecords - DEG 的 recovery 记录（只读读面）。
 * @param {object} [dependencies.agents] - agents 读面（只用 `get`）。
 * @param {Function|object} [dependencies.sessionQuery] - Host 的 sessionQuery（只读读面）。
 * @returns {Readonly<{expertProjection:object, createColdReadCoordinator:Function, createChildOwnershipResolver:Function}>}
 */
export function createExpertProjectionContext({ recoveryRecords, agents, sessionQuery } = {}) {
  if (!(recoveryRecords instanceof Map)) throw new TypeError("Expert Group projection 需要 recoveryRecords Map");
  return Object.freeze({
    // 阶段投影用的纯函数命令集合（无状态，可安全共享）。
    expertProjection,
    /** 每次 build 新建一个冷读协调器（内部 reads Map + 队列随构建回收）。 */
    createColdReadCoordinator: () => createColdReadCoordinator(sessionQuery),
    /** 每次 build 新建一个 childOwnership owner，只返回冻结的 resolver 命令。 */
    createChildOwnershipResolver: ({ rootId, persisted, coordinator, fast } = {}) =>
      createChildOwnershipResolver({ rootId, persisted, coordinator, fast, records: recoveryRecords, agents }),
  });
}
