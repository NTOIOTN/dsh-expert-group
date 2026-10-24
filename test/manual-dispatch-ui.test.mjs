/**
 * 票据 25 / 27 / 30 的侧栏 UI 契约。
 *
 * 覆盖：用量/成本/结构化结果渲染、动态角色标签（节点 roleLabel → snapshot.roleLabels →
 * meta.roleLabels）、会话模型区角色行显示名，以及模型层纯函数契约。
 *
 * 手动派发 / 模板 UI 已移除（票 28 的侧栏派发表单与模板库不再渲染），派发相关的 Host 侧
 * RPC 契约仍由 test/manual-dispatch.test.mjs 覆盖；本文件只保留侧栏用量、角色标签与
 * 模型层契约。
 *
 * 只通过公开入口（createExpertGroupPanel + requestPluginRpc 注入）断言，不读生产源码文本；
 * React 用 test-support 的最小渲染器，所有业务判断都在真实 bundle 组件体内。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createClientReactRuntime, createFakeIntervals, installGlobals } from "../test-support/client-bundle.mjs";

// 票据 29：模型拆为 normalize → format → 薄门面，按装配顺序依次求值（门面在装载期读取两者检查点）。
await import("../client-expert-group-model-normalize.js");
await import("../client-expert-group-model-format.js");
await import("../client-expert-group-model.js");
await import("../client-sidebar-views-a.js");
await import("../client-sidebar-views-b.js");
await import("../client-sidebar-views-c.js");
await import("../client-sidebar-overlay.js");
await import("../client-expert-group-sidebar.js");
const model = globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
const sidebar = globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];

function walk(node, result = []) {
  if (node === null || node === undefined || node === false) return result;
  result.push(node);
  if (typeof node === "object") for (const child of node.children ?? []) walk(child, result);
  return result;
}

function byClass(root, className) {
  return walk(root).filter((node) => typeof node === "object"
    && String(node.props?.className ?? "").split(/\s+/).includes(className));
}

function byAria(root, label) {
  return walk(root).find((node) => typeof node === "object" && node?.props?.["aria-label"] === label);
}

function byProp(root, name, value) {
  return walk(root).find((node) => typeof node === "object" && node?.props?.[name] === value);
}

function textOf(node) {
  return walk(node).filter((value) => typeof value === "string" || typeof value === "number").join("");
}

/** 会话快照替身：只提供目录身份（与真实面板契约一致）。 */
function sessionsFixture() {
  const snapshot = {
    current: "root-1",
    byId: {
      "root-1": { id: "root-1", title: "根任务标题", displayTitle: "root-1" },
      "expert-1": { id: "expert-1", title: "专家任务", displayTitle: "expert-1", running: true },
    },
    projectionsBySession: {
      "root-1": { values: { subagentCatalog: [{ id: "expert-1", createdAt: 1, mode: "continuable" }] } },
    },
  };
  return {
    list: { getSnapshot: () => snapshot, subscribe() { return () => {}; } },
    open() {},
  };
}

/**
 * 用量/结构化结果夹具（票据 25/30/27）：
 * - root 角色 orchestrator，带 roleLabels 映射；
 * - 专家 expert-1：节点自带 roleLabel + 用量 + 结构化结果 value；
 * - fan-out fan-1：角色 custom-role（不在内置表里），分片 s1 带 attempt 用量、结构化回退。
 */
