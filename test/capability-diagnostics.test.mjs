/**
 * Ticket 08：宿主能力矩阵与运行时诊断的只读契约。
 *
 * 覆盖两件事：
 * 1. `meta` 动作暴露的 capabilities / diagnostics 形状、有界性与敏感性边界；
 * 2. root turn 等待的宿主 seam 决策（session-activity waterfall + 固定降级标记）在
 *    inject 声明、启动行为、文档与诊断上一致；goals 只作为可选只读投影源。
 *
 * 设置页不再渲染宿主诊断区块（能力矩阵/运行时/预算/持久化/通知投递已从 UI 移除），
 * 这里只保留「通知事件开关」这一设置页控件的行为覆盖。
 *
 * 所有断言只走公开面：plugin.apply 注册的 RPC 与真实渲染输出。
 * 不读取 index.js/client-entry.js 的源码文本，也不访问插件私有状态；唯一的文本断言是 README
 * 的契约标记（文档与实现的显式一致性门禁）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import plugin from "../index.js";
import {
  createClientReactRuntime,
  createFakeNotificationApi,
  createHostContextStub,
  installGlobals,
  loadClientBundle,
} from "../test-support/client-bundle.mjs";

// 发布 bundle 的真实加载顺序：先让两个浏览器安全 IIFE（侧栏、通知协调）登记自己的
// globalThis Symbol，再 materialize client-entry.js 描述符。这样能力矩阵才能在真实模块面上
// 判定 taskSidebar 等能力是否可用，而不是靠替身假设（通知已不再是客户端能力）。
{
  const entries = [];
  const loader = { load(descriptor) { entries.push(descriptor); } };
  const restoreImport = installGlobals({ window: { __ModuleLoader__: loader }, __ModuleLoader__: loader });
  try {
    await import("../client-bundle.js");
  } finally {
    restoreImport();
  }
}
import {
  createPluginHost,
  flushAsyncWork,
  RPC_ENDPOINT,
  RPC_PATH,
} from "../test-support/plugin-host.mjs";

const ROLE_TOOLS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];

/**
 * goals 服务替身（只读投影源）。
 *
 * 改造后插件**只**在 Expert Group 快照里读 goals.get 展示目标阶段，绝不调用
 * pause/resume。这里让两者直接抛错：任何残留的旧调用路径都会立刻打红。
 */
function goalsService() {
  return {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  };
}

function appliedHost(options = {}) {
  const host = createPluginHost(options);
  host.apply();
  return host;
}

/**
 * 诊断/能力投影里绝不允许出现的键名（敏感性边界的可执行定义）。
 *
 * 注意：能力矩阵的键名是宿主服务名（例如 systemPrompt），它本身不是内容，因此不在这里
 * 禁止；对应的值是固定状态结构，由 CAPABILITY_ENTRY_KEYS 白名单单独断言——任何试图把
 * prompt 正文、请求体、路径或认证信息塞进能力条目的改动都会在那一层失败。
 */
const FORBIDDEN_KEYS = new Set([
  "prompt", "prompts", "token", "tokens", "authorization", "cookie", "cookies",
  "body", "rawbody", "requestbody", "payload", "path", "paths", "cwd", "home", "stack", "message",
  "sessionid", "agentid", "childid", "parentid", "eventlog",
]);

/** 能力条目允许出现的字段：固定状态枚举 + 布尔要求 + 固定降级标记。 */
const CAPABILITY_ENTRY_KEYS = new Set([
  "required", "status", "degradation", "methods", "probe", "transport", "failure", "binding",
]);

/** 递归扫描对象：返回违规键名与包含绝对路径/认证头的字符串值。 */
function scanSensitive(value, trail = "meta") {
  const violations = [];
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") {
      if (/[A-Za-z]:\\/.test(value) || value.includes("/Users/") || /^\/(?:home|root)\//.test(value)) {
        violations.push(trail + " 含绝对路径");
      }
      if (/\bBearer\b|authorization|-----BEGIN/i.test(value)) violations.push(trail + " 含认证信息");
    }
    return violations;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => violations.push(...scanSensitive(entry, trail + "[" + index + "]")));
    return violations;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) violations.push(trail + "." + key + " 是敏感键名");
    violations.push(...scanSensitive(entry, trail + "." + key));
  }
  return violations;
}

