/**
 * 会话删除 · 客户端列表对账与本地键清理（票据 08 · 规格决策 19/43 · 测试 E4）
 *
 * ## 职责
 * 1. **列表对账**：结算成功后调用宿主公开的 `ctx.sessions.refresh()`，让行立刻消失；
 *    刷新失败只回一条诊断（绝不抛错、绝不改写结算结果）。
 * 2. **本地键清理**：只清 `deleted` / `absent` 留下的、以会话 ID 为键的数据——
 *    `sessionStorage` 里的任务树展开态，与 `localStorage` 归属账本里 scope 命中该会话的条目
 *    （清理由账本 owner 提供，本模块不复制第二套键格式）。
 *    `failed`（日志仍在原地）/ `skipped`（不可处理）/ `raced`（内容已保留）**绝不清理**：
 *    那些会话还在，清掉它们的展开态或归属就是真实的数据丢失。
 *
 * ## 跨标签页
 * `sessionStorage` 每个标签页各一份，删除只发生在其中一个标签页。因此结算先写一条
 * `{ids, at}` 待清理标记到 `localStorage`（跨标签页可见），再做本标签页清理：清理成功立即
 * 摘掉标记；清理失败则留着，任何客户端在**下一次列表刷新或启动空闲**时重扫
 * （{@link sweepPendingLocalKeys}）。重复清扫幂等：键已不在就删 0 条、标记没有就零写入。
 *
 * ## 键格式不硬编码版本号
 * 展开态键形如 `dsh-expert-group:expansion:v<schema>:<encodeURIComponent(root)>:<task>`
 * （见 `client-expert-group-model-format.js` 的 `keyFor`）。这里按**结构**识别、只比根段：
 * 版本号不认识、结构不完整、或 ID 只出现在任务段/地址段的键一律不动（绝不猜格式误删）。
 *
 * 检查点：`globalThis[Symbol.for("dsh-expert-group/client-session-delete-local-keys")]`。
 */
