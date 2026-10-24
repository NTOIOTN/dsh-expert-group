import test from "node:test";
import assert from "node:assert/strict";

import { createExpertGroupRuntime } from "../host/expert-group-runtime.js";
import { FAILURE_REDACTED_MESSAGE } from "../host/expert-group-snapshot.js";
import { createRecoveryModule } from "../host/recovery.js";

/**
 * 票据 33：`createExpertGroupRuntime` 的注入面收窄为 8 个具名命名空间
 * （agents / goals / ownership / recovery / sources / labels / diagnostics / clock）。
 *
 * 本文件的夹具仍按「注入了什么」的扁平写法描述，由这里统一展开；因此**夹具值与断言
 * 一字未改**，只是把同一个协作方集合换成工厂的新注入形态。
 */
function runtimeDeps(flat = {}) {
  const {
    agents, goals, lineage, fanoutHost, recovery, recoveryRecords,
    source, sessionQuery, projectionTitleFor, roleLabels, usageFor, logger, now,
  } = flat;
  return {
    agents: { agents },
    goals: { goals },
    ownership: { lineage, fanoutHost },
    recovery: { recovery, recoveryRecords },
    sources: { source, sessionQuery, usageFor },
    labels: { roleLabels, projectionTitleFor },
    diagnostics: { logger },
    clock: { now },
  };
}

/**
 * 同一 child 重复 dispatch 后的第一行必须是**最新**描述（需求 4）。
 * 用真实 recovery 模块证明：rememberContext 覆盖 record.recoveryRequest，
 * 运行时的 firstText(context.label, lastDispatch.description, 冷会话标题) 因此拿到最新值；
 * 持久化 child model 的 lastDispatch 仍是同一语义的回退，不被改写。
 */
test("同一 child 重复 dispatch 后第一行使用最新描述，持久化回退语义不变", async () => {
  const recovery = createRecoveryModule();
  const record = { childId: "child-repeat", parentId: "root-repeat" };
  recovery.rememberContext(record, {
    routeKey: "route-1",
    request: { prompt: [{ text: "第一次派发" }], agentOptions: { provider: "p1", model: "m1" } },
    label: "第一次派发描述",
    taskKey: "task-1",
  });
  recovery.rememberContext(record, {
    routeKey: "route-2",
    request: { prompt: [{ text: "第二次派发" }], agentOptions: { provider: "p2", model: "m2" } },
    label: "第二次派发描述",
    taskKey: "task-2",
  });
  const sessions = { root: { id: "root-repeat", status: "idle", session: { id: "root-repeat", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} } };
  const build = (deps) => createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => sessions.root, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery,
    recoveryRecords: new Map([["child-repeat", record]]),
    source: () => ({ childModels: deps.childModels }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 10,
  }));

  const live = await build({}).snapshotForSession("root-repeat");
  assert.equal(live.root.children.length, 1);
  assert.equal(live.root.children[0].taskName, "第二次派发描述");
  assert.equal(live.root.children[0].content, "第二次派发");

  // 没有 live recovery 上下文时回退到持久化 child model 的 lastDispatch（仍是最新一次）。
  const coldRuntime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({
      childModels: {
        "child-repeat-cold": {
          parentId: "root-repeat",
          role: "fixer",
          lastDispatch: { description: "最新派发描述", prompt: "最新派发内容" },
        },
      },
    }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 10,
  }));
  const coldRoot = { id: "root-repeat", status: "idle", session: { id: "root-repeat", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} };
  const cold = await createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => coldRoot, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: { "child-repeat-cold": { parentId: "root-repeat", role: "fixer", lastDispatch: { description: "最新派发描述", prompt: "最新派发内容" } } } }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 10,
  })).snapshotForSession("root-repeat");
  assert.equal(cold.root.children[0].taskName, "最新派发描述");
  assert.equal(cold.root.children[0].content, "最新派发内容");
  assert.ok(coldRuntime !== undefined);
});

/**
 * 首屏语义下的「完整快照」辅助。
 *
 * 新契约：第一次请求返回**轻量快照**（partial:true，不等待任何冷读），同时幂等地在后台启动
 * 完整构建；这里等后台构建收敛（失败会原样抛出，错误契约仍然可断言），再请求一次取回权威快照。
 * 冷读相关的断言因此都落在真正的完整构建结果上——不是删断言，而是把它们放回「完整快照」这一层。
 */
async function fullSnapshotFor(runtime, sessionId) {
  await runtime.snapshotForSession(sessionId);
  await runtime.awaitFullBuild(sessionId);
  return runtime.snapshotForSession(sessionId);
}

test("冷根会话首屏返回轻量快照，完整快照随后恢复已完成专家的三行内容", async () => {
  const logs = new Map([
    ["root-cold", {
      session: { id: "root-cold", parentSession: undefined, createdAt: 10 },
      events: [
        { type: "user/message", data: { source: { kind: "user" }, content: "完成冷会话中的全部任务" } },
        { type: "session/title", data: { title: "冷根任务" } },
      ],
    }],
    ["child-cold", {
      session: { id: "child-cold", parentSession: "root-cold", createdAt: 20 },
      events: [
        { type: "user/message", data: { source: { kind: "manager" }, content: "检查完整构建结果" } },
        { type: "session/title", data: { title: "验证构建" } },
        { type: "turn/end", data: { reason: { kind: "completed" } } },
      ],
    }],
  ]);
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({
      childModels: {
        "child-cold": {
          parentId: "root-cold",
          role: "fixer",
          provider: "a6",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          continuable: true,
          createdAt: 20,
        },
      },
    }),
    sessionQuery: () => ({
      async readSession(sessionId) {
        const log = logs.get(sessionId);
        if (log === undefined) throw new Error("session not found");
        return log;
      },
    }),
    now: () => 100,
  }));

  // 首屏：轻量快照（partial:true）。子节点已经出现（归属由 child_models.parentId 证明），
  // 但没有任何冷读内容，且证据不足的状态是 unknown 而不是 ready（不把它伪装成已结束）。
  const partial = await runtime.snapshotForSession("root-cold");
  assert.equal(partial.partial, true);
  assert.equal(partial.root.sessionId, "root-cold");
  assert.deepEqual(partial.root.children.map((node) => node.id), ["child-cold"]);
  assert.equal(partial.root.children[0].taskName, null, "轻量快照读不到冷会话标题");
  assert.equal(partial.root.children[0].status, "unknown", "没有运行证据时不得声明 ready");
  assert.equal(partial.root.children[0].running, null, "证据不足时不写 running 布尔");
  assert.equal(partial.root.children[0].role, "fixer", "廉价元数据（role/provider/model）照常投影");
  assert.equal(partial.root.children[0].provider, "a6");
  assert.equal(partial.root.status, "unknown", "冷根占位时根节点同样不声明状态");

  // 后台完整构建完成后，权威快照通过缓存替换轻量快照。
  const snapshot = await fullSnapshotFor(runtime, "root-cold");
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.root.taskName, "冷根任务");
  assert.equal(snapshot.root.children.length, 1);
  assert.deepEqual(snapshot.root.children[0], {
    id: "child-cold",
    kind: "expert",
    sessionId: "child-cold",
    taskName: "验证构建",
    content: "检查完整构建结果",
    contentSource: "session-log",
    role: "fixer",
    // 票据 27：roleLabel 是运行期投影字段；记录里没有持久化标签且没有角色目录时为 null。
    roleLabel: null,
    provider: "a6",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    status: "succeeded",
    running: false,
    runSummary: { command: null, mode: "continuable", activity: "idle" },
    continuable: true,
    // 票据 09：会话节点固定能力（read allowed；写动作 not_supported）。
    capabilities: {
      read: { allowed: true },
      cancel: { allowed: false, reason: "not_supported" },
      retry: { allowed: false, reason: "not_supported" },
      continue: { allowed: false, reason: "not_supported" },
    },
    createdAt: 20,
    // 票据 12：会话节点时间线（DSH 只发布创建时间，完成时间与耗时保持 null）。
    startedAt: 20,
    lastActivityAt: 20,
    finishedAt: null,
    durationMs: null,
    children: [],
  });
});

test("live snapshotEvents 提供 session title 与未完成 tool call 的运行命令", async () => {
  const rootSession = {
    id: "root-live",
    status: "running",
    createdAt: 1,
    snapshotEvents: () => [
      { type: "session/title", data: { title: "实时根任务" } },
      { type: "tool/call", data: { turn: 3, step: 1, callId: "call-1", name: "edit", arguments: JSON.stringify({ file_path: "dsh-expert-group/index.js" }) } },
      { type: "tool/call", data: { turn: 3, step: 2, callId: "call-2", name: "grep", arguments: JSON.stringify({ pattern: "lastDispatch" }) } },
      { type: "tool/result", data: { turn: 3, step: 2, callId: "call-2" } },
    ],
    requestHeader: () => ({ config: {} }),
  };
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: (id) => id === "root-live" ? { id, status: "running", session: rootSession } : undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => ({ id: "root-live", status: "running", session: rootSession, options: {} }), tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    now: () => 2,
  }));
  const snapshot = await runtime.snapshotForSession("root-live");
  assert.equal(snapshot.root.taskName, "实时根任务");
  assert.deepEqual(snapshot.root.runSummary, { command: "编辑 dsh-expert-group/index.js", mode: "one-shot", activity: "running" });
});

/** 用一组 root 事件构造最小 runtime；只有 sessionQuery/agents 依赖被替换。 */
function runtimeWithRootEvents({ id, status, events }) {
  const session = { id, status, createdAt: 1, snapshotEvents: () => events, requestHeader: () => ({ config: {} }) };
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: (sessionId) => sessionId === id ? { id, status, session } : undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => ({ id, status, session, options: {} }), tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    now: () => 2,
  }));
  return runtime;
}

test("真实 tool/result 用 message.source.callId 配对，已完成的调用不再误判 running", async () => {
  // 真实 DSH 事件形状：tool/call 的 callId/name/arguments 扁平在 data 上；
  // tool/result 顶层没有 callId，身份在 message.source.callId（ToolMessageSource）。
  const runtime = runtimeWithRootEvents({
    id: "root-nested",
    status: "ready",
    events: [
      { type: "session/title", data: { title: "嵌套事件根任务" } },
      { type: "tool/call", data: { turn: 1, step: 1, callId: "call-a", name: "read", arguments: JSON.stringify({ file_path: "a.js" }) } },
      {
        type: "tool/result",
        data: {
          turn: 1,
          step: 1,
          message: { role: "user", source: { kind: "tool", callId: "call-a" }, content: [{ type: "tool-result", callId: "call-a", isError: false }] },
        },
      },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ],
  });

  const snapshot = await runtime.snapshotForSession("root-nested");
  assert.deepEqual(snapshot.root.runSummary, { command: "读取 a.js", mode: "one-shot", activity: "idle" });
});

test("真实消息封装：tool/call 从 content block 提取 callId/name/arguments，未配对调用仍算 running", async () => {
  const runtime = runtimeWithRootEvents({
    id: "root-wrapped",
    status: "running",
    events: [
      {
        type: "tool/call",
        data: {
          turn: 2,
          step: 1,
          message: {
            role: "assistant",
            source: { kind: "model", provider: "p", model: "m" },
            content: [{ type: "tool-call", callId: "call-wrapped", name: "grep", arguments: JSON.stringify({ pattern: "runSummary" }) }],
          },
        },
      },
      {
        type: "tool/call",
        data: {
          turn: 2,
          step: 2,
          message: { content: [{ type: "tool-call", callId: "call-done", name: "edit", arguments: JSON.stringify({ file_path: "done.js" }) }] },
        },
      },
      {
        type: "tool/result",
        data: { turn: 2, step: 2, message: { source: { kind: "tool", callId: "call-done" }, content: [{ type: "tool-result", callId: "call-done" }] } },
      },
    ],
  });

  const snapshot = await runtime.snapshotForSession("root-wrapped");
  // 最新的 call-done 已配对，回溯到仍未完成的 call-wrapped；两者都从消息封装里读到了身份。
  assert.deepEqual(snapshot.root.runSummary, { command: "Grep runSummary", mode: "one-shot", activity: "running" });
});

test("turn 已结束的孤儿 tool/call 不再把 activity 误判为 running", async () => {
  const runtime = runtimeWithRootEvents({
    id: "root-orphan",
    status: "ready",
    events: [
      { type: "tool/call", data: { turn: 4, step: 1, callId: "call-orphan", name: "pwsh", arguments: JSON.stringify({ command: "npm run build" }) } },
      // 该 turn 以 interrupted 结束：结果事件永远不会到达，但调用不可能还在执行。
      { type: "turn/end", data: { turn: 4, reason: { kind: "interrupted" } } },
    ],
  });

  const snapshot = await runtime.snapshotForSession("root-orphan");
  assert.deepEqual(snapshot.root.runSummary, { command: "PowerShell npm run build", mode: "one-shot", activity: "idle" });
});