// ── 宿主能力矩阵与诊断 ────────────────────────────────────────────────────

test("meta 暴露只读能力矩阵与运行时诊断，且不含任何敏感字段", async () => {
  const host = appliedHost({ goals: goalsService() });
  try {
    await flushAsyncWork();
    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.ok, true);

    const capabilities = meta.value.capabilities;
    assert.equal(capabilities.version, 2, "能力矩阵必须带 schema 版本");
    assert.equal(capabilities.host.rootTurnWait.required, false, "rootTurnWait 是可选宿主 seam");
    // 权威静止证明要求 listing **加上**同一份可调用的 agents.list() 快照：本 harness 只有
    // listing（没有 agents.list()），此时等待实际 fail-closed，诊断必须如实报 degraded。
    assert.equal(
      capabilities.host.rootTurnWait.status,
      "degraded",
      "缺 agents.list() 时不能误报 available（等待实际 fail-closed）",
    );
    assert.equal(
      capabilities.host.rootTurnWait.degradation,
      "root-turn-wait-runtime-agent-listing-unavailable",
    );
    assert.equal(capabilities.host.goals, undefined, "goal handoff 能力条目必须整体移除");
    assert.equal(capabilities.host.connectionRpc.status, "available");
    assert.equal(capabilities.host.connectionRpc.transport, "handle");
    assert.equal(capabilities.host.connectionRpc.failure, null);
    assert.equal(capabilities.host.storageDomain.status, "available", "storage domain 就绪后必须报可用");
    for (const key of ["tools", "subagents", "agents", "settings", "webServer", "systemPrompt", "llm"]) {
      assert.equal(capabilities.host[key].required, true, key + " 必须是硬依赖回执");
      assert.equal(capabilities.host[key].status, "available");
    }
    // 能力条目的字段面固定：宿主服务名可以出现在键上，但值里不能出现任何自由文本字段。
    for (const [key, entry] of Object.entries(capabilities.host)) {
      const unexpected = Object.keys(entry).filter((field) => !CAPABILITY_ENTRY_KEYS.has(field));
      assert.deepEqual(unexpected, [], "能力条目 " + key + " 含未声明的自由文本字段");
    }

    const diagnostics = meta.value.diagnostics;
    assert.equal(diagnostics.version, 2);
    assert.equal(diagnostics.children.active, 0);
    assert.equal(typeof diagnostics.children.tracked, "number");
    assert.equal(diagnostics.fanout.tasks, 0);
    assert.equal(diagnostics.fanout.queuedShards, 0);
    assert.equal(diagnostics.fanout.runningShards, 0);
    assert.equal(diagnostics.fanout.concurrency.default, 20, "默认并发布必须来自同一份归一设置");
    assert.deepEqual(diagnostics.fanout.concurrency.roles, {});
    assert.equal(diagnostics.recovery.limit, 5, "恢复次数上限必须取自运行时常量");
    assert.equal(diagnostics.recovery.disposed, false);
    assert.equal(diagnostics.settings.pendingWrites, 0);
    assert.equal(typeof diagnostics.settings.generation, "number");
    assert.equal(diagnostics.storage.hasBinding, true);
    assert.equal(diagnostics.storage.status, "ready");
    assert.ok(Number.isSafeInteger(diagnostics.storage.generation) && diagnostics.storage.generation >= 1);
    assert.equal(diagnostics.handoff.pending, 0);
    assert.equal(diagnostics.notifications.roots, 0);
    /**
     * root turn 等待账本诊断（票据 11）：空状态下全部为 0/空，字段面固定白名单。
     * 只允许计数、固定枚举与时间戳；roots 摘要不得携带 id/正文。
     */
    assert.deepEqual(Object.keys(diagnostics.rootTurnWait).sort(), [
      "abandonedCount", "capability", "lastDelivery", "oldestWaitedMs",
      "outstandingTotal", "rootCount", "roots",
    ], "rootTurnWait 诊断字段面固定");
    assert.equal(diagnostics.rootTurnWait.outstandingTotal, 0);
    assert.equal(diagnostics.rootTurnWait.rootCount, 0);
    assert.equal(diagnostics.rootTurnWait.oldestWaitedMs, 0);
    assert.equal(diagnostics.rootTurnWait.abandonedCount, 0);
    assert.equal(diagnostics.rootTurnWait.lastDelivery, null);
    assert.deepEqual(diagnostics.rootTurnWait.capability, { available: 0, degraded: 0, unavailable: 0 });
    assert.deepEqual(diagnostics.rootTurnWait.roots, []);
    assert.equal(diagnostics.rpc.categoryLimit, 8, "RPC 错误类别必须声明有界上限");
    assert.deepEqual(diagnostics.rpc.recentErrors, []);
    assert.ok(Number.isSafeInteger(diagnostics.generatedAt) && diagnostics.generatedAt > 0);

    // 敏感性边界：能力矩阵与诊断整体不得包含 prompt/token/Cookie/authorization/绝对路径。
    assert.deepEqual(scanSensitive({ capabilities, diagnostics }), []);
    // 有界性：报告大小固定，不随任务/历史增长。
    assert.ok(JSON.stringify({ capabilities, diagnostics }).length < 8192);
  } finally {
    await host.dispose();
  }
});