(function installClientSessionDeleteLocalKeys(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-session-delete-local-keys");
  /** 归属账本的公开检查点（清理命令的唯一实现方；缺失时按「清不了」上报）。 */
  const LEDGER = global[Symbol.for("dsh-expert-group/client-sidebar-auto-ledger")] ?? {};

  /** 行会消失的两态（规格决策 19）；`deletedWithWarnings` 是同义别名。 */
  const STATES = Object.freeze(["deleted", "absent"]);
  const EXPANSION_KEY_PREFIX = "dsh-expert-group:expansion:v";
  /** 待清理标记的持久键（与业务键分开命名，绝不与账本/展开态混用）。 */
  const PENDING_CLEANUP_KEY = "dsh-expert-group:session-delete-cleanup:v1";
  /** 有界：批数与单批目标数都封顶，存储体积不随失败次数增长；超过一周的标记按陈旧丢弃。 */
  const LIMIT = 16;
  const IDS_LIMIT = 200;
  const TTL_MS = 7 * 24 * 60 * 60 * 1000;

  /** 非数组对象判定。 */
  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /** 会话 ID 归一：只接受非空字符串（不透明 ID，不 trim、不猜大小写）。 */
  function readId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /**
   * 安全读 storage：缺失 / 被策略拒绝 / 访问即抛错（隐私模式）一律 null。
   *
   * 用**具名属性**访问而不是 `global[name]`：依赖图门禁把动态全局索引键当 fail-closed。
   */
  function storageOf(name) {
    try {
      const storage = name === "sessionStorage" ? global.sessionStorage : global.localStorage;
      if (storage === null || storage === undefined) return null;
      return typeof storage.getItem === "function" && typeof storage.removeItem === "function" ? storage : null;
    } catch {
      return null;
    }
  }

  /** ID 列表归一：去空、去重（保持顺序）、截到单批上限。 */
  function idsOf(value) {
    const ids = [];
    for (const entry of Array.isArray(value) ? value : []) {
      const id = readId(entry);
      if (id === null || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= IDS_LIMIT) break;
    }
    return ids;
  }

  /**
   * 结算里**已被处理掉**的会话 ID（纯函数）。
   *
   * 逐目标判定，绝不按聚合计数推断（`counts.deleted > 0` 会把整批都当成已删）；顺序即回执顺序。
   */
  function processedSessionIds(settlement) {
    const ids = [];
    const results = Array.isArray(settlement?.results) ? settlement.results : [];
    for (const result of results) {
      const raw = typeof result?.state === "string" ? result.state : "";
      const state = raw === "deletedWithWarnings" ? "deleted" : raw;
      const sessionId = readId(result?.sessionId);
      if (sessionId === null || STATES.includes(state) !== true || ids.includes(sessionId)) continue;
      ids.push(sessionId);
    }
    return ids;
  }

  /**
   * 展开态键 → 已编码的根会话段；不是本插件的展开态键、或结构无法识别时 null。
   *
   * 两段都由 `encodeURIComponent` 编码，因此段内不含 `:`，按 `:` 切分是安全的。
   */
  function expansionRootOf(key) {
    if (typeof key !== "string" || key.startsWith(EXPANSION_KEY_PREFIX) !== true) return null;
    const rest = key.slice(EXPANSION_KEY_PREFIX.length);
    const versionEnd = rest.indexOf(":");
    if (versionEnd <= 0 || /^[0-9]+$/.test(rest.slice(0, versionEnd)) !== true) return null;
    const afterVersion = rest.slice(versionEnd + 1);
    const taskEnd = afterVersion.indexOf(":");
    return taskEnd > 0 ? afterVersion.slice(0, taskEnd) : null;
  }

  /**
   * 清掉以这些会话为根的展开态键。
   *
   * 没有 sessionStorage（或没有目标）时按「没有可清的键」返回：否则待清理标记会永远摘不掉。
   * `ok:false` 只表示真的枚举/删除失败，调用方据此保留标记留待下一次重试。
   */
  function cleanExpansionKeys(sessionIds) {
    const ids = idsOf(sessionIds);
    const storage = ids.length === 0 ? null : storageOf("sessionStorage");
    if (storage === null) return { ok: true, removed: 0 };
    let removed = 0;
    try {
      const roots = ids.map(encodeURIComponent);
      const total = Number(storage.length);
      if (Number.isFinite(total) !== true || typeof storage.key !== "function") return { ok: false, removed: 0 };
      const keys = [];
      for (let index = 0; index < total; index += 1) {
        const key = storage.key(index);
        const root = expansionRootOf(key);
        if (root !== null && roots.includes(root)) keys.push(key);
      }
      for (const key of keys) {
        storage.removeItem(key);
        removed += 1;
      }
      return { ok: true, removed };
    } catch {
      return { ok: false, removed };
    }
  }

  /**
   * 清掉 scope 命中这些会话的归属条目（账本 owner 提供唯一实现，见
   * `client-sidebar-auto-ledger.js` 的 purgeSidebarAutoOwnershipForSessions）。
   *
   * 账本检查点缺失 → `ok:false`：保留标记等一个装了账本的客户端再清，绝不手写第二套键格式去猜。
   */
  function cleanOwnershipLedger(sessionIds) {
    const ids = idsOf(sessionIds);
    const purge = LEDGER.purgeSidebarAutoOwnershipForSessions;
    if (ids.length === 0) return { ok: true, removed: 0 };
    if (typeof purge !== "function") return { ok: false, removed: 0 };
    try {
      const outcome = purge(ids);
      const removed = Number(outcome?.removed);
      return { ok: outcome?.ok === true, removed: Number.isFinite(removed) ? removed : 0 };
    } catch {
      return { ok: false, removed: 0 };
    }
  }

  /** 读待清理标记（损坏 / 结构不符 / 超过 TTL 一律丢弃：绝不按猜出来的 ID 清键）。 */
  function readPendingMarkers(storage, now) {
    const markers = [];
    try {
      const raw = storage.getItem(PENDING_CLEANUP_KEY);
      const parsed = typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : [];
      if (Array.isArray(parsed) !== true) return markers;
      for (const entry of parsed.slice(-LIMIT)) {
        const ids = isObject(entry) ? idsOf(entry.ids) : [];
        const at = Number(entry?.at);
        if (ids.length === 0 || Number.isFinite(at) !== true || now - at > TTL_MS) continue;
        markers.push({ ids, at });
      }
    } catch {
      // 损坏的标记不影响本标签页；下一次成功写入会整体覆盖它。
    }
    return markers;
  }

  /** 写回标记：空列表即删除该键（不留空数组残渣）。 */
  function writePendingMarkers(storage, markers) {
    if (markers.length === 0) storage.removeItem(PENDING_CLEANUP_KEY);
    else storage.setItem(PENDING_CLEANUP_KEY, JSON.stringify(markers.slice(-LIMIT)));
  }

  /**
   * 写入一批待清理标记（结算后**先**写、再清理）。
   *
   * 写不进去（隐私模式 / 配额满）不是错误：本标签页仍会清理，只是缺了跨标签页的补清，
   * 因此返回 `written:false` 如实记账，绝不因此改变结算结果。
   */
  function addPendingCleanup(sessionIds, options) {
    const ids = idsOf(sessionIds);
    const storage = storageOf("localStorage");
    if (ids.length === 0) return { ok: true, written: false };
    if (storage === null) return { ok: false, written: false };
    const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now();
    try {
      const markers = readPendingMarkers(storage, now);
      markers.push({ ids, at: now });
      writePendingMarkers(storage, markers);
      return { ok: true, written: true };
    } catch {
      return { ok: false, written: false };
    }
  }

  /**
   * 待清理标记的**幂等清扫**（「下一次列表刷新」与「启动空闲」两个时机共用）。
   *
   * 每批先清展开态、再清归属账本；**两者都成功才摘标记**，否则留给下一次重试。
   * 没有标记时零写入；键已不在时删 0 条（重复清扫无副作用）。
   */
  function sweepPendingLocalKeys(options) {
    const storage = storageOf("localStorage");
    const report = { ok: true, batches: 0, expansionKeys: 0, ownershipEntries: 0, failed: 0 };
    if (storage === null) return { ...report, ok: false };
    const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now();
    try {
      const markers = readPendingMarkers(storage, now);
      if (markers.length === 0) return report;
      const remaining = [];
      for (const marker of markers) {
        const expansion = cleanExpansionKeys(marker.ids);
        const ownership = cleanOwnershipLedger(marker.ids);
        report.expansionKeys += expansion.removed;
        report.ownershipEntries += ownership.removed;
        if (expansion.ok === true && ownership.ok === true) {
          report.batches += 1;
          continue;
        }
        remaining.push(marker);
        report.failed += 1;
      }
      writePendingMarkers(storage, remaining);
      return { ...report, ok: report.failed === 0 };
    } catch {
      return { ...report, ok: false };
    }
  }

  /** 取宿主公开的会话列表刷新口；缺失（旧宿主 / 测试替身）时 null。 */
  function readSessionRefresh(ctx) {
    try {
      const sessions = ctx?.sessions;
      if (sessions === null || sessions === undefined) return null;
      return typeof sessions.refresh === "function" ? sessions : null;
    } catch {
      return null;
    }
  }

  /**
   * 一次结算后的收敛：**先写标记 → 公开列表刷新 → 本标签页清扫**。
   *
   * 返回值只服务诊断与测试：界面**不**把它当结算结果，清理或刷新失败都不改变「删了几个」的展示。
   * 没有任何 `deleted` / `absent` 时整段跳过（可见性没变、也没有要清的目标）。
   */
  async function convergeAfterSettlement(ctx, settlement, options) {
    const now = Number.isFinite(Number(options?.now)) ? Number(options.now) : Date.now();
    const ids = processedSessionIds(settlement);
    if (ids.length === 0) {
      return { applied: false, ids, marked: false, refreshed: false, refreshError: null, batches: 0, expansionKeys: 0, ownershipEntries: 0 };
    }
    const marked = addPendingCleanup(ids, { now });
    const sessions = readSessionRefresh(ctx);
    let refreshed = false;
    let refreshError = null;
    if (sessions === null) {
      refreshError = "sessions-unavailable";
    } else {
      try {
        await sessions.refresh();
        refreshed = true;
      } catch (error) {
        refreshError = error instanceof Error && error.message.length > 0 ? error.message : "refresh-failed";
      }
    }
    const swept = sweepPendingLocalKeys({ now });
    return {
      applied: true, ids, marked: marked.written === true, refreshed, refreshError,
      batches: swept.batches, expansionKeys: swept.expansionKeys, ownershipEntries: swept.ownershipEntries,
    };
  }

  // 只暴露相邻模块与测试实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    EXPANSION_KEY_PREFIX,
    PENDING_CLEANUP_KEY,
    PROCESSED_STATES: STATES,
    addPendingCleanup,
    cleanExpansionKeys,
    cleanOwnershipLedger,
    convergeAfterSettlement,
    expansionRootOf,
    processedSessionIds,
    readPendingMarkers,
    sweepPendingLocalKeys,
  });
})(globalThis);
