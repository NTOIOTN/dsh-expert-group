/**
 * Expert Group 快照的**两级缓存 owner**（票据 09 / R2 从 host/expert-group-runtime.js 拆出）。
 *
 * 状态所有权（规格书 §状态所有权(6)、plan R2.3）：`snapshotCache`、`snapshotInFlight`、每个条目
 * （entry / `building` / `generation`）、LRU 淘汰与 `sortAnchor` Map **只属于本模块**。
 *
 * 边界：
 * - 本模块**不 import** `host/expert-group-projection.js` 与 `host/expert-group-stage.js`：快照构建
 *   由 runtime 以**注入能力** `buildSnapshotForSession` 传入；构建时只把
 *   `sortAnchorFor(nodeId)`（**只读查询**）交给 builder，成功后又由**cache owner 自己**
 *   `rememberSortAnchor` 写回锚点。由此打断「runtime 侧 builder ↔ cache owner」的循环，同时
 *   不把 Map 传给 runtime / builder（plan R2.3 ④↔⑤）；
 * - 纯文本 helper（`nonEmpty` / `firstText` / `safeCall`）由 runtime 以冻结命令集合 `project` 注入，
 *   因此文件之间没有 import 边；
 * - 策略判定（新鲜度 / 宽限 / 可启动构建 / 失败退避 / 锚点）全部是**同文件 module-scope 无状态
 *   helper**，factory 本体因此守住 ≤400（plan R2.3）。
 *
 * 对外冻结面：`{ snapshotForSession, invalidateSnapshots, awaitFullBuild }`，与拆分前
 * `createExpertGroupRuntime` 返回的 surface 完全一致（不改 RPC、snapshot 字段或错误语义）。
 *
 * @module dsh-expert-group/host/snapshot-cache
 */

/**
 * 快照缓存按 root 的数量上限（**硬上限**）。
 *
 * 缓存值是一份完整快照（树规模随专家数增长），因此必须显式限制 root 数量；被淘汰的 root
 * 只是丢掉已有的权威结果，下一次请求会重新走「轻量返回 + 后台重建」，不会产生错误。
 * 取值 8：覆盖「用户来回切换若干个会话」的常见宽度，又让内存占用有明确上界。
 * 所有会创建条目的路径（含轻量构建返回 null、完整构建失败）都必须维护这个上限；
 * 淘汰是真正的 LRU（命中与写入都提权），避免活跃 root 被一次性查询挤掉后 full→fast→full 抖动。
 */
const SNAPSHOT_CACHE_LIMIT = 8;

/**
 * 轻量（partial）快照的兜底 TTL。
 *
 * 轻量快照只由事件挂点（invalidateSnapshots）与这个 TTL 决定新鲜度。它**必须与客户端轮询
 * 周期（2500ms）解耦**：若两者相等，严格 `<` 的新鲜度判定会让「恰好晚到一点」的下一次轮询
 * 落在过期之后，于是在完整快照就绪之前每次轮询都要重建一次轻量快照。
 * 取值 6000ms = 2.4× 轮询周期：即使连续两次轮询被合并或延迟（隐藏标签页恢复、通知触发的
 * 尾随刷新），缓存仍覆盖下一次轮询；代价只是「事件没到」时陈旧上界从 2.5s 放宽到 6s，
 * 而真正的状态变化由失效事件即时反映，不依赖这个兜底。
 */
const FAST_SNAPSHOT_TTL_MS = 6000;

/**
 * 完整（权威）快照的兜底 TTL。
 *
 * 完整快照重建的代价是每个冷 child 一次 `readSession`，因此不能被轮询无限放大；TTL 取 5s
 * （≤ 需求上限），其间由 invalidation 事件提供即时性：只要有可观察的状态变化就立刻重建。
 */
const FULL_SNAPSHOT_TTL_MS = 5000;

/**
 * 完整快照的**绝对**宽限上限：超过它就不再返回任何缓存的完整快照。
 *
 * 后台重建持续失败（上游存储故障）或 root 已被释放、持久化证据暂时消失时，继续返回任意旧的
 * 权威快照会让界面无限期停在错误状态；超过 4×TTL（20s）后改用轻量快照（它至少反映当前 DEG
 * 记录），连轻量也拿不到就回落到既有的「重新构建 / 404」契约（见 resolveSnapshotForSession）。
 */
const FULL_SNAPSHOT_GRACE_MS = 4 * FULL_SNAPSHOT_TTL_MS;

