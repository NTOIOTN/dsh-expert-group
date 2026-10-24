import test from "node:test";
import assert from "node:assert/strict";

/**
 * 归属账本（client-sidebar-auto-ledger.js）的容量分账与 stale 内存自愈回归。
 *
 * 背景（真实运行期证据）：
 * - 持久归属表 `dsh-expert-group:auto-ownership:v1` 里 128 条全部 origin=auto、全部来自 16 个旧
 *   会话 scope，恰好顶到 SIDEBAR_AUTO_OWNERSHIP_LIMIT=128；旧实现按**全表** auto 总数判定容量，
 *   于是任何**新**会话都无法再写入归属，Auto 永远打不开（跨会话死锁）。
 * - 自动打开候选每轮都对每个地址读一次归属；内存索引是 realm 级缓存，与持久层分叉时内存里的
 *   stale manual 会把自动打开永久挡住（诊断环里每个候选都是 persisted-manual skip，而持久表里
 *   一条 manual 都没有）。
 *
 * 本文件只测账本本身（纯 localStorage 替身，不装 React / 面板），端到端形状由
 * test/expert-group-sidebar-contract.test.mjs 的追加用例锁定。
 */
await import("../client-sidebar-pure.js");
await import("../client-sidebar-auto-ledger.js");
await import("../client-sidebar-auto-controller.js");
const LEDGER = globalThis[Symbol.for("dsh-expert-group/client-sidebar-auto-ledger")];
const AUTO_CONTROLLER = globalThis[Symbol.for("dsh-expert-group/client-sidebar-auto-controller")];

/** 归属表的持久键与 realm 级槽位（与实现逐字同源）。 */
const SIDEBAR_AUTO_OWNERSHIP_KEY = "dsh-expert-group:auto-ownership:v1";
const SIDEBAR_AUTO_DIAG_KEY = "dsh-expert-group:auto-diag:v1";
const SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/sidebar#shared-auto-ledger");
const SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL = Symbol.for("dsh-expert-group/sidebar#auto-ownership-memory");
const SIDEBAR_AUTO_OWNERSHIP_LIMIT = 128;
/** 实现里的全局硬上限（4 × 单 scope 上限）：本文件用它验证「存储体积有界」。 */
const SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT = 4 * SIDEBAR_AUTO_OWNERSHIP_LIMIT;
/** 当前 scope（与既有契约用例的默认 root 一致）。 */
const SCOPE = { sessionId: "root-a", rootSessionId: "root-a" };
/** 被测地址（子代理会话资源）。 */
const ADDRESS = "dsh-resource://subagentchat/session/child-a?parent=root-a&mode=continuable";

/** 归属复合键：sessionId|rootId|address（与 sidebarAutoScopedKey 同形）。 */
function ownershipKeyOf(address, sessionId = SCOPE.sessionId, rootId = SCOPE.rootSessionId) {
  return sessionId + "|" + rootId + "|" + address;
}

/**
 * 可读、按开关拒绝写入的 localStorage 替身（配额已满 / 权限被拒的形状）。
 * 读取永远正常：对账分支拿到的是一份**合法**的持久表，只是这次 manual 写入没落进去。
 */
