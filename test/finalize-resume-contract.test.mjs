/**
 * finalize 收口的**中断恢复**契约（票据 02）：被用户插话打断的待收口 root turn。
 *
 * 领域前提（两阶段收口的下半段，见票据 01 的实现）：
 * - finalize 只做「登记 + pending-close 闩锁」并返回非终态 waiting；
 * - 真正的等待由 root turn 的 \`agent/turn-stopping\` serial 边界承担，等待账本记录
 *   会在一次静止收口后销毁，因此每次都要按批次保存的 **exact admission** 重新登记
 *   仍未结算的工作，并用**本次 turn 自己的 signal** 重新等待；
 * - 等待被取消（用户插话 / AbortSignal / root 退休 / 插件卸载）**不是**专家完成：
 *   批次保持 pending-close，既不关闭也不投递终态结论，留给后续 root turn 接续。
 *
 * 本文件锁死的边界：
 * 1. 取消后 pending 不丢：同一 child、同一 admission 凭据在后续 turn 自动接续，
 *    不要求模型重发 admission 或重建专家任务；
 * 2. 插话期间专家结算（含结算发生在没有 waiter 的窗口里）不会产生幽灵 work，
 *    恢复后的等待既不悬挂也不把「取消」当成「完成」；
 * 3. pending-close 期间新接受的 role admission 归入**同一个开放批次**的 exact work
 *    集：它必须被一并等待（即使等待已经在飞），且收口结论的 acceptedCount 反映
 *    收口时刻的完整 accepted 集；
 * 4. 重复 settlement、重复 turn-stopping、重复合法 finalize 一律幂等：只投递一次、
 *    只关闭一次、不重复登记；
 * 5. root 代际退休 / 替代 root / 插件卸载时 fail-closed：绝不向替代 root 投递旧批次
 *    的结论，也绝不把取消当成收口完成。
 *
 * 断言全部落在公开可观察面上：工具回执、turn-stopping 返回的 Promise、被 steer 的
 * 消息与 child 注册事实；不读取插件私有状态，也不使用固定 sleep 猜测完成。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginHost, flushAsyncWork } from "../test-support/plugin-host.mjs";

const ROOT_ID = "root-finalize-resume";
/** DEG 会话消息的生产者自有 source kind（与 index.js 的 PRODUCER_SOURCE_KIND 同规则）。 */
const PRODUCER_SOURCE_KIND = "plugin:dsh-expert-group";

/**
 * 受控 Host：subagents.startContinuable 同步登记 running child，使等待账本的
 * listing + exact runtime 两条 seam 都读到同一份宿主事实。
 */