function usageSnapshot(overrides = {}) {
  // 缓存读 200 ⇒ 计费输入 1200、总计 1700、命中 17%）——任务行只展示聚合用量，不再显示请求数。
  const expertUsage = { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 500, requests: 2 };
  const attemptUsage = {
    inputTokens: 3000, outputTokens: 1200, cacheReadTokens: 800, cacheWriteTokens: 0,
    reasoningTokens: 200, requests: 3, retries: 1, fallbacks: 0, runMs: 4200,
    provider: "prov-a", model: "model-a",
  };
  return {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1,
    partial: false,
    roleLabels: { fixer: "修复者", "custom-role": "自定义角色" },
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "prov-a", model: "model-a", status: "running",
      children: [
        {
          id: "expert-1", kind: "expert", sessionId: "expert-1", taskName: "用量专家",
          role: "fixer", roleLabel: "节点内标签", status: "running",
          content: "完成用量统计",
          usage: expertUsage,
          structured: { value: { ok: true, summary: "结构化摘要" }, bytes: 40 },
          ...overrides.expert,
        },
        {
          id: "fan-1", kind: "fanout", parentTaskId: "fan-1", taskName: "批量任务",
          role: "custom-role", status: "running", taskStatus: "pending",
          shards: [
            {
              shardId: "s1", taskName: "分片一", role: "custom-role", status: "running",
              prompt: "分片提示", childId: "child-1",
              usage: { inputTokens: 10, outputTokens: 5, requests: 1 },
              structured: { fallback: true, reason: "missing_structured" },
              attempts: [{
                attempt: 1, status: "failed", childId: "child-1",
                usage: attemptUsage,
                structured: { value: { long: "x".repeat(600) }, bytes: 620 },
                failure: { code: "EACCES", message: "读取失败" },
              }],
            },
          ],
          ...overrides.fanout,
        },
        ...(overrides.children ?? []),
      ],
    },
  };
}

function metaBody() {
  return {
    ok: true,
    activeRoles: ["fixer", "explorer", "custom-role"],
    roleLabels: { fixer: "修复者（meta）", "custom-role": "自定义角色（meta）", explorer: "探索者（meta）" },
    modelPrices: [
      { provider: "prov-a", model: "model-a", inputPerMillion: 1, outputPerMillion: 2, currency: "USD" },
    ],
    usage: { totals: { inputTokens: 4000, outputTokens: 1700, requests: 5 } },
    diagnostics: {
      fanout: {
        concurrency: {
          throttle: {
            roles: [
              { role: "fixer", limit: 2, running: 1, queued: 1, samples: 3, lastThrottledAt: 1, etaMs: null, etaSource: "unknown" },
            ],
            providers: [
              { provider: "prov-a", limit: 0, running: 2, queued: 0, samples: 2, lastThrottledAt: null, etaMs: 1500, etaSource: "historical-average" },
            ],
            etaMinSamples: 2,
          },
        },
      },
    },
  };
}

function mountPanel(overrides = {}) {
  const runtime = overrides.runtime ?? createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const requests = [];
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: overrides.primitives ?? {},
    sessions: sessionsFixture(),
    async requestPluginRpc(_connection, request) {
      requests.push(request);
      if (typeof overrides.requestPluginRpc === "function") return overrides.requestPluginRpc(request, requests);
      if (request.action === "meta") return { ok: true, async json() { return metaBody(); } };
      return { ok: true, async json() { return { snapshot: overrides.hostSnapshot ?? usageSnapshot() }; } };
    },
  });
  const handle = runtime.render(Panel, {
    scope: { sessionId: "root-1" },
    ctx: { connection: {}, uiWorkspace: { openSession() {} } },
  });
  return { runtime, intervals, restore, requests, handle };
}