test("meta 诊断：notifications.systemToast 只暴露白名单字段与固定 token", async () => {
  const host = appliedHost({ goals: goalsService() });
  try {
    await flushAsyncWork();
    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const notifications = meta.value.diagnostics.notifications;
    // 既有字段形状不变（客户端按白名单只读 roots）。
    assert.equal(notifications.roots, 0);
    assert.equal(typeof notifications.hasAgentQuery, "boolean");
    assert.equal(notifications.disposed, false);
    // 新投影：字段面完全固定——多一个自由文本字段或少一个字段都会失败。
    const systemToast = notifications.systemToast;
    assert.deepEqual(Object.keys(systemToast).sort(), [
      "aumidReason", "aumidResolved", "dropped", "failed", "inflight", "lastReason",
      "platform", "queued", "sent", "status", "version",
    ]);
    assert.equal(systemToast.status, "available");
    assert.equal(systemToast.version, 1);
    assert.equal(["windows", "unsupported"].includes(systemToast.platform), true, "platform 只能是固定枚举");
    // 未发送过任何通知：AUMID 解析尚未尝试，计数全为 0，reason 为 null。
    assert.equal(systemToast.aumidResolved, false);
    assert.equal(systemToast.aumidReason, null);
    assert.equal(systemToast.lastReason, null);
    for (const field of ["inflight", "queued", "sent", "failed", "dropped"]) {
      assert.equal(systemToast[field], 0, field + " 必须是初始 0");
    }
    assert.deepEqual(scanSensitive({ notifications }), []);
  } finally {
    await host.dispose();
  }
});

