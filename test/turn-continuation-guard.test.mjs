/**
 * root turn 完成标记协议（dsh_expert_group_done）回归测试。
 *
 * 协议：**每个 turn** 都必须以 dsh_expert_group_done 作为最后一个工具调用收尾，不区分本
 * turn 是否调用过工具；root 的 agent/turn-stopping 边界按工具调用序列（callId 去重）与
 * tool/result 机械校验，未收尾就 steer 一条固定提醒，且同一 turn 最多提醒 3 次。
 *
 * 本文件锁定：
 * 1. 纯函数判定矩阵（纯文本 / done 收尾 / done 缺结果 / 缺名调用 / 去重 / 多 turn / 非法输入）；
 * 2. 接线后的公开行为：有界 steer（同 turn 至多 3 次）、DEG 来源、固定正文、fail-open；
 * 3. 工具本身：live root 返回 done 回执，child 返回结构化 rejected（root-only），工具已注册。
 *
 * 测试 seam 全部是公开面：真实 apply 的受控 Host、root session 事件日志、宿主
 * Agent.steer 记录（host.agentSteerMessages）与工具 definition/execute。不读取任何插件私有状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginHost } from "../test-support/plugin-host.mjs";
import {
  buildContinuationReminder,
  canNudgeTurn,
  DONE_TOOL_NAME,
  MAX_CONTINUATIONS_PER_TURN,
  markTurnNudged,
  needsContinuation,
  turnClosedWithDone,
  turnToolCallNames,
} from "../host/turn-continuation-guard.js";

const ROOT_ID = "root-turn-completion-marker";
/** 与插件内固定文案逐字一致（模型可见契约，改动必须同步本断言）。 */
const REMINDER_TEXT = "Turn not marked complete: this turn is about to close, but it did not end with a dsh_expert_group_done tool call. If the user's request is not fully delivered yet, continue now with the next tool call instead of describing what you will do next. If it is already fully delivered, call dsh_expert_group_done as the last tool call and then give the final answer — do not repeat the previous answer.";

/** 某次调用的稳定 callId（测试夹具与插件判定都不依赖具体格式，只需两侧一致）。 */
function callIdOf(turn, name) {
  return "call-" + turn + "-" + name;
}

/** 真实形状的 tool/call 事件（SessionEventMap 声明 turn/step/callId/name/arguments 在 data 上）。 */
function toolCallEvent(turn, name, callId) {
  return {
    type: "tool/call",
    data: { turn, step: 1, callId: callId ?? callIdOf(turn, name), name, arguments: {} },
  };
}

/** 真实形状的 tool/result 事件：message.toolCallId 指向对应调用。 */
function toolResultEvent(turn, callId) {
  return {
    type: "tool/result",
    data: { turn, step: 1, message: { role: "tool", toolCallId: callId, content: [] } },
  };
}

/** assistant 消息事件；text 为空串表示只有 reasoning / 流被截断。 */
function assistantEvent(turn, text = "", blocks = []) {
  return { type: "assistant/message", data: { turn, step: 2, message: { content: [{ type: "text", text }, ...blocks] } } };
}

/**
 * 构造某个 turn 的事件日志。
 *
 * 真实调用是三段式：assistant 消息里的 tool-call block（消息侧投影，带 callId）→
 * tool/call 事件（权威调用，同名同 callId）→ tool/result 事件（同 toolCallId）。
 * 夹具按同一形状生成，避免用「只有一侧投影」的残缺日志掩盖判定缺陷。
 *
 * @param {object} [options]
 * @param {number} [options.turn] 该日志所属 turn。
 * @param {string[]} [options.calls] 本 turn 的工具调用名（生成 block + tool/call 事件）。
 * @param {string[]} [options.results] 需要补成功 tool/result 的 callId。
 * @param {string} [options.text] assistant 文本。
 * @param {object[]} [options.blocks] 追加到最终 assistant content 的额外 block（如 tool-call）。
 */
function buildTurnEvents({ turn = 1, calls = [], results = [], text = "", blocks = [] } = {}) {
  const callBlocks = calls.map((name) => ({
    type: "tool-call",
    name,
    callId: callIdOf(turn, name),
    arguments: {},
  }));
  return [
    { type: "turn/start", data: { turn } },
    {
      type: "user/message",
      data: { id: "u-" + turn, role: "user", content: [{ type: "text", text: "任务" }], source: { kind: "user" } },
    },
    // 消息侧投影先出现（真实日志顺序），随后才是 tool/call 与 tool/result。
    ...(callBlocks.length === 0 ? [] : [assistantEvent(turn, "", callBlocks)]),
    ...calls.map((name) => toolCallEvent(turn, name)),
    ...results.map((callId) => toolResultEvent(turn, callId)),
    assistantEvent(turn, text, blocks),
  ];
}

