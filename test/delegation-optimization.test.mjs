/**
 * 回归测试：专家委派优化（父代理唯一编排 / 禁止孙代理 / 同父同角色去重与复用）。
 *
 * 本文件只通过公开行为 seam 断言，不读取 index.js/client-entry.js/orchestrator.js 的源码
 * 文本，不做源码文本切片，也不借动态求值重建生产函数：
 * 1. shared.js / prompt-contracts.js / orchestrator.js 的公开导出（tracker 原语、
 *    affectedPaths 归一化、admission helper、role tool 描述、root 编排提示词）；
 * 2. 真实 plugin.apply 注册出的角色工具：执行 toolDefinition(role).execute，观察
 *    subagents.startContinuable / interrupt / sendMessage 收到的公开 request、
 *    工具返回值、storage child_models 记录与（必须为零的）GoalService 调用；
 * 3. Host harness 公开面：toolNames / toolDefinition / guards / sections / storage /
 *    settings / emit；
 * 4. client bundle 的 DSH ModuleLoader 描述符与公开 apply(ctx) 的 slots 注册账本。
 *
 * 覆盖：
 * 1. delegationTaskKey 任务 key 归一化（NFKC、trim、连续空白、英文小写）；
 * 2. 并发相同任务：FIFO 临界区内仅一次 start、第二次 reused；
 * 3. 同角色不同任务：一次 start + 一次既有 child 公开 interrupt/sendMessage；
 * 4. 切换 route（provider/model/effort 变化）清空旧任务记录；
 * 5. tracker 原语：setChild 幂等、LRU 上限、任务指纹 TTL 过期（clock 注入）、
 *    dropParent 隔离、forgetTask（B3：确定失败后忘记任务，相同 prompt 可重新
 *    排队而不是在 TTL 窗口内永久 reused）；
 * 6. EXPERT_DELEGATION_DENY 完整清单、READONLY_DENY 覆盖与 dynamic MCP 只读限流；
 * 7. 角色工具真实 admission 行为：maxDepth:1、leaf worker marker、persona 纪律、
 *    toolFilter.deny 可见性过滤、reused/queued/interrupt/queue、NOT_RESUMABLE
 *    重建、取消信号无副作用、非阻塞 run_in_background、affectedPaths advisory；
 * 8. child_models 快照持久化与按 parentId+role+route 的重启恢复（含只接受
 *    continuable 记录、最新 lruSequence 优先）；
 * 9. root 专属接线：结构化文件 guard、dsh_expert_group_finalize 的 root turn 等待、
 *    用户等待 guard 与 user/message 边界；
 * 10. client 公开 apply 的 slots 注册账本与 shell.overlay 状态桥真实 RPC。
 *
 * 本文件只依赖插件纯模块、test-support harness 与 node:test，不需要 DSH 运行时依赖。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildRoleToolDescription, ROLE_TOOL_ADMISSION_CONTRACT } from "../prompt-contracts.js";
import { DOMAIN_CHILD_MODEL_RECORD } from "../index.js";
import { buildOrchestratorPrompt } from "../orchestrator.js";
import {
  createClientReactRuntime,
  createFakeIntervals,
  createHostContextStub,
  installGlobals,
  loadClientBundle,
} from "../test-support/client-bundle.mjs";
import { resolveWorkspaceRoot } from "../test-support/fixtures.mjs";
import { createPluginHost, flushAsyncWork, RPC_ENDPOINT } from "../test-support/plugin-host.mjs";
import {
  EXPERT_DELEGATION_DENY,
  READONLY_DENY,
  restrictableDenyNames,
  TASK_BINDING_LIMIT,
  TASK_TTL_DEFAULT_MS,
  affectedPathEntriesOverlap,
  createAdmissionBatchCoordinator,
  createDelegationTracker,
  delegationScopeKey,
  delegationTaskKey,
  evictOldestEntries,
  findAffectedPathOverlaps,
  normalizeAffectedPaths,
  normalizeWorkspacePath,
  rootStructuredPathGuard,
} from "../shared.js";

const roleToolDescription = buildRoleToolDescription("fixer");

/**
 * 专家 child 身份/续接 marker 是跨进程的 durable 契约：它们被写进 child.options 并
 * 随 child_models 快照持久化，因此测试必须锁定字面量（而不是 import 生产常量），
 * 否则 marker 改名会静默破坏重启恢复。
 */
const ROLE_MARKER = "__degExpertRole";
const PARENT_MARKER = "__degExpertParent";
const CONTINUABLE_MARKER = "__degExpertContinuable";
// deny marker 同样跨进程持久化，测试锁定其字面量契约。
const DENY_MARKER = "__degExpertDeny";

const ROLE_IDS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const READ_ONLY_ROLE_IDS = ["explorer", "librarian", "oracle", "observer"];
const ROOT_TOOL_NAMES = ["dsh_expert_group_finalize", "dsh_expert_group_done", "dsh_expert_group_release_scope", "dsh_expert_group_abandon_wait"];
/** 夹具的全局模型默认值：每个角色都解析到同一个 mock route。 */
const ROLE_DEFAULTS = {
  value: { defaults: Object.fromEntries(ROLE_IDS.map((role) => [role, { provider: "mock", model: "mock" }])) },
};

/**
 * 模拟 index.js 后台委派的多 child 判定流程（不含 NOT_RESUMABLE 分支与快照恢复），
 * 仅用 tracker 公开原语验证「相同任务复用、不同任务独立 child」的判定：
 * 1. 同一归一化任务（getTaskChild 有绑定且 route 一致）→ reused，不投递、不新建；
 * 2. 显式 childId（续作句柄）→ 投递给该 child（onContinue），不新建 child；
 * 3. 其余任务 → 独立新建 child，并把它与本任务 key 的绑定写回任务表。
 * @param {object} tracker - createDelegationTracker 实例。
 * @param {string} scope - delegationScopeKey 生成的 scope。
 * @param {string} routeKey - 当前 route（provider/model/effort 组合）。
 * @param {string} taskKey - delegationTaskKey 归一化后的任务 key。
 * @param {object} hooks - { onStart, onContinue, childId } 回调；childId 模拟显式续作句柄。
 */
async function simulateDelegation(tracker, scope, routeKey, taskKey, hooks) {
  return tracker.serialize(scope, async () => {
    const explicit = typeof hooks.childId === "string" && hooks.childId.length > 0;
    const bound = tracker.getTaskChild(scope, taskKey);
    // 无显式 childId 时命中自己那个 child 的绑定 → 复用；
    // 有显式 childId 时只有它正好是本任务绑定的 child 才算同一任务。
    if (bound !== void 0 && bound.routeKey === routeKey && (explicit === false || bound.childId === hooks.childId)) {
      return { outcome: "reused", childId: bound.childId };
    }
    if (explicit) {
      await hooks.onContinue?.(hooks.childId);
      tracker.rememberTask(scope, taskKey, { childId: hooks.childId, routeKey });
      return { outcome: "queued", childId: hooks.childId };
    }
    const childId = await hooks.onStart?.(taskKey);
    tracker.setChild(scope, { childId, routeKey });
    tracker.rememberTask(scope, taskKey, { childId, routeKey });
    return { outcome: "started", childId };
  });
}

// ── Host 行为夹具 ─────────────────────────────────────────────────────────

/**
 * 创建真实 apply 的 Host，并记录角色工具在公开 subagents seam 上产生的一切调用。
 *
 * subagents.startContinuable / interrupt / sendMessage 都是 DSH 的公开子代理 API；
 * 用例只观察它们的入参和工具返回值，不读取插件内部状态。
 *
 * @param {object} [options] - 传给 createPluginHost 的覆盖项（会覆盖默认录制替身）。
 * @returns {{host:object, requests:Array, interrupts:Array, messages:Array, goalCalls:Array}}
 */
function createDelegateHost(options = {}) {
  const requests = [];
  const interrupts = [];
  const messages = [];
  const goalCalls = [];
  const { subagents: subagentOverrides = {}, ...rest } = options;
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    ...rest,
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        return { childId: "child-" + requests.length, messageId: "message-" + requests.length };
      },
      interrupt: (childId, interruptOptions) => {
        interrupts.push({ childId, kind: interruptOptions?.kind, agent: interruptOptions?.agent });
      },
      sendMessage: async (parent, childId, content, sendOptions) => {
        messages.push({ parent, childId, content, signal: sendOptions?.signal });
        return "sent-" + messages.length;
      },
      ...subagentOverrides,
    },
  });
  // goals 只用于侧边栏的只读阶段投影；用例在 apply 前把探测替身写进服务。
  // 调用记录落在本 host 的 goalCalls 上，任何 pause/resume 都会抛错并被打红。
  Object.assign(host.context.goals, options.goals ?? createGoalService(goalCalls));
  // 可选钩子：用例可在 apply 前收紧某个宿主替身的契约（例如要求 tools.get 只接受一个参数）。
  options.beforeApply?.(host.context);
  host.apply();
  return { host, requests, interrupts, messages, goalCalls };
}

/**
 * GoalService 探测替身（改造后必须**零调用**）。
 *
 * 改造后 root 等待完全由「保持当前 turn 打开」实现，插件不调用 goals.pause /
 * goals.resume；goals 服务只剩 Expert Group 侧边栏的只读阶段投影。因此这个替身
 * 记录一切调用（含只读 get），并在 pause/resume 上直接抛错——任何残留的旧调用路径
 * 都会立刻把用例打红，而不是被静默忽略。
 *
 * @param {Array} calls - 记录动作名的调用日志。
 * @returns {object} GoalService 替身。
 */
function createGoalService(calls) {
  return {
    get(agent) {
      calls.push(["get", agent?.id]);
      return undefined;
    },
    pause(agent, ref) {
      calls.push(["pause", agent?.id, ref]);
      throw new Error("goals.pause must never be called by this plugin");
    },
    resume(agent, ref) {
      calls.push(["resume", agent?.id, ref]);
      throw new Error("goals.resume must never be called by this plugin");
    },
  };
}

/** 角色工具的最小公开 ToolExecution 形状（agent + signal + concludeTurn）。 */
function roleExecution(agent, overrides = {}) {
  return { agent, signal: new AbortController().signal, concludeTurn: () => {}, ...overrides };
}

/** 按 DSH 的 tools.guard 约定顺序执行已注册 guard，返回第一个拒绝结果。 */
function firstGuardRejection(host, execution) {
  for (const guard of [...host.guards]) {
    const result = guard(execution);
    if (result !== void 0) return result;
  }
  return void 0;
}

/** 读取某个 root 会话当下会看到的 system-prompt section 文本。 */
function sectionText(host, name, assemblyContext) {
  const section = host.sections.get(name);
  assert.ok(section, "apply 必须注册 system-prompt section " + name);
  return section.text(assemblyContext);
}

// ── 1. 任务 key 归一化 ─────────────────────────────────────────────────────

test("delegationTaskKey：NFKC / trim / 连续空白 / 英文小写归一化", () => {
  // 基本 trim + 连续空白折叠 + 小写。
  assert.equal(delegationTaskKey("  Hello\t World  "), "hello world");
  // 换行与多空格折叠为单个空格。
  assert.equal(delegationTaskKey("A  B\n\nC"), "a b c");
  // 全角字符 NFKC 归一为半角（含全角空格 U+3000）。
  assert.equal(delegationTaskKey("Ｈｅｌｌｏ　Ｗｏｒｌｄ"), "hello world");
  // 全角数字与标点同样归一（全角冒号 U+FF1A 也归一为半角）。
  assert.equal(delegationTaskKey("任务：ＡＢＣ１２３"), "任务:abc123");
  // 空值与 null 安全。
  assert.equal(delegationTaskKey(""), "");
  assert.equal(delegationTaskKey(undefined), "");
  // 归一化后完全相同的任务应命中同一 key（去重依据）。
  assert.equal(delegationTaskKey("  Analyze\n  the  screenshot  "), delegationTaskKey("ANALYZE THE SCREENSHOT"));
});

// ── 2. 并发相同任务：仅一次 start、一次 reused ─────────────────────────────

test("并发相同任务：FIFO 临界区内仅一次 start，第二次 reused", async () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "explorer");
  const taskKey = delegationTaskKey("Analyze the screenshot");
  let starts = 0;
  const hooks = {
    onStart: async () => { starts++; return "child-1"; },
    onSteer: async () => { throw new Error("相同任务不应触发 next-step steer"); },
  };
  // 两个调用并发进入同一 scope：serialize 保证 FIFO 串行，第二个必须复用。
  const results = await Promise.all([
    simulateDelegation(tracker, scope, "route-a", taskKey, hooks),
    simulateDelegation(tracker, scope, "route-a", taskKey, hooks),
  ]);
  assert.equal(starts, 1);
  assert.deepEqual(results, [
    { outcome: "started", childId: "child-1" },
    { outcome: "reused", childId: "child-1" },
  ]);
});

// ── 3. 同角色不同任务：两个独立 child（不再自动 steer 到旧 child）────────────

test("同角色不同任务：分别新建独立 child，旧 child 不被投递也不被复用", async () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "fixer");
  let starts = 0;
  const continued = [];
  const hooks = {
    onStart: async () => { starts++; return "child-" + starts; },
    onContinue: async (childId) => { continued.push(childId); },
  };
  const first = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task one"), hooks);
  const second = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task two"), hooks);
  assert.deepEqual(first, { outcome: "started", childId: "child-1" });
  assert.deepEqual(second, { outcome: "started", childId: "child-2" }, "不同 prompt 必须得到独立 child");
  assert.equal(starts, 2);
  assert.deepEqual(continued, [], "没有显式 childId 时不得向任何既有 child 投递");
  // 两个独立 child 都必须仍按各自任务 key 定位：相同 prompt 分别复用自己的 child。
  const again = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task one"), hooks);
  assert.deepEqual(again, { outcome: "reused", childId: "child-1" }, "相同 prompt 复用它自己的 child");
  assert.deepEqual(tracker.listChildIds(scope), ["child-2", "child-1"]);
});

test("同角色不同任务：显式 childId 才向指定 child 续作，其他任务仍是独立 child", async () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "fixer");
  let starts = 0;
  const continued = [];
  const hooks = {
    onStart: async () => { starts++; return "child-" + starts; },
    onContinue: async (childId) => { continued.push(childId); },
  };
  await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task one"), hooks);
  // 显式续作句柄：投递给指定 child，不新建。
  const followUp = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("follow up one"), { ...hooks, childId: "child-1" });
  assert.deepEqual(followUp, { outcome: "queued", childId: "child-1" });
  assert.deepEqual(continued, ["child-1"]);
  assert.equal(starts, 1, "续作不得新建 child");
  // 后续不同任务仍走独立 child 路径。
  const other = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task two"), hooks);
  assert.deepEqual(other, { outcome: "started", childId: "child-2" });
  assert.deepEqual(continued, ["child-1"], "独立任务不得触发任何续作投递");
});

// ── 4. 切换 route 清空旧任务记录 ───────────────────────────────────────────

test("切换 route（换模型）：旧 route 的任务记录失效，必须为同一 prompt 新建 child", async () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "designer");
  let starts = 0;
  const continued = [];
  const hooks = {
    onStart: async () => { starts++; return "child-" + starts; },
    onContinue: async (childId) => { continued.push(childId); },
  };
  // route-a 下记住 task-x。
  const r1 = await simulateDelegation(tracker, scope, "route-a", delegationTaskKey("task-x"), hooks);
  assert.deepEqual(r1, { outcome: "started", childId: "child-1" });
  // 切换 route（例如用户在侧边栏换了模型）→ 新建 child，旧 route 的任务记录被清理。
  const r2 = await simulateDelegation(tracker, scope, "route-b", delegationTaskKey("task-y"), hooks);
  assert.deepEqual(r2, { outcome: "started", childId: "child-2" });
  assert.equal(starts, 2);
  // 关键断言：route-b 下提交 task-x 必须新建独立 child 而不是复用 route-a 的 child；
  // 若 setChild 保留跨 route 的绑定，这里会命中 task 绑定返回 reused。
  const r3 = await simulateDelegation(tracker, scope, "route-b", delegationTaskKey("task-x"), hooks);
  assert.deepEqual(r3, { outcome: "started", childId: "child-3" });
  assert.equal(starts, 3);
  assert.deepEqual(continued, [], "普通派发不得走续作投递路径");
});

test("多 child：setChild 只清理被替换 child/旧 route 的任务记忆，同 route 的独立 child 保留", () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "oracle");
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  tracker.rememberTask(scope, "task-a", { childId: "c1", routeKey: "r1" });
  // 同 route 下新建第二个独立 child：c1 的绑定必须保留（相同 prompt 仍复用 c1）。
  tracker.setChild(scope, { childId: "c2", routeKey: "r1" });
  tracker.rememberTask(scope, "task-b", { childId: "c2", routeKey: "r1" });
  assert.deepEqual(tracker.getTaskChild(scope, "task-a"), { childId: "c1", routeKey: "r1" });
  assert.deepEqual(tracker.getTaskChild(scope, "task-b"), { childId: "c2", routeKey: "r1" });
  assert.deepEqual(tracker.listChildIds(scope), ["c2", "c1"]);
  // route 变更：所有旧 route 绑定都失效（不得把旧 route child 当可复用对象）。
  tracker.setChild(scope, { childId: "c3", routeKey: "r2" });
  assert.equal(tracker.getTaskChild(scope, "task-a"), void 0);
  assert.equal(tracker.getTaskChild(scope, "task-b"), void 0);
  assert.equal(tracker.hasTask(scope, "task-a"), false);
  assert.deepEqual(tracker.listChildIds(scope), ["c3"]);
});

// ── 5. tracker 原语：setChild 幂等 / LRU / dropParent ─────────────────────

test("setChild 相同 child+route 幂等：不清空任务记录", () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "fixer");
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  tracker.rememberTask(scope, "t1");
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  assert.equal(tracker.hasTask(scope, "t1"), true);
  assert.deepEqual(tracker.getChild(scope), { childId: "c1", routeKey: "r1" });
});

test("rememberTask LRU 上限（默认 32）：超限淘汰最旧", () => {
  const tracker = createDelegationTracker();
  const scope = "parent-1::explorer";
  for (let i = 0; i < 32; i++) tracker.rememberTask(scope, "task-" + i);
  assert.equal(tracker.hasTask(scope, "task-0"), true); // 32 个刚好占满
  tracker.rememberTask(scope, "task-32"); // 超限 → 淘汰最旧的 task-0
  assert.equal(tracker.hasTask(scope, "task-0"), false);
  assert.equal(tracker.hasTask(scope, "task-1"), true);
  assert.equal(tracker.hasTask(scope, "task-32"), true);
  // 重复记忆刷新位置：task-1 再次记住后，再次超限时淘汰 task-2。
  tracker.rememberTask(scope, "task-1");
  tracker.rememberTask(scope, "task-33");
  assert.equal(tracker.hasTask(scope, "task-2"), false);
  assert.equal(tracker.hasTask(scope, "task-1"), true);
});

