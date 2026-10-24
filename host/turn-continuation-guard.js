/**
 * root turn 完成标记（turn completion marker）与续接保护。
 *
 * ## 协议是什么
 * root 专用工具 dsh_expert_group_done（无参数）是**完成标记**：**每个 turn** 在给出最终
 * 答复之前，都必须把这次调用作为本 turn 的**最后一个工具调用**——不区分本 turn 是否调用过
 * 工具。root 的 agent/turn-stopping 边界据此做机械校验：turn 状态不是「以完成标记收尾」
 * 就视为未完成，调用方 steer 一条固定提醒让同一 turn 继续，而不是把 turn 关掉、让用户
 * 手动输入“继续”。
 *
 * ## 为什么不再用文本启发式
 * 旧实现用「动作词表 + 末句正则」猜测模型是否在任务中途停顿（例如“我去验证。”），
 * 该方案被证明既漏报又误报：同一句在不同上下文里既可能是承诺、也可能是陈述，词表永远
 * 追不上真实措辞。完成标记把判定从**自然语言猜测**换成**协议事实**：只看本 turn 的工具
 * 调用序列与其结果，不读任何文本内容，因此判定稳定、可测试、也不会被交付总结的措辞误导。
 *
 * ## 收尾判定（严格、fail-closed）
 * - 工具调用序列按 **callId 去重**：tool/call 事件与 assistant 消息里的 tool-call block 是
 *   同一次调用的两侧投影，重复出现只计一次（首次出现优先）；没有 callId 的条目用合成键
 *   入列、name 记为 null——它会让“最后一条”不再等于完成标记，从而保守地判定为未完成。
 * - 最后一条条目的 name 必须**严格等于** dsh_expert_group_done；尾部任何残缺/缺名调用都
 *   会破坏收尾。
 * - 最后这条 done **必须有非空 callId**：只有 assistant 消息里的 tool-call block、缺少
 *   tool/call 事件与 tool/result 的投影，无法核对调用是否真的发生并成功，因此不算收尾。
 * - 必须找到同一 callId、且**明确非失败**的成功凭据：顶层调用看 tool/result（结果缺失、
 *   message.isError === true 或 data.error != null 都按未完成处理）；PTC 嵌套调用看
 *   tool/ptc-dispatch 完成事件的 completed 与 isError。失败只看结构化字段，绝不解析正文
 *   （正文是模型可见文本，不能当协议凭据）。
 *
 * ## 为什么同时识别顶层 tool/call 与 PTC 嵌套调用
 * root 在 PTC 模式下只能直接调用 run_code，真实工具调用发生在 run_code 内部：宿主为它
 * 发布 tool/ptc-dispatch-start（开始）与 tool/ptc-dispatch（完成）两个事件，且**嵌套调用
 * 没有独立的 tool/result**——tool/result 只属于顶层 run_code 调用。只认 tool/call 会让
 * 嵌套的 dsh_expert_group_done 永远不可见，每个 turn 都被误判为未完成。
 *
 * PTC 事件没有 turn 字段：先用顶层 tool/call 建立 callId → turn 映射，再用
 * rootCallId / parentCallId 反查（parentCallId 指向上一个 subCallId，因此多层嵌套链可
 * 逐级解析）；都查不到时归属当前 turn——方向安全：只会让判定更保守地要求完成标记，
 * 不会误放行。
 *
 * ## 为什么有界（best-effort）
 * 同一个 root 的同一个 turn 最多提醒 MAX_CONTINUATIONS_PER_TURN（3）次（模块级 WeakMap
 * 计数）。turn 变化即重置。DSH 没有硬锁：提醒只是 best-effort 的纠偏，模型连续 3 次忽略
 * 后不再重复投递，避免把同一 turn 变成无限续接的死循环，也避免反复打断模型/用户节奏。
 *
 * ## 为什么 fail-open
 * turn-stopping 是 serial 且被宿主 await 的边界：监听器抛错会被 DSH 变成 turn 错误。
 * 本模块的判定全部是纯函数 / 只读事件投影（不写任何状态）；唯一的副作用（steer）由调用方
 * host/index-finalize.js 用 try/catch 包住并只记告警，异常绝不向宿主抛出。事件不可读
 * （非数组 / 非法 turn）时判定返回 false，绝不因此抛错。
 *
 * ## 为什么只针对 root
 * 本模块只被 root 的 turn-stopping 兜底调用。专家子代理的 turn 由 DSH 的 subagent 机制
 * 管理（结算、续作、取消都有自己的一套语义），插件不去替它们续接；dsh_expert_group_done
 * 本身也只允许 live root 调用。
 *
 * ## 为什么不碰等待账本
 * 续接提醒与 finalize/等待账本是**两条正交链路**：提醒只表达“本 turn 还没有完成标记”，
 * 不登记工作、不关闭批次、不投递收口结论、也不读改任何等待状态。等待路径已经 steer 过
 * 结算消息或收口结论时，调用方会跳过本提醒，避免同一 turn 里叠加两条续接消息。
 *
 * @module dsh-expert-group/host/turn-continuation-guard
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { PRODUCER_SOURCE_KIND } from "./plugin-identity.js";

/** root 专用完成标记的工具名（协议事实，提示词/工具定义/判定共用同一常量）。 */
export const DONE_TOOL_NAME = "dsh_expert_group_done";