test("票据 25：任务/专家/分片行显示用量速览（tok/命中），分片不再展示 attempt 详情", async () => {
  const mounted = mountPanel();
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 用量事实触发一次 meta 懒加载（单价），不再是「未配置单价」。
    assert.ok(requests.some((request) => request.action === "meta"), "出现用量后必须按需读取一次 meta");

    const expertCell = byClass(handle.output, "deg_expert_group_cell").find((cell) => textOf(cell).includes("用量专家"));
    assert.ok(expertCell, "专家行必须渲染");
    // 任务行摘要条只保留聚合用量事实：总 token（29M/1.5k 这类有界格式）与缓存命中率。
    const expertParts = byClass(expertCell, "deg_expert_group_metrics_part").map(textOf);
    assert.deepEqual(expertParts, ["1.7k tok", "命中17%"], "专家行显示 tok 与命中（没有运行时间/context 时不补占位）");

    const shard = byClass(handle.output, "deg_expert_group_shard")[0];
    assert.deepEqual(byClass(shard, "deg_expert_group_metrics_part").map(textOf), ["15 tok"]);

    // 结构化结果区：有 value 时是 JSON 预览；回退显示稳定原因且不显示 schema 原文。
    const expertStructured = byClass(expertCell, "deg_expert_group_structured")[0];
    assert.ok(expertStructured);
    assert.ok(textOf(expertStructured).includes('{"ok":true,"summary":"结构化摘要"}'));
    const fallback = byClass(shard, "deg_expert_group_structured")[0];
    assert.equal(fallback.props["data-fallback"], "true");
    assert.equal(fallback.props["data-reason"], "missing_structured");
    assert.ok(textOf(fallback).includes("已回退文本总结"));

    // 行为契约变更（用户要求）：分片行不再展示 attempt 明细，因此分片行及其后代
    // 不得再出现 attempt 条目 / 用量 / 成本节点。夹具里仍保留了 attempt 数据，
    // 这些断言证明的是渲染层不再消费它（用量摘要条仍按分片自身的 usage 渲染）。
    for (const className of ["deg_expert_group_attempt", "deg_expert_group_attempt_usage", "deg_expert_group_attempt_cost"]) {
      assert.equal(byClass(shard, className).length, 0, "分片行不得渲染 attempt 明细节点：" + className);
      assert.equal(byClass(handle.output, className).length, 0, "整棵输出不得再出现 attempt 明细节点：" + className);
    }

    // 旧快照/无用量节点：整条摘要行不渲染，绝不伪造 0 或「用量 —」占位。
    const noUsage = byClass(handle.output, "deg_expert_group_node_root")[0];
    const noUsageRow = byClass(noUsage, "deg_expert_group_row")[0];
    assert.equal(byClass(noUsageRow, "deg_expert_group_metrics").length, 0, "没有用量/时长/上下文时不得渲染空摘要行");
    assert.equal(textOf(handle.output).includes("用量 —"), false, "旧「用量 —」占位已被 tok 段取代");

    assert.equal(handle.cleanupErrors.length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 25：无单价时不估算成本，整棵输出不再出现成本节点（绝不把缺失单价算成 0）", async () => {
  // attempt 详情随用户要求移除后，成本节点本身也不存在；但「缺失单价绝不等于 0 成本」
  // 这条负向契约仍要由渲染输出兜住：整棵树里既没有成本节点，也没有任何 0 成本文案。
  const mounted = mountPanel({
    requestPluginRpc(request) {
      if (request.action === "meta") return { ok: true, async json() { return { ...metaBody(), modelPrices: [] }; } };
      return { ok: true, async json() { return { snapshot: usageSnapshot() }; } };
    },
  });
  const { handle, requests, restore } = mounted;
  try {
    await handle.settle();
    // 单价懒加载本身不受展示精简影响：出现用量仍然读取一次 meta。
    assert.ok(requests.some((request) => request.action === "meta"), "出现用量后仍按需读取 meta");
    assert.equal(byClass(handle.output, "deg_expert_group_attempt_cost").length, 0, "整棵输出不得再有成本节点");
    const allText = textOf(handle.output);
    assert.equal(allText.includes("0 USD"), false, "绝不出现 0 USD 成本");
    assert.equal(allText.includes("估算成本"), false, "没有 attempt 详情就不再有成本文案");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 27：角色显示按节点 roleLabel → snapshot roleLabels → meta 回退，筛选与会话模型区不被静态角色表过滤", async () => {
  const labelSnapshot = usageSnapshot({
    children: [{
      id: "expert-2", kind: "expert", sessionId: "expert-2", taskName: "纯标签专家",
      role: "custom-role", status: "ready", content: "自定义角色任务",
    }],
  });
  const mounted = mountPanel({
    requestPluginRpc(request) {
      if (request.action === "meta") {
        // 会话模型区需要 Host 声明 sessionOverride 能力，否则会按旧宿主降级为 unsupported。
        return { ok: true, async json() { return { ...metaBody(), capabilities: { sessionOverride: true } }; } };
      }
      if (request.action === "session-override-get") {
        return { ok: true, async json() { return { ok: true, revision: 0, live: true, overrides: {} }; } };
      }
      if (request.action === "session-override-set" || request.action === "session-override-clear") {
        return { ok: true, async json() { return { ok: true, revision: 1, live: true, overrides: {} }; } };
      }
      return { ok: true, async json() { return { snapshot: labelSnapshot }; } };
    },
  });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    const metaTexts = byClass(handle.output, "deg_expert_group_meta").map(textOf);
    assert.ok(metaTexts.some((value) => value.startsWith("节点内标签 ·")), "节点 roleLabel 优先：" + metaTexts.join(" | "));
    assert.ok(metaTexts.some((value) => value.startsWith("自定义角色 ·")), "snapshot.roleLabels 回退：" + metaTexts.join(" | "));

    const roleSelect = byAria(handle.output, "按角色筛选");
    const options = walk(roleSelect).filter((node) => node?.type === "option");
    const custom = options.find((option) => option.props.value === "custom-role");
    assert.ok(custom, "自定义角色必须出现在筛选中");
    assert.equal(textOf(custom), "自定义角色", "筛选项显示名来自 roleLabels");

    // 会话模型区沿用同一份合并后的 roleLabels：snapshot 优先，只有 meta 标签时回落 meta。
    byAria(handle.output, "会话模型").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await handle.settle();
    const dialog = byProp(handle.output, "data-deg-session-model", "dialog");
    assert.ok(dialog, "展开后必须渲染会话模型弹窗");
    assert.equal(dialog.props["data-deg-session-model-state"], "ready");
    const rowOfRole = (role) => byProp(dialog, "data-deg-session-model-role", role);
    assert.ok(rowOfRole("fixer"), "内置角色 fixer 必须有会话模型行");
    const pillLabelOf = (role) => textOf(byClass(rowOfRole(role), "deg_expert_group_session_model_pill_label")[0]);
    assert.equal(pillLabelOf("fixer"), "修复者", "snapshot.roleLabels 优先于 meta.roleLabels");
    assert.equal(pillLabelOf("explorer"), "探索者（meta）", "只有 meta 标签时使用 meta.roleLabels");
  } finally {
    handle.unmount();
    restore();
  }
});

test("模型层：用量/结构化/角色标签/成本的纯函数契约（票据 25/27/30）", () => {
  const usage = model.normalizeUsage({ inputTokens: 10, outputTokens: 5, requests: 2, retries: 0, provider: "p" });
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 5, billedInputTokens: 10, totalTokens: 15, requests: 2, provider: "p" });
  assert.equal(model.normalizeUsage({ provider: "p" }), null, "只有归属没有 token/计数不构成用量");
  assert.equal(model.formatTokenCount(999), "999");
  assert.equal(model.formatTokenCount(1500), "1.5k");
  assert.equal(model.formatTokenCount(2500000), "2.5M");
  assert.equal(model.formatTokenCount(null), null);

  assert.equal(model.roleLabelOf("fixer", { fixer: "修复者" }), "修复者");
  assert.equal(model.roleLabelOf("fixer", null), "fixer");
  assert.equal(model.roleLabelFrom("fixer", { fixer: "修复者" }), "修复者");
  assert.equal(model.roleLabelFrom("fixer", null), null);

  const price = { provider: "p", model: "m", inputPerMillion: 1, outputPerMillion: 2, currency: "USD" };
  assert.equal(model.findModelPrice([price], "P", "M"), price, "provider/model 匹配忽略大小写");
  assert.equal(model.findModelPrice([price], "p", "other"), null);
  assert.equal(model.estimateUsageCost(usage, null), null, "无单价绝不返回 0 成本");
  const cost = model.estimateUsageCost({ inputTokens: 1000000, outputTokens: 500000 }, price);
  assert.equal(cost.totalCost, 2);

  const fallback = model.normalizeStructured({ fallback: true, reason: "result_too_large", bytes: 70000 });
  assert.deepEqual(fallback, { bytes: 70000, fallback: true, reason: "result_too_large" });
  assert.equal(model.normalizeStructured({}), null);
  const preview = model.structuredPreviewOf({ value: "y".repeat(600) }, { maxChars: 100 });
  assert.equal(preview.text.length, 100);
  assert.equal(preview.truncated, true);
  assert.equal(model.structuredPreviewOf({ fallback: true, reason: "schema_not_restored" }).reason, "schema_not_restored");
  assert.ok(model.structuredFallbackText("schema_not_restored").includes("冷恢复"));
  assert.ok(model.structuredFallbackText("weird_reason").includes("不可用"));
  assert.equal(model.redactDisplayText("失败 C:\\Users\\u\\AppData\\Local\\Temp\\x.js", 200).includes("AppData"), false);
});