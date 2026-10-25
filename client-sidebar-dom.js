/**
 * 客户端侧栏 · 样式注入与右栏 DOM 解析（R5 / sidebar-dom）
 *
 * 宿主右栏的只读观测面：元素查询、右栏 panel / tab / pane / split 结构解析、
 * 拖拽手柄选择器、样式表注入与品牌图标构造，以及会话投影的读取助手。
 *
 * 本模块不写业务状态：解析结果只作为「组成是否可证明」的证据返回给调用方；
 * 样式注入保持幂等（同一 STYLE_ID 只挂一份 style 标签）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-dom")]
 * 装配：只从 globalThis 检查点取回依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarDom(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    BRAND_ICON_PATHS, EXPERT_GROUP_TAB_IDS, RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_DOCK_HOST_VALUE, RIGHTBAR_PANEL_SELECTOR, RIGHTBAR_PANEL_SESSION_ATTRIBUTE, RIGHTBAR_PANE_COLUMN_ATTRIBUTE, RIGHTBAR_PANE_SELECTOR, RIGHTBAR_SPLIT_ATTRIBUTE, RIGHTBAR_SPLIT_SELECTOR, RIGHTBAR_STRIP_TABS_ATTRIBUTE, RIGHTBAR_STRIP_TABS_SELECTOR, RIGHTBAR_TAB_ID_ATTRIBUTE, RIGHTBAR_TAB_SELECTOR, RUNTIME_STATE_DOT, RUNTIME_STATUS_LABELS, SIDEBAR_TAB_KEY_SEPARATOR, STYLE_ID, modelApi, object, text,
  } = PURE;

  function viewportWidthOf() {
    let value = null;
    try { value = globalThis.window?.innerWidth ?? globalThis.innerWidth; } catch { value = null; }
    const width = Number(value);
    return Number.isFinite(width) && width > 0 ? width : null;
  }

  /**
   * 元素查询的三种结果。**必须区分「没命中」与「读面有歧义」**，两者对调用方的含义完全不同：
   *
   * - `missing`：这个选择器在当前 DOM 里确实一个都没命中。它表示「当前宿主版本没有这个读法」，
   *   调用方可以继续尝试其它选择器；
   * - `unique`：恰好命中一个元素，可以当作证据使用；
   * - `ambiguous`：命中多个（读面有歧义，例如新旧 frame 同时残留），或查询本身抛错 / 读面不可用
   *   （无 document、没有 querySelectorAll、代理抛错）。它**不是**「这个读法不存在」，因此绝不允许
   *   被别的选择器「兜底」掩盖掉——把多命中降级成 missing 会让旧节点的唯一候选冒充当前 AppFrame。
   */
  const ELEMENT_QUERY_MISSING = "missing";
  const ELEMENT_QUERY_UNIQUE = "unique";
  const ELEMENT_QUERY_AMBIGUOUS = "ambiguous";

  /**
   * 查询一个选择器，返回 `{ status, element }`（element 只在 unique 时非 null）。
   *
   * 只返回这三种状态，任何异常都归一为 `ambiguous`（读不出来 ≠ 读到了空），绝不抛给调用方，
   * 也绝不按 DOM 顺序取第一个命中：第一个命中无法证明它就是目标元素。
   */
  function elementQueryOf(doc, selector) {
    let nodes = null;
    try {
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") {
        return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
      }
      nodes = Array.from(doc.querySelectorAll(selector));
    } catch {
      return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    }
    if (nodes.length === 0) return { status: ELEMENT_QUERY_MISSING, element: null };
    if (nodes.length > 1) return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    return { status: ELEMENT_QUERY_UNIQUE, element: nodes[0] };
  }

  /**
   * 解析当前宿主的 AppFrame 根元素；无法**唯一**定位时返回 null。
   *
   * 只用宿主公开的 DOM 标记，与本文件既有的 AppFrame 读法（rightbarTransitionTargets）一致：
   * 1. 主读法 [data-shell-overlay]：覆盖层是 AppFrame 的**直接子节点**，其 parentElement 即 AppFrame；
   * 2. 兜底 [data-rightbar-collapsed] / [data-rightbar-instant]：AppFrame 自己的公开状态属性
   *    （旧宿主可能没有覆盖层）。
   *
   * 歧义传播规则（本函数的 fail-closed 边界）：
   * - 任何一个选择器**多命中或查询异常** → 立刻返回 null，不再看后面的读法：此时读面已经不可信，
   *   让另一个选择器的唯一候选去「兜底」等于用旧 frame 冒充当前 AppFrame；
   * - 只有真正 `missing`（零命中）才继续尝试下一个选择器；
   * - 候选元素去重后必须**恰好一个**：零个表示定位不到 AppFrame，多个不同元素表示读面有歧义
   *   （比如新旧 frame 同时残留），两者都返回 null——调用方按「读不到」处理，绝不挑一个猜。
   */
  function appFrameElementOf(doc) {
    const candidates = [];
    const push = (element) => {
      if (element === null || element === undefined || element.nodeType !== 1) return;
      if (candidates.includes(element) === false) candidates.push(element);
    };
    const overlay = elementQueryOf(doc, "[data-shell-overlay]");
    if (overlay.status === ELEMENT_QUERY_AMBIGUOUS) return null;
    if (overlay.status === ELEMENT_QUERY_UNIQUE) {
      let parent = null;
      try { parent = overlay.element.parentElement ?? null; } catch { parent = null; }
      push(parent);
    }
    for (const selector of ["[data-rightbar-collapsed]", "[data-rightbar-instant]"]) {
      const state = elementQueryOf(doc, selector);
      if (state.status === ELEMENT_QUERY_AMBIGUOUS) return null;
      if (state.status === ELEMENT_QUERY_UNIQUE) push(state.element);
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 读取当前宿主 AppFrame 的宽度（px）；定位不到、尺寸非法时返回 null。
   *
   * 为什么不能拿 window.innerWidth 顶替：宿主 LayoutController 维护的 layout store 里那份
   * viewportWidth 是用 **AppFrame 根元素的 getBoundingClientRect().width** 更新的，它是右栏宽度
   * 上限 clamp 的参照系，并不恒等于 window.innerWidth（页面缩放、滚动条、外层留白、嵌入形态都会
   * 让两者不等）。把 innerWidth 写进宿主那个权威槽位等于换了一个量去改宿主的判据：frame 比 window
   * 窄时反而抬高上限，写出宿主自己永远不会写的宽度。
   *
   * fail-closed 边界（绝不猜测宿主尺寸）：
   * - AppFrame 定位不到或归属有歧义（见 appFrameElementOf）→ null；
   * - 解析结果就是 document.body / document.documentElement → null：它们是「整个文档」，
   *   不是 AppFrame，宽度语义完全不同，绝不拿它们顶替；
   * - 没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数 → null。
   */
  function hostAppFrameWidthOf() {
    try {
      const doc = globalThis.document;
      const frame = appFrameElementOf(doc);
      if (frame === null) return null;
      if (frame === doc?.body || frame === doc?.documentElement) return null;
      const rect = typeof frame.getBoundingClientRect === "function" ? frame.getBoundingClientRect() : null;
      if (rect === null || typeof rect !== "object") return null;
      const width = Number(rect.width);
      return Number.isFinite(width) && width > 0 ? width : null;
    } catch { return null; }
  }

  /**
   * 取一个方法而不读取它的调用形态。
   *
   * Cordis 的服务代理对未声明属性可能直接抛错，因此属性读取一律包在 try 里；
   * 只返回「确实是函数」的候选，其它（缺失、proxy 抛错、非函数属性）统一按 null 处理，
   * 调用方据此走兼容路径而不是拿到一个到调用时才炸的引用。
   */
  function methodOf(target, name) {
    if (target === null || target === undefined) return null;
    try {
      const candidate = target[name];
      return typeof candidate === "function" ? candidate : null;
    } catch { return null; }
  }

  /**
   * 安全解析一个可选客户端服务（uiWorkspace / sidebarRight / sessions 等）。
   *
   * 每个候选项都按「get(name) → 直接属性」两段式探测：Cordis 的服务代理对未声明服务的
   * 属性读取会抛错，任何一层失败都只表示「这个候选项没有它」，继续看下一个。
   * 查找顺序由调用方给出（本插件约定：显式注入的 deps → tab 的 props.ctx → install ctx），
   * 全部未命中返回 null —— 调用方必须据此走兼容路径，绝不把异常带进渲染路径。
   */
  function resolveClientService(candidates, name) {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      try {
        if (typeof candidate.get === "function") {
          const value = candidate.get(name);
          if (value !== null && value !== undefined) return value;
        }
      } catch { /* 未声明服务读取即抛错：按「该候选没有它」处理。 */ }
      try {
        const value = candidate[name];
        if (value !== null && value !== undefined) return value;
      } catch { /* 同上。 */ }
    }
    return null;
  }

  /**
   * DSH 原生 subagentchat 侧栏资源地址前缀。
   * 与 `@deepseek-ai/dsh-client-ui-subagent` 的 SUBAGENT_CHAT_ADDRESS 同值：
   * 地址由宿主原生 tab 类型解析，插件只负责生成同一个规范形状。
   */
  const SUBAGENT_CHAT_ADDRESS_PREFIX = "dsh-resource://subagentchat/session/";
  /** `sidebarRight.openResource` 的 kind：声明「这个地址由 subagentchat tab 认领」。 */
  const SUBAGENT_CHAT_KIND = "subagentchat";
  /**
   * 目录项 mode 的三个规范值（0.1.7-alpha.2 新增 `unknown`）。
   *
   * `unknown` 表示宿主的父目录只保留了身份、尚未解析出可续接性（读取 child 会话历史后才能确定）。
   * 插件因此按**不可续接**降级展示：地址照旧可构造（宿主原生主视图与侧栏都能处理该值），
   * 但不显示任何「可继续」相关文案或续接入口。已知模式（one-shot / continuable）行为完全不变。
   */
  const SUBAGENT_MODES = new Set(["one-shot", "continuable", "unknown"]);

  /**
   * 把任意来源的地址候选归一为 SubagentAddress（{ parentSessionId, childSessionId, mode }）。
   *
   * 只接受三个字段齐全、mode 是规范值（含新增的 `unknown`）的对象；字段名兼容 DSH 的正式命名
   * 与目录项里常见的别名（parentId / id / sessionId），任何缺失或非法值都返回 null（fail-closed）。
   */
  function normalizeSubagentAddress(value) {
    const source = object(value);
    const parentSessionId = text(source.parentSessionId, text(source.parentId, null));
    const childSessionId = text(source.childSessionId, text(source.id, text(source.sessionId, null)));
    const mode = text(source.mode, null);
    if (parentSessionId === null || childSessionId === null || mode === null) return null;
    if (SUBAGENT_MODES.has(mode) !== true) return null;
    return { parentSessionId, childSessionId, mode };
  }

  /**
   * 构造 subagentchat 资源地址：
   * `dsh-resource://subagentchat/session/<encodeURIComponent(child)>?parent=<URLSearchParams(parent)>&mode=<URLSearchParams(mode)>`。
   *
   * 路径段与查询串分别复用 DSH 原生实现的编码方式（查询串由 URLSearchParams 生成，空格为 +），
   * 因此宿主原生侧栏聊天 tab 能直接解析并定位到该子代理会话。地址不可构造时返回 null。
   */
  function subagentChatAddress(value) {
    const address = normalizeSubagentAddress(value);
    if (address === null) return null;
    const query = typeof global.URLSearchParams === "function"
      ? new global.URLSearchParams({ parent: address.parentSessionId, mode: address.mode }).toString()
      : "parent=" + encodeAddressPart(address.parentSessionId) + "&mode=" + encodeAddressPart(address.mode);
    return SUBAGENT_CHAT_ADDRESS_PREFIX
      + encodeAddressPart(address.childSessionId)
      + "?" + query;
  }

  /** 资源地址里的会话 id 按 DSH 的规范做路径百分号编码；查询串优先由 URLSearchParams 负责编码。 */
  function encodeAddressPart(value) {
    const raw = String(value);
    return typeof encodeURIComponent === "function" ? encodeURIComponent(raw) : raw;
  }

  /**
   * 侧栏打开状态的复合键：sessionId + rootSessionId + 资源地址。
   *
   * DSH 的 Tab 域按（Session，tabId）保留记录；同一个 root 可能在 root/child surface 各有一份
   * session-scoped 右栏。因此键必须同时含当前 session、所属 root 和资源地址，避免把一个 surface
   * 的关闭箭头或 tabId 借给另一个 surface。
   */
  function sidebarTabKey(sessionId, rootSessionId, resourceAddress) {
    return String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR
      + String(rootSessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(resourceAddress);
  }

  /**
   * 「同一个 tab 的关闭在途」锁的复合键：sessionId + rootSessionId + 宿主 tabId。
   *
   * 与 sidebarTabKey（按资源地址记账）刻意不同：同一个资源地址在别的 session / 别的 root 里对应的是
   * 另一个右栏 tab，只有 tabId 才能证明「宿主正在处理同一个 tab」。关闭的副作用作用在 tabId 上，
   * 因此重复关闭的判据也只能是 tabId。
   */
  function sidebarTabCloseKey(sessionId, rootSessionId, tabId) {
    return String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR
      + String(rootSessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(tabId);
  }

  function sessionEntries(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
      if (value.every((entry) => Array.isArray(entry) && entry.length >= 2)) return value;
      return value.map((entry, index) => [String(index), entry]);
    }
    if (typeof value.entries === "function") {
      try { return Array.from(value.entries()); } catch { return []; }
    }
    if (typeof value === "object") return Object.entries(value);
    return [];
  }

  function sessionIdOf(value, fallback) {
    const source = object(value);
    return text(source.sessionId, text(source.id, text(fallback, null)));
  }

  /**
   * 读取宿主当前可见的会话。
   *
   * 旧版 DSH 在 sessions 快照上提供 `current` 字段；0.1.6-alpha.2 的
   * SessionListState 已移除该字段，当前主视图改由对应会话的
   * `retainedBy.mainView > 0` 表示。这里集中兼容两种公开快照形状，避免自动打开、
   * 原生回退和面板首屏各自维护一份过期的 current 读取逻辑。
   */
  function currentSessionIdOf(snapshot) {
    const source = object(snapshot);
    const explicit = text(source.current, null);
    if (explicit !== null) return explicit;
    // 兼容未来/过渡宿主把当前会话包装成 { id/sessionId } 的只读值。
    const currentObject = sessionIdOf(source.current, null);
    if (currentObject !== null) return currentObject;
    // 显式 current=null 是宿主报告「当前没有可见 surface」，不能再用 retainedBy.mainView
    // 的旧兼容证据把已经消失的会话复活，否则事务取消永远看不到 session-null 边沿。
    if (source.current === null) return null;
    const named = text(source.currentSessionId, text(source.activeSessionId, null));
    if (named !== null) return named;
    for (const [fallback, value] of sessionEntries(source.byId ?? source.sessions)) {
      const summary = object(value);
      const retainedBy = object(summary.retainedBy);
      const mainView = retainedBy.mainView;
      if ((typeof mainView === "number" && mainView > 0) || mainView === true) {
        return sessionIdOf(summary, fallback);
      }
    }
    return null;
  }

  function listSnapshot(deps, ctx) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.getSnapshot === "function") {
      try { return list.getSnapshot() || {}; } catch { return {}; }
    }
    if (typeof sessions?.getSnapshot === "function") {
      try { return sessions.getSnapshot() || {}; } catch { return {}; }
    }
    return sessions?.snapshot || {};
  }

  function subscribeSessions(deps, ctx, listener) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.subscribe === "function") {
      try { return list.subscribe(listener); } catch { return () => {}; }
    }
    if (typeof sessions?.subscribe === "function") {
      try { return sessions.subscribe(listener); } catch { return () => {}; }
    }
    return () => {};
  }

  /**
   * 解析「打开会话」入口：只使用工作区服务的公开导航面 `uiWorkspace.openSession(target)`。
   *
   * 返回 `{ open, acceptsAddress, available }`：
   * - `open(target)`：真正可调用的导航入口；
   * - `acceptsAddress`：该入口是否认识 SubagentAddress；
   * - `available`：宿主是否提供了这个入口。为 false 时调用方**不渲染**任何导航入口，
   *   绝不显示点了没反应的按钮（已删除的 `sessions.open` / `ctx.sessions.open` /
   *   历史 `deps.openSession` 回退全部移除：0.1.7-alpha.2 只有工作区服务这一个入口）。
   *
   * 入口只在「确实取到了 openSession 方法」时才算可用；属性读取抛错（未声明服务）、
   * 方法缺失、非函数一律按不可用处理。
   */
  function getOpenSession(deps, ctx) {
    const workspace = resolveClientService([deps, ctx, deps?.ctx], "uiWorkspace");
    const openWorkspaceSession = methodOf(workspace, "openSession");
    if (openWorkspaceSession !== null) {
      return {
        open: (target) => openWorkspaceSession.call(workspace, target),
        acceptsAddress: true,
        available: true,
      };
    }
    return { open: () => {}, acceptsAddress: false, available: false };
  }


  /**
   * 逐动作能力读取（票据 09）：只有 Host 明确给出 allowed 布尔时才作为权威。
   *
   * 返回 true/false/null：
   * - true/false：严格按能力渲染（Host 是唯一判定来源）；
   * - null：旧 Host/旧快照没有该字段（或形状非法）→ 调用方回退既有的
   *   ACTIVE_STATUSES / RETRY_STATUSES 推导，兼容未升级的 Host。
   * 这里刻意不把「有 capabilities 但缺该动作」当成允许：缺项与缺失整块同义，都回退。
   */
  function capabilityAllowed(node, action) {
    const capabilities = object(object(node).capabilities);
    const entry = object(capabilities[action]);
    return typeof entry.allowed === "boolean" ? entry.allowed : null;
  }

  /**
   * 规范运行状态（展示与图标唯一使用的状态）。
   * 模型可用时由模型按官方源字段归一，模型缺失时才退回可证明的 running 布尔。
   */
  function runtimeStatusOf(node, entry, options) {
    const model = modelApi();
    if (typeof model.runtimeStatusOf === "function") return model.runtimeStatusOf(node, entry, options);
    // 模型缺失的降级路径：没有证据链可判，轻量快照下一律中性。
    if (options?.partial === true && object(node).running !== true) return "unknown";
    return object(node).running === true ? "running" : "ready";
  }

  /**
   * 官方目录项的查找表工厂：把会话投影 `projectionsBySession[parentId].values.subagentCatalog`
   * 预建为 parentId → (childId → entry) 的两级 Map，消除「每渲染一行就线性扫描一次目录」的成本
   * （大列表下渲染成本曾随条目数线性放大）。
   *
   * 0.1.7-alpha.2 的目录项只保证身份类字段（id / createdAt / mode / label），**不再带 activity**：
   * 「这个子代理是否在运行」必须从 byId 投影的 `SessionSummary.running` 派生（与 DSH 原生
   * 子代理目录同一算法）。因此这里在不改变其他字段的前提下补一个 activity：
   * - 目录项自带合法 activity（running/inactive）时原样保留，不覆盖更强证据；
   * - 否则用 byId 的布尔 running 派生 running/inactive；
   * - byId 也没有布尔 running 时保持缺失，由模型的活动证据链继续回退到 DEG 元数据，
   *   绝不把未知猜成「未运行」。
   * 任务标题与元数据仍只在渲染层从 byId 与 DEG 元数据读取，本表不产出展示文案。
   *
   * 逐条对齐旧线性扫描的语义，保证渲染行为零变化：
   * - 目录缺失、非数组、投影快照形状不符时按空目录处理（查不到任何条目）；
   * - id 取 entry.id，缺失时回退 entry.sessionId，且沿用 text() 的去空白口径；
   * - 重复 id 保留**第一个**匹配项（旧扫描在首处匹配即返回）；
   * - 每个 parentId 的桶按需构建一次并缓存在闭包里：同一帧内同一父节点的所有行共用
   *   同一份表，整帧的总成本从 O(行数 × 条目数) 降到 O(条目数)。
   */
  function createCatalogLookup(snapshot) {
    const tables = new Map();
    const tableFor = (parentId) => {
      const cached = tables.get(parentId);
      if (cached !== undefined) return cached;
      const table = new Map();
      const projection = object(object(object(snapshot).projectionsBySession)[parentId]);
      const values = object(projection.values);
      const entries = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
      for (const entry of entries) {
        const source = object(entry);
        if (source.kind === "diagnostic") continue;
        const id = text(source.id, text(source.sessionId, null));
        // 先到先得：与旧的「首个匹配即返回」保持同序同结果。
        if (id !== null && !table.has(id)) table.set(id, withSessionActivity(source, snapshot, id));
      }
      tables.set(parentId, table);
      return table;
    };
    return (parentId, childId) => {
      if (parentId === null || childId === null) return null;
      const table = tableFor(parentId);
      return table.has(childId) ? table.get(childId) : null;
    };
  }

  /** 目录 activity 的两个规范值（0.1.7-alpha.2 的目录投影不再携带，由 byId 的 running 派生）。 */
  const CATALOG_ACTIVITIES = new Set(["running", "inactive"]);

  /**
   * 给目录项补上活动证据：目录自带合法 activity 时原样返回，否则从 byId 的布尔 running 派生。
   * 两处证据都没有时返回原对象（保持「未知」，交由模型的活动证据链继续回退）。
   */
  function withSessionActivity(entry, snapshot, sessionId) {
    if (CATALOG_ACTIVITIES.has(text(entry.activity, null)) === true) return entry;
    const running = sessionRunningOf(snapshot, sessionId);
    if (running === null) return entry;
    return { ...entry, activity: running ? "running" : "inactive" };
  }

  /**
   * byId 投影里的会话运行状态（官方活动轴）。
   *
   * 0.1.7-alpha.2 的子代理目录投影只保证身份类字段（id/createdAt/mode/label），不再携带
   * activity，因此「这个子代理是否在运行」必须从 byId 投影的 SessionSummary.running 读取；
   * 非布尔（快照缺失、字段缺失）返回 null，调用方继续回退到 DEG 自己的元数据证据。
   */
  function sessionRunningOf(snapshot, sessionId) {
    if (sessionId === null) return null;
    const summary = object(object(object(snapshot).byId)[sessionId]);
    return typeof summary.running === "boolean" ? summary.running : null;
  }

  function metadataOf(node, roleLabels) {
    const model = modelApi();
    // 票据 27：把合并后的 roleLabels（snapshot 优先、meta 兜底）交给模型；
    // 节点自带的 roleLabel 在模型内优先，没有任何显示名时回退既有的角色 id 文案。
    if (typeof model.formatExpertMetadata === "function") return model.formatExpertMetadata(node, { roleLabels });
    const source = object(node);
    return [text(source.role, source.kind === "root" ? "Orchestrator" : "Expert"), text(source.provider, "未知供应商"), text(source.model, "未知模型"), text(source.effort, "默认")].join(" · ");
  }

  /**
   * 第一行文案。
   *
   * - 根节点固定为中文「主代理」：绝不显示 root taskName/title/displayTitle/session id，
   *   也不接受任何 session- 前缀回退；侧栏精简后根会话的权威标题不再出现在任何一行。
   * - 普通专家节点继续显示 Host 投影的最新 dispatch 短描述（context.label /
   *   lastDispatch.description / 冷会话标题），重复 dispatch 后即为最新描述。
   * - fan-out 分支标题保留 role、分片数与规范运行状态词。
   */
  function titleOf(node) {
    const source = object(node);
    if (source.kind === "fanout") {
      const role = text(source.role, "Expert");
      const count = Array.isArray(source.shards) ? source.shards.length : 0;
      return role.charAt(0).toUpperCase() + role.slice(1) + " · " + count + " shards · " + RUNTIME_STATUS_LABELS[runtimeStatusOf(source, null)];
    }
    if (source.kind === "root") return "主代理";
    return text(source.taskName, "未命名任务");
  }

  /**
   * 具名图标（仅用于折叠箭头与 fan-out 取消/重试动作）。
   *
   * 图标词表按 0.1.7-alpha.2 契约：后缀编码**描边粗细**（`*Regular` = 1px，`*Medium` = 1.3px），
   * 渲染尺寸由 `size` prop 承载；旧的 `*14` / `*16` 后缀名在该版本已全部消失。
   * 这里的 IconWarningOutlineRegular 只是「具名图标缺失」时的通用兜底图标，
   * 与代理运行状态无关：运行状态只由 StateDot 表达。
   * 兜底名本身也必须是 alpha.2 存在的导出，否则 `createElement(undefined)` 照样会渲染报错。
   */
  function makeIcon(primitives, name, props) {
    const Icon = primitives?.[name] || primitives?.IconWarningOutlineRegular;
    return typeof Icon === "function" ? Icon(props || { size: 14 }) : null;
  }

  /**
   * DEG 品牌图标组件（双人 users 图标）：better tab 与原生 guide 卡片共用同一个组件。
   *
   * 解析顺序刻意是「宿主优先、内联回落」：
   * 1. 宿主 primitives 导出了 IconUsersOutlineRegular 时直接用它——官方 artwork 将来改稿，
   *    插件自动跟随，不需要同步维护第二份形状定义；
   * 2. 该导出缺失（旧宿主 / 本包依赖的 alpha.2）时，用同一组 BRAND_ICON_PATHS 构造等价组件，
   *    保证任何宿主版本下看到的都是同一个图标；
   * 3. react 不可用（契约外直载安装）时返回 null；调用方据此整条 icon 字段都不写，
   *    注册契约的其余部分逐字节不变，install 绝不因缺依赖抛错。
   *
   * props 只消费 `size` 与 `className`（与宿主 IconProps 一致）：尺寸由调用方注入，插件的
   * 内联组件不固定渲染尺寸，也不引入第二套描边粗细。
   */
  function createBrandIcon(react, primitives) {
    if (typeof primitives?.IconUsersOutlineRegular === "function") return primitives.IconUsersOutlineRegular;
    if (typeof react?.createElement !== "function") return null;
    return function DegBrandIcon(props) {
      const size = props?.size ?? 16;
      // 4 条 path 逐条作为独立 child 传入（而不是传一个数组）：真实 React 与测试替身看到的
      // 子节点形状一致，断言「4 条 path」时不需要额外展平；key 用 path 数据本身，
      // 四条 d 互不相同，重渲染时不会错位复用。
      return react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        className: props?.className,
        "aria-hidden": "true",
        strokeWidth: 1,
        xmlns: "http://www.w3.org/2000/svg",
      }, ...BRAND_ICON_PATHS.map((d) => react.createElement("path", {
        key: d,
        d,
        stroke: "currentColor",
        fill: "none",
      })));
    };
  }

  /**
   * 状态圆点：优先使用注入的官方 primitives.StateDot。
   * running → state:ongoing（DSH 原生 1 秒追逐动画），ready → state:done（绿色静态圆点）。
   * 只有官方组件不可用时才退化为无动画的静态圆点——插件不复制也不改写原生动画。
   */
  function stateDotOf(react, primitives, status) {
    const StateDot = primitives?.StateDot;
    if (typeof StateDot === "function") {
      return react.createElement(StateDot, { state: RUNTIME_STATE_DOT[status] || RUNTIME_STATE_DOT.ready });
    }
    return react.createElement("span", {
      className: "deg_expert_group_state_dot",
      "data-state": status,
      "aria-hidden": "true",
    });
  }

  /** 状态图标：外层 span 承担无障碍名称，内容始终是规范运行状态的圆点。 */
  function statusIcon(react, primitives, status) {
    const label = RUNTIME_STATUS_LABELS[status] || RUNTIME_STATUS_LABELS.ready;
    return react.createElement("span", {
      className: "deg_expert_group_status_icon",
      role: "img",
      "aria-label": label,
      title: label,
      "data-status": status,
    }, stateDotOf(react, primitives, status));
  }


  /**
   * 任务状态播报的类别边界（票据 18）。
   *
   * 只播报四个用户语义事件：开始、完成、失败、取消。类别刻意用**集合**而不是字符串比较，
   * 因为 Host 的规范状态词表之外还可能有历史别名（canceled/done/completed 等）：
   * - 活跃集合用于「从非活跃变成活跃」= 开始；queued → running 不再重复播报；
   * - 完成集合只认 succeeded/ready 等终态，绝不把 cancelled 混进完成；
   * - 失败集合包含 timed_out/interrupted：用户需要感知的「没成功」都在这里；
   * - unknown 一律不播报：没有证据的状态变化不算事件（避免轻量快照升级成完整快照时刷屏）。
   */
  /**
   * 面板样式表文本常量（按区块分段，注入时按同一顺序拼接）。
   *
   * 第一段：面板骨架、标题栏、任务树（行 / 分片 / 树线）、行内控件与状态圆点。
   * 原样搬出 styleTag 的数组字面量：字符串内容与顺序一字未改，只是把
   * 「CSS 文本」与「注入动作」拆成两件事。
   */
  const PANEL_CSS_SHELL = [
    // position:relative 只为宽度拖拽手柄（.deg_expert_group_resizer）提供定位上下文，不影响既有布局。
    ".deg_expert_group{position:relative;display:flex;flex-direction:column;min-width:0;height:100%;overflow:auto;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);font-size:12px;line-height:16px}",
    // 标题栏允许换行：Auto 开关、错误槽与刷新按钮在窄右栏一行放不下时按行折行，
    // 绝不把标题或状态挤成不可读的一列。min-height 28px 保持既有高度。
    ".deg_expert_group_header{display:flex;flex-wrap:wrap;align-items:center;min-height:28px;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}",
    ".deg_expert_group_header_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    // 标题栏原有的「数据不完整」徽标与「更新于 HH:MM:SS」时间文本已按用户要求从界面移除，
    // 它们的描边徽标样式与等宽时间样式随节点一并删除，不再保留无消费者的 CSS 规则。
    ".deg_expert_group_header_action,.deg_expert_group_chevron,.deg_expert_group_action,.deg_expert_group_sidebar_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
    ".deg_expert_group_header_action{width:24px;height:24px;margin-left:auto}",
    // 标题栏 Auto 开关：紧凑到与标题同一行，右对齐且不换行，绝不遮挡标题或右侧操作按钮。
    ".deg_expert_group_header_auto{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:8px;font-weight:400;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
    ".deg_expert_group_header_auto_input{margin:0;cursor:pointer}",
    ".deg_expert_group_header_auto_input:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_header_auto_label{font-size:12px;line-height:16px}",
    // 恢复失败横幅（票据 04）：与标题栏的「快照读取失败」错误面完全独立，位于头部之下、
    // 任务树之上；失败原因码与一行 message 同排，重试按钮固定右侧。整块用 flex-wrap：
    // 窄右栏时补充行自动换到第二排，绝不挤压任务树的可点击区域。
    ".deg_expert_group_recovery{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:6px 0 0;padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-state-warning-primary,#f59e0b));border-radius:6px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-weight:600}",
    // 主文案严格一行：超长 message 用省略号收束，完整内容在 title 里（Host 已限长 200 字符）。
    ".deg_expert_group_recovery_text{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    // 补充行（重试动作本身失败）：次级颜色、可换行，绝不覆盖主原因码。
    ".deg_expert_group_recovery_retry_error{flex:1 1 100%;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-weight:400}",
    ".deg_expert_group_recovery_retry{flex:0 0 auto;box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:inherit;font-weight:600;cursor:pointer}",
    ".deg_expert_group_recovery_retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
    ".deg_expert_group_recovery_retry:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_recovery_retry:disabled{cursor:default;opacity:.7}",
    ".deg_expert_group_header_action:hover,.deg_expert_group_chevron:hover,.deg_expert_group_action:hover:not(:disabled),.deg_expert_group_sidebar_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".deg_expert_group_header_action:focus-visible,.deg_expert_group_chevron:focus-visible,.deg_expert_group_action:focus-visible,.deg_expert_group_sidebar_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_tree{min-width:0;padding-top:5px}",
    ".deg_expert_group_tree_items{min-width:0}",
    // 视觉隐藏的 aria-live 状态区（票据 18）：只服务辅助技术，不占布局、不参与指针命中。
    // 用 1px 裁剪而不是 display:none —— display:none 的内容不会被播报。
    ".deg_expert_group_announcer{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
    // 可导航行的明确焦点轮廓（票据 18）：不再依赖浏览器默认（宿主 reset 有时会把它抹掉）。
    // 任务名是 role=button 的 div，键盘焦点必须一眼可见。
    ".deg_expert_group_task:focus-visible,.deg_expert_group_fanout_title>.deg_expert_group_task:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:2px;border-radius:3px}",
    // 右栏宽度拖拽手柄（票据 18）：贴在面板左缘的 6px 竖条，拖拽改变视口比例。
    // touch-action:none 让触控板/触摸屏的拖拽不会被浏览器滚动吃掉；透明背景只在 hover/拖拽时显形。
    ".deg_expert_group_resizer{position:absolute;top:0;left:0;bottom:0;width:6px;cursor:col-resize;touch-action:none;background:transparent;z-index:2}",
    ".deg_expert_group_resizer:hover,.deg_expert_group_resizer[data-dragging=true]{background:var(--dsw-alias-interactive-bg-hover)}",
    ".deg_expert_group_resizer:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:-2px}",
    ".deg_expert_group_node{position:relative;min-width:0;padding-left:16px}",
    ".deg_expert_group_node_root{padding-left:0}",
    // 票据 12：任务行从固定高度改为最小高度——开始时间/耗时/重试/失败摘要作为两行主体的
    // 相邻块（.deg_expert_group_metrics），行高按内容增长而不是把内容挤出固定行盒。
    // 侧栏精简后主行只剩「任务名 + 模型元数据」两行，主行高度随之收敛到 44px；
    // 树线锚点仍以 44px 的主行高度为参照（--deg-parent-row-height），新增块只向下延伸。
    ".deg_expert_group_row{box-sizing:border-box;display:grid;grid-template-columns:20px 20px minmax(0,1fr);min-width:0;min-height:44px;padding:4px 0}",
    // 第一行必须是 auto：默认单行 16px 时与旧布局逐像素相同；分片第一行换行时按内容撑高，
    // 绝不把多行文本压进 16px 行盒而与元数据行重叠——它没有省略号语义（见 .deg_expert_group_shard_task）。
    // 第二行（模型元数据）保持 16px 是因为省略号只在单行行盒上生效：行盒被内容撑开时
    // WebKit/Blink 会退化成裁切而不是显示 "…"，原生右栏与项目既有行为都以 "…" 结尾。
    ".deg_expert_group_row_main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 16px;min-width:0}",
    // 第一行使用独立的内联容器：任务文字按内容宽度收缩，箭头紧跟在文字后方；名称过长时文字
    // 只在箭头前的可用空间内省略，不会把箭头推出右栏视口。第一行仍由内容撑高，兼容分片任务名换行。
    ".deg_expert_group_task_line{grid-area:1 / 1;display:flex;align-items:center;min-width:0;gap:2px}",
    ".deg_expert_group_meta{grid-area:2 / 1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}",
    // 两枚 20px chevron 重叠 10px，总宽 30px；按钮同步预留空间，避免箭头覆盖标题。
    ".deg_expert_group_sidebar_action{flex:0 0 30px;width:30px;height:20px;margin:-2px 0;padding:0;color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
    ".deg_expert_group_sidebar_action:hover{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
    // 打开态（可关闭的 <<）：同一枚按钮换成主题 business/info 色，缺 token 的老宿主退回 cyan。
    // 属性选择器 + 类选择器的特异度高于共享 hover 规则，因此这里显式重复 hover：「已打开」的
    // 身份色在悬停时同样保持；键盘聚焦沿用共享 focus-visible 的 outline（它不设置颜色），
    // 颜色因此仍是打开态的青色，聚焦轮廓与颜色同时可读。
    ".deg_expert_group_sidebar_action[data-open=true]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
    ".deg_expert_group_sidebar_action[data-open=true]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
    ".deg_expert_group_double_arrow{display:inline-flex;align-items:center;justify-content:center;width:30px;height:20px;line-height:0}",
    ".deg_expert_group_double_arrow>*+*{margin-left:-10px}",
    ".deg_expert_group_double_arrow_icon path{stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}",
    ".deg_expert_group_line{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".deg_expert_group_task{min-width:0;flex:0 1 auto;font-weight:600;cursor:pointer}",
    // fan-out 分片第一行是「分片代号  任务名称」：代号已经占掉单行相当一部分宽度，
    // 继续按单行省略会让任务名称几乎不可读。这里改成可换行：完整文本按行折行展示，
    // overflow-wrap:anywhere 让超长且无分隔符的名称（中文长句、长英文标识）也能折行，
    // 绝不溢出到第二行或右侧的取消/重试按钮下面。行高由内容撑开（.deg_expert_group_shard
    // 只设 min-height），因此名称越长行越高而不是被裁掉。
    ".deg_expert_group_shard_task{overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}",
    ".deg_expert_group_task:hover{text-decoration:underline}",
    ".deg_expert_group_chevron{width:20px;height:20px;padding:0;align-self:start}",
    ".deg_expert_group_fanout_header>.deg_expert_group_chevron{align-self:center}",
    ".deg_expert_group_chevron_placeholder{display:inline-block;width:20px;height:20px}",
    ".deg_expert_group_status_icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}",
    // 兜底圆点：官方 primitives.StateDot 缺失时才使用，静态、无动画。
    ".deg_expert_group_state_dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
    ".deg_expert_group_state_dot[data-state=running]{color:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary))}",
    ".deg_expert_group_state_dot[data-state=ready]{color:var(--dsw-alias-state-success-primary)}",
    // 轻量（partial）快照的中性圆点：用次要文字色，既不是「运行中」蓝也不是「已完成」绿。
    ".deg_expert_group_state_dot[data-state=unknown]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
    // 固定 30px 批量控件紧跟标题文字；不占独立 grid 尾列，也不使用自动外边距推向行尾。
    // 标题自身 min-width:0 + 单行省略，窄宽度下只收缩文字，箭头与批量控件保持固定占位。
    ".deg_expert_group_trailing{display:flex;flex:0 0 30px;align-items:center;justify-content:center;width:30px;height:20px;min-width:30px}",
    ".deg_expert_group_task_line_trailing{justify-content:flex-start}",
    ".deg_expert_group_idle_title_line{display:flex;align-items:center;min-width:0;gap:2px}",
    ".deg_expert_group_idle_title_line>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
    // 批量关闭按钮：与单会话箭头同尺寸（30×20）与同色系（主题 business/info，缺 token 退回 cyan），
    // 形状是同一枚「两个左尖括号」图标。pending 期间 disabled + aria-busy，绝不重复发出关闭序列。
    ".deg_expert_group_sidebar_batch_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 30px;width:30px;height:20px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
    ".deg_expert_group_sidebar_batch_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
    ".deg_expert_group_sidebar_batch_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_sidebar_batch_action:disabled{opacity:.45;cursor:wait}",
    // 「零」占位：inventory 已知为空时的非交互蓝色实心圆（直径 12px）。它只占位：
    // 没有 button / hover / tabindex，不进入键盘与可访问性交互面。
    ".deg_expert_group_sidebar_batch_zero{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary,#22d3ee))}",
    // 树线锚点固定在每一级父行的 20px 状态列中心，避免依赖窗口测量。
    ".deg_expert_group_children{position:relative;min-width:0;margin:0;padding:0;--deg-parent-row-height:44px}",
    ".deg_expert_group_children>.deg_expert_group_node,.deg_expert_group_children>.deg_expert_group_fanout,.deg_expert_group_children>.deg_expert_group_idle_group{--deg-tree-anchor:14px;position:relative}",
    ".deg_expert_group_children>.deg_expert_group_fanout{--deg-tree-anchor:14px}",
    ".deg_expert_group_children>:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
    ".deg_expert_group_children>:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",

    ".deg_expert_group_node>.deg_expert_group_row,.deg_expert_group_fanout_header,.deg_expert_group_idle_group>.deg_expert_group_row{position:relative}",
    ".deg_expert_group_node:not(.deg_expert_group_node_root)>.deg_expert_group_row:before,.deg_expert_group_fanout_header:before,.deg_expert_group_idle_group>.deg_expert_group_row:before{position:absolute;top:var(--deg-tree-anchor,14px);left:-6px;width:16px;border-top:1px solid var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
    ".deg_expert_group_row>*,.deg_expert_group_fanout_header>*{position:relative;z-index:1}",
    // 空闲分组没有隐式首项 spacer；折叠、展开和空列表都保持直接相邻。
    ".deg_expert_group_idle_group{position:relative;min-width:0;padding-left:16px;--deg-tree-anchor:14px}",
    ".deg_expert_group_idle_group>.deg_expert_group_children{margin:0;padding:0;--deg-parent-row-height:28px}",
    // 空闲分组标题行同样是 grid：状态列 + chevron 列 + 可收缩标题列 + 批量 trailing slot。
    // 第四列用 auto（与 .deg_expert_group_fanout_header 的 actions 列同款）：slot 存在时按它自己的
    // 30px 宽占位，slot 为空（没有批量能力）时该列宽度为 0——标题宽度因此与改动前逐像素一致，
    // 绝不会因为「能力缺失」而平白被压掉 30px。空 idleChildren 时该 slot 承载不可交互的零圆点。
    ".deg_expert_group_idle_group>.deg_expert_group_row.deg_expert_group_idle_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr);align-items:center;height:28px;min-height:28px;padding:4px 0}",
    ".deg_expert_group_idle_group>.deg_expert_group_row{margin:0}",
    ".deg_expert_group_fanout{position:relative;margin-top:0;padding-left:16px}",
    ".deg_expert_group_fanout_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;align-items:center;min-width:0;min-height:28px;gap:4px}",
    ".deg_expert_group_fanout_shards{position:relative;min-width:0;--deg-parent-row-height:28px}",
    // 分片第一行可以换行，行高不再固定 48px，所以树线锚点绑定到**固定 20px 高**的状态图标
    // 中心（3px 上内边距 + 10px），而不是行高的一半：水平连接线与垂直树线继续对准状态列，
    // 多行名称只让行变高，树形结构与高度语义不受影响。
    ".deg_expert_group_fanout_shards>.deg_expert_group_shard{--deg-tree-anchor:13px;position:relative}",
    ".deg_expert_group_fanout_shards>.deg_expert_group_shard:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
    ".deg_expert_group_fanout_shards>.deg_expert_group_shard:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
    ".deg_expert_group_shard{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;min-width:0;min-height:48px;padding:3px 0;gap:0 3px}",
    ".deg_expert_group_shard[data-expanded=false]{min-height:24px}",
    ".deg_expert_group_actions{display:flex;align-items:flex-start;gap:2px}",
    ".deg_expert_group_action{width:24px;height:24px;padding:0}",
    ".deg_expert_group_action:disabled{opacity:.45;cursor:wait}",
    ".deg_expert_group_empty{padding:16px 2px;color:var(--dsw-alias-label-secondary)}",
    // 独立错误空态（票据 13）：没有缓存快照且请求失败时，正文只渲染这一块，绝不与
    // 「暂无 Expert Group 任务」同时出现。标题行用错误色，细节行允许换行并可悬停读全文。
    ".deg_expert_group_error_empty{display:flex;flex-direction:column;gap:2px;padding:16px 2px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}",
    ".deg_expert_group_error_empty_title{font-weight:600}",
    ".deg_expert_group_error_empty_detail{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:11px}",
    ".deg_expert_group_skeleton{height:52px;margin:4px 0;border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));opacity:.65}",
    ".deg_expert_group_error{display:flex;align-items:center;gap:4px;padding:6px 0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:11px}",
    ".deg_expert_group_count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}",
    // ── 票据 12：任务时间线 / 搜索过滤 / 导出 ──────────────────────────────
    // 两行主体的相邻块容器：用量摘要条与 attempt 时间线都放在第三列里纵向排列，
    // 不占额外的 grid 列（不会挤压状态圆点/折叠箭头/操作按钮）。
    ".deg_expert_group_cell{display:flex;flex-direction:column;min-width:0}",
    // 任务行用量摘要条：用时 / tok/s / tok / 命中 / context + 多次重试徽标 / 失败摘要。
    // 窄右栏时按 flex-wrap 换行；每一段自身单行省略，完整文本仍在 tooltip 里。
    // 分隔符左右间距由 separator 自身文本的空格提供（与元数据行的 " · " 完全一致），
    // 因此列方向 gap 归零；否则 flex gap 会让第三行看起来比第二行更宽。
    ".deg_expert_group_metrics{display:flex;flex-wrap:wrap;align-items:center;gap:2px 0;min-width:0;padding:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
    ".deg_expert_group_metrics_part{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
    // pre 保留 separator 文本首尾的空格，避免 flex item 折叠首尾空白。
    ".deg_expert_group_metrics_separator{flex:0 0 auto;white-space:pre;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
    // 「多次重试」徽标：列 gap 归零后由这里补回与最后一段之间的 6px 间距；
    // 只有前一个兄弟是摘要段时才生效，避免仅渲染徽标时多出左侧留白。
    ".deg_expert_group_metrics_part+.deg_expert_group_retry_warning{margin-left:6px}",
    // 「多次重试」徽标：只在 retryCount 达到阈值时出现，文案不暗示存在已知的 maxAttempts。
    ".deg_expert_group_retry_warning{flex:0 0 auto;box-sizing:border-box;padding:0 4px;border:1px solid var(--dsw-alias-state-warning-primary,#f59e0b);border-radius:4px;color:var(--dsw-alias-state-warning-primary,#f59e0b);font-weight:600;line-height:14px}",
    // 受限失败摘要：稳定 code + 一行 message（模型已脱敏/截断），固定单行省略。
    ".deg_expert_group_failure{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-error,#f87171))}",
    // attempt 时间线：只读列表，左侧一条细线把它与任务主体区分开。
    ".deg_expert_group_attempts{display:flex;flex-direction:column;gap:0;min-width:0;margin:2px 0;padding:0 0 0 6px;border-inline-start:1px solid var(--dsw-alias-border-l2)}",
    // 票据 25/30：attempt 条目改为纵向（首行单元格 + 用量/成本 + 结构化结果），
    // 首行仍是原来的 flex 行，文本顺序与旧结构逐字一致。
    ".deg_expert_group_attempt{display:flex;flex-direction:column;align-items:stretch;gap:0;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
    ".deg_expert_group_attempt_row{display:flex;align-items:center;gap:6px;min-width:0}",
    ".deg_expert_group_attempt_usage{display:flex;flex-wrap:wrap;gap:0 6px;min-width:0;padding-left:2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}",
    ".deg_expert_group_attempt_usage_tokens{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".deg_expert_group_attempt_cost{min-width:0;overflow-wrap:anywhere}",
    ".deg_expert_group_attempt_cost[data-cost-configured=false]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
    // 结构化结果区：有界 JSON 预览按可读前缀展示，超长换行而不是横向滚动/溢出右栏。
    ".deg_expert_group_structured{min-width:0;margin:2px 0 0;padding:2px 4px;border-inline-start:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;overflow-wrap:anywhere;max-height:84px;overflow:auto}",
    ".deg_expert_group_structured[data-fallback=true]{border-inline-start-color:var(--dsw-alias-state-warning-primary,#f59e0b);color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
    ".deg_expert_group_shard_extra{display:flex;flex-direction:column;min-width:0}",
  ].join("");

  /**
   * 第二段：「会话模型」弹窗（原生 dialog + 表格 + 角色 pill + 保存按钮）。
   */
  const PANEL_CSS_SESSION_MODEL = [
    // ── 「会话模型」弹窗（本会话覆盖；表格密度与设置页角色模型表一致）──────────
    // 原生 <dialog> 进入 top layer：不被右栏容器的 overflow/transform 裁剪。
    // display:flex 只在 [open] 时生效——否则会盖掉 UA 的 dialog:not([open]){display:none}。
    ".deg_expert_group_session_model_dialog{position:fixed;inset:0;margin:auto;box-sizing:border-box;width:min(920px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden}",
    ".deg_expert_group_session_model_dialog[open]{display:flex;flex-direction:column}",
    ".deg_expert_group_session_model_dialog::backdrop{background:rgba(0,0,0,.42)}",
    // 头/体/脚三段：体是唯一滚动区，头脚常驻（窄屏也不会把保存按钮挤出视口）。
    ".deg_expert_group_session_model_header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:0 0 auto;padding:12px 14px 6px;font-weight:600}",
    ".deg_expert_group_session_model_title{flex:1 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;font-weight:600}",
    ".deg_expert_group_session_model_body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 14px 8px}",
    ".deg_expert_group_session_model_hint{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}",
    ".deg_expert_group_session_model_notice{margin:0 0 8px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
    ".deg_expert_group_session_model_notice_error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}",
    // 表格：单一 grid 承载表头与行（行用 display:contents 参与同一套列宽），
    // 外层只负责横向滚动；列宽与设置页四列表一致的最小宽度约束。
    ".deg_expert_group_session_model_scroll{overflow-x:auto}",
    ".deg_expert_group_session_model_table{display:grid;grid-template-columns:minmax(84px,.6fr) minmax(132px,.82fr) minmax(210px,1.5fr) minmax(96px,.62fr);min-width:540px;align-items:center}",
    ".deg_expert_group_session_model_row{display:contents}",
    ".deg_expert_group_session_model_head_cell{min-width:0;padding:8px 6px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}",
    ".deg_expert_group_session_model_cell{display:flex;align-items:center;min-width:0;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
    ".deg_expert_group_session_model_cell select{width:100%;min-width:0;box-sizing:border-box;padding:5px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}",
    ".deg_expert_group_session_model_cell select:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_session_model_cell select:disabled{opacity:.5;cursor:not-allowed}",
    // 角色 pill：与设置页 .deg_settings_role_button 同尺寸（74×28、圆角 6、1px 描边）。
    ".deg_expert_group_session_model_pill{display:flex;align-items:center;justify-content:space-between;gap:4px;flex:0 0 74px;width:74px;height:28px;min-height:28px;padding:2px 4px 2px 6px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}",
    ".deg_expert_group_session_model_pill_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    // 覆盖行的「×」：只在该行确有本会话覆盖时出现，点击立即清除该角色覆盖。
    ".deg_expert_group_session_model_clear{display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer}",
    ".deg_expert_group_session_model_clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".deg_expert_group_session_model_clear:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_session_model_clear:disabled{opacity:.4;cursor:not-allowed}",
    ".deg_expert_group_session_model_footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:0 0 auto;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2)}",
    ".deg_expert_group_session_model_revision{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;font-size:12px}",
    ".deg_expert_group_session_model_invalid{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:12px;line-height:18px;overflow-wrap:anywhere}",
    ".deg_expert_group_session_model_spacer{flex:1 1 auto}",
    // 主按钮（保存）：只在这个弹窗里使用，比工具条小按钮稍大、强调色跟随主题。
    ".deg_expert_group_session_model_primary{box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-radius:6px;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:12px;font-weight:600;cursor:pointer}",
    ".deg_expert_group_session_model_primary:disabled{opacity:.45;cursor:not-allowed}",
  ].join("");

  /**
   * 第三段：attempt 时间线、结构化结果与搜索 / 过滤 / 导出工具条。
   */
  const PANEL_CSS_TIMELINE = [
    ".deg_expert_group_attempt_index{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}",
    ".deg_expert_group_attempt_status{flex:0 0 auto;font-weight:600}",
    ".deg_expert_group_attempt[data-status=failed] .deg_expert_group_attempt_status,.deg_expert_group_attempt[data-status=timed_out] .deg_expert_group_attempt_status,.deg_expert_group_attempt[data-status=interrupted] .deg_expert_group_attempt_status{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-error,#f87171))}",
    ".deg_expert_group_attempt_duration{flex:0 0 auto;font-variant-numeric:tabular-nums}",
    ".deg_expert_group_attempt_time{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
    // 「查看全部 / 收起」：时间线唯一的交互控件（只切换展示条数，不改数据）。
    ".deg_expert_group_attempts_toggle{flex:0 0 auto;align-self:flex-start;box-sizing:border-box;height:20px;margin:1px 0 0;padding:0 4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
    ".deg_expert_group_attempts_toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".deg_expert_group_attempts_toggle:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    // fan-out 标题列：标题 + 时间线/计数/失败摘要纵向排列，标题行仍可点击导航。
    ".deg_expert_group_fanout_title{display:flex;flex-direction:column;min-width:0}",
    ".deg_expert_group_fanout_title>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
    // 搜索/过滤/会话模型工具条：位于任务树顶部，只在快照已上屏时出现。
    ".deg_expert_group_toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:5px 0 2px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
    ".deg_expert_group_search{flex:1 1 120px;min-width:0;box-sizing:border-box;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px}",
    ".deg_expert_group_filter{flex:0 1 auto;min-width:0;box-sizing:border-box;height:24px;padding:0 2px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;color-scheme:light}",
    // 原生 <select> 的弹出列表由浏览器按 color-scheme 绘制，不跟随页面文字的 CSS color：
    // DSH 深色主题下必须显式切到 dark，否则会出现「白底 + 浅色字」的低对比度列表。
    "body[data-ds-dark-theme] .deg_expert_group_filter{color-scheme:dark}",
    // 选项背景与文字显式使用 DSH 主题令牌：浅色主题白底深字、深色主题深底浅字；
    // 令牌缺失的旧宿主回退到系统控件色（Canvas / CanvasText 会随 color-scheme 解析）。
    ".deg_expert_group_filter option{background-color:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}",
    ".deg_expert_group_search:focus-visible,.deg_expert_group_filter:focus-visible,.deg_expert_group_export_button:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
    ".deg_expert_group_export_button{box-sizing:border-box;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
    ".deg_expert_group_export_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".deg_expert_group_filter_empty{padding:8px 2px;color:var(--dsw-alias-label-secondary);font-size:11px}",
  ].join("");

  /** 注入用的完整 CSS 文本：段序即最终样式顺序（与拆分前的单一数组逐项一致）。 */
  const PANEL_CSS_TEXT = PANEL_CSS_SHELL + PANEL_CSS_SESSION_MODEL + PANEL_CSS_TIMELINE;

  /**
   * 幂等注入面板样式（同一 STYLE_ID 只挂一份 style 标签）。
   * 只负责「建标签 + 写 dataset + 追加到 head」；CSS 文本来自上面的常量，
   * 因此本函数远小于函数级阈值，样式内容也可独立审阅。
   */
  function styleTag() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (document.querySelector?.("style[data-plugin-css=\"" + STYLE_ID + "\"]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-expert-group";
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = PANEL_CSS_TEXT;
    document.head?.appendChild(tag);
  }

  /**
   * 宿主 AppFrame 右栏拖拽手柄的稳定公开标记（div[data-side="rightbar"]）。
   *
   * 宿主 AppFrame 的 DragHandle 渲染成 <div class="…handle" data-side={props.side}>，右栏那一枚
   * 的 side 就是 "rightbar"（左栏是 "sidebar"）；它只在「右栏已展开 + 非全屏 + 宽度大于 0」时
   * 出现，是用户拖拽改变右栏宽度的**唯一**入口（pointerdown → setPointerCapture → setRightbar）。
   * 属性名与取值都是宿主自己写死的公开标记，插件只读它、绝不改写宿主 DOM 结构。
   */
  const RIGHTBAR_DRAG_HANDLE_SELECTOR = "[data-side=rightbar]";

  /**
   * 读取一个节点的属性原文；读不到（没有 getAttribute、抛错、返回非字符串）返回 null。
   *
   * 一律不抛：属性读面缺失与属性缺失在这里是同一件事——调用方只允许按「读不出来」fail-closed，
   * 绝不允许猜一个默认值。
   */
  function attributeOf(node, name) {
    try {
      if (node === null || node === undefined || typeof node.getAttribute !== "function") return null;
      const raw = node.getAttribute(name);
      return typeof raw === "string" ? raw : null;
    } catch { return null; }
  }

  /**
   * 判断 node 是否与 root 处在**同一个 dock 作用域**内（父链上不跨过 boundaries 里的任一个标记）。
   *
   * 用途：右栏一列的内容区里可能嵌着另一个完整 dock（它有自己的 host/split 与 tab 条），
   * 那种 tab 属于嵌套页面，不能算进当前列。判定从 node 的父节点一路走到 root（不含 root 自身）：
   * 途中遇到任何 boundary 标记就返回 false。
   * 返回三态：true＝同作用域，false＝跨了作用域，null＝父链/属性读面不可用（调用方 fail-closed）。
   */
  function withinSameDockScope(node, root, boundaries) {
    let parent = null;
    try { parent = node?.parentNode ?? null; } catch { return null; }
    let guard = 0;
    while (parent !== null && parent !== undefined && parent !== root) {
      guard += 1;
      if (guard > 512) return null;
      if (typeof parent.getAttribute !== "function") return null;
      for (const name of boundaries) {
        if (attributeOf(parent, name) !== null) return false;
      }
      try { parent = parent.parentNode ?? null; } catch { return null; }
    }
    return parent === root;
  }

  /**
   * 读一个 dock host 的 DOM 布尔 `hidden`。
   *
   * 真实 DockLayout（app.asar 里 US 组件渲染 host 的那一处）写的是 React 的 `hidden: !w`，
   * 其中 w = 「这个 host 的 tab 就是它所属 pane 的 activeTabId」：同一 pane 只有**一个** host
   * 不带 hidden，其余 host 全部带 hidden。hidden 是 HTMLElement 的布尔 IDL 属性，因此这里只认
   * 真正的布尔值；属性读面缺失、抛错或返回非布尔（替身没实现、宿主换了渲染方式）一律返回 null，
   * 调用方按「读不出来」fail-closed，绝不把 undefined 当成「可见」。
   */
  function hostHiddenStateOf(host) {
    try {
      const value = host?.hidden;
      return typeof value === "boolean" ? value : null;
    } catch { return null; }
  }

  /**
   * 读取一个 dock **逻辑列**（= 同一 data-dockkit-column 下的全部 host）的**唯一活跃 tab 条**。
   *
   * 真实 DockLayout 对**每个 tab** 渲染一个 div[data-dockkit-host="dock"]，同一 pane 的多个 tab
   * 共享同一个 data-dockkit-column；而 tab 条本身**只挂在活跃 tab 的那个 host 上**：
   *   hidden: !w                            ← 非活跃 host 带 DOM hidden
   *   children: [ w && <TabStrip …/>, … ]   ← 非活跃 host 连 strip 都不渲染
   * 活跃 host 的那条 strip 里列出的是**该 pane 的全部 tab**（TabStrip 渲染 pane.tabs），所以只要
   * 取到唯一活跃 strip，这一逻辑列的 tab 组成就是完整的——多开一个子代理 tab 只会多出一个
   * hidden 的空 host，绝不能让整列因此变成「读不出来」而退回宿主的 1:1。
   *
   * 判定（任一条不成立即整列 fail-closed，绝不猜）：
   * - 每个 host 的 hidden 必须是可读的布尔值；
   * - hidden === true 且该 host 没有自己的 strip → 真实非活跃 host，跳过；
   * - hidden === false 且**恰好一条**自己的 strip → 活跃 host，收集这条 strip；
   * - 可见 host 没有 strip、hidden host 却带着自己的 strip、querySelectorAll 或父链读面抛错
   *   → 结构不是本插件认识的那一种，fail-closed；
   * - 一个逻辑列出现多个活跃 strip host，或整列一个活跃 strip 都没有 → fail-closed。
   *
   * 列内容区里嵌着的另一个 dock 也有自己的 strip，靠 withinSameDockScope 排除（父链上跨过
   * host/split 的 strip 不算本列）。返回 null 表示读不出来；可读时返回**恰好一条** strip 的数组。
   */
  function cellStripNodesOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return null;
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return null;
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return null;
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return null; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return null;
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；它若带着自己的 tab 条，说明结构不是这一种，fail-closed。
        if (owned.length !== 0) return null;
        continue;
      }
      // 可见 host 必须恰好有一条自己的 tab 条：零条（tab 条没渲染出来）或多条都无法证明组成。
      if (owned.length !== 1) return null;
      activeCount += 1;
      if (activeCount > 1) return null;
      activeStrip = owned[0];
    }
    // 整列必须恰好一个活跃 host：整列全 hidden（一条 strip 都没有）同样读不出组成。
    if (activeCount !== 1 || activeStrip === null) return null;
    return [activeStrip];
  }

  /**
   * 读取一个逻辑列自己的 tabId 集合。
   *
   * 只认**唯一活跃 strip** 里的 tab 芯片（strip 内部更深一层的 strip 属于嵌套 dock，不算本列）。
   * 读面抛错、活跃 strip 不是恰好一条、strip 里没有任何 tab、未知或空 tabId 都让整列读不出来，
   * 调用方据此 fail-closed，绝不把「读不到」当成空列。
   *
   * 同一条 strip 里出现重复 tabId 同样是结构异常（一个 tab 不可能在同一个 tablist 里出现两次）：
   * 这里绝不能用 Set 静默吞掉重复，否则「读面不完整」会被误判成正常组成。
   */
  function cellTabIdsOf(column) {
    const ids = new Set();
    const strips = cellStripNodesOf(column);
    // 读面契约：可读时恰好一条活跃 strip；null 或长度不为 1 都表示这一列读不出来。
    if (strips === null || strips.length !== 1) return { ids, readable: false };
    const strip = strips[0];
    if (typeof strip.querySelectorAll !== "function") return { ids, readable: false };
    let tabNodes = null;
    try { tabNodes = Array.from(strip.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return { ids, readable: false }; }
    for (const node of tabNodes) {
      const scoped = withinSameDockScope(node, strip, [RIGHTBAR_STRIP_TABS_ATTRIBUTE]);
      if (scoped === null) return { ids, readable: false };
      if (scoped !== true) continue;
      const tabId = text(attributeOf(node, RIGHTBAR_TAB_ID_ATTRIBUTE), null);
      if (tabId === null) return { ids, readable: false };
      if (ids.has(tabId)) return { ids, readable: false };
      ids.add(tabId);
    }
    if (ids.size === 0) return { ids, readable: false };
    return { ids, readable: true };
  }

  /**
   * Expert Group 的 tabId 集合（kind 规范化 + DockKit 生成的 id）。
   *
   * inventory 是公开只读读面（sidebarRight.openTabs.getSnapshot），可用时它把 kind 映射成真实
   * tabId（DockKit 生成的 `dsh-expert-group1` 这类 id 仍在集合里）；读面缺失/抛错/返回非数组时
   * 退回旧宿主里 kind 直接当 tabId 用的 DOM 形态，并由 isGeneratedExpertGroupTabId 继续识别
   * 计数器后缀。其它旧逻辑允许在 inventory 缺失时保留基础 kind 兼容集合；严格的分栏配比
   * 读面另用 sidebarTabSetsForSession（内部走 tabKindsForSession），只接受当前 session 的
   * inventory 归属。
   */
  function expertGroupTabIdsOf(inventory, sessionId) {
    const expertTabIds = new Set(EXPERT_GROUP_TAB_IDS);
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return expertTabIds;
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId !== null) expertTabIds.add(tabId);
      } catch {
        // 单条 inventory 记录损坏时跳过它，不能阻断其它 tab 的 pane 定位。
      }
    }
    return expertTabIds;
  }

  /**
   * 面板里的全部 dock pane 节点（顺序保留用于诊断，方向以 data-dockkit-column 为准）。
   *
   * 读不到（没有 querySelectorAll、查询抛错）时返回 null：调用方按「这一轮 pane 读面不可用」
   * fail-closed，绝不把「读不到」当成「没有 pane」。
   */
  function paneNodesOf(panel) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
    try { return Array.from(panel.querySelectorAll(RIGHTBAR_PANE_SELECTOR)); } catch { return null; }
  }

  /**
   * 只建立当前 session 的 tabId -> kind 映射。inventory 缺失、session 无效或同一 tabId 出现
   * 冲突 kind 时返回 null；配比路径不能用全局 kind 或生成式 id 猜测旧 pane 的归属。
   */
  function tabKindsForSession(inventory, sessionId) {
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return null;
    const tabKinds = new Map();
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        const tabId = text(candidate.tabId, null);
        const kind = text(candidate.kind, text(candidate.type, null));
        if (tabId === null || kind === null) continue;
        const previous = tabKinds.get(tabId);
        if (previous !== undefined && previous !== kind) return null;
        tabKinds.set(tabId, kind);
      } catch {
        // 单条损坏记录不参与映射；若 DOM 仍引用它，后续会按未知归属 fail-closed。
      }
    }
    return tabKinds;
  }

  /**
   * 当前 session 的 tabId 读面：expert = Expert Group 页的 id 集合；known = 本会话全部已知 tabId。
   *
   * 沿用 tabKindsForSession 的严格归属：inventory 读不出来、session 无效、同一 tabId 出现冲突
   * kind 时返回 null（调用方整体 fail-closed），绝不退回全局 kind 或用生成式 id 猜测归属。
   * 静态 EXPERT_GROUP_TAB_IDS 作为旧宿主（kind 直接当 tabId）的兼容基线同时进入两个集合。
   */
  function sidebarTabSetsForSession(inventory, sessionId) {
    const tabKinds = tabKindsForSession(inventory, sessionId);
    if (tabKinds === null) return null;
    const expert = new Set(EXPERT_GROUP_TAB_IDS);
    const known = new Set(EXPERT_GROUP_TAB_IDS);
    for (const [tabId, kind] of tabKinds) {
      known.add(tabId);
      if (EXPERT_GROUP_TAB_IDS.has(kind)) expert.add(tabId);
    }
    return { expert, known };
  }

  /**
   * 按 data-sidebar-right-session 精确挑选属于当前 surface 的右栏面板。
   *
   * 面板会迟到挂载、也可能在一次 surface 重挂载里同时留下新旧两个；`querySelector` 的第一个命中
   * 无法证明归属，因此这里要求面板自带会话归属标记并与本轮 session **完全相等**，而且全局恰好
   * 一个匹配（零个＝还没挂载或不属于这一页，多个＝归属不明确）。缺属性、读面不可用或有歧义
   * 都返回 null，调用方保持 fail-closed，绝不猜第一个面板。
   */
  function rightbarPanelForSession(doc, sessionId) {
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    if (typeof sessionId !== "string" || sessionId === "") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    let matched = null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== sessionId) continue;
      if (matched !== null) return null;
      matched = node;
    }
    return matched;
  }

  /**
   * 面板级读面（面板内的 tab/pane 观察与组成判定）共用的「当前 session 面板」解析入口。
   *
   * 第一判据与 rightbarPanelForSession 完全一致：面板自带 data-sidebar-right-session、与当前
   * session 完全相等、且全局唯一时才可用；零个（面板还没挂载 / 不属于这一页）或多个（归属不明确）
   * 都返回 null，调用方一律 fail-closed——绝不按 DOM 顺序取第一个面板，那正是跨 session 误命中的根因。
   *
   * 唯一的兼容分支是**旧宿主形状**：data-sidebar-right-session 出现之前的面板没有归属标记，
   * 此时 DOM 里读不到任何带标记的面板。只有这种「整轮都没有归属标记」的形状才退回 querySelector
   * 的旧读法，而且要求面板至多一个（多于一个＝归属不可能证明，直接 fail-closed）。只要出现过任何
   * 一个带标记的面板（现代宿主），这个分支整体失效：当前 session 自己的面板没挂载时保持 null，
   * 绝不拿别的 session 的面板顶替。
   */
  function rightbarPanelForSessionCompat(doc, sessionId) {
    const panel = rightbarPanelForSession(doc, sessionId);
    if (panel !== null) return panel;
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    // 归属标记一旦存在就不再兼容：多个面板、或任一面板带标记，都只能按精确归属判定。
    if (nodes.length > 1) return null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    }
    if (nodes.length === 1) return nodes[0];
    // 旧替身/旧宿主的读面形状：面板选择器只能通过 querySelector 命中。这里同样要求命中节点
    // 没有归属标记——带了标记说明它是别的 session 的面板，不能拿来顶替。
    if (typeof doc.querySelector !== "function") return null;
    let single = null;
    try { single = doc.querySelector(RIGHTBAR_PANEL_SELECTOR) ?? null; } catch { return null; }
    if (single === null || single === undefined) return null;
    if (attributeOf(single, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    return single;
  }

  /**
   * 读取 split 容器的直接 dock 列，并按列号归并成**逻辑列**。
   *
   * 只有 split 的**直接子节点**里 `data-dockkit-host="dock"` 且带非空 `data-dockkit-column`
   * 的才是真实列：浮动 host（data-dockkit-host="floating"）、resize 手柄、嵌套 split 的子列
   * 都不算列。列号缺失（读不出来或空串）一律整轮 fail-closed——拿不到列号的节点不能被当成一列。
   *
   * 真实 DockLayout 是「**每个 tab 一个 host**」：同一个 pane 的多个 tab 各有自己的
   * div[data-dockkit-host="dock"]，它们共享同一个 data-dockkit-column（只有活跃 tab 的那个 host
   * 不带 hidden、也只有它渲染 tab 条）。因此同列多个 host 是**合法**结构，这里按列号归并成
   * { column, hosts }：hosts 保留 DOM 顺序，顺序本身没有语义（组成判定只看活跃 strip 里的
   * tab 集合），列号到 host 的归属仍然是精确的。
   */
  function dockCellsOf(split) {
    const cells = [];
    let children = null;
    try { children = split?.children ?? null; } catch { children = null; }
    if (children === null || children === undefined) return { cells, readable: false };
    const byColumn = new Map();
    for (const child of Array.from(children)) {
      if (child === null || typeof child.getAttribute !== "function") return { cells, readable: false };
      if (attributeOf(child, RIGHTBAR_DOCK_HOST_ATTRIBUTE) !== RIGHTBAR_DOCK_HOST_VALUE) continue;
      const column = text(attributeOf(child, RIGHTBAR_PANE_COLUMN_ATTRIBUTE), null);
      if (column === null) return { cells, readable: false };
      const merged = byColumn.get(column);
      if (merged === undefined) byColumn.set(column, { column, hosts: [child] });
      else merged.hosts.push(child);
    }
    for (const entry of byColumn.values()) cells.push(entry);
    return { cells, readable: true };
  }

  /**
   * 判断一个 split 容器是不是「列 0 = Expert Group、列 1 = 当前 session 的另一个已知页」。
   *
   * fail-closed 的边界（任一条不成立就 false，插件一个字节都不写）：
   * - 归并后的逻辑列不是**恰好两列**，或列号不是精确的 0/1（三列、缺列、未知列号都没有可证明的 40:60）；
   * - 任一逻辑列读不出自己的活跃 strip / tabId（整列没有活跃 strip、多个活跃 strip、
   *   可见 host 没有 strip、hidden host 却带 strip、hidden 状态不可读、未知 tabId、读面抛错）；
   * - 列 0 里混进非 Expert Group 页，或列 1 里出现 Expert Group 页；
   * - 同一个 tabId 同时出现在两列，或同一条 strip 里重复出现（重复归属），
   *   或出现本会话 inventory 里没有的 tab（未知归属）。
   *
   * 同列多个 host（真实「每个 tab 一个 host」形态）本身合法：判定用的是归并后的逻辑列与它唯一的
   * 活跃 strip（该 strip 列出整个 pane 的 tab），因此多个子代理 tab 与单个子代理 tab 得到完全
   * 相同的 40:60 结论。
   */
  function splitOwnsExpertPair(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return false;
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return false;
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return false;
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    const otherTabs = cellTabIdsOf(byColumn.get("1"));
    if (expertTabs.readable !== true || otherTabs.readable !== true) return false;
    let expertCount = 0;
    for (const tabId of expertTabs.ids) {
      if (otherTabs.ids.has(tabId)) return false;
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) !== true) return false;
      expertCount += 1;
    }
    if (expertCount === 0) return false;
    for (const tabId of otherTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) === true) return false;
    }
    return true;
  }

  /**
   * 一个逻辑列的「暂不可读」判定（与 cellStripNodesOf 同一套读面，但区分失败原因）。
   *
   * 返回 "readable" | "unavailable" | "foreign"：
   * - "readable"：恰好一条活跃 tab 条且 tab 组成可读——这一列有完整组成，轮不到 pending 分支；
   * - "unavailable"：整列只有 hidden host（tab 条还没渲染出来）。这是重启恢复窗口里第二列的
   *   典型形状，只有这种形状才允许 pending；
   * - "foreign"：可见 host 没有 tab 条、非活跃 host 却带着自己的 tab 条、一个逻辑列出现多个活跃
   *   strip host、hidden 状态不可读、host 列表为空、读面抛错。这些都不是「还没读完」而是
   *   「结构不是本插件认识的那一种」，必须按原有 fail-closed 语义交还宿主。
   */
  function cellPendingStateOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return "foreign";
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return "foreign";
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return "foreign";
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return "foreign"; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return "foreign";
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；带了自己的 tab 条说明结构不是这一种。
        if (owned.length !== 0) return "foreign";
        continue;
      }
      if (owned.length !== 1) return "foreign";
      activeCount += 1;
      if (activeCount > 1) return "foreign";
      activeStrip = owned[0];
    }
    if (activeCount !== 1 || activeStrip === null) return "unavailable";
    return cellTabIdsOf(column).readable === true ? "readable" : "foreign";
  }

  /**
   * 区分「两列但第二列内容暂不可读」与「组成明确不再是目标」。
   *
   * 为什么需要它：重启恢复（宿主从持久化布局恢复右栏）时，split 容器往往比列内的 tab 条 /
   * inventory 归属早几帧出现。这段窗口里 splitOwnsExpertPair 会返回 false，但 false 同时
   * 覆盖了两种完全不同的现实：
   * - **暂不可读**（本函数返回 "unavailable"）：结构上仍是两列，列 0 明确是本会话的
   *   Expert Group 页，只有列 1 整列还没有活跃 tab 条（tab 条比 split 容器晚若干帧提交）。
   *   此时组成只是「还没读完」，插件应当保持已写下的配比并短延迟重试，绝不闪回宿主默认值；
   * - **明确非目标 / 单列**（返回 "foreign"）：列数不是精确的 0/1 两列、列 0 不是 Expert Group
   *   页、列 0 的 tab 无法归属、或两列里混进重复/未知归属。这些都没有可证明的 40:60，必须
   *   按原有 fail-closed 语义交还宿主。
   *
   * 归属判定与 splitOwnsExpertPair 完全同源（同一份 tabSets、同一条唯一活跃 strip 读法），
   * 因此这里**不引入任何新的宽松证据**：pending 只在「目标那一侧已经被证明」时才成立，
   * 首次接管（从未写过目标配比）也绝不会因为列 1 读不出来就去猜页面归属。
   */
  function splitPairPendingOf(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return "foreign";
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return "foreign";
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return "foreign";
    // 列 0 必须是可读且明确属于本会话的 Expert Group 页：读不出来就没有「已确认的目标」。
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    if (expertTabs.readable !== true || expertTabs.ids.size === 0) return "foreign";
    for (const tabId of expertTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return "foreign";
      if (tabSets.expert.has(tabId) !== true) return "foreign";
    }
    // 列 1 只有「整列还没有活跃 tab 条」这一种形状算暂不可读；其余（组成读得出来、可见 host
    // 没有 strip、一个逻辑列多个活跃 strip、hidden 不可读等）都是「明确不是目标」，交回严格判定。
    return cellPendingStateOf(byColumn.get("1")) === "unavailable" ? "unavailable" : "foreign";
  }

  /**
   * 在面板里按给定判据挑出**唯一**的分栏容器。
   *
   * 面板内部可能同时存在多个 split（列的内容区里嵌着的另一个 dock 也有自己的 split），因此
   * 判据命中多个时一律视为归属不明确并返回 null（调用方 fail-closed，绝不挑第一个猜测）；
   * 返回数组的形态让调用方可以自行决定「零个 / 一个 / 多个」的处理方式（见下面的两个包装）。
   */
  function uniqueSplitBy(panel, matches) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return [];
    let nodes = null;
    try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_SPLIT_SELECTOR)); } catch { return []; }
    const resolved = [];
    for (const node of nodes) {
      if (matches(node) !== true) continue;
      resolved.push(node);
      if (resolved.length > 1) break;
    }
    return resolved;
  }

  /**
   * 在面板里找出**唯一**可解析的分栏容器。
   *
   * 只有满足 splitOwnsExpertPair 的那一个才是本插件的目标：零个表示还没分栏或形态不认识，
   * 多个表示归属不明确——两种情况都返回 null（调用方 fail-closed）。
   */
  function resolveSplitContainer(panel, tabSets) {
    const resolved = uniqueSplitBy(panel, (node) => splitOwnsExpertPair(node, tabSets) === true);
    return resolved.length === 1 ? resolved[0] : null;
  }

  /**
   * 找出面板里**唯一**的「暂不可读 pending」分栏容器（见 splitPairPendingOf 的说明）。
   *
   * 零个表示这一轮没有任何可保持目标配比的两列结构，多个表示归属不明确——调用方据此走
   * 原有的交还宿主分支，绝不挑第一个猜测。返回数组（而不是元素或 null），因为「零个」与
   * 「多个」在这里都必须与「恰好一个」区分开。
   */
  function splitPairPendingContainers(panel, tabSets) {
    return uniqueSplitBy(panel, (node) => splitPairPendingOf(node, tabSets) === "unavailable");
  }

  /**
   * 解析 grid-template-columns 的三轨形态。
   *
   * 真实右栏是「列 0 | 0px 分隔轨 | 列 1」三条轨道，两端必须是 `minmax(0,<数字>fr)`：只有这种
   * 形态才谈得上 40% / 60%，其余（单轨、repeat()、固定 px、轨道数不符、括号不闭合）一律返回
   * null，调用方绝不写。中间那条轨道原样返回给调用方复用——它是宿主自己的分隔轨，插件不改写。
   */
  function parseSplitTracks(raw) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") return null;
    const tracks = [];
    let depth = 0;
    let current = "";
    for (const character of value) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && /\s/.test(character)) {
        if (current !== "") { tracks.push(current); current = ""; }
        continue;
      }
      current += character;
    }
    if (depth !== 0 || current === "") return null;
    tracks.push(current);
    if (tracks.length !== 3) return null;
    const first = splitEndTrackFr(tracks[0]);
    const last = splitEndTrackFr(tracks[2]);
    if (first === null || last === null) return null;
    return { first, last, middle: tracks[1] };
  }

  /** 端点轨道必须是 `minmax(0,<数字>fr)` 或 CSSOM 规范化后的 `minmax(0px,<数字>fr)`；其余形态一律不认。 */
  function splitEndTrackFr(track) {
    const match = /^minmax\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(track);
    if (match === null) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * 右栏拖拽手柄锁：**只在 Expert Group 页确实是当前活动页时**生效，切换页面或卸载立刻恢复。
   *
   * 需求：Expert Group 页的宽度固定为视口宽度的 20%，用户不能在这一页上把右栏拖成别的宽度；
   * 而其它右侧分页（子代理聊天、文件等）必须继续能正常 resize。因此绝不能全局禁用这个手柄
   * （那是宿主 AppFrame 的公共元素，别的页面、甚至同一会话里的其它 tab 都要用它），只能在
   * 「当前活动 tab 就是 Expert Group」时逐次加锁、离开时逐次解锁。
   *
   * 最小侵入写法：只往这一个元素的内联样式上写两条属性（禁用指针事件 + 复位光标形状），
   * 不注入全局 CSS、不加 class、不改 DOM 结构，也绝不碰宿主的 data-* 属性：
   * - pointer-events: none —— 拖拽入口（pointerdown）根本收不到事件，宽度不可能被拖走；
   * - cursor: default —— 鼠标悬停时不再显示 col-resize 的「可拖拽」暗示。
   * 两条都带 important：宿主自己给手柄写了 hover 态样式，普通内联声明可能被主题的
   * !important 规则盖掉（与过渡抑制同一取舍）。
   *
   * 恢复用「值与优先级都仍等于本次写入才还原」的保守判定：锁存窗口内被宿主/主题/页面脚本
   * 改写过的属性一律保留外部状态，原本没有内联声明就删除，绝不用旧值覆盖新值。
   *
   * 句柄的存活性复用**已有的 tab 观察生命周期**：Expert Group 面板已挂在 body 子树的
   * childList observer + 2.5 秒轮询 + visibilitychange 上（见 syncSidebarTabs），宿主重新挂载
   * 这枚手柄本身就是一次 childList 变化，因此锁会随那条生命周期重新找句柄并补写——插件不为
   * 此再加一个长期 MutationObserver，宿主上的观察器数量与既有行为完全一致。
   *
   * 解锁（切换页面）与 dispose 都必须还原样式：绝不在宿主上留下「永久不可拖拽」的手柄，
   * 也绝不留下任何全局样式或残留属性。
   *
   * 全程 fail-safe：没有 document / 没有 querySelector / 句柄还没挂载 / style 不是可写对象，
   * 都只是「这一次没锁上」，绝不影响页面打开与渲染。
   */

  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    RIGHTBAR_DRAG_HANDLE_SELECTOR, SUBAGENT_CHAT_KIND, capabilityAllowed, createBrandIcon,
    createCatalogLookup, currentSessionIdOf, expertGroupTabIdsOf, getOpenSession,
    hostAppFrameWidthOf, listSnapshot, makeIcon, metadataOf,
    methodOf, normalizeSubagentAddress, paneNodesOf, parseSplitTracks,
    resolveClientService, resolveSplitContainer, rightbarPanelForSession, rightbarPanelForSessionCompat,
    runtimeStatusOf, sidebarTabCloseKey, sidebarTabKey, sidebarTabSetsForSession,
    splitPairPendingContainers, statusIcon, styleTag, subagentChatAddress,
    subscribeSessions, titleOf, viewportWidthOf,
  });
})(globalThis);