/**
 * 同一 root 同一 turn 的续接提醒上限。
 *
 * DSH 没有“必须打标记才能结束”的硬锁，提醒只能是有界 best-effort：超过该次数说明模型
 * 连续忽略纠偏，继续投递只会造成无限续接；把上限固定在 3 次并显式登记，便于测试与运维
 * 观测（第 4 次起不再 steer）。
 */
export const MAX_CONTINUATIONS_PER_TURN = 3;

/**
 * 续接提醒的固定正文（模型可见，逐字稳定）。
 *
 * 只表达协议事实：本 turn 即将关闭，但没有以完成标记收尾。随后给出两个合法出口——没交付
 * 完就继续调用工具；已交付完就先补 dsh_expert_group_done 再给最终答复，且**不要重复上一次
 * 答复**（避免模型用一段重复文本充当“已标记”）。文案对纯文本 turn 与“最后调用不是 done”
 * 的 turn 同样成立，因此不区分是否调用过工具。
 */
const CONTINUATION_REMINDER_TEXT = "Turn not marked complete: this turn is about to close, but it did not end with a dsh_expert_group_done tool call. If the user's request is not fully delivered yet, continue now with the next tool call instead of describing what you will do next. If it is already fully delivered, call dsh_expert_group_done as the last tool call and then give the final answer — do not repeat the previous answer.";

/** 安全取值：只接受普通对象，其余值一律视为“形状非法”。 */
function asObject(value) {
  return value !== null && typeof value === "object" ? value : null;
}