// ── 1. 纯函数判定矩阵 ────────────────────────────────────────────────────────

test("纯文本 turn（没有工具调用、没有 done）：需要提醒", () => {
  const events = buildTurnEvents({ text: "这是纯问答收尾。" });
  assert.deepEqual(turnToolCallNames(events, 1), []);
  assert.equal(turnClosedWithDone(events, 1), false);
  assert.equal(needsContinuation(events, 1), true, "每个 turn 都必须打完成标记，纯文本 turn 不豁免");
});

test("最后一个工具调用是完成标记且结果成功：本 turn 按协议收尾，不提醒", () => {
  const events = buildTurnEvents({
    calls: ["read", DONE_TOOL_NAME],
    results: [callIdOf(1, DONE_TOOL_NAME)],
    text: "已交付。",
  });
  assert.deepEqual(turnToolCallNames(events, 1), ["read", DONE_TOOL_NAME]);
  assert.equal(turnClosedWithDone(events, 1), true);
  assert.equal(needsContinuation(events, 1), false);
});

test("有工具调用但最后一个是别的工具：视为未完成，需要提醒", () => {
  const events = buildTurnEvents({ calls: ["read", "grep"], text: "我准备继续。" });
  assert.equal(turnClosedWithDone(events, 1), false);
  assert.equal(needsContinuation(events, 1), true);
});

test("done 之后又调用了别的工具：协议收尾被打断，仍需要提醒", () => {
  const events = buildTurnEvents({ calls: [DONE_TOOL_NAME, "edit"] });
  assert.equal(turnClosedWithDone(events, 1), false);
  assert.equal(needsContinuation(events, 1), true);
});

test("done 有 tool/call（有 callId）但缺 tool/result：不得算成功收尾（fail-closed 到继续）", () => {
  const missing = buildTurnEvents({ calls: ["read", DONE_TOOL_NAME] });
  assert.equal(turnClosedWithDone(missing, 1), false, "没有结果凭据不能证明 done 成功");
  assert.equal(needsContinuation(missing, 1), true);

  const present = buildTurnEvents({ calls: ["read", DONE_TOOL_NAME], results: [callIdOf(1, DONE_TOOL_NAME)] });
  assert.equal(turnClosedWithDone(present, 1), true);
  assert.equal(needsContinuation(present, 1), false);

  // 结果 id 直接挂在 data.toolCallId 上的旧形状同样接受。
  const flat = [
    ...buildTurnEvents({ calls: [DONE_TOOL_NAME] }),
    { type: "tool/result", data: { turn: 1, step: 1, toolCallId: callIdOf(1, DONE_TOOL_NAME) } },
  ];
  assert.equal(turnClosedWithDone(flat, 1), true);
});

test("done 的 tool/result 明确失败（message.isError / data.error）：不得算成功收尾", () => {
  const doneId = callIdOf(1, DONE_TOOL_NAME);
  const base = buildTurnEvents({ calls: [DONE_TOOL_NAME] });
  const withIsError = [
    ...base,
    { type: "tool/result", data: { turn: 1, step: 1, message: { role: "tool", toolCallId: doneId, isError: true, content: [] } } },
  ];
  assert.equal(turnClosedWithDone(withIsError, 1), false, "isError:true 的 done 结果不算成功");
  assert.equal(needsContinuation(withIsError, 1), true);

  const withError = [
    ...base,
    {
      type: "tool/result",
      data: { turn: 1, step: 1, message: { role: "tool", toolCallId: doneId, content: [] }, error: { code: "tool-failed" } },
    },
  ];
  assert.equal(turnClosedWithDone(withError, 1), false, "data.error 非空的结果不算成功");
  assert.equal(needsContinuation(withError, 1), true);

  // 明确成功（isError:false）与缺省字段都接受。
  const explicitOk = [
    ...base,
    { type: "tool/result", data: { turn: 1, step: 1, message: { role: "tool", toolCallId: doneId, isError: false, content: [] } } },
  ];
  assert.equal(turnClosedWithDone(explicitOk, 1), true);
  assert.equal(needsContinuation(explicitOk, 1), false);
  const implicitOk = [...base, toolResultEvent(1, doneId)];
  assert.equal(turnClosedWithDone(implicitOk, 1), true);
  assert.equal(needsContinuation(implicitOk, 1), false);
});

