/**
 * root turn 续接保护（turn continuation guard）回归测试。
 *
 * 背景：线上日志里 root 多次在任务中途只输出一段「下一步动作宣言」（例如“我去验证。”），
 * 该 step 没有任何工具调用，DSH 随即以该消息结束 turn，用户只能手动输入“继续”。
 * 本文件锁定两件事：
 * 1. `host/turn-continuation-guard.js` 的纯函数判定矩阵（命中 / 不命中 / 有界 / 空文本）；
 * 2. 接线后的公开行为：root 的 `agent/turn-stopping` 边界会**有界地** steer 一条 DEG
 *    来源的提醒；同一 turn 只投递一次，turn 变化后允许再次提醒，且任何异常都不向宿主抛出。
 *
 * 测试 seam 全部是公开面：真实 apply 的受控 Host、root session 事件日志、宿主
 * `Agent.steer` 记录（`host.agentSteerMessages`）。不读取任何插件私有状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginHost } from "../test-support/plugin-host.mjs";
import {
  buildContinuationReminder,
  canNudgeTurn,
  continuationHintOf,
  lastAssistantMessageOfTurn,
  markTurnNudged,
} from "../host/turn-continuation-guard.js";

const ROOT_ID = "root-continuation-guard";
/** 与插件内固定文案逐字一致（模型可见契约，改动必须同步本断言）。 */
const REMINDER_TEXT = "Turn continuation guard: your previous message contained no tool call, so this turn was about to close. If the user's request is not fully delivered yet, continue now with the next tool call instead of describing what you will do next; if it is already fully delivered, give a brief confirmation instead of repeating the answer; if it is blocked on the user, state what you need.";

/** 真实形状的 tool/call 事件（SessionEventMap 声明 turn/step/callId/name/arguments 在 data 上）。 */
function toolCallEvent(turn) {
  return { type: "tool/call", data: { turn, step: 1, callId: "call-" + turn, name: "read", arguments: {} } };
}

/**
 * 构造某个 turn 的事件日志：turn/start + user/message +（可选）tool/call + assistant/message。
 *
 * @param {object} [options]
 * @param {number} [options.turn] 该日志所属 turn。
 * @param {string} [options.text] assistant 文本；空串表示只有 reasoning / 流被截断。
 * @param {boolean} [options.toolCall] 该 turn 是否发生过工具调用（决定“纯问答 turn”分支）。
 * @param {object[]} [options.blocks] 追加到 assistant content 的额外 block（如 tool-call）。
 */
function buildTurnEvents({ turn = 1, text = "", toolCall = true, blocks = [] } = {}) {
  return [
    { type: "turn/start", data: { turn } },
    {
      type: "user/message",
      data: { id: "u-" + turn, role: "user", content: [{ type: "text", text: "任务" }], source: { kind: "user" } },
    },
    ...(toolCall ? [toolCallEvent(turn)] : []),
    {
      type: "assistant/message",
      data: { turn, step: 2, message: { content: [{ type: "text", text }, ...blocks] } },
    },
  ];
}

// ── 1. 纯函数判定矩阵 ────────────────────────────────────────────────────────

test("三条实测停顿文本在发生过工具调用的 turn 里判定为 continuation-intent", () => {
  const samples = [
    "我已经看过上下文了，我看子代理会话日志确认。",
    "实现路径已经清楚，我去验证。",
    "结果看起来对，我确认一下。",
  ];
  for (const text of samples) {
    const hint = continuationHintOf(buildTurnEvents({ text }), 1);
    assert.deepEqual(hint, { reason: "continuation-intent" }, text);
  }
});

test("明确动作前缀 + 有限宾语也必须命中（中文第二分支）", () => {
  for (const text of [
    "我去检查日志。",
    "我先看一下结果。",
    "我去查文档。",
    "我来确认结果。",
    "我会检查日志。",
    "我去检查一下测试日志。",
  ]) {
    assert.deepEqual(continuationHintOf(buildTurnEvents({ text }), 1), { reason: "continuation-intent" }, text);
  }
});

test("逗号衔接的后续动作也必须命中（中文第三分支）", () => {
  for (const text of [
    "我去检查日志，然后修。",
    "我去检查日志，然后修复问题。",
    "我先看一下结果，再决定。",
    "我会检查日志，必要时修复。",
  ]) {
    assert.deepEqual(continuationHintOf(buildTurnEvents({ text }), 1), { reason: "continuation-intent" }, text);
  }
});