test("任务指纹 TTL：过期后相同任务不再判为 reused（clock 注入，不依赖真实等待）", () => {
  let fakeNow = 1_000_000;
  const tracker = createDelegationTracker({ taskTtlMs: 600_000, now: () => fakeNow });
  const scope = "parent-1::explorer";
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  tracker.rememberTask(scope, "task-x");
  assert.equal(tracker.hasTask(scope, "task-x"), true);
  fakeNow += 599_999; // 未到 TTL：仍判为已记住。
  assert.equal(tracker.hasTask(scope, "task-x"), true);
  fakeNow += 2; // 累计 600_001ms，超过 TTL：惰性删除并返回 false。
  assert.equal(tracker.hasTask(scope, "task-x"), false);
  // 过期后再记住：同一 key 可重新进入复用判定（相同 prompt 不会永久失效）。
  tracker.rememberTask(scope, "task-x");
  assert.equal(tracker.hasTask(scope, "task-x"), true);
  // 未过期的 key 不受影响。
  tracker.rememberTask(scope, "task-y");
  fakeNow += 100_000;
  assert.equal(tracker.hasTask(scope, "task-y"), true);
});

test("任务指纹默认 TTL 为 10 分钟；taskTtlMs 可配置", () => {
  assert.equal(TASK_TTL_DEFAULT_MS, 10 * 60 * 1000);
  // 默认 tracker 使用默认 TTL：注入快速时钟验证默认窗口，无需真实等待。
  let fakeNow = 0;
  const tracker = createDelegationTracker({ now: () => fakeNow });
  const scope = "parent-1::fixer";
  tracker.rememberTask(scope, "t");
  assert.equal(tracker.hasTask(scope, "t"), true);
  fakeNow = TASK_TTL_DEFAULT_MS - 1;
  assert.equal(tracker.hasTask(scope, "t"), true);
  fakeNow = TASK_TTL_DEFAULT_MS;
  assert.equal(tracker.hasTask(scope, "t"), false);
});

test("forgetTask：忘记后相同 prompt 不再 reused，按新任务新建独立 child（B3）", async () => {
  const tracker = createDelegationTracker();
  const scope = delegationScopeKey("parent-1", "explorer");
  const taskKey = delegationTaskKey("Analyze the screenshot");
  let starts = 0;
  const continued = [];
  const hooks = {
    onStart: async () => { starts++; return "child-" + starts; },
    onContinue: async (childId) => { continued.push(childId); },
  };
  await simulateDelegation(tracker, scope, "route-a", taskKey, hooks);
  // 未忘记前：相同任务直接 reused（去重生效）。
  const dup = await simulateDelegation(tracker, scope, "route-a", taskKey, hooks);
  assert.deepEqual(dup, { outcome: "reused", childId: "child-1" });
  // 任务确定失败 → forgetTask：相同任务再次委派必须重新派发（不得被永久判为 reused）。
  assert.equal(tracker.forgetTask(scope, taskKey), true);
  const retry = await simulateDelegation(tracker, scope, "route-a", taskKey, hooks);
  assert.deepEqual(retry, { outcome: "started", childId: "child-2" });
  assert.deepEqual(continued, [], "未显式指定 childId 时不得投向旧 child");
  assert.equal(starts, 2);
  // 遗忘后的新任务重新建立自己的绑定：再次提交同一 prompt 复用的是新 child。
  const again = await simulateDelegation(tracker, scope, "route-a", taskKey, hooks);
  assert.deepEqual(again, { outcome: "reused", childId: "child-2" });
  assert.equal(starts, 2);
});

test("forgetTask：幂等安全，不影响其他任务与 child 记录（B3）", () => {
  const tracker = createDelegationTracker();
  const scope = "parent-1::fixer";
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  tracker.rememberTask(scope, "task-x");
  tracker.rememberTask(scope, "task-y");
  // 未知 key / 未知 scope：返回 false，不抛错。
  assert.equal(tracker.forgetTask(scope, "no-such-task"), false);
  assert.equal(tracker.forgetTask("parent-9::fixer", "task-x"), false);
  // 只删除指定 key。
  assert.equal(tracker.forgetTask(scope, "task-x"), true);
  assert.equal(tracker.forgetTask(scope, "task-x"), false); // 已删除
  assert.equal(tracker.hasTask(scope, "task-x"), false);
  assert.equal(tracker.hasTask(scope, "task-y"), true);
  // child 记录不受影响。
  assert.deepEqual(tracker.getChild(scope), { childId: "c1", routeKey: "r1" });
});

test("dropParent 只清除该父代理的 scope，但保留活动范围保护（票据 07）", () => {
  const tracker = createDelegationTracker();
  const scopeA = delegationScopeKey("parent-a", "fixer");
  const scopeB = delegationScopeKey("parent-b", "fixer");
  tracker.setChild(scopeA, { childId: "c1", routeKey: "r" });
  tracker.setChild(scopeB, { childId: "c2", routeKey: "r" });
  tracker.rememberTask(scopeA, "t1");
  const parentA = { id: "parent-a" };
  const activity = tracker.registerActiveTask({
    parentId: "parent-a", parentAgent: parentA, role: "fixer", taskKey: "t1",
    description: "edit shared", affectedPaths: ["file:src/shared.js"], childId: "c1",
  });
  tracker.dropParent("parent-a");
  // scope（可复用 child / 任务指纹）与短队列属于 root 的缓存，销毁即清理。
  assert.equal(tracker.getChild(scopeA), void 0);
  assert.equal(tracker.hasTask(scopeA, "t1"), false);
  assert.deepEqual(tracker.getChild(scopeB), { childId: "c2", routeKey: "r" });
  // 活动范围不是缓存：root 销毁不是停止证据，保护必须保留并转为 detached。
  const active = tracker.listActiveTasks("parent-a");
  assert.deepEqual(active.map((task) => task.id), [activity.id]);
  assert.equal(active[0].detached, true);
  assert.equal(Object.hasOwn(active[0], "parentAgent"), false, "快照绝不能带 root Agent 强引用");
  assert.deepEqual(tracker.activeTaskCounts(), { total: 1, detached: 1 });
  assert.deepEqual(tracker.listDetachedActiveTasks().map((task) => task.activityId), [activity.id]);
  const blocked = tracker.checkActiveTaskScope({ parentId: "parent-a", affectedPaths: ["file:src/shared.js"] });
  assert.equal(blocked.blocked, true, "detached 活动项必须继续阻塞同 parent 的同路径任务");
});

test("detached 活动项只由权威停止证据释放（turn/end messageId、child disposal）", () => {
  const tracker = createDelegationTracker();
  const parent = { id: "parent-stop" };
  const bound = tracker.registerActiveTask({
    parentId: "parent-stop", parentAgent: parent, role: "fixer", taskKey: "task-a",
    description: "task a", affectedPaths: ["file:src/a.js"], childId: "child-a",
  });
  const pending = tracker.registerActiveTask({
    parentId: "parent-stop", parentAgent: parent, role: "oracle", taskKey: "task-b",
    description: "task b", affectedPaths: ["file:src/b.js"], childId: "child-b",
  });
  tracker.bindActiveTask(bound.id, "child-a", "message-a");
  tracker.dropParent("parent-stop");
  assert.deepEqual(tracker.activeTaskCounts(), { total: 2, detached: 2 });

  // turn/end 证据：只释放该 turn 稳定 messageId 命中的活动项，未绑定 messageId 的保持保护。
  assert.equal(tracker.completeDetachedActiveTasksForChild("child-a", { turnMsgIds: ["message-a"] }), 1);
  assert.deepEqual(tracker.listActiveTasks("parent-stop").map((task) => task.id), [pending.id]);
  assert.equal(tracker.completeDetachedActiveTasksForChild("child-a", { turnMsgIds: ["other-message"] }), 0, "不匹配的 turn 不得释放");
  // child disposal 证据：释放该 child 的全部 detached 活动项（含未绑定 messageId 的竞态项）。
  assert.equal(tracker.completeDetachedActiveTasksForChild("child-b"), 1);
  assert.deepEqual(tracker.activeTaskCounts(), { total: 0, detached: 0 });

  // completeActiveTasksForChild 在 owner 已脱离（parentAgent 已移除）时仍必须能按 parentId 释放：
  // 否则 root 销毁后的权威 disposal 会被旧 owner 过滤永久拒绝。
  tracker.registerActiveTask({
    parentId: "parent-stop", parentAgent: parent, role: "fixer", taskKey: "task-c",
    description: "task c", affectedPaths: ["file:src/c.js"], childId: "child-c",
  });
  tracker.dropParent("parent-stop");
  assert.equal(tracker.completeActiveTasksForChild("child-c", "parent-stop", parent), 1);
  assert.equal(tracker.listActiveTasks("parent-stop").length, 0, "detached 项按 parentId 匹配即可释放");

  // 未脱离的活动项仍按 owner 过滤：明确属于另一个 root generation 的 child 不得被误删。
  const otherRoot = { id: "other-root" };
  tracker.registerActiveTask({
    parentId: "parent-stop", parentAgent: otherRoot, role: "fixer", taskKey: "task-d",
    description: "task d", affectedPaths: ["file:src/d.js"], childId: "child-d",
  });
  assert.equal(tracker.completeActiveTasksForChild("child-d", "parent-stop", parent), 0, "owner 明确不同的活动项不得释放");
  assert.equal(tracker.completeActiveTasksForChild("child-d", "parent-stop", otherRoot), 1);
});

test("clearChild：可指定 childId，不匹配时不动", () => {
  const tracker = createDelegationTracker();
  const scope = "parent-1::oracle";
  tracker.setChild(scope, { childId: "c1", routeKey: "r" });
  assert.equal(tracker.clearChild(scope, "c2"), false);
  assert.deepEqual(tracker.getChild(scope), { childId: "c1", routeKey: "r" });
  assert.equal(tracker.clearChild(scope, "c1"), true);
  assert.equal(tracker.getChild(scope), void 0);
});

test("getTaskChild：TTL 到期后返回 undefined，且兼容旧格式（纯时间戳）记录", () => {
  let fakeNow = 5_000;
  const tracker = createDelegationTracker({ taskTtlMs: 1_000, now: () => fakeNow });
  const scope = "parent-1::oracle";
  tracker.setChild(scope, { childId: "c1", routeKey: "r1" });
  tracker.rememberTask(scope, "task-a", { childId: "c1", routeKey: "r1" });
  assert.deepEqual(tracker.getTaskChild(scope, "task-a"), { childId: "c1", routeKey: "r1" });
  // 未过期：仍可定位。
  fakeNow += 999;
  assert.deepEqual(tracker.getTaskChild(scope, "task-a"), { childId: "c1", routeKey: "r1" });
  // 过期：惰性删除并返回 undefined（相同 prompt 到期后可重新派发）。
  fakeNow += 1;
  assert.equal(tracker.getTaskChild(scope, "task-a"), void 0);
  assert.equal(tracker.hasTask(scope, "task-a"), false, "getTaskChild 的惰性删除必须与 hasTask 一致");
  // 无绑定或未知 scope 安全返回 undefined。
  tracker.rememberTask(scope, "task-legacy");
  assert.equal(tracker.getTaskChild(scope, "task-legacy"), void 0);
  assert.equal(tracker.getTaskChild("parent-9::oracle", "task-a"), void 0);
  assert.deepEqual(tracker.listChildIds("parent-9::oracle"), []);
});

test("delegationScopeKey：parentId 与 role 组合稳定", () => {
  assert.equal(delegationScopeKey("p-1", "explorer"), "p-1::explorer");
  assert.equal(delegationScopeKey("p-1", "fixer"), "p-1::fixer");
  assert.notEqual(delegationScopeKey("p-1", "fixer"), delegationScopeKey("p-2", "fixer"));
});

// ── 6. affectedPaths 范围归一化与活动冲突登记 ─────────────────────────────

test("affectedPaths：归一化识别文件、目录、符号和祖先范围交集", () => {
  const entries = normalizeAffectedPaths([" ./SRC\\components/ ", "file:src/components/Button.js", "symbol:Widget.render", "symbol:Widget.render"]);
  assert.deepEqual(entries, [
    { kind: "directory", value: "src/components" },
    { kind: "file", value: "src/components/button.js" },
    { kind: "symbol", value: "Widget.render" },
  ]);
  assert.equal(affectedPathEntriesOverlap(entries[0], entries[1]), true, "目录与其文件相交");
  assert.equal(affectedPathEntriesOverlap({ kind: "file", value: "src/a" }, { kind: "path", value: "src/a/b" }), false, "文件不能充当祖先目录");
  assert.equal(affectedPathEntriesOverlap(entries[2], { kind: "symbol", value: "Widget.render" }), true);
  assert.equal(affectedPathEntriesOverlap(entries[2], { kind: "symbol", value: "Widget.Render" }), false, "符号保留大小写");
  assert.equal(findAffectedPathOverlaps(["dir:src/components"], ["src/components/Button.js"]).length, 1);
});

test("活动 affectedPaths：冲突默认阻断，allowOverlap 明确放行，缺失范围仅告警", () => {
  const tracker = createDelegationTracker();
  const first = tracker.registerActiveTask({
    parentId: "parent-scope",
    role: "explorer",
    taskKey: "inspect components",
    description: "inspect component tree",
    affectedPaths: ["dir:src/components"],
    childId: "child-a",
  });
  const blocked = tracker.checkActiveTaskScope({ parentId: "parent-scope", affectedPaths: ["file:src/components/Button.js"] });
  assert.equal(blocked.status, "conflict");
  assert.equal(blocked.blocked, true);
  assert.match(blocked.warning, /Affected-path conflict advisory/);
  assert.match(blocked.warning, /allowOverlap=true/);
  assert.equal(blocked.conflicts[0].task.id, first.id);

  const overridden = tracker.checkActiveTaskScope({ parentId: "parent-scope", affectedPaths: ["src/components/Button.js"], allowOverlap: true });
  assert.equal(overridden.status, "conflict");
  assert.equal(overridden.blocked, false);
  assert.match(overridden.warning, /Continuing only because allowOverlap=true/);

  const missingNew = tracker.checkActiveTaskScope({ parentId: "parent-scope" });
  assert.equal(missingNew.status, "unchecked");
  assert.equal(missingNew.blocked, false);
  assert.equal(missingNew.missingIncoming, true);
  assert.deepEqual(missingNew.missing, [], "新任务缺少范围不能把已声明的 explorer 误列为 missing");
  assert.match(missingNew.warning, /the new task is missing affectedPaths/);
  assert.doesNotMatch(missingNew.warning, /explorer/, "缺失归因必须指向 incoming task，而不是活动任务");

  const unknown = tracker.registerActiveTask({ parentId: "parent-scope", role: "oracle", taskKey: "review", description: "review" });
  const missingExisting = tracker.checkActiveTaskScope({ parentId: "parent-scope", affectedPaths: ["docs/guide.md"] });
  assert.equal(missingExisting.status, "unchecked");
  assert.match(missingExisting.warning, /affectedPaths is missing for oracle/);
  assert.doesNotMatch(missingExisting.warning, /explorer/, "只有自身缺少 affectedPaths 的活动任务才列为 missing");

  assert.equal(tracker.completeActiveTask({ parentId: "parent-scope", role: "explorer", taskKey: "inspect components", childId: "child-a" }), 1);
  assert.equal(tracker.releaseActiveTask(unknown.id), true);
  assert.deepEqual(tracker.listActiveTasks("parent-scope"), []);
});

test("活动范围：任务 fingerprint 和 record binding 淘汰后仍按 messageId 精确终态清理", () => {
  let clock = 0;
  const tracker = createDelegationTracker({ taskLimit: 1, taskTtlMs: 10, now: () => clock });
  const scope = delegationScopeKey("parent-activity", "fixer");
  tracker.setChild(scope, { childId: "child-shared", routeKey: "route" });
  const first = tracker.registerActiveTask({
    parentId: "parent-activity", role: "fixer", taskKey: "task-a", description: "task A",
    affectedPaths: ["file:src/a.js"], childId: "child-shared",
  });
  const second = tracker.registerActiveTask({
    // TTL 过期后相同 prompt/taskKey 可以再次派发；两个 activity 因而可能同 key，
    // 终态必须依 messageId 区分，不能让旧 turn 清掉新任务。
    parentId: "parent-activity", role: "fixer", taskKey: "task-a", description: "task A retry",
    affectedPaths: ["file:src/b.js"], childId: "child-shared",
  });
  tracker.bindActiveTask(first.id, "child-shared", "message-a");
  tracker.bindActiveTask(second.id, "child-shared", "message-b");

  // scope 任务 fingerprint 的 LRU/TTL 与 recovery record.tasks 的上限都不拥有
  // activeTasks 的终态关联；模拟两者淘汰后，活动项仍保留 admission messageId。
  tracker.rememberTask(scope, "task-a");
  tracker.rememberTask(scope, "task-b");
  assert.equal(tracker.hasTask(scope, "task-a"), false, "task fingerprint LRU 已淘汰 task A");
  clock = 20;
  assert.equal(tracker.hasTask(scope, "task-b"), false, "剩余 task fingerprint 已 TTL 过期");
  const recordTasks = new Map([["task-a", { messageId: "message-a" }]]);
  for (let i = 0; i < TASK_BINDING_LIMIT; i++) {
    recordTasks.set("later-" + i, { messageId: "later-message-" + i });
  }
  evictOldestEntries(recordTasks, TASK_BINDING_LIMIT);
  assert.equal(recordTasks.has("task-a"), false, "第 65 条写入会淘汰容量 64 的 record.tasks 原 binding");

  const completed = tracker.completeActiveTasksForTurn({
    parentId: "parent-activity", role: "fixer", childId: "child-shared",
    turnMsgIds: new Set(["message-a"]), taskKeys: [],
  });
  assert.equal(completed, 1);
  const remaining = tracker.listActiveTasks("parent-activity");
  assert.equal(remaining.length, 1, "同 child 的其他仍活动任务不得被误删");
  assert.equal(remaining[0].id, second.id);
  assert.equal(remaining[0].messageId, "message-b");

  assert.equal(tracker.completeActiveTasksForTurn({
    parentId: "parent-activity", role: "fixer", childId: "child-shared",
    turnMsgIds: new Set(["message-b"]), taskKeys: [],
  }), 1, "确定失败或正常完成都可按独立 messageId 清理");
  assert.deepEqual(tracker.listActiveTasks("parent-activity"), []);
});

test("claimed 补绑：同 key 只绑定首个 pending 活动，旧新 turn 各自精确清理", () => {
  const tracker = createDelegationTracker();
  const options = {
    parentId: "parent-claimed", role: "fixer", taskKey: "same-task", affectedPaths: ["file:src/shared.js"], childId: "child-claimed",
  };
  const oldActivity = tracker.registerActiveTask({ ...options, description: "old activity" });
  const newActivity = tracker.registerActiveTask({ ...options, description: "new pending activity" });
  tracker.bindActiveTask(oldActivity.id, "child-claimed", "m-old");

  assert.equal(tracker.bindActiveTasksByTaskKey({
    parentId: "parent-claimed", role: "fixer", childId: "child-claimed", taskKey: "same-task", messageId: "m-new",
  }), 1, "一个 claimed message 只能补绑一个 pending activity");
  let active = tracker.listActiveTasks("parent-claimed");
  assert.equal(active.find((task) => task.id === oldActivity.id).messageId, "m-old", "旧 activity 的稳定消息不能被覆盖");
  assert.equal(active.find((task) => task.id === newActivity.id).messageId, "m-new");

  assert.equal(tracker.completeActiveTasksForTurn({
    parentId: "parent-claimed", role: "fixer", childId: "child-claimed", turnMsgIds: new Set(["m-old"]), taskKeys: ["same-task"],
  }), 1, "旧 turn 只清旧 activity");
  active = tracker.listActiveTasks("parent-claimed");
  assert.deepEqual(active.map((task) => task.id), [newActivity.id]);
  assert.equal(tracker.completeActiveTasksForTurn({
    parentId: "parent-claimed", role: "fixer", childId: "child-claimed", turnMsgIds: new Set(["m-new"]), taskKeys: ["same-task"],
  }), 1, "新 turn 再清新 activity");
});