test("done 之后出现缺名/无双名字段的调用：需要提醒", () => {
  // 尾部是一个没有 name 的 tool/call（只有 callId）：最后一条条目 name 为 null。
  const events = [
    ...buildTurnEvents({ calls: [DONE_TOOL_NAME], results: [callIdOf(1, DONE_TOOL_NAME)] }),
    { type: "tool/call", data: { turn: 1, step: 3, callId: "call-without-name" } },
  ];
  assert.equal(turnClosedWithDone(events, 1), false);
  assert.equal(needsContinuation(events, 1), true);
});

test("同一消息内 block 顺序决定收尾：先 done 后其它工具不算，反过来算", () => {
  const doneFirst = buildTurnEvents({
    calls: [],
    blocks: [
      { type: "tool-call", name: DONE_TOOL_NAME, callId: "c1" },
      { type: "tool-call", name: "read", callId: "c2" },
    ],
  });
  assert.equal(turnClosedWithDone(doneFirst, 1), false, "done 之后还有调用 → 未收尾");

  const doneLast = buildTurnEvents({
    calls: [],
    blocks: [
      { type: "tool-call", name: "read", callId: "c1" },
      { type: "tool-call", name: DONE_TOOL_NAME, callId: "c2" },
    ],
    results: ["c2"],
  });
  assert.equal(turnClosedWithDone(doneLast, 1), true, "最后一条是 done 且有结果 → 收尾");
  assert.equal(needsContinuation(doneLast, 1), false);
});

test("同一 call 同时以 block 与 tool/call 事件出现：只计一次（按 callId 去重）", () => {
  const doneId = callIdOf(1, DONE_TOOL_NAME);
  // 去重后条目是 [done(c1), read(c2)]，最后一条不是 done → 未收尾。
  // 若不去重，重放的同 callId done 会排到最后，被误判为收尾。
  const events = [
    toolCallEvent(1, DONE_TOOL_NAME, doneId),
    toolResultEvent(1, doneId),
    assistantEvent(1, "", [{ type: "tool-call", name: "read", callId: "read-call" }]),
    toolCallEvent(1, DONE_TOOL_NAME, doneId),
  ];
  assert.equal(turnClosedWithDone(events, 1), false);
  assert.equal(needsContinuation(events, 1), true);
});

test("多个 turn 各自独立判定", () => {
  const events = [
    ...buildTurnEvents({ turn: 1, calls: [DONE_TOOL_NAME], results: [callIdOf(1, DONE_TOOL_NAME)] }),
    ...buildTurnEvents({ turn: 2, calls: ["read"] }),
    ...buildTurnEvents({ turn: 3, text: "纯文本收尾。" }),
  ];
  assert.equal(turnClosedWithDone(events, 1), true);
  assert.equal(needsContinuation(events, 1), false);
  assert.deepEqual(turnToolCallNames(events, 2), ["read"]);
  assert.equal(needsContinuation(events, 2), true);
  assert.equal(needsContinuation(events, 3), true, "纯文本 turn 同样需要标记");
  assert.equal(needsContinuation(events, 4), true, "不存在的 turn 没有完成标记");
});

test("assistant 消息里的 tool-call block 也计入本 turn 的工具调用", () => {
  // 没有 tool/call 事件，只有消息侧 block：仍算“有调用”，且最后不是 done。
  const onlyBlock = [{ type: "tool-call", name: "read", arguments: {} }];
  const blockEvents = buildTurnEvents({ calls: [], text: "", blocks: onlyBlock });
  assert.deepEqual(turnToolCallNames(blockEvents, 1), [], "turnToolCallNames 只投影 tool/call 事件");
  assert.equal(turnClosedWithDone(blockEvents, 1), false);
  assert.equal(needsContinuation(blockEvents, 1), true, "消息侧 tool-call block 必须计入工具调用");

  // 旧形状 tool_use 的 done block（无 callId）：只有消息侧投影，无法核对调用真的发生并成功，
  // 因此**不能**当作收尾；必须提醒模型补 tool/call + tool/result。
  const doneBlock = buildTurnEvents({ calls: ["read"], blocks: [{ type: "tool_use", name: DONE_TOOL_NAME }] });
  assert.equal(turnClosedWithDone(doneBlock, 1), false, "无 callId 的 done 投影不得关闭 turn");
  assert.equal(needsContinuation(doneBlock, 1), true);
});

