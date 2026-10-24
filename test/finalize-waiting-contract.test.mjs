/**
 * finalize 两阶段契约（票据 01）：快速登记 waiting + root turn 边界收口。
 *
 * 语义（用户确认的 B 方案）：
 * 1. \`dsh_expert_group_finalize\` 保留全部同步前置校验，把 accepted work 一次性登记进
 *    唯一的 root turn 等待账本后**立即**返回非终态 \`waiting\`：绝不在工具调用内等待
 *    专家结束，也绝不使用 \`exec.signal\` 等待（run_code 的 PTC 预算因此不再影响收口）。
 * 2. 继续等待由 root turn 的 \`agent/turn-stopping\` serial 边界承担：即使原账本记录已在
 *    settle 后销毁、\`isEngaged()\` 为 false，也必须依据批次保存的 exact admission 信息
 *    重新登记尚未结算的 work、engage 并用**本次 root turn 的 signal** 调用同一张账本。
 * 3. 只有 wait 明确 \`released\`、signal 未取消、且 exact root/generation 仍 live 时，才以
 *    同步 \`rootAgent.steer(message)\` 向同一 run 注入一次 DEG 来源的终态结论，然后一次性
 *    关闭批次；waiter 被取消时批次保持 pending-close，留给后续 turn 接续。
 *
 * 测试 seam（不新增除 steer 之外的面）：受控 Host 的真实 apply 面 + 公开 finalize 工具 +
 * \`agent/turn-stopping\` 事件 + 精确完成通知（\`agent/inbox/inserted\` / \`agent/inbox/spliced\`）
 * + 宿主公开的 \`Agent.steer\` 记录。断言全部落在公开结果上：工具回执、等待 Promise 状态、
 * 被投递的消息与系统 Toast 适配器调用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPluginHost, flushAsyncWork, RPC_ENDPOINT } from "../test-support/plugin-host.mjs";

const ROOT_ID = "root-finalize-waiting";
/** DEG 会话消息的生产者自有 source kind（与 index.js 的 PRODUCER_SOURCE_KIND 同规则）。 */
const PRODUCER_SOURCE_KIND = "plugin:dsh-expert-group";
/** 真实 Host 自动完成通知的固定前缀：插件消息绝不能撞上它。 */
const HOST_SETTLEMENT_PREFIX = /^Background subagent [0-9a-f-]{36} finished and will do no further work unless you send it more\./i;

/**
 * 系统 Toast 适配器替身：只记录被请求的文案。
 *
 * ADR 0005 规定系统通知是唯一通知界面，而插件内部的收口结论**不是**系统通知；本文件
 * 用这个替身证明收口投递不会触发 Toast（也绝不真弹通知）。
 */
function installToastSpy() {
  const shows = [];
  return {
    shows,
    adapter: {
      show(request) {
        shows.push({ title: request?.title, taskName: request?.taskName, body: request?.body });
        return Promise.resolve({ shown: true, reason: "ok" });
      },
      describe: () => ({ version: 1, sent: shows.length }),
      dispose() {},
    },
  };
}

/**
 * 受控 Host：subagents.startContinuable 同步登记 running child，使等待账本的两条 seam
 * （权威 listing + exact runtime \`agents.list()\` 快照）都读到同一份宿主事实。
 */