function createHost() {
  const children = [];
  const host = createPluginHost({
    goals: { get: () => undefined },
    sessionActivity: "subagent",
    descendantListing: "subagent",
    rootChildren: () => host.agents.roots(),
    settings: {
      value: { provider: "mock", defaults: { explorer: { provider: "mock", model: "mock" } } },
    },
    subagents: {
      async startContinuable({ request }) {
        const index = children.length + 1;
        const childId = "fr-child-" + index;
        const messageId = "fr-message-" + index;
        const created = host.registerRootAgent(childId, { lifecycle: false });
        created.session.header = { id: childId, parentSession: request.parent.id, origin: "subagent" };
        created.options = {
          provider: "mock",
          model: "mock",
          __degExpertRole: "explorer",
          __degExpertParent: request.parent.id,
          __degExpertContinuable: true,
        };
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

/** 调用真实注册的 explorer 角色工具（完整 admission 路径）。 */
async function startAdmission(host, root, prompt, affectedPaths = ["docs/finalize-resume.md"]) {
  return host.toolDefinition("explorer").execute({ description: "fr task", prompt, affectedPaths }, { agent: root });
}

/** 调用真实注册的 finalize 工具（默认提交完整 token 集）。 */
function finalize(host, root, outcomes) {
  const list = Array.isArray(outcomes) ? outcomes : [outcomes];
  return host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: list[0].admissionEpoch,
    admissionTokens: list.map((outcome) => outcome.admissionToken),
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
}

/**
 * 驱动一次 root turn 的 \`agent/turn-stopping\`（宿主会 await 监听器返回的 Promise）。
 *
 * @returns {{returned:number, pending:number, status:string, settled:Promise<string>}}
 */
function driveTurnStopping(host, root, turn = 1, signal) {
  const results = host.emit("agent/turn-stopping", { agent: root, turn, ...(signal === undefined ? {} : { signal }) });
  const waiting = results.filter((value) => value !== null && typeof value === "object" && typeof value.then === "function");
  const state = { returned: results.length, pending: waiting.length, status: "pending" };
  state.settled = Promise.all(waiting).then(() => { state.status = "resolved"; return "settled"; });
  return state;
}

/**
 * 构造「该 turn 已按协议打完成标记」的事件日志。
 *
 * 新协议要求**每个 turn** 都以 dsh_expert_group_done 收尾；本文件的关注点是收口结论的
 * 投递次数与幂等，因此给后续 turn 边界补一个**完整三段式**的完成标记（assistant block
 * 带 callId → tool/call 同名同 callId → 成功 tool/result），让 turn-stopping 的续接保护
 * 保持沉默，而不是放宽「每批至多一次结论」的断言。
 */
function doneClosedTurnEvents(turn) {
  const callId = "resume-done-call-" + turn;
  return [
    { type: "turn/start", data: { turn } },
    {
      type: "assistant/message",
      data: { turn, step: 1, message: { content: [{ type: "tool-call", name: "dsh_expert_group_done", callId, arguments: {} }] } },
    },
    { type: "tool/call", data: { turn, step: 1, callId, name: "dsh_expert_group_done", arguments: {} } },
    { type: "tool/result", data: { turn, step: 1, message: { role: "tool", toolCallId: callId, content: [] } } },
  ];
}

/** 结束 child 的 turn 边界（真实形状：turn/start + 携带 admission messageId 的 user/message + turn/end）。 */
function endChildTurn(host, entry, turn = 1) {
  entry.child.session.events = [
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: entry.messageId, role: "user", content: [], source: { kind: PRODUCER_SOURCE_KIND } } },
    { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: "done" }] } } },
  ];
  host.emit("session/event", entry.child.session, {
    type: "turn/end",
    data: { turn, reason: { kind: "completed" } },
  });
}

/**
 * 完成一个 admission 对应的全部精确终态：turn/end + 明确 idle + 精确 settlement。
 *
 * 默认 feedback id 只由 childId 决定，因此重复调用就是**重复 settlement 重放**。
 */
async function completeChild(host, root, entry, turn = 1, feedbackId) {
  endChildTurn(host, entry, turn);
  // 必须先让 turn/end 的发布 microtask 落地，再投递精确 settlement：真实 Host 的
  // settlement 比 turn/end 晚约 0.5s。若两者在同一同步批次发出，recovery gate 会把
  // settlement 撤回（此时 handoff entry 的 turnEnded 还没标记），精确通道就永远观察不到。
  await flushAsyncWork(8);
  host.setAgentStatus(entry.child, "idle");
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: {
      id: feedbackId ?? ("fr-feedback-" + entry.childId),
      source: { kind: "subagent-settled", senderSessionId: entry.childId },
    },
  });
  await flushAsyncWork(16);
}

/** 只取该 root 收到的 steer 消息。 */
function steerMessages(host, root) {
  return host.agentSteerMessages(root);
}

/** 取唯一一条收口结论的正文（并断言确实只有一条）。 */
function soleConclusionText(host, root) {
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "每个批次至多投递一次终态结论");
  return messages[0].content.map((block) => block.text).join("");
}

/**
 * 在真实计时器上给一次等待一个上限：等待必须**自行**收口，绝不允许靠轮询或固定
 * sleep 猜测完成；达到上限仍未收口说明等待被认定为悬挂（fail）。
 */
function settleWithin(state, ms = 2000) {
  return Promise.race([
    state.settled,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      timer.unref?.();
    }),
  ]);
}

// ── 1. 中断即取消等待，但批次保持 pending：同一 child / 同一凭据可接续 ─────────

