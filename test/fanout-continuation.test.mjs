/**
 * fan-out 多轮复用（continuation）契约测试。
 *
 * 覆盖已确认规格：
 * 1. 同一逻辑父任务跨 ready/completed 续作复用：parentTaskId / shardId / childId 不变，
 *    每个分片追加新 attempt（历史保留、attempt 递增），每轮独立 wait-all；
 * 2. 父级状态按「任一分片 running → running，否则 ready」聚合：复用提交后立即变 running，
 *    本轮全部分片结束后回到 ready（工具回执与 Expert Group 侧边栏投影一致）；
 * 3. 工具回执完整暴露 continuation 句柄（parentTaskId/role/round/running/reusable/
 *    shardId/childId/attempt/nextAttemptByShard + 下一轮调用字段）；
 * 4. 拒绝路径：role / 分片数量 / shardId 结构不一致、其它 root 的 parentTaskId、
 *    上一轮未完成、closed root / 关闭的 manager；
 * 5. 幂等与并发：duplicate continuation requestId 不追加 attempt；并发续作不重复建 child；
 * 6. 旧轮迟到 turn/end 不覆盖最新 attempt；每轮 wait-all 只结算一次（按 round 区分）；
 * 7. 多轮复用仍与现有 goal pause/resume handoff 协同（每轮重新 pause，结算后 resume）。
 *
 * 行为面：插件级用例全部通过真实 plugin.apply 注册出的工具、RPC、manager 快照与侧边栏
 * 投影驱动与观察，不读取生产源码文本；manager 级用例只依赖注入 seam（launcher/continuer/
 * persistence），覆盖复用状态机本体、快照恢复与预算边界。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FANOUT_BUDGET } from "../resource-budget.js";
import { createFanoutManager } from "../fanout.js";
import { FANOUT_MARKER, FANOUT_PARENT_AGENT_MARKER, FANOUT_PARENT_TASK_MARKER, FANOUT_SHARD_MARKER, FANOUT_ATTEMPT_MARKER, createFanoutRuntime } from "../fanout-host.js";
import { createLineageModule } from "../host/lineage.js";
import { buildExpertGroupSnapshot } from "../host/expert-group-snapshot.js";
import { createPluginHost, flushAsyncWork, RPC_ENDPOINT } from "../test-support/plugin-host.mjs";

const SETTINGS = { value: { defaults: { fixer: { provider: "mock", model: "mock" } } } };

/**
 * GoalService 探测替身（改造后必须**零调用**）。
 *
 * fan-out 的等待不再依赖 durable goal：提交/续作/重试只登记 root turn 等待工作，
 * 任务 settle 时精确结算（见 host/turn-wait.js）。因此这个替身记录一切调用并在
 * pause/resume 上直接抛错——任何残留的旧调用路径都会立刻打红。
 */
function createGoalService() {
  const calls = [];
  return {
    calls,
    service: {
      get() { calls.push(["get"]); return undefined; },
      pause(_agent, ref) { calls.push(["pause", ref]); throw new Error("goals.pause must never be called"); },
      resume(_agent, ref) { calls.push(["resume", ref]); throw new Error("goals.resume must never be called"); },
    },
  };
}

/**
 * 受控 fan-out Host：
 * - startContinuable：为每个**首轮** attempt 新建一个 fan-out child（带完整 marker），
 *   返回 { childId, messageId }；
 * - sendMessage：多轮复用走同一 child，返回新的 messageId（模拟真实 sendMessage admission）。
 *
 * 选项（都只影响 Host 侧行为，不改插件代码）：
 * - `sendMessageMode`：`normal`（默认，返回全新 messageId）| `missing`（返回 undefined，
 *   模拟投递没有消息身份）| `reuse`（返回该 child 首轮的 messageId，模拟新旧轮身份重复）；
 * - `detachChildSession`：默认 false。置 true 时 child 的 `agent.session` 引用被摘掉
 *   （registry 里仍存在但 `resolveChildSession` 解析不到），且 runtime 的会话索引也不会
 *   登记它——用于验证续作的执行路由前置条件；turn/end 仍由 harness 自己持有的 session
 *   对象投递。
 * - `delaySendMessage`：默认 false。置 true 时续作投递挂在 test 控制的 deferred 上
 *   （`resolvePendingSend` 才送达），用于构造 admission 期间新轮 turn/end 先到的竞态。
 */
function createFanoutHost({ goals, sendMessageMode = "normal", detachChildSession = false, delaySendMessage = false } = {}) {
  const goalService = goals ?? createGoalService();
  const started = [];
  const sent = [];
  const pendingSends = [];
  const children = new Map();
  const host = createPluginHost({
    settings: SETTINGS,
    goals: goalService.service,
    subagents: {
      async startContinuable({ request }) {
        const index = started.length + 1;
        const childId = "fanout-child-" + index;
        const messageId = "fanout-message-" + index;
        const child = host.registerRootAgent(childId, { lifecycle: false });
        const session = child.session;
        session.header = { id: childId, parentSession: request.parent.id, origin: "subagent" };
        session.events = [];
        child.parent = request.parent;
        child.options = { provider: "mock", model: "mock", ...request.agentOptions };
        // 摘掉 agent.session 引用：registry 仍有该 agent，但 resolveChildSession 拿不到会话，
        // 且 runtime 自己的 childSessions 索引也不会登记（handleAgentCreated 只认对象形态）。
        if (detachChildSession) child.session = undefined;
        children.set(childId, { agent: child, session, childId, prompt: request.prompt?.[0]?.text ?? "" });
        started.push({ childId, messageId, request });
        host.emit("agent/created", { agent: child });
        return { childId, messageId };
      },
      async sendMessage(parent, childId, content) {
        const entry = children.get(childId);
        if (entry === undefined) throw new Error("harness: unknown continuation child " + childId);
        if (sendMessageMode === "missing") {
          sent.push({ childId, parent, content, messageId: undefined });
          return undefined;
        }
        // reuse：返回该 child 首轮（launcher）的 messageId，模拟「新一轮拿到旧轮身份」。
        const messageId = sendMessageMode === "reuse"
          ? started.find((record) => record.childId === childId)?.messageId
          : "fanout-cont-message-" + (sent.length + 1);
        // delay：投递挂在 test 控制的 deferred 上，用于构造「新一轮 turn/end 先于 messageId
        // 绑定到达」的 admission 竞态；resolvePendingSend 才会真正"送达"。
        if (delaySendMessage === true) {
          const gate = deferred();
          pendingSends.push({ childId, parent, content, messageId, gate });
          return gate.promise;
        }
        sent.push({ childId, parent, content, messageId });
        return messageId;
      },
      interrupt() {},
    },
  });
  host.apply();
  return {
    host,
    goals: goalService,
    started,
    sent,
    children,
    pendingSends,
    /**
     * 让第 index 个被延迟的投递真正送达（把 messageId 交给 runtime 的 admission）。
     * @param {number} index - pendingSends 下标。
     */
    resolvePendingSend(index = 0) {
      const pending = pendingSends[index];
      assert.ok(pending !== undefined, "缺少被延迟的续作投递");
      sent.push({ childId: pending.childId, parent: pending.parent, content: pending.content, messageId: pending.messageId });
      pending.gate.resolve(pending.messageId);
      return pending.messageId;
    },
  };
}

/** 调用真实 fanout 工具（root-only 面）。 */
async function callFanout(host, root, args) {
  return host.toolDefinition("fanout").execute(args, {
    agent: root,
    signal: new AbortController().signal,
    concludeTurn: () => {},
  });
}

/** 新建一个 fan-out 父任务。 */
async function submitFanout(host, root, shards, extra = {}) {
  const accepted = await callFanout(host, root, {
    role: "fixer",
    basePrompt: "多轮复用共享目标",
    shards,
    ...extra,
  });
  assert.equal(accepted.accepted, true);
  await flushAsyncWork();
  return accepted;
}

/** 续作一轮（复用同一 parentTaskId）。 */
async function continueFanout(host, root, parentTaskId, shards, extra = {}) {
  return callFanout(host, root, {
    role: "fixer",
    basePrompt: extra.basePrompt ?? "本轮共享目标",
    shards,
    continuation: { parentTaskId, ...(extra.requestId === undefined ? {} : { requestId: extra.requestId }) },
  });
}

/**
 * 让某轮 attempt 真实终态：写入该轮事件（user/message = 本轮的 messageId，runtime 按它
 * 认领 turn）后发布 turn/end。
 */
async function settleAttempt(host, entry, { turn, messageId, reason = { kind: "completed" }, text = "分片完成" }) {
  const session = entry.session ?? entry.agent.session;
  session.events = [
    ...(Array.isArray(session.events) ? session.events : []),
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin" } } },
    ...(text === undefined ? [] : [{ type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } }]),
  ];
  host.emit("session/event", session, { type: "turn/end", data: { turn, reason } });
  await flushAsyncWork(10);
}

/** 让真实 DSH Session 形状的事件日志（snapshotEvents()）驱动一轮终态。 */
async function settleSnapshotAttempt(host, entry, { turn, messageId, reason = { kind: "completed" }, text = "分片完成" }) {
  const session = entry.session ?? entry.agent.session;
  const events = typeof session.snapshotEvents === "function" ? [...session.snapshotEvents()] : [];
  events.push(
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "agent-message", form: "relay" } } },
    ...(text === undefined ? [] : [{ type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } }]),
  );
  // DSH 的真实 Session 没有可供插件直接读取的 `events` 数组，只有快照方法。
  delete session.events;
  session.snapshotEvents = () => events;
  host.emit("session/event", session, { type: "turn/end", data: { turn, reason } });
  await flushAsyncWork(10);
}

/** 读取 manager 权威任务快照（RPC 面）。 */
async function getTask(host, root, parentTaskId) {
  const response = await host.invokeConnection(RPC_ENDPOINT, {
    action: "fanout-get",
    sessionId: root.id,
    parentTaskId,
  });
  assert.equal(response.ok, true);
  return response.value.task;
}

/** 读取 fan-out 事件历史（RPC 面）。 */
async function getEvents(host, root, after = 0) {
  const response = await host.invokeConnection(RPC_ENDPOINT, {
    action: "fanout-events",
    sessionId: root.id,
    after,
  });
  assert.equal(response.ok, true);
  return response.value.events;
}

/**
 * 从真实落盘的 fan-out 快照里读任务与事件。
 *
 * 为什么需要它：写路径的拒绝必须证明「没有改变历史」，而 RPC 回执只反映一次请求的
 * 结果；冷恢复后已终态任务的读路径（票据 09 起）可见，但持久化快照仍是最直接的
 * 「轮次/attempt/事件没有变化」证据。
 */
function storedSnapshot(host) {
  return host.storage.entries("fanout_tasks").find(([key]) => key === "current")?.[1] ?? null;
}

function storedTask(host, parentTaskId) {
  return storedSnapshot(host)?.tasks?.find((task) => task.parentTaskId === parentTaskId) ?? null;
}

/**
 * 直接驱动 fanout-host runtime 的最小脚手架（不经过 plugin.apply）。
 *
 * 为什么需要它：插件层（index.js）自己会校验 sendMessage 的返回值，因此「runtime 自身的
 * 严格启动门」在插件级用例里会被 Host 层先拦掉。这里直接给 runtime 注入
 * `continueMessage`/`resolveChildSession`，精确验证 runtime 的 fail-closed 行为：
 * - 投递返回无效 messageId / 与旧轮重复 → 本轮 attempt 在启动阶段失败；
 * - 会话事件无法证明归属 → 不结算，只记结构化诊断；
 * - 会话路由不可解析 → `continuationReadiness` 给出结构化原因。
 */
function createRuntimeHarness({ continueMessage, resolveChildSession } = {}) {
  const rootAgent = { id: "runtime-root", kind: "root" };
  const children = new Map();
  const continuations = [];
  // 记录 interrupt 调用（每次以 attempt key 计）：用于验证 disposal/close 组合不重复 interrupt。
  const interrupts = [];
  const runtime = createFanoutRuntime({
    buildRequest: async (input) => ({
      request: { label: "fanout " + input.shardId },
      parentAgent: rootAgent,
      parentId: rootAgent.id,
      role: input.role,
    }),
    startContinuable: async ({ input }) => {
      const childId = "runtime-child-" + (children.size + 1);
      const messageId = "runtime-message-" + (children.size + 1);
      const session = { id: childId, header: { id: childId }, events: [] };
      const agent = {
        id: childId,
        parent: rootAgent,
        session,
        options: {
          [FANOUT_MARKER]: true,
          [FANOUT_PARENT_TASK_MARKER]: input.parentTaskId,
          [FANOUT_PARENT_AGENT_MARKER]: rootAgent.id,
          [FANOUT_SHARD_MARKER]: input.shardId,
          [FANOUT_ATTEMPT_MARKER]: input.attempt,
        },
      };
      children.set(childId, { agent, session, childId, messageId });
      runtime.handleAgentCreated(agent);
      return { childId, messageId };
    },
    continueMessage: ({ childId, input }) => {
      continuations.push({ childId, input });
      return continueMessage({ childId, input, children, continuations });
    },
    ...(resolveChildSession === undefined
      ? {}
      : { resolveChildSession: (childId) => resolveChildSession(childId, children) }),
    parentAgentOf: () => rootAgent,
    interrupt: ({ childId, input }) => { interrupts.push({ childId, attempt: input?.attempt, shardId: input?.shardId }); },
  });
  return { runtime, rootAgent, children, continuations, interrupts };
}

/** 让某轮会话事件真实终态（写入 turn 内消息 id 后发布 turn/end）。 */
function settleRuntimeAttempt(runtime, entry, { turn, messageId, reason = { kind: "completed" } }) {
  entry.session.events = [
    ...entry.session.events,
    { type: "turn/start", data: { turn } },
    ...(messageId === undefined
      ? []
      : [{ type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin" } } }]),
  ];
  runtime.handleSessionEvent(entry.session, { type: "turn/end", data: { turn, reason } });
}

/**
 * 构造同一 child 的 replacement 实例（cold-resume / session 替换形态）：新的 Agent + 新的
 * session 对象、**同一个 childId**，markers 指向指定 attempt（因此能被 runtime 认领为同一
 * record 的下一次 activation，或按持久化身份被识别为 fan-out child）。
 *
 * @returns {{agent:object, session:object}} 可交给 runtime.handleAgentCreated 或
 *   host.emit("agent/created", { agent }) 的实例对。
 */
function createReplacementChild({ childId, parentTaskId, parentAgentId, shardId, attempt, parent }) {
  const session = { id: childId, header: { id: childId, parentSession: parentAgentId, origin: "subagent" }, events: [] };
  const agent = {
    id: childId,
    parent,
    session,
    options: {
      provider: "mock",
      model: "mock",
      [FANOUT_MARKER]: true,
      [FANOUT_PARENT_TASK_MARKER]: parentTaskId,
      [FANOUT_PARENT_AGENT_MARKER]: parentAgentId,
      [FANOUT_SHARD_MARKER]: shardId,
      [FANOUT_ATTEMPT_MARKER]: attempt,
    },
  };
  return { agent, session };
}

/** 当前轮每个 shard 最新 attempt 的 messageId（首轮来自 startContinuable，续作来自 sendMessage）。 */
function latestMessageId({ started, sent }, shardIndex, round) {
  if (round === 1) return started[shardIndex]?.messageId;
  // 续作按 shard 顺序投递：第 N 轮（N>=2）的第 i 个分片 = sent[(N-2)*shardCount + i]
  return sent[(round - 2) * started.length + shardIndex]?.messageId;
}

/**
 * 冷恢复 Host：把上一代实例真实落盘的 fan-out 快照 seed 进全新 host 的 storage domain，
 * 不复制任何内存状态——restore 只能依赖持久化快照与 manager 权威状态。
 */
function createColdHost({ snapshot, goals } = {}) {
  const goalService = goals ?? createGoalService();
  const started = [];
  const sent = [];
  const children = new Map();
  const host = createPluginHost({
    settings: SETTINGS,
    goals: goalService.service,
    storageOptions: { seed: { fanout_tasks: [["current", snapshot]] } },
    subagents: {
      async startContinuable({ request }) {
        const index = started.length + 1;
        const childId = "cold-child-" + index;
        const messageId = "cold-message-" + index;
        const child = host.registerRootAgent(childId, { lifecycle: false });
        child.session.header = { id: childId, parentSession: request.parent.id, origin: "subagent" };
        child.session.events = [];
        child.parent = request.parent;
        child.options = { provider: "mock", model: "mock", ...request.agentOptions };
        children.set(childId, { agent: child, childId });
        started.push({ childId, messageId, request });
        host.emit("agent/created", { agent: child });
        return { childId, messageId };
      },
      async sendMessage(_parent, childId, content) {
        const messageId = "cold-cont-message-" + (sent.length + 1);
        sent.push({ childId, content, messageId });
        return messageId;
      },
      interrupt() {},
    },
  });
  host.apply();
  return { host, goals: goalService, started, sent, children };
}

const SHARDS_TWO = [
  { shardId: "s1", name: "实现添加任务名称", prompt: "第一片：实现" },
  { shardId: "s2", prompt: "第二片：测试" },
];

test("多轮复用：三轮 continuation 保持 parentTaskId/shardId/childId，attempt 递增且每轮 wait-all 成功", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-three");
    const first = await submitFanout(host, root, SHARDS_TWO);
    assert.equal(first.round, 1);
    assert.equal(started.length, 2, "首轮每个分片一个 child");

    const childIds = started.map((entry) => entry.childId);
    let turn = 0;
    for (const round of [1, 2, 3]) {
      // 本轮开始：所有分片先到 running。
      for (const [index, shard] of SHARDS_TWO.entries()) {
        const entry = children.get(childIds[index]);
        turn += 1;
        await settleAttempt(host, entry, { turn, messageId: latestMessageId({ started, sent }, index, round) });
      }
      const task = await getTask(host, root, first.parentTaskId);
      assert.equal(task.parentTaskId, first.parentTaskId, "父任务 id 必须稳定");
      assert.deepEqual(task.shards.map((shard) => shard.shardId), ["s1", "s2"], "shardId 结构必须稳定");
      assert.equal(task.round, round, "轮次必须随 continuation 递增");
      assert.equal(task.status, "completed", "本轮全部分片成功 → 父任务 completed");
      assert.equal(task.continuable, true, "本轮 wait-all 完成后可继续下一轮");
      for (const [index, shard] of task.shards.entries()) {
        const attempts = shard.attempts;
        assert.equal(attempts.length, round, "每轮为每个分片追加一个 attempt");
        assert.deepEqual(attempts.map((item) => item.attempt), Array.from({ length: round }, (_v, i) => i + 1),
          "attempt 序号在同一 shard 内单调递增且历史保留");
        assert.equal(attempts[attempts.length - 1].childId, childIds[index], "续作必须复用原 childId");
        assert.equal(attempts[0].childId, childIds[index], "首轮 childId 历史不得被覆盖");
      }
      if (round === 3) break;
      const continued = await continueFanout(host, root, first.parentTaskId, [
        { shardId: "s1", prompt: "第 " + (round + 1) + " 轮：继续实现" },
        { shardId: "s2", prompt: "第 " + (round + 1) + " 轮：继续测试" },
      ]);
      assert.equal(continued.parentTaskId, first.parentTaskId, "续作不得创建新父任务");
      assert.equal(continued.reopened, true);
      assert.equal(continued.round, round + 1);
      await flushAsyncWork();
    }

    assert.equal(started.length, 2, "三轮复用不得新建 child");
    assert.equal(sent.length, 4, "第二、三轮各给同一 child 投递一次 prompt");
    assert.deepEqual(sent.map((entry) => entry.childId), [childIds[0], childIds[1], childIds[0], childIds[1]]);
    // 每轮 task_settled 一次（按 round 区分，不重复发布）。
    const settled = (await getEvents(host, root)).filter((event) => event.type === "task_settled");
    assert.deepEqual(settled.map((event) => event.round), [1, 2, 3], "每轮 wait-all 只结算一次并带 round");
    const continued = (await getEvents(host, root)).filter((event) => event.type === "task_continued");
    assert.deepEqual(continued.map((event) => event.round), [2, 3]);
    assert.deepEqual(continued[0].nextAttemptByShard, { s1: 2, s2: 2 });
  } finally {
    await host.dispose();
  }
});

test("fan-out 反馈注入使用生产者自有 source kind（V4 拒绝精确 plugin）", async () => {
  // 回归：会话格式 V4 在写入边界精确拒绝 `kind: "plugin"`（旧插件包装语法），
  // 而父任务 inbox 注入会产生受校验的 agent/inbox/spliced。因此注入必须使用
  // 生产者自有 kind（0.1.7 对未知插件的规范形式是 `plugin:<插件名>`），并且不再
  // 携带已退役的 `plugin` 字段——否则父任务完全收不到 fan-out 反馈。
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-feedback-source");
    const accepted = await submitFanout(host, root, SHARDS_TWO);
    const childIds = started.map((entry) => entry.childId);

    let turn = 0;
    for (const [index, childId] of childIds.entries()) {
      turn += 1;
      await settleAttempt(host, children.get(childId), { turn, messageId: started[index].messageId });
    }

    const injected = host.injectedMessages().filter((entry) => entry.agentId === root.id);
    assert.ok(injected.length >= 1, "父任务必须收到 fan-out 反馈注入");
    for (const entry of injected) {
      const source = entry.message?.source;
      assert.ok(source && typeof source === "object", "注入消息必须携带 source");
      assert.notEqual(source.kind, "plugin", "V4 精确拒绝 kind:plugin，注入不得再使用它");
      assert.match(String(source.kind), /^plugin:.+/, "注入必须使用生产者自有 kind: plugin:<插件名>");
      assert.equal(source.kind, "plugin:dsh-expert-group", "kind 必须参数化为本插件身份");
      assert.equal(Object.prototype.hasOwnProperty.call(source, "plugin"), false,
        "生产者自有 source 不得再携带已退役的 plugin 字段");
      assert.equal(host.injectFailures().length, 0, "注入不得被 V4 来源准入拒绝");
    }
  } finally {
    await host.dispose();
  }
});