test("非法输入一律安全返回空判定（fail-open，不抛错）", () => {
  for (const badEvents of [undefined, null, 0, "events", {}]) {
    assert.deepEqual(turnToolCallNames(badEvents, 1), []);
    assert.equal(turnClosedWithDone(badEvents, 1), false);
    assert.equal(needsContinuation(badEvents, 1), false);
  }
  const events = buildTurnEvents({ calls: ["read"] });
  for (const badTurn of [undefined, null, "1", 1.5, Number.NaN]) {
    assert.deepEqual(turnToolCallNames(events, badTurn), []);
    assert.equal(turnClosedWithDone(events, badTurn), false);
    assert.equal(needsContinuation(events, badTurn), false);
  }
});

test("提醒有界：同一 turn 至多 MAX_CONTINUATIONS_PER_TURN（3）次，turn 变化即重置", () => {
  const agent = {};
  assert.equal(MAX_CONTINUATIONS_PER_TURN, 3);
  for (let attempt = 1; attempt <= MAX_CONTINUATIONS_PER_TURN; attempt += 1) {
    assert.equal(canNudgeTurn(agent, 1), true, "第 " + attempt + " 次仍可提醒");
    assert.equal(markTurnNudged(agent, 1), true);
  }
  assert.equal(canNudgeTurn(agent, 1), false, "达到上限后不再提醒");
  assert.equal(canNudgeTurn(agent, 2), true, "turn 变化后计数重置");
  assert.equal(canNudgeTurn(null, 1), false);
  assert.equal(markTurnNudged(null, 1), false);
  assert.equal(canNudgeTurn(agent, 1.5), false, "非安全整数 turn 一律不提醒");
});

test("提醒消息使用 DEG 生产者来源与固定正文", () => {
  const message = buildContinuationReminder();
  assert.equal(message.source.kind, "plugin:dsh-expert-group");
  assert.equal(message.content.map((block) => block.text).join(""), REMINDER_TEXT);
  assert.equal(DONE_TOOL_NAME, "dsh_expert_group_done");
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

test("turn-stopping：纯文本 turn 没有完成标记 → 恰好一条续接提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ text: "我已经看过上下文。" });

  turnStopping(host, root, 1);
  const delivered = host.agentSteerMessages(root);
  assert.equal(delivered.length, 1, "纯文本 turn 也必须被提醒");
  assert.equal(delivered[0].source.kind, "plugin:dsh-expert-group", "来源必须是 DEG 生产者自有 kind");
  assert.equal(delivered[0].content.map((block) => block.text).join(""), REMINDER_TEXT);
  await host.dispose();
});

test("turn-stopping：有工具调用但没有完成标记 → 一条续接提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ calls: ["read"] });

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1);
  await host.dispose();
});

test("turn-stopping：同一 turn 连续触发 4 次 → 前 3 次各 1 条、第 4 次不再提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ calls: ["read"] });

  for (let attempt = 1; attempt <= 4; attempt += 1) turnStopping(host, root, 1);
  assert.equal(
    host.agentSteerMessages(root).length,
    MAX_CONTINUATIONS_PER_TURN,
    "同一 turn 只允许 MAX_CONTINUATIONS_PER_TURN 次提醒",
  );
  await host.dispose();
});

test("turn-stopping：最后一个工具调用是完成标记（且有结果）→ 不提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({
    calls: ["read", DONE_TOOL_NAME],
    results: [callIdOf(1, DONE_TOOL_NAME)],
    text: "已交付。",
  });

  turnStopping(host, root, 1);
  assert.deepEqual(host.agentSteerMessages(root), [], "协议已收尾，不得打断交付");
  await host.dispose();
});

test("turn-stopping：续接 steer 抛错也只告警，绝不把异常抛回宿主", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ calls: ["read"] });
  let attempts = 0;
  root.steer = () => { attempts += 1; throw new Error("steer boom"); };

  assert.doesNotThrow(() => turnStopping(host, root, 1), "turn-stopping 必须 fail-open");
  assert.equal(attempts, 1);
  // 抛错的那次已计入上限；有界策略允许后续边界继续重试，但绝不把异常抛回宿主。
  assert.doesNotThrow(() => turnStopping(host, root, 1));
  assert.equal(attempts, 2, "有界重试仍在 3 次上限内");
  await host.dispose();
});

