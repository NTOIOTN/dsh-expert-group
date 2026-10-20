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
 * 10. 后代 seam 的 known/unknown 判定：静止证明**只**来自「权威 listing 的干净完整
 *     catalog」**加上**「同一份 exact runtime `agents.list()` 快照」——catalog 的
 *     `activity` 只表达 session residency（idle 的 durable child 仍可能报 running），
 *     运行判定必须用 runtime `Agent.status`（rc.2 只有 idle/running）交叉校验，并用同一
 *     份快照验证 live 后代已被 catalog 完整覆盖；waterfall（`workspace/session-activity`）
 *     无论返回 sentinel、全新空数组、非空但无 subagent 族还是 malformed，都必须继续等待
 *     ——它是**非专属**扩展点，任意 listener 都能返回新的空数组，因此只能提供「确有
 *     running 后代」的正向证据；
 * 10c. 权威 listing **行级公开契约**校验：child 行的必填字段（`id`、`mode`、
 *     `activity`、`hasChildren`、`parentId`、`depth`，continuable 行的 `label`）
 *     任一缺失或非法，整次 listing 都视为 unknown；此外重复 id、parentId/depth 冲突、
 *     runtime 快照缺失/查询失败、live 后代未被 catalog 覆盖或被标 inactive、
 *     非法 `Agent.status`（含 ready）一律 unknown；
 * 10d. 合法 durable 非驻留行（`activity:"inactive"` 且 runtime 没有该 Agent）按
 *     「当前未运行」接受，不得阻塞已结算的 root turn；
 * 11. 同一 root 的第二轮等待（第一批静止后再 continue_parent_turn）；
 * 12. 查询 rejection 必须消费 recheck（不吞复查意图、也不自旋）；
 * 13. retire 后记录对 exact Agent 的强引用被清空、在途快照不得把记录挂回。
 *
 * 第 10–13 条同时覆盖**权威 listing seam**（`subagents.listDescendants` + exact
 * `agents.list()` 快照交叉校验）、**runtime fallback**（listing 缺失时，同样需要
 * `agents.list()`）与 **waterfall 回退 seam**（`workspace/session-activity` + 无 provider
 * sentinel，只能给正向证据）。
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
 * 建立受控 Host：subagents.startContinuable 同步登记 child（含 subagent 血缘），使 harness
 * 的两条 seam 都能读到同一份宿主事实：
 * - `subagents.listDescendants`（权威 catalog seam；提供后代清单与 **session residency**
 *   的 `activity`，默认启用）；
 * - `workspace/session-activity` waterfall（降级；只能提供正向的 running 证据）。
 *
 * rc.2 校正：listing 的 `activity` **不**是运行证据（驻留的 idle child 仍报 running），
 * 运行判定由插件用同一份 exact runtime 快照里的 `Agent.status` 交叉校验（running 阻塞、
 * idle 当前未运行、ready 等非法状态一律未知）。`rootChildren: "live"` 把 harness 的 live
 * 注册表接成 `agents.list()` 快照；省略时保持夹具默认「不注入 list」。
 *
 * @param {Function} [options.descendantRowTransform] 逐行改写权威 listing 的合法 child
 *   行；只用于**显式构造非法输入**（缺 `mode` / `mode` 非法 / 缺其他必填字段）或建模
 *   catalog 遗漏（返回 `undefined`），验证插件按公开契约 fail-closed。默认不传。
 */
function createWaitHost({
  goalProbe,
  sessionActivity = "subagent",
  descendantListing = "subagent",
  descendantRowTransform,
  /**
   * 覆盖权威 listing seam 的具体实现（只给日志泄漏回归用）：传入后它会替代 harness 的
   * listDescendants，让用例可以抛出一个**带敏感 message** 的异常，验证等待路径的日志
   * 只记录固定前缀与错误名。省略时保持 harness 的受控模式语义。
   */
  descendantListingImplementation,
  durableNonResidentRows,
  sessionActivityTransport = true,
  // 默认 "live"：真实 rc.2 宿主**一定**提供 agents.list()，等待的运行判定必须用同一份
  // 完整 runtime 快照交叉校验（缺它一律 fail-closed）。`null` 表示宿主没有该 seam，
  // 用于覆盖「无法验证覆盖关系 ⇒ 继续等待」的下层路径。
  rootChildren = "live",
  withGoals = true,
  childIdFactory,
  steerSeam = false,
} = {}) {
  const children = [];
  // 显式续作（childId + queue）需要公开 subagents.sendMessage seam：与真实 Host 一样
  // 返回新铸的 admission messageId。默认不注入，保持「未配置即抛错」的夹具语义。
  const steered = [];
  const host = createPluginHost({
    ...(withGoals ? { goals: goalProbe.service } : {}),
    sessionActivity,
    descendantListing,
    descendantRowTransform,
    ...(durableNonResidentRows === undefined ? {} : { durableNonResidentRows }),
    sessionActivityTransport,
    // rootChildren: "live" ⇒ 把 harness 的 live Agent 注册表作为 agents.list() 快照
    // （真实 rc.2 宿主一定有该 seam）；`null` ⇒ 宿主没有该 seam（覆盖 fail-closed 路径）。
    ...(rootChildren === null || rootChildren === undefined
      ? {}
      : { rootChildren: rootChildren === "live" ? () => host.agents.roots() : rootChildren }),
    settings: {
      // 这些用例只验证等待语义；关闭系统通知，避免完成通知 spawn 真实 PowerShell
      // 子进程（会污染桌面并把测试尾延迟拖到秒级）。通知文案由专门用例覆盖。
      value: {
        provider: "mock",
        defaults: { explorer: { provider: "mock", model: "mock" } },
        notificationEnabled: false,
      },
    },
    subagents: {
      ...(typeof descendantListingImplementation === "function"
        ? { listDescendants: descendantListingImplementation }
        : {}),
      async startContinuable({ request }) {
        const index = children.length + 1;
        const childId = typeof childIdFactory === "function"
          ? childIdFactory(index)
          : "wait-child-" + index;
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
      ...(steerSeam === true ? {
        /**
         * 公开显式续作 seam：把本轮 prompt 投递给既有 child，并返回新铸的 messageId
         * （与 DSH SubagentService.sendMessage 的 admission 结果同形）。
         */
        async sendMessage(parent, childId, content, options) {
          const messageId = "wait-steer-message-" + (steered.length + 1);
          steered.push({ parent, childId, content, options, messageId });
          return messageId;
        },
      } : {}),
    },
  });
  host.apply();
  const root = host.registerRootAgent(ROOT_ID);
  return { host, root, children, steered };
}

/**
 * 等待条件成立——替代「睡固定墙钟再断言」。
 *
 * 背景：`host/turn-wait.js` 的退避重查间隔是 10/20/40/80…ms，本文件里两个用例过去用
 * 固定 `setTimeout(80)` 等一次重查落地：既白等一次退避的余量，又对定时器精度敏感
 * （Windows 上 setTimeout 的实际触发可能晚于名义值）。这里每 5ms 轮询一次，条件一成立
 * 立刻返回；`timeoutMs` 只是兜底上限，真正的回归会由随后的断言（pending 仍是 pending、
 * calls 不足等）给出失败，而不是把失败变成超时等待。
 */
async function waitUntil(predicate, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
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

/**
 * 调用真实注册的 finalize 工具。
 *
 * 两阶段契约：这个 Promise 现在**立即**以非终态 waiting 回执收口（登记已完成，专家可能
 * 仍在运行）。真正的等待与投递发生在 root turn 的 `agent/turn-stopping` 边界，见
 * finalizeLifecycle。
 */
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

/**
 * 两阶段收口的统一测试入口（保留 track() 的断言形状）。
 *
 * finalize 只做校验与登记并立即返回 waiting；继续等待由 root turn 的
 * `agent/turn-stopping` serial 边界承担（与真实宿主同一顺序：工具返回后 turn 收尾）。
 * 本 helper 把整条链路投影成一个 thenable，供既有 `track(finalizeLifecycle(...))` 用例
 * 继续断言「等待是否仍在进行 / 是否已经收口」：
 *
 * - resolve 值 `{kind:"finalized", admissionEpoch, acceptedCount, reason:"finalized"}`：
 *   等待释放，且插件确实为该批次投递了一次性收口消息（epoch / acceptedCount 取自被投递
 *   消息的公开正文，不读取任何插件私有状态）；
 * - resolve 值 `{kind:"cancelled"}`：等待被取消（payload.signal abort / root 退休 /
 *   插件卸载）。取消不是终态收口，因此绝不谎报 finalized，也绝不投递结论；
 * - finalize 自身被拒绝（校验失败）时原样返回该回执，保持既有 rejected 断言可用。
 *
 * 注意：**不**把 finalize 的 `exec.signal` 转发给 turn-stopping——那正是本契约要切断的
 * 耦合（run_code 子执行结束不得取消 root turn 生命周期等待）；root turn 的 signal 由
 * 用例显式驱动 `agent/turn-stopping` 时传入。
 */
function finalizeLifecycle(host, root, outcomes, signal) {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  const deliveredBefore = host.agentSteerMessages(root).length;
  return (async () => {
    const receipt = await finalize(host, root, outcomes, signal);
    if (receipt.kind !== "waiting") return receipt;
    // finalize 只登记：等待与投递都发生在本次 root turn 的 serial 边界。
    const stop = stopRootTurn(host, root);
    if (stop.pending === 0) return { kind: "cancelled", reason: "wait-not-engaged" };
    await stop.settled;
    const delivered = host.agentSteerMessages(root).slice(deliveredBefore);
    if (delivered.length === 0) return { kind: "cancelled", reason: "wait-cancelled" };
    const text = delivered.map((message) => message.content.map((block) => block.text).join("")).join("\n");
    const accepted = /acceptedCount (\d+)/.exec(text);
    const epoch = /admissionEpoch (\d+)/.exec(text);
    return {
      kind: "finalized",
      admissionEpoch: Number(epoch?.[1] ?? list[0]?.admissionEpoch ?? 0),
      acceptedCount: Number(accepted?.[1] ?? 0),
      reason: "finalized",
    };
  })();
}

/**
 * 构造一个 child turn/end 终态事件（同时写入该 turn 的事件日志）。
 *
 * 返回的事件对象可被同一同步批次**重投递**多次：真实 Host 的迟到副本携带的正是同一个
 * event 对象，因此「首次 receipt 保留」的语义必须绑定 exact event 身份。
 */
function buildChildTurnEnd(entry, { turn, messageId, reason }) {
  entry.child.session.events = [
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin:dsh-expert-group" } } },
    { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: "done" }] } } },
  ];
  return { type: "turn/end", data: { turn, reason: reason ?? { kind: "completed" } } };
}

