/**
 * 设置页导航行的品牌图标（DOM 适配）（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-nav-icon")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientNavIcon(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-nav-icon");
  const clientExpertGroupSidebarSymbol = Symbol.for("dsh-expert-group/client-expert-group-sidebar");
  const expertGroupSidebar = global[clientExpertGroupSidebarSymbol] || {};

    // ── 设置页导航行的品牌图标（DOM 适配）──────────────────────────────────────
    /**
     * DEG 在宿主 settings.section ledger 里的条目 id，同时也是导航行显示的 label
     * （注册时的 label 固定回投射成这个 id）。设置页导航图标适配靠它定位目标行，因此提升到
     * 模块作用域：与 apply 内的注册共用同一个来源，不出现第二份字面量。
     */
    const DEG_SETTINGS_SECTION_ID = "dsh-expert-group";
    /** 适配标记：按钮 / 宿主原生 svg / DEG 自有 svg 各一个（同时被 CSS 选择器使用）。 */
    const DEG_SETTINGS_NAV_ATTR = "data-deg-settings-nav";
    const DEG_SETTINGS_NAV_NATIVE_ATTR = "data-deg-settings-nav-native";
    const DEG_SETTINGS_NAV_ICON_ATTR = "data-deg-settings-nav-icon";
    /** 设置页导航栏里其它行都是 1.3px 描边的 Medium 图标；宿主未给出描边宽度时按它回落。 */
    const DEG_SETTINGS_NAV_STROKE_FALLBACK = "1.3";

    /**
     * 品牌图标路径数据的兜底副本（双人 users 图标，与宿主「智能体团队」入口同源）。
     *
     * 运行期优先取 client-expert-group-sidebar.js 导出的 BRAND_ICON_PATHS（唯一一份 artwork，
     * 侧栏 tab / guide 图标与这里共用），只有侧栏 IIFE 缺失（契约外直接加载 client.js、被裁剪的
     * 装配产物）时才用这份逐字节同值的字面量，保证设置页图标不因缺模块而消失。
     * 两处一致性由 test/expert-group-sidebar-contract.test.mjs 断言。
     */
    const DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS = Object.freeze([
      "M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
      "M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
      "M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
      "M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
    ]);
    const DEG_SETTINGS_NAV_ICON_PATHS = (() => {
      const shared = expertGroupSidebar?.BRAND_ICON_PATHS;
      if (Array.isArray(shared) && shared.length > 0 && shared.every((item) => typeof item === "string")) return shared;
      return DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
    })();

    /**
     * 这个元素是不是 DEG 在设置面板里的导航行？
     *
     * 只认「可见文本严格等于 DEG 注册的 label，且含 svg 子元素」的节点：
     * - 文本取自 textContent.trim()（label 是按钮内 span 的文本，真实 DOM 的 textContent 会
     *   把后代文本拼起来），严格相等因此能排除 "dsh-expert-group-status" 之类的近似行；
     * - svg 的存在保证「有图标可换」——没有图标的行不动，避免给非目标行插图标；
     * - 绝不使用宿主 CSS module 的哈希类名（构建产物一变就失配）。
     *
     * 任何读取失败（节点代理抛错、querySelector 不可用）都按「不是目标行」处理。
     */
    function isDegSettingsNavRow(element) {
      if (element === null || typeof element !== "object") return false;
      try {
        if (typeof element.textContent !== "string" || element.textContent.trim() !== DEG_SETTINGS_SECTION_ID) return false;
        if (typeof element.querySelector !== "function") return false;
        const native = element.querySelector("svg");
        return native !== null && native !== void 0;
      } catch {
        return false;
      }
    }

    /**
     * 构造 DEG 自有的品牌 svg（与侧栏图标同一组 4 条 path）。
     *
     * 描边宽度沿用宿主原图标的值（宿主 Medium 图标为 1.3px），缺失时回落到同一数值：
     * 换掉图标后视觉重量必须与同一导航栏里其它行一致，不能变成明显更细或更粗的一行。
     */
    function createDegSettingsNavIcon(doc, strokeWidth) {
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute(DEG_SETTINGS_NAV_ICON_ATTR, "");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", strokeWidth);
      svg.setAttribute("aria-hidden", "true");
      for (const d of DEG_SETTINGS_NAV_ICON_PATHS) {
        const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("fill", "none");
        svg.appendChild(path);
      }
      return svg;
    }

    /**
     * 设置页导航行的品牌图标适配（宿主设置面板由 DSH 渲染，导航行图标来自 SettingsRoot 里按
     * section id 硬编码的 navIcon(id)，未知 id 回退齿轮；`settings.section` 注册只投影
     * id/order/label，插件无法用注册字段声明图标，因此只能在客户端做 DOM 适配）。
     *
     * 做法与边界：
     * 1. 定位：`[role="dialog"]` 内的按钮里，可见文本严格等于 "dsh-expert-group" 且含 svg 的那一行；
     * 2. **不替换**宿主 svg 的内容，只给它加标记交给 CSS 隐藏——React 重新渲染该行时会按 fiber
     *    位置回写自己那些 path 节点，改写宿主 svg 的内部结构会被下一次提交覆盖回去；
     * 3. 自造 svg 插到按钮第一个子节点之前：按钮是 display:flex;gap:8px，图标在最左，
     *    label 的位置与宿主自己的布局语义都不受影响；
     * 4. 幂等：sync 会先把行内**所有**非自有 svg 重新标成原生图标（宿主重渲染后标记可能丢失，
     *    这正是自愈路径），自有图标已在位就只补标记，绝不重复插入；
     * 5. 健壮性：DOM / observer / createElementNS / 选择器任何一步不可用都静默 no-op——
     *    设置页图标只是外观，绝不能影响插件入口、设置页或侧边栏本身的功能。
     *
     * 成本：observer 观察整个 body 子树（与 SubagentMetadataBridge 同一策略）。每次回调只做
     * 一次 `[role="dialog"]` 查询；设置面板关闭时该查询直接返回空集合，因此普通会话的 DOM
     * 变更不产生可见开销。
     *
     * @returns {() => void} disposer：断开 observer 并清掉全部标记与自有 svg。
     */
    function installDegSettingsNavIcon() {
      const doc = typeof document !== "undefined" ? document : null;
      const root = doc?.body ?? doc?.documentElement ?? null;
      if (doc === null || root === null || typeof doc.querySelectorAll !== "function") return () => {};
      let observer = null;
      let disposed = false;

      /** 单个候选行的适配（幂等 + 自愈，见上面的第 2/4 条）。 */
      const syncRow = (row) => {
        if (typeof row.querySelectorAll !== "function" || typeof row.setAttribute !== "function") return;
        const nativeSvgs = [];
        let ownIcon = null;
        for (const svg of row.querySelectorAll("svg")) {
          if (typeof svg.getAttribute !== "function") continue;
          if (svg.getAttribute(DEG_SETTINGS_NAV_ICON_ATTR) !== null) ownIcon = svg;
          else nativeSvgs.push(svg);
        }
        if (ownIcon === null) {
          // 首次适配：缺少 SVG 构造/插入能力（极旧的替身 DOM）时整行保持原样。
          if (typeof doc.createElementNS !== "function" || typeof row.insertBefore !== "function") return;
          const native = nativeSvgs[0];
          const inherited = native === undefined ? null : native.getAttribute("stroke-width");
          const strokeWidth = typeof inherited === "string" && inherited.trim() !== ""
            ? inherited
            : DEG_SETTINGS_NAV_STROKE_FALLBACK;
          ownIcon = createDegSettingsNavIcon(doc, strokeWidth);
          // 插到第一个子节点之前：图标列在最左，label 与宿主后续插入的节点位置不变。
          row.insertBefore(ownIcon, row.firstChild ?? null);
        }
        for (const svg of nativeSvgs) svg.setAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR, "");
        row.setAttribute(DEG_SETTINGS_NAV_ATTR, "");
      };

      /** 幂等同步：命中一行的条件是「label 严格相等 + 含 svg」，已适配的行只补标记。 */
      const sync = () => {
        if (disposed) return;
        try {
          for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
            if (typeof dialog?.querySelectorAll !== "function") continue;
            for (const row of dialog.querySelectorAll("button")) {
              if (isDegSettingsNavRow(row) !== true) continue;
              syncRow(row);
            }
          }
        } catch {
          // 选择器或宿主节点代理抛错：保持 no-op，下一次 observer 回调再试，绝不外泄异常。
        }
      };

      /** dispose 清理：全量清掉标记与自有 svg；宿主重渲染后已断开的节点同样安全跳过。 */
      const cleanup = () => {
        try {
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_ATTR + "]")) node.removeAttribute(DEG_SETTINGS_NAV_ATTR);
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_NATIVE_ATTR + "]")) node.removeAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR);
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_ICON_ATTR + "]")) {
            // 移除自己插入的节点；节点已游离时 remove() 是安全的空操作。
            if (typeof node.remove === "function") node.remove();
          }
        } catch {
          // 清理失败不能阻断卸载（标记属性本身无害，下次挂载会重新适配）。
        }
      };

      sync();
      const Observer = doc?.defaultView?.MutationObserver
        ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
      if (typeof Observer === "function") {
        try {
          observer = new Observer(() => { sync(); });
          observer.observe(root, { childList: true, subtree: true });
        } catch {
          // observer 装不上（宿主替身/权限异常）：保留已经完成的一次性适配，不再跟进重渲染。
          observer = null;
        }
      }
      return () => {
        if (disposed) return;
        disposed = true;
        try {
          observer?.disconnect();
        } catch {
          // 断开失败不阻断清理。
        }
        observer = null;
        cleanup();
      };
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    DEG_SETTINGS_SECTION_ID, DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS, DEG_SETTINGS_NAV_ICON_PATHS, isDegSettingsNavRow, installDegSettingsNavIcon,
  });
})(globalThis);