test("meta 诊断：注入适配器的正文/AUMID/路径被过滤，describe 抛错时显式 absent", async () => {
  const hostile = {
    show: () => Promise.resolve({ shown: false, reason: "ok" }),
    describe: () => ({
      version: 1,
      platform: "windows",
      // 以下字段全部是"注入实现不可信"的内容：正文、AUMID、命令行、绝对路径、自由文本。
      body: "秘密正文",
      aumid: "electron.app.DeepSeek Harness",
      commandLine: "powershell.exe -EncodedCommand AAAA",
      path: "C:\\\\secret\\\\path.lnk",
      sent: 3,
      failed: -5,
      dropped: Number.NaN,
      inflight: 1.5,
      queued: 2,
      aumidResolved: true,
      aumidReason: "C:\\\\secret\\\\path.lnk",
      lastReason: "some free text with spaces",
    }),
    dispose() {},
  };
  const host = appliedHost({
    goals: goalsService(),
    config: { enableOrchestrator: true, enableObserver: true, createSystemToast: () => hostile },
  });
  try {
    await flushAsyncWork();
    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const systemToast = meta.value.diagnostics.notifications.systemToast;
    assert.deepEqual(systemToast, {
      status: "available",
      version: 1,
      platform: "windows",
      aumidResolved: true,
      aumidReason: null,
      inflight: 0,
      queued: 2,
      sent: 3,
      failed: 0,
      dropped: 0,
      lastReason: null,
    });
    const serialized = JSON.stringify(meta.value.diagnostics);
    for (const forbidden of ["秘密正文", "DeepSeek Harness", "EncodedCommand", "secret", "free text"]) {
      assert.equal(serialized.includes(forbidden), false, "诊断不得包含 " + forbidden);
    }
    assert.deepEqual(scanSensitive({ diagnostics: meta.value.diagnostics }), []);
  } finally {
    await host.dispose();
  }

  const broken = {
    show: () => Promise.resolve({ shown: false, reason: "ok" }),
    describe() { throw new Error("boom"); },
    dispose() {},
  };
  const failureHost = appliedHost({
    goals: goalsService(),
    config: { enableOrchestrator: true, enableObserver: true, createSystemToast: () => broken },
  });
  try {
    await flushAsyncWork();
    const meta = await failureHost.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const systemToast = meta.value.diagnostics.notifications.systemToast;
    assert.equal(systemToast.status, "absent", "describe 抛错必须显式 absent，而不是伪造计数");
    assert.equal(systemToast.sent, 0);
    assert.equal(systemToast.aumidReason, null);
    assert.deepEqual(scanSensitive({ diagnostics: meta.value.diagnostics }), []);
  } finally {
    await failureHost.dispose();
  }
});
test("rootTurnWait 诊断投影：listing 可用但缺 agents.list() 时 degraded，两者都可调用才 available", async () => {
  // 权威静止证明 = `subagents.listDescendants` + 同一份可调用的 `agents.list()` 快照。
  // 只有 listing 时等待实际 fail-closed，诊断必须如实投影；这是**诊断投影**的修正，
  // 不改变等待本身的行为。
  const listingOnly = appliedHost({});
  try {
    await flushAsyncWork();
    const meta = await listingOnly.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(listingOnly.toolNames().length > 0, true, "缺 agents.list() 不影响插件加载");
    assert.equal(meta.value.capabilities.host.rootTurnWait.status, "degraded");
    assert.equal(
      meta.value.capabilities.host.rootTurnWait.degradation,
      "root-turn-wait-runtime-agent-listing-unavailable",
    );
  } finally {
    await listingOnly.dispose();
  }

  const both = appliedHost({ rootChildren: () => [] });
  try {
    await flushAsyncWork();
    const meta = await both.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.capabilities.host.rootTurnWait.status, "available");
    assert.equal(meta.value.capabilities.host.rootTurnWait.degradation, null);
  } finally {
    await both.dispose();
  }

  // listing 缺失、但 agents.list() 可调用、且 waterfall 也缺：strict runtime-only fallback
  // 仍能给出可证明的状态（idle child 能收口），所以必须是 degraded + 既有的
  // listing-unavailable reason，而不是 unavailable。
  const runtimeOnly = appliedHost({
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
    rootChildren: () => [],
  });
  try {
    await flushAsyncWork();
    const meta = await runtimeOnly.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(
      meta.value.capabilities.host.rootTurnWait.status,
      "degraded",
      "listing 缺失但 agents.list() 可调用时仍有可证明的查询路径",
    );
    assert.equal(
      meta.value.capabilities.host.rootTurnWait.degradation,
      "root-turn-wait-descendant-listing-unavailable",
    );
  } finally {
    await runtimeOnly.dispose();
  }

  // 可调用但返回**非数组**的 agents.list() 不能当 runtime 快照用（等待侧同样 fail-closed）：
  // 这时的诊断与「缺 runtime 快照」一致，都是 degraded + runtime-agent-listing-unavailable。
  // fixture 语义：传 `rootChildren: null` ⇒ `list: () => null`。
  const callableButGarbage = appliedHost({ rootChildren: null });
  try {
    await flushAsyncWork();
    const meta = await callableButGarbage.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(callableButGarbage.agents.list() === null, true, "该宿主确实提供了可调用的 list");
    assert.equal(meta.value.capabilities.host.rootTurnWait.status, "degraded");
    assert.equal(
      meta.value.capabilities.host.rootTurnWait.degradation,
      "root-turn-wait-runtime-agent-listing-unavailable",
    );
  } finally {
    await callableButGarbage.dispose();
  }

  // 完全没有任何可用查询（listing 缺、agents.list 缺、waterfall 缺）才是 unavailable。
  // 注意：fixture 里「不传 rootChildren」才是没有该 seam。
  const none = appliedHost({
    descendantListing: "missing",
    sessionActivity: "missing",
    sessionActivityTransport: false,
  });
  try {
    await flushAsyncWork();
    const meta = await none.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.capabilities.host.rootTurnWait.status, "unavailable");
    assert.equal(
      meta.value.capabilities.host.rootTurnWait.degradation,
      "root-turn-wait-descendant-query-unavailable",
    );
  } finally {
    await none.dispose();
  }
});
test("goals 只作为可选只读投影源：缺失或方法不全时插件仍加载且等待语义不变", async () => {
  assert.ok(Array.isArray(plugin.inject) && !plugin.inject.includes("goals"), "goals 不得作为插件加载硬依赖");

  for (const goalsOption of [{}, "missing"]) {
    const host = appliedHost({ goals: goalsOption });
    try {
      assert.deepEqual(host.toolNames().sort(), [...ROLE_TOOLS, "fanout", "dsh_expert_group_finalize", "dsh_expert_group_done", "dsh_expert_group_release_scope", "dsh_expert_group_abandon_wait"].sort());
      assert.equal(host.routes.has(RPC_PATH), true);
      const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
      // 能力矩阵不再暴露任何 goal handoff 条目；等待能力只取决于 session-activity。
      assert.equal(meta.value.capabilities.host.goals, undefined);
      assert.equal(meta.value.capabilities.host.rootTurnWait.required, false);
      // 同上：没有 agents.list() 时权威档不完整，只能是 degraded。
      assert.equal(meta.value.capabilities.host.rootTurnWait.status, "degraded");
      assert.equal(
        meta.value.capabilities.host.rootTurnWait.degradation,
        "root-turn-wait-runtime-agent-listing-unavailable",
      );
    } finally {
      await host.dispose();
    }
  }
});

