/**
 * root turn 等待回归测试（用户确认的 A 方案）。
 *
 * 语义：子代理派发后 root **保持当前 turn 打开**直到精确关联的工作真正结束；
 * 不再暂停/恢复任何 durable goal，也不主动 concludeTurn。
 *
 * 测试 seam（用户确认）：从测试宿主调用**已注册的** `dsh_expert_group_finalize`，
 * 并通过宿主事件模拟精确完成通知（`agent/inbox/inserted`）、状态变化
 * （`agent/status` / `agent/created` / `agent/disposed`）以及 root dispose/unload。
 * 断言全部落在公开结果上：工具回执、Promise 是否 pending、goal 服务是否被调用。
 *
 * 覆盖矩阵（与任务书逐条对应）：
 * 1. 等待不超时且保持 Promise pending；
 * 2. exact notice 释放；重复 / 错误 / 他 root / 旧代际 notice 不释放；
 * 3. 无通知但 root-scoped 明确 idle / 无 descendants 能释放；
 * 4. 未知状态、查询失败不释放；
 * 5. 多 child / fanout 部分完成不提前释放；
 * 6. 状态为零与新 admission / child-created 竞态；
 * 7. root dispose、generation replacement、unload 清理；
 * 8. 所有场景不调用 goal pause / resume；
 * 9. ask_user_question / exit_plan_mode 的 pending user wait 仍工作且无 goal API；
 * 10. 后代 seam 的 known/unknown 判定：静止证明**只**来自权威 listing 的干净完整
 *     listing；waterfall（`workspace/session-activity`）无论返回 sentinel、全新空数组、
 *     非空但无 subagent 族还是 malformed，都必须继续等待——它是**非专属**扩展点，
 *     任意 listener 都能返回新的空数组，因此只能提供「确有 running 后代」的正向证据；
 * 10c. 权威 listing **行级公开契约**校验：child 行的必填字段（`id`、`mode`、
 *     `activity`、`hasChildren`、`parentId`、`depth`，continuable 行的 `label`）
 *     任一缺失或非法，整次 listing 都视为 unknown——尤其 `mode` 缺失 / 非枚举值时
 *     绝不能凭该行 `activity:"inactive"` 放行等待；
 * 11. 同一 root 的第二轮等待（第一批静止后再 continue_parent_turn）；
 * 12. 查询 rejection 必须消费 recheck（不吞复查意图、也不自旋）；
 * 13. retire 后记录对 exact Agent 的强引用被清空、在途快照不得把记录挂回。
 *
 * 第 10–13 条同时覆盖**权威 listing seam**（`subagents.listDescendants`）与
 * **waterfall 回退 seam**（`workspace/session-activity` + 无 provider sentinel）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginHost, createDeferred, flushAsyncWork, RPC_ENDPOINT } from "../test-support/plugin-host.mjs";
import { createRootTurnWaitRegistry } from "../host/turn-wait.js";

const ROOT_ID = "root-wait";

/**
 * 受控 GoalService 替身：**任何** pause/resume 调用都会被记录并在断言中失败。
 *
 * get 只返回 undefined（没有 durable goal），因此旧实现下也不会产生 pause；
 * 用例断言的重点是「改造后完全不读不写 goal」——连 get 都不应发生。
 */
function createGoalProbe() {
  const calls = [];
  return {
    calls,
    service: {
      get() { calls.push("get"); return undefined; },
      pause() { calls.push("pause"); throw new Error("goals.pause must never be called"); },
      resume() { calls.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  };
}

/**
 * 建立受控 Host：subagents.startContinuable 同步登记 child（含 subagent 血缘与
 * running 状态），使 harness 的两条 seam 都能读到同一份宿主事实：
 * - `subagents.listDescendants`（权威；默认启用，是**唯一**的静止证明来源）；
 * - `workspace/session-activity` waterfall（降级；只能提供正向的 running 证据）。
 *
 * @param {Function} [options.descendantRowTransform] 逐行改写权威 listing 的合法 child
 *   行；只用于**显式构造非法输入**（缺 `mode` / `mode` 非法 / 缺其他必填字段），
 *   验证插件按公开契约 fail-closed。默认不传，夹具保持与契约同形。
 */
function createWaitHost({
  goalProbe,
  sessionActivity = "subagent",
  descendantListing = "subagent",
  descendantRowTransform,
  sessionActivityTransport = true,
  withGoals = true,
} = {}) {
  const children = [];
  const host = createPluginHost({
    ...(withGoals ? { goals: goalProbe.service } : {}),
    sessionActivity,
    descendantListing,
    descendantRowTransform,
    sessionActivityTransport,
    settings: {
      value: { provider: "mock", defaults: { explorer: { provider: "mock", model: "mock" } } },
    },
    subagents: {
      async startContinuable({ request }) {
        const index = children.length + 1;
        const childId = "wait-child-" + index;
        const messageId = "wait-message-" + index;
        const created = host.registerRootAgent(childId, { lifecycle: false });
        created.session.header = { id: childId, parentSession: request.parent.id, origin: "subagent" };
        // 必须保留 request.agentOptions：fan-out 分片身份（FANOUT_* marker）由它在
        // 真实路径上写入，runtime 也据此认领分片；丢掉它会让 fan-out child 变成孤儿。
        created.options = {
          provider: "mock",
          model: "mock",
          __degExpertRole: "explorer",
          __degExpertParent: request.parent.id,
          __degExpertContinuable: true,
          ...(request.agentOptions ?? {}),
        };
        // child 默认在运行：等待判定必须看到它。
        created.status = "running";
        children.push({ child: created, childId, messageId });
        host.emit("agent/created", { agent: created });
        return { childId, messageId };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent(ROOT_ID);
  return { host, root, children };
}

/** 把 Promise 的最终状态投影成可断言的值（不 await，保持 pending 可见）。 */
function track(promise) {
  const state = { status: "pending", value: undefined };
  promise.then(
    (value) => { state.status = "resolved"; state.value = value; },
    (error) => { state.status = "rejected"; state.value = error; },
  );
  return state;
}

/**
 * 调用真实注册的 explorer 角色工具（完整 admission 路径）。
 *
 * affectedPaths 必须逐次不同：同 scope 的活动任务范围相交时 delegationTracker 会
 * 返回 scope-conflict advisory（那是既有的范围保护语义，不是本用例要覆盖的行为）。
 */
async function startAdmission(host, root, prompt = "wait probe task", affectedPaths = ["docs/wait.md"], extra = {}) {
  return host.toolDefinition("explorer").execute(
    { description: "wait task", prompt, affectedPaths, ...extra },
    { agent: root },
  );
}

/** 调用真实注册的 finalize 工具；execute 返回的 Promise 就是 root turn 的等待。 */
function finalize(host, root, outcomes, signal) {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  return host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: list[0].admissionEpoch,
    admissionTokens: list.map((outcome) => outcome.admissionToken),
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root, ...(signal === undefined ? {} : { signal }) });
}

/** 让某个 admission 的 child turn 正常结束（turn/end 边界）。 */
function endChildTurn(host, entry, turn = 1) {
  entry.child.session.events = [
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: entry.messageId, role: "user", content: [], source: { kind: "plugin:dsh-expert-group" } } },
    { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: "done" }] } } },
  ];
  host.emit("session/event", entry.child.session, { type: "turn/end", data: { turn, reason: { kind: "completed" } } });
}

