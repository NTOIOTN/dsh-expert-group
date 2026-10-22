/**
 * Expert Group Host 运行时适配器。
 *
 * 本模块只读取 DEG 已有的 root/child/fan-out/goal 状态，并把不稳定的 DSH 对象形状
 * 收敛为 expert-group-snapshot 深模块的输入。它不持久化第二套任务状态，也不参与
 * 任务调度、恢复或 fan-out 结算。
 *
 * 首屏与权威快照（本次性能修复的核心契约）：
 * - `snapshotForSession` 先返回**轻量（fast）**快照：它跳过全部冷读（`sessionQuery.readSession`），
 *   只用 DEG 自己的持久化记录与 live 对象投影，快照上带 `partial: true`；
 * - 每次请求都**幂等**地在后台启动**完整（full）**构建（同一 root 同时只允许一个在跑），完成后
 *   写入按 root 的内存缓存，供客户端 ≤2.5s 的轮询取回权威快照（`partial: false`）；
 * - 完整快照「只是过期、没有失效事件」时继续返回上一份权威快照（不降级，避免界面抖动）；
 *   一旦收到失效事件，则当次请求改用新的轻量快照，保证状态变化立刻可见；
 * - 缓存由事件挂点（`invalidateSnapshots`，见 index.js 的接线）与兜底 TTL 失效，并按 root 限制容量。
 *
 * @module dsh-expert-group/host/expert-group-runtime
 */
import { buildExpertGroupSnapshot } from "./expert-group-snapshot.js";
import {
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  EXPERT_INHERIT_CONTEXT_MARKER,
  projectModelRouteFields,
} from "../shared.js";
import { hasUsageMetrics, projectUsage, sumUsageByChildId } from "./usage-ledger.js";
import { projectStructuredResult } from "../shared.js";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstText(...values) {
  for (const value of values) {
    const text = nonEmpty(value);
    if (text !== null) return text;
  }
  return null;
}

function safeCall(callback, fallback = undefined) {
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
function recoveryInputFromRestoreStatus(restoreStatus) {
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
function sessionEvents(session) {
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
function recentUserRequest(session, events = sessionEvents(session)) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message" || event?.data?.source?.kind !== "user") continue;
    const text = messageText(event.data?.message ?? event.data?.content);
    if (text !== null) return text;
  }
  return null;
}

/** 冷 child 的首条 user/message 就是 manager 派发 prompt；后续恢复消息不能覆盖它。 */
function dispatchedPrompt(session, events = sessionEvents(session)) {
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
function expertStatus({ agent, record, session, events = sessionEvents(session) }) {
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

function sessionTitle(session, sessionId, events = sessionEvents(session)) {
  // session/title 才是 DSH 的权威标题；SessionHeader 本身没有 title 字段。
  // sessionId 不作为标题回退，避免把内部身份误展示成用户任务名。
  return firstText(latestSessionTitle(session, events));
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

/**
 * 当前（或最近一次）turn 的墙钟用时，与 DSH 状态行「用时 …」同源。
 *
 * DSH 状态行的计时 = 当前打开 turn 的 turn/start 事件时间 → 现在；已完成轮次
 * 则显示 turn/end - turn/start。事件 time 由主机以 epoch ms 写入，所以这里复刻
 * 同一算法：
 * - 从尾部找最后一个 turn/start 作为起点；
 * - 再在该起点之后找最后一个 turn/end：找到即已完成轮次，未找到则是 open turn，
 *   结束时间取构建快照的 nowMs；
 * - 没有 turn/start 或时间戳非法时返回 null，调用方回退模型用时/会话时间。
 */
function turnDurationOf(events, nowMs) {
  const list = Array.isArray(events) ? events : [];
  let startAt = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type !== "turn/start") continue;
    const time = event?.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      startAt = time;
      break;
    }
  }
  if (startAt === null) return null;
  let endAt = null;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index];
    if (event?.type === "turn/start") break;
    if (event?.type !== "turn/end") continue;
    const time = event?.time;
    if (typeof time === "number" && Number.isFinite(time)) {
      endAt = time;
      break;
    }
  }
  const end = endAt === null ? (typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : null) : endAt;
  if (end === null) return null;
  return Math.max(0, end - startAt);
}

function runSummary(session, status, mode, events = sessionEvents(session)) {
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
function subagentContextFields(persisted, agent, context) {
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

function modelMetadata(agent, persisted, context) {
  const header = safeCall(() => agent?.session?.requestHeader?.(), null);
  const config = header?.config ?? {};
  // 实际路由（票据 24）：持久化 child_models 是权威；live child 在持久化落地前
  // 可从 agentOptions marker 读到同一份值。缺失字段整体省略，绝不补 0。
  const marker = safeCall(() => agent?.options?.[EXPERT_ROUTE_MARKER], undefined);
  return {
    provider: firstText(config.provider, agent?.options?.provider, context?.provider, persisted?.provider),
    model: firstText(config.model, agent?.options?.model, context?.model, persisted?.model),
    effort: firstText(
      config.reasoningEffort,
      config.reasoning_effort,
      agent?.options?.reasoningEffort,
      agent?.options?.__degExpertEffort,
      context?.reasoningEffort,
      persisted?.reasoningEffort,
    ),
    ...projectModelRouteFields(persisted),
    ...projectModelRouteFields(marker),
    // 目标 subagent provider / 继承开关（票据 29）：缺失省略，不伪造 false。
    ...subagentContextFields(persisted, agent, context),
  };
}

function createdAtOf(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

// ── 冷 child 会话读取的受控并发 ──────────────────────────────────────────────

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
const COLD_READ_CONCURRENCY = 4;

/**
 * 受控并发的遍历（彼此独立的项并行、并发数有上限）。
 *
 * 与 `for...of await` 的区别：互不依赖的项不再互相等待；与裸
 * `Promise.all(items.map(worker))` 的区别：同时进行的 worker 数有上限。
 *
 * 失败生命周期（与串行循环一致：错误原样上抛，且不留下仍在后台进行的读取）：
 * - 首个 worker 抛错时**立即停止领取新项**，但已经启动的 worker 不取消、不提前放弃；
 * - 仍然等待所有已启动 worker 全部 settle：迟到的成功照常写回，迟到的失败被收敛在这里
 *   （不覆盖首个错误、不重新抛出，因此不会产生未处理的 rejection）；
 * - 全部 settle 之后才向调用方**原样抛出首个错误对象**，所以本函数返回或抛出时都不会残留
 *   后台 worker：快照失败后同一 root 的立即重试不会与旧批次的读取重叠；
 * - 成功路径不变：受控并发 + 完成顺序无关（调用方按输入顺序取用结果）。
 */
async function forEachWithConcurrency(items, limit, worker) {
  if (items.length === 0) return;
  const size = Math.min(Math.max(1, limit), items.length);
  let cursor = 0;
  let stopped = false;
  let failed = false;
  let firstError;
  const run = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        // 首个失败决定最终抛出的错误并立即停止领取新项；随后到达的失败只在这里被收敛。
        if (!failed) {
          failed = true;
          firstError = error;
          stopped = true;
        }
      }
    }
  };
  // run 从不在内部抛出：Promise.all 因而总会等到所有已启动 worker settle（含迟到的成功与失败），
  // 既不会留下仍在后台进行的读取，也不会产生未处理的 rejection。
  await Promise.all(Array.from({ length: size }, () => run()));
  if (failed) throw firstError;
}

/**
 * 从 Promise.allSettled 的结果数组里取**首个** rejection（按数组顺序，稳定），全部成功时返回 null。
 *
 * 用对象包住 reason，是因为 worker 可以 `throw undefined`：直接返回 reason 无法与「没有失败」
 * 区分。阶段投影统一用它收敛错误：所有已调度分支 settle 之后才向上抛错，且抛出的是同一个
 * 错误对象，重复构建得到的结果稳定（不依赖完成顺序）。
 */
function firstRejection(results) {
  for (const result of results) {
    if (result.status === "rejected") return { reason: result.reason };
  }
  return null;
}

/**
 * 快照缓存按 root 的数量上限（**硬上限**）。
 *
 * 缓存值是一份完整快照（树规模随专家数增长），因此必须显式限制 root 数量；被淘汰的 root
 * 只是丢掉已有的权威结果，下一次请求会重新走「轻量返回 + 后台重建」，不会产生错误。
 * 取值 8：覆盖「用户来回切换若干个会话」的常见宽度，又让内存占用有明确上界。
 * 所有会创建条目的路径（含轻量构建返回 null、完整构建失败）都必须维护这个上限；
 * 淘汰是真正的 LRU（命中与写入都提权），避免活跃 root 被一次性查询挤掉后 full→fast→full 抖动。
 */
const SNAPSHOT_CACHE_LIMIT = 8;

/**
 * 轻量（partial）快照的兜底 TTL。
 *
 * 轻量快照只由事件挂点（invalidateSnapshots）与这个 TTL 决定新鲜度。它**必须与客户端轮询
 * 周期（2500ms）解耦**：若两者相等，严格 `<` 的新鲜度判定会让「恰好晚到一点」的下一次轮询
 * 落在过期之后，于是在完整快照就绪之前每次轮询都要重建一次轻量快照。
 * 取值 6000ms = 2.4× 轮询周期：即使连续两次轮询被合并或延迟（隐藏标签页恢复、通知触发的
 * 尾随刷新），缓存仍覆盖下一次轮询；代价只是「事件没到」时陈旧上界从 2.5s 放宽到 6s，
 * 而真正的状态变化由失效事件即时反映，不依赖这个兜底。
 */
const FAST_SNAPSHOT_TTL_MS = 6000;

/**
 * 完整（权威）快照的兜底 TTL。
 *
 * 完整快照重建的代价是每个冷 child 一次 `readSession`，因此不能被轮询无限放大；TTL 取 5s
 * （≤ 需求上限），其间由 invalidation 事件提供即时性：只要有可观察的状态变化就立刻重建。
 */