test("turn-stopping：payload.signal 已取消时不提醒", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ calls: ["read"] });
  const controller = new AbortController();
  controller.abort();

  turnStopping(host, root, 1, controller.signal);
  assert.deepEqual(host.agentSteerMessages(root), [], "取消的 turn 不是未完成");
  // 取消不消耗本 turn 的提醒额度：同 turn 的下一次边界仍可提醒（signal 正常）。
  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1);
  await host.dispose();
});

test("turn-stopping：新 turn 允许再次提醒（计数按 turn 重置）", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ turn: 1, calls: ["read"] });
  for (let attempt = 1; attempt <= MAX_CONTINUATIONS_PER_TURN; attempt += 1) turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, MAX_CONTINUATIONS_PER_TURN);

  root.session.events = buildTurnEvents({ turn: 2, calls: ["grep"] });
  turnStopping(host, root, 2);
  const texts = steeredTexts(host, root);
  assert.equal(texts.length, MAX_CONTINUATIONS_PER_TURN + 1, "新 turn 必须允许再次提醒");
  assert.equal(texts[texts.length - 1], REMINDER_TEXT);
  await host.dispose();
});

test("turn-stopping：session 只提供 snapshotEvents() 时走优先路径", async () => {
  const { host, root } = createGuardHost();
  const events = buildTurnEvents({ calls: ["read"] });
  // 真实 live session 的 events 常是空驻留数组，权威事件只能经 snapshotEvents() 读取。
  root.session.events = [];
  root.session.snapshotEvents = () => events;

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1, "snapshotEvents 优先路径必须生效");
  await host.dispose();
});

test("turn-stopping：snapshotEvents() 返回非数组时回落到 events", async () => {
  const { host, root } = createGuardHost();
  root.session.events = buildTurnEvents({ calls: ["read"] });
  // 残缺/异常的投影：sessionEvents 必须容错回落到 events，而不是把 turn 判定成无日志。
  root.session.snapshotEvents = () => undefined;

  turnStopping(host, root, 1);
  assert.equal(host.agentSteerMessages(root).length, 1, "非数组投影必须回落到 events");
  await host.dispose();
});

test("turn-stopping：session.events 是只读 getter 时仍能读取，且绝不回写", async () => {
  const { host, root } = createGuardHost();
  const events = buildTurnEvents({ calls: ["read"] });
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

// ── 3. dsh_expert_group_done 工具契约 ───────────────────────────────────────

/** root-only 工具需要的公开 execution 形状。 */
function execution(agent) {
  return { agent, signal: new AbortController().signal };
}

test("完成标记工具已注册，且描述写明协议契约", async () => {
  const { host } = createGuardHost();
  assert.ok(host.toolNames().includes(DONE_TOOL_NAME), "dsh_expert_group_done 必须真实注册");
  const definition = host.toolDefinition(DONE_TOOL_NAME);
  assert.equal(definition.name, DONE_TOOL_NAME);
  assert.match(definition.description, /LAST tool call/, "描述必须说明它是本 turn 的最后一个工具调用");
  assert.match(definition.description, /dsh_expert_group_done/);
  assert.match(definition.description, /unfinished/, "描述必须说明缺失标记会被视为未完成");
  // 无参数：参数 schema 只有对象根，没有必填字段。
  assert.deepEqual(definition.parameters.required, undefined);
  assert.deepEqual(Object.keys(definition.parameters.properties ?? {}), []);
  await host.dispose();
});

test("live root 调用完成标记工具：返回 done 回执", async () => {
  const { host, root } = createGuardHost();
  const result = await host.toolDefinition(DONE_TOOL_NAME).execute({}, execution(root));
  assert.equal(result.kind, "done");
  assert.equal(result.turnComplete, true);
  assert.match(result.message, /final answer/);
  await host.dispose();
});

test("child / 非 root 调用完成标记工具：返回结构化 rejected（root-only），且不抛异常", async () => {
  const { host, root } = createGuardHost();
  const child = {
    id: "child-done-caller",
    options: {},
    session: { id: "child-done-caller", header: { id: "child-done-caller", parentSession: root.id } },
  };
  const result = await host.toolDefinition(DONE_TOOL_NAME).execute({}, execution(child));
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "root-only");
  assert.ok(result.message.length > 0, "rejected 必须带可执行提示");
  await host.dispose();
});