/** 父 inbox 收到精确关联的 child settlement（exact 完成通知）。 */
function insertNotice(host, root, entry, messageId) {
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: {
      id: messageId,
      source: { kind: "subagent-settled", senderSessionId: entry.childId },
    },
  });
}

/** 每个用例结束时断言 goal 服务从未被触碰。 */
function assertNoGoalCalls(probe) {
  assert.deepEqual(probe.calls, [], "改造后不得调用任何 goal API（含只读 get）");
}

// ── 1. 等待不超时且保持 Promise pending ─────────────────────────────────────

test("等待保持 pending：child 仍在运行时 finalize 的 Promise 永不超时收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));

  // 推进大量宏任务/微任务轮次：等待不得因为任何计时/轮询而自行收口。
  await flushAsyncWork(40);
  assert.equal(pending.status, "pending", "child 仍在运行时等待必须保持 pending（无超时）");

  // 真实完成：turn 结束 + child 停止 + 精确通知。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "ready");
  insertNotice(host, root, children[0], "wait-feedback-1");
  await flushAsyncWork(12);

  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assert.equal(pending.value.reason, "finalized");
  assert.equal(pending.value.acceptedCount, 1);
  // 旧回执字段必须消失（改造后的输出契约）。
  assert.equal("paused" in pending.value, false, "回执不得再带 paused");
  assert.equal("concluded" in pending.value, false, "回执不得再带 concluded");
  assertNoGoalCalls(probe);
});

// ── 2. 精确通知：释放与不释放 ───────────────────────────────────────────────

test("exact notice 释放：turn/end + 精确关联 settlement 让等待收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  // child 明确停止运行（查询可见「无 running 后代」）。
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "wait-feedback-exact");
  await flushAsyncWork(12);

  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("重复 / 他 root / 旧代际 notice 不释放正在等待的 root", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const other = host.registerRootAgent("root-other");
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  // ① 他 root 的 notice：senderSessionId 属于别的 root 的 child 时不得命中本 root 的 admission。
  const stranger = host.registerRootAgent("wait-child-stranger", { lifecycle: false });
  stranger.session.header = { id: "wait-child-stranger", parentSession: other.id, origin: "subagent" };
  host.emit("agent/inbox/inserted", {
    agent: other,
    message: { id: "fb-other", source: { kind: "subagent-settled", senderSessionId: "wait-child-stranger" } },
  });
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "他 root 的 notice 不得释放本 root");

  // ② 错误 child 的 notice：senderSessionId 不属于本次 admission 的 child。
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: "fb-wrong", source: { kind: "subagent-settled", senderSessionId: "wait-child-nonexistent" } },
  });
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "错误 child 的 notice 不得释放");

  // ③ 旧代际 notice：turn 尚未结束的 admission 不会被任何 notice 消费。
  insertNotice(host, root, children[0], "fb-early");
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "turn 未结束时的 notice 不得释放");

  // ④ 真实边界到达后才释放；随后的重复 notice 是幂等空操作。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-real");
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  const settledValue = pending.value;

  insertNotice(host, root, children[0], "fb-real");
  await flushAsyncWork(8);
  assert.equal(pending.value, settledValue, "重复 notice 不得改变已收口的结论");
  assertNoGoalCalls(probe);
});

// ── 3. 无通知但 root-scoped 明确空闲 ────────────────────────────────────────

test("完成通知缺失时：root-scoped 明确无 running 后代即释放", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  endChildTurn(host, children[0]);
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍被报告为 running 时不得释放");

  // 没有任何 inbox settlement：只有「明确没有 running 后代」这一事实。
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("child dispose 后（从 live 注册表消失）也能在无通知时释放", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.disposeAgent(children[0].child);
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assertNoGoalCalls(probe);
});

// ── 4. 未知 / 查询失败一律不释放 ───────────────────────────────────────────

test("后代查询失败（provider 抛错且无权威 listing）时继续等待，绝不把未知当成无人运行", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "throw",
    descendantListing: "missing",
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  insertNotice(host, root, children[0], "fb-unknown");
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "查询失败必须 fail-closed：unknown 不放行");

  // 恢复查询能力后仍必须重新判定并正常释放（证明它只是等待，不是永久卡死）。
  host.emit("agent/status", { agent: children[0].child, status: "idle" });
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "harness 仍处于 throw 模式，继续等待");
  assertNoGoalCalls(probe);
});

test("后代 seam 缺失（无 listing、无 provider）时必须继续等待：无 provider ≠ 明确空", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "missing",
    descendantListing: "missing",
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  // 工作已经用 exact notice 精确结算、child 也明确不再运行；但**没有任何 seam 能证明**
  // 「没有 running 后代」——waterfall 链路没有 provider，最内层 sentinel 原样返回。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-missing-seam");
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending", "没有 provider 时必须继续等待，绝不能凭空数组放行");
  assertNoGoalCalls(probe);
});

test("权威 listing 明确返回空后代时才释放（provider 存在且明确回答）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, descendantListing: "subagent" });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  // 权威 seam 现在能明确回答「该 root 没有任何 running 后代」。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-empty");
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "确有 provider 且明确返回空列表时必须释放");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

// ── 10c. 权威 listing 行的公开契约校验（P2：mode 是必填判别字段） ──────────────