test("用户插话取消等待后 pending 不丢：同一 child 与同一凭据在后续 turn 接续并只投递一次", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "resume probe");
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.acceptedCount, 1);

  // turn 1：等待被用户插话（AbortSignal）取消。
  const controller = new AbortController();
  const interrupted = driveTurnStopping(host, root, 1, controller.signal);
  assert.equal(interrupted.pending, 1);
  await flushAsyncWork(12);
  assert.equal(interrupted.status, "pending", "专家仍在运行时等待必须保持");
  controller.abort();
  await interrupted.settled;
  assert.deepEqual(steerMessages(host, root), [], "取消不是专家完成：绝不投递终态结论");

  // 取消不改变批次状态，也不需要模型重发 admission 或重建 child。
  const reopened = await finalize(host, root, outcome);
  assert.equal(reopened.kind, "waiting", "取消后的批次仍是 pending-close，重复凭据是稳定 waiting");
  assert.equal(reopened.admissionEpoch, outcome.admissionEpoch);
  assert.equal(children.length, 1, "恢复不得要求重建专家任务");
  assert.equal(children[0].child.status, "running", "取消等待不得改变专家任务本身的运行事实");

  // 后续 root turn 接续同一批工作，并使用**本次 turn 自己的 signal**。
  const resumed = driveTurnStopping(host, root, 2, new AbortController().signal);
  assert.equal(resumed.pending, 1, "后续 turn 必须重新参与同一批次的等待");
  await flushAsyncWork(12);
  assert.equal(resumed.status, "pending", "专家未结束前接续的等待同样保持");

  await completeChild(host, root, children[0]);
  assert.equal(await settleWithin(resumed), "settled", "全部精确工作释放后接续的等待必须自行收口");
  const text = soleConclusionText(host, root);
  assert.match(text, /finalized/i);
  assert.match(text, new RegExp("admissionEpoch " + outcome.admissionEpoch));
  assert.match(text, /acceptedCount 1/);

  // 重复 turn-stopping：已关闭批次不再悬挂，也不再投递。
  // 本 turn 已按协议收尾：续接保护必须保持沉默。
  root.session.events = doneClosedTurnEvents(3);
  const again = driveTurnStopping(host, root, 3);
  await flushAsyncWork(8);
  assert.equal(again.pending, 0, "已关闭批次不得再次悬挂 root turn");
  assert.equal(steerMessages(host, root).length, 1, "终态结论每批至多一次");
  await host.dispose();
});

test("取消永远不等同 settlement：abort 之后没有任何结算事实时绝不出现收口结论", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "abort is not settlement");
  await finalize(host, root, outcome);

  const controller = new AbortController();
  const interrupted = driveTurnStopping(host, root, 1, controller.signal);
  await flushAsyncWork(12);
  controller.abort();
  await interrupted.settled;
  assert.deepEqual(steerMessages(host, root), [], "abort 只取消 waiter，不是专家完成");

  // 取消之后立刻再进入等待（没有任何新的 settlement）：仍必须等待，而不是提前收口。
  const resumed = driveTurnStopping(host, root, 2);
  await flushAsyncWork(12);
  assert.equal(resumed.status, "pending", "没有精确结算事实时批次不得关闭");
  assert.deepEqual(steerMessages(host, root), []);
  assert.equal(children[0].child.status, "running");

  // 只有真正的 expert 结算才能释放。
  await completeChild(host, root, children[0]);
  assert.equal(await settleWithin(resumed), "settled");
  assert.equal(steerMessages(host, root).length, 1);
  await host.dispose();
});

// ── 2. 插话期间的专家结算：恢复不重新等待幽灵 work，也不把结算当成取消 ─────────

test("插话期间专家完成结算：恢复不会重新等待幽灵 work，也不在无 waiter 时投递结论", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "settle during interruption");
  await finalize(host, root, outcome);

  const controller = new AbortController();
  const interrupted = driveTurnStopping(host, root, 1, controller.signal);
  await flushAsyncWork(12);
  controller.abort();
  await interrupted.settled;

  // 插话窗口内（没有任何 waiter 参与时）专家真正结束并完成精确结算。
  await completeChild(host, root, children[0]);
  assert.deepEqual(steerMessages(host, root), [], "没有 turn-stopping 边界时绝不投递结论");

  // 恢复后的等待必须立即判定静止：既不能悬挂（幽灵 work），也不能重复投递。
  const resumed = driveTurnStopping(host, root, 2);
  assert.equal(resumed.pending, 1, "pending-close 批次必须参与恢复后的边界判定");
  assert.equal(await settleWithin(resumed), "settled", "已结算的工作不得被重新登记成永不结算的幽灵 work");
  assert.match(soleConclusionText(host, root), /acceptedCount 1/);

  root.session.events = doneClosedTurnEvents(3);
  const again = driveTurnStopping(host, root, 3);
  await flushAsyncWork(8);
  assert.equal(again.pending, 0);
  assert.equal(steerMessages(host, root).length, 1, "多次恢复只投递一次");
  await host.dispose();
});

