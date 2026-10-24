/**
 * Host Expert Group JSON 投影契约（TDD 纵切）行为回归。
 *
 * 覆盖公开 seam buildExpertGroupSnapshot({ sessionId, root, experts, fanoutTasks, generatedAt })：
 * 投影只在 Host 侧做一次性归一，客户端只消费 schemaVersion:1 的 JSON，绝不重算
 * fan-out 状态、不猜测缺失内容。测试使用真实模块 + 普通对象输入，不读取生产源码文本，
 * 不使用源码切片或 new Function。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExpertGroupSnapshot,
  FAILURE_CODE_MAX_LENGTH,
  FAILURE_MESSAGE_MAX_LENGTH,
  FAILURE_MESSAGE_SCAN_MAX_LENGTH,
  FAILURE_REDACTED_MESSAGE,
  FAILURE_SAFE_MESSAGES,
  FAILURE_STABLE_CODES,
} from "../host/expert-group-snapshot.js";

test("基础投影：schemaVersion/sessionId/rootSessionId/generatedAt 与 root 节点形状", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    root: {
      id: "root-1",
      taskName: "根任务",
      content: "把任务拆给专家",
      contentSource: "user_request",
      role: "orchestrator",
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: "max",
      status: "running",
      createdAt: 10,
    },
    experts: [],
    fanoutTasks: [],
    generatedAt: 1000,
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.sessionId, "root-1");
  assert.equal(snapshot.rootSessionId, "root-1");
  assert.equal(snapshot.generatedAt, 1000);
  // 票据 12：schemaVersion 不抬版本，revision 是内容摘要（字符串）。
  assert.equal(typeof snapshot.revision, "string");
  assert.ok(snapshot.revision.length > 0);
  assert.deepEqual(snapshot.root, {
    id: "root-1",
    kind: "root",
    sessionId: "root-1",
    taskName: "根任务",
    content: "把任务拆给专家",
    contentSource: "user_request",
    role: "orchestrator",
    // 票据 27：角色显示名（未知/未提供为 null，绝不猜）。
    roleLabel: null,
    provider: "deepseek",
    model: "deepseek-chat",
    effort: "max",
    status: "running",
    running: true,
    runSummary: null,
    continuable: null,
    capabilities: {
      read: { allowed: true },
      cancel: { allowed: false, reason: "not_supported" },
      retry: { allowed: false, reason: "not_supported" },
      continue: { allowed: false, reason: "not_supported" },
    },
    createdAt: 10,
    // 票据 12：会话节点（root/普通专家）的共享时间线字段。DSH 只有创建时间，
    // 因此 startedAt/lastActivityAt = createdAt，完成时间与耗时保持 null。
    startedAt: 10,
    lastActivityAt: 10,
    finishedAt: null,
    durationMs: null,
    children: [],
  });
});

test("非法 sessionId 抛 TypeError（不出现降级快照）", () => {
  for (const sessionId of [undefined, null, "", "   ", 123, {}]) {
    assert.throws(() => buildExpertGroupSnapshot({ sessionId }), TypeError);
  }
  assert.throws(() => buildExpertGroupSnapshot(), TypeError);
});

test("root 声明的 sessionId 与请求 sessionId 不匹配抛 TypeError", () => {
  assert.throws(
    () => buildExpertGroupSnapshot({ sessionId: "root-1", root: { sessionId: "root-2" } }),
    TypeError,
  );
  assert.throws(
    () => buildExpertGroupSnapshot({ sessionId: "root-1", root: { id: "root-2" } }),
    TypeError,
  );
});

test("缺失输入降级：root 缺省时用 sessionId 占位，其余字段归一为 null/unknown", () => {
  const snapshot = buildExpertGroupSnapshot({ sessionId: "root-1" });

  assert.equal(snapshot.rootSessionId, "root-1");
  assert.equal(snapshot.generatedAt, null);
  assert.deepEqual(snapshot.root, {
    id: "root-1",
    kind: "root",
    sessionId: "root-1",
    taskName: null,
    content: null,
    contentSource: null,
    role: null,
    roleLabel: null,
    provider: null,
    model: null,
    effort: null,
    status: "unknown",
    running: null,
    runSummary: null,
    continuable: null,
    capabilities: {
      read: { allowed: true },
      cancel: { allowed: false, reason: "not_supported" },
      retry: { allowed: false, reason: "not_supported" },
      continue: { allowed: false, reason: "not_supported" },
    },
    createdAt: null,
    startedAt: null,
    lastActivityAt: null,
    finishedAt: null,
    durationMs: null,
    children: [],
  });
});

test("普通专家子节点：字段归一、缺失为 null、未知内容不猜测", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    root: { id: "root-1" },
    experts: [
      {
        sessionId: "child-1",
        taskName: "侦察",
        prompt: "看看 fanout.js 的 shard 状态机",
        contentSource: "prompt",
        role: "explorer",
        provider: "deepseek",
        model: "deepseek-chat",
        reasoningEffort: "high",
        status: "IDLE",
        running: false,
        createdAt: 20,
      },
      { id: "child-2", status: "paused" },
      {},
    ],
  });

  assert.deepEqual(snapshot.root.children, [
    {
      id: "child-1",
      kind: "expert",
      sessionId: "child-1",
      taskName: "侦察",
      content: "看看 fanout.js 的 shard 状态机",
      contentSource: "prompt",
      role: "explorer",
      roleLabel: null,
      provider: "deepseek",
      model: "deepseek-chat",
      effort: "high",
      status: "idle",
      running: false,
      runSummary: null,
      continuable: null,
      capabilities: {
        read: { allowed: true },
        cancel: { allowed: false, reason: "not_supported" },
        retry: { allowed: false, reason: "not_supported" },
        continue: { allowed: false, reason: "not_supported" },
      },
      createdAt: 20,
      // 票据 12：专家会话节点的时间线字段。
      startedAt: 20,
      lastActivityAt: 20,
      finishedAt: null,
      durationMs: null,
      children: [],
    },
    {
      id: "child-2",
      kind: "expert",
      sessionId: "child-2",
      taskName: null,
      content: null,
      contentSource: null,
      role: null,
      roleLabel: null,
      provider: null,
      model: null,
      effort: null,
      status: "unknown",
      running: null,
      runSummary: null,
      continuable: null,
      capabilities: {
        read: { allowed: true },
        cancel: { allowed: false, reason: "not_supported" },
        retry: { allowed: false, reason: "not_supported" },
        continue: { allowed: false, reason: "not_supported" },
      },
      createdAt: null,
      startedAt: null,
      lastActivityAt: null,
      finishedAt: null,
      durationMs: null,
      children: [],
    },
    {
      id: null,
      kind: "expert",
      sessionId: null,
      taskName: null,
      content: null,
      contentSource: null,
      role: null,
      roleLabel: null,
      provider: null,
      model: null,
      effort: null,
      status: "unknown",
      running: null,
      runSummary: null,
      continuable: null,
      capabilities: {
        read: { allowed: true },
        cancel: { allowed: false, reason: "not_supported" },
        retry: { allowed: false, reason: "not_supported" },
        continue: { allowed: false, reason: "not_supported" },
      },
      createdAt: null,
      startedAt: null,
      lastActivityAt: null,
      finishedAt: null,
      durationMs: null,
      children: [],
    },
  ]);
});

test("状态词表：拼写别名归一，词表外的值一律 unknown", () => {
  const cases = [
    ["queued", "queued"],
    ["waiting", "waiting"],
    ["Running", "running"],
    ["SUCCEEDED", "succeeded"],
    ["canceled", "cancelled"],
    ["timed-out", "timed_out"],
    ["interrupted", "interrupted"],
    ["ready", "ready"],
    ["pending", "queued"],
    ["completed", "succeeded"],
    ["paused", "unknown"],
    ["blocked", "unknown"],
    ["", "unknown"],
    [undefined, "unknown"],
    [42, "unknown"],
  ];
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    experts: cases.map(([status], index) => ({ sessionId: "child-" + index, status })),
  });

  assert.deepEqual(
    snapshot.root.children.map((child) => child.status),
    cases.map(([, expected]) => expected),
  );
});

test("running：显式布尔优先，其次由已知状态推导，未知状态保持 null", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    experts: [
      { sessionId: "a", status: "idle", running: true },
      { sessionId: "b", status: "running" },
      { sessionId: "c", status: "succeeded" },
      { sessionId: "d", status: "mystery" },
      { sessionId: "e" },
    ],
  });

  assert.deepEqual(
    snapshot.root.children.map((child) => child.running),
    [true, true, false, null, null],
  );
});

test("experts/fanoutTasks 不是数组时降级为空集合，不抛错", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    experts: "child-1",
    fanoutTasks: { parentTaskId: "fanout-1" },
  });

  assert.deepEqual(snapshot.root.children, []);
});

test("fan-out 节点：parentTaskId/basePrompt/counts/有序 shards 与最新 attempt 语义", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    root: { id: "root-1" },
    fanoutTasks: [
      {
        parentTaskId: "fanout-1",
        basePrompt: "把三个候选方案都实现一遍",
        role: "fixer",
        status: "completed",
        createdAt: 30,
        counts: {
          queued: 0,
          running: 0,
          succeeded: 2,
          failed: 0,
          cancelled: 0,
          timed_out: 0,
          interrupted: 0,
          pending: 0,
        },
        shards: [
          {
            shardId: "shard-b",
            // 主代理给出的分片任务名称：投影的 taskName 优先取它，而不是分片代号。
            name: "实现候选方案 B",
            prompt: "方案 B",
            status: "succeeded",
            createdAt: 32,
            attempts: [
              { attempt: 1, status: "failed", childId: "child-b1", startedAt: 32, finishedAt: 33 },
              { attempt: 2, status: "succeeded", childId: "child-b2", startedAt: 34, finishedAt: 35 },
            ],
          },
          {
            shardId: "shard-a",
            prompt: "方案 A",
            status: "succeeded",
            createdAt: 31,
            attempts: [
              { attempt: 1, status: "succeeded", childId: "child-a1", startedAt: 31, finishedAt: 32 },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(snapshot.root.children, [
    {
      id: "fanout-1",
      kind: "fanout",
      parentTaskId: "fanout-1",
      basePrompt: "把三个候选方案都实现一遍",
      role: "fixer",
      // 票据 27：父任务/分片/attempt 都投影 roleLabel（未提供为 null）。
      roleLabel: null,
      status: "succeeded",
      taskStatus: "completed",
      running: false,
      createdAt: 30,
      // 票据 12：父任务时间线。manager 没给 updatedAt/settledAt 时完成时间未知（null），
      // attemptCount/retryCount 由所有 shard 的 attempts 汇总（2+1 次尝试、1 次重试）。
      startedAt: 30,
      finishedAt: null,
      durationMs: null,
      lastActivityAt: null,
      attemptCount: 3,
      retryCount: 1,
      failure: null,
      counts: {
        queued: 0,
        running: 0,
        succeeded: 2,
        failed: 0,
        cancelled: 0,
        timed_out: 0,
        interrupted: 0,
        pending: 0,
      },
      shards: [
        {
          shardId: "shard-b",
          taskName: "实现候选方案 B",
          prompt: "方案 B",
          role: "fixer",
          roleLabel: null,
          provider: null,
          model: null,
          effort: null,
          status: "succeeded",
          running: false,
          runSummary: null,
          continuable: null,
          childId: "child-b2",
          createdAt: 32,
          // 首个 attempt 的 startedAt 是分片起点；终态分片的终点 = 最后一个 attempt 的 finishedAt。
          startedAt: 32,
          finishedAt: 35,
          durationMs: 3,
          lastActivityAt: null,
          attemptCount: 2,
          retryCount: 1,
          // 最新 attempt 没有 error：即使历史 attempt 失败过，分片级失败摘要也为 null。
          failure: null,
          attempts: [
            {
              attempt: 1, status: "failed", childId: "child-b1", startedAt: 32, finishedAt: 33, durationMs: 1, failure: null, roleLabel: null,
            },
            {
              attempt: 2, status: "succeeded", childId: "child-b2", startedAt: 34, finishedAt: 35, durationMs: 1, failure: null, roleLabel: null,
            },
          ],
        },
        {
          shardId: "shard-a",
          taskName: "shard-a",
          prompt: "方案 A",
          role: "fixer",
          roleLabel: null,
          provider: null,
          model: null,
          effort: null,
          status: "succeeded",
          running: false,
          runSummary: null,
          continuable: null,
          childId: "child-a1",
          createdAt: 31,
          startedAt: 31,
          finishedAt: 32,
          durationMs: 1,
          lastActivityAt: null,
          attemptCount: 1,
          retryCount: 0,
          failure: null,
          attempts: [
            {
              attempt: 1, status: "succeeded", childId: "child-a1", startedAt: 31, finishedAt: 32, durationMs: 1, failure: null, roleLabel: null,
            },
          ],
        },
      ],
    },
  ]);
  // shards/attempts 一律保持 manager 顺序，投影不按 id 或时间重排。
  assert.deepEqual(
    snapshot.root.children[0].shards.map((shard) => shard.shardId),
    ["shard-b", "shard-a"],
  );
  // 有任务名称的分片显示名称（shard-b），没有名称的旧数据回退分片代号（shard-a）。
  assert.deepEqual(
    snapshot.root.children[0].shards.map((shard) => shard.taskName),
    ["实现候选方案 B", "shard-a"],
  );
});

test("fan-out 分片继承父任务的角色与最新 child 模型元数据", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "fanout-meta",
      role: "fixer",
      provider: "a6",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      status: "completed",
      shards: [{
        shardId: "shard-meta",
        prompt: "实现元数据投影",
        status: "succeeded",
        attempts: [{ attempt: 1, childId: "child-meta", status: "succeeded" }],
      }],
    }],
  });

  const shard = snapshot.root.children[0].shards[0];
  assert.equal(shard.role, "fixer");
  assert.equal(shard.provider, "a6");
  assert.equal(shard.model, "gpt-5.6-sol");
  assert.equal(shard.effort, "xhigh");
});

test("fan-out manager 的明确 task/shard status 优先，缺失的 counts 不重算", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [
      {
        parentTaskId: "fanout-1",
        status: "completed_with_errors",
        shards: [{ shardId: "s1", status: "running", attempts: [{ attempt: 1, status: "queued" }] }],
      },
    ],
  });

  const [node] = snapshot.root.children;
  assert.equal(node.taskStatus, "completed_with_errors");
  assert.equal(node.status, "failed");
  assert.equal(node.running, false);
  assert.equal(node.createdAt, null);
  assert.equal(node.counts, null);
  assert.equal(node.shards[0].status, "running");
  assert.equal(node.shards[0].running, true);
  assert.equal(node.shards[0].childId, null);
  assert.equal(node.shards[0].createdAt, null);
  assert.equal(node.shards[0].taskName, "s1");
  assert.equal(node.shards[0].prompt, null);
  assert.equal(node.shards[0].role, null);
  assert.equal(node.shards[0].provider, null);
  assert.equal(node.shards[0].model, null);
  assert.equal(node.shards[0].effort, null);
});

test("fan-out task 状态映射与部分/非法输入降级", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [
      { parentTaskId: "t-pending", status: "pending" },
      { parentTaskId: "t-completed", status: "completed" },
      { parentTaskId: "t-cancel", status: "cancelled" },
      { parentTaskId: "t-unknown", status: "mystery" },
      {},
      "not-a-task",
    ],
  });

  const byId = new Map(snapshot.root.children.map((node) => [node.id, node]));
  assert.equal(byId.get("t-pending").status, "running");
  assert.equal(byId.get("t-completed").status, "succeeded");
  assert.equal(byId.get("t-cancel").status, "cancelled");
  assert.equal(byId.get("t-unknown").status, "unknown");
  assert.equal(byId.get("t-unknown").taskStatus, "mystery");
  // 缺 parentTaskId / 非对象输入：仍然产出节点，但身份与内容保持 null。
  assert.equal(byId.get(null).parentTaskId, null);
  assert.deepEqual(byId.get(null).shards, []);
  assert.deepEqual(byId.get(null).counts, null);

  const partial = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [
      {
        parentTaskId: "t-partial",
        counts: { succeeded: 1 },
        shards: [{ shardId: "s1" }, { shardId: "s2", attempts: "broken" }],
      },
    ],
  }).root.children[0];
  assert.deepEqual(partial.counts, {
    queued: null,
    running: null,
    succeeded: 1,
    failed: null,
    cancelled: null,
    timed_out: null,
    interrupted: null,
    pending: null,
  });
  assert.equal(partial.status, "unknown");
  assert.equal(partial.shards[0].status, "unknown");
  assert.equal(partial.shards[0].childId, null);
  assert.equal(partial.shards[0].running, null);
  assert.deepEqual(partial.shards[0].attempts, []);
  assert.deepEqual(partial.shards[1].attempts, []);
  assert.equal(partial.shards[1].shardId, "s2");
});

test("去重：出现在任意 fan-out attempt.childId 中的专家不再作为普通 expert 输出", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    experts: [
      { sessionId: "child-keep", taskName: "普通专家" },
      { sessionId: "child-latest", taskName: "最新分片专家" },
      { id: "child-history", taskName: "历史 attempt 专家" },
    ],
    fanoutTasks: [
      {
        parentTaskId: "fanout-1",
        shards: [
          {
            shardId: "s1",
            attempts: [
              { attempt: 1, status: "failed", childId: "child-history" },
              { attempt: 2, status: "succeeded", childId: "child-latest" },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    snapshot.root.children.filter((node) => node.kind === "expert").map((node) => node.id),
    ["child-keep"],
  );
  // 被去重的子代理仍以 attempt.childId 的形式保留导航能力。
  const fanout = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.deepEqual(
    fanout.shards[0].attempts.map((attempt) => attempt.childId),
    ["child-history", "child-latest"],
  );
});

test("排序：普通专家与 fan-out 混合按 createdAt 升序，缺失时间排在有序项之后并保持输入顺序", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    experts: [
      { sessionId: "e-late", createdAt: 30 },
      { sessionId: "e-untimed-1" },
      { sessionId: "e-early", createdAt: 10 },
      { sessionId: "e-untimed-2" },
    ],
    fanoutTasks: [
      { parentTaskId: "f-25", createdAt: 25 },
      { parentTaskId: "f-untimed" },
    ],
  });

  assert.deepEqual(
    snapshot.root.children.map((node) => node.id),
    ["e-early", "f-25", "e-late", "e-untimed-1", "e-untimed-2", "f-untimed"],
  );
});

test("输入不可变：深度冻结的输入仍能投影，输出不与输入共享引用且可 JSON 往返", () => {
  const root = Object.freeze({ id: "root-1", createdAt: 5 });
  const experts = Object.freeze([
    Object.freeze({ sessionId: "e-2", createdAt: 20 }),
    Object.freeze({ sessionId: "e-1", createdAt: 10 }),
  ]);
  const attempts = Object.freeze([
    Object.freeze({ attempt: 1, status: "succeeded", childId: "child-9" }),
  ]);
  const shards = Object.freeze([Object.freeze({ shardId: "s1", attempts })]);
  const fanoutTasks = Object.freeze([
    Object.freeze({ parentTaskId: "f-1", createdAt: 15, shards }),
  ]);
  const before = JSON.stringify({ root, experts, fanoutTasks });

  const snapshot = buildExpertGroupSnapshot({ sessionId: "root-1", root, experts, fanoutTasks });
  const again = buildExpertGroupSnapshot({ sessionId: "root-1", root, experts, fanoutTasks });

  assert.equal(JSON.stringify({ root, experts, fanoutTasks }), before);
  assert.deepEqual(again, snapshot);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(snapshot))), JSON.stringify(snapshot));

  assert.deepEqual(snapshot.root.children.map((node) => node.id), ["e-1", "f-1", "e-2"]);
  assert.notEqual(snapshot.root.children, experts);
  const fanout = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.notEqual(fanout.shards, shards);
  assert.notEqual(fanout.shards[0].attempts, attempts);
});

test("partial 标记：只有显式 true 才是轻量快照", () => {
  const base = { sessionId: "root-1", root: { id: "root-1" } };
  assert.equal(buildExpertGroupSnapshot(base).partial, false, "未声明时按完整权威快照处理（旧调用方行为不变）");
  assert.equal(buildExpertGroupSnapshot({ ...base, partial: false }).partial, false);
  assert.equal(buildExpertGroupSnapshot({ ...base, partial: true }).partial, true);
  // 非布尔输入不猜真值：只有恰好 true 才算轻量快照。
  assert.equal(buildExpertGroupSnapshot({ ...base, partial: "true" }).partial, false);
  assert.equal(buildExpertGroupSnapshot({ ...base, partial: 1 }).partial, false);
});

test("白名单出口：未知附加字段不进投影", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    root: { id: "root-1", inject() {}, session: { token: "x" } },
    experts: [{ sessionId: "e-1", status: "running", agent: { internal: true } }],
    fanoutTasks: [
      { parentTaskId: "f-1", status: "pending", shards: [{ shardId: "s1", attempts: [{ attempt: 1, status: "queued", result: "巨大负载" }] }] },
    ],
  });

  assert.deepEqual(Object.keys(snapshot).sort(), [
    "generatedAt",
    // partial 是本次新增的**快照级**标记：true = 轻量快照（跳过全部冷读），false = 完整权威快照。
    // 它仍然走白名单出口，未声明的附加字段照旧不进投影。
    "partial",
    // 票据 12：revision 是「除 generatedAt/revision 之外全部内容」的摘要（字符串）。
    "revision",
    "root",
    "rootSessionId",
    "schemaVersion",
    "sessionId",
  ]);
  assert.deepEqual(Object.keys(snapshot.root).sort(), [
    // 票据 09：会话节点（root/普通专家）也投影能力对象（read allowed、写动作 not_supported）。
    "capabilities",
    "children",
    "content",
    "contentSource",
    "continuable",
    "createdAt",
    // 票据 12：会话节点时间线（root 与 expert 共用同一套投影）。
    "durationMs",
    "effort",
    "finishedAt",
    "id",
    "kind",
    "lastActivityAt",
    "model",
    "provider",
    "role",
    // 票据 27：角色显示名是声明过的投影字段。
    "roleLabel",
    "runSummary",
    "running",
    "sessionId",
    "startedAt",
    "status",
    "taskName",
  ]);
  const expert = snapshot.root.children.find((node) => node.kind === "expert");
  assert.deepEqual(Object.keys(expert).sort(), [
    "capabilities",
    "children",
    "content",
    "contentSource",
    "continuable",
    "createdAt",
    "durationMs",
    "effort",
    "finishedAt",
    "id",
    "kind",
    "lastActivityAt",
    "model",
    "provider",
    "role",
    // 票据 27：角色显示名是声明过的投影字段。
    "roleLabel",
    "runSummary",
    "running",
    "sessionId",
    "startedAt",
    "status",
    "taskName",
  ]);
  const fanout = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.deepEqual(Object.keys(fanout).sort(), [
    // 票据 12：父任务时间线与尝试/重试计数、受限失败摘要。
    "attemptCount",
    "basePrompt",
    "counts",
    "createdAt",
    "durationMs",
    "failure",
    "finishedAt",
    "id",
    "kind",
    "lastActivityAt",
    "parentTaskId",
    "retryCount",
    "role",
    "roleLabel",
    "running",
    "shards",
    "startedAt",
    "status",
    "taskStatus",
  ]);
  assert.deepEqual(Object.keys(fanout.shards[0]).sort(), [
    "attemptCount",
    "attempts",
    "childId",
    "continuable",
    "createdAt",
    "durationMs",
    "effort",
    "failure",
    "finishedAt",
    "lastActivityAt",
    "model",
    "prompt",
    "provider",
    "retryCount",
    "role",
    "roleLabel",
    "runSummary",
    "running",
    "shardId",
    "startedAt",
    "status",
    "taskName",
  ]);
  assert.deepEqual(Object.keys(fanout.shards[0].attempts[0]).sort(), [
    "attempt",
    "childId",
    // 票据 12：单次尝试的耗时与受限失败摘要；原有五字段保持不变。
    "durationMs",
    "failure",
    "finishedAt",
    "roleLabel",
    "startedAt",
    "status",
  ]);
});


// ── 逐动作能力投影（票据 09） ───────────────────────────────────────────────

test("逐动作能力：fan-out 任务与 shard 按动作词表白名单投影，未知动作被丢弃", () => {
  const capabilities = {
    read: { allowed: true },
    cancel: { allowed: true },
    retry: { allowed: false, reason: "task_not_terminal" },
    continue: { allowed: false, reason: "task_not_terminal" },
    // 未声明的动作/字段一律不得穿透到客户端。
    launch: { allowed: true },
    extra: "secret",
  };
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    root: { id: "root-1" },
    fanoutTasks: [{
      parentTaskId: "fanout-caps",
      status: "pending",
      capabilities,
      shards: [{
        shardId: "s1",
        status: "running",
        attempts: [{ attempt: 1, status: "running" }],
        capabilities: {
          cancel: { allowed: true },
          retry: { allowed: false, reason: "task_not_terminal" },
          // shard 词表只有 cancel/retry：continue 即使给了也不得出现。
          continue: { allowed: true },
          allowed: "yes",
        },
      }],
    }],
  });

  const node = snapshot.root.children[0];
  assert.deepEqual(node.capabilities, {
    read: { allowed: true },
    cancel: { allowed: true },
    retry: { allowed: false, reason: "task_not_terminal" },
    continue: { allowed: false, reason: "task_not_terminal" },
  });
  assert.deepEqual(node.shards[0].capabilities, {
    cancel: { allowed: true },
    retry: { allowed: false, reason: "task_not_terminal" },
  });
  // 会话节点（root/普通专家）同样有固定能力：read allowed、写动作 not_supported。
  assert.deepEqual(snapshot.root.capabilities, {
    read: { allowed: true },
    cancel: { allowed: false, reason: "not_supported" },
    retry: { allowed: false, reason: "not_supported" },
    continue: { allowed: false, reason: "not_supported" },
  });
});

test("逐动作能力：非法形状收敛、超长原因码截断，缺失时省略字段而不伪造授权", () => {
  const longReason = "x".repeat(200);
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [
      {
        parentTaskId: "fanout-bad-caps",
        capabilities: {
          // 非布尔 allowed 不是有效能力项。
          read: { allowed: "true" },
          cancel: { allowed: false, reason: longReason },
          retry: null,
          continue: { reason: "missing-allowed" },
        },
        shards: [{ shardId: "s1", attempts: [{ attempt: 1, status: "failed" }], capabilities: {} }],
      },
      { parentTaskId: "fanout-no-caps" },
    ],
  });

  const bad = snapshot.root.children.find((node) => node.parentTaskId === "fanout-bad-caps");
  assert.deepEqual(bad.capabilities, {
    cancel: { allowed: false, reason: "x".repeat(64) },
  });
  const none = snapshot.root.children.find((node) => node.parentTaskId === "fanout-no-caps");
  assert.equal(Object.prototype.hasOwnProperty.call(none, "capabilities"), false,
    "没有能力来源时必须省略字段，客户端才能回退旧行为");
  assert.equal(Object.prototype.hasOwnProperty.call(bad.shards[0], "capabilities"), false,
    "shard 能力块没有任何有效项时同样省略");
});

// ── recovery 块（票据 04） ───────────────────────────────────────────────────

test("recovery 块：failed/ok/none 三态、字段白名单与 fail-closed 标记", () => {
  const base = { sessionId: "root-1", root: { id: "root-1" } };
  const failed = buildExpertGroupSnapshot({
    ...base,
    recovery: {
      status: "failed",
      code: "INVALID_SNAPSHOT",
      message: "快照 shard 结构非法",
      at: 1700000000000,
      retryable: false,
      persistenceBlocked: true,
      // 额外字段（快照正文/堆栈/路径）一律不得进入投影。
      snapshot: { tasks: ["secret"] },
      stack: "Error at C:\\secret\\path.js",
      path: "C:\\secret",
    },
  });
  assert.deepEqual(failed.recovery, {
    status: "failed",
    code: "INVALID_SNAPSHOT",
    message: "快照 shard 结构非法",
    at: 1700000000000,
    retryable: false,
    persistenceBlocked: true,
  });
  assert.deepEqual(Object.keys(failed.recovery).sort(), [
    "at",
    "code",
    "message",
    "persistenceBlocked",
    "retryable",
    "status",
  ]);

  const ok = buildExpertGroupSnapshot({
    ...base,
    recovery: { status: "ok", code: "STALE_CODE", message: "旧错误", at: 12, retryable: true, persistenceBlocked: false },
  });
  // 恢复成功必须清除 code/message/retryable：失败细节不得残留。
  assert.deepEqual(ok.recovery, {
    status: "ok",
    code: null,
    message: null,
    at: 12,
    retryable: false,
    persistenceBlocked: false,
  });

  const none = buildExpertGroupSnapshot({ ...base, recovery: { status: "none" } });
  assert.deepEqual(none.recovery, {
    status: "none",
    code: null,
    message: null,
    at: null,
    retryable: false,
    persistenceBlocked: false,
  });

  // 词表外的 status 不猜测：落回 none（不伪造失败，也不保留失败细节）。
  const unknown = buildExpertGroupSnapshot({
    ...base,
    recovery: { status: "exploded", code: "INVALID_SNAPSHOT", message: "x" },
  });
  assert.equal(unknown.recovery.status, "none");
  assert.equal(unknown.recovery.code, null);
  assert.equal(unknown.recovery.message, null);
});

test("recovery 块：原因码只接受固定集合，message 只保留白名单文案", () => {
  const base = { sessionId: "root-1", root: { id: "root-1" } };
  const longMessage = "错误详情".repeat(100);
  const snapshot = buildExpertGroupSnapshot({
    ...base,
    recovery: {
      status: "failed",
      // 自由文本/堆栈路径形态的原因码一律退化为稳定兜底码。
      code: "Error: boom\n    at C:\\secret\\snapshot.json",
      message: "第一行\u0000第二行\t第三行\n" + longMessage,
      at: Number.NaN,
      retryable: "true",
    },
  });
  assert.equal(snapshot.recovery.code, "RESTORE_FAILED");
  assert.ok(snapshot.recovery.message.length <= 200, "message 必须有长度上限");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(snapshot.recovery.message), false, "message 不得含控制字符");
  // 第十一轮：白名单外的自由文本（即使换行/制表折叠后看起来正常）整条回退。
  assert.equal(snapshot.recovery.message, FAILURE_REDACTED_MESSAGE, "白名单外文案整条回退");
  assert.equal(snapshot.recovery.at, null, "非有限时间戳归一为 null");
  assert.equal(snapshot.recovery.retryable, false, "retryable 只认明确 true");

  // 合法稳定码原样保留（大小写与下划线是契约的一部分）。
  const stable = buildExpertGroupSnapshot({
    ...base,
    recovery: { status: "failed", code: "BUDGET_EXCEEDED", message: "", retryable: true },
  });
  assert.equal(stable.recovery.code, "BUDGET_EXCEEDED");
  assert.equal(stable.recovery.message, null, "空 message 归一为 null");
  assert.equal(stable.recovery.retryable, true);
});

test("recovery 缺省：旧调用方不产生该块（客户端按缺失回退为无恢复错误）", () => {
  const snapshot = buildExpertGroupSnapshot({ sessionId: "root-1", root: { id: "root-1" } });
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "recovery"), false);
  // 非对象输入同样不产生块：绝不用「畸形负载」伪造一个失败态。
  const malformed = buildExpertGroupSnapshot({ sessionId: "root-1", root: { id: "root-1" }, recovery: "failed" });
  assert.equal(Object.prototype.hasOwnProperty.call(malformed, "recovery"), false);
});

// ── 任务时间线与受限失败摘要（票据 12） ─────────────────────────────────────

test("任务时间线：duration/attemptCount/retryCount 按 attempts 计算，非终态不伪造完成时间", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [
      {
        parentTaskId: "task-running",
        status: "pending",
        createdAt: 100,
        updatedAt: 900,
        // 异常输入：非终态任务即使带了 settledAt，也不得投影成完成时间。
        settledAt: 1200,
        shards: [{
          shardId: "s1",
          status: "running",
          createdAt: 101,
          updatedAt: 800,
          attempts: [
            { attempt: 1, status: "failed", childId: "child-1", startedAt: 101, finishedAt: 200 },
            { attempt: 2, status: "running", childId: "child-2", startedAt: 300, finishedAt: null },
          ],
        }],
      },
      {
        parentTaskId: "task-done",
        status: "completed",
        createdAt: 1000,
        updatedAt: 1500,
        settledAt: 1500,
        shards: [
          {
            shardId: "s1",
            status: "succeeded",
            createdAt: 1000,
            updatedAt: 1200,
            attempts: [{ attempt: 1, status: "succeeded", startedAt: 1000, finishedAt: 1200 }],
          },
          {
            shardId: "s2",
            status: "succeeded",
            createdAt: 1000,
            updatedAt: 1500,
            attempts: [
              { attempt: 1, status: "failed", startedAt: 1000, finishedAt: 1300 },
              { attempt: 2, status: "succeeded", startedAt: 1400, finishedAt: 1500 },
            ],
          },
        ],
      },
    ],
  });

  const running = snapshot.root.children.find((node) => node.parentTaskId === "task-running");
  assert.equal(running.startedAt, 100);
  assert.equal(running.finishedAt, null, "未终态的任务没有完成时间");
  assert.equal(running.durationMs, null, "耗时未知时不写 0");
  assert.equal(running.lastActivityAt, 900);
  assert.equal(running.attemptCount, 2);
  assert.equal(running.retryCount, 1);
  assert.equal(running.failure, null, "运行中的分片不算失败");
  const runningShard = running.shards[0];
  assert.equal(runningShard.startedAt, 101);
  assert.equal(runningShard.finishedAt, null, "仍在运行的分片不得用历史 attempt 的完成时间当终点");
  assert.equal(runningShard.durationMs, null);
  assert.equal(runningShard.lastActivityAt, 800);
  assert.equal(runningShard.attemptCount, 2);
  assert.equal(runningShard.retryCount, 1);
  assert.equal(runningShard.attempts[0].durationMs, 99);
  assert.equal(runningShard.attempts[1].durationMs, null, "未完成的 attempt 没有耗时");

  const done = snapshot.root.children.find((node) => node.parentTaskId === "task-done");
  assert.equal(done.finishedAt, 1500);
  assert.equal(done.durationMs, 500);
  assert.equal(done.lastActivityAt, 1500);
  assert.equal(done.attemptCount, 3);
  // retryCount = sum(max(0, attempts.length - 1)) = 0 + 1。
  assert.equal(done.retryCount, 1);
  assert.equal(done.shards[0].finishedAt, 1200);
  assert.equal(done.shards[0].durationMs, 200);
  // 分片起点取第一个真正开始的 attempt（而不是最新 attempt 的 startedAt）。
  assert.equal(done.shards[1].startedAt, 1000);
  assert.equal(done.shards[1].finishedAt, 1500);
  assert.equal(done.shards[1].durationMs, 500);
  assert.equal(done.shards[1].retryCount, 1);
});

test("retryCount 只统计真实重试：continuation 轮次不计入，轮次多于 attempt 时钳到 0", () => {
  // 同一份 attempts 形状，只有 task.round 不同：
  // - round=2 表示第 2 个逻辑轮次（continuation 每轮给每个分片追加一个 attempt），不是重试；
  // - round=1 表示两个 attempt 都在同一轮（真实 retryShard 追加 attempt、不增 round）→ 1 次重试；
  // - round=3 大于 attempts 数（部分输入/旧数据）：基线被钳到 attempts 总数，重试数钳到 0，不出现负数。
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-round",
    fanoutTasks: [
      {
        parentTaskId: "task-cont",
        status: "completed",
        round: 2,
        createdAt: 10,
        updatedAt: 50,
        settledAt: 50,
        shards: [{
          shardId: "s1",
          status: "succeeded",
          createdAt: 11,
          attempts: [
            { attempt: 1, status: "succeeded", startedAt: 11, finishedAt: 12 },
            { attempt: 2, status: "succeeded", startedAt: 13, finishedAt: 14 },
          ],
        }],
      },
      {
        parentTaskId: "task-retry",
        status: "completed",
        round: 1,
        createdAt: 10,
        updatedAt: 50,
        settledAt: 50,
        shards: [{
          shardId: "s1",
          status: "succeeded",
          createdAt: 11,
          attempts: [
            { attempt: 1, status: "failed", startedAt: 11, finishedAt: 12 },
            { attempt: 2, status: "succeeded", startedAt: 13, finishedAt: 14 },
          ],
        }],
      },
      {
        parentTaskId: "task-round-ahead",
        status: "completed",
        round: 3,
        createdAt: 10,
        updatedAt: 50,
        settledAt: 50,
        shards: [{
          shardId: "s1",
          status: "succeeded",
          createdAt: 11,
          attempts: [
            { attempt: 1, status: "succeeded", startedAt: 11, finishedAt: 12 },
            { attempt: 2, status: "succeeded", startedAt: 13, finishedAt: 14 },
          ],
        }],
      },
    ],
  });
  const byId = (id) => snapshot.root.children.find((node) => node.parentTaskId === id);

  const cont = byId("task-cont");
  assert.equal(cont.attemptCount, 2, "attemptCount 仍是总尝试数");
  assert.equal(cont.shards[0].attemptCount, 2);
  assert.equal(cont.shards[0].retryCount, 0, "两个 attempt 分属两个轮次：没有真实重试");
  assert.equal(cont.retryCount, 0, "父任务重试数 = 各分片真实重试数之和");

  const retry = byId("task-retry");
  assert.equal(retry.shards[0].retryCount, 1, "同一轮次内的第二个 attempt 是真实重试");
  assert.equal(retry.retryCount, 1);

  const ahead = byId("task-round-ahead");
  assert.equal(ahead.shards[0].retryCount, 0, "轮次多于 attempt 时钳到 0，绝不出现负数");
  assert.equal(ahead.retryCount, 0);
});

test("恢复钳位后的混合形状：round=2 + 3 个 attempt → retryCount=1，非整数 round 不得产生半次重试", () => {
  // 锁定的缺陷场景（oracle 复审）：损坏/裁剪快照写下 round=3、分片只有 2 条 attempt；
  // 恢复入口把它钳回 2（fanout/restore.js），随后一次真实 retryShard 追加第 3 条 attempt。
  // 这一「round=2 + 3 attempts」的混合形状正是钳位后的真实产物——若投影端仍按虚高 round
  // 记账，第 3 条 attempt 会被当成 continuation 复用而被静默漏计（retryCount=0）。
  //
  // 附带锁定 round 的类型门槛：numberOrNull 只校验有限性，round=1.5 会让基线变成 1.5，
  // retryCount 出现 0.5 这种无法解释的「半次重试」；只接受安全整数 >=1 后按第 1 轮处理。
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-round-clamp",
    fanoutTasks: [
      {
        parentTaskId: "task-clamped-retry",
        status: "completed",
        round: 2,
        createdAt: 10,
        updatedAt: 60,
        settledAt: 60,
        shards: [{
          shardId: "s1",
          status: "succeeded",
          createdAt: 11,
          attempts: [
            { attempt: 1, status: "succeeded", startedAt: 11, finishedAt: 12 },
            { attempt: 2, status: "succeeded", startedAt: 13, finishedAt: 14 },
            { attempt: 3, status: "running", startedAt: 15 },
          ],
        }],
      },
      {
        parentTaskId: "task-fractional-round",
        status: "completed",
        // 非安全整数：投影必须回退第 1 轮，基线取 attempts.length（2），重试数 = 1。
        round: 1.5,
        createdAt: 10,
        updatedAt: 60,
        settledAt: 60,
        shards: [{
          shardId: "s1",
          status: "succeeded",
          createdAt: 11,
          attempts: [
            { attempt: 1, status: "failed", startedAt: 11, finishedAt: 12 },
            { attempt: 2, status: "succeeded", startedAt: 13, finishedAt: 14 },
          ],
        }],
      },
    ],
  });
  const byId = (id) => snapshot.root.children.find((node) => node.parentTaskId === id);

  const clamped = byId("task-clamped-retry");
  assert.equal(clamped.attemptCount, 3, "attemptCount 仍是总尝试数");
  assert.equal(clamped.shards[0].attemptCount, 3);
  assert.equal(clamped.shards[0].retryCount, 1, "钳位后的第 3 条 attempt 是真实重试，必须计为 1");
  assert.equal(clamped.retryCount, 1);

  const fractional = byId("task-fractional-round");
  assert.equal(fractional.shards[0].retryCount, 1, "非整数 round 回退第 1 轮：不得出现 0.5 次重试");
  assert.equal(fractional.retryCount, 1);
});

test("受限失败摘要：丢弃堆栈/结果/prompt，白名单外自由文本整条回退", () => {
  const longMessage = "错".repeat(500);
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "task-fail",
      status: "completed_with_errors",
      createdAt: 10,
      updatedAt: 90,
      settledAt: 90,
      shards: [
        {
          shardId: "s1",
          status: "failed",
          createdAt: 10,
          updatedAt: 30,
          attempts: [{
            attempt: 1,
            status: "failed",
            childId: "child-1",
            startedAt: 10,
            finishedAt: 30,
            // 结构化错误里带 stack / prompt / result：一律不得进入投影。
            // 完整多行文本整体匹配白名单：第二行是普通中文也会让整条文本不命中 ⇒ 回退。
            error: {
              code: "EACCES",
              name: "PermissionError",
              message: "rate limit exceeded\n重复任务已忽略",
              stack: "SECRET STACK",
              result: "SECRET RESULT",
              prompt: "SECRET PROMPT",
            },
          }],
        },
        {
          shardId: "s2",
          status: "failed",
          createdAt: 10,
          updatedAt: 40,
          attempts: [{
            attempt: 1,
            status: "failed",
            startedAt: 20,
            finishedAt: 40,
            // 没有 code：回退 name；自由文本（含超长）整条回退通用文案。
            error: { name: "DivisionByZero", message: longMessage },
          }],
        },
        {
          shardId: "s3",
          status: "timed_out",
          createdAt: 10,
          updatedAt: 50,
          attempts: [{
            attempt: 1,
            status: "timed_out",
            startedAt: 40,
            finishedAt: 50,
            // 没有 message：只保留 code。
            error: { code: "ETIMEDOUT" },
          }],
        },
        {
          shardId: "s4",
          status: "failed",
          createdAt: 10,
          updatedAt: 60,
          attempts: [{
            attempt: 1,
            status: "failed",
            startedAt: 50,
            finishedAt: 60,
            // 字符串错误：归一为 code=error；含路径/URL 的文案整条回退通用文案。
            error: "open 'C:\\Program Files\\app.exe' failed /home/alice/app.js, see https://example.com/a/b",
          }],
        },
      ],
    }],
  });

  const task = snapshot.root.children[0];
  const [first, second, third, fourth] = task.shards;

  // 父任务失败摘要 = 首个失败 shard 的摘要。
  assert.deepEqual(task.failure, { code: "EACCES", message: FAILURE_REDACTED_MESSAGE });
  assert.deepEqual(first.failure, { code: "EACCES", message: FAILURE_REDACTED_MESSAGE });
  assert.equal(second.failure.code, "DivisionByZero", "没有 code 时回退 name");
  assert.equal(second.failure.message, FAILURE_REDACTED_MESSAGE, "白名单外自由文本（含超长）整条回退");
  assert.deepEqual(third.failure, { code: "ETIMEDOUT", message: null }, "没有 message 时只保留 code");

  // 字符串错误：code 退化为稳定值 error；含路径/URL 的文案整条回退通用文案。
  assert.equal(fourth.failure.code, "error");
  assert.equal(fourth.failure.message, FAILURE_REDACTED_MESSAGE);

  // 堆栈、prompt、完整 result 与原始路径都不得出现在投影里的任何位置。
  const serialized = JSON.stringify(snapshot);
  for (const secret of [
    "SECRET STACK", "SECRET RESULT", "SECRET PROMPT",
    "重复任务已忽略", "secret.js", "alice", "Program Files",
  ]) {
    assert.equal(serialized.includes(secret), false, "投影不得包含 " + secret);
  }
  // 摘要只有两个字段。
  assert.deepEqual(Object.keys(first.failure).sort(), ["code", "message"]);
});

test("受限失败摘要：多行文本只有整体命中白名单才保留（换行分段 token 不泄漏）", () => {
  const segmentA = "AAECAwQFBgcICQoL";
  const segmentB = "A0ODxAREhMUFRYX";
  const messages = [
    // 各种换行形态分隔的 Base64：完整文本扫描 + 跨行合并后整条回退。
    segmentA + "\n" + segmentB,
    segmentA + "\r\n" + segmentB,
    segmentA + "\r" + segmentB,
    segmentA + "\u2028" + segmentB,
    segmentA + "\u2029" + segmentB,
    // 多行文本整条折叠后不是任何白名单文案（即使首行是安全文案）⇒ 整条回退。
    "rate limit exceeded\nretry later",
    // 后续行含凭据/URL/hex：整条回退。
    "rate limit exceeded\nBearer abc",
    "rate limit exceeded\nhttps://host/x",
    "rate limit exceeded\nabcdef1234567890",
    // 超长多行（> 扫描上限）：回退，不因截断把尾部凭据切成安全残段。
    "rate limit exceeded\n" + "错".repeat(FAILURE_MESSAGE_SCAN_MAX_LENGTH),
  ];
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "task-multiline",
      status: "completed_with_errors",
      shards: messages.map((message, index) => ({
        shardId: "ml-" + index,
        status: "failed",
        attempts: [{ attempt: 1, status: "failed", startedAt: 1, finishedAt: 2, error: { code: "E" + index, message } }],
      })),
    }],
  });
  const text = (index) => snapshot.root.children[0].shards[index].failure.message;

  for (let index = 0; index < messages.length; index += 1) {
    assert.equal(text(index), FAILURE_REDACTED_MESSAGE, "第 " + index + " 条必须回退通用文案");
  }
  // 任何多行文本（含首行是安全文案）都不保留；只有整体命中白名单才保留（见新增用例）。

  // 序列化后不得出现首段 Base64、第二行内容或被后续行污染的片段。
  const serialized = JSON.stringify(snapshot);
  for (const secret of [segmentA, segmentB, "Bearer abc", "abcdef1234567890", "retry later"]) {
    assert.equal(serialized.includes(secret), false, "快照不得包含多行片段 " + secret);
  }
});

test("受限失败摘要：零宽/格式字符不可用于拆分 token（整条回退）", () => {
  // 这些字符不属于 \s、也不是 Cc 控制字符：必须显式拒绝，不能「折叠后继续」。
  const invisibleSeparators = ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u00AD", "\uFE0F"];
  const segmentA = "AAECAwQFBgcICQoL";
  const segmentB = "A0ODxAREhMUFRYX";
  const hexHead = "abcdef1234567890";
  const hexTail = "1234567890";
  const messages = [];
  for (const separator of invisibleSeparators) {
    messages.push(segmentA + separator + segmentB);
    messages.push("failed " + hexHead + separator + hexTail);
  }
  const safeStart = messages.length;
  const safeMessages = ["rate limit exceeded", "model not found", "模型不存在", "请求超时"];
  messages.push(...safeMessages);

  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "task-invisible",
      status: "completed_with_errors",
      shards: messages.map((message, index) => ({
        shardId: "invisible-" + index,
        status: "failed",
        attempts: [{ attempt: 1, status: "failed", startedAt: 1, finishedAt: 2, error: { code: "E" + index, message } }],
      })),
    }],
  });
  const text = (index) => snapshot.root.children[0].shards[index].failure.message;

  // 任意不可见分隔符拆分的 Base64 / hex 都整条回退。
  for (let index = 0; index < safeStart; index += 1) {
    assert.equal(text(index), FAILURE_REDACTED_MESSAGE, "第 " + index + " 条必须回退通用文案");
  }
  // 安全文案不受影响。
  for (let index = 0; index < safeMessages.length; index += 1) {
    assert.equal(text(safeStart + index), safeMessages[index]);
  }
  // 序列化后不得包含任何一侧片段。
  const serialized = JSON.stringify(snapshot);
  for (const secret of [segmentA, segmentB, hexHead, hexTail]) {
    assert.equal(serialized.includes(secret), false, "快照不得包含不可见分隔片段 " + JSON.stringify(secret));
  }

  // recovery.message 同形态：任一分隔符都整条回退；安全文案保留。
  const recoverySnapshots = invisibleSeparators.map((separator) => buildExpertGroupSnapshot({
    sessionId: "root-1",
    recovery: { status: "failed", code: "RESTORE_FAILED", message: segmentA + separator + segmentB },
  }));
  for (const recovery of recoverySnapshots) {
    assert.equal(recovery.recovery.message, FAILURE_REDACTED_MESSAGE);
  }
  const serializedRecovery = JSON.stringify(recoverySnapshots);
  for (const secret of [segmentA, segmentB]) {
    assert.equal(serializedRecovery.includes(secret), false, "recovery 快照不得包含不可见分隔片段");
  }
  const safeRecovery = buildExpertGroupSnapshot({
    sessionId: "root-1",
    recovery: { status: "failed", code: "RESTORE_FAILED", message: "快照 shard 结构非法" },
  });
  assert.equal(safeRecovery.recovery.message, "快照 shard 结构非法");

  // failure.code / recovery.code 同样拒绝不可见字符（显式断言）。
  const codeSnapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "task-invisible-code",
      status: "completed_with_errors",
      shards: ["\u200BEACCES", "EACCES\u200B", "EAC\u200BCES"].map((code, index) => ({
        shardId: "invisible-code-" + index,
        status: "failed",
        attempts: [{ attempt: 1, status: "failed", error: { code, message: "failed" } }],
      })),
    }],
  });
  assert.deepEqual(
    codeSnapshot.root.children[0].shards.map((entry) => entry.failure.code),
    ["error", "error", "error"],
  );
  const recoveryCode = buildExpertGroupSnapshot({
    sessionId: "root-1",
    recovery: { status: "failed", code: "INVALID\u200BSNAPSHOT", message: "restore failed" },
  });
  assert.equal(recoveryCode.recovery.code, "RESTORE_FAILED");
});

test("受限失败摘要：Unicode 排版标点同样是分隔符，不能拆分 Base64/hex", () => {
  // 弯撇号/弯引号/书名号/破折号/间隔号/顿号：此前不在 ASCII 标点清单里，曾被用来拆分 token。
  const separators = ["\u2019", "\u201C", "\u300A", "\u2014", "\u00B7", "\u3001"];
  const segmentA = "AAECAwQFBgcICQoL";
  const segmentB = "A0ODxAREhMUFRYX";
  const hexHead = "abcdef1234567890";
  const hexTail = "1234567890";
  const messages = [];
  for (const separator of separators) {
    messages.push(segmentA + separator + segmentB);
    // 典型绕过写法：Unicode 标点 + 空格（例如 U+2019 + space）。
    messages.push(segmentA + separator + " " + segmentB);
    messages.push("failed " + hexHead + separator + hexTail);
  }
  const safeStart = messages.length;
  const safeMessages = ["rate limit exceeded", "model not found", "模型不存在", "请求超时"];
  messages.push(...safeMessages);

  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-1",
    fanoutTasks: [{
      parentTaskId: "task-unicode-separator",
      status: "completed_with_errors",
      shards: messages.map((message, index) => ({
        shardId: "unicode-" + index,
        status: "failed",
        attempts: [{ attempt: 1, status: "failed", startedAt: 1, finishedAt: 2, error: { code: "E" + index, message } }],
      })),
    }],
  });
  const text = (index) => snapshot.root.children[0].shards[index].failure.message;

  for (let index = 0; index < safeStart; index += 1) {
    assert.equal(text(index), FAILURE_REDACTED_MESSAGE, "第 " + index + " 条必须回退通用文案");
  }
  for (let index = 0; index < safeMessages.length; index += 1) {
    assert.equal(text(safeStart + index), safeMessages[index]);
  }

  // 序列化后不得出现任何一侧片段。
  const serialized = JSON.stringify(snapshot);
  for (const secret of [segmentA, segmentB, hexHead, hexTail]) {
    assert.equal(serialized.includes(secret), false, "快照不得包含 Unicode 分隔片段 " + JSON.stringify(secret));
  }

  // recovery.message 同形态。
  const recoverySnapshots = separators.map((separator) => buildExpertGroupSnapshot({
    sessionId: "root-1",
    recovery: { status: "failed", code: "RESTORE_FAILED", message: segmentA + separator + segmentB },
  }));
  for (const recovery of recoverySnapshots) {
    assert.equal(recovery.recovery.message, FAILURE_REDACTED_MESSAGE);
  }
  const serializedRecovery = JSON.stringify(recoverySnapshots);
  for (const secret of [segmentA, segmentB]) {
    assert.equal(serializedRecovery.includes(secret), false, "recovery 快照不得包含 Unicode 分隔片段");
  }
  const safeRecovery = buildExpertGroupSnapshot({
    sessionId: "root-1",
    recovery: { status: "failed", code: "RESTORE_FAILED", message: "快照 shard 结构非法" },
  });
  assert.equal(safeRecovery.recovery.message, "快照 shard 结构非法");

  // failure.code / recovery.code：Unicode 标点拆分的稳定码同样被拒绝。
  for (const separator of separators) {
    const codeSnapshot = buildExpertGroupSnapshot({
      sessionId: "root-1",
      fanoutTasks: [{
        parentTaskId: "task-unicode-code",
        status: "completed_with_errors",
        shards: [{
          shardId: "unicode-code",
          status: "failed",
          attempts: [{ attempt: 1, status: "failed", error: { code: "INVALID" + separator + "SNAPSHOT", message: "failed" } }],
        }],
      }],
    });
    assert.equal(codeSnapshot.root.children[0].shards[0].failure.code, "error");
    const recoveryCode = buildExpertGroupSnapshot({
      sessionId: "root-1",
      recovery: { status: "failed", code: "INVALID" + separator + "SNAPSHOT", message: "restore failed" },
    });
    assert.equal(recoveryCode.recovery.code, "RESTORE_FAILED");
  }
});

test("结构化交付（票据 30）：expert/attempt/shard/task 只读投影 structured，缺失省略且不合并 value", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-structured",
    root: { id: "root-structured", status: "running", createdAt: 1 },
    experts: [{
      id: "child-structured",
      status: "idle",
      role: "fixer",
      createdAt: 2,
      structured: { value: { summary: "expert" }, bytes: 22, receivedAt: 5 },
      outputSchemaRequested: true,
    }],
    fanoutTasks: [{
      parentTaskId: "task-structured",
      role: "fixer",
      status: "completed",
      createdAt: 3,
      shards: [{
        shardId: "s1",
        status: "succeeded",
        attempts: [{
          attempt: 1,
          status: "succeeded",
          childId: "child-structured-fanout",
          structured: { value: { summary: "attempt" }, bytes: 23, receivedAt: 6 },
          outputSchemaRequested: true,
        }],
      }],
    }],
    generatedAt: 1000,
  });
  const expert = snapshot.root.children.find((node) => node.kind === "expert");
  assert.deepEqual(expert.structured.value, { summary: "expert" });
  assert.equal(expert.outputSchemaRequested, true);
  const fanout = snapshot.root.children.find((node) => node.kind === "fanout");
  assert.deepEqual(fanout.shards[0].attempts[0].structured.value, { summary: "attempt" });
  assert.equal(fanout.shards[0].attempts[0].outputSchemaRequested, true);
  assert.deepEqual(fanout.shards[0].structured.value, { summary: "attempt" });
  assert.deepEqual(fanout.structured, [{
    shardId: "s1",
    attempt: 1,
    childId: "child-structured-fanout",
    // 投影按 value 的 UTF-8 字节数重算，不信任输入里的 bytes 自报值。
    structured: { value: { summary: "attempt" }, bytes: 21, receivedAt: 6 },
  }]);
  assert.equal(fanout.outputSchemaRequested, true);
  const plain = buildExpertGroupSnapshot({
    sessionId: "root-plain",
    root: { id: "root-plain", status: "idle" },
    experts: [{ id: "child-plain", status: "idle" }],
    fanoutTasks: [],
    generatedAt: 1001,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(plain.root.children[0], "structured"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(plain.root.children[0], "outputSchemaRequested"), false);
});

test("受限失败摘要：16 位纯字母 Base64 不得原样透传（message 整条回退，code 回退稳定兜底）", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-b64",
    fanoutTasks: [{
      parentTaskId: "task-b64",
      status: "failed",
      shards: [{
        shardId: "s1",
        status: "failed",
        attempts: [{
          attempt: 1,
          status: "failed",
          error: { code: "AbcdefGhijklmnop", message: "AbcdefGhijklmnop" },
        }],
      }],
    }],
  });
  const failure = snapshot.root.children[0].shards[0].attempts[0].failure;
  assert.deepEqual(failure, { code: "error", message: FAILURE_REDACTED_MESSAGE });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("AbcdefGhijklmnop"), false, "编码载荷不得出现在快照任何位置");
});

test("受限失败摘要：URL/复合键/编码变体/凭据前缀/长 token/路径等可疑形态整条回退，安全文案保留", () => {
  const unsafe = [
    "GET https://example.com/path?token=abcdef",
    "Authorization: Bearer abcdef123456",
    "api_key=sk-live-abcdef",
    "C:\\Users\\tong_li\\secret\\file.txt",
    "/home/user/private/.env",
    "a".repeat(FAILURE_MESSAGE_MAX_LENGTH + 40),
    "BASE64 YXBPPWFL ZGFJZWFH",
  ];
  for (const message of unsafe) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-unsafe",
      experts: [{ id: "e1", status: "failed", lastError: { code: "SECRET_TOKEN", message } }],
    });
    // expert 节点没有 failure 字段；用 fanout attempt 走同一 projectFailure 出口。
    const fanout = buildExpertGroupSnapshot({
      sessionId: "root-unsafe",
      fanoutTasks: [{
        parentTaskId: "task-unsafe",
        status: "failed",
        shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code: "SECRET_TOKEN", message } }] }],
      }],
    });
    const failure = fanout.root.children[0].shards[0].attempts[0].failure;
    assert.deepEqual(failure, { code: "error", message: FAILURE_REDACTED_MESSAGE }, message);
    assert.equal(JSON.stringify(snapshot).includes(message), false);
  }

  const safe = buildExpertGroupSnapshot({
    sessionId: "root-safe",
    fanoutTasks: [{
      parentTaskId: "task-safe",
      status: "failed",
      shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code: "EACCES", message: "Rate limit exceeded." } }] }],
    }],
  });
  assert.deepEqual(safe.root.children[0].shards[0].attempts[0].failure, {
    code: "EACCES",
    message: "rate limit exceeded",
  });
});

test("recovery 消息复用失败摘要白名单：凭据/URL/键值/长 token 整条回退，安全文案保留", () => {
  for (const message of [
    "Authorization: Bearer abcdef",
    "https://example.com/?token=abcdef",
    "token=abcdef",
    "x".repeat(FAILURE_MESSAGE_SCAN_MAX_LENGTH + 1),
    "BASE64 YXBPPWFL ZGFJZWFH",
  ]) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-recovery",
      recovery: { status: "failed", code: "RESTORE_FAILED", message, retryable: true },
    });
    assert.deepEqual(snapshot.recovery, {
      status: "failed",
      code: "RESTORE_FAILED",
      message: FAILURE_REDACTED_MESSAGE,
      at: null,
      retryable: true,
      persistenceBlocked: false,
    });
  }
  const safe = buildExpertGroupSnapshot({
    sessionId: "root-recovery",
    recovery: { status: "failed", code: "EIO", message: "Restore failed。", at: 10, retryable: false },
  });
  assert.equal(safe.recovery.message, "restore failed");
  assert.equal(safe.recovery.code, "EIO");
});

test("活动 attempt/分片的时间边界：running/queued/waiting 误带完成时间也投影 null", () => {
  for (const status of ["running", "queued", "waiting"]) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-active",
      fanoutTasks: [{
        parentTaskId: "task-active",
        status: "running",
        createdAt: 100,
        shards: [{
          shardId: "s1",
          status,
          createdAt: 100,
          finishedAt: 900,
          attempts: [{ attempt: 1, status, childId: "c1", startedAt: 200, finishedAt: 900 }],
        }],
      }],
    });
    const shard = snapshot.root.children[0].shards[0];
    assert.equal(shard.finishedAt, null, status + " 分片不得有完成时间");
    assert.equal(shard.durationMs, null);
    assert.equal(shard.attempts[0].finishedAt, null, status + " attempt 不得有完成时间");
    assert.equal(shard.attempts[0].durationMs, null);
  }
});

test("时间线字段向后兼容：旧输入缺 updatedAt/startedAt/attempts 时给出 null/0", () => {
  const snapshot = buildExpertGroupSnapshot({
    sessionId: "root-legacy",
    fanoutTasks: [{
      parentTaskId: "task-legacy",
      status: "completed",
      shards: [{ shardId: "s1", status: "succeeded" }],
    }],
  });
  const task = snapshot.root.children[0];
  assert.equal(task.startedAt, null);
  assert.equal(task.finishedAt, null, "completed 但没有任何已结算时间：不得伪造完成时间");
  assert.equal(task.durationMs, null);
  assert.equal(task.lastActivityAt, null);
  assert.equal(task.attemptCount, 0);
  assert.equal(task.retryCount, 0);
  const shard = task.shards[0];
  assert.equal(shard.startedAt, null);
  assert.equal(shard.finishedAt, null);
  assert.equal(shard.durationMs, null);
  assert.equal(shard.attemptCount, 0);
  assert.equal(shard.retryCount, 0);
});

test("revision：只由内容决定（忽略 generatedAt），内容变化即变化，schemaVersion 仍为 1", () => {
  const base = {
    sessionId: "root-revision",
    root: { id: "root-revision", status: "idle", taskName: "任务" },
    experts: [{ id: "e1", role: "fixer", status: "idle" }],
    fanoutTasks: [],
  };
  const first = buildExpertGroupSnapshot({ ...base, generatedAt: 1 });
  const second = buildExpertGroupSnapshot({ ...base, generatedAt: 999 });
  assert.equal(first.revision, second.revision, "generatedAt 不得影响 revision");
  const changed = buildExpertGroupSnapshot({ ...base, root: { ...base.root, taskName: "任务已变" }, generatedAt: 1 });
  assert.notEqual(changed.revision, first.revision, "内容变化必须改变 revision");
  assert.equal(first.schemaVersion, 1);
  assert.equal(changed.schemaVersion, 1);
});

test("受限失败摘要（第十一轮）：固定安全消息白名单 + 固定稳定错误码集合，编码语义载荷一律回退", () => {
  const cases = [
    ["rate limit exceeded.", "rate limit exceeded"],
    ["  RATE   LIMIT EXCEEDED  ", "rate limit exceeded"],
    ["模型不存在。", "模型不存在"],
    ["请求超时", "请求超时"],
    ["快照 shard 结构非法", "快照 shard 结构非法"],
    ["rate limit exceeded / model not found", FAILURE_REDACTED_MESSAGE],
    ["shard failed\nBASE64 YXBPPWFL ZGFJZWFH", FAILURE_REDACTED_MESSAGE],
    ["第一行安全\n第二行载荷", FAILURE_REDACTED_MESSAGE],
  ];
  for (const [message, expected] of cases) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-safe-list",
      fanoutTasks: [{
        parentTaskId: "task-safe-list",
        status: "failed",
        shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code: "EIO", message } }] }],
      }],
    });
    assert.equal(snapshot.root.children[0].shards[0].attempts[0].failure.message, expected, JSON.stringify(message));
  }
  // 稳定码集合完整性：白名单内的码逐字保留，集合外的一律回退。
  assert.ok(FAILURE_STABLE_CODES.includes("EACCES"));
  assert.ok(FAILURE_STABLE_CODES.includes("DivisionByZero"));
  assert.ok(FAILURE_SAFE_MESSAGES.includes("shard failed (retry 2)"));
});

test("受限失败摘要（第十二轮）：code 改为有限精确 allowlist，编码载荷与未登记机器码一律回退", () => {
  const rejected = [
    "AbcdefGhijklmno",
    "YXBPPWFL_ZGFJZWFHAA",
    "eacces",
    "Eacces",
    "RANDOM_UNREGISTERED_CODE",
    "A".repeat(FAILURE_CODE_MAX_LENGTH + 1),
    "Authorization: Bearer x",
  ];
  for (const code of rejected) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-code",
      fanoutTasks: [{
        parentTaskId: "task-code",
        status: "failed",
        shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code, message: "shard failed" } }] }],
      }],
    });
    assert.equal(snapshot.root.children[0].shards[0].attempts[0].failure.code, "error", code);
  }
  for (const code of ["EACCES", "ERROR", "Error", "TypeError", "BUDGET_EXCEEDED", "ERR_MODEL_NOT_FOUND", "FIRST_FAILURE"]) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-code",
      fanoutTasks: [{
        parentTaskId: "task-code",
        status: "failed",
        shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code, message: "shard failed" } }] }],
      }],
    });
    assert.equal(snapshot.root.children[0].shards[0].attempts[0].failure.code, code, code);
  }
  const recovery = buildExpertGroupSnapshot({
    sessionId: "root-code",
    recovery: { status: "failed", code: "AbcdefGhijklmno", message: "restore failed" },
  });
  assert.equal(recovery.recovery.code, "RESTORE_FAILED");
});

test("受限失败摘要：Unicode 字母/数字/emoji 不能拆分 Base64/hex（合并只保留 ASCII 字母数字）", () => {
  const secret = "AAECAwQFBgcICQoL";
  const separated = [
    secret.split("").join("中"),
    secret.split("").join("α"),
    secret.split("").join("Ж"),
    secret.slice(0, 6) + "🙂" + secret.slice(6),
    secret.split("").join("٣"),
  ];
  for (const payload of separated) {
    const snapshot = buildExpertGroupSnapshot({
      sessionId: "root-unicode",
      fanoutTasks: [{
        parentTaskId: "task-unicode",
        status: "failed",
        shards: [{ shardId: "s1", status: "failed", attempts: [{ attempt: 1, status: "failed", error: { code: "EACCES", message: "shard failed " + payload } }] }],
      }],
    });
    assert.equal(
      snapshot.root.children[0].shards[0].attempts[0].failure.message,
      FAILURE_REDACTED_MESSAGE,
      payload,
    );
  }
});
