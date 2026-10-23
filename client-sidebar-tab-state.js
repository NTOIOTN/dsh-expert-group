/**
 * 客户端侧栏 · tab 记账与操作状态（R6 / sidebar-tab-state）
 *
 * ## 职责边界
 * 本模块是「右栏 tab 记账」的**唯一计算面**：从快照推导可操作资源地址（运行中 / 空闲）、
 * 从公开 inventory 读面判定某个资源当前的 tab 状态、批量关闭候选与签名、手动意图的作用域过滤，
 * 以及自动关闭预算（重试次数 / owner 令牌 / 失败冷却 / 连续缺失采样）的转移函数。
 *
 * ## 状态所有权（规格书 §状态所有权(3)）
 * - **容器身份**仍由各自 owner 持有：实例级 Map/Set 由 Panel 的 ref 持有（client-sidebar-panel-state-a/b）；
 *   跨安装 / 跨 bundle 的共享账本由 client-sidebar-auto-ledger.js 创建并复用（realm 级）。
 * - 本模块只承接**转移函数**（读 → 判定 → 写回同一批容器），不 new 任何长期容器，也不缓存结论。
 *   把转移函数集中在这里，是为了让「谁在什么时候改账本」只有一处可审计的实现；写入点因此
 *   从主 IIFE 迁出，而不是新增第二个写入方。
 * - 每次调用都由调用方把**本帧的**容器与 surface 身份传进来：绝不跨帧保留 sessionId / rootSessionId，
 *   也绝不把某一帧的判定结果留到下一帧（旧实现的所有判据都是闭包值，这里逐字保持该语义）。
 *
 * ## 关键语义（逐条保留，不得放宽）
 * - 空集合 vs null：空集合 =「读到了、确实没有」；null =「读不到」。调用方据此保持现状或复位；
 * - 严格判据（sidebarNodeIsIdleReady）只用于**会真的操作宿主资源**的路径；分组**显示**用
 *   sidebarNodeIsIdleMembership（轻量快照下 unknown 也进组），两条规则刻意不同（显示从宽、操作从严）；
 * - 批量候选必须同时携带 tabId 与资源地址：宿主可以把已释放的 tabId 回收给另一个资源，
 *   只按 tabId 执行等于盲关别人的 tab；
 * - 自动关闭预算与 owner 令牌同生共死；采样计数与预算同生共死；限容淘汰绝不淘汰仍可能被精确关闭的 key。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-tab-state")]
 * 装配：只从 globalThis 检查点取回 pure / dom 依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarTabState(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-tab-state");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    FANOUT_SETTLED_STATUSES, RIGHTBAR_FLOAT_SELECTOR, RIGHTBAR_FLOAT_TITLE_SELECTOR,
    SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS, SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS,
    SIDEBAR_AUTO_KEY_LIMIT, SIDEBAR_TAB_KEY_SEPARATOR,
    object, statusOf, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const { SUBAGENT_CHAT_KIND, subagentChatAddress } = DOM;

  /* ----------------------------------------------------------------------------------------------- *
   * 一、资源地址推导（快照 → 可操作地址集合）
   * ----------------------------------------------------------------------------------------------- */

  /**
   * 外部关闭同步（低成本、幂等、绝不抛错）。
   *
   * 停靠 tab 通过宿主渲染的 tabId 标记观察，浮动 tab 通过 subagentchat body 与打开时标题做
   * 保守正向匹配；面板、浮动查询或任何 DOM 能力缺失时返回 null，调用方保持现有状态，
   * 绝不把焦点切换或 surface 过渡猜成关闭。
   */
  function presentFloatingSubagentTitles(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return null;
    let floats = null;
    try { floats = Array.from(doc.querySelectorAll(RIGHTBAR_FLOAT_SELECTOR)); } catch { return null; }
    const titles = new Set();
    for (const float of floats) {
      if (typeof float?.querySelector !== "function") return null;
      let chat = null;
      let titleNode = null;
      try {
        chat = float.querySelector("[data-sidebar-chat]");
        titleNode = float.querySelector(RIGHTBAR_FLOAT_TITLE_SELECTOR);
      } catch { return null; }
      if (chat === null || titleNode === null) continue;
      const title = text(titleNode.textContent, null);
      if (title !== null) titles.add(title);
    }
    return titles;
  }

  /**
   * 快照里当前有打开记录的候选资源地址集合（收养判定用）。
   *
   * @param {any} snapshot 归一快照（缺失时按空树处理）
   * @param {string} rootSessionId 当前 root
   * @param {(childId: string, parentId: string, node: any) => any} addressOf 规范地址解析（由 Panel 注入）
   */
  function knownSidebarResourceAddresses(snapshot, rootSessionId, addressOf) {
    const addresses = new Set();
    const add = (node, parentId) => {
      const source = object(node);
      if (source.kind === "fanout") {
        const shards = Array.isArray(source.shards) ? source.shards : [];
        for (const shard of shards) {
          const shardSource = object(shard);
          const childId = text(shardSource.childId, null);
          if (childId === null) continue;
          const address = subagentChatAddress(addressOf(childId, parentId, {
            ...shardSource,
            kind: "expert",
          }));
          if (address !== null) addresses.add(address);
        }
      } else {
        const childId = text(source.sessionId, text(source.childId, null));
        if (childId !== null) {
          const address = subagentChatAddress(addressOf(childId, parentId, source));
          if (address !== null) addresses.add(address);
        }
      }
      if (Array.isArray(source.children)) {
        for (const child of source.children) add(child, parentId);
      }
    };
    const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
    for (const child of children) add(child, rootSessionId);
    return addresses;
  }

  /**
   * 当前 root 专家树里的「运行中」资源地址（普通专家、嵌套专家与最新 fan-out 分片）。
   *
   * 与行内渲染使用**同一个**规范地址 helper（addressOf + subagentChatAddress），因此批量候选与
   * 单会话箭头指向的是同一个 contentId，绝不存在第二套地址推导。
   *
   * 纳入条件只有一条：statusOf(...) === "running"（与行内圆点同源）。
   * ready/unknown 一律不纳入——未知状态绝不混进「可以关闭」的集合。
   */
  function sidebarExpertResourceAddresses(node, parentId, addresses, deps) {
    const addressOf = deps.addressOf;
    const statusOfNode = deps.statusOf;
    const source = object(node);
    const kind = text(source.kind, null);
    if (kind === "fanout") {
      const shards = Array.isArray(source.shards) ? source.shards : [];
      for (const shard of shards) {
        const shardSource = object(shard);
        // 只认最新 attempt 的 childId：旧 attempt 的子会话不再由这一行代表，也不是可导航目标。
        const childId = text(shardSource.childId, null);
        if (childId === null) continue;
        if (statusOfNode(shardSource, parentId, childId) !== "running") continue;
        const address = subagentChatAddress(addressOf(childId, parentId, {
          ...shardSource,
          kind: "expert",
        }));
        if (address !== null) addresses.add(address);
      }
      return;
    }
    if (kind !== "expert") return;
    const childId = text(source.sessionId, text(source.childId, null));
    if (childId !== null && statusOfNode(source, parentId, childId) === "running") {
      const address = subagentChatAddress(addressOf(childId, parentId, source));
      if (address !== null) addresses.add(address);
    }
    // 嵌套专家：parent 就是它的宿主专家会话；宿主缺失时内层地址推导 fail-closed。
    if (Array.isArray(source.children)) {
      for (const child of source.children) sidebarExpertResourceAddresses(child, childId, addresses, deps);
    }
  }

  /**
   * 空闲证据规则（空闲分组与空闲批量关闭候选的**唯一**判定入口）。
   *
   * 只有 statusOf(...) === "ready"（**有证据**表明当前未运行）才算空闲：
   * - 轻量快照（partial）下「没有任何活动证据」的节点被归一为中性值，既不是 running 也不是 ready，
   *   因此既不得进入空闲分组、也不得成为空闲批量关闭候选——否则用户会依据轻量快照关掉实际仍在
   *   运行、只是首屏读不到状态的会话；
   * - 完整快照到达后不会再出现中性值，规则自动回到既有行为，不留永久性差异；
   * - running 与中性值一样被排除，保守方向不变。
   */
  function sidebarNodeIsIdleReady(node, parentId, childId, deps) {
    return deps.statusOf(node, parentId, childId, { partial: deps.partial }) === "ready";
  }

  /**
   * 空闲分组的**成员**判定（显示从宽）。
   *
   * 在严格判据之外，额外接受轻量快照下「没有任何活动证据」的中性节点：它们与 ready 一样被
   * 收纳进分组，只是圆点与文案保持中性。这样同一份数据在 partial / full 下分组的**成员集合与顺序
   * 完全一致**，消除「同一节点在两条路径之间来回跳位」的用户可见缺陷。
   *
   * 只放宽**显示**：任何会真的操作宿主资源的路径都必须继续使用严格的 sidebarNodeIsIdleReady。
   */
  function sidebarNodeIsIdleMembership(node, parentId, childId, deps) {
    const status = deps.statusOf(node, parentId, childId, { partial: deps.partial });
    if (status === "ready") return true;
    // 中性值只可能来自 partial 快照（完整快照的证据链不会返回它）：此时纳入分组显示。
    return deps.partial === true && status === deps.neutralStatus;
  }

  /** 空闲分组收纳 ready 直接专家和已结算的 fan-out 父任务（成员判定见 sidebarNodeIsIdleMembership）。 */
  function sidebarIdleChildren(children, rootSessionId, deps) {
    return (Array.isArray(children) ? children : [])
      .filter((node) => {
        if (node.kind === "fanout") return FANOUT_SETTLED_STATUSES.has(statusOf(node));
        return node.kind === "expert"
          && sidebarNodeIsIdleMembership(node, rootSessionId, text(node.sessionId, null), deps);
      });
  }

  /** 当前 root 专家树里「运行中」的资源地址集合（主代理行批量关闭的唯一候选来源）。 */
  function runningSidebarResourceAddresses(children, rootSessionId, deps) {
    const addresses = new Set();
    for (const child of Array.isArray(children) ? children : []) {
      sidebarExpertResourceAddresses(child, rootSessionId, addresses, deps);
    }
    return addresses;
  }

  /**
   * 空闲分组的资源地址集合（空闲批量关闭的**唯一**候选来源）。
   *
   * 与分组**成员**判定是两条不同严格度的规则（「显示从宽、操作从严」）：成员用
   * sidebarNodeIsIdleMembership（中性值也进组显示），候选在这里用严格的 sidebarNodeIsIdleReady
   * 再复核一次——轻量快照下没有活动证据的节点虽然会出现在分组里，但绝不会成为可关闭的目标。
   */
  function idleSidebarResourceAddresses(nodes, rootSessionId, deps) {
    const addresses = new Set();
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const source = object(node);
      if (source.kind === "fanout") {
        for (const shard of Array.isArray(source.shards) ? source.shards : []) {
          const shardSource = object(shard);
          const shardChildId = text(shardSource.childId, null);
          // childId 缺失与中性状态一样，都不能进候选：没有精确地址就没有可关闭的目标。
          if (shardChildId === null || sidebarNodeIsIdleReady(shardSource, rootSessionId, shardChildId, deps) !== true) continue;
          const shardAddress = subagentChatAddress(deps.addressOf(shardChildId, rootSessionId, {
            ...shardSource,
            kind: "expert",
          }));
          if (shardAddress !== null) addresses.add(shardAddress);
        }
        continue;
      }
      const childId = text(source.sessionId, text(source.childId, null));
      if (childId === null) continue;
      // 防御式复核：实参与 idleChildren 的成员判定逐字相同，因此对既有成员的结果完全不变。
      if (sidebarNodeIsIdleReady(source, rootSessionId, text(source.sessionId, null), deps) !== true) continue;
      const address = subagentChatAddress(deps.addressOf(childId, rootSessionId, source));
      if (address !== null) addresses.add(address);
    }
    return addresses;
  }

  /* ----------------------------------------------------------------------------------------------- *
   * 二、inventory 读面判定（某个资源的 tab 现状）
   * ----------------------------------------------------------------------------------------------- */

  /**
   * 当前 sidebar session 的公开 inventory 里，某个资源地址对应的已提交 tabId。
   *
   * 返回值必须区分两种「没有」——这是能力降级 fail-closed 的唯一判据：
   * - readable === false：inventory 不可读（旧宿主 / 读取抛错）。既证明不了资源已打开，也证明不了它没打开；
   * - readable === true && tabId === null：读到了 inventory，确认这个地址没有已提交 tab。
   */
  function sidebarResourceTabStateOf(inventory, sidebarSessionId, resourceAddress) {
    if (inventory === null || inventory === undefined) return { readable: false, tabId: null };
    for (const entry of inventory) {
      /**
       * 单条畸形条目（属性 getter 抛错）只跳过它自己：它既证明不了资源已打开，也不代表整份
       * inventory 不可读，因此绝不让它把异常抛到同步链路上、也绝不因此改变 readable 的语义。
       */
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
        if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
        if (text(candidate.contentId, null) !== resourceAddress) continue;
        return { readable: true, tabId: text(candidate.tabId, null) };
      } catch { continue; }
    }
    return { readable: true, tabId: null };
  }

  /**
   * 收养路径（面板重挂载 / 切换 root 后从宿主重建记录）的证据门槛。
   *
   * inventory 可读 ⇒ 必须由**当前 session** 的条目证明；只有 inventory 不可读（旧宿主 / 读取抛错）
   * 才沿用 active() 这一唯一证据——那条路径的既有契约是「外部已存在的 tab 记为手动来源」。
   */
  function sidebarAdoptionEvidenceAvailable(inventory, sidebarSessionId, resourceAddress) {
    const state = sidebarResourceTabStateOf(inventory, sidebarSessionId, resourceAddress);
    if (state.readable !== true) return true;
    return state.tabId !== null;
  }

  /**
   * active() 是否已经是这个资源（kind 与 contentId 同时匹配）。
   *
   * inventory 不可读或提交延迟时，它仍能证明「这个资源已经开着」：这样的 tab 只算手动/未知
   * 来源，Auto 既不接管也不重复打开；它只在「可追踪」判定里作为证据使用。
   * active tab 由调用方解析（读面缺失/抛错时传 null），本函数只做纯判定。
   */
  function sidebarActiveResourceMatches(activeTab, resourceAddress) {
    if (activeTab === null || activeTab === undefined) return false;
    const tab = object(activeTab);
    if (text(tab.kind, null) !== SUBAGENT_CHAT_KIND) return false;
    return text(tab.contentId, null) === resourceAddress;
  }

  /** 当前 surface 自己的手动意图记录；别的 session/root 的键在当前闭包里一律不可见。 */
  function sidebarManualIntentOf(manualIntentMap, key, sidebarSessionId, rootSessionId) {
    const entry = manualIntentMap.get(key);
    if (entry === undefined) return undefined;
    if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) return undefined;
    return entry;
  }

  /* ----------------------------------------------------------------------------------------------- *
   * 三、批量关闭候选与签名
   * ----------------------------------------------------------------------------------------------- */

  /**
   * 一次批量动作的候选集合：当前 openTabs inventory ∩ 给定的规范地址集合。
   *
   * 匹配条件缺一不可（全部来自公开只读 inventory 的字段）：
   * - candidate.sessionId === 当前 sidebar session：绝不操作别的 surface 的 tab；
   * - kind === "subagentchat"：同 session 下别的 kind 不是本插件的资源；
   * - tabId 与 contentId 都非空：缺任何一个都无法精确关闭；
   * - contentId 精确等于集合中的地址：同一个 kind 下也可能是另一个子代理的地址。
   *
   * 候选携带 { tabId, address } 两个字段：候选集合是点击那一刻的渲染快照，真正 close 之前可能
   * 跨过若干次 await，宿主可以把已释放的 tabId 回收给另一个资源——地址与 tabId 一起进候选，
   * 执行时才能复核「这个 id 此刻仍然是我们要关的那个资源」。
   */
  function sidebarBatchCandidates(addresses, inventory, sidebarSessionId) {
    const seen = new Set();
    const candidates = [];
    for (const entry of Array.isArray(inventory) ? inventory : []) {
      // 单条损坏记录（getter 抛错、非对象、缺字段）只跳过这一条：其余可关闭的 tab 照旧成候选。
      let candidate = null;
      try {
        candidate = object(entry);
        if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
        if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId === null) continue;
        const contentId = text(candidate.contentId, null);
        if (contentId === null || addresses.has(contentId) !== true) continue;
        if (seen.has(tabId) === true) continue;
        seen.add(tabId);
        candidates.push({ tabId, address: contentId });
      } catch { continue; }
    }
    return candidates;
  }

  /**
   * 两类标题行的批量状态（渲染期纯读，一次渲染只算一次）。
   *
   * 四态语义严格区分「未知」「零」「有候选但关不掉」：
   * - inventory 读不出来 → kind "none"：不渲染零圆点、也不渲染按钮；
   * - inventory 已知是数组且候选数为 0 → kind "zero"：非交互蓝色实心圆占位；
   * - 候选数 > 0 且 close 能力可用 → kind "close"：可点击的批量关闭按钮；
   * - 候选数 > 0 但 close 不可用 → kind "none"：既不能误报「零」，也绝不渲染假按钮。
   *
   * 判定的顺序有实质意义：必须先算候选再看 close 能力。反过来会把「有候选但关不掉」误判成「零」。
   */
  function sidebarBatchStateFor(addresses, options) {
    const inventory = options?.inventory ?? null;
    if (inventory === null || inventory === undefined) return { kind: "none", candidates: [] };
    const candidates = sidebarBatchCandidates(addresses, inventory, options?.sidebarSessionId ?? null);
    if (candidates.length === 0) return { kind: "zero", candidates: [] };
    if (options?.closeAvailable !== true) return { kind: "none", candidates: [] };
    return { kind: "close", candidates };
  }

  /**
   * 两行批量状态的合并签名：只在候选集合真的变化时触发一次重渲染（空闲轮询绝不空转重渲染）。
   *
   * 候选是 { tabId, address }：签名必须把**两个字段**都编码进去。只取 tabId 会让「同一个 id 换了
   * 资源地址」这种真实变化被当成没变化；直接 join 对象则退化成 "[object Object]"。
   */
  function sidebarBatchSignatureOf(runningState, idleState) {
    const part = (state) => (state.kind === "close"
      ? "close:" + state.candidates
        .map((candidate) => candidate.tabId + SIDEBAR_TAB_KEY_SEPARATOR + candidate.address)
        .join(",")
      : state.kind);
    return part(runningState) + "|" + part(idleState);
  }

  /* ----------------------------------------------------------------------------------------------- *
   * 四、自动关闭预算（重试次数 / owner 令牌 / 失败冷却 / 连续缺失采样）
   * ----------------------------------------------------------------------------------------------- */

  /**
   * 上限淘汰（复合键跨 root 保留时的安全阀，见 SIDEBAR_AUTO_KEY_LIMIT）。
   *
   * activeAware = true 时优先淘汰「没有当前 record / 没有在途动作 / 没有验证 / 没有冷却」的历史条目；
   * 若上限内全是活动条目，则**什么都不淘汰**（fail-closed）。false 保持既有语义（按插入顺序丢最旧）。
   *
   * 注意：这里判「活动」用的是**当前这个 Panel 实例**的在途状态与**当前 scope** 的 record，因此这套
   * 淘汰只允许用在「条目重新出现时会自行重建」的记账上（重试预算 / owner 令牌 / 冷却 / 抑制）。
   */
  function trimAutoKeyMap(map, options) {
    const limit = Number.isSafeInteger(options?.limit) ? options.limit : SIDEBAR_AUTO_KEY_LIMIT;
    const activeAware = options?.activeAware === true;
    const isActive = typeof options?.isActive === "function" ? options.isActive : null;
    while (map.size > limit) {
      let victim = null;
      for (const candidate of map.keys()) {
        if (activeAware !== true || isActive === null || isActive(candidate) !== true) {
          victim = candidate;
          break;
        }
      }
      if (victim === null) break;
      map.delete(victim);
    }
  }

  /**
   * 无条件收口一个 key 的共享自动关闭记账（重试预算 + owner 身份 + 采样计数）。
   *
   * 预算与 owner 必须同生共死：只删预算而留下 owner，会让旧令牌在下一次预支之后仍被误判成所有者；
   * 只删 owner 而留下预算，则旧令牌只能 fail-safe 地放弃回滚（白烧一次预算，但有界性不受影响）。
   * 候选采样计数与这条预算同生共死：预算整体不再需要时，采样序列也一并作废，绝不跨代残留。
   */
  function clearAutoCloseAttempt(ledger, key) {
    ledger.closeAttempts.delete(key);
    ledger.owners.delete(key);
    ledger.tabMisses.delete(key);
  }

  /** 清空一个 key 的失败冷却与重试预算（verified-closed / 手动接管 / 资源重新运行共用）。 */
  function clearAutoCloseBudget(ledger, key) {
    clearAutoCloseAttempt(ledger, key);
    ledger.closeCooldowns.delete(key);
  }

  /** 进入冷却慢车道：60 秒起指数退避、上限 15 分钟；origin / record 一律保留。 */
  function enterAutoCloseCooldown(ledger, key, isActive) {
    const cooldowns = ledger.closeCooldowns;
    const previous = cooldowns.get(key);
    const step = previous === undefined ? 0 : Math.min(previous.step + 1, 4);
    const delay = Math.min(SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS * (2 ** step), SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS);
    cooldowns.set(key, { step, until: Date.now() + delay });
    trimAutoKeyMap(cooldowns, { limit: ledger.limit, activeAware: true, isActive });
  }

  /** 冷却是否仍在生效：生效期内同一个 key 零次 close 请求。 */
  function autoCloseCooldownActive(ledger, key) {
    const entry = ledger.closeCooldowns.get(key);
    return entry !== undefined && entry.until > Date.now();
  }

  /** 冷却到期：清空快速预算，让这个 key 重新进入快速车道。 */
  function releaseExpiredAutoCloseCooldown(ledger, key) {
    const cooldowns = ledger.closeCooldowns;
    const entry = cooldowns.get(key);
    if (entry === undefined || entry.until > Date.now()) return;
    clearAutoCloseAttempt(ledger, key);
  }

  /**
   * 候选选择阶段的「这个 tab 连续不在场」计数（见 sharedSidebarAutoTabMisses）。
   *
   * 只有计数记录里的 tabId 与当前 record 的 tabId 一致时才有效：宿主为同一个 key 重新分配了
   * tabId（旧 tab 消失、同一个资源换成新 tab）之后，旧计数绝不能计入新一代的确认。
   */
  function autoTabMissesOf(ledger, key, tabId) {
    const entry = ledger.tabMisses.get(key);
    if (entry === undefined || entry.tabId !== tabId) return 0;
    return Number.isFinite(entry.misses) ? entry.misses : 0;
  }

  /**
   * 记一次候选采样结果，返回这个 tabId 的连续不在场次数。
   *
   * present（missing !== true）一律清零，与记录同步器「任一正向证据清零」逐字同源；absent 与
   * recycled 共用同一条连续计数。unreadable 的采样绝不走到这里——读不到既不证明存在也不证明不存在。
   *
   * 次序即 LRU：Map 对已存在的键 set 不会改变插入位置，因此先 delete 再 set 把这次采样刷到队尾；
   * 淘汰只按「最后一次采样有多旧」进行，绝不看当前实例的在途状态（那会把别的 scope 判成不活动）。
   */
  function sampleAutoTabMisses(ledger, key, options) {
    const map = ledger.tabMisses;
    const previousMisses = autoTabMissesOf(ledger, key, options?.tabId ?? null);
    map.delete(key);
    // present：清零就是「条目保持删除状态」，与记录同步器「任一正向证据清零」逐字同源。
    if (options?.missing !== true) return 0;
    const misses = previousMisses + 1;
    map.set(key, {
      sessionId: options?.sidebarSessionId ?? null,
      rootSessionId: options?.rootSessionId ?? null,
      tabId: options?.tabId ?? null,
      misses,
    });
    const limit = Number.isSafeInteger(ledger.limit) ? ledger.limit : SIDEBAR_AUTO_KEY_LIMIT;
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done === true) break;
      map.delete(oldest.value);
    }
    return misses;
  }

  /**
   * 一次「已经真的关掉」的结算后的预算收口（成功关闭 / 已证明 tab 消失）。
   *
   * - 手动动作（context === null）：手动恒优先，直接清空这个 key 的预算与 owner；
   * - 自动关闭动作：只有 owner 仍是本次动作的令牌时才清空。旧代次的迟到结算绝不碰后来者的预算；
   * - 自动打开动作（没有 close 令牌，却因为期间出现了记录而走到关闭）：只要这个 key 上已经存在
   *   任何更新的 owner，就同样不清零。
   */
  function settleAutoCloseAttempt(ledger, key, context) {
    if (context !== null && context !== undefined) {
      const owners = ledger.owners;
      if (context.kind === "close") {
        if (owners.get(key) !== context.attemptToken) return;
      } else if (owners.has(key) === true) {
        return;
      }
    }
    clearAutoCloseAttempt(ledger, key);
  }

  // 只暴露主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    autoCloseCooldownActive,
    autoTabMissesOf,
    clearAutoCloseAttempt,
    clearAutoCloseBudget,
    enterAutoCloseCooldown,
    idleSidebarResourceAddresses,
    knownSidebarResourceAddresses,
    presentFloatingSubagentTitles,
    releaseExpiredAutoCloseCooldown,
    runningSidebarResourceAddresses,
    sampleAutoTabMisses,
    settleAutoCloseAttempt,
    sidebarActiveResourceMatches,
    sidebarAdoptionEvidenceAvailable,
    sidebarBatchCandidates,
    sidebarBatchSignatureOf,
    sidebarBatchStateFor,
    sidebarExpertResourceAddresses,
    sidebarIdleChildren,
    sidebarManualIntentOf,
    sidebarNodeIsIdleMembership,
    sidebarNodeIsIdleReady,
    sidebarResourceTabStateOf,
    trimAutoKeyMap,
  });
})(globalThis);