test("多轮复用：提交后父级立即 running，本轮全部分片 settle 后回到 ready", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-status");
    const first = await submitFanout(host, root, SHARDS_TWO);
    const childIds = started.map((entry) => entry.childId);
    await settleAttempt(host, children.get(childIds[0]), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(childIds[1]), { turn: 2, messageId: started[1].messageId });
    assert.equal((await getTask(host, root, first.parentTaskId)).status, "completed");

    // 复用提交：父任务必须立即回到 pending（投影 = running），不能停留在上一轮 ready。
    const reopened = await continueFanout(host, root, first.parentTaskId, [
      { shardId: "s1", prompt: "第二轮 s1" },
      { shardId: "s2", prompt: "第二轮 s2" },
    ]);
    await flushAsyncWork();
    assert.equal(reopened.status, "pending", "复用提交后父任务必须是 pending");
    assert.equal(reopened.continuation.running, true, "回执必须立即显示 running");
    assert.equal(reopened.continuation.reusable, false, "本轮运行中不可再次复用");
    assert.equal((await getTask(host, root, first.parentTaskId)).status, "pending");

    // 侧边栏投影：父节点 running=true、status=running（修复「复用后仍显示上一轮 ready」）。
    const snapshot = buildExpertGroupSnapshot({
      sessionId: root.id,
      root: { id: root.id, status: "running" },
      experts: [],
      fanoutTasks: [await getTask(host, root, first.parentTaskId)],
      generatedAt: 1,
    });
    const fanoutNode = snapshot.root.children.find((node) => node.kind === "fanout");
    assert.ok(fanoutNode !== undefined, "父任务必须出现在 Expert Group 快照里");
    assert.equal(fanoutNode.status, "running", "任一分片未终态 → 父节点 running");
    assert.equal(fanoutNode.running, true);
    // 同一条链路也要覆盖真实 RPC（Expert Group 侧边栏读的就是它）。
    const rpcSnapshot = await host.invokeConnection(RPC_ENDPOINT, { action: "expert-group-snapshot", sessionId: root.id });
    assert.equal(rpcSnapshot.ok, true);
    const rpcFanout = rpcSnapshot.value.snapshot.root.children.find((node) => node.kind === "fanout");
    assert.ok(rpcFanout !== undefined, "RPC 快照必须包含 fan-out 父节点");
    assert.equal(rpcFanout.running, true, "RPC 投影必须显示 running（复用后不得停在上一轮 ready）");
    assert.equal(rpcFanout.status, "running");

    // 只完成一个分片：仍然 running（用户确认的聚合规则）。
    await settleAttempt(host, children.get(childIds[0]), {
      turn: 3,
      messageId: sent[0].messageId,
    });
    assert.equal((await getTask(host, root, first.parentTaskId)).status, "pending");
    // 两个分片都结束：回到 ready（manager 状态 completed → 投影 running=false）。
    await settleAttempt(host, children.get(childIds[1]), {
      turn: 4,
      messageId: sent[1].messageId,
    });
    const finished = await getTask(host, root, first.parentTaskId);
    assert.equal(finished.status, "completed");
    const after = buildExpertGroupSnapshot({
      sessionId: root.id,
      root: { id: root.id, status: "ready" },
      experts: [],
      fanoutTasks: [finished],
      generatedAt: 2,
    });
    const finishedNode = after.root.children.find((node) => node.kind === "fanout");
    assert.equal(finishedNode.running, false, "全部分片结束 → 父节点回到 ready");
    assert.equal(finishedNode.status, "succeeded", "manager 终态 completed 映射为统一词表的 succeeded");
    const rpcAfter = await host.invokeConnection(RPC_ENDPOINT, { action: "expert-group-snapshot", sessionId: root.id });
    assert.equal(rpcAfter.ok, true);
    const rpcFinishedNode = rpcAfter.value.snapshot.root.children.find((node) => node.kind === "fanout");
    assert.equal(rpcFinishedNode.running, false, "RPC 投影：本轮全部结束后回到 ready");
    assert.equal(rpcFinishedNode.shards.length, 2, "分片结构必须保持 2 个");
    assert.equal(rpcFinishedNode.shards[0].attempts.length, 2, "侧边栏可见完整 attempt 历史");
  } finally {
    await host.dispose();
  }
});

test("真实 Session 事件日志：snapshotEvents() 形状下续作仍能完成 wait-all", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-snapshot-events");
    const first = await submitFanout(host, root, SHARDS_TWO);
    const childIds = started.map((entry) => entry.childId);
    await settleAttempt(host, children.get(childIds[0]), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(childIds[1]), { turn: 2, messageId: started[1].messageId });

    await continueFanout(host, root, first.parentTaskId, [
      { shardId: "s1", prompt: "第二轮 s1" },
      { shardId: "s2", prompt: "第二轮 s2" },
    ]);
    await flushAsyncWork();

    // 真实 DSH child session 只暴露 snapshotEvents()；两片都收到第二轮 turn/end。
    await settleSnapshotAttempt(host, children.get(childIds[0]), { turn: 3, messageId: sent[0].messageId });
    await settleSnapshotAttempt(host, children.get(childIds[1]), { turn: 4, messageId: sent[1].messageId });

    const finished = await getTask(host, root, first.parentTaskId);
    assert.equal(finished.status, "completed", "真实 Session API 形状下两片完成后父任务必须完成");
    assert.equal(finished.shards[0].attempts[1].status, "succeeded");
    assert.equal(finished.shards[1].attempts[1].status, "succeeded");
  } finally {
    await host.dispose();
  }
});


test("多轮复用：回执暴露完整 continuation 句柄与下一轮调用字段", async () => {
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-receipt");
    const first = await submitFanout(host, root, SHARDS_TWO);
    const handle = first.continuation;
    assert.ok(handle !== undefined, "首轮回执必须带 continuation 句柄");
    assert.equal(handle.parentTaskId, first.parentTaskId);
    assert.equal(handle.role, "fixer");
    assert.equal(handle.round, 1);
    assert.equal(handle.running, true, "首轮刚提交 → running");
    assert.equal(handle.reusable, false, "首轮运行中不可复用");
    assert.deepEqual(handle.shardIds, ["s1", "s2"]);
    assert.deepEqual(handle.shards.map((shard) => shard.shardId), ["s1", "s2"]);
    for (const [index, shard] of handle.shards.entries()) {
      // 首轮回执是同步返回的：admission 可能尚未落地，childId 允许为 null（后续读取或
      // 下一轮回执里必然给出）；attempt 序号与下一轮 attempt 必须已经确定。
      assert.ok(shard.childId === null || shard.childId === started[index].childId);
      assert.equal(shard.attempt, 1);
      assert.equal(shard.attemptCount, 1);
      assert.equal(shard.nextAttempt, 2);
    }
    assert.deepEqual(handle.nextAttemptByShard, { s1: 2, s2: 2 });
    assert.equal(handle.resumeWith.tool, "fanout");
    assert.equal(handle.resumeWith.arguments.continuation.parentTaskId, first.parentTaskId);
    assert.deepEqual(handle.resumeWith.arguments.shards.map((shard) => shard.shardId), ["s1", "s2"]);

    // 本轮完成后：句柄 reusable=true 且给出下一轮 attempt。
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(started[1].childId), { turn: 2, messageId: started[1].messageId });
    const finished = (await getTask(host, root, first.parentTaskId));
    const reopened = await continueFanout(host, root, first.parentTaskId, [
      { shardId: "s1", prompt: "第二轮 s1" },
      { shardId: "s2", prompt: "第二轮 s2" },
    ]);
    assert.equal(reopened.continuation.round, 2);
    // 第二轮已经提交 → 每个分片当前 attempt 是 2，下一轮 attempt 是 3。
    assert.deepEqual(reopened.continuation.nextAttemptByShard, { s1: 3, s2: 3 });
    for (const [index, shard] of reopened.continuation.shards.entries()) {
      assert.equal(shard.childId, started[index].childId, "续作回执必须给出复用的原 childId");
      assert.equal(shard.attempt, 2, "续作回执必须给出本轮 attempt");
      assert.equal(shard.attemptCount, 2, "attempt 历史必须完整可见");
    }
    assert.equal(finished.continuable, true, "wait-all 完成后 manager 标记可继续");
  } finally {
    await host.dispose();
  }
});

test("多轮复用拒绝路径：role/分片数量/shardId 结构不一致、其它 root、上一轮未完成", async () => {
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-reject");
    const other = host.registerRootAgent("root-continuation-other");
    const first = await submitFanout(host, root, SHARDS_TWO);

    // 上一轮仍在运行：拒绝 task_not_ready，且不得追加 attempt。
    await assert.rejects(
      () => continueFanout(host, root, first.parentTaskId, SHARDS_TWO),
      (error) => {
        assert.equal(error.name, "FanoutContinuationError");
        assert.equal(error.reason, "task_not_ready");
        assert.match(error.message, /上一轮 wait-all 尚未完成/);
        return true;
      },
    );
    const whileRunning = await getTask(host, root, first.parentTaskId);
    assert.equal(whileRunning.shards[0].attempts.length, 1, "拒绝路径不得追加 attempt");

    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(started[1].childId), { turn: 2, messageId: started[1].messageId });

    // role 不一致。
    await assert.rejects(
      () => callFanout(host, root, {
        role: "designer",
        basePrompt: "x",
        shards: SHARDS_TWO,
        continuation: { parentTaskId: first.parentTaskId },
      }),
      (error) => {
        assert.equal(error.reason, "role_mismatch");
        assert.match(error.message, /role 必须与原任务一致/);
        return true;
      },
    );

    // 分片数量不一致。
    await assert.rejects(
      () => continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "只有一片" }]),
      (error) => {
        assert.equal(error.reason, "shard_count_mismatch");
        return true;
      },
    );

    // shardId 结构不一致（数量相同但缺一个原分片）。
    await assert.rejects(
      () => continueFanout(host, root, first.parentTaskId, [
        { shardId: "s1", prompt: "a" },
        { shardId: "s3", prompt: "b" },
      ]),
      (error) => {
        assert.equal(error.reason, "shard_ids_mismatch");
        assert.equal(error.detail.missing, "s2");
        return true;
      },
    );

    // 其它 root 的 parentTaskId：归属校验 fail-closed。
    await assert.rejects(
      () => continueFanout(host, other, first.parentTaskId, SHARDS_TWO),
      (error) => {
        assert.equal(error.reason, "not_owned_by_root");
        return true;
      },
    );

    // 未知 parentTaskId：归属解析拿不到 owner，一律按 not_owned_by_root 拒绝（fail-closed，
    // 不泄露其它 root 是否存在该任务）。
    await assert.rejects(
      () => continueFanout(host, root, "fanout-does-not-exist", SHARDS_TWO),
      (error) => {
        assert.equal(error.reason, "not_owned_by_root");
        return true;
      },
    );

    // 以上全部拒绝都不得修改任务与 attempt 历史。
    const after = await getTask(host, root, first.parentTaskId);
    assert.equal(after.round, 1);
    assert.deepEqual(after.shards.map((shard) => shard.attempts.length), [1, 1]);
    assert.equal(after.status, "completed");
  } finally {
    await host.dispose();
  }
});

test("多轮复用：duplicate requestId 幂等，并发续作不重复追加 attempt 或新建 child", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-idempotent");
    const first = await submitFanout(host, root, SHARDS_TWO);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(started[1].childId), { turn: 2, messageId: started[1].messageId });

    const nextShards = [
      { shardId: "s1", prompt: "第二轮 s1" },
      { shardId: "s2", prompt: "第二轮 s2" },
    ];
    // 并发两次（不同 requestId）：只有一个能提交，另一个必须因「上一轮（新一轮）未完成」被拒。
    const settled = await Promise.allSettled([
      continueFanout(host, root, first.parentTaskId, nextShards, { requestId: "continue-round-2a" }),
      continueFanout(host, root, first.parentTaskId, nextShards, { requestId: "continue-round-2b" }),
    ]);
    const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
    const rejected = settled.filter((entry) => entry.status === "rejected");
    assert.equal(fulfilled.length, 1, "并发续作只允许一次成功");
    assert.equal(rejected.length, 1, "并发续作必须拒绝另一次，不能重复追加 attempt");
    assert.equal(rejected[0].reason.reason, "task_not_ready");
    await flushAsyncWork();
    const raced = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(raced.shards.map((shard) => shard.attempts.length), [2, 2], "并发只追加一轮");
    assert.equal(raced.round, 2);
    assert.equal(sent.length, 2, "只应对两个分片各投递一次续作 prompt");
    assert.equal(started.length, 2, "续作不得新建 child");

    // 本轮完成后再测同 requestId 串行幂等：第二次相同 requestId 返回 duplicate，不追加 attempt。
    await settleAttempt(host, children.get(started[0].childId), { turn: 3, messageId: sent[0].messageId });
    await settleAttempt(host, children.get(started[1].childId), { turn: 4, messageId: sent[1].messageId });
    const roundThreeShards = [
      { shardId: "s1", prompt: "第三轮 s1" },
      { shardId: "s2", prompt: "第三轮 s2" },
    ];
    const accepted = await continueFanout(host, root, first.parentTaskId, roundThreeShards, { requestId: "continue-round-3" });
    assert.equal(accepted.round, 3);
    await flushAsyncWork();
    const duplicate = await continueFanout(host, root, first.parentTaskId, roundThreeShards, { requestId: "continue-round-3" });
    assert.equal(duplicate.duplicate, true, "同一 requestId 的重复续作必须幂等");
    assert.equal(duplicate.round, 3);
    const afterDuplicate = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(afterDuplicate.shards.map((shard) => shard.attempts.length), [3, 3], "幂等重复不得追加 attempt");
    assert.equal(afterDuplicate.round, 3);
    assert.equal(sent.length, 4, "幂等重复不得再次投递 prompt");
    // 同一 requestId 指向别的父任务：拒绝（幂等键不能跨任务复用）。
    const second = await submitFanout(host, root, [{ shardId: "only", prompt: "另一个任务" }], { requestId: "other-task" });
    await assert.rejects(
      () => callFanout(host, root, {
        role: "fixer",
        basePrompt: "x",
        shards: [{ shardId: "only", prompt: "x" }],
        continuation: { parentTaskId: second.parentTaskId, requestId: "continue-round-3" },
      }),
      (error) => {
        assert.equal(error.reason, "duplicate_request_id");
        return true;
      },
    );
  } finally {
    await host.dispose();
  }
});