test("cold 已终态 fan-out 仍出现在所属根的任务树中，且保持跨根隔离", async () => {
  // manager 的权威快照里已经终态、lineage 活动 ownership 已释放的父任务。
  const tasks = [{
    parentTaskId: "fanout-cold",
    role: "fixer",
    basePrompt: "完成三段工作",
    status: "completed",
    createdAt: 30,
    counts: { queued: 0, running: 0, succeeded: 1, failed: 0, cancelled: 0, timed_out: 0, interrupted: 0, pending: 0 },
    shards: [{
      shardId: "s1",
      prompt: "第一段",
      status: "succeeded",
      createdAt: 31,
      attempts: [{ attempt: 1, status: "succeeded", childId: "child-cold-1", startedAt: 31, finishedAt: 32 }],
    }],
  }];
  const logs = new Map([
    ["root-tree", {
      session: { id: "root-tree", parentSession: undefined, createdAt: 10 },
      events: [{ type: "session/title", data: { title: "冷根任务树" } }],
    }],
    // 正常 cold child 的日志自带 parentSession，是冷启动下唯一能证明归属的证据。
    ["child-cold-1", {
      session: { id: "child-cold-1", parentSession: "root-tree", createdAt: 20 },
      events: [{ type: "tool/call", data: { turn: 1, step: 1, callId: "cold-call", name: "read", arguments: JSON.stringify({ file_path: "cold.js" }) } }],
    }],
  ]);
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    // 活动 ownership 已释放：lineage 不再认识这个终态父任务。
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: (id) => (id === "root-tree" ? tasks : []) },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: () => ({
      async readSession(sessionId) {
        const log = logs.get(sessionId);
        if (log === undefined) throw new Error("session not found");
        return log;
      },
    }),
    now: () => 100,
  }));

  // 首屏：轻量快照不做冷读。fan-out 父任务来自 manager 视图，但 attempt 的 childId 归属
  // 只有 child_models 的 fan-out 身份或冷会话 header 能证明——两者都没有时 fail-closed 清空，
  // 绝不把来源不明的会话挂到本根任务树上。
  const partial = await runtime.snapshotForSession("root-tree");
  assert.equal(partial.partial, true);
  assert.deepEqual(
    partial.root.children.map((node) => [node.kind, node.parentTaskId, node.status, node.taskStatus]),
    [["fanout", "fanout-cold", "succeeded", "completed"]],
    "manager 的权威任务状态不依赖冷读，轻量快照里必须原样保留",
  );
  assert.deepEqual(
    partial.root.children[0].shards.map((shard) => [shard.shardId, shard.status, shard.childId]),
    [["s1", "succeeded", null]],
    "归属未证明的 attempt childId 在轻量快照里一律清空",
  );

  const snapshot = await fullSnapshotFor(runtime, "root-tree");
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.root.taskName, "冷根任务树");
  assert.deepEqual(
    snapshot.root.children.map((node) => [node.kind, node.parentTaskId, node.status, node.taskStatus]),
    [["fanout", "fanout-cold", "succeeded", "completed"]],
  );
  assert.deepEqual(
    snapshot.root.children[0].shards.map((shard) => [shard.shardId, shard.status, shard.childId]),
    [["s1", "succeeded", "child-cold-1"]],
  );
  // 正常 cold child：header.parentSession 匹配当前 root，导航与第二行都必须保留。
  assert.equal(snapshot.root.children[0].shards[0].attempts[0].childId, "child-cold-1");
  assert.deepEqual(snapshot.root.children[0].shards[0].runSummary, { command: "读取 cold.js", mode: "continuable", activity: "running" });

  // 跨根隔离：别的根拿不到该任务，也不能借任务视图枚举别的会话。
  await assert.rejects(
    () => runtime.snapshotForSession("root-elsewhere"),
    (error) => error?.code === "session-not-found",
  );
});

test("attempt child 属于别的 root 时，投影副本清空导航 childId 且不泄漏它的会话内容", async () => {
  // 任务属于 root-a；attempt 的 child 是 root-b 的在线会话，且没有匹配的 DEG child record。
  const tasks = [{
    parentTaskId: "fanout-a",
    role: "fixer",
    basePrompt: "root-a 的公共目标",
    status: "pending",
    createdAt: 30,
    shards: [
      {
        shardId: "s1",
        prompt: "跨根分片",
        status: "running",
        createdAt: 31,
        attempts: [{ attempt: 1, status: "running", childId: "child-of-b", startedAt: 31 }],
      },
      {
        shardId: "s2",
        prompt: "会话缺失分片",
        status: "running",
        createdAt: 32,
        attempts: [{ attempt: 1, status: "running", childId: "child-missing", startedAt: 32 }],
      },
    ],
  }];
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: {
      get: (id) => (id === "child-of-b" ? {
        id,
        status: "running",
        options: { provider: "foreign-provider", model: "foreign-model" },
        session: {
          id,
          status: "running",
          header: { id, parentSession: "root-b" },
          snapshotEvents: () => [{ type: "tool/call", data: { turn: 1, step: 1, callId: "foreign", name: "read", arguments: JSON.stringify({ file_path: "secret.js" }) } }],
          requestHeader: () => ({ config: { provider: "foreign-provider", model: "foreign-model" } }),
        },
      } : undefined),
    },
    goals: { get: () => undefined },
    lineage: {
      activeRoot: () => ({ id: "root-a", status: "idle", session: { id: "root-a", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} }),
      tasksOwnedBy: () => tasks,
    },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: (id) => (id === "root-a" ? tasks : []) },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 100,
  }));

  const snapshot = await runtime.snapshotForSession("root-a");
  const [fanout] = snapshot.root.children;
  assert.equal(fanout.parentTaskId, "fanout-a");
  const [crossRoot, missing] = fanout.shards;
  assert.equal(crossRoot.childId, null, "跨根 child 不得成为导航目标");
  assert.equal(crossRoot.attempts[0].childId, null, "attempt 的跨根 childId 也要在投影副本里清空");
  // 外根会话的内容不得进入投影：命令与 provider/model 都必须为空。
  assert.equal(crossRoot.runSummary.command, null);
  assert.equal(crossRoot.provider, null);
  assert.equal(crossRoot.model, null);
  // 会话缺失且没有 DEG child record 时同样不能导航。
  assert.equal(missing.childId, null);
  assert.equal(missing.attempts[0].childId, null);
  // manager 的权威快照保持原样：只清理输出副本。
  assert.equal(tasks[0].shards[0].attempts[0].childId, "child-of-b");
  assert.equal(tasks[0].shards[0].childId, undefined);
  assert.equal(tasks[0].shards[1].attempts[0].childId, "child-missing");
});

test("在线 child 的 parentSession 匹配当前 root 时保留导航与第二行元数据", async () => {
  const tasks = [{
    parentTaskId: "fanout-owned",
    role: "fixer",
    basePrompt: "root-a 的公共目标",
    status: "pending",
    createdAt: 30,
    shards: [{
      shardId: "s1",
      prompt: "本根分片",
      status: "running",
      createdAt: 31,
      attempts: [{ attempt: 1, status: "running", childId: "child-ok", startedAt: 31 }],
    }],
  }];
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: {
      get: (id) => (id === "child-ok" ? {
        id,
        status: "running",
        options: { provider: "a6", model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
        session: {
          id,
          status: "running",
          header: { id, parentSession: "root-a" },
          snapshotEvents: () => [{ type: "tool/call", data: { turn: 1, step: 1, callId: "own", name: "read", arguments: JSON.stringify({ file_path: "own.js" }) } }],
          requestHeader: () => ({ config: {} }),
        },
      } : undefined),
    },
    goals: { get: () => undefined },
    lineage: {
      activeRoot: () => ({ id: "root-a", status: "idle", session: { id: "root-a", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} }),
      tasksOwnedBy: () => tasks,
    },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: (id) => (id === "root-a" ? tasks : []) },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 100,
  }));

  const [fanout] = (await runtime.snapshotForSession("root-a")).root.children;
  const [shard] = fanout.shards;
  assert.equal(shard.childId, "child-ok");
  assert.equal(shard.attempts[0].childId, "child-ok");
  assert.equal(shard.provider, "a6");
  assert.equal(shard.model, "gpt-5.6-sol");
  assert.equal(shard.effort, "xhigh");
  assert.deepEqual(shard.runSummary, { command: "读取 own.js", mode: "continuable", activity: "running" });
});

test("持久化 fan-out 身份记录按父任务证明归属，否则清空导航 childId", async () => {
  const task = (parentTaskId, childId) => ({
    parentTaskId,
    role: "fixer",
    basePrompt: "g",
    status: "running",
    createdAt: 30,
    shards: [{
      shardId: "s1",
      prompt: "p",
      status: "running",
      createdAt: 31,
      attempts: [{ attempt: 1, status: "running", childId, startedAt: 31 }],
    }],
  });
  const build = (tasks, childModels) => createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: {
      activeRoot: () => ({ id: "root-a", status: "idle", session: { id: "root-a", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} }),
      tasksOwnedBy: () => tasks,
    },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: (id) => (id === "root-a" ? tasks : []) },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 100,
  }));

  // fan-out 子代理的持久化记录用 fanoutParentTaskId 表达归属（没有 parentId）。
  const owned = await build(
    [task("fanout-a", "child-of-task")],
    { "child-of-task": { fanout: true, fanoutParentTaskId: "fanout-a", role: "fixer", provider: "a6", model: "gpt-5.6-sol" } },
  ).snapshotForSession("root-a");
  const ownedShard = owned.root.children[0].shards[0];
  assert.equal(ownedShard.childId, "child-of-task");
  assert.equal(ownedShard.attempts[0].childId, "child-of-task");
  assert.equal(ownedShard.provider, "a6");
  assert.equal(ownedShard.model, "gpt-5.6-sol");

  // 记录指向别的父任务：没有 parentSession、没有可读会话，必须清空导航。
  const foreign = await build(
    [task("fanout-a", "child-of-other-task")],
    { "child-of-other-task": { fanout: true, fanoutParentTaskId: "fanout-other", role: "fixer", provider: "a6", model: "gpt-5.6-sol" } },
  ).snapshotForSession("root-a");
  const foreignShard = foreign.root.children[0].shards[0];
  assert.equal(foreignShard.childId, null);
  assert.equal(foreignShard.attempts[0].childId, null);
  assert.equal(foreignShard.provider, null);
  assert.equal(foreignShard.model, null);
});

test("显式 parent 证据冲突时，任一根都不得把该 child 当作普通专家投影", async () => {
  // 旧 record/persisted 停留在 root-a，但 live session 的 header.parentSession 已经属于 root-b。
  const foreignSession = {
    id: "child-conflict",
    status: "running",
    header: { id: "child-conflict", parentSession: "root-b" },
    snapshotEvents: () => [{ type: "session/title", data: { title: "冲突子会话标题" } }],
    requestHeader: () => ({ config: { provider: "b-provider", model: "b-model" } }),
  };
  const okSession = {
    id: "child-ok",
    status: "idle",
    header: { id: "child-ok", parentSession: "root-a" },
    snapshotEvents: () => [{ type: "session/title", data: { title: "同根会话标题" } }],
    requestHeader: () => ({ config: { provider: "a-provider", model: "a-model" } }),
  };
  const records = new Map([
    ["child-conflict", { childId: "child-conflict", parentId: "root-a", role: "fixer", session: foreignSession, agent: { id: "child-conflict", status: "running", session: foreignSession } }],
    ["child-ok", { childId: "child-ok", parentId: "root-a", role: "fixer", session: okSession, agent: { id: "child-ok", status: "idle", session: okSession } }],
  ]);
  const rootFor = (id) => ({
    id, status: "idle",
    session: { id, header: { id }, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  });
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: (childId) => records.get(childId)?.agent },
    goals: { get: () => undefined },
    lineage: { activeRoot: (id) => (id === "root-a" || id === "root-b" ? rootFor(id) : undefined), tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [], tasksOwnedBy: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: records,
    source: () => ({
      childModels: {
        "child-conflict": { parentId: "root-a", role: "fixer", provider: "a6", model: "gpt-5.6-sol" },
        "child-ok": { parentId: "root-a", role: "fixer", provider: "a6", model: "gpt-5.6-sol" },
      },
    }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 10,
  }));

  const forA = await runtime.snapshotForSession("root-a");
  assert.deepEqual(forA.root.children.map((child) => child.id), ["child-ok"], "冲突 child 不得作为 root-a 的普通 expert");
  assert.ok(!JSON.stringify(forA).includes("冲突子会话标题"), "不得泄漏冲突 child 的会话内容");
  assert.equal(forA.root.children[0].taskName, "同根会话标题", "同根证据仍然照常投影");

  const forB = await runtime.snapshotForSession("root-b");
  assert.deepEqual(forB.root.children, [], "冲突 child 同样不得成为 root-b 的普通 expert");
  assert.ok(!JSON.stringify(forB).includes("a6"), "不得把旧 record 的模型快照泄漏到别的根");
  assert.ok(!JSON.stringify(forB).includes("a-provider"), "不得泄漏另一侧会话的元数据");
});

test("fan-out attempt child 的显式 parent 证据冲突时同样清空导航并拒绝泄漏", async () => {
  const tasks = [{
    parentTaskId: "fanout-a",
    role: "fixer",
    basePrompt: "root-a 的公共目标",
    status: "running",
    createdAt: 30,
    shards: [{ shardId: "s1", prompt: "p", status: "running", createdAt: 31, attempts: [{ attempt: 1, status: "running", childId: "child-conflict-fanout", startedAt: 31 }] }],
  }];
  const foreignSession = {
    id: "child-conflict-fanout",
    status: "running",
    header: { id: "child-conflict-fanout", parentSession: "root-b" },
    snapshotEvents: () => [{ type: "tool/call", data: { turn: 1, step: 1, callId: "foreign-call", name: "read", arguments: JSON.stringify({ file_path: "secret.js" }) } }],
    requestHeader: () => ({ config: { provider: "b-provider", model: "b-model" } }),
  };
  const rootA = { id: "root-a", status: "idle", session: { id: "root-a", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) }, options: {} };
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: (childId) => (childId === "child-conflict-fanout" ? { id: childId, status: "running", options: { provider: "b-provider", model: "b-model" }, session: foreignSession } : undefined) },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => rootA, tasksOwnedBy: () => tasks },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: (id) => (id === "root-a" ? tasks : []) },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map([["child-conflict-fanout", { childId: "child-conflict-fanout", parentId: "root-a" }]]),
    source: () => ({
      childModels: {
        "child-conflict-fanout": { parentId: "root-a", fanout: true, fanoutParentTaskId: "fanout-a", role: "fixer", provider: "a6", model: "gpt-5.6-sol" },
      },
    }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 100,
  }));

  const [fanout] = (await runtime.snapshotForSession("root-a")).root.children;
  const [shard] = fanout.shards;
  assert.equal(shard.childId, null, "记录说本根、live session 说别的根时必须拒绝导航");
  assert.equal(shard.attempts[0].childId, null, "attempt childId 也要在输出副本里清空");
  assert.equal(shard.provider, null, "不得泄漏旧 record 的 provider");
  assert.equal(shard.model, null);
  assert.equal(shard.runSummary.command, null, "不得读取冲突 child 的会话内容");
});

