/**
 * 客户端侧栏 · install 展开与打开（R7 票据 25 / sidebar-install-expand）
 *
 * ## 职责边界
 * 本模块承接「右栏打开 / 展开」这条异步链路的两段，二者共用同一套访问代次校验：
 * 1. **展开面**（`createRightbarExpand`）：展示生命周期记账（rightbarPresented /
 *    rightbarPresentedPersisted）、每会话的延迟展开与失败预算、`layout.openRightbar` 调用；
 * 2. **打开面**（`createSurfaceOpen`）：右栏组成读面（openTabs inventory + 右栏 DOM）、
 *    跨 pane「页面已存在」判定、active() 证据、延迟打开与重试。
 *
 * ## 关键语义（逐条保留，不得放宽）
 * - 顺序硬约束：宽度写入（同步）→ 打开页面（deferred）→ 展开右栏（deferred）；
 *   同一同步栈里先展开会被宿主 RightbarSeat 的 `shown: false` 报文立刻关掉。
 * - 只服务**当前可见会话**：宿主右栏 surface 按 session 懒创建，对非当前会话的 scoped open 会
 *   被静默 no-op，却被记成「已打开」。
 * - 读面 fail-closed：inventory / DOM 读不到时绝不把「读不到」当成「不存在」，也绝不当成「已存在」。
 * - dispose 后不得再碰宿主 layout：所有定时器都进本模块的待执行表，由 coordinator 的 dispose
 *   一次性取消（cancelAllRightbarExpands / cancelAllSurfaceOpens）。
 *
 * ## 状态所有权
 * - `rightbarExpandTimers` / `rightbarExpandFailures` / `surfaceOpenTimers` 与两个 presented
 *   标记都由本模块创建并持有；访问记录（surfaceRecords）属于 `sidebar-install-layout`，
 *   这里只经 `frame.layout` 的窄命令读写，绝不复制。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-install-expand")]
 * 装配：真实依赖边为 pure / dom → 本模块 → install-resources。
 */
