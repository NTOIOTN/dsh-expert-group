/**
 * 客户端侧栏 · install 宽度状态与配比（R7 票据 25 / sidebar-install-width）
 *
 * ## 职责边界
 * 本模块是「右栏宽度」的**唯一读写下命令面**：
 * 1. 目标写入：applyRightbarWidth（按视口 × 比例写宿主 layout store，并记账归属）；
 * 2. 所有权观测：readRightbarPanelWidth / rightbarOwnershipOf（公开 DOM 证据，fail-closed）；
 * 3. 恢复与视口重算：recoverRightbarWidth / recomputeOwnedWidth（共用一份按会话的有界预算）；
 * 4. transient 记账：mode / prepared / active 的读写与按会话收口；
 * 5. 分栏事务表的按会话增删（begin/commit/cancel 的命令在 target 模块，表本身与逐条收口在这里）。
 *
 * ## 状态所有权（票据 25 的 C5 硬约束）
 * - 六份宽度容器（widths / viewports / modes / prepared / active / recoveries）的**生命周期**
 *   属于 `sidebar-install-layout`：它创建容器、并在 dispose 时调用自己的 clearWidthState()。
 * - 本模块**只持读写命令**，绝不调用 `.clear()` —— 从这里 grep 不到任何 Map.clear()。
 *   容器引用与 `surfaceSessionId` 标量都来自同一份 `frame.layout.widthState` 状态框（不复制）。
 * - 分栏事务表同样按会话逐条 delete（releaseSidebarSplitTransaction / cancel 路径），
 *   整表清空交给 `cancelAllSidebarSplits` 逐条收口（原实现也没有整表 clear）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-install-width")]
 * 装配：真实依赖边为 pure / dom → 本模块 → install-resources。
 */