test("旧扁平 tool/result.data.callId 仍能配对", async () => {
  const runtime = runtimeWithRootEvents({
    id: "root-flat",
    status: "ready",
    events: [
      { type: "tool/call", data: { turn: 1, step: 1, callId: "flat-1", name: "read", arguments: JSON.stringify({ file_path: "flat.js" }) } },
      { type: "tool/result", data: { turn: 1, step: 1, callId: "flat-1" } },
    ],
  });

  const snapshot = await runtime.snapshotForSession("root-flat");
  assert.deepEqual(snapshot.root.runSummary, { command: "读取 flat.js", mode: "one-shot", activity: "idle" });
});

test("相同 callId 跨 turn/step 时不得互相配对", async () => {
  const callX = { type: "tool/call", data: { turn: 1, step: 1, callId: "call-x", name: "edit", arguments: JSON.stringify({ file_path: "old.js" }) } };
  const laterCallX = { type: "tool/call", data: { turn: 2, step: 1, callId: "call-x", name: "grep", arguments: JSON.stringify({ pattern: "new" }) } };
  const laterResultX = { type: "tool/result", data: { turn: 2, step: 1, message: { source: { kind: "tool", callId: "call-x" }, content: [{ type: "tool-result", callId: "call-x" }] } } };

  const leaked = await runtimeWithRootEvents({ id: "root-dup", status: "ready", events: [callX, laterCallX, laterResultX] })
    .snapshotForSession("root-dup");
  // turn 1 的 call-x 没有被 turn 2 的结果顶替：它仍是未完成调用。
  assert.deepEqual(leaked.root.runSummary, { command: "编辑 old.js", mode: "one-shot", activity: "running" });

  const paired = await runtimeWithRootEvents({
    id: "root-dup",
    status: "ready",
    events: [callX, laterCallX, laterResultX, { type: "tool/result", data: { turn: 1, step: 1, message: { source: { kind: "tool", callId: "call-x" } } } }],
  }).snapshotForSession("root-dup");
  assert.deepEqual(paired.root.runSummary, { command: "Grep new", mode: "one-shot", activity: "idle" });
});

test("同一根会话的并发快照请求共享一次冷读取", async () => {
  let reads = 0;
  let firstRead = true;
  let resolveRead;
  const readPromise = new Promise((resolve) => { resolveRead = resolve; });
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: {
      readSession: async (id) => {
        reads += 1;
        if (firstRead) {
          firstRead = false;
          return readPromise;
        }
        return { session: { id, config: {} }, events: [] };
      },
    },
    now: () => 2,
  }));

  const first = runtime.snapshotForSession("root-shared");
  const second = runtime.snapshotForSession("root-shared");

  resolveRead({ session: { id: "root-shared", config: {} }, events: [] });
  const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
  assert.equal(reads, 1, "并发请求应复用同一个构建期 Promise");
  assert.deepEqual(firstSnapshot, secondSnapshot);
  // 该 root 没有任何 DEG 记录能证明它存在，轻量路径无法承认陌生 id，因此按既有契约回落到
  // 完整构建（保留 404/错误传播）；这里断言两次并发请求只触发一次冷读。
  assert.equal(reads, 1, "两次并发请求只允许触发一次冷读");

  // 缓存命中：完整快照在 TTL 内由后续请求直接复用，不再重跑冷读（旧实现每次请求都重读）。
  await runtime.snapshotForSession("root-shared");
  assert.equal(reads, 1, "完整快照命中缓存时不得再冷读");

  // 显式失效（事件挂点语义）：下一次请求继续返回上一份权威快照，同时后台重建。
  assert.equal(runtime.invalidateSnapshots("root-shared"), 1, "失效按 root 计数");
  await runtime.snapshotForSession("root-shared");
  assert.equal(reads, 2, "失效后的请求必须重新构建完整快照");
  await runtime.awaitFullBuild("root-shared");

  // 不同 root 各自构建，绝不共享快照请求。
  await runtime.snapshotForSession("root-other");
  assert.equal(reads, 3, "不同根会话不得共享快照请求");
});

test("Host 快照构建失败后会清理去重表并允许重试", async () => {
  let attempts = 0;
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: {
      readSession: async (id) => {
        attempts += 1;
        if (attempts === 1) throw new Error("storage temporarily unavailable");
        return { session: { id, config: {} }, events: [] };
      },
    },
    now: () => 2,
  }));

  await assert.rejects(runtime.snapshotForSession("root-retry"), /storage temporarily unavailable/);
  await runtime.snapshotForSession("root-retry");
  assert.equal(attempts, 2, "失败的构建不能把 root 永久留在去重表");
});

// ── 普通 expert child 冷读的受控并发（延迟修复回归） ────────────────────────

/**
 * 构造「根会话在线、普通专家子会话只能冷读」的 runtime。
 *
 * childIds 只通过持久化 childModels 登记（parentId = 根），recoveryRecords 为空、
 * agents.get 恒为 undefined，因此每个 child 都必须走 sessionQuery.readSession；
 * childModels 的键顺序同时决定 runtime 的输入顺序，也就是顺序断言的基准。
 */
function coldOnlyRuntime({ rootId, childIds, readSession, createdAt = 20, now = () => 100 }) {
  const root = {
    id: rootId,
    status: "idle",
    session: { id: rootId, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  };
  return createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => root, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [], tasksOwnedBy: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({
      childModels: Object.fromEntries(childIds.map((id) => [id, { parentId: rootId, role: "fixer", createdAt }])),
    }),
    sessionQuery: () => ({ readSession }),
    now,
  }));
}

/**
 * 冷读探针：统计**同时在飞**的 readSession 数量，并提供一个闸门——只有并发数达到 openAt
 * 时才放行。串行 for-await 永远等不到闸门，看门狗（500ms）会放行并置 watchdogFired=true，
 * 于是用例以断言失败结束，而不是挂死整个测试进程。
 */
function coldReadProbe({ openAt }) {
  const probe = { started: [], finished: [], inFlight: 0, maxInFlight: 0, watchdogFired: false };
  probe.gate = new Promise((resolve) => { probe.open = resolve; });
  probe.watchdog = setTimeout(() => {
    probe.watchdogFired = true;
    probe.open();
  }, 500);
  probe.enter = (sessionId) => {
    probe.started.push(sessionId);
    probe.inFlight += 1;
    probe.maxInFlight = Math.max(probe.maxInFlight, probe.inFlight);
    if (probe.inFlight >= openAt) probe.open();
  };
  probe.leave = (sessionId) => {
    probe.inFlight -= 1;
    probe.finished.push(sessionId);
  };
  probe.close = () => clearTimeout(probe.watchdog);
  return probe;
}

/** 等待若干毫秒：让并发读取真正交错，并让迟到的成功/失败有机会到达。 */
function delayMs(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * 跨批次冷读追踪器：记录同时在飞的读取数与其峰值，并在「旧批次尚未结束、新批次已经开始」
 * 时置 overlapped=true。批次号由用例在重试前推进（track.batch = 2）；进入/离开都要带上
 * 读取开始时的批次号，因此即使真的出现跨批次重叠也能正确记账。
 */
function coldReadTracker() {
  const track = { batch: 1, started: [], settled: [], inFlight: 0, peak: 0, overlapped: false, byBatch: new Map() };
  track.enter = (batchId, sessionId) => {
    track.started.push({ batch: batchId, sessionId });
    track.byBatch.set(batchId, (track.byBatch.get(batchId) ?? 0) + 1);
    track.inFlight += 1;
    track.peak = Math.max(track.peak, track.inFlight);
    // 进入时若还有别的批次在飞，说明旧批次没有收敛就启动了新批次。
    for (const [id, count] of track.byBatch) {
      if (id !== batchId && count > 0) {
        track.overlapped = true;
        break;
      }
    }
  };
  track.leave = (batchId, sessionId) => {
    track.byBatch.set(batchId, (track.byBatch.get(batchId) ?? 0) - 1);
    track.inFlight -= 1;
    track.settled.push({ batch: batchId, sessionId });
  };
  return track;
}

/**
 * 构造「根会话在线 + 显式 childModels + 可选 fan-out 任务」的 runtime。
 *
 * root 由 lineage.activeRoot 在线返回，因此不会触发 root 冷读；recoveryRecords 为空、
 * agents.get 恒为 undefined，所以每个 child 都只能冷读。归属证据来自 childModels.parentId
 * 与按根过滤的 fanoutHost.tasksOwnedBy（与线上 runtime 的取证路径一致）。
 */
function runtimeWithColdChildren({ rootId, childModels = {}, tasks = [], readSession, usageFor, now = 100 }) {
  // now 既接受数值（既有用例的常量时钟），也接受函数（需要推进时钟的用例）。
  const clockOf = typeof now === "function" ? now : () => now;
  const root = {
    id: rootId,
    status: "idle",
    session: { id: rootId, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  };
  return createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => root, tasksOwnedBy: () => tasks },
    fanoutHost: { listTasks: () => tasks, tasksOwnedBy: () => tasks },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels }),
    sessionQuery: () => ({ readSession }),
    ...(usageFor === undefined ? {} : { usageFor }),
    now: clockOf,
  }));
}

/**
 * fan-out attempt child 的持久化记录：fanout=true 让它只走 fan-out 分支，
 * fanoutParentTaskId 提供父任务级归属证据。
 */
function fanoutChildModels(rootId, parentTaskId, childIds, createdAt = 20) {
  return Object.fromEntries(childIds.map((childId) => [childId, {
    parentId: rootId,
    role: "fixer",
    fanout: true,
    fanoutParentTaskId: parentTaskId,
    createdAt,
  }]));
}

/** fan-out 父任务 fixture：shards 是「每个 shard 的 attempt childId 列表」，形状与 manager 一致。 */
function fanoutTaskFixture({ parentTaskId, shards, role = "fixer", createdAt = 30 }) {
  return {
    parentTaskId,
    role,
    basePrompt: "公共目标",
    status: "running",
    createdAt,
    shards: shards.map((attemptChildIds, index) => ({
      shardId: parentTaskId + "-s" + (index + 1),
      prompt: "分片 " + (index + 1),
      status: "running",
      createdAt,
      attempts: attemptChildIds.map((childId, attemptIndex) => ({
        attempt: attemptIndex + 1,
        status: "running",
        childId,
        startedAt: createdAt,
      })),
    })),
  };
}


test("manager 的 updatedAt/settledAt/error 经 runtime 透传，投影给出时间线与受限失败摘要", async () => {
  const rootId = "root-timeline";
  const tasks = [{
    parentTaskId: "task-timeline",
    role: "fixer",
    basePrompt: "公共目标",
    status: "completed_with_errors",
    createdAt: 30,
    updatedAt: 90,
    settledAt: 90,
    shards: [
      {
        shardId: "task-timeline-s1",
        prompt: "分片 1",
        status: "failed",
        createdAt: 31,
        updatedAt: 60,
        attempts: [
          {
            attempt: 1,
            status: "failed",
            childId: "tl-1",
            startedAt: 31,
            finishedAt: 40,
            // manager 的结构化错误带 stack：投影只允许出现受限摘要（真实 Host→快照链路的端到端断言）。
            error: {
              code: "EACCES",
              message: "无法读取 C:\\Users\\alice\\a.txt\n    at read (x.js)",
              stack: "SECRET STACK",
            },
          },
          {
            attempt: 2,
            status: "failed",
            childId: "tl-2",
            startedAt: 50,
            finishedAt: 60,
            // 安全自由文本：通过白名单，原样保留。
            error: { name: "TimeoutError", message: "请求超时" },
          },
        ],
      },
      {
        shardId: "task-timeline-s2",
        prompt: "分片 2",
        status: "succeeded",
        createdAt: 31,
        updatedAt: 90,
        attempts: [{ attempt: 1, status: "succeeded", childId: "tl-3", startedAt: 61, finishedAt: 90 }],
      },
      {
        shardId: "task-timeline-s3",
        prompt: "分片 3",
        status: "failed",
        createdAt: 95,
        updatedAt: 96,
        attempts: [
          {
            attempt: 1,
            status: "failed",
            childId: "tl-4",
            startedAt: 95,
            finishedAt: 96,
            // 真实 Host→快照链路：CJK 表意文字夹在 Base64 中间（白名单本身允许 CJK），
            // 合并检测只保留 ASCII 字母数字，因此两段会被拼成一个 32 位长 token 而回退。
            error: { code: "EAI_AGAIN", message: "AAECAwQFBgcICQoL中A0ODxAREhMUFRYX" },
          },
        ],
      },
    ],
  }];
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: fanoutChildModels(rootId, "task-timeline", ["tl-1", "tl-2", "tl-3", "tl-4"]),
    tasks,
    readSession: async (sessionId) => ({
      session: { id: sessionId, parentSession: rootId, createdAt: 20 },
      events: [],
    }),
  });

  // 轻量快照不做冷读，但 manager 已有的时间线/计数/失败摘要必须已可用。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  assert.equal(typeof partial.revision, "string");
  const partialTask = partial.root.children.find((node) => node.parentTaskId === "task-timeline");
  assert.equal(partialTask.startedAt, 30);
  assert.equal(partialTask.finishedAt, 90);
  assert.equal(partialTask.durationMs, 60);
  assert.equal(partialTask.lastActivityAt, 90);
  assert.equal(partialTask.attemptCount, 4);
  assert.equal(partialTask.retryCount, 1);
  // 父任务失败摘要 = 首个失败 shard 的摘要，而 shard 摘要取**最新**带错误的 attempt。
  assert.deepEqual(partialTask.failure, { code: "TimeoutError", message: "请求超时" });
  // 历史 attempt 含路径/堆栈：默认整条回退通用文案。
  assert.deepEqual(
    partialTask.shards[0].attempts[0].failure,
    { code: "EACCES", message: FAILURE_REDACTED_MESSAGE },
  );
  assert.equal(JSON.stringify(partial).includes("SECRET"), false, "堆栈不得进入快照");
  assert.equal(JSON.stringify(partial).includes("alice"), false, "路径不得进入快照");

  const full = await runtime.awaitFullBuild(rootId);
  assert.equal(full.partial, false);
  assert.equal(typeof full.revision, "string");
  const fullTask = full.root.children.find((node) => node.parentTaskId === "task-timeline");
  assert.equal(fullTask.durationMs, 60);
  // 分片级摘要取最新带错误的 attempt；成功分片没有失败摘要。
  assert.deepEqual(fullTask.shards[0].failure, { code: "TimeoutError", message: "请求超时" });
  assert.equal(fullTask.shards[1].failure, null);
  assert.equal(fullTask.shards[1].durationMs, 29);
  // Unicode 字母（CJK）夹在 Base64 中间：合并检测只保留 ASCII，两段拼接后整条回退。
  assert.deepEqual(
    fullTask.shards[2].failure,
    { code: "EAI_AGAIN", message: FAILURE_REDACTED_MESSAGE },
  );
  assert.equal(fullTask.shards[2].durationMs, 1);
  // partial 与 full 都是真实 Host 出口：两侧 Base64 片段都不得出现在序列化结果里。
  for (const snapshot of [partial, full]) {
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["AAECAwQFBgcICQoL", "A0ODxAREhMUFRYX"]) {
      assert.equal(serialized.includes(secret), false, "快照不得包含 Unicode 分隔片段 " + secret);
    }
  }
});

