/**
 * 插件级行为 harness 回归。
 *
 * 这些测试只通过真实插件 apply 注册出的公开面驱动：tools.register、ctx.on、
 * ctx.effect、webServer.register、connection.rpc.handle、settings.register 与
 * storageDomain.open。测试不读取生产源码文本，不使用源码切片或函数重建，
 * 也不访问插件私有状态。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  createPluginHost,
  flushAsyncWork,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  RPC_PATH,
} from "../test-support/plugin-host.mjs";

const ROLE_TOOLS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const ROOT_TOOLS = ["dsh_expert_group_finalize", "dsh_expert_group_done", "dsh_expert_group_release_scope", "dsh_expert_group_abandon_wait"];
const ALL_TOOLS = [...ROLE_TOOLS, "fanout", ...ROOT_TOOLS];

function appliedHost(options = {}) {
  const host = createPluginHost(options);
  host.apply();
  return host;
}

test("apply 通过公开注册面暴露角色工具、RPC 路由、system section 与事件订阅", () => {
  const host = appliedHost();

  assert.deepEqual(host.toolNames().sort(), [...ALL_TOOLS].sort());
  assert.equal(host.routes.has(RPC_PATH), true);
  assert.deepEqual([...host.sections.keys()].sort(), [
    "dsh-expert-group:orchestrator",
    "dsh-expert-group:routing",
  ]);
  assert.ok(host.listenerCount("subagent/provider-added") >= 1);
  assert.ok(host.listenerCount("subagent/provider-removed") >= 1);
  assert.ok(host.listenerCount("settings/document-updated") >= 1);
  // 新契约：settings 不注册 namespace；插件通过 Config volatile 字段投影 + 关闭自动配置页。
  assert.equal(host.settingsAutoGenerate(), false, "必须关闭宿主自动生成配置页");
  assert.equal(host.stats.activeEffects > 0, true);
});

test("provider 移除卸载角色工具，重新加入恢复挂载且不重复注册", () => {
  const host = appliedHost();
  const registrationsAfterApply = host.stats.toolRegistrations;

  host.emit("subagent/provider-removed", "spawn");
  assert.deepEqual(host.toolNames().sort(), [...ROOT_TOOLS].sort());
  assert.equal(host.stats.toolDisposals, ROLE_TOOLS.length + 1);

  host.emit("subagent/provider-added", { name: "spawn" });
  assert.deepEqual(host.toolNames().sort(), [...ALL_TOOLS].sort());
  assert.equal(host.stats.toolRegistrations, registrationsAfterApply + ROLE_TOOLS.length + 1);
  assert.equal(host.stats.toolDisposals, ROLE_TOOLS.length + 1);
});

test("webServer 注册失败时 apply 显式失败并回滚已注册的工具与监听", () => {
  const host = createPluginHost({ webServer: "register-fails" });

  assert.throws(() => host.apply(), /webServer register failed/);
  assert.deepEqual(host.toolNames(), []);
  assert.equal(host.routes.size, 0);
  assert.equal(host.listenerCount("settings/document-updated"), 0);
  assert.equal(host.stats.activeEffects, 0);
});

test("宿主缺少 webServer 时 apply 以明确 inject 错误失败", () => {
  const host = createPluginHost({ webServer: "missing" });

  assert.throws(() => host.apply(), /cannot get property "webServer" without inject/);
  assert.deepEqual(host.toolNames(), []);
});

test("Connection 可用时 legacy 路由拒绝并保留 Connection 通道", async () => {
  const host = appliedHost();

  assert.deepEqual(host.connectionChannels(), [RPC_CHANNEL]);
  const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
  assert.equal(legacy.status, 404);
  assert.equal(legacy.body.error.code, "connection-required");

  const viaConnection = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(viaConnection.ok, true);
  assert.deepEqual(viaConnection.value.roles, ROLE_TOOLS);
});

test("Connection 缺失时 legacy 路由继续服务", async () => {
  const host = appliedHost({ connection: "missing" });

  assert.deepEqual(host.connectionChannels(), []);
  const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.ok, true);
});

// 宿主 rpc.handle API 缺失或注册失败时，插件都可在 webServer 上自持同名前缀路由；
// 认证仍由公开 connection.requestRejection 提供，legacy 路由继续拒绝，不能因为回退
// 把认证 fence 变成旁路。
test("Connection handle-missing 时改由自持 channel 路由服务", async () => {
  const host = appliedHost({ connection: "handle-missing" });

  assert.deepEqual(host.connectionChannels(), []);
  assert.equal(host.channelTransport(), "route");
  const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
  assert.equal(legacy.status, 404);
  assert.equal(legacy.body.error.code, "connection-required");
  const viaChannel = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(viaChannel.ok, true);
  assert.deepEqual(viaChannel.value.roles, ROLE_TOOLS);
});

test("Connection register-fails 时回退到带 fence 的自持 channel 路由", async () => {
  const host = appliedHost({ connection: "register-fails" });

  assert.deepEqual(host.connectionChannels(), []);
  assert.equal(host.channelTransport(), "route");
  const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
  assert.equal(legacy.status, 404);
  assert.equal(legacy.body.error.code, "connection-required");
  const viaChannel = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(viaChannel.ok, true);
  assert.deepEqual(viaChannel.value.roles, ROLE_TOOLS);
});

test("Connection 既无 handle 也无 fence 时 legacy 路由 fail-closed 返回 503", async () => {
  const host = appliedHost({ connection: "fence-missing" });

  assert.equal(host.channelTransport(), "none");
  const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
  assert.equal(legacy.status, 503);
  assert.equal(legacy.body.error.code, "connection-required");
  assert.ok(host.warnings.some((entry) => entry.message.includes("connection rpc")));
});

test("卸载释放路由、Connection 通道、工具与监听，重复调用幂等", async () => {
  const host = appliedHost();

  await host.dispose();
  assert.equal(host.routes.size, 0);
  assert.deepEqual(host.connectionChannels(), []);
  assert.deepEqual(host.toolNames(), []);
  assert.equal(host.listenerCount("settings/document-updated"), 0);
  assert.equal(host.storage.closeCount, 1);

  const statsAfterFirstDispose = host.stats;
  await host.dispose();
  assert.deepEqual(host.stats, statsAfterFirstDispose);
  assert.equal(host.storage.closeCount, 1);
});

test("legacy 请求可注入 abort，取消映射为 499 gateway/cancelled", async () => {
  const host = appliedHost({ connection: "missing" });
  host.registerRootAgent("root-1");

  const response = await host.invokeRoute(RPC_PATH, {
    body: {
      action: "commit",
      sessionId: "root-1",
      scope: "defaults",
      expectedRevision: 0,
      changes: [{ role: "fixer", selection: { provider: "mock", model: "mock" } }],
    },
    abort: true,
  });

  assert.equal(response.status, 499);
  assert.equal(response.body.error.code, "gateway/cancelled");
  assert.equal(host.settingsSnapshot().revision, 0);
});

test("请求 body 读完后 abort 仍映射为取消", async () => {
  const host = appliedHost({ connection: "missing" });
  host.registerRootAgent("root-1");

  const response = await host.invokeRoute(RPC_PATH, {
    body: {
      action: "commit",
      sessionId: "root-1",
      scope: "defaults",
      expectedRevision: 0,
      changes: [{ role: "fixer", selection: { provider: "mock", model: "mock" } }],
    },
    abortAfterBody: true,
  });

  assert.equal(response.status, 499);
  assert.equal(response.body.error.code, "gateway/cancelled");
});

test("Connection 请求可注入 abort signal，取消映射为 499", async () => {
  const host = appliedHost();
  host.registerRootAgent("root-1");
  const controller = new AbortController();
  controller.abort();

  const result = await host.invokeConnection(RPC_ENDPOINT, {
    action: "commit",
    sessionId: "root-1",
    scope: "defaults",
    expectedRevision: 0,
    changes: [{ role: "fixer", selection: { provider: "mock", model: "mock" } }],
  }, { signal: controller.signal });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "gateway/cancelled");
  assert.equal(host.settingsSnapshot().revision, 0);
});

test("卸载进行中的请求不会留下未处理拒绝", async () => {
  const host = appliedHost();
  host.registerRootAgent("root-1");
  const pending = host.invokeConnection(RPC_ENDPOINT, {
    action: "commit",
    sessionId: "root-1",
    scope: "session",
    changes: [{ role: "fixer", selection: { provider: "mock", model: "mock" } }],
  });

  await host.dispose();
  const result = await pending;
  assert.equal(typeof result.ok, "boolean");
  await flushAsyncWork();
});