function createReadOnlyWritesStorage() {
  const store = new Map();
  const state = { writable: false };
  return {
    state,
    getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
    setItem(key, value) {
      if (state.writable !== true) throw new Error("配额已满");
      store.set(String(key), String(value));
    },
    removeItem(key) { store.delete(String(key)); },
    seed(key, value) { store.set(String(key), String(value)); },
    read(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  };
}

/** 可控 localStorage 替身：可读回、可预置、可整体抛错（隐私模式 / 被拒）。 */
function createFakeLocalStorage(options = {}) {
  const store = new Map();
  const state = { throwOnAccess: options.throwOnAccess === true, writes: 0 };
  const guard = () => {
    if (state.throwOnAccess === true) throw new Error("localStorage 被拒绝");
  };
  return {
    state,
    getItem(key) { guard(); return store.has(String(key)) ? store.get(String(key)) : null; },
    setItem(key, value) { guard(); store.set(String(key), String(value)); state.writes += 1; },
    removeItem(key) { guard(); store.delete(String(key)); },
    seed(key, value) { store.set(String(key), String(value)); },
    read(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
  };
}

/** 清掉 realm 级槽位（等价于一次全新 realm）并装上本用例的 storage。 */
function installStorage(storage) {
  delete globalThis[SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL];
  delete globalThis[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  return () => {
    if (previous === undefined) {
      try { delete globalThis.localStorage; } catch { /* 不可删除时保持原样。 */ }
    } else {
      Object.defineProperty(globalThis, "localStorage", previous);
    }
    delete globalThis[SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL];
    delete globalThis[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL];
  };
}

/** 读持久条目数组（解析失败一律当作空）。 */
function readPersistedEntries(storage) {
  const raw = storage.read(SIDEBAR_AUTO_OWNERSHIP_KEY);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 读有界诊断环。 */
function readDiag(storage) {
  const raw = storage.read(SIDEBAR_AUTO_DIAG_KEY);
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 预置 N 条 auto 归属（key 前缀由 ownerScope 决定，updatedAt 按 index 递增）。 */
function seedAutoEntries(storage, ownerScope, count, prefix) {
  const now = Date.now();
  const list = [];
  for (let index = 0; index < count; index += 1) {
    list.push({
      key: ownershipKeyOf(
        prefix + index,
        ownerScope.sessionId,
        ownerScope.rootSessionId,
      ),
      origin: "auto",
      updatedAt: now - (count - index) * 1000,
      reason: "auto-open",
      tabId: prefix + "tab-" + index,
    });
  }
  storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(list));
  return list;
}

test("归属容量按 scope 分账：别的 scope 顶满 128 条 auto 也不阻塞当前 scope 的自动归属", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const seeded = seedAutoEntries(
      storage,
      { sessionId: "root-old", rootSessionId: "root-old" },
      SIDEBAR_AUTO_OWNERSHIP_LIMIT,
      "dsh-resource://subagentchat/session/seeded-",
    );
    // 用户的故障形状：持久表被旧会话占满，但当前会话一条都没有。
    assert.equal(
      LEDGER.sidebarOwnershipAcceptsNewAuto(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS),
      true,
      "别的 scope 的 128 条 auto 不得阻塞当前 scope：容量必须按 scope 计账",
    );
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "auto", "auto-open", "tab-current"),
      true,
      "当前 scope 的 auto 归属必须能写进去",
    );
    const stored = readPersistedEntries(storage);
    assert.equal(stored.length, SIDEBAR_AUTO_OWNERSHIP_LIMIT + 1, "磁盘条目数必须恰好是旧 128 条 + 新 1 条");
    assert.ok(stored.length <= SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT, "磁盘条目总数必须守在全局限额内");
    for (const item of seeded) {
      assert.ok(stored.some((entry) => entry.key === item.key), "别的 scope 的旧 auto 条目不得被无差别清空：" + item.key);
    }
    const written = stored.find((entry) => entry.key === ownershipKeyOf(ADDRESS));
    assert.equal(written?.origin, "auto", "新写入的条目必须是当前 scope 的 auto 归属");
    assert.equal(written?.tabId, "tab-current", "auto 归属必须保留调用方给出的 tabId 绑定");
    const rejects = readDiag(storage).filter((entry) => entry.kind === "ownership" && entry.event === "reject");
    assert.deepEqual(rejects, [], "按 scope 计账之后不得再出现容量拒绝诊断");
  } finally {
    restore();
  }
});