test("结构化交付（票据 30）：runtime 从 child_models 补齐 expert structured 与声明标记", async () => {
  const root = {
    id: "root-structured-runtime",
    status: "idle",
    session: { id: "root-structured-runtime", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  };
  const records = new Map();
  for (const childId of ["child-structured-live", "child-structured-plain"]) {
    records.set(childId, {
      childId,
      parentId: root.id,
      role: "fixer",
      continuable: true,
      session: { id: childId, status: "idle", snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    });
  }
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => root, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: records,
    source: () => ({
      childModels: {
        "child-structured-live": {
          parentId: root.id,
          role: "fixer",
          provider: "mock",
          model: "mock",
          structured: { value: { summary: "live" }, bytes: 20, receivedAt: 7 },
          outputSchemaRequested: true,
        },
        "child-structured-plain": {
          parentId: root.id,
          role: "fixer",
          provider: "mock",
          model: "mock",
        },
      },
    }),
    sessionQuery: () => ({ async readSession() { throw new Error("session not found"); } }),
    now: () => 10,
  }));
  const snapshot = await fullSnapshotFor(runtime, root.id);
  const live = snapshot.root.children.find((node) => node.id === "child-structured-live");
  const plain = snapshot.root.children.find((node) => node.id === "child-structured-plain");
  assert.deepEqual(live.structured.value, { summary: "live" });
  assert.equal(live.outputSchemaRequested, true);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "structured"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "outputSchemaRequested"), false);
});

test("真实 Host→快照链路：manager 的 error.code 走精确 allowlist，编码载荷回退 error", async () => {
  const rootId = "root-code-allowlist";
  const tasks = [{
    parentTaskId: "task-code-allowlist",
    role: "fixer",
    basePrompt: "公共目标",
    status: "completed_with_errors",
    createdAt: 30,
    updatedAt: 90,
    settledAt: 90,
    shards: [
      {
        shardId: "task-code-allowlist-payload",
        prompt: "分片 1",
        status: "failed",
        createdAt: 31,
        updatedAt: 60,
        attempts: [{
          attempt: 1,
          status: "failed",
          childId: "cla-1",
          startedAt: 31,
          finishedAt: 40,
          // oracle 复现载荷：19 位含下划线 Base64URL（旧「全大写+下划线」形态）。
          // manager 原样保存 error.code，投影必须整条回退 "error"，绝不透传。
          error: { code: "YXBPPWFL_ZGFJZWFHAA", message: "失败" },
        }],
      },
      {
        shardId: "task-code-allowlist-name",
        prompt: "分片 2",
        status: "failed",
        createdAt: 31,
        updatedAt: 70,
        attempts: [{
          attempt: 1,
          status: "failed",
          childId: "cla-2",
          startedAt: 61,
          finishedAt: 70,
          // 没有 code 时回退 name：15 位无填充 Base64URL（旧 CamelCase 形态）同样回退。
          error: { name: "AbcdefGhijklmno", message: "失败" },
        }],
      },
      {
        shardId: "task-code-allowlist-stable",
        prompt: "分片 3",
        status: "timed_out",
        createdAt: 31,
        updatedAt: 80,
        attempts: [{
          attempt: 1,
          status: "timed_out",
          childId: "cla-3",
          startedAt: 71,
          finishedAt: 80,
          // 精确允许列表内的稳定码原样保留。
          error: { code: "EAI_AGAIN", message: "请求超时" },
        }],
      },
    ],
  }];
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: fanoutChildModels(rootId, "task-code-allowlist", ["cla-1", "cla-2", "cla-3"]),
    tasks,
    readSession: async (sessionId) => ({
      session: { id: sessionId, parentSession: rootId, createdAt: 20 },
      events: [],
    }),
  });

  // 轻量快照即已包含 manager 的失败摘要：编码载荷在首屏就不得出现。
  const partial = await runtime.snapshotForSession(rootId);
  const partialTask = partial.root.children.find((node) => node.parentTaskId === "task-code-allowlist");
  assert.deepEqual(
    partialTask.shards.map((shard) => shard.failure.code),
    ["error", "error", "EAI_AGAIN"],
  );
  assert.deepEqual(partialTask.failure, { code: "error", message: FAILURE_REDACTED_MESSAGE });

  const full = await runtime.awaitFullBuild(rootId);
  const fullTask = full.root.children.find((node) => node.parentTaskId === "task-code-allowlist");
  assert.deepEqual(
    fullTask.shards.map((shard) => shard.failure.code),
    ["error", "error", "EAI_AGAIN"],
  );
  for (const snapshot of [partial, full]) {
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["YXBPPWFL_ZGFJZWFHAA", "AbcdefGhijklmno"]) {
      assert.equal(serialized.includes(secret), false, "快照不得包含编码载荷：" + secret);
    }
  }
});

test("多个冷 child 的会话读取受控并发，且并发数有上限", async () => {
  const rootId = "root-cold-parallel";
  const childIds = ["child-cold-1", "child-cold-2", "child-cold-3", "child-cold-4", "child-cold-5", "child-cold-6"];
  const probe = coldReadProbe({ openAt: 2 });
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    readSession: async (sessionId) => {
      probe.enter(sessionId);
      await probe.gate;
      probe.leave(sessionId);
      return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
    },
  });

  // 首屏返回轻量快照（不等待闸门后的冷读），随后等待后台完整构建。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  const snapshot = await runtime.awaitFullBuild(rootId);
  probe.close();

  assert.equal(probe.watchdogFired, false, "冷读必须真的并发：闸门只等第 2 个并发读取，串行实现等不到");
  assert.ok(probe.maxInFlight >= 2, "同时进行的冷读数量应 >= 2，实测 " + probe.maxInFlight);
  // 上限 = host/expert-group-runtime.js 的 COLD_READ_CONCURRENCY；调整该常量时同步更新此断言。
  assert.ok(probe.maxInFlight <= 4, "冷读必须有并发上限，不得一次性无界启动全部读取，实测 " + probe.maxInFlight);
  assert.equal(probe.started.length, childIds.length, "每个冷 child 恰好触发一次冷读");
  assert.deepEqual(
    snapshot.root.children.map((child) => child.id),
    childIds,
    "并发读取之后，任务树顺序仍与输入（childModels 键）顺序一致",
  );
});

test("冷 child 的投影顺序不依赖冷读完成顺序", async () => {
  const rootId = "root-cold-order";
  const childIds = ["child-order-1", "child-order-2", "child-order-3"];
  // 每个冷读各自等待固定数量的微任务：输入越靠前完成越晚，完成顺序被刻意做成输入顺序的逆序。
  const ticks = new Map([["child-order-1", 6], ["child-order-2", 4], ["child-order-3", 2]]);
  const probe = coldReadProbe({ openAt: childIds.length });
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    readSession: async (sessionId) => {
      probe.enter(sessionId);
      await probe.gate;
      for (let tick = ticks.get(sessionId); tick > 0; tick -= 1) await Promise.resolve();
      probe.leave(sessionId);
      return {
        session: { id: sessionId, parentSession: rootId, createdAt: 20 },
        events: [{ type: "session/title", data: { title: "标题 " + sessionId } }],
      };
    },
  });

  // 首屏：轻量返回后由后台完整构建完成这批冷读（闸门等满 3 个才放行，串行实现等不到）。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  const snapshot = await runtime.awaitFullBuild(rootId);
  probe.close();

  assert.equal(probe.watchdogFired, false, "同一批冷读必须完全重叠（闸门等满 3 个）才能放行");
  assert.equal(probe.maxInFlight, childIds.length, "同一批冷读必须同时在飞");
  assert.deepEqual(probe.finished, [...childIds].reverse(), "冷读完成顺序已被刻意打乱，顺序断言才不是空断言");
  assert.deepEqual(snapshot.root.children.map((child) => child.id), childIds, "任务树顺序必须与输入顺序一致");
  assert.deepEqual(
    snapshot.root.children.map((child) => child.taskName),
    childIds.map((id) => "标题 " + id),
    "并发读取不得串号：每个节点必须读到自己的会话",
  );
});

test("live child 仍走快速路径，不进入冷读并发池", async () => {
  const rootId = "root-live-fast";
  const started = [];
  const liveEvents = [{ type: "session/title", data: { title: "在线专家标题" } }];
  const liveSession = {
    id: "child-live-agent",
    status: "running",
    header: { id: "child-live-agent", parentSession: rootId },
    snapshotEvents: () => liveEvents,
    requestHeader: () => ({ config: { provider: "live-provider", model: "live-model" } }),
  };
  const recordSession = {
    id: "child-live-record",
    status: "idle",
    header: { id: "child-live-record", parentSession: rootId },
    snapshotEvents: () => [{ type: "session/title", data: { title: "缓存专家标题" } }],
    requestHeader: () => ({ config: {} }),
  };
  const root = {
    id: rootId,
    status: "idle",
    session: { id: rootId, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  };
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: {
      get: (childId) => (childId === "child-live-agent"
        ? { id: childId, status: "running", options: { provider: "live-provider", model: "live-model" }, session: liveSession }
        : undefined),
    },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => root, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [], tasksOwnedBy: () => [] },
    recovery: { contextFor: () => undefined },
    // recovery record 自带会话：parentId 既是归属证据，也让它直接复用 record.session。
    recoveryRecords: new Map([
      ["child-live-record", { childId: "child-live-record", parentId: rootId, session: recordSession }],
    ]),
    source: () => ({
      childModels: Object.fromEntries(
        ["child-live-record", "child-live-agent", "child-cold-fast"]
          .map((id) => [id, { parentId: rootId, role: "fixer", createdAt: 10 }]),
      ),
    }),
    sessionQuery: () => ({
      async readSession(sessionId) {
        started.push(sessionId);
        return {
          session: { id: sessionId, parentSession: rootId, createdAt: 10 },
          events: [{ type: "session/title", data: { title: "冷标题" } }],
        };
      },
    }),
    now: () => 100,
  }));

  // 轻量首屏：live/cached 会话在首屏就已经生效（它们不需要任何冷读）。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  assert.deepEqual(
    partial.root.children.map((child) => child.taskName),
    ["缓存专家标题", "在线专家标题", null],
    "live/cached child 的任务名在轻量快照里就已经可用；冷 child 只留空，绝不猜",
  );

  const snapshot = await fullSnapshotFor(runtime, rootId);
  assert.equal(snapshot.partial, false);
  assert.deepEqual(started, ["child-cold-fast"], "持有在线/缓存会话的 live child 不得再触发冷读");
  // ids 顺序 = recoveryRecords 顺序 + childModels 新增键；createdAt 相同，投影按输入顺序稳定输出。
  assert.deepEqual(
    snapshot.root.children.map((child) => child.id),
    ["child-live-record", "child-live-agent", "child-cold-fast"],
    "混合 live/冷 child 时任务树顺序仍按输入顺序",
  );
  assert.deepEqual(
    snapshot.root.children.map((child) => child.taskName),
    ["缓存专家标题", "在线专家标题", "冷标题"],
    "每个节点读取的都是自己的会话",
  );
});

test("冷读失败仍原样向上抛出，且首个失败后不再调度新的冷读", async () => {
  const rootId = "root-cold-error";
  const childIds = ["child-err", "child-ok-1", "child-ok-2", "child-ok-3", "child-ok-4", "child-ok-5",
    "child-ok-6", "child-ok-7", "child-ok-8", "child-ok-9", "child-ok-10", "child-ok-11"];
  const started = [];
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    readSession: async (sessionId) => {
      started.push(sessionId);
      if (sessionId === "child-err") {
        const error = new Error("session storage denied");
        error.code = "EACCES";
        throw error;
      }
      // 其余读取跨过一个宏任务：保证首个失败先被观察到，之后不再领取新项。
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
    },
  });

  // 首屏不等待冷读：即使冷读注定失败，轻量快照也照常返回（partial:true）。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  // 失败由**后台完整构建**承载：错误仍原样暴露，只是不再阻塞首屏。
  await assert.rejects(
    runtime.awaitFullBuild(rootId),
    (error) => error.code === "EACCES" && /session storage denied/.test(error.message),
    "权限/存储错误必须原样向上暴露，不得被并发池吞掉或改写",
  );
  assert.ok(started.includes("child-err"), "失败的 child 必须真的被读取过");
  assert.equal(started.length, 4, "首错后只能保留首批 4 个已启动冷读，不能再领取后续项，实测 " + started.length);
});