test("长交付文本与含完成声明的文本都不提醒", () => {
  // 超过 1200 字符：通常是交付总结，不做续接提醒。
  const long = "交付总结。" + "细节。".repeat(500);
  assert.ok(long.length > 1200);
  assert.equal(continuationHintOf(buildTurnEvents({ text: long }), 1), null);
  // 短文本但命中完成声明：这是交付，不是中途停顿。
  for (const text of ["已完成，2216 项测试通过。", "全部通过，全绿。", "全部完成。", "交付完成。", "All done."]) {
    assert.equal(continuationHintOf(buildTurnEvents({ text }), 1), null, text);
  }
});

test("末句动作承诺优先于完成声明：交付句后面追加的「我去验证」仍然命中", () => {
  assert.deepEqual(
    continuationHintOf(buildTurnEvents({ text: "代码已修复，我去验证。" }), 1),
    { reason: "continuation-intent" },
  );
  // 英文同理：完成词（well done）不得吞掉末句的核对意图。
  assert.deepEqual(
    continuationHintOf(buildTurnEvents({ text: "well done, but I will check the logs." }), 1),
    { reason: "continuation-intent" },
  );
});

test("末句动作承诺不误伤正常陈述/结论", () => {
  for (const text of [
    "我看这个方案可行。",
    "我先给结论：方案A可行。",
    "让我确认：这个方案可行。",
    "这个实现我看没问题。",
    "Logs look clean, I will not touch them.",
  ]) {
    assert.equal(continuationHintOf(buildTurnEvents({ text }), 1), null, text);
  }
});

test("没有工具调用的纯问答 turn 不提醒", () => {
  const events = buildTurnEvents({ text: "我去验证。", toolCall: false });
  assert.equal(continuationHintOf(events, 1), null);
});

test("最后一条 assistant 消息自带 tool-call 时不提醒（这一步本来就会继续）", () => {
  const events = buildTurnEvents({ text: "", turn: 3, blocks: [{ type: "tool-call", name: "read", arguments: {} }] });
  assert.equal(continuationHintOf(events, 3), null);
});

test("只有 reasoning、没有 text 的最后一条消息给出 empty-assistant-message", () => {
  const events = buildTurnEvents({ text: "" });
  assert.deepEqual(continuationHintOf(events, 1), { reason: "empty-assistant-message" });
});

test("turn 号必须精确匹配：别的 turn 的 assistant 消息不参与判定", () => {
  const events = buildTurnEvents({ text: "我去验证。", turn: 2 });
  assert.equal(lastAssistantMessageOfTurn(events, 1), null);
  assert.equal(continuationHintOf(events, 1), null);
  assert.deepEqual(continuationHintOf(events, 2), { reason: "continuation-intent" });
});

test("提醒有界：同一 turn 最多一次，turn 变化即重置；非对象 agent 安全返回 false", () => {
  const agent = {};
  assert.equal(canNudgeTurn(agent, 1), true);
  assert.equal(markTurnNudged(agent, 1), true);
  assert.equal(canNudgeTurn(agent, 1), false, "同一 turn 不得再次提醒");
  assert.equal(canNudgeTurn(agent, 2), true, "turn 变化后允许再次提醒");
  assert.equal(canNudgeTurn(null, 1), false);
  assert.equal(markTurnNudged(null, 1), false);
  assert.equal(canNudgeTurn(agent, 1.5), false, "非安全整数 turn 一律不提醒");
});

test("提醒消息使用 DEG 生产者来源与固定正文", () => {
  const message = buildContinuationReminder();
  assert.equal(message.source.kind, "plugin:dsh-expert-group");
  assert.equal(message.content.map((block) => block.text).join(""), REMINDER_TEXT);
});

// ── 2. turn-stopping 接线后的公开行为 ──────────────────────────────────────