test("归属容量按 scope 分账：当前 scope 顶满 128 条 auto 仍然 fail-closed 拒绝（不淘汰同 scope owner）", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const seeded = seedAutoEntries(storage, SCOPE, SIDEBAR_AUTO_OWNERSHIP_LIMIT, "dsh-resource://subagentchat/session/seeded-");
    assert.equal(
      LEDGER.sidebarOwnershipAcceptsNewAuto(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS),
      false,
      "当前 scope 满额必须 fail-closed：绝不为了腾位淘汰仍然有效的同 scope owner",
    );
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "auto", "auto-open", "tab-current"),
      false,
      "满额时写入必须被拒绝并返回 false",
    );
    const stored = readPersistedEntries(storage);
    assert.equal(stored.length, SIDEBAR_AUTO_OWNERSHIP_LIMIT, "既有 128 条条目一条都不许被淘汰");
    for (const item of seeded) {
      assert.ok(stored.some((entry) => entry.key === item.key), "既有有效 owner 必须原样保留：" + item.key);
    }
    assert.equal(
      readPersistedEntries(storage).some((entry) => entry.key === ownershipKeyOf(ADDRESS)),
      false,
      "被拒绝的新增条目绝不允许落盘",
    );
    const diag = readDiag(storage);
    assert.ok(
      diag.some((entry) => entry.kind === "ownership" && entry.event === "reject" && entry.reason === "capacity"),
      "容量拒绝必须留下 reject/capacity 诊断，实际 " + JSON.stringify(diag.filter((entry) => entry.kind === "ownership").slice(-3)),
    );
  } finally {
    restore();
  }
});

test("全局硬上限：别的 scope 超过 512 条时只按 updatedAt 淘汰最旧的部分，manual 与当前 scope 一条不动", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    // 512 条别的 scope 的 auto + 1 条别的 scope 的 manual（manual 是用户意图，永不被淘汰）。
    const oldScope = { sessionId: "root-old", rootSessionId: "root-old" };
    const seeded = seedAutoEntries(storage, oldScope, SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT, "dsh-resource://subagentchat/session/old-");
    const manualKey = ownershipKeyOf("dsh-resource://subagentchat/session/old-manual", oldScope.sessionId, oldScope.rootSessionId);
    const list = [...seeded, { key: manualKey, origin: "manual", updatedAt: Date.now() - 100000000, reason: "manual-close" }];
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(list));

    assert.equal(
      LEDGER.sidebarOwnershipAcceptsNewAuto(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS),
      true,
      "全局腾位只需淘汰别的 scope 的旧 auto 条目，当前 scope 的这次写入必须被接受",
    );
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "auto", "auto-open", "tab-current"),
      true,
    );
    const stored = readPersistedEntries(storage);
    /**
     * 全局硬上限只对 **auto** 条目计账：manual 条目是用户意图、永不被淘汰，因此「auto ≤ 512」
     * 是这条上限的确切语义（manual 条目可以额外存在）。
     */
    const storedAuto = stored.filter((entry) => entry.origin === "auto");
    assert.ok(
      storedAuto.length <= SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT,
      "写入之后 auto 条目数必须守在全局限额内，实际 " + storedAuto.length,
    );
    // 最旧的那条 auto（index 0，updatedAt 最小）被淘汰；其余条目与 manual 全部保留。
    assert.equal(
      stored.some((entry) => entry.key === seeded[0].key),
      false,
      "按 updatedAt 从旧到新淘汰：最旧的 auto 条目必须被回收",
    );
    assert.ok(stored.some((entry) => entry.key === seeded[seeded.length - 1].key), "较新的 auto 条目必须原样保留");
    assert.ok(stored.some((entry) => entry.key === manualKey), "manual 条目永不被全局容量淘汰");
    assert.ok(stored.some((entry) => entry.key === ownershipKeyOf(ADDRESS)), "本次写入的当前 scope 条目必须落盘");
  } finally {
    restore();
  }
});