test("首个冷读失败后等待已启动 worker 收敛（含迟到失败），不产生未处理 rejection", async () => {
  const rootId = "root-cold-late-failure";
  // 前 4 个 child 就是并发池一次启动的整批：第 1 个立即失败，第 3 个稍后失败，其余慢成功。
  const childIds = ["child-fail-first", "child-ok-1", "child-fail-late", "child-ok-2", "child-ok-3", "child-ok-4"];
  const firstError = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const lateError = Object.assign(new Error("session log truncated"), { code: "EBADMSG" });
  const track = coldReadTracker();
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    readSession: async (sessionId) => {
      const batchId = track.batch;
      track.enter(batchId, sessionId);
      try {
        if (sessionId === "child-fail-first") throw firstError;
        // 迟到失败与慢成功都先跨一个宏任务：首个错误一定先于它们产生。
        await delayMs(5);
        if (sessionId === "child-fail-late") throw lateError;
        return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
      } finally {
        track.leave(batchId, sessionId);
      }
    },
  });

  let inFlightAtReject = null;
  try {
    // 首屏轻量返回（不等待冷读），失败由后台完整构建承载。
    const partial = await runtime.snapshotForSession(rootId);
    assert.equal(partial.partial, true);
    await assert.rejects(
      runtime.awaitFullBuild(rootId).catch((error) => {
        inFlightAtReject = track.inFlight;
        throw error;
      }),
      (error) => error === firstError,
      "调用方必须拿到首个错误对象本身，而不是迟到失败的错误",
    );
    // 再让事件循环转几圈：迟到失败若没有被收敛，这里就会冒出未处理的 rejection。
    await delayMs(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(inFlightAtReject, 0, "抛出错误前必须等所有已启动的冷读 settle，否则立即重试会与旧批次重叠");
  assert.equal(track.settled.length, track.started.length, "已启动的 worker 必须全部收敛（含迟到失败）");
  assert.ok(
    track.started.some((entry) => entry.sessionId === "child-fail-late"),
    "迟到失败的 worker 必须真的启动过，否则这个用例证明不了收敛",
  );
  assert.equal(track.started.length, 4, "首错后只能保留首批 4 个已启动冷读，不能再领取后续项，实测 " + track.started.length);
  assert.deepEqual(unhandled, [], "迟到失败不得变成未处理的 rejection");
});

test("同一 root 首个快照失败后立即重试不与旧批次冷读重叠，峰值并发不超过上限", async () => {
  const rootId = "root-cold-retry";
  const childIds = ["child-fail-once", "child-retry-1", "child-retry-2", "child-retry-3", "child-retry-4", "child-retry-5"];
  const firstError = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const track = coldReadTracker();
  let failedOnce = false;
  // 失败退避（R1）会把「失败后立刻重试」挡在窗口外；本用例要验证的是**批次不重叠**，
  // 因此用可控时钟把重试推到退避到期之后，而不是绕过退避（退避本身由缓存回归用例覆盖）。
  const clock = { value: 1_000_000 };
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    now: () => clock.value,
    readSession: async (sessionId) => {
      const batchId = track.batch;
      track.enter(batchId, sessionId);
      try {
        if (sessionId === "child-fail-once" && !failedOnce) {
          failedOnce = true;
          throw firstError;
        }
        // 其余读取都比首个失败慢：若实现不等已启动 worker，重试就会与它们重叠。
        await delayMs(10);
        return {
          session: { id: sessionId, parentSession: rootId, createdAt: 20 },
          events: [{ type: "session/title", data: { title: "标题 " + sessionId } }],
        };
      } finally {
        track.leave(batchId, sessionId);
      }
    },
  });

  // 首屏轻量返回后，后台完整构建原样抛出首个错误。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  await assert.rejects(
    runtime.awaitFullBuild(rootId),
    (error) => error === firstError,
    "第一次完整构建必须原样抛出首个错误",
  );

  // 失败返回后立即重试（退避到期后立即）：旧批次若还在后台读取，新批次就会与它重叠并抬高峰值。
  // 时钟推进量 = FULL_SNAPSHOT_RETRY_MAX_MS（40s），足以越过任意级别的失败退避。
  clock.value += 40_000;
  track.batch = 2;
  await runtime.snapshotForSession(rootId);
  const retried = await runtime.awaitFullBuild(rootId);

  assert.equal(track.overlapped, false, "旧批次结束前不得启动新批次的冷读");
  // 上限 = host/expert-group-runtime.js 的 COLD_READ_CONCURRENCY；调整该常量时同步更新此断言。
  assert.ok(track.peak <= 4, "跨批次峰值并发不得超过上限，实测 " + track.peak);
  assert.deepEqual(retried.root.children.map((child) => child.id), childIds, "重试后的任务树仍按输入顺序");
  assert.deepEqual(
    retried.root.children.map((child) => child.taskName),
    childIds.map((id) => "标题 " + id),
    "重试读到的必须是各自的会话",
  );
});

// ── 跨阶段共享冷读协调器 ────────────────────────────────────────────────────

test("普通 expert 与 fan-out attempt 的冷读跨阶段并行在飞", async () => {
  const rootId = "root-stage-parallel";
  const probe = coldReadProbe({ openAt: 2 });
  const titleEvents = (sessionId) => [{ type: "session/title", data: { title: "标题 " + sessionId } }];
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      // 普通专家：parentId 即归属证据，由 collectExperts 阶段冷读。
      "child-expert-cold": { parentId: rootId, role: "fixer", createdAt: 20 },
      // fan-out attempt：fanout=true，因此只由 fan-out 阶段冷读。
      ...fanoutChildModels(rootId, "task-parallel", ["child-attempt-cold"]),
    },
    tasks: [fanoutTaskFixture({ parentTaskId: "task-parallel", shards: [["child-attempt-cold"]] })],
    readSession: async (sessionId) => {
      probe.enter(sessionId);
      await probe.gate;
      probe.leave(sessionId);
      return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: titleEvents(sessionId) };
    },
  });

  const snapshot = await runtime.snapshotForSession(rootId);
  probe.close();

  assert.equal(probe.watchdogFired, false, "两个阶段的冷读必须同时在飞：串行阶段实现等不到第二个读取");
  assert.ok(probe.maxInFlight >= 2, "跨阶段冷读并发实测 " + probe.maxInFlight);
  assert.ok(probe.maxInFlight <= 4, "跨阶段峰值不得超过全局上限，实测 " + probe.maxInFlight);
  assert.deepEqual(probe.started.slice().sort(), ["child-attempt-cold", "child-expert-cold"], "两个 child 各读一次");
  // 两个阶段的结果进入同一份快照：createdAt 20 的普通专家在前、createdAt 30 的 fan-out 在后（既有排序）。
  assert.deepEqual(snapshot.root.children.map((node) => node.id), ["child-expert-cold", "task-parallel"], "两阶段结果合并成同一棵树");
  const fanoutNode = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.equal(fanoutNode.shards[0].attempts[0].childId, "child-attempt-cold", "fan-out 归属证明成功，导航 childId 保留");
});

test("同一 child 同时出现在普通 expert 与 fan-out attempt 时只冷读一次", async () => {
  const rootId = "root-shared-child";
  const readIds = [];
  const runtime = runtimeWithColdChildren({
    rootId,
    // 没有 fanout 标记：既是普通专家候选，又被 attempt 引用（同一份 childModels 记录）。
    childModels: { "child-shared-cold": { parentId: rootId, role: "fixer", createdAt: 20 } },
    tasks: [fanoutTaskFixture({ parentTaskId: "task-shared", shards: [["child-shared-cold"]] })],
    readSession: async (sessionId) => {
      readIds.push(sessionId);
      // 让两个阶段真正重叠，否则「只读一次」可能只是时序巧合。
      await delayMs(5);
      return {
        session: { id: sessionId, parentSession: rootId, createdAt: 20 },
        events: [{ type: "session/title", data: { title: "共享标题" } }],
      };
    },
  });

  const snapshot = await runtime.snapshotForSession(rootId);

  assert.deepEqual(readIds, ["child-shared-cold"], "同一 parentSessionId + childId 只允许一次 readSession");
  const fanoutNode = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.equal(fanoutNode.shards[0].attempts[0].childId, "child-shared-cold", "fan-out 侧复用同一次读取证明归属");
  // 普通 expert 与 attempt 是同一个会话：节点按既有规则去重，只保留 fan-out 分支。
  assert.deepEqual(snapshot.root.children.map((node) => node.id), ["task-shared"], "去重规则不变");
});

test("多个 fan-out attempt 冷读的峰值不超过全局上限，输出顺序不受完成顺序影响", async () => {
  const rootId = "root-fanout-order";
  const scheduleOrder = ["fa-0", "fa-1", "fa-2", "fa-3", "fa-4", "fa-5", "fa-6", "fa-7"];
  // 2 个父任务 × 2 个 shard × 2 个 attempt；微任务级延迟按调度顺序递减，完成顺序被刻意做成逆序。
  const ticks = new Map(scheduleOrder.map((childId, index) => [childId, scheduleOrder.length - index]));
  const track = coldReadTracker();
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      ...fanoutChildModels(rootId, "task-first", scheduleOrder.slice(0, 4)),
      ...fanoutChildModels(rootId, "task-second", scheduleOrder.slice(4)),
    },
    tasks: [
      fanoutTaskFixture({ parentTaskId: "task-first", shards: [scheduleOrder.slice(0, 2), scheduleOrder.slice(2, 4)] }),
      fanoutTaskFixture({ parentTaskId: "task-second", shards: [scheduleOrder.slice(4, 6), scheduleOrder.slice(6)] }),
    ],
    readSession: async (sessionId) => {
      const batchId = track.batch;
      track.enter(batchId, sessionId);
      try {
        for (let tick = ticks.get(sessionId); tick > 0; tick -= 1) await Promise.resolve();
        return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
      } finally {
        track.leave(batchId, sessionId);
      }
    },
  });

  // 首屏轻量返回，冷读批次由后台完整构建承担（完成顺序的断言因此仍然针对真实批次）。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  const snapshot = await runtime.awaitFullBuild(rootId);

  assert.ok(track.peak >= 2, "fan-out 冷读必须并发，实测峰值 " + track.peak);
  // 上限 = host/expert-group-runtime.js 的 COLD_READ_CONCURRENCY；调整该常量时同步更新此断言。
  assert.ok(track.peak <= 4, "fan-out 冷读峰值不得超过全局上限，实测 " + track.peak);
  const completionOrder = track.settled.map((entry) => entry.sessionId);
  assert.notDeepEqual(completionOrder, scheduleOrder, "完成顺序必须被打乱，顺序断言才不是空断言");
  assert.equal(completionOrder[0], "fa-3", "首批调度中延迟最小的最先完成");
  const fanoutNodes = snapshot.root.children.filter((node) => node.kind === "fanout");
  assert.deepEqual(fanoutNodes.map((node) => node.parentTaskId), ["task-first", "task-second"], "父任务顺序 = 输入顺序");
  assert.deepEqual(
    fanoutNodes.map((node) => node.shards.map((shard) => shard.shardId)),
    [["task-first-s1", "task-first-s2"], ["task-second-s1", "task-second-s2"]],
    "shard 顺序 = 输入顺序",
  );
  assert.deepEqual(
    fanoutNodes.map((node) => node.shards.map((shard) => shard.attempts.map((attempt) => attempt.childId))),
    [[["fa-0", "fa-1"], ["fa-2", "fa-3"]], [["fa-4", "fa-5"], ["fa-6", "fa-7"]]],
    "attempt 顺序 = 输入顺序，与完成顺序无关",
  );
});