test("recovery activityIds：同 key 新活动并存时只终态清理 op 指向的旧活动", () => {
  const tracker = createDelegationTracker();
  const options = {
    parentId: "parent-recovery", role: "fixer", taskKey: "same-task", affectedPaths: ["file:src/shared.js"], childId: "child-recovery",
  };
  const recoveryActivity = tracker.registerActiveTask({ ...options, description: "old recovery activity" });
  const newerActivity = tracker.registerActiveTask({ ...options, description: "new same-key activity" });
  tracker.bindActiveTask(recoveryActivity.id, "child-recovery", "m-recovery-old");
  tracker.bindActiveTask(newerActivity.id, "child-recovery", "m-newer");
  const op = { activityIds: new Set([recoveryActivity.id]), taskKeys: new Set(["same-task"]) };

  assert.equal(tracker.completeActiveTasksByIds(op.activityIds), 1);
  const active = tracker.listActiveTasks("parent-recovery");
  assert.deepEqual(active.map((task) => task.id), [newerActivity.id], "不能按 op.taskKeys 宽泛删除同 key 的新 activity");
});

test("角色工具 admission 不再主动结束 root turn（结论只由宿主与 finalize 决定）", async () => {
  const { host, goalCalls } = createDelegateHost();
  const root = host.registerRootAgent("root-no-conclude");
  let concludeCalls = 0;
  const execution = roleExecution(root, { concludeTurn: () => { concludeCalls += 1; } });
  for (const args of [
    { description: "one", prompt: "task one" },
    { description: "two", prompt: "task two", run_in_background: false },
    { description: "three", prompt: "task three", continue_parent_turn: true },
  ]) {
    const outcome = await host.toolDefinition("explorer").execute(args, execution);
    assert.equal(outcome.accepted, true, "admission 始终非阻塞并接受");
  }
  assert.equal(concludeCalls, 0, "role tool 绝不调用 exec.concludeTurn()");
  assert.deepEqual(goalCalls, [], "role tool 绝不调用任何 goal API");
  await host.dispose();
});

test("admission batch：所有已进入的 admission 结算后才释放 accepted", async () => {
  const coordinator = createAdmissionBatchCoordinator();
  const accepted = coordinator.begin();
  const rejected = coordinator.begin();
  let released = false;
  const ready = accepted.whenReady().then(() => { released = true; });

  accepted.settle();
  await Promise.resolve();
  assert.equal(released, false, "accepted 不能绕过尚未结算的 sibling admission");

  rejected.settle();
  await ready;
  assert.equal(released, true, "rejected outcome 收集后 batch 才可释放");
});

test("admission batch：重复 settle 幂等，已完成 batch 不阻塞下一轮", async () => {
  const coordinator = createAdmissionBatchCoordinator();
  const first = coordinator.begin();
  const firstReady = first.whenReady();
  assert.equal(first.settle(), true);
  assert.equal(first.settle(), false, "重复 settle 不能重复减少 pending");
  await firstReady;

  const second = coordinator.begin();
  let ready = false;
  const secondReady = second.whenReady().then(() => { ready = true; });
  second.settle();
  await secondReady;
  assert.equal(ready, true, "已结算 batch 不应阻塞下一轮 admission");
});


// ── 7. root 编排提示词（orchestrator 公开导出） ─────────────────────────────

test("root 编排提示词：root turn 等待、用户等待与反问工具只来自公开构造器", () => {
  const prompt = buildOrchestratorPrompt({ roles: ROLE_IDS, providerReady: true, rootSessionId: "root-1" });
  assert.match(prompt, /Do not use.*update_goal pause/i, "必须禁止 update_goal pause 接管用户等待");
  // finalize 已是两阶段契约：工具完成校验与等待登记后立即返回非终态 waiting 回执；
  // 继续等待属于 root turn 的 agent/turn-stopping 生命周期且没有超时。旧说法"finalize
  // 工具调用本身保持 root turn 打开并无限等待"必须整体退役。
  assert.match(prompt, /returns immediately with its non-terminal waiting receipt/i, "必须说明 finalize 登记等待后立即返回非终态 waiting");
  assert.match(prompt, /keeps waiting at the agent\/turn-stopping lifecycle boundary/i, "必须把继续等待定位到 root turn 的 turn-stopping 生命周期");
  assert.match(prompt, /with no timeout/i, "必须说明 root turn 生命周期等待没有超时");
  assert.match(prompt, /do not call finalize again for that batch and do not poll for status/i, "必须禁止收到 waiting 后重试 finalize 或轮询状态");
  // 等待期间仍然可以做其他独立工作；绝不能用纯文本回复结束 turn。
  assert.match(prompt, /keep doing other independent work with tool calls/i, "必须保留等待期间继续调用工具的许可");
  assert.doesNotMatch(prompt, /keeps the current root turn open until every expert it accepted has actually finished/i, "旧的 finalize 工具自身无限等待说法必须退役");
  assert.doesNotMatch(prompt, /pauses the root goal/i, "不得再声称 finalize 会暂停 root goal");
  assert.match(prompt, /ask_user_question/);
  assert.match(prompt, /exit_plan_mode/);
  assert.match(prompt, /grill-me/);
  assert.match(prompt, /to-spec/);
  // 每个启用角色都必须恰好出现一次，provider 未就绪时不声称工具可用。
  for (const role of ROLE_IDS) {
    assert.equal(prompt.split("@" + role).length - 1, 1, role + " 必须恰好出现一次");
  }
  const unavailable = buildOrchestratorPrompt({ roles: ROLE_IDS, providerReady: false });
  assert.match(unavailable, /currently unavailable/);
  assert.doesNotMatch(unavailable, /Available expert tools/);
});

// ── 8. root 结构化路径 guard（shared 公开导出） ────────────────────────────

test("root structured path guard：覆盖文件工具、glob/grep、缺失范围与嵌套内层执行", () => {
  const tracker = createDelegationTracker();
  const active = tracker.registerActiveTask({
    parentId: "root-guard", role: "fixer", taskKey: "edit shared", description: "edit shared",
    affectedPaths: ["file:src/shared.js"], childId: "expert-child",
  });
  const activeTasks = tracker.listActiveTasks("root-guard");
  for (const name of ["read", "edit", "write"]) {
    const warning = rootStructuredPathGuard({
      name, arguments: { file_path: "src/shared.js" }, agent: { id: "root-guard" },
    }, activeTasks, "root-guard");
    assert.match(warning, /fixer.*edit shared.*src\/shared\.js/, name + " 重叠路径必须拒绝");
  }
  for (const name of ["glob", "grep"]) {
    const warning = rootStructuredPathGuard({
      // 模拟 run_code 的结构化内层 ToolExecution：guard 看到的是内层 name/arguments，
      // 不需要、也不允许解析外层 code 文本。
      name, arguments: { path: "src/shared.js" }, agent: { id: "root-guard" }, parent: Symbol("run-code"),
    }, activeTasks, "root-guard");
    assert.match(warning, /fixer.*edit shared/, name + " 重叠路径必须拒绝");
  }
  for (const name of ["read", "edit", "write", "glob", "grep"]) {
    const argument = name === "glob" || name === "grep" ? { path: "docs/guide.md" } : { file_path: "docs/guide.md" };
    assert.equal(rootStructuredPathGuard({ name, arguments: argument, agent: { id: "root-guard" } }, activeTasks, "root-guard"), undefined, name + " 不相交路径允许");
  }
  assert.match(rootStructuredPathGuard({ name: "glob", arguments: {}, agent: { id: "root-guard" } }, activeTasks, "root-guard"), /workspace-wide|unknown/i, "无 path 的 glob 视为 workspace-wide 未知范围");
  assert.match(rootStructuredPathGuard({ name: "grep", arguments: {}, agent: { id: "root-guard" } }, activeTasks, "root-guard"), /workspace-wide|unknown/i, "无 path 的 grep 视为 workspace-wide 未知范围");
  assert.equal(rootStructuredPathGuard({ name: "glob", arguments: {} }, [], "root-guard"), undefined, "无活动专家时未知范围允许");

  const missingTasks = [{ role: "oracle", taskKey: "inspect", description: "inspect files", affectedPaths: [] }];
  assert.match(rootStructuredPathGuard({ name: "read", arguments: { file_path: "docs/guide.md" }, agent: { id: "root-guard" } }, missingTasks, "root-guard"), /affectedPaths.*oracle.*inspect/i, "活动范围缺失时拒绝结构化文件工具");
  assert.equal(rootStructuredPathGuard({ name: "read", arguments: { file_path: "src/shared.js" }, agent: { id: "expert-child" } }, activeTasks, "root-guard"), undefined, "child execution 不受 root guard 影响");
  for (const name of ["fixer", "todo_write", "run_code", "bash", "pwsh"]) {
    assert.equal(rootStructuredPathGuard({ name, arguments: { path: "src/shared.js" } }, activeTasks, "root-guard"), undefined, name + " 等非结构化/委派工具允许");
  }
  assert.equal(active.id, "activity-" + active.id.split("-").at(-1));
});

test("root structured path guard：统一 workspace root 后识别相对/绝对 Windows 路径", () => {
  // 工作区根动态发现（DEG_WORKSPACE_ROOT 优先，否则从模块位置向上查找 package.json），
  // 绝不写死个人绝对路径。normalizeWorkspacePath 只做纯字符串归一、不访问文件系统，
  // 因此这里只需要一个真实工作区根即可继续覆盖分隔符 / 大小写 / dot segments 语义。
  const workspaceRoot = resolveWorkspaceRoot();
  const relative = normalizeWorkspacePath("src\\.\\nested\\..\\shared.js", workspaceRoot);
  const absolute = normalizeWorkspacePath(workspaceRoot + "\\src/./nested/../shared.js", workspaceRoot);
  assert.equal(relative, absolute, "相对路径与 workspaceRoot 下绝对路径必须统一");
  // 同一根目录的大小写 + 正斜杠变体：Windows 盘符与路径段必须大小写不敏感。
  const caseVariant = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  assert.equal(
    normalizeWorkspacePath(caseVariant + "/src/../src/shared.js", workspaceRoot),
    absolute,
    "Windows 分隔符、大小写和 dot segments 必须统一",
  );
  // 含空格与反斜杠的路径段必须原样保留，不得按空白切分。
  assert.equal(
    normalizeWorkspacePath("dir with space\\file.js", workspaceRoot),
    normalizeWorkspacePath(workspaceRoot + "/dir with space/file.js", workspaceRoot),
    "含空格的路径段必须原样归一",
  );

  const relativeExpert = createDelegationTracker().registerActiveTask({
    parentId: "root-paths", role: "fixer", taskKey: "relative expert", description: "relative expert",
    affectedPaths: ["file:src/shared.js"], childId: "expert-relative",
  });
  const relativeWarning = rootStructuredPathGuard({
    name: "read", arguments: { file_path: workspaceRoot + "\\src\\shared.js" }, agent: { id: "root-paths" },
  }, [relativeExpert], "root-paths", workspaceRoot);
  assert.match(relativeWarning, /overlaps active expert work/, "专家相对、root 绝对必须被拒绝");

  const absoluteExpert = createDelegationTracker().registerActiveTask({
    parentId: "root-paths", role: "fixer", taskKey: "absolute expert", description: "absolute expert",
    affectedPaths: ["file:" + workspaceRoot + "\\src\\shared.js"], childId: "expert-absolute",
  });
  const absoluteWarning = rootStructuredPathGuard({
    name: "edit", arguments: { file_path: "src/./nested/../shared.js" }, agent: { id: "root-paths" },
  }, [absoluteExpert], "root-paths", workspaceRoot);
  assert.match(absoluteWarning, /overlaps active expert work/, "专家绝对、root 相对必须被拒绝");
});

// ── 9. deny 清单与可见性过滤 ───────────────────────────────────────────────

test("EXPERT_DELEGATION_DENY 同时覆盖 Harness 外层与插件命名空间", () => {
  const required = [
    "report",
    "subagent",
    "subagent_fork",
    "subagent_explorer",
    "subagent_librarian",
    "subagent_oracle",
    "subagent_designer",
    "subagent_fixer",
    "subagent_observer",
    "explorer",
    "librarian",
    "oracle",
    "designer",
    "fixer",
    "observer",
    "run_code",
    "workflow",
    "ralph",
    "create_goal",
    "update_goal",
    "send_message",
    "interrupt_agent",
    "todo_write",
  ];
  assert.equal(EXPERT_DELEGATION_DENY.length, required.length);
  assert.deepEqual([...EXPERT_DELEGATION_DENY].sort(), [...required].sort());
});

test("READONLY_DENY 保留写/命令限制并覆盖全部委派限制", () => {
  for (const name of ["write", "edit", "bash", "pwsh"]) {
    assert.ok(READONLY_DENY.includes(name), "READONLY_DENY 缺少 " + name);
  }
  for (const name of EXPERT_DELEGATION_DENY) {
    assert.ok(READONLY_DENY.includes(name), "READONLY_DENY 缺少委派限制 " + name);
  }
});

test("restrictableDenyNames 排除 Code Mode 保留传输但保留其他可见 deny 工具", () => {
  const visible = new Set(["run_code", "subagent", "write"]);
  const filtered = restrictableDenyNames(
    ["run_code", "subagent", "missing", "subagent"],
    (name) => visible.has(name),
  );
  assert.deepEqual(filtered, ["subagent"]);
});

test("角色工具 deny 只包含宿主当前可见的全局工具，run_code 保留为展示传输", async () => {
  const visibleTools = [...new Set([...READONLY_DENY, ...EXPERT_DELEGATION_DENY])];
  const visibilityChecks = [];
  const { host, requests } = createDelegateHost({
    visibleTools,
    // 收紧宿主替身：全局可见性检查只能按名字查询，不得把 parent scope 传进 tools.get
    // （scope-local 工具不属于全局视图，传 parent 会把限制校验变成另一套语义）。
    beforeApply(context) {
      const tools = context.tools;
      const originalGet = tools.get;
      tools.get = (name, ...rest) => {
        assert.equal(rest.length, 0, "tools.get 不得接收 parent scope 参数");
        visibilityChecks.push(name);
        return originalGet(name);
      };
    },
  });
  const root = host.registerRootAgent("root-deny");
  for (const [index, role] of ["explorer", "fixer"].entries()) {
    const result = await host.toolDefinition(role).execute(
      { description: "deny " + role, prompt: "deny " + role, affectedPaths: ["file:src/" + role + ".js"] },
      roleExecution(root),
    );
    assert.equal(result.kind, "continuable", role + " 必须完成 admission");
    assert.equal(requests.length, index + 1);
  }
  const readOnlyDeny = requests[0].toolFilter.deny;
  const writeDeny = requests[1].toolFilter.deny;
  for (const name of ["write", "edit", "bash", "pwsh"]) {
    assert.ok(readOnlyDeny.includes(name), "只读角色必须拒绝 " + name);
    assert.equal(writeDeny.includes(name), false, "可写角色不应拒绝 " + name);
  }
  for (const name of ROOT_TOOL_NAMES) {
    assert.ok(readOnlyDeny.includes(name), "只读角色必须拒绝 root-only 工具 " + name);
    assert.ok(writeDeny.includes(name), "可写角色必须拒绝 root-only 工具 " + name);
  }
  // send_message 是 scope-local 工具，不属于 tools.get 的全局视图；它由插件显式补入
  // child filter，因此允许出现在 deny 里，其他 deny 名必须都来自当前可见全局工具。
  const visible = new Set(visibleTools);
  for (const deny of [readOnlyDeny, writeDeny]) {
    assert.equal(deny.includes("run_code"), false, "run_code 是 Code Mode 展示传输，不能交给 tools.restrict");
    assert.equal(deny.includes("send_message"), true, "必须显式拒绝 scope-local send_message");
    for (const name of deny) {
      if (name === "send_message") continue;
      assert.ok(visible.has(name), "deny 不得包含当前不可见的工具: " + name);
    }
  }
  assert.equal(readOnlyDeny.includes("mcp__dynamic__tool"), false, "schema 未声明的 MCP 名称不能被猜测性拒绝");
  assert.ok(visibilityChecks.length > 0, "deny 计算必须真实查询当前全局工具视图");
  assert.ok(visibilityChecks.includes("write"), "只读 deny 必须查询 write 可见性");
});

// ── 10. 角色工具真实 admission 行为 ────────────────────────────────────────

test("角色工具：短角色名注册、leaf worker marker、persona 纪律与 maxDepth 1", async () => {
  const { host, requests } = createDelegateHost();
  const root = host.registerRootAgent("root-markers");
  for (const name of ROLE_IDS) {
    assert.ok(host.toolNames().includes(name), "必须注册短角色工具 " + name);
    assert.equal(host.toolNames().includes("subagent_" + name), false, "不得注册 Harness 外层名 subagent_" + name);
  }
  for (const role of ROLE_IDS) {
    const result = await host.toolDefinition(role).execute(
      { description: "marker " + role, prompt: "marker " + role, affectedPaths: ["file:src/" + role + ".js"] },
      roleExecution(root),
    );
    assert.equal(result.kind, "continuable", role + " admission 必须被接受");
    assert.ok(["continuable", "advisory", "failure"].includes(result.kind), role + " 只能返回已公开的 admission 结果类型");
    assert.notEqual(result.kind, "foreground", "run_in_background 已退役，不得再承诺前台结果");
    assert.equal(result.started, true);
    assert.equal(result.accepted, true);
    assert.equal(typeof result.admissionToken, "string", role + " 必须返回 admissionToken");
    assert.equal(Number.isSafeInteger(result.admissionEpoch), true, role + " 必须返回 admissionEpoch");
  }
  assert.equal(requests.length, ROLE_IDS.length);
  for (const [index, role] of ROLE_IDS.entries()) {
    const request = requests[index];
    assert.equal(request.parent, root, role + " request 必须携带 exact root Agent");
    assert.equal(request.maxDepth, 1, role + " 必须用 maxDepth 1 禁止孙代理");
    assert.equal(request.agentOptions[ROLE_MARKER], role, role + " 必须写入角色 marker");
    assert.equal(request.agentOptions[PARENT_MARKER], root.id, role + " 必须写入父代理 marker");
    assert.equal(request.agentOptions[CONTINUABLE_MARKER], true, role + " 必须写入 continuable marker");
    assert.equal(request.agentOptions.provider, "mock");
    assert.equal(request.agentOptions.model, "mock");
    // persona 是 child 的公开系统提示词：固定纪律（英文短句）必须由每个角色自己携带。
    assert.equal(typeof request.persona, "string", role + " 必须携带 persona");
    assert.ok(request.persona.length > 40, role + " persona 不应为空");
    assert.match(request.persona, /You are a leaf worker: never delegate or create other subagents/);
    assert.match(request.persona, /never call workflow, ralph, or goal tools/);
    assert.match(request.persona, /Never call send_message directly, and never reach it indirectly through run_code/);
    assert.match(request.persona, /do not proactively message your parent/);
    assert.match(request.persona, /Do the task in Chinese/);
  }
});