test("Connection 能力矩阵反映实际可达状态：handle / 自持 route / legacy 回落", async () => {
  const viaHandle = appliedHost({ goals: goalsService() });
  try {
    const meta = await viaHandle.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.capabilities.host.connectionRpc.probe, "available");
    assert.equal(meta.value.capabilities.host.connectionRpc.transport, "handle");
    assert.equal(meta.value.capabilities.host.connectionRpc.status, "available");
  } finally {
    await viaHandle.dispose();
  }

  const viaRoute = appliedHost({ goals: goalsService(), connection: "handle-missing" });
  try {
    assert.equal(viaRoute.channelTransport(), "route");
    const meta = await viaRoute.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.capabilities.host.connectionRpc.transport, "route");
    assert.equal(meta.value.capabilities.host.connectionRpc.status, "degraded", "自持 route 是可诊断的降级路径");
    assert.equal(
      meta.value.capabilities.host.connectionRpc.failure,
      "probe-unsupported",
      "handle API 缺失必须记录为固定枚举原因",
    );
  } finally {
    await viaRoute.dispose();
  }

  // 既无 handle 也无公开 fence：通道建立不起来，legacy 也 fail-closed（503），
  // 因此该 host 上没有任何 RPC 可达——这本身就是 fail-closed 的权威证据。
  const failClosed = appliedHost({ goals: goalsService(), connection: "fence-missing" });
  try {
    assert.equal(failClosed.channelTransport(), "none");
    const legacy = await failClosed.invokeRoute(RPC_PATH, { body: { action: "meta" } });
    assert.equal(legacy.status, 503);
    assert.equal(legacy.body.error.code, "connection-required");
  } finally {
    await failClosed.dispose();
  }

  // Connection 服务整体缺失：保持历史 legacy 行为，能力矩阵报 legacy。
  const legacyHost = appliedHost({ goals: goalsService(), connection: "missing" });
  try {
    const meta = await legacyHost.invokeRoute(RPC_PATH, { body: { action: "meta" } });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.capabilities.host.connectionRpc.probe, "absent");
    assert.equal(meta.body.capabilities.host.connectionRpc.transport, "none");
    assert.equal(meta.body.capabilities.host.connectionRpc.status, "legacy");
  } finally {
    await legacyHost.dispose();
  }
});

