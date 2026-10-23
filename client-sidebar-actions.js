/**
 * 客户端侧栏 · Panel 手动开关与副作用复核（R6 票据 24 / sidebar-actions）
 *
 * ## 职责边界
 * 本模块承接「一次右栏动作」的手动意图与副作用**复核/回退**：
 * 1. 手动意图：记录用户在在途动作期间表达的 open/close 方向，并在动作收尾后按当下真实状态结算；
 * 2. 动作有效性：Auto 关闭 / 代次过期 / 面板重挂载 / surface 切换之后，副作用一律放弃；
 * 3. 副作用回退：撤销在途打开记账、收口 split 事务、按 owner 令牌回退自动关闭预算；
 * 4. 同步编排：先记录/库存同步，再开关代次收口，最后跑 Auto 同步（顺序即判据，不得颠倒）。
 *
 * ## 状态所有权（规格书 §状态所有权(3)）
 * - 所有可写容器仍归 Panel / realm 共享账本所有；本模块只通过注入的 scope 读写同一批容器。
 * - 本模块**不推进任何 Hook**：Panel 的 useEffect / useRef / useState 全部留在原位置、原顺序，
 *   本文件只是被 Panel 每帧按需调用的纯闭包。因此 effect 的 setup/cleanup 顺序不受拆分影响。
 *
 * ## 关键语义（逐条保留，不得放宽）
 * - 手动恒优先：在途动作必须在副作用之前让位，绝不并发派发第二个动作；
 * - 结算只按当下真实状态，绝不盲目重放那次点击；
 * - 失败屏障让「失败 → 撤销预留 → 立刻重选」不在微任务里自转；
 * - 尾随同步必须过 surface 闸门：旧闭包绝不清理新 Panel 刚写入的来源账本。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-actions")]
 * 装配：真实依赖边为 pure / dom / auto-ledger → 本模块 → 主 sidebar。
 */