// ── 3. pending-close 期间的新 admission：归入同一批次并被一并等待 ──────────────

test("pending-close 期间新 admission 归入同一开放批次：被一并等待，final count 反映完整 accepted 集", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "batch item one", ["docs/resume-one.md"]);
  const waiting = await finalize(host, root, first);
  assert.equal(waiting.acceptedCount, 1);

  // 用户插话：等待取消，批次保持 pending-close。
  const controller = new AbortController();
  const interrupted = driveTurnStopping(host, root, 1, controller.signal);
  await flushAsyncWork(12);
  controller.abort();
  await interrupted.settled;
  assert.deepEqual(steerMessages(host, root), []);

  // 后续 root turn 重新建立同一批次的等待；新 admission 就落在这段等待**在飞期间**。
  const resumed = driveTurnStopping(host, root, 2);
  await flushAsyncWork(12);
  assert.equal(resumed.status, "pending");

  const second = await startAdmission(host, root, "batch item two", ["docs/resume-two.md"]);
  assert.equal(second.admissionEpoch, first.admissionEpoch, "旧批次仍 pending-close：新 admission 必须留在同一个开放 epoch");
  assert.notEqual(second.admissionToken, first.admissionToken);

  // 第一项真正结束：逐 child 进度放行会收口**本次等待**（宿主在同一 turn 继续 step 消费
  // 已进入 next-step 的 settlement），但新 admission 仍未结算 → 绝不投递结论、批次不关闭。
  await completeChild(host, root, children[0]);
  assert.equal(await settleWithin(resumed), "settled", "逐 child 进度放行必须收口本次等待");
  assert.deepEqual(steerMessages(host, root), [], "其它 exact work 未释放时不得投递收口结论");
  const stillOpen = await finalize(host, root, [first, second]);
  assert.equal(stillOpen.kind, "waiting", "进度放行不关闭 pending-close 批次");

  // 新 child 已不在 running 列表，但它的 exact settlement 尚未到达：新边界的静止判定必须
  // 由**未结算 work** 挡住，而不是把「查询不到 running 后代」当完成。
  host.setAgentStatus(children[1].child, "idle");
  const next = driveTurnStopping(host, root, 3);
  assert.equal(next.pending, 1, "未结算 work 必须让新边界继续等待");
  await flushAsyncWork(16);
  assert.equal(next.status, "pending", "exact work 未释放时绝不因后代列表空闲而提前收口");
  assert.deepEqual(steerMessages(host, root), []);

  // 新 admission 真正结束：一次性收口，且结论反映收口时刻的完整 accepted 集。
  await completeChild(host, root, children[1]);
  assert.equal(await settleWithin(next), "settled");
  const text = soleConclusionText(host, root);
  assert.match(text, new RegExp("admissionEpoch " + first.admissionEpoch));
  assert.match(text, /acceptedCount 2/, "final count 必须反映收口时刻的完整 accepted 集");
  assert.equal(children.length, 2, "恢复与新 admission 都不得重建既有专家任务");

  root.session.events = doneClosedTurnEvents(4);
  const again = driveTurnStopping(host, root, 4);
  await flushAsyncWork(8);
  assert.equal(again.pending, 0);
  assert.equal(steerMessages(host, root).length, 1);
  await host.dispose();
});