/**
 * 公开契约（`@deepseek-ai/dsh-subagent` 的 `SubagentCatalogRow` /
 * `SubagentListEntry` / `SubagentDescendantListEntry`）对 `kind:"child"` 行的
 * **必填**字段是：`id`、`mode`（`one-shot` | `continuable`）、`activity`
 * （`running` | `inactive`）、`hasChildren`、`parentId`、`depth`；
 * `mode:"continuable"` 的行另有必填的 `label`。
 *
 * 因此 `mode` 不是可选装饰：它是这条行的生命周期判别字段。真实
 * `listDescendants` 已经把 catalog 里 `mode:"unknown"` 的条目转成
 * `kind:"diagnostic"`，所以 child 行出现**缺失**或**非法** `mode` 只可能说明这份
 * listing 不是公开契约的形状（伪造 / 截断 / 跨版本错配）。这种情况下
 * `activity:"inactive"` **不能**当作静止证据——整次结果按 unknown 处理，等待继续。
 */
test("权威 listing 的合法 inactive child 行可证明静止（行形状符合公开 contract）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  // 夹具本身必须与公开契约同形：插件按契约 fail-closed 校验必填字段，缺字段的假数据
  // 会让等待永远收不口——那是夹具缺陷，不是插件行为。
  const rows = host.listHarnessDescendants(root.id);
  assert.equal(rows.length, 1, "权威 listing 必须报出该 root 的一个后代");
  assert.equal(rows[0].kind, "child");
  assert.equal(rows[0].mode, "continuable", "child 行必须带合法 mode");
  assert.equal(typeof rows[0].label, "string", "continuable 行的 label 是必填字段");
  assert.ok(rows[0].label.length > 0, "continuable 行的 label 不得为空");
  assert.equal(typeof rows[0].hasChildren, "boolean", "hasChildren 是必填字段");
  assert.equal(rows[0].parentId, root.id, "parentId 是必填字段");
  assert.equal(rows[0].depth, 1, "直接子代的 depth 必须是 1");
  assert.equal(rows[0].activity, "running");

  // child 真正结束：listing 给出一行**合法**的 inactive child——这是可证明的静止。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-legal-inactive");
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "合法 inactive child 行由权威 listing 证明静止，必须放行");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("权威 listing 的 inactive child 行缺少 mode 时不得当作静止（等待继续 pending）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    // 显式删掉 mode：行的其余字段（含 activity:"inactive"）都「看起来静止」，
    // 但缺了判别字段的 listing 不是公开契约的形状。
    descendantRowTransform: (row) => {
      const { mode, ...rest } = row;
      return rest;
    },
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-mode-missing");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "pending",
    "mode 缺失的 child 行不是合法契约行：整次 listing 视为 unknown，不得按 inactive child 放行",
  );
  assertNoGoalCalls(probe);
});

test("权威 listing 的 inactive child 行 mode 非法时不得当作静止（等待继续 pending）", async () => {
  // "unknown" 是真实 catalog 的第三个取值（listing 必须把它转成 diagnostic 行），
  // "paused" 是任意无关字符串，"" 是空值：三者都不是公开契约的 mode 枚举。
  for (const illegalMode of ["unknown", "paused", ""]) {
    const probe = createGoalProbe();
    const { host, root, children } = createWaitHost({
      goalProbe: probe,
      descendantRowTransform: (row) => ({ ...row, mode: illegalMode }),
    });
    const outcome = await startAdmission(host, root);
    const pending = track(finalize(host, root, outcome));
    await flushAsyncWork(8);

    endChildTurn(host, children[0]);
    host.setAgentStatus(children[0].child, "idle");
    insertNotice(host, root, children[0], "fb-mode-illegal");
    await flushAsyncWork(24);
    assert.equal(
      pending.status,
      "pending",
      "mode=" + JSON.stringify(illegalMode) + " 不是公开契约枚举：整次 listing 视为 unknown",
    );
    assertNoGoalCalls(probe);
  }
});

test("权威 listing 的 child 行缺少其他必填字段时同样不得当作静止", async () => {
  const mutations = [
    ["hasChildren", (row) => { const { hasChildren, ...rest } = row; return rest; }],
    ["parentId", (row) => { const { parentId, ...rest } = row; return rest; }],
    ["depth", (row) => { const { depth, ...rest } = row; return rest; }],
    // continuable 行的 label 是必填字段；one-shot 行的 label 才是可选的。
    ["label(continuable)", (row) => { const { label, ...rest } = row; return rest; }],
  ];
  for (const [field, transform] of mutations) {
    const probe = createGoalProbe();
    const { host, root, children } = createWaitHost({
      goalProbe: probe,
      descendantRowTransform: transform,
    });
    const outcome = await startAdmission(host, root);
    const pending = track(finalize(host, root, outcome));
    await flushAsyncWork(8);

    endChildTurn(host, children[0]);
    host.setAgentStatus(children[0].child, "idle");
    insertNotice(host, root, children[0], "fb-missing-" + field);
    await flushAsyncWork(24);
    assert.equal(
      pending.status,
      "pending",
      "缺少必填字段 " + field + " 的 child 行必须按 unknown 处理（fail-closed）",
    );
    assertNoGoalCalls(probe);
  }
});

test("只有 waterfall（无权威 listing）时：provider 原样透传不能证明静止", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "subagent",
    descendantListing: "missing",
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  // provider 装载着，但它在「没有 running 后代」时是 `return rest`（原样透传最内层
  // 返回值），因此 sentinel 会一路返回：既不能证明 provider 装载过，也不能证明它
  // 报告了空。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-passthrough");
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending", "透传形状必须按 unknown 处理（fail-closed）");
  assertNoGoalCalls(probe);
});

// ── 10b. waterfall 降级路径：任何空数组都不是静止证明（P1） ──────────────────

/**
 * `workspace/session-activity` 是**非专属**扩展点：任何 listener 都能返回一个全新的
 * 空数组（既不 spread 最内层 sentinel，也不检查 subagent 血缘）。它和「provider 明确
 * 报告没有 running 后代」在返回值上同形，但**不能**证明静止——sentinel 只能识别
 * 「链路没有贡献」，识别不了「贡献者是谁」。
 *
 * 因此本组用例把「fresh []」作为**公开边界**固定下来：等待必须保持 pending，
 * 只有权威 listing 的干净完整 listing 才能放行。
 */
function registerFreshEmptyActivityListener(host) {
  return host.context.on("workspace/session-activity", () => []);
}