test("stale 内存自愈：持久层删掉 manual 之后，内存条目随之删除并按「没有标记」返回", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const key = ownershipKeyOf(ADDRESS);
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([
      { key, origin: "manual", updatedAt: Date.now(), reason: "manual-close" },
    ]));
    const first = LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS);
    assert.equal(first?.origin, "manual", "持久层 manual 必须命中 manual");
    const memory = globalThis[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL];
    assert.ok(memory?.entries instanceof Map, "读一次之后归属索引必须进入 realm 内存");
    assert.equal(memory.entries.has(key), true, "内存索引里必须有这条 manual 条目");

    // 模拟另一个 realm（旧 bundle 实例 / 别的标签页）把这条记录删掉：内存仍是 stale 的。
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([]));
    const second = LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, { quiet: true });
    assert.equal(second, null, "持久层没有这条记录时必须按「没有标记」返回，绝不继续按 stale manual 阻断");
    assert.equal(memory.entries.has(key), false, "stale 内存条目必须被删除");
    assert.ok(
      readDiag(storage).some((entry) => entry.kind === "ownership" && entry.event === "delete" && entry.reason === "stale-memory"),
      "自愈删除必须留下一条有界诊断（即使调用方传了 quiet）",
    );

    // 自愈之后，这个地址的 auto 归属必须能正常写入（用户故障形状的解锁点）。
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "auto", "auto-open", "tab-current"),
      true,
    );
  } finally {
    restore();
  }
});

test("stale 内存自愈：持久层仍有 manual 时仍按 manual 返回（绝不凭内存猜测放开）", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const key = ownershipKeyOf(ADDRESS);
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([
      { key, origin: "manual", updatedAt: Date.now(), reason: "manual-close" },
    ]));
    assert.equal(LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin, "manual");
    // 持久层原样保留（只是重新序列化了一次，键仍在）。
    assert.equal(
      LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin,
      "manual",
      "持久层 manual 仍在时，任何一次读取都必须是 manual",
    );
  } finally {
    restore();
  }
});

test("stale 内存自愈：持久层不可读 / 解析失败时 fail-closed 继续按内存 manual 判定", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const key = ownershipKeyOf(ADDRESS);
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([
      { key, origin: "manual", updatedAt: Date.now(), reason: "manual-close" },
    ]));
    assert.equal(LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin, "manual");
    // 持久层被写坏：解析失败必须按「读不到」处理，绝不据此放开自动打开。
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, "{ 不是数组");
    assert.equal(
      LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin,
      "manual",
      "持久层解析失败时必须 fail-closed 沿用内存判定",
    );
  } finally {
    restore();
  }
});

test("标题栏 Auto 由关→开：只清当前 scope 的 manual 抑制，返回删除条数", () => {
  const storage = createFakeLocalStorage();
  const restore = installStorage(storage);
  try {
    const currentManual = ownershipKeyOf("dsh-resource://subagentchat/session/manual-a");
    const currentAuto = ownershipKeyOf("dsh-resource://subagentchat/session/auto-a");
    const foreignManual = ownershipKeyOf("dsh-resource://subagentchat/session/manual-b", "root-b", "root-b");
    const now = Date.now();
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([
      { key: currentManual, origin: "manual", updatedAt: now, reason: "manual-close" },
      { key: currentAuto, origin: "auto", updatedAt: now, reason: "auto-open", tabId: "tab-auto-a" },
      { key: foreignManual, origin: "manual", updatedAt: now, reason: "manual-close" },
    ]));
    assert.equal(
      LEDGER.clearSidebarAutoManualSuppressions(SCOPE.sessionId, SCOPE.rootSessionId),
      1,
      "只删当前 scope 的一条 manual，返回删除条数 1",
    );
    const stored = readPersistedEntries(storage);
    assert.equal(stored.some((entry) => entry.key === currentManual), false, "当前 scope 的 manual 抑制必须被清除");
    assert.equal(
      stored.find((entry) => entry.key === currentAuto)?.origin,
      "auto",
      "当前 scope 的 auto 归属一条都不许动",
    );
    assert.equal(
      stored.find((entry) => entry.key === foreignManual)?.origin,
      "manual",
      "别的 scope 的 manual 条目一条都不许动",
    );
    assert.equal(
      LEDGER.clearSidebarAutoManualSuppressions(SCOPE.sessionId, SCOPE.rootSessionId),
      0,
      "没有 manual 可清时返回 0（不制造写放大）",
    );
  } finally {
    restore();
  }
});

