/**
 * 客户端侧栏 · install 布局装配（R7 票据 25 / sidebar-install-layout）
 *
 * ## 职责边界（逐条对应源 install 段的布局装配区）
 * 1. 右栏拖拽手柄锁与首次分栏的列宽配比（两个宿主侧布局句柄）；
 * 2. 每个 surface 会话的「本次访问」记账（surfaceRecords / beginVisit / 读宿主活跃 surface）；
 * 3. 右栏过渡抑制（内联样式 + 短生命周期 MutationObserver）与延迟恢复调度；
 * 4. 视觉连续性遮罩单例；
 * 5. **右栏宽度状态的容器所有权**（6 份 Map/Set：widths / viewports / modes / prepared /
 *    active / recoveries）与其在 dispose 时的清空。
 *
 * ## 状态所有权（规格书 §状态所有权）
 * - 六份宽度容器由本模块**创建并持有**，只把**引用**交给 `sidebar-install-width` 的读写命令；
 *   dispose 中的 6 个 `Map.clear()` 只出现在本模块的 `clearWidthState()` 里。
 *   `sidebar-install-width` 因此「只持宽度读写命令，不直接 clear」——这是票据 25 的硬约束。
 * - 分栏事务表（splitTransactions）同样建在这里，但它的增删语义属于宽度/分栏命令，
 *   逐条 delete 由 width 模块的分栏命令完成；清空整表**不**走 `clear()`（原实现也没有），
 *   而是由 cancelAllSidebarSplits 逐条收口。
 * - install 的 `disposed` 标志由 coordinator 持有：本模块与其它模块都经 `frame.disposed`
 *   **实时读取**，绝不各自复制一份布尔值（复制即双 owner）。
 *
 * ## 分工
 * 本文件不注册任何宿主入口、不订阅会话、不创建 Panel：那些属于 coordinator
 * （`sidebar-install-resources`）。这里只提供「布局读面 + 布局句柄」。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-install-layout")]
 * 装配：真实依赖边为 pure / layout / overlay → 本模块 → install-resources。
 */