test("RC1 provider：角色工具通过 startActivation 接受 RC1 capabilities", async () => {
  const activations = [];
  let fallbackCalls = 0;
  const provider = {
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
    prepareContinuable() {},
  };
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      // RC1 与旧入口同时存在时，必须优先使用 startActivation。
      startContinuable: async () => {
        fallbackCalls += 1;
        return { childId: "legacy-child", messageId: "legacy-message" };
      },
      startActivation: async (spec) => {
        activations.push(spec);
        return {
          childId: "rc1-child",
          messageId: "rc1-message",
          result: Promise.resolve(),
          dispose() {},
        };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1");
  const execution = roleExecution(root);
  const result = await host.toolDefinition("explorer").execute(
    { description: "RC1 dispatch", prompt: "verify RC1 dispatch", affectedPaths: ["file:src/rc1.js"] },
    execution,
  );

  assert.equal(result.kind, "continuable");
  assert.equal(result.subagentId, "rc1-child");
  assert.equal(result.messageId, "rc1-message");
  assert.equal(fallbackCalls, 0, "RC1 startActivation 存在时不得调用 legacy startContinuable");
  assert.equal(activations.length, 1);
  assert.equal(activations[0].provider, "spawn");
  assert.equal(activations[0].delivery, "parent");
  assert.equal(activations[0].label, "RC1 dispatch");
  assert.equal(activations[0].signal, execution.signal);
  assert.equal(activations[0].request.parent, root);
  assert.equal(activations[0].request.label, undefined);
  assert.equal(activations[0].request.signal, undefined);
  // persona/toolFilter 是 RC1 的 child composition 注入字段：必须原样保留在 request 上，
  // 由宿主应用到 child 系统提示词与 childCtx.tools.restrict。
  assert.equal(typeof activations[0].request.persona, "string", "RC1 request 必须携带 persona");
  assert.match(activations[0].request.persona, /You are the Explorer/);
  assert.match(activations[0].request.persona, /You are a leaf worker: never delegate or create other subagents/);
  assert.ok(Array.isArray(activations[0].request.toolFilter?.deny), "RC1 request 必须携带 toolFilter");
  assert.ok(activations[0].request.toolFilter.deny.includes("send_message"), "RC1 toolFilter 必须显式隐藏 send_message");
  assert.equal(activations[0].request.maxDepth, 1);
  assert.equal(activations[0].request.agentOptions.provider, "mock");
  assert.equal(activations[0].request.agentOptions.model, "mock");
  assert.equal(activations[0].request.agentOptions.__degExpertRole, "explorer");
  assert.equal(activations[0].request.agentOptions.__degExpertParent, root.id);
  assert.equal(activations[0].request.agentOptions.__degExpertContinuable, true);
  // 任务消息只保留「身份行 + 任务内容」两段：persona 与固定纪律不再被拼进 prompt。
  const rc1Prompt = activations[0].request.prompt[0].text;
  assert.equal(rc1Prompt.split("\n").length, 2, "RC1 任务消息必须保持两段式");
  assert.equal(rc1Prompt.split("\n", 1)[0], "你是 explorer 子代理。");
  assert.match(rc1Prompt, /任务内容：verify RC1 dispatch/);
  assert.doesNotMatch(rc1Prompt, /You are the Explorer|You are a leaf worker|专家是叶子 worker/,
    "persona 与固定纪律不得再拼进首条任务消息");
});

test("child_models schema：domain round-trip 保留 deny marker 并拒绝 malformed 数组", () => {
  const parsed = DOMAIN_CHILD_MODEL_RECORD.parse({
    provider: "mock",
    model: "mock",
    role: "fixer",
    parentId: "root-schema",
    continuable: true,
    [DENY_MARKER]: ["mcp__schema_snapshot"],
    unknownField: "必须被 domain schema 丢弃",
  });
  assert.deepEqual(parsed[DENY_MARKER], ["mcp__schema_snapshot"], "domain schema 必须保留 deny marker");
  assert.equal(parsed.unknownField, undefined, "domain schema 仍必须拒绝未知字段漂移");
  assert.throws(
    () => DOMAIN_CHILD_MODEL_RECORD.parse({
      provider: "mock",
      model: "mock",
      [DENY_MARKER]: ["mcp__schema_snapshot", 42],
    }),
    /expected.*string/i,
    "malformed deny marker 必须在 durable schema 边界被拒绝",
  );
  assert.throws(
    () => DOMAIN_CHILD_MODEL_RECORD.parse({
      provider: "mock",
      model: "mock",
      [DENY_MARKER]: Array.from({ length: 513 }, (_, index) => "mcp__" + index),
    }),
    /array|too_big|maximum/i,
    "超限 deny marker 必须在 durable schema 边界被拒绝",
  );
});

test("fan-out child：独立 onAgentCreated 路径持久化 deny marker 与 lineage", async () => {
  let host;
  let root;
  const requests = [];
  const childId = "fanout-child-marker";
  const { host: createdHost } = createDelegateHost({
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        const agent = {
          id: childId,
          parent: root,
          options: request.agentOptions,
          session: { id: "fanout-session-marker", header: { id: childId } },
        };
        queueMicrotask(() => host.emit("agent/created", { agent }));
        return { childId, messageId: "fanout-message-marker" };
      },
    },
  });
  host = createdHost;
  root = host.registerRootAgent("root-fanout-marker");
  const result = await host.toolDefinition("fanout").execute(
    {
      role: "fixer",
      basePrompt: "fan-out marker round-trip",
      shards: [{ shardId: "schema-shard", prompt: "verify durable marker" }],
    },
    roleExecution(root),
  );
  assert.equal(result.kind, "fanout");
  assert.equal(result.accepted, true, "fan-out 必须接受合法 shard");
  await flushAsyncWork(6);
  assert.equal(requests.length, 1, "fan-out 必须启动一个 shard child");
  const stored = host.storage.entries("child_models").find(([key]) => key === childId);
  assert.ok(stored, "fan-out child 必须写入 DEG 自有 child_models 快照");
  assert.deepEqual(stored[1][DENY_MARKER], requests[0].agentOptions[DENY_MARKER], "fan-out 快照必须保留 deny marker");
  assert.equal(stored[1].fanout, true, "fan-out 快照必须保留 fanout 身份");
  assert.equal(stored[1].fanoutParentTaskId, result.parentTaskId, "fan-out 快照必须保留 parentTaskId");
  assert.equal(stored[1].fanoutShardId, "schema-shard", "fan-out 快照必须保留 shardId");
  host.dispose();
});

test("RC1 child：deny marker 携带完整边界并由 agent/created guard 拒绝", async () => {
  const activations = [];
  const provider = {
    capabilities: { agentOptions: true, depthLimit: true },
    prepareContinuable() {},
  };
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    // 让静态 deny 候选全部成为当前全局工具；run_code 仍由 restrictable 规则排除。
    visibleTools: [...EXPERT_DELEGATION_DENY],
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startActivation: async (spec) => {
        activations.push(spec);
        return {
          childId: "rc1-deny-child",
          messageId: "rc1-deny-message",
          result: Promise.resolve(),
          dispose() {},
        };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1-deny");
  const result = await host.toolDefinition("fixer").execute(
    { description: "RC1 deny", prompt: "verify deny boundary" },
    roleExecution(root),
  );

  assert.equal(result.kind, "continuable");
  assert.equal(activations.length, 1);
  const request = activations[0].request;
  const expectedDeny = [...new Set([
    ...EXPERT_DELEGATION_DENY.filter((name) => name !== "run_code"),
    ...ROOT_TOOL_NAMES,
    "send_message",
  ])];
  const marker = request.agentOptions.__degExpertDeny;
  const child = {
    id: "rc1-deny-child",
    parent: root,
    options: { ...request.agentOptions },
    session: {
      id: "rc1-deny-child",
      header: { id: "rc1-deny-child", parentSession: root.id },
      requestHeader: () => ({ config: { provider: "mock", model: "mock" } }),
    },
    // 复用 host 的公开 guard 注册器，模拟真实 child 自有 tools.guard。
    ctx: { tools: host.context.tools },
  };
  host.emit("agent/created", { agent: child });
  await flushAsyncWork();

  const stored = host.storage.entries("child_models").find(([key]) => key === child.id);
  assert.ok(stored, "RC1 专家 child 必须写入 DEG 自有 child_models 快照");
  assert.deepEqual(stored[1][DENY_MARKER], marker, "child_models 必须持久化 RC1 deny marker");

  // 先收集 guard 结果，再断言 marker，确保 marker 与完整 guard 两条回归证据都被观测。
  const deniedResults = expectedDeny.map((name) => ({
    name,
    rejection: firstGuardRejection(host, { name, agent: child }),
  }));
  const reportRejection = firstGuardRejection(host, { name: "report", agent: child });
  const sendMessageRejection = firstGuardRejection(host, { name: "send_message", agent: child });
  const allowedResult = firstGuardRejection(host, { name: "read", agent: child });

  assert.deepEqual(marker, expectedDeny, "RC1 agentOptions 必须携带完整 __degExpertDeny");
  assert.ok(deniedResults.every(({ rejection }) => typeof rejection === "string"), "marker 内每个工具都必须被 child guard 拒绝");
  assert.equal(typeof reportRejection, "string", "report 必须由 child guard 拒绝");
  assert.equal(typeof sendMessageRejection, "string", "send_message 必须由 child guard 拒绝");
  assert.equal(allowedResult, undefined, "marker 外的普通工具不得被误拒绝");
  await host.dispose();
});

test("cold-resume：从 DEG child_models 恢复 deny marker 并保持后续写回", async () => {
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    visibleTools: [...EXPERT_DELEGATION_DENY, "mcp__cold_resume"],
    subagents: {
      startContinuable: async () => ({ childId: "unused", messageId: "unused-message" }),
      interrupt: () => {},
      sendMessage: async () => "unused-send",
    },
  });
  const domain = await host.storage.open({ name: "dsh-expert-group" });
  await domain.table("child_models").put("cold-child", {
    provider: "mock",
    model: "mock",
    role: "fixer",
    parentId: "root-cold",
    continuable: true,
    [DENY_MARKER]: ["mcp__cold_resume"],
    lruSequence: 1,
  });
  host.apply();
  await flushAsyncWork();
  const root = host.registerRootAgent("root-cold");
  const child = {
    id: "cold-child",
    parent: root,
    options: { provider: "mock", model: "mock" },
    session: { id: "cold-child", header: { id: "cold-child", parentSession: root.id } },
    ctx: { tools: host.context.tools },
  };
  // 冷恢复 child 只有 provider/model；身份和 deny policy 均来自 DEG 快照。
  host.emit("agent/created", { agent: child });
  await flushAsyncWork();

  const denied = firstGuardRejection(host, { name: "mcp__cold_resume", agent: child });
  assert.equal(typeof denied, "string", "cold-resume 必须恢复快照中的 deny marker");
  assert.equal(firstGuardRejection(host, { name: "read", agent: child }), undefined, "marker 不应扩大到普通工具");

  const stored = host.storage.entries("child_models").find(([key]) => key === "cold-child");
  assert.ok(stored, "cold-resume 写回后仍必须保留 child_models 记录");
  assert.deepEqual(stored[1][DENY_MARKER], ["mcp__cold_resume"], "恢复写回不得擦除 deny marker");
  await host.dispose();
});

test("RC1 provider：仅 agentOptions/depthLimit 与 prepareContinuable 也能注册角色工具", async () => {
  const activations = [];
  const provider = {
    capabilities: { agentOptions: true, depthLimit: true },
    prepareContinuable() {},
  };
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startActivation: async (spec) => {
        activations.push(spec);
        return { childId: "rc1-minimal-child", messageId: "rc1-minimal-message" };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1-minimal");
  const tool = host.toolDefinition("explorer");
  assert.ok(tool, "最小 RC1 provider 仍应注册角色工具");

  const result = await tool.execute(
    { description: "RC1 minimal", prompt: "verify minimal capability" },
    roleExecution(root),
  );

  assert.equal(result.kind, "continuable");
  assert.equal(result.subagentId, "rc1-minimal-child");
  assert.equal(activations.length, 1);
  assert.equal(activations[0].request.agentOptions.__degExpertContinuable, true);
  await host.dispose();
});

test("RC1 provider：双启动 seam 但 RC1 capability 不完整时拒绝 legacy readiness", async () => {
  let activationCalls = 0;
  let legacyCalls = 0;
  const provider = {
    // legacy 能力完整，但故意缺少 RC1 的 agentOptions；不能借 legacy readiness 放行。
    capabilities: { depthLimit: true, toolFilter: true, persona: true },
    prepareContinuable() {},
  };
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startActivation: async () => {
        activationCalls += 1;
        return { childId: "should-not-start", messageId: "should-not-start" };
      },
      startContinuable: async () => {
        legacyCalls += 1;
        return { childId: "should-not-fallback", messageId: "should-not-fallback" };
      },
    },
  });
  host.apply();

  assert.equal(host.toolDefinition("explorer"), undefined, "RC1 seam 存在且 capability 不完整时不得注册角色工具");
  assert.equal(host.toolDefinition("fixer"), undefined, "不得通过 legacy readiness 绕过 RC1 capability 校验");
  assert.equal(activationCalls, 0);
  assert.equal(legacyCalls, 0);
  await host.dispose();
});

test("RC1 适配器：冻结嵌套 request 与 ContentBlock 输入后仍保持不变", async () => {
  const activations = [];
  const provider = {
    capabilities: { agentOptions: true, depthLimit: true },
    prepareContinuable() {},
  };
  const sourceAttachment = Object.freeze({
    attachmentId: "frozen-source",
    mediaType: "image/png",
    bytes: 9,
    width: 1,
    height: 1,
    name: "frozen-source",
  });
  const copiedAttachment = Object.freeze({
    attachmentId: "frozen-copy",
    mediaType: "image/png",
    bytes: 9,
    name: "frozen-copy.png",
  });
  const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    llm: { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) },
    attachments: {
      async readImage(ref) {
        assert.equal(ref, sourceAttachment, "冻结 attachment 必须原样作为 readImage ref 传递");
        return { data: pngBytes, ref: sourceAttachment };
      },
      async saveImage(input) {
        assert.deepEqual(input.data, pngBytes);
        return copiedAttachment;
      },
    },
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startActivation: async (spec) => {
        const request = spec.request;
        const promptSnapshot = request.prompt.map((block) => ({
          ...block,
          ...(block.attachment === undefined ? {} : { attachment: { ...block.attachment } }),
        }));
        const agentOptionsSnapshot = { ...request.agentOptions };
        // 回调收到的 request 及其嵌套 block 全部冻结；admission 后续若回写会直接暴露 mutation。
        Object.freeze(request.prompt);
        for (const block of request.prompt) {
          if (block && typeof block === "object") {
            if (block.attachment && typeof block.attachment === "object") Object.freeze(block.attachment);
            Object.freeze(block);
          }
        }
        Object.freeze(request.agentOptions);
        Object.freeze(request);
        activations.push({ request, promptSnapshot, agentOptionsSnapshot });
        return { childId: "rc1-frozen-child", messageId: "rc1-frozen-message" };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1-frozen");
  const image = Object.freeze({ attachment: sourceAttachment });
  const args = Object.freeze({
    description: "RC1 frozen",
    prompt: "verify frozen content",
    image,
  });
  const argsSnapshot = {
    description: args.description,
    prompt: args.prompt,
    image: { attachment: { ...args.image.attachment } },
  };

  const result = await host.toolDefinition("explorer").execute(args, roleExecution(root));
  await flushAsyncWork();

  assert.equal(result.kind, "continuable");
  assert.equal(activations.length, 1);
  assert.deepEqual(args, argsSnapshot, "冻结的嵌套角色输入不得被 admission/适配器改写");
  assert.deepEqual(activations[0].request.prompt, activations[0].promptSnapshot, "冻结 ContentBlock 不得在 activation 后被改写");
  assert.deepEqual(activations[0].request.agentOptions, activations[0].agentOptionsSnapshot, "冻结 agentOptions 不得在 activation 后被改写");
  await host.dispose();
});


test("RC1 provider：图片 ContentBlock 保持文本 + image 顺序与 durable attachment", async () => {
  const activations = [];
  const provider = {
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
    prepareContinuable() {},
  };
  const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const sourceAttachment = {
    attachmentId: "source-image",
    mediaType: "image/png",
    bytes: pngBytes.byteLength,
    width: 1,
    height: 1,
    name: "source",
  };
  const copiedAttachment = {
    attachmentId: "copy-image",
    mediaType: "image/png",
    bytes: pngBytes.byteLength,
    name: "source.png",
  };
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    llm: { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) },
    attachments: {
      async readImage(ref) {
        assert.equal(ref, sourceAttachment, "图片 admission 必须读取原始 attachment ref");
        return { data: pngBytes, ref: sourceAttachment };
      },
      async saveImage(input) {
        assert.equal(input.mediaType, "image/png");
        assert.deepEqual(input.data, pngBytes, "PNG attachment 应按原始字节创建 durable 副本");
        return copiedAttachment;
      },
    },
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startActivation: async (spec) => {
        activations.push(spec);
        return {
          childId: "rc1-image-child",
          messageId: "rc1-image-message",
          result: Promise.resolve(),
          dispose() {},
        };
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1-image");
  const result = await host.toolDefinition("explorer").execute(
    {
      description: "RC1 image dispatch",
      prompt: "verify image dispatch",
      image: { attachment: sourceAttachment },
    },
    roleExecution(root),
  );

  assert.equal(result.kind, "continuable");
  assert.equal(activations.length, 1);
  const prompt = activations[0].request.prompt;
  assert.equal(prompt.length, 2, "任务文本与 image 必须保持两个有序 ContentBlock");
  assert.equal(prompt[0].type, "text");
  assert.match(prompt[0].text, /verify image dispatch/);
  assert.doesNotMatch(prompt[0].text, /You are the Explorer|You are a leaf worker/,
    "persona 与固定纪律走 request.persona，不得再拼进任务文本块");
  assert.deepEqual(prompt[1], { type: "image", attachment: copiedAttachment });
});

test("RC1 provider：startActivation 抛错时不得静默回退 legacy startContinuable", async () => {
  const provider = {
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
    prepareContinuable() {},
  };
  let fallbackCalls = 0;
  const activationError = new Error("RC1 activation sentinel");
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startContinuable: async () => {
        fallbackCalls += 1;
        return { childId: "legacy-child", messageId: "legacy-message" };
      },
      startActivation: async () => {
        throw activationError;
      },
    },
  });
  host.apply();
  const root = host.registerRootAgent("root-rc1-error");
  const result = await host.toolDefinition("explorer").execute(
    { description: "RC1 error", prompt: "verify RC1 error" },
    roleExecution(root),
  );

  assert.equal(result.kind, "failure");
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "admission");
  assert.equal(result.code, "ADMISSION_FAILED");
  assert.match(result.message, /RC1 activation sentinel/);
  assert.equal(fallbackCalls, 0, "startActivation 的运行时错误不得回退 legacy startContinuable");
});