test("多轮复用：旧轮迟到 turn/end 不覆盖最新 attempt，每轮 wait-all 不重复", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-stale");
    const first = await submitFanout(host, root, SHARDS_TWO);
    const childIds = started.map((entry) => entry.childId);
    await settleAttempt(host, children.get(childIds[0]), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(childIds[1]), { turn: 2, messageId: started[1].messageId });

    await continueFanout(host, root, first.parentTaskId, [
      { shardId: "s1", prompt: "第二轮 s1" },
      { shardId: "s2", prompt: "第二轮 s2" },
    ]);
    await flushAsyncWork();
    assert.equal((await getTask(host, root, first.parentTaskId)).status, "pending");

    // 旧轮（第一轮）的迟到 turn/end：其 turn 只包含旧 messageId，必须被忽略。
    const session = children.get(childIds[0]).agent.session;
    session.events = [
      ...session.events,
      { type: "turn/start", data: { turn: 9 } },
      { type: "user/message", data: { id: "stale-round-one-message", role: "user", content: [], source: { kind: "plugin" } } },
    ];
    host.emit("session/event", session, { type: "turn/end", data: { turn: 9, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    const afterStale = await getTask(host, root, first.parentTaskId);
    assert.equal(afterStale.status, "pending", "旧轮迟到 turn/end 不得结算新一轮");
    assert.equal(afterStale.shards[0].attempts.length, 2);
    assert.equal(afterStale.shards[0].attempts[1].status, "running", "新一轮 attempt 必须仍在跑");

    // 本轮真实完成：按 round=2 只结算一次。
    await settleAttempt(host, children.get(childIds[0]), { turn: 10, messageId: sent[0].messageId });
    await settleAttempt(host, children.get(childIds[1]), { turn: 11, messageId: sent[1].messageId });
    const done = await getTask(host, root, first.parentTaskId);
    assert.equal(done.status, "completed");
    assert.equal(done.round, 2);
    const settled = (await getEvents(host, root)).filter((event) => event.type === "task_settled");
    assert.deepEqual(settled.map((event) => event.round), [1, 2], "每轮只发布一次 task_settled");
    const rejected = (await getEvents(host, root)).filter((event) => event.type === "shard_settlement_rejected");
    assert.equal(rejected.length, 0, "旧轮迟到事件不应进入结算（turn 归属不匹配时直接忽略）");
    // 严格归属路径必须为这次迟到 turn/end 留下结构化诊断（不结算 ≠ 无证据）。
    const diagnostics = (await getEvents(host, root)).filter((event) => event.type === "shard_attribution_unproven");
    assert.equal(diagnostics.length, 1, "旧轮迟到 turn/end 必须留下一条归属诊断");
    assert.equal(diagnostics[0].reason, "message_id_mismatch");
    assert.equal(diagnostics[0].shardId, "s1");
    assert.equal(diagnostics[0].attempt, 2);
    assert.equal(diagnostics[0].turn, 9);
  } finally {
    await host.dispose();
  }
});

test("多轮复用：closed root 与关闭的 manager 拒绝续作", async () => {
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-continuation-closed");
    const first = await submitFanout(host, root, SHARDS_TWO);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    await settleAttempt(host, children.get(started[1].childId), { turn: 2, messageId: started[1].messageId });

    // root 关闭（dispose）：不得再续作。
    host.emit("agent/disposed", { agent: root });
    await flushAsyncWork();
    await assert.rejects(
      () => continueFanout(host, root, first.parentTaskId, SHARDS_TWO),
      (error) => {
        assert.ok(
          error.reason === "not_owned_by_root" || error.reason === "runtime_closed"
            || error.reason === "manager_closed" || /root generation is no longer live/.test(error.message),
          "closed root 必须被拒绝: " + error.message,
        );
        return true;
      },
    );
  } finally {
    await host.dispose();
  }
});

test("多轮复用与 root turn 等待协同：每轮重新登记，结算后精确释放，且全程零 goal API", async () => {
  const goals = createGoalService();
  const { host, started, sent, children } = createFanoutHost({ goals });
  try {
    const root = host.registerRootAgent("root-continuation-goal");
    const first = await submitFanout(host, root, [{ shardId: "only", prompt: "唯一分片" }]);
    assert.deepEqual(goals.calls, [], "提交 fan-out 不得调用任何 goal API");

    const childId = started[0].childId;
    // 第 1 轮
    await settleAttempt(host, children.get(childId), { turn: 1, messageId: started[0].messageId });
    // 第 2 轮
    const second = await continueFanout(host, root, first.parentTaskId, [{ shardId: "only", prompt: "第 2 轮" }]);
    assert.equal(second.round, 2);
    await flushAsyncWork();
    await settleAttempt(host, children.get(childId), { turn: 2, messageId: sent[0].messageId });
    // 第 3 轮
    const third = await continueFanout(host, root, first.parentTaskId, [{ shardId: "only", prompt: "第 3 轮" }]);
    assert.equal(third.round, 3);
    await flushAsyncWork();
    await settleAttempt(host, children.get(childId), { turn: 3, messageId: sent[1].messageId });

    assert.deepEqual(goals.calls, [], "续作/结算路径同样不得调用任何 goal API");
    const task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.round, 3);
    assert.deepEqual(task.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded", "succeeded"]);
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// manager 级用例：只依赖注入 seam（launcher / continuer / persistence）
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * 可续作的 manager 脚手架：
 * - launcher：每次调用新建一个 child（可控完成句柄），记录入参；
 * - continuer：把新一轮 prompt 投递给 input.childId（可控完成句柄），记录入参；
 * - persistence：记录每次状态变化后立即拿到的快照。
 * withContinuer=false 用于验证「未接线续作时 fail-closed」。
 * withPersistence=false 用于**不关心 saves 断言**的用例：persistence 接缝会让 manager 在
 * 每次状态变化后整份快照序列化 + 字节估算，规模用例（数百次状态变化）会因此被拖到秒级，
 * 而它并不读取 saves。默认 true，既有用例行为不变。
 */
function createContinuableManager({ withContinuer = true, withPersistence = true, prefix = "child", config = {} } = {}) {
  const launches = [];
  const continuations = [];
  const saves = [];
  const launcher = (input) => {
    const gate = deferred();
    const handle = {
      childId: prefix + "-" + (launches.length + 1),
      messageId: prefix + "-message-" + (launches.length + 1),
      completion: gate.promise,
    };
    launches.push({ input, handle, gate });
    return handle;
  };
  const continuer = withContinuer
    ? (input) => {
      const gate = deferred();
      const handle = {
        childId: input.childId,
        messageId: prefix + "-cont-message-" + (continuations.length + 1),
        continuation: true,
        completion: gate.promise,
      };
      continuations.push({ input, handle, gate });
      return handle;
    }
    : undefined;
  const manager = createFanoutManager({
    launcher,
    ...(continuer === undefined ? {} : { continuer }),
    // 只有断言 saves 的用例才接线 persistence（见 withPersistence 说明）。
    ...(withPersistence ? { persistence: { save: (snapshot) => saves.push(snapshot) } } : {}),
    ...config,
  });
  const events = [];
  manager.subscribe((event) => events.push(event));
  return { manager, launches, continuations, saves, events };
}

/** 等待调度器把可派发工作全部派发完（两次 whenIdle 覆盖 admission 落地后的再调度）。 */
async function drainIdle(manager) {
  await manager.whenIdle();
  await manager.whenIdle();
}


/** 能力测试专用假时钟：驱动超时路径，不真实等待（与 fanout.test.mjs 同一 seam）。 */
function createCapabilityClock() {
  let now = 1000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => {
      const id = ++nextId;
      timers.set(id, { callback, remainingMs: delayMs });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      const due = [];
      for (const [id, timer] of timers.entries()) {
        timer.remainingMs -= ms;
        if (timer.remainingMs <= 0) due.push([id, timer]);
      }
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

const MANAGER_SHARDS = [
  { shardId: "s1", prompt: "第一片" },
  { shardId: "s2", prompt: "第二片" },
];

function reasonOf(result) {
  return result?.reason ?? result?.code;
}

test("manager continuation：复用同一 childId 追加 attempt，结构化拒绝不改变状态", async () => {
  const { manager, launches, continuations, saves, events } = createContinuableManager();
  const submitted = manager.submit({ role: "fixer", basePrompt: "共享目标", shards: MANAGER_SHARDS });
  const parentTaskId = submitted.parentTaskId;
  await drainIdle(manager);
  assert.equal(launches.length, 2);

  // 第一轮未完成：拒绝且不追加 attempt。
  assert.equal(reasonOf(manager.continueTask({ parentTaskId, role: "fixer", basePrompt: "b2", shards: MANAGER_SHARDS })), "task_not_ready");
  assert.deepEqual(manager.getTask(parentTaskId).shards.map((shard) => shard.attempts.length), [1, 1]);

  launches[0].gate.resolve({ text: "完成" });
  launches[1].gate.resolve({ text: "完成" });
  await drainIdle(manager);
  assert.equal(manager.getTask(parentTaskId).status, "completed");
  assert.equal(manager.getTask(parentTaskId).continuable, true);

  // 结构一致性拒绝：role / 数量 / shardId 集合。
  assert.equal(reasonOf(manager.continueTask({ parentTaskId, role: "designer", basePrompt: "b2", shards: MANAGER_SHARDS })), "role_mismatch");
  assert.equal(reasonOf(manager.continueTask({ parentTaskId, role: "fixer", basePrompt: "b2", shards: [{ shardId: "s1", prompt: "x" }] })), "shard_count_mismatch");
  assert.equal(reasonOf(manager.continueTask({
    parentTaskId,
    role: "fixer",
    basePrompt: "b2",
    shards: [{ shardId: "s1", prompt: "x" }, { shardId: "s3", prompt: "y" }],
  })), "shard_ids_mismatch");
  assert.equal(reasonOf(manager.continueTask({ parentTaskId: "fanout-missing", role: "fixer", basePrompt: "b2", shards: MANAGER_SHARDS })), "unknown_parent_task");
  assert.equal(reasonOf(manager.continueTask({ role: "fixer", basePrompt: "b2", shards: MANAGER_SHARDS })), "missing_parent_task_id");
  assert.deepEqual(manager.getTask(parentTaskId).shards.map((shard) => shard.attempts.length), [1, 1], "拒绝路径不得追加 attempt");

  // 成功续作：launcher 不再被调用，continuer 拿到每个分片的原 childId。
  const result = manager.continueTask({
    parentTaskId,
    role: "fixer",
    basePrompt: "第二轮共享目标",
    shards: [{ shardId: "s2", prompt: "第二轮 s2" }, { shardId: "s1", prompt: "第二轮 s1" }],
  });
  assert.equal(result.accepted, true);
  assert.equal(result.round, 2);
  assert.deepEqual(result.nextAttemptByShard, { s1: 2, s2: 2 });
  assert.equal(manager.getTask(parentTaskId).status, "pending", "复用提交后立即回到 pending（投影 = running）");
  await drainIdle(manager);
  assert.equal(launches.length, 2, "续作不得再调用 launcher");
  assert.deepEqual(continuations.map((entry) => entry.input.childId), ["child-1", "child-2"]);
  assert.deepEqual(continuations.map((entry) => entry.input.attempt), [2, 2]);
  assert.deepEqual(continuations.map((entry) => entry.input.prompt), ["第二轮 s1", "第二轮 s2"]);
  assert.deepEqual(continuations.map((entry) => entry.input.round), [2, 2]);
  const task = manager.getTask(parentTaskId);
  assert.deepEqual(task.shards.map((shard) => shard.attempts.map((attempt) => [attempt.attempt, attempt.childId])), [
    [[1, "child-1"], [2, "child-1"]],
    [[1, "child-2"], [2, "child-2"]],
  ], "新 attempt 复用原 childId，旧 attempt 历史保留");

  // 第二轮 wait-all 完成后：快照必须带上轮次与新 attempt。
  continuations[0].gate.resolve({ text: "第二轮完成" });
  continuations[1].gate.resolve({ text: "第二轮完成" });
  await drainIdle(manager);
  const snapshotTask = manager.snapshot().tasks.find((entry) => entry.parentTaskId === parentTaskId);
  assert.equal(snapshotTask.round, 2, "快照必须持久化逻辑轮次");
  assert.deepEqual(snapshotTask.shards.map((shard) => shard.attempts.length), [2, 2]);
  assert.ok(saves.length > 0, "每次状态变化后必须持久化");
  assert.equal(snapshotTask.status, "completed");
  // 事件面：task_continued 与两轮 task_settled 都必须带 round（消费方据此区分轮次）。
  const continued = events.filter((event) => event.type === "task_continued");
  assert.deepEqual(continued.map((event) => event.round), [2]);
  assert.deepEqual(continued[0].nextAttemptByShard, { s1: 2, s2: 2 });
  const settled = events.filter((event) => event.type === "task_settled");
  assert.deepEqual(settled.map((event) => event.round), [1, 2], "每轮 wait-all 只结算一次");
});

test("manager continuation：未接线 continuer 时 fail-closed 为本轮启动失败，历史保持一致", async () => {
  const { manager, launches } = createContinuableManager({ withContinuer: false });
  const submitted = manager.submit({ role: "fixer", basePrompt: "共享目标", shards: [{ shardId: "s1", prompt: "第一片" }] });
  await drainIdle(manager);
  launches[0].gate.resolve({ text: "完成" });
  await drainIdle(manager);
  assert.equal(manager.getTask(submitted.parentTaskId).status, "completed");

  const result = manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮 s1" }],
  });
  assert.equal(result.accepted, true, "提交本身被接受（校验通过）");
  await drainIdle(manager);
  const task = manager.getTask(submitted.parentTaskId);
  assert.equal(task.status, "completed_with_errors", "无法复用时本轮 attempt 显式失败，不静默换 child");
  assert.equal(task.shards[0].attempts.length, 2);
  assert.equal(task.shards[0].attempts[0].status, "succeeded", "旧 attempt 历史不受影响");
  assert.equal(task.shards[0].attempts[1].status, "failed");
  assert.match(task.shards[0].attempts[1].error.message, /continuation/);
  assert.equal(launches.length, 1, "绝不为复用新建 child");
});

test("manager continuation：attempt 预算耗尽整体拒绝，不产生半写", async () => {
  const env = createContinuableManager();
  const submitted = env.manager.submit({ role: "fixer", basePrompt: "共享目标", shards: [{ shardId: "s1", prompt: "第一片" }] });
  await drainIdle(env.manager);
  let round = 1;
  let latest = env.launches[0];
  while (round < FANOUT_BUDGET.maxAttemptsPerShard) {
    latest.gate.resolve({ text: "完成 " + round });
    await drainIdle(env.manager);
    const result = env.manager.continueTask({
      parentTaskId: submitted.parentTaskId,
      role: "fixer",
      basePrompt: "第 " + (round + 1) + " 轮",
      shards: [{ shardId: "s1", prompt: "第 " + (round + 1) + " 轮" }],
    });
    assert.equal(result.accepted, true, "预算内的复用必须被接受");
    round += 1;
    await drainIdle(env.manager);
    latest = env.continuations[env.continuations.length - 1];
  }
  // 已用满 attempt 预算：本轮完成后再次复用必须整体拒绝。
  latest.gate.resolve({ text: "最后一轮完成" });
  await drainIdle(env.manager);
  const before = env.manager.getTask(submitted.parentTaskId);
  assert.equal(before.shards[0].attempts.length, FANOUT_BUDGET.maxAttemptsPerShard);
  const rejected = env.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "超预算",
    shards: [{ shardId: "s1", prompt: "超预算" }],
  });
  assert.equal(rejected.accepted, false);
  assert.equal(reasonOf(rejected), "attempt_budget_exceeded");
  const after = env.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(after.shards.map((shard) => shard.attempts.length), before.shards.map((shard) => shard.attempts.length), "预算拒绝不得追加 attempt");
  assert.equal(after.round, before.round);
});


test("票据 09：manager 逐动作能力——运行中/停止未确认/终态/attempt 用尽", async () => {
  const env = createContinuableManager();
  const submitted = env.manager.submit({ role: "fixer", basePrompt: "共享目标", shards: [{ shardId: "s1", prompt: "第一片" }] });
  const parentTaskId = submitted.parentTaskId;
  await drainIdle(env.manager);

  // ① 运行中：取消允许；重试/续作因任务未终态明确拒绝。
  let caps = env.manager.taskCapabilities(parentTaskId);
  assert.deepEqual(caps.read, { allowed: true });
  assert.deepEqual(caps.cancel, { allowed: true });
  assert.deepEqual(caps.retry, { allowed: false, reason: "task_not_terminal" });
  assert.deepEqual(caps.continue, { allowed: false, reason: "task_not_terminal" });
  assert.deepEqual(caps.shards.s1.cancel, { allowed: true });
  assert.deepEqual(caps.shards.s1.retry, { allowed: false, reason: "task_not_terminal" });

  // ② 取消运行中分片：逻辑终态但停止未确认 → 重试必须 stop_unconfirmed（与写入口同因）。
  assert.equal(env.manager.cancelShard(parentTaskId, "s1").accepted, true);
  caps = env.manager.taskCapabilities(parentTaskId);
  assert.deepEqual(caps.shards.s1.cancel, { allowed: false, reason: "already_terminal" });
  assert.deepEqual(caps.shards.s1.retry, { allowed: false, reason: "stop_unconfirmed" });
  assert.deepEqual(caps.retry, { allowed: false, reason: "stop_unconfirmed" });
  assert.deepEqual(caps.cancel, { allowed: true }, "停止未确认的父任务仍需保留取消/等待入口");

  // ③ 停止证据到达：任务终态 → 取消 already_terminal；可重试终态 → retry/continue 允许。
  const firstIdentity = env.manager.attemptIdentityOf(parentTaskId, "s1", 1);
  assert.equal(env.manager.observeStopEvidence(firstIdentity, { source: "child_turn_end", turn: 1 }).accepted, true);
  caps = env.manager.taskCapabilities(parentTaskId);
  assert.deepEqual(caps.cancel, { allowed: false, reason: "already_terminal" });
  assert.deepEqual(caps.shards.s1.cancel, { allowed: false, reason: "already_terminal" });
  assert.deepEqual(caps.shards.s1.retry, { allowed: true });
  assert.deepEqual(caps.retry, { allowed: true });
  assert.deepEqual(caps.continue, { allowed: true });

  // ④ 把 attempt 打到上限：每轮重试后取消并补停止证据，保证 stop gate 不抢先。
  for (let index = 1; index < FANOUT_BUDGET.maxAttemptsPerShard; index += 1) {
    const retried = env.manager.retryShard(parentTaskId, "s1");
    assert.equal(retried.accepted, true, "第 " + (index + 1) + " 个 attempt 仍在预算内");
    await drainIdle(env.manager);
    const attemptNumber = env.manager.getTask(parentTaskId).shards[0].attempts.length;
    assert.equal(env.manager.cancelShard(parentTaskId, "s1").accepted, true);
    const identity = env.manager.attemptIdentityOf(parentTaskId, "s1", attemptNumber);
    assert.equal(
      env.manager.observeStopEvidence(identity, { source: "child_turn_end", turn: attemptNumber }).accepted,
      true,
      "停止证据必须精确归属到当前 attempt",
    );
  }
  assert.equal(
    env.manager.getTask(parentTaskId).shards[0].attempts.length,
    FANOUT_BUDGET.maxAttemptsPerShard,
    "前置：attempt 预算已经用尽",
  );
  caps = env.manager.taskCapabilities(parentTaskId);
  assert.deepEqual(caps.shards.s1.retry, { allowed: false, reason: "attempt_limit" });
  assert.deepEqual(caps.retry, { allowed: false, reason: "attempt_limit" });
  assert.deepEqual(caps.continue, { allowed: false, reason: "attempt_limit" });
  assert.deepEqual(caps.cancel, { allowed: false, reason: "already_terminal" });

  // ⑤ 超时且停止未观测：retry/continue 都必须给出 stop_unconfirmed（与取消路径同一 gate），
  //    防止界面把「逻辑终态」误当成「执行已停止」而允许并发重试。
  const clock = createCapabilityClock();
  const timeoutEnv = createContinuableManager({ config: { clock } });
  const timeoutSubmitted = timeoutEnv.manager.submit({
    role: "fixer",
    basePrompt: "超时目标",
    shards: [{ shardId: "s1", prompt: "超时片", timeoutMs: 1000 }],
  });
  await drainIdle(timeoutEnv.manager);
  clock.advance(1000);
  assert.equal(timeoutEnv.manager.getTask(timeoutSubmitted.parentTaskId).shards[0].status, "timed_out");
  const timeoutCaps = timeoutEnv.manager.taskCapabilities(timeoutSubmitted.parentTaskId);
  assert.deepEqual(timeoutCaps.shards.s1.retry, { allowed: false, reason: "stop_unconfirmed" });
  assert.deepEqual(timeoutCaps.retry, { allowed: false, reason: "stop_unconfirmed" });
  assert.deepEqual(timeoutCaps.continue, { allowed: false, reason: "stop_unconfirmed" });

  // ⑥ 不存在的任务：全部 task_not_found（Host 据此映射 404）。
  const missing = env.manager.taskCapabilities("fanout-does-not-exist");
  assert.equal(missing.read.allowed, false);
  assert.equal(missing.read.reason, "task_not_found");
  assert.deepEqual(missing.shards, {});
  // 纯读：能力查询不得改变任务、attempt 或轮次。
  const before = env.manager.getTask(parentTaskId);
  env.manager.taskCapabilities(parentTaskId);
  assert.deepEqual(env.manager.getTask(parentTaskId), before);
});

test("manager continuation：快照恢复保留轮次与 attempt 历史，恢复后可继续下一轮", async () => {
  const env = createContinuableManager({ prefix: "first" });
  const submitted = env.manager.submit({ role: "fixer", basePrompt: "共享目标", shards: MANAGER_SHARDS });
  await drainIdle(env.manager);
  env.launches[0].gate.resolve({ text: "第一轮 s1" });
  env.launches[1].gate.resolve({ text: "第一轮 s2" });
  await drainIdle(env.manager);
  env.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮 s1" }, { shardId: "s2", prompt: "第二轮 s2" }],
  });
  await drainIdle(env.manager);
  // 第二轮运行中先取一份快照：恢复时 running attempt 收敛为 interrupted，并派发新 attempt。
  const midRound = env.manager.snapshot();
  env.continuations[0].gate.resolve({ text: "第二轮 s1" });
  env.continuations[1].gate.resolve({ text: "第二轮 s2" });
  await drainIdle(env.manager);
  const snapshot = env.manager.snapshot();

  // 冷恢复（本轮已终态）：round 与 attempt 历史必须完整还原，且任务仍可继续。
  const restored = createContinuableManager({ prefix: "restored" });
  restored.manager.restore(snapshot, { resume: false });
  const task = restored.manager.getTask(submitted.parentTaskId);
  assert.equal(task.round, 2, "轮次必须随快照持久化并恢复");
  assert.deepEqual(task.shards.map((shard) => shard.attempts.map((attempt) => [attempt.attempt, attempt.childId])), [
    [[1, "first-1"], [2, "first-1"]],
    [[1, "first-2"], [2, "first-2"]],
  ], "旧 attempt 历史（含 childId）恢复后不得丢失或改写");
  assert.equal(task.continuable, true, "恢复后全部最新 attempt 已终态，仍可继续");

  const result = restored.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第三轮",
    shards: [{ shardId: "s1", prompt: "第三轮 s1" }, { shardId: "s2", prompt: "第三轮 s2" }],
  });
  assert.equal(result.round, 3, "恢复后继续复用必须接着原有轮次递增");
  await drainIdle(restored.manager);
  // 复用语义不因重启而改变：新一轮仍然指向历史 childId（同一 childId 的新 attempt）。
  // 若该 child 已不可继续，Host 的 sendMessage 会显式失败，而不是静默换 child。
  assert.equal(restored.launches.length, 0, "恢复后的续作不得新建 child");
  assert.deepEqual(restored.continuations.map((entry) => entry.input.childId), ["first-1", "first-2"]);
  assert.deepEqual(restored.continuations.map((entry) => entry.input.attempt), [3, 3]);
  const third = restored.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(third.shards.map((shard) => shard.attempts.map((attempt) => attempt.attempt)), [[1, 2, 3], [1, 2, 3]]);

  // 冷恢复（本轮进行中）：未终态 attempt 收敛为 interrupted，resume 用新 attempt 重新派发，
  // 且恢复派发一律走 launcher 新建 child（continuation 标记不持久化）。
  const midRestored = createContinuableManager({ prefix: "mid" });
  // 票据 07：这里模拟进程重启边界（执行体所属进程已终止），因此快照内的 attempt 可视为
  // 已确认停止；默认的 unknown 边界会拒绝为"停止未确认"的中断分片自动追加 attempt。
  midRestored.manager.restore(midRound, { resume: true, stopEvidenceBoundary: "process-restart" });
  await drainIdle(midRestored.manager);
  const midTask = midRestored.manager.getTask(submitted.parentTaskId);
  assert.equal(midTask.round, 2, "恢复必须保留进行中的轮次");
  assert.deepEqual(midTask.shards.map((shard) => shard.attempts.map((attempt) => attempt.status)), [
    ["succeeded", "interrupted", "running"],
    ["succeeded", "interrupted", "running"],
  ], "恢复把未终态 attempt 记为 interrupted，并追加新的 attempt 后重新派发");
  assert.equal(midRestored.launches.length, 2, "恢复派发走 launcher 新建 child");
  assert.deepEqual(midRestored.launches.map((entry) => entry.input.attempt), [3, 3]);
  assert.equal(midRestored.continuations.length, 0, "恢复后的新 attempt 不复用已丢失的 child");
});