test("waterfall-only：其他 listener 返回的全新空数组不能证明静止，等待保持 pending", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "subagent",
    descendantListing: "missing",
  });
  const stopListener = registerFreshEmptyActivityListener(host);
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  // 工作已用 exact notice 精确结算、child 也明确不再运行；唯一到达的「静止证据」是
  // 第三方 listener 的全新空数组——它不能证明静止，必须继续等待。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-fresh-empty");
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending", "fresh 空数组不是静止证明：必须继续等待");
  stopListener();
  assertNoGoalCalls(probe);
});

test("waterfall-only：确有 running subagent 后代时继续等待（只作正向证据）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "subagent",
    descendantListing: "missing",
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  // 正向事实：waterfall 明确报出 kind=subagent 的 running 后代。
  const activity = await host.waterfall("workspace/session-activity", { sessionId: root.id }, () => []);
  assert.equal(Array.isArray(activity), true, "waterfall 必须返回数组");
  assert.equal(activity.length, 1, "waterfall 必须报出 subagent 族");
  assert.equal(activity[0].kind, "subagent", "族必须标明 kind=subagent");
  assert.equal(activity[0].items.length, 1, "该族必须带一条 running 后代");
  assert.equal(pending.status, "pending", "确有 running 后代时必须继续等待");

  // 即便 exact notice 与 turn/end 都到达，waterfall 也无法证明静止：继续等待。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-activity-only");
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending", "waterfall-only 永远不能证明静止");
  assertNoGoalCalls(probe);
});

test("waterfall-only：malformed 形状（subagent 族 items 非数组）同样继续等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "subagent",
    descendantListing: "missing",
  });
  const stopListener = host.context.on("workspace/session-activity", () => [{ kind: "subagent", items: "not-an-array" }]);
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-malformed-family");
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending", "结构非法必须 fail-closed（unknown 不放行）");
  stopListener();
  assertNoGoalCalls(probe);
});

test("权威 listing 优先：waterfall 只给全新空数组时，listing 的明确空仍能释放", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, descendantListing: "subagent" });
  const stopListener = registerFreshEmptyActivityListener(host);
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-wins");
  await flushAsyncWork(24);
  assert.equal(pending.status, "resolved", "权威 listing 的干净完整 listing 是唯一静止证明");
  assert.equal(pending.value.kind, "finalized");
  stopListener();
  assertNoGoalCalls(probe);
});

test("listing 报出不可读分支（diagnostic）时继续等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, descendantListing: "diagnostic" });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-diagnostic");
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "有分支读不到时无法证明该分支静止");
  assertNoGoalCalls(probe);
});

test("listing 整条 reject 时继续等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, descendantListing: "throw" });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-throw");
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "listing 失败必须按 unknown 处理");
  assertNoGoalCalls(probe);
});

test("能力诊断：权威 listing 缺失即降级，事件服务也缺失才算 unavailable", async () => {
  const probe = createGoalProbe();
  // 只有 waterfall：不能只凭「ctx.waterfall 是函数」就报 available——那只能证明 Cordis
  // 事件服务在，不能证明有任何 provider 能给出可证明的静止结论。
  const degraded = createWaitHost({ goalProbe: probe, descendantListing: "missing" });
  const degradedMeta = await degraded.host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(degradedMeta.value.capabilities.host.rootTurnWait.status, "degraded");
  assert.equal(
    degradedMeta.value.capabilities.host.rootTurnWait.degradation,
    "root-turn-wait-descendant-listing-unavailable",
  );

  // 连 Cordis 事件服务都没有：unavailable。
  const unavailable = createWaitHost({
    goalProbe: probe,
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
  });
  const unavailableMeta = await unavailable.host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(unavailableMeta.value.capabilities.host.rootTurnWait.status, "unavailable");
  assert.equal(
    unavailableMeta.value.capabilities.host.rootTurnWait.degradation,
    "root-turn-wait-descendant-query-unavailable",
  );

  // 默认 harness：权威 listing 存在 → available。
  const available = createWaitHost({ goalProbe: probe });
  const availableMeta = await available.host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(availableMeta.value.capabilities.host.rootTurnWait.status, "available");
  assert.equal(availableMeta.value.capabilities.host.rootTurnWait.degradation, null);
  assertNoGoalCalls(probe);
});

// ── 5. 多 child / 部分完成不提前释放 ────────────────────────────────────────

test("多 child 部分完成不提前释放：最后一个 admission 结束才收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const first = await startAdmission(host, root, "wait probe task one", ["docs/wait-one.md"]);
  const second = await startAdmission(host, root, "wait probe task two", ["docs/wait-two.md"]);
  assert.equal(first.kind, "continuable");
  assert.equal(second.kind, "continuable");
  assert.equal(children.length, 2, "两次不同任务必须各自新建 child");

  const pending = track(finalize(host, root, [first, second]));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  // 只有第一个 child 完成：等待必须继续。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-multi-1");
  await flushAsyncWork(16);
  assert.equal(pending.status, "pending", "还有 running 后代时不得提前释放");

  endChildTurn(host, children[1]);
  host.setAgentStatus(children[1].child, "idle");
  insertNotice(host, root, children[1], "fb-multi-2");
  await flushAsyncWork(16);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.acceptedCount, 2);
  assertNoGoalCalls(probe);
});

test("fanout：任务未 settle 时 turn-stopping 兜底保持 root turn 打开，settle 后放行", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const fanout = host.toolDefinition("fanout");
  assert.ok(fanout !== undefined, "provider 就绪时必须挂载 fanout 工具");
  const submitted = await fanout.execute({
    role: "explorer",
    basePrompt: "fanout wait probe",
    shards: [{ shardId: "s1", prompt: "shard one" }],
  }, { agent: root });
  assert.equal(submitted.kind, "fanout");
  assert.equal(submitted.accepted, true);
  assert.equal(typeof submitted.parentTaskId, "string");
  await flushAsyncWork(10);

  // fan-out 分片 child 是 root 的后代：只要它还在跑，turn 就不能关闭。
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1, "fanout 任务未 settle 时兜底必须参与等待");
  let settled = false;
  stop.settled.then(() => { settled = true; });
  await flushAsyncWork(20);
  assert.equal(settled, false, "fanout 任务未 settle 时不得放行");

  // 分片真实终态 → task_settled → 等待被精确结算（只结算当前登记代次）。
  const shard = children[0];
  shard.child.session.events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { id: shard.messageId, role: "user", content: [], source: { kind: "plugin:dsh-expert-group" } } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "shard done" }] } } },
  ];
  host.emit("session/event", shard.child.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await flushAsyncWork(12);
  const task = await host.invokeConnection(RPC_ENDPOINT, {
    action: "fanout-get",
    sessionId: root.id,
    parentTaskId: submitted.parentTaskId,
  });
  assert.equal(task.value.task.status, "completed", "分片结束后父任务必须终态");

  // child 明确不再运行：等待被结算且静止判定成立后放行。
  host.setAgentStatus(shard.child, "idle");
  await flushAsyncWork(24);
  assert.equal(settled, true, "fanout 任务 settle 后必须放行");
  assertNoGoalCalls(probe);
});