/** 消息 content 数组；缺失或非数组时安全返回空数组。 */
function contentBlocks(message) {
  const content = asObject(message)?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * 判定某个 block 是否是一次工具调用。
 *
 * 真实形状是 tool-call；旧会话日志里可能是 tool_use，两者都算——续接判定只关心
 * “本 turn 的工具调用序列”这一协议事实，不区分日志版本。
 */
function isToolCallBlock(block) {
  const part = asObject(block);
  return part !== null && (part.type === "tool-call" || part.type === "tool_use");
}

/** 从 block 读取 callId：真实形状是 callId，旧形状也可能用 id。 */
function blockCallId(block) {
  const part = asObject(block);
  if (part === null) return undefined;
  if (typeof part.callId === "string" && part.callId.length > 0) return part.callId;
  if (typeof part.id === "string" && part.id.length > 0) return part.id;
  return undefined;
}

/** 读取非空字符串 id；其余值一律视为“缺失”。 */
function nonEmptyId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 解析 PTC 嵌套事件归属的 turn。
 *
 * PTC 事件本身没有 turn 字段，只能沿调用链反查：rootCallId → parentCallId → 当前 turn。
 * parentCallId 指向上一级 subCallId，而上一级在处理开始事件时已写入映射，因此多层嵌套可
 * 逐级解析。都查不到时归属当前 turn：这是**方向安全**的兜底——只会让判定更保守地要求
 * 完成标记，不会把别的 turn 的调用误算成已收尾。
 *
 * @param {object} data - PTC 事件 data。
 * @param {Map<string, number>} callTurnById - callId/subCallId → turn 映射。
 * @param {number} fallbackTurn - 当前判定的 turn。
 * @returns {number} 归属的 turn。
 */
function resolveNestedTurn(data, callTurnById, fallbackTurn) {
  const rootTurn = callTurnById.get(nonEmptyId(data.rootCallId));
  if (Number.isSafeInteger(rootTurn)) return rootTurn;
  const parentTurn = callTurnById.get(nonEmptyId(data.parentCallId));
  if (Number.isSafeInteger(parentTurn)) return parentTurn;
  return fallbackTurn;
}

/**
 * 按事件顺序收集该 turn 的**工具调用条目**（按 callId 去重、首次出现优先）。
 *
 * 条目来源（同一 callId 只保留第一条，后续事件只更新该条目的状态）：
 * - tool/call（data.turn === turn）→ 顶层调用，kind "top"；
 * - assistant 消息里的 tool-call block → 顶层调用的消息侧投影，kind "top"；
 * - tool/ptc-dispatch-start → run_code 内部的嵌套调用，kind "nested"、completed=false；
 * - tool/ptc-dispatch → 同一 subCallId 的完成事件，更新 completed/failed；残缺日志里只有
 *   完成事件时补一条已完成条目（仍按首次出现的事件位置排序）。
 *
 * 嵌套条目与顶层条目共用同一序列：判定只看“本 turn 最后一次调用是什么”。嵌套调用没有
 * 独立的 tool/result，因此它的成功与否由完成事件的结构化 isError 决定。
 *
 * 没有 callId 的条目用合成键入列（不做去重）：它的 name 可能是 null，从而让“最后一条”
 * 不再等于完成标记——这正是残缺调用必须被判为未完成的地方。
 *
 * @param {object[]} events - session 事件数组（顺序与 session 日志一致）。
 * @param {number} turn - 目标 turn 号。
 * @returns {{callId:string|null, name:string|null, kind:"top"|"nested",
 *   completed:boolean, failed:boolean}[]} 去重后的有序条目。
 */
function turnToolCallEntries(events, turn) {
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return [];
  const entries = [];
  const seenCallIds = new Set();
  const entryByCallId = new Map();
  const callTurnById = new Map();
  const pushEntry = (callId, name, kind) => {
    const key = nonEmptyId(callId) ?? null;
    // 有 callId 时按 callId 去重；没有 callId 的条目各自独立入列。
    if (key !== null) {
      if (seenCallIds.has(key)) return entryByCallId.get(key);
      seenCallIds.add(key);
    }
    const entry = {
      callId: key,
      name: typeof name === "string" ? name : null,
      kind,
      // 顶层调用的成功由 tool/result 核对；嵌套调用由 PTC 完成事件核对。
      completed: kind === "top",
      failed: false,
    };
    entries.push(entry);
    if (key !== null) entryByCallId.set(key, entry);
    return entry;
  };
  for (const event of events) {
    const item = asObject(event);
    if (item === null) continue;
    if (item.type === "tool/call") {
      const data = asObject(item.data);
      if (data === null) continue;
      const callId = nonEmptyId(data.callId);
      // 先登记映射：后续 PTC 事件可能以它为 rootCallId / parentCallId。
      if (callId !== undefined && Number.isSafeInteger(data.turn)) callTurnById.set(callId, data.turn);
      if (data.turn !== turn) continue;
      pushEntry(callId, data.name, "top");
      continue;
    }
    if (item.type === "tool/ptc-dispatch-start") {
      const data = asObject(item.data);
      if (data === null) continue;
      const subCallId = nonEmptyId(data.subCallId);
      const nestedTurn = resolveNestedTurn(data, callTurnById, turn);
      if (subCallId !== undefined) callTurnById.set(subCallId, nestedTurn);
      if (nestedTurn !== turn) continue;
      pushEntry(subCallId, data.name, "nested");
      continue;
    }
    if (item.type === "tool/ptc-dispatch") {
      const data = asObject(item.data);
      if (data === null) continue;
      const subCallId = nonEmptyId(data.subCallId);
      const knownTurn = subCallId === undefined ? undefined : callTurnById.get(subCallId);
      const nestedTurn = Number.isSafeInteger(knownTurn) ? knownTurn : resolveNestedTurn(data, callTurnById, turn);
      if (subCallId !== undefined) callTurnById.set(subCallId, nestedTurn);
      if (nestedTurn !== turn) continue;
      const failed = data.isError === true;
      const existing = subCallId === undefined ? undefined : entryByCallId.get(subCallId);
      if (existing !== undefined) {
        existing.completed = true;
        existing.failed = failed;
        continue;
      }
      // 残缺日志：只有完成事件 → 补一条已完成的嵌套条目（沿用当前位置排序）。
      const entry = pushEntry(subCallId, data.name, "nested");
      if (entry !== undefined) {
        entry.completed = true;
        entry.failed = failed;
      }
      continue;
    }
    if (item.type !== "assistant/message") continue;
    const data = asObject(item.data);
    if (data === null || data.turn !== turn) continue;
    for (const block of contentBlocks(asObject(data.message))) {
      if (!isToolCallBlock(block)) continue;
      const part = asObject(block);
      if (part === null) continue;
      pushEntry(blockCallId(part), part.name, "top");
    }
  }
  return entries;
}

/**
 * 该 turn 是否存在某个 callId 的**成功** tool/result。
 *
 * 事件形状：{type:"tool/result", data:{turn, step, message:{role:"tool", toolCallId, isError?, content}}}；
 * 兼容结果 id 直接挂在 data.toolCallId 上的形状。
 *
 * 失败判定只看结构化字段：message.isError === true 或 data.error 非空 → 该结果不算成功
 * （继续扫描；找不到成功结果即视为未完成）。缺失这些字段的旧日志按成功处理。刻意**不**
 * 解析 content 正文：正文既可能提到错误、也可能被截断，不能当协议凭据。
 *
 * 匹配规则保守：data.turn 缺失或不是安全整数时接受（旧日志可能不写 turn），但它明确属于
 * 另一个 turn 时跳过，避免把别的 turn 的结果当成这次 done 的成功凭据。
 *
 * @param {object[]} events - session 事件数组。
 * @param {number} turn - 目标 turn 号。
 * @param {string} callId - 待匹配的调用 id。
 * @returns {boolean} 是否存在明确的成功结果。
 */
function hasToolResult(events, turn, callId) {
  if (!Array.isArray(events) || typeof callId !== "string" || callId.length === 0) return false;
  for (const event of events) {
    const item = asObject(event);
    if (item === null || item.type !== "tool/result") continue;
    const data = asObject(item.data);
    if (data === null) continue;
    if (Number.isSafeInteger(data.turn) && data.turn !== turn) continue;
    const message = asObject(data.message);
    if (data.toolCallId !== callId && message?.toolCallId !== callId) continue;
    // 结构化失败字段：任一明确失败都不算成功；缺失按成功处理（旧日志）。
    if (message?.isError === true) continue;
    if (data.error != null) continue;
    return true;
  }
  return false;
}

/**
 * 本 turn 是否**按协议收尾**：至少有一条工具调用，且最后一条是完成标记（并且它真的成功）。
 *
 * 判定（任何一步不满足都返回 false，fail-closed 到“继续”）：
 * 1. 工具调用条目为空 → false（没有完成标记）；
 * 2. 最后一条条目的 name 严格等于 dsh_expert_group_done；
 * 3. 该条目必须有非空 callId：只有消息侧投影（assistant block）的 done 无法核对结果，
 *    不能关闭 turn；
 * 4. 顶层调用（kind "top"）必须找到该 callId 的**成功** tool/result；结果缺失、isError
 *    或 data.error 都按未完成；
 * 5. 嵌套调用（kind "nested"）必须已完成（收到 tool/ptc-dispatch）且 isError !== true——
 *    嵌套调用没有独立 tool/result，完成事件就是它唯一的成功凭据。
 *
 * 因此「done 之后又调用了别的工具」「done 之后出现缺名调用」「done 没有结果」
 * 「done 结果失败」「只有消息侧 block 的 done」「嵌套 done 未完成/失败」都不算收尾。
 *
 * @param {object[]} events - session 事件数组。
 * @param {number} turn - 目标 turn 号。
 * @returns {boolean} 是否以完成标记收尾。
 */
export function turnClosedWithDone(events, turn) {
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return false;
  const entries = turnToolCallEntries(events, turn);
  if (entries.length === 0) return false;
  const last = entries[entries.length - 1];
  if (last?.name !== DONE_TOOL_NAME) return false;
  // 只有 assistant 消息侧投影（没有 callId）无法核对调用是否真的发生并成功 → fail-closed。
  if (typeof last.callId !== "string" || last.callId.length === 0) return false;
  // 嵌套调用没有独立 tool/result：成功与否只看 PTC 完成事件的结构化字段。
  if (last.kind === "nested") return last.completed === true && last.failed !== true;
  return hasToolResult(events, turn, last.callId);
}

/**
 * 本 turn 是否需要一次续接提醒（纯函数，只读事件）。
 *
 * 判定：不是「以完成标记收尾」就提醒——**不再豁免“本 turn 没有工具调用”的纯文本 turn**，
 * 因为协议要求每个 turn 都以 dsh_expert_group_done 结束。
 *
 * 非数组 events / 非法 turn 返回 false：事件日志不可读时无法判定，提醒只会变成噪音；
 * 这是本模块统一的 fail-open 边界。
 *
 * @param {object[]} events - session 事件数组。
 * @param {number} turn - 目标 turn 号。
 * @returns {boolean} 是否需要续接提醒。
 */
export function needsContinuation(events, turn) {
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return false;
  return turnClosedWithDone(events, turn) !== true;
}

/**
 * 续接提醒的**可测决策**：把「是否提醒」从副作用里拆成纯函数。
 *
 * 线上出现过「turn 关闭时没有提醒、也没有任何日志」的静默短路：判定散落在接线层的一串
 * early-return 里，跳过时不可观测。这里按固定顺序短路并返回稳定 reason 码，接线层只负责
 * 收集事实 + 记录 reason，因此每次跳过都能在日志里定位。
 *
 * 顺序（先排除、后命中）：
 * turn-invalid → turn-aborted → wait-stopping → root-not-live → batch-abandoned →
 * already-complete → nudge-exhausted → no-steer → nudge。
 *
 * force === true 只绕过 already-complete（“本 turn 已打完成标记”）：用于「turn 关闭时
 * DEG 仍有在跑/未收的专家」这一兜底——此时即使模型已经打标，也要继续纠偏。其余生命周期、
 * 取消与次数约束不受 force 影响（卸载/退休/取消/耗尽时依旧不提醒）。
 *
 * @param {object} input - 已算好的事实。
 * @param {number|null} input.turn - 目标 turn（非安全整数 → turn-invalid）。
 * @param {boolean} [input.aborted] - turn 的 signal 已取消。
 * @param {boolean} [input.waitStopping] - 插件卸载闩已生效。
 * @param {boolean} [input.liveRoot] - 是否仍是当前 live root。
 * @param {boolean} [input.abandoned] - admission 批次已被人工逃生关闭。
 * @param {boolean} [input.closed] - 本 turn 已按协议打完成标记。
 * @param {boolean} [input.exhausted] - 本 turn 的提醒次数已用尽。
 * @param {boolean} [input.hasSteer] - root 是否提供公开 steer。
 * @param {boolean} [input.force] - 是否因「DEG 仍有未收工作」而绕过 already-complete。
 * @returns {{nudge:boolean, reason:string}} 决策与稳定原因码。
 */
export function evaluateContinuation(input) {
  const facts = input !== null && typeof input === "object" ? input : {};
  if (!Number.isSafeInteger(facts.turn)) return { nudge: false, reason: "turn-invalid" };
  if (facts.aborted === true) return { nudge: false, reason: "turn-aborted" };
  if (facts.waitStopping === true) return { nudge: false, reason: "wait-stopping" };
  if (facts.liveRoot !== true) return { nudge: false, reason: "root-not-live" };
  if (facts.abandoned === true) return { nudge: false, reason: "batch-abandoned" };
  // force 只在这里生效：其余约束（取消/卸载/退休/人工逃生/次数）都必须继续生效。
  if (facts.closed === true && facts.force !== true) return { nudge: false, reason: "already-complete" };
  if (facts.exhausted === true) return { nudge: false, reason: "nudge-exhausted" };
  if (facts.hasSteer !== true) return { nudge: false, reason: "no-steer" };
  return { nudge: true, reason: "nudge" };
}

/**
 * 解析本次续接判定使用的 turn。
 *
 * payload.turn 是宿主在 turn-stopping 载荷里给出的权威值；但线上存在载荷缺 turn 的日志，
 * 此时从会话事件里推导：最后一条 assistant/message 的 data.turn，再退到最后一次
 * turn/start 的 data.turn。都推不出来返回 null（由 evaluateContinuation 判 turn-invalid，
 * 并在日志里留下 reason，而不是静默跳过）。
 *
 * @param {object[]} events - session 事件数组。
 * @param {unknown} payloadTurn - turn-stopping 载荷里的 turn。
 * @returns {number|null} 解析出的 turn；无法解析时 null。
 */
export function resolveTurnForContinuation(events, payloadTurn) {
  if (Number.isSafeInteger(payloadTurn)) return payloadTurn;
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = asObject(events[index]);
    if (item === null || item.type !== "assistant/message") continue;
    const turn = asObject(item.data)?.turn;
    if (Number.isSafeInteger(turn)) return turn;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = asObject(events[index]);
    if (item === null || item.type !== "turn/start") continue;
    const turn = asObject(item.data)?.turn;
    if (Number.isSafeInteger(turn)) return turn;
  }
  return null;
}

