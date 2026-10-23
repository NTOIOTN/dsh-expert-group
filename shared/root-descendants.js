/**
 * root 后代运行状态判定。
 *
 * 收集 root 的递归后代、判定是否仍有运行中的专家，并生成通知门控快照。
 * 本文件由原 `shared.js` 的 3710–3891 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/root-descendants
 */

/**
 * 视为「当前未运行」的 Agent 状态集合。
 *
 * 默认 `["idle", "ready"]` 保持 0.1.x 的兼容语义（ready 只是「两轮之间」）；DSH rc.2 的
 * `Agent.status` 只有 `idle` / `running`，因此等待判定传入 `["idle"]`，让 `ready` 落到
 * 「状态非法」→ `known:false`（fail-closed），绝不被当成空闲。
 */
const DEFAULT_IDLE_STATUSES = Object.freeze(["idle", "ready"]);

function normalizeIdleStatuses(value) {
  if (!Array.isArray(value)) return new Set(DEFAULT_IDLE_STATUSES);
  const statuses = value.filter((item) => typeof item === "string" && item.length > 0);
  return statuses.length > 0 ? new Set(statuses) : new Set(DEFAULT_IDLE_STATUSES);
}

/**
 * runtime agents.list() 快照的后代索引：**唯一**的血缘/身份/状态校验实现。
 *
 * 续接对话时插件本地 tracker 可能为空，因此判定只能依赖 runtime Agent 自身的 exact
 * 血缘（`session.header.parentSession` 链）与状态字段：parentSession 链最终指向 rootId
 * 的 Agent 才算这个 root 的后代；root 自身、其他 root 与非 subagent 运行时 Agent 都不计入。
 *
 * 校验规则（任一不成立都返回 known:false，绝不猜测）：
 * - 列表不是数组、条目不是对象、id 缺失或**重复**、header 不是非数组 object；
 * - `origin` 存在但不是 string（`origin: null` 等既非 subagent 也非已确认 foreign）；
 * - **当前 root 自己**出现在快照里却声称有父会话（root -> child -> root 环）或父字段无效；
 * - 显式声明 subagent 却没有父会话、父会话字段非法、父链成环或链上父级不在 live 列表；
 * - 状态不是字符串，或既不是 running 也不在 idleStatuses 里（rc.2 严格模式下 ready 即非法）。
 *
 * rootId 优先级：当前 exact root 永远先判为「本树」，即使它自身显式声明非 subagent 的
 * origin（例如 `"user"`）也不会被 foreign 分类排除，它的正常 subagent child / 孙辈仍算后代；
 * 其他已确认 foreign 的顶层会话能证明其整支不属于当前 root（false），但真正缺父、非 root 环、
 * 重复 id、非法状态或 subagent 无父会话仍然 fail-closed。空列表是可信的空状态。
 *
 * @param {unknown} agents - agents.list() 返回的 live Agent 数组。
 * @param {string} rootId - 当前 exact root id。
 * @param {{idleStatuses?:string[]}} [options] 视为「当前未运行」的状态集合。
 * @returns {{known:boolean, reason?:string, descendants:Map<string,object>}} 后代索引
 *   （id → { parentSession, status, node }）。
 */