// ── 6. 竞态：新 admission / child 创建让旧静止结论作废 ─────────────────────

test("竞态保护：等待期间新登记的工作让旧静止结论作废", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  // 让第一个 child 明确结束（静止判定本应成立）。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-race-1");

  // 同一 tick 内再创建一个新的 child（模拟等待窗口内出现的新后代）。
  const late = host.registerRootAgent("wait-child-late", { lifecycle: false });
  late.session.header = { id: "wait-child-late", parentSession: ROOT_ID, origin: "subagent" };
  late.status = "running";
  host.emit("agent/created", { agent: late });

  await flushAsyncWork(16);
  assert.equal(pending.status, "pending", "新 child 出现必须让旧静止结论作废并重新等待");

  host.setAgentStatus(late, "idle");
  await flushAsyncWork(16);
  assert.equal(pending.status, "resolved");
  assertNoGoalCalls(probe);
});

// ── 7. 生命周期：dispose / 代际替换 / 卸载 ─────────────────────────────────

test("root dispose 取消等待：Promise 以 root-wait-cancelled 收口且清理监听", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  const listenersBefore = host.listenerCount("agent/turn-stopping");
  host.disposeAgent(root);
  await flushAsyncWork(12);

  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "rejected");
  assert.equal(pending.value.reason, "root-wait-cancelled");
  assert.ok(String(pending.value.message).includes("root-disposed"), "回执必须说明取消原因");
  // 插件级监听器属于插件 fiber，root dispose 不卸载它；这里断言它仍被正确注册（不泄漏额外监听）。
  assert.equal(host.listenerCount("agent/turn-stopping"), listenersBefore);
  assertNoGoalCalls(probe);
});

test("插件卸载：等待被取消，且不留下悬空 Promise", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  await host.dispose();
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.reason, "root-wait-cancelled");
  assert.ok(String(pending.value.message).includes("plugin-unloaded"), "卸载必须给出 plugin-unloaded 原因");
  assertNoGoalCalls(probe);
});

test("代际替换：旧 root 的等待被取消，新 root 拥有独立等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  // 同 id 的新代际：旧 root 先 dispose，再登记同 id 的新 root。
  host.disposeAgent(root);
  const replacement = host.registerRootAgent(ROOT_ID);
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.reason, "root-wait-cancelled");

  // 旧代际的迟到 notice / 状态变化不得影响新 root（新 root 没有等待）。
  insertNotice(host, root, children[0], "fb-late-generation");
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.reason, "root-wait-cancelled", "旧代际结论不得被迟到事件改写");
  assertNoGoalCalls(probe);
});

// ── 8. 用户等待（ask_user_question / exit_plan_mode）仍工作 ────────────────

test("ask_user_question / exit_plan_mode 的 pending user wait 仍工作且不触碰 goal API", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });

  // 非 goal 的 guard 职责：exact live root 上放行用户等待；root 已销毁时明确拒绝。
  const verdictsFor = (agent) => host.guards.map((candidate) => {
    try { return candidate({ agent, name: "ask_user_question" }); } catch (error) { return error; }
  });
  assert.ok(
    verdictsFor(root).every((verdict) => verdict === undefined),
    "live root 的 ask_user_question 必须被放行（guard 不得因为等待登记而拒绝）",
  );

  // 用户回答落 tool/result（role=user）：等待被清理，root run 重新开始。
  await host.startRootRun(root, 1);
  host.emit("session/event", root.session, {
    type: "tool/result",
    data: { message: { role: "user", content: [] } },
  });
  await flushAsyncWork(8);
  assertNoGoalCalls(probe);

  // 已销毁 root：必须至少有一个 guard 明确拒绝，绝不开始一个没有归属的等待。
  host.disposeAgent(root);
  await flushAsyncWork(4);
  const rejections = verdictsFor(root).filter((verdict) => typeof verdict === "string" && verdict.length > 0);
  assert.ok(rejections.length > 0, "已销毁 root 的用户等待必须被明确拒绝");
  assert.ok(
    rejections.some((reason) => reason.includes("no longer live")),
    "拒绝原因必须说明 root 已不再 live",
  );
  assertNoGoalCalls(probe);
});

test("没有注入 goals 服务时等待语义完全不变", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, withGoals: false });
  const outcome = await startAdmission(host, root);
  const pending = track(finalize(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-no-goal-service");
  await flushAsyncWork(12);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

// ── 9. 回执契约：不再有 paused/concluded，且拒绝原因可自诊断 ───────────────

test("finalize 回执契约：无 admission 时是 no-admission，且回执无 goal 字段", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });
  // 从未调用任何 role 工具：epoch 0 + 空 token 集是幂等 no-admission，必须立即收口。
  const result = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: 0,
    admissionTokens: [],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(result.kind, "noop");
  assert.equal(result.reason, "no-admission");
  assert.equal("paused" in result, false, "回执不得再带 paused");
  assert.equal("concluded" in result, false, "回执不得再带 concluded");
  assertNoGoalCalls(probe);
});

test("finalize 回执契约：开放批次上的过期 epoch 仍被拒绝且无 goal 字段", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });
  await startAdmission(host, root, "wait probe continue task", ["docs/wait-epoch.md"]);
  const result = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: 0,
    admissionTokens: [],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "admission-epoch-mismatch");
  assert.equal("paused" in result, false);
  assert.equal("concluded" in result, false);
  assertNoGoalCalls(probe);
});

// ── 10. agent/turn-stopping 兜底（模型遗漏 finalize / 纯 continue / fanout） ──

/**
 * 驱动一次 `agent/turn-stopping`：宿主对该 serial 事件会 await 监听器返回的 Promise，
 * 因此这里把返回值收成一个 Promise，用例据此断言「turn 是否被保持打开」。
 */