test("manager continuation：恢复入口把虚高 round 钳到可证明上界，真实 retry 仍被侧栏计为 1 次", async () => {
  // 缺陷路径（oracle 复审）：损坏/裁剪快照可能写下 round 大于任一分片 attempt 数的值；
  // 恢复后只要发生一次真实 retryShard，attempts.length 就追平这个虚高 round，投影端
  // retryCount = attempts.length − max(1, min(attempts.length, round)) 会把这次真实重试
  // 静默漏计。修复位置在恢复入口（fanout/restore.js 的 commitRestorePlan）。
  const env = createContinuableManager();
  const submitted = env.manager.submit({
    role: "fixer",
    basePrompt: "共享目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  const parentTaskId = submitted.parentTaskId;
  await drainIdle(env.manager);
  env.launches[0].gate.resolve({ text: "第一轮完成" });
  await drainIdle(env.manager);
  // 真实第 2 轮：round=2，分片恰好 2 条 attempt（真实 continuation 的唯一合法形状）。
  const continued = env.manager.continueTask({
    parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮 s1" }],
  });
  assert.equal(continued.round, 2);
  await drainIdle(env.manager);
  assert.equal(env.manager.getTask(parentTaskId).round, 2);
  // 在第 2 轮运行中取快照：恢复后 running attempt 收敛为 interrupted（可重试终态），
  // 这样 retryShard 才是合法动作——成功终态按契约不可重试（not_retryable）。
  const midRound = env.manager.snapshot();
  // 人为损坏快照：round=3，但分片只有 2 条 attempt（round > attempts.length）。
  const corrupted = {
    ...midRound,
    tasks: midRound.tasks.map((task) => (task.parentTaskId === parentTaskId ? { ...task, round: 3 } : task)),
  };

  const restored = createContinuableManager({ prefix: "restored" });
  // process-restart 边界：模拟进程重启，恢复后的 interrupted attempt 视为「停止已确认」，retry 可放行。
  restored.manager.restore(corrupted, { resume: false, stopEvidenceBoundary: "process-restart" });
  const restoredTask = restored.manager.getTask(parentTaskId);
  assert.equal(restoredTask.round, 2, "虚高 round 必须钳到可证明上界（各分片 attempts.length 的最小值）");
  assert.equal(restoredTask.shards[0].attempts.length, 2, "钳位不得改动 attempt 历史");
  assert.equal(restoredTask.shards[0].attempts[1].status, "interrupted", "运行中的 attempt 恢复后记为 interrupted");

  // 真实重试：只追加 attempt、不推进逻辑轮次。
  const retried = restored.manager.retryShard(parentTaskId, "s1");
  assert.equal(retried.accepted, true, "interrupted 终态分片在停止已确认时可重试");
  await drainIdle(restored.manager);
  const afterRetry = restored.manager.getTask(parentTaskId);
  assert.equal(afterRetry.shards[0].attempts.length, 3, "重试必须追加第 3 条 attempt");
  assert.equal(afterRetry.round, 2, "重试不得推进逻辑轮次");

  // 侧栏投影：第 3 条 attempt 是真实重试，必须计为 retryCount=1（这正是漏计场景）。
  const projected = buildExpertGroupSnapshot({
    sessionId: "root-restore-round-clamp",
    root: { id: "root-restore-round-clamp", status: "running" },
    experts: [],
    fanoutTasks: [afterRetry],
    generatedAt: 1,
  });
  const node = projected.root.children.find((child) => child.kind === "fanout");
  assert.ok(node !== undefined, "父任务必须出现在 Expert Group 快照里");
  assert.equal(node.shards[0].attemptCount, 3);
  assert.equal(node.shards[0].retryCount, 1, "恢复钳位后的真实重试必须计入分片 retryCount");
  assert.equal(node.retryCount, 1, "父任务 retryCount = 各分片真实重试之和");
});

// ---------------------------------------------------------------------------
// Oracle 复审 P1/P2：执行前置条件、turn 归属 fail-closed、requestId 持久化幂等
// ---------------------------------------------------------------------------

/** 断言续作被结构化拒绝，并返回错误对象（reason/ownership 等字段供进一步断言）。 */
async function expectContinuationRejected(promise, { reason } = {}) {
  let failure;
  await promise.then(
    (value) => { failure = new Error("expected rejection, got: " + JSON.stringify(value)); },
    (error) => { failure = error; },
  );
  assert.ok(failure !== undefined, "续作必须被拒绝");
  assert.equal(failure.name, "FanoutContinuationError", "拒绝必须是结构化 continuation 错误: " + failure.message);
  if (reason !== undefined) assert.equal(failure.reason, reason, failure.message);
  return failure;
}

test("P1：冷恢复后的终态任务续作必须结构化拒绝，且任务历史与事件不变", async () => {
  // 1) 上一代实例：跑完一轮（终态）并真实落盘 fan-out 快照。
  const source = createFanoutHost();
  let snapshot;
  try {
    const root = source.host.registerRootAgent("root-cold-continuation");
    const first = await submitFanout(source.host, root, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(source.host, source.children.get(source.started[0].childId), {
      turn: 1,
      messageId: source.started[0].messageId,
    });
    await flushAsyncWork(10);
    const stored = source.host.storage.entries("fanout_tasks").find(([key]) => key === "current")?.[1];
    assert.ok(stored !== undefined, "上一代实例必须真实落盘 fan-out 快照");
    assert.equal(stored.tasks[0].status, "completed");
    snapshot = { stored, parentTaskId: first.parentTaskId };
  } finally {
    await source.host.dispose();
  }

  // 2) 冷恢复实例：同一个 root session id 重新注册（restore 会把终态任务的 ownership 归还）。
  const cold = createColdHost({ snapshot: snapshot.stored });
  try {
    const root = cold.host.registerRootAgent("root-cold-continuation");
    await flushAsyncWork(10);
    const before = storedTask(cold.host, snapshot.parentTaskId);
    assert.equal(before?.status, "completed", "冷恢复必须还原终态任务");
    // 票据 09：冷恢复的已结算任务对**读路径**可见（与侧栏快照一致），但写动作仍然
    // 没有 live 绑定证据，因此能力投影只允许 read。
    const read = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: root.id,
      parentTaskId: snapshot.parentTaskId,
    });
    assert.equal(read.ok, true, "冷恢复后的已结算任务必须可读");
    assert.equal(read.value.task.status, "completed");
    assert.deepEqual(read.value.task.capabilities.cancel, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(read.value.task.capabilities.retry, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(read.value.task.capabilities.read, { allowed: true });

    // 续作：没有活动 ownership / exact 代际证据 → 必须在任何状态修改前拒绝。
    const error = await expectContinuationRejected(
      continueFanout(cold.host, root, snapshot.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]),
      { reason: "not_owned_by_root" },
    );
    assert.equal(error.detail?.ownership, "no_active_binding", "拒绝原因必须指出没有活动绑定: " + error.message);
    await flushAsyncWork(10);

    const after = storedTask(cold.host, snapshot.parentTaskId);
    assert.deepEqual(after, before, "拒绝不得改变持久化的任务历史（轮次/attempt/状态）");
    assert.equal(after.round, 1, "拒绝不得推进轮次");
    assert.deepEqual(after.shards.map((shard) => shard.attempts.length), [1], "拒绝不得追加 attempt");
    const continuedEvents = (storedSnapshot(cold.host)?.events ?? []).filter((event) => event.type === "task_continued");
    assert.equal(continuedEvents.length, 0, "拒绝不得发布 task_continued");
    assert.equal(cold.sent.length, 0, "拒绝不得投递任何续作 prompt");
  } finally {
    await cold.host.dispose();
  }
});

test("票据 09：冷恢复已结算任务在 list/get/events/侧栏中一致，写动作返回 owner_not_live", async () => {
  // 1) 上一代实例：跑完一片并真实落盘（冷恢复后是「已终态 + 已归还 ownership」形态）。
  const source = createFanoutHost();
  let stored;
  let parentTaskId;
  try {
    const root = source.host.registerRootAgent("root-cold-capabilities");
    const accepted = await submitFanout(source.host, root, [{ shardId: "s1", prompt: "只跑一片" }]);
    parentTaskId = accepted.parentTaskId;
    await settleAttempt(source.host, source.children.get(source.started[0].childId), {
      turn: 1,
      messageId: source.started[0].messageId,
    });
    await flushAsyncWork(10);
    stored = source.host.storage.entries("fanout_tasks").find(([key]) => key === "current")?.[1];
    assert.ok(stored, "上一代实例必须真实落盘");
  } finally {
    await source.host.dispose();
  }

  const cold = createColdHost({ snapshot: stored });
  try {
    const root = cold.host.registerRootAgent("root-cold-capabilities");
    await flushAsyncWork(10);

    // 2) list 与 get 的能力投影必须逐字段一致，且读允许、写 owner_not_live。
    const list = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-list", sessionId: root.id });
    assert.equal(list.ok, true);
    const listed = list.value.tasks.find((task) => task.parentTaskId === parentTaskId);
    assert.ok(listed, "冷恢复的已结算任务必须出现在 list 中");
    assert.deepEqual(listed.capabilities.read, { allowed: true });
    assert.deepEqual(listed.capabilities.cancel, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(listed.capabilities.retry, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(listed.capabilities.continue, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(listed.capabilities.shards.s1.cancel, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(listed.capabilities.shards.s1.retry, { allowed: false, reason: "owner_not_live" });

    const got = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: root.id,
      parentTaskId,
    });
    assert.equal(got.ok, true, "冷恢复的已结算任务必须可读");
    assert.deepEqual(got.value.capabilities, listed.capabilities, "get 与 list 的能力投影必须一致");
    assert.deepEqual(got.value.task.capabilities, listed.capabilities, "任务快照与顶层能力必须同源");
    assert.deepEqual(got.value.task.shards[0].capabilities, listed.capabilities.shards.s1);

    const events = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-events", sessionId: root.id, after: 0 });
    assert.equal(events.ok, true, "冷恢复的已结算任务事件必须可读");
    assert.ok(events.value.events.length > 0, "事件历史必须保留");
    assert.ok(events.value.events.every((event) => event.parentTaskId === parentTaskId));

    const snapshot = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "expert-group-snapshot",
      sessionId: root.id,
    });
    assert.equal(snapshot.ok, true);
    const node = snapshot.value.snapshot.root.children.find((child) => child.kind === "fanout" && child.parentTaskId === parentTaskId);
    assert.ok(node, "侧栏快照必须包含该任务");
    // 快照节点把任务级能力与 shard 能力分居两层（父节点 + 各 shard 节点）：
    // 逐动作值与 list 的同一来源完全一致，只是容器按树形展开。
    assert.deepEqual(node.capabilities, {
      read: listed.capabilities.read,
      cancel: listed.capabilities.cancel,
      retry: listed.capabilities.retry,
      continue: listed.capabilities.continue,
    }, "侧栏与 list 的任务级能力投影必须一致");
    assert.deepEqual(node.shards[0].capabilities, listed.capabilities.shards.s1, "shard 能力同样必须一致");

    // 3) 写动作：任务已知且归属匹配，但没有 live 写绑定 → 200 + accepted:false + owner_not_live。
    for (const request of [
      { action: "fanout-cancel-parent", parentTaskId },
      { action: "fanout-cancel-shard", parentTaskId, shardId: "s1" },
      { action: "fanout-retry-shard", parentTaskId, shardId: "s1" },
    ]) {
      const response = await cold.host.invokeConnection(RPC_ENDPOINT, { ...request, sessionId: root.id });
      assert.equal(response.ok, true, request.action + " 必须返回可读回执");
      assert.equal(response.value.accepted, false, request.action + " 不得真正执行");
      assert.equal(response.value.reason, "owner_not_live");
      assert.equal(response.value.task.parentTaskId, parentTaskId, "拒绝回执仍附带任务快照");
      assert.deepEqual(response.value.capabilities, listed.capabilities, "写拒绝回执的能力必须与读路径一致");
    }

    // 4) 非归属 root：list 为空，get/events(指定任务)/写动作全部 404，且不泄露任务存在性。
    const other = cold.host.registerRootAgent("root-cold-other");
    const otherList = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-list", sessionId: other.id });
    assert.equal(otherList.ok, true);
    assert.deepEqual(otherList.value.tasks, [], "非归属 root 的 list 必须为空");
    const otherEvents = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-events", sessionId: other.id, after: 0 });
    assert.equal(otherEvents.ok, true);
    assert.deepEqual(otherEvents.value.events, [], "非归属 root 不得看到别人的事件");
    for (const request of [
      { action: "fanout-get", parentTaskId },
      { action: "fanout-events", parentTaskId, after: 0 },
      { action: "fanout-cancel-parent", parentTaskId },
      { action: "fanout-retry-shard", parentTaskId, shardId: "s1" },
    ]) {
      const response = await cold.host.invokeConnection(RPC_ENDPOINT, { ...request, sessionId: other.id });
      assert.equal(response.ok, false, request.action + " 必须拒绝非归属 root");
      assert.equal(response.error.code, "not-found", request.action + " 不得暴露任务是否存在");
    }

    // 5) root 下线后：冷恢复根仍可读（归属索引），写仍返回 owner_not_live。
    cold.host.disposeAgent(root);
    await flushAsyncWork(10);
    const offlineList = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-list", sessionId: root.id });
    assert.equal(offlineList.ok, true, "root 不在线但归属索引非空时 list 必须可读");
    assert.deepEqual(offlineList.value.tasks.map((task) => task.parentTaskId), [parentTaskId]);
    const offlineGet = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: root.id,
      parentTaskId,
    });
    assert.equal(offlineGet.ok, true, "冷恢复根必须能按 id 读取已结算任务");
    const offlineEvents = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-events",
      sessionId: root.id,
      after: 0,
      parentTaskId,
    });
    assert.equal(offlineEvents.ok, true, "冷恢复根必须能读指定任务的事件");
    const offlineWrite = await cold.host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-cancel-parent",
      sessionId: root.id,
      parentTaskId,
    });
    assert.equal(offlineWrite.ok, true);
    assert.equal(offlineWrite.value.accepted, false);
    assert.equal(offlineWrite.value.reason, "owner_not_live");

    // 完全未知的 session 仍是 404（不能凭空归属索引枚举任务）。
    const missing = await cold.host.invokeConnection(RPC_ENDPOINT, { action: "fanout-list", sessionId: "root-unknown-cold" });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "session-not-found");
  } finally {
    await cold.host.dispose();
  }
});