test("最近 RPC 错误只保留结构化类别与计数，不含消息、请求体或路径", async () => {
  const host = appliedHost({ goals: goalsService() });
  try {
    const unknown = await host.invokeConnection(RPC_ENDPOINT, { action: "no-such-action" });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, "bad-request");
    await host.invokeConnection(RPC_ENDPOINT, { action: "no-such-action" });
    await host.invokeConnection(RPC_ENDPOINT, { action: "meta", pad: "x".repeat(17000) });

    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    const errors = meta.value.diagnostics.rpc.recentErrors;
    const byCode = new Map(errors.map((entry) => [entry.code, entry]));
    assert.equal(byCode.get("bad-request")?.count, 2, "同类失败必须聚合计数");
    assert.equal(byCode.get("payload-too-large")?.count, 1);
    assert.ok(errors.length <= meta.value.diagnostics.rpc.categoryLimit);
    for (const entry of errors) {
      assert.deepEqual(Object.keys(entry).sort(), ["code", "count", "lastAt"]);
      assert.match(entry.code, /^[A-Za-z0-9_./-]{1,40}$/);
      assert.ok(Number.isSafeInteger(entry.count) && entry.count >= 1);
    }
    // 失败请求携带的超长填充与请求体本身不得出现在诊断里。
    assert.deepEqual(scanSensitive(meta.value.diagnostics), []);
    assert.equal(JSON.stringify(meta.value.diagnostics).includes("xxxxx"), false);
  } finally {
    await host.dispose();
  }
});

test("settings 提交后诊断与能力矩阵读到同一份生效并发上限，且在途写入归零", async () => {
  const host = appliedHost({ goals: goalsService() });
  try {
    await flushAsyncWork();
    const committed = await host.invokeConnection(RPC_ENDPOINT, {
      action: "settings-commit",
      expectedRevision: 0,
      settings: {
        provider: "",
        defaults: {},
        notificationEnabled: true,
        notificationVolume: 100,
        roleConcurrencyLimit: 3,
      },
    });
    assert.equal(committed.ok, true);

    const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
    assert.equal(meta.value.roleConcurrencyLimit, 3);
    assert.equal(meta.value.diagnostics.fanout.concurrency.default, 3, "诊断必须与设置页读到同一数值");
    assert.equal(meta.value.diagnostics.settings.pendingWrites, 0, "提交完成后不得残留待写计数");
    assert.equal(typeof meta.value.diagnostics.settings.trackedNamespaces, "number", "目录跟踪数必须是可读数值");
  } finally {
    await host.dispose();
  }
});

// ── 设置页通知事件控件 ───────────────────────────────────────────────────

