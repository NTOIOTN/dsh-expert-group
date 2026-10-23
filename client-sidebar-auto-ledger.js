/**
 * 客户端侧栏 · 共享自动打开账本与归属记忆（R5 / sidebar-auto-ledger）
 *
 * 跨安装生命周期（C7）的唯一 owner：共享账本（origin / suppressed / closeAttempts /
 * closeAttemptOwners / closeVerifications / closeCooldowns / tabMisses / tabCloseInFlight
 * 八张 Map）与 auto-ownership 归属记忆都在这里创建与封存。
 *
 * 为什么独立成模块：这些状态必须跨 Panel 重挂载存活，所以不能挂在 Panel 闭包上；
 * 把它们集中到唯一 owner 后，主 IIFE 与 Panel 只通过命令面（读/写/清理）访问，
 * 不存在第二份实现或第二个 timer。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-auto-ledger")]
 * 装配：只从 globalThis 检查点取回依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarAutoLedger(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");

  const SIDEBAR_SHARED_AUTO_LEDGER_KEY = Symbol.for("dsh-expert-group/sidebar#shared-auto-ledger");
  const SIDEBAR_SHARED_AUTO_LEDGER_VERSION = 1;
  /** 持久归属标记的版本化键（与 dsh-expert-group:rightbar-presented:v1 同命名风格）。 */
  const SIDEBAR_AUTO_OWNERSHIP_KEY = "dsh-expert-group:auto-ownership:v1";
  const SIDEBAR_AUTO_OWNERSHIP_LIMIT = 128;
  const SIDEBAR_AUTO_OWNERSHIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO = "auto";
  const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL = "manual";
  /** 归属标记的内存索引槽位（与 localStorage 同源 write-through；测试可重置）。 */
  const SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY = Symbol.for("dsh-expert-group/sidebar#auto-ownership-memory");
  /** 有界诊断环形缓冲：只记结论摘要，绝不记提示词 / 消息正文 / 令牌 / 凭据。 */
  const SIDEBAR_AUTO_DIAG_KEY = "dsh-expert-group:auto-diag:v1";
  const SIDEBAR_AUTO_DIAG_LIMIT = 60;
  const SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS = 360;
  const SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS = 96;
  /** 账本里八份 Map 的字段名（顺序即诊断里的 sizes 顺序）。 */
  const SIDEBAR_SHARED_AUTO_LEDGER_FIELDS = [
    "origin", "suppressed", "closeAttempts", "closeAttemptOwners",
    "closeVerifications", "closeCooldowns", "tabMisses", "tabCloseInFlight",
  ];

  /** 安全取 realm 的 globalThis：不可用时给 null，调用方一律走降级分支。 */
  const sidebarRealmHost = () => {
    try {
      return typeof globalThis === "object" && globalThis !== null ? globalThis : null;
    } catch {
      return null;
    }
  };

  /** 安全读 localStorage：缺失 / 被拒 / 抛错一律返回 null（调用方静默降级）。 */
  const sidebarLocalStorage = () => {
    try {
      const host = sidebarRealmHost();
      const storage = host === null ? null : host.localStorage;
      if (storage === null || storage === undefined) return null;
      if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;
      return storage;
    } catch {
      return null;
    }
  };

  /** 有界文本字段：非字符串按字符串化处理并截断，空值返回 undefined（不写这个字段）。 */
  const sidebarBoundedText = (value) => {
    if (value === null || value === undefined) return undefined;
    const text = typeof value === "string" ? value : String(value);
    if (text.length === 0) return undefined;
    return text.length > SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS ? text.slice(0, SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS) : text;
  };

  /** 复合键摘要：只落 hash，绝不落 session / root / 地址原文。 */
  const sidebarAutoKeyDigest = (key) => {
    const source = typeof key === "string" ? key : String(key);
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return "k" + hash.toString(36);
  };

  const sidebarAutoScopedKey = (sessionId, rootId, address) => String(sessionId) + "|" + String(rootId) + "|" + String(address);

  /**
   * realm 共享 Auto 来源账本（sharedAutoLedger.origin）条目的唯一构造函数。
   *
   * 条目形状：{ sessionId, rootSessionId, address, tabId }。**tabId 是这条账本的全部证明力所在**：
   * 它必须是「写入这一刻，插件亲眼在宿主 inventory 里读到的那个 tab」。
   *
   * - 非 null：这条条目证明「这个 tab 是 Auto 亲手打开/替换并落地的那一个」。任何据此认定 auto 的
   *   位置都必须要求 entry.tabId 与当前观察到的 tabId **逐字相等**；只要求「有条目」是不够的
   *   （缺陷 1：旧 tab 被用户/宿主移除而插件未观察到时，同 realm 的收养会把用户新开的同地址 tab
   *   当成 Auto 的旧 tab 认领，资源一空闲就把它关掉）。
   * - null：只表示「本次运行已经为这个资源发出过一次 Auto 打开、落地证据还没到」这条**去重记账**，
   *   它**不是**归属证据——任何收养 / 关闭判据都不许把它当作 auto。
   *
   * 只有插件亲眼观察到的那次 Auto 打开/替换落地（recordSidebarTab 从宿主 inventory 读到 tabId 的
   * 那一刻）才允许写入或刷新 tabId。宿主合法重 mint 新 id 而插件没有观察到时，这条绑定随之失配，
   * 收养一律退化成 manual——宁可漏收一次（tab 留在右栏交给用户手动处理），也绝不误关一个可能是
   * 用户自己刚打开的 tab。
   */
  const sidebarAutoOriginEntry = (sessionId, rootId, address, tabId) => ({
    sessionId,
    rootSessionId: rootId,
    address,
    tabId: typeof tabId === "string" && tabId.length > 0 ? tabId : null,
    /**
     * 写入时刻：**只有占位**（tabId === null，「打开已发出、落地证据还没到」）用它判 TTL，
     * 见 SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS 与 sweepAutoOpenPlaceholders。
     * 落地条目（tabId 非 null）不使用它：那条生命周期由既有收口路径负责（verified-closed /
     * inventory-absent / tab-recycled / resource-running），比 TTL 精确得多，绝不能被 TTL 顺手回收。
     */
    writtenAt: Date.now(),
  });

  /** 读一条来源账本条目绑定的 tabId：缺失 / 畸形一律 null（调用方必须按「不是我们的 tab」处理）。 */
  const sidebarAutoOriginTabIdOf = (entry) => {
    if (entry === null || entry === undefined || typeof entry !== "object") return null;
    return typeof entry.tabId === "string" && entry.tabId.length > 0 ? entry.tabId : null;
  };

  /** 读一条来源账本条目的写入时刻：缺失 / 畸形一律 0（按「最旧」处理，优先回收）。 */
  const sidebarAutoOriginWrittenAtOf = (entry) => {
    if (entry === null || entry === undefined || typeof entry !== "object") return 0;
    const value = Number(entry.writtenAt);
    return Number.isFinite(value) ? value : 0;
  };

  /**
   * 写一条诊断（环形、有界、失败静默）。
   *
   * 结构：{ t, kind, event?, action?, verdict?, reason?, key?, origin?, reused?, degraded?, sizes? }，
   * key 一律是摘要（sidebarAutoKeyDigest），绝不含原文；单条 JSON 超过硬上限时先丢 sizes 再整体丢弃。
   */
  const recordSidebarAutoDiag = (entry) => {
    try {
      const storage = sidebarLocalStorage();
      if (storage === null) return;
      const source = entry !== null && typeof entry === "object" ? entry : {};
      const normalized = { t: Date.now() };
      for (const field of ["kind", "event", "action", "verdict", "reason", "key", "origin"]) {
        const value = sidebarBoundedText(source[field]);
        if (value !== undefined) normalized[field] = value;
      }
      if (source.reused === true) normalized.reused = true;
      if (source.degraded === true) normalized.degraded = true;
      if (source.sizes !== null && typeof source.sizes === "object") {
        const sizes = {};
        for (const name of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
          const value = Number(source.sizes[name]);
          if (Number.isFinite(value) === true) sizes[name] = Math.max(0, Math.trunc(value));
        }
        normalized.sizes = sizes;
      }
      let serialized = JSON.stringify(normalized);
      if (serialized.length > SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS) {
        delete normalized.sizes;
        serialized = JSON.stringify(normalized);
      }
      if (serialized.length > SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS) return;
      let list = [];
      const raw = storage.getItem(SIDEBAR_AUTO_DIAG_KEY);
      if (typeof raw === "string" && raw.length > 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) === true) list = parsed.slice(-SIDEBAR_AUTO_DIAG_LIMIT);
      }
      list.push(JSON.parse(serialized));
      storage.setItem(SIDEBAR_AUTO_DIAG_KEY, JSON.stringify(list.slice(-SIDEBAR_AUTO_DIAG_LIMIT)));
    } catch {
      /* 诊断只服务排查：任何失败都静默，绝不阻断功能。 */
    }
  };

  /** 新建一份共享 Auto 账本（八份 Map + 必要元数据）。 */
  const createSidebarSharedAutoLedger = () => {
    const ledger = { version: SIDEBAR_SHARED_AUTO_LEDGER_VERSION, createdAt: Date.now() };
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) ledger[field] = new Map();
    return ledger;
  };

  /**
   * 鸭子类型校验：只认「版本一致 + 八份 Map 都在」的账本，避免跨 realm / 旧格式的脏值被复用。
   * 不用 instanceof：测试替身与 vm realm 里的 Map 不共享构造函数。
   */
  const isSidebarSharedAutoLedger = (value) => {
    if (value === null || typeof value !== "object") return false;
    if (value.version !== SIDEBAR_SHARED_AUTO_LEDGER_VERSION) return false;
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
      const map = value[field];
      if (map === null || typeof map !== "object" || typeof map.get !== "function" || typeof map.set !== "function") return false;
    }
    return true;
  };

  /** 各 Map 规模的只读快照（诊断用；缺失字段按 0 计）。 */
  const sidebarSharedAutoLedgerSizes = (ledger) => {
    const sizes = {};
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
      const map = ledger === null || ledger === undefined ? null : ledger[field];
      sizes[field] = map !== null && typeof map === "object" && Number.isFinite(Number(map.size)) ? Number(map.size) : 0;
    }
    return sizes;
  };

  const sidebarSharedAutoLedgerTotal = (ledger) => {
    const sizes = sidebarSharedAutoLedgerSizes(ledger);
    let total = 0;
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) total += sizes[field];
    return total;
  };

  /**
   * 取本 realm 的共享 Auto 账本：命中即复用（reused=true），否则新建并写回 realm 槽位。
   *
   * 写回失败（globalThis 被冻结 / 受限）时只返回这一份新账本，绝不抛错：行为退回「每次执行各自
   * new Map」的旧语义，功能可用性不受影响。
   */
  const resolveSidebarSharedAutoLedger = () => {
    const host = sidebarRealmHost();
    let existing = null;
    if (host !== null) {
      try { existing = host[SIDEBAR_SHARED_AUTO_LEDGER_KEY]; } catch { existing = null; }
    }
    if (isSidebarSharedAutoLedger(existing) === true) {
      return { ledger: existing, reused: true, degraded: false };
    }
    const created = createSidebarSharedAutoLedger();
    let degraded = host === null;
    if (host !== null) {
      try {
        Object.defineProperty(host, SIDEBAR_SHARED_AUTO_LEDGER_KEY, { value: created, configurable: true, writable: true });
      } catch {
        degraded = true;
      }
    }
    return { ledger: created, reused: false, degraded };
  };

  /**
   * 归属标记的内存索引（懒加载 + write-through）：命中 realm 槽位即复用，否则新建并写回。
   * 槽位不可用时返回 null——此时所有读写直接走 localStorage（仍然正确，只是每次都要解析）。
   */
  const sidebarOwnershipMemory = () => {
    const host = sidebarRealmHost();
    if (host === null) return null;
    try {
      const existing = host[SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY];
      if (existing !== null && typeof existing === "object" && existing.entries instanceof Map) return existing;
    } catch { return null; }
    try {
      const created = { entries: new Map(), loaded: false };
      Object.defineProperty(host, SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY, { value: created, configurable: true, writable: true });
      return created;
    } catch {
      return null;
    }
  };

  /**
   * 把持久条目数组整理成 Map：只做两件「数据卫生」的事——丢掉 TTL 过期条目、同一 key 去重
   * （manual 优先）。
   *
   * **这里刻意不做任何按上限的 LRU 淘汰**（缺陷 2）：条目描述的 owner 在载入这一刻完全可能仍然
   * 有效（宿主里那个 tab 还开着，只是插件这一帧还没有 inventory 证据），LRU 淘汰它们等于永久丢掉
   * 一批仍然打开的 Auto owner——它们再也不会被自动收回，刷新也不能恢复。容量改由**写入路径**
   * 分账 fail-closed 控制：新增 auto 条目在满额时被拒绝，manual 条目照常写入（见
   * writeSidebarAutoOwnership / sidebarOwnershipAcceptsNewAuto）。
   */
  const normalizeSidebarOwnershipEntries = (raw, now) => {
    const entries = new Map();
    if (Array.isArray(raw) !== true) return entries;
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const key = typeof item.key === "string" ? item.key : null;
      if (key === null) continue;
      const updatedAt = Number(item.updatedAt);
      if (Number.isFinite(updatedAt) !== true || now - updatedAt > SIDEBAR_AUTO_OWNERSHIP_TTL_MS) continue;
      const origin = item.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const previous = entries.get(key);
      if (previous !== undefined && previous.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) continue;
      /**
       * tabId 是「写下这条归属的那一刻，宿主 inventory 里这个地址的 tab id」（缺省表示这次写入没有
       * 可证明的 tab）。只有 **auto** 条目在收养时会按它比对（见 recordSidebarTab 的 tabId 绑定闸门）：
       * 宿主重新 mint 了新 id 就说明这条条目描述的那个 tab 已经不存在，此时宁可退化成 manual
       * （漏收一次、留给用户手动处理），也绝不让 Auto 去关一个可能是用户自己刚打开的 tab。
       */
      entries.delete(key);
      entries.set(key, {
        key,
        origin,
        updatedAt,
        reason: sidebarBoundedText(item.reason),
        tabId: sidebarBoundedText(item.tabId),
      });
    }
    return entries;
  };

  /** 读取（必要时从 localStorage 懒加载）归属索引；两处都不可用时返回空的临时索引。 */
  const sidebarOwnershipEntries = () => {
    const memory = sidebarOwnershipMemory();
    if (memory === null) {
      const storage = sidebarLocalStorage();
      if (storage === null) return new Map();
      try {
        const raw = storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
        return normalizeSidebarOwnershipEntries(raw === null || raw.length === 0 ? [] : JSON.parse(raw), Date.now());
      } catch {
        return new Map();
      }
    }
    if (memory.loaded !== true) {
      memory.loaded = true;
      const storage = sidebarLocalStorage();
      if (storage !== null) {
        try {
          const raw = storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
          memory.entries = normalizeSidebarOwnershipEntries(raw === null || raw.length === 0 ? [] : JSON.parse(raw), Date.now());
        } catch {
          memory.entries = new Map();
        }
      }
    }
    return memory.entries;
  };

  /** 把索引写回 localStorage（失败 / 不可用一律静默：内存仍然一致，只是不持久）。 */
  const persistSidebarOwnership = (entries) => {
    const storage = sidebarLocalStorage();
    if (storage === null) return false;
    try {
      const list = [];
      for (const entry of entries.values()) {
        const item = { key: entry.key, origin: entry.origin, updatedAt: entry.updatedAt };
        if (entry.reason !== undefined) item.reason = entry.reason;
        // tabId 必须随条目一起持久化：整页刷新之后它是唯一能证明「这条 auto 归属描述的是哪个 tab」的证据。
        if (entry.tabId !== undefined) item.tabId = entry.tabId;
        list.push(item);
      }
      storage.setItem(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 读一个地址的持久归属：返回 { origin, tabId }，没有标记时返回 null。
   *
   * - origin 命中 manual 一律 manual（安全侧），命中 auto 才 auto；
   * - tabId 是写入那一刻宿主 inventory 里这个地址的 tab id（没有可证明的 tab 时为 null）；
   *   只有 auto 条目会被调用方按它比对，manual 条目只按 origin 判定。
   *
   * 读取本身绝不修改任何状态，失败一律当作「没有标记」（调用方按 manual 兜底）。
   * options.quiet === true 时连诊断也不写：调用点可能是每轮同步都会跑的判据（自动打开候选、
   * 空闲资源的抑制清除扫描），它们的结论由各自的决策 / 删除诊断承担，不该把有界诊断环挤满。
   */
  const readSidebarAutoOwnershipEntry = (sessionId, rootId, address, options) => {
    try {
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const entry = sidebarOwnershipEntries().get(key);
      const origin = entry === undefined
        ? null
        : (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO);
      if (options === null || options === undefined || options.quiet !== true) {
        recordSidebarAutoDiag({ kind: "ownership", event: "hit", origin, key: sidebarAutoKeyDigest(key) });
      }
      if (entry === undefined) return null;
      return {
        origin,
        tabId: typeof entry.tabId === "string" && entry.tabId.length > 0 ? entry.tabId : null,
      };
    } catch {
      return null;
    }
  };

  /** 持久表里的 auto 条目数（容量只对 auto 计账：manual 是用户意图，恒优先、从不被容量拒绝）。 */
  const sidebarOwnershipAutoCount = (entries) => {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO) count += 1;
    }
    return count;
  };

  /**
   * 持久表是否还容得下这个地址的一条 **auto** 归属（fail-closed 容量判据，缺陷 2）。
   *
   * 判据只有一条：写入之后 auto 条目数不得超过 SIDEBAR_AUTO_OWNERSHIP_LIMIT。**绝不为了腾位而
   * 淘汰任何已有条目**——持久表里的 auto 条目描述的 owner 在本帧完全可能仍然有效（宿主里那个 tab
   * 还开着），LRU（或任何「看起来更旧」的排序）淘汰它同样会让那个 tab 永久失去 Auto 归属，刷新
   * 也不能恢复。
   *
   * manual 条目不参与这里的容量判定：它表达用户意图，写入 / 改写一律照常（手动恒优先）。因此本
   * 函数回答的是「新增/改写一条 auto 条目能不能被保留」，而不是「表里总共有多少条」。
   *
   * 读取失败（localStorage 不可用 / 抛错）按「容得下」处理：内存账本仍然守着同一份容量，持久层
   * 只是「刷新之后的记忆」，读不到它不该让自动打开整体失效（与既有的静默降级一致）。
   */
  const sidebarOwnershipAcceptsNewAuto = (sessionId, rootId, address) => {
    try {
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const existing = entries.get(key);
      const existingIsAuto = existing !== undefined && existing.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const nextAutoCount = sidebarOwnershipAutoCount(entries) - (existingIsAuto ? 1 : 0) + 1;
      return nextAutoCount <= SIDEBAR_AUTO_OWNERSHIP_LIMIT;
    } catch {
      return true;
    }
  };

  /**
   * 写入归属标记（内存与 localStorage 同一处收口）并记一条诊断；返回是否真的写进去了。
   *
   * tabId 只在**调用方真的读到了宿主 inventory 里这个地址的 tab** 时才传（当前唯一的 auto 调用点
   * 是 recordSidebarTab）：它把这条归属绑定到具体的 tab 上，刷新之后的收养必须靠它证明「还是同一个
   * tab」（见 recordSidebarTab 的 tabId 绑定闸门）。manual 条目不需要它，传 undefined 即可。
   *
   * 容量 fail-closed（缺陷 2）：会挤掉仍有效 owner 的新增 / 改写（即写入之后 auto 条目数超过上限）
   * **一律拒绝**，并留下一条 reject/capacity 诊断。manual 写入从不被容量拒绝——但同样绝不为了腾位
   * 去淘汰任何已有条目，因此持久表最多是「上限条 auto + 用户自己产生的 manual 条目」。
   * 到达上限是可用性代价而不是错误：那个资源不自动打开，用户仍然可以手动打开（手动打开照常写
   * manual 归属，见 handleSidebarAction 的入口写入）。
   */
  const writeSidebarAutoOwnership = (sessionId, rootId, address, origin, reason, tabId) => {
    try {
      const normalizedOrigin = origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      if (normalizedOrigin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
        && sidebarOwnershipAcceptsNewAuto(sessionId, rootId, address) !== true) {
        recordSidebarAutoDiag({ kind: "ownership", event: "reject", origin: normalizedOrigin, reason: "capacity", key: sidebarAutoKeyDigest(key) });
        return false;
      }
      entries.delete(key);
      entries.set(key, {
        key,
        origin: normalizedOrigin,
        updatedAt: Date.now(),
        reason: sidebarBoundedText(reason),
        tabId: sidebarBoundedText(tabId),
      });
      persistSidebarOwnership(entries);
      recordSidebarAutoDiag({ kind: "ownership", event: "write", origin: normalizedOrigin, reason, key: sidebarAutoKeyDigest(key) });
      return true;
    } catch {
      /* 归属标记只影响「刷新之后还认不认」，任何失败都静默。 */
      return false;
    }
  };

  /**
   * 删除归属标记（与写入同源：内存删掉后立刻落盘）。
   *
   * 默认**拒绝**删除 manual 条目：manual 是用户的手动意图（手动关闭 / 手动打开），而调用这条删除的
   * 路径全是 Auto 自己的收口（verified-close / inventory-absent / tab-recycled / resource-running）。
   * 让 Auto 的收口顺手删掉用户的抑制，就等于「刷新之后用户的关闭又被撤销」——正是 P1-B 要堵的洞。
   * 因此这里只回答「Auto 自己的归属是否已经不需要了」，manual 条目一律保留并留一条 keep 诊断。
   *
   * options.manual === true 是唯一的例外：只有「观察到资源已经明确空闲（ready）」那条专用清点路径
   * 才允许清除 manual（见 clearManualSuppressionOfIdleResources），语义是「这一轮运行已经结束，
   * 用户当时的关闭意图不再需要跨运行保留」。
   */
  const deleteSidebarAutoOwnership = (sessionId, rootId, address, reason, options) => {
    try {
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const entry = entries.get(key);
      if (entry === undefined) {
        recordSidebarAutoDiag({ kind: "ownership", event: "delete-miss", reason, key: sidebarAutoKeyDigest(key) });
        return false;
      }
      if (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        && (options === null || options === undefined || options.manual !== true)) {
        recordSidebarAutoDiag({ kind: "ownership", event: "keep", origin: SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, reason, key: sidebarAutoKeyDigest(key) });
        return false;
      }
      entries.delete(key);
      persistSidebarOwnership(entries);
      recordSidebarAutoDiag({ kind: "ownership", event: "delete", reason, key: sidebarAutoKeyDigest(key) });
      return true;
    } catch {
      return false;
    }
  };

  /** 记录一次自动打开/自动关闭决策（候选 + 结算），失败原因只留截断后的一行。 */
  const recordSidebarAutoDecision = (event, candidate, verdict, reason) => {
    recordSidebarAutoDiag({
      kind: "decision",
      event,
      action: candidate === null || candidate === undefined ? undefined : candidate.kind,
      verdict,
      reason,
      key: candidate === null || candidate === undefined ? undefined : sidebarAutoKeyDigest(candidate.key),
    });
  };


  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, deleteSidebarAutoOwnership, readSidebarAutoOwnershipEntry,
    recordSidebarAutoDecision, recordSidebarAutoDiag, resolveSidebarSharedAutoLedger, sidebarAutoKeyDigest,
    sidebarAutoOriginEntry, sidebarAutoOriginTabIdOf, sidebarAutoOriginWrittenAtOf, sidebarBoundedText,
    sidebarLocalStorage, sidebarOwnershipAcceptsNewAuto, sidebarSharedAutoLedgerSizes, sidebarSharedAutoLedgerTotal,
    writeSidebarAutoOwnership,
  });
})(globalThis);