test("票据 09：已回收任务返回 task_not_found（不保留墓碑）", async () => {
  /**
   * 模拟「已回收」：持久化的 parentSessions 仍记录归属，但 manager 的 tasks 为空。
   *
   * 这是回收实现（后续票据）会产生的形状；当前代码只能靠 seed 快照构造。
   * 归属匹配 + 任务不存在 ⇒ task_not_found，而不是 not-found（后者留给非归属 root），
   * 也不能因为任务消失就把归属一起抹掉（否则下次同 id 绑定的判定会漂移）。
   */
  const host = createPluginHost({
    settings: SETTINGS,
    storageOptions: {
      seed: {
        fanout_tasks: [["current", {
          schemaVersion: 1,
          sequence: 0,
          processInstance: "proc:test",
          tasks: [],
          events: [],
          parentSessions: { "fanout-reclaimed": "root-reclaimed" },
        }]],
      },
    },
    subagents: { startContinuable: async () => ({ childId: "unused", messageId: "unused" }), interrupt() {} },
  });
  host.apply();
  try {
    const root = host.registerRootAgent("root-reclaimed");
    await flushAsyncWork(10);
    for (const request of [
      { action: "fanout-get", parentTaskId: "fanout-reclaimed" },
      { action: "fanout-events", parentTaskId: "fanout-reclaimed", after: 0 },
      { action: "fanout-cancel-parent", parentTaskId: "fanout-reclaimed" },
      { action: "fanout-retry-shard", parentTaskId: "fanout-reclaimed", shardId: "s1" },
    ]) {
      const response = await host.invokeConnection(RPC_ENDPOINT, { ...request, sessionId: root.id });
      assert.equal(response.ok, false, request.action + " 必须失败");
      assert.equal(response.error.code, "task_not_found", request.action + " 必须返回回收语义");
    }
    // list 仍按 manager 权威数据：没有任务就返回空集，不凭归属索引伪造墓碑。
    const list = await host.invokeConnection(RPC_ENDPOINT, { action: "fanout-list", sessionId: root.id });
    assert.equal(list.ok, true);
    assert.deepEqual(list.value.tasks, []);
  } finally {
    await host.dispose();
  }
});

test("P1：root 被销毁后续作拒绝，任务历史不变", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-disposed-continuation");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    assert.equal((await getTask(host, root, first.parentTaskId)).status, "completed");

    host.emit("agent/disposed", { agent: root });
    await flushAsyncWork(10);

    let failure;
    await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }])
      .then(() => { failure = undefined; }, (error) => { failure = error; });
    assert.ok(failure !== undefined, "已销毁 root 的续作必须被拒绝");
    assert.match(failure.message, /root generation is no longer live/);
    await flushAsyncWork(10);
    const after = storedTask(host, first.parentTaskId);
    assert.equal(after.round, 1);
    assert.deepEqual(after.shards.map((shard) => shard.attempts.length), [1]);
    assert.equal(sent.length, 0, "拒绝不得投递任何续作 prompt");
  } finally {
    await host.dispose();
  }
});

test("P1：同 id root replacement 不得继承旧任务的可写权限", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const firstRoot = host.registerRootAgent("root-replacement");
    const first = await submitFanout(host, firstRoot, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    assert.equal((await getTask(host, firstRoot, first.parentTaskId)).status, "completed");

    // 同 id 新代际：激活新 agent 会 retire 旧代际（releaseAgent + token 失活）。
    const replacement = host.registerRootAgent("root-replacement");
    await flushAsyncWork(10);
    assert.notEqual(replacement, firstRoot, "必须是不同的 exact Agent 对象");

    // 票据 09：归属仍匹配（同 id）时读路径可用，但写绑定证据已随旧代际失效。
    const read = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: replacement.id,
      parentTaskId: first.parentTaskId,
    });
    assert.equal(read.ok, true, "同 id replacement 只要归属匹配就可读");
    assert.deepEqual(read.value.capabilities.read, { allowed: true });
    assert.deepEqual(read.value.capabilities.cancel, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(read.value.capabilities.retry, { allowed: false, reason: "owner_not_live" });
    assert.deepEqual(read.value.task.shards[0].capabilities.retry, { allowed: false, reason: "owner_not_live" });
    const replacementCancel = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-cancel-parent",
      sessionId: replacement.id,
      parentTaskId: first.parentTaskId,
    });
    assert.equal(replacementCancel.ok, true);
    assert.equal(replacementCancel.value.accepted, false);
    assert.equal(replacementCancel.value.reason, "owner_not_live", "同 id replacement 不得继承写权限");

    const error = await expectContinuationRejected(
      continueFanout(host, replacement, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]),
      { reason: "not_owned_by_root" },
    );
    await flushAsyncWork(10);
    assert.equal(error.detail?.ownership, "no_active_binding", error.message);
    const after = storedTask(host, first.parentTaskId);
    assert.equal(after.round, 1, "replacement 不得推进旧任务的轮次");
    assert.deepEqual(after.shards.map((shard) => shard.attempts.length), [1], "replacement 不得追加 attempt");
    assert.equal(sent.length, 0, "replacement 不得投递任何续作 prompt");

    // 反向对照：replacement 自己的新任务可以正常续作（证明拒绝只针对旧代际权限）。
    const own = await submitFanout(host, replacement, [{ shardId: "own", prompt: "新任务" }]);
    await settleAttempt(host, children.get(started[1].childId), { turn: 2, messageId: started[1].messageId });
    const continued = await continueFanout(host, replacement, own.parentTaskId, [{ shardId: "own", prompt: "新任务第二轮" }]);
    assert.equal(continued.accepted, true);
    assert.equal(continued.round, 2);
  } finally {
    await host.dispose();
  }
});

test("P1：lineage 绑定代际证据语义（只有绑定时的 live 代际才能授权写路径）", () => {
  const roots = new Map();
  const disposed = new WeakSet();
  const lineage = createLineageModule({
    disposedRoots: disposed,
    isRootAgent: (agent) => agent !== null && typeof agent === "object" && agent.kind === "root",
    getAgent: (id) => roots.get(id),
  });
  const rootA = { id: "root-gen", kind: "root" };
  roots.set(rootA.id, rootA);
  lineage.activateRoot(rootA);
  const tokenA = lineage.tokenFor(rootA);

  const taskId = "fanout-gen-1";
  lineage.bindParentTask({ parentTaskId: taskId, parentId: rootA.id, parentAgent: rootA });
  assert.equal(lineage.parentTokenOf(taskId), tokenA, "绑定必须记录绑定当时的 exact token");
  assert.equal(lineage.isLiveGeneration(rootA, lineage.parentTokenOf(taskId)), true, "live 代际授权成立");
  assert.equal(lineage.parentAgentOf(taskId), rootA);

  // 只从持久化快照恢复寻址：owner 可解析，但没有代际证据 → 写路径必须 fail-closed。
  const taskId2 = "fanout-gen-2";
  lineage.restoreParentSessions({ parentSessions: { [taskId2]: rootA.id } });
  assert.equal(lineage.resolveOwner(taskId2), rootA.id, "快照恢复只恢复寻址");
  assert.equal(lineage.parentTokenOf(taskId2), undefined, "快照恢复不得伪造代际证据");

  // 释放（root 销毁/替换路径）：活动绑定与代际证据一起消失。
  lineage.releaseAgent(rootA);
  assert.equal(lineage.resolveOwner(taskId), undefined);
  assert.equal(lineage.parentTokenOf(taskId), undefined, "释放后不得残留可授权证据");

  // 同 id replacement：旧 token 立即不再是 live 代际。
  const rootB = { id: "root-gen", kind: "root" };
  roots.set(rootB.id, rootB);
  lineage.activateRoot(rootB);
  assert.equal(lineage.isLiveGeneration(rootA, tokenA), false, "旧代际 token 不得继续授权");
  const tokenB = lineage.tokenFor(rootB);
  assert.equal(lineage.isLiveGeneration(rootB, tokenB), true);
  assert.notEqual(tokenB, tokenA);
});

