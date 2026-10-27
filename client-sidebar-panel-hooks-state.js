/**
 * 客户端侧栏 · Panel 自定义 Hook（实例状态）
 *
 * 这些 Hook 由 client-sidebar-panel.js 的 Panel 组件按**固定顺序**调用；每个 Hook 内部
 * 的 react.use* 调用顺序、effect 依赖数组、setup / cleanup 归属都与拆分前逐字相同。
 * 拆分只把原来同一个函数体里的连续语句段移进独立函数，因此运行期 Hook 派发序列不变。
 */
(function installSidebarPanelHooksState(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-state");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    RIGHTBAR_WIDTH_RATIO, RIGHTBAR_WIDTH_RATIO_MAX, RIGHTBAR_WIDTH_RATIO_MIN, clampRightbarWidthRatio, normalizeHostMeta, normalizeSessionModelView,
    object, sessionModelOrchestratorOf, sessionModelRowKeysOf, snapshotHasUsageFact,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    getOpenSession, methodOf, viewportWidthOf,
  } = DOM;
  const POLL_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-poll");
  const POLL = global[POLL_SYMBOL] || {};
  const {
    callRpc,
  } = POLL;
  const SPLIT_SYNC_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-split-sync");
  const SPLIT_SYNC = global[SPLIT_SYNC_SYMBOL] || {};
  const PANEL_STATE_A_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
  const PANEL_STATE_A = global[PANEL_STATE_A_SYMBOL] || {};
  const PANEL_STATE_B_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-b");
  const PANEL_STATE_B = global[PANEL_STATE_B_SYMBOL] || {};

  /** 实例级 state / ref 与其初值（会话、过滤、时间线、meta、会话模型、播报）。 */
  function useSidebarPanelStateCore(frame) {
    const {
      initialStateFor, react, rootSessionId,
    } = frame;

    const statePair = typeof react.useState === "function"
      ? react.useState(() => initialStateFor(rootSessionId))
      : [initialStateFor(rootSessionId), () => {}];
    const state = statePair[0];
    const setState = statePair[1];
    // rootSessionId 属于请求边界：切换 surface 时先在渲染层隐藏旧树，避免旧会话内容
    // 在新会话首屏等待期间继续占据右栏。真实响应提交时也会再次校验该边界。
    // 切到另一个 root 时用的初始状态是**目标 root** 的状态（有缓存即直接显示它的树）：
    // 缓存按 root 隔离，因此绝不会把旧 root 的内容显示到新 root 上。
    // 只有这条回退分支需要再读一次缓存，且同样走纯读通道；同一 root 的普通重渲染
    // （通知、轮询、展开状态变化）完全不触碰缓存。
    const viewState = state.rootSessionId === rootSessionId ? state : initialStateFor(rootSessionId);
    const versionPair = typeof react.useState === "function" ? react.useState(0) : [0, () => {}];
    const version = versionPair[0];
    const bump = versionPair[1];
    /**
     * 面板标题栏 Auto 开关的本地乐观值（null = 跟随权威读面）。
     *
     * 开关的持久化要走一次 settings-commit 往返；没有本地覆盖时，用户点击后要等下一次
     * 轮询（最长 2.5 秒）才会看到勾选状态变化。这里先乐观翻转，写失败或权威值变化时
     * 立刻回退到读面值（绝不让开关停在错误状态）。
     */
    const autoOpenDraftPair = typeof react.useState === "function" ? react.useState(null) : [null, () => {}];
    const autoOpenDraft = autoOpenDraftPair[0];
    const setAutoOpenDraft = autoOpenDraftPair[1];
    /**
     * 客户端本地搜索/过滤状态（票据 12）：{ rootSessionId, query, role, status }。
     *
     * 三条硬约束：
     * - **不持久化**：只有内存状态，刷新页面即回到「无过滤」，绝不写 sessionStorage
     *   （展开状态是唯一的持久化 UI 状态，过滤不属于它）；
     * - **不新增 RPC**：过滤只作用于已归一的内存快照，轮询节奏与请求体完全不变；
     * - **按 root 绑定**：rootSessionId 与当前 root 不一致时按空过滤处理。切换会话后
     *   旧会话的搜索词/角色筛选不会把新会话的树整棵隐藏（也不需要渲染期 setState）。
     */
    // 空过滤的唯一事实源在 panel-state-a（冻结常量）：这里只取同一份引用，绝不复制第二份字面量。
    const emptyFilter = PANEL_STATE_A.EMPTY_TASK_FILTER;
    const filterPair = typeof react.useState === "function"
      ? react.useState(emptyFilter)
      : [emptyFilter, () => {}];
    const filterState = filterPair[0] !== null && typeof filterPair[0] === "object" ? filterPair[0] : emptyFilter;
    const setFilterState = filterPair[1];
    /**
     * 「查看全部」时间线的本地展开集合：键是稳定节点键（fanout:<id> / shard:<parent>:<shard>）。
     *
     * 用 ref + bump 而不是 useState：展开集合不参与快照内容比较，也不需要跨渲染树传递；
     * 这样与 pendingSet / recoveryRetryRef 同一模式，点击只触发一次重渲染。
     * 同样不持久化：刷新后回到「最近 5 条」的默认视图。
     */
    const timelineExpandedRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };

    /**
     * 票据 25/26/27/28 的客户端读面状态。
     *
     * - meta：宿主 meta（角色清单/显示名/全局默认/单价/限流诊断/全局用量）。**懒加载**：只有
     *   用户打开「诊断」或「会话模型」，或快照第一次出现用量事实时才读一次；挂载与轮询路径
     *   不新增任何请求，既有请求计数契约不变。
     * - sessionModel：侧栏「会话模型」弹窗（本会话 provider/model/思考深度覆盖）。
     *   展开状态是纯本地 UI 状态：关闭时不发 session-override-* RPC、也不订阅模型目录。
     */
    const metaPair = typeof react.useState === "function" ? react.useState(null) : [null, () => {}];
    const meta = metaPair[0];
    const setMeta = metaPair[1];
    // 事件路径（runAction 的尾随刷新）读取的是**当前渲染**的 meta，用 ref 同步写入。
    const metaStateRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    metaStateRef.current = meta;
    /**
     * 「会话模型」编辑区的读写状态机（语义与设置页 useSessionOverrideSection 一致）：
     *
     * - status：idle / loading / ready / no-session / child / unsupported / error；
     * - overrides：Host 权威投影（role -> selection），只在本会话确实有覆盖时才有条目；
     * - revision：Host 持久化代次，保存/清除都作为 expectedRevision 提交（CAS 栅栏）；
     * - live：会话是否在运行；false 时整块只读（Host 不接受离线会话的覆盖写入）。
     */
    const sessionModelOpenPair = typeof react.useState === "function" ? react.useState(false) : [false, () => {}];
    const sessionModelOpen = sessionModelOpenPair[0];
    const setSessionModelOpen = sessionModelOpenPair[1];
    const sessionModelStatePair = typeof react.useState === "function"
      ? react.useState({ status: "idle", overrides: {}, revision: 0, live: false })
      : [{ status: "idle", overrides: {}, revision: 0, live: false }, () => {}];
    const sessionModelState = sessionModelStatePair[0];
    const setSessionModelState = sessionModelStatePair[1];
    /**
     * 未提交的编辑草稿（role -> {provider, model, reasoningEffort}）。
     *
     * 只有「用户确实改过」的角色才在这里有条目：没有条目的行直接显示权威覆盖或全局默认。
     * 覆盖/保存失败路径**绝不清空**草稿，冲突提示就是让用户在保留输入的前提下重试。
     */
    const sessionModelDraftsPair = typeof react.useState === "function" ? react.useState({}) : [{}, () => {}];
    const sessionModelDrafts = sessionModelDraftsPair[0];
    const setSessionModelDrafts = sessionModelDraftsPair[1];
    /**
     * 整批写入在途标记（保存/清除共用一把锁）。
     *
     * 弹窗一次可能提交多个角色（按角色展示顺序串行），因此不再按角色记账：只要有一轮
     * session-override-* 在途中，整块表格就锁成只读，避免用户在一次多角色提交的中途再改草稿
     * 或再点保存，制造必然冲突的重复提交。
     */
    const sessionModelSavingPair = typeof react.useState === "function" ? react.useState(false) : [false, () => {}];
    const sessionModelSaving = sessionModelSavingPair[0];
    const setSessionModelSaving = sessionModelSavingPair[1];
    const sessionModelNoticePair = typeof react.useState === "function" ? react.useState(null) : [null, () => {}];
    const sessionModelNotice = sessionModelNoticePair[0];
    const setSessionModelNotice = sessionModelNoticePair[1];
    // 「重新读取」只递增这个令牌：effect 依赖它，手动重读不会改动其它任何状态。
    const sessionModelReloadPair = typeof react.useState === "function" ? react.useState(0) : [0, () => {}];
    const sessionModelReloadToken = sessionModelReloadPair[0];
    const setSessionModelReloadToken = sessionModelReloadPair[1];
    /** 请求代次：每次新读取都递增，迟到的旧响应按序号丢弃（关闭/切会话后绝不写状态）。 */
    const sessionModelRequestSerialRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
    /** 最近一次成功读取覆盖的 root：只有它变了才清空草稿（手动重读保留用户输入）。 */
    const sessionModelLoadedRootRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /**
     * 注入的模型目录快照（设置页同一份 store）：{groups, status}。
     *
     * 只用于 provider/model 的 datalist 与思考深度档位；目录缺失时输入框照常可手填，
     * effort 下拉退化为「模型默认」且禁用，绝不伪造候选。
     */
    const sessionModelCatalogPair = typeof react.useState === "function"
      ? react.useState({ groups: [], status: "idle" })
      : [{ groups: [], status: "idle" }, () => {}];
    const sessionModelCatalog = sessionModelCatalogPair[0];
    const setSessionModelCatalog = sessionModelCatalogPair[1];
    /**
     * 「会话模型」入口按钮 / 弹窗节点的 DOM 引用与上一帧的展开状态（无障碍焦点归还）。
     *
     * 关闭弹窗后焦点必须回到入口按钮，否则键盘用户会掉回文档开头；但**首次挂载**时
     * 弹窗从未打开过，绝不能抢用户当前的焦点，因此用 wasOpen 记录上一帧状态，只在
     * 「上一帧打开 → 这一帧关闭」这一次转换上归还焦点。
     * 测试替身里 ref 不会真正挂载（current 恒为 null），调用方必须做可选调用。
     */
    const sessionModelEntryRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    const sessionModelWasOpenRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
    /** 原生 dialog 节点：打开时调用 showModal() 进入 top layer（不被右栏容器裁剪）。 */
    const sessionModelDialogRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /**
     * 读取 effect 上一次作用的 surface 身份（root + sidebar session）。
     *
     * 值变化 = 用户切走了（root A→B、root→子会话、子会话→root，含 A→B→A）：旧 surface 的
     * 在途保存不得继续把新 surface 的按钮锁在「保存中」，因此变化时清空 busy。
     */
    const sessionModelSurfaceRef = typeof react.useRef === "function"
      ? react.useRef({ rootSessionId: null, sidebarSessionId: null })
      : { current: { rootSessionId: null, sidebarSessionId: null } };

    /**
     * 任务状态播报（票据 18）：{ rootSessionId, tasks }。
     *
     * 基线放在 ref 里而不是 state：它只服务「上一份快照是什么」这一比较，不参与渲染。
     * 语义边界：
     * - 首次挂载 / 切换 root 时只建立基线，**绝不播报历史任务**（包括缓存首屏与重挂载）；
     * - 每次快照变化按 collectAnnouncementTasks + announcementTextOf 求差异，同内容轮询没有差异；
     * - 播报文本只在确实有事件时写入 state（同一帧最多一次 setState），因此 aria-live 区域
     *   不会因为轮询而反复重读同一句话。
     */
    const announcerRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    const announcementPair = typeof react.useState === "function" ? react.useState("") : ["", () => {}];
    const announcement = announcementPair[0];
    const setAnnouncement = announcementPair[1];

    Object.assign(frame, {
      announcement, announcerRef, autoOpenDraft, bump,
      emptyFilter, filterState, meta, metaStateRef,
      sessionModelCatalog, sessionModelDialogRef, sessionModelDrafts, sessionModelEntryRef,
      sessionModelLoadedRootRef, sessionModelNotice, sessionModelOpen,
      sessionModelReloadToken, sessionModelRequestSerialRef, sessionModelSaving, sessionModelState,
      sessionModelSurfaceRef, sessionModelWasOpenRef, setAnnouncement, setAutoOpenDraft, setFilterState, setMeta,
      setSessionModelCatalog, setSessionModelDrafts, setSessionModelNotice, setSessionModelOpen,
      setSessionModelReloadToken, setSessionModelSaving,
      setSessionModelState, setState, state, timelineExpandedRef, version,
      viewState,
    });
  }

  /** 右栏宽度拖拽 / 键盘调整与本地 aria 比例（渲染手柄节点）。 */
  function useSidebarPanelWidth(frame) {
    const {
      config, react,
    } = frame;

    /**
     * 右栏宽度拖拽（票据 18）：只在本面板拿到了 install 侧的两个注入点时才渲染手柄。
     *
     * 分工：
     * - Panel 只负责「这次拖拽/按键想把比例改成多少」与本地 aria-valuenow；
     * - install 侧负责 clamp 后的真实写入（setRightbar）与 localStorage 持久化。
     * 直接 createExpertGroupPanel（旧宿主/单测）没有注入点时完全不渲染手柄，
     * 绝不留下一个拖了没反应的控件。
     */
    const readWidthRatio = typeof config.readRightbarWidthRatio === "function" ? config.readRightbarWidthRatio : null;
    const applyWidthRatio = typeof config.applyRightbarWidthRatio === "function" ? config.applyRightbarWidthRatio : null;
    const widthRatioPair = typeof react.useState === "function"
      ? react.useState(() => {
        const stored = readWidthRatio === null ? null : clampRightbarWidthRatio(readWidthRatio());
        return stored === null ? RIGHTBAR_WIDTH_RATIO : stored;
      })
      : [RIGHTBAR_WIDTH_RATIO, () => {}];
    const widthRatio = widthRatioPair[0];
    const setWidthRatio = widthRatioPair[1];
    /** 拖拽会话：{ startX, startRatio, lastRatio, listeners }；null 表示没有在拖。 */
    const widthDragRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /**
     * 一次比例变更的唯一收口：先更新本地值（aria-valuenow 立刻反映），再交给 install 侧。
     * persist=false 用于拖动过程中的连续预览，避免每次 pointermove 都写一次 localStorage；
     * 松手/按键结束时用 persist=true 落盘。应用失败不抛给事件处理器：拖拽只是体验增强。
     */
    const commitWidthRatio = (value, options = {}) => {
      const clamped = clampRightbarWidthRatio(value);
      if (clamped === null) return null;
      setWidthRatio(clamped);
      if (applyWidthRatio !== null) {
        try { applyWidthRatio(clamped, { persist: options.persist === true }); } catch { /* 见上。 */ }
      }
      return clamped;
    };
    /** 拖拽事件宿主：优先 window（真实浏览器的 pointer 事件目标），缺失时退回 globalThis。 */
    const widthDragHost = () => {
      try { return globalThis.window ?? globalThis; } catch { return null; }
    };
    const detachWidthDrag = (drag) => {
      const host = widthDragHost();
      if (host === null || drag === null) return;
      try {
        host.removeEventListener?.("pointermove", drag.onMove);
        host.removeEventListener?.("pointerup", drag.onEnd);
        host.removeEventListener?.("pointercancel", drag.onEnd);
        host.removeEventListener?.("mousemove", drag.onMove);
        host.removeEventListener?.("mouseup", drag.onEnd);
      } catch { /* 移除失败不阻断松手收口。 */ }
    };
    const endWidthDrag = () => {
      const drag = widthDragRef.current;
      if (drag === null) return;
      widthDragRef.current = null;
      detachWidthDrag(drag);
      commitWidthRatio(drag.lastRatio, { persist: true });
    };
    const onWidthDragMove = (event) => {
      const drag = widthDragRef.current;
      if (drag === null) return;
      const clientX = Number(event?.clientX);
      if (Number.isFinite(clientX) !== true) return;
      event?.preventDefault?.();
      // 比例换算（手柄在右栏左缘：指针向左拖 → 右栏更宽 → 比例增大）与 clamp 归 panel-state-a。
      const next = PANEL_STATE_A.nextWidthRatioFromDrag({
        startX: drag.startX,
        startRatio: drag.startRatio,
        clientX,
        viewport: viewportWidthOf(),
      });
      if (next === null) return;
      drag.lastRatio = next;
      commitWidthRatio(next, { persist: false });
    };
    const onWidthDragStart = (event) => {
      // 写面是手柄存在的唯一条件；读面缺失时从本地 widthRatio（默认 20%）起手。
      if (applyWidthRatio === null) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const clientX = Number(event?.clientX);
      if (Number.isFinite(clientX) !== true) return;
      endWidthDrag();
      // 起手比例以**当前上屏值**为准（aria-valuenow 与拖拽必须同源）；
      // 注入的读面只在挂载那一帧参与初始化，避免拖拽过程中被外部旧值拉回。
      const startRatio = clampRightbarWidthRatio(widthRatio) ?? RIGHTBAR_WIDTH_RATIO;
      const drag = {
        startX: clientX,
        startRatio,
        lastRatio: startRatio,
        onMove: null,
        onEnd: null,
      };
      drag.onMove = (moveEvent) => onWidthDragMove(moveEvent);
      drag.onEnd = () => endWidthDrag();
      const host = widthDragHost();
      try {
        host?.addEventListener?.("pointermove", drag.onMove);
        host?.addEventListener?.("pointerup", drag.onEnd);
        host?.addEventListener?.("pointercancel", drag.onEnd);
        host?.addEventListener?.("mousemove", drag.onMove);
        host?.addEventListener?.("mouseup", drag.onEnd);
      } catch { /* 监听装不上时手柄仍可用键盘调整。 */ }
      widthDragRef.current = drag;
    };
    /**
     * 键盘调整：Left 缩窄 / Right 加宽（每次 2%），Home/End 直达边界。
     * 与拖拽共用同一条 commit 路径，方向键同样持久化。
     */
    const onWidthResizerKeyDown = (event) => {
      const key = event?.key;
      if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
      event?.preventDefault?.();
      event?.stopPropagation?.();
      // 键盘档位换算（2% 步长 / Home·End 直达边界）归 panel-state-a，与拖拽共用同一条 clamp。
      const next = PANEL_STATE_A.nextWidthRatioFromKey(key, widthRatio);
      if (next === null) return;
      commitWidthRatio(next, { persist: true });
    };
    /**
     * 宽度手柄节点：role=separator + 比例 aria 值，指针与键盘两条调整路径共用本地 widthRatio。
     * 手柄只在有写入能力（apply）时出现；read 缺失时按默认比例初始化（仍可拖拽）。
     */
    const widthResizer = applyWidthRatio === null
      ? null
      : react.createElement("div", {
        className: "deg_expert_group_resizer",
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": "调整右栏宽度",
        "aria-valuemin": Math.round(RIGHTBAR_WIDTH_RATIO_MIN * 100),
        "aria-valuemax": Math.round(RIGHTBAR_WIDTH_RATIO_MAX * 100),
        "aria-valuenow": Math.round(widthRatio * 100),
        "data-dragging": widthDragRef.current !== null ? "true" : undefined,
        tabIndex: 0,
        onPointerDown: onWidthDragStart,
        onMouseDown: onWidthDragStart,
        onKeyDown: onWidthResizerKeyDown,
      });

    Object.assign(frame, { widthResizer });
  }

  /** 展开态 store、跨 await 的身份 ref 与宿主 meta 单飞读取。 */
  function useSidebarPanelStoreAndMeta(frame) {
    const {
      config, ctx, model, react, rootSessionId, setMeta,
      sidebarSessionId,
    } = frame;

    // 展开状态只依赖 storage 与 root；缓存 store 可避免每次 RPC/通知重渲染都重复读取
    // sessionStorage 和解析同一份展开键。
    const createStore = () => typeof model.createExpansionStore === "function"
      ? model.createExpansionStore({ storage: config.storage, rootSessionId })
      : null;
    const store = typeof react.useMemo === "function"
      ? react.useMemo(createStore, [config.storage, rootSessionId])
      : createStore();
    const mountedRef = typeof react.useRef === "function" ? react.useRef(true) : { current: true };
    const requestSequenceRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
    const contextRef = typeof react.useRef === "function" ? react.useRef(ctx) : { current: ctx };
    contextRef.current = ctx;
    /**
     * 最近一次渲染算出的根会话 id（每次渲染同步写入，与 contextRef 同一模式）。
     *
     * 管理动作（取消/重试）在确认弹窗的 await 之后才发请求，而确认弹窗是宿主级模态：
     * 用户完全可能在它打开期间切换会话。那时 runAction 闭包里捕获的 rootSessionId 已经过期，
     * 用它发请求会把动作打到用户已经切走的旧会话上。这里保存当前选中值，确认完成后重读，
     * 保证动作始终绑定「请求发出这一刻」面板正在展示的根会话。
     */
    const currentRootRef = typeof react.useRef === "function" ? react.useRef(rootSessionId) : { current: rootSessionId };
    currentRootRef.current = rootSessionId;
    const currentSidebarSessionRef = typeof react.useRef === "function" ? react.useRef(sidebarSessionId) : { current: sidebarSessionId };
    currentSidebarSessionRef.current = sidebarSessionId;
    /**
     * 票据 25/26/27/28：meta 读取的单飞标记与懒加载记账。
     *
     * meta 是旁路读面（角色显示名/单价/限流诊断/全局用量），不是任务树的第二事实源：
     * 读失败一律静默保持 null（UI 回退角色 id / 「未配置单价，不估算」），绝不写标题栏
     * 错误槽——否则一次诊断读取失败会让用户以为任务树坏了。
     */
    const metaRequestRef = typeof react.useRef === "function" ? react.useRef({ inFlight: false, promise: null }) : { current: { inFlight: false, promise: null } };
    /** 已经为哪个 root 触发过「快照有用量 ⇒ 自动读 meta」，每个 root 最多一次。 */
    const metaAutoAttemptRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /** runAction 尾随刷新使用的 meta 刷新入口（每次渲染同步写入，避免闭包陈旧）。 */
    const metaRefreshRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };

    /**
     * 读取宿主 meta（唯一入口，单飞）。
     *
     * 只在明确的用户读面或快照出现用量事实时调用；返回值只给调用方做「读到了/没读到」
     * 判定，失败静默（UI 保持「角色 id / 未配置单价」的保守显示）。
     *
     * 单飞的返回语义必须是「共享同一个在途 Promise」而不是 null：null 会被调用方读成
     * 「这次没拿到（能力未知）」，于是「会话模型」会在 meta 还在路上的时候多发一次
     * session-override-get —— 这是一次纯浪费的请求，而旧宿主可能对未知 action 回
     * bad-request，把界面错误地降级成 unsupported。调用方 await 同一个 Promise 才能等到
     * 真正的能力声明。
     */
    const loadMeta = async () => {
      if (mountedRef.current !== true) return null;
      const request = metaRequestRef.current;
      if (request.inFlight === true) {
        // 兼容没有 promise 字段的旧状态形状：拿不到共享句柄时仍退回 null ——
        // 宁可让调用方按「能力未知」走实测 get，也绝不让它永久挂起。
        return typeof request.promise?.then === "function" ? request.promise : null;
      }
      request.inFlight = true;
      const pending = (async () => {
        try {
          const body = await callRpc(config, contextRef.current, { action: "meta" }, {}, (value) => object(value));
          if (mountedRef.current !== true) return null;
          const normalized = normalizeHostMeta(body);
          setMeta(normalized);
          return normalized;
        } catch {
          // 旁路读面失败不写错误槽：角色 id 与「未配置单价，不估算」仍是诚实显示。
          // 失败仍返回 null：调用方保留下游「meta 失败 ⇒ 实测一次 get」的降级路径。
          return null;
        } finally {
          // 只有真正发起请求的这一支负责清账；所有等待方共享同一个已结算的 Promise。
          request.inFlight = false;
          request.promise = null;
        }
      })();
      request.promise = pending;
      return pending;
    };
    metaRefreshRef.current = loadMeta;

    Object.assign(frame, {
      contextRef, currentRootRef, currentSidebarSessionRef, loadMeta, metaAutoAttemptRef,
      metaRefreshRef, mountedRef, requestSequenceRef, store,
    });
  }

  /**
   * 「恢复默认」的唯一实现：清除本会话**全部角色**覆盖并立即保存（不是把当前值写成覆盖）。
   *
   * 为什么必须串行：session-override-clear 一次只处理一个角色，每次写入都推进代次，
   * 因此每个请求的 expectedRevision 只能用上一次响应的 revision（首个用当前投影的代次）。
   * 任何一次冲突/失败都立刻停止后续请求：剩余角色仍保持原覆盖，绝不半途改成另一种口径。
   * 全部成功才清空草稿——宿主侧已无覆盖，草稿既没有基线也没有可提交的差异。
   *
   * surface 闸门与批量保存一致：旧 surface 的迟到回执只丢弃本地写入，
   * 宿主写入仍按 CAS 落库，重新打开时以权威读取为准。
   * 放在模块级而不是 Hook 内：Hook 已贴近「单函数 ≤200 行」门禁，40 多行异步流程
   * 留在这里既不影响 Hook 的调用顺序，也不改变任何语义。
   */
  async function restoreSessionModelDefaultsOf(deps) {
    const {
      applySessionModelView, config, contextRef, metaStateRef, rootSessionId, sessionModelState,
      sessionModelWriteReady, setSessionModelDrafts, setSessionModelNotice, setSessionModelSaving,
      settleSessionModelFailure, sidebarSurfaceStillCurrent, t,
    } = deps;
    if (sessionModelWriteReady() !== true) return;
    const rolesToClear = Object.keys(object(sessionModelState.overrides));
    if (rolesToClear.length === 0) {
      // 没有可清除的覆盖：不产生任何写入，只把本地草稿收敛回空（按钮此时本身也是禁用的）。
      setSessionModelDrafts({});
      return;
    }
    const targetSessionId = rootSessionId;
    const roles = sessionModelRowKeysOf(metaStateRef.current);
    setSessionModelSaving(true);
    setSessionModelNotice(null);
    let revision = sessionModelState.revision;
    try {
      for (const role of rolesToClear) {
        const body = await callRpc(
          config,
          contextRef.current,
          { action: "session-override-clear", sessionId: targetSessionId, role, expectedRevision: revision },
          {},
          (value) => object(value),
        );
        if (sidebarSurfaceStillCurrent() !== true) return;
        const view = normalizeSessionModelView(body, roles);
        if (view === null) {
          setSessionModelNotice({ kind: "error", role, text: t("sidebar.sessionModel.unavailable") });
          return;
        }
        revision = view.revision;
        applySessionModelView(view, role);
      }
      if (sidebarSurfaceStillCurrent() !== true) return;
      setSessionModelDrafts({});
      setSessionModelNotice({ kind: "cleared", revision });
    } catch (error) {
      // 失败/冲突回执走的仍是保存那条收口：只提示、推进基线、绝不清空用户输入。
      if (sidebarSurfaceStillCurrent() !== true) return;
      settleSessionModelFailure(error, null);
    } finally {
      if (sidebarSurfaceStillCurrent() === true) setSessionModelSaving(false);
    }
  }

  /**
   * 某个角色行的权威基线（草稿起点与「可提交改动」共用同一份判据）。
   *
   * 主代理是覆盖表里的保留键、不在 meta.roleDefaults 里：它的显示值只能按读面 applyState
   * 语义取（applied / manual 为实际套用值，其余为期望配置），否则「只改思考深度」就成了
   * 缺 provider/model 的非法草稿（E3）；其余角色仍跟随全局默认。
   */
  function sessionModelBaselineOfFrame(sessionModelState, meta, role) {
    return PANEL_STATE_B.sessionModelBaselineOf(sessionModelState.overrides, meta?.roleDefaults, role,
      sessionModelOrchestratorOf(sessionModelState.orchestrator, meta).selection);
  }

  /** 会话模型草稿 / 提交 / 清除与 surface 身份令牌。 */
  function useSidebarPanelSessionModel(frame) {
    const {
      config, contextRef, metaStateRef, mountedRef, rootSessionId, sessionModelCatalog,
      sessionModelDrafts, sessionModelSaving, sessionModelState, setSessionModelDrafts, setSessionModelNotice,
      setSessionModelReloadToken, setSessionModelSaving, setSessionModelState, sidebarSessionId, t,
    } = frame;
    // 跨 Hook 前向引用的晚绑定包装：这些函数由后续 Hook 声明并登记到 frame.late；
    // 本 Hook 里的调用全部发生在渲染之后的异步 / 事件路径，因此转发保持原来的调用时机与顺序。
    const sidebarSurfaceStillCurrent = (...args) => frame.late.sidebarSurfaceStillCurrent(...args);

    /**
     * 角色行草稿 / 权威基线 / 可提交改动 / 本地校验 / 失败收口（R6 票据 22）：
     * 全部「上一版 → 下一版」的纯转移都在 client-sidebar-panel-state-b.js。
     * 本层只提供本帧的 state / meta ref / setState，并把结果写回两个 state。
     */
    const updateSessionModelDraft = (role, field, value) => {
      setSessionModelDrafts((previous) => PANEL_STATE_B.nextSessionModelDrafts({
        previous,
        role,
        field,
        value,
        // 草稿起点与**显示值**同源（判据见 sessionModelBaselineOfFrame），否则只改思考深度
        // 会因缺 provider/model 被判成非法草稿而无法保存（E3）。
        baseline: sessionModelBaselineOfFrame(sessionModelState, metaStateRef.current, role),
        groups: sessionModelCatalog.groups,
      }));
      setSessionModelNotice(null);
    };

    /** 当前可提交的改动（只算确有草稿、字段完整、且与权威基线不同的角色）。 */
    const sessionModelPendingChanges = () => PANEL_STATE_B.sessionModelPendingChangesOf({
      drafts: sessionModelDrafts,
      meta: metaStateRef.current,
      baselineOf: (role) => sessionModelBaselineOfFrame(sessionModelState, metaStateRef.current, role),
    });

    /** 本地校验：任一草稿缺 provider/model 就不允许保存（按钮禁用 + 底部提示）。 */
    const sessionModelHasInvalidDraft = () => PANEL_STATE_B.sessionModelHasInvalidDraftOf({
      drafts: sessionModelDrafts,
      meta: metaStateRef.current,
    });

    /** 写成功后**合并**权威投影（替换会丢掉只由 get 提供的主代理读面，C1）+ 删除该角色草稿。 */
    const applySessionModelView = (view, role) => {
      setSessionModelState((previous) => ({ ...previous, status: "ready", overrides: view.overrides, revision: view.revision, live: view.live }));
      setSessionModelDrafts((previous) => PANEL_STATE_B.withoutRoleDraft(previous, role));
      // 主代理写入成功后 Host 才排队 apply（此刻读面必为 pending）：800ms 后复用「重新读取」同一入口
      // 做一次收敛读取，把 pending 落到 applied / unapplied（失败走既有失败分支，不再静默留旧值）；
      // 每次写入至多排一次、重读不再排 ⇒ 不新增 RPC 入口、不常驻轮询。
      if (role === "orchestrator") setTimeout(() => setSessionModelReloadToken((value) => value + 1), 800);
    };

    /**
     * 冲突/失败回执的统一收口：判定与文案描述归 panel-state-b，
     * 这里只把描述写进两个 state（保留未提交草稿的语义原样不变）。
     */
    const settleSessionModelFailure = (error, role) => {
      const roles = sessionModelRowKeysOf(metaStateRef.current);
      const outcome = PANEL_STATE_B.describeSessionModelFailure({ error, role, roles, t });
      if (outcome.statePatch !== null) {
        const patch = outcome.statePatch;
        setSessionModelState((previous) => ({
          ...previous,
          status: "ready",
          revision: patch.revision === null ? previous.revision : patch.revision,
          overrides: patch.overrides === null ? previous.overrides : patch.overrides,
        }));
      }
      setSessionModelNotice(outcome.notice);
    };

    /** 保存/清除的公共前置条件（判据归 panel-state-b，mounted 与 surface 身份由本层提供）。 */
    const sessionModelWriteReady = () => PANEL_STATE_B.sessionModelWriteReadyOf({
      mounted: mountedRef.current,
      state: sessionModelState,
      saving: sessionModelSaving,
      rootSessionId,
      sidebarSessionId,
    });

    /**
     * 提交底部「保存」：按角色展示顺序串行发送 session-override-set。
     *
     * 代次是唯一的并发栅栏：每个请求的 expectedRevision 都用上一次响应的 revision
     * （首个用打开时读到的 revision）。任何一次冲突/失败都立即停止后续请求，保留未提交草稿；
     * 只有全部成功才提示 saved。await 之后一律先过 sidebarSurfaceStillCurrent()：
     * 闸门只丢弃本地 UI 写入，Host 写入仍按 CAS 落库，重新打开时以权威读取为准。
     */
    const commitSessionModelChanges = async () => {
      if (sessionModelWriteReady() !== true) return;
      if (sessionModelHasInvalidDraft()) return;
      const changes = sessionModelPendingChanges();
      if (changes.length === 0) return;
      const targetSessionId = rootSessionId;
      const roles = sessionModelRowKeysOf(metaStateRef.current);
      setSessionModelSaving(true);
      setSessionModelNotice(null);
      let revision = sessionModelState.revision;
      try {
        for (const change of changes) {
          const body = await callRpc(
            config,
            contextRef.current,
            {
              action: "session-override-set",
              sessionId: targetSessionId,
              role: change.role,
              expectedRevision: revision,
              selection: change.selection,
            },
            {},
            (value) => object(value),
          );
          if (sidebarSurfaceStillCurrent() !== true) return;
          const view = normalizeSessionModelView(body, roles);
          if (view === null) {
            setSessionModelNotice({ kind: "error", role: change.role, text: t("sidebar.sessionModel.unavailable") });
            return;
          }
          revision = view.revision;
          applySessionModelView(view, change.role);
        }
        if (sidebarSurfaceStillCurrent() !== true) return;
        // 主代理的覆盖只在下一次派发时套用：保存提示必须写明「下一轮生效」，不能只说"已保存"。
        setSessionModelNotice({
          kind: "saved",
          ...(changes.some((change) => change.role === "orchestrator")
            ? { text: t("sidebar.sessionModel.orchestrator.saved") }
            : {}),
          revision,
        });
      } catch (error) {
        // 失败/冲突回执走同一道 surface 闸门：旧 surface 的错误绝不写进新 surface 的提示槽。
        if (sidebarSurfaceStillCurrent() !== true) return;
        settleSessionModelFailure(error, changes[changes.length - 1]?.role ?? null);
      } finally {
        // 锁按 surface 归属释放：A 会话的迟到回执不得提前解除 B 会话正在进行的保存锁。
        if (sidebarSurfaceStillCurrent() === true) setSessionModelSaving(false);
      }
    };

    /**
     * 行内「×」：立即清除该角色的本会话覆盖。
     *
     * 与批量保存共用同一把 sessionModelSaving 锁；成功用响应刷新状态并删掉该行草稿，
     * 冲突/失败按保存同一套语义收口（保留草稿、推进基线、只提示）。
     */
    const clearSessionModelRole = async (role) => {
      if (sessionModelWriteReady() !== true) return;
      if (sessionModelState.overrides[role] === undefined) return;
      const targetSessionId = rootSessionId;
      const roles = sessionModelRowKeysOf(metaStateRef.current);
      setSessionModelSaving(true);
      setSessionModelNotice(null);
      try {
        const body = await callRpc(
          config,
          contextRef.current,
          {
            action: "session-override-clear",
            sessionId: targetSessionId,
            role,
            expectedRevision: sessionModelState.revision,
          },
          {},
          (value) => object(value),
        );
        if (sidebarSurfaceStillCurrent() !== true) return;
        const view = normalizeSessionModelView(body, roles);
        if (view === null) {
          setSessionModelNotice({ kind: "error", role, text: t("sidebar.sessionModel.unavailable") });
          return;
        }
        applySessionModelView(view, role);
        setSessionModelNotice({ kind: "cleared", role, revision: view.revision });
      } catch (error) {
        if (sidebarSurfaceStillCurrent() !== true) return;
        settleSessionModelFailure(error, role);
      } finally {
        if (sidebarSurfaceStillCurrent() === true) setSessionModelSaving(false);
      }
    };

    /**
     * 底部「恢复默认」：清除本会话全部角色覆盖并立即保存。
     * 语义（串行 CAS、surface 闸门、失败收口）全在模块级 restoreSessionModelDefaultsOf，
     * 本闭包只交出本帧的读写面，避免把 50 多行异步流程塞进本 Hook 撞函数行数门禁。
     */
    const restoreSessionModelDefaults = () => restoreSessionModelDefaultsOf({
      applySessionModelView, config, contextRef, metaStateRef, rootSessionId, sessionModelState,
      sessionModelWriteReady, setSessionModelDrafts, setSessionModelNotice, setSessionModelSaving,
      settleSessionModelFailure, sidebarSurfaceStillCurrent, t,
    });

    Object.assign(frame, {
      clearSessionModelRole, commitSessionModelChanges, restoreSessionModelDefaults,
      sessionModelHasInvalidDraft, sessionModelPendingChanges, updateSessionModelDraft,
    });
  }

  /** undefined */
  function useSidebarPanelSessionModelPart2(frame) {
    const {
      currentRootRef, currentSidebarSessionRef, mountedRef, react, rootSessionId, sidebarSessionId,
    } = frame;

    /**
     * surface 身份令牌：给每一条「跨 await 的异步动作」用的**不可复用**身份。
     *
     * 症状与根因：异步动作（自动打开/关闭、批量关闭、等待竞争租约）在 await 之后只用
     * mountedRef + currentRootRef + currentSidebarSessionRef 复核「当前 surface」。这三条判据
     * 比较的是**当前字符串值**，于是有一条真实交错会漏过去：同一个 Panel 实例快速
     * root/sidebar session A→B→A 之后，旧闭包捕获的字符串会与当前值**重新相等**——旧动作由此
     * 把自己的迟到收尾当成当前 surface 的收尾继续执行，删掉「A 里已经换成新 tabId 的 record /
     * Auto 来源」，并用旧快照推进同步。字符串判据挡得住「切走了没回来」，挡不住「切走又切回」。
     *
     * 因此每个 Panel 实例在挂载时生成一份唯一身份，并在 sidebarSessionId / rootSessionId 每一次
     * 变化时换成**新对象**（A→B→A 两次都换）：异步动作启动时捕获自己那一份，await 之后只回答
     * 「还是不是我出发时那一份」。令牌必须比较对象身份，绝不能只比较当前字符串值。
     *
     * 生成时机：首次渲染（挂载）与「root/sidebar session 与上一帧不同」的那一帧。同一组值下的
     * 普通重渲染（轮询、通知、展开状态变化）与 StrictMode 的双渲染都不会换令牌（hook 槽位不变），
     * 因此正在执行的异步动作不会被误判成 stale；组件重挂载则必然换（新实例 = 新 ref 槽位）。
     */
    const surfaceTokenScopeRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    const surfaceTokenRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    // 令牌派生（同样的 session 值 ⇒ 同一个对象；任一变化 ⇒ 两份新对象）归 panel-state-a，
    // 这里只把结果写回两个 ref —— 对象身份判据因此逐字不变。
    const derivedSurfaceToken = PANEL_STATE_A.deriveSurfaceToken(
      surfaceTokenScopeRef.current,
      surfaceTokenRef.current,
      rootSessionId,
      sidebarSessionId,
    );
    surfaceTokenScopeRef.current = derivedSurfaceToken.scope;
    surfaceTokenRef.current = derivedSurfaceToken.token;
    /** 本帧闭包捕获的 surface 身份：所有异步动作在启动时捕获它，await 之后只与这一份比较。 */
    const surfaceToken = surfaceTokenRef.current;
    /**
     * 异步动作的 surface 闸门：mounted / root / sidebar session 三条既有判据**同时**成立，
     * 并且令牌仍然是出发时那一份，才允许继续。
     *
     * 两组判据缺一不可：字符串判据负责「切走了、没回来」与「别的 root 的同地址记录」，令牌负责
     * 「切走了又切回同一组值」（A→B→A）与「重挂载后的旧闭包」。await 之后、旧闭包调用
     * syncSidebarTabs() 之前、以及会改共享 Auto 账本 / 记录 / 手动抑制的迟到收尾分支，都必须先过
     * 这一道闸门。
     */
    const sidebarSurfaceStillCurrent = () => mountedRef.current === true
      && currentRootRef.current === rootSessionId
      && currentSidebarSessionRef.current === sidebarSessionId
      && surfaceTokenRef.current === surfaceToken;

    // 登记给更早 Hook 的晚绑定包装（声明已完成，此后的调用都拿到本帧的实例）。
    frame.late.sidebarSurfaceStillCurrent = sidebarSurfaceStillCurrent;
    Object.assign(frame, { sidebarSurfaceStillCurrent });
  }

  /** 宿主服务解析、Auto 开关、split 事务入口与无标签同步读面。 */
  function useSidebarPanelHostServices(frame) {
    const {
      clearSidebarAutoManualSuppressions, config, contextRef, rootSessionId, sessionId,
      setAutoOpenDraft, sidebarRight, sidebarSessionId,
    } = frame;

    const navigation = getOpenSession(config, contextRef.current);
    /**
     * Auto（自动打开运行中的子代理侧栏）的实时读面：install 注入的 getter，每次同步现读。
     *
     * 直接 createExpertGroupPanel（旧宿主/单测）没有该依赖时按**关闭**处理：默认行为必须
     * 与历史逐字节一致（不做任何自动 open/close）。读取抛错同样按关闭处理——自动行为只是
     * 体验增强，绝不能影响面板渲染或既有的手动箭头。
     */
    const readAutoOpenSetting = typeof config.getAutoOpenSubagentSidebar === "function"
      ? config.getAutoOpenSubagentSidebar
      : null;
    /** 面板标题栏 Auto 开关的写面；缺失时开关只读（渲染 disabled），绝不假装能改。 */
    const writeAutoOpenSetting = typeof config.setAutoOpenSubagentSidebar === "function"
      ? config.setAutoOpenSubagentSidebar
      : null;
    const autoOpenEnabled = () => {
      if (readAutoOpenSetting === null) return false;
      try { return readAutoOpenSetting() === true; } catch { return false; }
    };
    /**
     * 标题栏 Auto 开关的点击处理：先本地乐观翻转，再把显式布尔交给写面持久化。
     *
     * 写面缺失或返回非 true（只读文档、宿主校验/并发失败）时立刻清掉本地值，开关回退到权威读面；
     * 成功时本地值与读面一致，下一次同步观察到权威值变化会再清一次（幂等，绝不闪回）。
     */
    const toggleAutoOpen = (next) => {
      const value = next === true;
      if (writeAutoOpenSetting === null) return;
      setAutoOpenDraft(value);
      void Promise.resolve()
        .then(() => writeAutoOpenSetting(value))
        .then(
          (accepted) => {
            if (accepted !== true) {
              setAutoOpenDraft(null);
              return;
            }
            /**
             * 由关→开 = 重新授权自动打开：解除本 scope 的手动关闭抑制，且**两层都要解除**——
             * 持久 manual 归属（跨刷新，账本负责）与本页 realm 内存抑制表（同一页面生命周期，
             * 见 hooks-tabs 的 clearSidebarAutoSuppressionsOfScope 晚绑定）。只清一层时，同一页面里
             * 手动关过的仍在运行资源仍会被 autoOpenCandidate 跳过，直到它回到 ready 才恢复。
             *
             * 只有**写面确认接受**且 value === true 时才清：写失败 / 只读文档时开关并没有真的打开，
             * 顺手清抑制等于替用户撤销了他从未表达过的意图。关闭（false）时什么也不做——抑制正是
             * 「关闭」需要保留的记忆。
             *
             * scope 用 sidebarSessionId + rootSessionId：归属账本与内存抑制表的所有写入点都以这
             * 两个值为键，清理必须落在同一个 scope 上。缺依赖（旧宿主 / 直接 createExpertGroupPanel）
             * 时静默跳过：Auto 开关本身照常持久化，行为退回没有这条恢复路径。
             */
            // 清理失败不影响「Auto 已打开」这个事实：下一轮同步仍会按持久层判定。
            if (value === true) {
              if (typeof clearSidebarAutoManualSuppressions === "function") {
                try { clearSidebarAutoManualSuppressions(sidebarSessionId, rootSessionId); } catch {}
              }
              frame.late.clearSidebarAutoSuppressionsOfScope?.();
            }
          },
          () => { setAutoOpenDraft(null); },
        );
    };
    // 新版宿主提供公开 split()，返回新 pane 的 PaneId；只有拿到这个回执后才打开资源，
    // 避免 preferNewPane 失败时静默回落到 Expert Group 所在 pane。旧宿主没有 split() 时
    // 保留 preferNewPane 兼容路径，但绝不调用 float()，不制造用户可见浮窗。
    const splitSidebarPane = methodOf(sidebarRight, "split");
    // 可关闭 toggle 的两个方法能力：close() 负责关闭，active()/openTabs 提供「打开后真的落地了」的证据。
    // 两类确认能力都可能缺失（旧宿主），此时箭头退回静态 >> 打开行为，绝不猜 tabId。
    const closeSidebarResource = methodOf(sidebarRight, "close");
    // 宽度不足时 openResource 会按宿主契约回落到当前 pane；插件不调用 float，
    // 避免把用户的右栏页面变成独立悬浮窗口。右栏宽度策略在 install 侧统一处理。
    const readActiveSidebarResource = methodOf(sidebarRight, "active");
     /**
      * 读取公开 openTabs inventory：它按 Session 给出已提交 tab 的 tabId/kind/contentId，
      * 不依赖 active pane，因此宿主将焦点留在其它 pane/tab 时仍能确认目标子代理。
      * 旧宿主没有该 inventory 或读取失败时返回 null，调用方继续使用 active() 兼容路径。
      */
     const readSidebarOpenTabs = () => {
       let inventory = null;
       try { inventory = sidebarRight?.openTabs ?? null; } catch { return null; }
       const getSnapshot = methodOf(inventory, "getSnapshot");
       if (getSnapshot === null) return null;
       try {
         const snapshot = getSnapshot.call(inventory);
         return Array.isArray(snapshot) ? snapshot : null;
       } catch { return null; }
     };
    /**
     * split 同步的检查点（R6 票据 22）：右栏 tab/pane 读面计算的唯一 owner 是
     * client-sidebar-split-sync.js。这里只把「本帧的 surface 身份 + inventory 读面」绑进去，
     * 绝不复制 DOM 判定（复制即双 owner，两条判定迟早漂移）。
     *
     * 适配层保持与拆分前**同名同实参**：调用点一行未改，行为等价由既有用例锁定。
     */
    const presentSidebarTabIds = () => SPLIT_SYNC.presentSidebarTabIds(globalThis.document, sidebarSessionId);
    const existingSubagentPaneId = () => SPLIT_SYNC.existingSubagentPaneId(
      globalThis.document,
      sidebarSessionId,
      readSidebarOpenTabs(),
    );
    const sidebarSplitTargetEvidence = (resourceAddress, expectedPaneId = null) => SPLIT_SYNC.sidebarSplitTargetEvidence({
      doc: globalThis.document,
      sidebarSessionId,
      inventory: readSidebarOpenTabs(),
      resourceAddress,
      expectedPaneId,
    });
    const seededGuideTabId = (beforeTabs, sessionId) => SPLIT_SYNC.seededGuideTabId(
      beforeTabs,
      sessionId,
      readSidebarOpenTabs(),
    );
    /** 等宿主完成一次布局提交（RAF → 宏任务 → microtask 的既有优先级不变）。 */
    const waitForSidebarSplitLayoutCommit = SPLIT_SYNC.waitForSidebarSplitLayoutCommit;

    Object.assign(frame, {
      autoOpenEnabled, closeSidebarResource, existingSubagentPaneId, navigation, presentSidebarTabIds, readActiveSidebarResource,
      readSidebarOpenTabs, seededGuideTabId, sidebarSplitTargetEvidence, splitSidebarPane, toggleAutoOpen,
      waitForSidebarSplitLayoutCommit, writeAutoOpenSetting,
    });
  }

  /** 快照派生：openTabs 可用性、partial 标记与用量事实。 */
  function useSidebarPanelSnapshotDerived(frame) {
    const {
      readSidebarOpenTabs, viewState,
    } = frame;

           const sidebarOpenTabsAvailable = readSidebarOpenTabs() !== null;
                   const snapshot = viewState.snapshot;
    /**
     * 轻量（partial）快照标记：Host 首屏返回 partial:true 表示它跳过了全部冷读，
     * 状态与任务名可能不完整。渲染层据此把「没有任何活动证据」的圆点与活动文案保持中性；
     * 完整快照（partial:false/缺失）与旧宿主一律走既有渲染路径，逐字不变。
     */
    const partialSnapshot = snapshot?.partial === true;
    /**
     * 票据 25：快照里第一次出现用量事实时，懒加载一次 meta（单价/全局用量）。
     *
     * 为什么按需而不是挂载即读：既有契约把「挂载只发一次首屏快照」写进了请求计数测试，
     * 诊断是旁路读面，绝不能改变轮询节奏；而没有用量时也不需要单价。
     * 每个 root 最多触发一次（metaAutoAttemptRef），失败不重试、不写错误槽。
     */
    const usageFactPresent = snapshot === null ? false : snapshotHasUsageFact(snapshot);

    Object.assign(frame, {
      partialSnapshot, sidebarOpenTabsAvailable, snapshot, usageFactPresent,
    });
  }

  /** 标题栏峰谷标记的分钟级重算间隔（票据 09）：跨过峰段边界后无需刷新即可更新。 */
  const PV_MARKER_MS = 60000;
  /** 未启用（或读面缺失）时的固定标记：宁可显示「未启用」，绝不猜成峰时。 */
  const PV_DISABLED = Object.freeze({ enabled: false, period: "valley" });

  /**
   * 读一次峰谷标记：判定**只**调 client.peakValleyTime（shared/peak-valley-time.js 的权威纯函数），
   * 不另写时段算法，也不按当前 settings 推断回执字段。读面缺失/抛错/未显式启用一律「未启用」；
   * 时段数组原样交给权威函数（它对非法项 fail-closed，不抛异常）。
   */
  function readPvMarker(config) {
    let settings = null;
    try { settings = config?.getPeakValleySettings?.() ?? null; } catch { return PV_DISABLED; }
    if (settings?.enabled !== true) return PV_DISABLED;
    const at = config?.peakValleyTime;
    return {
      enabled: true,
      period: typeof at?.peakValleyAtDate === "function" && at.peakValleyAtDate(settings.periods, new Date()) === "peak" ? "peak" : "valley",
    };
  }

  /**
   * 标题栏「峰谷时段标记」（票据 09）：Auto 右侧显示 峰时 / 谷时 / 峰谷：未启用。
   *
   * - 挂载即读（useState 惰性初始化）：首帧即按当前时段渲染，不先闪一帧「未启用」；
   * - 启用才定时：仅 enabled === true 启动 60s 重算，未启用**不创建**任何定时器；
   * - 设置变更即时生效：有 subscribePeakValleySettings 时订阅表单，保存后立刻重算；
   *   没有订阅能力（旧宿主/直接 createExpertGroupPanel）时降级为每次渲染现读；
   * - 订阅与定时器都只在 effect 内创建，cleanup 统一释放；Hook 无条件调用（序列固定）。
   */
  function useSidebarPanelPeakValleyMarker(frame) {
    const { config, react } = frame;
    const pair = typeof react.useState === "function"
      ? react.useState(() => readPvMarker(config))
      : [readPvMarker(config), null];
    const marker = pair[0];
    const setMarker = pair[1];
    const subscribe = config?.subscribePeakValleySettings ?? null;
    // 无订阅能力时每次渲染现读（设置页保存后，面板下一次渲染即可追上）。
    const shown = subscribe === null || setMarker === null ? readPvMarker(config) : marker;
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        const refresh = () => setMarker((previous) => {
          const next = readPvMarker(config);
          return previous.enabled === next.enabled && previous.period === next.period ? previous : next;
        });
        let release = null;
        try { release = subscribe === null ? null : subscribe(refresh); } catch {}
        const timer = shown.enabled === true ? globalThis.setInterval(refresh, PV_MARKER_MS) : null;
        return () => {
          if (typeof release === "function") release();
          if (timer !== null) globalThis.clearInterval(timer);
        };
      }, [subscribe, shown.enabled, config]);
    }
    Object.assign(frame, { peakValleyMarker: shown });
  }

  global[SYMBOL] = Object.freeze({
    useSidebarPanelHostServices, useSidebarPanelPeakValleyMarker, useSidebarPanelSessionModel, useSidebarPanelSessionModelPart2,
    useSidebarPanelSnapshotDerived, useSidebarPanelStateCore, useSidebarPanelStoreAndMeta,
    useSidebarPanelWidth,
  });
})(globalThis);