test("fan-out 冷读失败后收敛全部已调度读取，首错按输入顺序稳定且重试不与旧批次重叠", async () => {
  const rootId = "root-fanout-retry";
  const firstError = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const earlyError = Object.assign(new Error("session log truncated"), { code: "EBADMSG" });
  const childIds = ["fb-0", "fb-1", "fb-2", "fb-3", "fb-4", "fb-5"];
  const track = coldReadTracker();
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  // 失败退避（R1）会把「失败后立刻重试」挡在窗口外；本用例验证的是**批次不重叠**，
  // 因此用可控时钟把重试推到退避到期之后（退避本身由缓存回归用例覆盖）。
  const clock = { value: 1_000_000 };
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: fanoutChildModels(rootId, "task-fail", childIds),
    tasks: [fanoutTaskFixture({ parentTaskId: "task-fail", shards: [childIds.slice(0, 3), childIds.slice(3)] })],
    now: () => clock.value,
    readSession: async (sessionId) => {
      const batchId = track.batch;
      track.enter(batchId, sessionId);
      try {
        // 输入顺序上的首个失败（fb-0）被**刻意延后**：时序上更早失败的是 fb-1。
        // 对外错误必须仍取输入顺序上的首个失败，证明首错契约与完成时序无关。
        if (batchId === 1 && sessionId === "fb-0") {
          await delayMs(10);
          throw firstError;
        }
        if (batchId === 1 && sessionId === "fb-1") throw earlyError;
        await delayMs(5);
        return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
      } finally {
        track.leave(batchId, sessionId);
      }
    },
  });

  let inFlightAtReject = null;
  try {
    const partial = await runtime.snapshotForSession(rootId);
    assert.equal(partial.partial, true);
    await assert.rejects(
      runtime.awaitFullBuild(rootId).catch((error) => {
        inFlightAtReject = track.inFlight;
        throw error;
      }),
      (error) => error === firstError,
      "调用方必须拿到输入顺序上的首个错误，而不是时序上更早的错误",
    );
    // 再让事件循环转几圈：被收敛的失败若漏处理，这里就会冒出未处理的 rejection。
    await delayMs(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.equal(track.settled[0].sessionId, "fb-1", "时序上更早失败的确实是 fb-1（该用例的前提）");
  assert.equal(inFlightAtReject, 0, "抛出错误前必须等所有已调度读取 settle");
  assert.deepEqual(
    track.started.map((entry) => entry.sessionId),
    childIds,
    "所有输入 child 都必须进入协调器，且排队启动顺序 = 输入 FIFO 顺序",
  );
  assert.equal(track.settled.length, track.started.length, "已启动的读取必须全部收敛（无残留）");
  assert.deepEqual(
    [...new Set(track.settled.map((entry) => entry.sessionId))].sort(),
    [...childIds].sort(),
    "每个输入 child 都必须最终 settle",
  );
  assert.ok(track.peak <= 4, "失败批次的峰值不得超过全局上限，实测 " + track.peak);
  assert.deepEqual(unhandled, [], "被收敛的失败不得变成未处理的 rejection");

  // 失败返回后立即重试（退避到期后立即）：旧批次已完全收敛，新批次不得与它重叠，峰值仍在全局上限内。
  // 时钟推进量 = FULL_SNAPSHOT_RETRY_MAX_MS（40s），足以越过任意级别的失败退避。
  clock.value += 40_000;
  track.batch = 2;
  await runtime.snapshotForSession(rootId);
  const retried = await runtime.awaitFullBuild(rootId);
  assert.equal(track.overlapped, false, "旧批次结束前不得启动新批次的冷读");
  // 上限 = host/expert-group-runtime.js 的 COLD_READ_CONCURRENCY；调整该常量时同步更新此断言。
  assert.ok(track.peak <= 4, "跨批次峰值不得超过全局上限，实测 " + track.peak);
  const retriedAttempts = retried.root.children
    .filter((node) => node.kind === "fanout")[0]
    .shards.map((shard) => shard.attempts.map((attempt) => attempt.childId));
  assert.deepEqual(retriedAttempts, [childIds.slice(0, 3), childIds.slice(3)], "重试后的 attempt 顺序仍与输入一致");
});

// ── 并行化后的阶段错误兼容性 ────────────────────────────────────────────────

test("普通 expert 与 fan-out 同时失败时优先返回 fan-out 阶段的错误", async () => {
  const rootId = "root-stage-error-order";
  // 两种时序都断言：顶层错误选择只取「优化前的阶段顺序」（fan-out 优先），与谁先失败无关。
  const cases = [
    { label: "fan-out 立即失败、expert 延迟失败", fanoutDelay: 0, expertDelay: 15 },
    { label: "expert 立即失败、fan-out 延迟失败", fanoutDelay: 15, expertDelay: 0 },
  ];
  for (const testCase of cases) {
    const fanoutError = Object.assign(new Error("fanout projection failed"), { code: "EFANOUT" });
    const expertError = Object.assign(new Error("expert read failed"), { code: "EEXPERT" });
    const readIds = [];
    const runtime = runtimeWithColdChildren({
      rootId,
      childModels: {
        "child-expert-fail": { parentId: rootId, role: "fixer", createdAt: 20 },
        ...fanoutChildModels(rootId, "task-error-order", ["child-fanout-fail"]),
      },
      tasks: [fanoutTaskFixture({ parentTaskId: "task-error-order", shards: [["child-fanout-fail"]] })],
      readSession: async (sessionId) => {
        readIds.push(sessionId);
        if (sessionId === "child-fanout-fail") {
          await delayMs(testCase.fanoutDelay);
          throw fanoutError;
        }
        await delayMs(testCase.expertDelay);
        throw expertError;
      },
    });

    // 轻量首屏照常返回；两个阶段同时失败时，顶层错误选择仍按优化前的阶段顺序（fan-out 优先）。
    const partial = await runtime.snapshotForSession(rootId);
    assert.equal(partial.partial, true);
    await assert.rejects(
      runtime.awaitFullBuild(rootId),
      (error) => error === fanoutError,
      testCase.label + "：顶层必须抛 fan-out 阶段的错误（兼容优化前的阶段顺序）",
    );
    assert.deepEqual(
      readIds.slice().sort(),
      ["child-expert-fail", "child-fanout-fail"],
      testCase.label + "：两个阶段都必须真的失败过",
    );
  }
});

test("同一 child 的冷读 rejection 被两侧共享，只读一次且不产生未处理 rejection", async () => {
  const rootId = "root-shared-rejection";
  const readIds = [];
  const thrownErrors = [];
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  // 失败退避（R1）会把「失败后立刻重试」挡在窗口外；本用例验证的是**rejection 共享与不跨快照缓存**，
  // 因此用可控时钟把第二次构建推到退避到期之后（退避本身由缓存回归用例覆盖）。
  const clock = { value: 1_000_000 };
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: { "child-shared-fail": { parentId: rootId, role: "fixer", createdAt: 20 } },
    tasks: [fanoutTaskFixture({ parentTaskId: "task-shared-fail", shards: [["child-shared-fail"]] })],
    now: () => clock.value,
    readSession: async (sessionId) => {
      readIds.push(sessionId);
      // 每次调用都产生新的错误对象：协调器若没有缓存 rejection，对外错误就不会是第一个对象。
      const error = Object.assign(new Error("session storage denied"), { code: "EACCES" });
      thrownErrors.push(error);
      // 让两个阶段都先发起请求，证明去重发生在读取 promise 上，而不是靠时序巧合。
      await delayMs(5);
      throw error;
    },
  });

  let observed = null;
  try {
    const partial = await runtime.snapshotForSession(rootId);
    assert.equal(partial.partial, true);
    await assert.rejects(
      runtime.awaitFullBuild(rootId).catch((error) => {
        observed = error;
        throw error;
      }),
      (error) => error === thrownErrors[0],
      "对外错误必须是最初那次读取抛出的对象（两侧共享同一个 rejection）",
    );
    await delayMs(20);
    // 失败后立即重试（退避到期后立即）：协调器只活在单次构建里，新构建必须重新读取
    // （不得跨快照缓存失败结果）。时钟推进量 = FULL_SNAPSHOT_RETRY_MAX_MS（40s）。
    clock.value += 40_000;
    await runtime.snapshotForSession(rootId);
    await assert.rejects(runtime.awaitFullBuild(rootId), /session storage denied/);
    await delayMs(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(readIds, ["child-shared-fail", "child-shared-fail"], "每次构建内同一 child 只读一次，且缓存不跨快照");
  assert.equal(thrownErrors.length, 2, "两次构建各读取一次，失败结果没有被跨快照缓存");
  assert.equal(observed, thrownErrors[0], "两侧共享同一个 rejection 对象");
  assert.deepEqual(unhandled, [], "共享的 rejection 不得变成未处理的 rejection");
});

// ── 首屏轻量快照 / 后台完整快照替换 ──────────────────────────────────────────

test("首屏在冷读完成前即返回轻量快照，后台完成后同一 root 替换为完整快照", async () => {
  const rootId = "root-first-paint";
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  const runtime = coldOnlyRuntime({
    rootId,
    childIds: ["child-paint-1", "child-paint-2"],
    readSession: async (sessionId) => {
      reads += 1;
      // 冷读被闸门挡住：首屏只有在「不等待冷读」时才能返回。
      await readGate;
      return {
        session: { id: sessionId, parentSession: rootId, createdAt: 20 },
        events: [
          { type: "session/title", data: { title: "标题 " + sessionId } },
          { type: "turn/end", data: { reason: { kind: "completed" } } },
        ],
      };
    },
  });

  const first = await runtime.snapshotForSession(rootId);
  assert.equal(first.partial, true, "首屏必须是轻量快照（partial:true）");
  assert.deepEqual(first.root.children.map((child) => child.id), ["child-paint-1", "child-paint-2"], "轻量快照已经列出全部专家（来自 child_models 的归属证明）");
  assert.deepEqual(first.root.children.map((child) => child.taskName), [null, null], "轻量快照不猜任务名");
  assert.deepEqual(first.root.children.map((child) => child.status), ["unknown", "unknown"], "没有任何运行证据时不得声明 ready，更不得伪造终态");
  assert.deepEqual(first.root.children.map((child) => child.running), [null, null], "证据不足时不写 running 布尔");

  // 冷读还没结束时，轮询继续复用同一份轻量快照（不阻塞、不重跑）。
  const second = await runtime.snapshotForSession(rootId);
  assert.equal(second, first, "完整快照未就绪时，轮询复用同一份轻量快照");

  releaseRead();
  const full = await runtime.awaitFullBuild(rootId);
  assert.equal(full.partial, false, "后台完成后必须是完整快照");
  assert.deepEqual(full.root.children.map((child) => child.taskName), ["标题 child-paint-1", "标题 child-paint-2"], "完整快照读到冷会话标题");
  assert.deepEqual(full.root.children.map((child) => child.status), ["succeeded", "succeeded"], "终态只能由冷日志的 turn/end 证明");

  const third = await runtime.snapshotForSession(rootId);
  assert.equal(third, full, "此后同一个 root 的请求直接命中完整快照缓存");
  assert.equal(reads, 2, "两个 child 各读一次，并且只读这一轮");
});

test("快照缓存跨请求命中、按 child 归属失效、按 TTL 兜底重建并按 root 限制容量", async () => {
  const rootId = "root-cache";
  let clock = 1_000_000;
  const reads = [];
  const liveRoot = {
    id: rootId,
    status: "idle",
    session: { id: rootId, snapshotEvents: () => [], requestHeader: () => ({ config: {} }) },
    options: {},
  };
  const childModels = { "child-cache": { parentId: rootId, role: "fixer", createdAt: 20 } };
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [], tasksOwnedBy: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map([["child-cache", { childId: "child-cache", parentId: rootId }]]),
    // source() 每次现读：容量用例会动态增加 root。
    source: () => ({ childModels }),
    sessionQuery: () => ({
      async readSession(sessionId) {
        reads.push(sessionId);
        return { session: { id: sessionId, parentSession: sessionId === rootId ? undefined : rootId, createdAt: 20 }, events: [] };
      },
    }),
    now: () => clock,
  }));
  void liveRoot;

  await runtime.snapshotForSession(rootId);
  const full = await runtime.awaitFullBuild(rootId);
  assert.equal(full.partial, false);
  // 一次完整构建 = 一次 root 冷读（root 不是 live）+ 一次 child 冷读，绝无重复读取。
  assert.deepEqual(reads, ["root-cache", "child-cache"], "完整构建每个会话只读一次");
  const readsAfterFirstBuild = reads.length;

  // 命中：TTL 内的请求直接复用完整快照，不重跑冷读。
  assert.equal(await runtime.snapshotForSession(rootId), full, "TTL 内必须命中完整快照缓存");
  assert.equal(reads.length, readsAfterFirstBuild, "命中缓存时不得再冷读");

  // 失效：child 会话的事件由 runtime 反查 parentId 找到 root；找不到就是 0（幂等、无泄漏）。
  assert.equal(runtime.invalidateSnapshots("child-cache"), 1, "child 事件必须能失效它所属 root 的快照");
  assert.equal(runtime.invalidateSnapshots("child-cache"), 1, "失效幂等：重复失效不报错，仍然只标记一次");
  assert.equal(runtime.invalidateSnapshots("session-unknown"), 0, "与任何缓存无关的会话 id 不产生失效");
  const afterInvalidate = await runtime.snapshotForSession(rootId);
  assert.equal(afterInvalidate.partial, true, "失效后当次请求必须给出与新状态一致的轻量快照（状态变化立刻可见）");
  assert.notEqual(afterInvalidate, full, "失效后不得再复用旧完整快照");
  const rebuilt = await runtime.awaitFullBuild(rootId);
  assert.equal(rebuilt.partial, false);
  assert.notEqual(rebuilt, full, "失效后必须真正重建，而不是复用旧结果");
  assert.equal(reads.length, readsAfterFirstBuild * 2, "失效后必须重建（root + child 各再读一次）");
  assert.equal(await runtime.snapshotForSession(rootId), rebuilt, "重建结果写回缓存并被后续请求命中");
  const readsAfterInvalidate = reads.length;

  // 兜底 TTL：没有失效事件（只是过期）时继续用上一份权威快照顶住，同时后台重建；
  // 陈旧上界因此由 TTL 保证，而界面不会在 full ↔ fast 之间抖动。
  clock += 5000;
  assert.equal(await runtime.snapshotForSession(rootId), rebuilt, "只过期未失效时必须继续返回上一份权威快照（不降级）");
  await runtime.awaitFullBuild(rootId);
  assert.equal(reads.length, readsAfterInvalidate + 2, "超过完整快照 TTL 必须重建");

  // 容量：按 root 限制缓存数量，最久未写入的 root 会被淘汰（用失效计数间接观察）。
  childModels["child-other-0"] = { parentId: rootId, role: "fixer", createdAt: 20 };
  for (let index = 0; index < 12; index += 1) {
    const other = rootId + "-other-" + index;
    childModels["child-of-" + other] = { parentId: other, role: "fixer", createdAt: 20 };
    await runtime.snapshotForSession(other);
  }
  assert.equal(runtime.invalidateSnapshots(rootId), 0, "超过容量上限后最久未使用的 root 必须被淘汰（缓存不得无界增长）");
});