/**
 * 代次不一致（构建期间发生过失效）的完整快照还能兜底多久。
 *
 * 这类结果的内容是构建期间真实读到的，只是「读完到完成」之间又出现了可观察变化；当轻量路径
 * 拿不到任何存在性证据（fast 为 null）时，用它在**很短**的窗口内顶住比直接空屏更接近真实状态。
 * 窗口取 2×TTL（10s），且必须同时满足 FULL_SNAPSHOT_GRACE_MS 的绝对上限；它永远不会被当作
 * 「新鲜」或「只是过期」的权威结果返回。
 */
const FULL_SNAPSHOT_STALE_GRACE_MS = 2 * FULL_SNAPSHOT_TTL_MS;

/**
 * 因「构建期间发生过失效」而需要的重建，两次之间的最小间隔（去抖）。
 *
 * 构建开始时捕获代次、完成时若代次已变化则不作权威，这是正确性要求；但活跃会话里失效事件
 * 可能每几秒就来一次，若每个请求都立刻重跑全量冷读，就会退化成「每请求一次全量构建」。
 * 因此一次被判为非权威的构建之后，至少间隔一个完整 TTL（5s，与 FULL_SNAPSHOT_TTL_MS 同量级）
 * 才允许再次后台重建；这段时间由毫秒级的轻量快照承担展示。
 */
const STALE_REBUILD_MIN_INTERVAL_MS = FULL_SNAPSHOT_TTL_MS;

/**
 * 后台完整构建**失败**后的重试退避上限（R1）。
 *
 * 失败退避与上面的 STALE_REBUILD_MIN_INTERVAL_MS 是两条**互相独立**的闸门：
 * - STALE_REBUILD_MIN_INTERVAL_MS 处理「构建成功但期间发生过失效」，是去抖；
 * - 这里的失败退避处理「构建直接失败」（冷读报权限/存储错误、上游短暂不可用），是**指数退避**。
 *
 * 基数取 FULL_SNAPSHOT_TTL_MS（5s），第 n 次连续失败后等待 min(5s × 2^(n-1), 40s)：
 * 5s → 10s → 20s → 40s → 40s…。上限取 8×TTL（40s）：既让持续故障下的重试频率收敛到「每 40s
 * 一次全量冷读」，又保证上游恢复后最迟 40s 内能重新拿到权威快照（不会永远停在 partial）。
 * 任一次成功立即把退避级别清零。
 *
 * 失效事件**不**提前解除失败退避：失败反映的是上游冷读健康度，与「这份快照是否陈旧」正交；
 * 而活跃会话的失效事件可能每几秒就来一次，若用它放行重试，退避会被事件流完全绕过，退化成
 * 「每请求一次全量冷读」——正是 R1 要修的问题。展示层的即时性已由毫秒级轻量快照保证。
 */
const FULL_SNAPSHOT_RETRY_MAX_MS = 8 * FULL_SNAPSHOT_TTL_MS;

/**
 * 同时在飞的完整构建条目数量**安全上限**（R3）。
 *
 * SNAPSHOT_CACHE_LIMIT 只约束「非在飞」条目；在飞条目在构建结束前**不得**被淘汰，否则
 * awaitFullBuild 看不到该构建、后续请求会为同一 root 启动第二个构建（同一 root 同时只有一个
 * 构建的契约被破坏，且每个构建各自建立冷读协调器，跨 root 的实际 I/O 并发被放大）。
 * 这里额外给在飞条目一个安全上限，防止「大量陌生 root 同时构建」把缓存撑成无界增长：
 * 取 2×SNAPSHOT_CACHE_LIMIT（16）。正常情况下远达不到，只有异常增长（例如被大量不同 root
 * 的请求同时驱动）时才会退化为淘汰最久未用的在飞条目——这是有意的「有界优先」取舍。
 */
const SNAPSHOT_INFLIGHT_LIMIT = 2 * SNAPSHOT_CACHE_LIMIT;

// ── module-scope 无状态策略 helper（plan R2.3：factory 本体因此 ≤400） ────────

/**
 * 新条目的初值（每次调用返回**新对象**；条目本身仍由 cache factory 独占，本函数只是构造器）。
 *
 * sortAnchor 是**排序锚点**（修复 A）：节点 id → createdAt，只由完整构建成功写入，轻量构建
 * 用它给缺失的 createdAt 兜底，使同一节点在 partial / full 下拿到同一个排序键。锚点挂在条目上
 * ⇒ 与缓存条目同生命周期、按 rootId 天然隔离，条目被淘汰时锚点一起消失。
 */
function createCacheEntry() {
  return {
    full: null,
    fast: null,
    generation: 0,
    building: null,
    lastError: null,
    rebuildBlockedUntil: 0,
    // R1：连续失败次数与失败退避截止时刻（成功后清零，见 ensureFullBuild）。
    failureCount: 0,
    retryBlockedUntil: 0,
    // 修复 A：排序锚点（节点 id → createdAt），只由**完整构建成功**写入，供轻量构建补缺。
    sortAnchor: new Map(),
  };
}