function stopRootTurn(host, root, turn = 1, signal) {
  const results = host.emit("agent/turn-stopping", { agent: root, turn, ...(signal === undefined ? {} : { signal }) });
  const pending = results.filter((value) => value !== null && typeof value === "object" && typeof value.then === "function");
  return { returned: results.length, pending: pending.length, settled: Promise.all(pending).then(() => "settled") };
}

test("turn-stopping 兜底：纯 continue_parent_turn 留下的 running child 让 turn 保持打开", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "continue probe task", ["docs/wait-continue.md"], { continue_parent_turn: true });
  assert.equal(outcome.kind, "continuable");
  assert.equal(outcome.accepted, true);
  await flushAsyncWork(8);

  // 模型没有调用 finalize：turn 即将关闭，但 child 仍在运行。
  const stop = stopRootTurn(host, root);
  assert.ok(stop.returned > 0, "turn-stopping 必须有监听器参与判定");
  assert.equal(stop.pending, 1, "root 的 turn-stopping 必须返回可 await 的等待 Promise");

  let settled = false;
  stop.settled.then(() => { settled = true; });
  await flushAsyncWork(20);
  assert.equal(settled, false, "child 仍在运行时 turn-stopping 必须保持 turn 打开");

  // child 真正结束（turn/end + 明确不再 running）后兜底才放行。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(20);
  assert.equal(settled, true, "child 结束后 turn-stopping 必须放行");
  assertNoGoalCalls(probe);
});

test("AbortSignal：finalize 与 turn-stopping 各自取消等待，但保留工作直到 child 真正结束", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "abort wait probe", ["docs/wait-abort.md"]);

  const finalizeController = new AbortController();
  const pendingFinalize = track(finalize(host, root, outcome, finalizeController.signal));
  await flushAsyncWork(8);
  assert.equal(pendingFinalize.status, "pending");
  finalizeController.abort();
  await flushAsyncWork(12);
  assert.equal(pendingFinalize.status, "resolved", "finalize 应以公开 exec.signal 快速收口");
  assert.equal(pendingFinalize.value.kind, "rejected");
  assert.equal(pendingFinalize.value.reason, "root-wait-cancelled");
  assert.match(pendingFinalize.value.message, /signal-aborted/);

  const retryFinalize = track(finalize(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(retryFinalize.status, "pending", "同一 epoch/token 的 finalize 重试必须继续等待保留的 child 工作");

  const stopController = new AbortController();
  const stop = stopRootTurn(host, root, 2, stopController.signal);
  let stopSettled = false;
  stop.settled.then(() => { stopSettled = true; });
  await flushAsyncWork(10);
  assert.equal(stopSettled, false, "stop 等待必须仍观察到原 admission 和 running child");
  stopController.abort();
  await flushAsyncWork(10);
  assert.equal(stopSettled, true, "turn-stopping 应将 payload.signal 传给该 waiter");

  const retryStop = stopRootTurn(host, root, 3);
  let retrySettled = false;
  retryStop.settled.then(() => { retrySettled = true; });
  await flushAsyncWork(10);
  assert.equal(retrySettled, false, "取消的 waiter 不得清除 admission 或伪造静止");

  endChildTurn(host, children[0]);
  insertNotice(host, root, children[0], "fb-abort-retained-work");
  await flushAsyncWork(10);
  assert.equal(retryFinalize.status, "pending", "turn/end 与反馈结算后，child 仍报告 running 时必须继续等待");

  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(20);
  assert.equal(retrySettled, true, "真实 child turn/end + feedback settlement 后静止才让新 waiter 收口");
  assert.equal(retryFinalize.status, "resolved");
  assert.equal(retryFinalize.value.kind, "finalized");
  assert.equal(retryFinalize.value.reason, "finalized");
  assertNoGoalCalls(probe);
});

test("turn-stopping 兜底：没有任何登记工作时立即放行（不悬挂 turn）", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });
  const stop = stopRootTurn(host, root);
  await flushAsyncWork(8);
  // 该 root 从未 engage 过等待体系：兜底必须直接返回，不产生任何待等待 Promise。
  assert.equal(stop.pending, 0, "未 engage 的 root 不得被兜底悬挂");
  await stop.settled;
  assertNoGoalCalls(probe);
});

test("turn-stopping 兜底与 finalize 共用同一账本：child 仍在运行时两边都不放行", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const first = await startAdmission(host, root, "stop probe one", ["docs/stop-one.md"]);
  const pendingFinalize = track(finalize(host, root, first));
  await flushAsyncWork(8);
  assert.equal(pendingFinalize.status, "pending");

  // 同一个 root 的 turn-stopping 兜底：走的是**同一张**等待表，因此同样保持打开。
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1);
  let stopSettled = false;
  stop.settled.then(() => { stopSettled = true; });
  await flushAsyncWork(12);
  assert.equal(stopSettled, false, "child 仍在运行时兜底也不得放行");

  // child 明确结束（turn/end + 不再 running）后，两条通道都在同一轮判定里收口。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(16);
  assert.equal(pendingFinalize.status, "resolved");
  assert.equal(stopSettled, true);
  assertNoGoalCalls(probe);
});

test("finalize 校验失败时不登记等待（Promise 立即收口，不悬挂）", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const result = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: outcome.admissionEpoch,
    admissionTokens: [],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "incomplete-admission-token-set");
  assertNoGoalCalls(probe);
});

// ── 11. 同一 root 的第二轮等待（第一批静止后 continue_parent_turn） ─────────

test("同一 root 第二轮：第一批静止收口后，continue_parent_turn 的第二批重新判定并释放", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });

  // 第一批：普通 accepted admission。
  const first = await startAdmission(host, root, "round one task", ["docs/round-one.md"]);
  const firstFinalize = track(finalize(host, root, first));
  await flushAsyncWork(8);
  assert.equal(firstFinalize.status, "pending");
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-round-one");
  await flushAsyncWork(20);
  assert.equal(firstFinalize.status, "resolved", "第一批必须正常收口");
  assert.equal(firstFinalize.value.kind, "finalized");

  // 第二批：纯 continue_parent_turn（不产生等待工作，只留下一个 running child）。
  // 这是旧实现永久 pending 的路径：记录已 released、监听已解除。
  const second = await startAdmission(
    host, root, "round two task", ["docs/round-two.md"], { continue_parent_turn: true },
  );
  assert.equal(second.kind, "continuable");
  assert.equal(children.length, 2, "第二轮必须新建独立 child");
  await flushAsyncWork(8);

  const stop = stopRootTurn(host, root, 2);
  assert.equal(stop.pending, 1, "第二轮必须重新进入等待体系（记录重建 + 监听重订阅）");
  let settled = false;
  stop.settled.then(() => { settled = true; });
  await flushAsyncWork(20);
  assert.equal(settled, false, "第二轮 child 仍在运行时不得放行");

  // 第二轮 child 真正结束：重新订阅的监听必须驱动一次新的判定。
  endChildTurn(host, children[1], 1);
  host.setAgentStatus(children[1].child, "idle");
  await flushAsyncWork(24);
  assert.equal(settled, true, "第二轮静止后必须放行，绝不能永久 pending");
  assertNoGoalCalls(probe);
});