function createHost({ toastSpy, holdSecondStart = false, descendantListing = "subagent", rootChildren } = {}) {
  const children = [];
  let heldOnce = false;
  const host = createPluginHost({
    goals: { get: () => undefined },
    sessionActivity: "subagent",
    // 默认权威 listing；用例可传 "throw" 构造「查询未知」的逃生拒绝路径。
    descendantListing,
    // 真实 rc.2 宿主一定提供 agents.list()：等待的运行判定必须用同一份完整快照交叉校验。
    // rootChildren: null 表示宿主没有该 seam（否则默认接 live Agent 注册表）。
    ...(rootChildren === undefined
      ? { rootChildren: () => host.agents.roots() }
      : (rootChildren === null ? {} : { rootChildren })),
    settings: {
      value: { provider: "mock", defaults: { explorer: { provider: "mock", model: "mock" } } },
    },
    ...(toastSpy === undefined
      ? {}
      : {
        config: {
          enableOrchestrator: true,
          enableObserver: true,
          createSystemToast: () => toastSpy.adapter,
          // 票据 11 的提示用例显式开启（现仅剩收口投递失败一类）；测试 Host 默认关闭，避免其余用例 spawn 真实通知。
          waitLedgerNotifications: true,
        },
      }),
    subagents: {
      async startContinuable({ request }) {
        // 票据 10 用例：让**第二次**派发永久挂起，构造「admission 已 begin、outcome 尚未
        // settle」的开放批次（只挂一次，后续派发照常登记）。
        if (holdSecondStart && !heldOnce && children.length === 1) {
          heldOnce = true;
          await new Promise(() => {});
        }
        const index = children.length + 1;
        const childId = "fw-child-" + index;
        const messageId = "fw-message-" + index;
        const created = host.registerRootAgent(childId, { lifecycle: false });
        created.session.header = { id: childId, parentSession: request.parent.id, origin: "subagent" };
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

/** 调用真实注册的 explorer 角色工具（完整 admission 路径）。 */
async function startAdmission(host, root, prompt, affectedPaths = ["docs/finalize-waiting.md"]) {
  return host.toolDefinition("explorer").execute({ description: "fw task", prompt, affectedPaths }, { agent: root });
}

/** 只传批次定位键（admissionEpoch）调用 finalize：admissionTokens 是可选的诊断参数。 */
function finalizeEpochOnly(host, root, admissionEpoch, extra = {}) {
  return host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch,
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
    ...extra,
  }, { agent: root });
}

/** 调用真实注册的 finalize 工具。 */
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
 * 驱动一次 root turn 的 \`agent/turn-stopping\`（宿主会 await 监听器返回的 Promise）。
 *
 * @returns {{returned:number, pending:number, status:string, settled:Promise<string>}}
 *   可断言句柄：\`pending\` 是参与等待的监听器个数，\`status\` 在等待收口后变为 resolved。
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
 * 投递次数，因此给后续 turn 边界补一个**完整三段式**的完成标记（assistant block 带 callId →
 * tool/call 同名同 callId → 成功 tool/result），让 turn-stopping 的续接保护保持沉默，
 * 而不是放宽「每批至多一次结论」的断言。
 */
function doneClosedTurnEvents(turn) {
  const callId = "done-call-" + turn;
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

/**
 * 结束 child 的 turn 边界。
 *
 * 必须与真实 Host 同形：终态事件之外，会话日志里也要有本 turn 的 `turn/start` 与带着
 * admission messageId 的 `user/message`——插件用它把 handoff admission 精确归属到该 turn
 * （缺少它时 admission 永远关联不上这次终态，等待会正确地一直保持）。
 */
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

/** 让 child 明确不再运行（rc.2 的 Agent.status 只有 idle / running）。 */
function quiesceChild(host, entry) {
  host.setAgentStatus(entry.child, "idle");
}

/** 父 inbox 收到精确关联的 child settlement。 */
function insertNotice(host, root, entry, messageId = "fw-feedback-1") {
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: messageId, source: { kind: "subagent-settled", senderSessionId: entry.childId } },
  });
}

/**
 * 完成一个 admission 对应的全部精确终态：turn/end + 明确 idle + 精确 settlement。
 *
 * 顺序与真实 Host 一致（终态事件先、状态随后、父 inbox 结算最后）。**必须在 turn/end 与
 * settlement 之间让出一次异步**：真实 Host 的终态处理先落地（handoff entry 标记 turnEnded、
 * pending feedback 消费），之后才把 settlement 投进父 inbox。若两者在同一同步批次里发出，
 * settlement 会被 recovery gate 当成「turn 尚未结束」撤回到 gated 队列，精确通道
 * （cohort.ready → 逐 child 进度放行）就永远观察不到。
 */
async function completeChild(host, root, entry, turn = 1) {
  endChildTurn(host, entry, turn);
  await flushAsyncWork(8);
  quiesceChild(host, entry);
  insertNotice(host, root, entry, "fw-feedback-" + entry.childId);
  await flushAsyncWork(16);
}

/** 只取该 root 收到的 steer 消息（多 root 用例互不干扰）。 */
function steerMessages(host, root) {
  return host.agentSteerMessages(root);
}

/**
 * 可控虚拟时钟：把 \`setTimeout\` / \`clearTimeout\` / \`Date.now\` 换成手工推进的假时钟。
 *
 * 为什么需要它：票据要求覆盖「等待超过 600000ms（run_code 的 PTC 预算）」而**不得**真实
 * 等待十分钟，也不得改动任何超时配置。假时钟让虚拟时间一次性推进到 10 分钟以上，同时
 * 真实墙钟只花几毫秒；插件若依赖任何真实 deadline，在这个窗口里就会暴露。
 * 恢复必须放在 finally（其它用例可能依赖真实定时器）。
 */
function installVirtualClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  let now = 0;
  let seq = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback, args });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  Date.now = () => now;
  return {
    get now() { return now; },
    /** 推进虚拟时间并同步执行到期回调（回调中新排的、同样到期的定时器也会执行）。 */
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
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realDateNow;
    },
  };
}

// ── 1. 快速登记：工具调用绝不在 run_code 内等待 ────────────────────────────────

test("accepted finalize 在 child 仍运行时立即返回 waiting（不等待、不关闭、不投递）", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "waiting probe");
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting", "合法非空批次必须返回非终态 waiting");
  assert.equal(waiting.reason, "experts-running");
  assert.equal(waiting.admissionEpoch, outcome.admissionEpoch);
  assert.equal(waiting.acceptedCount, 1);
  assert.equal(children[0].child.status, "running", "child 必须仍在运行：本回执不表示专家已完成");
  assert.deepEqual(steerMessages(host, root), [], "等待登记阶段绝不投递终态结论");
  await host.dispose();
});

test("waiting 回执是幂等的：重复合法 finalize 返回稳定 waiting，不重复登记也不关闭批次", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "idempotent waiting");
  const first = await finalize(host, root, outcome);
  const second = await finalize(host, root, outcome);
  assert.equal(first.kind, "waiting");
  assert.deepEqual(second, first, "同一批次的重复合法 finalize 必须得到同一回执");
  // 批次仍未关闭：turn-stopping 仍要参与等待，child 结束后才收口。
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1, "pending-close 批次必须让 turn-stopping 参与判定");
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending", "重复 finalize 不得提前关闭批次");
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.equal(steerMessages(host, root).length, 1, "重复调用只能产生一次投递");
  await host.dispose();
});

// ── 2. 边界重建：账本记录销毁 / isEngaged() 为 false 时也必须收口 ──────────────

test("finalize 返回之后 child 才静止：turn-stopping 仍按保存的 exact admission 重新登记并一次性收口", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "settle after finalize");
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting");
  // child 在 finalize 返回之后、turn-stopping 之前真正结束。
  await completeChild(host, root, children[0]);
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1, "pending-close 批次必须进入本次 root turn 的等待");
  await stop.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "静止后必须一次性投递终态结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /finalized/);
  await host.dispose();
});

test("finalize 登记时工作已结算（账本记录已销毁、isEngaged() 为 false）：turn-stopping 仍必须收口并投递", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "already settled");
  // 先让 child 完全静止，再调用 finalize：登记阶段发现 admission 已不在 handoff，
  // 因此没有任何工作项、也没有 engage——旧实现会因此在 turn-stopping 直接放行，
  // 既关闭不了批次也投递不了结论（这正是本用例要锁死的回归）。
  await completeChild(host, root, children[0]);
  const waiting = await finalize(host, root, outcome);
  assert.equal(waiting.kind, "waiting", "已结算的 accepted 批次仍按 waiting 回执收口");
  assert.equal(waiting.acceptedCount, 1);
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1, "没有可登记工作、且未 engage 的 pending-close 批次同样必须参与判定");
  await stop.settled;
  assert.equal(steerMessages(host, root).length, 1, "静止事实成立时必须投递一次终态结论");
  await host.dispose();
});

// ── 3. 取消语义：waiter 取消不得伪造最终结论 ─────────────────────────────────

test("turn-stopping 等待被 abort 取消：批次保持 pending-close，不关闭也不投递，后续 turn 可接续", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "abort keeps pending close");
  await finalize(host, root, outcome);

  const controller = new AbortController();
  const aborted = driveTurnStopping(host, root, 1, controller.signal);
  assert.equal(aborted.pending, 1);
  await flushAsyncWork(12);
  assert.equal(aborted.status, "pending", "child 仍在运行时等待必须保持");
  controller.abort();
  await aborted.settled;
  assert.deepEqual(steerMessages(host, root), [], "取消不是专家完成：绝不投递终态结论");
  // 重复 finalize 仍是稳定 waiting：批次没有被取消关闭。
  assert.equal((await finalize(host, root, outcome)).kind, "waiting");

  // 后续 root turn 接续同一次等待：child 真正结束后仍能一次性收口。
  await completeChild(host, root, children[0]);
  const resumed = driveTurnStopping(host, root, 2);
  await resumed.settled;
  assert.equal(steerMessages(host, root).length, 1, "接续的 turn 必须完成一次性收口");
  await host.dispose();
});

test("root dispose 取消等待：旧 root 绝不 steer，批次随代际一起退休", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "retire no steer");
  await finalize(host, root, outcome);
  const stop = driveTurnStopping(host, root);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending");
  host.disposeAgent(root);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "root 退休后旧代际不得投递收口结论");
  assert.equal(children[0].child.status, "running", "取消等待不得改变专家任务本身的运行事实");
  await host.dispose();
});

// ── 4. 一次性关闭：多次 turn-stopping 与多 child ─────────────────────────────

test("wait 释放后只关闭并 steer 一次：重复 turn-stopping 不再参与、也不再投递", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "close once");
  await finalize(host, root, outcome);
  const stop = driveTurnStopping(host, root);
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.equal(steerMessages(host, root).length, 1);

  // 本 turn 已按协议收尾：后续边界不得再叠加续接提醒（只验证收口结论仍至多一次）。
  root.session.events = doneClosedTurnEvents(2);
  const again = driveTurnStopping(host, root, 2);
  await flushAsyncWork(8);
  assert.equal(again.pending, 0, "已关闭批次不得再次悬挂 root turn");
  assert.equal(steerMessages(host, root).length, 1, "终态结论每批至多一次");
  const repeatFinalize = await finalize(host, root, outcome);
  assert.equal(repeatFinalize.kind, "noop", "已关闭批次上的重复凭据是 already-finalized");
  assert.equal(repeatFinalize.reason, "already-finalized");
  await host.dispose();
});

test("逐 child 进度放行：第一个专家结算即收口本次等待，但不投递、批次仍 pending-close；全部静止后只投递一次 acceptedCount=2", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "multi one", ["docs/multi-one.md"]);
  const second = await startAdmission(host, root, "multi two", ["docs/multi-two.md"]);
  const waiting = await finalize(host, root, [first, second]);
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.acceptedCount, 2);

  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending", "两个专家都在运行时等待必须保持");

  // 第一个专家结算：精确通道**进度放行**——本次 turn-stopping 的 Promise 收口，宿主会在同一
  // turn 的下一个 step 立刻消费已经进入 next-step 的 settlement；它不是最终结论。
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "进度放行绝不投递最终结论");
  assert.equal((await finalize(host, root, [first, second])).kind, "waiting", "批次必须仍保持 pending-close");

  // 模拟同一 turn 下一个 step 之后的 turn 边界：仍有未结算专家 → 等待必须继续。
  const remaining = driveTurnStopping(host, root, 2);
  assert.equal(remaining.pending, 1, "未结算工作必须让新的 turn 边界继续参与等待");
  await flushAsyncWork(12);
  assert.equal(remaining.status, "pending", "进度放行不得把剩余专家一起放掉");

  await completeChild(host, root, children[1]);
  await remaining.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  const text = messages[0].content.map((block) => block.text).join("");
  assert.match(text, /acceptedCount 2/, "终态结论必须表达 acceptedCount");
  await host.dispose();
});

test("逐 child 进度放行只发生一次：同一记录上的多个 waiter 一起收口，重复 settlement 幂等", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "once one", ["docs/once-one.md"]);
  const second = await startAdmission(host, root, "once two", ["docs/once-two.md"]);
  await finalize(host, root, [first, second]);

  // 同一 root turn 上叠加两个等待者（真实宿主一次只有一个 turn-stopping，这里证明
  // 进度收口对同一记录的全部 waiter 都是**一次性**的，不会重复 resolve）。
  const left = driveTurnStopping(host, root, 1);
  const right = driveTurnStopping(host, root, 1);
  assert.equal(left.pending, 1);
  assert.equal(right.pending, 1);
  await flushAsyncWork(12);
  assert.equal(left.status, "pending");
  assert.equal(right.status, "pending");

  await completeChild(host, root, children[0]);
  await Promise.all([left.settled, right.settled]);
  assert.deepEqual(steerMessages(host, root), [], "进度放行只收口 waiter，绝不投递最终结论");

  // 重复 settlement（同一 id 副本）与重复 settle 都是幂等空操作：既不重新放行，
  // 也不投递结论；仍未结算的第二个专家继续阻塞。
  insertNotice(host, root, children[0], "fw-feedback-" + children[0].childId);
  await flushAsyncWork(12);
  assert.deepEqual(steerMessages(host, root), [], "重复 settlement 不得投递结论");
  const again = driveTurnStopping(host, root, 2);
  assert.equal(again.pending, 1, "剩余专家仍在运行：新边界必须继续等待");
  await flushAsyncWork(12);
  assert.equal(again.status, "pending", "重复 settlement 不得把剩余工作一起放掉");

  await completeChild(host, root, children[1]);
  await again.settled;
  assert.equal(steerMessages(host, root).length, 1, "整批静止后只投递一次收口结论");
  await host.dispose();
});

test("单个 child：结算后 works 已空时不走进度放行，仍按 quiescent 一次性投递结论（不拆两段）", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "single quiescent", ["docs/single-quiescent.md"]);
  await finalize(host, root, outcome);
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending");

  // 唯一的工作结算后登记集为空：必须走原有的 quiescent 路径，在**同一个** turn-stopping
  // 内完成结论投递——如果错误地先进度放行，这次边界会以空转结束、结论只能等到下一边界。
  await completeChild(host, root, children[0]);
  await stop.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "单 child 场景必须在同一边界直接投递结论");
  const text = messages[0].content.map((block) => block.text).join("");
  assert.match(text, /acceptedCount 1/);

  // 批次已经关闭：后续 turn 边界不再参与等待，也不需要补投递。
  // 本 turn 已按协议收尾：续接保护必须保持沉默。
  root.session.events = doneClosedTurnEvents(2);
  const after = driveTurnStopping(host, root, 2);
  await flushAsyncWork(8);
  assert.equal(after.pending, 0, "已关闭批次不得再次悬挂 root turn");
  assert.equal(steerMessages(host, root).length, 1, "终态结论每批至多一次");
  await host.dispose();
});

test("无 waiter 静止窗口回归：root 新 step 执行期间最后一个专家结算，后续 turn 边界仍必须投递结论", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "gap one", ["docs/gap-one.md"]);
  const second = await startAdmission(host, root, "gap two", ["docs/gap-two.md"]);
  const waiting = await finalize(host, root, [first, second]);
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.acceptedCount, 2);

  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending", "两个专家都在运行时等待必须保持");

  // 第一个专家结算 → 进度放行收口本次等待（不投递），root 随后进入同一 turn 的下一个 step。
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "进度放行不投递最终结论");

  // 关键窗口：**不**发起新的 turn-stopping，直接让最后一个专家在「root 新 step 执行期间」结算。
  // 此刻没有 waiter：settle 后 works 已空，静止判定以 quiescent 销毁记录并收口，但没人接收，
  // 因此账本随后处于「未 engaged」状态——这正是进度放行引入的无 waiter 静止窗口。
  await completeChild(host, root, children[1]);
  const settledMeta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(settledMeta.value.diagnostics.rootTurnWait.outstandingTotal, 0, "最后一个专家必须已精确结算");
  // 记录已在没有 waiter 的静止判定里销毁（rootCount 0）：这正是待回归的窗口。
  assert.equal(settledMeta.value.diagnostics.rootTurnWait.rootCount, 0, "静止判定必须在没有 waiter 时销毁记录");
  assert.deepEqual(steerMessages(host, root), [], "无 waiter 的静止窗口内不得凭空投递结论");

  // 新 step 结束后的 turn 边界：pending-close 批次仍存在，必须继续等待并在静止后一次性投递。
  // 若这里因为 isEngaged() 为 false 提前返回（且此时没有可重新登记的已结算 admission），
  // 批次将永远不关闭、结论永远不投递——本用例的回归点。
  const closing = driveTurnStopping(host, root, 2);
  assert.equal(closing.pending, 1, "pending-close 批次不得因未登记工作而提前返回");
  await closing.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "无 waiter 静止窗口后仍必须一次性投递收口结论");
  const text = messages[0].content.map((block) => block.text).join("");
  assert.match(text, /acceptedCount 2/, "终态结论必须表达整批 acceptedCount");

  // 批次已关闭：后续 turn 边界不再悬挂，也不会重复投递。
  // 本 turn 已按协议收尾：续接保护必须保持沉默。
  root.session.events = doneClosedTurnEvents(3);
  const after = driveTurnStopping(host, root, 3);
  await flushAsyncWork(8);
  assert.equal(after.pending, 0, "已关闭批次不得再次悬挂 root turn");
  assert.equal(steerMessages(host, root).length, 1, "终态结论每批至多一次");
  await host.dispose();
});

test("进度信号先于 waiter：root step 执行期间结算也不丢唤醒，下一 turn 边界立即放行且不投递", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "early one", ["docs/early-one.md"]);
  const second = await startAdmission(host, root, "early two", ["docs/early-two.md"]);
  const waiting = await finalize(host, root, [first, second]);
  assert.equal(waiting.acceptedCount, 2);

  // 不发起 turn-stopping：模拟 root 正在执行 step，此刻没有 waiter。
  await completeChild(host, root, children[0]);
  const midMeta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(midMeta.value.diagnostics.rootTurnWait.outstandingTotal, 1, "child1 必须已精确结算，剩余 work=1");
  assert.equal(midMeta.value.diagnostics.rootTurnWait.rootCount, 1, "记录必须继续存活以保存进度信号");
  assert.equal(midMeta.value.diagnostics.rootTurnWait.roots[0].outstanding, 1, "剩余 work 必须仍被登记");
  assert.deepEqual(steerMessages(host, root), [], "进度信号不是最终结论");

  // 新 waiter 建立时必须消费已保存的进度信号：立即 partial 放行（不投递）。
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "进度放行绝不投递最终结论");

  // child2 结算 + 新边界：整批静止后一次性投递。
  await completeChild(host, root, children[1]);
  const closing = driveTurnStopping(host, root, 2);
  assert.equal(closing.pending, 1, "剩余 child 必须让新边界继续等待");
  await closing.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 2/);
  await host.dispose();
});

test("重新等待后重放旧通知：已用过的进度资格不得再次放行 waiter", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "replay one", ["docs/replay-one.md"]);
  const second = await startAdmission(host, root, "replay two", ["docs/replay-two.md"]);
  await finalize(host, root, [first, second]);

  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending");

  // child1 结算：首次精确结算消耗一次性进度资格 → 本次等待放行（不投递）。
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "首次进度放行不投递最终结论");

  // 立即建立第二个 turn-stopping（child2 仍在运行），并在同一次同步批次里重放 child1 的
  // 同一条 settlement：复现「重新登记后、静止复查落地前」的竞态窗口。
  const next = driveTurnStopping(host, root, 2);
  assert.equal(next.pending, 1);
  insertNotice(host, root, children[0], "fw-feedback-" + children[0].childId);
  await flushAsyncWork(20);
  assert.equal(next.status, "pending", "重放旧 settlement 不得再次放行 waiter");
  assert.deepEqual(steerMessages(host, root), [], "重放旧 settlement 不得投递结论");

  // child2 完成后收口，且只投递一次。
  await completeChild(host, root, children[1]);
  await next.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 2/);
  await host.dispose();
});

test("无 waiter 时用户新输入必须清理进度信号：旧 credit 不得跨 run 放行", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "newrun one", ["docs/newrun-one.md"]);
  const second = await startAdmission(host, root, "newrun two", ["docs/newrun-two.md"]);
  await finalize(host, root, [first, second]);

  // 不发起 turn-stopping：child1 在「root step 执行期间」结算，形成一笔进度信号。
  await completeChild(host, root, children[0]);
  const midMeta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(midMeta.value.diagnostics.rootTurnWait.outstandingTotal, 1, "child1 必须已精确结算");

  // 公开路径模拟真实用户新输入：agent/inbox/inserted 且 source.kind === "user"
  // （handleInboxFeedback → cancelRootTurnWaitForUserInput）。此刻没有 waiter，但用户输入
  // 开启的是新一轮 run，旧进度信号必须在这里被丢弃。
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: "user-input-1", role: "user", content: [{ type: "text", text: "继续" }], source: { kind: "user" } },
  });
  await flushAsyncWork(12);

  // 新 run 的 turn 边界不得消费上一轮的 credit：child2 仍在运行 → 等待必须保持。
  const stop = driveTurnStopping(host, root, 2);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(16);
  assert.equal(stop.status, "pending", "旧 credit 不得跨 run 放行新 run 的 waiter");
  assert.deepEqual(steerMessages(host, root), [], "跨 run 的放行不得投递结论");

  // child2 完成后正常收口，只投递一次。
  await completeChild(host, root, children[1]);
  await stop.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 2/);
  await host.dispose();
});

test("多个进度信号累积只放行一次：后续边界仍按剩余专家阻塞", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "multi credit one", ["docs/multi-credit-one.md"]);
  const second = await startAdmission(host, root, "multi credit two", ["docs/multi-credit-two.md"]);
  const third = await startAdmission(host, root, "multi credit three", ["docs/multi-credit-three.md"]);
  const waiting = await finalize(host, root, [first, second, third]);
  assert.equal(waiting.acceptedCount, 3);

  // 不发起 turn-stopping：child1、child2 各自在「root step 执行期间」结算，累积两笔信号，
  // works 只剩 child3。
  await completeChild(host, root, children[0]);
  await completeChild(host, root, children[1]);
  const midMeta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(midMeta.value.diagnostics.rootTurnWait.outstandingTotal, 1, "只剩 child3 未结算");

  // 第一个边界消费进度信号：只放行一次、不投递。
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "多个进度信号也只做进度放行，不投递结论");

  // 第二个边界：child3 仍未完成，必须继续等待（不得被残留信号再次放行）。
  const next = driveTurnStopping(host, root, 2);
  assert.equal(next.pending, 1);
  await flushAsyncWork(16);
  assert.equal(next.status, "pending", "剩余专家未完成：第二次边界必须继续等待");

  // child3 完成后收口，只投递一次且 acceptedCount 为 3。
  await completeChild(host, root, children[2]);
  await next.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 3/);
  await host.dispose();
});

test("回退通道先结算、settlement 后到：回退结算不得放行，迟到的精确 settlement 只补一次放行", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "fallback one", ["docs/fallback-one.md"]);
  const second = await startAdmission(host, root, "fallback two", ["docs/fallback-two.md"]);
  await finalize(host, root, [first, second]);

  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending");

  // 只做 child1 的 turn/end + 明确 idle，**不**投递 settlement：让静止复查拿到 known 快照，
  // 由回退通道先结算 child1 的 work（真实 Host 的 settlement 比 turn/end 晚约 0.5s）。
  endChildTurn(host, children[0]);
  quiesceChild(host, children[0]);
  await flushAsyncWork(24);

  const settledMeta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(settledMeta.value.diagnostics.rootTurnWait.outstandingTotal, 1, "回退通道必须已结算 child1 的 work");
  // 安全语义：回退结算时 child1 的 settlement **还没有进入 root 的 next-step**，因此绝不能
  // 放行——否则 turn 会在没有任何新消息的情况下收口（root 进 idle、durable goal round 推进）。
  await flushAsyncWork(16);
  assert.equal(stop.status, "pending", "回退结算不得放行 waiter");
  assert.deepEqual(steerMessages(host, root), [], "回退结算不得投递最终结论");

  // 迟到的精确 settlement：work 已被回退结算，但此刻 settlement 才真正进入 next-step，
  // 由 turn-wait 的「已结算仍放行」分支补一次进度放行（不投递、批次仍 pending-close）。
  insertNotice(host, root, children[0], "fw-feedback-" + children[0].childId);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "迟到的 settlement 只做进度放行，不投递结论");
  assert.equal((await finalize(host, root, [first, second])).kind, "waiting", "进度放行不关闭 pending-close 批次");

  // 重放同一条 settlement：一次性进度资格已用掉，不得二次放行。
  const next = driveTurnStopping(host, root, 2);
  assert.equal(next.pending, 1);
  insertNotice(host, root, children[0], "fw-feedback-" + children[0].childId);
  await flushAsyncWork(20);
  assert.equal(next.status, "pending", "重放旧 settlement 不得二次放行");

  // child2 完成 + 新边界：整批静止后只投递一次。
  await completeChild(host, root, children[1]);
  await next.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 2/);
  await host.dispose();
});

test("只有回退结算、没有 settlement：下一次新边界必须继续 pending，child2 完成后才收口", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "noexact one", ["docs/noexact-one.md"]);
  const second = await startAdmission(host, root, "noexact two", ["docs/noexact-two.md"]);
  await finalize(host, root, [first, second]);

  // 本 turn 结束时取消 waiter（而不是等它被放行）：取消不是完成，批次保持 pending-close。
  const controller = new AbortController();
  const stop = driveTurnStopping(host, root, 1, controller.signal);
  assert.equal(stop.pending, 1);
  await flushAsyncWork(12);
  assert.equal(stop.status, "pending");

  // 只做 child1 的 turn/end + 明确 idle，**不**投递 settlement —— 回退通道结算它的 work。
  endChildTurn(host, children[0]);
  quiesceChild(host, children[0]);
  await flushAsyncWork(24);
  const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(meta.value.diagnostics.rootTurnWait.outstandingTotal, 1, "回退结算只推进登记集");

  controller.abort();
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "回退结算 + 取消都不得投递结论");

  // 关键反例：settlement 始终不到，新边界必须继续 pending——回退结算绝不能空放行。
  const next = driveTurnStopping(host, root, 2);
  assert.equal(next.pending, 1);
  await flushAsyncWork(24);
  assert.equal(next.status, "pending", "没有 settlement 时回退结算不得放行新边界");
  assert.deepEqual(steerMessages(host, root), [], "空放行不得投递结论");

  // child2 完成后才收口：child1 的 work 已被回退结算，最后一个 child 走 quiescent 一次性投递。
  await completeChild(host, root, children[1]);
  await next.settled;
  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1, "整批静止后只投递一次收口结论");
  assert.match(messages[0].content.map((block) => block.text).join(""), /acceptedCount 2/, "终态结论必须表达整批 acceptedCount");
  await host.dispose();
});

// ── 5. 投递语义：DEG 来源、非 settlement、非 Toast ───────────────────────────

test("终态投递是 DEG 插件来源的模型上下文消息，不是 child settlement，也不触发系统 Toast", async () => {
  const toastSpy = installToastSpy();
  const { host, root, children } = createHost({ toastSpy });
  const outcome = await startAdmission(host, root, "delivery shape");
  await finalize(host, root, outcome);
  const stop = driveTurnStopping(host, root);
  await completeChild(host, root, children[0]);
  await stop.settled;

  const messages = steerMessages(host, root);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.role, "user", "steer 投递的是 user 角色消息");
  assert.equal(typeof message.id, "string");
  assert.ok(message.id.length > 0, "消息必须有稳定身份");
  assert.equal(message.source.kind, PRODUCER_SOURCE_KIND, "来源必须是 DEG 生产者自有 kind");
  assert.notEqual(message.source.kind, "subagent-settled", "绝不允许伪装成 child settlement");
  const text = message.content.map((block) => block.text).join("");
  assert.match(text, /finalized/i);
  assert.match(text, new RegExp("admissionEpoch " + outcome.admissionEpoch));
  assert.match(text, /acceptedCount 1/);
  assert.doesNotMatch(text, HOST_SETTLEMENT_PREFIX, "插件消息不得撞上 Host 自动完成通知前缀");
  assert.deepEqual(toastSpy.shows, [], "插件内部收口结论不得触发系统 Toast");
  await host.dispose();
});

test("终态投递不会被 DEG 识别成 child settlement：另一批 admission 不会因它被结算", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "first batch", ["docs/first-batch.md"]);
  await finalize(host, root, first);
  const firstStop = driveTurnStopping(host, root, 1);
  await completeChild(host, root, children[0]);
  await firstStop.settled;
  const delivered = steerMessages(host, root)[0];
  assert.ok(delivered, "第一批必须投递终态结论");

  // 第二批：新的 admission + 新的 epoch，仍未结束。
  const second = await startAdmission(host, root, "second batch", ["docs/second-batch.md"]);
  assert.ok(second.admissionEpoch > first.admissionEpoch);
  await finalize(host, root, second);
  const secondStop = driveTurnStopping(host, root, 2);
  await flushAsyncWork(12);
  assert.equal(secondStop.status, "pending");

  // 把第一批的投递消息按真实形状重放到 root 的 next-step spliced 通道：
  // 它是 DEG 来源，不是 child settlement，绝不能结算第二批的 admission。
  host.emit("session/event", root.session, {
    seq: 8801,
    type: "agent/inbox/spliced",
    data: { target: "next-step", inserted: [{ message: delivered }] },
  });
  await flushAsyncWork(12);
  assert.equal(secondStop.status, "pending", "插件来源消息不得被当作专家完成");
  await completeChild(host, root, children[1]);
  await secondStop.settled;
  assert.equal(steerMessages(host, root).length, 2, "第二批静止后各自投递一次");
  await host.dispose();
});

// ── 6. 契约面：schema / description / renderer ───────────────────────────────

test("finalize 工具契约：kind 枚举含 waiting，说明把继续等待定位到 turn-stopping 边界", async () => {
  const { host, root } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");
  assert.ok(definition, "finalize 工具必须已注册");
  const kinds = definition.output.schema?.properties?.kind;
  const values = Array.isArray(kinds?.enum) ? kinds.enum : (Array.isArray(kinds?.anyOf) ? kinds.anyOf.map((item) => item?.const ?? item?.enum?.[0]) : []);
  assert.ok(values.includes("waiting"), "输出 schema 必须声明非终态 waiting 回执: " + JSON.stringify(kinds));
  assert.ok(!values.includes("finalized"), "终态结论只通过后续上下文消息表达，不得保留为工具返回 kind");
  assert.match(definition.description, /waiting/i, "工具说明必须描述 waiting 回执");
  assert.match(definition.description, /turn-stopping/i, "工具说明必须把继续等待定位到 root turn 边界");

  const outcome = await startAdmission(host, root, "renderer probe");
  const waiting = await finalize(host, root, outcome);
  const rendered = definition.output.render(null, waiting).map((block) => block.text).join("\n");
  assert.match(rendered, /experts-running/, "渲染必须回显稳定 reason 码");
  assert.match(rendered, /acceptedCount 1|1 accepted/, "渲染必须让模型看到已登记的 accepted 数量");
  await host.dispose();
});

test("前置校验仍立即 rejected、无 admission 仍 noop，空 token 集不再阻塞收口", async () => {
  const { host, root } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");
  const noop = await definition.execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    { agent: root },
  );
  assert.equal(noop.kind, "noop");
  assert.equal(noop.reason, "no-admission");

  const outcome = await startAdmission(host, root, "preflight probe");
  const rejectedSummary = await definition.execute(
    { admissionEpoch: outcome.admissionEpoch, admissionTokens: [outcome.admissionToken], summaryCompleted: false, outcomesChecked: true, safeParallelWork: false },
    { agent: root },
  );
  assert.equal(rejectedSummary.kind, "rejected");
  assert.equal(rejectedSummary.reason, "summary-or-outcome-check-required");
  const rejectedParallel = await definition.execute(
    { admissionEpoch: outcome.admissionEpoch, admissionTokens: [outcome.admissionToken], summaryCompleted: true, outcomesChecked: true, safeParallelWork: true },
    { agent: root },
  );
  assert.equal(rejectedParallel.reason, "safe-parallel-work-remains");
  // 空 token 集 / 完全不传 token 不再阻止收口（票据 10）：批次定位键与收口集合都由服务端
  // 枚举，token 只是可选诊断。这里同时验证「不传 token 也能登记 waiting」。
  const epochOnly = await finalizeEpochOnly(host, root, outcome.admissionEpoch);
  assert.equal(epochOnly.kind, "waiting", "空 token 集不得再被判为不完整");
  assert.equal(epochOnly.reason, "experts-running");
  assert.equal(epochOnly.acceptedCount, 1);
  assert.deepEqual(epochOnly.tokenDiagnostics, {
    provided: 0,
    expected: 1,
    missing: [outcome.admissionToken],
    unknown: [],
    duplicates: [],
    invalid: 0,
    ignored: 0,
  }, "缺失 token 只做诊断，不阻塞收口");
  const stale = await definition.execute(
    { admissionEpoch: outcome.admissionEpoch + 99, admissionTokens: [outcome.admissionToken], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    { agent: root },
  );
  assert.equal(stale.kind, "rejected");
  assert.equal(stale.reason, "admission-epoch-mismatch");
  assert.ok(stale.message.length > 0, "拒绝必须带可执行 message");
  assert.deepEqual(steerMessages(host, root), [], "登记等待与拒绝都不会投递终态结论");
  await host.dispose();
});

// ── 7. 超过 PTC 预算的可控虚拟时间覆盖 ──────────────────────────────────────

test("虚拟时钟：超过 600000ms 的等待里 finalize 早已完成，收口只由 turn-stopping 承担", async () => {
  const clock = installVirtualClock();
  try {
    const { host, root, children } = createHost();
    const outcome = await startAdmission(host, root, "long running expert");
    const startNow = Date.now();
    // finalize 必须在不推进任何虚拟时间的情况下完成：它不在工具调用内等待。
    const waiting = await finalize(host, root, outcome);
    assert.equal(waiting.kind, "waiting");
    assert.equal(Date.now(), startNow, "finalize 回执不得消耗任何虚拟（更不消耗真实）等待时间");

    const stop = driveTurnStopping(host, root);
    assert.equal(stop.pending, 1);
    // 一次性推进 10 分钟以上（run_code 的 PTC 预算量级），真实墙钟几乎不花时间。
    for (let step = 0; step < 12; step += 1) {
      clock.advance(60 * 1000);
      await flushAsyncWork(6);
      assert.equal(waiting.kind, "waiting", "finalize 的回执不因时间推进而改变");
      assert.equal(stop.status, "pending", "专家仍在运行时等待必须保持，且不依赖任何 deadline");
    }
    assert.ok(clock.now - startNow > 600000, "虚拟时间必须已经超过 600000ms: " + clock.now);
    assert.deepEqual(steerMessages(host, root), [], "长时间运行期间绝不提前投递结论");

    // 专家真正结束后，同一次 turn-stopping 等待完成一次性收口。
    await completeChild(host, root, children[0]);
    await stop.settled;
    assert.equal(steerMessages(host, root).length, 1);
    await host.dispose();
  } finally {
    clock.restore();
  }
});
// ── 8. 整批语义（票据 10）：批次定位键 + 可选诊断 token ─────────────────────

test("只传 admissionEpoch、完全不传 admissionTokens：整批收口登记等待，缺失 token 不阻塞", async () => {
  const { host, root, children } = createHost();
  const first = await startAdmission(host, root, "batch semantics one", ["docs/batch-one.md"]);
  const second = await startAdmission(host, root, "batch semantics two", ["docs/batch-two.md"]);
  const waiting = await finalizeEpochOnly(host, root, first.admissionEpoch);
  assert.equal(waiting.kind, "waiting", "定位键足够时必须能收口整批");
  assert.equal(waiting.reason, "experts-running");
  assert.equal(waiting.acceptedCount, 2, "收口集合由服务端枚举，不需要调用方枚举 token");
  assert.deepEqual(waiting.tokenDiagnostics, {
    provided: 0,
    expected: 2,
    missing: [first.admissionToken, second.admissionToken],
    unknown: [],
    duplicates: [],
    invalid: 0,
    ignored: 0,
  }, "缺失 token 只做诊断，不阻塞收口");
  assert.equal(children[0].child.status, "running", "waiting 仍是非终态回执");
  assert.deepEqual(steerMessages(host, root), [], "登记阶段绝不投递结论");

  // 登记账本的不变量：epoch-only 收口同样必须让 turn-stopping 参与同一张等待账本。
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1, "epoch-only 收口必须登记到 root turn 等待账本");
  await flushAsyncWork(8);
  assert.equal(stop.status, "pending", "专家未结束时等待必须保持");
  // 第一个专家结算 → 进度放行（本次等待收口，但不是最终结论）。
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.deepEqual(steerMessages(host, root), [], "进度放行不投递最终结论");
  // 同一 turn 下一个 step 之后的边界：剩余专家仍未结束 → 继续等待。
  const remaining = driveTurnStopping(host, root, 2);
  assert.equal(remaining.pending, 1, "剩余工作必须继续阻塞 root turn");
  await flushAsyncWork(8);
  assert.equal(remaining.status, "pending");
  await completeChild(host, root, children[1]);
  await remaining.settled;
  assert.equal(steerMessages(host, root).length, 1, "整批静止后只投递一次收口结论");
  await host.dispose();
});

test("waiting 立即返回（无 await）：不消耗任何定时器，返回时账本已可被 turn-stopping 观察到", async () => {
  const { host, root, children } = createHost();
  const outcome = await startAdmission(host, root, "no-await invariant");
  const promise = finalizeEpochOnly(host, root, outcome.admissionEpoch);
  // 任何宏任务都会让 finalize 输掉竞速；它只做同步校验 + 登记，因此必然先完成。
  const raced = await Promise.race([
    promise.then((value) => ({ kind: "receipt", value })),
    new Promise((resolve) => { const timer = setTimeout(() => resolve({ kind: "timer" }), 0); timer.unref?.(); }),
  ]);
  assert.equal(raced.kind, "receipt", "finalize 不得在工具调用内等待专家");
  assert.equal(raced.value.kind, "waiting");
  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1, "回执返回时等待账本必须已经登记");
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.equal(steerMessages(host, root).length, 1);
  await host.dispose();
});

test("多余、重复、未知、非字符串 token：仍 waiting，tokenDiagnostics 如实回报且不改变收口集合", async () => {
  const { host, root, children } = createHost();
  const accepted = await startAdmission(host, root, "diagnostic tokens", ["docs/diag-tokens.md"]);
  // 未知 childId 的内部 ticket 被 discardRootAdmission 丢弃：它从未把凭据交给调用方，
  // 因此不得进入有效集合（expected），更不得毒化批次。
  const discarded = await host.toolDefinition("explorer").execute(
    { description: "discarded", prompt: "discarded", childId: "fw-child-missing", affectedPaths: ["docs/discarded.md"] },
    { agent: root },
  );
  assert.equal(discarded.kind, "rejected");
  assert.equal(discarded.code, "CHILD_NOT_FOUND");

  const waiting = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken, accepted.admissionToken, "999:never-issued", 42, null],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(waiting.kind, "waiting", "诊断条目永远不阻塞收口");
  assert.equal(waiting.acceptedCount, 1, "重复/未知/非法条目不得改变收口集合");
  assert.deepEqual(waiting.tokenDiagnostics, {
    provided: 5,
    expected: 1,
    missing: [],
    unknown: ["999:never-issued"],
    duplicates: [accepted.admissionToken],
    invalid: 2,
    ignored: 4,
  }, "未知与重复有界上报，非字符串只计数，discarded ticket 不在 expected 里");

  // 有界性：超过 32 条的未知 token 只保留前 32 条，其余仅在计数里体现；渲染文本不展开明细。
  const manyUnknown = Array.from({ length: 40 }, (_, index) => "999:bulk-" + index);
  const bounded = await host.toolDefinition("dsh_expert_group_finalize").execute({
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: manyUnknown,
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: root });
  assert.equal(bounded.kind, "waiting");
  assert.equal(bounded.tokenDiagnostics.unknown.length, 32, "unknown 数组最多 32 条");
  assert.equal(bounded.tokenDiagnostics.ignored, 40, "超出上限的条目只计数");
  const boundedText = host.toolDefinition("dsh_expert_group_finalize").output.render(null, bounded)
    .map((block) => block.text).join("\n");
  assert.doesNotMatch(boundedText, /999:bulk-/, "渲染文本不得展开 token 明细");

  const stop = driveTurnStopping(host, root);
  assert.equal(stop.pending, 1);
  await completeChild(host, root, children[0]);
  await stop.settled;
  assert.equal(steerMessages(host, root).length, 1);
  await host.dispose();
});

test("空数组与非字符串条目都不阻塞：空数组按整批有效集合收口，invalid 只计数", async () => {
  const { host, root } = createHost();
  const first = await startAdmission(host, root, "empty tokens one", ["docs/empty-one.md"]);
  const second = await startAdmission(host, root, "empty tokens two", ["docs/empty-two.md"]);

  const empty = await finalizeEpochOnly(host, root, first.admissionEpoch, { admissionTokens: [] });
  assert.equal(empty.kind, "waiting");
  assert.equal(empty.acceptedCount, 2);
  assert.equal(empty.tokenDiagnostics.provided, 0);
  assert.equal(empty.tokenDiagnostics.expected, 2);
  assert.deepEqual(empty.tokenDiagnostics.missing, [first.admissionToken, second.admissionToken]);

  // 非字符串条目：DSH 入参校验放行后由 handler 计数为 invalid，不影响有效集合。
  const invalidOnly = await finalizeEpochOnly(host, root, first.admissionEpoch, { admissionTokens: [42] });
  assert.equal(invalidOnly.kind, "waiting");
  assert.equal(invalidOnly.acceptedCount, 2);
  assert.deepEqual(
    { provided: invalidOnly.tokenDiagnostics.provided, invalid: invalidOnly.tokenDiagnostics.invalid, ignored: invalidOnly.tokenDiagnostics.ignored },
    { provided: 1, invalid: 1, ignored: 1 },
  );
  await host.dispose();
});

test("无批次、错误 epoch、非法 epoch 形态、旧 epoch 各自 rejected 码 + 非空 message", async () => {
  const { host, root, children } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");

  // 1) 无批次：非零 epoch 没有可定位的批次。
  const noBatch = await definition.execute({
    admissionEpoch: 7, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false,
  }, { agent: root });
  assert.equal(noBatch.kind, "rejected");
  assert.equal(noBatch.reason, "no-admission-batch");
  assert.match(noBatch.message, /7/);

  // 2) 错误 epoch：批次仍开放时传入别的代次。
  const outcome = await startAdmission(host, root, "epoch probe");
  const mismatch = await definition.execute({
    admissionEpoch: outcome.admissionEpoch + 99, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false,
  }, { agent: root });
  assert.equal(mismatch.reason, "admission-epoch-mismatch");
  assert.match(mismatch.message, new RegExp(String(outcome.admissionEpoch)));

  // 3) 非法 epoch 形态（number 但不是整数）：稳定 reason，不进入批次比较。
  const invalidEpoch = await definition.execute({
    admissionEpoch: 1.5, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false,
  }, { agent: root });
  assert.equal(invalidEpoch.reason, "invalid-admission-epoch");
  assert.ok(invalidEpoch.message.length > 0);

  // 4) 旧 epoch：先正常收口第一批；迟到 admission 开出新批次并同样收口后，再拿第一批的
  //    代次调用就是真正的过期凭据（当前批次已关闭）→ stale-admission-epoch。
  await finalizeEpochOnly(host, root, outcome.admissionEpoch);
  const stop = driveTurnStopping(host, root);
  await completeChild(host, root, children[0]);
  await stop.settled;

  const late = await startAdmission(host, root, "late epoch", ["docs/late-epoch.md"]);
  assert.ok(late.admissionEpoch > outcome.admissionEpoch, "迟到 admission 必须打开新 epoch");
  await finalizeEpochOnly(host, root, late.admissionEpoch);
  const lateStop = driveTurnStopping(host, root, 2);
  await completeChild(host, root, children[1]);
  await lateStop.settled;

  const stale = await definition.execute({
    admissionEpoch: outcome.admissionEpoch, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false,
  }, { agent: root });
  assert.equal(stale.kind, "rejected");
  assert.equal(stale.reason, "stale-admission-epoch");
  assert.ok(stale.message.length > 0);

  // 渲染文本必须同时带出机器码与可执行提示。
  const rendered = definition.output.render(null, stale).map((block) => block.text).join("\n");
  assert.match(rendered, /stale-admission-epoch/);
  assert.ok(rendered.includes(stale.message), "渲染文本必须包含 message");
  await host.dispose();
});

test("每个 rejected 分支都有稳定 reason 码与非空 message，渲染文本同时包含两者", async () => {
  const { host, root } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");
  const cases = [
    { args: { admissionEpoch: 0, summaryCompleted: false, outcomesChecked: true, safeParallelWork: false }, reason: "summary-or-outcome-check-required" },
    { args: { admissionEpoch: 0, summaryCompleted: true, outcomesChecked: true, safeParallelWork: true }, reason: "safe-parallel-work-remains" },
    { args: { admissionEpoch: 1.5, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false }, reason: "invalid-admission-epoch" },
    { args: { admissionEpoch: 11, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false }, reason: "no-admission-batch" },
  ];
  for (const entry of cases) {
    const receipt = await definition.execute(entry.args, { agent: root });
    assert.equal(receipt.kind, "rejected", entry.reason);
    assert.equal(receipt.reason, entry.reason);
    assert.equal(typeof receipt.message, "string");
    assert.ok(receipt.message.length > 0, entry.reason + " 必须带可执行 message");
    const rendered = definition.output.render(null, receipt).map((block) => block.text).join("\n");
    assert.match(rendered, new RegExp(entry.reason), "渲染文本必须回显 reason 码");
    assert.ok(rendered.includes(receipt.message), "渲染文本必须回显 message: " + entry.reason);
  }
  await host.dispose();
});

test("错误 root 调用 finalize 返回 rejected root-only 回执，不再抛异常", async () => {
  const { host, root } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");
  const fakeChild = { id: "fw-child-finalizer", session: { header: { parentSession: root.id } } };
  const receipt = await definition.execute({
    admissionEpoch: 3, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false,
  }, { agent: fakeChild });
  assert.equal(receipt.kind, "rejected");
  assert.equal(receipt.reason, "root-only");
  assert.ok(receipt.message.length > 0);
  assert.equal(receipt.admissionEpoch, 3);
  const rendered = definition.output.render(null, receipt).map((block) => block.text).join("\n");
  assert.match(rendered, /root-only/);
  assert.ok(rendered.includes(receipt.message));
  await host.dispose();
});

test("存在未 settle 的 admission 时仍 rejected admission-outcome-pending（不传 token 也不放行）", async () => {
  const { host, root, children } = createHost({ holdSecondStart: true });
  const settled = await startAdmission(host, root, "settled lane", ["docs/pending-one.md"]);
  // 第二次派发永久挂起：admission 已 begin，但 outcome 永远不会 settle。
  const hanging = startAdmission(host, root, "hanging lane", ["docs/pending-two.md"]);
  hanging.catch(() => {});
  await flushAsyncWork(8);
  const rejected = await finalizeEpochOnly(host, root, settled.admissionEpoch);
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.reason, "admission-outcome-pending");
  assert.match(rejected.message, /1 个 admission/);
  assert.equal(children.length, 1, "挂起的 lane 尚未创建 child");
  await host.dispose();
});

test("纯 continue_parent_turn 批次仍 rejected continue-parent-turn（不传 token 也拒绝）", async () => {
  const { host, root } = createHost();
  const continued = await host.toolDefinition("explorer").execute({
    description: "pure continue",
    prompt: "pure continue",
    continue_parent_turn: true,
    affectedPaths: ["docs/pure-continue.md"],
  }, { agent: root });
  assert.equal(continued.kind, "continuable");
  assert.equal(continued.accepted, true);
  const rejected = await finalizeEpochOnly(host, root, continued.admissionEpoch);
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.reason, "continue-parent-turn");
  assert.ok(rejected.message.length > 0);
  await host.dispose();
});

test("finalize 契约：admissionTokens 可选，输出 schema 声明 tokenDiagnostics 且保持 additionalProperties:false", async () => {
  const { host } = createHost();
  const definition = host.toolDefinition("dsh_expert_group_finalize");
  const required = Array.isArray(definition.parameters?.required) ? definition.parameters.required : [];
  assert.ok(required.includes("admissionEpoch"), "admissionEpoch 仍是必填的批次定位键");
  assert.equal(required.includes("admissionTokens"), false, "admissionTokens 不得再是必填参数");
  assert.ok(definition.parameters.properties?.admissionTokens, "admissionTokens 仍必须可传入（诊断）");

  const schema = definition.output.schema;
  assert.equal(schema.additionalProperties, false, "输出 schema 必须保持 additionalProperties:false");
  const diagnostics = schema.properties?.tokenDiagnostics;
  assert.ok(diagnostics, "输出 schema 必须声明可选 tokenDiagnostics");
  assert.equal(diagnostics.type, "object");
  assert.equal(diagnostics.additionalProperties, false);
  assert.deepEqual(
    [...(diagnostics.required ?? [])].sort(),
    ["duplicates", "expected", "ignored", "invalid", "missing", "provided", "unknown"],
  );
  for (const key of ["missing", "unknown", "duplicates"]) {
    assert.equal(diagnostics.properties[key].type, "array", key + " 必须是有界字符串数组");
    assert.equal(diagnostics.properties[key].items.type, "string");
  }
  await host.dispose();
});


// ── 9. 票据 11：等待账本可观测性、人工逃生与一次性提示 ─────────────────────────

/** 取 abandon_wait 工具定义（未注册时返回 undefined，用例显式断言）。 */
function abandonWaitTool(host) {
  return host.toolDefinition("dsh_expert_group_abandon_wait");
}

test("abandon_wait：拒绝路径稳定原因码（root-only / no-open-batch / descendants-active / descendant-query-unknown）", async () => {
  const first = createHost();
  try {
    const definition = abandonWaitTool(first.host);
    assert.ok(definition, "dsh_expert_group_abandon_wait 必须真实注册");
    const noBatch = await definition.execute({ reason: "manual" }, { agent: first.root });
    assert.equal(noBatch.kind, "rejected");
    assert.equal(noBatch.reason, "no-open-batch");
    assert.ok(noBatch.message.length > 0, "拒绝必须带可执行 message");
    const rendered = definition.output.render(null, noBatch).map((block) => block.text).join("\n");
    assert.match(rendered, /no-open-batch/);
    assert.ok(rendered.includes(noBatch.message));

    // 专家 child（非 root）不得关闭等待账本。
    const fakeChild = { id: "fw-child-abandoner", session: { header: { parentSession: first.root.id } } };
    assert.equal((await definition.execute({ reason: "manual" }, { agent: fakeChild })).reason, "root-only");
    // 空 reason 是稳定回执，不是异常。
    assert.equal((await definition.execute({ reason: "   " }, { agent: first.root })).reason, "invalid-reason");

    // 权威查询看到运行中的后代：拒绝，且只回数量、不回任何 id。
    await startAdmission(first.host, first.root, "abandon active", ["docs/abandon-active.md"]);
    const active = await definition.execute({ reason: "manual" }, { agent: first.root });
    assert.equal(active.kind, "rejected");
    assert.equal(active.reason, "descendants-active");
    assert.equal(active.activeCount, 1);
    assert.equal(JSON.stringify(active).includes(first.children[0].childId), false, "拒绝回执不得携带 child id");
  } finally {
    await first.host.dispose();
  }

  // 后代查询抛错：未知一律拒绝，且批次保持开放（finalize 仍是稳定 waiting）。
  const unknownHost = createHost({ descendantListing: "throw" });
  try {
    const definition = abandonWaitTool(unknownHost.host);
    const outcome = await startAdmission(unknownHost.host, unknownHost.root, "abandon unknown", ["docs/abandon-unknown.md"]);
    await finalize(unknownHost.host, unknownHost.root, outcome);
    const unknown = await definition.execute({ reason: "manual" }, { agent: unknownHost.root });
    assert.equal(unknown.kind, "rejected");
    assert.equal(unknown.reason, "descendant-query-unknown");
    assert.equal(unknown.descendantReason, "descendant-listing-failed", "未知必须附带稳定底层原因码");
    assert.equal(unknown.outstanding, 0);
    assert.equal((await finalize(unknownHost.host, unknownHost.root, outcome)).kind, "waiting", "拒绝不得关闭批次");
  } finally {
    await unknownHost.host.dispose();
  }
});

test("abandon_wait：权威查询明确无运行后代时关闭等待批次，且不释放 scope、不改 child/fanout", async () => {
  const { host, root, children } = createHost();
  try {
    const outcome = await startAdmission(host, root, "abandon success", ["docs/abandon-success.md"]);
    assert.equal((await finalize(host, root, outcome)).kind, "waiting");
    // child 明确 idle，但**不**发 turn/end 与 settlement：admission 仍未结算、影响范围
    // 保护仍持有。这正是「账本一直等一个已经静默的 child」的人工逃生场景。
    host.setAgentStatus(children[0].child, "idle");
    await flushAsyncWork(12);
    const stop = driveTurnStopping(host, root);
    assert.equal(stop.pending, 1);
    await flushAsyncWork(8);
    assert.equal(stop.status, "pending", "未结算 admission 必须继续阻塞 root turn");

    const before = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const waitBefore = before.value.diagnostics.rootTurnWait;
    assert.equal(waitBefore.outstandingTotal, 1, "诊断必须暴露未结算工作数");
    assert.equal(waitBefore.rootCount, 1);
    assert.equal(waitBefore.abandonedCount, 0);
    assert.equal(waitBefore.lastDelivery, null);
    assert.deepEqual(waitBefore.capability, { available: 1, degraded: 0, unavailable: 0 });
    // 最早等待时长必须可观测，且与有界 roots 摘要一致（同一次 describeAll 采样）。
    assert.equal(typeof waitBefore.oldestWaitedMs, "number");
    assert.ok(waitBefore.oldestWaitedMs >= 0);
    assert.equal(waitBefore.roots.length, 1);
    assert.equal(waitBefore.roots[0].waitedMs, waitBefore.oldestWaitedMs);
    assert.equal(waitBefore.roots[0].outstanding, 1);
    assert.equal(waitBefore.roots[0].capability, "available");
    assert.equal(typeof waitBefore.roots[0].waitedMs, "number");
    assert.equal("rootId" in waitBefore.roots[0], false, "roots 摘要不得携带 id");
    const scopeBefore = before.value.diagnostics.delegation.activeScopeCount;
    assert.ok(scopeBefore >= 1, "admission 的 affectedPaths 保护必须仍持有");
    const fanoutBefore = {
      tasks: before.value.diagnostics.fanout.tasks,
      activeAttempts: before.value.diagnostics.fanout.activeAttempts,
    };
    const childStatusBefore = children[0].child.status;

    const abandoned = await abandonWaitTool(host).execute(
      { reason: "权威查询确认没有运行中的后代" },
      { agent: root },
    );
    assert.equal(abandoned.kind, "wait-abandoned");
    assert.equal(abandoned.admissionEpoch, outcome.admissionEpoch);
    assert.equal(abandoned.outstanding, 1);
    assert.ok(Number.isSafeInteger(abandoned.abandonedAt) && abandoned.abandonedAt > 0);
    await stop.settled;
    assert.deepEqual(steerMessages(host, root), [], "人工逃生绝不投递收口结论");
    assert.equal(children[0].child.status, childStatusBefore, "人工逃生不得改动 child 状态");
    assert.equal(children.length, 1);

    const after = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(after.value.diagnostics.delegation.activeScopeCount, scopeBefore, "人工逃生不得释放影响范围保护");
    assert.deepEqual(
      {
        tasks: after.value.diagnostics.fanout.tasks,
        activeAttempts: after.value.diagnostics.fanout.activeAttempts,
      },
      fanoutBefore,
      "人工逃生不得改动 fanout manager",
    );
    assert.equal(after.value.diagnostics.rootTurnWait.abandonedCount, 1);
    assert.equal(after.value.diagnostics.rootTurnWait.rootCount, 0);
    assert.equal(after.value.diagnostics.rootTurnWait.outstandingTotal, 0);

    const repeatFinalize = await finalize(host, root, outcome);
    assert.equal(repeatFinalize.kind, "noop");
    assert.equal(repeatFinalize.reason, "already-finalized");

    const repeatTurn = driveTurnStopping(host, root, 2);
    await flushAsyncWork(8);
    assert.equal(repeatTurn.pending, 0, "abandoned 批次不得再次悬挂 root turn");
    assert.deepEqual(steerMessages(host, root), []);
  } finally {
    await host.dispose();
  }
});

test("投递失败：steer 抛错记录 lastDelivery 并一次性提示，批次保持 pending-close 直到后续成功", async () => {
  const toastSpy = installToastSpy();
  const { host, root, children } = createHost({ toastSpy });
  const failureToasts = () => toastSpy.shows.filter((show) => show.body.includes("收口结论投递失败"));
  try {
    const outcome = await startAdmission(host, root, "delivery failure", ["docs/delivery-failure.md"]);
    await finalize(host, root, outcome);
    const originalSteer = root.steer;
    root.steer = () => { throw new Error("steer boom"); };

    const first = driveTurnStopping(host, root, 1);
    await completeChild(host, root, children[0]);
    await first.settled;
    assert.deepEqual(steerMessages(host, root), [], "抛错的 steer 不算投递");
    let meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const delivery = meta.value.diagnostics.rootTurnWait.lastDelivery;
    assert.equal(delivery.ok, false);
    assert.equal(delivery.reason, "steer-failed");
    assert.equal(typeof delivery.at, "number");
    assert.equal(failureToasts().length, 1, "投递失败必须一次性提示");

    // 批次保持 pending-close：结论还没有进入模型上下文。
    assert.equal((await finalize(host, root, outcome)).kind, "waiting");

    // 下一个 turn 仍失败：同一 root+reason 不得重复刷屏。
    const second = driveTurnStopping(host, root, 2);
    await flushAsyncWork(16);
    await second.settled;
    assert.equal(failureToasts().length, 1, "同一投递失败只提示一次");

    // 恢复 steer：后续 turn 成功投递并关闭批次。
    root.steer = originalSteer;
    const third = driveTurnStopping(host, root, 3);
    await flushAsyncWork(16);
    await third.settled;
    assert.equal(steerMessages(host, root).length, 1, "恢复后只投递一次");
    meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.diagnostics.rootTurnWait.lastDelivery.ok, true);
    assert.equal(meta.value.diagnostics.rootTurnWait.lastDelivery.reason, "delivered");
    assert.equal((await finalize(host, root, outcome)).kind, "noop");
  } finally {
    await host.dispose();
  }
});

test("后代查询降级：不再弹系统通知，等待保持 fail-closed，诊断能力等级为 degraded", async () => {
  const toastSpy = installToastSpy();
  const { host, root, children } = createHost({ toastSpy, descendantListing: "throw" });
  // 后代查询降级的系统通知已按产品要求移除：此处断言"零通知"，同时继续断言账本语义
  // 与可观测性未变——等待仍 fail-closed，capabilityLevel 仍如实投影为 degraded。
  // 账本侧 descendant-query-degraded issue 的产生由 test/turn-wait-observability.test.mjs 覆盖。
  const degradedToasts = () => toastSpy.shows.filter((show) => String(show.body ?? "").includes("后代查询降级或失败"));
  try {
    const outcome = await startAdmission(host, root, "degraded query", ["docs/degraded-query.md"]);
    await finalize(host, root, outcome);
    const stop = driveTurnStopping(host, root);
    assert.equal(stop.pending, 1);
    await flushAsyncWork(16);
    assert.equal(stop.status, "pending", "查询降级绝不能放行等待");
    assert.equal(degradedToasts().length, 0, "后代查询降级不再产生系统通知");
    assert.equal(toastSpy.shows.length, 0, "降级路径不得产生任何系统通知");
    assert.deepEqual(steerMessages(host, root), []);

    // 多次活动事件触发重复查询：既不再提示，也不改变等待结论（issue 去重仍在账本内生效）。
    for (let index = 0; index < 3; index += 1) {
      host.emit("agent/status", { agent: children[0].child, status: "running" });
      await flushAsyncWork(8);
    }
    assert.equal(degradedToasts().length, 0, "重复查询同样不产生通知");
    assert.equal(toastSpy.shows.length, 0);
    assert.equal(stop.status, "pending");

    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.deepEqual(meta.value.diagnostics.rootTurnWait.capability, {
      available: 0,
      degraded: 1,
      unavailable: 0,
    }, "诊断必须如实暴露后代查询能力等级");
    assert.equal(meta.value.diagnostics.rootTurnWait.roots[0].capability, "degraded");
  } finally {
    await host.dispose();
  }
});

test("长等待：30/60/90 分钟不再弹系统通知，且绝不自动释放 root turn 等待", async () => {
  const clock = installVirtualClock();
  const toastSpy = installToastSpy();
  // 长等待的系统通知已按产品要求移除：30 分钟定时器、onLongWait 注入点与
  // reminderCount / lastReminderAt 诊断全部保留，只是插件不再把它们投递成通知。
  // 账本侧的 30/60/90 提醒节奏由 test/turn-wait-observability.test.mjs 断言。
  const longToasts = () => toastSpy.shows.filter((show) => String(show.body ?? "").includes("等待超过 30 分钟"));
  try {
    const { host, root, children } = createHost({ toastSpy });
    const outcome = await startAdmission(host, root, "long wait reminder", ["docs/long-wait.md"]);
    await finalize(host, root, outcome);
    const stop = driveTurnStopping(host, root);
    assert.equal(stop.pending, 1);
    await flushAsyncWork(8);
    assert.equal(stop.status, "pending");
    assert.equal(longToasts().length, 0, "不足 30 分钟不得提醒");

    clock.advance(30 * 60 * 1000);
    await flushAsyncWork(8);
    assert.equal(longToasts().length, 0, "满 30 分钟也不再弹系统通知");
    assert.equal(toastSpy.shows.length, 0);
    assert.equal(stop.status, "pending", "长等待边界绝不释放等待");

    // 分两次各推进 30 分钟：60/90 分钟边界同样只保留诊断，不再有任何用户可见提示。
    clock.advance(30 * 60 * 1000);
    await flushAsyncWork(8);
    assert.equal(longToasts().length, 0, "60 分钟边界同样不提醒");
    clock.advance(30 * 60 * 1000);
    await flushAsyncWork(8);
    assert.equal(longToasts().length, 0, "90 分钟边界同样不提醒");
    assert.equal(toastSpy.shows.length, 0, "长等待全程不得产生任何系统通知");
    assert.equal(stop.status, "pending", "长时间等待也绝不自动超时释放");
    assert.deepEqual(steerMessages(host, root), []);
    assert.equal(children[0].child.status, "running");

    await completeChild(host, root, children[0]);
    await stop.settled;
    assert.equal(steerMessages(host, root).length, 1, "专家真正结束后仍按原语义一次性收口");
  } finally {
    clock.restore();
  }
});