/**
 * 最近一次续接决策的内存诊断（环形缓冲）。
 *
 * 为什么需要它：续接保护跳过时只写进程日志（stdout），会话 JSONL 里看不到；线上排查
 * 「turn 关闭却没有提醒」时因此缺少观测面。这里把**每次**决策（含 reason 码）留在内存里，
 * 经运行时诊断 RPC 暴露给侧栏。
 *
 * 边界（只读诊断，不是业务状态）：
 * - 进程内存：重启即清空，不持久化、不参与任何判定；
 * - 固定上限 CONTINUATION_DIAGNOSTIC_LIMIT 条，按时间倒序，报告大小不随历史增长；
 * - 内容只有 reason 码 / turn / nudge / 时间戳：**不含用户文本、路径、prompt 或异常正文**。
 */
const CONTINUATION_DIAGNOSTIC_LIMIT = 20;
const continuationDiagnostics = { total: 0, nudged: 0, skipped: 0, recent: [] };

/**
 * 记录一次续接决策（供运行时诊断读取）。
 *
 * 归一规则：turn 只接受安全整数（其余记为 null）；reason 只接受非空字符串（其余记为
 * "unknown"）；nudge 只有严格 true 才算提醒；at 非有限数字时用当前时间。
 *
 * @param {object} decision - { turn, reason, nudge, at }。
 */
