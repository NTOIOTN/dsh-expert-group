/**
 * root turn 续接保护（turn continuation guard）。
 *
 * ## 为什么需要它
 * 线上会话日志里 root 多次在任务中途只输出一段「下一步动作宣言」（例如“我去验证。”），
 * 这一步没有任何工具调用；DSH 随即以该消息结束 turn（turn/end completed），用户必须
 * 手动输入“继续”。提示词层的 Turn discipline 已经加载，但模型仍会这样收尾，因此在
 * 插件**自己的** `agent/turn-stopping` 边界再兜一层：当本 turn 明显处在“准备继续干活”
 * 的中途停顿时，用 `parent.steer(createUserMessage(...))` 往 next-step inbox 投递一条
 * 固定提醒；宿主重读 inbox 后会在同一 turn 继续一个 step，而不是把 turn 关掉。
 *
 * ## 为什么有界
 * 同一个 root 的同一个 turn 最多提醒一次（模块级 WeakMap）。turn 变化即重置；一旦提醒过，
 * 即使后续 step 仍只写文本也不再重复投递——避免与模型形成“无限续接”的死循环，也避免
 * 在同一 turn 里反复打断模型或用户的正常节奏。
 *
 * ## 为什么 fail-open
 * turn-stopping 是 serial 且被宿主 await 的边界：监听器抛错会被 DSH 变成 turn 错误。
 * 本模块的判定全部是纯函数 / 只读事件投影（不写任何状态）；唯一的副作用（steer）由调用方
 * host/index-finalize.js 用 try/catch 包住并只记告警，异常绝不向宿主抛出。
 *
 * ## 为什么只针对 root
 * 本模块只被 root 的 turn-stopping 兜底调用。专家子代理的 turn 由 DSH 的 subagent 机制
 * 管理（结算、续作、取消都有自己的一套语义），插件不去替它们续接。
 *
 * ## 为什么不碰等待账本
 * 续接提醒与 finalize/等待账本是**两条正交链路**：提醒只表达“这一步看起来还没说完”，
 * 不登记工作、不关闭批次、不投递收口结论、也不读改任何等待状态。等待路径已经 steer 过
 * 结算消息或收口结论时，调用方会跳过本提醒，避免同一 turn 里叠加两条续接消息。
 *
 * @module dsh-expert-group/host/turn-continuation-guard
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { PRODUCER_SOURCE_KIND } from "./plugin-identity.js";

/**
 * 续接提醒的固定正文（模型可见，逐字稳定）。
 *
 * 三段结构：解释为什么被提醒（上一条消息没有工具调用、turn 即将关闭）→ 要求继续调用工具、
 * 不要只描述下一步 → 给出两个合法收尾出口（真的交付完 / 正阻塞在用户输入）。
 *
 * 刻意**不**要求模型回复固定标记（旧版要求 “reply with exactly: DONE”）：那会诱导模型
 * 在未完成时也回一个 DONE 来规避提醒，也会污染正常交付文本。
 */
const CONTINUATION_REMINDER_TEXT = "Turn continuation guard: your previous message contained no tool call, so this turn was about to close. If the user's request is not fully delivered yet, continue now with the next tool call instead of describing what you will do next; if it is already fully delivered, give a brief confirmation instead of repeating the answer; if it is blocked on the user, state what you need.";

/**
 * 完成声明：出现在该 turn 最后一条 assistant 文本里就表示这一步是交付，不是中途停顿。
 *
 * 覆盖中英文常见收尾（已完成 / 已实现 / 已修复 / 已交付 / 已通过 / 全部通过 / 全绿 /
 * 测试通过 / 搞定 / 改好 / 改完 / 完成以上 / 全部完成 / 交付完成 / All done），大小写不敏感。
 *
 * 刻意**不**接受裸的 “done”：它常出现在英文普通句子里（如 “well done, but I will check
 * the logs”），把它当完成声明会吞掉真正的续接意图；只有 “all done” 这种明确收尾才算。
 */
const COMPLETION_PATTERN = /(已完成|已实现|已修复|已交付|已通过|全部通过|全绿|测试通过|搞定|改好|改完|完成以上|全部完成|交付完成|all done)/i;