test("角色工具：不同 prompt 顺序调用得到两个独立 child，且不 interrupt/不 sendMessage", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-independent");
  const explorer = host.toolDefinition("explorer");
  const execution = roleExecution(root);
  const first = await explorer.execute({ description: "one", prompt: "one" }, execution);
  assert.equal(first.subagentId, "child-1");
  assert.equal(first.reused, undefined);
  assert.equal(first.queued, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(interrupts, [], "新建 child 不需要 interrupt");

  const second = await explorer.execute({ description: "two", prompt: "two" }, execution);
  assert.equal(second.subagentId, "child-2", "不同 prompt 必须得到独立 child");
  assert.equal(second.reused, undefined);
  assert.equal(second.queued, undefined, "独立 child 不是对旧 child 的 steer/queue");
  assert.equal(requests.length, 2, "第二次任务必须新建 child");
  assert.deepEqual(interrupts, [], "独立新任务绝不得 interrupt 既有 child");
  assert.deepEqual(messages, [], "独立新任务绝不得向既有 child sendMessage");
  // 投递只允许走公开 subagents.sendMessage/interrupt：替身没有 steer/interruptAndSteer，
  // 任何私有投递尝试都会直接以 TypeError 失败。这里只锁定公开工具 schema。
  const parameters = host.toolDefinition("explorer").parameters.properties;
  assert.equal(parameters.queue.type, "boolean", "queue 必须是公开 boolean 参数");
  assert.equal(parameters.run_in_background.type, "boolean", "run_in_background 保留为兼容输入声明");
  assert.equal(parameters.childId.type, "string", "显式续作句柄必须是公开可选参数");
  assert.equal(parameters.cancelChildId.type, "string", "显式取消句柄必须是公开可选参数");
  // 两个 child 的 prompt 必须各自自包含（互不覆盖）。
  assert.match(requests[0].prompt[0].text, /one/);
  assert.match(requests[1].prompt[0].text, /two/);
  assert.notEqual(requests[0].prompt[0].text, requests[1].prompt[0].text);
});

test("角色工具：不同 prompt 经 Promise.all 并发调用得到两个 child，无 interrupt/sendMessage", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-independent-parallel");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  const [first, second] = await Promise.all([
    oracle.execute({ description: "review a", prompt: "review a" }, execution),
    oracle.execute({ description: "review b", prompt: "review b" }, execution),
  ]);
  assert.equal(requests.length, 2, "并发不同 prompt 必须各自新建 child");
  assert.deepEqual([first.subagentId, second.subagentId].sort(), ["child-1", "child-2"]);
  assert.deepEqual(interrupts, [], "并发独立任务不得 interrupt 任何 child");
  assert.deepEqual(messages, [], "并发独立任务不得向任何 child sendMessage");
  for (const result of [first, second]) {
    assert.equal(result.kind, "continuable");
    assert.equal(result.accepted, true);
    assert.equal(result.reused, undefined);
    assert.equal(result.queued, undefined);
  }
});

test("角色工具：相同 prompt 复用同一 child，不新建、不投递", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-reuse-independent");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  const first = await oracle.execute({ description: "one", prompt: "one" }, execution);
  const second = await oracle.execute({ description: "two", prompt: "two" }, execution);
  // 不同 prompt：两个独立 child。
  assert.deepEqual([first.subagentId, second.subagentId], ["child-1", "child-2"]);
  // 回到第一个 prompt：必须复用它自己的 child，而不是最近一个 child。
  const reusedFirst = await oracle.execute({ description: "again", prompt: "one" }, execution);
  assert.equal(reusedFirst.reused, true, "相同 prompt 必须复用");
  assert.equal(reusedFirst.subagentId, "child-1", "必须复用它自己的 child");
  assert.equal(requests.length, 2, "复用不得新建 child");
  assert.deepEqual(interrupts, []);
  assert.deepEqual(messages, []);
  // 第二个 prompt 的复用同样命中它自己的 child。
  const reusedSecond = await oracle.execute({ description: "again2", prompt: "two" }, execution);
  assert.equal(reusedSecond.reused, true);
  assert.equal(reusedSecond.subagentId, "child-2");
  assert.equal(requests.length, 2);
});

test("角色工具：显式 childId 才向指定 child 续作（interrupt + 公开 sendMessage）", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-explicit-continue");
  const explorer = host.toolDefinition("explorer");
  const execution = roleExecution(root);
  const first = await explorer.execute({ description: "one", prompt: "one", affectedPaths: ["file:src/a.js"] }, execution);
  const second = await explorer.execute({ description: "two", prompt: "two", affectedPaths: ["file:src/b.js"] }, execution);
  assert.deepEqual([first.subagentId, second.subagentId], ["child-1", "child-2"]);
  assert.deepEqual(messages, [], "普通派发不得投递任何消息");

  // 显式续作：只允许把消息投递给 args.childId 指定的 child。
  const continued = await explorer.execute({ description: "follow up", prompt: "follow up", childId: second.subagentId }, execution);
  assert.equal(continued.kind, "continuable");
  assert.equal(continued.queued, true);
  assert.equal(continued.subagentId, "child-2", "续作必须命中显式 childId");
  assert.equal(requests.length, 2, "续作不得新建 child");
  assert.equal(interrupts.length, 1, "续作默认先请求 ancestor interrupt");
  assert.equal(interrupts[0].childId, "child-2");
  assert.equal(interrupts[0].kind, "ancestor", "interrupt 必须使用公开 ancestor 语义");
  assert.equal(interrupts[0].agent, root, "interrupt 必须携带 exact parent authority");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].childId, "child-2", "sendMessage 只能发给显式指定的 child");
  assert.equal(messages[0].parent, root, "sendMessage 必须携带 exact parent Agent");
  assert.equal(messages[0].signal, execution.signal, "sendMessage 必须透传调用方 signal");
  assert.ok(Array.isArray(messages[0].content) && messages[0].content.length > 0, "必须经公开 sendMessage 投递 prompt 内容");
  // 另一个 child 不能被这次续作影响（既无 interrupt 也无消息）。
  assert.equal(interrupts.some((entry) => entry.childId === "child-1"), false);
  assert.equal(messages.some((entry) => entry.childId === "child-1"), false);

  // queue=true 续作只排队：不再请求 interrupt，但仍发给同一个显式 child。
  const queued = await explorer.execute({ description: "follow up 2", prompt: "follow up 2", childId: second.subagentId, queue: true }, execution);
  assert.equal(queued.queued, true);
  assert.equal(queued.subagentId, "child-2");
  assert.equal(interrupts.length, 1, "queue=true 不得再请求 interrupt");
  assert.equal(messages.length, 2);
  assert.equal(messages[1].childId, "child-2");
});

test("角色工具：显式 childId 优先于「相同 prompt 复用」——续作只发给 root 指定的 child", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-explicit-precedence");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  // 两个独立任务各自建 child；第一个 prompt 的任务绑定落在 child-1。
  const first = await oracle.execute({ description: "one", prompt: "shared text" }, execution);
  const second = await oracle.execute({ description: "two", prompt: "other text" }, execution);
  assert.deepEqual([first.subagentId, second.subagentId], ["child-1", "child-2"]);
  assert.equal(requests.length, 2);
  assert.deepEqual(messages, [], "普通派发不得投递消息");

  // 复用规则：相同 prompt 不带 childId 时复用它自己那个 child（child-1），不投递。
  const reusedFirst = await oracle.execute({ description: "reuse", prompt: "shared text" }, execution);
  assert.equal(reusedFirst.reused, true);
  assert.equal(reusedFirst.subagentId, "child-1");
  assert.equal(requests.length, 2);

  // 同一 prompt + 显式 childId=child-2：必须投递给 child-2（而不是被「相同任务复用」
  // 短路回 child-1），否则回执 subagentId 会与请求的 childId 矛盾。
  const targeted = await oracle.execute(
    { description: "again", prompt: "shared text", childId: second.subagentId },
    execution,
  );
  assert.equal(targeted.subagentId, "child-2", "显式 childId 必须胜出");
  assert.equal(targeted.queued, true);
  assert.equal(requests.length, 2, "续作不得新建 child");
  assert.deepEqual(messages.map((entry) => entry.childId), ["child-2"]);
  assert.deepEqual(interrupts.map((entry) => entry.childId), ["child-2"]);

  // 显式续作改写任务绑定：之后不带 childId 的相同 prompt 复用的是被指定的 child-2。
  const reused = await oracle.execute({ description: "again2", prompt: "shared text" }, execution);
  assert.equal(reused.reused, true);
  assert.equal(reused.subagentId, "child-2", "任务绑定必须跟随显式续作");
  assert.equal(messages.length, 1, "复用不得再次投递");
});

test("角色工具：未知 childId 返回无 admission 凭据的 rejected，不新建也不投递，且不毒化 root 批次", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-unknown-child");
  const fixer = host.toolDefinition("fixer");
  const finalize = host.toolDefinition("dsh_expert_group_finalize");
  const execution = roleExecution(root);

  // 未知 childId 在**内部 admission 窗口内**被拒绝：返回值必须落在无凭据的 rejected 变体上
  // （带 admissionEpoch/admissionToken 的 advisory 会伪造出「已为它开了一批要 finalize 的
  // admission」的假象），同时绝不派发、绝不投递、绝不 interrupt。
  for (const childId of ["child-does-not-exist", "child-" + "9".repeat(8)]) {
    const rejected = await fixer.execute({ description: "follow up", prompt: "follow up " + childId, childId }, execution);
    assert.equal(rejected.kind, "rejected", "未知 childId 必须显式拒绝续作");
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.started, false);
    assert.equal(rejected.reason, "child-not-found");
    assert.equal(rejected.code, "CHILD_NOT_FOUND");
    assert.match(rejected.warning, /childId/);
    assert.equal(Object.hasOwn(rejected, "admissionEpoch"), false, "拒绝路径不得返回 finalize 凭据");
    assert.equal(Object.hasOwn(rejected, "admissionToken"), false, "拒绝路径不得产生 admissionToken");
    assert.deepEqual(
      Object.keys(rejected).sort(),
      ["accepted", "code", "kind", "reason", "started", "warning"],
      "拒绝必须严格落在无凭据 rejected 变体（不得多出任何 admission 凭据字段）",
    );
  }
  assert.deepEqual(requests, [], "未知 childId 不得新建 child");
  assert.deepEqual(interrupts, [], "未知 childId 不得触发任何 interrupt");
  assert.deepEqual(messages, [], "未知 childId 不得投递任何消息");

  // 批次未被毒化：只有拒绝记录时，finalize(epoch 0 + 空 token 集) 仍是幂等 no-admission，
  // 而不是被一个只含内部拒绝 ticket 的空批次挡成 epoch-mismatch 或永久 pending。
  const noop = await finalize.execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    execution,
  );
  assert.equal(noop.kind, "noop");
  assert.equal(noop.reason, "no-admission");

  // 之后的合法 admission 仍拿到自己的凭据，并能用**它自己的** token 集正常收口：
  // 被拒绝的内部 ticket 不得成为必需 token，也不得让批次停在 outcome-pending。
  const admitted = await fixer.execute({ description: "real", prompt: "real work" }, execution);
  assert.equal(admitted.kind, "continuable");
  assert.equal(requests.length, 1, "合法派发只新建一个 child");
  const waiting = await finalize.execute(
    {
      admissionEpoch: admitted.admissionEpoch,
      admissionTokens: [admitted.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    },
    execution,
  );
  assert.equal(waiting.kind, "waiting", "合法 admission 必须能正常收口：拒绝记录不得进入必需 token 集");
  assert.equal(waiting.acceptedCount, 1);
  await host.dispose();
});

test("角色工具：已接受批次内的未知 childId 拒绝不改变有效 admission 集合，空 token 集不阻塞收口", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-unknown-child-accepted");
  const fixer = host.toolDefinition("fixer");
  const finalize = host.toolDefinition("dsh_expert_group_finalize");
  const execution = roleExecution(root);
  const admitted = await fixer.execute({ description: "one", prompt: "one" }, execution);
  assert.equal(admitted.kind, "continuable");
  assert.equal(typeof admitted.admissionToken, "string");

  // 同一 epoch 内再来一次未知 childId：它同样不产生凭据，因此不得进入必需 token 集。
  const rejected = await fixer.execute({ description: "bad", prompt: "bad", childId: "child-unknown" }, execution);
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.code, "CHILD_NOT_FOUND");
  assert.equal(Object.hasOwn(rejected, "admissionToken"), false);
  assert.equal(requests.length, 1, "拒绝不得新建 child");
  assert.deepEqual(messages, [], "拒绝不得投递任何消息");
  assert.deepEqual(interrupts, [], "拒绝不得触发任何 interrupt");

  // 票据 10：空 token 集不再被判为不完整——收口集合由服务端枚举，空 token 只是诊断缺失。
  const epochOnly = await finalize.execute(
    { admissionEpoch: admitted.admissionEpoch, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    execution,
  );
  assert.equal(epochOnly.kind, "waiting", "只凭批次定位键即可收口整批");
  assert.equal(epochOnly.acceptedCount, 1);
  assert.deepEqual(epochOnly.tokenDiagnostics.missing, [admitted.admissionToken]);

  // 只用调用方真正收到的那一个 token 即可收口：内部拒绝 ticket 既不要求凭据，
  // 也不让批次停在 admission-outcome-pending。
  const waiting = await finalize.execute(
    { admissionEpoch: admitted.admissionEpoch, admissionTokens: [admitted.admissionToken], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    execution,
  );
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.acceptedCount, 1);
  await host.dispose();
});

test("角色工具：cancelChildId 精确取消指定 child，不影响同 scope 的其他独立 child", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-cancel-explicit");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  const first = await oracle.execute({ description: "one", prompt: "one" }, execution);
  const second = await oracle.execute({ description: "two", prompt: "two" }, execution);
  assert.deepEqual([first.subagentId, second.subagentId], ["child-1", "child-2"]);

  // 取消第一个 child：只请求这一个 child 的取消，不派发新任务、不发消息。
  const cancelled = await oracle.execute({ description: "stop", prompt: "stop", cancelChildId: first.subagentId }, execution);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.childId, "child-1");
  assert.equal(interrupts.length, 1);
  assert.equal(interrupts[0].childId, "child-1", "取消必须精确按 childId 定位");
  assert.equal(interrupts[0].kind, "ancestor");
  assert.equal(interrupts[0].agent, root);
  assert.equal(requests.length, 2, "取消不得新建 child");
  assert.deepEqual(messages, [], "取消不得投递任何消息");
  assert.equal(interrupts.some((entry) => entry.childId === "child-2"), false, "不得误取消另一个独立 child");

  // 第二个 child 仍然可续作：取消没有破坏它的任务记录/child 记录。
  const continued = await oracle.execute({ description: "follow", prompt: "follow", childId: second.subagentId }, execution);
  assert.equal(continued.subagentId, "child-2");
  assert.equal(continued.queued, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].childId, "child-2");

  // 未知/越权 childId：返回无 admission 凭据的 rejected，绝不按 parent+role 猜测目标。
  const messagesBefore = messages.length;
  const rejected = await oracle.execute({ description: "stop-unknown", prompt: "stop-unknown", cancelChildId: "child-unknown" }, execution);
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.code, "CHILD_NOT_FOUND");
  assert.equal(rejected.reason, "child-not-found");
  assert.equal(rejected.started, false);
  assert.equal(rejected.accepted, false);
  assert.equal(Object.hasOwn(rejected, "admissionEpoch"), false, "取消路径不登记 admission，不得返回凭据");
  assert.equal(Object.hasOwn(rejected, "admissionToken"), false, "取消路径不产生 finalize 凭据");
  assert.equal(interrupts.length, 2, "未知 childId 不得触发任何 interrupt");
  assert.equal(requests.length, 2, "未知 childId 不得新建 child");
  assert.equal(messages.length, messagesBefore, "未知 childId 不得投递任何消息");
});

test("角色工具：cancelChildId 优先级高于 childId，且两者互斥语义明确", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-cancel-priority");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  const first = await oracle.execute({ description: "one", prompt: "one" }, execution);
  const second = await oracle.execute({ description: "two", prompt: "two" }, execution);

  const result = await oracle.execute(
    { description: "stop", prompt: "stop", childId: second.subagentId, cancelChildId: first.subagentId },
    execution,
  );
  assert.equal(result.kind, "cancelled");
  assert.equal(result.childId, "child-1", "cancelChildId 优先");
  assert.deepEqual(interrupts.map((entry) => entry.childId), ["child-1"]);
  assert.deepEqual(messages, [], "取消路径不得投递消息");
  assert.equal(requests.length, 2);
});

/**
 * 边界 0：task 记忆（scope.tasks LRU = 32）与 route 绑定会被淘汰/清表，但 receipt 里的
 * childId 指向的 child 依然真实存活。此时它必须仍能被显式续作与取消 —— 唯一还能证明
 * 它归属本 root+role 的载体是 recovery record。丢失这条路径会让 root 只能改派新任务，
 * 而旧 child 继续跑成孤儿。
 */
test("角色工具：route 切换后 receipt 的 childId 仍可显式续作与取消（recovery record 兜底）", async () => {
  // settings 写操作会就地合并进宿主 settings 文档（harness 只做浅拷贝）：本用例必须
  // 传入独占的深拷贝，否则会改写模块级 ROLE_DEFAULTS，污染后续依赖 mock/mock route 的用例。
  const { host, requests, interrupts, messages } = createDelegateHost({ settings: structuredClone(ROLE_DEFAULTS) });
  const root = host.registerRootAgent("root-route-switch");
  const execution = roleExecution(root);
  const fixer = host.toolDefinition("fixer");
  const releaseScope = host.toolDefinition("dsh_expert_group_release_scope");
  const first = await fixer.execute({ description: "one", prompt: "one" }, execution);
  assert.equal(first.subagentId, "child-1");

  // release_scope 已收紧为只读诊断（票据 07）：它绝不删除活动项，只回执当前范围。
  const refused = await releaseScope.execute(
    { childId: first.subagentId, role: "fixer", reason: "terminal feedback received" },
    execution,
  );
  assert.equal(refused.kind, "scope-release-refused");
  assert.equal(refused.reason, "authoritative-stop-required");
  assert.equal(refused.activeCount, 1, "诊断必须如实报告仍持有保护的活动项");
  assert.equal(refused.active[0].childId, first.subagentId);
  const refusedAgain = await releaseScope.execute(
    { childId: first.subagentId, role: "fixer", reason: "terminal feedback received again" },
    execution,
  );
  assert.equal(refusedAgain.activeCount, 1, "人工动作不得释放保护，重复调用结果稳定");

  // 切换 route：scope 里上一个 route 的任务绑定会被新 route 清掉。
  const described = host.context.settings.describe().find((entry) => entry.ns === "dsh-expert-group");
  await host.context.settings.update(
    "dsh-expert-group",
    { defaults: { fixer: { provider: "mock", model: "other-model" } } },
    described.revision,
  );
  await flushAsyncWork();
  const second = await fixer.execute({ description: "two", prompt: "two" }, execution);
  assert.equal(second.subagentId, "child-2");
  assert.equal(requests[1].agentOptions.model, "other-model", "第二次派发必须落在新 route 上");

  // task 绑定与活动范围都不再指向 child-1，但它仍是本 root 该角色真实创建的 child。
  const continued = await fixer.execute(
    { description: "back", prompt: "back to child one", childId: first.subagentId },
    execution,
  );
  assert.equal(continued.kind, "continuable", "route 切换不得让 receipt 的 childId 失效");
  assert.equal(continued.subagentId, "child-1");
  assert.equal(continued.queued, true);
  assert.equal(requests.length, 2, "显式续作不得新建 child");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].childId, "child-1");

  const cancelled = await fixer.execute(
    { description: "stop", prompt: "stop child one", cancelChildId: first.subagentId },
    execution,
  );
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.childId, "child-1");
  assert.deepEqual(interrupts.map((entry) => entry.childId), ["child-1", "child-1"], "取消必须精确命中 child-1");
  assert.equal(requests.length, 2, "取消不得新建 child");
});