const FULL_SNAPSHOT_TTL_MS = 5000;

/**
 * 完整快照的**绝对**宽限上限：超过它就不再返回任何缓存的完整快照。
 *
 * 后台重建持续失败（上游存储故障）或 root 已被释放、持久化证据暂时消失时，继续返回任意旧的
 * 权威快照会让界面无限期停在错误状态；超过 4×TTL（20s）后改用轻量快照（它至少反映当前 DEG
 * 记录），连轻量也拿不到就回落到既有的「重新构建 / 404」契约（见 resolveSnapshotForSession）。
 */
const FULL_SNAPSHOT_GRACE_MS = 4 * FULL_SNAPSHOT_TTL_MS;

/**
 * 代次不一致（构建期间发生过失效）的完整快照还能兜底多久。
 *
 * 这类结果的内容是构建期间真实读到的，只是「读完到完成」之间又出现了可观察变化；当轻量路径
 * 拿不到任何存在性证据（fast 为 null）时，用它在**很短**的窗口内顶住比直接空屏更接近真实状态。
 * 窗口取 2×TTL（10s），且必须同时满足 FULL_SNAPSHOT_GRACE_MS 的绝对上限；它永远不会被当作
 * 「新鲜」或「只是过期」的权威结果返回。
 */
const FULL_SNAPSHOT_STALE_GRACE_MS = 2 * FULL_SNAPSHOT_TTL_MS;

/**
 * 因「构建期间发生过失效」而需要的重建，两次之间的最小间隔（去抖）。
 *
 * 构建开始时捕获代次、完成时若代次已变化则不作权威，这是正确性要求；但活跃会话里失效事件
 * 可能每几秒就来一次，若每个请求都立刻重跑全量冷读，就会退化成「每请求一次全量构建」。
 * 因此一次被判为非权威的构建之后，至少间隔一个完整 TTL（5s，与 FULL_SNAPSHOT_TTL_MS 同量级）
 * 才允许再次后台重建；这段时间由毫秒级的轻量快照承担展示。
 */
const STALE_REBUILD_MIN_INTERVAL_MS = FULL_SNAPSHOT_TTL_MS;

/**
 * 后台完整构建**失败**后的重试退避上限（R1）。
 *
 * 失败退避与上面的 STALE_REBUILD_MIN_INTERVAL_MS 是两条**互相独立**的闸门：
 * - STALE_REBUILD_MIN_INTERVAL_MS 处理「构建成功但期间发生过失效」，是去抖；
 * - 这里的失败退避处理「构建直接失败」（冷读报权限/存储错误、上游短暂不可用），是**指数退避**。
 *
 * 基数取 FULL_SNAPSHOT_TTL_MS（5s），第 n 次连续失败后等待 min(5s × 2^(n-1), 40s)：
 * 5s → 10s → 20s → 40s → 40s…。上限取 8×TTL（40s）：既让持续故障下的重试频率收敛到「每 40s
 * 一次全量冷读」，又保证上游恢复后最迟 40s 内能重新拿到权威快照（不会永远停在 partial）。
 * 任一次成功立即把退避级别清零。
 *
 * 失效事件**不**提前解除失败退避：失败反映的是上游冷读健康度，与「这份快照是否陈旧」正交；
 * 而活跃会话的失效事件可能每几秒就来一次，若用它放行重试，退避会被事件流完全绕过，退化成
 * 「每请求一次全量冷读」——正是 R1 要修的问题。展示层的即时性已由毫秒级轻量快照保证。
 */
const FULL_SNAPSHOT_RETRY_MAX_MS = 8 * FULL_SNAPSHOT_TTL_MS;

/**
 * 同时在飞的完整构建条目数量**安全上限**（R3）。
 *
 * SNAPSHOT_CACHE_LIMIT 只约束「非在飞」条目；在飞条目在构建结束前**不得**被淘汰，否则
 * awaitFullBuild 看不到该构建、后续请求会为同一 root 启动第二个构建（同一 root 同时只有一个
 * 构建的契约被破坏，且每个构建各自建立冷读协调器，跨 root 的实际 I/O 并发被放大）。
 * 这里额外给在飞条目一个安全上限，防止「大量陌生 root 同时构建」把缓存撑成无界增长：
 * 取 2×SNAPSHOT_CACHE_LIMIT（16）。正常情况下远达不到，只有异常增长（例如被大量不同 root
 * 的请求同时驱动）时才会退化为淘汰最久未用的在飞条目——这是有意的「有界优先」取舍。
 */
const SNAPSHOT_INFLIGHT_LIMIT = 2 * SNAPSHOT_CACHE_LIMIT;

/**
 * @param {object} dependencies
 * @param {Function} [dependencies.projectionTitleFor] - 可选：零 I/O 的会话标题读面
 *   （`(childId) => string|null`）。轻量快照拿不到冷会话日志，用它替代冷会话标题，
 *   位于既有降级链的同一槽位（见 collectExperts 的 taskName）。
 * @param {object} [dependencies.logger] - 可选：`{warn}`。后台完整构建失败不再向请求方抛出，
 *   因此需要一条宿主日志出口；缺失时静默（只保留 lastError，供 awaitFullBuild 观察）。
 * @param {Function} [dependencies.roleLabels] - 可选：`() => Record<string,string>`，运行期
 *   角色目录的「id → 显示名」投影（含历史角色显示名，包括已删除角色的持久化标签；
 *   票据 27）。自定义角色能力已删除后，这份映射仍服务历史记录的可读标签。
 *   专家/分片/attempt 的 roleLabel 优先使用记录里持久化的值（角色被删除后仍可读），
 *   缺失时才回落到这份映射。
 * @returns {{snapshotForSession(sessionId:string): Promise<object>,
 *   invalidateSnapshots(sessionId?:string): number,
 *   awaitFullBuild(sessionId:string): Promise<object|null>}}
 */
