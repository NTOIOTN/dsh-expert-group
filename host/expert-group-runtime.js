/**
 * Expert Group Host 运行时适配器。
 *
 * 本模块只读取 DEG 已有的 root/child/fan-out/goal 状态，并把不稳定的 DSH 对象形状
 * 收敛为 expert-group-snapshot 深模块的输入。它不持久化第二套任务状态，也不参与
 * 任务调度、恢复或 fan-out 结算。
 *
 * @module dsh-expert-group/host/expert-group-runtime
 */
import { buildExpertGroupSnapshot } from "./expert-group-snapshot.js";

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

function runSummary(session, status, mode, events = sessionEvents(session)) {
  const state = toolCallState(events);
  return {
    command: latestCommand(session, events, state),
    mode: mode === "continuable" || mode === "one-shot" ? mode : "unknown",
    activity: activityOf(status, events, state),
  };
}

function modelMetadata(agent, persisted, context) {
  const header = safeCall(() => agent?.session?.requestHeader?.(), null);
  const config = header?.config ?? {};
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
 * fan-out 的 per-role 默认并发（10）。live/cached 会话不进入这个并发池。
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
 * @param {object} dependencies
 * @returns {{snapshotForSession(sessionId:string): Promise<object>}}
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
  now = Date.now,
} = {}) {
  if (!(recoveryRecords instanceof Map)) throw new TypeError("Expert Group runtime 需要 recoveryRecords Map");
  if (typeof now !== "function") throw new TypeError("Expert Group runtime 需要 now 函数");
  // root 与 child surface 可能同时请求同一份树；只合并重叠的构建期，完成后不保留
  // 旧快照，确保下一次通知仍读取最新状态。
  const snapshotInFlight = new Map();

  function persistedChildren() {
    const snapshot = safeCall(() => source?.(), null);
    return snapshot?.childModels && typeof snapshot.childModels === "object" ? snapshot.childModels : {};
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
  async function resolveOwnedChild(childId, { rootId, parentTaskId, persisted, cache, coordinator }) {
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
      const session = record?.session ?? agent?.session ?? await coordinator.read(childId, rootId);
      resolved = {
        owned: true,
        childId,
        agent,
        session,
        // 归属已由显式证据或父任务级记录证明，允许该记录提供 provider/model 回退。
        childSnapshot,
      };
    } else {
      const coldSession = await coordinator.read(childId, rootId);
      resolved = coldSession === undefined
        ? { owned: false, childId, agent: undefined, session: undefined, childSnapshot: null }
        : { owned: true, childId, agent, session: coldSession, childSnapshot: null };
    }
    cache.set(cacheKey, resolved);
    return resolved;
  }

  async function collectExperts(root, coordinator) {
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
    await forEachWithConcurrency(candidates, COLD_READ_CONCURRENCY, async (candidate) => {
      if (candidate.session !== undefined && candidate.session !== null) return;
      candidate.session = await coordinator.read(candidate.childId, root.id);
    });

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
      experts.push({
        id: childId,
        kind: "expert",
        sessionId: childId,
        parentSessionId: root.id,
        // context.label 是最新 accepted dispatch 的短描述；冷恢复再读持久 child model。
        taskName: firstText(context?.label, childSnapshot?.lastDispatch?.description, sessionTitle(session, childId, events)),
        content: firstText(context?.promptText, childSnapshot?.lastDispatch?.prompt, sessionPrompt),
        contentSource: context?.promptText ? "dispatch-prompt" : sessionPrompt ? "session-log" : "unavailable",
        role: firstText(record?.role, childSnapshot?.role, agent?.options?.__degExpertRole),
        ...metadata,
        status,
        running: firstText(agent?.status, session?.status) === "running",
        runSummary: runSummary(session, status, mode, events),
        continuable: mode === "continuable",
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
  async function projectFanoutShard(shard, task, { rootId, persisted, cache, coordinator }) {
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : undefined;
    // 导航目标是最新 attempt 的 child；manager 若在 shard 上直接给了 childId，则作为回退。
    const navigationChildId = firstText(latestAttempt?.childId, shard?.childId);
    const parentTaskId = firstText(task?.parentTaskId);
    // 去重后的归属证明请求：proofIds 决定错误与结果的稳定顺序（attempts 顺序 + 导航回退）。
    const proofIds = [];
    const proofPromises = new Map();
    const requestProof = (childId) => {
      if (childId === null || proofPromises.has(childId)) return;
      proofIds.push(childId);
      proofPromises.set(childId, resolveOwnedChild(childId, { rootId, parentTaskId, persisted, cache, coordinator }));
    };
    for (const attempt of attempts) requestProof(firstText(attempt?.childId));
    requestProof(navigationChildId);
    const settled = await Promise.allSettled(proofIds.map((childId) => proofPromises.get(childId)));
    const failure = firstRejection(settled);
    if (failure !== null) throw failure.reason;
    const proofs = new Map(proofIds.map((childId, index) => [childId, settled[index].value]));
    const navigationProof = navigationChildId === null ? undefined : proofs.get(navigationChildId);
    const ownedChild = navigationProof?.owned === true ? navigationProof : undefined;
    // 归属未证明的 childId 一律从**输出副本**清空：manager 的权威快照保持原样。
    const projectedAttempts = attempts.map((attempt) => {
      const proof = proofs.get(firstText(attempt?.childId));
      return proof === undefined || proof.owned ? attempt : { ...attempt, childId: null };
    });
    const shardStatus = firstText(shard?.status, ownedChild?.agent?.status, ownedChild?.session?.status) ?? "unknown";
    return {
      ...shard,
      childId: ownedChild === undefined ? null : navigationChildId,
      role: firstText(shard?.role, task?.role),
      ...modelMetadata(ownedChild?.agent, ownedChild?.childSnapshot ?? null, null),
      runSummary: runSummary(ownedChild?.session, shardStatus, "continuable", sessionEvents(ownedChild?.session)),
      continuable: true,
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
    return { ...task, shards: settled.map((result) => result.value) };
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

  async function buildSnapshotForSession(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) throw new TypeError("expert-group-snapshot 需要 sessionId");
    // 本次构建独有的冷读协调器：root 冷读、普通 expert 阶段与 fan-out 阶段共用同一份读取
    // promise 缓存与同一个全局并发上限；构建结束即回收，不会被后续快照或别的 root 复用。
    const coordinator = createColdReadCoordinator();
    // 没有 ownership 证明时 fail-closed；fanoutHost 的全局 list 不能作为当前根的回退。
    const rawFanoutTasks = fanoutTasksOwnedBy(id);
    const persisted = persistedChildren();
    let root = safeCall(() => lineage?.activeRoot?.(id), undefined) ?? safeCall(() => agents?.get?.(id), undefined);

    if (root === undefined || root === null || root.id !== id) {
      const coldSession = await coordinator.read(id, null);
      if (coldSession !== undefined) {
        root = { id, status: "ready", session: coldSession, options: coldSession.header?.config ?? {} };
      }
    }

    if (root === undefined || root === null || root.id !== id) {
      // sessionQuery 是可选服务。它缺失时，只允许已有 DEG 记录能够证明 ownership 的根；
      // 一个完全陌生的 id 仍返回 404，不能借任务视图枚举别的会话。
      const knownByChild = Object.values(persisted).some((child) => child?.parentId === id);
      const knownByFanout = Array.isArray(rawFanoutTasks) && rawFanoutTasks.length > 0;
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
    const expertsStage = collectExperts(root, coordinator);
    const fanoutStage = projectFanoutTasks(rawFanoutTasks, {
      rootId: id,
      persisted,
      cache: childOwnership,
      coordinator,
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
    return buildExpertGroupSnapshot({
      sessionId: id,
      generatedAt: now(),
      root: {
        id,
        kind: "root",
        sessionId: id,
        taskName: sessionTitle(session, id, rootEvents),
        content,
        contentSource: goal?.objective ? "goal" : userRequest ? "recent-user-request" : "unavailable",
        role: "orchestrator",
        ...metadata,
        status: rootStatus,
        running: rootStatus === "running",
        runSummary: runSummary(session, rootStatus, "one-shot", rootEvents),
        continuable: false,
        createdAt: createdAtOf(session?.createdAt, session?.header?.createdAt, header?.createdAt),
      },
      experts,
      fanoutTasks,
    });
  }

  async function snapshotForSession(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) return buildSnapshotForSession(sessionId);
    const existing = snapshotInFlight.get(id);
    if (existing !== undefined) return existing;
    const promise = buildSnapshotForSession(id);
    snapshotInFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      if (snapshotInFlight.get(id) === promise) snapshotInFlight.delete(id);
    }
  }

  return Object.freeze({ snapshotForSession });
}