test("轻量快照保持跨 root 隔离：别的根与错配的分片身份都不得进入本根任务树", async () => {
  const tasks = [{
    parentTaskId: "task-a",
    role: "fixer",
    basePrompt: "A 的公共目标",
    status: "running",
    createdAt: 30,
    shards: [
      {
        shardId: "s1", prompt: "跨根分片", status: "running", createdAt: 31,
        attempts: [{ attempt: 1, status: "running", childId: "child-of-b", startedAt: 31 }],
      },
      {
        shardId: "s2", prompt: "错配分片", status: "running", createdAt: 32,
        attempts: [{ attempt: 1, status: "running", childId: "child-other-task", startedAt: 32 }],
      },
    ],
  }];
  const childModels = {
    "child-of-a": { parentId: "root-a", role: "fixer", createdAt: 20, lastDispatch: { description: "A 的专家" } },
    // 属于别的 root：任何根都不得把它投影进自己的任务树。
    "child-of-b": { parentId: "root-b", role: "fixer", createdAt: 20, lastDispatch: { description: "B 的专家" } },
    // 同根，但记录声明的 fan-out 身份指向别的父任务/分片：廉价反证必须把 childId 清空。
    "child-other-task": {
      parentId: "root-a", role: "fixer", fanout: true,
      fanoutParentTaskId: "task-z", fanoutShardId: "s9", fanoutAttempt: 3, createdAt: 20,
    },
  };
  const runtime = runtimeWithColdChildren({
    rootId: "root-a",
    childModels,
    tasks,
    readSession: async () => { throw new Error("session not found"); },
  });

  const partial = await runtime.snapshotForSession("root-a");
  assert.equal(partial.partial, true);
  assert.deepEqual(
    partial.root.children.map((node) => (node.kind === "expert" ? node.id : node.parentTaskId)),
    ["child-of-a", "task-a"],
    "轻量快照只投影属于本根的 child",
  );
  const fanout = partial.root.children.find((node) => node.kind === "fanout");
  assert.deepEqual(fanout.shards.map((shard) => shard.childId), [null, null], "跨根与错配的 attempt childId 在轻量快照里一律清空");
  assert.deepEqual(
    fanout.shards.map((shard) => shard.attempts.map((attempt) => attempt.childId)),
    [[null], [null]],
    "输出副本清空，manager 的权威快照不被改写",
  );
  assert.equal(tasks[0].shards[0].attempts[0].childId, "child-of-b", "投影绝不修改输入");

  // 完整快照必须给出同样的归属结论（同一套廉价反证），不允许 2.5s 后把跨根 childId 又放回来。
  const full = await runtime.awaitFullBuild("root-a");
  assert.equal(full.partial, false);
  const fullFanout = full.root.children.find((node) => node.kind === "fanout");
  assert.deepEqual(fullFanout.shards.map((shard) => shard.childId), [null, null], "完整快照同样拒绝跨根与错配的 childId");

  // 反向验证：从另一个根的视角看，root-a 的任何 childId 都不得出现（专家行或分片导航都算）。
  const other = await runtime.snapshotForSession("root-b");
  assert.equal(other.partial, true);
  const visibleIds = [];
  for (const node of other.root.children) {
    if (node.kind === "expert") visibleIds.push(node.id);
    for (const shard of Array.isArray(node.shards) ? node.shards : []) {
      if (shard.childId !== null) visibleIds.push(shard.childId);
      for (const attempt of Array.isArray(shard.attempts) ? shard.attempts : []) {
        if (attempt.childId !== null) visibleIds.push(attempt.childId);
      }
    }
  }
  assert.ok(
    !visibleIds.includes("child-of-a") && !visibleIds.includes("child-other-task"),
    "root-b 视角不得出现 root-a 的任何 childId，实测 " + JSON.stringify(visibleIds),
  );
});

/**
 * 用时口径（用户要求）：DEG 侧栏的“用时”必须与 DSH 状态行同源——当前/最近一轮 turn 的
 * 墙钟（turn/start → now，或 turn/end - turn/start），而不是模型用时 sessionStats.llmMs。
 * 这里用真实事件形状（顶层 time 为 epoch ms）锁定 root 与 expert 两条投影路径。
 */
test("用时口径：turnDurationMs 投影当前/最近一轮 turn 墙钟，root 与 expert 同源", async () => {
  const rootEvents = [
    { type: "turn/start", time: 1000, data: { turn: 1 } },
    { type: "turn/end", time: 4000, data: { turn: 1 } },
    { type: "turn/start", time: 10000, data: { turn: 2 } },
  ];
  const rootSession = {
    id: "root-clock",
    status: "running",
    createdAt: 1,
    snapshotEvents: () => rootEvents,
    requestHeader: () => ({ config: {} }),
  };
  const coldLogs = new Map([
    ["child-clock", {
      session: { id: "child-clock", parentSession: "root-clock", createdAt: 20 },
      events: [
        { type: "turn/start", time: 2000, data: { turn: 1 } },
        { type: "turn/end", time: 9000, data: { turn: 1 } },
      ],
    }],
  ]);
  const runtime = createExpertGroupRuntime(runtimeDeps({
    agents: { get: (id) => id === "root-clock" ? { id, status: "running", session: rootSession } : undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => ({ id: "root-clock", status: "running", session: rootSession, options: {} }), tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({
      childModels: {
        "child-clock": { parentId: "root-clock", role: "fixer", continuable: true, createdAt: 20 },
      },
    }),
    sessionQuery: () => ({
      async readSession(sessionId) {
        const log = coldLogs.get(sessionId);
        if (log === undefined) throw new Error("session not found");
        return log;
      },
    }),
    now: () => 50000,
  }));
  const snapshot = await fullSnapshotFor(runtime, "root-clock");
  // 根：最后一个 turn 仍 open，用时 = now(50000) - 最后一个 turn/start(10000)。
  assert.equal(snapshot.root.turnDurationMs, 40000, "root 必须取当前打开 turn 的墙钟");
  // 专家：最后一次 turn 已结束，用时 = turn/end(9000) - turn/start(2000)。
  assert.equal(snapshot.root.children[0].turnDurationMs, 7000, "expert 必须取最近一轮已完成 turn 的墙钟");
  // 没有 turn 事件的会话不投影该字段（旧宿主/旧日志），由客户端回退模型用时。
  const plain = runtimeWithRootEvents({ id: "root-no-turn", status: "running", events: [{ type: "session/title", data: { title: "无轮次事件" } }] });
  const plainSnapshot = await plain.snapshotForSession("root-no-turn");
  assert.equal(Object.prototype.hasOwnProperty.call(plainSnapshot.root, "turnDurationMs"), false);
});

// ── R2 阶段收敛断言（票据 09 / plan R2.5-a） ─────────────────────────────────
//
// 四条契约（不得回归）：
// 1. 双失败时抛出的错误对象**严格等于** fan-out 阶段的错误对象，且与完成时序无关
//    （已由「普通 expert 与 fan-out 同时失败时优先返回 fan-out 阶段的错误」用例锁定，
//    该用例同时覆盖「fan-out 先失败」「expert 先失败」两种时序并按引用比较）；
// 2. 构建 reject 之后不存在仍在飞的冷读：readSession 调用计数不再增长，同一 root 的立即重试
//    不与旧批次重叠；
// 3. 启动优先级：\`collectExperts\` 的首次 readSession 先于 fan-out 阶段的首次调用（调用序数组）；
// 4. fast 路径零 readSession。

test("阶段收敛：collectExperts 先启动——普通 expert 的首次 readSession 早于 fan-out 阶段的首次调用", async () => {
  const rootId = "root-stage-start-order";
  // 调用序数组就是唯一证据：冷读在协调器里按 FIFO 取号，因此数组顺序 = 两个阶段的启动顺序。
  const calls = [];
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      // 普通专家：由 collectExperts 阶段冷读。
      "child-expert-order": { parentId: rootId, role: "fixer", createdAt: 20 },
      // fan-out attempt：fanout=true，只由 fan-out 阶段冷读。
      ...fanoutChildModels(rootId, "task-order", ["child-attempt-order"]),
    },
    tasks: [fanoutTaskFixture({ parentTaskId: "task-order", shards: [["child-attempt-order"]] })],
    readSession: async (sessionId) => {
      calls.push(sessionId);
      // 两个阶段都立刻发起读取；完成顺序与本断言无关（这里甚至不需要延迟）。
      return {
        session: { id: sessionId, parentSession: rootId, createdAt: 20 },
        events: [{ type: "session/title", data: { title: "标题 " + sessionId } }],
      };
    },
  });

  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true, "首屏仍是轻量快照");
  await runtime.awaitFullBuild(rootId);

  assert.equal(calls.length, 2, "两个 child 各冷读一次，实测 " + JSON.stringify(calls));
  assert.equal(
    calls[0],
    "child-expert-order",
    "collectExperts 必须先启动：它的首次 readSession 必须排在 fan-out 阶段之前，实测 " + JSON.stringify(calls),
  );
  assert.equal(calls[1], "child-attempt-order", "fan-out 阶段的读取紧随其后，实测 " + JSON.stringify(calls));
});

test("阶段收敛：fast 路径零 readSession——冷读只发生在后台完整构建", async () => {
  const rootId = "root-fast-zero-read";
  const childIds = ["child-fast-1", "child-fast-2"];
  const readIds = [];
  let releaseRead;
  const gate = new Promise((resolve) => { releaseRead = resolve; });
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    readSession: async (sessionId) => {
      readIds.push(sessionId);
      // 冷读被闸门挡住：任何「等待冷读」的路径都不可能先返回，因此首屏能返回就是证据。
      await gate;
      return {
        session: { id: sessionId, parentSession: rootId, createdAt: 20 },
        events: [
          { type: "session/title", data: { title: "标题 " + sessionId } },
          { type: "turn/end", data: { reason: { kind: "completed" } } },
        ],
      };
    },
  });

  const first = await runtime.snapshotForSession(rootId);
  assert.equal(first.partial, true, "首屏必须是轻量快照（partial:true）");
  // 轻量快照里没有任何冷读内容：标题与终态都必须缺失（证明 fast 没等过任何 readSession）。
  assert.deepEqual(first.root.children.map((child) => child.taskName), [null, null], "轻量快照不猜任务名");
  assert.deepEqual(first.root.children.map((child) => child.status), ["unknown", "unknown"], "没有运行证据时不得声明终态");

  releaseRead();
  const full = await runtime.awaitFullBuild(rootId);
  assert.equal(full.partial, false, "后台完成后必须是完整快照");
  // 关键断言：每次构建都有**自己的**协调器，因此 fast 若真的冷读过，计数会是 2×childIds。
  assert.deepEqual(
    readIds.slice().sort(),
    childIds.slice().sort(),
    "只有后台完整构建读过（每个 child 一次），实测 " + JSON.stringify(readIds),
  );
});

test("阶段收敛：构建 reject 后不再有在飞冷读，同一 root 的立即重试不与旧批次重叠", async () => {
  const rootId = "root-stage-settled";
  const childIds = ["child-settled-fail", "child-settled-slow-1", "child-settled-slow-2"];
  const failure = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const track = coldReadTracker();
  const clock = { value: 1_000_000 };
  let failedOnce = false;
  const runtime = coldOnlyRuntime({
    rootId,
    childIds,
    now: () => clock.value,
    readSession: async (sessionId) => {
      const batchId = track.batch;
      track.enter(batchId, sessionId);
      try {
        if (sessionId === "child-settled-fail" && !failedOnce) {
          failedOnce = true;
          throw failure;
        }
        // 其余读取都比首个失败慢：实现若不等已启动 worker，reject 返回后仍会有读取在飞。
        await delayMs(10);
        return { session: { id: sessionId, parentSession: rootId, createdAt: 20 }, events: [] };
      } finally {
        track.leave(batchId, sessionId);
      }
    },
  });

  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true);
  await assert.rejects(runtime.awaitFullBuild(rootId), (error) => error === failure, "构建必须原样抛出首个错误");

  // 断言 1：reject 返回时已启动的读取全部 settle，且此后调用计数不再增长。
  assert.equal(track.inFlight, 0, "reject 返回时不得有在飞冷读，实测 inFlight=" + track.inFlight);
  const settledCount = track.started.length;
  await delayMs(30);
  assert.equal(track.started.length, settledCount, "reject 之后 readSession 调用计数不得再增长");

  // 断言 2：同一 root 立即重试（时钟越过失败退避后）不与旧批次重叠。
  clock.value += 40_000;
  track.batch = 2;
  await runtime.snapshotForSession(rootId);
  const retried = await runtime.awaitFullBuild(rootId);
  assert.equal(retried.partial, false, "重试必须拿到完整快照");
  assert.equal(track.overlapped, false, "旧批次结束前不得启动新批次的冷读");
  assert.ok(track.peak <= 4, "跨批次峰值并发不得超过上限，实测 " + track.peak);
});

/**
 * G7（plan R2.5 覆盖缺口）：后台完整构建失败必须有 logger 出口。
 *
 * 契约：失败经 \`logger.warn\` 输出（带 rootId、错误消息与本次退避时长）；logger 缺失时**静默**，
 * 但 \`lastError\` 仍然保留——\`awaitFullBuild\` 原样抛出同一个错误对象。
 */