test("内存共享账本容量按 scope 计账：别的 scope 占满 128 条 origin 条目也不阻塞当前 scope", () => {
  // 隔离 realm 级内存索引：本用例只验证控制器里的容量闸门，不需要持久层。
  delete globalThis[SIDEBAR_SHARED_AUTO_LEDGER_SYMBOL];
  delete globalThis[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL];
  const origin = new Map();
  const controller = AUTO_CONTROLLER.createSidebarAutoController({
    sidebarAutoOriginRef: { current: origin },
    sidebarSessionId: SCOPE.sessionId,
    rootSessionId: SCOPE.rootSessionId,
  });
  // 条目形状与 realm 账本一致：{ sessionId, rootSessionId, address, tabId }；key 只需唯一。
  for (let index = 0; index < SIDEBAR_AUTO_OWNERSHIP_LIMIT; index += 1) {
    origin.set("root-old|root-old|addr-" + index, {
      sessionId: "root-old", rootSessionId: "root-old", address: "addr-" + index, tabId: null,
    });
  }
  assert.equal(
    controller.autoSidebarOwnershipHasCapacity("root-a|root-a|new", ADDRESS),
    true,
    "别的 scope 的 128 条 origin 条目不得阻塞当前 scope（旧实现用 origin.size 合计判定）",
  );
  for (let index = 0; index < SIDEBAR_AUTO_OWNERSHIP_LIMIT; index += 1) {
    origin.set("root-a|root-a|addr-" + index, {
      sessionId: SCOPE.sessionId, rootSessionId: SCOPE.rootSessionId, address: "addr-" + index, tabId: null,
    });
  }
  assert.equal(
    controller.autoSidebarOwnershipHasCapacity("root-a|root-a|new", ADDRESS),
    false,
    "当前 scope 自己占满 128 条时仍必须 fail-closed",
  );
  assert.equal(
    controller.autoSidebarOwnershipHasCapacity("root-a|root-a|addr-0", "addr-0"),
    true,
    "覆盖写 key 自己那一格不占新增额度（统计时排除自己）",
  );
  delete globalThis[SIDEBAR_AUTO_OWNERSHIP_MEMORY_SYMBOL];
});

test("manual 落盘失败时不得被合法空表对账清掉（fail-closed），成功落盘后对账恢复", () => {
  const storage = createReadOnlyWritesStorage();
  const restore = installStorage(storage);
  try {
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([]));
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "manual", "manual-close"),
      true,
      "manual 写入先落内存：持久层拒绝不影响这次调用成立",
    );
    assert.equal(
      LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin,
      "manual",
      "本 realm 未成功落盘的 manual 绝不能被合法空表判成 stale（否则 Auto 会重开用户刚关掉的 tab）",
    );
    // 恢复可写并成功落盘一次：此前所有未落盘 manual 都被这次全表写入覆盖，标记清空。
    storage.state.writable = true;
    assert.equal(
      LEDGER.writeSidebarAutoOwnership(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS, "manual", "manual-close"),
      true,
    );
    assert.equal(
      LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS)?.origin,
      "manual",
      "成功落盘之后持久层与内存一致，读面仍是 manual",
    );
    // 外部把这条记录删掉（合法空表）：已经落盘过，对账必须恢复并判定为 stale。
    storage.seed(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify([]));
    assert.equal(
      LEDGER.readSidebarAutoOwnershipEntry(SCOPE.sessionId, SCOPE.rootSessionId, ADDRESS),
      null,
      "成功落盘之后对账恢复：空表会把「已落盘后被外部删除」的 manual 判成 stale",
    );
  } finally {
    restore();
  }
});
