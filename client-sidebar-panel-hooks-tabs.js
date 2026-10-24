/**
 * 客户端侧栏 · Panel 自定义 Hook（tab 记账与 Auto 编排）
 *
 * 这些 Hook 由 client-sidebar-panel.js 的 Panel 组件按**固定顺序**调用；每个 Hook 内部
 * 的 react.use* 调用顺序、effect 依赖数组、setup / cleanup 归属都与拆分前逐字相同。
 * 拆分只把原来同一个函数体里的连续语句段移进独立函数，因此运行期 Hook 派发序列不变。
 */
(function installSidebarPanelHooksTabs(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-tabs");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_KEY_LIMIT, SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS, SIDEBAR_TAB_KEY_SEPARATOR, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    methodOf, normalizeSubagentAddress, sidebarTabKey,
  } = DOM;
  const TAB_STATE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-tab-state");
  const TAB_STATE = global[TAB_STATE_SYMBOL] || {};
  const AUTO_CONTROLLER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-controller");
  const AUTO_CONTROLLER = global[AUTO_CONTROLLER_SYMBOL] || {};
  const SIDEBAR_ACTIONS_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-actions");
  const SIDEBAR_ACTIONS = global[SIDEBAR_ACTIONS_SYMBOL] || {};

  /**
   * 清除某个 scope 的**内存**手动关闭抑制（标题栏 Auto 由关→开 = 重新授权）。
   *
   * 抑制表是 realm 级 Map：键与 sidebarTabKey 同构，条目形如 { sessionId, rootSessionId, address }。
   * 只删 (sessionId, rootSessionId) **逐字相等**的条目——别的会话 / root 的抑制是那边用户的意图，
   * 绝不能被另一处的开关顺手清掉；返回删除条数（0 表示本来就没有抑制）。
   *
   * 独立成模块级纯函数：承载它的 Hook 已贴着 200 行上限，本逻辑也不依赖 React 状态，放在闭包里
   * 只会给 Hook 增行、给「闭包内函数数」加数，收益为零。
   */
  function clearAutoSuppressionsOfScope(suppressed, sessionId, rootSessionId) {
    let removed = 0;
    for (const [key, entry] of suppressed) {
      if (entry.sessionId !== sessionId || entry.rootSessionId !== rootSessionId) continue;
      suppressed.delete(key);
      removed += 1;
    }
    return removed;
  }

  /** tab 记账 / Auto 预算 / 关闭租约所需的实例级 ref 容器。 */
  function useSidebarPanelAutoRefs(frame) {
    const {
      react, sessionId, sharedSidebarAutoCloseAttemptOwners, sharedSidebarAutoCloseAttempts, sharedSidebarAutoCloseCooldowns, sharedSidebarAutoCloseVerifications,
      sharedSidebarAutoOrigin, sharedSidebarAutoSuppressed, sharedSidebarAutoTabMisses,
    } = frame;

    /**
     * 子代理侧栏打开状态：复合键（sessionId + rootSessionId + 资源地址）→
     * { sessionId, rootSessionId, tabId, title, misses, origin }。
     *
     * 用 ref 而不是 state 的理由与 pendingSet 相同：一次渲染里可能同时存在多个已打开的子代理
     * （每个 root、每个资源地址各一条记录），状态必须按「哪个 root 的哪个地址」隔离，绝不使用
     * 单一全局 boolean——那会让两个子代理互相顶掉，也无法区分不同会话。重渲染统一走 bump。
     * misses 是该 tab 连续被观测到缺失的次数（见 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS）。
     * origin 是该 tab 的来源（auto | manual，见 SIDEBAR_TAB_ORIGIN_*）：只有 auto 来源才允许
     * 被自动同步关闭，manual 来源（用户手动打开、外部已存在的 tab）一律不碰。
     */
    const sidebarTabRecordsRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
     /**
      * 已发起但尚未从 active() 得到落地证据的打开动作：
      * key → { sessionId, rootSessionId, resourceAddress, expiresAt, origin }。
      *
      * DSH 的 openResource 可能先提交导航意图，下一次渲染才出现 active tab；这段窗口不能让第二次
      * 点击再次 openResource，也不能提前伪造 <<。observer/轮询读到匹配 active() 后才转成正式记录。
      */
     const sidebarTabOpeningRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
    /**
     * Auto（自动打开运行中的子代理侧栏）的来源与抑制账本，键与打开记录完全同构
     * （sidebar session + rootSessionId + 资源地址），因此不同会话/root 的状态互不影响。
     *
     * - 来源：Auto 本次运行亲手发出过打开动作的资源。它同时是「不要重复打开」的记账：
     *   命中即跳过（哪怕这次打开始终没有落地证据，也绝不再发第二次 openResource）；
     *   只有这个集合里的 key 才允许被自动关闭。
     * - 抑制：用户手动关闭过的资源。Auto 不得立刻重开它；用户手动重新打开同一资源时清除
     *   （手动意图始终优先）。
     * 两个集合都按当前快照与上限清理（见 syncAutoSidebarTabs 的清理阶段）。
     */
    // 这几个集合指向 createExpertGroupPanel 闭包里的共享账本：重挂载后的新实例靠它认领旧实例开出的
    // tab（见 sharedSidebarAutoOrigin 的说明）。ref 只是持有者，读写结构逐字不变。
    const sidebarAutoOriginRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoOrigin) : { current: sharedSidebarAutoOrigin };
    const sidebarAutoSuppressedRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoSuppressed) : { current: sharedSidebarAutoSuppressed };
    /** 自动关闭的重试记账：key → 已尝试次数（成功或资源重新变成运行中时清空）；跨重挂载保留。 */
    const sidebarAutoCloseAttemptsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseAttempts) : { current: sharedSidebarAutoCloseAttempts };
    /**
     * 自动关闭重试预算的所有者账本：key → 本次预支预算的不可复用令牌；与重试计数同层共享。
     *
     * 只有「当前 owner 就是自己出发时那一份令牌」的动作才允许回滚这次预支（见 releaseAutoCloseAttempt），
     * 因此旧代次在副作用之前被撤销时绝不可能删掉/覆盖新代次已经预支的预算。
     */
    const sidebarAutoCloseAttemptOwnersRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseAttemptOwners) : { current: sharedSidebarAutoCloseAttemptOwners };
    /** 关闭请求的验证记录（跨重挂载保留：验证由后续任意一次同步按精确 inventory 完成）。 */
    const sidebarAutoCloseVerificationsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseVerifications) : { current: sharedSidebarAutoCloseVerifications };
    /** 自动关闭失败冷却账本（跨重挂载保留：remount 绝不能绕过失败上限）。 */
    const sidebarAutoCloseCooldownsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseCooldowns) : { current: sharedSidebarAutoCloseCooldowns };
    /**
     * Auto 候选采样到的「这个 tab 连续不在场」计数（跨重挂载保留，见 sharedSidebarAutoTabMisses）。
     *
     * 与来源 / 抑制 / 预算同层共享：一次重挂载绝不能把「已经确认缺失一次」重置成「还没采样过」，
     * 否则同一条确认语义会被 remount 反复打断（那正是「单次缺失即收口」的另一种写法）。
     */
    const sidebarAutoTabMissesRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoTabMisses) : { current: sharedSidebarAutoTabMisses };
    /**
     * 自动打开的**预留**（reservation）：key → { sessionId, rootSessionId, address, epoch }。
     *
     * 与来源标记严格分离：预留只在候选选择的那一刻写入，用来挡住同一资源的重复动作；只有
     * openResource 真的成功发出、且宿主有可追踪能力时才升级成「Auto 亲手打开」的来源。
     * split busy、准备失败、layout 失效、open 抛错、root/sidebar session 变化等失败路径一律
     * 撤销预留（见 handleSidebarAction 的 finally）：否则一次失败会被永久记成「已经开过」，
     * 该资源在本次运行里再也打不开。
     */
    const sidebarAutoReservationRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
    /**
     * 自动动作的级联标记与失败屏障。
     *
     * 撤销预留之后，「下一次同步」会立刻重新选中同一个资源，而自动动作收尾时又会立刻跑一次
     * 尾随同步。若宿主的失败是**持续**的（本会话的 split 事务仍在途 ⇒ busy；宿主持续拒绝分栏；
     * openResource 持续抛错），「失败 → 撤销预留 → 立刻重选」这条链路会在微任务里自转：它永远
     * 不让出宏任务，宿主的提交证据也就永远不会被观察到，页面与预算一起被拖住。
     *
     * 因此：同一次级联（自动动作收尾引发的那条同步链）里失败过的 key 不再入选；失败仍然可重试，
     * 但下一次尝试一定发生在**外部同步轮**（2.5 秒轮询 / observer / 可见性变化 / 会话通知）里，
     * 那里才能观察到形成失败条件的宿主状态是否已经改变。
     */
    const sidebarAutoCascadeRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
    const sidebarAutoFailedKeysRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
    /**
     * Auto 动作代次：Auto 开关的权威值每次变化（含关闭）时递增。
     *
     * 在途自动动作在自己那一轮渲染的闭包里捕获取代次，并在每个 await 之后、真正调用宿主
     * openResource()/close() 之前复核：代次不符说明用户已经关掉（或重新打开）Auto，那次自动
     * 动作一律放弃——绝不把「已经关掉的 Auto」变成一次迟到的用户可见打开。
     */
    const sidebarAutoEpochRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
    /**
     * 用户手动意图记录：key → { sessionId, rootSessionId, address, intent }。
     *
     * 唯一目的：Auto 的动作正在同一个 key 上等待（split/layout/open）时，手动点击不能被 pending
     * 锁直接丢弃。意图只记录「用户要打开还是关闭」，由在途动作在副作用之前让位，或由同一条同步
     * 链路在它收尾后结算（见 applyPendingManualIntent）：手动关闭绝不被 Auto 随后重开，手动打开
     * 的最终 tab 一律记为 manual 来源。
     */
    const sidebarManualIntentRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
    /**
     * Auto 动作串行闸门。
     *
     * 自动同步可能同时看到多个候选（多个运行中的子代理），但同一 tick 里连发多个
     * split()/openResource() 会互相抢 pane（第二个动作看到的 pane 证据仍是第一帧之前的）。
     * 因此一次只放行一个动作，动作收尾后由同一条同步链路推进下一个候选。
     */
    const sidebarAutoBusyRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
    /** 最近一次同步观察到的 Auto 开关值；变化时 bump 一次（空闲轮询绝不重渲染）。 */
    const sidebarAutoSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /**
     * 当前首次 split 的用户意图；它跨越 split → openResource → openTabs/DOM 提交窗口，
     * 只能在目标 tab 已经落到返回的 pane 后才交给 install 侧结算。
     */
    const sidebarSplitIntentRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /** 侧栏箭头动作的同 key 在途集合（打开/关闭共用一把锁）：重复点击只允许一次动作穿过。 */
    const sidebarTabPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
    /**
     * 批量关闭动作的聚合锁，按 (sidebar session, root) 组合键隔离（主代理行 / 空闲分组标题行共用同一把）。
     *
     * 一次点击会顺序 await 多个 close(tabId)：整段序列在途期间必须拒绝第二次点击，否则双击会
     * 让同一个 tabId 被关闭两次（第二次必然抛错），也会让两次序列交错发出关闭请求。
     *
     * 锁键必须含 root + sidebar session，而不是一个组件级 boolean：宿主 close 返回的 Promise
     * 可能长时间不 settle，而用户完全可以在它挂起期间切换 root。单一 boolean 会让旧 root 的
     * 在途序列把**新 root** 的批量按钮一并置成 disabled —— 一次与它无关的切换被旧锁阻塞，
     * 且旧序列一旦永不 settle 就永久阻塞。集合里只保留仍在途的 scope，结算时精确删除自己那一项。
     */
    const sidebarBatchPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
    /**
     * 批量关闭锁的复合键：当前 sidebar session + 当前 root。
     *
     * 两者缺一不可：同一个 root 的 root/child surface 各有自己的右栏，不同 root 更是完全独立的
     * surface；只有完全相同的两者才共享同一把锁（同一 scope 内 running/idle 两个批量入口互斥）。
     */
    const sidebarBatchScopeKey = (sessionId, rootId) => String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(rootId);
    /**
     * 最近一次同步算出的「批量候选 tabId 签名」。
     *
     * 主代理行与空闲分组标题行的批量控件/零圆点由渲染期现读的 openTabs inventory 决定，
     * 因此 inventory 变化必须触发一次重渲染——但 2.5 秒轮询在没有变化时绝不能再 bump，
     * 否则空闲时会变成定时重渲染。这里只在签名真的变化时 bump（见 syncSidebarTabs）。
     */
    const sidebarBatchSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /**
     * 最近一次渲染的右栏 tab 同步器（每次渲染同步写入，写法与 refreshRef 一致）。
     *
     * 挂载 effect 只在 sessionId/rootSessionId 变化时重建，而 observer / 轮询 / 可见性回调必须在
     * 「最近一次渲染」的闭包里执行——那里的 rootSessionId 与 sidebarRight 才是当前的。
     * 因此回调只读这个引用，绝不长期持有某一轮渲染的旧闭包。
     */
    const sidebarTabSyncRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };

    Object.assign(frame, {
      sidebarAutoBusyRef, sidebarAutoCascadeRef, sidebarAutoCloseAttemptOwnersRef, sidebarAutoCloseAttemptsRef, sidebarAutoCloseCooldownsRef, sidebarAutoCloseVerificationsRef,
      sidebarAutoEpochRef, sidebarAutoFailedKeysRef, sidebarAutoOriginRef, sidebarAutoReservationRef, sidebarAutoSignatureRef, sidebarAutoSuppressedRef,
      sidebarAutoTabMissesRef, sidebarBatchPendingRef, sidebarBatchScopeKey, sidebarBatchSignatureRef, sidebarManualIntentRef, sidebarSplitIntentRef,
      sidebarTabOpeningRef, sidebarTabPendingRef, sidebarTabRecordsRef, sidebarTabSyncRef,
    });
  }

  /** tab 渲染期原语：中性运行状态与快照同步 ref。 */
  function useSidebarPanelTabPrimitives(frame) {
    const {
      model, react, rootSessionId, sidebarSessionId, snapshot,
    } = frame;

    /**
     * 容器（空闲分组）在轻量快照下使用的中性运行状态：取值与模型导出的
     * UNKNOWN_RUNTIME_STATUS 同源，模型缺失时按同名字面量兜底，避免两处各存一份词表。
     */
    const neutralRuntimeStatus = typeof model.UNKNOWN_RUNTIME_STATUS === "string" && model.UNKNOWN_RUNTIME_STATUS.length > 0
      ? model.UNKNOWN_RUNTIME_STATUS
      : "unknown";
     const sidebarSnapshotSyncRef = typeof react.useRef === "function"
       ? react.useRef({ rootSessionId, sidebarSessionId, snapshot })
       : { current: { rootSessionId, sidebarSessionId, snapshot } };

    Object.assign(frame, {
      neutralRuntimeStatus, sidebarSnapshotSyncRef,
    });
  }

  /** tab / 分栏 / Auto 账本的与本文件内视图函数之间的接线层。 */
  function useSidebarPanelTabWiring(frame) {
    const {
      bump, catalogEntryOf, model, navigation, readActiveSidebarResource, refresh,
      rootSessionId, sessionsService, setState, sidebarRight, store,
    } = frame;

    /**
     * 标题栏的**手动刷新 / 重试**入口（票据 13：常驻刷新按钮）。
     *
     * 与自动轮询的区别只有一处：手动刷新是用户的显式推进，因此它先清掉当前 surface 的
     * **所有**错误（含只允许由动作或手动操作清除的 action 错误），再发起刷新——用户点了刷新
     * 却还看到上一条错误，会以为这次点击没有生效；同时它带 manual 标记，让内容完全一致时
     * 也提交一次新的「更新于」时间（自动轮询绝不会这样）。
     */
    const retry = () => {
      setState((previous) => (previous.rootSessionId === rootSessionId && previous.error !== null
        ? { ...previous, error: null }
        : previous));
      void refresh({ manual: true });
    };
    const expand = (node) => store ? store.isExpanded(node) : (node?.kind === "root" || (typeof model.defaultExpanded === "function" && model.defaultExpanded(node)));
    const toggle = (node) => {
      if (store) store.toggle(node);
      bump((value) => value + 1);
    };
    /**
     * 打开会话的主视图导航（唯一入口：工作区服务的 `uiWorkspace.openSession`）。
     *
     * 已知子代理优先传 SubagentAddress（宿主据此恢复直系父与续跑能力，与 DSH 原生子代理行的
     * openChild 语义一致），地址缺失时传裸 session id。工作区入口不存在时这里不会被调用：
     * 渲染层在 `navigation.available !== true` 时不生成任何可点击的导航入口，绝不显示
     * 点了没反应的按钮。
     */
    const handleOpen = (id, address) => {
      if (navigation.available !== true) return;
      if (typeof id !== "string" || id.length === 0) return;
      navigation.open(address === null || address === undefined || navigation.acceptsAddress !== true ? id : address);
    };

    /**
     * 子代理地址解析（渲染层唯一的地址来源，主视图导航与侧栏箭头共用）。
     *
     * 1. `sessions.subagentAddress(childId)`：DSH 维护的「直系父会话 + 模式」权威地址，
     *    存在即优先使用；
     * 2. 会话投影目录项的合法 mode：目录已 hydration 时沿用 DSH 目录证据（含新增的
     *    `unknown`）。`unknown` 是合法地址值，但**不可续接**：它绝不被降级成
     *    continuable，宿主据此按只读呈现；
     * 3. 目录尚未 hydration 时，DEG Host 快照节点的 `continuable: true` 是本插件自身的
     *    明确证据，可与树遍历提供的 parentId 组成 continuable 地址。`false` 不映射为
     *    one-shot，避免把缺失/未知模式误当成合法地址；目录已有显式 mode（含 unknown）时
     *    保持该权威值，不被节点回退覆盖。
     * 4. 都拿不到时返回 null：主视图仍传裸 id，但绝不构造侧栏地址（避免打不开的地址）。
     */
    const subagentAddressOfChild = (childId, parentId, node) => {
      const id = text(childId, null);
      if (id === null) return null;
      const lookup = methodOf(sessionsService, "subagentAddress");
      if (lookup !== null) {
        let addressed;
        try { addressed = lookup.call(sessionsService, id); } catch { addressed = null; }
        const normalized = normalizeSubagentAddress(addressed);
        if (normalized !== null) return normalized;
        // undefined/null 表示地址尚未被 DSH 发现，允许继续走 Host 快照兜底；
        // 宿主若已经返回了非空但非法对象，则保守拒绝，不能用较弱证据覆盖坏地址。
        if (addressed !== undefined && addressed !== null) return null;
      }
      const parent = text(parentId, null);
      const entry = catalogEntryOf(parent, id);
      const entrySource = object(entry);
      const entryHasMode = Object.prototype.hasOwnProperty.call(entrySource, "mode");
      const entryMode = text(entrySource.mode, null);
      // DSH 目录懒加载时 entry 可能暂时不存在，或投影项尚未带 mode 字段；DEG 的 Host
      // 快照已明确证明其 child 是 continuable，此证据足以构造同一规范地址。只对 true 回退，
      // false 仍表示未知；若目录显式带了 mode（含 unknown 或非法值），则保留目录权威值，
      // 绝不用较弱证据把它说成可续接。
      const mode = entryHasMode
        ? entryMode
        : (object(node).continuable === true ? "continuable" : null);
      return normalizeSubagentAddress({
        parentSessionId: parent,
        childSessionId: id,
        mode,
      });
    };

    /**
     * 标题后「在右侧栏打开」箭头按钮：与 DSH 原生子代理行同款（IconChevronRightOutlineRegular）。
     *
     * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名箭头图标可用。
     * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
     *
     * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
     * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
     * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
     * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
     * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
     * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
     * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
     * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
     * 必须同时存在：鼠标事件不得冒泡到任务名的导航处理器，键盘 Enter/Space 在按钮上的
     * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
     * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
     */
    /**
     * 当前 active tab 的 id（读面缺失、读取或调用抛错、没有 tab 时一律返回 null）。
     *
     * 只用于「正向存在证据」：active() 返回的目标 tabId 说明宿主的存储里这个 tab 还在。
     * 反过来不成立——active() 返回别的 tab 只说明用户切到了别的 tab/pane，绝不能当作
     * 「目标 tab 没了」的证据去复位或关闭。
     */
    const activeSidebarTabId = () => {
      if (readActiveSidebarResource === null) return null;
      try { return text(object(readActiveSidebarResource.call(sidebarRight)).id, null); } catch { return null; }
    };

    Object.assign(frame, {
      activeSidebarTabId, expand, handleOpen, retry, subagentAddressOfChild, toggle,
    });
  }

  /** undefined */
  function useSidebarPanelTabWiringPart2(frame) {
    const {
      cancelSidebarSplit, closeSidebarResource, config, neutralRuntimeStatus, partialSnapshot, readActiveSidebarResource,
      readSidebarOpenTabs, rootSessionId, sidebarAutoCloseAttemptOwnersRef, sidebarAutoCloseAttemptsRef, sidebarAutoCloseCooldownsRef, sidebarAutoTabMissesRef,
      sidebarManualIntentRef, sidebarRight, sidebarSessionId, sidebarSplitIntentRef, sidebarTabOpeningRef, snapshot,
      subagentAddressOfChild,
    } = frame;
    // 跨 Hook 前向引用的晚绑定包装：这些函数由后续 Hook 声明并登记到 frame.late；
    // 本 Hook 里的调用全部发生在渲染之后的异步 / 事件路径，因此转发保持原来的调用时机与顺序。
    const runtimeStatusOfNode = (...args) => frame.late.runtimeStatusOfNode(...args);
    const sidebarAutoCloseKeyIsActive = (...args) => frame.late.sidebarAutoCloseKeyIsActive(...args);

    /**
     * tab 记账的检查点（R6 票据 22）：资源地址推导、inventory 判定、批量候选与自动关闭预算转移
     * 的唯一实现都在 client-sidebar-tab-state.js。这里只提供**本帧的**依赖（快照 / surface 身份 /
     * 容器）+ 与拆分前同名的适配层，调用点一行未改。
     *
     * 生命周期边界：
     * - 容器身份仍归各自 owner（实例级 ref / realm 级共享账本），本层每次现取 ref.current；
     * - 依赖对象 treeDeps / autoCloseLedger 每帧重建，绝不跨帧复用（旧实现的判据都是闭包值）。
     */
    const tabTreeDeps = () => ({
      addressOf: subagentAddressOfChild,
      statusOf: runtimeStatusOfNode,
      partial: partialSnapshot,
      neutralStatus: neutralRuntimeStatus,
    });
    /** 自动关闭预算的四个容器 + 上限：成员 Map 的身份来自主体（实例 ref / 共享账本），本层不 new。 */
    const autoCloseLedger = () => ({
      closeAttempts: sidebarAutoCloseAttemptsRef.current,
      owners: sidebarAutoCloseAttemptOwnersRef.current,
      closeCooldowns: sidebarAutoCloseCooldownsRef.current,
      tabMisses: sidebarAutoTabMissesRef.current,
      limit: SIDEBAR_AUTO_KEY_LIMIT,
    });
    const presentFloatingSubagentTitles = () => TAB_STATE.presentFloatingSubagentTitles(globalThis.document);
    const knownSidebarResourceAddresses = () => TAB_STATE.knownSidebarResourceAddresses(
      snapshot,
      rootSessionId,
      subagentAddressOfChild,
    );
    const sidebarExpertResourceAddresses = (node, parentId, addresses) => TAB_STATE.sidebarExpertResourceAddresses(
      node,
      parentId,
      addresses,
      tabTreeDeps(),
    );
    const sidebarNodeIsIdleReady = (node, parentId, childId) => TAB_STATE.sidebarNodeIsIdleReady(
      node,
      parentId,
      childId,
      tabTreeDeps(),
    );
    const sidebarNodeIsIdleMembership = (node, parentId, childId) => TAB_STATE.sidebarNodeIsIdleMembership(
      node,
      parentId,
      childId,
      tabTreeDeps(),
    );
    const sidebarIdleChildren = () => TAB_STATE.sidebarIdleChildren(sidebarRootChildren(), rootSessionId, tabTreeDeps());
    const runningSidebarResourceAddresses = () => TAB_STATE.runningSidebarResourceAddresses(
      sidebarRootChildren(),
      rootSessionId,
      tabTreeDeps(),
    );
    const idleSidebarResourceAddresses = (nodes) => TAB_STATE.idleSidebarResourceAddresses(
      nodes,
      rootSessionId,
      tabTreeDeps(),
    );
    const sidebarBatchCandidates = (addresses, inventory) => TAB_STATE.sidebarBatchCandidates(
      addresses,
      inventory,
      sidebarSessionId,
    );
    const sidebarBatchStateFor = (addresses) => TAB_STATE.sidebarBatchStateFor(addresses, {
      inventory: readSidebarOpenTabs(),
      sidebarSessionId,
      closeAvailable: closeSidebarResource !== null,
    });
    const sidebarBatchSignatureOf = TAB_STATE.sidebarBatchSignatureOf;
    const sidebarResourceTabStateOf = (resourceAddress) => TAB_STATE.sidebarResourceTabStateOf(
      readSidebarOpenTabs(),
      sidebarSessionId,
      resourceAddress,
    );
    const sidebarAdoptionEvidenceAvailable = (resourceAddress) => TAB_STATE.sidebarAdoptionEvidenceAvailable(
      readSidebarOpenTabs(),
      sidebarSessionId,
      resourceAddress,
    );
    /**
     * active() 是否已经是这个资源：读面解析留在本层（它属于宿主服务注入面），
     * 判定本身（kind + contentId）归 tab-state，绝不在此复制第二份判据。
     */
    const sidebarActiveResourceMatches = (resourceAddress) => {
      if (readActiveSidebarResource === null) return false;
      let tab = null;
      try { tab = object(readActiveSidebarResource.call(sidebarRight)); } catch { return false; }
      return TAB_STATE.sidebarActiveResourceMatches(tab, resourceAddress);
    };
    /** 当前 surface 自己的手动意图记录；别的 session/root 的键在当前闭包里一律不可见。 */
    const sidebarManualIntentOf = (key) => TAB_STATE.sidebarManualIntentOf(
      sidebarManualIntentRef.current,
      key,
      sidebarSessionId,
      rootSessionId,
    );
    const trimAutoKeyMap = (map, activeAware) => TAB_STATE.trimAutoKeyMap(map, {
      limit: SIDEBAR_AUTO_KEY_LIMIT,
      activeAware,
      isActive: sidebarAutoCloseKeyIsActive,
    });
    const clearAutoCloseAttempt = (key) => TAB_STATE.clearAutoCloseAttempt(autoCloseLedger(), key);
    const clearAutoCloseBudget = (key) => TAB_STATE.clearAutoCloseBudget(autoCloseLedger(), key);
    const enterAutoCloseCooldown = (key) => TAB_STATE.enterAutoCloseCooldown(
      autoCloseLedger(),
      key,
      sidebarAutoCloseKeyIsActive,
    );
    const autoCloseCooldownActive = (key) => TAB_STATE.autoCloseCooldownActive(autoCloseLedger(), key);
    const releaseExpiredAutoCloseCooldown = (key) => TAB_STATE.releaseExpiredAutoCloseCooldown(autoCloseLedger(), key);
    const autoTabMissesOf = (key, tabId) => TAB_STATE.autoTabMissesOf(autoCloseLedger(), key, tabId);
    const sampleAutoTabMisses = (key, tabId, missing) => TAB_STATE.sampleAutoTabMisses(
      autoCloseLedger(),
      key,
      { sidebarSessionId, rootSessionId, tabId, missing },
    );
    const settleAutoCloseAttempt = (key, context) => TAB_STATE.settleAutoCloseAttempt(autoCloseLedger(), key, context);
    /** 当前快照的 root 直接子节点（快照缺失时为空数组）。 */
    const sidebarRootChildren = () => (Array.isArray(snapshot?.root?.children) ? snapshot.root.children : []);

    /**
     * 子代理页必须先通过公开 split() 获得独立 paneId，再由 openResource 显式定位；split() 明确
     * 失败时不打开资源，避免回落到 Expert Group pane。旧宿主没有 split() 时保留 preferNewPane
     * 兼容路径。这里不调用 float，因为 float 的用户可见结果是独立窗口。
     */

    /**
     * 清理当前 split 事务；失败时由 install 侧按实际 pane 组成决定是否恢复 20%。
     *
     * 同一个 key 的「在途打开记录」与 split 意图属于同一次点击：事务一旦收口，那次打开就不该
     * 再被后续同步当成「还没确认的打开」而重建关闭记录（用户明明已经收回了这个 tab）。因此这里
     * 一并删除该 key 的 opening 记录；意图缺失时它是一次幂等空操作。
     */
    const cancelPendingSidebarSplit = (reason, expectedIntentToken) => {
      const intent = sidebarSplitIntentRef.current;
      if (intent === null) return;
      /**
       * 可选的令牌闸门：显式传入令牌的调用方（关闭收口）必须与当前意图的**不可复用令牌**逐对象
       * 相等才允许取消；不传令牌的调用方（卸载、超时、动作被撤销、打开失败）保持既有语义——它们
       * 手里的意图就是它们此刻正在处理的那一份。null 是**有效**的期望值：它只可能来自「出发时根本
       * 没有意图」，此刻槽位里的任何意图都必然是后来者，一律不取消。
       */
      if (expectedIntentToken !== undefined && intent.token !== expectedIntentToken) return;
      sidebarSplitIntentRef.current = null;
      // 意图里带着 key，收口范围因此精确到这一次点击，绝不误伤别的行的在途记录。
      sidebarTabOpeningRef.current.delete(intent.key);
      if (cancelSidebarSplit === null) return;
      try { cancelSidebarSplit.call(config, intent.token, { reason }); } catch { /* 收口失败不能阻断面板同步。 */ }
    };
    /**
     * 关闭收口专用的 split 事务取消：只有当前意图**仍然是这次关闭出发时看到的那一份**才允许取消。
     *
     * 特征判据必须是比较意图的**不可复用令牌**（每次 beginSidebarSplit 新建的对象身份），而不是
     * 只比 key：split 意图槽位在一个实例里只有一份，同一个 key 上的新一次打开会把它整份替换掉，
     * 旧 close 的迟到收口（尤其 verified-recycled）若按 key 取消，取消的就是新 generation 的
     * split/open 事务——右栏从临时 50% 掉回、新 pane 的打开失去归属，而那次打开与这次关闭毫无关系。
     *
     * 令牌为 null（出发时根本没有意图）时一律不取消：它只可能属于后来者。
     */
    const cancelPendingSidebarSplitOfClose = (key, splitIntentToken) => {
      const intent = sidebarSplitIntentRef.current;
      if (intent === null || intent.key !== key) return;
      if (splitIntentToken === null || splitIntentToken === undefined) return;
      if (intent.token !== splitIntentToken) return;
      cancelPendingSidebarSplit("close", splitIntentToken);
    };

    Object.assign(frame, {
      autoCloseCooldownActive, autoTabMissesOf, cancelPendingSidebarSplit, cancelPendingSidebarSplitOfClose, clearAutoCloseAttempt,
      clearAutoCloseBudget, enterAutoCloseCooldown, idleSidebarResourceAddresses, knownSidebarResourceAddresses, presentFloatingSubagentTitles, releaseExpiredAutoCloseCooldown,
      runningSidebarResourceAddresses, sampleAutoTabMisses, settleAutoCloseAttempt, sidebarActiveResourceMatches, sidebarAdoptionEvidenceAvailable, sidebarBatchCandidates,
      sidebarBatchSignatureOf, sidebarBatchStateFor, sidebarExpertResourceAddresses, sidebarIdleChildren, sidebarManualIntentOf, sidebarNodeIsIdleMembership,
      sidebarNodeIsIdleReady, sidebarResourceTabStateOf, trimAutoKeyMap,
    });
  }

  /** undefined */
  function useSidebarPanelTabWiringPart3(frame) {
    const {
      commitSidebarSplit, config, sidebarSplitIntentRef, sidebarSplitTargetEvidence,
    } = frame;

    /**
     * 只有 inventory 与 DOM 同时证明目标资源位于本次返回的 pane，才结束临时扩栏事务。
     * 该检查复用已有 observer、可见性回调和轮询，不另挂长期 observer。
     */
    const tryCommitSidebarSplit = () => {
      const intent = sidebarSplitIntentRef.current;
      if (intent === null || intent.resourceIssued !== true || commitSidebarSplit === null) return;
      const evidence = sidebarSplitTargetEvidence(intent.resourceAddress, intent.paneId);
      if (evidence === null) return;
      try {
        if (commitSidebarSplit.call(config, intent.token, evidence) === true) {
          sidebarSplitIntentRef.current = null;
        }
      } catch {
        // 宿主提交窗口仍可能在下一次 observer/轮询中完成，保留事务继续等待。
      }
    };

    /**
     * 第一阶段：既有「右栏 tab 记录/库存同步」（外部关闭观察、在途打开结算、批量签名更新）。
     *
     * 它保留了原有的提前 return（records 为空时不做任何 DOM 查询）；自动同步因此被拆到
     * 独立的第二阶段（syncSidebarTabs），那些短路不会再吞掉自动打开/关闭。
     */

    Object.assign(frame, {
      tryCommitSidebarSplit,
    });
  }

  /** 右栏 tab 打开记录的外部同步（收养 / 回收 / 预算推进）。 */
  function useSidebarPanelTabSync(frame) {
    const {
      activeSidebarTabId, bump, cancelPendingSidebarSplit, idleSidebarResourceAddresses, knownSidebarResourceAddresses, presentFloatingSubagentTitles,
      presentSidebarTabIds, requestRightbarDragSync, rootSessionId, runningSidebarResourceAddresses, sidebarAdoptionEvidenceAvailable, sidebarBatchSignatureOf,
      sidebarBatchSignatureRef, sidebarBatchStateFor, sidebarIdleChildren, sidebarManualIntentRef, sidebarSessionId, sidebarSplitIntentRef,
      sidebarTabOpeningRef, sidebarTabRecordsRef, tryCommitSidebarSplit,
    } = frame;
    // 跨 Hook 前向引用的晚绑定包装：这些函数由后续 Hook 声明并登记到 frame.late；
    // 本 Hook 里的调用全部发生在渲染之后的异步 / 事件路径，因此转发保持原来的调用时机与顺序。
    const applyPendingManualIntent = (...args) => frame.late.applyPendingManualIntent(...args);
    const recordSidebarTab = (...args) => frame.late.recordSidebarTab(...args);

    const syncSidebarTabRecords = () => {
      // 右栏拖拽手柄锁复用这条既有生命周期（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）：
      // 活跃 tab 一变就重估，绝不为它单独再挂一个长期 observer。请求失败只影响这一次重估。
      try { requestRightbarDragSync?.(); } catch { /* 手柄锁只是体验优化，绝不影响面板。 */ }
      /**
       * 标题行批量控件/零圆点由渲染期现读的 openTabs inventory 决定，因此这里必须在**任何提前 return
       * 之前**比较一次候选签名：records 为空时旧实现会直接返回，inventory 变化就再也不会被反映，
       * 用户手动打开的 tab（没有本插件的打开记录）也会永远看不到可关闭的批量按钮。
       *
       * 只有签名真的变化才 bump：2.5 秒轮询在没有变化时绝不产生重渲染。
       */
      const batchSignatureNow = sidebarBatchSignatureOf(
        sidebarBatchStateFor(runningSidebarResourceAddresses()),
        sidebarBatchStateFor(idleSidebarResourceAddresses(sidebarIdleChildren())),
      );
      if (sidebarBatchSignatureRef.current !== batchSignatureNow) {
        sidebarBatchSignatureRef.current = batchSignatureNow;
        bump((value) => value + 1);
      }
      const records = sidebarTabRecordsRef.current;
      const openings = sidebarTabOpeningRef.current;
       const now = Date.now();
                 const openingResolved = [];
        /**
         * 初始收养的判据是「当前（sidebar session + root）还没有任何打开记录」，而不是全局
         * records.size：同一个 Panel 实例会按新的 props.scope 切换到另一个 root，前一个 root
         * 遗留的记录绝不能让当前 root 跳过这一步——否则宿主里已经存在的 tab 永远收不到记录，
         * Auto 也就再也认不出自己打开过的 tab（箭头停在 >>，资源结束后也不会自动关闭）。
         *
         * 记录键始终是（sidebar session + root + 地址）复合键，因此按 scope 收养不会覆盖或
         * 误伤别的 root 的记录。tabId 一律当场从当前 openTabs inventory 现读（见 recordSidebarTab），
         * 绝不跨重挂载缓存 tabId：宿主的 tabId 只由它自己那份 inventory 证明。
         */
        let scopedRecordExists = false;
        for (const record of records.values()) {
          if (record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId) {
            scopedRecordExists = true;
            break;
          }
        }
        if (scopedRecordExists !== true) {
          for (const resourceAddress of knownSidebarResourceAddresses()) {
            if (sidebarAdoptionEvidenceAvailable(resourceAddress) !== true) continue;
            const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
            if (recordSidebarTab(key, resourceAddress)) openings.delete(key);
          }
        }
       for (const [key, opening] of openings) {
         if (now >= opening.expiresAt) {
           if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("timeout");
           openingResolved.push(key);
           continue;
         }
         if (opening.sessionId !== sidebarSessionId || opening.rootSessionId !== rootSessionId) continue;
         if (recordSidebarTab(key, opening.resourceAddress)) openingResolved.push(key);
       }
       for (const key of openingResolved) {
         openings.delete(key);
       }
       // 先完成精确 split 提交，再执行关闭同步；guide-only 或错误 pane 仍继续等待。
       tryCommitSidebarSplit();
       /**
        * 手动意图的兜底结算扫描（在任何提前 return 之前）：
        * 在途动作收尾、打开记录落地或超时都可能让一个意图变成可结算状态。数量级等于用户点击次数，
        * 因此每轮扫描的成本可以忽略；仍然在途的意图由 applyPendingManualIntent 自己跳过。
        * 别的 session/root 的条目在这里永远结算不了（它属于那个 surface 自己的闭包），直接删除，
        * 保证面板跨 root 复用时不泄漏手动意图。
        */
       for (const key of [...sidebarManualIntentRef.current.keys()]) {
         const entry = sidebarManualIntentRef.current.get(key);
         if (entry === undefined) continue;
         if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) {
           sidebarManualIntentRef.current.delete(key);
           continue;
         }
         applyPendingManualIntent(key);
       }
       // 先完成打开记录，再执行关闭同步；同 pane 回落不再被转换成独立浮窗。
       // 这里保留「没有打开记录就直接返回」的既有短路（它保证空闲时不会发生任何 DOM 查询）；
       // 批量控件的聚合状态更新已经在**这个短路之前**完成，因此 records 为空时 inventory 的变化
       // 照旧能被反映，而用户手动打开的 tab 也不再依赖本插件的打开记录。
       if (records.size === 0) return;
      const present = presentSidebarTabIds();
      if (present === null) return;
      const floatingTitles = presentFloatingSubagentTitles();
       if (floatingTitles === null) return;
       const activeTabId = activeSidebarTabId();
      const stale = [];
      for (const [key, record] of records) {
        if (record.sessionId !== sidebarSessionId || record.rootSessionId !== rootSessionId) continue;
        if (present.has(record.tabId) === true
           || record.tabId === activeTabId
           || (text(record.title, null) !== null && floatingTitles.has(record.title))) {
          record.misses = 0;
          continue;
        }
        record.misses += 1;
        if (record.misses >= SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS) stale.push(key);
      }
      if (stale.length === 0) return;
      for (const key of stale) {
        // 外部关闭同步只维护「这个 tab 还在不在」的记录：宽度不再随 tab 开关变化。
        records.delete(key);
      }
      bump((value) => value + 1);
    };

    Object.assign(frame, {
      syncSidebarTabRecords,
    });
  }

  /** Auto / 手动动作面的惰性注入与命令转发（每帧一个实例）。 */
  function useSidebarPanelAutoOrchestration(frame) {
    const {
      autoCloseCooldownActive, autoOpenEnabled, bump, cancelPendingSidebarSplit, cancelPendingSidebarSplitOfClose, clearAutoCloseAttempt,
      clearAutoCloseBudget, closeSidebarResource, currentRootRef, currentSidebarSessionRef, enterAutoCloseCooldown, idleSidebarResourceAddresses,
      knownSidebarResourceAddresses, mountedRef, openSidebarResource, primitives, readActiveSidebarResource, readSidebarOpenTabs,
      releaseExpiredAutoCloseCooldown, rootSessionId, runningSidebarResourceAddresses, sampleAutoTabMisses, setAutoOpenDraft, settleAutoCloseAttempt,
      sharedSidebarTabCloseInFlight, sidebarActiveResourceMatches, sidebarAutoBusyRef, sidebarAutoCascadeRef, sidebarAutoCloseAttemptOwnersRef, sidebarAutoCloseAttemptsRef,
      sidebarAutoCloseCooldownsRef, sidebarAutoCloseVerificationsRef, sidebarAutoEpochRef, sidebarAutoFailedKeysRef, sidebarAutoOriginRef, sidebarAutoReservationRef,
      sidebarAutoSignatureRef, sidebarAutoSuppressedRef, sidebarIdleChildren, sidebarManualIntentOf, sidebarManualIntentRef, sidebarOpenTabsAvailable,
      sidebarResourceTabStateOf, sidebarRight, sidebarSessionId, sidebarSplitIntentRef, sidebarSurfaceStillCurrent, sidebarTabOpeningRef,
      sidebarTabPendingRef, sidebarTabRecordsRef, sidebarTabSyncRef, snapshot, syncSidebarTabRecords, trimAutoKeyMap,
    } = frame;
    // 跨 Hook 前向引用的晚绑定包装：这些函数由后续 Hook 声明并登记到 frame.late；
    // 本 Hook 里的调用全部发生在渲染之后的异步 / 事件路径，因此转发保持原来的调用时机与顺序。
    const cleanupAutoSidebarKeys = (...args) => frame.late.cleanupAutoSidebarKeys(...args);
    const clearManualSuppressionOfIdleResources = (...args) => frame.late.clearManualSuppressionOfIdleResources(...args);
    const handleSidebarAction = (...args) => frame.late.handleSidebarAction(...args);
    const sweepAutoOpenPlaceholders = (...args) => frame.late.sweepAutoOpenPlaceholders(...args);

    /**
     * 本帧自动 / 手动动作的注入面（R6 票据 24）。
     *
     * 每个 key 都是本闭包本来就有的**同名**标识符：ref 容器、每帧的 session / root、宿主注入的
     * 读写面与窄命令。判定与写入全部在 client-sidebar-auto-controller.js / client-sidebar-actions.js；
     * 这里**只**做注入，不含任何业务分支，也不推进任何 Hook。
     *
     * 惰性构建：首次调用动作时才求值（此时 Panel 体内所有 const 都已初始化），同一帧内复用；
     * 下一帧重建——绝不把某一帧的 session / root / snapshot 留到下一帧（与拆分前的闭包判据等价）。
     */
    let sidebarAutoFrameCache = null;
    const sidebarAutoFrame = () => {
      if (sidebarAutoFrameCache === null) {
        sidebarAutoFrameCache = {
          autoCloseCandidate,
          autoCloseCooldownActive,
          autoOpenCandidate,
          autoOpenEnabled,
          bump,
          cancelPendingSidebarSplit,
          cancelPendingSidebarSplitOfClose,
          cleanupAutoSidebarKeys,
          clearAutoCloseAttempt,
          clearAutoCloseBudget,
          clearManualSuppressionOfIdleResources,
          closeSidebarResource,
          currentRootRef,
          currentSidebarSessionRef,
          enterAutoCloseCooldown,
          handleSidebarAction,
          idleSidebarResourceAddresses,
          knownSidebarResourceAddresses,
          mountedRef,
          openSidebarResource,
          primitives,
          readActiveSidebarResource,
          readSidebarOpenTabs,
          releaseExpiredAutoCloseCooldown,
          rootSessionId,
          runningSidebarResourceAddresses,
          sampleAutoTabMisses,
          setAutoOpenDraft,
          settleAutoCloseAttempt,
          sharedSidebarTabCloseInFlight,
          sidebarActiveResourceMatches,
          sidebarAutoBusyRef,
          sidebarAutoCascadeRef,
          sidebarAutoCloseAttemptOwnersRef,
          sidebarAutoCloseAttemptsRef,
          sidebarAutoCloseCooldownsRef,
          sidebarAutoCloseVerificationsRef,
          sidebarAutoEpochRef,
          sidebarAutoFailedKeysRef,
          sidebarAutoOriginRef,
          sidebarAutoReservationRef,
          sidebarAutoSignatureRef,
          sidebarAutoSuppressedRef,
          sidebarIdleChildren,
          sidebarManualIntentOf,
          sidebarManualIntentRef,
          sidebarOpenTabsAvailable,
          sidebarResourceTabStateOf,
          sidebarRight,
          sidebarSessionId,
          sidebarSplitIntentRef,
          sidebarSurfaceStillCurrent,
          sidebarTabOpeningRef,
          sidebarTabPendingRef,
          sidebarTabRecordsRef,
          sidebarTabSyncRef,
          snapshot,
          sweepAutoOpenPlaceholders,
          syncSidebarTabRecords,
          trimAutoKeyMap,
          verifyPendingSidebarCloses,
        };
      }
      return sidebarAutoFrameCache;
    };
    /** 自动打开 / 预算 / 关闭租约的判定面（每帧一个实例，兄弟函数之间的调用不再绕回本层）。 */
    let sidebarAutoControllerCache = null;
    const autoController = () => {
      if (sidebarAutoControllerCache === null) {
        sidebarAutoControllerCache = AUTO_CONTROLLER.createSidebarAutoController(sidebarAutoFrame());
      }
      return sidebarAutoControllerCache;
    };
    /** 手动开关与副作用复核的判定面（同上：每帧一个实例）。 */
    let sidebarActionsCache = null;
    const sidebarActions = () => {
      if (sidebarActionsCache === null) {
        sidebarActionsCache = SIDEBAR_ACTIONS.createSidebarActions(sidebarAutoFrame());
      }
      return sidebarActionsCache;
    };

    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 sidebarAutoOpenCapable()：本层只注入本帧作用面，不含任何判据。
     */
    const sidebarAutoOpenCapable = () => autoController().sidebarAutoOpenCapable();

    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 autoCloseCandidate()：本层只注入本帧作用面，不含任何判据。
     */
    const autoCloseCandidate = (running) => autoController().autoCloseCandidate(running);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 autoOpenCandidate()：本层只注入本帧作用面，不含任何判据。
     */
    const autoOpenCandidate = (running) => autoController().autoOpenCandidate(running);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 sidebarAutoCloseKeyIsActive()：本层只注入本帧作用面，不含任何判据。
     */
    const sidebarAutoCloseKeyIsActive = (key) => autoController().sidebarAutoCloseKeyIsActive(key);
    /** 清空一个 key 的失败冷却与重试预算（verified-closed / 手动接管 / 资源重新运行共用）。 */
    /** 进入冷却慢车道：60 秒起指数退避、上限 15 分钟；origin / record 一律保留。 */
    /** 冷却是否仍在生效：生效期内同一个 key 零次 close 请求。 */
    /** 冷却到期：清空快速预算，让这个 key 重新进入快速车道（失败后由 enterAutoCloseCooldown 退避到下一档）。 */
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 autoSidebarOwnershipHasCapacity()：本层只注入本帧作用面，不含任何判据。
     */
    const autoSidebarOwnershipHasCapacity = (key, address) => autoController().autoSidebarOwnershipHasCapacity(key, address);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 sidebarTabCloseInFlight()：本层只注入本帧作用面，不含任何判据。
     */
    const sidebarTabCloseInFlight = (tabId) => autoController().sidebarTabCloseInFlight(tabId);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 acquireSidebarTabClose()：本层只注入本帧作用面，不含任何判据。
     */
    const acquireSidebarTabClose = (tabId) => autoController().acquireSidebarTabClose(tabId);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 sidebarTabPresenceInInventory()：本层只注入本帧作用面，不含任何判据。
     */
    const sidebarTabPresenceInInventory = (tabId, expectedAddress = null) => autoController().sidebarTabPresenceInInventory(tabId, expectedAddress);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 requestSidebarTabClose()：本层只注入本帧作用面，不含任何判据。
     */
    const requestSidebarTabClose = (tabId) => autoController().requestSidebarTabClose(tabId);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 waitForSidebarCloseLease()：本层只注入本帧作用面，不含任何判据。
     */
    const waitForSidebarCloseLease = (leaseToken, timeoutMs) => autoController().waitForSidebarCloseLease(leaseToken, timeoutMs);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 beginSidebarCloseVerification()：本层只注入本帧作用面，不含任何判据。
     */
    const beginSidebarCloseVerification = (lease, tabId, verify) => autoController().beginSidebarCloseVerification(lease, tabId, verify);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 finishVerifiedSidebarClose()：本层只注入本帧作用面，不含任何判据。
     */
    const finishVerifiedSidebarClose = (key, entry, reason) => autoController().finishVerifiedSidebarClose(key, entry, reason);

    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 verifyPendingSidebarCloses()：本层只注入本帧作用面，不含任何判据。
     */
    const verifyPendingSidebarCloses = () => autoController().verifyPendingSidebarCloses();

    // 登记给更早 Hook 的晚绑定包装（声明已完成，此后的调用都拿到本帧的实例）。
    // 内存抑制清除也走晚绑定：归属账本清的是持久层，这张表是同一页面生命周期内的第二层抑制。
    frame.late.clearSidebarAutoSuppressionsOfScope = () => clearAutoSuppressionsOfScope(sidebarAutoSuppressedRef.current, sidebarSessionId, rootSessionId);
    frame.late.sidebarAutoCloseKeyIsActive = sidebarAutoCloseKeyIsActive;
    Object.assign(frame, {
      acquireSidebarTabClose, autoCloseCandidate, autoController, autoOpenCandidate, autoSidebarOwnershipHasCapacity, beginSidebarCloseVerification,
      finishVerifiedSidebarClose, requestSidebarTabClose, sidebarActions, sidebarAutoCloseKeyIsActive,
      sidebarAutoOpenCapable, sidebarTabCloseInFlight,
      sidebarTabPresenceInInventory, verifyPendingSidebarCloses, waitForSidebarCloseLease,
    });
  }

  /** undefined */
  function useSidebarPanelAutoOrchestrationPart2(frame) {
    const {
      autoController, sidebarActions, sidebarTabSyncRef,
    } = frame;

    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 closeSidebarTabWithLease()：本层只注入本帧作用面，不含任何判据。
     */
    const closeSidebarTabWithLease = (tabId, options) => autoController().closeSidebarTabWithLease(tabId, options);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 cleanupAutoSidebarKeys()：本层只注入本帧作用面，不含任何判据。
     */
    const cleanupAutoSidebarKeys = (known, actingKey) => autoController().cleanupAutoSidebarKeys(known, actingKey);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 sweepAutoOpenPlaceholders()：本层只注入本帧作用面，不含任何判据。
     */
    const sweepAutoOpenPlaceholders = (running) => autoController().sweepAutoOpenPlaceholders(running);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 launchAutoSidebarAction()：本层只注入本帧作用面，不含任何判据。
     */
    const launchAutoSidebarAction = (candidate) => sidebarActions().launchAutoSidebarAction(candidate);
    /**
     * 唯一实现在 client-sidebar-auto-controller.js 的 clearManualSuppressionOfIdleResources()：本层只注入本帧作用面，不含任何判据。
     */
    const clearManualSuppressionOfIdleResources = (idle) => autoController().clearManualSuppressionOfIdleResources(idle);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 syncAutoSidebarTabs()：本层只注入本帧作用面，不含任何判据。
     */
    const syncAutoSidebarTabs = () => sidebarActions().syncAutoSidebarTabs();

    /**
     * 唯一实现在 client-sidebar-actions.js 的 autoActionStillValid()：本层只注入本帧作用面，不含任何判据。
     */
    const autoActionStillValid = (context) => sidebarActions().autoActionStillValid(context);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 abandonAutoSidebarAction()：本层只注入本帧作用面，不含任何判据。
     */
    const abandonAutoSidebarAction = (key, context) => sidebarActions().abandonAutoSidebarAction(key, context);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 releaseAutoCloseAttempt()：本层只注入本帧作用面，不含任何判据。
     */
    const releaseAutoCloseAttempt = (key, context) => sidebarActions().releaseAutoCloseAttempt(key, context);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 autoTakeoverStateOf()：本层只注入本帧作用面，不含任何判据。
     */
    const autoTakeoverStateOf = (key) => sidebarActions().autoTakeoverStateOf(key);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 recordSidebarManualIntent()：本层只注入本帧作用面，不含任何判据。
     */
    const recordSidebarManualIntent = (key, resourceAddress) => sidebarActions().recordSidebarManualIntent(key, resourceAddress);
    /**
     * 唯一实现在 client-sidebar-actions.js 的 applyPendingManualIntent()：本层只注入本帧作用面，不含任何判据。
     */
    const applyPendingManualIntent = (key) => sidebarActions().applyPendingManualIntent(key);

    /**
     * 唯一实现在 client-sidebar-actions.js 的 syncSidebarTabs()：本层只注入本帧作用面，不含任何判据。
     */
    const syncSidebarTabs = () => sidebarActions().syncSidebarTabs();
    // 挂载 effect 与轮询/observer 回调都只经由这个引用取最新闭包（见 sidebarTabSyncRef 的说明）。
    sidebarTabSyncRef.current = syncSidebarTabs;

    // 登记给更早 Hook 的晚绑定包装（声明已完成，此后的调用都拿到本帧的实例）。
    frame.late.applyPendingManualIntent = applyPendingManualIntent;
    frame.late.cleanupAutoSidebarKeys = cleanupAutoSidebarKeys;
    frame.late.clearManualSuppressionOfIdleResources = clearManualSuppressionOfIdleResources;
    frame.late.sweepAutoOpenPlaceholders = sweepAutoOpenPlaceholders;
    Object.assign(frame, {
      abandonAutoSidebarAction, applyPendingManualIntent, autoActionStillValid, autoTakeoverStateOf, cleanupAutoSidebarKeys, clearManualSuppressionOfIdleResources,
      closeSidebarTabWithLease, launchAutoSidebarAction, recordSidebarManualIntent, releaseAutoCloseAttempt, sweepAutoOpenPlaceholders, syncAutoSidebarTabs,
      syncSidebarTabs,
    });
  }

  global[SYMBOL] = Object.freeze({
    useSidebarPanelAutoOrchestration, useSidebarPanelAutoOrchestrationPart2, useSidebarPanelAutoRefs,
    useSidebarPanelTabPrimitives, useSidebarPanelTabSync, useSidebarPanelTabWiring,
    useSidebarPanelTabWiringPart2, useSidebarPanelTabWiringPart3,
  });
})(globalThis);