test("P1：runtime 层续作启动门——无效/重复 messageId 一律 fail-closed，不结算", async () => {
  // ① 投递给不出有效 messageId：本轮 attempt 必须在启动阶段失败（不进入 running 之外的任何
  //    结算路径），且后续任何 turn/end 都不能把它变成成功。
  const missing = createRuntimeHarness({ continueMessage: async () => undefined });
  const missingSubmitted = missing.runtime.manager.submit({
    parentTaskId: "runtime-task-missing",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await missing.runtime.manager.whenIdle();
  await missing.runtime.manager.whenIdle();
  settleRuntimeAttempt(missing.runtime, missing.children.get("runtime-child-1"), { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  const missingContinue = missing.runtime.manager.continueTask({
    parentTaskId: missingSubmitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  assert.equal(missingContinue.accepted, true);
  await missing.runtime.manager.whenIdle();
  await missing.runtime.manager.whenIdle();
  const missingTask = missing.runtime.manager.getTask(missingSubmitted.parentTaskId);
  assert.deepEqual(missingTask.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "failed"],
    "没有 messageId 的续作投递必须在启动阶段失败");
  assert.match(missingTask.shards[0].attempts[1].error.message, /messageId/);
  // 迟到的会话终态事件不能"救活"它（record 已在启动失败时结算）。
  settleRuntimeAttempt(missing.runtime, missing.children.get("runtime-child-1"), { turn: 2, messageId: "late" });
  await flushAsyncWork();
  assert.equal(missing.runtime.manager.getTask(missingSubmitted.parentTaskId).shards[0].attempts[1].status, "failed");

  // ② 投递返回的 messageId 与同一 child 旧轮重复：同样在启动阶段失败。
  const reuse = createRuntimeHarness({
    continueMessage: async ({ children }) => children.get("runtime-child-1")?.messageId,
  });
  const reuseSubmitted = reuse.runtime.manager.submit({
    parentTaskId: "runtime-task-reuse",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await reuse.runtime.manager.whenIdle();
  await reuse.runtime.manager.whenIdle();
  settleRuntimeAttempt(reuse.runtime, reuse.children.get("runtime-child-1"), { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  reuse.runtime.manager.continueTask({
    parentTaskId: reuseSubmitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await reuse.runtime.manager.whenIdle();
  await reuse.runtime.manager.whenIdle();
  const reuseTask = reuse.runtime.manager.getTask(reuseSubmitted.parentTaskId);
  assert.equal(reuseTask.shards[0].attempts[1].status, "failed", "重复的 messageId 必须被启动门拒绝");
  assert.match(reuseTask.shards[0].attempts[1].error.message, /重复/);

  // ③ 正对照：有效且不重复的 messageId 正常进入 running 并被合法 turn/end 结算。
  const healthy = createRuntimeHarness({ continueMessage: async ({ continuations }) => "runtime-cont-" + continuations.length });
  const healthySubmitted = healthy.runtime.manager.submit({
    parentTaskId: "runtime-task-healthy",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await healthy.runtime.manager.whenIdle();
  await healthy.runtime.manager.whenIdle();
  settleRuntimeAttempt(healthy.runtime, healthy.children.get("runtime-child-1"), { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  const healthyContinue = healthy.runtime.manager.continueTask({
    parentTaskId: healthySubmitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  assert.equal(healthyContinue.round, 2);
  await healthy.runtime.manager.whenIdle();
  await healthy.runtime.manager.whenIdle();
  assert.equal(healthy.runtime.manager.getTask(healthySubmitted.parentTaskId).shards[0].attempts[1].status, "running");
  settleRuntimeAttempt(healthy.runtime, healthy.children.get("runtime-child-1"), { turn: 2, messageId: "runtime-cont-1" });
  await flushAsyncWork();
  const healthyTask = healthy.runtime.manager.getTask(healthySubmitted.parentTaskId);
  assert.equal(healthyTask.status, "completed", "有效 messageId 的续作必须正常结算");
  assert.equal(healthyTask.round, 2);
  assert.equal(healthyTask.shards[0].attempts.length, 2, "复用必须保留原 childId 的 attempt 历史");
  assert.equal(healthyTask.shards[0].attempts[1].childId, "runtime-child-1");
});

test("P1：runtime 层归属不可证明时不结算并记录诊断；路由不可解析时 readiness 拒绝", async () => {
  const harness = createRuntimeHarness({ continueMessage: async ({ continuations }) => "runtime-cont-" + continuations.length });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-attribution",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const entry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, entry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // ① turn 里没有任何可读消息 id（旧形态/无归属证据）→ 不结算 + 诊断。
  harness.runtime.handleSessionEvent(entry.session, {
    type: "turn/end",
    data: { turn: 7, reason: { kind: "completed" } },
  });
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "归属不可证明必须保持未结算");

  // ② 有效 turn 但消息 id 属于别的投递 → 同样拒绝。
  entry.session.events = [
    ...entry.session.events,
    { type: "turn/start", data: { turn: 8 } },
    { type: "user/message", data: { id: "other-message", role: "user", content: [], source: { kind: "plugin" } } },
  ];
  harness.runtime.handleSessionEvent(entry.session, {
    type: "turn/end",
    data: { turn: 8, reason: { kind: "completed" } },
  });
  const diagnostics = harness.runtime
    .getEvents({ after: 0 })
    .events.filter((event) => event.type === "shard_attribution_unproven");
  assert.deepEqual(diagnostics.map((event) => event.reason),
    ["turn_message_ids_unavailable", "message_id_mismatch"], "两种不可证明形态各自留证");
  assert.ok(diagnostics.every((event) => event.attempt === 2 && event.shardId === "s1"));

  // ③ 合法 turn/end 仍可结算（严格路径不阻断正常流程）。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 9, messageId: "runtime-cont-1" });
  await flushAsyncWork();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).status, "completed");

  // ④ readiness：child 会话不可解析时给出结构化原因与分片列表。
  const detached = createRuntimeHarness({
    continueMessage: async () => "runtime-cont-x",
    resolveChildSession: () => undefined,
  });
  const detachedSubmitted = detached.runtime.manager.submit({
    parentTaskId: "runtime-task-detached",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }, { shardId: "s2", prompt: "第二片" }],
  });
  await detached.runtime.manager.whenIdle();
  await detached.runtime.manager.whenIdle();
  // 摘掉 runtime 自己的会话索引，模拟"宿主也解析不到、runtime 也没见过"的冷 child。
  const taskView = detached.runtime.manager.getTask(detachedSubmitted.parentTaskId);
  const originalSession = detached.runtime.continuationReadiness;
  assert.equal(typeof originalSession, "function", "runtime 必须暴露只读 readiness 检查");
  detached.children.clear();
  const readiness = detached.runtime.continuationReadiness(taskView);
  assert.equal(readiness.ok, false);
  assert.equal(readiness.reason, "child_session_unavailable");
  assert.deepEqual(readiness.shardIds, ["s1", "s2"], "readiness 必须列出所有不可解析的分片");
});

test("P1：插件层 child 会话不可解析时先拒绝续作，不追加 attempt", async () => {
  // child 的 agent.session 引用被摘掉：registry 里仍有该 agent，但宿主 resolveChildSession 与
  // runtime 索引都拿不到会话。首轮通过 agent/disposed 收敛为 failed（不产生任何会话事件），
  // 因此「本轮 wait-all 已完成但没有任何可复用的 child 会话」这一形态被真实构造出来。
  const { host, started, sent, children } = createFanoutHost({ detachChildSession: true });
  try {
    const root = host.registerRootAgent("root-route-missing");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    host.emit("agent/disposed", { agent: children.get(started[0].childId).agent });
    await flushAsyncWork(10);
    const before = await getTask(host, root, first.parentTaskId);
    assert.equal(before.status, "completed_with_errors", "首轮必须已收敛（可续作的前提）");
    assert.equal(before.shards[0].attempts[0].status, "failed");

    const error = await expectContinuationRejected(
      continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]),
      { reason: "child_session_unavailable" },
    );
    assert.deepEqual(error.detail?.shardIds, ["s1"], "拒绝必须指出不可解析的分片");
    await flushAsyncWork(10);
    const after = await getTask(host, root, first.parentTaskId);
    assert.equal(after.round, 1);
    assert.deepEqual(after.shards.map((shard) => shard.attempts.length), [1], "路由未就绪不得追加 attempt");
    assert.equal(after.status, "completed_with_errors", "路由未就绪不得改变任务状态");
    assert.equal(sent.length, 0, "路由未就绪不得投递");
  } finally {
    await host.dispose();
  }
});

test("P1：续作投递没有有效 messageId 时启动阶段 fail-closed（不结算、不提前 task_settled）", async () => {
  // 说明分层：插件层的 sendMessageToExistingChild 自己就会拒绝非字符串 messageId，因此这条
  // 用例验证的是「Host 层拦下 + 本轮 attempt 在启动阶段失败」的端到端语义；runtime 自己的
  // 同名门（continueMessage 直接返回无效值）由上面的 runtime 级用例覆盖。
  const { host, started, sent, children } = createFanoutHost({ sendMessageMode: "missing" });
  try {
    const root = host.registerRootAgent("root-message-missing");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    const settledBefore = (await getEvents(host, root)).filter((event) => event.type === "task_settled").length;

    const continued = await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    assert.equal(continued.accepted, true, "续作仍会被接受（进入本轮 admission）");
    await flushAsyncWork(10);
    const task = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(task.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "failed"],
      "没有消息身份的投递必须在启动阶段失败");
    assert.match(task.shards[0].attempts[1].error.message, /messageId/, "失败原因必须点明 messageId");
    const afterEvents = await getEvents(host, root);
    assert.equal(afterEvents.filter((event) => event.type === "task_settled").length, settledBefore + 1,
      "本轮只在 attempt failed 后聚合一次，不得被其它 turn 提前结算");
    assert.equal(sent.length, 1, "投递确实发生过（只是没有有效身份）");

    // 下一轮（正常投递）仍然可以继续：失败轮不阻塞下一次复用。
    const healthy = createFanoutHost();
    try {
      const healthyRoot = healthy.host.registerRootAgent("root-healthy");
      const healthyFirst = await submitFanout(healthy.host, healthyRoot, SHARDS_TWO);
      for (const [index] of SHARDS_TWO.entries()) {
        await settleAttempt(healthy.host, healthy.children.get(healthy.started[index].childId), {
          turn: index + 1,
          messageId: healthy.started[index].messageId,
        });
      }
      const ok = await continueFanout(healthy.host, healthyRoot, healthyFirst.parentTaskId, [
        { shardId: "s1", prompt: "第二轮 s1" },
        { shardId: "s2", prompt: "第二轮 s2" },
      ]);
      assert.equal(ok.accepted, true);
      assert.equal(ok.round, 2);
      assert.equal(healthy.sent.length, 2, "正常投递必须真实发生");
    } finally {
      await healthy.host.dispose();
    }
  } finally {
    await host.dispose();
  }
});

test("P1：续作 messageId 与旧轮重复时启动阶段 fail-closed", async () => {
  const { host, started, children } = createFanoutHost({ sendMessageMode: "reuse" });
  try {
    const root = host.registerRootAgent("root-message-reused");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });

    const continued = await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    assert.equal(continued.accepted, true);
    await flushAsyncWork(10);
    const task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[1].status, "failed", "重复的 messageId 必须被拒绝");
    assert.match(task.shards[0].attempts[1].error.message, /重复/, "失败原因必须点明 messageId 重复");

    // 旧轮 turn/end 再次到达也不得把这一轮「救活」成 succeeded。
    const session = children.get(started[0].childId).agent.session;
    session.events = [
      ...session.events,
      { type: "turn/start", data: { turn: 5 } },
      { type: "user/message", data: { id: started[0].messageId, role: "user", content: [], source: { kind: "plugin" } } },
    ];
    host.emit("session/event", session, { type: "turn/end", data: { turn: 5, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    const after = await getTask(host, root, first.parentTaskId);
    assert.equal(after.shards[0].attempts[1].status, "failed", "已失败的本轮不得被旧轮 turn/end 改写");
    assert.equal(after.status, "completed_with_errors");
  } finally {
    await host.dispose();
  }
});

test("P1：continuation 的 turn 归属无法证明时不结算并记录结构化诊断", async () => {
  const { host, started, sent, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-attribution");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const childId = started[0].childId;
    await settleAttempt(host, children.get(childId), { turn: 1, messageId: started[0].messageId });
    await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    await flushAsyncWork(10);
    const session = children.get(childId).agent.session;

    // ① turn 里没有可读的 user/message id：归属不可证明 → 不结算 + 诊断。
    session.events = [...session.events, { type: "turn/start", data: { turn: 10 } }];
    host.emit("session/event", session, { type: "turn/end", data: { turn: 10, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    let task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.status, "pending", "归属不可证明不得结算新一轮");
    assert.equal(task.shards[0].attempts[1].status, "running");

    // ② 有效 turn 但消息 id 是另一轮的：同样拒绝，并记录 message_id_mismatch。
    session.events = [
      ...session.events,
      { type: "turn/start", data: { turn: 11 } },
      { type: "user/message", data: { id: "some-other-message", role: "user", content: [], source: { kind: "plugin" } } },
    ];
    host.emit("session/event", session, { type: "turn/end", data: { turn: 11, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.status, "pending");

    // ③ turn 不是有效安全整数：同样拒绝（invalid_turn）。
    host.emit("session/event", session, { type: "turn/end", data: { reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.status, "pending");

    const diagnostics = (await getEvents(host, root)).filter((event) => event.type === "shard_attribution_unproven");
    assert.deepEqual(diagnostics.map((event) => event.reason),
      ["turn_message_ids_unavailable", "message_id_mismatch", "invalid_turn"],
      "每次无法证明的 turn/end 都必须留下结构化诊断");
    assert.ok(diagnostics.every((event) => event.parentTaskId === first.parentTaskId));
    assert.ok(diagnostics.every((event) => event.shardId === "s1" && event.attempt === 2));
    assert.equal(diagnostics[1].messageId, sent[0].messageId);
    assert.equal(diagnostics[0].turn, 10);
    assert.equal(diagnostics[2].turn, undefined, "非法 turn 不得出现在诊断里");

    // ④ 同一 record 的重复不可证明事件只诊断一次（有界，不抖动）。
    host.emit("session/event", session, { type: "turn/end", data: { turn: 12, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    const again = (await getEvents(host, root)).filter((event) => event.type === "shard_attribution_unproven");
    assert.equal(again.length, diagnostics.length, "同一 attempt 的归属诊断必须有界");

    // ⑤ 归属证据齐全的 turn/end 仍然正常结算（严格检查不阻断合法路径）。
    await settleAttempt(host, children.get(childId), { turn: 13, messageId: sent[0].messageId });
    const done = await getTask(host, root, first.parentTaskId);
    assert.equal(done.status, "completed", "合法 messageId 的 turn/end 必须正常结算");
    assert.equal(done.round, 2);
  } finally {
    await host.dispose();
  }
});

test("P1：首轮 launcher 的宽松 fallback 保持不变（旧形态 turn 无 message id 仍可结算）", async () => {
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-legacy-turn");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const session = children.get(started[0].childId).agent.session;
    // 旧形态：turn 内没有 user/message 记录 → 首轮 attempt 仍按会话结算（兼容既有行为）。
    session.events = [...session.events, { type: "turn/start", data: { turn: 3 } }];
    host.emit("session/event", session, { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
    await flushAsyncWork(10);
    const task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.status, "completed", "首轮 launcher attempt 必须保持宽松 fallback");
    assert.equal(task.shards[0].attempts[0].status, "succeeded");
    const diagnostics = (await getEvents(host, root)).filter((event) => event.type === "shard_attribution_unproven");
    assert.equal(diagnostics.length, 0, "首轮不得因为旧形态产生归属诊断");
  } finally {
    await host.dispose();
  }
});

test("P1/P2：requestId 幂等记录按任务持久化，冷恢复后仍 duplicate=true 且不追加 attempt", async () => {
  const source = createFanoutHost();
  let snapshot;
  try {
    const root = source.host.registerRootAgent("root-idempotent-cold");
    const first = await submitFanout(source.host, root, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(source.host, source.children.get(source.started[0].childId), {
      turn: 1,
      messageId: source.started[0].messageId,
    });
    const continued = await continueFanout(source.host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }], {
      requestId: "round-2",
    });
    assert.equal(continued.accepted, true);
    assert.equal(continued.round, 2);
    await flushAsyncWork(10);
    // 第二轮真实完成（终态）后再落盘快照：这样冷恢复形态是「已终态 + 已归还 ownership」。
    await settleAttempt(source.host, source.children.get(source.started[0].childId), {
      turn: 2,
      messageId: source.sent[0].messageId,
    });
    // 同一 requestId 再提交：duplicate，且不追加 attempt / 不重复投递。
    const replaySameProcess = await continueFanout(source.host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }], {
      requestId: "round-2",
    });
    assert.equal(replaySameProcess.duplicate, true);
    assert.deepEqual(replaySameProcess.shardIds, continued.shardIds);
    assert.equal(replaySameProcess.round, 2);
    const attemptsBeforeRestart = (await getTask(source.host, root, first.parentTaskId)).shards[0].attempts.length;
    assert.equal(source.sent.length, 1, "幂等重放不得重复投递 prompt");
    await flushAsyncWork(10);
    const stored = source.host.storage.entries("fanout_tasks").find(([key]) => key === "current")?.[1];
    assert.ok(stored?.tasks?.[0]?.continuationRequests?.["round-2"] !== undefined,
      "requestId 幂等记录必须写入持久化快照");
    snapshot = { stored, parentTaskId: first.parentTaskId, attemptsBeforeRestart };
  } finally {
    await source.host.dispose();
  }

  const cold = createColdHost({ snapshot: snapshot.stored });
  try {
    const root = cold.host.registerRootAgent("root-idempotent-cold");
    await flushAsyncWork(10);
    // 冷恢复后写路径同样被 fail-closed 拒绝（无 exact 代际证据）……
    await expectContinuationRejected(
      continueFanout(cold.host, root, snapshot.parentTaskId, [{ shardId: "s1", prompt: "第三轮" }], { requestId: "round-3" }),
      { reason: "not_owned_by_root" },
    );
    // ……但已记录 requestId 的幂等重放仍然可查（只读，不产生任何新状态）。
    const eventsBefore = (storedSnapshot(cold.host)?.events ?? []).length;
    const replay = await continueFanout(cold.host, root, snapshot.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }], {
      requestId: "round-2",
    });
    assert.equal(replay.duplicate, true, "快照恢复后同一 requestId 仍必须 duplicate=true");
    assert.equal(replay.round, 2);
    await flushAsyncWork(10);
    // 冷恢复后的终态任务 RPC 读路径按设计不可寻址，改用持久化事实 + 回执内的任务快照验证。
    const after = storedTask(cold.host, snapshot.parentTaskId);
    assert.equal(after.shards[0].attempts.length, snapshot.attemptsBeforeRestart, "重放不得追加 attempt");
    assert.equal(after.round, 2, "重放不得推进轮次");
    assert.equal(replay.task.shards[0].attempts.length, snapshot.attemptsBeforeRestart,
      "重放回执里的任务快照同样不得出现新 attempt");
    assert.equal(cold.sent.length, 0, "重放不得投递任何 prompt");
    assert.equal((storedSnapshot(cold.host)?.events ?? []).length, eventsBefore, "重放不得追加任何事件");
  } finally {
    await cold.host.dispose();
  }
});

test("P1/P2：requestId 幂等不依赖会淘汰旧键的全局 LRU（43 任务 × 7 轮后旧键仍可查）", async () => {
  // 规模下界由语义决定：每个任务首轮 + 6 轮续作 = 6 个 requestId，必须总量 > 旧 LRU 的
  // 256 项上限（43 × 6 = 258 刚好越过边界）。规模再往上只增加墙钟时间，不增加覆盖。
  // 本用例不断言 saves，故不接线 persistence：否则每次状态变化都会整份快照序列化 +
  // 字节估算（数百次变化），把用例从百毫秒级拖到秒级，而幂等语义与落盘无关。
  const taskCount = 43;
  // 并发池上限放宽到 taskCount：本用例要一次登记全部任务并让它们的首轮全部派发。
  const env = createContinuableManager({ prefix: "lru", withPersistence: false, config: { concurrencyLimit: taskCount } });
  const tasks = [];
  for (let index = 0; index < taskCount; index += 1) {
    const submitted = env.manager.submit({
      role: "fixer",
      basePrompt: "任务 " + index,
      shards: [{ shardId: "s1", prompt: "任务 " + index + " 第一轮" }],
    });
    tasks.push({ parentTaskId: submitted.parentTaskId, firstRequestId: "task-" + index + "-round-2" });
  }
  await drainIdle(env.manager);
  assert.equal(env.launches.length, taskCount, "每个任务一个首轮 child");

  // 每个任务推进 6 轮续作（attempt 2..7），全部带 requestId —— 总量远超旧 LRU 的 256。
  for (let round = 2; round <= 7; round += 1) {
    for (const [index, task] of tasks.entries()) {
      const gate = round === 2
        ? env.launches[index]
        : env.continuations[env.continuations.length - taskCount];
      gate.gate.resolve({ text: "任务 " + index + " 第 " + (round - 1) + " 轮完成" });
      await drainIdle(env.manager);
      const continued = env.manager.continueTask({
        parentTaskId: task.parentTaskId,
        role: "fixer",
        basePrompt: "任务 " + index + " 第 " + round + " 轮",
        shards: [{ shardId: "s1", prompt: "任务 " + index + " 第 " + round + " 轮" }],
        requestId: "task-" + index + "-round-" + round,
      });
      assert.equal(continued.accepted, true, "预算内的续作必须被接受");
      assert.equal(continued.round, round);
      if (index === 0 && round === 2) task.firstResult = { ...continued };
      await drainIdle(env.manager);
    }
  }
  const totalRequests = taskCount * 6;
  assert.equal(totalRequests, 258, "本轮共写入 258 个 requestId（已越过旧的 256 项上限）");

  // 最早的 requestId 仍然可查：duplicate=true、不追加 attempt、不重复投递。
  const oldest = tasks[0];
  const attemptsBefore = env.manager.getTask(oldest.parentTaskId).shards[0].attempts.length;
  const eventsBefore = env.events.length;
  const continuationsBefore = env.continuations.length;
  const replay = env.manager.continueTask({
    parentTaskId: oldest.parentTaskId,
    role: "fixer",
    basePrompt: "重放",
    shards: [{ shardId: "s1", prompt: "重放" }],
    requestId: oldest.firstRequestId,
  });
  assert.equal(replay.duplicate, true, "最早的 requestId 不得被淘汰");
  assert.equal(replay.round, 2, "重放必须返回与首次完全相同的轮次");
  // 除 duplicate 标记外，重放结果必须与首次逐字段相同（幂等回执契约）。
  const { duplicate: _duplicate, ...replayed } = replay;
  assert.deepEqual(replayed, oldest.firstResult, "重放结果必须与首次结果完全一致");
  assert.equal(env.events.length, eventsBefore, "重放不得发布任何新事件（不重复 task_continued/task_settled）");
  assert.equal(env.continuations.length, continuationsBefore, "重放不得产生新的续作投递");
  const after = env.manager.getTask(oldest.parentTaskId);
  assert.equal(after.shards[0].attempts.length, attemptsBefore, "重放不得追加 attempt");

  // 不同父任务复用同一 requestId 仍然拒绝。
  const crossTask = env.manager.continueTask({
    parentTaskId: tasks[1].parentTaskId,
    role: "fixer",
    basePrompt: "跨任务",
    shards: [{ shardId: "s1", prompt: "跨任务" }],
    requestId: oldest.firstRequestId,
  });
  assert.equal(crossTask.accepted, false);
  assert.equal(crossTask.reason, "duplicate_request_id");

  // 快照恢复后同一 requestId 依旧可查（幂等记录随任务持久化）。
  const restored = createContinuableManager({ prefix: "lru-restored", withPersistence: false });
  restored.manager.restore(env.manager.snapshot(), { resume: false });
  const restoredReplay = restored.manager.continueTask({
    parentTaskId: oldest.parentTaskId,
    role: "fixer",
    basePrompt: "重放",
    shards: [{ shardId: "s1", prompt: "重放" }],
    requestId: oldest.firstRequestId,
  });
  assert.equal(restoredReplay.duplicate, true, "恢复后 requestId 幂等必须保持");
  assert.equal(restoredReplay.round, 2);
});

// ---------------------------------------------------------------------------
// 终审修复：replacement 重放读权限边界 + admission 期间 turn/end 先到竞态
// ---------------------------------------------------------------------------

test("终审 1：同 id replacement root 不得重放旧代际 requestId；同 live root 重放保持通过", async () => {
  const goals = createGoalService();
  const { host, started, sent, children } = createFanoutHost({ goals });
  try {
    const firstRoot = host.registerRootAgent("root-replay-guard");
    const first = await submitFanout(host, firstRoot, [{ shardId: "s1", prompt: "第一片" }]);
    await settleAttempt(host, children.get(started[0].childId), { turn: 1, messageId: started[0].messageId });
    const continueShards = [{ shardId: "s1", prompt: "第二轮" }];
    const accepted = await continueFanout(host, firstRoot, first.parentTaskId, continueShards, { requestId: "round-2" });
    assert.equal(accepted.accepted, true);
    await flushAsyncWork(10);
    await settleAttempt(host, children.get(started[0].childId), { turn: 2, messageId: sent[0].messageId });

    // 同 live root + 同 requestId：必须返回逐字段相同结果 + duplicate，且不产生任何副作用。
    const attemptsBefore = storedTask(host, first.parentTaskId).shards[0].attempts.length;
    const eventsBefore = (storedSnapshot(host)?.events ?? []).length;
    const sendsBefore = sent.length;
    const pausesBefore = goals.calls.filter((call) => call[0] === "pause").length;
    const liveReplay = await continueFanout(host, firstRoot, first.parentTaskId, continueShards, { requestId: "round-2" });
    assert.equal(liveReplay.duplicate, true, "同 live root 的重复重放必须保持 duplicate=true");
    assert.equal(liveReplay.parentTaskId, accepted.parentTaskId);
    assert.equal(liveReplay.round, accepted.round);
    assert.deepEqual(liveReplay.shardIds, accepted.shardIds);
    await flushAsyncWork(10);
    assert.equal(storedTask(host, first.parentTaskId).shards[0].attempts.length, attemptsBefore, "重放不得追加 attempt");
    assert.equal((storedSnapshot(host)?.events ?? []).length, eventsBefore, "重放不得追加事件");
    assert.equal(sent.length, sendsBefore, "重放不得重复投递");
    assert.equal(goals.calls.filter((call) => call[0] === "pause").length, pausesBefore, "重放不得重新 pause goal");

    // 同 id replacement：不得读取旧代际的 continuation requestId 结果。
    host.emit("agent/disposed", { agent: firstRoot });
    await flushAsyncWork(10);
    const replacement = host.registerRootAgent("root-replay-guard");
    await flushAsyncWork(10);
    assert.notEqual(replacement, firstRoot);

    const beforeReplacement = storedSnapshot(host);
    const error = await expectContinuationRejected(
      continueFanout(host, replacement, first.parentTaskId, continueShards, { requestId: "round-2" }),
      { reason: "not_owned_by_root" },
    );
    assert.equal(error.detail?.ownership, "no_active_binding", error.message);
    await flushAsyncWork(10);
    // 任务、事件、投递、goal 全部不变（读权限边界同样 fail-closed）。
    assert.deepEqual(storedSnapshot(host), beforeReplacement, "replacement 重放不得改变任务/事件/snapshot");
    assert.equal(sent.length, sendsBefore, "replacement 重放不得投递");
    assert.equal(goals.calls.filter((call) => call[0] === "pause").length, pausesBefore, "replacement 重放不得 pause goal");
  } finally {
    await host.dispose();
  }
});

test("终审 2：admission 期间新轮 turn/end 先到——绑定后受限回放并最终结算", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-admission-race",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const entry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, entry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();

  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "admission 尚未返回 messageId 时 attempt 处于 running");

  // 新轮 turn/end 先到：必须被暂存（不能提前结算，也不能被 knownIds 吞掉后无回放）。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 2, messageId: "runtime-cont-race" });
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "messageId 绑定前不得结算");
  assert.equal(harness.runtime.getEvents({ after: 0 }).events.filter((event) => event.type === "shard_attribution_unproven").length, 0,
    "暂存阶段不做归属判定（绑定后统一回放）");

  // 绑定新 messageId：受限回放必须严格证明归属并结算本轮。
  resolveDelivery("runtime-cont-race");
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(settled.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
    "合法的新轮 turn/end 必须在绑定后结算");
  assert.equal(settled.status, "completed");
  assert.equal(settled.round, 2);
  assert.equal(harness.runtime.activeAttemptCount, 0, "结算后不得残留活动 record");
});

test("终审 2：admission 期间的旧轮/缺归属/invalid turn 事件都不结算，只记诊断", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-admission-stale",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const entry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, entry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // ① 旧轮（含旧 messageId 的 turn）② 无消息 id 的 turn ③ 无 turn 的终态事件。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 5, messageId: "runtime-message-1" });
  entry.session.events = [...entry.session.events, { type: "turn/start", data: { turn: 6 } }];
  harness.runtime.handleSessionEvent(entry.session, { type: "turn/end", data: { turn: 6, reason: { kind: "completed" } } });
  harness.runtime.handleSessionEvent(entry.session, { type: "turn/end", data: { reason: { kind: "completed" } } });

  resolveDelivery("runtime-cont-after");
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const afterReplay = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.equal(afterReplay.shards[0].attempts[1].status, "running", "不可证明归属的事件不得结算本轮");
  const diagnostics = harness.runtime.getEvents({ after: 0 }).events.filter((event) => event.type === "shard_attribution_unproven");
  assert.deepEqual(diagnostics.map((event) => event.reason).sort(),
    ["invalid_turn", "message_id_mismatch", "turn_message_ids_unavailable"],
    "三类不可证明事件都必须留下结构化诊断");

  // 合法的新轮 turn/end 仍然能结算（严格路径不阻断正常流程）。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 7, messageId: "runtime-cont-after" });
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).status, "completed");
  assert.equal(harness.runtime.activeAttemptCount, 0);
});

test("终审 2：admission 暂存有界（丢最旧、fail-closed），不无限增长", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-admission-bound",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const entry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, entry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // 先用一条**合法**的新轮事件占位，再用 8 条无归属事件把它挤出有界暂存。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 20, messageId: "runtime-cont-bounded" });
  for (let index = 0; index < 8; index += 1) {
    harness.runtime.handleSessionEvent(entry.session, { type: "turn/end", data: { reason: { kind: "completed" } } });
  }
  resolveDelivery("runtime-cont-bounded");
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "被挤出暂存的合法事件不得结算（丢最旧 = fail-closed，attempt 保持 running）");
  const diagnostics = harness.runtime.getEvents({ after: 0 }).events.filter((event) => event.type === "shard_attribution_unproven");
  assert.equal(diagnostics.length, 1, "同一种不可证明原因在回放里只留一条诊断（有界）");

  // 下一次真正的 turn/end 仍能结算。
  settleRuntimeAttempt(harness.runtime, entry, { turn: 21, messageId: "runtime-cont-bounded" });
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).status, "completed");
});

test("终审 2：admission 挂起时 close 不留悬挂记录，迟到 session 事件不复活", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-admission-close",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const entry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, entry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.activeAttemptCount, 1, "admission 挂起期间有一个活动 record");

  harness.runtime.close();
  assert.equal(harness.runtime.activeAttemptCount, 0, "close 必须清理全部在飞 record（含暂存）");
  const closedTask = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.ok(["failed", "cancelled"].includes(closedTask.shards[0].attempts[1].status),
    "close 必须收敛挂起的续作 attempt: " + closedTask.shards[0].attempts[1].status);

  // 迟到 resolve + 会话事件（含 session 替换）都不得复活记录或再次结算。
  resolveDelivery("runtime-cont-late");
  await flushAsyncWork(10);
  const replacementSession = { id: "runtime-child-1", header: { id: "runtime-child-1" }, events: [] };
  harness.runtime.handleSessionEvent(replacementSession, { type: "turn/end", data: { turn: 9, reason: { kind: "completed" } } });
  await flushAsyncWork(10);
  assert.equal(harness.runtime.activeAttemptCount, 0, "迟到 resolve/session 事件不得留下悬挂记录");
  assert.deepEqual(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts.map((attempt) => attempt.status),
    ["succeeded", closedTask.shards[0].attempts[1].status], "迟到事件不得改写已收敛的 attempt");
});

test("终审 2：插件层 delayed sendMessage + 新轮 turn/end 先到，绑定后最终结算", async () => {
  const { host, started, sent, children, pendingSends, resolvePendingSend } = createFanoutHost({ delaySendMessage: true });
  try {
    const root = host.registerRootAgent("root-admission-race");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const childId = started[0].childId;
    await settleAttempt(host, children.get(childId), { turn: 1, messageId: started[0].messageId });

    const continued = await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    assert.equal(continued.accepted, true);
    await flushAsyncWork(10);
    assert.equal(pendingSends.length, 1, "续作投递必须处于挂起（尚未绑定 messageId）");
    const newMessageId = pendingSends[0].messageId;

    // 新轮 turn/end 先到：暂存，不结算。
    await settleAttempt(host, children.get(childId), { turn: 2, messageId: newMessageId });
    let task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[1].status, "running", "绑定前不得结算");

    // 旧轮事件（旧 messageId）在绑定后回放：只留诊断，不结算。
    await settleAttempt(host, children.get(childId), { turn: 3, messageId: started[0].messageId });
    await flushAsyncWork(10);
    task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[1].status, "running", "旧轮事件不得覆盖新 attempt");

    // 投递送达：满足严格归属的暂存事件必须在绑定后结算本轮。
    assert.equal(resolvePendingSend(0), newMessageId);
    await flushAsyncWork(20);
    task = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(task.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
      "合法的新轮 turn/end 必须在 messageId 绑定后结算");
    assert.equal(task.status, "completed");
    assert.equal(task.round, 2);
    await flushAsyncWork(10);
    assert.equal(task.shards[0].attempts[1].messageId, newMessageId, "本轮必须记录自己的 messageId");
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// 终审追加：session replacement / cold-resume 竞态（latest-session 规则）
// ---------------------------------------------------------------------------

test("session replacement：admission 期间安装新 session，旧 resolvedSession 不得覆盖并最终结算", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-session-swap",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();

  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // cold-resume：同一 childId 的新 session 实例，markers 指向当前 attempt(2) → 命中同一 record。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  // 竞态顺序的可观测不变式：activation 安装新实例 → 代次从 1 推进到 2。
  const bindingAfterSwap = harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2);
  assert.equal(bindingAfterSwap.generation, 2, "cold-resume 安装新 session 必须推进代次");
  assert.equal(bindingAfterSwap.sessionId, "runtime-child-1");
  assert.equal(bindingAfterSwap.hasInstance, true);
  // 新轮 user/turn/end 写进新 session（进入 admission 暂存）。
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-cont-swap" });
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "绑定前仍不得结算");

  // 投递返回新 messageId：回放必须使用「admission 期间最后一次可信 session」（S2）并结算；
  // 同时 runContinuation 的写回分支**不得**把代次改回旧实例（代次保持 2）。
  resolveDelivery("runtime-cont-swap");
  await flushAsyncWork(20);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(settled.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
    "替换 session 后合法新轮 turn/end 必须在绑定后结算（旧 resolvedSession 不得覆盖新实例）");
  assert.equal(settled.status, "completed");
  assert.equal(settled.round, 2);
  assert.equal(settled.shards[0].attempts[1].messageId, "runtime-cont-swap");
  assert.equal(harness.runtime.activeAttemptCount, 0, "结算后不得残留 record");
  assert.equal(harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2), null,
    "结算后必须清理会话绑定（不留下悬挂引用）");

  // 旧 S1 的迟到事件不得改写已结算的新轮 attempt。
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 9, messageId: "runtime-message-1" });
  await flushAsyncWork(10);
  const afterLate = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(afterLate.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
    "旧 session 迟到事件不得覆盖新 attempt");
  assert.equal(afterLate.status, "completed");
});