/**
 * 「下一步动作承诺」只按**句子末尾**判定，不做全文子串匹配。
 *
 * 为什么改成末句：全文子串会把正常陈述误判成交接意图——例如「我看这个方案可行。」里
 * 的 “我看” 只是观点表达，并不是“接下来去查看”。因此先切出最后一句话，再用三个中文
 * 互补分支 + 英文分支判定（任一命中即 continuation-intent）：
 *
 * 分支 A（动作词贴近句末）：我/让我 + ≤30 字 + 动作动词 + 极短语气补语
 * （一下 / 一遍 / 再 / 就 …）结尾。尾部范围的取舍有实测依据：
 * 1. oracle 给出的 0..6 字上界无法排除它自己指定的反例「我看这个方案可行。」——
 *    “这个方案可行”正好 6 字，会命中；收窄到 ≤4 才能过该反例；
 * 2. 但 ≤4 仍会误伤「这个实现我看没问题。」（“没问题”3 字）。因此最终改为
 *    **语气补语白名单**：动词之后只允许“一下/一遍/一眼/下/来/先/再/就”，
 *    陈述性尾巴（没问题 / 可行 / 这个方案可行）一律不命中。
 *
 * 分支 B（明确动作前缀 + 有限宾语）：只接受“我去/我会/我来/我先/让我”这类第一人称
 * **明确动作前缀**，动作词之后允许一个有限宾语（≤12 字），覆盖「我去检查日志」
 * 「我先看一下结果」「我去查文档」「我来确认结果」「我会检查日志」。
 * 宾语不允许出现分句标点（：:，,），因为那是“解释/结论”的形态：
 * 「让我确认：这个方案可行」必须继续保持不命中。分支 B 刻意不接受裸「我看」——
 * 「我看这个方案可行」只是评价，不是动作承诺。
 *
 * 分支 C（逗号衔接的后续动作）：只接受「明确动作前缀 + 动作词 + 逗号 + 连接词
 * （然后/再/随后/接着/必要时/之后/并）+ 后续动作动词」，覆盖「我去检查日志，然后修」
 * 「我先看一下结果，再决定」这类“先做一步、再做一步”的承诺。
 * 它刻意**不是**任意逗号宾语的通道：逗号后必须紧跟上述连接词，且后续动作必须是动作
 * 动词；「我去查文档，确认后回复」不命中（连接词白名单不含“确认”），冒号结论
 * 「让我确认：这个方案可行」也继续不命中。
 *
 * 英文：I'll / I will / Let me + 动作动词 + ≤20 字宾语结尾；“well done, but I will
 * check the logs.” 命中末句动作承诺，优先于完成声明。
 */