/**
 * 为同一 child 写入「多个 turn 的完整事件日志」，并返回指定 turn 的终态事件对象。
 *
 * 为什么需要它：同一同步批次里先后发布两个不同 turn 的终态时，处理被延迟到 microtask，
 * 而日志在同步阶段就已推进到更晚的 turn。真实 Host 的 session 日志是**单调追加**的，
 * 因此每个 turn 自己的输出始终可见；夹具必须同形，否则「该 turn 没有输出」的假象会被
 * 判成可恢复失败，进而错误打开 recovery gate（那是夹具缺陷，不是插件行为）。
 */
function buildChildMultiTurnEnd(entry, { turns, turn }) {
  entry.child.session.events = turns.flatMap((item) => [
    { type: "turn/start", data: { turn: item.turn } },
    { type: "user/message", data: { id: item.messageId, role: "user", content: [], source: { kind: "plugin:dsh-expert-group" } } },
    { type: "assistant/message", data: { turn: item.turn, message: { content: [{ type: "text", text: "done" }] } } },
  ]);
  return { type: "turn/end", data: { turn, reason: { kind: "completed" } } };
}

/** 让某个 admission 的 child turn 正常结束（turn/end 边界）。 */
function endChildTurn(host, entry, turn = 1) {
  host.emit("session/event", entry.child.session, buildChildTurnEnd(entry, { turn, messageId: entry.messageId }));
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

/** 真实 Host 自动完成通知的固定正文（完整前缀 + canonical child UUID）。 */
function sourceLessNoticeText(childId) {
  return "Background subagent " + childId + " finished and will do no further work unless you send it more.";
}

/**
 * 发布一条真实形状的 agent/inbox/spliced（target=next-step）自动完成通知。
 *
 * 真实 Host 把自动完成消息作为 root Session 的 spliced 事件发布（而不是 guaranteed 的
 * agent/inbox/inserted），因此「到达顺序」相关的用例必须走这条通道。seq 只在 safe-integer
 * 时形成 delivery（去重）身份；缺失/非法值必须 fail-closed。
 *
 * @param {object} host - 受控 Host。
 * @param {object} root - exact root Agent。
 * @param {{childId?:string,seq?:number,source?:object,text?:string,target?:string}} options
 */
function emitSplicedNotice(host, root, { childId, seq, source, text, target = "next-step" }) {
  return host.emit("session/event", root.session, {
    ...(seq === undefined ? {} : { seq }),
    type: "agent/inbox/spliced",
    data: {
      target,
      inserted: [{
        content: [{ type: "text", text: text === undefined ? sourceLessNoticeText(childId) : text }],
        ...(source === undefined ? {} : { source }),
      }],
    },
  });
}

/**
 * 结束指定 messageId 所属的 turn。
 *
 * 同一 child 上可以有多个 admission（显式 childId 续作），每个 admission 归属自己那个
 * turn：turn/end 的消息归属由该 turn 内的 user/message 决定，因此这里显式写事件，而不是
 * 复用只支持单一 messageId 的 endChildTurn。
 */
function endChildTurnForMessage(host, entry, { turn, messageId }) {
  host.emit("session/event", entry.child.session, buildChildTurnEnd(entry, { turn, messageId }));
}

/**
 * 把 child 推到「宿主明确报告当前未运行」的状态。
 *
 * rc.2 校正：DSH rc.2 的 `Agent.status` 只有 `idle` / `running`（不存在 `ready`）；
 * `idle` 表示当前没有在执行。child **不** dispose，会话仍驻留，因此 durable listing 的
 * 行仍然是 `activity: "running"`——运行判定必须来自 exact `Agent.status`，而不是驻留标记。
 *
 * 为什么本组「work 账本精确性」用例必须先把静止证明固定下来：host/turn-wait 的放行条件是
 * 「没有未结算 work」**且**「宿主明确报告没有正在运行的后代」。child 仍 running 时第二个
 * 条件恒为假，任何 work 账本口径的错误（提前结算 / 错误消费）都不会改变 Promise 状态，
 * 因此在那个窗口里没有公开可观察结果（插件不暴露 handoff/cohort/等待账本的只读投影）。
 * 反过来，一旦静止证明成立，放行与否**只**由 work 账本决定——本组用例在断言窗口内不再改变
 * child 的任何状态，所以结论不可能来自 idle/fallback 或超时。
 */
function quiesceChild(host, entry) {
  host.setAgentStatus(entry.child, "idle");
}

test("真实 session/event spliced：唯一晚到 no-id 通知在 child turn 结束后释放 root", async () => {
  const childId = "123e4567-e89b-12d3-a456-426614174000";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "spliced host completion", ["docs/spliced-host.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");
  // 真实顺序：admission 后先结束 child turn；唯一通知只在 turn/end 之后到达。
  endChildTurn(host, children[0]);
  await flushAsyncWork(5);
  assert.equal(pending.status, "pending", "turn-end 只有结束 cohort，不能凭空结算 no-id 通知");
  host.emit("session/event", root.session, {
    seq: 9001,
    type: "agent/inbox/spliced",
    data: { target: "next-step", inserted: [{ content: [
      { type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." },
      { type: "text", text: "\nIts closing message: ignored" },
    ] }] },
  });
  await flushAsyncWork(12);
  assert.equal(pending.status, "pending", "完成通知不会覆盖 child 仍在运行的事实；必须等 idle 才能收口");
  // 通知已在 child 仍 running 时到达；若未结算对应 cohort，后续 idle 会成为无法区分的假阳性。
  // 因此先固定观察 pending，再推进唯一 child 的公开状态到 idle。
  // work 账本本身是否被这条通知结算，由紧随其后的「late 通知的直接断言」用例在
  // 「静止证明固定不变」的窗口里单独证明：那里 child 状态全程不变，放行只可能来自本次通知。
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(8);
  assert.equal(pending.status, "resolved", "唯一晚到 notice 到达并确认 child 静止后必须结算精确 cohort");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("spliced 自动完成身份保持 fail-closed：wrong child、用户消息和相似正文不释放", async () => {
  const childId = "123e4567-e89b-12d3-a456-426614174001";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "spliced identity gates", ["docs/spliced-gates.md"]);
  // 同正文但显式 user source 只表示用户输入，不得成为 child settlement；此时尚未建立 waiter。
  host.emit("session/event", root.session, {
    seq: 6999,
    type: "agent/inbox/spliced",
    data: { target: "next-step", inserted: [{
      content: [{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." }],
      source: { kind: "user" },
    }] },
  });
  await flushAsyncWork(5);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { content: [{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." }] },
  });
  await flushAsyncWork(5);
  endChildTurn(host, children[0]);
  await flushAsyncWork(5);
  const emit = (message, seq, source) => host.emit("session/event", root.session, {
    seq,
    type: "agent/inbox/spliced",
    data: { target: "next-step", inserted: [{ content: message, ...(source === undefined ? {} : { source }) }] },
  });
  emit([{ type: "text", text: "Background subagent 123e4567-e89b-12d3-a456-426614174099 finished and will do no further work unless you send it more." }], 7001);
  emit([{ type: "text", text: "Background subagent not-a-uuid finished and will do no further work unless you send it more." }], 7002);
  emit([{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." }]);
  emit([{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." }], Number.MAX_SAFE_INTEGER + 1);
  emit([{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more." }], 7003, { kind: "user" });
  emit([{ type: "text", text: "Background subagent " + childId + " finished and will do no further work unless you send it more" }], 7004);
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");
  assertNoGoalCalls(probe);
});

// ── 到达顺序与 work 账本精确性（Oracle 复现缺陷的回归）──────────────────────
//
// 本组用例全部走公开 Host fixture seam：真实 session/event 的 agent/inbox/spliced 通知、
// child session 的 turn/end、agent/status 与公开 finalize 工具。断言对象是唯一的外部结果
// （finalize Promise 的状态），并把「宿主明确报告无 running 后代」这一条件在断言窗口内
// 固定不变——因此任何放行都只能来自 work 账本口径的结算（见 quiesceChild 的说明）。

test("同批次 notice 先发布、turn/end 随后发布：不得消费未来终态证据", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "order notice-first", ["docs/order-notice-first.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "turn 尚未结束时静止证明不能放行任何 work");

  // 同一同步批次：先发布 source-less 完成通知，随后才发布 child turn/end。
  // 通知在接收顺序上早于终态事件，因此它证明不了那个 turn 已完成 → 必须拒绝。
  emitSplicedNotice(host, root, { childId, seq: 4101 });
  endChildTurn(host, children[0]);
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending",
    "notice 先于 turn/end 发布时不得消费该终态：它属于「未来证据」，消费会凭空结算 work");

  // 随后一条真正晚到的通知（新 seq，且终态早已到达）必须仍能精确结算本轮 work。
  // 这同时证明上一步的 pending 不是「管线被卡死」，而是精确边界。
  emitSplicedNotice(host, root, { childId, seq: 4102 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "晚到且终态更早的通知必须精确结算对应 work");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("同批次 turn/end 先发布、notice 随后发布：合法顺序必须由通知结算", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3305";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "order turn-end-first", ["docs/order-turn-end-first.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 同一同步批次：先发布 child turn/end，随后发布 source-less 完成通知。
  // turn/end 的接收顺序更早，因此这条通知必须结算（过紧的实现会让它永久悬挂）。
  endChildTurn(host, children[0]);
  emitSplicedNotice(host, root, { childId, seq: 4201 });
  await flushAsyncWork(24);
  assert.equal(pending.status, "resolved",
    "turn/end 先发布的同一批次里，随后到达的通知必须精确结算本轮 work");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("late 通知的直接断言：child 静止证明固定不变时，通知本身即结算 work 账本", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "late direct", ["docs/late-direct.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);

  // 静止证明先到位并稳定下来（此后 child 状态全程不变）。
  quiesceChild(host, children[0]);
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  // 终态事件先到、通知后到（真实线上的「晚到通知」形状）。
  endChildTurn(host, children[0]);
  await flushAsyncWork(12);
  assert.equal(pending.status, "pending",
    "turn/end 只有终态事实：在没有通知结算 work 时不得靠静默重查放行");

  emitSplicedNotice(host, root, { childId, seq: 4401 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved",
    "work 账本只能由这条 exact 通知结算；本断言窗口内 child 状态从未改变");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("结构化（带 message.id）通知仍按既有语义结算 work 账本：直接断言", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "structured direct", ["docs/structured-direct.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);
  endChildTurn(host, children[0]);
  await flushAsyncWork(12);
  assert.equal(pending.status, "pending");

  // 结构化通知（subagent-settled + 稳定 message.id）走既有兼容路径：它必须独立结算 work。
  insertNotice(host, root, children[0], "fb-structured-direct");
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "结构化通知的结算语义不得被 source-less 修复改变");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("同一 child/activation：notice 只标记真正结束的 admission，未结束者随后结束也不得被结算", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
  const probe = createGoalProbe();
  const { host, root, children, steered } = createWaitHost({
    goalProbe: probe,
    childIdFactory: () => childId,
    steerSeam: true,
  });
  const first = await startAdmission(host, root, "A still running turn", ["docs/a-still-running.md"]);
  assert.equal(first.kind, "continuable");
  // 显式续作：把第二个 admission 放到**同一个 child/activation** 上（不新建 child）。
  const second = await startAdmission(host, root, "B finished turn", ["docs/b-finished.md"], {
    childId,
    queue: true,
  });
  assert.equal(second.kind, "continuable");
  assert.equal(second.subagentId, childId, "显式续作必须投递给同一个 child");
  assert.equal(steered.length, 1, "续作必须经公开 sendMessage seam 投递");
  assert.equal(children.length, 1, "续作不得新建 child");
  assert.notEqual(second.messageId, first.messageId, "两个 admission 各自持有自己的 messageId");

  const pending = track(finalizeLifecycle(host, root, [first, second]));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // B（第二个 admission）所在 turn 先结束；A 所在 turn 仍未结束。
  endChildTurnForMessage(host, children[0], { turn: 2, messageId: second.messageId });
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  // 唯一的通知只证明「B 所在 turn 已完成」：它绝不能顺带把 A 也标成已反馈。
  emitSplicedNotice(host, root, { childId, seq: 4301 });
  await flushAsyncWork(14);
  assert.equal(pending.status, "pending", "A 仍未结束：通知不得结算 A 的 work");

  // A 所在 turn 随后结束，但没有任何新通知：A 必须保持「未收到反馈」。
  endChildTurnForMessage(host, children[0], { turn: 1, messageId: first.messageId });
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending",
    "A 结束后没有新通知时不得凭错误镜像标记提前结算 A 的 work");

  // 新的合法通知（新 seq、且 A 的终态接收顺序更早）仍然可以精确结算 A。
  emitSplicedNotice(host, root, { childId, seq: 4302 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("跨轮同 seq 重放不得消费未来 entry，新 seq 的下一轮通知仍可结算", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3306";
  const probe = createGoalProbe();
  const { host, root, children, steered } = createWaitHost({
    goalProbe: probe,
    childIdFactory: () => childId,
    steerSeam: true,
  });
  const first = await startAdmission(host, root, "round one", ["docs/round-one.md"]);
  const second = await startAdmission(host, root, "round two", ["docs/round-two.md"], { childId, queue: true });
  assert.equal(steered.length, 1);
  const pending = track(finalizeLifecycle(host, root, [first, second]));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 第一轮：turn 2 结束 + 唯一通知（seq 4501）精确结算第二个 admission。
  endChildTurnForMessage(host, children[0], { turn: 2, messageId: second.messageId });
  await flushAsyncWork(10);
  emitSplicedNotice(host, root, { childId, seq: 4501 });
  await flushAsyncWork(14);
  assert.equal(pending.status, "pending", "第一轮的 work 已结算，但第二轮的 work 仍未结算");

  // 第二轮：turn 1 结束；随后重放**同一条 delivery**（同 seq）。它没有新的 delivery 身份，
  // 绝不能消费这一轮的 entry。
  endChildTurnForMessage(host, children[0], { turn: 1, messageId: first.messageId });
  await flushAsyncWork(12);
  emitSplicedNotice(host, root, { childId, seq: 4501 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "同 seq 重放不得消费未来 entry（delivery 身份只用于去重）");

  // 真正的新一轮通知（新 seq）仍然可以结算。
  emitSplicedNotice(host, root, { childId, seq: 4502 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("身份账本饱和后的 early source-less 通知：不得排队，也不得在未来 turn/end 被消费", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "saturation probe", ["docs/saturation.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 用 4096 条互不相同的 delivery 身份灌满该 child 的身份账本（FEEDBACK_DELIVERY_LIMIT）。
  // 这些通知都在 child turn 结束之前到达，因此不会消费任何 work，也不建立 marker。
  for (let index = 0; index < 4096; index += 1) emitSplicedNotice(host, root, { childId, seq: 5000 + index });
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "turn 未结束时任何 early 通知都不得结算 work");

  // 账本饱和后的下一条 early source-less 通知没有任何可证明的身份：必须直接拒绝，
  // 绝不能退化成 generic 无身份队列（那会在随后的 turn/end 消费未来 entry）。
  emitSplicedNotice(host, root, { childId, seq: 90000 });
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  endChildTurn(host, children[0]);
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending",
    "饱和后的 source-less 通知不得在未来 turn/end 被消费：那会凭空结算 work 并提前放行");
  assertNoGoalCalls(probe);
});

test("同一终态 event 对象重投递：保留首次 receipt，合法通知仍精确结算", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3311";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "redelivered terminal", ["docs/redelivered-terminal.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 同一同步批次、无任何异步间隔：终态 event E → 合法 source-less 通知 → 重投递同一个 E。
  // 重投递不是新终态，绝不能把 receipt 推到通知之后；否则这条身份已被 claim 的合法通知
  // 会被永久拒绝，且没有新事件能救回 → finalize 挂住。
  const terminal = buildChildTurnEnd(children[0], { turn: 1, messageId: children[0].messageId });
  host.emit("session/event", children[0].child.session, terminal);
  emitSplicedNotice(host, root, { childId, seq: 4601 });
  host.emit("session/event", children[0].child.session, terminal);
  await flushAsyncWork(24);
  assert.equal(pending.status, "resolved",
    "同一终态 event 重投递必须保留首次 receipt：晚于通知的序号是重投递，不是新终态证据");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("同一终态以同一 event.seq 重投递（新对象）：按同一终态保留首次 receipt", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3314";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "seq identity terminal", ["docs/seq-identity-terminal.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 既有 session/event 契约里 seq 是同一 Session 内单调的投递身份：宿主重放同一事件时
  // 可能重新构造对象但保留 seq。这种形状与「同一个 event 对象」等价，仍属同一终态。
  buildChildTurnEnd(children[0], { turn: 1, messageId: children[0].messageId });
  host.emit("session/event", children[0].child.session, {
    seq: 7001,
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });
  emitSplicedNotice(host, root, { childId, seq: 4901 });
  host.emit("session/event", children[0].child.session, {
    seq: 7001,
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });
  await flushAsyncWork(24);
  assert.equal(pending.status, "resolved",
    "同一 seq 的新对象是同一终态：必须保留首次 receipt，合法通知仍要精确结算");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("新终态不得借最早 receipt 消费：不同 event 对象（同一 turn）必须重置", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3312";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "new terminal identity", ["docs/new-terminal-identity.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 同一批次：终态 event E1 → 通知 → **另一个**终态 event 对象（同一 turn）。
  // 不同事件身份属于新终态证据，必须重置 receipt：E1 之前/之间的通知无权消费它。
  const first = buildChildTurnEnd(children[0], { turn: 1, messageId: children[0].messageId });
  host.emit("session/event", children[0].child.session, first);
  emitSplicedNotice(host, root, { childId, seq: 4701 });
  host.emit("session/event", children[0].child.session, {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending",
    "新 event 身份是新的终态证据：不得借用最早 receipt 让早于它的通知消费");

  // 真正晚到的新通知仍可精确结算（管线没有被卡死）。
  emitSplicedNotice(host, root, { childId, seq: 4702 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("新终态不得借最早 receipt 消费：同一 entry 的新 turn 必须重置", async () => {
  const childId = "3f2504e0-4f89-41d3-9a0c-0305e82c3313";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, childIdFactory: () => childId });
  const outcome = await startAdmission(host, root, "new turn terminal", ["docs/new-turn-terminal.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  quiesceChild(host, children[0]);
  await flushAsyncWork(8);

  // 同一 entry 先后承载两个 turn 的终态：通知夹在中间。
  // 新 turn 是**新终态**，绝不能沿用最早 receipt（那会让未来通知错配到更晚的终态）。
  // 同一同步批次内两个不同 turn 的终态：事件日志必须同时包含两个 turn 的段落
  // （真实 Host 的日志是单调追加的，microtask 延迟处理时仍能看到各个 turn 自己的输出）。
  const turns = [{ turn: 1, messageId: children[0].messageId }, { turn: 2, messageId: children[0].messageId }];
  host.emit("session/event", children[0].child.session, buildChildMultiTurnEnd(children[0], { turns, turn: 1 }));
  emitSplicedNotice(host, root, { childId, seq: 4801 });
  host.emit("session/event", children[0].child.session, buildChildMultiTurnEnd(children[0], { turns, turn: 2 }));
  await flushAsyncWork(24);
  assert.equal(pending.status, "pending",
    "同一 entry 的新 turn 必须重置 receipt：不得对同 entry 跨 turn 取全局最早序号");

  emitSplicedNotice(host, root, { childId, seq: 4802 });
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

// ── 1. 等待不超时且保持 Promise pending ─────────────────────────────────────

test("等待保持 pending：child 仍在运行时 finalize 的 Promise 永不超时收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));

  // 推进大量宏任务/微任务轮次：等待不得因为任何计时/轮询而自行收口。
  await flushAsyncWork(40);
  assert.equal(pending.status, "pending", "child 仍在运行时等待必须保持 pending（无超时）");

  // 真实完成：turn 结束 + child 停止 + 精确通知。
  endChildTurn(host, children[0]);
  // rc.2：Agent.status 只有 idle/running；idle 表示当前未运行（不再用 ready）。
  host.setAgentStatus(children[0].child, "idle");
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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
    rootChildren: null,
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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

test("后代快照瞬时失败后：没有新事件也必须退避重查并释放", async () => {
  let calls = 0;
  const root = { id: "retry-root" };
  const registry = createRootTurnWaitRegistry({
    isLiveRoot: () => true,
    subscribe: () => () => {},
    snapshotDescendants: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient listing failure");
      return { known: true, running: [], runningIds: new Set() };
    },
  });

  // 本用例没有 outstanding work，等待只验证快照失败后的退避复查。
  const pending = track(registry.wait(root));
  await waitUntil(() => pending.status === "resolved");
  await flushAsyncWork(8);

  assert.ok(calls >= 2, "瞬时查询失败后必须在没有新事件时自动重查");
  assert.equal(pending.status, "resolved");
  assert.deepEqual(pending.value, { released: true, reason: "quiescent" });
  registry.dispose();
});

test("child 静默结束后：已结算工作不能因缺少 agent/status 事件永久等待", async () => {
  let childRunning = true;
  const root = { id: "silent-child-root" };
  const registry = createRootTurnWaitRegistry({
    isLiveRoot: () => true,
    subscribe: () => () => {},
    snapshotDescendants: async () => {
      const running = childRunning ? [{ id: "silent-child" }] : [];
      return { known: true, running, runningIds: new Set(running.map((child) => child.id)) };
    },
  });
  const work = { kind: "admission", token: "silent-child-work" };

  registry.track(root, work);
  const pending = track(registry.wait(root));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  // 精确完成通知已经结算工作，但宿主暂时仍报告 child running。
  assert.equal(registry.settle(root, work), true);
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  // 模拟 durable child 进入 ready，但宿主没有发出 agent/status/disposed 事件。
  childRunning = false;
  await waitUntil(() => pending.status === "resolved");
  await flushAsyncWork(8);

  assert.equal(pending.status, "resolved", "没有状态事件也必须通过后代快照重查发现 child 已结束");
  assert.deepEqual(pending.value, { released: true, reason: "quiescent" });
  registry.dispose();
});

test("后代 seam 缺失（无 listing、无 provider）时必须继续等待：无 provider ≠ 明确空", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    sessionActivity: "missing",
    descendantListing: "missing",
    rootChildren: null,
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  // 权威 seam 明确回答：catalog 里该 child 仍然驻留（activity=running），
  // 但 exact Agent.status=idle ⇒ rc.2 判「当前未运行」⇒ 允许放行。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-empty");
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "驻留行 + Agent.status=idle 必须放行");
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
 * listing 不是公开契约的形状（伪造 / 截断 / 跨版本错配）。
 *
 * rc.2 补充：契约行成立之后，`activity` 只表达 **session residency**（驻留的 idle child
 * 仍报 `running`），它**永远不能**单独证明静止；运行判定必须由 exact `Agent.status`
 * 交叉校验。因此合同不成立、缺少 exact live Agent、状态非法（含 ready）、重复 id、
 * 血缘或 parentId/depth 冲突、runtime 快照不可用时，整次结果都按 unknown 处理。
 */
test("权威 listing 的驻留行 + exact Agent.status=idle 才证明静止（行形状符合公开 contract）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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

  // child 真正结束：行仍然是合法的驻留行（activity=running），静止证据来自 exact Agent.status。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-legal-inactive");
  await flushAsyncWork(20);
  assert.equal(pending.status, "resolved", "Agent.status=idle 由 rc.2 判「当前未运行」，必须放行");
  assert.equal(
    host.listHarnessDescendants(root.id)[0].activity,
    "running",
    "会话仍驻留：activity 恒为 running，放行只能来自 Agent.status",
  );
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("权威 listing 的 child 行缺少 mode 时整次 listing 不可信（等待继续 pending）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    // 显式删掉 mode：行的其余字段都合法（且 exact Agent 已 idle），但缺了判别字段的
    // listing 不是公开契约的形状，整次结果必须按 unknown 处理。
    descendantRowTransform: (row) => {
      const { mode, ...rest } = row;
      return rest;
    },
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-mode-missing");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "pending",
    "mode 缺失的 child 行不是合法契约行：整次 listing 视为 unknown，不得据此放行",
  );
  assertNoGoalCalls(probe);
});

test("权威 listing 的 child 行 mode 非法时整次 listing 不可信（等待继续 pending）", async () => {
  // "unknown" 是真实 catalog 的第三个取值（listing 必须把它转成 diagnostic 行），
  // "paused" 是任意无关字符串，"" 是空值：三者都不是公开契约的 mode 枚举。
  for (const illegalMode of ["unknown", "paused", ""]) {
    const probe = createGoalProbe();
    const { host, root, children } = createWaitHost({
      goalProbe: probe,
      descendantRowTransform: (row) => ({ ...row, mode: illegalMode }),
    });
    const outcome = await startAdmission(host, root);
    const pending = track(finalizeLifecycle(host, root, outcome));
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
    const pending = track(finalizeLifecycle(host, root, outcome));
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
    // 同时没有 agents.list()：否则 runtime fallback 会先给出明确结论，这条 seam 根本不会被走到。
    rootChildren: null,
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
    rootChildren: null,
  });
  const stopListener = registerFreshEmptyActivityListener(host);
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
    rootChildren: null,
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
    rootChildren: null,
  });
  const stopListener = host.context.on("workspace/session-activity", () => [{ kind: "subagent", items: "not-an-array" }]);
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(8);
  assert.equal(pending.status, "pending", "child 仍在运行时不得释放");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-wins");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "resolved",
    "权威 listing + 同一份 exact runtime snapshot 是唯一可证明的静止来源",
  );
  assert.equal(pending.value.kind, "finalized");
  stopListener();
  assertNoGoalCalls(probe);
});

test("listing 报出不可读分支（diagnostic）时继续等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, descendantListing: "diagnostic" });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-throw");
  await flushAsyncWork(20);
  assert.equal(pending.status, "pending", "listing 失败必须按 unknown 处理");
  assertNoGoalCalls(probe);
});

test("等待异常日志只记固定前缀与错误名：不得输出异常 message 原文", async () => {
  /**
   * 等待路径的异常可能来自宿主 provider、会话读取器甚至文件系统：message 里可能夹带
   * 凭据、绝对路径或会话正文。日志只允许回答"哪一步失败 + 错误类型"，因此这里用一个
   * 明显可识别的敏感 message 驱动真实失败路径，断言 logger 输出不含原文。
   */
  const SENSITIVE_MESSAGE = "token=SECRET-DO-NOT-LOG path=C:/secret/session.json prompt=internal task body";
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    descendantListingImplementation: async () => {
      throw new Error(SENSITIVE_MESSAGE);
    },
  });
  const outcome = await startAdmission(host, root);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(8);

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-listing-sensitive");
  await flushAsyncWork(20);
  // 日志修复不得改变等待语义：查询失败仍然是 unknown（继续等待）。
  assert.equal(pending.status, "pending", "listing 失败必须按 unknown 处理");

  const warnings = host.warnings
    .filter((entry) => entry.kind === "logger-warn")
    .map((entry) => String(entry.message));
  const listingWarnings = warnings.filter((message) => message.includes("root turn wait descendant-listing failed"));
  assert.ok(listingWarnings.length > 0, "等待路径仍必须留下固定前缀的诊断（不是静默吞错）");
  for (const message of listingWarnings) {
    // 只允许「固定前缀 + 错误名」：Error 是异常构造器名，不含任何 message 片段。
    assert.match(message, /root turn wait descendant-listing failed: Error$/);
    assert.equal(message.includes("SECRET-DO-NOT-LOG"), false, "日志不得输出异常 message 里的敏感片段");
    assert.equal(message.includes("/secret/session.json"), false, "日志不得输出异常 message 里的路径");
    assert.equal(message.includes("internal task body"), false, "日志不得输出异常 message 里的正文");
  }
  assert.equal(
    warnings.some((message) => message.includes(SENSITIVE_MESSAGE)),
    false,
    "任何等待告警都不得携带异常 message 原文",
  );
  assertNoGoalCalls(probe);
});

test("能力诊断：权威 listing 缺失但有可调用的 agents.list() 仍降级，三者全缺才 unavailable", async () => {
  const probe = createGoalProbe();
  // 只有 waterfall（listing 与 agents.list() 都没有）：不能只凭「ctx.waterfall 是函数」就报
  // available——那只能证明 Cordis 事件服务在，不能证明有任何 provider 能给出可证明的静止结论。
  const degraded = createWaitHost({ goalProbe: probe, descendantListing: "missing", rootChildren: null });
  const degradedMeta = await degraded.host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(degradedMeta.value.capabilities.host.rootTurnWait.status, "degraded");
  assert.equal(
    degradedMeta.value.capabilities.host.rootTurnWait.degradation,
    "root-turn-wait-descendant-listing-unavailable",
  );

  // strict runtime-only fallback（listing 缺、agents.list() 可调用、waterfall 也缺）：仍然能给出
  // 可证明的状态 ⇒ degraded + 同一个 listing-unavailable reason，绝不是 unavailable。
  const runtimeOnly = createWaitHost({
    goalProbe: probe,
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
    rootChildren: "live",
  });
  const runtimeOnlyMeta = await runtimeOnly.host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(runtimeOnlyMeta.value.capabilities.host.rootTurnWait.status, "degraded");
  assert.equal(
    runtimeOnlyMeta.value.capabilities.host.rootTurnWait.degradation,
    "root-turn-wait-descendant-listing-unavailable",
  );

  // listing、agents.list() 与 Cordis 事件服务都没有：unavailable。
  const unavailable = createWaitHost({
    goalProbe: probe,
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
    rootChildren: null,
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

test("rc.2：runtime 快照里当前 root 自带字符串 parentSession（root→child→root 环）时必须 fail-closed", async () => {
  // snapshotRootTurnDescendants() 的 rootId 优先级**不能**绕过 root 自身的身份校验：
  // 若快照里的当前 root 声称自己有父会话，就只能继续等待（绝不因 lineage 捷径放行）。
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    // 用一份「自称有父会话」的 root 副本替换快照里的 root。
    rootChildren: () => {
      const live = host.agents.roots();
      const [first, ...rest] = live;
      const cyclic = {
        id: first.id,
        status: "idle",
        session: { header: { ...first.session.header, parentSession: children[0].childId } },
      };
      return [cyclic, ...rest];
    },
  });
  const outcome = await startAdmission(host, root, "cyclic root probe", ["docs/rc2-cyclic-root.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  // 本树 child 已结算、catalog 仍是合法驻留行：仍必须等待（root 身份不可解释）。
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-rc2-cyclic-root");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "pending",
    "root 自身的 parentSession 不可解释时必须 fail-closed",
  );
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

  const pending = track(finalizeLifecycle(host, root, [first, second]));
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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

test("root dispose 取消等待：批次保持未收口、不投递结论，且监听不泄漏", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  // finalize 只登记：等待发生在 root turn 的 serial 边界。
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting");
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(8);
  const listenersBefore = host.listenerCount("agent/turn-stopping");
  host.disposeAgent(root);
  await flushAsyncWork(12);

  // 取消（root 退休）不是专家完成：不投递终态结论，批次也不被标记为 finalized。
  assert.deepEqual(host.agentSteerMessages(root), [], "root 退休后旧代际绝不投递收口结论");
  assert.equal(children[0].child.status, "running", "取消等待不得改变专家任务本身的运行事实");
  // 插件级监听器属于插件 fiber，root dispose 不卸载它；这里断言它仍被正确注册（不泄漏额外监听）。
  assert.equal(host.listenerCount("agent/turn-stopping"), listenersBefore);
  await stop.settled;
  assertNoGoalCalls(probe);
});

test("插件卸载：等待被取消、不投递结论，且不留下悬空 Promise", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting");
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(8);

  await host.dispose();
  await stop.settled;
  assert.deepEqual(host.agentSteerMessages(root), [], "卸载期间不得由旧 root 投递收口结论");
  assertNoGoalCalls(probe);
});

test("代际替换：旧 root 的等待被取消且不投递，新 root 拥有独立等待", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting");
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(8);

  // 同 id 的新代际：旧 root 先 dispose，再登记同 id 的新 root。
  host.disposeAgent(root);
  const replacement = host.registerRootAgent(ROOT_ID);
  await stop.settled;
  await flushAsyncWork(12);
  assert.deepEqual(host.agentSteerMessages(root), [], "旧代际绝不投递收口结论");

  // 旧代际的迟到 notice / 状态变化不得影响新 root（新 root 没有等待）。
  insertNotice(host, root, children[0], "fb-late-generation");
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(12);
  assert.deepEqual(host.agentSteerMessages(root), [], "旧代际结论不得被迟到事件改写");
  assert.deepEqual(host.agentSteerMessages(replacement), [], "新代际不得继承旧批次的收口结论");
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
  const pending = track(finalizeLifecycle(host, root, outcome));
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

// ── 10a. rc.2：durable listing 的 session residency 与 Agent.status 交叉校验 ────────
//
// rc.2 事实（本次校正）：`Agent.status` 只有 `idle` / `running`；
// `subagents.listDescendants.activity` 表示 **session residency** —— 一个 idle 的 durable
// continuable child 仍可能被列为 `activity: "running"`。因此运行判定**只**认同一份 exact
// runtime 快照里的 `Agent.status`：running 继续阻塞，idle 判当前未运行。
// 下列情况一律未知（继续等待，绝不提前放行）：缺少 exact live Agent、状态非法（含 ready）、
// 重复 id、runtime/catalog 血缘或 parentId/depth 冲突、runtime 快照查询失败、
// listing/runtime 对 live 后代互相矛盾（遗漏或标成 inactive）。

test("rc.2：listing 报驻留 activity=running 时，只有 exact Agent.status=idle 才放行 root", async () => {
  const probe = createGoalProbe();
  // 显式要求完整 agents.list() 快照（root + child）：本用例必须真的走 exact runtime 路径。
  const { host, root, children } = createWaitHost({ goalProbe: probe, rootChildren: "live" });
  const outcome = await startAdmission(host, root, "aborted child probe", ["docs/rc2-aborted-child.md"]);
  assert.equal(outcome.kind, "continuable");
  const child = children[0];
  assert.equal(host.listHarnessDescendants(root.id)[0].activity, "running", "驻留 child 必须报 activity=running");
  assert.equal(typeof host.agents.list, "function", "本用例必须提供完整 agents.list() 快照");
  const liveSnapshot = host.agents.list();
  assert.ok(liveSnapshot.some((agent) => agent.id === root.id), "runtime 快照必须包含 root");
  assert.ok(liveSnapshot.some((agent) => agent.id === child.childId), "runtime 快照必须包含 exact child");

  // 父级取消：turn/end 的 reason 是结构化 {kind:"aborted", reason:{kind:"parent"}}。
  host.emit("session/event", child.child.session, buildChildTurnEnd(child, {
    turn: 1,
    messageId: child.messageId,
    reason: { kind: "aborted", reason: { kind: "parent" } },
  }));
  // root 收到真实形状的 spliced settled 通知（structured source），随后再经过 turn-stopping 兜底。
  host.emit("session/event", root.session, {
    seq: 6101,
    type: "agent/inbox/spliced",
    data: {
      target: "next-step",
      inserted: [{
        content: [{ type: "text", text: "child settled" }],
        source: { kind: "subagent-settled", senderSessionId: child.childId },
      }],
    },
  });
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1, "turn-stopping 兜底必须参与等待");
  let settled = false;
  stop.settled.then(() => { settled = true; });

  // Agent 仍 running：精确结算通知已经到达也绝不放行。
  await flushAsyncWork(30);
  assert.equal(settled, false, "Agent.status=running 时必须保持 root turn 打开");
  assert.equal(host.listHarnessDescendants(root.id)[0].activity, "running", "驻留行始终是 activity=running");

  // 只把 exact Agent.status 变成 idle（child 不 dispose、会话仍驻留）⇒ 必须放行。
  host.setAgentStatus(child.child, "idle");
  await flushAsyncWork(30);
  assert.equal(settled, true, "exact Agent.status=idle 是 rc.2 的「当前未运行」证据，必须放行");
  assert.equal(
    host.listHarnessDescendants(root.id)[0].activity,
    "running",
    "会话仍驻留：activity 仍报 running，放行只能来自 Agent.status",
  );
  assertNoGoalCalls(probe);
});

test("rc.2：listing 存在但没有完整 agents.list() 快照时绝不放行（fail-closed）", async () => {
  // 同一 lifecycle 形状（aborted/parent turn/end + spliced settled + turn-stopping），但宿主没有
  // agents.list()：catalog 只能说明 residency，无法验证 status 与「live 后代是否被完整覆盖」，
  // 因此即使 work 已被精确结算、Agent 已 idle，也必须继续等待。
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe, rootChildren: null });
  assert.equal(host.agents.list, undefined, "本用例必须没有 agents.list() seam");
  const outcome = await startAdmission(host, root, "missing runtime snapshot", ["docs/rc2-missing-runtime.md"]);
  const child = children[0];

  host.emit("session/event", child.child.session, buildChildTurnEnd(child, {
    turn: 1,
    messageId: child.messageId,
    reason: { kind: "aborted", reason: { kind: "parent" } },
  }));
  host.emit("session/event", root.session, {
    seq: 6201,
    type: "agent/inbox/spliced",
    data: {
      target: "next-step",
      inserted: [{
        content: [{ type: "text", text: "child settled" }],
        source: { kind: "subagent-settled", senderSessionId: child.childId },
      }],
    },
  });
  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1, "turn-stopping 兜底必须参与等待");
  let settled = false;
  stop.settled.then(() => { settled = true; });

  await flushAsyncWork(30);
  assert.equal(settled, false, "没有 runtime 快照时不得放行");
  host.setAgentStatus(child.child, "idle");
  await flushAsyncWork(30);
  assert.equal(
    settled,
    false,
    "缺少完整 agents.list() 时无法验证运行判定与覆盖关系：必须 fail-closed（继续等待）",
  );
  assert.equal(host.listHarnessDescendants(root.id)[0].activity, "running", "catalog 仍报驻留：不能据此放行");
  assertNoGoalCalls(probe);
});
test("rc.2：agents.list() 里的其他 root（origin:\"user\"）及其 running 后代不得阻塞当前 root", async () => {
  // Oracle 场景的集成保护：同一份 agents.list() 快照里混入另一个**显式** origin:"user" 的
  // 顶层会话与它的 running subagent child。foreign 祖先可证明该支不属于当前 root，因此当前
  // root 的等待必须能正常收口（而不是永久 unknown）。
  const probe = createGoalProbe();
  const foreignRoot = {
    id: "foreign-root",
    status: "running",
    session: { header: { id: "foreign-root", parentSession: void 0, origin: "user" } },
  };
  const foreignChild = {
    id: "foreign-child",
    status: "running",
    session: { header: { id: "foreign-child", parentSession: "foreign-root", origin: "subagent" } },
  };
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    rootChildren: () => [...host.agents.roots(), foreignRoot, foreignChild],
  });
  const outcome = await startAdmission(host, root, "foreign root probe", ["docs/rc2-foreign-root.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending", "本树 child 仍在运行：必须继续等待");
  assert.ok(
    host.agents.list().some((agent) => agent.id === "foreign-child"),
    "runtime 快照必须确实包含 foreign 会话的后代",
  );

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-rc2-foreign-root");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "resolved",
    "别家 root 的 running 后代不得让当前 root 永久 fail-closed",
  );
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});
test("rc.2：真正 running 的长任务持续等待，驻留行不得当作静止证据", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "long running probe", ["docs/rc2-long-running.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));

  for (let round = 0; round < 3; round += 1) {
    await flushAsyncWork(20);
    assert.equal(pending.status, "pending", "Agent 真正 running 时必须持续等待（第 " + (round + 1) + " 轮）");
    assert.equal(host.listHarnessDescendants(root.id)[0].activity, "running");
  }

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-rc2-long-running");
  await flushAsyncWork(24);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("rc.2 交叉校验：listing/runtime 缺失、冲突或非法状态时一律 fail-closed", async () => {
  // 每个场景都让 exact Agent 处于「当前未运行」（idle 或已 dispose），因此**只有**交叉校验
  // 本身能解释「继续等待」——若放宽任一规则，这些场景都会提前放行。
  const ghostRow = { id: "durable-ghost", parentId: ROOT_ID, depth: 1, mode: "continuable", label: "explorer", hasChildren: false };
  const scenarios = [
    {
      name: "listing 遗漏仍 live 的后代",
      options: { rootChildren: "live", descendantRowTransform: () => undefined },
      expected: "pending",
      why: "runtime live 后代没有被 catalog 覆盖 ⇒ 覆盖关系无法证明",
    },
    {
      name: "仍 live 的后代被标成 activity=inactive",
      options: { rootChildren: "live", descendantRowTransform: (row) => ({ ...row, activity: "inactive" }) },
      expected: "pending",
      why: "activity 是 residency：live Agent 与 inactive 行互相矛盾",
    },
    {
      name: "listing 存在但没有完整 agents.list() 快照",
      options: { rootChildren: null },
      expected: "pending",
      why: "没有完整 runtime 快照 ⇒ 无法验证运行判定与覆盖关系，必须 fail-closed",
    },
    {
      name: "catalog 出现重复 id（live 行 + durable 行同 id）",
      options: { durableNonResidentRows: (childrenState) => (childrenState.length === 0 ? [] : [{ ...ghostRow, id: childrenState[0].childId }]) },
      expected: "pending",
      why: "重复 id 无法区分代际",
    },
    {
      name: "Agent.status 非法（rc.2 只有 idle/running）",
      options: {},
      status: "ready",
      expected: "pending",
      why: "显式非法状态不得当成空闲",
    },
    {
      name: "catalog parentId/depth 冲突",
      options: { descendantRowTransform: (row) => ({ ...row, depth: row.depth + 2 }) },
      expected: "pending",
      why: "catalog 深度链自相矛盾",
    },
    {
      name: "runtime 列表查询失败",
      options: { rootChildren: () => { throw new Error("runtime agent listing down"); } },
      expected: "pending",
      why: "查询失败是未知，不是「没有 running 后代」",
    },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const probe = createGoalProbe();
    const held = [];
    const options = { ...scenario.options };
    if (typeof options.durableNonResidentRows === "function") {
      const readChildren = options.durableNonResidentRows;
      options.durableNonResidentRows = () => readChildren(held);
    }
    const { host, root, children } = createWaitHost({ goalProbe: probe, ...options });
    const outcome = await startAdmission(host, root, scenario.name, ["docs/rc2-closed-" + index + ".md"]);
    const pending = track(finalizeLifecycle(host, root, outcome));
    await flushAsyncWork(10);
    assert.equal(pending.status, "pending", scenario.name + "：登记后必须仍在等待");
    held.push(...children);

    endChildTurn(host, children[0]);
    if (scenario.status !== undefined) host.setAgentStatus(children[0].child, scenario.status);
    else host.setAgentStatus(children[0].child, "idle");
    insertNotice(host, root, children[0], "fb-rc2-closed-" + index);
    await flushAsyncWork(24);
    assert.equal(
      pending.status,
      scenario.expected,
      scenario.name + "：" + scenario.why,
    );
    assertNoGoalCalls(probe);
  }
});

test("rc.2：合法 durable 非驻留行（activity=inactive 且没有 exact live Agent）不阻塞放行", async () => {
  // 上游实现把 activity 定义为 session residency：`sessions.get(entry.id) === undefined` 的行
  // 是**合法**的 durable 历史行（会话不驻留 ⇒ 不可能在执行），必须被接受为「不运行」，
  // 而不是让整份 catalog 变成未知。
  const probe = createGoalProbe();
  const ghostRow = { id: "durable-historical", parentId: ROOT_ID, depth: 1, mode: "continuable", label: "explorer", hasChildren: false };
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    rootChildren: "live",
    durableNonResidentRows: () => [ghostRow],
  });
  const outcome = await startAdmission(host, root, "historical durable row", ["docs/rc2-historical.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending", "child 仍在运行：必须继续等待");

  endChildTurn(host, children[0]);
  // child 被回收：catalog 只剩 durable 非驻留历史行，runtime 已没有该 child。
  host.disposeAgent(children[0].child);
  insertNotice(host, root, children[0], "fb-rc2-historical");
  await flushAsyncWork(24);
  assert.equal(
    pending.status,
    "resolved",
    "durable 非驻留行（无 exact live Agent）是合法历史行：它不得阻塞 work 已结算的 root turn",
  );
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("rc.2：listing 不可用时 runtime fallback 严格区分 idle/running（ready 视为未知）", async () => {
  const expectations = [
    { status: "idle", expected: "resolved", why: "idle 判当前未运行" },
    { status: "running", expected: "pending", why: "真正 running 必须继续等待" },
    { status: "ready", expected: "pending", why: "rc.2 不存在 ready：非法状态一律未知" },
  ];

  for (const [index, item] of expectations.entries()) {
    const probe = createGoalProbe();
    const { host, root, children } = createWaitHost({
      goalProbe: probe,
      descendantListing: "missing",
      sessionActivity: "missing",
      sessionActivityTransport: false,
      rootChildren: "live",
    });
    const outcome = await startAdmission(host, root, "runtime fallback " + item.status, ["docs/rc2-runtime-" + index + ".md"]);
    const pending = track(finalizeLifecycle(host, root, outcome));
    await flushAsyncWork(10);

    endChildTurn(host, children[0]);
    host.setAgentStatus(children[0].child, item.status);
    insertNotice(host, root, children[0], "fb-rc2-runtime-" + index);
    await flushAsyncWork(24);
    assert.equal(pending.status, item.expected, "Agent.status=" + item.status + "：" + item.why);
    assertNoGoalCalls(probe);
  }
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

test("AbortSignal：finalize 不再用 exec.signal 等待；payload.signal 只取消本次 turn 的 waiter", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "abort wait probe", ["docs/wait-abort.md"]);

  // ① 预先取消的 exec.signal 不再影响 finalize：工具只做校验与登记，立即返回 waiting。
  //    这正是本契约要切断的耦合——run_code 子执行结束不得取消 root turn 生命周期等待。
  const finalizeController = new AbortController();
  finalizeController.abort();
  const abortedReceipt = await finalize(host, root, outcome, finalizeController.signal);
  assert.equal(abortedReceipt.kind, "waiting", "finalize 不在工具调用内等待，exec.signal 与等待无关");
  assert.equal(abortedReceipt.reason, "experts-running");

  // ② 本 turn 的 turn-stopping 等待仍观察到运行中的专家；payload.signal 取消只结束本次 waiter。
  const stopController = new AbortController();
  const stop = stopRootTurn(host, root, 1, stopController.signal);
  let stopSettled = false;
  stop.settled.then(() => { stopSettled = true; });
  await flushAsyncWork(10);
  assert.equal(stopSettled, false, "stop 等待必须仍观察到原 admission 和 running child");
  stopController.abort();
  await flushAsyncWork(10);
  assert.equal(stopSettled, true, "turn-stopping 应将 payload.signal 传给该 waiter");
  assert.deepEqual(host.agentSteerMessages(root), [], "被取消的 waiter 绝不投递终态结论");
  // 取消不关闭批次：同一凭据仍是稳定 waiting，不重复登记。
  const retryFinalize = await finalize(host, root, outcome);
  assert.equal(retryFinalize.kind, "waiting");

  // ③ 后续 root turn 接续同一批工作：只有 child 真正静止后才一次性收口。
  const retryStop = stopRootTurn(host, root, 2);
  let retrySettled = false;
  retryStop.settled.then(() => { retrySettled = true; });
  await flushAsyncWork(10);
  assert.equal(retrySettled, false, "取消的 waiter 不得清除 admission 或伪造静止");

  endChildTurn(host, children[0]);
  insertNotice(host, root, children[0], "fb-abort-retained-work");
  await flushAsyncWork(10);
  assert.equal(retrySettled, false, "turn/end 与反馈结算后，child 仍报告 running 时必须继续等待");

  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(20);
  assert.equal(retrySettled, true, "真实 child turn/end + feedback settlement 后静止才让新 waiter 收口");
  const delivered = host.agentSteerMessages(root);
  assert.equal(delivered.length, 1, "静止后必须一次性投递终态结论");
  assert.equal(delivered[0].source.kind, "plugin:dsh-expert-group");
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
  const pendingFinalize = track(finalizeLifecycle(host, root, first));
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

test("finalize 前置校验失败时不登记等待（Promise 立即收口，不悬挂）", async () => {
  const probe = createGoalProbe();
  const { host, root } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  // 票据 10：token 集不再是前置条件；这里用真正的前置校验（summary 未完成）证明
  // 失败路径依旧立即返回 rejected，且绝不登记等待或悬挂 root turn。
  const result = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: outcome.admissionEpoch,
    admissionTokens: [outcome.admissionToken],
    summaryCompleted: false,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(result.kind, "rejected");
  assert.equal(result.reason, "summary-or-outcome-check-required");
  assert.ok(result.message.length > 0);
  assertNoGoalCalls(probe);
});

test("finalize 只传 admissionEpoch 时同样登记同一张等待账本（token 只是诊断）", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root);
  const receipt = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: outcome.admissionEpoch,
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(receipt.kind, "waiting");
  assert.equal(receipt.acceptedCount, 1);
  assert.deepEqual(receipt.tokenDiagnostics.missing, [outcome.admissionToken]);

  const stop = stopRootTurn(host, root);
  assert.equal(stop.pending, 1, "epoch-only 收口必须让 turn-stopping 参与同一张等待账本");
  let settled = false;
  stop.settled.then(() => { settled = true; });
  await flushAsyncWork(10);
  assert.equal(settled, false, "专家仍在运行时等待必须保持");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  await flushAsyncWork(20);
  assert.equal(settled, true, "专家静止后同一张账本一次性收口");
  assert.equal(host.agentSteerMessages(root).length, 1);
  assertNoGoalCalls(probe);
});

// ── 11. 同一 root 的第二轮等待（第一批静止后 continue_parent_turn） ─────────

test("同一 root 第二轮：第一批静止收口后，continue_parent_turn 的第二批重新判定并释放", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });

  // 第一批：普通 accepted admission。
  const first = await startAdmission(host, root, "round one task", ["docs/round-one.md"]);
  const firstFinalize = track(finalizeLifecycle(host, root, first));
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
  const firstFinalize = track(finalizeLifecycle(host, root, first));
  await flushAsyncWork(8);
  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-second-round-one");
  await flushAsyncWork(20);
  assert.equal(firstFinalize.status, "resolved");

  // 第二批走普通 accepted admission：新的 epoch、新的 token、新的等待记录。
  const second = await startAdmission(host, root, "second round two", ["docs/second-round-two.md"]);
  const secondFinalize = track(finalizeLifecycle(host, root, second));
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
 * @param {{now?:Function,setTimeout?:Function,clearTimeout?:Function}} [clock]
 *   可选假时钟；不传时使用真实定时器（退避复查按墙钟运行）。
 * @returns {{registry:object, calls:number[], agents:Set<object>, fire:(agent:object)=>void}}
 */
function createFactoryRig(snapshot, clock = {}) {
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
    ...(typeof clock.now === "function" ? { now: clock.now } : {}),
    ...(typeof clock.setTimeout === "function" ? { setTimeout: clock.setTimeout } : {}),
    ...(typeof clock.clearTimeout === "function" ? { clearTimeout: clock.clearTimeout } : {}),
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
  // 假时钟：退避复查绝不能靠真实 10/20ms 墙钟抢在断言前触发（否则用例本身会变成
  // 对机器负载的断言）。这里显式推进到期时间，既证明「不会同步自旋」，也证明
  // 「退避到期后确实会重查」。
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(callback, delay = 0, ...args) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback, args });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at > now) continue;
          timers.delete(id);
          progressed = true;
          timer.callback(...timer.args);
        }
      }
      return now;
    },
    get pending() { return timers.size; },
  };
  const rig = createFactoryRig((index) => (index === 1 ? first.promise : second.promise), clock);
  rig.agents.add(agent);

  const waitState = track(rig.registry.wait(agent));
  await flushAsyncWork(1);
  rig.fire(agent);
  first.reject(new Error("first failure"));
  await flushAsyncWork(2);
  assert.equal(rig.calls.length, 2, "第一次 reject 消费 recheck 并重跑一次");

  // 第二次查询也 reject，但期间没有任何新事件：先同步断言不自旋（还没有任何
  // 定时器到期），再推进假时钟证明退避重查确实存在。
  second.reject(new Error("second failure"));
  await flushAsyncWork(2);
  assert.equal(rig.calls.length, 2, "没有新事件时不得同步重跑（不能自旋）");
  assert.ok(clock.pending >= 1, "失败后必须武装退避重查，而不是永久放弃观察");
  assert.equal(waitState.status, "pending", "查询持续失败必须保持等待（unknown 不放行）");
  clock.advance(60 * 1000);
  await flushAsyncWork(2);
  assert.equal(rig.calls.length, 3, "退避到期后才允许重查");
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

test("agents.list fallback：权威 listing 与 session activity 都不可用时仍按严格血缘收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({
    goalProbe: probe,
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
    rootChildren: () => [root, ...children.map((entry) => entry.child)],
  });
  const outcome = await startAdmission(host, root, "runtime list fallback", ["docs/runtime-list.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending", "running child 必须继续阻塞 root");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-runtime-list-fallback");
  await flushAsyncWork(20);

  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "finalized");
  assertNoGoalCalls(probe);
});

test("用户插话：同步取消旧 waiter 但保留 admission，后续 finalize 仍可收口", async () => {
  const probe = createGoalProbe();
  const { host, root, children } = createWaitHost({ goalProbe: probe });
  const outcome = await startAdmission(host, root, "user interruption", ["docs/user-interruption.md"]);
  const pending = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(pending.status, "pending");

  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: "user-interruption-1", source: { kind: "user" } },
  });
  await flushAsyncWork(10);
  assert.equal(pending.status, "resolved");
  assert.equal(pending.value.kind, "cancelled", "用户插话只取消本次 waiter，不是终态收口");
  assert.deepEqual(host.agentSteerMessages(root), [], "被取消的 waiter 绝不投递终态结论");

  const retry = track(finalizeLifecycle(host, root, outcome));
  await flushAsyncWork(10);
  assert.equal(retry.status, "pending", "用户插话不得关闭原 admission batch");

  endChildTurn(host, children[0]);
  host.setAgentStatus(children[0].child, "idle");
  insertNotice(host, root, children[0], "fb-user-interruption");
  await flushAsyncWork(20);
  assert.equal(retry.status, "resolved");
  assert.equal(retry.value.kind, "finalized");
  assertNoGoalCalls(probe);
});
