import test from "node:test";
import assert from "node:assert/strict";

import { createClientReactRuntime, createFakeIntervals, installGlobals, loadClientBundle } from "../test-support/client-bundle.mjs";

await import("../client-sidebar-views-a.js");
await import("../client-sidebar-views-b.js");
await import("../client-sidebar-views-c.js");
await import("../client-sidebar-overlay.js");
await import("../client-expert-group-sidebar.js");
const sidebar = globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];

const react = { createElement(type, props, ...children) { return { type, props: props || {}, children }; } };
// 图标名按 0.1.7-alpha.2 词表：后缀是描边粗细（Regular=1px），渲染尺寸由 size prop 承载；
// 旧 `*14` / `*16` 后缀名在该版本已消失，替身也必须提供新名，否则插件会走兜底或判为能力缺失。
const primitives = {
  IconChevronRightOutlineRegular: function Chevron() {}, IconChevronDownOutlineRegular: function ChevronDown() {},
  IconRefreshOutlineRegular: function Refresh() {},
  IconStopFillRegular: function Stop() {}, IconWarningOutlineRegular: function Warning() {}, IconCheckOutlineRegular: function Check() {},
};
function sessionsFixture() {
  let snapshot = { current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } };
  const listeners = new Set();
  return { list: { getSnapshot: () => snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }, open: () => {}, set(next) { snapshot = next; for (const fn of listeners) fn(); } };
}

function modernSessionsFixture() {
  // DSH 0.1.6 起 SessionListState 不再提供 snapshot.current；当前主会话
  // 由 byId 条目的 retainedBy.mainView 引用计数表示。
  // 0.1.7-alpha.2 的子代理目录改由 projectionsBySession 承载。
  let snapshot = {
    ids: ["root-a", "root-b"],
    byId: {
      "root-a": { id: "root-a", retainedBy: { mainView: 1 } },
      "root-b": { id: "root-b", retainedBy: {} },
    },
    phase: "ready",
    projectionsBySession: {},
  };
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
  };
}

/**
 * 带 child 子代理会话的 sessions 替身：child-1/child-2 都挂在 root-1 下。
 * 与真实 DSH 一致，current 可以直接是一个 child 会话（用户正在看子代理会话）。
 */
function childSessionsFixture() {
  let snapshot = {
    current: "child-1",
    byId: {
      "root-1": { id: "root-1" },
      "child-1": { id: "child-1", parentId: "root-1" },
    },
  };
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    open: () => {},
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
  };
}

/**
 * 与真实 Host 同契约的 root 解析器（client-entry.js expertGroupRootSessionIdOf 的行为）：
 * 沿 byId 的 parentId/parentSessionId 一路走到根，缺失或成环时停在最后一个已知会话。
 */
function rootIdOf(sessionId, _session, snapshot) {
  const byId = snapshot?.byId ?? {};
  let candidate = sessionId;
  const visited = new Set();
  while (!visited.has(candidate)) {
    visited.add(candidate);
    const parent = byId[candidate]?.parentId;
    if (typeof parent !== "string" || parent.length === 0 || parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

/**
 * 无 DOM 视口替身：侧栏源码只通过 globalThis.window.innerWidth（回退 globalThis.innerWidth）
 * 读取窗口宽度，因此给出最小替身即可，测试不依赖 jsdom 或任何真实 DOM。
 */
function withViewportWidth(width, run) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previous = globalThis.window;
  globalThis.window = { innerWidth: width };
  try {
    return run();
  } finally {
    if (hadWindow) globalThis.window = previous;
    else delete globalThis.window;
  }
}

/**
 * 宿主 layout 兼容桥替身：LayoutController 运行时把布局 store 的 bound actions 挂在
 * layout.panels 上（公开的 ctx.layout 本身没有 setRightbar）。
 *
 * 展开右栏走的是宿主公开契约 ctx.layout.openRightbar(track, fullscreen)，这里一并提供，
 * 并把调用记成 "rightbar:track:fullscreen" 事件；默认不提供该 action，以保留既有用例
 * 「宿主没有这个 action」的断言，需要断言自动展开的用例显式传 { openRightbar: true }。
 */
function layoutFixture(events, { openRightbar = false } = {}) {
  const layout = { panels: { setRightbar(px) { events.push("width:" + px); } } };
  if (openRightbar) {
    // 方法式绑定，与宿主 LayoutController 的 actions 一致：用例可据此确认接收者没丢。
    layout.openRightbar = function openRightbarAction(track, fullscreen) {
      events.push("rightbar:" + track + ":" + fullscreen);
    };
  }
  return layout;
}

/**
 * 自动展开右栏的事件（形如 rightbar:true:false），用于断言「每份右栏展示生命周期最多展开一次」：
 * 首次确保（此前确实没有右栏）时展开，之后切换 surface 只切换页面内容，绝不重复展开。
 */
const rightbarOpens = (events) => events.filter((event) => event.startsWith("rightbar:"));

/**
 * 受控 defer 调度替身：插件的异步展开只通过 globalThis.setTimeout / clearTimeout 排程与取消，
 * 因此替换这两个全局即可精确断言「同一同步栈内不展开、推进调度后才展开」以及 dispose 的清理。
 *
 * - flush()：执行当前所有待执行回调（回调里重新排队的新任务留到下一次 flush，便于验证重试上限）；
 * - size()：待执行任务数量（dispose 后必须归零）；
 * - delays()：待执行任务的延迟，用于确认「先排 0ms 的展开、失败后排 250ms 的重试」；
 * - failScheduling(true)：让 setTimeout 抛错，模拟没有可用调度器的宿主环境。
 */
function withDeferredTimers(run) {
  const pending = new Map();
  let nextId = 1;
  let schedulingThrows = false;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => {
    if (schedulingThrows) throw new Error("调度器不可用");
    const id = nextId++;
    pending.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => { pending.delete(id); };
  const timers = {
    flush() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.callback();
      }
    },
    size: () => pending.size,
    delays: () => [...pending.values()].map((entry) => entry.delay),
    failScheduling(value) { schedulingThrows = value === true; },
  };
  try {
    return run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

/** 可 await 的受控 timer：分栏事务 deadline 需要在 install panel 完成挂载后再推进。 */
async function withControlledTimeouts(run) {
  const pending = new Map();
  let nextId = 1;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => {
    const id = nextId++;
    pending.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => { pending.delete(id); };
  const timers = {
    flushAll() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.callback();
      }
    },
    delays() { return [...pending.values()].map((entry) => entry.delay); },
    size() { return pending.size; },
  };
  try {
    return await run(timers);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

/**
 * 反复推进调度直到没有待执行任务（就绪重试链会被逐轮清空），返回实际推进轮数。
 * 轮数可以断言「有界」：就绪重试与补偿重试都有上限，绝不该无限重排 timer。
 */
function drainTimers(timers, limit = 8) {
  let rounds = 0;
  while (timers.size() > 0 && rounds < limit) {
    timers.flush();
    rounds += 1;
  }
  return rounds;
}

/**
 * 带「宿主就绪证据」的 Better Sidebar 替身。
 *
 * 真实宿主用 Better 的公开状态订阅面报告当前活跃 surface：snapshot.sessionId 由
 * setSession(sessionId) 在会话切换提交时写入并通知。因此：
 * - getSnapshot().sessionId = 已提交的活跃会话（surface 是否真的切到该会话的权威证据）；
 * - openTab 记录每次请求，并标出它是在「已就绪」还是「还没切到位」时发出的——
 *   后者是实测竞态里可能被宿主丢弃、导致右栏空白的那一次；
 * - commitSession(next) 模拟宿主提交切换后发出的状态通知，notify() 只重放通知；
 * - failNextOpens(n) 让接下来 n 次 openTab 抛错，用来验证「补偿打开失败不结算 + 有界重试」。
 */
function readyBetterFixture({ active = "root-a" } = {}) {
  const opens = [];
  const listeners = new Set();
  let activeSession = active;
  let failingOpens = 0;
  return {
    opens,
    /** 就绪时成功发出的请求（真正落在已挂载 surface 上的那些）。 */
    landed: () => opens.filter((call) => call.ready && !call.failed).map((call) => call.sessionId),
    /** 全部请求尝试（含失败的），用来数补偿次数。 */
    requested: () => opens.map((call) => call.sessionId),
    failedAttempts: () => opens.filter((call) => call.failed).length,
    failNextOpens(count) { failingOpens = count; },
    registerTab() { return () => {}; },
    isTabEnabled: () => true,
    openTab(seed, scope) {
      const failed = failingOpens > 0;
      if (failed) failingOpens -= 1;
      opens.push({ sessionId: scope.sessionId, seed, ready: scope.sessionId === activeSession, failed });
      // 真实宿主的 openTab 也可能直接抛错（surface 还没挂载 / tab host 未就绪）。
      if (failed) throw new Error("宿主暂时无法定位该 surface");
    },
    getSnapshot() { return { sessionId: activeSession, state: undefined, prefs: {} }; },
    subscribeState(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    commitSession(next) { activeSession = next; for (const listener of [...listeners]) listener(); },
    notify() { for (const listener of [...listeners]) listener(); },
  };
}

/**
 * 「多 pane/分页」的公开只读证据替身：sidebarRight.openTabs.getSnapshot() 给出该会话**全部
 * pane** 的已提交 tab（DSH SidebarTabInventory 的形状：sessionId / tabId / kind / contentId），
 * 而 active() 只返回当前活跃 pane 的 active tab。
 *
 * 两条读面的差异正是刷新后的真实形状：宿主从持久化布局恢复所有 pane 的 tab，active() 却看不到
 * 非活跃 pane 里的 tab。只看 active() 就会把「Expert Group 页其实已经存在于另一个 pane」误判成
 * 「不存在」，于是在当前 pane 再开一个重复页（本 fixture 专门服务这条回归）。
 */
function crossPaneSidebarRightFixture({ sessionId = "root-a", activeTab = undefined, tabs } = {}) {
  const inventory = tabs ?? [{ sessionId, tabId: "pane-2-expert-group", kind: "expert-group", contentId: "expert-group" }];
  return { openTabs: { getSnapshot: () => inventory }, active: () => activeTab };
}

test("betterSidebar 存在时只注册 expert-group，并只为当前会话（deferred）打开页面", () => {
  assert.ok(sidebar && Object.isFrozen(sidebar));
  withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const calls = { tabs: [], opens: [], disposed: 0 };
    const betterSidebar = {
      registerTab(descriptor) { calls.tabs.push(descriptor); return () => { calls.disposed += 1; }; },
      isTabEnabled: () => true,
      openTab(seed, scope) { calls.opens.push({ seed, scope }); },
    };
    const ctx = { betterSidebar, sessions };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    assert.equal(calls.tabs.length, 1);
    assert.equal(calls.tabs[0].id, "expert-group");
    assert.equal(calls.tabs[0].title, "expert group");
    assert.equal(calls.tabs[0].single, true);
    assert.equal(typeof calls.tabs[0].component, "function");
    // 打开请求一律 defer：同步栈里一个都不发；后台 root-b 也不再预发（对未挂载会话的 open 会静默 no-op）。
    assert.deepEqual(calls.opens, []);
    drainTimers(timers);
    assert.deepEqual(calls.opens.map((call) => call.scope.sessionId), ["root-a"]);
    assert.ok(calls.opens.every((call) => call.seed.type === "expert-group" && call.seed.target === "right"));

    // 同一会话的重复通知不重复打开；换成 root-c 才算新的一次访问。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(calls.opens.map((call) => call.scope.sessionId), ["root-a"]);
    sessions.set({ current: "root-c", byId: { "root-a": { id: "root-a" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(calls.opens.map((call) => call.scope.sessionId), ["root-a", "root-c"]);
    dispose();
    assert.equal(calls.disposed, 1);
  });
});

test("DSH 0.1.6-alpha.2：没有 snapshot.current 时按 retainedBy.mainView 自动打开当前 Expert Group 页", () => {
  withDeferredTimers((timers) => {
    const sessions = modernSessionsFixture();
    const calls = { opens: [] };
    const betterSidebar = {
      registerTab() { return () => {}; },
      isTabEnabled: () => true,
      openTab(seed, scope) { calls.opens.push({ seed, scope }); },
    };
    const dispose = sidebar.installExpertGroupSidebar(
      { betterSidebar, sessions },
      { react, primitives, sessions, resolveRootSessionId: (id) => id },
    );
    assert.deepEqual(calls.opens, [], "打开请求仍应延迟到宿主会话状态提交之后");
    drainTimers(timers);
    assert.deepEqual(calls.opens.map((call) => call.scope.sessionId), ["root-a"]);

    sessions.set({
      ids: ["root-a", "root-b"],
      byId: {
        "root-a": { id: "root-a", retainedBy: {} },
        "root-b": { id: "root-b", retainedBy: { mainView: 1 } },
      },
      phase: "ready",
      projectionsBySession: {},
    });
    drainTimers(timers);
    assert.deepEqual(calls.opens.map((call) => call.scope.sessionId), ["root-a", "root-b"]);
    dispose();
  });
});

test("DSH 0.1.6-alpha.2 原生右侧栏：没有 snapshot.current 时仍按 retainedBy.mainView 打开 Expert Group 页", () => {
  withDeferredTimers((timers) => {
    const sessions = modernSessionsFixture();
    const calls = { types: [], slots: [], opens: [] };
    const ctx = {
      sessions,
      sidebarRightTabs: { register(definition) { calls.types.push(definition); return () => {}; } },
      sidebarRight: { openTab(kind, options) { calls.opens.push({ kind, options }); } },
      slots: { register(definition, component) { calls.slots.push({ definition, component }); return () => {}; } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
    });
    assert.equal(calls.types.length, 1);
    assert.equal(calls.types[0].keepMounted, true, "Expert Group 原生 tab 必须保持挂载，才能在子代理 tab 激活后继续同步");
    assert.equal(calls.slots.length, 1);
    drainTimers(timers);
    assert.deepEqual(calls.opens, [{ kind: "expert-group", options: { revealIfOpened: true } }]);
    dispose();
  });
});

test("native 只为当前 root 打开：走公开 global openTab，后台 root 绝不预发 openTabIn", () => {
  withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const calls = { types: [], slots: [], opens: [], legacy: [] };
    const ctx = {
      sessions,
      sidebarRightTabs: { register(definition) { calls.types.push(definition); return () => {}; } },
      sidebarRight: {
        openTab(kind, options) { calls.opens.push({ kind, options }); },
        openTabIn(sessionId, kind, options) { calls.legacy.push({ sessionId, kind, options }); },
      },
      slots: { register(definition, component) { calls.slots.push({ definition, component }); return () => {}; } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    assert.deepEqual(calls.opens, [], "同步栈不发请求");
    assert.deepEqual(calls.legacy, [], "后台 root 绝不预发（旧 API 对未挂载会话会静默 no-op）");
    drainTimers(timers);
    // global openTab(kind, options) 没有会话参数，只会画在当前会话上：当前 root 才允许调用。
    assert.deepEqual(calls.opens, [{ kind: "expert-group", options: { revealIfOpened: true } }]);
    assert.deepEqual(calls.legacy, []);

    // 切到 root-b：新的一次访问，轮到它走公开接口。
    sessions.set({ current: "root-b", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    drainTimers(timers);
    assert.equal(calls.opens.length, 2);
    assert.deepEqual(calls.legacy, [], "公开接口可用时绝不回退旧 openTabIn");
    dispose();
  });
});

test("只有 global openTab 时非当前 root 保持未打开，切到该 root 后才打开", () => {
  withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const calls = { opens: [] };
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight: { openTab(kind, options) { calls.opens.push({ kind, options }); } },
      slots: { register() { return () => {}; } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    drainTimers(timers);
    assert.deepEqual(calls.opens, [{ kind: "expert-group", options: { revealIfOpened: true } }]);

    // root-b 是非当前目标：绝不预发；它成为当前 surface 后才拿到自己的那次打开。
    sessions.set({ current: "root-b", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    drainTimers(timers);
    assert.deepEqual(calls.opens, [
      { kind: "expert-group", options: { revealIfOpened: true } },
      { kind: "expert-group", options: { revealIfOpened: true } },
    ]);
    dispose();
  });
});

test("native 优先使用按会话解析的 session-scoped openTab，公开全局接口不被越权调用", () => {
  withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const calls = { scoped: [], global: [] };
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight: { openTab(kind, options) { calls.global.push({ kind, options }); } },
      slots: { register() { return () => {}; } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
      // 本项目契约：按会话解析出作用域内的 sidebarRight，openTab 收到的会话就是该 surface。
      sidebarRightForSession: (root) => ({ openTab: (kind, options) => calls.scoped.push({ root, kind, options }) }),
    });
    drainTimers(timers);
    assert.deepEqual(calls.scoped, [
      { root: "root-a", kind: "expert-group", options: { revealIfOpened: true } },
    ]);
    assert.deepEqual(calls.global, []);

    // 切到 root-b：新访问只服务当前会话，全局接口仍然不被越权调用。
    sessions.set({ current: "root-b", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    drainTimers(timers);
    assert.deepEqual(calls.scoped.map((call) => call.root), ["root-a", "root-b"]);
    assert.deepEqual(calls.global, []);
    dispose();
  });
});

test("betterSidebar 缺失且旧 DSH 没有公开 openTab 时，只注册原生 keyed tab 并用 openTabIn 打开对应 root", () => {
  const sessions = sessionsFixture();
  const calls = { types: [], slots: [], opens: [], typeDisposed: 0, slotDisposed: 0 };
  const ctx = {
    sessions,
    sidebarRightTabs: { register(definition) { calls.types.push(definition); return () => { calls.typeDisposed += 1; }; } },
    sidebarRight: { openTabIn(sessionId, kind, options) { calls.opens.push({ sessionId, kind, options }); } },
    slots: { register(definition, component) { calls.slots.push({ definition, component }); return () => { calls.slotDisposed += 1; }; } },
  };
  const dispose = withDeferredTimers((timers) => {
    const release = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    assert.equal(calls.types.length, 1);
    assert.equal(calls.types[0].id, "dsh-expert-group");
    assert.equal(calls.types[0].kind, "expert-group");
    assert.equal(calls.types[0].guide[0].title(), "expert group");
    assert.equal(calls.slots.length, 1);
    assert.equal(calls.slots[0].definition.name, "sidebar.right.pane.tab");
    assert.equal(calls.slots[0].definition.key, "dsh-expert-group");
    // DSH 两阶段 registry 用 definition.id 寻找 body；kind 仅用于 openTab 路由。
    assert.equal(calls.slots[0].definition.key, calls.types[0].id);
    assert.notEqual(calls.slots[0].definition.key, calls.types[0].kind);
    assert.equal(typeof calls.slots[0].component, "function");
    drainTimers(timers);
    // 旧 DSH 只有 openTabIn：它只服务当前会话（后台 root 不预发，避免静默 no-op 被当成已完成）。
    assert.deepEqual(calls.opens.map(({ sessionId, kind }) => ({ sessionId, kind })), [
      { sessionId: "root-a", kind: "expert-group" },
    ]);
    return release;
  });
  dispose();
  assert.equal(calls.typeDisposed, 1);
  assert.equal(calls.slotDisposed, 1);
});

test("betterSidebar 禁用 expert-group 时不自动打开且不回退原生注册", () => {
  const sessions = sessionsFixture();
  const calls = { betterTabs: 0, opens: 0, nativeTabs: 0, slots: 0 };
  const ctx = {
    sessions,
    betterSidebar: {
      registerTab() { calls.betterTabs += 1; return () => {}; },
      isTabEnabled: () => false,
      openTab() { calls.opens += 1; },
    },
    sidebarRightTabs: { register() { calls.nativeTabs += 1; return () => {}; } },
    slots: { register() { calls.slots += 1; return () => {}; } },
  };
  const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions });
  assert.deepEqual(calls, { betterTabs: 1, opens: 0, nativeTabs: 0, slots: 0 });
  dispose();
});

test("任务管理关闭：零注册任何侧边栏入口，返回的 disposer 幂等且不释放别人的所有权", () => {
  const sessions = sessionsFixture();
  const calls = {};
  const note = (name) => { calls[name] = (calls[name] ?? 0) + 1; };
  const ctx = {
    sessions,
    betterSidebar: {
      registerTab() { note("betterRegisterTab"); return () => note("betterReleaseTab"); },
      isTabEnabled() { note("betterTabEnabled"); return true; },
      openTab() { note("betterOpenTab"); },
      subscribeState() { note("betterSubscribeState"); return () => note("betterUnsubscribeState"); },
      getSnapshot() { note("betterSnapshot"); return { sessionId: "root-a", prefs: {} }; },
      setTabEnabled() { note("betterSetTabEnabled"); },
    },
    sidebarRightTabs: { register() { note("nativeRegisterTab"); return () => note("nativeReleaseTab"); } },
    sidebarRight: {
      openTab() { note("nativeOpenTab"); },
      openTabIn() { note("nativeOpenTabIn"); },
    },
    slots: { register() { note("nativeRegisterSlot"); return () => note("nativeReleaseSlot"); } },
  };
  const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, taskManagementEnabled: false });
  assert.equal(typeof dispose, "function");
  assert.deepEqual(calls, {}, "关闭时必须不触碰任何宿主注册面（Better 与原生都不能注册，也不改 tabsEnabled 偏好）");
  // 幂等 no-op：重复释放既不得抛错，也不得释放别人的注册。
  dispose();
  dispose();
  assert.deepEqual(calls, {});
});

test("任务管理关闭只影响本插件：同一上下文重新开启后 Better/native 既有契约不变", () => {
  withDeferredTimers(() => {
    const sessions = sessionsFixture();
    const calls = { betterTabs: 0, betterDisposed: 0, nativeTabs: 0, slots: 0 };
    const ctx = {
      sessions,
      betterSidebar: {
        registerTab() { calls.betterTabs += 1; return () => { calls.betterDisposed += 1; }; },
        isTabEnabled: () => true,
        openTab() {},
      },
    };
    // 关闭：零注册；返回的 disposer 不可复用，这里按 apply 的卸载路径直接释放它。
    const disabled = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, taskManagementEnabled: false });
    assert.equal(calls.betterTabs, 0);
    disabled();
    disabled();
    assert.equal(calls.betterDisposed, 0, "no-op disposer 不得释放任何注册");

    // 重新开启必须重新 install：Better 注册契约与释放语义与既有用例一致。
    const enabled = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, taskManagementEnabled: true });
    assert.equal(calls.betterTabs, 1, "开启时必须注册 Better 页面");
    enabled();
    assert.equal(calls.betterDisposed, 1);

    // 未安装 Better Sidebar 时，原生 tab/slot 注册同样只在开启时生效。
    const nativeCtx = {
      sessions,
      sidebarRightTabs: { register() { calls.nativeTabs += 1; return () => {}; } },
      slots: { register() { calls.slots += 1; return () => {}; } },
    };
    const nativeDisabled = sidebar.installExpertGroupSidebar(nativeCtx, { react, primitives, sessions, taskManagementEnabled: false });
    assert.equal(calls.nativeTabs, 0);
    assert.equal(calls.slots, 0);
    nativeDisabled();
    const nativeEnabled = sidebar.installExpertGroupSidebar(nativeCtx, { react, primitives, sessions, taskManagementEnabled: true });
    assert.equal(calls.nativeTabs, 1, "开启时必须注册原生 tab");
    assert.equal(calls.slots, 1, "开启时必须注册原生 pane slot");
    nativeEnabled();
  });
});

/**
 * install 契约：RPC adapter 的协议声明必须原样透传到面板。
 *
 * 面板的调用约定只由注入侧声明决定（判定不读被调用函数的 length），安装路径因此必须把
 * `rpcAdapterProtocol` 一并交给 createExpertGroupPanel。这里直接渲染注册进宿主的那个
 * 组件——它是真实调用入口——以验证整条链路，而不是只看某个内部函数。
 */
test("install 透传 RPC adapter 协议声明：注册进宿主的组件按声明调用 adapter", async () => {
  const sessions = sessionsFixture();
  const connection = { rpc: { call: async () => ({ ok: true }) } };
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restoreGlobals = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: { id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a" },
  };
  const envelope = { ok: true, async json() { return { snapshot: hostSnapshot }; } };

  /** 安装一次、渲染宿主真正注册的组件，返回 adapter 收到的原始实参。 */
  const renderInstalled = async (deps) => {
    const calls = [];
    const registered = [];
    const ctx = {
      sessions,
      betterSidebar: {
        registerTab(descriptor) { registered.push(descriptor); return () => {}; },
        isTabEnabled: () => true,
        openTab() {},
      },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react: runtime.react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
      requestPluginRpc: function requestPluginRpc(...argv) { calls.push(argv); return envelope; },
      ...deps,
    });
    const component = registered[0]?.component;
    assert.equal(typeof component, "function", "Better 页面组件必须已注册");
    const handle = runtime.render(component, { scope: { sessionId: "root-a" }, ctx: { connection } });
    try {
      await handle.settle();
    } finally {
      handle.unmount();
      dispose();
    }
    return calls;
  };

  try {
    // 未声明：v1 connection-first（历史注入形状）；安装路径不得改变判定。
    const positional = await renderInstalled({});
    assert.equal(positional.length, 1, "首屏只发一次 RPC");
    assert.equal(positional[0][0], connection, "未声明协议时第一个实参必须是 connection");
    assert.equal(positional[0][1].action, "expert-group-snapshot");
    assert.equal(positional[0][1].sessionId, "root-a");

    // 显式 object：单一对象参数，证明声明确实穿透 install 到达面板。
    const object = await renderInstalled({ rpcAdapterProtocol: "object" });
    assert.equal(object.length, 1);
    assert.equal(object[0].length, 1, "对象协议只传一个实参，位置顺序不再承载语义");
    assert.deepEqual(Object.keys(object[0][0]).sort(), ["connection", "init", "request"]);
    assert.equal(object[0][0].connection, connection);
    assert.equal(object[0][0].request.action, "expert-group-snapshot");
    assert.equal(object[0][0].request.sessionId, "root-a");
  } finally {
    restoreGlobals();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("betterSidebar：current 是 child 时 root 与 child 两个 surface 都自动打开，且按 surface 去重", () => {
  const sessions = childSessionsFixture();
  const calls = { opens: [], disposed: 0 };
  const ctx = {
    betterSidebar: {
      registerTab() { return () => { calls.disposed += 1; }; },
      isTabEnabled: () => true,
      openTab(seed, scope) { calls.opens.push({ seed, scope }); },
    },
    sessions,
  };
  const dispose = withDeferredTimers((timers) => {
    const release = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const opened = () => calls.opens.map((call) => call.scope.sessionId);

    // 当前会话是 child-1：只为它发请求；root-1 是后台目标，绝不预发（那会静默 no-op 却被记成已完成）。
    assert.deepEqual(opened(), []);
    drainTimers(timers);
    assert.deepEqual(opened(), ["child-1"]);
    assert.ok(calls.opens.every((call) => call.seed.type === "expert-group" && call.seed.target === "right"));

    // 同一份快照再次广播：同一次访问不重复打开。
    sessions.set({
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    drainTimers(timers);
    assert.deepEqual(opened(), ["child-1"]);

    // 切到同一 root 下的新 child：这是新的一次访问，只新增 child-2。
    sessions.set({
      current: "child-2",
      byId: {
        "root-1": { id: "root-1" },
        "child-1": { id: "child-1", parentId: "root-1" },
        "child-2": { id: "child-2", parentId: "root-1" },
      },
    });
    drainTimers(timers);
    assert.deepEqual(opened(), ["child-1", "child-2"]);

    // 切回 child-1：新一轮访问，重新确保它的页面（root→child→root 的自愈路径）。
    sessions.set({
      current: "child-1",
      byId: {
        "root-1": { id: "root-1" },
        "child-1": { id: "child-1", parentId: "root-1" },
        "child-2": { id: "child-2", parentId: "root-1" },
      },
    });
    drainTimers(timers);
    assert.deepEqual(opened(), ["child-1", "child-2", "child-1"]);
    return release;
  });

  dispose();
  assert.equal(calls.disposed, 1);
});

test("betterSidebar：没有 root 解析器时也只为当前 child 打开（不再依赖 root 集合）", () => {
  withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const opens = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { opens.push({ seed, scope }); },
      },
      sessions,
    };
    // 不注入 resolveRootSessionId：目标只看 sessions.current，不依赖 root 集合上溯。
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions });
    drainTimers(timers);
    assert.deepEqual(opens.map((call) => call.scope.sessionId), ["child-1"]);
    dispose();
  });
});

test("native：current 是 child 时 global openTab 只服务该 child surface，root 走按会话回退", () => {
  const sessions = childSessionsFixture();
  const calls = { global: [], legacy: [] };
  const ctx = {
    sessions,
    sidebarRightTabs: { register() { return () => {}; } },
    sidebarRight: {
      openTab(kind, options) { calls.global.push({ kind, options }); },
      openTabIn(sessionId, kind, options) { calls.legacy.push({ sessionId, kind, options }); },
    },
    slots: { register() { return () => {}; } },
  };
  const dispose = withDeferredTimers((timers) => {
    const release = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    drainTimers(timers);
    // child-1 就是当前会话：global 画在它身上是对的。
    assert.deepEqual(calls.global, [{ kind: "expert-group", options: { revealIfOpened: true } }]);
    // root-1 是非当前目标：绝不预发（旧 API 对未挂载会话会静默 no-op）。
    assert.deepEqual(calls.legacy, []);

    // 切回 root-1：新访问，这次轮到它（公开接口优先，同样不借用 global 去画 child）。
    sessions.set({
      current: "root-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    drainTimers(timers);
    assert.equal(calls.global.length, 2);
    assert.deepEqual(calls.legacy, []);
    return release;
  });
  dispose();
});

test("native：current 是 child 时按 surface 逐会话定位，root 与 child 各打开一次且不借用 global", () => {
  const sessions = childSessionsFixture();
  const calls = { scoped: [], global: [] };
  const ctx = {
    sessions,
    sidebarRightTabs: { register() { return () => {}; } },
    sidebarRight: { openTab(kind, options) { calls.global.push({ kind, options }); } },
    slots: { register() { return () => {}; } },
  };
  const dispose = withDeferredTimers((timers) => {
    const release = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: rootIdOf,
      // 本项目契约：按会话解析出作用域内的 sidebarRight，openTab 收到的就是该 surface 会话。
      sidebarRightForSession: (target) => ({ openTab: (kind, options) => calls.scoped.push({ target, kind, options }) }),
    });
    drainTimers(timers);
    assert.deepEqual(calls.scoped.map((call) => call.target), ["child-1"]);
    assert.deepEqual(calls.global, []);

    // 切到新 child：新访问，只服务当时可见的 child-2。
    sessions.set({
      current: "child-2",
      byId: {
        "root-1": { id: "root-1" },
        "child-1": { id: "child-1", parentId: "root-1" },
        "child-2": { id: "child-2", parentId: "root-1" },
      },
    });
    drainTimers(timers);
    assert.deepEqual(calls.scoped.map((call) => call.target), ["child-1", "child-2"]);
    return release;
  });
  dispose();
});

test("没有自动打开目标时不写宽度，hydration 后出现目标才写", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    let snapshot = {};
    const listeners = new Set();
    const sessions = {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      },
      set(next) {
        snapshot = next;
        for (const listener of listeners) listener();
      },
    };
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    assert.deepEqual(events, []);

    // hydration 完成后首次出现当前会话，才写入它的 20%；打开请求本身仍在 deferred 里。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" } } });
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a"]);
    dispose();
  }));
});

test("betterSidebar：每个 surface 会话独立恢复 20% 宽度，重复通知不重写", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 1600 × 20% = 320：写入在同步栈里、早于任何打开请求，并且当前会话 root-a 只写一次。
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a"]);

    // 同一会话的重复通知（含新增 root-b/root-c 的目录变更）不得再写宽度：宿主里的这个值
    // 此时可能已经是用户拖拽或宿主自己算出来的结果。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" }, "root-c": { id: "root-c" } } });
    assert.deepEqual(events, ["width:320", "open:root-a"], "同一会话的重复通知不得改写宽度");
    // 切到 root-c 是**另一个 surface 会话**：它有自己的记账，必须写入它自己的 20%——
    // root-a 的那次写入绝不能把 root-c 标记成「已应用」（这正是按会话记账要修的行为）。
    sessions.set({ current: "root-c", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "width:320", "open:root-c"]);

    // 再切回 root-a：宿主 setRightbar 是全局 store，因此必须重放 root-a 自己的 20%；
    // 这不是同一 surface 的重复通知，而是一次新的会话激活边沿。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "width:320", "open:root-c", "width:320", "open:root-a"],
      "切回会话时重新应用该会话自己的固定宽度");
    dispose();
  }));
});

test("同一会话从其它右栏分页返回 Expert Group 时重新恢复 20% 宽度", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const state = { activeTab: { id: "tab-expert", kind: "expert-group" } };
    const sidebarRight = {
      active: () => state.activeTab,
      openTab(kind, options) { events.push("open:" + kind); },
    };
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight,
      slots: { register() { return () => {}; } },
      layout: layoutFixture(events),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
    });
    assert.deepEqual(events, ["width:320"], "首次进入 Expert Group 先写入 20%");
    drainTimers(timers);

    // 同一 session 切到其它右栏分页：总右栏预置为 50%，手柄恢复可调。
    state.activeTab = { id: "tab-session", kind: "session" };
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" } } });
    assert.deepEqual(events.slice(-1), ["width:800"], "其它页面活跃时总右栏必须预置为 50%");
    const writesBeforeOtherRepeat = events.filter((event) => event === "width:800").length;
    events.push("host-width:640"); // 模拟用户在可调分页把宿主全局右栏宽度拖到 640px。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" } } });
    assert.equal(
      events.filter((event) => event === "width:800").length,
      writesBeforeOtherRepeat,
      "其它页面保持活跃时不得覆盖用户已经拖出的总宽度",
    );

    // 返回 Expert Group：同一 session 也必须重新写回 20%，不能被旧 Map 记账跳过。
    state.activeTab = { id: "tab-expert", kind: "expert-group" };
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" } } });
    assert.equal(
      events.filter((event) => event === "width:320").length,
      2,
      "从其它分页返回时必须恢复固定 20%",
    );
    assert.deepEqual(events.slice(-2), ["host-width:640", "width:320"]);
    dispose();
  }));
});

test("窄窗口按精确 20% 写入：不再叠加 300px 最小值 clamp，落值交给宿主自己的 clamp", () => {
  withViewportWidth(1000, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 1000 × 20% = 200：插件只表达精确比例，不做最小值 clamp（宿主 setRightbar 自己会把它夹到自己的范围内）。
    assert.deepEqual(events, ["width:200"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:200", "open:root-a"]);
    dispose();
  }));
});

test("跨 pane：Expert Group active 但存在其它右栏页时总宽度为 50% 且手柄可调", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const events = [];
    const handle = elementStub({ events: [] }, "handle:");
    const dom = documentStub(null, null, null, { handle });
    const restoreGlobals = installGlobals({ document: dom });
    const sessions = sessionsFixture();
    const sidebarRight = crossPaneSidebarRightFixture({
      activeTab: { id: "pane-1-expert", kind: "expert-group" },
      tabs: [
        { sessionId: "root-a", tabId: "pane-1-expert", kind: "expert-group", contentId: "dsh://page/dsh-expert-group" },
        { sessionId: "root-a", tabId: "pane-2-chat", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/child-a" },
      ],
    });
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight,
      slots: { register() { return () => {}; } },
      layout: { panels: { setRightbar(px) { events.push("width:" + px); } } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
    });
    try {
      assert.deepEqual(events, ["width:800"], "跨 pane 的其它页面存在时不得先写入 Expert Group 的 20%");
      assert.equal(handle.inline.size, 0, "存在其它右栏页时总右栏必须保持可拖拽");
      drainTimers(timers);
      assert.equal(handle.inline.size, 0, "deferred 打开完成后仍不得锁总右栏");
    } finally {
      dispose();
      restoreGlobals();
    }
  }));
});

test("native 路径同样按会话写入 20% 宽度，且只为当前会话打开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight: {
        openTab(kind, options) { events.push("global"); },
        openTabIn(sessionId, kind, options) { events.push("legacy:" + sessionId); },
      },
      slots: { register() { return () => {}; } },
      layout: layoutFixture(events),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 顺序不变：先在同步栈写入当前会话的 20% 宽度，打开请求 defer 到宏任务；公开接口可用时不回退旧 API。
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "global"]);

    // 后续通知换成 root-c：新的一次访问只服务当时可见会话，并为这个新 surface 会话写它自己的 20%。
    sessions.set({ current: "root-c", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "global", "width:320", "global"]);
    dispose();
  }));
});

test("宿主没有 layout 兼容 action 时不写宽度，打开契约照常", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 三种「没有兼容 action」的宿主形态：无 layout 服务、panels 缺失 setRightbar、
    // 服务代理读取属性即抛错（Cordis 对未声明服务的行为）。
    const shapes = [undefined, {}, { panels: {} }, { get panels() { throw new Error("未声明的服务属性"); } }];
    for (const shape of shapes) {
      const sessions = sessionsFixture();
      const opens = [];
      const ctx = {
        betterSidebar: {
          registerTab() { return () => {}; },
          isTabEnabled: () => true,
          openTab(seed, scope) { opens.push(scope.sessionId); },
        },
        sessions,
        ...(shape === undefined ? {} : { layout: shape }),
      };
      const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
      drainTimers(timers);
      assert.deepEqual(opens, ["root-a"]);
      dispose();
    }
  }));
});

test("setRightbar 抛错时安全忽略：不影响右栏打开契约", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const calls = { attempts: 0, opens: [] };
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { calls.opens.push(scope.sessionId); },
      },
      sessions,
      layout: { panels: { setRightbar() { calls.attempts += 1; throw new Error("store 已销毁"); } } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 兼容桥失败不能让自动打开失败：当前会话仍照常打开。
    drainTimers(timers);
    assert.deepEqual(calls.opens, ["root-a"]);
    assert.ok(calls.attempts >= 1);

    // 失败不算写入成功，因此不标记；后续通知仍能打开新会话，宿主默认宽度继续生效。
    sessions.set({ current: "root-c", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" }, "root-c": { id: "root-c" } } });
    drainTimers(timers);
    assert.deepEqual(calls.opens, ["root-a", "root-c"]);
    dispose();
  }));
});

test("betterSidebar：页面打开后只在 deferred 回调里展开右栏一次，同步栈内不展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 同步栈内只有宽度写入：打开与展开都必须延后到宿主完成本次提交（surface/seat 就位），
    // 否则打开会落到旧 binding、展开会被 RightbarSeat 的
    // syncPresentation({ shown: false }) → layout.closeRightbar() 反手关掉。
    assert.deepEqual(events, ["width:320"]);
    assert.deepEqual(rightbarOpens(events), [], "同一同步栈内不得展开右栏");

    // 推进调度：先为当前会话打开页面，再调用 ctx.layout.openRightbar(true, false)。
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false"]);
    assert.equal(events.at(-1), "rightbar:true:false", "展开必须发生在页面打开之后");
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"], "每次访问只允许主动展开一次");

    // 同一份快照（current 不变 = 同一次访问）再次广播：绝不重新排队、也绝不重新展开——
    // 这段时间里用户完全可能已经手动把右栏关掉了，插件不得覆盖这个显式操作。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    assert.equal(timers.size(), 0, "已消费机会的会话不再排队");
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false"]);
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"]);
    dispose();
  }));
});

test("native：current 是 child 时按 surface 打开页面，deferred 里为 child 展开一次", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const events = [];
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight: { openTab() { events.push("global"); } },
      slots: { register() { return () => {}; } },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: rootIdOf,
      // 按 surface 解析出的 sidebarRight：openTab 收到的会话就是该 surface。
      sidebarRightForSession: (target) => ({ openTab() { events.push("scoped:" + target); } }),
    });
    // 当前会话是 child-1：只为它打开；root-1 是后台目标不预发；展开仍只在 deferred 回调里。
    assert.deepEqual(events, ["width:320"]);
    assert.deepEqual(rightbarOpens(events), [], "native 路径同样不在同步栈内展开");
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "scoped:child-1", "rightbar:true:false"]);
    assert.equal(events.at(-1), "rightbar:true:false", "展开只能跟在页面打开之后");

    // 同一份快照再次广播：同一次访问的机会已消费，不再排队也不再展开。
    sessions.set({
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    assert.equal(timers.size(), 0);
    drainTimers(timers);
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"]);
    dispose();
  }));
});

test("没有自动打开目标时不排队展开，hydration 后按「宽度写入 → 打开 → deferred 展开」补上", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    let snapshot = {};
    const listeners = new Set();
    const sessions = {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      },
      set(next) {
        snapshot = next;
        for (const listener of listeners) listener();
      },
    };
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // hydration 尚未产生可打开 surface：既不写宽度、也不排队展开（DEG 什么都不开）。
    assert.deepEqual(events, []);
    assert.equal(timers.size(), 0, "没有目标时连 deferred 任务都不该排队");

    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" } } });
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false"]);
    dispose();
  }));
});

test("betterSidebar 禁用 expert-group 时既不写宽度、也不排队展开右栏", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      sessions,
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => false,
        openTab() { events.push("open"); },
      },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    // 展开与宽度写入都必须发生在「存在目标且 Better 未禁用」之后：禁用时一个动作都不发。
    assert.deepEqual(events, []);
    assert.equal(timers.size(), 0, "Better 禁用时不得排队展开");
    timers.flush();
    assert.deepEqual(rightbarOpens(events), []);
    dispose();
  }));
});

test("注入的 config.layout 优先于可选服务，并以 layout 为接收者调用公开 openRightbar", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const layout = {
      panels: { setRightbar(px) { events.push("width:" + px); } },
      openRightbar(track, fullscreen) { events.push("rightbar:" + track + ":" + fullscreen + ":" + String(this === layout)); },
    };
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      // ctx 上另有一个同名服务：注入的 config.layout 必须优先，宽度与展开都只能走它。
      layout: { openRightbar() { events.push("ctx-rightbar"); } },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, layout, resolveRootSessionId: (id) => id });
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    // 事件尾部的 true 是接收者断言：宿主动作必须以 layout 为 this 调用，且排在页面打开之后。
    assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false:true"]);
    dispose();
  }));
});

test("展开右栏的服务缺失或抛错都不阻塞页面打开，服务稍后可用时仍会展开一次", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 五种宿主形态：无 layout 服务、没有 openRightbar、openRightbar 不是函数、
    // 服务代理读取属性即抛错（Cordis 对未声明服务的行为）、调用本身抛错。
    const shapes = [
      ["没有 layout 服务", undefined],
      ["没有 openRightbar action", {}],
      ["openRightbar 不是函数", { openRightbar: "not-a-function" }],
      ["读取属性即抛错", { get openRightbar() { throw new Error("未声明的服务属性"); } }],
      ["调用 openRightbar 抛错", { openRightbar() { throw new Error("layout store 已销毁"); } }],
    ];
    for (const [label, shape] of shapes) {
      const sessions = sessionsFixture();
      const opens = [];
      const ctx = {
        betterSidebar: {
          registerTab() { return () => {}; },
          isTabEnabled: () => true,
          openTab(seed, scope) { opens.push(scope.sessionId); },
        },
        sessions,
        ...(shape === undefined ? {} : { layout: shape }),
      };
      const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
      drainTimers(timers);
      assert.deepEqual(opens, ["root-a"], label + "：右栏展开失败不得影响 Expert Group 页面打开");
      // 展开失败同样不得抛出到调用方，页面打开的既成事实不变。
      assert.deepEqual(opens, ["root-a"], label + "：deferred 展开失败同样不得影响页面打开");
      dispose();
      // dispose 必须把「调用抛错后排队的重试」也一并取消，不能留下泄漏的 timer。
      assert.equal(timers.size(), 0, label + "：dispose 后不得残留 deferred timer");
    }

    // 「宿主这一层根本没有 openRightbar」不消耗机会：同一次 install 生命周期内宿主稍后提供
    // 该 action 时，下一次会话通知仍会把这次展开补上（且不会留下没人消费的定时器）。
    let layout = null;
    const events = [];
    const sessions = sessionsFixture();
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      get: (name) => (name === "layout" ? layout : undefined),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    drainTimers(timers);
    assert.deepEqual(events, ["open:root-a"]);
    assert.deepEqual(rightbarOpens(events), [], "宿主没有该 action 时不展开");
    assert.equal(timers.size(), 0, "没有 openRightbar 时不排自动重试，避免留下没人消费的定时器");

    layout = { openRightbar(track, fullscreen) { events.push("rightbar:" + track + ":" + fullscreen); } };
    // 同一份快照再次广播即可：本次访问的页面早已落地，只是当时宿主没有该 action；服务可用后
    // 仍会把这次展开补上（访问内展开机会尚未消费）。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    drainTimers(timers);
    assert.deepEqual(events, ["open:root-a", "rightbar:true:false"]);
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"]);
    dispose();
  }));
});

test("没有任何页面成功发起打开时不排队展开，宿主就绪后成功打开才补上", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // native：宿主暂时没有按会话定位的接口，openNativeTab 对每个目标都返回 false。
    const nativeSidebar = {};
    const nativeSessions = sessionsFixture();
    const nativeEvents = [];
    const nativeCtx = {
      sessions: nativeSessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight: nativeSidebar,
      slots: { register() { return () => {}; } },
      layout: layoutFixture(nativeEvents, { openRightbar: true }),
    };
    const disposeNative = sidebar.installExpertGroupSidebar(nativeCtx, {
      react, primitives, sessions: nativeSessions, resolveRootSessionId: (id) => id,
    });
    // 宽度写入与「有没有打开页面」无关；但一个页面都没打开时绝不排队展开（否则会拉开空右栏）。
    drainTimers(timers);
    assert.deepEqual(nativeEvents, ["width:320"]);
    assert.deepEqual(rightbarOpens(nativeEvents), []);
    assert.equal(timers.size(), 0, "页面没落地时不排队展开");

    // 宿主就绪后再次通知：当前会话这次成功发起打开，才轮到异步展开。
    nativeSidebar.openTab = (kind, options) => { nativeEvents.push("global"); };
    nativeSessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    drainTimers(timers);
    assert.deepEqual(nativeEvents, ["width:320", "global", "rightbar:true:false"]);
    assert.equal(nativeEvents.at(-1), "rightbar:true:false", "展开只能跟在成功打开之后");
    disposeNative();

    // Better：openTab 每次抛错（页面没有真正发起打开），同样不排队、不展开。
    const betterSessions = sessionsFixture();
    const betterEvents = [];
    const betterCtx = {
      sessions: betterSessions,
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab() { throw new Error("tab host 尚未就绪"); },
      },
      layout: layoutFixture(betterEvents, { openRightbar: true }),
    };
    const disposeBetter = sidebar.installExpertGroupSidebar(betterCtx, {
      react, primitives, sessions: betterSessions, resolveRootSessionId: (id) => id,
    });
    drainTimers(timers);
    // 打开调用始终抛错：绝不算已落地、绝不展开，且重试次数有界（不会无限重排 timer）。
    assert.deepEqual(betterEvents.filter((event) => event.startsWith("open:")), []);
    assert.deepEqual(rightbarOpens(betterEvents), []);
    assert.equal(timers.size(), 0, "失败重试用尽后不再排队");
    disposeBetter();
  }));
});

test("右栏展示生命周期：current root 与点进去的 child 之间切换只切页面内容，不重复展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const events = [];
    const betterStateListeners = new Set();
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
        // 真实的 Better 设置通知：状态变化会再次触发 openTargets。
        subscribeState(listener) { betterStateListeners.add(listener); return () => betterStateListeners.delete(listener); },
      },
      sessions,
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });

    // 初始：current 是 root-a，root-b 只是后台 root。只为当前会话请求 + 展开。
    assert.deepEqual(events, ["width:320"]);
    drainTimers(timers);
    assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false"]);

    // Better 状态通知（例如设置面板关闭）不得为同一次访问再次排队：用户此时完全可能已经
    // 手动关掉了右栏，插件不能把它重新拉开。
    for (const listener of [...betterStateListeners]) listener();
    assert.equal(timers.size(), 0, "同一次访问不再排队");
    drainTimers(timers);
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"]);

    // 从 Expert Group 页面点进子代理会话：current 变成 child-1。child 是独立 surface，页面内容
    // 必须切过去（先打开它的页面），但右栏这份**全局**展示已经展开过，绝不再调
    // layout.openRightbar——重复展开正是切换子代理时右栏闪烁的来源。
    sessions.set({
      current: "child-1",
      byId: { "root-a": { id: "root-a" }, "child-1": { id: "child-1", parentId: "root-a" } },
    });
    // 切到 child-1：新的一次访问，只为它打开页面（切内容），并写入 child-1 自己的 20% 宽度
    // （1600 × 20% = 320，与 root-a 那次同值；两个 surface 会话各自记账）。
    drainTimers(timers);
    assert.deepEqual(events, [
      "width:320", "open:root-a", "rightbar:true:false", "width:320", "open:child-1",
    ]);
    assert.equal(rightbarOpens(events).length, 1, "右栏不再重复展开：切换 surface 只切换页面内容");

    // 切回 root-a：又是一次新访问 → 重新确保页面（右栏展示生命周期没结束，不重复展开）。
    sessions.set({
      current: "root-a",
      byId: { "root-a": { id: "root-a" }, "child-1": { id: "child-1", parentId: "root-a" } },
    });
    drainTimers(timers);
    assert.deepEqual(events, [
      // 切回 root-a 时重放该 surface 自己的 20%；右栏展示生命周期仍未结束，所以只恢复宽度、不重复展开。
      "width:320", "open:root-a", "rightbar:true:false", "width:320", "open:child-1", "width:320", "open:root-a",
    ]);
    assert.equal(rightbarOpens(events).length, 1, "切回 root-a 只重新确保页面");
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

test("deferred 展开的清理与错误边界：dispose 取消 timer，调度/调用抛错都不外泄", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 1) 已排队但未执行：dispose 必须 clearTimeout 掉它，回调不得再碰宿主 layout。
    const sessions = sessionsFixture();
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    assert.deepEqual(events, ["width:320"]);
    assert.ok(timers.size() >= 1, "打开请求已在排队");
    dispose();
    assert.equal(timers.size(), 0, "dispose 必须 clearTimeout 掉未执行的 deferred 任务");
    timers.flush();
    assert.deepEqual(events, ["width:320"], "dispose 后 deferred 回调不得执行");
    dispose(); // 幂等：重复 dispose 不得抛错

    // 2) 调度器本身抛错（宿主环境没有可用定时器）：安装与页面打开照常，异常不外泄。
    timers.failScheduling(true);
    const failingSessions = sessionsFixture();
    const failingEvents = [];
    const failingCtx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { failingEvents.push("open:" + scope.sessionId); },
      },
      sessions: failingSessions,
      layout: layoutFixture(failingEvents, { openRightbar: true }),
    };
    const disposeFailing = sidebar.installExpertGroupSidebar(failingCtx, {
      react, primitives, sessions: failingSessions, resolveRootSessionId: (id) => id,
    });
    assert.deepEqual(failingEvents, ["width:320"], "调度失败时宽度写入照常，且不外泄异常");
    assert.equal(timers.size(), 0, "没有可用调度器时不排队");
    assert.deepEqual(rightbarOpens(failingEvents), [], "调度失败只放弃自动打开/展开");
    disposeFailing();
    timers.failScheduling(false);

    // 3) 调用抛错：有限重试（每个 surface 最多 3 次尝试），用尽后不再排队新的 timer。
    const retrySessions = sessionsFixture();
    const retryEvents = [];
    const retryCtx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { retryEvents.push("open:" + scope.sessionId); },
      },
      sessions: retrySessions,
      layout: {
        panels: { setRightbar(px) { retryEvents.push("width:" + px); } },
        // 事件名以 "rightbar:" 开头，便于用 rightbarOpens 统一统计调用次数。
        openRightbar() { retryEvents.push("rightbar:attempt"); throw new Error("layout store 已销毁"); },
      },
    };
    const disposeRetry = sidebar.installExpertGroupSidebar(retryCtx, {
      react, primitives, sessions: retrySessions, resolveRootSessionId: (id) => id,
    });
    // 展开调用每次都抛错：异常不得外泄，尝试次数有上限，且绝不无限重排 timer。
    drainTimers(timers, 8);
    assert.deepEqual(retryEvents, [
      "width:320", "open:root-a", "rightbar:attempt", "rightbar:attempt", "rightbar:attempt",
    ], "打开先落地；展开调用最多 3 次尝试");
    assert.equal(timers.size(), 0, "尝试上限用尽后不再排重试");
    disposeRetry();
  }));
});

test("root→child→root 往返：每一段新访问都重新确保页面，右栏已展开过就不重复展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 只含 root-a 的最小会话替身：初始 current = root-a，稍后切到 child-1。
    let snapshot = { current: "root-a", byId: { "root-a": { id: "root-a" } } };
    const listeners = new Set();
    const sessions = {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      },
      open() {},
      set(next) { snapshot = next; for (const listener of listeners) listener(); },
    };
    const better = readyBetterFixture({ active: "root-a" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const withCurrent = (current) => ({
      current,
      byId: { "root-a": { id: "root-a" }, "child-1": { id: "child-1", parentId: "root-a" } },
    });

    // 第一段 root-a：宿主已提交 → 打开一次 + 展开一次。
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["root-a"]);
    assert.deepEqual(better.landed(), ["root-a"]);
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"]);

    // 点进子代理会话：sessions.current 先切换，宿主 binding 还没提交 → 绝不发请求。
    sessions.set(withCurrent("child-1"));
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["root-a"], "宿主未提交前不发请求（避免落到旧 binding）");
    assert.equal(rightbarOpens(events).length, 1, "页面没落地就不可能展开");

    // 宿主提交 child-1：这才真正为 child 打开页面（切内容），右栏已展开过所以不再重复展开。
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["root-a", "child-1"]);
    assert.deepEqual(better.landed(), ["root-a", "child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "child 页面自动打开，但右栏不重复展开（无闪烁）");

    // 切回 root-a（宿主机提交）：新的一次访问 → 重新确保 root 的页面（右栏展示生命周期未结束）。
    sessions.set(withCurrent("root-a"));
    better.commitSession("root-a");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["root-a", "child-1", "root-a"]);
    assert.equal(rightbarOpens(events).length, 1, "回到 root 只重新确保页面");

    // 再回到 child-1：同样重新确保页面，往返不留残留 timer，也不累积任何右栏调用。
    sessions.set(withCurrent("child-1"));
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["root-a", "child-1", "root-a", "child-1"]);
    assert.equal(rightbarOpens(events).length, 1);
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

test("同一 sessionId 的 surface 重挂载：宿主重新提交该会话后重新确保页面（读面无「明确缺失」证据时不重复展开）", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // current 与宿主已提交的活跃会话都是 child-1。
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const sameSnapshot = {
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    };
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1);

    // 重复通知：同一次访问绝不重复打开/展开（用户此时可能已手动关闭右栏）。
    better.notify();
    sessions.set(sameSnapshot);
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1);

    // surface 重挂载：宿主先清空活跃会话、再重新提交同一个 sessionId（公开 API 能观察到的边界）。
    better.commitSession(null);
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1", "child-1"], "重挂载后重新确保页面");
    // 这个替身没有 active tab 读面（旧 Better），证据只能是 unknown：无法区分「surface 被卸掉」
    // 与「用户手动关掉右栏」，一律保持已展示语义，绝不重新拉开右栏。
    assert.equal(rightbarOpens(events).length, 1, "无「明确缺失」证据时不重复展开");
    assert.equal(timers.size(), 0, "重挂载处理完不留残留 timer");
    dispose();
  }));
});

test("宿主没有就绪证据（旧 Better/native）：只为当前会话打开，切走再切回重新确保页面", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 老版本 Better / native 路径：没有 getSnapshot 证据 → 无法等待宿主提交，只能按
    // sessions.current 的兼容语义打开，但绝不预发后台目标、也绝不重复重发。
    const sessions = childSessionsFixture();
    const opens = [];
    const events = [];
    const ctx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { opens.push(scope.sessionId); },
      },
      sessions,
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    drainTimers(timers);
    assert.deepEqual(opens, ["child-1"], "只为当前会话打开；后台 root-1 不预发");
    assert.equal(rightbarOpens(events).length, 1, "当前会话 child-1 展开一次（首次没有右栏）");

    // 同一会话的重复通知：不重复打开、不重复展开。
    const snapshot = { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } };
    sessions.set({ current: "child-1", byId: snapshot });
    drainTimers(timers);
    assert.deepEqual(opens, ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1);

    // 切到 root-1 再切回 child-1：两次都是新访问 → 各重新确保页面（无证据时不等待宿主提交）；
    // 右栏读取不到 active tab，无法证明它真的没了，因此这份展示已经展开过就不再重复展开。
    sessions.set({ current: "root-1", byId: snapshot });
    drainTimers(timers);
    assert.deepEqual(opens, ["child-1", "root-1"]);
    assert.equal(rightbarOpens(events).length, 1, "无明确缺失证据：不重复展开");
    sessions.set({ current: "child-1", byId: snapshot });
    drainTimers(timers);
    assert.deepEqual(opens, ["child-1", "root-1", "child-1"]);
    assert.equal(rightbarOpens(events).length, 1);

    // 新访问排队后 dispose：未执行的 deferred 任务必须被清掉。
    sessions.set({
      current: "child-2",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" }, "child-2": { id: "child-2", parentId: "root-1" } },
    });
    assert.ok(timers.size() >= 1, "新访问会排队任务");
    dispose();
    assert.equal(timers.size(), 0, "dispose 必须清理未执行的 deferred 任务");
    drainTimers(timers);
    assert.equal(rightbarOpens(events).length, 1, "dispose 后回调不得再执行");
  }));
});

test("打开调用失败不标记成功：定时重试有界、通知可补、用尽后停止且不展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 宿主已提交到 child-1，因此失败与「等提交」无关，就是调用本身失败。
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    assert.deepEqual(better.requested(), [], "同步栈里不发请求");
    assert.equal(better.failedAttempts(), 0);

    // 第一次调用抛错：不算落地，排一次定时重试；期间绝不展开。
    better.failNextOpens(1);
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), ["child-1", "child-1"], "首次 + 一次定时重试");
    assert.equal(better.failedAttempts(), 1);
    assert.deepEqual(better.landed(), ["child-1"], "第二次尝试才落地");
    assert.equal(rightbarOpens(events).length, 1, "落地后展开一次");

    // 同一次访问的后续通知：既不重复打开也不重复展开。
    better.notify();
    sessions.set({
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    drainTimers(timers, 6);
    assert.equal(better.requested().length, 2);
    assert.equal(rightbarOpens(events).length, 1);
    dispose();

    // 失败到底：三次尝试（首次 + 定时重试 + 通知补一次）用尽后必须停下，永不落地、绝不展开。
    const stuckSessions = childSessionsFixture();
    const stuckBetter = readyBetterFixture({ active: "child-1" });
    const stuckEvents = [];
    const stuckCtx = { betterSidebar: stuckBetter, sessions: stuckSessions, layout: layoutFixture(stuckEvents, { openRightbar: true }) };
    const disposeStuck = sidebar.installExpertGroupSidebar(stuckCtx, {
      react, primitives, sessions: stuckSessions, resolveRootSessionId: rootIdOf,
    });
    stuckBetter.failNextOpens(10);
    drainTimers(timers, 8);
    assert.equal(stuckBetter.requested().length, 2, "首次 + 一次定时重试");
    assert.equal(timers.size(), 0, "定时重试次数用尽后不再自我重排");
    stuckBetter.notify();
    drainTimers(timers, 8);
    assert.equal(stuckBetter.requested().length, 3, "通知给最后一次机会");
    stuckBetter.notify();
    drainTimers(timers, 8);
    assert.equal(stuckBetter.requested().length, 3, "总次数到上限后不再重试");
    assert.deepEqual(stuckBetter.landed(), [], "始终失败：永不落地");
    assert.deepEqual(rightbarOpens(stuckEvents), [], "页面没落地就不展开");
    assert.equal(timers.size(), 0);
    disposeStuck();
  }));
});

test("就绪边界：getSnapshot 抛错、通知先到都不抛错且不产生无限 timer，dispose 清理全部 timer", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 1) getSnapshot 抛错 → 按「无证据」处理：保持既有 deferred 展开语义，异常不外泄。
    const throwingSessions = childSessionsFixture();
    const throwingEvents = [];
    const throwingCtx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { throwingEvents.push("open:" + scope.sessionId); },
        getSnapshot() { throw new Error("宿主状态暂不可读"); },
      },
      sessions: throwingSessions,
      layout: layoutFixture(throwingEvents, { openRightbar: true }),
    };
    const disposeThrowing = sidebar.installExpertGroupSidebar(throwingCtx, {
      react, primitives, sessions: throwingSessions, resolveRootSessionId: rootIdOf,
    });
    drainTimers(timers);
    assert.deepEqual(throwingEvents, ["width:320", "open:child-1", "rightbar:true:false"], "读不到证据时按兼容语义打开并展开");
    disposeThrowing();
    assert.equal(timers.size(), 0);

    // 1b) getSnapshot 属性读取本身抛错（Cordis 服务代理对未声明属性会抛）→ 同样按无证据处理，
    //     绝不把异常抛给通知回调，也不产生无限重试。
    const getterSessions = childSessionsFixture();
    const getterEvents = [];
    const getterCtx = {
      betterSidebar: {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) { getterEvents.push("open:" + scope.sessionId); },
        get getSnapshot() { throw new Error("未声明的服务属性"); },
      },
      sessions: getterSessions,
      layout: layoutFixture(getterEvents, { openRightbar: true }),
    };
    const disposeGetter = sidebar.installExpertGroupSidebar(getterCtx, {
      react, primitives, sessions: getterSessions, resolveRootSessionId: rootIdOf,
    });
    const getterRounds = drainTimers(timers);
    assert.ok(getterRounds <= 3, "属性读取抛错时不得反复重排 timer");
    assert.deepEqual(getterEvents, ["width:320", "open:child-1", "rightbar:true:false"], "属性读取抛错按无证据处理");
    assert.equal(timers.size(), 0);
    disposeGetter();

    // 2) 通知先到、snapshot 还没更新：只等待（不碰 layout），且等待次数有上限。
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "root-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    better.notify(); // 宿主先通知，snapshot 仍是 root-1
    const waitingRounds = drainTimers(timers);
    assert.ok(waitingRounds <= 4, "等提交重试有界");
    assert.deepEqual(better.requested(), [], "宿主未提交前绝不发请求");
    assert.deepEqual(rightbarOpens(events), [], "snapshot 未更新前绝不调用 layout.openRightbar");
    assert.equal(timers.size(), 0, "不会留下无限 timer");

    // 3) snapshot 追上通知后照常打开 + 展开；dispose 清理所有 timer。
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.landed(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "提交后补上展开");
    dispose();

    // 4) 打开重试排队后 dispose：打开与展开两类 timer 一并清理，回调不再执行。
    const pendingSessions = childSessionsFixture();
    const pendingBetter = readyBetterFixture({ active: "child-1" });
    const pendingEvents = [];
    const pendingCtx = { betterSidebar: pendingBetter, sessions: pendingSessions, layout: layoutFixture(pendingEvents, { openRightbar: true }) };
    const disposePending = sidebar.installExpertGroupSidebar(pendingCtx, {
      react, primitives, sessions: pendingSessions, resolveRootSessionId: rootIdOf,
    });
    pendingBetter.failNextOpens(10);
    timers.flush();                            // 首次尝试失败 → 排 250ms 定时重试（此时不展开）
    assert.deepEqual(timers.delays(), [250], "只剩打开重试 timer");
    disposePending();
    assert.equal(timers.size(), 0, "dispose 必须清掉打开重试 timer");
    drainTimers(timers);
    assert.deepEqual(rightbarOpens(pendingEvents), [], "dispose 后不得再执行任何 deferred 任务");
  }));
});

test("未就绪时重复通知不重置等待预算：timer 链有界且无残留", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "root-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });

    // 通知风暴：sessions 重复快照 + Better 重复广播，期间不推进任何定时器。
    const sameSnapshot = {
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    };
    for (let round = 0; round < 8; round += 1) {
      better.notify();
      sessions.set(sameSnapshot);
      // 同一 surface 同时只允许一个待执行任务：重复通知不会堆出 timer 队列。
      assert.ok(timers.size() <= 1, "同一 surface 同时最多一个待执行任务");
    }

    // 推进等待链：等提交重试有上限，必须收敛（初次 + MAX_READINESS_RETRIES 次重试）。
    const rounds = drainTimers(timers, 12);
    assert.ok(rounds <= 4, "等提交重试链有界（初次 + 3 次重试）");
    assert.equal(timers.size(), 0, "预算用尽后没有残留 timer");
    assert.deepEqual(better.requested(), [], "宿主未提交前绝不发请求");
    assert.deepEqual(rightbarOpens(events), [], "未提交期间绝不调用 layout.openRightbar");

    // 预算用尽后继续广播：每次通知最多排一个 deferred 任务（宿主驱动、有界），推进后不再自我重排。
    for (let round = 0; round < 4; round += 1) {
      better.notify();
      sessions.set(sameSnapshot);
      assert.ok(timers.size() <= 1, "每次通知最多一个待执行任务");
      drainTimers(timers);
      assert.equal(timers.size(), 0, "推进后不再自我重排");
    }
    assert.deepEqual(better.requested(), [], "预算用尽后仍然不发请求");
    assert.deepEqual(rightbarOpens(events), [], "预算用尽后仍然不碰 layout");
    dispose();
    assert.equal(timers.size(), 0);
  }));
});

test("宿主提交后打开并展开；重复通知不重复，切走再切回只重新确保页面", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "root-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const withCurrent = (current) => ({
      current,
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });

    // 宿主还停在 root-1（child 未被提交）：不请求、不展开，等待链收敛。
    better.notify();
    drainTimers(timers);
    assert.deepEqual(better.requested(), []);
    assert.deepEqual(rightbarOpens(events), []);

    // 宿主提交 child-1：这才打开页面并展开一次。
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1"]);
    assert.deepEqual(better.landed(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "提交后展开一次");
    assert.equal(timers.size(), 0);

    // 同一份状态的重复通知：同一次访问，不重开也不重新展开（用户此时可能已手动关闭右栏）。
    better.notify();
    sessions.set(withCurrent("child-1"));
    drainTimers(timers);
    assert.equal(rightbarOpens(events).length, 1);
    assert.deepEqual(better.requested(), ["child-1"]);

    // 切到 root-1 并等宿主提交：新访问 → 打开 root-1 的页面（右栏已展开过，不重复展开）。
    sessions.set(withCurrent("root-1"));
    better.commitSession("root-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1", "root-1"]);
    assert.equal(rightbarOpens(events).length, 1, "右栏不重复展开");

    // 切回 child-1 并提交：又是一次新访问 → 重新确保页面（这是「切回后必须刷新」的修复点）。
    sessions.set(withCurrent("child-1"));
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1", "root-1", "child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "切回 child 只重新确保页面，不重展开右栏");
    assert.equal(timers.size(), 0, "往返之后不留残留 timer");
    dispose();
  }));
});

test("打开失败重试在排队时通知不抢先，且每次通知不会堆出 timer 队列", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const sameSnapshot = {
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    };

    // 首次尝试失败 → 排一次 250ms 定时重试（此时绝不展开）。
    better.failNextOpens(10);
    timers.flush();
    assert.deepEqual(better.requested(), ["child-1"], "首次尝试已发出");
    assert.deepEqual(timers.delays(), [250], "失败后排一次定时重试");
    assert.equal(rightbarOpens(events).length, 0, "未落地不展开");

    // 重试在排队时：通知不得抢先发第二次请求，也不新增任务。
    for (let round = 0; round < 4; round += 1) {
      better.notify();
      sessions.set(sameSnapshot);
      assert.deepEqual(better.requested(), ["child-1"], "通知不抢先执行");
      assert.deepEqual(timers.delays(), [250], "仍只保留那一个待执行任务");
    }

    // 让定时重试自己执行：第二次失败（定时重试预算用尽）→ 不再自我重排。
    timers.flush();
    assert.deepEqual(better.requested(), ["child-1", "child-1"]);
    assert.equal(timers.size(), 0, "定时重试预算用尽后不再排队");
    assert.deepEqual(better.landed(), [], "始终失败：永不落地");
    assert.deepEqual(rightbarOpens(events), [], "页面没落地就不展开");

    // 后续通知给最后一次机会（总次数上限 3）；用尽后不再重试。
    better.notify();
    timers.flush();
    assert.equal(better.requested().length, 3);
    better.notify();
    timers.flush();
    assert.equal(better.requested().length, 3, "总次数到上限后不再重试");
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

test("stale binding 回归：宿主未提交 child 前，请求不得落到旧 root binding", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // child 已被 sessions 切成 current，但 Better 的活跃会话仍是 root-1——宿主 surface/binding
    // 尚未提交。真实宿主此时会把 scoped openTab 落到旧 binding 并静默丢弃。
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "root-1" });
    const events = [];
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });

    // 同步栈里不得发任何请求（落到旧 binding 的请求既没落地、又会被计成已完成）。
    assert.deepEqual(better.requested(), [], "宿主未提交前不得发 scoped openTab");

    // 推进 defer：仍然不得发请求，只在有限次「等宿主提交」重试里等待，且绝不展开。
    const rounds = drainTimers(timers, 8);
    assert.ok(rounds <= 5, "等宿主提交的重试必须有限");
    assert.deepEqual(better.requested(), [], "宿主未提交前绝不发请求（更不得计成已打开）");
    assert.deepEqual(rightbarOpens(events), [], "页面没落地就不可能展开");

    // 宿主提交：这一次请求才真正落到 child 的 surface 上，并在随后展开。
    better.commitSession("child-1");
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1"], "提交后只对 child 发一次真实请求");
    assert.deepEqual(better.landed(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "落地后展开一次");

    // 重复通知：同一访问内不重复请求、不重复展开。
    better.notify();
    drainTimers(timers);
    assert.deepEqual(better.requested(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1);
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

test("native 旧 openTabIn 静默 no-op：只为当前会话发请求，切回目标时用公开 openTab 收敛", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture(); // current = child-1
    const events = [];
    const calls = { legacy: [], global: [] };
    const sidebarRight = {
      // 旧 DSH：只有按会话的 openTabIn；未挂载会话会静默 no-op（返回值不可信）。
      openTabIn(sessionId) { calls.legacy.push(sessionId); },
    };
    const ctx = {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight,
      slots: { register() { return () => {}; } },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    drainTimers(timers);

    // 后台 root-1 绝不能被预发：它在旧 API 下静默 no-op，却会被永久记成「已打开」。
    assert.deepEqual(calls.legacy, ["child-1"], "只为当前可见会话走旧 API");
    assert.equal(rightbarOpens(events).length, 1, "当前会话落地后展开一次");

    // 宿主补上公开 openTab 后切回 root-1：这是一次新的访问，必须重新确保页面（切内容）。
    sidebarRight.openTab = (kind) => { calls.global.push(kind); };
    sessions.set({
      current: "root-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    drainTimers(timers);
    assert.deepEqual(calls.global, ["expert-group"], "切回目标时改走公开 openTab 收敛");
    // 旧 openTabIn 没有 active tab 读面：证据永远是 unknown，因此不重复展开（保守、尊重手动关闭）。
    assert.equal(rightbarOpens(events).length, 1, "无明确缺失证据时不重复展开");
    assert.equal(timers.size(), 0, "不得留下残留 timer");
    dispose();
  }));
});

test("提交确认：宿主 active tab 未落地时不得结算也不得展开，提交后才打开并展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();              // current = child-1
    const better = readyBetterFixture({ active: "child-1" }); // Better 已提交到 child-1
    // 宿主右栏真实的 active tab：null = surface 还没 mint / tab 还没提交（DSH SidebarRight 的
    // active() 就是读这个，未挂载时返回 undefined）。
    let activeTabKind = null;
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => (activeTabKind === null ? undefined : { id: "tab-1", kind: activeTabKind }) },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });

    // openTab 已发出，但宿主读面证明 tab 还没落地 → 绝不结算、绝不展开。
    drainTimers(timers, 4);
    assert.ok(better.requested().length >= 1, "打开请求已发出");
    assert.deepEqual(rightbarOpens(events), [], "tab 未落地时绝不调用 layout.openRightbar");
    assert.deepEqual(events.filter((event) => event.startsWith("rightbar:")), []);

    // 宿主把 expert-group 提交成 active：这次请求才算落地 → 展开。
    activeTabKind = "expert-group";
    better.notify();
    drainTimers(timers, 6);
    assert.equal(rightbarOpens(events).length, 1, "确认落地后才展开");
    assert.equal(timers.size(), 0);

    // 同一访问的后续普通通知：不重复打开、不重复展开。
    const requestsAfterCommit = better.requested().length;
    better.notify();
    sessions.set({
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    drainTimers(timers, 6);
    assert.equal(better.requested().length, requestsAfterCommit);
    assert.equal(rightbarOpens(events).length, 1);
    dispose();
  }));
});

test("同 sessionId 重挂载：已确认 → active 清空 → 重新提交后必须重新打开并展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    let activeTabKind = "expert-group";
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => (activeTabKind === null ? undefined : { id: "tab-1", kind: activeTabKind }) },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const sameSnapshot = {
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    };

    // 第一次访问：确认落地 + 展开一次。
    drainTimers(timers, 6);
    assert.equal(rightbarOpens(events).length, 1);
    const requestsAfterFirstVisit = better.requested().length;

    // 用户手动切到别的 tab：不是重挂载，也不得在普通通知里抢回用户的 tab。
    activeTabKind = "files";
    better.notify();
    sessions.set(sameSnapshot);
    drainTimers(timers, 6);
    assert.equal(better.requested().length, requestsAfterFirstVisit, "其它 kind 不触发新的打开请求");
    assert.equal(rightbarOpens(events).length, 1, "不得抢回用户已切走的 tab");

    // surface 重挂载：active 被清空（seat 卸载/布局重置）→ 同一 sessionId 也必须重新确保。
    activeTabKind = null;
    better.notify();
    drainTimers(timers, 6);

    // 宿主重新提交 active 后：重新打开 + 重新展开。
    activeTabKind = "expert-group";
    better.notify();
    drainTimers(timers, 6);
    assert.ok(better.requested().length > requestsAfterFirstVisit, "重挂载后重新打开页面");
    assert.equal(rightbarOpens(events).length, 2, "重挂载后重新展开");
    assert.equal(timers.size(), 0, "重挂载处理完不得留下残留 timer");

    // 持续 missing 不会每次通知都重置预算：反复通知后请求次数保持有界。
    const afterRemount = better.requested().length;
    activeTabKind = null;
    for (let round = 0; round < 4; round += 1) {
      better.notify();
      drainTimers(timers, 4);
    }
    assert.ok(better.requested().length - afterRemount <= 3, "持续缺失时的重试必须有界");
    assert.equal(timers.size(), 0, "持续缺失也不留残留 timer");
    dispose();
  }));
});

/**
 * 回归（多 pane/分页刷新）：宿主刷新后会从持久化布局恢复**全部 pane** 的 tab，而 active()
 * 只返回当前活跃 pane 的 active tab。修复前 DEG 只用 readHostActiveSurface() 判断当前
 * surface，随后无条件 openSurfaceTab(sessionId)，于是已经存在于另一个 pane 的 Expert Group 页
 * 会被当前 pane 再开一份——刷新一次多一个重复页。
 *
 * 公开的只读 inventory（sidebarRight.openTabs.getSnapshot()，按 Session 给出全部已提交 tab）
 * 才是跨 pane 的权威证据。命中同一 sessionId + kind === "expert-group" 时必须走「已打开」的
 * 完成语义：不调用 openTab（既不新建重复页，也不把焦点抢到别的 pane 的 tab 上），
 * 但右栏展开照旧完成（否则用户看到的是「页面明明在，右栏却没打开」）。
 */
test("多 pane/分页：同一 session 的 expert-group 已在非活跃 pane 时不再 openTab，但仍照常展开右栏", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();                      // current = root-a
    const better = readyBetterFixture({ active: "root-a" }); // 宿主已提交 root-a
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      // 活跃 pane 上是另一个 kind 的 tab：只看 active() 只会得出「Expert Group 页不存在」。
      sidebarRight: crossPaneSidebarRightFixture({
        activeTab: { id: "pane-1-chat", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/expert-1?parent=root-a&mode=continuable" },
        // 宿主 native tab 的真实 kind 也可能是 dsh-expert-group；自动去重必须与 pane 映射使用同一词表。
        tabs: [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" }],
      }),
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });

    // 同步栈内照旧只有宽度写入：打开与展开都 defer 到宿主提交之后。
    assert.deepEqual(better.requested(), [], "同步栈不发打开请求");
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), [], "跨 pane 已有 Expert Group 页时绝不再开一个重复页");
    assert.deepEqual(rightbarOpens(events), ["rightbar:true:false"], "命中已存在仍必须完成右栏展开");
    assert.equal(timers.size(), 0, "命中路径不得留下残留 timer");

    // 重复通知（sessions 广播 + Better 状态通知）必须保持幂等：既不补开，也不重复展开。
    sessions.set({ current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } });
    better.notify();
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), [], "重复通知不得补开一个");
    assert.equal(rightbarOpens(events).length, 1, "不得重复展开右栏");
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

/**
 * 同一回归的第二个边界：inventory 只能证明「tab 已提交」，**不能**证明「它就是当前活跃 pane 的
 * active tab」。因此命中路径绝不能把 commitState 写成 "confirmed"：那会伪造出
 * 「已确认 → 明确缺失」的重挂载边沿，把 rightbarPresented 复位并重新展开一次右栏
 * （表现为右栏反复闪烁）。这里 active() 持续返回 undefined（读面 missing），展开次数必须保持 1。
 */
test("多 pane：活跃 pane 无 active tab（证据 missing）时命中跨 pane 已存在也不伪造 confirmed 证据", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = sessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      // 活跃 pane 一个 tab 都没有：active() 返回 undefined（surface 未 mint / tab 未提交）。
      sidebarRight: crossPaneSidebarRightFixture({ activeTab: undefined }),
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), [], "跨 pane 已有页时不得再 openTab");
    assert.equal(rightbarOpens(events).length, 1, "命中已存在仍要展开右栏一次");

    // 后续通知：active() 依旧 missing。commitState 若被写成 confirmed，这里就会走重挂载复位
    // 并再展开一次——断言展开次数恒为 1 正是这条边界的守卫。
    const sameSnapshot = { current: "root-a", byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } } };
    better.notify();
    sessions.set(sameSnapshot);
    drainTimers(timers, 6);
    assert.equal(rightbarOpens(events).length, 1, "不得因伪造的 confirmed 证据重挂载并重复展开右栏");
    assert.deepEqual(better.requested(), [], "重挂载也不得补开一个（页面已在别的 pane）");
    assert.equal(timers.size(), 0);
    dispose();
  }));
});

/**
 * 兼容边界：openTabs 读面缺失（旧宿主）、getSnapshot 缺失、返回 null/非数组或任何一步抛错时，
 * 必须**完全**回退到修复前的旧语义（照常按当前会话打开 Expert Group 页），绝不把「读不到」
 * 当成「页面已存在」而跳过打开。
 */
test("openTabs 读面缺失、返回 null 或抛错时完全回退旧语义：仍按当前会话打开 Expert Group 页", () => {
  // 每个形态都用「active() 已确认 expert-group」这一旧宿主的成功路径：读面不可用时必须逐字节
  // 保持修复前的语义（恰好打开一次），绝不能因为读不到 inventory 就跳过打开。
  const confirmedTab = () => ({ id: "tab-1", kind: "expert-group" });
  const shapes = [
    ["没有 sidebarRight 服务", undefined],
    ["sidebarRight 没有 openTabs", { active: confirmedTab }],
    ["openTabs 没有 getSnapshot", { openTabs: {}, active: confirmedTab }],
    ["getSnapshot 返回 null", { openTabs: { getSnapshot: () => null }, active: confirmedTab }],
    ["getSnapshot 返回非数组", { openTabs: { getSnapshot: () => ({ tabs: [] }) }, active: confirmedTab }],
    ["getSnapshot 抛错", { openTabs: { getSnapshot() { throw new Error("inventory 尚未就绪"); } }, active: confirmedTab }],
    ["openTabs 属性读取抛错", { get openTabs() { throw new Error("未声明的服务属性"); }, active: confirmedTab }],
  ];
  for (const [label, sidebarRight] of shapes) {
    withViewportWidth(1600, () => withDeferredTimers((timers) => {
      const sessions = sessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const ctx = {
        betterSidebar: better,
        sessions,
        ...(sidebarRight === undefined ? {} : { sidebarRight }),
      };
      const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: (id) => id });
      drainTimers(timers, 6);
      assert.deepEqual(better.requested(), ["root-a"], label + "：读面不可用时必须完全回退旧语义（照常打开一次）");
      dispose();
      assert.equal(timers.size(), 0, label + "：dispose 后不得残留 timer");
    }));
  }
});

test("宿主明确卸载 surface 的复位边沿清理旧访问遗留的展开 timer：重挂载后仍会重新展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();                 // current = child-1
    const better = readyBetterFixture({ active: "child-1" }); // 宿主已把 child-1 提交为活跃 surface
    let activeTabKind = "expert-group";
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => (activeTabKind === null ? undefined : { id: "tab-1", kind: activeTabKind }) },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });

    // 第一次访问：只推进「打开页面」这一轮。回调里新排的展开 timer 留在队列里不执行，
    // 等价于宿主在展开回调真正跑起来之前就把这个 surface 卸载了（旧访问遗留的待执行任务）。
    timers.flush();
    assert.ok(timers.size() >= 1, "页面落地后必须已排入 deferred 展开请求");
    assert.deepEqual(rightbarOpens(events), [], "展开必须 deferred 到宿主提交之后，推进前不得调用 layout");

    // 宿主明确卸载 surface（seat 卸载 / 右栏被关掉）：结束展示生命周期并开一次新访问。
    // 复位边沿顺手取消旧访问遗留的展开 timer —— 它属于已经作废的访问，继续排队只会占住该
    // session 的唯一槽位（scheduleRightbarExpand 见到同 session 已有待执行 timer 就返回 false），
    // 因此这里是就地显式清理，不看后续 beginVisit 的代次变化脸色。断言队列只剩新访问的打开请求。
    activeTabKind = null;
    better.notify();
    assert.equal(timers.size(), 1, "旧访问遗留的展开 timer 必须被取消，只留新访问的打开请求");

    // 宿主重新提交同一个 surface：重挂载后必须重新确保页面，并重新调用 layout.openRightbar。
    activeTabKind = "expert-group";
    better.notify();
    drainTimers(timers, 8);
    assert.ok(better.requested().length >= 2, "重挂载后必须重新打开页面");
    assert.equal(rightbarOpens(events).length, 1, "重挂载后必须重新展开右栏一次");
    assert.equal(timers.size(), 0, "处理完不得留下残留 timer");
    dispose();
  }));
});

test("右栏展示生命周期：首次展开后切换 child 只切页面内容，宿主明确清空 active tab 后才重新展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // current = child-1；child-2 / child-3 是同一 root 下的另外两个子代理会话。
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    // 宿主右栏真实的 active tab 读面：null = 面板上没有 active tab
    // （seat 卸载 / 布局重置 / 用户关掉右栏，都是「Expert Group surface 明确没了」）。
    let activeTabKind = "expert-group";
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => (activeTabKind === null ? undefined : { id: "tab-1", kind: activeTabKind }) },
      layout: layoutFixture(events, { openRightbar: true }),
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const byId = {
      "root-1": { id: "root-1" },
      "child-1": { id: "child-1", parentId: "root-1" },
      "child-2": { id: "child-2", parentId: "root-1" },
      "child-3": { id: "child-3", parentId: "root-1" },
    };
    /** 切到一个「宿主已提交」的 child surface：sessions.current 先走，宿主随后提交 binding。 */
    const switchToCommittedChild = (childId) => {
      sessions.set({ current: childId, byId });
      better.commitSession(childId);
      drainTimers(timers, 6);
    };

    // 1) 首次访问（此前确实没有右栏）：页面落地后展开一次，首次打开的动画保留。
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), ["child-1"]);
    assert.deepEqual(better.landed(), ["child-1"]);
    assert.equal(rightbarOpens(events).length, 1, "首次访问必须调用一次 layout.openRightbar");

    // 2) 切到第二个已提交 child：仍然要切到对应 surface 的内容，但右栏已经展开过，
    //    绝不能再调 layout.openRightbar —— 重复展开正是切换 child 时右栏闪烁的来源。
    switchToCommittedChild("child-2");
    assert.deepEqual(better.requested(), ["child-1", "child-2"], "切换 child 必须切换对应 surface 的页面");
    assert.equal(rightbarOpens(events).length, 1, "已展开的右栏不得被再次展开");

    // 3) 再切第三个已提交 child：同样只切内容，右栏调用次数保持不增。
    switchToCommittedChild("child-3");
    assert.deepEqual(better.requested(), ["child-1", "child-2", "child-3"]);
    assert.equal(rightbarOpens(events).length, 1, "连续切换 child 不得累积右栏展开");

    // 4) 宿主明确清空 active tab（surface 卸载 / 右栏被关掉）：展示生命周期结束，
    //    重新提交后必须重新确保页面，并允许再展开一次。
    activeTabKind = null;
    better.notify();
    drainTimers(timers, 6);
    const requestsAfterRemount = better.requested().length;
    activeTabKind = "expert-group";
    better.notify();
    drainTimers(timers, 6);
    assert.ok(better.requested().length > requestsAfterRemount, "明确清空后重新提交必须重新打开页面");
    assert.equal(rightbarOpens(events).length, 2, "右栏生命周期结束后允许重新展开一次");
    assert.equal(timers.size(), 0, "往返之后不留残留 timer");
    dispose();
  }));
});

test("右栏展示生命周期复位后展开失败预算重新开始：旧生命周期的失败计数不得跨生命周期继承", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sessions = childSessionsFixture();                 // current = child-1
    const better = readyBetterFixture({ active: "child-1" }); // 宿主已提交
    let activeTabKind = "expert-group";
    const events = [];
    const ctx = {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => (activeTabKind === null ? undefined : { id: "tab-1", kind: activeTabKind }) },
      layout: {
        panels: { setRightbar(px) { events.push("width:" + px); } },
        // 展开调用永远抛错：用 "rightbar:attempt" 精确数尝试次数，并验证上限确实生效。
        openRightbar() { events.push("rightbar:attempt"); throw new Error("layout store 已销毁"); },
      },
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    const expandAttempts = () => events.filter((event) => event === "rightbar:attempt").length;

    // 第一个展示生命周期：页面落地后展开调用连续失败，用满 RIGHTBAR_EXPAND_MAX_ATTEMPTS。
    drainTimers(timers, 8);
    assert.equal(expandAttempts(), 3, "展开失败尝试上限 3 次");
    assert.equal(timers.size(), 0, "失败上限用尽后不再自我重排");

    // 宿主明确清空 active tab（seat 卸载 / 用户关掉右栏）→ 展示生命周期结束、失败预算复位。
    activeTabKind = null;
    better.notify();
    drainTimers(timers, 6);
    const attemptsAfterReset = expandAttempts();
    assert.equal(attemptsAfterReset, 3, "清空时页面还没重新落地，不该有新尝试");

    // 宿主重新提交 active tab：新生命周期必须重新尝试展开，哪怕旧生命周期已经失败到上限。
    activeTabKind = "expert-group";
    better.notify();
    drainTimers(timers, 8);
    assert.ok(
      expandAttempts() > attemptsAfterReset,
      "新展示生命周期必须能重新尝试展开（旧生命周期的失败计数不得被继承）",
    );
    assert.equal(expandAttempts() - attemptsAfterReset, 3, "新生命周期同样最多 3 次尝试");
    assert.equal(timers.size(), 0, "新生命周期的失败上限同样有界，不留残留 timer");
    dispose();
  }));
});

test("旧 root 的 deferred 打开未执行就切到已提交 child：flush 旧 timer 与重放旧回调都不得为 root 打开或展开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 初始 current = root-1，宿主也提交在 root-1：安装时会为它排一个 deferred 打开回调。
    let snapshot = { current: "root-1", byId: { "root-1": { id: "root-1" } } };
    const listeners = new Set();
    const sessions = {
      list: {
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      },
      open() {},
      set(next) { snapshot = next; for (const listener of listeners) listener(); },
    };
    const better = readyBetterFixture({ active: "root-1" });
    // 打开与展开共用一条时间线（readyBetterFixture 只记自己的 opens，因此把它的 openTab
    // 包一层写进同一条时间线），这样才能断言「旧 root 没有 openTab」以及展开排在 child 之后。
    const timeline = [];
    const betterOpenTab = better.openTab;
    better.openTab = (seed, scope) => {
      timeline.push("open:" + scope.sessionId);
      return betterOpenTab.call(better, seed, scope);
    };
    const ctx = { betterSidebar: better, sessions, layout: layoutFixture(timeline, { openRightbar: true }) };

    // 额外记下每次排程的回调：真实路径上旧 root 的 timer 会被代次切换 clearTimeout 掉，
    // 直接重放这个「已作废」的回调才能证明代次/当前可见会话两道校验真的拦住了旧 root。
    const scheduled = [];
    const executed = [];
    const deferredSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, delay) => {
      scheduled.push(callback);
      // 同时记录「真正被执行过」的回调：切走时旧 root 的 deferred 任务必须被代次切换取消，
      // 所以它绝不能出现在 executed 里（这是「旧 timer 在切换时可取消」的直接证据）。
      return deferredSetTimeout(() => { executed.push(callback); callback(); }, delay);
    };
    const dispose = sidebar.installExpertGroupSidebar(ctx, { react, primitives, sessions, resolveRootSessionId: rootIdOf });
    globalThis.setTimeout = deferredSetTimeout;
    const staleRootOpen = scheduled[0];

    // 同步栈里不发请求：root-1 的打开请求只排在 deferred 队列里，尚未执行。
    assert.deepEqual(better.requested(), [], "同步栈不发请求");
    assert.equal(scheduled.length, 1, "root-1 的 deferred 打开已排队");
    assert.equal(typeof staleRootOpen, "function");

    // 旧 root 的 deferred 任务还没执行就切到已提交的 child。
    sessions.set({
      current: "child-1",
      byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
    });
    better.commitSession("child-1");
    assert.deepEqual(better.requested(), [], "切换本身不得触发任何请求");

    // 1) flush：旧 timer 已被代次切换取消（这条路径上必须空转），只为 child 打开。
    drainTimers(timers, 6);
    // 2) 即便取消逻辑失效、旧回调被重放，也必须被「不再是当前可见会话」拦下。
    staleRootOpen();
    drainTimers(timers, 6);
    assert.deepEqual(better.requested(), ["child-1"], "旧 root 绝不允许 openTab；只为已提交的 child 打开");
    assert.deepEqual(better.landed(), ["child-1"]);
    // 两次宽度写入分别属于 root-1 与 child-1 两个 surface 会话：切换会话时新会话写它自己的 20%，
    // 但两次都是 1600 × 20% = 320，因此宿主看到的宽度值不变。
    assert.deepEqual(timeline, ["width:320", "width:320", "open:child-1", "rightbar:true:false"],
      "旧 root 不得 openTab、不得 openRightbar；child 仍照常打开并在自己的 deferred 回调里展开");
    assert.deepEqual(rightbarOpens(timeline), ["rightbar:true:false"], "只允许一次展开，且属于 child");
    assert.ok(!executed.includes(staleRootOpen), "旧 root 的 deferred 任务必须被代次切换取消，绝不能被 flush 执行");
    assert.equal(timers.size(), 0, "切换 + flush 之后不留残留 timer");
    dispose();
    assert.equal(timers.size(), 0, "dispose 后同样没有残留 timer");
  }));
});

/** 最小 localStorage 替身：跨「刷新」（新的 install 生命周期）共享同一份数据的唯一载体。 */
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

/**
 * 通用元素替身：只实现插件探测与改写过渡所需的 DOM 面。
 * setProperty/removeProperty 把动作写进 sink.events（label 前缀区分 frame 与 panel），
 * 这样「先抑制过渡 → 再调用 openRightbar → 提交后恢复」可以被逐项顺序断言，
 * 断言比对的是元素真实的内联属性（inline），而不是事件条数。
 */
function elementStub(sink, label = "", initial = {}, initialPriorities = {}) {
  const inline = new Map(Object.entries(initial));
  const priorities = new Map(Object.entries(initialPriorities));
  return {
    inline,
    priorities,
    style: {
      getPropertyValue(name) { return inline.has(name) ? inline.get(name) : ""; },
      getPropertyPriority(name) { return priorities.has(name) ? priorities.get(name) : ""; },
      setProperty(name, value, priority) {
        inline.set(name, String(value));
        if (priority === undefined || priority === null || priority === "") priorities.delete(name);
        else priorities.set(name, String(priority));
        // 日志仍然只记内联值：既有时间线断言的格式保持不变；优先级通过 priorities 断言。
        sink.events.push(label + "style:" + name + "=" + value);
      },
      removeProperty(name) {
        inline.delete(name);
        priorities.delete(name);
        sink.events.push(label + "style:" + name + "=");
      },
    },
  };
}

/** AppFrame 根元素替身（保持原有日志格式："style:…"）。 */
function frameElementStub(sink, initial = {}, initialPriorities = {}) {
  return elementStub(sink, "", initial, initialPriorities);
}

/**
 * 真实右栏面板替身（[data-sidebar-right-panel]）：日志加 "panel:" 前缀。
 * 插件唯一依赖的探测契约就是这个公开属性；面板可能被宿主（不同 DSH 版本/运行时实现）挂到
 * frame 之外，因此不能假设它继承 frame 上的变量——测试也按「独立元素」来搭替身。
 */
function panelElementStub(sink, initial = {}, initialPriorities = {}) {
  return elementStub(sink, "panel:", initial, initialPriorities);
}

/**
 * 受控 requestAnimationFrame 替身：手动推进帧，用于验证「两次 RAF 后恢复」、
 * 以及「RAF 被后台节流时 fallback timer 兜底恢复」这两条边界。
 */
function withFakeRaf(run) {
  const pending = new Map();
  const cancelled = [];
  let nextId = 1;
  const restore = installGlobals({
    requestAnimationFrame(callback) { const id = nextId++; pending.set(id, callback); return id; },
    cancelAnimationFrame(id) { cancelled.push(id); pending.delete(id); },
  });
  const raf = {
    cancelled,
    size: () => pending.size,
    /** 执行当前这一帧里的全部回调；回调里新排的帧留到下一次 advance。 */
    advance() {
      for (const [id, callback] of [...pending]) { pending.delete(id); callback(); }
    },
  };
  try {
    return run(raf);
  } finally {
    restore();
  }
}

/**
 * document 替身：data-shell-overlay 是 AppFrame 的直接子节点（与真实 DSH DOM 一致）；
 * panel 可选对应 [data-sidebar-right-panel]：面板可能由宿主挂到 frame 之外（插件只依赖这个公开属性）；
 * better 可选对应 dsh-better-sidebar 的宿主（[data-dsh-better-sidebar] + 其直接子节点）与 #root。
 * queries 记录插件实际问过的选择器，用例可据此断言定位参数（而不是依赖真实 CSS module hash）。
 */
function documentStub(frame, panel = null, better = null, options = {}) {
  const current = {
    frame: frame ?? null,
    panel: panel ?? null,
    betterHost: better?.host ?? null,
    root: better?.root ?? null,
    // AppFrame 的右栏拖拽手柄（宿主稳定 DOM 标记 [data-side=rightbar]）：插件只在这个
    // 元素上写内联样式，因此替身也只需要 querySelector 返回它。
    handle: options.handle ?? null,
  };
  // collapsed=true 模拟「用户已手动关闭右栏 / 从未展开」：AppFrame 上存在 data-rightbar-collapsed。
  const state = { collapsed: options.collapsed === true };
  const queries = [];
  return {
    hidden: false,
    documentElement: { nodeType: 1 },
    queries,
    /** 模拟「panel 比抑制更晚挂载」：从这一刻起 querySelector 才能查到它。 */
    setPanel(next) { current.panel = next ?? null; },
    /** 模拟「AppFrame 比抑制更晚出现」（frame 迟到的宿主实现）。 */
    setFrame(next) { current.frame = next ?? null; },
    /** 模拟「拖拽手柄比插件首次同步更晚挂载」（React 按 rightbarShown/宽度重挂载它）。 */
    setHandle(next) { current.handle = next ?? null; },
    /** 模拟用户手动关闭/展开右栏（公开属性 data-rightbar-collapsed 的有无）。 */
    setCollapsed(next) { state.collapsed = next === true; },
    querySelector(selector) {
      queries.push(selector);
      if (selector === "[data-shell-overlay]") {
        return current.frame === null ? null : { parentElement: current.frame };
      }
      if (selector === "[data-sidebar-right-panel]") return current.panel;
      if (selector === "[data-side=rightbar]") return current.handle;
      // dsh-better-sidebar 0.12.x：宿主属性 + 直接子节点里 class 含 panel（排除 bottomPanel）。
      if (selector === "[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])") {
        const host = current.betterHost;
        if (host === null) return null;
        return host.children.find((child) => {
          const name = String(child.className ?? "");
          return name.includes("panel") && !name.includes("bottomPanel");
        }) ?? null;
      }
      if (selector === "[data-rightbar-collapsed]") return state.collapsed ? current.frame : null;
      if (selector === "#root") return current.root;
      return null;
    },
  };
}

/**
 * dsh-better-sidebar 0.12.x 的真实 DOM 结构替身：
 * - document.body 下的稳定宿主属性 [data-dsh-better-sidebar]；它的**直接子节点**里 class 含 panel 的
 *   是右面板（真实 CSS module 名带 hash，例如 "panel_1a2b3c"，因此测试也刻意用 hash 风格类名，
 *   绝不依赖具体 hash），class 含 bottomPanel 的是底面板；
 * - #root：Better 在它上面写 margin-right: var(--dsh-sidebar-width) 并对其使用过渡。
 * 所有元素共享同一个 sink，便于断言「谁被抑制、谁被恢复、谁完全没被碰过」。
 */
function betterDomFixture(sink, { mounted = true } = {}) {
  const host = { nodeType: 1, children: [] };
  const rightPanel = elementStub(sink, "better-panel:");
  rightPanel.className = "panel_1a2b3c rightbar_surface";   // 不含 bottomPanel
  const bottomPanel = elementStub(sink, "bottom-panel:");
  bottomPanel.className = "bottomPanel_9z8y7x";
  const root = elementStub(sink, "root:", { "margin-right": "0px" });
  const mountPanel = () => { if (!host.children.includes(rightPanel)) host.children.push(rightPanel); };
  const mountBottom = () => { if (!host.children.includes(bottomPanel)) host.children.push(bottomPanel); };
  if (mounted) { mountPanel(); mountBottom(); }
  return {
    host, rightPanel, bottomPanel, root, mountPanel, mountBottom,
    /** Better 展开右栏：状态驱动地改 panel 的公开 class（这里模拟同步展开）。 */
    expandPanel() { rightPanel.className = "panel_1a2b3c panel_open"; },
  };
}

/**
 * 受控 MutationObserver 替身：记录实例与 observe 参数，允许用例手动触发回调，
 * 用来模拟「右栏 panel 比抑制更晚挂载 / 公开状态变化」的时序（真实浏览器里回调是微任务，
 * 会在绘制前跑完，所以内联抑制先于首帧动画生效）。
 */
function withFakeObserver(run) {
  const instances = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.disconnected = false;
      instances.push(this);
    }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const restore = installGlobals({ MutationObserver: FakeMutationObserver });
  try {
    return run({
      instances,
      /** 手动触发所有仍然连着的 observer 回调（等价于浏览器把变更批次派发给它们）。 */
      /** 手动派发一批 mutation records（不传则派发空批次）。 */
      fire(records) {
        const batch = Array.isArray(records) ? records : [];
        for (const instance of instances) {
          if (instance.disconnected !== true) instance.callback(batch);
        }
      },
    });
  } finally {
    restore();
  }
}

/**
 * 一次插件安装生命周期（等价于一次页面加载 / 一次刷新）：宿主 layout 每次都是新的 store 替身，
 * 但 document 与 localStorage 由用例跨生命周期共享，用来模拟「刷新」。
 */
function installLifecycle({ events, sessions, layout }) {
  const better = {
    registerTab() { return () => {}; },
    isTabEnabled: () => true,
    openTab(seed, scope) { events.push("open:" + scope.sessionId); },
  };
  return sidebar.installExpertGroupSidebar(
    { betterSidebar: better, sessions, layout },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
}

test("刷新后首次自动展开以无过渡方式提交：仍调用 openRightbar，但不重新播放展开动画", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const storage = memoryStorage();
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const restoreGlobals = installGlobals({ localStorage: storage, document: documentStub(frame) });
    try {
      const sessions = sessionsFixture();

      // 1) 第一次安装（首次打开右栏）：必须保留原有动画，绝不出现任何过渡抑制。
      const firstEvents = [];
      sink.events = firstEvents;
      const disposeFirst = installLifecycle({
        events: firstEvents, sessions, layout: layoutFixture(firstEvents, { openRightbar: true }),
      });
      drainTimers(timers);
      assert.deepEqual(firstEvents, ["width:320", "open:root-a", "rightbar:true:false"], "首次自动展开照常调用 openRightbar");
      assert.deepEqual(frame.inline.size, 0, "首次打开不得改写 frame 过渡：首次动画必须保留");
      disposeFirst();

      // 2) 浏览器刷新：新的 install 生命周期（内存态 rightbarPresented 归零）、新的布局 store
      //    （宿主 rightbarShown 回到 false，因此仍然必须调用 openRightbar 让右栏显示），
      //    但 DOM 与 localStorage 不变。
      const secondEvents = [];
      sink.events = secondEvents;
      const disposeSecond = installLifecycle({
        events: secondEvents, sessions, layout: layoutFixture(secondEvents, { openRightbar: true }),
      });
      timers.flush();  // 推进「打开页面」的 deferred 回调
      timers.flush();  // 推进「展开右栏」的 deferred 回调（样式抑制发生在这里）
      assert.deepEqual(secondEvents, [
        "width:320",
        "style:--ds-transition-duration-slow=0ms",
        "style:transition=none",
        "open:root-a",
        "rightbar:true:false",
      ], "刷新后的首次自动展开：抑制必须早于 openTab（panel 可能同步展开），随后仍调用 openRightbar");

      // 恢复必须晚于宿主的这次提交：受控 timer 推进后内联样式还原，不留下任何抑制态。
      timers.flush();
      assert.deepEqual(secondEvents.slice(5), [
        "style:transition=",
        "style:--ds-transition-duration-slow=",
      ], "浏览器完成一次提交后必须恢复原值");
      assert.deepEqual([...frame.inline.keys()], [], "恢复后 frame 上不得残留任何内联抑制");

      // 3) 后续切换 child：页面照常切换，右栏已展示过 → 不再调用 openRightbar；
      //    但这次 openTab 仍可能让新 surface 的 panel 进入 expanded（transform 过渡），
      //    所以仍然要在 openTab 之前抑制、并在恢复窗口后归还（这正是「首次展开后切换仍滑入」的漏点）。
      sessions.set({
        current: "child-1",
        byId: { "root-a": { id: "root-a" }, "child-1": { id: "child-1", parentId: "root-a" } },
      });
      drainTimers(timers);
      // slice(7) 从「切到 child-1 的那次访问」开始：先是 child-1 自己的 20% 宽度写入，
      // 再是抑制新 surface 的提交（expanded transform），全程不再调用 openRightbar。
      assert.deepEqual(secondEvents.slice(7), [
        "width:320",
        "style:--ds-transition-duration-slow=0ms",
        "style:transition=none",
        "open:child-1",
        "style:transition=",
        "style:--ds-transition-duration-slow=",
      ], "切换 child 仍必须抑制新 surface 的提交（expanded transform），但不再调用 openRightbar");
      assert.equal(rightbarOpens(secondEvents).length, 1, "刷新后的生命周期内同样不重复展开右栏");
      assert.equal(secondEvents.filter((event) => event.startsWith("style:")).length, 8, "每个 surface 各一次抑制 + 一次恢复");
      disposeSecond();
      assert.equal(timers.size(), 0, "dispose 后不留残留 timer");

      // 持久标记：刷新后仍能识别「右栏已经展示过」，后续自动打开都走无过渡路径。
      assert.equal(storage.getItem("dsh-expert-group:rightbar-presented:v1"), "1", "成功展开后才写入持久标记");
    } finally {
      restoreGlobals();
    }
  }));
});

test("dispose 取消尚未执行的过渡恢复，并立即还原 AppFrame 的临时内联样式", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // 已有持久标记（刷新后场景）：这次自动打开会写入过渡抑制，但恢复还没执行就卸载插件。
    const storage = memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" });
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const restoreGlobals = installGlobals({ localStorage: storage, document: documentStub(frame) });
    try {
      const sessions = sessionsFixture();
      const events = [];
      sink.events = events;
      const dispose = installLifecycle({ events, sessions, layout: layoutFixture(events, { openRightbar: true }) });
      timers.flush(); // 打开页面
      timers.flush(); // 展开右栏：写入抑制并排下恢复任务
      assert.equal(frame.inline.get("--ds-transition-duration-slow"), "0ms", "抑制已写入，恢复尚未执行");
      assert.ok(timers.size() >= 1, "恢复任务仍在排队");

      dispose();
      assert.deepEqual([...frame.inline.keys()], [], "dispose 必须立刻还原临时内联样式");
      assert.equal(timers.size(), 0, "dispose 必须取消尚未执行的恢复 timer");
      const styleWritesBefore = events.filter((event) => event.startsWith("style:")).length;
      timers.flush();
      assert.equal(events.filter((event) => event.startsWith("style:")).length, styleWritesBefore, "dispose 后不得再有任何样式改写");
    } finally {
      restoreGlobals();
    }
  }));
});

/** 准备一次「已有持久标记」的抑制现场：返回 frame/events 与安装句柄（样式抑制已写入）。 */
function suppressedInstall({ timers, storage }) {
  const sink = { events: [] };
  const frame = frameElementStub(sink);
  const restoreGlobals = installGlobals({ localStorage: storage, document: documentStub(frame) });
  const sessions = sessionsFixture();
  const events = [];
  sink.events = events;
  const dispose = installLifecycle({ events, sessions, layout: layoutFixture(events, { openRightbar: true }) });
  timers.flush(); // 打开页面
  timers.flush(); // 展开右栏：写入抑制并排下恢复任务
  return { frame, events, dispose, restoreGlobals };
}

test("过渡恢复同时排两次 RAF 与有界 fallback：第二帧恢复并取消 fallback timer", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeRaf((raf) => {
      // 已有持久标记 → 这次自动打开会临时抑制过渡。
      const { frame, dispose, restoreGlobals } = suppressedInstall({
        timers, storage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      });
      try {
        assert.equal(frame.inline.get("--ds-transition-duration-slow"), "0ms", "抑制已写入");
        assert.equal(frame.inline.get("transition"), "none");
        assert.equal(raf.size(), 1, "已排下第一帧");
        assert.deepEqual(timers.delays(), [250], "即使 RAF 可用，也必须同时安排有界 fallback timer");

        raf.advance();
        assert.equal(raf.size(), 1, "第一帧只负责排第二帧");
        assert.equal(frame.inline.get("--ds-transition-duration-slow"), "0ms", "第一帧后不得提前恢复");

        raf.advance();
        assert.deepEqual([...frame.inline.keys()], [], "第二帧必须恢复原值");
        assert.equal(timers.size(), 0, "恢复后必须取消 fallback timer，不留任务");
        assert.equal(raf.size(), 0, "恢复后不得再留待执行帧");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("RAF 被后台节流不执行时，fallback timer 到点恢复样式并取消待执行帧", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeRaf((raf) => {
      const { frame, dispose, restoreGlobals } = suppressedInstall({
        timers, storage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      });
      try {
        assert.equal(frame.inline.get("transition"), "none", "抑制已写入");
        // 后台标签页/节能：RAF 从不触发，只有 fallback timer 会到点（有界延迟 250ms）。
        assert.equal(raf.size(), 1, "RAF 仍排着队但永远不会执行");
        timers.flush();
        assert.deepEqual([...frame.inline.keys()], [], "fallback 到点必须恢复样式，绝不能让 frame 长期保持 transition:none");
        assert.equal(raf.size(), 0, "fallback 恢复后必须取消待执行的 RAF");
        assert.ok(raf.cancelled.length >= 1, "被取消的正是之前排下的那一帧");
        assert.equal(timers.size(), 0, "恢复后不留任何 timer");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("dispose 同时取消 RAF 与 fallback timer，并立即恢复样式", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeRaf((raf) => {
      const { frame, events, dispose, restoreGlobals } = suppressedInstall({
        timers, storage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      });
      try {
        assert.equal(frame.inline.get("--ds-transition-duration-slow"), "0ms", "抑制已写入");
        assert.equal(raf.size(), 1, "RAF 仍在排队");
        assert.equal(timers.size(), 1, "fallback timer 仍在排队");

        dispose();
        assert.deepEqual([...frame.inline.keys()], [], "dispose 必须立即恢复样式");
        assert.equal(raf.size(), 0, "dispose 必须取消待执行帧");
        assert.equal(timers.size(), 0, "dispose 必须清除 fallback timer");
        const styleWrites = events.filter((event) => event.startsWith("style:")).length;
        raf.advance();
        timers.flush();
        assert.equal(events.filter((event) => event.startsWith("style:")).length, styleWrites, "dispose 后不得再有任何样式改写");
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("恢复期间被外部改写过的样式不被覆盖，未被改写的属性照常恢复", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeRaf((raf) => {
      const { frame, dispose, restoreGlobals } = suppressedInstall({
        timers, storage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      });
      try {
        // 外部（宿主或页面脚本）在抑制窗口内改写了该变量：恢复时绝不能用旧值把它覆盖回去。
        frame.style.setProperty("--ds-transition-duration-slow", "600ms");
        assert.equal(frame.inline.get("transition"), "none", "transition 未被外部改写");
        raf.advance();
        raf.advance();
        assert.equal(frame.inline.get("--ds-transition-duration-slow"), "600ms", "外部写入的变量必须保留");
        assert.equal(frame.inline.has("transition"), false, "未被外部改写的属性照常恢复（删除内联声明）");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("openRightbar 抛错时不写持久标记，改为成功后才写入 1", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const storage = memoryStorage();
    // 无 document：本条只验证持久化时机，不涉及 DOM 抑制。
    const restoreGlobals = installGlobals({ localStorage: storage, document: undefined });
    try {
      // 1) 调用始终抛错：绝不写标记（否则刷新后会误以为右栏已经展示过，首次动画被吃掉）。
      const failingEvents = [];
      const failingDispose = installLifecycle({
        events: failingEvents,
        sessions: sessionsFixture(),
        layout: {
          panels: { setRightbar(px) { failingEvents.push("width:" + px); } },
          openRightbar() { failingEvents.push("rightbar:attempt"); throw new Error("layout store 已销毁"); },
        },
      });
      drainTimers(timers, 8);
      assert.equal(failingEvents.filter((event) => event === "rightbar:attempt").length, 3, "失败尝试确实发生（上限 3 次）");
      assert.equal(storage.getItem("dsh-expert-group:rightbar-presented:v1"), null, "调用失败绝不写持久标记");
      failingDispose();

      // 2) 同一份 storage 下换成成功调用：这时才写入 1。
      const successEvents = [];
      const successDispose = installLifecycle({
        events: successEvents, sessions: sessionsFixture(), layout: layoutFixture(successEvents, { openRightbar: true }),
      });
      drainTimers(timers);
      assert.equal(rightbarOpens(successEvents).length, 1, "成功后照常展开一次");
      assert.equal(storage.getItem("dsh-expert-group:rightbar-presented:v1"), "1", "只有成功后才写入持久标记");
      successDispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("已有持久标记时同时抑制真实右栏 panel 与 AppFrame：调用前写入、调用后恢复", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    // 右栏面板可能被宿主挂到 AppFrame 子树之外（不同版本/运行时实现不同）：
    // 它自己的 transform 过渡（[data-sidebar-right-panel] + --ds-transition-duration-slow）
    // 才是「刷新后首次打开仍看到滑入动画」的真实来源，必须单独抑制。
    const panel = panelElementStub(sink);
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const sessions = sessionsFixture();
      const events = [];
      sink.events = events;
      const dispose = installLifecycle({ events, sessions, layout: layoutFixture(events, { openRightbar: true }) });
      timers.flush(); // 打开页面
      timers.flush(); // 展开右栏：两个目标都被抑制后才调用 layout.openRightbar
      assert.deepEqual(events, [
        "width:320",
        "panel:style:--ds-transition-duration-slow=0ms",
        "panel:style:transition=none",
        "panel:style:transform=none",
        "panel:style:visibility=visible",
        "style:--ds-transition-duration-slow=0ms",
        "style:transition=none",
        "open:root-a",
        "rightbar:true:false",
      ], "panel（含 transform/visibility）与 frame 的过渡必须在 openTab 之前被抑制，随后仍调用 openRightbar");
      // 断言元素真实属性，而不是只看事件条数。
      assert.equal(panel.inline.get("transition"), "none", "panel 的内联 transition 必须被置 none");
      assert.equal(panel.inline.get("--ds-transition-duration-slow"), "0ms", "panel 必须拿到 0ms 的过渡时长变量");
      assert.equal(panel.inline.get("transform"), "none", "panel 必须被钉成 transform:none（消除 collapsed 瞬间）");
      assert.equal(panel.inline.get("visibility"), "visible", "panel 必须被钉成 visibility:visible");
      assert.equal(frame.inline.get("transition"), "none");
      assert.equal(frame.inline.get("--ds-transition-duration-slow"), "0ms");
      assert.equal(frame.inline.has("transform"), false, "frame 绝不写 transform");
      assert.equal(frame.inline.has("visibility"), false, "frame 绝不写 visibility");

      timers.flush();
      assert.deepEqual(events.slice(9), [
        "panel:style:visibility=",
        "panel:style:transform=",
        "panel:style:transition=",
        "panel:style:--ds-transition-duration-slow=",
        "style:transition=",
        "style:--ds-transition-duration-slow=",
      ], "宿主提交后 panel 先撤销可见性钉住、再与 frame 一起恢复原值");
      assert.deepEqual([...panel.inline.keys()], [], "panel 不得残留任何抑制态");
      assert.deepEqual([...frame.inline.keys()], [], "frame 不得残留任何抑制态");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("同一元素被多个公开选择器命中时只处理一次（去重）", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    // 退化 DOM：panel 与 frame 是同一个节点（[data-sidebar-right-panel] 与 overlay 父元素指向它）。
    const shared = panelElementStub(sink);
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(shared, shared),
    });
    try {
      const events = [];
      sink.events = events;
      const dispose = installLifecycle({ events, sessions: sessionsFixture(), layout: layoutFixture(events, { openRightbar: true }) });
      timers.flush();
      timers.flush();
      assert.deepEqual(events.filter((event) => event.startsWith("panel:style:")), [
        "panel:style:--ds-transition-duration-slow=0ms",
        "panel:style:transition=none",
        "panel:style:transform=none",
        "panel:style:visibility=visible",
      ], "同一元素只允许被处理一次（panel 需要四项）");
      assert.equal(rightbarOpens(events).length, 1, "自动打开路径仍然只调用一次 openRightbar");

      timers.flush();
      assert.deepEqual(events.filter((event) => event.startsWith("panel:style:")), [
        "panel:style:--ds-transition-duration-slow=0ms",
        "panel:style:transition=none",
        "panel:style:transform=none",
        "panel:style:visibility=visible",
        "panel:style:visibility=",
        "panel:style:transform=",
        "panel:style:transition=",
        "panel:style:--ds-transition-duration-slow=",
      ], "恢复同样只发生一次，不留重复写入");
      assert.deepEqual([...shared.inline.keys()], []);
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("抑制必须早于 openTab：panel 与 frame 在页面打开调用之前就已是 transition:none", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const sessions = sessionsFixture();
      const events = [];
      sink.events = events;
      // openTab 之后 Better/native 可能同步把 panel 置成展开（data-sidebar-right-open），
      // 动画从那一刻开始；因此这里在 openTab 内部快照两个元素的真实内联属性，
      // 断言抑制早在这次调用之前就已经生效。
      const better = {
        registerTab() { return () => {}; },
        isTabEnabled: () => true,
        openTab(seed, scope) {
          events.push("open:" + scope.sessionId);
          // 同步模拟面板展开：真实宿主此时会写入 transform 与公开属性。
          panel.inline.set("--ds-transition-duration-slow", "520ms");
          events.push("panel-expanded");
        },
      };
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      timers.flush(); // 打开页面（抑制必须已经在此之前写好，但 openTab 会改写 panel 的变量）
      timers.flush(); // 展开右栏
      // 时间线证明抑制早于页面打开：panel 的四项写入与 frame 的两项写入都排在 open:root-a 之前。
      assert.deepEqual(events.slice(0, 8), [
        "width:320",
        "panel:style:--ds-transition-duration-slow=0ms",
        "panel:style:transition=none",
        "panel:style:transform=none",
        "panel:style:visibility=visible",
        "style:--ds-transition-duration-slow=0ms",
        "style:transition=none",
        "open:root-a",
      ], "panel（含 transform/visibility）与 frame 的抑制必须排在 openTab（页面打开）之前");
      assert.equal(events.includes("panel-expanded"), true, "openTab 确实模拟了同步展开");
      assert.equal(rightbarOpens(events).length, 1, "openRightbar 仍然被调用一次");

      timers.flush();
      // openTab 期间被外部改成 520ms，恢复时不得覆盖它；transition 仍是本次写入值，正常恢复。
      assert.equal(panel.inline.get("--ds-transition-duration-slow"), "520ms", "外部改写保留");
      assert.equal(panel.inline.has("transition"), false, "未被外部改写的属性照常恢复");
      assert.deepEqual([...frame.inline.keys()], [], "frame 完全恢复");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("panel 延迟挂载：MutationObserver 在面板出现后立刻抑制，并在恢复时断开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const document_ = documentStub(frame, null); // 抑制开始时 panel 还不存在
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: document_,
      });
      try {
        const events = [];
        sink.events = events;
        const better = {
          registerTab() { return () => {}; },
          isTabEnabled: () => true,
          openTab(seed, scope) {
            events.push("open:" + scope.sessionId);
            // 面板此刻才挂到 DOM 上（公开状态变化会触发 observer 回调）。
            document_.setPanel(panel);
            observer.fire();
          },
        };
        const sessions = sessionsFixture();
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        // 抑制发生在 deferred 的打开轮里：到那时才需要挂 observer。
        assert.equal(observer.instances.length, 0, "同步栈里还没开始打开页面，不应提前挂 observer");
        timers.flush();
        assert.equal(observer.instances.length, 1, "必须挂一个短生命周期 observer 兜住延迟挂载");
        // observer 回调在 openTab 内部（面板挂上来）之后立即跑过：新 panel 被内联抑制。
        assert.equal(panel.inline.get("transition"), "none", "新出现的 panel 必须立刻被抑制");
        assert.equal(panel.inline.get("--ds-transition-duration-slow"), "0ms");
        timers.flush();
        assert.equal(rightbarOpens(events).length, 1, "openRightbar 仍然被调用一次");
        timers.flush();
        assert.deepEqual([...panel.inline.keys()], [], "恢复时 panel 必须还原");
        assert.deepEqual([...frame.inline.keys()], [], "恢复时 frame 必须还原");
        assert.equal(observer.instances[0].disconnected, true, "恢复句柄必须 disconnect observer");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("dispose 收口尚未消费的抑制句柄：样式恢复、observer 断开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: documentStub(frame, panel),
      });
      try {
        const events = [];
        sink.events = events;
        const dispose = installLifecycle({
          events, sessions: sessionsFixture(), layout: layoutFixture(events, { openRightbar: true }),
        });
        timers.flush(); // 只推进「打开页面」这一轮：抑制句柄已挂在本次访问上、还没被展开消费
        assert.equal(panel.inline.get("transition"), "none", "抑制已写入且尚未消费");
        assert.equal(observer.instances[0].disconnected, false, "observer 仍在观察");

        dispose();
        assert.deepEqual([...panel.inline.keys()], [], "dispose 必须收口未消费句柄并还原 panel");
        assert.deepEqual([...frame.inline.keys()], [], "dispose 必须收口未消费句柄并还原 frame");
        assert.equal(observer.instances[0].disconnected, true, "dispose 必须断开 observer");
        assert.equal(timers.size(), 0, "dispose 后不留残留 timer");
        const styleWrites = events.filter((event) => event.includes("style:")).length;
        timers.flush();
        assert.equal(events.filter((event) => event.includes("style:")).length, styleWrites, "dispose 后不得再改写样式");
      } finally {
        restoreGlobals();
      }
    });
  }));
});

/** 装载「已有持久标记 + panel/frame 都在」的抑制现场，返回句柄与可静默切换的宿主替身。 */
function readinessScenario({ events, frame, panel, activeRead }) {
  const restoreGlobals = installGlobals({
    localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
    document: documentStub(frame, panel),
  });
  const sessions = childSessionsFixture(); // current = child-1
  const host = { session: "child-1" };     // 宿主已提交的活跃会话：可在不发通知的情况下静默改变
  const better = {
    registerTab() { return () => {}; },
    isTabEnabled: () => true,
    openTab(seed, scope) { events.push("open:" + scope.sessionId); },
    getSnapshot() { return { sessionId: host.session }; },
  };
  const dispose = sidebar.installExpertGroupSidebar(
    { betterSidebar: better, sessions, sidebarRight: { active: activeRead }, layout: layoutFixture(events, { openRightbar: true }) },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
  return { host, sessions, dispose, restoreGlobals };
}

test("readiness 等待预算用尽必须收口已准备的抑制句柄：样式恢复、observer 断开", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      // 读面永远没有 active tab（evidence = missing），因此第一轮打开不会结算，会排一次打开重试。
      const scenario = readinessScenario({ events, frame, panel, activeRead: () => undefined });
      try {
        timers.flush(); // 第一轮：readiness 通过 → 抑制已准备并写在 panel/frame 上 → openTab
        assert.equal(panel.inline.get("transition"), "none", "抑制已准备并写入 panel");
        assert.equal(observer.instances.length, 1, "已挂 observer");
        assert.equal(observer.instances[0].disconnected, false, "observer 仍在观察");

        // 宿主静默切回别的会话（不发通知 → 代次不变）：后续重试全部卡在 readiness 分支。
        scenario.host.session = "root-1";
        drainTimers(timers, 8);

        // 等待预算用尽后必须立刻收口句柄，绝不能把 observer 与内联样式留在宿主上。
        assert.deepEqual([...panel.inline.keys()], [], "readiness 预算用尽必须恢复 panel");
        assert.deepEqual([...frame.inline.keys()], [], "readiness 预算用尽必须恢复 frame");
        assert.equal(observer.instances[0].disconnected, true, "readiness 预算用尽必须 disconnect observer");
        assert.equal(timers.size(), 0, "不得残留 timer");
        scenario.dispose();
      } finally {
        scenario.restoreGlobals();
      }
    });
  }));
});

test("调度失败时立即收口句柄：展开排程与打开重试两条路径都不遗留 transition:none", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      // 场景 A：页面落地后 scheduleRightbarExpand 排不出 timer（setTimeout 失败）→ 立刻收口。
      const sinkA = { events: [] };
      const frameA = frameElementStub(sinkA);
      const panelA = panelElementStub(sinkA);
      const eventsA = [];
      sinkA.events = eventsA;
      const scenarioA = readinessScenario({
        events: eventsA, frame: frameA, panel: panelA,
        // 读面在 openTab 之后把调度器弄坏：展开排程必然失败。
        activeRead: () => { timers.failScheduling(true); return { id: "tab-1", kind: "expert-group" }; },
      });
      try {
        timers.flush();
        assert.deepEqual(rightbarOpens(eventsA), [], "排不出 timer 就不会调用 layout.openRightbar");
        assert.deepEqual([...panelA.inline.keys()], [], "展开排程失败必须立刻恢复 panel");
        assert.deepEqual([...frameA.inline.keys()], [], "展开排程失败必须立刻恢复 frame");
        assert.equal(observer.instances[0].disconnected, true, "展开排程失败必须 disconnect observer");
        assert.equal(timers.size(), 0, "不得残留 timer");
      } finally {
        scenarioA.dispose();
        timers.failScheduling(false);
        scenarioA.restoreGlobals();
      }
    });
  }));
});

test("MutationObserver 监听的公开标记覆盖全部探测目标，且重复回调不重复处理", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const document_ = documentStub(null, null); // frame 与 panel 都还没出现
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: document_,
      });
      try {
        const events = [];
        sink.events = events;
        const better = {
          registerTab() { return () => {}; },
          isTabEnabled: () => true,
          openTab(seed, scope) {
            events.push("open:" + scope.sessionId);
            document_.setFrame(frame);   // frame 迟到
            document_.setPanel(panel);   // panel 也迟到
            observer.fire();
            observer.fire();             // 重复派发：不得重复写入
          },
        };
        const sessions = sessionsFixture();
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        timers.flush();
        const instance = observer.instances[0];
        assert.ok(instance, "必须挂一个短生命周期 observer");
        assert.equal(instance.target, document_.documentElement, "必须观察 documentElement");
        assert.deepEqual(instance.options, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            "data-sidebar-right-panel",
            "data-sidebar-right-open",
            "data-shell-overlay",
            "data-rightbar-collapsed",
            "data-rightbar-instant",
            "data-dsh-better-sidebar",
          ],
        }, "attributeFilter 必须覆盖所有公开探测标记（含 Better 宿主属性）");
        // 迟到目标都被抑制，且重复回调没有产生重复写入。
        assert.equal(panel.inline.get("transition"), "none");
        assert.equal(frame.inline.get("transition"), "none");
        assert.deepEqual(events.filter((event) => event.includes("style:transition=none")).length, 2,
          "两次 observer 回调只允许各写一次");
        timers.flush();
        timers.flush();
        assert.equal(panel.inline.has("transition"), false, "恢复后 panel 还原");
        assert.equal(frame.inline.has("transition"), false, "恢复后 frame 还原");
        assert.equal(instance.disconnected, true, "恢复时 disconnect");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("逐属性保存/恢复 CSS priority：抑制写入 important，外部改了 priority 就保留外部状态", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    // frame 原本就带内联 transition: opacity 1s !important：恢复必须连优先级一起还原。
    const frame = frameElementStub(sink, { transition: "opacity 1s" }, { transition: "important" });
    const panel = panelElementStub(sink);
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const events = [];
      sink.events = events;
      const dispose = installLifecycle({ events, sessions: sessionsFixture(), layout: layoutFixture(events, { openRightbar: true }) });
      timers.flush();
      timers.flush();
      // 抑制写入必须带 important，才能盖住主题里可能出现的 transition: ... !important。
      assert.equal(panel.inline.get("transition"), "none");
      assert.equal(panel.priorities.get("transition"), "important", "抑制写入使用 important");
      assert.equal(panel.priorities.get("--ds-transition-duration-slow"), "important");
      assert.equal(frame.priorities.get("transition"), "important", "覆盖宿主原本的 important");

      // 外部把 panel 的 transition 改成同值但不同优先级：恢复必须保留外部状态。
      panel.style.setProperty("transition", "none");
      assert.equal(panel.style.getPropertyPriority("transition"), "", "外部写入清掉了优先级");
      timers.flush();
      assert.equal(panel.inline.get("transition"), "none", "外部改写（优先级变化）必须保留");
      assert.equal(panel.style.getPropertyPriority("transition"), "", "外部优先级必须保留");
      assert.equal(panel.inline.has("--ds-transition-duration-slow"), false, "未被外部改写的变量照常恢复");
      // frame 的原始内联值与优先级都必须还原。
      assert.equal(frame.inline.get("transition"), "opacity 1s", "原始内联值还原");
      assert.equal(frame.priorities.get("transition"), "important", "原始优先级一并还原");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("localStorage 不可用/抛错与 DOM 探测失败时安全回退：插件不崩溃，自动展开照旧", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const throwingStorage = {
      getItem() { throw new Error("隐私模式拒绝读取"); },
      setItem() { throw new Error("配额已满"); },
    };
    const sharedFrame = frameElementStub({ events: [] });
    const shapes = [
      ["没有 localStorage", undefined, documentStub(sharedFrame)],
      ["localStorage 读写抛错", throwingStorage, documentStub(sharedFrame)],
      ["已有持久标记但探测 AppFrame 抛错", memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        { hidden: false, querySelector() { throw new Error("DOM 不可探测"); } }],
      ["已有持久标记但没有 document", memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }), undefined],
    ];
    for (const [label, storageValue, documentValue] of shapes) {
      const events = [];
      const restoreShape = installGlobals({ localStorage: storageValue, document: documentValue });
      try {
        const sessions = sessionsFixture();
        const dispose = installLifecycle({ events, sessions, layout: layoutFixture(events, { openRightbar: true }) });
        drainTimers(timers);
        assert.deepEqual(events, ["width:320", "open:root-a", "rightbar:true:false"], label + "：页面打开与自动展开都不受影响");
        assert.equal(events.some((event) => event.startsWith("style:")), false, label + "：探测失败时不得改写 frame 样式");
        dispose();
        assert.equal(timers.size(), 0, label + "：dispose 后不得残留 timer");
      } finally {
        restoreShape();
      }
    }
  }));
});

/**
 * 建立「已有持久标记 + 第一轮已准备抑制句柄 + 仍有一个待执行打开重试 timer」的现场：
 * 读面永远没有 active tab（evidence = missing），所以首轮不会结算、会排一次 250ms 重试，
 * 句柄就悬在这次访问的记录上等着被消费或收口。
 */
function pendingSuppressionScenario({ events, frame, panel, better }) {
  const restoreGlobals = installGlobals({
    localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
    document: documentStub(frame, panel),
  });
  const sessions = childSessionsFixture(); // current = child-1
  const dispose = sidebar.installExpertGroupSidebar(
    {
      betterSidebar: better,
      sessions,
      sidebarRight: { active: () => undefined }, // evidence 永远 missing
      layout: layoutFixture(events, { openRightbar: true }),
    },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
  return { sessions, dispose, restoreGlobals };
}

test("current 变为 null 是访问终止边沿：取消旧 timer、恢复样式、断开 observer，恢复 current 后可开新访问", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      const better = {
        registerTab() { return () => {} },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      };
      const scenario = pendingSuppressionScenario({ events, frame, panel, better });
      try {
        timers.flush(); // 第一轮：openTab 之前建立抑制 → openTab → evidence missing → 排一次重试
        assert.equal(panel.inline.get("transition"), "none", "抑制句柄已建立（写在 panel 上）");
        assert.equal(events.filter((event) => event === "open:child-1").length, 1);
        assert.equal(timers.size(), 1, "旧访问仍有一个待执行的重试 timer");
        const opensBefore = events.filter((event) => event === "open:child-1").length;

        // current 变成 null（宿主暂时没有可见 surface）：这是访问终止边沿，必须清理干净。
        scenario.sessions.set({});
        assert.deepEqual([...panel.inline.keys()], [], "current 为 null 必须恢复 panel 内联抑制");
        assert.deepEqual([...frame.inline.keys()], [], "current 为 null 必须恢复 frame 内联抑制");
        assert.equal(observer.instances[0].disconnected, true, "current 为 null 必须 disconnect observer");
        assert.equal(timers.size(), 0, "current 为 null 必须取消旧访问待执行的 timer");
        assert.equal(events.filter((event) => event === "open:child-1").length, opensBefore, "终止边沿不得再发起打开");

        // 恢复 current：必须能开启一次新访问（不能因为前面终止过就永久卡住）。
        scenario.sessions.set({
          current: "child-1",
          byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
        });
        drainTimers(timers, 8);
        assert.ok(events.filter((event) => event === "open:child-1").length > opensBefore, "恢复 current 后必须开启新访问");
        assert.equal(observer.instances.length, 2, "新访问会重新挂 observer");
        assert.equal(rightbarOpens(events).length, 0, "evidence 未确认时绝不调用 layout.openRightbar");
        scenario.dispose();
      } finally {
        scenario.restoreGlobals();
      }
    });
  }));
});

test("Better 禁用或缺 openTab 时也必须结束本次访问并收口句柄：不抛错、不改宽度、不抢右栏，恢复可用后继续", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      const control = { enabled: true };
      const better = {
        registerTab() { return () => {} },
        isTabEnabled: () => control.enabled,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      };
      const scenario = pendingSuppressionScenario({ events, frame, panel, better });
      try {
        timers.flush();
        assert.equal(panel.inline.get("transition"), "none", "抑制句柄已建立");
        assert.equal(timers.size(), 1, "仍有一个待执行重试 timer");
        const opensBefore = events.filter((event) => event.startsWith("open:")).length;
        const widthsBefore = events.filter((event) => event.startsWith("width:")).length;

        // Better 被禁用（例如用户在设置里关掉了 expert-group tab）：这是本次访问的终止边沿。
        control.enabled = false;
        scenario.sessions.set({
          current: "child-1",
          byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
        });
        assert.deepEqual([...panel.inline.keys()], [], "禁用后必须恢复 panel 内联抑制");
        assert.deepEqual([...frame.inline.keys()], [], "禁用后必须恢复 frame 内联抑制");
        assert.equal(observer.instances[0].disconnected, true, "禁用后必须 disconnect observer");
        assert.equal(timers.size(), 0, "禁用后必须取消旧访问待执行 timer");
        assert.equal(events.filter((event) => event.startsWith("open:")).length, opensBefore, "禁用时不得再发起打开");
        assert.equal(events.filter((event) => event.startsWith("width:")).length, widthsBefore, "禁用时不得改写右栏宽度");
        assert.equal(rightbarOpens(events).length, 0, "禁用时绝不抢回用户右栏");

        // Better 恢复可用：必须允许新访问继续（不能因为终止过就永久停摆）。
        control.enabled = true;
        scenario.sessions.set({
          current: "child-1",
          byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
        });
        drainTimers(timers, 8);
        assert.ok(events.filter((event) => event.startsWith("open:")).length > opensBefore, "恢复可用后必须继续打开页面");
        assert.equal(observer.instances.length, 2, "新访问会重新挂 observer");
        scenario.dispose();
      } finally {
        scenario.restoreGlobals();
      }
    });
  }));
});

test("Better 存在但没有 openTab 时同样收口本次访问：不抛错，恢复后继续", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      // 先用具备 openTab 的宿主建立 prepared restore，再模拟宿主丢失 openTab（旧路径/降级）。
      const better = {
        registerTab() { return () => {} },
        isTabEnabled: () => true,
        openTab(seed, scope) { events.push("open:" + scope.sessionId); },
      };
      const scenario = pendingSuppressionScenario({ events, frame, panel, better });
      try {
        timers.flush();
        assert.equal(panel.inline.get("transition"), "none", "抑制句柄已建立");
        assert.equal(timers.size(), 1, "仍有一个待执行重试 timer");
        delete better.openTab;

        // 宿主缺 openTab：同样是本次访问的终止边沿，必须清理且不抛错。
        scenario.sessions.set({
          current: "child-1",
          byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
        });
        assert.deepEqual([...panel.inline.keys()], [], "缺 openTab 时必须恢复 panel 内联抑制");
        assert.equal(observer.instances[0].disconnected, true, "缺 openTab 时必须 disconnect observer");
        assert.equal(timers.size(), 0, "缺 openTab 时必须取消旧访问待执行 timer");
        scenario.dispose();
      } finally {
        scenario.restoreGlobals();
      }
    });
  }));
});

test("成功展开进入待恢复窗口后，访问终止边沿（current 变 null）必须立即 flush 全局待恢复任务", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      const sessions = childSessionsFixture();
      const better = readyBetterFixture({ active: "child-1" });
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: documentStub(frame, panel),
      });
      try {
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        timers.flush(); // 打开页面：openTab 之前写入抑制
        timers.flush(); // 展开：调用 openRightbar 成功 → 把恢复挂到 RAF/fallback（待恢复窗口）
        assert.equal(rightbarOpens(events).length, 1, "成功展开一次");
        assert.equal(panel.inline.get("transition"), "none", "待恢复窗口内仍是抑制状态");
        assert.ok(timers.size() >= 1, "全局待恢复任务（fallback timer）仍在排队");

        // current 变成 null：访问终止边沿必须立刻 flush 全局待恢复任务，不能等 250ms fallback。
        sessions.set({});
        assert.deepEqual([...panel.inline.keys()], [], "终止边沿必须立即恢复 panel（不必等 fallback）");
        assert.deepEqual([...frame.inline.keys()], [], "终止边沿必须立即恢复 frame");
        assert.equal(observer.instances[0].disconnected, true, "终止边沿必须 disconnect observer");
        assert.equal(timers.size(), 0, "全局待恢复 timer 必须被取消，不留任务");
        dispose();
        assert.equal(timers.size(), 0, "dispose 后同样不留任务");
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("Better 禁用进入待恢复窗口后，终止边沿同样立即 flush 全局待恢复任务", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const panel = panelElementStub(sink);
      const events = [];
      sink.events = events;
      const sessions = childSessionsFixture();
      const better = readyBetterFixture({ active: "child-1" });
      const control = { enabled: true };
      const isTabEnabled = better.isTabEnabled;
      better.isTabEnabled = () => control.enabled;
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: documentStub(frame, panel),
      });
      try {
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        timers.flush();
        timers.flush();
        assert.equal(rightbarOpens(events).length, 1, "成功展开一次");
        assert.equal(panel.inline.get("transition"), "none", "待恢复窗口内仍是抑制状态");
        assert.ok(timers.size() >= 1, "全局待恢复任务仍在排队");
        void isTabEnabled;

        // Better 被禁用：终止边沿必须立刻 flush 全局待恢复任务。
        control.enabled = false;
        better.notify();
        assert.deepEqual([...panel.inline.keys()], [], "禁用终止必须立即恢复 panel");
        assert.deepEqual([...frame.inline.keys()], [], "禁用终止必须立即恢复 frame");
        assert.equal(observer.instances[0].disconnected, true, "禁用终止必须 disconnect observer");
        assert.equal(timers.size(), 0, "禁用终止必须取消全局待恢复 timer");
        assert.equal(rightbarOpens(events).length, 1, "禁用终止不得再调用 openRightbar");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("缺 openTab 终止后恢复 openTab：新访问仍会打开页面，且 rightbarPresented 不被错误复位", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const events = [];
    sink.events = events;
    const sessions = childSessionsFixture();
    const better = readyBetterFixture({ active: "child-1" });
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.deepEqual(better.requested(), ["child-1"], "首轮打开页面");
      assert.equal(rightbarOpens(events).length, 1, "成功展开一次 → rightbarPresented 置位");

      // 宿主丢失 openTab：终止边沿清理，但绝不能把 rightbarPresented 复位。
      const openTab = better.openTab;
      delete better.openTab;
      better.notify();
      assert.equal(timers.size(), 0, "终止边沿不得留任务");
      better.openTab = openTab;
      better.notify();
      drainTimers(timers, 6);
      assert.deepEqual(better.requested(), ["child-1", "child-1"], "恢复 openTab 后必须重新打开页面（不永久停摆）");
      assert.equal(rightbarOpens(events).length, 1, "rightbarPresented 不得被错误复位：不重复展开");

      // 再切换 child：页面照常切换，右栏仍不重复展开。
      sessions.set({
        current: "child-2",
        byId: {
          "root-1": { id: "root-1" },
          "child-1": { id: "child-1", parentId: "root-1" },
          "child-2": { id: "child-2", parentId: "root-1" },
        },
      });
      better.commitSession("child-2");
      drainTimers(timers, 6);
      assert.deepEqual(better.requested(), ["child-1", "child-1", "child-2"], "切换 child 仍会切换页面内容");
      assert.equal(rightbarOpens(events).length, 1, "已展示过的右栏不再重复展开");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

/** 装载一个「Better 0.12.x 真实结构 + 已有持久标记」的现场（frame 走 DSH 公开标记，panel/root 走 Better 结构）。 */
function betterScenario({ events, sink, dom, frame, sessions, openTab }) {
  const restoreGlobals = installGlobals({
    localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
    document: documentStub(frame, null, { host: dom.host, root: dom.root }),
  });
  const better = {
    registerTab() { return () => {} },
    isTabEnabled: () => true,
    openTab(seed, scope) { openTab(scope.sessionId); },
    getSnapshot() { return { sessionId: "child-1" }; },
  };
  const dispose = sidebar.installExpertGroupSidebar(
    { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
  return { better, dispose, restoreGlobals };
}

test("Better 0.12.x：右面板与 #root 的过渡必须在 openTab 之前被抑制，且绝不误伤 bottomPanel", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const dom = betterDomFixture(sink);
    const events = [];
    sink.events = events;
    const sessions = childSessionsFixture();
    const scenario = betterScenario({
      events, sink, dom, frame, sessions,
      // Better 的 openTab 会同步把右面板置为展开：动画从这一刻开始。
      openTab(sessionId) { events.push("open:" + sessionId); dom.expandPanel(); events.push("better-panel-expanded"); },
    });
    try {
      timers.flush(); // 打开页面（Better 在这一步同步展开右面板）
      assert.deepEqual(events.slice(0, 10), [
        "width:320",
        "style:--ds-transition-duration-slow=0ms",
        "style:transition=none",
        "better-panel:style:--ds-transition-duration-slow=0ms",
        "better-panel:style:transition=none",
        "better-panel:style:transform=none",
        "better-panel:style:visibility=visible",
        "root:style:--ds-transition-duration-slow=0ms",
        "root:style:transition=none",
        "open:child-1",
      ], "Better 右面板（含 transform/visibility）与 #root 的抑制必须排在 openTab 之前");
      assert.deepEqual(events.slice(10), ["better-panel-expanded"], "抑制之后才发生 Better 面板展开");
      assert.equal(dom.rightPanel.inline.get("transition"), "none", "Better 右面板的真实内联 transition 被置 none");
      assert.equal(dom.rightPanel.inline.get("transform"), "none", "Better 右面板被钉成 transform:none");
      assert.equal(dom.rightPanel.inline.get("visibility"), "visible", "Better 右面板被钉成 visibility:visible");
      assert.equal(dom.root.inline.get("transition"), "none", "#root 的 margin-right 过渡也被抑制");
      assert.equal(dom.root.inline.get("margin-right"), "0px", "#root 的 margin-right 原值不得被改写");
      assert.equal(dom.root.inline.has("transform"), false, "#root 绝不写 transform（只做布局过渡抑制）");
      assert.equal(dom.root.inline.has("visibility"), false, "#root 绝不写 visibility");
      assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 绝不能被误抑制");
      assert.equal(dom.bottomPanel.priorities.size, 0, "bottomPanel 连优先级也不得被写");

      timers.flush(); // 展开：调用 layout.openRightbar（成功）并把恢复排到下一个 timer
      assert.equal(rightbarOpens(events).length, 1, "抑制之后仍正常调用 openRightbar");
      timers.flush();
      assert.deepEqual([...dom.rightPanel.inline.keys()], [], "右面板恢复原值");
      assert.deepEqual([...dom.root.inline.keys()], ["margin-right"], "#root 只剩原本的 margin-right");
      assert.equal(dom.root.style.getPropertyValue("margin-right"), "0px");
      assert.deepEqual([...frame.inline.keys()], [], "AppFrame 同样恢复");
      assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 始终没有被碰过");
      scenario.dispose();
      assert.equal(timers.size(), 0);
    } finally {
      scenario.restoreGlobals();
    }
  }));
});

test("Better 面板延迟挂载：observer 捕获 childList 变化后立即抑制，重复回调不重复写入，bottomPanel 仍免疫", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const dom = betterDomFixture(sink, { mounted: false }); // 抑制开始时 Better 面板还没挂到宿主上
      const events = [];
      sink.events = events;
      const document_ = documentStub(frame, null, { host: dom.host, root: dom.root });
      const sessions = childSessionsFixture();
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: document_,
      });
      try {
        const better = {
          registerTab() { return () => {} },
          isTabEnabled: () => true,
          openTab(seed, scope) {
            events.push("open:" + scope.sessionId);
            dom.mountPanel();            // Better 在打开后才把面板插进宿主（childList 变化）
            observer.fire();
            observer.fire();             // 重复派发不得重复写入
          },
          getSnapshot() { return { sessionId: "child-1" }; },
        };
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        timers.flush();
        assert.equal(dom.rightPanel.inline.get("transition"), "none", "迟到挂载的 Better 面板必须被抑制");
        assert.equal(dom.root.inline.get("transition"), "none", "#root 同样被抑制");
        assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 仍然不被碰");
        assert.equal(events.filter((event) => event.startsWith("better-panel:style:transition=none")).length, 1,
          "两次 observer 回调只允许写一次");
        assert.ok(document_.queries.includes("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"),
          "必须用带边界的 Better 选择器定位面板（不得依赖 CSS module hash）");
        timers.flush();
        timers.flush();
        assert.deepEqual([...dom.rightPanel.inline.keys()], [], "恢复后 Better 面板还原");
        assert.equal(observer.instances[0].disconnected, true, "恢复句柄必须 disconnect observer");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("Better：同一生命周期后续 child 切换不再启动抑制（不重复写 Better 面板/#root 样式）", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const dom = betterDomFixture(sink);
    const events = [];
    sink.events = events;
    const sessions = childSessionsFixture();
    const scenario = betterScenario({
      events, sink, dom, frame, sessions,
      openTab(sessionId) { events.push("open:" + sessionId); dom.expandPanel(); },
    });
    try {
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "首次成功展开一次");
      const betterWrites = events.filter((event) => event.startsWith("better-panel:style:") || event.startsWith("root:style:")).length;
      assert.ok(betterWrites > 0, "首次展开确实抑制过 Better 目标");

      // 切到同一 root 下的新 child：只切页面内容，绝不再启动抑制。
      sessions.set({
        current: "child-2",
        byId: {
          "root-1": { id: "root-1" },
          "child-1": { id: "child-1", parentId: "root-1" },
          "child-2": { id: "child-2", parentId: "root-1" },
        },
      });
      drainTimers(timers, 6);
      assert.equal(
        events.filter((event) => event.startsWith("better-panel:style:") || event.startsWith("root:style:")).length,
        betterWrites,
        "child 切换不得再写 Better 面板/#root 的样式",
      );
      assert.equal(rightbarOpens(events).length, 1, "child 切换不重复展开右栏");
      scenario.dispose();
    } finally {
      scenario.restoreGlobals();
    }
  }));
});

/** current 初始为 root-a、可切到 child-1/child-2 的 sessions 替身（用于「先成功、再切换」的时序用例）。 */
function rootFirstSessionsFixture() {
  const byId = {
    "root-a": { id: "root-a" },
    "child-1": { id: "child-1", parentId: "root-a" },
    "child-2": { id: "child-2", parentId: "root-a" },
  };
  let snapshot = { current: "root-a", byId };
  const listeners = new Set();
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    open() {},
    setCurrent(current) { snapshot = { current, byId }; for (const listener of listeners) listener(); },
  };
}

test("首次展开完成后切换到 child：新 surface 的 openTab 之前仍必须抑制 panel 的 expanded transform", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const events = [];
    sink.events = events;
    const sessions = rootFirstSessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    // 模拟 DSH 原生面板：openTab 在同一个提交里把该 surface 的 panel 置为 expanded（transform: none 过渡开始）。
    const panelState = { open: false };
    const originalOpenTab = better.openTab;
    better.openTab = (seed, scope) => {
      events.push("open:" + scope.sessionId);
      panelState.open = scope.sessionId === "child-1"; // child surface 的 expanded 由这次 openTab 触发
      events.push("panel-expanded:" + scope.sessionId);
      originalOpenTab.call(better, seed, scope);
    };
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.deepEqual(better.requested(), ["root-a"], "第一次自动打开 root-a 页面");
      assert.equal(rightbarOpens(events).length, 1, "第一次自动打开成功展开右栏 → rightbarPresented = true");
      assert.deepEqual([...panel.inline.keys()], [], "首次展开的抑制已按恢复窗口归还（pending restore 完成）");

      // 切到 child-1：这是**后续** surface 切换，rightbarPresented 已经为 true。
      const mark = events.length;
      sessions.setCurrent("child-1");
      better.commitSession("child-1");
      timers.flush(); // 打开 child-1 页面（openTab 会同步把该 surface 的 panel 置为 expanded）
      const cycle = events.slice(mark);
      const firstSuppress = cycle.findIndex((event) => event.startsWith("panel:style:"));
      const firstOpen = cycle.indexOf("open:child-1");
      const expanded = cycle.indexOf("panel-expanded:child-1");
      assert.ok(panelState.open === true && expanded !== -1, "openTab 确实同步把新 surface 的 panel 置为 expanded");
      assert.ok(firstSuppress !== -1, "后续 surface 切换也必须在 openTab 前抑制 panel 过渡（旧实现漏掉这里）");
      assert.ok(firstSuppress < firstOpen, "抑制必须早于 openTab（expanded transform 从那一刻开始）");
      assert.ok(firstSuppress < expanded, "抑制必须早于面板进入 expanded");
      assert.equal(cycle.includes("panel:style:transition=none"), true, "panel 必须被置 transition:none");
      assert.equal(rightbarOpens(events).length, 1, "rightbarPresented 语义：后续切换绝不再调用 layout.openRightbar");

      // 两帧/fallback 之后必须归还样式，不能长期停在 transition:none。
      drainTimers(timers, 6);
      assert.deepEqual([...panel.inline.keys()], [], "切换期间的抑制必须在恢复窗口后归还");
      assert.equal(timers.size(), 0, "不得残留 timer");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("持久标记存在时连续 root/child 切换都要在 openTab 前抑制且不重复 openRightbar；无标记首次打开保留动画", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // —— 有持久标记：每次自动打开另一个 surface 都在 openTab 前抑制，但不再调用 openRightbar ——
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const events = [];
    sink.events = events;
    const sessions = rootFirstSessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    const originalOpenTab = better.openTab;
    better.openTab = (seed, scope) => { events.push("open:" + scope.sessionId); originalOpenTab.call(better, seed, scope); };
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "首轮成功展开一次");

      for (const target of ["child-1", "child-2", "root-a"]) {
        const mark = events.length;
        sessions.setCurrent(target);
        better.commitSession(target);
        drainTimers(timers, 6);
        const cycle = events.slice(mark);
        const firstSuppress = cycle.findIndex((event) => event.startsWith("panel:style:"));
        const firstOpen = cycle.indexOf("open:" + target);
        assert.ok(firstSuppress !== -1 && firstOpen !== -1 && firstSuppress < firstOpen,
          "切到 " + target + " 时抑制必须早于 openTab");
        assert.deepEqual([...panel.inline.keys()], [], "切到 " + target + " 后必须归还样式");
        assert.equal(rightbarOpens(events).length, 1, "切到 " + target + " 不得再次调用 layout.openRightbar");
      }
      dispose();
    } finally {
      restoreGlobals();
    }

    // —— 无持久标记：首次打开保留动画，全程不得写任何抑制样式 ——
    const freshSink = { events: [] };
    const freshFrame = frameElementStub(freshSink);
    const freshPanel = panelElementStub(freshSink);
    const freshEvents = [];
    freshSink.events = freshEvents;
    const freshSessions = rootFirstSessionsFixture();
    const freshBetter = readyBetterFixture({ active: "root-a" });
    const freshRestore = installGlobals({
      localStorage: memoryStorage(),
      document: documentStub(freshFrame, freshPanel),
    });
    try {
      const disposeFresh = sidebar.installExpertGroupSidebar(
        { betterSidebar: freshBetter, sessions: freshSessions, layout: layoutFixture(freshEvents, { openRightbar: true }) },
        { react, primitives, sessions: freshSessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(freshEvents).length, 1, "无标记首次打开照常展开一次（动画保留）");
      assert.equal(freshEvents.some((event) => event.includes("style:")), false, "无持久标记路径不得写任何抑制样式");
      assert.deepEqual([...freshPanel.inline.keys()], [], "无持久标记时 panel 不被改写");
      assert.deepEqual([...freshFrame.inline.keys()], [], "无持久标记时 frame 不被改写");
      disposeFresh();
    } finally {
      freshRestore();
    }
  }));
});

test("Better 0.12.x：后续 child 切换同样抑制右面板与 #root，bottomPanel 始终免疫", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const dom = betterDomFixture(sink);
    const events = [];
    sink.events = events;
    const sessions = rootFirstSessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    const originalOpenTab = better.openTab;
    better.openTab = (seed, scope) => {
      events.push("open:" + scope.sessionId);
      dom.expandPanel();
      originalOpenTab.call(better, seed, scope);
    };
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, null, { host: dom.host, root: dom.root }),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "首轮成功展开一次");
      assert.deepEqual([...dom.rightPanel.inline.keys()], [], "首轮抑制已归还");
      assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 从未被碰");

      // 后续 child 切换：Better 右面板与 #root 同样必须在 openTab 之前被抑制。
      const mark = events.length;
      sessions.setCurrent("child-1");
      better.commitSession("child-1");
      timers.flush();
      const cycle = events.slice(mark);
      const firstBetter = cycle.findIndex((event) => event.startsWith("better-panel:style:"));
      const firstRoot = cycle.findIndex((event) => event.startsWith("root:style:"));
      const firstOpen = cycle.indexOf("open:child-1");
      assert.ok(firstBetter !== -1 && firstRoot !== -1, "后续切换必须同时抑制 Better 右面板与 #root");
      assert.ok(firstBetter < firstOpen && firstRoot < firstOpen, "抑制必须早于 openTab");
      assert.equal(cycle.some((event) => event.startsWith("bottom-panel:style:")), false, "bottomPanel 不得被误抑制");
      assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 始终免疫");
      assert.equal(rightbarOpens(events).length, 1, "后续切换不得再次调用 layout.openRightbar");

      drainTimers(timers, 6);
      assert.deepEqual([...dom.rightPanel.inline.keys()], [], "切换后 Better 面板归还");
      assert.deepEqual([...dom.root.inline.keys()], ["margin-right"], "#root 归还且保留原始 margin-right");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("后续 surface 切换：右 panel 在提交窗口内必须同时钉住 transition/transform/visibility，且绝不写 hidden/translateX", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const events = [];
    sink.events = events;
    const sessions = rootFirstSessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    const originalOpenTab = better.openTab;
    better.openTab = (seed, scope) => {
      events.push("open:" + scope.sessionId);
      // 模拟 DSH：child surface 的 panel 在这次提交里从 collapsed 变成 open
      // （CSS 由 data-sidebar-right-open 驱动：collapsed 是 translateX(100%) + visibility:hidden）。
      if (scope.sessionId === "child-1") events.push("panel-commit:collapsed->open");
      originalOpenTab.call(better, seed, scope);
    };
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "root-a 首轮成功展开一次");
      assert.deepEqual([...panel.inline.keys()], [], "首轮抑制已归还");

      const mark = events.length;
      sessions.setCurrent("child-1");
      better.commitSession("child-1");
      timers.flush();
      const cycle = events.slice(mark);
      const firstPanelWrite = cycle.findIndex((event) => event.startsWith("panel:style:"));
      const firstOpen = cycle.indexOf("open:child-1");
      assert.ok(firstPanelWrite !== -1 && firstOpen !== -1 && firstPanelWrite < firstOpen,
        "钉住 panel 的写入必须早于 openTab（collapsed→open 的提交从那一刻开始）");
      assert.equal(panel.inline.get("transition"), "none", "transition=none 消除滑动");
      assert.equal(panel.inline.get("transform"), "none", "transform=none 消除 collapsed 瞬间");
      assert.equal(panel.inline.get("visibility"), "visible", "visibility=visible 消除 hidden 瞬间");
      assert.equal(panel.priorities.get("transform"), "important", "transform 以 important 写入");
      assert.equal(panel.priorities.get("visibility"), "important", "visibility 以 important 写入");
      assert.equal(cycle.some((event) => event.includes("translateX") || event.includes("hidden")), false,
        "抑制期间绝不能写出 hidden/translateX（那才是闪烁来源）");
      assert.equal(rightbarOpens(events).length, 1, "后续切换不得调用 layout.openRightbar");

      drainTimers(timers, 6);
      assert.deepEqual([...panel.inline.keys()], [], "恢复后只回到原始 inline（本来没有就删除）");
      assert.deepEqual([...panel.priorities.keys()], [], "优先级同样归还");
      assert.equal(timers.size(), 0, "不得残留 timer");
      dispose();
    } finally {
      restoreGlobals();
    }
  }));
});

test("panel 延迟插入（collapsed 节点）：observer 必须在恢复窗口内钉住三项，bottomPanel 不得被写入", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const sink = { events: [] };
      const frame = frameElementStub(sink);
      const dom = betterDomFixture(sink, { mounted: false }); // 抑制开始时 Better panel 还不存在
      const events = [];
      sink.events = events;
      const document_ = documentStub(frame, null, { host: dom.host, root: dom.root });
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const originalOpenTab = better.openTab;
      better.openTab = (seed, scope) => {
        events.push("open:" + scope.sessionId);
        dom.mountPanel();   // Better 在这次提交后才把 collapsed 的 panel 插进宿主
        observer.fire();    // childList 变化触发 observer（真实浏览器里是微任务）
        originalOpenTab.call(better, seed, scope);
      };
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: document_,
      });
      try {
        const dispose = sidebar.installExpertGroupSidebar(
          { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
          { react, primitives, sessions, resolveRootSessionId: rootIdOf },
        );
        timers.flush();
        assert.equal(dom.rightPanel.inline.get("transition"), "none", "迟到插入的 panel 也要抑制 transition");
        assert.equal(dom.rightPanel.inline.get("transform"), "none", "迟到插入的 panel 也要钉住 transform");
        assert.equal(dom.rightPanel.inline.get("visibility"), "visible", "迟到插入的 panel 也要钉住 visibility");
        assert.equal(dom.bottomPanel.inline.size, 0, "bottomPanel 不得被写入");
        assert.equal(dom.bottomPanel.priorities.size, 0, "bottomPanel 连优先级也不得被写");
        assert.ok(document_.queries.includes("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"),
          "仍然用带边界的稳定选择器定位 Better 面板");

        drainTimers(timers, 6);
        assert.deepEqual([...dom.rightPanel.inline.keys()], [], "恢复窗口结束后归还 panel 样式");
        assert.deepEqual([...dom.bottomPanel.inline.keys()], [], "bottomPanel 始终没有被碰");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("用户手动关闭（frame 报 collapsed）或无持久标记：绝不写 transform/visibility，也不改变首次动画与切换语义", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    // A) 持久标记存在，但 AppFrame 明确报告右栏已折叠（用户手动关闭 / 从未展开）：
    //    切换时仍可抑制 transition，但绝不能把 panel 钉成可见（那就是抢回用户右栏）。
    const sink = { events: [] };
    const frame = frameElementStub(sink);
    const panel = panelElementStub(sink);
    const events = [];
    sink.events = events;
    const sessions = rootFirstSessionsFixture();
    const better = readyBetterFixture({ active: "root-a" });
    const restoreGlobals = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: documentStub(frame, panel, null, { collapsed: true }),
    });
    try {
      const dispose = sidebar.installExpertGroupSidebar(
        { betterSidebar: better, sessions, layout: layoutFixture(events, { openRightbar: true }) },
        { react, primitives, sessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      sessions.setCurrent("child-1");
      better.commitSession("child-1");
      drainTimers(timers, 6);
      assert.equal(events.some((event) => event.includes("panel:style:transform") || event.includes("panel:style:visibility")), false,
        "右栏已折叠时绝不写 panel 的 transform/visibility（不抢回用户右栏）");
      assert.deepEqual([...panel.inline.keys()], [], "panel 不应残留任何内联样式");
      assert.equal(rightbarOpens(events).length, 1, "已展示过的右栏不再重复展开");
      dispose();
    } finally {
      restoreGlobals();
    }

    // B) 无持久标记：首次打开保留动画，全程不写任何 transform/visibility。
    const freshSink = { events: [] };
    const freshFrame = frameElementStub(freshSink);
    const freshPanel = panelElementStub(freshSink);
    const freshEvents = [];
    freshSink.events = freshEvents;
    const freshSessions = rootFirstSessionsFixture();
    const freshBetter = readyBetterFixture({ active: "root-a" });
    const freshRestore = installGlobals({ localStorage: memoryStorage(), document: documentStub(freshFrame, freshPanel) });
    try {
      const disposeFresh = sidebar.installExpertGroupSidebar(
        { betterSidebar: freshBetter, sessions: freshSessions, layout: layoutFixture(freshEvents, { openRightbar: true }) },
        { react, primitives, sessions: freshSessions, resolveRootSessionId: rootIdOf },
      );
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(freshEvents).length, 1, "无标记首次打开照常展开一次（动画保留）");
      assert.equal(freshEvents.some((event) => event.includes("style:")), false, "无持久标记路径不得写任何抑制样式");
      assert.deepEqual([...freshPanel.inline.keys()], [], "无标记时 panel 不被改写");
      disposeFresh();
    } finally {
      freshRestore();
    }
  }));
});

/**
 * 通用假元素：属性表 + 子树 + 样式/克隆/矩形/输入值，供「原生右栏连续性遮罩」测试使用（不依赖真实浏览器）。
 * 所有方法都刻意保持最小实现，只覆盖遮罩实现真正调用的 DOM 面。
 */
function fakeElement(tag, attributes = {}) {
  const children = [];
  return {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    attributes: { ...attributes },
    children,
    childNodes: children,
    parentNode: null,
    textContent: "",
    style: {},
    dataset: {},
    value: undefined,
    get id() { return this.attributes.id ?? ""; },
    set id(value) { this.attributes.id = String(value); },
    /** 第一个子节点：设置页导航适配把自有图标插在它之前（图标列在最左，label 位置不变）。 */
    get firstChild() { return this.children[0] ?? null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); },
    removeAttribute(name) { delete this.attributes[name]; },
    getBoundingClientRect() { return { left: 100, top: 20, width: 360, height: 800 }; },
    cloneNode() {
      const copy = fakeElement(this.tagName, { ...this.attributes });
      copy.style = { ...this.style };
      copy.value = this.value;
      copy.textContent = this.textContent;
      for (const child of this.children) copy.appendChild(child.cloneNode(true));
      return copy;
    },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child, reference) {
      const index = reference === null || reference === undefined ? this.children.length : this.children.indexOf(reference);
      if (index === -1) throw new Error("insertBefore: 参照节点不是当前节点的子节点");
      child.parentNode = this;
      this.children.splice(index, 0, child);
      return child;
    },
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      if (child.parentNode === this) child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode !== null) this.parentNode.removeChild(this); },
    matches(selector) {
      const text = String(selector);
      // 属性选择器同时支持 `[name]` 与 `[name="value"]`（设置页适配按 role="dialog" 定位面板），
      // 其余保持既有的标签名比较；两类之外的选择器一律不命中，与原来的最小实现同语义。
      const match = /^\[([^\]=\s]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(text);
      if (match !== null) {
        if (!Object.prototype.hasOwnProperty.call(this.attributes, match[1])) return false;
        const expected = match[2] ?? match[3] ?? match[4];
        if (expected === undefined) return true;
        const actual = this.attributes[match[1]];
        return actual !== undefined && actual !== null && String(actual) === expected;
      }
      return this.tagName === text.toUpperCase();
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) {
      const result = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    },
  };
}

/** 连续性遮罩测试用 document 替身：body + createElement + 在 body 子树内查询。 */
function continuityDocumentStub() {
  const body = fakeElement("body");
  const document_ = {
    nodeType: 9,
    hidden: false,
    body,
    documentElement: fakeElement("html"),
    createElement(tag) { return fakeElement(tag); },
    getElementById(id) {
      if (body.id === id) return body;
      return body.querySelectorAll("[id]").find((node) => node.id === id) ?? null;
    },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  return { document: document_, body };
}

const CONTINUITY_OVERLAY_ID = "dsh-expert-group-rightbar-continuity-overlay";
const continuityOverlayOf = (dom) => dom.document.getElementById(CONTINUITY_OVERLAY_ID);
const nativePanelCountOf = (dom) => dom.document.querySelectorAll("[data-sidebar-right-panel]").length;

/**
 * 安装插件并跑完首轮「自动打开 + 展开右栏」（此刻 rightbarPresented=true），返回 dispose。
 * 注意这里**不**执行任何切换：切换各用例自己发起，才能在 deferred 打开轮之前断言遮罩状态。
 */
function armContinuityScenario({ timers, events, sessions, better, layout }) {
  const dispose = sidebar.installExpertGroupSidebar(
    { betterSidebar: better, sessions, layout },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
  drainTimers(timers, 6);
  return dispose;
}

/** 造一个「已 open 的旧原生 panel + 一个含 id 与输入框的子树」。 */
function legacyNativePanel(dom) {
  const panel = fakeElement("div", { "data-sidebar-right-panel": "push", "data-sidebar-right-open": "" });
  const inner = fakeElement("div", { id: "deg-inner-block" });
  const input = fakeElement("input", { id: "deg-note-input" });
  input.value = "typed-by-user";
  inner.appendChild(input);
  panel.appendChild(inner);
  dom.body.appendChild(panel);
  return panel;
}

test("原生右栏连续性遮罩：必须在 openTargets 内、deferred 打开轮之前抢拍（旧 panel 仍存在），新 panel open 后移除", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    withFakeObserver((observer) => {
      const dom = continuityDocumentStub();
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: dom.document,
      });
      try {
        const events = [];
        const sessions = rootFirstSessionsFixture();
        const better = readyBetterFixture({ active: "root-a" });
        const oldPanel = legacyNativePanel(dom);
        const dispose = armContinuityScenario({
          timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }),
        });
        assert.equal(rightbarOpens(events).length, 1, "首轮成功展开一次");
        assert.equal(continuityOverlayOf(dom), null, "首次自动打开不得创建遮罩（只对后续切换启用）");

        // 切到 child：openTargets 是同步跑的，deferred 的打开轮还没执行——遮罩必须已经在这里创建。
        // 真实时序（诊断闭环）：openTargets(current=child) → 旧 panel removed → 新 panel added(collapsed)
        // → runSurfaceOpen。等到 runSurfaceOpen 再 clone，旧 panel 早就没了。
        sessions.setCurrent("child-1");
        const host = continuityOverlayOf(dom);
        assert.ok(host !== null, "必须在 openTargets 内就抢拍（旧 panel 仍挂在 DOM 上），不能等到 runSurfaceOpen");
        assert.equal(dom.body.children.includes(oldPanel), true, "此刻旧 panel 仍存在，正是唯一可复制的窗口");
        assert.equal(nativePanelCountOf(dom), 1, "遮罩不得被当成额外的右栏 panel（克隆已降级为纯视觉节点）");

        const style = String(host.getAttribute("style") ?? "");
        assert.ok(style.includes("position:fixed"), "遮罩必须 fixed");
        assert.ok(style.includes("left:100px") && style.includes("top:20px") && style.includes("width:360px") && style.includes("height:800px"),
          "遮罩必须固定在旧 panel 的 getBoundingClientRect() 上，实际：" + style);
        assert.ok(style.includes("z-index:2147482999"), "z-index 必须高于右栏 panel");
        assert.ok(style.includes("pointer-events:none"), "遮罩不得拦截交互");
        assert.equal(host.getAttribute("aria-hidden"), "true", "遮罩必须对可访问性隐藏");
        assert.ok(style.includes("overflow:hidden"), "遮罩必须裁剪");
        assert.ok(style.includes("background:inherit"), "背景必须继承（透明），不得引入新的视觉底色");

        const clone = host.children[0];
        assert.ok(clone !== undefined, "必须含克隆的视觉壳");
        assert.equal(clone.querySelectorAll("[id]").length, 0, "克隆子树内所有 id 必须移除（避免 DOM id 重复）");
        assert.equal(clone.getAttribute("data-sidebar-right-panel"), null,
          "克隆必须去掉右栏 panel 身份标记，否则遮罩会被误判成新 panel 而自我释放");
        assert.equal(clone.getAttribute("data-sidebar-right-open"), "",
          "克隆必须保留 data-sidebar-right-open（原生 CSS 用它决定可见状态）");
        const clonedInput = clone.querySelector("input");
        assert.ok(clonedInput !== undefined, "克隆必须包含输入控件节点");
        assert.equal(clonedInput.value, "", "克隆里的输入值必须清空（不携带用户数据）");
        assert.equal(clonedInput.textContent, "", "克隆里的输入文本必须清空");
        assert.equal(clone.style.pointerEvents, "none", "克隆本身也必须 pointer-events:none");

        // 模拟 DSH 原生 session-key 重挂载：旧 panel 被移除（新 panel 还没来）→ 遮罩必须保持
        dom.body.removeChild(oldPanel);
        observer.fire();
        assert.ok(continuityOverlayOf(dom) !== null, "旧 panel 移除后遮罩必须保持，覆盖卸载空窗");

        // 宿主提交新的 active surface（同一 session 的代次变化）：中途通知不得丢掉正在覆盖空窗的遮罩
        better.commitSession("child-1");
        assert.ok(continuityOverlayOf(dom) !== null, "同一 surface 的代次变化不得中途释放遮罩");

        // 新 panel added(collapsed)：还没 open → 遮罩继续保持
        const newPanel = fakeElement("div", { "data-sidebar-right-panel": "push" });
        dom.body.appendChild(newPanel);
        observer.fire();
        assert.ok(continuityOverlayOf(dom) !== null, "新 panel 还没 open 时遮罩必须保持");

        // 新 panel open（data-sidebar-right-open + aria-hidden 非 true）→ 遮罩移除
        newPanel.setAttribute("data-sidebar-right-open", "");
        observer.fire();
        assert.equal(continuityOverlayOf(dom), null, "新 panel open 后必须移除遮罩");

        // 收尾：deferred 打开轮照常执行，但绝不再次调用 layout.openRightbar
        timers.flush();
        assert.equal(rightbarOpens(events).length, 1, "后续切换不得再次调用 layout.openRightbar");
        assert.equal(continuityOverlayOf(dom), null, "落定后不得残留遮罩");
        dispose();
      } finally {
        restoreGlobals();
      }
    });
  }));
});

test("原生右栏连续性遮罩：500ms fallback 与访问终止（dispose/current null/Better 禁用/打开失败）都必须释放", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const build = () => {
      const dom = continuityDocumentStub();
      legacyNativePanel(dom);
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const restoreGlobals = installGlobals({
        localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
        document: dom.document,
      });
      return { dom, events, sessions, better, restoreGlobals };
    };

    // A) 新 panel 一直不 open：500ms 兜底必须移除遮罩
    const a = build();
    try {
      const disposeA = armContinuityScenario({ timers, events: a.events, sessions: a.sessions, better: a.better, layout: layoutFixture(a.events, { openRightbar: true }) });
      a.sessions.setCurrent("child-1");
      assert.ok(continuityOverlayOf(a.dom) !== null, "切换时创建了遮罩");
      assert.ok(timers.delays().includes(500), "必须设置 500ms 兜底释放，实际：" + timers.delays().join(","));
      drainTimers(timers, 6);
      assert.equal(continuityOverlayOf(a.dom), null, "兜底到点必须移除遮罩，绝不长期遮盖 UI");
      disposeA();
    } finally {
      a.restoreGlobals();
    }

    // B) dispose 释放
    const b = build();
    try {
      const disposeB = armContinuityScenario({ timers, events: b.events, sessions: b.sessions, better: b.better, layout: layoutFixture(b.events, { openRightbar: true }) });
      b.sessions.setCurrent("child-1");
      assert.ok(continuityOverlayOf(b.dom) !== null);
      disposeB();
      assert.equal(continuityOverlayOf(b.dom), null, "dispose 必须移除遮罩");
      assert.equal(timers.size(), 0, "dispose 后不得残留 timer");
    } finally {
      b.restoreGlobals();
    }

    // C) current 变 null（访问终止边沿）释放
    const c = build();
    try {
      const disposeC = armContinuityScenario({ timers, events: c.events, sessions: c.sessions, better: c.better, layout: layoutFixture(c.events, { openRightbar: true }) });
      c.sessions.setCurrent("child-1");
      assert.ok(continuityOverlayOf(c.dom) !== null);
      c.sessions.setCurrent(null);
      assert.equal(continuityOverlayOf(c.dom), null, "current 变 null 必须释放遮罩");
      disposeC();
    } finally {
      c.restoreGlobals();
    }

    // D) Better 被禁用（enabled=false）后收到通知：访问终止必须释放遮罩
    const d = build();
    try {
      const control = { enabled: true };
      d.better.isTabEnabled = () => control.enabled;
      const disposeD = armContinuityScenario({ timers, events: d.events, sessions: d.sessions, better: d.better, layout: layoutFixture(d.events, { openRightbar: true }) });
      d.sessions.setCurrent("child-1");
      assert.ok(continuityOverlayOf(d.dom) !== null);
      control.enabled = false;
      d.better.notify();
      assert.equal(continuityOverlayOf(d.dom), null, "Better 禁用终止必须释放遮罩");
      disposeD();
    } finally {
      d.restoreGlobals();
    }

    // E) 宿主一直没提交新 surface（readiness 重试用尽）：绝不发会落到旧 binding 的 openTab，
    //    但遮罩同样必须收口。
    const e = build();
    try {
      const disposeE = armContinuityScenario({ timers, events: e.events, sessions: e.sessions, better: e.better, layout: layoutFixture(e.events, { openRightbar: true }) });
      const requestsBefore = e.better.requested().length; // 首轮 root-a 的请求不算在内
      e.sessions.setCurrent("child-1"); // 注意：不 commitSession，宿主仍停在 root-a
      assert.ok(continuityOverlayOf(e.dom) !== null);
      drainTimers(timers, 8);
      assert.equal(e.better.requested().length, requestsBefore, "宿主未提交时绝不发 openTab 请求（避免落到旧 binding）");
      assert.equal(continuityOverlayOf(e.dom), null, "宿主未提交且重试用尽后不得留下遮罩");
      disposeE();
    } finally {
      e.restoreGlobals();
    }

    // F) 宿主已提交，但 openTab 每次都抛错（有限重试用尽）：同样不得留下遮罩
    const f = build();
    try {
      const disposeF = armContinuityScenario({ timers, events: f.events, sessions: f.sessions, better: f.better, layout: layoutFixture(f.events, { openRightbar: true }) });
      f.sessions.setCurrent("child-1");
      f.better.commitSession("child-1");
      assert.ok(continuityOverlayOf(f.dom) !== null);
      f.better.failNextOpens(10);
      drainTimers(timers, 8);
      // 首次尝试 + MAX_SURFACE_OPEN_RETRIES 次补偿重试都失败后才收手（>=2 即证明重试真的跑过）。
      assert.ok(f.better.failedAttempts() >= 2,
        "必须真的走完有限重试（失败请求数：" + f.better.failedAttempts() + "）");
      assert.equal(continuityOverlayOf(f.dom), null, "openTab 失败且重试用尽后不得留下遮罩");
      disposeF();
    } finally {
      f.restoreGlobals();
    }
  }));
});

test("原生右栏连续性遮罩：缺 document/body/克隆/矩形/observer 时安全降级不抛错", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const switchToChild = (timersRef, sessions, better) => { sessions.setCurrent("child-1"); void better; void timersRef; };

    // A) 完全没有 document
    const noDoc = installGlobals({ document: undefined });
    try {
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const dispose = armContinuityScenario({ timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }) });
      sessions.setCurrent("child-1");
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "没有 document 时插件照常工作（不抛错）");
      dispose();
    } finally {
      noDoc();
    }

    // B) panel 的 getBoundingClientRect 抛错：不得创建遮罩，也不得影响打开流程
    const rectDom = continuityDocumentStub();
    const rectPanel = legacyNativePanel(rectDom);
    rectPanel.getBoundingClientRect = () => { throw new Error("rect 不可用"); };
    const rectRestore = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: rectDom.document,
    });
    try {
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const dispose = armContinuityScenario({ timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }) });
      sessions.setCurrent("child-1");
      assert.equal(continuityOverlayOf(rectDom), null, "getBoundingClientRect 抛错时不得创建遮罩");
      drainTimers(timers, 6);
      assert.equal(rightbarOpens(events).length, 1, "矩形读取失败不影响打开流程");
      dispose();
    } finally {
      rectRestore();
    }

    // C) panel 没有 cloneNode：不得创建遮罩
    const noCloneDom = continuityDocumentStub();
    const noClonePanel = legacyNativePanel(noCloneDom);
    noClonePanel.cloneNode = undefined;
    const noCloneRestore = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: noCloneDom.document,
    });
    try {
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const dispose = armContinuityScenario({ timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }) });
      sessions.setCurrent("child-1");
      assert.equal(continuityOverlayOf(noCloneDom), null, "缺少 cloneNode 时不得创建遮罩");
      dispose();
    } finally {
      noCloneRestore();
    }

    // D) 没有 MutationObserver：仍创建遮罩，但必须靠 500ms 兜底释放
    const noObserverDom = continuityDocumentStub();
    legacyNativePanel(noObserverDom);
    const noObserverRestore = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: noObserverDom.document,
      MutationObserver: undefined,
    });
    try {
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const dispose = armContinuityScenario({ timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }) });
      sessions.setCurrent("child-1");
      assert.ok(continuityOverlayOf(noObserverDom) !== null, "没有 observer 时仍应创建遮罩（靠兜底释放）");
      assert.ok(timers.delays().includes(500), "没有 observer 时兜底是唯一的释放路径");
      drainTimers(timers, 6);
      assert.equal(continuityOverlayOf(noObserverDom), null, "没有 observer 时兜底必须释放遮罩");
      dispose();
    } finally {
      noObserverRestore();
    }

    // E) 没有 body：不得创建、不得抛错
    const noBodyDom = { hidden: false, documentElement: { nodeType: 1 }, createElement: () => fakeElement("div"), querySelector: () => null };
    const noBodyRestore = installGlobals({
      localStorage: memoryStorage({ "dsh-expert-group:rightbar-presented:v1": "1" }),
      document: noBodyDom,
    });
    try {
      const events = [];
      const sessions = rootFirstSessionsFixture();
      const better = readyBetterFixture({ active: "root-a" });
      const dispose = armContinuityScenario({ timers, events, sessions, better, layout: layoutFixture(events, { openRightbar: true }) });
      switchToChild(timers, sessions, better);
      assert.equal(rightbarOpens(events).length, 1, "没有 body 时打开流程不受影响");
      dispose();
    } finally {
      noBodyRestore();
    }
  }));
});

/**
 * 行尾侧栏箭头与任务名导航的 install 契约（新 DSH）。
 *
 * client-entry.js 并不把 uiWorkspace / sidebarRight 注入 deps：面板只能从 install ctx 解析它们。
 * 因此这里走完整装配路径——真实 install、真实注册进宿主的组件、真实点击处理函数——逐项验证：
 * 1. 点击任务名走 `uiWorkspace.openSession(SubagentAddress)`（地址优先于裸 session id）；
 * 2. 点击箭头先调用公开 `sidebarRight.split()`，再把返回的 paneId 传给
 *    `openResource(address, { kind: "subagentchat", paneId, preferNewPane: false })`，保证子代理资源
 *    与 Expert Group 位于不同 pane；只关闭该 tab（右栏宽度由 install 侧按当前 surface 会话管理）；
 *    地址逐字节等于 DSH 原生子代理行使用的规范形状，且不产生任何主视图导航；
 * 3. 箭头点击必须拦下冒泡（它绝不能触发任务名的导航）。
 */
test("install 契约：面板经 install ctx 解析 uiWorkspace/sidebarRight，行尾箭头只打开右侧栏资源", async () => {
  // 本用例要断言真实渲染结果（行与箭头），因此必须先装载模型模块：面板只通过
  // globalThis 上的 IIFE 检查点取归一化实现，缺它时快照会被判为无效格式。
  // 票据 29：模型拆为 normalize → format → 薄门面，按装配顺序依次求值（门面在装载期读取两者检查点）。
  await import("../client-expert-group-model-normalize.js");
  await import("../client-expert-group-model-format.js");
  await import("../client-expert-group-model.js");
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restoreGlobals = installGlobals({
    window: { innerWidth: 1000 },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  });
  const navTargets = [];
  const resourceCalls = [];
  const splitCalls = [];
  const openSequence = [];
  const widthSequence = [];
  let rightbarWidth = 200; // 20% 的 Expert Group-only 初始状态。
  let pendingRightbarWidth = null;
  let openTabsSnapshot = [];
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [{
        id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
        role: "fixer", content: "子代理 A 的任务", status: "running", continuable: true,
      }],
    },
  };
  // sessions 替身：会话投影给出 child-a 的合法 mode（只带身份类字段），
  // byId 给出权威 title 与运行状态，subagentAddress 给出权威地址（优先使用）。
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: "root-a",
        byId: {
          "root-a": { id: "root-a", title: "root-a" },
          "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话", running: true },
        },
        projectionsBySession: {
          "root-a": { values: { subagentCatalog: [{ id: "child-a", createdAt: 1, mode: "continuable", label: "子代理 A" }] } },
        },
      }),
      subscribe: () => () => {},
    },
    subagentAddress: (childId) => (childId === "child-a"
      ? { parentSessionId: "root-a", childSessionId: "child-a", mode: "continuable" }
      : undefined),
  };
  const uiWorkspace = { openSession(target) { navTargets.push(target); } };
  const sidebarRight = {
    openTabs: { getSnapshot: () => openTabsSnapshot },
    active() { return { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" }; },
    split(paneId) {
      splitCalls.push(paneId);
      openSequence.push("split");
      if (rightbarWidth < 450) return undefined; // 20% 时宿主按契约拒绝分栏。
      openTabsSnapshot = [{ sessionId: "root-a", tabId: "guide-1", kind: "guide", contentId: "sidebar://guide" }];
      return "pane-child";
    },
    openResource(address, options) {
      resourceCalls.push({ address, options });
      openSequence.push("openResource");
    },
  };
  const registered = [];
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {}; },
    isTabEnabled: () => true,
    openTab() {},
  };
  const ctx = {
    // 真实宿主用 Cordis 服务查找：面板必须经 ctx.get 拿到这两个新契约入口。
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "uiWorkspace") return uiWorkspace;
      if (name === "sidebarRight") return sidebarRight;
      if (name === "betterSidebar") return betterSidebar;
      return undefined;
    },
    sessions,
  };
  const layout = {
    panels: {
      setRightbar(px) {
        pendingRightbarWidth = px;
        widthSequence.push(px);
        openSequence.push("width:" + px);
        // 模拟宿主 store action 已返回，但 DockLayout 的 onRoom 仍要等一次提交。
        queueMicrotask(() => {
          if (pendingRightbarWidth === px) {
            rightbarWidth = px;
            pendingRightbarWidth = null;
          }
        });
      },
    },
  };
  const dispose = sidebar.installExpertGroupSidebar(ctx, {
    react: runtime.react,
    primitives,
    sessions,
    layout,
    resolveRootSessionId: (id) => id,
    requestPluginRpc: () => ({ ok: true, async json() { return { snapshot: hostSnapshot }; } }),
  });
  const component = registered[0]?.component;
  assert.equal(typeof component, "function", "Better 页面组件必须已注册");
  // props.ctx 故意**不**提供这两个服务：面板只能从 install ctx 解析，这正是真实客户端的装配形状。
  const handle = runtime.render(component, { scope: { sessionId: "root-a" }, ctx: {} });
  try {
    await handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const rows = byClass(handle.output, "deg_expert_group_row_main");
    const childRow = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.ok(childRow, "子代理行必须渲染");

    const arrow = byClass(childRow, "deg_expert_group_sidebar_action")[0];
    assert.ok(arrow, "行尾箭头必须渲染（install ctx 上有 sidebarRight.openResource）");
    assert.equal(arrow.props["aria-label"], "在侧边栏打开 子代理 A");
    // 展示数据分工：任务名来自 DEG Host 快照，运行状态来自 byId 投影的 running。
    // 用户精简侧栏后摘要行已移除：byId 的权威标题与目录 mode 不再进入侧栏文案。
    assert.equal(byClass(childRow, "deg_expert_group_content").length, 0, "摘要行不得再渲染");
    // 圆点挂在 treeitem（.deg_expert_group_row）上而不是 row_main 内部，按文本定位整行再读。
    const treeRow = byClass(handle.output, "deg_expert_group_row").find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.equal(byClass(treeRow, "deg_expert_group_status_icon")[0].props["data-status"], "running", "运行状态仍来自 byId 投影");
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    await arrow.props.onClick(event);
    assert.deepEqual(splitCalls, [undefined], "必须先通过公开 split() 创建目标 pane");
    assert.ok(widthSequence.includes(500), "20% Expert Group-only 状态下首次分栏前必须临时扩到 50%");
    assert.ok(openSequence.indexOf("width:500") < openSequence.indexOf("split"), "临时扩栏必须发生在 split() 前");
    assert.deepEqual(openSequence.slice(-2), ["split", "openResource"], "必须先拆分 pane 再打开子代理资源");
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable",
      options: { kind: "subagentchat", paneId: "pane-child", replaceTab: "guide-1", preferNewPane: false },
    }]);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual(navTargets, [], "点击箭头不得切换主视图");

    // 任务名点击：新契约优先传地址（而不是裸 session id）。
    byClass(childRow, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [
      { parentSessionId: "root-a", childSessionId: "child-a", mode: "continuable" },
    ]);
    assert.equal(resourceCalls.length, 1, "任务名点击不得顺带打开侧栏资源");
  } finally {
    handle.unmount();
    dispose();
    restoreGlobals();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

test("install 契约：已有两个 pane 时新的子代理箭头固定落到 Expert Group 右侧 pane", async () => {
  const dom = continuityDocumentStub();
  const panel = fakeElement("div", { "data-sidebar-right-panel": "" });
  const expertPane = fakeElement("div", { "data-dockkit-pane": "pane-left", "data-dockkit-column": "0" });
  // DockKit 的 data-dockkit-tab 是生成的 TabId，不是 tab kind；真实形态为 kind + counter。
  const firstExpertTab = fakeElement("div", { "data-dockkit-tab": "dsh-expert-group1" });
  expertPane.appendChild(firstExpertTab);
  const subagentPane = fakeElement("div", { "data-dockkit-pane": "pane-right", "data-dockkit-column": "1" });
  subagentPane.appendChild(fakeElement("div", { "data-dockkit-tab": "subagent-a" }));
  const secondExpertPane = fakeElement("div", { "data-dockkit-pane": "pane-far-right", "data-dockkit-column": "2" });
  const secondExpertTab = fakeElement("div", { "data-dockkit-tab": "dsh-expert-group2" });
  secondExpertPane.appendChild(secondExpertTab);
  panel.appendChild(expertPane);
  panel.appendChild(subagentPane);
  panel.appendChild(secondExpertPane);
  dom.body.appendChild(panel);
  const restoreDom = installGlobals({ document: dom.document });
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [
        { id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "任务 A", status: "running", continuable: true },
        { id: "child-b", kind: "expert", sessionId: "child-b", taskName: "子代理 B", role: "explorer", content: "任务 B", status: "running", continuable: true },
      ],
    },
  };
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "root-a" },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话", running: true },
      "child-b": { id: "child-b", parentId: "root-a", title: "子代理 B 会话", running: true },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [
        { id: "child-a", createdAt: 1, mode: "continuable", label: "子代理 A" },
        { id: "child-b", createdAt: 2, mode: "continuable", label: "子代理 B" },
      ] } },
    },
  };
  const resourceCalls = [];
  const malformedInventoryEntry = {};
  Object.defineProperty(malformedInventoryEntry, "sessionId", { get() { throw new Error("inventory entry getter failed"); } });
  let inventory = [
    malformedInventoryEntry,
    { sessionId: "other-session", tabId: "dsh-expert-group3", kind: "dsh-expert-group", contentId: "dsh://page/other-session" },
    { sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" },
    { sessionId: "root-a", tabId: "dsh-expert-group2", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" },
  ];
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    ctxServices: {
      uiWorkspace: { openSession() {} },
      sidebarRight: {
        // openTabs 给出真实宿主的 kind -> 生成 tabId 映射；DOM 只保存后者。
        openTabs: {
          getSnapshot() { return inventory; },
        },
        openResource(address, options) { resourceCalls.push({ address, options }); },
      },
    },
  });
  try {
    await fixture.handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const rows = byClass(fixture.handle.output, "deg_expert_group_row_main");
    const rowA = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
    const rowB = rows.find((row) => collect(row).some((item) => item === "子代理 B"));
    assert.ok(rowA && rowB, "两个子代理行必须渲染");
    await byClass(rowA, "deg_expert_group_sidebar_action")[0].props.onClick();
    await byClass(rowB, "deg_expert_group_sidebar_action")[0].props.onClick();
    assert.equal(resourceCalls.length, 2, "两个箭头都必须打开对应子代理资源");
    assert.deepEqual(resourceCalls[0].options, {
      kind: "subagentchat",
      paneId: "pane-right",
      preferNewPane: false,
    }, "已有右侧 pane 时第一个新子代理也必须落到右侧 pane");
    assert.deepEqual(resourceCalls[1].options, {
      kind: "subagentchat",
      paneId: "pane-right",
      preferNewPane: false,
    }, "已有右侧 pane 时后续子代理不得回落到当前的 Expert Group pane");

    // inventory 暂时没有当前 surface 的 Expert Group 条目，且 DOM 的 TabId 也无法识别时，
    // 不能把未知 pane 猜成安全目标。
    firstExpertTab.setAttribute("data-dockkit-tab", "unmapped-expert-a");
    secondExpertTab.setAttribute("data-dockkit-tab", "unmapped-expert-b");
    inventory = [{ sessionId: "root-a", tabId: "unmapped-tab", kind: "other", contentId: "dsh://page/other" }];
    await byClass(rowA, "deg_expert_group_sidebar_action")[0].props.onClick();
    assert.deepEqual(resourceCalls[2].options, {
      kind: "subagentchat",
      preferNewPane: true,
    }, "无法证明 Expert Group pane 时必须保留首次打开的 fail-closed 语义");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
    restoreDom();
  }
  assert.equal(fixture.intervals.active, 0, "卸载后不得遗留轮询定时器");
});

/**
 * install 契约（可关闭 toggle）：完整 sidebarRight 能力（openResource + active + close）与右栏
 * 公开 DOM 标记下，行尾箭头必须走完
 * `>> 打开 →（active 证据匹配）<< 可关闭 → close(精确 tabId) → >>`
 * 这条闭环；用户从 tab 自带关闭按钮关掉时，DEG 只观察 `[data-dockkit-tab]` 节点消失就复位，
 * 绝不改写宿主 DOM、也绝不在缺少证据时猜测。
 *
 * 上一条 install 用例覆盖的是「旧宿主只有 openResource」时的静态兼容行为（含 preferNewPane 回退）；
 * 这一条覆盖新契约，两者互补：能力齐备才出现可关闭的 <<。
 */
test("install 契约：完整能力下箭头可打开与关闭，并由右栏 DOM 节点消失自动复位", async () => {
  await import("../client-expert-group-model-normalize.js");
  await import("../client-expert-group-model-format.js");
  await import("../client-expert-group-model.js");
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  // 真实右栏 DOM 替身：Expert Group pane + 宿主回落到同 pane 的子代理 tab。
  const dom = continuityDocumentStub();
  const panel = fakeElement("div", { "data-sidebar-right-panel": "" });
  const expertPane = fakeElement("div", { "data-dockkit-pane": "pane-expert", "data-dockkit-column": "0" });
  expertPane.appendChild(fakeElement("div", { "data-dockkit-tab": "dsh-expert-group1" }));
  panel.appendChild(expertPane);
  dom.body.appendChild(panel);
  const chip = fakeElement("div", { "data-dockkit-tab": "tab-a" });
  // 受控 MutationObserver：记录实例并允许手动派发变更批次（真实回调在浏览器里是微任务）。
  const observerInstances = [];
  class ContractMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.disconnected = false;
      observerInstances.push(this);
    }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  }
  const restoreGlobals = installGlobals({
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
    document: dom.document,
    MutationObserver: ContractMutationObserver,
  });
  /** 面板为「看 tab 有没有消失」而挂的观察器：观察面是 body 子树。 */
  const panelObserver = () => observerInstances
    .find((instance) => instance.target === dom.body && instance.options?.subtree === true) ?? null;
  const fireObserver = () => {
    for (const instance of observerInstances) if (instance.disconnected !== true) instance.callback([]);
  };
  // 具名图标替身把方向写进返回元素，测试据此证明插件取用的是 IconChevronLeft/RightOutlineRegular。
  const rightChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-right" }, children: [] });
  const leftChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-left" }, children: [] });
  const navTargets = [];
  const resourceCalls = [];
  const closeCalls = [];
  const floatCalls = [];
  let activeTab;
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [{
        id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
        role: "fixer", content: "子代理 A 的任务", status: "running", continuable: true,
      }],
    },
  };
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: "root-a",
        byId: {
          "root-a": { id: "root-a", title: "root-a" },
          "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话", running: true },
        },
        projectionsBySession: {
          "root-a": { values: { subagentCatalog: [{ id: "child-a", createdAt: 1, mode: "continuable", label: "子代理 A" }] } },
        },
      }),
      subscribe: () => () => {},
    },
    subagentAddress: (childId) => (childId === "child-a"
      ? { parentSessionId: "root-a", childSessionId: "child-a", mode: "continuable" }
      : undefined),
  };
  const uiWorkspace = { openSession(target) { navTargets.push(target); } };
  const sidebarRight = {
    openResource(address, options) {
      resourceCalls.push({ address, options });
      // 真实宿主在 openResource 里同步提交 store 并渲染出 tab：active() 立刻读到它，芯片随后出现。
      activeTab = { id: "tab-a", kind: "subagentchat", contentId: address, title: "子代理 A 会话" };
      if (expertPane.children.includes(chip) !== true) expertPane.appendChild(chip);
    },
    float(tabId) {
      floatCalls.push(tabId);
    },
    active() { return activeTab; },
    close(tabId) {
      closeCalls.push(tabId);
      if (activeTab?.id === tabId) activeTab = undefined;
      // 宿主自己的关闭路径：芯片随之从 DOM 消失。
      chip.remove();
    },
  };
  const registered = [];
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {}; },
    isTabEnabled: () => true,
    openTab() {},
  };
  const ctx = {
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "uiWorkspace") return uiWorkspace;
      if (name === "sidebarRight") return sidebarRight;
      if (name === "betterSidebar") return betterSidebar;
      return undefined;
    },
    sessions,
  };
  const dispose = sidebar.installExpertGroupSidebar(ctx, {
    react: runtime.react,
    primitives: { ...primitives, IconChevronRightOutlineRegular: rightChevron, IconChevronLeftOutlineRegular: leftChevron },
    sessions,
    resolveRootSessionId: (id) => id,
    requestPluginRpc: () => ({ ok: true, async json() { return { snapshot: hostSnapshot }; } }),
  });
  const component = registered[0]?.component;
  assert.equal(typeof component, "function", "Better 页面组件必须已注册");
  // props.ctx 刻意不提供 sidebarRight：面板只能从 install ctx 解析它（与真实客户端一致）。
  const handle = runtime.render(component, { scope: { sessionId: "root-a" }, ctx: {} });
  try {
    await handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const arrowOf = () => {
      const rows = byClass(handle.output, "deg_expert_group_row_main");
      const childRow = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
      assert.ok(childRow, "子代理行必须渲染");
      const arrow = byClass(childRow, "deg_expert_group_sidebar_action")[0];
      assert.ok(arrow, "行尾箭头必须渲染（install ctx 上有 sidebarRight.openResource）");
      return arrow;
    };
    const iconsOf = (arrow) => byClass(arrow, "deg_expert_group_double_arrow")[0];

    // 1) 未打开：静态橙色 >> 的语义 + toggle 的无障碍标记。
    const closedArrow = arrowOf();
    assert.equal(closedArrow.props["aria-label"], "在侧边栏打开 子代理 A");
    assert.equal(closedArrow.props["data-open"], "false");
    assert.equal(closedArrow.props["aria-pressed"], false);

    // 2) 打开：旧宿主没有 split 时，openResource 保留 preferNewPane 兼容参数；插件不浮出。
    const openEvent = {
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
    };
    await closedArrow.props.onClick(openEvent);
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable",
      options: { kind: "subagentchat", preferNewPane: true },
    }]);
    assert.equal(openEvent.defaultPrevented, true);
    assert.equal(openEvent.propagationStopped, true);
    assert.deepEqual(navTargets, [], "点击箭头不得切换主视图");
    assert.deepEqual(floatCalls, [], "openResource 提交后不得自动创建独立浮窗");
    fireObserver();
    await handle.settle();
    assert.deepEqual(floatCalls, [], "子代理回落到 Expert Group pane 时仍不得调用公开 float(tabId)");
    fireObserver();
    await handle.settle();
    assert.deepEqual(floatCalls, [], "后续同步也不得调用 float()");
    const openArrow = arrowOf();
    assert.equal(openArrow.props["data-open"], "true", "active() 证据匹配后必须进入 << 状态");
    assert.equal(openArrow.props["aria-pressed"], true);
    assert.equal(openArrow.props["aria-label"], "在侧边栏关闭 子代理 A");
    const openIcons = iconsOf(openArrow);
    assert.equal(openIcons.children.length, 2, "打开态必须是两个左箭头");
    for (const icon of openIcons.children) assert.equal(icon.props["data-icon"], "chevron-left");
    // DEG 只观察宿主 DOM：Expert Group 与子代理 tab 都由宿主自己渲染，插件不得增删节点或改属性。
    assert.equal(panel.querySelectorAll("[data-dockkit-tab]").length, 2, "宿主 DOM 必须保持原样");
    assert.equal(chip.getAttribute("data-dockkit-tab"), "tab-a");
    assert.equal(panelObserver() !== null, true, "面板必须挂一个观察 body 子树的 MutationObserver");

    // 3) 再次点击：只关闭记录里的精确 tabId，随后复位成 >>。
    await arrowOf().props.onClick(openEvent);
    assert.deepEqual(closeCalls, ["tab-a"], "关闭必须使用打开时记录的精确 tabId");
    assert.equal(resourceCalls.length, 1, "关闭态点击不得再打开一次");
    await handle.settle();
    assert.equal(arrowOf().props["data-open"], "false", "关闭成功后必须复位");
    assert.equal(arrowOf().props["aria-label"], "在侧边栏打开 子代理 A");

    // 4) 重新打开，然后模拟「用户从 tab 自带的关闭按钮关掉」：DEG 只凭节点消失复位，且不调用 close。
    await arrowOf().props.onClick(openEvent);
    await handle.settle();
    assert.equal(arrowOf().props["data-open"], "true");
    chip.remove();
    activeTab = undefined;
    fireObserver();
    await handle.settle();
    assert.equal(arrowOf().props["data-open"], "true", "一次观测不足以判定用户关闭了 tab");
    fireObserver();
    await handle.settle();
    assert.equal(arrowOf().props["data-open"], "false", "连续两次观测到节点消失后必须复位");
    assert.deepEqual(closeCalls, ["tab-a"], "外部关闭同步绝不调用 close()");
    assert.equal(resourceCalls.length, 2, "复位过程不得重新打开资源");
  } finally {
    handle.unmount();
    dispose();
    restoreGlobals();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
  assert.equal(panelObserver()?.disconnected, true, "卸载（面板 effect 清理）必须断开观察器");
});

/**
 * 会话投影与新导航面的 install 契约（0.1.7-alpha.2）。
 *
 * 两条边界都走完整装配路径（真实 install → 真实注册组件 → 真实渲染）：
 * 1. 子代理目录只来自 `projectionsBySession[sessionId].values.subagentCatalog`，且目录项
 *    只提供身份/层级：任务名来自 DEG Host 快照、运行状态来自 byId 投影（摘要行已移除）；
 * 2. 会话导航只使用 `uiWorkspace.openSession`；入口缺失时不渲染任何失效按钮
 *    （已删除的 sessions.open / ctx.sessions.open / deps.openSession 回退不再存在）。
 */
/**
 * install 契约（行尾批量关闭）：完整装配路径下的当前栏语义。
 *
 * 同一个 openTabs inventory 里同时放四种「不该被当前栏关掉」的形状（别的 sidebar session、
 * 别的 root、别的 kind、idle 成员），并断言：
 * - 关闭的 tabId 逐条对应**当前 root 运行中资源**的规范 contentId；
 * - root-a 与 root-b 两个 install 实例各自只关自己栏里的那一个 tab；
 * - 空闲分组标题行的批量入口只关 ready 成员，运行中的 tab 保留。
 */
test("install 契约：行尾批量关闭只作用于当前栏（sidebar session + root）的 running 资源", async () => {
  const inventory = [];
  const closed = [];
  const contentOfTab = new Map();
  const addTab = (sessionId, tabId, kind, contentId) => {
    inventory.push({ sessionId, tabId, kind, contentId });
    contentOfTab.set(tabId, contentId);
  };
  const ADDRESS_A = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const ADDRESS_B = "dsh-resource://subagentchat/session/child-b?parent=root-a&mode=continuable";
  const ADDRESS_C = "dsh-resource://subagentchat/session/child-c?parent=root-b&mode=continuable";
  addTab("root-a", "tab-a-running", "subagentchat", ADDRESS_A);
  addTab("root-a", "tab-a-idle", "subagentchat", ADDRESS_B);
  // 同一个 contentId 但属于别的 sidebar session：绝不能被当前栏关闭。
  addTab("root-b", "tab-a-wrong-session", "subagentchat", ADDRESS_A);
  addTab("root-a", "tab-a-guide", "guide", ADDRESS_A);
  addTab("root-b", "tab-b-running", "subagentchat", ADDRESS_C);
  // 同一个 contentId 但属于别的 root：绝不能被当前栏关闭。
  addTab("root-a", "tab-b-wrong-root", "subagentchat", ADDRESS_C);

  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    openResource() {},
    // 真实宿主的 close 会把 tab 从公开 inventory 移除：候选集合因此随关闭收敛。
    close(tabId) {
      closed.push(tabId);
      const index = inventory.findIndex((tab) => tab.tabId === tabId);
      if (index >= 0) inventory.splice(index, 1);
    },
  };
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "root-a" },
      "root-b": { id: "root-b", title: "root-b" },
      "child-a": { id: "child-a", parentId: "root-a", title: "运行专家 A", running: true },
      "child-b": { id: "child-b", parentId: "root-a", title: "空闲专家 B", running: false },
      "child-c": { id: "child-c", parentId: "root-b", title: "运行专家 C", running: true },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [
        { id: "child-a", createdAt: 1, mode: "continuable", label: "运行专家 A" },
        { id: "child-b", createdAt: 2, mode: "continuable", label: "空闲专家 B" },
      ] } },
      "root-b": { values: { subagentCatalog: [{ id: "child-c", createdAt: 1, mode: "continuable", label: "运行专家 C" }] } },
    },
  };
  const hostSnapshotFor = (rootId, children) => ({
    schemaVersion: 1,
    rootSessionId: rootId,
    generatedAt: 1,
    root: { id: rootId, kind: "root", sessionId: rootId, taskName: rootId, children },
  });
  const hostSnapshotA = hostSnapshotFor("root-a", [
    { id: "child-a", kind: "expert", sessionId: "child-a", taskName: "运行专家 A", role: "fixer", content: "运行中", status: "running", continuable: true },
    { id: "child-b", kind: "expert", sessionId: "child-b", taskName: "空闲专家 B", role: "explorer", content: "已完成", status: "ready", continuable: true },
  ]);
  const hostSnapshotB = hostSnapshotFor("root-b", [
    { id: "child-c", kind: "expert", sessionId: "child-c", taskName: "运行专家 C", role: "fixer", content: "运行中", status: "running", continuable: true },
  ]);
  // 具名图标替身把方向写进返回元素：批量按钮必须取用 IconChevronLeftOutlineRegular。
  const rightChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-right" }, children: [] });
  const leftChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-left" }, children: [] });
  const arrowPrimitives = {
    ...primitives,
    IconChevronRightOutlineRegular: rightChevron,
    IconChevronLeftOutlineRegular: leftChevron,
  };
  const collect = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
    return result;
  };
  const byClass = (node, className) => collect(node)
    .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
  const batchOf = (handle, className) => byClass(handle.output, className)[0];

  const panelA = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot: hostSnapshotA,
    deps: { primitives: arrowPrimitives },
    ctxServices: { sidebarRight },
  });
  const panelB = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot: hostSnapshotB,
    deps: { primitives: arrowPrimitives },
    ctxServices: { sidebarRight },
    scope: { sessionId: "root-b" },
  });
  try {
    await panelA.handle.settle();
    await panelB.handle.settle();

    // root-a 栏：运行中 1 个、空闲 1 个；候选只认 sessionId=root-a 且 contentId 精确匹配的那一条。
    const rootBatchA = byClass(panelA.handle.output, "deg_expert_group_sidebar_batch_action")[0];
    assert.ok(rootBatchA, "root-a 栏的主代理行必须渲染批量关闭按钮");
    assert.equal(rootBatchA.props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");
    assert.equal(rootBatchA.props["aria-pressed"], undefined, "批量关闭不是 toggle");
    const idleHeaderA = byClass(panelA.handle.output, "deg_expert_group_idle_header")[0];
    const idleBatchA = byClass(idleHeaderA, "deg_expert_group_sidebar_batch_action")[0];
    assert.ok(idleBatchA, "root-a 栏的空闲分组标题行必须渲染批量关闭按钮");
    assert.equal(idleBatchA.props["aria-label"], "在侧边栏关闭 1 个空闲子代理");

    // root-b 栏：同一个 inventory、同一个 install 入口，但只认自己的 session 与 root。
    const rootBatchB = byClass(panelB.handle.output, "deg_expert_group_sidebar_batch_action")[0];
    assert.ok(rootBatchB, "root-b 栏的主代理行必须渲染批量关闭按钮");
    assert.equal(rootBatchB.props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");

    await rootBatchA.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await panelA.handle.settle();
    assert.deepEqual(closed, ["tab-a-running"], "root-a 批量只关当前栏运行中资源对应的 tab");
    assert.equal(contentOfTab.get(closed[0]), ADDRESS_A, "关闭的必须是当前栏 running 资源的规范 contentId");

    await idleBatchA.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await panelA.handle.settle();
    assert.deepEqual(closed, ["tab-a-running", "tab-a-idle"], "空闲批量只关 ready 成员");

    await rootBatchB.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await panelB.handle.settle();
    assert.deepEqual(closed, ["tab-a-running", "tab-a-idle", "tab-b-running"], "root-b 批量只关自己栏里的运行中资源");
    assert.equal(contentOfTab.get("tab-b-running"), ADDRESS_C);
    // 别的 sidebar session / 别的 root / 别的 kind 的 tab 全程未被触碰。
    for (const tabId of ["tab-a-wrong-session", "tab-a-guide", "tab-b-wrong-root"]) {
      assert.equal(closed.includes(tabId), false, tabId + " 绝不能被当前栏的批量关闭触碰");
    }
    assert.ok(batchOf(panelA.handle, "deg_expert_group_sidebar_batch_zero") !== undefined, "候选清空后回到非交互零圆点");
  } finally {
    panelA.handle.unmount();
    panelA.dispose();
    panelA.restoreGlobals();
    panelB.handle.unmount();
    panelB.dispose();
    panelB.restoreGlobals();
  }
});

async function renderInstallPanel({ sessionsSnapshot, deps = {}, ctxServices = {}, hostSnapshot = null, scope = { sessionId: "root-a" } }) {
  await import("../client-expert-group-model-normalize.js");
  await import("../client-expert-group-model-format.js");
  await import("../client-expert-group-model.js");
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restoreGlobals = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  const snapshot = hostSnapshot ?? {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [{
        id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
        role: "fixer", content: "子代理 A 的任务", status: "running", continuable: true,
      }],
    },
  };
  const sessionListeners = new Set();
  const sessions = {
    list: {
      getSnapshot: () => sessionsSnapshot,
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
    },
    notify() { for (const listener of [...sessionListeners]) listener(); },
  };
  const registered = [];
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {}; },
    isTabEnabled: () => true,
    openTab() {},
  };
  const ctx = {
    // 真实宿主用 Cordis 服务查找；这里只提供用例显式给出的服务。
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "betterSidebar") return betterSidebar;
      return ctxServices[name];
    },
    sessions,
  };
  const dispose = sidebar.installExpertGroupSidebar(ctx, {
    react: runtime.react,
    primitives,
    sessions,
    resolveRootSessionId: (id) => id,
    requestPluginRpc: () => ({ ok: true, async json() { return { snapshot }; } }),
    ...deps,
  });
  const component = registered[0]?.component;
  assert.equal(typeof component, "function", "Better 页面组件必须已注册");
  const handle = runtime.render(component, { scope, ctx: {} });
  return { handle, dispose, intervals, restoreGlobals, sessions };
}

test("install 契约：目录投影只提供身份/层级，展示数据分别来自 byId 与 DEG 快照", async () => {
  // 同一 root 下两条 DEG 任务分支：普通专家 child-a 与 fan-out 分片（最新 attempt = grandchild-a）。
  // 展示数据全部来自 DEG Host 快照 + byId 投影；目录投影只按父会话 id 提供 mode/标签。
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [
        {
          id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
          role: "fixer", content: "子代理 A 的任务", status: "running", continuable: true,
        },
        {
          id: "fan-1", kind: "fanout", parentTaskId: "fan-1", role: "fixer", status: "running",
          shards: [{
            shardId: "shard-a", taskName: "分片 A", prompt: "分片 A 的提示", status: "failed",
            childId: "grandchild-a", attempts: [{ attempt: 1, status: "failed", childId: "grandchild-a" }],
          }],
        },
      ],
    },
  };
  const snapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话标题", running: false },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话标题", running: true },
      "grandchild-a": { id: "grandchild-a", parentId: "root-a", title: "分片会话标题", running: false },
    },
    // 目录项只带身份类字段（没有 taskName/role/activity）：展示数据必须来自别处。
    projectionsBySession: {
      "root-a": {
        values: {
          subagentCatalog: [
            { id: "child-a", createdAt: 1, mode: "continuable", label: "第一层目录标签" },
            { id: "grandchild-a", createdAt: 2, mode: "one-shot", label: "分片目录标签" },
          ],
        },
      },
    },
  };
  const navTargets = [];
  const fixture = await renderInstallPanel({
    sessionsSnapshot: snapshot,
    hostSnapshot,
    ctxServices: { uiWorkspace: { openSession(target) { navTargets.push(target); } }, sidebarRight: { openResource() {} } },
  });
  try {
    await fixture.handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const rows = byClass(fixture.handle.output, "deg_expert_group_row_main");
    const childRow = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.ok(childRow, "普通专家行必须渲染");
    // 第一行任务名来自 DEG Host 快照的 taskName，不是目录 label。
    assert.equal(collect(childRow).includes("子代理 A"), true);
    assert.equal(collect(childRow).includes("第一层目录标签"), false, "任务名不得改从目录投影读取");
    // 摘要行已移除：byId 的权威标题与目录 mode 不再进入侧栏文案；
    // 运行状态仍来自 byId 投影的 running（圆点）。
    assert.equal(byClass(childRow, "deg_expert_group_content").length, 0, "第三行摘要不得再渲染");
    const treeRow = byClass(fixture.handle.output, "deg_expert_group_row").find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.equal(byClass(treeRow, "deg_expert_group_status_icon")[0].props["data-status"], "running");
    assert.deepEqual(navTargets, []);
    // 分片行同样按 byId 投影补运行状态（byId running=false ⇒ ready）。
    const shardRow = byClass(fixture.handle.output, "deg_expert_group_shard")
      .find((row) => row.props["data-shard-id"] === "shard-a");
    assert.ok(shardRow, "fan-out 分片行必须渲染（最新 attempt 的 childId 进入目录查找）");
    assert.equal(
      byClass(shardRow, "deg_expert_group_status_icon")[0].props["data-status"],
      "ready",
      "分片的运行状态必须来自 byId 投影",
    );
    // 导航仍走工作区入口：分片的最新 attempt childId 带目录 mode，因此传地址。
    byClass(shardRow, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [{ parentSessionId: "root-a", childSessionId: "grandchild-a", mode: "one-shot" }]);
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
  }
  assert.equal(fixture.intervals.active, 0);
});

test("install 契约：没有工作区导航入口时不渲染失效按钮，且不读取已删除的旧入口", async () => {
  const snapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话标题" },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话标题", running: true },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [{ id: "child-a", createdAt: 1, mode: "continuable", label: "子代理 A" }] } },
    },
  };
  // 已删除的旧导航入口全部放在替身上并把调用记成「回归证据」。
  const staleCalls = [];
  const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, open: (id) => staleCalls.push("open:" + id) };
  // 注意：ctx 上完全没有 uiWorkspace 服务（宿主未提供该入口）。
  const fixture = await renderInstallPanel({
    sessionsSnapshot: snapshot,
    deps: { sessions, openSession: (id) => staleCalls.push("deps:" + id) },
    ctxServices: {},
  });
  try {
    await fixture.handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const rows = byClass(fixture.handle.output, "deg_expert_group_row_main");
    const childRow = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.ok(childRow, "没有导航入口时任务树仍必须渲染");
    const taskLine = byClass(childRow, "deg_expert_group_task")[0];
    assert.equal(taskLine.props.onClick, undefined, "导航入口缺失时不得留下失效的点击处理器");
    assert.equal(taskLine.props.role, undefined, "导航入口缺失时不得冒充 role=button");
    assert.equal(taskLine.props.tabIndex, undefined);
    // 摘要行已移除：不存在第二个（同样必须失效的）导航入口。
    assert.equal(byClass(childRow, "deg_expert_group_content").length, 0);
    assert.deepEqual(staleCalls, [], "已删除的 sessions.open / deps.openSession 不得再被读取或调用");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
  }
  assert.equal(fixture.intervals.active, 0);
});

test("install 契约：mode=unknown 的目录项按不可续接降级，地址与箭头照常可用", async () => {
  // 0.1.7-alpha.2 目录新增 unknown；它表示「可续接性未知」，按不可续接降级展示。
  const snapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话标题" },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话标题", running: true },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [{ id: "child-a", createdAt: 1, mode: "unknown" }] } },
    },
  };
  const navTargets = [];
  const resourceCalls = [];
  const fixture = await renderInstallPanel({
    sessionsSnapshot: snapshot,
    ctxServices: {
      uiWorkspace: { openSession(target) { navTargets.push(target); } },
      sidebarRight: { openResource(address, options) { resourceCalls.push({ address, options }); } },
    },
  });
  try {
    await fixture.handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    const rows = byClass(fixture.handle.output, "deg_expert_group_row_main");
    const childRow = rows.find((row) => collect(row).some((item) => item === "子代理 A"));
    assert.ok(childRow, "unknown 模式的子代理行必须渲染");
    // 摘要行已移除：unknown 的 mode 降级不再有展示面，侧栏不输出「可继续 / 一次性」猜测词。
    assert.equal(byClass(childRow, "deg_expert_group_content").length, 0, "第三行摘要不得再渲染");
    assert.equal(collect(childRow).includes("可继续"), false, "unknown 模式绝不能显示为可继续");
    // 地址是合法值（宿主原生主视图与侧栏都认识 unknown），因此导航与箭头照常工作。
    byClass(childRow, "deg_expert_group_task")[0].props.onClick();
    assert.deepEqual(navTargets, [{ parentSessionId: "root-a", childSessionId: "child-a", mode: "unknown" }]);
    const arrow = byClass(childRow, "deg_expert_group_sidebar_action")[0];
    assert.ok(arrow, "unknown 模式的地址可构造，箭头必须渲染");
    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=unknown",
      options: { kind: "subagentchat", preferNewPane: true },
    }]);
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
  }
  assert.equal(fixture.intervals.active, 0);
});

test("install 回归：当前 session B 的箭头必须 split 到 B panel，不得命中 DOM 首个 session A", async () => {
  const dom = multiPanelSplitDocumentStub([
    {
      sessionId: "root-a",
      cells: [
        { column: 0, paneId: "pane-a-expert", tabIds: ["dsh-expert-group1"] },
        { column: 1, paneId: "pane-a-subagent", tabIds: ["subagent-tab"] },
      ],
    },
    {
      sessionId: "root-b",
      cells: [
        { column: 0, paneId: "pane-b-expert", tabIds: ["dsh-expert-group1"] },
      ],
    },
  ]);
  const sessionsSnapshot = {
    current: "root-b",
    byId: {
      "root-b": { id: "root-b", title: "根会话 B", retainedBy: { mainView: 1 } },
      "child-b": { id: "child-b", parentId: "root-b", title: "子代理 B", running: true },
    },
    projectionsBySession: {
      "root-b": { values: { subagentCatalog: [{ id: "child-b", createdAt: 1, mode: "continuable", label: "子代理 B" }] } },
    },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-b",
    generatedAt: 1,
    root: {
      id: "root-b", kind: "root", sessionId: "root-b", taskName: "根会话 B",
      children: [{
        id: "child-b", kind: "expert", sessionId: "child-b", taskName: "子代理 B",
        role: "fixer", content: "子代理 B 的任务", status: "running", continuable: true,
      }],
    },
  };
  const inventory = [
    { sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" },
    { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/child-a" },
    { sessionId: "root-b", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" },
  ];
  const resourceCalls = [];
  const splitCalls = [];
  const widthWrites = [];
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active() { return { sessionId: "root-b", id: "dsh-expert-group1", kind: "dsh-expert-group" }; },
    split() { splitCalls.push("split"); return "pane-b-subagent"; },
    openResource(address, options) { resourceCalls.push({ address, options }); },
  };
  const restoreGlobals = installGlobals({ document: dom.document, window: { innerWidth: 1600 } });
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    scope: { sessionId: "root-b" },
    deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
    ctxServices: { sidebarRight },
  });
  try {
    await fixture.handle.settle();
    const collect = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
      return result;
    };
    const byClass = (node, className) => collect(node)
      .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
    widthWrites.length = 0;
    const aGridBefore = dom.panels[0].split.inline.get("grid-template-columns");
    const aEventsBefore = dom.panels[0].sink.events.length;
    const childRow = byClass(fixture.handle.output, "deg_expert_group_row_main")
      .find((row) => collect(row).some((item) => item === "子代理 B"));
    assert.ok(childRow, "B session 的子代理行必须渲染");
    const arrow = byClass(childRow, "deg_expert_group_sidebar_action")[0];
    assert.ok(arrow, "B session 的箭头必须渲染");
    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(splitCalls, ["split"], "B 没有可复用 pane 时必须只为 B 调用 split()");
    assert.deepEqual(resourceCalls, [{
      address: "dsh-resource://subagentchat/session/child-b?parent=root-b&mode=continuable",
      options: { kind: "subagentchat", paneId: "pane-b-subagent", preferNewPane: false },
    }], "openResource 必须固定到 split 返回的 B panel pane");
    assert.equal(widthWrites.at(-1), 800, "B 首次分栏必须先进入可提交的 50% 宽度");
    assert.equal(dom.panels[0].split.inline.get("grid-template-columns"), aGridBefore, "B 的分栏不得改写 A 的 grid");
    assert.equal(dom.panels[0].sink.events.length, aEventsBefore, "B 的分栏不得向 A 的 layout sink 写事件");
    assert.deepEqual(dom.panels[0].cells.flatMap((cell) => cell.tabNodes.map((node) => node.getAttribute("data-dockkit-tab"))), ["dsh-expert-group1", "subagent-tab"], "A 的 tabs 必须保持不变");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
    restoreGlobals();
  }
  assert.equal(fixture.intervals.active, 0);
});

// ── 品牌图标：宿主「智能体团队」入口的双人（users）artwork ─────────────────────
/**
 * DEG 的品牌图标必须与宿主「智能体团队」入口同源：宿主 primitives 导出了
 * IconUsersOutlineRegular 时直接复用它；缺该导出（本包依赖的 0.1.7-alpha.2 只有单人
 * IconUserOutlineRegular）时回落到侧栏模块内联的等价 artwork。下面几组用例锁定：
 * 1. 两个注册面的 icon 契约形状相反——Better 收「size → React 元素」的工厂，原生 guide 收
 *    组件本身（宿主渲染 `<Icon size={22|26} />`）；写反了图标不会报错，只会静默不显示；
 * 2. 内联 artwork 与 client-entry.js 设置页导航适配读的路径常量是**同一组 path**（唯一一份数据）；
 * 3. react 缺失（契约外直载安装）时两个注册面都不写 icon 字段，其余注册字段逐字节不变。
 */
test("品牌图标：better tab 的 icon 是 size 工厂、native guide 的 icon 是组件，且 artwork 是宿主双人图标", () => {
  withDeferredTimers(() => {
    const fixture = installBrandIconFixture(primitives);
    try {
      const descriptor = fixture.descriptor("better");
      assert.equal(typeof descriptor.icon, "function", "Better 的 icon 必须是 size → 元素的工厂");
      const element = descriptor.icon(14);
      assert.equal(typeof element.type, "function", "工厂要返回元素（渲染我们的图标组件），不是直接返回 svg");
      const svg = element.type({ size: element.props.size });
      assert.equal(svg.type, "svg");
      assert.equal(svg.props.width, 14, "渲染尺寸只能由宿主传入的 size 决定");
      assert.equal(svg.props.height, 14);
      assert.equal(svg.props.viewBox, "0 0 16 16");
      assert.equal(svg.props.fill, "none");
      assert.equal(svg.props.strokeWidth, 1, "Regular(=1px) 描边必须由 svg 继承给 4 条 path");
      assert.equal(svg.props["aria-hidden"], "true");
      assertArtworkPaths(svg.children.map((path) => path.props.d));
      for (const path of svg.children) {
        assert.equal(path.type, "path");
        assert.equal(path.props.stroke, "currentColor", "颜色必须跟随文字色，不能写死");
        assert.equal(path.props.fill, "none");
      }
      assert.equal(element.type({}).props.width, 16, "未给 size 时按图标网格默认 16 渲染");
      assert.equal(element.type({ size: 14, className: "deg_brand" }).props.className, "deg_brand", "className 必须透传（宿主用它注入自己的图标类）");

      const guide = fixture.descriptor("native").guide;
      assert.equal(guide.length, 1);
      assert.equal(guide[0].order, 40, "guide 条目的既有排序不得改变");
      assert.equal(guide[0].title(), "expert group");
      assert.equal(guide[0].description(), "查看当前会话的专家任务树");
      assert.equal(typeof guide[0].icon, "function", "原生 guide 的 icon 必须是组件本身（宿主自己渲染它）");
      const guideSvg = guide[0].icon({ size: 22 });
      assert.equal(guideSvg.type, "svg", "宿主以 <Icon size={22} /> 渲染，图标必须是可直接调用的组件");
      assert.equal(guideSvg.props.width, 22);
      assertArtworkPaths(guideSvg.children.map((path) => path.props.d));
    } finally {
      fixture.dispose();
    }
  });
});

test("品牌图标：宿主 primitives 有 IconUsersOutlineRegular 时直接复用，不再构造内联 artwork", () => {
  withDeferredTimers(() => {
    const HostIcon = function HostIcon() {};
    const fixture = installBrandIconFixture({ ...primitives, IconUsersOutlineRegular: HostIcon });
    try {
      // 宿主导出的组件被原样使用：工厂返回的元素类型就是宿主组件，guide 也直接挂宿主组件。
      assert.equal(fixture.descriptor("better").icon(16).type, HostIcon);
      assert.equal(fixture.descriptor("native").guide[0].icon, HostIcon);
    } finally {
      fixture.dispose();
    }
  });
});

test("品牌图标：react 缺失时两个注册面都不写 icon 字段，其余注册契约逐字节不变", () => {
  withDeferredTimers(() => {
    const sessions = sessionsFixture();
    const captured = {};
    // 两个注册面各自一次安装：Better 存在时原生面根本不会被注册，必须分开装才能各看一面。
    const betterCtx = {
      sessions,
      betterSidebar: {
        registerTab(descriptor) { captured.better = descriptor; return () => {}; },
        isTabEnabled: () => false,
        openTab() {},
      },
    };
    const nativeCtx = {
      sessions,
      sidebarRightTabs: { register(definition) { captured.native = definition; return () => {}; } },
      slots: { register() { return () => {}; } },
    };
    // 契约外直载安装（没有 react）：图标整体跳过，但 id/kind/title/guide 一字不差。
    const disposeBetter = sidebar.installExpertGroupSidebar(betterCtx, { sessions });
    const disposeNative = sidebar.installExpertGroupSidebar(nativeCtx, { sessions });
    try {
      assert.deepEqual(Object.keys(captured.better), ["id", "title", "single", "component"]);
      assert.equal("icon" in captured.native.guide[0], false, "缺 react 时 guide 条目不得出现 icon 键");
      assert.equal(captured.better.id, "expert-group");
      assert.equal(captured.native.id, "dsh-expert-group");
      assert.equal(captured.native.kind, "expert-group");
      assert.equal(captured.native.guide[0].order, 40);
    } finally {
      disposeBetter();
      disposeNative();
    }
  });
});

test("品牌图标 artwork：侧栏常量与 client-entry.js 设置页导航图标读的是同一组 4 条 path", async () => {
  const { client } = await loadClientModule();
  assert.equal(client.DEG_SETTINGS_NAV_ICON_PATHS, sidebar.BRAND_ICON_PATHS,
    "设置页导航适配必须直接取用侧栏导出的唯一一份 artwork（同一数组引用）");
  assert.deepEqual(client.DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS, sidebar.BRAND_ICON_PATHS,
    "侧栏模块缺失时用的兜底字面量必须与侧栏常量逐字节同值");
  assertArtworkPaths([...client.DEG_SETTINGS_NAV_ICON_PATHS]);
});

/**
 * 品牌图标安装替身：两个注册面各装一次，只记录描述符。
 *
 * Better 侧把 tab 置为禁用（isTabEnabled=false）：注册照常发生，但不触发任何自动打开流程，
 * 本组用例只关心描述符形状。原生侧不需要 sidebarRight 服务（不产生打开请求）。
 */
function installBrandIconFixture(primitivesOverride) {
  const sessions = sessionsFixture();
  const captured = { better: null, native: null };
  const betterCtx = {
    sessions,
    betterSidebar: {
      registerTab(descriptor) { captured.better = descriptor; return () => {}; },
      isTabEnabled: () => false,
      openTab() {},
    },
  };
  const nativeCtx = {
    sessions,
    sidebarRightTabs: { register(definition) { captured.native = definition; return () => {}; } },
    slots: { register() { return () => {}; } },
  };
  const disposeBetter = sidebar.installExpertGroupSidebar(betterCtx, {
    react, primitives: primitivesOverride, sessions, resolveRootSessionId: (id) => id,
  });
  const disposeNative = sidebar.installExpertGroupSidebar(nativeCtx, {
    react, primitives: primitivesOverride, sessions, resolveRootSessionId: (id) => id,
  });
  return {
    descriptor: (surface) => captured[surface],
    dispose() {
      disposeBetter();
      disposeNative();
    },
  };
}

/** 双人 users artwork 的形状断言：4 条 path，第 3/4 条正是「后面第二个人」的两条轮廓。 */
function assertArtworkPaths(paths) {
  assert.equal(paths.length, 4, "双人图标恰好是 4 条 path（第一人的头 + 肩，第二人的头 + 肩）");
  assert.ok(paths[0].startsWith("M6 8.25C7.51878"), "第一条是前面人像的头部轮廓，实际：" + paths[0]);
  assert.ok(paths[1].startsWith("M1 14.5"), "第二条是前面人像的肩部轮廓，实际：" + paths[1]);
  assert.ok(paths[2].startsWith("M10.5 2.9"), "第三条是后面第二人的头部轮廓，实际：" + paths[2]);
  assert.ok(paths[3].startsWith("M12.4 10.6"), "第四条是后面第二人的肩部轮廓，实际：" + paths[3]);
  for (const d of paths) assert.equal(typeof d, "string");
}

// ── 设置页导航行的品牌图标（client-entry.js 的 DOM 适配）────────────────────────────
/**
 * 设置面板由 DSH 渲染：导航行图标来自 SettingsRoot 里按 section id 硬编码的 navIcon(id)
 * （未知 id 回退齿轮），`settings.section` 注册只投影 id/order/label，插件无法用注册字段声明
 * 图标。因此 DEG 只能在客户端做 DOM 适配——替换宿主 svg 的内容会被 React 的下一次提交按 fiber
 * 位置覆盖回去，所以这里断言的是「宿主原生 svg 被标记交给 CSS 隐藏 + DEG 自有 svg 插在最前」。
 */
let clientModulePromise = null;
/** 真实 client bundle 的导出面（同一进程内只装载一次；侧栏 IIFE 已在本文件顶部登记）。 */
function loadClientModule() {
  clientModulePromise ??= loadClientBundle();
  return clientModulePromise;
}

/** 设置页适配用的最小 document 替身：body + head + createElement/createElementNS。 */
function settingsNavDocumentStub() {
  const body = fakeElement("body");
  const head = fakeElement("head");
  const documentStub = {
    nodeType: 9,
    body,
    head,
    documentElement: fakeElement("html"),
    // head 只为让真实 bundle 的「注入一次样式」路径照常执行（插件不新增注入机制）。
    createElement(tag) { return fakeElement(tag); },
    createElementNS(_namespace, tag) { return fakeElement(tag); },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  return { document: documentStub, body, head };
}

/** 打开中的设置面板：一行 DEG（宿主回退齿轮）、一行其它 section。 */
function settingsDialogStub(dom) {
  const dialog = fakeElement("div", { role: "dialog", "aria-modal": "true" });
  const row = fakeElement("button");
  const nativeSvg = fakeElement("svg", { "stroke-width": "1.3", class: "navIcon_hash" });
  nativeSvg.appendChild(fakeElement("path", { d: "M2 2h12v12H2z" }));
  row.appendChild(nativeSvg);
  // 真实 DOM 里 label 是按钮内的 span，textContent 会把后代文本拼起来——替身按同一观测值给出。
  row.textContent = "dsh-expert-group";
  const otherRow = fakeElement("button");
  otherRow.appendChild(fakeElement("svg", { "stroke-width": "1.3" }));
  otherRow.textContent = "models";
  dialog.appendChild(row);
  dialog.appendChild(otherRow);
  dom.body.appendChild(dialog);
  return { dialog, row, otherRow, nativeSvg };
}

test("设置页导航匹配：label 严格等于 dsh-expert-group 且含 svg 才命中，不做近似匹配", async () => {
  const { client } = await loadClientModule();
  const withSvg = (text) => {
    const button = fakeElement("button");
    button.appendChild(fakeElement("svg"));
    button.textContent = text;
    return button;
  };
  assert.equal(client.isDegSettingsNavRow(withSvg("dsh-expert-group")), true);
  assert.equal(client.isDegSettingsNavRow(withSvg("  dsh-expert-group  ")), true, "可见文本按 trim 后比较（标签两侧空白不算差异）");
  assert.equal(client.isDegSettingsNavRow(withSvg("dsh-expert-group-status")), false, "前缀相同的其它行不得命中");
  assert.equal(client.isDegSettingsNavRow(withSvg("expert group")), false, "展示名不等于注册 label");
  const noSvg = fakeElement("button");
  noSvg.textContent = "dsh-expert-group";
  assert.equal(client.isDegSettingsNavRow(noSvg), false, "没有图标可换的行不动");
  assert.equal(client.isDegSettingsNavRow(null), false);
  assert.equal(client.isDegSettingsNavRow(undefined), false);
  assert.equal(client.isDegSettingsNavRow({ textContent: "dsh-expert-group" }), false, "缺少 querySelector 的节点按不命中处理");
  assert.equal(client.isDegSettingsNavRow({ querySelector() { throw new Error("节点代理拒答"); } }), false, "读取抛错必须吞掉并判为不命中");
});

test("设置页导航图标：只适配 DEG 行、重复同步幂等、dispose 断开 observer 并清干净", async () => {
  const { client } = await loadClientModule();
  const dom = settingsNavDocumentStub();
  const restoreGlobals = installGlobals({ document: dom.document });
  try {
    withFakeObserver((observer) => {
      const { row, otherRow, nativeSvg } = settingsDialogStub(dom);
      const dispose = client.installDegSettingsNavIcon();
      assert.equal(typeof dispose, "function");

      // 命中行：宿主 svg 被标记（CSS 隐藏），DEG 自有 svg 插到第一个子节点之前。
      assert.equal(row.getAttribute("data-deg-settings-nav"), "");
      assert.equal(nativeSvg.getAttribute("data-deg-settings-nav-native"), "");
      const icon = row.firstChild;
      assert.equal(icon.getAttribute("data-deg-settings-nav-icon"), "");
      assert.equal(icon.tagName, "SVG");
      assert.equal(icon.getAttribute("width"), "16");
      assert.equal(icon.getAttribute("height"), "16");
      assert.equal(icon.getAttribute("viewBox"), "0 0 16 16");
      assert.equal(icon.getAttribute("fill"), "none");
      assert.equal(icon.getAttribute("stroke"), "currentColor");
      assert.equal(icon.getAttribute("aria-hidden"), "true");
      assert.equal(icon.getAttribute("stroke-width"), "1.3",
        "描边宽度必须沿用宿主原图标（Medium=1.3），否则这一行的视觉重量与同栏其它行不一致");
      assert.deepEqual(icon.children.map((path) => path.getAttribute("d")), [...client.DEG_SETTINGS_NAV_ICON_PATHS]);
      for (const path of icon.children) {
        assert.equal(path.tagName, "PATH");
        assert.equal(path.getAttribute("stroke"), "currentColor");
        assert.equal(path.getAttribute("fill"), "none");
      }
      // 图标在左、label 在右：宿主按钮是 display:flex;gap:8px，插入不得改变 label 的位置。
      assert.deepEqual(row.children.map((child) => child.tagName), ["SVG", "SVG"]);
      // 其它行完全不动（不得给非目标行插图标，也不得标记它）。
      assert.equal(otherRow.getAttribute("data-deg-settings-nav"), null);
      assert.equal(otherRow.children[0].getAttribute("data-deg-settings-nav-native"), null);
      assert.equal(otherRow.children.length, 1);

      // 幂等：observer 重复回调不得重复插入图标。
      observer.fire();
      observer.fire();
      assert.equal(row.querySelectorAll("svg").length, 2, "自有图标只能有一个（另一个是宿主原生 svg）");
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-icon]").length, 1);
      assert.equal(row.firstChild, icon, "重复同步必须复用同一个自有图标节点");

      // 自愈：宿主重渲染出新的原生 svg（标记随之丢失）后，下一次同步必须把它也隐藏掉。
      const freshNative = fakeElement("svg", { "stroke-width": "1.3" });
      row.appendChild(freshNative);
      nativeSvg.removeAttribute("data-deg-settings-nav-native");
      observer.fire();
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-native]").length, 2, "新旧宿主 svg 都必须被标记隐藏");
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-icon]").length, 1, "自愈不得再插一个自有图标");

      // dispose：断开 observer 并清掉全部标记与自有 svg（宿主 DOM 回到适配前的形状）。
      dispose();
      assert.equal(observer.instances[0].disconnected, true, "dispose 必须断开 observer");
      assert.equal(row.getAttribute("data-deg-settings-nav"), null);
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-native]").length, 0);
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-icon]").length, 0);
      assert.deepEqual(row.children.map((child) => child.tagName), ["SVG", "SVG"], "只剩宿主自己的两个 svg");
      assert.equal(otherRow.children.length, 1);

      // dispose 后 observer 的迟到回调不得再适配（节点已断开/已释放）。
      observer.fire();
      assert.equal(row.querySelectorAll("[data-deg-settings-nav]").length, 0);
      assert.equal(row.querySelectorAll("[data-deg-settings-nav-icon]").length, 0);
      dispose();
      assert.equal(observer.instances.length, 1, "disposer 必须幂等：重复释放不得再装 observer");
    });
  } finally {
    restoreGlobals();
  }
});

test("设置页导航适配：没有 observer、没有 querySelectorAll 或没有 SVG 构造能力时安全 no-op", async () => {
  const { client } = await loadClientModule();
  // 1. 完全没有 document：install 返回可调用的 disposer，且不抛错。
  const noDocumentRestore = installGlobals({ document: undefined });
  try {
    const dispose = client.installDegSettingsNavIcon();
    assert.equal(typeof dispose, "function");
    dispose();
  } finally {
    noDocumentRestore();
  }

  // 2. document 只有 querySelector（旧替身形状）：一律 no-op，不影响插件入口。
  const bareDom = settingsNavDocumentStub();
  const bareDocument = { querySelector: bareDom.document.querySelector, body: bareDom.body };
  const bareRestore = installGlobals({ document: bareDocument });
  try {
    const dispose = client.installDegSettingsNavIcon();
    assert.equal(typeof dispose, "function");
    dispose();
    const { row } = settingsDialogStub(bareDom);
    assert.equal(row.getAttribute("data-deg-settings-nav"), null);
  } finally {
    bareRestore();
  }

  // 3. 有 DOM 但没有 MutationObserver：一次性适配照常生效（设置页此刻若已打开，图标已经换好），
  //    只是不再跟进后续重渲染；观察者缺失不得抛错。
  const dom = settingsNavDocumentStub();
  const restore = installGlobals({ document: dom.document });
  try {
    const { row, nativeSvg } = settingsDialogStub(dom);
    const dispose = client.installDegSettingsNavIcon();
    assert.equal(row.getAttribute("data-deg-settings-nav"), "");
    assert.equal(nativeSvg.getAttribute("data-deg-settings-nav-native"), "");
    assert.equal(row.querySelectorAll("[data-deg-settings-nav-icon]").length, 1);
    dispose();
    assert.equal(row.getAttribute("data-deg-settings-nav"), null, "disposer 在没有 observer 时同样要清理");
  } finally {
    restore();
  }

  // 4. 没有 createElementNS（无法构造 SVG）：保持 no-op，不清空宿主图标，也不留半个标记。
  const noSvgDom = settingsNavDocumentStub();
  const noSvgRow = settingsDialogStub(noSvgDom);
  const noSvgDocument = { ...noSvgDom.document, createElementNS: undefined };
  const noSvgRestore = installGlobals({ document: noSvgDocument });
  try {
    const dispose = client.installDegSettingsNavIcon();
    assert.equal(noSvgRow.row.getAttribute("data-deg-settings-nav"), null, "无法构造 SVG 时不得留下适配标记");
    assert.equal(noSvgRow.nativeSvg.getAttribute("data-deg-settings-nav-native"), null, "宿主原生图标必须保持原样");
    dispose();
  } finally {
    noSvgRestore();
  }
});

/**
 * 右栏拖拽手柄锁的场景夹具（native 路径）。
 *
 * 宿主 AppFrame 的拖拽手柄是带稳定标记 [data-side=rightbar] 的节点，也是用户改右栏宽度的唯一
 * 入口（pointerdown → setPointerCapture → setRightbar）。插件只在这一个元素上写两条内联样式
 * （pointer-events:none + cursor:default，均 !important），并且只以宿主公开读面 sidebarRight.active()
 * 判定「用户眼前这一页到底是不是 Expert Group」：confirmed → 锁；other/missing → 交还宿主；
 * unknown（旧宿主没有该读面）→ 什么都不做，绝不把别的页面一起锁死。
 *
 * 场景用 native 路径（没有 Better）：current = child-1，config.sidebarRight 就是插件解析到的读面，
 * document 里有手柄替身。switchActiveTab 模拟「用户切到别的 tab」——只改读面再发一次会话通知，
 * 这正是插件重估手柄锁的触发边沿。
 */
function dragLockScenario({ handle = null, withActive = true, layout = undefined } = {}) {
  const sink = { events: [] };
  const doc = documentStub(null, null, null, { handle });
  const restoreGlobals = installGlobals({ document: doc });
  const sessions = childSessionsFixture(); // current = child-1
  const opens = [];
  const state = { activeTab: { id: "tab-1", kind: "expert-group" } };
  const sidebarRight = {
    openTab(kind, options) { opens.push({ kind, options }); },
    openTabIn(sessionId, kind) { opens.push({ sessionId, kind }); },
  };
  // setRightbar 可用时才允许验证「已成功固定宽度 → 锁手柄」；旧宿主与失败桥接继续保持解锁。
  const effectiveLayout = layout === undefined && withActive === true
    ? { panels: { setRightbar() {} } }
    : layout;
  // withActive=false：模拟旧宿主——有打开面但没有 active() 读面（证据永远是 unknown）。
  if (withActive === true) sidebarRight.active = () => state.activeTab;
  const dispose = sidebar.installExpertGroupSidebar(
    {
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight,
      slots: { register() { return () => {}; } },
      ...(effectiveLayout === undefined ? {} : { layout: effectiveLayout }),
    },
    { react, primitives, sessions, resolveRootSessionId: rootIdOf },
  );
  return {
    sink, doc, sessions, state, opens, dispose, restoreGlobals,
    /** 宿主把活跃 tab 换成另一个 kind，并通知一次：插件据此重估手柄锁。 */
    switchActiveTab(next) {
      state.activeTab = next;
      sessions.set({
        current: "child-1",
        byId: { "root-1": { id: "root-1" }, "child-1": { id: "child-1", parentId: "root-1" } },
      });
    },
  };
}

test("右栏手柄锁：Expert Group 页默认不锁手柄（用户可拖拽），只有首次分栏事务期间才锁", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const handle = elementStub(sink, "handle:");
    const scenario = dragLockScenario({ handle });
    try {
      // 票据 18：宽度必须允许用户拖拽并记住。Expert Group 页活跃不再等于「禁止拖拽」，
      // 插件在确认页面上一个样式字节都不写，手柄完全交还宿主。
      assert.equal(handle.inline.size, 0, "Expert Group 页活跃时不得再永久锁住手柄");
      assert.deepEqual(sink.events, [], "默认路径不得写任何手柄内联样式");
      drainTimers(timers);
      assert.ok(scenario.opens.length >= 1, "不锁手柄绝不影响页面打开契约");
      assert.equal(handle.inline.size, 0, "打开/同步流程结束后仍然保持可拖拽");
    } finally {
      scenario.dispose();
      scenario.restoreGlobals();
    }
  }));
});

test("右栏手柄锁：setRightbar 缺失或抛错时保持可拖拽", () => {
  withViewportWidth(1600, () => {
    const cases = [
      ["missing", null],
      ["throws", { panels: { setRightbar() { throw new Error("layout store unavailable"); } } }],
    ];
    for (const [label, layout] of cases) {
      withDeferredTimers((timers) => {
        const sink = { events: [] };
        const handle = elementStub(sink, "handle:");
        const scenario = dragLockScenario({ handle, layout });
        try {
          assert.equal(handle.inline.size, 0, label + "：宽度桥接失败时不得锁定手柄");
          drainTimers(timers);
          assert.equal(handle.inline.size, 0, label + "：deferred 流程也必须保持可拖拽");
          assert.ok(scenario.opens.length >= 1, label + "：宽度失败不能阻断页面打开");
        } finally {
          scenario.dispose();
          scenario.restoreGlobals();
        }
      });
    }
  });
});

test("右栏手柄锁：active 缺失且没有其它页时不误写入 50%", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const writes = [];
    const sink = { events: [] };
    const handle = elementStub(sink, "handle:");
    const scenario = dragLockScenario({
      handle,
      layout: { panels: { setRightbar(px) { writes.push(px); } } },
    });
    try {
      assert.deepEqual(writes, [320]);
      scenario.switchActiveTab(undefined);
      assert.deepEqual(writes, [320], "missing 不是其它页面存在，不得切到 50%");
      assert.equal(handle.inline.size, 0, "active 缺失时应交还手柄");
      drainTimers(timers);
      assert.deepEqual(writes, [320]);
    } finally {
      scenario.dispose();
      scenario.restoreGlobals();
    }
  }));
});

test("右栏手柄锁：切到其它右栏页时手柄保持宿主原值（插件不写样式，也不覆盖主题内联值）", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    // 手柄原本就有主题写的内联值（含优先级）：插件默认不写，切页也不得动它们。
    const handle = elementStub(sink, "handle:", { cursor: "grab", "pointer-events": "auto" }, { cursor: "high" });
    const scenario = dragLockScenario({ handle });
    try {
      drainTimers(timers);
      assert.ok(scenario.opens.length >= 1, "打开契约不受手柄策略影响");
      const opensBefore = scenario.opens.length;

      scenario.switchActiveTab({ id: "tab-2", kind: "session" });

      assert.equal(handle.inline.get("pointer-events"), "auto", "宿主原本的 pointer-events 必须原样保留");
      assert.equal(handle.inline.get("cursor"), "grab", "光标保持宿主原本的可拖拽形状");
      assert.equal(handle.priorities.get("cursor"), "high", "原本的优先级不得被改写");
      assert.deepEqual(sink.events, [], "插件不得写任何手柄样式事件");
      drainTimers(timers);
      assert.ok(scenario.opens.length >= opensBefore, "切到别的页只影响宽度策略，打开契约不变");
    } finally {
      scenario.dispose();
      scenario.restoreGlobals();
    }
  }));
});

test("右栏手柄锁：旧宿主没有 active() 读面时绝不碰手柄（兼容优先，绝不误锁别的页面）", () => {
  withViewportWidth(1600, () => withDeferredTimers((timers) => {
    const sink = { events: [] };
    const handle = elementStub(sink, "handle:");
    const scenario = dragLockScenario({ handle, withActive: false });
    try {
      assert.equal(handle.inline.size, 0, "读面不可用时不得写任何内联样式");
      assert.deepEqual(sink.events, [], "一个样式动作都不许发出");
      assert.equal(scenario.doc.queries.includes("[data-side=rightbar]"), false, "连手柄都不查：读不到证据就完全按旧行为走");
      drainTimers(timers);
      assert.ok(scenario.opens.length >= 1, "旧宿主的自动打开语义必须原样保留");
      assert.deepEqual(sink.events, [], "打开流程同样不会碰手柄");
    } finally {
      scenario.dispose();
      scenario.restoreGlobals();
    }
  }));
});

test("右栏手柄锁：手柄比首次同步更晚挂载时保持可拖拽（默认路径不主动补锁）", () => {
  withViewportWidth(1600, () => withDeferredTimers(() => {
    const sink = { events: [] };
    // 安装时手柄还不在 DOM 上（宿主按 rightbarShown/宽度重挂载它）。默认路径不锁手柄，
    // 因此后续同步即使在 DOM 里看到新句柄，也不得为它写任何样式。
    const scenario = dragLockScenario({ handle: null });
    try {
      const handle = elementStub(sink, "handle:");
      scenario.doc.setHandle(handle);
      scenario.switchActiveTab({ id: "tab-1", kind: "expert-group" });
      assert.equal(handle.inline.size, 0, "迟到的手柄不得被默认路径锁住");
      assert.deepEqual(sink.events, []);
    } finally {
      scenario.dispose();
      scenario.restoreGlobals();
    }
  }));
});

test("右栏手柄锁：dispose 后手柄保持宿主原值，之后的通知不再写任何样式", () => {
  withViewportWidth(1600, () => withDeferredTimers(() => {
    const sink = { events: [] };
    const handle = elementStub(sink, "handle:", { cursor: "grab" });
    const scenario = dragLockScenario({ handle });
    try {
      scenario.dispose();
      assert.deepEqual([...handle.inline.keys()], ["cursor"], "dispose 不得留下任何插件写入的样式");
      assert.equal(handle.inline.get("cursor"), "grab", "宿主原值原样保留");
      assert.deepEqual([...handle.priorities.keys()], [], "插件写入的优先级必须清掉");
      const settled = sink.events.length;
      scenario.switchActiveTab({ id: "tab-1", kind: "expert-group" });
      assert.equal(sink.events.length, settled, "卸载后不得再响应对宿主通知（订阅已释放）");
    } finally {
      scenario.restoreGlobals();
    }
  }));
});

test("票据 18：右栏宽度偏好从 localStorage 恢复、clamp 到边界，并随视口变化重算", async () => {
  const runCase = async ({ stored, viewportWidth, expected }) => {
    const sessionsSnapshot = splitRatioSessionsSnapshot();
    // 只有 Expert Group 页：组成证据 confirmed，宽度由插件按偏好写入。
    const inventory = [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group" }];
    const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
    const viewport = resizableViewportStub(viewportWidth);
    const events = [];
    const { layout } = hostRenderedLayoutFixture(events, splitDom.panel);
    const sidebarRight = {
      openTabs: { getSnapshot: () => inventory },
      active: () => ({ id: "tab-expert", kind: "expert-group" }),
      openTab() {},
    };
    const storage = memoryStorage(stored === null ? {} : { "dsh-expert-group/rightbar-width-ratio:v1": stored });
    const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window, localStorage: storage });
    try {
      await withLiveFakeObserver(async () => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout },
          ctxServices: { sidebarRight },
        });
        try {
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(events, ["width:" + expected], "宽度必须按持久化偏好（clamp 后）换算");
          // 同一偏好随视口变化重算：比例仍然成立（不是把旧 px 记成新视口的结果）。
          viewport.resize(2000);
          assert.deepEqual(events, ["width:" + expected, "width:" + Math.round(2000 * (expected / viewportWidth))],
            "视口变化后必须按同一偏好重新换算");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    } finally {
      restoreGlobals();
    }
  };
  // 1) 用户拖到 30%：1600 → 480；2) 越界值 clamp 到 50%：1600 → 800；
  // 3) 越界值 clamp 到下限 15%：1600 → 240；4) 坏值/缺失回退默认 20%：1600 → 320。
  await runCase({ stored: "0.3", viewportWidth: 1600, expected: 480 });
  await runCase({ stored: "0.9", viewportWidth: 1600, expected: 800 });
  await runCase({ stored: "0.01", viewportWidth: 1600, expected: 240 });
  await runCase({ stored: "not-a-number", viewportWidth: 1600, expected: 320 });
  await runCase({ stored: null, viewportWidth: 1600, expected: 320 });
});

test("票据 18：首次分栏事务期间锁住宿主手柄，事务收口/切走后立刻交还", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true },
      "root-b": { id: "root-b", title: "另一个根会话", retainedBy: {} },
    },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话",
      children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }],
    },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const childResource = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const childTab = { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat", contentId: childResource };
  let inventory = [expertTab];
  let active = expertTab;
  const sidebarRight = {
    openTabs: { getSnapshot() { return inventory; } },
    active() { return active; },
    split() { return "pane-child"; },
    openResource() {
      // 真实宿主会提交 tab：inventory/active 立刻变化，但面板侧还没有 pane 归属证据，
      // 事务因此停在「目标已记录、等待提交证据」的窗口里 —— 这正是要锁手柄的那一段。
      inventory = [expertTab, childTab];
      active = childTab;
    },
    close(tabId) {
      inventory = inventory.filter((entry) => entry.tabId !== tabId);
      if (active?.tabId === tabId) active = expertTab;
    },
  };
  const sink = { events: [] };
  const handle = elementStub(sink, "handle:", { cursor: "grab", "pointer-events": "auto" }, { cursor: "high" });
  const dom = documentStub(null, null, null, { handle });
  const restoreGlobals = installGlobals({
    document: dom,
    window: { innerWidth: 1600 },
    // 等待器优先走 RAF；同步替身让「临时扩栏 → 提交 → split」在同一个点击里完成，不混入 deadline。
    requestAnimationFrame(callback) { callback(); return 1; },
  });
  const rowsOf = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
    return result;
  };
  const arrowOf = (output) => rowsOf(output)
    .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/[ \t]+/).includes("deg_expert_group_sidebar_action"));
  try {
    await withControlledTimeouts(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot,
        deps: {
          layout: { panels: { setRightbar() {} } },
          primitives: { ...primitives, IconChevronLeftOutlineRegular: function ChevronLeft() {} },
        },
        ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
      });
      try {
        await fixture.handle.settle();
        assert.equal(handle.inline.get("pointer-events"), "auto", "进入 Expert Group 页不得永久锁手柄");
        assert.deepEqual(sink.events, [], "默认路径不得写任何手柄样式");

        // 首次分栏：事务打开 → 宽度临时 50%，手柄被锁住（这次过渡里宽度由事务独占）。
        const arrow = arrowOf(fixture.handle.output);
        assert.ok(arrow, "行尾箭头必须渲染");
        await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        await fixture.intervals.tick();
        await fixture.handle.settle();
        assert.equal(handle.inline.get("pointer-events"), "none", "首次分栏事务期间必须锁住手柄");
        assert.equal(handle.inline.get("cursor"), "default", "事务期间不得提示可拖拽");
        assert.equal(handle.priorities.get("pointer-events"), "important");

        // 切到另一个会话：本会话的在途事务随切换取消，新会话的同步必须立刻交还手柄。
        sessionsSnapshot.current = "root-b";
        fixture.sessions.notify();
        await fixture.handle.settle();
        await fixture.intervals.tick();
        await fixture.handle.settle();
        assert.equal(handle.inline.get("pointer-events"), "auto", "切走后必须还原宿主原本的 pointer-events");
        assert.equal(handle.inline.get("cursor"), "grab", "光标还原成宿主原本的可拖拽形状");
        assert.equal(handle.priorities.get("cursor"), "high", "原本的优先级必须一起还原");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 分栏事务：split 返回空值或抛错恢复 20%，openResource 抛错保留 seeded guide 的其它 pane", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } },
      "child-a": { id: "child-a", title: "子代理 A", running: true, parentId: "root-a" },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } },
    },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a",
      kind: "root",
      sessionId: "root-a",
      taskName: "根会话",
      children: [{
        id: "child-a",
        kind: "expert",
        sessionId: "child-a",
        taskName: "子代理 A",
        role: "fixer",
        content: "子代理任务",
        status: "running",
        continuable: true,
      }],
    },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const rowsOf = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
    return result;
  };
  const arrowOf = (output) => rowsOf(output)
    .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\\s+/).includes("deg_expert_group_sidebar_action"));

  async function runRejectedSplit(splitBehavior) {
    const restoreViewport = installGlobals({ window: { innerWidth: 1000 } });
    const widthWrites = [];
    const resourceCalls = [];
    const splitCalls = [];
    let inventory = [expertTab];
    let active = expertTab;
    const sidebarRight = {
      openTabs: { getSnapshot() { return inventory; } },
      active() { return active; },
      split() { splitCalls.push(true); return splitBehavior(); },
      openResource(address, options) { resourceCalls.push({ address, options }); },
    };
    const fixture = await renderInstallPanel({
      sessionsSnapshot,
      hostSnapshot,
      deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
      ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
    });
    try {
      await fixture.handle.settle();
      const arrow = arrowOf(fixture.handle.output);
      assert.ok(arrow, "split 失败场景仍应渲染可尝试的箭头");
      await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
      await fixture.handle.settle();
      assert.equal(splitCalls.length, 1);
      assert.deepEqual(resourceCalls, [], "split 未返回 pane 时不得向当前 pane 打开资源");
      assert.ok(widthWrites.includes(500), "事务开始前必须暂时扩到 50%");
      assert.equal(widthWrites.at(-1), 200, "split 失败必须恢复 Expert Group-only 的 20%");
    } finally {
      fixture.handle.unmount();
      fixture.dispose();
      fixture.restoreGlobals();
      restoreViewport();
    }
  }

  await runRejectedSplit(() => undefined);
  await runRejectedSplit(() => { throw new Error("split unavailable"); });

  const restoreViewport = installGlobals({ window: { innerWidth: 1000 } });
  const widthWrites = [];
  const resourceCalls = [];
  const guideTab = { sessionId: "root-a", tabId: "guide-new", kind: "guide", contentId: "sidebar://guide", title: "开始" };
  let inventory = [expertTab];
  let active = expertTab;
  const sidebarRight = {
    openTabs: { getSnapshot() { return inventory; } },
    active() { return active; },
    split() { inventory = [expertTab, guideTab]; active = guideTab; return "pane-child"; },
    openResource(address, options) { resourceCalls.push({ address, options }); throw new Error("resource host unavailable"); },
  };
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
    ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
  });
  try {
    await fixture.handle.settle();
    const arrow = arrowOf(fixture.handle.output);
    assert.ok(arrow);
    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.equal(resourceCalls.length, 1);
    assert.equal(resourceCalls[0].options.replaceTab, "guide-new", "split 产生的 guide 必须作为替换目标");
    assert.equal(inventory[1].tabId, "guide-new", "openResource 抛错时 seeded guide 仍应保留");
    assert.equal(widthWrites.at(-1), 500, "真实其它 pane 已留下时失败收口仍保留 50% 可调宽度");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
    restoreViewport();
  }
});

test("install 分栏事务：目标 inventory 已到但 DOM 永不出现时 deadline 释放事务并恢复 20%", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: { "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } }, "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true } },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话",
      children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }],
    },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const widthWrites = [];
  const splitCalls = [];
  let inventory = [expertTab];
  const sidebarRight = {
    openTabs: { getSnapshot() { return inventory; } },
    active() { return expertTab; },
    split() { splitCalls.push(true); return "pane-child"; },
    openResource() {},
  };
  const rowsOf = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
    return result;
  };
  const arrowOf = (output) => rowsOf(output)
    .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
  const restoreEnvironment = installGlobals({
    window: { innerWidth: 1000 },
    document: undefined,
    // 等待器优先走 RAF；用同步替身避免测试把 0ms 布局等待和 15s deadline 混在一起 flush。
    requestAnimationFrame(callback) { callback(); return 1; },
  });
  try {
    await withControlledTimeouts(async (timers) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot,
        deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
        ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
      });
      try {
        await fixture.handle.settle();
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(splitCalls, [true], "第一点击必须确实发起 split");
        assert.equal(widthWrites.at(-1), 500, "目标尚未完成 DOM 提交时保持临时 50%");
        assert.ok(timers.delays().includes(15000), "必须登记独立的分栏 deadline");

        timers.flushAll();
        assert.equal(widthWrites.at(-1), 200, "目标证据超时后必须回到 Expert Group-only 的 20%");

        // deadline 清掉旧事务后，回到确认的 Expert Group surface 可以再次尝试 split。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(splitCalls, [true, true], "deadline 后不得把下一次点击永久挡成 busy");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        assert.equal(fixture.intervals.active, 0);
      }
    });
  } finally {
    restoreEnvironment();
  }
});

test("install 分栏事务：current session 变为 null 时统一取消旧事务并恢复 20%", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: { "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } }, "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true } },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: { id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话", children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }] },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const widthWrites = [];
  const sidebarRight = {
    openTabs: { getSnapshot() { return [expertTab]; } },
    active() { return expertTab; },
    split() { return "pane-child"; },
    openResource() {},
  };
  const restoreEnvironment = installGlobals({ window: { innerWidth: 1000 }, document: undefined });
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
    ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
  });
  try {
    await fixture.handle.settle();
    const rowsOf = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
      return result;
    };
    const arrow = rowsOf(fixture.handle.output)
      .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.equal(widthWrites.at(-1), 500);

    sessionsSnapshot.current = null;
    fixture.sessions.notify();
    assert.equal(widthWrites.at(-1), 200, "session 消失必须通过统一取消路径回滚宽度");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    restoreEnvironment();
  }
});

test("install 分栏事务：切换到另一会话时不得回滚旧会话宽度", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话 A", retainedBy: { mainView: 1 } },
      "root-b": { id: "root-b", title: "根会话 B", retainedBy: { mainView: 1 } },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true },
    },
    projectionsBySession: {
      "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } },
      "root-b": { values: { subagentCatalog: [] } },
    },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a",
      kind: "root",
      sessionId: "root-a",
      taskName: "根会话 A",
      children: [{
        id: "child-a",
        kind: "expert",
        sessionId: "child-a",
        taskName: "子代理 A",
        role: "fixer",
        content: "子代理任务",
        status: "running",
        continuable: true,
      }],
    },
  };
  const expertA = {
    sessionId: "root-a",
    tabId: "expert-a",
    kind: "dsh-expert-group",
    contentId: "dsh://page/dsh-expert-group",
  };
  const expertB = {
    sessionId: "root-b",
    tabId: "expert-b",
    kind: "dsh-expert-group",
    contentId: "dsh://page/dsh-expert-group",
  };
  const otherB = {
    sessionId: "root-b",
    tabId: "other-b",
    kind: "subagentchat",
    contentId: "dsh-resource://subagentchat/session/child-b",
  };
  let inventory = [expertA];
  let active = expertA;
  const widthWrites = [];
  const sidebarRight = {
    openTabs: { getSnapshot() { return inventory; } },
    active() { return active; },
    split() { return "pane-a"; },
    openResource() {},
  };
  const restoreEnvironment = installGlobals({ window: { innerWidth: 1000 }, document: undefined });
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
    ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
  });
  try {
    await fixture.handle.settle();
    const rowsOf = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
      return result;
    };
    const arrow = rowsOf(fixture.handle.output)
      .find((item) => typeof item === "object"
        && String(item.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
    assert.ok(arrow, "root-a 的子代理行必须提供分栏箭头");

    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.equal(widthWrites.at(-1), 500, "root-a 分栏事务开始时右栏应临时扩到 50%");
    const writesBeforeSwitch = widthWrites.length;

    // root-b 已有自己的其它右栏页；切换时应直接采用 root-b 的 50%，不能先执行 root-a 的 20% 回滚。
    inventory = [expertB, otherB];
    active = expertB;
    sessionsSnapshot.current = "root-b";
    fixture.sessions.notify();

    assert.deepEqual(
      widthWrites.slice(writesBeforeSwitch),
      [500],
      "切换会话只允许写入新会话的宽度，旧会话分栏取消不得把全局宿主宽度改成 20%",
    );
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    fixture.restoreGlobals();
    restoreEnvironment();
  }
});

test("宽度同步：旧会话的右栏 DOM 组成不得改变新会话的宽度", () => {
  withViewportWidth(1000, () => withDeferredTimers(() => {
    const nodeOf = (tabId) => ({
      getAttribute(name) { return name === "data-dockkit-tab" ? tabId : null; },
    });
    // 面板仍保留 root-a 的两个 tab 节点，模拟会话切换和 React 重挂载之间的全局 DOM 窗口。
    const panel = {
      querySelectorAll(selector) {
        return selector === "[data-dockkit-tab]" ? [nodeOf("expert-a"), nodeOf("other-a")] : [];
      },
    };
    const restoreGlobals = installGlobals({ document: documentStub(null, panel) });
    const sessions = sessionsFixture();
    const events = [];
    const expertA = { sessionId: "root-a", tabId: "expert-a", kind: "dsh-expert-group" };
    const otherA = { sessionId: "root-a", tabId: "other-a", kind: "subagentchat" };
    const expertB = { sessionId: "root-b", tabId: "expert-b", kind: "dsh-expert-group" };
    let inventory = [expertA, otherA];
    let active = expertA;
    const sidebarRight = {
      openTabs: { getSnapshot() { return inventory; } },
      active() { return active; },
    };
    const dispose = sidebar.installExpertGroupSidebar({
      sessions,
      sidebarRightTabs: { register() { return () => {}; } },
      sidebarRight,
      slots: { register() { return () => {}; } },
      layout: layoutFixture(events),
    }, {
      react,
      primitives,
      sessions,
      resolveRootSessionId: (id) => id,
    });
    try {
      assert.deepEqual(events, ["width:500"], "root-a 的其它右栏页应使它使用 50% 宽度");

      inventory = [expertB];
      active = expertB;
      sessions.set({
        current: "root-b",
        byId: { "root-a": { id: "root-a" }, "root-b": { id: "root-b" } },
      });

      assert.deepEqual(
        events.slice(1),
        ["width:200"],
        "root-a 遗留的 DOM tab 不得让 root-b 继承 50%，新会话应恢复自己的 20%",
      );
    } finally {
      dispose();
      restoreGlobals();
    }
  }));
});

test("install 分栏事务：当前 composition 不是确认的 Expert Group-only 时 fail-closed", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: { "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } }, "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true } },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: { id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话", children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }] },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const otherTab = { sessionId: "root-a", tabId: "other-tab", kind: "subagentchat", contentId: "dsh://page/subagent/child-a" };
  const splitCalls = [];
  const sidebarRight = {
    openTabs: { getSnapshot() { return [expertTab, otherTab]; } },
    active() { return otherTab; },
    split() { splitCalls.push(true); return "pane-child"; },
    openResource() { throw new Error("不得打开"); },
  };
  const restoreEnvironment = installGlobals({ window: { innerWidth: 1000 }, document: undefined });
  const fixture = await renderInstallPanel({
    sessionsSnapshot,
    hostSnapshot,
    deps: { layout: { panels: { setRightbar() { throw new Error("不得在错误 composition 改宽"); } } } },
    ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
  });
  try {
    await fixture.handle.settle();
    const rowsOf = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
      return result;
    };
    const arrow = rowsOf(fixture.handle.output)
      .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
    await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(splitCalls, [], "错误 composition 不得调用 split()");
  } finally {
    fixture.handle.unmount();
    fixture.dispose();
    restoreEnvironment();
  }
});

/**
 * 分栏事务入口的两种兼容形状（同一份宿主替身只换 active() 的读数）。
 *
 * 真实 DSH 重启后首次进入 Expert Group 页时，宿主只提供 active()：公开 inventory 读不到、
 * dockkit 的右栏 DOM 也还没出现。此时：
 * - active() 明确是 Expert Group ⇒ 必须继续走既有的 split → openResource(paneId, preferNewPane:false)
 *   事务（否则行尾橙色 >> 点了没反应）；
 * - active() 是别的 kind / 没有 kind / 调用抛错 ⇒ 仍然 fail-closed，绝不放开错误状态。
 *
 * 事务内部逻辑（临时 50%、paneId 回执、提交证据、15 秒 deadline、取消回滚）逐字不变，因此
 * 读面持续不可用时由 deadline 收口回 20%，且事务结束后点击必须能再次开始（绝不永久 busy）。
 */
test("install 分栏事务：active-only 兼容宿主（inventory 抛错 + 无 DOM）仍能分栏，deadline 后恢复 20%", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: { "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } }, "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true } },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: { id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话", children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }] },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  const widthWrites = [];
  const splitCalls = [];
  const resourceCalls = [];
  const sidebarRight = {
    // 兼容宿主的真实形状：inventory 存在但读不出来，document 也不可用（DOM 读面同样为 null）。
    openTabs: { getSnapshot() { throw new Error("inventory unavailable"); } },
    active() { return expertTab; },
    split() { splitCalls.push(true); return "pane-child"; },
    openResource(address, options) { resourceCalls.push({ address, options }); },
  };
  const rowsOf = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
    return result;
  };
  const arrowOf = (output) => rowsOf(output)
    .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
  const restoreEnvironment = installGlobals({
    window: { innerWidth: 1000 },
    document: undefined,
    // 等待器优先走 RAF；用同步替身避免测试把 0ms 布局等待和 15s deadline 混在一起 flush。
    requestAnimationFrame(callback) { callback(); return 1; },
  });
  try {
    await withControlledTimeouts(async (timers) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot,
        deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
        ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
      });
      try {
        await fixture.handle.settle();
        // 安装期的自动打开会先写一次 20%：只观察点击之后的行为。
        widthWrites.length = 0;
        splitCalls.length = 0;
        const arrow = arrowOf(fixture.handle.output);
        assert.ok(arrow, "兼容宿主同样必须渲染行尾箭头");

        await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();

        assert.deepEqual(splitCalls, [true], "active() 明确是 Expert Group 时必须真的发起 split");
        assert.equal(widthWrites.at(-1), 500, "事务开始前必须暂时扩到 50%");
        assert.equal(resourceCalls.length, 1, "必须打开一次子代理资源");
        assert.equal(resourceCalls[0].options.paneId, "pane-child", "openResource 必须使用 split 返回的 paneId");
        assert.equal(resourceCalls[0].options.preferNewPane, false, "已有 split pane 时不得再请求新 pane");
        assert.equal(resourceCalls[0].options.kind, "subagentchat");
        assert.ok(timers.delays().includes(15000), "必须登记独立的分栏 deadline");

        // 读面持续不可用：inventory 抛错 + 没有 DOM，因此永远拿不到提交证据；deadline 到点必须收口。
        timers.flushAll();
        assert.equal(widthWrites.at(-1), 200, "读面持续不可用时 deadline 必须回到 Expert Group-only 的 20%");

        // 事务已彻底结束：同一行再次点击必须重新开始，绝不被永久挡成 busy。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(splitCalls, [true, true], "deadline 收口后下一次点击必须能够重新开始事务");
        assert.equal(resourceCalls.length, 2, "第二次点击同样要打开资源（事务不是一次性的）");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        assert.equal(fixture.intervals.active, 0);
      }
    });
  } finally {
    restoreEnvironment();
  }
});

test("install 分栏事务：读面同时缺失但 active 不是 Expert Group 时仍然 fail-closed", async () => {
  const cases = [
    { name: "active 是别的 kind", active: () => ({ sessionId: "root-a", tabId: "other-tab", kind: "subagentchat" }) },
    { name: "active 没有 kind", active: () => ({ sessionId: "root-a", tabId: "tab-without-kind" }) },
    { name: "active() 抛错", active: () => { throw new Error("active unavailable"); } },
  ];
  for (const item of cases) {
    const sessionsSnapshot = {
      current: "root-a",
      byId: { "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } }, "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true } },
      projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
    };
    const hostSnapshot = {
      schemaVersion: 1,
      rootSessionId: "root-a",
      generatedAt: 1,
      root: { id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话", children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }] },
    };
    const widthWrites = [];
    const splitCalls = [];
    const resourceCalls = [];
    const sidebarRight = {
      openTabs: { getSnapshot() { throw new Error("inventory unavailable"); } },
      active: item.active,
      split() { splitCalls.push(true); return "pane-child"; },
      openResource(address, options) { resourceCalls.push({ address, options }); },
    };
    const restoreEnvironment = installGlobals({ window: { innerWidth: 1000 }, document: undefined });
    const fixture = await renderInstallPanel({
      sessionsSnapshot,
      hostSnapshot,
      deps: { layout: { panels: { setRightbar(px) { widthWrites.push(px); } } } },
      ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
    });
    try {
      await fixture.handle.settle();
      widthWrites.length = 0;
      splitCalls.length = 0;
      const rowsOf = (node, result = []) => {
        if (node === null || node === undefined || node === false) return result;
        result.push(node);
        if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
        return result;
      };
      const arrow = rowsOf(fixture.handle.output)
        .find((node) => typeof node === "object" && String(node.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_action"));
      assert.ok(arrow, item.name + "：仍应渲染可尝试的箭头");
      await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
      await fixture.handle.settle();
      assert.deepEqual(splitCalls, [], item.name + "：读面不可用时不得只凭 active() 调用 split()");
      assert.deepEqual(resourceCalls, [], item.name + "：终止在 split 之前，绝不打开资源");
      assert.deepEqual(widthWrites, [], item.name + "：fail-closed 时不得写入任何宽度（尤其不得写 50%）");
    } finally {
      fixture.handle.unmount();
      fixture.dispose();
      restoreEnvironment();
    }
  }
});
/**
 * 关闭点击必须同时收口同一 key 上尚未提交的分栏事务（回归：收回后箭头立刻变橙、右栏卡在 50%）。
 *
 * 真实的中间态窗口：宿主已经让目标 subagentchat tab 出现在公开 inventory（因此面板有了「可关闭」
 * 的 tabId 记录、箭头是青色 <<），但 pane 组成证据仍证明右栏存在其它页 —— dockkit 还没把这个 tab
 * 渲染进 split 返回的 pane，或该会话面板此刻读不到。此时用户点 << 收回：
 *
 * - 修复前：记录被删、箭头回 >>，但面板侧保留 split 意图、install 侧的事务仍停在临时 50%，
 *   直到 15 秒 deadline 才回到 20%（用户看到的就是「卡在 50% 十几秒」），并且同一行的下一次
 *   点击被残留事务挡成 busy（点了没反应）；
 * - 修复后：关闭与分栏事务的收口是同一件事。取消事务让既有同步器按真实组成证据重估，回到
 *   Expert Group-only 的 20%，下一次点击能够重新开始一次分栏与打开。
 *
 * 断言全部落在可观察行为上：宽度写序列、公开 close/openResource/split 调用、箭头状态。绝不
 * 依赖任何实现内部字段或字符串匹配。
 */
test("install 分栏事务：目标 tab 已记录但 pane 组成证据未提交时，点 << 收回必须收口事务并恢复 20%", async () => {
  const sessionsSnapshot = {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true },
    },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话",
      children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }],
    },
  };
  const expertTab = { sessionId: "root-a", tabId: "expert-tab", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
  // 子代理资源地址必须与面板派生出的地址逐字节一致，recordSidebarTab 才认它是「这个资源的 tab」。
  const childResource = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const childTab = { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat", contentId: childResource };
  const widthWrites = [];
  const splitCalls = [];
  const resourceCalls = [];
  const closeCalls = [];
  let inventory = [expertTab];
  let active = expertTab;
  const sidebarRight = {
    openTabs: { getSnapshot() { return inventory; } },
    active() { return active; },
    split() { splitCalls.push(true); return "pane-child"; },
    openResource(address, options) {
      resourceCalls.push({ address, options });
      // 真实宿主的 openResource 会提交这个 tab：公开 inventory 立刻给出它，并成为该会话的活跃 tab。
      inventory = [expertTab, childTab];
      active = childTab;
    },
    close(tabId) {
      closeCalls.push(tabId);
      // 宿主关闭 tab：公开 inventory 与活跃 tab 一起回到 Expert Group，右栏组成随即变成 only。
      inventory = inventory.filter((entry) => entry.tabId !== tabId);
      if (active?.tabId === tabId) active = expertTab;
    },
  };
  const rowsOf = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
    return result;
  };
  // 箭头用公开的 class 名定位（与既有 install 契约用例同一口径），不读任何内部状态。
  const arrowOf = (output) => rowsOf(output)
    .find((item) => typeof item === "object" && String(item.props?.className ?? "").split(/[ \t]+/).includes("deg_expert_group_sidebar_action"));
  // 本用例刻意没有 document：右栏面板还没渲染，面板侧拿不到任何 pane 归属证据，因此 split 事务
  // 永远等不到提交证据 —— 这正是「目标 tab 已记录、事务仍未结算」的真实窗口。
  const restoreEnvironment = installGlobals({
    window: { innerWidth: 1000 },
    document: undefined,
    // 等待器优先走 RAF；同步替身让「临时扩栏 → 提交 → split」在同一个点击里完成，不混入 deadline。
    requestAnimationFrame(callback) { callback(); return 1; },
  });
  try {
    await withControlledTimeouts(async (timers) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot,
        deps: {
          layout: { panels: { setRightbar(px) { widthWrites.push(px); } } },
          // 左箭头图标是「可关闭」能力的一部分：缺它时面板不会建立关闭记录，也不该渲染 <<。
          primitives: { ...primitives, IconChevronLeftOutlineRegular: function ChevronLeft() {} },
        },
        ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
      });
      try {
        await fixture.handle.settle();
        const arrow = arrowOf(fixture.handle.output);
        assert.ok(arrow, "行尾箭头必须渲染");
        assert.equal(arrow.props["data-open"], "false", "初始态是未打开的 >>");
        assert.equal(widthWrites.at(-1), 200, "初始组成是 Expert Group-only，右栏必须处于 20%");

        // 1) 打开：split 创建 pane 并打开资源，inventory 立刻给出目标 tab（箭头因此已经是 <<），但
        //    面板侧始终没有 pane 归属证据，事务只能停在临时 50% 等待 15 秒 deadline。
        await arrow.props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(splitCalls, [true], "首次分栏必须调用公开 split()");
        assert.equal(resourceCalls.length, 1, "必须打开一次子代理资源");
        assert.equal(resourceCalls[0].options.paneId, "pane-child");
        assert.equal(resourceCalls[0].options.preferNewPane, false, "已有 split pane 时不得再请求新 pane");
        assert.equal(widthWrites.at(-1), 500, "分栏事务进行中保持临时 50%");
        assert.ok(timers.delays().includes(15000), "未提交的事务必须登记独立 deadline");
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "true", "inventory 证据到达后必须进入 << 状态");

        // 2) 收回：关闭必须同时收口同一 key 上尚未提交的分栏事务。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(closeCalls, ["subagent-tab"], "关闭必须使用记录里的精确 tabId");
        assert.equal(resourceCalls.length, 1, "关闭不得顺带再打开一次资源");
        // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
        // 这里推进两次轮询采样，验证链完成后箭头、来源与分栏事务一起收口。
        await fixture.intervals.tick();
        await fixture.handle.settle();
        await fixture.intervals.tick();
        await fixture.handle.settle();
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "false", "验证完成后箭头必须回到 >>");
        assert.equal(widthWrites.at(-1), 200, "目标 tab 关闭后组成回到 Expert Group-only，必须立刻恢复 20%");
        assert.equal(timers.delays().includes(15000), false, "事务已收口，不得留下仍在等待的 deadline");

        // 3) 事务收口后再次打开：不得被残留事务挡成永久 busy，也不得重复同一次动作。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(splitCalls, [true, true], "收口后点击必须能够重新开始一次分栏");
        assert.equal(resourceCalls.length, 2, "重新打开必须恰好再打开一次资源");
        assert.equal(resourceCalls[1].address, childResource, "必须打开同一个子代理资源地址");
        assert.equal(resourceCalls[1].options.paneId, "pane-child", "必须复用 split 返回的 pane");
        assert.equal(widthWrites.at(-1), 500, "重新打开后仍然进入可分栏的临时 50%");
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "true", "重新打开后箭头必须回到 <<");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        assert.equal(fixture.intervals.active, 0);
      }
    });
  } finally {
    restoreEnvironment();
  }
});

/**
 * 收回与打开的交错点击不得永久吞掉最后一次意图（回归：过渡中再点是「点了没反应」）。
 *
 * 两种宿主形状都必须在关闭后接受下一次打开：
 * - A) 目标 tab 的 pane 在 DOM 里已经可见（面板据此把后续资源固定复用到该 pane，不再消耗新 pane 配额）；
 * - B) 目标 tab 只在公开 inventory 里（pane 节点还没渲染），关闭后必须重新走公开 split() 得到 pane。
 *
 * 两种形状的共同不变量：关闭把「已提交记录 + 在途 opening 记录 + 未提交分栏事务」一起收口，
 * 因此下一次点击既不会被 busy 挡掉，也不会因此重复同一次动作（同一次点击只发一次 openResource）。
 */
test("install 分栏事务：收回后在途状态不再吞掉下一次打开（有 pane 证据与只有 inventory 两种形状）", async () => {
  const cases = [
    { name: "pane 已渲染：复用已有子代理 pane", paneRendered: true },
    { name: "只有 inventory：重新 split 取 pane", paneRendered: false },
  ];
  for (const item of cases) {
    const sessionsSnapshot = {
      current: "root-a",
      byId: {
        "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } },
        "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true },
      },
      projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
    };
    const hostSnapshot = {
      schemaVersion: 1,
      rootSessionId: "root-a",
      generatedAt: 1,
      root: {
        id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话",
        children: [{ id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A", role: "fixer", content: "子代理任务", status: "running", continuable: true }],
      },
    };
    const expertTab = { sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" };
    const childResource = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
    const childTab = { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat", contentId: childResource };
    const widthWrites = [];
    const splitCalls = [];
    const resourceCalls = [];
    const closeCalls = [];
    let inventory = [expertTab];
    let active = expertTab;
    const dom = continuityDocumentStub();
    const panel = fakeElement("div", { "data-sidebar-right-panel": "" });
    const expertPane = fakeElement("div", { "data-dockkit-pane": "pane-left", "data-dockkit-column": "0" });
    expertPane.appendChild(fakeElement("div", { "data-dockkit-tab": "dsh-expert-group1" }));
    panel.appendChild(expertPane);
    dom.body.appendChild(panel);
    // 目标 tab 的 pane 节点：只在形状 A 里出现，用来验证「已有子代理 pane 时复用、不再 split」。
    const childPane = fakeElement("div", { "data-dockkit-pane": "pane-child", "data-dockkit-column": "1" });
    const childTabNode = fakeElement("div", { "data-dockkit-tab": "subagent-tab" });
    childPane.appendChild(childTabNode);
    const sidebarRight = {
      openTabs: { getSnapshot() { return inventory; } },
      active() { return active; },
      split() {
        splitCalls.push(true);
        inventory = [expertTab, childTab];
        active = childTab;
        if (item.paneRendered && childPane.parentNode === null) panel.appendChild(childPane);
        return "pane-child";
      },
      openResource(address, options) {
        resourceCalls.push({ address, options });
        // 真实宿主的 openResource 会提交这个 tab：inventory 与活跃 tab 一起更新。
        inventory = [expertTab, childTab];
        active = childTab;
      },
      close(tabId) {
        closeCalls.push(tabId);
        inventory = inventory.filter((entry) => entry.tabId !== tabId);
        if (active?.tabId === tabId) active = expertTab;
        // 真实宿主的 close() 只关 tab，不拆掉 pane 本身：残留的 pane 节点必须在关闭后仍可复用。
        if (item.paneRendered && childTabNode.parentNode !== null) childTabNode.remove();
      },
    };
    const rowsOf = (node, result = []) => {
      if (node === null || node === undefined || node === false) return result;
      result.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) rowsOf(child, result);
      return result;
    };
    const arrowOf = (output) => rowsOf(output)
      .find((node) => typeof node === "object" && String(node.props?.className ?? "").split(/[ 	]+/).includes("deg_expert_group_sidebar_action"));
    const restoreEnvironment = installGlobals({
      window: { innerWidth: 1000 },
      document: dom.document,
      requestAnimationFrame(callback) { callback(); return 1; },
    });
    try {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot,
        deps: {
          layout: { panels: { setRightbar(px) { widthWrites.push(px); } } },
          primitives: { ...primitives, IconChevronLeftOutlineRegular: function ChevronLeft() {} },
        },
        ctxServices: { sidebarRight, uiWorkspace: { openSession() {} } },
      });
      try {
        await fixture.handle.settle();
        // 1) 打开：进入 << 状态并打开资源。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "true", item.name + "：打开后必须进入 << 状态");

        // 2) 收回：关闭必须把在途 opening 记录与未提交事务一起收口。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.deepEqual(closeCalls, ["subagent-tab"], item.name + "：关闭必须使用记录里的精确 tabId");
        // 关闭请求 resolve 之后必须由 inventory 的精确证据验证（连续两次采样 absent）才收口：
        // 这里推进两次轮询采样，验证链完成后箭头、来源与分栏事务一起收口。
        await fixture.intervals.tick();
        await fixture.handle.settle();
        await fixture.intervals.tick();
        await fixture.handle.settle();
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "false", item.name + "：验证完成后必须回到 >>");
        assert.equal(widthWrites.at(-1), 200, item.name + "：关闭后必须回到 Expert Group-only 的 20%");

        // 3) 立刻再打开：必须是新的一次打开，而不是被残留状态吞掉。
        await arrowOf(fixture.handle.output).props.onClick({ preventDefault() {}, stopPropagation() {} });
        await fixture.handle.settle();
        assert.equal(resourceCalls.length, 2, item.name + "：收回后的下一次点击必须重新打开资源");
        assert.equal(resourceCalls[1].address, childResource, item.name + "：必须打开同一个子代理资源地址");
        assert.equal(arrowOf(fixture.handle.output).props["data-open"], "true", item.name + "：重新打开后箭头必须回到 <<");
        if (item.paneRendered) {
          assert.deepEqual(splitCalls, [true], item.name + "：已有子代理 pane 时必须复用它，不得再消耗新 pane 配额");
          assert.equal(resourceCalls[1].options.paneId, "pane-child", item.name + "：必须显式指定已有的子代理 pane");
          assert.equal(resourceCalls[1].options.preferNewPane, false);
        } else {
          assert.deepEqual(splitCalls, [true, true], item.name + "：pane 证据缺失时必须重新 split() 取 pane");
          assert.equal(resourceCalls[1].options.paneId, "pane-child");
        }
        assert.equal(widthWrites.at(-1), 500, item.name + "：重新打开后仍然进入可分栏的临时 50%");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        assert.equal(fixture.intervals.active, 0);
      }
    } finally {
      restoreEnvironment();
    }
  }
});

/*
 * ======================== 首次分栏的右栏列宽配比 ========================
 *
 * 症状：用户第一次点行尾 >> 分栏后，右栏总宽度是视口的 50%（既有契约），但 Expert Group 页只占
 * 视口的 25%——因为宿主把右栏内部两条列轨**等分**，而 Expert Group 只该占右栏的 40%（视口 20%），
 * 子代理页占 60%（视口 30%）。
 *
 * 真实 DockKit 结构（只读公开标记）：
 *   [data-sidebar-right-panel][data-sidebar-right-session]
 *     [data-dockkit-split]                        ← 实际列宽由它的内联 grid-template-columns 决定
 *       div[data-dockkit-host="dock"][data-dockkit-column="0"]
 *         [data-dockkit-strip-tabs] > [data-dockkit-tab]   ← tab 是列的后代，不是直接子节点
 *       div[data-dockkit-host="dock"][data-dockkit-column="1"] …
 * split 的直接子节点是「**每个 tab 一个 host**」：同一个 pane（同一列）里每多开一个 tab 就多一个
 * host，它们的 data-dockkit-column 完全相同，因此同列多 host 是合法结构（列 0 一个 host、列 1 两个
 * host 就是「Expert Group 页 + 两个子代理页」的真实形态），必须仍按归并后的两列写 40/60。
 * 列内的 flex-grow 不参与真实列宽计算，因此配比只能写 split 容器的那一条内联属性。
 *
 * 契约（插件侧可观察的全部行为）：
 * - 恰好两列、列号 0/1、列 0 是 Expert Group、列 1 是当前 session 的另一个已知页时，把 split 的
 *   内联 grid-template-columns 写成 minmax(0,0.4fr) 0px minmax(0,0.6fr)（中间那条分隔轨沿用宿主的）；
 * - 组成不再成立（单列、三列、Expert Group 消失、未知/混合/重复归属、多 panel、session 切换、
 *   读面不可用）时立刻交还宿主样式；
 * - 交还只还原「仍是插件写下的那个值 + 优先级」的属性，被外部改写过的值原样保留；
 * - dispose 还原，且此后的迟到回调不再写入。
 */

/** 宿主默认的等分三轨（真实右栏分栏后的初始内联值）。 */
const SPLIT_COLUMNS_HOST_DEFAULT = "minmax(0,0.5fr) 0px minmax(0,0.5fr)";
/** 插件应写入的目标三轨：中间那条分隔轨沿用宿主当前值。 */
const SPLIT_COLUMNS_TARGET = "minmax(0,0.4fr) 0px minmax(0,0.6fr)";

/**
 * 分栏结构节点替身：既是有父子结构与 querySelectorAll 的真实节点（插件靠它解析列组成），
 * 又带 elementStub 的内联样式读写面（插件靠它写/还原 grid-template-columns）。
 * 两类能力来自两个不同的替身，这里显式合并，避免任一侧的语义被顶掉。
 */
function splitNodeStub(sink, label, attributes = {}, initial = {}, initialPriorities = {}) {
  const node = fakeElement("div", attributes);
  Object.assign(node, elementStub(sink, label, initial, initialPriorities));
  return node;
}

/**
 * 一个 dock host：真实结构里是 div[data-dockkit-host="dock"][data-dockkit-column]。
 *
 * 真实 DockLayout 对**每个 tab** 渲染一个这样的 host，同一 pane 的多个 host 共享同一个列号；
 * host 上的 DOM hidden 就是 React 的 `hidden: !w`（w = 该 host 的 tab 是否是该 pane 的
 * activeTabId），而 tab 条（[data-dockkit-strip] > [data-dockkit-strip-tabs] > [data-dockkit-tab]）
 * **只在活跃 host 上渲染**，并且列出该 pane 的全部 tab。因此：
 * - 活跃 host（hidden 为 false）：一条 strip，strip 里是这一个 pane 的全部 tab；
 * - 非活跃 host（hidden 为 true）：完全没有 strip，只有页面内容容器。
 * 列内还可以再塞页面内容（用于模拟嵌套 dock / 浮动 host）。data-dockkit-pane 挂在列上，模拟
 * 真实结构里「活跃非浮动 section」上的那个标记（打开/复用 pane 的既有路径要读它）。
 *
 * options.hidden=true 造的就是非活跃 host（无 strip）；options.hidden 缺省是 false（活跃 host）。
 */
function dockCellStub(sink, column, tabIds, options = {}) {
  const cell = splitNodeStub(sink, "cell-" + column + ":", {
    "data-dockkit-host": "dock",
    "data-dockkit-column": String(column),
    "data-dockkit-pane": options.paneId ?? "pane-" + column,
    ...(options.attributes ?? {}),
  }, options.style ?? {}, options.priorities ?? {});
  // hidden 必须是可读的布尔值（真实 DOM 的 HTMLElement.hidden）；替身直接写同名的自有属性。
  cell.hidden = options.hidden === true;
  if (cell.hidden === true) {
    // 非活跃 host：真实渲染分支是 `children: [w && <TabStrip …/>, …]`，连 strip 都不存在。
    cell.appendChild(fakeElement("div", { "data-dockkit-content": "" }));
    return { cell, strip: null, tabs: null, tabNodes: [] };
  }
  const strip = fakeElement("div", { "data-dockkit-strip": "" });
  const tabs = fakeElement("div", { "data-dockkit-strip-tabs": "" });
  strip.appendChild(tabs);
  cell.appendChild(strip);
  const tabNodes = [];
  for (const tabId of tabIds) {
    const node = fakeElement("div", { "data-dockkit-tab": tabId });
    tabs.appendChild(node);
    tabNodes.push(node);
  }
  cell.appendChild(fakeElement("div", { "data-dockkit-content": "" }));
  return { cell, strip, tabs, tabNodes };
}

/**
 * 构建「右栏面板 + split + dock 列」的 DOM 替身（真实 DockKit 层级）。
 *
 * panel 带 data-sidebar-right-panel 与 data-sidebar-right-session（插件按会话精确选面板）；
 * split 的初始内联 grid-template-columns 就是宿主默认的等分三轨（可用 columns: null 模拟
 * 「宿主当前没有内联声明」）。每个列描述支持 style / priorities，用来模拟宿主自己也写过内联样式。
 */
function splitDocumentStub(options = {}) {
  const sink = { events: [] };
  const sessionId = options.sessionId ?? "root-a";
  const panel = fakeElement("div", {
    "data-sidebar-right-panel": "push",
    "data-sidebar-right-session": sessionId,
  });
  const initialColumns = options.columns === undefined ? SPLIT_COLUMNS_HOST_DEFAULT : options.columns;
  const split = splitNodeStub(sink, "split:", { "data-dockkit-split": "" },
    initialColumns === null ? {} : { "grid-template-columns": initialColumns },
    options.columnPriorities ?? {});
  panel.appendChild(split);
  const cells = (options.cells ?? [
    { column: 0, tabIds: ["dsh-expert-group1"] },
    { column: 1, tabIds: ["subagent-tab"] },
  ]).map((spec) => dockCellStub(sink, spec.column, spec.tabIds ?? [], spec));
  for (const cell of cells) split.appendChild(cell.cell);
  const body = fakeElement("body");
  body.appendChild(panel);
  const document_ = {
    nodeType: 9,
    hidden: false,
    body,
    documentElement: fakeElement("html"),
    createElement(tag) { return fakeElement(tag); },
    getElementById() { return null; },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  return { sink, panel, split, cells, body, document: document_ };
}

/** 构建同一安装内同时残留的多个 session panel；querySelector 的顺序故意保留为调用方传入顺序。 */
function multiPanelSplitDocumentStub(panelOptions = []) {
  const panels = panelOptions.map((options) => splitDocumentStub(options));
  const body = fakeElement("body");
  for (const entry of panels) body.appendChild(entry.panel);
  const document_ = {
    nodeType: 9,
    hidden: false,
    body,
    documentElement: fakeElement("html"),
    createElement(tag) { return fakeElement(tag); },
    getElementById() { return null; },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
  };
  return { panels, body, document: document_ };
}

/** 分栏配比用例共用的宿主快照（root-a + 一个 continuable 子代理）。 */
function splitRatioHostSnapshot() {
  return {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "根会话",
      children: [{
        id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
        role: "fixer", content: "子代理任务", status: "running", continuable: true,
      }],
    },
  };
}

/** 分栏配比用例共用的会话快照。 */
function splitRatioSessionsSnapshot() {
  return {
    current: "root-a",
    byId: {
      "root-a": { id: "root-a", title: "根会话", retainedBy: { mainView: 1 } },
      "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A", running: true },
    },
    projectionsBySession: { "root-a": { values: { subagentCatalog: [{ sessionId: "child-a", mode: "continuable" }] } } },
  };
}

/** 分栏配比用例共用的 sidebarRight 替身（Expert Group 页 + 子代理页都在 root-a 名下）。 */
function splitRatioSidebarRight(inventory) {
  return { openTabs: { getSnapshot: () => inventory }, active: () => "root-a", openTab() {} };
}

/** 分栏配比用例的 inventory 基线：Expert Group 页 + 子代理会话页。 */
function splitRatioInventory() {
  return [
    { sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group", contentId: "dsh://page/dsh-expert-group" },
    { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/child-a" },
  ];
}

/** split 容器上的样式写入次数：sink.events 同时混有 layout 事件，只数这一条属性。 */
const splitStyleWrites = (dom) => dom.sink.events
  .filter((event) => event.startsWith("split:style:" + "grid-template-columns=")).length;

test("install 分栏配比：真实 split 三轨结构下列 0 占 40%、列 1 占 60%，宿主重渲染等分后重施加，单列与 dispose 都还原", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      { column: 0, tabIds: ["dsh-expert-group1"], style: { "min-width": "0" } },
      { column: 1, tabIds: ["subagent-tab"] },
    ],
  });
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async (observer) => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          // 夹具必须是真实形状：tab 芯片在列的 strip-tabs 后代里，而不是列的直接子节点。
          assert.equal(splitDom.cells[0].tabs.parentNode, splitDom.cells[0].strip, "strip-tabs 必须挂在列内的 strip 里");
          assert.equal(splitDom.cells[0].tabNodes[0].parentNode, splitDom.cells[0].tabs, "tab 必须是 strip-tabs 的后代");

          drainTimers(timers);
          // 1) 只改写 split 容器的那一条内联属性，值就是要求的三轨。
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET);
          assert.equal(splitDom.split.priorities.get("grid-template-columns"), "important", "写入必须沿用宿主原本的优先级");
          // 2) 列自己的内联样式一个字都不能动（旧实现写的是列上的 flex-grow）。
          assert.equal(splitDom.cells[0].cell.inline.has("flex-grow"), false, "不得再往列上写 flex-grow");
          assert.equal(splitDom.cells[0].cell.inline.get("min-width"), "0", "不得改写列的其它内联属性");

          // 3) 同一组成的重复同步（面板挂载 / 2.5 秒轮询 / 宿主广播都走这条链路）必须零写入。
          const settledWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          observer.fire();
          assert.equal(splitStyleWrites(splitDom), settledWrites, "重复同步必须是零写入（幂等）");
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET);

          // 4) 宿主重渲染回它自己的等分形态：必须重新施加 40/60，而不是只按容器身份短路。
          splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT);
          const repairWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "宿主重渲染等分后必须重新施加配比");
          assert.ok(splitStyleWrites(splitDom) > repairWrites, "外部重写后必须重新写入配比");

          // 5) 单列：列 1 消失后必须立刻交还宿主原本的值与优先级。
          splitDom.split.removeChild(splitDom.cells[1].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "单列时必须还原宿主原值");
          assert.equal(splitDom.split.priorities.get("grid-template-columns"), "important", "还原必须连优先级一起还");

          // 6) 宿主删掉自己的内联声明后重新分栏：仍要写入目标配比（分隔轨用规范值）。
          splitDom.split.style.removeProperty("grid-template-columns");
          const nextCell = dockCellStub(splitDom.sink, 1, ["subagent-tab-2"]);
          inventory.push({ sessionId: "root-a", tabId: "subagent-tab-2", kind: "subagentchat" });
          splitDom.split.appendChild(nextCell.cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "重新分栏必须重新写入配比");

          // 7) 卸载：还原宿主原值，且此后的迟到 observer / 会话通知都不再写入。
          fixture.handle.unmount();
          fixture.dispose();
          const writesAfterDispose = splitStyleWrites(splitDom);
          observer.fire();
          fixture.sessions.notify();
          assert.equal(splitStyleWrites(splitDom), writesAfterDispose, "dispose 后的迟到同步不得再次写入");
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "dispose 必须还原宿主原值");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

/**
 * 多个子代理 tab 时仍要维持 40/60 配比。
 *
 * 真实 DockLayout（app.asar 里渲染 host 的那个组件）对**每个 tab** 渲染一个
 * div[data-dockkit-host="dock"]，同一 pane 的多个 tab 共享同一个 data-dockkit-column；但 tab 条
 * 只挂在**活跃 tab 的那个 host** 上：
 *   hidden: !w                            ← 非活跃 host 带 DOM hidden
 *   children: [ w && <TabStrip …/>, … ]   ← 非活跃 host 连 strip 都不渲染
 * 而活跃 host 的那条 strip 列出的是**该 pane 的全部 tab**。所以「列 1 有两个子代理 tab」的真实形状
 * 是：一个可见活跃 host（唯一 strip，里面两个 tab）+ 一个 hidden 空 host。
 *
 * 旧实现要求同列**每个** host 都有自己的 strip，于是第二个子代理 tab 一出现，列 1 就变成「读不出来」
 * 并交还宿主，用户看到的就是退回 1:1。本用例先守住真实形状必须仍然写 40/60，再逐条守住非活跃 host
 * 与结构异常的 fail-closed 边界。
 */
test("install 分栏配比：同一列由多个 host（每个 tab 一个 host）时仍写 40/60，非活跃 hidden host 与结构异常都 fail-closed", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  // 第二个子代理 tab 必须先进入当前 session 的 inventory，否则它会被当成未知归属而 fail-closed。
  const inventory = [...splitRatioInventory(),
    { sessionId: "root-a", tabId: "subagent-tab-2", kind: "subagentchat", contentId: "dsh-resource://subagentchat/session/child-b" }];
  const splitDom = splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      // 列 0：一个 tab，一个可见活跃 host。
      { column: 0, tabIds: ["dsh-expert-group1"] },
      // 列 1：两个 tab 属于同一个 pane → 活跃 host 的唯一 strip 列出两个 tab；
      // 另一个 host 是非活跃的（hidden，完全没有 strip）。
      { column: 1, tabIds: ["subagent-tab", "subagent-tab-2"] },
      { column: 1, hidden: true },
    ],
  });
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async (observer) => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          // 夹具必须是真实形状：列 1 的两个 host 共享列号，只有活跃 host 有 strip。
          assert.equal(splitDom.cells[1].cell.parentNode, splitDom.split, "列 1 的第二个 host 必须是 split 的直接子节点");
          assert.equal(splitDom.cells[1].cell.getAttribute("data-dockkit-column"), "1", "同一 pane 的多个 host 共享同一个列号");
          assert.equal(splitDom.cells[2].cell.getAttribute("data-dockkit-column"), "1", "同一 pane 的多个 host 共享同一个列号");
          assert.equal(splitDom.cells[1].cell.hidden, false, "活跃 host 不带 hidden");
          assert.equal(splitDom.cells[1].tabNodes.length, 2, "活跃 host 的唯一 strip 列出该 pane 的全部 tab");
          assert.equal(splitDom.cells[2].cell.hidden, true, "非活跃 host 带 DOM hidden");
          assert.equal(splitDom.cells[2].cell.querySelectorAll("[data-dockkit-strip-tabs]").length, 0, "非活跃 host 完全没有 strip");

          drainTimers(timers);
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
            "同列多 host 的真实结构必须仍然写 40/60，绝不退回宿主的 50/50");

          // 重复同步（面板挂载 / 轮询 / 宿主广播）必须幂等：已经是目标值就零写入。
          const settledWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          observer.fire();
          assert.equal(splitStyleWrites(splitDom), settledWrites, "重复同步必须是零写入（幂等）");
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET);

          // 宿主重渲染回自己的等分形态：必须重新施加 40/60。
          splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "宿主重渲染等分后必须重新施加配比");

          // 边界一：活跃 strip 里出现未知归属的 tab（不在本会话 inventory 里）→ 交还宿主。
          splitDom.cells[1].tabNodes[1].setAttribute("data-dockkit-tab", "mystery-tab");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "未知 tab 必须 fail-closed");
          splitDom.cells[1].tabNodes[1].setAttribute("data-dockkit-tab", "subagent-tab-2");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "归属恢复后重新施加");

          // 边界二：同一条 strip 里出现重复 tabId（一个 tab 不可能在同一个 tablist 里出现两次）
          // → 结构异常，绝不能靠 Set 静默吞掉重复。
          const duplicatedTab = fakeElement("div", { "data-dockkit-tab": "subagent-tab" });
          splitDom.cells[1].tabs.appendChild(duplicatedTab);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "同一条 strip 内重复 tabId 必须 fail-closed");
          duplicatedTab.remove();
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "重复消失后重新施加");

          // 边界三：整列没有活跃 strip（把活跃 host 摘掉，只剩 hidden 且没有 strip 的 host）。
          // 这正是重启恢复期的「暂不可读」形状：结构仍是两列、列 0 仍是 Expert Group 页，
          // 只有列 1 的 tab 条还没提交。已经写过目标配比之后必须**保持**并短延迟重试，
          // 绝不闪回宿主默认值（详见「重启恢复期」那组用例）。
          splitDom.split.removeChild(splitDom.cells[1].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "整列暂不可读时必须保持目标配比，不得闪回宿主默认值");
          splitDom.split.insertBefore(splitDom.cells[1].cell, splitDom.cells[2].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "活跃 host 回来后重新施加");

          // 边界四：hidden 状态不可读（DOM 读面缺失）→ 归属不可证明，交还宿主。
          const savedHidden = splitDom.cells[2].cell.hidden;
          delete splitDom.cells[2].cell.hidden;
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "hidden 状态不可读必须 fail-closed");
          splitDom.cells[2].cell.hidden = savedHidden;
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "hidden 读面恢复后重新施加");

          // 边界五：非活跃 host 却带着自己的 strip（结构不是本插件认识的那一种）→ 交还宿主。
          const strayStrip = fakeElement("div", { "data-dockkit-strip": "pane-1" });
          const strayTabs = fakeElement("div", { "data-dockkit-strip-tabs": "pane-1" });
          strayStrip.appendChild(strayTabs);
          strayTabs.appendChild(fakeElement("div", { "data-dockkit-tab": "subagent-tab-2" }));
          splitDom.cells[2].cell.appendChild(strayStrip);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "hidden host 带自己的 strip 必须 fail-closed");

          // 边界六：同一逻辑列出现两个活跃 strip host（把上面那个 host 变可见）→ 组成不唯一，交还宿主。
          splitDom.cells[2].cell.hidden = false;
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "一个逻辑列出现多个活跃 strip 必须 fail-closed");

          // 边界七：可见 host 却没有 strip（摘掉它的 strip，保持可见）→ 交还宿主。
          splitDom.cells[2].cell.removeChild(strayStrip);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "可见 host 没有 strip 必须 fail-closed");

          // 回到真实形状：非活跃 host 重新带 hidden 且没有 strip。
          splitDom.cells[2].cell.hidden = true;
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "回到真实形状后重新施加");

          // 边界八：单列（列 1 的 host 全被移除）→ 立刻交还宿主原值与优先级。
          splitDom.split.removeChild(splitDom.cells[1].cell);
          splitDom.split.removeChild(splitDom.cells[2].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "单列时必须还原宿主原值");
          assert.equal(splitDom.split.priorities.get("grid-template-columns"), "important", "还原必须连优先级一起还");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：CSSOM 将 minmax 的 0 规范化为 0px 时仍识别三轨", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    columns: "minmax(0px,0.5fr) 0px minmax(0px,0.5fr)",
  });
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async () => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          drainTimers(timers);
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
            "CSSOM 的 0px 规范化不得让合法等分轨道 fail-closed");
        } finally {
          fixture.dispose();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：外部改写的不等分值必须让位并保留，绝不盖回宿主原值", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub();
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async (observer) => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          drainTimers(timers);
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");

          // 外部（用户拖分隔条 / 别的插件）改成两端不等的第三值：组成仍有效，但插件必须让位。
          splitDom.split.style.setProperty("grid-template-columns", "minmax(0,0.7fr) 0px minmax(0,0.3fr)");
          const externalWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          observer.fire();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), "minmax(0,0.7fr) 0px minmax(0,0.3fr)", "外部改写的配比必须被保留");
          assert.equal(splitStyleWrites(splitDom), externalWrites, "让位时不得产生任何写入");

          // 组成失效时同样不许把外部值盖回宿主原值（只还原「仍是插件写入状态」的属性）。
          splitDom.split.removeChild(splitDom.cells[1].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), "minmax(0,0.7fr) 0px minmax(0,0.3fr)", "外部改写过的值绝不盖回旧值");
          assert.equal(splitStyleWrites(splitDom), externalWrites, "交还时不得覆盖外部写入");

          // 宿主自己把等分写回来后，插件可以重新接管（这是宿主默认形态，不是外部刻意改动）。
          splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT);
          splitDom.split.appendChild(splitDom.cells[1].cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "宿主回到等分后重新施加配比");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：宿主没有内联轨道声明时用规范分隔轨施加，dispose 连属性一起删除", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  // columns: null = 宿主当前没有内联 grid-template-columns（属性整个不存在）。
  const splitDom = splitDocumentStub({ columns: null });
  // 断言必须在 install 之前：install 期的那一轮同步就会把目标配比写上去。
  assert.equal(splitDom.split.inline.has("grid-template-columns"), false, "夹具必须是「宿主没有内联声明」");
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async (observer) => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          drainTimers(timers);
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "宿主没有内联声明时仍要施加目标配比");

          // 宿主显式写回自己的等分形态（重渲染）：仍然按宿主默认形态重新施加。
          splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "宿主写回等分后重新施加配比");

          fixture.handle.unmount();
          fixture.dispose();
          assert.equal(splitDom.split.inline.has("grid-template-columns"), false, "宿主原本没有内联声明时必须删除属性本身");
          const writesAfterDispose = splitStyleWrites(splitDom);
          observer.fire();
          fixture.sessions.notify();
          assert.equal(splitStyleWrites(splitDom), writesAfterDispose, "dispose 后的迟到同步不得再次写入");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：多 panel / session 切换 / 列组成不明确时一律 fail-closed，绝不覆盖宿主写入", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub();
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withFakeObserver(async (observer) => {
      await withDeferredTimers(async (timers) => {
        const fixture = await renderInstallPanel({
          sessionsSnapshot,
          hostSnapshot: splitRatioHostSnapshot(),
          deps: { layout: layoutFixture(splitDom.sink.events) },
          ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
        });
        try {
          drainTimers(timers);
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");
          const expertTab = splitDom.cells[0].tabNodes[0];
          const otherTab = splitDom.cells[1].tabNodes[0];

          // A) 未知 tab（不在当前 session 的 inventory 里）：归属不可证明 → 交还宿主。
          otherTab.setAttribute("data-dockkit-tab", "mystery-tab");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "未知 tab 必须 fail-closed");
          otherTab.setAttribute("data-dockkit-tab", "subagent-tab");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "归属恢复后重新施加");

          // B) 混合 / 重复归属：列 1 里出现 Expert Group 页 → 没有可证明的 40:60。
          const duplicatedExpert = fakeElement("div", { "data-dockkit-tab": "dsh-expert-group1" });
          splitDom.cells[1].tabs.appendChild(duplicatedExpert);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "重复归属必须 fail-closed");
          duplicatedExpert.remove();
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "重复归属消失后重新施加");

          // C) 列 0 里混进别的已知页：Expert Group 与其它页混在同一列 → fail-closed。
          const mixedKnown = fakeElement("div", { "data-dockkit-tab": "subagent-tab" });
          splitDom.cells[0].tabs.appendChild(mixedKnown);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "混合列必须 fail-closed");
          mixedKnown.remove();
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "混合列消失后重新施加");

          // D) 列号重复：列 1 的 host 被标成列 0 后，同一个逻辑列里出现**两个活跃 strip host**
          //    （同列多 host 本身合法，但活跃 strip 必须唯一）→ 组成不明确，交还宿主。
          splitDom.cells[1].cell.setAttribute("data-dockkit-column", "0");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "一个逻辑列出现多个活跃 strip 时必须 fail-closed");
          splitDom.cells[1].cell.setAttribute("data-dockkit-column", "1");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "列号恢复后重新施加");

          // D2) 直接 host 缺列号：拿不到列号的节点不能被当成一列，整轮 fail-closed。
          splitDom.cells[1].cell.removeAttribute("data-dockkit-column");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "直接 host 缺列号必须 fail-closed");
          splitDom.cells[1].cell.setAttribute("data-dockkit-column", "1");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "列号恢复后重新施加");

          // E) 三列：没有「谁该拿 40%」的可证明关系。
          const thirdCell = dockCellStub(splitDom.sink, 2, ["subagent-tab"]);
          splitDom.split.appendChild(thirdCell.cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "三列必须 fail-closed");
          splitDom.split.removeChild(thirdCell.cell);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "回到两列后重新施加");

          // F) 浮动 host 不是列：它自己的 strip（未知 tab）也不能改判两列组成。
          // 真实浮动 host 是 data-dockkit-host="float" 且**没有** data-dockkit-column（React 写的是
          // `"data-dockkit-column": x ? void 0 : u`）：它既不是 "dock" 也拿不到列号，两种理由都轮不到它当列。
          const floatingHost = fakeElement("div", { "data-dockkit-host": "float" });
          const floatingStrip = fakeElement("div", { "data-dockkit-strip-tabs": "" });
          floatingStrip.appendChild(fakeElement("div", { "data-dockkit-tab": "floating-tab" }));
          floatingHost.appendChild(floatingStrip);
          splitDom.split.appendChild(floatingHost);
          const floatingWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "浮动 host 不得影响两列判定");
          assert.equal(splitStyleWrites(splitDom), floatingWrites, "已是目标值时浮动 host 不得引起写入");
          splitDom.split.removeChild(floatingHost);

          // G) 嵌套 dock 的 strip 属于页面内容：它里面的 Expert Group / 未知 tab 都不算当前列。
          const nestedHost = fakeElement("div", { "data-dockkit-host": "dock", "data-dockkit-column": "3" });
          const nestedStrip = fakeElement("div", { "data-dockkit-strip-tabs": "" });
          nestedStrip.appendChild(fakeElement("div", { "data-dockkit-tab": "dsh-expert-group1" }));
          nestedStrip.appendChild(fakeElement("div", { "data-dockkit-tab": "mystery-nested" }));
          nestedHost.appendChild(nestedStrip);
          splitDom.cells[0].cell.appendChild(nestedHost);
          const nestedWrites = splitStyleWrites(splitDom);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "嵌套 strip 不得参与当前列判定");
          assert.equal(splitStyleWrites(splitDom), nestedWrites, "嵌套 strip 不得引起任何写入");
          splitDom.cells[0].cell.removeChild(nestedHost);

          // H) 空列：列 1 自己的 strip 里一个 tab 都没有 → 组成读不出来，必须交还宿主。
          const detachedTab = splitDom.cells[1].tabs.removeChild(otherTab);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "空列必须 fail-closed");
          splitDom.cells[1].tabs.appendChild(detachedTab);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "列恢复后重新施加");

          // I) 同会话的第二个 panel：querySelector 的第一个命中不可信 → fail-closed。
          const duplicatePanel = fakeElement("div", {
            "data-sidebar-right-panel": "push",
            "data-sidebar-right-session": "root-a",
          });
          splitDom.body.appendChild(duplicatePanel);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "同会话多 panel 必须 fail-closed");
          // 别的会话的 panel 不参与选择：仍按本会话的面板施加。
          duplicatePanel.setAttribute("data-sidebar-right-session", "root-b");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "其它会话的 panel 不得影响本会话");
          splitDom.body.removeChild(duplicatePanel);

          // J) 面板缺会话标记：归属不可证明 → 不写。
          splitDom.panel.removeAttribute("data-sidebar-right-session");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "面板缺会话标记必须 fail-closed");
          splitDom.panel.setAttribute("data-sidebar-right-session", "root-a");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "会话标记恢复后重新施加");

          // K) 当前 session 切走：旧面板不再属于本 surface，必须交还。
          sessionsSnapshot.byId["root-b"] = { id: "root-b", retainedBy: { mainView: 1 } };
          sessionsSnapshot.current = "root-b";
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "session 切换后必须交还");
          sessionsSnapshot.current = "root-a";
          delete sessionsSnapshot.byId["root-b"];
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "回到本会话后重新施加");

          // L) Expert Group 页消失（列 0 变成别的已知页）：没有 Expert Group 就不再配比。
          expertTab.setAttribute("data-dockkit-tab", "subagent-tab");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "没有 Expert Group 页时必须交还");
          expertTab.setAttribute("data-dockkit-tab", "dsh-expert-group1");
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "Expert Group 页回来后重新施加");

          // M) inventory 读面不可用（非数组）：缺少严格归属证据 → 交还。
          const savedInventory = inventory.map((entry) => ({ ...entry }));
          inventory.splice(0, inventory.length, { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" });
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "inventory 里没有 Expert Group tabId 时必须 fail-closed");
          inventory.splice(0, inventory.length, ...savedInventory);
          fixture.sessions.notify();
          assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "inventory 恢复后重新施加");
        } finally {
          fixture.handle.unmount();
          fixture.dispose();
          fixture.restoreGlobals();
        }
      });
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ======================== 重启恢复期的分栏配比暂不可读 ========================
 *
 * 场景（用户可见症状）：DSH 重启后宿主从持久化布局恢复右栏分栏，第二列（子代理页）的 tab
 * 条与 inventory 归属会**比 split 容器晚若干帧**才提交。旧实现在这段窗口里读不出「列 1 是
 * 本会话的另一个已知页」，于是把列宽当成「组成已失效」立刻交还宿主，用户看到的是
 * 40/60 → 50/50 的闪回，随后才被下一轮同步补回 40/60。
 *
 * 契约（本次新增，只作用于「已经写进过目标配比」之后）：
 * - 重启恢复窗口里第二列内容暂不可读时**保持当前样式**，不得出现 target → host default 闪回；
 * - 同时安排**有界、去重、可取消**的短延迟重试；读面恢复后由重试（或任何一次既有同步）自动
 *   重新落到目标配比，重试预算用尽后必须交还宿主默认值（有限预算，绝不无限重排）；
 * - 首次接管不因此放松：从未写进过目标配比的未知页面归属仍然 fail-closed。
 */

/**
 * 把列 1 的**活跃** host 摘掉，只留下同列的 hidden host（真实 DockLayout 对每个 tab 各渲染一个
 * host，非活跃 host 带 DOM hidden 且不渲染 tab 条）。
 *
 * 这正是重启恢复窗口里最典型的暂不可读形状：结构上仍是两列、列 0 仍是 Expert Group 页，
 * 只有列 1 的 tab 条还没提交——既不能证明组成成立，也没有任何证据说明组成失效。
 */
function detachColumnActiveHost(splitDom) {
  splitDom.split.removeChild(splitDom.cells[1].cell);
  return () => splitDom.split.insertBefore(splitDom.cells[1].cell, splitDom.cells[2].cell);
}

/** 暂不可读重试的延迟（与源码的 SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS 同值）。 */
const SPLIT_PENDING_RETRY_DELAY_MS = 400;

/**
 * 只接管「pending 重试」那一档延迟的 setTimeout，其余定时器一律交回真实调度器。
 *
 * 为什么不用 withDeferredTimers：它的 finally 会在异步测试体的**第一个 await** 处就恢复真实
 * setTimeout（假定时器只在同步阶段有效），而这些用例的断言点全在安装完成之后，notify 触发的
 * 重试会落到真实调度器上、size() 恒为 0。这里就地接管到用例结束。
 *
 * 拦截范围必须**只限于** delay === SPLIT_PENDING_RETRY_DELAY_MS：插件还用它排程打开请求（0ms）、
 * 展开补偿（250ms）、事务 deadline（15s）等 deferred 任务，那些任务一旦被吞进 fake 表就永远
 * 不会执行，用例会在一个「宿主从未提交打开请求」的失真环境里断言（用例里的 setImmediate
 * 也就等不到它们）。因此其它延迟一律调用 realSetTimeout 走真实调度器。
 *
 * clearTimeout 必须同时认两种句柄：fake timer id（数字）与真实 timer 句柄（Node 的 Timeout 对象）。
 */
function withSplitRetryTimers(run) {
  const pendingRetries = new Map();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextRetryTimerId = 1;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay !== SPLIT_PENDING_RETRY_DELAY_MS) return realSetTimeout(callback, delay, ...args);
    const id = nextRetryTimerId++;
    pendingRetries.set(id, { callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    // fake id 只可能是本替身发出去的数字；命中就只从 fake 表移除，否则交给真实调度器。
    if (typeof id === "number" && pendingRetries.delete(id)) return;
    realClearTimeout(id);
  };
  const entries = () => [...pendingRetries.entries()];
  const retryTimers = {
    size: () => entries().length,
    delays: () => entries().map(([, entry]) => entry.delay),
    /** 只推进 pending 重试（其它 deferred 任务由真实调度器负责），返回实际推进轮数。 */
    drain(limit = 8) {
      let rounds = 0;
      while (retryTimers.size() > 0 && rounds < limit) {
        for (const [id, entry] of entries()) {
          pendingRetries.delete(id);
          entry.callback();
        }
        rounds += 1;
      }
      return rounds;
    },
  };
  return Promise.resolve()
    .then(() => run(retryTimers))
    .finally(() => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    });
}

test("install 分栏配比：重启恢复期间第二列内容暂不可读时保持目标配比并自动重试，不闪回宿主默认", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      { column: 0, tabIds: ["dsh-expert-group1"] },
      { column: 1, tabIds: ["subagent-tab"] },
      // 同列第二个 host（非活跃、hidden、没有 strip）：摘掉活跃 host 后列 1 仍然存在。
      { column: 1, hidden: true },
    ],
  });
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        // 安装期的 deferred 任务（打开请求 / 展开补偿）走真实调度器，等它们落定后再断言配比。
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");
        const restoreHost = detachColumnActiveHost(splitDom);

        // 1) 重启恢复窗口：列 1 的内容暂不可读 → 保持目标配比，绝不立刻交还宿主默认值。
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
          "暂不可读期间不得出现 target → host default 闪回");
        assert.equal(splitDom.split.priorities.get("grid-template-columns"), "important", "保持期间不得改动优先级");

        // 2) 同时必须安排重试：去重（重复同步只保留一个待执行重试）且延迟是短延迟。
        assert.equal(retryTimers.size(), 1, "暂不可读时必须安排恰好一次重试");
        fixture.sessions.notify();
        observer.fire();
        assert.equal(retryTimers.size(), 1, "重复同步不得堆积重试定时器（去重）");
        assert.ok(retryTimers.delays().every((delay) => delay > 0 && delay <= 1000), "重试必须是短延迟");

        // 3) 读面恢复（列 1 的活跃 host 回来）后，**只推进一轮 timer** 就必须自动收敛：
        //    重试回调必须重新调用真实读面（document/session/panel/split/inventory 全部现读），
        //    绝不能把上一轮的 pending 结论原样回放——否则 timer 自己永远看不到 target，收敛
        //    只能依赖外部的 sessions/observer 通知，「有界短延迟重试自动收敛」就是空话。
        //    因此这里刻意**不**调用 fixture.sessions.notify()：外部同步通知路径由下一个用例覆盖。
        restoreHost();
        const recoverRounds = retryTimers.drain(1);
        assert.equal(recoverRounds, 1, "读面恢复后必须由 timer 自己完成一轮重读");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "读面恢复后仍是目标配比");
        assert.equal(retryTimers.size(), 0, "读面恢复后 timer 必须清空 pending，绝不再重排");

        // 4) 有界预算：再次暂不可读时反复推进重试，最终必须交还宿主默认值并停止重排。
        detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "重试预算内仍保持目标配比");
        const rounds = retryTimers.drain();
        assert.ok(rounds <= 8, "重试链必须有界，绝不允许无限重排定时器");
        assert.equal(retryTimers.size(), 0, "重试预算用尽后不得留下待执行的定时器");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT,
          "有限预算结束后必须交还宿主默认值");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

/**
 * 「列 1 有两个 host：一个活跃 + 一个同列 hidden」的两列夹具。
 *
 * 摘掉活跃 host 后列 1 仍然存在（只剩 hidden host、没有 tab 条），这正是重启恢复窗口里
 * 「暂不可读」的形状：结构仍是两列、列 0 仍是 Expert Group 页，只有列 1 的内容还没提交。
 */
function splitRatioPendingDom() {
  return splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      { column: 0, tabIds: ["dsh-expert-group1"] },
      { column: 1, tabIds: ["subagent-tab"] },
      { column: 1, hidden: true },
    ],
  });
}

/** 外部（用户拖分隔条 / 别的插件）刻意写下的非等分三轨。 */
const SPLIT_COLUMNS_EXTERNAL = "minmax(0,0.7fr) 0px minmax(0,0.3fr)";

/**
 * pending 重试预算（与源码的 SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS 同值）。
 * 语义是「**实际执行过的** pending retry timer 轮数上限」，不是外部同步次数。
 */
const SPLIT_PENDING_MAX_ATTEMPTS = 4;

test("install 分栏配比：暂不可读 pending 期间宿主重渲染回等分时，重试必须把配比修复回目标", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitRatioPendingDom();
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        // 安装期的 deferred 任务（打开请求 0ms / 展开补偿 250ms）走真实调度器，等它们落定。
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");

        // 进入 pending：保持目标配比并留下一个待执行重试。
        const restoreHost = detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "暂不可读期间保持目标配比");
        assert.equal(retryTimers.size(), 1, "暂不可读时必须安排一次重试");

        // 宿主在暂不可读窗口里重渲染回它自己的等分形态（内联值与优先级都由宿主写回）。
        // 此时只「保持当前样式」会把 50/50 一直留在屏幕上——必须由重试重新施加目标配比。
        splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT, "important");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "前提：宿主确实写回了等分");

        // 只推进一轮 pending timer：修复必须由 timer 自己完成（不依赖任何外部同步通知）。
        const repairedRounds = retryTimers.drain(1);
        assert.equal(repairedRounds, 1, "必须由 timer 自己完成一轮重读与修复");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
          "暂不可读期间宿主重渲染等分后，重试必须把配比修复回目标");
        assert.equal(splitDom.split.priorities.get("grid-template-columns"), "important", "修复必须沿用宿主原本的优先级");
        assert.equal(retryTimers.size(), 1, "组成还没恢复时必须继续有界重试，而不是停止观察");

        // 读面恢复后同样由 timer 收敛并清空 pending。
        restoreHost();
        retryTimers.drain(1);
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "读面恢复后仍是目标配比");
        assert.equal(retryTimers.size(), 0, "读面恢复后必须清空 pending，绝不再重排");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

/**
 * 高频外部同步不得消耗重试预算。
 *
 * 缺陷形状：旧实现每次 sync 都执行 pending.attempts + 1，而 pendingRetryTimer 是去重的——
 * 同一个 400ms 等待期内，宿主的 sessions 广播 / 面板 MutationObserver / 2.5 秒轮询可以触发
 * 任意多次同步，于是预算在**真实 timer 一轮都还没跑**的情况下被耗尽，第 5 次同步就
 * clearPending + restore，重启恢复窗口因此提前闪回宿主比例。
 *
 * 契约：attempts 只由**实际执行到的 pending retry timer** 消耗。外部同步只能
 * 「保持 pending + 用 applyRatio 修复目标/等分值或让位外部非等分值 + 保证最多一个 timer」。
 */
test("install 分栏配比：暂不可读期间高频外部同步不得消耗重试预算，也不得提前交还宿主", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitRatioPendingDom();
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");

        // 进入 pending：一个待执行重试，且此后**不推进**任何 fake 400ms timer。
        const restoreHost = detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(retryTimers.size(), 1, "暂不可读时必须安排恰好一次重试");

        // 高频外部同步：远超重试预算的次数，但一轮 timer 都没跑。
        for (let index = 0; index < 20; index += 1) {
          fixture.sessions.notify();
          observer.fire();
        }
        assert.equal(retryTimers.size(), 1, "高频外部同步绝不得堆积或取消重试 timer");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
          "高频外部同步不得提前交还宿主默认值（预算只能由实际 timer 轮次消耗）");

        // 窗口内宿主重渲染回等分：外部同步必须修复回目标，而不是把预算烧完后 restore。
        splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT, "important");
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
          "暂不可读期间外部同步同样要把宿主等分修复回目标");

        // 窗口内外部非等分值：外部同步必须让位，且不产生任何写入。
        splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_EXTERNAL);
        const externalWrites = splitStyleWrites(splitDom);
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_EXTERNAL,
          "暂不可读期间外部同步必须让位外部非等分值");
        assert.equal(splitStyleWrites(splitDom), externalWrites, "让位时外部同步不得产生任何写入");

        // 预算按**实际 timer 轮数**推进：预算内连续推进 MAX-1 轮后仍在观察、仍是目标配比。
        splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_HOST_DEFAULT, "important");
        const withinBudgetRounds = retryTimers.drain(SPLIT_PENDING_MAX_ATTEMPTS - 1);
        assert.equal(withinBudgetRounds, SPLIT_PENDING_MAX_ATTEMPTS - 1,
          "预算内应当按实际 timer 轮数逐轮推进（前面的高频同步不得预先扣减预算）");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET,
          "预算内的每一轮 timer 都必须保持/修复目标配比");
        assert.equal(retryTimers.size(), 1, "预算未耗尽时必须继续观察，绝不提前交还宿主");

        // 恢复 active host：最后一轮 timer 读到 target，立即收敛并清空 pending。
        restoreHost();
        retryTimers.drain(1);
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "读面恢复后仍是目标配比");
        assert.equal(retryTimers.size(), 0, "读面恢复后必须清空 pending，绝不再重排");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：暂不可读 pending 期间外部非等分轨道必须让位，绝不覆盖", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitRatioPendingDom();
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");

        const restoreHost = detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "暂不可读期间保持目标配比");
        assert.equal(retryTimers.size(), 1, "暂不可读时必须安排一次重试");

        // 外部在暂不可读窗口里写下两端不等的第三值：插件必须让位并保留它。
        splitDom.split.style.setProperty("grid-template-columns", SPLIT_COLUMNS_EXTERNAL);
        const externalWrites = splitStyleWrites(splitDom);

        // 一轮 timer：不得产生任何写入。
        retryTimers.drain(1);
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_EXTERNAL,
          "暂不可读期间外部非等分轨道必须被保留");
        assert.equal(splitStyleWrites(splitDom), externalWrites, "让位时 timer 不得产生任何写入");

        // 外部同步通知（宿主广播 / observer / 轮询）同样不得覆盖。
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_EXTERNAL,
          "暂不可读期间外部同步通知同样不得覆盖外部值");
        assert.equal(splitStyleWrites(splitDom), externalWrites, "让位时同步通知不得产生任何写入");

        // 预算耗尽后也不得把外部值盖回宿主原值（只还原「仍是插件写入状态」的属性）。
        retryTimers.drain();
        assert.equal(retryTimers.size(), 0, "重试链必须有界，绝不允许无限重排定时器");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_EXTERNAL,
          "预算耗尽也不得覆盖外部写入");
        assert.equal(splitStyleWrites(splitDom), externalWrites, "交还时不得覆盖外部写入");
        restoreHost();
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：暂不可读的 pending 在 dispose / 卸载后必须取消重试并交还宿主", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      { column: 0, tabIds: ["dsh-expert-group1"] },
      { column: 1, tabIds: ["subagent-tab"] },
      { column: 1, hidden: true },
    ],
  });
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "基线：两列明确时写目标配比");

        // 进入 pending：保持目标配比并留下一个待执行重试。
        const restoreHost = detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "暂不可读期间保持目标配比");
        assert.equal(retryTimers.size(), 1, "暂不可读时必须留下一个待执行重试");

        // 切到别的会话：容器身份不再属于本 surface，必须取消待执行重试并交还宿主原值。
        sessionsSnapshot.current = "root-b";
        fixture.sessions.notify();
        assert.equal(retryTimers.size(), 0, "session 切换必须取消待执行的重试定时器");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "session 切换必须交还宿主原值");

        // 切回本会话：读面恢复后由**外部同步通知**（fixture.sessions.notify，等价于宿主广播 /
        // observer / 2.5 秒轮询）重新接管——这条路径与「重启恢复」用例里那条「只推进 timer、
        // 不调用 notify」的路径互补，两条都必须能收敛并清空 pending。
        restoreHost();
        sessionsSnapshot.current = "root-a";
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_TARGET, "回到本会话后重新接管配比");
        assert.equal(retryTimers.size(), 0, "外部同步通知恢复读面后同样必须清空 pending，不得残留重排");
        detachColumnActiveHost(splitDom);
        fixture.sessions.notify();
        assert.equal(retryTimers.size(), 1, "重新进入暂不可读时必须重新安排重试");

        // dispose：取消待执行重试、还原宿主原值，且此后的迟到同步不得再写入或重排。
        fixture.dispose();
        assert.equal(retryTimers.size(), 0, "dispose 必须取消待执行的重试定时器");
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT, "dispose 必须还原宿主原值");
        const writesAfterDispose = splitStyleWrites(splitDom);
        fixture.sessions.notify();
        observer.fire();
        assert.equal(retryTimers.size(), 0, "dispose 后的迟到同步不得重新安排重试");
        assert.equal(splitStyleWrites(splitDom), writesAfterDispose, "dispose 后的迟到同步不得再次写入");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

test("install 分栏配比：首次接管时列 1 内容读不出来仍然 fail-closed，绝不凭空列或缺失 inventory 猜测归属", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    columnPriorities: { "grid-template-columns": "important" },
    cells: [
      { column: 0, tabIds: ["dsh-expert-group1"] },
      { column: 1, tabIds: ["subagent-tab"] },
      { column: 1, hidden: true },
    ],
  });
  // 首帧就是「列 1 内容读不出来」：插件从未写过目标配比，因此没有任何需要保持的样式。
  detachColumnActiveHost(splitDom);
  const restoreGlobals = installGlobals({ document: splitDom.document, window: { innerWidth: 1600 } });
  try {
    await withSplitRetryTimers(async (retryTimers) => withFakeObserver(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: layoutFixture(splitDom.sink.events) },
        ctxServices: { sidebarRight: splitRatioSidebarRight(inventory) },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT,
          "首次接管时列 1 读不出来必须 fail-closed，绝不猜测页面归属");
        assert.equal(retryTimers.size(), 0, "从未写过目标配比时不得进入 pending 重试");

        // 即便 inventory 整轮读不出来（列 1 的 tab 完全无法归属），也仍然不许写。
        inventory.splice(0, inventory.length, { sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" });
        fixture.sessions.notify();
        assert.equal(splitDom.split.inline.get("grid-template-columns"), SPLIT_COLUMNS_HOST_DEFAULT,
          "缺失 inventory 归属时同样 fail-closed");
        assert.equal(retryTimers.size(), 0, "缺失 inventory 归属不得进入 pending 重试");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    }));
  } finally {
    restoreGlobals();
  }
});

/*
 * ======================== 窗口最大化后的右栏宽度重算 ========================
 *
 * 症状：用户把窗口最大化 / 全屏（或拖拽窗口边缘）之后，Expert Group 页的右栏仍停在最大化
 * 之前那份**旧像素宽度**上，比例不再成立（1600 视口写 320，最大化到 3200 后仍是 320，而
 * 正确值是 640）。
 *
 * 根因：右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主
 * layout store 的是像素值；插件只在「会话激活 / 页面切换」这些边沿写入，常驻同步路径
 * （面板 observer、2.5 秒轮询）看到宽度已经 active/prepared 就直接 return，也不消费视口变化；
 * install 期更没有注册任何 resize 监听。于是视口一变，那份像素值就永久过期。
 *
 * 契约（本组用例守住的行为）：
 * - 真实 resize 事件后，20% 与 50% 两种模式都按**新视口**重新换算并写入宿主；
 * - 即使 resize 事件丢失（旧宿主没有 addEventListener），既有 observer / 轮询同步路径
 *   同样必须发现视口变化并补写；
 * - 同一视口下的重复 resize 事件与重复通知仍然**不重复写入**（保留原有去重语义）；
 * - resize 监听在 install 注册、dispose 移除，卸载后绝不再写。
 */

/**
 * 可跨 await 存活的 MutationObserver 替身（返回可手动派发变更的 observer 句柄）。
 *
 * 为什么不用 withFakeObserver：它的 finally 会在异步测试体的**第一个 await** 处就恢复真实
 * MutationObserver，而本用例必须在「面板真正挂载」那一刻就替换掉它（renderInstallPanel 是异步的，
 * 面板的观察器在挂载 effect 里创建）。用 withFakeObserver 时观察器实例数为 0，面板根本不会创建
 * 观察器，observer 同步路径就没有被真正走到。这里把替身装到用例结束，才能验证「resize 事件丢失
 * 时既有 observer 路径仍会按新视口补写」。
 */
function withLiveFakeObserver(run) {
  const instances = [];
  class LiveFakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      instances.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const restore = installGlobals({ MutationObserver: LiveFakeMutationObserver });
  const observer = {
    instances,
    /** 手动派发一批 mutation records（等价于浏览器把变更批次派发给所有仍连着的观察器）。 */
    fire(records) {
      const batch = Array.isArray(records) ? records : [];
      for (const instance of instances) {
        if (instance.disconnected !== true) instance.callback(batch);
      }
    },
  };
  return Promise.resolve().then(() => run(observer)).finally(restore);
}

/**
 * 「宿主真的把宽度渲染出来」的 layout 替身：setRightbar(px) 既记事件、也把 [data-sidebar-right-panel]
 * 的**实际渲染宽度**改成 px（真实宿主的形状：store 更新 → 面板按新宽度渲染）。
 *
 * 为什么需要它：插件判断「宿主里那份右栏宽度是否仍是自己写的」只读面板的实际渲染宽度
 * （readRightbarPanelWidth → getBoundingClientRect）。splitDocumentStub 的 panel 默认固定 360px，
 * 那不是任何一次写入的结果——用它会把「宿主还没渲染」误当成「宿主夺回了宽度」。真实宿主一定
 * 会把插件写入的值渲染出来，因此这里用同一个 setRightbar 驱动面板宽度，夹具才与真实时序一致。
 */
function hostRenderedLayoutFixture(events, panel) {
  const host = { width: null };
  panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: host.width, height: 800 });
  return {
    host,
    layout: {
      panels: {
        setRightbar(px) {
          events.push("width:" + px);
          host.width = px;
        },
      },
    },
  };
}

/**
 * 可调整尺寸的视口替身：除 innerWidth 外还提供 resize 监听面（真实浏览器 window 的最小形状）。
 * 用例通过 resize(next) 派发一次真实 resize 事件，等价于用户最大化 / 全屏 / 拖拽窗口边缘。
 *
 * removeApi=false 复现**只有 add、没有 remove** 的旧宿主 window：那种宿主上任何一次注册都
 * 再也摘不掉（dispose 时无法注销），因此插件必须整条放弃注册，改走 observer / 轮询兜底。
 */
function resizableViewportStub(width, { removeApi = true } = {}) {
  const listeners = new Map();
  const windowStub = {
    innerWidth: width,
    addEventListener(type, listener) {
      if (typeof listener !== "function") return;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
  };
  if (removeApi) {
    windowStub.removeEventListener = (type, listener) => { listeners.get(type)?.delete(listener); };
  }
  return {
    window: windowStub,
    /** 当前注册的 resize 监听器数量（dispose 后必须归零）。 */
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    /** 改宽度并派发一次 resize 事件（真实浏览器里这两件事同时发生）。 */
    resize(next) {
      windowStub.innerWidth = next;
      for (const listener of [...(listeners.get("resize") ?? [])]) listener({ type: "resize" });
    },
  };
}

test("install 契约：窗口最大化后 Expert Group 20% 与其它分页 50% 都按新视口重新换算写入", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  // 只有 Expert Group 页：20% 预置不会被「跨 pane 已存在其它页」的判定挡掉。
  const inventory = [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group" }];
  const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
  const viewport = resizableViewportStub(1600);
  const events = [];
  // 宿主 layout 替身会把写入的宽度真的渲染到面板上（面板实际宽度 = 宿主里那份值）。
  const { layout } = hostRenderedLayoutFixture(events, splitDom.panel);
  const state = { activeTab: { id: "tab-expert", kind: "expert-group" } };
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => state.activeTab,
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：1600 × 20% = 320，并且 install 已经注册 resize 监听。
        assert.deepEqual(events, ["width:320"], "1600 视口下 Expert Group 页写入 20%");
        assert.equal(viewport.listenerCount("resize"), 1, "install 必须注册 resize 监听");

        // 2) 真实 resize 事件（窗口最大化到 3200）：必须按新视口重新换算 20%。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:320", "width:640"], "最大化后必须按新视口重新换算 20%");

        // 3) 同一视口下重复派发 resize 事件：不得重复写入宿主。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:320", "width:640"], "同一视口的重复 resize 事件不得重复写入");

        // 4) resize 事件丢失（旧宿主没有 addEventListener）：observer 同步路径必须补写。
        viewport.window.innerWidth = 4800;
        observer.fire();
        assert.deepEqual(events, ["width:320", "width:640", "width:960"],
          "没有 resize 事件时 observer 同步路径必须按新视口补写 20%");

        // 5) 轮询同步路径同理（2.5 秒轮询与 observer 共用同一条同步链路）。
        viewport.window.innerWidth = 6400;
        await fixture.intervals.tick();
        assert.deepEqual(events, ["width:320", "width:640", "width:960", "width:1280"],
          "轮询同步路径必须按新视口补写 20%");

        // 6) 切到其它右侧分页：50% 模式按当前视口换算（6400 × 50% = 3200）。
        state.activeTab = { id: "tab-session", kind: "session" };
        fixture.sessions.notify();
        assert.deepEqual(events.slice(-1), ["width:3200"], "其它分页活跃时按当前视口写入 50%");

        // 7) 其它分页下同样必须消费视口变化（8000 × 50% = 4000）。
        viewport.resize(8000);
        assert.deepEqual(events.slice(-1), ["width:4000"], "最大化后其它分页的 50% 同样必须按新视口重算");

        // 8) 同一视口下的重复通知不得重写（用户在可调分页拖出的宽度不能被覆盖）。
        fixture.sessions.notify();
        assert.equal(events.filter((event) => event === "width:4000").length, 1, "同一视口重复通知不得重复写入");

        // 9) dispose 必须移除 resize 监听，此后的 resize 事件绝不再写宿主宽度。
        fixture.dispose();
        assert.equal(viewport.listenerCount("resize"), 0, "dispose 必须移除 resize 监听");
        const writesAfterDispose = events.length;
        viewport.resize(16000);
        assert.equal(events.length, writesAfterDispose, "dispose 后的 resize 事件不得再写入宽度");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ================== DSH 重启后宿主恢复旧 px 的宽度自愈 ==================
 *
 * 症状（用户实测）：全屏（视口 3200）下 Expert Group 右栏本来是视口的 20%（640px），DSH 重启后
 * 同一视口下右栏却缩到 320px（视口 10%），必须手动切一次分页才会回到 640。
 *
 * 根因：右栏宽度是**视口比例**，但写进宿主 layout store 的是像素值。DSH 重启后宿主会从持久化
 * 布局恢复它自己那份旧 px（重启前 1600 视口写下的 320），而且这份恢复**晚于** DEG 首次写入
 * 640：插件按 20% 写完 640 之后，宿主又把 store 里的 rightbar 改回 320 并重渲染面板。此时
 * 「视口是否变化」这条唯一的重新写入判据是 false（视口一直 3200），插件的 per-session 记账又
 * 已经认为「这个视口写过 640」，于是常驻同步路径（面板 observer / 2.5 秒轮询 / 宿主广播）全部
 * 跳过写入，那份被宿主改回 320 的宽度就永久留在屏幕上。
 *
 * 契约（本用例守住的行为）：
 * - Expert Group 页已确认（手柄被插件锁住、20% 是插件独占比例，用户在该页拖不动）时，
 *   **面板实际渲染宽度不再等于插件上次写入的 target** 就是「宿主已经夺回那份值」的可验证证据，
 *   正常同步必须把 20% 重新写回去；
 * - 写入收敛后（面板宽度回到 target）不得再重复写：既有「同一视口不重复写」的去重语义不变；
 * - 其它右栏分页的 50% 可调语义完全不变：只有面板宽度仍等于插件 target 时才按视口重算，
 *   用户拖出的宽度读不到/对不上就绝不覆盖；
 * - dispose 之后不再写。
 *
 * 为什么不违反「不能把旧 px 持久化为 DEG 自身偏好」：修复只**重写 20% 目标值**，既不读取也不
 * 保存宿主那份旧 px，旧值只被当作「宿主已经夺回所有权」的一次性证据。
 */

test("install 契约：DSH 重启后宿主恢复旧 px 时，Expert Group 20% 在正常同步里自愈回目标宽度", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  // 只有 Expert Group 页：组成证据是 confirmed（expert-only），20% 是插件独占比例。
  const inventory = [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group" }];
  const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
  const viewport = resizableViewportStub(3200);
  const events = [];
  // 「宿主里那份右栏宽度现在到底是多少」的公开证据：面板实际渲染宽度。
  let panelWidth = 640;
  splitDom.panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: panelWidth, height: 800 });
  // 宿主 layout 替身：setRightbar 会把 store 里的值渲染到面板上（真实宿主的形状），
  // 用例可随后用 setHostRestoredWidth 模拟「宿主恢复持久化的旧 px」。
  const layout = {
    panels: {
      setRightbar(px) {
        events.push("width:" + px);
        panelWidth = px;
      },
    },
  };
  const state = { activeTab: { id: "tab-expert", kind: "expert-group" } };
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => state.activeTab,
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：3200 × 20% = 640，与宿主当前那份值一致 → 恰好一次写入。
        assert.deepEqual(events, ["width:640"], "全屏视口下 Expert Group 页写入 20%（3200 × 20% = 640）");

        // 2) DSH 重启后的真实时序：宿主在 DEG 首次写入之后恢复它持久化的旧 px（1600 视口写下的
        //    320），视口本身没有变。宿主重渲染面板 → 面板实际宽度变成 320。
        panelWidth = 320;
        assert.equal(panelWidth, 320, "夹具必须真的模拟出宿主恢复旧 px");

        // 3) 一次正常同步（面板 observer 路径）就必须把 20% 自愈回目标宽度。
        observer.fire();
        assert.equal(
          events.at(-1),
          "width:640",
          "宿主恢复旧 px 后，正常同步必须把 Expert Group 的 20% 重新写回目标宽度（640）",
        );
        assert.equal(events.filter((event) => event === "width:640").length, 2, "自愈只允许补写一次");

        // 4) 写入收敛（面板宽度已回到 target）后不得再重复写：去重语义不变、也没有重排定时器。
        const settled = events.length;
        observer.fire();
        fixture.sessions.notify();
        await fixture.intervals.tick();
        assert.equal(events.length, settled, "收敛后重复同步必须是零写入（不得反复重写同一个值）");

        // 5) 其它右栏分页的 50% 可调语义不变：先进入 other 模式（3200 × 50% = 1600）。
        state.activeTab = { id: "tab-session", kind: "session" };
        fixture.sessions.notify();
        assert.deepEqual(events.slice(-1), ["width:1600"], "其它分页活跃时按当前视口写入 50%");
        // 用户在可调分页拖出 900：面板宽度不再等于插件 target → 所有权无法证明。
        panelWidth = 900;
        viewport.window.innerWidth = 4800;
        observer.fire();
        assert.equal(events.at(-1), "width:1600", "用户已拖走宽度时，视口变化绝不用 50% 覆盖用户的值");
        assert.equal(panelWidth, 900, "用户拖出的宽度必须原样保留");

        // 6) dispose 后不再写：宿主再恢复一次旧 px 也不得被插件改写。
        fixture.dispose();
        panelWidth = 320;
        const writesAfterDispose = events.length;
        viewport.resize(6400);
        observer.fire();
        fixture.sessions.notify();
        await fixture.intervals.tick();
        assert.equal(events.length, writesAfterDispose, "dispose 后不得再写入宽度");
        assert.equal(panelWidth, 320, "dispose 后宿主那份值不再被插件改写");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ================== 组成读面不可用时的同一自愈（unknown 分支） ==================
 *
 * 与上一条用例同源：DSH 重启后宿主可能**晚于**插件首次写入才恢复它持久化的旧 px。区别只在于
 * 重启窗口里 sidebarRight.openTabs inventory 也可能读不出来（readSurfaceOpenTabs 返回 null），
 * 此时组成证据是 unknown，走的是 recomputeOwnedWidth 而不是 confirmed 分支。
 *
 * 该函数消费的是本会话**自己**已经接管过的宽度记账（mode / prepared / active），与组成读面无关：
 * expert 模式下 20% 是插件独占比例，因此「宿主夺回那份 px」这条边沿在这里同样成立。
 * 本用例守住它与 confirmed 分支口径一致，并且 dispose 后不再写。
 */
test("install 契约：组成证据 unknown 时，宿主恢复旧 px 同样在正常同步里自愈回 20% 目标宽度", async () => {
  const fixture = unknownCompositionFixture({
    // DOM 只看到 Expert Group 页；inventory 与 active() 都读不出来 → 组成证据 unknown。
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => { throw new Error("inventory unavailable"); },
  });
  const { viewport, events } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：1600 × 20% = 320。宿主此刻还没有把宽度渲染出来（面板宽度读不到）。
        assert.deepEqual(events, ["width:320"], "1600 视口下 Expert Group 页写入 20%");
        // 宿主按写入值渲染面板：所有权证据成立。
        fixture.setPanelWidth(320);
        observer.fire();
        assert.deepEqual(events, ["width:320"], "面板宽度等于 target 时不得重复写入");

        // 2) 宿主恢复它持久化的旧 px（视口没变）：unknown 分支同样必须自愈回 20%。
        fixture.setPanelWidth(200);
        observer.fire();
        assert.equal(events.at(-1), "width:320", "unknown 证据下宿主夺回宽度同样必须自愈回 20%");
        assert.equal(events.filter((event) => event === "width:320").length, 2, "自愈只允许补写一次");

        // 3) 收敛后零写入。
        fixture.setPanelWidth(320);
        const settled = events.length;
        observer.fire();
        await panel.intervals.tick();
        assert.equal(events.length, settled, "收敛后重复同步必须是零写入");

        // 4) dispose 后不得再写。
        panel.dispose();
        const writesAfterDispose = events.length;
        fixture.setPanelWidth(120);
        viewport.resize(3200);
        observer.fire();
        await panel.intervals.tick();
        assert.equal(events.length, writesAfterDispose, "dispose 后不得再写入宽度");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ==================== 只有 add、没有 remove 的旧宿主 window ====================
 *
 * 兼容缺口：install 期的 resize 注册只检查了 addEventListener 是否存在，dispose 却用
 * removeEventListener 的可选调用（`?.()`）来注销。宿主 window 若只有 add 而没有 remove
 * （老 WebView / 精简替身 / 被冻结的事件面），注册会成功、注销会静默失败，于是那次 install
 * 的闭包被永久留在宿主 window 上：插件卸载后 resize 事件仍会触发它，而它内部读到的
 * disposed 标志虽能拦住写入，监听本身却再也摘不掉（每装一次泄漏一个）。
 *
 * 契约（本用例守住的行为）：
 * - add 与 remove 不都是函数时**完全不注册**（宁可少一条快路径，也绝不留下摘不掉的监听）；
 * - 少掉 resize 快路径后，视口变化仍必须由既有 observer 与 2.5 秒轮询按新视口补写；
 * - dispose 在这种宿主上不得抛错，且监听计数始终为 0。
 *
 * 对照面：上面那条用例守住标准 window（add + remove 都有）的即时 resize 与 dispose 注销，
 * 两条合起来才是完整的兼容契约。
 */
test("install 契约：window 只有 addEventListener 没有 removeEventListener 时绝不注册 resize 监听，改由 observer/轮询按新视口补写", async () => {
  const sessionsSnapshot = splitRatioSessionsSnapshot();
  // 只有 Expert Group 页：20% 预置不会被「跨 pane 已存在其它页」的判定挡掉。
  const inventory = [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group" }];
  const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
  // removeApi=false：宿主 window 只有 addEventListener，注册即永久驻留。
  const viewport = resizableViewportStub(1600, { removeApi: false });
  const events = [];
  // 宿主 layout 替身会把写入的宽度真的渲染到面板上（面板实际宽度 = 宿主里那份值）。
  const { layout } = hostRenderedLayoutFixture(events, splitDom.panel);
  const state = { activeTab: { id: "tab-expert", kind: "expert-group" } };
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => state.activeTab,
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot,
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：1600 × 20% = 320；关键断言是**一个监听都没注册**。
        assert.deepEqual(events, ["width:320"], "1600 视口下 Expert Group 页写入 20%");
        assert.equal(viewport.listenerCount("resize"), 0,
          "宿主只有 addEventListener 时不得注册 resize 监听（否则 dispose 摘不掉、每次安装泄漏一个闭包）");

        // 2) 视口变了，但 resize 事件面在这种宿主上不可用：派发本身不得写宽度。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:320"], "没有可用 resize 事件面时，派发事件本身不得写宽度");

        // 3) observer 同步路径必须发现视口变化并按新视口补写 20%（3200 × 20% = 640）。
        observer.fire();
        assert.deepEqual(events, ["width:320", "width:640"],
          "缺 resize 监听时 observer 同步路径必须按新视口补写 20%");

        // 4) 2.5 秒轮询同理（与 observer 共用同一条同步链路，6400 × 20% = 1280）。
        viewport.window.innerWidth = 6400;
        await fixture.intervals.tick();
        assert.deepEqual(events, ["width:320", "width:640", "width:1280"],
          "缺 resize 监听时轮询同步路径必须按新视口补写 20%");

        // 5) 其它右侧分页的 50% 同样靠 observer 兜底（6400 × 50% = 3200）。
        state.activeTab = { id: "tab-session", kind: "session" };
        fixture.sessions.notify();
        assert.deepEqual(events.slice(-1), ["width:3200"], "其它分页活跃时按当前视口写入 50%");
        viewport.window.innerWidth = 8000;
        observer.fire();
        assert.deepEqual(events.slice(-1), ["width:4000"], "缺 resize 监听时其它分页的 50% 同样必须按新视口重算");

        // 6) dispose 在这种宿主上不得抛错，且绝不能因为缺 removeEventListener 留下任何监听。
        fixture.dispose();
        assert.equal(viewport.listenerCount("resize"), 0, "dispose 后 resize 监听计数必须仍为 0");
        const writesAfterDispose = events.length;
        viewport.resize(16000);
        viewport.window.innerWidth = 16000;
        observer.fire();
        assert.equal(events.length, writesAfterDispose, "dispose 后 observer 路径不得再写入宽度");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ================== 组合读面不可用（unknown）时的视口重算 ==================
 *
 * 症状：openTabs inventory 读不出来（旧宿主 / 读面抛错）而右栏 DOM 仍可读时，安装期
 * （视口 1600）能按 20% 写入 320，但窗口最大化到 3200 之后一个字节都不再写：宿主继续沿用
 * 最大化之前那份 px 偏好，比例不再成立（正确值是 640）。
 *
 * 根因：rightbarDragSyncImpl 在 evidence === "unknown" 时于**当前宽度逻辑之前**直接 return。
 * 组成读面不可用时确实无法判定「现在该是 20% 还是 50%」，因此 fail-closed 本身是对的；
 * 但「视口变了要按原比例重算」消费的是本会话**已经接管过**的宽度模式（mode / prepared /
 * active），那几份记账与组成读面无关，在 unknown 分支里同样成立。
 *
 * 契约（本组用例守住的行为）：
 * - unknown 时绝不臆测模式：没有 mode/prepared/active 证据就一个字节都不写（用例 3）；
 * - 有已接管的模式时，视口变化必须按同一比例重算（expert → 20%，other → 50%，用例 1/2）；
 * - **other 模式还要证明宿主宽度所有权**：50% 是可调状态，用户在其它右侧分页上拖出的宽度由
 *   宿主持有，只有当前 panel 的实际渲染宽度仍等于插件上次写入的 target 时才允许重算（用例 4）；
 * - 同一视口下的重复 resize 事件与重复同步通知仍然不重复写入；
 * - unknown 分支绝不改手柄锁：证据不可用时手柄保持宿主原样（fail-closed 语义不变）；
 * - dispose 后不再写。
 */

/**
 * 「组合读面不可用」场景的安装替身（本组三个用例共用），形状与真实旧宿主一致：
 *
 * - inventory（openTabs.getSnapshot）由 state.inventory() 决定，用例可让它抛错——此时
 *   readSurfaceOpenTabs() 返回 null（「读不到」绝不等于「不存在」）；
 * - 右栏 DOM 始终可读（splitDocumentStub 给出真实 DockKit 层级与带归属标记的 panel），
 *   因此 compositionReadFacesUnavailable() 为 false，插件不会走 active-only 的 fail-open 升级；
 * - active() 由 state.active() 决定，默认抛错——活跃 tab 证据是 unknown。
 *
 * 手柄替身（[data-side=rightbar]）挂在 body 上：unknown 分支必须完全不碰它，用例据此证明
 * 「读面不可用」没有被当成 confirmed。
 *
 * panel 宽度是可变的（setPanelWidth）：它是「宿主里那份右栏宽度现在到底是多少」的公开证据，
 * 也是插件判断「那份值是否仍是自己写的」的唯一依据。默认 null 表示读不到有限正数宽度
 * （getBoundingClientRect().width = null → Number(null) = 0），此时插件必须 fail-closed 不写。
 *
 * renderWidths=true：宿主把插件写入的值真的渲染到面板上（真实宿主的形状），面板宽度随写入收敛。
 * 「未知组成 + 视口变化仍按已接管的 20% 重算」那类用例需要它才能守住既有去重语义：所有权证据
 * 只有随写入收敛，收敛后的重复同步才是零写入；固定不动的面板宽度在真实宿主上并不存在。
 */
function unknownCompositionFixture({
  cells,
  inventory,
  active = () => { throw new Error("active unavailable"); },
  panelWidth = null,
  renderWidths = false,
}) {
  const splitDom = splitDocumentStub({ cells });
  const viewport = resizableViewportStub(1600);
  const events = [];
  const handleSink = { events: [] };
  const handle = Object.assign(fakeElement("div", { "data-side": "rightbar" }), elementStub(handleSink, "handle:"));
  splitDom.body.appendChild(handle);
  // 真实 panel 的宽度由布局决定：替身把它做成可变值，模拟「插件写入后的实际渲染宽度」与
  // 「用户随后手动拖出的宽度」两种状态。
  let currentPanelWidth = panelWidth;
  splitDom.panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: currentPanelWidth, height: 800 });
  // 读面本身由用例在运行中切换（模拟「读面中途不可用」这条真实时序）。
  const state = { inventory, active };
  const sidebarRight = {
    openTabs: { getSnapshot() { return state.inventory(); } },
    active: () => state.active(),
    openTab() {},
  };
  // 与 layoutFixture 同形状的宿主 layout 替身（renderWidths=false 时逐字节等价）。
  const layout = {
    panels: {
      setRightbar(px) {
        events.push("width:" + px);
        if (renderWidths) currentPanelWidth = px;
      },
    },
  };
  return {
    splitDom, viewport, events, handle, handleSink, state, sidebarRight, layout,
    /** 设置当前 panel 的实际渲染宽度（null = 读不到有限正数宽度）。 */
    setPanelWidth(next) { currentPanelWidth = next; },
  };
}

/** 用共用替身走一次真实 install + 渲染（沿用公开 seam，不访问任何私有状态）。 */
function renderUnknownComposition(fixture) {
  return renderInstallPanel({
    sessionsSnapshot: splitRatioSessionsSnapshot(),
    hostSnapshot: splitRatioHostSnapshot(),
    deps: { layout: fixture.layout },
    ctxServices: { sidebarRight: fixture.sidebarRight },
  });
}

test("install 契约：组合证据 unknown（inventory 抛错 + DOM 可读）时，视口变化仍按已接管的 20% 重算", async () => {
  const fixture = unknownCompositionFixture({
    // DOM 只看到 Expert Group 页（生成形态的 tabId），但 inventory 抛错 → 组成证据 unknown。
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => { throw new Error("inventory unavailable"); },
    // 安装期宿主把写入的 320 渲染到面板上，renderWidths 让后续写入继续收敛。
    // 这是「视口变化重算」的必要前提：恢复 / 视口重算入口只在**能读到面板实际宽度**时才写
    // （没有公开 DOM 证据就 fail-closed，见下面那组「读面不可用必须零写入」的用例）。
    panelWidth: 320,
    renderWidths: true,
  });
  const { viewport, events, handle, handleSink } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：1600 × 20% = 320（openTargets 的预置写入），并且手柄一点没碰。
        assert.deepEqual(events, ["width:320"], "1600 视口下 Expert Group 页写入 20%");
        assert.deepEqual(handleSink.events, [], "unknown 证据下绝不锁手柄（读面不可用 ≠ confirmed）");
        assert.equal(handle.inline.size, 0, "unknown 证据下不得写任何手柄内联样式");

        // 2) 真实 resize 事件（窗口最大化到 3200）：必须按已接管的 20% 重算 3200 × 20% = 640。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:320", "width:640"],
          "组合证据 unknown 时，视口变化仍必须按已接管的 20% 重算");

        // 3) 同一视口下重复派发 resize 事件：不得重复写入宿主。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:320", "width:640"], "同一视口的重复 resize 事件不得重复写入");

        // 4) 同一视口下的重复同步通知（observer 路径）：同样不得重复写入。
        observer.fire();
        assert.deepEqual(events, ["width:320", "width:640"], "同一视口的重复同步通知不得重复写入");

        // 5) 第二次视口变化仍然要重算：模式证据没有被上一轮消费掉（4800 × 20% = 960）。
        viewport.resize(4800);
        assert.deepEqual(events, ["width:320", "width:640", "width:960"],
          "第二次视口变化同样必须按已接管的 20% 重算");

        // 6) dispose 后不再写：resize 与 observer 两条路径都不得再碰宿主宽度。
        panel.dispose();
        const writesAfterDispose = events.length;
        viewport.resize(16000);
        viewport.window.innerWidth = 16000;
        observer.fire();
        assert.equal(events.length, writesAfterDispose, "dispose 后不得再写入宽度");
        assert.deepEqual(handleSink.events, [], "unknown 证据下全程不得锁手柄");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：组合证据 unknown 时，面板宽度仍是插件 target 的其它分页 50% 按新视口重算", async () => {
  const fixture = unknownCompositionFixture({
    // DOM 只有 Expert Group 页；「其它页」的正向证据先由 inventory 给出，随后读面变成不可用。
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => [{ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }],
    // 面板宽度仍是插件写下的 800（用户没有拖过）：所有权成立，视口变化必须重算。
    panelWidth: 800,
  });
  const { viewport, events, state } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 安装期：inventory 证明存在其它页 → 50%（1600 × 50% = 800）。
        assert.deepEqual(events, ["width:800"], "存在其它右侧分页时写入 50%");

        // 2) inventory 中途变成读不出来：组成证据退回 unknown；面板宽度仍是插件上次的 target，
        //    因此所有权成立，已接管的 other 模式仍必须按新视口重算（3200 × 50% = 1600）。
        state.inventory = () => { throw new Error("inventory unavailable"); };
        viewport.resize(3200);
        assert.deepEqual(events, ["width:800", "width:1600"],
          "面板宽度仍是插件 target 时，unknown 下其它分页的 50% 必须按新视口重算");
        // 重算写下的新 target 成为下一次所有权判据：面板宽度同步到 1600（真实宿主会立即渲染）。
        fixture.setPanelWidth(1600);

        // 3) 同一视口下的重复 resize 事件与重复通知都不得重复写入。
        viewport.resize(3200);
        observer.fire();
        assert.deepEqual(events, ["width:800", "width:1600"], "同一视口不得重复写入");

        // 4) dispose 后不再写。
        panel.dispose();
        const writesAfterDispose = events.length;
        viewport.resize(16000);
        viewport.window.innerWidth = 16000;
        observer.fire();
        assert.equal(events.length, writesAfterDispose, "dispose 后不得再写入宽度");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：组合证据 unknown 且用户已把其它分页拖窄时，视口变化绝不覆盖用户的宽度", async () => {
  const fixture = unknownCompositionFixture({
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => [{ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }],
    // 安装期插件写下 800，宿主面板也就渲染成 800（所有权成立）。
    panelWidth: 800,
  });
  const { viewport, events, state } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ["width:800"], "先确认 other 模式在 1600 视口写入 800");

        // 用户在该页手动把右栏拖窄到 640：宿主里那份宽度不再等于插件的 target。
        fixture.setPanelWidth(640);
        // inventory 同时变得读不出来 → 组成证据退回 unknown，插件只剩「模式是 other」这一条信息。
        state.inventory = () => { throw new Error("inventory unavailable"); };

        // 视口变化（最大化到 3200）绝不能用 50% 覆盖用户拖出的 640：所有权无法证明就不写。
        viewport.resize(3200);
        assert.deepEqual(events, ["width:800"], "用户拖出的宽度不得被 unknown 分支的 50% 重算覆盖");

        // 重复 resize 与 observer 通知同样不得写入（所有权不成立时任何同步路径都不写）。
        viewport.resize(3200);
        observer.fire();
        assert.deepEqual(events, ["width:800"], "所有权不成立时任何同步路径都不得写入宽度");

        // 正面对照：用户把宽度拖回插件的 target（800）后所有权重新成立，视口变化必须照常重算。
        // 这条断言证明上面不是「整条链路失效」，而是「严格按证据决定写不写」（4800 × 50% = 2400）。
        fixture.setPanelWidth(800);
        viewport.resize(4800);
        assert.deepEqual(events, ["width:800", "width:2400"],
          "所有权恢复后必须按 50% 重算新视口");

        // dispose 后不再写。
        panel.dispose();
        const writesAfterDispose = events.length;
        viewport.resize(16000);
        viewport.window.innerWidth = 16000;
        observer.fire();
        assert.equal(events.length, writesAfterDispose, "dispose 后不得再写入宽度");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：组合证据 unknown 且没有任何模式证据时，视口变化绝不臆测 20% 或 50%", async () => {
  const fixture = unknownCompositionFixture({
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => [{ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }],
  });
  const { viewport, events, state } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ["width:800"], "先确认已接管 other 模式（50%）");

        // 组成证据明确是「没有活跃 tab」：既有契约要求清掉本会话全部 transient 宽度记账
        // （mode / prepared / active），但**保留**视口记账——这正是下面那条 fail-closed 的前提。
        state.inventory = () => { throw new Error("inventory unavailable"); };
        state.active = () => ({ sessionId: "root-a", tabId: "tab-without-kind" });
        observer.fire();
        assert.deepEqual(events, ["width:800"], "missing 证据不猜测性写入 50%");

        // 活跃 tab 读面随后也不可用：组成证据是 unknown，且已经没有任何模式证据。
        state.active = () => { throw new Error("active unavailable"); };
        viewport.resize(3200);
        assert.deepEqual(events, ["width:800"],
          "没有任何模式证据时，unknown 分支绝不臆测 20% 或 50%");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ==================== 右栏宽度冷启动竞态（宿主视口缓存滞后） ====================
 *
 * 症状：宿主刚起来时自己那份 viewportWidth 缓存还是旧值（例如 1280），而 AppFrame 与浏览器视口
 * 已经是 2560。插件按 window.innerWidth 换算目标宽度（2560 × 50% = 1280）并调用
 * layout.panels.setRightbar(1280)，但宿主会拿自己那份滞后缓存做 clamp：
 * Math.max(300, Math.min(1280, 1280 × 0.7)) = 896。于是「插件以为写下了 1280，宿主实际只保存 896」，
 * 右栏比目标窄了一大截；而插件的去重记账记的是 1280/当前视口，后续同一视口的同步不会再写，
 * 这个偏差就一直留在宿主里——宿主视口缓存自己追上后也不会回头修正已经落库的宽度。
 *
 * 契约（本组用例守住的行为）：
 * - 宽度目标仍按 window.innerWidth 的比例换算（2560 × 50% = 1280），本次已读取的同一个视口宽度贯穿始终；
 * - 写入宽度前 best-effort 把宿主那份视口缓存同步为**能唯一、可靠读到的 AppFrame 宽度**，
 *   避免宿主以旧视口执行 70% clamp；
 * - 同步值必须是 AppFrame 宽度而不是 window.innerWidth：两者不等时写错等于污染宿主的权威阈值
 *   （宿主此后会接受它自己永远不会产生的宽度）；
 * - AppFrame 定位不到 / 归属有歧义 / 尺寸非法 / 可选同步 action 缺失或读、调用抛错时，一律**完全跳过**
 *   同步并照常调用 setRightbar，绝不猜测宿主尺寸，既有写入路径与去重语义一个字节都不变。
 *
 * 本组用例通过真实 install 入口、有状态宿主替身与真实 AppFrame DOM 读面，验证这条公开行为契约。
 */

/**
 * 有状态宿主 layout 替身：真实宿主的右栏宽度不是「写多少就是多少」。
 *
 * - 宿主自己缓存一份 viewportWidth；setRightbar(px) 按
 *   `Math.max(300, Math.min(px, viewportWidth * 0.7))` clamp 后保存**实际** rightbar；
 * - setViewportWidth(width) 只更新这份缓存，**不重算**已经保存的 rightbar（真实宿主的形状：
 *   视口信息到位时并不会回头修正一个已经落库的旧宽度）。
 *
 * 这正是冷启动竞态的形状：AppFrame 与浏览器视口已经是 2560，宿主缓存却还停在 1280。
 */
function statefulRightbarLayoutAdapter({ viewportWidth = 1280 } = {}) {
  let hostViewportWidth = viewportWidth;
  let rightbar = null;
  const requested = [];
  const saved = [];
  const calls = [];
  return {
    /** 插件请求写入的 px（尚未经过宿主 clamp）。 */
    requested,
    /** 宿主 action 的调用顺序，用来锁定视口同步必须先于宽度写入。 */
    calls,
    /** 宿主实际保存的 px（clamp 之后）——用户看到的右栏宽度就是这个。 */
    saved,
    /** 宿主当前保存的实际 rightbar（null = 还没写过）。 */
    get rightbar() { return rightbar; },
    /** 宿主自己缓存的视口宽度。 */
    get viewportWidth() { return hostViewportWidth; },
    /** 宿主刷新自己的视口缓存；按真实语义**不**重算已有 rightbar。 */
    setViewportWidth(next) { calls.push("viewport:" + next); hostViewportWidth = next; },
    layout: {
      panels: {
        /**
         * 宿主 layout store 的 bound action：只更新自己那份视口缓存，不重算已保存的 rightbar。
         * 与 setRightbar 挂在同一个 panels 上——插件的视口同步必须打在这个接收者上，
         * 且必须在 setRightbar 之前调用，否则 70% clamp 仍会读到冷启动旧值。
         */
        setViewportWidth(next) {
          calls.push("viewport:" + next);
          hostViewportWidth = next;
        },
        setRightbar(px) {
          calls.push("rightbar:" + px);
          requested.push(px);
          rightbar = Math.max(300, Math.min(px, hostViewportWidth * 0.7));
          saved.push(rightbar);
        },
      },
    },
  };
}

/**
 * 给分栏 DOM 替身补上「真实 AppFrame 读面」：`[data-shell-overlay]` 是 AppFrame 的直接子节点
 * （与真实 DSH DOM 一致），AppFrame 自己的 getBoundingClientRect().width 就是宿主 layout store
 * 里那份 viewportWidth 的来源。
 *
 * 宽度由参数给定，因此用例可以构造「AppFrame 宽度与 window.innerWidth 不一致」的宿主形态。
 * 返回 AppFrame 元素本身，便于断言它的读面值。
 */
function attachAppFrameStub(body, width) {
  const frame = fakeElement("div");
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width, height: 900 });
  const overlay = fakeElement("div", { "data-shell-overlay": "" });
  // fakeElement 不实现 parentElement：这里按宿主 DOM 语义补上（覆盖层是 frame 的直接子节点）。
  overlay.parentElement = frame;
  frame.appendChild(overlay);
  body.appendChild(frame);
  return frame;
}

test("install 契约：写入右栏宽度前先同步宿主视口，避免冷启动 clamp 使用旧值", async () => {
  // 宿主缓存视口 1280（冷启动旧值），AppFrame 与浏览器视口都是 2560：宽度目标 2560 × 50% = 1280。
  const host = statefulRightbarLayoutAdapter({ viewportWidth: 1280 });
  const viewport = resizableViewportStub(2560);
  // 双栏 inventory（Expert Group 页 + 子代理页）→ 组成证据 other → 目标比例 50%。
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }, { column: 1, tabIds: ["subagent-tab"] }],
  });
  // 真实 AppFrame 读面：宿主 layout store 里那份 viewportWidth 就来自它的宽度。
  const appFrame = attachAppFrameStub(splitDom.body, 2560);
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => ({ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }),
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    // 前提：install 之前宿主缓存视口还停在冷启动旧值 1280，而 AppFrame 读面已经是 2560。
    // 这两条必须读在 install 之前——宽度写入路径一进 install 就会把宿主缓存同步掉。
    assert.equal(host.viewportWidth, 1280, "前提：安装前宿主缓存视口仍是冷启动旧值 1280");
    assert.equal(appFrame.getBoundingClientRect().width, 2560, "前提：AppFrame 读面给出 2560");
    await withLiveFakeObserver(async (observer) => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再断言宽度序列。
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 宽度目标仍按 window.innerWidth 换算：2560 × 50% = 1280。
        assert.deepEqual(host.requested, [1280], "宽度目标仍按 window.innerWidth 换算（2560 × 50%）");

        // 2) AppFrame 视口同步必须先于首次宽度写入，且同步值就是 AppFrame 宽度。
        assert.deepEqual(host.calls.slice(0, 2), ["viewport:2560", "rightbar:1280"],
          "AppFrame 视口同步必须先于首次右栏宽度写入");
        assert.equal(host.viewportWidth, 2560, "宿主视口缓存必须已被同步为 AppFrame 宽度 2560");

        // 3) 宿主按同步后的视口做 70% clamp：min(1280, 2560 × 0.7 = 1792) = 1280，
        //    正是用户看到的右栏宽度；冷启动旧缓存下的 896 不再出现。
        assert.equal(host.saved[0], 1280, "宿主实际保存值必须与 2560 视口下的 50% 目标一致");
        assert.equal(host.rightbar, 1280, "宿主保存的右栏宽度必须是 1280，而不是被滞后视口夹成 896");

        // 4) 同一视口下的重复同步不得追加写入（既有去重语义不变）。
        observer.fire();
        assert.equal(host.saved.length, 1, "同一视口的重复同步不得重复写入");

        // 5) 宿主的视口缓存自己追上（2560）后也不会自愈：插件的记账认为「这个视口已经写过」，
        //    因此不会再写一次；初次同步时已保存正确宽度，这里只断言「没有追加写入」这个不变量。
        host.setViewportWidth(2560);
        observer.fire();
        assert.equal(host.saved.length, 1, "宿主视口缓存追上后插件不得追加写入");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/**
 * 冷启动竞态用例共用的安装过程：真实 install → 真实注册组件 → 真实渲染，返回宿主 layout 收到的
 * 实际调用序列。每次调用自带 installGlobals / withLiveFakeObserver 的恢复，调用方不需要额外清理。
 *
 * appFrameWidth = null 表示 DOM 里不放 AppFrame 读面；duplicateAppFrame = true 表示同时存在两个
 * 带覆盖层的 frame（归属有歧义）；panels 由场景给出，用来构造可选 action 的异常形状。
 *
 * domShape 用来搭「覆盖层读法与状态属性读法不一致」的宿主形态，默认按上面两个参数搭建：
 * - "ambiguous-overlay-with-collapsed"：两个 [data-shell-overlay]，其中一个**同时**带
 *   [data-rightbar-collapsed]（覆盖层多命中 + 唯一的状态属性候选）；
 * - "unique-overlay-with-ambiguous-state"：唯一覆盖层 + 两个 [data-rightbar-collapsed] 候选
 *   （状态属性多命中）。
 * 两种形态都必须是「完全跳过同步」：多命中或查询异常是**读面有歧义**，绝不能被另一条读法的
 * 唯一候选掩盖成一次猜测写入。
 */
async function renderColdStartWidthPanel({
  panels, appFrameWidth, duplicateAppFrame = false, windowWidth = 2560, domShape = "default",
}) {
  const events = [];
  const viewport = resizableViewportStub(windowWidth);
  // 双栏 inventory（Expert Group 页 + 子代理页）→ 组成证据 other → 目标比例 50%。
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }, { column: 1, tabIds: ["subagent-tab"] }],
  });
  if (appFrameWidth !== null && domShape === "ambiguous-overlay-with-collapsed") {
    // 现役 frame（宽度正确）之外再留一个旧 frame：两个覆盖层让覆盖层读法多命中，
    // 其中**后一个覆盖层自己**同时带 data-rightbar-collapsed，于是状态属性读法恰好命中一个候选。
    // 旧实现把「多命中」与「零命中」都当成 null，这个唯一候选就会把覆盖层的歧义掩盖掉，
    // 插件拿旧节点的矩形去同步宿主视口（矩形刻意给一个可辨认的过期值 640）。
    attachAppFrameStub(splitDom.body, appFrameWidth);
    const staleFrame = attachAppFrameStub(splitDom.body, appFrameWidth);
    const staleOverlay = staleFrame.children[0];
    staleOverlay.setAttribute("data-rightbar-collapsed", "");
    staleOverlay.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 900 });
  } else if (appFrameWidth !== null && domShape === "unique-overlay-with-ambiguous-state") {
    // 覆盖层唯一（这一路本来可用），但 AppFrame 状态属性有两个候选：任何一路读面有歧义都必须
    // 整体放弃同步，绝不能拿另一条读法的唯一候选把歧义「补」回来。
    attachAppFrameStub(splitDom.body, appFrameWidth);
    splitDom.body.appendChild(fakeElement("div", { "data-rightbar-collapsed": "" }));
    splitDom.body.appendChild(fakeElement("div", { "data-rightbar-collapsed": "" }));
  } else if (appFrameWidth !== null) {
    attachAppFrameStub(splitDom.body, appFrameWidth);
    // 第二个带覆盖层的 frame：覆盖层不再唯一，AppFrame 归属无法证明。
    if (duplicateAppFrame) attachAppFrameStub(splitDom.body, appFrameWidth);
  }
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => ({ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }),
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: { panels: panels(events) } },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再断言宽度调用序列。
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
  return events;
}

test("install 契约：视口同步写入的是 AppFrame 宽度而不是 window.innerWidth，宿主阈值不被污染", async () => {
  // 浏览器窗口 4000，但 AppFrame 实际只有 2000（页面缩放 / 外层留白 / 嵌入形态都会造成这种差异）：
  // 宽度目标按 window.innerWidth 换算，同步给宿主的阈值必须是 AppFrame 宽度——两者绝不能混用。
  const host = statefulRightbarLayoutAdapter({ viewportWidth: 1000 });
  const viewport = resizableViewportStub(4000);
  const inventory = splitRatioInventory();
  const splitDom = splitDocumentStub({
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }, { column: 1, tabIds: ["subagent-tab"] }],
  });
  attachAppFrameStub(splitDom.body, 2000);
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => ({ sessionId: "root-a", tabId: "subagent-tab", kind: "subagentchat" }),
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async () => {
      const fixture = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));

        // 1) 宽度目标仍按 window.innerWidth 换算：4000 × 50% = 2000。
        assert.deepEqual(host.requested, [2000], "宽度目标仍按 window.innerWidth 换算（4000 × 50%）");

        // 2) 同步给宿主的必须是 AppFrame 宽度 2000，而不是 window.innerWidth 4000：
        //    写错就是把宿主的权威阈值抬高到 4000，宿主此后会接受它自己永远不会产生的宽度。
        assert.deepEqual(host.calls.slice(0, 2), ["viewport:2000", "rightbar:2000"],
          "同步值必须是 AppFrame 宽度，而不是 window.innerWidth");
        assert.equal(host.viewportWidth, 2000, "宿主视口缓存必须等于 AppFrame 宽度 2000");

        // 3) 宿主按自己的阈值 clamp：min(2000, 2000 × 70% = 1400) = 1400。
        //    若插件误把 4000 写进宿主阈值，这里会得到 min(2000, 2800) = 2000——阈值被污染的证据。
        assert.equal(host.saved[0], 1400, "宿主阈值必须来自 AppFrame 宽度（2000 × 70%）");
        assert.equal(host.rightbar, 1400, "宿主保存值必须是 AppFrame 阈值下的结果");

        // 4) 窗口宽度没变时不会触发宽度重写：去重语义与 window.innerWidth 判据都保持不变。
        viewport.resize(4000);
        assert.equal(host.saved.length, 1, "window.innerWidth 没变时不得重写宽度");
      } finally {
        fixture.handle.unmount();
        fixture.dispose();
        fixture.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：读不到 AppFrame 或可选同步 action 异常时完全跳过同步，既有宽度写入路径不变", async () => {
  // 每个场景给出自己的 layout 替身与 AppFrame 读面形状；断言一律只看「插件实际调用了什么」。
  // 共同契约：跳过同步，但 setRightbar 仍按 window.innerWidth 的 50% 目标照常调用。
  // 会记录调用的 setViewportWidth：任何一次「猜测出来的同步」都会在事件序列里现形。
  const recordingSync = (events) => ({
    setViewportWidth(px) { events.push("viewport:" + px); },
    setRightbar(px) { events.push("rightbar:" + px); },
  });
  const scenarios = [
    {
      name: "DOM 里没有 AppFrame 读面",
      appFrameWidth: null,
      panels: recordingSync,
    },
    {
      name: "AppFrame 归属有歧义（两个覆盖层）",
      appFrameWidth: 2560,
      duplicateAppFrame: true,
      panels: recordingSync,
    },
    {
      // 覆盖层读法多命中（两个 [data-shell-overlay]），其中后一个覆盖层自己同时带
      // data-rightbar-collapsed：状态属性读法恰好命中一个候选。多命中绝不能被这个唯一候选
      // 掩盖成一次「旧节点宽度」的同步——否则宿主阈值会被旧 frame 污染（这里旧节点宽度是 640）。
      name: "覆盖层多命中时不得被唯一的状态属性候选掩盖（两个覆盖层，其一同时带 data-rightbar-collapsed）",
      appFrameWidth: 2560,
      domShape: "ambiguous-overlay-with-collapsed",
      panels: recordingSync,
    },
    {
      // 覆盖层唯一，但 AppFrame 状态属性有两个候选：任一路读面有歧义都必须整体放弃同步。
      name: "状态属性多命中时同样完全跳过同步（单覆盖层 + 两个 data-rightbar-collapsed）",
      appFrameWidth: 2560,
      domShape: "unique-overlay-with-ambiguous-state",
      panels: recordingSync,
    },
    {
      name: "AppFrame 尺寸非法（读不到有限正宽度）",
      appFrameWidth: 0,
      panels: recordingSync,
    },
    {
      name: "宿主没有可选 setViewportWidth",
      appFrameWidth: 2560,
      panels: (events) => ({ setRightbar(px) { events.push("rightbar:" + px); } }),
    },
    {
      name: "可选 setViewportWidth 读属性抛错",
      appFrameWidth: 2560,
      panels: (events) => ({
        get setViewportWidth() { throw new Error("未声明的服务属性"); },
        setRightbar(px) { events.push("rightbar:" + px); },
      }),
    },
    {
      name: "可选 setViewportWidth 调用抛错",
      appFrameWidth: 2560,
      panels: (events) => ({
        setViewportWidth() { throw new Error("layout store 已销毁"); },
        setRightbar(px) { events.push("rightbar:" + px); },
      }),
    },
    {
      name: "可选 setViewportWidth 调用抛错时同步值仍是 AppFrame 宽度",
      appFrameWidth: 2560,
      panels: (events) => ({
        setViewportWidth(px) { events.push("viewport:" + px); throw new Error("layout store 已销毁"); },
        setRightbar(px) { events.push("rightbar:" + px); },
      }),
      expected: ["viewport:2560", "rightbar:1280"],
    },
  ];

  for (const scenario of scenarios) {
    const events = await renderColdStartWidthPanel(scenario);
    assert.deepEqual(events, scenario.expected ?? ["rightbar:1280"], scenario.name);
  }
});


/*
 * ================== 恢复写入的 per-session 有界预算 ==================
 *
 * 症状（独立审查发现的阻塞风险）：宿主**持续** clamp 或 React 延迟提交时，面板的实际渲染宽度
 * 可能一直不等于插件 target（插件请求 640，宿主只渲染 320）。上一版修复把「面板宽度 != 插件 target」
 * 当成「宿主夺回了那份 px」的证据，并在**每一条**既有同步路径（面板 observer / 2.5 秒轮询 /
 * sessions 通知）上 force 重写 20%：只要宿主一直 clamp，每一次同步都会再写一次，形成无限重复
 * 写入（layout store 被同一个值反复改写 → 宿主反复重渲染，用户看到的是持续抖动）。
 *
 * 契约（本组用例守住的行为）：
 * - 用一份**小型 per-session 状态**跟踪同一个恢复事件（session、target、观测到的实际宽度）：
 *   同一个未收敛 mismatch **最多执行 2 次恢复写入**，达到上限后对完全相同的 mismatch 停止重写；
 * - 上限**不能**被正常轮询自行重置：重复 observer / 轮询 / sessions 通知都必须保持零写入；
 * - 宿主真的把 target 提交到面板（读回的宽度等于 target）时状态清除，此后的正常同步一个字节都不写；
 * - 宿主**再次**独立恢复旧 px 时是新的一次 mismatch 事件，插件必须重新自愈（上限按新事件重算）；
 * - dispose 后不得再写。
 *
 * 为什么上限是 2：一次恢复写入 + 一次重试足以覆盖「React 延迟一帧才提交」这类真实时序；再多就是
 * 与宿主 clamp 的无限拉锯，只会持续改写宿主的 layout store。
 */

/**
 * 「宿主持续 clamp」的右栏 layout 替身：插件请求写什么都被记下来，但宿主只把面板渲染到
 * clampWidth（真实宿主的形状：store 里的值被 clamp 成 min(px, 上限)）。
 *
 * panelWidth() 给出的是 [data-sidebar-right-panel] 的**实际渲染宽度**——插件判断「宿主里那份值
 * 是否仍是自己写的」的唯一公开证据（readRightbarPanelWidth → getBoundingClientRect）。
 */
function clampedRightbarLayoutAdapter(panel, { clampWidth, deferredRender = false }) {
  let renderedWidth = clampWidth;
  const events = [];
  panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: renderedWidth, height: 800 });
  return {
    events,
    /** 当前面板实际渲染宽度（宿主里那份值落到 DOM 上的结果）。 */
    panelWidth: () => renderedWidth,
    /** 宿主把 store 里那份值重新渲染到面板上（真实宿主每次提交都会做）。 */
    render(width) { renderedWidth = width; },
    /** 宿主独立恢复它持久化的旧 px（例如 DSH 重启后 layout store 被改写并重渲染）。 */
    hostRestoreOldWidth(width) { renderedWidth = width; },
    layout: {
      panels: {
        setRightbar(px) {
          events.push("width:" + px);
          // deferredRender=true：宿主**延迟提交**（React 下一帧才把新宽度渲染到面板上），
          // 此刻读回的面板宽度仍是旧值——正是「写入后依然不收敛」的真实形状。
          if (deferredRender !== true) renderedWidth = Math.min(px, clampWidth);
        },
      },
    },
  };
}

/**
 * 「宿主持续 clamp」场景的安装替身：Expert Group 页是唯一组成证据（confirmed → expert 模式，
 * 20% 是插件独占比例），视口 3200 下 20% 目标就是 640。
 */
function clampedExpertWidthFixture({ clampWidth, deferredRender = false, viewportWidth = 3200 }) {
  const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
  const viewport = resizableViewportStub(viewportWidth);
  const host = clampedRightbarLayoutAdapter(splitDom.panel, { clampWidth, deferredRender });
  const inventory = [{ sessionId: "root-a", tabId: "dsh-expert-group1", kind: "dsh-expert-group" }];
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory },
    active: () => ({ id: "tab-expert", kind: "expert-group" }),
    openTab() {},
  };
  return { splitDom, viewport, host, sidebarRight };
}

test("install 契约：宿主持续 clamp 时同一 mismatch 的恢复写入最多 2 次，正常轮询绝不无限重写", async () => {
  // 视口 3200 → 20% 目标 640；宿主持续把右栏 clamp/渲染成 320（永远不收敛）。
  const fixture = clampedExpertWidthFixture({ clampWidth: 320 });
  const { viewport, host, sidebarRight } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始计数。
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.panelWidth(), 320, "前提：宿主把 640 clamp 成 320，面板实际渲染宽度是 320");
        assert.ok(host.events.every((event) => event === "width:640"),
          "插件只会请求 20% 目标 640，实际：" + JSON.stringify(host.events));

        // 安装期（首次接管 + 初始同步轮）就必须已经到达上限：1 次首次接管写入 + 最多 2 次恢复写入。
        assert.equal(host.events.length, 3,
          "宿主持续 clamp 时，安装期就应把同一个未收敛 mismatch 写到上限（1 次接管 + 2 次恢复），实际：" + JSON.stringify(host.events));
        const bounded = host.events.length;

        // 连续触发三条既有同步路径（面板 observer / sessions 通知 / 2.5 秒轮询），每条触发多轮：
        // 同一个未收敛 mismatch 的预算已经用尽，因此必须全部是零写入。
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        observer.fire();
        await panel.intervals.tick();
        observer.fire();
        assert.equal(host.events.length, bounded,
          "恢复写入预算用尽后，正常轮询 / observer / sessions 通知都不得再改写宿主 layout，实际：" + JSON.stringify(host.events));

        // 上限绝不能被「再等一轮」自行重置：继续推进轮询与 observer 仍是零写入。
        await panel.intervals.tick();
        observer.fire();
        panel.sessions.notify();
        assert.equal(host.events.length, bounded, "预算用尽后继续轮询不得重置上限、也不得再写");
        assert.equal(host.panelWidth(), 320, "插件绝不为了自愈去伪造面板宽度");

        // dispose 后不得再写（宿主再次恢复旧 px 也不得被改写）。
        panel.dispose();
        host.hostRestoreOldWidth(200);
        const writesAfterDispose = host.events.length;
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, writesAfterDispose, "dispose 后不得再写入宽度");
        assert.equal(host.panelWidth(), 200, "dispose 后宿主那份值不再被插件改写");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：渲染延迟期间恢复写入同样有界，宿主提交后状态清除且再次恢复旧 px 仍能自愈", async () => {
  // deferredRender=true：宿主延迟提交，写入后面板读数**暂时仍是 320**——这正是「不收敛」的形状。
  const fixture = clampedExpertWidthFixture({ clampWidth: 320, deferredRender: true });
  const { viewport, host, sidebarRight } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.panelWidth(), 320, "前提：宿主还没提交，面板读数仍是 320");
        assert.ok(host.events.every((event) => event === "width:640"),
          "插件只会请求 20% 目标 640，实际：" + JSON.stringify(host.events));

        // 1) 渲染延迟期间连续同步：同一个未收敛 mismatch 的恢复写入必须不超过 2 次，因此
        //    「安装期 + 这几轮同步」的总写入封顶在 1 次首次接管 + 2 次恢复 = 3 次。
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        observer.fire();
        await panel.intervals.tick();
        observer.fire();
        assert.equal(host.events.length, 3,
          "渲染延迟期间同一个 mismatch 的恢复写入必须有界（1 次接管 + 2 次恢复），实际：" + JSON.stringify(host.events));

        // 2) 宿主最终把 640 提交到 DOM：观测到「实际宽度 == target」时必须清除恢复状态。
        host.render(640);
        assert.equal(host.panelWidth(), 640, "前提：宿主已提交 target");

        // 3) 收敛后不重复写：正常同步（observer / 轮询 / sessions 通知）必须是零写入。
        const settled = host.events.length;
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(host.events.length, settled, "收敛后重复同步必须是零写入");

        // 4) 宿主**再次**独立恢复旧 px（新的一次 mismatch 事件）：插件必须重新自愈回 640。
        host.hostRestoreOldWidth(320);
        observer.fire();
        assert.equal(host.events.at(-1), "width:640",
          "宿主再次恢复旧 px 时必须重新自愈回 20% 目标（新 mismatch 事件重新获得预算）");
        assert.equal(host.events.length, settled + 1, "重新自愈只允许补写一次");
        // 宿主这次立刻提交 target：状态清除。
        host.render(640);

        // 5) 再次收敛后不重复写。
        const settledAgain = host.events.length;
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(host.events.length, settledAgain, "第二次收敛后同样不得重复写入");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

test("install 契约：宿主持续 clamp 时 dispose 后不再写，也不留下恢复记账", async () => {
  const fixture = clampedExpertWidthFixture({ clampWidth: 320 });
  const { viewport, host, sidebarRight } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        // 先消耗一部分恢复预算，确保 dispose 发生在「记账非空」的状态上。
        observer.fire();
        const writesBeforeDispose = host.events.length;
        assert.ok(writesBeforeDispose >= 2, "前提：宿主 clamp 时同步路径至少触发过恢复写入，实际：" + writesBeforeDispose);

        panel.dispose();
        host.hostRestoreOldWidth(160);
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, writesBeforeDispose, "dispose 后 observer / 轮询都不得再写入宽度");
        assert.equal(host.panelWidth(), 160, "dispose 后宿主那份值不再被插件改写");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});
/*
 * ============== 同一 target/actual 的视口变化不得绕过恢复预算 ==============
 *
 * 症状（审查发现）：宿主持续 clamp（请求 640、实际只渲染 320）时，同一个未收敛 mismatch 的恢复
 * 写入本来有界；但「视口变化」曾被当成**独立边沿**、不消费预算，于是只要视口挪一两个像素而
 * Math.round(viewport * 0.2) 取整后仍是同一个 target（3200 → 3201 → 3202 都还是 640），
 * 就能一次次绕过预算继续 force 写入——用户看到的是插件与宿主 clamp 的无限拉锯。
 *
 * 契约（本用例守住的行为）：
 * - 首轮接管写入 1 次之后，**同一个 (预期 target, 观测到的实际宽度)** 的恢复重写总数不得超过 2 次；
 *   视口变化只要取整后仍是同一个 target，就不是新的 mismatch 事件，后续普通通知与这些视口变化
 *   都不得继续写；
 * - 视口真正增长到 target 改变时，新目标是一次**新的** mismatch 事件，重新获得有限预算
 *   （同样最多 2 次恢复写入）；
 * - 宿主把 target 提交到 DOM（收敛）后恢复状态解除，之后新的宿主夺回宽度仍能自愈；
 * - 全程只断言公开读面（宿主 layout 收到的调用序列与面板实际渲染宽度），不触碰任何私有 map。
 */
test("install 契约：宿主持续 clamp 时，取整后仍是同一 target 的视口变化不得绕过恢复预算", async () => {
  // 视口 3200 → 20% 目标 640；宿主持续把右栏 clamp/渲染成 320（永远不收敛）。
  const fixture = clampedExpertWidthFixture({ clampWidth: 320 });
  const { viewport, host, sidebarRight } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.panelWidth(), 320, "前提：宿主把 640 clamp 成 320，面板实际渲染宽度是 320");
        assert.ok(host.events.every((event) => event === "width:640"),
          "插件只会请求 20% 目标 640，实际：" + JSON.stringify(host.events));
        // 安装期（首次接管 + 初始同步轮）已经把同一个 mismatch 的预算写到上限。
        assert.equal(host.events.length, 3,
          "前提：安装期就应到达上限（1 次接管 + 2 次恢复），实际：" + JSON.stringify(host.events));
        const bounded = host.events.length;

        // 1) 连续把视口改到**取整后仍是同一个 target=640** 的宽度（3201 / 3202 / 3199），每次再触发
        //    全部正常同步路径（面板 observer / sessions 通知 / 2.5 秒轮询）。这些视口变化不构成新的
        //    mismatch 事件（预期 target 与观测到的实际宽度都没变），绝不能再获得预算。
        for (const width of [3201, 3202, 3199]) {
          viewport.resize(width);
          observer.fire();
          panel.sessions.notify();
          await panel.intervals.tick();
        }
        assert.equal(host.events.length, bounded,
          "取整后仍是同一 target 的视口变化不得绕过恢复预算继续写，实际：" + JSON.stringify(host.events));
        assert.equal(host.panelWidth(), 320, "插件绝不为了自愈去伪造面板宽度");

        // 2) 视口真正增长到 target 改变（4000 × 20% = 800）：新目标是一次**新的** mismatch 事件，
        //    重新获得有限预算。
        viewport.resize(4000);
        assert.equal(host.events.at(-1), "width:800", "target 真正改变时必须按新视口重写");
        const afterTargetChange = host.events.length;
        assert.equal(afterTargetChange, bounded + 1, "新 target 的事件只允许立即写一次");
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(host.events.length, afterTargetChange + 1,
          "新 mismatch 事件同样只有 2 次恢复写入（一次立即 + 一次重试），实际：" + JSON.stringify(host.events));
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, afterTargetChange + 1,
          "新 mismatch 事件的预算用尽后同样不得再写，实际：" + JSON.stringify(host.events));

        // 3) 宿主终于把 target 提交到 DOM（收敛）：恢复记账解除，此后普通同步零写入。
        host.render(800);
        observer.fire();
        const settled = host.events.length;
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(host.events.length, settled, "DOM 收敛后重复同步必须是零写入");

        // 4) 宿主再次独立恢复旧 px（新的一次 mismatch 事件）：状态已解除，必须重新自愈回 800。
        host.hostRestoreOldWidth(320);
        observer.fire();
        assert.equal(host.events.at(-1), "width:800", "收敛后宿主再次夺回宽度必须重新自愈");
        assert.equal(host.events.length, settled + 1, "重新自愈只允许补写一次");

        // 5) dispose 后不得再写。
        panel.dispose();
        host.hostRestoreOldWidth(160);
        const writesAfterDispose = host.events.length;
        viewport.resize(6400);
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, writesAfterDispose, "dispose 后不得再写入宽度");
        assert.equal(host.panelWidth(), 160, "dispose 后宿主那份值不再被插件改写");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * 同源缺口：组成读面整体不可用（DSH 重启窗口里 inventory 与 active 都读不出来）时，宽度重写走的是
 * recomputeOwnedWidth 这条 unknown 分支。它必须与 confirmed 分支**共用同一份预算判定**，否则
 * 「取整后仍是同一 target 的视口变化」在重启窗口里照样能无限重写。
 *
 * 夹具沿用既有公开替身：clampedRightbarLayoutAdapter（宿主持续 clamp 到 320）+ resizableViewportStub
 * + splitDocumentStub，只把 sidebarRight 的两个组合读面做成「读不出来」。
 */
test("install 契约：组合证据 unknown 时，取整后仍是同一 target 的视口变化同样不得绕过恢复预算", async () => {
  const splitDom = splitDocumentStub({ cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }] });
  const viewport = resizableViewportStub(3200);
  const host = clampedRightbarLayoutAdapter(splitDom.panel, { clampWidth: 320 });
  // 两个组合读面都读不出来（DSH 重启窗口的真实形状）→ 组成证据 unknown → recomputeOwnedWidth。
  const readFaces = {
    inventory: () => { throw new Error("inventory unavailable"); },
    active: () => { throw new Error("active unavailable"); },
  };
  const sidebarRight = {
    openTabs: { getSnapshot: () => readFaces.inventory() },
    active: () => readFaces.active(),
    openTab() {},
  };
  const restoreGlobals = installGlobals({ document: splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(host.panelWidth(), 320, "前提：宿主把 640 clamp 成 320，面板实际渲染宽度是 320");
        assert.ok(host.events.every((event) => event === "width:640"),
          "插件只会请求 20% 目标 640，实际：" + JSON.stringify(host.events));
        assert.equal(host.events.length, 3,
          "前提：unknown 分支下安装期同样把同一 mismatch 写到上限（1 次接管 + 2 次恢复），实际："
          + JSON.stringify(host.events));
        const bounded = host.events.length;

        // 视口变化但取整后仍是 target=640：不是新的一次 mismatch 事件，不得重新获得预算。
        for (const width of [3201, 3202, 3199]) {
          viewport.resize(width);
          observer.fire();
          panel.sessions.notify();
          await panel.intervals.tick();
        }
        assert.equal(host.events.length, bounded,
          "unknown 分支同样不得因取整后仍是同一 target 的视口变化绕过预算，实际：" + JSON.stringify(host.events));

        // 视口真正增长到 target 改变（4000 × 20% = 800）：新目标是一次新事件，重新获得有限预算。
        viewport.resize(4000);
        assert.equal(host.events.at(-1), "width:800", "unknown 分支下 target 真正改变时必须按新视口重写");
        const afterTargetChange = host.events.length;
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(host.events.length, afterTargetChange + 1,
          "unknown 分支的新 mismatch 事件同样只有 2 次恢复写入，实际：" + JSON.stringify(host.events));
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, afterTargetChange + 1,
          "unknown 分支新事件的预算用尽后不得再写，实际：" + JSON.stringify(host.events));

        // dispose 后不得再写。
        panel.dispose();
        host.hostRestoreOldWidth(160);
        const writesAfterDispose = host.events.length;
        viewport.resize(6400);
        observer.fire();
        await panel.intervals.tick();
        assert.equal(host.events.length, writesAfterDispose, "dispose 后不得再写入宽度");
        assert.equal(host.panelWidth(), 160, "dispose 后宿主那份值不再被插件改写");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * ============== 没有公开 DOM 证据时的恢复写入必须 fail-closed ==============
 *
 * 症状（审查发现的阻塞问题）：recoverRightbarWidth 在 ownership === null（面板宽度读不出来 /
 * 面板归属无法精确解析）时仍直接 applyRightbarWidth(..., true) 强写一次。宽度读面不可用期间，
 * 每一次视口变化 / observer / sessions 通知 / 2.5 秒轮询都会绕过有界预算反复 force 写入宿主
 * layout store——用户轻微拖动窗口边缘就能触发一串**没有证据**的写入。
 *
 * 契约（本组用例守住的行为）：
 * - 没有公开 DOM 证据（面板定位不到，或 getBoundingClientRect().width 不是有限正数）时，
 *   恢复 / 视口重算入口**一个字节都不写**，也绝不新建或重置恢复预算；
 * - 该收紧只作用于恢复 / 视口重算入口：首次接管、从其它分页返回、分栏事务收口等正常写入语义不变；
 * - 面板宽度重新可读且明确偏离 target 后，自愈照旧，并且仍受「同一个未收敛 mismatch 最多 2 次」
 *   的有界预算约束；
 * - dispose 后不再写。
 *
 * 为什么必须 fail-closed：右栏宽度是宿主 layout store 里的一份**全局**偏好，插件只在能证明
 * 「这份 px 现在是谁的」时才允许改写它。读面不可用期间没有任何证据说明面板宽度偏离了 target，
 * 写下去就是无据改写宿主状态，而且是无界的。
 */

test("install 契约：confirmed Expert Group 的恢复路径在面板宽度读不出来时 fail-closed，绝不复写", async () => {
  // 宿主把写入值原样渲染（面板实际宽度 == 插件 target），因此安装期不会消费恢复预算。
  const fixture = clampedExpertWidthFixture({ clampWidth: 640 });
  const { viewport, host, sidebarRight } = fixture;
  const panel = fixture.splitDom.panel;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const rendered = await renderInstallPanel({
        sessionsSnapshot: splitRatioSessionsSnapshot(),
        hostSnapshot: splitRatioHostSnapshot(),
        deps: { layout: host.layout },
        ctxServices: { sidebarRight },
      });
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始计数。
        await new Promise((resolve) => setImmediate(resolve));
        // 前提：3200 视口 → 20% target 640，宿主如实渲染 640，所有权证据成立。
        assert.deepEqual(host.events, ["width:640"], "前提：安装期只写一次 20% 目标（640）");
        assert.equal(host.panelWidth(), 640, "前提：面板实际渲染宽度等于插件 target");
        const baseline = host.events.length;

        // 宽度 DOM 读面不可用：getBoundingClientRect().width 返回 null（非法值）。
        panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: null, height: 800 });

        // 连续触发四条既有同步路径，且每次视口都变化（取整后仍是同一个 target=640）。
        for (const width of [3201, 3202, 3199]) {
          viewport.resize(width);
          observer.fire();
          rendered.sessions.notify();
          await rendered.intervals.tick();
        }
        assert.equal(host.events.length, baseline,
          "没有公开 DOM 证据时恢复 / 视口重算路径必须零写入，实际：" + JSON.stringify(host.events));
        assert.equal(host.panelWidth(), 640, "插件绝不为了自愈去伪造面板宽度");

        // 面板宽度重新可读，并且明确偏离 target（640 → 320）：自愈照旧，但仍有界。
        panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: 320, height: 800 });
        observer.fire();
        assert.equal(host.events.at(-1), "width:640", "面板宽度重新可读且明确偏离 target 后必须自愈");
        assert.equal(host.events.length, baseline + 1, "自愈先写一次，实际：" + JSON.stringify(host.events));
        observer.fire();
        rendered.sessions.notify();
        await rendered.intervals.tick();
        assert.equal(host.events.length, baseline + 2,
          "同一个未收敛 mismatch 只允许 2 次恢复写入，实际：" + JSON.stringify(host.events));
        observer.fire();
        await rendered.intervals.tick();
        assert.equal(host.events.length, baseline + 2, "预算用尽后不得再写");

        // 收敛（宿主把 target 提交到面板）后恢复记账解除：普通同步零写入。
        panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: 640, height: 800 });
        observer.fire();
        const settled = host.events.length;
        observer.fire();
        rendered.sessions.notify();
        await rendered.intervals.tick();
        assert.equal(host.events.length, settled, "收敛后重复同步必须是零写入");

        // dispose 后不得再写（面板再次不可读也一样）。
        rendered.dispose();
        panel.getBoundingClientRect = () => ({ left: 100, top: 20, width: null, height: 800 });
        viewport.resize(6400);
        observer.fire();
        rendered.sessions.notify();
        await rendered.intervals.tick();
        assert.equal(host.events.length, settled, "dispose 后不得再写入宽度");
      } finally {
        rendered.handle.unmount();
        rendered.dispose();
        rendered.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

/*
 * 同源缺口（unknown 分支）：组成读面整体不可用（DSH 重启窗口里 inventory 与 active 都读不出来）时，
 * 宽度重算走的是 recomputeOwnedWidth。它同样必须与 confirmed 分支**共用**同一条 fail-closed 口径：
 * 面板宽度读不出来就一个字节都不写，而不是「按兼容语义强写一次」。
 *
 * 本用例刻意让本会话**已经**有可靠的 Expert ownership 记账（安装期按 20% 写过 320、prepared 已置位），
 * 证明「有模式证据」绝不等于「可以没有 DOM 证据地写」。
 */
test("install 契约：组合证据 unknown 且面板宽度读不出来时同样 fail-closed，恢复预算不被绕过", async () => {
  const fixture = unknownCompositionFixture({
    // DOM 只看到 Expert Group 页；inventory 与 active() 都读不出来 → 组成证据 unknown。
    cells: [{ column: 0, tabIds: ["dsh-expert-group1"] }],
    inventory: () => { throw new Error("inventory unavailable"); },
    // 安装期宿主把写入的 320 如实渲染到面板上：所有权证据成立，恢复预算未被消费。
    panelWidth: 320,
  });
  const { viewport, events } = fixture;
  const restoreGlobals = installGlobals({ document: fixture.splitDom.document, window: viewport.window });
  try {
    await withLiveFakeObserver(async (observer) => {
      const panel = await renderUnknownComposition(fixture);
      try {
        // 安装期的打开请求是 deferred 的：等它们落定后再开始计数。
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, ["width:320"], "前提：安装期按 1600 视口的 20% 写一次 320");
        const baseline = events.length;

        // 宽度读面不可用：width = null（Number(null) = 0，不是有限正数）。
        fixture.setPanelWidth(null);
        for (const width of [1601, 1602, 1599]) {
          viewport.resize(width);
          observer.fire();
          panel.sessions.notify();
          await panel.intervals.tick();
        }
        assert.deepEqual(events, ["width:320"],
          "unknown 分支同样必须 fail-closed（有模式证据 ≠ 可以没有 DOM 证据地写），实际：" + JSON.stringify(events));

        // 面板重新可读，并且是宿主恢复的旧 px（160，明确偏离 target 320）：按预算自愈。
        fixture.setPanelWidth(160);
        observer.fire();
        assert.equal(events.at(-1), "width:320", "面板重新可读为旧 px 后必须自愈回 20% 目标");
        assert.equal(events.length, baseline + 1, "自愈先写一次，实际：" + JSON.stringify(events));
        observer.fire();
        panel.sessions.notify();
        await panel.intervals.tick();
        assert.equal(events.length, baseline + 2,
          "同一个未收敛 mismatch 最多 2 次恢复写入，实际：" + JSON.stringify(events));
        observer.fire();
        await panel.intervals.tick();
        assert.equal(events.length, baseline + 2, "预算用尽后不得再写");

        // dispose 后不得再写（面板再次不可读也一样）。
        panel.dispose();
        fixture.setPanelWidth(null);
        viewport.resize(3200);
        observer.fire();
        await panel.intervals.tick();
        assert.equal(events.length, baseline + 2, "dispose 后不得再写入宽度");
      } finally {
        panel.handle.unmount();
        panel.dispose();
        panel.restoreGlobals();
      }
    });
  } finally {
    restoreGlobals();
  }
});

// ── Auto（自动打开运行中的子代理侧栏）契约 ──────────────────────────────────

/**
 * 可选的存在性 DOM 读面（presenceDom: true）。
 *
 * 真实宿主会把右栏 tab 渲染成 [data-dockkit-tab] 节点（面板带 data-sidebar-right-session 归属），
 * 插件的「记录里的 tabId 还在不在」就靠这一面确认。宿主把旧 tab 换成新 tabId 时，缺了这一面就
 * 永远观察不到替换：记录不会被判 stale，也就不会按新 tabId 重新收养——这条形状必须显式打开。
 *
 * 面板与 tab 节点都从**同一份宿主 inventory 现读**，因此宿主替换 tab 之后，插件看到的 DOM 与
 * 宿主真实渲染保持一致；面板归属标记也随当前 sidebar session 现读（只有当前 session 的面板能被
 * rightbarPanelForSessionCompat 认出来，绝不借用别的 session 的面板当证据）。
 */
function createSidebarPresenceDocument(scope, inventory, hiddenTabs = null) {
  const panel = {
    /** 精确归属标记：只有与当前 session 完全相等的面板才被认作这一页的右栏。 */
    getAttribute(name) {
      return name === "data-sidebar-right-session" ? scope.sidebarSessionId : null;
    },
    querySelectorAll(selector) {
      if (selector !== "[data-dockkit-tab]") return [];
      const nodes = [];
      for (const entry of inventory) {
        // 用例可显式让某个 tab 暂时不出现在渲染读面：真实右栏在折叠 pane / 布局提交中间态时
        // 也会这样。它只影响 DOM 在场集合，宿主 inventory 仍然完整。
        if (hiddenTabs !== null && hiddenTabs.has(entry?.tabId) === true) continue;
        if (String(entry?.sessionId ?? "") !== scope.sidebarSessionId) continue;
        if (entry?.tabId === undefined || entry?.tabId === null) continue;
        nodes.push({
          getAttribute: (attribute) => (attribute === "data-dockkit-tab" ? String(entry.tabId) : null),
        });
      }
      return nodes;
    },
  };
  return {
    hidden: false,
    querySelector(selector) {
      return selector === "[data-sidebar-right-panel]" ? panel : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-sidebar-right-panel]") return [panel];
      // 浮动 subagentchat 窗口：本夹具不制造浮窗，构造器读到的就是真实的「没有浮窗」证据。
      return [];
    },
  };
}

/**
 * Auto 契约夹具：真实 installExpertGroupSidebar → 宿主 registerTab → 真实渲染 → 真实轮询触发同步。
 *
 * 覆盖规格里全部可观察行为：
 * 1. 默认关闭；install 未注入读面（旧宿主/直接 createExpertGroupPanel）同样按关闭处理；
 * 2. 开启后只对当前快照里「运行中」的资源打开右侧栏资源，同一个资源绝不重复打开；
 * 3. 资源结束后只用**已确认记录里的真实 tabId** 关闭 Auto 自己打开的 tab；
 * 4. 手动来源（用户手动打开的空闲/完成会话）绝不被自动关闭，用户手动关闭的自动 tab 绝不被立刻重开；
 * 5. 来源与抑制按（sidebar session + rootSessionId + 资源地址）复合键记账。
 *
 * 夹具只经公开面驱动：宿主 openResource/close/openTabs/active、插件的公开注册面与渲染输出。
 */
/**
 * 直接执行 checked-in 的 client-bundle.js（隔离 realm），取回它装配出来的侧栏实现。
 *
 * 与 test-support 的 loadClientBundle({ source: "generated" }) 同一条装载路径；区别只在于这里必须把
 * **宿主当前的**定时器与 Date 传进 realm——关闭 watchdog / 验证窗口 / 冷却都读它们，用例才能用虚拟
 * 时钟精确推进，而绝不真实等待 10 秒或 60 秒。
 */
async function loadGeneratedSidebarModule() {
  const vm = await import("node:vm");
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(new URL("../client-bundle.js", import.meta.url), "utf8");
  const entries = [];
  const loader = { load(entry) { entries.push(entry); } };
  const sandbox = {
    console,
    window: { __ModuleLoader__: loader, innerWidth: 1000 },
    __ModuleLoader__: loader,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    MutationObserver: globalThis.MutationObserver,
  };
  // 生成 bundle 的函数留在 realm 里，运行期 document 仍属于宿主（与真实 classic script 一致）。
  Object.defineProperty(sandbox, "document", { configurable: true, get: () => globalThis.document });
  vm.createContext(sandbox);
  vm.runInContext(content, sandbox, { filename: "client-bundle.js" });
  // realm 内部的全局写入不会镜像到宿主侧的 sandbox 视图，因此从 realm 里读回同一份 Symbol 值
  // （Symbol.for 的全局注册表在同一个 isolate 内共享，读到的就是侧栏模块本身）。
  const sidebarModule = vm.runInContext(
    "globalThis[Symbol.for(\"dsh-expert-group/client-expert-group-sidebar\")]",
    sandbox,
  );
  assert.equal(typeof sidebarModule?.installExpertGroupSidebar, "function", "生成 bundle 必须暴露侧栏安装入口");
  return sidebarModule;
}

async function installAutoSidebarHarness(options = {}) {
  await import("../client-expert-group-model-normalize.js");
  await import("../client-expert-group-model-format.js");
  await import("../client-expert-group-model.js");
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  /**
   * 受控调度器队列。
   *
   * 这条自动路径上真正的用户可见副作用（split / openResource）发生在一个 await 之后：面板要等
   * 宿主把新宽度提交到布局（优先 rAF，250ms 短 fallback 兜底；split 事务本身还有 15s deadline）。
   * 只有接管这两类调度，用例才能把「Auto 正卡在等待里」这一段真实异步窗口停下来，在中间插入
   * 用户手动点击或「关闭 Auto」，再放行它继续跑。队列不参与断言，等待/超时由用例显式推进。
   */
  const rafQueue = [];
  /**
   * 虚拟时钟 + 可控定时器。
   *
   * 关闭 watchdog（10 秒）、验证窗口（10 秒）与失败冷却（60 秒起）都只能靠时间推进来观察，
   * 用例绝不允许真实等待：这里把 Date.now() 与 setTimeout/clearTimeout 都换成受控替身，
   * 由 advanceClock(ms) 显式推进——先加时间，再按到期顺序执行到期回调。
   */
  const clock = { now: 0 };
  const RealDate = Date;
  const fakeDate = new Proxy(RealDate, {
    get(target, property, receiver) {
      if (property === "now") return () => clock.now;
      return Reflect.get(target, property, receiver);
    },
  });
  const timeoutQueue = new Map();
  let timeoutSequence = 0;
  const restoreGlobals = installGlobals({
    window: { innerWidth: 1000 },
    Date: fakeDate,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
    setTimeout: (callback, delay) => {
      timeoutSequence += 1;
      const wait = Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 0;
      timeoutQueue.set(timeoutSequence, { callback, delay: wait, dueAt: clock.now + wait });
      return timeoutSequence;
    },
    clearTimeout: (id) => { timeoutQueue.delete(id); },
    requestAnimationFrame: (callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => {},
    // 可控 localStorage（持久归属标记 / 诊断环形日志共用）：只在用例显式提供时注入，其余逐字不变。
    ...(options.localStorage === undefined ? {} : { localStorage: options.localStorage }),
  });
  const rightChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-right" }, children: [] });
  const leftChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-left" }, children: [] });
  /**
   * 用例级「当前 root / 当前 sidebar session」。
   *
   * 真实 DSH 的 keyed session surface 既会在同一个 Panel 实例上换一组 props.scope 来切换会话，
   * 也会卸载旧实例、再用同一个已安装组件挂载新实例。夹具里所有替身（DEG 快照、sessions 目录、
   * 子代理地址解析、inventory 条目标记）都现读这两个值，因此 switchRoot() 改的就是面板真正看到
   * 的 surface，而 install 闭包（同一个 factory、同一份宿主 inventory）保持不变。
   */
  const activeScope = {
    sidebarSessionId: options.sidebarSessionId ?? "root-a",
    rootSessionId: options.rootSessionId ?? "root-a",
  };
  // 宿主右栏替身：openResource 同步提交 inventory + active tab（与真实宿主同一时序），close 移除它。
  const inventory = [];
  const resources = [];
  const closes = [];
  /** 全部 openResource 尝试（含 openFailures 抛错的那些），用来断言「宿主确实收到了请求」。 */
  const openAttempts = [];
  /**
   * **可选**开关 syncInventoryOnOpen：模拟真实宿主在 openResource() **内部**发布 inventory。
   *
   * 已按实现核实的宿主链路（@deepseek-ai/dsh-client-ui-sidebar-right + @deepseek-ai/dsh-client-store）：
   * openResource → place() → store.actions.openContent（defineStore 的 update）→ snapshot store 的
   * zustand setState（同步 forEach 订阅者）→ adopt() 注册的 sync() → inventory.update → publish →
   * openTabs（SnapshotStore）.set → 插件的 subscribe 回调。整条链路没有任何 await / 微任务，因此插件
   * 会在 openResource() **返回之前**被同步重入一次。本夹具默认保持历史形状（openTabs 只有 getSnapshot，
   * openResource 返回后才由插件自己的收尾同步推进），只有显式打开的用例才模拟同步语义：
   * - true：提交后立刻同步通知订阅者（重入发生在 openResource 内部）；
   * - "async"：提交后在微任务里通知订阅者（通知晚于 openResource 返回的另一种语义）；
   * - 缺省 / false：完全不通知（既有用例逐字不变）。
   */
  const syncInventoryOnOpen = options.syncInventoryOnOpen === true
    ? "sync"
    : (options.syncInventoryOnOpen === "async" ? "async" : "off");
  /** openTabs 的订阅者（只有打开 syncInventoryOnOpen 时才注册得到）。 */
  const inventoryListeners = new Set();
  const publishInventory = () => {
    if (syncInventoryOnOpen === "off") return;
    for (const listener of [...inventoryListeners]) listener();
  };
  /**
   * 按所选语义发布：同步语义在 openResource() 内部通知（复现宿主重入），异步语义排进微任务。
   * 两种语义都必须让插件最终记成 auto——实现绝不允许只对其中一种时序正确。
   */
  const publishInventoryOnOpen = () => {
    if (syncInventoryOnOpen === "sync") publishInventory();
    else if (syncInventoryOnOpen === "async") void Promise.resolve().then(() => publishInventory());
  };
  /**
   * 可选的存在性 DOM 读面：只有需要「宿主换了 tabId」形状的用例打开它（见
   * createSidebarPresenceDocument）。未打开时保持历史夹具形状：插件看不到 tab 节点，
   * 记录只由 inventory 收养/关闭结算驱动。
   */
  /** presenceDom 下暂时「不渲染」的 tabId（只影响 DOM 读面，inventory 保持完整）。 */
  const hiddenPresenceTabs = new Set();
  const restorePresenceDom = options.presenceDom === true
    ? installGlobals({ document: createSidebarPresenceDocument(activeScope, inventory, hiddenPresenceTabs) })
    : null;
  let activeTab;
  let sequence = 0;
  let splitCalls = 0;
  let remainingSplitFailures = Math.max(0, Number(options.splitFailures) || 0);
  let remainingOpenFailures = Math.max(0, Number(options.openFailures) || 0);
  const wantsSplit = options.split === true;
  const enabledOpenTabs = options.openTabs !== false;
  const enabledClose = options.close !== false;
  if (wantsSplit) {
    /**
     * 真实宿主的启动形状：Expert Group 页已经提交并且是 active tab。
     *
     * 公开 split() 只在「组成确认为仅 Expert Group」时放行，这条 seed 就是那个证据；没有它，
     * install 侧的分栏协调器会 fail-closed 返回 null，用例根本走不到布局等待那一段。
     */
    inventory.push({ sessionId: activeScope.sidebarSessionId, tabId: "tab-expert-group", kind: "expert-group", contentId: "expert-group" });
    activeTab = { id: "tab-expert-group", kind: "expert-group", contentId: "expert-group", title: "expert group" };
  }
  /**
   * inventory 读面调用计数 + 防挂死阀。
   *
   * 计数本身是「候选评估次数」的代理指标（每评估一个候选就会读一次 inventory）；上限则是用例的
   * 安全阀：候选评估如果失去上界（例如「失败 → 撤销预留 → 立刻重选」在微任务里自转），测试进程
   * 会永远挂住。到达上限后读面返回 null（inventory 不可读），fail-closed 的逻辑自然收敛，
   * 缺陷因此表现为断言失败，而不是让整个测试进程挂死。
   */
  let inventoryReadCount = 0;
  /** 读面故障开关：模拟旧宿主 / 读面抛错时 openTabs 不可读（null），绝不是「确认没有」。 */
  let inventoryUnreadable = options.inventoryUnreadable === true;
  // 用例可按需抬高防挂死阀（大量候选的容量用例）；默认仍是既有的 300。
  const INVENTORY_READ_CAP = Number(options.inventoryReadCap) > 0 ? Number(options.inventoryReadCap) : 300;
  const sidebarRight = {
    // openTabs: false 模拟旧宿主 / 读面缺失：inventory 不可读 ≠ 确认没有目标。
    openTabs: enabledOpenTabs ? {
      getSnapshot: () => {
        inventoryReadCount += 1;
        if (inventoryUnreadable === true) return null;
        return inventoryReadCount > INVENTORY_READ_CAP ? null : inventory.map((entry) => ({ ...entry }));
      },
      // 真实宿主把 inventory 发布成 snapshot store（插件订阅它做外部变更同步）：只有打开
      // syncInventoryOnOpen 的用例才暴露这个订阅面，其余用例逐字保持「只有 getSnapshot」的历史形状。
      ...(syncInventoryOnOpen === "off" ? {} : {
        subscribe(listener) {
          inventoryListeners.add(listener);
          return () => { inventoryListeners.delete(listener); };
        },
      }),
    } : undefined,
    /**
     * 宿主当前活跃 tab。
     *
     * 默认就是夹具自己维护的 activeTab（openResource 写入、关闭时清空）。个别用例需要显式构造
     * 「宿主把活跃 tab 切回 Expert Group 页」这一真实用户动作（它是右侧组成判定与 split 兼容性
     * 的唯一正向证据），因此允许用 options.activeTabOf 覆盖——只在传入时才启用，其余用例逐字不变。
     */
    active: () => (typeof options.activeTabOf === "function" ? options.activeTabOf(activeTab) : activeTab),
    openResource(address, resourceOptions) {
      openAttempts.push({ address, options: resourceOptions });
      if (remainingOpenFailures > 0) {
        remainingOpenFailures -= 1;
        throw new Error("宿主暂时无法打开该资源");
      }
      resources.push({ address, options: resourceOptions });
      /**
       * 宿主契约对齐（与 @deepseek-ai/dsh-client-ui-sidebar-right 的公开行为逐条同源）：
       * - openResource() **没有返回值**（void），调用方拿不到新 tab 的 tabId；
       * - 默认 revealIfOpened=true —— 同一个 (kind, contentId) 已经有 tab 时它**揭示那一个**，
       *   绝不新建第二个；只有显式 revealIfOpened:false 才允许重复。
       *
       * 这两条正是「缺陷 1」的成因：调用过 openResource + 随后 inventory 里有一个同地址 tab，
       * 并不构成「那个 tab 是我们创建的」的因果证据。夹具必须与宿主同形状，插件才能被正确地检验。
       */
      const revealIfOpened = resourceOptions?.revealIfOpened !== false;
      const existing = revealIfOpened
        ? inventory.find((entry) => entry.sessionId === activeScope.sidebarSessionId
          && entry.kind === "subagentchat" && entry.contentId === address)
        : undefined;
      // split() 留下的 seeded guide 必须在同一次导航里被替换掉（宿主公开的 replaceTab 选项）。
      const replaceTab = resourceOptions?.replaceTab;
      if (typeof replaceTab === "string") {
        const guideIndex = inventory.findIndex((entry) => entry.tabId === replaceTab);
        if (guideIndex >= 0) inventory.splice(guideIndex, 1);
      }
      if (existing !== undefined) {
        // 揭示已有 tab：不新建、不消耗 tabId 序列，只把它设为活跃 tab。
        activeTab = { id: existing.tabId, kind: "subagentchat", contentId: address, title: "子代理会话" };
        // 真实宿主的 openContent 动作在任何一次提交后都会发布一次 inventory（揭示也是一次提交）。
        publishInventoryOnOpen();
        return;
      }
      /**
       * openNoCommit：宿主接受了这次打开，但 tab 始终没有提交进 inventory（落不下来的形状）。
       * 用来观察「tabId=null 占位」的生命周期（TTL 回收 + 有界重试），不设时逐字保持既有行为。
       */
      if (options.openNoCommit === true) return;
      sequence += 1;
      const tabId = "tab-" + sequence;
      inventory.push({ sessionId: activeScope.sidebarSessionId, tabId, kind: "subagentchat", contentId: address });
      activeTab = { id: tabId, kind: "subagentchat", contentId: address, title: "子代理会话" };
      /**
       * 提交之后、**返回之前**按所选语义发布：sync 语义下这次通知就在 openResource() 内部同步送达
       * （复现宿主的同步重入），async 语义下排进微任务。close()/split() 不在这里发布——本开关只用来
       * 锁定「打开」这一条时序，绝不放宽既有用例对它们的形状假设。
       */
      publishInventoryOnOpen();
    },
    close(tabId) {
      closes.push(tabId);
      const applyClose = () => {
        const index = inventory.findIndex((entry) => entry.tabId === tabId);
        if (index >= 0) inventory.splice(index, 1);
        if (activeTab?.id === tabId) activeTab = undefined;
      };
      if (typeof options.closeTab === "function") return options.closeTab(tabId, applyClose);
      return applyClose();
    },
  };
  // close: false 模拟没有公开 close() 的旧宿主：此时自动打开的未来 tab 无法被精确回收。
  if (enabledClose !== true) delete sidebarRight.close;
  if (wantsSplit) {
    // 公开 split()：返回新 pane 的 PaneId，并按宿主默认行为放入一个 guide tab。
    // splitFailures 让前 N 次返回 undefined（宿主拒绝分栏），用来验证「准备失败必须可重试」。
    sidebarRight.split = function split() {
      splitCalls += 1;
      if (remainingSplitFailures > 0) {
        remainingSplitFailures -= 1;
        return undefined;
      }
      sequence += 1;
      inventory.push({ sessionId: activeScope.sidebarSessionId, tabId: "tab-guide-" + sequence, kind: "guide", contentId: "guide" });
      return "pane-" + splitCalls;
    };
  }
  /** 布局服务替身（只有分栏用例需要）：公开 split 事务会先写 50% 再等布局提交。 */
  const layoutWrites = [];
  const layoutStub = wantsSplit
    ? { panels: { setRightbar(px) { layoutWrites.push(px); } } }
    : undefined;
  // 快照节点可由用例就地改写状态（running → completed/ready），下一次刷新即得到新快照。
  const makeChildren = (list) => list.map((child) => ({
    id: child.id,
    kind: "expert",
    sessionId: child.id,
    taskName: child.taskName ?? ("子代理 " + child.id),
    role: "fixer",
    content: "任务 " + child.id,
    status: child.status ?? "running",
    continuable: true,
  }));
  /** 每个 root 自己的专家树：切换 root 后必须读目标 root 的树，绝不沿用上一个 root 的快照。 */
  const childrenByRoot = new Map();
  childrenByRoot.set(activeScope.rootSessionId, makeChildren(options.children ?? [{ id: "child-a", status: "running" }]));
  const childrenOf = (rootId) => childrenByRoot.get(rootId) ?? [];
  /**
   * childId → 拥有它的 root 的反查索引。
   *
   * 容量用例会在每个轮询周期里为上百个候选各解析一次地址（128 个资源的容量上限用例尤其明显），
   * 原来的「遍历 childrenByRoot + 逐个 some()」把它放大成 O(候选数 × 根数 × 子节点数)。
   * 索引与 childrenByRoot 的插入顺序逐字同源（先出现的 root 胜出），因此解析结果完全一致；
   * 只在 root 的专家树被换掉时（switchRoot / 初始装载）重建一次。
   */
  const childOwnerOf = new Map();
  const reindexChildOwners = () => {
    childOwnerOf.clear();
    for (const [rootId, list] of childrenByRoot) {
      for (const child of list) {
        if (childOwnerOf.has(child.sessionId)) continue;
        childOwnerOf.set(child.sessionId, rootId);
      }
    }
  };
  reindexChildOwners();
  /** 初始 root 的专家树（用例就地改状态时改的就是它，下一次刷新即得到新快照）。 */
  const children = childrenOf(activeScope.rootSessionId);
  /**
   * 指定 root 的 DEG 快照（默认当前 root）；children 每次都是新对象，与真实 Host 的投影一致。
   *
   * partial 由 options.partialSnapshot 控制（默认不写该字段 = 权威完整快照，既有用例逐字不变）：
   * 需要验证「轻量快照下 unknown 成员不被 manual 抑制清理放过」的用例把它设成 true，并把子节点
   * 的 status 置为 unknown（Host 的 evidenceFree 形状：没有 running 布尔）。
   */
  const hostSnapshotOf = (forRootSessionId = activeScope.rootSessionId) => ({
    schemaVersion: 1,
    rootSessionId: forRootSessionId,
    generatedAt: 1,
    ...(options.partialSnapshot === true ? { partial: true } : {}),
    root: {
      id: forRootSessionId,
      kind: "root",
      sessionId: forRootSessionId,
      taskName: forRootSessionId,
      children: childrenOf(forRootSessionId).map((child) => ({ ...child })),
    },
  });
  /** 当前 root 的 sessions 目录投影（每次现读：切换 root 后目录必须跟着换）。 */
  const sessionsSnapshotOf = () => ({
    current: activeScope.sidebarSessionId,
    byId: {
      [activeScope.rootSessionId]: { id: activeScope.rootSessionId, title: activeScope.rootSessionId },
      ...Object.fromEntries(childrenOf(activeScope.rootSessionId).map((child) => [child.sessionId, {
        id: child.sessionId,
        parentId: activeScope.rootSessionId,
        title: child.taskName + " 会话",
      }])),
    },
    projectionsBySession: {},
  });
  const sessions = {
    list: { getSnapshot: sessionsSnapshotOf },
    // 地址的 parent 必须来自**拥有这个 child 的 root**：切换 root 后旧 root 的 child 不再可解析。
    subagentAddress: (childId) => {
      const rootId = childOwnerOf.get(childId);
      if (rootId === undefined) return undefined;
      return { parentSessionId: rootId, childSessionId: childId, mode: "continuable" };
    },
  };
  const registered = [];
  const betterSidebar = {
    registerTab(descriptor) { registered.push(descriptor); return () => {}; },
    isTabEnabled: () => true,
    openTab() {},
  };
  const ctx = {
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "sidebarRight") return sidebarRight;
      if (name === "betterSidebar") return betterSidebar;
      if (name === "layout") return layoutStub;
      return undefined;
    },
    sessions,
  };
  const autoOpenState = { value: options.autoOpen === true };
  const deps = {
    react: runtime.react,
    primitives: { ...primitives, IconChevronRightOutlineRegular: rightChevron, IconChevronLeftOutlineRegular: leftChevron },
    sessions,
    resolveRootSessionId: (id) => id,
    /**
     * 真实 Host 按请求发起那一刻的 surface 返回快照：这里在发起时就固定 root，
     * 切换 root 之后迟到的响应不得冒充新 root 的专家树。
     */
    requestPluginRpc: () => {
      const requestedRootSessionId = activeScope.rootSessionId;
      return { ok: true, async json() { return { snapshot: hostSnapshotOf(requestedRootSessionId) }; } };
    },
  };
  // withAutoDep=false 模拟旧宿主 / 直接 createExpertGroupPanel：缺少新读面时必须按关闭处理。
  if (options.withAutoDep !== false) {
    deps.getAutoOpenSubagentSidebar = typeof options.getAutoOpen === "function"
      ? options.getAutoOpen
      : () => autoOpenState.value === true;
  }
  if (typeof options.setAutoOpen === "function") deps.setAutoOpenSubagentSidebar = options.setAutoOpen;
  // 生成 bundle 路径（见 T14）：装配期先加载 checked-in 的 client-bundle.js，再取它装配出的侧栏实现；
  // 默认仍是源模块，既有用例的装载路径逐字不变。
  /**
   * realm 级账本的用例隔离：每次新建夹具都先把「共享 Auto 账本」与「归属索引内存」两个槽位清掉
   * （等价于一次全新 realm），否则上一个用例的归属/预算会顺着 realm 槽位漏进下一个用例。
   * 需要观察「整页刷新」形状的用例自己调用 resetSidebarRealmLedger({ keepPersisted: true })。
   */
  resetSidebarRealmLedger({ keepPersisted: options.keepPersistedOwnership === true });
  const installedSidebar = options.sidebarModule
    ?? (options.sidebarModuleProvider !== undefined && options.sidebarModuleProvider !== null
      ? await options.sidebarModuleProvider.load()
      : (options.bundleSource === "generated" ? await loadGeneratedSidebarModule() : sidebar));
  let installedSidebarNext = installedSidebar;
  let dispose = installedSidebar.installExpertGroupSidebar(ctx, deps);
  let component = registered[0]?.component;
  assert.equal(typeof component, "function", "Better 页面组件必须已注册");
  // 面板实例可被 remount() 替换（真实宿主会卸载旧实例再挂新实例），因此用可变绑定 + 取值器。
  let handle = runtime.render(component, { scope: { sessionId: activeScope.sidebarSessionId }, ctx: {} });
  await handle.settle();
  const collect = (node, result = []) => {
    if (node === null || node === undefined || node === false) return result;
    result.push(node);
    if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
    return result;
  };
  const byClass = (node, className) => collect(node)
    .filter((item) => typeof item === "object" && String(item.props?.className ?? "").split(/\s+/).includes(className));
  const arrowOf = (label) => {
    const rows = byClass(handle.output, "deg_expert_group_row_main");
    const row = rows.find((candidate) => collect(candidate).some((item) => item === label));
    assert.ok(row, "必须渲染子代理行：" + label);
    const arrow = byClass(row, "deg_expert_group_sidebar_action")[0];
    assert.ok(arrow, "行尾箭头必须渲染：" + label);
    return arrow;
  };
  /** 当前渲染里的批量关闭按钮（主代理行与空闲分组标题行共用同一个类名；缺失返回 null）。 */
  const batchButtonOf = () => collect(handle.output)
    .find((node) => typeof node === "object"
      && String(node.props?.className ?? "").split(/\s+/).includes("deg_expert_group_sidebar_batch_action")) ?? null;
  return {
    get handle() { return handle; },
    intervals,
    inventory,
    resources,
    closes,
    openAttempts,
    layoutWrites,
    /** inventory 读面被读取的次数（候选评估次数的代理指标）。 */
    inventoryReads: () => inventoryReadCount,
    children,
    autoOpenState,
    /**
     * 放行一次「等宿主布局提交」的等待（受控 rAF），让停在 await 里的自动动作继续执行。
     *
     * 只放行调用那一刻已排队的帧：动作若在下一轮又排了一次布局等待（例如手动意图把它重新派发成
     * 一次手动打开），用例必须再调一次——异步边界因此始终由用例显式控制，绝不隐式连跑。
     */
    async flushLayout() {
      const frames = rafQueue.splice(0, rafQueue.length);
      for (const frame of frames) frame();
      await handle.settle();
    },
    /** 队列里还没有被放行的布局等待帧数量（用来断言动作确实停在 await 里）。 */
    layoutWaits: () => rafQueue.length,
    /**
     * 只放行**最后一次**排队的布局等待帧，把更早排队的那些留在队列里（留给随后的 flushLayout）。
     *
     * 真实宿主里两个 Panel 实例的等待可以在任意交错点结算：旧实例的视觉帧被后台节流 / 推迟、
     * 新实例的帧先到，是完全合法的时序。用例需要显式构造这种「新 Panel 的自动打开先完成、
     * 旧实例的等待后结算」的有害交错，因此这里提供比 flushLayout 更细的推进粒度。
     */
    async flushNewestLayoutFrame() {
      const frame = rafQueue.pop();
      if (typeof frame === "function") frame();
      await handle.settle();
    },
    /**
     * 宿主侧（用户在宿主 UI 里）已经提交了这个资源的 tab：不经过本插件的任何动作。
     * 用来构造「Auto 动作在途期间，用户已经手动打开同一个资源」的真实形状。
     */
    /** 让某个 tab 暂时不出现在 presenceDom 的渲染读面（inventory 不动）。 */
    hidePresenceTab(tabId) { hiddenPresenceTabs.add(tabId); },
    /** 恢复某个 tab 的渲染读面（与 hidePresenceTab 对称）。 */
    showPresenceTab(tabId) { hiddenPresenceTabs.delete(tabId); },
    hostOpenTab(address, forSidebarSessionId = activeScope.sidebarSessionId) {
      sequence += 1;
      const tabId = "tab-host-" + sequence;
      inventory.push({ sessionId: forSidebarSessionId, tabId, kind: "subagentchat", contentId: address });
      activeTab = { id: tabId, kind: "subagentchat", contentId: address, title: "子代理会话" };
      return tabId;
    },
    /**
     * 宿主把某个 tabId **回收复用**给了另一个资源的 tab（旧 tab 已经消失、id 被重新分配）。
     *
     * 只把那一条 inventory 记录的 contentId 换成新地址：active tab、本插件的 records 与 DOM 都不动，
     * 因此插件看到的正是真实宿主「同一个 id 此刻承载别的资源」的形状——这正是固定长度的迟到隔离窗
     * 挡不住、必须靠地址证据才能识别的场景。
     */
    recycleTabId(tabId, address) {
      const index = inventory.findIndex((entry) => entry.tabId === tabId);
      if (index < 0) return false;
      inventory[index] = { ...inventory[index], contentId: address };
      return true;
    },
    /**
     * 推进虚拟时钟：先加时间，再按到期顺序执行到期定时器，最后结算异步链路。
     *
     * 关闭 watchdog（10 秒）、验证窗口（10 秒）与失败冷却（60 秒起）都只读虚拟时间，用例因此可以
     * 精确跨过这些窗口，而绝不真实等待。
     */
    async advanceClock(ms) {
      clock.now += Math.max(0, Number(ms) || 0);
      const due = [...timeoutQueue.entries()]
        .filter(([, entry]) => entry.dueAt <= clock.now)
        .sort((left, right) => left[1].dueAt - right[1].dueAt);
      for (const [id, entry] of due) {
        timeoutQueue.delete(id);
        entry.callback();
      }
      await handle.settle();
    },
    /** 仍未到期的定时器数量（断言 watchdog 定时器被清理、绝不泄漏）。 */
    pendingTimers: () => timeoutQueue.size,
    /** 当前虚拟时间（毫秒）。 */
    now: () => clock.now,
    /** 读面故障开关：模拟宿主 openTabs 不可读（null），绝不是「确认没有」。 */
    setInventoryUnreadable(value) { inventoryUnreadable = value === true; },

    /** 推进轮询并结算异步链路：自动动作收尾后还会再推进同步，因此默认多跑几轮把级联排空。 */
    async sync(rounds = 3) {
      for (let index = 0; index < rounds; index += 1) {
        await intervals.tick();
        await handle.settle();
      }
    },
    /**
     * 宿主卸载旧 Panel 实例，再用**同一个已安装组件**（同一个 factory / install 闭包）挂载新实例。
     *
     * 宿主 inventory 保持原样：这正是「插件把账本存在组件生命周期里」这一缺陷的可观测条件。
     * 新实例的 hook 槽位、ref 与 records 全部重新创建，只有 install 闭包里的东西能活下来。
     */
    async remount() {
      handle.unmount();
      handle = runtime.render(component, { scope: { sessionId: activeScope.sidebarSessionId }, ctx: {} });
      await handle.settle();
      return handle;
    },
    /**
     * 同一个 Panel 实例切换到另一个 root（真实宿主换一组 props.scope 重新渲染同一实例）。
     *
     * 只改当前 root / sidebar session 与它的专家树；inventory、install 闭包与面板实例都不变，
     * 因此这一步专门用来验证「记账与恢复是否按 root 隔离」。
     */
    switchRoot(nextRootSessionId, next = {}) {
      activeScope.rootSessionId = nextRootSessionId;
      activeScope.sidebarSessionId = next.sidebarSessionId ?? nextRootSessionId;
      if (Array.isArray(next.children)) {
        childrenByRoot.set(nextRootSessionId, makeChildren(next.children));
        // 专家树换了，反查索引必须跟着重建：否则新 root 的 child 会解析不到（或解析到旧 root）。
        reindexChildOwners();
      }
      handle.rerender({ scope: { sessionId: activeScope.sidebarSessionId } });
      return handle;
    },
    /** 点击某一行的手动箭头（等价于用户点击，来源恒为 manual）。 */
    async clickArrow(label) {
      const event = {
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
      };
      await arrowOf(label).props.onClick(event);
      await handle.settle();
      return event;
    },
    arrowOf,
    batchButton: batchButtonOf,
    /** 标题栏 Auto 开关的 input 与它的 label（缺失时返回 null）。 */
    autoToggle() {
      const all = collect(handle.output);
      const input = all.find((node) => node?.type === "input" && node?.props?.["aria-label"] === "Auto") ?? null;
      const label = all.find((node) => typeof node?.props?.className === "string"
        && node.props.className.split(/\s+/).includes("deg_expert_group_header_auto")) ?? null;
      return { input, label };
    },
    /**
     * HMR 形状：同一个 realm 里重新执行同一个侧栏脚本（可能还换了 realm）之后，用新模块**再 install
     * 一次**，并让宿主重挂载面板。ctx / deps / inventory / closes / 计时器全部原样保留——这正是真实
     * 宿主在 ClientModuleSystem 失效主插件模块后的行为（见 client-freshness.js 的说明）。
     */
    async hotReloadSidebar(reloadOptions = {}) {
      const nextSidebar = typeof reloadOptions.sidebarModule === "object" && reloadOptions.sidebarModule !== null
        ? reloadOptions.sidebarModule
        : (options.sidebarModuleProvider !== undefined && options.sidebarModuleProvider !== null
          ? await options.sidebarModuleProvider.reload(reloadOptions)
          : installedSidebar);
      registered.length = 0;
      handle.unmount();
      try {
        dispose();
      } catch {
        /* 旧 install 的释放失败不影响新装载：真实 HMR 同样不会因此中止。 */
      }
      installedSidebarNext = nextSidebar;
      dispose = nextSidebar.installExpertGroupSidebar(ctx, deps);
      component = registered[0]?.component;
      assert.equal(typeof component, "function", "重新装载之后 Better 页面组件必须已注册");
      handle = runtime.render(component, { scope: { sessionId: activeScope.sidebarSessionId }, ctx: {} });
      await handle.settle();
      return handle;
    },
    dispose() {
      handle.unmount();
      dispose();
      if (restorePresenceDom !== null) restorePresenceDom();
      restoreGlobals();
    },
  };
}

test("Auto 契约：开关关闭（含 install 未注入读面）时不做任何自动打开或关闭", async () => {
  const disabled = await installAutoSidebarHarness({ autoOpen: false, children: [{ id: "child-a", status: "running" }] });
  try {
    await disabled.sync();
    assert.deepEqual(disabled.resources, [], "Auto 关闭时绝不自动打开任何资源");
    assert.deepEqual(disabled.closes, [], "Auto 关闭时绝不自动关闭任何 tab");
    assert.equal(disabled.arrowOf("子代理 child-a").props["data-open"], "false", "手动箭头必须保持未打开态");
    assert.equal(disabled.inventory.length, 0, "Auto 关闭时宿主 inventory 不被插件写入");
  } finally {
    disabled.dispose();
  }

  // 旧宿主 / 直接 createExpertGroupPanel：没有新读面时同样按关闭处理（缺依赖绝不开启）。
  const missing = await installAutoSidebarHarness({ withAutoDep: false, children: [{ id: "child-a", status: "running" }] });
  try {
    await missing.sync();
    assert.deepEqual(missing.resources, [], "缺少 getAutoOpenSubagentSidebar 时必须按关闭处理");
    assert.deepEqual(missing.closes, []);
  } finally {
    missing.dispose();
  }
});

test("Auto 契约：开启后自动打开运行中的子代理，且同一个资源绝不重复打开", async () => {
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "running" }] });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的子代理必须被自动打开一次");
    assert.deepEqual(fixture.resources[0], {
      address: "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable",
      options: { kind: "subagentchat", preferNewPane: true },
    });
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "落地证据齐备后箭头必须进入 << 态");
    // 多轮轮询：已打开的资源不得被重复打开（openResource 绝不再发第二次）。
    await fixture.sync(4);
    assert.equal(fixture.resources.length, 1, "已落地的资源绝不能被重复打开");
    assert.deepEqual(fixture.closes, [], "仍在运行的资源不得被自动关闭");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：资源结束后只关闭 Auto 自己打开的 tab，手动来源的空闲会话保持打开", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "ready" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "只有运行中的 child-a 会被自动打开");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");
    // 用户在空闲分组里手动打开 child-b：这是手动来源。
    await fixture.clickArrow("子代理 child-b");
    assert.equal(fixture.resources.length, 2, "手动打开必须照常发出 openResource");
    assert.equal(fixture.arrowOf("子代理 child-b").props["data-open"], "true");
    // child-a 运行结束：只有它的 tab（Auto 来源）允许被自动关闭。
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, ["tab-1"], "只允许关闭 Auto 本次运行打开的那个 tab");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "自动关闭后箭头必须复位");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-2"], "手动打开的 tab 必须原样留在宿主里");
    assert.equal(fixture.arrowOf("子代理 child-b").props["data-open"], "true", "手动来源的空闲会话绝不被自动关闭");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：同批多个空闲子代理的 close Promise 拒绝后仍会重试关闭", async () => {
  const rejectedOnce = new Set(["tab-1", "tab-2"]);
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: Array.from({ length: 9 }, (_, index) => ({ id: "child-" + (index + 1), status: "running" })),
    closeTab(tabId, applyClose) {
      if (rejectedOnce.delete(tabId) === true) {
        const rejected = Promise.reject(new Error("宿主暂时未能关闭这个 tab"));
        // 旧实现没有 await 返回值；在测试夹具中吸收进程级未处理拒绝，只断言可观测的重试行为。
        void rejected.catch(() => {});
        return rejected;
      }
      return applyClose();
    },
  });
  try {
    await fixture.sync(16);
    assert.equal(fixture.resources.length, 9, "Auto 必须先为同批 9 个运行中子代理打开侧栏");

    for (const child of fixture.children) child.status = "ready";
    await fixture.sync(24);

    assert.deepEqual(fixture.inventory, [], "异步关闭失败的子代理也必须保留归属并自动重试，最终全部关闭");
    const attempts = new Map();
    for (const tabId of fixture.closes) attempts.set(tabId, (attempts.get(tabId) ?? 0) + 1);
    assert.equal(attempts.get("tab-1"), 2, "第一个异步失败的 tab 必须重试一次");
    assert.equal(attempts.get("tab-2"), 2, "第二个异步失败的 tab 必须重试一次");
    for (let index = 3; index <= 9; index += 1) {
      assert.equal(attempts.get("tab-" + index), 1, "其余成功关闭的 tab 不应重复调用");
    }
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：手动关闭自动打开的 tab 后不立刻重开，手动重新打开清除抑制", async () => {
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "running" }] });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的子代理必须先被自动打开");
    assert.deepEqual(fixture.closes, []);
    // 用户手动关闭这个（自动打开的）tab：使用记录里的精确 tabId，且登记抑制。
    await fixture.clickArrow("子代理 child-a");
    assert.deepEqual(fixture.closes, ["tab-1"], "手动关闭必须使用记录里的精确 tabId");
    await fixture.sync(4);
    assert.equal(fixture.resources.length, 1, "被用户手动关闭后 Auto 绝不立刻重新打开");
    // 用户手动重新打开：清除抑制并把手动意图交给记录。
    await fixture.clickArrow("子代理 child-a");
    assert.equal(fixture.resources.length, 2, "手动重新打开必须照常打开 diag=" + JSON.stringify({ closes: fixture.closes, inv: fixture.inventory.map((e) => e.tabId), arrow: fixture.arrowOf("子代理 child-a").props["data-open"] }));
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");
    /**
     * 资源随后结束：用户这次是在**运行中**重新打开（running+present = 正常状态），按统一相位规则
     * 归属收敛为 auto，因此本轮结束时它与 Auto 打开的 tab 一样被收回。旧断言（"手动重新打开的 tab
     * 绝不被自动关闭"）锁的是收敛之前的契约；同一轮里"运行中关闭"（running+absent）仍保持抑制。
     */
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, ["tab-1", "tab-2"], "运行中重新打开的 tab 在相位规则下属 Auto，本轮结束必须收回");
    assert.deepEqual(fixture.inventory.filter((entry) => entry.kind === "subagentchat").map((entry) => entry.tabId), []);
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：手动打开的空闲会话在后续同步里保持打开", async () => {
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "ready" }] });
  try {
    await fixture.sync();
    assert.deepEqual(fixture.resources, [], "空闲（非运行中）资源绝不触发自动打开");
    await fixture.clickArrow("子代理 child-a");
    assert.equal(fixture.resources.length, 1, "手动箭头照常打开空闲会话");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "手动打开的空闲会话绝不被自动关闭");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "空闲会话的 << 态必须保持");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：来源与抑制按复合键隔离，别的 session 的同地址 tab 不被误判也不被关闭", async () => {
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "running" }] });
  try {
    // 另一个 sidebar session（child surface）已在它自己的右栏里打开同一个资源地址：
    // 它既不能算作「当前栏已打开」，也绝不能被当前栏的自动关闭碰到。
    const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
    fixture.inventory.push({ sessionId: "child-a", tabId: "tab-other", kind: "subagentchat", contentId: address });
    await fixture.sync(4);
    assert.equal(fixture.resources.length, 1, "别的 session 的 tab 不算当前栏已打开");
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, ["tab-1"], "只允许关闭当前 scope 自己的 tab");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-other"], "别的 session 的 tab 必须原样保留");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：inventory 不可读时不自动打开；active 已存在的资源视为手动来源，不被接管也不被关闭", async () => {
  const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    openTabs: false,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    // 没有任何证据说这个资源已经打开，但也没有 inventory 能证明它没打开：必须 fail-closed。
    await fixture.sync(4);
    assert.deepEqual(fixture.openAttempts, [], "inventory 不可读时无法证明资源没打开，绝不自动 open");

    // 用户在宿主 UI 里打开同一个资源：这次 active() 能读到它，但 inventory 依然不可读。
    const hostTabId = fixture.hostOpenTab(address);
    await fixture.sync(4);
    assert.deepEqual(fixture.openAttempts, [], "active 已存在的资源绝不能被 Auto 重复打开");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "手动来源的记录让箭头进入 <<");
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "active 已存在的 tab 只算手动/未知来源，Auto 绝不接管、更不自动关闭");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [hostTabId]);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "tab 保持打开，交给用户手动处理");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：缺少公开 close 能力时绝不自动打开（未来无法精确回收的 tab 不归 Auto）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    close: false,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync(4);
    assert.deepEqual(fixture.openAttempts, [], "没有 close() 时自动打开的 tab 无法被精确回收，绝不自动 open");
    assert.deepEqual(fixture.resources, []);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], undefined, "能力不齐备时不渲染 toggle 态");

    // 手动路径与历史行为逐条不变：箭头照旧打开（旧宿主 preferNewPane 兼容路径）。
    await fixture.clickArrow("子代理 child-a");
    assert.equal(fixture.openAttempts.length, 1, "手动箭头必须保持旧语义");
    assert.deepEqual(fixture.openAttempts[0].options, { kind: "subagentchat", preferNewPane: true });
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [], "没有 close 能力时插件绝不尝试任何自动关闭");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：等待布局期间手动关闭有优先级——在途自动打开让位，绝不随后重开", async () => {
  const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须真实停在「等宿主布局提交」的 await 里");
    assert.deepEqual(fixture.openAttempts, [], "布局等待还没放行，绝不允许发出 openResource");

    // 用户在这个窗口里已经手动打开了同一个资源（宿主提交，不是本插件动作）。
    const hostTabId = fixture.hostOpenTab(address);
    await fixture.sync();
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "手动打开必须已经反映成 <<");

    // 用户接着点 <<：这次点击撞在 Auto 的 pending 锁上，但绝不能被丢弃。
    await fixture.clickArrow("子代理 child-a");
    assert.deepEqual(fixture.closes, [], "在途动作还没让位，此刻不允许发出任何关闭");

    await fixture.flushLayout();
    await fixture.sync(4);
    assert.deepEqual(fixture.openAttempts, [], "手动关闭接管之后，Auto 绝不能再打开一次");
    assert.deepEqual(fixture.closes, [hostTabId], "手动关闭必须使用记录里的精确 tabId");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "关闭后箭头必须复位");

    // 资源仍在运行、Auto 仍开启：抑制必须继续生效，绝不重开。
    await fixture.sync(4);
    assert.deepEqual(fixture.openAttempts, []);
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-expert-group"]);
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：等待布局期间手动打开把最终 tab 记成 manual，且绝不被自动关闭", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须真实停在布局等待里");

    // 箭头此刻是 >>：用户点击表达「打开」意图，锁被 Auto 占着也不能丢。
    await fixture.clickArrow("子代理 child-a");
    assert.deepEqual(fixture.openAttempts, [], "点击被记成意图，绝不在锁内并发第二次打开");

    await fixture.flushLayout();
    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 1, "手动意图与自动动作必须收敛成恰好一次 openResource");
    assert.equal(fixture.resources.length, 1);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");

    /**
     * 资源结束：用户在这次运行中亲手打开了这个 tab（manual-open）。按统一相位规则
     * 「running+present = auto」，下一次同步会把归属收敛成 auto——它不属于「偏离正常状态」的
     * 手动意图，本轮结束时应与 Auto 打开的 tab 一样收回。旧断言（"绝不被自动关闭"）锁的是收敛
     * 之前的旧契约，这里按新语义同步（外部写入者/无法证明来源的 tab 仍是 manual，见同步抛错用例）。
     */
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.equal(fixture.closes.length, 1, "manual-open 的 tab 在新相位规则下属 Auto，本轮结束必须被收回");
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      0,
      "tab 必须被收回",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：等待期间关闭 Auto 取消在途自动打开，不产生 open，也不自动关闭已有 tab", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须真实停在布局等待里");

    // 用户在标题栏关掉 Auto：在途动作必须在真正调用 openResource 之前放弃。
    fixture.autoOpenState.value = false;
    await fixture.sync();
    await fixture.flushLayout();
    assert.deepEqual(fixture.openAttempts, [], "关闭 Auto 必须取消还没落地的自动打开");
    assert.deepEqual(fixture.closes, [], "关闭 Auto 绝不自动关闭任何 tab");

    // 预留已经撤销：重新开启后同一个资源必须能被重新选中（被取消不等于「已经打开过」）。
    fixture.autoOpenState.value = true;
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "重新开启 Auto 后必须重新发起这次自动打开");
    await fixture.flushLayout();
    await fixture.sync(2);
    assert.equal(fixture.resources.length, 1, "重新开启后必须能完成这次自动打开");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;

    // 再次关闭 Auto 并让资源结束：已存在的 tab 保持原样，交给用户手动处理。
    fixture.autoOpenState.value = false;
    fixture.children[0].status = "completed";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "关闭 Auto 之后绝不自动关闭已有 tab");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "tab 必须保持打开");

    // 重新开启 Auto：这次资源已结束，Auto 用它自己记录的精确 tabId 收口。
    fixture.autoOpenState.value = true;
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "Auto 只关闭自己打开过、且已经结束的 tab");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：split 准备失败后撤销预留，下一轮同步可以重试成功", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    splitFailures: 1,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须先走到布局等待");
    await fixture.flushLayout();
    assert.deepEqual(fixture.resources, [], "宿主拒绝分栏时绝不回落成 openResource");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false");
    // 失败屏障：同一条微任务级联里绝不重试（否则「失败 → 撤销预留 → 立刻重选」会自转）。
    assert.equal(fixture.layoutWaits(), 0, "同一次级联里绝不立刻重试同一个 key");

    // 预留已释放：下一轮外部同步（轮询/observer）里屏障失效，同一个资源必须能被重新选中。
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "下一轮同步必须重新发起候选动作");
    await fixture.flushLayout();
    await fixture.sync(2);
    assert.equal(fixture.resources.length, 1, "下一轮同步必须能重试并成功自动打开");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：openResource 抛错后撤销预留，下一轮同步可以重试成功", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    openFailures: 1,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync(3);
    assert.equal(fixture.openAttempts.length, 2, "第一次抛错后必须重试一次");
    assert.equal(fixture.resources.length, 1, "抛错的打开不算成功，重试必须真的落地");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true");
    // 重试成功后仍要守住「同一个资源绝不重复打开」。
    await fixture.sync(4);
    assert.equal(fixture.openAttempts.length, 2);
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：split 事务在途导致的失败绝不在微任务里空转（自动重试有上界）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "child-a 的自动打开停在布局等待里");
    const readsBefore = fixture.inventoryReads();
    await fixture.flushLayout();
    // child-a 完成自动打开；child-b 撞上同一 sidebar session 在途的 split 事务（协调器返回 busy）。
    assert.equal(fixture.openAttempts.length, 1, "只有 child-a 被自动打开");
    assert.equal(fixture.layoutWaits(), 0, "busy 失败之后绝不在同一批微任务里重试同一个 key");
    /**
     * 关键不变量：失败之后的候选评估必须有界。
     * 若「失败 → 撤销预留 → 立刻重选」失去上界，这一轮会变成不让出宏任务的微任务死循环，
     * 夹具的防挂死阀（inventory 读面在上限后失效）会让它收敛，这里的断言随即失败。
     */
    assert.ok(
      fixture.inventoryReads() - readsBefore < 40,
      "busy 失败之后的候选评估必须有界，实际新增 " + (fixture.inventoryReads() - readsBefore),
    );

    // 下一轮外部同步仍然可以重新尝试 child-b（失败可重试，只是不在同一批微任务里空转）。
    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 1, "在途 split 事务未收口前，child-b 仍然打不开（但绝不空转）");
    assert.ok(fixture.inventoryReads() < 300, "总评估次数必须远低于防挂死阀");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：面板重挂载后仍能关闭 Auto 打开的 fixer tab（宿主 inventory 保留）", async () => {
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "running" }] });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的子代理必须先被 Auto 打开");
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabId, "tab-1", "Auto 打开的 tab 必须先落进宿主 inventory");
    assert.deepEqual(fixture.closes, [], "仍在运行的资源不得被自动关闭");

    // 宿主（keyed session surface）卸载旧 Panel 实例、再用同一个已安装组件挂载新实例：
    // 宿主 inventory 原样保留这个 tab，而旧实例的组件级记账全部消失。
    await fixture.remount();
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "重挂载后必须从宿主 inventory 恢复这条 tab 的打开态",
    );

    // 子代理变 idle：Auto 必须仍然认得这是自己打开过、并且仍属于当前 scope 的 tab，用真实 tabId 关闭它。
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "重挂载绝不能改变归属：Auto 自己打开的 tab 仍必须被自动关闭");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [], "关闭后宿主 inventory 里不得残留这个 tab");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：关闭在途时重挂载，绝不对同一个 tab 发起第二次关闭", async () => {
  /** 宿主这次关闭的结算句柄：只有用例显式放行，它才真的把 tab 从 inventory 里移除。 */
  let settleClose = null;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      // 宿主非幂等 / 结算延迟的真实形状：close() 返回一个悬而未决的 Promise，真正移除 tab 发生在
      // 它结算之后。这次调用在途期间，同一个 tabId 上绝不允许再发出第二次 close。
      return new Promise((resolve) => {
        settleClose = () => { applyClose(); resolve(); };
      });
    },
  });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的子代理必须先被 Auto 打开");
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabId, "tab-1", "Auto 打开的 tab 必须先落进宿主 inventory");

    // 子代理结束 → Auto 发起关闭；宿主还没有结算，这次关闭停在 pending Promise 里。
    fixture.children[0].status = "completed";
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [autoTabId], "Auto 必须先为已经结束的资源发起一次关闭");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [autoTabId], "宿主尚未结算时 tab 仍留在 inventory");

    // 宿主（keyed session surface）在关闭在途期间卸载旧 Panel、再用同一个已安装组件挂载新实例：
    // 宿主 inventory 与那次在途关闭都原样保留，新实例会重新收养这个 tab。
    await fixture.remount();
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "同一个 tab 的关闭在途时，新 Panel 绝不能再发起第二次关闭");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [autoTabId], "没有第二次关闭，tab 就必须原样留在 inventory");

    // 宿主结算那次关闭：tab 真的离开 inventory，并且全程只允许一次 close 调用。
    assert.equal(typeof settleClose, "function", "本场景必须真实产生一次在途关闭");
    settleClose();
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "结算之后同样只允许这一次 close 调用");
    assert.deepEqual(fixture.inventory, [], "关闭成功后这个 tab 必须离开宿主 inventory");

    // 「来源按成功路径清理」的可观察证据：同一个资源重新变成运行中时，Auto 必须能再次打开它
    // （账本若还留着这个 key，Auto 会把它当成「本次运行已经打开过」而永远不再打开）。
    // 先重挂载清掉实例级的打开记录，让这条断言只依赖 Auto 自己的来源账本。
    await fixture.remount();
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(fixture.resources.length, 2, "关闭成功清理来源后，同一个资源重新运行必须能再次被自动打开");
    assert.deepEqual(fixture.closes, [autoTabId], "重新打开绝不产生额外的关闭");
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      1,
      "重新打开只允许落一个 tab",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：关闭在途时重挂载，旧实例的迟到收尾绝不清掉新实例的 Auto 来源", async () => {
  /**
   * 场景（旧实例的异步收尾污染新实例）：
   * 1. Auto 打开资源 A，A 随后变 idle ⇒ 旧实例发起关闭，这次 close 停在宿主的 pending Promise 里；
   * 2. 关闭在途期间宿主卸载旧 Panel、再用同一个已安装组件挂载新实例（共享 Auto 账本跨重挂载保留）；
   * 3. 新实例加入新的运行中资源 B，并确认新 Panel 真的自动打开了 B（B 的 Auto 来源写进共享账本）；
   * 4. 宿主结算 A 的那次关闭：旧实例的迟到续体从这里继续跑，此时它那一轮的 surface（root/sidebar
   *    session）与「仍挂载」证据都已经失效，绝不允许它再用旧快照推进同步、清掉 B 的共享来源；
   *    已经消失的 A tab 由新实例按真实 inventory 收口（绝不补发第二次 close）；
   * 5. B 之后变 idle：新实例必须仍然认得这是 Auto 亲手打开的 tab，并用真实 tabId 关掉它。
   *
   * 只经公开面断言：宿主 inventory、openResource/close 调用记录与箭头开合态。绝不窥视插件的私有 Map。
   */
  /** 资源 A（tab-1）**第一次**关闭的结算句柄：只有用例放行，它才真的把 tab 从 inventory 移除。 */
  let settleCloseA = null;
  let closeAttemptsA = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      // 只有 A 的第一次关闭停在宿主 pending Promise 里；此后（典型：新 Panel 按真实 inventory 结算
      // 同一条已经被关掉的旧 tab）照常立即结算，避免把用例卡在一个永不结算的宿主调用上。
      if (tabId === "tab-1" && closeAttemptsA === 0) {
        closeAttemptsA += 1;
        return new Promise((resolve) => { settleCloseA = () => { applyClose(); resolve(); }; });
      }
      return applyClose();
    },
  });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的 child-a 必须先被 Auto 打开");
    assert.equal(fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId, "tab-1");

    // A 变 idle：旧实例发起关闭，宿主尚未结算 ⇒ 这次关闭停在 pending Promise 里（租约在途）。
    fixture.children[0].status = "ready";
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, ["tab-1"], "Auto 必须先为已经空闲的 child-a 发起一次关闭");
    assert.equal(typeof settleCloseA, "function", "本场景必须真实产生一次在途关闭");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-1"], "宿主尚未结算时 tab-1 仍留在 inventory");

    // 关闭在途期间宿主重挂载 Panel：同一个 factory 的共享 Auto 账本保留，旧实例的闭包从此失效。
    await fixture.remount();

    // 新实例里出现新的运行中资源 child-b（形状与夹具的专家节点一致）：新 Panel 必须真的为它自动打开侧栏。
    fixture.children.push({
      id: "child-b",
      kind: "expert",
      sessionId: "child-b",
      taskName: "子代理 child-b",
      role: "fixer",
      content: "任务 child-b",
      status: "running",
      continuable: true,
    });
    await fixture.sync(6);
    assert.equal(fixture.resources.length, 2, "新 Panel 必须为新的运行中资源 child-b 自动打开侧栏");
    const autoTabIdB = fixture.inventory.find((entry) => String(entry.contentId ?? "").includes("child-b"))?.tabId;
    assert.equal(autoTabIdB, "tab-2", "child-b 的自动打开必须先落进宿主 inventory");
    assert.equal(fixture.arrowOf("子代理 child-b").props["data-open"], "true", "B 的自动打开必须反映成 << 态");
    assert.deepEqual(fixture.closes, ["tab-1"], "B 仍在运行：此时不得有任何新的关闭");

    // 宿主结算 A 的那次关闭：旧实例的迟到收尾从这里继续（这正是被污染的窗口）。
    settleCloseA();
    await fixture.sync(6);
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [autoTabIdB],
      "旧实例的迟到收尾只许收口它自己那次关闭：A 的旧 tab 必须离开 inventory，B 的 tab 必须原样保留",
    );
    assert.equal(fixture.arrowOf("子代理 child-b").props["data-open"], "true", "B 仍在运行：绝不能被自动关闭");

    // B 也变 idle：只要 B 的共享 Auto 来源还在，新实例就必须认出自己打开的 tab 并关闭它。
    fixture.children[1].status = "ready";
    await fixture.sync(6);
    assert.ok(
      fixture.closes.includes(autoTabIdB),
      "旧实例的迟到收尾绝不能让 B 失去 Auto 来源：B 的 tab 必须被 Auto 关闭，实际 close 序列 "
        + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [], "两个 Auto tab 最终都必须离开宿主 inventory");
    assert.equal(fixture.arrowOf("子代理 child-b").props["data-open"], "false", "自动关闭后 B 的箭头必须复位");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：批量关闭与单 tab 关闭共用同一把在途锁，绝不重复关闭同一个 tab", async () => {
  /** 这次关闭的结算句柄：在它结算之前，同一个 tabId 上的关闭锁必须一直有效。 */
  let settleClose = null;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      // 宿主非幂等 / 结算延迟：close() 停在 pending Promise 里，真正移除 tab 发生在结算之后。
      return new Promise((resolve) => {
        settleClose = () => { applyClose(); resolve(); };
      });
    },
  });
  try {
    await fixture.sync();
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabId, "tab-1", "Auto 打开的 tab 必须先落进宿主 inventory");

    // 用户手动关闭这个仍在运行、tab 也仍然开着的资源：箭头 onClick 返回的正是这次动作的 Promise，
    // 因此这里刻意不 await 它——这次关闭此刻仍停在宿主的 pending Promise 里（在途）。
    void fixture.arrowOf("子代理 child-a").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, [autoTabId], "手动关闭必须先发出一次 close");

    // 资源仍在运行 ⇒ 批量入口此刻仍然把这个 tab 算作候选；它绝不能在同一个 tab 上再发一次 close。
    const batch = fixture.batchButton();
    assert.ok(batch, "运行中的资源必须渲染批量关闭按钮");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 1 个运行中的子代理");
    void batch.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, [autoTabId], "同一个 tab 的关闭在途时，批量入口绝不能再发第二次 close");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [autoTabId], "没有第二次关闭，tab 必须原样留在 inventory");

    // 宿主结算那次关闭：关闭成功、登记抑制，Auto 绝不立刻重开。
    assert.equal(typeof settleClose, "function", "本场景必须真实产生一次在途关闭");
    settleClose();
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "结算之后同样只允许这一次 close");
    assert.deepEqual(fixture.inventory, [], "关闭成功后 tab 必须离开宿主 inventory");
    assert.equal(fixture.resources.length, 1, "手动关闭必须登记抑制：Auto 绝不立刻重新打开");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：批量关闭逐项重读 inventory——单项入口已成功关闭的候选绝不再 close", async () => {
  /** 第一个候选（tab-1）的宿主结算句柄：只有用例放行，它才真的把 tab 从 inventory 移除。 */
  let settleFirst = null;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab(tabId, applyClose) {
      // 真实宿主的异步结算形状：第一个候选的 close 停在 pending Promise 里，第二个候选照常立即结算。
      if (tabId === "tab-1") return new Promise((resolve) => { settleFirst = () => { applyClose(); resolve(); }; });
      return applyClose();
    },
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");
    const batch = fixture.batchButton();
    assert.ok(batch, "运行中的资源必须渲染批量关闭按钮");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 2 个运行中的子代理");

    // 批量候选集合固定在渲染时快照 [tab-1, tab-2] 上；刻意不 await：序列正停在 tab-1 的 pending close 里。
    void batch.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, ["tab-1"], "批量必须先对第一个候选发出关闭");
    assert.equal(typeof settleFirst, "function", "本场景必须真实产生一次在途关闭");

    // tab-1 仍在等宿主结算：用户此刻手动关闭 tab-2（单项入口），并且这次关闭真的成功。
    await fixture.clickArrow("子代理 child-b");
    assert.deepEqual(fixture.closes, ["tab-1", "tab-2"], "单项入口必须用自己的 lease 关闭 tab-2");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-1"], "tab-2 必须已经被真实移除");

    // 放行 tab-1：批量推进到第二个候选之前必须重读**当前** inventory，绝不按渲染时快照再 close 一次。
    settleFirst();
    await fixture.handle.settle();
    await fixture.sync(2);
    const attempts = new Map();
    for (const tabId of fixture.closes) attempts.set(tabId, (attempts.get(tabId) ?? 0) + 1);
    assert.equal(attempts.get("tab-1"), 1, "tab-1 只允许关闭一次");
    assert.equal(attempts.get("tab-2"), 1, "tab-2 只能由成功的单项入口关闭这一次：批量绝不能再对已消失的候选 close");
    assert.deepEqual(fixture.inventory, [], "两个 tab 最终都必须离开 inventory");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：单项关闭失败结算后，批量等待者复核 inventory 并接管一次有限重试", async () => {
  /** 单项 tab-2 关闭的 reject 句柄：它结算之前，lease 一直被这次在途关闭持有。 */
  let rejectSingle = null;
  let singleAttempts = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab(tabId, applyClose) {
      // 只对 tab-2 的**第一次**关闭注入 pending-then-reject：批量等待者必须能接管一次重试。
      if (tabId === "tab-2" && singleAttempts === 0) {
        singleAttempts += 1;
        return new Promise((_, reject) => { rejectSingle = () => reject(new Error("宿主暂时关闭失败")); });
      }
      return applyClose();
    },
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");

    // 单项入口关闭 tab-2：这次 close 停在 pending Promise 里，因此 lease 仍被它持有。
    void fixture.arrowOf("子代理 child-b").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, ["tab-2"], "单项入口必须先对 tab-2 发出一次 close");
    assert.equal(typeof rejectSingle, "function", "本场景必须真实产生一次在途关闭");

    // 批量开始：第一个候选立即成功，随后到达 tab-2 时 lease 仍被单项持有 → 必须等待结算，绝不跳过。
    const batch = fixture.batchButton();
    assert.ok(batch, "运行中的资源必须渲染批量关闭按钮");
    void batch.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, ["tab-2", "tab-1"], "批量只能先关掉自己的第一个候选；tab-2 必须停在等待里");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-2"], "等待期间 tab-2 仍必须留在 inventory");

    // 单项关闭失败结算：等待者必须看到这次失败，用当前 inventory 证明同一个 tabId 仍在，
    // 然后接管**一次**有限重试（失败一次 + 成功一次，绝不静默丢失、也绝不无限重试）。
    rejectSingle();
    await fixture.handle.settle();
    await fixture.sync(2);
    const attempts = new Map();
    for (const tabId of fixture.closes) attempts.set(tabId, (attempts.get(tabId) ?? 0) + 1);
    assert.equal(attempts.get("tab-2"), 2, "失败一次 + 成功一次：等待者必须恰好接管一次重试");
    assert.equal(attempts.get("tab-1"), 1, "批量自己的候选只允许关闭一次");
    assert.deepEqual(fixture.inventory, [], "接管重试成功后 tab-2 必须离开 inventory（用户意图绝不被静默丢失）");
    assert.ok(fixture.inventoryReads() < 300, "有限重试必须有界，绝不无限重试");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：重挂载后来源未知的手动 tab 绝不被自动关闭", async () => {
  const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "ready" }] });
  try {
    await fixture.sync();
    assert.deepEqual(fixture.resources, [], "空闲资源绝不触发自动打开");
    // 用户在宿主 UI 里自己打开这个空闲会话：插件从未为它发出过打开动作，来源未知。
    // 打开之后宿主**立刻**卸载旧 Panel 并挂载新实例（旧实例没有机会 sync 一次），因此这条 tab
    // 从未被任何 Panel 收养过——新实例是第一次看到它，必须仍然按「来源未知」处理。
    const hostTabId = fixture.hostOpenTab(address);
    assert.deepEqual(fixture.closes, [], "宿主自己打开的 tab 不经过插件，绝不允许有任何 close");
    assert.deepEqual(fixture.openAttempts, [], "手动 tab 出现时插件绝不补一次打开");
    await fixture.remount();
    assert.deepEqual(fixture.closes, [], "新 Panel 挂载提交期间不得有任何插件 close");
    assert.deepEqual(fixture.openAttempts, [], "新 Panel 挂载提交期间不得有任何插件 open");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "来源未知的手动 tab 绝不能被重挂载收养成 Auto 自己的 tab");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [hostTabId], "这个 tab 必须原样留在宿主里");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "来源未知的已存在 tab 同样是 << 态，只交给用户手动处理",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：同一 factory 的多 root 恢复彼此隔离（前一个 root 的记录不阻止本 root 收养已存在的 tab）", async () => {
  const addressB = "dsh-resource://subagentchat/session/child-b?parent=root-b&mode=continuable";
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "running" }] });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "root-a 的运行中子代理必须先被自动打开");
    const autoTabIdA = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabIdA, "tab-1");

    // root-b 的右栏里已经存在 child-b 的 tab（宿主侧提交，与当前面板实例无关）。
    const hostTabIdB = fixture.hostOpenTab(addressB, "root-b");
    // 同一个 Panel 实例切换到 root-b：root-a 的打开记录仍留在这个实例的 records 里。
    fixture.switchRoot("root-b", { children: [{ id: "child-b", status: "ready" }] });
    await fixture.sync(4);
    assert.equal(
      fixture.arrowOf("子代理 child-b").props["data-open"],
      "true",
      "切到 root-b 后必须从 inventory 收养它自己的已存在 tab（前一个 root 的记录不得阻止恢复）",
    );
    assert.deepEqual(fixture.closes, [], "收养一个来源未知的 tab 绝不产生任何自动关闭");
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId).sort(),
      [autoTabIdA, hostTabIdB].sort(),
      "两个 root 的 tab 都必须原样留在宿主里",
    );

    // 切回 root-a：它自己的记录与 Auto 来源仍然有效，绝不因为切过一次 root 就丢失归属。
    fixture.switchRoot("root-a");
    await fixture.sync(2);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "root-a 的打开态必须原样保留");
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabIdA], "切回 root-a 后，Auto 仍必须关闭自己打开、且已经结束的 tab");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：旧 Panel 的自动打开迟到收尾绝不清掉新 Panel 对同一资源写入的 Auto 来源", async () => {
  /**
   * 场景（自动打开的迟到收尾 + 重挂载）：
   * 1. Auto 为运行中的 child-a 发起自动打开，动作停在「等宿主布局提交」的 await 里；
   * 2. 宿主卸载旧 Panel、再用同一个已安装组件挂载新实例；新实例为**同一个资源 key** 发起自己的
   *    自动打开（旧实例那一帧仍留在队列里）；
   * 3. 新实例那一帧先结算：它真的调用 split()/openResource()，成功打开 tab 并写入 Auto 来源；
   * 4. 旧实例那一帧后结算：旧闭包既不 mounted、generation 也早已不是出发时那一份，它的 finally
   *    绝不允许再删掉这个 key 的共享 Auto 来源（旧实现正是在这里无条件 delete 的）；
   * 5. child-a 变 idle：新 Panel 必须仍然认得这是 Auto 亲手打开的 tab，并用真实 tabId 关掉它。
   *
   * 只经公开面断言：宿主 inventory、openResource/close 调用记录与箭头开合态。绝不窥视插件的私有 Map。
   */
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "旧 Panel 的自动打开必须停在「等宿主布局提交」的 await 里");
    assert.deepEqual(fixture.openAttempts, [], "布局等待还没放行，绝不允许发出 openResource");

    // 宿主（keyed session surface）卸载旧 Panel 实例、再用同一个已安装组件挂载新实例。
    await fixture.remount();
    assert.equal(fixture.layoutWaits(), 2, "重挂载后新 Panel 必须发起自己的自动打开，并同样停在布局等待里");

    // 新实例那一帧先结算：这次自动打开必须真的落地，并把「Auto 亲手打开」写进共享来源账本。
    await fixture.flushNewestLayoutFrame();
    assert.equal(fixture.openAttempts.length, 1, "新 Panel 必须为这个资源发出恰好一次 openResource");
    assert.equal(fixture.resources.length, 1, "新 Panel 的自动打开必须成功落地");
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.ok(autoTabId, "自动打开必须落进宿主 inventory");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "新 tab 必须已经反映成 <<");

    // 旧实例那一帧现在才结算：迟到续体已经是 stale，绝不允许再碰共享账本。
    await fixture.flushLayout();
    assert.equal(fixture.openAttempts.length, 1, "旧实例绝不允许再发出第二次 openResource");
    assert.deepEqual(fixture.closes, [], "资源仍在运行：此刻不得有任何关闭");

    // 子代理变 idle：新 Panel 必须仍然认得这是 Auto 打开的 tab，并用真实 tabId 关掉它。
    fixture.children[0].status = "ready";
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [autoTabId],
      "旧实例的迟到收尾绝不能让新 tab 失去 Auto 来源，实际 close 序列 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-expert-group"], "新 tab 必须被自动关闭");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "自动关闭后箭头必须复位");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：同一个 Panel A→B→A 快速回返时，旧 root 的迟到关闭收尾绝不清掉新 tab 的记录（宿主 mint 的新 tabId 按 manual 安全侧处理）", async () => {
  /**
   * 场景（同一个 Panel 实例的 scope ABA）：
   * 1. root A 的 Auto 打开 child-a；child-a 变 idle ⇒ 旧 root 的关闭停在宿主 pending Promise 里；
   * 2. 宿主换掉这个 tab：旧 tabId 离开 inventory，同一个资源换成新 tabId（那次关闭仍未结算）；
   * 3. 同一个 Panel 实例切到 root B 再切回 root A：字符串判据（root / sidebar session）在这里会
   *    **重新为真**，旧闭包由此把自己的迟到收尾当成当前 surface 的收尾继续执行；
   * 4. 回到 A 后插件按真实 inventory 重新收养新 tabId（record 成立，来源判据见第 5 条）；
   * 5. 宿主结算那次旧关闭：旧 generation 的续体绝不允许再删掉这个 key 的 record；
   * 6. 资源始终 idle ⇒ 这个 tab 绝不允许被自动关闭。理由正是缺陷 1 的判据：新 tabId 是宿主在插件
   *    没有观察到的那一刻 mint 出来的（共享来源账本里记的仍是旧 tabId，绑定失配），无法与「用户
   *    自己新开的同地址 tab」区分，因此按安全侧落 manual——宁可漏收一次，也绝不误关。
   *
   * 只经公开面断言：宿主 inventory、close 调用次数与箭头开合态。绝不窥视插件的私有 Map。
   */
  let settleFirstClose = null;
  let closeCalls = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    // 宿主把旧 tab 换成新 tabId 时，插件必须能从右栏 tab 节点观察到「记录里的 tabId 不在了」。
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      closeCalls += 1;
      if (closeCalls === 1) {
        // 旧 generation 那次关闭停在宿主 pending Promise 里：只有用例显式放行，它才真的移除 tab 并结算。
        return new Promise((resolve) => { settleFirstClose = () => { applyClose(); resolve(); }; });
      }
      return applyClose();
    },
  });
  try {
    const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
    await fixture.sync();
    const firstTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.ok(firstTabId, "运行中的 child-a 必须先被 Auto 打开");

    // child-a 变 idle：Auto 发起关闭，宿主尚未结算 ⇒ 旧 root 的那次关闭停在 pending Promise 里。
    fixture.children[0].status = "ready";
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [firstTabId], "Auto 必须先为已经空闲的 child-a 发起一次关闭");
    assert.equal(typeof settleFirstClose, "function", "本场景必须真实产生一次在途关闭");

    // 宿主替换这个 tab（旧 tabId 离开 inventory，同一个资源换成新 tabId）；随后同一个 Panel 实例
    // 切到 root B 再切回 root A——旧闭包捕获的 root/sidebar session 字符串会重新等于当前值。
    fixture.switchRoot("root-b", { children: [] });
    const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === firstTabId);
    assert.ok(staleIndex >= 0, "旧 tab 必须仍在 inventory 里（那次关闭还没结算）");
    fixture.inventory.splice(staleIndex, 1);
    const secondTabId = fixture.hostOpenTab(address, "root-a");
    assert.equal(fixture.inventory.filter((entry) => entry.kind === "subagentchat").length, 1, "同一个资源只允许一个新 tab");
    fixture.switchRoot("root-a");

    // 回到 A：插件必须按真实 inventory 重新收养新 tabId，并保留 Auto 归属。
    await fixture.sync(4);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "新 tabId 必须被重新收养成 << 态");
    assert.deepEqual(fixture.closes, [firstTabId], "旧关闭在途期间绝不允许出现第二次关闭");

    // 让资源在旧关闭结算前重新变成运行中：这一轮 Auto 只允许推进「不关它」，于是「迟到收尾有没有
    // 删掉新 tabId 的 record / Auto 来源」能被单独观察到，而不是和随后的自动关闭混在同一条断言里。
    fixture.children[0].status = "running";
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [firstTabId], "资源仍在运行：旧关闭在途期间同样不得关闭新 tab");

    // 宿主结算旧 root 那次关闭：旧 generation 的迟到续体从这里继续跑（这正是被污染的窗口）。
    settleFirstClose();
    assert.ok(
      fixture.inventory.some((entry) => entry.tabId === secondTabId),
      "宿主结算旧关闭之前，新 tabId 必须仍留在 inventory 里",
    );
    await fixture.sync(2);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "迟到收尾绝不能让新 tabId 失去记录");
    assert.deepEqual(fixture.closes, [firstTabId], "资源仍在运行：迟到收尾之后同样不得关闭新 tab");

    /**
     * 资源再次空闲：新 tabId 是宿主在插件没观察到的那一刻 mint 的，共享来源账本里记的仍是旧 tabId
     * ——绑定失配 ⇒ 按安全侧落 manual：**绝不自动关闭这个 tab**（宁可漏收一次，也绝不误关一个可能
     * 是用户自己刚打开的 tab；与跨整页刷新的持久条目闸门是同一条判据、同一个安全侧）。
     * 同时这条记录必须仍然在：旧 generation 的迟到收尾绝不允许删掉新 tab 的 record。
     */
    fixture.children[0].status = "ready";
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [firstTabId],
      "新 tabId 与来源账本的绑定失配 ⇒ 绝不允许被自动关闭，实际 close 序列 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").map((entry) => entry.tabId),
      [secondTabId],
      "新 tab 必须原样留在右栏里（交给用户手动处理）",
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "manual 来源的记录必须保持 <<");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：旧 generation 在副作用前取消回滚时，绝不重置新 generation 的关闭重试预算", async () => {
  /**
   * 场景（跨代次的共享关闭重试预算被旧动作回滚覆盖）：
   * 1. Auto 已经为 child-a 打开 tab-1（来源 auto）；child-a 变空闲，旧 generation 在一次完全同步
   *    的同步轮里选中关闭候选：预支一次重试预算（0 → 1），动作排进微任务但还没跑；
   * 2. 那次动作在真正调用宿主 close 之前作废（surface 换代：同一个实例切走再切回 + 面板重挂载）；
   * 3. 新 generation 在旧动作跑起来之前，为**同一个 key**重新选中关闭候选（1 → 2）——这条预算
   *    现在的所有者是它，不是旧动作；
   * 4. 旧动作随后才跑到 abandon/rollback：旧实现只按 key 把共享计数写回 attemptsBefore，于是新
   *    generation 的预算被删掉（等于被复活）；
   * 5. 宿主 close 连续 reject：预算被复活时，同一个 key 的实际 close 次数会超过 3 次上限；修复后
   *    旧动作的 attempt token 与 owner 账本不匹配，它只能清自己的局部预留，绝不写共享计数。
   *
   * 只经公开面断言：宿主 close 调用序列、inventory 与箭头开合态。绝不窥视插件的私有 Map。
   */
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    // 宿主持续拒绝关闭：每一次真实 close 都失败，有界重试预算因此被完整消耗，次数可直接观测。
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭这个 tab")); },
  });
  try {
    await fixture.sync();
    assert.equal(fixture.resources.length, 1, "运行中的 child-a 必须先被 Auto 打开");
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabId, "tab-1", "Auto 打开的 tab 必须先落进宿主 inventory");
    assert.deepEqual(fixture.closes, [], "仍在运行的资源不得被自动关闭");

    // child-a 变空闲。先用一轮「Auto 关闭」的外部同步把最新快照（status=ready）落进面板缓存：
    // 这一轮里 Auto 是关的，因此既不会预支任何关闭预算，也不会产生任何动作。
    fixture.children[0].status = "ready";
    fixture.autoOpenState.value = false;
    await fixture.sync(2);
    fixture.autoOpenState.value = true;

    // 下面整段是**同一段同步代码**：旧动作还停在微任务队列里，没有机会跑到副作用。
    // 切走再切回：effect 依赖（root / sidebar session）变化触发一次同步轮，旧 generation 由此为
    // 同一个 key 选中关闭候选并预支一次重试预算（0 → 1）；字符串判据随后会重新相等，只有不可复用
    // 的 surface 令牌能证明旧闭包那一次动作已经不属于当前 surface。
    fixture.switchRoot("root-b", { children: [] });
    fixture.switchRoot("root-a");
    // 宿主卸载旧实例、挂载新实例：新实例的挂载 effect 同步跑一轮同步，为同一个 key 重新选中关闭
    // 候选（1 → 2）。旧动作紧随其后在微任务里作废并回滚它那一笔预算。
    await fixture.remount();

    assert.ok(
      fixture.closes.length >= 1,
      "新 generation 必须真的为这个 key 发出关闭，实际 " + JSON.stringify(fixture.closes),
    );

    // 外部同步轮继续推进：预算一旦被旧回滚复活，实际 close 次数就会超过 3 次上限。
    await fixture.sync(6);
    assert.ok(
      fixture.closes.length <= 3,
      "同一个 key 的自动关闭实际尝试不得超过 3 次（旧代次的回滚绝不能重置新代次的预算），实际 "
        + fixture.closes.length + " 次：" + JSON.stringify(fixture.closes),
    );

    // 预算耗尽之后的同步绝不能再发出 close：任何旧 token 的迟到收尾也不得把它"复活"。
    const exhausted = fixture.closes.length;
    await fixture.sync(6);
    assert.equal(
      fixture.closes.length,
      exhausted,
      "重试预算耗尽后，后续同步绝不能再发出 close（实际新增 " + (fixture.closes.length - exhausted) + " 次）",
    );
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [autoTabId],
      "宿主持续拒绝时 tab 必须原样留在 inventory 里，留给用户手动处理",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：单代次在副作用前取消的关闭候选必须归还它预支的那一次重试预算", async () => {
  /**
   * 上一条用例守住的是「旧代次不得回滚后来者的预算」；这一条守住它的对偶面：**当前所有者**自己在
   * 副作用之前被取消（用户关掉 Auto）时，那次预支必须被精确归还。少了它，一次被取消的自动关闭就
   * 会白烧掉一次有界重试，Auto 会提前放弃这个 tab（旧实现的 attemptsBefore 语义必须逐条保留）。
   *
   * 只经公开面断言：宿主 close 调用序列与 Auto 开关。绝不窥视插件的私有 Map。
   */
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭这个 tab")); },
  });
  try {
    await fixture.sync();
    const autoTabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.equal(autoTabId, "tab-1", "Auto 打开的 tab 必须先落进宿主 inventory");

    // 同前一条用例：先用一轮 Auto 关闭的外部同步把 status=ready 的最新快照落进面板缓存。
    fixture.children[0].status = "ready";
    fixture.autoOpenState.value = false;
    await fixture.sync(2);
    fixture.autoOpenState.value = true;

    // 同一段同步代码：本代次选中关闭候选并预支一次预算，动作还停在微任务里；紧接着关掉 Auto——
    // 权威读面立刻变成 false，动作在真正调用宿主 close 之前作废，并归还它这一次预支。
    fixture.switchRoot("root-b", { children: [] });
    fixture.switchRoot("root-a");
    fixture.autoOpenState.value = false;
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, [], "动作在副作用之前被取消：绝不允许发出 close");

    // 重新打开 Auto：预支已经被归还，这个 tab 仍然拿到完整的 3 次重试（绝不是只剩 2 次）。
    fixture.autoOpenState.value = true;
    await fixture.sync(8);
    assert.equal(
      fixture.closes.filter((tabId) => tabId === autoTabId).length,
      3,
      "被取消的那次预支必须归还：重试预算仍是完整的 3 次，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [autoTabId],
      "宿主持续拒绝时 tab 必须原样留在 inventory 里",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * Auto 关闭契约的公共前置：Auto 打开 child-a 的侧栏 tab，再把 child-a 变成空闲。
 *
 * 返回宿主分配的精确 tabId。空闲之后至少要再跑两轮 sync：第一轮把 status=ready 的新快照拉回来，
 * 之后才会进入关闭候选。
 */
async function prepareAutoCloseIdle(fixture) {
  await fixture.sync();
  assert.equal(fixture.resources.length, 1, "运行中的 child-a 必须先被 Auto 打开");
  const tabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
  assert.ok(tabId, "Auto 打开的 tab 必须先落进宿主 inventory");
  fixture.children[0].status = "ready";
  return tabId;
}

test("Auto 契约：宿主 close 静默 no-op（resolve 但 tab 仍在）绝不清理归属，验证失败后仍会重试", async () => {
  /**
   * 宿主 closeIn 在 actions / surface 缺失、tab 不存在或 canCloseTab=false 时会静默 no-op 并 resolve：
   * **resolve 只代表请求完成，绝不代表 tab 已经关闭**。旧实现把它当成关闭成功，于是删除 record/origin，
   * 结果 tab 仍然开着却永久失去 Auto 归属（这正是「偶尔漏收」的根因之一）。
   */
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return undefined; },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须为已经空闲的资源发出一次关闭请求");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "close resolve 但 inventory 仍 present：绝不能撤销 Auto 归属（箭头必须仍是 <<）",
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "宿主没有真的关闭它，tab 必须仍在 inventory");

    // 验证窗口（10 秒）过期后仍然 present：后续同步必须继续重试，而不是永久失去归属。
    await fixture.advanceClock(10000);
    await fixture.sync(4);
    assert.ok(
      fixture.closes.length >= 2,
      "验证失败后必须继续重试关闭，实际 " + JSON.stringify(fixture.closes),
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "重试期间 Auto 归属必须一直保留");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：close resolve 后只有连续两次采样都 absent 才收口，且全程只 close 一次", async () => {
  /** 宿主侧「请求已 resolve、但真正移除晚一点发生」的真实形状：验证链必须等 inventory 的精确证据。 */
  const pendingCloses = [];
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      pendingCloses.push({ tabId, applyClose });
      return undefined;
    },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须先发出一次关闭请求");
    assert.equal(pendingCloses.length, 1, "本场景必须真实产生一次关闭请求");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "宿主还没真的移除：tab 必须仍在 inventory");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "未验证关闭前必须保留 Auto 归属");
    assert.deepEqual(fixture.closes, [tabId], "验证窗口内绝不允许重复 close");
    // 宿主此刻真的移除 tab：再采样两次（SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS）才允许收口。
    pendingCloses[0].applyClose();
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "验证期间绝不允许重复 close");
    assert.deepEqual(fixture.inventory, [], "tab 必须离开宿主 inventory");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "验证完成后箭头必须复位");
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [tabId], "收口之后绝不允许再发出 close");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：resolve 后 tab 仍 present 时按三次上限进入冷却，冷却期间零次 close、到期后允许一次", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return undefined; },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "第一次真实 close 必须发出");
    // 验证窗口是 10 秒（四次 2.5 秒轮询）：按真实轮询节奏推进，三次之后进入冷却。
    for (let round = 0; round < 40 && fixture.closes.length < 3; round += 1) {
      await fixture.advanceClock(2500);
      await fixture.sync(1);
    }
    assert.equal(fixture.closes.length, 3, "快速预算最多 3 次真实 close，实际 " + JSON.stringify(fixture.closes));
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "进入冷却后 origin 与 record 都必须保留");
    // 第 3 次 close 的验证窗口过期：这一轮进入 60 秒冷却。
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    assert.equal(fixture.closes.length, 3, "进入冷却的那一轮绝不允许再发 close");
    // 冷却期内 59 秒：零次 close；跨过 60 秒后允许一次新的真实 close。
    await fixture.advanceClock(59000);
    await fixture.sync(4);
    assert.equal(fixture.closes.length, 3, "冷却期内绝不允许任何新的 close，实际 " + JSON.stringify(fixture.closes));
    await fixture.advanceClock(2000);
    await fixture.sync(4);
    assert.equal(fixture.closes.length, 4, "冷却到期后必须允许一次新的真实 close，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：inventory 不可读时 fail-closed——不发 close、不清理 origin，也绝不把 unreadable 当 absent", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    fixture.setInventoryUnreadable(true);
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [], "inventory 不可读时绝不允许发出 close");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "unreadable 绝不能当成 absent：Auto 归属必须原样保留",
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "tab 必须原样留在宿主里");
    fixture.setInventoryUnreadable(false);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "读面恢复后必须照常关闭");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：close 永不 settle 时 watchdog 必须恢复 busy 与 pending，后续候选照常推进", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab(tabId, applyClose) {
      // tab-1 的 close 永不 settle（宿主 Promise 不可取消）；tab-2 照常立即成功。
      if (tabId === "tab-1") return new Promise(() => {});
      return applyClose();
    },
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");
    for (const child of fixture.children) child.status = "ready";
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, ["tab-1"], "第一个候选的 close 必须已经发出并停在永不结算的 Promise 里");
    // 10 秒 watchdog：超时后 Auto 的 busy 闸门与 pending 锁都必须恢复，下一个候选照常推进。
    await fixture.advanceClock(10000);
    await fixture.sync(6);
    assert.ok(
      fixture.closes.includes("tab-2"),
      "watchdog 超时后必须能继续处理其它候选，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-1"], "tab-2 必须真的被关掉，tab-1 原样保留");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：手动关闭永不 settle 时批量等待必须在 watchdog 后让位并继续处理其它 key", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab(tabId, applyClose) {
      if (tabId === "tab-1") return new Promise(() => {});
      return applyClose();
    },
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");
    // 用户手动关闭 child-a 的 tab：这次 close 永不 settle，租约被它一直持有。
    void fixture.arrowOf("子代理 child-a").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, ["tab-1"], "手动关闭必须先发出一次 close");
    const batch = fixture.batchButton();
    assert.ok(batch, "运行中的资源必须渲染批量关闭按钮");
    void batch.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, ["tab-1"], "批量必须先停在第一个候选的等待里，绝不盲发第二次 close");
    // 同一个 10 秒上限：等待超时后让位，并继续处理其它 key（绝不无限 await）。
    await fixture.advanceClock(10000);
    assert.deepEqual(
      fixture.closes,
      ["tab-1", "tab-2"],
      "watchdog 超时后批量必须继续关闭其它候选，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), ["tab-1"], "tab-2 必须真的被关掉");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：watchdog 超时后迟到的 settle 绝不能释放后来者的租约或清理归属", async () => {
  let settleFirst = null;
  let closeCalls = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() {
      closeCalls += 1;
      if (closeCalls === 1) {
        // 第一次 close：静默 no-op（不移除 tab），并停在宿主 pending Promise 里等待用例放行。
        return new Promise((resolve) => { settleFirst = () => resolve(); });
      }
      // 重试同样停在 pending 里：用来证明迟到结果不会释放后来者的租约。
      return new Promise(() => {});
    },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须发出一次关闭请求");
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [tabId], "watchdog 超时后的隔离窗内绝不允许重复 close");
    // 迟到 settle：旧 Promise 在超时之后才 resolve，只能作用于仍匹配的旧租约。
    assert.equal(typeof settleFirst, "function", "本场景必须真实产生一次在途关闭");
    settleFirst();
    await fixture.handle.settle();
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "迟到 settle 绝不允许清理 Auto 归属");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "tab 必须原样留在 inventory");
    // 隔离窗跨过一次 2.5 秒采样之后才允许重试；重试仍在途时绝不允许第三次 close。
    await fixture.advanceClock(4000);
    await fixture.sync(6);
    assert.equal(fixture.closes.length, 2, "隔离窗结束后必须重试一次，实际 " + JSON.stringify(fixture.closes));
    await fixture.sync(6);
    assert.equal(fixture.closes.length, 2, "重试在途时绝不允许第三次 close（后来者的租约不得被迟到结果释放）");
    /**
     * 迟到 settle 同样不得释放后来者的**预算与冷却**（不只是租约）。
     *
     * 先把三次快速预算推满（每次 close 都永不结算），让这个 key 进入冷却慢车道，量出「冷却期内
     * 零次 close」的基线；再把最早那次 Promise 的迟到 resolve 放进来——它只能作用于它自己那次旧
     * 调用，绝不允许清掉后来者的 owner/预算/冷却，也绝不允许清理 Auto 归属。
     */
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    for (let round = 0; round < 40 && fixture.closes.length < 3; round += 1) {
      await fixture.advanceClock(2500);
      await fixture.sync(1);
    }
    assert.equal(fixture.closes.length, 3, "三次快速预算必须全部用尽，实际 " + JSON.stringify(fixture.closes));
    // 第三次 close 的 watchdog 与迟到隔离窗依次走完 → 预算用尽，进入冷却（record / origin 保留）。
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    await fixture.advanceClock(4000);
    await fixture.sync(4);
    const baseline = fixture.closes.length;
    assert.equal(baseline, 3, "冷却入口绝不允许再发 close，实际 " + JSON.stringify(fixture.closes));
    await fixture.advanceClock(59000);
    await fixture.sync(6);
    assert.equal(fixture.closes.length, baseline, "冷却期内必须零次 close（基线），实际 " + JSON.stringify(fixture.closes));
    // 迟到 settle：跨过 watchdog、隔离窗与冷却入口之后才 resolve 的那一次旧调用。
    settleFirst();
    await fixture.handle.settle();
    await fixture.sync(6);
    assert.equal(
      fixture.closes.length,
      baseline,
      "迟到 settle 绝不允许放出新的 close（后来者的租约、预算与冷却不得被它释放），实际 " + JSON.stringify(fixture.closes),
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "迟到 settle 绝不允许清理 Auto 归属");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "tab 必须原样留在 inventory");
  } finally {
    fixture.dispose();
  }
});

/**
 * 地址复用（tabId 回收）的契约：宿主把已经释放的 tabId 分给**另一个资源**之后，任何一次重试都
 * 不得再向这个 id 发出 close。
 *
 * 固定长度的迟到隔离窗只保证「窗口内不重叠」，它既挡不住宿主在窗口释放之后才落地的副作用，也不
 * 知道这个 id 现在承载的是谁。因此 close 之前必须证明「这个 tabId 此刻仍然是我们要关的那个资源」：
 * 在场（同 session + 子代理 kind + 精确 tabId）+ 条目暴露的资源地址与本次关闭那个 key 的地址一致。
 */
test("Auto 契约：隔离窗过期后旧 Promise 才 settle，且 tabId 已被另一个资源复用——绝不关闭被复用的新 tab", async () => {
  const FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";
  let releaseFirst = null;
  let closeCalls = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      closeCalls += 1;
      // 第一次 close：静默 no-op，停在宿主 pending Promise 里（tab 此刻仍在 inventory）。
      if (closeCalls === 1) return new Promise((resolve) => { releaseFirst = () => resolve(); });
      return applyClose();
    },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须先发出一次关闭请求并停在宿主 pending Promise 里");
    // 10 秒 watchdog 超时：租约进入 3 秒迟到隔离窗（这段时间里绝不允许重复 close）。
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [tabId], "隔离窗内绝不允许重复 close");
    // 宿主把刚刚释放的 tabId 复用给了另一个资源：同一个 id 现在承载别的地址，旧 tab 已经消失。
    assert.equal(fixture.recycleTabId(tabId, FOREIGN), true, "夹具必须真的把那一条 inventory 换成新地址");
    // 隔离窗过期：租约归还、重试被放行——这正是「更迟到的宿主副作用」与重试重叠的窗口。
    await fixture.advanceClock(4000);
    await fixture.sync(8);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "tabId 已被另一个资源复用：绝不允许再向这个 id 发出 close，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [tabId],
      "被复用的新 tab 必须原样留在宿主 inventory 里（绝不能被上一代的关闭意图关掉）",
    );
    assert.equal(fixture.inventory[0].contentId, FOREIGN, "复用的新 tab 必须仍属于它自己的资源");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "旧 tab 已经消失：这个 key 的记录与 Auto 归属必须按「旧 tab 已消失」收口（箭头复位）",
    );
    // 迟到的旧 Promise 现在才 settle：只能作用于它自己那次调用，绝不允许放出新的 close 或改回归属。
    assert.equal(typeof releaseFirst, "function", "本场景必须真实产生一次在途关闭");
    releaseFirst();
    await fixture.handle.settle();
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "迟到 settle 绝不允许产生新的 close，实际 " + JSON.stringify(fixture.closes),
    );
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "迟到 settle 绝不能把已经收口的归属改回来",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：隔离窗过期后重试已经在途、旧 Promise 随后才 settle——整体只关闭一次，不重复关闭同一 tab", async () => {
  let releaseFirst = null;
  let pendingRetry = null;
  let closeCalls = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      closeCalls += 1;
      if (closeCalls === 1) {
        // 第一次 close：永不结算（watchdog 超时）；宿主既没有移除 tab，也没有真正关闭它。
        return new Promise((resolve) => { releaseFirst = () => resolve(); });
      }
      // 重试：宿主已经 resolve（请求完成），但真正移除 tab 由用例稍后放行——验证链只认 inventory 证据。
      pendingRetry = { tabId, applyClose };
      return undefined;
    },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须先发出一次关闭请求");
    await fixture.advanceClock(10000);
    await fixture.sync(2);
    assert.deepEqual(fixture.closes, [tabId], "watchdog 超时后的隔离窗内绝不允许重复 close");
    // 隔离窗过期：重试被放行，停在「已 resolve、等待 inventory 验证」的验证窗口里。
    await fixture.advanceClock(4000);
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [tabId, tabId], "隔离窗结束后必须针对同一个精确 tabId 重试一次，实际 " + JSON.stringify(fixture.closes));
    assert.ok(pendingRetry !== null, "重试必须真的发出");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "重试未验证前必须保留 Auto 归属");
    // 第一个 Promise 现在才 settle（跨过 watchdog 与隔离窗）：它只作用于它自己那次旧调用。
    assert.equal(typeof releaseFirst, "function", "本场景必须真实产生一次在途关闭");
    releaseFirst();
    await fixture.handle.settle();
    await fixture.sync(6);
    assert.equal(
      fixture.closes.length,
      2,
      "旧 Promise 迟到 settle 之后绝不允许再多一次 close，实际 " + JSON.stringify(fixture.closes),
    );
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "旧 settle 绝不允许提前收口后来者这一次重试的归属",
    );
    // 宿主此刻真的移除这个 tab：验证链连续两次 absent 之后才收口——全程只有两次请求、一次有效关闭。
    pendingRetry.applyClose();
    await fixture.sync(6);
    assert.deepEqual(fixture.inventory, [], "重试关闭必须真的生效（tab 离开 inventory）");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "验证完成后箭头必须复位");
    await fixture.sync(8);
    assert.equal(fixture.closes.length, 2, "收口之后绝不允许再发出 close，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：close resolve 后宿主把 tabId 复用给另一个资源——按旧 tab 已消失收口，绝不重试关闭新 tab", async () => {
  const FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    // 宿主静默 no-op：close resolve 但 tab 仍在 → 进入验证窗口（租约保留、记录保留）。
    closeTab() { return undefined; },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "Auto 必须先发出一次关闭请求");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "未验证关闭前必须保留 Auto 归属");
    // 宿主把刚刚释放的 tabId 复用给了另一个资源：这个 id 已经不属于我们的 key。
    assert.equal(fixture.recycleTabId(tabId, FOREIGN), true, "夹具必须真的把那一条 inventory 换成新地址");
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "id 已经被别的资源复用：验证链绝不允许为它补发 close，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "被复用的新 tab 必须原样留在宿主 inventory 里");
    assert.equal(fixture.inventory[0].contentId, FOREIGN, "复用的新 tab 必须仍属于它自己的资源");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "旧 tab 已消失：这个 key 的记录、预算与归属必须按「旧 tab 已消失」收口（箭头复位）",
    );
    await fixture.sync(8);
    assert.deepEqual(fixture.closes, [tabId], "收口之后绝不允许再发出任何 close，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：连续三次真实失败后进入冷却——不再重试，且 origin 必须保留", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭")); },
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    await fixture.sync(10);
    assert.equal(fixture.closes.length, 3, "三次快速预算用尽后绝不允许第四次真实 close，实际 " + JSON.stringify(fixture.closes));
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "进入冷却后 origin 与 record 都必须保留（旧实现在这里删掉归属，tab 因此永久漏收）",
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [tabId], "宿主持续失败时 tab 必须原样留在 inventory");
    await fixture.sync(10);
    assert.equal(fixture.closes.length, 3, "冷却期内后续同步同样零次 close，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：冷却 59 秒内零次 close，跨过 60 秒后允许新的真实 close", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭")); },
  });
  try {
    await prepareAutoCloseIdle(fixture);
    await fixture.sync(10);
    assert.equal(fixture.closes.length, 3, "先耗尽三次快速预算并进入冷却");
    await fixture.advanceClock(59000);
    await fixture.sync(6);
    assert.equal(fixture.closes.length, 3, "冷却 59 秒内绝不允许任何新的 close，实际 " + JSON.stringify(fixture.closes));
    await fixture.advanceClock(2000);
    await fixture.sync(6);
    assert.ok(
      fixture.closes.length > 3,
      "跨过 60 秒后必须允许一次新的真实 close，实际 " + JSON.stringify(fixture.closes),
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：资源重新 running 清除失败预算与冷却，再次空闲后重新进入快速预算", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭")); },
  });
  try {
    await prepareAutoCloseIdle(fixture);
    await fixture.sync(10);
    assert.equal(fixture.closes.length, 3, "先耗尽三次快速预算并进入冷却");
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(fixture.closes.length, 3, "资源重新运行绝不允许产生新的 close");
    fixture.children[0].status = "ready";
    await fixture.sync(10);
    assert.equal(
      fixture.closes.length,
      6,
      "预算与冷却被清零后必须重新拿到完整的三次快速重试，实际 " + JSON.stringify(fixture.closes),
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：快照暂时缺地址时绝不清理 origin，冷却到期后仍能关闭", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭")); },
  });
  try {
    await prepareAutoCloseIdle(fixture);
    await fixture.sync(10);
    assert.equal(fixture.closes.length, 3, "先耗尽三次快速预算并进入冷却");
    // 资源从当前快照里暂时消失（record 与宿主 inventory 都还在）：绝不能因此删掉 origin。
    const removed = fixture.children.splice(0, fixture.children.length);
    await fixture.sync(6);
    assert.equal(fixture.closes.length, 3, "快照缺项期间不得产生 close");
    for (const child of removed) fixture.children.push(child);
    await fixture.advanceClock(60000);
    await fixture.sync(6);
    assert.ok(
      fixture.closes.length > 3,
      "冷却到期后必须仍能关闭（origin 绝不能被快照缺项清理），实际 " + JSON.stringify(fixture.closes),
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：归属账本满 128 且全是活动条目时 fail-closed 拒绝新自动打开，且不淘汰活动条目", async () => {
  const children = Array.from({ length: 130 }, (_, index) => ({ id: "child-" + (index + 1), status: "running" }));
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children, inventoryReadCap: 20000 });
  try {
    await fixture.sync(4);
    const opened = fixture.inventory.filter((entry) => entry.kind === "subagentchat").length;
    assert.equal(
      opened,
      128,
      "归属账本最多容纳 128 个活动 Auto tab，第 129 个起必须 fail-closed 拒绝自动打开，实际 " + opened,
    );
    // 活动条目绝不被限容淘汰：第 1 个 child 仍然归 Auto 管（变成空闲后必须被自动关闭）。
    fixture.children[0].status = "ready";
    await fixture.sync(8);
    assert.ok(
      fixture.closes.includes("tab-1"),
      "第一个 Auto tab 绝不能被限容淘汰，实际 " + JSON.stringify(fixture.closes.slice(0, 6)),
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：插件账本重建（页面 reload）后，宿主里已存在的同地址 tab 按 manual 处理且绝不被自动关闭", async () => {
  const address = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({ autoOpen: true, children: [{ id: "child-a", status: "ready" }] });
  try {
    // 宿主在插件账本建立之前就已经有这个 tab（页面 reload：插件内存账本为空，宿主 inventory 保留）。
    const hostTabId = fixture.hostOpenTab(address);
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [], "账本重建后来源未知的既有 tab 绝不允许被自动关闭（残余风险 D）");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [hostTabId], "这个 tab 必须原样留在宿主里");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "既有 tab 必须被收养成 <<（manual 来源）");
    assert.deepEqual(fixture.openAttempts, [], "既有 tab 绝不允许触发重复打开");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约（生成 bundle 路径）：静默 no-op / 永不 settle / 冷却 / 地址复用四条契约在 client-bundle.js 上同样成立", async () => {
  // 1) 静默 no-op：resolve 但 tab 仍在 ⇒ 绝不清理归属，验证失败后继续重试。
  const silent = await installAutoSidebarHarness({
    bundleSource: "generated",
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return undefined; },
  });
  try {
    await prepareAutoCloseIdle(silent);
    await silent.sync(4);
    assert.deepEqual(silent.closes, ["tab-1"], "生成 bundle：必须为已经空闲的资源发出一次关闭请求");
    assert.equal(silent.arrowOf("子代理 child-a").props["data-open"], "true", "生成 bundle：resolve 但 tab 仍在时绝不清理归属");
    await silent.advanceClock(10000);
    await silent.sync(4);
    assert.ok(silent.closes.length >= 2, "生成 bundle：验证失败后必须继续重试，实际 " + JSON.stringify(silent.closes));
  } finally {
    silent.dispose();
  }

  // 2) 永不 settle：watchdog 必须恢复 busy 与 pending，后续候选照常推进。
  const stuck = await installAutoSidebarHarness({
    bundleSource: "generated",
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab(tabId, applyClose) {
      if (tabId === "tab-1") return new Promise(() => {});
      return applyClose();
    },
  });
  try {
    await stuck.sync(8);
    for (const child of stuck.children) child.status = "ready";
    await stuck.sync(6);
    assert.deepEqual(stuck.closes, ["tab-1"], "生成 bundle：第一个候选的 close 停在永不结算的 Promise 里");
    await stuck.advanceClock(10000);
    await stuck.sync(6);
    assert.ok(stuck.closes.includes("tab-2"), "生成 bundle：watchdog 超时后必须继续处理其它候选，实际 " + JSON.stringify(stuck.closes));
  } finally {
    stuck.dispose();
  }

  // 3) 冷却：三次真实失败后进入冷却，冷却期内零次 close。
  const cooled = await installAutoSidebarHarness({
    bundleSource: "generated",
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab() { return Promise.reject(new Error("宿主持续拒绝关闭")); },
  });
  try {
    await prepareAutoCloseIdle(cooled);
    await cooled.sync(10);
    assert.equal(cooled.closes.length, 3, "生成 bundle：三次快速预算用尽后不得再 close，实际 " + JSON.stringify(cooled.closes));
    assert.equal(cooled.arrowOf("子代理 child-a").props["data-open"], "true", "生成 bundle：冷却期必须保留 origin");
    await cooled.advanceClock(59000);
    await cooled.sync(6);
    assert.equal(cooled.closes.length, 3, "生成 bundle：冷却期内零次 close，实际 " + JSON.stringify(cooled.closes));
  } finally {
    cooled.dispose();
  }

  // 4) 地址复用：watchdog 超时 + 隔离窗过期之后 tabId 已被另一个资源复用 ⇒ 绝不补发 close。
  const FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";
  let firstCloseHangs = true;
  const reused = await installAutoSidebarHarness({
    bundleSource: "generated",
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    closeTab(tabId, applyClose) {
      // 第一次 close 停在宿主 pending Promise 里（watchdog 超时），之后一律照常关闭。
      if (firstCloseHangs === true) { firstCloseHangs = false; return new Promise(() => {}); }
      return applyClose();
    },
  });
  try {
    const tabId = await prepareAutoCloseIdle(reused);
    await reused.sync(4);
    assert.deepEqual(reused.closes, [tabId], "生成 bundle：Auto 必须先发出一次关闭请求");
    await reused.advanceClock(10000);
    await reused.sync(2);
    assert.equal(reused.recycleTabId(tabId, FOREIGN), true, "生成 bundle：夹具必须真的把那一条 inventory 换成新地址");
    await reused.advanceClock(4000);
    await reused.sync(8);
    assert.deepEqual(
      reused.closes,
      [tabId],
      "生成 bundle：tabId 已被另一个资源复用，绝不允许再补发 close，实际 " + JSON.stringify(reused.closes),
    );
    assert.deepEqual(reused.inventory.map((entry) => entry.tabId), [tabId], "生成 bundle：被复用的新 tab 必须原样留在宿主 inventory 里");
    assert.equal(reused.inventory[0].contentId, FOREIGN, "生成 bundle：复用的新 tab 必须仍属于它自己的资源");
    assert.equal(
      reused.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "生成 bundle：旧 tab 已消失必须按「旧 tab 已消失」收口这个 key 的归属（箭头复位）",
    );
  } finally {
    reused.dispose();
  }
});

test("Auto 契约：面板标题栏开关默认关闭、可访问，并把显式布尔交给写面", async () => {
  const written = [];
  const accepting = await installAutoSidebarHarness({
    autoOpen: false,
    children: [{ id: "child-a", status: "running" }],
    setAutoOpen: async (next) => { written.push(next); return true; },
  });
  try {
    const toggle = accepting.autoToggle();
    assert.ok(toggle.input, "面板标题栏必须渲染 Auto 开关");
    assert.ok(toggle.label, "Auto 开关必须使用面板既有的 header 控件容器");
    assert.equal(toggle.input.props.checked, false, "Auto 默认关闭（未开启时开关不勾选）");
    assert.equal(toggle.input.props.disabled, false, "存在写面时开关必须可交互");
    assert.equal(toggle.input.props["aria-label"], "Auto", "开关必须带可访问名称");
    const labelText = collectToggleText(toggle.label);
    assert.deepEqual(labelText, ["Auto"], "可见文案必须只有 Auto（不新增说明性长文案）");
    assert.equal(toggle.label.props.title, "自动打开运行中的子代理侧栏会话", "解释性文案只放在 title（悬浮提示）");
    toggle.input.props.onChange({ target: { checked: true } });
    await accepting.handle.settle();
    assert.deepEqual(written, [true], "点击 Auto 必须把显式布尔交给写面");
    assert.equal(accepting.autoToggle().input.props.checked, true, "本地乐观态必须立刻反映用户意图");
  } finally {
    accepting.dispose();
  }

  // 写面拒绝（只读文档/宿主校验失败）：开关必须回退到权威读面，绝不停在一个没生效的状态。
  const rejecting = await installAutoSidebarHarness({
    autoOpen: false,
    children: [{ id: "child-a", status: "running" }],
    setAutoOpen: async () => false,
  });
  try {
    rejecting.autoToggle().input.props.onChange({ target: { checked: true } });
    await rejecting.handle.settle();
    await rejecting.handle.settle();
    assert.equal(rejecting.autoToggle().input.props.checked, false, "写失败后开关必须回退到权威读面");
  } finally {
    rejecting.dispose();
  }

  // 写面缺失（直接 createExpertGroupPanel 的宿主/测试）：开关只读，绝不渲染一个点了没反应的控件。
  const readonly = await installAutoSidebarHarness({ autoOpen: false, children: [{ id: "child-a", status: "running" }] });
  try {
    assert.equal(readonly.autoToggle().input.props.disabled, true, "缺少写面时开关必须禁用");
  } finally {
    readonly.dispose();
  }
});


test("Auto 契约：直接 createExpertGroupPanel（无 install 依赖）缺少新依赖时按关闭处理", async () => {
  await import("../client-expert-group-model-normalize.js");
  await import("../client-expert-group-model-format.js");
  await import("../client-expert-group-model.js");
  const runtime = createClientReactRuntime();
  const intervals = createFakeIntervals();
  const restoreGlobals = installGlobals({
    window: { innerWidth: 1000 },
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  });
  const rightChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-right" }, children: [] });
  const leftChevron = (props) => ({ type: "svg", props: { ...(props || {}), "data-icon": "chevron-left" }, children: [] });
  const resources = [];
  const closes = [];
  const inventory = [];
  const hostSnapshot = {
    schemaVersion: 1,
    rootSessionId: "root-a",
    generatedAt: 1,
    root: {
      id: "root-a", kind: "root", sessionId: "root-a", taskName: "root-a",
      children: [{
        id: "child-a", kind: "expert", sessionId: "child-a", taskName: "子代理 A",
        role: "fixer", content: "任务 A", status: "running", continuable: true,
      }],
    },
  };
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: "root-a",
        byId: {
          "root-a": { id: "root-a", title: "root-a" },
          "child-a": { id: "child-a", parentId: "root-a", title: "子代理 A 会话" },
        },
        projectionsBySession: {},
      }),
    },
    subagentAddress: (childId) => (childId === "child-a"
      ? { parentSessionId: "root-a", childSessionId: "child-a", mode: "continuable" }
      : undefined),
  };
  const sidebarRight = {
    openTabs: { getSnapshot: () => inventory.slice() },
    active: () => undefined,
    openResource(address) {
      resources.push(address);
      inventory.push({ sessionId: "root-a", tabId: "tab-" + resources.length, kind: "subagentchat", contentId: address });
    },
    close(tabId) { closes.push(tabId); },
  };
  // 直接构造面板：config 自带 sidebarRight/sessions，没有 install 注入的 Auto 读面。
  const Panel = sidebar.createExpertGroupPanel({
    react: runtime.react,
    primitives: { ...primitives, IconChevronRightOutlineRegular: rightChevron, IconChevronLeftOutlineRegular: leftChevron },
    sessions,
    sidebarRight,
    resolveRootSessionId: (id) => id,
    requestPluginRpc: () => ({ ok: true, async json() { return { snapshot: hostSnapshot }; } }),
  });
  const handle = runtime.render(Panel, { scope: { sessionId: "root-a" }, ctx: {} });
  try {
    await handle.settle();
    await intervals.tick();
    await handle.settle();
    await intervals.tick();
    await handle.settle();
    assert.deepEqual(resources, [], "缺少 getAutoOpenSubagentSidebar 时绝不自动打开");
    assert.deepEqual(closes, [], "缺少依赖时绝不自动关闭");
    const all = [];
    const collect = (node) => {
      if (node === null || node === undefined || node === false) return;
      all.push(node);
      if (typeof node === "object") for (const child of node.children ?? []) collect(child);
    };
    collect(handle.output);
    const input = all.find((node) => node?.type === "input" && node?.props?.["aria-label"] === "Auto") ?? null;
    assert.ok(input, "面板标题栏必须渲染 Auto 开关");
    assert.equal(input.props.checked, false, "缺少读面时开关按关闭展示");
    assert.equal(input.props.disabled, true, "缺少写面时开关必须禁用（绝不渲染点了没反应的控件）");
  } finally {
    handle.unmount();
    restoreGlobals();
  }
});

/**
 * 候选选择阶段的「连续两次可读采样」确认语义（与记录同步器 / 关闭验证链同一条强度）。
 *
 * 宿主 inventory 在**一帧**里短暂缺项是正常抖动（布局换桶、面板重挂载、宿主提交窗口的中间态）。
 * 旧实现在候选阶段只采一次样就删掉 record / 来源 / 预算，tab 明明还在宿主里却永久失去 Auto 归属，
 * 资源结束后再也不会被自动收回——正是用户报的「偶尔漏收」。
 */
test("Auto 契约：候选采样单次缺项后立即恢复，绝不删除归属，且之后仍能正常收回", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    // 宿主 inventory 在这一轮里短暂缺项：只跑一轮同步（候选采样到一次 absent），随后立刻恢复。
    const entry = fixture.inventory[0];
    fixture.inventory.splice(0, fixture.inventory.length);
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "单次缺项绝不能删除 Auto 归属（旧实现只采一次样就收口，箭头会立刻复位）",
    );
    assert.deepEqual(fixture.closes, [], "缺项的那一轮绝不允许发出 close");
    // 宿主恢复：同一个 tabId 重新出现在 inventory 里，归属与预算必须原样还在。
    fixture.inventory.push(entry);
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "恢复之后必须照常收回这个 tab（旧实现已经把归属删了，这里会一次 close 都没有），实际 "
        + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory, [], "恢复之后这个 tab 必须被正常收回");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "收回后箭头必须复位");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：候选采样连续两次 absent 才收口（第一次只算待确认）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    // 宿主已经把 tab 收走（用户/宿主侧关闭），插件自己的记录还在。
    fixture.inventory.splice(0, fixture.inventory.length);
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "第一次缺项只能算一次待确认，必须保留 record / origin",
    );
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "连续两次可读采样都 absent 才允许收口归属（与既有 2 次确认语义一致）",
    );
    assert.deepEqual(fixture.closes, [], "tab 已经不在：绝不允许补发 close，实际 " + JSON.stringify(fixture.closes));
    await fixture.sync(3);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "收口之后归属必须保持复位");
    assert.deepEqual(fixture.closes, [], "收口之后同样绝不允许发出 close");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约：候选采样连续两次 recycled 才收口，且全程不对被复用的 id 发 close", async () => {
  const FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    // 宿主把这个 tabId 回收给另一个资源：旧 tab 已经消失、id 不再属于我们。
    assert.equal(fixture.recycleTabId(tabId, FOREIGN), true, "夹具必须真的把那一条 inventory 换成新地址");
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "第一次 recycled 只能算一次待确认，必须保留 record / origin / 预算 / 冷却",
    );
    assert.deepEqual(fixture.closes, [], "id 已被复用：不许发 close");
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "连续两次可读采样都 recycled 才允许按「旧 tab 已消失」收口",
    );
    assert.deepEqual(fixture.closes, [], "被复用的 id 绝不允许收到 close，实际 " + JSON.stringify(fixture.closes));
    assert.deepEqual(fixture.inventory.map((item) => item.tabId), [tabId], "被复用的新 tab 必须原样留在宿主 inventory 里");
    assert.equal(fixture.inventory[0].contentId, FOREIGN, "复用的新 tab 必须仍属于它自己的资源");
  } finally {
    fixture.dispose();
  }
});

test("批量关闭：候选生成之后 id 被宿主复用——绝不向该 id 发 close，其余候选照常处理", async () => {
  const FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");
    const batch = fixture.batchButton();
    assert.ok(batch, "运行中的资源必须渲染批量关闭按钮");
    assert.equal(batch.props["aria-label"], "在侧边栏关闭 2 个运行中的子代理");
    // 候选快照（tab-1 + 那时的资源地址）已经在渲染期固定下来；宿主此刻把 tab-1 回收给另一个资源。
    assert.equal(fixture.recycleTabId("tab-1", FOREIGN), true, "夹具必须真的把 tab-1 换成别的地址");
    void batch.props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    await fixture.sync(2);
    assert.deepEqual(
      fixture.closes,
      ["tab-2"],
      "被复用的 id 绝不允许再发 close，其余候选必须照常处理，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((item) => item.tabId), ["tab-1"], "被复用的新 tab 必须原样留在宿主里");
    assert.equal(fixture.inventory[0].contentId, FOREIGN, "复用的新 tab 必须仍属于它自己的资源");
  } finally {
    fixture.dispose();
  }
});

/**
 * 跨 key 交错的租约结算：A 的 verified-recycled 绝不能被 T 的等待者当成「我那个 tab 已经关掉」。
 *
 * 构造的是真实形状：宿主把已经释放的 tabId 复用给了另一个资源，而两个 key 的记录此刻都指向这个
 * 同一个 tabId（T 的记录是从复用后的 inventory 收养来的）。旧实现只读租约的布尔 ok，等待者直接
 * 返回 verified-closed，于是 T 既不再发自己的关闭（漏关），又顺手删掉了 T 的 record / origin。
 */
test("Auto 契约：等待者遇到 verified-recycled 必须用自己的地址复核——绝不冒领关闭，也绝不误删别的 key 的记录与归属", async () => {
  // 宿主把 child-a 释放的 tabId 直接分给了 child-b 的地址：同一个 id 此刻承载的是 child-b 的资源。
  const ADDRESS_B = "dsh-resource://subagentchat/session/child-b?parent=root-a&mode=continuable";
  let releaseFirst = null;
  let closeCalls = 0;
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }, { id: "child-b", status: "running" }],
    closeTab() {
      closeCalls += 1;
      // 第一次关闭停在宿主 pending Promise 里（租约被它持有）；之后的请求一律静默 no-op。
      if (closeCalls === 1) return new Promise((resolve) => { releaseFirst = () => resolve(); });
      return undefined;
    },
  });
  try {
    await fixture.sync(8);
    assert.equal(fixture.resources.length, 2, "两个运行中的子代理都必须被 Auto 打开");
    const tabIdA = fixture.inventory.find((entry) => String(entry.contentId ?? "").includes("child-a"))?.tabId;
    assert.equal(tabIdA, "tab-1", "child-a 的 Auto tab 必须先落进宿主 inventory");
    // 1) 用户手动关闭 child-a：这次 close 停在宿主 pending Promise 里，租约一直被它持有。
    void fixture.arrowOf("子代理 child-a").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, [tabIdA], "手动关闭必须先发出一次 close");
    assert.equal(typeof releaseFirst, "function", "本场景必须真实产生一次在途关闭");
    // 2) 宿主把刚释放的 tabId 复用给了另一个资源：这个 id 此刻承载 child-b 的地址。
    assert.equal(fixture.recycleTabId(tabIdA, ADDRESS_B), true, "夹具必须真的把那一条 inventory 换成新地址");
    // 3) 面板重挂载：新实例从当前 inventory 收养 child-b 的记录，命中的正是这个被复用的 tabId；
    //    来源仍取自共享账本（Auto 亲手打开过 child-b），因此两份 key 的记录此刻都指向同一个 id。
    await fixture.remount();
    assert.equal(
      fixture.arrowOf("子代理 child-b").props["data-open"],
      "true",
      "child-b 必须从复用后的 inventory 收养到记录（同一个 tabId、自己的地址）",
    );
    // 4) 用户关闭 child-b：lease 仍被 A 的那次关闭持有 → 必须等待它结算。
    void fixture.arrowOf("子代理 child-b").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.deepEqual(fixture.closes, [tabIdA], "等待期间绝不允许为 child-b 并发发出第二次 close");
    // 5) A 的那次关闭结算：preflight 用 A 自己的地址复核 → recycled（这个 id 已经换成 child-b 的地址）。
    releaseFirst();
    await fixture.handle.settle();
    await fixture.sync(2);
    assert.equal(
      fixture.arrowOf("子代理 child-b").props["data-open"],
      "true",
      "child-b 的 record 绝不能被 A 的 recycled 结算误删（它的 tab 此刻仍然开着）",
    );
    const attempts = new Map();
    for (const item of fixture.closes) attempts.set(item, (attempts.get(item) ?? 0) + 1);
    assert.equal(
      attempts.get(tabIdA),
      2,
      "等待者必须用自己的地址复核后接管一次重试（旧实现把 recycled 当成自己的关闭完成，这里只有一次 close），实际 "
        + JSON.stringify(fixture.closes),
    );
    /**
     * 6) child-b 结束：它的 tab 此刻绑在**宿主回收过**的那个 tabId 上（tab-1），而共享来源账本里
     *    记的是 child-b 自己那次 Auto 打开落地时的 tab-2——绑定失配 ⇒ 按安全侧落 manual，绝不被
     *    自动关闭（宁可漏收一次，绝不误关一个无法与「用户新开的同地址 tab」区分的目标）。
     *
     *    这一轮真正要锁死的是：那次 recycled 结算**只**收口它自己那个 key，绝不顺手删掉 child-b
     *    的 record——所以这里同时断言新 tab 与它的 << 记录都还在。
     */
    fixture.children[1].status = "ready";
    await fixture.advanceClock(10000);
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [tabIdA, tabIdA],
      "child-b 的 tab 绑在宿主回收过的 id 上（账本绑定失配）⇒ 绝不允许被自动关闭，实际 close 序列 "
        + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.map((item) => item.tabId).sort(),
      [tabIdA, "tab-2"].sort(),
      "被复用 id 的 tab 与 child-a 原来的 tab 都必须原样留在宿主里（本夹具的 close 是静默 no-op）",
    );
    assert.equal(
      fixture.arrowOf("子代理 child-b").props["data-open"],
      "true",
      "child-b 的 record 绝不能被那次 recycled 结算删掉（<< 必须保持）",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * split 意图的世代闸门：旧 close 的收口只能取消**它自己出发时看到的那一份**意图。
 *
 * 复现窗口：第一次 split 的事务在 15 秒 deadline 才由宿主收口（客户端意图槽位仍留着那份旧意图），
 * 用户的关闭请求在 deadline 之前发出并捕获了它；tab 之后真的消失、面板重挂载，用户重新打开同一个
 * 资源产生了**新 generation** 的 split 事务。旧 close 的 verified 收口若只按 key 取消，掐掉的就是
 * 那次与它毫无关系的新打开（右栏回落、openResource 再也不发）。
 */
test("split 事务：旧 close 的收口绝不取消同 key 新 generation 的 split 意图", async () => {
  let expertGroupActive = false;
  const EXPERT_GROUP_TAB = { id: "tab-expert-group", kind: "expert-group", contentId: "expert-group", title: "expert group" };
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
    // 用户在第一次 split 之后把活跃 tab 切回 Expert Group 页：右侧组成证据因此重新成立。
    activeTabOf: (current) => (expertGroupActive === true ? EXPERT_GROUP_TAB : current),
    // 宿主静默 no-op：close resolve 但 tab 仍在 → 进入验证窗口。
    closeTab() { return undefined; },
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "Auto 的第一次 split 打开必须停在布局等待里");
    await fixture.flushLayout();
    await fixture.sync(2);
    assert.equal(fixture.resources.length, 1, "第一次 split 打开必须完成");
    const tabId = fixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.ok(tabId, "第一次打开必须落进宿主 inventory");
    // 1) 关闭请求在 split 事务 deadline（15 秒）之前发出：它捕获的是**旧 generation** 的意图令牌。
    await fixture.advanceClock(14000);
    await fixture.clickArrow("子代理 child-a");
    assert.deepEqual(fixture.closes, [tabId], "关闭请求必须真的发出（宿主静默 no-op → 进入验证窗口）");
    // 2) split 事务 deadline 到期：宿主收口了那次分栏事务，但客户端意图槽位仍留着旧意图。
    await fixture.advanceClock(1000);
    // 3) 旧 tab 真的消失、用户切回 Expert Group 页，宿主重挂载面板：新实例没有任何记录。
    expertGroupActive = true;
    fixture.inventory.splice(0, fixture.inventory.length, { sessionId: "root-a", ...EXPERT_GROUP_TAB });
    await fixture.remount();
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "新实例没有记录：箭头必须是 >>（随后的一次点击才是新的打开）",
    );
    // 4) 用户重新打开同一个资源：新 generation 的 split 事务此刻在途，停在布局等待里。
    void fixture.arrowOf("子代理 child-a").props.onClick({ preventDefault() {}, stopPropagation() {} });
    await fixture.handle.settle();
    assert.equal(fixture.layoutWaits(), 1, "新 generation 的打开必须真的开始了一次 split 事务");
    // 5) 旧 close 的 verified 收口在这一轮同步里发生：绝不能把新 generation 的 split 意图取消掉。
    await fixture.sync(2);
    await fixture.flushLayout();
    await fixture.sync(2);
    assert.equal(
      fixture.resources.length,
      2,
      "旧 close 的收口绝不能取消同 key 新 generation 的 split/open 事务（新打开必须真的发出），实际 open 次数 "
        + fixture.resources.length,
    );
    assert.equal(fixture.openAttempts.length, 2, "新打开必须真的调用 openResource 一次");
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "新打开落地之后箭头必须回到 <<",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * contentId 缺失 ⇒ fail-open 判 present（行为锁定）。
 *
 * 这是本轮**刻意保留**的取舍：宿主 inventory 条目结构性缺 contentId 时，地址判据无法证伪。
 * 若在这种情况下判 recycled，本插件的每一次关闭都会在 preflight 被拦下——一个 tab 也关不掉，
 * 用户看到的是永久漏收。残余风险（tabId 复用无法识别）已写在 sidebarTabPresenceInInventory 的注释里。
 */
test("Auto 契约：inventory 条目缺 contentId 时 fail-open 判 present——照常关闭（行为锁定）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await prepareAutoCloseIdle(fixture);
    // 条目不再暴露 contentId：地址判据不可证伪 → 必须退回 present（fail-open），绝不判 recycled。
    delete fixture.inventory[0].contentId;
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "缺 contentId 必须 fail-open 判 present 并照常发出 close，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory, [], "tab 必须被正常关闭（绝不因为缺地址就永久不关）");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "关闭收口后箭头必须复位");
  } finally {
    fixture.dispose();
  }
});

/** 标题栏 Auto label 的可见文本（只取字符串子节点，忽略 input/span 结构）。 */
function collectToggleText(node, result = []) {
  if (node === null || node === undefined || node === false) return result;
  if (typeof node === "string") {
    result.push(node);
    return result;
  }
  if (typeof node !== "object") return result;
  for (const child of node.children ?? []) collectToggleText(child, result);
  return result;
}
/* ------------------------------------------------------------------------------------------------ *
 * 共享 Auto 账本跨 bundle 重新执行（HMR）+ 持久归属标记（跨整页刷新）
 * ------------------------------------------------------------------------------------------------ */

/** realm 级共享账本 / 归属索引槽位（与插件实现一致；夹具用它做隔离与「整页刷新」模拟）。 */
const SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/sidebar#shared-auto-ledger");
const SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL = Symbol.for("dsh-expert-group/sidebar#auto-ownership-memory");
const SIDEBAR_AUTO_OWNERSHIP_KEY = "dsh-expert-group:auto-ownership:v1";
const SIDEBAR_AUTO_DIAG_KEY = "dsh-expert-group:auto-diag:v1";
const SIDEBAR_AUTO_OWNERSHIP_LIMIT = 128;
const SIDEBAR_AUTO_DIAG_LIMIT = 60;
/**
 * 打开占位的存活上限（与插件实现一致）：对齐 opening 的等待窗口（SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS，
 * 15 秒）；别的 scope 的占位用 4 倍期限回收。两者都是「Auto 打开已经发出、tabId 始终没落地」的收口参数。
 */
const SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS = 15000;
const SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS = SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS;
const SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS = 4 * SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS;
/** 插件的 Auto 记账上限（SIDEBAR_AUTO_KEY_LIMIT）：归属 / 预算 / 候选采样计数共用同一个值。 */
const SIDEBAR_AUTO_KEY_LIMIT = 128;
/** 插件复合键的分隔符（SIDEBAR_TAB_KEY_SEPARATOR）：键 = session + 分隔符 + root + 分隔符 + 地址。 */
const SIDEBAR_TAB_KEY_SEPARATOR = "\u0000";

/** 当前 realm 的共享 Auto 账本（源模块装载路径下它就在宿主 globalThis 的槽位上）。 */
function sharedAutoLedgerOf() {
  return globalThis[SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL] ?? null;
}

/** 与插件同构的复合键（候选采样计数的键与打开记录的键完全同构）。 */
function autoKeyOf(address, sessionId = "root-a", rootId = "root-a") {
  return sessionId + SIDEBAR_TAB_KEY_SEPARATOR + rootId + SIDEBAR_TAB_KEY_SEPARATOR + address;
}

/**
 * 清掉 realm 级槽位（等价于一次全新 realm）。
 *
 * options.keepPersisted === true 时保留 localStorage 里的持久归属标记 / 诊断：那正是「整页刷新」
 * 的形状（内存全丢、localStorage 还在）。默认连 localStorage 一起清掉，保证用例之间互不污染。
 */
function resetSidebarRealmLedger(options = {}) {
  const host = options.host ?? globalThis;
  try { delete host[SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL]; } catch { /* 冻结时无处可删。 */ }
  try { delete host[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL]; } catch { /* 同上。 */ }
  if (options.keepPersisted !== true) {
    try { host.localStorage?.removeItem?.(SIDEBAR_AUTO_OWNERSHIP_KEY); } catch { /* 不可用即忽略。 */ }
    try { host.localStorage?.removeItem?.(SIDEBAR_AUTO_DIAG_KEY); } catch { /* 同上。 */ }
  }
}

/** 可控 localStorage 替身：可读回、可预置、可整体抛错（隐私模式 / 被拒）。 */
function createFakeLocalStorage(options = {}) {
  const store = new Map();
  const state = { throwOnAccess: options.throwOnAccess === true, writes: 0 };
  const guard = () => {
    if (state.throwOnAccess === true) throw new Error("localStorage 被拒绝");
  };
  return {
    state,
    getItem(key) { guard(); return store.has(String(key)) ? store.get(String(key)) : null; },
    setItem(key, value) { guard(); store.set(String(key), String(value)); state.writes += 1; },
    removeItem(key) { guard(); store.delete(String(key)); },
    seed(key, value) { store.set(String(key), String(value)); },
    read(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  };
}

/**
 * 读持久归属条目原文（含 tabId 与 reason）：找不到返回 null。
 *
 * tabId 是 P1-A 的绑定凭据（写入那一刻宿主 inventory 里这个地址的 tab），reason 用来区分
 * 「用户手动接管」与「陈旧 auto 被降级」两种 manual 来源。
 */
function readSidebarOwnershipEntry(storage, address, sessionId = "root-a", rootId = "root-a") {
  const raw = storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY);
  if (typeof raw !== "string" || raw.length === 0) return null;
  const list = JSON.parse(raw);
  if (Array.isArray(list) !== true) return null;
  const wanted = sessionId + "|" + rootId + "|" + address;
  return list.find((item) => item?.key === wanted) ?? null;
}

/** 读持久归属：返回 "auto" | "manual" | null（address 为资源地址，scope 固定为 root-a）。 */
function readSidebarOwnership(storage, address, sessionId = "root-a", rootId = "root-a") {
  const entry = readSidebarOwnershipEntry(storage, address, sessionId, rootId);
  return entry === null ? null : entry.origin;
}

/** 读诊断环形日志（解析失败一律当作空）。 */
function readSidebarAutoDiag(storage) {
  const raw = storage.read(SIDEBAR_AUTO_DIAG_KEY);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 收集 console 输出（断言 console.info 只在「复用非空账本」时出现一次）。 */
function createConsoleProbe() {
  const lines = [];
  const record = (level) => (...args) => { lines.push(level + " " + args.map((item) => String(item)).join(" ")); };
  return { lines, console: { log: record("log"), info: record("info"), warn: record("warn"), error: record("error") } };
}

/**
 * 「同一 realm 内可重复执行同一个侧栏脚本」的装载器：模拟 DSH 的 HMR。
 *
 * load() 建 realm 并执行一次；reload() 在同一 realm 里**再执行一次**（正是 ClientModuleSystem
 * 失效主插件模块后的行为）；reload({ freshRealm: true }) 换一个全新 realm（等价整页刷新），但
 * localStorage 替身按引用原样带过去——持久归属标记因此跨「刷新」存活。
 */
function createSidebarScriptProvider(scriptText, options = {}) {
  let realm = null;
  const createRealm = async () => {
    const vm = await import("node:vm");
    const loader = { load() {} };
    const sandbox = {
      console: options.console ?? console,
      window: { __ModuleLoader__: loader, innerWidth: 1000, localStorage: options.localStorage },
      __ModuleLoader__: loader,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      Date: globalThis.Date,
      MutationObserver: globalThis.MutationObserver,
      localStorage: options.localStorage,
    };
    if (options.freezeLedgerSlot === true) {
      // 冻结/不可读的 realm 槽位：插件必须捕获并退回「每次执行各自 new Map」，绝不抛错。
      Object.defineProperty(sandbox, SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL, {
        configurable: false,
        get() { throw new Error("realm 账本槽位不可读"); },
      });
    }
    Object.defineProperty(sandbox, "document", { configurable: true, get: () => globalThis.document });
    vm.createContext(sandbox);
    const execute = () => {
      vm.runInContext(scriptText, sandbox, { filename: options.filename ?? "deg-sidebar-script.js" });
      return vm.runInContext("globalThis[Symbol.for('dsh-expert-group/client-expert-group-sidebar')]", sandbox);
    };
    return { sandbox, execute };
  };
  return {
    async load() { realm = await createRealm(); return realm.execute(); },
    async reload(reloadOptions = {}) {
      if (reloadOptions.freshRealm === true) realm = await createRealm();
      return realm.execute();
    },
    get realm() { return realm; },
  };
}

/** 读两侧栏脚本原文：源码模块与发布物各跑一遍，保证两条装载路径都覆盖。 */
async function readSidebarScript(relativePath) {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

/**
 * HMR / 整页刷新场景一律执行**发布物** client-bundle.js。
 *
 * 原因：bundle 里装着侧栏模块与它的同族模块（装配期由 scripts/build.mjs 拼好），而单独的源码文件在
 * 隔离 realm 里跑起来缺少这些同族模块，插件取不到快照、也就不会自动打开——那既不是本用例要测的语义，
 * 也会把「bundle 重新执行」这一现场形状测偏。源码模块那条装载路径由下面几条 Node realm 夹具
 * （持久归属的写入 / 删除 / 上限）覆盖。
 */
const SIDEBAR_SCRIPT_SOURCES = [{ label: "生成 bundle", path: "../client-bundle.js" }];

const AUTO_LEDGER_TARGET_ADDRESS = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";
const AUTO_LEDGER_FOREIGN = "dsh-resource://subagentchat/session/child-foreign?parent=root-a&mode=continuable";

/** 打开一个 Auto tab 并返回它的 tabId（子代理 running）。 */
async function openAutoTabOnce(fixture, label = "") {
  await fixture.sync();
  assert.equal(fixture.resources.length, 1, (label.length > 0 ? label + "：" : "") + "运行中的 child-a 必须先被 Auto 打开");
  const tabId = fixture.inventory.find((entry) => entry?.kind === "subagentchat")?.tabId;
  assert.ok(tabId, "Auto 打开的 tab 必须先落进宿主 inventory");
  return tabId;
}

test("Auto 契约（HMR）：同一 realm 重新执行 bundle 之后，已空闲的 Auto tab 仍必须被自动关闭", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const probe = createConsoleProbe();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { console: probe.console });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      assert.equal(readSidebarOwnership(createFakeLocalStorage(), AUTO_LEDGER_TARGET_ADDRESS), null, "无 localStorage 时归属标记只落在内存里");
      // 关掉 Auto 再把子代理变空闲：这一步刻意不让它收口（模拟「tab 已经打开、资源随后空闲」）。
      fixture.autoOpenState.value = false;
      fixture.children[0].status = "ready";
      await fixture.sync(2);
      assert.deepEqual(fixture.closes, [], source.label + "：Auto 关闭时绝不自动关闭");
      // 模拟 HMR：同一个 realm 里重新执行整份脚本 + 宿主用新模块重新 install / 重挂载。
      await fixture.hotReloadSidebar();
      fixture.autoOpenState.value = true;
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：重新执行之后共享账本必须仍然认得这个 tab 是 Auto 打开的，已空闲时必须收口，实际 "
          + JSON.stringify(fixture.closes),
      );
      assert.ok(
        probe.lines.some((line) => line.startsWith("info ") && line.includes("共享 Auto 账本")),
        source.label + "：复用非空账本时必须输出一行 console.info，实际 " + JSON.stringify(probe.lines),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（HMR）：重新执行发生在子代理仍在运行时，结束后同样必须被自动关闭", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), {});
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      // 现场时序：构建（HMR）发生在子代理仍在运行时。
      await fixture.hotReloadSidebar();
      assert.deepEqual(fixture.closes, [], source.label + "：资源仍在运行，重新执行本身不得产生任何关闭");
      fixture.children[0].status = "ready";
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：重新执行之后归属仍是 auto，资源结束后必须被自动关闭，实际 " + JSON.stringify(fixture.closes),
      );
      assert.deepEqual(fixture.inventory.filter((entry) => entry?.kind === "subagentchat"), [], source.label + "：tab 必须被真的关掉");
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（HMR）：realm 槽位不可写或被冻结时退回旧行为，绝不抛错", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), {
      localStorage: storage,
      freezeLedgerSlot: true,
    });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      const firstInstall = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "install");
      assert.ok(firstInstall.length >= 1, source.label + "：装载必须留下安装诊断");
      assert.equal(firstInstall[0].degraded, true, source.label + "：槽位不可写必须记 degraded=true");
      fixture.autoOpenState.value = false;
      fixture.children[0].status = "ready";
      await fixture.sync(2);
      // 重新执行 + 重新装载：槽位不可写 ⇒ realm 级账本退回「每次执行各自 new Map」的旧行为。
      await fixture.hotReloadSidebar();
      const installDiag = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "install");
      const secondInstall = installDiag[installDiag.length - 1];
      assert.equal(secondInstall.degraded, true, source.label + "：降级在重新装载时同样必须被记录");
      assert.equal(secondInstall.reused, undefined, source.label + "：降级时绝不允许声明「复用既有账本」");
      assert.deepEqual(
        secondInstall.sizes,
        { origin: 0, suppressed: 0, closeAttempts: 0, closeAttemptOwners: 0, closeVerifications: 0, closeCooldowns: 0, tabMisses: 0, tabCloseInFlight: 0 },
        source.label + "：降级之后必须是全新的空账本（不再共享）",
      );
      // 持久归属层仍然有效（那是另一层证据）：刷新/重新执行之后该 tab 依旧按 auto 收口。
      fixture.autoOpenState.value = true;
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：realm 账本降级不影响持久归属层，已空闲的 Auto tab 仍必须被收口，实际 " + JSON.stringify(fixture.closes),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：整页刷新（换 realm、保留 localStorage）后仍按 auto 收口", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { localStorage: storage });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "auto",
        source.label + "：DEG 自己打开成功之后必须写入 auto 归属标记",
      );
      fixture.autoOpenState.value = false;
      fixture.children[0].status = "ready";
      await fixture.sync(2);
      // 整页刷新：新的 realm（内存账本全丢）+ 同一份 localStorage + 重新 install。
      resetSidebarRealmLedger({ keepPersisted: true });
      await fixture.hotReloadSidebar({ freshRealm: true });
      fixture.autoOpenState.value = true;
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：整页刷新之后持久 auto 标记必须让 Auto 继续认领这个 tab 并收口，实际 "
          + JSON.stringify(fixture.closes),
      );
      const diag = readSidebarAutoDiag(storage);
      assert.ok(diag.some((entry) => entry.kind === "install"), source.label + "：诊断里必须能读到安装记录");
      assert.ok(diag.some((entry) => entry.kind === "decision"), source.label + "：诊断里必须能读到自动决策记录");
      assert.ok(diag.length <= SIDEBAR_AUTO_DIAG_LIMIT, source.label + "：诊断条数必须有界，实际 " + diag.length);
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：手动操作改写为 manual，刷新后绝不再自动关闭", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { localStorage: storage });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
      // 宿主静默 no-op：手动关闭请求会发出，但 tab 仍在（这样「刷新之后会不会被自动关闭」才可观察）。
      closeTab() { return undefined; },
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", source.label + "：自动打开先写 auto");
      // 用户手动关闭（点行尾箭头）：手动恒优先 ⇒ 立刻改写 manual。
      void fixture.arrowOf("子代理 child-a").props.onClick({ preventDefault() {}, stopPropagation() {} });
      await fixture.handle.settle();
      assert.deepEqual(fixture.closes, [tabId], source.label + "：手动关闭必须真的发出一次关闭请求");
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "manual",
        source.label + "：手动关闭必须把持久标记改写成 manual",
      );
      // 整页刷新（换 realm、保留 localStorage）：这个 tab 必须按 manual 收养，绝不自动关闭。
      resetSidebarRealmLedger({ keepPersisted: true });
      await fixture.hotReloadSidebar({ freshRealm: true });
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "manual",
        source.label + "：刷新之后持久标记必须仍是 manual",
      );
      fixture.children[0].status = "ready";
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：manual 标记的 tab 绝不允许被自动关闭（只有那次手动关闭），实际 " + JSON.stringify(fixture.closes),
      );
      assert.ok(
        fixture.inventory.some((entry) => entry?.tabId === tabId),
        source.label + "：manual 来源的 tab 必须原样留在宿主里",
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：验证关闭 / 内容消失后删除条目，重新运行后可重新打点", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "自动打开必须写 auto 标记");
    // 资源结束 ⇒ 关闭 + inventory 验证：验证关闭成功后条目必须被删除。
    fixture.children[0].status = "ready";
    await fixture.sync(8);
    assert.deepEqual(fixture.closes, [tabId], "资源结束后必须真的发出一次关闭");
    assert.equal(fixture.inventory.filter((entry) => entry?.kind === "subagentchat").length, 0, "tab 必须被真的关掉");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "验证关闭成功之后不得残留陈旧 auto 标记");
    // 资源重新 running ⇒ 条目清除 + 重新自动打开时重新写 auto。
    fixture.children[0].status = "running";
    await fixture.sync(6);
    const nextTabId = fixture.inventory.find((entry) => entry?.kind === "subagentchat")?.tabId;
    assert.ok(nextTabId, "资源重新运行必须被重新自动打开");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "重新自动打开必须重新写 auto 标记");
    // 地址被宿主复用（recycled）⇒ 收口时同样删除条目（子代理先变空闲，复用才进入关闭候选）。
    fixture.children[0].status = "ready";
    assert.equal(fixture.recycleTabId(nextTabId, AUTO_LEDGER_FOREIGN), true, "夹具必须真的把那一条 inventory 换成新地址");
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "recycled 收口之后必须删除持久条目");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约（持久归属）：上限 128 / TTL 生效，localStorage 抛错时静默降级", async () => {
  const storage = createFakeLocalStorage();
  const now = Date.now();
  const seeded = [];
  for (let index = 0; index < 200; index += 1) {
    seeded.push({
      key: "root-a|root-a|dsh-resource://subagentchat/session/seeded-" + index + "?parent=root-a&mode=continuable",
      origin: "auto",
      updatedAt: index === 0 ? now - 8 * 24 * 60 * 60 * 1000 : now - 1000,
      reason: "auto-open",
    });
  }
  storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(seeded));
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await openAutoTabOnce(fixture);
    const stored = JSON.parse(storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY));
    assert.ok(Array.isArray(stored), "归属标记必须以数组形式落盘");
    assert.ok(stored.length <= SIDEBAR_AUTO_OWNERSHIP_LIMIT, "上限 128 必须生效，实际 " + stored.length);
    assert.equal(
      stored.some((entry) => entry.key.indexOf("seeded-0?") >= 0),
      false,
      "TTL 过期条目必须被清掉",
    );
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "真实写入必须落在同一份索引里");
    // 诊断同样有界：预置超量条目之后一次真实写入必须收敛到上限内。
    storage.seed(SIDEBAR_AUTO_DIAG_KEY, JSON.stringify(new Array(200).fill({ t: 1, kind: "seed" })));
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    const diag = readSidebarAutoDiag(storage);
    assert.ok(diag.length <= SIDEBAR_AUTO_DIAG_LIMIT, "诊断条数必须有硬上限，实际 " + diag.length);
  } finally {
    fixture.dispose();
  }
  // localStorage 全抛错：静默降级为仅内存，功能（打开与关闭）逐字不变。
  const throwing = createFakeLocalStorage({ throwOnAccess: true });
  const degraded = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: throwing,
  });
  try {
    const tabId = await openAutoTabOnce(degraded);
    degraded.children[0].status = "ready";
    await degraded.sync(8);
    assert.deepEqual(degraded.closes, [tabId], "localStorage 抛错时自动关闭必须照常工作，实际 " + JSON.stringify(degraded.closes));
  } finally {
    degraded.dispose();
  }
});


/* ------------------------------------------------------------------------------------------------ *
 * 持久归属的 tabId 绑定（P1-A）、跨整页刷新的 manual 抑制（P1-B）与跨 scope 采样容量（P1-C）
 * ------------------------------------------------------------------------------------------------ */

test("Auto 契约（持久归属）：刷新后同地址被宿主换成新 tabId ⇒ 绝不按 auto 收养，也绝不被自动关闭", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { localStorage: storage });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
    });
    try {
      const autoTabId = await openAutoTabOnce(fixture, source.label);
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "auto",
        source.label + "：自动打开成功之后必须写入 auto 归属标记",
      );

      /**
       * 现场（P1-A）：旧的 Auto tab 被用户/宿主移除而插件**没有观察到**（Auto 关闭期间不发生任何
       * 自动收口），用户随后从 DSH 其它入口打开同一个地址 ⇒ 宿主 mint 出一个**新** tabId
       * （注意不是原 tabId：这正是「刷新后同 scope 同地址的新 tab」形状）。
       */
      fixture.autoOpenState.value = false;
      const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === autoTabId);
      assert.ok(staleIndex >= 0, source.label + "：Auto 打开的 tab 必须先在宿主 inventory 里");
      fixture.inventory.splice(staleIndex, 1);
      const newTabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
      assert.notEqual(newTabId, autoTabId, source.label + "：新 tab 必须是另一个 tabId");

      // 整页刷新：新 realm（内存账本全丢）+ 同一份 localStorage + 重新 install。资源此刻**仍在运行**。
      resetSidebarRealmLedger({ keepPersisted: true });
      await fixture.hotReloadSidebar({ freshRealm: true });
      fixture.autoOpenState.value = true;
      await fixture.sync(3);

      assert.deepEqual(
        fixture.closes,
        [],
        source.label + "：tabId 不符的陈旧 auto 绝不允许认领并关闭这个新 tab，实际 " + JSON.stringify(fixture.closes),
      );
      assert.deepEqual(
        fixture.inventory.map((entry) => entry.tabId),
        [newTabId],
        source.label + "：用户新开的 tab 必须原样留在右栏里",
      );
      assert.equal(
        fixture.arrowOf("子代理 child-a").props["data-open"],
        "true",
        source.label + "：新 tab 必须按 manual 兜底收养（<<），交给用户手动处理",
      );
      // 陈旧条目必须被改写成 manual 并绑定到当前 tab，避免它长期误导后续判断。
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "manual",
        source.label + "：陈旧 auto 必须被改写成 manual",
      );
      assert.equal(
        readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId,
        newTabId,
        source.label + "：改写之后的条目必须绑定当前 tab",
      );
      const ownershipDiag = readSidebarAutoDiag(storage)
        .filter((entry) => entry.kind === "ownership" && entry.event === "write");
      assert.ok(
        ownershipDiag.some((entry) => entry.reason === "manual-stale-auto"),
        source.label + "：降级必须留下 manual-stale-auto 诊断，实际 " + JSON.stringify(ownershipDiag),
      );
      /**
       * 资源随后 idle：这条已经按 manual 收养的记录绝不允许被 Auto 收回。
       * 旧行为下这里会真的关掉用户新开的那个 tab（陈旧 auto 仍然被当成归属证据）。
       */
      fixture.children[0].status = "ready";
      await fixture.sync(4);
      assert.deepEqual(
        fixture.closes,
        [],
        source.label + "：资源 idle 之后同样绝不允许关闭这个 tab，实际 " + JSON.stringify(fixture.closes),
      );
      assert.deepEqual(
        fixture.inventory.map((entry) => entry.tabId),
        [newTabId],
        source.label + "：用户新开的 tab 必须一直留在右栏里",
      );
      assert.equal(
        fixture.arrowOf("子代理 child-a").props["data-open"],
        "true",
        source.label + "：手动来源的记录必须保持 <<（交给用户手动处理）",
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：刷新后 tabId 未变 ⇒ 仍按 auto 收养（idle 观察不清 auto 标记），随后正常自动关闭", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { localStorage: storage });
    /** 宿主静默 no-op：先让 tab 留在右栏，才能观察「资源空闲之后 auto 标记还在不在」。 */
    let silentClose = true;
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
      closeTab(_tabId, applyClose) { return silentClose === true ? undefined : applyClose(); },
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      assert.equal(
        readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId,
        tabId,
        source.label + "：auto 条目必须记录写入时那个 tab 的 tabId（刷新后的比对依据）",
      );

      // 整页刷新：宿主从它自己的持久化布局里带回**同一批 tabId**——正常刷新场景必须恢复 auto。
      resetSidebarRealmLedger({ keepPersisted: true });
      await fixture.hotReloadSidebar({ freshRealm: true });
      fixture.children[0].status = "ready";
      await fixture.sync(2);

      assert.deepEqual(
        fixture.closes,
        [tabId],
        source.label + "：tabId 一致的持久 auto 必须被继续认领并发起关闭，实际 " + JSON.stringify(fixture.closes),
      );
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "auto",
        source.label + "：观察到资源空闲绝不允许清除 auto 标记（正在等待收口的归属必须保留）",
      );
      assert.equal(
        readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId,
        tabId,
        source.label + "：收养必须把当前 tabId 刷新回条目",
      );
      assert.equal(
        fixture.arrowOf("子代理 child-a").props["data-open"],
        "true",
        source.label + "：宿主静默 no-op 时 Auto 归属必须原样保留（<<）",
      );

      // 宿主恢复真实关闭：验证链连续两次确认 tab 离开 inventory 之后才收口归属。
      silentClose = false;
      await fixture.advanceClock(10000);
      await fixture.sync(8);
      assert.ok(
        fixture.closes.length >= 2,
        source.label + "：验证超时后必须用真实关闭重试，实际 " + JSON.stringify(fixture.closes),
      );
      assert.deepEqual(fixture.inventory.filter((entry) => entry.kind === "subagentchat"), [], source.label + "：已空闲的自动 tab 最终必须被真的关掉");
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        null,
        source.label + "：只有验证关闭之后才允许删除 auto 条目",
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：手动关闭 + 刷新 + 资源仍 running ⇒ 绝不重新自动打开", async () => {
  for (const source of SIDEBAR_SCRIPT_SOURCES) {
    const storage = createFakeLocalStorage();
    const provider = createSidebarScriptProvider(await readSidebarScript(source.path), { localStorage: storage });
    const fixture = await installAutoSidebarHarness({
      autoOpen: true,
      children: [{ id: "child-a", status: "running" }],
      sidebarModuleProvider: provider,
      localStorage: storage,
    });
    try {
      const tabId = await openAutoTabOnce(fixture, source.label);
      // 用户手动关闭这个（自动打开的）tab：宿主真的把它移除，资源**仍在运行**。
      await fixture.clickArrow("子代理 child-a");
      await fixture.sync(4);
      assert.deepEqual(fixture.closes, [tabId], source.label + "：手动关闭必须真的发出一次关闭请求");
      assert.equal(
        readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
        "manual",
        source.label + "：手动关闭必须把持久标记改写成 manual",
      );
      assert.equal(fixture.resources.length, 1, source.label + "：资源仍在运行，抑制生效，绝不立刻重开");

      // 整页刷新：内存抑制（realm Map）全丢，只剩持久 manual。
      resetSidebarRealmLedger({ keepPersisted: true });
      await fixture.hotReloadSidebar({ freshRealm: true });
      await fixture.sync(6);

      assert.equal(
        fixture.resources.length,
        1,
        source.label + "：资源仍 running 时，刷新后的持久 manual 必须继续抑制自动打开，实际 openResource "
          + fixture.resources.length + " 次",
      );
      assert.equal(fixture.openAttempts.length, 1, source.label + "：绝不发出第二次 openResource");
      assert.deepEqual(fixture.inventory.filter((entry) => entry.kind === "subagentchat"), [], source.label + "：用户关掉的 tab 绝不能被自动重开");
      const decisions = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "decision");
      assert.ok(
        decisions.some((entry) => entry.verdict === "skip" && entry.reason === "persisted-manual"),
        source.label + "：跳过必须留下 persisted-manual 决策诊断，实际 " + JSON.stringify(decisions),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test("Auto 契约（持久归属）：观察到资源 idle 后 manual 抑制被清除，资源再次 running 时仍能自动打开", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    // 用户手动关闭（宿主真的移除 tab）：内存抑制与持久 manual 同时落地，资源仍在运行。
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "手动关闭必须真的发出一次关闭请求");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "手动关闭必须写持久 manual");
    assert.equal(fixture.resources.length, 1, "资源仍在运行：抑制生效，绝不立刻重开");

    // 子代理真正结束（明确 idle）：manual 抑制必须被清除（内存 + 持久两层）。
    fixture.children[0].status = "ready";
    await fixture.sync(2);
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      null,
      "观察到资源 idle 之后 manual 抑制必须被清除",
    );
    assert.equal(fixture.resources.length, 1, "资源空闲本身绝不触发自动打开");
    const ownershipDiag = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "ownership");
    assert.ok(
      // 相位对账统一后，idle+absent 的删除理由从历史名 resource-idle 收敛为 new-run（下一个运行轮次
      // 即交回 Auto）；断言强度不变：仍要求这次清除留下可离线核对的删除证据。
      ownershipDiag.some((entry) => entry.event === "delete" && entry.reason === "new-run"),
      "空闲清点必须留下 new-run 诊断，实际 " + JSON.stringify(ownershipDiag),
    );

    // 同一次访问里资源再次运行：抑制已经清除，自动打开必须恢复正常。
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(
      fixture.resources.length,
      2,
      "manual 抑制清除之后，资源再次运行必须能正常自动打开，实际 " + fixture.resources.length + " 次",
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "重新自动打开必须回到 <<");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "重新自动打开必须重新写 auto");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约（轻量快照）：unknown 成员不被 manual 抑制清理放过（显示从宽、操作从严）", async () => {
  const storage = createFakeLocalStorage();
  // partialSnapshot:true + status=unknown 就是 Host 轻量快照的 evidenceFree 形状：
  // 该节点会**显示**在空闲分组里（修复 B 的显示从宽），但没有任何活动证据。
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "unknown" }],
    localStorage: storage,
    partialSnapshot: true,
  });
  try {
    // 先让资源处于运行态并自动打开，再由用户手动关闭，从而写下持久 manual。
    fixture.children[0].status = "running";
    const tabId = await openAutoTabOnce(fixture);
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "手动关闭必须真的发出一次关闭请求");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "手动关闭必须写持久 manual");

    // 回到轻量快照的 unknown 形状：它现在**进空闲分组显示**，但绝不能因此被当作「已明确空闲」
    // 而清掉 manual 抑制——状态无法证明时按 fail-closed 保留。
    fixture.children[0].status = "unknown";
    await fixture.sync(4);
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "manual",
      "unknown 成员不得被 manual 抑制清理放过（否则轻量快照会撤销用户的关闭意图）",
    );
    const ownershipDiag = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "ownership");
    assert.equal(
      ownershipDiag.some((entry) => entry.event === "delete" && entry.reason === "resource-idle"),
      false,
      "unknown 成员不得产生 resource-idle 清除记录，实际 " + JSON.stringify(ownershipDiag),
    );
    assert.equal(fixture.resources.length, 1, "抑制仍然生效：绝不因为轻量快照而重新打开");

    // 对照：同一节点在完整快照里变成 ready（有明确证据）后，抑制必须被正常清除（既有行为不变）。
    fixture.children[0].status = "ready";
    await fixture.sync(2);
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      null,
      "完整证据下仍必须按既有语义清除 manual 抑制",
    );
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约（跨 scope 容量）：别的 root 的大量候选采样绝不淘汰 / 重置本 root 待确认的收口计数", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    inventoryReadCap: 20000,
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    const ledger = sharedAutoLedgerOf();
    assert.ok(ledger !== null && ledger.tabMisses instanceof Map, "夹具必须能观察到 realm 共享账本的采样计数");
    const targetKey = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);

    // 1) A：宿主静默移除这个 tab（插件观察不到），资源随后 idle ⇒ 一次 absent 采样（计数 1，不达阈值）。
    const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === tabId);
    fixture.inventory.splice(staleIndex, 1);
    fixture.children[0].status = "ready";
    await fixture.sync(1);
    assert.equal(ledger.tabMisses.get(targetKey)?.misses, 1, "第一次采样只算待确认");
    assert.equal(ledger.tabMisses.get(targetKey)?.tabId, tabId, "采样计数必须绑定这个 tabId");
    assert.deepEqual(fixture.closes, [], "确认次数没数满之前绝不发 close");

    // 2) B：127 个真实 Auto-owned tab 全部被宿主静默移除 + 资源全部 idle ⇒ 一轮里各采样一次。
    const rootBChildren = Array.from({ length: 127 }, (_, index) => ({ id: "child-b-" + (index + 1), status: "running" }));
    fixture.switchRoot("root-b", { children: rootBChildren });
    await fixture.handle.settle();
    await fixture.sync(6);
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      127,
      "B 必须真的开出 127 个 Auto tab（加上 A 的那 1 个正好占满 128 上限），实际 "
        + fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
    );
    for (let index = fixture.inventory.length - 1; index >= 0; index -= 1) {
      if (fixture.inventory[index]?.kind === "subagentchat") fixture.inventory.splice(index, 1);
    }
    // 重新设置 root B 的专家树（switchRoot 会按新状态重建快照）：全部 ready ⇒ 全部成为 absent 候选。
    fixture.switchRoot("root-b", { children: rootBChildren.map((child) => ({ ...child, status: "ready" })) });
    await fixture.handle.settle();
    await fixture.sync(1);

    assert.equal(
      ledger.tabMisses.size,
      SIDEBAR_AUTO_KEY_LIMIT,
      "A 的 1 条 + B 的 127 条必须都在采样计数里（正好触到 128 上限），实际 " + ledger.tabMisses.size,
    );
    assert.equal(ledger.tabMisses.get(targetKey)?.misses, 1, "别的 scope 的海量采样绝不淘汰 / 重置本 root 的待确认计数");
    assert.deepEqual(fixture.closes, [], "B 的候选同样只算第一次确认，绝不提前关闭");

    // 3) 回到 A：目标 key 的第 2 次确认 ⇒ 按既有阈值（2 次）正常收口。
    fixture.switchRoot("root-a");
    await fixture.handle.settle();
    await fixture.sync(1);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "false",
      "第二次确认必须按 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS=2 正常收口（计数没有被别的 scope 打散）",
    );
    assert.equal(ledger.tabMisses.has(targetKey), false, "收口之后这个 key 的采样计数必须一并清理");
    assert.deepEqual(fixture.closes, [], "tab 已经不在宿主里，绝不补发 close");
  } finally {
    fixture.dispose();
  }
});

test("Auto 契约（跨 scope 容量）：超出上限时只淘汰最久没被采样的条目（LRU）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    const ledger = sharedAutoLedgerOf();
    assert.ok(ledger !== null && ledger.tabMisses instanceof Map, "夹具必须能观察到 realm 共享账本的采样计数");
    /**
     * 前置：账本里先有 128 条「历史遗留」采样条目。
     *
     * 插件与用例操作的是同一份 realm 共享账本（同一批 Map 对象），这里直接填充即模拟长生命周期里
     * 累积的其它 scope / 其它 surface 残留——也是限容淘汰真正会触发的唯一形状（一次真实采样只占一条）。
     */
    const staleKeys = Array.from({ length: SIDEBAR_AUTO_KEY_LIMIT }, (_, index) => autoKeyOf(
      "dsh-resource://subagentchat/session/seed-" + index,
      "seed",
      "seed",
    ));
    ledger.tabMisses.clear();
    for (const key of staleKeys) {
      ledger.tabMisses.set(key, { sessionId: "seed", rootSessionId: "seed", tabId: "seed-tab", misses: 1 });
    }
    assert.equal(ledger.tabMisses.size, SIDEBAR_AUTO_KEY_LIMIT, "前置：限容必须正好处在 128 上限");

    // 目标 key 采样一次：它被插到队尾（最近采样），因此超限淘汰必须落在队首的遗留条目上。
    const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === tabId);
    fixture.inventory.splice(staleIndex, 1);
    fixture.children[0].status = "ready";
    await fixture.sync(1);
    const targetKey = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);
    assert.equal(
      ledger.tabMisses.size,
      SIDEBAR_AUTO_KEY_LIMIT,
      "插入第 129 条之后必须立刻按上限收敛回 128，实际 " + ledger.tabMisses.size,
    );
    assert.equal(ledger.tabMisses.get(targetKey)?.misses, 1, "刚采样过的目标 key 绝不能被限容淘汰");
    assert.equal(ledger.tabMisses.has(staleKeys[0]), false, "被淘汰的必须是队首（最久没被采样）的那一条");
    assert.equal(ledger.tabMisses.has(staleKeys[1]), true, "其余遗留条目必须原样保留（只淘汰一条）");

    // 目标 key 的确认序列继续推进：第 2 次采样按既有阈值收口，证明计数没有被淘汰 / 清零。
    await fixture.sync(1);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "第二次确认必须正常收口");
    assert.equal(ledger.tabMisses.has(targetKey), false, "收口之后目标 key 的计数一并清理");
    assert.deepEqual(fixture.closes, [], "tab 已经不在宿主里，绝不补发 close");
  } finally {
    fixture.dispose();
  }
});


/* ------------------------------------------------------------------------------------------------ *
 * 同 realm 收养的 tabId 绑定（缺陷 1）与归属容量 fail-closed（缺陷 2）
 * ------------------------------------------------------------------------------------------------ */

/**
 * 缺陷 1：同 realm 重挂载 + 同地址新 tabId（用户新开）。
 *
 * 现场：旧 Auto tab 被用户/宿主移除而插件没有观察到任何收口（Auto 关闭期间不跑候选），用户随后从
 * DSH 其它入口打开同一个地址 ⇒ 宿主 mint 出一个新 tabId。同一个 realm 里再挂载一个新 Panel 实例时，
 * 旧实现只看「realm 共享来源账本里有没有这个 key」就按 auto 认领，资源随后 idle 就把用户新开的 tab
 * 自动关掉了。
 *
 * 定稿判据：共享账本的条目必须携带「Auto 落地那一刻亲眼看到的 tabId」，收养必须要求它与当前
 * inventory 证据逐字相等；不匹配（或条目没有 tabId）一律不算 auto 证据，按安全侧落 manual 并把
 * 那条改写 / 清理掉。
 */
test("Auto 契约（同 realm 重挂载）：同地址换成新 tabId（用户新开）⇒ 绝不按 auto 收养，也绝不被自动关闭", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const autoTabId = await openAutoTabOnce(fixture);
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "auto",
      "自动打开成功之后必须写入 auto 归属标记",
    );
    const ledger = sharedAutoLedgerOf();
    assert.ok(ledger !== null && ledger.origin instanceof Map, "夹具必须能观察到 realm 共享的来源账本");
    const targetKey = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);
    assert.equal(
      ledger.origin.get(targetKey)?.tabId,
      autoTabId,
      "共享来源账本必须携带 Auto 落地那一刻亲眼看到的 tabId（旧实现只存 session/root/地址）",
    );

    // Auto 关闭期间旧 tab 被移除（插件不跑任何收口），用户自己打开同一个地址。
    fixture.autoOpenState.value = false;
    const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === autoTabId);
    assert.ok(staleIndex >= 0, "Auto 打开的 tab 必须先在宿主 inventory 里");
    fixture.inventory.splice(staleIndex, 1);
    const userTabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    assert.notEqual(userTabId, autoTabId, "用户新开的 tab 必须是另一个 tabId");

    // 同一个 realm、同一个 install 闭包：宿主卸载旧 Panel、再用同一个已安装组件挂载新实例。
    await fixture.remount();
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "新实例必须从宿主 inventory 收养这条 tab（<<）",
    );
    assert.deepEqual(fixture.closes, [], "收养用户新开的 tab 绝不产生任何自动关闭");
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [userTabId],
      "用户新开的 tab 必须原样留在右栏里",
    );
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "manual",
      "tabId 对不上的陈旧 auto 必须被改写成 manual（持久条目）",
    );
    assert.equal(
      readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId,
      userTabId,
      "改写之后的条目必须绑定当前 tab",
    );
    /**
     * 降级理由必须落在「陈旧证据」那一族：两层证据（持久条目 + realm 共享账本）此刻都指向旧 tabId，
     * 判据里持久条目优先，因此这里通常是 manual-stale-auto；只有共享账本这一层失配时才是
     * manual-stale-origin（见下面那条不含 localStorage 的用例）。
     */
    assert.ok(
      ["manual-stale-auto", "manual-stale-origin"].includes(
        readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.reason,
      ),
      "降级理由必须是陈旧证据那一族，实际 " + readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.reason,
    );
    assert.equal(
      ledger.origin.has(targetKey),
      false,
      "tabId 对不上的共享账本条目必须就地清掉，绝不留在 realm 账本里长期误导下一次收养",
    );

    // 资源随后 idle：旧行为下这里会真的关掉用户新开的那个 tab（共享账本仍被当成归属证据）。
    fixture.autoOpenState.value = true;
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(
      fixture.closes,
      [],
      "资源 idle 之后同样绝不允许关闭这个 tab，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [userTabId],
      "用户新开的 tab 必须一直留在右栏里",
    );
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "manual 来源的记录必须保持 <<（交给用户手动处理）",
    );
  } finally {
    fixture.dispose();
  }
});

/** 缺陷 1 的不回归面：同 realm 重挂载 + 原 tabId 未变 ⇒ 绑定成立，仍按 auto 收回。 */
test("Auto 契约（同 realm 重挂载）：原 tabId 未变 ⇒ 仍按 auto 收养并在资源结束后收回（不回归）", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    const ledger = sharedAutoLedgerOf();
    assert.equal(
      ledger.origin.get(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS))?.tabId,
      tabId,
      "共享账本必须绑定 Auto 落地那一刻的 tabId",
    );
    // 宿主卸载旧 Panel 再挂新实例：宿主 inventory 原样保留这个 tab（同一个 tabId）。
    await fixture.remount();
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "重挂载后必须从宿主 inventory 恢复这条 tab 的打开态",
    );
    assert.equal(
      ledger.origin.get(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS))?.tabId,
      tabId,
      "tabId 逐字相等的合法恢复必须保留这条归属，绝不能被当成陈旧条目清掉",
    );
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "tabId 一致的共享归属必须继续被认领：资源结束后必须按这个 tabId 收回，实际 "
        + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [], "tab 必须被真的关掉");
  } finally {
    fixture.dispose();
  }
});

/**
 * 回归（渲染抖动 → 永久漏收）：右栏 tab 在一帧里没有渲染节点，绝不等于宿主里已经不存在。
 *
 * 旧实现只按 DOM 在场集合累计 misses，连续两次缺席就删除 Auto 记录；紧接的 autoCloseCandidate 又因
 * 「本实例没有记录」把共享 origin 与被持久化的 auto 归属一起抹掉。tab 仍留在宿主 inventory 里，
 * 之后既不会被自动关闭，也不会被重新自动打开（Auto 只对 inventory 里没有 tab 的资源发打开）——
 * 用户看到的就是「子代理结束了，Auto 的 tab 偶尔收不回去」，而且刷新也恢复不了。
 *
 * 定稿判据：记录丢失（DOM 抖动、Panel 重挂载、收养只成功一部分）只说明「本实例没有记录」，
 * 不说明归属失效。autoCloseCandidate 必须先用宿主 inventory 复核 origin 绑定的那个 tabId：
 * 仍是同一个 tab 就按证据重建记录，下一轮照常关闭；无法证明时才撤销归属。
 */
test("Auto 契约（渲染抖动）：DOM 暂时不渲染 Auto tab 后，资源结束仍必须自动收回", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    // 让这个 tab 不再是 active（activeTab 判据会替任何 active tab 兜底），并让它暂时离开 DOM 读面。
    fixture.hostOpenTab(AUTO_LEDGER_FOREIGN);
    fixture.hidePresenceTab(tabId);
    await fixture.sync(4);
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "渲染缺席不等于宿主里没有 tab：Auto 归属必须按 inventory 证据恢复，箭头保持 <<",
    );
    assert.ok(fixture.inventory.some((entry) => entry.tabId === tabId), "宿主 inventory 必须仍然有这个 tab");
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(
      fixture.closes,
      [tabId],
      "资源结束后必须按 inventory 里真实的 tabId 收回，实际 " + JSON.stringify(fixture.closes),
    );
    assert.deepEqual(
      fixture.inventory.map((entry) => entry.tabId),
      [fixture.inventory.find((entry) => entry.contentId === AUTO_LEDGER_FOREIGN)?.tabId].filter(Boolean),
      "只允许关掉 Auto 那个 tab，别的 tab 原样保留",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * 同一场景的「只有 realm 共享账本可用」变体（没有 localStorage：持久条目层整层缺席）。
 *
 * 这一条把共享账本的 tabId 闸门单独锁死：旧实现里它是这一形状下的唯一证据，而且只比对 key、
 * 不比对 tabId，因此同 realm 收养会把用户新开的同地址 tab 认成 Auto，资源 idle 时把它关掉。
 */
test("Auto 契约（同 realm 重挂载）：没有持久层时，共享账本的 tabId 闸门同样必须拦住同地址的新 tab", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const autoTabId = await openAutoTabOnce(fixture);
    const ledger = sharedAutoLedgerOf();
    const targetKey = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);
    assert.equal(ledger.origin.get(targetKey)?.tabId, autoTabId, "共享账本必须先绑定 Auto 落地时的 tabId");
    fixture.autoOpenState.value = false;
    const staleIndex = fixture.inventory.findIndex((entry) => entry.tabId === autoTabId);
    fixture.inventory.splice(staleIndex, 1);
    const userTabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.remount();
    assert.equal(ledger.origin.has(targetKey), false, "没有持久层时，tabId 对不上的共享条目同样必须被清掉");
    fixture.autoOpenState.value = true;
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "绝不按陈旧的共享条目关闭用户新开的 tab");
    assert.deepEqual(fixture.inventory.map((entry) => entry.tabId), [userTabId], "用户新开的 tab 必须原样保留");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "manual 兜底必须保持 <<");
  } finally {
    fixture.dispose();
  }
});
/**
 * 缺陷 2（跨 scope 容量）：B 跨 root 打开大量资源，绝不能淘汰 A 仍然有效的 owner。
 *
 * 旧实现用「活动感知淘汰」限容，而活动判定只看**当前 Panel 实例**的在途状态与**当前 scope**的
 * record：B scope 里 A 的条目天然「不活动」，于是 B 的第 128 次打开会把 A 的 owner 从 realm 账本里
 * 淘汰掉，持久表也用 LRU 淘汰 A 的条目。自动关闭只遍历那本账本，A 的 tab 从此永久漏收（刷新也
 * 不能恢复）。定稿判据：容量满时 fail-closed 拒绝新的自动打开，绝不淘汰任何仍有效的 owner。
 */
test("Auto 契约（跨 root 容量）：别的 root 打开 128 个资源绝不淘汰本 root 的 owner（内存与持久表都不许）", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
    inventoryReadCap: 20000,
  });
  try {
    const tabIdA = await openAutoTabOnce(fixture);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "A 的自动打开必须写入持久 auto 条目");
    const ledger = sharedAutoLedgerOf();
    const keyA = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);
    assert.equal(ledger.origin.get(keyA)?.tabId, tabIdA, "A 的共享条目必须绑定它自己的 tabId");

    // B（另一个 root / 另一个 sidebar session）有 128 个运行中的子代理。
    const rootBChildren = Array.from({ length: SIDEBAR_AUTO_KEY_LIMIT }, (_, index) => ({
      id: "child-b-" + (index + 1),
      status: "running",
    }));
    fixture.switchRoot("root-b", { children: rootBChildren });
    await fixture.handle.settle();
    await fixture.sync(8);

    const openedB = fixture.inventory.filter((entry) => entry.kind === "subagentchat" && String(entry.sessionId) === "root-b").length;
    /**
     * 容量按 **scope** 计账（oracle 审查修复）：B 是另一个 (sidebar session, root)，它的 128 条
     * 归属自成一个 scope，因此可以占满自己的 128 个名额——旧断言锁的是「A 的 1 条把 B 挤到 127」
     * 这一跨 scope 阻塞行为，而那正是本次要移除的跨会话死锁。断言强度没有降低：本用例其余断言
     * 仍然逐条锁定「A 的 owner 一条都不许被淘汰 / tabId 绑定原样保留 / 回到 A 后仍能按原 tabId 收回」。
     */
    assert.equal(
      openedB,
      SIDEBAR_AUTO_KEY_LIMIT,
      "B 有自己的 128 个名额（别的 scope 的条目不再阻塞），实际 " + openedB,
    );
    assert.equal(ledger.origin.has(keyA), true, "A 的 owner 绝不能被别的 scope 的容量压力淘汰（内存账本）");
    assert.equal(
      ledger.origin.get(keyA)?.tabId,
      tabIdA,
      "A 的共享条目必须原样保留它自己的 tabId 绑定",
    );
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "auto",
      "A 的持久条目绝不能被 LRU / 任何腾位淘汰掉",
    );
    assert.equal(
      readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId,
      tabIdA,
      "持久条目里的 tabId 绑定也必须原样保留",
    );
    assert.ok(
      fixture.inventory.some((entry) => entry.tabId === tabIdA),
      "A 的 tab 必须原样留在宿主里",
    );

    // 回到 A：资源结束 ⇒ A 的 idle tab 仍必须按它**原来的** tabId 被收回。
    fixture.switchRoot("root-a");
    await fixture.handle.settle();
    fixture.children[0].status = "ready";
    await fixture.sync(8);
    assert.ok(
      fixture.closes.includes(tabIdA),
      "A 的 owner 被淘汰之后它的 tab 会永久漏收；这里必须按原 tabId 正常收回，实际 close 序列 "
        + JSON.stringify(fixture.closes),
    );
    assert.equal(
      fixture.inventory.some((entry) => entry.tabId === tabIdA),
      false,
      "A 的 tab 必须真的被关掉",
    );
  } finally {
    fixture.dispose();
  }
});

/** 缺陷 2（内存账本容量）：满额时新的自动打开被拒绝并留下诊断；释放一个已验证结束的 owner 后恢复。 */
test("Auto 契约（归属容量）：满额时新的自动打开被拒绝并留 owner-capacity 诊断，释放一个 owner 后恢复正常", async () => {
  const storage = createFakeLocalStorage();
  const children = Array.from({ length: SIDEBAR_AUTO_KEY_LIMIT + 1 }, (_, index) => ({
    id: "child-" + (index + 1),
    status: "running",
  }));
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children,
    localStorage: storage,
    inventoryReadCap: 20000,
  });
  try {
    await fixture.sync(8);
    const opened = fixture.inventory.filter((entry) => entry.kind === "subagentchat").length;
    assert.equal(opened, SIDEBAR_AUTO_KEY_LIMIT, "上限内的资源必须全部被自动打开，实际 " + opened);
    assert.equal(
      fixture.openAttempts.length,
      SIDEBAR_AUTO_KEY_LIMIT,
      "第 129 个必须 fail-closed：连一次 openResource 都不许发出（旧行为会淘汰第 1 个 owner 来腾位），实际 "
        + fixture.openAttempts.length,
    );
    /**
     * 拒绝必须可观测：owner-capacity 决策诊断（有界诊断环里只留结论摘要）。
     */
    const decisions = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "decision");
    assert.ok(
      decisions.some((entry) => entry.verdict === "skip" && entry.reason === "owner-capacity"),
      "满额拒绝必须留下 owner-capacity 决策诊断，实际 " + JSON.stringify(decisions.slice(-4)),
    );

    // 释放一个 owner：第 1 个资源结束 ⇒ 它的 tab 被正常关闭并验证收口（record / 来源 / 持久条目全清）。
    fixture.children[0].status = "ready";
    await fixture.sync(8);
    assert.ok(
      fixture.closes.includes("tab-1"),
      "已空闲的 owner 必须被正常收回（释放路径），实际 " + JSON.stringify(fixture.closes.slice(0, 4)),
    );
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "验证关闭成功后必须删除那条持久条目");
    assert.equal(
      fixture.openAttempts.length,
      SIDEBAR_AUTO_KEY_LIMIT + 1,
      "释放一个 owner 之后，之前被拒绝的那个资源必须能正常自动打开，实际 " + JSON.stringify(fixture.openAttempts.length),
    );
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      SIDEBAR_AUTO_KEY_LIMIT,
      "恢复之后归属账本仍然必须守在上限内",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * 缺陷 2（持久表容量）：满额时新增 auto 条目被拒绝、既有有效条目一条都不许被淘汰。
 *
 * 与内存账本同源的判据：发出 openResource 之前必须能确认新 owner 在**两层**都留得住；持久表留不住
 * 就等于「刷新之后这条归属消失」，那正是永久漏收的形状，因此同样 fail-closed（那个资源不自动打开，
 * 用户仍可手动打开）。
 */
test("Auto 契约（归属容量）：持久表满额时新增 auto 被拒绝、既有有效条目不被淘汰，也绝不发出 openResource", async () => {
  const storage = createFakeLocalStorage();
  const now = Date.now();
  const seeded = [];
  for (let index = 0; index < SIDEBAR_AUTO_OWNERSHIP_LIMIT; index += 1) {
    seeded.push({
      key: "root-a|root-a|dsh-resource://subagentchat/session/seeded-" + index + "?parent=root-a&mode=continuable",
      origin: "auto",
      updatedAt: now - 1000,
      reason: "auto-open",
      tabId: "seeded-tab-" + index,
    });
  }
  storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(seeded));
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
    keepPersistedOwnership: true,
  });
  try {
    await fixture.sync(6);
    assert.deepEqual(fixture.openAttempts, [], "持久表满额 ⇒ 新 owner 留不住 ⇒ 连 openResource 都不许发出");
    assert.deepEqual(fixture.inventory.filter((entry) => entry.kind === "subagentchat"), []);
    const stored = JSON.parse(storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY));
    assert.ok(Array.isArray(stored), "归属标记必须以数组形式落盘");
    assert.equal(
      stored.length,
      SIDEBAR_AUTO_OWNERSHIP_LIMIT,
      "既有 128 条有效 auto 条目一条都不许被淘汰（旧实现按 LRU 丢掉最旧的那条来腾位），实际 " + stored.length,
    );
    for (const item of seeded) {
      assert.ok(
        stored.some((entry) => entry.key === item.key),
        "既有有效条目必须原样保留：" + item.key,
      );
    }
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      null,
      "被拒绝的新增 auto 条目绝不允许落盘",
    );
    const allDiag = readSidebarAutoDiag(storage);
    assert.ok(
      allDiag.some((entry) => entry.kind === "decision" && entry.verdict === "skip" && entry.reason === "owner-capacity"),
      "拒绝打开必须留下 owner-capacity 决策诊断，实际 "
        + JSON.stringify(allDiag.filter((entry) => entry.kind === "decision").slice(-3)),
    );

    /**
     * 手动恒优先：容量满额只挡住**自动**打开，用户手动点箭头照常打开，并照常写 manual 归属
     * （manual 条目不参与 auto 容量判定，也绝不为它淘汰任何既有条目）。
     */
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 1, "手动打开绝不被容量拒绝");
    const afterManual = JSON.parse(storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY));
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "manual",
      "手动打开照常写 manual 归属",
    );
    for (const item of seeded) {
      assert.ok(
        afterManual.some((entry) => entry.key === item.key),
        "manual 写入同样不得淘汰任何既有 auto 条目：" + item.key,
      );
    }
    assert.equal(
      fixture.arrowOf("子代理 child-a").props["data-open"],
      "true",
      "手动打开落地之后箭头必须是 <<（交给用户手动处理）",
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * 缺陷 3（跨会话死锁）：持久表被别的 session 的 128 条 auto 条目占满时的自动打开。
 *
 * 用户实测形状：`dsh-expert-group:auto-ownership:v1` 里 128 条全部 origin=auto、全部来自 16 个
 * 旧会话 scope，没有任何 manual；Auto 开着、候选也选出来了，但每个候选都被容量判据挡住，子代理 tab
 * 永远不自动打开（自动关闭只遍历 Auto 亲手打开过的 tab，于是也表现为永远不自动关闭）。容量必须按
 * scope 计账：别的 scope 的条目不得阻塞当前 scope 的自动打开。
 */
test("Auto 契约（跨会话容量）：别的 root/scope 顶满 128 条持久 auto 归属时，当前 root 的子代理必须照常自动打开并落 auto 归属", async () => {
  // 全局硬上限（4 × 单 scope 上限）只约束存储体积：这里在用例内声明，避免动既有夹具常量。
  const GLOBAL_LIMIT = 4 * SIDEBAR_AUTO_OWNERSHIP_LIMIT;
  const storage = createFakeLocalStorage();
  const now = Date.now();
  const seeded = [];
  for (let index = 0; index < SIDEBAR_AUTO_OWNERSHIP_LIMIT; index += 1) {
    seeded.push({
      key: "root-old|root-old|dsh-resource://subagentchat/session/seeded-" + index + "?parent=root-old&mode=continuable",
      origin: "auto",
      updatedAt: now - (SIDEBAR_AUTO_OWNERSHIP_LIMIT - index) * 1000,
      reason: "auto-open",
      tabId: "seeded-tab-" + index,
    });
  }
  storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(seeded));
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
    keepPersistedOwnership: true,
  });
  try {
    await fixture.sync(6);
    assert.equal(
      fixture.openAttempts.length,
      1,
      "别的 scope 的 128 条 auto 条目不得阻塞当前 root 的自动打开，实际 open 次数 " + fixture.openAttempts.length,
    );
    assert.deepEqual(
      fixture.resources.map((entry) => entry.address),
      [AUTO_LEDGER_TARGET_ADDRESS],
      "运行中的子代理必须被自动打开",
    );
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "auto",
      "自动打开必须为当前 scope 落一条 auto 归属（容量按 scope 计账）",
    );
    const stored = JSON.parse(storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY));
    assert.ok(Array.isArray(stored), "归属标记必须以数组形式落盘");
    assert.ok(stored.length <= GLOBAL_LIMIT, "磁盘条目总数必须守在全局限额内，实际 " + stored.length);
    for (const item of seeded) {
      assert.ok(stored.some((entry) => entry.key === item.key), "别的 scope 的既有 auto 条目不得被淘汰：" + item.key);
    }
    const decisions = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "decision");
    assert.equal(
      decisions.some((entry) => entry.verdict === "skip" && entry.reason === "owner-capacity"),
      false,
      "按 scope 计账之后不得再出现 owner-capacity 跳过，实际 " + JSON.stringify(decisions.slice(-3)),
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "落地证据齐备后箭头必须进入 << 态");
  } finally {
    fixture.dispose();
  }
});


/**
 * 「Auto 由关→开 = 重新授权」的内层抑制（同一页面生命周期）。
 *
 * 用户手动关闭一个仍在运行的子代理 tab 时会同时留下两层抑制：持久 manual 归属（跨刷新，账本负责）
 * 与本页 realm 内存的 sidebarAutoSuppressed 表（autoOpenCandidate 先看它）。只清持久层时，重新打开
 * Auto 之后候选仍被内存抑制跳过，要等资源回到 ready 才恢复——与 README「重新打开 Auto 就能恢复」
 * 的措辞不一致。本用例锁定：标题栏由关→开必须把两层一起解除，下一次同步重新自动打开。
 */
test("Auto 契约（重新授权）：同一页面内手动关闭后由关→开 Auto，下一次同步必须重新自动打开该子代理", async () => {
  const storage = createFakeLocalStorage();
  // 开关真相源：标题栏写面直接改这里，install 注入的读面每次现读（与真实宿主 getter 同形）。
  const autoSwitch = { value: true };
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
    getAutoOpen: () => autoSwitch.value,
    setAutoOpen: (value) => { autoSwitch.value = value === true; return Promise.resolve(true); },
  });
  try {
    const tabId = await openAutoTabOnce(fixture);
    // 用户手动关闭（宿主真的移除 tab）：持久 manual 与内存抑制同时落地，资源仍在运行。
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "手动关闭必须真的发出一次关闭请求");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "手动关闭必须写持久 manual");
    assert.equal(
      sharedAutoLedgerOf().suppressed.has(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS)),
      true,
      "手动关闭必须同时留下本 realm 的内存抑制",
    );
    assert.equal(fixture.openAttempts.length, 1, "资源仍 running：两层抑制生效，绝不立刻重开");

    // 标题栏 Auto 由关→开（走真实写面）：两层抑制都必须被解除。
    const toggleOff = fixture.autoToggle().input;
    assert.ok(toggleOff, "标题栏 Auto 开关必须渲染");
    await toggleOff.props.onChange({ target: { checked: false } });
    await fixture.handle.settle();
    assert.equal(autoSwitch.value, false, "关闭 Auto 必须经过写面结算");
    const toggleOn = fixture.autoToggle().input;
    await toggleOn.props.onChange({ target: { checked: true } });
    await fixture.handle.settle();
    assert.equal(autoSwitch.value, true, "重新打开 Auto 必须经过写面结算");
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      null,
      "重新授权必须清除持久 manual 归属",
    );
    assert.equal(
      sharedAutoLedgerOf().suppressed.has(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS)),
      false,
      "重新授权必须清除本 realm 的内存抑制",
    );

    // 下一次同步：资源仍在 running ⇒ 必须重新自动打开（openAttempts 增加）。
    await fixture.sync(6);
    assert.equal(
      fixture.openAttempts.length,
      2,
      "重新授权之后必须重新自动打开该子代理，实际 openAttempts " + fixture.openAttempts.length,
    );
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      1,
      "自动打开的 tab 必须重新落到宿主 inventory",
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "落地之后箭头必须回到 << 态");
  } finally {
    fixture.dispose();
  }
});


/**
 * 相位归属（用户最终规则）：manual 只在「手动操作让状态偏离该相位的正常状态」时存在；
 * 回到正常状态（running+present / idle+absent）就交回 Auto 或直接清除。
 *
 * 对账表（每轮同步按 (phase, presence) 直接判定，不做过渡检测、不新增 ref）：
 * | running | present | auto |    | running | absent | manual |
 * | idle    | absent  | 清   |    | idle    | present| manual |
 * | unknown / inventory 不可读 ⇒ 不改（fail-closed） |
 *
 * 只收敛「用户亲手打开」留下的 manual-open（表里两行"重新打开/恢复运行"的来源）；manual-close、
 * manual-takeover（外部写入者）与 stale/unproven 的 manual 一律保持——它们要么是同一轮内的关闭
 * 意图，要么无法证明 tabId 属于自己，绝不在这里被猜成 auto。
 */
test("相位归属：空闲中手动打开（idle+present=manual）绝不被自动关闭；恢复运行后收敛为 auto 并在该轮结束收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "ready" }],
    localStorage: storage,
  });
  try {
    // 空闲子代理：Auto 不会打开它；用户手动打开会话 ⇒ idle+present ⇒ manual。
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "空闲中手动打开必须写 manual");
    const tabId = fixture.inventory.find((entry) => entry?.kind === "subagentchat")?.tabId;
    assert.ok(tabId, "手动打开必须落地");
    await fixture.sync(3);
    assert.deepEqual(fixture.closes, [], "idle+present 是偏离态：Auto 绝不允许自动关闭用户打开的会话");
    assert.ok(fixture.inventory.some((entry) => entry.tabId === tabId), "tab 必须原样留在宿主里");

    // 恢复运行（running+present）：manual 收敛为 auto，同一张 tab 由本轮接管。
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "running+present 必须收敛为 auto");
    assert.equal(fixture.closes.length, 0, "收敛本身绝不关闭 tab");

    // 本轮结束（idle+absent）：auto 归属的 tab 必须被自动收回。
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "新一轮结束必须按 auto 归属收回同一张 tab");
  } finally {
    fixture.dispose();
  }
});

test("相位归属：运行中手动关闭（running+absent=manual）不重开；用户再打开（running+present）即收敛 auto 并在该轮结束收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const autoTabId = await openAutoTabOnce(fixture);
    // 运行中手动关闭：running+absent 是偏离态 ⇒ manual 抑制本轮重开。
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId], "手动关闭必须真的关闭");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "运行中手动关闭必须写 manual");
    await fixture.sync(4);
    assert.equal(fixture.resources.length, 1, "running+absent：本轮绝不重开");
    assert.equal(fixture.openAttempts.length, 1, "绝不发出第二次 openResource");

    // 用户再次手动打开：running+present 回到正常态 ⇒ 收敛 auto（本轮归属仍由 Auto 管理）。
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(3);
    const manualTabId = fixture.inventory.find((entry) => entry?.kind === "subagentchat")?.tabId;
    assert.ok(manualTabId, "手动重新打开必须落地");
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "auto",
      "运行中重新打开 = 正常态，必须收敛为 auto",
    );

    // 本轮结束：收敛后的 tab 必须被收回。
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [autoTabId, manualTabId], "本轮结束必须收回这张 tab，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("相位归属：空闲中手动打开再手动关闭（idle+absent）⇒ 清标记；unknown 与 inventory 不可读 ⇒ 一律不改", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "ready" }],
    localStorage: storage,
  });
  try {
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(2);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "idle+present 先落 manual");
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "idle+absent 必须清掉 manual（恢复自动）");
    assert.deepEqual(fixture.closes.length, 1, "手动关闭本身必须发出一次关闭");

    // unknown（既不在 running 也不在 idle 集合）⇒ 对账不改任何东西。
    fixture.children[0].status = "unknown";
    await fixture.sync(2);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "unknown 相位绝不写/删归属");

    // 手工写一条 manual 之后 inventory 不可读：必须保持 manual（fail-closed），既不收敛也不删除。
    fixture.children[0].status = "running";
    await fixture.sync(2);
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(2);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "运行中手动打开先落 manual");
    fixture.setInventoryUnreadable(true);
    await fixture.sync(2);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "inventory 不可读 ⇒ 保持 manual 不动");
    fixture.setInventoryUnreadable(false);
  } finally {
    fixture.dispose();
  }
});


test("相位归属（轮次边界）：同一轮内 manual-takeover 绝不收敛，也绝不被自动关闭", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    presenceDom: true,
    // 第一次自动打开同步抛错：随后从宿主侧出现的同地址 tab 只能按 manual-takeover 收养。
    openFailures: 99,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await fixture.sync(2);
    const tabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(5);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "同一轮内 takeover 必须保持 manual");
    assert.deepEqual(fixture.closes, [], "同一轮内绝不允许关闭外部入口打开的 tab");
    assert.ok(fixture.inventory.some((entry) => entry.tabId === tabId), "tab 必须原样保留");
  } finally {
    fixture.dispose();
  }
});

test("相位归属（轮次边界）：manual-takeover 在观察到 idle→running 后收敛 auto，并在该轮结束被收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    presenceDom: true,
    openFailures: 99,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await fixture.sync(2);
    const tabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "同轮保持 manual");

    // 明确空闲一次（tab 仍在）：记录「这一轮亲眼见过空闲」→ 再运行即下一轮。
    fixture.children[0].status = "ready";
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "idle+present 仍是偏离态，保持 manual");
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "观察到 idle→running 后必须收敛为 auto");

    fixture.children[0].status = "ready";
    await fixture.sync(5);
    assert.ok(fixture.closes.includes(tabId), "新一轮结束必须收回该 tab，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

test("相位归属（轮次边界）：运行中手动关闭（manual-close）→ 空闲 → 再运行 ⇒ 恢复自动并正常收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const firstTabId = await openAutoTabOnce(fixture);
    await fixture.clickArrow("子代理 child-a");
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [firstTabId], "运行中手动关闭必须真的关闭");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "手动关闭写 manual");

    // 资源明确空闲且 tab 已不存在：idle+absent 清标记。
    fixture.children[0].status = "ready";
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), null, "idle+absent 必须清掉 manual");

    // 再次运行：Auto 正常打开并写 auto，本轮结束正常收回。
    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "新一轮必须由 Auto 接管");
    const secondTabId = fixture.inventory.find((entry) => entry?.kind === "subagentchat")?.tabId;
    assert.ok(secondTabId, "新一轮必须重新打开");
    fixture.children[0].status = "ready";
    await fixture.sync(5);
    assert.ok(fixture.closes.includes(secondTabId), "该轮结束必须收回，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});


test("相位归属（容量 fail-closed）：rearm 写入被容量拒绝时保持 manual，内存不改、绝不关闭", async () => {
  const storage = createFakeLocalStorage();
  // 当前 scope 预置 128 条 auto（顶满单 scope 上限）+ 一条待收敛的 manual-takeover。
  const seeded = Array.from({ length: SIDEBAR_AUTO_OWNERSHIP_LIMIT }, (_, index) => ({
    key: "root-a|root-a|dsh-resource://subagentchat/session/bulk-" + index + "?parent=root-a&mode=continuable",
    origin: "auto",
    updatedAt: Date.now(),
    reason: "auto-open",
    tabId: null,
  }));
  seeded.push({
    key: "root-a|root-a|" + AUTO_LEDGER_TARGET_ADDRESS,
    origin: "manual",
    updatedAt: Date.now(),
    // manual-open：running+present 会立刻走收敛路径，用来验证容量拒绝时 fail-closed。
    reason: "manual-open",
    tabId: null,
  });
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    // install 会清空持久层；在挂载之后预置，再重置内存槽位让它重新从 localStorage 载入。
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(seeded));
    resetSidebarRealmLedger({ keepPersisted: true });
    const tabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "容量拒绝后持久必须仍是 manual");
    assert.equal(
      sharedAutoLedgerOf()?.origin.has(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS)) ?? false,
      false,
      "容量拒绝后内存 origin 绝不允许出现该 key（否则关闭候选会误关）",
    );
    assert.deepEqual(fixture.closes, [], "容量拒绝时绝不关闭用户的 tab");
    assert.ok(fixture.inventory.some((entry) => entry.tabId === tabId), "tab 必须原样保留");
    const diag = readSidebarAutoDiag(storage);
    assert.ok(
      diag.some((entry) => entry.kind === "ownership" && entry.event === "reject" && entry.reason === "capacity"),
      "必须留下 reject/capacity 诊断，实际 " + JSON.stringify(diag.slice(-6)),
    );
  } finally {
    fixture.dispose();
  }
});

test("相位归属（首帧竞态）：新实例首帧 idle+present 没有 record 也必须在同一次同步记下空闲证据", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "ready" }],
    localStorage: storage,
  });
  try {
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([{
      key: "root-a|root-a|" + AUTO_LEDGER_TARGET_ADDRESS,
      origin: "manual",
      updatedAt: Date.now(),
      reason: "manual-takeover",
      tabId: "tab-seed",
    }]));
    resetSidebarRealmLedger({ keepPersisted: true });
    // 首帧：新实例还没有任何 record，但 tab 已经 present（idle+present）。
    const tabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(2);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "首帧仍保持 manual");

    fixture.children[0].status = "running";
    await fixture.sync(4);
    assert.equal(
      readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS),
      "auto",
      "首帧记录的空闲证据必须让下一次 running 收敛为 auto（旧实现会因无 record 丢失证据）",
    );
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.ok(fixture.closes.includes(tabId), "该轮结束必须收回，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

/**
 * idle 证据的生命周期（与控制器注释一致：running+absent 时**消费**，不保留）。
 *
 * 说明：夹具里无法稳定构造「已有 idle 证据 + running+absent」——只要资源处于 running+present，
 * 收敛分支就会先命中并消费证据（能收敛的 reason），或是永不收敛的安全降级 reason（其 tab 必须
 * 由收养写入、同样不会留下证据）。因此这里锁用户可见结果：运行中移除 tab 后 manual 保持，
 * 同地址在本轮重新出现时绝不收敛成 auto、绝不自动关闭。
 */
test("相位归属（轮次边界）：running+absent 移除 tab 后同地址本轮重现绝不收敛", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([{
      key: "root-a|root-a|" + AUTO_LEDGER_TARGET_ADDRESS,
      origin: "manual",
      updatedAt: Date.now(),
      reason: "manual-takeover",
      tabId: null,
    }]));
    resetSidebarRealmLedger({ keepPersisted: true });
    const firstTabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(3); // running+present：不产生 idle 证据
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "running+present 的 takeover 保持 manual");
    const index = fixture.inventory.findIndex((entry) => entry.tabId === firstTabId);
    fixture.inventory.splice(index, 1); // running+absent：child 仍 running，tab 已消失
    await fixture.sync(3);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "running+absent 必须保持 manual");

    fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS); // 同地址本轮重新出现
    await fixture.sync(4);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "本轮重现绝不收敛成 auto");
    assert.deepEqual(fixture.closes, [], "本轮绝不自动关闭");
  } finally {
    fixture.dispose();
  }
});

/**
 * 持久化 I/O 失败（可读、但 setItem 抛错）时的真实语义：ledger 仍返回 true，rearm 以内存状态继续。
 * 这是 fail-safe：持久层仍是 manual，整页刷新后按 manual 回落，不会误关用户的 tab。
 */
test("相位归属（持久化失败 persist-failed）：setItem 抛错时以内存状态继续且该轮正常关闭，持久仍 manual", async () => {
  const storage = createFakeLocalStorage();
  storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([{
    key: "root-a|root-a|" + AUTO_LEDGER_TARGET_ADDRESS,
    origin: "manual",
    updatedAt: Date.now(),
    reason: "manual-open",
    tabId: null,
  }]));
  // 可读、但 setItem 抛错：正是 localStorage 写失败的形状（读仍然成功）。
  const readOnly = {
    getItem: (key) => storage.getItem(key),
    removeItem: (key) => storage.removeItem(key),
    setItem() { throw new Error("persist-failed：磁盘只读"); },
  };
  // keepPersistedOwnership：安装时保留上面预置的 manual（等价整页刷新后仍带着它）。
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: readOnly,
    keepPersistedOwnership: true,
  });
  try {
    const tabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(4); // 不得抛错
    assert.equal(
      sharedAutoLedgerOf()?.origin.has(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS)) ?? false,
      true,
      "存储写失败时以内存状态继续：共享 origin 必须是 auto",
    );
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "持久层仍是 manual（刷新后按 manual 回落）");
    // 诊断本身也走 setItem，写失败时同样落不了盘——因此这里只断言可观测行为（内存 auto + 收口）。
    fixture.children[0].status = "ready";
    await fixture.sync(5);
    assert.ok(fixture.closes.includes(tabId), "内存已 auto ⇒ 该轮结束必须正常收回，实际 " + JSON.stringify(fixture.closes));
  } finally {
    fixture.dispose();
  }
});

/* ------------------------------------------------------------------------------------------------ *
 * 缺陷 1：布局等待期间的因果证明（不再按地址认领）与缺陷 2：打开占位的生命周期
 * ------------------------------------------------------------------------------------------------ */


/**
 * 缺陷 1（阻塞级误关）：布局等待期间用户从 DSH 其它入口打开同地址 tab。
 *
 * 宿主公开契约（@deepseek-ai/dsh-client-ui-sidebar-right，见 lib/types/client/service.d.ts 与
 * lib/client-entry.js 的 place()）：openResource(address, options) 返回 **void**，不携带新 tab 的 tabId；
 * 而且默认 revealIfOpened=true——同一个 (kind, contentId) 已经有 tab 时它只**揭示**那一个。
 * 因此「我们调用过 openResource」+「随后 inventory 里出现同地址 tab」**不构成因果**。
 *
 * 旧行为：Auto 在布局等待前登记的 opening(origin=auto) 成了最高的内存来源证据，等待期间收养到的
 * 那个**用户 tab** 被记成 auto（previous/origin 分支同样不看 tabId），资源一空闲就被自动关闭。
 */
test("Auto 契约（因果证明）：布局等待期间用户从其它入口打开同地址 tab ⇒ 记 manual，资源 idle 时绝不被自动关闭", async () => {
  const ADDRESS = AUTO_LEDGER_TARGET_ADDRESS;
  const storage = createFakeLocalStorage();
  /**
   * 本形状刻意**不装 DOM 读面**：opening 记录不登记（canObserveOpenCommit 需要 document），
   * 因此这里检验的是「发出 openResource 之前的因果证明」这一层。
   *
   * 归属结论在本形状里还有第二层保护——等待期间的那次普通同步会把用户的 tab 收养成 manual，
   * 而持久 manual 在来源判据里恒优先。真正会被旧行为误关的形状（opening 直接压过一切）由下一条
   * 开着 DOM 读面的用例复现；本条锁的是「因果证明失败必须被记录下来、且绝不发生误关」。
   */
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须真实停在「等宿主布局提交」的 await 里");
    assert.deepEqual(fixture.openAttempts, [], "布局等待还没放行，绝不允许发出 openResource");

    // 用户在这个窗口里从 DSH 其它入口打开了同一个资源（没有插件侧手动意图）。
    const hostTabId = fixture.hostOpenTab(ADDRESS);
    await fixture.sync();
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "用户打开的 tab 必须已经反映成 <<");

    // 放行布局等待：Auto 继续走完 split + openResource。
    await fixture.flushLayout();
    await fixture.sync(4);

    const decisions = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "decision");
    assert.ok(
      decisions.some((entry) => entry.reason === "causal-unproven"),
      "发出前地址上已经有 tab ⇒ 必须记为「因果证明失败」（旧行为：没有这一层，直接按声明认领），实际 "
        + JSON.stringify(decisions.slice(-4)),
    );
    assert.equal(
      readSidebarOwnership(storage, ADDRESS),
      "manual",
      "缺因果证明的落地一律 manual（旧行为：本次动作声明的 auto 来源直接认领 ⇒ auto）",
    );
    assert.ok(
      ["manual-unproven-open", "manual-takeover"].includes(readSidebarOwnershipEntry(storage, ADDRESS)?.reason),
      "降级理由必须落在「未证明 / 手动接管」这一族，实际 " + readSidebarOwnershipEntry(storage, ADDRESS)?.reason,
    );
    assert.equal(
      fixture.inventory.filter((entry) => entry.kind === "subagentchat").length,
      1,
      "宿主默认 reveal：绝不因为这次 openResource 多出一个同地址 tab",
    );
    assert.ok(fixture.inventory.some((entry) => entry.tabId === hostTabId), "用户那个 tab 必须原样保留");

    // 资源结束：这条 manual 归属绝不允许被自动收回。
    fixture.children[0].status = "ready";
    await fixture.sync(6);
    assert.deepEqual(
      fixture.closes,
      [],
      "用户自己打开的 tab 绝不能被自动关闭，实际 " + JSON.stringify(fixture.closes),
    );
    assert.ok(fixture.inventory.some((entry) => entry.tabId === hostTabId), "用户的 tab 必须原样保留");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "manual 记录必须保持 <<");
  } finally {
    fixture.dispose();
  }
});

/**
 * 同一形状、但**开着 DOM 读面**（presenceDom）：opening 记录此时真的存在，因此这条用例锁的是
 * 「在途打开（opening）这一层也必须自带因果证明」——causalProof / causalIssuedAt / foreignWriter
 * 三个字段缺一不可。install 之前登记的 opening 在等待期间看到同地址 tab 时会被标记 foreignWriter。
 */
test("Auto 契约（因果证明）：开着 DOM 读面时，等待期间出现的同地址 tab 同样不得被 opening 认领", async () => {
  const ADDRESS = AUTO_LEDGER_TARGET_ADDRESS;
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await fixture.sync();
    assert.equal(fixture.layoutWaits(), 1, "自动打开必须停在布局等待里（此时 opening 已经登记）");
    const hostTabId = fixture.hostOpenTab(ADDRESS);
    // 等待窗口里的普通同步：插件会看到这个 tab，而自己的 openResource 还没发出。
    await fixture.sync();
    await fixture.flushLayout();
    await fixture.sync(4);
    assert.equal(
      readSidebarOwnership(storage, ADDRESS),
      "manual",
      "opening 缺因果证明时绝不认领这个 tab（旧行为：opening.origin=auto 直接压过一切）",
    );
    fixture.children[0].status = "ready";
    await fixture.sync(6);
    assert.deepEqual(fixture.closes, [], "绝不允许自动关闭这个 tab，实际 " + JSON.stringify(fixture.closes));
    assert.ok(fixture.inventory.some((entry) => entry.tabId === hostTabId), "用户的 tab 必须原样保留");
  } finally {
    fixture.dispose();
  }
});

/** 缺陷 1 的不回归面：没有外部竞争时，Auto 打开仍然是 auto，并且资源结束后按真实 tabId 正常收回。 */
test("Auto 契约（因果证明不回归）：无外部竞争时 Auto 打开仍是 auto，资源结束后正常收回", async () => {
  // 直路（没有 split 布局等待）。
  const storage = createFakeLocalStorage();
  const direct = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const tabId = await openAutoTabOnce(direct);
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "因果证明成立时必须写 auto");
    const writes = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "ownership" && entry.event === "write");
    assert.ok(writes.some((entry) => entry.origin === "auto" && entry.reason === "auto-open"), "必须留下 auto-open 写入诊断");
    assert.equal(direct.openAttempts.length, 1, "只允许一次 openResource");
    direct.children[0].status = "ready";
    await direct.sync(4);
    assert.deepEqual(direct.closes, [tabId], "资源结束后必须按真实 tabId 收回");
  } finally {
    direct.dispose();
  }

  // 分栏直路（要跨过布局等待）：证明点就在 openResource 之前，等待本身不削弱证明。
  const storage2 = createFakeLocalStorage();
  const splitFixture = await installAutoSidebarHarness({
    autoOpen: true,
    split: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage2,
  });
  try {
    await splitFixture.sync();
    assert.equal(splitFixture.layoutWaits(), 1, "必须真实经过布局等待");
    await splitFixture.flushLayout();
    await splitFixture.sync(2);
    assert.equal(readSidebarOwnership(storage2, AUTO_LEDGER_TARGET_ADDRESS), "auto", "等待结束后证明点仍然成立");
    const tabId = splitFixture.inventory.find((entry) => entry.kind === "subagentchat")?.tabId;
    assert.ok(tabId, "Auto 打开必须落进宿主 inventory");
    splitFixture.children[0].status = "ready";
    await splitFixture.sync(4);
    assert.deepEqual(splitFixture.closes, [tabId], "分栏路径同样必须正常收回");
  } finally {
    splitFixture.dispose();
  }
});

/**
 * 可用性阻塞（时序加固）：宿主在 openResource() **内部**同步发布 inventory。
 *
 * 已按实现核实的宿主链路（@deepseek-ai/dsh-client-ui-sidebar-right 的 client-entry.js + client-store 的
 * snapshot store）：openResource → place → store.actions.openContent（defineStore 的 update）→
 * zustand setState 的同步 forEach → adopt() 里 store.subscribe(sync) 注册的回调 → inventory.update →
 * inventory.publish() → openTabs.set → 插件的 subscribe 回调。整条链路上没有任何 await / 微任务，
 * 插件因此会在 openResource() 返回之前被**同步重入**一次。
 *
 * 旧实现把「已发出」标记写在 openResource() 返回之后：这次重入结算读到的 causalIssuedAt 还是 null，
 * 于是按「别的写入者」把它记成 manual 并落盘持久归属；随后声明式的 Auto 记录又被持久 manual 压制，
 * 资源结束后再也收不回来（不会误关，但正常自动收回失效）。加固后必须把标记写在同一个同步段的调用
 * **之前**，重入结算才能把它当作可用 auto 证据（仍然要求既有三件套：发出前 inventory 可读且该地址无
 * tab 的因果证明 + 无 foreignWriter）。
 */
test("Auto 契约（同步重入）：宿主在 openResource 内部同步发布 inventory 时，Auto tab 仍必须记 auto 并按 tabId 收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    // 必须开着 DOM 读面：只有它才走「在途 opening + causalIssuedAt 因果判据」那条路径——也就是本次
    // 加固真正要修的那条（真实宿主有 DOM，因此现场走的一定是这条）。
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const tabId = await openAutoTabOnce(fixture, "同步重入");
    assert.equal(fixture.openAttempts.length, 1, "只允许一次 openResource");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "同步重入的落地必须记成 auto");
    const entry = readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS);
    assert.equal(entry?.tabId, tabId, "持久归属必须绑定重入那一刻亲眼读到的 tabId");
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "落地证据齐备后箭头必须进入 << 态");
    // 资源结束：必须按精确 tabId 收回（旧实现落 manual，永不收回）。
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "资源结束后必须按精确 tabId 收回");
    assert.deepEqual(fixture.inventory, [], "Auto 自己打开的 tab 必须已经从宿主里消失");
  } finally {
    fixture.dispose();
  }
});


/**
 * 同步重入 + 重挂载的端到端面：宿主同步发布 inventory 时打开的那个 tab，在 Panel 重挂载之后仍必须
 * 按 auto 收养并收回。
 *
 * 这个夹具刻意不提供 localStorage：持久归属层不存在时，同 realm 的共享来源账本是重挂载后唯一的
 * auto 证据，因此它锁定的是「重入结算写下的真实 tabId 必须留在账本里、收养时按它绑定」这条不变量
 * （声明式占位的覆盖闸门就是为这条不变量加的护栏）。
 */
test("Auto 契约（同步重入 + 重挂载）：共享账本必须保留重入读到的真实 tabId，重挂载后仍按 auto 收回", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
  });
  try {
    const tabId = await openAutoTabOnce(fixture, "同步重入 + 重挂载");
    // 宿主卸载旧 Panel 再挂新实例：新实例没有任何内存记录，只能靠 realm 共享账本收养这个 tab。
    await fixture.remount();
    await fixture.sync(2);
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "true", "重挂载后必须按共享账本收养成 << 态");
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "重挂载后仍必须按精确 tabId 收回");
    assert.deepEqual(fixture.inventory, [], "Auto 自己打开的 tab 必须已经从宿主里消失");
  } finally {
    fixture.dispose();
  }
});

/**
 * 另一种语义：inventory 通知晚于 openResource() 返回（微任务发布）。
 *
 * 与上一条互为镜像：实现绝不允许只对「同步重入」这一种时序正确——声明式记录与重入结算必须都能给出
 * auto，且都必须按同一条 tabId 绑定判据收口。
 */
test("Auto 契约（异步发布）：inventory 通知晚于 openResource 返回时同样记 auto 并正常收回", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: "async",
    // 与同步重入那条互为镜像：同样开着 DOM 读面，锁定「通知晚于返回」这一种语义下也必须是 auto。
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const tabId = await openAutoTabOnce(fixture, "异步发布");
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "异步发布同样必须记 auto");
    assert.equal(readSidebarOwnershipEntry(storage, AUTO_LEDGER_TARGET_ADDRESS)?.tabId, tabId, "持久归属同样必须绑定真实 tabId");
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [tabId], "资源结束后同样必须按精确 tabId 收回");
  } finally {
    fixture.dispose();
  }
});

/**
 * 反向用例：openResource() **同步抛错**时绝不能留下「已发出」的假证据。
 *
 * 断言三件事：不崩溃（面板照常渲染、后续同步照常推进）；抛错那一轮不写任何 auto 归属；随后的同地址
 * tab（宿主/用户在别处提交的外部写入者）一律落 manual，绝不因为「这次动作声明过 auto」而被认领，
 * 也绝不被自动关闭（不会误关用户刚打开的 tab）。
 */
test("Auto 契约（同步抛错）：openResource 同步抛错后不得留下已发出证据，同地址 tab 一律 manual 且不被自动关闭", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    // 每次打开都同步抛错：这一段只观察「抛错之后留下的状态」，重试成功留给下面那一段夹具。
    openFailures: 99,
    // 与同步重入用例同一条路径（真实宿主始终有 DOM 读面）：抛错时必须把「已发出」标记回滚干净。
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    await fixture.sync(2);
    assert.ok(fixture.openAttempts.length >= 1, "Auto 必须真的尝试过打开");
    assert.equal(fixture.resources.length, 0, "抛错的那次绝不留下打开记录");
    assert.deepEqual(fixture.inventory, [], "抛错时宿主没有提交任何 tab");
    assert.notEqual(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "抛错后绝不允许留下 auto 归属");
    // 「已发出」标记绝不允许变成留在账本里的证据：抛错的动作连共享来源占位都不许留下。
    assert.equal(
      sharedAutoLedgerOf()?.origin.has(autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS)) ?? false,
      false,
      "抛错后共享来源账本不得留下这个地址的条目",
    );
    assert.equal(fixture.arrowOf("子代理 child-a").props["data-open"], "false", "抛错后必须保持 >> 打开语义");
    // 抛错之后宿主/用户在别处提交了同地址 tab（外部写入者）：声明式的 Auto 绝不能认领它。
    const foreignTabId = fixture.hostOpenTab(AUTO_LEDGER_TARGET_ADDRESS);
    await fixture.sync(4);
    const attemptsWithTab = fixture.openAttempts.length;
    assert.equal(readSidebarOwnership(storage, AUTO_LEDGER_TARGET_ADDRESS), "manual", "抛错的动作不得凭声明认定为 auto（必须落 manual）");
    await fixture.sync(4);
    assert.equal(fixture.openAttempts.length, attemptsWithTab, "地址上已经有 tab 时绝不再补发第二次 openResource");
    fixture.children[0].status = "ready";
    await fixture.sync(4);
    assert.deepEqual(fixture.closes, [], "manual 来源的 tab 绝不被自动关闭");
    assert.ok(fixture.inventory.some((entry) => entry.tabId === foreignTabId), "用户的 tab 必须原样保留");
  } finally {
    fixture.dispose();
  }

  // 回滚必须彻底：抛错那一轮之后，同一个资源仍然可以被重新选中并正常打开（不残留「已发出」假证据）。
  const retryStorage = createFakeLocalStorage();
  const retry = await installAutoSidebarHarness({
    autoOpen: true,
    syncInventoryOnOpen: true,
    openFailures: 1,
    presenceDom: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: retryStorage,
  });
  try {
    // 第一次尝试同步抛错；下一轮外部同步里屏障失效，同一个资源必须能被重新选中并成功落地。
    const tabId = await openAutoTabOnce(retry, "抛错后重试");
    assert.equal(retry.openAttempts.length, 2, "抛错后必须允许一次新的打开（第一次抛错 + 一次成功重试）");
    assert.equal(readSidebarOwnership(retryStorage, AUTO_LEDGER_TARGET_ADDRESS), "auto", "成功的那次仍然必须是 auto");
    retry.children[0].status = "ready";
    await retry.sync(4);
    assert.deepEqual(retry.closes, [tabId], "重试打开的 tab 必须按真实 tabId 收回");
  } finally {
    retry.dispose();
  }
});

/**
 * 缺陷 2（可用性）：tabId=null 的打开占位必须有生命周期。
 *
 * 覆盖四件事：期限之内保留（去重，绝不并发第二次 openResource）；期限之后释放并允许一次有界重试
 * （每次至少间隔一个窗口）；inventory 不可读时 fail-closed 保留（绝不把「读不到」当成「没有 tab」）；
 * 长时间反复不落地时重试次数与窗口数同阶（绝不无限重试）。
 */
test("Auto 契约（占位生命周期）：未落地的占位按期限释放并允许有界重试，inventory 不可读时 fail-closed 保留", async () => {
  const storage = createFakeLocalStorage();
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    openNoCommit: true,
    children: [{ id: "child-a", status: "running" }],
    localStorage: storage,
  });
  try {
    const ledger = sharedAutoLedgerOf();
    assert.ok(ledger !== null && ledger.origin instanceof Map, "夹具必须能观察到 realm 共享的来源账本");
    const key = autoKeyOf(AUTO_LEDGER_TARGET_ADDRESS);

    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 1, "Auto 必须先为运行中的子代理发出一次打开");
    assert.deepEqual(fixture.inventory.filter((entry) => entry.kind === "subagentchat"), [], "宿主没有落地这个 tab");
    const placeholder = ledger.origin.get(key);
    assert.ok(placeholder !== undefined, "打开已发出、落地证据未到时必须留下占位");
    assert.equal(placeholder.tabId, null, "占位不得携带 tabId（它不是归属证据）");
    assert.equal(typeof placeholder.writtenAt, "number", "占位必须携带写入时刻（TTL 判据）");

    // 期限之内：占位保留 ⇒ 同一个资源绝不并发第二次 openResource。
    await fixture.advanceClock(SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS - 1000);
    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 1, "期限之内绝不释放占位、也绝不重试");

    // 期限之后：占位被回收 ⇒ 允许一次有界重试。
    await fixture.advanceClock(2000);
    await fixture.sync(3);
    assert.equal(fixture.openAttempts.length, 2, "占位回收之后必须允许一次重试，实际 " + fixture.openAttempts.length);
    assert.equal(ledger.origin.get(key)?.tabId ?? null, null, "重试之后留下的仍然是新的占位");
    const deletes = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "ownership" && entry.event === "delete");
    assert.ok(
      deletes.some((entry) => entry.reason === "placeholder-retry"),
      "释放必须留下 placeholder-retry 诊断，实际 " + JSON.stringify(deletes.slice(-3)),
    );

    // inventory 不可读：占位一律保留（fail-closed），绝不重试。
    fixture.setInventoryUnreadable(true);
    await fixture.advanceClock(SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS * 2);
    await fixture.sync(3);
    assert.equal(fixture.openAttempts.length, 2, "inventory 不可读时绝不释放占位、也绝不重试");
    assert.ok(ledger.origin.has(key), "占位必须保留（绝不把读不到当成没有 tab）");
    const keeps = readSidebarAutoDiag(storage).filter((entry) => entry.kind === "ownership" && entry.event === "keep");
    assert.ok(
      keeps.some((entry) => entry.reason === "placeholder-unreadable"),
      "保留必须留下 placeholder-unreadable 诊断，实际 " + JSON.stringify(keeps.slice(-3)),
    );

    // 恢复可读：过期占位立刻回收，重试恢复正常。
    fixture.setInventoryUnreadable(false);
    await fixture.sync(2);
    assert.equal(fixture.openAttempts.length, 3, "恢复可读后过期占位必须被回收并允许下一次重试");

    // 长时间持续不落地：每个 TTL 窗口至多一次重试，绝不无限重试。
    for (let index = 0; index < 10; index += 1) {
      await fixture.advanceClock(SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS + 1000);
      await fixture.sync(2);
    }
    assert.ok(
      fixture.openAttempts.length <= 3 + 10 + 1,
      "重试必须有界（每个窗口至多一次），实际 " + fixture.openAttempts.length,
    );
  } finally {
    fixture.dispose();
  }
});

/** 缺陷 2 的容量面：大量从未落地的占位绝不占满 128 槽位，Auto 仍能正常打开新资源。 */
test("Auto 契约（占位生命周期）：200 个从未落地的占位不占满 128 槽位，Auto 仍能正常打开新资源", async () => {
  const fixture = await installAutoSidebarHarness({
    autoOpen: true,
    children: [{ id: "child-a", status: "running" }],
    inventoryReadCap: 20000,
  });
  try {
    const ledger = sharedAutoLedgerOf();
    assert.ok(ledger !== null && ledger.origin instanceof Map, "夹具必须能观察到 realm 共享的来源账本");
    /**
     * 前置：模拟长会话里 200 次「openResource 发出去了、tab 始终没落地」的占位（含其它 scope 的）。
     * 它们的年龄超过外来的 4 倍期限，因此必须被 TTL 清扫回收。
     */
    ledger.origin.clear();
    const ghosts = [];
    for (let index = 0; index < 200; index += 1) {
      const address = "dsh-resource://subagentchat/session/ghost-" + index + "?parent=ghost&mode=continuable";
      const key = autoKeyOf(address, "ghost", "ghost");
      ghosts.push(key);
      ledger.origin.set(key, {
        sessionId: "ghost",
        rootSessionId: "ghost",
        address,
        tabId: null,
        writtenAt: fixture.now() - SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS - 1000,
      });
    }
    assert.equal(ledger.origin.size, 200, "前置：账本里必须先有 200 条占位（远超 128 上限）");
    // child-a 在装载时就已被自动打开：这条基线只是为了让下面的断言看**增量**。
    const openedBefore = fixture.resources.length;
    assert.equal(openedBefore, 1, "前置：child-a 已经自动打开");

    // 现在再出现一个运行中的资源：它必须能在 200 条占位之后被打开。
    fixture.children.push({
      id: "child-b",
      kind: "expert",
      sessionId: "child-b",
      taskName: "子代理 child-b",
      role: "fixer",
      content: "任务 child-b",
      status: "running",
      continuable: true,
    });
    await fixture.sync(4);
    // 旧行为：占位没有任何生命周期 ⇒ 200 条一直占满账本 ⇒ 容量 fail-closed ⇒ 新的运行中资源开不出来。
    assert.equal(
      fixture.resources.length,
      openedBefore + 1,
      "过期占位被回收之后，Auto 必须仍能正常打开新资源，实际 " + fixture.resources.length,
    );
    assert.ok(
      ledger.origin.size < SIDEBAR_AUTO_KEY_LIMIT,
      "过期占位必须被回收，账本规模必须回到上限之内，实际 " + ledger.origin.size,
    );
    assert.equal(ghosts.some((key) => ledger.origin.has(key)), false, "200 条外来占位必须全部被回收");
  } finally {
    fixture.dispose();
  }
});

test("恢复失败横幅（生成 bundle 路径）：client-bundle.js 同样渲染原因码并在点击后调用 fanout-restore-retry", async () => {
  // 发布物装载路径：直接执行 checked-in 的 client-bundle.js（隔离 realm），
  // 保证「生成文件滞后 / 新代码没进 bundle」会在这里失败。
  const intervals = createFakeIntervals();
  const restore = installGlobals({ setInterval: intervals.setInterval, clearInterval: intervals.clearInterval });
  try {
    const generated = await loadGeneratedSidebarModule();
    const runtime = createClientReactRuntime();
    const requests = [];
    const failedSnapshot = {
      schemaVersion: 1,
      rootSessionId: "root-a",
      generatedAt: 1,
      recovery: {
        status: "failed",
        code: "INVALID_SNAPSHOT",
        message: "快照 shard 结构非法",
        at: 1700000000000,
        retryable: false,
        persistenceBlocked: true,
      },
      root: {
        id: "root-a", kind: "root", sessionId: "root-a", taskName: "根任务", status: "running",
        children: [],
      },
    };
    const sessions = {
      list: {
        getSnapshot: () => ({ current: "root-a", byId: { "root-a": { id: "root-a" } }, projectionsBySession: {} }),
        subscribe: () => () => {},
      },
    };
    const Panel = generated.createExpertGroupPanel({
      react: runtime.react,
      primitives,
      sessions,
      // 面板的真实调用形状：install 注入的 requestPluginRpc(connection, request, init)。
      requestPluginRpc(_connection, request) {
        requests.push(request);
        if (request.action === "fanout-restore-retry") {
          return { ok: true, async json() { return { ok: true, restored: true, restoredCount: 1, deferred: 0, error: null }; } };
        }
        return { ok: true, async json() { return { snapshot: failedSnapshot }; } };
      },
    });
    const handle = runtime.render(Panel, { scope: { sessionId: "root-a" }, ctx: { connection: {} } });
    try {
      await handle.settle();
      const collect = (node, result = []) => {
        if (node === null || node === undefined || node === false) return result;
        result.push(node);
        if (typeof node === "object") for (const child of node.children ?? []) collect(child, result);
        return result;
      };
      const nodes = collect(handle.output);
      const banner = nodes.find((node) => typeof node === "object"
        && String(node.props?.className ?? "").split(/\s+/).includes("deg_expert_group_recovery"));
      assert.ok(banner, "生成 bundle 必须渲染恢复失败横幅");
      assert.equal(banner.props["data-recovery-code"], "INVALID_SNAPSHOT");
      const retry = nodes.find((node) => typeof node === "object"
        && String(node.props?.className ?? "").split(/\s+/).includes("deg_expert_group_recovery_retry"));
      assert.ok(retry, "生成 bundle 必须提供重试恢复入口");
      retry.props.onClick();
      await handle.settle();
      assert.ok(
        requests.some((request) => request.action === "fanout-restore-retry" && request.sessionId === "root-a"),
        "生成 bundle 的重试按钮必须调用 fanout-restore-retry",
      );
    } finally {
      handle.unmount();
    }
  } finally {
    restore();
  }
  assert.equal(intervals.active, 0, "卸载后不得遗留轮询定时器");
});