test("同一 root 第二轮：第二批的 accepted admission 同样能再次等待并收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });

  const first = await startAdmission(host, root, "second round one", ["docs/second-round-one.md"]);
  const firstFinalize = track(finalize(host, root, first));
  await flushAsyncWork(8);
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-second-round-one");
  await flushAsyncWork(20);
  assert.equal(firstFinalize.status, "resolved");

  // 第二批走普通 accepted admission：新的 epoch、新的 token、新的等待记录。
  const second = await startAdmission(host, root, "second round two", ["docs/second-round-two.md"]);
  const secondFinalize = track(finalize(host, root, second));
  await flushAsyncWork(8);
  assert.equal(secondFinalize.status, "pending", "第二批 accepted 必须重新等待");

  endChildTurn(host, children[1]);
  host.setAgentStatus(children[1].child, "idle");
  insertNotice(host, root, children[1], "fb-second-round-two");
  await flushAsyncWork(20);
  assert.equal(secondFinalize.status, "resolved", "第二批必须收口");
  assert.equal(secondFinalize.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

// ── 12/13. 工厂级回归：recheck 消费与 retire 引用清理 ───────────────────────

/**
 * 受控 factory rig：直接驱动 host/turn-wait.js 的状态机，用可控的 snapshot Promise
 * 与可手动触发的 invalidate 精确构造竞态。
 *
 * @param {(callIndex:number)=>Promise<object>} snapshot - 第 N 次查询（1 起）的返回。
 * @returns {{registry:object, calls:number[], agents:Set<object>, fire:(agent:object)=>void}}
 */
function createFactoryRig(snapshot) {
  const calls = [];
  const agents = new Set();
  const invalidators = new Map();
  const registry = createRootTurnWaitRegistry({
    isLiveRoot: (agent) => agents.has(agent),
    snapshotDescendants: (rootId) => { calls.push(rootId); return snapshot(calls.length); },
    subscribe: (agent, invalidate) => {
      const set = invalidators.get(agent) ?? new Set();
      set.add(invalidate);
      invalidators.set(agent, set);
      return () => { set.delete(invalidate); };
    },
    onError: () => {},
  });
  return {
    registry,
    calls,
    agents,
    /** 模拟一次宿主活动事件（child 创建 / 状态变化）。 */
    fire(agent) { for (const invalidate of [...(invalidators.get(agent) ?? [])]) invalidate(); },
    /** 该 root 当前订阅的监听数（销毁后必须归零）。 */
    listenerCount(agent) { return (invalidators.get(agent) ?? new Set()).size; },
  };
}

test("AbortSignal：预先取消的等待立即返回且不创建状态记录", async () => {
  const agent = { id: "root-factory-pre-aborted" };
  const rig = createFactoryRig(async () => ({ known: true, running: [] }));
  rig.agents.add(agent);
  const controller = new AbortController();
  controller.abort();

  const waitState = track(rig.registry.wait(agent, controller.signal));
  await flushAsyncWork(1);

  assert.equal(waitState.status, "resolved");
  assert.deepEqual(waitState.value, { released: false, reason: "signal-aborted" });
  assert.equal(rig.calls.length, 0, "预先取消不得启动静止查询");
  assert.equal(rig.registry.size, 0, "预先取消不得创建等待记录");
});

test("AbortSignal：共享记录中只取消对应 waiter", async () => {
  const agent = { id: "root-multiple" };
  const queries = [];
  const registry = createRootTurnWaitRegistry({ isLiveRoot: () => true, snapshotDescendants: () => { const d = createDeferred(); queries.push(d); return d.promise; }, subscribe: () => () => {} });
  registry.engage(agent);
  const controller = new AbortController();
  const first = track(registry.wait(agent, controller.signal));
  const second = track(registry.wait(agent));
  controller.abort();
  await flushAsyncWork(2);
  assert.deepEqual(first.value, { released: false, reason: "signal-aborted" });
  assert.equal(second.status, "pending");
  assert.equal(queries.length, 1);
  queries[0].resolve({ known: true, running: [] });
  await flushAsyncWork(2);
  assert.equal(second.status, "resolved");
  registry.dispose();
});

test("AbortSignal：取消只释放当前 waiter，忽略在途静止快照并保留记录", async () => {
  const agent = { id: "root-factory-abort-stale-query" };
  const inflight = createDeferred();
  const replacement = createDeferred();
  const rig = createFactoryRig((index) => (index === 1 ? inflight.promise : replacement.promise));
  rig.agents.add(agent);
  rig.registry.engage(agent);

  const controller = new AbortController();
  const cancelled = track(rig.registry.wait(agent, controller.signal));
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 1);

  controller.abort();
  await flushAsyncWork(1);
  assert.deepEqual(cancelled.value, { released: false, reason: "signal-aborted" });
  assert.equal(rig.registry.size, 1, "取消 waiter 不得销毁等待记录");
  assert.equal(rig.registry.describe(agent).released, false, "取消不得伪造静止结论");

  const next = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 2, "新 waiter 不得被旧的未完成查询卡住");

  inflight.resolve({ known: true, running: [], reason: "stale-quiescent-snapshot" });
  await flushAsyncWork(2);
  assert.equal(next.status, "pending", "取消前启动的快照结果必须被忽略");
  assert.equal(rig.registry.describe(agent).released, false);

  replacement.resolve({ known: true, running: [{ id: "still-running" }] });
  await flushAsyncWork(2);
  assert.equal(next.status, "pending", "未取消的 waiter 必须继续等待 running child");
  rig.registry.retire(agent);
});

