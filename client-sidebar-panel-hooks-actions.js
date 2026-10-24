/**
 * 客户端侧栏 · Panel 自定义 Hook（动作编排）
 *
 * 这些 Hook 由 client-sidebar-panel.js 的 Panel 组件按**固定顺序**调用；每个 Hook 内部
 * 的 react.use* 调用顺序、effect 依赖数组、setup / cleanup 归属都与拆分前逐字相同。
 * 拆分只把原来同一个函数体里的连续语句段移进独立函数，因此运行期 Hook 派发序列不变。
 */
(function installSidebarPanelHooksActions(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-actions");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS, SIDEBAR_TAB_ORIGIN_AUTO, SIDEBAR_TAB_ORIGIN_MANUAL, modelFunction, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    SUBAGENT_CHAT_KIND, runtimeStatusOf,
  } = DOM;
  const POLL_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-poll");
  const POLL = global[POLL_SYMBOL] || {};
  const {
    PANEL_ERROR_SOURCES, RPC_FAILURE_TRANSPORT, callRpc, rpcFailureKindOf,
  } = POLL;
  const AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const AUTO_LEDGER = global[AUTO_LEDGER_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, readSidebarAutoOwnershipEntry, recordSidebarAutoDecision, sidebarAutoOriginEntry, sidebarAutoOriginTabIdOf,
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

    Object.assign(frame, {

    });
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
      sidebarAutoOriginRef, sidebarManualIntentOf, sidebarRight, sidebarSessionId, sidebarTabOpeningRef, sidebarTabRecordsRef,
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
     * 证据存在但 tabId 对不上（或根本没有 tabId）时，那条共享账本条目已经被这一轮判定为**不是**
     * 本次归属的证据，必须就地清掉：它会一直躺在 realm 账本里，在下一次收养里继续参与判断
     * （长期误导），也会让「本次运行已经为它发过打开」这条去重记账与真实状态脱节。
     *
     * 清掉不会造成重复打开：这个地址此刻确实有 tab（收养的前提就是 inventory 里读到了它），
     * autoOpenCandidate 的「inventory 里已经有这个地址的 tab」判据会照常跳过。持久 manual 与
     * 内存 auto 的歧义同样按 manual 清理（既有语义）。
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
      previous.origin = recordOrigin;
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


  /** 一次右栏动作的完整编排（打开 / 关闭 / split / 回退）。 */
  function useSidebarPanelActionHandlers(frame) {
    const {

    } = frame;

    /**
     * 侧栏箭头点击的唯一入口：打开与关闭共用一条路径，同一 key 上串行（pending 防重入）。
     *
     * 串行窗口覆盖从「读记录」到「记录落定」的整段同步逻辑：打开时 openResource 可能同步触发
     * 宿主的提交，重入点击若穿过检查就会发出第二次 openResource（第二个重复 tab）或提前走关闭。
     * 抛错处理：openResource / close 抛错只影响这一次动作，绝不写状态——打开失败保持 >>，
     * 关闭失败保持 <<（用户可以再点一次），两种情况都不会把按钮和真实世界对不上。
     *
     * origin 是**内部**参数，默认 manual：普通 UI 调用（箭头、键盘）一律手动来源；只有自动同步
     * 显式传 auto。它决定三件事：记录来源、手动动作是否清除抑制/自动来源、关闭时是否登记抑制。
     *
     * autoAction 也是**内部**参数，只在自动路径上出现：{ kind, epoch, attemptsBefore, attemptToken }。
     * 它让同一条实现能在每个 await 之后、真正调用宿主 open/close 之前复核「Auto 是否仍然开启、动作
     * 是否已过期、用户是否已经手动接管」，并在收尾时无条件释放在途预留（见 finally）。关闭类候选还
     * 带着预支预算时新建的 attemptToken：回滚/收口共享重试计数只认这份不可复用的所有权凭据。
     */

    Object.assign(frame, {

    });
  }

  /**
   * 动作入口的上下文归一：手动来源在**任何 await 之前**改写归属标记；自动动作把 autoAction 归一成
   * 一份不可复用的上下文；已换掉的 surface 闭包在这里释放在途预留并返回 null（放弃本次动作）。
   * openIssued / effectiveOrigin / canTrackOpen / openProof 会被后续阶段原地改写，与拆分前的
   * 局部变量同义，因此三个阶段读到的永远是同一份值。
   */
  function createSidebarActionContext(deps, key, resourceAddress, actionOrigin, autoAction) {
    const {
      releaseAutoCloseAttempt, rootSessionId, sidebarAutoEpochRef, sidebarAutoReservationRef,
      sidebarSessionId, sidebarSurfaceStillCurrent, sidebarTabRecordsRef,
    } = deps;

    const origin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;
    /**
     * 手动来源的动作在入口就把归属标记改写成 manual（手动恒优先，且必须在任何 await 之前落盘）：
     * 有记录 ⇒ 用户在关闭这个 tab（manual-close）；没有记录 ⇒ 用户在打开它（manual-open）。
     * 这条写入同时抹掉内存里的共享来源，绝不留「内存 auto / 持久 manual」的歧义。
     */
    if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
      const manualRecord = sidebarTabRecordsRef.current.get(key);
      writeSidebarAutoOwnership(
        sidebarSessionId,
        rootSessionId,
        resourceAddress,
        SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
        manualRecord === undefined ? "manual-open" : "manual-close",
      );
    }
    const autoContext = origin === SIDEBAR_TAB_ORIGIN_AUTO && autoAction !== null && typeof autoAction === "object"
      ? {
        kind: autoAction.kind === "close" ? "close" : "open",
        epoch: Number.isFinite(Number(autoAction.epoch)) ? Number(autoAction.epoch) : sidebarAutoEpochRef.current,
        attemptsBefore: Number.isFinite(Number(autoAction.attemptsBefore)) ? Number(autoAction.attemptsBefore) : 0,
        // 只有候选选择真的登记过一份令牌时才带上它：缺失/畸形一律按 null 处理，后续回滚因此
        // fail-safe 地放弃（绝不按 key 盲写共享计数）。
        attemptToken: autoAction.attemptToken !== null && autoAction.attemptToken !== undefined
          && typeof autoAction.attemptToken === "object"
          ? autoAction.attemptToken
          : null,
      }
      : null;
    if (sidebarSurfaceStillCurrent() !== true) {
      /**
       * 连入口都没通过的自动动作：这里必须自己释放候选选择时写下的预留（以及自动关闭的重试记账）。
       * 这些键属于已经被换掉的 surface，当前闭包之后再也不会为它们做清理。
       */
      if (autoContext !== null) {
        sidebarAutoReservationRef.current.delete(key);
        releaseAutoCloseAttempt(key, autoContext);
      }
      return null;
    }
    return {
      autoContext, canTrackOpen: false, effectiveOrigin: origin, key, openIssued: false, openProof: null, origin,
      resourceAddress,
    };
  }

  /**
   * 关闭态的唯一执行入口：只调用记录里的精确 tabId（绝不按 active() 猜要关哪个 tab）。await 之前
   * 记下出发时的 split 意图令牌；await 之后先过 surface 闸门，再按 outcome 决定「让位 / 回滚 /
   * 保留现场 / 收口」。只有 verified-closed / closed / verified-recycled 允许收口归属。
   */
  async function closeSidebarActionWithLease(action, deps, record) {
    const {
      closeSidebarTabWithLease, releaseAutoCloseAttempt, sidebarAutoFailedKeysRef, sidebarAutoReservationRef,
      sidebarSplitIntentRef, sidebarSurfaceStillCurrent,
    } = deps;
    const { autoContext, key, origin, resourceAddress } = action;
      const splitIntentAtClose = sidebarSplitIntentRef.current;
      const closeSplitIntentToken = splitIntentAtClose !== null && splitIntentAtClose.key === key
        ? splitIntentAtClose.token
        : null;
      const closeOutcome = await closeSidebarTabWithLease(record.tabId, {
        waitForCompeting: origin === SIDEBAR_TAB_ORIGIN_MANUAL,
        /**
         * 验证上下文：close 请求 resolve 之后必须由 inventory 的精确 tabId 证据收口。
         * 手动关闭同样要验证（attemptToken = null ⇒ 验证成功后按手动语义登记抑制）。
         * splitIntentToken 随验证记录一起保留：验证链的收口可能在若干轮同步之后才发生。
         */
        verify: {
          key,
          address: resourceAddress,
          attemptToken: autoContext === null ? null : autoContext.attemptToken,
          manual: origin === SIDEBAR_TAB_ORIGIN_MANUAL,
          splitIntentToken: closeSplitIntentToken,
        },
      });

      /**
       * await 之后的 surface 身份闸门（单项关闭的收尾边界，与批量入口同一条判据）。
       *
       * 这次 await 可能跨越一次组件重挂载或 root / sidebar session 切换：本闭包里的 ref、
       * records 与快照都已经不属于当前 surface，而**共享**的 Auto 来源 / 抑制 / 重试记账却是
       * 同一份。此时若还按旧闭包继续收尾（删记录、删共享来源、登记抑制、bump）并调用旧闭包的
       * syncSidebarTabs()，旧快照会把新 Panel 刚刚写入的**其它** Auto 来源当成「已经离开当前
       * 快照」而清掉——新 Panel 随后再也认不出自己打开过的 tab，资源结束后也不会自动关闭它。
       *
       * 因此任何返回结果（closed / failed / settled-closed / contended / unreadable / stale）
       * 都必须在写共享账本、删记录、登记抑制或调用旧闭包同步**之前**复核 surface 身份；任一失配
       * 立即停止本实例的后续收尾。判据含不可复用的 surface 令牌：同一个实例 A→B→A 之后
       * root/sidebar session 字符串会重新相等，只有令牌能证明这次收尾已经不属于当前 surface
       * （否则旧动作会删掉 A 里已经换成新 tabId 的 record / Auto 来源）。租约已经由
       * closeSidebarTabWithLease 自己的 finally 结算并归还（这里绝不重复释放），旧 tab 的归属交给
       * 新 Panel 后续同步按真实 inventory 结算：成功关掉的由那次同步收口，失败 / 还没落地的则仍
       * 留在 inventory 里等下一轮有界重试。
       */
      if (sidebarSurfaceStillCurrent() !== true) {
        return;
      }
      if (closeOutcome.status === "contended" || closeOutcome.status === "contended-timeout") {
        /**
         * 让位路径（自动动作）：这次关闭根本没有发出，因此必须归还候选选择时预支的那一次重试
         * 预算与在途预留，否则一次「有人在关」的等待就会白烧掉一次有界重试，甚至让 Auto 提前
         * 放弃这个 tab。**绝不在这里清理来源**：来源只在关闭真的成功后才允许撤销（失败 / 让位
         * 都必须继续归 Auto 管，留给后续同步重试）。
         */
        if (autoContext !== null) {
          sidebarAutoReservationRef.current.delete(key);
          releaseAutoCloseAttempt(key, autoContext);
          /**
           * 同时记进本次级联的失败屏障：这次关闭没有发出，但它绝不能在**同一批微任务级联**里被
           * 重新选中（候选与执行之间只隔一次微任务，动作收尾的尾随同步会立刻再选一次；若冲突
           * 持续存在，那会变成不让出宏任务的微任务死循环）。屏障在下一次外部同步轮自动失效，
           * 那时锁通常已经归还，重试照常。
           */
          sidebarAutoFailedKeysRef.current.add(key);
        }
        return;
      }
      /**
       * 只有拿到「已经关掉」的结算才收口：亲手关闭成功，或等待竞争租约后拿到成功 / inventory
       * 已证明 tab 消失的结算。失败、inventory 不可读（fail-closed）与「有人接手」都不允许在
       * 这里改写记录或来源——记录只由真实结算（这里或既有同步器）收口，绝不因为「这次不是自己
       * 亲手关的」就跳过收口，否则会留下一份与宿主 inventory 不符的账。
       */
      if (closeOutcome.status === "unreadable") {
        // preflight 没通过：close 根本没有发出 → 按令牌回滚这次预支，绝不清理归属。
        if (autoContext !== null) {
          sidebarAutoReservationRef.current.delete(key);
          releaseAutoCloseAttempt(key, autoContext);
          sidebarAutoFailedKeysRef.current.add(key);
        }
        return;
      }
      if (closeOutcome.status === "stale") {
        // 等待期间 surface 换代：close 没有发出 → 同样按令牌回滚，旧 tab 交给新 generation 收口。
        if (autoContext !== null) {
          sidebarAutoReservationRef.current.delete(key);
          releaseAutoCloseAttempt(key, autoContext);
        }
        return;
      }
      if (closeOutcome.status === "failed" || closeOutcome.status === "timeout") {
        /**
         * 请求真的发出去过（reject 或 watchdog 超时）：**绝不回滚 count**——回滚就等于把三次快速
         * 上限又还给它，实际 close 次数会突破上限。record / origin / 冷却一律保留，留给后续同步重试。
         */
        sidebarAutoFailedKeysRef.current.add(key);
        return;
      }
      if (closeOutcome.status === "request-resolved-unverified") {
        /**
         * resolve 只代表请求完成：验证链已经登记在共享账本里，record / origin / attempt 全部保留。
         * 这里直接返回，绝不落到下面的 openResource 分支，也绝不当成「已经关掉」收口。
         */
        return;
      }
    settleVerifiedSidebarClose(action, deps, record, closeOutcome, closeSplitIntentToken);
  }

  /**
   * 关闭结算的收口分支（verified-closed / closed / verified-recycled）：(key, tabId) 一致性闸门、
   * split 事务收口、重试预算结算、来源与抑制记账，最后 bump + 同步一次。
   */
  function settleVerifiedSidebarClose(action, deps, record, closeOutcome, closeSplitIntentToken) {
    const {
      bump, cancelPendingSidebarSplitOfClose, rootSessionId, settleAutoCloseAttempt, sidebarAutoCloseCooldownsRef,
      sidebarAutoOriginRef, sidebarAutoSuppressedRef, sidebarSessionId, sidebarTabRecordsRef, syncSidebarTabs,
      trimAutoKeyMap,
    } = deps;
    const { autoContext, key, origin, resourceAddress } = action;
      /**
       * verified-closed：精确 inventory 证据证明这个 tab 已经不在；
       * verified-recycled：这个 tabId 已经被宿主回收给另一个资源（地址不一致）——旧 tab 已经
       *   消失、close 一次也没有发出，但「这个 key 已经没有自己的 tab」这个结论与 verified-closed
       *   完全等价，因此收口规则一致（下面的 (key, tabId) 一致性闸门照旧生效）；
       * closed：旧宿主没有 inventory 读面时的手动关闭（历史语义，用户意图优先）。
       * 只有这三种结算允许收口归属。
       */
      if (closeOutcome.status === "verified-closed" || closeOutcome.status === "closed"
        || closeOutcome.status === "verified-recycled") {

        /**
         * 关闭成功后一起收口这个 key 上尚未结算的分栏事务。
         *
         * 现实窗口：目标 tab 已经进入公开 inventory（所以这里能拿到可关闭的 tabId），但宿主的
         * pane 组成证据还没提交（dockkit 尚未把它渲染进 split 返回的 pane）。此时只删记录会让
         * 右栏停在事务的临时 50%，直到 15 秒 deadline 才回落——用户看到的就是「收回后右栏卡在
         * 50% 十几秒」，同一行的下一次点击也只会撞上残留事务。取消事务既清掉在途事务，也让
         * 既有同步器按最新组成重估宽度（Expert Group-only ⇒ 立即回到 20%）。
         *
         * 只有同 key 的意图会被取消：别的行的在途打开照旧继续。
         */
        /**
         * (key, tabId) 一致性闸门：只有这个 key 当前记录的 tabId 仍是本次动作关闭的那一个，才允许
         * 收口 record / origin。宿主换过 tabId（旧 tab 消失、同一个资源换成新 tab）时，旧代次的
         * 结算只能清理它自己那一笔预算，绝不能删掉新 generation 的 record 与 Auto 归属。
         */
        const currentRecord = sidebarTabRecordsRef.current.get(key);
        const recordStillSame = currentRecord !== undefined && currentRecord.tabId === record.tabId;
        /**
         * 分栏事务只收口**这次关闭出发时看到的那一份意图**：这次关闭确实发生了，事务必须收口
         * （否则右栏停在临时 50%）；但同一个 key 上如果已经出现新 generation 的 split/open
         * 事务（用户或 Auto 重新打开了这个资源），旧 close 的结算绝不取消它——那会把新一次打开
         * 的 pane 归属与临时扩栏一起打断。令牌逐对象比较，A→B→A 或同 key 重开都无法冒充。
         */
        cancelPendingSidebarSplitOfClose(key, closeSplitIntentToken);
        if (recordStillSame === true) {
          sidebarTabRecordsRef.current.delete(key);
        }
        // 重试预算按所有权收口：手动关闭恒优先，直接清空；自动关闭只有 owner 仍是本次动作的
        // 令牌时才清空（旧代次的迟到成功结算绝不把后来者重新预支的预算一起清零）。
        settleAutoCloseAttempt(key, autoContext);

        /**
         * 关闭成功后收口来源与抑制记账（两种开放的语义差别就在这两行）：
         *
         * - 自动关闭：只撤销来源标记——本次运行不会再对同一个资源重复动作；
         * - 手动关闭：除撤销来源外还要登记**抑制**，Auto 不得立刻把它重新打开。抑制只由
         *   用户手动重新打开同一资源清除（手动意图优先）。
         *
         * 「等待竞争租约后拿到成功结算」同样走这里：tab 确实已经被关掉，收口规则与亲手关闭一致；
         * 反过来说，让位 / 失败 / inventory 不可读的路径一律在上面 return，绝不提前清理来源。
         */
        // 来源与抑制同样只在这个 key 仍然指向本次关闭的那个 tabId 时收口：否则删掉的会是
        // 新 generation 刚刚为**新 tabId** 写下的 Auto 归属。
        if (recordStillSame === true && closeOutcome.status === "verified-recycled") {
          /**
           * 地址复用证明旧 tab 已经消失：这个 key 的失败冷却也随之失效，必须一起清掉。否则一条
           * 永远等不到自己 tab 的冷却（最长 15 分钟）会白白屏蔽这个 key 后续的真实关闭。
           * 仍然只在 record 仍指向本次证明消失的那个 tabId 时清理：后来者已经接管这个 key 时，
           * 它的冷却记账不属于这次结算（与 finishVerifiedSidebarClose 的 sameTab 闸门同源）。
           */
          sidebarAutoCloseCooldownsRef.current.delete(key);
        }
        if (recordStillSame === true) {
          sidebarAutoOriginRef.current.delete(key);
          if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
            sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
            trimAutoKeyMap(sidebarAutoSuppressedRef.current);
            writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
          }
        }

        bump((value) => value + 1);
        // 关闭改变了右栏组成，必须立刻重估一次：宽度与手柄锁都在同一条同步链路上。
        syncSidebarTabs();
      }
  }

  /**
   * 自动动作的副作用复核点（split / openResource 之前重跑）：proceed = 照常执行；abort = Auto 已
   * 关闭或用户要求关闭，撤销在途记账且绝不发出副作用；manual = 用户手动要求打开，动作继续但最终
   * tab 记 manual 来源。手动路径（autoContext === null）永远是 proceed，历史行为逐字不变。
   */
  function reviewAutoSideEffect(action, deps) {
    const { autoActionStillValid, autoTakeoverStateOf } = deps;
    const { autoContext, key } = action;
      if (autoContext === null) return "proceed";
      if (autoActionStillValid(autoContext) !== true) return "abort";
      /**
       * 这里刻意**不**再加一道「持久 manual ⇒ abort」的闸门（持久抑制的判据只落在候选选择处，
       * 见 autoOpenCandidate）。原因：这条路是「候选已经选中、正在等宿主布局」的在途窗口，窗口里
       * 出现的 manual 条目可能来自用户**手动打开同一个资源**（handleSidebarAction 的入口写入），
       * 那种形状的既有契约是「这一次打开照常发出，但最终 tab 记成 manual」（见 autoTakeoverStateOf
       * 的 "open" 分支与「等待布局期间手动打开」用例）；在这里 abort 会连同用户的手动意图一起
       * 丢掉（那次点击不会补发 openResource）。
       *
       * 窗口里的「手动关闭」不依赖持久条目：它由 applyPendingManualIntent 立刻写抑制，并且
       * autoTakeoverStateOf 返回 "close" ⇒ 下面直接 abort，行为逐字不变。
       */
      const takeover = autoTakeoverStateOf(key);
      if (takeover === "close") return "abort";
      if (takeover === "open") return "manual";
      return "proceed";
  }

  /**
   * 打开态：从「当前没有记录」一路走到「记录落地 + 同步一次」。
   *
   * 顺序刻意与拆分前逐字一致：先登记在途打开记录（含因果证明字段），再清手动抑制/来源，
   * 然后准备目标 pane（可能跨一次布局 await），复核 → 因果证明 → 发 openResource → 记来源 →
   * 写记录 → 同步。任一阶段的 abort 都只放弃本次动作，绝不写状态。
   */
  function runSidebarOpenAction(action, deps) {
    const {
      clearAutoCloseAttempt, closeSidebarResource, existingSubagentPaneId, primitives, readActiveSidebarResource,
      rootSessionId, sidebarAutoOriginRef, sidebarAutoSuppressedRef, sidebarOpenTabsAvailable, sidebarSessionId,
      sidebarTabOpeningRef, splitSidebarPane,
    } = deps;
    const { key, origin, resourceAddress } = action;
    /** 本次打开最终要记的来源：自动动作只在没有手动接管时才是 auto（后续阶段原地改写）。 */
    action.effectiveOrigin = origin;
    /** 宿主是否具备「能读到 tabId + 能精确关闭」的能力：不具备时这次打开永不记成 auto。 */
    action.canTrackOpen = closeSidebarResource !== null
      && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
      && typeof primitives?.IconChevronLeftOutlineRegular === "function";
    const canObserveOpenCommit = action.canTrackOpen
      && globalThis.document !== null && globalThis.document !== undefined;
    if (canObserveOpenCommit) {
      sidebarTabOpeningRef.current.set(key, {
        sessionId: sidebarSessionId,
        rootSessionId,
        resourceAddress,
        expiresAt: Date.now() + SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,
        origin,
        /**
         * 因果证明状态（缺陷 1）：这一次打开到底凭什么说「随后落地的那个 tab 是我们创建的」。
         *
         * - causalProof："pending"（还没判）→ "proven"（发出 openResource 之前亲眼确认
         *   inventory 可读且该地址没有已提交 tab）/ "failed"（有 tab 或读不到，一律不认领）；
         * - causalIssuedAt：openResource 真正发给宿主的时刻（null = 还没发出）。在此之前读到
         *   同地址 tab 只可能是**别的写入者**；
         * - foreignWriter：期间观察到别的写入者的证据（见 recordSidebarTab 的置位点）。
         *
         * 三个字段缺一不可：任何一层不成立都不允许把落地证据认成 auto（宁可漏收一次）。
         */
        causalProof: "pending",
        causalIssuedAt: null,
        foreignWriter: false,
      });
    }
    /**
     * 手动打开的意图优先于自动记账：
     *
     * - 清除抑制：用户手动重新打开 = 他重新要这个会话，Auto 之后可以继续管理它；
     * - 撤销自动来源：这次打开是手动来源，Auto 绝不能在资源结束时把它当成自己的 tab 关掉。
     * 两条都在发动作之前写，因此这一段没有 await，不存在与自动同步交叉的窗口。
     */
    if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
      sidebarAutoSuppressedRef.current.delete(key);
      sidebarAutoOriginRef.current.delete(key);
      // 用户手动重新打开同一资源：手动接管，这个 key 上未结算的自动关闭预算（含 owner）一并作废。
      clearAutoCloseAttempt(key);
    }
    /**
     * 准备目标 pane：只有走公开 split() 的那条会跨 await（等宿主布局提交）；其余两条必须**同步完成**
     * ——真实点击的宿主副作用原本就在同一 tick 内发出，await 会改变可观察时序。
     */
    const targetPaneId = existingSubagentPaneId();
    let plan;
    if (targetPaneId !== null) {
      // 已经有独立子代理 pane：后续资源固定复用它，不再消耗新的 pane 配额。
      plan = { openOptions: { kind: SUBAGENT_CHAT_KIND, paneId: targetPaneId, preferNewPane: false }, splitToken: null };
    } else if (splitSidebarPane === null) {
      // 旧宿主没有公开 split()：保留历史 preferNewPane 请求，兼容旧版本。
      plan = { openOptions: { kind: SUBAGENT_CHAT_KIND, preferNewPane: true }, splitToken: null };
    } else {
      const splitState = beginSidebarSplitPreparation(action, deps);
      if (splitState === null) return;
      if (splitState.waitForLayout === true) {
        // 唯一会跨 await 的分支：把后两步串到同一个 promise 上返回，由调用方 await。
        return completeSidebarSplitPreparation(action, deps, splitState).then((splitPlan) => {
          if (splitPlan === null) return;
          if (issueSidebarResourceOpen(action, deps, splitPlan) !== true) return;
          finishSidebarResourceOpen(action, deps, splitPlan);
        });
      }
      plan = finishSidebarSplitPreparation(action, deps, splitState);
    }
    if (plan === null) return;
    if (issueSidebarResourceOpen(action, deps, plan) !== true) return;
    finishSidebarResourceOpen(action, deps, plan);
  }

  /**
   * 分栏准备的第一段（纯同步）：读取分栏前 inventory、起分栏准备事务、校验 token、登记 split 意图。
   *
   * 返回 null 表示本次动作已放弃（在途标记已在函数内清理）；否则返回
   * { splitToken, tabsBeforeSplit, waitForLayout }：waitForLayout 为 true 时调用方必须先 await 宿主
   * 布局提交（completeSidebarSplitPreparation）；旧宿主没有 beginSidebarSplit 时它是 false，
   * 整条路径（split + openResource）因此仍在同一 tick 内完成，时序与拆分前逐字相同。
   */
  function beginSidebarSplitPreparation(action, deps) {
    const {
      beginSidebarSplit, config, readSidebarOpenTabs, rootSessionId, sidebarSessionId, sidebarSplitIntentRef,
      sidebarTabOpeningRef,
    } = deps;
    const { key, resourceAddress } = action;
    // 分栏前的 inventory 快照：用于识别 split() 顺带播种的「开始」guide tab。
    const tabsBeforeSplit = readSidebarOpenTabs();
    let splitToken = null;
    if (beginSidebarSplit === null) return { splitToken, tabsBeforeSplit, waitForLayout: false };
    let preparation = null;
    try {
      preparation = beginSidebarSplit.call(config, {
        sessionId: sidebarSessionId,
        rootSessionId,
        key,
        resourceAddress,
      });
    } catch {
      preparation = null;
    }
    if (preparation?.busy === true) {
      sidebarTabOpeningRef.current.delete(key);
      return;
    }
    // install coordinator 已接管新版 split 时，null/缺 token 表示宽度或 surface
    // 准备失败；必须在调用 split() 之前中止，不能把 20% 状态下的 split 静默发给宿主。
    if (preparation === null || typeof preparation !== "object"
      || preparation.token === null || preparation.token === undefined) {
      sidebarTabOpeningRef.current.delete(key);
      return;
    }
    splitToken = preparation.token;
    if (splitToken !== null) {
      sidebarSplitIntentRef.current = {
        token: splitToken,
        key,
        resourceAddress,
        paneId: null,
        resourceIssued: false,
      };
    }
    return { splitToken, tabsBeforeSplit, waitForLayout: true };
  }

  /**
   * 分栏准备的第二段（唯一跨 await 的一段）：等宿主把新宽度提交到 DockLayout，再复核 Auto 与
   * 手动接管，最后进入同步收尾。返回 null 表示放弃。
   */
  async function completeSidebarSplitPreparation(action, deps, state) {
    const {
      abandonAutoSidebarAction, autoTakeoverStateOf, cancelPendingSidebarSplit, rootSessionId,
      sidebarAutoSuppressedRef, sidebarSessionId, sidebarSplitIntentRef, sidebarSurfaceStillCurrent,
      sidebarTabOpeningRef, trimAutoKeyMap, waitForSidebarSplitLayoutCommit,
    } = deps;
    const { autoContext, key, resourceAddress } = action;
    const { splitToken } = state;
    // 宽度 action 返回只代表 store 已写入；必须等宿主把新宽度提交到 DockLayout，
    // 否则 split() 仍会读到旧 room.row=false，并弹出「栏宽不足」。
    await waitForSidebarSplitLayoutCommit();
    const splitStillCurrent = sidebarSurfaceStillCurrent() === true
      && sidebarSplitIntentRef.current?.token === splitToken;
    if (!splitStillCurrent) {
      // session 切换、卸载或 deadline 已经收口时，不得让旧点击继续操作新 surface。
      if (sidebarSplitIntentRef.current?.token === splitToken) cancelPendingSidebarSplit("split-stale");
      sidebarTabOpeningRef.current.delete(key);
      return null;
    }
    /**
     * 布局等待是这条路径上唯一会跨越用户操作窗口的 await：用户可能在这里关闭了 Auto，
     * 也可能在同一个 key 上手动接管。此时连 split() 都还没调用，直接放弃是代价最小的时机。
     */
    const afterLayoutReview = reviewAutoSideEffect(action, deps);
    if (afterLayoutReview === "abort") {
      abandonAutoSidebarAction(key, autoContext);
      if (autoTakeoverStateOf(key) === "close") {
        // 用户要的是关闭：立刻登记抑制，Auto 不得在下一轮同步里把它重新选成候选。
        sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
        trimAutoKeyMap(sidebarAutoSuppressedRef.current);
        writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
      }
      return null;
    }
    if (afterLayoutReview === "manual") action.effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
    return finishSidebarSplitPreparation(action, deps, state);
  }

  /**
   * 分栏准备的同步收尾：真的调用 split()、登记 pane，并组装 openResource 选项。
   * 返回 null 表示宿主拒绝了分栏（本次动作放弃）。
   */
  function finishSidebarSplitPreparation(action, deps, state) {
    const {
      cancelPendingSidebarSplit, config, markSidebarSplitPane, seededGuideTabId, sidebarRight, sidebarSessionId,
      sidebarSplitIntentRef, sidebarTabOpeningRef, splitSidebarPane,
    } = deps;
    const { key } = action;
    const { splitToken, tabsBeforeSplit } = state;
    let paneId = null;
    try { paneId = splitSidebarPane.call(sidebarRight); } catch { paneId = null; }
    if (typeof paneId !== "string" || paneId.trim() === "") {
      if (splitToken !== null) cancelPendingSidebarSplit("split-failed");
      sidebarTabOpeningRef.current.delete(key);
      return null;
    }
    if (splitToken !== null) {
      let accepted = true;
      if (markSidebarSplitPane !== null) {
        try { accepted = markSidebarSplitPane.call(config, splitToken, paneId) !== false; } catch { accepted = false; }
      }
      if (!accepted) {
        cancelPendingSidebarSplit("pane-rejected");
        sidebarTabOpeningRef.current.delete(key);
        return null;
      }
      if (sidebarSplitIntentRef.current?.token === splitToken) {
        sidebarSplitIntentRef.current.paneId = paneId;
      }
    }
    const guideTabId = seededGuideTabId(tabsBeforeSplit, sidebarSessionId);
    // split() 的默认 guide 也必须在同一次导航意图中被替换，否则新 pane 会出现
    // 一个多余的「开始」tab；replaceTab 仍是公开 openResource 选项。
    const openOptions = { kind: SUBAGENT_CHAT_KIND, paneId, preferNewPane: false };
    if (guideTabId !== null) openOptions.replaceTab = guideTabId;
    return { openOptions, splitToken };
  }

  /**
   * 副作用之前的最后一道复核 + 因果证明 + 真正调用 openResource。
   *
   * 返回 true 表示 openResource 已经成功发出（action.openIssued / action.openProof 同步置位）；
   * 返回 false 表示在复核/证明阶段放弃，调用方直接返回。同步抛错时回滚「已发出」标记并原样抛出。
   */
  function issueSidebarResourceOpen(action, deps, plan) {
    const {
      abandonAutoSidebarAction, autoTakeoverStateOf, openSidebarResource, rootSessionId,
      sidebarAutoOriginRef, sidebarAutoSuppressedRef, sidebarResourceTabStateOf, sidebarSessionId,
      sidebarTabOpeningRef, sidebarRight, trimAutoKeyMap,
    } = deps;
    const { autoContext, key, resourceAddress } = action;
    const { openOptions } = plan;
    /**
     * 真正发出副作用之前的最后一道复核：从「读记录」到这里可能已经跨过 split 前的布局等待，
     * Auto 开关与用户手动意图都可能变化。只有通过复核才允许调用宿主 openResource()——绝不把
     * 一个已经关掉的 Auto 变成一次迟到的自动打开。
     */
    const beforeOpenReview = reviewAutoSideEffect(action, deps);
    if (beforeOpenReview === "abort") {
      abandonAutoSidebarAction(key, autoContext);
      if (autoTakeoverStateOf(key) === "close") {
        // 用户要的是关闭：立刻登记抑制，绝不在同一轮或下一轮同步里把这个资源重新打开。
        sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
        trimAutoKeyMap(sidebarAutoSuppressedRef.current);
        writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
      }
      return false;
    }
    if (beforeOpenReview === "manual") action.effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
    /**
     * 副作用之前的**因果证明**（缺陷 1，与复核点在同一个同步段里，中间没有任何 await）。
     *
     * 宿主 openResource() 的公开契约里没有返回值（void），默认 revealIfOpened=true —— 同一个
     * (kind, contentId) 已经有 tab 时它只是**揭示**那一个。因此「我们调用过 openResource」+
     * 「随后 inventory 里出现同地址 tab」并不构成因果：那个 tab 完全可能是用户刚刚从 DSH 其它
     * 入口打开的同一个资源。这里在发动作之前亲眼核对一次：
     * - inventory 可读、且该地址没有已提交 tab ⇒ 之后出现的那个 tab 只可能是本次调用打出来的
     *   （同一帧内没有别的写入者能插进来），记为 proven；
     * - 已经有 tab（用户在等待窗口里打开了它）、或 inventory 读不出来（证明不了）⇒ 一律降级
     *   manual：这次调用最多只是揭示别人的 tab，绝不认领、绝不在资源结束后把它关掉。
     *
     * 取舍（刻意）：宁可漏收一次（那个 tab 留在右栏交给用户手动处理），也绝不误关用户刚打开的
     * tab。手动路径（autoContext === null）不需要证明：它本来就记 manual。
     */
    let openProof = null;
    if (autoContext !== null) {
      const openWitness = sidebarResourceTabStateOf(resourceAddress);
      const autoProven = openWitness.readable === true && openWitness.tabId === null;
      openProof = { autoProven };
      if (autoProven !== true) {
        /**
         * 刻意**不**在这里改 effectiveOrigin：留成 auto 才能让「声明过 auto 但缺因果证明」这个
         * 事实一路带到来源判据（recordSidebarTab 的 declaredUsable ⇒ manual，理由
         * manual-unproven-open，诊断里一眼能看出是**没证明出来**而不是用户手动接管）。
         * 占位写入与最终归属都由 openProof 把关。
         */
        recordSidebarAutoDecision("open", { key, kind: "open" }, "downgrade", "causal-unproven");
      }
      const pendingOpening = sidebarTabOpeningRef.current.get(key);
      if (pendingOpening !== undefined
        && pendingOpening.sessionId === sidebarSessionId && pendingOpening.rootSessionId === rootSessionId) {
        pendingOpening.causalProof = autoProven === true ? "proven" : "failed";
      }
    }
    /**
     * 「已发出」标记必须写在**调用之前**、与调用处在同一个同步段里（时序加固）。宿主链路
     * （openResource → store.actions.openContent → zustand setState 的同步 forEach → inventory.publish
     * → openTabs.set → 插件的 inventory 订阅回调）没有任何 await / 微任务，宿主会在 openResource()
     * 返回之前同步重入一次（syncSidebarTabs → recordSidebarTab）。标记若晚于这次重入写入，重入结算
     * 读到的 causalIssuedAt 还是 null，就会把 landing 记成 manual 并落盘持久 manual 归属，资源结束
     * 再也收不回来（不会误关，但正常自动收回失效）。
     */
    const issuedOpening = autoContext === null ? undefined : sidebarTabOpeningRef.current.get(key);
    const issuedOpeningScoped = issuedOpening !== undefined
      && issuedOpening.sessionId === sidebarSessionId && issuedOpening.rootSessionId === rootSessionId
      ? issuedOpening
      : undefined;
    // 回滚用的原值：畸形值按 null（「还没发出」）处理，绝不把脏值留在记录里。
    const issuedAtBefore = issuedOpeningScoped === undefined
      || issuedOpeningScoped.causalIssuedAt === null || issuedOpeningScoped.causalIssuedAt === undefined
      ? null
      : issuedOpeningScoped.causalIssuedAt;
    if (issuedOpeningScoped !== undefined) issuedOpeningScoped.causalIssuedAt = Date.now();
    try {
      openSidebarResource.call(sidebarRight, resourceAddress, openOptions);
    } catch (error) {
      /**
       * 同步抛错：宿主没有完成这次打开，这次调用必须回到「从未发出」的状态——否则任何一条把它们
       * 联系起来的后续判据（重入结算 / 重试 / 收养）都可能把失败的动作当成已发出的证据。
       * 回滚后原样抛出，交给外层 catch 收口（撤销来源占位、清掉在途记录）。
       */
      if (issuedOpeningScoped !== undefined) issuedOpeningScoped.causalIssuedAt = issuedAtBefore;
      throw error;
    }
    action.openIssued = true;
    action.openProof = openProof;
    /**
     * 预留 → 来源的升级点：只有 openResource 真的成功发出、且宿主具备可追踪能力（能读到 tabId、
     * 能精确关闭）时，才把这次打开记成「Auto 亲手打开」。openResource 抛错时直接走 catch，
     * 来源标记绝不写；能力不足时也不写——将来无法精确回收的 tab 不归 Auto 管。
     */
    if (action.effectiveOrigin === SIDEBAR_TAB_ORIGIN_AUTO && action.canTrackOpen === true
      && openProof !== null && openProof.autoProven === true) {
      /**
       * 此刻落地证据还没到（tabId 未知）：这里只写下「本次运行已经为它发出过一次 Auto 打开」
       * 这条去重记账，tabId 一律留空——它不是归属证据（见 sidebarAutoOriginEntry）。真正的
       * tabId 只由 recordSidebarTab 在宿主 inventory 里**亲手读到那个 tab** 时写入 / 刷新。
       *
       * 覆盖闸门（时序加固）：这次打开可能在**调用内部**就已经被重入结算，结算会把真实 tabId
       * 写进这条账本条目。那条条目比占位强，绝不能用 tabId=null 的占位把它覆盖回「落地证据
       * 还没到」：只放行「没有 tabId」的写入（含条目缺失 / 畸形值），其余一律保留现场。
       */
      const landedOriginEntry = sidebarAutoOriginRef.current.get(key);
      if (sidebarAutoOriginTabIdOf(landedOriginEntry) === null) {
        sidebarAutoOriginRef.current.set(
          key,
          sidebarAutoOriginEntry(sidebarSessionId, rootSessionId, resourceAddress, null),
        );
      }
    }
    return true;
  }

  /** 落定收尾：split 事务确认、写记录、清在途标记，并在 surface 未变时推进一次同步。 */
  function finishSidebarResourceOpen(action, deps, plan) {
    const {
      cancelPendingSidebarSplit, config, markSidebarSplitOpen, recordSidebarTab, sidebarSplitIntentRef,
      sidebarSurfaceStillCurrent, sidebarTabOpeningRef, syncSidebarTabs,
    } = deps;
    const { effectiveOrigin, key, openProof, resourceAddress } = action;
    const { splitToken } = plan;
    if (splitToken !== null) {
      let acknowledged = true;
      if (markSidebarSplitOpen !== null) {
        try { acknowledged = markSidebarSplitOpen.call(config, splitToken) !== false; } catch { acknowledged = false; }
      }
      if (!acknowledged) {
        cancelPendingSidebarSplit("resource-not-acknowledged");
      } else if (sidebarSplitIntentRef.current?.token === splitToken) {
        sidebarSplitIntentRef.current.resourceIssued = true;
      }
    }
    // 记录必须发生在 openResource 之后：它读的是宿主提交后的 active tab，是打开的证据。
    // openProof 把「发出之前地址上没有 tab」这条因果证据一路带进来源判据（见 recordSidebarTab）。
    const opened = recordSidebarTab(key, resourceAddress, effectiveOrigin, openProof);
    // 只要这次打开的 tab 已经落定，就不能留下 opening 记录：它的语义是「这次打开还没有确定
    // 证据」（split 事务仍在等待 pane 证据、或本来就没有事务时都一样）。残留的 opening 会让
    // 用户收回这个 tab 之后的下一次同步把关闭记录重新建回来（<< 复活），并把之后的点击挡成
    // 「点了没反应」——在途状态一律由上面的 split 意图与取消路径负责收口。
    if (opened) sidebarTabOpeningRef.current.delete(key);
    // openResource 可能已经同步提交 tab：立即推进一次同步，让同 pane 回退不依赖下一轮 observer。
    // 若宿主稍后才渲染 DOM，keepMounted + observer/轮询仍会继续补偿。
    // 旧闭包绝不允许在新 surface 上推进同步（见 finishSidebarAction 的说明）。
    if (sidebarSurfaceStillCurrent() === true) syncSidebarTabs();
  }
  /** undefined */
  function useSidebarPanelActionHandlersPart2(frame) {
    const {
      abandonAutoSidebarAction, autoActionStillValid, cancelPendingSidebarSplit, closeSidebarResource,
      openSidebarResource, recordSidebarManualIntent, sidebarSplitIntentRef, sidebarTabOpeningRef,
      sidebarTabPendingRef, sidebarTabRecordsRef,
    } = frame;

    /**
     * 侧栏箭头点击的唯一入口：打开与关闭共用一条路径，同一 key 上串行（pending 防重入）。串行窗口
     * 覆盖从「读记录」到「记录落定」的整段同步逻辑；openResource / close 抛错只影响这一次动作，
     * 绝不写状态（打开失败保持 >>，关闭失败保持 <<）。
     *
     * 三段式（票据 31）：入口归一 → 关闭 / 打开两条路径 → 收尾，三段共享同一个 action 上下文。
     */
    const handleSidebarAction = async (key, resourceAddress, actionOrigin, autoAction) => {
      const action = createSidebarActionContext(frame, key, resourceAddress, actionOrigin, autoAction);
      if (action === null) return;
      const pending = sidebarTabPendingRef.current;
      if (pending.has(key)) {
        /**
         * 同一个 key 上已经有动作在途（典型：Auto 正在等 split 返回 pane / 等布局提交 / 等打开落地）。
         * 用户此刻的手动点击绝不能因为「锁被占用」而消失：它被记成手动意图，由在途动作在副作用之前
         * 让位、或由本函数收尾后立即结算（见 applyPendingManualIntent）。手动意图只在手动路径上记录。
         */
        if (action.origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
        return;
      }
      pending.add(key);
      try {
        /**
         * 副作用之前的第一道复核（自动路径）：Auto 开关的权威值与动作代次都可能在等待期间变化。
         * 关闭 Auto 时必须在这里放弃——包括「已经 split 出 pane」的前一阶段遗留在途记录的情况。
         */
        if (action.autoContext !== null && autoActionStillValid(action.autoContext) !== true) {
          abandonAutoSidebarAction(key, action.autoContext);
          return;
        }
        const record = sidebarTabRecordsRef.current.get(key);
        if (record === undefined && sidebarTabOpeningRef.current.has(key)) {
          /**
           * 打开已经发出、落地证据还没到：手动点击同样不能丢。按意图记账，等它落地（或超时）后
           * 由同步链路结算；在这之前绝不补发第二次 openResource，也绝不猜 tabId 去关闭。
           */
          if (action.origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
          return;
        }
        // 关闭态：只调用记录里的精确 tabId。绝不根据 active() 当前是谁来决定关哪个 tab。
        if (record !== undefined && closeSidebarResource !== null) {
          await closeSidebarActionWithLease(action, frame, record);
          return;
        }
        if (openSidebarResource === null) return;
        // 旧宿主 / 复用已有 pane 的路径完全同步（与拆分前同一 tick），只有走公开 split() 的那条
        // 会返回 promise；这里只在真的需要等待时才让 finally 顺延到微任务。
        const openResult = runSidebarOpenAction(action, frame);
        if (openResult !== null && openResult !== undefined && typeof openResult.then === "function") {
          await openResult;
        }
      } catch {
        if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("resource-failed");
        sidebarTabOpeningRef.current.delete(key);
        /* 宿主暂时打不开/关不掉这个地址：只影响这一次侧栏动作，状态绝不被污染。 */
      } finally {
        finishSidebarAction(action, frame);
      }
    };

    // 登记给更早 Hook 的晚绑定包装（声明已完成，此后的调用都拿到本帧的实例）。
    frame.late.handleSidebarAction = handleSidebarAction;
    Object.assign(frame, {
      handleSidebarAction,
    });
  }

  /**
   * 动作收尾：释放在途记账（预留 / 失败屏障 / 手动意图结算）。
   *
   * surface 仍是出发时那一份时历史行为逐字不变（预留必须释放，否则一次失败会被永久记成「已经
   * 打开过」；打开没有真正发出时撤销残留来源，并结算窗口里的手动意图）；generation 已经换掉时
   * 只清理明确属于本实例这一次动作的预留，共享 Auto 账本与手动意图一律不碰。
   */
  function finishSidebarAction(action, deps) {
    const {
      applyPendingManualIntent, sidebarAutoFailedKeysRef, sidebarAutoOriginRef, sidebarAutoReservationRef,
      sidebarSurfaceStillCurrent, sidebarTabPendingRef,
    } = deps;
    const { autoContext, key, openIssued } = action;
    sidebarTabPendingRef.current.delete(key);
    const surfaceCurrent = sidebarSurfaceStillCurrent() === true;
    if (autoContext !== null) {
      sidebarAutoReservationRef.current.delete(key);
      if (surfaceCurrent === true && autoContext.kind === "open" && openIssued !== true) {
        sidebarAutoOriginRef.current.delete(key);
        // 本次打开没有发出：把 key 记进失败屏障，同一批微任务里绝不再重选它（见其说明）。
        sidebarAutoFailedKeysRef.current.add(key);
      }
      if (surfaceCurrent === true && openIssued === true) sidebarAutoFailedKeysRef.current.delete(key);
    }
    /**
     * 在途动作收尾后立刻结算用户在这个窗口里表达的手动意图：手动恒优先，绝不因为「那次点击撞上
     * 了 pending 锁」而丢失。没有意图时这一步是幂等空操作。
     *
     * 只由仍然属于当前 surface 的闭包结算：applyPendingManualIntent 会改共享的来源 / 抑制 / 重试
     * 账本，并可能派发新的打开或关闭动作；surface 换代后这些收尾属于新 Panel 的下一轮外部同步。
     */
    if (surfaceCurrent === true) applyPendingManualIntent(key);
  }
  /** 批量关闭动作编排。 */
  function useSidebarPanelBatchClose(frame) {
    const {
      bump, closeSidebarResource, closeSidebarTabWithLease, rootSessionId, sidebarBatchPendingRef, sidebarBatchScopeKey,
      sidebarSessionId, sidebarSurfaceStillCurrent, sidebarTabPresenceInInventory, syncSidebarTabs,
    } = frame;

    /**
     * 批量关闭的唯一入口（主代理行 = 运行中专家/分片；空闲标题行 = ready 专家/已结算分片）。
     *
     * 与单会话箭头共用三条边界：1) 聚合锁覆盖整段 await 序列，锁按 (sidebar session, root) 隔离，
     * 只拒绝同一个 surface 的重复点击；2) 候选集合来自点击那一刻的 inventory 快照，但每个候选
     * 调用 close 前必须重读当前 inventory 并复核地址（期间可能已被别的入口关掉）；3) 每次 await
     * 前后都过 surface 闸门（含不可复用令牌），A→B→A 回返后立即停止。
     *
     * 单项失败严格隔离：抛错只跳过这一项，也绝不把失败项标成已关闭（记录交给宿主 inventory 与
     * 既有同步器确认）。与单项入口共用 closeSidebarTabWithLease 的等待/接管语义。
     */
    const handleSidebarBatchClose = async (candidates) => {
      if (sidebarSurfaceStillCurrent() !== true) return;
      if (closeSidebarResource === null) return;
      if (Array.isArray(candidates) !== true || candidates.length === 0) return;
      // 锁只覆盖「这一个 surface」：同一个 scope 的重复点击被拦下，别的 root/session 的批量按钮
      // 完全不受影响（它的键不在集合里）。
      const scopeKey = sidebarBatchScopeKey(sidebarSessionId, rootSessionId);
      const pendingScopes = sidebarBatchPendingRef.current;
      if (pendingScopes.has(scopeKey) === true) return;
      pendingScopes.add(scopeKey);
      // 立刻进入 pending 态：按钮 disabled + aria-busy，第二次点击在 has 检查处被拦下。
      bump((value) => value + 1);
      try {
        for (const candidate of candidates) {
          // await 之前：surface 已经换掉（卸载、root/session 切换，或同一个实例 A→B→A 回返）即停止
          // 后续关闭。判据含不可复用的 surface 令牌，字符串重新相等不算「还是当前 surface」。
          if (sidebarSurfaceStillCurrent() !== true) return;
          /**
           * 候选形状闸门：候选必须**同时**携带 tabId 与资源地址（见 sidebarBatchCandidates）。
           * 缺任何一个都无法在副作用之前回答「这个 id 此刻仍然是我们要关的那个资源」——一律跳过
           * 这一项（其余候选继续处理），绝不退化成「只按 tabId 盲关」。
           */
          const tabId = text(object(candidate).tabId, null);
          const candidateAddress = text(object(candidate).address, null);
          if (tabId === null || candidateAddress === null) continue;
          /**
           * 每个候选调用前重新读**当前** inventory，并同时复核**地址**：候选集合只是点击那一刻的
           * 渲染快照，而等待前一个候选的 close 期间，同一个 tab 完全可能已经被别的入口（用户刚点的
           * 单项箭头、Auto 的关闭、旧 Panel 的迟到收尾）成功关闭，甚至这个 tabId 已经被宿主回收给了
           * 另一个资源。只有「present 且条目暴露的地址与候选地址逐字一致」才允许调用 close；
           * absent / recycled / unreadable 一律跳过这一项，绝不按 active tab 或渲染时快照猜一个 id。
           */
          if (sidebarTabPresenceInInventory(tabId, candidateAddress) !== "present") continue;
          // 批量关闭是显式手动语义：按候选地址把持久标记改写成 manual（手动恒优先）。
          writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, candidateAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
          /**
           * 与单 tab 关闭共用同一个执行入口（同一把 session + root + tabId 租约 + 结算信号）：
           * 这个 tab 上已经有一次关闭在途时（典型：用户刚点的单项箭头还停在宿主 Promise 里），
           * 批量必须等待它结算再决定——上次成功就直接收口（绝不重复 close），上次失败且当前
           * inventory 仍证明这个精确 tabId 存在**且地址一致**时才接管**一次**有限重试。用户按下的
           * 批量意图因此绝不在冲突里被静默丢失，也不会对已经关掉的 tab 重复调用 close。
           */
          await closeSidebarTabWithLease(tabId, {
            waitForCompeting: true,
            /**
             * 批量入口没有 key（它的候选只有 tabId + 地址）：按手动语义处理，不做验证收口——记录由
             * 同步层结算。地址必须传下去：它既是 preflight 的地址判据，也是等待竞争租约时等待者
             * 自己那份复核证据（没有地址证据的等待者遇到 recycled 结算只能跳过）。
             */
            verify: { key: null, address: candidateAddress, attemptToken: null, manual: true },
          });

          // await 之后：surface 已切换（含同一个实例 A→B→A 回返）时不再继续（已经发出的那一次
          // 关闭照旧由宿主结算）。判据含不可复用的 surface 令牌，字符串重新相等不算「还是当前 surface」。
          if (sidebarSurfaceStillCurrent() !== true) return;
        }
      } finally {
        // 只释放自己那一个 scope：旧序列的收尾绝不改写别的 root/session 的锁。
        pendingScopes.delete(scopeKey);
        // 重渲染与同步只服务**自己这一轮渲染**的 surface：root/session 已经切换时它们会去操作
        // 新 surface（旧 scope 的 bump 会让新 root 白白重渲染、旧闭包的 sync 会去同步旧 root）。
        // 判据含不可复用的 surface 令牌：同一个实例 A→B→A 之后字符串会重新相等，但这一轮批量序列
        // 已经不属于当前 surface，收尾交给新 Panel 自己的同步（bump 只由它自己发起）。
        if (sidebarSurfaceStillCurrent() === true) {
          bump((value) => value + 1);
          // 关闭序列结束后推进一次同步：候选集合与签名都按宿主 inventory 重新读取，
          // 真正被宿主关掉的 tab 由既有同步器（present/active/浮窗标题证据）结算，插件不抢先删记录。
          syncSidebarTabs();
        }
      }
    };

    Object.assign(frame, {
      handleSidebarBatchClose,
    });
  }
  /**
   * 任务管理动作（取消分片 / 重试分片 / 取消父任务）的唯一入口。三条并发边界：
   *
   * 1) 去重锁覆盖「确认弹窗 await + RPC 发送 + 尾随刷新」全程：占位发生在**发起确认之前**，
   *    因此确认弹窗还开着时的重复点击（双击、连击、键盘重复触发）会在 has(key) 处静默返回，
   *    既不会弹出第二个确认，也不会并发发出第二个 RPC。旧实现先确认后占锁，await 期间锁是空的，
   *    重复点击会穿过检查并各发一次请求。
   * 2) 确认返回后重读**当前**选中的根会话（currentRootRef 每次渲染同步更新）再发请求：
   *    确认期间用户切换了 root 时，动作绑定切走后的新会话，绝不用闭包里捕获的旧值。
   * 3) 确认期间或 RPC 在途期间组件被卸载（宿主切换 surface 的常见形态）时静默放弃：
   *    不发请求、不刷新、不写状态，杜绝迟到 setState 与卸载后重新拉起的轮询请求。
   *
   * 锁键沿用「动作类型 + parentTaskId + shardId」而不含 rootSessionId：同一实例切换 root 后，
   * 新树里同 id 的按钮在这段收尾窗口内也会显示处理中，直到动作结算（最长一次 RPC 时长）。
   * 这是刻意取舍——锁只需要在「同一实例的同一个动作」上成立，加入 root 会让锁出现第二事实源，
   * 反而可能在切换瞬间漏锁；跨实例的重复提交由 Host 侧的任务状态判定兜底。
   */
  function useSidebarPanelRunAction(frame) {
    const {
      bump, catalogEntryOf, config, contextRef, currentRootRef, metaRefreshRef, metaStateRef, mountedRef, react,
      refreshRef, setState,
    } = frame;

    /** 行内状态投影的窄包装：目录项只按 (parentId, childId) 现读，不缓存、不新增请求。 */
    const runtimeStatusOfNode = (node, parentId, childId, options) => runtimeStatusOf(
      node,
      catalogEntryOf(parentId, childId ?? text(object(node).sessionId, null)),
      options,
    );
    /** 同键动作去重锁：Set 放在 ref 里，动作期间的重渲染不会重置它。 */
    const pendingSet = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
    /**
     * 恢复重试的本地状态（票据 04）：{ rootSessionId, inFlight, error }。
     *
     * 为什么用 ref 而不是 state：与 pendingSet 同一模式——重试期间要立刻禁用按钮并显示
     * 进度，只靠 Host 快照（2.5s 轮询 + 完整快照缓存）会有明显延迟；这里用 ref + bump
     * 驱动一次同步重渲染。rootSessionId 绑定发起时的 root：同一实例切换 root 后，
     * 旧请求的迟到结果绝不会显示在新会话的横幅上（也不会把新 root 的按钮标成处理中）。
     *
     * error 只保存**重试动作本身**的失败细节（业务失败返回的 error 块或传输/校验异常），
     * 它是补充信息；恢复失败的主原因码始终来自 snapshot.recovery（Host 权威投影）。
     */
    const recoveryRetryRef = typeof react.useRef === "function"
      ? react.useRef({ rootSessionId: null, inFlight: false, error: null })
      : { current: { rootSessionId: null, inFlight: false, error: null } };
    const runAction = async (request, key, requiresConfirm, message, options) => {
      // options（票据 25/28）：{ includeErrorCode, safeMessage, refreshMeta }；
      // 默认全部关闭，取消/重试等既有动作的文案与副作用逐字不变。
      const actionOptions = object(options);
      // 已卸载的实例不再接受新动作（按钮即使还残留在旧 DOM 上也不会发出请求）。
      if (mountedRef.current !== true) return null;
      // 同键动作进行中：静默忽略，不排队也不提示。
      if (pendingSet.current.has(key)) return null;
      // 先占锁再确认：锁必须在第一个 await 之前生效，否则重复点击会穿过上面的空闲检查。
      pendingSet.current.add(key);
      // 立刻让同键动作进入 pending 态（按钮 disabled + aria-busy），单击到确认弹窗之间的
      // 空隙里再次点击同样会被 has(key) 拦下。
      bump((value) => value + 1);
      // 新动作开始即让上一条**动作类**错误退场（票据 13）：action/rpc 错误只属于发起它的那次
      // 动作，用户再次操作时它已经过期。snapshot 错误属于快照槽，不在这里清（它由刷新自己裁决）。
      setState((previous) => {
        const current = previous.error;
        if (current === null || (current.source !== PANEL_ERROR_SOURCES.action && current.source !== PANEL_ERROR_SOURCES.rpc)) {
          return previous;
        }
        return { ...previous, error: null };
      });
      try {
        if (requiresConfirm) {
          // 没有确认能力时什么都不做：破坏性操作绝不降级为静默执行。
          if (typeof config.confirm !== "function") return null;
          let accepted = false;
          try { accepted = await config.confirm(message); } catch { accepted = false; }
          if (accepted !== true) return null;
          // 确认弹窗打开期间 surface 可能已被卸载：卸载即静默放弃，不再发请求。
          if (mountedRef.current !== true) return null;
        }
        // 重读当前选中 root：ref 在每次渲染同步写入，因此这里拿到的是「确认完成这一刻」
        // 用户实际选中的会话。空会话无法定位任务，直接放弃而不是发一条无目标的请求。
        const targetSessionId = typeof currentRootRef.current === "string" ? currentRootRef.current : "";
        if (targetSessionId === "") return null;
        const result = await callRpc(config, contextRef.current, { ...request, sessionId: targetSessionId });
        // RPC 在途期间卸载：不刷新、不写状态（动作本身已由 Host 侧收下，无需再补）。
        if (mountedRef.current !== true) return null;
        // 走最新渲染的 refresh：确认期间切换过 root 时，用旧闭包刷新会把旧 root 的快照
        // 写回新 surface，也会为旧 root 多发一次请求。
        await refreshRef.current();
        // 票据 26：meta 已经加载（用户打开过诊断读面）时随动作补一次只读诊断刷新，
        // 让「取消排队分片」后 running/queued 立即回到最新；未加载时绝不新增请求。
        if (metaStateRef.current !== null && actionOptions.refreshMeta !== false) {
          const refreshMeta = metaRefreshRef.current;
          if (typeof refreshMeta === "function") void refreshMeta();
        }
        // 把回执原样交给调用方：动作自己决定是否消费回执字段（取消/重试不消费）。
        return result;
      } catch (error) {
        // 卸载后的失败没有可展示的错误面，静默丢弃，绝不 setState。
        if (mountedRef.current !== true) return null;
        // 动作失败按来源分档（票据 13）：callRpc 标记过的传输/协议失败呈现「请求失败」，
        // 其余（Host 结构化拒绝、动作链路上的其它失败）呈现「操作失败」。
        // 两种来源都**不再**显示「快照读取失败」：任务树本身没坏，旧快照继续可见。
        let message = error instanceof Error ? error.message : String(error);
        if (actionOptions.safeMessage === true) {
          const redact = modelFunction("redactDisplayText");
          const clean = redact === null ? message : redact(message, 200);
          message = clean === "" ? message : clean;
        }
        // includeErrorCode：把 Host 的稳定 code 放在最前面，用户可按来源核对
        // （客户端仍然只展示文案，不解析 code 做业务判断）。其它动作保持既有原文。
        const code = actionOptions.includeErrorCode === true ? text(object(error).code, null) : null;
        if (code !== null) message = code + " · " + message;
        const source = rpcFailureKindOf(error) === RPC_FAILURE_TRANSPORT
          ? PANEL_ERROR_SOURCES.rpc
          : PANEL_ERROR_SOURCES.action;
        // 时间戳在事件路径取一次：updater 保持纯函数（StrictMode 可能调用两次）。
        const at = Date.now();
        setState((previous) => ({ ...previous, error: { source, message, at } }));
        return null;
      } finally {
        // 释放锁无条件执行（含提前 return 的分支）；只有仍挂载时才触发重渲染。
        pendingSet.current.delete(key);
        if (mountedRef.current === true) bump((value) => value + 1);
      }
    };

    frame.late.runtimeStatusOfNode = runtimeStatusOfNode;
    Object.assign(frame, {
      pendingSet, recoveryRetryRef, runAction, runtimeStatusOfNode,
    });
  }

  /**
   * 恢复重试入口（票据 04）：调用 fanout-restore-retry，成功后刷新快照。
   *
   * 失败语义（与既有动作错误面完全隔离）：
   * - RPC 业务失败（restored:false）不是异常：Host 会把稳定原因码放在回执的 error 块里，
   *   这里记录到横幅的补充行，**不**写入 title 区的「快照读取失败」槽；
   * - 传输/校验异常（404 根会话不存在、网络失败）同样只记录补充行；横幅本身继续由
   *   snapshot.recovery 驱动，因此「失败保持错误态与原因码」不依赖一次成功的快照刷新；
   * - 成功（restored:true）后无论刷新是否成功，下一次成功快照都会把 recovery 变成 ok，
   *   横幅随之消失（快照不再含 failed 块）。
   *
   * 并发边界与 runAction 一致：卸载后不写状态；切换 root 后旧结果只落回旧 root 的账本
   * 而不污染当前 surface；同一 root 的在途重试直接忽略重复点击。
   */
  function useSidebarPanelRunActionPart2(frame) {
    const {
      bump, config, contextRef, currentRootRef, mountedRef, recoveryRetryRef, refreshRef,
    } = frame;

    const retryRecovery = async () => {
      if (mountedRef.current !== true) return;
      const targetSessionId = typeof currentRootRef.current === "string" ? currentRootRef.current : "";
      if (targetSessionId === "") return;
      const previous = recoveryRetryRef.current;
      if (previous.rootSessionId === targetSessionId && previous.inFlight === true) return;
      recoveryRetryRef.current = { rootSessionId: targetSessionId, inFlight: true, error: null };
      bump((value) => value + 1);
      let failure = null;
      try {
        const result = await callRpc(config, contextRef.current, {
          action: "fanout-restore-retry",
          sessionId: targetSessionId,
        });
        if (result?.restored !== true) {
          const error = object(result?.error);
          const code = text(error.code, null);
          // restored:false 且没有 error 块 = 磁盘上没有可恢复快照（Host 的既有早退语义）：
          // 这不是失败，但也没有清除错误态，保持横幅并让用户知道重试没有恢复任何任务。
          failure = code === null
            ? { code: "NO_RESTORABLE_SNAPSHOT", message: "当前没有可恢复的持久化任务" }
            : { code, message: text(error.message, "") };
        }
      } catch (error) {
        failure = {
          code: "RETRY_FAILED",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const stillCurrent = mountedRef.current === true && currentRootRef.current === targetSessionId;
      recoveryRetryRef.current = { rootSessionId: targetSessionId, inFlight: false, error: stillCurrent ? failure : null };
      // 卸载或已切走：迟到结果不触发刷新/重渲染（新 surface 自己维护状态）。
      if (stillCurrent !== true) return;
      bump((value) => value + 1);
      // 无论成功还是失败都刷新：成功让横幅随 recovery=ok 消失，失败则把 Host 重新记录的
      // 原因码/任务树取回来（失败原因码仍以 snapshot.recovery 为权威）。
      await refreshRef.current();
    };

    Object.assign(frame, {
      retryRecovery,
    });
  }

  global[SYMBOL] = Object.freeze({
    useSidebarPanelActionHandlers, useSidebarPanelActionHandlersPart2, useSidebarPanelBatchClose,
    useSidebarPanelRunAction, useSidebarPanelRunActionPart2, useSidebarPanelTabRecorder,
    useSidebarPanelTabRecorderPart2,
  });
})(globalThis);