(function installSidebarActions(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-actions");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_TAB_ORIGIN_AUTO, SIDEBAR_TAB_ORIGIN_MANUAL, text,
  } = PURE;
  // 本模块不直接读 DOM 检查点：tab key / 地址判定都由注入面的窄命令承担，真实依赖边只有
  // pure 与 auto-ledger（manifest 的 iifeDependencies 与此逐项一致）。
  const LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const LEDGER = global[LEDGER_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, recordSidebarAutoDecision, sidebarBoundedText,
    writeSidebarAutoOwnership,
  } = LEDGER;

  /**
   * 把本帧的 Panel 执行上下文注入成一份闭包作用面（scope）。
   *
   * 每个 key 都是 Panel 原来的**同名**标识符（ref / 每帧值 / 窄命令），因此本文件里的
   * 全部判定与写入都是拆分前那段代码的逐字搬移，判据语义、读写时机与顺序都不变。
   */
  function createSidebarActions(scope) {
    const {
      autoCloseCandidate, autoOpenCandidate, autoOpenEnabled,
      bump, cancelPendingSidebarSplit, cleanupAutoSidebarKeys,
      clearAutoCloseAttempt, clearManualSuppressionOfIdleResources, currentRootRef,
      currentSidebarSessionRef, handleSidebarAction, idleSidebarResourceAddresses,
      knownSidebarResourceAddresses, mountedRef, rootSessionId,
      runningSidebarResourceAddresses, setAutoOpenDraft, sidebarAutoBusyRef,
      sidebarAutoCascadeRef, sidebarAutoCloseAttemptOwnersRef, sidebarAutoCloseAttemptsRef,
      sidebarAutoEpochRef, sidebarAutoFailedKeysRef, sidebarAutoOriginRef,
      sidebarAutoReservationRef, sidebarAutoSignatureRef, sidebarAutoSuppressedRef,
      sidebarIdleChildren, sidebarManualIntentOf, sidebarManualIntentRef,
      sidebarSessionId, sidebarSplitIntentRef, sidebarSurfaceStillCurrent,
      sidebarTabOpeningRef, sidebarTabPendingRef, sidebarTabRecordsRef,
      sidebarTabSyncRef, snapshot, sweepAutoOpenPlaceholders,
      syncSidebarTabRecords, trimAutoKeyMap, verifyPendingSidebarCloses,
    } = scope;

    /**
     * 放行一个自动动作。
     *
     * 复用用户点击的同一条入口（handleSidebarAction + origin=auto）：同一把 pending 锁、同一段
     * split 事务、同一套「用真实 tabId 关闭」的记录语义，因此自动路径不存在第二套打开/关闭实现。
     * 动作收尾后才重新推进同步，下一个候选（或清理）由那条链路继续。
     */
    function launchAutoSidebarAction(candidate) {
      sidebarAutoBusyRef.current = true;
      /**
       * 自动打开/自动关闭决策的诊断记录（只记结论与 key 摘要，绝不记提示词/正文/令牌）：
       * 候选选中时记一条 launch，结算/失败时再记一条，便于事后离线核对「某次构建之后这个 tab 为什么
       * 没被收回去」。
       */
      recordSidebarAutoDecision("launch", candidate, "candidate");
      void Promise.resolve()
        // candidate 作为自动动作上下文（kind/epoch/预留）传入：动作必须在每个 await 之后
        // 复核它是否仍然有效，并在收尾时无条件释放预留（见 handleSidebarAction）。
        .then(() => handleSidebarAction(candidate.key, candidate.address, SIDEBAR_TAB_ORIGIN_AUTO, candidate))
        .then(
          () => { recordSidebarAutoDecision("settle", candidate, "ok"); },
          (error) => {
            /* 打开/关闭失败只影响这一次动作：状态由既有记录与重试记账负责。 */
            recordSidebarAutoDecision("settle", candidate, "failed", sidebarBoundedText(error === null || error === undefined ? undefined : error.message));
          },
        )
        .then(() => {
          sidebarAutoBusyRef.current = false;
          /**
           * 尾随同步只用来推进「下一个候选」。它必须带着级联标记执行：这一轮里失败过的 key
           * 不会被重新选中，因此「失败 → 撤销预留 → 立刻重选」不在微任务里自转（见
           * sidebarAutoFailedKeysRef）。真正的重试留给下一个外部同步轮。
           *
           * 但这次推进同样只能由**仍然有效**的那一轮 surface 发起：动作的 await 可能跨越一次组件
           * 重挂载 / root 切换，此时本闭包的 mountedRef 已经是 false（旧实例的挂载 effect 已清理），
           * 而它手里的旧快照与共享 Auto 来源账本不是一回事——旧闭包的 syncSidebarTabs() 会把新
           * Panel 刚写入的其它 Auto 来源当成「已经离开旧快照」清掉（新 Panel 随后再也认不出自己
           * 打开过的 tab），并且「旧实例入口放弃动作 → 尾随同步又选中同一个候选」会形成不让出宏
           * 任务的微任务自转（页面被拖住）。因此这里与 handleSidebarAction 的收尾闸门用同一条判据
           * （含不可复用的 surface 令牌，重挂载与 A→B→A 都算失配）：surface 失配时只归还本实例的
           * 级联闸门，绝不调用旧闭包的同步；新 Panel 的下一轮外部同步会按真实 inventory 继续推进
           * 候选与清理。
           */
          if (sidebarSurfaceStillCurrent() !== true) return;
          sidebarAutoCascadeRef.current = true;
          try {
            // 用引用取最新一轮渲染的同步器（与 observer/轮询同一写法），绝不复用当前闭包。
            sidebarTabSyncRef.current?.();
          } finally {
            sidebarAutoCascadeRef.current = false;
          }
        });
    }

    /**
     * 第二阶段：Auto（自动打开运行中的子代理侧栏）同步。
     *
     * 顺序固定为「先关后开」，并且只在有属于当前 root 的真实快照时动作：
     * 1. 关闭：Auto 亲手打开过的资源一旦不在运行中集合里，就用**已确认记录里的真实 tabId** 走
     *    既有 handleSidebarAction 关闭路径（绝不猜 tabId、绝不调用批量关闭）；
     * 2. 打开：运行中、尚未打开、且没有被用户手动关闭抑制的资源走既有打开路径；
     * 3. 清理：把已经离开当前快照的复合键从来源/抑制集合里移除。
     *
     * 开关关闭时不做任何自动 open/close（历史行为逐字节不变），已打开的 tab 交由用户手动处理；
     * 清理阶段与开关无关，它只维护插件自己的记账，不触碰宿主。
     */
    function syncAutoSidebarTabs() {
      const source = snapshot;
      // 没有快照（首次加载 / 读取失败）时没有「谁在运行」的证据：既不打开也不关闭。
      if (source === null || source === undefined) return;
      // root 切换瞬间旧快照可能仍在 state 里：只有属于当前 root 的快照才能决定动作。
      if (text(source.rootSessionId, null) !== rootSessionId) return;
      const known = knownSidebarResourceAddresses();
      const running = runningSidebarResourceAddresses();
      const enabled = autoOpenEnabled();
      /**
       * 先回收过期的打开占位（缺陷 2）：它只维护插件自己的记账、绝不触碰宿主，因此与 Auto 开关无关
       * （与下面的记账清理同一条边界）。放在候选选择之前，被回收的容量当轮就能重新用上。
       */
      sweepAutoOpenPlaceholders(running);
      /**
       * manual 抑制的清除只由「明确空闲」驱动，且与 Auto 开关无关（与上面的记账清理同一条边界：
       * 它只维护本插件自己的标记，绝不触碰宿主）。先清再选候选：清掉之后这一轮的开候选判据读到的
       * 就是最新状态；空闲地址本来就不在 running 集合里，因此这一步不会为本次运行重新打开任何 tab。
       */
      clearManualSuppressionOfIdleResources(idleSidebarResourceAddresses(sidebarIdleChildren()));
      let candidate = null;
      if (enabled === true && sidebarAutoBusyRef.current !== true) {
        candidate = autoCloseCandidate(running) ?? autoOpenCandidate(running);
      }
      cleanupAutoSidebarKeys(known, candidate === null ? null : candidate.key);
      if (candidate === null) return;
      launchAutoSidebarAction(candidate);
    }

    /**
     * 自动动作是否仍然有效：Auto 仍开启、动作代次未变、面板仍挂在同一个 root / sidebar session 上。
     *
     * 这是「关闭 Auto 取消在途打开」的判据：Auto getter 每次现读（权威读面），代次在开关变化时
     * 递增，surface 身份用与 handleSidebarAction 入口相同的三个 ref 复核。任一项不成立，那次自动
     * 动作一律放弃副作用。
     */
    function autoActionStillValid(context) {
      if (context === null || context === undefined) return false;
      if (autoOpenEnabled() !== true) return false;
      if (sidebarAutoEpochRef.current !== context.epoch) return false;
      return mountedRef.current === true
        && currentRootRef.current === rootSessionId
        && currentSidebarSessionRef.current === sidebarSessionId;
    }

    /**
     * 撤销一次自动动作的在途记账（Auto 关闭 / 代次过期 / 手动接管 / 失败路径共用）。
     *
     * 三件事缺一不可：
     * 1. 收口这次动作开出的 split 事务：否则右栏会停在事务的临时 50%，直到 15 秒 deadline 才回落；
     * 2. 删掉这个 key 的在途打开记录：这次打开没有发出，不能让后续同步把它当成「还没确认的打开」；
     * 3. 释放预留：失败绝不等于「已经打开过」，下一次同步必须能重新选中这个资源。
     * 来源标记只在 openResource 成功发出时才存在，因此这里不删除它（关闭类动作被撤销后，
     * 那个 tab 仍然属于 Auto，开关重新打开后仍可被自动回收）。
     */
    function abandonAutoSidebarAction(key, context) {
      if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("auto-abandoned");
      sidebarTabOpeningRef.current.delete(key);
      sidebarAutoReservationRef.current.delete(key);
      releaseAutoCloseAttempt(key, context);
    }

    /**
     * 回退候选选择时预支的那一次自动关闭重试（动作在真正调用 close 之前被撤销时调用）。
     *
     * 只有**这条预算当前的所有者**才允许回滚：owner 账本里登记的必须与本次动作出发时拿到的是
     * 同一份不可复用令牌。旧代次的迟到收尾（重挂载、同一个实例 A→B→A、Auto 关闭取消）完全可能
     * 在新代次已经为同一个 key 重新预支预算之后才跑到这里——令牌不匹配时一律 fail-safe：绝不写、
     * 绝不删共享 attempts，否则新代次的预算会被删掉（等于复活），同一个 key 的实际 close 次数就会
     * 突破 3 次上限。owner 不存在或已被限容淘汰时同样 fail-safe（宁可白烧一次预算，也绝不动可能
     * 属于后来者的计数）。
     */
    function releaseAutoCloseAttempt(key, context) {
      if (context === null || context === undefined || context.kind !== "close") return;
      const owners = sidebarAutoCloseAttemptOwnersRef.current;
      const token = context.attemptToken;
      if (token === null || token === undefined || owners.get(key) !== token) return;
      const attempts = sidebarAutoCloseAttemptsRef.current;
      // owner 还在、预算已经不在了（被限容淘汰或被别的收口路径清掉）：只清掉自己这一份 owner。
      if (attempts.has(key) !== true) {
        owners.delete(key);
        return;
      }
      if (context.attemptsBefore === 0) attempts.delete(key);
      else {
        attempts.set(key, context.attemptsBefore);
        // 回退同样要限容：这一步是 set 的第二条路径，少了它这个 Map 就可能在长生命周期里无界增长。
        trimAutoKeyMap(attempts);
      }
      // 回滚完成即交还所有权：此后同一个 key 的新预支由新的令牌持有，旧令牌再也回不来。
      owners.delete(key);
    }

    /**
     * 自动动作在副作用之前必须让位的「手动接管」状态：
     * - "close"：用户在同一个 key 上留下过关闭意图——Auto 绝不能在关闭意图之后再打开一个 tab；
     * - "open"：用户手动要求打开这个资源——打开照常发出，但最终 tab 必须记成 manual 来源；
     * - null：没有手动接管。
     */
    function autoTakeoverStateOf(key) {
      const intent = sidebarManualIntentOf(key);
      if (intent === undefined) return null;
      return intent.intent === "close" ? "close" : "open";
    }

    /**
     * 记录一次「在途动作期间」的用户手动意图。
     *
     * 触发点只有两个（用户点击落在一个已被 pending 锁或未落地打开占用的 key 上）：意图方向按
     * 点击那一刻的按钮语义判定——已经有记录（<<）表示要关闭，没有记录（>>）表示要打开，
     * 绝不按动作在途时的中间态猜方向。方向判定与 handleSidebarAction 的分支条件同源。
     */
    function recordSidebarManualIntent(key, resourceAddress) {
      const record = sidebarTabRecordsRef.current.get(key);
      const scoped = record !== undefined
        && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
      sidebarManualIntentRef.current.set(key, {
        sessionId: sidebarSessionId,
        rootSessionId,
        address: resourceAddress,
        intent: scoped ? "close" : "open",
      });
    }

    /**
     * 结算一个 key 上的手动意图（在途动作收尾后，以及同步的兜底扫描里调用）。
     *
     * 手动恒优先，但**只按当下的真实状态结算**，绝不盲目重放那次点击：
     * - 还有动作在途（pending）或打开尚未落地：这一轮什么都不做，等下一次收尾再结算；
     * - 「打开」：已经开着就把来源改回 manual（Auto 不再管它）；还没开出才补发一次**手动**打开，
     *   走与点击完全相同的入口（唯一区别是 origin=manual，因此后续绝不会被自动关闭）；
     * - 「关闭」：有精确 tabId 时走同一入口关闭并登记抑制；没有可关闭的 tab 时只登记抑制，
     *   绝不为了「执行这次关闭」而先打开一个 tab。
     */
    function applyPendingManualIntent(key) {
      const entry = sidebarManualIntentOf(key);
      if (entry === undefined) return;
      // 同一 key 仍有动作在途：它收尾时会再结算一次，绝不在这里并发派发第二个动作。
      if (sidebarTabPendingRef.current.has(key) === true) return;
      const opening = sidebarTabOpeningRef.current.get(key);
      const openingScoped = opening !== undefined
        && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId;
      const record = sidebarTabRecordsRef.current.get(key);
      const recordScoped = record !== undefined
        && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
      if (entry.intent === "open") {
        if (openingScoped) {
          // 这次打开仍在途：把它的来源改成 manual，落地后就是手动 tab（绝不并发第二次 openResource）。
          opening.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
          sidebarManualIntentRef.current.delete(key);
          return;
        }
        if (recordScoped) {
          // 用户手动打开 = 他重新要这个会话：清除抑制，并把来源收回 manual（Auto 不得再自动关它）。
          record.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
          writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-open");
          sidebarAutoSuppressedRef.current.delete(key);
          sidebarAutoOriginRef.current.delete(key);
          // 手动接管这个 key：未结算的自动关闭预算（含 owner）一并作废，Auto 不得再按旧预算重试。
          clearAutoCloseAttempt(key);
          sidebarManualIntentRef.current.delete(key);
          return;
        }
        sidebarManualIntentRef.current.delete(key);
        void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
        return;
      }
      // intent === "close"
      if (recordScoped) {
        sidebarManualIntentRef.current.delete(key);
        // 手动关闭信号在这里就落持久标记（抑制写入要等验证收口，太晚；手动恒优先必须立刻生效）。
        writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
        void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
        return;
      }
      if (openingScoped) {
        /**
         * 打开仍在途、此刻没有可精确关闭的 tabId：抑制先登记（用户要的是关闭，Auto 不得重开），
         * 意图保留到它落地或超时——由同一条同步链路再结算一次，绝不在没有 tabId 时猜一个 id 去关。
         */
        sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
        trimAutoKeyMap(sidebarAutoSuppressedRef.current);
        writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
        return;
      }
      // 没有可关闭的 tab：只登记抑制与撤销自动记账，绝不为了「执行关闭」先打开一个 tab。
      sidebarManualIntentRef.current.delete(key);
      sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
      trimAutoKeyMap(sidebarAutoSuppressedRef.current);
      writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
      sidebarAutoOriginRef.current.delete(key);
      // 手动关闭意图接管这个 key：未结算的自动关闭预算（含 owner）一并作废。
      clearAutoCloseAttempt(key);
    }

    /**
     * 右栏 tab 的完整同步入口（挂载 effect / 2.5 秒轮询 / sessions 通知 / observer / 可见性变化
     * 全部只经由它）：先跑既有的记录/库存同步，再跑 Auto 自动同步。
     *
     * 顺序不可颠倒：自动打开必须建立在「库存与在途记录已经结算完」的基础上，否则同一个资源
     * 会被先记录再打开，重复消耗 pane。
     */
    function syncSidebarTabs() {
      /**
       * 外部同步轮（挂载 / 2.5 秒轮询 / observer / 可见性变化 / 会话通知）都是新的一轮：自动动作的
       * 失败屏障在这里失效，因此同一个资源仍然可以被重试。自动动作收尾的那条尾随同步例外——它
       * 只是同一批微任务里的推进，不构成「宿主状态可能已经改变」的新证据。
       */
      if (sidebarAutoCascadeRef.current !== true) sidebarAutoFailedKeysRef.current.clear();
      syncSidebarTabRecords();
      // 关闭请求的验证链先跑：上一轮 close 的验证结果必须先收口，候选选择才按真实归属推进。
      verifyPendingSidebarCloses();
      // Auto 开关是渲染输入：设置页保存或面板自身切换后必须重渲染一次（标题栏开关的勾选态）。
      // 与批量签名同一模式：只有真的变化才 bump，空闲轮询绝不产生重渲染。
      const autoNow = autoOpenEnabled();
      if (sidebarAutoSignatureRef.current !== autoNow) {
        sidebarAutoSignatureRef.current = autoNow;
        /**
         * 开关的权威值一变（含关闭）就推进自动动作代次：已经发出、仍在等待 split/layout 的在途
         * 自动动作会在下一次复核时放弃——「关闭 Auto」必须立刻取消还没落地的自动打开，而不是
         * 等它把 tab 打开之后再交给用户手动关。已存在的 tab 不受影响（关闭 Auto 绝不自动关 tab）。
         */
        sidebarAutoEpochRef.current += 1;
        // 权威值变化后丢弃本地乐观值，开关始终收敛到读出的事实。
        setAutoOpenDraft(null);
        bump((value) => value + 1);
      }
      syncAutoSidebarTabs();
    }

    return Object.freeze({
      abandonAutoSidebarAction,
      applyPendingManualIntent,
      autoActionStillValid,
      autoTakeoverStateOf,
      launchAutoSidebarAction,
      recordSidebarManualIntent,
      releaseAutoCloseAttempt,
      syncAutoSidebarTabs,
      syncSidebarTabs,
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarActions });
})(globalThis);
