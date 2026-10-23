/**
 * 客户端侧栏 · split 同步（R6 / sidebar-split-sync）
 *
 * ## 职责边界（R6 票据 22）
 * 「目标资源是否真的落在这次 split 返回的 pane 里」的全部**读面计算**集中在这里：
 * 右栏 tab 的在场集合、tab/pane 归属、Expert Group pane 识别、可复用子代理 pane 选择、
 * 种子 guide tab 差分，以及等待宿主完成一次布局提交的调度。
 *
 * ## 为什么不持有状态
 * split **事务本身**（意图槽位、令牌、临时扩栏的提交/取消）属于 Panel 实例级状态，
 * 由 client-sidebar-panel-state-a/b 的所有者（Panel 闭包里的 sidebarSplitIntentRef）持有；
 * 本模块只回答「现在的证据是什么」，绝不缓存证据、绝不记住上一次判定。
 * 这样「同一份 DOM/inventory 在同一帧内被问两次必然得到同一答案」，也不会跨帧残留过期证据。
 *
 * ## fail-closed 口径（逐条保留，不得放宽）
 * - 面板解析不出来（读面缺失 / 归属不明确 / 查询抛错）⇒ null 或空集合，调用方保持现状；
 * - 空集合与 null 语义不同：空集合表示「面板在、但确实没有匹配 tab」，那是真实的缺失证据；
 *   null 表示「读不到」，既证明不了存在也证明不了不存在；
 * - 绝不退回 DOM 里第一个面板（别的会话残留的面板会把它自己的 tab 当成本会话的缺失证据）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-split-sync")]
 * 装配：只从 globalThis 检查点取回 pure / dom 依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarSplitSync(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-split-sync");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    RIGHTBAR_TAB_SELECTOR, RIGHTBAR_PANE_COLUMN_ATTRIBUTE, RIGHTBAR_PANE_ID_ATTRIBUTE,
    SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS,
    isGeneratedExpertGroupTabId, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    SUBAGENT_CHAT_KIND, expertGroupTabIdsOf, paneNodesOf, rightbarPanelForSessionCompat,
  } = DOM;

  /**
   * 当前右栏面板里所有 tab 的 id 集合。
   *
   * 读不到「当前右栏面板」（折叠、surface 切换中、宿主还没挂载）、没有 DOM 查询能力、
   * 或查询抛错时统一返回 null——调用方据此保持现有状态。空 Set 表示「面板在、但确实没有
   * 任何 tab」，那是真实的缺失证据，不是「读不到」。
   */
  function presentSidebarTabIds(doc, sidebarSessionId) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    // 只读当前 session 自己的面板：零个匹配（还没挂载 / 不属于这一页）或归属不明确时返回 null，
    // 调用方保持现状；绝不退回 DOM 第一个面板——别的会话残留的面板会把它的 tab 当成
    // 本会话的缺失证据，从而误判「用户收回了 tab」。
    const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
    if (panel === null || panel === undefined) return null;
    if (typeof panel.querySelectorAll !== "function") return null;
    let nodes = null;
    try { nodes = panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR); } catch { return null; }
    if (nodes === null || nodes === undefined) return null;
    let entries = [];
    try { entries = Array.from(nodes); } catch { return null; }
    const ids = new Set();
    for (const node of entries) {
      let raw = null;
      try { raw = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { raw = null; }
      const id = text(raw, null);
      if (id !== null) ids.add(id);
    }
    return ids;
  }

  /**
   * 找到包含指定 tab 的 DockKit pane。
   *
   * openTabs 公开读面只给 tabId/kind/contentId，不提供 paneId；而 openResource 在没有 paneId
   * 且无法再 split 时会回落到 active pane。这里仅读取宿主已经渲染的
   * data-dockkit-pane / data-dockkit-tab 标记，不改 DOM，也不调用宿主内部 split。
   */
  function paneIdsContainingTabs(panel, tabIds, extraMatcher = null) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
    let nodes;
    try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return new Set(); }
    const paneIds = new Set();
    for (const node of nodes) {
      let rawTabId = null;
      try { rawTabId = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { rawTabId = null; }
      const tabId = text(rawTabId, null);
      const matched = tabIds.has(tabId) || (typeof extraMatcher === "function" && extraMatcher(tabId));
      if (!matched) continue;
      const visited = new Set();
      let parent = null;
      try { parent = node?.parentElement ?? node?.parentNode ?? null; } catch { parent = null; }
      while (parent !== null && parent !== undefined && !visited.has(parent)) {
        visited.add(parent);
        let rawPaneId = null;
        try {
          rawPaneId = typeof parent.getAttribute === "function"
            ? parent.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
            : null;
        } catch { rawPaneId = null; }
        const paneId = text(rawPaneId, null);
        if (paneId !== null) {
          paneIds.add(paneId);
          break;
        }
        try { parent = parent.parentElement ?? parent.parentNode ?? null; } catch { parent = null; }
      }
    }
    return paneIds;
  }

  /**
   * 读取某个真实 tab 所在的 DockKit pane。只接受 DOM 明确给出的 paneId；
   * openTabs 没有 paneId 时，inventory 本身不能证明资源没有回落到 Expert Group pane。
   */
  function paneIdContainingTab(doc, sidebarSessionId, tabId) {
    if (doc === null || doc === undefined || typeof doc.querySelector !== "function") return null;
    // 与 existingSubagentPaneId 同源：只认当前 session 面板里的 data-dockkit-pane 标记。
    // 面板解析不出来（读面缺失或归属不明确）时返回 null，split 提交证据继续 fail-closed，
    // 绝不把别的 session 的 paneId 当成「目标资源已经落到本次 split 的 pane」的证据。
    const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
    if (panel === null || panel === undefined) return null;
    const paneIds = paneIdsContainingTabs(panel, new Set([tabId]));
    return paneIds.size === 1 ? [...paneIds][0] : null;
  }

  /**
   * 目标资源的精确提交证据：同一 surface、subagentchat kind、同一 contentId，
   * 并且 DOM 把该 tab 放在本次 split 返回的 pane 中。guide、active-only 或错误 pane
   * 都会继续等待，不会把临时 50% 状态提交成 other 模式。
   *
   * @param {{ doc: Document|null, sidebarSessionId: string, inventory: unknown[]|null,
   *   resourceAddress: string, expectedPaneId?: string|null }} options
   * @returns {{ tabId: string, paneId: string } | null}
   */
  function sidebarSplitTargetEvidence(options) {
    const inventory = options?.inventory ?? null;
    const sidebarSessionId = text(options?.sidebarSessionId, null);
    const resourceAddress = text(options?.resourceAddress, null);
    const expectedPaneId = options?.expectedPaneId === undefined || options?.expectedPaneId === null
      ? null
      : text(options.expectedPaneId, null);
    if (!Array.isArray(inventory) || sidebarSessionId === null || resourceAddress === null) return null;
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
        if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
        if (text(candidate.contentId, null) !== resourceAddress) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId === null) continue;
        const paneId = paneIdContainingTab(options.doc ?? null, sidebarSessionId, tabId);
        if (paneId === null) continue;
        // 同地址可以短暂存在多个 tab：首条记录可能还在旧 pane，必须继续搜索，
        // 直到找到真正落在本次 split 返回 pane 的候选，避免错误 pane 永久遮蔽正确证据。
        if (expectedPaneId !== null && paneId !== expectedPaneId) continue;
        return { tabId, paneId };
      } catch {
        // 单条 inventory 损坏时继续检查其余记录。
      }
    }
    return null;
  }

  /**
   * 读取当前 DOM 中 Expert Group 所在的 pane 集合。
   *
   * 这个集合只由公开的 tab/pane 标记构成：inventory 用来把 kind 映射成真实 tabId，
   * DOM 用来确认 tab 的实际 pane。没有证据时返回空集合，调用方必须保持 fail-closed。
   */
  function expertGroupPaneIds(panel, inventory, sidebarSessionId) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
    // tabId 集合来自共享读面 helper（与分栏配比那条路径同源，避免两处判定漂移）。
    return paneIdsContainingTabs(
      panel,
      expertGroupTabIdsOf(inventory, sidebarSessionId),
      isGeneratedExpertGroupTabId,
    );
  }

  /**
   * 解析已有的子代理目标 pane。
   *
   * 首次打开时只有 Expert Group pane，返回 null 让打开流程通过公开 split() 创建子代理 pane；
   * 已经存在多个 pane 时，选最右侧且不包含 Expert Group 的 pane，并显式传给 openResource。
   * 这样后续所有 >> 都复用同一个右侧 pane，不会因为 active pane 恰好在左侧而回落到左侧。
   * DOM 读面缺失、pane/tab 结构不完整或查询抛错时统一返回 null，保留旧宿主兼容语义。
   */
  function existingSubagentPaneId(doc, sidebarSessionId, inventory) {
    if (!doc || typeof doc.querySelector !== "function") return null;
    // 归属边界：pane 只能从**当前 session 自己的面板**里复用。同一次 install 里 DOM 可能同时
    // 残留多个 session 的面板（React 重挂载窗口），querySelector 的首个命中无法证明归属；
    // 解析不出来时保持 null，让打开流程决定是先 split 还是走旧宿主兼容分支——绝不把别的
    // session 的 paneId 传给 openResource（那会让资源落到别人的右栏布局上）。
    const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
    const expertPaneIds = expertGroupPaneIds(panel, inventory, sidebarSessionId);
    // 没有任何证据证明哪个 pane 是 Expert Group 时，不能把最右 pane 猜成安全目标；
    // 保持 null，让打开流程决定是调用公开 split() 还是走旧宿主兼容分支。
    if (expertPaneIds.size === 0) return null;
    // 候选 pane 与它们的 DOM 顺序/列号：这里刻意只用 pane 标识与列号判定（pane 读面本身
    // 读不到时才 fail-closed），绝不复用分栏配比那条更严的 pane 组成读面——否则一个读不到
    // tabId 的 pane 就会让「复用已有子代理 pane」退化成再 split 一个新 pane。
    const panes = paneNodesOf(panel);
    if (panes === null) return null;
    const candidates = [];
    for (let index = 0; index < panes.length; index += 1) {
      const pane = panes[index];
      let rawPaneId = null;
      try {
        rawPaneId = typeof pane?.getAttribute === "function"
          ? pane.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
          : null;
      } catch { rawPaneId = null; }
      const paneId = text(rawPaneId, null);
      if (paneId === null || expertPaneIds.has(paneId)) continue;
      let rawColumn = null;
      try {
        rawColumn = typeof pane?.getAttribute === "function"
          ? pane.getAttribute(RIGHTBAR_PANE_COLUMN_ATTRIBUTE)
          : null;
      } catch { rawColumn = null; }
      const columnText = text(rawColumn, null);
      const column = columnText === null ? null : Number(columnText);
      candidates.push({ paneId, column: Number.isFinite(column) ? column : null, index });
    }
    candidates.sort((left, right) => {
      if (left.column !== null && right.column !== null && left.column !== right.column) {
        return right.column - left.column;
      }
      if (left.column !== null && right.column === null) return -1;
      if (left.column === null && right.column !== null) return 1;
      return right.index - left.index;
    });
    return candidates[0]?.paneId ?? null;
  }

  /**
   * split() 会按宿主 seed 规则先放入一个 guide tab。公开 openTabs 不带 paneId，
   * 只有同一 session 的 split 前后 tabId 差分中恰好一个新增 kind=guide，才足以唯一识别这次
   * 新建 pane 的种子；inventory 延迟、跨 session、并发新增多个 guide 或记录损坏时都 fail-closed，
   * 避免把其它并发提交的 tab 错当成 replaceTab。
   */
  function seededGuideTabId(beforeTabs, sessionId, afterTabs) {
    const expectedSessionId = text(sessionId, null);
    if (expectedSessionId === null || !Array.isArray(beforeTabs)) return null;
    const beforeIds = new Set();
    for (const tab of beforeTabs) {
      try {
        const candidate = object(tab);
        if (text(candidate.sessionId, null) !== expectedSessionId) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId !== null) beforeIds.add(tabId);
      } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
    }
    if (!Array.isArray(afterTabs)) return null;
    const newGuideTabIds = [];
    for (const tab of afterTabs) {
      try {
        const candidate = object(tab);
        if (text(candidate.sessionId, null) !== expectedSessionId
          || text(candidate.kind, null) !== "guide") continue;
        const tabId = text(candidate.tabId, null);
        if (tabId !== null && !beforeIds.has(tabId)) newGuideTabIds.push(tabId);
      } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
    }
    return newGuideTabIds.length === 1 ? newGuideTabIds[0] : null;
  }

  /**
   * 等宿主完成一次布局提交，再读取 DockLayout 的可分栏判定。
   *
   * \`layout.panels\` 的 setRightbar action 只同步派发 store 更新；真实宿主的 \`DockLayout\`
   * 通过 React 提交后才会更新 \`onRoom\` 读面，而 \`sidebarRight.split()\` 会立即读取这个
   * 读面。若在同一调用栈内 split，宿主仍可能看到旧的窄栏并弹出「栏宽不足」。
   * 优先使用 RAF，让 React 的 layout effect 和浏览器布局先完成；无 RAF 的旧宿主退回
   * 一个宏任务，再退回 microtask。这个等待只发生在新版 install 注入的 split 事务里，
   * 旧宿主没有事务入口时仍保持原同步兼容路径。
   *
   * 调度器全部从 globalThis 现读（测试替身可替换），并且 settle 幂等：任何一条路径先到
   * 都会清掉 fallback timer，绝不留下悬挂的定时器。
   */
  function waitForSidebarSplitLayoutCommit() {
    return new Promise((resolve) => {
      let settled = false;
      let fallbackTimer = null;
      const clearFallback = () => {
        if (fallbackTimer === null) return;
        try { globalThis.clearTimeout?.(fallbackTimer); } catch { /* 清理失败时 callback 仍会由 settled 防重。 */ }
        fallbackTimer = null;
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        clearFallback();
        resolve();
      };
      const scheduleFallback = (delay) => {
        try {
          const setTimeout = globalThis.setTimeout;
          if (typeof setTimeout !== "function" || settled) return false;
          fallbackTimer = setTimeout(settle, delay);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const requestAnimationFrame = globalThis.requestAnimationFrame;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => settle());
          // 视觉帧可能被后台标签页节流；fallback 只负责结束等待，随后仍由事务检查决定是否 split。
          if (scheduleFallback(SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS)) return;
        }
      } catch { /* 继续尝试不依赖视觉帧的宿主调度器。 */ }
      if (scheduleFallback(0)) return;
      try {
        const queueMicrotask = globalThis.queueMicrotask;
        if (typeof queueMicrotask === "function") {
          queueMicrotask(settle);
          return;
        }
      } catch { /* 最后的同步收口保证 Promise 不会永久悬挂。 */ }
      settle();
    });
  }

  // 只暴露主 IIFE 实际消费的符号（无全量外挂）。
  // 只暴露主 IIFE 实际消费的符号：paneIdsContainingTabs / paneIdContainingTab / expertGroupPaneIds
  // 是本模块内部的读面组合，主 IIFE 不直接调用，因此不外挂（避免扩大跨模块表面）。
  global[SYMBOL] = Object.freeze({
    existingSubagentPaneId,
    presentSidebarTabIds,
    seededGuideTabId,
    sidebarSplitTargetEvidence,
    waitForSidebarSplitLayoutCommit,
  });
})(globalThis);