const LAST_SENTENCE_ACTION_PATTERN = /(?:我|让我)[^。！？\n]{0,30}(?:看|读|查|确认|验证|核对|检查|跑|试|复现|抓|取|定位)(?:一下|一遍|一眼|下|来|先|再|就)?$/;
const LAST_SENTENCE_OBJECT_ACTION_PATTERN = /(?:我(?:去|会|来|先)|让我)[^。！？\n]{0,24}(?:看|读|查|确认|验证|核对|检查|跑|试|复现|抓|取|定位)[^。！？\n：:，,]{0,12}$/;
const LAST_SENTENCE_COMMA_CHAIN_PATTERN = /(?:我(?:去|会|来|先)|让我)[^。！？\n]{0,24}(?:看|读|查|确认|验证|核对|检查|跑|试|复现|抓|取|定位)[^。！？\n]{0,16}[，,]\s*(?:然后|再|随后|接着|必要时|之后|并)[^。！？\n：:]{0,24}(?:修|改|写|补|做|处理|决定|验证|确认|检查|跑|试|复现|分析|定位|继续|推进|实现)[^。！？\n]{0,6}$/;
const LAST_SENTENCE_ACTION_PATTERN_EN = /\b(?:I(?:'ll| will)|Let me)\s+(?:now\s+)?(?:check|look|read|run|verify|test|inspect|open|search|continue)\b[^.!?\n]{0,20}$/i;

/** 意图判定的文本上限：超过它的通常是交付总结，不做续接提醒。 */
const MAX_INTENT_TEXT_LENGTH = 1200;

/**
 * 取文本最后一个非空句子。
 *
 * 按中文句末标点、ASCII 的 !/? 与换行切分；ASCII 句点 “.” 不作为切分符（英文里它常与
 * 缩写/小数混用），但在末尾统一剥掉，保证末句以内容结尾、便于用 `$` 锚定动作动词。
 */
function lastSentenceOf(text) {
  const sentences = text.split(/[。！？!?\n]+/);
  for (let index = sentences.length - 1; index >= 0; index -= 1) {
    const sentence = sentences[index].trim().replace(/[.!?]+$/, "").trim();
    if (sentence.length > 0) return sentence;
  }
  return "";
}

/**
 * 每个 root 的提醒登记簿：`WeakMap<Agent, {turn, nudged}>`。
 *
 * 用 WeakMap 而不是 Map：root 退休/被回收时登记自然消失，不需要显式清理，也不会
 * 让插件持有 Agent 的强引用。turn 变化即视为重置（见 canNudgeTurn）。
 */
const nudgeState = new WeakMap();

/** 只接受可作 WeakMap 键的对象/函数，其余值一律安全地当作“不可跟踪”。 */
function isTrackable(agent) {
  return (typeof agent === "object" && agent !== null) || typeof agent === "function";
}

function asObject(value) {
  return value !== null && typeof value === "object" ? value : null;
}

/** 消息 content 数组；缺失或非数组时安全返回空数组。 */
function contentBlocks(message) {
  const content = asObject(message)?.content;
  return Array.isArray(content) ? content : [];
}

/** 该消息是否携带工具调用 block（真实形状 `tool-call`，兼容旧形状 `tool_use`）。 */
function hasToolCallBlock(message) {
  return contentBlocks(message).some((block) => {
    const part = asObject(block);
    return part !== null && (part.type === "tool-call" || part.type === "tool_use");
  });
}

/** 拼接全部 text block 并 trim；reasoning / 图片等 block 不参与判定。 */
function messageText(message) {
  return contentBlocks(message)
    .map((block) => {
      if (typeof block === "string") return block;
      const part = asObject(block);
      return part !== null && part.type === "text" && typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();
}

/** 该 turn 里是否存在任何工具调用（`tool/call` 事件或 assistant 消息里的 tool-call block）。 */
function turnHasToolCall(events, turn) {
  for (const event of events) {
    if (event?.type === "tool/call" && event.data?.turn === turn) return true;
    if (event?.type === "assistant/message" && event.data?.turn === turn
      && hasToolCallBlock(event.data?.message)) return true;
  }
  return false;
}

/**
 * 取某个 turn 最后一条 `assistant/message`。
 *
 * 真实事件形状：`{ type: "assistant/message", data: { turn, step, message: { content } } }`。
 * 同一 turn 可能有多个 step，因此必须**从后往前**取最后一条；找不到时返回 null。
 */
export function lastAssistantMessageOfTurn(events, turn) {
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const data = asObject(event.data);
    if (data === null || data.turn !== turn) continue;
    return asObject(data.message);
  }
  return null;
}

/**
 * 判定本轮 turn 是否需要一次续接提醒（纯函数，只读事件）。
 *
 * 判定顺序（先排除、后命中，宁可漏报也不误报）：
 * 1. 该 turn 没有 assistant/message → null（日志尚未提交，不干预）；
 * 2. 最后一条消息含 tool-call → null（这一步本来就会继续）；
 * 3. 该 turn 完全没有工具调用 → null（纯问答 turn，不干预）；
 * 4. 文本长度 ≤1200 且**末句**是下一步动作承诺 → `continuation-intent`
 *    （即使正文前面有完成词，例如「代码已修复，我去验证。」也必须命中）；
 * 5. 否则文本命中完成声明 → null（这是交付，不是停顿）；
 * 6. 文本为空（只有 reasoning，典型是流被截断）→ `empty-assistant-message`；
 * 7. 其余 → null。
 *
 * 为什么“末句动作承诺”排在完成声明之前：模型常在交付句后面追加一句“我再去验证一下”，
 * 若完成词优先就会把真实的续作意图吞掉；反过来，没有动作承诺的完成声明仍然是交付。
 *
 * @param {object[]} events - session 事件数组（顺序与 session 日志一致）。
 * @param {number} turn - 当前 turn 号（必须是安全整数）。
 * @returns {{reason:string}|null} 命中时返回 reason，否则 null。
 */
export function continuationHintOf(events, turn) {
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return null;
  const message = lastAssistantMessageOfTurn(events, turn);
  if (message === null) return null;
  if (hasToolCallBlock(message)) return null;
  if (!turnHasToolCall(events, turn)) return null;
  const text = messageText(message);
  const lastSentence = lastSentenceOf(text);
  if (lastSentence.length > 0
    && text.length <= MAX_INTENT_TEXT_LENGTH
    && (LAST_SENTENCE_ACTION_PATTERN.test(lastSentence)
      || LAST_SENTENCE_OBJECT_ACTION_PATTERN.test(lastSentence)
      || LAST_SENTENCE_COMMA_CHAIN_PATTERN.test(lastSentence)
      || LAST_SENTENCE_ACTION_PATTERN_EN.test(lastSentence))) {
    return { reason: "continuation-intent" };
  }
  if (COMPLETION_PATTERN.test(text)) return null;
  if (text.length === 0) return { reason: "empty-assistant-message" };
  return null;
}

/**
 * 本 turn 是否还可以提醒。
 *
 * 同一 root 同一 turn 最多一次；turn 变化即重置。非对象 agent / 非安全整数 turn 返回 false
 * （调用方据此跳过，绝不抛错）。
 */
export function canNudgeTurn(agent, turn) {
  if (!isTrackable(agent) || !Number.isSafeInteger(turn)) return false;
  const record = nudgeState.get(agent);
  if (record === undefined) return true;
  if (record.turn !== turn) return true;
  return record.nudged !== true;
}

/**
 * 登记「本 turn 已提醒」。
 *
 * 调用方必须在 steer **之前**调用：即使 steer 抛错，同一 turn 也不会二次投递。
 * 非对象 agent / 非安全整数 turn 返回 false，不写任何状态。
 */
export function markTurnNudged(agent, turn) {
  if (!isTrackable(agent) || !Number.isSafeInteger(turn)) return false;
  nudgeState.set(agent, { turn, nudged: true });
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
