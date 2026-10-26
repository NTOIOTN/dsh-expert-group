import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createClientReactRuntime, createFakeDocumentEventTarget, createFakeIntervals, createHostContextStub, installFakeClock, installGlobals,
  loadClientBundle,
} from "../test-support/client-bundle.mjs";
import { CLIENT_SOURCE_FILES } from "../scripts/client-sources.mjs";

/**
 * 「整个侧栏实现」的源码文本：**从装配清单派生**，不再手工维护文件名。
 *
 * 侧栏在 R5–R7 被拆成 5 个辅助 IIFE + 5 个 Panel 状态 IIFE + 4 个视图 IIFE
 * + 2 个行为 IIFE + 5 个安装面 IIFE + 补票 26b 的 Panel/Hook 模块。手写数组
 * 每拆一次就要补一行，实际已漏过 Panel 与 Hook 模块（源码文本断言看不到它们）。
 * 现在按前缀从 `CLIENT_SOURCE_FILES` 过滤：新增侧栏模块必然进入断言范围。
 */
const SIDEBAR_SOURCE_FILES = CLIENT_SOURCE_FILES.filter((file) =>
  file.startsWith("client-sidebar-") || file === "client-expert-group-sidebar.js",
);
const sidebarSource = (await Promise.all(
  SIDEBAR_SOURCE_FILES.map((file) => readFile(new URL("../" + file, import.meta.url), "utf8")),
)).join("\n");
// 专家提示词查看器（FullSystemPromptNode）在票据 27 拆出的 client-conversation-adapters.js 中；
// 图标词表断言同时读 descriptor 与该模块的源码文本，断言强度不变（旧后缀名在两处都必须消失）。
const clientSource = [
  await readFile(new URL("../client-entry.js", import.meta.url), "utf8"),
  await readFile(new URL("../client-conversation-adapters.js", import.meta.url), "utf8"),
].join("\n");

// 票据 29：模型拆为 normalize → format → 薄门面，按装配顺序依次求值（门面在装载期读取两者检查点）。
await import("../client-expert-group-model-normalize.js");
await import("../client-expert-group-model-format.js");
await import("../client-expert-group-model.js");
await import("../client-expert-group-sidebar.js");
const sidebar = globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];
// 票据 09：侧栏时段标记消费的两份权威实现（构建期投影 + client-text 的 extra 文案表）。
const peakValleyTime = globalThis[Symbol.for("dsh-expert-group/peak-valley-time")];
const { settingsExtraText } = globalThis[Symbol.for("dsh-expert-group/client-text")] ?? {};

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

function walk(node, result = []) {
  if (node === null || node === undefined || node === false) return result;
  result.push(node);
  if (typeof node === "object") for (const child of node.children ?? []) walk(child, result);
  return result;
}

function byClass(root, className) {
  return walk(root).filter((node) => typeof node === "object" && String(node.props?.className ?? "").split(/\s+/).includes(className));
}

function textOf(node) {
  return walk(node).filter((value) => typeof value === "string" || typeof value === "number").join("");
}

/**
 * 官方 sessions 快照替身：byId 提供权威 title 与运行状态（DSH SessionSummary.running），
 * projectionsBySession[parentId].values.subagentCatalog 提供子代理目录项的身份/时间/模式/标签
 * （0.1.7-alpha.2 契约：目录投影不再携带 activity，活动证据由 byId 的 running 派生）。
 */
function sessionsSnapshot() {
  return {
    current: "root-1",
    byId: {
      "root-1": { id: "root-1", title: "根任务标题", displayTitle: "root-1" },
      "expert-running": { id: "expert-running", title: "实现运行任务", displayTitle: "expert-running", running: true },
      "expert-ready": { id: "expert-ready", title: "已完成任务", displayTitle: "expert-ready", running: false },
      "running-child": { id: "running-child", title: "分片运行摘要", displayTitle: "running-child", running: true },
      "new-child": { id: "new-child", title: "最新 attempt 摘要", displayTitle: "new-child", running: false },
    },
    projectionsBySession: {
      "root-1": {
        values: {
          subagentCatalog: [
            { id: "expert-running", createdAt: 1, mode: "continuable", label: "运行专家" },
            { id: "expert-ready", createdAt: 2, mode: "continuable", label: "空闲专家" },
            { id: "running-child", createdAt: 3, mode: "continuable" },
            { id: "new-child", createdAt: 4, mode: "one-shot" },
          ],
        },
      },
    },
  };
}

/** sessions 替身：可订阅、可推送新快照，用于验证行内状态（圆点/分组）动态刷新。 */
function sessionsFixture(opened = []) {
  const state = { snapshot: sessionsSnapshot() };
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => state.snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    open(id) { opened.push(id); },
    update(next) {
      state.snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

function snapshot() {
  return {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh",
      content: "当前目标内容", status: "running", continuable: false,
      runSummary: { command: "编辑 dsh-expert-group/test/index.js", mode: "one-shot", activity: "running" },
      children: [
        { id: "expert-running", kind: "expert", sessionId: "expert-running", taskName: "运行专家", role: "fixer", content: "实现运行任务", status: "running", runSummary: { command: "Grep running-task", mode: "continuable", activity: "running" }, continuable: true },
        { id: "expert-ready", kind: "expert", sessionId: "expert-ready", taskName: "空闲专家", role: "explorer", content: "已完成任务", status: "ready", runSummary: { command: "读取完成", mode: "continuable", activity: "idle" }, continuable: true },
        {
          id: "fan-1", kind: "fanout", parentTaskId: "fan-1", role: "fixer", status: "running",
          shards: [
            { shardId: "running-shard", prompt: "运行中的分片提示", role: "fixer", status: "running", childId: "running-child", attempts: [{ attempt: 1, status: "running", childId: "running-child" }] },
            { shardId: "failed-shard", prompt: "失败分片的完整长提示内容", role: "designer", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh", status: "failed", childId: "new-child", attempts: [{ attempt: 1, status: "failed", childId: "old-child" }, { attempt: 2, status: "failed", childId: "new-child" }] },
            // 有任务名称的分片（Host 已把"任务名称优先、旧数据回退 shardId"投影成 taskName）。
            // 覆盖"分片代号  任务名称"文案；没有 taskName 的分片仍只显示分片代号。
            { shardId: "cancelled-shard", taskName: "实现添加任务名称", prompt: "取消分片提示", status: "cancelled", childId: "cancelled-child", attempts: [{ attempt: 1, status: "cancelled", childId: "cancelled-child" }] },
          ],
        },
      ],
    },
  };
}

function mountPanel(overrides = {}) {
  const runtime = overrides.runtime ?? createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const opened = [];
  const requests = [];
  const confirms = [];
  /** 已删除的历史注入面：插件一旦读取并调用它就是回归，用例据此断言它从未被触碰。 */
  const legacyOpenSessionCalls = [];
  const sessions = overrides.sessions ?? sessionsFixture(opened);
  // 工作区服务的打开会话入口是 0.1.7-alpha.2 唯一的导航面（已删除的 sessions.open /
  // deps.openSession 回退不再被读取）。默认替身记录每个导航目标，用例可用 overrides.uiWorkspace
  // 换成受控实现；不需要导航能力的用例可显式传 uiWorkspace: null。
  const uiWorkspace = overrides.uiWorkspace === undefined
    ? { openSession(target) { opened.push(target); } }
    : (overrides.uiWorkspace === null ? undefined : overrides.uiWorkspace);
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: overrides.primitives ?? {},
    sessions,
    storage: overrides.storage,
    // 历史注入面（本插件旧契约，只接受裸 session id）：必须完全不被读取。
    openSession: (id) => legacyOpenSessionCalls.push(id),
    // 真实 Host 会注入按 parentId 上溯的 root 解析器；默认不注入（多数用例挂在 root surface 上）。
    resolveRootSessionId: overrides.resolveRootSessionId,
    // 默认直接接受确认；用例可用 overrides.confirm 换成受控（挂起）的确认弹窗，
    // 从而驱动「确认还没返回时的重复点击」「确认期间切换 root」这类并发场景。
    confirm(message) { confirms.push(message); return typeof overrides.confirm === "function" ? overrides.confirm(message) : true; },
    // 右栏拖拽手柄锁的两个注入点（install 侧提供，面板据此在本页活跃时锁住手柄、离开时交还）。
    // 与真实装配一致：不注入时面板必须保持 no-op（多数用例正是这种形状）。
    syncRightbarDragLock: overrides.syncRightbarDragLock,
    releaseRightbarDragLock: overrides.releaseRightbarDragLock,
    // 票据 18：宽度偏好的两个注入点（生产由 install 提供）。测试可注入受控实现，
    // 断言面板只提出比例、真实写入与持久化留给 install 侧。
    readRightbarWidthRatio: overrides.readRightbarWidthRatio,
    applyRightbarWidthRatio: overrides.applyRightbarWidthRatio,
    beginSidebarSplit: overrides.beginSidebarSplit,
    markSidebarSplitPane: overrides.markSidebarSplitPane,
    markSidebarSplitOpen: overrides.markSidebarSplitOpen,
    commitSidebarSplit: overrides.commitSidebarSplit,
    cancelSidebarSplit: overrides.cancelSidebarSplit,
    // 票据 16：tab 活跃度注入点（生产由 install 侧/宿主提供；缺省时面板退回文档可见性）。
    isTabActive: overrides.isTabActive,
    // 票据 09：标题栏峰谷时段标记的注入面（生产由 install 侧读取配置表单快照并订阅）。
    getPeakValleySettings: overrides.getPeakValleySettings,
    subscribePeakValleySettings: overrides.subscribePeakValleySettings,
    peakValleyTime: overrides.peakValleyTime,
    settingsExtraText: overrides.settingsExtraText,
    async requestPluginRpc(_connection, request, init) {
      requests.push(request);
      if (typeof overrides.requestPluginRpc === "function") {
        return overrides.requestPluginRpc(_connection, request, init);
      }
      return { ok: true, async json() { return { snapshot: overrides.hostSnapshot ?? snapshot() }; } };
    },
  });
  const handle = runtime.render(Panel, {
    scope: { sessionId: overrides.scopeSessionId ?? "root-1" },
    // 新 DSH 契约的服务都挂在 tab 的 props.ctx 上（与真实宿主一致）：uiWorkspace.openSession 是
    // 主视图导航入口（缺失时不渲染任何导航入口），sidebarRight.openResource 是侧栏资源入口。
    // 票据 19：locale 注入面（生产宿主把 ctx.locale / ctx.i18n.locale 挂在 tab props.ctx 上）。
    ctx: {
      connection: {},
      uiWorkspace,
      sidebarRight: overrides.sidebarRight,
      layout: overrides.layout,
      ...(overrides.locale === undefined ? {} : { locale: overrides.locale }),
      ...(overrides.i18n === undefined ? {} : { i18n: overrides.i18n }),
    },
  });
  return { runtime, intervals, restore, opened, legacyOpenSessionCalls, requests, confirms, sessions, handle };
}

test("空闲组标题与批量控件同行内相邻，树线仍按末项结构收束", () => {
  // 标题与固定 30px trailing slot 共享第三个 grid 单元格的 inline flex；不得单独占 grid 尾列。
  assert.match(sidebarSource, /deg_expert_group_idle_group>\.deg_expert_group_row\.deg_expert_group_idle_header\{display:grid;grid-template-columns:20px 20px minmax\(0,1fr\);align-items:center;height:28px;min-height:28px;padding:4px 0\}/);
  assert.match(sidebarSource, /\.deg_expert_group_idle_title_line\{display:flex;align-items:center;min-width:0;gap:2px\}/);
  assert.match(sidebarSource, /deg_expert_group_idle_group>\.deg_expert_group_children\{margin:0;padding:0;--deg-parent-row-height:28px\}/);
  assert.match(sidebarSource, /deg_expert_group_children>:first-child:before\{position:absolute;top:calc\(var\(--deg-tree-anchor\) - var\(--deg-parent-row-height\)\)/);
  assert.match(sidebarSource, /deg_expert_group_children>:not\(:last-child\):after\{position:absolute;top:var\(--deg-tree-anchor\);bottom:calc\(0px - var\(--deg-tree-anchor\)\)/);
  assert.match(sidebarSource, /deg_expert_group_fanout_shards>\.deg_expert_group_shard:not\(:last-child\):after/);
  // fan-out 头部的箭头沿用通用起始对齐，但在 28px 头部网格中单独回到中心，
  // 使 20px 箭头按钮与同列状态点的中心重合，不影响普通代理行。
  assert.match(sidebarSource, /\.deg_expert_group_chevron\{width:20px;height:20px;padding:0;align-self:start\}/);
  assert.match(sidebarSource, /\.deg_expert_group_fanout_header>\.deg_expert_group_chevron\{align-self:center\}/);
  assert.equal(sidebarSource.includes("border-left:1px solid var(--dsw-alias-border-l2)"), false);
  assert.match(sidebarSource, /className: "deg_expert_group_row deg_expert_group_idle_header"/);
});

/**
 * 分片任务名完整显示的结构门禁（与渲染断言互补）。
 *
 * 只删渲染层截断而保留单行省略，长名称依然看不到——所以这里同时锁住三件事：
 * 1. 分片第一行有专用样式类，且该类把单行省略换成可换行（white-space:normal + overflow-wrap）；
 * 2. 两行网格的第一行是 auto：换行后的文本按内容撑高，不会被压进 16px 行盒与第二行重叠；
 * 3. 分片行沿用 min-height（不设固定 height），名称换行只让行变高；
 * 4. 树线锚点绑定固定 20px 高的状态图标中心，行高可变时树形结构仍然正确。
 */
test("分片第一行用专用可换行样式替代单行省略，两行网格与树线锚点按可变行高收敛", () => {
  assert.match(
    sidebarSource,
    /\.deg_expert_group_shard_task\{overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere\}/,
  );
  assert.match(
    sidebarSource,
    /\.deg_expert_group_row_main\{display:grid;grid-template-columns:minmax\(0,1fr\);grid-template-rows:auto 16px;min-width:0\}/,
  );
  // 侧栏精简后主行只剩两行（任务名 + 模型元数据）：行高与树线锚点同步收敛到 44px。
  assert.match(sidebarSource, /\.deg_expert_group_row\{[^}]*min-height:44px/);
  assert.match(sidebarSource, /\.deg_expert_group_children\{position:relative;min-width:0;margin:0;padding:0;--deg-parent-row-height:44px\}/);
  assert.equal(sidebarSource.includes("--deg-parent-row-height:60px"), false, "树线锚点不得再引用旧的三行主行高度");
  assert.match(
    sidebarSource,
    /\.deg_expert_group_task_line\{grid-area:1 \/ 1;display:flex;align-items:center;min-width:0;gap:2px\}/,
  );
  // 主代理批量 slot 与标题共享同一个 inline flex 行：slot 固定，不向行尾延伸。
  assert.match(sidebarSource, /\.deg_expert_group_task_line_trailing\{justify-content:flex-start\}/);
  assert.equal(sidebarSource.includes(".deg_expert_group_task_line_trailing>.deg_expert_group_task_line{flex:1 1 auto;min-width:0}"), false);
  assert.match(
    sidebarSource,
    /\.deg_expert_group_sidebar_action\{flex:0 0 30px;width:30px;height:20px;margin:-2px 0;padding:0;color:var\(--dsw-alias-state-warning-primary,#f59e0b\)\}/,
  );
  assert.match(
    sidebarSource,
    /\.deg_expert_group_sidebar_action:hover\{color:var\(--dsw-alias-state-warning-primary,#f59e0b\)\}/,
  );
  // 打开态（可关闭的 <<）沿用同一枚 30×20 点击区域，只换颜色：主题 business/info token，缺 token 的老宿主退回 cyan。
  assert.match(
    sidebarSource,
    /\.deg_expert_group_sidebar_action\[data-open=true\]\{color:var\(--dsw-alias-state-business-primary,var\(--dsw-alias-button-info-fill,#22d3ee\)\)\}/,
  );
  assert.match(
    sidebarSource,
    /\.deg_expert_group_sidebar_action\[data-open=true\]:hover\{background:var\(--dsw-alias-interactive-bg-hover\);color:var\(--dsw-alias-state-business-primary,var\(--dsw-alias-button-info-fill,#22d3ee\)\)\}/,
  );
  assert.match(
    sidebarSource,
    /\.deg_expert_group_double_arrow\{display:inline-flex;align-items:center;justify-content:center;width:30px;height:20px;line-height:0\}/,
  );
  assert.match(sidebarSource, /\.deg_expert_group_double_arrow>\*\+\*\{margin-left:-10px\}/);
  assert.match(sidebarSource, /\.deg_expert_group_double_arrow_icon path\{stroke:currentColor;stroke-width:1\.5;stroke-linejoin:round\}/);
  assert.match(sidebarSource, /\.deg_expert_group_shard\{display:grid;grid-template-columns:20px 20px minmax\(0,1fr\) auto;min-width:0;min-height:48px/);
  assert.match(sidebarSource, /\.deg_expert_group_fanout_shards>\.deg_expert_group_shard\{--deg-tree-anchor:13px;position:relative\}/);
  // 普通专家/根节点第一行仍然是既有的单行省略，未被分片样式波及。
  assert.match(sidebarSource, /\.deg_expert_group_line\{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/);
  // 渲染层不再存在 20 grapheme 截断路径。
  assert.equal(sidebarSource.includes("truncateCommand"), false, "第一行不得再做 grapheme 硬截断");
  assert.equal(sidebarSource.includes("SEGMENTER_CACHE"), false, "截断删除后分段器缓存不得残留");
});

test("代理行只显示 running/ready 圆点与两行主体，根第一行固定为主代理", async () => {
  const StateDot = function StateDot() { return null; };
  // 展开状态需要可持久化的 storage 才生效（无 storage 时 store 每次回落到默认值）。
  const storage = new MemoryStorage();
  const mounted = mountPanel({ primitives: { StateDot }, storage });
  const { handle, opened, requests, confirms, sessions, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(intervals.active, 1);

    const rows = byClass(handle.output, "deg_expert_group_row_main");
    const rootRow = rows.find((row) => row.props["data-kind"] === "root");
    const runningRow = rows.find((row) => textOf(row).includes("运行专家"));
    const readyRow = rows.find((row) => textOf(row).includes("空闲专家"));
    const failedRow = rows.find((row) => textOf(row).includes("failed-shard"));
    const cancelledRow = rows.find((row) => textOf(row).includes("cancelled-shard"));

    // 普通专家永远两行（任务名 + 模型元数据），且不因自身展开状态隐藏任何一行；空闲分组默认展开并显示成员。
    for (const row of [rootRow, runningRow, failedRow, cancelledRow]) assert.equal(row.children.length, 2);
    // 没有 sidebarRight（本用例）时两行都**不**增加批量 slot / 零圆点：能力缺失绝不留下空占位。
    assert.equal(byClass(handle.output, "deg_expert_group_trailing").length, 0);
    assert.equal(byClass(handle.output, "deg_expert_group_sidebar_batch_action").length, 0);
    assert.equal(byClass(handle.output, "deg_expert_group_sidebar_batch_zero").length, 0);
    // 空闲分组标题行始终渲染（snapshot 已知），成员数为 0 时也保留「空闲子代理（0）」的零状态。
    assert.equal(byClass(handle.output, "deg_expert_group_idle_header").length, 1);
    assert.ok(readyRow, "空闲子代理默认显示在展开的空闲分组中");
    assert.equal(byClass(handle.output, "deg_expert_group_idle_group")[0].props["data-expanded"], true);

    // 根节点第一行固定「主代理」：绝不显示 root taskName/title/session id。
    assert.equal(textOf(byClass(rootRow, "deg_expert_group_task")[0]), "主代理");
    assert.ok(!textOf(rootRow).includes("root-1"));
    assert.ok(!textOf(rootRow).includes("session-"));
    assert.equal(textOf(byClass(rootRow, "deg_expert_group_meta")[0]), "Orchestrator · A6 · gpt-5.6-sol · Xhigh");
    // 根会话权威标题不再出现在任何一行（摘要行已移除），根行只有任务名与元数据。
    assert.equal(textOf(rootRow), "主代理Orchestrator · A6 · gpt-5.6-sol · Xhigh");
    assert.ok(!textOf(rootRow).includes("根任务标题"), "根会话权威标题不得再上屏");

    // 普通专家两行 = 任务名 + 模型元数据；工具命令与 mode/activity 文案都不再上屏。
    assert.equal(textOf(byClass(runningRow, "deg_expert_group_meta")[0]), "Fixer · 未知供应商 · 未知模型 · 默认");
    assert.ok(!textOf(runningRow).includes("Grep running-task"), "侧栏不得再显示工具命令");
    assert.ok(!textOf(runningRow).includes("可继续"), "mode 文案不再出现在侧栏");
    // 分片第一行是"分片代号  任务名称"：有 taskName 时显示名称，没有名称的旧数据
    // 仍然只显示分片代号（见 cancelledRow 的对照断言）。
    assert.equal(textOf(byClass(failedRow, "deg_expert_group_task")[0]), "failed-shard");
    // 第一行不再做 grapheme 硬截断：拼接后的完整文本必须原样上屏（分片代号不允许挤掉任务名称），
    // title/tooltip 与视觉文本同源。
    assert.equal(textOf(byClass(cancelledRow, "deg_expert_group_task")[0]), "cancelled-shard  实现添加任务名称");
    assert.equal(byClass(cancelledRow, "deg_expert_group_task")[0].props.title, "cancelled-shard  实现添加任务名称");
    // 分片第一行改用专用可换行样式替代单行省略；普通专家行不拿到该类，仍走 .deg_expert_group_line 的单行省略。
    for (const shardRow of [failedRow, cancelledRow]) {
      assert.match(
        String(byClass(shardRow, "deg_expert_group_task")[0].props.className),
        /(?:^|\s)deg_expert_group_shard_task(?:\s|$)/,
        "分片第一行必须带可换行样式类",
      );
    }
    assert.doesNotMatch(String(byClass(runningRow, "deg_expert_group_task")[0].props.className), /deg_expert_group_shard_task/);
    // 分片同样只有两行；最新 attempt 的权威标题与目录 mode 不再进入侧栏文案。
    assert.equal(textOf(byClass(failedRow, "deg_expert_group_meta")[0]), "Designer · A6 · gpt-5.6-sol · Xhigh");
    // 分片角色沿用父 fan-out 的 role（normalizeShard 的继承规则），元数据行因此显示 Fixer。
    assert.equal(textOf(byClass(cancelledRow, "deg_expert_group_meta")[0]), "Fixer · 未知供应商 · 未知模型 · 默认");
    assert.equal(byClass(handle.output, "deg_expert_group_content").length, 0, "摘要行必须从渲染树彻底消失");

    // 状态只有两个规范值，图标一律用官方 StateDot：running → ongoing，ready → done。
    const icons = byClass(handle.output, "deg_expert_group_status_icon");
    assert.deepEqual([...new Set(icons.map((icon) => icon.props["data-status"]))].sort(), ["ready", "running"]);
    for (const icon of icons) {
      assert.equal(typeof icon.props.title, "string");
      assert.equal(icon.props["aria-label"], icon.props.title);
    }
    const dotStates = walk(handle.output).filter((node) => node?.type === StateDot).map((dot) => dot.props.state);
    assert.ok(dotStates.includes("ongoing"), "running 必须使用 StateDot 的 ongoing");
    assert.ok(dotStates.includes("done"), "ready 必须使用 StateDot 的 done");
    assert.equal(walk(handle.output).some((node) => node?.props?.className === "deg_expert_group_state_dot"), false, "官方组件可用时不走兜底圆点");

    // sessions 快照仍驱动分组与圆点（同一 child 的新运行状态立即生效）。
    const next = sessionsSnapshot();
    next.byId["expert-running"] = { id: "expert-running", title: "运行任务新标题", displayTitle: "expert-running", running: false };
    next.projectionsBySession["root-1"].values.subagentCatalog[0] = { id: "expert-running", createdAt: 1, mode: "one-shot", label: "运行专家" };
    sessions.update(next);
    await handle.settle();
    const refreshedIdleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
    assert.ok(refreshedIdleGroup, "运行中的专家变为未运行后必须进入空闲分组");
    assert.equal(textOf(refreshedIdleGroup).includes("空闲子代理（2）"), true);
    assert.equal(refreshedIdleGroup.props["data-expanded"], true, "空闲分组默认展开");
    const refreshedRow = byClass(handle.output, "deg_expert_group_row").find((row) => textOf(row).includes("运行专家"));
    assert.equal(byClass(refreshedRow, "deg_expert_group_status_icon")[0].props["data-status"], "ready");
    assert.ok(!textOf(refreshedRow).includes("运行任务新标题"), "权威标题不再上屏（摘要行已移除）");

    // fan-out 分支：标题只出现规范状态词，管理状态改由 data-task-status 暴露。
    const fanoutTitle = byClass(handle.output, "deg_expert_group_fanout_header").map(textOf).join(" ");
    assert.ok(fanoutTitle.includes("Fixer · 3 shards · running"));
    const fanoutContainer = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(fanoutContainer.props["data-status"], "running");
    assert.equal(fanoutContainer.props["data-task-status"], "running");

    // 键盘可访问性：只有任务名是 role=button + tabIndex，Enter/Space 与鼠标一致。
    const taskLine = byClass(failedRow, "deg_expert_group_task")[0];
    assert.equal(taskLine.props.role, "button");
    assert.equal(taskLine.props.tabIndex, 0);
    assert.ok(typeof taskLine.props["aria-label"] === "string" && taskLine.props["aria-label"].startsWith("打开任务会话："));
    const rowCountBeforeKeyboardNavigation = byClass(handle.output, "deg_expert_group_row_main").length;
    assert.ok(taskLine.props["aria-label"].includes("failed-shard"), "任务名 aria-label 必须点明任务");
    taskLine.props.onKeyDown({ key: "a", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, [], "非 Enter/Space 按键不得导航");
    // 工作区入口认识 SubagentAddress：分片导航同样传地址（目录投影给出 one-shot）。
    const shardAddress = { parentSessionId: "root-1", childSessionId: "new-child", mode: "one-shot" };
    taskLine.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, [shardAddress]);
    taskLine.props.onKeyDown({ key: " ", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, [shardAddress, shardAddress], "Space 也能导航到最新 attempt child");
    assert.equal(byClass(handle.output, "deg_expert_group_row_main").length, rowCountBeforeKeyboardNavigation, "键盘操作不得新增或删除行");

    // 取消/重试仍按 fan-out 管理状态判定，语义不变。
    const retry = walk(handle.output).find((node) => node?.props?.["aria-label"] === "重试分片 failed-shard");
    assert.ok(retry, "失败分片必须提供直接重试");
    await retry.props.onClick();
    await handle.settle();
    assert.ok(requests.some((request) => request.action === "fanout-retry-shard" && request.shardId === "failed-shard"));
    assert.equal(confirms.length, 0, "retry 不需要确认");
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "重试分片 cancelled-shard"), false);

    const cancelParent = walk(handle.output).find((node) => node?.props?.["aria-label"] === "取消父任务（未完成 1 个分片）");
    assert.ok(cancelParent);
    await cancelParent.props.onClick();
    await handle.settle();
    assert.ok(requests.some((request) => request.action === "fanout-cancel-parent" && request.parentTaskId === "fan-1"));
    assert.ok(confirms[0].includes("未完成 1 个分片"));

    // 空闲分组默认展开；手动折叠后可再次展开，成员仍保持两行。
    const idleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
    const idleChevron = byClass(idleGroup, "deg_expert_group_chevron")[0];
    assert.equal(idleChevron.props["aria-expanded"], true);
    idleChevron.props.onClick({ stopPropagation() {} });
    await handle.settle();
    const collapsedIdleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
    assert.equal(byClass(collapsedIdleGroup, "deg_expert_group_chevron")[0].props["aria-expanded"], false);
    assert.equal(byClass(handle.output, "deg_expert_group_row_main").some((row) => textOf(row).includes("空闲专家")), false);
    byClass(collapsedIdleGroup, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
    await handle.settle();
    const expandedReady = byClass(handle.output, "deg_expert_group_row_main").find((row) => textOf(row).includes("空闲专家"));
    assert.equal(expandedReady.children.length, 2);
    assert.ok([...storage.values.keys()].some((key) => key.includes("root-1") && key.includes("__idle__")));
    const expandedIdleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
    const idleChildren = byClass(expandedIdleGroup, "deg_expert_group_children")[0];
    assert.ok(idleChildren, "展开空闲组时直接渲染子代理列表");
    assert.equal(idleChildren.children.length, 2, "空闲组 children 不应插入额外首项 spacer");
    assert.ok(String(idleChildren.children[0].props.className).includes("deg_expert_group_node"));

    const rootNode = byClass(handle.output, "deg_expert_group_node_root")[0];
    byClass(rootNode, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_children").length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 需求二的默认展开红线：判定只看**结算状态**，不看挂载位置。
 *
 * - 已结算（succeeded / failed / cancelled）：默认收起 —— 这类 fan-out 必然被「空闲子代理（N）」分组收纳，
 *   用户要求进入分组后默认收起；
 * - 未结算（idle / ready 等不在结算词表里的状态）：默认展开 —— 运行期行为逐字不变。
 *
 * 收起只是折叠，不是删数据：点击 chevron（用户唯一入口）后 3 个分片全部回来，
 * 且 fan-out 仍然只渲染一次（不重复渲染）。
 */
test("fan-out 结算态默认收起、未结算态默认展开全部子代理", async () => {
  /** 把 fan-out 父任务与它的 3 个分片一起改到目标状态（父任务状态决定默认展开值）。 */
  const applyStatus = (hostSnapshot, status) => {
    const task = hostSnapshot.root.children.find((node) => node.kind === "fanout");
    task.status = status;
    for (const shard of task.shards) {
      shard.status = status;
      shard.attempts.at(-1).status = status;
    }
  };

  // ① 结算态（三种终态逐一覆盖，与空闲组成员判定 FANOUT_SETTLED_STATUSES 同集合）：
  //    默认 aria-expanded=false 且 0 个可见分片；点击后展开出全部分片。
  for (const status of ["succeeded", "failed", "cancelled"]) {
    const hostSnapshot = snapshot();
    applyStatus(hostSnapshot, status);
    const { handle, restore } = mountPanel({ hostSnapshot, storage: new MemoryStorage() });
    try {
      await handle.settle();
      const branch = byClass(handle.output, "deg_expert_group_fanout")[0];
      assert.ok(branch, status + "：结算态 fan-out 必须仍渲染父任务行");
      assert.equal(branch.props["data-task-status"], status);
      assert.equal(byClass(branch, "deg_expert_group_chevron")[0].props["aria-expanded"], false, status + "：结算态必须默认收起");
      assert.equal(byClass(branch, "deg_expert_group_shard").length, 0, status + "：收起时不得渲染分片行");
      // 默认收起与「归入空闲组」是同一语义的两面：先确认它确实在分组内，再展开。
      const idleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
      assert.ok(idleGroup, status + "：结算态 fan-out 必须归入空闲子代理分组");
      assert.equal(byClass(idleGroup, "deg_expert_group_fanout").length, 1, status + "：分组内恰好一条 fan-out");

      byClass(branch, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
      await handle.settle();
      const expanded = byClass(handle.output, "deg_expert_group_fanout")[0];
      assert.equal(byClass(expanded, "deg_expert_group_chevron")[0].props["aria-expanded"], true, status + "：点击后必须展开");
      assert.equal(byClass(expanded, "deg_expert_group_shard").length, 3, status + "：展开后分片必须全在");
      assert.equal(byClass(handle.output, "deg_expert_group_fanout").length, 1, status + "：展开前后 fan-out 只渲染一次");
    } finally {
      handle.unmount();
      restore();
    }
  }

  // ② 未结算态：默认展开（运行期红线，行为不变）。
  for (const status of ["idle", "ready"]) {
    const hostSnapshot = snapshot();
    applyStatus(hostSnapshot, status);
    const { handle, restore } = mountPanel({ hostSnapshot, storage: new MemoryStorage() });
    try {
      await handle.settle();
      const branch = byClass(handle.output, "deg_expert_group_fanout")[0];
      assert.equal(byClass(branch, "deg_expert_group_chevron")[0].props["aria-expanded"], true, status + "：未结算必须默认展开");
      assert.equal(byClass(branch, "deg_expert_group_shard").length, 3, status + "：未结算必须直接展示全部分片");
    } finally {
      handle.unmount();
      restore();
    }
  }
});

test("fan-out 未完成时留在主代理下，完成后完整进入空闲子代理组", async () => {
  // 展开 override 只在有可写 storage 时持久（无 storage 时点击后的下一次渲染会退回默认值），
  // 本用例要区分「默认值」与「用户点击后的展开」，因此必须提供一个真实存储替身。
  const storage = new MemoryStorage();
  const hostSnapshot = snapshot();
  const task = hostSnapshot.root.children.find((node) => node.kind === "fanout");
  task.status = "running";
  const { handle, intervals, restore } = mountPanel({ hostSnapshot, storage });
  try {
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_fanout").length, 1);
    const idleGroupWhileRunning = byClass(handle.output, "deg_expert_group_idle_group")[0];
    assert.equal(byClass(idleGroupWhileRunning, "deg_expert_group_fanout").length, 0);
    // 运行态红线（需求二之前的行为逐字保留）：未结算 fan-out 默认展开，分片直接可见。
    assert.equal(byClass(handle.output, "deg_expert_group_shard").length, 3, "未结算 fan-out 默认展开");

    const terminalCases = [
      ["succeeded", ["succeeded", "succeeded", "succeeded"]],
      ["failed", ["succeeded", "failed", "succeeded"]],
      ["cancelled", ["cancelled", "cancelled", "cancelled"]],
    ];
    for (const [taskStatus, shardStatuses] of terminalCases) {
      task.status = taskStatus;
      task.shards.forEach((shard, index) => {
        shard.status = shardStatuses[index];
        shard.attempts.at(-1).status = shardStatuses[index];
      });
      // 清掉上一轮手动展开留下的 override：下面要断言的是**默认值**本身，不是上一轮的点击残留。
      storage.values.clear();
      hostSnapshot.generatedAt += 1;
      await intervals.tick();
      await handle.settle();

      const idleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
      const groupedFanout = byClass(idleGroup, "deg_expert_group_fanout")[0];
      assert.ok(groupedFanout, "终态 fan-out 父任务应归入空闲子代理组");
      assert.equal(groupedFanout.props["data-task-status"], taskStatus);
      // 需求二：结算态 fan-out 默认收起（aria-expanded=false，分片行不进渲染树）。
      assert.equal(
        byClass(groupedFanout, "deg_expert_group_chevron")[0].props["aria-expanded"],
        false,
        "结算态 fan-out 默认收起",
      );
      assert.equal(byClass(groupedFanout, "deg_expert_group_shard").length, 0, "默认收起时不渲染分片行");

      // 用户在空闲组内点击 chevron 展开：完整分片树与重试动作都仍在组内，且 fan-out 只渲染一次。
      byClass(groupedFanout, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
      await handle.settle();
      const expandedFanout = byClass(byClass(handle.output, "deg_expert_group_idle_group")[0], "deg_expert_group_fanout")[0];
      assert.equal(byClass(expandedFanout, "deg_expert_group_chevron")[0].props["aria-expanded"], true, "点击后必须展开");
      assert.equal(byClass(expandedFanout, "deg_expert_group_shard").length, 3, "移入分组后仍保留完整分片树");
      if (taskStatus === "failed") {
        const retryAction = byClass(expandedFanout, "deg_expert_group_action")
          .find((action) => action.props["aria-label"]?.startsWith("重试分片 "));
        assert.ok(retryAction, "失败分片的重试操作应随 fan-out 一起保留在空闲组");
      }
      assert.equal(byClass(handle.output, "deg_expert_group_fanout").length, 1, "fan-out 父任务不能重复渲染");
    }
  } finally {
    handle.unmount();
    restore();
  }
});

/**
 * 手动选择恒优先于缺省值（需求二把缺省值改成「结算态收起」，这条优先级因此必须双向验证）。
 *
 * 顺序刻意按新缺省值重排：默认已折叠 → 手动展开 → 再手动折叠 → 刷新后仍折叠 → 重挂载后仍折叠
 * → 再次展开仍可见。否则「默认值本来就是折叠」会让断言假通过，证明不了 override 的存在。
 */
test("fan-out 手动展开/折叠优先于默认值，状态刷新和重新挂载后仍保持用户选择", async () => {
  const storage = new MemoryStorage();
  const hostSnapshot = snapshot();
  const task = hostSnapshot.root.children.find((node) => node.kind === "fanout");
  // 夹具直接处于结算态：只有此时「默认收起」与「手动展开」才会真正竞争。
  task.status = "succeeded";
  for (const shard of task.shards) {
    shard.status = "succeeded";
    shard.attempts.at(-1).status = "succeeded";
  }
  const { handle, intervals, restore } = mountPanel({ hostSnapshot, storage });
  try {
    await handle.settle();
    // ① 默认收起：结算态 fan-out 不进分片行。
    const initial = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(byClass(initial, "deg_expert_group_chevron")[0].props["aria-expanded"], false, "结算态 fan-out 默认收起");
    assert.equal(byClass(initial, "deg_expert_group_shard").length, 0);

    // ② 手动展开：override=true，分片全部可见，且 override 真的落盘。
    byClass(initial, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
    await handle.settle();
    const expandedOnce = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(byClass(expandedOnce, "deg_expert_group_chevron")[0].props["aria-expanded"], true, "手动展开必须压过默认收起");
    assert.equal(byClass(expandedOnce, "deg_expert_group_shard").length, 3);
    assert.ok(
      [...storage.values.values()].some((raw) => raw.includes("\"expanded\":true")),
      "手动展开必须以 override 形式落盘（默认值绝不落盘）",
    );

    // ③ 再手动折叠：override=false。
    byClass(expandedOnce, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
    await handle.settle();
    assert.equal(byClass(byClass(handle.output, "deg_expert_group_fanout")[0], "deg_expert_group_shard").length, 0);

    // ④ 状态刷新（真实内容变化的快照）不得覆盖用户刚才的手动折叠选择。
    hostSnapshot.root.children.find((node) => node.id === "expert-ready").taskName = "刷新后的空闲专家";
    hostSnapshot.generatedAt += 1;
    await intervals.tick();
    await handle.settle();
    assert.ok(textOf(handle.output).includes("刷新后的空闲专家"), "确认刷新真的上屏（折叠不被刷新静默覆盖）");
    const refreshed = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(refreshed.props["data-task-status"], "succeeded", "确认已显示完成后的快照");
    assert.equal(byClass(refreshed, "deg_expert_group_chevron")[0].props["aria-expanded"], false);
    assert.equal(byClass(refreshed, "deg_expert_group_shard").length, 0);
    assert.ok(
      [...storage.values.values()].some((raw) => raw.includes("\"expanded\":false")),
      "手动折叠同样以 override 形式落盘",
    );
  } finally {
    handle.unmount();
    restore();
  }

  // ⑤ 沿用同一存储重新挂载，模拟刷新页面后恢复状态；再次点击仍能展示分片。
  const remounted = mountPanel({ hostSnapshot, storage });
  try {
    await remounted.handle.settle();
    const branch = byClass(remounted.handle.output, "deg_expert_group_fanout")[0];
    const chevron = byClass(branch, "deg_expert_group_chevron")[0];
    assert.equal(chevron.props["aria-expanded"], false);
    assert.equal(byClass(branch, "deg_expert_group_shard").length, 0);
    chevron.props.onClick({ stopPropagation() {} });
    await remounted.handle.settle();
    const reopened = byClass(remounted.handle.output, "deg_expert_group_fanout")[0];
    assert.equal(byClass(reopened, "deg_expert_group_chevron")[0].props["aria-expanded"], true);
    assert.equal(byClass(reopened, "deg_expert_group_shard").length, 3);
  } finally {
    remounted.handle.unmount();
    remounted.restore();
  }
});

test("未知 Host 状态但官方目录未运行时仍进入默认展开分组", async () => {
  const hostSnapshot = snapshot();
  const readyExpert = hostSnapshot.root.children.find((node) => node.kind === "expert" && node.id === "expert-ready");
  readyExpert.status = "unknown";
  readyExpert.running = null;

  const mounted = mountPanel({ hostSnapshot });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(
      byClass(handle.output, "deg_expert_group_idle_group").length,
      1,
      "官方目录明确 inactive 的专家必须进入默认展开分组",
    );
    const idleGroup = byClass(handle.output, "deg_expert_group_idle_group")[0];
    assert.equal(idleGroup.props["data-expanded"], true, "空闲分组默认展开");
    assert.equal(
      byClass(idleGroup, "deg_expert_group_row_main").some((row) => textOf(row).includes("空闲专家")),
      true,
      "未运行专家显示在展开的空闲分组中",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("展示数据分工：运行状态来自 byId 投影的 running，目录投影只提供 mode", async () => {
  const StateDot = function StateDot() { return null; };
  // 分片一：byId running=true，Host 快照旧信号却说未运行（running=false + status=idle）。
  // 分片二：byId running=false，Host 快照旧信号却说在运行（running=true + status=running）。
  // 分片三：byId 没有布尔 running（投影未就绪），只能回退到 DEG 自己的元数据证据。
  const hostSnapshot = snapshot();
  const fanoutTask = hostSnapshot.root.children.find((child) => child.kind === "fanout");
  const shards = fanoutTask.shards;
  shards[0].running = false;
  shards[0].status = "idle";
  shards[1].running = true;
  shards[1].status = "running";
  const mounted = mountPanel({ primitives: { StateDot }, hostSnapshot });
  const { handle, intervals, restore, sessions } = mounted;
  try {
    // 会话投影只保证身份/模式/标签，运行状态一律由 byId 的 SessionSummary.running 派生；
    // 先把 byId 的 running 喂成与 Host 快照相反的值，证明展示层读的是投影而非快照。
    sessions.update(sessionsSnapshot());
    await handle.settle();
    const shardRow = (shardId) => byClass(handle.output, "deg_expert_group_shard").find((row) => row.props["data-shard-id"] === shardId);
    const runningShard = shardRow("running-shard");
    const inactiveShard = shardRow("failed-shard");
    // byId running=true 必须保持 running，不能被 Host 快照旧信号降级。
    assert.equal(byClass(runningShard, "deg_expert_group_status_icon")[0].props["data-status"], "running");
    // byId running=false 必须 ready（摘要行已移除，展示词表只由圆点承担）。
    assert.equal(byClass(inactiveShard, "deg_expert_group_status_icon")[0].props["data-status"], "ready");
    // byId 缺少布尔 running 时回退 DEG 元数据（Host 快照 running=false → ready，绝不猜 running）。
    const withoutRunning = sessionsSnapshot();
    delete withoutRunning.byId["running-child"].running;
    sessions.update(withoutRunning);
    await handle.settle();
    assert.equal(
      byClass(shardRow("running-shard"), "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "byId 没有布尔 running 时不得猜测运行状态",
    );
    const dots = walk(handle.output).filter((node) => node?.type === StateDot).map((dot) => dot.props.state);
    assert.ok(dots.includes("ongoing") && dots.includes("done"));
    // 管理状态仍按原始 fan-out 状态暴露，未被 running|ready 取代。
    const fanoutContainer = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(fanoutContainer.props["data-task-status"], "running");
    // 该分片展示状态是 ready（byId running=false），但管理状态仍是 running，
    // 因此取消动作必须照常出现——展示词表不得替换管理判定。
    assert.ok(
      walk(handle.output).some((node) => node?.props?.["aria-label"] === "取消分片 failed-shard"),
      "管理状态为 running 的分片必须保留取消动作",
    );
    assert.equal(
      walk(handle.output).some((node) => node?.props?.["aria-label"] === "重试分片 failed-shard"),
      false,
      "取消/重试仍按原始管理状态判定",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("官方 StateDot 缺失时退化为静态圆点，仍只出现 running/ready", async () => {
  const mounted = mountPanel({ primitives: {} });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const dots = walk(handle.output).filter((node) => node?.props?.className === "deg_expert_group_state_dot");
    assert.ok(dots.length > 0, "没有 StateDot 时才使用兼容兜底");
    assert.deepEqual([...new Set(dots.map((dot) => dot.props["data-state"]))].sort(), ["ready", "running"]);
    assert.ok(dots.every((dot) => dot.props["aria-hidden"] === "true"));
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("图标词表：具名图标缺失时兜底到 alpha.2 存在的 IconWarningOutlineRegular，绝不 createElement(undefined)", async () => {
  // 只提供兜底图标：所有具名图标（折叠箭头等）都走 makeIcon 的兜底链。
  // 兜底名必须是 0.1.7-alpha.2 存在的导出，否则 makeIcon 会拿到 undefined 并渲染成
  // createElement(undefined)——这里用替身自报身份（data-icon）证明兜底确实被取用。
  const FallbackWarning = function FallbackWarning(props) {
    return { type: "svg", props: { ...(props || {}), "data-icon": "warning-fallback" }, children: [] };
  };
  const mounted = mountPanel({ primitives: { IconWarningOutlineRegular: FallbackWarning } });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const chevrons = byClass(handle.output, "deg_expert_group_chevron");
    assert.ok(chevrons.length > 0, "折叠箭头按钮必须照常渲染");
    const icons = chevrons.map((chevron) => chevron.children?.[0]);
    assert.ok(
      icons.every((icon) => icon?.type !== undefined),
      "具名图标缺失时绝不渲染 createElement(undefined)",
    );
    assert.ok(
      icons.every((icon) => icon.props["data-icon"] === "warning-fallback"),
      "具名图标缺失时必须落回新的兜底图标（不是旧后缀名，也不是空元素）",
    );
    // 尺寸仍由既有 size prop 承载（改名不改变渲染尺寸）。
    assert.ok(icons.every((icon) => icon.props.size === 14), "折叠箭头必须保持原有的 size: 14");
    // 命中的具名图标优先于兜底：提供具名折叠图标时不再走兜底。
    // 展开态用 ChevronDown、折叠态用 ChevronRight，因此两个具名图标都要给出才能覆盖所有箭头。
    const namedIcon = (name) => (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": name }, children: [] });
    const named = mountPanel({
      primitives: {
        IconWarningOutlineRegular: FallbackWarning,
        IconChevronDownOutlineRegular: namedIcon("named-down"),
        IconChevronRightOutlineRegular: namedIcon("named-right"),
      },
    });
    try {
      await named.handle.settle();
      const namedIcons = byClass(named.handle.output, "deg_expert_group_chevron").map((chevron) => chevron.children?.[0]);
      assert.ok(namedIcons.length > 0, "折叠箭头必须照常渲染");
      assert.ok(
        namedIcons.every((icon) => String(icon.props["data-icon"]).startsWith("named-")),
        "具名图标存在时必须优先使用具名图标，兜底不得覆盖它",
      );
    } finally {
      named.handle.unmount();
      named.restore();
    }
    assert.equal(named.intervals.active, 0);
    // 兜底名本身缺失（宿主未导出任何图标）时只降级为「不渲染图标」，绝不抛错。
    const withoutAny = mountPanel({ primitives: {} });
    try {
      await withoutAny.handle.settle();
      assert.deepEqual(withoutAny.handle.cleanupErrors, [], "图标全缺时渲染不得产生清理期异常");
    } finally {
      withoutAny.handle.unmount();
      withoutAny.restore();
    }
    assert.equal(withoutAny.intervals.active, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("图标词表：专家提示词查看器使用新的 IconBrowseOutlineRegular（不再引用旧后缀名）", () => {
  // 提示词查看器（FullSystemPromptNode）通过 primitives.DisclosureRow 的 icon prop 渲染浏览图标；
  // 这里只断言源码引用了 alpha.2 的新导出名（真实的渲染尺寸由 size prop 承载，保持 14）。
  assert.match(clientSource, /primitives\.IconBrowseOutlineRegular/);
  assert.equal(clientSource.includes("IconBrowseOutline16"), false, "旧后缀名必须彻底消失");
});

test("轮询失败保留最后快照并提供标题重试", async () => {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  let shouldFail = false;
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture(),
    async requestPluginRpc() {
      if (shouldFail) throw new Error("transport failed");
      return { snapshot: snapshot() };
    },
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-1" }, ctx: {} });
  try {
    await handle.settle();
    // 摘要行已移除：用仍然上屏的任务树证据（任务名 + 元数据）证明首屏快照已渲染。
    assert.ok(textOf(handle.output).includes("运行专家"), "首屏快照的任务树必须上屏");
    assert.equal(textOf(byClass(handle.output, "deg_expert_group_row_main")[0]), "主代理Orchestrator · A6 · gpt-5.6-sol · Xhigh");
    shouldFail = true;
    await intervals.tick();
    await handle.settle();
    assert.ok(textOf(handle.output).includes("运行专家"), "错误后不得清空最后有效快照");
    assert.equal(textOf(byClass(handle.output, "deg_expert_group_row_main")[0]), "主代理Orchestrator · A6 · gpt-5.6-sol · Xhigh", "缓存快照的任务树必须原样保留");
    assert.ok(textOf(handle.output).includes("快照读取失败"));
    assert.ok(walk(handle.output).some((node) => node?.props?.["aria-label"] === "重试"));
  } finally {
    handle.unmount();
    restore();
  }
});

/**
 * 轮询内容比较：真实 Host 每次响应都是全新的归一化对象，而且顶层 generatedAt 每次都填
 * 新的 Date.now()（见 index.js 的投影），因此「引用不同」绝不能当成「内容变了」。
 *
 * 断言用渲染次数（确定性计数，不依赖计时）：大任务树空闲时，2.5s 轮询不得产生任何重渲染；
 * 真实变化必须照常上屏——内容比较只允许省掉「没有变化」的那一次更新。
 */
test("轮询返回内容不变时零重渲染，内容变化时照常上屏", async () => {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  let hostSnapshot = snapshot();
  let requestCount = 0;
  /** 票据 15 之后一轮自动轮询 = 1 次事件探测 + （必要时）1 次快照；替身对任何 action 都回同一份载荷，
   * 事件读面因此不可判定，面板按既有全量语义降级——这里按 action 分别计数，断言各自真的发出。 */
  const counts = { events: 0, snapshot: 0 };
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture([]),
    async requestPluginRpc(_connection, request) {
      requestCount += 1;
      if (request?.action === "fanout-events") counts.events += 1;
      else counts.snapshot += 1;
      // 每次响应都返回一份全新对象，且 generatedAt 逐次变化：等价于真实 Host 的投影。
      const generatedAt = requestCount;
      return { ok: true, async json() { return { snapshot: { ...hostSnapshot, generatedAt } }; } };
    },
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-1" }, ctx: { connection: {} } });
  try {
    await handle.settle();
    assert.ok(textOf(handle.output).includes("运行专家"), "首屏快照必须上屏");
    const rendersAfterFirstLoad = handle.renderCount;
    assert.ok(rendersAfterFirstLoad >= 2, "首屏至少经历「骨架 → 上屏」两次渲染");

    // 连续三个轮询周期返回内容相同的全新对象：请求照发，但不得产生任何重渲染。
    for (let round = 0; round < 3; round += 1) {
      await intervals.tick();
      await handle.settle();
    }
    assert.equal(counts.snapshot, 4, "轮询确实继续发起快照 RPC（1 次首屏 + 3 次轮询降级）");
    assert.equal(counts.events, 3, "每轮自动轮询都先探测一次事件（票据 15）");
    assert.equal(handle.renderCount, rendersAfterFirstLoad, "内容不变的轮询不得触发重渲染");

    // 内容真的变化（同一份树的浅层字段）：必须照常上屏，比较绝不吞掉真实变化。
    const changed = snapshot();
    changed.root.children[0] = { ...changed.root.children[0], taskName: "运行专家 轮询更新" };
    hostSnapshot = changed;
    await intervals.tick();
    await handle.settle();
    assert.ok(handle.renderCount > rendersAfterFirstLoad, "内容变化必须重渲染");
    assert.ok(textOf(handle.output).includes("运行专家 轮询更新"), "变化后的内容必须上屏");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("child surface 上的面板仍按所属 root 读取并渲染同一份 Expert Group 快照", async () => {
  const mounted = mountPanel({
    scopeSessionId: "child-1",
    // 与真实 Host 同契约：child 子代理会话沿 parentId 找到所属 root。
    resolveRootSessionId: (sessionId) => (sessionId === "child-1" ? "root-1" : sessionId),
  });
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 当前 surface 是 child，但快照只能按所属 root 请求：RPC 的 sessionId 必须是 root-1。
    assert.deepEqual(requests.map((request) => request.sessionId), ["root-1"]);
    // 渲染的是同一棵以「主代理」为第一行的树，不因 surface 是 child 而改变。
    const rootRow = byClass(handle.output, "deg_expert_group_row_main").find((row) => row.props["data-kind"] === "root");
    assert.equal(textOf(byClass(rootRow, "deg_expert_group_task")[0]), "主代理");
    assert.equal(byClass(handle.output, "deg_expert_group_node_root").length, 1);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("连续会话通知只保留一个在途请求和一次尾随刷新", async () => {
  const deferred = [];
  const mounted = mountPanel({
    requestPluginRpc(_connection, request, init) {
      return new Promise((resolve) => deferred.push({ request, init, resolve }));
    },
  });
  const { handle, requests, sessions, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(requests.length, 1, "挂载时保留一次首屏请求");
    assert.ok(deferred[0].init?.signal, "请求应携带可取消信号");

    // 模拟切换会话时 sessions 连续发布多个快照；在途期间不应继续放大 RPC 数量。
    for (let index = 0; index < 10; index += 1) sessions.update(sessionsSnapshot());
    assert.equal(requests.length, 1, "通知风暴期间只保留一个在途请求");

    deferred[0].resolve({ ok: true, async json() { return { snapshot: snapshot() }; } });
    await handle.settle();
    assert.equal(requests.length, 2, "首个请求完成后最多补发一次尾随刷新");

    deferred[1].resolve({ ok: true, async json() { return { snapshot: snapshot() }; } });
    await handle.settle();
  } finally {
    handle.unmount();
    restore();
  }
});

test("页面隐藏时跳过轮询刷新", async () => {
  const restoreDocument = installGlobals({ document: { hidden: true } });
  const mounted = mountPanel();
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    const initialRequests = requests.length;
    await intervals.tick();
    assert.equal(requests.length, initialRequests, "隐藏页面不应继续发起轮询 RPC");
  } finally {
    handle.unmount();
    restore();
    restoreDocument();
  }
});

test("切换根会话时取消旧请求并拒绝旧快照上屏", async () => {
  const deferred = [];
  const mounted = mountPanel({
    requestPluginRpc(_connection, request, init) {
      return new Promise((resolve) => deferred.push({ request, init, resolve }));
    },
  });
  const { handle, requests, sessions, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(requests[0].sessionId, "root-1");

    const nextSessions = sessionsSnapshot();
    nextSessions.current = "root-2";
    nextSessions.byId["root-2"] = { id: "root-2", title: "新根任务标题", displayTitle: "root-2" };
    sessions.update(nextSessions);
    handle.rerender({ scope: { sessionId: "root-2" } });
    assert.equal(requests[1].sessionId, "root-2");
    assert.equal(deferred[0].init.signal.aborted, true, "切换根会话应取消旧请求");
    // 根行第一行固定「主代理」，会话标题不再上屏：用任务树的可见性判断是否仍显示旧树。
    assert.equal(byClass(handle.output, "deg_expert_group_row_main").length, 0, "新会话等待期间不得显示旧树");

    deferred[0].resolve({ ok: true, async json() { return { snapshot: snapshot() }; } });
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_row_main").length, 0, "旧响应不得覆盖新会话");

    const next = snapshot();
    next.rootSessionId = "root-2";
    next.root = { ...next.root, id: "root-2", sessionId: "root-2", taskName: "新根任务标题" };
    // 新快照换一棵可识别的树：根任务名不再展示，任务树内容是「新会话已上屏」的唯一可见证据。
    next.root.children = [{
      id: "expert-new-root", kind: "expert", sessionId: "expert-new-root", taskName: "新根会话专家",
      role: "fixer", status: "ready",
    }];
    deferred[1].resolve({ ok: true, async json() { return { snapshot: next }; } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("新根会话专家"), true, "新会话响应应正常上屏");
  } finally {
    handle.unmount();
    restore();
  }
});

/**
 * RPC adapter 协议回归替身。
 *
 * 直接注入未包装的 adapter（函数形态由用例自己决定），因此可以验证「协议判定只看注入侧
 * 声明、与 adapter 的函数形态无关」这条契约本身。connection 由用例持有，便于断言面板
 * 透传下去的就是 ctx 上那一个——Connection / legacy fetch 的分流仍由 adapter 自己决定。
 */
function mountAdapterPanel({ adapter, rpcAdapterProtocol, connection = { rpc: { call: async () => ({ ok: true }) } } } = {}) {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture([]),
    confirm() { return true; },
    rpcAdapterProtocol,
    requestPluginRpc: adapter,
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-1" }, ctx: { connection } });
  return { runtime, intervals, restore, connection, handle };
}

/** fetch-like 成功 envelope 替身：与 Connection 归一结果同形状。 */
function snapshotEnvelope(body = snapshot()) {
  return { ok: true, async json() { return { snapshot: body }; } };
}

test("协议判定不再读取 Function.length：源码里不存在 arity 猜测分支", () => {
  assert.equal(
    sidebarSource.includes("fn.length"),
    false,
    "被调用函数的 length 会随默认参数/rest/bind/wrapper 变化，不能作为协议判定依据",
  );
  assert.ok(
    sidebarSource.includes("rpcAdapterProtocol"),
    "调用约定必须由注入侧显式声明（capability），而不是靠函数形态推测",
  );
});

test("未声明协议即 v1 connection-first：默认参数、rest、bind、wrapper 四种形态收到完全相同的实参", async () => {
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const calls = [];
  const record = (shape, argv) => { calls.push({ shape, argv }); return snapshotEnvelope(); };
  /**
   * 四种形态的 Function.length 分别是 2 / 0 / 0 / 0（bind(null) 保留原 length）。
   * 旧实现按 length >= 2 判定，后三种都会翻到 request-first；新实现不读 length，
   * 一律按 v1 connection-first 调用。
   */
  const shapes = [
    ["默认参数", function requestPluginRpc(connectionArg, request, init = {}) { return record("默认参数", [connectionArg, request, init]); }],
    ["rest", function requestPluginRpc(...argv) { return record("rest", argv); }],
    ["bind", ((...argv) => record("bind", argv)).bind(null)],
    ["wrapper", (...argv) => record("wrapper", argv)],
  ];
  for (const [shape, adapter] of shapes) {
    const mounted = mountAdapterPanel({ adapter, connection });
    try {
      await mounted.handle.settle();
    } finally {
      mounted.handle.unmount();
      mounted.restore();
    }
    assert.equal(mounted.intervals.active, 0);
    assert.equal(calls.at(-1).shape, shape);
  }
  assert.equal(calls.length, 4, "每种形态只应发出一次首屏 RPC");
  for (const { shape, argv } of calls) {
    assert.equal(argv.length, 3, shape + " 必须收到完整的位置参数三件套");
    assert.equal(argv[0], connection, shape + " 的第一个实参必须是 ctx.connection");
    assert.equal(argv[1].action, "expert-group-snapshot", shape + " 的第二个实参必须是请求体");
    assert.equal(argv[1].sessionId, "root-1");
    assert.equal(argv[2]?.signal?.aborted, false, shape + " 的第三个实参必须是可取消的 init");
  }
});

test("声明 object 协议的新 adapter 收到单一对象参数，bind 后的函数形态同样生效", async () => {
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const calls = [];
  const adapter = function requestPluginRpc(args) { calls.push(args); return snapshotEnvelope(); };
  // bind 只改变函数对象的形态（length/name），不参与协议判定：判定只读注入侧声明。
  const mounted = mountAdapterPanel({ adapter: adapter.bind(null), rpcAdapterProtocol: "object", connection });
  try {
    await mounted.handle.settle();
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ["connection", "init", "request"], "对象参数只带这三个具名字段");
    assert.equal(calls[0].connection, connection);
    assert.equal(calls[0].request.action, "expert-group-snapshot");
    assert.equal(calls[0].request.sessionId, "root-1");
    assert.equal(calls[0].init.signal.aborted, false, "对象参数同样必须透传可取消 init");
    assert.ok(textOf(mounted.handle.output).includes("运行专家"), "对象协议下的快照照常上屏");
    assert.equal(byClass(mounted.handle.output, "deg_expert_group_error").length, 0);
  } finally {
    mounted.handle.unmount();
    mounted.restore();
  }
  assert.equal(mounted.intervals.active, 0);
});

test("旧签名兼容边界：未声明即 v1 connection-first，request-first 只有显式声明才生效", async () => {
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const calls = [];
  const adapter = function requestPluginRpc(...argv) { calls.push(argv); return snapshotEnvelope(); };

  // 未声明：client-entry.js 注入的 requestPluginRpc 正是 connection-first 形状，历史宿主无需改动。
  const undeclared = mountAdapterPanel({ adapter, connection });
  try {
    await undeclared.handle.settle();
  } finally {
    undeclared.handle.unmount();
    undeclared.restore();
  }
  assert.equal(undeclared.intervals.active, 0);

  // 显式声明 request-first：旧实现只能靠 arity 猜出来的另一种最小约定，现在必须声明。
  const requestFirst = mountAdapterPanel({ adapter, rpcAdapterProtocol: "request-first", connection });
  try {
    await requestFirst.handle.settle();
  } finally {
    requestFirst.handle.unmount();
    requestFirst.restore();
  }
  assert.equal(requestFirst.intervals.active, 0);

  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], connection, "未声明协议必须按 v1 connection-first 调用");
  assert.equal(calls[0][1].action, "expert-group-snapshot");
  assert.equal(calls[1][0].action, "expert-group-snapshot", "显式 request-first 才把请求体放在第一个实参");
  assert.equal(calls[1][1], connection);
  assert.equal(calls[1][2].signal.aborted, false);
});

test("协议标识边界：空白声明按 v1 默认，未知或非字符串声明 fail-closed 明确拒绝", async () => {
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const calls = [];
  const adapter = function requestPluginRpc(...argv) { calls.push(argv); return snapshotEnvelope(); };

  // 纯空白等同未声明：按 connection-first 调用，不抛错、不落错误面。
  const blank = mountAdapterPanel({ adapter, rpcAdapterProtocol: "   ", connection });
  try {
    await blank.handle.settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], connection);
    assert.equal(byClass(blank.handle.output, "deg_expert_group_error").length, 0);
  } finally {
    blank.handle.unmount();
    blank.restore();
  }
  assert.equal(blank.intervals.active, 0);

  // 未知协议：绝不猜测参数顺序，错误进入既有标题错误面并提供重试入口。
  const unknown = mountAdapterPanel({ adapter, rpcAdapterProtocol: "object-v2", connection });
  try {
    await unknown.handle.settle();
    assert.equal(calls.length, 1, "未知协议不得落到 adapter");
    const error = byClass(unknown.handle.output, "deg_expert_group_error")[0];
    assert.ok(error, "未知协议必须显示错误面");
    assert.match(error.props.title, /未知的 RPC adapter 协议：object-v2/);
    assert.ok(walk(unknown.handle.output).some((node) => node?.props?.["aria-label"] === "重试"), "明确拒绝同样可重试");
  } finally {
    unknown.handle.unmount();
    unknown.restore();
  }
  assert.equal(unknown.intervals.active, 0);

  // 非字符串标识同样是显式拒绝，而不是静默回落到某个位置约定。
  const invalid = mountAdapterPanel({ adapter, rpcAdapterProtocol: 1, connection });
  try {
    await invalid.handle.settle();
    assert.equal(calls.length, 1);
    const error = byClass(invalid.handle.output, "deg_expert_group_error")[0];
    assert.ok(error);
    assert.match(error.props.title, /协议标识必须是字符串/);
  } finally {
    invalid.handle.unmount();
    invalid.restore();
  }
  assert.equal(invalid.intervals.active, 0);
});

test("adapter 同步抛错、Promise reject、错误 envelope 共用同一条错误面，重试成功后恢复", async () => {
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const calls = [];
  let mode = "throw";
  const adapter = function requestPluginRpc(args) {
    calls.push(args);
    if (mode === "throw") throw new Error("适配器同步抛错");
    if (mode === "reject") return Promise.reject(new Error("适配器异步拒绝"));
    if (mode === "error-envelope") return { ok: false, error: { message: "宿主拒绝请求" } };
    if (mode === "value") return { ok: true, value: { snapshot: snapshot() } };
    return snapshotEnvelope();
  };
  const mounted = mountAdapterPanel({ adapter, rpcAdapterProtocol: "object", connection });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].connection, connection, "抛错路径上的协议判定同样不受函数形态影响");
    assert.equal(byClass(handle.output, "deg_expert_group_error")[0].props.title, "适配器同步抛错");

    mode = "reject";
    await intervals.tick();
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_error")[0].props.title, "适配器异步拒绝");

    mode = "error-envelope";
    await intervals.tick();
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_error")[0].props.title, "宿主拒绝请求", "结构化错误必须原样冒泡");

    // { value: { snapshot } } 与 fetch-like json() 两条成功 envelope 语义都必须照常上屏。
    mode = "value";
    await intervals.tick();
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_error").length, 0, "成功响应必须清掉标题错误面");
    assert.ok(textOf(handle.output).includes("运行专家"), "成功快照必须上屏");

    mode = "ok";
    await intervals.tick();
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_error").length, 0);
    assert.ok(textOf(handle.output).includes("运行专家"));
    assert.equal(
      calls.filter((call) => call.request?.action === "expert-group-snapshot").length,
      5,
      "每次轮询恰好一次快照请求（首屏 + 4 轮降级全量）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 指定 root 的 Host 快照投影：专家行名字带上 root 标识，用于断言「命中的是哪个 root 的缓存」。
 * 只改展示字段，schemaVersion/结构不变，normalize 语义与真实 Host 一致。
 */
function snapshotForRoot(rootId, expertName = "运行专家 " + rootId) {
  const base = snapshot();
  return {
    ...base,
    rootSessionId: rootId,
    root: {
      ...base.root,
      id: rootId,
      sessionId: rootId,
      children: base.root.children.map((child, index) => (index === 0 ? { ...child, taskName: expertName } : child)),
    },
  };
}

/**
 * 「同一个 createExpertGroupPanel 返回的 Panel 函数、多次挂载」的会话替身。
 *
 * 真实 DSH 的 keyed session surface 在切换会话时可能卸载旧 Panel 实例、再用**同一个** Panel
 * 函数挂载新实例（截图里的闪烁就发生在这一次重新挂载上），所以缓存必须挂在
 * createExpertGroupPanel 的闭包上才能跨实例共享；这里因此只创建一个 Panel 并允许反复
 * mount/unmount。RPC 由用例显式放行（holdRpc），不依赖任何真实等待。
 */
function createPanelSession(overrides = {}) {
  const runtime = overrides.runtime ?? createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const requests = [];
  let hold = null;
  let hostSnapshot = overrides.hostSnapshot ?? snapshot();
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: overrides.primitives ?? {},
    sessions: overrides.sessions ?? sessionsFixture([]),
    storage: overrides.storage,
    resolveRootSessionId: overrides.resolveRootSessionId,
    confirm() { return true; },
    async requestPluginRpc(_connection, request) {
      requests.push(request);
      if (hold !== null) await hold;
      return { ok: true, async json() { return { snapshot: hostSnapshot }; } };
    },
  });
  return {
    Panel,
    runtime,
    requests,
    intervals,
    restore,
    /** 挂载一次（等价于宿主新建一个 Panel 实例并立即 commit）：同步返回渲染会话。 */
    mount(sessionId = "root-1") {
      return runtime.render(Panel, { scope: { sessionId }, ctx: { connection: {} } });
    },
    /** 让接下来的 RPC 全部挂起，返回放行函数：用于观察「RPC 还没返回时的首屏」。 */
    holdRpc() {
      let release;
      hold = new Promise((resolve) => { release = resolve; });
      return () => { hold = null; release(); };
    },
    setHostSnapshot(next) { hostSnapshot = next; },
  };
}

test("同一 Panel 函数重新挂载同一 root 时首屏直接用缓存快照，不再闪两条 skeleton", async () => {
  const session = createPanelSession();
  try {
    // 第一次挂载：闭包里还没有任何缓存，必须保留原有的两条 skeleton（首次加载语义不变）。
    session.setHostSnapshot(snapshotForRoot("root-1"));
    const first = session.mount("root-1");
    assert.equal(byClass(first.output, "deg_expert_group_skeleton").length, 2, "真正首次访问仍必须显示两条 skeleton");
    await first.settle();
    assert.equal(byClass(first.output, "deg_expert_group_skeleton").length, 0, "首屏 RPC 成功后 skeleton 消失");
    assert.ok(textOf(first.output).includes("运行专家 root-1"), "任务树正常上屏");
    first.unmount();

    // 第二次挂载：同一个 Panel 函数、同一个 root-1，但 RPC 故意挂起不返回
    // （真实宿主切换 surface 后 RPC 需要时间，这正是出现两条灰色占位块的窗口）。
    const releaseSecond = session.holdRpc();
    const second = session.mount("root-1");
    assert.equal(byClass(second.output, "deg_expert_group_skeleton").length, 0, "重新挂载同一 root 不得再闪 skeleton");
    assert.ok(textOf(second.output).includes("运行专家 root-1"), "缓存快照必须直接渲染出原任务树");

    // 放行第二次 RPC：新快照上屏并替换缓存，全程不出现 skeleton。
    session.setHostSnapshot(snapshotForRoot("root-1", "运行专家 新快照"));
    releaseSecond();
    await second.settle();
    assert.equal(byClass(second.output, "deg_expert_group_skeleton").length, 0, "新快照上屏同样不出现 skeleton");
    assert.ok(textOf(second.output).includes("运行专家 新快照"), "第二次 RPC 的新快照必须替换内容");
    second.unmount();

    // 第三次挂载：缓存已被第二次的成功响应更新，首屏直接是新快照。
    const releaseThird = session.holdRpc();
    const third = session.mount("root-1");
    assert.equal(byClass(third.output, "deg_expert_group_skeleton").length, 0, "缓存必须随成功响应更新后继续命中");
    assert.ok(textOf(third.output).includes("运行专家 新快照"), "首屏显示最近一次成功快照");
    assert.ok(session.requests.length >= 3, "每次挂载仍必须发起后台刷新 RPC（缓存只解决首屏）");
    releaseThird();
    await third.settle();
    third.unmount();
  } finally {
    session.restore();
  }
});

test("快照缓存按 root 隔离：没有缓存的 root 仍然显示 skeleton，绝不显示别的 root 的树", async () => {
  const session = createPanelSession();
  try {
    session.setHostSnapshot(snapshotForRoot("root-1"));
    const first = session.mount("root-1");
    await first.settle();
    assert.ok(textOf(first.output).includes("运行专家 root-1"));
    first.unmount();

    // root-2 从未成功加载过：首屏必须是 skeleton，且绝不能显示 root-1 的树。
    const release = session.holdRpc();
    const second = session.mount("root-2");
    assert.equal(byClass(second.output, "deg_expert_group_skeleton").length, 2, "未缓存的 root 仍显示两条 skeleton");
    assert.equal(textOf(second.output).includes("运行专家 root-1"), false, "绝不把旧 root 的内容显示到新 root");

    session.setHostSnapshot(snapshotForRoot("root-2"));
    release();
    await second.settle();
    assert.ok(textOf(second.output).includes("运行专家 root-2"), "放行后新 root 的快照正常上屏");
    assert.equal(textOf(second.output).includes("运行专家 root-1"), false, "新 root 上屏后也不得残留旧 root 内容");
    second.unmount();
  } finally {
    session.restore();
  }
});

test("快照缓存有明确上限与 LRU：超过 32 个 root 后最久未用的缓存被淘汰", async () => {
  const session = createPanelSession();
  try {
    // 依次挂载 33 个不同 root，每个都成功拿到快照：缓存只保留最近 32 个。
    for (let index = 1; index <= 33; index += 1) {
      const rootId = "root-" + index;
      session.setHostSnapshot(snapshotForRoot(rootId));
      const mounted = session.mount(rootId);
      await mounted.settle();
      assert.ok(textOf(mounted.output).includes("运行专家 " + rootId), rootId + " 的首屏应显示自己的快照");
      mounted.unmount();
    }

    // 最久未用的 root-1 已被淘汰：重新挂载时回到首次加载的 skeleton。
    const release = session.holdRpc();
    const evicted = session.mount("root-1");
    assert.equal(byClass(evicted.output, "deg_expert_group_skeleton").length, 2, "被淘汰的 root 必须回到首次加载 skeleton");
    assert.equal(textOf(evicted.output).includes("运行专家 root-1"), false, "被淘汰的 root 不得再显示旧内容");
    evicted.unmount();

    // 最近使用的 root-33 仍在缓存里：重新挂载首屏直接显示任务树。
    const cached = session.mount("root-33");
    assert.equal(byClass(cached.output, "deg_expert_group_skeleton").length, 0, "最近使用的 root 必须命中缓存");
    assert.ok(textOf(cached.output).includes("运行专家 root-33"), "命中缓存直接显示最近一次成功快照");
    release();
    cached.unmount();
  } finally {
    session.restore();
  }
});

/**
 * 渲染纯性（缓存 LRU 顺序）。
 *
 * 老实现的首屏状态计算会调用「命中即重排」的 LRU 读函数：它被放在渲染体里，
 * 因此在**每一次**渲染（StrictMode 还会把同一次渲染调用两遍）都对缓存做一次 delete+set 重排；
 * 视图回退分支（state.rootSessionId !== rootSessionId）更是每帧空转重排。渲染期的副作用是
 * React 明令禁止的，这里的断言方式是完全可观察的：一个只被「视图回退分支渲染」过、却始终
 * 没被成功拉取过的 root，绝不能顶掉别的 root 的 LRU 位置。
 *
 * 具体编排：先铺满 32 条缓存（A1 最旧、A32 最新），然后挂一个未缓存的 A0 并切到 A1
 * （视图回退分支逐帧读取 A1 的缓存快照），再放进第 33 条缓存 —— 若渲染重排了 LRU，
 * A1 会被顶到队首、改由 A2 被淘汰；正确实现下 A1 仍是队首、必须第一个被淘汰。
 */
test("渲染期不重排快照缓存 LRU：只被渲染过的 root 仍是最先被淘汰的那个", async () => {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  // 被挂起的 root（只在需要观察「仅渲染、不拉取」的窗口里启用）：其快照请求一直不返回，
  // 因此不会写缓存、也不会提权，只留下「渲染读取」这一条路径。
  const held = new Set();
  const heldResolvers = new Map();
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture([]),
    confirm() { return true; },
    async requestPluginRpc(_connection, request) {
      if (held.has(request.sessionId)) {
        await new Promise((resolve) => { heldResolvers.set(request.sessionId, resolve); });
      }
      // 每个 root 的快照各自独立：避免放行某个 root 时把别的 root 的内容写进它的缓存。
      return { ok: true, async json() { return { snapshot: snapshotForRoot(request.sessionId) }; } };
    },
  });
  const mountScope = (sessionId) => runtime.render(Panel, { scope: { sessionId }, ctx: { connection: {} } });
  try {
    // 1) 铺满缓存：A1 最旧、A32 最新（每次成功响应写入并提权）。
    for (let index = 1; index <= 32; index += 1) {
      const rootId = "A" + index;
      const mounted = mountScope(rootId);
      await mounted.settle();
      assert.ok(textOf(mounted.output).includes("运行专家 " + rootId), rootId + " 的首屏应显示自己的快照");
      mounted.unmount();
    }

    // 2) 挂一个未缓存的 A0（RPC 挂起，不写缓存），再切到已缓存的 A1：视图回退分支逐帧
    //    渲染 A1 的缓存快照（这是首帧不闪 skeleton 的既有契约）。连续 rerender 两次等价于
    //    React 严格模式对同一次渲染的双重调用。
    held.add("A0");
    held.add("A1");
    const panel = mountScope("A0");
    assert.equal(byClass(panel.output, "deg_expert_group_skeleton").length, 2, "未缓存的 root 首屏仍是两条 skeleton");
    panel.rerender({ scope: { sessionId: "A1" } });
    panel.rerender({ scope: { sessionId: "A1" } });
    assert.ok(textOf(panel.output).includes("运行专家 A1"), "视图回退分支仍必须命中缓存首帧渲染");
    await panel.settle();
    assert.ok(textOf(panel.output).includes("运行专家 A1"), "挂起期间继续显示目标 root 的缓存快照");

    // 3) 放进第 33 条缓存：被淘汰的必须仍然是最旧的 A1。
    const added = mountScope("A33");
    await added.settle();
    assert.ok(textOf(added.output).includes("运行专家 A33"), "新 root 正常上屏");
    added.unmount();

    const evicted = mountScope("A1");
    assert.equal(byClass(evicted.output, "deg_expert_group_skeleton").length, 2, "只被渲染过的 A1 必须仍是最先被淘汰的那个");
    assert.equal(textOf(evicted.output).includes("运行专家 A1"), false, "被淘汰的 root 不得再显示旧内容");
    evicted.unmount();

    // 4) A2 是原来的第二旧、不是淘汰对象：重新挂载必须命中缓存（若渲染重排过 LRU，被淘汰的会是它）。
    const cached = mountScope("A2");
    assert.equal(byClass(cached.output, "deg_expert_group_skeleton").length, 0, "第二旧的 root 仍在缓存里");
    assert.ok(textOf(cached.output).includes("运行专家 A2"), "命中缓存直接显示任务树");
    cached.unmount();
    panel.unmount();
  } finally {
    // 放行所有挂起的响应，避免请求悬挂到用例之外（此时面板已卸载，成功路径不会再写状态）。
    for (const resolve of heldResolvers.values()) resolve();
    heldResolvers.clear();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 单分片 Host 快照替身。
 *
 * 只保留一个 fan-out 分片，把「一次点击 → 一次请求」的断言限定在唯一目标上，
 * 避免同一份快照里第二个可取消分片干扰计数。active=true 是 running（可取消），
 * false 是 failed（可重试）；两种管理状态互斥，动作按钮也互斥。
 */
function singleShardSnapshot(active = true) {
  const base = snapshot();
  const status = active ? "running" : "failed";
  return {
    ...base,
    root: {
      ...base.root,
      children: [{
        id: "fan-1", kind: "fanout", parentTaskId: "fan-1", role: "fixer", status,
        shards: [{
          shardId: "only-shard", prompt: "单分片提示", role: "fixer", status,
          childId: "shard-child", attempts: [{ attempt: 1, status, childId: "shard-child" }],
        }],
      }],
    },
  };
}

/** 按 aria-label 精确查找动作按钮（renderAction 的标签在 pending 时带「（处理中）」后缀）。 */
function actionByLabel(handle, label) {
  return walk(handle.output).find((node) => node?.props?.["aria-label"] === label);
}

/** 在单分片快照上附加逐动作能力（票据 09）；undefined 表示该层没有 capabilities 字段。 */
function singleShardSnapshotWithCapabilities({ active = true, task, shard } = {}) {
  const base = singleShardSnapshot(active);
  const fan = base.root.children[0];
  return {
    ...base,
    root: {
      ...base.root,
      children: [{
        ...fan,
        ...(task === undefined ? {} : { capabilities: task }),
        shards: [{
          ...fan.shards[0],
          ...(shard === undefined ? {} : { capabilities: shard }),
        }],
      }],
    },
  };
}

test("票据 09：侧栏严格按能力渲染取消/重试按钮，缺失或非法能力回退旧状态推导", async () => {
  // ① 能力允许：运行中的分片/父任务都渲染取消；重试因 task_not_terminal 不渲染。
  const allowed = mountPanel({
    hostSnapshot: singleShardSnapshotWithCapabilities({
      task: {
        read: { allowed: true },
        cancel: { allowed: true },
        retry: { allowed: false, reason: "task_not_terminal" },
        continue: { allowed: false, reason: "task_not_terminal" },
      },
      shard: {
        cancel: { allowed: true },
        retry: { allowed: false, reason: "task_not_terminal" },
      },
    }),
  });
  try {
    await allowed.handle.settle();
    assert.ok(actionByLabel(allowed.handle, "取消分片 only-shard"), "能力允许时必须渲染取消");
    assert.ok(actionByLabel(allowed.handle, "取消父任务（未完成 1 个分片）"), "父任务能力允许时必须渲染取消");
    assert.equal(actionByLabel(allowed.handle, "重试分片 only-shard"), undefined, "能力拒绝时不得渲染重试");
  } finally {
    allowed.handle.unmount();
    allowed.restore();
  }

  // ② 能力拒绝：即使分片/父任务状态是 running，也绝不渲染按钮（界面不承诺无法执行的写动作）。
  const denied = mountPanel({
    hostSnapshot: singleShardSnapshotWithCapabilities({
      task: {
        read: { allowed: true },
        cancel: { allowed: false, reason: "owner_not_live" },
        retry: { allowed: false, reason: "owner_not_live" },
        continue: { allowed: false, reason: "owner_not_live" },
      },
      shard: {
        cancel: { allowed: false, reason: "owner_not_live" },
        retry: { allowed: false, reason: "owner_not_live" },
      },
    }),
  });
  try {
    await denied.handle.settle();
    assert.equal(actionByLabel(denied.handle, "取消分片 only-shard"), undefined);
    assert.equal(actionByLabel(denied.handle, "取消父任务（未完成 1 个分片）"), undefined);
  } finally {
    denied.handle.unmount();
    denied.restore();
  }

  // ③ 失败分片 + 能力允许重试：重试按钮出现，且取消能力拒绝时不出现取消。
  // 该夹具是结算态（failed）fan-out，需求二下默认收起；先按用户方式展开再读动作按钮。
  const retryable = mountPanel({
    hostSnapshot: singleShardSnapshotWithCapabilities({
      active: false,
      shard: {
        cancel: { allowed: false, reason: "already_terminal" },
        retry: { allowed: true },
      },
    }),
    storage: new MemoryStorage(),
  });
  try {
    await retryable.handle.settle();
    await expandFanouts(retryable.handle);
    assert.ok(actionByLabel(retryable.handle, "重试分片 only-shard"), "能力允许时必须渲染重试");
    assert.equal(actionByLabel(retryable.handle, "取消分片 only-shard"), undefined);
  } finally {
    retryable.handle.unmount();
    retryable.restore();
  }

  // ④ 旧 Host：没有 capabilities 字段 → 回退既有状态推导（running 可取消、failed 可重试）。
  const legacy = mountPanel({ hostSnapshot: singleShardSnapshotWithCapabilities({}) });
  try {
    await legacy.handle.settle();
    assert.ok(actionByLabel(legacy.handle, "取消分片 only-shard"), "旧 Host 下 running 仍按旧行为可取消");
    assert.ok(actionByLabel(legacy.handle, "取消父任务（未完成 1 个分片）"));
  } finally {
    legacy.handle.unmount();
    legacy.restore();
  }

  // ⑤ 非法能力形状（allowed 不是布尔）等价于缺失 → 回退旧行为，不因畸形负载隐藏按钮。
  const malformed = mountPanel({
    hostSnapshot: singleShardSnapshotWithCapabilities({
      task: { cancel: { allowed: "yes" } },
      shard: { cancel: { allowed: 1 } },
    }),
  });
  try {
    await malformed.handle.settle();
    assert.ok(actionByLabel(malformed.handle, "取消分片 only-shard"), "非法能力不得获得权威，必须回退旧行为");
  } finally {
    malformed.handle.unmount();
    malformed.restore();
  }
});

test("票据 09：客户端能力归一拒绝任意负载，reason 截断且成功态不保留原因", () => {
  const model = globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
  assert.equal(typeof model.normalizeCapabilities, "function");
  const normalized = model.normalizeCapabilities({
    read: { allowed: true, reason: "stale" },
    cancel: { allowed: false, reason: "x".repeat(200) },
    retry: { allowed: "true" },
    continue: null,
    launch: { allowed: true },
  }, ["read", "cancel", "retry", "continue"]);
  assert.deepEqual(normalized, {
    read: { allowed: true },
    cancel: { allowed: false, reason: "x".repeat(64) },
  }, "只保留布尔 allowed 的动作，reason 截断，成功态不保留原因");
  assert.equal(model.normalizeCapabilities(null, ["cancel"]), null);
  assert.equal(model.normalizeCapabilities({ cancel: {} }, ["cancel"]), null);
  assert.equal(model.normalizeCapabilities("cancel", ["cancel"]), null);
});

test("确认弹窗打开期间重复点击：只弹一次确认、只发一次取消 RPC，拒绝确认后锁释放", async () => {
  // 受控确认：每次点击把 resolver 交给用例，弹窗一直挂着直到用例显式放行。
  const confirmGate = [];
  const mounted = mountPanel({
    hostSnapshot: singleShardSnapshot(true),
    confirm: () => new Promise((resolve) => confirmGate.push(resolve)),
  });
  const { handle, requests, confirms, intervals, restore } = mounted;
  try {
    await handle.settle();
    const first = actionByLabel(handle, "取消分片 only-shard");
    assert.ok(first, "运行中的分片必须提供取消动作");

    const pendingClick = first.props.onClick();
    // 占锁发生在发起确认之前，所以弹窗还开着时按钮已经进入 pending 态。
    await handle.settle();
    assert.equal(confirms.length, 1, "第一次点击只弹一次确认");

    // 双击的第二下 / 键盘重复触发：确认尚未返回。真实浏览器里按钮此时已被禁用，
    // 但同一帧内排队的第二次点击仍可能直接落到处理器上，因此这里显式调用验证「静默忽略」。
    const secondShot = actionByLabel(handle, "取消分片 only-shard（处理中）") ?? actionByLabel(handle, "取消分片 only-shard");
    assert.ok(secondShot, "按钮必须仍在渲染树里");
    secondShot.props.onClick();
    await handle.settle();
    assert.equal(confirms.length, 1, "重复点击不得弹出第二个确认");
    assert.equal(
      requests.filter((request) => request.action === "fanout-cancel-shard").length,
      0,
      "确认未返回前不得发出取消请求",
    );

    // 处理中的按钮同时必须禁用并暴露 aria-busy：正常情况下第二次点击压根到不了处理器。
    const armed = actionByLabel(handle, "取消分片 only-shard（处理中）");
    assert.ok(armed, "确认弹窗打开期间按钮必须显示处理中");
    assert.equal(armed.props.disabled, true, "处理中按钮必须禁用，浏览器不再接受第二次点击");
    assert.equal(armed.props["aria-busy"], true);

    confirmGate[0](true);
    await pendingClick;
    await handle.settle();
    const cancels = requests.filter((request) => request.action === "fanout-cancel-shard");
    assert.equal(cancels.length, 1, "一次确认只对应一次取消 RPC");
    assert.equal(cancels[0].shardId, "only-shard", "动作目标不变");
    const released = actionByLabel(handle, "取消分片 only-shard");
    assert.ok(released, "动作收尾后锁必须释放、按钮恢复可点");
    assert.equal(released.props.disabled, false);

    // 反向路径：用户在确认弹窗里取消（accepted=false）时既不发请求，也必须释放锁。
    const rejectedClick = released.props.onClick();
    await handle.settle();
    assert.equal(confirms.length, 2, "第二次点击是新的动作，允许再弹一次确认");
    confirmGate[1](false);
    await rejectedClick;
    await handle.settle();
    assert.equal(
      requests.filter((request) => request.action === "fanout-cancel-shard").length,
      1,
      "被拒绝的确认不得发出取消请求",
    );
    assert.ok(actionByLabel(handle, "取消分片 only-shard"), "被拒绝后锁同样必须释放");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("确认期间切换根会话：确认返回后动作绑定当前选中会话，不为旧 root 补发刷新", async () => {
  const confirmGate = [];
  const mounted = mountPanel({
    // 每个会话都回自己 root 的快照：切换后新会话照常渲染任务树。
    requestPluginRpc(_connection, request) {
      const body = singleShardSnapshot(true);
      body.rootSessionId = request.sessionId;
      body.root = { ...body.root, id: request.sessionId, sessionId: request.sessionId };
      return { ok: true, async json() { return { snapshot: body }; } };
    },
    confirm: () => new Promise((resolve) => confirmGate.push(resolve)),
  });
  const { handle, requests, confirms, sessions, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(requests[0].sessionId, "root-1");

    const pendingClick = actionByLabel(handle, "取消分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(confirms.length, 1);

    // 确认弹窗打开期间用户切到另一个根会话：同一个 Panel 实例按新 scope 重渲染，
    // 第一次点击时捕获的 rootSessionId（root-1）从这一刻起已经过期。
    const nextSessions = sessionsSnapshot();
    nextSessions.current = "root-2";
    nextSessions.byId["root-2"] = { id: "root-2", title: "新根任务标题", displayTitle: "root-2" };
    sessions.update(nextSessions);
    handle.rerender({ scope: { sessionId: "root-2" } });
    await handle.settle();
    assert.equal(
      requests.some((request) => request.action === "fanout-cancel-shard"),
      false,
      "确认未返回前不得发出动作请求",
    );
    // 切换之后（含动作的尾随刷新）不允许再出现任何指向旧 root 的请求。
    const mark = requests.length;

    confirmGate[0](true);
    await pendingClick;
    await handle.settle();
    const cancels = requests.filter((request) => request.action === "fanout-cancel-shard");
    assert.equal(cancels.length, 1);
    assert.equal(cancels[0].sessionId, "root-2", "取消动作必须绑定确认完成时选中的根会话");
    assert.equal(cancels[0].shardId, "only-shard", "动作目标本身不变");
    assert.deepEqual(
      requests.slice(mark).filter((request) => request.sessionId === "root-1"),
      [],
      "切换后不得再为旧 root 发请求（尾随刷新必须走最新渲染）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("确认弹窗期间组件卸载：确认返回后静默放弃，不补发动作请求", async () => {
  const confirmGate = [];
  const mounted = mountPanel({
    hostSnapshot: singleShardSnapshot(true),
    confirm: () => new Promise((resolve) => confirmGate.push(resolve)),
  });
  const { handle, requests, confirms, intervals, restore } = mounted;
  try {
    await handle.settle();
    const pendingClick = actionByLabel(handle, "取消分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(confirms.length, 1);
    const requestsBeforeUnmount = requests.length;
    handle.unmount();

    // 宿主的确认弹窗是模态：它可能在 surface 已经卸载之后才返回。
    confirmGate[0](true);
    await pendingClick;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      requests.filter((request) => request.action === "fanout-cancel-shard").length,
      0,
      "卸载后的确认必须静默放弃",
    );
    assert.equal(requests.length, requestsBeforeUnmount, "卸载后不得再发起任何请求");
    assert.deepEqual(handle.cleanupErrors, [], "卸载清理不得抛错");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("取消/重试 RPC 在途期间组件卸载：成功或失败都不得再发起迟到请求", async () => {
  /**
   * 挂载一次「重试动作 RPC 挂起」的面板：返回放行钩子与渲染会话。
   * 重试动作不需要确认，因此点击后 RPC 立即在途，可以在它未结算时卸载组件。
   */
  const mountPendingRetry = () => {
    const inFlight = [];
    const mounted = mountPanel({
      hostSnapshot: singleShardSnapshot(false),
      // 结算态（failed）fan-out 默认收起，需要一条可写存储让「展开」成为持久的 override。
      storage: new MemoryStorage(),
      requestPluginRpc(_connection, request) {
        if (request.action === "fanout-retry-shard") {
          return new Promise((resolve, reject) => inFlight.push({ resolve, reject }));
        }
        return { ok: true, async json() { return { snapshot: singleShardSnapshot(false) }; } };
      },
    });
    return { ...mounted, inFlight };
  };

  // 路径一：卸载后动作成功返回。旧实现会用过期闭包继续调用 refresh，卸载后凭空多出一次
  // 快照请求；新实现必须在 mountedRef 处收口。
  const successCase = mountPendingRetry();
  try {
    await successCase.handle.settle();
    await expandFanouts(successCase.handle);
    const retryButton = actionByLabel(successCase.handle, "重试分片 only-shard");
    assert.ok(retryButton, "失败分片必须提供重试动作");
    const pendingClick = retryButton.props.onClick();
    await successCase.handle.settle();
    assert.equal(successCase.inFlight.length, 1, "重试动作必须发出一次 RPC");
    const requestsBeforeUnmount = successCase.requests.length;
    successCase.handle.unmount();

    successCase.inFlight[0].resolve({ ok: true, async json() { return { snapshot: singleShardSnapshot(false) }; } });
    await pendingClick;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(successCase.requests.length, requestsBeforeUnmount, "卸载后不得再发起快照刷新");
    assert.deepEqual(successCase.handle.cleanupErrors, [], "卸载清理不得抛错");
  } finally {
    successCase.handle.unmount();
    successCase.restore();
  }
  assert.equal(successCase.intervals.active, 0);

  // 路径二：卸载后动作失败返回。既不得写错误面，也不得产生未处理的 rejection
  // （Node 测试运行器会把 unhandled rejection 记为用例失败，因此本断言具备实际约束力）。
  const failureCase = mountPendingRetry();
  try {
    await failureCase.handle.settle();
    await expandFanouts(failureCase.handle);
    const retryButton = actionByLabel(failureCase.handle, "重试分片 only-shard");
    const pendingClick = retryButton.props.onClick();
    await failureCase.handle.settle();
    assert.equal(failureCase.inFlight.length, 1);
    const requestsBeforeUnmount = failureCase.requests.length;
    failureCase.handle.unmount();

    failureCase.inFlight[0].reject(new Error("卸载后到达的失败"));
    await pendingClick;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failureCase.requests.length, requestsBeforeUnmount, "卸载后不得再发起快照刷新");
    assert.deepEqual(failureCase.handle.cleanupErrors, [], "卸载清理不得抛错");
  } finally {
    failureCase.handle.unmount();
    failureCase.restore();
  }
  assert.equal(failureCase.intervals.active, 0);
});

/**
 * ── 新 DSH 契约：uiWorkspace.openSession + sidebarRight.openResource ──────────────
 *
 * 新宿主的右栏导航入口是 `ctx.sidebarRight.openResource(address, options)`；当前宿主用
 * `ctx.sidebarRight.split()` 创建新 pane，再通过 `options.paneId` 定位资源。这里的基础夹具刻意
 * 不提供 split，覆盖旧宿主仍可接受的 `preferNewPane` 回退；双 pane 主契约由下一条用例单独验证。
 *
 * 下面每个用例都只提供这两个入口、**不提供 sessions.open**：旧回退不可用，因此任何导航调用
 * 都只能来自新契约（旧 DSH 的兼容路径由既有用例与「旧 DSH 兼容」用例覆盖）。
 */

/** 带宿主权威地址表的 sessions 替身：只对显式登记的 child 返回地址，其余触发目录兜底/不渲染箭头。 */
function addressedSessionsFixture(addresses = {}) {
  const state = { snapshot: sessionsSnapshot() };
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => state.snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    // 刻意不提供 open：新契约下不允许回退到旧接口。
    subagentAddress: (childId) => addresses[childId],
    update(next) { state.snapshot = next; for (const listener of [...listeners]) listener(); },
  };
}

/**
 * 双右箭头（未打开）与双左箭头（已打开、可关闭）各自的具名图标替身。
 *
 * 插件的 makeIcon 以普通函数方式调用 primitives 上的具名组件，返回的元素里看不到函数身份，
 * 因此这两个替身把自己「是谁」写进返回元素的 props（data-icon）：测试据此证明插件确实取用了
 * IconChevronRightOutlineRegular / IconChevronLeftOutlineRegular，而不是靠方向文案猜测。
 * 图标名按 0.1.7-alpha.2 词表（后缀是描边粗细，尺寸由 size prop 承载）。
 */
function sidebarRightArrowIcon(props) { return { type: "svg", props: { ...(props || {}), "data-icon": "chevron-right" }, children: [] }; }
function sidebarLeftArrowIcon(props) { return { type: "svg", props: { ...(props || {}), "data-icon": "chevron-left" }, children: [] }; }

/**
 * 官方具名图标的 primitives 替身（含双向箭头与 StateDot）。
 * 标题后箭头依赖 IconChevronRightOutlineRegular：缺失时插件不渲染按钮，因此涉及箭头的用例必须提供它；
 * IconChevronLeftOutlineRegular 决定箭头能否进入可关闭的 << 状态（缺它时保持静态 >>，见对应用例）。
 */
const sidebarArrowPrimitives = {
  IconChevronRightOutlineRegular: sidebarRightArrowIcon,
  IconChevronLeftOutlineRegular: sidebarLeftArrowIcon,
  IconChevronDownOutlineRegular: function ChevronDown(props) { return { type: "svg", props: props || {}, children: [] }; },
  IconRefreshOutlineRegular: function Refresh() {},
  IconStopFillRegular: function Stop() {},
  StateDot: function StateDot() {},
};

/** 记录 preventDefault / stopPropagation 的合成事件。 */
function recordingEvent() {
  return {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

/** 按可见文本定位一条 .deg_expert_group_row_main（两行内容的唯一容器）。 */
function rowByText(handle, needle) {
  return byClass(handle.output, "deg_expert_group_row_main").find((row) => textOf(row).includes(needle));
}

/** 一条行里的标题后侧栏箭头按钮（不存在时返回 undefined）。 */
function sidebarActionOf(row) {
  return row === undefined ? undefined : byClass(row, "deg_expert_group_sidebar_action")[0];
}

/**
 * 挂载一次「新契约」面板：只提供 uiWorkspace.openSession 与 sidebarRight.openResource。
 * 返回真实渲染会话 + 两个入口的调用账本（导航目标与资源地址原样记录，便于精确断言）。
 */
function mountContractPanel(options = {}) {
  const navTargets = [];
  const resourceCalls = [];
  const uiWorkspace = { openSession(target) { navTargets.push(target); } };
  const sidebarRight = options.sidebarRight ?? {
    openResource(address, openOptions) { resourceCalls.push({ address, options: openOptions }); },
  };
  const mounted = mountPanel({
    sessions: options.sessions ?? addressedSessionsFixture(options.addresses),
    hostSnapshot: options.hostSnapshot,
    // 展开 override 只有在 storage 可写时才持久（需求二：结算态 fan-out 默认收起，
    // 需要读分片行的用例必须先展开）。默认不传，行为与既有用例一致。
    storage: options.storage,
    primitives: options.primitives ?? sidebarArrowPrimitives,
    uiWorkspace,
    sidebarRight,
    layout: options.layout,
    // 手柄锁的两个注入点由 install 侧提供：契约面板用例可借此断言面板只在既有生命周期里
    // 请求重估、并在卸载时交还手柄（不注入时保持 no-op）。
    syncRightbarDragLock: options.syncRightbarDragLock,
    releaseRightbarDragLock: options.releaseRightbarDragLock,
    beginSidebarSplit: options.beginSidebarSplit,
    markSidebarSplitPane: options.markSidebarSplitPane,
    markSidebarSplitOpen: options.markSidebarSplitOpen,
    commitSidebarSplit: options.commitSidebarSplit,
    cancelSidebarSplit: options.cancelSidebarSplit,
  });
  return { ...mounted, navTargets, resourceCalls };
}

test("新契约：点击任务名走 uiWorkspace.openSession，已知子代理优先传地址", async () => {
  const mounted = mountContractPanel({
    addresses: {
      // 宿主权威地址：登记过的 child 必须带 parent + mode 一起导航。
      "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    },
  });
  const { handle, navTargets, resourceCalls, intervals, restore } = mounted;
  try {
    await handle.settle();
    const runningRow = rowByText(handle, "运行专家");
    assert.ok(runningRow, "运行中的专家必须在普通列表里渲染");

    // 任务名点击 → 地址对象（不是裸 id）。
    byClass(runningRow, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [
      { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    ]);
    // 键盘 Enter/Space 与鼠标同源（地址形态也必须一致）。
    byClass(runningRow, "deg_expert_group_task")[0].props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    assert.equal(navTargets.length, 2);
    assert.deepEqual(navTargets[1], navTargets[0]);
    byClass(runningRow, "deg_expert_group_task")[0].props.onKeyDown({ key: " ", preventDefault() {}, stopPropagation() {} });
    assert.equal(navTargets.length, 3);
    assert.deepEqual(navTargets[2], navTargets[0]);

    // 根节点没有子代理地址：必须退回裸 session id（旧行为与宿主契约都不变）。
    byClass(rowByText(handle, "主代理"), "deg_expert_group_task")[0].props.onClick();
    assert.equal(navTargets.at(-1), "root-1");
    assert.equal(navTargets.length, 4);

    // 任务行只有两行：摘要行不得再提供第二个导航入口。
    assert.equal(byClass(runningRow, "deg_expert_group_content").length, 0);

    // 主视图导航不得顺带打开任何侧栏资源。
    assert.deepEqual(resourceCalls, [], "点击任务名不得打开侧栏资源页");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：子代理目录尚未 hydration 时仍用 Host 快照地址证据显示箭头并导航", async () => {
  const sessions = addressedSessionsFixture({});
  // 模拟 DSH 首次打开 child：会话投影尚未 refresh，subagentAddress 也还没有缓存。
  sessions.list.getSnapshot = () => ({
    current: "root-1",
    byId: { "root-1": { id: "root-1", title: "根任务标题" } },
    projectionsBySession: {},
  });
  const hostSnapshot = snapshot();
  hostSnapshot.root.children = [{
    id: "expert-running",
    kind: "expert",
    sessionId: "expert-running",
    taskName: "运行专家",
    role: "explorer",
    content: "目录尚未 hydration",
    status: "running",
    continuable: true,
  }];
  const mounted = mountContractPanel({ sessions, hostSnapshot });
  const { handle, navTargets, resourceCalls, intervals, restore } = mounted;
  try {
    await handle.settle();
    const row = rowByText(handle, "运行专家");
    assert.ok(row, "Host 快照中的专家节点必须先于 sessions 目录渲染");
    const arrow = sidebarActionOf(row);
    assert.ok(arrow, "目录尚未 hydration 时，明确 continuable 的专家仍必须显示侧栏箭头");

    byClass(row, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [{
      parentSessionId: "root-1",
      childSessionId: "expert-running",
      mode: "continuable",
    }], "任务名导航不得退回裸 child id");

    arrow.props.onClick(recordingEvent());
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/expert-running?parent=root-1&mode=continuable",
      options: { kind: "subagentchat", preferNewPane: true },
    }], "首屏箭头必须使用同一个 durable parent address");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：标题后箭头只打开右侧栏 subagentchat 资源，绝不触发主视图导航", async () => {
  const mounted = mountContractPanel({
    addresses: {
      "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    },
  });
  const { handle, navTargets, resourceCalls, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    const runningRow = rowByText(handle, "运行专家");
    const arrow = sidebarActionOf(runningRow);
    assert.ok(arrow, "可导航的子代理行必须在任务标题后渲染侧栏箭头");
    assert.equal(runningRow.children.length, 2, "任务行保持「标题 + 元数据」两行结构");
    const taskLine = byClass(runningRow, "deg_expert_group_task_line")[0];
    assert.ok(taskLine, "任务标题必须有独立的内联容器");
    assert.equal(taskLine.children[1], arrow, "侧栏箭头必须紧跟任务文字位于同一标题行");
    assert.equal(arrow.type, "button");
    const doubleArrow = byClass(arrow, "deg_expert_group_double_arrow")[0];
    assert.ok(doubleArrow, "侧栏按钮必须渲染双右箭头容器");
    assert.equal(doubleArrow.children.length, 2, "箭头形状必须是两个右箭头");
    for (const icon of doubleArrow.children) {
      assert.equal(icon.type, "svg", "双箭头必须渲染 SVG 图标");
      assert.equal(icon.props.size, 20, "双箭头的两个图标都应从 10px 放大至 20px");
      assert.equal(icon.props.className, "deg_expert_group_double_arrow_icon", "双箭头图标必须使用插件加粗样式");
      assert.equal(icon.props["aria-hidden"], true, "双箭头图标必须作为按钮内的装饰内容");
    }
    assert.equal(arrow.props["aria-label"], "在侧边栏打开 运行专家");
    assert.equal(arrow.props.title, arrow.props["aria-label"], "title 与无障碍名称同源");

    const event = recordingEvent();
    arrow.props.onClick(event);
    // 基础夹具不提供 split，因此这里断言旧宿主回退参数；split/paneId 主契约见双 pane 回归用例。
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/expert-running?parent=root-1&mode=continuable",
      options: { kind: "subagentchat", preferNewPane: true },
    }]);
    // 冒泡与默认行为都必须拦下：箭头绝不能触发任务名的主视图导航。
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(navTargets, [], "点击箭头不得产生任何主视图导航调用");

    // 键盘事件同样拦下冒泡，但保留按钮自身的默认激活行为（Enter/Space → click）。
    const keyEvent = recordingEvent();
    arrow.props.onKeyDown(keyEvent);
    assert.equal(keyEvent.propagationStopped, true);
    assert.equal(keyEvent.defaultPrevented, false);

    // fan-out 分片行同样支持箭头：宿主没有给出地址时用目录项的合法 mode + parentId 构造。
    const shardArrow = sidebarActionOf(rowByText(handle, "failed-shard"));
    assert.ok(shardArrow, "分片行必须在任务标题后渲染侧栏箭头");
    assert.equal(shardArrow.props["aria-label"], "在侧边栏打开 failed-shard");
    shardArrow.props.onClick(recordingEvent());
    assert.deepEqual(resourceCalls[1], {
      address: "dsh-resource://subagentchat/session/new-child?parent=root-1&mode=one-shot",
      options: { kind: "subagentchat", preferNewPane: true },
    });
    // 地址同样交给主视图导航：分片任务名点击拿到的地址与箭头同源（目录兜底）。
    byClass(rowByText(handle, "failed-shard"), "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [{ parentSessionId: "root-1", childSessionId: "new-child", mode: "one-shot" }]);
    assert.equal(requests.some((request) => String(request.action).startsWith("fanout-")), false, "侧栏箭头不是管理动作，绝不发取消/重试 RPC");
    assert.equal(resourceCalls.length, 2);

    // 地址不可解析的行（目录里没有该 child、宿主也没有地址）绝不渲染空按钮：
    // 根节点（没有父会话）与取消分片（cancelled-child 不在目录里）都必须没有箭头。
    assert.equal(sidebarActionOf(rowByText(handle, "主代理")), undefined);
    assert.equal(sidebarActionOf(rowByText(handle, "cancelled-shard")), undefined);
    assert.equal(sidebarActionOf(rowByText(handle, "空闲子代理")), undefined);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：split 显式定位子代理 pane，不播种开始页", async () => {
  const splitCalls = [];
  const resourceCalls = [];
  const mounted = mountContractPanel({
    addresses: {
      "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    },
    sidebarRight: {
      split() {
        splitCalls.push(true);
        return "pane-child";
      },
      openResource(address, options) { resourceCalls.push({ address, options }); },
    },
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const arrow = sidebarActionOf(rowByText(handle, "运行专家"));
    assert.ok(arrow, "可导航的子代理行必须显示侧栏箭头");

    arrow.props.onClick(recordingEvent());

    assert.deepEqual(splitCalls, [true], "打开子代理必须先通过公开 split 创建目标 pane");
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/expert-running?parent=root-1&mode=continuable",
      options: { kind: "subagentchat", paneId: "pane-child", preferNewPane: false },
    }], "资源必须显式定位到新建 pane，避免静默回落到 Expert Group pane");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：资源地址按 DSH 规范对 child 与 parent 做百分号编码", async () => {
  // child id 含空格与斜杠：不编码会让宿主把地址解析成别的路径段（地址直接失效）。
  const hostSnapshot = snapshot();
  hostSnapshot.root.children = [{
    id: "child a/1", kind: "expert", sessionId: "child a/1", taskName: "特殊字符子代理",
    role: "fixer", content: "特殊字符 id 的子代理", status: "running", continuable: true,
  }];
  const mounted = mountContractPanel({
    hostSnapshot,
    addresses: {
      "child a/1": { parentSessionId: "parent 1/2", childSessionId: "child a/1", mode: "one-shot" },
    },
  });
  const { handle, resourceCalls, navTargets, intervals, restore } = mounted;
  try {
    await handle.settle();
    const arrow = sidebarActionOf(rowByText(handle, "特殊字符子代理"));
    assert.ok(arrow, "带宿主地址的子代理行必须有箭头");
    arrow.props.onClick(recordingEvent());
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child%20a%2F1?parent=parent+1%2F2&mode=one-shot",
      options: { kind: "subagentchat", preferNewPane: true },
    }]);
    // 主视图导航收到的是未编码的原始地址对象（宿主自己按地址对象定位，不做字符串拼接）。
    byClass(rowByText(handle, "特殊字符子代理"), "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [
      { parentSessionId: "parent 1/2", childSessionId: "child a/1", mode: "one-shot" },
    ]);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：地址来源缺失或 mode 非法时绝不用猜测值凑地址", async () => {
  const hostSnapshot = snapshot();
  hostSnapshot.root.children = [
    // 目录项 mode 非法（DSH 只认 one-shot | continuable | unknown）：地址无法构造。
    {
      id: "bad-mode", kind: "expert", sessionId: "bad-mode", taskName: "非法模式子代理",
      role: "fixer", content: "非法 mode", status: "running", continuable: true,
    },
    // 宿主地址表里存在但 mode 非法：同样拒绝，且不退回目录（目录里也没有它的合法条目）。
    {
      id: "bad-host", kind: "expert", sessionId: "bad-host", taskName: "宿主非法模式",
      role: "fixer", content: "宿主非法 mode", status: "running", continuable: true,
    },
  ];
  const mounted = mountContractPanel({
    hostSnapshot,
    sessions: (() => {
      const fixture = addressedSessionsFixture({
        "bad-host": { parentSessionId: "root-1", childSessionId: "bad-host", mode: "forever" },
      });
      // 目录项给出非法 mode：插件必须按「没有合法 mode」处理。
      fixture.list.getSnapshot = () => ({
        current: "root-1",
        byId: {},
        projectionsBySession: {
          "root-1": { values: { subagentCatalog: [{ id: "bad-mode", createdAt: 1, mode: "forever" }] } },
        },
      });
      return fixture;
    })(),
  });
  const { handle, resourceCalls, navTargets, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.ok(rowByText(handle, "非法模式子代理"), "非法 mode 的专家仍要正常渲染");
    assert.equal(sidebarActionOf(rowByText(handle, "非法模式子代理")), undefined);
    assert.equal(sidebarActionOf(rowByText(handle, "宿主非法模式")), undefined);
    // 行本身仍可导航（主视图只需 session id），只是没有侧栏箭头。
    byClass(rowByText(handle, "非法模式子代理"), "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, ["bad-mode"]);
    assert.deepEqual(resourceCalls, []);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("新契约：mode=unknown 是合法地址但按不可续接降级，绝不显示可继续", async () => {
  const hostSnapshot = snapshot();
  hostSnapshot.root.children = [{
    id: "unknown-mode", kind: "expert", sessionId: "unknown-mode", taskName: "未知模式子代理",
    role: "fixer", content: "未知 mode", status: "running", continuable: true,
  }];
  const mounted = mountContractPanel({
    hostSnapshot,
    // 会话投影目录显式给出 unknown；节点 continuable=true 是较弱证据，绝不覆盖它。
    sessions: addressedSessionsFixture({}),
  });
  // 目录投影的 unknown 是权威值：地址照旧可构造（宿主原生侧栏认识该值）。
  mounted.sessions.list.getSnapshot = () => ({
    current: "root-1",
    byId: { "unknown-mode": { id: "unknown-mode", title: "未知模式会话", running: true } },
    projectionsBySession: {
      "root-1": { values: { subagentCatalog: [{ id: "unknown-mode", createdAt: 1, mode: "unknown" }] } },
    },
  });
  const { handle, navTargets, resourceCalls, intervals, restore } = mounted;
  try {
    await handle.settle();
    const row = rowByText(handle, "未知模式子代理");
    assert.ok(row, "unknown 模式的专家必须照常渲染");
    // 摘要行已移除：unknown 的「可续接性未知」不再有可展示的 mode 文案，
    // 侧栏绝不出现「可继续 / 一次性」这类被降级过的猜测词。
    assert.equal(byClass(row, "deg_expert_group_content").length, 0);
    assert.equal(textOf(handle.output).includes("可继续"), false, "unknown 模式绝不能显示为可继续");
    assert.equal(textOf(handle.output).includes("一次性"), false, "unknown 不映射为一次性（那同样是猜测）");
    const treeRow = byClass(handle.output, "deg_expert_group_row").find((candidate) => textOf(candidate).includes("未知模式子代理"));
    assert.equal(byClass(treeRow, "deg_expert_group_status_icon")[0].props["data-status"], "running", "圆点仍与目录证据同源");
    // 主视图导航照旧传地址（宿主自己按 unknown 只读呈现），侧栏箭头照旧可打开资源页。
    byClass(row, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [{ parentSessionId: "root-1", childSessionId: "unknown-mode", mode: "unknown" }]);
    const arrow = sidebarActionOf(row);
    assert.ok(arrow, "unknown 模式的地址可构造，箭头必须渲染");
    arrow.props.onClick(recordingEvent());
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/unknown-mode?parent=root-1&mode=unknown",
      options: { kind: "subagentchat", preferNewPane: true },
    }]);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("侧栏箭头：缺 openResource / 缺具名图标时不渲染，宿主抛错也不污染导航", async () => {
  const sessions = addressedSessionsFixture({
    "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
  });

  // 1) 有 sidebarRight 但没有 openResource：不渲染按钮（绝不产生点了没反应的入口）。
  const withoutOpenResource = mountContractPanel({ sessions, sidebarRight: { active: () => undefined } });
  try {
    await withoutOpenResource.handle.settle();
    assert.equal(byClass(withoutOpenResource.handle.output, "deg_expert_group_sidebar_action").length, 0);
  } finally {
    withoutOpenResource.handle.unmount();
    withoutOpenResource.restore();
  }
  assert.equal(withoutOpenResource.intervals.active, 0);

  // 2) 有 openResource 但 primitives 没有具名箭头图标：同样不渲染（不用兜底警告图标冒充箭头）。
  const withoutIcon = mountContractPanel({ sessions, primitives: {} });
  try {
    await withoutIcon.handle.settle();
    assert.equal(byClass(withoutIcon.handle.output, "deg_expert_group_sidebar_action").length, 0);
  } finally {
    withoutIcon.handle.unmount();
    withoutIcon.restore();
  }
  assert.equal(withoutIcon.intervals.active, 0);

  // 3) 宿主打开抛错（seat 尚未 mint）：插件吞掉异常，主视图导航照常，其它行不受影响。
  const throwing = mountContractPanel({
    sessions,
    sidebarRight: { openResource() { throw new Error("no session surface is mounted"); } },
  });
  try {
    await throwing.handle.settle();
    const row = rowByText(throwing.handle, "运行专家");
    const arrow = sidebarActionOf(row);
    assert.ok(arrow, "宿主有 openResource 时箭头照常渲染");
    assert.doesNotThrow(() => arrow.props.onClick(recordingEvent()));
    byClass(row, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(throwing.navTargets, [
      { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    ], "侧栏打开失败不得影响主视图导航");
    assert.deepEqual(throwing.handle.cleanupErrors, []);
  } finally {
    throwing.handle.unmount();
    throwing.restore();
  }
  assert.equal(throwing.intervals.active, 0);
});

test("工作区导航缺失：不渲染任何导航入口，删除的 sessions.open / deps.openSession 回退不再被读取", async () => {
  const opened = [];
  // 已删除的旧入口照旧放在替身上：插件必须完全不读它们（新契约只有 uiWorkspace.openSession）。
  const staleSessions = sessionsFixture(opened);
  staleSessions.open = (id) => opened.push(id);
  staleSessions.subagentAddress = (childId) => ({ parentSessionId: "root-1", childSessionId: childId, mode: "continuable" });

  const mounted = mountPanel({
    sessions: staleSessions,
    primitives: sidebarArrowPrimitives,
    // 工作区导航入口缺失（宿主没有 uiWorkspace.openSession）；同时把已删除的 deps.openSession
    // 注入成「一旦被调用就抛错」，证明插件确实不再读它。
    uiWorkspace: null,
  });
  const { handle, intervals, restore, legacyOpenSessionCalls } = mounted;
  try {
    await handle.settle();
    const row = rowByText(handle, "运行专家");
    assert.ok(row, "缺少工作区导航入口时任务树仍必须正常渲染");
    // 不显示失效按钮：任务名不再是 role=button，点击也没有任何效果。
    const taskLine = byClass(row, "deg_expert_group_task")[0];
    assert.equal(taskLine.props.role, undefined, "没有导航入口时任务名不得冒充可点击按钮");
    assert.equal(taskLine.props.tabIndex, undefined);
    assert.equal(taskLine.props.onClick, undefined);
    assert.equal(byClass(row, "deg_expert_group_content").length, 0, "摘要行已移除，不存在第二个导航入口");
    assert.deepEqual(opened, [], "已删除的 sessions.open 不得再被调用");
    assert.deepEqual(legacyOpenSessionCalls, [], "已删除的 deps.openSession 不得再被调用");
    // 没有 sidebarRight：地址与图标即使可用也不渲染标题后箭头。
    assert.equal(sidebarActionOf(row), undefined);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 只有 uiWorkspace.openSession 时导航照常工作（根节点与普通专家都走同一个入口）。
  const navTargets = [];
  const viaWorkspace = mountPanel({
    sessions: staleSessions,
    primitives: sidebarArrowPrimitives,
    uiWorkspace: { openSession(target) { navTargets.push(target); } },
  });
  try {
    await viaWorkspace.handle.settle();
    byClass(rowByText(viaWorkspace.handle, "运行专家"), "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [
      { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    ], "工作区入口必须收到地址对象（它认识 SubagentAddress）");
    assert.deepEqual(opened, [], "工作区入口可用时绝不触碰已删除的旧入口");
    assert.deepEqual(viaWorkspace.legacyOpenSessionCalls, []);
  } finally {
    viaWorkspace.handle.unmount();
    viaWorkspace.restore();
  }
  assert.equal(viaWorkspace.intervals.active, 0);
});

/**
 * ── 侧栏箭头 toggle：>> 打开 / << 关闭（DSH 公开 sidebarRight 契约）───────────────────
 *
 * 状态机只架在三条公开面上：
 * 1. `sidebarRight.openResource(address, options)`：打开（空结果、抛错都只影响这一次动作）；
 * 2. `sidebarRight.active()`：打开是否真的落地的唯一证据（返回目标 tab 才算数），
 *    以及外部关闭同步的额外正向证据；
 * 3. `sidebarRight.close(tabId)` 与宿主渲染的稳定 DOM 标记
 *    `[data-sidebar-right-panel] [data-dockkit-tab="<tabId>"]`：关闭入口与「tab 还在不在」的观测面。
 *
 * 下面每个用例都只用这三条公开面驱动（外加受控的 fake document/MutationObserver），
 * 不读私有 Map、不匹配源码字符串。
 */

/** 目标子代理的规范资源地址（地址构造本身由既有编码用例单独覆盖）。 */
const TOGGLE_ADDRESS = "dsh-resource://subagentchat/session/expert-running?parent=root-1&mode=continuable";
/** toggle 用例共用的宿主权威地址表：exper-running 是唯一有地址的子代理。 */
const TOGGLE_ADDRESSES = {
  "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
};

/**
 * 完整右栏能力替身：openResource + active + close（paneId 非 null 时还有 split）。
 *
 * - 默认 mintOnOpen：openResource 成功即把该地址 mint 成 active tab —— 真实 DSH 的 openResource
 *   会同步把 intent 提交进 session store，因此 active() 在同一轮同步栈里就能读到它；
 * - 用例可用 setActive(...) 模拟「没有 active tab」「active 是别的 tab/pane」与证据不匹配
 *   （kind / contentId / id 缺一不可）；
 * - hooks.onOpen / hooks.onClose 注入重入点击与抛错，用于验证 pending 防重入与失败不写状态。
 */
function sidebarRightToggleFixture(options = {}) {
  const opened = [];
  const closed = [];
  const hooks = { onOpen: null, onClose: null };
  const state = { splits: 0, tab: undefined };
  const openRecords = new Map();
  const openTabsListeners = new Set();
  const publishOpenTabs = () => { for (const listener of [...openTabsListeners]) listener(); };
  const openTabs = {
    getSnapshot() {
      const snapshot = [...openRecords.values()].map((tab) => ({ sessionId: tab.sessionId ?? "root-1", tabId: tab.id, kind: tab.kind, contentId: tab.contentId }));
      if (typeof options.snapshotOpenTabs === "function") return options.snapshotOpenTabs(snapshot, state);
      return snapshot;
    },
    subscribe(listener) {
      openTabsListeners.add(listener);
      return () => openTabsListeners.delete(listener);
    },
  };
  const service = {
    ...(options.openTabs === false ? {} : { openTabs }),
    openResource(address, openOptions) {
      opened.push({ address, options: openOptions });
      if (typeof hooks.onOpen === "function") hooks.onOpen(address, openOptions);
      if (typeof openOptions?.replaceTab === "string") openRecords.delete(openOptions.replaceTab);
      if (options.mintOnOpen !== false) {
        const tab = {
          id: typeof options.tabIdFor === "function" ? options.tabIdFor(address) : "tab-1",
          kind: "subagentchat",
          contentId: address,
          title: "子代理会话",
        };
        openRecords.set(tab.id, tab);
        state.tab = typeof options.activeOnOpen === "function" ? options.activeOnOpen(tab) : tab;
        publishOpenTabs();
      }
    },
    active() { return state.tab; },
    close(tabId) {
      closed.push(tabId);
      // 真实宿主的 close 可能同步抛错、也可能返回 Promise；hook 的返回值原样交回调用方，
      // 这样「异步拒绝」这条边界才能被插件的 await 真实观察到（而不是变成游离的 unhandled rejection）。
      const hooked = typeof hooks.onClose === "function" ? hooks.onClose(tabId) : undefined;
      // inventory 移除的时机必须与真实宿主一致：close 的**结算**才是 tab 消失的时刻。
      // - 同步 close（含同步抛错）保持既有行为：抛错时记录原样保留（插件必须继续看到 <<）；
      // - 返回 Promise 的 close 只有 resolve 之后才移除；reject 时 tab 仍在 inventory 里——
      //   夹具绝不能抢在 Promise settle 之前把失败项抹掉，否则「失败项没有被标成已关闭」这条
      //   断言在夹具层面就已经失真。
      const commit = () => {
        if (state.tab?.id === tabId) state.tab = undefined;
        if (openRecords.delete(tabId)) publishOpenTabs();
      };
      if (hooked !== null && typeof hooked === "object" && typeof hooked.then === "function") {
        return Promise.resolve(hooked).then((value) => { commit(); return value; });
      }
      commit();
      return hooked;
    },
  };
  if (options.paneId !== null) {
    service.split = () => {
      state.splits += 1;
      if (options.seedGuideOnSplit === true) {
        const guideIds = Array.isArray(options.guideTabIds) && options.guideTabIds.length > 0
          ? options.guideTabIds
          : [options.guideTabId ?? "guide-1"];
        let activeGuide;
        for (const guideId of guideIds) {
          const guide = {
            id: guideId,
            sessionId: Array.isArray(options.guideSessionIds)
              ? options.guideSessionIds[guideIds.indexOf(guideId)] ?? "root-1"
              : options.guideSessionId ?? "root-1",
            kind: "guide",
            contentId: "sidebar://guide",
            title: "开始",
          };
          openRecords.set(guide.id, guide);
          activeGuide = guide;
        }
        state.tab = activeGuide;
        publishOpenTabs();
      }
      return options.paneId ?? "pane-child";
    };
  }
  return {
    service,
    opened,
    closed,
    hooks,
    get splits() { return state.splits; },
    get activeTab() { return state.tab; },
    get openTabs() { return openTabs.getSnapshot(); },
    get openTabsSubscribers() { return openTabsListeners.size; },
    /** 直接设定宿主 active() 的返回值（null 表示没有 active tab）。 */
    setActive(tab) {
       state.tab = tab === null ? undefined : tab;
       if (state.tab !== undefined) openRecords.set(state.tab.id, state.tab);
     },
     /** 注入一个已经提交的 tab，用于模拟同地址 tab 出现在多个 pane 的宿主状态。 */
     addOpenTab(tab) {
       if (tab !== null && typeof tab === "object" && typeof tab.id === "string") {
         openRecords.set(tab.id, tab);
         publishOpenTabs();
       }
     },
     /** 模拟宿主提交外部关闭：从公开 openTabs inventory 移除 tab 并通知订阅者。 */
     forgetOpenTab(tabId) {
       if (openRecords.delete(tabId)) publishOpenTabs();
     },
  };
}

/**
 * 右栏 DOM 替身：只实现插件读取的公开标记与查询面。
 * - `document.querySelector("[data-sidebar-right-panel]")`：面板节点；折叠 / surface 重挂载期间返回 null；
 * - `panel.querySelectorAll("[data-dockkit-tab]")`：当前 tab 芯片，tabId 即 data-dockkit-tab 的值；
 * - body 供 MutationObserver 观察（真实回调由受控 observer 手动派发）。
 */
function rightbarDomStub() {
  const state = { panel: null, tabs: [], floats: [] };
  const listeners = new Map();
  const paneNode = (paneId) => paneId === null || paneId === undefined ? null : {
    getAttribute(name) { return name === "data-dockkit-pane" ? paneId : null; },
    parentNode: null,
  };
  const panelNode = {
    nodeType: 1,
    querySelectorAll(selector) {
      if (selector !== "[data-dockkit-tab]") return [];
      return state.tabs
        .filter((tab) => tab.present === true)
        .map((tab) => ({
          getAttribute(name) { return name === "data-dockkit-tab" ? tab.id : null; },
          parentNode: paneNode(tab.paneId),
        }));
    },
  };
  const floatingNode = (title) => ({
    querySelector(selector) {
      if (selector === "[data-sidebar-chat]") return {};
      if (selector === "[data-dockkit-float-title]") return { textContent: title };
      return null;
    },
  });
  return {
    document: {
      hidden: false,
      body: { nodeType: 1 },
      documentElement: { nodeType: 1 },
      querySelector(selector) { return selector === "[data-sidebar-right-panel]" ? state.panel : null; },
       querySelectorAll(selector) {
         if (selector === "[data-dockkit-float]") return state.floats
           .filter((item) => item.present === true)
           .map((item) => floatingNode(item.title));
         return [];
       },
      addEventListener(type, listener) {
        const entries = listeners.get(type) ?? [];
        entries.push(listener);
        listeners.set(type, entries);
      },
      removeEventListener(type, listener) {
        const entries = listeners.get(type) ?? [];
        const index = entries.indexOf(listener);
        if (index >= 0) entries.splice(index, 1);
      },
    },
    /** 某个事件类型上仍登记的监听器数量：用于断言卸载后彻底清理。 */
    listenerCount(type) { return (listeners.get(type) ?? []).length; },
    /** 派发一次可见性变化（等价于用户把标签页切回前台）。 */
    dispatchVisibilityChange() {
      for (const listener of [...(listeners.get("visibilitychange") ?? [])]) listener({ type: "visibilitychange" });
    },
    /** 宿主展开右栏：面板挂载。 */
    mountPanel() { state.panel = panelNode; },
    /** 右栏折叠 / surface 整体重挂载：面板暂时（或长期）不在 DOM 里。 */
    unmountPanel() { state.panel = null; },
    /** 宿主渲染出一个 tab 芯片。 */
    addTab(id, paneId = null) { state.tabs.push({ id, paneId, present: true }); },
    moveTab(id, paneId) {
      const tab = state.tabs.find((entry) => entry.id === id);
      if (tab !== undefined) tab.paneId = paneId;
    },
    /** 用户从 tab 自带的关闭按钮 / 右键菜单关掉它：芯片从 DOM 中消失。 */
    removeTab(id) {
      const tab = state.tabs.find((entry) => entry.id === id);
      if (tab !== undefined) tab.present = false;
    },
    /** 宿主把 subagentchat tab 浮动到面板外：只保留 body 与标题标记。 */
    addFloatingTab(title) { state.floats.push({ title, present: true }); },
    /** 用户从浮动窗口关闭 subagentchat tab。 */
    removeFloatingTab(title) {
      const tab = state.floats.find((entry) => entry.title === title);
      if (tab !== undefined) tab.present = false;
    },
  };
}

/**
 * 挂载一次「侧栏箭头 toggle」面板：完整 sidebarRight 能力 + 可选右栏 DOM 替身与受控 observer。
 *
 * document / MutationObserver 只在这一次挂载的生命周期内安装，与真实浏览器一致：两者同时存在时
 * 插件才会创建观察器。unmountAll() 先卸载渲染会话（触发 effect 清理），再恢复全局与假定时器，
 * 用例可以因此在卸载后断言「观察器确实断开了」。
 */
function mountTogglePanel(options = {}) {
  const instances = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.disconnected = false;
      instances.push(this);
    }
    observe(target, nextOptions) { this.target = target; this.options = nextOptions; }
    disconnect() { this.disconnected = true; }
  }
  const dom = options.dom ?? null;
  // 显式传 undefined 会删除该全局：Node 里本来就没有 document/MutationObserver，
  // 因此「完全没有 DOM 观察能力」与「有 document 但没有 observer」两条降级路径都能被如实覆盖。
  const restoreGlobals = installGlobals({
    document: dom === null ? undefined : dom.document,
    MutationObserver: dom === null || options.observer === false ? undefined : FakeMutationObserver,
  });
  const fixture = options.fixture ?? sidebarRightToggleFixture();
  const mounted = mountContractPanel({ ...(options.panel ?? {}), layout: options.layout, sidebarRight: fixture.service });
  return {
    ...mounted,
    fixture,
    dom,
    observer: {
      instances,
      /** 手动派发一批 DOM 变更（等价于浏览器把本批变更交给 observer）。 */
      fire() { for (const instance of instances) if (instance.disconnected !== true) instance.callback([]); },
    },
    unmountAll() {
      try {
        mounted.handle.unmount();
        mounted.restore();
      } finally {
        restoreGlobals();
      }
    },
  };
}

/** 一行当前箭头的 data-open 值（"true" 已打开 / "false" 可打开 / undefined 没有箭头）。 */
function sidebarOpenStateOf(handle, label) {
  const arrow = sidebarActionOf(rowByText(handle, label));
  return arrow === undefined ? undefined : arrow.props["data-open"];
}

/**
 * 断言一行箭头当前渲染的是指定方向的两个图标，并返回该双箭头容器。
 * expectedIcon 取 "chevron-right"（未打开）或 "chevron-left"（已打开），与替身写回的 data-icon 同源。
 */
function assertArrowDirection(handle, label, expectedIcon, message) {
  const arrow = sidebarActionOf(rowByText(handle, label));
  assert.ok(arrow, message + "：箭头必须存在");
  const container = byClass(arrow, "deg_expert_group_double_arrow")[0];
  assert.ok(container, message + "：必须使用双箭头容器");
  assert.equal(container.props["data-direction"], expectedIcon === "chevron-left" ? "close" : "open",
    message + "：容器方向必须与图标方向一致");
  assert.equal(container.children.length, 2, message + "：必须是两个同向图标");
  for (const icon of container.children) {
    assert.equal(icon.type, "svg", message + "：箭头必须是 SVG 图标");
    assert.equal(icon.props["data-icon"], expectedIcon, message);
    assert.equal(icon.props.size, 20, message + "：单个箭头图标尺寸必须为 20px");
    assert.equal(icon.props["aria-hidden"], true, message + "：图标是按钮内的装饰内容");
  }
  return container;
}

test("侧栏箭头 toggle：只打开子代理会话，关闭后清掉该 pane（宽度不再随 tab 开关变化）", async () => {
  const widthCalls = [];
  const restoreViewport = installGlobals({ window: { innerWidth: 1600 } });
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a", seedGuideOnSplit: true });
  const mounted = mountTogglePanel({
    fixture,
    layout: { panels: { setRightbar(width) { widthCalls.push(width); } } },
    panel: { addresses: TOGGLE_ADDRESSES },
  });
  const { handle, intervals, navTargets } = mounted;
  try {
    await handle.settle();
    const closedArrow = sidebarActionOf(rowByText(handle, "运行专家"));
    assert.ok(closedArrow, "完整能力（openResource + active + close + 双向图标）下必须渲染箭头");
    assert.equal(closedArrow.type, "button");
    assert.equal(closedArrow.props["data-open"], "false", "未打开时必须显式标记未打开");
    assert.equal(closedArrow.props["aria-pressed"], false, "可关闭按钮是 toggle：未打开时 aria-pressed=false");
    assert.equal(closedArrow.props["aria-label"], "在侧边栏打开 运行专家");
    assert.equal(closedArrow.props.title, closedArrow.props["aria-label"], "title 与无障碍名称同源");
    assertArrowDirection(handle, "运行专家", "chevron-right", "未打开时必须是两个右箭头");

    const openEvent = recordingEvent();
    closedArrow.props.onClick(openEvent);
    assert.equal(openEvent.defaultPrevented, true, "必须拦下默认行为");
    assert.equal(openEvent.propagationStopped, true, "必须拦下冒泡（绝不能触发主视图导航）");
    assert.deepEqual(fixture.opened, [{
      address: TOGGLE_ADDRESS,
      options: { kind: "subagentchat", paneId: "pane-child", replaceTab: "guide-1", preferNewPane: false },
    }], "打开必须显式定位到宿主新建的子代理 pane，并替换默认开始页");
    assert.deepEqual(fixture.openTabs.filter((tab) => tab.kind === "guide"), [], "打开后不得残留宿主播种的开始页");
    // Expert Group 页的右栏宽度由 install 侧固定为视口 20%，与子代理 tab 的开关无关：
    // 面板绝不能再按「有没有打开 pane」把宿主宽度改成另一档。
    assert.deepEqual(widthCalls, [], "打开子代理 pane 不得改写右栏宽度");
    assert.deepEqual(navTargets, [], "点击箭头绝不触发主视图导航");

    // active() 的证据在打开那一刻就成立：bump 后同一行变成可关闭的 <<。
    await handle.settle();
    const openArrow = sidebarActionOf(rowByText(handle, "运行专家"));
    assert.notEqual(openArrow, closedArrow, "状态变化必须触发重渲染");
    assert.equal(openArrow.props["data-open"], "true", "打开成功后必须进入 << 状态");
    assert.equal(openArrow.props["aria-pressed"], true);
    assert.equal(openArrow.props["aria-label"], "在侧边栏关闭 运行专家", "无障碍名称必须反映当前动作");
    assert.equal(openArrow.props.title, openArrow.props["aria-label"]);
    assertArrowDirection(handle, "运行专家", "chevron-left", "打开态必须是两个左箭头");

    // 再次点击：只关闭记录里的精确 tabId，绝不再打开一次，也绝不对别的 tab 动手。
    const closeEvent = recordingEvent();
    openArrow.props.onClick(closeEvent);
    assert.equal(closeEvent.defaultPrevented, true);
    assert.equal(closeEvent.propagationStopped, true);
    assert.deepEqual(fixture.closed, ["tab-a"], "关闭必须使用打开时记录下来的精确 tabId");
    assert.deepEqual(fixture.openTabs, [], "关闭子代理后新 pane 应为空，由宿主恢复 Expert Group 默认布局");
    assert.deepEqual(widthCalls, [], "关闭子代理 pane 同样不得改写右栏宽度（宽度只由 install 侧按会话写入）");
    assert.equal(fixture.opened.length, 1, "关闭态点击不得再调用 openResource");
    assert.deepEqual(navTargets, [], "关闭同样不得触发主视图导航");
    await handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
    // 这里推进两次轮询采样，验证链完成后箭头才复位。
    await intervals.tick();
    await handle.settle();
    await intervals.tick();
    await handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
    // 这里推进两次轮询采样，验证链完成后箭头才复位。
    await intervals.tick();
    await handle.settle();
    await intervals.tick();
    await handle.settle();
    const resetArrow = sidebarActionOf(rowByText(handle, "运行专家"));
    assert.equal(resetArrow.props["aria-pressed"], false);
    assert.equal(resetArrow.props["aria-label"], "在侧边栏打开 运行专家");
    assertArrowDirection(handle, "运行专家", "chevron-right", "关闭后必须恢复两个右箭头");
  } finally {
    mounted.unmountAll();
    restoreViewport();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：两个子代理各自独立，开关任一 pane 都不改写右栏宽度", async () => {
  const widthCalls = [];
  const restoreViewport = installGlobals({ window: { innerWidth: 1600 } });
  const hostSnapshot = snapshot();
  hostSnapshot.root.children = [
    { id: "expert-running", kind: "expert", sessionId: "expert-running", taskName: "运行专家", role: "fixer", content: "第一个子代理", status: "running", continuable: true },
    { id: "expert-other", kind: "expert", sessionId: "expert-other", taskName: "另一个专家", role: "explorer", content: "第二个子代理", status: "running", continuable: true },
  ];
  const fixture = sidebarRightToggleFixture({
    tabIdFor: (address) => (address.includes("expert-running") ? "tab-a" : "tab-b"),
  });
  const dom = rightbarDomStub();
  dom.mountPanel();
  // 宿主每次打开都会渲染出对应芯片：DEG 依据它判断 tab 是否还在。
  fixture.hooks.onOpen = (address) => dom.addTab(address.includes("expert-running") ? "tab-a" : "tab-b");
  const mounted = mountTogglePanel({
    dom,
    fixture,
    layout: { panels: { setRightbar(width) { widthCalls.push(width); } } },
    panel: {
      hostSnapshot,
      addresses: {
        ...TOGGLE_ADDRESSES,
        "expert-other": { parentSessionId: "root-1", childSessionId: "expert-other", mode: "continuable" },
      },
    },
  });
  const { handle, intervals, navTargets } = mounted;
  try {
    await handle.settle();
    sidebarActionOf(rowByText(handle, "运行专家")).props.onClick(recordingEvent());
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "第一个子代理已打开");
    assert.equal(sidebarOpenStateOf(handle, "另一个专家"), "false", "两个子代理的状态必须互相独立");

    // 打开第二个：第一个的 << 必须原样保留（记录按 root + 地址隔离），active 变成第二个也不算复位。
    sidebarActionOf(rowByText(handle, "另一个专家")).props.onClick(recordingEvent());
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "打开第二个子代理不得顶掉第一个的状态");
    assert.equal(sidebarOpenStateOf(handle, "另一个专家"), "true");
    assert.deepEqual(widthCalls, [], "多个子代理 pane 的开关都不得改写右栏宽度");

    // 用户把 active 切到别的 tab/pane：两个目标 tab 都还在 DOM 里，谁都不能被复位。
    fixture.setActive({ id: "tab-other", kind: "file", contentId: "dsh-resource://file/other", title: "别的 tab" });
    mounted.observer.fire();
    await intervals.tick();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "active 是别的 tab/pane 不构成目标缺失的证据");
    assert.equal(sidebarOpenStateOf(handle, "另一个专家"), "true");

    // 关闭第二个：只有它自己的 tabId 被关闭，第一个保持打开。
    sidebarActionOf(rowByText(handle, "另一个专家")).props.onClick(recordingEvent());
    await handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
    // 这里推进两次轮询采样，验证链完成后箭头才复位。
    await intervals.tick();
    await handle.settle();
    await intervals.tick();
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-b"], "只关闭该行记录的 tab");
    assert.equal(sidebarOpenStateOf(handle, "另一个专家"), "false");
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "关闭第二个不得连带复位第一个");
    assert.deepEqual(widthCalls, [], "关闭其中一个 pane 不得改写右栏宽度");
    assert.equal(fixture.opened.length, 2, "关闭动作不得额外打开资源");
    sidebarActionOf(rowByText(handle, "运行专家")).props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(widthCalls, [], "最后一个子代理 pane 关闭时同样不得改写右栏宽度");
    assert.deepEqual(navTargets, [], "两个子代理的开关都不得触发主视图导航");
  } finally {
    mounted.unmountAll();
    restoreViewport();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：外部关闭最后一个 pane 时复位状态（宽度不受影响）", async () => {
  const widthCalls = [];
  const restoreViewport = installGlobals({ window: { innerWidth: 1600 } });
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a", mintOnOpen: false });
  const dom = rightbarDomStub();
  dom.mountPanel();
  dom.addTab("tab-a");
  const mounted = mountTogglePanel({
    dom,
    fixture,
    layout: { panels: { setRightbar(width) { widthCalls.push(width); } } },
    panel: { addresses: TOGGLE_ADDRESSES },
  });
  const { handle, intervals, navTargets } = mounted;
  try {
    await handle.settle();
    // 宿主证据：openResource 之后 active() 立刻读到该地址的 tab。
    fixture.setActive({ id: "tab-a", kind: "subagentchat", contentId: TOGGLE_ADDRESS, title: "子代理会话" });
    sidebarActionOf(rowByText(handle, "运行专家")).props.onClick(recordingEvent());
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true");
    assert.deepEqual(widthCalls, [], "确认打开 pane 时不得改写右栏宽度");
    assert.equal(mounted.observer.instances.length, 1, "document + MutationObserver 可用时必须挂一个观察器");
    assert.deepEqual(mounted.observer.instances[0].options, { childList: true, subtree: true }, "观察面固定为 body 子树的 childList 变更");
    assert.equal(mounted.observer.instances[0].target, dom.document.body, "观察目标必须是 document.body（面板可能迟到挂载或整体重挂载）");

    // 1) active() 仍返回目标 tab：DOM 一时读不到也不得复位（正向存在证据）。
    dom.removeTab("tab-a");
    mounted.observer.fire();
    mounted.observer.fire();
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "active() 仍是目标 tab 时不得仅凭 DOM 缺失复位");

    // 2) 用户切到别的 tab/pane：正向证据消失，但一次缺失可能正是宿主提交窗口的中间态。
    fixture.setActive({ id: "tab-other", kind: "file", contentId: "dsh-resource://file/other", title: "别的 tab" });
    mounted.observer.fire();
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "一次缺失不足以判定用户关掉了 tab");
    mounted.observer.fire();
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "false", "连续两次观察到缺失后必须复位成 >>");
    assert.deepEqual(widthCalls, [], "外部关闭同步只改插件状态，绝不改写右栏宽度");
    assert.equal(sidebarActionOf(rowByText(handle, "运行专家")).props["aria-label"], "在侧边栏打开 运行专家");
    assertArrowDirection(handle, "运行专家", "chevron-right", "复位后必须恢复两个右箭头");
    assert.deepEqual(fixture.closed, [], "外部关闭同步只能改插件状态，绝不调用 close()");
    assert.deepEqual(navTargets, [], "复位过程绝不触发主视图导航");
  } finally {
    mounted.unmountAll();
    restoreViewport();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
  assert.equal(
    mounted.observer.instances.every((instance) => instance.disconnected === true),
    true,
    "卸载必须断开观察器，绝不留下仍在观察 body 的 observer",
  );
});

test("侧栏箭头 toggle：openResource 返回后 active 延迟提交时首次点击仍收敛为青色 <<", async () => {
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a", mintOnOpen: false });
  const dom = rightbarDomStub();
  dom.mountPanel();
  const mounted = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    const arrow = sidebarActionOf(rowByText(mounted.handle, "运行专家"));
    arrow.props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "false", "提交前只保持打开语义");
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    assert.equal(fixture.opened.length, 1, "打开确认在途时第二次点击不得重复 openResource");

    // 模拟 DSH 在 openResource 返回后的后续 store/DOM 提交；用户不会再次点击箭头。
    fixture.setActive({ id: "tab-a", kind: "subagentchat", contentId: TOGGLE_ADDRESS, title: "子代理会话" });
    dom.addTab("tab-a");
    mounted.observer.fire();
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true", "首次点击对应的延迟提交必须自动收敛为 <<");
    assert.equal(sidebarActionOf(rowByText(mounted.handle, "运行专家")).props["aria-label"], "在侧边栏关闭 运行专家");
    assert.deepEqual(fixture.opened.length, 1, "延迟确认不得重复打开资源");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：split 打开后重挂载仍从 openTabs 恢复 <<", async () => {
  const seedTab = { id: "seed-1", kind: "guide", contentId: "sidebar://guide", title: "Start" };
  const fixture = sidebarRightToggleFixture({
    tabIdFor: () => "tab-a",
    activeOnOpen: () => seedTab,
  });
  const dom = rightbarDomStub();
  const first = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  let second = null;
  try {
    await first.handle.settle();
    sidebarActionOf(rowByText(first.handle, "运行专家")).props.onClick(recordingEvent());
    await first.handle.settle();
    assert.equal(sidebarOpenStateOf(first.handle, "运行专家"), "true", "首个组件实例能确认已提交资源");

    // split 会让宿主重挂载 Expert Group surface；新实例没有旧实例的 opening/ref 状态。
    first.unmountAll();
    second = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
    await second.handle.settle();
    assert.equal(sidebarOpenStateOf(second.handle, "运行专家"), "true", "重挂载后仍必须显示青色 <<");
    assert.equal(sidebarActionOf(rowByText(second.handle, "运行专家")).props["aria-label"], "在侧边栏关闭 运行专家");
  } finally {
    if (second !== null) second.unmountAll();
    else first.unmountAll();
  }
});

test("侧栏箭头 toggle：split 后 active 仍指向其它 tab 时用 openTabs 确认目标", async () => {
  const seedTab = { id: "seed-1", kind: "guide", contentId: "sidebar://guide", title: "Start" };
  const fixture = sidebarRightToggleFixture({
    tabIdFor: () => "tab-a",
    activeOnOpen: () => seedTab,
  });
  // 初始没有右栏 panel；打开目标资源后 active 仍可能指向原有 tab。
  const dom = rightbarDomStub();
  const mounted = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.equal(fixture.splits, 1, "打开子代理必须先通过公开 split 创建目标 pane");
    assert.equal(fixture.openTabsSubscribers, 1, "有公开 openTabs 时必须订阅提交通知");
    assert.equal(fixture.opened.length, 1, "首次点击只打开一次子代理资源");
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true", "active 仍指向其它 tab 时也必须首击进入 <<");
    assert.equal(sidebarActionOf(rowByText(mounted.handle, "运行专家")).props["aria-label"], "在侧边栏关闭 运行专家");
    assert.deepEqual(fixture.closed, [], "首击确认阶段不得误关闭 seed tab");
  } finally {
    mounted.unmountAll();
    assert.equal(fixture.openTabsSubscribers, 0, "卸载后必须解除 openTabs 订阅");
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：subagentchat 浮动到面板外时保持打开，浮动关闭后才复位", async () => {
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const dom = rightbarDomStub();
  dom.mountPanel();
  dom.addTab("tab-a");
  const mounted = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true");

    // 浮动层没有 tabId 标记，插件用 subagentchat body + 打开时标题作为保守存在证据。
    dom.removeTab("tab-a");
    dom.addFloatingTab("子代理会话");
    fixture.setActive(null);
    mounted.observer.fire();
    mounted.observer.fire();
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true", "浮动 tab 仍存在时不得误复位");

    dom.removeFloatingTab("子代理会话");
    mounted.observer.fire();
    mounted.observer.fire();
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "false", "浮动 tab 消失后必须复位");
    assert.deepEqual(fixture.closed, [], "外部关闭浮动 tab 不得再次调用 close()");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：没有 observer 时轮询兜底复位；面板或 DOM 能力缺失时保持状态不猜测", async () => {
  // A) 有 document、有面板，但宿主没有 MutationObserver：2.5 秒轮询与 visibilitychange 是唯一兜底。
  const noObserverFixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const noObserverDom = rightbarDomStub();
  noObserverDom.mountPanel();
  noObserverDom.addTab("tab-a");
  const noObserver = mountTogglePanel({ dom: noObserverDom, fixture: noObserverFixture, observer: false, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await noObserver.handle.settle();
    sidebarActionOf(rowByText(noObserver.handle, "运行专家")).props.onClick(recordingEvent());
    await noObserver.handle.settle();
    assert.equal(sidebarOpenStateOf(noObserver.handle, "运行专家"), "true");
    assert.equal(noObserver.observer.instances.length, 0, "没有 MutationObserver 时不得凭空创建观察器");

    // 用户从 tab 自带关闭按钮关掉它，并把 active 切走：轮询第一次观测仍然保持（连续两次才算确认）。
    noObserverDom.removeTab("tab-a");
    noObserverFixture.setActive(null);
    await noObserver.intervals.tick();
    assert.equal(sidebarOpenStateOf(noObserver.handle, "运行专家"), "true", "轮询的一次观测同样不足以复位");
    await noObserver.intervals.tick();
    await noObserver.handle.settle();
    assert.equal(sidebarOpenStateOf(noObserver.handle, "运行专家"), "false", "轮询必须能兜底复位");
    assert.deepEqual(noObserverFixture.closed, [], "轮询复位同样不得调用 close()");
  } finally {
    noObserver.unmountAll();
  }
  assert.equal(noObserver.intervals.active, 0, "卸载后不得遗留轮询定时器");

  // B) 面板不在 DOM 里（右栏折叠 / surface 切换中）：读不到面板不是「tab 没了」的证据。
  const foldedFixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const foldedDom = rightbarDomStub();
  const folded = mountTogglePanel({ dom: foldedDom, fixture: foldedFixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await folded.handle.settle();
    sidebarActionOf(rowByText(folded.handle, "运行专家")).props.onClick(recordingEvent());
    await folded.handle.settle();
    assert.equal(sidebarOpenStateOf(folded.handle, "运行专家"), "true");

    foldedFixture.setActive(null);
    folded.observer.fire();
    folded.observer.fire();
    await folded.intervals.tick();
    assert.equal(sidebarOpenStateOf(folded.handle, "运行专家"), "true", "宿主 panel 不存在时必须保持现有状态，不做猜测");

    // 面板回来（这次真的没有该 tab）：证据恢复后连续两次缺失才复位。
    foldedDom.mountPanel();
    folded.observer.fire();
    folded.observer.fire();
    await folded.handle.settle();
    assert.equal(sidebarOpenStateOf(folded.handle, "运行专家"), "false", "面板重新出现且确实没有该 tab 时必须复位");
  } finally {
    folded.unmountAll();
  }
  assert.equal(folded.intervals.active, 0, "卸载后不得遗留轮询定时器");

  // C) 完全没有 document（旧宿主 / 非浏览器环境）：靠 active() 证据进入 <<，缺 DOM 证据时绝不复位。
  const bareFixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const bare = mountTogglePanel({ fixture: bareFixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await bare.handle.settle();
    sidebarActionOf(rowByText(bare.handle, "运行专家")).props.onClick(recordingEvent());
    await bare.handle.settle();
    assert.equal(sidebarOpenStateOf(bare.handle, "运行专家"), "true", "没有 DOM 观察能力时仍按 active() 证据进入 <<");
    bareFixture.setActive(null);
    await bare.intervals.tick();
    await bare.intervals.tick();
    assert.equal(sidebarOpenStateOf(bare.handle, "运行专家"), "true", "没有 DOM 证据时绝不因为读不到而复位");
    assert.deepEqual(bareFixture.closed, [], "同步路径绝不调用 close()");
  } finally {
    bare.unmountAll();
  }
  assert.equal(bare.intervals.active, 0, "卸载后不得遗留轮询定时器");

  // D) 回到前台（visibilitychange）同样补一次同步：后台期间观察器可能被浏览器节流。
  const visibilityFixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const visibilityDom = rightbarDomStub();
  visibilityDom.mountPanel();
  visibilityDom.addTab("tab-a");
  const visibility = mountTogglePanel({
    dom: visibilityDom,
    fixture: visibilityFixture,
    observer: false,
    panel: { addresses: TOGGLE_ADDRESSES },
  });
  try {
    await visibility.handle.settle();
    sidebarActionOf(rowByText(visibility.handle, "运行专家")).props.onClick(recordingEvent());
    await visibility.handle.settle();
    assert.equal(sidebarOpenStateOf(visibility.handle, "运行专家"), "true");
    assert.equal(visibilityDom.listenerCount("visibilitychange"), 1, "面板必须监听可见性变化（兜底路径）");

    visibilityDom.removeTab("tab-a");
    visibilityFixture.setActive(null);
    visibilityDom.dispatchVisibilityChange();
    await visibility.handle.settle();
    assert.equal(sidebarOpenStateOf(visibility.handle, "运行专家"), "true", "一次可见性观测同样不足以复位");
    visibilityDom.dispatchVisibilityChange();
    await visibility.handle.settle();
    assert.equal(sidebarOpenStateOf(visibility.handle, "运行专家"), "false", "回到前台必须补一次同步并兜底复位");
  } finally {
    visibility.unmountAll();
  }
  assert.equal(visibility.intervals.active, 0, "卸载后不得遗留轮询定时器");
  assert.equal(visibilityDom.listenerCount("visibilitychange"), 0, "卸载必须移除可见性监听器");
});
/**
 * 手柄锁的两个注入点只在 install 侧提供（面板本身不认识 DOM 手柄）：面板要做的事只有两件——
 * 1. 每次同步（挂载、body 结构变化、2.5 秒轮询、可见性变化）都请求 install 侧按宿主证据重估；
 * 2. 卸载（这一页不再由插件渲染）时无条件交还手柄，方向永远安全。
 * 这里注入 spies 验证接线；锁的行为本身由 expert-group-sidebar-contract 的用例覆盖。
 */
test("手柄锁注入点：同步生命周期里请求重估，卸载时无条件交还宿主", async () => {
  const syncCalls = [];
  const releaseCalls = [];
  const dom = rightbarDomStub();
  const mounted = mountTogglePanel({
    dom,
    panel: {
      addresses: TOGGLE_ADDRESSES,
      syncRightbarDragLock() { syncCalls.push("sync"); },
      releaseRightbarDragLock() { releaseCalls.push("release"); },
    },
  });
  const { handle, observer } = mounted;
  try {
    await handle.settle();
    assert.ok(syncCalls.length >= 1, "面板挂载（这一页出现）时必须请求一次手柄锁重估");
    assert.equal(releaseCalls.length, 0, "页面还在时绝不交还手柄");
    const beforeFire = syncCalls.length;
    observer.fire();
    assert.ok(syncCalls.length > beforeFire, "body 结构变化（宿主重挂手柄 / 换页）必须再重估一次");
    const beforeTick = syncCalls.length;
    await mounted.intervals.tick();
    assert.ok(syncCalls.length > beforeTick, "2.5 秒轮询同样是重估边沿（迟到的句柄靠它补锁）");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(releaseCalls.length, 1, "卸载必须把手柄交还宿主");
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});


test("侧栏箭头 toggle：active 证据不匹配时绝不猜测 tabId，按钮保持打开语义", async () => {
  const cases = [
    {
      name: "active 是别的 kind",
      tab: { id: "tab-1", kind: "file", contentId: TOGGLE_ADDRESS, title: "文件 tab" },
    },
    {
      name: "active 的 contentId 不是该资源地址",
      tab: { id: "tab-1", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/other?parent=root-1&mode=one-shot", title: "别的子代理" },
    },
    {
      name: "active 没有有效 id",
      tab: { kind: "subagentchat", contentId: TOGGLE_ADDRESS, title: "缺少 id" },
    },
    {
      name: "根本没有 active tab",
      tab: null,
    },
  ];
  for (const item of cases) {
    const fixture = sidebarRightToggleFixture({ mintOnOpen: false });
    fixture.setActive(item.tab);
    const mounted = mountTogglePanel({ fixture, panel: { addresses: TOGGLE_ADDRESSES } });
    try {
      await mounted.handle.settle();
      sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
      await mounted.handle.settle();
      assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "false", item.name + "：没有落地证据时必须保持 >> 打开语义");
      assertArrowDirection(mounted.handle, "运行专家", "chevron-right", item.name + "：绝不显示假的可关闭状态");
      assert.equal(fixture.opened.length, 1, item.name + "：打开请求本身照常发出");
      assert.deepEqual(fixture.closed, [], item.name + "：绝不凭空关闭任何 tab");

      // 再次点击仍然是「打开」而不是「关闭」：状态没有被污染成可关闭。
      sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
      assert.equal(fixture.opened.length, 2, item.name + "：按钮必须仍然可打开");
      assert.deepEqual(fixture.closed, [], item.name + "：仍然没有任何关闭调用");
    } finally {
      mounted.unmountAll();
    }
    assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
  }
});

test("侧栏箭头 toggle：openResource / active / close / split 抛错与重入点击都不污染状态", async () => {
  // 1) openResource 抛错（seat 尚未 mint）：不进入 <<，主视图导航照常。
  const throwingOpen = sidebarRightToggleFixture();
  throwingOpen.service.openResource = () => { throw new Error("no session surface is mounted"); };
  const openFailure = mountTogglePanel({ fixture: throwingOpen, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await openFailure.handle.settle();
    const row = rowByText(openFailure.handle, "运行专家");
    assert.doesNotThrow(() => sidebarActionOf(row).props.onClick(recordingEvent()));
    await openFailure.handle.settle();
    assert.equal(sidebarOpenStateOf(openFailure.handle, "运行专家"), "false", "打开失败不得留下任何状态");
    byClass(row, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(openFailure.navTargets, [
      { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
    ], "侧栏打开失败不得影响主视图导航");
    assert.deepEqual(openFailure.handle.cleanupErrors, []);
  } finally {
    openFailure.unmountAll();
  }

  // 2) active() 抛错：按「没有证据」处理，绝不猜测、绝不抛给渲染路径。
  const throwingActive = sidebarRightToggleFixture({ openTabs: false });
  throwingActive.service.active = () => { throw new Error("active 读取失败"); };
  const activeFailure = mountTogglePanel({ fixture: throwingActive, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await activeFailure.handle.settle();
    assert.doesNotThrow(() => sidebarActionOf(rowByText(activeFailure.handle, "运行专家")).props.onClick(recordingEvent()));
    await activeFailure.handle.settle();
    assert.equal(sidebarOpenStateOf(activeFailure.handle, "运行专家"), "false", "active 抛错不得进入 <<");
    assert.equal(throwingActive.opened.length, 1, "打开请求照常发出");
  } finally {
    activeFailure.unmountAll();
  }

  // 3) split() 抛错：不能确认独立 pane 时 fail-closed，绝不回落到当前 pane。
  const throwingSplit = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  throwingSplit.service.split = () => { throw new Error("split 失败"); };
  const splitFailure = mountTogglePanel({ fixture: throwingSplit, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await splitFailure.handle.settle();
    assert.doesNotThrow(() => sidebarActionOf(rowByText(splitFailure.handle, "运行专家")).props.onClick(recordingEvent()));
    await splitFailure.handle.settle();
    assert.deepEqual(throwingSplit.opened, [], "split 抛错时不得回落到当前 pane 打开");
    assert.equal(sidebarOpenStateOf(splitFailure.handle, "运行专家"), "false", "split 抛错时必须保持打开语义");
  } finally {
    splitFailure.unmountAll();
  }

  // 4) split() 返回 undefined：同样不能把资源静默打开到当前 pane。
  const emptySplit = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  emptySplit.service.split = () => undefined;
  const emptySplitFailure = mountTogglePanel({ fixture: emptySplit, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await emptySplitFailure.handle.settle();
    assert.doesNotThrow(() => sidebarActionOf(rowByText(emptySplitFailure.handle, "运行专家")).props.onClick(recordingEvent()));
    await emptySplitFailure.handle.settle();
    assert.deepEqual(emptySplit.opened, [], "split 返回 undefined 时不得回落到当前 pane 打开");
    assert.equal(sidebarOpenStateOf(emptySplitFailure.handle, "运行专家"), "false", "split 返回 undefined 时必须保持打开语义");
  } finally {
    emptySplitFailure.unmountAll();
  }

  // 5) close() 抛错：保持 <<（用户可以再点一次），宿主恢复后再次点击才复位。
  const throwingClose = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  throwingClose.hooks.onClose = () => { throw new Error("close 失败"); };
  const closeFailure = mountTogglePanel({ fixture: throwingClose, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await closeFailure.handle.settle();
    sidebarActionOf(rowByText(closeFailure.handle, "运行专家")).props.onClick(recordingEvent());
    await closeFailure.handle.settle();
    assert.equal(sidebarOpenStateOf(closeFailure.handle, "运行专家"), "true", "打开成功必须进入 <<");
    sidebarActionOf(rowByText(closeFailure.handle, "运行专家")).props.onClick(recordingEvent());
    await closeFailure.handle.settle();
    assert.equal(sidebarOpenStateOf(closeFailure.handle, "运行专家"), "true", "关闭抛错时必须保持可关闭状态，绝不假装已关闭");
    assert.deepEqual(throwingClose.closed, ["tab-a"], "抛错的那次也必须使用记录里的精确 tabId");
    assert.equal(throwingClose.opened.length, 1, "关闭失败不得改走打开路径");

    throwingClose.hooks.onClose = null;
    sidebarActionOf(rowByText(closeFailure.handle, "运行专家")).props.onClick(recordingEvent());
    await closeFailure.handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口。
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
    // 这里推进两次轮询采样，验证链完成后箭头才复位。
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口。
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    await closeFailure.intervals.tick();
    await closeFailure.handle.settle();
    assert.deepEqual(throwingClose.closed, ["tab-a", "tab-a"]);
    assert.equal(sidebarOpenStateOf(closeFailure.handle, "运行专家"), "false", "宿主恢复后重试关闭必须复位");
  } finally {
    closeFailure.unmountAll();
  }

  // 6) 重入点击：openResource 同步栈里再次点击同一行，pending 锁只允许一次动作穿过。
  const reentrant = sidebarRightToggleFixture();
  const reentrantPanel = mountTogglePanel({ fixture: reentrant, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await reentrantPanel.handle.settle();
    const arrow = sidebarActionOf(rowByText(reentrantPanel.handle, "运行专家"));
    let reentered = 0;
    reentrant.hooks.onOpen = () => {
      reentered += 1;
      if (reentered === 1) arrow.props.onClick(recordingEvent());
    };
    arrow.props.onClick(recordingEvent());
    await reentrantPanel.handle.settle();
    assert.equal(reentered, 1, "宿主同步回调里确实发生了重入点击");
    assert.equal(reentrant.opened.length, 1, "同一 key 在途时的重入点击必须被 pending 挡下（不得打开第二个 tab）");
    assert.deepEqual(reentrant.closed, [], "重入点击不得误走关闭路径");
    assert.equal(sidebarOpenStateOf(reentrantPanel.handle, "运行专家"), "true", "一次点击 + 一次重入只产生一个已打开状态");
  } finally {
    reentrantPanel.unmountAll();
  }
});

test("侧栏箭头 toggle：缺 close/active 或左箭头图标时保持旧宿主静态 >> 行为，绝不出现假 toggle", async () => {
  // 1) 旧宿主只有 openResource（没有 active/close）：按钮保持原有静态打开语义，不带 toggle 标记。
  const legacy = mountContractPanel({ addresses: TOGGLE_ADDRESSES });
  try {
    await legacy.handle.settle();
    const arrow = sidebarActionOf(rowByText(legacy.handle, "运行专家"));
    assert.ok(arrow, "旧宿主（有 openResource）仍必须渲染箭头");
    assert.equal(arrow.props["aria-pressed"], undefined, "没有可关闭能力时不得声明 toggle 语义");
    assert.equal(arrow.props["data-open"], undefined, "没有可关闭能力时不得声明打开状态");
    assert.equal(arrow.props["aria-label"], "在侧边栏打开 运行专家");
    assertArrowDirection(legacy.handle, "运行专家", "chevron-right", "静态行为下只有右箭头");
    arrow.props.onClick(recordingEvent());
    assert.deepEqual(legacy.resourceCalls, [{
      address: TOGGLE_ADDRESS,
      options: { kind: "subagentchat", preferNewPane: true },
    }], "旧宿主缺 split 时继续使用 preferNewPane");
    arrow.props.onClick(recordingEvent());
    assert.equal(legacy.resourceCalls.length, 2, "旧宿主行为下再次点击仍然是打开（没有关闭语义）");
  } finally {
    legacy.handle.unmount();
    legacy.restore();
  }
  assert.equal(legacy.intervals.active, 0, "卸载后不得遗留轮询定时器");

  // 2) 有 active/close 但 primitives 缺 IconChevronLeftOutlineRegular：绝不显示「点了不会关」的假 <<。
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const withoutLeftIcon = mountContractPanel({
    addresses: TOGGLE_ADDRESSES,
    sidebarRight: fixture.service,
    primitives: { ...sidebarArrowPrimitives, IconChevronLeftOutlineRegular: undefined },
  });
  try {
    await withoutLeftIcon.handle.settle();
    const arrow = sidebarActionOf(rowByText(withoutLeftIcon.handle, "运行专家"));
    assert.ok(arrow, "缺左箭头图标不影响渲染打开箭头");
    assert.equal(arrow.props["aria-pressed"], undefined, "缺左箭头图标时不得声明 toggle 语义");
    assert.equal(arrow.props["data-open"], undefined);
    assertArrowDirection(withoutLeftIcon.handle, "运行专家", "chevron-right", "缺左箭头图标时只有右箭头");
    arrow.props.onClick(recordingEvent());
    await withoutLeftIcon.handle.settle();
    assert.equal(sidebarActionOf(rowByText(withoutLeftIcon.handle, "运行专家")).props["data-open"], undefined, "缺左箭头图标时绝不进入可关闭状态");
    arrow.props.onClick(recordingEvent());
    assert.equal(fixture.opened.length, 2, "缺左箭头图标时点击仍然是打开语义");
    assert.deepEqual(fixture.closed, [], "缺左箭头图标时绝不允许关闭");
  } finally {
    withoutLeftIcon.handle.unmount();
    withoutLeftIcon.restore();
  }
  assert.equal(withoutLeftIcon.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：同一 root 的不同 Session 不复用旧 tab 记录或旧箭头 handler", async () => {
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "root-tab" });
  const mounted = mountPanel({
    scopeSessionId: "root-1",
    resolveRootSessionId: (sessionId) => (sessionId === "child-1" ? "root-1" : sessionId),
    primitives: sidebarArrowPrimitives,
    sidebarRight: fixture.service,
  });
  try {
    await mounted.handle.settle();
    const rootArrow = sidebarActionOf(rowByText(mounted.handle, "运行专家"));
    rootArrow.props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true");

    // root/child 属于同一 root tree，但 sidebarRight 的 tab 域按 Session 隔离。
    mounted.handle.rerender({ scope: { sessionId: "child-1" } });
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "false", "新 Session 不得借用旧 Session 的 <<");

    // 旧 DOM handler 即使迟到触发，也不能把 root Session 的 tabId 交给当前 surface。
    rootArrow.props.onClick(recordingEvent());
    assert.deepEqual(fixture.closed, [], "Session 切换后的旧箭头不得调用 close()");
    assert.equal(fixture.opened.length, 1, "Session 切换后的旧箭头不得重新打开资源");

    mounted.handle.rerender({ scope: { sessionId: "root-1" } });
    await mounted.handle.settle();
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "true", "返回旧 Session 时仍保留其自己的记录");
  } finally {
    mounted.handle.unmount();
    mounted.restore();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("侧栏箭头 toggle：状态按 rootSessionId 隔离，切换 root 期间不复位也不关闭别的会话的 tab", async () => {
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-a" });
  const dom = rightbarDomStub();
  dom.mountPanel();
  dom.addTab("tab-a");
  const mounted = mountTogglePanel({ dom, fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  const { handle, intervals } = mounted;
  try {
    await handle.settle();
    sidebarActionOf(rowByText(handle, "运行专家")).props.onClick(recordingEvent());
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true");

    // 切到另一个 root：同一个资源地址在新 root 上是另一条记录，必须显示未打开。
    dom.removeTab("tab-a");
    fixture.setActive(null);
    handle.rerender({ scope: { sessionId: "root-2" } });
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "false", "新 root 上的同地址资源是独立状态，必须回到 >>");
    // 在 root-2 上多跑几轮同步：root-1 的记录必须原样保留（不检查、不删除）。
    await intervals.tick();
    await intervals.tick();
    await intervals.tick();

    handle.rerender({ scope: { sessionId: "root-1" } });
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "root 切换期间绝不复位别的 root 的记录");
    fixture.forgetOpenTab("tab-a");
    assert.deepEqual(fixture.closed, [], "root 切换绝不调用 close()：旧会话的 tab 不能被跨会话关闭");
    assert.equal(fixture.opened.length, 1, "root 切换不得重新打开资源");

    // 回到 root-1 后证据确实缺失（DOM 里没有该芯片、active 也不是它）：再观测两次才复位。
    // 注意切换回 root-1 时 effect 会立刻同步一次（可能已经记了一次缺失），因此这里用轮询推满确认次数。
    await intervals.tick();
    await intervals.tick();
    await handle.settle();
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "false", "回到原 root 后仍要按证据复位");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

/**
 * ── 标题行批量关闭（当前右侧栏） ─────────────────────────────────────────────────
 *
 * 主代理行与空闲分组标题行各有一个批量入口：
 * - 主代理行只覆盖当前 root 里 runtimeStatusOfNode(...) === "running" 的普通专家与最新 fan-out 分片；
 * - 空闲分组标题行只覆盖当前 idleChildren（ready 直接专家）；
 * - 候选来自当前 install 实例的 sidebarRight.openTabs inventory ∩ 上述规范地址集合，
 *   并严格按 sidebarSessionId 隔离；inventory 不可读时既不显示零圆点、也不发出任何关闭。
 *
 * 下面这组用例全部通过 installExpertGroupSidebar → createExpertGroupPanel 的现有接缝驱动，
 * 不新增任何正式导出 API。
 */

/** 批量用例共用的 Host 快照：一个运行中专家、一个空闲专家、一个含 running/failed/重试 三个分片的任务。 */
function batchPanelSnapshot() {
  return {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh",
      content: "当前目标内容", status: "running", continuable: false,
      children: [
        { id: "expert-running", kind: "expert", sessionId: "expert-running", taskName: "运行专家", role: "fixer", content: "实现运行任务", status: "running", continuable: true },
        { id: "expert-ready", kind: "expert", sessionId: "expert-ready", taskName: "空闲专家", role: "explorer", content: "已完成任务", status: "ready", continuable: true },
        {
          id: "fan-1", kind: "fanout", parentTaskId: "fan-1", role: "fixer", status: "running",
          shards: [
            { shardId: "running-shard", prompt: "运行中的分片提示", role: "fixer", status: "running", childId: "running-child", attempts: [{ attempt: 1, status: "running", childId: "running-child" }] },
            { shardId: "failed-shard", prompt: "失败分片的提示", role: "designer", status: "failed", childId: "new-child", attempts: [{ attempt: 1, status: "failed", childId: "old-child" }, { attempt: 2, status: "failed", childId: "new-child" }] },
            // 重试分片：分片行代表**最新** attempt（retry-new-child），旧 attempt（retry-old-child）已经被
            // 新一轮取代。旧 attempt 的子会话可能还留着右栏 tab，但它不是这一行的导航目标，也绝不是
            // 批量候选——只有 shard.childId 对应的地址能进候选集合。
            {
              shardId: "retried-shard", prompt: "重试分片的提示", role: "explorer", status: "running",
              childId: "retry-new-child",
              attempts: [
                { attempt: 1, status: "running", childId: "retry-old-child" },
                { attempt: 2, status: "running", childId: "retry-new-child" },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** 与 batchPanelSnapshot 同源的宿主权威地址表（批量候选必须与单会话箭头指向同一个 contentId）。 */
const BATCH_ADDRESSES = {
  "expert-running": { parentSessionId: "root-1", childSessionId: "expert-running", mode: "continuable" },
  "expert-ready": { parentSessionId: "root-1", childSessionId: "expert-ready", mode: "continuable" },
  "running-child": { parentSessionId: "root-1", childSessionId: "running-child", mode: "continuable" },
  "new-child": { parentSessionId: "root-1", childSessionId: "new-child", mode: "one-shot" },
  "retry-new-child": { parentSessionId: "root-1", childSessionId: "retry-new-child", mode: "continuable" },
  // 旧 attempt 的地址与最新 attempt 同 mode：它落选的原因只能是「分片行只代表最新 childId」，
  // 而不是模式差异——这样用例证明的才是 attempt 规则本身。
  "retry-old-child": { parentSessionId: "root-1", childSessionId: "retry-old-child", mode: "continuable" },
};

const BATCH_ADDRESS_RUNNING = "dsh-resource://subagentchat/session/expert-running?parent=root-1&mode=continuable";
const BATCH_ADDRESS_READY = "dsh-resource://subagentchat/session/expert-ready?parent=root-1&mode=continuable";
const BATCH_ADDRESS_SHARD = "dsh-resource://subagentchat/session/running-child?parent=root-1&mode=continuable";
const BATCH_ADDRESS_FAILED_SHARD = "dsh-resource://subagentchat/session/new-child?parent=root-1&mode=one-shot";
const BATCH_ADDRESS_RETRY_SHARD = "dsh-resource://subagentchat/session/retry-new-child?parent=root-1&mode=continuable";
const BATCH_ADDRESS_RETRY_OLD_CHILD = "dsh-resource://subagentchat/session/retry-old-child?parent=root-1&mode=continuable";

/**
 * 批量控件所在的标题行：主代理行是 .deg_expert_group_row_main，空闲分组标题行是
 * .deg_expert_group_row.deg_expert_group_idle_header（它不是 row_main，必须分别定位）。
 */
function batchRowOf(handle, label) {
  if (label === "空闲子代理") return byClass(handle.output, "deg_expert_group_idle_header")[0];
  return rowByText(handle, label);
}

/** 标题行批量关闭按钮；不存在时返回 undefined。 */
function batchActionOf(handle, label) {
  const row = batchRowOf(handle, label);
  return row === undefined ? undefined : byClass(row, "deg_expert_group_sidebar_batch_action")[0];
}

/** 行尾零状态圆点；不存在时返回 undefined。 */
function batchZeroOf(handle, label) {
  const row = batchRowOf(handle, label);
  return row === undefined ? undefined : byClass(row, "deg_expert_group_sidebar_batch_zero")[0];
}

/** 批量用例夹具：完整右栏能力 + 可注入 inventory 快照；tabId 由地址稳定派生。 */
function mountBatchPanel(options = {}) {
  const fixture = sidebarRightToggleFixture({
    paneId: null,
    tabIdFor: (address) => "tab-" + address.slice(address.lastIndexOf("/") + 1).split("?")[0],
    // 真实宿主在把 tab 提交进 inventory 时就会读取 contentId；损坏记录在那里被跳过，
    // 插件看到的仍然是一份可读的数组。单条记录内部抛错的解析边界由 install 契约用例覆盖。
    snapshotOpenTabs: (snapshot) => {
      if (typeof options.snapshotOpenTabs === "function") return options.snapshotOpenTabs(snapshot);
      return snapshot.filter((tab) => {
        try { return typeof tab.contentId === "string"; } catch { return false; }
      });
    },
  });
  // 「inventory 读面本身不可读」的形状：整个 openTabs 属性读取即抛错（真实宿主的未就绪服务）。
  if (options.unreadableInventory === true) {
    Object.defineProperty(fixture.service, "openTabs", { get() { throw new Error("inventory 尚未就绪"); } });
  }
  // 能力缺失形状：批量关闭只依赖公开 inventory + close()，因此这两个开关用来把「宿主没有打开
  // 能力」「宿主没有关闭能力」两种情况分别隔离出来（真实宿主的方法可能逐个缺失）。
  if (options.withoutOpenResource === true) delete fixture.service.openResource;
  if (options.withoutClose === true) delete fixture.service.close;
  const mounted = mountContractPanel({
    // 默认用与 batchPanelSnapshot 同源的地址表；需要额外 child 的用例可注入 options.addresses，
    // 注入的地址表必须自包含（不做合并），避免用例之间互相影响。
    sessions: addressedSessionsFixture(options.addresses ?? BATCH_ADDRESSES),
    hostSnapshot: options.hostSnapshot ?? batchPanelSnapshot(),
    sidebarRight: fixture.service,
  });
  return { ...mounted, fixture };
}

test("批量关闭：主代理行只关当前 root 的 running 专家与最新 running 分片，idle/其它 session/损坏记录一律跳过", async () => {
  const mounted = mountBatchPanel();
  const { handle, fixture, intervals, restore } = mounted;
  try {
    await handle.settle();
    // inventory 里放满「不该被关」的形状：其它 session、非 subagentchat、缺 contentId、
    // 重复 tabId，以及一条 contentId 为空的残缺记录。
    fixture.addOpenTab({ id: "tab-expert-running", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    // 同一个 tabId 重复出现：去重后只能关闭一次。
    fixture.addOpenTab({ id: "tab-expert-running", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-running-child", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_SHARD });
    // failed 分片的最新 attempt（new-child）不是 running：它的 tab 绝不能被批量关闭。
    fixture.addOpenTab({ id: "tab-new-child", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_FAILED_SHARD });
    fixture.addOpenTab({ id: "tab-other-session", sessionId: "root-2", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-guide", sessionId: "root-1", kind: "guide", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-no-content", sessionId: "root-1", kind: "subagentchat" });
    await handle.settle();

    const rootRow = rowByText(handle, "主代理");
    assert.ok(rootRow, "主代理行必须渲染");
    assert.equal(rootRow.children.length, 2, "主代理行是「标题 + 元数据」两行结构");
    const taskLine = byClass(rootRow, "deg_expert_group_task_line")[0];
    const batch = batchActionOf(handle, "主代理");
    assert.ok(batch, "候选存在时必须渲染批量关闭按钮");
    // 标题和批量 slot 必须是同一 inline flex 行的相邻项；位置由标题宽度决定，而非行尾对齐。
    assert.equal(taskLine.children.length, 2, "批量能力可用时标题行只包含标题和紧邻的 trailing slot");
    assert.deepEqual(String(taskLine.props.className).split(/\s+/), ["deg_expert_group_task_line", "deg_expert_group_task_line_trailing"]);
    assert.equal(taskLine.children[0].props.className.includes("deg_expert_group_task"), true, "标题是行内首项");
    const trailing = taskLine.children[1];
    assert.deepEqual(String(trailing.props.className).split(/\s+/), ["deg_expert_group_trailing"]);
    assert.equal(byClass(trailing, "deg_expert_group_sidebar_batch_action")[0], batch);
    const idleRow = byClass(handle.output, "deg_expert_group_idle_header")[0];
    const idleTitleLine = byClass(idleRow, "deg_expert_group_idle_title_line")[0];
    assert.ok(idleTitleLine, "空闲标题须与批量控件共享标题行");
    assert.equal(idleRow.children.length, 3, "空闲标题行不再设置独立的第四个尾列");
    assert.equal(idleTitleLine.children[0].props.className, "deg_expert_group_line deg_expert_group_task", "标题文案是内联行首项");
    assert.equal(idleTitleLine.children[1].props.className, "deg_expert_group_trailing", "空闲批量控件紧跟标题文字");
    assert.equal(byClass(idleTitleLine, "deg_expert_group_sidebar_batch_action")[0], batchActionOf(handle, "空闲子代理"));
    // 普通任务行没有批量 slot：第一行仍是「任务文字 + 单会话箭头」两项。
    assert.equal(byClass(rowByText(handle, "运行专家"), "deg_expert_group_task_line")[0].children.length, 2);
    assert.equal(batch.type, "button");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 2 个运行中的子代理");
    assert.equal(batch.props.title, batch.props["aria-label"]);
    assert.equal(batch.props["aria-pressed"], undefined, "批量关闭是命令而不是 toggle，绝不使用 aria-pressed");
    assert.equal(batch.props.disabled, false);
    assert.equal(byClass(batch, "deg_expert_group_double_arrow")[0].children.length, 2, "批量按钮必须是两个左尖括号");
    assert.equal(batchZeroOf(handle, "主代理"), undefined, "有候选时绝不显示零圆点");

    const event = recordingEvent();
    await batch.props.onClick(event);
    await handle.settle();
    // expert-running 只出现一次（重复 tabId 去重）；new-child 是 failed 分片，绝不关闭。
    // 顺序即 inventory 顺序；重复 tabId 只关一次，failed 分片与其它 session/kind/缺字段记录一律不关。
    assert.deepEqual(fixture.closed, ["tab-expert-running", "tab-running-child"]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(mounted.navTargets, [], "批量关闭绝不触发主视图导航");
    assert.equal(fixture.opened.length, 0, "批量关闭绝不打开任何资源");
    assert.equal(batchActionOf(handle, "主代理"), undefined, "全部候选关闭后批量按钮必须消失");
    assert.ok(batchZeroOf(handle, "主代理"), "inventory 仍可读且候选为零时必须回到零圆点");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("批量关闭：只关最新 attempt 的 child tab，旧 attempt 的 tab 绝不被批量关闭", async () => {
  const mounted = mountBatchPanel();
  const { handle, fixture, intervals, restore } = mounted;
  try {
    // 同一个分片的两个 attempt 各留了一个右栏 tab：旧 attempt 的 childId 已经不是分片行的
    // 导航目标，只有最新 attempt 才是 running 候选。
    fixture.addOpenTab({ id: "tab-retry-old-child", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RETRY_OLD_CHILD });
    fixture.addOpenTab({ id: "tab-retry-new-child", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RETRY_SHARD });
    await handle.settle();

    const batch = batchActionOf(handle, "主代理");
    assert.ok(batch, "最新 attempt 是 running，必须渲染批量关闭按钮");
    // 候选只有一个：旧 attempt 的地址根本不在运行中候选集合里，绝不进 aria-label 的计数。
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");

    await batch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-retry-new-child"], "批量关闭只能关最新 attempt 的 tab");
    const remaining = fixture.openTabs.map((tab) => tab.tabId);
    assert.equal(remaining.includes("tab-retry-old-child"), true, "旧 attempt 的 tab 必须原样留在 inventory 里");
    assert.equal(remaining.includes("tab-retry-new-child"), false, "最新 attempt 的 tab 必须被宿主关闭");
    assert.equal(batchActionOf(handle, "主代理"), undefined, "最新 attempt 关闭后候选清空，批量按钮消失");
    assert.ok(batchZeroOf(handle, "主代理"), "旧 attempt 的 tab 不是候选，因此这一行回到零圆点");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("批量关闭：空闲分组标题行只关 ready idleChildren，运行中专家保留", async () => {
  const mounted = mountBatchPanel();
  const { handle, fixture, intervals, restore } = mounted;
  try {
    fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    fixture.addOpenTab({ id: "tab-running", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    await handle.settle();

    const idleBatch = batchActionOf(handle, "空闲子代理");
    assert.ok(idleBatch, "空闲分组标题行必须有批量关闭按钮");
    assert.equal(idleBatch.props["aria-label"], "在侧边栏关闭 1 个空闲子代理");
    // 主代理行只看到运行中的那一个：空闲成员绝不混入运行中集合。
    assert.equal(batchActionOf(handle, "主代理").props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");

    await idleBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-idle"], "空闲批量只关闭 ready 成员");
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "运行中专家必须保留");
    assert.ok(batchZeroOf(handle, "空闲子代理"), "空闲候选清空后该行回到零圆点");
    assert.equal(batchActionOf(handle, "空闲子代理"), undefined, "空闲候选清空后批量按钮必须消失");
    assert.equal(batchActionOf(handle, "主代理").props["aria-label"], "在侧边栏关闭 1 个运行中的子代理", "运行中候选不受空闲批量影响");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("批量关闭：inventory 已知为空时渲染非交互零圆点且不产生任何关闭；未知 inventory 既不显示零也不显示按钮", async () => {
  // 已知空数组：两行都显示零圆点（空闲分组此时也显示「空闲子代理（0）」）。
  const empty = mountBatchPanel({ snapshotOpenTabs: () => [] });
  try {
    await empty.handle.settle();
    assert.equal(textOf(batchRowOf(empty.handle, "空闲子代理")), "空闲子代理（1）", "空闲分组标题始终显示当前成员数");
    for (const label of ["主代理", "空闲子代理"]) {
      const zero = batchZeroOf(empty.handle, label);
      assert.ok(zero, label + "：已知空 inventory 必须渲染零圆点");
      assert.equal(zero.type, "span", "零圆点不是按钮");
      assert.equal(zero.props["data-zero"], "true");
      assert.equal(zero.props.onClick, undefined);
      assert.equal(zero.props.tabIndex, undefined, "零圆点绝不进入键盘焦点序列");
      assert.equal(zero.props["aria-hidden"], "true");
      assert.equal(batchActionOf(empty.handle, label), undefined, "零状态绝不出现可点击的批量按钮");
    }
    assert.deepEqual(empty.fixture.closed, [], "零状态点击面不存在，绝不发出任何 close");
  } finally {
    empty.handle.unmount();
    empty.restore();
  }

  // snapshot 已知但没有 idleChildren：空闲分组仍显示「空闲子代理（0）」与零圆点。
  const noIdleSnapshot = batchPanelSnapshot();
  noIdleSnapshot.root.children = noIdleSnapshot.root.children.filter((node) => node.kind !== "expert" || node.id !== "expert-ready");
  const noIdle = mountBatchPanel({ snapshotOpenTabs: () => [], hostSnapshot: noIdleSnapshot });
  try {
    await noIdle.handle.settle();
    assert.equal(textOf(batchRowOf(noIdle.handle, "空闲子代理")), "空闲子代理（0）", "没有 idleChildren 时仍要显示零状态");
    assert.ok(batchZeroOf(noIdle.handle, "空闲子代理"), "没有 idleChildren 时仍要渲染零圆点");
    assert.equal(batchActionOf(noIdle.handle, "空闲子代理"), undefined, "零成员绝不出现可点击的批量按钮");
  } finally {
    noIdle.handle.unmount();
    noIdle.restore();
  }

  // 未知 inventory（读面返回 null）：绝不假报零。
  const unknown = mountBatchPanel({ unreadableInventory: true });
  try {
    await unknown.handle.settle();
    for (const label of ["主代理", "空闲子代理"]) {
      assert.equal(batchZeroOf(unknown.handle, label), undefined, label + "：inventory 不可读时绝不显示零圆点");
      assert.equal(batchActionOf(unknown.handle, label), undefined, label + "：inventory 不可读时绝不显示批量按钮");
    }
    assert.deepEqual(unknown.fixture.closed, [], "未知状态绝不发出任何 close");
  } finally {
    unknown.handle.unmount();
    unknown.restore();
  }
});

test("批量关闭：状态模型不依赖打开能力——缺 close 时不误报零、缺 openResource 时控件照常", async () => {
  // 1) inventory 已知为空 + 缺 close：零状态只由「候选为空」决定，仍然显示非交互蓝点。
  const emptyWithoutClose = mountBatchPanel({ withoutClose: true, snapshotOpenTabs: () => [] });
  try {
    await emptyWithoutClose.handle.settle();
    for (const label of ["主代理", "空闲子代理"]) {
      const zero = batchZeroOf(emptyWithoutClose.handle, label);
      assert.ok(zero, label + "：缺 close 时已知空 inventory 仍必须显示零圆点");
      assert.equal(zero.type, "span", "零圆点不是按钮");
      assert.equal(zero.props["data-zero"], "true");
      assert.equal(zero.props.onClick, undefined, "零圆点绝不可交互");
      assert.equal(batchActionOf(emptyWithoutClose.handle, label), undefined, "零状态绝不出现关闭按钮");
    }
    assert.deepEqual(emptyWithoutClose.fixture.closed, [], "零状态绝不发出任何 close");
  } finally {
    emptyWithoutClose.handle.unmount();
    emptyWithoutClose.restore();
  }

  // 2) inventory 里有本行的打开会话，但宿主没有 close：既不显示零点（绝不误报「零」），
  //    也不显示一个点了不会关的按钮——这一行整个不出现行尾控件。
  const candidateWithoutClose = mountBatchPanel({ withoutClose: true });
  try {
    candidateWithoutClose.fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    candidateWithoutClose.fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    await candidateWithoutClose.handle.settle();
    for (const label of ["主代理", "空闲子代理"]) {
      assert.equal(batchZeroOf(candidateWithoutClose.handle, label), undefined, label + "：有候选但关不掉时绝不误报零圆点");
      assert.equal(batchActionOf(candidateWithoutClose.handle, label), undefined, label + "：close 缺失时绝不渲染无法使用的关闭按钮");
    }
    assert.deepEqual(candidateWithoutClose.fixture.closed, [], "缺 close 时绝不发出任何关闭");
  } finally {
    candidateWithoutClose.handle.unmount();
    candidateWithoutClose.restore();
  }

  // 3) 缺 openResource 但 inventory 与 close 都可用：批量控件完全不依赖打开能力，照常显示并按状态工作。
  const withoutOpen = mountBatchPanel({ withoutOpenResource: true });
  try {
    withoutOpen.fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    withoutOpen.fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    await withoutOpen.handle.settle();
    const runningBatch = batchActionOf(withoutOpen.handle, "主代理");
    assert.ok(runningBatch, "缺 openResource 时主代理行的批量关闭按钮仍必须渲染");
    assert.equal(runningBatch.props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");
    const idleBatch = batchActionOf(withoutOpen.handle, "空闲子代理");
    assert.ok(idleBatch, "缺 openResource 时空闲分组标题行的批量关闭按钮仍必须渲染");
    assert.equal(idleBatch.props["aria-label"], "在侧边栏关闭 1 个空闲子代理");

    await idleBatch.props.onClick(recordingEvent());
    await withoutOpen.handle.settle();
    assert.deepEqual(withoutOpen.fixture.closed, ["tab-idle"], "缺 openResource 时批量关闭照常工作");
    assert.ok(batchZeroOf(withoutOpen.handle, "空闲子代理"), "空闲候选清空后回到零圆点");
    assert.equal(withoutOpen.fixture.opened.length, 0, "批量关闭绝不打开任何资源");

    // 关闭能力缺失 + 打开能力也缺失时，仍按上面的状态模型：候选存在 → 不渲染任何控件。
    const bare = mountBatchPanel({ withoutOpenResource: true, withoutClose: true });
    try {
      bare.fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
      await bare.handle.settle();
      assert.equal(batchZeroOf(bare.handle, "主代理"), undefined, "两个能力都缺时绝不误报零圆点");
      assert.equal(batchActionOf(bare.handle, "主代理"), undefined, "两个能力都缺时绝不渲染关闭按钮");
    } finally {
      bare.handle.unmount();
      bare.restore();
    }
  } finally {
    withoutOpen.handle.unmount();
    withoutOpen.restore();
  }
});

test("批量关闭：逐项 await 且单项抛错/reject 只跳过该项，pending 期间拒绝重复点击", async () => {
  const mounted = mountBatchPanel();
  const { handle, fixture, intervals, restore } = mounted;
  try {
    // 三个**互不相同**的 running 候选（普通专家 + 两个最新分片 attempt）：第三项必须是真正的
    // 候选，否则「继续到第三项」这条断言会被一个根本不在候选集合里的 tab 伪造出来。
    fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-b", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_SHARD });
    fixture.addOpenTab({ id: "tab-c", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RETRY_SHARD });
    // 第一次 close 同步抛错、第二次 reject：序列必须继续到第三次，且失败项绝不被标成已关闭。
    fixture.hooks.onClose = (tabId) => {
      if (tabId === "tab-a") throw new Error("宿主拒绝关闭");
      if (tabId === "tab-b") return Promise.reject(new Error("宿主异步拒绝"));
      return undefined;
    };
    await handle.settle();

    const batch = batchActionOf(handle, "主代理");
    assert.ok(batch, "运行中候选必须渲染批量按钮");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 3 个运行中的子代理", "三个 running 候选缺一不可");
    await batch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-a", "tab-b", "tab-c"], "单项失败必须隔离并继续其余项");
    // 成功项由宿主 inventory 结算：它从公开 inventory 里消失；两个失败项仍在（夹具只在 Promise
    // resolve 后才移除记录，因此这两条断言证明的是「失败项确实没有被标成已关闭」）。
    const remaining = fixture.openTabs.map((tab) => tab.tabId);
    assert.equal(remaining.includes("tab-c"), false, "成功关闭的 tab 必须从宿主 inventory 消失");
    assert.equal(remaining.includes("tab-a"), true, "同步抛错的 tab 仍留在 inventory 里");
    assert.equal(remaining.includes("tab-b"), true, "Promise reject 的 tab 仍留在 inventory 里");
    assert.equal(sidebarOpenStateOf(handle, "运行专家"), "true", "close 抛错的 tab 绝不能被标成已关闭");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 双击防重：第一次 close 在途期间按钮 disabled + aria-busy，第二次点击被聚合锁拦下。
  const pending = mountBatchPanel();
  try {
    pending.fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    pending.fixture.addOpenTab({ id: "tab-b", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_SHARD });
    // 同一个 scope 里的空闲分组也放一个候选：running 行与 idle 行共用同一把 scope 锁，必须互斥。
    pending.fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    // 受控 close：在途期间既不改 inventory 也不结算，从而把「pending 态本身」隔离出来观察。
    const pendingCloses = [];
    const resolvers = [];
    pending.fixture.service.close = (tabId) => {
      pendingCloses.push(tabId);
      return new Promise((resolve) => { resolvers.push(resolve); });
    };
    await pending.handle.settle();
    const first = batchActionOf(pending.handle, "主代理");
    assert.equal(first.props.disabled, false);
    const inFlight = first.props.onClick(recordingEvent());
    await pending.handle.settle();
    const whilePending = batchActionOf(pending.handle, "主代理");
    assert.ok(whilePending, "在途期间按钮仍必须存在");
    assert.equal(whilePending.props.disabled, true, "关闭序列在途期间按钮必须 disabled");
    assert.equal(whilePending.props["aria-busy"], true);
    // 同一 scope 的空闲分组批量按钮也必须 disabled：两个入口共用同一把 scope 锁（互斥）。
    const idleWhilePending = batchActionOf(pending.handle, "空闲子代理");
    assert.ok(idleWhilePending, "空闲分组仍有候选，按钮必须存在");
    assert.equal(idleWhilePending.props.disabled, true, "同一个 scope 的 idle 批量入口必须与 running 序列互斥");
    assert.equal(idleWhilePending.props["aria-busy"], true);
    await whilePending.props.onClick(recordingEvent());
    assert.deepEqual(pendingCloses, ["tab-a"], "pending 期间的重复点击绝不发出第二次 close");
    await idleWhilePending.props.onClick(recordingEvent());
    assert.deepEqual(pendingCloses, ["tab-a"], "同一 scope 的 idle 入口在途期间同样绝不发出 close");
    // 逐个结算：每释放一个在途 close，序列才会推进到下一个候选。
    resolvers.shift()();
    await pending.handle.settle();
    assert.deepEqual(pendingCloses, ["tab-a", "tab-b"], "释放后序列继续处理剩余候选");
    resolvers.shift()();
    await inFlight;
    await pending.handle.settle();
    assert.equal(batchActionOf(pending.handle, "主代理").props.disabled, false, "序列结算后锁必须释放");
    // 锁释放后空闲分组的入口同样恢复可用（空闲候选自始至终没有被 running 序列动过）。
    assert.equal(batchActionOf(pending.handle, "空闲子代理").props.disabled, false, "同一 scope 的锁释放后 idle 入口恢复可用");
    assert.deepEqual(pendingCloses, ["tab-a", "tab-b"], "running 序列只处理 running 候选，绝不关闭空闲成员的 tab");
  } finally {
    pending.handle.unmount();
    pending.restore();
  }
  assert.equal(pending.intervals.active, 0);
});

test("批量关闭：root 切换后停止后续关闭，且旧 root 的在途锁绝不阻塞或污染新 root", async () => {
  const mounted = mountBatchPanel();
  const { handle, fixture, intervals, restore } = mounted;
  try {
    // 两个 root 各有自己的候选：root-1 两个 tab、root-2 两个 tab。右栏 tab 域按 session 隔离，
    // 因此 root-2 的候选只能来自 sessionId === "root-2" 的记录。
    fixture.addOpenTab({ id: "tab-a", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-b", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_SHARD });
    fixture.addOpenTab({ id: "tab-r2-a", sessionId: "root-2", kind: "subagentchat", contentId: BATCH_ADDRESS_RUNNING });
    fixture.addOpenTab({ id: "tab-r2-b", sessionId: "root-2", kind: "subagentchat", contentId: BATCH_ADDRESS_SHARD });
    // 受控 close：每个 tabId 各留一个 resolver，用来精确控制「哪一个在途序列何时结算」。
    const resolvers = new Map();
    fixture.hooks.onClose = (tabId) => new Promise((resolve) => { resolvers.set(tabId, resolve); });
    const release = (tabId) => {
      const resolve = resolvers.get(tabId);
      assert.equal(typeof resolve, "function", tabId + "：该 close 必须在途");
      resolvers.delete(tabId);
      resolve();
    };
    await handle.settle();
    const batch = batchActionOf(handle, "主代理");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 2 个运行中的子代理");

    // root-1 的批量序列在第一个候选上挂起（宿主 Promise 不 settle）。
    const inFlight = batch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-a"], "root-1 的序列从第一个候选开始");
    assert.equal(batchActionOf(handle, "主代理").props.disabled, true, "root-1 自己的按钮在途期间必须 disabled");

    // 切到 root-2：旧 root 的锁绝不能落到新 root 上——root-2 的按钮必须保持可用。
    handle.rerender({ scope: { sessionId: "root-2" } });
    await handle.settle();
    const rootTwoBatch = batchActionOf(handle, "主代理");
    assert.ok(rootTwoBatch, "root-2 必须渲染自己的批量按钮");
    assert.equal(rootTwoBatch.props.disabled, false, "旧 root 的在途序列绝不能把新 root 的按钮置成 disabled");
    assert.equal(rootTwoBatch.props["aria-busy"], undefined, "新 root 不共享旧 root 的 aria-busy");

    // 新 root 的批量动作照常发出：它只处理 root-2 自己的候选。
    const rootTwoInFlight = rootTwoBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-a", "tab-r2-a"], "root-2 的批量序列必须能穿过旧 root 的锁");
    assert.equal(batchActionOf(handle, "主代理").props.disabled, true, "root-2 自己的序列在途期间按钮必须 disabled");

    // 旧 root 的 Promise 此刻才 settle：旧序列必须停下，且收尾不得改写 root-2 的锁。
    release("tab-a");
    await inFlight;
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-a", "tab-r2-a"], "root 切换后必须停止后续关闭（tab-b 绝不发出）");
    assert.equal(fixture.openTabs.some((tab) => tab.tabId === "tab-b"), true, "root-1 的第二个候选必须原样保留");
    assert.equal(batchActionOf(handle, "主代理").props.disabled, true, "旧 root 的收尾绝不清掉新 root 自己的在途锁");

    // root-2 的序列继续推进到自己的第二个候选，并在结算后释放自己的锁。
    release("tab-r2-a");
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-a", "tab-r2-a", "tab-r2-b"], "root-2 的序列按自己的候选继续");
    release("tab-r2-b");
    await rootTwoInFlight;
    await handle.settle();
    assert.equal(batchActionOf(handle, "主代理"), undefined, "root-2 候选清空后按钮必须消失");
    assert.ok(batchZeroOf(handle, "主代理"), "root-2 候选清空后回到零圆点");
    assert.deepEqual(fixture.closed, ["tab-a", "tab-r2-a", "tab-r2-b"], "root-1 的剩余候选自始至终没有被处理");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("分栏事务：目标 inventory 与 DOM pane 证据齐全后才提交，并拒绝错误 pane", async () => {
  const restoreViewport = installGlobals({ window: { innerWidth: 1600 } });
  const dom = rightbarDomStub();
  dom.mountPanel();
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-target", mintOnOpen: false });
  const callbacks = { begins: [], panes: [], opens: [], commits: [], cancels: [] };
  const mounted = mountTogglePanel({
    dom,
    fixture,
    panel: {
      addresses: TOGGLE_ADDRESSES,
      beginSidebarSplit(details) {
        callbacks.begins.push(details);
        return { token: "split-1" };
      },
      markSidebarSplitPane(token, paneId) {
        callbacks.panes.push({ token, paneId });
        return true;
      },
      markSidebarSplitOpen(token) {
        callbacks.opens.push(token);
        return true;
      },
      commitSidebarSplit(token, evidence) {
        callbacks.commits.push({ token, evidence });
        return true;
      },
      cancelSidebarSplit(token, details) {
        callbacks.cancels.push({ token, details });
      },
    },
  });
  try {
    await mounted.handle.settle();
    const arrow = sidebarActionOf(rowByText(mounted.handle, "运行专家"));
    assert.ok(arrow);
    const firstClick = arrow.props.onClick(recordingEvent());
    const secondClick = arrow.props.onClick(recordingEvent());
    await firstClick;
    await secondClick;
    assert.equal(fixture.opened.length, 1, "事务仍在途时重复点击不得重复打开资源");
    assert.deepEqual(callbacks.begins.map((item) => item.resourceAddress), [TOGGLE_ADDRESS]);
    assert.deepEqual(callbacks.panes, [{ token: "split-1", paneId: "pane-child" }]);
    assert.deepEqual(callbacks.opens, ["split-1"]);
    assert.deepEqual(callbacks.commits, [], "只有 split/openResource 回执还不能提交临时宽度");

    fixture.setActive({ id: "tab-target", kind: "subagentchat", contentId: TOGGLE_ADDRESS, title: "子代理会话" });
    dom.addTab("tab-target", "pane-wrong");
    mounted.observer.fire();
    await mounted.handle.settle();
    assert.deepEqual(callbacks.commits, [], "目标 tab 在错误 pane 时必须保持事务在途");

    // 同一 contentId 的首条 inventory 仍在错误 pane 时，不能遮蔽后续正确 pane 的记录。
    mounted.fixture.addOpenTab({
      id: "tab-target-right",
      kind: "subagentchat",
      contentId: TOGGLE_ADDRESS,
      title: "子代理会话",
    });
    mounted.fixture.setActive({
      id: "tab-target-right",
      kind: "subagentchat",
      contentId: TOGGLE_ADDRESS,
      title: "子代理会话",
    });
    dom.addTab("tab-target-right", "pane-child");
    mounted.observer.fire();
    await mounted.handle.settle();
    assert.deepEqual(callbacks.commits, [{
      token: "split-1",
      evidence: { tabId: "tab-target-right", paneId: "pane-child" },
    }], "必须继续搜索同地址记录，直到找到返回 pane 中的目标 tab");
    assert.deepEqual(callbacks.cancels, []);
  } finally {
    mounted.unmountAll();
    restoreViewport();
  }
});

test("分栏事务：install coordinator 准备失败时面板必须在 split 前中止", async () => {
  const fixture = sidebarRightToggleFixture({ tabIdFor: () => "tab-target" });
  const mounted = mountTogglePanel({
    fixture,
    panel: {
      addresses: TOGGLE_ADDRESSES,
      beginSidebarSplit() { return null; },
    },
  });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.equal(fixture.splits, 0, "准备事务失败时不得调用 split()");
    assert.deepEqual(fixture.opened, [], "准备事务失败时不得调用 openResource()");
    assert.equal(sidebarOpenStateOf(mounted.handle, "运行专家"), "false", "失败动作必须保持 >> 打开语义");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("分栏事务：split 后 inventory 暂时不可读时不得猜测 replaceTab", async () => {
  const fixture = sidebarRightToggleFixture({
    seedGuideOnSplit: true,
    snapshotOpenTabs(snapshot, state) {
      return state.splits > 0 ? null : snapshot;
    },
  });
  const mounted = mountTogglePanel({ fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.deepEqual(fixture.opened, [{
      address: TOGGLE_ADDRESS,
      options: { kind: "subagentchat", paneId: "pane-child", preferNewPane: false },
    }], "inventory 延迟时不得把猜测出的 guide id 传给 replaceTab");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("分栏事务：同一次 split 新增多个 guide 时不得替换任意一个", async () => {
  const fixture = sidebarRightToggleFixture({ seedGuideOnSplit: true, guideTabIds: ["guide-a", "guide-b"] });
  const mounted = mountTogglePanel({ fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.deepEqual(fixture.opened, [{
      address: TOGGLE_ADDRESS,
      options: { kind: "subagentchat", paneId: "pane-child", preferNewPane: false },
    }], "多个新增 guide 无法唯一归属时不得选择首条记录");
    assert.deepEqual(fixture.openTabs.filter((tab) => tab.kind === "guide").map((tab) => tab.tabId).sort(), ["guide-a", "guide-b"]);
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("分栏事务：其它 session 的新增 guide 不得作为当前 pane 的替换目标", async () => {
  const fixture = sidebarRightToggleFixture({ seedGuideOnSplit: true, guideTabId: "guide-foreign", guideSessionId: "other-root" });
  const mounted = mountTogglePanel({ fixture, panel: { addresses: TOGGLE_ADDRESSES } });
  try {
    await mounted.handle.settle();
    sidebarActionOf(rowByText(mounted.handle, "运行专家")).props.onClick(recordingEvent());
    await mounted.handle.settle();
    assert.deepEqual(fixture.opened, [{
      address: TOGGLE_ADDRESS,
      options: { kind: "subagentchat", paneId: "pane-child", preferNewPane: false },
    }], "跨 session 的 guide 不能证明当前 split 的 replaceTab 归属");
  } finally {
    mounted.unmountAll();
  }
  assert.equal(mounted.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

/**
 * 轻量（partial）快照的中性渲染。
 *
 * Host 首屏返回 partial:true 时，**没有活动证据**的节点必须保持中性：圆点既不声明运行、也不声明
 * 已结束（不渲染 done 绿点），摘要行不再输出活动文案；只要存在证据（目录 activity / 节点 running）
 * 或完整快照（partial:false）到达，渲染立即回到既有逻辑。partial 参与上屏内容比较，因此
 * 「内容相同但 partial 变了」也必须重新渲染。
 */
test("轻量快照只让证据不足的节点中性渲染，完整快照到达后恢复既有渲染", async () => {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  /** Host 轻量快照形状：partial:true；冷读被跳过的专家是 status=unknown 且没有 running 布尔。 */
  const partialHostSnapshot = () => {
    const base = snapshot();
    base.partial = true;
    base.root.status = "unknown";
    delete base.root.running;
    base.root.children.unshift({
      id: "expert-unknown", kind: "expert", sessionId: "expert-unknown", taskName: "待补全专家",
      role: "fixer", status: "unknown", continuable: true,
    });
    return base;
  };
  let hostSnapshot = partialHostSnapshot();
  let requestCount = 0;
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture([]),
    async requestPluginRpc() {
      requestCount += 1;
      return { ok: true, async json() { return { snapshot: { ...hostSnapshot, generatedAt: requestCount } }; } };
    },
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-1" }, ctx: { connection: {} } });
  try {
    await handle.settle();
    assert.ok(textOf(handle.output).includes("待补全专家"), "轻量快照的任务名必须直接上屏（不再等完整快照）");

    const rowOf = (label) => byClass(handle.output, "deg_expert_group_row").find((row) => textOf(row).includes(label));
    const unknownRow = rowOf("待补全专家");
    assert.equal(
      byClass(unknownRow, "deg_expert_group_status_icon")[0].props["data-status"],
      "unknown",
      "没有活动证据的节点在轻量快照里必须中性（不得声明已结束）",
    );
    assert.equal(byClass(unknownRow, "deg_expert_group_state_dot")[0].props["data-state"], "unknown", "兜底圆点同样中性");
    assert.equal(byClass(unknownRow, "deg_expert_group_content").length, 0, "摘要行已移除，中性态只由圆点表达");
    // 有证据（目录 activity=inactive）的专家不受 partial 影响：中性规则只针对「没有任何证据」。
    assert.equal(
      byClass(rowOf("空闲专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "有活动证据的节点照常渲染",
    );
    // fan-out 的状态来自本机 manager，与冷读无关：轻量快照下同样保持权威状态。
    assert.equal(byClass(handle.output, "deg_expert_group_fanout")[0].props["data-status"], "running");
    // 空闲分组是容器：轻量快照下它同样不声明「已结束」。
    assert.equal(
      byClass(byClass(handle.output, "deg_expert_group_idle_group")[0], "deg_expert_group_row")[0].props["data-status"],
      "unknown",
      "空闲分组容器在轻量快照下同样中性",
    );

    // 完整快照到达：任务树内容完全相同，只有 partial 由 true 变 false，也必须重新上屏。
    hostSnapshot = { ...partialHostSnapshot(), partial: false };
    await intervals.tick();
    await handle.settle();
    assert.ok(requestCount >= 2, "轮询照常发起 RPC");
    const refreshedRow = rowOf("待补全专家");
    assert.equal(
      byClass(refreshedRow, "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "完整快照到达后必须恢复既有渲染（partial 参与内容比较，不得被吞掉）",
    );
    assert.equal(byClass(refreshedRow, "deg_expert_group_state_dot")[0].props["data-state"], "ready");
    assert.equal(
      byClass(byClass(handle.output, "deg_expert_group_idle_group")[0], "deg_expert_group_row")[0].props["data-status"],
      "ready",
      "空闲分组容器恢复既有圆点",
    );
    assert.ok(textOf(handle.output).includes("待补全专家"), "任务名在两次渲染之间保持不变");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

/**
 * 轻量（partial）快照的证据规则必须一路贯穿到**空闲归组**与**空闲批量关闭候选**。
 *
 * Host 首屏的轻量快照跳过全部冷读：既没有 live session/agent 的专家被投影成 status=unknown
 * 且**省略 running**（host/expert-group-runtime.js 的 evidenceFree 分支）。这类节点「没有任何
 * 活动证据」，因此既不算 running 也不算 ready。
 *
 * ── 语义变更（修复 B：显示从宽、操作从严）──────────────────────────────────────
 * 原语义：unknown 节点**不进**空闲分组。
 * 新语义：unknown 节点**进**空闲分组**显示**（因此 partial 与 full 下的组内成员与顺序一致，
 *   不再出现「同一 fan-out 分组每隔 2.5 秒在两个位置之间来回跳」），但仍然**不参与**任何会真的
 *   操作宿主的动作：
 *   - 不进空闲批量关闭候选（一次误关会毁掉用户正在运行的会话）；
 *   - 不被 manual 抑制清理放过（状态无法证明，按 fail-closed 保留抑制）。
 *
 * 变更理由：位置稳定性属于展示正确性，而「是否可关闭」属于操作安全性；把两者解耦后，用户既不会
 * 看到条目跳位，也不会因为轻量快照的证据缺失而误关会话。断言因此从「不进组」改为「进组显示、
 * 但不进候选」，并新增「不被抑制清理放过」的断言。
 *
 * 与上一个用例的分工：那个用例锁「圆点/文案」的中性渲染，本用例锁「归组与批量关闭候选」
 * 这两个会真的改变行为的判定。
 */
test("轻量快照：没有活动证据的专家进空闲分组显示但不进空闲批量候选，完整快照到达后按证据恢复", async () => {
  const hostSnapshot = batchPanelSnapshot();
  // 冷读被跳过的专家：status=unknown、没有 running 布尔，且官方子代理目录里也没有它的条目
  // （首屏时 DSH 会话投影可能还没 hydrate）——这正是「没有任何活动证据」的形状。
  const warmingNode = {
    id: "expert-warming", kind: "expert", sessionId: "expert-warming", taskName: "待补全专家",
    role: "fixer", content: "冷读被跳过", status: "unknown", continuable: true,
  };
  hostSnapshot.root.children.unshift(warmingNode);
  hostSnapshot.partial = true;
  const mounted = mountBatchPanel({
    hostSnapshot,
    addresses: {
      ...BATCH_ADDRESSES,
      "expert-warming": { parentSessionId: "root-1", childSessionId: "expert-warming", mode: "continuable" },
    },
  });
  const { handle, fixture, intervals, restore } = mounted;
  const WARMING_ADDRESS = "dsh-resource://subagentchat/session/expert-warming?parent=root-1&mode=continuable";
  /** 某个节点的行容器（.deg_expert_group_row）：data-status 与树结构断言都读它。 */
  const statusRowOf = (label) => byClass(handle.output, "deg_expert_group_row").find((row) => textOf(row).includes(label));
  /** 空闲分组内成员容器的文本（分组折叠或不存在时为空串）。 */
  const idleMemberText = () => {
    const container = byClass(handle.output, "deg_expert_group_idle_children")[0];
    return container === undefined ? "" : textOf(container);
  };
  try {
    fixture.addOpenTab({ id: "tab-warming", sessionId: "root-1", kind: "subagentchat", contentId: WARMING_ADDRESS });
    fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    await handle.settle();

    // 中性圆点照旧；归组**放宽**（进组显示），但操作候选**不变**（仍然只有真正 ready 的那一个）。
    assert.equal(
      byClass(statusRowOf("待补全专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "unknown",
      "没有活动证据的节点在轻量快照里保持中性",
    );
    assert.equal(textOf(batchRowOf(handle, "空闲子代理")), "空闲子代理（2）", "无证据的专家也计入空闲成员数（显示从宽）");
    assert.equal(idleMemberText().includes("待补全专家"), true, "无证据的专家进入空闲分组显示（位置稳定性优先）");
    // 操作安全性不变：空闲批量候选只有真正 ready 的那一个，unknown 绝不成为「可以关闭」的目标。
    const idleBatch = batchActionOf(handle, "空闲子代理");
    assert.equal(idleBatch.props["aria-label"], "在侧边栏关闭 1 个空闲子代理", "候选数量只算有证据的成员（操作从严）");
    await idleBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-idle"], "空闲批量只能关掉有证据表明已空闲的成员");
    assert.equal(
      fixture.openTabs.map((tab) => tab.tabId).includes("tab-warming"),
      true,
      "状态无法证明的会话 tab 必须原样保留在 inventory 里",
    );

    // 完整快照到达：节点带上完整证据（status=ready + running=false），归组与候选按完整证据恢复。
    // 上一阶段被关掉的空闲 tab 由宿主清出了 inventory，这里补一个同地址的新 tab（用户重新打开），
    // 用来证明恢复后的候选集合同时包含两个空闲成员。
    fixture.addOpenTab({ id: "tab-idle-again", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    hostSnapshot.partial = false;
    warmingNode.status = "ready";
    warmingNode.running = false;
    await intervals.tick();
    await handle.settle();
    assert.equal(textOf(batchRowOf(handle, "空闲子代理")), "空闲子代理（2）", "完整快照到达后必须按完整证据恢复归组");
    assert.equal(idleMemberText().includes("待补全专家"), true, "完整证据下该专家回到空闲分组");
    assert.equal(
      byClass(statusRowOf("待补全专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "完整证据下圆点回到既有渲染",
    );
    const restoredBatch = batchActionOf(handle, "空闲子代理");
    assert.equal(restoredBatch.props["aria-label"], "在侧边栏关闭 2 个空闲子代理", "候选按完整证据恢复，不留永久性差异");
    await restoredBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(
      fixture.closed,
      ["tab-idle", "tab-warming", "tab-idle-again"],
      "恢复后的候选集合包含两个空闲成员，按 inventory 顺序逐个关闭（tab-warming 现在有完整证据）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});


/**
 * 轻量（partial）快照的中性渲染。
 *
 * Host 首屏返回 partial:true 时，**没有活动证据**的节点必须保持中性：圆点既不声明运行、也不声明
 * 已结束（不渲染 done 绿点），摘要行不再输出活动文案；只要存在证据（目录 activity / 节点 running）
 * 或完整快照（partial:false）到达，渲染立即回到既有逻辑。partial 参与上屏内容比较，因此
 * 「内容相同但 partial 变了」也必须重新渲染。
 */
test("轻量快照只让证据不足的节点中性渲染，完整快照到达后恢复既有渲染", async () => {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  /** Host 轻量快照形状：partial:true；冷读被跳过的专家是 status=unknown 且没有 running 布尔。 */
  const partialHostSnapshot = () => {
    const base = snapshot();
    base.partial = true;
    base.root.status = "unknown";
    delete base.root.running;
    base.root.children.unshift({
      id: "expert-unknown", kind: "expert", sessionId: "expert-unknown", taskName: "待补全专家",
      role: "fixer", status: "unknown", continuable: true,
    });
    return base;
  };
  let hostSnapshot = partialHostSnapshot();
  let requestCount = 0;
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: {},
    sessions: sessionsFixture([]),
    async requestPluginRpc() {
      requestCount += 1;
      return { ok: true, async json() { return { snapshot: { ...hostSnapshot, generatedAt: requestCount } }; } };
    },
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-1" }, ctx: { connection: {} } });
  try {
    await handle.settle();
    assert.ok(textOf(handle.output).includes("待补全专家"), "轻量快照的任务名必须直接上屏（不再等完整快照）");

    const rowOf = (label) => byClass(handle.output, "deg_expert_group_row").find((row) => textOf(row).includes(label));
    const unknownRow = rowOf("待补全专家");
    assert.equal(
      byClass(unknownRow, "deg_expert_group_status_icon")[0].props["data-status"],
      "unknown",
      "没有活动证据的节点在轻量快照里必须中性（不得声明已结束）",
    );
    assert.equal(byClass(unknownRow, "deg_expert_group_state_dot")[0].props["data-state"], "unknown", "兜底圆点同样中性");
    assert.equal(byClass(unknownRow, "deg_expert_group_content").length, 0, "摘要行已移除，中性态只由圆点表达");
    // 有证据（目录 activity=inactive）的专家不受 partial 影响：中性规则只针对「没有任何证据」。
    assert.equal(
      byClass(rowOf("空闲专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "有活动证据的节点照常渲染",
    );
    // fan-out 的状态来自本机 manager，与冷读无关：轻量快照下同样保持权威状态。
    assert.equal(byClass(handle.output, "deg_expert_group_fanout")[0].props["data-status"], "running");
    // 空闲分组是容器：轻量快照下它同样不声明「已结束」。
    assert.equal(
      byClass(byClass(handle.output, "deg_expert_group_idle_group")[0], "deg_expert_group_row")[0].props["data-status"],
      "unknown",
      "空闲分组容器在轻量快照下同样中性",
    );

    // 完整快照到达：任务树内容完全相同，只有 partial 由 true 变 false，也必须重新上屏。
    hostSnapshot = { ...partialHostSnapshot(), partial: false };
    await intervals.tick();
    await handle.settle();
    assert.ok(requestCount >= 2, "轮询照常发起 RPC");
    const refreshedRow = rowOf("待补全专家");
    assert.equal(
      byClass(refreshedRow, "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "完整快照到达后必须恢复既有渲染（partial 参与内容比较，不得被吞掉）",
    );
    assert.equal(byClass(refreshedRow, "deg_expert_group_state_dot")[0].props["data-state"], "ready");
    assert.equal(
      byClass(byClass(handle.output, "deg_expert_group_idle_group")[0], "deg_expert_group_row")[0].props["data-status"],
      "ready",
      "空闲分组容器恢复既有圆点",
    );
    assert.ok(textOf(handle.output).includes("待补全专家"), "任务名在两次渲染之间保持不变");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

/**
 * 轻量（partial）快照的证据规则必须一路贯穿到**空闲归组**与**空闲批量关闭候选**。
 *
 * Host 首屏的轻量快照跳过全部冷读：既没有 live session/agent 的专家被投影成 status=unknown
 * 且**省略 running**（host/expert-group-runtime.js 的 evidenceFree 分支）。这类节点「没有任何
 * 活动证据」，因此既不算 running 也不算 ready。
 *
 * ── 语义变更（修复 B：显示从宽、操作从严）──────────────────────────────────────
 * 原语义：unknown 节点**不进**空闲分组。
 * 新语义：unknown 节点**进**空闲分组**显示**（因此 partial 与 full 下的组内成员与顺序一致，
 *   不再出现「同一 fan-out 分组每隔 2.5 秒在两个位置之间来回跳」），但仍然**不参与**任何会真的
 *   操作宿主的动作：
 *   - 不进空闲批量关闭候选（一次误关会毁掉用户正在运行的会话）；
 *   - 不被 manual 抑制清理放过（状态无法证明，按 fail-closed 保留抑制）。
 *
 * 变更理由：位置稳定性属于展示正确性，而「是否可关闭」属于操作安全性；把两者解耦后，用户既不会
 * 看到条目跳位，也不会因为轻量快照的证据缺失而误关会话。断言因此从「不进组」改为「进组显示、
 * 但不进候选」，并新增「不被抑制清理放过」的断言。
 *
 * 与上一个用例的分工：那个用例锁「圆点/文案」的中性渲染，本用例锁「归组与批量关闭候选」
 * 这两个会真的改变行为的判定。
 */
test("轻量快照：没有活动证据的专家进空闲分组显示但不进空闲批量候选，完整快照到达后按证据恢复", async () => {
  const hostSnapshot = batchPanelSnapshot();
  // 冷读被跳过的专家：status=unknown、没有 running 布尔，且官方子代理目录里也没有它的条目
  // （首屏时 DSH 会话投影可能还没 hydrate）——这正是「没有任何活动证据」的形状。
  const warmingNode = {
    id: "expert-warming", kind: "expert", sessionId: "expert-warming", taskName: "待补全专家",
    role: "fixer", content: "冷读被跳过", status: "unknown", continuable: true,
  };
  hostSnapshot.root.children.unshift(warmingNode);
  hostSnapshot.partial = true;
  const mounted = mountBatchPanel({
    hostSnapshot,
    addresses: {
      ...BATCH_ADDRESSES,
      "expert-warming": { parentSessionId: "root-1", childSessionId: "expert-warming", mode: "continuable" },
    },
  });
  const { handle, fixture, intervals, restore } = mounted;
  const WARMING_ADDRESS = "dsh-resource://subagentchat/session/expert-warming?parent=root-1&mode=continuable";
  /** 某个节点的行容器（.deg_expert_group_row）：data-status 与树结构断言都读它。 */
  const statusRowOf = (label) => byClass(handle.output, "deg_expert_group_row").find((row) => textOf(row).includes(label));
  /** 空闲分组内成员容器的文本（分组折叠或不存在时为空串）。 */
  const idleMemberText = () => {
    const container = byClass(handle.output, "deg_expert_group_idle_children")[0];
    return container === undefined ? "" : textOf(container);
  };
  try {
    fixture.addOpenTab({ id: "tab-warming", sessionId: "root-1", kind: "subagentchat", contentId: WARMING_ADDRESS });
    fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    await handle.settle();

    // 中性圆点照旧；归组**放宽**（进组显示），但操作候选**不变**（仍然只有真正 ready 的那一个）。
    assert.equal(
      byClass(statusRowOf("待补全专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "unknown",
      "没有活动证据的节点在轻量快照里保持中性",
    );
    assert.equal(textOf(batchRowOf(handle, "空闲子代理")), "空闲子代理（2）", "无证据的专家也计入空闲成员数（显示从宽）");
    assert.equal(idleMemberText().includes("待补全专家"), true, "无证据的专家进入空闲分组显示（位置稳定性优先）");
    // 操作安全性不变：空闲批量候选只有真正 ready 的那一个，unknown 绝不成为「可以关闭」的目标。
    const idleBatch = batchActionOf(handle, "空闲子代理");
    assert.equal(idleBatch.props["aria-label"], "在侧边栏关闭 1 个空闲子代理", "候选数量只算有证据的成员（操作从严）");
    await idleBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(fixture.closed, ["tab-idle"], "空闲批量只能关掉有证据表明已空闲的成员");
    assert.equal(
      fixture.openTabs.map((tab) => tab.tabId).includes("tab-warming"),
      true,
      "状态无法证明的会话 tab 必须原样保留在 inventory 里",
    );

    // 完整快照到达：节点带上完整证据（status=ready + running=false），归组与候选按完整证据恢复。
    // 上一阶段被关掉的空闲 tab 由宿主清出了 inventory，这里补一个同地址的新 tab（用户重新打开），
    // 用来证明恢复后的候选集合同时包含两个空闲成员。
    fixture.addOpenTab({ id: "tab-idle-again", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    hostSnapshot.partial = false;
    warmingNode.status = "ready";
    warmingNode.running = false;
    await intervals.tick();
    await handle.settle();
    assert.equal(textOf(batchRowOf(handle, "空闲子代理")), "空闲子代理（2）", "完整快照到达后必须按完整证据恢复归组");
    assert.equal(idleMemberText().includes("待补全专家"), true, "完整证据下该专家回到空闲分组");
    assert.equal(
      byClass(statusRowOf("待补全专家"), "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "完整证据下圆点回到既有渲染",
    );
    const restoredBatch = batchActionOf(handle, "空闲子代理");
    assert.equal(restoredBatch.props["aria-label"], "在侧边栏关闭 2 个空闲子代理", "候选按完整证据恢复，不留永久性差异");
    await restoredBatch.props.onClick(recordingEvent());
    await handle.settle();
    assert.deepEqual(
      fixture.closed,
      ["tab-idle", "tab-warming", "tab-idle-again"],
      "恢复后的候选集合包含两个空闲成员，按 inventory 顺序逐个关闭（tab-warming 现在有完整证据）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});


/**
 * 修复 B 的核心回归：同一份数据在 partial:true 与 partial:false 下，**空闲分组的成员与顺序必须完全一致**。
 *
 * 缺陷形状（用户可见）：DSH 重启后打开已有会话，空闲列表里的 fan-out 分组「Oracle: 3 shards」
 * 每隔约 2.5s 在组内第 2 位与第 9 位之间来回跳。成因之一是轻量快照下无证据专家为 unknown，
 * 原先**不进**空闲分组，而完整快照下它们有真实状态、**进**空闲分组；同一次 partial↔full 切换
 * 因此同时改变了成员集合与组内下标。
 *
 * 本用例锁定新语义：unknown 节点也进组显示，于是成员集合与顺序在两条路径下一致；
 * 同时锁定安全门禁没有放宽（unknown 不在批量关闭候选里）。
 */
test("修复 B：空闲分组成员与顺序在 partial/full 下完全一致，但 unknown 仍不进批量候选", async () => {
  const hostSnapshot = batchPanelSnapshot();
  // 两个「轻量快照下无活动证据」的专家：status=unknown、没有 running 布尔、目录里也没有条目。
  // 它们分别排在 ready 专家之前与之后，用来证明顺序（而不只是成员集合）也一致。
  const warmingBefore = {
    id: "expert-warming-before", kind: "expert", sessionId: "expert-warming-before", taskName: "前置待补全",
    role: "fixer", content: "冷读被跳过", status: "unknown", continuable: true,
  };
  const warmingAfter = {
    id: "expert-warming-after", kind: "expert", sessionId: "expert-warming-after", taskName: "后置待补全",
    role: "explorer", content: "冷读被跳过", status: "unknown", continuable: true,
  };
  hostSnapshot.root.children = [warmingBefore, ...hostSnapshot.root.children, warmingAfter];
  hostSnapshot.partial = true;
  const WARMING_BEFORE_ADDRESS = "dsh-resource://subagentchat/session/expert-warming-before?parent=root-1&mode=continuable";
  const WARMING_AFTER_ADDRESS = "dsh-resource://subagentchat/session/expert-warming-after?parent=root-1&mode=continuable";
  const mounted = mountBatchPanel({
    hostSnapshot,
    addresses: {
      ...BATCH_ADDRESSES,
      "expert-warming-before": { parentSessionId: "root-1", childSessionId: "expert-warming-before", mode: "continuable" },
      "expert-warming-after": { parentSessionId: "root-1", childSessionId: "expert-warming-after", mode: "continuable" },
    },
  });
  const { handle, fixture, intervals, restore } = mounted;
  /**
   * 空闲分组内每个成员的**身份**（按渲染顺序），用于比较两条路径的成员与顺序。
   *
   * 直接读分组容器的 children：每个成员就是一个成员容器（专家是 deg_expert_group_node，
   * fan-out 是 deg_expert_group_fanout），该数组顺序就是用户看到的组内顺序。
   * 只取任务名标识、不比对完整行文本：unknown → ready 时圆点本来就要从「中性」恢复为「已结束」，
   * 那是**预期**的展示差异（活动文案行已按用户要求移除）；本用例锁定的是成员集合与相对位置（跳位缺陷）。
   */
  const IDLE_LABELS = ["前置待补全", "空闲专家", "后置待补全"];
  const idleMemberOrder = () => {
    const container = byClass(handle.output, "deg_expert_group_idle_children")[0];
    if (container === undefined) return [];
    return (container.children || []).map((child) => {
      const line = textOf(child);
      return IDLE_LABELS.find((label) => line.includes(label)) ?? ("未识别成员:" + line);
    });
  };
  try {
    // 给三个空闲成员各开一个 tab：批量关闭控件只在「候选 ∩ inventory」非空时渲染按钮（否则渲染零占位）。
    fixture.addOpenTab({ id: "tab-warming-before", sessionId: "root-1", kind: "subagentchat", contentId: WARMING_BEFORE_ADDRESS });
    fixture.addOpenTab({ id: "tab-idle", sessionId: "root-1", kind: "subagentchat", contentId: BATCH_ADDRESS_READY });
    fixture.addOpenTab({ id: "tab-warming-after", sessionId: "root-1", kind: "subagentchat", contentId: WARMING_AFTER_ADDRESS });
    await handle.settle();
    const partialOrder = idleMemberOrder();
    assert.equal(
      partialOrder.some((line) => line.includes("前置待补全")) && partialOrder.some((line) => line.includes("后置待补全")),
      true,
      "轻量快照下 unknown 专家必须进空闲分组显示（否则 partial/full 的成员集合必然不同）",
    );
    // 安全门禁不变：unknown 仍然不在批量关闭候选里（只有真正 ready 的「空闲专家」可关）。
    assert.equal(
      batchActionOf(handle, "空闲子代理").props["aria-label"],
      "在侧边栏关闭 1 个空闲子代理",
      "unknown 成员仍然不进空闲批量关闭候选（显示从宽、操作从严）",
    );

    // 完整快照到达：同一批节点带上完整证据，成员与顺序必须逐项一致。
    hostSnapshot.partial = false;
    warmingBefore.status = "ready";
    warmingBefore.running = false;
    warmingAfter.status = "ready";
    warmingAfter.running = false;
    await intervals.tick();
    await handle.settle();
    const fullOrder = idleMemberOrder();
    assert.deepEqual(fullOrder, partialOrder, "空闲分组的成员与顺序在 partial/full 下必须完全一致（修复 B）");
    assert.equal(
      batchActionOf(handle, "空闲子代理").props["aria-label"],
      "在侧边栏关闭 3 个空闲子代理",
      "完整证据下候选按完整证据恢复（3 = 空闲专家 + 两个原先 unknown 的成员）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

// ── 恢复失败错误态与重试入口（票据 04） ─────────────────────────────────────

/** 带 Host recovery 块的快照；recovery 省略时保持旧 Host 形状（没有该字段）。 */
function snapshotWithRecovery(recovery) {
  const base = snapshot();
  if (recovery !== undefined) base.recovery = recovery;
  return base;
}

/** 可外部驱动的 promise：用它在「重试 RPC 在途」窗口里断言按钮禁用与进度文案。 */
function createRetryGate() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("恢复失败：侧栏顶部渲染独立错误横幅与重试入口，重试成功后横幅消失", async () => {
  const failedRecovery = {
    status: "failed",
    code: "INVALID_SNAPSHOT",
    message: "快照 shard 结构非法",
    at: 1700000000000,
    retryable: false,
    persistenceBlocked: true,
  };
  let hostSnapshot = snapshotWithRecovery(failedRecovery);
  const firstRetry = createRetryGate();
  const secondRetry = createRetryGate();
  const retryGates = [firstRetry, secondRetry];
  const mounted = mountPanel({
    async requestPluginRpc(_connection, request) {
      if (request.action === "fanout-restore-retry") {
        // 每次重试都挂起，用例据此观察「在途禁用/进度」这个真实窗口。
        return retryGates.shift().promise;
      }
      return { ok: true, json: async () => ({ snapshot: hostSnapshot }) };
    },
  });
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();

    const banner = byClass(handle.output, "deg_expert_group_recovery")[0];
    assert.ok(banner, "恢复失败必须渲染独立的错误横幅");
    assert.equal(banner.props.role, "alert");
    assert.equal(banner.props["data-recovery-status"], "failed");
    assert.equal(banner.props["data-recovery-code"], "INVALID_SNAPSHOT");
    const bannerText = textOf(banner);
    assert.ok(bannerText.includes("INVALID_SNAPSHOT"), "横幅必须展示稳定原因码");
    assert.ok(bannerText.includes("快照 shard 结构非法"), "横幅必须展示一行 message");
    // 恢复失败绝不占用「快照读取失败」槽：两个错误面彼此独立。
    assert.equal(byClass(handle.output, "deg_expert_group_error").length, 0);
    assert.equal(
      requests.some((request) => request.action === "fanout-restore-retry"),
      false,
      "横幅出现本身不触发重试请求",
    );

    const retryButton = () => byClass(handle.output, "deg_expert_group_recovery_retry")[0];
    assert.ok(retryButton(), "恢复失败必须提供重试入口");
    assert.equal(textOf(retryButton()), "重试恢复");
    assert.equal(retryButton().props.disabled ?? false, false);

    // 第一次重试：RPC 在途 → 按钮禁用、aria-busy、文案进入进度态。
    retryButton().props.onClick();
    await handle.settle();
    const pendingButton = retryButton();
    assert.equal(pendingButton.props.disabled, true, "重试在途必须禁用按钮");
    assert.equal(pendingButton.props["aria-busy"], true);
    assert.equal(textOf(pendingButton), "重试中…");
    assert.ok(
      requests.some((request) => request.action === "fanout-restore-retry"
        && request.sessionId === "root-1"),
      "重试必须调用 fanout-restore-retry 并带上当前根会话 id",
    );

    // 第一次重试失败（同原因码）：保持错误态与原因码，并在横幅内补一行重试结果。
    firstRetry.resolve({
      ok: true,
      async json() {
        return {
          ok: true,
          restored: false,
          deferred: 0,
          error: { code: "INVALID_SNAPSHOT", message: "快照 shard 结构非法", retryable: false },
        };
      },
    });
    await handle.settle();
    assert.ok(byClass(handle.output, "deg_expert_group_recovery")[0], "失败后横幅必须保持");
    assert.equal(byClass(handle.output, "deg_expert_group_recovery")[0].props["data-recovery-code"], "INVALID_SNAPSHOT");
    const retryError = byClass(handle.output, "deg_expert_group_recovery_retry_error")[0];
    assert.ok(retryError, "重试动作失败必须有补充行");
    assert.ok(textOf(retryError).includes("INVALID_SNAPSHOT"), "补充行保留同一原因码");
    assert.equal(byClass(handle.output, "deg_expert_group_error").length, 0, "仍不占用快照错误槽");
    const snapshotRequestsBeforeSuccess = requests.filter((request) => request.action === "expert-group-snapshot").length;
    assert.ok(snapshotRequestsBeforeSuccess >= 2, "每次重试结算后都必须刷新快照");

    // 第二次重试成功：Host 返回 restored=true 且新快照 recovery=ok → 横幅消失。
    hostSnapshot = snapshotWithRecovery({
      status: "ok", code: null, message: null, at: 1700000001000, retryable: false, persistenceBlocked: false,
    });
    retryButton().props.onClick();
    await handle.settle();
    assert.equal(textOf(retryButton()), "重试中…", "第二次重试同样进入进度态");
    secondRetry.resolve({ ok: true, async json() { return { ok: true, restored: true, restoredCount: 1, deferred: 0, error: null }; } });
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_recovery").length, 0, "恢复成功后横幅必须消失");
    assert.equal(
      requests.filter((request) => request.action === "expert-group-snapshot").length,
      snapshotRequestsBeforeSuccess + 1,
      "重试成功后必须刷新一次快照（以 Host 的 recovery=ok 为准）",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("恢复状态：ok/none 与旧 Host（缺失 recovery 块）都不渲染横幅", async () => {
  const model = globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
  // 旧 Host 缺失该字段：客户端必须回退为 null（不渲染、也不猜成失败）。
  assert.equal(model.normalizeExpertGroupSnapshot({
    schemaVersion: 1,
    rootSessionId: "root-1",
    root: { id: "root-1", kind: "root", children: [] },
  }).recovery, null);

  for (const recovery of [
    undefined,
    { status: "ok", code: null, message: null, at: 1, retryable: false, persistenceBlocked: false },
    { status: "none", code: null, message: null, at: null, retryable: false, persistenceBlocked: false },
  ]) {
    const mounted = mountPanel({ hostSnapshot: snapshotWithRecovery(recovery) });
    try {
      await mounted.handle.settle();
      assert.equal(byClass(mounted.handle.output, "deg_expert_group_recovery").length, 0, "没有失败态时不得出现恢复横幅");
    } finally {
      mounted.handle.unmount();
      mounted.restore();
    }
  }
});

// ── 票据 12：任务时间线、失败摘要、折叠、搜索过滤与导出 ─────────────────────

/** 失败摘要夹具：带引号的绝对路径 + 第二行堆栈，验证客户端脱敏与「只取首行」。 */
const TIMELINE_SECRET_PATH = "/home/user/secret/a.txt";
const TIMELINE_FAILURE_MESSAGE = '无法读取 "' + TIMELINE_SECRET_PATH + '"' + String.fromCharCode(10) + "    at readFile (/repo/io.js:1:1)";

/**
 * 票据 12 的完整时间线夹具：fanout/shard/attempt/会话节点都带 Host 投影字段，
 * 覆盖「失败摘要」「多次重试」「最近 5 条 attempt」「嵌套专家折叠」四类断言。
 */
function timelinePanelSnapshot() {
  return {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1700000000000,
    revision: "rev-timeline",
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh",
      content: "根任务完整目标正文", status: "running", createdAt: 1699999000000,
      startedAt: 1699999000000, lastActivityAt: 1699999500000,
      children: [
        {
          id: "expert-running", kind: "expert", sessionId: "expert-running", taskName: "运行专家",
          role: "fixer", model: "gpt-5.6-sol", content: "实现运行任务", status: "running",
          createdAt: 1699999100000, startedAt: 1699999100000, lastActivityAt: 1699999300000,
          children: [{
            id: "nested-expert", kind: "expert", sessionId: "nested-expert", taskName: "嵌套子任务",
            role: "designer", model: "gpt-5.6-mini", status: "running", createdAt: 1699999150000,
          }],
        },
        {
          id: "expert-ready", kind: "expert", sessionId: "expert-ready", taskName: "空闲专家",
          role: "explorer", model: "gpt-5.6-mini", content: "已完成任务", status: "ready",
          createdAt: 1699999200000,
        },
        {
          id: "fan-1", kind: "fanout", parentTaskId: "fan-1", taskName: "时间线任务", role: "fixer",
          model: "gpt-5.6-sol", status: "failed", createdAt: 1699999100000,
          startedAt: 1699999100000, finishedAt: 1699999950000, durationMs: 850000,
          lastActivityAt: 1699999960000, attemptCount: 10, retryCount: 4,
          failure: { code: "EACCES", message: "错".repeat(200) },
          shards: [
            {
              shardId: "failed-shard", taskName: "失败分片", prompt: "失败分片完整提示词正文",
              role: "designer", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh", status: "failed",
              createdAt: 1699999100000, startedAt: 1699999100000, finishedAt: 1699999950000,
              durationMs: 850000, lastActivityAt: 1699999960000, attemptCount: 7, retryCount: 6,
              failure: { code: "EACCES", message: TIMELINE_FAILURE_MESSAGE },
              attempts: Array.from({ length: 7 }, (_value, index) => ({
                attempt: index + 1,
                status: "failed",
                childId: "failed-child-" + (index + 1),
                startedAt: 1700000000000 + index * 5000,
                finishedAt: 1700000000000 + index * 5000 + 1200,
                durationMs: 1200,
                failure: { code: "EACCES", message: "第 " + (index + 1) + " 次失败" },
              })),
            },
            {
              shardId: "succeeded-shard", taskName: "成功分片", prompt: "成功分片提示词",
              role: "fixer", model: "gpt-5.6-sol", status: "succeeded",
              createdAt: 1699999700000, startedAt: 1699999700000, finishedAt: 1699999800000,
              durationMs: 100000, lastActivityAt: 1699999800000, attemptCount: 2, retryCount: 1,
              // 历史失败 + 最终成功：状态不是失败语义时绝不展示失败摘要。
              failure: { code: "ETIMEDOUT", message: "历史超时" },
              attempts: [
                { attempt: 1, status: "timed_out", startedAt: 1699999700000, finishedAt: 1699999750000, durationMs: 50000, failure: { code: "ETIMEDOUT", message: "历史超时" } },
                { attempt: 2, status: "succeeded", startedAt: 1699999760000, finishedAt: 1699999800000, durationMs: 40000 },
              ],
            },
            {
              shardId: "cancelled-shard", taskName: "取消分片", status: "cancelled",
              createdAt: 1699999800000, attemptCount: 1, retryCount: 0,
              attempts: [{ attempt: 1, status: "cancelled", startedAt: 1699999800000, finishedAt: 1699999900000 }],
            },
          ],
        },
      ],
    },
  };
}

/**
 * 用量速览行专用夹具（不影响其它时间线用例）：在 timelinePanelSnapshot 上补齐五段所需事实。
 *
 * - root：无 durationMs，运行时间来自 DEG 快照 generatedAt - 节点 startedAt；
 * - expert-running：节点 durationMs + 完整用量 + 目录投影里的 contextPressure；
 * - fanout 父任务：聚合 durationMs/usage（29M tok、210tok/s、命中98%），没有单一会话；
 * - failed-shard：分片 durationMs + 用量 + 最新 attempt child 的 contextPressure。
 */
function usageMetricsSnapshot() {
  const base = timelinePanelSnapshot();
  // 运行中行的终点时间只存在于 DEG Host 快照：sessions 列表快照没有 generatedAt。
  base.generatedAt = 1700000060000;
  // 起点用节点 startedAt（分片/父任务以自身起点为准）；root 的起点与会话 createdAt 对齐，
  // 因此 1700000060000 - 1699999758000 = 302000ms →「用时5m2s」。
  base.root.startedAt = 1699999758000;
  base.root.usage = { inputTokens: 850, outputTokens: 150 };
  const expert = base.root.children.find((node) => node.id === "expert-running");
  expert.durationMs = 1500;
  expert.usage = { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 120 };
  const fanout = base.root.children.find((node) => node.kind === "fanout");
  fanout.durationMs = 1707000;
  fanout.usage = { inputTokens: 574000, cacheReadTokens: 28126000, cacheWriteTokens: 0, outputTokens: 358470 };
  const failedShard = fanout.shards.find((shard) => shard.shardId === "failed-shard");
  failedShard.durationMs = 850000;
  failedShard.usage = { inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0, outputTokens: 72000 };
  return base;
}

/**
 * 可注入快照的 sessions 替身：用量速览用例需要 createdAt / updatedAt / contextPressure。
 *
 * refresh 可选：给出时挂上 DSH 公开的 sessions.refreshProjections(sessionId)，并按调用顺序
 * 记账到 fixture.refreshCalls——用于验证「缺失 sessionStats 的会话按需刷新且只刷新一次」。
 * 回调收到 (sessionId, fixture)，可同步写入快照（fixture.update）或返回 Promise（含拒绝），
 * 由用例决定刷新成功/失败/抛错的时序。
 */
function sessionsFixtureWith(snapshot, opened = [], refresh = null) {
  const state = { snapshot };
  const listeners = new Set();
  const fixture = {
    /** 每次 refreshProjections(sessionId) 的调用记录（含重复调用，便于断言去重）。 */
    refreshCalls: [],
    list: {
      getSnapshot: () => state.snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    open(id) { opened.push(id); },
    update(next) {
      state.snapshot = next;
      for (const listener of listeners) listener();
    },
  };
  if (typeof refresh === "function") {
    fixture.refreshProjections = (sessionId) => {
      fixture.refreshCalls.push(sessionId);
      return refresh(sessionId, fixture);
    };
  }
  return fixture;
}

/**
 * 用量速览的会话投影夹具：
 * - **不提供 generatedAt**：生产会话列表快照没有该字段，运行时间必须来自 DEG 快照；
 * - root 走第一条读面（byId.projectionValues.contextPressure）与 createdAt 起点；
 * - expert-running 走第二条读面（projectionsBySession[sid].values.contextPressure）；
 * - failed-child-7（失败分片的最新 attempt）走 byId.projectionValues；
 * - expert-ready 用 updatedAt 计算已结束会话的运行时间（非 running 分支）。
 */
function usageMetricsSessionsFixture() {
  const base = sessionsSnapshot();
  const snapshot = {
    ...base,
    byId: {
      ...base.byId,
      "root-1": {
        ...base.byId["root-1"],
        createdAt: 1699999758000,
        updatedAt: 1700000000000,
        projectionValues: { contextPressure: { projectedTokens: 30000, contextWindow: 100000 } },
      },
      "expert-ready": {
        ...base.byId["expert-ready"],
        createdAt: 1699999800000,
        updatedAt: 1699999950000,
      },
      "failed-child-7": {
        id: "failed-child-7", title: "失败第七次", running: false,
        projectionValues: { contextPressure: { projectedTokens: 60000, contextWindow: 240000 } },
      },
    },
    projectionsBySession: {
      ...base.projectionsBySession,
      "expert-running": { values: { contextPressure: { pressureTokens: 40000, contextWindow: 200000 } } },
    },
  };
  return sessionsFixtureWith(snapshot);
}

/**
 * DSH 权威投影夹具（复刻用户实测截图 2）。
 *
 * sessionStats / tokenUsage / contextPressure 与现有 contextPressure 完全同一读面
 * （byId.projectionValues 优先）。数字取自用户图 2 的可验证展示值：模型用时 65m26s、
 * 工具调用用时 18m56s、输出速度 208tok/s、总量 109M tok、缓存命中 97%、context 32%。
 * decodeMs 是毫秒且必须落在模型用时之内：3,800,000ms 对应 790,400 个 decode token
 * （790400 ÷ 3800s = 208tok/s）；tokenUsage 的 3.2M 未缓存输入 + 105M 缓存读 + 0.8M 输出
 * 得到 109M 总量与 97% 命中，避免构造「decode 用时超过模型用时」的物理不可能夹具。
 */
function dshProjectionValues(overrides = {}) {
  return {
    sessionStats: {
      turns: 12,
      steps: 40,
      llmMs: 3926000,
      toolMs: 1136000,
      ttftMs: 1200,
      ttftSteps: 3,
      decodeMs: 3800000,
      decodeTokens: 790400,
    },
    tokenUsage: {
      uncachedInputTokens: 3200000,
      cacheReadTokens: 105000000,
      cacheWriteTokens: 0,
      outputTokens: 800000,
    },
    contextPressure: { projectedTokens: 32000, contextWindow: 100000 },
    ...overrides,
  };
}

/** 只让 root 携带 DSH 投影的 sessions 替身（其它会话保持无投影，覆盖 DEG 回退）。 */
function dshMetricsSessionsFixture() {
  const base = sessionsSnapshot();
  return sessionsFixtureWith({
    ...base,
    byId: {
      ...base.byId,
      "root-1": { ...base.byId["root-1"], projectionValues: dshProjectionValues() },
      "expert-running": { ...base.byId["expert-running"], projectionValues: dshProjectionValues() },
    },
  });
}

/**
 * 分片/fan-out 的 DSH 投影夹具：
 * - failed-child-7（失败分片最新 attempt）走 byId.projectionValues；
 * - cancelled-child（取消分片最新 attempt）走 projectionsBySession 读面；
 * - succeeded-shard 的最新 attempt 没有 childId，不参与聚合。
 */
function dshShardSessionsFixture() {
  const base = sessionsSnapshot();
  return sessionsFixtureWith({
    ...base,
    byId: {
      ...base.byId,
      "failed-child-7": {
        id: "failed-child-7", title: "失败第七次", running: false,
        projectionValues: {
          sessionStats: { llmMs: 600000, toolMs: 100000, decodeMs: 2000, decodeTokens: 40000 },
          tokenUsage: { uncachedInputTokens: 2000, cacheReadTokens: 8000, cacheWriteTokens: 0, outputTokens: 40000 },
          contextPressure: { projectedTokens: 60000, contextWindow: 240000 },
        },
      },
    },
    projectionsBySession: {
      ...base.projectionsBySession,
      "cancelled-child": {
        values: {
          sessionStats: { llmMs: 60000, toolMs: 20000, decodeMs: 1000, decodeTokens: 5000 },
          tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5000 },
        },
      },
    },
  });
}

function byAria(root, label) {
  return walk(root).find((node) => node?.props?.["aria-label"] === label) ?? null;
}

function rowOfShard(root, shardId) {
  return byClass(root, "deg_expert_group_shard").find((row) => row.props["data-shard-id"] === shardId) ?? null;
}

/**
 * 展开输出树里所有仍处于收起状态的 fan-out（需求二：结算态 fan-out 默认为收起）。
 *
 * 背景：大量既有用例使用「结算态 fan-out 夹具」（status 为 failed / succeeded / cancelled），
 * 它们要验证的是折叠之后依然正确的内容——分片行文本、取消/重试动作、用量摘要、attempt
 * 时间线缺席等，而**不是**默认展开本身。需求二把这些 fan-out 的缺省值改成收起以后，分片行
 * 不再进入渲染树，断言目标随之中断。
 *
 * 这里走的是用户唯一可点的入口：点击 fan-out 头部的 chevron（同一条 toggle →
 * sessionStorage override 生产路径），再 settle 一次让分片行上屏。不绕过任何生产逻辑，
 * 原断言一条都不删、不改弱。
 *
 * 注意：override 只有在 storage 可写时才持久（无 storage 时下一次渲染会退回缺省值），
 * 因此调用方必须给 mountPanel 提供 storage；没有 storage 的用例补一个 MemoryStorage。
 *
 * @param {{ output: any, settle: () => Promise<any> }} handle 渲染会话
 * @returns {Promise<number>} 本次真正被点击展开的 fan-out 数量
 */
async function expandFanouts(handle) {
  let expanded = 0;
  for (const fanout of byClass(handle.output, "deg_expert_group_fanout")) {
    const chevron = byClass(fanout, "deg_expert_group_chevron")[0];
    if (!chevron || chevron.props["aria-expanded"] !== false) continue;
    chevron.props.onClick({ stopPropagation() {} });
    expanded += 1;
  }
  if (expanded > 0) await handle.settle();
  return expanded;
}

function rowOfExpert(root, needle) {
  return byClass(root, "deg_expert_group_row").find((row) => textOf(row).includes(needle)) ?? null;
}

test("用量速览：任务行按 用时 · tok/s · tok · 命中 · context 顺序渲染，异常提示保留", async () => {
  const mounted = mountPanel({
    hostSnapshot: usageMetricsSnapshot(),
    sessions: usageMetricsSessionsFixture(),
    storage: new MemoryStorage(),
  });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；本用例验证的是摘要内容本身，先按用户方式展开。
    await expandFanouts(handle);
    // 生产会话列表快照（DSH getListSnapshot）没有 generatedAt：root 的「用时5m2s」
    // 只能由 DEG Host 快照的 generatedAt 与节点 startedAt 算出。
    assert.equal(mounted.sessions.list.getSnapshot().generatedAt, undefined, "sessions 快照不得提供 generatedAt");
    // 本夹具没有 sessionStats/tokenUsage 投影：五段必须完全回退 DEG usage/duration。
    assert.equal(mounted.sessions.list.getSnapshot().byId["root-1"].projectionValues.sessionStats, undefined);

    // fan-out 父任务：四段（没有单一会话 ⇒ 没有 context），数字全部来自真实投影。
    const fanout = byClass(handle.output, "deg_expert_group_fanout")[0];
    const fanoutMetrics = byClass(fanout, "deg_expert_group_metrics")[0];
    assert.ok(fanoutMetrics, "fan-out 任务行必须渲染用量摘要条");
    assert.equal(fanoutMetrics.props["aria-label"], "任务用量摘要");
    assert.deepEqual(metricsParts(fanoutMetrics), ["用时28m27s", "210tok/s", "29M tok", "命中98%"]);
    const fanoutMetricsText = textOf(fanoutMetrics);
    for (const banned of ["开始", "最近活动", "重试 4 次", "用量 —"]) {
      assert.equal(fanoutMetricsText.includes(banned), false, "摘要条不得再出现旧片段：" + banned);
    }
    // tok 段 tooltip 复用完整用量摘要（有界）。
    const tokPart = byClass(fanoutMetrics, "deg_expert_group_metrics_part").find((part) => textOf(part) === "29M tok");
    assert.ok(tokPart, "tok 段必须渲染");
    assert.ok(tokPart.props.title.startsWith("用量："), "tok 段 tooltip 使用完整用量摘要");
    assert.ok(tokPart.props.title.includes("输入 574000"));
    assert.ok(tokPart.props.title.length <= 400);

    // 专家行：五段齐全且顺序固定（context 来自 projectionsBySession 读面）。
    const expertRow = rowOfExpert(handle.output, "运行专家");
    const expertMetrics = byClass(expertRow, "deg_expert_group_metrics")[0];
    // 时长口径变更（2026-10-25）：1 分钟以内向下取整到秒，1500ms 从「1.5s」变成「1s」。
    assert.deepEqual(metricsParts(expertMetrics), ["用时1s", "80tok/s", "520 tok", "命中75%", "context 20%"]);

    // root：没有 durationMs/usage.runMs ⇒ 运行中时间差（DEG generatedAt - 节点 startedAt）。
    // 该行严格 running 且已有 usage ⇒ 缺失段（没有 cacheReadTokens ⇒ 命中）按 0 补齐（用户要求）：
    // 运行过程中五段不得塌成「用时 · tok」两段，否则投影陆续到达时摘要条会来回跳动。
    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    const rootMetrics = byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(rootMetrics), ["用时5m2s", "0.5tok/s", "1.0k tok", "命中0%", "context 30%"]);

    // 已结束会话：节点 startedAt（规范化后回退节点 createdAt）→ 会话 updatedAt；
    // 没有 usage ⇒ 只有「用时」一段。1699999950000 - 1699999200000 = 750000ms → 「12m30s」。
    const readyRow = rowOfExpert(handle.output, "空闲专家");
    const readyMetrics = byClass(readyRow, "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(readyMetrics), ["用时12m30s"]);

    // 分片：分片自身 usage/duration + 最新 attempt child 的 contextPressure。
    const failedShardRow = rowOfShard(handle.output, "failed-shard");
    assert.ok(failedShardRow);
    const shardMetrics = byClass(failedShardRow, "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(shardMetrics), ["用时14m10s", "85tok/s", "82k tok", "命中90%", "context 25%"]);

    // 异常提示不占五段：retryCount >= 3 的「多次重试」徽标 + 失败摘要照常保留。
    const retryWarning = byClass(fanout, "deg_expert_group_retry_warning")[0];
    assert.ok(retryWarning, "重试达到阈值必须显示徽标");
    assert.equal(retryWarning.props["data-retry-warning"], "true");
    assert.equal(textOf(retryWarning), "多次重试");
    assert.equal(textOf(retryWarning).includes("上限"), false, "不声称存在已知尝试上限");
    assert.ok(byClass(failedShardRow, "deg_expert_group_retry_warning")[0], "失败分片同样展示多次重试徽标");

    // 失败摘要：稳定 code + 一行 message；路径脱敏、堆栈丢弃、UI 截断 120 字符。
    const failure = byClass(failedShardRow, "deg_expert_group_failure")[0];
    assert.ok(failure, "失败分片必须展示受限失败摘要");
    assert.equal(failure.props["data-failure-code"], "EACCES");
    const failureText = textOf(failure);
    assert.ok(failureText.startsWith("EACCES · "), "稳定 code 在前，message 在后");
    assert.ok(failureText.includes("<path>"), "绝对路径被替换为占位符");
    assert.equal(failureText.includes("secret"), false, "路径片段绝不外泄");
    assert.equal(failureText.includes("readFile"), false, "堆栈绝不进入摘要");
    assert.equal(failureText.includes("完整提示词正文"), false, "失败摘要不含提示词正文");
    assert.ok(failureText.length <= "EACCES · ".length + 120, "UI 摘要不超过 120 字符");

    // 失败摘要只在失败节点展示：重试后已成功的分片即使带着历史 failure 也不渲染。
    const succeededShardRow = rowOfShard(handle.output, "succeeded-shard");
    assert.equal(byClass(succeededShardRow, "deg_expert_group_failure").length, 0);
    assert.equal(byClass(rowOfShard(handle.output, "cancelled-shard"), "deg_expert_group_failure").length, 0);
    // fanout 父任务失败摘要同样受 120 字符上限约束。
    const fanoutFailure = byClass(fanout, "deg_expert_group_failure")[0];
    assert.ok(fanoutFailure);
    assert.ok(textOf(fanoutFailure).length <= "EACCES · ".length + 120);
    assert.equal(textOf(handle.output).includes("完整提示词正文"), false, "侧栏绝不展示完整 prompt");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 未开始运行的行：五段 0 占位（用户要求 2026-10-25）。
 *
 * 占位的前提是**有事实**——宿主已为该行投影 sessionStats/tokenUsage（全 0 投影也算），
 * 或 DEG 侧已有明确的 0 token 事实。因此：
 * - root 与 expert-idle 有全 0 投影 ⇒ 五段全 0 展示，且不伪造语义化 tooltip；
 * - expert-legacy 既没有投影也没有 usage（旧快照）⇒ 仍不渲染摘要条（未知不写成 0）。
 */
test("用量速览：未开始运行的行在宿主投影全 0 时显示五段 0 占位，旧快照仍不渲染摘要条", async () => {
  const createdAt = 1700000000000;
  const zeroProjection = {
    sessionStats: { llmMs: 0, toolMs: 0, decodeMs: 0, decodeTokens: 0 },
    tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: createdAt,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh",
      status: "ready", createdAt,
      children: [
        {
          id: "expert-idle", kind: "expert", sessionId: "expert-idle", taskName: "未开始专家",
          role: "fixer", model: "gpt-5.6-sol", status: "ready", createdAt,
        },
        {
          id: "expert-legacy", kind: "expert", sessionId: "expert-legacy", taskName: "旧快照专家",
          role: "explorer", model: "gpt-5.6-mini", status: "ready",
        },
      ],
    },
  };
  const base = sessionsSnapshot();
  const sessions = sessionsFixtureWith({
    ...base,
    byId: {
      ...base.byId,
      // createdAt === updatedAt：起止差为 0（durationOfNode 返回 null），才有「未开始」的事实。
      "root-1": { ...base.byId["root-1"], createdAt, updatedAt: createdAt, projectionValues: zeroProjection },
      "expert-idle": {
        id: "expert-idle", title: "未开始专家", displayTitle: "expert-idle", running: false,
        createdAt, updatedAt: createdAt, projectionValues: zeroProjection,
      },
      // expert-legacy：没有任何投影（旧快照），也没有 usage/durationMs。
      "expert-legacy": { id: "expert-legacy", title: "旧快照专家", displayTitle: "expert-legacy", running: false },
    },
  });
  const mounted = mountPanel({ hostSnapshot, sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  try {
    await handle.settle();
    const expected = ["用时0s", "0tok/s", "0 tok", "命中0%", "context 0%"];

    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    const rootMetrics = byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0];
    assert.ok(rootMetrics, "主代理行必须显示五段 0 占位");
    assert.equal(rootMetrics.props["aria-label"], "任务用量摘要");
    assert.deepEqual(metricsParts(rootMetrics), expected);

    const idleRow = rowOfExpert(handle.output, "未开始专家");
    assert.ok(idleRow, "未开始专家行必须渲染");
    const idleMetrics = byClass(idleRow, "deg_expert_group_metrics")[0];
    assert.ok(idleMetrics, "子代理行必须显示五段 0 占位");
    assert.deepEqual(metricsParts(idleMetrics), expected);

    // 补齐出来的段不伪造语义化 tooltip：既不写「累计轮次用时 0s」，也不落成「已用 null / 窗口 null」。
    // 唯一的例外是 tok 段——宿主的全 0 tokenUsage 投影给出了真实的 "0 tok" 文本（不是补齐段），
    // 它的 tooltip 仍是 usageTitleOf 的零用量摘要（真实事实），只需保证不含 null。
    for (const part of byClass(rootMetrics, "deg_expert_group_metrics_part")
      .concat(byClass(idleMetrics, "deg_expert_group_metrics_part"))) {
      const title = part.props.title;
      const partText = textOf(part);
      assert.equal(typeof title, "string", "每段都有 tooltip（缺失时回退为段文本）");
      assert.equal(title.includes("累计轮次用时"), false, "占位行不得写「累计轮次用时」tooltip");
      assert.equal(title.includes("null"), false, "占位行 tooltip 不得出现 null");
      if (partText === "0 tok") {
        // 真实的 0 token 事实：tooltip 是完整（且同样全 0）的用量摘要。
        assert.ok(title.startsWith("用量："), "0 tok 段保留真实用量摘要 tooltip");
      } else {
        assert.equal(title, partText, "补齐段 tooltip 回退为段文本本身");
      }
    }

    // 旧快照行（既无投影也无 usage）：未知不写成 0，整条摘要条不渲染。
    const legacyRow = rowOfExpert(handle.output, "旧快照专家");
    assert.ok(legacyRow, "旧快照行仍然渲染");
    assert.equal(byClass(legacyRow, "deg_expert_group_metrics").length, 0, "旧快照行不得补 0 占位");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 运行中补齐（用户要求，2026-10-25 第二次修正）：DSH 投影尚未加载时，摘要条不能塌成
 * 「用时 · tok」两段——缺失段先补 0，等 sessionStats / tokenUsage / contextPressure 到达后
 * 再替换为真实值（五段数量与顺序始终稳定，不跳动）。
 */
test("用量速览：运行中投影未到位时缺失段补 0，投影到达后替换为真实值", async () => {
  const createdAt = 1700000000000;
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: createdAt,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题",
      role: "orchestrator", provider: "A6", model: "gpt-5.6-sol", effort: "xhigh",
      status: "running", createdAt, turnDurationMs: 6000,
      // DEG 侧只有「全 0」用量：0 tok 是有效事实，tok/s 与命中都无法证明。
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
    },
  };
  const base = sessionsSnapshot();
  const sessions = sessionsFixtureWith({
    ...base,
    byId: {
      ...base.byId,
      // 首帧：没有任何 sessionStats / tokenUsage / contextPressure 投影（DSH 尚未加载）。
      "root-1": { ...base.byId["root-1"], createdAt, updatedAt: createdAt },
    },
  });
  const mounted = mountPanel({ hostSnapshot, sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  const rootMetrics = () => {
    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    return byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0];
  };
  try {
    await handle.settle();
    // 首帧：运行中（约 6 秒）但投影未到 —— 五段稳定显示，缺失段补 0。
    const before = rootMetrics();
    assert.ok(before, "运行中的行必须渲染摘要条");
    assert.deepEqual(metricsParts(before), ["用时6s", "0tok/s", "0 tok", "命中0%", "context 0%"]);
    for (const part of byClass(before, "deg_expert_group_metrics_part")) {
      const partText = textOf(part);
      if (partText !== "0tok/s" && partText !== "命中0%" && partText !== "context 0%") continue;
      assert.equal(part.props.title, partText, "补齐段 tooltip 回退为段文本本身");
      assert.equal(part.props.title.includes("平均吞吐"), false, "补齐段不伪造「平均吞吐 0tok/s」");
      assert.equal(part.props.title.includes("已用 null"), false, "补齐段不写「已用 null / 窗口 null」");
    }
    // 用时是真实值（turnDurationMs）：tooltip 保持常规文案，不属于补齐段。
    const durationPart = byClass(before, "deg_expert_group_metrics_part").find((part) => textOf(part) === "用时6s");
    assert.ok(durationPart.props.title.includes("累计轮次用时 6s"), "真实用时的 tooltip 保持常规文案");

    // 投影到达：真实的 sessionStats / tokenUsage / contextPressure 进入 sessions 快照。
    sessions.update({
      ...base,
      byId: {
        ...base.byId,
        "root-1": {
          ...base.byId["root-1"], createdAt, updatedAt: createdAt,
          projectionValues: {
            sessionStats: { turns: 1, llmMs: 6000, toolMs: 0, decodeMs: 2000, decodeTokens: 100 },
            tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 200 },
            contextPressure: { projectedTokens: 30000, contextWindow: 100000 },
          },
        },
      },
    });
    await handle.settle();
    const after = rootMetrics();
    assert.ok(after, "投影到达后摘要条仍在");
    // 行内结构不变，只是把补齐的 0 换成真实值：用时仍优先 turnDurationMs（6s）；
    // tok/s = 100 decode token ÷ 2s = 50；tok = 50+50+0+200 = 300；命中 = 50 ÷ 100 = 50%；
    // context = 30000 ÷ 100000 = 30%。
    assert.deepEqual(metricsParts(after), ["用时6s", "50tok/s", "300 tok", "命中50%", "context 30%"]);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 用时口径（用户要求）：Host 投影的 turnDurationMs 必须优先于 sessionStats.llmMs。
 * 前者与 DSH 状态行「用时 …」同源，但语义是**该会话全部 turn 的累计墙钟**（一轮结束不清零）；
 * 后者只是模型用时；tooltip 仍应保留模型用时，避免信息丢失。
 */
test("用量速览：turnDurationMs 优先于模型用时，与 DSH 状态行同源（累计轮次）", async () => {
  const hostSnapshot = usageMetricsSnapshot();
  // 模拟完整构建的投影：该会话全部 turn 累计 1h30m（远大于夹具里的模型用时）。
  hostSnapshot.root.turnDurationMs = 90 * 60 * 1000;
  const mounted = mountPanel({ hostSnapshot, sessions: usageMetricsSessionsFixture(), storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  try {
    await handle.settle();
    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    const metrics = byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0];
    assert.equal(metricsParts(metrics)[0], "用时1h30m", "running 行必须用累计 turn 墙钟而不是模型用时");
    const durationPart = byClass(metrics, "deg_expert_group_metrics_part").find((part) => textOf(part) === "用时1h30m");
    assert.ok(durationPart, "墙钟用时段必须渲染");
    assert.equal(durationPart.props.title, "累计轮次用时 1h30m", "tooltip 明确累计轮次墙钟语义");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 本地锚定外推（A）：open turn 在两次权威快照之间按 1 秒本地时钟推进。
 *
 * 只允许在「turnDurationMs + turnOpenSince + generatedAt 都有效、行严格 running、快照新鲜」时
 * 相加；closed / 非 running / partial / 缺 generatedAt / 超龄 / 时钟回拨一律只显示权威值。
 * tok/s 回退同理跟随 durationMs 缓慢下降（用户要求的预期语义）。
 */
test("用量速览：open turn 按快照锚点外推；条件不全时只显示权威值", async () => {
  const generatedAt = 1700000060000;
  const clock = installFakeClock(generatedAt + 1000);
  /** 构造「61s 累计 + 最后一段仍未闭合」的根快照；patch 用于逐条关闭外推条件。 */
  const mountWith = (patch) => {
    const hostSnapshot = usageMetricsSnapshot();
    hostSnapshot.generatedAt = generatedAt;
    hostSnapshot.root.turnDurationMs = 61000;
    hostSnapshot.root.turnOpenSince = generatedAt - 61000;
    if (typeof patch === "function") patch(hostSnapshot);
    return mountPanel({ hostSnapshot, sessions: usageMetricsSessionsFixture(), storage: new MemoryStorage() });
  };
  const rootMetricsOf = (handle) => {
    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    return byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0];
  };
  const partsOf = (handle) => byClass(rootMetricsOf(handle), "deg_expert_group_metrics_part").map(textOf);
  const durationPartOf = (handle) => byClass(rootMetricsOf(handle), "deg_expert_group_metrics_part")
    .find((part) => textOf(part).startsWith("用时"));
  const expectAuthorityOnly = async (patch, message) => {
    const mounted = mountWith(patch);
    try {
      await mounted.handle.settle();
      assert.equal(textOf(durationPartOf(mounted.handle)), "用时1m1s", message);
    } finally {
      mounted.handle.unmount();
      mounted.restore();
    }
  };

  try {
    // ① 条件齐全：61s 权威值 + 快照之后 1s = 62s；tooltip 仍是「累计轮次用时」。
    const live = mountWith(null);
    try {
      await live.handle.settle();
      assert.equal(textOf(durationPartOf(live.handle)), "用时1m2s", "open turn 必须按快照锚点外推");
      const durationPart = durationPartOf(live.handle);
      assert.ok(durationPart.props.title.startsWith("累计轮次用时 1m2s"), "tooltip 语义不变");
      // tok/s 回退公式：150 output tok ÷ 62s ≈ 2.4 tok/s（缺失 DSH 实测吞吐时）。
      assert.deepEqual(
        partsOf(live.handle).filter((part) => part.endsWith("tok/s")),
        ["2.4tok/s"],
        "缺 DSH 实测吞吐时按 durationMs 回退",
      );
      // 本地 1 秒时钟推进：文本跟着变化，tok/s 随用时增加而下降（2.3）。
      clock.advance(2000);
      await live.intervals.tick();
      await live.handle.settle();
      assert.equal(textOf(durationPartOf(live.handle)), "用时1m4s", "本地时钟推进后用时文本必须变化");
      assert.deepEqual(
        partsOf(live.handle).filter((part) => part.endsWith("tok/s")),
        ["2.3tok/s"],
        "tok/s 回退随 durationMs 增大而下降",
      );
      // 有 open turn ⇒ 真正的 1 秒 ticker 存在；轮询仍是 2.5 秒（未新增网络轮询）。
      assert.equal(live.intervals.delays.includes(1000), true, "有 open turn ⇒ 存在 1 秒本地 ticker");
      assert.equal(live.intervals.delays.includes(2500), true, "周期性权威同步仍是 2.5 秒轮询");
    } finally {
      live.handle.unmount();
      live.restore();
    }
    assert.equal(live.intervals.active, 0, "卸载必须清理 ticker 与轮询定时器");

    // ② 已闭合（没有 turnOpenSince）只显示权威值。
    await expectAuthorityOnly(
      (snapshot) => { delete snapshot.root.turnOpenSince; },
      "closed turn 不得外推",
    );
    // ③ 非 running：状态已定格。
    await expectAuthorityOnly(
      (snapshot) => { snapshot.root.status = "ready"; },
      "非 running 行不得外推",
    );
    // ④ partial 轻量快照：证据不完整，不做时间外推。
    await expectAuthorityOnly(
      (snapshot) => { snapshot.partial = true; },
      "partial 快照不得外推",
    );
    // ⑤ 缺少 generatedAt：没有锚点。
    await expectAuthorityOnly(
      (snapshot) => { delete snapshot.generatedAt; },
      "缺 generatedAt 不得外推",
    );
    // ⑥ 快照年龄超过 120s：轮询可能已停摆。
    await expectAuthorityOnly(
      (snapshot) => { snapshot.generatedAt = clock.now() - 130000; },
      "快照年龄超过 120s 不得外推",
    );
    // ⑦ 时钟回拨（generatedAt 在未来）：负年龄不加。
    await expectAuthorityOnly(
      (snapshot) => { snapshot.generatedAt = clock.now() + 5000; },
      "时钟回拨不得产生额外用时",
    );
  } finally {
    clock.restore();
  }
});

/**
 * 1 秒本地 ticker 的启停边界：只在「存在 running 且 turnOpenSince 有效」的节点时启动，
 * 没有 open turn 时不创建，卸载后必须清干净（不留下空转定时器）。
 */
test("用量速览：1 秒 ticker 仅在 open turn 存在时启动，卸载必须清理", async () => {
  const generatedAt = 1700000060000;
  const clock = installFakeClock(generatedAt + 1000);
  const mountWith = (withOpenTurn) => {
    const hostSnapshot = usageMetricsSnapshot();
    hostSnapshot.generatedAt = generatedAt;
    hostSnapshot.root.turnDurationMs = 61000;
    if (withOpenTurn === true) hostSnapshot.root.turnOpenSince = generatedAt - 61000;
    return mountPanel({ hostSnapshot, sessions: usageMetricsSessionsFixture(), storage: new MemoryStorage() });
  };
  try {
    const live = mountWith(true);
    try {
      await live.handle.settle();
      assert.equal(
        live.intervals.delays.filter((delay) => delay === 1000).length,
        1,
        "有 open turn ⇒ 恰好一个 1 秒 ticker（每行各建 interval 会多于一个）",
      );
    } finally {
      live.handle.unmount();
      live.restore();
    }
    assert.equal(live.intervals.active, 0, "卸载必须清理 ticker 与轮询定时器");

    const closed = mountWith(false);
    try {
      await closed.handle.settle();
      assert.equal(closed.intervals.delays.includes(1000), false, "没有 open turn ⇒ 绝不启动 ticker");
      assert.equal(closed.intervals.delays.includes(2500), true, "周期性权威同步的轮询照常存在");
    } finally {
      closed.handle.unmount();
      closed.restore();
    }
    assert.equal(closed.intervals.active, 0);
  } finally {
    clock.restore();
  }
});

/**
 * 用量速览的 context 读面回归：三条读面依次回退，fan-out 父任务与缺失投影的节点整段省略。
 *
 * 真实快照里 contextPressure 往往不可用，摘要条必须优雅省略——绝不伪造上下文占用。
 */
test("用量速览：context 依次读取 byId / projectionsBySession / projectionValues 三读面，缺失整段省略", async () => {
  const base = usageMetricsSessionsFixture();
  const snapshot = base.list.getSnapshot();
  // 删掉分片 child 的 byId 投影，迫使它走第三兜底 config.sessions.projectionValues(sessionId)。
  const byId = { ...snapshot.byId };
  byId["failed-child-7"] = { id: "failed-child-7", title: "失败第七次", running: false };
  const calls = [];
  const sessions = sessionsFixtureWith({ ...snapshot, byId });
  sessions.projectionValues = (sessionId) => {
    calls.push(sessionId);
    return sessionId === "failed-child-7"
      ? { contextPressure: { projectedTokens: 120000, contextWindow: 240000 } }
      : null;
  };
  const mounted = mountPanel({ hostSnapshot: usageMetricsSnapshot(), sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；分片 context 断言需要分片行在树上，先展开。
    await expandFanouts(handle);
    // 1) root：byId[sessionId].projectionValues.contextPressure。
    const rootRow = byClass(handle.output, "deg_expert_group_node_root")[0];
    assert.ok(
      metricsParts(byClass(byClass(rootRow, "deg_expert_group_row")[0], "deg_expert_group_metrics")[0]).includes("context 30%"),
      "root 的 context 必须来自 byId 投影",
    );
    // 2) 专家：projectionsBySession[sessionId].values.contextPressure。
    assert.ok(
      metricsParts(byClass(rowOfExpert(handle.output, "运行专家"), "deg_expert_group_metrics")[0]).includes("context 20%"),
      "专家的 context 必须来自 projectionsBySession",
    );
    // 3) 分片：config.sessions.projectionValues(sessionId) 兜底（120000/240000 = 50%）。
    assert.ok(
      metricsParts(byClass(rowOfShard(handle.output, "failed-shard"), "deg_expert_group_metrics")[0]).includes("context 50%"),
      "分片的 context 必须走第三兜底读面",
    );
    assert.ok(calls.includes("failed-child-7"), "第三读面必须收到分片最新 attempt 的 childId");
    // fan-out 父任务没有单一会话：其余四段照常，context 整段省略。
    const fanoutParts = metricsParts(byClass(byClass(handle.output, "deg_expert_group_fanout")[0], "deg_expert_group_metrics")[0]);
    assert.equal(fanoutParts.some((part) => part.startsWith("context ")), false, "fan-out 父任务不得显示 context");
    // 没有 contextPressure 投影的节点：只渲染其余可证明的段（这里是节点起点 → 会话 updatedAt）。
    assert.deepEqual(metricsParts(byClass(rowOfExpert(handle.output, "空闲专家"), "deg_expert_group_metrics")[0]), ["用时12m30s"]);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 运行时间的真实数据源回归（critical 修复）：
 *
 * 生产 sessions 列表快照没有 generatedAt，运行中行的终点时间只能来自 DEG Host 快照。
 * fan-out 父任务没有 sessionId，同样必须能按「节点 startedAt → generatedAt」算出用时。
 */
test("用量速览：运行中的 fan-out（无 sessionId）与专家在 sessions 快照无 generatedAt 时仍显示用时", async () => {
  const hostSnapshot = usageMetricsSnapshot();
  // 运行中的 fan-out：删除 durationMs，只留下节点 startedAt 与 DEG 快照 generatedAt。
  const fanout = hostSnapshot.root.children.find((node) => node.kind === "fanout");
  delete fanout.durationMs;
  fanout.status = "running";
  fanout.taskStatus = "running";
  // 运行中的专家：同样删除 durationMs（usage 里也没有 runMs）。
  const expert = hostSnapshot.root.children.find((node) => node.id === "expert-running");
  delete expert.durationMs;
  const sessions = usageMetricsSessionsFixture();
  assert.equal(sessions.list.getSnapshot().generatedAt, undefined, "sessions 快照不提供 generatedAt");
  const mounted = mountPanel({ hostSnapshot, sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  try {
    await handle.settle();
    // 1700000060000（DEG generatedAt） - 1699999100000（节点 startedAt） = 960000ms → 「16m」。
    const fanoutParts = metricsParts(byClass(byClass(handle.output, "deg_expert_group_fanout")[0], "deg_expert_group_metrics")[0]);
    assert.equal(fanoutParts[0], "用时16m", "运行中的 fan-out 必须按节点起点 + DEG generatedAt 显示用时");
    assert.ok(fanoutParts.some((part) => part.endsWith("tok/s")), "fan-out 的 TPS 不能被时长缺失连带吞掉");
    const expertParts = metricsParts(byClass(rowOfExpert(handle.output, "运行专家"), "deg_expert_group_metrics")[0]);
    assert.equal(expertParts[0], "用时16m", "运行中的专家必须按节点起点 + DEG generatedAt 显示用时");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * DSH 权威数据优先（用户实测回归）：
 * 旧会话没有 DEG usage/duration 时，必须用 sessionStats（模型用时/输出速度）与
 * tokenUsage（tok/命中）渲染，不得再出现「用时<1s」或缺少 tok/TPS。
 */
test("用量速览：DSH sessionStats/tokenUsage 优先，旧会话不再显示 <1s 假用时", async () => {
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  const rootMetricsOf = (output) => {
    const rootNode = byClass(output, "deg_expert_group_node_root")[0];
    const rootRow = byClass(rootNode, "deg_expert_group_row")[0];
    return byClass(rootRow, "deg_expert_group_metrics")[0];
  };
  const expected = ["用时1h5m", "208tok/s", "109M tok", "命中97%", "context 32%"];

  // a) DEG 给出错误用量（15 tok）与 500ms 假时长：DSH 投影必须胜出。
  const wrong = usageMetricsSnapshot();
  wrong.root.usage = { inputTokens: 10, outputTokens: 5 };
  wrong.root.durationMs = 500;
  const mounted = mountPanel({ hostSnapshot: wrong, sessions: dshMetricsSessionsFixture(), storage: new MemoryStorage() });
  try {
    await mounted.handle.settle();
    const metrics = rootMetricsOf(mounted.handle.output);
    assert.ok(metrics, "root 行必须渲染摘要条");
    assert.deepEqual(metricsParts(metrics), expected);
    const durationPart = byClass(metrics, "deg_expert_group_metrics_part").find((part) => textOf(part) === "用时1h5m");
    assert.equal(durationPart.props.title, "模型用时 1h5m · 工具调用用时 18m56s", "tooltip 同时给出模型用时与工具调用用时");
    const tokPart = byClass(metrics, "deg_expert_group_metrics_part").find((part) => textOf(part) === "109M tok");
    assert.ok(tokPart.props.title.includes("输入 3200000"));
    assert.ok(tokPart.props.title.includes("缓存读 105000000"));
    const metricsText = textOf(metrics);
    assert.equal(metricsText.includes("<1s"), false, "DSH 模型用时不得被 DEG 的 500ms 覆盖");
    assert.equal(metricsText.includes("15 tok"), false, "DEG 的错误用量不得覆盖 DSH tokenUsage");
  } finally {
    mounted.handle.unmount();
    mounted.restore();
  }

  // b) 旧专家行（用户截图中的实际形态）：无 DEG usage/duration，仍由 DSH 投影渲染。
  const expertHost = usageMetricsSnapshot();
  const expertNode = expertHost.root.children.find((node) => node.id === "expert-running");
  delete expertNode.usage;
  delete expertNode.durationMs;
  const expertMounted = mountPanel({ hostSnapshot: expertHost, sessions: dshMetricsSessionsFixture(), storage: new MemoryStorage() });
  try {
    await expertMounted.handle.settle();
    const expertMetrics = byClass(rowOfExpert(expertMounted.handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(expertMetrics), expected);
    assert.equal(textOf(expertMetrics).includes("<1s"), false, "旧专家不得出现 <1s 假用时");
  } finally {
    expertMounted.handle.unmount();
    expertMounted.restore();
  }

  // c) 旧会话完全没有 DEG usage/duration：DSH 仍给出同一行，不再出现 <1s / 1.8s 假用时。
  const legacy = usageMetricsSnapshot();
  delete legacy.root.usage;
  delete legacy.root.durationMs;
  const legacyMounted = mountPanel({ hostSnapshot: legacy, sessions: dshMetricsSessionsFixture(), storage: new MemoryStorage() });
  try {
    await legacyMounted.handle.settle();
    const metrics = rootMetricsOf(legacyMounted.handle.output);
    assert.deepEqual(metricsParts(metrics), expected);
    const metricsText = textOf(metrics);
    assert.equal(metricsText.includes("<1s"), false, "旧会话不得出现 <1s 假用时");
    assert.equal(metricsText.includes("1.8s"), false, "旧会话不得出现 1.8s 假用时");
  } finally {
    legacyMounted.handle.unmount();
    legacyMounted.restore();
  }
});

/**
 * 分片/fan-out 的 DSH 会话归属：
 * 分片只用「最新 attempt 的 childId」；fan-out 用每个 shard 最新 childId 去重后聚合；
 * context 仍然只来自单会话（fan-out 没有单一会话 ⇒ 不显示 context）。
 */
test("用量速览：分片取最新 child 的 DSH 投影，fan-out 聚合各 shard 最新 child", async () => {
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  const hostSnapshot = usageMetricsSnapshot();
  // 取消分片在时间线夹具里没有 childId：补上最新 attempt 的 childId，覆盖 fan-out 的多 child 聚合。
  const fanoutTask = hostSnapshot.root.children.find((node) => node.kind === "fanout");
  const cancelledShard = fanoutTask.shards.find((shard) => shard.shardId === "cancelled-shard");
  cancelledShard.childId = "cancelled-child";
  cancelledShard.attempts = [{
    attempt: 1, status: "cancelled", childId: "cancelled-child",
    startedAt: 1699999800000, finishedAt: 1699999900000,
  }];
  const mounted = mountPanel({ hostSnapshot, sessions: dshShardSessionsFixture(), storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；分片投影断言需要分片行在树上，先展开。
    await expandFanouts(handle);
    // 失败分片：600000ms = 10m；40000/2s = 20000tok/s；2000+8000+0+40000 = 50k；8000/10000 = 80%；context 25%。
    assert.deepEqual(
      metricsParts(byClass(rowOfShard(handle.output, "failed-shard"), "deg_expert_group_metrics")[0]),
      ["用时10m", "20000tok/s", "50k tok", "命中80%", "context 25%"],
      "分片必须使用最新 attempt childId 的 DSH 投影，而不是 DEG 的 14m10s/82k/90%",
    );
    // fan-out 聚合 failed-child-7 + cancelled-child：
    // llm 660000ms=11m；decode 45000/3s=15000tok/s；tok 55000=55k；hit 8000/10000=80%。
    const fanoutMetrics = byClass(byClass(handle.output, "deg_expert_group_fanout")[0], "deg_expert_group_metrics")[0];
    assert.deepEqual(
      metricsParts(fanoutMetrics),
      ["用时11m", "15000tok/s", "55k tok", "命中80%"],
      "fan-out 必须聚合每个 shard 最新 childId 的 DSH 指标，而不是 DEG 的 28m27s/29M/98%",
    );
    assert.equal(
      metricsParts(fanoutMetrics).some((part) => part.startsWith("context ")),
      false,
      "fan-out 父任务没有单一会话，不得显示 context",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 「旧会话尚未加载 sessionStats」夹具：sessions 里只有 tokenUsage / contextPressure。
 *
 * 这正是生产 sessions 列表快照的形态：sessionStats 是客户端按需投影，只有会话被打开过或经
 * sessions.refreshProjections(sessionId) 显式刷新后才会出现。contextPressure 给出「刷新前」的
 * 回退值（root 30%、expert-running 20%），刷新成功后由 dshProjectionValues() 提供 32%。
 * nested-expert / expert-ready / failed-child-7 不在 byId 里，同样必须被按需请求。
 */
function staleProjectionSessionsSnapshot() {
  const base = sessionsSnapshot();
  const tokenUsage = dshProjectionValues().tokenUsage;
  return {
    ...base,
    byId: {
      ...base.byId,
      "root-1": {
        ...base.byId["root-1"],
        projectionValues: {
          tokenUsage,
          contextPressure: { projectedTokens: 30000, contextWindow: 100000 },
        },
      },
      "expert-running": {
        ...base.byId["expert-running"],
        projectionValues: {
          tokenUsage,
          contextPressure: { projectedTokens: 40000, contextWindow: 200000 },
        },
      },
    },
  };
}

/** 旧专家行夹具：DEG 端没有 usage/duration，只能靠会话投影（否则回退到粗粒度的起止时间差）。 */
function legacyExpertUsageSnapshot() {
  const host = usageMetricsSnapshot();
  const expert = host.root.children.find((node) => node.id === "expert-running");
  delete expert.usage;
  delete expert.durationMs;
  return host;
}

/**
 * 按需投影加载（用户实测回归）：未打开过的 child 不会自动带 sessionStats。
 *
 * 面板必须在拿到 DEG 快照后，对「树里出现但还没有 sessionStats」的会话各请求一次
 * sessions.refreshProjections；已有投影的会话不再请求，重复渲染/新快照也不重复请求。
 */
test("用量速览：缺失 sessionStats 的 root/专家/分片最新 child 各按需刷新一次投影", async () => {
  const hostSnapshot = legacyExpertUsageSnapshot();
  const sessions = sessionsFixtureWith(staleProjectionSessionsSnapshot(), [], () => Promise.resolve());
  const mounted = mountPanel({ hostSnapshot, sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // root / 专家 / 嵌套专家（递归 children）/ 分片最新 attempt child 都必须请求一次。
    for (const expected of ["root-1", "expert-running", "nested-expert", "expert-ready", "failed-child-7"]) {
      assert.ok(sessions.refreshCalls.includes(expected), "缺失 sessionStats 的会话必须按需刷新：" + expected);
    }
    // 分片只认最新 attempt 的 childId：旧 attempt 的历史会话绝不请求。
    assert.equal(sessions.refreshCalls.includes("failed-child-1"), false, "分片只请求最新 attempt 的 childId");
    assert.equal(sessions.refreshCalls.includes("failed-child-6"), false, "旧 attempt 的 childId 不参与按需刷新");
    assert.equal(
      sessions.refreshCalls.length,
      new Set(sessions.refreshCalls).size,
      "同一会话只允许请求一次",
    );
    const beforeRefresh = [...sessions.refreshCalls];

    // 重复渲染（手动刷新拿到一份内容不同的新快照）：集合跨渲染保留，绝不重复请求。
    // revision 是 Host 的内容摘要，内容变了就一起改，避免被 revision 短路吞掉。
    const nested = hostSnapshot.root.children.find((node) => node.id === "expert-running").children[0];
    nested.taskName = "嵌套子任务（刷新后）";
    hostSnapshot.revision = "rev-timeline-refreshed";
    byAria(handle.output, "刷新").props.onClick();
    await handle.settle();
    assert.deepEqual(sessions.refreshCalls, beforeRefresh, "新快照触发的重渲染不得重复请求同一会话");
    assert.ok(
      textOf(handle.output).includes("嵌套子任务（刷新后）"),
      "手动刷新必须拿到新快照（证明 effect 确实以新快照重跑过）",
    );
    assert.equal(handle.cleanupErrors.length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 按需刷新成功的完整链路：首帧允许短暂回退 DEG（不阻塞渲染），刷新把 sessionStats/tokenUsage
 * 写回 sessions 快照并通知订阅后，同一行自动切换到 DSH 权威值；已有 sessionStats 的会话不再请求。
 */
test("用量速览：按需刷新成功后旧专家行从 DEG 回退切到 DSH 权威值", async () => {
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  const raw = staleProjectionSessionsSnapshot();
  // root 已经有 sessionStats：不得再请求刷新（只刷新真正缺失的那些会话）。
  raw.byId["root-1"] = { ...raw.byId["root-1"], projectionValues: dshProjectionValues() };
  // 刷新挂起：用例先断言「快照已上屏但 sessionStats 未加载」的回退形态，再手动放行刷新。
  let releaseRefresh = null;
  const sessions = sessionsFixtureWith(raw, [], (sessionId, fixture) => new Promise((resolve) => {
    if (sessionId !== "expert-running") { resolve(); return; }
    releaseRefresh = () => {
      const current = fixture.list.getSnapshot();
      fixture.update({
        ...current,
        byId: {
          ...current.byId,
          "expert-running": { ...current.byId["expert-running"], projectionValues: dshProjectionValues() },
        },
      });
      resolve();
    };
  }));
  const mounted = mountPanel({ hostSnapshot: legacyExpertUsageSnapshot(), sessions, storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 刷新尚未结算：快照已上屏，但该行只能显示 DEG 回退值（16m；吞吐由输出量回退算出）。
    const beforeRefresh = metricsParts(byClass(rowOfExpert(handle.output, "运行专家"), "deg_expert_group_metrics")[0]);
    assert.deepEqual(beforeRefresh, ["用时16m", "833tok/s", "109M tok", "命中97%", "context 20%"], "刷新完成前允许显示 DEG 回退值");
    assert.ok(sessions.refreshCalls.includes("expert-running"), "缺失 sessionStats 的专家必须请求刷新");
    assert.equal(sessions.refreshCalls.includes("root-1"), false, "已有 sessionStats 的会话不得再请求刷新");
    assert.equal(typeof releaseRefresh, "function", "专家会话必须发起过一次按需刷新");

    // 放行刷新：sessions 快照写入 sessionStats/tokenUsage 并通知订阅 → 面板 bump 重渲染。
    releaseRefresh();
    await handle.settle();
    const expertMetrics = byClass(rowOfExpert(handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(
      metricsParts(expertMetrics),
      ["用时1h5m", "208tok/s", "109M tok", "命中97%", "context 32%"],
      "刷新成功后必须切换到 DSH 权威值（不再显示 DEG 回退的 16m / 833tok/s / context 20%）",
    );
    assert.equal(textOf(expertMetrics).includes("<1s"), false, "不得出现 <1s 假用时");
    assert.equal(
      sessions.refreshCalls.filter((id) => id === "expert-running").length,
      1,
      "同一会话只请求一次",
    );
    assert.equal(handle.cleanupErrors.length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 投影刷新是旁路优化：公开方法缺失、同步抛错或 Promise 拒绝时，面板必须照常渲染且不循环请求。
 */
test("用量速览：refreshProjections 缺失/抛错/拒绝时面板不崩、不循环", async () => {
  const metricsParts = (node) => byClass(node, "deg_expert_group_metrics_part").map(textOf);
  const fallbackParts = ["用时16m", "833tok/s", "109M tok", "命中97%", "context 20%"];

  // a) 旧宿主没有 refreshProjections：完全 no-op，回退值照常显示。
  const absent = sessionsFixtureWith(staleProjectionSessionsSnapshot());
  const absentMounted = mountPanel({ hostSnapshot: legacyExpertUsageSnapshot(), sessions: absent, storage: new MemoryStorage() });
  try {
    await absentMounted.handle.settle();
    const metrics = byClass(rowOfExpert(absentMounted.handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(metrics), fallbackParts, "方法缺失时必须保留 DEG 回退值");
    assert.equal(absentMounted.handle.cleanupErrors.length, 0);
    assert.ok(absentMounted.handle.renderCount <= 4, "不得因为缺少刷新入口而自转：渲染次数 " + absentMounted.handle.renderCount);
  } finally {
    absentMounted.handle.unmount();
    absentMounted.restore();
  }

  // b) 同步抛错：异常被吞掉，每个会话只尝试一次。
  let syncAttempts = 0;
  const throwing = sessionsFixtureWith(staleProjectionSessionsSnapshot(), [], () => {
    syncAttempts += 1;
    throw new Error("refresh boom");
  });
  const throwingMounted = mountPanel({ hostSnapshot: legacyExpertUsageSnapshot(), sessions: throwing, storage: new MemoryStorage() });
  try {
    await throwingMounted.handle.settle();
    const metrics = byClass(rowOfExpert(throwingMounted.handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(metrics), fallbackParts, "刷新抛错时必须保留 DEG 回退值");
    assert.equal(throwing.refreshCalls.length, syncAttempts);
    assert.equal(throwing.refreshCalls.length, new Set(throwing.refreshCalls).size, "抛错后同一会话不得重试");
    assert.equal(throwingMounted.handle.cleanupErrors.length, 0);
    assert.ok(throwingMounted.handle.renderCount <= 4, "抛错不得触发渲染循环");
  } finally {
    throwingMounted.handle.unmount();
    throwingMounted.restore();
  }

  // c) 读取公开方法本身抛错（服务代理对未声明属性会抛）：按「没有这个入口」处理，不崩。
  const hostile = sessionsFixtureWith(staleProjectionSessionsSnapshot());
  Object.defineProperty(hostile, "refreshProjections", {
    configurable: true,
    get() { throw new Error("service proxy denied"); },
  });
  const hostileMounted = mountPanel({ hostSnapshot: legacyExpertUsageSnapshot(), sessions: hostile, storage: new MemoryStorage() });
  try {
    await hostileMounted.handle.settle();
    const metrics = byClass(rowOfExpert(hostileMounted.handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(metrics), fallbackParts, "方法读取抛错时必须保留 DEG 回退值");
    assert.equal(hostile.refreshCalls.length, 0, "读不到方法时不得请求任何会话");
    assert.equal(hostileMounted.handle.cleanupErrors.length, 0);
  } finally {
    hostileMounted.handle.unmount();
    hostileMounted.restore();
  }

  // d) Promise 拒绝：catch 吞掉（未捕获拒绝会让本用例失败），面板照常显示回退值。
  const rejecting = sessionsFixtureWith(staleProjectionSessionsSnapshot(), [], () => Promise.reject(new Error("refresh rejected")));
  const rejectingMounted = mountPanel({ hostSnapshot: legacyExpertUsageSnapshot(), sessions: rejecting, storage: new MemoryStorage() });
  try {
    await rejectingMounted.handle.settle();
    const metrics = byClass(rowOfExpert(rejectingMounted.handle.output, "运行专家"), "deg_expert_group_metrics")[0];
    assert.deepEqual(metricsParts(metrics), fallbackParts, "刷新被拒绝时必须保留 DEG 回退值");
    assert.equal(rejecting.refreshCalls.length, new Set(rejecting.refreshCalls).size, "拒绝后同一会话不得重试");
    assert.equal(rejectingMounted.handle.cleanupErrors.length, 0);
  } finally {
    rejectingMounted.handle.unmount();
    rejectingMounted.restore();
  }
});

/**
 * 行为契约变更（用户明确要求）：分片行下方不再展示 attempt 明细。
 *
 * 旧用例断言「失败分片默认展开、展示最近 5 条 attempt，查看全部/收起只改展示条数」，
 * 那是旧的渐进披露契约。用户要求分片行与普通叶子子代理行表现一致，因此整条时间线被移除。
 * 本用例现在证明的是相反的事实：
 * - 无论分片处于失败、成功、取消还是运行状态，行内都不存在 attempts / attempt 节点；
 * - 分片行没有可点击的折叠箭头，只有与叶子专家行一致的占位 span；
 * - 用量摘要条与结构化结果块仍然常驻（精简的是 attempt 明细，不是用量事实）。
 * 既有「父任务不渲染聚合时间线」「不新增 RPC」「cleanupErrors 为 0」断言原样保留。
 */
test("票据 12：分片不再渲染 attempt 时间线（用户要求），仅保留用量摘要", async () => {
  // 先用同一份夹具把首个分片改成 running 再挂一次：即使快照里仍带着 7 条 attempt，
  // 运行状态的分片同样一节点都不渲染，证明「不渲染时间线」与状态无关。
  const runningSnapshot = timelinePanelSnapshot();
  runningSnapshot.root.children.find((node) => node.kind === "fanout").shards[0].status = "running";
  const runningMounted = mountPanel({ hostSnapshot: runningSnapshot, storage: new MemoryStorage() });
  try {
    await runningMounted.handle.settle();
    // 夹具的父任务仍是结算态（failed）⇒ 默认收起；先展开，才能读到分片行本身。
    await expandFanouts(runningMounted.handle);
    const runningRow = rowOfShard(runningMounted.handle.output, "failed-shard");
    assert.ok(runningRow, "运行状态的分片行必须渲染");
    assert.equal(byClass(runningRow, "deg_expert_group_attempts").length, 0, "运行状态分片不得渲染 attempt 时间线");
    assert.equal(byClass(runningRow, "deg_expert_group_attempt").length, 0, "运行状态分片不得渲染 attempt 条目");
  } finally {
    runningMounted.handle.unmount();
    runningMounted.restore();
  }

  const mounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage: new MemoryStorage() });
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；本用例验证分片行内部结构，先按用户方式展开。
    await expandFanouts(handle);
    const requestCountBefore = requests.length;

    // 每个分片行（失败 / 成功 / 取消）都不得再有 attempt 时间线或条目。
    const shardIds = byClass(handle.output, "deg_expert_group_shard").map((row) => row.props["data-shard-id"]);
    assert.deepEqual(shardIds, ["failed-shard", "succeeded-shard", "cancelled-shard"], "三个分片行都必须渲染");
    for (const shardId of shardIds) {
      const row = rowOfShard(handle.output, shardId);
      assert.equal(byClass(row, "deg_expert_group_attempts").length, 0, "分片行不得渲染 attempt 时间线：" + shardId);
      assert.equal(byClass(row, "deg_expert_group_attempt").length, 0, "分片行不得渲染 attempt 条目：" + shardId);
      // 没有可折叠内容 ⇒ 不渲染可点击箭头，只保留与叶子专家行一致的占位 span。
      assert.equal(byClass(row, "deg_expert_group_chevron").length, 0, "分片行不得渲染可点击折叠箭头：" + shardId);
      assert.equal(byClass(row, "deg_expert_group_chevron_placeholder").length, 1, "分片行必须有占位箭头：" + shardId);
      // data-expanded 恒为 true：属性保留，避免 CSS [data-expanded=false] 分支被意外命中。
      assert.equal(row.props["data-expanded"], true, "分片行恒为展开态：" + shardId);
    }

    // 用量摘要条常驻：精简的是 attempt 明细，不是用量事实。
    assert.ok(byClass(rowOfShard(handle.output, "failed-shard"), "deg_expert_group_metrics")[0], "分片行用量摘要条必须保留");

    // 占位 span 不是按钮：没有点击入口，也就不存在「点了没变化」的控件。
    const placeholder = byClass(rowOfShard(handle.output, "failed-shard"), "deg_expert_group_chevron_placeholder")[0];
    assert.equal(placeholder.props.onClick, undefined);
    assert.equal(placeholder.props["aria-hidden"], "true");

    // 该夹具没有结构化结果：footer 必须保持 null，不渲染空容器。
    assert.equal(
      byClass(rowOfShard(handle.output, "failed-shard"), "deg_expert_group_shard_extra").length,
      0,
      "没有结构化结果时不得渲染空的 shard_extra",
    );

    // 用户精简侧栏：fan-out 父任务不再渲染跨分片聚合时间线（10 条摊平视图已移除），
    // 分片自己的时间线同样被移除，整个 fan-out 子树不再有任何 attempt 节点。
    const fanoutContainer = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(
      byClass(fanoutContainer, "deg_expert_group_attempts").some((timelineNode) => timelineNode.props["data-total"] === "10"),
      false,
      "父任务不得再渲染聚合 attempt 时间线",
    );
    assert.equal(byClass(handle.output, "deg_expert_group_attempt_shard").length, 0, "聚合视图移除后不再有分片归属单元格");
    assert.equal(
      walk(handle.output).some((node) => String(node?.props?.className ?? "").split(/\s+/).includes("deg_expert_group_attempt")
        && node.props["data-shard-id"] !== undefined),
      false,
      "attempt 条目不再携带 data-shard-id（分片归属单元格已移除）",
    );

    // 整棵树里不再有任何 attempt 时间线节点（父任务与分片都已移除）。
    assert.equal(byClass(handle.output, "deg_expert_group_attempts").length, 0, "整棵面板不得渲染 attempt 时间线");
    assert.equal(byClass(handle.output, "deg_expert_group_attempt").length, 0);

    assert.equal(requests.length, requestCountBefore, "移除时间线绝不新增 RPC");
    assert.equal(requests.some((request) => request.action !== "expert-group-snapshot"), false);
    assert.equal(handle.cleanupErrors.length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 侧栏精简的结构回归（用户明确要求删除的两类信息）。
 *
 * 1) 子代理行的第三行摘要 `.deg_expert_group_content` 必须从渲染树彻底消失，
 *    root / 专家 / 分片的行主体都只保留「任务名 + 模型元数据」两个子节点；
 * 2) fan-out 父任务不再显示跨分片聚合 attempt 时间线（摊平后的 data-total=10），
 *    分片也不再展示自己的 attempt 历史——用户要求分片行与普通叶子子代理行一致。
 */
test("侧栏精简回归：行主体固定两行、父任务无聚合时间线、分片不得再渲染 attempt 历史", async () => {
  const mounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；行主体断言需要分片行在树上，先展开。
    await expandFanouts(handle);

    // 1) 第三行摘要节点不存在（选择器命中 0 个）。
    assert.equal(byClass(handle.output, "deg_expert_group_content").length, 0, "第三行摘要节点必须为 0");

    // 2) 所有 row_main（root / 专家 / 分片）都恰好两个子节点：任务名行 + 元数据行。
    const rows = byClass(handle.output, "deg_expert_group_row_main");
    assert.ok(rows.length >= 3, "root、专家与分片行都必须渲染");
    for (const row of rows) {
      assert.equal(row.children.length, 2, "row_main 必须只有两行：" + String(row.props["data-kind"]));
      assert.deepEqual(
        String(row.children[0].props?.className ?? "").split(/\s+/).includes("deg_expert_group_task_line"),
        true,
        "第一行是任务名行",
      );
      assert.deepEqual(
        String(row.children[1].props?.className ?? "").split(/\s+/).includes("deg_expert_group_meta"),
        true,
        "第二行是模型元数据",
      );
    }
    assert.equal(rows.some((row) => row.props["data-kind"] === "root"), true, "根行必须按两行渲染");
    assert.equal(rows.some((row) => row.props["data-kind"] === "expert"), true, "专家/分片行必须按两行渲染");

    // 3) fan-out 父任务没有聚合时间线；分片同样不得再渲染 attempt 历史（含其 7 条 attempt）。
    const fanout = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.equal(
      byClass(fanout, "deg_expert_group_attempts").some((timeline) => timeline.props["data-total"] === "10"),
      false,
      "父任务不得再渲染聚合 attempt 时间线",
    );
    const shard = byClass(handle.output, "deg_expert_group_shard").find((row) => row.props["data-shard-id"] === "failed-shard");
    assert.ok(shard, "失败分片行必须渲染");
    assert.equal(byClass(shard, "deg_expert_group_attempts").length, 0, "分片不得再渲染 attempt 历史");
    assert.equal(byClass(shard, "deg_expert_group_attempt").length, 0, "分片不得再渲染 attempt 条目");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 12：专家行可折叠（有子节点时）；叶子专家保留占位箭头，绝不渲染无效果按钮", async () => {
  const mounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const expertRow = rowOfExpert(handle.output, "运行专家");
    assert.ok(expertRow);
    const expertNode = byClass(handle.output, "deg_expert_group_node").find((node) => textOf(node).includes("运行专家") && !textOf(node).includes("主代理"));
    assert.ok(expertNode);
    assert.equal(textOf(expertNode).includes("嵌套子任务"), true, "嵌套专家默认展示");
    const chevron = byClass(expertRow, "deg_expert_group_chevron")[0];
    assert.ok(chevron, "有子节点的专家行必须渲染折叠箭头");
    assert.equal(chevron.props["aria-expanded"], true);
    chevron.props.onClick({ stopPropagation() {} });
    await handle.settle();
    const collapsedRow = rowOfExpert(handle.output, "运行专家");
    assert.equal(byClass(collapsedRow, "deg_expert_group_chevron")[0].props["aria-expanded"], false);
    assert.equal(textOf(handle.output).includes("嵌套子任务"), false, "折叠后子节点收纳");
    byClass(collapsedRow, "deg_expert_group_chevron")[0].props.onClick({ stopPropagation() {} });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("嵌套子任务"), true, "再次展开恢复子节点");

    // 叶子专家（没有子节点）不渲染可折叠箭头：占位 span 不进入键盘/可访问性交互面。
    const leafRow = rowOfExpert(handle.output, "空闲专家");
    assert.ok(leafRow);
    assert.equal(byClass(leafRow, "deg_expert_group_chevron").length, 0, "叶子专家行没有折叠箭头");
    assert.equal(byClass(leafRow, "deg_expert_group_chevron_placeholder").length, 1);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 12：客户端本地搜索/角色/状态过滤保留祖先路径，不新增 RPC 也不持久化", async () => {
  const storage = new MemoryStorage();
  const mounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage });
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 结算态 fan-out 默认收起（需求二）；过滤断言要看分片名是否命中，先展开到分片行可见。
    await expandFanouts(handle);
    // 展开是唯一会写 sessionStorage 的 UI 状态；记下它，用来证明过滤本身一个字都没写。
    const storageAfterExpand = [...storage.values.entries()];
    const requestCountBefore = requests.length;
    const search = byAria(handle.output, "搜索任务");
    const roleSelect = byAria(handle.output, "按角色筛选");
    const statusSelect = byAria(handle.output, "按状态筛选");
    assert.ok(search && roleSelect && statusSelect, "顶部工具条必须有搜索框 + 角色/状态筛选");
    // 选项契约（需求变更）：分组选项恰好三项——运行中 / 未完成 / 已完成（空值项「全部状态」不计）。
    const statusOptionNodes = (statusSelect.props.children ?? [])
      .filter((node) => typeof node === "object" && node !== null && node.type === "option");
    const groupedStatusOptions = statusOptionNodes.filter((option) => option.props.value !== "");
    assert.equal(groupedStatusOptions.length, 3, "状态下拉只剩三个分组选项");
    assert.deepEqual(groupedStatusOptions.map((option) => option.props.value), ["running", "incomplete", "completed"]);
    assert.deepEqual(groupedStatusOptions.map((option) => textOf(option)), ["运行中", "未完成", "已完成"]);

    // 任务名搜索：命中分片时保留祖先（根 + fan-out 分支），其它节点整棵隐藏。
    search.props.onChange({ target: { value: "failed-shard" } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("失败分片"), true);
    assert.equal(textOf(handle.output).includes("成功分片"), false);
    assert.equal(textOf(handle.output).includes("运行专家"), false);
    assert.ok(byClass(handle.output, "deg_expert_group_node_root")[0], "根节点（祖先路径）始终保留");
    assert.ok(byClass(handle.output, "deg_expert_group_fanout")[0], "命中分片的 fan-out 父任务保留");

    // 清空搜索后恢复完整树。
    byAria(handle.output, "搜索任务").props.onChange({ target: { value: "" } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("成功分片"), true);
    assert.equal(textOf(handle.output).includes("运行专家"), true);

    // 角色筛选：只保留该角色节点；父任务/父专家因后代命中而保留（祖先路径），但只展示命中的分片。
    byAria(handle.output, "按角色筛选").props.onChange({ target: { value: "designer" } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("失败分片"), true);
    assert.equal(textOf(handle.output).includes("成功分片"), false);
    assert.equal(textOf(handle.output).includes("嵌套子任务"), true, "designer 角色的嵌套专家命中");
    assert.equal(textOf(handle.output).includes("运行专家"), true, "命中后代的祖先专家行保留");
    assert.equal(textOf(handle.output).includes("空闲专家"), false, "没有 designer 后代的兄弟节点被过滤");
    byAria(handle.output, "按角色筛选").props.onChange({ target: { value: "" } });
    await handle.settle();

    // 状态筛选：「未完成」= 失败/超时/中断/取消，以及没有正常完成证据的 idle/ready/unknown；
    // 有 succeeded 证据的成功分片与仍在跑的运行专家都不属于未完成。
    byAria(handle.output, "按状态筛选").props.onChange({ target: { value: "incomplete" } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("失败分片"), true);
    assert.equal(textOf(handle.output).includes("成功分片"), false);
    assert.equal(textOf(handle.output).includes("运行专家"), false);
    // 空闲专家的协议状态是 ready：没有正常完成（succeeded）的证据，因此归入「未完成」可见。
    assert.equal(textOf(handle.output).includes("空闲专家"), true, "ready 无正常完成证据 ⇒ 未完成");
    byAria(handle.output, "按状态筛选").props.onChange({ target: { value: "" } });
    await handle.settle();

    // 「已完成」只认 succeeded：成功分片可见，失败分片/运行专家/空闲专家都被过滤掉。
    byAria(handle.output, "按状态筛选").props.onChange({ target: { value: "completed" } });
    await handle.settle();
    assert.equal(textOf(handle.output).includes("成功分片"), true);
    assert.equal(textOf(handle.output).includes("失败分片"), false);
    assert.equal(textOf(handle.output).includes("运行专家"), false);
    assert.equal(textOf(handle.output).includes("空闲专家"), false);
    byAria(handle.output, "按状态筛选").props.onChange({ target: { value: "" } });
    await handle.settle();

    // 无命中：给出独立空态，绝不伪装成「没有任务」，根节点仍作为路径保留。
    byAria(handle.output, "搜索任务").props.onChange({ target: { value: "不存在的任务" } });
    await handle.settle();
    assert.ok(byClass(handle.output, "deg_expert_group_filter_empty")[0], "零命中必须有过滤空态");
    assert.equal(byClass(handle.output, "deg_expert_group_shard").length, 0);
    assert.ok(byClass(handle.output, "deg_expert_group_node_root")[0]);
    byAria(handle.output, "搜索任务").props.onChange({ target: { value: "" } });
    await handle.settle();

    // 过滤是纯客户端视图：不发新 RPC、不写存储（展开状态才是唯一持久化的 UI 状态）。
    assert.equal(requests.length, requestCountBefore, "过滤不产生任何 RPC");
    assert.equal(requests.some((request) => request.action !== "expert-group-snapshot"), false);
    // 展开状态是唯一持久化的 UI 状态：整轮过滤前后存储条目必须逐条一致（过滤绝不落盘）。
    assert.deepEqual(
      [...storage.values.entries()],
      storageAfterExpand,
      "过滤状态不落盘（展开状态才是唯一持久化的 UI 状态）",
    );
    assert.equal(
      [...storage.values.keys()].some((key) => key.toLowerCase().includes("filter")),
      false,
      "存储里绝不允许出现过滤键",
    );
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 重新挂载（同一 storage）：过滤不持久化，首屏仍是完整任务树。
  const remounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage });
  try {
    await remounted.handle.settle();
    assert.equal(textOf(remounted.handle.output).includes("成功分片"), true);
    assert.equal(byClass(remounted.handle.output, "deg_expert_group_filter_empty").length, 0);
  } finally {
    remounted.handle.unmount();
    remounted.restore();
  }
});

test("工具栏移除诊断与 Markdown/JSON 导出入口，下拉框选项跟随 DSH 主题", async () => {
  const doc = createFakeDocumentEventTarget({ hidden: false });
  const restoreDocument = installGlobals({ document: doc });
  const mounted = mountPanel({ hostSnapshot: timelinePanelSnapshot(), storage: new MemoryStorage() });
  const { handle, requests, intervals, restore } = mounted;
  try {
    await handle.settle();
    const requestCountBefore = requests.length;
    assert.equal(byAria(handle.output, "排队与限流诊断"), null, "工具栏不得再提供诊断入口");
    assert.equal(byAria(handle.output, "导出 Markdown"), null, "工具栏不得再提供 Markdown 导出");
    assert.equal(byAria(handle.output, "导出 JSON"), null, "工具栏不得再提供 JSON 导出");
    assert.equal(walk(handle.output).some((node) => node?.props?.className === "deg_expert_group_export"), false,
      "导出按钮容器必须一并移除");
    assert.ok(byAria(handle.output, "会话模型"), "「会话模型」入口占据原手动派发槽位");
    assert.equal(requests.length, requestCountBefore, "渲染工具条不发 RPC");

    // 下拉框的弹出列表由浏览器按 color-scheme 绘制：样式表必须显式声明深色主题切换
    // 与选项背景/文字令牌，否则深色页面上会出现白底浅字（用户报告的可读性问题）。
    const css = doc.insertedStyles.map((style) => style.textContent).join("\n");
    assert.match(css, /body\[data-ds-dark-theme\] \.deg_expert_group_filter\{color-scheme:dark\}/);
    assert.match(css, /\.deg_expert_group_filter option\{background-color:var\(--dsw-alias-bg-layer-2,Canvas\);color:var\(--dsw-alias-label-primary,CanvasText\)\}/);
    assert.doesNotMatch(css, /deg_expert_group_diagnostics/);
    assert.doesNotMatch(css, /\.deg_expert_group_export\{/);
  } finally {
    handle.unmount();
    restore();
    restoreDocument();
  }
  assert.equal(intervals.active, 0);
});

test("票据 12：旧快照降级——没有 usage/duration/context 时不渲染空摘要行，分片也不渲染 attempt 时间线", async () => {
  // snapshot() 是既有夹具：没有任何 durationMs/usage/contextPressure/failure 字段。
  const mounted = mountPanel({ hostSnapshot: snapshot(), storage: new MemoryStorage() });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 五段全空且没有异常提示时整行不渲染：绝不留下「开始/最近活动/重试 N 次/用量 —」这类占位行。
    assert.equal(byClass(handle.output, "deg_expert_group_metrics").length, 0, "旧快照不得渲染空摘要行");
    for (const banned of ["开始 ", "最近活动", "重试 1 次", "用量 —"]) {
      assert.equal(textOf(handle.output).includes(banned), false, "旧快照不得伪造：" + banned);
    }
    assert.equal(byClass(handle.output, "deg_expert_group_failure").length, 0);
    assert.equal(byClass(handle.output, "deg_expert_group_retry_warning").length, 0);
    // 分片不再展示 attempt 时间线：旧快照下同样为 0，缺失的耗时也不会退化成「—」占位条目。
    assert.equal(byClass(handle.output, "deg_expert_group_attempts").length, 0, "旧快照下同样不渲染分片 attempt 时间线");
    assert.equal(byClass(handle.output, "deg_expert_group_attempt").length, 0);
    assert.equal(handle.cleanupErrors.length, 0);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 没有快照（首屏加载中）时不渲染过滤工具条：没有可过滤的内容。
  const loading = mountPanel({
    requestPluginRpc() { return new Promise(() => {}); },
  });
  try {
    await loading.handle.settle();
    assert.equal(byClass(loading.handle.output, "deg_expert_group_toolbar").length, 0);
  } finally {
    loading.handle.unmount();
    loading.restore();
  }
});
// ── 票据 13：状态可读性（错误来源 / 常驻刷新） ──────────────────────────────────
// 「更新于 HH:MM:SS」文本与 partial 徽标已按用户要求从标题栏移除，对应的两个查询 helper
// （时间格式期望值 / deg_expert_group_updated 节点）随节点一起删除；原本由它们承载的两条契约
// 已改写为 renderCount 可观测断言（手动刷新不被短路吞掉、内容相同的轮询零重渲染）。

/** 标题栏错误槽节点（按类名精确匹配，data-error-source 由用例另行断言）。 */
function headerErrorNode(handle) {
  return byClass(handle.output, "deg_expert_group_error")[0];
}

test("票据 13：快照失败、动作传输失败与动作被拒绝分别显示三类文案与来源标记", async () => {
  // failed 分片 ⇒ 重试动作始终可见，可以把「一次点击 → 一次动作 RPC」隔离在唯一入口上。
  const hostSnapshot = singleShardSnapshot(false);
  const host = { snapshotFails: false, action: "ok" };
  const mounted = mountPanel({
    // 结算态（failed）fan-out 默认收起，需要可写存储让「展开」成为持久的 override。
    storage: new MemoryStorage(),
    requestPluginRpc(_connection, request) {
      if (String(request.action).startsWith("fanout-")) {
        // 传输层失败（adapter reject）与被 Host 结构化拒绝是两类不同的事实：
        // 前者归 rpc，后者归 action。二者都绝不允许显示成「快照读取失败」。
        if (host.action === "reject") return Promise.reject(new Error("动作传输中断"));
        if (host.action === "refused") return { ok: false, error: { code: "task_terminal", message: "宿主拒绝该动作" } };
        return { ok: true, async json() { return { ok: true, accepted: true }; } };
      }
      if (host.snapshotFails === true) throw new Error("快照传输失败");
      return { ok: true, async json() { return { snapshot: hostSnapshot }; } };
    },
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 需求二：结算态 fan-out 默认收起；用例要断言「旧快照不清屏」的分片内容，先展开。
    await expandFanouts(handle);
    assert.equal(headerErrorNode(handle), undefined, "成功首屏不得有错误槽");

    // ① 快照请求失败 → snapshot（即使底层是传输失败，用户看到的事实仍是任务树没读到）。
    host.snapshotFails = true;
    await intervals.tick();
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "快照读取失败");
    assert.equal(headerErrorNode(handle).props["data-error-source"], "snapshot");
    assert.equal(headerErrorNode(handle).props.title, "快照传输失败", "title 仍是受限的原始 message");
    assert.ok(textOf(handle.output).includes("only-shard"), "快照失败时保留最后有效快照");

    // 快照成功后 snapshot 错误被清除（既有语义不变）。
    host.snapshotFails = false;
    await intervals.tick();
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "快照成功必须清除 snapshot 错误");

    // ② 动作内部的传输/协议失败 → rpc（绝不是「快照读取失败」）。
    host.action = "reject";
    await actionByLabel(handle, "重试分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "请求失败");
    assert.equal(headerErrorNode(handle).props["data-error-source"], "rpc");
    assert.equal(headerErrorNode(handle).props.title, "动作传输中断");
    assert.equal(textOf(handle.output).includes("快照读取失败"), false, "动作失败绝不显示「快照读取失败」");

    // ③ 动作被 Host 结构化拒绝 → action。
    host.action = "refused";
    await actionByLabel(handle, "重试分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "操作失败");
    assert.equal(headerErrorNode(handle).props["data-error-source"], "action");
    assert.equal(headerErrorNode(handle).props.title, "宿主拒绝该动作");
    assert.ok(textOf(handle.output).includes("only-shard"), "动作失败时任务树继续可见（旧快照不清屏）");
    assert.equal(textOf(handle.output).includes("快照读取失败"), false);
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 票据 13 的 partial 契约**收窄**后的事实：标题栏的「数据不完整」徽标已按用户要求移除，
 * partial 只由状态圆点表达，不再有可见文字提示。
 *
 * 断言按新契约反转（不是删掉）：partial 快照下徽标节点必须不存在、文案必须不上屏；
 * 圆点契约与「partial 参与上屏内容比较 ⇒ 完整快照到达必须重渲染」照旧成立。
 */
test("票据 13：partial 快照不再渲染「数据不完整」徽标，状态圆点契约不变", async () => {
  const hostState = { snapshot: { ...snapshot(), partial: true } };
  const mounted = mountPanel({
    requestPluginRpc() { return { ok: true, async json() { return { snapshot: hostState.snapshot }; } }; },
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 徽标与文案都必须从渲染树消失：partial 只能靠圆点颜色暗示。
    assert.equal(byClass(handle.output, "deg_expert_group_partial").length, 0, "partial 快照不得再渲染徽标节点");
    assert.equal(textOf(handle.output).includes("数据不完整"), false, "partial 文案必须从界面彻底消失");
    // 既有 aria/状态点契约不变：圆点仍由同一条 partial 规则渲染。
    const partialStatuses = byClass(handle.output, "deg_expert_group_status_icon");
    assert.ok(partialStatuses.length > 0);
    assert.ok(partialStatuses.every((node) => typeof node.props["data-status"] === "string"));

    // 完整快照到达：partial 参与上屏内容比较 ⇒ 必须重新渲染，圆点契约不变。
    const rendersBefore = handle.renderCount;
    hostState.snapshot = snapshot();
    await intervals.tick();
    await handle.settle();
    assert.ok(handle.renderCount > rendersBefore, "partial → 完整必须重渲染（partial 参与上屏内容比较）");
    assert.equal(byClass(handle.output, "deg_expert_group_partial").length, 0, "完整快照到达后依然没有徽标节点");
    const fullStatuses = byClass(handle.output, "deg_expert_group_status_icon");
    assert.ok(fullStatuses.length > 0);
    assert.ok(fullStatuses.every((node) => typeof node.props["data-status"] === "string"));
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/**
 * 标题栏「更新于 HH:MM:SS」按用户要求移除后，本条契约改用**可观测量**表达，强度不降反升：
 *
 * 1. 常驻刷新入口（成功态也在）必须真的发一次快照请求；
 * 2. 手动刷新是用户的显式推进，内容一字未变也必须提交一次状态（renderCount 增加）——
 *    这正是旧断言「手动刷新推进更新时间」证明的同一件事：手动刷新不被内容短路吞掉；
 * 3. 内容完全相同的**自动轮询**依然零重渲染（renderCount 不变）；
 * 4. 真实内容变化必须重渲染并上屏。
 */
test("票据 13：常驻刷新入口不被内容短路吞掉，内容相同的轮询零重渲染", async () => {
  const clock = installFakeClock(1700000000000);
  const hostState = { snapshot: snapshot() };
  const mounted = mountPanel({
    requestPluginRpc() { return { ok: true, async json() { return { snapshot: hostState.snapshot }; } }; },
  });
  const { handle, intervals, restore, requests } = mounted;
  try {
    await handle.settle();

    // 常驻刷新入口：成功态下同样存在（aria-label="刷新"），点击真的发一次快照请求。
    const refreshButton = walk(handle.output).find((node) => node?.props?.["aria-label"] === "刷新");
    assert.ok(refreshButton, "无错误时刷新按钮必须常驻，而不是只在错误时出现");

    // 手动刷新不被「内容相同」短路吞掉：内容一字未变，仍必须提交一次新状态。
    const rendersBeforeManual = handle.renderCount;
    const requestsBeforeRefresh = requests.length;
    clock.advance(1000);
    refreshButton.props.onClick();
    await handle.settle();
    assert.equal(requests.length, requestsBeforeRefresh + 1, "刷新按钮必须真的发起一次快照请求");
    assert.ok(
      handle.renderCount > rendersBeforeManual,
      "手动刷新即使内容完全相同也必须提交一次可见状态（不被短路吞掉）",
    );

    // 自动轮询：内容完全相同 ⇒ 零重渲染（不回归）。
    const rendersBeforePoll = handle.renderCount;
    clock.advance(5000);
    await intervals.tick();
    await handle.settle();
    assert.equal(handle.renderCount, rendersBeforePoll, "内容相同的轮询不得重渲染（不回归）");

    // 内容真的变化：必须上屏并重渲染（根行固定显示「主代理」，因此改专家的任务名）。
    const changed = snapshot();
    changed.root.children[0].taskName = "变化后的专家";
    hostState.snapshot = changed;
    await intervals.tick();
    await handle.settle();
    assert.ok(textOf(handle.output).includes("变化后的专家"), "真实变化必须上屏");
    assert.ok(handle.renderCount > rendersBeforePoll, "真实变化必须重渲染");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 13：失败且无缓存时只显示独立错误空态，绝不再同时显示「暂无 Expert Group 任务」", async () => {
  const mounted = mountPanel({
    requestPluginRpc() { return Promise.reject(new Error("首屏快照读取失败")); },
  });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    const errorEmpty = byClass(handle.output, "deg_expert_group_error_empty")[0];
    assert.ok(errorEmpty, "失败且没有缓存快照时必须渲染独立错误空态");
    assert.equal(errorEmpty.props["data-error-source"], "snapshot");
    assert.equal(errorEmpty.props.role, "alert");
    assert.equal(errorEmpty.props.title, "首屏快照读取失败");
    assert.match(textOf(errorEmpty), /快照读取失败/, "空态标题使用与标题栏同源的短文案");
    assert.match(textOf(errorEmpty), /首屏快照读取失败/, "空态细节行给出受限 message");
    assert.equal(textOf(handle.output).includes("暂无 Expert Group 任务"), false, "错误空态与「暂无任务」不得同时出现");
    assert.equal(byClass(handle.output, "deg_expert_group_empty").length, 1, "正文只有一个空态块");
    assert.equal(byClass(handle.output, "deg_expert_group_skeleton").length, 0, "失败后不再显示骨架占位");
    // 标题栏错误槽与重试入口同时存在，title 放完整 message。
    assert.equal(headerErrorNode(handle).props.title, "首屏快照读取失败");
    assert.ok(walk(handle.output).some((node) => node?.props?.["aria-label"] === "重试"), "无缓存失败必须保留重试入口");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 13：action 错误保留到下一次动作或手动刷新，绝不被成功的轮询清掉", async () => {
  const hostState = { snapshot: singleShardSnapshot(false) };
  const actionState = { mode: "refused" };
  /** 快照请求的挂起器：用来在「轮询在途」与「轮询成功」两个时刻观察错误槽。 */
  const snapshotGates = [];
  const actionGates = [];
  const gateSnapshot = { value: false };
  const mounted = mountPanel({
    // 结算态（failed）fan-out 默认收起，需要可写存储让「展开」成为持久的 override。
    storage: new MemoryStorage(),
    requestPluginRpc(_connection, request) {
      if (String(request.action).startsWith("fanout-")) {
        if (actionState.mode === "pending") return new Promise((resolve) => actionGates.push(resolve));
        if (actionState.mode === "refused") return { ok: false, error: { code: "task_terminal", message: "宿主拒绝该动作" } };
        return { ok: true, async json() { return { ok: true, accepted: true }; } };
      }
      if (gateSnapshot.value === true) return new Promise((resolve) => snapshotGates.push(resolve));
      return { ok: true, async json() { return { snapshot: hostState.snapshot }; } };
    },
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    // 需求二：结算态 fan-out 默认收起；本用例的动作入口是分片行上的重试按钮，先展开。
    await expandFanouts(handle);

    // 动作失败 → action 错误上屏。
    await actionByLabel(handle, "重试分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "操作失败");

    // 轮询开始（请求在途）时：错误必须仍然可见——旧实现会在刷新的开始分支清掉它。
    gateSnapshot.value = true;
    const polling = intervals.tick();
    await handle.settle();
    assert.equal(snapshotGates.length, 1, "轮询必须发出一次快照请求");
    assert.equal(textOf(headerErrorNode(handle)), "操作失败", "轮询开始绝不清掉 action 错误");

    // 轮询成功（内容完全一致）：action 错误仍保留（快照成功只清 snapshot/rpc 错误）。
    snapshotGates[0]({ ok: true, async json() { return { snapshot: hostState.snapshot }; } });
    await polling;
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "操作失败", "成功的轮询绝不清掉 action 错误");
    gateSnapshot.value = false;

    // 下一次动作开始即清除上一条 action 错误（动作在途时就能看到它退场）。
    actionState.mode = "pending";
    const nextAction = actionByLabel(handle, "重试分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "新动作开始必须清掉上一条 action 错误");
    assert.equal(actionGates.length, 1);
    actionGates[0]({ ok: true, async json() { return { ok: true, accepted: true }; } });
    await nextAction;
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "动作成功且尾随刷新成功后仍无错误");

    // 手动刷新（标题栏的重试按钮）同样清除 action 错误。
    actionState.mode = "refused";
    await actionByLabel(handle, "重试分片 only-shard").props.onClick();
    await handle.settle();
    assert.equal(textOf(headerErrorNode(handle)), "操作失败");
    const manualRetry = walk(handle.output).find((node) => node?.props?.["aria-label"] === "重试");
    assert.ok(manualRetry, "错误时标题栏保留重试语义");
    const requestsBeforeManual = mounted.requests.length;
    manualRetry.props.onClick();
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "手动刷新必须清掉 action 错误");
    assert.ok(mounted.requests.length > requestsBeforeManual, "手动刷新必须真的发起快照请求");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 13：快照请求以 AbortError 形态失败时仍按取消处理，绝不落错误槽", async () => {
  // 宿主自带的取消错误是 DOMException（不是 Error 实例）：分类标记必须原样保留它的 name，
  // 否则「取消」会被当成真实失败，旧代次/过期响应的静默收口语义随之回归。
  const abortError = typeof globalThis.DOMException === "function"
    ? new globalThis.DOMException("内部已取消", "AbortError")
    : Object.assign(new Error("内部已取消"), { name: "AbortError" });
  const mounted = mountPanel({
    requestPluginRpc() { return Promise.reject(abortError); },
  });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "AbortError 不写标题错误槽");
    assert.equal(byClass(handle.output, "deg_expert_group_error_empty").length, 0, "AbortError 不渲染错误空态");
    assert.equal(textOf(handle.output).includes("快照读取失败"), false);
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 13：切换到新 root 后，旧 root 的迟到失败既不写错误也不顶掉新 root 的首屏", async () => {
  const clock = installFakeClock(1700000000000);
  const pending = [];
  const mounted = mountPanel({
    requestPluginRpc(_connection, request) {
      return new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
    },
  });
  const { handle, sessions, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].request.sessionId, "root-1");

    // 切到 root-2：旧请求被取消，新请求在途。
    const nextSessions = sessionsSnapshot();
    nextSessions.current = "root-2";
    nextSessions.byId["root-2"] = { id: "root-2", title: "新根任务标题", displayTitle: "root-2" };
    sessions.update(nextSessions);
    handle.rerender({ scope: { sessionId: "root-2" } });
    assert.equal(pending.length, 2);
    assert.equal(pending[1].request.sessionId, "root-2");
    // 「更新于」节点已按用户要求移除，等价断言落到**首屏内容**上：新 root 的响应还没回来时，
    // 面板必须保持空态骨架（loading + snapshot=null），绝不把旧 root 的任何内容留在屏上。
    assert.ok(byClass(handle.output, "deg_expert_group_skeleton").length > 0, "新 root 等待首屏时必须显示骨架空态");
    assert.equal(byClass(handle.output, "deg_expert_group_node_root").length, 0, "新 root 等待首屏时不得显示旧 root 的任务树");

    // 旧 root 的响应迟到失败：绝不把错误写进新会话，也绝不顶掉新 root 的空态。
    pending[0].reject(new Error("旧会话请求失败"));
    await handle.settle();
    assert.equal(headerErrorNode(handle), undefined, "旧请求失败不得污染新会话的错误槽");
    assert.equal(textOf(handle.output).includes("快照读取失败"), false);
    assert.ok(byClass(handle.output, "deg_expert_group_skeleton").length > 0, "旧 root 的迟到失败不得提前结束新 root 的加载态");
    assert.equal(byClass(handle.output, "deg_expert_group_node_root").length, 0, "旧 root 的迟到失败不得把旧任务树顶上屏");

    // 新 root 成功：上屏内容属于新会话。
    clock.advance(3000);
    const next = snapshot();
    next.rootSessionId = "root-2";
    next.root = { ...next.root, id: "root-2", sessionId: "root-2", taskName: "新根任务标题" };
    // 根任务名不再上屏：用新快照独有的任务树内容证明「新 root 的快照已上屏」。
    next.root.children = [{
      id: "expert-new-root", kind: "expert", sessionId: "expert-new-root", taskName: "新根会话专家",
      role: "fixer", status: "ready",
    }];
    pending[1].resolve({ ok: true, async json() { return { snapshot: next }; } });
    await handle.settle();
    assert.ok(textOf(handle.output).includes("新根会话专家"), "新会话响应必须正常上屏");
    assert.equal(headerErrorNode(handle), undefined);
    assert.equal(byClass(handle.output, "deg_expert_group_skeleton").length, 0, "新 root 上屏后骨架空态必须消失");
    assert.equal(byClass(handle.output, "deg_expert_group_node_root").length, 1, "新 root 的任务树必须上屏");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * 票据 15 / 16：游标增量同步与自适应轮询。
 *
 * 这些用例只通过公开注入面驱动：假 setInterval/clearInterval（显式 tick）、假 document（显式
 * visibilitychange）、注入的 isTabActive 与可编程的 Host 替身。全部断言都是确定性的计数/文案，
 * 不依赖真实等待，也不依赖真实时钟。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 票据 15：可编程的 Host 替身（fanout-events 与 expert-group-snapshot 分开计数）。
 *
 * 语义与 Host 的 fanout-events 一致：返回「游标之后的事件」，并用 nextSequence 回传新游标
 * （队列读走即清空，等价于 Host 的序号推进）；两个读面都能单独失败，用来验证
 * 「事件读面不可用 ⇒ 降级全量」「快照失败 ⇒ 游标不推进」等边界。
 */
function incrementalHostPanel(options = {}) {
  const state = {
    snapshot: options.snapshot ?? snapshot(),
    events: [],
    cursor: 0,
    cursorOverride: null,
    earliestSequence: 1,
    gap: false,
    omitGap: false,
    failEvents: false,
    failSnapshot: false,
    eventsCalls: [],
    snapshotCalls: [],
  };
  const mounted = mountPanel({
    ...(options.mount ?? {}),
    async requestPluginRpc(_connection, request) {
      if (request?.action === "fanout-events") {
        state.eventsCalls.push(request);
        if (state.failEvents === true) throw new Error("事件读面不可用");
        const events = state.events.splice(0, state.events.length);
        const computed = events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), state.cursor);
        const nextCursor = Number.isSafeInteger(state.cursorOverride) ? state.cursorOverride : computed;
        state.cursor = nextCursor;
        const body = {
          ok: true,
          events,
          cursor: nextCursor,
          earliestSequence: state.earliestSequence,
          ...(state.omitGap === true ? {} : { gap: state.gap }),
          dropped: 0,
        };
        return { ok: true, async json() { return body; } };
      }
      if (request?.action === "expert-group-snapshot") {
        state.snapshotCalls.push(request);
        if (state.failSnapshot === true) throw new Error("快照读取失败");
        const body = state.snapshot;
        return { ok: true, async json() { return { snapshot: body }; } };
      }
      // 其它动作（取消/重试等）一律接受：用例只关心它随后的尾随全量刷新。
      return { ok: true, async json() { return { ok: true, accepted: true }; } };
    },
  });
  return { ...mounted, state };
}

/** 空闲快照：没有任何运行中的任务（空闲退避的输入）。 */
function idleSnapshot() {
  return {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "空闲根任务",
      status: "ready", children: [],
    },
  };
}

test("票据 15：自动轮询先读事件；空闲无事件不请求快照，运行态仍请求快照", async () => {
  // ① 空闲快照：锁定「空闲零请求」的既有契约（无事件 ⇒ 不拉快照、不重渲染）。
  const idleHost = incrementalHostPanel({ snapshot: idleSnapshot() });
  try {
    await idleHost.handle.settle();
    assert.equal(idleHost.state.snapshotCalls.length, 1, "挂载时一次首屏快照");
    const renders = idleHost.handle.renderCount;
    assert.deepEqual(idleHost.intervals.delays, [2500], "轮询初始间隔是 2.5 秒（时间参数集中定义）");

    for (let round = 0; round < 3; round += 1) {
      await idleHost.intervals.tick();
      await idleHost.handle.settle();
    }
    assert.deepEqual(
      idleHost.state.eventsCalls.map((call) => [call.sessionId, call.after]),
      [["root-1", 0], ["root-1", 0], ["root-1", 0]],
      "每轮都先读事件；Host 没给新游标时继续用当前游标（绝不伪造进度）",
    );
    assert.equal(idleHost.state.snapshotCalls.length, 1, "空闲且无事件 ⇒ 绝不请求快照（空闲零请求契约）");
    assert.equal(idleHost.handle.renderCount, renders, "空闲且无事件 ⇒ 零重渲染");
  } finally {
    idleHost.handle.unmount();
    idleHost.restore();
  }
  assert.equal(idleHost.intervals.active, 0);

  // ② 运行态快照：turn/start 不产生 fanout 事件，但「用时」必须实时推进 ⇒ 无事件也要刷新快照。
  const runningHost = incrementalHostPanel();
  try {
    await runningHost.handle.settle();
    assert.equal(runningHost.state.snapshotCalls.length, 1, "挂载时一次首屏快照");
    const renders = runningHost.handle.renderCount;
    for (let round = 0; round < 3; round += 1) {
      await runningHost.intervals.tick();
      await runningHost.handle.settle();
    }
    assert.equal(runningHost.state.snapshotCalls.length, 4, "运行态每轮无事件也必须刷新快照");
    assert.deepEqual(
      runningHost.state.eventsCalls.map((call) => call.after),
      [0, 0, 0],
      "刷新快照前仍然先读事件（顺序不变）",
    );
    // 内容相同时不重渲染：实时性由「新快照 → 新 generatedAt」驱动，而不是每轮强制刷新 DOM。
    assert.equal(runningHost.handle.renderCount, renders, "内容相同的运行态刷新不产生重渲染");
  } finally {
    runningHost.handle.unmount();
    runningHost.restore();
  }
  assert.equal(runningHost.intervals.active, 0);
});

test("票据 15：有事件时恰好补拉一次快照，并推进到 Host 返回的游标", async () => {
  const host = incrementalHostPanel();
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    const changed = snapshot();
    changed.root.children[0] = { ...changed.root.children[0], taskName: "事件到达后的新任务名" };
    state.snapshot = changed;
    state.events.push({ sequence: 1, type: "task_settled", parentTaskId: "fan-1" });

    await intervals.tick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 2, "有事件 ⇒ 恰好一次快照");
    assert.ok(textOf(handle.output).includes("事件到达后的新任务名"), "新内容必须上屏");

    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.at(-1).after, 1, "游标推进到 Host 的 nextSequence");
    // 行为契约变更（用户要求「用时实时跳动」）：运行态即使没有新事件也要刷新快照，
    // 让 turnDurationMs/turnOpenSince 跟上。内容相同 ⇒ 不重渲染（见下一条断言）。
    const runningRenders = handle.renderCount;
    assert.equal(state.snapshotCalls.length, 3, "事件已消费，但运行态仍刷新快照");
    assert.equal(handle.renderCount, runningRenders, "运行态内容相同 ⇒ 不重渲染");

    // 切回空闲：恢复「无事件不请求快照」的既有契约。
    state.snapshot = idleSnapshot();
    await intervals.tick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 4, "回到空闲的那一轮仍要拉一次快照（确认没有运行中工作）");
    await intervals.tick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 4, "空闲后恢复零快照请求");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 15：gap 或游标过旧时执行一次全量同步，并以响应 cursor 重建游标", async () => {
  const host = incrementalHostPanel();
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    // Host 的事件日志已裁剪到 5 之后：游标 0 读不到 1..4（gap=true），nextSequence=9。
    state.earliestSequence = 5;
    state.gap = true;
    state.cursorOverride = 9;
    const changed = snapshot();
    changed.root.children[0] = { ...changed.root.children[0], taskName: "缺口恢复后的全量" };
    state.snapshot = changed;

    await intervals.tick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 2, "gap ⇒ 恰好一次全量快照");
    assert.ok(textOf(handle.output).includes("缺口恢复后的全量"), "全量恢复必须上屏");

    state.gap = false;
    state.cursorOverride = null;
    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.at(-1).after, 9, "游标按响应 cursor 重建");
    // 游标已重建，但快照仍是运行态 ⇒ 新契约要求继续刷新（内容相同不重渲染）。
    assert.equal(state.snapshotCalls.length, 3, "运行态无事件仍刷新快照（游标本身仍按 9 读取）");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 旧 Host 不返回 gap 字段：客户端必须用 Host 的同一公式（earliest > 1 且 after < earliest）
  // 自行判定缺口，否则「读不到」就会被当成「没有变化」。
  const legacy = incrementalHostPanel();
  try {
    await legacy.handle.settle();
    legacy.state.earliestSequence = 5;
    legacy.state.omitGap = true;
    legacy.state.cursorOverride = 7;
    await legacy.intervals.tick();
    await legacy.handle.settle();
    assert.equal(legacy.state.snapshotCalls.length, 2, "缺 gap 字段同样必须全量恢复");
    legacy.state.omitGap = false;
    legacy.state.cursorOverride = null;
    await legacy.intervals.tick();
    await legacy.handle.settle();
    assert.equal(legacy.state.eventsCalls.at(-1).after, 7, "旧 Host 路径同样重建游标");
  } finally {
    legacy.handle.unmount();
    legacy.restore();
  }

  // gap 恢复失败：旧数据必须保持上屏、错误可见，且游标绝不推进（否则这段事件会被当成
  // 「已处理」，界面就永久停在旧数据上）。下一轮因为上一轮快照失败而直接重试全量。
  const failing = incrementalHostPanel();
  try {
    await failing.handle.settle();
    failing.state.earliestSequence = 5;
    failing.state.gap = true;
    failing.state.cursorOverride = 9;
    failing.state.failSnapshot = true;
    await failing.intervals.tick();
    await failing.handle.settle();
    assert.equal(failing.state.snapshotCalls.length, 2, "gap ⇒ 一次全量尝试");
    assert.ok(textOf(failing.handle.output).includes("运行专家"), "失败时旧数据必须保留（不清屏）");
    assert.ok(headerErrorNode(failing.handle), "gap 恢复失败必须可见");

    failing.state.failSnapshot = false;
    failing.state.gap = false;
    await failing.intervals.tick();
    await failing.handle.settle();
    assert.equal(failing.state.snapshotCalls.length, 3, "失败后的下一轮必须直接重试全量（不依赖事件）");
    assert.equal(failing.state.eventsCalls.length, 1, "失败恢复期间不再探测事件（游标没有推进）");
    assert.equal(headerErrorNode(failing.handle), undefined, "重试成功后错误面清除");
  } finally {
    failing.handle.unmount();
    failing.restore();
  }
});

test("票据 15：revision 相同 ⇒ 保留旧快照、零重渲染；手动刷新不被短路吞掉", async () => {
  const clock = installFakeClock(1700000000000);
  const first = snapshot();
  first.revision = "rev-1";
  const host = incrementalHostPanel({ snapshot: first });
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    const renders = handle.renderCount;

    // 事件到达，但 Host 的快照内容与 revision 都没变（只有 generatedAt 不同）：
    // 快照确实被拉了一次，但 revision 短路 ⇒ 保留旧对象、零重渲染。
    clock.advance(4000);
    state.events.push({ sequence: 1, type: "turn/end", parentTaskId: "fan-1" });
    state.snapshot = { ...first, generatedAt: 99 };
    await intervals.tick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 2, "有事件仍然要拉一次快照");
    assert.equal(handle.renderCount, renders, "revision 相同不得重渲染");

    // 内容真的变化 ⇒ revision 变化 ⇒ 正常上屏并重渲染。
    const changed = snapshot();
    changed.revision = "rev-2";
    changed.root.children[0] = { ...changed.root.children[0], taskName: "revision 变化后的内容" };
    state.snapshot = changed;
    state.events.push({ sequence: 2, type: "turn/end", parentTaskId: "fan-1" });
    await intervals.tick();
    await handle.settle();
    assert.ok(textOf(handle.output).includes("revision 变化后的内容"), "revision 变化必须上屏");
    const rendersAfterChange = handle.renderCount;
    assert.ok(rendersAfterChange > renders, "revision 变化必须重渲染");

    // 手动刷新：revision 相同也必须提交一次状态（票据 13 的可见反馈不能被短路吞掉）。
    // 标题栏「更新于」节点已按用户要求移除，因此用 renderCount 观测同一条契约。
    const snapshotCallsBeforeManual = state.snapshotCalls.length;
    clock.advance(2000);
    walk(handle.output).find((node) => node?.props?.["aria-label"] === "刷新").props.onClick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, snapshotCallsBeforeManual + 1, "手动刷新必须真的再拉一次快照");
    assert.ok(handle.renderCount > rendersAfterChange, "手动刷新即使 revision 相同也必须提交一次可见状态");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 15：切换 root / 手动刷新 / sessions 通知 / 动作完成都走全量快照", async () => {
  const host = incrementalHostPanel();
  const { handle, intervals, restore, state, sessions } = host;
  try {
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 1, "挂载首屏一次快照");

    // 1) 手动刷新：只发快照，不先探测事件。
    const eventsBeforeManual = state.eventsCalls.length;
    walk(handle.output).find((node) => node?.props?.["aria-label"] === "刷新").props.onClick();
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 2, "手动刷新必须拉全量快照");
    assert.equal(state.eventsCalls.length, eventsBeforeManual, "强制全量路径不先探测事件");

    // 2) sessions 通知：渲染输入变化必须重拉全量并上屏。
    sessions.update(sessionsSnapshot());
    await handle.settle();
    assert.equal(state.snapshotCalls.length, 3, "sessions 订阅通知必须拉全量快照");

    // 3) 切换 root：立即拉目标 root 的全量快照，游标重置（不沿用旧 root 的进度）。
    handle.rerender({ scope: { sessionId: "root-2" } });
    await handle.settle();
    assert.equal(state.snapshotCalls.at(-1).sessionId, "root-2", "切换 root 必须拉目标 root 的快照");
    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.at(-1).sessionId, "root-2");
    assert.equal(state.eventsCalls.at(-1).after, 0, "切换 root 后游标从头开始（绝不沿用旧 root 的进度）");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 4) 动作完成：动作的尾随刷新同样是全量快照（不经过事件探测）。
  // 结算态（failed）fan-out 默认收起，重试按钮在分片行上：给一条可写存储并先展开。
  const actionHost = incrementalHostPanel({ snapshot: singleShardSnapshot(false), mount: { storage: new MemoryStorage() } });
  try {
    await actionHost.handle.settle();
    await expandFanouts(actionHost.handle);
    const snapshotsBeforeAction = actionHost.state.snapshotCalls.length;
    const eventsBeforeAction = actionHost.state.eventsCalls.length;
    await actionByLabel(actionHost.handle, "重试分片 only-shard").props.onClick();
    await actionHost.handle.settle();
    assert.equal(actionHost.state.snapshotCalls.length, snapshotsBeforeAction + 1, "动作完成后必须全量刷新");
    assert.equal(actionHost.state.eventsCalls.length, eventsBeforeAction, "动作尾随刷新不经过事件探测；");
  } finally {
    actionHost.handle.unmount();
    actionHost.restore();
  }
});

/* ── 票据 16：轮询自适应 ── */

test("票据 16：运行态 2.5 秒，空闲态逐档退避到 30 秒，任务重新运行后立刻回到 2.5 秒", async () => {
  const host = incrementalHostPanel({ snapshot: idleSnapshot() });
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    assert.deepEqual(intervals.delays, [2500], "首个间隔与运行态同源（2.5 秒）");

    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [5000], "第一次空闲后退到 5 秒");

    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [10000], "第二次空闲退到 10 秒");

    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [20000], "第三次空闲退到 20 秒");

    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [30000], "第四次空闲退到 30 秒（封顶）");

    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [30000], "空闲上限保持 30 秒，不再增长");

    // 任务重新运行：一次事件 + 运行中的快照 ⇒ 立刻回到 2.5 秒。
    state.events.push({ sequence: 1, type: "turn/start", parentTaskId: "fan-1" });
    state.snapshot = snapshot();
    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [2500], "运行中的任务必须回到 2.5 秒");
    assert.equal(state.eventsCalls.length, 6, "退避只改变间隔，不减少轮询次数");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 16：连续失败按 1/2/4/8 秒递进并封顶 30 秒，成功后复位", async () => {
  const host = incrementalHostPanel();
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    state.failEvents = true;
    state.failSnapshot = true;

    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (let index = 0; index < expected.length; index += 1) {
      await intervals.tick();
      await handle.settle();
      assert.deepEqual(intervals.delays, [expected[index]], "第 " + (index + 1) + " 次失败后的退避必须是 " + expected[index] + "ms");
    }
    assert.ok(headerErrorNode(handle), "连续失败必须留下可见的快照错误提示");
    assert.ok(textOf(handle.output).includes("运行专家"), "失败不得丢弃最后一份有效快照");

    // 恢复：下一次轮询成功 ⇒ 失败计数清零，回到运行态节奏。
    state.failEvents = false;
    state.failSnapshot = false;
    await intervals.tick();
    await handle.settle();
    assert.deepEqual(intervals.delays, [2500], "成功后必须复位（失败计数清零）");
    assert.equal(headerErrorNode(handle), undefined, "成功后错误面清除");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 16：页面隐藏时暂停调度，重新可见立即刷新并恢复排表", async () => {
  const doc = createFakeDocumentEventTarget({ hidden: false });
  const restoreDocument = installGlobals({ document: doc });
  const host = incrementalHostPanel();
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    assert.equal(intervals.active, 1, "可见页面照常排表");
    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.length, 1, "挂载不探测事件，第一次 tick 才读事件");

    // 隐藏：立刻停表（不等下一次 tick），且 tick 不再产生任何请求。
    doc.setHidden(true);
    assert.equal(intervals.active, 0, "隐藏时必须停掉轮询定时器");
    const eventsWhileHidden = state.eventsCalls.length;
    const snapshotsWhileHidden = state.snapshotCalls.length;
    await intervals.tick();
    assert.equal(state.eventsCalls.length, eventsWhileHidden, "隐藏期间不得读事件");
    assert.equal(state.snapshotCalls.length, snapshotsWhileHidden, "隐藏期间不得请求快照");

    // 重新可见：立即刷新一次并恢复排表。
    doc.setHidden(false);
    await handle.settle();
    assert.equal(state.snapshotCalls.length, snapshotsWhileHidden + 1, "重新可见必须立即刷新一次");
    assert.equal(intervals.active, 1, "重新可见必须恢复排表");
    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.length, eventsWhileHidden + 1, "恢复后的轮询继续读事件");
  } finally {
    handle.unmount();
    restore();
    restoreDocument();
  }
  assert.equal(intervals.active, 0);
});

test("票据 16：所在 tab 非活跃时暂停轮询，注入的活跃读面重新激活时立即刷新", async () => {
  const activity = { active: true };
  const host = incrementalHostPanel({ mount: { isTabActive: () => activity.active } });
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    assert.equal(intervals.active, 1, "活跃 tab 照常排表");
    await intervals.tick();
    await handle.settle();
    const eventsBeforeInactive = state.eventsCalls.length;

    activity.active = false;
    handle.rerender({});
    assert.equal(intervals.active, 0, "非活跃 tab 必须暂停轮询");
    await intervals.tick();
    await handle.settle();
    assert.equal(state.eventsCalls.length, eventsBeforeInactive, "非活跃期间不得读事件");

    const snapshotsBeforeActive = state.snapshotCalls.length;
    activity.active = true;
    handle.rerender({});
    await handle.settle();
    assert.equal(state.snapshotCalls.length, snapshotsBeforeActive + 1, "重新激活必须立即刷新一次");
    assert.equal(intervals.active, 1, "重新激活必须恢复排表");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("票据 16：空闲轮询零重渲染，卸载后定时器与请求全部停止", async () => {
  const host = incrementalHostPanel({ snapshot: idleSnapshot() });
  const { handle, intervals, restore, state } = host;
  try {
    await handle.settle();
    const renders = handle.renderCount;
    const snapshotsAfterMount = state.snapshotCalls.length;
    assert.equal(snapshotsAfterMount, 1, "挂载首屏一次快照");

    for (let round = 0; round < 6; round += 1) {
      await intervals.tick();
      await handle.settle();
    }
    assert.equal(state.eventsCalls.length, 6, "空闲轮询仍在按退避节奏读事件");
    assert.equal(state.snapshotCalls.length, snapshotsAfterMount, "空闲轮询绝不重传整棵树");
    assert.equal(handle.renderCount, renders, "空闲轮询零重渲染");

    handle.unmount();
    assert.equal(intervals.active, 0, "卸载必须清理轮询定时器");
    const eventsAfterUnmount = state.eventsCalls.length;
    const snapshotsAfterUnmount = state.snapshotCalls.length;
    await intervals.tick();
    assert.equal(state.eventsCalls.length, eventsAfterUnmount, "卸载后不得再发起事件探测");
    assert.equal(state.snapshotCalls.length, snapshotsAfterUnmount, "卸载后不得再发起快照请求");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 15：增量轮询保持单飞 + 一次尾随，事件读面失败时降级全量且不落错误面", async () => {
  const eventsCalls = [];
  const snapshotCalls = [];
  const gates = [];
  const mounted = mountPanel({
    requestPluginRpc(_connection, request) {
      if (request?.action === "fanout-events") {
        eventsCalls.push(request);
        if (eventsCalls.length === 1) return new Promise((resolve) => gates.push(resolve));
        return { ok: true, async json() { return { ok: true, events: [], cursor: 3, gap: false, earliestSequence: 1, dropped: 0 }; } };
      }
      snapshotCalls.push(request);
      // 本用例只锁定「单飞 + 一次尾随」：用空闲快照避免运行态刷新干扰计数（该行为由上方用例覆盖）。
      return { ok: true, async json() { return { snapshot: idleSnapshot() }; } };
    },
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();

    // 第一轮事件探测挂起；第二轮 tick 只记一次尾随，绝不再发一次探测。
    await intervals.tick();
    await intervals.tick();
    await handle.settle();
    assert.equal(eventsCalls.length, 1, "在途期间只保留一次事件探测（单飞）");
    assert.equal(snapshotCalls.length, 1, "事件还没结论时不得请求快照");

    gates[0]({ ok: true, async json() { return { ok: true, events: [], cursor: 3, gap: false, earliestSequence: 1, dropped: 0 }; } });
    await handle.settle();
    await handle.settle();
    assert.equal(eventsCalls.length, 2, "结算后恰好补跑一轮尾随");
    assert.equal(eventsCalls.at(-1).after, 3, "尾随轮使用上一轮返回的新游标");
    assert.equal(snapshotCalls.length, 1, "无事件 ⇒ 尾随轮同样不请求快照");
    assert.equal(headerErrorNode(handle), undefined, "事件探测本身不产生错误面");

    // 事件读面失败：降级为既有全量语义（快照照发），且不写错误横幅。
    const faulty = mountPanel({
      requestPluginRpc(_connection, request) {
        if (request?.action === "fanout-events") throw new Error("事件读面不可用");
        return { ok: true, async json() { return { snapshot: snapshot() }; } };
      },
    });
    try {
      await faulty.handle.settle();
      const before = faulty.requests.filter((request) => request.action === "expert-group-snapshot").length;
      await faulty.intervals.tick();
      await faulty.handle.settle();
      const after = faulty.requests.filter((request) => request.action === "expert-group-snapshot").length;
      assert.equal(after, before + 1, "事件读面不可用时降级为全量快照（绝不把读不到当成没有变化）");
      assert.equal(headerErrorNode(faulty.handle), undefined, "事件读面失败不得占用快照错误槽");
    } finally {
      faulty.handle.unmount();
      faulty.restore();
    }
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

/*
 * ================== 票据 18：侧栏可访问性与宽度 ==================
 */

/** aria-live 播报区文本（区域常驻；空串表示还没有需要播报的事件）。 */
function liveAnnouncement(handle) {
  const node = byClass(handle.output, "deg_expert_group_announcer")[0];
  return node === undefined ? null : textOf(node);
}

test("票据 18：aria-live 播报开始/完成/失败/取消，轮询去重且初次挂载不播历史", async () => {
  // 可变快照：每次轮询返回 state.value，用例按需改写它来驱动状态迁移。
  const state = { value: snapshot() };
  const mounted = mountPanel({
    storage: new MemoryStorage(),
    requestPluginRpc: async () => ({ ok: true, async json() { return { snapshot: state.value }; } }),
  });
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const live = byClass(handle.output, "deg_expert_group_announcer")[0];
    assert.ok(live, "aria-live 区域必须常驻");
    assert.equal(live.props.role, "status");
    assert.equal(live.props["aria-live"], "polite");
    assert.equal(live.props["aria-atomic"], "true");
    assert.equal(liveAnnouncement(handle), "", "初次挂载绝不播报历史任务");

    // 同一快照的轮询：没有任何迁移 ⇒ 不播报（避免每 2.5 秒重复读同一句话）。
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "", "相同快照的轮询不得重复播报");

    // running → ready：完成。
    const completed = JSON.parse(JSON.stringify(state.value));
    completed.root.children[0].status = "ready";
    state.value = completed;
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "任务完成：运行专家");

    // 再次轮询同一内容：不重复播报。
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "任务完成：运行专家", "同内容轮询不得重复播报");

    // ready → running → failed：先开始后失败（失败的播报优先于「完成」）。
    const rerun = JSON.parse(JSON.stringify(state.value));
    rerun.root.children[0].status = "running";
    state.value = rerun;
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "任务开始：运行专家");

    const failed = JSON.parse(JSON.stringify(state.value));
    failed.root.children[0].status = "failed";
    state.value = failed;
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "任务失败：运行专家");

    // 分片 running → cancelled：取消。
    const cancelled = JSON.parse(JSON.stringify(state.value));
    cancelled.root.children[2].shards[0].status = "cancelled";
    state.value = cancelled;
    await intervals.tick();
    await handle.settle();
    assert.equal(liveAnnouncement(handle), "任务取消：running-shard");

    // 新出现的运行中任务：开始。同时出现的多个迁移合并成一句，绝不逐个刷屏。
    const added = JSON.parse(JSON.stringify(state.value));
    added.root.children.push({
      id: "new-expert", kind: "expert", sessionId: "new-expert", taskName: "新专家",
      role: "explorer", content: "新任务", status: "running", continuable: true,
    });
    added.root.children[0].status = "running";
    state.value = added;
    await intervals.tick();
    await handle.settle();
    const announcement = liveAnnouncement(handle);
    assert.ok(announcement.includes("任务开始：新专家"), announcement);
    assert.ok(announcement.includes("任务开始：运行专家"), announcement);
    assert.ok(announcement.includes("；"), "同一次响应里的多个事件必须合并成一句");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 18：任务树具备 tree/treeitem 语义与过滤后的层级位置", async () => {
  const mounted = mountPanel({ storage: new MemoryStorage() });
  const { handle, restore } = mounted;
  const rowWith = (needle) => byClass(handle.output, "deg_expert_group_row")
    .find((row) => textOf(row).includes(needle)) ?? null;
  try {
    await handle.settle();
    const tree = byClass(handle.output, "deg_expert_group_tree_items")[0];
    assert.ok(tree, "树容器必须渲染");
    assert.equal(tree.props.role, "tree");
    assert.equal(tree.props["aria-label"], "专家任务树");

    // 根 = 第 1 层；子代理与 fan-out 头部 = 第 2 层；分片 = 第 3 层。
    const rootRow = rowWith("主代理");
    assert.equal(rootRow.props.role, "treeitem");
    assert.equal(rootRow.props["aria-level"], 1);
    assert.equal(rootRow.props["aria-posinset"], 1);
    assert.equal(rootRow.props["aria-setsize"], 1);
    assert.equal(rootRow.props["aria-expanded"], true);

    // 根下可见兄弟：运行中的专家 + fan-out 父任务 + 空闲分组（空闲专家被收进分组）。
    const runningRow = rowWith("运行专家");
    assert.equal(runningRow.props.role, "treeitem");
    assert.equal(runningRow.props["aria-level"], 2);
    assert.equal(runningRow.props["aria-posinset"], 1);
    assert.equal(runningRow.props["aria-setsize"], 3);

    const fanoutHeader = byClass(handle.output, "deg_expert_group_fanout_header")[0];
    assert.equal(fanoutHeader.props.role, "treeitem");
    assert.equal(fanoutHeader.props["aria-level"], 2);
    assert.equal(fanoutHeader.props["aria-posinset"], 2);
    assert.equal(fanoutHeader.props["aria-setsize"], 3);
    assert.equal(fanoutHeader.props["aria-expanded"], true);

    const idleHeader = byClass(handle.output, "deg_expert_group_row").find((row) => row.props.className.includes("deg_expert_group_idle_header"));
    assert.ok(idleHeader, "空闲分组标题行必须渲染");
    assert.equal(idleHeader.props.role, "treeitem");
    assert.equal(idleHeader.props["aria-level"], 2);
    assert.equal(idleHeader.props["aria-posinset"], 3);
    assert.equal(idleHeader.props["aria-setsize"], 3);

    const shardRows = byClass(handle.output, "deg_expert_group_shard");
    assert.equal(shardRows.length, 3);
    shardRows.forEach((row, index) => {
      assert.equal(row.props.role, "treeitem");
      assert.equal(row.props["aria-level"], 3);
      assert.equal(row.props["aria-posinset"], index + 1);
      assert.equal(row.props["aria-setsize"], 3, "分片位置只在父任务内计数");
    });

    // 子容器是 group（不是 treeitem）：层级由 aria-level 明确表达。
    assert.equal(byClass(handle.output, "deg_expert_group_children")[0].props.role, "group");
    assert.equal(byClass(handle.output, "deg_expert_group_fanout_shards")[0].props.role, "group");

    // 过滤后：位置/总数必须与**可见集合**一致（空闲分组整体隐藏时不再占位）。
    const search = byClass(handle.output, "deg_expert_group_search")[0];
    search.props.onChange({ target: { value: "运行专家" } });
    await handle.settle();
    const filtered = rowWith("运行专家");
    assert.equal(filtered.props["aria-posinset"], 1);
    assert.equal(filtered.props["aria-setsize"], 1, "过滤后只有 1 个可见兄弟");
    assert.equal(byClass(handle.output, "deg_expert_group_fanout_header").length, 0, "未命中的 fan-out 整支隐藏");
    assert.equal(byClass(handle.output, "deg_expert_group_shard").length, 0, "未命中的分片不再参与位置计算");
    assert.equal(byClass(handle.output, "deg_expert_group_idle_header").length, 0, "没有命中的空闲分组整组隐藏");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 18：可导航行有明确 focus-visible 轮廓；fan-out 标题可聚焦并能键盘跳转", async () => {
  // 1) focus-visible：任务名（唯一的可导航文本行）必须有显式 outline，而不是依赖浏览器默认。
  assert.match(
    sidebarSource,
    /\.deg_expert_group_task:focus-visible,[^{]*\{outline:2px solid/,
    "可导航行必须显式声明 focus-visible 轮廓",
  );
  assert.match(
    sidebarSource,
    /\.deg_expert_group_task:focus-visible[^{]*\{outline:2px solid var\(--dsw-alias-interactive-border-focus/,
  );

  // 2) fan-out 标题：可聚焦 + Enter/Space 跳转，且不嵌入 button。
  const fanoutSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-1",
    generatedAt: 1,
    root: {
      id: "root-1", kind: "root", sessionId: "root-1", taskName: "根任务标题", status: "running",
      children: [{
        id: "fan-1", kind: "fanout", parentTaskId: "fan-1", sessionId: "fanout-session",
        role: "fixer", status: "running",
        shards: [{ shardId: "shard-a", prompt: "分片提示", role: "fixer", status: "running", childId: "running-child" }],
      }],
    },
  };
  const mounted = mountPanel({ hostSnapshot: fanoutSnapshot });
  const { handle, opened, restore } = mounted;
  try {
    await handle.settle();
    const title = byClass(handle.output, "deg_expert_group_fanout_title")[0];
    const titleText = byClass(title, "deg_expert_group_task")[0];
    assert.ok(titleText, "fan-out 标题必须渲染");
    assert.equal(titleText.type, "div", "标题是 div，不得嵌套 button");
    assert.equal(titleText.props.role, "button");
    assert.equal(titleText.props.tabIndex, 0);
    assert.ok(String(titleText.props["aria-label"]).startsWith("打开任务会话："));

    titleText.props.onKeyDown({ key: "a", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, [], "非 Enter/Space 不得导航");
    // Host 的 fan-out 父任务是任务而不是会话：没有 sessionId 时落点是**最新分片 attempt 的会话**。
    titleText.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, ["running-child"], "Enter 必须跳转 fan-out 最新分片会话");
    titleText.props.onKeyDown({ key: " ", preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(opened, ["running-child", "running-child"], "Space 与 Enter 同效");
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 18：右栏宽度手柄可按指针/键盘调整比例并持久化", async () => {
  const applied = [];
  const listeners = { pointermove: new Set(), pointerup: new Set(), pointercancel: new Set(), mousemove: new Set(), mouseup: new Set() };
  const windowStub = {
    innerWidth: 1000,
    addEventListener(type, listener) {
      if (listeners[type] === undefined) listeners[type] = new Set();
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type]?.delete(listener);
    },
  };
  const restoreWindow = installGlobals({ window: windowStub });
  const mounted = mountPanel({
    readRightbarWidthRatio: () => 0.2,
    applyRightbarWidthRatio: (ratio, options) => {
      applied.push({ ratio, persist: options?.persist === true });
    },
  });
  const { handle, restore } = mounted;
  const resizer = () => byClass(handle.output, "deg_expert_group_resizer")[0];
  try {
    await handle.settle();
    const handleNode = resizer();
    assert.ok(handleNode, "注入了写入能力时必须渲染宽度手柄");
    assert.equal(handleNode.props.role, "separator");
    assert.equal(handleNode.props["aria-orientation"], "vertical");
    assert.equal(handleNode.props["aria-valuemin"], 15);
    assert.equal(handleNode.props["aria-valuemax"], 50);
    assert.equal(handleNode.props["aria-valuenow"], 20);
    assert.equal(handleNode.props.tabIndex, 0, "手柄必须可键盘聚焦");

    // 指针拖拽：起手 900 → 移动到 800（向左 100px / 1000 = +10%）。
    handleNode.props.onPointerDown({ clientX: 900, preventDefault() {}, stopPropagation() {} });
    for (const listener of listeners.pointermove) listener({ clientX: 800, preventDefault() {} });
    assert.equal(applied.length, 1);
    assert.equal(applied[0].ratio.toFixed(2), "0.30");
    assert.equal(applied[0].persist, false, "拖动过程只预览，不写 localStorage");
    for (const listener of listeners.pointerup) listener({});
    assert.equal(applied.at(-1).persist, true, "松手必须持久化");
    assert.equal(applied.at(-1).ratio.toFixed(2), "0.30");
    assert.equal(listeners.pointermove.size, 0, "松手必须解绑拖拽监听");
    await handle.settle();
    assert.equal(resizer().props["aria-valuenow"], 30, "aria-valuenow 必须跟随拖拽结果");

    // 越界 clamp：把它拖到远超出视口左侧，比例封顶 50%。
    resizer().props.onPointerDown({ clientX: 1000, preventDefault() {}, stopPropagation() {} });
    for (const listener of listeners.pointermove) listener({ clientX: -5000, preventDefault() {} });
    assert.equal(applied.at(-1).ratio, 0.5, "宽度比例必须 clamp 到 50%");
    for (const listener of listeners.pointerup) listener({});
    await handle.settle();

    // 键盘：Left 缩窄 2%，Home/End 直达边界。
    resizer().props.onKeyDown({ key: "ArrowLeft", preventDefault() {}, stopPropagation() {} });
    assert.equal(applied.at(-1).ratio.toFixed(2), "0.48");
    assert.equal(applied.at(-1).persist, true, "键盘调整同样持久化");
    resizer().props.onKeyDown({ key: "Home", preventDefault() {}, stopPropagation() {} });
    assert.equal(applied.at(-1).ratio, 0.15);
    resizer().props.onKeyDown({ key: "End", preventDefault() {}, stopPropagation() {} });
    assert.equal(applied.at(-1).ratio, 0.5);
    resizer().props.onKeyDown({ key: "a", preventDefault() {}, stopPropagation() {} });
    assert.equal(applied.at(-1).ratio, 0.5, "无关按键不得调整宽度");
  } finally {
    handle.unmount();
    restore();
    restoreWindow();
  }
});

test("票据 18：没有 install 注入点时面板不渲染宽度手柄（绝不留下拖了没反应的控件）", async () => {
  const mounted = mountPanel();
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(byClass(handle.output, "deg_expert_group_resizer").length, 0);
  } finally {
    handle.unmount();
    restore();
  }
});


test("票据 19：英文宿主下侧栏核心文案来自消息表（标题/刷新/搜索/过滤/空闲组）", async () => {
  const partialSnapshot = { ...snapshot(), partial: true };
  const mounted = mountPanel({ hostSnapshot: partialSnapshot, storage: new MemoryStorage(), locale: "en-US" });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(textOf(byClass(handle.output, "deg_expert_group_header_title")[0]), "Expert Group");

    // 刷新入口（英文宿主下同样来自消息表）。
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "Refresh"), true);
    // partial 徽标与「更新于」已按用户要求移除，两份文案表里的 sidebar.partial / sidebar.updated
    // 四个键也一并删除：英文宿主下这两个节点与两段文案都不得再上屏（断言反转，不是删除）。
    assert.equal(byClass(handle.output, "deg_expert_group_partial").length, 0, "partial 徽标不得再渲染");
    assert.equal(byClass(handle.output, "deg_expert_group_updated").length, 0, "更新时间文本不得再渲染");
    assert.equal(textOf(handle.output).includes("Incomplete data"), false, "Incomplete data 文案必须彻底消失");
    assert.equal(textOf(handle.output).includes("Updated "), false, "Updated HH:MM:SS 文案必须彻底消失");

    // 工具条：搜索、角色/状态筛选；诊断与导出入口已移除。
    const search = byClass(handle.output, "deg_expert_group_search")[0];
    assert.equal(search.props.placeholder, "Search task name / role / model");
    const filters = byClass(handle.output, "deg_expert_group_filter");
    assert.equal(filters[0].props["aria-label"], "Filter by role");
    assert.equal(filters[1].props["aria-label"], "Filter by status");
    assert.equal(textOf(filters[0].children.find((child) => child?.props?.value === "")), "All roles");
    assert.equal(textOf(filters[1].children.find((child) => child?.props?.value === "")), "All statuses");
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "Export Markdown"), false);
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "Export JSON"), false);

    // 空闲分组标题与成员计数。
    const idleHeader = byClass(handle.output, "deg_expert_group_idle_header")[0];
    assert.ok(textOf(idleHeader).includes("Idle subagents (1)"));

    // 过滤无命中：英文空态。
    search.props.onChange({ target: { value: "no-such-task-xyz" } });
    await handle.settle();
    assert.equal(textOf(byClass(handle.output, "deg_expert_group_filter_empty")[0]), "No matching tasks");

    // 折叠/展开按钮的无障碍名称。
    const chevron = byClass(handle.output, "deg_expert_group_chevron")[0];
    assert.ok(["Collapse", "Expand"].includes(chevron.props["aria-label"]));
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 19：英文宿主下空态/错误来源文案来自消息表，缺失键不显示键名", async () => {
  // 无快照且 RPC 失败：错误空态必须显示英文来源文案（snapshot → Snapshot read failed）。
  const mounted = mountPanel({
    locale: "en",
    requestPluginRpc: async () => { throw new Error("network down"); },
  });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    const errorEmpty = byClass(handle.output, "deg_expert_group_error_empty")[0];
    assert.ok(errorEmpty, "失败且无缓存时必须渲染错误空态");
    assert.equal(textOf(byClass(errorEmpty, "deg_expert_group_error_empty_title")[0]), "Snapshot read failed");
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "Retry"), true);
    // 任何可见文本都不能是消息表键名或空串占位之外的内部标识。
    const visible = textOf(handle.output);
    assert.equal(visible.includes("sidebar."), false);
  } finally {
    handle.unmount();
    restore();
  }
});

test("票据 19：ctx.i18n.locale 与应用文案语言同样生效（优先级兜底）", async () => {
  const mounted = mountPanel({ i18n: { locale: "en" }, storage: new MemoryStorage() });
  const { handle, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(walk(handle.output).some((node) => node?.props?.["aria-label"] === "Refresh"), true);
    assert.equal(byClass(handle.output, "deg_expert_group_search")[0].props.placeholder, "Search task name / role / model");
  } finally {
    handle.unmount();
    restore();
  }
});

/**
 * 续作（continuation）复用后的用户可见回归——直接锁用户报告的两个症状。
 *
 * 症状 1：同一 fan-out 分片被 continuation 复用后，侧栏出现「多次重试」徽标，正常的续作
 *        被误读成任务在反复失败重试。宿主修复后的口径是：retryCount 只统计真正的重试轮次，
 *        continuation 轮次不计入（父任务 round=2、分片两条 attempt 同属同一 childId 时
 *        retryCount 仍为 0）。本用例固定的是**用户能看到的结果**：新口径快照下整棵面板不得
 *        出现任何重试徽标，fan-out 子树文本也不含「多次重试」。
 * 症状 2：续作复用后分片行行尾的双箭头（打开 subagentchat 的侧栏动作）消失，用户无法再从
 *        侧栏打开该分片的子会话。宿主修复后导航 childId 在复用轮次被保留；本用例断言分片行
 *        仍有可用的双箭头，且点开的 subagentchat 地址 child 段是当前 childId（child-cont）、
 *        parent 段是 root 会话、mode 与 continuable 一致。
 *
 * 这两处修复分别落在宿主与渲染侧，当前代码已通过；本用例的价值在于把「宿主契约字段」翻译成
 * 端到端的可见结果门禁：只断言宿主字段（retryCount / childId）不足以防回归，任何一侧把
 * continuation 重新解释成重试、或在复用后丢掉导航 childId，用户看到的仍是当初报告的问题。
 *
 * 「改动前会不会失败」的实测结论（用于说明本用例的灵敏度）：
 * - 箭头：会失败。修复前宿主按「声明的 fanoutAttempt ≠ 最新 attempt 号」判定身份矛盾，
 *   continuation 复用（声明号 1、最新 attempt 号 2）会把分片的导航 childId 与最新 attempt
 *   的 childId 一起清空；按这份旧输出挂载本用例时，双箭头整枚消失，assertArrowDirection
 *   在「箭头必须存在」处即失败（已用同一夹具把 childId 置空实测复现）。
 * - 徽标：最小夹具（round=2、两条 attempt）在旧口径下 retryCount=1，尚未达到阈值 3，
 *   所以徽标断言本身在改动前不会红；它锁定的是「续作轮次计 0 次重试」的契约（0 对 1），
 *   多次续作累积后才会变成用户看到的徽标。末尾 retryCount=3 的对照夹具证明阈值逻辑仍在，
 *   只是不再把 continuation 当重试——防止有人为了让本用例变绿而整体删掉徽标。
 * 注意：渲染层在分片缺少 childId 时会回退最新 attempt 的 childId，因此箭头断言同时固定
 * 「分片导航 childId 与最新 attempt 一致」这条可证明来源；若宿主两处都丢，地址不可解析，
 * 箭头会整枚消失，本用例即失败。
 */
test("续作复用：分片行不误报「多次重试」且保留行尾双箭头（宿主新口径集成）", async () => {
  // 宿主新口径的快照形状：父任务 round=2（经历一次 continuation 复用），分片两条 attempt
  // 都属于同一个 childId（续作沿用同一子会话），因此 retryCount=0；分片 continuable=true
  // 且 childId 指向可导航的续作子会话。父任务显式给 retryCount=0：不再用
  // 「attemptCount - 1」或分片汇总把续作算成重试。
  const continuationSnapshot = () => {
    const base = snapshot();
    base.root.children = [{
      id: "fan-cont", kind: "fanout", parentTaskId: "fan-cont", taskName: "续作复用任务",
      role: "fixer", status: "succeeded", round: 2, retryCount: 0,
      shards: [{
        shardId: "cont-shard", prompt: "续作复用分片提示", role: "fixer", status: "succeeded",
        childId: "child-cont", continuable: true, retryCount: 0,
        attempts: [
          { attempt: 1, status: "succeeded", childId: "child-cont" },
          { attempt: 2, status: "succeeded", childId: "child-cont" },
        ],
      }],
    }];
    return base;
  };

  // 结算态（succeeded）fan-out 默认收起：本用例验证分片行内容，先按用户方式展开。
  const mounted = mountContractPanel({ hostSnapshot: continuationSnapshot(), storage: new MemoryStorage() });
  const { handle, resourceCalls, intervals, restore } = mounted;
  try {
    await handle.settle();
    await expandFanouts(handle);
    const fanout = byClass(handle.output, "deg_expert_group_fanout")[0];
    assert.ok(fanout, "fan-out 父任务必须渲染");

    // 1) 续作不算重试：整棵面板不得出现徽标，fan-out 子树文本也不含该文案。
    assert.equal(
      byClass(handle.output, "deg_expert_group_retry_warning").length,
      0,
      "续作复用后不得出现「多次重试」徽标",
    );
    assert.equal(textOf(fanout).includes("多次重试"), false, "fan-out 子树文本不得包含「多次重试」");

    const shardRow = rowOfShard(handle.output, "cont-shard");
    assert.ok(shardRow, "续作分片行必须渲染");

    // 2) 行尾双箭头仍在且可用：两枚同向右箭头 + openResource 指向 subagentchat 资源。
    assertArrowDirection(handle, "cont-shard", "chevron-right", "续作复用后分片行必须保留两个右箭头");
    const shardArrow = sidebarActionOf(rowByText(handle, "cont-shard"));
    assert.ok(shardArrow, "续作分片行必须有侧栏箭头按钮");
    const clickEvent = recordingEvent();
    shardArrow.props.onClick(clickEvent);
    assert.equal(clickEvent.defaultPrevented, true, "箭头必须拦下默认行为");
    assert.equal(clickEvent.propagationStopped, true, "箭头必须拦下冒泡，绝不触发主视图导航");
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child-cont?parent=root-1&mode=continuable",
      options: { kind: "subagentchat", preferNewPane: true },
    }], "箭头必须打开续作子会话：child=child-cont、parent=root 会话、mode 跟随 continuable");

    // 4) 分片行仍不渲染 attempt 时间线（上一轮删除时间线的契约继续有效）。
    assert.equal(byClass(shardRow, "deg_expert_group_attempts").length, 0, "续作分片行不得渲染 attempt 时间线");
    assert.equal(byClass(shardRow, "deg_expert_group_attempt").length, 0, "续作分片行不得渲染 attempt 条目");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);

  // 3) 对照：同一夹具只把分片的 retryCount 改成 3（达到阈值），徽标必须重新出现。
  //    这证明第 1 步的「没有徽标」来自宿主的续作口径，而不是徽标阈值逻辑被整体删除。
  const retriedSnapshot = continuationSnapshot();
  retriedSnapshot.root.children[0].shards[0].retryCount = 3;
  const retried = mountContractPanel({ hostSnapshot: retriedSnapshot, storage: new MemoryStorage() });
  try {
    await retried.handle.settle();
    // 结算态 fan-out 默认收起：徽标在分片行上，先展开。
    await expandFanouts(retried.handle);
    const retriedShard = rowOfShard(retried.handle.output, "cont-shard");
    const warning = byClass(retriedShard, "deg_expert_group_retry_warning")[0];
    assert.ok(warning, "retryCount 达到阈值时分片行必须重新出现徽标");
    assert.equal(textOf(warning), "多次重试");
    assert.equal(warning.props.title, "已重试 3 次");
    // 父任务自己的 retryCount 仍为 0：徽标只跟随真正达到阈值的行，不被分片值污染。
    // 注意 fanout 容器包含分片子树，必须把范围收敛到父任务头部行再看徽标。
    const retriedFanoutHeader = byClass(retried.handle.output, "deg_expert_group_fanout_header")[0];
    assert.ok(retriedFanoutHeader, "fan-out 父任务头部必须渲染");
    assert.equal(
      byClass(retriedFanoutHeader, "deg_expert_group_retry_warning").length,
      0,
      "父任务 retryCount=0 时不得被分片的重试计数带出徽标",
    );
  } finally {
    retried.handle.unmount();
    retried.restore();
  }
});

// ── 票据 09：标题栏「峰谷时段标记」与分钟级刷新 ─────────────────────────────────
// 断言强度：
// - 文案与「设置页入口按钮的后缀」同键同源（A5 渲染真实设置页做对照）；
// - 60s 定时器只在启用时创建：受控 setInterval 账本记录**每一次**调用（含已清理的），
//   因此"未启用"断言的是"一次都没创建"，而不只是"当前不存在"；
// - 跨边界更新用受控时钟推进 + 受控 tick 驱动，不真实等待（A6）；
// - 标记只出现在标题栏：任务行/运行摘要的渲染输出与未注入读面时逐字相同。

/** 标题栏峰谷标记节点（稳定 class；缺失返回 null）。 */
const peakValleyMarkerOf = (handle) => byClass(handle.output, "deg_expert_group_header_peak_valley")[0] ?? null;
const peakValleyTagText = (handle) => {
  const node = peakValleyMarkerOf(handle);
  return node === null ? null : textOf(node);
};
/** 峰段夹具：08:00–10:00 为峰时（左闭右开：10:00 起即谷时）。 */
const PEAK_PERIODS = Object.freeze([{ start: "08:00", end: "10:00" }]);

/**
 * 可控「无参 new Date()」：替换全局 Date，按当前固定时刻回答。
 *
 * 为什么不用 installFakeClock：那个替身只接管 Date.now，而判定函数（与设置页）都用
 * `new Date()` 读墙钟——只改 Date.now 不会影响 new Date()。这里连构造一起接管，
 * 用例才能用 set/advance 精确驱动"跨过峰段边界"这一时刻。
 * 带参数的构造与静态方法原样委托给真实 Date（其余用例行为不变）。
 */
function installFixedDate(initial) {
  const RealDate = globalThis.Date;
  const state = { now: initial };
  function FixedDate(...args) {
    if (args.length > 0) return new RealDate(...args);
    return new RealDate(state.now);
  }
  FixedDate.prototype = RealDate.prototype;
  FixedDate.now = () => state.now;
  FixedDate.parse = (text) => RealDate.parse(text);
  FixedDate.UTC = (...args) => RealDate.UTC(...args);
  globalThis.Date = FixedDate;
  return {
    set(next) { state.now = next; },
    advance(ms) { state.now += ms; },
    now: () => state.now,
    restore() { globalThis.Date = RealDate; },
  };
}

/**
 * 与 install 注入面同形的峰谷读面替身：`enabled/periods` 每次现读，
 * 因此用例可以只改 state 就让面板看到设置页保存后的新值。
 */
function peakValleyDeps(state, extra = {}) {
  return {
    peakValleyTime,
    settingsExtraText,
    getPeakValleySettings: () => ({
      enabled: state.enabled === true,
      periods: Array.isArray(state.periods) ? state.periods : [],
    }),
    ...extra,
  };
}

/** 标题栏子节点的相对顺序（用于断言"Auto 右侧、错误槽左侧"）。 */
function headerOrderOf(handle) {
  const header = byClass(handle.output, "deg_expert_group_header")[0];
  assert.ok(header, "标题栏必须渲染");
  return {
    auto: header.children.findIndex((node) => String(node?.props?.className ?? "").split(/\s+/).includes("deg_expert_group_header_auto")),
    marker: header.children.findIndex((node) => node === peakValleyMarkerOf(handle)),
    error: header.children.findIndex((node) => String(node?.props?.className ?? "").split(/\s+/).includes("deg_expert_group_error")),
    refresh: header.children.findIndex((node) => String(node?.props?.className ?? "").split(/\s+/).includes("deg_expert_group_header_action")),
  };
}

/**
 * 渲染**真实设置页**并返回「峰谷模式」入口按钮的完整文本（A5 的对照面）。
 *
 * 与设置页测试同一装载路径（client.apply → settings.section 组件），后缀完全由生产实现
 * 算出：侧栏标记只要与它的尾部一致，就证明两处对同一 enabled/periods + 同一时刻给出
 * 同一个峰/谷结果（两处都调 01 的权威纯函数，没有第二份判定）。
 */
async function renderSettingsEntryText(settingsValue) {
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restoreIntervals = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
  const settingsForm = {
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "ready", value: settingsValue, revision: 1, writable: true, mode: "host" }),
  };
  const host = createHostContextStub({
    connection: {
      rpc: {
        async call(_channel, _endpoint, body) {
          if (body?.action === "meta") {
            return { ok: true, value: { ok: true, activeRoles: ["fixer"], enableObserver: true } };
          }
          return { ok: false, error: { code: "bad-request" } };
        },
      },
    },
  });
  client.apply(host.ctx);
  const section = host.registrations.get("settings.section");
  assert.ok(section, "设置页必须注册为 settings.section");
  const modelCatalog = {
    subscribe: () => () => {},
    getSnapshot: () => ({ groups: [], status: "ready", error: null }),
    load: async () => {},
  };
  const handle = runtime.render(section.Component, { settingsForm, modelCatalog, ctx: host.ctx });
  try {
    await handle.settle();
    const entry = byClass(handle.output, "deg_settings_peak_valley_entry")[0];
    assert.ok(entry, "设置页必须渲染峰谷入口按钮");
    return textOf(entry);
  } finally {
    handle.unmount();
    host.dispose();
    restoreIntervals();
  }
}

test("A4：未启用时 Auto 右侧显示「峰谷：未启用」，且绝不创建分钟定时器", async () => {
  // 基线：同一份快照、不注入峰谷读面 ⇒ 任务树渲染输出必须与新标记无关。
  const baseline = mountPanel({});
  let baselineRows = [];
  try {
    await baseline.handle.settle();
    baselineRows = byClass(baseline.handle.output, "deg_expert_group_row").map((row) => textOf(row));
  } finally {
    baseline.handle.unmount();
    baseline.restore();
  }
  assert.equal(baselineRows.length > 0, true, "基线必须渲染出任务行");

  const state = { enabled: false, periods: PEAK_PERIODS };
  const mounted = mountPanel(peakValleyDeps(state));
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    const marker = peakValleyMarkerOf(handle);
    assert.ok(marker, "标题栏必须渲染峰谷时段标记（Auto 右侧）");
    assert.equal(textOf(marker), "峰谷：未启用");
    assert.equal(textOf(marker), settingsExtraText("zh", "settings.pv.disabled"),
      "未启用文案必须来自 settings/extra 表（与设置页同一张表）");
    assert.equal(marker.props["data-peak-valley"], "disabled");
    // 位置：紧跟 Auto、位于刷新按钮之前（错误槽未出现时紧邻 Auto）。
    const order = headerOrderOf(handle);
    assert.equal(order.marker, order.auto + 1, "标记必须紧跟在 Auto 之后");
    assert.ok(order.marker < order.refresh, "标记必须位于标题栏操作按钮之前");

    // 未启用 ⇒ 受控账本里一次 60s 定时器都没有（不是"当前不存在"，而是"从未创建"）。
    assert.equal(intervals.scheduled.includes(60000), false, "未启用时绝不得创建 60s 定时器");
    assert.equal(intervals.delays.includes(60000), false);

    // 标记只进标题栏：任务行/运行摘要的渲染输出与基线逐字相同。
    const markedRows = byClass(handle.output, "deg_expert_group_row").map((row) => textOf(row));
    assert.deepEqual(markedRows, baselineRows, "任务行与运行摘要的渲染输出不得因标记而改变");
    assert.equal(markedRows.some((row) => row.includes("峰谷：未启用")), false, "标记不得进入任务行");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得留下任何定时器");
});

test("A4-补：有错误槽时标记仍在 Auto 与错误槽之间", async () => {
  const state = { enabled: false, periods: PEAK_PERIODS };
  const mounted = mountPanel(peakValleyDeps(state, {
    requestPluginRpc() {
      throw new Error("快照传输失败");
    },
  }));
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.ok(headerErrorNode(handle), "本用例必须有错误槽");
    const order = headerOrderOf(handle);
    assert.ok(order.error > 0, "错误槽必须渲染");
    assert.equal(order.marker, order.auto + 1, "标记必须紧跟在 Auto 之后");
    assert.ok(order.marker < order.error, "标记必须位于错误槽之前（错误槽右侧才是刷新按钮）");
    assert.ok(order.error < order.refresh, "错误槽仍位于刷新按钮之前（既有顺序不变）");
    assert.equal(peakValleyTagText(handle), "峰谷：未启用");
  } finally {
    handle.unmount();
    restore();
  }
  assert.equal(intervals.active, 0);
});

test("A5：启用后标记显示峰时/谷时，且与设置页入口后缀对同一输入一致", async () => {
  const state = { enabled: true, periods: PEAK_PERIODS };
  const settingsValue = {
    peakValley: {
      enabled: true,
      initialized: true,
      periods: PEAK_PERIODS,
      peak: { provider: "", defaults: {}, candidates: {}, fallbackLimit: 2 },
      valley: { provider: "", defaults: {}, candidates: {}, fallbackLimit: 2 },
    },
  };
  // 固定本地墙钟 09:00（峰段内）：侧栏与设置页读到的都是同一个 "now"。
  const clock = installFixedDate(new Date(2026, 0, 15, 9, 0, 0).getTime());
  const mounted = mountPanel(peakValleyDeps(state));
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷模式 峰时");
    assert.equal(peakValleyMarkerOf(handle).props["data-peak-valley"], "peak");
    assert.equal(peakValleyTagText(handle),
      settingsExtraText("zh", "settings.pv.entry") + " " + settingsExtraText("zh", "settings.pv.peak"),
      "标记文案必须复用设置页入口文案 + settings.pv.peak");

    const peakEntryText = await renderSettingsEntryText(settingsValue);
    assert.equal(peakEntryText, "峰谷模式 峰时", "设置页入口后缀（对照面）应为峰时");
    assert.equal(peakValleyTagText(handle), peakEntryText,
      "侧栏标记必须与设置页入口按钮同文案（同一 enabled/periods 同一结果）");

    // 启用后必须启动分钟级刷新（与"未启用不创建"成对，证明定时器确实是启用态专属）。
    assert.equal(intervals.delays.includes(60000), true, "启用后必须创建 60s 定时器");

    // 跨到谷时（10:30）：受控 tick 重算后标记与设置页后缀仍一致。
    clock.advance(90 * 60 * 1000);
    await intervals.tick();
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷模式 谷时");
    assert.equal(peakValleyMarkerOf(handle).props["data-peak-valley"], "valley");
    assert.equal(peakValleyTagText(handle),
      settingsExtraText("zh", "settings.pv.entry") + " " + settingsExtraText("zh", "settings.pv.valley"),
      "标记文案必须复用设置页入口文案 + settings.pv.valley");
    const valleyEntryText = await renderSettingsEntryText(settingsValue);
    assert.equal(valleyEntryText, "峰谷模式 谷时");
    assert.equal(peakValleyTagText(handle), valleyEntryText,
      "谷时同样必须与设置页入口按钮同文案");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
  assert.equal(intervals.active, 0);
});

test("A6：跨过峰段边界后标记自动更新，无需刷新面板（分钟级）", async () => {
  const state = { enabled: true, periods: PEAK_PERIODS };
  // 09:59 仍在峰段内；推进 2 分钟跨过 10:00 边界。
  const clock = installFixedDate(new Date(2026, 0, 15, 9, 59, 0).getTime());
  const mounted = mountPanel(peakValleyDeps(state));
  const { handle, intervals, restore } = mounted;
  try {
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷模式 峰时");
    // 不刷新、不重挂载：只推进受控时钟并驱动分钟级 tick。
    clock.advance(2 * 60 * 1000);
    await intervals.tick();
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷模式 谷时", "跨过峰段边界后标记必须自动更新");
    assert.equal(peakValleyMarkerOf(handle).props["data-peak-valley"], "valley");
    // 同一时段内继续 tick 不改变结果（幂等）。
    await intervals.tick();
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷模式 谷时");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
  assert.equal(intervals.active, 0, "卸载后分钟级定时器必须被清理");
  assert.equal(intervals.delays.includes(60000), false);
});

test("A6-补：设置表单变更（启用/关闭、时段变化）后标记立即更新", async () => {
  // 受控订阅面：install 注入的 subscribePeakValleySettings 与 settingsForm.subscribe 同形。
  const state = { enabled: false, periods: PEAK_PERIODS };
  const listeners = new Set();
  const clock = installFixedDate(new Date(2026, 0, 15, 9, 0, 0).getTime());
  const mounted = mountPanel(peakValleyDeps(state, {
    subscribePeakValleySettings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }));
  const { handle, intervals, restore } = mounted;
  const notify = async () => {
    for (const listener of [...listeners]) listener();
    await handle.settle();
  };
  try {
    await handle.settle();
    assert.equal(peakValleyTagText(handle), "峰谷：未启用");
    assert.equal(intervals.delays.includes(60000), false, "未启用时不创建分钟定时器");

    // ① 用户启用峰谷（同一时刻仍在峰段内）：标记立刻变成「峰时」，定时器随之启动。
    state.enabled = true;
    await notify();
    assert.equal(peakValleyTagText(handle), "峰谷模式 峰时", "启用后必须立刻更新，不必等下一轮轮询");
    assert.equal(intervals.delays.includes(60000), true, "启用后必须启动分钟级刷新");

    // ② 用户把峰段改到 11:00–12:00：同一时刻 09:00 变成谷时，标记立即跟随。
    state.periods = [{ start: "11:00", end: "12:00" }];
    await notify();
    assert.equal(peakValleyTagText(handle), "峰谷模式 谷时", "时段变化后必须立即按新时段重算");

    // ③ 用户关闭峰谷：标记回到「峰谷：未启用」，定时器被清理。
    state.enabled = false;
    await notify();
    assert.equal(peakValleyTagText(handle), "峰谷：未启用");
    assert.equal(intervals.delays.includes(60000), false, "关闭后必须清掉分钟定时器");
    assert.equal(listeners.size, 1, "同一 Panel 只保留一条订阅");
  } finally {
    handle.unmount();
    restore();
    clock.restore();
  }
  assert.equal(intervals.active, 0);
  assert.equal(listeners.size, 0, "卸载必须取消设置订阅");
});