test("重复合法 finalize / 重复 settlement / 重复 turn-stopping 在含新 admission 的批次上保持幂等", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "idempotent one", ["docs/idem-one.md"]);
  await finalize(host, root, first);

  const controller = new AbortController();
  const interrupted = driveTurnStopping(host, root, 1, controller.signal);
  await flushAsyncWork(12);
  controller.abort();
  await interrupted.settled;

  // pending-close 期间新接受第二项。
  const second = await startAdmission(host, root, "idempotent two", ["docs/idem-two.md"]);
  assert.equal(second.admissionEpoch, first.admissionEpoch);

  // 重复的**合法** finalize（完整的新 token 集）仍是稳定 waiting：不重复登记、不关闭、不投递。
  const repeated = await finalize(host, root, [first, second]);
  assert.equal(repeated.kind, "waiting");
  assert.equal(repeated.reason, "experts-running");
  assert.equal(repeated.acceptedCount, 2, "重复凭据反映批次当前完整 accepted 集");
  assert.deepEqual(steerMessages(host, root), []);

  const resumed = driveTurnStopping(host, root, 2);
  assert.equal(resumed.pending, 1, "重复 finalize 不得提前关闭批次");

  // 重复 settlement 重放：终态事件与精确 settlement 各来两次。第一次结算触发逐 child
  // 进度放行（收口本次等待、不投递），重复副本是幂等空操作；批次保持 pending-close。
  await completeChild(host, root, children[0]);
  await completeChild(host, root, children[0]);
  assert.equal(await settleWithin(resumed), "settled", "逐 child 进度放行必须收口本次等待");
  assert.deepEqual(steerMessages(host, root), [], "单项结算不得投递整批结论");
  const stillOpen = await finalize(host, root, [first, second]);
  assert.equal(stillOpen.kind, "waiting", "单项重复结算不得关闭批次");

  // 第二项结算完成后，由下一个 turn 边界一次性投递（此时已没有活跃 waiter）。
  await completeChild(host, root, children[1]);
  await completeChild(host, root, children[1]);
  const closing = driveTurnStopping(host, root, 3);
  assert.equal(closing.pending, 1, "pending-close 批次必须让新边界参与等待");
  assert.equal(await settleWithin(closing), "settled");
  assert.match(soleConclusionText(host, root), /acceptedCount 2/);

  // 重复 turn-stopping：不再参与、也不再投递。
  // 本 turn 已按协议收尾：续接保护必须保持沉默。
  root.session.events = doneClosedTurnEvents(4);
  const third = driveTurnStopping(host, root, 4);
  await flushAsyncWork(8);
  assert.equal(third.pending, 0);
  assert.equal(steerMessages(host, root).length, 1);
  // 已关闭批次上的重复凭据仍是稳定幂等回执。
  const afterClose = await finalize(host, root, [first, second]);
  assert.equal(afterClose.kind, "noop");
  assert.equal(afterClose.reason, "already-finalized");
  assert.equal(steerMessages(host, root).length, 1);
  await host.dispose();
});

// ── 4. 生命周期 fail-closed：退休 / 替代 root / 卸载都不投递 ─────────────────

test("等待期间 root 退休：批次随代际退休，替代 root 绝不收到旧批次的收口结论", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "retire probe");
  await finalize(host, root, outcome);

  const waiting = driveTurnStopping(host, root, 1);
  await flushAsyncWork(12);
  assert.equal(waiting.status, "pending");

  host.disposeAgent(root);
  await waiting.settled;
  assert.deepEqual(steerMessages(host, root), [], "退休的 root 绝不投递收口结论");
  assert.equal(children[0].child.status, "running", "取消等待不得改变专家任务本身的运行事实");

  // 同 id 的替代 root 必须从空状态开始：旧批次既不继承也不投递。
  // 该 turn 已按协议收尾：替代 root 也不该收到任何续接提醒。
  const replacement = host.registerRootAgent(ROOT_ID);
  replacement.session.events = doneClosedTurnEvents(2);
  const replacementStop = driveTurnStopping(host, replacement, 2);
  await flushAsyncWork(12);
  assert.equal(replacementStop.pending, 0, "替代 root 不得继承旧批次的 pending-close 等待");
  assert.deepEqual(steerMessages(host, replacement), [], "旧批次结论绝不投递到替代 root");

  // 即使旧 child 之后真的结束，旧批次也不会有任何补投递。
  await completeChild(host, root, children[0]);
  assert.deepEqual(steerMessages(host, root), []);
  assert.deepEqual(steerMessages(host, replacement), []);
  await host.dispose();
});

test("插件卸载：等待被取消，卸载后不再参与 turn-stopping，也不投递结论", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "unload probe");
  await finalize(host, root, outcome);

  const waiting = driveTurnStopping(host, root, 1);
  await flushAsyncWork(12);
  assert.equal(waiting.status, "pending");

  await host.dispose();
  await waiting.settled;
  assert.deepEqual(steerMessages(host, root), [], "卸载时不得投递收口结论");
  assert.equal(children[0].child.status, "running");

  const afterUnload = driveTurnStopping(host, root, 2);
  await flushAsyncWork(8);
  assert.equal(afterUnload.pending, 0, "卸载后监听器必须已释放");
  assert.deepEqual(steerMessages(host, root), []);
});