export function collectRuntimeRootDescendants(agents, rootId, options = {}) {
  const idleStatuses = normalizeIdleStatuses(options?.idleStatuses);
  const unknown = (reason = "runtime-descendant-identity-unknown") => ({
    known: false, reason, descendants: new Map(),
  });
  if (typeof rootId !== "string" || rootId.length === 0 || !Array.isArray(agents)) {
    return unknown("runtime-child-query-unknown");
  }
  // 第一遍：只建立可解释的血缘索引；任何一条无法解释的记录都直接保守失败，
  // 因为无法证明它不属于当前 root 的子树。
  const index = new Map();
  for (const node of agents) {
    if (node === null || typeof node !== "object") return unknown();
    const id = node.id;
    if (typeof id !== "string" || id.length === 0) return unknown();
    // 同一 id 出现两次（同 id 新旧 Agent 并存）无法区分代际，不能猜测。
    if (index.has(id)) return unknown("runtime-agent-duplicate-id");
    const header = node.session?.header;
    // header 必须是非 null、非数组的 object：数组 / 字符串等无法解释，绝不能当成
    // 「没有父会话的顶层会话」而放行。
    if (header === null || typeof header !== "object" || Array.isArray(header)) return unknown();
    const parentSession = header.parentSession;
    const origin = header.origin;
    // origin 若存在必须是 string：`origin: null` / 数字等既不是 subagent 也不是已确认
    // foreign，归属无法解释 ⇒ 未知。`origin === undefined` 保持兼容（历史 host 不写该字段）。
    if (origin !== void 0 && typeof origin !== "string") {
      return unknown("runtime-agent-origin-invalid");
    }
    // 当前 root 自己出现在快照里时**必须**符合 DEG root 身份：parentSession 必须缺省。
    // 否则 root -> child -> root 这类环会被第二遍的 rootId 捷径掩盖（rootId 只是 memo 的
    // 初值，不能代替 header 校验）。任何字符串 parentSession 或无效父字段都不可解释。
    if (id === rootId) {
      if (parentSession !== void 0) return unknown("runtime-root-parent-conflict");
      index.set(id, { root: true });
      continue;
    }
    // 非 subagent origin 的 runtime Agent（另一个 root、fork/副本会话等）不属于任何专家子树。
    if (typeof origin === "string" && origin !== "subagent") {
      index.set(id, { foreign: true });
      continue;
    }
    if (parentSession === void 0) {
      // 显式声明 subagent 却没有父会话：身份自相矛盾，无法归属。
      if (origin === "subagent") return unknown();
      index.set(id, { parentSession: void 0 });
      continue;
    }
    if (typeof parentSession !== "string" || parentSession.length === 0) return unknown();
    index.set(id, { parentSession, status: node.status, node });
  }

  // 第二遍：按父链归属。memo 里已知归属的节点不重复回溯；成环或父级缺失都返回未知。
  const lineage = new Map([[rootId, true]]);
  // 已确认 foreign 的 runtime Agent（非 subagent origin，例如另一个 root 的 `"user"` 会话）
  // **先验地**不属于当前 root：父链在它那里终止时，整支都能被证明「不是当前 root 的后代」
  // （false），而不是未知——否则另一个 root 的专家子树会让当前 root 永久 fail-closed。
  // 顺序保护：rootId 自己先入 memo（lineage 初始化即含 true），因此即使当前 root 自身带
  // 非 subagent origin，也永远优先判为「本树」。
  for (const [id, entry] of index) {
    if (entry.foreign === true && id !== rootId) lineage.set(id, false);
  }
  const isDescendant = (id, visiting) => {
    if (lineage.has(id)) return lineage.get(id);
    if (visiting.has(id)) return void 0;
    const entry = index.get(id);
    // 未知 id / 未登记的 foreign 条目：前者仍然未知（绝不猜测），后者只可能是「非本树」。
    if (entry === void 0) return void 0;
    if (entry.foreign === true) return false;
    visiting.add(id);
    // 父链在另一个顶层会话处终止：该 Agent 属于那个 root，不是当前 root 的后代。
    const resolved = entry.parentSession === void 0 ? false : isDescendant(entry.parentSession, visiting);
    if (resolved !== void 0) lineage.set(id, resolved);
    return resolved;
  };

  const descendants = new Map();
  for (const [id, entry] of index) {
    // root 自身不是自己的后代；非 subagent 运行时 Agent 已在上一步排除。
    if (id === rootId || entry.foreign === true) continue;
    const descendant = isDescendant(id, new Set());
    if (descendant === false) continue;
    // 血缘链断裂（父级不在 live 列表里）时无法证明它不在当前子树内，只能 fail closed。
    if (descendant === void 0) return unknown("runtime-descendant-lineage-unknown");
    if (typeof entry.status !== "string") return unknown();
    // running 或「明确未运行」之外的任何状态（含 rc.2 里不存在的 ready）都不能当成空闲。
    if (entry.status !== "running" && !idleStatuses.has(entry.status)) {
      return unknown("runtime-descendant-status-unknown");
    }
    descendants.set(id, entry);
  }
  return { known: true, descendants };
}

/**
 * 递归判断当前 root 的全部后代 runtime Agent 是否仍在运行（通知/终止门控使用）。
 *
 * 复用 collectRuntimeRootDescendants 的同一份校验；返回形状保持既有契约不变。
 *
 * @param {unknown} agents - agents.list() 返回的 live Agent 数组。
 * @param {string} rootId - 当前 exact root id。
 * @param {{idleStatuses?:string[]}} [options] 视为「当前未运行」的状态集合。
 */
export function evaluateRunningRootDescendants(agents, rootId, options = {}) {
  const built = collectRuntimeRootDescendants(agents, rootId, options);
  if (built.known !== true) {
    return {
      known: false,
      blocked: true,
      reason: built.reason ?? "runtime-descendant-identity-unknown",
      runningDescendants: [],
    };
  }
  const runningDescendants = [];
  for (const entry of built.descendants.values()) {
    if (entry.status === "running") runningDescendants.push(entry.node);
  }
  return {
    known: true,
    blocked: runningDescendants.length > 0,
    ...(runningDescendants.length > 0 ? { reason: "runtime-running-descendant" } : {}),
    runningDescendants,
  };
}

/**
 * 同步读取 runtime agents.list() 并转换为终止门控可消费的快照。
 * 查询缺失、抛错或非数组结果均为未知；终止判定必须 fail closed。
 * @param {unknown} list - 读取 live Agent 的函数（通常是 () => agents.list()）。
 * @param {string} rootId - 当前 exact root id。
 */
export function snapshotRunningRootDescendants(list, rootId, options = {}) {
  if (typeof list !== "function") {
    return { known: false, blocked: true, reason: "runtime-child-query-unknown", runningDescendants: [] };
  }
  try {
    return evaluateRunningRootDescendants(list(), rootId, options);
  } catch {
    return { known: false, blocked: true, reason: "runtime-child-query-unknown", runningDescendants: [] };
  }
}