test("角色工具：task 记忆被 LRU 淘汰后 receipt 的 childId 仍可显式续作（recovery record 兜底）", async () => {
  const { host, requests, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-task-lru");
  const execution = roleExecution(root);
  const fixer = host.toolDefinition("fixer");
  const first = await fixer.execute({ description: "task-1", prompt: "task-1" }, execution);
  assert.equal(first.subagentId, "child-1");
  await host.toolDefinition("dsh_expert_group_release_scope").execute(
    { childId: first.subagentId, role: "fixer", reason: "terminal feedback received" },
    execution,
  );

  // 打满 scope 任务记忆（taskLimit = 32）：第 33 个新任务起，最早那条绑定被淘汰。
  for (let index = 2; index <= 34; index += 1) {
    const created = await fixer.execute({ description: "task-" + index, prompt: "task-" + index }, execution);
    assert.equal(created.subagentId, "child-" + index);
  }
  assert.equal(requests.length, 34);

  const continued = await fixer.execute(
    { description: "back", prompt: "back to child one", childId: first.subagentId },
    execution,
  );
  assert.equal(continued.kind, "continuable", "task 绑定被淘汰不等于 child 失效");
  assert.equal(continued.subagentId, "child-1");
  assert.equal(continued.queued, true);
  assert.equal(requests.length, 34, "显式续作不得新建 child");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].childId, "child-1");
});

test("角色工具：recovery record 兜底不越权——其他 root 与其他角色仍不可显式定位", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const rootA = host.registerRootAgent("root-scope-a");
  const rootB = host.registerRootAgent("root-scope-b");
  const fixer = host.toolDefinition("fixer");
  const oracle = host.toolDefinition("oracle");
  const childA = await fixer.execute({ description: "a", prompt: "task a" }, roleExecution(rootA));
  assert.equal(childA.subagentId, "child-1");

  const crossRoot = await fixer.execute(
    { description: "b", prompt: "task b", childId: childA.subagentId },
    roleExecution(rootB),
  );
  // 越权句柄与未知句柄同一条路径：无 admission 凭据的 rejected（绝不派发/投递/ interrupt）。
  assert.equal(crossRoot.kind, "rejected", "另一个 root 不得接管本 root 的 child");
  assert.equal(crossRoot.code, "CHILD_NOT_FOUND");
  assert.equal(crossRoot.reason, "child-not-found");
  assert.equal(Object.hasOwn(crossRoot, "admissionToken"), false, "越权续作不得返回凭据");

  const crossRole = await oracle.execute(
    { description: "c", prompt: "task c", childId: childA.subagentId },
    roleExecution(rootA),
  );
  assert.equal(crossRole.kind, "rejected", "另一个角色不得续作 fixer 的 child");
  assert.equal(crossRole.code, "CHILD_NOT_FOUND");
  assert.equal(Object.hasOwn(crossRole, "admissionToken"), false, "越权续作不得返回凭据");

  const crossRoleCancel = await oracle.execute(
    { description: "d", prompt: "task d", cancelChildId: childA.subagentId },
    roleExecution(rootA),
  );
  assert.equal(crossRoleCancel.kind, "rejected", "另一个角色不得取消 fixer 的 child");
  assert.equal(crossRoleCancel.code, "CHILD_NOT_FOUND");

  assert.deepEqual(interrupts, [], "越权句柄不得触发任何 interrupt");
  assert.deepEqual(messages, [], "越权句柄不得投递任何消息");
  assert.equal(requests.length, 1, "越权句柄不得新建 child");

  // 被拒绝方的批次同样不被毒化：rootB 从未有过真实 admission，也没有凭据可用，
  // 它自己的 finalize(epoch 0 + 空 token 集) 必须仍是幂等 no-admission。
  const rootBFinalize = await host.toolDefinition("dsh_expert_group_finalize").execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    roleExecution(rootB),
  );
  assert.equal(rootBFinalize.kind, "noop");
  assert.equal(rootBFinalize.reason, "no-admission");

  // 兜底只服务本 root+role：rootA 自己仍然可以续作它自己的 child。
  const own = await fixer.execute(
    { description: "e", prompt: "task e", childId: childA.subagentId },
    roleExecution(rootA),
  );
  assert.equal(own.subagentId, "child-1");
  assert.equal(requests.length, 1);
});

/**
 * 边界 1：显式句柄（childId / cancelChildId）在 admission 之前被拒绝时，结果必须严格
 * 落在 output schema 的 rejected 变体上 —— 既不能缺少 reason/code/warning（模型看不到
 * 拒绝原因），也不能多出 admissionEpoch/admissionToken（伪造出「有真实 child admission
 * 需要 finalize」的假象，反而把 root 引向错误的收口动作）。
 */
test("角色工具：未知 cancelChildId 返回无 admission 凭据的 rejected，且字段严格符合 schema", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-cancel-unknown");
  const oracle = host.toolDefinition("oracle");
  const execution = roleExecution(root);
  await oracle.execute({ description: "one", prompt: "one" }, execution);

  const rejected = await oracle.execute(
    { description: "stop", prompt: "stop", cancelChildId: "child-unknown" },
    execution,
  );
  assert.deepEqual(
    Object.keys(rejected).sort(),
    ["accepted", "code", "kind", "reason", "started", "warning"],
    "rejected 变体的字段集必须与 schema 完全一致",
  );
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.started, false);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, "child-not-found");
  assert.equal(rejected.code, "CHILD_NOT_FOUND");
  assert.match(rejected.warning, /childId/);
  assert.equal(Object.hasOwn(rejected, "admissionEpoch"), false);
  assert.equal(Object.hasOwn(rejected, "admissionToken"), false);
  // fail-closed：validate 阶段就返回，绝不 interrupt、绝不派发、绝不投递。
  assert.deepEqual(interrupts, []);
  assert.equal(requests.length, 1);
  assert.deepEqual(messages, []);
  // render 不含 admission 后缀（没有凭据可渲染），但仍给出可读原因。
  const rendered = oracle.output.render({}, rejected);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].text, rejected.warning);
  assert.equal(rendered[0].text.includes("admissionToken"), false);
});

/**
 * 边界 2：字段只要**存在**就必须是合法的非空、非纯空白字符串。空串最危险：它过去被
 * 当成「未提供 childId」而静默新建 child，root 以为在续作、实际开了新任务。
 * 非字符串由 DSH 工具入参校验（defineTool）在 handler 之前以 INVALID_ARGS 拦下。
 */
test("角色工具：非法句柄（空串/纯空白/非字符串）必须 fail-closed，绝不派发或取消", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-invalid-handle");
  const fixer = host.toolDefinition("fixer");
  const execution = roleExecution(root);
  const base = await fixer.execute({ description: "one", prompt: "one" }, execution);
  assert.equal(base.subagentId, "child-1");
  const before = requests.length;

  for (const value of ["", "   "]) {
    const blankContinue = await fixer.execute(
      { description: "x", prompt: "continue-" + value + "x", childId: value },
      execution,
    );
    assert.deepEqual(
      Object.keys(blankContinue).sort(),
      ["accepted", "code", "kind", "reason", "started", "warning"],
      "非法 childId 必须返回 schema 的 rejected 变体",
    );
    assert.equal(blankContinue.kind, "rejected");
    assert.equal(blankContinue.code, "INVALID_CHILD_ID");
    assert.equal(blankContinue.reason, "invalid-child-id");
    assert.equal(blankContinue.started, false);
    assert.equal(blankContinue.accepted, false);
    assert.match(blankContinue.warning, /childId 必须是非空字符串/);
    assert.equal(Object.hasOwn(blankContinue, "admissionEpoch"), false);
    assert.equal(Object.hasOwn(blankContinue, "admissionToken"), false);

    const blankCancel = await fixer.execute(
      { description: "x", prompt: "cancel-" + value + "x", cancelChildId: value },
      execution,
    );
    assert.equal(blankCancel.kind, "rejected");
    assert.equal(blankCancel.code, "INVALID_CANCEL_CHILD_ID");
    assert.equal(blankCancel.reason, "invalid-child-id");
    assert.match(blankCancel.warning, /cancelChildId 必须是非空字符串/);
    assert.equal(requests.length, before, "非法句柄不得新建 child");
    assert.deepEqual(interrupts, [], "非法句柄不得请求取消");
    assert.deepEqual(messages, [], "非法句柄不得投递任何消息");
  }

  for (const [key, value] of [["childId", 42], ["childId", null], ["cancelChildId", 42], ["cancelChildId", null]]) {
    await assert.rejects(
      () => fixer.execute({ description: "x", prompt: "non-string-" + key + String(value), [key]: value }, execution),
      (error) => error?.code === "INVALID_ARGS" || /non-empty string/.test(String(error?.message)),
    );
    assert.equal(requests.length, before, "非字符串句柄不得新建 child");
    assert.deepEqual(interrupts, []);
    assert.deepEqual(messages, []);
  }

  // 边界：完全省略句柄才是「未提供」，仍然正常派发新 child。
  const omitted = await fixer.execute({ description: "new", prompt: "brand new task" }, execution);
  assert.equal(omitted.kind, "continuable");
  assert.equal(requests.length, before + 1);
});

test("角色工具：重复任务返回 reused 且不再投递任何消息", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-dup");
  const fixer = host.toolDefinition("fixer");
  await fixer.execute({ description: "same", prompt: "analyze the screenshot" }, roleExecution(root));
  const duplicate = await fixer.execute({ description: "same", prompt: "  ANALYZE\n  THE SCREENSHOT " }, roleExecution(root));
  assert.equal(duplicate.reused, true, "归一化后相同任务必须复用");
  assert.equal(duplicate.subagentId, "child-1");
  assert.equal(requests.length, 1, "reused 不得新建 child");
  assert.equal(interrupts.length, 0, "reused 不得请求 interrupt");
  assert.equal(messages.length, 0, "reused 不得发送任何新消息");
});

/**
 * 为前台登记一个带完整 expert marker 与 durable Session 的专家 child（模拟 DSH 在
 * startContinuable resolve 前同步发布的 agent/created）。只有真实 durable Session 才让
 * 「不可恢复 → 重建」这条路径可验证。
 */
function registerExpertChild(host, childId, parent, role) {
  const child = host.registerRootAgent(childId, { lifecycle: false });
  child.session.header = { id: childId, parentSession: parent.id, origin: "subagent" };
  child.options = {
    provider: "mock",
    model: "mock",
    [ROLE_MARKER]: role,
    [PARENT_MARKER]: parent.id,
    [CONTINUABLE_MARKER]: true,
  };
  host.emit("agent/created", { agent: child });
  return child;
}

test("角色工具：显式续作遇到 NOT_RESUMABLE 时重建替代 child", async () => {
  let notResumable = false;
  let expertIndex = 0;
  const { host, requests, messages } = createDelegateHost({
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        const childId = "child-" + requests.length;
        registerExpertChild(host, childId, request.parent, "oracle");
        expertIndex += 1;
        return { childId, messageId: "message-" + requests.length };
      },
      sendMessage: async (parent, childId, content, options) => {
        messages.push({ parent, childId, content, signal: options?.signal });
        if (notResumable) {
          const error = new Error("child is not resumable");
          error.code = "NOT_RESUMABLE";
          throw error;
        }
        return "sent-" + messages.length;
      },
    },
  });
  const root = host.registerRootAgent("root-resume");
  const oracle = host.toolDefinition("oracle");
  const first = await oracle.execute({ description: "one", prompt: "one" }, roleExecution(root));
  assert.equal(requests.length, 1);
  assert.equal(expertIndex, 1);
  notResumable = true;
  // 只有显式 childId 才会向既有 child 投递；投递被判定为不可恢复时重建替代 child。
  const rebuilt = await oracle.execute(
    { description: "two", prompt: "two", childId: first.subagentId },
    roleExecution(root),
  );
  assert.equal(rebuilt.kind, "continuable", rebuilt.message);
  assert.equal(rebuilt.subagentId, "child-2", "NOT_RESUMABLE 必须落到替代 child");
  assert.equal(rebuilt.queued, undefined, "重建不是排队");
  assert.equal(requests.length, 2);
  assert.equal(messages.length, 1, "失败投递后不得重复发送");
  assert.equal(messages[0].childId, "child-1", "失败投递必须发给显式续作目标");
  // 替代 child 继承同一任务绑定：相同 prompt 之后复用替代 child，而不是再新建。
  notResumable = false;
  const reused = await oracle.execute({ description: "three", prompt: "two" }, roleExecution(root));
  assert.equal(reused.reused, true, "替代 child 必须接管任务绑定");
  assert.equal(reused.subagentId, "child-2");
  assert.equal(requests.length, 2);
});

test("RC1 provider：显式 NOT_RESUMABLE 重建必须保留 caller AbortSignal", async () => {
  let notResumable = false;
  let host;
  let legacyCalls = 0;
  const activations = [];
  const sent = [];
  const provider = {
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      outputSchema: true,
      depthLimit: true,
    },
    prepareContinuable() {},
  };
  const fixture = createDelegateHost({
    subagents: {
      getProvider: (name) => name === "spawn" ? provider : undefined,
      startContinuable: async () => {
        legacyCalls += 1;
        throw new Error("RC1 显式重建不得调用 legacy startContinuable");
      },
      startActivation: async (spec) => {
        // 模拟 RC1 manager 的 admission 前检查；signal 丢失时该测试必须失败。
        spec.signal.throwIfAborted();
        activations.push(spec);
        const childId = "rc1-rebuild-child-" + activations.length;
        registerExpertChild(host, childId, spec.request.parent, "oracle");
        return {
          childId,
          messageId: "rc1-rebuild-message-" + activations.length,
          result: Promise.resolve(),
          dispose() {},
        };
      },
      sendMessage: async (parent, childId, content, options) => {
        sent.push({ parent, childId, content, signal: options?.signal });
        if (notResumable) {
          const error = new Error("child is not resumable");
          error.code = "NOT_RESUMABLE";
          throw error;
        }
        return "sent-" + sent.length;
      },
    },
  });
  host = fixture.host;
  const root = host.registerRootAgent("root-rc1-rebuild");
  const oracle = host.toolDefinition("oracle");
  const first = await oracle.execute({ description: "one", prompt: "one" }, roleExecution(root));
  assert.equal(first.kind, "continuable");
  assert.equal(activations.length, 1);

  notResumable = true;
  const rebuildExecution = roleExecution(root);
  const rebuilt = await oracle.execute(
    { description: "two", prompt: "two", childId: first.subagentId },
    rebuildExecution,
  );

  assert.equal(rebuilt.kind, "continuable", rebuilt.message);
  assert.equal(rebuilt.subagentId, "rc1-rebuild-child-2");
  assert.equal(activations.length, 2, "NOT_RESUMABLE 必须通过 RC1 startActivation 重建");
  assert.equal(activations[1].signal, rebuildExecution.signal, "显式 rebuild 必须透传 caller signal");
  assert.equal(typeof activations[1].signal.throwIfAborted, "function");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].signal, rebuildExecution.signal, "失败投递与重建必须共享本轮 signal");
  assert.equal(legacyCalls, 0, "RC1 显式重建不得回退 legacy startContinuable");
});

test("角色工具：容量耗尽时给出可读提示且不重建、不原样上抛原始码", async () => {
  let capacity = false;
  const capacityError = () => {
    const error = new Error("subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents");
    error.code = "ACTIVATION_LIMIT_REACHED";
    return error;
  };
  // 容量上限会同时拒绝新建（startContinuable）与既有 child 的冷恢复投递（sendMessage），
  // 因此两个入口都必须建模；本条只关心「独立新任务撞上限」这一形态。
  const { host, requests, messages } = createDelegateHost({
    subagents: {
      startContinuable: async ({ request }) => {
        if (capacity) throw capacityError();
        requests.push(request);
        return { childId: "child-" + requests.length, messageId: "message-" + requests.length };
      },
      sendMessage: async (parent, childId, content, options) => {
        messages.push({ parent, childId, content, signal: options?.signal });
        if (capacity) throw capacityError();
        return "sent-" + messages.length;
      },
    },
  });
  const root = host.registerRootAgent("root-capacity");
  const oracle = host.toolDefinition("oracle");
  await oracle.execute({ description: "one", prompt: "one" }, roleExecution(root));
  assert.equal(requests.length, 1, "首个任务正常新建 child");

  capacity = true;
  const blocked = await oracle.execute({ description: "two", prompt: "two" }, roleExecution(root));
  assert.equal(blocked.kind, "failure", "容量耗尽必须显式失败，不能伪装成成功");
  assert.equal(blocked.accepted, false);
  assert.equal(blocked.code, "SUBAGENT_CAPACITY_REACHED", "容量耗尽必须使用 DEG 自有稳定分类");
  assert.equal(blocked.reason, "capacity", "必须归入容量原因，而不是泛化的 admission 失败");
  // 面向用户的可读提示：说明可等待或继续使用现有子代理。
  assert.match(blocked.message, /数量上限/, "必须给出可读中文提示");
  assert.match(blocked.message, /等待/, "必须说明可以等待现有子代理完成");
  assert.match(blocked.message, /继续使用/, "必须说明可以继续使用现有子代理");
  // 不得回显宿主原始错误码或原始英文文案。
  assert.equal(blocked.message.includes("ACTIVATION_LIMIT_REACHED"), false, "不得回显宿主原始错误码");
  assert.equal(/subagent limit reached/i.test(blocked.message), false, "不得回显宿主原始英文文案");
  // 关键边界：容量耗尽不是「child 已损坏」，不得触发自动重建，也不得回落到旧 child。
  assert.equal(requests.length, 1, "容量耗尽不得创建替代 child（重建只会再撞上限）");
  assert.deepEqual(messages, [], "不同 prompt 不得回落到向既有 child 投递");
});