(function installSidebarInstallWidth(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-width");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    OTHER_RIGHTBAR_WIDTH_RATIO, RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX, RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS,
    clampRightbarWidthRatio, resolveExpertRightbarWidthRatio, storeRightbarWidthRatio,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    hostAppFrameWidthOf, methodOf, rightbarPanelForSession, viewportWidthOf,
  } = DOM;

  /**
   * 构建本次 install 的宽度命令面。
   *
   * `frame` 是 coordinator 持有的同一份可写框；容器引用来自 `frame.layout.widthState`（布局
   * 模块是唯一 owner）。所有命令都保持拆分前的判定、写入时机与 fail-closed 边界。
   */
  function createWidthBookkeeping(frame) {
    const state = frame.layout.widthState;
    // 容器引用按拆分前的同名标识符取回：命令体因此逐字不变（读写的是同一份 widthState）。
    const rightbarWidths = state.widths;
    const rightbarWidthModes = state.modes;
    const rightbarWidthPreparedSessions = state.prepared;
    const rightbarWidthActiveSessions = state.active;
    const rightbarWidthRecoveries = state.recoveries;
    const rightbarSplitTransactions = state.splitTransactions;
    /**
     * 最近一次成功写入宽度的 surface 会话：宿主那份全局宽度当前归谁。
     *
     * 宿主 setRightbar 写的是全局 layout store；因此 session A → B → A 的每次 surface 切换都必须
     * 重新把当前会话的宽度写回：宿主里那份值此刻属于上一个会话，不能只因为 rightbarWidths 里
     * 留着 A 的旧目标值就跳过。同一次激活内的重复通知仍由各会话自己的记账去重，避免在 Expert
     * Group 页保持活跃时无意义地覆盖宿主状态。
     *
     * 标量由本模块（唯一写入点 claimRightbarWidthOwnership）持有；openTargets 只经
     * `surfaceSessionId()` 命令读取当前值。
     */
    let rightbarWidthSurfaceSessionId = null;

    /** 清除某个会话的恢复写入记账（收敛 / 所有权周期变化 / dispose 共用）。 */
    const clearRightbarWidthRecovery = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      rightbarWidthRecoveries.delete(sessionId);
    };
    /**
     * 恢复边沿的**有界预算**判定：返回 true 表示这一次「宿主夺回了宽度」的恢复写入允许执行。
     *
     * 只在恢复边沿调用（统一入口是 recoverRightbarWidth：recomputeOwnedWidth 的 hostReclaimed 分支
     * 与 confirmed 分支的同一判据），因此首次接管、从其它分页返回、分栏事务的 50% / 收口 20% 等
     * 正常写入完全不受影响。
     *
     * target 参数必须是**按当前视口算出来的预期值**（`Math.round(视口宽度 × 比例)`），不能传「上次
     * 成功写入的值」：宿主持续 clamp 时，视口 3200 → 3201 → 3202 的预期值都是 640，用预期值做事件
     * 同一性，这些视口变化才会被正确地归入同一个未收敛事件、不再重新获得预算。
     *
     * 预算在**调用时**消耗（而不是写入成功后）：写入本身几乎不会失败，而「尝试过就计数」能保证
     * 即使宿主每次都把写入吞掉，也不会出现无限重试——这正是本预算要挡住的形状。
     */
    const allowRightbarRecoveryWrite = (sessionId, target, actualWidth) => {
      if (sessionId === null || sessionId === undefined) return false;
      if (typeof target !== "number" || Number.isFinite(target) !== true) return false;
      if (typeof actualWidth !== "number" || Number.isFinite(actualWidth) !== true) return false;
      const recorded = rightbarWidthRecoveries.get(sessionId);
      const sameEvent = recorded !== undefined
        && recorded.target === target
        && Math.abs(recorded.actualWidth - actualWidth) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX;
      if (sameEvent !== true) {
        // 新的一次 mismatch 事件（首次观测 / target 变了 / 观测到的实际宽度变了）。
        rightbarWidthRecoveries.set(sessionId, { target, actualWidth, attempts: 1 });
        return true;
      }
      if (recorded.attempts >= RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS) return false;
      recorded.attempts += 1;
      return true;
    };
    /** 读取某个会话当前的宽度模式；没有已确认模式时返回 null。 */
    const widthModeOf = (sessionId) => (sessionId === null || sessionId === undefined
      ? null
      : rightbarWidthModes.get(sessionId) ?? null);
    /** 写入（mode 非空）或清除（mode 为 null）某个会话的宽度模式。 */
    const setWidthMode = (sessionId, mode) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthModes.get(sessionId) ?? null;
      const next = mode === null || mode === undefined ? null : mode;
      if (next === null) rightbarWidthModes.delete(sessionId);
      else rightbarWidthModes.set(sessionId, next);
      // 模式（= 宽度所有权周期）**发生变化**时，恢复事件记账随之失效：新周期里的第一次 mismatch
      // 是新事件，重新获得完整预算。两条刻意收紧的边界：
      // - 只在**已有非空模式**被换掉（expert ↔ other、或交还成 null）时清除。null → expert 是
      //   「首次确认这一份 expert 所有权」，恢复记账仍属于同一个周期，不能被重置；
      // - 无条件清除会让 confirmed 分支每一轮同步都重置预算（它每轮都用同一个值调用本函数），
      //   正常轮询就能无限重写——正是本预算要挡住的形状。
      if (previous !== null && previous !== next) clearRightbarWidthRecovery(sessionId);
    };
    /** 某个会话是否刚被 openTargets 预置过宽度（同一同步栈内不重复写）。 */
    const isWidthPrepared = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthPreparedSessions.has(sessionId);
    /** 标记/清除某个会话的「刚预置过宽度」状态。 */
    const setWidthPrepared = (sessionId, value) => {
      if (sessionId === null || sessionId === undefined) return;
      if (value === true) rightbarWidthPreparedSessions.add(sessionId);
      else rightbarWidthPreparedSessions.delete(sessionId);
    };
    /** 某个会话的 Expert Group 页是否已被 active() 证明落地（宽度已经成功写到宿主）。 */
    const isWidthActive = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthActiveSessions.has(sessionId);
    /** 标记/清除某个会话的「已确认活跃」状态。 */
    const setWidthActive = (sessionId, value) => {
      if (sessionId === null || sessionId === undefined) return;
      if (value === true) rightbarWidthActiveSessions.add(sessionId);
      else rightbarWidthActiveSessions.delete(sessionId);
    };
    /** 清除某个会话的全部 transient 宽度记账（模式 + 预置 + 已确认活跃）。 */
    const clearRightbarWidthMarks = (sessionId) => {
      setWidthMode(sessionId, null);
      setWidthPrepared(sessionId, false);
      setWidthActive(sessionId, false);
      // 模式/所有权周期结束时，这个会话的「恢复事件」记账一并失效：下一次 mismatch 是新事件。
      clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 把宿主那份全局宽度的归属迁移到 sessionId（每次成功写入后调用）。
     *
     * 旧主人的 transient 记账（模式 / 预置 / 已确认活跃）描述的是「宿主那份宽度属于它」时的状态，
     * 归属一换就不再成立：必须一起失效，否则 A 的 other / split-pending 会在 B 激活时被当成 B 的
     * 现状（B 的首次预置被跳过），切回 A 时又会挡住 A 自己的 50% 重放。新会话自己的条目一概不动；
     * per-session 的目标值 widths 不受影响，切回时仍按该会话自己的目标重估。
     */
    const claimRightbarWidthOwnership = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthSurfaceSessionId;
      if (previous !== null && previous !== sessionId) clearRightbarWidthMarks(previous);
      rightbarWidthSurfaceSessionId = sessionId;
    };
    /** 按 token 反查仍然在途的事务；已被 commit/cancel 收口的 token 一律返回 null（迟到回调的安全边界）。 */
    const transactionOf = (token) => {
      if (token === null || token === undefined) return null;
      for (const transaction of rightbarSplitTransactions.values()) {
        if (transaction.token === token) return transaction;
      }
      return null;
    };
    /** 从表里移除自己那一条（按 identity 比对，绝不误删同会话后来居上的新事务）。 */
    const releaseSidebarSplitTransaction = (transaction) => {
      if (rightbarSplitTransactions.get(transaction.sessionId) === transaction) {
        rightbarSplitTransactions.delete(transaction.sessionId);
      }
    };
    /** 逐条收口全部在途事务（无可见 surface / dispose）：每条只清理自己所属 session 的 transient 记账。 */
    const cancelAllSidebarSplits = (reason) => {
      for (const transaction of [...rightbarSplitTransactions.values()]) {
        try { frame.target.cancelSidebarSplit(transaction.token, { reason }); } catch { /* 单条收口失败不能阻断其余事务与 disposer。 */ }
      }
    };
    /** 分栏事务自己的 deadline 句柄，不能借用 panel 的 opening 记录或 observer 生命周期。 */
    const clearSidebarSplitDeadline = (transaction) => {
      if (transaction === null || transaction === undefined) return;
      const timer = transaction.deadlineTimer;
      transaction.deadlineTimer = null;
      if (timer === null || timer === undefined) return;
      try { globalThis.clearTimeout?.(timer); } catch { /* 收口路径必须继续执行。 */ }
    };
    return Object.freeze({
      allowRightbarRecoveryWrite,
      cancelAllSidebarSplits,
      // 容器访问命令也归簿记面：它们是「同一份 widthState」的窄读面，writer 与 target 都只读。
      hasSplitTransaction: (sessionId) => rightbarSplitTransactions.has(sessionId),
      hasWidthTarget: (sessionId) => rightbarWidths.has(sessionId),
      splitTransactions: rightbarSplitTransactions,
      splitTransactionsList: () => [...rightbarSplitTransactions],
      surfaceSessionId: () => rightbarWidthSurfaceSessionId,
      claimRightbarWidthOwnership,
      clearRightbarWidthMarks,
      clearRightbarWidthRecovery,
      clearSidebarSplitDeadline,
      isWidthActive,
      isWidthPrepared,
      releaseSidebarSplitTransaction,
      setWidthActive,
      setWidthMode,
      setWidthPrepared,
      transactionOf,
      widthModeOf,
    });
  }

  /**
   * 宽度写入命令面：目标写入、公开 DOM 所有权证据、恢复/视口重算与面板偏好注入点。
   *
   * 与簿记面（createWidthBookkeeping）分开只为守住「单工厂 ≤400 行」的门禁：两者共用同一份
   * `frame.layout.widthState` 容器与同一套语义，跨面调用一律经 `frame.width` 在调用时解析。
   */
  function createRightbarWidthWriter(frame) {
    const config = frame.config;
    const state = frame.layout.widthState;
    // 与簿记面同一份容器（拆分前就是两个闭包共用的同一批 Map/Set）。
    const rightbarWidths = state.widths;
    const rightbarWidthViewports = state.viewports;

    /**
     * 为某个 surface 会话写入右栏宽度（默认比例 = 持久化偏好，缺省 20%）；返回是否真的写了。
     *
     * 写入时机：只有该会话的 Expert Group surface 被激活（openTargets 里的当前可见会话）时才写，
     * 并且**同一会话不重复改写**——宿主里的这个值可能已经是用户拖拽或宿主自己算出的结果；
     * 视口宽度变化导致同一会话的目标 px 变化时会重写一次。
     *
     * 比例边界（票据 18）：Expert Group 页的默认比例是 20%，用户拖拽/键盘调整后以 localStorage
     * 里的偏好为准（readStoredRightbarWidthRatio 已 clamp 到 15%–50%）；other 模式仍固定 50%。
     * 这里不再对传入比例做二次 clamp（调用方已归一），宿主 setRightbar 自己的 clamp 仍是最终边界。
     *
     * 写入前会 best-effort 同步宿主自己那份视口缓存：宿主 clamp 用的是 AppFrame 根元素宽度，
     * 冷启动时它可能还停在旧值，会把目标宽度夹小（2560 视口写 1280，宿主按 1280 缓存夹成 896），
     * 而插件的记账已认为「这个视口写过」，偏差不会自愈。同步值只取**能唯一、可靠读到的 AppFrame
     * 宽度**（见 hostAppFrameWidthOf），绝不拿 window.innerWidth 顶替；读不到就完全跳过同步。
     * 目标像素值仍按 window.innerWidth 的比例换算，本次已读取的同一个视口宽度贯穿始终。
     *
     * 兼容：layout 服务缺失、服务代理读属性抛错、setRightbar 不是函数或调用抛错时一律返回 false
     * 且**不记账**——写入失败不算应用，后续通知仍可重试，宿主自己的默认宽度继续生效。
     * 可选的视口同步 action 缺失、读属性抛错或调用抛错都不阻断既有 setRightbar 路径。
     */
    const applyRightbarWidth = (sessionId, ratio = resolveExpertRightbarWidthRatio(), force = false) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 视口宽度读不到（无 DOM 环境）就没有可换算的比例：放弃写入，保留宿主当前值。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const normalizedRatio = Number(ratio);
      if (!Number.isFinite(normalizedRatio) || normalizedRatio <= 0) return false;
      const target = Math.round(viewportWidth * normalizedRatio);
      if (force !== true && rightbarWidths.get(sessionId) === target) return false;
      const layout = config.layout || frame.optionalService("layout");
      // panels 与两个 action 的属性读取必须**逐项独立隔离**：可选的 setViewportWidth 读属性抛错
      // （Cordis 服务代理对未声明属性就会抛）绝不能把必要的 setRightbar 一起挡掉。
      let panels = null;
      try { panels = layout?.panels ?? null; } catch { panels = null; }
      const setRightbar = methodOf(panels, "setRightbar");
      if (setRightbar === null) return false;
      const setViewportWidth = methodOf(panels, "setViewportWidth");
      // 宿主 setRightbar 按 layout store 的 viewportWidth 做上限 clamp，而那份缓存来自 AppFrame 根
      // 元素宽度（冷启动时可能还停在旧值，把目标宽度夹小）。只有能唯一、可靠读到 AppFrame 宽度时
      // 才先把它同步给宿主；读不到 AppFrame、尺寸非法时**不同步、不猜测宿主尺寸**，直接走原有写入。
      const appFrameWidth = hostAppFrameWidthOf();
      if (appFrameWidth !== null) {
        try { setViewportWidth?.call(panels, appFrameWidth); } catch { /* 校准不是展示侧栏的前置条件，失败时保留原有写入兼容路径。 */ }
      }
      try {
        // bound action 是闭包，不依赖 this；仍显式带上接收者，兼容将来改成方法式绑定。
        setRightbar.call(panels, target);
      } catch {
        // 调用失败不算写入成功：保持未记账（后续通知仍可重试），宿主当前宽度继续生效。
        return false;
      }
      rightbarWidths.set(sessionId, target);
      // 连同「这次换算用的视口宽度」一起记账：它才是「宿主那份像素值是否还对应当前视口」的判据，
      // 也是常驻同步路径发现窗口最大化 / 全屏 / 拖拽后必须重新写入的唯一来源。
      rightbarWidthViewports.set(sessionId, viewportWidth);
      // 写入成功即接管宿主那份全局宽度：旧会话的 transient 记账随归属一起失效（见 claim 说明）。
      frame.width.claimRightbarWidthOwnership(sessionId);
      return true;
    };
    /**
     * 某个会话「上次写入宽度时用的视口宽度」是否已经变了（窗口最大化 / 全屏 / 拖拽 / 旋转屏幕）。
     *
     * 右栏宽度是视口比例，视口一变，之前写下的像素值就不再代表 20% / 50%：必须按新视口重新
     * 换算并写入。这是常驻同步路径**唯一**的重新写入判据——同一视口下的重复通知仍然一个字节
     * 都不写（保留「宿主里那份值可能是用户拖拽结果」的原有去重语义）。
     *
     * 没有写过宽度（没有记账）时返回 false：那种情况由「首次接管 / 从其它分页返回」等既有
     * 分支负责写入，不在这里重复承担。
     */
    const rightbarWidthViewportChanged = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const recorded = rightbarWidthViewports.get(sessionId);
      if (recorded === undefined) return false;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      return recorded !== viewportWidth;
    };
    /**
     * 读当前会话对应右栏面板的**实际渲染宽度**（px）。
     *
     * 这是「宿主里那份宽度到底是谁写的」唯一可验证的公开证据：只读
     * [data-sidebar-right-panel] 与 getBoundingClientRect()，不注册 class、不读任何私有状态。
     *
     * 一律 fail-closed（返回 null）：面板归属无法精确解析（零个 / 多个 / 缺
     * data-sidebar-right-session）、没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数
     * （null / 0 / NaN / 负值 / 非数字）——这些都不构成「宽度等于某个值」的证据，调用方必须保留
     * 宿主当前值，等后续可验证的同步。
     */
    const readRightbarPanelWidth = (sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") return null;
      let panel = null;
      try { panel = rightbarPanelForSession(globalThis.document, sessionId); } catch { return null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try {
        rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
      } catch { return null; }
      if (rect === null || typeof rect !== "object") return null;
      let width = null;
      try { width = Number(rect.width); } catch { return null; }
      if (Number.isFinite(width) !== true || width <= 0) return null;
      return width;
    };
    /**
     * 一次性读出「宿主那份宽度 vs 插件 target」的**所有权观测**；读不出来时返回 null（fail-closed）。
     *
     * 返回 { target, actualWidth, matches, differs }：
     * - matches：面板实际渲染宽度仍等于插件上次写入的 target（所有权仍在插件手里）；
     * - differs：面板实际渲染宽度明确不等于 target（宿主夺回了那份 px）。
     *
     * 为什么合成一个函数：同一轮同步里既要判 matches 又要判 differs，还会消费恢复预算，分开调用会
     * 把同一份 DOM 证据读两遍（readRightbarPanelWidth → getBoundingClientRect 会触发布局）。
     * 任何一环读不出来（没有 target / 面板定位不到 / 宽度不是有限正数）一律返回 null——读不出来就
     * 不构成任何证据，调用方必须原样保留宿主当前值。
     */
    const rightbarOwnershipOf = (sessionId) => {
      const target = rightbarWidths.get(sessionId);
      if (typeof target !== "number" || Number.isFinite(target) !== true) return null;
      const actualWidth = readRightbarPanelWidth(sessionId);
      if (actualWidth === null) return null;
      const delta = Math.abs(actualWidth - target);
      return {
        target,
        actualWidth,
        matches: delta <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
        differs: delta > RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
      };
    };
    /**
     * 宿主里那份右栏宽度是否**仍是插件上一次成功写入的 target**（见 widths）。
     *
     * 为什么需要它：other 模式的宽度是**可调**的，用户在其它右侧分页上拖出的宽度由宿主持有。
     * 只有「面板实际渲染宽度 == 插件上次写的 px」才能证明宿主里那份值仍是插件写的（或用户恰好
     * 拖回了同一个值，等价于没有改动），此时按模式重算视口才不会覆盖用户的拖拽结果。
     *
     * 任何一环读不出来（没有上次 target / 面板宽度读不到 / 宽度对不上）都返回 false：宁可这一次
     * 不重算，也绝不猜测写入——宿主当前值原样保留，后续 confirmed / other 分支仍会按证据重估。
     */
    const hostWidthMatchesPluginTarget = (sessionId) => {
      const ownership = rightbarOwnershipOf(sessionId);
      return ownership !== null && ownership.matches === true;
    };
    /**
     * 消费一次「所有权观测」：观测到收敛（实际宽度 == target）就清掉恢复事件记账。
     *
     * 这正是「状态清除」的唯一判据：宿主终于把 target 提交到 DOM 上之后，下一次 mismatch 必须是
     * **新的一次恢复事件**（重新获得完整预算），而不是被上一次已经用尽的预算永久挡住。
     * 读不出观测（null）时什么都不做——没有证据就不清除，保持原有记账。
     */
    const settleRightbarRecovery = (sessionId, ownership) => {
      if (ownership !== null && ownership.matches === true) frame.width.clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 恢复 / 视口重写的**统一入口**：所有「实际宽度明确偏离当前视口预期 target」的写入都走这里。
     *
     * 为什么必须统一：恢复写入的判据散落在两条分支上（confirmed 分支与 recomputeOwnedWidth 的
     * unknown 分支）时，只要其中一条把「视口变化」当成**独立**边沿、不消费预算，宿主持续 clamp 的
     * 场景就能被无限绕过——视口从 3200 挪到 3201 / 3202，20% 取整后仍是同一个 target 640，
     * 每一次视口变化都变成「一次新的恢复事件」，用户轻微拖动窗口边缘就会与宿主的 clamp 无限拉锯。
     * 因此两条分支共用这一份判定（per-session，按预期 target + 观测到的实际宽度记账）。
     *
     * 三条口径：
     * - **没有公开 DOM 证据（ownership 为 null：面板定位不到，或 getBoundingClientRect().width
     *   不是有限正数）就是不写**：恢复 / 视口重算入口一律 fail-closed，一个字节都不写，既不消费
     *   mismatch 预算，也绝不新建 / 重置一次 mismatch 事件。右栏宽度是宿主 layout store 里的**全局**
     *   偏好，插件只在能证明「这份 px 现在是谁的」时才允许改写它；读面不可用期间没有任何证据说明
     *   面板宽度偏离了 target，写下去就是无据改写宿主状态（而且是每次视口变化 / 通知 / 轮询都写的
     *   无界改写）。宿主那份值原样保留，等后续**可验证**的同步（readRightbarPanelWidth 恢复可读）——
     *   这条收紧只作用于恢复 / 视口重算入口，首次接管、从其它分页返回、分栏事务收口等正常写入
     *   语义完全不受影响；
     * - 实际宽度已经等于**当前视口下预期**的 target：这不是 mismatch，只是视口记账需要更新（例如
     *   宿主已经自己落到了正确宽度），正常写一次即可，不消费预算；
     * - 实际宽度明确偏离预期 target：同一个 (预期 target, 实际宽度) 的写入共用 per-session 预算，
     *   用尽后一律拒绝；预期 target 真正改变（窗口最大化导致取整结果变化）时是一次**新事件**，
     *   重新获得完整预算。
     *
     * 调用方负责「该不该尝试写入」的边沿判定（视口变化 / 宿主夺回宽度 / 模式证据），这里只负责
     * 「这次写入允不允许」：不读任何私有状态、不新增轮询或定时器。
     */
    const recoverRightbarWidth = (sessionId, ratio, ownership) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 没有任何公开 DOM 证据：直接 fail-closed。这里刻意不调用 applyRightbarWidth（更不带 force），
      // 因此既不会写宿主宽度，也不会触碰恢复预算记账（不新建、不重置、不消费）。
      if (ownership === null || ownership === undefined) return false;
      // 预期 target 必须与 applyRightbarWidth 用同一套换算（同一视口宽度 × 同一比例、同样取整），
      // 否则事件同一性会把「同一份预期值」判成两次不同事件。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const expectedTarget = Math.round(viewportWidth * ratio);
      if (Math.abs(ownership.actualWidth - expectedTarget) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX) {
        // 实际宽度已经等于预期 target：只是视口记账需要更新，不属于 mismatch，不消费预算。
        return applyRightbarWidth(sessionId, ratio, true) === true;
      }
      if (frame.width.allowRightbarRecoveryWrite(sessionId, expectedTarget, ownership.actualWidth) !== true) return false;
      return applyRightbarWidth(sessionId, ratio, true) === true;
    };
    /**
     * 组成证据为 unknown 时，按**本会话已经证明过的宽度模式**重算「视口变化 / 宿主夺回宽度」。
     *
     * 两条触发边沿（都只作用于 expert 模式，见下面的 other 分支说明）：
     * 1. 视口宽度变了（窗口最大化 / 全屏 / 拖拽窗口边缘）：那份 px 不再代表原来的比例；
     * 2. **宿主夺回了那份 px**（面板实际渲染宽度 != 插件上次写入的 target）：DSH 重启后宿主从
     *    持久化布局恢复它自己那份旧值的时序正是「视口没变但那份值已经不是插件的」，
     *    只按视口判据永远等不到重算（见 rightbarOwnershipOf 的 differs）。
     *
     * 为什么「面板宽度 != 插件 target」就足以证明宿主夺回了所有权（只在 expert 模式消费）：
     * Expert Group 页的手柄由插件锁住（rightbarDragLock），用户在这一页**拖不动**右栏；而 20%
     * 又是插件独占的固定比例，不存在「用户在该页自定义宽度」的语义。因此这一页上面板宽度偏离
     * target 只有两种可能：宿主自己重渲染回了它那份持久化值，或用户恰好拖到了同一个值（等价于
     * 没有改动）。两种情形都应当把 20% 写回去——但**必须有界**（见 recoverRightbarWidth）。
     *
     * 为什么 unknown 仍然可以重算：组成读面（inventory / DOM）回答的是「当前右栏里有哪些页」，
     * 而这里消费的是本会话**自己**的宽度记账——它记的是「宿主那份 px 是按哪个比例、哪个视口
     * 写下去的」，与组成读面无关。视口一变（窗口最大化 / 全屏 / 拖拽窗口边缘），那份 px 就不再
     * 代表原来的比例（实测：1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640），因此
     * 必须按同一比例重算；否则读面暂不可用的宿主会一直停在过期宽度上。
     *
     * fail-closed 边界（绝不放松）：
     * - 没有任何模式证据（mode 为空且 prepared/active 都没有）时返回 false，一个字节都不写；
     *   组成读面不可用时**绝不臆测** 20% 或 50%，也绝不把 unknown 当成 confirmed；
     * - **没有宽度 DOM 证据（面板宽度读不出来）时同样一个字节都不写**：expert 模式虽然不要求
     *   「面板宽度仍等于插件 target」（那是 other 的可调保护），但**要求这条读面本身可用**——
     *   ownership 为 null 时 recoverRightbarWidth 直接 fail-closed，既不写宽度也不动恢复预算
     *   （见该函数第一条口径）。模式证据只回答「该写哪个比例」，不构成「可以无据改写宿主全局
     *   宽度」的证据；
     * - **other 模式额外要求宿主宽度所有权**：other 的 50% 是可调状态，用户可以在该页手动拖宽，
     *   仅凭「模式是 other」就重算会覆盖用户的拖拽结果。因此只有 hostWidthMatchesPluginTarget
     *   证明宿主里那份 px 仍是插件上次写的 target 时才重算；读不到或对不上一律不写（见该函数说明）。
     *   expert 模式不受此限制：20% 是插件**独占**的固定比例，不存在「用户在该页拖宽」的语义；
     * - **other 模式只认视口变化这一条边沿**：宿主夺回宽度在 other 模式里正是「用户拖过一次」
     *   的典型形状，据此重算会覆盖用户的拖拽结果，因此那一模式绝不消费 hostReclaimed；
     *   other 的视口重算还额外要求 hostWidthMatchesPluginTarget（实际宽度仍等于插件上次的 target），
     *   这条真实用户拖拽保护不受本预算逻辑影响，绝不放宽；
     * - expert 模式去重：视口没变、且宿主那份值仍等于插件 target 时什么都不做；
     * - 写入失败由 applyRightbarWidth 自己保证不记账，后续通知仍可重试；
     * - 手柄锁与组合归属语义完全不变：本函数不碰 rightbarDragLock，也不改写任何 transient 记账
     *   （prepared / active 保持原样，因此下一次视口变化仍然有据可依）。
     */
    const recomputeOwnedWidth = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const viewportChanged = rightbarWidthViewportChanged(sessionId) === true;
      // expert 模式下还有第二条触发边沿：宿主已经夺回那份 px（面板宽度不再等于插件 target）。
      // DSH 重启后宿主恢复持久化旧值的时序正是「视口没变但那份值已经不是插件的」，只按视口判据
      // 永远等不到重算。一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
      const ownership = rightbarOwnershipOf(sessionId);
      // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
      settleRightbarRecovery(sessionId, ownership);
      const hostReclaimed = ownership !== null && ownership.differs === true;
      if (viewportChanged !== true && hostReclaimed !== true) return false;
      const mode = frame.width.widthModeOf(sessionId);
      // 只有已确认的模式才给出比例：expert = 20%，other = 50%。split-pending 不会走到这里
      // （在途事务在 rightbarDragSyncImpl 里更早 return，收口时也必然被改写成 expert/other/null），
      // 万一出现也一律不猜。
      let ratio = null;
      if (mode === "expert") {
        // expert 模式的比例来自持久化偏好（缺省 20%）：视口变化与「宿主夺回宽度」两条边沿都重算。
        ratio = resolveExpertRightbarWidthRatio();
      } else if (mode === "other") {
        // other 是可调模式，**只认视口变化这一条边沿**：
        // - 宿主夺回宽度（面板宽度 != 插件 target）在 other 模式里恰恰是「用户拖过一次」的
        //   典型形状，绝不能据此重算，否则会把用户的拖拽结果覆盖成 50%；
        // - 视口变化本身也必须先证明所有权（面板宽度仍等于插件 target）才允许重算；
        // 读不到面板宽度时所有权不成立 → 一个字节都不写，用户的宽度原样保留。
        if (viewportChanged !== true) return false;
        if (ownership === null || ownership.matches !== true) return false;
        ratio = OTHER_RIGHTBAR_WIDTH_RATIO;
      } else if (mode === null && (frame.width.isWidthPrepared(sessionId) || frame.width.isWidthActive(sessionId))) {
        // prepared / active 只由**成功的 expert 比例写入**置位（openTargets 预置，或 confirmed 分支 /
        // 事务收口时按偏好恢复成功），因此它们证明的模式就是 expert；这里绝不据此推断 50%。
        ratio = resolveExpertRightbarWidthRatio();
      }
      if (ratio === null) return false;
      // 写入判据与 confirmed 分支**共用**同一份有界预算（见 recoverRightbarWidth）：视口变化本身不再
      // 自动等于「可以再写一次」——取整后仍是同一个 target 的视口变化不是新的 mismatch 事件，
      // 否则宿主持续 clamp 时轻微拖动窗口边缘就能无限重写。
      return recoverRightbarWidth(sessionId, ratio, ownership) === true;
    };
    /**
     * 面板「宽度偏好」注入点的写入实现（票据 18）：面板只提出「想改成多少」，真实写入与持久化在这里。
     *
     * - 写入前先 clamp 并（按需）落盘；存储不可用不影响本次生效；
     * - 分栏事务进行中时宽度由事务独占（临时 50%）：只记偏好，不写宿主，避免拖拽与事务
     *   互相覆盖；事务收口后的下一次同步会按新偏好重算；
     * - 写入成功后把本会话标记为 expert 模式并接管所有权，后续视口变化仍按同一偏好重算。
     */
    const applyRightbarWidthRatio = (ratio, options = {}) => {
      const clamped = clampRightbarWidthRatio(ratio);
      if (clamped === null) return null;
      if (options.persist === true) storeRightbarWidthRatio(clamped);
      const sessionId = frame.target.currentSurfaceSessionId();
      if (sessionId === null) return clamped;
      if (frame.width.hasSplitTransaction(sessionId)) return clamped;
      if (applyRightbarWidth(sessionId, clamped, true) !== true) return clamped;
      setWidthPrepared(sessionId, false);
      setWidthActive(sessionId, true);
      setWidthMode(sessionId, "expert");
      return clamped;
    };

    return Object.freeze({
      applyRightbarWidth,
      applyRightbarWidthRatio,
      hostWidthMatchesPluginTarget,
      readRightbarPanelWidth,
      recomputeOwnedWidth,
      recoverRightbarWidth,
      rightbarOwnershipOf,
      rightbarWidthViewportChanged,
      settleRightbarRecovery,
    });
  }

  global[SYMBOL] = Object.freeze({ createRightbarWidthWriter, createWidthBookkeeping });
})(globalThis);