test("session replacement：runContinuation 的写回不得覆盖 replacement 已安装的新 session", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-session-guard",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2).generation, 1,
    "admission 起点安装初始 session 是代次 1");

  // cold-resume 安装新实例 → 代次 2；随后只注入一条**不可证明**的旧 messageId 事件，
  // 让 record 在回放后保持 running（因此可以继续观察它的会话绑定）。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-message-1" });

  resolveDelivery("runtime-cont-guard");
  await flushAsyncWork(20);
  const binding = harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2);
  assert.ok(binding !== null, "不可证明事件不得结算 → record 仍在");
  assert.equal(binding.generation, 2,
    "runContinuation 写回不得覆盖 replacement 已安装的新 session（代次必须保持 2）");
  assert.equal(binding.hasInstance, true);
  assert.equal(binding.sessionId, "runtime-child-1");
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running");

  // 绑定仍指向可用实例：后续合法 turn/end 正常结算。
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 3, messageId: "runtime-cont-guard" });
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).status, "completed");
  assert.equal(harness.runtime.activeAttemptCount, 0);
});

test("session replacement：替换实例 markers 不指向当前 attempt（持久化身份形态）时按事件来源 session 结算", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-session-identity",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // 替换实例的 markers 仍指向 attempt 1（cold-resume 常见的"旧持久化身份"形态）：
  // 它不会被认领为当前 record 的 activation，但按 session id 仍路由到同一个 record。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 1,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-cont-identity" });

  resolveDelivery("runtime-cont-identity");
  await flushAsyncWork(20);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(settled.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
    "事件来源 session 必须决定回放日志（否则会去旧实例里找新 messageId）");
  assert.equal(settled.shards[0].attempts[1].messageId, "runtime-cont-identity");
  assert.equal(harness.runtime.activeAttemptCount, 0);
});

test("session replacement：新实例缺 messageId/旧 messageId/invalid turn 都不结算，只记诊断", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-session-invalid",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);

  // ① 新实例里只有旧轮 messageId ② 新实例 turn 无消息 id ③ 新实例终态事件无 turn。
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-message-1" });
  swap.session.events = [...swap.session.events, { type: "turn/start", data: { turn: 3 } }];
  harness.runtime.handleSessionEvent(swap.session, { type: "turn/end", data: { turn: 3, reason: { kind: "completed" } } });
  harness.runtime.handleSessionEvent(swap.session, { type: "turn/end", data: { reason: { kind: "completed" } } });

  resolveDelivery("runtime-cont-valid");
  await flushAsyncWork(20);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "三类不可证明事件都不得结算");
  const diagnostics = harness.runtime.getEvents({ after: 0 }).events
    .filter((event) => event.type === "shard_attribution_unproven")
    .map((event) => event.reason)
    .sort();
  assert.deepEqual(diagnostics, ["invalid_turn", "message_id_mismatch", "turn_message_ids_unavailable"]);

  // 合法的新实例 turn/end 仍然结算。
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 4, messageId: "runtime-cont-valid" });
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.equal(settled.status, "completed");
  assert.equal(settled.shards[0].attempts[1].status, "succeeded");
});

