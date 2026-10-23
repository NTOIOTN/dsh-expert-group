/**
 * 客户端侧栏 · 原生右栏「视觉连续性遮罩」— R6 / sidebar-overlay
 *
 * ## 职责边界（R6 票据 23）
 * 只负责「旧 panel 已删、新 panel 未开」这段 DOM 空窗里的**非交互视觉壳**：抢拍旧 panel 的
 * 克隆、固定定位、监听新 panel 打开或 500ms 兜底释放。它不改动任何 Panel 状态，也不读取用户数据。
 *
 * ## 为什么单独成模块
 * 这段代码只在 openSurfaceTab 前后被调用一次，与 Panel 的 React 渲染完全无关（纯 DOM）；
 * 它的唯一外部依赖是 globalThis.document 与 Object.freeze，因此是视图层里最干净的切面。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-overlay")]
 */
(function installClientSidebarOverlay(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-overlay");

  /**
   * 原生右栏「视觉连续性遮罩」（仅 DEG 侧补偿，**不是动画抑制**）。
   *
   * 真实诊断闭环：root→child 时 DSH 原生 RightbarSeat 的 surface 按 session key 重挂载——current
   * 变化后旧 [data-sidebar-right-panel] 先被移除，新 panel 稍后才挂上（仍是 collapsed），直到 DEG
   * openSurfaceTab 之后新 panel 才拿到 data-sidebar-right-open。这段「旧已删、新未开」的 DOM 空窗里
   * 右栏整块消失；transition/transform/visibility 抑制只能作用于存在的节点，覆盖不到它。
   *
   * 因此在 openSurfaceTab 之前把旧 panel 的**非交互视觉壳**克隆一份钉在旧位置：
   * - 只复制上一帧的视觉结构：clone 子树所有 id 移除（避免 DOM id 重复）、输入控件清空
   *   value/textContent（绝不携带、也绝不读取用户数据）；
   * - host 固定定位、pointer-events:none、aria-hidden=true、overflow:hidden、z-index 高于 panel：
   *   不拦截交互、不进入可访问性树、不影响布局；
   * - 新 panel 真正 open（不同节点 + data-sidebar-right-open + aria-hidden 非 true）或 500ms 兜底
   *   到点即移除；每次只允许一个遮罩，新一次 capture 先释放旧的；
   * - 绝不调用 layout/openRightbar、不触发 session 导航、不改动旧/新 panel 的 style；
   * - 任何 DOM API 缺失或异常都安全降级为「不创建遮罩」，绝不影响打开流程。
   */
  const RIGHTBAR_CONTINUITY_OVERLAY_ID = "dsh-expert-group-rightbar-continuity-overlay";
  /** 兜底释放时间（毫秒）：新 panel 迟迟不 open 时绝不长期遮盖 UI。 */
  const RIGHTBAR_CONTINUITY_FALLBACK_MS = 500;
  function createNativeRightbarContinuityOverlay() {
    let host = null;
    let observer = null;
    let timer = null;
    let originalPanel = null;

    const removeHost = (element) => {
      if (element === null || element === undefined) return;
      try {
        if (typeof element.remove === "function") element.remove();
        else element.parentNode?.removeChild?.(element);
      } catch { /* 移除失败也不能留下引用 */ }
    };
    /** 幂等释放：清 timer、断开 observer、移除宿主。 */
    const release = () => {
      if (timer !== null) {
        try { globalThis.clearTimeout?.(timer); } catch { /* 可选 API */ }
        timer = null;
      }
      if (observer !== null) {
        try { observer.disconnect?.(); } catch { /* 可选 API */ }
        observer = null;
      }
      const current = host;
      host = null;
      originalPanel = null;
      removeHost(current);
      return true;
    };
    /** 是否已经出现「不同于旧节点、并且真的 open」的原生 panel。 */
    const hasOpenedPanel = () => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelectorAll !== "function") return false;
      let panels = [];
      try { panels = Array.from(doc.querySelectorAll("[data-sidebar-right-panel]") ?? []); } catch { return false; }
      for (const candidate of panels) {
        if (candidate === null || candidate === undefined || candidate === originalPanel) continue;
        if (isOwnOverlayNode(candidate) === true) continue; // 遮罩内部的克隆不算新 panel
        try {
          if (typeof candidate.hasAttribute !== "function" || candidate.hasAttribute("data-sidebar-right-open") !== true) continue;
          if (typeof candidate.getAttribute === "function" && candidate.getAttribute("aria-hidden") === "true") continue;
          return true;
        } catch { /* 单个候选读取失败继续看其它 */ }
      }
      return false;
    };
    /** 遮罩宿主自身或其中的节点（遮罩绝不能把自己算成「新 panel」，也不能被别的探测命中）。 */
    const isOwnOverlayNode = (node) => {
      if (host === null || node === null || node === undefined) return false;
      try {
        let current = node;
        for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
          if (current === host) return true;
          current = current.parentNode ?? null;
        }
      } catch { return false; }
      return false;
    };
    /**
     * 只清理非交互视觉壳：移除 id（避免 DOM id 重复）、把克隆降级为纯视觉节点
     * （去掉 data-sidebar-right-panel，否则遮罩自己的克隆会被当成「新 panel」而瞬间自我释放，
     * 也可能被右栏探测当成真实面板）、清空输入控件；不读取任何值。
     * data-sidebar-right-open 必须保留：原生 CSS 用它决定 panel 是展开还是 collapsed，
     * 去掉后克隆会渲染成滑出屏幕的 collapsed 状态，遮罩就失去意义了。
     */
    const scrubClone = (node, depth = 0) => {
      if (node === null || node === undefined || depth > 12) return;
      try { node.removeAttribute?.("id"); } catch { /* 单个节点失败继续 */ }
      try { node.removeAttribute?.("data-sidebar-right-panel"); } catch { /* 同上 */ }
      try {
        const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          node.value = "";
          node.textContent = "";
        }
      } catch { /* 同上 */ }
      let children = [];
      try { children = Array.from(node.childNodes ?? node.children ?? []); } catch { children = []; }
      for (const child of children) scrubClone(child, depth + 1);
    };
    const observeBody = () => {
      const doc = globalThis.document;
      const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
      const body = doc?.body ?? null;
      if (typeof Observer !== "function" || body === null || typeof body !== "object") return;
      try {
        observer = new Observer(() => { if (hasOpenedPanel() === true) release(); });
        observer.observe(body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-sidebar-right-open", "aria-hidden"],
        });
      } catch {
        try { observer?.disconnect?.(); } catch { /* 忽略 */ }
        observer = null;
      }
    };
    const startFallback = () => {
      try {
        timer = globalThis.setTimeout(() => { timer = null; release(); }, RIGHTBAR_CONTINUITY_FALLBACK_MS);
      } catch { timer = null; /* 没有可用调度器：最坏情况由调用方 release */ }
    };
    /** 抢拍旧 panel 的视觉壳；返回幂等 release（供访问终止路径收口）。没有可复制目标时返回 null。 */
    const capture = () => {
      release(); // 每次只允许一个遮罩
      const doc = globalThis.document;
      if (!doc || typeof doc.createElement !== "function" || doc.body === null || doc.body === undefined) return null;
      let panel = null;
      try { panel = typeof doc.querySelector === "function" ? doc.querySelector("[data-sidebar-right-panel]") : null; } catch { panel = null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try { rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null; } catch { rect = null; }
      if (rect === null || typeof rect !== "object") return null;
      const left = Number(rect.left);
      const top = Number(rect.top);
      const width = Number(rect.width);
      const height = Number(rect.height);
      // 定位拿不到有效数字时不创建：宁可没有遮罩，也不能把 fixed 层丢到左上角盖住 UI。
      if ([left, top, width, height].every((value) => Number.isFinite(value)) !== true) return null;
      let clone = null;
      try { clone = typeof panel.cloneNode === "function" ? panel.cloneNode(true) : null; } catch { clone = null; }
      if (clone === null || clone === undefined) return null;
      let created = null;
      try {
        scrubClone(clone);
        try {
          if (clone.style !== undefined && clone.style !== null) clone.style.pointerEvents = "none";
        } catch { /* host 本身已经 pointer-events:none */ }
        removeHost(typeof doc.getElementById === "function" ? doc.getElementById(RIGHTBAR_CONTINUITY_OVERLAY_ID) : null);
        created = doc.createElement("div");
        created.id = RIGHTBAR_CONTINUITY_OVERLAY_ID;
        created.setAttribute("aria-hidden", "true");
        created.setAttribute("style",
          "position:fixed;z-index:2147482999;pointer-events:none;overflow:hidden;background:inherit;"
          + "left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;");
        created.appendChild(clone);
        doc.body.appendChild(created);
      } catch {
        removeHost(created);
        return null;
      }
      host = created;
      originalPanel = panel;
      // 新 panel 可能已经在这次同步提交里 open（例如 openTab 已提交）→ 立刻检查一次。
      if (hasOpenedPanel() === true) {
        release();
        return release;
      }
      observeBody();
      startFallback();
      return release;
    };
    return Object.freeze({ capture, release });
  }

  global[SYMBOL] = Object.freeze({ createNativeRightbarContinuityOverlay });
})(globalThis);
