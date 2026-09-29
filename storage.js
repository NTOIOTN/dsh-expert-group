/**
 * dsh-expert-group 的 storage domain 纯辅助函数。
 * 运行数据没有 settings fallback；这里仅定义 domain 快照、binding 与 child LRU 协议。
 */

export const CHILD_LRU_LIMIT = 300;

/**
 * 首次 storageDomain 注入门闩：注入回调未执行前，写入只能等待；
 * 回调明确报告缺失服务或初始化失败时，等待者收到同一个失败结果。
 */
export function createInitializationGate() {
  let settled = false;
  let resolveGate;
  let rejectGate;
  const promise = new Promise((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return false;
      settled = true;
      resolveGate(value);
      return true;
    },
    reject(error) {
      if (settled) return false;
      settled = true;
      rejectGate(error);
      return true;
    },
    get settled() { return settled; },
  };
}

function finiteSequence(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function recordSequence(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? finiteSequence(value.lruSequence)
    : undefined;
}

function withSequence(value, sequence) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...value, lruSequence: sequence }
    : value;
}

function compareEntries(left, right) {
  const leftSequence = recordSequence(left[1]);
  const rightSequence = recordSequence(right[1]);
  if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) return leftSequence - rightSequence;
  if (leftSequence === undefined && rightSequence !== undefined) return -1;
  if (leftSequence !== undefined && rightSequence === undefined) return 1;
  const leftKey = String(left[0]);
  const rightKey = String(right[0]);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * 把缺失或重复序号的历史记录按 key 稳定补齐，分配值严格避开已有序号，
 * 完全不依赖 JSON/SQLite entries 顺序。
 */
export function normalizeLruEntries(entries) {
  const unique = new Map(entries ?? []);
  const sorted = [...unique.entries()].sort(compareEntries);
  const occupied = new Set();
  const unresolved = [];
  for (const [key, value] of sorted) {
    const sequence = recordSequence(value);
    if (sequence === undefined || occupied.has(sequence)) unresolved.push([key, value]);
    else occupied.add(sequence);
  }
  let nextSequence = occupied.size === 0 ? 0 : Math.max(...occupied) + 1;
  const assigned = new Map();
  unresolved.sort(([leftKey], [rightKey]) => {
    const left = String(leftKey);
    const right = String(rightKey);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const [key, value] of unresolved) {
    while (occupied.has(nextSequence)) nextSequence += 1;
    assigned.set(key, nextSequence);
    occupied.add(nextSequence);
    nextSequence += 1;
  }
  return sorted.map(([key, value]) => [
    key,
    assigned.has(key) ? withSequence(value, assigned.get(key)) : value,
  ]).sort(compareEntries);
}

/** 追加最新 child，维护单调序号，超限从最旧序号裁剪。 */
export function appendLruEntry(entries, key, value, limit = CHILD_LRU_LIMIT) {
  if (limit <= 0) return [];
  const current = normalizeLruEntries([...entries ?? []].filter(([entryKey]) => entryKey !== key));
  const maxSequence = current.reduce((max, [, entryValue]) => Math.max(max, recordSequence(entryValue) ?? -1), -1);
  return [...current, [key, withSequence(value, maxSequence + 1)]]
    .sort(compareEntries)
    .slice(-limit);
}

/** 返回 domain 表读出的公共 source 形状，不读取 settings。 */
export function readDomainSnapshot(sessionEntries, childEntries) {
  return {
    sessionOverrides: Object.fromEntries(sessionEntries ?? []),
    childModels: Object.fromEntries(childEntries ?? []),
  };
}

/** 计算先写最新记录、再删除裁剪项的计划。 */
export function planLruPersistence(entries, key, value, limit = CHILD_LRU_LIMIT) {
  const current = [...entries ?? []];
  const next = appendLruEntry(current, key, value, limit);
  const keep = new Set(next.map(([entryKey]) => entryKey));
  return {
    record: next.find(([entryKey]) => entryKey === key)?.[1] ?? value,
    trimKeys: current.map(([entryKey]) => entryKey).filter((entryKey) => !keep.has(entryKey)),
    entries: next,
  };
}

/** domain 普通记录写入；generation 失效时不再触碰旧 handle。 */
export async function persistDomainEntry({ table, key, value, isCurrent }) {
  if (typeof isCurrent === "function" && !isCurrent()) return { written: false, detached: true };
  await table.put(key, value);
  if (typeof isCurrent === "function" && !isCurrent()) return { written: true, detached: true };
  return { written: true, detached: false };
}

/**
 * child durable put 成功前不删除任何旧记录；裁剪删除失败时保留新记录，下一次写入可重试。
 */
export async function persistLruEntry({ table, key, value, limit = CHILD_LRU_LIMIT, isCurrent }) {
  if (typeof isCurrent === "function" && !isCurrent()) return { record: value, trimmed: false, detached: true, deleted: [] };
  const plan = planLruPersistence(table.entries(), key, value, limit);
  await table.put(key, plan.record);
  const deleted = [];
  if (typeof isCurrent === "function" && !isCurrent()) return { record: plan.record, trimmed: false, detached: true, deleted };
  for (const trimKey of plan.trimKeys) {
    try {
      await table.delete(trimKey);
      deleted.push(trimKey);
    } catch (error) {
      return { record: plan.record, trimmed: false, deleted, error };
    }
    if (typeof isCurrent === "function" && !isCurrent()) return { record: plan.record, trimmed: false, detached: true, deleted };
  }
  return { record: plan.record, trimmed: true, deleted };
}

/**
 * storageDomain 重载控制器。旧 binding 失效后立即脱离 current；迟到 Promise 不能安装到新 generation。
 */
export function createBindingController() {
  let generation = 0;
  let active;
  const invalidate = (binding) => {
    if (binding === undefined || binding.status === "fallback") return false;
    binding.status = "fallback";
    binding.onInvalidate?.();
    if (active === binding) active = undefined;
    return true;
  };
  return {
    begin() {
      if (active !== undefined) invalidate(active);
      const binding = { generation: ++generation, status: "opening" };
      active = binding;
      return binding;
    },
    install(binding, value = {}) {
      if (active !== binding || binding.status === "fallback") return false;
      Object.assign(binding, value, { status: "ready" });
      return true;
    },
    invalidate,
    isCurrent(binding) {
      return active === binding && binding.status !== "fallback";
    },
    current() {
      return active;
    },
  };
}