export function recordContinuationDecision(decision) {
  const facts = asObject(decision) ?? {};
  const turn = Number.isSafeInteger(facts.turn) ? facts.turn : null;
  const reason = typeof facts.reason === "string" && facts.reason.length > 0 ? facts.reason : "unknown";
  const nudge = facts.nudge === true;
  const at = Number.isFinite(facts.at) ? facts.at : Date.now();
  continuationDiagnostics.total += 1;
  if (nudge) continuationDiagnostics.nudged += 1;
  else continuationDiagnostics.skipped += 1;
  continuationDiagnostics.recent.unshift({ turn, reason, nudge, at });
  if (continuationDiagnostics.recent.length > CONTINUATION_DIAGNOSTIC_LIMIT) {
    continuationDiagnostics.recent.length = CONTINUATION_DIAGNOSTIC_LIMIT;
  }
}

/**
 * 只读快照：最近一次续接决策 + 计数 + 有界历史（时间倒序）。
 *
 * 返回的是拷贝，调用方无法改写内部缓冲；last 在从未记录时为 null。
 *
 * @returns {{version:number, total:number, nudged:number, skipped:number,
 *   last:object|null, recent:object[]}} 诊断载荷。
 */
export function describeContinuationDiagnostics() {
  const recent = continuationDiagnostics.recent.map((entry) => ({ ...entry }));
  return {
    version: 1,
    total: continuationDiagnostics.total,
    nudged: continuationDiagnostics.nudged,
    skipped: continuationDiagnostics.skipped,
    last: recent.length === 0 ? null : recent[0],
    recent,
  };
}