(function installSidebarInstallExpand(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-expand");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    EXPERT_GROUP_TAB_IDS, RIGHTBAR_PANEL_SELECTOR, RIGHTBAR_TAB_SELECTOR,
    isGeneratedExpertGroupTabId, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { methodOf, rightbarPanelForSession } = DOM;

  const RIGHTBAR_EXPAND_DELAY_MS = 0; // 至少一个宏任务：排到宿主本次提交（surface/seat）之后
  const RIGHTBAR_EXPAND_RETRY_MS = 250; // 调用抛错后的短重试间隔
  const RIGHTBAR_EXPAND_MAX_ATTEMPTS = 3; // 每个 surface 的调用尝试上限（含自动重试）
  /** 每次访问最多发出的打开请求次数（首次 + 通知/定时器驱动的有界重试）。 */
  const MAX_SURFACE_OPEN_ATTEMPTS = 3;
  /** 每次访问内自动定时重试的上限（其余重试机会由后续通知驱动，同样受上面的总次数约束）。 */
  const MAX_SURFACE_OPEN_RETRIES = 1;
  /** 打开请求的 defer 延迟：至少一个宏任务，排在宿主本次提交（surface/seat/binding）之后。 */
  const SURFACE_OPEN_DELAY_MS = 0;
  /** 打开失败后的短重试间隔（timer 纳入 dispose 清理）。 */
  const SURFACE_OPEN_RETRY_MS = 250;
  /** 「等宿主提交活跃会话」的短重试上限与间隔：通知先到、binding 稍后提交时靠它兜住。 */
  const MAX_READINESS_RETRIES = 3;
  const HOST_COMMIT_RETRY_MS = 250;

  /**
   * 「右栏此前已经展示过」的持久标记（跨浏览器刷新）。
   *
   * 症状：Ctrl+F5 / 重新打开浏览器后，第一次在主代理与子代理之间切换又会播放一次右栏展开动画。
   * 根因：rightbarPresented 与 rightbarWidths 一样都是 install 生命周期的内存变量，刷新后归零；
   * 而刷新后宿主 layout store 的 rightbarShown 也回到 false，DEG 必须继续调用
   * layout.openRightbar(true, false)（跳过调用右栏就可能不显示），于是这次调用又带出一次过渡动画。
   *
   * 因此这里把「曾经成功展示过右栏」持久化到 localStorage（带版本号的键）：
   * - 只有 layout.openRightbar 调用成功后才写入；
   * - 读取失败、写入失败（隐私模式、配额、storage 被禁用、无 DOM）都静默回退为「没有标记」，
   *   也就是刷新后仍会正常打开，只是这次会播放一次动画——绝不把异常带出插件；
   * - 标记只影响「这次打开要不要动画」，绝不用于跳过 openRightbar 调用。
   */
  const RIGHTBAR_PRESENTED_KEY = "dsh-expert-group:rightbar-presented:v1";
  /** 安全读持久标记：任何探测/读取异常都按「没有标记」处理。 */
  const readPersistedRightbarPresented = () => {
    try {
      const storage = globalThis.localStorage;
      if (!storage || typeof storage.getItem !== "function") return false;
      return storage.getItem(RIGHTBAR_PRESENTED_KEY) === "1";
    } catch { return false; }
  }
  /** 安全写持久标记：写入失败只影响「下次刷新要不要动画」，绝不影响本次打开。 */
  const persistRightbarPresented = () => {
    try {
      const storage = globalThis.localStorage;
      if (!storage || typeof storage.setItem !== "function") return false;
      storage.setItem(RIGHTBAR_PRESENTED_KEY, "1");
      return true;
    } catch { return false; }
  }

  /**
   * 自动展开右侧栏：按 surface 会话隔离 + 异步延迟执行。
   *
   * 两次实测反馈决定了这里的两个硬约束：
   * 1. 「新会话右栏偶尔短暂弹出又收回，必须 Ctrl+F5」——宿主 ui-sidebar-right 的
   *    RightbarSeat 用 syncPresentation({ shown: false }) → layout.closeRightbar() 上报
   *    「这个 surface 还没展开」，而宿主右栏 surface 的 expanded 状态是按 sessionId 隔离、
   *    由页面打开（openTab → planSetExpanded(true)）才置位的。在同一同步栈里紧跟页面打开
   *    调 layout.openRightbar，会赶在宿主完成本次提交（surface 建立、seat 就位）之前，
   *    随后被 seat 的「未展开」报文反手关掉——表现为闪一下又收回。因此展开必须 defer 到
   *    宿主提交之后：这里只安排一个异步回调，回调里才真正调用宿主公开契约
   *    ctx.layout.openRightbar(true, false)。
   * 2. 「点进子代理会话后右栏不展开」——child 是另一个 sessionId，有自己的 surface 与
   *    expanded 状态；用「整个 install 只展开一次」的全局布尔值管理，child 永远拿不到
   *    自己的机会。因此逐次访问的记账按 sessionId 隔离。
   *    （注意：上面那条历史结论针对的是「永不复位的整个 install 布尔值」；下面新增的
   *    rightbarPresented 记的是**右栏这份全局展示**，宿主明确报告 surface 没了就会复位，
   *    所以它既不会让 child 永远拿不到机会，也不会在切换 child 时重复展开。）
   *
   * 记账规则（每个 surface 会话独立 + 一份跨会话的「右栏展示」记账）：
   * - 每个 surface 的每次访问最多展开一次：调用成功即在本访问内消费，同一访问的后续通知
   *   绝不再排（用户此时手动关掉右栏，本次访问不会把它重新拉开）；
   * - 跨会话另记一份 rightbarPresented（右栏展示生命周期）：成功展开过一次后，继续切换到
   *   别的 child 只切换页面/tab 内容（openTab / openTabIn / scoped openTab），绝不再调
   *   layout.openRightbar——否则每进入一个 surface 都会重展开一次，表现为右栏闪烁；
   * - 只有宿主**明确**报告 Expert Group surface 没了（此前已确认的 active tab 变成
   *   「没有 active tab」）才结束这次展示生命周期，下一次访问允许再展开一次；
   * - 调用抛错：记一次失败，最多 RIGHTBAR_EXPAND_MAX_ATTEMPTS 次尝试（含短延迟自动重试），
   *   避免把「布局 store 临时不可用」变成永久失败；
   * - 宿主这一层没有 openRightbar：不消耗机会、也不排自动重试，交给后续通知再试——
   *   服务稍后可用时仍能展开一次，同时不会留下没人消费的定时器。
   *
   * 只对「当前可见 surface」调用（插件解析出的当前可见会话）：右栏是全局的，为后台 root 展开
   * 等于替用户切走当前视图，而页面都没打开就展开只会拉出一个空右栏。
   *
   * 安全边界：layout 服务缺失、Cordis 服务代理读属性即抛错、openRightbar 调用抛错、
   * 调度器（setTimeout）本身抛错或被 deferred 回调跨过 dispose，全部静默吞掉。自动展开
   * 只是锦上添花，绝不能让 Expert Group 页面打不开（页面默认选择仍由 Better openTab /
   * native openNativeTab 完成）。
   */
  function createRightbarExpand(frame) {
    const config = frame.config;
    const layout = frame.layout;
    // 访问记录与收尾命令属于 layout（唯一 owner）；这里按拆分前同名标识符取回，判定体逐字不变。
    const {
      readHostActiveSurface, releaseTransitionRestore, scheduleInstantRestore, suppressRightbarTransition,
      surfaceRecordOf, surfaceRecords,
    } = layout;
    const currentSurfaceSessionIdOf = () => frame.target.currentSurfaceSessionId();
    /** 已排队的异步展开：sessionId → timer handle（同一会话同时只保留一个）。 */
    const rightbarExpandTimers = new Map();
    /**
     * 调用失败次数：sessionId → attempts（只有真的调用过并抛错才累加）。
     * 属于「右栏展示生命周期」的预算：宿主明确报告 surface 没了（见 openTargets 的重挂载
     * 边沿）时整体清零，新生命周期重新拥有完整的尝试次数。
     */
    const rightbarExpandFailures = new Map();
    /**
     * 右栏「展示生命周期」记账（跨 surface 会话共用一份）。
     *
     * 实测症状：从主代理首次切到子代理时右栏首次打开动画正常；首次打开完成后再继续切换不同
     * 子代理，右栏会闪烁。根因与记账范围有关：展开机会原先按「每个 session 的每次访问」记，
     * 每进入一个新 surface 都会再排一次 layout.openRightbar(true, false)，而 DSH 的公开 API
     * 会同步改写右栏展示状态，于是内容切换的同时右栏被反复重展开。
     *
     * 语义修正：右栏是**全局**的一份展示，不是每个 session 一份。成功展开过一次就置位，之后
     * 切换 surface 只切换对应页面/tab 的内容，绝不再调用 layout.openRightbar。
     *
     * 复位条件只有一个（保守、只认宿主的明确证据）：宿主读面显示此前已确认的 expert-group
     * 变成「没有 active tab」（seat 卸载 / 布局重置 / 用户关掉右栏，见 openTargets 的重挂载
     * 边沿）时结束本次展示生命周期——下一次访问既能重新确保页面，也允许再展开一次；同一时刻
     * rightbarExpandFailures 一并清零，展开失败计数绝不跨生命周期继承。
     * 读面缺失或抛错（旧 Better / native 的 unknown）不做任何推断：那时无法区分「用户手动关掉」
     * 与「surface 还在」，一律保持「已展示」语义，绝不重新拉开右栏（尊重用户的显式操作）。
     */
    let rightbarPresented = false;
    /**
     * 「右栏此前已经展示过」的持久标记（含本次 install 生命周期内刚成功展开过的情形）。
     * 与 rightbarPresented 的区别：后者是可被宿主「明确缺失」边沿复位的内存态，前者跨刷新存活，
     * 只决定「这次自动打开是否需要播放动画」，绝不用于跳过 openRightbar 调用。
     */
    let rightbarPresentedPersisted = readPersistedRightbarPresented();

    /** 取消某个会话尚未执行的异步展开（dispose 与「已消费」路径共用）。 */
    const cancelRightbarExpand = (sessionId) => {
      const timer = rightbarExpandTimers.get(sessionId);
      if (timer === undefined) return;
      rightbarExpandTimers.delete(sessionId);
      try {
        // 定时器句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的异步展开：插件卸载后不得再操作宿主 layout。 */
    const cancelAllRightbarExpands = () => {
      for (const sessionId of [...rightbarExpandTimers.keys()]) cancelRightbarExpand(sessionId);
    };

    /**
     * 真正调用宿主动作，返回 ok / unavailable / failed 供调用方记账。
     * 每次调用都重新取一次服务（与宽度预置同一条路径：优先注入的 config.layout，回退可选
     * 服务查找），这样「服务稍后才可用」也能被后续尝试接住。
     */
    const callOpenRightbar = (preparedRestore = null) => {
      // 准备好的抑制句柄来自 runSurfaceOpen()（在 openTab 之前就已生效）；一旦拿不到 layout action，
      // 必须立刻收口，绝不能把 transition:none 留在宿主上。
      const releasePrepared = () => {
        if (typeof preparedRestore !== "function") return;
        try { preparedRestore(); } catch { /* 恢复失败不能阻断其它收尾。 */ }
      };
      const layout = config.layout || frame.optionalService("layout");
      let openRightbar = null;
      try {
        const candidate = layout?.openRightbar;
        if (typeof candidate === "function") openRightbar = candidate;
      } catch {
        // Cordis 服务代理对未声明属性会抛错：按「宿主没有这个 action」处理。
        releasePrepared();
        return "unavailable";
      }
      if (openRightbar === null) {
        releasePrepared();
        return "unavailable";
      }
      // 刷新后（本生命周期内已经展示过右栏）仍然必须调用 openRightbar：宿主 layout store 的
      // rightbarShown 刷新后可能是 false，跳过调用右栏就可能不显示。区别只在于这次打开要
      // 瞬时完成：优先复用「页面打开之前就已经开始」的抑制句柄（panel 可能在 openTab 时就展开，
      // 那时动画已经开始）；只有没有句柄时才按现有逻辑临时创建，兼容独立重试与旧调用路径。
      // 临时创建同样拿不到目标（无 DOM / 元素缺失）时为 null，行为与旧版本完全一致。
      const restoreTransition = typeof preparedRestore === "function"
        ? preparedRestore
        : (rightbarPresentedPersisted ? suppressRightbarTransition() : null);
      let result = "ok";
      try {
        // 宿主动作是方法式绑定：显式带上接收者，避免将来 layout 改成类实例后丢失 this。
        openRightbar.call(layout, true, false);
      } catch {
        // 调用抛错不影响页面打开：只影响这一次自动展开，失败会被记账。
        result = "failed";
      }
      // 恢复必须晚于宿主的这次提交：绝不在同一同步栈里还原，否则过渡会在列宽落地前重新生效。
      if (restoreTransition !== null) scheduleInstantRestore(restoreTransition);
      return result;
    };

    /**
     * 为某次访问排队一次异步展开（同一访问只会成功展开一次）。
     * 已消费、已排队、代次过期、已 dispose 或环境没有可用调度器时什么都不做——绝不阻塞页面打开。
     */
    const scheduleRightbarExpand = (sessionId, epoch, delay) => {
      if (frame.disposed || sessionId === null) return false;
      // 右栏这次展示生命周期已经展开过：连定时器都不排（切换 surface 时不产生任何 layout 调用）。
      if (rightbarPresented) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.expandDone) return false;
      if (rightbarExpandTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          rightbarExpandTimers.delete(sessionId);
          runRightbarExpand(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动展开，页面打开与其它行为都不受影响。
        return false;
      }
      rightbarExpandTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 展开体。三重校验后才调用 layout：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 不得污染新 surface）；
     * 2. 仍是当前可见会话（右栏是全局的，绝不为后台会话展开）；
     * 3. 本次访问的页面已经落地（openState === "opened"）——宿主有证据时还要求宿主已提交，
     *    否则会把内容展开到旧 surface 或被 seat 立刻关掉。
     * 成功一次即 expandDone（同一访问内不再重复，尊重用户随后手动关闭），并置位右栏展示
     * 生命周期 rightbarPresented（跨 surface 会话共用，切换 child 时不再重复展开）。
     */
    const runRightbarExpand = (sessionId, epoch) => {
      if (frame.disposed) return;
      const record = surfaceRecordOf(sessionId);
      // 右栏已经在本展示生命周期里展开过（例如另一个 surface 的展开先成功）：绝不再调宿主 layout，
      // 同时收口本次访问可能已经开始的抑制（它不会再被消费）。
      if (rightbarPresented) {
        releaseTransitionRestore(record);
        return;
      }
      // 旧代次：句柄属于别的访问，绝不能在这里收口（那会撕掉新访问的抑制）。
      if (record.visitEpoch !== epoch) return;
      if (record.expandDone) return;
      if ((rightbarExpandFailures.get(sessionId) || 0) >= RIGHTBAR_EXPAND_MAX_ATTEMPTS) {
        releaseTransitionRestore(record);
        return;
      }
      if (currentSurfaceSessionIdOf() !== sessionId) {
        // 用户已切走：这次访问不会再为它调用 openRightbar，收口抑制（切回时是新访问、会重新抑制）。
        releaseTransitionRestore(record);
        return;
      }
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        releaseTransitionRestore(record);
        return;
      }
      if (record.openState !== "opened") {
        // 页面还没落地：后续 runSurfaceOpen 会在下一次 openTab 之前重新抑制，这里先收口避免悬空。
        releaseTransitionRestore(record);
        return;
      }
      // 句柄所有权移交：callOpenRightbar 负责在调用 layout.openRightbar 之后统一延迟恢复，
      // 或在拿不到 layout action 时立刻收口。
      const preparedRestore = typeof record.transitionRestore === "function" ? record.transitionRestore : null;
      record.transitionRestore = null;
      const result = callOpenRightbar(preparedRestore);
      if (result === "ok") {
        record.expandDone = true;
        // 置位全局展示生命周期：之后切换 surface 只切内容，不再重复展开（消除右栏闪烁）。
        rightbarPresented = true;
        // 持久标记：刷新后仍能识别「右栏曾经展示过」，下一次自动打开以无过渡方式提交，
        // 不再重新播放一次展开动画（写入失败只影响下次刷新有没有动画，静默回退）。
        rightbarPresentedPersisted = true;
        persistRightbarPresented();
        rightbarExpandFailures.delete(sessionId);
        return;
      }
      // 宿主没有这个 action：不消耗机会、不排自动重试，等下一次通知再试。
      if (result === "unavailable") return;
      const failures = (rightbarExpandFailures.get(sessionId) || 0) + 1;
      rightbarExpandFailures.set(sessionId, failures);
      // 失败重试同样必须异步（回到宿主提交之后），且次数有上限，不会无限重排定时器；
      // 排不出重试任务时收口句柄（此时句柄通常已交给 callOpenRightbar 消费，这里是兜底）。
      if (failures >= RIGHTBAR_EXPAND_MAX_ATTEMPTS
        || scheduleRightbarExpand(sessionId, epoch, RIGHTBAR_EXPAND_RETRY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };

    /**
     * 为「当前可见会话的本次访问」安排一次异步展开。
     * 页面必须先落地（openState === "opened"），否则展开只会拉出一个空右栏；本次访问已经展开过
     * 就绝不再排——用户手动关闭右栏后，本次访问的重复通知不会把它重新拉开。
     * 另有全局闸门：右栏这份展示（跨 surface 会话只有一份）已经展开过时，后续切换只切换内容，
     * 绝不再调用 layout.openRightbar（rightbarPresented 只控制「要不要调用 openRightbar」）。
     */
    const scheduleCurrentSurfaceExpand = () => {
      const current = currentSurfaceSessionIdOf();
      const record = current === null ? undefined : surfaceRecords.get(current);
      if (rightbarPresented) {
        // 已经展示过右栏：这次 surface 切换只需要「把新 panel 的 expanded transform 提交过程变瞬时」，
        // 不需要再调用 layout.openRightbar。因此把 openTab 前准备好的抑制句柄转交给延迟恢复
        // （两帧 RAF + 250ms fallback），覆盖 React 把 data-sidebar-right-open/transform 提交到 DOM
        // 的窗口；绝不能在这里直接 release，否则新 panel 仍会播放一次从右侧滑入的动画。
        const preparedRestore = typeof record?.transitionRestore === "function" ? record.transitionRestore : null;
        if (preparedRestore === null) return;
        record.transitionRestore = null;
        scheduleInstantRestore(preparedRestore);
        return;
      }
      if (current === null) return;
      if (record === undefined) return;
      if (record.visitEpoch !== frame.layout.currentVisitEpoch()) return;
      if (record.openState !== "opened") return;
      if (record.expandDone) return;
      // 排程失败（没有可用调度器 / setTimeout 抛错）：这次访问不会再调用 openRightbar，
      // 立刻收口抑制句柄，绝不让 observer 与内联样式悬在宿主上。
      if (scheduleRightbarExpand(current, record.visitEpoch, RIGHTBAR_EXPAND_DELAY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };

    /**
     * 为一次 surface 打开「装配抑制句柄」（必须在 openSurfaceTab 之前调用）。
     *
     * 启动条件只看「持久标记」：只要宿主上曾经展示过右栏（含本生命周期内刚成功的那次切换），
     * 之后每次自动打开**另一个 surface** 的 openTab 都可能让这个 surface 的 panel 进入 expanded
     * （data-sidebar-right-open → transform: none + 过渡），动画从那一刻开始，所以必须在 openTab
     * 之前抑制这次提交。rightbarPresented 只决定「要不要调用 layout.openRightbar」，不决定
     * 「要不要抑制 panel 动画」——这正是此前「首次展开后切换 surface 仍会滑入」的漏点。
     * 同一访问已有句柄时绝不覆盖（重复通知、重试都复用同一个句柄）。
     */
    const armSuppression = (record) => {
      if (rightbarPresentedPersisted && typeof record.transitionRestore !== "function") {
        record.transitionRestore = suppressRightbarTransition();
      }
    };
    return Object.freeze({
      armSuppression,
      cancelAllRightbarExpands,
      cancelRightbarExpand,
      isPersisted: () => rightbarPresentedPersisted,
      isPresented: () => rightbarPresented,
      /**
       * 结束本次「右栏展示生命周期」（宿主明确报告 surface 没了 / 重挂载边沿）。
       *
       * 三件事必须一起做，顺序与拆分前逐字一致：先复位全局展示态、再就地取消该会话尚未执行的
       * 展开 timer（不依赖随后 beginVisit 的代次变化兜底）、最后清零失败预算——否则旧生命周期里
       * 已经失败到上限的 surface 在新生命周期里永远不会再尝试展开。
       */
      endPresentation: (sessionId) => {
        rightbarPresented = false;
        cancelRightbarExpand(sessionId);
        rightbarExpandFailures.clear();
      },
      scheduleCurrentSurfaceExpand,
      scheduleRightbarExpand,
    });
  }

  /**
   * 构建组成读面（openTabs inventory + 右栏 DOM + active() 证据）。
   *
   * 这些读面只回答「当前右栏里有哪些页、这个会话的页在不在」，不写任何状态；单独成厂只为守住
   * 「单工厂 ≤400 行」的门禁。跨面调用一律经 `frame.expand` 在调用时解析。
   */
  function createRightbarComposition(frame) {
    const config = frame.config;
    const sessions = frame.sessions;
    const nativeSidebar = frame.nativeSidebar;
    const { readHostActiveSurface } = frame.layout;

    /** 按会话解析 scoped sidebarRight（公开契约；解析不到时返回 null）。 */
    const nativeSidebarFor = (target) => {
      if (typeof config.sidebarRightForSession === "function") {
        try { return config.sidebarRightForSession(target, frame.ctx); } catch { return null; }
      }
      try {
        const scoped = typeof sessions?.scope === "function" ? sessions.scope(target) : null;
        return scoped?.get?.("sidebarRight") || scoped?.sidebarRight || null;
      } catch { return null; }
    };
    /**
     * 读取宿主右栏的公开只读 tab inventory（**跨 pane** 的全量已提交 tab 表）。
     *
     * 为什么需要它：宿主刷新后会从持久化布局恢复**全部 pane** 的 tab，而 `active()` 只返回
     * 当前活跃 pane 的 active tab。只看 active() 无法回答「这个会话的 Expert Group 页是否已经
     * 存在于另一个 pane」，于是插件会在当前 pane 再开一个重复的 Expert Group 页
     * （多 pane/分页下刷新一次多一个重复页）。
     *
     * 读面缺失（旧宿主没有 openTabs）、读属性抛错、没有 getSnapshot、返回非数组/null 或调用
     * 抛错时一律返回 null：调用方据此**完全**回退旧的 active() 兼容语义，绝不把「读不到」
     * 当成「不存在」，也绝不当成「已存在」。
     */
    const readSurfaceOpenTabs = () => {
      let inventory = null;
      try { inventory = nativeSidebar?.openTabs ?? null; } catch { return null; }
      const getSnapshot = methodOf(inventory, "getSnapshot");
      if (getSnapshot === null) return null;
      try {
        const snapshot = getSnapshot.call(inventory);
        return Array.isArray(snapshot) ? snapshot : null;
      } catch { return null; }
    };
    /**
     * 读取已渲染右栏的页面组成：DOM 能看到其它 tab 时，它是跨 pane「其它页存在」的直接证据。
     *
     * DOM 只提供 tabId，不提供 kind、更不提供 sessionId；这两样都只能来自 openTabs inventory。
     * 因此**归属**是这里的第一判据：一个节点只有在 inventory 里明确属于本次查询的 sessionId 时，
     * 才算这个会话的组成。
     *
     * 会话切换时旧会话的 tab 节点可能还留在 DOM 里（宿主 React 重挂载窗口）：它在 inventory 里
     * 挂在别的 sessionId 名下，因此在这里拿不到 kind，落进下面的 unknown 桶——既不会被当成当前
     * 会话的「其它页」（这正是修复点：只按 tabId 建全局 kind 表时，root-a 的残留节点会把 root-b
     * 判成 50%），也不会被当成 Expert Group-only。
     *
     * fail-closed 语义（与修复前一致，不能放松）：
     * - 节点没有 tabId、或 tabId 在 inventory 里找不到**属于本次会话**的归属（含挂在别的会话
     *   名下的旧节点）→ "unknown"（读不到 ≠ 不存在）；
     * - inventory 不可用（返回 null）时所有非 Expert Group 节点都归入 unknown；
     * - 已知是 Expert Group 的 tabId（含 DockKit 生成的 kind+计数器形态）永远不是「其它页」。
     * 只有「明确属于当前会话、且 kind 不是 Expert Group」的节点才返回 "other"。
     *
     * 面板归属同样按 session 精确解析（rightbarPanelForSession）：DOM 里可能同时残留多个 session
     * 的面板（React 重挂载窗口），querySelector 的首个命中不能证明归属，读它的 tab 节点就会把别的
     * 会话的页算成本会话的组成。零个/多个匹配、或现代宿主里当前面板缺归属标记都返回 null
     * （＝这一面在本轮读不到），绝不退回全局第一个面板。
     *
     * sessionId 省略（传 null）时不做任何归属判定：调用方只用来探测 DOM 读面本身是否可用
     * （见 compositionReadFacesUnavailable），因此这里保留旧的兼容读法（querySelector 的命中），
     * 只回答「DOM 读面在不在」，它的返回值也不会被当成任何会话的组成证据。
     */
    const readRightbarDomComposition = (sessionId = null) => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelector !== "function") return null;
      let panel = null;
      if (typeof sessionId === "string" && sessionId !== "") {
        // 实际 session 判定：只读这个会话自己的面板。
        panel = rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
      } else {
        // 探测读面能力（无归属判定）。
        try { panel = doc.querySelector(RIGHTBAR_PANEL_SELECTOR); } catch { return null; }
      }
      if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
      let nodes;
      try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return null; }
      const inventory = readSurfaceOpenTabs();
      // 只登记「明确属于当前会话」的 tabId → kind；别的会话与 sessionId 缺失的记录一律不参与判定。
      const kindByTabId = new Map();
      if (inventory !== null && sessionId !== null && sessionId !== undefined) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const tabId = text(candidate.tabId, null);
            const kind = text(candidate.kind, text(candidate.type, null));
            if (tabId !== null && kind !== null) kindByTabId.set(tabId, kind);
          } catch {
            // 单条坏记录不阻断其它 tab 的归属；无法归属的节点仍由下面的 fail-closed 分支处理。
          }
        }
      }
      let hasOther = false;
      let hasUnknown = false;
      for (const node of nodes) {
        let tabId = null;
        try { tabId = text(node?.getAttribute?.("data-dockkit-tab"), null); } catch { tabId = null; }
        if (tabId === null) { hasUnknown = true; continue; }
        if (EXPERT_GROUP_TAB_IDS.has(tabId) || isGeneratedExpertGroupTabId(tabId)) continue;
        if (!kindByTabId.has(tabId)) { hasUnknown = true; continue; }
        const kind = kindByTabId.get(tabId);
        if (EXPERT_GROUP_TAB_IDS.has(kind)) continue;
        hasOther = true;
      }
      if (hasOther) return "other";
      if (hasUnknown) return "unknown";
      return "expert-only";
    };

    /** 同步栈内只读取「其它页是否已经存在」，不触碰 active()，避免改变宿主提交时序。 */
    const hasOtherRightbarPage = (sessionId) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return true;
          } catch {
            // 单条坏记录不构成其它页的正向证据。
          }
        }
      }
      // DOM 读面同样只认属于该会话的节点：旧会话残留的 tab 不算当前会话的其它页。
      return readRightbarDomComposition(sessionId) === "other";
    };

    /**
     * 跨 pane 的「这个会话的 Expert Group 页已经存在」判定。
     *
     * 命中口径与 activeTabEvidenceOf 的证据口径一致（同 sessionId + kind 为 expert-group）：
     * inventory 是全部 pane 已提交 tab 的并集，因此这里**不区分 pane**——这正是修复点，
     * 非活跃 pane 里的同一个页也是「已经存在」。tabId/contentId 不参与判定：它们是关闭/定位
     * 用的元数据，缺失不影响「页面已存在」这一事实。
     *
     * 返回值语义（两种 false 对调用方是同一件事：回退旧的打开语义）：
     * - true：读面证明页面已存在；
     * - false：读面证明不存在，或读面根本不可用（fail-closed，绝不因为读不到就跳过打开）。
     */
    const hasExistingExpertGroupTab = (sessionId) => {
      if (sessionId === null) return false;
      const inventory = readSurfaceOpenTabs();
      if (inventory === null) return false;
      for (const entry of inventory) {
        try {
          // 单条 inventory 记录来自宿主对象；某些代理对象字段读取失败时，不能让
          // 一条坏记录阻断其它记录和旧的打开回退语义。
          const candidate = object(entry);
          if (text(candidate.sessionId, null) !== sessionId) continue;
          if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
          return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    /**
     * 保守的「页面真的提交成 active」证据（只用插件已能访问的公开读面，不依赖未公开的 DSH 改动）。
     *
     * 为什么需要它：better.openTab() 返回 void；在它之外，插件此前只能证明宿主活跃会话是谁。
     * 即使调用没抛错，宿主右栏的 surface 也可能还没 mint / tab 还没提交（DSH SidebarRight 对
     * 未挂载会话的 open 会静默 no-op）。DSH 公开的 sidebarRight.active()（active tab of the
     * active pane，未挂载时返回 undefined）正好回答「这个 tab 到底有没有落地」。
     *
     * 读法：优先按目标会话解析出的 scoped sidebarRight，其次当前挂载的 nativeSidebar；只要其中
     * 任意一个有 active() 就用它。返回值：
     * - "confirmed"：active tab 的 kind/type 就是 expert-group（真正落地）；
     * - "missing"：读面存在但没有 active tab / 没有 kind（尚未 mint 或被静默 no-op）；
     * - "other"：active tab 是别的 kind（例如用户手动切走的 tab）；
     * - "unknown"：宿主没有该读面、属性读取或调用抛错、或宿主的活跃会话还不是目标会话
     *   （此时 active() 读的是别的 surface，不能当证据）——调用方必须退回旧 native / 旧 Better
     *   的兼容语义，绝不能让老版本失效。
     */
    const activeTabEvidenceOf = (sessionId) => {
      const host = readHostActiveSurface();
      // 宿主有活跃会话证据但还没提交到目标：此刻 active() 读的是别的 surface，不能当证据。
      if (host.available && host.sessionId !== sessionId) return "unknown";
      let reader = null;
      let owner = null;
      try {
        const scoped = nativeSidebarFor(sessionId);
        if (typeof scoped?.active === "function") { reader = scoped.active; owner = scoped; }
      } catch { /* 服务代理读取即抛错：按「没有读面」处理。 */ }
      if (reader === null) {
        try {
          if (typeof nativeSidebar?.active === "function") { reader = nativeSidebar.active; owner = nativeSidebar; }
        } catch { /* 同上。 */ }
      }
      if (reader === null) return "unknown";
      try {
        // 方法式绑定：显式带上接收者，避免将来改成类实例后丢失 this。
        const tab = reader.call(owner);
        const kind = text(object(tab).kind, text(object(tab).type, null));
        if (kind === null) return "missing";
        return EXPERT_GROUP_TAB_IDS.has(kind) ? "confirmed" : "other";
      } catch {
        // 调用抛错按「无证据」处理：自动打开降级为既有语义，绝不影响页面打开。
        return "unknown";
      }
    };
    /**
     * 组合 active()、openTabs 与宿主 DOM 的证据：active() 只回答当前 pane，不能代表整个右栏。
     *
     * 只要 openTabs 或 DOM 证明当前右栏存在其它 tab，就进入 50% 可调模式；仅有 Expert Group
     * 证据时才进入 20% 锁定模式。missing 与 unknown 保持独立：前者解锁但不改宽度，后者
     * 不改变已确认状态，避免读面暂态把用户宽度覆盖掉；两种组合读面都不可用时不采信 active-only
     * 证据，防止把一个 pane 的暂态读数误当成整个右栏的 Expert Group-only 组成。
     */
    const rightbarCompositionEvidenceOf = (sessionId, activeEvidence) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return "other";
          } catch {
            // 坏记录不能否定 active() 的证据；DOM 读面仍有机会给出其它页的正向证据。
          }
        }
      }
      // DOM 按 sessionId 归属：只有 inventory 明确算在当前会话名下的节点才参与组成判定，
      // 旧会话残留或无法归属的节点都归入 unknown，绝不推断成其它页。
      const domComposition = readRightbarDomComposition(sessionId);
      if (domComposition === "other") return "other";
      if (domComposition === "unknown") return "unknown";
      // active() 只够让既有宿主继续锁住当前 Expert Group 手柄；它本身不足以支撑会创建新 pane
      // 的 split 事务，否则会把一个 pane 的暂态读数扩展成整个右栏的 ownership 结论。
      // beginSidebarSplit 因此把这个 unknown 当作 fail-closed，唯一例外是「连组合读面都不存在」
      // 的 active-only 兼容宿主：那里的判据由 isActiveOnlySplitCompatible 单独给出（见其说明）。
      if (inventory === null && domComposition === null && activeEvidence === "confirmed") return "unknown";
      return activeEvidence;
    };
    /**
     * 两个组合读面是否都不可用（openTabs inventory 读不到 + 右栏 DOM 也读不到）。
     *
     * 这就是「旧宿主 / 读面还没就绪」的宿主形状：插件手上只剩 active() 这一份公开证据。
     * 读函数自己已经把「没有该 API / 属性读取抛错 / 调用抛错」吞成 null，因此这里的 try/catch
     * 只是防御服务代理在读取瞬间抛错，一律按「这一面不可用」处理（读不到 ≠ 不存在）。
     */
    const compositionReadFacesUnavailable = () => {
      let inventoryUnavailable = false;
      let domUnavailable = false;
      try { inventoryUnavailable = readSurfaceOpenTabs() === null; } catch { inventoryUnavailable = true; }
      // 这里只探测 DOM 读面本身是否可用（不传 sessionId，不做归属判定）：只要面板与节点查询
      // 能读，返回值就不是 null（最坏是保守的 "unknown"），读面可用性结论与修复前一致。
      try { domUnavailable = readRightbarDomComposition() === null; } catch { domUnavailable = true; }
      return inventoryUnavailable && domUnavailable;
    };
    return Object.freeze({
      activeTabEvidenceOf,
      compositionReadFacesUnavailable,
      hasExistingExpertGroupTab,
      hasOtherRightbarPage,
      nativeSidebarFor,
      readRightbarDomComposition,
      readSurfaceOpenTabs,
      rightbarCompositionEvidenceOf,
    });
  }

  /**
   * 构建打开面：延迟打开 + 采集落地证据。
   *
   * `frame` 由 coordinator 持有；本工厂在 expand 句柄尚未装配时创建，因此所有跨模块调用都经
   * `frame.*` 在**调用时**解析（绝不在此刻缓存引用）。
   */
  function createSurfaceOpen(frame) {
    const better = frame.better;
    const layout = frame.layout;
    const { readHostActiveSurface, releaseTransitionRestore, surfaceRecordOf } = layout;
    // 组成读面与展开排程属于同一个 expand 句柄；本工厂在句柄装配完成**之前**创建，
    // 因此按同名标识符做**调用时**转发（绝不在此刻缓存引用，也绝不复制任何状态）。
    const activeTabEvidenceOf = (sessionId) => frame.expand.activeTabEvidenceOf(sessionId);
    const armSuppression = (record) => frame.expand.armSuppression(record);
    const hasExistingExpertGroupTab = (sessionId) => frame.expand.hasExistingExpertGroupTab(sessionId);
    // 用 rest 形参转发（零实参）而不是零参箭头：这样 bundle 里 "scheduleCurrentSurfaceExpand();"
    // 的出现次数仍然只有三处**真实排程点**（openTargets 补排 + 打开落地后补排 + 跨 pane 已存在补排），
    // 转发定义本身不构成第四个排程点。
    const scheduleCurrentSurfaceExpand = (...args) => frame.expand.scheduleCurrentSurfaceExpand(...args);
    const openNativeTab = (target) => frame.target.openNativeTab(target);
    const currentSurfaceSessionIdOf = () => frame.target.currentSurfaceSessionId();

    /**
     * 发出一次 Expert Group 页面打开请求（Better 优先，native 回退）。
     * 返回 true 表示请求已成功发出；false 表示当前宿主无法定位该 surface（保持未打开状态，
     * 留给后续会话/设置通知重试）。Better openTab 返回 void，调用未抛错即视为已发出。
     */
    const openSurfaceTab = (target) => {
      if (better) {
        if (typeof better.openTab !== "function") return false;
        try {
          // target 必须显式为 right，第二参数是 Better Sidebar 的 SessionScope；
          // scope.sessionId 接受任意 surface 会话 id（root 或 child）。
          better.openTab({ type: "expert-group", target: "right" }, { sessionId: target });
          return true;
        } catch { return false; }
      }
      try {
        // native 用 openNativeTab 的 boolean 返回值判定「已成功发起」。
        return openNativeTab(target) === true;
      } catch { return false; }
    };

    /** 已排队的「打开请求」：sessionId → timer handle（与展开 timer 分开记账，dispose 一并清理）。 */
    const surfaceOpenTimers = new Map();
    /** 取消某个会话尚未执行的打开请求。 */
    const cancelSurfaceOpenTimer = (sessionId) => {
      const timer = surfaceOpenTimers.get(sessionId);
      if (timer === undefined) return;
      surfaceOpenTimers.delete(sessionId);
      try {
        // 句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的打开请求（dispose 用）。 */
    const cancelAllSurfaceOpens = () => {
      for (const sessionId of [...surfaceOpenTimers.keys()]) cancelSurfaceOpenTimer(sessionId);
    };

    /**
     * 为某次访问排队一次「打开页面」请求：一律 defer 到至少一个宏任务之后，等宿主把
     * surface/binding 提交完再发；同一次访问同时只保留一个待执行任务。
     * 代次过期、已落地、次数用尽、已排队、已 dispose 或没有可用调度器时什么都不做。
     */
    const scheduleSurfaceOpen = (sessionId, epoch, delay) => {
      if (frame.disposed || sessionId === null) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.openState === "opened") return false;
      if (record.openAttempts >= frame.layout.maxSurfaceOpenAttempts) return false;
      if (surfaceOpenTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          surfaceOpenTimers.delete(sessionId);
          runSurfaceOpen(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动打开，安装与其它行为都不受影响。
        return false;
      }
      surfaceOpenTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 打开体。发请求前逐条校验：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 绝不污染新 surface）；
     * 2. 用户仍在这个会话上（插件解析出的当前可见会话 已切走就直接放弃，新会话有它自己的访问）；
     * 3. 宿主有权威证据时，必须已经提交到这个会话（host.sessionId === sessionId）。未提交时
     *    绝不发请求——那正是会落到旧 binding 被静默丢弃的情况——只做有限次「等宿主提交」重试；
     * 4. 这个会话的 Expert Group 页在**任意 pane** 里都还不存在（公开只读 openTabs inventory）。
     *    已存在时绝不发请求（那会在当前 pane 再开一个重复页），但仍按「已打开」结算并排展开。
     * 只有真正通过全部校验的请求才算本次访问的 openState = "opened"；失败不记账为成功，按上限重试。
     */
    const runSurfaceOpen = (sessionId, epoch) => {
      if (frame.disposed) return;
      const layout = frame.layout;
      const record = layout.surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return;
      if (record.openState === "opened") return;
      if (currentSurfaceSessionIdOf() !== sessionId) return;
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        // 宿主 binding 还没提交到目标：有限等待（等通知或短重试），绝不盲目发请求。
        // 预算用尽或排不出重试任务（没有可用调度器）时，这次访问不会再走到 openRightbar，
        // 必须立刻收口抑制句柄，绝不把 observer/内联样式悬在宿主上。
        if (record.readinessRetries < MAX_READINESS_RETRIES
          && scheduleSurfaceOpen(sessionId, epoch, HOST_COMMIT_RETRY_MS) === true) {
          record.readinessRetries += 1;
        } else {
          releaseTransitionRestore(record);
        }
        return;
      }
      if (record.openAttempts >= MAX_SURFACE_OPEN_ATTEMPTS) {
        // 打开次数已用尽：这次访问同样不会再调用 openRightbar，收口未消费的句柄。
        releaseTransitionRestore(record);
        return;
      }
      // 跨 pane 已存在判定（必须在真正发请求之前）：宿主刷新后会从持久化布局恢复**全部 pane**
      // 的 tab，而 active() 只返回当前活跃 pane 的 tab——只看 active() 会得出「页面不存在」，
      // 于是在当前 pane 再开一个重复的 Expert Group 页。公开只读 inventory（openTabs.getSnapshot）
      // 是跨 pane 的权威证据，命中即按「已打开」结算：
      // - 不调用 openSurfaceTab：既不新建重复页，也不把焦点抢到别的 pane 的 tab 上；
      // - 不写 record.commitState = "confirmed"：inventory 只能证明 tab 已提交，不能证明它是
      //   当前活跃 pane 的 active tab；写成 confirmed 会伪造出「已确认 → 明确缺失」的重挂载边沿，
      //   把 rightbarPresented 复位并反复重展开右栏（保持 "unknown" 才与读面证据一致）；
      // - 但照旧消费本次访问（openState = "opened"，与成功路径同一条完成语义）并排程右栏展开，
      //   绝不因为跳过 openTab 就让用户看到「页面明明在、右栏却没打开」。
      // 读面缺失/返回 null/抛错时 hasExistingExpertGroupTab 一律返回 false：完全回退旧语义。
      if (hasExistingExpertGroupTab(sessionId)) {
        record.openState = "opened";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        scheduleCurrentSurfaceExpand();
        return;
      }
      record.openAttempts += 1;
      // 注意：视觉连续性遮罩**不在这里**创建。DSH 原生 session-key 重挂载会在本函数执行之前
      // （openTargets 之后的下一帧里）就把旧 panel 删掉，因此抢拍必须在 openTargets() 里、
      // scheduleSurfaceOpen() 之前完成；这里只复用 record 上已有的句柄，绝不再新 clone。
      // 时序硬约束：Better/native 的 openTab 可能**同步**把右栏面板置为展开（公开属性
      // data-sidebar-right-open + transform 过渡），动画从那一刻就已经开始；而 layout.openRightbar
      // 要等下一轮 deferred 展开体才会被调用。因此抑制必须在这里、在 openSurfaceTab() 之前开始，
      // 并把恢复句柄挂到本次访问记录上，等真正调用 openRightbar 之后交给 scheduleInstantRestore 延迟恢复。
      // 启动条件只看「持久标记」：只要宿主上曾经展示过右栏（含本生命周期内刚成功的那次切换），
      // 之后每次自动打开**另一个 surface** 的 openTab 都可能让这个 surface 的 panel 进入 expanded
      // （data-sidebar-right-open → transform: none + 过渡），动画从那一刻开始，所以必须在 openTab
      // 之前抑制这次提交。rightbarPresented 只决定「要不要调用 layout.openRightbar」，不决定
      // 「要不要抑制 panel 动画」——这正是此前「首次展开后切换 surface 仍会滑入」的漏点。
      // 同一访问已有句柄时绝不覆盖（重复通知、重试都复用同一个句柄）。
      armSuppression(record);
      const opened = openSurfaceTab(sessionId);
      // 保守提交确认：openTab/openTabIn 是 void（openTabIn 的返回值对未挂载会话也不可信），
      // 只有公开读面确认 expert-group 已成为 active，或宿主根本没有该读面（unknown 兼容路径）
      // 时，才算这次打开真的落地。
      const evidence = opened ? activeTabEvidenceOf(sessionId) : "unknown";
      if (opened && (evidence === "confirmed" || evidence === "unknown")) {
        record.openState = "opened";
        record.commitState = evidence === "confirmed" ? "confirmed" : "unknown";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        // 页面落地后才排程展开（展开永远排在打开之后）。
        scheduleCurrentSurfaceExpand();
        return;
      }
      // 请求已发出但没落地（或调用本身失败）：绝不结算、绝不展开。自动定时重试有独立上限
      // （其余机会留给后续通知），总次数仍受 MAX_SURFACE_OPEN_ATTEMPTS 约束；异常已在
      // openSurfaceTab 内部吞掉，绝不抛给调用方。
      if (evidence === "missing") record.commitState = "missing";
      else if (evidence === "other") record.commitState = "other";
      record.openFailures += 1;
      // 重试预算还够、且重试任务确实排得出去时才算消费一次重试；否则立刻收口抑制句柄
      // （重试用尽 / 调度不可用都意味着这次访问不会再调用 layout.openRightbar），
      // 绝不把 observer 与 transition:none 留给宿主。
      if (record.openRetries < MAX_SURFACE_OPEN_RETRIES
        && record.openAttempts < MAX_SURFACE_OPEN_ATTEMPTS
        && scheduleSurfaceOpen(sessionId, epoch, SURFACE_OPEN_RETRY_MS) === true) {
        record.openRetries += 1;
      } else {
        releaseTransitionRestore(record);
      }
    };

    return Object.freeze({
      cancelAllSurfaceOpens,
      cancelSurfaceOpenTimer,
      openSurfaceTab,
      surfaceOpenDelayMs: SURFACE_OPEN_DELAY_MS,
      scheduleSurfaceOpen,
      surfaceOpenTimers,
    });
  }

  global[SYMBOL] = Object.freeze({ createRightbarComposition, createRightbarExpand, createSurfaceOpen });
})(globalThis);