/**
 * 某一级缓存是否新鲜：写入代次必须等于当前代次（其间没有失效事件），且未超过该级 TTL。
 *
 * 两级的代次都在**各自构建开始时**捕获（见 ensureFullBuild / resolveSnapshotForSession）：
 * 构建期间到达的失效事件会让这份结果落成「非当前权威」，绝不会被当成最新版返回。
 */
function isFresh(level, entry, timestamp, ttlMs) {
  if (level === null || level.generation !== entry.generation) return false;
  return timestamp - level.at < ttlMs;
}

/**
 * 上屏可用的完整快照（阻塞项 B2）。
 *
 * 任何返回缓存 full 的路径都必须同时满足两条约束：
 * ① 代次一致，或处于**明确的短宽限**内（FULL_SNAPSHOT_STALE_GRACE_MS）；
 * ② 未超过**绝对宽限上限**（FULL_SNAPSHOT_GRACE_MS）。
 * 超出上限一律返回 null，由调用方回落到轻量快照 / 既有的完整构建（可能得到 404），
 * 从而保证「root 被释放、持久化证据消失、上游持续失败」时不会无限期展示已失效的 root。
 */
function displayableFull(entry, timestamp) {
  if (entry.full === null) return null;
  const age = timestamp - entry.full.at;
  if (age >= FULL_SNAPSHOT_GRACE_MS) return null;
  if (entry.full.generation === entry.generation) return entry.full.snapshot;
  // 代次不一致：构建期间发生过失效，内容仍是那一次真实读取，只允许在很短的窗口内兜底。
  return age < FULL_SNAPSHOT_STALE_GRACE_MS ? entry.full.snapshot : null;
}

/**
 * 是否允许启动一次**新的**后台完整构建（两条独立的闸门）。
 *
 * 1. 失效去抖：上一次构建「成功但期间发生过失效」后，冷却 STALE_REBUILD_MIN_INTERVAL_MS；
 * 2. 失败退避（R1）：上一次构建直接失败后，按指数退避冷却 FULL_SNAPSHOT_RETRY_MAX_MS 封顶。
 *
 * 两个窗口内的请求继续由毫秒级的轻量快照承担展示，不再触发全量冷读；已有在飞构建时
 * ensureFullBuild 自身就会复用，因此这里只看冷却。失效事件**不**提前解除失败退避：失败反映
 * 的是上游冷读健康度，与「这份快照是否陈旧」正交，用事件放行会让退避被事件流完全绕过。
 */
function canStartFullBuild(entry, timestamp) {
  if (entry.building !== null) return true;
  return timestamp >= entry.rebuildBlockedUntil && timestamp >= entry.retryBlockedUntil;
}

/**
 * 连续失败 n 次后的重试退避时长（R1）：5s → 10s → 20s → 40s → 40s…（封顶 FULL_SNAPSHOT_RETRY_MAX_MS）。
 *
 * 纯函数：只吃失败次数，不读 entry，因此不构成第二个 owner。
 */
function failureBackoffMs(failureCount) {
  return Math.min(
    FULL_SNAPSHOT_TTL_MS * (2 ** Math.min(failureCount - 1, 16)),
    FULL_SNAPSHOT_RETRY_MAX_MS,
  );
}

/**
 * 从一份**完整**快照里提取排序锚点并写入该 root 的锚点 Map（修复 A）。
 *
 * 只记录 root.children 上**非空有限数值**的 createdAt（专家节点与 fan-out 父任务都在这一层，
 * 分片/attempt 不参与顶层排序，无需记录）。已有锚点不被空值覆盖：某次完整构建若因为上游暂时
 * 读不到时间而给出 null，不应把已知的好锚点抹掉。整段读取 fail-soft：快照形状异常时静默跳过，
 * 绝不影响完整构建本身的成功返回。
 *
 * 入参是 cache owner **局部持有**的 sortAnchor Map；本函数只是无状态策略 helper（不持有它），
 * 调用点固定在 ensureFullBuild 的成功分支里，因此 owner 唯一。
 */
function rememberSortAnchor(sortAnchor, snapshot) {
  if (!(sortAnchor instanceof Map)) return;
  let children;
  try {
    children = snapshot?.root?.children;
  } catch {
    return;
  }
  if (!Array.isArray(children)) return;
  for (const node of children) {
    if (node === null || typeof node !== "object") continue;
    const createdAt = node.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
    const key = firstTextOf(node.id, node.parentTaskId, node.sessionId, node.childId);
    if (key !== null) sortAnchor.set(key, createdAt);
  }
}

