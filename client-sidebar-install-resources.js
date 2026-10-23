/**
 * 客户端侧栏 · install coordinator / 资源注册（R7 票据 25 / sidebar-install-resources）
 *
 * ## 职责（plan §7 R7：薄编排壳，代码量计入本模块的注册区段）
 * 1. **注册时机与顺序**（不可变契约，逐条与拆分前一致）：
 *    建 panel → session 订阅 → Better `registerTab` 后 `subscribeState` →
 *    native `tabs.register` 后 `slots.register` → **最后** `openTargets()`；
 * 2. **disposer 栈**：按注册顺序入栈、**逆序**释放、单条抛错不阻断其余；
 *    `disposeAll()` 只由本模块持有（唯一持有者，其它模块只暴露各自的取消命令）；
 * 3. 宿主服务定位（betterSidebar / sessions / sidebarRightTabs / sidebarRight / slots），
 *    逐项两段式安全探测；
 * 4. 视口 resize 快路径的注册与注销（add + remove 必须同时存在才注册）；
 * 5. 装配四个 install 子模块（layout → width → expand → target），并把它们的窄命令接线成
 *    Panel 的注入面与列宽配比读面。
 *
 * ## 为什么 coordinator 不另开源区段
 * plan §7 的 install 段预算（2,547 行 = 5 个模块之和）已经把 11153–11169 的 head 与
 * 13481–13699 的注册/收尾都算进 `sidebar-install-resources`；本文件就是那两段的落点，
 * 因此模块数与 §7 的 21 个口径一致（5 个 install 模块，coordinator 不新增第 6 个）。
 *
 * ## 状态所有权
 * - `disposed` 与 `disposers` 的唯一 owner 是本模块；其它模块只**实时读** `frame.disposed`。
 * - 六份宽度容器归 `sidebar-install-layout`；分栏事务表归 `sidebar-install-width`；
 *   访问记录归 layout；展开/打开定时器归 expand。这里只调用它们的收尾命令。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-install-resources")]
 * 装配：真实依赖边为 pure / dom + 四个 install 子模块 → 本模块 → 主 sidebar。
 */
