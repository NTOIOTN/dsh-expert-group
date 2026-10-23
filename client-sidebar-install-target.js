/**
 * 客户端侧栏 · install 目标同步（R7 票据 25 / sidebar-install-target）
 *
 * ## 职责边界
 * 本模块承接「当前可见 surface 的目标」这一条链路：
 * 1. `openTargets()`：一次 sessions / Better 状态通知的完整同步（访问代次、宽度预置、页面打开、
 *    展开排程、手柄锁重估、重挂载边沿复位）；
 * 2. `currentSurfaceSessionId()` 与 `openNativeTab()`：当前 surface 的精确解析与 native 打开回退；
 * 3. `rightbarDragSyncImpl`：按宿主公开活跃 tab 证据重估手柄锁 + 宽度模式 + 列宽配比；
 * 4. 首次分栏事务（begin / mark / commit / cancel）：按会话隔离的 50% → 证据 → 收口协调器。
 *
 * ## 关键语义（逐条保留，不得放宽）
 * - 注册顺序契约（coordinator 负责调用序）：建 panel → session 订阅 → Better registerTab 后
 *   subscribeState → native tabs.register 后 slots.register → **最后** openTargets()。
 * - 只服务当前可见 surface：绝不为后台 root/child 预发打开请求（宿主对未挂载会话的 scoped
 *   open 会静默 no-op，却被当成已完成）。
 * - 顺序硬约束：宽度写入（同步）→ 打开页面（deferred）→ 展开右栏（deferred）。
 * - 分栏事务：只有目标 subagentchat tab 已经位于 split 返回的 pane 才提交 other 模式；
 *   迟到回调只收口自己那一条（按 token + identity），绝不改写别的会话。
 *
 * ## 状态所有权
 * - 事务表、宽度模式与 transient 记账都属于 `sidebar-install-width`（表与命令在那里），
 *   访问记录属于 `sidebar-install-layout`；本模块只经它们的窄命令读写，绝不复制容器。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-install-target")]
 * 装配：真实依赖边为 pure / dom → 本模块 → install-resources。
 */