test("角色工具：容量耗尽不触发重建，但 NOT_RESUMABLE 的安全边界保持不变", async () => {
  let mode = "capacity";
  const { host, requests, messages } = createDelegateHost({
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        const childId = "child-" + requests.length;
        registerExpertChild(host, childId, request.parent, "fixer");
        return { childId, messageId: "message-" + requests.length };
      },
      sendMessage: async (parent, childId, content, options) => {
        messages.push({ parent, childId, content, signal: options?.signal });
        const error = new Error(mode === "capacity" ? "subagent limit reached" : "child is not resumable");
        error.code = mode === "capacity" ? "ACTIVATION_LIMIT_REACHED" : "NOT_RESUMABLE";
        throw error;
      },
    },
  });
  const root = host.registerRootAgent("root-capacity-boundary");
  const fixer = host.toolDefinition("fixer");
  const first = await fixer.execute({ description: "one", prompt: "one" }, roleExecution(root));
  assert.equal(requests.length, 1);

  const blocked = await fixer.execute(
    { description: "two", prompt: "two", childId: first.subagentId },
    roleExecution(root),
  );
  assert.equal(blocked.kind, "failure", "容量耗尽不得新建 child");
  assert.equal(blocked.reason, "capacity");
  assert.equal(requests.length, 1, "容量耗尽后 child 数不变");

  mode = "not-resumable";
  const rebuilt = await fixer.execute(
    { description: "three", prompt: "three", childId: first.subagentId },
    roleExecution(root),
  );
  assert.equal(rebuilt.kind, "continuable", rebuilt.message ?? "NOT_RESUMABLE 仍必须重建");
  assert.equal(rebuilt.subagentId, "child-2", "NOT_RESUMABLE 的重建边界未扩大也未收紧");
  assert.equal(requests.length, 2);
});

test("角色工具：UNAUTHORIZED 与 DRAINING 仍原样上抛，不被容量分类吞掉", async () => {
  for (const code of ["UNAUTHORIZED", "DRAINING"]) {
    let fail = false;
    const { host, messages } = createDelegateHost({
      subagents: {
        sendMessage: async (parent, childId, content, options) => {
          messages.push({ parent, childId, content, signal: options?.signal });
          if (fail) {
            const error = new Error(code === "DRAINING" ? "continuable subagents are draining" : "message delivery requires the exact live sender agent");
            error.code = code;
            throw error;
          }
          return "sent-" + messages.length;
        },
      },
    });
    const root = host.registerRootAgent("root-" + code);
    const explorer = host.toolDefinition("explorer");
    const first = await explorer.execute({ description: "one", prompt: "one" }, roleExecution(root));
    fail = true;
    // 续作路径的投递失败必须原样上抛；普通新任务不会再回落到向既有 child 投递。
    const rejected = await explorer.execute(
      { description: "two", prompt: "two", childId: first.subagentId },
      roleExecution(root),
    );
    assert.equal(rejected.kind, "failure", code + " 必须显式失败");
    // 权限与排空错误必须保留原错误契约（原样上抛，不被改写成容量提示）。
    assert.equal(rejected.message.includes("数量上限"), false, code + " 不得被伪装成容量提示");
    await host.dispose();
  }
});

test("角色工具：取消信号在投递前中止且不产生任何 child 副作用", async () => {
  const { host, requests, interrupts, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-abort");
  const designer = host.toolDefinition("designer");
  await designer.execute({ description: "one", prompt: "one" }, roleExecution(root));
  const controller = new AbortController();
  controller.abort();
  const aborted = await designer.execute({ description: "two", prompt: "two" }, roleExecution(root, { signal: controller.signal }));
  assert.equal(aborted.kind, "failure");
  assert.equal(aborted.started, false);
  assert.equal(aborted.accepted, false);
  assert.equal(requests.length, 1, "取消不得新建 child");
  assert.equal(interrupts.length, 0, "取消后不得请求 interrupt");
  assert.equal(messages.length, 0, "取消后不得经公开 sendMessage 投递");
});

test("角色工具：run_in_background 只是兼容输入，admission 始终非阻塞", async () => {
  // 每次 startContinuable 都在自己的 gate 上挂起：只有用例显式放行才会被接受。
  const releaseGates = [];
  let concludeCalls = 0;
  const { host } = createDelegateHost({
    subagents: {
      startContinuable: async () => {
        await new Promise((resolve) => releaseGates.push(resolve));
        return { childId: "late-child", messageId: "late-message" };
      },
    },
  });
  const root = host.registerRootAgent("root-bg");
  const execute = (role, args) => host.toolDefinition(role).execute(
    args,
    roleExecution(root, { concludeTurn: () => { concludeCalls += 1; } }),
  );
  const stillPending = (promise) => Promise.race([
    promise.then(() => "resolved", () => "rejected"),
    new Promise((resolve) => setImmediate(() => resolve("still-pending"))),
  ]);

  const background = execute("explorer", { description: "bg", prompt: "bg", run_in_background: true });
  assert.equal(await stillPending(background), "still-pending", "role tool 不得等待 child admission 之外的结果");
  assert.equal(concludeCalls, 0, "role tool 自己不得结束 root turn");
  releaseGates.shift()();
  const result = await background;
  assert.equal(result.kind, "continuable");
  assert.equal(result.subagentId, "late-child");
  assert.equal(concludeCalls, 0, "admission 返回后仍不得自动收口");

  // run_in_background:false 只是兼容输入：同样不得分出等待 child 的前台路径。
  const foreground = execute("librarian", { description: "fg", prompt: "fg", run_in_background: false });
  assert.equal(await stillPending(foreground), "still-pending", "run_in_background:false 也必须是非阻塞 admission");
  releaseGates.shift()();
  const foregroundResult = await foreground;
  assert.equal(foregroundResult.kind, "continuable");
  assert.equal(concludeCalls, 0, "false 兼容输入不得触发 root turn 收口");
  assert.equal(host.toolDefinition("explorer").isConcurrencySafe, undefined, "会改共享状态的角色工具必须保持默认独占调度");
});

test("角色工具：同父同角色并发相同任务只 start 一次，第二个 reused", async () => {
  const { host, requests, messages } = createDelegateHost();
  const root = host.registerRootAgent("root-concurrent");
  const fixer = host.toolDefinition("fixer");
  const results = await Promise.all([
    fixer.execute({ description: "same", prompt: "same task" }, roleExecution(root)),
    fixer.execute({ description: "same", prompt: "same task" }, roleExecution(root)),
  ]);
  assert.equal(requests.length, 1, "并发相同任务只允许一次 startContinuable");
  assert.equal(results[0].reused, undefined);
  assert.equal(results[1].reused, true);
  assert.equal(messages.length, 0, "reused 分支不得投递消息");
});

test("角色工具：affectedPaths 冲突返回 SCOPE_CONFLICT advisory，allowOverlap 才放行", async () => {
  const { host, requests } = createDelegateHost();
  const root = host.registerRootAgent("root-scope");
  const fixer = host.toolDefinition("fixer");
  const accepted = await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  assert.equal(accepted.kind, "continuable");
  assert.equal(requests.length, 1);

  const conflict = await host.toolDefinition("designer").execute(
    { description: "overlap", prompt: "overlap", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  assert.equal(conflict.kind, "advisory");
  assert.equal(conflict.code, "SCOPE_CONFLICT");
  assert.equal(conflict.started, false);
  assert.equal(conflict.accepted, false);
  assert.match(conflict.warning, /allowOverlap=true/);
  assert.equal(requests.length, 1, "advisory 必须在任何 child 副作用之前返回");

  const overridden = await host.toolDefinition("designer").execute(
    { description: "overlap", prompt: "overlap", affectedPaths: ["file:src/shared.js"], allowOverlap: true },
    roleExecution(root),
  );
  assert.equal(overridden.kind, "continuable", "allowOverlap=true 必须放行");
  assert.match(overridden.scopeWarning, /overlaps active expert work/);
  assert.equal(requests.length, 2);
});

// ── 11. root 结构化 guard 与 finalize 的真实接线 ───────────────────────────

test("真实 apply：root 结构化文件 guard 按活动专家范围拒绝并放行不相关工具", async () => {
  const { host } = createDelegateHost();
  const root = host.registerRootAgent("root-guard-wired");
  assert.ok(host.guards.length >= 1, "apply 必须注册 tools.guard");
  const fixer = host.toolDefinition("fixer");
  const accepted = await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  assert.equal(accepted.kind, "continuable");

  const blocked = firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent: root });
  assert.match(String(blocked), /overlaps active expert work/, "root 读取活动专家范围必须被拒绝");
  assert.match(String(blocked), /fixer \(edit shared\)/);
  assert.equal(firstGuardRejection(host, { name: "edit", arguments: { file_path: "docs/guide.md" }, agent: root }), undefined, "不相交路径必须放行");
  assert.match(String(firstGuardRejection(host, { name: "glob", arguments: {}, agent: root })), /unknown\/workspace-wide/, "缺少 path 的 glob 视为未知范围");
  for (const name of ["fixer", "todo_write", "run_code", "bash", "pwsh"]) {
    assert.equal(firstGuardRejection(host, { name, arguments: { path: "src/shared.js" }, agent: root }), undefined, name + " 不是结构化文件工具，必须放行");
  }
  // 人工动作不释放保护（票据 07/11）：release_scope 只诊断，guard 继续拒绝同路径读取。
  // 权威停止证据（child turn/end、disposal）释放范围的接线由 activation-lifecycle 覆盖。
  const refused = await host.toolDefinition("dsh_expert_group_release_scope").execute(
    { childId: accepted.subagentId, role: "fixer", reason: "terminal feedback received" },
    roleExecution(root),
  );
  assert.equal(refused.kind, "scope-release-refused");
  assert.equal(refused.activeCount, 1, "必须如实报告该 child 的活动范围");
  assert.match(String(firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent: root })), /overlaps active expert work/, "人工动作不得释放保护");

  // child Agent 不属于该 root：同一 guard 不得影响 child 自己的文件操作。
  const childAgent = { id: "child-1", session: { header: { id: "child-1", parentSession: root.id } } };
  assert.equal(firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent: childAgent }), undefined);
});

test("真实 apply：root 结构化 guard 不读取未注入的 cwd/懒 getter", async () => {
  const { host } = createDelegateHost();
  // lifecycle:false 只登记 registry；先注入会抛错的懒 cwd，再发布 agent/created，
  // 让 guard 安装与执行期间任何 cwd 读取都直接失败（DSH 的 header.cwd 与 ctx.cwd
  // 都是未注入的懒 getter，读取会中断 SessionRuntime.create）。
  const root = host.registerRootAgent("root-lazy-cwd", { lifecycle: false });
  Object.defineProperty(root.session.header, "cwd", {
    configurable: true,
    get() { throw new Error("guard 不得读取 session.header.cwd"); },
  });
  host.emit("agent/created", { agent: root });
  assert.ok(host.guards.length >= 1, "root 注册后必须安装结构化文件 guard");
  const fixer = host.toolDefinition("fixer");
  await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  assert.match(String(firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent: root })), /overlaps active expert work/);
  assert.equal(firstGuardRejection(host, { name: "read", arguments: { file_path: "docs/guide.md" }, agent: root }), undefined);
  await host.dispose();
});

test("dsh_expert_group_finalize：root-only 两阶段契约，不暂停 goal、不主动 concludeTurn", async () => {
  const { host, goalCalls } = createDelegateHost();
  const root = host.registerRootAgent("root-finalize");
  const finalize = host.toolDefinition("dsh_expert_group_finalize");
  assert.ok(finalize, "apply 必须注册 dsh_expert_group_finalize");
  assert.ok(host.toolNames().includes("dsh_expert_group_finalize"));

  // 没有任何 admission 的空批次是幂等 noop，并且立即收口（不会悬挂）。
  let concludeCalls = 0;
  const noop = await finalize.execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    roleExecution(root, { concludeTurn: () => { concludeCalls += 1; } }),
  );
  assert.equal(noop.kind, "noop");
  assert.equal(noop.reason, "no-admission");
  assert.equal(concludeCalls, 0);
  assert.equal("paused" in noop, false, "回执不得再带 paused");
  assert.equal("concluded" in noop, false, "回执不得再带 concluded");

  // 未完成 summary/outcome 检查与 safeParallelWork 仍是稳定拒绝码；token 集不再是拒绝条件。
  const rejectedSummary = await finalize.execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: false, outcomesChecked: true, safeParallelWork: false },
    roleExecution(root),
  );
  assert.equal(rejectedSummary.reason, "summary-or-outcome-check-required");
  const rejectedParallel = await finalize.execute(
    { admissionEpoch: 0, admissionTokens: [], summaryCompleted: true, outcomesChecked: true, safeParallelWork: true },
    roleExecution(root),
  );
  assert.equal(rejectedParallel.reason, "safe-parallel-work-remains");

  const explorer = host.toolDefinition("explorer");
  const admission = await explorer.execute({ description: "work", prompt: "work" }, roleExecution(root));
  // 票据 10：不传 token 也能收口整批（诊断回报 missing），不再有 incomplete 拒绝。
  const epochOnly = await finalize.execute(
    { admissionEpoch: admission.admissionEpoch, summaryCompleted: true, outcomesChecked: true, safeParallelWork: false },
    roleExecution(root),
  );
  assert.equal(epochOnly.kind, "waiting");
  assert.equal(epochOnly.acceptedCount, 1);
  assert.deepEqual(epochOnly.tokenDiagnostics.missing, [admission.admissionToken]);
  assert.equal("paused" in epochOnly, false);

  // 完整的 accepted 批次：finalize 只登记等待并**立即**返回非终态 waiting，
  // 绝不在工具调用内等待专家结束（等待由 root turn 的 turn-stopping 边界承担）。
  const finalizationArgs = {
    admissionEpoch: admission.admissionEpoch,
    admissionTokens: [admission.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  };
  const waiting = await finalize.execute(
    finalizationArgs,
    roleExecution(root, { concludeTurn: () => { concludeCalls += 1; } }),
  );
  assert.equal(waiting.kind, "waiting", "合法非空批次必须立即返回 waiting，而不是等待专家结束");
  assert.equal(waiting.reason, "experts-running");
  assert.equal(waiting.acceptedCount, 1);
  assert.equal(concludeCalls, 0, "finalize 绝不调用 exec.concludeTurn()");
  assert.deepEqual(goalCalls, [], "finalize 绝不调用任何 goal API");
  // 重复合法 finalize 是稳定 waiting：不重复登记，也不提前关闭批次。
  const repeated = await finalize.execute(finalizationArgs, roleExecution(root));
  assert.deepEqual(repeated, waiting, "同一批次重复合法 finalize 必须得到同一回执");

  // root turn 的 serial 边界继续等待：专家仍在运行时 turn 保持打开，且绝不提前投递结论。
  const stopResults = host.emit("agent/turn-stopping", { agent: root, turn: 1 });
  const waits = stopResults.filter((value) => value !== null && typeof value === "object" && typeof value.then === "function");
  assert.equal(waits.length, 1, "pending-close 批次必须让 root turn 的 turn-stopping 参与等待");
  let stopSettled = false;
  Promise.all(waits).then(() => { stopSettled = true; });
  await flushAsyncWork(12);
  assert.equal(stopSettled, false, "专家未结束时 root turn 必须保持打开");
  assert.deepEqual(host.agentSteerMessages(root), [], "等待登记阶段绝不投递终态结论");

  // root 退休：等待被取消，既不关闭批次也不投递结论（取消不是专家完成）。
  host.disposeAgent(root);
  await flushAsyncWork(12);
  assert.equal(stopSettled, true, "root 退休必须收口等待，不留下悬空 Promise");
  assert.deepEqual(host.agentSteerMessages(root), [], "root 退休后旧代际绝不投递收口结论");
  assert.equal(concludeCalls, 0);
  assert.deepEqual(goalCalls, []);
  await host.dispose();
});

test("root 用户等待 guard：放行 ask_user_question/exit_plan_mode，且不触碰任何 goal API", async () => {
  const { host, goalCalls } = createDelegateHost();
  const root = host.registerRootAgent("root-wait");
  // 用户等待不再依赖 goal：guard 直接放行，root turn 由宿主保持打开。
  assert.equal(firstGuardRejection(host, { name: "ask_user_question", arguments: {}, agent: root }), undefined);
  assert.equal(firstGuardRejection(host, { name: "exit_plan_mode", arguments: {}, agent: root }), undefined);
  // 非用户等待工具不受影响。
  assert.equal(firstGuardRejection(host, { name: "read", arguments: { file_path: "docs/x.md" }, agent: root }), undefined);
  assert.deepEqual(goalCalls, [], "用户等待 guard 绝不调用 goal API");

  // 真实用户回复（user/message，source.kind=user）清理等待；重复消息幂等。
  host.emit("session/event", root.session, { type: "user/message", data: { source: { kind: "user" }, message: { id: "user-1" } } });
  await flushAsyncWork();
  assert.equal(firstGuardRejection(host, { name: "ask_user_question", arguments: {}, agent: root }), undefined);
  host.emit("session/event", root.session, { type: "user/message", data: { source: { kind: "user" }, message: { id: "user-2" } } });
  await flushAsyncWork();
  assert.deepEqual(goalCalls, [], "用户回复路径同样不得调用 goal API");

  // 已销毁 root：guard 必须明确拒绝，绝不开始一个没有归属的等待。
  host.disposeAgent(root);
  const rejection = firstGuardRejection(host, { name: "exit_plan_mode", arguments: {}, agent: root });
  assert.match(String(rejection), /no longer live/, "已销毁 root 的用户等待必须被拒绝");
  await host.dispose();
});

test("root 用户等待 guard：宿主完全没有 goals 服务时语义不变", async () => {
  const host = createPluginHost({ settings: ROLE_DEFAULTS, goals: "missing" });
  host.apply();
  const root = host.registerRootAgent("root-no-goal-service");
  for (const name of ["ask_user_question", "exit_plan_mode"]) {
    assert.equal(
      firstGuardRejection(host, { name, arguments: {}, agent: root }),
      undefined,
      name + " 不得因为缺少 goals 服务而被拒绝",
    );
  }
  assert.equal(firstGuardRejection(host, { name: "read", arguments: { file_path: "docs/x.md" }, agent: root }), undefined);
  await host.dispose();
});

// ── 12. child_models 快照与重启恢复 ────────────────────────────────────────

test("child_models 快照：agent/created 持久化 role/parentId/continuable", async () => {
  const { host } = createDelegateHost();
  const root = host.registerRootAgent("root-snapshot");
  const fixer = host.toolDefinition("fixer");
  const admission = await fixer.execute({ description: "snapshot", prompt: "snapshot" }, roleExecution(root));
  const childId = admission.subagentId;
  // 公开 agent/created 事件：插件必须按 marker 写出可重启恢复的模型快照。
  host.emit("agent/created", {
    agent: {
      id: childId,
      parent: root,
      options: {
        provider: "mock",
        model: "mock",
        [ROLE_MARKER]: "fixer",
        [PARENT_MARKER]: root.id,
        [CONTINUABLE_MARKER]: true,
      },
      session: { id: childId, parentSession: root.id, snapshotEvents: () => [] },
    },
  });
  await flushAsyncWork();
  const stored = host.storage.entries("child_models").find(([key]) => key === childId);
  assert.ok(stored, "child_models 必须写入专家 child 快照");
  assert.equal(stored[1].role, "fixer");
  assert.equal(stored[1].parentId, root.id);
  assert.equal(stored[1].continuable, true);
  assert.equal(stored[1].provider, "mock");
  assert.equal(stored[1].model, "mock");
  await host.dispose();
});