(function installSidebarInstallLayout(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-layout");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const { object, text } = PURE;
  const LAYOUT_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-layout");
  const LAYOUT = global[LAYOUT_SYMBOL] || {};
  const { createRightbarDragLock, createSplitTrackRatio } = LAYOUT;
  // 视觉连续性遮罩是「右栏面板本体」的 DOM 投影，装配面只有 overlay 一个提供方。
  const OVERLAY_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-overlay");
  const OVERLAY = global[OVERLAY_SYMBOL] || {};
  const { createNativeRightbarContinuityOverlay } = OVERLAY;

  /**
   * 右栏目标探测依赖的公开 DOM 标记清单：探测选择器与 MutationObserver 的 attributeFilter 共用同一份，
   * 避免出现「探测认某个标记、观察却不监听它」的漂移。
   */
  const RIGHTBAR_TARGET_MARKERS = [
    "data-sidebar-right-panel",  // 右栏面板本体
    "data-sidebar-right-open",   // 面板展开状态（动画开始）
    "data-shell-overlay",        // 覆盖层：其父元素即 AppFrame
    "data-rightbar-collapsed",   // AppFrame 折叠状态
    "data-rightbar-instant",     // AppFrame 瞬时展开状态
    // dsh-better-sidebar 0.12.x 的稳定宿主属性：宿主（body 下）出现/变化时也要重新命中目标。
    // 只在本清单末尾追加，绝不删除上面任何旧标记。
    "data-dsh-better-sidebar",
  ];
  const RIGHTBAR_TRANSITION_VAR = "--ds-transition-duration-slow";
  /**
   * 过渡抑制的兜底恢复延迟（毫秒）。
   *
   * 后台标签页、节能模式或被隐藏的 iframe 里 requestAnimationFrame 可能被严重节流甚至永不触发，
   * 因此**即使 RAF 可用也必须同时**安排一个有界 fallback timer：两条路径任一先到就取消另一方并
   * 恢复样式。250ms 足以覆盖正常两帧提交（约 32ms），又不会让 frame 长期停在 transition:none。
   */
  const RIGHTBAR_INSTANT_FALLBACK_MS = 250;

  /**
   * 收集需要临时抑制过渡的宿主元素（只认公开 DOM 标记，不依赖 CSS module class）。
   *
   * 同一元素被多个选择器命中时只返回一次（只要有一个来源是 panel 就按 panel 处理）；任何探测失败
   * （无 document、querySelector 抛错、DOM 结构不符）都返回已收集到的部分（可能为空）：
   * 调用方按「能抑制多少算多少」处理，绝不抛错。
   */
  const rightbarTransitionTargets = () => {
    const targets = [];
    const byElement = new Map(); // element → targets 下标：同一元素只保留一次
    const push = (element, kind) => {
      if (!element) return;
      const index = byElement.get(element);
      if (index !== undefined) {
        if (kind === "panel") targets[index].kind = "panel";
        return;
      }
      byElement.set(element, targets.length);
      targets.push({ element, kind });
    };
    try {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelector !== "function") return targets;
      // 先面板、后 frame：面板是可见动画（与瞬时闪烁）的真实来源。
      push(doc.querySelector("[data-sidebar-right-panel]"), "panel");
      const overlay = doc.querySelector("[data-shell-overlay]");
      if (overlay?.parentElement) push(overlay.parentElement, "frame");
      push(doc.querySelector("[data-rightbar-collapsed]"), "frame");
      push(doc.querySelector("[data-rightbar-instant]"), "frame");
      // dsh-better-sidebar 0.12.x：宿主的直接子节点中 class 含 panel 的右面板（必须排除 bottomPanel）。
      push(doc.querySelector("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"), "panel");
      // Better 的整页 margin-right 过渡挂在 #root 上：只抑制布局过渡，绝不写 transform/visibility。
      push(doc.querySelector("#root"), "frame");
    } catch { /* 探测失败：返回已收集到的部分，其余按「无法抑制」处理。 */ }
    return targets;
  }

  /**
   * AppFrame 是否报告右栏已折叠（用户手动关闭或从未展开）：
   * 折叠时不把 panel 钉成可见——那等于把用户关掉的右栏抢回来。读不到（无 document / querySelector
   * 抛错）时按「未折叠」处理，与旧行为一致。
   */
  const frameRightbarCollapsed = () => {
    try {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelector !== "function") return false;
      return doc.querySelector("[data-rightbar-collapsed]") !== null;
    } catch { return false; }
  }

  /**
   * 临时抑制右栏过渡（只在插件自动打开右栏这条路径上使用，作用域仅限本次命中的那几个元素）。
   *
   * 为什么用 CSS 变量 + 内联 transition 而不是改写 DSH：右栏面板的 .panel（transform）与 AppFrame
   * 的 .frame（grid-template-columns）、.handle（left）过渡都读 --ds-transition-duration-slow；
   * 在被抑制的元素上内联置 0ms 后，这一次变化瞬时完成，页面其它动画与用户手动拖拽完全不受影响
   * （不动 document 级样式、不写全局 CSS，也不改 DSH 源码）。内联 transition: none 同时是兜底：
   * 老版本或自定义主题若把过渡写成字面量时长，也仍然是瞬时的；对挂在 frame 之外的右栏面板而言，
   * 它还是唯一能覆盖其自身 transform 过渡的手段（frame 上的变量继承不到它）。
   *
   * 每个目标元素各自保存 transition 与变量的原值；返回的组合恢复函数按同样顺序逐元素还原，
   * 原本没有内联声明就删除。没有任何可用目标时返回 null——调用方照常调用 openRightbar，只是会播放一次动画。
   */
  const suppressRightbarTransition = () => {
    /** 已经处理过的元素：同一元素被多个选择器命中（或 observer 多次回调）时只处理一次。 */
    const handled = new Set();
    const restores = [];
    /**
     * 对一个目标元素做临时抑制。所有目标都抑制 transition 与过渡时长变量；真正的 panel
     * （pinPanel=true）额外固定 transform:none + visibility:visible。
     *
     * 为什么 panel 还需要这两项：DSH 原生 panel 的 collapsed 状态是
     * transform: translateX(100%) + visibility: hidden，open 才是 none/visible，transition 只负责滑动。
     * 只把 transition 置 0 的话，React 在 surface 切换提交里仍可能先提交 collapsed/hidden 再提交
     * expanded/open，视觉上就是右栏本体「瞬间消失又出现」的闪烁。窗口内把 transform/visibility 直接
     * 内联钉成可见状态、提交完成后按原值（含 priority）归还，才能同时消除滑动与闪烁。
     * #root 与 bottomPanel 绝不做这件事：前者只管布局过渡，后者与右栏展开无关。
     */
    const applyToElement = (element, pinPanel) => {
      let style = null;
      try { style = element.style || null; } catch { style = null; }
      if (style === null || typeof style.setProperty !== "function") return;
      /** 读内联值与优先级：没有这些 API 的最小替身一律按「无内联声明 / 无优先级」处理。 */
      const readValue = (name) => {
        try { return typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : ""; } catch { return ""; }
      };
      const readPriority = (name) => {
        try { return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(name) : ""; } catch { return ""; }
      };
      // 写入顺序固定：先过渡变量、再 transition；真正的 panel 再补 transform/visibility。
      const writes = [
        { name: RIGHTBAR_TRANSITION_VAR, value: "0ms" },
        { name: "transition", value: "none" },
      ];
      if (pinPanel === true) {
        writes.push({ name: "transform", value: "none" }, { name: "visibility", value: "visible" });
      }
      const previous = new Map();
      for (const { name } of writes) previous.set(name, { value: readValue(name), priority: readPriority(name) });
      /**
       * 恢复单个属性：只有当前值**与优先级**都仍等于本次写入时才还原旧值/旧优先级。
       * 抑制窗口内被外部（宿主、主题脚本或页面代码）改写过的属性一律保留外部状态——绝不用旧值
       * 覆盖新值，也绝不动我们没写过的东西；读不到值（style 没有 getPropertyValue）的极简 DOM
       * 替身按旧行为直接还原，兼容最小测试替身与老宿主。
       */
      const restoreIfUnchanged = (name, written, writtenPriority, prev) => {
        try {
          if (typeof style.getPropertyValue === "function" && style.getPropertyValue(name) !== written) return false;
          if (typeof style.getPropertyPriority === "function" && style.getPropertyPriority(name) !== writtenPriority) return false;
          if (prev.value === "" || prev.value === null || prev.value === undefined) style.removeProperty?.(name);
          // 还原旧值时连旧优先级一起还原（原本没有优先级就写空字符串）。
          else style.setProperty(name, prev.value, prev.priority || "");
          return true;
        } catch { return false; /* 单个还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */ }
      };
      try {
        // 内联 !important：主题若用 transition: ... !important 覆盖，这里仍要保证这一次瞬时完成；
        // 不支持 priority 参数的宿主会忽略第三个实参（等价于原来的两参写入），行为安全降级。
        for (const { name, value } of writes) style.setProperty(name, value, "important");
      } catch {
        // 写入失败：把已经写进去的属性还原掉（同样只在仍是本次写入状态时才还原），跳过这个元素。
        for (const { name, value } of writes) {
          restoreIfUnchanged(name, value, readPriority(name), previous.get(name));
        }
        return;
      }
      // 写完后回读优先级：宿主可能规范化或忽略它，恢复判定必须用「实际写入的状态」。
      // 恢复顺序与写入相反（先撤销 panel 的可见性钉住，再恢复 transition 与变量），
      // 这样「只有过渡项」的目标恢复顺序仍与旧实现一致（transition → 变量）。
      const written = [...writes].reverse().map(({ name, value }) => ({
        name,
        value,
        priority: readPriority(name),
        prev: previous.get(name),
      }));
      restores.push(() => {
        // 每个属性各自独立判定：外部改过的保留外部状态，没改过的恢复（原本无内联声明就删除）。
        for (const entry of written) {
          restoreIfUnchanged(entry.name, entry.value, entry.priority, entry.prev);
        }
      });
    };
    const applyTargets = () => {
      // 右栏本身已折叠（用户手动关闭 / 从未展开）时不钉 panel 的可见性：那是把用户关掉的右栏抢回来。
      const collapsed = frameRightbarCollapsed();
      for (const target of rightbarTransitionTargets()) {
        if (handled.has(target.element)) continue;
        handled.add(target.element);
        applyToElement(target.element, target.kind === "panel" && collapsed !== true);
      }
    };
    // 当前可查到的目标立刻内联抑制：调用方保证这一步发生在 openSurfaceTab() 之前，
    // 因为 Better/native 的 openTab 可能同步展开 panel，动画在那时就已经开始。
    applyTargets();
    /**
     * 面板可能比这次抑制更晚挂载（seat 尚未 mint 出 surface、面板还没插到 DOM 上）：
     * 用一个**短生命周期** MutationObserver 盯住 documentElement/body 的子树，并监听五个公开标记
     * 的属性变化。一旦面板出现或这些公开状态变化，就对新增目标执行同样的逐元素抑制（去重由
     * handled 保证）。仍然只改这几个元素的内联样式：不注入全局 style，也不动 document/body 的
     * 全局 transition。没有 MutationObserver、没有 document、observe 抛错时静默降级为「只抑制
     * 当前已存在的目标」。观察者由返回的恢复句柄 disconnect（dispose 与延迟恢复都会走它）。
     */
    let observer = null;
    try {
      const doc = globalThis.document;
      const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
      const root = doc?.documentElement ?? doc?.body ?? null;
      if (typeof Observer === "function" && root !== null && typeof root === "object") {
        observer = new Observer(() => { applyTargets(); });
        try {
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [...RIGHTBAR_TARGET_MARKERS],
          });
        } catch {
          // observe 失败：断开并放弃观察，只保留已经写好的内联抑制。
          try { observer.disconnect(); } catch { /* 断开失败也不能阻断后续恢复。 */ }
          observer = null;
        }
      }
    } catch { observer = null; }
    if (restores.length === 0 && observer === null) return null;
    /** 恢复句柄：先 disconnect（避免恢复后又被重新抑制），再逐元素还原样式。 */
    return () => {
      const current = observer;
      observer = null;
      if (current !== null) {
        try { current.disconnect(); } catch { /* 断开失败不能阻断样式还原。 */ }
      }
      for (const restore of restores) {
        try { restore(); } catch { /* 单个目标还原失败不能阻断其它目标。 */ }
      }
    };
  }

  /**
   * 过渡抑制的延迟恢复调度器（每次 install 一份，同一时刻只保留一个待恢复句柄）。
   *
   * 时机：必须在宿主完成这次提交之后才还原，否则过渡会在列宽变化落地前被重新打开。两条互备路径：
   * - 连排两帧 requestAnimationFrame：第一帧足够让 React 把宿主 store 的列宽变化提交到 DOM，
   *   第二帧在无过渡状态下完成布局后再还原；
   * - 有界 fallback timer：RAF 被节流/永不触发时保底恢复（没有 RAF 时它是唯一路径）；
   * - 任一触发即取消另一方，保证只恢复一次、也不留下没人消费的任务；
   * - 两类调度都不可用时立刻还原；任何调度异常都只影响「这次打开有没有动画」，绝不影响右栏显示。
   */
  function createInstantRestoreScheduler() {
    let pendingInstantRestore = null; // { restore, cancel }
    const flushInstantRestore = () => {
      const pending = pendingInstantRestore;
      if (pending === null) return;
      pendingInstantRestore = null;
      try { pending.cancel(); } catch { /* 取消失败不影响立即还原。 */ }
      try { pending.restore(); } catch { /* 还原失败不能影响宿主布局。 */ }
    };
    const scheduleInstantRestore = (restore) => {
      flushInstantRestore();
      let settled = false;
      let firstFrame = null;
      let secondFrame = null;
      let fallbackTimer = null;
      /** 取消两类尚未执行的任务（恢复前与 dispose 共用）。 */
      const cancelPending = () => {
        try { if (firstFrame !== null) globalThis.cancelAnimationFrame?.(firstFrame); } catch { /* 可选 API。 */ }
        try { if (secondFrame !== null) globalThis.cancelAnimationFrame?.(secondFrame); } catch { /* 可选 API。 */ }
        try { if (fallbackTimer !== null) globalThis.clearTimeout?.(fallbackTimer); } catch { /* 可选 API。 */ }
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        // 先取消另一方，保证只恢复一次，也不留没人消费的任务。
        cancelPending();
        if (pendingInstantRestore !== null && pendingInstantRestore.restore === restore) pendingInstantRestore = null;
        try { restore(); } catch { /* 见上：只影响这次打开有没有动画。 */ }
      };
      const cancel = () => { settled = true; cancelPending(); };
      // fallback 先排：RAF 被节流时它是唯一保底，绝不让 frame 长期停在 transition:none。
      try {
        fallbackTimer = globalThis.setTimeout(settle, RIGHTBAR_INSTANT_FALLBACK_MS);
      } catch { fallbackTimer = null; }
      let rafScheduled = false;
      try {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === "function") {
          firstFrame = raf(() => { secondFrame = raf(settle); });
          rafScheduled = true;
        }
      } catch { /* RAF 不可用：完全依赖上面的 fallback timer。 */ }
      // 两类调度都不可用：立刻还原（最坏情况是这次打开又播放一次动画，绝不留抑制态）。
      if (fallbackTimer === null && rafScheduled !== true) {
        settle();
        return;
      }
      pendingInstantRestore = { restore, cancel };
    };
    return Object.freeze({ flushInstantRestore, scheduleInstantRestore });
  }

  /**
   * 布局装配体：把「宿主布局句柄 + 每次访问的记账 + 宽度状态容器」交给本次 install。
   *
   * `frame` 是 coordinator 持有的**同一份可写框**（config / 服务 / disposed / 各模块句柄），
   * 本模块只读 frame 上的服务、只写自己的句柄；绝不复制 `disposed` 或 config（复制即双 owner）。
   */
  function createSidebarInstallLayout(frame) {
    /**
     * 右栏拖拽手柄锁（Expert Group 页专属）：只在当前活动 tab 就是 Expert Group 时生效，
     * 切换页面、切换会话或卸载都会按同一条证据链恢复。状态与 DOM 写入都在这里，面板只通过
     * config.syncRightbarDragLock 请求一次重估（见下面 rightbarDragSyncImpl 的说明）。
     */
    const rightbarDragLock = createRightbarDragLock();
    /**
     * 首次分栏后的列宽配比（右栏内部的 40% / 60%，即视口的 20% / 30%）。
     * 它与手柄锁是**两件事**、但共用同一条同步链路：手柄锁决定用户能不能拖总宽度，这里决定
     * split 容器里两条列轨各占多少。触发与恢复条件见 createSplitTrackRatio 的说明。
     */
    const splitTrackRatio = createSplitTrackRatio();
    /**
     * 列宽配比重估的读面（在 install 收尾时接线，见 coordinator 里的说明）。
     *
     * 读面必须以参数形式交给 splitTrackRatio：install 函数体里的 readSurfaceOpenTabs /
     * currentSurfaceSessionId 都是后置定义，而 openTargets() 会在函数体里就触发同步——
     * 直接在 splitTrackRatio 内部引用它们会撞上 TDZ（typeof 为 undefined），异常又被同步入口的
     * try/catch 吞掉，配比就永远写不进去。改成显式读面回调后，这条依赖是**编译器可见**的：
     * 调用点必须自己保证读面就绪。
     */
    let splitTrackReader = null;
    /** 请求一次列宽配比重估；读面还没接线时安全跳过（绝不猜组成、也不碰样式）。 */
    const requestSplitTrackSync = () => {
      // splitTrackReader 在 install 收尾前可能还未接线；disposed 优先阻断已排队的迟到回调。
      if (splitTrackReader === null || frame.disposed) return false;
      return splitTrackRatio.sync(splitTrackReader.readTarget);
    };
    /**
     * 重估入口的真实实现：必须等 currentSurfaceSessionId / activeTabEvidenceOf（target 模块）
     * 就绪后才能求值，因此用一个可空引用转交——注册期（install 中段）与渲染期调用都不会踩到 TDZ。
     */
    let rightbarDragSyncImpl = null;
    /**
     * 请求一次「右栏拖拽手柄锁」重估。面板（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）与
     * openTargets（sessions 与 Better 状态通知）都经这里；dispose 后一律不再碰宿主 DOM。
     */
    const requestRightbarDragSync = () => {
      // 实现体在 target 模块里赋值（它依赖同样后置的 currentSurfaceSessionId / 活跃 tab 读面），
      // 因此这里必须按引用转发，不能内联——注册期与渲染期调用都不会踩到 TDZ。
      // 引用为空时短路，既避开早期 disposed 的 TDZ，也阻断 dispose 后已经排队的迟到通知。
      if (rightbarDragSyncImpl === null || frame.disposed) return;
      try { rightbarDragSyncImpl(); } catch { /* 手柄锁只是体验优化，绝不影响面板渲染。 */ }
    };
    /**
     * 面板卸载时的**无条件解锁**（离开 Expert Group 页这条边沿）。
     *
     * 为什么不用证据判定：面板卸载正是「这一页不再由插件渲染」的时刻，而宿主对活跃 tab 的
     * 提交可能还没落地——此刻读 active() 可能仍返回 Expert Group，于是锁会被错误地留在别的
     * 页面上（用户会突然发现右侧栏拖不动）。无条件解锁的方向永远安全：最坏情况是 Expert Group
     * 页在一次 surface 重挂载的空窗里短暂可拖，而重新挂载后的第一次同步会立刻锁回去。
     */
    const releaseRightbarDragLock = () => {
      if (frame.disposed) return;
      try { rightbarDragLock.setLocked(false); } catch { /* 同上。 */ }
      // 面板卸载 = 这一页不再由插件渲染：列宽配比同样立刻交还宿主（下一轮同步会按最新组成
      // 重新写）。它与手柄锁同一方向、同一无条件的理由：宁可短暂地回到宿主默认比例，
      // 也绝不把插件的 grid-template-columns 留在别人的页面上。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响卸载。 */ }
    };

    /**
     * 每个 surface 会话的「本次访问」记账（root 与 child 各自独立）。
     *
     * 实测症状：root → child 后右栏空白、刷新 child 才显示；再切回 root 时 root 的右栏又是错的。
     * 根因是宿主右栏 surface/store 按 session 懒创建、binding 由 passive effect 提交，而
     * 插件解析出的当前可见会话可能早于宿主 surface 绑定完成：
     * - Better 0.19.1 的 native surface 对「非当前会话」调用 openTabIn，只要方法存在就返回成功，
     *   但未 mint 的会话会静默 no-op；
     * - 于是在同步通知里发 scoped openTab，既会把 child 的请求落到旧 root binding，又会把目标
     *   永久记成「已打开/已展开」，后续通知再也不会重试。
     *
     * 记账模型（按「访问」而不是按 install 生命周期）：
     * - 「宿主已提交的活跃 surface」每次变化（Better getSnapshot().sessionId 变化；无证据的
     *   native/旧 Better 的当前可见会话）就是一次新的访问，拥有独立的一次打开 + 一次展开预算；
     * - 同一次访问里的重复通知绝不重复打开/展开（尊重用户手动关闭右栏）；
     * - 切走再切回、或同一 sessionId 的 surface 被重新挂载（宿主重新提交活跃会话）都会开新访问，
     *   于是会重新确保页面与右栏——这是 root→child→root 与「刷新 child 再回 root」的自愈路径。
     *   公开 API 观察不到「挂载」本身，只能用上述可观察边界近似：没有任何可观察变化的重挂载
     *   无法区分（属已知限制）。
     *
     * 每条记录里的字段都是「本次访问」的预算：
     * - visitEpoch：这些预算所属的访问代次；旧代次排下的任务在回调里一律作废；
     * - openAttempts / openFailures：本次访问已发出的打开请求次数、其中失败的次数（各有上限）；
     * - openState：idle | opened。只有在「当前可见 + 宿主已提交」时发出的请求才算 opened；
     * - expandDone：本次访问是否已成功调用过 layout.openRightbar（成功即消费，不再重复）；
     * - readinessRetries：本次访问内为「等宿主提交」排过的短重试次数（有上限）。
     * 另外跨会话还有一份 rightbarPresented（见 expand 模块的「右栏展示生命周期」）：右栏这份
     * **全局**展示是否已经展开过，它才是「切换 child 时不再重展开」的判据。
     */
    const surfaceRecords = new Map();
    const surfaceRecordOf = (sessionId) => {
      let record = surfaceRecords.get(sessionId);
      if (record === undefined) {
        record = {
          visitEpoch: 0,
          openAttempts: 0,
          openRetries: 0,
          openFailures: 0,
          openState: "idle",
          expandDone: false,
          readinessRetries: 0,
          commitState: "unknown",
          transitionRestore: null,
          continuityRelease: null,
        };
        surfaceRecords.set(sessionId, record);
      }
      return record;
    };
    /**
     * 收口一条访问记录上的连续性遮罩（幂等）。遮罩与过渡抑制是两件事，但生命周期完全一致。
     */
    const releaseContinuityOverlayOf = (record) => {
      if (record === undefined || record === null) return false;
      const release = record.continuityRelease ?? null;
      record.continuityRelease = null;
      if (typeof release !== "function") return false;
      try { release(); } catch { /* 释放失败不能阻断其它收尾动作。 */ }
      return true;
    };
    /**
     * 安全收口一条访问记录上**尚未消费**的过渡抑制句柄。
     *
     * 句柄在 runSurfaceOpen() 里、openSurfaceTab() 之前创建（Better/native 的 openTab 可能同步把
     * 右栏面板置为展开，动画从那一刻开始），正常情况下会由 runRightbarExpand() 交给
     * callOpenRightbar() 并在延迟后恢复。凡是「这次访问不会再调用 layout.openRightbar」的终态
     * （访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、右栏读面不符、dispose…）
     * 都必须在这里立刻恢复，绝不能把 transition:none 留给宿主。
     */
    const releaseTransitionRestore = (record, options = {}) => {
      if (record === undefined || record === null) return false;
      // 所有既有收口路径（访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、dispose…）
      // 都必须同时释放连续性遮罩，避免它长期遮住 UI。
      // 唯一例外是「同一个 surface 的访问代次变化」（options.keepContinuity）：那是宿主提交了新的
      // active surface，属于同一次切换窗口的中途通知，此时释放遮罩会把正在覆盖的 DOM 空窗重新暴露
      // 出来。遮罩仍然由「新 panel open / 500ms 兜底 / 打开失败 / 切走 / 终止边沿 / dispose」收口。
      if (options.keepContinuity !== true) releaseContinuityOverlayOf(record);
      const restore = record.transitionRestore ?? null;
      record.transitionRestore = null;
      if (typeof restore !== "function") return false;
      try { restore(); } catch { /* 恢复失败不能阻断其它收尾动作。 */ }
      return true;
    };
    /** 把某条记录绑定到本次访问代次；代次不同就重置该 surface 的访问预算（普通重复通知沿用）。 */
    const beginVisitFor = (sessionId, epoch) => {
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch === epoch) return record;
      // 新访问：先收口上一次访问遗留在记录上的抑制句柄（它属于旧访问，永远不会再被消费）。
      // 连续性遮罩例外保留：同一个 surface 的代次变化只是宿主提交了新的 active surface，切换窗口
      // 还在进行，遮罩必须继续覆盖空窗（由新 panel open / 兜底 / 终止路径收口）。
      releaseTransitionRestore(record, { keepContinuity: true });
      record.visitEpoch = epoch;
      record.openAttempts = 0;
      record.openRetries = 0;
      record.openFailures = 0;
      record.openState = "idle";
      record.expandDone = false;
      record.readinessRetries = 0;
      // 提交确认状态属于一次访问：新访问重新开始判断（否则「已确认 → 缺失」的边沿会反复触发）。
      record.commitState = "unknown";
      return record;
    };
    /**
     * 访问代次：宿主活跃 surface（有证据用 Better snapshot.sessionId，否则用 插件解析出的当前可见会话）
     * 与当前可见会话的组合一旦变化就 +1。作用：
     * - 旧代次排下的打开/展开任务会在回调里被 visitEpoch 校验拦掉（root 的旧 timer 不会污染
     *   child，反之亦然），并且代次变化时顺手取消上一个会话的待执行任务；
     * - 同一 sessionId 的 surface 重新挂载（snapshot 从 null 变回 S，或切走再切回）同样开新访问，
     *   因此会重新确保页面与展开。
     */
    let currentVisitKey = null;
    let currentVisitEpoch = 0;
    let currentVisitSessionId = null;
    /**
     * 同一 sessionId 的 surface 重挂载序号：current 与宿主活跃会话都没变、但宿主读面显示
     * 此前已确认的 expert-group 变成「明确没有 active tab」时 +1（见 target 模块的 openTargets
     * 边沿检测），用来强制开启一次新访问。持续缺失不会重复 +1，用户手动切到其它 kind 也不会 +1。
     *
     * 序号本身由 target 模块持有（它是唯一的 +1 点，也就是重挂载边沿的判定者）；布局这里只
     * **读当前值**拼访问 key，绝不持有第二份计数器（两份必然漂移，key 就不再变化）。
     */
    const beginVisit = (current, hostSessionId) => {
      const key = String(current) + "|" + String(hostSessionId) + "|" + String(frame.target.remountSerial());
      if (key === currentVisitKey) return currentVisitEpoch;
      currentVisitKey = key;
      currentVisitEpoch += 1;
      // 代次变化：上一个可见会话的遗留任务立刻取消（它们属于旧访问，绝不能在这次访问里执行）。
      if (currentVisitSessionId !== null) {
        frame.expand.cancelSurfaceOpenTimer(currentVisitSessionId);
        frame.expand.cancelRightbarExpand(currentVisitSessionId);
        // 上一个可见会话遗留的过渡抑制同样属于旧访问：立刻收口，绝不留 transition:none。
        // 连续性遮罩要分两种情形：
        // - 可见会话真的换人了（current 变了），或宿主报 null（Better 禁用/未提交的终止标记）：
        //   旧遮罩已经没有意义，必须释放；
        // - 仍然是同一个可见会话，只是宿主提交了新的 active surface / 重挂载序号变化：这正是切换
        //   DOM 空窗的中途通知，遮罩必须继续覆盖（由新 panel open / 500ms 兜底 / 终止路径收口），
        //   否则它会在空窗中间消失，用户依旧看到右栏整块闪一下。
        releaseTransitionRestore(surfaceRecords.get(currentVisitSessionId), {
          keepContinuity: currentVisitSessionId === current && hostSessionId !== null,
        });
      }
      currentVisitSessionId = current;
      return currentVisitEpoch;
    };
    /**
     * 读宿主右栏真正承载的会话（Better 公开状态面；由 setSession() 在切换提交时写入并通知）：
     * - available=false：宿主没有该 API（旧 Better / native 路径），或属性读取/调用抛错 →
     *   调用方走兼容语义（退回 插件解析出的当前可见会话），异常绝不外泄；
     * - available=true, sessionId=null：有 API 但读不到活跃会话（未建立/切换中）→ 视为
     *   「尚未提交」：此时绝不发打开请求（那正是会落到旧 binding 被静默丢弃的情况），只等通知
     *   或有限重试；
     * - available=true, sessionId=S：宿主 binding 已提交到 S，是唯一可信的「已提交」证据。
     */
    const readHostActiveSurface = () => {
      const better = frame.better;
      let readSnapshot;
      try {
        const candidate = better?.getSnapshot;
        if (typeof candidate !== "function") return { available: false, sessionId: null };
        readSnapshot = candidate;
      } catch { return { available: false, sessionId: null }; }
      try {
        return { available: true, sessionId: text(object(readSnapshot.call(better)).sessionId, null) };
      } catch { return { available: false, sessionId: null }; }
    };

    const instantRestore = createInstantRestoreScheduler();
    /** 视觉连续性遮罩单例：每次 capture 先释放上一个，保证同时最多一个遮罩。 */
    const continuityOverlay = createNativeRightbarContinuityOverlay();

    /**
     * 右栏宽度状态的**容器所有权**（票据 25 的 C5 硬约束）。
     *
     * 六份容器按 surface 会话记账，语义见 `sidebar-install-width` 的模块头（命令都在那里）。
     * 这里只负责「谁拥有生命周期」：
     * - 创建：每次 install 一份；
     * - 清空：**只在本模块的 clearWidthState()**（dispose 调用），因此 6 个 Map.clear() 全落在这里；
     * - width 模块只拿引用做读写命令，绝不调用 clear（不得直接清空别人的所有权周期）。
     * `surfaceSessionId` 是「宿主那份全局宽度当前归谁」的标量，随同一份状态框迁移；
     * `splitTransactions` 是按会话隔离的分栏事务表（逐条 delete，不整表 clear）。
     */
    /** 本次安装生命周期内、按 surface 会话记账的右栏宽度：sessionId → 已写入的 px。 */
    const rightbarWidths = new Map();
    /** sessionId → 上次成功写入宽度时所用的**视口宽度**（px）：窗口最大化 / 全屏后重算的判据。 */
    const rightbarWidthViewports = new Map();
    /** sessionId → 该会话的宽度模式（"expert" / "other" / "split-pending"）。 */
    const rightbarWidthModes = new Map();
    /** openTargets 刚刚成功预置宽度的会话集合：避免同一同步栈末尾的活跃页确认再次重复写入。 */
    const rightbarWidthPreparedSessions = new Set();
    /** 最近一次被公开 active() 证明确实处于 Expert Group 页、且宽度已经落到宿主的会话集合。 */
    const rightbarWidthActiveSessions = new Set();
    /** 同一个「未收敛的宽度 mismatch」的恢复写入记账：sessionId → { target, actualWidth, attempts }。 */
    const rightbarWidthRecoveries = new Map();
    /** 首次从 Expert Group-only pane 创建子代理 pane 的**按会话隔离**事务表：sessionId → 事务。 */
    const rightbarSplitTransactions = new Map();
    /**
     * 同一份宽度状态的**引用框**：命令面（width 模块）只拿这套引用做读写，绝不复制容器。
     * `surfaceSessionId`（宿主那份全局宽度当前归谁）由命令面自己持有，不在这套容器里。
     */
    const widthState = {
      widths: rightbarWidths,
      viewports: rightbarWidthViewports,
      modes: rightbarWidthModes,
      prepared: rightbarWidthPreparedSessions,
      active: rightbarWidthActiveSessions,
      recoveries: rightbarWidthRecoveries,
      splitTransactions: rightbarSplitTransactions,
    };
    /**
     * 清空本次 install 的全部宽度状态（只由 coordinator 的 dispose 调用）。
     * 六份容器各属同一生命周期：rightbarWidths（目标值）→ viewports（视口记账）→ modes
     * （模式）→ prepared / active（transient 标记）→ recoveries（恢复预算）。resize 监听与
     * 所有 deferred 任务此时已由 coordinator 取消，之后的迟到回调一律被 frame.disposed 拦掉。
     */
    const clearWidthState = () => {
      rightbarWidths.clear();
      rightbarWidthViewports.clear();
      rightbarWidthModes.clear();
      rightbarWidthPreparedSessions.clear();
      rightbarWidthActiveSessions.clear();
      rightbarWidthRecoveries.clear();
    };

    return Object.freeze({
      beginVisit,
      beginVisitFor,
      clearWidthState,
      continuityOverlay,
      currentVisitEpoch: () => currentVisitEpoch,
      flushInstantRestore: instantRestore.flushInstantRestore,
      readHostActiveSurface,
      releaseRightbarDragLock,
      releaseTransitionRestore,
      requestRightbarDragSync,
      requestSplitTrackSync,
      rightbarDragLock,
      scheduleInstantRestore: instantRestore.scheduleInstantRestore,
      setDragSyncImpl: (impl) => { rightbarDragSyncImpl = impl; },
      setSplitTrackReader: (reader) => { splitTrackReader = reader; },
      suppressRightbarTransition,
      // 列宽配比句柄由 coordinator 的 dispose 调用（与手柄锁同一收尾时机）。
      splitTrackRatio,
      surfaceRecordOf,
      surfaceRecords,
      widthState,
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarInstallLayout });
})(globalThis);