(function installSidebarInstallTarget(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-target");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    OTHER_RIGHTBAR_WIDTH_RATIO, SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS,
    resolveExpertRightbarWidthRatio, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { currentSessionIdOf, listSnapshot } = DOM;

  /**
   * 构建目标同步面（openTargets / 当前 surface 解析 / 手柄锁重估）。
   *
   * `frame` 是 coordinator 持有的同一份可写框：layout / width / expand 三个句柄在本工厂运行时
   * 已经就位（装配顺序 layout → width → expand → target），因此可以在此解构；跨到 split 句柄的
   * 调用一律经 `frame.target` 在调用时解析。
   */
  function createSidebarInstallTarget(frame) {
    const config = frame.config;
    const ctx = frame.ctx;
    const sessions = frame.sessions;
    const better = frame.better;
    const nativeSidebar = frame.nativeSidebar;
    const layout = frame.layout;
    const width = frame.width;
    const expand = frame.expand;
    // 三个协作面的窄命令按拆分前的同名标识符取回：判定体逐字不变（同一份 frame / 同一批容器）。
    const {
      beginVisit, beginVisitFor, continuityOverlay, flushInstantRestore, readHostActiveSurface,
      releaseTransitionRestore, requestRightbarDragSync, requestSplitTrackSync, rightbarDragLock, surfaceRecords,
    } = layout;
    const {
      activeTabEvidenceOf, compositionReadFacesUnavailable, hasExistingExpertGroupTab, hasOtherRightbarPage,
      nativeSidebarFor, rightbarCompositionEvidenceOf, scheduleCurrentSurfaceExpand, scheduleSurfaceOpen,
    } = expand;
    const {
      applyRightbarWidth, cancelAllSidebarSplits, claimRightbarWidthOwnership, clearRightbarWidthMarks, hostWidthMatchesPluginTarget,
      isWidthActive, isWidthPrepared, recomputeOwnedWidth, recoverRightbarWidth, rightbarOwnershipOf,
      rightbarWidthViewportChanged, setWidthActive, setWidthMode, setWidthPrepared, settleRightbarRecovery,
      widthModeOf,
    } = width;
    const rightbarSplitTransactions = width.splitTransactions;
    const SURFACE_OPEN_DELAY_MS = expand.surfaceOpenDelayMs;
    const widthSurfaceSessionId = () => width.surfaceSessionId();
    /**
     * 同一 sessionId 的 surface 重挂载序号：current 与宿主活跃会话都没变、但宿主读面显示此前已确认的
     * expert-group 变成「明确没有 active tab」时 +1（重挂载边沿，见下面的 openTargets），用来强制开启
     * 一次新访问。持续缺失不会重复 +1，用户手动切到其它 kind 也不会 +1。
     * 计数器由本模块持有（唯一 +1 点）；布局模块只读它的当前值拼访问 key。
     */
    let currentRemountSerial = 0;

    /**
     * 自动打开 Expert Group 页面 + 展开右栏（每次 sessions/Better 通知都调用一次）。
     *
     * 目标只有一个：**当前可见会话**（插件解析出的当前可见会话）。宿主右栏是按 session 懒创建的，
     * 对非当前会话的 scoped open 会被静默 no-op（Better 0.19.1 的 native surface 对未 mint 的
     * 会话就是「openTabIn 存在即返回成功」）。因此这里：
     * 1. 绝不为后台 root/child 预发打开请求——它们成为 current 时自然会拿到属于自己的一次访问；
     * 2. 打开请求不在同步栈里发出，而是 defer 一个宏任务，等宿主把 surface/binding 提交完
     *    （runSurfaceOpen 会复核访问代次、插件解析出的当前可见会话，以及 Better 已提交的活跃会话）；
     * 3. 宿主明确还没提交时只做有限次「等提交」重试，绝不把请求落到旧 binding、也绝不把它
     *    记成已完成；
     * 4. 页面真正落地后才排程 layout.openRightbar(true, false)（同样 defer、同样按访问记账，
     *    成功一次即消费，用户的后续手动关闭在本次访问内不会被覆盖）。
     *
     * 宽度策略：Expert Group 页的右栏宽度固定为视口宽度的 20%（RIGHTBAR_WIDTH_RATIO），
     * 由 applyRightbarWidth(current) 在页面打开之前按 surface 会话写入宿主 layout store；
     * 插件不写第二套宽度状态、不操作 DOM/grid，也不通过 openTab 参数伪造 width。同一会话
     * 的重复通知不重复改写，切换会话时为新会话写它自己的一份（见 widths 的说明）。
     * 注意写入仍在同步栈里执行，必须早于宿主第一次展开。
     *
     * 拖拽手柄锁也在这条访问路径上重估（requestRightbarDragSync）：宿主报告「当前活跃 tab
     * 就是 Expert Group」时锁住 [data-side=rightbar]，切到别的页面立刻交还宿主。
     *
     * 顺序是硬约束：宽度写入（同步）→ 打开页面（deferred）→ 展开右栏（deferred）。宿主
     * ui-sidebar-right 的 RightbarSeat 在右栏 surface 还没挂载时会以
     * syncPresentation({ shown: false }) → layout.closeRightbar() 收尾，任何同步/过早的展开都会
     * 被它立刻关掉。
     *
     * 契约不变：Better Sidebar 可用时由它独占（用户禁用它则不自动打开，也绝不回退 native
     * 注册）；否则走 native（含旧 openTabIn 兼容）。打开失败保持未打开状态等待后续通知。
     */
    const openTargets = () => {
      if (frame.disposed) return;
      // 页面打开最终只服务当前可见 surface；后台 root/child 不会被这里打开。旧实现为了
      // 判断「是否有目标」先枚举所有 session 并逐个解析 root，切换会话时形成 O(S²) 主线程工作。
      // current 已经是唯一实际会被打开的目标，直接读取一次即可保留同样的行为。
      const current = currentSurfaceSessionId();
      const targets = current === null ? [] : [current];
      // hydration 尚未产生任何可打开 surface 时，不得提前改写宿主宽度偏好；
      // 等后续会话通知带来目标后，再在真正打开前写入该会话的 20%。
      if (targets.length === 0) {
        // 「没有当前可见 surface」是一次**访问终止边沿**，绝不能直接 return 绕过 beginVisit：
        // 上一个会话可能还留着待执行的 open/expand timer，以及未消费的抑制句柄
        // （MutationObserver + panel/frame 的内联 transition:none），绕过清理就会永久留在宿主上。
        // 这里用 (null, null) 走一次与普通访问完全相同的收尾路径：取消上一个可见会话的遗留 timer，
        // 并收口它记录上的抑制句柄；key 相同（持续无 current）时是幂等空操作。
        beginVisit(null, null);
        // 同时 flush 全局待恢复任务：终止边沿必须立刻把过渡样式交还宿主，不能等 RAF/250ms
        // fallback。普通 child 切换永远走不到这里（current 非空），所以不会误 flush 正常展开的
        // 恢复窗口。
        flushInstantRestore();
        // 没有可服务的 surface 就没有 Expert Group 页：手柄锁必须跟着交还宿主（这里 current
        // 为 null，重估只会解锁，不会读任何宿主读面）。
        requestRightbarDragSync();
        return;
      }
      if (better) {
        let enabled = true;
        try { enabled = typeof better.isTabEnabled !== "function" || better.isTabEnabled("expert-group") !== false; } catch { enabled = false; }
        if (!enabled || typeof better.openTab !== "function") {
          // Better 被用户禁用（expert-group tab 关掉）或宿主没有 openTab：这是**本次访问的终止边沿**，
          // 不是「什么都没发生」。仍要结束当前访问：取消该会话遗留的 open/expand timer 并收口
          // 未消费的抑制句柄；但绝不写入右栏宽度、不打开/展开右栏（禁用语义与用户右栏状态都不受影响）。
          // 用 (current, null) 作为终止标记：之后 Better 恢复可用时 visit key 会再次变化，
          // 自然开启新访问继续（不会因为终止过就永久停摆）。
          beginVisit(current, null);
          // 同样是终止边沿：立刻 flush 全局待恢复任务（上一次成功展开排下的 RAF/fallback），
          // 不能等到延迟恢复才把 transition:none 交还宿主。
          flushInstantRestore();
          // 插件这次不会打开任何页面：手柄锁按宿主当前的活跃 tab 重估（页面确实还是
          // Expert Group 时保持锁定，用户切到别的页时立刻交还宿主）。
          requestRightbarDragSync();
          return;
        }
      }
      // 宽度写入先于页面打开：Better 被禁用时上面已 return，不会在「DEG 什么都不开」的
      // 情况下改写宿主的宽度偏好；Expert Group 首次展开前仍需先落盘 20%。
      // 当前如果已经是其它右栏页，50% 模式由右栏同步器负责，不能在每次 session 通知时被
      // 这里的「新 surface」分支重新覆盖成 20%。
      // 不在这里提前读取 active()：openTargets 发生在页面提交前，某些宿主的 active() 读面
      // 会影响调度器就绪时序。上一轮同步已经确认的 mode 足以阻止 50% 可调状态被 20%预置覆盖。
      // 跨 pane 已存在其它页时，当前 Expert Group 不能在这里抢先写 20%；同步器会直接
      // 把总右栏初始化到 50%。这里不读 active()，只用 inventory/DOM 的正向存在证据。
      // mode / prepared / active 全部按 sessionId 读取：root-a 的 other / split-pending 绝不是
      // root-b 的现状，不能阻止 root-b 的首次预置。
      const otherPagePresent = hasOtherRightbarPage(current);
      // 只按**本会话**自己的在途事务判定：别的 session 的 split-pending 与 root-b 的首次预置无关。
      const splitPending = rightbarSplitTransactions.has(current);
      const expertPageCanOwnWidth = splitPending !== true
        && widthModeOf(current) !== "other" && otherPagePresent !== true;
      // 宿主那份全局宽度当前归谁（宽度命令面的唯一标量，命令面是唯一写点）：这里读一次，
      // 与拆分前的直接读取同义——同一轮同步里的后续判定都基于这份快照。
      const rightbarWidthSurfaceSessionId = widthSurfaceSessionId();
      const widthSurfaceChanged = rightbarWidthSurfaceSessionId !== current;
      const shouldPrepareWidth = expertPageCanOwnWidth && (widthSurfaceChanged
        || isWidthActive(current)
        || !width.hasWidthTarget(current));
      if (shouldPrepareWidth && applyRightbarWidth(current, resolveExpertRightbarWidthRatio(), widthSurfaceChanged)) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        // 只有本次确实写入才标记 prepared；把 Map 里的旧目标当作“刚写过”会漏掉
        // 「其它分页改宽 → 返回 Expert Group」这条必须强制恢复 20% 的进入边沿。
        setWidthPrepared(current, true);
      }
      // 宿主真正承载右栏的会话（Better 证据优先）；两者都没读到时按 current 兜底，
      // 但「有 API 却读不到活跃会话」会被记成 null，也就是「尚未提交」，只等通知/有限重试。
      const host = readHostActiveSurface();
      const observedActive = host.available ? host.sessionId : current;
      // 同一 sessionId 的 surface 重挂载：宿主把某个此前已确认 expert-group 的目标变成
      // 「明确没有 active tab」（seat 卸载 / 布局被重置）时，开一次新的访问代次重新确保。
      // 只在「已确认 → 明确缺失」这条边沿触发：
      // - 持续缺失不会重复触发（重置后 commitState 回到 unknown）；
      // - active 是别的 kind（用户手动切走 tab）不算重挂载，也不在普通通知里抢回用户 tab；
      // - 读面缺失或抛错时是 unknown，不做任何推断（旧 native / 旧 Better 语义不变）。
      if (current !== null) {
        const previousRecord = surfaceRecords.get(current);
        if (previousRecord !== undefined
          && previousRecord.commitState === "confirmed"
          && activeTabEvidenceOf(current) === "missing") {
          currentRemountSerial += 1;
          // 宿主明确卸载/关掉了这个 surface：右栏这次展示生命周期结束，下一次访问允许重新展开
          // 一次（这也是用户手动关闭右栏后唯一的重开路径）。复位必须就地进行：展开 timer 与失败
          // 预算都只属于旧生命周期，绝不能靠随后 beginVisit 的代次变化兜底——旧 timer 占着槽位时
          // 新访问的 scheduleRightbarExpand 会提前返回 false，重挂载后就再也调不到 openRightbar。
          expand.endPresentation(current);
        }
      }
      // 访问代次：宿主活跃 surface、当前可见会话或重挂载序号变化 = 一次新访问（重复通知不改变
      // 代次，因此不会重置本次访问的打开/展开预算）。
      const epoch = beginVisit(current, observedActive);
      if (current !== null) {
        const record = beginVisitFor(current, epoch);
        // 视觉连续性遮罩（不是动画抑制）：真实时序是 openTargets(current=child) → 旧 panel removed
        // → 新 panel added(collapsed) → runSurfaceOpen → 新 panel open。也就是说旧 panel 在
        // scheduleSurfaceOpen() 的 deferred 打开轮之前就已经被 DSH 的 session-key 重挂载删掉了，
        // 等到 runSurfaceOpen 再 clone 就太晚（旧节点已不存在）。因此必须在这里、在旧 panel 仍然
        // 存在的那一刻抢拍，正好覆盖 openTargets → panel removed 的窗口。
        // 只对「后续 surface 切换」启用：isPresented 表示本生命周期已经展示过右栏，
        // isPersisted 表示宿主上确实呈现过（含本生命周期内刚成功的那次）。
        // 首次无持久标记、首次自动打开、用户手动开关都不满足条件，因此不会创建遮罩。
        // 同一访问（同一 epoch 的重复通知）只创建一次：record 上已有句柄时直接复用。
        if (expand.isPresented() === true && expand.isPersisted() === true
          && typeof record.continuityRelease !== "function") {
          record.continuityRelease = continuityOverlay.capture();
        }
        // 只为「当前可见会话」的本次访问排队打开：绝不预发后台目标的请求（宿主对未挂载会话
        // 的 scoped open 会静默 no-op，却被当成已完成，于是目标被永久跳过）。
        scheduleSurfaceOpen(current, epoch, SURFACE_OPEN_DELAY_MS);
      }
      // 展开同样只排队（defer 到宿主提交之后），并且要求本次访问的页面已经落地。
      scheduleCurrentSurfaceExpand();
      // 最后按宿主当前提交的活跃 tab 重估手柄锁：这条通知路径覆盖会话切换与 Better 设置变化；
      // 页面还没落地时证据是 missing/unknown —— missing 会解锁，unknown 保持现状而不误锁别页。
      // 刻意排在这里（而不是函数开头）：宿主读面的调用顺序与打开流程保持原样，绝不提前读面。
      requestRightbarDragSync();
    };

    /**
     * 右栏拖拽手柄锁的重估实现（在 coordinator 注册入口之前接线，早于 subscribeSessions 的首次通知）。
     *
     * 判定只用宿主公开读面：**当前可见会话**的活跃 tab 必须是 Expert Group。
     * - "confirmed"：不锁 [data-side=rightbar]（票据 18：用户必须能拖拽并记住宽度）；
     *   只有首次分栏事务在途时才锁，事务提交/取消后立刻解锁；
     * - "other" / "missing"：用户在别的右侧分页或没有活跃 tab → 立刻解锁并还原样式；
     * - "unknown"（旧宿主没有 active() 读面等）：无法证明当前页就是 Expert Group，
     *   按兼容处理**不解锁也不加锁**——保持上一次已确认的状态，绝不误伤其它页面。
     *
     * 只用 currentSurfaceSessionId() 解析出的当前会话：后台 root/child 的活跃 tab 与用户
     * 眼前这一页无关，拿它决定手柄锁会锁错页面。
     */
    const rightbarDragSyncImpl = () => {
      // 分栏配比与手柄锁共用这条同步链路（面板 observer / 2.5 秒轮询 / visibilitychange 与
      // sessions 通知都会走到这里），因此宿主把第二个 pane 渲染出来、或用户把子代理 pane 关掉
      // 之后，配比会在同一轮里被补上或还原，不为它另挂 observer、也不读取任何额外宿主状态。
      // 刻意排在下面的 early return 之前：这些分支全都不代表「pane 组成没变」。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响宽度与手柄的判定。 */ }
      const current = currentSurfaceSessionId();
      if (current === null) {
        // 没有任何可见 surface：所有在途事务都不可能再提交，逐条收口（每条只清理自己所属会话的
        // transient 记账）；统一回滚失败由后续同步重试。
        cancelAllSidebarSplits("session-missing");
        // 没有可见 surface：归属会话的 transient 记账一并失效（它描述的是「宿主那份宽度属于
        // 该会话」时的状态，不能留给下一个会话当现状）。per-session 的目标值不受影响，该会话
        // 下次被激活时会按自己的目标重估。
        clearRightbarWidthMarks(widthSurfaceSessionId());
        rightbarDragLock.setLocked(false);
        return;
      }
      // 可见 surface 已切到**另一会话**：别会话的在途事务（可能有多个）已经不可能由用户继续完成，
      // 只收口它们本身（deadline + 各自的 transient 记账）——绝不回滚宽度、绝不改写当前会话的
      // active/prepared/mode，也不按旧会话去锁手柄；宿主那份全局宽度交给下面这轮针对 current 的
      // 同步自行判定 20%/50%。本会话自己的事务不进这个循环，因此不会被别的会话的同步收口。
      for (const [sessionId, transaction] of width.splitTransactionsList()) {
        if (sessionId === current) continue;
        try { frame.target.cancelSidebarSplit(transaction.token, { reason: "session-switched" }); } catch { /* 后续同步仍会重估。 */ }
      }
      if (rightbarSplitTransactions.has(current)) {
        // 首次分栏事务期间**锁住宿主手柄**（票据 18）：这段窗口里宽度由事务独占（临时 50%），
        // 用户拖拽只会和事务的“split → openResource → 提交证据 → 收口”竞争同一个全局宽度。
        // 事务提交/取消后立刻解锁（见 commitSidebarSplit / cancelSidebarSplit），因此锁只覆盖
        // 这一次过渡；guide-only 不足以结算，deadline 会兜底收口。
        // 只对本会话成立：别的会话的在途事务不阻塞本会话的宽度/手柄判定。
        rightbarDragLock.setLocked(true);
        return;
      }
      const activeEvidence = activeTabEvidenceOf(current);
      let evidence = rightbarCompositionEvidenceOf(current, activeEvidence);
      if (evidence === "unknown" && activeEvidence === "confirmed" && compositionReadFacesUnavailable()) {
        // 旧宿主没有 inventory/DOM 组合读面时，active() 仍是宽度模式与手柄锁的唯一兼容证据。
        // 注意：这条恢复分支只服务宽度/手柄模式；split 事务入口另有更窄的局部例外
        // （isActiveOnlySplitCompatible），那个例外必须单独判定，绝不与这里共用 fail-open。
        evidence = "confirmed";
      }
      if (evidence === "unknown") {
        // 组成不可判定 → 绝不改手柄锁、也绝不臆测模式（fail-closed 语义不变）；但本会话
        // **已经接管过**的宽度模式与组成读面无关，视口变了（或宿主重启后夺回了那份 px）就必须按
        // 同一比例重算，否则窗口最大化后宿主会一直保留旧视口下的 px 偏好（见 recomputeOwnedWidth）。
        recomputeOwnedWidth(current);
        return;
      }
      if (evidence === "confirmed") {
        // openTargets 已在同一同步栈为这个 surface 成功预置过偏好比例时，只消费 prepared 标记；
        // 否则这是从其它可调分页重新进入 Expert Group，必须强制恢复偏好比例。只有宽度已经成功
        // 落到宿主（本轮 prepared 或此前 active）才允许提交 expert 模式。
        // prepared / active 只按当前 sessionId 读取：别的会话的记账绝不参与判定。
        const prepared = isWidthPrepared(current);
        const alreadyActive = isWidthActive(current);
        let widthReady = prepared || alreadyActive;
        if (!widthReady) {
          // 归属由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
          widthReady = applyRightbarWidth(current, resolveExpertRightbarWidthRatio(), true);
        } else {
          const viewportChanged = rightbarWidthViewportChanged(current) === true;
          // 一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
          const ownership = rightbarOwnershipOf(current);
          // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
          settleRightbarRecovery(current, ownership);
          const hostReclaimed = ownership !== null && ownership.differs === true;
          if (viewportChanged || hostReclaimed) {
            // 两条重新写入边沿，缺一不可：
            // 1. 窗口最大化 / 全屏 / 拖拽改变了视口：20% 是**视口比例**，必须按新视口重新换算并写入，
            //    否则右栏会一直停在最大化之前那份旧像素宽度上（1600 写 320，3200 仍是 320）；
            // 2. **宿主夺回了那份 px**：DSH 重启后宿主从持久化布局恢复它自己那份旧值，而这份恢复
            //    晚于插件的首次写入（视口一直没变）。Expert Group 页的宽度是插件的持久化偏好，
            //    因此「面板宽度不再等于插件 target」就是宿主夺回所有权的可验证证据，必须把偏好
            //    重新写回去，否则用户看到的是「重启后右栏从 640 缩到 320」。
            // 两条判据都为假时一个字节都不写：同一视口的重复通知仍然保持原有去重语义。
            //
            // 写入许可与 recomputeOwnedWidth（unknown 分支）**共用**同一份有界预算：视口变化不再是
            // 绕过预算的独立边沿——取整后仍是同一个 target 的视口变化（3200 → 3201 → 3202 都是 640）
            // 不是新的一次 mismatch 事件；只有预期 target 真的改变才重新获得预算。宿主持续 clamp 或
            // React 延迟提交时「实际宽度 != target」会一直为真，否则就会与宿主的 clamp 无限拉锯。
            //
            // 这条边沿同样要过证据关：面板宽度读不出来（ownership 为 null）时 recoverRightbarWidth
            // 直接 fail-closed——即使视口真的变了，这里也一个字节都不写（读面不可用期间没有任何证据
            // 说明面板宽度偏离了 target，写下去就是无据改写宿主那份**全局**宽度偏好）。
            recoverRightbarWidth(current, resolveExpertRightbarWidthRatio(), ownership);
          }
        }
        setWidthPrepared(current, false);
        setWidthActive(current, widthReady);
        setWidthMode(current, widthReady ? "expert" : null);
        // Expert Group 页默认**不锁**宿主手柄（票据 18）：右栏宽度必须允许用户拖拽，
        // 偏好由面板自己的拖拽手柄写入 localStorage（见 applyRightbarWidthRatio）。
        // 只有首次分栏事务那一小段窗口才锁（见上面的 hasSplitTransaction 分支）。
        rightbarDragLock.setLocked(false);
        return;
      }
      if (evidence === "missing") {
        // 没有 active tab 不等于存在其它页：清理当前会话已确认的模式并交还手柄，但不猜测性写入 50%。
        clearRightbarWidthMarks(current);
        rightbarDragLock.setLocked(false);
        return;
      }
      // 第一次确认任一 pane 存在其它页时把总右栏预置到 50%；随后只交还手柄，用户拖动出的
      // 宽度由宿主持有。重复通知不会重写 50%（只按当前会话的 other 模式去重），宽度桥接失败
      // 则保持模式未提交，便于以后重试。
      const otherModeMissing = widthModeOf(current) !== "other";
      // 「首次确认其它页」这条边沿无条件预置 50%；视口变化触发的重算则**必须先证明宿主宽度所有权**
      // （面板实际宽度仍等于插件上次写入的 target）。50% 是可调状态，用户在其它右侧分页上拖出的
      // 宽度由宿主持有，仅凭「视口变了」就重算会直接覆盖用户的拖拽结果——这与 unknown 分支里的
      // 同一判据（见 recomputeOwnedWidth）保持完全一致的口径。
      const otherNeedsRecompute = otherModeMissing
        || (rightbarWidthViewportChanged(current) && hostWidthMatchesPluginTarget(current));
      if (otherNeedsRecompute) {
        // 写入失败时只在「首次确认其它页」这条边沿把模式置回未提交，视口重算失败不得抹掉
        // 已经确认的 other 模式。
        if (applyRightbarWidth(current, OTHER_RIGHTBAR_WIDTH_RATIO, true)) {
          setWidthMode(current, "other");
        } else if (otherModeMissing) {
          setWidthMode(current, null);
        }
      }
      setWidthPrepared(current, false);
      setWidthActive(current, false);
      rightbarDragLock.setLocked(false);
    };

    /**
     * 当前 surface 会话 id（由 currentSessionIdOf 兼容解析），不解析成 root。
     *
     * global `sidebarRight.openTab(kind, options)` 没有会话参数：它只会画在「已挂载
     * 会话」上，也就是当前 surface。当前视图可能正是一个 child 子代理会话，此时它的 root
     * 反而是「非当前目标」——用 global 去开它会画到 child 的 surface 上，也会错误地把该
     * root 记成已打开。因此这里返回原始 current，只允许与它完全相同的目标借用 global
     * 接口；解析不出当前会话时返回 null，任何目标都不算当前 surface，全部改走按会话定位。
     */
    const currentSurfaceSessionId = () => currentSessionIdOf(listSnapshot({ ...config, sessions }, ctx));
    /**
     * 打开某个 surface 会话的原生 Expert Group 页面；返回 false 表示当前 DSH 无法按该
     * 会话定位页面（保持未打开状态，由后续会话通知重试）。
     *
     * 顺序固定：
     * 1. 按会话解析出的 session-scoped `sidebarRight.openTab(kind, options)`——公开
     *    接口，作用域实例把该 surface 会话带进打开请求，是唯一能服务任意 surface 的
     *    正规路径（root 与 child 同样适用）；
     * 2. 根级 `sidebarRight.openTab(kind, options)`——同一公开接口，但作用在已挂载
     *    会话上，所以**只有与当前 surface 完全相同的目标**才允许调用；用它去开别的
     *    surface 会把页面画到错误的会话上，也会错误地把那些目标当成已打开；
     * 3. 旧 `openTabIn(sessionId, kind, options)`——它**不属于** ISidebarRight，只是
     *    Tab domain 的按会话内部路径，是旧 DSH 里唯一能按任意会话定位的兼容回退。
     */
    const openNativeTab = (target) => {
      const scopedSidebar = nativeSidebarFor(target);
      if (typeof scopedSidebar?.openTab === "function") {
        scopedSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (target === currentSurfaceSessionId() && typeof nativeSidebar?.openTab === "function") {
        nativeSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (typeof nativeSidebar?.openTabIn === "function") {
        nativeSidebar.openTabIn(target, "expert-group", { revealIfOpened: true });
        return true;
      }
      return false;
    };
    // 接线：布局模块的 requestRightbarDragSync 从这里取真实实现（早于任何注册通知）。
    layout.setDragSyncImpl(rightbarDragSyncImpl);

    return Object.freeze({
      currentSurfaceSessionId,
      openNativeTab,
      resetRemountSerial: () => { currentRemountSerial = 0; },
      remountSerial: () => currentRemountSerial,
      openTargets,
      rightbarDragSyncImpl,
    });
  }

  /**
   * 首次从 Expert Group-only pane 分栏的协调器。
   *
   * split() 在右栏仅 20% 时可能返回 undefined；事务在调用前强制写入 50%，暂时交还拖拽手柄，
   * 并把 pane、openResource、openTabs 与 DOM 证据拆成几个阶段。只有目标 subagentchat tab
   * 已经位于 split 返回的 pane 才提交 other 模式；失败时若只留下 guide pane，保留 50% 供用户调整。
   * 入口的 composition 判定见 isActiveOnlySplitCompatible：它只放宽「是否开始本次事务」，
   * 事务本身（paneId 回执、preferNewPane:false、提交证据、deadline、取消回滚）逐字不变。
   *
   * 事务表与 transient 记账都属于 `sidebar-install-width`；本工厂只提供 begin/mark/commit/cancel
   * 四个命令，并把它们挂进 target 句柄（coordinator 与外层同步都经这个句柄调用）。
   */
  function createSidebarSplitTransactions(frame) {
    const layout = frame.layout;
    const width = frame.width;
    const expand = frame.expand;
    // 与目标同步面同一批协作命令（同一个 frame/容器）：按拆分前同名标识符取回。
    const { rightbarDragLock } = layout;
    const {
      applyRightbarWidth, claimRightbarWidthOwnership, clearRightbarWidthMarks, clearSidebarSplitDeadline,
      isWidthActive, releaseSidebarSplitTransaction, setWidthActive, setWidthMode, setWidthPrepared,
      transactionOf, widthModeOf,
    } = width;
    const { activeTabEvidenceOf, compositionReadFacesUnavailable, rightbarCompositionEvidenceOf } = expand;
    const rightbarSplitTransactions = width.splitTransactions;
    const currentSurfaceSessionIdOf = () => frame.target.currentSurfaceSessionId();

    /**
     * split 入口的**窄口径 active-only 兼容例外**（本文件唯一一处；rightbarCompositionEvidenceOf
     * 的结论本身不变）。
     *
     * 为什么需要它：真实 DSH 重启后首次进入 Expert Group 页时，宿主只提供 active()——
     * sidebarRight.openTabs 这个公开 inventory 与 dockkit 的右栏 DOM 读面都还不存在（或读不到）。
     * rightbarCompositionEvidenceOf 对这种 active-only 形状保守返回 "unknown"，而 beginSidebarSplit
     * 原本把 unknown 当 fail-closed，于是行尾橙色 >> 的点击在调用 split()/openResource() 之前就
     * 静默中止：宿主上什么都没发生，用户看到的就是「点了没反应」。
     *
     * 为什么只在这里放开：这条例外只作用于「会创建新 pane」的 split 入口，并且要求三个条件同时
     * 成立，缺一不可：
     * 1. active() 明确就是 Expert Group（other/missing/unknown 一律不放行，绝不放开错误状态）；
     * 2. 目标就是当前可见 surface（否则新 pane 会落到后台会话的布局上）；
     * 3. openTabs inventory 与右栏 DOM **两个组合读面都不可用**（任意一面返回非 null 就说明宿主
     *    能给出真实组成证据，此时必须回到 fail-closed，由 rightbarCompositionEvidenceOf 说话）。
     * 读面不可用（null）本身不代表「没有其它页」，只代表宿主没有这个读面；在这种宿主上 active()
     * 就是唯一的公开组成证据，且既有宽度策略早已按同口径采信它。新宿主只要有 inventory 或 DOM，
     * 条件 3 立刻不成立，行为与修复前完全一致。
     *
     * 边界：只放宽「是否开始本次事务」。事务内部的临时 50% → split → paneId → openResource
     * （preferNewPane:false）→ 目标 tab 的 inventory+DOM 提交证据 → 15 秒 deadline → 取消回滚
     * 全部逻辑逐字不变；读面一直不可用时同样由 deadline 收口回 20%。
     */
    const isActiveOnlySplitCompatible = (sessionId, activeEvidence) => {
      if (activeEvidence !== "confirmed") return false;
      try { if (currentSurfaceSessionIdOf() !== sessionId) return false; } catch { return false; }
      return compositionReadFacesUnavailable();
    };

    const beginSidebarSplit = (details) => {
      if (frame.disposed) return { busy: true };
      const input = details !== null && typeof details === "object" ? details : {};
      const sessionId = text(input.sessionId, null);
      if (sessionId === null || currentSurfaceSessionIdOf() !== sessionId) return null;
      // 防重入只针对**同一个 session**：本会话已有在途事务时拒绝第二次 split，绝不产生竞争 pane；
      // 别的 session 的在途事务与本次请求无关，不得把点击挡成 busy（一个卡住的会话不再冻结全部会话）。
      if (rightbarSplitTransactions.has(sessionId)) return { busy: true };
      // split 只允许从已确认的 Expert Group-only composition 开始。active() 缺失、当前
      // 已是其它页或 openTabs/DOM 给出其它 pane 证据时都 fail-closed，避免把新 pane
      // 叠到一个已经可调的用户布局上；唯一例外是上面那个窄口径的 active-only 兼容分支。
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition !== "confirmed"
        && frame.target.isActiveOnlySplitCompatible(sessionId, activeEvidence) !== true) return null;
      const prepared = applyRightbarWidth(sessionId, OTHER_RIGHTBAR_WIDTH_RATIO, true);
      if (prepared !== true) return null;
      const token = {};
      const transaction = {
        token,
        sessionId,
        rootSessionId: text(input.rootSessionId, null),
        key: text(input.key, null),
        resourceAddress: text(input.resourceAddress, null),
        paneId: null,
        resourceIssued: false,
        // 只捕获**本会话**的旧模式/活跃记账：取消时要还原的也是这个会话自己的状态，
        // 别的会话的记账既不是它的前态、也不能被它写回去。
        previousMode: widthModeOf(sessionId),
        previousActive: isWidthActive(sessionId),
        deadlineTimer: null,
      };
      // 先入表再写宽度：deadline / commit / cancel 都按这张表反查，表里没有的事务一律不再被结算。
      rightbarSplitTransactions.set(sessionId, transaction);
      // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
      clearRightbarWidthMarks(sessionId);
      setWidthMode(sessionId, "split-pending");
      // 事务一开始就锁住宿主手柄（票据 18）：这一次过渡里宽度由插件独占（临时 50%），
      // 用户拖拽会和 split/openResource 的提交证据竞争同一个全局宽度。提交/取消后立刻解锁。
      try { rightbarDragLock.setLocked(true); } catch { /* 锁定失败不阻断公开 split；同步会继续重估。 */ }
      try {
        transaction.deadlineTimer = globalThis.setTimeout(() => {
          // 迟到的 deadline 只收口**仍然在途的自己那一条**：已被 commit/cancel 收口的 token 查不到
          // 事务，什么都不做，绝不误伤同会话后来居上的新事务或别的会话。
          if (transactionOf(token) !== null) {
            try { frame.target.cancelSidebarSplit(token, { reason: "deadline" }); } catch { /* deadline 仍须保持有界。 */ }
          }
        }, SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS);
      } catch {
        // 宿主若没有可用的 timer，不能留下永久 50%/解锁状态；直接走同一取消路径。
        frame.target.cancelSidebarSplit(token, { reason: "deadline-unavailable" });
        return null;
      }
      return { token };
    };

    const markSidebarSplitPane = (token, paneId) => {
      const transaction = transactionOf(token);
      if (transaction === null || typeof paneId !== "string" || paneId.trim() === "") return false;
      transaction.paneId = paneId;
      return true;
    };

    const markSidebarSplitOpen = (token) => {
      const transaction = transactionOf(token);
      if (transaction === null || transaction.paneId === null) return false;
      transaction.resourceIssued = true;
      return true;
    };

    const commitSidebarSplit = (token, evidence) => {
      const transaction = transactionOf(token);
      const observed = evidence !== null && typeof evidence === "object" ? evidence : {};
      if (transaction === null
        || transaction.resourceIssued !== true
        || transaction.paneId === null
        || text(observed.paneId, null) !== transaction.paneId
        || text(observed.tabId, null) === null) return false;
      clearSidebarSplitDeadline(transaction);
      releaseSidebarSplitTransaction(transaction);
      // 迟到提交边界：只有事务所属会话**仍是当前可见 surface** 时，才允许把宿主那份全局宽度
      // 的归属迁移到它名下。用户已经切到别的会话时只收口本事务自己的 transient 记账——
      // 绝不动当前会话的宽度归属、模式、手柄，否则一个后台面板的迟到 observer 回调就会
      // 把用户眼前的会话改回旧会话的布局。
      let current = null;
      try { current = currentSurfaceSessionIdOf(); } catch { current = null; }
      if (current !== transaction.sessionId) {
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      // 提交后宿主那份宽度归本会话的 other 组成所有（本轮没有写宽度，因此显式接管归属）。
      claimRightbarWidthOwnership(transaction.sessionId);
      clearRightbarWidthMarks(transaction.sessionId);
      setWidthMode(transaction.sessionId, "other");
      try { rightbarDragLock.setLocked(false); } catch { /* 提交后的手柄必须可调，失败由后续同步重试。 */ }
      return true;
    };

    /** 取消 / 中止一次分栏事务：只收口自己那一条，并按可见 surface 归属决定要不要回滚宽度。 */
    function cancelSidebarSplit(token, details) {
      const transaction = transactionOf(token);
      if (transaction === null) return false;
      clearSidebarSplitDeadline(transaction);
      // 只移除自己那一条：同会话后来居上的新事务、以及别的会话的在途事务都不受影响。
      releaseSidebarSplitTransaction(transaction);
      const current = currentSurfaceSessionIdOf();
      if (current !== transaction.sessionId) {
        if (current === null) {
          // 终止边沿（没有任何可见 surface 接手）：宿主那份全局宽度只能由这里收口，
          // 否则会长期停留在事务期间的临时 50%。恢复的是旧事务会话自己的 20%。
          const restored = applyRightbarWidth(transaction.sessionId, resolveExpertRightbarWidthRatio(), true);
          claimRightbarWidthOwnership(transaction.sessionId);
          setWidthPrepared(transaction.sessionId, restored === true);
          setWidthActive(transaction.sessionId, restored === true);
          setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
          // 事务收口（终止边沿）：锁必须立刻交还宿主；恢复宽度成功与否都由后续同步重估。
          try { rightbarDragLock.setLocked(false); } catch { /* 后续同步重估。 */ }
          return true;
        }
        // 可见 surface 已切到**另一会话**：只清理这个被切走的事务和它自己的 transient 记账，
        // 绝不回滚宽度、绝不改写当前会话的 active/prepared/mode，也不按旧会话去锁手柄——宿主
        // 那份全局宽度交给随后针对 current 的同步自行判定 20%/50%。
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(transaction.sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(transaction.sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition === "other") {
        // split 已留下一个真实的其它 pane（通常是 seeded guide）：保留 50%，继续允许用户调整。
        // 本轮没有写宽度，因此显式接管归属（旧会话的 transient 记账随之失效）。
        claimRightbarWidthOwnership(transaction.sessionId);
        clearRightbarWidthMarks(transaction.sessionId);
        setWidthMode(transaction.sessionId, "other");
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步仍会重估。 */ }
        return true;
      }
      const shouldRestoreExpert = transaction.previousMode === "expert" || composition === "confirmed";
      if (shouldRestoreExpert) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        const restored = applyRightbarWidth(transaction.sessionId, resolveExpertRightbarWidthRatio(), true);
        setWidthPrepared(transaction.sessionId, restored === true);
        setWidthActive(transaction.sessionId, restored === true);
        setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
        // 事务已收口：解锁，用户重新获得拖拽能力（偏好写入由面板手柄负责）。
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步重估。 */ }
      } else {
        // 还原的只是本会话自己的前态（别的会话的记账与它无关）。
        setWidthPrepared(transaction.sessionId, false);
        setWidthActive(transaction.sessionId, transaction.previousActive === true);
        setWidthMode(transaction.sessionId, transaction.previousMode === "other" ? "other" : null);
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步重估。 */ }
      }
      return true;
    }

    return Object.freeze({
      beginSidebarSplit,
      cancelSidebarSplit,
      isActiveOnlySplitCompatible,
      commitSidebarSplit,
      markSidebarSplitOpen,
      markSidebarSplitPane,
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarInstallTarget, createSidebarSplitTransactions });
})(globalThis);