export function createExpertGroupRuntime({
  agents,
  goals,
  lineage,
  fanoutHost,
  recovery,
  recoveryRecords,
  source,
  sessionQuery,
  projectionTitleFor,
  roleLabels,
  // 用量账本的 live 读面（票据 25，可选）：返回某 child 当前累积 usage 的投影。
  // 缺失/旧调用方时投影只读 child_models.usage（持久化值），行为仍向后兼容。
  usageFor,
  logger,
  now = Date.now,
} = {}) {
  if (!(recoveryRecords instanceof Map)) throw new TypeError("Expert Group runtime 需要 recoveryRecords Map");
  if (typeof now !== "function") throw new TypeError("Expert Group runtime 需要 now 函数");
  // root 与 child surface 可能同时请求同一份树；只合并重叠的构建期。首屏请求不再等待完整
  // 构建，因此表项仍按「请求期」存在：完成后删除，只保留下面按 root 的两级结果缓存。
  const snapshotInFlight = new Map();

  function persistedChildren() {
    const snapshot = safeCall(() => source?.(), null);
    return snapshot?.childModels && typeof snapshot.childModels === "object" ? snapshot.childModels : {};
  }

  /**
   * 单个 child 的用量投影（票据 25）。
   *
   * 优先读 live 账本（去抖窗口内的最新值），其次读 child_models.usage（重启/恢复后仍可读）。
   * 两条来源都只接受白名单投影；没有可用 token/请求数时返回 null，调用方据此**省略**字段，
   * 绝不补一个 0 成本的 usage 对象。
   *
   * @param {string} childId - 会话/child id。
   * @param {object} persisted - 本次投影的 child_models 映射。
   * @returns {object|null} 有界 usage 投影或 null。
   */
  function usageOfChild(childId, persisted) {
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
  function structuredOfChild(childId, persisted) {
    const record = typeof childId === "string" ? persisted?.[childId] : undefined;
    return projectStructuredResult(record?.structured);
  }

  /** 该 child 是否声明过 outputSchema：只有持久化 true 才输出，缺失不伪造 false。 */
  function outputSchemaRequestedOfChild(childId, persisted) {
    const record = typeof childId === "string" ? persisted?.[childId] : undefined;
    return record?.outputSchemaRequested === true;
  }

  /**
   * 运行期角色显示名映射（含历史角色显示名，包括已删除角色的持久化标签）。
   * 自定义角色能力已删除，它只服务历史任务/旧快照的可读标签；
   * 不可用时返回空对象，绝不猜显示名。
   */
  function currentRoleLabels() {
    if (typeof roleLabels !== "function") return {};
    const value = safeCall(() => roleLabels(), null);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  /**
   * 角色的显示名投影：运行期目录优先（角色改名/内置角色文案调整后，历史任务同步
   * 显示当前名称），其次持久化快照（角色已删除时历史任务仍可显示标签）。
   * 两者都没有时返回 null。
   */
  function roleLabelOf(role, persistedLabel) {
    const roleId = firstText(role);
    if (roleId !== null) {
      const current = firstText(currentRoleLabels()[roleId]);
      if (current !== null) return current;
    }
    return firstText(persistedLabel);
  }

  /**
   * 轻量快照专用的会话标题读面（可选能力，期望零 I/O）。
   *
   * 冷会话标题原本只能在 `readSession` 之后读到，而轻量路径不做任何冷读，因此这里留一个
   * **可选**依赖槽：宿主提供 `projectionTitleFor` 时用它替代冷会话标题；没有提供（或它读不到、
   * 抛错、返回空串）时返回 null，降级链继续落到 child_models.lastDispatch.description。
   *
   * 探测与调用都必须 fail-soft：可选服务缺失绝不能影响首屏，因此所有异常在这里被收敛成 null。
   */
  function projectionTitleOf(childId) {
    if (typeof projectionTitleFor !== "function") return null;
    return firstText(safeCall(() => projectionTitleFor(childId), null));
  }

  /**
   * fan-out 分片身份一致性校验（**只用廉价记录，绝不冷读**）。
   *
   * 归属证明回答的是「这个 child 属于本 root 吗」；本函数回答的是更强的「它属于**本分片的这一次
   * attempt** 吗」。完整路径靠 `readSession` 的 header 证明前者，轻量路径没有这次读取，因此两种
   * 模式都用 `child_models` 记录自带的 fan-out 身份做**反证**：记录一旦声明了
   * fanoutParentTaskId / fanoutShardId / fanoutAttempt，就必须与当前父任务 / 分片 / attempt 一致，
   * 否则返回 true（调用方把该 childId 清空），保证 fast 与 full 的归属结论一致、都 fail-closed。
   *
   * 只有「记录存在且与之矛盾」才算反证：完全没有记录的 child（例如由 live agent 的
   * header.parentSession 证明归属）不受影响，避免把可用的导航键误删。
   */
  function fanoutIdentityContradicts(record, childSnapshot, { parentTaskId, shardId, attempt }) {
    for (const source of [record, childSnapshot]) {
      if (source === null || source === undefined) continue;
      const declaredTask = nonEmpty(source.fanoutParentTaskId);
      if (declaredTask !== null && declaredTask !== parentTaskId) return true;
      const declaredShard = nonEmpty(source.fanoutShardId);
      if (declaredShard !== null && shardId !== null && declaredShard !== shardId) return true;
      const declaredAttempt = Number.isSafeInteger(source.fanoutAttempt) ? source.fanoutAttempt : null;
      if (declaredAttempt !== null && attempt !== null && declaredAttempt !== attempt) return true;
    }
    return false;
  }

  /**
   * 当前根会话拥有的 fan-out 父任务。
   *
   * 归属查询优先问 fanout runtime：它按同一套 parentSessions 语义过滤 manager 的权威
   * 任务，并额外覆盖「活动 ownership 已释放、但持久化仍记录归属」的已终态恢复任务
   * （冷启动后这些任务必须继续出现在自己的根下）。两者都按根过滤，绝不退回全局
   * listTasks()——没有归属证明时保持 fail-closed，不借任务视图枚举别的会话。
   */
  function fanoutTasksOwnedBy(sessionId) {
    const fromRuntime = safeCall(() => fanoutHost?.tasksOwnedBy?.(sessionId), undefined);
    if (Array.isArray(fromRuntime)) return fromRuntime;
    const fromLineage = safeCall(() => lineage?.tasksOwnedBy?.(sessionId), undefined);
    return Array.isArray(fromLineage) ? fromLineage : [];
  }

  /**
   * 逐动作能力（票据 09）：唯一来源是 fanoutHost.capabilitiesOf（归属 + manager 能力）。
   *
   * 返回 undefined 表示**旧 Host 或测试替身没有该读面**：投影层据此完全省略 capabilities
   * 字段，客户端回退既有状态推导，绝不伪造一个「全部拒绝」的能力对象。
   */
  function fanoutCapabilitiesFor(rootId, parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return undefined;
    if (typeof fanoutHost?.capabilitiesOf !== "function") return undefined;
    const capabilities = safeCall(() => fanoutHost.capabilitiesOf(rootId, parentTaskId), undefined);
    if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return undefined;
    return capabilities;
  }

  function isMissingSessionError(error) {
    const code = firstText(error?.code, error?.name)?.toLowerCase();
    const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
    return code === "enoent" || code === "not_found" || code === "session_not_found"
      || message.includes("session not found") || message.includes("session-not-found");
  }

  async function readColdSession(sessionId, parentSessionId) {
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
   * 单次 buildSnapshotForSession 专用的冷读协调器（**绝不跨 root、跨快照复用**）。
   *
   * 同一次投影会从多个入口读取同一份 child 会话：root 冷读、普通 expert 阶段、fan-out 的
   * task/shard/attempt 归属证明。这些入口分属不同阶段且可以并行，因此协调器负责两件事：
   * 1. 按 `parentSessionId + childId` 缓存**读取 promise 本身**：同一快照内同一 child 只会真正
   *    调用一次 `sessionQuery.readSession`；`undefined`（会话不存在/父子不符）与 rejection 同样
   *    被缓存复用，所以第二个调用者拿到的是同一个结果或同一个错误对象，不会触发第二次读取；
   * 2. 真实 readSession 全局最多 COLD_READ_CONCURRENCY 个同时在飞：请求按 FIFO 排队，
   *    各阶段自己再收敛顺序与错误，因此阶段并行也不会突破上限。
   * 缓存随本次构建回收，构建结束后不再被任何后续快照（含失败后的立即重试）共享。
   */
  function createColdReadCoordinator() {
    const reads = new Map();
    const queue = [];
    let active = 0;
    const pump = () => {
      while (active < COLD_READ_CONCURRENCY && queue.length > 0) {
        const request = queue.shift();
        active += 1;
        // 这两个回调只 settle 请求方自己的 promise，返回的链式 promise 总是 resolve，
        // 因此协调器内部不会产生未处理的 rejection；请求方的 rejection 由调用方负责处理。
        readColdSession(request.childId, request.parentSessionId).then(
          (session) => { active -= 1; request.resolve(session); pump(); },
          (error) => { active -= 1; request.reject(error); pump(); },
        );
      }
    };
    return {
      /** 读取并校验某个 child（root 时 parentSessionId 传 null）的冷会话；同键只读一次。 */
      read(childId, parentSessionId) {
        const key = (parentSessionId ?? "") + "|" + childId;
        const cached = reads.get(key);
        if (cached !== undefined) return cached;
        const promise = new Promise((resolve, reject) => {
          queue.push({ childId, parentSessionId, resolve, reject });
          pump();
        });
        reads.set(key, promise);
        return promise;
      },
    };
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
  function collectParentEvidence({ agent, record, childSnapshot, session } = {}) {
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
  function parentEvidenceVerdict(evidence, rootId) {
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
   */
  async function resolveOwnedChild(childId, { rootId, parentTaskId, persisted, cache, coordinator, fast }) {
    if (typeof childId !== "string" || childId.length === 0) {
      return { owned: false, childId: null, agent: undefined, session: undefined, childSnapshot: null };
    }
    // 缓存键带上父任务：同一次快照里 fan-out 归属是任务级的。
    const cacheKey = (typeof parentTaskId === "string" ? parentTaskId : "") + "|" + childId;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const record = recoveryRecords.get(childId);
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

  async function collectExperts(root, coordinator, { fast = false } = {}) {
    const persisted = persistedChildren();
    const ids = new Set();
    for (const record of recoveryRecords.values()) {
      if (record?.parentId === root.id && typeof record?.childId === "string") ids.add(record.childId);
    }
    for (const [childId, child] of Object.entries(persisted)) {
      if (child?.parentId === root.id && child?.fanout !== true) ids.add(childId);
    }

    // 第一步（同步，顺序 = ids）：只做筛选与归属判定，把需要投影的 child 按原顺序收进 candidates。
    // 跳过条件与归属语义（显式父证据冲突/缺失一律 fail-closed）与串行实现完全一致。
    const candidates = [];
    for (const childId of ids) {
      const record = recoveryRecords.get(childId);
      const childSnapshot = persisted[childId];
      if (childSnapshot?.fanout === true) continue;
      const agent = safeCall(() => agents?.get?.(childId), undefined) ?? record?.agent;
      const cachedSession = record?.session;
      // 只按 record.parentId 就直接使用 record.session 是不安全的：record 可能停留在旧代际，
      // 而 live/cached session 的 header.parentSession 已经指向别的 root。这里要求所有显式
      // 父证据一致指向本根，否则（冲突或缺失）一律 fail-closed 拒绝投影。
      const evidence = collectParentEvidence({ agent, record, childSnapshot, session: cachedSession });
      if (parentEvidenceVerdict(evidence, root.id) !== "owned") continue;
      // live child（recovery 缓存会话或在线 agent 会话）已经有可投影的会话对象：不进并发池、
      // 不等待任何冷读，保持原有快速路径；两者都缺失时才在第二步补一次冷读。
      candidates.push({ childId, record, childSnapshot, agent, session: cachedSession ?? agent?.session });
    }

    // 第二步（受控并发）：冷读之间互不依赖（各自只读一份日志，不引用彼此结果），串行会让总等待
    // 时间随 child 数线性增长，因此交给受控并发池。每次读取都走本次构建的共享协调器，与 root
    // 冷读、fan-out attempt 共用同一份 promise 缓存和同一个全局并发上限；这里的
    // forEachWithConcurrency 只负责本阶段的顺序与失败收敛语义。
    // 每个 child 读到的会话写回各自的 candidate，读取内容、归属校验与错误语义都不变；
    // live/cached 会话在上面已被快速跳过。
    // 失败时本阶段会先停止领取新项、等已启动的读取全部 settle，再把首个错误原样抛出，因此
    // 构建失败返回时不会有残留的冷读，snapshotInFlight 清理后同一 root 的立即重试也不会与
    // 旧批次重叠（并发上限仍然只有一个批次的量级）。
    // 轻量路径（fast）**完全跳过**这一步：没有 live/cached 会话的 candidate 保持 session 为
    // undefined，绝不触发任何 sessionQuery.readSession——这正是首屏 5~15s 的根因。
    if (fast !== true) {
      await forEachWithConcurrency(candidates, COLD_READ_CONCURRENCY, async (candidate) => {
        if (candidate.session !== undefined && candidate.session !== null) return;
        candidate.session = await coordinator.read(candidate.childId, root.id);
      });
    }

    // 第三步（同步，顺序 = candidates = ids）：投影顺序只由 candidates 决定，与冷读完成顺序无关，
    // 因此并发不会改变快照里 expert 的既有顺序。
    const experts = [];
    for (const candidate of candidates) {
      const { childId, record, childSnapshot, agent, session } = candidate;
      const events = sessionEvents(session);
      const context = safeCall(() => recovery?.contextFor?.(record), undefined) ?? record?.recoveryRequest;
      const sessionPrompt = dispatchedPrompt(session, events);
      const metadata = modelMetadata(agent, childSnapshot, context);
      const status = expertStatus({ agent, record, session, events });
      const mode = record?.continuable === true || childSnapshot?.continuable === true
        || agent?.options?.__degExpertContinuable === true ? "continuable" : "unknown";
      /**
       * 轻量路径的「证据不足」判定：既没有 live/cached 会话，也没有 live agent。
       *
       * 这种情况下 expertStatus 的 ready/idle 只是「读不到东西」的兜底值，客户端的活动证据链
       * 会把它读成「已结束/空闲」；因此降级为词表里的 unknown，并**省略 running 布尔**，
       * 让客户端落回「没有活动证据」，从而渲染中性圆点、不输出活动文案。
       * 注意：终态（succeeded/failed/…）本来就必须由 turn/end 证明，这里的降级不可能伪造终态；
       * 而 running/waiting 这类有真实证据的状态不受影响。
       */
      const evidenceFree = fast === true && (session === undefined || session === null)
        && (agent === undefined || agent === null);
      const projectedStatus = evidenceFree && (status === "ready" || status === "idle") ? "unknown" : status;
      // 用量（票据 25）：live 账本优先，其次 child_models.usage；无有效样本时省略整个字段。
      const usage = usageOfChild(childId, persisted);
      // 结构化交付（票据 30）：只读投影；缺失省略，绝不伪造回退/空值。
      const structured = structuredOfChild(childId, persisted);
      const outputSchemaRequested = outputSchemaRequestedOfChild(childId, persisted);
      // 当前/最近一轮 turn 的墙钟用时（与 DSH 状态行 "用时 …" 同源）；无 turn 事件时为 null。
      const turnDurationMs = turnDurationOf(events, now());
      experts.push({
        id: childId,
        kind: "expert",
        sessionId: childId,
        parentSessionId: root.id,
        // 当前/最近一轮的墙钟用时（与 DSH 状态行同源）；没有 turn 事件时省略。
        ...(turnDurationMs === null ? {} : { turnDurationMs }),
        // context.label 是最新 accepted dispatch 的短描述；冷恢复再读持久 child model。
        // 降级顺序与完整构建完全一致（描述优先于会话标题），轻量路径只是把读不到的冷会话标题
        // 换成同样语义的可选零 I/O 读面（projectionTitleOf），避免 full 替换 fast 时任务名跳动。
        taskName: firstText(
          context?.label,
          childSnapshot?.lastDispatch?.description,
          projectionTitleOf(childId),
          sessionTitle(session, childId, events),
        ),
        content: firstText(context?.promptText, childSnapshot?.lastDispatch?.prompt, sessionPrompt),
        contentSource: context?.promptText ? "dispatch-prompt" : sessionPrompt ? "session-log" : "unavailable",
        role: firstText(record?.role, childSnapshot?.role, agent?.options?.__degExpertRole),
        // 角色显示名（票据 27）：持久化快照优先，角色被删除后历史任务仍可显示标签。
        roleLabel: roleLabelOf(
          firstText(record?.role, childSnapshot?.role, agent?.options?.__degExpertRole),
          firstText(childSnapshot?.roleLabel),
        ),
        ...metadata,
        status: projectedStatus,
        ...(evidenceFree ? {} : { running: firstText(agent?.status, session?.status) === "running" }),
        runSummary: runSummary(session, projectedStatus, mode, events),
        continuable: mode === "continuable",
        ...(usage === null ? {} : { usage }),
        ...(structured === null ? {} : { structured }),
        ...(outputSchemaRequested ? { outputSchemaRequested: true } : {}),
        createdAt: createdAtOf(session?.createdAt, session?.header?.createdAt, childSnapshot?.createdAt),
      });
    }
    return experts;
  }

  /**
   * 单个 fan-out shard 的投影。
   *
   * attempt 之间彼此独立，因此先把本 shard 需要的归属证明**全部调度**（同一 child 去重），
   * 再用 allSettled 收敛：任一次读取失败，也要等本 shard 的全部证明 settle 之后才向上抛首个
   * 错误，避免失败返回后仍有 readSession 在后台运行。真实并发由协调器统一限流，shard 内因此
   * 可以放心地一次性调度全部 attempt。输出仍按 attempts 的输入顺序重组，与完成顺序无关。
   * **首错契约**：shard 内的首错按 proofIds 的稳定顺序选取（attempts 输入顺序，末尾是导航回退），
   * 与读取完成时序无关——先调度但迟到的失败，仍然优先于后调度却更早返回的失败。
   */
  async function projectFanoutShard(shard, task, { rootId, persisted, cache, coordinator, fast }) {
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
    const shardId = firstText(shard?.shardId);
    // 导航目标是最新 attempt 的 child；manager 若在 shard 上直接给了 childId，则作为回退。
    const navigationChildId = firstText(latestAttempt?.childId, shard?.childId);
    const parentTaskId = firstText(task?.parentTaskId);
    // 去重后的归属证明请求：proofIds 决定错误与结果的稳定顺序（attempts 顺序 + 导航回退）。
    const proofIds = [];
    const proofPromises = new Map();
    const requestProof = (childId) => {
      if (childId === null || proofPromises.has(childId)) return;
      proofIds.push(childId);
      proofPromises.set(childId, resolveOwnedChild(childId, { rootId, parentTaskId, persisted, cache, coordinator, fast }));
    };
    for (const attempt of attempts) requestProof(firstText(attempt?.childId));
    requestProof(navigationChildId);
    const settled = await Promise.allSettled(proofIds.map((childId) => proofPromises.get(childId)));
    const failure = firstRejection(settled);
    if (failure !== null) throw failure.reason;
    const proofs = new Map(proofIds.map((childId, index) => [childId, settled[index].value]));
    const navigationProof = navigationChildId === null ? undefined : proofs.get(navigationChildId);
    /**
     * 廉价反证（两种模式都执行，保证 fast 与 full 的归属结论一致、且都 fail-closed）：
     * 记录里声明了别的父任务 / 别的分片 / 别的 attempt 时，即使归属证明还算通过，
     * 也必须把该 childId 从输出副本清空——否则本行会挂上不属于它的会话。
     * 反证只用已经在手的持久化记录与 recovery 记录，不产生任何额外 IO。
     */
    const contradicts = (childId, attemptNumber) => {
      if (childId === null) return false;
      return fanoutIdentityContradicts(recoveryRecords.get(childId), persisted[childId], {
        parentTaskId,
        shardId,
        attempt: Number.isSafeInteger(attemptNumber) ? attemptNumber : null,
      });
    };
    const ownedChild = navigationProof?.owned === true
      && contradicts(navigationChildId, latestAttempt?.attempt) !== true
      ? navigationProof
      : undefined;
    // 归属未证明（或身份反证成立）的 childId 一律从**输出副本**清空：manager 的权威快照保持原样。
    const projectedAttempts = attempts.map((attempt) => {
      const childId = firstText(attempt?.childId);
      const proof = proofs.get(childId);
      const owned = (proof === undefined || proof.owned === true)
        && contradicts(childId, attempt?.attempt) !== true;
      if (!owned) return { ...attempt, childId: null };
      // 实际路由（票据 24）：尝试本身的持久化字段（未来管理器的快照扩展）优先，
      // 缺失时从同一 child 的 child_models 记录补齐 candidateIndex/fallbackCount/
      // lastRouteErrorCode；没有记录就省略字段，绝不伪造 0。
      const route = {
        ...projectModelRouteFields(attempt),
        ...projectModelRouteFields(persisted[childId]),
      };
      // 角色显示名（票据 27）：attempt 自身记录优先，其次同一 child 的 child_models 快照；
      // 两者都没有时省略字段（不猜显示名）。角色删除后历史 attempt 仍保留标签。
      const attemptRoleLabel = roleLabelOf(firstText(attempt?.role, task?.role), firstText(attempt?.roleLabel, persisted[childId]?.roleLabel));
      const labeled = attemptRoleLabel === null ? attempt : { ...attempt, roleLabel: attemptRoleLabel };
      // 目标 subagent provider / 继承开关（票据 29）：attempt 自身字段优先，其次同一
      // child 的 child_models 快照；都没有时省略字段，不伪造 false。
      const attemptSubagent = subagentContextFields(attempt, null, persisted[childId]);
      const settledAttempt = Object.keys(attemptSubagent).length === 0
        ? labeled
        : { ...labeled, ...attemptSubagent };
      // 用量（票据 25）：归属已证明的 attempt 才允许带 usage；缺失时省略整个字段，
      // 绝不把“没拿到 usage”渲染成 0 token。
      const attemptUsage = usageOfChild(childId, persisted);
      // 结构化交付（票据 30）：只读结果/声明标记来自同一 child 的 child_models；
      // 归属已证明的 attempt 才补齐，缺失整体省略。
      const attemptStructured = structuredOfChild(childId, persisted);
      const attemptRequested = outputSchemaRequestedOfChild(childId, persisted);
      const settled = Object.keys(route).length === 0 ? labeled : { ...labeled, ...route };
      const withSubagent = Object.keys(attemptSubagent).length === 0 ? settled : { ...settled, ...attemptSubagent };
      return {
        ...withSubagent,
        ...(attemptUsage === null ? {} : { usage: attemptUsage }),
        ...(attemptStructured === null ? {} : { structured: attemptStructured }),
        ...(attemptRequested ? { outputSchemaRequested: true } : {}),
      };
    });
    // 分片用量 = 全部 attempt 的用量按 childId 去重汇总：续作复用同一 child 时，
    // child_models.usage 是累计值，不能被多轮 attempt 重复相加。
    const shardUsage = sumUsageByChildId(projectedAttempts.map((attempt) => ({
      childId: attempt?.childId,
      usage: attempt?.usage,
    })));
    const shardStatus = firstText(shard?.status, ownedChild?.agent?.status, ownedChild?.session?.status) ?? "unknown";
    // 分片级结构化结果取最新 attempt 的 child_models（与 usage 同一“最新 attempt”口径）；
    // 不跨 attempt 合并 value，每个 attempt 自己的 structured 保留在 attempts 里。
    const shardStructured = structuredOfChild(navigationChildId, persisted);
    const shardRequested = outputSchemaRequestedOfChild(navigationChildId, persisted);
    // 分片最新 child 的当前/最近一轮墙钟（与 DSH 状态行同源）；无 live 会话时省略。
    const shardTurnDurationMs = turnDurationOf(sessionEvents(ownedChild?.session), now());
    return {
      ...shard,
      childId: ownedChild === undefined ? null : navigationChildId,
      role: firstText(shard?.role, task?.role),
      // 分片角色显示名（票据 27）：manager/分片记录优先，其次同一 child 快照，最后运行期目录。
      roleLabel: roleLabelOf(
        firstText(shard?.role, task?.role),
        firstText(shard?.roleLabel, persisted[navigationChildId]?.roleLabel),
      ),
      ...modelMetadata(ownedChild?.agent, ownedChild?.childSnapshot ?? null, null),
      runSummary: runSummary(ownedChild?.session, shardStatus, "continuable", sessionEvents(ownedChild?.session)),
      continuable: true,
      ...(shardUsage === null || !hasUsageMetrics(shardUsage) ? {} : { usage: shardUsage }),
      ...(shardStructured === null ? {} : { structured: shardStructured }),
      ...(shardRequested ? { outputSchemaRequested: true } : {}),
      ...(shardTurnDurationMs === null ? {} : { turnDurationMs: shardTurnDurationMs }),
      attempts: projectedAttempts,
    };
  }

  /**
   * 单个 fan-out 父任务的投影：shards 全部并行调度，等所有 shard settle 之后再抛首个错误；
   * 首错按 shards 的输入顺序选取（稳定，与完成时序无关）；成功时按 shards 的输入顺序重组，
   * 输出顺序与旧实现完全一致。
   */
  async function projectFanoutTask(task, deps) {
    const shards = Array.isArray(task?.shards) ? task.shards : [];
    const settled = await Promise.allSettled(shards.map((shard) => projectFanoutShard(shard, task, deps)));
    const failure = firstRejection(settled);
    if (failure !== null) throw failure.reason;
    const projectedShards = settled.map((result) => result.value);
    /**
     * 逐动作能力（票据 09）：父任务与每个 shard 都带上 Host 的权威能力投影。
     *
     * 能力只由 fanoutHost.capabilitiesOf 产生（归属 + manager 规则），快照层不做二次判定：
     * - 旧 Host/测试替身没有该读面时整个字段省略（客户端回退旧行为）；
     * - shard 能力按 shardId 对齐，缺失条目的 shard 不带字段，绝不补一个假的 allowed。
     * 这里写的是**投影副本**（projectFanoutShard 每次都返回新对象），不会改动 manager 的输入。
     */
    const capabilities = fanoutCapabilitiesFor(deps.rootId, task?.parentTaskId);
    if (capabilities !== undefined) {
      const shardCapabilities = capabilities.shards !== null && typeof capabilities.shards === "object"
        && !Array.isArray(capabilities.shards)
        ? capabilities.shards
        : {};
      for (const projected of projectedShards) {
        const shardId = firstText(projected?.shardId);
        if (shardId === null) continue;
        const shardCapability = shardCapabilities[shardId];
        if (shardCapability !== null && typeof shardCapability === "object" && !Array.isArray(shardCapability)) {
          projected.capabilities = shardCapability;
        }
      }
    }
    // 父任务用量 = 全部分片 attempt 的用量按 childId 去重汇总（防止跨分片重复或
    // 续作多轮重复）。没有有效样本时省略字段，父任务不显示假成本。
    const taskUsage = sumUsageByChildId(projectedShards.flatMap((shard) => (
      Array.isArray(shard?.attempts) ? shard.attempts.map((attempt) => ({
        childId: attempt?.childId,
        usage: attempt?.usage,
      })) : []
    )));
    return {
      ...task,
      shards: projectedShards,
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(taskUsage === null || !hasUsageMetrics(taskUsage) ? {} : { usage: taskUsage }),
    };
  }

  /**
   * fan-out 阶段：所有父任务并行调度（真实冷读由协调器全局限流），等所有已调度分支 settle
   * 之后再抛出**稳定**的首个错误；成功时按 rawTasks 的输入顺序重组，保持既有输出顺序。
   * **首错契约**：按「task → shard → attempt（含导航回退）」的输入顺序取第一个失败的 rejection，
   * 与完成时序无关，因此同一份输入重复构建得到同一个错误对象。
   */
  async function projectFanoutTasks(rawTasks, deps) {
    const tasks = Array.isArray(rawTasks) ? rawTasks : [];
    const settled = await Promise.allSettled(tasks.map((task) => projectFanoutTask(task, deps)));
    const failure = firstRejection(settled);
    if (failure !== null) throw failure.reason;
    return settled.map((result) => result.value);
  }

  /**
   * 从一份**完整**快照里提取排序锚点并写入该 root 的缓存条目（修复 A）。
   *
   * 只记录 root.children 上**非空有限数值**的 createdAt（专家节点与 fan-out 父任务都在这一层，
   * 分片/attempt 不参与顶层排序，无需记录）。已有锚点不被空值覆盖：某次完整构建若因为上游暂时
   * 读不到时间而给出 null，不应把已知的好锚点抹掉。整段读取 fail-soft：快照形状异常时静默跳过，
   * 绝不影响完整构建本身的成功返回。
   */
  function rememberSortAnchor(entry, snapshot) {
    const anchor = entry.sortAnchor;
    if (!(anchor instanceof Map)) return;
    const children = safeCall(() => snapshot?.root?.children, null);
    if (!Array.isArray(children)) return;
    for (const node of children) {
      if (node === null || typeof node !== "object") continue;
      const createdAt = node.createdAt;
      if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
      const key = firstText(node.id, node.parentTaskId, node.sessionId, node.childId);
      if (key !== null) anchor.set(key, createdAt);
    }
  }

  /**
   * 用**排序锚点**给轻量快照补上 createdAt（修复 A）。
   *
   * 背景：唯一排序点（expert-group-snapshot.js 的 sortByCreatedAt）按 createdAt 升序、缺失兜底
   * Infinity 排到最后。普通专家的 createdAt 在完整路径由冷读到的 session.createdAt 补上，而真实
   * child_models 记录里没有这个字段，轻量路径又没有 session，因此 fast 下恒为 null；fan-out 任务的
   * createdAt 来自 manager，两条路径一致。于是同一个 fan-out 节点在 partial / full 之间相对位置
   * 会跳变（Explorer 因 createdAt 最小恒居第一，所以它稳定，Oracle 会来回跳）。
   *
   * 处理方式：完整构建成功后把该快照里所有节点的 id → createdAt 记进缓存条目的锚点；轻量构建时
   * 只对 **createdAt 为 null** 的节点用锚点兜底填充，锚点里没有的保持 null（既有兜底行为不变）。
   * 这样两条路径对同一节点给出同一个键，排序结果一致，且**不修改排序语义本身**。
   *
   * 只按节点 id 匹配（专家节点 id 即 childId/sessionId，fan-out 节点 id 即 parentTaskId），
   * 因此锚点天然按 root 隔离：它挂在该 root 的缓存条目上，绝不跨 root 共享。
   */
  function applySortAnchor(nodes, sortAnchor) {
    if (!(sortAnchor instanceof Map) || sortAnchor.size === 0) return nodes;
    for (const node of nodes) {
      if (node === null || typeof node !== "object") continue;
      // 只补缺失值：已有真实 createdAt（完整路径 / manager 给出的任务时间）绝不被覆盖。
      if (node.createdAt !== null && node.createdAt !== undefined) continue;
      // 键与快照层一致：专家节点的 id 就是 childId/sessionId，fan-out 父任务的 id 由 parentTaskId
      // 派生（原始 manager 任务对象上没有 id 字段，因此这里按同一优先级回退）。
      const key = firstText(node.id, node.parentTaskId, node.sessionId, node.childId);
      if (key === null) continue;
      const anchored = sortAnchor.get(key);
      if (typeof anchored === "number" && Number.isFinite(anchored)) node.createdAt = anchored;
    }
    return nodes;
  }

  async function buildSnapshotForSession(sessionId, { fast = false, sortAnchor = null } = {}) {
    const id = nonEmpty(sessionId);
    if (id === null) throw new TypeError("expert-group-snapshot 需要 sessionId");
    // 本次构建独有的冷读协调器：root 冷读、普通 expert 阶段与 fan-out 阶段共用同一份读取
    // promise 缓存与同一个全局并发上限；构建结束即回收，不会被后续快照或别的 root 复用。
    // 轻量构建（fast）不会调用它——那时它只是一个空协调器，不产生任何 IO。
    const coordinator = createColdReadCoordinator();
    // 没有 ownership 证明时 fail-closed；fanoutHost 的全局 list 不能作为当前根的回退。
    const rawFanoutTasks = fanoutTasksOwnedBy(id);
    const persisted = persistedChildren();
    const knownByChild = Object.values(persisted).some((child) => child?.parentId === id);
    const knownByFanout = Array.isArray(rawFanoutTasks) && rawFanoutTasks.length > 0;
    let root = safeCall(() => lineage?.activeRoot?.(id), undefined) ?? safeCall(() => agents?.get?.(id), undefined);
    // 轻量路径用占位 root 时，root 自身也没有任何运行证据；投影层据此把它降级为中性状态。
    let placeholderRoot = false;

    if (root === undefined || root === null || root.id !== id) {
      if (fast === true) {
        // 轻量路径不冷读 root 会话。首屏只要求「有内容」，而 root 行的显示并不依赖会话日志
        // （第一行固定「主代理」，标题由客户端自己的会话投影给出）；因此这里只做廉价的存在性判定：
        // - 有 DEG 记录或 fan-out 任务能证明该 id 被使用过 → 用占位 root 继续投影子节点；
        // - 完全没有证据 → 返回 null，让调用方回落到完整构建，从而保留「陌生 id 一律 404」
        //   以及「冷 root 会话仍能读到标题/内容」这两个既有契约。
        if (!knownByChild && !knownByFanout) return null;
        const session = { id, header: { id }, events: [], status: "ready", requestHeader: () => ({ config: {} }) };
        root = { id, status: "ready", session, options: {} };
        placeholderRoot = true;
      } else {
        const coldSession = await coordinator.read(id, null);
        if (coldSession !== undefined) {
          root = { id, status: "ready", session: coldSession, options: coldSession.header?.config ?? {} };
        }
      }
    }

    if (root === undefined || root === null || root.id !== id) {
      // sessionQuery 是可选服务。它缺失时，只允许已有 DEG 记录能够证明 ownership 的根；
      // 一个完全陌生的 id 仍返回 404，不能借任务视图枚举别的会话。
      if (!knownByChild && !knownByFanout) {
        const error = new Error("root session not found: " + id);
        error.code = "session-not-found";
        throw error;
      }
      const session = { id, header: { id }, events: [], status: "ready", requestHeader: () => ({ config: {} }) };
      root = { id, status: "ready", session, options: {} };
    }

    const session = root.session;
    const rootEvents = sessionEvents(session);
    const goal = safeCall(() => goals?.get?.(root), undefined) ?? safeCall(() => goals?.get?.(id), undefined);
    const userRequest = recentUserRequest(session, rootEvents);
    const content = firstText(goal?.objective, userRequest);
    const header = safeCall(() => session?.requestHeader?.(), null);
    const metadata = modelMetadata(root, null, null);
    const rootStatus = firstText(root?.status, session?.status) ?? "unknown";
    // 每个 shard 的第二行必须描述最新 attempt 对应的实际 child；重试可能更换模型，
    // 因此不能只读取父任务创建时的角色选择，也不能沿用历史 attempt 的 metadata。
    // 同一份投影还必须做归属隔离：只有能证明属于当前 root 的 childId 才允许进入快照，
    // 否则客户端会导航到跨根会话，并看到别的根的模型、命令与状态。
    const childOwnership = new Map();
    // 普通 expert 阶段先启动：它决定首屏的专家列表，理应优先占用冷读队列；fan-out 阶段紧随其后
    // 启动。两个阶段**并行**推进，但共享同一个冷读协调器，因此真实 readSession 全局最多
    // COLD_READ_CONCURRENCY 个同时在飞，同一个 child 也不会被两个阶段读两次。
    const expertsStage = collectExperts(root, coordinator, { fast });
    const fanoutStage = projectFanoutTasks(rawFanoutTasks, {
      rootId: id,
      persisted,
      cache: childOwnership,
      coordinator,
      fast,
    });
    // 两个阶段都用 allSettled 收敛：阶段内部已保证各自已调度的分支全部 settle，这里再保证跨阶段
    // 收敛，因此构建失败返回时不会有残留冷读，同一 root 的立即重试不会与旧批次重叠。
    const settledStages = await Promise.allSettled([expertsStage, fanoutStage]);
    const [expertOutcome, fanoutOutcome] = settledStages;
    // 顶层错误选择显式按 **fan-out 优先**，用于兼容优化前的阶段顺序：改动前 buildSnapshotForSession
    // 先 await fan-out 投影、之后才 await collectExperts，两个阶段都失败时外部只会收到 fan-out 的
    // 错误。并行化以后必须用显式顺序保留这个可观察契约，绝不能依赖谁先失败/谁先完成（否则错误会随
    // 负载抖动）。此处两个阶段都已 settle，所以提前 throw 不会留下后台读取。
    const stageFailure = firstRejection([fanoutOutcome, expertOutcome]);
    if (stageFailure !== null) throw stageFailure.reason;
    const experts = expertOutcome.value;
    const fanoutTasks = fanoutOutcome.value;
    // 修复 A：轻量路径用排序锚点补 createdAt，让同一节点在 partial / full 下拿到同一个排序键。
    // 完整路径不传锚点（它的 createdAt 本来就是权威值），因此这里只影响 fast。
    if (fast === true) applySortAnchor([...experts, ...fanoutTasks], sortAnchor);
    /**
     * 恢复状态（票据 04）：两条构建路径都投影同一份只读状态，且**不做任何冷读**——
     * 它来自 fanoutHost 内存里的 restoreStatus()，因此轻量快照也能立刻反映恢复失败，
     * 用户不必等完整快照就能看到错误横幅与重试入口。
     */
    const recovery = recoveryInputFromRestoreStatus(safeCall(() => fanoutHost?.restoreStatus?.(), null));
    const generatedAt = now();
    // 根会话当前/最近一轮的墙钟用时（与 DSH 状态行同源）；placeholder root 没有事件时省略。
    const rootTurnDurationMs = turnDurationOf(rootEvents, generatedAt);
    return buildExpertGroupSnapshot({
      sessionId: id,
      generatedAt,
      recovery,
      root: {
        id,
        kind: "root",
        sessionId: id,
        taskName: sessionTitle(session, id, rootEvents),
        content,
        contentSource: goal?.objective ? "goal" : userRequest ? "recent-user-request" : "unavailable",
        role: "orchestrator",
        ...metadata,
        // 占位 root（轻量路径且没有 live root）没有任何运行证据：状态降级为 unknown 并省略
        // running 布尔，客户端因此渲染中性圆点而不是「已结束」的绿色圆点。
        status: placeholderRoot ? "unknown" : rootStatus,
        ...(placeholderRoot ? {} : { running: rootStatus === "running" }),
        runSummary: runSummary(session, placeholderRoot ? "unknown" : rootStatus, "one-shot", rootEvents),
        continuable: false,
        ...(rootTurnDurationMs === null ? {} : { turnDurationMs: rootTurnDurationMs }),
        createdAt: createdAtOf(session?.createdAt, session?.header?.createdAt, header?.createdAt),
      },
      experts,
      fanoutTasks,
      // 角色显示名（票据 27）：含历史角色显示名（包括已删除角色的持久化标签）；
      // 只有至少一个条目时才出现在快照顶层。
      roleLabels: currentRoleLabels(),
      // partial 是本次新增的快照级标记：true = 轻量快照（跳过了全部冷读，状态可能不完整），
      // false = 完整权威快照。客户端据此在轻量快照期间保持状态圆点/活动文案中性。
      partial: fast === true,
    });
  }

  // ── 按 root 的两级快照缓存（轻量 / 完整） ────────────────────────────────────
  //
  // 结构：rootId → { full, fast, generation, building, lastError, rebuildBlockedUntil,
  //                    failureCount, retryBlockedUntil, sortAnchor }
  // - full/fast：{ snapshot, at, generation }。generation 是**该次构建开始时**捕获的代次，
  //   用来判定「这份结果读完之后有没有发生失效事件」，时间戳只用来兜底 TTL；
  //   **at 只在真正构建出该级结果时写入，命中缓存绝不刷新**（R2）：否则持续轮询会把 6s 的
  //   陈旧上界退化成「滑动空闲 TTL」，一旦失效事件被漏掉，同一份 partial 就能无限期复用；
  // - generation：每次 invalidateSnapshots 命中该 root 时递增。失效**不删除**已缓存的快照：它只
  //   表示「这份结果可能已经不代表当前状态」。因此失效后的下一个请求会同步构建一份新的轻量快照
  //   （毫秒级），保证状态变化立刻可见；而「只是过期、没有失效事件」时继续返回上一份权威快照
  //   （不降级），避免界面在 full ↔ fast 之间抖动；
  // - building：该 root 正在进行的完整构建（同一 root 同时只允许一个）；
  // - lastError：最近一次后台完整构建的错误对象，供 awaitFullBuild（测试/诊断）原样观察；
  // - rebuildBlockedUntil：因「构建期间发生过失效」而需要的重建的最早启动时刻（去抖），
  //   保证活跃会话下不会退化成「每个请求一次全量冷读」；
  // - failureCount / retryBlockedUntil：后台完整构建**连续失败**次数与失败重试的最早启动时刻
  //   （R1 的指数退避，与上面的失效去抖是两条独立闸门；成功后立即清零）；
  // - sortAnchor：节点 id → createdAt 的**排序锚点**（修复 A）。只由完整构建成功写入，轻量构建
  //   用它给缺失的 createdAt 兜底，使同一节点在 partial / full 下拿到同一个排序键、相对位置不再
  //   跳变。锚点挂在条目上 ⇒ 与缓存条目同生命周期、按 rootId 天然隔离，绝不跨 root 泄漏。
  //
  // 容量契约（R3）：
  // - **非在飞**条目受 SNAPSHOT_CACHE_LIMIT（8）约束，这是「缓存结果」的硬上限；
  // - **在飞**（building !== null）条目在构建结束前**不得**被淘汰：淘汰它会让 awaitFullBuild
  //   看不到该构建、后续请求为同一 root 再起一个构建，破坏「同一 root 同时只有一个构建」；
  // - 在飞条目另有独立安全上限 SNAPSHOT_INFLIGHT_LIMIT（16），防止异常增长把缓存撑成无界；
  // - 因此条目总数上界是 8 + 16 = 24。
  // 顺序是真正的 LRU——命中与写入都会把条目提到队尾，因此活跃 root 不会被一次性查询挤掉。
  const snapshotCache = new Map();

  /** 把条目提到 LRU 队尾（Map 的插入顺序即 LRU 顺序：队首最久未使用）。 */
  function touchEntry(rootId) {
    const entry = snapshotCache.get(rootId);
    if (entry === undefined) return;
    snapshotCache.delete(rootId);
    snapshotCache.set(rootId, entry);
  }

  function cacheEntry(rootId) {
    const existing = snapshotCache.get(rootId);
    if (existing !== undefined) {
      // 命中即提权：正在被轮询/观察的 root 不会被别的会话的一次性查询挤掉。
      touchEntry(rootId);
      return existing;
    }
    const entry = {
      full: null,
      fast: null,
      generation: 0,
      building: null,
      lastError: null,
      rebuildBlockedUntil: 0,
      // R1：连续失败次数与失败退避截止时刻（成功后清零，见 ensureFullBuild）。
      failureCount: 0,
      retryBlockedUntil: 0,
      // 修复 A：排序锚点（节点 id → createdAt），只由**完整构建成功**写入，供轻量构建补缺。
      // 挂在条目上 = 与缓存条目同生命周期、按 rootId 天然隔离，条目被淘汰时锚点一起消失。
      sortAnchor: new Map(),
    };
    snapshotCache.set(rootId, entry);
    // 创建路径同样维护硬上限：「轻量返回 null」「完整构建失败」这些不写结果的路径也会留下
    // 条目，容量不能只靠成功写入那一条路径收敛。
    evictSnapshots(rootId);
    return entry;
  }

  /**
   * 把缓存收敛到容量契约（R3）：非在飞条目 ≤ SNAPSHOT_CACHE_LIMIT，在飞条目 ≤ SNAPSHOT_INFLIGHT_LIMIT。
   *
   * 淘汰顺序（按 Map 的插入顺序 = LRU 顺序，队首最久未使用）：
   * 1. 先淘汰**非在飞**条目，直到非在飞数量回到 SNAPSHOT_CACHE_LIMIT；
   * 2. 只有在飞条目本身超过安全上限时，才按 LRU 淘汰最久未用的在飞条目。
   *
   * 关键不变量：在飞条目**不会**因为非在飞条目超限而被淘汰。淘汰一个在飞条目会让
   * awaitFullBuild 看不到该构建、后续请求为同一 root 启动第二个构建（同一 root 同时只有一个构建
   * 的契约被破坏，且每个构建各自建立冷读协调器，跨 root 的实际 I/O 并发被放大）。
   * keepRootId 是刚刚创建/正在写入的 root，任何一轮都不淘汰它，避免「刚建好就被自己挤掉」。
   */
  function evictSnapshots(keepRootId = null) {
    const idleLimit = SNAPSHOT_CACHE_LIMIT;
    const inflightLimit = SNAPSHOT_INFLIGHT_LIMIT;
    // 先数一遍在飞数量：后面两轮都要用到，避免每淘汰一个就重扫全表。
    let inflight = 0;
    for (const entry of snapshotCache.values()) {
      if (entry.building !== null) inflight += 1;
    }
    let idle = snapshotCache.size - inflight;
    if (idle <= idleLimit && inflight <= inflightLimit) return;
    for (const [rootId, entry] of snapshotCache) {
      if (idle <= idleLimit) break;
      if (rootId === keepRootId) continue;
      if (entry.building !== null) continue;
      snapshotCache.delete(rootId);
      idle -= 1;
    }
    // 在飞条目只在超过**自己的**安全上限时才淘汰（异常增长的兜底，正常路径不会触发）。
    if (inflight <= inflightLimit) return;
    for (const [rootId, entry] of snapshotCache) {
      if (inflight <= inflightLimit) return;
      if (rootId === keepRootId) continue;
      if (entry.building === null) continue;
      snapshotCache.delete(rootId);
      inflight -= 1;
    }
  }

  /**
   * 某一级缓存是否新鲜：写入代次必须等于当前代次（其间没有失效事件），且未超过该级 TTL。
   *
   * 两级的代次都在**各自构建开始时**捕获（见 ensureFullBuild / resolveSnapshotForSession）：
   * 构建期间到达的失效事件会让这份结果落成「非当前权威」，绝不会被当成最新版返回。
   */
  function isFresh(level, entry, timestamp, ttlMs) {
    if (level === null || level.generation !== entry.generation) return false;
    return timestamp - level.at < ttlMs;
  }

  /**
   * 上屏可用的完整快照（阻塞项 B2）。
   *
   * 任何返回缓存 full 的路径都必须同时满足两条约束：
   * ① 代次一致，或处于**明确的短宽限**内（FULL_SNAPSHOT_STALE_GRACE_MS）；
   * ② 未超过**绝对宽限上限**（FULL_SNAPSHOT_GRACE_MS）。
   * 超出上限一律返回 null，由调用方回落到轻量快照 / 既有的完整构建（可能得到 404），
   * 从而保证「root 被释放、持久化证据消失、上游持续失败」时不会无限期展示已失效的 root。
   */
  function displayableFull(entry, timestamp) {
    if (entry.full === null) return null;
    const age = timestamp - entry.full.at;
    if (age >= FULL_SNAPSHOT_GRACE_MS) return null;
    if (entry.full.generation === entry.generation) return entry.full.snapshot;
    // 代次不一致：构建期间发生过失效，内容仍是那一次真实读取，只允许在很短的窗口内兜底。
    return age < FULL_SNAPSHOT_STALE_GRACE_MS ? entry.full.snapshot : null;
  }

  /**
   * 幂等地启动该 root 的后台完整构建。
   *
   * - 已有在飞构建时直接复用同一个 promise（同一 root 同时只有一个 readSession 批次）；
   * - **构建开始时**捕获代次并随结果写入缓存（阻塞项 B1）：构建期间到达的失效事件因此会体现在
   *   「写入代次 ≠ 当前代次」上，该结果不会被标记成当前权威，最多只在
   *   FULL_SNAPSHOT_STALE_GRACE_MS 的短宽限内兜底；
   * - 一次被判为非权威的构建之后，间隔 STALE_REBUILD_MIN_INTERVAL_MS 才允许再次后台重建
   *   （去抖）：否则活跃会话里每次失效都会立刻重跑全量冷读，退化成「每请求一次全量构建」；
   * - 成功后写入 full 缓存并记录写入时刻与代次；失败时记录 lastError 并写一条宿主日志
   *   （完整构建不再阻塞请求，因此错误只能从这里暴露）；两条路径都维护缓存硬上限；
   * - 返回值可能是 rejected promise：调用方要么 await 它（「无法证明 root 存在」的回落路径，
   *   需要原样抛出错误），要么像普通请求路径那样忽略它。内部已挂了一个 catch 处理器，
   *   所以忽略也不会产生未处理的 rejection。
   */
  function ensureFullBuild(rootId) {
    const entry = cacheEntry(rootId);
    if (entry.building !== null) return entry.building;
    entry.lastError = null;
    // 代次在构建**开始**时捕获：完成时不再读取 entry.generation。
    const buildGeneration = entry.generation;
    const settled = buildSnapshotForSession(rootId, { fast: false }).then(
      (snapshot) => {
        entry.full = { snapshot, at: now(), generation: buildGeneration };
        // 修复 A：完整快照是权威的 createdAt 来源，构建成功后把 id → createdAt 记成锚点，
        // 供后续轻量快照补齐同一个排序键。只记录非空有限数值；空值不覆盖已有锚点。
        rememberSortAnchor(entry, snapshot);
        // 成功即重置失败退避（R1）：下一次失败重新从基数开始，不会因为历史失败次数被长期拖慢。
        entry.failureCount = 0;
        entry.retryBlockedUntil = 0;
        // 构建期间发生过失效：这份结果不是当前权威。除「写入代次 ≠ 当前代次」之外，还要显式
        // 记下一条宿主日志，并推迟下一次重建，避免活跃会话下被失效事件驱动成每请求全量冷读。
        if (buildGeneration !== entry.generation) {
          entry.rebuildBlockedUntil = now() + STALE_REBUILD_MIN_INTERVAL_MS;
          logStaleBuild(rootId);
        }
        if (entry.building === settled) entry.building = null;
        touchEntry(rootId);
        evictSnapshots(rootId);
        return snapshot;
      },
      (error) => {
        entry.lastError = error;
        // 失败退避（R1）：连续失败按 5s → 10s → 20s → 40s → 40s… 指数上升并封顶。
        // 没有这条闸门时，下一次轮询（约 2.5s 后）会立刻重新冷读全部 child，活跃会话下
        // 按轮询周期反复重跑全量冷读，并让界面长期停在 partial。
        entry.failureCount += 1;
        const backoffMs = Math.min(
          FULL_SNAPSHOT_TTL_MS * (2 ** Math.min(entry.failureCount - 1, 16)),
          FULL_SNAPSHOT_RETRY_MAX_MS,
        );
        entry.retryBlockedUntil = now() + backoffMs;
        if (entry.building === settled) entry.building = null;
        touchEntry(rootId);
        evictSnapshots(rootId);
        logBuildFailure(rootId, error, backoffMs);
        throw error;
      },
    );
    entry.building = settled;
    // 立即消费一次 rejection：后台失败不得变成未处理的 rejection；awaitFullBuild 的调用方
    // 拿到的仍是同一个 promise（因此仍是同一个错误对象）。
    settled.catch(() => {});
    return settled;
  }

  /**
   * 是否允许启动一次**新的**后台完整构建（两条独立的闸门）。
   *
   * 1. 失效去抖：上一次构建「成功但期间发生过失效」后，冷却 STALE_REBUILD_MIN_INTERVAL_MS；
   * 2. 失败退避（R1）：上一次构建直接失败后，按指数退避冷却 FULL_SNAPSHOT_RETRY_MAX_MS 封顶。
   *
   * 两个窗口内的请求继续由毫秒级的轻量快照承担展示，不再触发全量冷读；已有在飞构建时
   * ensureFullBuild 自身就会复用，因此这里只看冷却。失效事件**不**提前解除失败退避：失败反映
   * 的是上游冷读健康度，与「这份快照是否陈旧」正交，用事件放行会让退避被事件流完全绕过。
   */
  function canStartFullBuild(entry) {
    if (entry.building !== null) return true;
    const timestamp = now();
    return timestamp >= entry.rebuildBlockedUntil && timestamp >= entry.retryBlockedUntil;
  }

  /**
   * 幂等地确保后台完整构建已启动。
   *
   * 与 ensureFullBuild 的唯一区别是它先过冷却闸门：被判为非权威的构建之后，冷却窗口内的请求
   * 不会启动新的全量冷读（返回 undefined，调用方不得依赖返回值）。
   * 注意这里刻意**不调用 cacheEntry**：冷却闸门只是读，不应因为一次被挡下的请求就创建条目或
   * 提升 LRU 顺序（容量由真正产生结果的路径维护）。
   */
  function requestFullBuild(rootId) {
    const entry = snapshotCache.get(rootId);
    if (entry !== undefined && !canStartFullBuild(entry)) return undefined;
    return ensureFullBuild(rootId);
  }

  function logStaleBuild(rootId) {
    if (typeof logger?.warn !== "function") return;
    safeCall(() => logger.warn(
      "dsh-expert-group: expert-group snapshot build for " + rootId
      + " finished after an invalidation event; result is not authoritative and the next rebuild is deferred",
    ));
  }

  function logBuildFailure(rootId, error, backoffMs) {
    if (typeof logger?.warn !== "function") return;
    const message = error instanceof Error ? error.message : String(error);
    // 日志里带上本次退避时长：持续故障时能直接从宿主日志看出重试节奏在收敛。
    const suffix = Number.isFinite(backoffMs) ? "; retrying in " + backoffMs + "ms" : "";
    safeCall(() => logger.warn("dsh-expert-group: background expert-group snapshot build for " + rootId + " failed: " + message + suffix));
  }

  /**
   * 使某个会话（root 本身，或属于某个 root 的 child）相关的快照缓存失效。
   *
   * 判定顺序（全部是 O(1) 的 Map 读，找不到就什么都不做，因此幂等、无泄漏）：
   * 1. 该 id 自己就是缓存里的 root；
   * 2. recoveryRecords 的 parentId（live/恢复代际的 child）；
   * 3. 持久化 child_models 的 parentId（重启后只剩持久记录的 child）。
   *
   * **默认 no-op（阻塞项 B3③）**：id 缺失/非法（undefined、空串、纯空白、非字符串）时什么都不做，
   * 返回 0。事件挂点可能拿到缺失的 session/agent id（见 index.js 的接线），若把「没有 id」
   * 解释成「清空全部」，一次无关事件就会把全部 root 打回冷启动。全局失效必须显式调用：
   * `invalidateSnapshots({ all: true })`。
   * 返回被标记失效的 root 数量，便于调用方/测试观察。
   */
  function invalidateSnapshots(sessionId) {
    // 显式全局失效：只有调用方明确传对象才生效，绝不从「缺失 id」推断。
    if (sessionId !== null && typeof sessionId === "object" && sessionId.all === true) {
      let count = 0;
      for (const entry of snapshotCache.values()) {
        entry.generation += 1;
        count += 1;
      }
      return count;
    }
    const id = nonEmpty(sessionId);
    if (id === null) return 0;
    const parentId = snapshotCache.has(id)
      ? id
      : firstText(
        recoveryRecords.get(id)?.parentId,
        persistedChildren()[id]?.parentId,
      );
    const entry = parentId === null ? undefined : snapshotCache.get(parentId);
    if (entry === undefined) return 0;
    entry.generation += 1;
    // 失效只影响「这份结果还算不算当前权威」，不重置去抖窗口：冷却窗口从构建完成时刻起算，
    // 否则「失效即放行」会让去抖完全失效。
    return 1;
  }

  /**
   * 请求路径：轻量优先、完整后台补齐。首屏因此不再等待任何冷读。
   *
   * 顺序（①②③④ 是需求给定的顺序，后两条是同一契约下的防抖动收敛）：
   * 1. 完整快照「新鲜」（代次一致且未超 FULL TTL）→ 直接返回；
   * 2. 完整快照「只是过期」（代次仍一致、未超**绝对**宽限上限）→ 返回它并后台重建：期间没有
   *    任何可观察的状态变化，降级为轻量快照只会让界面在 full ↔ fast 之间抖动；
   * 3. 完整快照「已失效」（收到过失效事件）或超过宽限上限 → 必须给出与新状态一致的结果：
   *    新鲜轻量快照 → 直接返回；否则同步构建一份轻量快照（毫秒级）后返回；
   * 4. 上述每条路径都**幂等**地确保该 root 的后台完整构建已启动（同一 root 同时只有一个；
   *    被判为非权威的构建之后有一个 STALE_REBUILD_MIN_INTERVAL_MS 的冷却窗口）。
   *
   * 边界：轻量构建返回 null 表示「没有任何证据证明该 root 存在」。此时只允许用**仍在宽限内**的
   * 完整快照兜底（displayableFull 同时检查代次与绝对上限）；连它也没有就 await 后台完整构建，
   * 保留原有的 404 / 错误传播契约——绝不无限期展示已失效的 root。
   */
  async function resolveSnapshotForSession(id) {
    const timestamp = now();
    const entry = cacheEntry(id);
    if (isFresh(entry.full, entry, timestamp, FULL_SNAPSHOT_TTL_MS)) return entry.full.snapshot;
    if (entry.full !== null
      && entry.full.generation === entry.generation
      && timestamp - entry.full.at < FULL_SNAPSHOT_GRACE_MS) {
      // 「只是过期」而不是「已失效」：期间没有任何可观察的状态变化，因此继续用上一份权威快照
      // 顶住（不降级为轻量快照），同时后台重建。稳态下这保证界面不会在 full ↔ fast 之间抖动。
      requestFullBuild(id);
      return entry.full.snapshot;
    }
    // 已失效（收到过状态变化事件）或超过宽限期：必须给出与新状态一致的结果。
    // 轻量快照是同步构建的毫秒级投影，先用它保证「状态变化立刻可见」，完整快照紧随其后替换。
    // 代次同样在**构建开始时**捕获（与完整构建同一条规则）。
    //
    // R2：**命中缓存时绝不续期**。只有真正重建 fast 时才写入新的时间戳与代次；否则持续轮询会
    // 把 FAST_SNAPSHOT_TTL_MS 退化成「滑动空闲 TTL」——只要失效事件被漏掉（事件挂点没拿到 id、
    // 宿主事件丢失、客户端轮询早于事件落库），同一份 partial 就能无限期复用。
    // 现在「陈旧上界」由**首次构建时刻**的绝对时间保证：距上次真正重建满 6s 必然重建一次。
    //
    // R5：轻量构建 await 之后必须复核代次。若失效恰好发生在构建期间，这份结果就不是当前权威，
    // 不能作为本次响应返回（否则客户端会拿到旧代次的 partial 并把它当成最新状态）。
    // 处理方式是最小正确做法：立即**再重建一次**（轻量构建是零 I/O 的同步投影，重算不引入阻塞、
    // 不触发任何冷读），并把这次重建结果当作当前权威；最多重算一次，避免理论上
    // 「失效事件与构建无限交替」时自旋。
    let fast;
    let fastGeneration = entry.generation;
    if (isFresh(entry.fast, entry, timestamp, FAST_SNAPSHOT_TTL_MS)) {
      // 命中已有轻量快照：直接复用，**不写回时间戳**（R2）。
      fast = entry.fast.snapshot;
    } else {
      // 真正重建：代次在构建**开始时**捕获（与完整构建同一条规则）。
      // 修复 A：把该 root 的排序锚点传给轻量构建，用它给缺失的 createdAt 兜底（按 root 隔离）。
      fastGeneration = entry.generation;
      fast = await buildSnapshotForSession(id, { fast: true, sortAnchor: entry.sortAnchor });
      if (fast !== null && fastGeneration !== entry.generation) {
        // R5：构建期间发生过失效，这份结果不是当前权威——丢弃它，按**当前**代次重算一次
        // （仍是零 I/O 的同步轻量投影，不引入阻塞、不触发冷读）。只重算一次，避免自旋。
        fastGeneration = entry.generation;
        fast = await buildSnapshotForSession(id, { fast: true, sortAnchor: entry.sortAnchor });
      }
      // 只有真正重建成功时才写入新的时间戳与代次；命中路径保持原有 at 不变。
      if (fast !== null) {
        entry.fast = { snapshot: fast, at: now(), generation: fastGeneration };
        touchEntry(id);
        evictSnapshots(id);
      }
    }
    if (fast === null) {
      // 证据不足：只接受仍在宽限内的完整快照兜底（代次一致，或处于明确的短宽限），
      // 否则等完整构建——它要么给出权威结果，要么按既有契约抛 session-not-found（404）。
      const fallback = displayableFull(entry, timestamp);
      if (fallback !== null) {
        requestFullBuild(id);
        return fallback;
      }
      return await ensureFullBuild(id);
    }
    requestFullBuild(id);
    return fast;
  }

  async function snapshotForSession(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) return buildSnapshotForSession(sessionId, { fast: false });
    const existing = snapshotInFlight.get(id);
    if (existing !== undefined) return existing;
    const promise = resolveSnapshotForSession(id);
    snapshotInFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      if (snapshotInFlight.get(id) === promise) snapshotInFlight.delete(id);
    }
  }

  /**
   * 等待某个 root 的后台完整构建收敛，并返回完整快照。
   *
   * 语义（供测试与收尾使用，不参与首屏与 RPC 信封）：
   * - 有在飞构建 → 等它 settle；成功返回完整快照，失败**原样抛出**同一个错误对象；
   * - 没有在飞构建 → 返回**仍在宽限内**的缓存完整快照（R4：与请求路径共用 displayableFull 的
   *   同一套有界判定：代次一致，或处于明确的短宽限，且都不超过绝对宽限 FULL_SNAPSHOT_GRACE_MS）；
   *   超过上限一律返回 null，绝不无限期返回已失效的 full；
   * - 没有可用缓存但上一次后台构建失败 → 抛出该错误（错误契约不变）；
   * - 从未构建过（未知 root）→ 返回 null。
   */
  async function awaitFullBuild(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) return null;
    const entry = snapshotCache.get(id);
    if (entry === undefined) return null;
    if (entry.building !== null) return await entry.building;
    const cached = displayableFull(entry, now());
    if (cached !== null) return cached;
    if (entry.lastError !== null) throw entry.lastError;
    return null;
  }

  return Object.freeze({ snapshotForSession, invalidateSnapshots, awaitFullBuild });
}