/**
 * 把「节点 id → createdAt」的查询做成**只读命令**交给 builder（plan R2.3）。
 *
 * builder 只拿到 `sortAnchorFor(nodeId)`，拿不到 Map 本身：既读不到条目、也写不了锚点；
 * 锚点的写入永远发生在 cache owner 自己的成功分支里。
 */
function createSortAnchorQuery(entry) {
  return (nodeId) => {
    const anchored = entry.sortAnchor.get(nodeId);
    return typeof anchored === "number" && Number.isFinite(anchored) ? anchored : undefined;
  };
}

/**
 * 节点身份键：与快照层（expert-group-snapshot.js 的排序）一致。
 *
 * 专家节点的 id 就是 childId/sessionId，fan-out 父任务节点的 id 由 parentTaskId 派生
 * （原始 manager 任务对象上没有 id 字段，因此按同一优先级回退）。
 * 局部实现（cache 不 import projection，避免新增 import 边）。
 */
function firstTextOf(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * 按 root 的两级快照缓存（轻量 / 完整）。
 *
 * 结构：rootId → { full, fast, generation, building, lastError, rebuildBlockedUntil,
 *                    failureCount, retryBlockedUntil, sortAnchor }
 * - full/fast：{ snapshot, at, generation }。generation 是**该次构建开始时**捕获的代次，
 *   用来判定「这份结果读完之后有没有发生失效事件」，时间戳只用来兜底 TTL；
 *   **at 只在真正构建出该级结果时写入，命中缓存绝不刷新**（R2）：否则持续轮询会把 6s 的
 *   陈旧上界退化成「滑动空闲 TTL」，一旦失效事件被漏掉，同一份 partial 就能无限期复用；
 * - generation：每次 invalidateSnapshots 命中该 root 时递增。失效**不删除**已缓存的快照：它只
 *   表示「这份结果可能已经不代表当前状态」。因此失效后的下一个请求会同步构建一份新的轻量快照
 *   （毫秒级），保证状态变化立刻可见；而「只是过期、没有失效事件」时继续返回上一份权威快照
 *   （不降级），避免界面在 full ↔ fast 之间抖动；
 * - building：该 root 正在进行的完整构建（同一 root 同时只允许一个）；
 * - lastError：最近一次后台完整构建的错误对象，供 awaitFullBuild（测试/诊断）原样观察；
 * - rebuildBlockedUntil：因「构建期间发生过失效」而需要的重建的最早启动时刻（去抖），
 *   保证活跃会话下不会退化成「每个请求一次全量冷读」；
 * - failureCount / retryBlockedUntil：后台完整构建**连续失败**次数与失败重试的最早启动时刻
 *   （R1 的指数退避，与上面的失效去抖是两条独立闸门；成功后立即清零）；
 * - sortAnchor：节点 id → createdAt 的**排序锚点**（修复 A），见 createCacheEntry。
 *
 * 容量契约（R3）：
 * - **非在飞**条目受 SNAPSHOT_CACHE_LIMIT（8）约束，这是「缓存结果」的硬上限；
 * - **在飞**（building !== null）条目在构建结束前**不得**被淘汰：淘汰它会让 awaitFullBuild
 *   看不到该构建、后续请求为同一 root 再起一个构建，破坏「同一 root 同时只有一个构建」；
 * - 在飞条目另有独立安全上限 SNAPSHOT_INFLIGHT_LIMIT（16），防止异常增长把缓存撑成无界；
 * - 因此条目总数上界是 8 + 16 = 24。
 * 顺序是真正的 LRU——命中与写入都会把条目提到队尾，因此活跃 root 不会被一次性查询挤掉。
 *
 * @param {object} dependencies
 * @param {Function} dependencies.buildSnapshotForSession - 注入能力：
 *   `(sessionId, { fast, sortAnchorFor }) => Promise<object|null>`。
 * @param {Function} dependencies.now - 单调时钟读数（毫秒）。
 * @param {object} [dependencies.logger] - 可选：`{warn}` 宿主日志出口。
 * @param {Map} dependencies.recoveryRecords - recovery 记录（失效判定用，只读）。
 * @param {Function} dependencies.persistedChildren - child_models 的只读读面。
 * @param {object} dependencies.project - 冻结的纯文本命令集合（nonEmpty / firstText / safeCall）。
 * @returns {Readonly<{snapshotForSession:Function, invalidateSnapshots:Function, awaitFullBuild:Function}>}
 */
export function createSnapshotCache({
  buildSnapshotForSession,
  now = Date.now,
  logger = null,
  recoveryRecords,
  persistedChildren,
  project,
} = {}) {
  if (typeof buildSnapshotForSession !== "function") throw new TypeError("Expert Group 快照缓存需要 buildSnapshotForSession 能力");
  if (typeof now !== "function") throw new TypeError("Expert Group 快照缓存需要 now 函数");
  if (!(recoveryRecords instanceof Map)) throw new TypeError("Expert Group 快照缓存需要 recoveryRecords Map");
  const { nonEmpty, firstText } = project;

  // root 与 child surface 可能同时请求同一份树；只合并重叠的构建期。首屏请求不再等待完整
  // 构建，因此表项仍按「请求期」存在：完成后删除，只保留下面按 root 的两级结果缓存。
  const snapshotInFlight = new Map();
  const snapshotCache = new Map();

  /** 把条目提到 LRU 队尾（Map 的插入顺序即 LRU 顺序：队首最久未使用）。 */
  function touchEntry(rootId) {
    const entry = snapshotCache.get(rootId);
    if (entry === undefined) return;
    snapshotCache.delete(rootId);
    snapshotCache.set(rootId, entry);
  }

  function cacheEntry(rootId) {
    const existing = snapshotCache.get(rootId);
    if (existing !== undefined) {
      // 命中即提权：正在被轮询/观察的 root 不会被别的会话的一次性查询挤掉。
      touchEntry(rootId);
      return existing;
    }
    const entry = createCacheEntry();
    snapshotCache.set(rootId, entry);
    // 创建路径同样维护硬上限：「轻量返回 null」「完整构建失败」这些不写结果的路径也会留下
    // 条目，容量不能只靠成功写入那一条路径收敛。
    evictSnapshots(rootId);
    return entry;
  }

  /**
   * 把缓存收敛到容量契约（R3）：非在飞条目 ≤ SNAPSHOT_CACHE_LIMIT，在飞条目 ≤ SNAPSHOT_INFLIGHT_LIMIT。
   *
   * 淘汰顺序（按 Map 的插入顺序 = LRU 顺序，队首最久未使用）：
   * 1. 先淘汰**非在飞**条目，直到非在飞数量回到 SNAPSHOT_CACHE_LIMIT；
   * 2. 只有在飞条目本身超过安全上限时，才按 LRU 淘汰最久未用的在飞条目。
   *
   * 关键不变量：在飞条目**不会**因为非在飞条目超限而被淘汰。淘汰一个在飞条目会让
   * awaitFullBuild 看不到该构建、后续请求为同一 root 启动第二个构建（同一 root 同时只有一个构建
   * 的契约被破坏，且每个构建各自建立冷读协调器，跨 root 的实际 I/O 并发被放大）。
   * keepRootId 是刚刚创建/正在写入的 root，任何一轮都不淘汰它，避免「刚建好就被自己挤掉」。
   */
  function evictSnapshots(keepRootId = null) {
    const idleLimit = SNAPSHOT_CACHE_LIMIT;
    const inflightLimit = SNAPSHOT_INFLIGHT_LIMIT;
    // 先数一遍在飞数量：后面两轮都要用到，避免每淘汰一个就重扫全表。
    let inflight = 0;
    for (const entry of snapshotCache.values()) {
      if (entry.building !== null) inflight += 1;
    }
    let idle = snapshotCache.size - inflight;
    if (idle <= idleLimit && inflight <= inflightLimit) return;
    for (const [rootId, entry] of snapshotCache) {
      if (idle <= idleLimit) break;
      if (rootId === keepRootId) continue;
      if (entry.building !== null) continue;
      snapshotCache.delete(rootId);
      idle -= 1;
    }
    // 在飞条目只在超过**自己的**安全上限时才淘汰（异常增长的兜底，正常路径不会触发）。
    if (inflight <= inflightLimit) return;
    for (const [rootId, entry] of snapshotCache) {
      if (inflight <= inflightLimit) return;
      if (rootId === keepRootId) continue;
      if (entry.building === null) continue;
      snapshotCache.delete(rootId);
      inflight -= 1;
    }
  }

  /**
   * 幂等地启动该 root 的后台完整构建。
   *
   * - 已有在飞构建时直接复用同一个 promise（同一 root 同时只有一个 readSession 批次）；
   * - **构建开始时**捕获代次并随结果写入缓存（阻塞项 B1）：构建期间到达的失效事件因此会体现在
   *   「写入代次 ≠ 当前代次」上，该结果不会被标记成当前权威，最多只在
   *   FULL_SNAPSHOT_STALE_GRACE_MS 的短宽限内兜底；
   * - 一次被判为非权威的构建之后，间隔 STALE_REBUILD_MIN_INTERVAL_MS 才允许再次后台重建
   *   （去抖）：否则活跃会话里每次失效都会立刻重跑全量冷读，退化成「每请求一次全量构建」；
   * - 成功后写入 full 缓存并记录写入时刻与代次；失败时记录 lastError 并写一条宿主日志
   *   （完整构建不再阻塞请求，因此错误只能从这里暴露）；两条路径都维护缓存硬上限；
   * - 返回值可能是 rejected promise：调用方要么 await 它（「无法证明 root 存在」的回落路径，
   *   需要原样抛出错误），要么像普通请求路径那样忽略它。内部已挂了一个 catch 处理器，
   *   所以忽略也不会产生未处理的 rejection。
   */
  function ensureFullBuild(rootId) {
    const entry = cacheEntry(rootId);
    if (entry.building !== null) return entry.building;
    entry.lastError = null;
    // 代次在构建**开始**时捕获：完成时不再读取 entry.generation。
    const buildGeneration = entry.generation;
    const settled = buildSnapshotForSession(rootId, { fast: false }).then(
      (snapshot) => {
        entry.full = { snapshot, at: now(), generation: buildGeneration };
        // 修复 A：完整快照是权威的 createdAt 来源，构建成功后把 id → createdAt 记成锚点，
        // 供后续轻量快照补齐同一个排序键。只记录非空有限数值；空值不覆盖已有锚点。
        // 写入点固定在 cache owner 里（builder 只拿到只读查询，拿不到 Map）。
        rememberSortAnchor(entry.sortAnchor, snapshot);
        // 成功即重置失败退避（R1）：下一次失败重新从基数开始，不会因为历史失败次数被长期拖慢。
        entry.failureCount = 0;
        entry.retryBlockedUntil = 0;
        // 构建期间发生过失效：这份结果不是当前权威。除「写入代次 ≠ 当前代次」之外，还要显式
        // 记下一条宿主日志，并推迟下一次重建，避免活跃会话下被失效事件驱动成每请求全量冷读。
        if (buildGeneration !== entry.generation) {
          entry.rebuildBlockedUntil = now() + STALE_REBUILD_MIN_INTERVAL_MS;
          logStaleBuild(rootId);
        }
        if (entry.building === settled) entry.building = null;
        touchEntry(rootId);
        evictSnapshots(rootId);
        return snapshot;
      },
      (error) => {
        entry.lastError = error;
        // 失败退避（R1）：连续失败按 5s → 10s → 20s → 40s → 40s… 指数上升并封顶。
        // 没有这条闸门时，下一次轮询（约 2.5s 后）会立刻重新冷读全部 child，活跃会话下
        // 按轮询周期反复重跑全量冷读，并让界面长期停在 partial。
        entry.failureCount += 1;
        const backoffMs = failureBackoffMs(entry.failureCount);
        entry.retryBlockedUntil = now() + backoffMs;
        if (entry.building === settled) entry.building = null;
        touchEntry(rootId);
        evictSnapshots(rootId);
        logBuildFailure(rootId, error, backoffMs);
        throw error;
      },
    );
    entry.building = settled;
    // 立即消费一次 rejection：后台失败不得变成未处理的 rejection；awaitFullBuild 的调用方
    // 拿到的仍是同一个 promise（因此仍是同一个错误对象）。
    settled.catch(() => {});
    return settled;
  }

  /**
   * 幂等地确保后台完整构建已启动（先过冷却闸门）。
   *
   * 与 ensureFullBuild 的唯一区别是它先过冷却闸门：被判为非权威的构建之后，冷却窗口内的请求
   * 不会启动新的全量冷读（返回 undefined，调用方不得依赖返回值）。
   * 注意这里刻意**不调用 cacheEntry**：冷却闸门只是读，不应因为一次被挡下的请求就创建条目或
   * 提升 LRU 顺序（容量由真正产生结果的路径维护）。
   */
  function requestFullBuild(rootId) {
    const entry = snapshotCache.get(rootId);
    if (entry !== undefined && !canStartFullBuild(entry, now())) return undefined;
    return ensureFullBuild(rootId);
  }

  function logStaleBuild(rootId) {
    if (typeof logger?.warn !== "function") return;
    safeWarn(
      "dsh-expert-group: expert-group snapshot build for " + rootId
      + " finished after an invalidation event; result is not authoritative and the next rebuild is deferred",
    );
  }

  function logBuildFailure(rootId, error, backoffMs) {
    if (typeof logger?.warn !== "function") return;
    const message = error instanceof Error ? error.message : String(error);
    // 日志里带上本次退避时长：持续故障时能直接从宿主日志看出重试节奏在收敛。
    const suffix = Number.isFinite(backoffMs) ? "; retrying in " + backoffMs + "ms" : "";
    safeWarn("dsh-expert-group: background expert-group snapshot build for " + rootId + " failed: " + message + suffix);
  }

  /** logger 自身抛错必须就地隔离：告警失败绝不能影响缓存状态或错误传播。 */
  function safeWarn(message) {
    try {
      logger.warn(message);
    } catch {
      // 忽略：宿主日志出口的失败不属于缓存契约。
    }
  }

  /**
   * 使某个会话（root 本身，或属于某个 root 的 child）相关的快照缓存失效。
   *
   * 判定顺序（全部是 O(1) 的 Map 读，找不到就什么都不做，因此幂等、无泄漏）：
   * 1. 该 id 自己就是缓存里的 root；
   * 2. recoveryRecords 的 parentId（live/恢复代际的 child）；
   * 3. 持久化 child_models 的 parentId（重启后只剩持久记录的 child）。
   *
   * **默认 no-op（阻塞项 B3③）**：id 缺失/非法（undefined、空串、纯空白、非字符串）时什么都不做，
   * 返回 0。事件挂点可能拿到缺失的 session/agent id（见 index.js 的接线），若把「没有 id」
   * 解释成「清空全部」，一次无关事件就会把全部 root 打回冷启动。全局失效必须显式调用：
   * `invalidateSnapshots({ all: true })`。
   * 返回被标记失效的 root 数量，便于调用方/测试观察。
   */
  function invalidateSnapshots(sessionId) {
    // 显式全局失效：只有调用方明确传对象才生效，绝不从「缺失 id」推断。
    if (sessionId !== null && typeof sessionId === "object" && sessionId.all === true) {
      let count = 0;
      for (const entry of snapshotCache.values()) {
        entry.generation += 1;
        count += 1;
      }
      return count;
    }
    const id = nonEmpty(sessionId);
    if (id === null) return 0;
    const parentId = snapshotCache.has(id)
      ? id
      : firstText(
        recoveryRecords.get(id)?.parentId,
        persistedChildren()[id]?.parentId,
      );
    const entry = parentId === null ? undefined : snapshotCache.get(parentId);
    if (entry === undefined) return 0;
    entry.generation += 1;
    // 失效只影响「这份结果还算不算当前权威」，不重置去抖窗口：冷却窗口从构建完成时刻起算，
    // 否则「失效即放行」会让去抖完全失效。
    return 1;
  }

  /**
   * 请求路径：轻量优先、完整后台补齐。首屏因此不再等待任何冷读。
   *
   * 顺序（①②③④ 是需求给定的顺序，后两条是同一契约下的防抖动收敛）：
   * 1. 完整快照「新鲜」（代次一致且未超 FULL TTL）→ 直接返回；
   * 2. 完整快照「只是过期」（代次仍一致、未超**绝对**宽限上限）→ 返回它并后台重建：期间没有
   *    任何可观察的状态变化，降级为轻量快照只会让界面在 full ↔ fast 之间抖动；
   * 3. 完整快照「已失效」（收到过失效事件）或超过宽限上限 → 必须给出与新状态一致的结果：
   *    新鲜轻量快照 → 直接返回；否则同步构建一份轻量快照（毫秒级）后返回；
   * 4. 上述每条路径都**幂等**地确保该 root 的后台完整构建已启动（同一 root 同时只有一个；
   *    被判为非权威的构建之后有一个 STALE_REBUILD_MIN_INTERVAL_MS 的冷却窗口）。
   *
   * 边界：轻量构建返回 null 表示「没有任何证据证明该 root 存在」。此时只允许用**仍在宽限内**的
   * 完整快照兜底（displayableFull 同时检查代次与绝对上限）；连它也没有就 await 后台完整构建，
   * 保留原有的 404 / 错误传播契约——绝不无限期展示已失效的 root。
   */
  async function resolveSnapshotForSession(id) {
    const timestamp = now();
    const entry = cacheEntry(id);
    if (isFresh(entry.full, entry, timestamp, FULL_SNAPSHOT_TTL_MS)) return entry.full.snapshot;
    if (entry.full !== null
      && entry.full.generation === entry.generation
      && timestamp - entry.full.at < FULL_SNAPSHOT_GRACE_MS) {
      // 「只是过期」而不是「已失效」：期间没有任何可观察的状态变化，因此继续用上一份权威快照
      // 顶住（不降级为轻量快照），同时后台重建。稳态下这保证界面不会在 full ↔ fast 之间抖动。
      requestFullBuild(id);
      return entry.full.snapshot;
    }
    // 已失效（收到过状态变化事件）或超过宽限期：必须给出与新状态一致的结果。
    // 轻量快照是同步构建的毫秒级投影，先用它保证「状态变化立刻可见」，完整快照紧随其后替换。
    // 代次同样在**构建开始时**捕获（与完整构建同一条规则）。
    //
    // R2：**命中缓存时绝不续期**。只有真正重建 fast 时才写入新的时间戳与代次；否则持续轮询会
    // 把 FAST_SNAPSHOT_TTL_MS 退化成「滑动空闲 TTL」——只要失效事件被漏掉（事件挂点没拿到 id、
    // 宿主事件丢失、客户端轮询早于事件落库），同一份 partial 就能无限期复用。
    // 现在「陈旧上界」由**首次构建时刻**的绝对时间保证：距上次真正重建满 6s 必然重建一次。
    //
    // R5：轻量构建 await 之后必须复核代次。若失效恰好发生在构建期间，这份结果就不是当前权威，
    // 不能作为本次响应返回（否则客户端会拿到旧代次的 partial 并把它当成最新状态）。
    // 处理方式是最小正确做法：立即**再重建一次**（轻量构建是零 I/O 的同步投影，重算不引入阻塞、
    // 不触发任何冷读），并把这次重建结果当作当前权威；最多重算一次，避免理论上
    // 「失效事件与构建无限交替」时自旋。
    let fast;
    let fastGeneration = entry.generation;
    if (isFresh(entry.fast, entry, timestamp, FAST_SNAPSHOT_TTL_MS)) {
      // 命中已有轻量快照：直接复用，**不写回时间戳**（R2）。
      fast = entry.fast.snapshot;
    } else {
      // 真正重建：代次在构建**开始时**捕获（与完整构建同一条规则）。
      // 修复 A：把该 root 的排序锚点（只读查询）传给轻量构建，用它给缺失的 createdAt 兜底
      // （按 root 隔离；Map 不离开本模块）。
      fastGeneration = entry.generation;
      fast = await buildSnapshotForSession(id, { fast: true, sortAnchorFor: createSortAnchorQuery(entry) });
      if (fast !== null && fastGeneration !== entry.generation) {
        // R5：构建期间发生过失效，这份结果不是当前权威——丢弃它，按**当前**代次重算一次
        // （仍是零 I/O 的同步轻量投影，不引入阻塞、不触发冷读）。只重算一次，避免自旋。
        fastGeneration = entry.generation;
        fast = await buildSnapshotForSession(id, { fast: true, sortAnchorFor: createSortAnchorQuery(entry) });
      }
      // 只有真正重建成功时才写入新的时间戳与代次；命中路径保持原有 at 不变。
      if (fast !== null) {
        entry.fast = { snapshot: fast, at: now(), generation: fastGeneration };
        touchEntry(id);
        evictSnapshots(id);
      }
    }
    if (fast === null) {
      // 证据不足：只接受仍在宽限内的完整快照兜底（代次一致，或处于明确的短宽限），
      // 否则等完整构建——它要么给出权威结果，要么按既有契约抛 session-not-found（404）。
      const fallback = displayableFull(entry, timestamp);
      if (fallback !== null) {
        requestFullBuild(id);
        return fallback;
      }
      return await ensureFullBuild(id);
    }
    requestFullBuild(id);
    return fast;
  }

  async function snapshotForSession(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) return buildSnapshotForSession(sessionId, { fast: false });
    const existing = snapshotInFlight.get(id);
    if (existing !== undefined) return existing;
    const promise = resolveSnapshotForSession(id);
    snapshotInFlight.set(id, promise);
    try {
      return await promise;
    } finally {
      if (snapshotInFlight.get(id) === promise) snapshotInFlight.delete(id);
    }
  }

  /**
   * 等待某个 root 的后台完整构建收敛，并返回完整快照。
   *
   * 语义（供测试与收尾使用，不参与首屏与 RPC 信封）：
   * - 有在飞构建 → 等它 settle；成功返回完整快照，失败**原样抛出**同一个错误对象；
   * - 没有在飞构建 → 返回**仍在宽限内**的缓存完整快照（R4：与请求路径共用 displayableFull 的
   *   同一套有界判定：代次一致，或处于明确的短宽限，且都不超过绝对宽限 FULL_SNAPSHOT_GRACE_MS）；
   *   超过上限一律返回 null，绝不无限期返回已失效的 full；
   * - 没有可用缓存但上一次后台构建失败 → 抛出该错误（错误契约不变）；
   * - 从未构建过（未知 root）→ 返回 null。
   */
  async function awaitFullBuild(sessionId) {
    const id = nonEmpty(sessionId);
    if (id === null) return null;
    const entry = snapshotCache.get(id);
    if (entry === undefined) return null;
    if (entry.building !== null) return await entry.building;
    const cached = displayableFull(entry, now());
    if (cached !== null) return cached;
    if (entry.lastError !== null) throw entry.lastError;
    return null;
  }

  return Object.freeze({ snapshotForSession, invalidateSnapshots, awaitFullBuild });
}