test("AbortSignal：取消后 admission 保留，新 waiter 等待真实结算", async () => {
  const agent = { id: "root-factory-abort-retains-work" };
  const inflight = createDeferred();
  const secondQuery = createDeferred();
  const settledQuery = createDeferred();
  const rig = createFactoryRig((index) => [inflight.promise, secondQuery.promise, settledQuery.promise][index - 1]);
  rig.agents.add(agent);
  const work = { kind: "admission", token: "retained-admission" };
  rig.registry.track(agent, work);

  const controller = new AbortController();
  const cancelled = track(rig.registry.wait(agent, controller.signal));
  await flushAsyncWork(1);
  controller.abort();
  await flushAsyncWork(1);
  assert.deepEqual(cancelled.value, { released: false, reason: "signal-aborted" });
  assert.equal(rig.registry.outstandingCount(agent), 1, "取消不得删除 admission 工作项");

  const next = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 2, "后续 waiter 应启动新的静止查询");
  inflight.resolve({ known: true, running: [], reason: "stale-quiescent-snapshot" });
  await flushAsyncWork(2);
  assert.equal(next.status, "pending", "取消 waiter 的旧快照不能释放后续 waiter");
  assert.equal(rig.registry.outstandingCount(agent), 1);

  secondQuery.resolve({ known: true, running: [], reason: "work-still-outstanding" });
  await flushAsyncWork(2);
  assert.equal(next.status, "pending", "未结算 admission 仍然阻止静止");
  assert.equal(rig.registry.settle(agent, work), true, "真实 settlement 应仍可命中保留的工作项");
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 3, "真实 settlement 后需要重新验证静止状态");
  settledQuery.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(2);
  assert.equal(next.status, "resolved");
  assert.deepEqual(next.value, { released: true, reason: "quiescent" });
});

test("recheck 消费：查询在飞期间的事件在 reject 后必须触发第二次查询", async () => {
  const agent = { id: "root-factory-recheck" };
  const first = createDeferred();
  const second = createDeferred();
  const rig = createFactoryRig((index) => (index === 1 ? first.promise : second.promise));
  rig.agents.add(agent);

  const waitState = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 1, "wait 必须发起第一次查询");
  assert.equal(waitState.status, "pending");

  // 查询在飞期间发生一次宿主活动（status/settlement）：这会置 recheck。
  rig.fire(agent);

  first.reject(new Error("transient snapshot failure"));
  await flushAsyncWork(2);
  assert.equal(rig.calls.length, 2, "reject 必须消费 recheck 并重跑查询，不能吞掉复查意图");

  second.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(2);
  assert.equal(waitState.status, "resolved", "第二次查询明确静止后必须释放");
  assert.equal(waitState.value.released, true);
});

test("recheck 消费：连续 reject 且无新事件时保持等待且不自旋", async () => {
  const agent = { id: "root-factory-nospin" };
  const first = createDeferred();
  const second = createDeferred();
  const rig = createFactoryRig((index) => (index === 1 ? first.promise : second.promise));
  rig.agents.add(agent);

  const waitState = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  rig.fire(agent);
  first.reject(new Error("first failure"));
  await flushAsyncWork(2);
  assert.equal(rig.calls.length, 2, "第一次 reject 消费 recheck 并重跑一次");

  // 第二次查询也 reject，但期间没有任何新事件：绝不能继续重跑。
  second.reject(new Error("second failure"));
  await flushAsyncWork(6);
  assert.equal(rig.calls.length, 2, "没有新事件时不得继续重跑（不能自旋）");
  assert.equal(waitState.status, "pending", "查询持续失败必须保持等待（unknown 不放行）");
});

test("retire：等待者以 released:false 收口，记录与监听立即回收，在途快照不得挂回", async () => {
  const agent = { id: "root-factory-retire" };
  const inflight = createDeferred();
  const rig = createFactoryRig(() => inflight.promise);
  rig.agents.add(agent);

  const waitState = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  assert.equal(rig.registry.size, 1);
  assert.equal(rig.listenerCount(agent), 1, "记录必须订阅监听");

  assert.equal(rig.registry.retire(agent, "root-disposed"), true);
  await flushAsyncWork(1);
  assert.equal(waitState.status, "resolved");
  assert.deepEqual(waitState.value, { released: false, reason: "root-disposed" });
  assert.equal(rig.registry.size, 0, "销毁必须把记录移出登记表");
  assert.equal(rig.listenerCount(agent), 0, "销毁必须解除监听");
  assert.equal(rig.registry.isEngaged(agent), false);
  assert.equal(rig.registry.describe(agent), undefined);

  // 在途快照落地：绝不能让已退休记录重新挂回登记表，也不得改变任何结论。
  inflight.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(4);
  assert.equal(rig.registry.size, 0, "在途快照不得把已退休记录挂回");
  assert.equal(rig.registry.describe(agent), undefined);
  assert.deepEqual(waitState.value, { released: false, reason: "root-disposed" });
});

test("retire：在途快照落地时不再触碰已退休的 exact Agent（revocable proxy）", async () => {
  const inflight = createDeferred();
  const rig = createFactoryRig(() => inflight.promise);
  const { proxy, revoke } = Proxy.revocable({ id: "root-factory-proxy" }, {});
  rig.agents.add(proxy);

  const waitState = track(rig.registry.wait(proxy));
  await flushAsyncWork(1);
  rig.registry.retire(proxy, "root-generation-retired");
  // 撤销代理：任何对 record.agent 的字段读取都会抛 TypeError。
  revoke();
  inflight.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(4);
  assert.deepEqual(waitState.value, { released: false, reason: "root-generation-retired" });
  assert.equal(rig.registry.size, 0);
});

test("retire 后重新等待：建立全新记录并重新订阅监听", async () => {
  const agent = { id: "root-factory-reengage" };
  const firstQuery = createDeferred();
  const secondQuery = createDeferred();
  const rig = createFactoryRig((index) => (index === 1 ? firstQuery.promise : secondQuery.promise));
  rig.agents.add(agent);

  track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  rig.registry.retire(agent, "root-disposed");
  firstQuery.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(2);
  assert.equal(rig.listenerCount(agent), 0);

  // 同 id 的新代际（不同对象）与「同一对象重新 engage」都必须拿到全新记录。
  const reengaged = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  assert.equal(rig.calls.length, 2, "重新等待必须重新发起查询");
  assert.equal(rig.listenerCount(agent), 1, "重新等待必须重新订阅监听");
  secondQuery.resolve({ known: true, running: [], reason: "no-running-descendants" });
  await flushAsyncWork(2);
  assert.equal(reengaged.status, "resolved");
  assert.equal(reengaged.value.released, true);
});
