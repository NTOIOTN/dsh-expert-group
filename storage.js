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

/**
 * 返回 domain 表读出的公共 source 形状，不读取 settings。
 *
 * @param {Array<[string, object]>} [sessionEntries] - session_overrides 的 [sessionId, 角色字典]。
 * @param {Array<[string, object]>} [childEntries] - child_models 的 [childId, 记录]。
 * @param {Array<[string, object]>} [overrideMetaEntries] - session_override_meta 的
 *   [sessionId, { revision }]（票据 21）。第三参数刻意可选：历史调用方/测试只传两张表时
 *   仍得到原来的形状，只是 revision 映射为空（= 全部从 0 开始）。
 * @param {Array<[string, object]>} [templateEntries] - fanout_templates 的 [key, 文档]
 *   （票据 28）。同样可选：只读纯函数测试可以继续只关心 session/child 两张表，
 *   此时模板文档按“空表”归一，绝不让缺失参数变成 undefined 读取。
 * @returns {{sessionOverrides: object, childModels: object, sessionOverrideRevisions: object,
 *   fanoutTemplates: {version: number, templates: object[]}}}
 */
export function readDomainSnapshot(sessionEntries, childEntries, overrideMetaEntries, templateEntries) {
  // 代次只投影合法非负安全整数：坏记录（历史手工写入/未知版本）不得让读取面抛错，
  // 也绝不被当成一个更大的 revision 去绕过 CAS——缺失即按 0 处理。
  const sessionOverrideRevisions = {};
  for (const [sessionId, value] of overrideMetaEntries ?? []) {
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    const revision = value?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) continue;
    sessionOverrideRevisions[sessionId] = revision;
  }
  return {
    sessionOverrides: Object.fromEntries(sessionEntries ?? []),
    childModels: Object.fromEntries(childEntries ?? []),
    sessionOverrideRevisions,
    fanoutTemplates: normalizeTemplateDocumentEntries(templateEntries),
  };
}

/**
 * fanout_templates 单表文档的键（票据 28）。
 *
 * 与 fanout_tasks 完全同构：固定一行 key="current"，值的版本号独立于 storage domain
 * 的 version（domain 仍是 1，新增表不升版）。模板 id 由 Host 生成，绝不拿用户输入
 * 当键或路径；因此这里不需要任何文件系统语义。
 */
export const FANOUT_TEMPLATE_STORE_KEY = "current";

/** 模板文档版本：读取面不信任 raw.version，统一投影为 1（写入端也只写 1）。 */
export const FANOUT_TEMPLATE_VERSION = 1;

/** 单库模板数量上限：超过即拒绝新增/更新（更新不增加数量）。 */
export const FANOUT_TEMPLATE_LIMIT = 32;

/**
 * 把 fanout_templates 的持久化条目归一成 {@link readDomainSnapshot} 的只读投影。
 *
 * 读取面必须宽容：表缺失、key 缺失、结构非法、条目不是普通对象都只意味着“没有模板”，
 * 绝不能让 storage ready 或设置页读取失败。数量上限在读取面同样生效：即使磁盘被外部
 * 写入超量模板，内存投影也只保留前 32 条，避免 UI/RPC 被无界数据拖死。
 *
 * @param {Array<[string, unknown]>} [entries] - storage 表条目。
 * @param {{limit?: number}} [options] - 读取上限覆盖（测试可收紧）。
 * @returns {{version: number, templates: object[]}}
 */
export function normalizeTemplateDocumentEntries(entries, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit >= 0
    ? options.limit
    : FANOUT_TEMPLATE_LIMIT;
  const raw = Array.isArray(entries)
    ? entries.find(([key]) => key === FANOUT_TEMPLATE_STORE_KEY)?.[1]
    : undefined;
  const templates = Array.isArray(raw?.templates)
    ? raw.templates
      .filter((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))
      .slice(0, limit)
    : [];
  return { version: FANOUT_TEMPLATE_VERSION, templates };
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
 * domain 普通记录删除；与 persistDomainEntry 共用同一套 generation 门控语义。
 *
 * 会话覆盖清除后如果某个会话已经没有任何角色覆盖，就删除整行（而不是留下空对象）：
 * 读取面因此继续把“没有覆盖”表达为缺行，旧读者看到的形状与从未写过完全一致。
 *
 * @param {{table: object, key: string, isCurrent?: Function}} params
 * @returns {Promise<{deleted: boolean, detached: boolean}>}
 */
export async function removeDomainEntry({ table, key, isCurrent }) {
  if (typeof isCurrent === "function" && !isCurrent()) return { deleted: false, detached: true };
  await table.delete(key);
  if (typeof isCurrent === "function" && !isCurrent()) return { deleted: true, detached: true };
  return { deleted: true, detached: false };
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