/**
 * 清空诊断缓冲（仅测试用；生产路径不会调用）。
 */
export function resetContinuationDiagnostics() {
  continuationDiagnostics.total = 0;
  continuationDiagnostics.nudged = 0;
  continuationDiagnostics.skipped = 0;
  continuationDiagnostics.recent.length = 0;
}

/**
 * 每个 root 的提醒登记簿：WeakMap<Agent, {turn, count}>。
 *
 * 用 WeakMap 而不是 Map：root 退休/被回收时登记自然消失，不需要显式清理，也不会
 * 让插件持有 Agent 的强引用。turn 变化即视为重置（见 canNudgeTurn）。
 */
const nudgeState = new WeakMap();

/** 只接受可作 WeakMap 键的对象/函数，其余值一律安全地当作“不可跟踪”。 */
function isTrackable(agent) {
  return (typeof agent === "object" && agent !== null) || typeof agent === "function";
}

/**
 * 本 turn 是否还可以提醒。
 *
 * 同一 root 同一 turn 最多 MAX_CONTINUATIONS_PER_TURN 次；turn 变化即重置。非对象 agent /
 * 非安全整数 turn 返回 false（调用方据此跳过，绝不抛错）。
 */
export function canNudgeTurn(agent, turn) {
  if (!isTrackable(agent) || !Number.isSafeInteger(turn)) return false;
  const record = nudgeState.get(agent);
  if (record === undefined || record.turn !== turn) return true;
  return record.count < MAX_CONTINUATIONS_PER_TURN;
}

/**
 * 登记「本 turn 又提醒了一次」（计数自增）。
 *
 * 调用方必须在 steer **之前**调用：即使 steer 抛错，本次也计入上限，避免同一边界反复重试。
 * 非对象 agent / 非安全整数 turn 返回 false，不写任何状态。
 */
export function markTurnNudged(agent, turn) {
  if (!isTrackable(agent) || !Number.isSafeInteger(turn)) return false;
  const record = nudgeState.get(agent);
  const count = record !== undefined && record.turn === turn ? record.count + 1 : 1;
  nudgeState.set(agent, { turn, count });
  return true;
}

/**
 * 构造一条 DEG 生产者自有的续接提醒消息。
 *
 * source.kind 与收口结论同一来源（PRODUCER_SOURCE_KIND），因此通过宿主的 V4 会话写入边界，
 * 也不会被误认成“用户输入”或“child settlement”。
 */
export function buildContinuationReminder() {
  return createUserMessage({
    content: [{ type: "text", text: CONTINUATION_REMINDER_TEXT }],
    source: { kind: PRODUCER_SOURCE_KIND },
  });
}
