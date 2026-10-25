/**
 * 客户端侧栏 · Panel 自定义 Hook（effect / 订阅 / 定时器）
 *
 * 这些 Hook 由 client-sidebar-panel.js 的 Panel 组件按**固定顺序**调用；每个 Hook 内部
 * 的 react.use* 调用顺序、effect 依赖数组、setup / cleanup 归属都与拆分前逐字相同。
 * 拆分只把原来同一个函数体里的连续语句段移进独立函数，因此运行期 Hook 派发序列不变。
 */
(function installSidebarPanelHooksEffects(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-effects");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    ANNOUNCEMENT_MAX_ITEMS, collectAnnouncementTasks, collectSnapshotSessionIds, normalizeSessionModelView, object, safeNormalize,
    sessionModelRolesOf, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    methodOf, subscribeSessions,
  } = DOM;
  const POLL_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-poll");
  const POLL = global[POLL_SYMBOL] || {};
  const {
    PANEL_ERROR_SOURCES, PANEL_POLL_TIMINGS, applyPanelPollCycle, callRpc, fanoutBatchIsStale, panelNextPollDelayMs,
    readFanoutEventBatch, samePanelSnapshot, snapshotHasRunningWork,
  } = POLL;
  const PANEL_STATE_A_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
  const PANEL_STATE_A = global[PANEL_STATE_A_SYMBOL] || {};

  /** 任务状态播报 effect：快照差异 → aria-live 文本。 */
  function useSidebarPanelAnnouncementEffect(frame) {
    const {
      announcerRef, panelLocale, react, rootSessionId, setAnnouncement, state,
      t,
    } = frame;

    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (state.snapshot === null) return;
        const tasks = collectAnnouncementTasks(state.snapshot);
        // 基线推进与差异计算归 panel-state-a（纯函数）：首次挂载 / 换 root 只建立基线不播历史。
        const update = PANEL_STATE_A.nextAnnouncementBaseline(announcerRef.current, rootSessionId, tasks);
        announcerRef.current = update.baseline;
        if (update.events.length === 0) return;
        setAnnouncement(PANEL_STATE_A.announcementTextOf({
          events: update.events,
          t,
          locale: panelLocale,
          maxItems: ANNOUNCEMENT_MAX_ITEMS,
        }));
      }, [state.snapshot, rootSessionId]);
    }

  }

  /** 「会话模型」读取、目录订阅、原生 dialog 与焦点归还四条 effect。 */
  function useSidebarPanelSessionModelEffects(frame) {
    const {
      config, contextRef, loadMeta, metaStateRef, mountedRef, react,
      rootSessionId, sessionModelDialogRef, sessionModelEntryRef, sessionModelLoadedRootRef, sessionModelOpen, sessionModelReloadToken,
      sessionModelRequestSerialRef, sessionModelSurfaceRef, sessionModelWasOpenRef, setSessionModelCatalog, setSessionModelDrafts, setSessionModelNotice,
      setSessionModelSaving, setSessionModelState, sidebarSessionId,
    } = frame;

    /**
     * 「会话模型」读取 effect：展开编辑区、切换 root、点「重新读取」各跑一次。
     *
     * 边界（与设置页 useSessionOverrideSection 逐条对齐）：
     * - 折叠时直接返回：不发 session-override-* RPC、也不读 meta；
     * - 没有 root（未打开会话）⇒ no-session；当前视图是子代理会话 ⇒ child，两者都不发 RPC；
     * - 否则先读 meta（复用单飞 loadMeta，失败时用渲染期快照 metaStateRef 兜底）再判能力：
     *   Host 明确声明不支持时降级为 unsupported，绝不发一个大概率被拒的请求；
     * - 请求代次 + cancelled 标记丢弃迟到响应：关闭/切会话/连续重读都不会把旧结果写回界面。
     */
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (sessionModelOpen !== true) return () => {};
        const targetSessionId = rootSessionId;
        // surface 身份变化（含 root→子会话、子会话→root、A→B→A）都算「换了一块界面」：
        // 旧 surface 的在途写入再也不会被采纳，它的保存锁必须立刻释放，否则新 surface
        // 的保存/清除按钮会被一条已经不属于这里的请求一直锁住。
        const previousSurface = sessionModelSurfaceRef.current;
        const surfaceChanged = previousSurface.rootSessionId !== rootSessionId
          || previousSurface.sidebarSessionId !== sidebarSessionId;
        sessionModelSurfaceRef.current = { rootSessionId, sidebarSessionId };
        if (surfaceChanged === true) setSessionModelSaving(false);
        // 旧 root 的成功/冲突/失败提示不属于新 surface：root 一变立即清掉，
        // 不等新 root 的读取结果（新读取可能失败、也可能很慢，旧提示不能一直挂着）。
        // 草稿仍只在真正读到权威覆盖后才清（同一 root 的手动重读必须保留用户输入）。
        if (sessionModelLoadedRootRef.current !== targetSessionId) setSessionModelNotice(null);
        if (targetSessionId === "" || sidebarSessionId !== targetSessionId) {
          sessionModelRequestSerialRef.current += 1;
          sessionModelLoadedRootRef.current = null;
          setSessionModelDrafts({});
          setSessionModelNotice(null);
          setSessionModelSaving(false);
          setSessionModelState({
            status: targetSessionId === "" ? "no-session" : "child",
            overrides: {},
            revision: 0,
            live: false,
          });
          return () => {};
        }
        let cancelled = false;
        sessionModelRequestSerialRef.current += 1;
        const serial = sessionModelRequestSerialRef.current;
        // 保留上一份覆盖数据只把状态切到 loading：重读期间界面不闪成空表。
        setSessionModelState((previous) => (previous.status === "ready"
          ? { ...previous, status: "loading" }
          : { status: "loading", overrides: {}, revision: 0, live: false }));
        void (async () => {
          // 模型目录与 meta 并行读取：目录只做输入提示，慢一点不影响覆盖读取。
          try {
            const pending = config.modelCatalog?.load?.();
            if (pending !== null && pending !== undefined && typeof pending.catch === "function") pending.catch(() => {});
          } catch { /* 目录加载失败不阻塞覆盖读取：输入框仍可手填。 */ }
          const loaded = await loadMeta();
          if (cancelled === true || serial !== sessionModelRequestSerialRef.current) return;
          const effectiveMeta = loaded !== null ? loaded : metaStateRef.current;
          if (effectiveMeta !== null && effectiveMeta.capabilities.sessionOverride !== true) {
            setSessionModelState({ status: "unsupported", overrides: {}, revision: 0, live: false });
            return;
          }
          let body;
          try {
            body = await callRpc(
              config,
              contextRef.current,
              { action: "session-override-get", sessionId: targetSessionId },
              {},
              (value) => object(value),
            );
          } catch (error) {
            if (cancelled === true || serial !== sessionModelRequestSerialRef.current) return;
            // 能力未知（meta 读失败）时旧宿主会对未知 action 回 bad-request：按「版本不支持」呈现，
            // 比一直停在「读取失败」更诚实。
            const code = text(object(error).code, null);
            setSessionModelState({
              status: code === "bad-request" && effectiveMeta === null ? "unsupported" : "error",
              overrides: {},
              revision: 0,
              live: false,
            });
            return;
          }
          if (cancelled === true || serial !== sessionModelRequestSerialRef.current) return;
          const roles = sessionModelRolesOf(effectiveMeta);
          const view = normalizeSessionModelView(body, roles);
          if (view === null) {
            setSessionModelState({ status: "error", overrides: {}, revision: 0, live: false });
            return;
          }
          // 只有 root 真的换了才清草稿：同一会话的手动重读必须保留用户未提交的输入。
          if (sessionModelLoadedRootRef.current !== targetSessionId) setSessionModelDrafts({});
          sessionModelLoadedRootRef.current = targetSessionId;
          setSessionModelState({ status: "ready", overrides: view.overrides, revision: view.revision, live: view.live });
        })();
        return () => { cancelled = true; };
      }, [sessionModelOpen, rootSessionId, sidebarSessionId, sessionModelReloadToken, config]);
    }

    /**
     * 模型目录订阅（只在本区展开时）：目录 store 与设置页是同一份单飞实例。
     *
     * 这里只做只读订阅（getSnapshot + subscribe）；目录的加载/刷新仍由该 store 自己管理。
     * 折叠或卸载即退订，避免面板常驻时白跑回调。
     */
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (sessionModelOpen !== true) return () => {};
        const catalog = config.modelCatalog;
        if (catalog === null || catalog === undefined || typeof catalog !== "object") return () => {};
        const read = () => {
          if (mountedRef.current !== true) return;
          try {
            const snapshot = typeof catalog.getSnapshot === "function" ? catalog.getSnapshot() : null;
            const source = object(snapshot);
            setSessionModelCatalog({
              groups: Array.isArray(source.groups) ? source.groups : [],
              status: text(source.status, "idle"),
            });
          } catch {
            // 目录读取抛错按「没有目录」降级：输入框仍可手填，绝不伪造候选。
            setSessionModelCatalog({ groups: [], status: "error" });
          }
        };
        read();
        let unsubscribe = null;
        try {
          if (typeof catalog.subscribe === "function") unsubscribe = catalog.subscribe(read);
        } catch { unsubscribe = null; }
        return () => { if (typeof unsubscribe === "function") unsubscribe(); };
      }, [sessionModelOpen, config]);
    }

    /**
     * 打开时把 dialog 真正弹到 top layer。
     *
     * 必须走原生 showModal()：右栏容器带 overflow/transform，普通定位的浮层会被裁剪，
     * 只有 top layer 能覆盖整页。已打开（node.open === true）不重复调用（showModal 对
     * 已打开对话框会抛 InvalidStateError）；ref 未挂载、宿主不支持 showModal（测试替身 /
     * 极旧 WebView）时静默跳过——弹窗内容仍然渲染在树里，绝不因为缺少 DOM 能力而报错。
     */
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (sessionModelOpen !== true) return;
        const node = sessionModelDialogRef.current;
        if (node === null || node === undefined) return;
        if (node.open === true) return;
        try {
          if (typeof node.showModal === "function") node.showModal();
        } catch { /* 宿主拒绝 showModal（已打开/非活动文档）时保持当前可见性。 */ }
      }, [sessionModelOpen]);
    }

    /**
     * 关闭弹窗后把焦点还给入口按钮（无障碍：键盘用户不能掉回文档开头）。
     *
     * 只在「上一帧打开 → 这一帧关闭」这一次转换上执行：首次挂载时 wasOpen=false，
     * 用户从未打开过，绝不抢焦点。ref 在测试替身里不会真正挂载（current 为 null），
     * 因此用可选调用 + try/catch：任何宿主上焦点归还失败都不得让关闭语义崩掉。
     */
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        const wasOpen = sessionModelWasOpenRef.current === true;
        sessionModelWasOpenRef.current = sessionModelOpen === true;
        if (wasOpen !== true || sessionModelOpen === true) return;
        const entry = sessionModelEntryRef.current;
        try {
          if (entry !== null && entry !== undefined && typeof entry.focus === "function") entry.focus();
        } catch { /* 宿主拒绝聚焦时忽略：关闭已经生效，焦点位置不是阻断条件。 */ }
      }, [sessionModelOpen]);
    }

  }

  /** 快照与轮询的单飞状态 ref、fanout 游标及其推进。 */
  function useSidebarPanelSnapshotRefs(frame) {
    const {
      react, rootSessionId, state,
    } = frame;

    const refreshStateRef = typeof react.useRef === "function"
      ? react.useRef({ rootSessionId: null, inFlight: null, pending: false })
      : { current: { rootSessionId: null, inFlight: null, pending: false } };
    /**
     * fanout 事件游标（票据 15）：{ rootSessionId, cursor }，只描述「本实例当前 root 已经读到哪」。
     *
     * 语义边界：
     * - 起始值 0 = 「从头读保留窗口」（Host 的 getEvents 以 0 为起点），不是伪造的对齐位置；
     * - 切换 root 时重置（旧 root 的游标对新 root 没有意义）；A→B→A 同样从头读，
     *   多读一轮事件最多触发一次全量快照，绝不会漏事件；
     * - 只在**真正读到** Host 返回的 cursor 时推进：请求失败、响应缺字段、被取消、旧代次
     *   一律原地不动 —— 下一轮用同一个游标重读，宁可重复也绝不把未确认的区间当成已同步。
     */
    const fanoutCursorRef = typeof react.useRef === "function"
      ? react.useRef({ rootSessionId, cursor: 0 })
      : { current: { rootSessionId, cursor: 0 } };
    // root 归属规整（换 root 即重开 cursor:0）归 panel-state-a；同一 root 返回同一对象。
    fanoutCursorRef.current = PANEL_STATE_A.normalizeFanoutCursor(fanoutCursorRef.current, rootSessionId);
    /**
     * 最近一次渲染提交的快照（票据 16）。
     *
     * 调度器在 effect 闭包里运行，它看到的 state 永远停留在挂载那一帧；
     * 而「还有没有运行中的任务」「当前是不是轻量快照」必须按**最新上屏**的数据回答。
     * 渲染期同步写入这个引用（与 refreshRef / sidebarTabSyncRef 同一写法），读取者只做纯读。
     */
    const latestSnapshotRef = typeof react.useRef === "function"
      ? react.useRef(state.snapshot)
      : { current: state.snapshot };
    latestSnapshotRef.current = state.snapshot;
    /**
     * 最近一次渲染提交的错误槽（票据 15 的失败恢复）。
     *
     * 用途只有一个：上一轮**快照**读取失败时，下一轮轮询必须直接重试整棵快照。
     * 少了这条规则，事件读面一旦健康（无事件）就会让快照错误与旧数据永久挂在界面上——
     * 失败的自动恢复因此不能只依赖「有事件」。
     */
    const latestPanelErrorRef = typeof react.useRef === "function"
      ? react.useRef(state.error)
      : { current: state.error };
    latestPanelErrorRef.current = state.error;
    /**
     * 增量轮询的单飞状态（票据 15）：{ rootSessionId, inFlight, pending }。
     *
     * 与 refreshStateRef 分工不同：那条链路保护**快照请求**（通知/手动/动作尾随共用），
     * 这条保护**一轮增量同步**（先 fanout-events、必要时再快照）。两者都有「单飞 + 一次尾随」：
     * 在途期间到来的轮询只记一次 pending，结算后立刻补跑一轮，绝不并发堆请求。
     */
    const pollSyncStateRef = typeof react.useRef === "function"
      ? react.useRef({ rootSessionId: null, inFlight: null, pending: false })
      : { current: { rootSessionId: null, inFlight: null, pending: false } };
    /** 轮次序号：同一轮结果被多个 tick 观察到时，调度器据此只记账一次（见 applyPanelPollCycle）。 */
    const pollCycleSequenceRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
    /**
     * 采纳一次快照响应里出现的游标（票据 15 的强制全量路径）。
     *
     * Host 当前的 expert-group-snapshot 响应**不带** cursor（契约只有 snapshot + revision），
     * 因此这里按「有就采纳、没有就保持」处理：
     * - 返回 false 时调用方什么都不做，下一轮 fanout-events 继续用当前游标（绝不伪造一个进度）；
     * - 只接受本 root 的响应：旧 root 的迟到响应不得改写新 root 的游标。
     */
    const adoptFanoutCursorFromSnapshot = (requestRoot, envelope) => {
      // 游标推进规则（只认本 root / 绝不伪造进度）归 panel-state-a；这里只负责写回自己的 ref。
      const next = PANEL_STATE_A.adoptFanoutCursor(fanoutCursorRef.current, requestRoot, envelope);
      if (next === null) return false;
      fanoutCursorRef.current = next;
      return true;
    };

    Object.assign(frame, {
      adoptFanoutCursorFromSnapshot, fanoutCursorRef, latestPanelErrorRef, latestSnapshotRef, pollCycleSequenceRef, pollSyncStateRef,
      refreshStateRef,
    });
  }

  /**
   * 快照刷新的单飞动作（从 useSidebarPanelPolling 抽出，逻辑逐字保留）。
   *
   * 单飞 + 尾随合并的判定留在本函数里；一次请求的完整生命周期（成功/失败/取消/代次
   * 门禁、缓存写入与状态提交）交给 fetchPanelSnapshot。拆开只是为了让两段各自可读，
   * 调用顺序、状态写入时机与返回值形状都与拆分前逐字相同。
   */
  function createPanelRefreshAction(deps) {
    const {
      adoptFanoutCursorFromSnapshot, config, contextRef, mountedRef, peekCachedSnapshot,
      refreshStateRef, requestSequenceRef, rootSessionId, setState, writeCachedSnapshot,
    } = deps;

    return function refresh(refreshOptions) {
      // 手动刷新（标题栏的刷新/重试按钮）即使内容完全一致也要提交一次新的更新时间：用户点了
      // 刷新，界面必须给出「已经刷新过」的可见反馈。自动轮询/通知/尾随刷新绝不走这条分支，
      // 「内容相等不重渲染」的契约因此逐字不变。
      const commitManualTimestamp = refreshOptions?.manual === true;
      const refreshState = refreshStateRef.current;
      // 同一组件实例切换 root 时，立即放弃旧请求；旧 Promise 的 finally 通过对象身份检查，
      // 不会清理或触发新 root 的请求。
      if (refreshState.rootSessionId !== rootSessionId) {
        refreshState.inFlight?.controller?.abort?.();
        refreshState.inFlight = null;
        refreshState.pending = false;
        refreshState.rootSessionId = rootSessionId;
      }
      if (refreshState.inFlight !== null) {
        // 通知、轮询和手工重试在同一请求期间只合并成一次尾随刷新。
        refreshState.pending = true;
        // merged 标记（票据 15）：这次「刷新」复用的是**别人**在更早时刻发出的快照请求。
        // 增量轮询据此拒绝推进游标——那份响应可能早于它刚读到的事件，
        // 推进游标就等于把这段事件当成了已上屏，界面会停在旧数据上直到下一次事件。
        return refreshState.inFlight.promise.then((outcome) => (typeof outcome === "object" && outcome !== null
          ? { ...outcome, merged: true }
          : { ok: false, snapshot: null, merged: true }));
      }
      const requestSequence = ++requestSequenceRef.current;
      if (rootSessionId === "") {
        setState({ rootSessionId, snapshot: null, updatedAt: null, loading: false, error: null });
        // 空 root 不是失败：返回成功结果，调度器按「没有任务」进入空闲退避。
        return Promise.resolve({ ok: true, snapshot: null, skipped: true });
      }
      const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
      const request = { rootSessionId, requestSequence, controller, promise: null };
      refreshState.inFlight = request;
      // 切换 root 时目标 root 的缓存快照必须在**事件路径**里预先读好（纯读，不重排 LRU）：
      // setState 的 updater 可能被 React 在渲染期调用、也可能在 StrictMode 下被调用两次，
      // updater 里读缓存（旧实现）就等于把缓存访投放回渲染阶段。
      const cachedBaseline = peekCachedSnapshot(rootSessionId);
      setState((previous) => {
        if (previous.rootSessionId === rootSessionId) {
          // 同一 root：保留当前快照（尾随刷新绝不清屏）。状态本身没有变化（没有待展示的错误、
          // loading 语义与当前快照一致）时返回原对象 —— React 直接 bail out，2.5s 轮询与
          // 会话通知的空转不再产生任何重渲染。
          //
          // 错误清理语义（票据 13）：开始一轮刷新只清 snapshot/rpc 错误（它们会被本次请求的结果
          // 重新裁决）；**action 错误必须留下**，否则「动作刚失败 → 2.5 秒轮询开始 → 错误被
          // 无声清掉」会让用户看不到动作失败。它只由下一次动作或手动刷新/重试清除。
          const nextLoading = previous.snapshot === null;
          const keptError = previous.error !== null && previous.error.source === PANEL_ERROR_SOURCES.action
            ? previous.error
            : null;
          if (previous.error === keptError && previous.loading === nextLoading) return previous;
          return {
            rootSessionId,
            snapshot: previous.snapshot,
            updatedAt: previous.updatedAt,
            loading: nextLoading,
            error: keptError,
          };
        }
        // 切换 root：用目标 root 的缓存快照顶首屏，缓存未命中仍然是「snapshot=null + loading」
        // 的 skeleton 语义。缓存按 root 隔离，因此这里绝不会把旧 root 的内容显示到新 root 上；
        // 错误与更新时间同样按 root 重建（上一次失败绝不带到新会话的首屏）。
        return {
          rootSessionId,
          snapshot: cachedBaseline === null ? null : cachedBaseline.snapshot,
          updatedAt: cachedBaseline === null ? null : cachedBaseline.updatedAt,
          loading: cachedBaseline === null,
          error: null,
        };
      });
      const promise = fetchPanelSnapshot({
        adoptFanoutCursorFromSnapshot, cachedBaseline, commitManualTimestamp, config, contextRef, controller,
        mountedRef, outcomeReason: text(refreshOptions?.reason, "refresh"), refresh, refreshState, request,
        requestSequence, requestSequenceRef, rootSessionId, setState, writeCachedSnapshot,
      });
      request.promise = promise;
      return promise;
    };
  }

  /**
   * 一次快照请求的完整生命周期：发 RPC、代次/surface 门禁、缓存与状态提交、失败收口、
   * 尾随刷新串联。返回给调用方的结果对象只服务增量轮询的调度器（失败/空闲退避）。
   */
  async function fetchPanelSnapshot(ctx) {
    const {
      adoptFanoutCursorFromSnapshot, cachedBaseline, commitManualTimestamp, config, contextRef, controller,
      mountedRef, outcomeReason, refresh, refreshState, request, requestSequence, requestSequenceRef,
      rootSessionId, setState, writeCachedSnapshot,
    } = ctx;

    // 本次刷新的结果（票据 15/16）：{ ok, snapshot, aborted, stale, reason }。
    // 刷新本身仍然只负责状态写入与错误语义；结果对象只服务增量轮询的调度器
    // （失败退避 / 空闲退避 / 运行态判定），不改变任何既有调用方看到的行为。
    let outcome = { ok: false, snapshot: null, reason: outcomeReason };
    try {
      // 用带 select 的调用拿完整 envelope：快照本体之外，Host 若在顶层给出 cursor，
      // 这里必须能读到它（票据 15 的强制全量路径）。不传 select 的调用方行为逐字不变。
      const envelope = await callRpc(
        config,
        contextRef.current,
        { action: "expert-group-snapshot", sessionId: rootSessionId },
        controller === null ? {} : { signal: controller.signal },
        (body) => object(body),
      );
      // 兼容两种响应形状：Host 的 { ok, snapshot } 信封，或旧替身/旧 Host 直接给快照本体。
      const raw = envelope.snapshot === undefined || envelope.snapshot === null ? envelope : envelope.snapshot;
      const next = safeNormalize(raw);
      if (next === null) throw new Error("快照格式无效");
      // 提交门禁：只有当前请求、当前 root 且页面仍挂载时才允许写状态/缓存，防止旧 surface
      // 的慢响应覆盖新会话，同时保证一次尾随刷新不会被旧请求的收尾逻辑吞掉。
      // 先算出门禁结论再写 outcome：过期响应的 ok 必须是「未提交」（stale），
      // 否则增量轮询会误以为这次快照成功并推进游标（票据 15 的游标只随成功提交前进）。
      const current = mountedRef.current === true
        && refreshState.inFlight === request
        && requestSequence === requestSequenceRef.current
        && rootSessionId === request.rootSessionId;
      outcome = { ok: true, snapshot: next, stale: current !== true, reason: outcome.reason };
      if (current) {
        // 只有真正上屏的这份成功快照进缓存：被取消、过期或失败的响应都不写。
        // 写入同时完成 LRU 提权：正在被观察的 root 由它自己的成功拉取保持新鲜
        // （渲染期不再有任何重排，因此提权只能发生在这里）。
        //
        // 时间戳只在这里取一次（事件路径），并同时写进缓存与状态：状态里的提交基线与
        // 重挂载首屏的缓存时间因此同源，不可能出现两份互相矛盾的基线。
        // （标题栏的「更新于」文本已按用户要求移除，updatedAt 只服务这条同源基线与手动刷新语义。）
        const updatedAt = Date.now();
        writeCachedSnapshot(rootSessionId, next, updatedAt);
        // 强制全量路径（票据 15）：响应带 cursor 就采纳并重建游标；Host 当前不带，
        // 则保持当前游标（下一轮 fanout-events 从它继续），绝不伪造一个「已对齐」。
        adoptFanoutCursorFromSnapshot(rootSessionId, envelope);
        setState((previous) => {
          // 内容级比较：Host 每次响应都是全新对象（generatedAt 还是新的 Date.now()），
          // 引用不同但上屏内容深度相等时不产生新状态 —— React 直接 bail out，
          // 大任务树空闲时每 2.5s 的全树重渲染就此消失。真实变化一定更新，绝不吞掉。
          //
          // 错误清理语义（票据 13）：成功快照只清 snapshot/rpc 错误；action 错误保留到
          // 下一次动作或手动刷新/重试（见 PANEL_ERROR_SOURCES 的说明）。
          const keptError = previous.error !== null && previous.error.source === PANEL_ERROR_SOURCES.action
            ? previous.error
            : null;
          // revision 短路（票据 15）：Host 的顶层 revision 是「除 generatedAt 与 revision 自身之外
          // 全部内容」的摘要，两份快照 revision 相同就意味着**上屏内容完全相同**。此时直接返回
          // 原状态对象（保留旧 snapshot 引用、零重渲染），连深比较都不做。
          //
          // 与提交基线语义冲突时的取舍（以不重渲染优先）：revision 相同 ⇒ 不更新 updatedAt。
          // 用户想要一次显式的新提交，走的是 manual 刷新（下面那一条显式排除它）。
          // samePanelSnapshot 仍然保留：旧 Host 没有 revision 时由它承担同一职责（逐字段深比较）。
          const sameRevision = typeof previous.snapshot?.revision === "string"
            && typeof next.revision === "string"
            && previous.snapshot.revision.length > 0
            && previous.snapshot.revision === next.revision;
          if (previous.rootSessionId === rootSessionId
            && previous.loading === false
            && previous.error === keptError
            && (sameRevision || samePanelSnapshot(previous.snapshot, next))
            // 手动刷新：内容一致也提交一次新状态（updatedAt 推进，等于同一毫秒时仍然 bail out）。
            // 标题栏不再显示时间后，这条路径仍由测试用 renderCount 证明「刷新没有被短路吞掉」。
            && (commitManualTimestamp !== true || previous.updatedAt === updatedAt)) return previous;
          return { rootSessionId, snapshot: next, updatedAt, loading: false, error: keptError };
        });
      }
    } catch (error) {
      const aborted = controller?.signal?.aborted === true || error?.name === "AbortError";
      const current = mountedRef.current === true
        && refreshState.inFlight === request
        && requestSequence === requestSequenceRef.current
        && rootSessionId === request.rootSessionId;
      // 结果对象：取消与旧代次都不算「刷新失败」（调度器据此不退避，见 applyPanelPollCycle）。
      outcome = { ok: false, snapshot: null, aborted, stale: current !== true, reason: outcome.reason };
      if (!aborted && current) {
        // 时间戳在事件路径取一次：setState 的 updater 必须是纯函数（StrictMode 可能调用两次）。
        const failedAt = Date.now();
        setState((previous) => {
          // 失败时保留当前 root 的最后有效快照（同实例的当前态，或该 root 的缓存快照），
          // 只在标题栏给出错误提示与重试入口；缓存未命中时仍是原来的空态语义（由渲染层的
          // 独立错误空态承担，绝不与「暂无任务」同时出现）。
          // 缓存读取同样在事件路径预先完成（cachedBaseline），updater 保持纯函数。
          const sameRoot = previous.rootSessionId === rootSessionId;
          const baseline = sameRoot
            ? previous.snapshot
            : (cachedBaseline === null ? null : cachedBaseline.snapshot);
          // 快照请求的失败**永远**归 snapshot 槽：即使底层是传输失败，用户看到的事实仍是
          // 「任务树没读到」；传输细节只进 title。动作失败因此绝不会被误标成这一类。
          const message = error instanceof Error ? error.message : String(error);
          // 同一条错误、同一份快照的重复失败同样不产生新状态：失败横幅已经在上屏，
          // 每 2.5s 重排一次标题栏没有意义（错误文案变化时才更新；at 因此表示首次出现时间）。
          if (sameRoot
            && previous.error !== null
            && previous.error.source === PANEL_ERROR_SOURCES.snapshot
            && previous.error.message === message
            && previous.loading === false
            && previous.snapshot === baseline) return previous;
          return {
            rootSessionId,
            snapshot: baseline,
            updatedAt: sameRoot ? previous.updatedAt : (cachedBaseline === null ? null : cachedBaseline.updatedAt),
            loading: false,
            error: { source: PANEL_ERROR_SOURCES.snapshot, message, at: failedAt },
          };
        });
      }
    }
    // 收尾只由「仍然是当前在途请求」的那一个负责：被取消/被取代的请求绝不清理或触发
    // 新请求的尾随刷新（与旧实现的早退语义逐字等价，只是这里还要把结果交给调用方）。
    if (refreshState.inFlight === request) {
      refreshState.inFlight = null;
      if (refreshState.pending && mountedRef.current === true && refreshState.rootSessionId === rootSessionId) {
        refreshState.pending = false;
        void refresh();
      } else {
        refreshState.pending = false;
      }
    }
    return outcome;
  }

  /**
   * 一轮增量同步（先读 fanout-events，再决定是否拉全量）与单飞 + 一次尾随的轮次循环。
   * 从 useSidebarPanelPolling 抽出：拆开后 Hook 只剩「按本帧依赖绑定」与 ref 声明。
   */
  function createPanelPollCycle(deps) {
    const {
      advanceFanoutCursor, config, contextRef, fanoutCursorRef, latestPanelErrorRef, latestSnapshotRef,
      pollCycleSequenceRef, pollSyncStateRef, pollSurfaceStillCurrent, refresh, rootSessionId,
    } = deps;

    const pollOnce = async (request) => {
      const nextId = () => {
        pollCycleSequenceRef.current += 1;
        return pollCycleSequenceRef.current;
      };
      const cancelledCycle = (outcome) => ({ id: nextId(), outcome, ok: false, cancelled: true, snapshot: null });
      // 两条「必须强制全量」的既有语义，都优先于事件探测：
      // 1. 轻量快照（partial）：Host 的 partial 只在冷读时出现，若因为「没有新事件」跳过快照，
      //    partial 可能永远停在界面上（票据 13 的升级语义会回归）；
      // 2. 上一轮快照读取失败：事件读面健康（无事件）不能让快照失败永久挂起，失败必须被重试到成功。
      const partialBaseline = latestSnapshotRef.current !== null && latestSnapshotRef.current?.partial === true;
      const lastSnapshotError = latestPanelErrorRef.current;
      const retryAfterFailure = lastSnapshotError !== null
        && lastSnapshotError !== undefined
        && lastSnapshotError.source === PANEL_ERROR_SOURCES.snapshot;
      if (partialBaseline || retryAfterFailure) {
        const full = (await refresh({ reason: partialBaseline ? "partial" : "retry" })) ?? {};
        return {
          id: nextId(),
          outcome: partialBaseline ? "partial" : "retry",
          ok: full.ok === true,
          cancelled: full.aborted === true || full.stale === true,
          snapshot: full.snapshot ?? null,
        };
      }
      const cursorBefore = fanoutCursorRef.current.rootSessionId === rootSessionId ? fanoutCursorRef.current.cursor : 0;
      let batch = null;
      try {
        const response = await callRpc(
          config,
          contextRef.current,
          { action: "fanout-events", sessionId: rootSessionId, after: cursorBefore },
          request.controller === null ? {} : { signal: request.controller.signal },
        );
        batch = readFanoutEventBatch(response);
      } catch (error) {
        const aborted = request.controller?.signal?.aborted === true || error?.name === "AbortError";
        // 取消/旧代次：这一轮作废，绝不推进游标、也绝不当成「没有变化」。
        if (aborted) return cancelledCycle("cancelled");
        // 读面不可用：降级为全量快照（旧 Host 语义），不写错误横幅。
        batch = null;
      }
      if (!pollSurfaceStillCurrent()) return cancelledCycle("stale");
      if (batch !== null && batch.conclusive) {
        if (fanoutBatchIsStale(batch, cursorBefore)) {
          // gap / 游标过旧：事件已经永久缺失，只能整棵重拉。
          const full = (await refresh({ reason: "gap" })) ?? {};
          // 只有全量**成功**后才以响应 cursor 重建游标：失败/取消时保留旧游标，下一轮重读同一段。
          // 否则一次失败的 gap 恢复会把这段事件当成「已处理」，界面就永久停在旧数据上。
          if (full.ok === true && full.stale !== true && full.merged !== true) advanceFanoutCursor(batch.cursor);
          return {
            id: nextId(),
            outcome: "gap",
            ok: full.ok === true,
            cancelled: full.aborted === true || full.stale === true,
            snapshot: full.snapshot ?? null,
          };
        }
        if (batch.events.length > 0) {
          const full = (await refresh({ reason: "events" })) ?? {};
          // 同上：快照没成功就不推进游标，这些事件下一轮还会被重读。
          if (full.ok === true && full.stale !== true && full.merged !== true) advanceFanoutCursor(batch.cursor);
          return {
            id: nextId(),
            outcome: "events",
            ok: full.ok === true,
            cancelled: full.aborted === true || full.stale === true,
            snapshot: full.snapshot ?? null,
          };
        }
        // 无事件且无缺口：游标推进是安全的（Host 明确回答「游标之后什么都没有」）。
        // 但「没有 fanout 事件」不等于「快照没有变化」：运行中的 turn 会在没有 fanout 事件时
        // 持续推进墙钟（turn/start 也不会产生 fanout 事件）。因此在运行态必须走一次全量刷新，
        // 让「用时」与 DSH 状态行一样实时；空闲态仍走「不请求快照、零重渲染」的既有契约。
        advanceFanoutCursor(batch.cursor);
        if (snapshotHasRunningWork(latestSnapshotRef.current)) {
          const full = (await refresh({ reason: "running" })) ?? {};
          return {
            id: nextId(),
            outcome: "running",
            ok: full.ok === true,
            cancelled: full.aborted === true || full.stale === true,
            snapshot: full.snapshot ?? null,
          };
        }
        return { id: nextId(), outcome: "none", ok: true, cancelled: false, snapshot: null };
      }
      // 不可判定（缺 events 数组 / 读面失败）：全量降级。
      const fallback = (await refresh({ reason: "events-unavailable" })) ?? {};
      return {
        id: nextId(),
        outcome: "fallback",
        ok: fallback.ok === true,
        cancelled: fallback.aborted === true || fallback.stale === true,
        snapshot: fallback.snapshot ?? null,
      };
    };

    /**
     * 跑一轮（含尾随）增量同步：单飞 + 一次尾随，与 refresh 的 pending 语义同构。
     *
     * 在途期间到来的轮询只记一次 pending；结算后立刻补跑**一轮**，绝不并发堆请求。
     * 结果对象带回给调度器记账（失败退避 / 空闲退避 / 运行态判定）。
     */
    const runPollCycle = () => {
      const state = pollSyncStateRef.current;
      if (state.rootSessionId !== rootSessionId) {
        // 切换 root：旧 root 的在途轮询立刻取消，尾随标记清零（旧结果绝不写回新 surface）。
        state.inFlight?.controller?.abort?.();
        state.inFlight = null;
        state.pending = false;
        state.rootSessionId = rootSessionId;
      }
      if (state.inFlight !== null) {
        state.pending = true;
        return state.inFlight.promise;
      }
      const request = {
        rootSessionId,
        controller: typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null,
        promise: null,
      };
      state.inFlight = request;
      const promise = (async () => {
        let cycle = null;
        try {
          cycle = await pollOnce(request);
          while (state.pending && state.inFlight === request && pollSurfaceStillCurrent()) {
            state.pending = false;
            cycle = await pollOnce(request);
          }
        } catch {
          // pollOnce 内部已把 RPC 失败降级为全量；万一仍抛错，按一次失败收口，
          // 绝不让调度器停在「以为还有一轮在途」的状态。
          pollCycleSequenceRef.current += 1;
          cycle = { id: pollCycleSequenceRef.current, outcome: "error", ok: false, cancelled: false, snapshot: null };
        } finally {
          if (state.inFlight === request) state.inFlight = null;
          state.pending = false;
        }
        return cycle;
      })();
      request.promise = promise;
      return promise;
    };

    return { pollOnce, runPollCycle };
  }

  /** 快照刷新、增量轮询与可暂停调度器（含全部定时器与请求收口）。 */
  function useSidebarPanelPolling(frame) {
    const {
      adoptFanoutCursorFromSnapshot, config, contextRef, fanoutCursorRef, latestPanelErrorRef, latestSnapshotRef,
      mountedRef, peekCachedSnapshot, pollCycleSequenceRef, pollSyncStateRef, react, refreshStateRef,
      requestSequenceRef, rootSessionId, setState, sidebarSurfaceStillCurrent, state, writeCachedSnapshot,
    } = frame;

    /**
     * 把事件游标推进到 max(当前, 给定值)（票据 15）：null/非法值表示 Host 没给游标 ⇒ 原地不动，
     * 绝不伪造一个进度；只接受本 root 的推进（旧 root 的迟到结果不得改写新 root 的游标）。
     */
    const advanceFanoutCursor = (nextCursor) => {
      // 推进判据（非法值 / 跨 root / 非前进一律原地不动）归 panel-state-a；这里只写回自己的 ref。
      const next = PANEL_STATE_A.advanceFanoutCursor(fanoutCursorRef.current, rootSessionId, nextCursor);
      if (next === null) return false;
      fanoutCursorRef.current = next;
      return true;
    };
    /**
     * 刷新动作与单轮增量同步：实现分别在 createPanelRefreshAction / createPanelPollCycle，
     * 这里只按本帧依赖（ref、root、setState 等）绑定出同一批函数。
     */
    const refresh = createPanelRefreshAction({
      adoptFanoutCursorFromSnapshot, config, contextRef, mountedRef, peekCachedSnapshot, refreshStateRef,
      requestSequenceRef, rootSessionId, setState, writeCachedSnapshot,
    });
    /**
     * 最近一次渲染的 refresh（每次渲染同步写入）。
     *
     * refresh 是闭包：它只认自己那一轮渲染的 rootSessionId，并往对应 root 的状态边界写入。
     * runAction 的 await 可能跨越一次 root 切换，此时旧闭包的 refresh 会为**旧 root** 再发一次
     * 快照请求、并把旧 root 的状态写回新 surface。动作完成后的尾随刷新统一走这个引用，
     * 与当前渲染（也就是当前选中 root）保持一致。
     */
    const refreshRef = typeof react.useRef === "function" ? react.useRef(refresh) : { current: refresh };
    refreshRef.current = refresh;
    /**
     * 当前挂载对应的轮询调度器（票据 16）：{ timer, delay, paused, detached, failureCount,
     * idleLevel, running, lastCycleId, activityKey }。effect 每次重建（root/session 变化）都换新对象，
     * 旧对象在 cleanup 里 detached，任何迟到回调据此拒绝再排定时器或写状态。
     *
     * 读源码时注意：文中其它位置出现的「2.5 秒轮询」指**运行态的节奏**（有任务在跑）；
     * 空闲阶梯退避、失败退避与隐藏/非活跃暂停都由 PANEL_POLL_TIMINGS 与本调度器统一决定。
     */
    const panelSchedulerRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
    /** 一轮增量同步的结果是否仍属于当前 surface（挂载中 + 同一 root/session + 同一 surface 令牌）。 */
    const pollSurfaceStillCurrent = () => sidebarSurfaceStillCurrent();
    /** 单轮增量同步与单飞尾随循环：实现见 createPanelPollCycle。 */
    const { pollOnce, runPollCycle } = createPanelPollCycle({
      advanceFanoutCursor, config, contextRef, fanoutCursorRef, latestPanelErrorRef, latestSnapshotRef,
      pollCycleSequenceRef, pollSyncStateRef, pollSurfaceStillCurrent, refresh, rootSessionId,
    });

    Object.assign(frame, {
      advanceFanoutCursor, panelSchedulerRef, pollOnce, pollSurfaceStillCurrent, refresh, refreshRef,
      runPollCycle,
    });
  }

  /** 挂载 effect：会话订阅、轮询调度、可见性、外部关闭观察与卸载收口。 */
  function useSidebarPanelMountEffects(frame) {
    const {
      bump, cancelSidebarSplit, config, contextRef, latestSnapshotRef, mountedRef,
      panelSchedulerRef, pollSyncStateRef, react, refresh, refreshStateRef, releaseRightbarDragLock,
      requestSequenceRef, rootSessionId, runPollCycle, sidebarRight, sidebarSessionId, sidebarSplitIntentRef,
      sidebarTabSyncRef, tabActivityKey,
    } = frame;

    if (typeof react.useEffect === "function") {
      react.useEffect(() => runPanelMountEffect({
        bump, cancelSidebarSplit, config, contextRef, latestSnapshotRef, mountedRef, panelSchedulerRef,
        pollSyncStateRef, refresh, refreshStateRef, releaseRightbarDragLock, requestSequenceRef, rootSessionId,
        runPollCycle, sidebarRight, sidebarSessionId, sidebarSplitIntentRef, sidebarTabSyncRef, tabActivityKey,
      }), [rootSessionId, sidebarSessionId]);
    }

  }

  /**
   * 挂载 effect 的实体（每次 root / sidebar session 变化重建，销毁时返回 cleanup）。
   *
   * 抽成普通函数只是把 effect 回调体搬出 Hook：setup 的语句顺序、清理的赋值顺序、
   * 以及 cleanup 里每个「停表 / 中止 / 退订 / 摘监听」的相对次序都与拆分前逐字相同。
   */
  function runPanelMountEffect(deps) {
    const {
      bump, cancelSidebarSplit, config, contextRef, latestSnapshotRef, mountedRef, panelSchedulerRef,
      pollSyncStateRef, refresh, refreshStateRef, releaseRightbarDragLock, requestSequenceRef, rootSessionId,
      runPollCycle, sidebarRight, sidebarSessionId, sidebarSplitIntentRef, sidebarTabSyncRef, tabActivityKey,
    } = deps;

    mountedRef.current = true;
    const refreshState = refreshStateRef.current;
    refreshState.rootSessionId = rootSessionId;
    refreshState.pending = false;
    void refresh();
    /**
     * sessions 通知：快照本身是**渲染输入**（运行状态圆点、目录项的活动证据与目录项
     * 都来自 sessions 快照，且是在渲染期现读的），因此这条通知必须显式 bump 一次版本号
     * 触发一次重新渲染，不能只依赖 refresh 的状态写入。
     *
     * 原因：轮询空转时 refresh 会因「内容深度相等」直接 bail out（不再产生新状态），
     * 若这里不 bump，sessions 驱动的行内状态更新就会跟着一起停掉。bump 与轮询无关：
     * 它只在宿主真的发布了新 sessions 快照时才发生，是事件驱动的必要重渲染。
     */
    const unsubscribe = subscribeSessions(config, contextRef.current, () => {
      bump((value) => value + 1);
      void refresh();
    });
    const documentRef = globalThis.document;
    /** 轮询调度器（票据 16）：定时器、退避记分与可见性/活跃度暂停全部封在下面这个工厂里。 */
    const {
      scheduler, armScheduler, clearSchedulerTimer, onVisibilityChange, pauseScheduler, pollSurfaceBlocked, resumeScheduler,
    } = createPanelPollScheduler({
      documentRef, latestSnapshotRef, panelSchedulerRef, refresh, runPollCycle, sidebarTabSyncRef, tabActivityKey,
    });
    panelSchedulerRef.current = scheduler;
    // 挂载时按当前可见性/活跃度决定是否排表：不可见/非活跃就保持暂停（恢复时立即刷新一次）。
    if (pollSurfaceBlocked() !== null) pauseScheduler();
    else armScheduler();
    try { documentRef?.addEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
    // 挂载（或切换 root 后重挂载）时立刻对齐一次：记录可能来自同一个 root 的上一个实例。
    sidebarTabSyncRef.current?.();
    /**
     * 外部关闭观察器：站在宿主已公开的 DOM 标记上观察，插件绝不改写宿主 DOM。
     *
     * 观察面固定为 document.body 子树而不是面板节点：右栏面板会迟到挂载（展开后才出现）、
     * 也会被宿主按 surface 整体重挂载，盯住具体节点会在重挂载后失联；而回调本身在没有任何
     * 打开记录时立即返回，空闲时（绝大多数时间）连一次 DOM 查询都不会发生。
     * 没有 MutationObserver / 没有 document.body / observe 抛错时静默降级为「只靠既有的
     * 自适应轮询（运行态 2.5s / 空闲退避 / 隐藏与非活跃暂停）与 visibilitychange 兜底」，
     * 绝不因为观察器缺失影响面板渲染。
     */
               let unsubscribeOpenTabs = null;
     try {
       const inventory = sidebarRight?.openTabs ?? null;
       const subscribe = methodOf(inventory, "subscribe");
       if (subscribe !== null) {
         const cleanup = subscribe.call(inventory, () => { sidebarTabSyncRef.current?.(); });
         if (typeof cleanup === "function") unsubscribeOpenTabs = cleanup;
       }
     } catch { /* 旧宿主没有公开 inventory 或订阅失败时继续靠 observer/轮询。 */ }
     let tabObserver = null;
    try {
      const doc = globalThis.document;
      const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
      const target = doc?.body ?? null;
      if (typeof Observer === "function" && target !== null && target !== undefined) {
        tabObserver = new Observer(() => { sidebarTabSyncRef.current?.(); });
        tabObserver.observe(target, { childList: true, subtree: true });
      }
    } catch {
      try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
      tabObserver = null;
    }
    return () => {
      mountedRef.current = false;
      // 面板卸载 = 这一页不再由插件渲染：立刻把手柄交还宿主（无条件解锁，方向永远安全，
      // 重新挂载后的第一次同步会按宿主证据锁回去）。
      try { releaseRightbarDragLock?.(); } catch { /* 同上。 */ }
      const splitIntent = sidebarSplitIntentRef.current;
      sidebarSplitIntentRef.current = null;
      if (splitIntent !== null && cancelSidebarSplit !== null) {
        try { cancelSidebarSplit.call(config, splitIntent.token, { reason: "unmount" }); } catch { /* 事务收口失败不能阻断卸载。 */ }
      }
      requestSequenceRef.current += 1;
      // 轮询调度器与增量同步一起停：先标记 detached，任何迟到回调都不会再排定时器或写状态。
      scheduler.detached = true;
      clearSchedulerTimer();
      if (panelSchedulerRef.current === scheduler) panelSchedulerRef.current = null;
      const pollState = pollSyncStateRef.current;
      pollState.pending = false;
      pollState.inFlight?.controller?.abort?.();
      pollState.inFlight = null;
      refreshState.pending = false;
      refreshState.inFlight?.controller?.abort?.();
      refreshState.inFlight = null;
      if (typeof unsubscribe === "function") unsubscribe();
       if (typeof unsubscribeOpenTabs === "function") unsubscribeOpenTabs();
      try { documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
      // 观察器必须与本次挂载同生共死：留一个仍在观察 body 的 observer 就是长期泄漏。
      try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
    };
  }

  /**
   * 轮询调度器（票据 16）：单一在途定时器 + 失败退避 / 空闲退避 + 可见性与活跃度暂停。
   *
   * 字段语义与拆分前逐字相同：timer / delay / paused / detached / failureCount / idleLevel /
   * running / lastCycleId / activityKey。工厂只创建对象与操作函数，不注册任何 effect。
   */
  function createPanelPollScheduler(deps) {
    const { documentRef, latestSnapshotRef, panelSchedulerRef, refresh, runPollCycle, sidebarTabSyncRef, tabActivityKey } = deps;

    const scheduler = {
      timer: null,
      delay: PANEL_POLL_TIMINGS.activeMs,
      paused: false,
      detached: false,
      failureCount: 0,
      idleLevel: 0,
      running: true,
      lastCycleId: 0,
      activityKey: tabActivityKey,
    };
    /** 文档可见性：读面抛错按可见处理（旧实现的降级语义逐字保留）。 */
    const readDocumentHidden = () => {
      try { return documentRef?.hidden === true; } catch { return false; }
    };
    const clearSchedulerTimer = () => {
      if (scheduler.timer === null) return;
      // 句柄由所在环境的 setInterval 生成，必须用同一环境的 clearInterval 释放。
      if (typeof globalThis.clearInterval === "function") {
        try { globalThis.clearInterval(scheduler.timer); } catch { /* 清理失败不影响渲染。 */ }
      }
      scheduler.timer = null;
    };
    const armScheduler = () => {
      clearSchedulerTimer();
      if (scheduler.detached === true || scheduler.paused === true) return;
      if (typeof globalThis.setInterval !== "function") return;
      try { scheduler.timer = globalThis.setInterval(runScheduledPoll, scheduler.delay); } catch { scheduler.timer = null; }
    };
    const pauseScheduler = () => {
      if (scheduler.paused === true) { clearSchedulerTimer(); return; }
      scheduler.paused = true;
      // 暂停即停表：隐藏/非活跃期间不再产生任何轮询请求（旧实现只是在下一次 tick 里跳过）。
      clearSchedulerTimer();
    };
    const resumeScheduler = (refreshImmediately) => {
      if (scheduler.detached === true) return;
      scheduler.paused = false;
      // 暂停期间不积累失败/空闲档：恢复后回到运行态节奏（并由调用方立刻刷新一次）。
      scheduler.failureCount = 0;
      scheduler.idleLevel = 0;
      scheduler.delay = panelNextPollDelayMs(scheduler);
      // 文档仍然隐藏时不排表也不刷新：可见性真正恢复时 onVisibilityChange 会再调一次本函数。
      if (readDocumentHidden()) { clearSchedulerTimer(); return; }
      armScheduler();
      if (refreshImmediately === true) void refresh();
    };
    scheduler.pause = pauseScheduler;
    scheduler.resume = resumeScheduler;
    /**
     * 本轮轮询是否应该暂停：文档隐藏或所在 tab 非活跃。
     *
     * 活跃度未知（宿主没有明确 active 字段）时**不**暂停：生产退回文档可见性这一既有判据，
     * 绝不凭「读不到活跃度」把正常观察停掉。
     */
    const pollSurfaceBlocked = () => {
      if (readDocumentHidden()) return "hidden";
      if (scheduler.activityKey === "inactive") return "inactive";
      return null;
    };
    const runScheduledPoll = () => {
      // 右栏 tab 的外部关闭同步先跑：它不依赖页面可见性（隐藏标签页里用户也可能在别处关掉
      // 这个 tab），且没有任何打开记录时立刻返回，不触碰 DOM。
      sidebarTabSyncRef.current?.();
      if (pollSurfaceBlocked() !== null) {
        // 隐藏 / 非活跃：立刻停表（回到前台或重新活跃时由 visibilitychange / 活跃度 effect 唤醒）。
        pauseScheduler();
        return;
      }
      // 刻意**不** await 整轮同步（与旧 poll 的「发起即返回」语义一致）：结算在后台链路里完成，
      // 记账后按新的延迟重排下一轮。tick 只负责发起（测试用 await intervals.tick() 观察同样成立）。
      void runPollCycle().then((cycle) => {
        if (scheduler.detached === true || panelSchedulerRef.current !== scheduler) return;
        applyPanelPollCycle(scheduler, cycle, latestSnapshotRef.current);
        armScheduler();
      });
    };
    const onVisibilityChange = () => {
      try {
        if (documentRef?.hidden !== true) {
          // 回到前台：立即刷新一次并恢复调度（票据 16）。
          resumeScheduler(true);
          // 回到前台时补一次同步：后台期间 MutationObserver 可能被浏览器节流。
          sidebarTabSyncRef.current?.();
        } else {
          // 隐藏：立刻暂停，不再排任何轮询。
          pauseScheduler();
        }
      } catch { /* 可见性通知只是加速恢复，读取失败不影响轮询。 */ }
    };

    return {
      armScheduler, clearSchedulerTimer, onVisibilityChange, pauseScheduler, pollSurfaceBlocked, resumeScheduler, scheduler,
    };
  }

  /** tab 活跃度 effect：非活跃暂停轮询、重新活跃立即刷新。 */
  function useSidebarPanelActivityEffect(frame) {
    const {
      panelSchedulerRef, react, tabActivityKey,
    } = frame;

    /**
     * tab 活跃度变化（票据 16）：非活跃暂停轮询，重新活跃立即刷新。
     *
     * 为什么是独立 effect 而不是挂载 effect 的依赖项：活跃度变化只应改变**调度状态**，
     * 绝不该像切换 root 那样重建整条挂载链路（那会释放手柄锁、取消分栏事务、重建观察器）。
     * 这里只在值真的变化时动手：首次挂载时调度器已经按当前结论排过表
     * （scheduler.activityKey 与当前值相等 ⇒ no-op），所以挂载不会重复刷新。
     */
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        const scheduler = panelSchedulerRef.current;
        if (scheduler === null || scheduler.detached === true) return;
        if (scheduler.activityKey === tabActivityKey) return;
        scheduler.activityKey = tabActivityKey;
        if (tabActivityKey === "inactive") {
          scheduler.pause?.();
          return;
        }
        // active：立即刷新一次并恢复调度；unknown：退回文档可见性判定，只恢复排表。
        scheduler.resume?.(tabActivityKey === "active");
      }, [tabActivityKey]);
    }

  }

  /** 1 秒本地时钟的间隔（只触发本地重渲染，不发起任何网络请求）。 */
  const LIVE_TICK_INTERVAL_MS = 1000;

  /**
   * 快照里是否还有「运行中且带 open turn 起点」的节点（1 秒本地时钟的启用条件）。
   *
   * turnOpenSince 由 Host 只在最后一轮仍未闭合时投影；running 布尔与 status 二选一即可，
   * 因为旧快照可能只有 status。快照来自 Host 的 JSON 投影（无环），不再自建遍历上限。
   */
  function snapshotHasLiveOpenTurn(snapshot) {
    const pending = [object(snapshot).root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === null || typeof node !== "object") continue;
      if (Number.isFinite(node.turnOpenSince) && (node.running === true || node.status === "running")) return true;
      if (Array.isArray(node.children)) pending.push(...node.children);
      if (Array.isArray(node.shards)) pending.push(...node.shards);
    }
    return false;
  }

  /**
   * 运行中 turn 的 1 秒本地重渲染时钟（A）。
   *
   * - 只在「快照里存在 running 且 turnOpenSince 有效的节点」时启动；无 open turn 立即清理，
   *   绝不留下一个空转定时器；
   * - 不做 document.hidden 判断：隐藏 tab 下浏览器本来就会节流定时器，且 tick 只触发本地渲染
   *   （权威同步仍由轮询负责，它自己会在页面隐藏时跳过）；
   * - 计数直接 +1：React state 是 number，长会话的理论增长远达不到其上限，不需要取模；
   * - 卸载/依赖变化时清掉定时器；无 open turn 时也返回空 cleanup，保持 effect 的 setup /
   *   cleanup 槽位与卸载清理顺序稳定。
   */
  function useSidebarPanelLiveTick(frame) {
    const { react, snapshot } = frame;
    const tickPair = typeof react.useState === "function" ? react.useState(0) : [0, () => {}];
    const setTick = tickPair[1];
    const liveOpenTurn = snapshotHasLiveOpenTurn(snapshot);
    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (liveOpenTurn !== true) return () => {};
        const timer = globalThis.setInterval(() => setTick((value) => value + 1), LIVE_TICK_INTERVAL_MS);
        return () => globalThis.clearInterval(timer);
      }, [liveOpenTurn]);
    }
  }

  /** 用量事实出现时懒加载一次 meta（每 root 至多一次）。 */
  function useSidebarPanelMetaEffect(frame) {
    const {
      loadMeta, metaAutoAttemptRef, metaStateRef, react, rootSessionId, usageFactPresent,
    } = frame;

    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (usageFactPresent !== true) return;
        if (metaStateRef.current !== null) return;
        if (metaAutoAttemptRef.current === rootSessionId) return;
        metaAutoAttemptRef.current = rootSessionId;
        void loadMeta();
      }, [usageFactPresent, rootSessionId]);
    }

  }

  /** 快照变化时重跑 tab 同步的 effect。 */
  function useSidebarPanelSnapshotSyncEffect(frame) {
    const {
      react, rootSessionId, sidebarSessionId, sidebarSnapshotSyncRef, sidebarTabSyncRef, snapshot,
    } = frame;

     if (typeof react.useEffect === "function") {
       react.useEffect(() => {
         const previous = sidebarSnapshotSyncRef.current;
         sidebarSnapshotSyncRef.current = { rootSessionId, sidebarSessionId, snapshot };
         if (previous.rootSessionId === rootSessionId
           && previous.sidebarSessionId === sidebarSessionId
           && previous.snapshot !== snapshot) sidebarTabSyncRef.current?.();
       }, [rootSessionId, sidebarSessionId, snapshot]);
     }

  }

  /** 投影刷新 effect：快照出现用量事实时请求一次刷新。 */
  function useSidebarPanelProjectionEffect(frame) {
    const {
      config, ctx, projectionRefreshRequestedRef, react, rootSessionId, sessionId,
      sessionStatsPresentOf, snapshot,
    } = frame;

    if (typeof react.useEffect === "function") {
      react.useEffect(() => {
        if (snapshot === null || snapshot === undefined) return;
        // 生产装配里 sessions 挂在 tab 的 ctx 上；单测/旧宿主经 createExpertGroupPanel 直接注入。
        // 方法读取本身也可能抛错（服务代理对未声明属性会抛），同样按「没有这个入口」处理。
        let service = null;
        let refreshProjections = null;
        try {
          service = config.sessions ?? ctx?.sessions ?? null;
          refreshProjections = service === null || service === undefined ? null : service.refreshProjections;
        } catch {
          service = null;
          refreshProjections = null;
        }
        if (typeof refreshProjections !== "function") return;
        const requested = projectionRefreshRequestedRef.current;
        for (const sessionId of collectSnapshotSessionIds(snapshot)) {
          if (requested.has(sessionId)) continue;
          if (sessionStatsPresentOf(sessionId) === true) continue;
          requested.add(sessionId);
          try {
            const pending = refreshProjections.call(service, sessionId);
            // 拒绝也吞掉：刷新失败只是继续显示 DEG 回退值，绝不无限重试。
            if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
              pending.catch(() => {});
            }
          } catch {
            /* 同步抛错：本会话已记账，绝不再请求第二次。 */
          }
        }
      }, [snapshot, rootSessionId]);
    }

  }

  global[SYMBOL] = Object.freeze({
    useSidebarPanelActivityEffect, useSidebarPanelAnnouncementEffect, useSidebarPanelLiveTick,
    useSidebarPanelMetaEffect, useSidebarPanelMountEffects, useSidebarPanelPolling, useSidebarPanelProjectionEffect,
    useSidebarPanelSessionModelEffects, useSidebarPanelSnapshotRefs, useSidebarPanelSnapshotSyncEffect,
  });
})(globalThis);