test("G7 runtime logger：后台完整构建失败经 logger.warn 出口；缺失 logger 时静默且保留 lastError", async () => {
  /**
   * 构造一个「陌生 root + 根冷读直接失败」的 runtime：首屏轻量返回 null 会回落到完整构建，
   * 因此失败一定走后台构建的 failure handler（正是 G7 要覆盖的出口）。
   */
  const buildRuntime = (logger, failure) => createExpertGroupRuntime(runtimeDeps({
    agents: { get: () => undefined },
    goals: { get: () => undefined },
    lineage: { activeRoot: () => undefined, tasksOwnedBy: () => [] },
    fanoutHost: { listTasks: () => [], tasksOwnedBy: () => [] },
    recovery: { contextFor: () => undefined },
    recoveryRecords: new Map(),
    source: () => ({ childModels: {} }),
    sessionQuery: () => ({ async readSession() { throw failure; } }),
    ...(logger === undefined ? {} : { logger }),
    now: () => 5,
  }));

  // 1) 提供 logger：失败必须经 logger.warn 出口一次，并带上 rootId / 错误消息 / 本次退避时长。
  const warnings = [];
  const failure = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const withLogger = buildRuntime({ warn: (message) => { warnings.push(String(message)); } }, failure);
  await assert.rejects(withLogger.snapshotForSession("root-logger"), (error) => error === failure);
  assert.equal(warnings.length, 1, "失败必须经 logger.warn 出口一次，实测 " + JSON.stringify(warnings));
  assert.match(warnings[0], /background expert-group snapshot build for root-logger failed: session storage denied/);
  assert.match(warnings[0], /retrying in 5000ms/, "日志必须带上本次退避时长，实测 " + warnings[0]);

  // 2) 缺失 logger：静默（不因缺少日志出口而抛错），lastError 仍保留给 awaitFullBuild 观察。
  const silentFailure = Object.assign(new Error("session storage denied"), { code: "EACCES" });
  const silent = buildRuntime(undefined, silentFailure);
  await assert.rejects(silent.snapshotForSession("root-logger-silent"), (error) => error === silentFailure);
  await assert.rejects(
    silent.awaitFullBuild("root-logger-silent"),
    (error) => error === silentFailure,
    "缺失 logger 时必须静默失败并保留 lastError（awaitFullBuild 原样抛出同一对象）",
  );
});



// ── continuation 复用：轮次不是重试，childId 也不得被「身份反证」清空 ───────────
//
// 两个宿主侧缺陷的共同触发场景：continuation 复用同一 child 进入第 2 个逻辑轮次
// （fanout/task-commands.js 给每个分片追加一个 attempt、同时 task.round + 1）。旧实现：
// 1. retryCount = attempts.length - 1，于是复用被当成重试，父任务累计到 3 时侧栏出现
//    「多次重试」徽标；
// 2. child_models.fanoutAttempt 只在 child 创建时写一次（=1），而「身份反证」拿它和当前
//    attempt 号（=2）精确比较，于是第 2 轮被判成矛盾、导航 childId 被清空，行尾 >> 消失。
// 下面三个用例分别锁定：复用不产生重试、真正的身份矛盾仍然 fail-closed、真实重试仍计数。

/** 单分片父任务 fixture；round 是 manager 快照里的逻辑轮次（fanout/store.js 恒给 round>=1）。 */
function roundTaskFixture({ parentTaskId, round, status = "completed", attempts }) {
  return {
    parentTaskId,
    role: "librarian",
    basePrompt: "公共目标",
    status,
    round,
    createdAt: 30,
    shards: [{
      shardId: "s1",
      prompt: "分片 1",
      status,
      createdAt: 31,
      attempts,
    }],
  };
}

/** 冷读返回与 runtimeWithColdChildren 约定一致的会话（header.parentSession 证明归属）。 */
function ownedSessionReader(rootId) {
  return async (sessionId) => ({
    session: { id: sessionId, parentSession: rootId, createdAt: 30 },
    events: [],
  });
}

test("continuation 复用：同一 child 跨两个轮次不得计入 retryCount，childId 必须保留", async () => {
  const rootId = "root-cont";
  const task = roundTaskFixture({
    parentTaskId: "task-cont",
    // 第 2 个逻辑轮次：manager 已经 round=2，两个 attempt 都是同一个 child。
    round: 2,
    attempts: [
      { attempt: 1, status: "succeeded", childId: "child-cont", startedAt: 31, finishedAt: 32 },
      { attempt: 2, status: "succeeded", childId: "child-cont", startedAt: 33, finishedAt: 34 },
    ],
  });
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      // fanoutAttempt 记录的是 child **创建时**的 attempt 号，continuation 复用后仍是 1。
      "child-cont": {
        parentId: rootId,
        role: "librarian",
        fanout: true,
        fanoutParentTaskId: "task-cont",
        fanoutShardId: "s1",
        fanoutAttempt: 1,
        createdAt: 30,
      },
    },
    tasks: [task],
    readSession: ownedSessionReader(rootId),
  });

  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true, "首屏是轻量快照");
  const partialTask = partial.root.children.find((node) => node.parentTaskId === "task-cont");
  const partialShard = partialTask.shards[0];
  // child_models 同时给出 parentId 与 fanoutParentTaskId，属于**廉价归属证据**，因此 partial
  // 阶段也保留导航键（B4 的 fail-closed 差异只发生在完全没有廉价证据时）。
  assert.equal(partialShard.childId, "child-cont", "partial 阶段有廉价归属证据时必须保留导航键");
  assert.equal(partialShard.attempts[1].childId, "child-cont", "复用 child 在最新 attempt 上同样可导航");
  // 缺陷 1：两个 attempt 分属两个逻辑轮次，没有任何一次真实重试。
  assert.equal(partialShard.retryCount, 0, "continuation 复用不得计入分片重试数");
  assert.equal(partialTask.retryCount, 0, "continuation 复用不得计入父任务重试数（否则触发「多次重试」徽标）");

  const full = await runtime.awaitFullBuild(rootId);
  assert.equal(full.partial, false);
  const fullTask = full.root.children.find((node) => node.parentTaskId === "task-cont");
  const fullShard = fullTask.shards[0];
  // 缺陷 2：声明号 1 属于本分片该 child 的 attempt 号域 {1,2}，因此不是身份矛盾。
  assert.equal(fullShard.childId, "child-cont", "continuation 复用的 child 必须继续作为导航目标");
  assert.equal(fullShard.attempts[1].childId, "child-cont", "最新 attempt 的 childId 不得被反证清空");
  assert.equal(fullShard.retryCount, 0);
  assert.equal(fullTask.retryCount, 0);
});

test("身份反证仍然 fail-closed：声明的 fanoutAttempt 不在本分片该 child 的号域内时清空 childId", async () => {
  const rootId = "root-cont-reject";
  const task = roundTaskFixture({
    parentTaskId: "task-cont-reject",
    round: 2,
    attempts: [
      { attempt: 1, status: "succeeded", childId: "child-reject", startedAt: 31, finishedAt: 32 },
      { attempt: 2, status: "succeeded", childId: "child-reject", startedAt: 33, finishedAt: 34 },
    ],
  });
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      // 5 不属于 {1,2}：这是真正的身份矛盾，必须保持 fail-closed（不放宽反证）。
      "child-reject": {
        parentId: rootId,
        role: "librarian",
        fanout: true,
        fanoutParentTaskId: "task-cont-reject",
        fanoutShardId: "s1",
        fanoutAttempt: 5,
        createdAt: 30,
      },
    },
    tasks: [task],
    readSession: ownedSessionReader(rootId),
  });

  const partial = await runtime.snapshotForSession(rootId);
  const partialShard = partial.root.children.find((node) => node.parentTaskId === "task-cont-reject").shards[0];
  assert.equal(partialShard.childId, null, "partial 阶段身份矛盾必须 fail-closed");

  const full = await runtime.awaitFullBuild(rootId);
  const fullTask = full.root.children.find((node) => node.parentTaskId === "task-cont-reject");
  const fullShard = fullTask.shards[0];
  assert.equal(fullShard.childId, null, "号域外的 fanoutAttempt 仍是身份矛盾：导航键必须清空");
  assert.equal(fullShard.attempts[1].childId, null, "逐 attempt 的 childId 同样必须清空");
  // 重试口径与身份反证相互独立：清空导航键不影响真实重试计数（这里仍是复用轮次）。
  assert.equal(fullShard.retryCount, 0);
  assert.equal(fullTask.retryCount, 0);
});

test("身份反证缺作用域声明时回退精确比较：只声明 fanoutAttempt 的记录不得靠号域成员关系保留 childId", async () => {
  // 缺陷前提（oracle 复审）：号域成员判定只在记录**同时声明** fanoutParentTaskId 与
  // fanoutShardId 时才成立；只有 fanoutAttempt 的陈旧记录无法用「号在本分片该 child 的
  // 号域内」证明归属，必须回退精确比较（declaredAttempt !== 当前 attempt 即矛盾）。
  //
  // 反例 A（需求指定的形状）：fanoutAttempt=5、无作用域声明，attempts 为 1/2。
  const rootA = "root-cont-scope-missing-a";
  const taskA = roundTaskFixture({
    parentTaskId: "task-cont-scope-missing-a",
    round: 2,
    attempts: [
      { attempt: 1, status: "succeeded", childId: "child-scope-a", startedAt: 31, finishedAt: 32 },
      { attempt: 2, status: "succeeded", childId: "child-scope-a", startedAt: 33, finishedAt: 34 },
    ],
  });
  const runtimeA = runtimeWithColdChildren({
    rootId: rootA,
    childModels: {
      // 只声明 fanoutAttempt：缺少 fanoutParentTaskId / fanoutShardId。
      "child-scope-a": {
        parentId: rootA,
        role: "librarian",
        fanout: true,
        fanoutAttempt: 5,
        createdAt: 30,
      },
    },
    tasks: [taskA],
    readSession: ownedSessionReader(rootA),
  });
  const partialA = await runtimeA.snapshotForSession(rootA);
  assert.equal(partialA.root.children.find((node) => node.parentTaskId === "task-cont-scope-missing-a").shards[0].childId, null,
    "缺作用域声明时号域成员关系不构成归属证据：partial 阶段必须 fail-closed");
  const fullA = await runtimeA.awaitFullBuild(rootA);
  const fullShardA = fullA.root.children.find((node) => node.parentTaskId === "task-cont-scope-missing-a").shards[0];
  assert.equal(fullShardA.childId, null, "缺作用域声明且号不等于当前 attempt：导航键必须清空");
  assert.equal(fullShardA.attempts[1].childId, null, "逐 attempt 的 childId 同样必须清空");

  // 反例 B（判别性用例）：fanoutAttempt=1 虽落在号域 {1,2} 内，但缺作用域声明，不能靠成员关系
  // 保留；精确比较与最新 attempt（2）不符 → 导航键必须清空。旧实现会保留 childId，本用例因此
  // 真正锁住「回退精确比较」这一改动。
  const rootB = "root-cont-scope-missing-b";
  const taskB = roundTaskFixture({
    parentTaskId: "task-cont-scope-missing-b",
    round: 2,
    attempts: [
      { attempt: 1, status: "succeeded", childId: "child-scope-b", startedAt: 31, finishedAt: 32 },
      { attempt: 2, status: "succeeded", childId: "child-scope-b", startedAt: 33, finishedAt: 34 },
    ],
  });
  const runtimeB = runtimeWithColdChildren({
    rootId: rootB,
    childModels: {
      "child-scope-b": {
        parentId: rootB,
        role: "librarian",
        fanout: true,
        fanoutAttempt: 1,
        createdAt: 30,
      },
    },
    tasks: [taskB],
    readSession: ownedSessionReader(rootB),
  });
  const partialB = await runtimeB.snapshotForSession(rootB);
  const partialShardB = partialB.root.children.find((node) => node.parentTaskId === "task-cont-scope-missing-b").shards[0];
  assert.equal(partialShardB.childId, null, "缺作用域声明时不得用号域成员关系保留导航键");
  assert.equal(partialShardB.attempts[0].childId, "child-scope-b", "声明号与 attempt 1 精确相等：该行仍可导航");
  const fullB = await runtimeB.awaitFullBuild(rootB);
  const fullShardB = fullB.root.children.find((node) => node.parentTaskId === "task-cont-scope-missing-b").shards[0];
  assert.equal(fullShardB.childId, null, "精确比较与最新 attempt 不符：导航键必须清空");
  assert.equal(fullShardB.attempts[1].childId, null);
});

test("真实重试：同一轮次内两次不同 child 的 attempt 仍计为 1 次重试，导航取最新 child", async () => {
  const rootId = "root-retry";
  const task = roundTaskFixture({
    parentTaskId: "task-retry",
    // 真实 retryShard 不增 round：两个 attempt 都属于第 1 轮。
    round: 1,
    attempts: [
      { attempt: 1, status: "failed", childId: "child-retry-a", startedAt: 31, finishedAt: 32 },
      { attempt: 2, status: "succeeded", childId: "child-retry-b", startedAt: 33, finishedAt: 34 },
    ],
  });
  const runtime = runtimeWithColdChildren({
    rootId,
    childModels: {
      "child-retry-a": {
        parentId: rootId,
        role: "librarian",
        fanout: true,
        fanoutParentTaskId: "task-retry",
        fanoutShardId: "s1",
        fanoutAttempt: 1,
        createdAt: 30,
      },
      "child-retry-b": {
        parentId: rootId,
        role: "librarian",
        fanout: true,
        fanoutParentTaskId: "task-retry",
        fanoutShardId: "s1",
        fanoutAttempt: 2,
        createdAt: 30,
      },
    },
    tasks: [task],
    readSession: ownedSessionReader(rootId),
  });

  // awaitFullBuild 只观察已存在的缓存条目：先发一次请求建立条目（首屏是轻量快照）。
  const partial = await runtime.snapshotForSession(rootId);
  assert.equal(partial.partial, true, "首屏是轻量快照");
  const partialShard = partial.root.children.find((node) => node.parentTaskId === "task-retry").shards[0];
  assert.equal(partialShard.childId, "child-retry-b", "partial 阶段同样取最新 attempt 的 child");
  assert.equal(partialShard.retryCount, 1, "partial 阶段的重试口径与 full 一致");

  const full = await runtime.awaitFullBuild(rootId);
  const fullTask = full.root.children.find((node) => node.parentTaskId === "task-retry");
  const fullShard = fullTask.shards[0];
  assert.equal(fullShard.childId, "child-retry-b", "导航目标是同轮次内最新 attempt 的 child");
  assert.equal(fullShard.attempts[1].childId, "child-retry-b");
  assert.equal(fullShard.retryCount, 1, "同一轮次内的第二个 attempt 是真实重试");
  assert.equal(fullTask.retryCount, 1, "父任务重试数 = 各分片真实重试数之和");
});