test("重启恢复：按 parentId+role+route 选择最新 continuable 快照，忽略无标记与 fan-out 记录", async () => {
  const requests = [];
  const messages = [];
  const host = createPluginHost({
    settings: ROLE_DEFAULTS,
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        return { childId: "fresh-child", messageId: "fresh-message" };
      },
      sendMessage: async (parent, childId, content, options) => {
        messages.push({ parent, childId, content, signal: options?.signal });
        return "resumed-message";
      },
      interrupt: () => {},
    },
  });
  // 用 storageDomain 公开契约在插件初始化前预置 durable 快照。
  const domain = await host.storage.open({ name: "dsh-expert-group" });
  const childTable = domain.table("child_models");
  await childTable.put("snapshot-old", { provider: "mock", model: "mock", role: "fixer", parentId: "root-restore", continuable: true, lruSequence: 1 });
  await childTable.put("snapshot-new", { provider: "mock", model: "mock", role: "fixer", parentId: "root-restore", continuable: true, lruSequence: 2 });
  // 更新的旧版 one-shot 记录没有 continuable 标记：不得被当作可复用 child。
  await childTable.put("snapshot-legacy", { provider: "mock", model: "mock", role: "fixer", parentId: "root-restore", lruSequence: 3 });
  // route 不同（换模型）的快照不可复用。
  await childTable.put("snapshot-other-route", { provider: "mock", model: "other", role: "fixer", parentId: "root-restore", continuable: true, lruSequence: 4 });
  // 另一个父代理名下、route 相同的快照不可复用。
  await childTable.put("snapshot-other-parent", { provider: "mock", model: "mock", role: "fixer", parentId: "root-elsewhere", continuable: true, lruSequence: 5 });
  // fan-out child 属于另一条恢复链，即使 route/role 相同也不得被普通专家恢复。
  await childTable.put("snapshot-fanout", {
    provider: "mock", model: "mock", role: "fixer", parentId: "root-restore", continuable: true,
    fanout: true, fanoutParentTaskId: "task-1", fanoutParentAgentId: "root-restore", fanoutShardId: "s1", fanoutAttempt: 1,
    lruSequence: 6,
  });
  host.apply();
  await flushAsyncWork();

  const root = host.registerRootAgent("root-restore");
  const result = await host.toolDefinition("fixer").execute({ description: "resume", prompt: "resume" }, roleExecution(root));
  assert.equal(result.kind, "continuable");
  assert.equal(requests.length, 0, "快照恢复不得新建 child");
  assert.equal(messages.length, 1, "恢复后的 child 走公开 sendMessage 排队");
  assert.equal(messages[0].childId, "snapshot-new", "必须选择序号最新的 continuable 快照");
  assert.equal(result.subagentId, "snapshot-new");
  assert.equal(result.queued, true, "重启恢复不恢复任务指纹，同一 prompt 也走排队");
  await host.dispose();
});

test("root Agent 退役后新 generation 不复用旧 child scope", async () => {
  const { host, requests, messages } = createDelegateHost();
  const first = host.registerRootAgent("root-generation");
  const fixer = host.toolDefinition("fixer");
  const created = await fixer.execute({ description: "one", prompt: "one" }, roleExecution(first));
  assert.equal(created.subagentId, "child-1");
  assert.equal(requests.length, 1);
  host.emit("agent/disposed", { agent: first });
  await flushAsyncWork();

  const second = host.registerRootAgent("root-generation");
  const again = await fixer.execute({ description: "one", prompt: "one" }, roleExecution(second));
  assert.equal(requests.length, 2, "退役 root 的 child scope 不得泄漏到新 generation");
  assert.equal(again.subagentId, "child-2");
  assert.equal(messages.length, 0, "不得把新 root 的任务投递给旧 child");
  await host.dispose();
});

test("影响范围保护：root 结束/代际替换不释放，只由该 child 的 turn/end 释放", async () => {
  const { host, requests } = createDelegateHost();
  const fixer = host.toolDefinition("fixer");
  const first = host.registerRootAgent("root-stop-boundary");
  const accepted = await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(first),
  );
  assert.equal(accepted.kind, "continuable");
  const childId = accepted.subagentId;
  const read = (agent) => firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent });
  assert.match(String(read(first)), /overlaps active expert work/);

  // 1) 同 id 新 generation：代际更新不是停止证据，保护与冲突检查都必须保留。
  const second = host.registerRootAgent("root-stop-boundary");
  await flushAsyncWork();
  assert.match(String(read(second)), /overlaps active expert work/, "代际更新不得释放仍在运行 child 的范围");
  const conflict = await fixer.execute(
    { description: "edit shared again", prompt: "edit shared again", affectedPaths: ["file:src/shared.js"] },
    roleExecution(second),
  );
  assert.equal(conflict.kind, "advisory");
  assert.equal(conflict.code, "SCOPE_CONFLICT");
  assert.equal(requests.length, 1, "冲突必须在任何 child 副作用之前返回");

  // 2) root 销毁同样不是停止证据：保护保持（detached），同路径读取继续被拒绝。
  host.emit("agent/disposed", { agent: second });
  await flushAsyncWork();
  assert.match(String(read(second)), /overlaps active expert work/, "root dispose 不得释放保护");

  // 3) 该 child 自己的 turn/end 才是权威停止证据（按该 turn 的稳定 messageId 精确释放）。
  const session = {
    id: childId,
    header: { id: childId, parentSession: first.id },
    events: [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: accepted.messageId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "done" }] } } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ],
  };
  host.emit("session/event", session, session.events.at(-1));
  await flushAsyncWork();
  assert.equal(read(second), undefined, "child turn/end 必须释放 detached 范围");
  await host.dispose();
});

test("影响范围保护：root 销毁后 child disposal 是权威停止证据", async () => {
  const { host } = createDelegateHost();
  const fixer = host.toolDefinition("fixer");
  const root = host.registerRootAgent("root-stop-disposal");
  const accepted = await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  assert.equal(accepted.kind, "continuable");
  const read = () => firstGuardRejection(host, { name: "read", arguments: { file_path: "src/shared.js" }, agent: root });
  assert.match(String(read()), /overlaps active expert work/);

  host.emit("agent/disposed", { agent: root });
  await flushAsyncWork();
  assert.match(String(read()), /overlaps active expert work/, "root 销毁不得释放保护");

  // child Agent 的权威 disposal：root 已不在，record 已丢弃，只能由 disposal 收口。
  host.emit("agent/disposed", {
    agent: {
      id: accepted.subagentId,
      options: { provider: "mock", model: "mock" },
      session: { id: accepted.subagentId, header: { id: accepted.subagentId, parentSession: root.id } },
    },
  });
  await flushAsyncWork();
  assert.equal(read(), undefined, "child disposal 必须释放 detached 范围");
  await host.dispose();
});

test("运行时诊断：delegation 块只暴露计数与最近拒绝摘要", async () => {
  const { host } = createDelegateHost();
  const root = host.registerRootAgent("root-delegation-diag");
  const fixer = host.toolDefinition("fixer");
  await fixer.execute(
    { description: "edit shared", prompt: "edit shared", affectedPaths: ["file:src/shared.js"] },
    roleExecution(root),
  );
  await host.toolDefinition("dsh_expert_group_release_scope").execute(
    { childId: "child-1", reason: "inspect" },
    roleExecution(root),
  );
  const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(meta.ok, true);
  const delegation = meta.value.diagnostics.delegation;
  assert.equal(delegation.activeScopeCount, 1);
  assert.equal(delegation.detachedScopeCount, 0);
  assert.equal(delegation.lastRefusedRelease.activeCount, 1);
  assert.equal(delegation.lastRefusedRelease.reason, "authoritative-stop-required");
  // 只读投影不得带 id/路径/任务正文（与 meta 的敏感字段扫描同一口径）。
  const serialized = JSON.stringify(delegation);
  assert.equal(serialized.includes("child-1"), false);
  assert.equal(serialized.includes("src/shared.js"), false);
  assert.equal(serialized.includes("edit shared"), false);
  await host.dispose();
});

// ── 13. routing prompt 与 role tool description ───────────────────────────

test("routing section：只暴露动态路由事实且只注入 root 会话", async () => {
  const { host } = createDelegateHost();
  const root = host.registerRootAgent("root-routing");
  const text = sectionText(host, "dsh-expert-group:routing", { agent: root });
  assert.match(text, /Enabled expert tools: /, "必须列出当前可用专家工具");
  for (const role of ROLE_IDS) {
    assert.ok(text.includes(role), "routing 必须列出 " + role);
  }
  assert.ok(text.includes("fanout"), "routing 必须列出通用 fanout 入口");
  assert.match(text, /Image tasks may use observer/);
   assert.match(text, /any role tool may receive a direct image attachment/);
  // child 会话不是 root：routing 不注入。
  const childContext = { agent: { id: "child-1", session: { header: { id: "child-1", parentSession: root.id } } } };
  assert.equal(sectionText(host, "dsh-expert-group:routing", childContext), "");
  await host.dispose();
});

test("routing section：provider 未就绪时声明不可用且不注册角色工具", async () => {
  const host = createPluginHost({ providerReady: false, settings: ROLE_DEFAULTS });
  host.apply();
  const root = host.registerRootAgent("root-no-provider");
  const text = sectionText(host, "dsh-expert-group:routing", { agent: root });
  assert.match(text, /unavailable/);
  assert.doesNotMatch(text, /Enabled expert tools/);
  for (const role of ROLE_IDS) {
    assert.equal(host.toolNames().includes(role), false, role + " 在 provider 不可用时不得注册");
  }
  await host.dispose();
});

test("role tool description：只保留短派发契约，长编排协议不复制进 tool schema", () => {
  // 旧的 2.2k 编排协议（多 child 语义、显式 childId 续作、cancelChildId 取消、
  // finalize 等待）必须退役：完整流程留在 root prompt，role tool 只保留五项派发契约。
  assert.equal(roleToolDescription.endsWith(ROLE_TOOL_ADMISSION_CONTRACT), true, "工具门面必须原样复用权威派发说明");
  assert.match(roleToolDescription, /must be self-contained/);
  assert.match(roleToolDescription, /the workspace path, the allowed scope, the expected verification, and the affectedPaths/);
  assert.match(roleToolDescription, /The fixed child discipline is injected by the plugin on the child itself/);
  assert.match(roleToolDescription, /never restate it in the task body/);
  for (const retired of [
    /归一化后完全相同的任务复用/,
    /续作必须显式指定 childId/,
    /CHILD_NOT_FOUND/,
    /INVALID_CHILD_ID/,
    /cancelChildId/,
    /dsh_expert_group_finalize/,
    /continue_parent_turn/,
    /queue=true/,
    /不能把它当作等待机制/,
    /<Workflow>/,
  ]) {
    assert.doesNotMatch(roleToolDescription, retired, "长编排协议不得回归 tool schema：" + retired);
  }
  // 同一份文本会随每个角色重复下发，必须有明显长度约束。
  assert.ok(roleToolDescription.length < 700,
    "role tool description 必须明显缩短，实际 " + roleToolDescription.length + " 字符");
  assert.ok(ROLE_TOOL_ADMISSION_CONTRACT.length < 300,
    "派发契约本身必须是一条短说明，实际 " + ROLE_TOOL_ADMISSION_CONTRACT.length + " 字符");
});

// ── 14. client bundle：公开描述符与 apply 注册账本 ─────────────────────────

test("client：公开 apply 注册设置页、插件详情摘要、chat node、session 状态桥、侧栏 tab 与 shell.overlay", async () => {
  const runtime = createClientReactRuntime();
  const { client, descriptor } = await loadClientBundle({ react: runtime.react });
  assert.equal(descriptor.id, "dsh-expert-group", "client-entry.js 必须通过 ModuleLoader 描述符登记模块");
  assert.equal(typeof client.apply, "function", "bundle 必须导出公开 apply(ctx)");

  const host = createHostContextStub();
  client.apply(host.ctx);
  // slots 注册账本是 Host 的公开面。DSH 0.2.0-rc1 已提供原生状态行，DEG 不再注册
  // conversation.input.dock；但右侧栏 tab 仍由 sidebar IIFE 注册（发布 bundle 里它
  // 恒先于 descriptor 执行）。R0-03 之后 source 模式也按 manifest 装载全部 IIFE，
  // 因此这份账本与真实发布 bundle 一致，不再退化成「只加载 client-entry.js」的 4 项。
  assert.deepEqual([...host.registrations.keys()].sort(),
    [
      "conversation.chat.node",
      // 左侧栏入口与主面板：sidebar.panellist 行随 sidebarEntryEnabled 动态注册，
      // main 面板始终注册（见 client-sidebar-entry.js 与 test/sidebar-entry.test.mjs）。
      "main",
      "plugins.bundle.config",
      "settings.section",
      "shell.overlay",
      "sidebar.panellist",
      "sidebar.right.pane.tab",
    ]);
  const section = host.registrations.get("settings.section");
  assert.equal(section.descriptor.id, "dsh-expert-group");
  // 插件详情摘要挂在插件管理器的组合包页上：keyed slot，key 必须是组合包的 npm 包名。
  const pluginDetail = host.registrations.get("plugins.bundle.config");
  assert.equal(pluginDetail.descriptor.key, "dsh-expert-group");
  assert.equal(typeof pluginDetail.Component, "function");
  const overlay = host.registrations.get("shell.overlay");
  assert.equal(overlay.descriptor.id, "dsh-expert-group-overlay");
  // harness 的 slots.inject 立即回调并丢弃 register 返回的 disposer，因此 slot 释放
  // 不由该替身观察；这里只清理 effect，避免把替身限制当成插件契约。
  host.dispose();
});

test("client：原生状态桥不占用旧 dock slot，也不启动轮询", async () => {
  const intervals = createFakeIntervals();
  const restoreGlobals = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  try {
    const runtime = createClientReactRuntime();
    const { client } = await loadClientBundle({ react: runtime.react });
    const host = createHostContextStub();
    client.apply(host.ctx);
    assert.equal(host.registrations.has("conversation.input.dock"), false);
    assert.equal(intervals.active, 0, "原生状态桥必须由 observer 驱动，不得启动轮询");
    host.dispose();
    assert.equal(intervals.active, 0);
  } finally {
    restoreGlobals();
  }
});


// ── 15. tracker 命令面：状态容器拆分后的行为 seam（R2.5-B 补票） ──────────
// 以下三组断言只覆盖 tracker 的公开命令语义，不读取源码文本、不断言文件划分；
// 它们锁的是「状态唯一 owner 从工厂下移到 createTrackerState」后最容易回归的三处：
// 父代理临界区、messageId 优先的终态定位、恢复改绑。

test("serializeParent：同父代理 FIFO 串行、前一个失败不影响后一个、不同父代理互不阻塞", async () => {
  const tracker = createDelegationTracker();
  const order = [];
  const failing = tracker.serializeParent("p1", async () => {
    order.push("first-start");
    await Promise.resolve();
    order.push("first-end");
    throw new Error("boom");
  });
  const second = tracker.serializeParent("p1", async () => {
    order.push("second-start");
    return "second";
  });
  await assert.rejects(failing, /boom/);
  assert.equal(await second, "second", "前一个回调 reject 不得阻断同 queue 的下一个");
  assert.deepEqual(order, ["first-start", "first-end", "second-start"], "同父代理必须严格串行");

  // 不同 parentId 各有独立队列：p2 不得等待 p1 的未决回调。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const blocked = tracker.serializeParent("p1", async () => { await gate; return "gated"; });
  assert.equal(await tracker.serializeParent("p2", () => "free"), "free", "不同父代理不得互相阻塞");
  release();
  assert.equal(await blocked, "gated");
});

test("activeTaskIdsForTurn：稳定 messageId 优先，taskKey 只兜底未绑定消息的活动项", () => {
  const tracker = createDelegationTracker();
  const bound = tracker.registerActiveTask({
    parentId: "p", role: "fixer", taskKey: "task-1", description: "", affectedPaths: [], childId: "child-1",
  });
  tracker.bindActiveTask(bound.id, "child-1", "message-1");
  // 消息命中：按 messageId 精确返回该活动项。
  assert.deepEqual(
    tracker.activeTaskIdsForTurn({ parentId: "p", role: "fixer", childId: "child-1", turnMsgIds: ["message-1"], taskKeys: ["task-1"] }),
    [bound.id],
  );
  // 已绑定稳定消息的活动项只能按 messageId 命中：taskKey 不得扩大集合，
  // 否则 TTL 后同 key 的新任务会被旧 turn 误删。
  assert.deepEqual(
    tracker.activeTaskIdsForTurn({ parentId: "p", role: "fixer", childId: "child-1", turnMsgIds: ["unknown"], taskKeys: ["task-1"] }),
    [],
  );
  // 尚未绑定 messageId 的 admission 竞态项：taskKey 兜底命中。
  const pending = tracker.registerActiveTask({
    parentId: "p", role: "fixer", taskKey: "task-2", description: "", affectedPaths: [], childId: "child-2",
  });
  assert.deepEqual(
    tracker.activeTaskIdsForTurn({ parentId: "p", role: "fixer", childId: "child-2", turnMsgIds: [], taskKeys: ["task-2"] }),
    [pending.id],
  );
  // 非字符串 id 与其他 role/child 不得误命中。
  assert.deepEqual(
    tracker.activeTaskIdsForTurn({ parentId: "p", role: "fixer", childId: "child-2", turnMsgIds: [42], taskKeys: ["other"] }),
    [],
  );
  assert.deepEqual(
    tracker.activeTaskIdsForTurn({ parentId: "p", role: "oracle", childId: "child-1", turnMsgIds: ["message-1"] }),
    [],
  );
});

test("rebindActiveTasks：activityIds 精确改绑并刷新 messageId，taskKeys 只兜底旧记录", () => {
  const tracker = createDelegationTracker();
  const first = tracker.registerActiveTask({
    parentId: "p", role: "fixer", taskKey: "task-a", description: "", affectedPaths: [], childId: "old-child",
  });
  const second = tracker.registerActiveTask({
    parentId: "p", role: "fixer", taskKey: "task-b", description: "", affectedPaths: [], childId: "old-child",
  });
  const otherRole = tracker.registerActiveTask({
    parentId: "p", role: "oracle", taskKey: "task-a", description: "", affectedPaths: [], childId: "old-child",
  });
  assert.equal(tracker.rebindActiveTasks({
    parentId: "p", role: "fixer", oldChildId: "old-child", newChildId: "new-child",
    messageId: "recovery-message", activityIds: [first.id], taskKeys: ["task-b"],
  }), 2, "activityIds 命中项与 taskKey 兜底项都要改绑");
  const byId = new Map(tracker.listActiveTasks("p").map((task) => [task.id, task]));
  assert.equal(byId.get(first.id).childId, "new-child");
  assert.equal(byId.get(first.id).messageId, "recovery-message");
  assert.equal(byId.get(second.id).childId, "new-child");
  assert.equal(byId.get(second.id).messageId, "recovery-message");
  assert.equal(byId.get(otherRole.id).childId, "old-child", "其他角色不得被改绑");
  // 旧 childId 不匹配时一律不改绑，保护迟到事件。
  assert.equal(tracker.rebindActiveTasks({
    parentId: "p", role: "fixer", oldChildId: "old-child", newChildId: "x", activityIds: [first.id],
  }), 0);
  assert.equal(byId.get(first.id).childId, "new-child");
});

