/**
 * 客户端侧栏 · Panel 组件本体（R6.5 票据 26b）
 *
 * 本文件只保留**组件装配**：
 *   1. 每帧的读取面（props / scope / 宿主 model 与 locale / 宿主服务）→ createSidebarPanelFrame；
 *   2. 按固定顺序调用各自定义 Hook（Hook 内部的 react.use* 顺序与拆分前逐字相同）；
 *   3. 渲染组装（assembleSidebarPanelBody → renderSidebarPanelSection）。
 *
 * 为什么组件体的语句要搬进 Hook 而不是留在本文件：规格书要求单文件 ≤1,500、单工厂 ≤400；
 * 组件函数体内的 Hook 不能跨组件搬迁，但可以搬进自定义 Hook（React 的标准组合方式），
 * 运行时派发顺序因此保持不变。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-panel")]
 */
(function installSidebarPanel(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_KEY_LIMIT, TIMELINE_EXPANDED_KEY_LIMIT, modelApi, object,
    text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    createCatalogLookup, currentSessionIdOf, listSnapshot, makeIcon,
    methodOf, resolveClientService, runtimeStatusOf, statusIcon,
    styleTag,
  } = DOM;
  const POLL_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-poll");
  const POLL = global[POLL_SYMBOL] || {};
  const {
    formatPanelUpdatedTime, readPanelTabActivity,
  } = POLL;
  const AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const AUTO_LEDGER = global[AUTO_LEDGER_SYMBOL] || {};
  const {
    recordSidebarAutoDiag, resolveSidebarSharedAutoLedger, sidebarSharedAutoLedgerSizes, sidebarSharedAutoLedgerTotal,
  } = AUTO_LEDGER;
  const PANEL_CACHE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-cache");
  const PANEL_CACHE = global[PANEL_CACHE_SYMBOL] || {};
  const {
    createPanelSnapshotCache,
  } = PANEL_CACHE;
  const PANEL_STATE_A_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
  const PANEL_STATE_A = global[PANEL_STATE_A_SYMBOL] || {};
  const VIEWS_A_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-a");
  const VIEWS_A = global[VIEWS_A_SYMBOL] || {};
  const VIEWS_B_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-b");
  const VIEWS_B = global[VIEWS_B_SYMBOL] || {};
  const VIEWS_C_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-views-c");
  const VIEWS_C = global[VIEWS_C_SYMBOL] || {};
  const HOOKS_STATE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-state");
  const HOOKS_STATE = global[HOOKS_STATE_SYMBOL] || {};
  const {
    useSidebarPanelHostServices, useSidebarPanelSessionModel, useSidebarPanelSessionModelPart2,
    useSidebarPanelSnapshotDerived, useSidebarPanelStateCore, useSidebarPanelStoreAndMeta,
    useSidebarPanelWidth,
  } = HOOKS_STATE;
  const HOOKS_EFFECTS_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-effects");
  const HOOKS_EFFECTS = global[HOOKS_EFFECTS_SYMBOL] || {};
  const {
    useSidebarPanelActivityEffect, useSidebarPanelAnnouncementEffect, useSidebarPanelMetaEffect,
    useSidebarPanelMountEffects, useSidebarPanelPolling, useSidebarPanelProjectionEffect,
    useSidebarPanelSessionModelEffects, useSidebarPanelSnapshotRefs, useSidebarPanelSnapshotSyncEffect,
  } = HOOKS_EFFECTS;
  const HOOKS_TABS_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-tabs");
  const HOOKS_TABS = global[HOOKS_TABS_SYMBOL] || {};
  const {
    useSidebarPanelAutoOrchestration, useSidebarPanelAutoOrchestrationPart2, useSidebarPanelAutoRefs,
    useSidebarPanelTabPrimitives, useSidebarPanelTabSync, useSidebarPanelTabWiring,
    useSidebarPanelTabWiringPart2, useSidebarPanelTabWiringPart3,
  } = HOOKS_TABS;
  const HOOKS_ACTIONS_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-actions");
  const HOOKS_ACTIONS = global[HOOKS_ACTIONS_SYMBOL] || {};
  const {
    useSidebarPanelActionHandlers, useSidebarPanelActionHandlersPart2, useSidebarPanelBatchClose,
    useSidebarPanelRunAction, useSidebarPanelRunActionPart2, useSidebarPanelTabRecorder,
    useSidebarPanelTabRecorderPart2,
  } = HOOKS_ACTIONS;

  /**
   * 工厂级共享面（同一 install 内跨 Panel 实例共享）：样式注入、快照缓存、Auto 账本。
   *
   * 这段是拆分前 createExpertGroupPanel 的前导（原 110–271 行）的逐字搬移：顺序
   * （styleTag → 快照缓存 → 共享账本 → 关闭租约）与方法调用都不变。
   */
  function createSidebarPanelShared(deps) {
    const { config, react, primitives } = deps;
    styleTag();

    /**
     * 工厂级快照缓存（R6 票据 22）：跨 Panel 实例共享，卸载后重挂载首帧仍然命中。
     *
     * 缓存本体（Map）、LRU 上限 32 与两条访问通道（peek 纯读 / write 事件路径）的唯一 owner 是
     * client-sidebar-panel-cache.js；这里只取回检查点，**不再保留第二份 Map**（保留即双 owner）。
     * 生命周期语义随之固定：随 createExpertGroupPanel 存在，跨 Panel 实例共享，绝不随实例卸载丢失。
     *
     * 渲染纯性边界逐字不变：peekCachedSnapshot 只在挂载帧的懒初始化与「切换 root 的视图回退分支」
     * 被调用（纯读，不重排 LRU）；writeCachedSnapshot 只在 RPC 成功的事件路径被调用。
     */
    const panelSnapshotCache = createPanelSnapshotCache();
    const peekCachedSnapshot = panelSnapshotCache.peek;
    const writeCachedSnapshot = panelSnapshotCache.write;
    const initialStateFor = panelSnapshotCache.initialStateFor;

    /**
     * 跨 Panel 实例共享的 Auto 账本（同一插件 install 内共享；重装插件或重启进程即随之消失）。
     *
     * 症状与根因：真实 DSH 的 keyed session surface 会卸载旧 Panel 实例、再用同一个已安装组件挂载
     * 新实例，而宿主右栏的 tab 与它自己那份 inventory 原样保留。这三份账本原先都建在 Panel 内的
     * useRef 上，卸载即丢失，因此新实例在 syncSidebarTabRecords() 的收养路径里只能把宿主里已经
     * 存在的 tab 记成 manual 来源（recordSidebarTab 的兜底），Auto 随后主动放弃关闭它——用户看到的
     * 就是「子代理已经空闲，Auto 开出来的那个 tab 却永远留在右栏」。
     *
     * 只共享回答「这个 tab 是不是 Auto 亲手打开、还归不归 Auto 管」所必需的集合：
     * - origin：Auto 亲手发出过打开动作的资源（键与打开记录同构）；它同时是「绝不重复打开」的记账；
     * - suppressed：用户手动关闭过的资源，Auto 不得立刻重开；
     * - closeAttempts：自动关闭的有界重试计数（重挂载不得白送或重置预算）；
     * - closeAttemptOwners：每条 closeAttempts 预算**当前所有者**的不可复用令牌（见下方说明）。
     *
     * 重试预算必须带所有者身份：预支与回滚分别发生在「候选选择」和「动作在副作用之前被撤销」两个
     * 时刻，中间可能跨越一次面板重挂载或同一个实例的 A→B→A 回代。预算本身按 key 共享，因此旧代次
     * 的迟到回滚若只按 key 写回 attemptsBefore，就会删掉/覆盖新代次已经预支的那一笔预算——同一个
     * key 的实际 close 次数随之突破 3 次上限。owner 账本把「这笔预算现在是谁的」也放进同一层共享
     * 状态，回滚只认对象身份，旧令牌一律 fail-safe。
     *
     * 其余状态一律留在 Panel 实例内：在途动作与预留（reservation）、Auto 代次（epoch）、失败屏障、
     * busy 闸门、tab 打开记录（records/openings）、手动意图都属于「当前这一帧 surface 的在途状态」，
     * 跨实例共享只会让旧实例的在途状态污染新实例。键始终是（sidebar session + rootSessionId +
     * 资源地址）复合键，因此共享也不会让不同 root / 不同 session 互相影响。
     *
     * 生命周期（本轮修复）：这八份 Map 不只是「同一 install 内共享」，而是**本 realm 内共享**——
     * bundle 被 HMR 重新执行之后仍复用同一批 Map（见 resolveSidebarSharedAutoLedger）。否则一次
     * 构建（fixer 角色最容易触发）就会把「这个 tab 是 Auto 亲手打开的」全部抹掉，tab 随即被收养成
     * manual 并永久留在右栏。跨整页刷新/进程重启的归属由持久标记层负责（SIDEBAR_AUTO_OWNERSHIP_KEY）。
     */
    const sharedAutoLedgerState = resolveSidebarSharedAutoLedger();
    const sharedAutoLedger = sharedAutoLedgerState.ledger;
    recordSidebarAutoDiag({
      kind: "install",
      reused: sharedAutoLedgerState.reused,
      degraded: sharedAutoLedgerState.degraded,
      sizes: sidebarSharedAutoLedgerSizes(sharedAutoLedger),
    });
    if (sharedAutoLedgerState.reused === true && sharedAutoLedgerState.degraded !== true
      && sidebarSharedAutoLedgerTotal(sharedAutoLedger) > 0) {
      // 只在「复用了一份非空账本」时提示一行：用户开着 DevTools 就能确认 HMR 之后归属没有丢。
      try {
        console.info("[dsh-expert-group] 本 realm 已有共享 Auto 账本：本次装载复用既有的归属 / 预算 / 确认计数（bundle 重新执行或 HMR）");
      } catch { /* 控制台不可用不影响功能。 */ }
    }
    /**
     * realm 共享的 Auto 来源账本：key → { sessionId, rootSessionId, address, tabId }。
     *
     * tabId 是「Auto 打开/替换落地那一刻，插件亲眼在宿主 inventory 里读到的那个 tab」，它让这份
     * 跨 bundle 重新执行（HMR）/ 跨 Panel 实例的账本不再只是一句「我们打开过」——所有据此认定
     * auto 的位置都必须比对 tabId（见 sidebarAutoOriginEntry / sidebarAutoOriginTabIdOf）。
     */
    const sharedSidebarAutoOrigin = sharedAutoLedger.origin;
    const sharedSidebarAutoSuppressed = sharedAutoLedger.suppressed;
    const sharedSidebarAutoCloseAttempts = sharedAutoLedger.closeAttempts;
    /**
     * 跨 Panel 实例共享的「这条自动关闭重试预算归谁」账本：key → 本次预支预算的**不可复用**令牌。
     *
     * 键与 closeAttempts 完全同构，取值是候选选择那一刻新建的对象（对象身份即所有权），因此任何
     * 旧代次手里的令牌都不可能与后来者的令牌相等。写入与删除与 closeAttempts 同步进行，并沿用同一
     * 个 trimAutoKeyMap/128 上限，绝不引入第二份无界 Map。
     */
    const sharedSidebarAutoCloseAttemptOwners = sharedAutoLedger.closeAttemptOwners;
    /**
     * 跨 Panel 实例共享的「close 请求已经发出、等待 inventory 验证」状态：key → 验证记录
     * { sessionId, rootSessionId, tabId, address, attemptToken, manual, misses, deadline, lease }。
     *
     * 关闭请求 resolve 之后绝不能立刻收口：记录只在**连续两次可读 inventory 都读不到这个精确 tabId**
     * 时才算 verified-closed。验证链因此必须与来源账本同层共享——重挂载后的新实例继续采样、继续收口，
     * 而不是把「请求完成」当成「已经关闭」。租约同时被这条记录持有，下一轮同步绝不会重复 close。
     */
    const sharedSidebarAutoCloseVerifications = sharedAutoLedger.closeVerifications;
    /**
     * 跨 Panel 实例共享的自动关闭失败冷却：key → { step, until }。
     *
     * 与重试计数同层共享：scope remount 或同一个实例 A→B→A 绝不能绕过失败上限（否则频繁重挂载就等于
     * 无限重试）。generation token 只负责阻止旧动作越权，不改变这份预算的生命周期。
     */
    const sharedSidebarAutoCloseCooldowns = sharedAutoLedger.closeCooldowns;
    /**
     * 跨 Panel 实例共享的 Auto 候选采样计数：key → { sessionId, rootSessionId, tabId, misses }。
     *
     * 症状与根因：候选选择阶段的在场判据原先只采**一次**样。宿主 inventory 只要在这一帧短暂缺项
     * （布局换桶、面板重挂载、宿主提交窗口的中间态都是正常抖动），单次 absent 就会立刻删掉这个 key
     * 的 record / 来源 / 预算——tab 明明还在宿主里，却永久失去 Auto 归属，资源结束后再也不会被
     * 自动收回（用户看到的正是「偶尔漏收」）。记录同步器（record.misses）与关闭验证链
     * （verification.misses）都要求 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS 次**连续**缺失，候选选择
     * 必须与它们同一条确认语义，否则同一份 inventory 在两处被解释成两种强度。
     *
     * - 生命周期：第一次 absent/recycled 采样时写入；任一 present 采样立刻清零（与既有语义一致）；
     *   这个 key 的 Auto 关闭记账整体收口时（clearAutoCloseAttempt，覆盖预算 / owner / 冷却的
     *   所有入口）一并删除，因此绝不跨代残留；
     * - 计数只对**同一个 tabId** 有效：record 换成宿主新分配的 tabId 时旧计数自动作废；
     * - 限容：**纯 LRU**（按最近一次采样时间排序）+ SIDEBAR_AUTO_KEY_LIMIT，绝不新增无界 Map；
     *   绝不用当前实例的局部 record / 在途状态判定别的 scope 的共享条目（见 trimSharedSidebarAutoTabMisses）。
     */
    const sharedSidebarAutoTabMisses = sharedAutoLedger.tabMisses;
    /**
     * sharedSidebarAutoTabMisses 的限容淘汰：**纯 LRU**——按「最近一次采样」排序，淘汰最久没被采样的条目。
     *
     * 为什么这条 Map 绝不能用 trimAutoKeyMap(map, true) 那套「活动感知」淘汰：
     * 1. 生命周期不匹配。这份计数必须**跨 Panel 实例、跨 root / sidebar session 共享**（确认序列要在
     *    重挂载之后继续推进），而活动判定 sidebarAutoCloseKeyIsActive 读的是**当前这个实例**的局部
     *    在途状态（pending / opening / reservation / verification / cooldown）与**当前 scope** 的
     *    record。别的 scope 的条目在当前实例里天然「不活动」，于是它们会在别的 scope 的一次普通采样
     *    写入时被当成历史条目淘汰——正是本插件要修的「偶尔漏收」：目标 key 的确认计数被打回 1，永远
     *    到不了 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS，record / origin 保留但那个 tab 再也不自动收回。
     * 2. 采样计数本来就与在途状态无关：它只回答「这个 tabId 连续几次被**可读采样**判为不在场」。
     *    跨 scope 的条目同样需要完整数满两次，因此可淘汰性只能由「最后一次采样有多旧」决定，绝不能由
     *    当前帧的 record / 在途状态决定。
     *
     * 为什么 128 上限够用：确认只需 2 次采样，而**每次采样都会把这个 key 重新插到队尾**
     * （见 sampleAutoTabMisses），所以一个正在确认中的 key 只有在「它两次采样之间又插入了 128 次其它
     * 采样」时才会被挤掉；每个 surface 每轮至多推进自己的一条采样，真实轮询周期远小于这个量级。
     * 上限本身继续防止复合键（session + root + 资源地址）随长生命周期无界增长。
     */
    const trimSharedSidebarAutoTabMisses = () => {
      while (sharedSidebarAutoTabMisses.size > SIDEBAR_AUTO_KEY_LIMIT) {
        const oldest = sharedSidebarAutoTabMisses.keys().next();
        if (oldest.done === true) break;
        sharedSidebarAutoTabMisses.delete(oldest.value);
      }
    };
    /**
     * 跨 Panel 实例共享的「同一个 tab 上已经有一次关闭在途」租约：key =（sidebar session + root + tabId）
     * → 租约对象（身份 + 结算信号）。
     *
     * 症状与根因：宿主右栏的 close() 可能是异步的（返回 Promise，结算后才真的移除 tab）。旧 Panel 实例
     * 发出这次关闭后就被卸载了，但那次调用的续体仍在运行；而它的 pending 锁与 busy 闸门都是**实例级**
     * 的，新实例一概看不见——宿主 inventory 里这个 tab 还在，新实例收养它之后会为同一个 tabId 再发一次
     * close。宿主若非幂等（或复用了 tabId），用户就会看到重复副作用（关掉别人的 tab / 抛错）。
     *
     * 因此这把锁必须与来源账本同层共享：身份是（当前 sidebar session + root + tabId），Auto 单 tab 关闭、
     * 手动单 tab 关闭与批量关闭三个入口共用它；只在真正调用宿主 close 的那一小段持有，并在 finally 归还。
     * 锁只回答「这个 tab 现在有人在关吗」，不携带任何 Panel 实例状态。
     *
     * 值不是「无结果的 token」而是一份**可结算的租约**：它额外携带那一次 close 的真实结果（成功 / 失败）
     * 与一个等待信号。竞争方（用户触发的手动单项与批量）必须等到结算再决定下一步——上次成功就当作这个
     * tab 已经被关掉、绝不再 close；上次失败才允许用当前 inventory 复核同一个 tabId 后做一次有限重试。
     * 少了这层结果信号，等待者只能看到「锁空了」：要么对已经关掉的 tab 重复 close，要么把一次失败的
     * 竞争当成「有人处理了」而丢掉用户的关闭意图。
     */
    const sharedSidebarTabCloseInFlight = sharedAutoLedger.tabCloseInFlight;

    return {
      config, react, primitives,
      panelSnapshotCache, peekCachedSnapshot, writeCachedSnapshot, initialStateFor,
      sharedAutoLedgerState, sharedAutoLedger,
      sharedSidebarAutoOrigin, sharedSidebarAutoSuppressed, sharedSidebarAutoCloseAttempts,
      sharedSidebarAutoCloseAttemptOwners, sharedSidebarAutoCloseVerifications, sharedSidebarAutoCloseCooldowns,
      sharedSidebarAutoTabMisses, trimSharedSidebarAutoTabMisses, sharedSidebarTabCloseInFlight,
    };
  }

  /**
   * 每帧读取面（frame）：拆分前 Panel 体开头那一段纯读，加上两处必须**提前**求值的纯绑定。
   *
   * - model / panelLocale / t / errorLabelOf 由原 625–632 行前移：任务播报 effect（原 470 行）
   *   要用 t；提前求值不改变任何取值，只是把纯读放到所有 Hook 之前。
   * - 宿主服务与 split 事务入口（原 1903–1930 行）前移：挂载 effect（原 1689 行）在卸载收口里
   *   读 sidebarRight / releaseRightbarDragLock / cancelSidebarSplit；同属纯读。
   * - frame.late 是跨 Hook 前向引用的晚绑定槽位（见各 Hook 里的包装与登记）。
   */
  function createSidebarPanelFrame(props, shared) {
    const { config } = shared;
    const frame = Object.assign(Object.create(null), shared);
    frame.props = props;
    frame.late = Object.create(null);
    const ctx = props?.ctx || config.ctx;
    let tabInfo = null;
    if (typeof props?.useTabInfo === "function") {
      try { tabInfo = props.useTabInfo(); } catch { tabInfo = null; }
    }
    const tabParams = object(tabInfo?.tab?.navigation?.params);
    // 每次渲染只读一次 sessions 快照：官方目录项（mode/activity）与权威 title 都来自它，
    // 会话订阅触发的重渲染因此能刷新行内状态与圆点。0.1.7-alpha.2 的目录改为按会话 id 索引的
    // 会话投影（projectionsBySession[sessionId].values.subagentCatalog）。
    const sessionsSnapshot = listSnapshot(config, ctx);
    // 目录查找表与快照同一帧只建一次：每行渲染都用它取官方目录项（mode/activity），
    // 旧实现每行都要线性扫描一次 entries，行数一多就成了主要渲染成本。
    const catalogEntryOf = createCatalogLookup(sessionsSnapshot);
    const fallbackCurrent = currentSessionIdOf(sessionsSnapshot);
    const scopedId = typeof config.sessions?.scopeOf === "function" ? config.sessions.scopeOf(ctx) : undefined;
    const scope = props?.scope || props?.tab?.scope || tabInfo?.scope || {};
    const sessionId = text(scope.sessionId, text(props?.sessionId, text(props?.rootSessionId, text(tabParams.rootSessionId, text(scopedId, fallbackCurrent)))));
    let resolvedRoot = sessionId;
    if (typeof config.resolveRootSessionId === "function" && sessionId !== null) {
      try { resolvedRoot = text(config.resolveRootSessionId(sessionId, undefined, listSnapshot(config, ctx)), sessionId); } catch { resolvedRoot = sessionId; }
    }
    const rootSessionId = resolvedRoot || "";
    // 右栏 tab 域按当前 Session 隔离；缺失时回退 root，保持旧宿主的确定性作用域。
    const sidebarSessionId = sessionId || rootSessionId;
    /**
     * 当前面板所在 tab 的活跃度（票据 16）：true / false / null（未知）。
     *
     * 读面只在这里解析一次（渲染期纯读），两个消费者共用同一份结论：
     * - 挂载 effect 用它决定是否一开始就暂停轮询；
     * - 独立的活跃度 effect 用它处理「非活跃 → 暂停 / 重新活跃 → 立即刷新」。
     * 宿主没有明确 active 字段时是 null：生产退回 document 可见性，绝不凭旁证暂停。
     */
    const tabActivity = readPanelTabActivity(config, props, tabInfo);
    const tabActivityKey = tabActivity === true ? "active" : (tabActivity === false ? "inactive" : "unknown");
    const model = modelApi();
    const panelLocale = PANEL_STATE_A.resolvePanelLocale(model, ctx, tabInfo);
    const t = PANEL_STATE_A.createPanelTranslator(model, panelLocale);
    const errorLabelOf = (source) => PANEL_STATE_A.errorLabelOf(t, source);
    /**
     * 导航与侧栏动作依赖的可选服务（每个渲染帧解析一次，成本是可忽略的属性读取）。
     *
     * 候选顺序与 getOpenSession 一致：显式注入的 deps → tab 的 props.ctx → install ctx。
     * 三者都拿不到时保持 null：主视图导航退回旧接口，标题后箭头不渲染（绝不出现点了没反应的按钮）。
     */
    const serviceCandidates = [config, ctx, config.ctx];
    const sessionsService = resolveClientService(serviceCandidates, "sessions");
    const sidebarRight = resolveClientService(serviceCandidates, "sidebarRight");
    /**
     * install 侧注入的「右栏拖拽手柄锁」重估入口：真正的状态与 DOM 写入都在 install 闭包里
     * （只有它知道当前可见会话与宿主提交的活跃 tab），面板只负责在自己已有的观察/轮询
     * 生命周期上顺带请求一次。直接使用 createExpertGroupPanel 的宿主或测试没有这个入口，
     * 此时保持 no-op：面板渲染与交互逐字节不变。
     */
    const requestRightbarDragSync = typeof config.syncRightbarDragLock === "function" ? config.syncRightbarDragLock : null;
    /** 面板卸载时的无条件解锁入口（语义见 install 侧 releaseRightbarDragLock 的说明）。 */
    const releaseRightbarDragLock = typeof config.releaseRightbarDragLock === "function" ? config.releaseRightbarDragLock : null;
    /**
     * 首次 split 的宽度事务只由 install 侧协调：面板报告用户意图、split 回执和资源提交，
     * 自己不直接写 layout。没有 install 注入时保持旧宿主的 no-op 兼容路径。
     */
    const beginSidebarSplit = typeof config.beginSidebarSplit === "function" ? config.beginSidebarSplit : null;
    const markSidebarSplitPane = typeof config.markSidebarSplitPane === "function" ? config.markSidebarSplitPane : null;
    const markSidebarSplitOpen = typeof config.markSidebarSplitOpen === "function" ? config.markSidebarSplitOpen : null;
    const commitSidebarSplit = typeof config.commitSidebarSplit === "function" ? config.commitSidebarSplit : null;
    const cancelSidebarSplit = typeof config.cancelSidebarSplit === "function" ? config.cancelSidebarSplit : null;
    const openSidebarResource = methodOf(sidebarRight, "openResource");
    Object.assign(frame, {
      ctx, tabInfo, tabParams, sessionsSnapshot, catalogEntryOf, fallbackCurrent, scopedId, scope,
      sessionId, resolvedRoot, rootSessionId, sidebarSessionId, tabActivity, tabActivityKey,
      model, panelLocale, t, errorLabelOf,
      serviceCandidates, sessionsService, sidebarRight, requestRightbarDragSync, releaseRightbarDragLock,
      beginSidebarSplit, markSidebarSplitPane, markSidebarSplitOpen, commitSidebarSplit, cancelSidebarSplit,
      openSidebarResource,
    });
    return frame;
  }



  function useSidebarPanelViews(frame) {
    const {
      bump, catalogEntryOf, clearSessionModelRole, closeSidebarResource, commitSessionModelChanges, config,
      expand, handleOpen, handleSidebarAction, handleSidebarBatchClose, meta, model,
      navigation, neutralRuntimeStatus, openSidebarResource, partialSnapshot, primitives, react,
      readActiveSidebarResource, rootSessionId, sessionId, sessionModelCatalog, sessionModelDialogRef, sessionModelDrafts,
      sessionModelHasInvalidDraft, sessionModelNotice, sessionModelOpen, sessionModelPendingChanges, sessionModelSaving, sessionModelState,
      sessionsSnapshot, sidebarBatchPendingRef, sidebarBatchScopeKey, sidebarBatchStateFor, sidebarOpenTabsAvailable, sidebarSessionId,
      sidebarTabRecordsRef, snapshot, subagentAddressOfChild, t, timelineExpandedRef, toggle,
      updateSessionModelDraft,
    } = frame;


    // ── R6（票据 23）：Panel 视图层（三组子视图）的上下文与窄命令 ─────────────────────
    // 视图层只接收「本帧只读投影 + 窄命令」：在途动作锁、右栏 tab 记录、时间线展开 Set、
    // 弹窗开关与重读令牌全部仍由 Panel 独占，视图一律经下列命令写入，绝不持有可写引用。
    /** 时间线展开的只读投影。 */
    const isTimelineExpanded = (key) => timelineExpandedRef.current.has(key) === true;
    /**
     * 时间线展开的窄命令：有界记账（最近 256 份）+ 一次重渲染。
     *
     * 记账与 bump 都留在 Panel：视图只发命令，因此「谁写这份 Set」只有一个答案。
     */
    const toggleTimelineExpanded = (key) => {
      const expandedKeys = timelineExpandedRef.current;
      if (expandedKeys.has(key)) expandedKeys.delete(key);
      else {
        expandedKeys.add(key);
        // 有界记账：长会话里节点会不断消失/新增，只保留最近的 256 份展开选择，
        // 避免一份永不清理的 Set 随会话寿命无界增长。
        while (expandedKeys.size > TIMELINE_EXPANDED_KEY_LIMIT) {
          const oldest = expandedKeys.values().next();
          if (oldest.done === true) break;
          expandedKeys.delete(oldest.value);
        }
      }
      bump((value) => value + 1);
    };
    /** 标题行批量关闭的在途投影（可写 Set 归 Panel）。 */
    const isBatchPending = () => sidebarBatchPendingRef.current.has(
      sidebarBatchScopeKey(sidebarSessionId, rootSessionId),
    ) === true;
    /** 右栏 tab 记录的只读投影（可写 Map 归 Panel）。 */
    const isTabOpen = (key) => sidebarTabRecordsRef.current.get(key) !== undefined;
    /**
     * 视图上下文（第一、二组）：本帧只读投影 + 窄命令。
     *
     * 每次渲染重建一份并交给 createSidebarViewsA/B；它们返回的渲染函数与拆分前 Panel 内的
     * 箭头函数一一对应（同名同签名），因此调用点、调用顺序与渲染结果一字未改。
     */
    const viewCtx = {
      react, primitives, t, model, meta, snapshot, sessionsSnapshot, config,
      sessionId, sidebarSessionId, rootSessionId, catalogEntryOf,
      handleSidebarAction, handleSidebarBatchClose,
      openSidebarResource, closeSidebarResource, readActiveSidebarResource, sidebarOpenTabsAvailable,
      sidebarBatchStateFor, toggle, expand, handleOpen, subagentAddressOfChild, navigation,
      isBatchPending, isTabOpen, isTimelineExpanded, toggleTimelineExpanded,
      partialSnapshot, neutralRuntimeStatus,
      sessionModelOpen, sessionModelState, sessionModelCatalog, sessionModelSaving, sessionModelNotice,
      sessionModelDrafts, sessionModelHasInvalidDraft, sessionModelPendingChanges, sessionModelDialogRef,
      updateSessionModelDraft, clearSessionModelRole, commitSessionModelChanges,
    };
    const viewsA = VIEWS_A.createSidebarViewsA(viewCtx);
    const { renderChevron, renderSidebarBatchSlot } = viewsA;
    const viewsB = VIEWS_B.createSidebarViewsB(viewCtx, viewsA);
    // 首屏懒加载 sessionStats 的判定（Hook 位于其下方原位置）也只经视图层的只读投影。
    const { sessionStatsPresentOf, renderMetrics, renderRowMain } = viewsB;

    /**
     * 按需加载子会话的 sessionStats 投影（一次性副作用，服务用量速览的 DSH 权威数据）。
     *
     * 根因：DSH 的 sessions 列表快照只带列表投影子集（tokenUsage / contextPressure 等），
     * sessionStats 是客户端按需投影，必须经公开的 sessions.refreshProjections(sessionId)
     * 加载；未打开过的 child 会话不会自动加载，于是旧专家行只能回退 DEG，出现「用时<1s」
     * 假用时并缺 TPS。这里在拿到 DEG 快照后，为树里出现但还没有 sessionStats 的会话各请求一次。
     *
     * 边界（不阻塞首帧、不自转、不改变请求契约）：
     * - 首帧仍可显示 DEG 回退值；刷新成功后 sessions 订阅会 bump 一次重渲染，
     *   sessionStats / tokenUsage 自然进入 projectionValueOf 读面并替换回退值；
     * - useRef 的集合跨渲染保留：同一会话只请求一次，刷新失败也不重试（不写错误槽）；
     * - 公开方法缺失、同步抛错、Promise 拒绝一律吞掉——投影刷新只是体验优化，绝不让面板崩；
     * - 快照为空（skeleton/空态）时直接跳过，不产生任何请求。
     * hook 无条件调用（位于渲染助手区之前）：每次渲染的 hook 顺序稳定，不改变其余 hook 的调用语义。
     */

    Object.assign(frame, {
      isBatchPending, isTabOpen, isTimelineExpanded, renderChevron, renderMetrics, renderRowMain,
      renderSidebarBatchSlot, sessionStatsPresentOf, toggleTimelineExpanded, viewCtx, viewsA, viewsB,
    });
  }

  function useSidebarPanelProjectionRef(frame) {
    const {
      react,
    } = frame;

    const projectionRefreshRequestedRef = typeof react.useRef === "function"
      ? react.useRef(new Set())
      : { current: new Set() };

    Object.assign(frame, {
      projectionRefreshRequestedRef,
    });
  }

  function assembleSidebarPanelBody(frame) {
    const {
      emptyFilter, errorLabelOf, expand, filterState, idleSidebarResourceAddresses, model,
      partialSnapshot, pendingSet, react, recoveryRetryRef, renderSidebarBatchSlot, retryRecovery,
      rootSessionId, runAction, runningSidebarResourceAddresses, runtimeStatusOfNode, sessionModelEntryRef, setFilterState,
      setSessionModelOpen, setSessionModelReloadToken, sidebarIdleChildren, snapshot, t, viewCtx,
      viewsA, viewsB,
    } = frame;

    const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
    /**
     * 客户端本地过滤（票据 12）：只读内存快照，不新增 RPC、不写任何持久化。
     *
     * 三条语义：
     * - 过滤状态绑定 root：切换会话后旧搜索词/角色/状态不会把新会话的树整棵隐藏；
     * - 祖先路径保留：父级用 isVisible（自身命中，或任一子节点/分片命中）决定整棵子树是否展示；
     * - 批量 slot 在过滤期间隐藏：批量关闭作用于整棵树，不能让用户在「看不见候选」时误关。
     */
    // 过滤派生（绑定 root / 祖先保留 / active 判定）归 panel-state-a；本层只接住结果与 setState。
    const { filterSource, taskFilter, filterActive, passesFilter } = PANEL_STATE_A.selectTaskFilter(
      model,
      filterState,
      rootSessionId,
      emptyFilter,
    );
    const updateFilter = (patch) => {
      setFilterState(PANEL_STATE_A.nextFilterPatch(filterSource, patch, rootSessionId));
    };
    // 普通专家按实际运行状态分组，fan-out 父任务则按 manager 的聚合终态进入空闲组。
    // 轻量快照（partial）下没有活动证据的专家是 unknown：**仍进空闲组显示**（位置与完整快照
    // 一致，不再因证据缺失而换组），但圆点/文案保持中性，且不参与任何批量关闭或抑制清理
    // （见 sidebarNodeIsIdleMembership 与 idleSidebarResourceAddresses 的分工）。
    // fan-out 展示与取消/重试仍使用各自的 manager 状态，不受分组位置影响。
    const idleChildren = sidebarIdleChildren();
    const visibleChildren = children.filter((node) => !idleChildren.includes(node)).filter((node) => passesFilter(node));
    const visibleIdleChildren = filterActive === true ? idleChildren.filter((node) => passesFilter(node)) : idleChildren;
    // 两行标题后的批量 slot 内容：主代理行只覆盖运行中的普通专家/最新分片，空闲标题行只覆盖
    // idleChildren（因此天然继承同一套证据规则：unknown 成员不在其中，绝不成为关闭候选）。
    // 两者都只在渲染期纯读 openTabs inventory 与 close 能力（inventory 读不出来、
    // 或候选存在但 close 缺失时返回 null，不渲染任何东西）；打开能力不参与这里的判定。
    // 过滤期间整体隐藏（见上面 updateFilter 的说明）。
    const rootBatchSlot = filterActive === true ? null : renderSidebarBatchSlot(runningSidebarResourceAddresses(), "运行中的子代理");
    const idleBatchSlot = filterActive === true ? null : renderSidebarBatchSlot(idleSidebarResourceAddresses(idleChildren), t("sidebar.idleGroup.name"));
    const root = snapshot?.root;
    // ── R6（票据 23）：第三组视图（专家 / 空闲分组 / 分片 / fan-out / 工具条与「会话模型」弹窗）
    // 在 root 与过滤派生就绪后绑定：它需要本帧的 root、过滤结果与在途动作锁投影。
    /** 行内动作的在途投影（可写 Set 归 Panel）。 */
    const isActionPending = (key) => pendingSet.current.has(key) === true;
    /** 「会话模型」弹窗开关命令：开关的 useState 归 Panel。 */
    const toggleSessionModelDialog = () => setSessionModelOpen((previous) => previous !== true);
    const closeSessionModelDialog = () => setSessionModelOpen(false);
    /** 弹窗「重新读取」命令：只递增重读令牌，绝不冲掉当前草稿。 */
    const retrySessionModelLoad = () => setSessionModelReloadToken((value) => value + 1);
    const viewsC = VIEWS_C.createSidebarViewsC({
      ...viewCtx,
      root, filterSource, updateFilter, passesFilter, filterActive, taskFilter,
      runAction, isActionPending, runtimeStatusOfNode, sessionModelEntryRef,
      closeSessionModelDialog, toggleSessionModelDialog, retrySessionModelLoad,
    }, viewsA, viewsB);
    const { renderExpert, renderIdleGroup, renderFanout, renderToolbar, renderSessionModelDialog } = viewsC;
    const rootOpen = root === null ? true : expand(root);
    // 根层的可见兄弟集合（票据 18）：普通/空闲成员之外，空闲分组本身也是根的一个可见子项。
    // 过滤把空闲组整体隐藏时它**不计入** setsize/posinset，位置信息必须与用户看到的集合一致。
    const idleGroupVisible = !(filterActive === true && visibleIdleChildren.length === 0);
    const rootSiblingCount = visibleChildren.length + (idleGroupVisible ? 1 : 0);
    // 根行的圆点走与专家行同一条 partial 规则：轻量快照里没有活动证据的根会话渲染中性圆点，
    // 而不是「已结束」的绿色圆点；完整快照与旧宿主下与既有渲染逐字一致。
    const rootStatus = runtimeStatusOf(root, null, { partial: partialSnapshot });
    /**
     * 恢复失败横幅（票据 04）：**独立**于标题栏的「快照读取失败」错误面。
     *
     * 两者语义不同，绝不合并：
     * - 快照读取失败 = 这次 RPC 没拿到任务树（viewState.error + 重试按钮）；
     * - 恢复失败 = 任务树读得到，但持久化恢复失败（磁盘快照可能不完整，fail-closed 生效），
     *   需要重新读取持久化快照并重跑恢复。
     *
     * 横幅只由 Host 的权威投影 snapshot.recovery 驱动（旧 Host 缺失该块 ⇒ 不渲染）；
     * 本地 retry 状态只补充「重试中/重试失败」这一行，不替代原因码。
     */
    const recovery = snapshot?.recovery ?? null;
    const recoveryFailed = recovery !== null && recovery.status === "failed";
    const recoveryRetry = recoveryRetryRef.current;
    // rootSessionId 绑定：切换 root 后旧请求的 in-flight/error 不属于当前 surface。
    const recoveryRetryPending = recoveryRetry.inFlight === true && recoveryRetry.rootSessionId === rootSessionId;
    const recoveryCode = recovery === null ? null : text(recovery.code, "RESTORE_FAILED");
    // 补充行只在「当前仍是失败态，且重试失败与当前原因码同一来源」时显示：
    // Host 后来换了原因码（例如先 INVALID_SNAPSHOT、修复后变 BUDGET_EXCEEDED）时，
    // 旧重试的文案不再适用，必须让位给新的主原因码（两个稳定本地码始终保留）。
    const recoveryRetryError = recoveryFailed === true
      && recoveryRetry.rootSessionId === rootSessionId
      && recoveryRetry.error !== null
      && (recoveryRetry.error.code === recoveryCode
        || recoveryRetry.error.code === "RETRY_FAILED"
        || recoveryRetry.error.code === "NO_RESTORABLE_SNAPSHOT")
      ? recoveryRetry.error
      : null;
    const recoveryMessage = recovery === null ? null : text(recovery.message, null);
    const recoveryBanner = recoveryFailed !== true
      ? null
      : react.createElement("div", {
        className: "deg_expert_group_recovery",
        role: "alert",
        "data-recovery-status": "failed",
        "data-recovery-code": recoveryCode,
        // title 提供完整文案：可见行按一行省略，悬停仍可读到全部（仍受 Host 200 字上限约束）。
        title: recoveryMessage === null ? "恢复失败（" + recoveryCode + "）" : recoveryMessage,
      },
      react.createElement("span", { className: "deg_expert_group_recovery_text" },
        "任务恢复失败（" + recoveryCode + "）" + (recoveryMessage === null ? "" : "：" + recoveryMessage)),
      recoveryRetryError === null
        ? null
        : react.createElement("span", { className: "deg_expert_group_recovery_retry_error", role: "status" },
          "重试未恢复（" + text(recoveryRetryError.code, "RETRY_FAILED") + "）"
          + (text(recoveryRetryError.message, "") === "" ? "" : "：" + text(recoveryRetryError.message, ""))),
      react.createElement("button", {
        type: "button",
        className: "deg_expert_group_recovery_retry",
        // retryable=false 只影响提示语（结构性快照缺陷）；按钮仍保留：重试会重读磁盘，
        // 外部修复后仍可能成功，入口绝不隐藏。
        title: recovery.retryable === false
          ? "该原因通常需要修复持久化快照后才能恢复；点击会重新读取当前持久化快照"
          : "重新读取当前持久化快照并重跑恢复",
        "aria-label": t("sidebar.recovery.retry"),
        "aria-busy": recoveryRetryPending || undefined,
        disabled: recoveryRetryPending,
        onClick: retryRecovery,
        // 文字按钮：进度态把文案换成「重试中…」，可见且可被辅助技术读到。
      }, recoveryRetryPending ? t("sidebar.recovery.retrying") : t("sidebar.recovery.retry")));
    /**
     * 错误空态（票据 13）：失败且没有任何可展示快照时，标题栏错误槽之外还要有一块**独立**的
     * 正文占位——只留一行「暂无 Expert Group 任务」会让用户以为任务真的不存在。
     *
     * 三个来源共用同一块空态，但文案与 data-error-source 各自可辨：可见文案是来源短文案
     * （与标题栏一致），细节 message 放在下面一行并以 title 提供完整内容（受 Host 限长约束）。
     * 有缓存快照时这条空态根本不渲染：上一次的数据继续显示，错误只在标题栏提示。
     */
    const errorEmptyState = (panelError) => react.createElement("div", {
      className: "deg_expert_group_empty deg_expert_group_error_empty",
      role: "alert",
      "data-error-source": panelError.source,
      title: panelError.message,
    },
    react.createElement("div", { className: "deg_expert_group_error_empty_title" },
      errorLabelOf(panelError.source)),
    react.createElement("div", { className: "deg_expert_group_error_empty_detail" }, panelError.message));

    Object.assign(frame, {
      children, closeSessionModelDialog, errorEmptyState, filterActive, filterSource, idleBatchSlot,
      idleChildren, idleGroupVisible, isActionPending, passesFilter, recovery, recoveryBanner,
      recoveryCode, recoveryFailed, recoveryMessage, recoveryRetry, recoveryRetryError, recoveryRetryPending,
      renderExpert, renderFanout, renderIdleGroup, renderSessionModelDialog, renderToolbar, retrySessionModelLoad,
      root, rootBatchSlot, rootOpen, rootSiblingCount, rootStatus, taskFilter,
      toggleSessionModelDialog, updateFilter, viewsC, visibleChildren, visibleIdleChildren,
    });
  }

  function assembleSidebarPanelBodyPart2(frame) {
    const {
      errorEmptyState, filterActive, idleBatchSlot, idleChildren, idleGroupVisible, primitives,
      react, renderChevron, renderExpert, renderFanout, renderIdleGroup, renderMetrics,
      renderRowMain, renderToolbar, root, rootBatchSlot, rootOpen, rootSessionId,
      rootSiblingCount, rootStatus, snapshot, t, taskFilter, viewState,
      visibleChildren, visibleIdleChildren,
    } = frame;

    const body = viewState.loading && snapshot === null
      ? react.createElement("div", { className: "deg_expert_group_tree", "aria-busy": "true" }, react.createElement("div", { className: "deg_expert_group_skeleton" }), react.createElement("div", { className: "deg_expert_group_skeleton" }))
      : snapshot === null && viewState.error !== null
        ? errorEmptyState(viewState.error)
        : snapshot === null
        ? react.createElement("div", { className: "deg_expert_group_empty" }, t("sidebar.empty"))
        : react.createElement("div", { className: "deg_expert_group_tree" },
          renderToolbar(),
          // 树语义（票据 18）：role=tree 只包住真正的树项，工具条（role=search）留在树外，
          // 避免辅助技术把搜索框当成树的子项。aria-label 给整棵树一个稳定名称。
          react.createElement("div", { className: "deg_expert_group_tree_items", role: "tree", "aria-label": "专家任务树" },
          react.createElement("div", { className: "deg_expert_group_node deg_expert_group_node_root", role: "none", "data-root": "true" },
            react.createElement("div", {
              className: "deg_expert_group_row",
              role: "treeitem",
              "aria-level": 1,
              "aria-posinset": 1,
              "aria-setsize": 1,
              "aria-expanded": rootOpen,
              "data-status": rootStatus,
              "data-expanded": rootOpen,
            }, statusIcon(react, primitives, rootStatus), renderChevron(root, rootOpen), react.createElement("div", null, renderRowMain(root, {
              sessionId: root.sessionId,
              parentId: null,
              expanded: true,
              trailing: rootBatchSlot,
              // 会话节点只有 startedAt/lastActivityAt（Host 不发布会话完成时间，durationMs 为 null）。
              metrics: renderMetrics(root, { kind: "root", runtimeStatus: rootStatus, sessionId: root.sessionId, sessionIds: [root.sessionId] }),
            }))),
            rootOpen ? react.createElement("div", { className: "deg_expert_group_children", role: "group" }, [
              ...visibleChildren.map((node, index) => node.kind === "fanout"
                ? renderFanout(node, index, { level: 2, posinset: index + 1, setsize: rootSiblingCount })
                : renderExpert(node, index, rootSessionId, { level: 2, posinset: index + 1, setsize: rootSiblingCount })),
              // 过滤期间：空闲组成员的命中才算命中；整组没有命中时不渲染空分组（由下方空态统一提示）。
              idleGroupVisible
                ? renderIdleGroup(filterActive === true ? visibleIdleChildren : idleChildren, idleBatchSlot, { level: 2, posinset: visibleChildren.length + 1, setsize: rootSiblingCount })
                : null,
              // 过滤无命中时的空态：只提示「没有匹配」，绝不把「零结果」伪装成「没有任务」。
              // 根行自身命中也算有结果（它始终可见，不再叠加一条「没有匹配」的误导提示）。
              filterActive === true && visibleChildren.length === 0 && visibleIdleChildren.length === 0
                && taskFilter !== null && taskFilter.matches(root) !== true
                ? react.createElement("div", { className: "deg_expert_group_filter_empty", role: "status" }, t("sidebar.filter.empty"))
                : null,
            ].filter((node) => node !== null && node !== undefined)) : null)));
    /**
     * 标题栏「Auto」开关（紧凑、与标题同一行，不遮挡标题与行内批量控件）：
     *
     * - 勾选态：权威读面（install 注入的 getter，每次渲染现读）叠加本地乐观值；
     * - 可访问性：input 自带 aria-label="Auto"，可见文字也是 Auto，说明性文案只放在 title 里，
     *   不新增任何长段落；
     * - 写面缺失（直接 createExpertGroupPanel 的旧宿主/单测）时 disabled：绝不渲染一个点了没反应的开关。
     */

    Object.assign(frame, {
      body,
    });
  }

  function renderSidebarPanelSection(frame) {
    const {
      announcement, autoOpenDraft, autoOpenEnabled, body, errorLabelOf, partialSnapshot,
      primitives, react, recoveryBanner, renderSessionModelDialog, retry, snapshot,
      t, toggleAutoOpen, version, viewState, widthResizer, writeAutoOpenSetting,
    } = frame;

    const autoOpenChecked = autoOpenDraft === null ? autoOpenEnabled() : autoOpenDraft === true;
    const autoOpenToggle = react.createElement("label", {
      className: "deg_expert_group_header_auto",
      title: "自动打开运行中的子代理侧栏会话",
    },
    react.createElement("input", {
      type: "checkbox",
      className: "deg_expert_group_header_auto_input",
      "aria-label": "Auto",
      checked: autoOpenChecked,
      disabled: writeAutoOpenSetting === null,
      onChange: (event) => toggleAutoOpen(event?.target?.checked === true),
    }),
    react.createElement("span", { className: "deg_expert_group_header_auto_label" }, "Auto"));
    /**
     * 标题栏的状态区（票据 13）：
     *
     * - partial 徽标：只在 snapshot.partial === true 时出现，明确告诉用户「这份数据不完整」；
     *   中性圆点、空闲分组等既有 partial 契约逐字不变，徽标只是把它们已经在表达的事实显式化。
     * - 「更新于 HH:MM:SS」：只在该 root 有成功快照时出现；时间来自提交成功快照时记录的时间戳，
     *   格式由 formatPanelUpdatedTime 集中定义（本地时区 24 小时制）。
     * - 错误槽：按来源选择固定文案（快照读取失败 / 操作失败 / 请求失败），完整 message 只在 title。
     * - 刷新按钮：**常驻**（不再只在错误时出现）。无错误时 aria-label="刷新"，有错误时保留
     *   既有「重试」语义与 aria-label，两者都走同一个 retry（先清错误再刷新）。
     */
    const panelError = viewState.error;
    const panelErrorLabel = panelError === null
      ? null
      : errorLabelOf(panelError.source);
    const updatedTime = snapshot === null ? null : formatPanelUpdatedTime(viewState.updatedAt);
    const partialBadge = partialSnapshot === true
      ? react.createElement("span", {
        className: "deg_expert_group_partial",
        role: "status",
        "data-partial": "true",
        title: t("sidebar.partial.title"),
      }, t("sidebar.partial"))
      : null;
    const updatedBadge = updatedTime === null
      ? null
      : react.createElement("span", { className: "deg_expert_group_updated", title: t("sidebar.updated.title") }, t("sidebar.updated", { time: updatedTime }));
    const refreshLabel = panelError === null ? t("sidebar.refresh") : t("sidebar.retry");
    const refreshButton = react.createElement("button", {
      type: "button",
      className: "deg_expert_group_header_action",
      title: refreshLabel,
      "aria-label": refreshLabel,
      onClick: retry,
    }, makeIcon(primitives, "IconRefreshOutlineRegular", { size: 14 }));
    return react.createElement("section", { className: "deg_expert_group", "data-version": version, "aria-label": "Expert Group" },
      // 宽度拖拽手柄（票据 18）：只在 install 注入了写入能力时渲染，贴在面板左缘。
      widthResizer,
      // 任务状态播报区（票据 18）：视觉隐藏但始终存在（role=status 隐含 aria-live=polite）。
      // 空字符串时同样保持节点存在，辅助技术才能在后续文本变化时稳定播报。
      react.createElement("div", {
        className: "deg_expert_group_announcer",
        role: "status",
        "aria-live": "polite",
        "aria-atomic": "true",
        "data-announcement": announcement === "" ? undefined : announcement,
      }, announcement),
      react.createElement("header", { className: "deg_expert_group_header" },
        react.createElement("span", { className: "deg_expert_group_header_title" }, t("sidebar.title")),
        partialBadge,
        updatedBadge,
        autoOpenToggle,
        panelError === null
          ? null
          : react.createElement("span", {
            className: "deg_expert_group_error",
            "data-error-source": panelError.source,
            title: panelError.message,
          }, panelErrorLabel),
        refreshButton), recoveryBanner, body,
      // 「会话模型」弹窗挂在任务树之后：只在打开时渲染（关闭态 DOM 与既有面板一致）。
      renderSessionModelDialog());

    Object.assign(frame, {
      autoOpenChecked, autoOpenToggle, panelError, panelErrorLabel, partialBadge, refreshButton,
      refreshLabel, updatedBadge, updatedTime,
    });
  }

  /**
   * Panel 工厂：只做「react 能力校验 → 共享面 → 组件」。
   *
   * 拆分前 createExpertGroupPanel 是 4,176 行；现在它只承担装配，工厂体 ≤400。
   */
  function createSidebarPanel(deps) {
    const config = object(deps);
    const react = config.react;
    const primitives = config.primitives || {};
    if (!react || typeof react.createElement !== "function") {
      return function MissingReactPanel() { return null; };
    }
    const shared = createSidebarPanelShared({ config, react, primitives });

    /**
     * Panel 组件：**只**做「建帧 → 按固定顺序调用 Hook → 渲染组装」。
     *
     * 调用顺序 = 拆分前组件体的语句顺序（Hook 与普通语句的原始相对位置）。任何重排都会改变
     * react.use* 的派发序列；顺序由 test/sidebar-hook-order.test.mjs 的运行期 trace 逐项锁定。
     */
    function Panel(props) {
      const frame = createSidebarPanelFrame(props, shared);
      useSidebarPanelStateCore(frame);
      useSidebarPanelAnnouncementEffect(frame);
      useSidebarPanelWidth(frame);
      useSidebarPanelStoreAndMeta(frame);
      useSidebarPanelSessionModelEffects(frame);
      useSidebarPanelSessionModel(frame);
      useSidebarPanelSessionModelPart2(frame);
      useSidebarPanelSnapshotRefs(frame);
      useSidebarPanelPolling(frame);
      useSidebarPanelAutoRefs(frame);
      useSidebarPanelMountEffects(frame);
      useSidebarPanelActivityEffect(frame);
      useSidebarPanelHostServices(frame);
      useSidebarPanelSnapshotDerived(frame);
      useSidebarPanelMetaEffect(frame);
      useSidebarPanelTabPrimitives(frame);
      useSidebarPanelSnapshotSyncEffect(frame);
      useSidebarPanelTabWiring(frame);
      useSidebarPanelTabWiringPart2(frame);
      useSidebarPanelTabWiringPart3(frame);
      useSidebarPanelTabSync(frame);
      useSidebarPanelAutoOrchestration(frame);
      useSidebarPanelAutoOrchestrationPart2(frame);
      useSidebarPanelTabRecorder(frame);
      useSidebarPanelTabRecorderPart2(frame);
      useSidebarPanelActionHandlers(frame);
      useSidebarPanelActionHandlersPart2(frame);
      useSidebarPanelBatchClose(frame);
      useSidebarPanelViews(frame);
      useSidebarPanelProjectionRef(frame);
      useSidebarPanelProjectionEffect(frame);
      useSidebarPanelRunAction(frame);
      useSidebarPanelRunActionPart2(frame);
      assembleSidebarPanelBody(frame);
      assembleSidebarPanelBodyPart2(frame);
      return renderSidebarPanelSection(frame);
    }
    Panel.displayName = "ExpertGroupPanel";

    return Panel;
  }

  global[SYMBOL] = Object.freeze({ createSidebarPanel });
})(globalThis);