(function installSidebarInstallResources(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-resources");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const { object, resolveExpertRightbarWidthRatio } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { createBrandIcon, viewportWidthOf } = DOM;
  const LAYOUT_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-layout");
  const INSTALL_LAYOUT = global[LAYOUT_SYMBOL] || {};
  const { createSidebarInstallLayout } = INSTALL_LAYOUT;
  const WIDTH_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-width");
  const INSTALL_WIDTH = global[WIDTH_SYMBOL] || {};
  const { createRightbarWidthWriter, createWidthBookkeeping } = INSTALL_WIDTH;
  const EXPAND_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-expand");
  const INSTALL_EXPAND = global[EXPAND_SYMBOL] || {};
  const { createRightbarComposition, createRightbarExpand, createSurfaceOpen } = INSTALL_EXPAND;
  const TARGET_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-target");
  const INSTALL_TARGET = global[TARGET_SYMBOL] || {};
  const { createSidebarInstallTarget, createSidebarSplitTransactions } = INSTALL_TARGET;

  /**
   * 装配并返回 disposeAll（唯一持有者）。
   *
   * @param ctx Cordis 上下文（宿主服务经 `ctx.get(name)` / `ctx[name]` 两段式探测）。
   * @param deps 面板与注册用的注入面（react / primitives / 各服务覆盖 / taskManagementEnabled…）。
   * @param host 主 sidebar 提供的 Panel 工厂（`{ createExpertGroupPanel }`）：install 只负责
   *   把「注册时机 + 事务命令 + 宽度偏好」接线进去，绝不自己实现渲染。
   */
  function createSidebarInstallCoordinator(ctx, deps, host) {
    const config = { ...object(deps), ctx };
    /**
     * 「任务管理」关闭时 Expert Group 不注册任何侧边栏入口。
     *
     * 返回幂等 no-op disposer（可重复调用且不释放任何别人的所有权），调用方因此可以沿用
     * 同一份 install/dispose 契约：关闭时直接释放既有 install 的 disposer，重新开启时重新
     * install 一次。这里只表示「本插件不注册」，不触碰 DSH 或 dsh-better-sidebar 的
     * tabsEnabled 偏好，也不回退到另一种注册方式。
     */
    if (config.taskManagementEnabled === false) return () => {};
    /**
     * 可选依赖的两段式安全探测：Cordis 对未声明服务的属性读取会抛错，因此先 `ctx.get(name)`，
     * 失败或为空再试直接属性；两段都失败一律按「服务未安装」处理。
     */
    const optionalService = (name) => {
      try {
        const value = typeof ctx?.get === "function" ? ctx.get(name) : null;
        if (value) return value;
      } catch { /* 服务未安装。 */ }
      try { return ctx?.[name] || null; } catch { return null; }
    };
    /**
     * 品牌图标：两个注册面（Better tab 与原生 guide 卡片）共用同一个组件。
     *
     * react 缺失时 createBrandIcon 返回 null，注册描述符里就完全不写 icon 字段——
     * 图标只是外观，缺依赖必须保持「其余注册契约逐字节不变」，绝不因此改变 tab 的行为。
     */
    const brandReact = typeof config.react?.createElement === "function" ? config.react : null;
    const brandIcon = createBrandIcon(brandReact, object(config.primitives));
    /**
     * 本次 install 的共享框：**唯一可变字段是 disposed**（本模块独占写权），其余是只读服务
     * 引用与各模块句柄。四个子模块拿同一份引用，绝不各自复制 config / disposed / 容器。
     */
    const frame = {
      better: config.betterSidebar || optionalService("betterSidebar"),
      brandIcon,
      brandReact,
      config,
      ctx,
      disposed: false,
      // 探测到 betterSidebar 后始终由它独占，禁用也绝不回退到 native。
      nativeSidebar: config.sidebarRight || optionalService("sidebarRight"),
      optionalService,
      sessions: config.sessions || optionalService("sessions"),
      slots: config.slots || optionalService("slots"),
      tabs: config.sidebarRightTabs || optionalService("sidebarRightTabs"),
    };
    /** 注册顺序栈：每一条注册都按发生顺序入栈，dispose 时**逆序**逐条释放。 */
    const disposers = [];

    // ── 装配（顺序即依赖：layout → width → expand → target）─────────────────────
    frame.layout = createSidebarInstallLayout(frame);
    // 宽度面拆成「簿记（容器读写 + 分栏表）」与「写入（目标值 / 证据 / 恢复）」两个工厂，
    // 但对外是**同一个** width 句柄：两者共用同一份 widthState，分工只受单工厂行数门禁约束。
    frame.width = { ...createWidthBookkeeping(frame), ...createRightbarWidthWriter(frame) };
    // 展开面、组成读面与打开面是三个工厂，但对外是**同一个** expand 句柄：访问记录、
    // presented 记账与打开定时器共用同一份 frame，断开成多个句柄只会让调用点分散。
    frame.expand = {
      ...createRightbarExpand(frame),
      ...createRightbarComposition(frame),
      ...createSurfaceOpen(frame),
    };
    // 目标同步面 + 分栏事务：同样合成一个 target 句柄（外层同步与 Panel 注入都只看这一个）。
    frame.target = { ...createSidebarInstallTarget(frame), ...createSidebarSplitTransactions(frame) };

    // 收尾与注入面按拆分前的同名标识符取回（同一批句柄，不复制任何状态）。
    const {
      cancelAllRightbarExpands, cancelAllSurfaceOpens,
    } = frame.expand;
    const {
      cancelAllSidebarSplits, applyRightbarWidthRatio,
    } = frame.width;
    const {
      beginSidebarSplit, cancelSidebarSplit, commitSidebarSplit, markSidebarSplitOpen, markSidebarSplitPane,
    } = frame.target;
    const {
      continuityOverlay, flushInstantRestore, releaseRightbarDragLock, releaseTransitionRestore,
      requestRightbarDragSync, rightbarDragLock, splitTrackRatio, surfaceRecords,
    } = frame.layout;

    // 面板只多拿这几个事务注入点：其余 config 字段逐项不变；没有 install coordinator 的
    // 直接 createExpertGroupPanel 测试/宿主仍沿用旧的 split + openResource 兼容路径。
    const panel = host.createExpertGroupPanel({
      ...config,
      syncRightbarDragLock: requestRightbarDragSync,
      releaseRightbarDragLock,
      beginSidebarSplit,
      markSidebarSplitPane,
      markSidebarSplitOpen,
      commitSidebarSplit,
      cancelSidebarSplit,
      /**
       * 宽度偏好的两个注入点（票据 18）：面板只提出「想改成多少」，真实写入与持久化都在
       * width 模块（见 applyRightbarWidthRatio 的说明）。
       */
      readRightbarWidthRatio: resolveExpertRightbarWidthRatio,
      applyRightbarWidthRatio,
    });

    // ── 注册顺序（硬约束）：panel 已建 → session 订阅 → Better → native → openTargets ──
    const unsubscribe = frame.sessions === null || frame.sessions === undefined
      ? null
      : DOM.subscribeSessions({ ...config, sessions: frame.sessions }, ctx, frame.target.openTargets);
    disposers.push(typeof unsubscribe === "function" ? unsubscribe : () => {});

    if (frame.better) {
      if (typeof frame.better.registerTab === "function") {
        const release = frame.better.registerTab({
          id: "expert-group",
          title: "expert group",
          single: true,
          component: panel,
          // Better 的 tab 图标契约是「size → React 元素」的函数（宿主只把尺寸传进来，
          // 渲染时机与容器由它决定），因此这里传的是工厂而不是元素。缺 react 时整条
          // icon 字段都不写：宿主照常渲染一个无图标的 tab，注册契约的其余字段不变。
          ...(brandIcon === null ? {} : { icon: (size) => brandReact.createElement(brandIcon, { size }) }),
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof frame.better.subscribeState === "function") {
        try {
          const unsubscribeState = frame.better.subscribeState(frame.target.openTargets);
          if (typeof unsubscribeState === "function") disposers.push(unsubscribeState);
        } catch { /* 旧版 Better Sidebar 没有设置订阅时仍可初次打开。 */ }
      }
      frame.target.openTargets();
    } else {
      if (typeof frame.tabs?.register === "function") {
        const release = frame.tabs.register({
          id: "dsh-expert-group",
          kind: "expert-group",
          // 子代理 tab 成为 active 后仍保留面板 body，observer/轮询才能继续完成同 pane 的 float 回退。
          keepMounted: true,
          title: () => "expert group",
          guide: [{
            order: 40,
            title: () => "expert group",
            description: () => "查看当前会话的专家任务树",
            // 原生 guide 卡片的图标契约与 Better 相反：宿主以**组件**形式渲染它
            // （`<Icon size={22|26} />`），因此传组件本身，不预构造元素。
            // 缺 react 时同样整条不写，宿主退回到自己的立方体占位。
            ...(brandIcon === null ? {} : { icon: brandIcon }),
          }],
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof frame.slots?.register === "function") {
        const release = frame.slots.register({ name: "sidebar.right.pane.tab", key: "dsh-expert-group" }, panel);
        if (typeof release === "function") disposers.push(release);
      }
      frame.target.openTargets();
    }
    /**
     * 视口尺寸变化（窗口最大化 / 全屏 / 拖拽窗口边缘 / 旋转屏幕）后重新换算右栏宽度。
     *
     * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store
     * 的是像素值。没有这条边沿，窗口最大化后宿主会一直沿用最大化之前那份旧像素宽度，比例不再
     * 成立（1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640）。
     *
     * 四条约束：
     * - 只读公开的 window 事件，且全程按**可选 API** 处理：没有 window、没有 addEventListener、
     *   代理读取抛错时静默降级为「只靠既有 observer + 2.5 秒轮询兜底」——那条链路同样会靠
     *   视口记账发现变化并补写（见 rightbarWidthViewportChanged），因此老宿主不会失效；
     * - **add 与 remove 必须同时存在**才注册：宿主只有 addEventListener 时（旧 WebView、被冻结
     *   的事件面），注册会成功而 dispose 的注销永远失败，那次 install 的闭包就被永久留在宿主
     *   window 上——每装一次泄漏一个，卸载后仍会被 resize 事件唤醒。这种宿主整条放弃快路径，
     *   同样退回上面那条 observer + 2.5 秒轮询兜底，功能不缺失；
     * - 监听在 install 注册、dispose 移除（走统一的 disposers），绝不在宿主上留下长期监听；
     * - 高频 resize 只在**视口宽度真的变了**时才请求同步：同一宽度的连发事件直接短路，既不做
     *   无谓的组成读面求值，也让行为保持确定性（同步栈内立即生效，不需要推进任何定时器）。
     */
    let lastObservedViewportWidth = viewportWidthOf();
    const onViewportResize = () => {
      if (frame.disposed) return;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return;
      if (lastObservedViewportWidth === viewportWidth) return;
      lastObservedViewportWidth = viewportWidth;
      // 复用既有的宽度/手柄/配比同步链路：不新开一条并行路径，也不直接在这里写宽度。
      requestRightbarDragSync();
    };
    try {
      const viewportTarget = globalThis.window ?? null;
      // 注册条件必须**同时**要求 add 与 remove：宿主只有 addEventListener 时注册会成功、
      // dispose 的注销却永远失败，闭包被永久留在宿主 window 上（每次安装泄漏一个，且卸载后
      // 仍会被 resize 事件唤醒）。宁可少一条快路径，也绝不在宿主上留下摘不掉的监听——
      // 缺少任一 API 时完全依赖既有的 observer + 2.5 秒轮询兜底，它们同样按视口记账补写。
      if (typeof viewportTarget?.addEventListener === "function"
        && typeof viewportTarget?.removeEventListener === "function") {
        viewportTarget.addEventListener("resize", onViewportResize);
        disposers.push(() => {
          try { viewportTarget.removeEventListener("resize", onViewportResize); } catch { /* 注销抛错的宿主只能放弃这条监听。 */ }
        });
      }
    } catch { /* 没有 window 或代理读取抛错：只靠既有 observer 与 2.5 秒轮询兜底。 */ }
    // 到这里 install 函数体里的全部读面（readSurfaceOpenTabs / currentSurfaceSessionId /
    // rightbarDragSyncImpl）都已初始化完成：接线配比读面，后续每一轮同步都能安全求值。
    // 刻意排在 install 函数体的**最后**：任何一次同步（包括下面这次立即求值）都要等这些读面
    // 初始化完成，否则会撞上 const 的 TDZ（异常被同步入口的 try/catch 吞掉，配比就永远写不进去）。
    // 在它之前发生的同步（install 中段那一轮 openTargets）只会拿到 null 读面并安全跳过。
    frame.layout.setSplitTrackReader({
      /**
       * 读当前 surface 那条 surface 的分栏容器：session → panel → split 三级读面都必须精确唯一。
       *
       * 返回 { status, container }：
       * - "target"：组成可证明，容器就是本次要施加配比的那一个；
       * - "pending"：结构上仍是两列、列 0 明确是本会话的 Expert Group 页，但列 1 的内容这一轮
       *   读不出来（重启恢复窗口：tab 条 / inventory 归属还没提交）。容器照常返回，调用方据此
       *   保持已写下的配比并短延迟重试——这正是「不闪回宿主默认值」的唯一来源；
       * - null：会话读不出来、inventory 不可用、没有属于本会话的 panel、panel 归属有歧义、
       *   或组成明确不是目标（单列 / 三列 / Expert Group 消失 / 归属冲突）。调用方交还宿主样式。
       *
       * fail-closed 边界不因 pending 放松：pending 只在列 0 的目标身份**已被证明**时才可能返回，
       * 任何未知归属、重复或混合列都仍然走 null（明确非目标），绝不靠猜测进入 pending。
       */
      readTarget(doc) {
        let sessionId = null;
        try { sessionId = frame.target.currentSurfaceSessionId(); } catch { sessionId = null; }
        if (typeof sessionId !== "string" || sessionId === "") return null;
        // 严格归属：tabId 必须能在当前 session 的 inventory 里对上，绝不用全局 kind 猜测。
        const tabSets = DOM.sidebarTabSetsForSession(frame.expand.readSurfaceOpenTabs(), sessionId);
        if (tabSets === null) return null;
        // panel 按 data-sidebar-right-session 精确选择：同名多 panel = 归属不明确，直接放弃。
        const panel = DOM.rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
        const container = DOM.resolveSplitContainer(panel, tabSets);
        if (container !== null) return { status: "target", container };
        // 两列结构仍在、列 0 仍是 Expert Group 页，只有列 1 的内容读不出来：暂不可读。
        // 单列 / 三列 / 混合列 / 重复列号等形状在这里都拿不到 "unavailable"，一律交还宿主。
        const candidates = DOM.splitPairPendingContainers(panel, tabSets);
        if (candidates.length === 1) return { status: "pending", container: candidates[0] };
        return null;
      },
    });
    // install 收尾立即求值一次：中段那一轮 openTargets 触发的同步当时读面还是 null（已跳过），
    // 而右栏 DOM 此刻可能已经是「两列」的形状（刷新恢复的分栏）——不能让 Expert Group 页
    // 停在宿主的等分比例上等下一次 observer/轮询。
    try { frame.layout.requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响 install。 */ }

    /**
     * disposeAll：**唯一持有者**是本模块（其它模块只暴露各自的有界取消命令）。
     *
     * 顺序逐条与拆分前一致，任何一步都不允许被跳过或重排：
     * 1. 先置位 disposed（cancel/observer 可能同步重入同步入口，必须让它们看到已销毁状态）；
     * 2. 逐条收口在途分栏事务（每条只清理自己所属会话的记账与 deadline）；
     * 3. 取消全部 deferred 任务（展开 + 补偿打开重试）；
     * 4. 收口过渡抑制（挂起的延迟恢复 + 记录上未消费的句柄 + 遮罩单例兜底释放）；
     * 5. 释放布局句柄（手柄锁、列宽配比）；
     * 6. 清空宽度状态（6 个 Map.clear() 由 layout 的 clearWidthState 完成）；
     * 7. **逆序**逐个调用 disposer，单条抛错不阻断其余。
     */
    const disposeAll = () => {
      if (frame.disposed) return;
      frame.disposed = true;
      // 逐条收口：每条事务只清理自己所属会话的 transient 记账与 deadline，互不干扰。
      cancelAllSidebarSplits("dispose");
      // 先清掉未执行的所有 deferred 任务（展开 + 补偿打开重试）：卸载后插件不得再碰宿主
      // layout，也不留下泄漏的 timer。
      cancelAllRightbarExpands();
      cancelAllSurfaceOpens();
      // 过渡抑制同样要收尾：取消挂起的延迟恢复、收口所有记录上尚未消费的句柄，并立刻把
      // frame/panel 上的内联样式还原、断开 observer，绝不把「无过渡」这个临时状态留给宿主。
      flushInstantRestore();
      for (const record of surfaceRecords.values()) releaseTransitionRestore(record);
      // 连续性遮罩单例兜底释放（记录级释放已经覆盖它，这里防漏）。
      continuityOverlay.release();
      // 右栏拖拽手柄锁收尾：还原内联样式（锁本身复用面板那条 tab 观察生命周期，不另持观察器），
      // 绝不在宿主上留下「永久不可拖拽」的手柄。
      rightbarDragLock.dispose();
      // 首次分栏的列宽配比同样只属于本次安装：把 split 容器的内联 grid-template-columns 还回
      // 宿主原本的值与优先级，并置位 disposed（此后的迟到同步一律不再写入）。
      splitTrackRatio.dispose();
      // 宽度状态（目标值 / 视口 / 模式 / 预置 / 已确认活跃 / 恢复预算）只属于本次安装生命周期，
      // 由布局 owner 统一清空（6 个 Map.clear() 全在 layout 的 clearWidthState 里）。
      frame.layout.clearWidthState();
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try { disposers[index](); } catch { /* 一个 disposer 失败不能阻止其它所有权释放。 */ }
      }
    };
    return disposeAll;
  }

  global[SYMBOL] = Object.freeze({ createSidebarInstallCoordinator });
})(globalThis);
