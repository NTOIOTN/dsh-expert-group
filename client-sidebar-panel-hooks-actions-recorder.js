/**
 * 客户端侧栏 · Panel tab 记录器（从 client-sidebar-panel-hooks-actions.js 移出的自洽块）
 *
 * 本文件承载「打开成功后按宿主证据记录可关闭 tabId」这一整块判定与写入：
 * - useSidebarPanelTabRecorder / useSidebarPanelTabRecorderPart2 两个 Hook（Panel 按固定顺序调用）；
 * - 只被 Part2 私有使用的 readSidebarTabEvidence / resolveSidebarTabOrigin（不对外提供）。
 *
 * 为什么单独成文件：client-sidebar-panel-hooks-actions.js 原本 1,499 行，贴着 1,500 行门禁上限，
 * 任何净增都会违规。这里只做**代码搬家**——判定、时序、写入门槛、错误处理与注释语义逐字保持，
 * 因此 Hook 调用顺序（及其 golden）零变化。
 *
 * 装配：client-sidebar-panel-hooks-actions.js 在加载期从本文件的公开检查点取回两个 Hook，
 * 并按原顺序再导出；Panel 侧的调用点与导出面因此完全不变。
 */
(function installSidebarPanelHooksActionsRecorder(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-actions-recorder");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_TAB_ORIGIN_AUTO, SIDEBAR_TAB_ORIGIN_MANUAL, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    SUBAGENT_CHAT_KIND,
  } = DOM;
  const AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const AUTO_LEDGER = global[AUTO_LEDGER_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, readSidebarAutoOwnershipEntry, sidebarAutoOriginEntry, sidebarAutoOriginTabIdOf,
    writeSidebarAutoOwnership,
  } = AUTO_LEDGER;

  /** 打开成功后按宿主证据记录可关闭 tabId。 */
  function useSidebarPanelTabRecorder(frame) {
    const {

    } = frame;

    /**
     * 打开成功后按宿主 openTabs/active() 证据记录「可关闭的 tabId」。
     *
     * openTabs 条目或 active() 返回的 tab 满足下面三条才记录，缺一条都只说明「还没有可证明的落地证据」：
     * - 有效 id：没有 id 就无法在之后精确关闭，也就没有任何可关闭状态可言；
     * - `kind === "subagentchat"`：active 可能仍是用户原本在看的别的 tab；
     * - `contentId === 资源地址`：同一个 kind 下也可能是另一个子代理的地址。
     * 不满足时保持 >> 的打开语义（按钮照旧可再次点击打开），绝不猜测 tabId。
     *
     * origin 的来源优先级（缺陷 1 之后的定稿判据，**每一层都必须自带证据**）：
     * 手动意图 / 持久 manual > 显式传入的动作来源（**且必须带因果证明**）> 已存在记录（**且 tabId
     * 必须相等**）> 在途打开记录（**且因果证明成立**）> realm 共享来源账本（tabId 逐字相等）>
     * 持久 auto（tabId 逐字相等）> **manual** 兜底。最后那条兜底正是规格要求：「外部已存在但未由
     * 自动动作发起的 tab 视为手动来源」，因此自动同步永远关不掉一个它没有亲手打开过的 tab。
     *
     * 为什么「本次动作声明的来源」还不够：宿主 openResource() 的公开契约里**没有返回值**（返回
     * void，见 lib/types/client/service.d.ts），而且默认 revealIfOpened=true —— 同一个
     * (kind, contentId) 已经有 tab 时它**揭示那一个**，绝不新建。所以「调用过 openResource」+
     * 「随后 inventory 里有一个同地址 tab」并不能证明那个 tab 是我们创建出来的：它完全可能是用户
     * 在等待窗口里从 DSH 其它入口打开的同一个资源。认领它就等于事后替用户关掉他的 tab。
     *
     * 因此 actionProof.autoProven 只由「发出 openResource **之前**亲眼确认 inventory 可读、且该
     * 地址没有已提交 tab」写成（见 handleSidebarAction 的因果证明点）。缺证明一律 manual。
     */

  }

  /**
   * 读「本次打开落地在哪个 tab」的宿主证据：inventory 精确命中优先，读不到再退回 active()。
   * 只读、无副作用；返回 null 表示没有可证明的落地 tab（调用方按「没有证据」fail-closed 处理）。
   * 三条判据缺一不可：有效 id、kind 为子代理会话、contentId 与资源地址逐字相等。
   */
  function readSidebarTabEvidence(deps) {
    const { readActiveSidebarResource, readSidebarOpenTabs, resourceAddress, sidebarRight, sidebarSessionId } = deps;
  let tab = null;
  const inventory = readSidebarOpenTabs();
  if (inventory !== null) {
    for (const entry of inventory) {
      const candidate = object(entry);
      if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
      if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
      if (text(candidate.contentId, null) !== resourceAddress) continue;
      const candidateId = text(candidate.tabId, null);
      if (candidateId !== null) {
        tab = { id: candidateId, kind: candidate.kind, contentId: candidate.contentId, title: null };
        break;
      }
    }
  }
  if (tab !== null && readActiveSidebarResource !== null) {
    try {
      const activeSource = object(readActiveSidebarResource.call(sidebarRight));
      if (text(activeSource.id, null) === tab.id) tab = { ...tab, title: text(activeSource.title, null) };
    } catch { /* inventory 已足够确认 tabId，标题读取失败不阻塞 toggle。 */ }
  }
    if (tab === null) {
      try { tab = readActiveSidebarResource.call(sidebarRight); } catch { return null; }
    }
      const source = object(tab);
      const tabId = text(source.id, null);
       const tabTitle = text(source.title, null);
      if (tabId === null) return null;
      if (text(source.kind, null) !== SUBAGENT_CHAT_KIND) return null;
      if (text(source.contentId, null) !== resourceAddress) return null;
    return { tabId, tabTitle };
  }

  /**
   * 归属来源的优先级链（**每一层都必须自带证据**）：手动意图 / 持久 manual > 显式传入的动作来源
   * （且必须带因果证明）> 已存在记录（且 tabId 相等）> 在途打开记录（且因果证明成立）> realm
   * 共享来源账本（tabId 逐字相等）> 持久 auto（tabId 逐字相等）> manual 兜底。最后那条兜底正是
   * 规格要求：「外部已存在但未由自动动作发起的 tab 视为手动来源」，因此自动同步永远关不掉一个
   * 它没有亲手打开过的 tab。
   *
   * 本函数只读证据、只做判定；写入（清陈旧账本、写来源、改记录）全部留在 recordSidebarTab 里。
   */
  function resolveSidebarTabOrigin(deps) {
    const {
      actionOrigin, actionProof, key, openings, readPersistedEntry, records, resourceAddress, rootSessionId,
      sharedOrigins, sidebarManualIntentOf, sidebarSessionId, tabId,
    } = deps;
  const declaredOrigin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO || actionOrigin === SIDEBAR_TAB_ORIGIN_MANUAL
    ? actionOrigin
    : null;
  /**
   * 本次动作是否带**因果证明**：只有 handleSidebarAction 的自动路径会传它，而且只在
   * 「发出 openResource 之前 inventory 可读且该地址确实没有 tab」时为 true。
   * 手动路径带 null（不需要证明：手动动作恒按 manual 记账）。
   */
  const declaredAutoProven = actionProof !== null && actionProof !== undefined
    && actionProof.autoProven === true;
  const previous = records.get(key);
  const opening = openings.get(key);
  const previousScoped = previous !== undefined
    && previous.sessionId === sidebarSessionId && previous.rootSessionId === rootSessionId
    ? previous
    : undefined;
  const openingScoped = opening !== undefined
    && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId
    ? opening
    : undefined;
  /**
   * 别的写入者证据（缺陷 1 的第二个判据）：这次打开**还没有**把 openResource 发给宿主
   * （causalIssuedAt 还是 null），我们却已经能读到这个地址上的 tab —— 那只可能是别人先打开的
   * （用户从 DSH 其它入口、或另一个 surface）。这次动作从此不再是这个 tab 的因果来源，落地
   * 时一律按 manual 记账，并把它写进在途记录，后续任何一次落地观察都不会再翻案。
   */
  if (openingScoped !== undefined
    && (openingScoped.causalIssuedAt === null || openingScoped.causalIssuedAt === undefined)) {
    openingScoped.foreignWriter = true;
  }
  /**
   * 手动接管优先于调用方声明的来源：用户在那个 key 上留下过「要打开」的手动意图时，即使这次
   * 打开是 Auto 发出的，最终 tab 也必须记成 manual——手动打开的最终来源必须是 manual，
   * Auto 绝不能在资源结束后把它当成自己的 tab 关掉。
   */
  const manualTakeover = sidebarManualIntentOf(key);
  /**
   * 共享 Auto 来源账本（键与打开记录同构，见 sharedSidebarAutoOrigin）。
   *
   * 收养路径（面板重挂载后 / 切 root 后从 inventory 重建记录）没有「本次动作的显式来源」，
   * 实例内的 previous 与 opening 也都是空的；唯一能证明「这个 tab 是 Auto 亲手打开的」的
   * 就是这条跨实例账本。缺了它，收养只能落到 manual 兜底，Auto 从此不再管这个 tab。
   *
   * 只认显式记成 auto 的账本条目，并且必须同 session + 同 root、且绑定的 tabId 与当前证据
   * 逐字相等（见下面的绑定闸门）：别的 scope 的条目一律不可见，来源未知的外部 tab、其它 pane
   * 的同地址 tab，以及「同地址但已经换了 tabId」的 tab 都不会被误收养成 Auto 的 tab。
   */
  const sharedOrigin = sharedOrigins.get(key);
  const sharedOriginScoped = sharedOrigin !== undefined
    && sharedOrigin.sessionId === sidebarSessionId && sharedOrigin.rootSessionId === rootSessionId
    ? sharedOrigin
    : undefined;
  /**
   * tabId 绑定闸门（缺陷 1，与持久条目那条闸门逐字同源，只是证据来自另一层）：
   *
   * 共享账本的条目里记着「Auto 打开/替换落地那一刻亲眼看到的 tab」。只要求「有条目」是不够的：
   * 旧 tab 被用户或宿主移除而插件没有观察到时，同一个 realm 里的下一次收养（重挂载 / 记录被判
   * stale 后的重建）会在同地址上看到**用户新开的 tab**——它的 tabId 与条目里那个不一样。不比对
   * tabId 就按 auto 收养，等于替用户认领他刚打开的 tab，资源随后的 idle 就会把它自动关掉。
   *
   * 条目没有 tabId（null：这次自动打开已经发出、落地证据还没到）同样**不是** auto 证据：它只
   * 回答「这次运行是否已经为它发过打开」，任何归属判定都必须按「证据不足」处理。
   */
  const sharedOriginTabId = sidebarAutoOriginTabIdOf(sharedOriginScoped);
  const sharedOriginBound = sharedOriginTabId !== null && sharedOriginTabId === tabId;
  const sharedOriginStale = sharedOriginScoped !== undefined && sharedOriginBound !== true;
  /**
   * 持久归属标记是「整页刷新 / 进程重启 / HMR 之后」唯一还活着的证据（见 SIDEBAR_AUTO_OWNERSHIP_KEY）：
   * 命中 manual 一律 manual（手动恒优先，安全侧）；命中 auto 还要过下面那条 tabId 绑定闸门才按
   * auto 收养；没有标记按既有 manual 兜底。内存（含 realm 共享账本）与持久层不一致时以 manual
   * 为准，并在下面把内存来源一并抹掉，绝不留「内存 auto / 持久 manual」的歧义。
   */
  const persistedEntry = readPersistedEntry(sidebarSessionId, rootSessionId, resourceAddress);
  const persistedManual = persistedEntry !== null && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL;
  /**
   * tabId 绑定闸门（P1-A）：持久 auto 条目只认「写入时那个 tab」。
   *
   * 条目里的 tabId 是记录这条 auto 归属时宿主 inventory 里这个地址的 tab。整页刷新之后持久条目
   * 是唯一还活着的证据，而右栏里同地址的 tab 完全可能是**另一次 tab 创建**出来的（旧 tab 被用户
   * 或宿主移除而插件没观察到、用户随后从 DSH 其它入口打开同一地址）。不比对 tabId 就按 auto 收养，
   * 等于替用户认领他刚打开的 tab——资源随后 idle，Auto 就会把它关掉。
   *
   * 判定顺序（三档，manual 恒优先）：
   * 1. manual：手动意图（manualIntentOpen）/ 持久 manual 一律 manual，安全侧；
   * 2. 陈旧 auto：持久条目的 tabId 与当前证据不符（或旧格式条目根本没记 tabId）⇒ 它**不再**
   *    作为 auto 证据参与收养。若内存里也没有别的来源证据，最终落到下面的 manual 兜底，并在统一
   *    写入点把这条陈旧条目改写成 manual（理由 manual-stale-auto），避免它长期误导后续判断；
   * 3. auto：只有「内存来源证据」或「tabId 逐字相等的持久 auto」才认 auto。
   *
   * 为什么内存证据（本次动作声明的来源 / 已有记录 / 在途打开）仍然优先：它们是**本 realm 亲眼
   * 观察到的** Auto 动作；但「亲眼观察」必须落实到**证据**上，不能只凭「有一个 auto 来源」：
   * - 本次动作声明的来源（declaredOrigin）：必须带因果证明（actionProof.autoProven，见上面的
   *   说明）——宿主 openResource 没有返回值、而且默认是「已存在就揭示」，光调用过它不足以
   *   证明随后出现的那个 tab 是我们创建的；
   * - 已有记录（previous.origin）：必须 previous.tabId === 当前落地 tabId —— 记录说的是
   *   「T 这个 tab 归 Auto」，宿主换了一个新 id 之后这条记录已经不指向任何还在我们手里的 tab；
   * - 在途打开（opening）：必须 causalProof === "proven"（发出之前亲眼确认地址上没有 tab）、
   *   causalIssuedAt 非空（openResource 真的发出去过）、且 foreignWriter 未置位（期间没有
   *   观察到别的写入者）。
   * 而 realm 共享来源账本与持久条目各要多过一道 tabId 逐字相等的绑定闸门。任何一层缺证据都
   * 按安全侧落 manual：宁可漏收一次，也绝不误关用户刚打开的 tab。
   *
   * 取舍（刻意）：本机页面刷新时宿主从它自己的持久化布局里带回**同一批 tabId**，因此正常刷新场景
   * 仍然恢复 auto；只有宿主真的重新 mint 了 id 时才退化成 manual——宁可漏收一次（那个 tab 留在
   * 右栏里交给用户手动处理，绝不会自己消失），也绝不误关一个可能是用户刚打开的 tab。
   */
  const persistedAutoBound = persistedEntry !== null
    && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
    && persistedEntry.tabId !== null
    && persistedEntry.tabId === tabId;
  const persistedStaleAuto = persistedEntry !== null
    && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
    && persistedAutoBound !== true;
  /**
   * 内存两层的证据闸门（缺陷 1）：
   * - previous：记录必须**绑定当前这个 tabId**，否则那条 auto 记录描述的是另一个已经不存在的
   *   tab（宿主重 mint / 回收），继承它就等于替用户认领他刚打开的 tab；
   * - opening：因果证明成立、openResource 真的发出过、期间没有别的写入者（见 causalProof /
   *   causalIssuedAt / foreignWriter 的说明）。
   */
  const previousUsableAuto = previousScoped !== undefined
    && previousScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
    && previousScoped.tabId === tabId;
  const openingUsableAuto = openingScoped !== undefined
    && openingScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
    && openingScoped.causalProof === "proven"
    && openingScoped.causalIssuedAt !== null && openingScoped.causalIssuedAt !== undefined
    && openingScoped.foreignWriter !== true;
  /**
   * 声明的来源也要过证据闸门：声明 auto 但缺因果证明时**直接落 manual**，绝不继续借用更弱的
   * 层（那正是缺陷 1 的误关形状：这次落地可能压根不是我们的动作打出来的那个 tab）。
   */
  const declaredUsable = declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO
    ? (declaredAutoProven === true ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL)
    : declaredOrigin;
  const manualIntentOpen = manualTakeover !== undefined && manualTakeover.intent === "open";
  const origin = manualIntentOpen || persistedManual
    ? SIDEBAR_TAB_ORIGIN_MANUAL
    : (declaredUsable
      ?? (previousUsableAuto === true
        ? SIDEBAR_TAB_ORIGIN_AUTO
        : (openingUsableAuto === true
          ? SIDEBAR_TAB_ORIGIN_AUTO
          : (sharedOriginBound === true
            ? SIDEBAR_TAB_ORIGIN_AUTO
            : (persistedAutoBound === true ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL)))));
  const recordOrigin = origin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;

    return {
      declaredAutoProven, declaredOrigin, manualIntentOpen, openingScoped, openingUsableAuto, persistedManual,
      persistedStaleAuto, previous, previousUsableAuto, recordOrigin, sharedOriginScoped, sharedOriginStale,
    };
  }

  /** undefined */
  function useSidebarPanelTabRecorderPart2(frame) {
    const {
      bump, closeSidebarResource, primitives, readActiveSidebarResource, readSidebarOpenTabs, rootSessionId,
      sidebarAutoOriginRef, sidebarManualIntentOf, sidebarOnScreenSessionStill, sidebarRight, sidebarSessionId,
      sidebarTabOpeningRef, sidebarTabRecordsRef,
    } = frame;


    /**
     * 打开成功后按宿主 openTabs/active() 证据记录「可关闭的 tabId」。
     *
     * 本函数只做三件事：取证据（readSidebarTabEvidence）→ 判来源（resolveSidebarTabOrigin）→
     * 按判定写入（清陈旧共享账本 / 写 auto 来源 / 写持久归属 / 更新记录）。不满足三条记录条件时
     * 保持 >> 的打开语义（按钮照旧可再次点击打开），绝不猜测 tabId。
     */
    const recordSidebarTab = (key, resourceAddress, actionOrigin, actionProof) => {
      if (closeSidebarResource === null) return false;
       if (readActiveSidebarResource === null && readSidebarOpenTabs() === null) return false;
      // 左箭头图标缺失时不会渲染 <<，因此也不该建立只在 << 上才有意义的记录。
      if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return false;
      const evidence = readSidebarTabEvidence({
        readActiveSidebarResource, readSidebarOpenTabs, resourceAddress, sidebarRight, sidebarSessionId,
      });
      if (evidence === null) return false;
      const { tabId, tabTitle } = evidence;
      const resolution = resolveSidebarTabOrigin({
        actionOrigin, actionProof, key, openings: sidebarTabOpeningRef.current, readPersistedEntry: readSidebarAutoOwnershipEntry,
        records: sidebarTabRecordsRef.current, resourceAddress, rootSessionId,
        sharedOrigins: sidebarAutoOriginRef.current, sidebarManualIntentOf, sidebarSessionId, tabId: evidence.tabId,
      });
      const {
        declaredAutoProven, declaredOrigin, manualIntentOpen, openingScoped, openingUsableAuto, persistedManual,
        persistedStaleAuto, previous, previousUsableAuto, recordOrigin, sharedOriginScoped, sharedOriginStale,
      } = resolution;
    /**
     * on-screen 会话写入闸门（票 02 复审收尾）：本函数是共享来源 / 持久归属 / 记录三处写入的唯一
     * 收口，而收养（面板重挂载、切 root 后按 inventory 重建）与打开落地扫描同样会走到这里——它们的
     * 调用方并没有各自过闸门。闸门因此放在任何写入（含下面的清陈旧条目）之前：
     * - 观测（读 inventory / active）照旧进行，外部关闭 / 外部打开的**读面**观测不受影响；
     * - 身份不一致（mismatch / absent / unavailable）时这一轮不落地，切回本会话后的同步会按真实
     *   inventory 重新收养，绝不把记录或归属写进别人的会话。
     */
    if (sidebarOnScreenSessionStill("record") !== true) return false;
    /**
     * 证据存在但 tabId 对不上（或根本没有 tabId）时，那条共享账本条目已经被这一轮判定为**不是**
     * 本次归属的证据，必须就地清掉：它会一直躺在 realm 账本里，在下一次收养里继续参与判断
     * （长期误导），也会让「本次运行已经为它发过打开」这条去重记账与真实状态脱节。
     *
     * 清掉不会造成重复打开：这个地址此刻确实有 tab（收养的前提就是 inventory 里读到了它），
     * autoOpenCandidate 的「inventory 里已经有这个地址的 tab」判据会照常跳过。持久 manual 与
     * 内存 auto 的歧义同样按 manual 清理（既有语义）。
     *
     * **必须留在闸门之后**（oracle 复审收尾）：stale 的判据是「本条目的 tabId 与本次观测到的 tabId
     * 不符」，而本次观测（readSidebarTabEvidence）在非前台时描述的是**别的会话**的 tab——按它删条目
     * 会把本会话仍然有效的 owner 一起删掉（该 tab 之后再也收不回来）。所以非前台时**不删**，清理
     * 延后到下一个前台轮（切回补偿会推进一次完整同步，判据不变）。
     */
    if (sharedOriginStale === true
      || (persistedManual === true && sharedOriginScoped !== undefined)) {
      sidebarAutoOriginRef.current.delete(key);
    }
    /**
     * 归属成立（auto）时，把**当前亲眼观察到的 tabId** 写进共享来源账本：关闭候选的遍历与
     * 「绝不重复打开」的记账都长在这份账本上，两者本来就是同一份归属证据；缺了它，收养出来的
     * record 虽然是 auto，Auto 却永远不会再为它选出关闭候选（仍然漏收）。
     *
     * 这里也是**唯一**允许刷新 tabId 的位置之一（另一个是 handleSidebarAction 里 openResource
     * 成功落地的那次调用）：tabId 一律来自本次从宿主 inventory / active 读到的证据，绝不缓存、
     * 绝不猜测。刻意不做任何限容淘汰——归属容量由 autoOpenCandidate 在发出 openResource 之前
     * fail-closed 判定（见 autoSidebarOwnershipHasCapacity），收养路径绝不允许挤掉别的 scope
     * 仍然有效的 owner。
     */
    if (recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO) {
      sidebarAutoOriginRef.current.set(
        key,
        sidebarAutoOriginEntry(sidebarSessionId, rootSessionId, resourceAddress, tabId),
      );
    }
    /**
     * 归属标记与内存账本在**同一处**收口（写入 / 删除同源）：
     * - auto：DEG 自己成功打开（openIssued 成功落地）时写 auto-open；收养证据证明是 Auto 时写
     *   auto-adopt。同一地址此前若是 manual，必须由这次自动打开改回 auto（这是插件新开的一次自动行为）；
     * - manual：手动打开 / 手动接管 / 来源未知的外部 tab 一律写 manual（手动恒优先）。
     */
    writeSidebarAutoOwnership(
      sidebarSessionId,
      rootSessionId,
      resourceAddress,
      recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
      recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO
        ? (declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? "auto-open" : "auto-adopt")
        /**
         * 陈旧 auto 被降级成 manual 时用独立理由：诊断里据此能区分「用户手动接管」
         * （manual-takeover）与「某条 auto 证据的 tabId 与当前 tab 不符，按安全侧退让」两种完全
         * 不同的原因，事后排查「这个 tab 为什么没被自动收回」时才有的放矢。
         *
         * - manual-stale-auto：持久条目的 tabId 与当前 tab 不符（跨整页刷新的那条证据）；
         * - manual-stale-origin：realm 共享来源账本的 tabId 与当前 tab 不符或缺席（同一次页面
         *   会话内、宿主重 mint 了 tabId 而插件没有观察到那次替换）；
         * - manual-unproven-open：本次自动打开**没有**因果证明（发出前没能确认地址上没有 tab），
         *   或因果证明成立却在途期间观察到了别的写入者——落地到的这个 tab 无法与「用户自己打开的
         *   同一个资源」区分，按安全侧落 manual（缺陷 1）。
         */
        : (manualIntentOpen === true || declaredOrigin === SIDEBAR_TAB_ORIGIN_MANUAL
          ? "manual-open"
          : (persistedStaleAuto === true
            ? "manual-stale-auto"
            : (sharedOriginStale === true
              ? "manual-stale-origin"
              : (declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO && declaredAutoProven !== true
                ? "manual-unproven-open"
                : (openingScoped !== undefined && openingScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
                  && openingUsableAuto !== true && previousUsableAuto !== true
                  ? "manual-unproven-open"
                  : "manual-takeover"))))),
      // 条目与内存账本同源写入当前的 tabId：下一次刷新后的收养按它比对（见上面的绑定闸门）。
      tabId,
    );
    if (previous !== undefined && previous.sessionId === sidebarSessionId
      && previous.rootSessionId === rootSessionId && previous.tabId === tabId) {
      previous.title = tabTitle ?? previous.title;
      previous.misses = 0;
      previous.origin = recordOrigin; previous.absent = false; // 落地证据齐备：清掉权威缺席标记
      return true;
    }
    sidebarTabRecordsRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, tabId, title: tabTitle, misses: 0, origin: recordOrigin });
       bump((value) => value + 1);
       return true;
    };

    // 登记给更早 Hook 的晚绑定包装（声明已完成，此后的调用都拿到本帧的实例）。
    frame.late.recordSidebarTab = recordSidebarTab;
    Object.assign(frame, {
      recordSidebarTab,
    });
  }

  global[SYMBOL] = Object.freeze({
    useSidebarPanelTabRecorder, useSidebarPanelTabRecorderPart2,
  });
})(globalThis);