/** 最小受控 Host：只需要真实 apply、一个 live root 与宿主 steer 记录。 */
function createGuardHost() {
  const host = createPluginHost({
    goals: { get: () => undefined },
    sessionActivity: "subagent",
    descendantListing: "subagent",
    settings: {
      value: {
        provider: "mock",
        defaults: { explorer: { provider: "mock", model: "mock" } },
        notificationEnabled: false,
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent(ROOT_ID);
  return { host, root };
}

/** 驱动一次 root 的 agent/turn-stopping（宿主会 await 监听器返回的 Promise）。 */
function turnStopping(host, root, turn = 1, signal) {
  return host.emit("agent/turn-stopping", { agent: root, turn, ...(signal === undefined ? {} : { signal }) });
}

/** 取该 root 已被 steer 的提醒正文。 */
function steeredTexts(host, root) {
  return host.agentSteerMessages(root).map((message) => message.content.map((block) => block.text).join(""));
}

test("turn-stopping：无等待工作时，中途停顿文本触发一次续接提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我已经看过上下文了，我看子代理会话日志确认。" });

  turnStopping(host, root, 1);
  const delivered = host.agentSteerMessages(root);
  assert.equal(delivered.length, 1, "本 turn 必须恰好投递一次续接提醒");
  assert.equal(delivered[0].source.kind, "plugin:dsh-expert-group", "来源必须是 DEG 生产者自有 kind");
  assert.equal(delivered[0].content.map((block) => block.text).join(""), REMINDER_TEXT);
  await host.dispose();
});

test("turn-stopping：同一 turn 第二次触发不再提醒（有界）", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我去验证。" });

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1);
  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1, "同一 turn 至多一次");
  await host.dispose();
});

test("turn-stopping：完成声明不打断交付", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "已完成，2216 项测试通过。" });

  turnStopping(host, root, 1);
  assert.deepEqual(host.agentSteerMessages(root), [], "交付文本不得被续接提醒打断");
  await host.dispose();
});

test("turn-stopping：续接 steer 抛错也只告警，绝不把异常抛回宿主", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我去验证。" });
  let attempts = 0;
  root.steer = () => { attempts += 1; throw new Error("steer boom"); };

  assert.doesNotThrow(() => turnStopping(host, root, 1), "turn-stopping 必须 fail-open");
  assert.equal(attempts, 1);
  // 先登记再 steer：抛错也算本 turn 已提醒，同一边界不得重试。
  assert.doesNotThrow(() => turnStopping(host, root, 1));
  assert.equal(attempts, 1, "steer 抛错后同一 turn 不得重试");
  await host.dispose();
});

test("turn-stopping：payload.signal 已取消时不提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我去验证。" });
  const controller = new AbortController();
  controller.abort();

  turnStopping(host, root, 1, controller.signal);
  assert.deepEqual(host.agentSteerMessages(root), [], "取消的 turn 不是中途停顿");
  // 取消不消耗本 turn 的提醒额度：同 turn 的下一次边界仍可提醒（signal 正常）。
  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1);
  await host.dispose();
});

test("turn-stopping：新 turn 允许再次提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我去验证。", turn: 1 });
  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1);

  root.session.events = buildTurnEvents({ text: "我确认一下。", turn: 2 });
  turnStopping(host, root, 2);
  const texts = steeredTexts(host, root);
  assert.equal(texts.length, 2, "新 turn 必须允许再次提醒");
  assert.equal(texts[1], REMINDER_TEXT);
  await host.dispose();
});

test("turn-stopping：session 只提供 snapshotEvents() 时走优先路径", async () => {
  const { host, root } = createGuardHost();
  const events = buildTurnEvents({ text: "我去检查日志。" });
  // 真实 live session 的 events 常是空驻留数组，权威事件只能经 snapshotEvents() 读取。
  root.session.events = [];
  root.session.snapshotEvents = () => events;

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1, "snapshotEvents 优先路径必须生效");
  await host.dispose();
});

test("turn-stopping：snapshotEvents() 返回非数组时回落到 events", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我去检查日志。" });
  // 残缺/异常的投影：sessionEvents 必须容错回落到 events，而不是把 turn 判定成无日志。
  root.session.snapshotEvents = () => undefined;

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1, "非数组投影必须回落到 events");
  await host.dispose();
});

test("turn-stopping：session.events 是只读 getter 时仍能读取，且绝不回写", async () => {
  const { host, root } = createGuardHost();
  const events = buildTurnEvents({ text: "我去验证。" });
  // 真实 live session 的 events 是只读投影：这里用 getter/setter 建模，任何回写都会
  // 被记录（并在严格模式下抛错），从而证明护栏只读事件、绝不改会话日志。
  let reads = 0;
  let writes = 0;
  Object.defineProperty(root.session, "events", {
    configurable: true,
    get() { reads += 1; return events; },
    set() { writes += 1; throw new Error("session.events is read-only"); },
  });

  assert.doesNotThrow(() => turnStopping(host, root, 1), "只读投影下也必须 fail-open");
  assert.equal(host.agentSteerMessages(root).length, 1, "getter 读到的日志必须生效");
  assert.ok(reads > 0, "护栏必须通过 getter 读取 session.events");
  assert.equal(writes, 0, "护栏绝不能给 session.events 赋值");
  await host.dispose();
});