// 宿主诊断区块（能力矩阵/运行时/预算/持久化/通知投递）与「发送测试通知」已从设置页移除；
// 这里保留与保留功能相关的控件覆盖：停留时长字段整体移除、三个通知事件开关仍在，
// 且设置页绝不触碰浏览器通知权限。宿主侧诊断与 notification-test RPC 由上面的用例覆盖。
test("设置页渲染通知事件开关（停留时长字段已移除），且不再渲染宿主诊断区块", async () => {
  const fake = createFakeNotificationApi({ permission: "default" });
  const restore = installGlobals({ Notification: fake.Notification });
  try {
    const runtime = createClientReactRuntime();
    const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
    const hostMeta = {
      ok: true,
      roles: ROLE_TOOLS,
      activeRoles: ROLE_TOOLS,
      enableObserver: true,
    };
    const host = createHostContextStub({
      connection: {
        rpc: {
          async call(_channel, _endpoint, body) {
            if (body?.action === "meta") return { ok: true, value: hostMeta };
            return { ok: false, error: { code: "bad-request", message: "夹具未提供该 RPC" } };
          },
        },
      },
    });
    client.apply(host.ctx);
    try {
      const section = host.registrations.get("settings.section");
      assert.ok(section, "apply 必须注册设置页 section");
      const settingsForm = host.settingsForm;
      const modelCatalog = {
        subscribe: () => () => {},
        getSnapshot: () => ({ groups: [], status: "ready", error: null }),
        load: async () => {},
      };
      const handle = runtime.render(section.Component, { settingsForm, modelCatalog, ctx: host.ctx });
      await handle.settle();

      // 停留时长字段整体移除；事件类型开关收进「通知事件」下拉，展开后才渲染。
      assert.equal(findDiagnosticNode(handle.output, (node) => node.props?.["aria-label"] === "弹窗停留时间"), null,
        "notificationHoldMs 的设置页控件必须移除");
      const eventsTrigger = findDiagnosticNode(handle.output,
        (node) => node.props?.id === "deg-settings-notification-events-trigger");
      assert.ok(eventsTrigger, "通知事件下拉触发按钮必须渲染");
      assert.equal(eventsTrigger.props["aria-expanded"], "false", "通知事件下拉初始收起");
      for (const label of ["通知任务完成", "通知等待用户", "通知任务失败"]) {
        assert.equal(findDiagnosticNode(handle.output, (node) => node.props?.["aria-label"] === label), null,
          label + " 在收起时不得出现在渲染树里");
      }
      eventsTrigger.props.onClick();
      await handle.settle();
      for (const label of ["通知任务完成", "通知等待用户", "通知任务失败"]) {
        assert.ok(findDiagnosticNode(handle.output, (node) => node.props?.["aria-label"] === label), label + " 展开后必须渲染");
      }
      // 诊断区块与「发送测试通知」按钮已从设置页移除（宿主侧 RPC 仍然存在，见上面的用例）。
      assert.equal(findDiagnosticNode(handle.output, (node) => node.props?.["data-deg-diagnostics"] !== undefined), null,
        "设置页不再渲染诊断区块");
      assert.equal(findDiagnosticNode(handle.output, (node) => node.props?.["aria-label"] === "发送测试通知"), null,
        "设置页不再渲染发送测试通知按钮");
      assert.equal(fake.permissionRequests.length, 0, "设置页不得请求通知权限");
      assert.equal(fake.instances.length, 0, "设置页不得弹出浏览器通知");

      handle.unmount();
    } finally {
      host.dispose();
    }
  } finally {
    restore();
  }
});

/** 深度优先收集所有渲染节点。 */
function collectDiagnosticNodes(node, found) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) collectDiagnosticNodes(child, found);
    return found;
  }
  found.push(node);
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children) collectDiagnosticNodes(child, found);
  return found;
}

/** 深度优先查找第一个满足 predicate 的渲染节点。 */
function findDiagnosticNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findDiagnosticNode(child, predicate);
      if (found !== null) return found;
    }
    return null;
  }
  if (predicate(node) === true) return node;
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children) {
    const found = findDiagnosticNode(child, predicate);
    if (found !== null) return found;
  }
  return null;
}
