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
  /**
   * **单 scope** 的 auto 归属上限（容量按 scope 分账）。
   *
   * 归属表里一条记录只对「写下它的那个 (sidebar session, root session)」有效，因此容量也只能按
   * scope 计账：旧实现按全表 auto 总数判定，16 个历史会话留下的 128 条 auto 条目会把任何**新**
   * 会话永久挡在门外（用户实测：Auto 开关是开的、候选也选出来了、每个候选都因容量/陈旧 manual
   * 被跳过）——这是一条跨会话死锁。
   */
  const SIDEBAR_AUTO_OWNERSHIP_LIMIT = 128;
  /**
   * 持久归属表的**全局**硬上限（4 × 单 scope 上限 = 512），只约束存储体积。
   *
   * 它不参与「能不能自动打开」的语义判定（那是上面按 scope 的那道判据）；只有当一次 auto 写入会让
   * 全表 auto 条目数超过本上限时，才先按 updatedAt 从旧到新淘汰**别的 scope** 的 auto 条目来腾位。
   * manual 条目是用户意图，**永不被淘汰**；当前 scope 的条目同样一条都不许淘汰。
   */
  const SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT = 4 * SIDEBAR_AUTO_OWNERSHIP_LIMIT;
  /**
   * 单次写入最多淘汰 64 条别的 scope 的旧 auto 条目（有界工作量：一次写入绝不为了腾位扫完整张表）。
   * 上限直接写在 planSidebarOwnershipAutoWrite 里，避免再多一份只被引用一次的常量。
   */
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
   *
   * `unpersisted` 是同层的「本 realm 已写入内存、但**落盘失败**的 manual 复合键」集合：
   * 对账时这些 key 一律不采信持久层（fail-closed）。它比另开一个 Symbol 槽位少一次槽位解析，
   * 生命周期也与索引完全一致（同一个 realm 槽位，一起创建、一起被测试重置）。
   */
  const sidebarOwnershipMemory = () => {
    const host = sidebarRealmHost();
    if (host === null) return null;
    try {
      const existing = host[SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY];
      if (existing?.entries instanceof Map) return existing;
    } catch { return null; }
    try {
      const created = { entries: new Map(), loaded: false, unpersisted: new Set() };
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
      if (typeof item.key !== "string") continue;
      const key = item.key;
      const updatedAt = Number(item.updatedAt);
      if (!Number.isFinite(updatedAt) || now - updatedAt > SIDEBAR_AUTO_OWNERSHIP_TTL_MS) continue;
      const origin = item.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      if (entries.get(key)?.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) continue;
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

  /**
   * 从持久表构建一份归属索引。
   *
   * 三态契约（载入与对账共用这一份解析，避免第二套 JSON 口径）：null = 持久层不可读 / 解析失败
   * （调用方 fail-closed 或退回空索引）；空 Map = 持久层确实没有条目；否则是规范化后的条目索引。
   */
  const loadSidebarOwnershipEntries = () => {
    const storage = sidebarLocalStorage();
    if (storage === null) return null;
    try {
      const raw = storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) === true ? normalizeSidebarOwnershipEntries(parsed, Date.now()) : null;
    } catch {
      return null;
    }
  };

  /** 读取（必要时从 localStorage 懒加载）归属索引；两处都不可用时返回空的临时索引。 */
  const sidebarOwnershipEntries = () => {
    const memory = sidebarOwnershipMemory();
    if (memory === null) return loadSidebarOwnershipEntries();
    if (memory.loaded !== true) {
      memory.loaded = true;
      memory.entries = loadSidebarOwnershipEntries() ?? new Map();
    }
    return memory.entries;
  };

  /**
   * 把索引写回 localStorage（失败 / 不可用一律不抛错：内存仍然一致，只是不持久）。
   *
   * 失败必须留一条**有界**诊断（{kind:"ownership",event:"persist-failed"}）：归属写不进去时，
   * 刷新之后这条 owner 就消失了（tab 会永久漏收）。诊断环本身有界（60 条、单条 ≤360 字符），
   * 且绝不记录条目原文 / 地址 —— 只记「写失败了」这一个结论。
   */
  const persistSidebarOwnership = (entries) => {
    try {
      const storage = sidebarLocalStorage();
      if (storage === null) throw new Error("storage-unavailable");
      // 展开条目即可：reason / tabId 为 undefined 时 JSON.stringify 会省略该键，落盘形状与逐字段拷贝一致
      // （tabId 必须随条目一起持久化：整页刷新之后它是唯一能证明「这条 auto 归属描述的是哪个 tab」的证据）。
      const list = [];
      for (const entry of entries.values()) list.push({ ...entry });
      storage.setItem(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(list));
      // 全表已写出：此前任何「落盘失败」的 manual 都已被这次写入覆盖，标记随之清空。
      sidebarOwnershipMemory()?.unpersisted?.clear();
      return true;
    } catch {
      // 固定短码（不记异常原文 / 条目原文）：event 已足以区分「落盘失败」，reason 只说明写面被拒。
      recordSidebarAutoDiag({ kind: "ownership", event: "persist-failed", reason: "write-rejected" });
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
   * **内存 / 持久层对账（自愈 stale 内存）**：内存归属索引是 realm 级缓存（跨 HMR 复用），而持久
   * 表可能已被另一个 realm（旧 bundle 实例 / 别的标签页）改写。两者分叉时，内存里那条 manual 会把
   * 自动打开永久挡住——用户实测形状正是：持久表 128 条全是 auto、没有任何 manual，Auto 却对每个
   * 候选都记 persisted-manual 跳过。因此**只有内存命中 manual 时**才复核一次持久层：
   * - 持久层确实没有这条 key ⇒ 内存是 stale 的：删掉内存条目并按「没有标记」返回，同时留一条
   *   {kind:"ownership",event:"delete",reason:"stale-memory"} 诊断；
   * - 持久层有 ⇒ 按持久层的 origin / tabId 返回，并把内存条目修正到同源（下一轮不再复核）；
   * - 持久层不可读 / 解析失败 ⇒ fail-closed 继续按内存判定。
   * 读 auto 不走复核，避免每轮同步对每个候选都做一次全表解析。
   *
   * 读取本身绝不修改除「自愈那一条」以外的任何状态，失败一律当作「没有标记」（调用方按 manual 兜底）。
   * options.quiet === true 时连「命中」诊断也不写：调用点可能是每轮同步都会跑的判据（自动打开候选、
   * 空闲资源的抑制清除扫描），它们的结论由各自的决策 / 删除诊断承担。**但自愈删除是一次真实的
   * 状态变更**，不受 quiet 影响——判据的诊断会被判据本身替代，状态变更不会。
   */
  const readSidebarAutoOwnershipEntry = (sessionId, rootId, address, options) => {
    try {
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const entries = sidebarOwnershipEntries();
      let entry = entries.get(key);
      /**
       * 只有「已成功落盘的 manual」才允许被持久层对账：本 realm 落盘失败的 manual 一定不在表里，
       * 若照常对账就会被合法空表判成 stale 删掉（Auto 随即重开用户刚关掉的 tab，违背 P1-B）。
       */
      if (entry !== undefined && entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        && sidebarOwnershipMemory()?.unpersisted?.has(key) !== true) {
        // null = 持久层不可读（fail-closed 沿用内存判定）；Map 里没有这个 key = 持久层权威的「没有」。
        const persisted = loadSidebarOwnershipEntries();
        if (persisted !== null) {
          entry = persisted.get(key);
          entries.delete(key);
          // 自愈删除是真实状态变更：即使 quiet 也要留证据（quiet 只静音命中判据）。
          if (entry === undefined) recordSidebarAutoDiag({ kind: "ownership", event: "delete", reason: "stale-memory", key: sidebarAutoKeyDigest(key) });
          else entries.set(key, entry);
        }
      }
      // 条目的 origin 在写入 / 载入时已经归一为 AUTO 或 MANUAL，这里直接取用（无需二次归一）。
      const origin = entry === undefined ? null : entry.origin;
      if (options?.quiet !== true) {
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

  /**
   * 一次 auto 写入的容量计划：**判定 + 回收清单的唯一实现**（写路径与判据共用，杜绝两处分叉）。
   *
   * scope 前缀直接复用 sidebarAutoScopedKey(sessionId, rootId, "")，不另写拼接：容量分账与归属
   * 读写的键口径必须逐字同源，否则「按 scope 计账」会悄悄变成第二套键格式。
   *
   * 两道容量，缺一不可：
   * 1. **按 scope 记账**（本次修复）：只统计当前 scope（key 前缀 sessionId|rootId|）的 auto 条目，
   *    达到 SIDEBAR_AUTO_OWNERSHIP_LIMIT 才拒绝。旧实现按全表 auto 总数判定，于是 16 个旧会话留下的
   *    128 条 auto 条目会把任何新会话永久挡在门外（用户实测：Auto 开着、候选选出来了、每个候选都
   *    被跳过）——跨会话死锁。别的 scope 的条目**不再阻塞**当前 scope。
   * 2. **全局硬上限**（存储体积）：写入之后全表 auto 条目数不得超过
   *    SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT。超出时可以先按 updatedAt 从旧到新淘汰**别的 scope** 的
   *    auto 条目（单次最多 64 条）；淘汰之后仍然放不下才拒绝。
   *
   * 两条边界不可放宽：
   * - **当前 scope 的条目一条都不许淘汰**：它描述的是这个会话现在仍然有效的 owner，淘汰就是永久
   *   漏收（既有容量用例锁定：同 scope 满额必须 fail-closed 拒绝，绝不为了腾位丢 owner）；
   * - **manual 条目永不淘汰**：它表达用户意图，容量压力不该改写用户的选择。
   *
   * 返回值：null = 这次写入放不下（调用方 fail-closed 拒绝）；数组 = 需要先淘汰的键（空数组 = 不用
   * 淘汰）。manual 写入从不走本函数（手动恒优先、从不被容量拒绝）。
   */
  const planSidebarOwnershipAutoWrite = (entries, prefix, key) => {
    let scopeAuto = 0;
    let totalAuto = 0;
    const others = [];
    for (const [entryKey, entry] of entries) {
      if (entry.origin !== SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO) continue;
      totalAuto += 1;
      if (entryKey.startsWith(prefix)) scopeAuto += 1;
      else others.push([entryKey, entry.updatedAt]);
    }
    const existingIsAuto = entries.get(key)?.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO ? 1 : 0;
    if (scopeAuto - existingIsAuto + 1 > SIDEBAR_AUTO_OWNERSHIP_LIMIT) return null;
    const overflow = totalAuto - existingIsAuto + 1 - SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT;
    if (overflow <= 0) return [];
    if (overflow > 64) return null;
    others.sort((left, right) => left[1] - right[1]);
    return others.length < overflow ? null : others.slice(0, overflow).map(([entryKey]) => entryKey);
  };

  /**
   * 持久表是否还容得下这个地址的一条 **auto** 归属（fail-closed 容量判据）。
   *
   * 判据本体与回收清单都在 planSidebarOwnershipAutoWrite（唯一实现）；这里只回答「计划是否成立」。
   * 刻意不在这里执行淘汰：判据必须是只读的（调用点每轮同步都会跑）。
   *
   * 读取失败（localStorage 不可用 / 抛错）按「容得下」处理：内存账本仍然守着同一份容量，持久层
   * 只是「刷新之后的记忆」，读不到它不该让自动打开整体失效（与既有的静默降级一致）。
   */
  const sidebarOwnershipAcceptsNewAuto = (sessionId, rootId, address) => {
    try {
      return planSidebarOwnershipAutoWrite(sidebarOwnershipEntries(), sidebarAutoScopedKey(sessionId, rootId, ""), sidebarAutoScopedKey(sessionId, rootId, address)) !== null;
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
   * **一律拒绝**，并留下一条 reject/capacity 诊断。manual 写入从不被容量拒绝，也绝不会为了腾位去
   * 淘汰任何已有条目。auto 写入只在**全局硬上限**被突破时才回收别的 scope 的旧 auto 条目（回收
   * 清单与判据同源，见 planSidebarOwnershipAutoWrite）；当前 scope 的条目与 manual 条目一条都不淘汰，
   * 因此持久表最多是「每个 scope 上限条 auto + 用户自己产生的 manual 条目」。
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
      /**
       * 只有 auto 写入要过容量闸门：manual 是用户意图，恒优先、从不被容量拒绝（也绝不为了腾位淘汰
       * 任何条目）。capacity 计划同时给出「放不放得下」与「要回收哪些别的 scope 的旧 auto 条目」。
       */
      const plan = normalizedOrigin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
        ? planSidebarOwnershipAutoWrite(entries, sidebarAutoScopedKey(sessionId, rootId, ""), key)
        : [];
      if (plan === null) {
        recordSidebarAutoDiag({ kind: "ownership", event: "reject", origin: normalizedOrigin, reason: "capacity", key: sidebarAutoKeyDigest(key) });
        return false;
      }
      for (const evictedKey of plan) entries.delete(evictedKey);
      entries.delete(key);
      entries.set(key, {
        key,
        origin: normalizedOrigin,
        updatedAt: Date.now(),
        reason: sidebarBoundedText(reason),
        tabId: sidebarBoundedText(tabId),
      });
      if (persistSidebarOwnership(entries) !== true && normalizedOrigin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) {
        // 懒建集合：HMR 从旧 bundle 复用过来的 realm 索引槽位可能还没有 unpersisted 字段。
        const memory = sidebarOwnershipMemory();
        if (memory !== null) (memory.unpersisted ??= new Set()).add(key);
      }
      /**
       * 淘汰证据**聚合**在这条既有写入诊断上（degraded=true = 为了放下这条 auto 回收过别的 scope 的
       * 旧 auto 条目）：逐条淘汰各写一条会一次刷满 60 条的有界诊断环，收益远低于代价。字段只用
       * recordSidebarAutoDiag 的既有白名单（degraded 是布尔标记，计数不进协议）。
       */
      recordSidebarAutoDiag({ kind: "ownership", event: "write", origin: normalizedOrigin, reason, key: sidebarAutoKeyDigest(key), degraded: plan.length > 0 });
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
      if (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL && options?.manual !== true) {
        recordSidebarAutoDiag({ kind: "ownership", event: "keep", origin: SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, reason, key: sidebarAutoKeyDigest(key) });
        return false;
      }
      entries.delete(key);
      persistSidebarOwnership(entries);
      sidebarOwnershipMemory()?.unpersisted?.delete(key);
      recordSidebarAutoDiag({ kind: "ownership", event: "delete", reason, key: sidebarAutoKeyDigest(key) });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 清除某个 scope 的全部 manual 归属（标题栏 Auto 由关→开 = 重新授权自动打开）。
   *
   * 语义边界（逐条固定，不可放宽）：
   * - 只删**当前 scope**（key 前缀 sessionId|rootId|）里 origin=manual 的条目；别的 scope 的 manual
   *   条目一条都不动（那是别的会话的用户意图）；
   * - 当前 scope 的 auto 条目一条都不动（那是仍然有效的 owner，删掉就是永久漏收）；
   * - 返回删除条数；0 条时不落盘（没有变化就不制造写放大）。
   *
   * 为什么需要这条确定性路径：manual 归属是跨刷新的用户意图，既有实现里只有「资源明确空闲」那一条
   * 清点路径会清它。用户手动关闭过某个子代理之后，那个抑制会一直带到下一次运行，于是即使重新打开
   * Auto 也不会恢复自动打开（用户实测形状）。标题栏 Auto 由关→开是一次明确的重新授权，必须能直接
   * 解除本 scope 的抑制，而不是等资源恰好回到 ready。
   */
  const clearSidebarAutoManualSuppressions = (sessionId, rootId) => {
    try {
      const entries = sidebarOwnershipEntries();
      const prefix = sidebarAutoScopedKey(sessionId, rootId, "");
      const keys = [...entries]
        .filter(([key, entry]) => entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL && key.startsWith(prefix))
        .map(([key]) => key);
      for (const key of keys) {
        entries.delete(key);
        sidebarOwnershipMemory()?.unpersisted?.delete(key);
      }
      if (keys.length > 0) persistSidebarOwnership(entries);
      return keys.length;
    } catch {
      return 0;
    }
  };

  /** 记录一次自动打开/自动关闭决策（候选 + 结算），失败原因只留截断后的一行。 */
  const recordSidebarAutoDecision = (event, candidate, verdict, reason) => {
    recordSidebarAutoDiag({
      kind: "decision",
      event,
      action: candidate?.kind,
      verdict,
      reason,
      key: candidate == null ? undefined : sidebarAutoKeyDigest(candidate.key),
    });
  };


  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, clearSidebarAutoManualSuppressions,
    deleteSidebarAutoOwnership, readSidebarAutoOwnershipEntry,
    recordSidebarAutoDecision, recordSidebarAutoDiag, resolveSidebarSharedAutoLedger, sidebarAutoKeyDigest,
    sidebarAutoOriginEntry, sidebarAutoOriginTabIdOf, sidebarAutoOriginWrittenAtOf, sidebarBoundedText,
    sidebarLocalStorage, sidebarOwnershipAcceptsNewAuto, sidebarSharedAutoLedgerSizes, sidebarSharedAutoLedgerTotal,
    writeSidebarAutoOwnership,
  });
})(globalThis);