test("session replacement：取消/close 与迟到 replacement 不复活 record、不重复结算", async () => {
  // ① 取消：admission 挂起时取消分片 → 迟到送达 + 合法 turn/end 只收敛为 cancelled。
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const cancelled = createRuntimeHarness({ continueMessage: () => delivery });
  const cancelledTask = cancelled.runtime.manager.submit({
    parentTaskId: "runtime-task-session-cancel",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  const cancelledOld = cancelled.children.get("runtime-child-1");
  settleRuntimeAttempt(cancelled.runtime, cancelledOld, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  cancelled.runtime.manager.continueTask({
    parentTaskId: cancelledTask.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  cancelled.runtime.manager.cancelShard(cancelledTask.parentTaskId, "s1");
  const cancelledSwap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: cancelledTask.parentTaskId,
    parentAgentId: cancelled.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: cancelled.rootAgent,
  });
  cancelled.runtime.handleAgentCreated(cancelledSwap.agent);
  settleRuntimeAttempt(cancelled.runtime, { session: cancelledSwap.session }, { turn: 2, messageId: "runtime-cont-cancel" });
  resolveDelivery("runtime-cont-cancel");
  await flushAsyncWork(20);
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  const cancelledView = cancelled.runtime.manager.getTask(cancelledTask.parentTaskId);
  assert.deepEqual(cancelledView.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "cancelled"],
    "取消优先于合法的续作结算（同一次 completion 只收敛一次）");
  assert.equal(cancelled.runtime.activeAttemptCount, 0, "取消后不得残留 record");
  // 迟到的 replacement activation 不得复活 record。
  const lateSwap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: cancelledTask.parentTaskId,
    parentAgentId: cancelled.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: cancelled.rootAgent,
  });
  cancelled.runtime.handleAgentCreated(lateSwap.agent);
  settleRuntimeAttempt(cancelled.runtime, { session: lateSwap.session }, { turn: 6, messageId: "runtime-cont-cancel" });
  await flushAsyncWork(10);
  assert.equal(cancelled.runtime.activeAttemptCount, 0, "迟到 replacement 不得复活 record");
  assert.deepEqual(cancelled.runtime.manager.getTask(cancelledTask.parentTaskId).shards[0].attempts.map((attempt) => attempt.status),
    ["succeeded", "cancelled"], "迟到事件不得重复结算");

  // ② close：admission 挂起（含 replacement 与暂存）时关闭 → record 清空、迟到事件不复活。
  const closed = createRuntimeHarness({ continueMessage: () => Promise.resolve("runtime-cont-close") });
  const closedTask = closed.runtime.manager.submit({
    parentTaskId: "runtime-task-session-close",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await closed.runtime.manager.whenIdle();
  await closed.runtime.manager.whenIdle();
  const closedOld = closed.children.get("runtime-child-1");
  settleRuntimeAttempt(closed.runtime, closedOld, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  closed.runtime.manager.continueTask({
    parentTaskId: closedTask.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await closed.runtime.manager.whenIdle();
  await closed.runtime.manager.whenIdle();
  const closedSwap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: closedTask.parentTaskId,
    parentAgentId: closed.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: closed.rootAgent,
  });
  closed.runtime.handleAgentCreated(closedSwap.agent);
  settleRuntimeAttempt(closed.runtime, { session: closedSwap.session }, { turn: 2, messageId: "runtime-cont-close" });
  closed.runtime.close();
  assert.equal(closed.runtime.activeAttemptCount, 0, "close 必须清空含 replacement 暂存的 record");
  settleRuntimeAttempt(closed.runtime, { session: closedSwap.session }, { turn: 3, messageId: "runtime-cont-close" });
  await flushAsyncWork(10);
  assert.equal(closed.runtime.activeAttemptCount, 0, "close 后迟到 replacement 事件不得复活 record");
  const closedView = closed.runtime.manager.getTask(closedTask.parentTaskId);
  assert.ok(["failed", "cancelled"].includes(closedView.shards[0].attempts[1].status),
    "close 必须收敛挂起的续作 attempt: " + closedView.shards[0].attempts[1].status);
});

test("session replacement：插件层 delayed sendMessage 期间 cold-resume 换 session，绑定后仍结算", async () => {
  const { host, started, sent, children, pendingSends, resolvePendingSend } = createFanoutHost({ delaySendMessage: true });
  try {
    const root = host.registerRootAgent("root-session-swap");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const childId = started[0].childId;
    const oldEntry = children.get(childId);
    await settleAttempt(host, oldEntry, { turn: 1, messageId: started[0].messageId });

    const continued = await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    assert.equal(continued.accepted, true);
    await flushAsyncWork(10);
    assert.equal(pendingSends.length, 1, "续作投递必须处于挂起");
    const newMessageId = pendingSends[0].messageId;

    // cold-resume：同一 childId 的新 Agent + 新 session（走真实 agent/created 注册面）。
    const registered = host.registerRootAgent(childId, { lifecycle: false });
    registered.parent = root;
    registered.session = { id: childId, header: { id: childId, parentSession: root.id, origin: "subagent" }, events: [] };
    registered.options = {
      provider: "mock",
      model: "mock",
      [FANOUT_MARKER]: true,
      [FANOUT_PARENT_TASK_MARKER]: first.parentTaskId,
      [FANOUT_PARENT_AGENT_MARKER]: root.id,
      [FANOUT_SHARD_MARKER]: "s1",
      [FANOUT_ATTEMPT_MARKER]: 2,
    };
    host.emit("agent/created", { agent: registered });
    await flushAsyncWork(10);

    // 新轮 turn/end 只写进新 session（旧 session 里没有这条消息）。
    await settleAttempt(host, { session: registered.session }, { turn: 2, messageId: newMessageId });
    let task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[1].status, "running", "绑定前不得结算");

    assert.equal(resolvePendingSend(0), newMessageId);
    await flushAsyncWork(20);
    task = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(task.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
      "替换 session 后合法新轮 turn/end 必须在绑定后结算（旧 resolvedSession 不得覆盖新实例）");
    assert.equal(task.status, "completed");
    assert.equal(task.round, 2);
    assert.equal(task.shards[0].attempts[1].messageId, newMessageId);

    // 旧 session 的迟到事件不得改写已结算的新轮。
    await settleAttempt(host, oldEntry, { turn: 7, messageId: started[0].messageId });
    task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[1].status, "succeeded", "旧 session 迟到事件不得覆盖新 attempt");
    assert.equal(sent.length, 1, "旧会话迟到事件不得触发新的投递");
  } finally {
    await host.dispose();
  }
});

// ---------------------------------------------------------------------------
// 终审追加：旧 child disposal / cold-resume 竞态（旧实例 disposal 不得终结新 attempt）
// ---------------------------------------------------------------------------

test("child disposal 竞态：admission 期间旧实例 disposal 不得终结新 attempt，cold-resume 后仍成功结算", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-disposal",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).round, 1);

  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // 旧 activation 先关闭：DSH 随后会为同一 child id cold-resume（替换窗口）。
  harness.runtime.handleAgentDisposed(oldEntry.agent);
  const afterDisposal = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.equal(afterDisposal.shards[0].attempts[1].status, "running",
    "旧实例 disposal 不得让尚未绑定的续作 attempt 提前 failed");
  assert.equal(afterDisposal.status, "pending", "旧实例 disposal 不得让父任务提前终结");
  const bindingDuringWindow = harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2);
  assert.equal(bindingDuringWindow.pendingDisposal, true, "替换窗口必须记录 disposal 待决标记");

  // cold-resume：同一 childId 的新 Agent/session，markers 指向当前 attempt。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  assert.equal(harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2).pendingDisposal, false,
    "新 activation 到位后待决标记必须清除（替换已落地）");
  // 新轮 user/turn/end 写进新 session（进入 admission 暂存）。
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-cont-disposal" });
  resolveDelivery("runtime-cont-disposal");
  await flushAsyncWork(20);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(settled.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
    "cold-resume 后合法新轮 turn/end 必须成功结算");
  assert.equal(settled.status, "completed");
  assert.equal(settled.round, 2);
  // 事件面：第 2 轮只能有一条成功形态的 task_settled（不得出现 disposal 触发的 premature failed）。
  const settledEvents = harness.runtime.getEvents({ after: 0 }).events.filter((event) => event.type === "task_settled");
  assert.deepEqual(settledEvents.map((event) => event.round), [1, 2]);
  assert.deepEqual(settledEvents.map((event) => event.status), ["completed", "completed"]);
  assert.equal(harness.runtime.activeAttemptCount, 0, "结算后不得残留 record");
});

test("child disposal：已绑定的当前 session 被销毁仍按既有语义收敛为 failed；旧实例 disposal 被忽略", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-disposal-bound",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();

  // 先换成新实例（旧实例 disposal 随后才到 → 属于迟到 disposal，必须被忽略）。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  resolveDelivery("runtime-cont-bound");
  await flushAsyncWork(20);
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running");

  harness.runtime.handleAgentDisposed(oldEntry.agent);
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "旧实例 disposal 不得终结绑定了新实例的 attempt");
  assert.equal(harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2).staleDisposalIgnored, 1,
    "迟到 disposal 必须留可诊断计数");

  // 当前 session（新实例）被销毁 → 立即按既有 disposal 语义收敛为 failed。
  harness.runtime.handleAgentDisposed(swap.agent);
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.equal(settled.shards[0].attempts[1].status, "failed", "当前 session 被销毁必须 failed");
  assert.equal(settled.status, "completed_with_errors");
  assert.equal(harness.runtime.activeAttemptCount, 0, "收敛后不得残留 record");
  // 迟到的旧实例 session 事件不得复活 record / 二次结算。
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 9, messageId: "runtime-message-1" });
  await flushAsyncWork(10);
  assert.equal(harness.runtime.activeAttemptCount, 0);
  assert.deepEqual(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts.map((attempt) => attempt.status),
    ["succeeded", "failed"], "迟到事件不得改写已收敛的 attempt");
});

test("child disposal：close/cancel 与 disposal 组合不留悬挂、不重复 interrupt、不复活 record", async () => {
  // ① close：admission 挂起 + 旧实例 disposal 待决 → close 必须收敛并清理，迟到 disposal 不复活。
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const closing = createRuntimeHarness({ continueMessage: () => delivery });
  const closingTask = closing.runtime.manager.submit({
    parentTaskId: "runtime-task-disposal-close",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await closing.runtime.manager.whenIdle();
  await closing.runtime.manager.whenIdle();
  const closingOld = closing.children.get("runtime-child-1");
  settleRuntimeAttempt(closing.runtime, closingOld, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  closing.runtime.manager.continueTask({
    parentTaskId: closingTask.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await closing.runtime.manager.whenIdle();
  await closing.runtime.manager.whenIdle();
  closing.runtime.handleAgentDisposed(closingOld.agent);
  assert.equal(closing.runtime.activeAttemptCount, 1);
  closing.runtime.close();
  assert.equal(closing.runtime.activeAttemptCount, 0, "close 必须清理带待决 disposal 的 record");
  const interruptsAfterClose = closing.interrupts.length;
  // 迟到 disposal（同一旧实例再次上报）与迟到 resolve 都不得复活 record。
  closing.runtime.handleAgentDisposed(closingOld.agent);
  resolveDelivery("runtime-cont-late-close");
  await flushAsyncWork(10);
  assert.equal(closing.runtime.activeAttemptCount, 0, "close 后迟到 disposal/resolve 不得复活 record");
  assert.ok(closing.interrupts.length <= interruptsAfterClose,
    "close 已收敛的 attempt 不得因迟到 disposal 被再次 interrupt");
  const closedView = closing.runtime.manager.getTask(closingTask.parentTaskId);
  assert.ok(["failed", "cancelled"].includes(closedView.shards[0].attempts[1].status),
    "close 必须收敛挂起的续作 attempt: " + closedView.shards[0].attempts[1].status);

  // ② cancel：admission 挂起 + disposal 待决 → 取消优先，合法 turn/end 只收敛为 cancelled。
  let resolveCancelled;
  const cancelledDelivery = new Promise((resolve) => { resolveCancelled = resolve; });
  const cancelled = createRuntimeHarness({ continueMessage: () => cancelledDelivery });
  const cancelledTask = cancelled.runtime.manager.submit({
    parentTaskId: "runtime-task-disposal-cancel",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  const cancelledOld = cancelled.children.get("runtime-child-1");
  settleRuntimeAttempt(cancelled.runtime, cancelledOld, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  cancelled.runtime.manager.continueTask({
    parentTaskId: cancelledTask.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  cancelled.runtime.handleAgentDisposed(cancelledOld.agent);
  cancelled.runtime.manager.cancelShard(cancelledTask.parentTaskId, "s1");
  const cancelledSwap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: cancelledTask.parentTaskId,
    parentAgentId: cancelled.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: cancelled.rootAgent,
  });
  cancelled.runtime.handleAgentCreated(cancelledSwap.agent);
  settleRuntimeAttempt(cancelled.runtime, { session: cancelledSwap.session }, { turn: 2, messageId: "runtime-cont-cancel-disposal" });
  resolveCancelled("runtime-cont-cancel-disposal");
  await flushAsyncWork(20);
  await cancelled.runtime.manager.whenIdle();
  await cancelled.runtime.manager.whenIdle();
  assert.deepEqual(cancelled.runtime.manager.getTask(cancelledTask.parentTaskId).shards[0].attempts.map((attempt) => attempt.status),
    ["succeeded", "cancelled"], "取消优先于合法续作结算");
  assert.equal(cancelled.runtime.activeAttemptCount, 0, "取消后不得残留 record");
  // 每个 attempt 至多被 interrupt 一次（disposal + cancel 组合不得重复 interrupt）。
  const interruptKeys = cancelled.interrupts.map((entry) => entry.shardId + "#" + entry.attempt);
  assert.equal(new Set(interruptKeys).size, interruptKeys.length, "同一 attempt 不得重复 interrupt");
});

test("child disposal 竞态：插件层旧 child disposal 不产生 premature failed，cold-resume 后仍成功结算", async () => {
  const { host, started, sent, children, pendingSends, resolvePendingSend } = createFanoutHost({ delaySendMessage: true });
  try {
    const root = host.registerRootAgent("root-disposal-race");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const childId = started[0].childId;
    const oldEntry = children.get(childId);
    await settleAttempt(host, oldEntry, { turn: 1, messageId: started[0].messageId });

    const continued = await continueFanout(host, root, first.parentTaskId, [{ shardId: "s1", prompt: "第二轮" }]);
    assert.equal(continued.accepted, true);
    await flushAsyncWork(10);
    assert.equal(pendingSends.length, 1, "续作投递必须处于挂起");
    const newMessageId = pendingSends[0].messageId;
    const settledBefore = (await getEvents(host, root)).filter((event) => event.type === "task_settled").length;

    // 旧 activation 先关闭（DSH 随后会 cold-resume 同一 child id）。
    host.emit("agent/disposed", { agent: oldEntry.agent });
    await flushAsyncWork(10);
    let task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.status, "pending", "旧 child disposal 不得提前终结父任务");
    assert.equal(task.shards[0].attempts[1].status, "running", "旧 child disposal 不得让新 attempt failed");
    const settledAfterDisposal = (await getEvents(host, root)).filter((event) => event.type === "task_settled").length;
    assert.equal(settledAfterDisposal, settledBefore, "旧 child disposal 不得产生 task_settled");

    // cold-resume：同一 childId 的新 Agent/session（走真实 agent/created 注册面）。
    const registered = host.registerRootAgent(childId, { lifecycle: false });
    registered.parent = root;
    registered.session = { id: childId, header: { id: childId, parentSession: root.id, origin: "subagent" }, events: [] };
    registered.options = {
      provider: "mock",
      model: "mock",
      [FANOUT_MARKER]: true,
      [FANOUT_PARENT_TASK_MARKER]: first.parentTaskId,
      [FANOUT_PARENT_AGENT_MARKER]: root.id,
      [FANOUT_SHARD_MARKER]: "s1",
      [FANOUT_ATTEMPT_MARKER]: 2,
    };
    host.emit("agent/created", { agent: registered });
    await flushAsyncWork(10);

    // 新轮 turn/end 只写进新 session，随后投递才真正送达。
    await settleAttempt(host, { session: registered.session }, { turn: 2, messageId: newMessageId });
    assert.equal(resolvePendingSend(0), newMessageId);
    await flushAsyncWork(20);
    task = await getTask(host, root, first.parentTaskId);
    assert.deepEqual(task.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"],
      "cold-resume 后合法新轮 turn/end 必须成功结算");
    assert.equal(task.status, "completed");
    assert.equal(task.round, 2);
    const settledEvents = (await getEvents(host, root)).filter((event) => event.type === "task_settled");
    assert.deepEqual(settledEvents.map((event) => event.round), [1, 2]);
    assert.deepEqual(settledEvents.map((event) => event.status), ["completed", "completed"],
      "disposal 不得产生 premature 失败形态的 task_settled");
    assert.equal(sent.length, 1, "全程只允许一次真实投递");
  } finally {
    await host.dispose();
  }
});

test("child disposal：投递成功但新 activation 尚未上报时，绑定后清除待决标记并等新轮事件结算", async () => {
  let resolveDelivery;
  const delivery = new Promise((resolve) => { resolveDelivery = resolve; });
  const harness = createRuntimeHarness({ continueMessage: () => delivery });
  const submitted = harness.runtime.manager.submit({
    parentTaskId: "runtime-task-disposal-late-activation",
    role: "fixer",
    basePrompt: "目标",
    shards: [{ shardId: "s1", prompt: "第一片" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const oldEntry = harness.children.get("runtime-child-1");
  settleRuntimeAttempt(harness.runtime, oldEntry, { turn: 1, messageId: "runtime-message-1" });
  await flushAsyncWork();
  harness.runtime.manager.continueTask({
    parentTaskId: submitted.parentTaskId,
    role: "fixer",
    basePrompt: "第二轮",
    shards: [{ shardId: "s1", prompt: "第二轮" }],
  });
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  // 旧实例 disposal 先到，但 DSH 的 cold-resume activation 比投递结果更晚上报。
  harness.runtime.handleAgentDisposed(oldEntry.agent);
  resolveDelivery("runtime-cont-late-activation");
  await flushAsyncWork(20);
  const binding = harness.runtime.sessionBindingOf(submitted.parentTaskId, "s1", 2);
  assert.ok(binding !== null, "不得因 disposal 提前终结");
  assert.equal(binding.pendingDisposal, false, "绑定成功后必须清除待决标记（不再视为未决）");
  assert.equal(harness.runtime.manager.getTask(submitted.parentTaskId).shards[0].attempts[1].status, "running",
    "没有新事件前 attempt 保持 running（不猜成功也不提前失败）");

  // 迟到的 activation 到位后，合法新轮 turn/end 正常结算。
  const swap = createReplacementChild({
    childId: "runtime-child-1",
    parentTaskId: submitted.parentTaskId,
    parentAgentId: harness.rootAgent.id,
    shardId: "s1",
    attempt: 2,
    parent: harness.rootAgent,
  });
  harness.runtime.handleAgentCreated(swap.agent);
  settleRuntimeAttempt(harness.runtime, { session: swap.session }, { turn: 2, messageId: "runtime-cont-late-activation" });
  await flushAsyncWork(10);
  await harness.runtime.manager.whenIdle();
  await harness.runtime.manager.whenIdle();
  const settled = harness.runtime.manager.getTask(submitted.parentTaskId);
  assert.deepEqual(settled.shards[0].attempts.map((attempt) => attempt.status), ["succeeded", "succeeded"]);
  assert.equal(settled.status, "completed");
  assert.equal(harness.runtime.activeAttemptCount, 0);
});

test("child disposal：首轮 launcher 的 disposal 失败语义保持不变", async () => {
  const { host, started, children } = createFanoutHost();
  try {
    const root = host.registerRootAgent("root-first-round-disposal");
    const first = await submitFanout(host, root, [{ shardId: "s1", prompt: "第一片" }]);
    const entry = children.get(started[0].childId);
    // 首轮 child 的**当前** session 被销毁 → 必须按既有语义收敛为 failed。
    host.emit("agent/disposed", { agent: entry.agent });
    await flushAsyncWork(10);
    const task = await getTask(host, root, first.parentTaskId);
    assert.equal(task.shards[0].attempts[0].status, "failed", "首轮 child 被销毁必须 failed");
    assert.equal(task.status, "completed_with_errors");
    assert.equal(task.shards[0].attempts.length, 1, "不得因 disposal 追加 attempt");
  } finally {
    await host.dispose();
  }
});




test("用量（票据 25）：多轮 attempt 复用同一 child 时，attempt/shard/task usage 只计一次", () => {
  const usage = {
    inputTokens: 7,
    outputTokens: 3,
    billedInputTokens: 7,
    totalTokens: 10,
    requests: 1,
    retries: 1,
    sampleCount: 1,
    provider: "mock",
    model: "mock",
    role: "fixer",
    roleLabel: "修理工",
  };
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-continuation-usage",
    root: { id: "root-continuation-usage", status: "idle" },
    experts: [],
    fanoutTasks: [{
      parentTaskId: "task-continuation-usage",
      role: "fixer",
      status: "completed",
      shards: [{
        shardId: "s1",
        status: "succeeded",
        attempts: [
          { attempt: 1, childId: "child-usage-shared", status: "succeeded", usage },
          // 第二轮复用同一 child：child_models.usage 是累计值，不能被第二轮再加一遍。
          { attempt: 2, childId: "child-usage-shared", status: "succeeded", usage },
          { attempt: 3, childId: "child-usage-other", status: "succeeded", usage },
        ],
      }],
    }],
    generatedAt: 1,
  });
  const task = snapshot.root.children[0];
  assert.equal(task.shards[0].attempts.length, 3, "attempt 历史必须完整保留");
  assert.equal(task.shards[0].attempts[0].usage.totalTokens, 10);
  assert.equal(task.shards[0].attempts[1].usage.totalTokens, 10);
  assert.equal(task.shards[0].usage.totalTokens, 20, "同一 childId 只计一次（10 + 另一个 child 10）");
  assert.equal(task.usage.totalTokens, 20);
  assert.equal(task.usage.sampleCount, 2, "两个不同 child 的样本各计一次");
});
