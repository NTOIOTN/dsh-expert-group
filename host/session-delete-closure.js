/**
 * 会话删除的目标闭包与五态计数（票据 02）。
 *
 * ## 为什么这一层必须是纯函数
 * 规格决策 6 要求「闭包在确认时刻冻结」：成员集合、去重结果、执行顺序、每个成员的可处理性
 * 都在用户点确认那一刻定下来，执行期只按冻结结果推进。因此这一层不碰文件系统、不读宿主
 * 服务、不读时钟——输入是两份快照（持久化清单 header、DEG 子会话记录）与一份 live 会话 ID
 * 快照，输出是确定的计划。这样「子先父后」「父子同选不重复计数」「被阻塞的闭包整体跳过」
 * 都能在没有真实文件系统的测试里逐条验证（票据验收：纯函数部分不依赖真实文件系统）。
 *
 * ## 两个后代来源为什么取并集（规格决策 5）
 * - `sessionPersistence.list()` 的 `header.parentSession` 是宿主权威血缘，但它只覆盖**日志
 *   还在**的会话：某个专家的日志一旦被改名进隔离区，下一次进程启动后它就不在清单里了。
 * - DEG 自己的 `child_models` 表（键 = 子会话 ID，记录的 `parentId` = 父会话 ID）记录的是
 *   派发当时的事实，即使子会话日志已消失也还在——它负责补齐「header 已消失的子会话」。
 * 两者取并集，闭包才不会因为某个中间层 header 消失而断链。
 *
 * ## 为什么 child_models 的父关系不覆盖 header 血统
 * 同一对父子关系在两个来源里一般一致；若不一致（DEG 记录陈旧、会话被 fork 过），**header
 * 是权威**：`parentOf` 保留 header 的父，只在缺失时用 DEG 记录补齐。但**子索引仍然取并集**，
 * 因为规格要求「覆盖 header 已消失的子会话」——陈旧记录最多让闭包多带一个会话，绝不漏带；
 * 多带的会话会以 absent / 正常删除路径处理，不会误删别人的日志（日志定位自带归属校验）。
 *
 * ## 执行顺序（子先父后）
 * 对成员图做**后序**遍历：先发完所有后代再发自己。同一层的兄弟按会话 ID 升序固定，父目标
 * 一定排在自己的后代之后；这样的顺序让「先删子、再删父」在任何批量里都成立，也让同一份
 * 输入永远得到同一份结果（守恒与去重的断言依赖这份确定性）。
 *
 * ## 五态与守恒
 * 五个结果态互斥且穷尽（规格决策 17）：deleted / raced / failed / skipped / absent。
 * 守恒式：`deleted + raced + failed + skipped + absent = 闭包内目标数 T`。候选级阻塞
 * （确认时就被判定为 live / live-descendant 的目标，以及被父目标闭包连坐跳过的目标）**不计入
 * T**——它们根本没进入作业，`evaluateDeletePlan` 把它们放在 `blocked` / `collateral` 里。
 *
 * @module dsh-expert-group/host/session-delete-closure
 */

/** 五个结果态（互斥且穷尽，规格决策 17）。 */
export const SESSION_DELETE_STATES = Object.freeze({
  /** 日志已改名进隔离区，队列条目已登记到 cleanup。 */
  DELETED: "deleted",
  /** 改名后发现会话被重新打开：删除未完成，内容已保留（或已尝试回位）。 */
  RACED: "raced",
  /** 日志仍在原地，什么都没动。 */
  FAILED: "failed",
  /** 不可处理：live / live-descendant / pending-cleanup。 */
  SKIPPED: "skipped",
  /** 本来就没有日志（或日志已不在），只登记收敛清理。 */
  ABSENT: "absent",
});

/** 不可处理（skipped）的三种原因（规格决策 17 / 24）。 */
export const DELETE_BLOCK_REASONS = Object.freeze({
  /** 目标自己仍被宿主保持在 live。 */
  LIVE: "live",
  /** 闭包内某个后代会话仍 live：整个目标跳过，并指名阻塞者。 */
  LIVE_DESCENDANT: "live-descendant",
  /** 上一次删除的收尾没做完（隔离目录还在，或队列条目还在）。 */
  PENDING_CLEANUP: "pending-cleanup",
});

/** 五态的稳定顺序（聚合结果与零值计数的唯一事实源）。 */
const RESULT_STATES = Object.freeze(Object.values(SESSION_DELETE_STATES));

/** 稳定比较：会话 ID 一律按码元升序，保证同一份输入的兄弟顺序固定。 */
function compareSessionId(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 非空字符串归一；其余（含数字、空串）返回 undefined。 */
function readId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 归一持久化清单条目为 header（**纯函数、永不抛错**）。
 *
 * 兼容两种形状：后端直接返回 header，或返回 `{ header }` 包装（宿主 jsonl 后端的 list()
 * 只保证「有一条会话记录」，包装层是实现细节）。同一 id 只保留**第一条**：清单里出现重复
 * 会话是后端异常，闭包按「先出现者为准」处理，绝不因此让计数漂移。
 *
 * @param {Iterable<unknown>} entries - `sessionPersistence.list()` 的返回值。
 * @returns {Array<{id: string, cwd?: string, parentSession?: string, title?: string}>} 归一后的 header。
 */
export function normalizeSessionHeaders(entries) {
  const headers = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    const raw = entry !== null && typeof entry === "object" && entry.header !== undefined ? entry.header : entry;
    const id = readId(raw?.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const cwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
    const parentSession = readId(raw.parentSession);
    // title 不是宿主 header 的契约字段；它只是让适配器（候选查询）能把标题带进闭包，
    // 缺失时闭包按「没有标题」处理，绝不伪造一个会话名。
    const title = readId(raw.title);
    headers.push({
      id,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(title === undefined ? {} : { title }),
    });
  }
  return headers;
}

/**
 * 归一 DEG 子会话记录为 `{childId, parentId}` 连线（**纯函数、永不抛错**）。
 *
 * 表键就是子会话 ID（身份永远取自键），记录体里的 `parentId` 是父会话 ID。自环
 * （childId === parentId）会被丢弃：它只可能来自被外部篡改的记录，保留只会让闭包出现
 * 一个自己指向自己的节点。同一对父子只保留一次。
 *
 * @param {Iterable<unknown>} records - `[{childId, parentId}]`（适配器已把表读成数组）。
 * @returns {Array<{childId: string, parentId: string}>} 归一后的连线。
 */
export function normalizeDegChildLinks(records) {
  const links = [];
  const seen = new Set();
  for (const record of records ?? []) {
    const childId = readId(record?.childId);
    const parentId = readId(record?.parentId);
    if (childId === undefined || parentId === undefined || childId === parentId) continue;
    const key = parentId + "\u0000" + childId;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ childId, parentId });
  }
  return links;
}

/**
 * 建立会话血缘索引：父 → 子集合、子 → 父、id → header。
 *
 * @param {Array<object>} headers - 归一后的 header 列表。
 * @param {Array<{childId: string, parentId: string}>} degChildren - 归一后的 DEG 连线。
 * @returns {{headerOf: Map<string, object>, parentOf: Map<string, string>, children: Map<string, Set<string>>}}
 *   索引；`children` 的集合是**并集**（header 血缘 ∪ DEG 记录），`parentOf` 以 header 为准。
 */
export function buildSessionChildIndex(headers, degChildren) {
  const headerOf = new Map();
  const parentOf = new Map();
  const children = new Map();
  const addChild = (parentId, childId) => {
    const set = children.get(parentId) ?? new Set();
    set.add(childId);
    children.set(parentId, set);
  };
  for (const header of headers ?? []) {
    const id = readId(header?.id);
    if (id === undefined) continue;
    if (!headerOf.has(id)) headerOf.set(id, header);
    const parentSession = readId(header?.parentSession);
    if (parentSession === undefined || parentSession === id) continue;
    // header 是权威父关系：先写者为准（同一 id 的重复 header 已在归一层去重）。
    if (!parentOf.has(id)) parentOf.set(id, parentSession);
    addChild(parentSession, id);
  }
  for (const link of degChildren ?? []) {
    const childId = readId(link?.childId);
    const parentId = readId(link?.parentId);
    if (childId === undefined || parentId === undefined || childId === parentId) continue;
    // DEG 记录只补 header 已消失的子会话：header 血缘优先，绝不覆盖。
    if (!parentOf.has(childId)) parentOf.set(childId, parentId);
    addChild(parentId, childId);
  }
  return { headerOf, parentOf, children };
}

/** 子会话按 ID 升序（确定性顺序的唯一来源）。 */
function sortedChildrenOf(index, parentId) {
  const set = index?.children?.get(parentId);
  return set === undefined ? [] : [...set].sort(compareSessionId);
}

/**
 * 收集一个会话的整棵子树（含它自己），BFS 顺序：先根、再逐层后代。
 *
 * BFS 顺序是「最近的 live 阻塞者」判定的基础：命中的第一个 live 后代就是距离目标最近的
 * 那个，比任意顺序更容易向用户解释。
 *
 * @param {object} index - {@link buildSessionChildIndex} 的结果。
 * @param {string} rootId - 子树的根会话 ID。
 * @returns {string[]} 根在前、后代在后；未知会话返回只含自己的单元素数组。
 */
export function collectSessionSubtree(index, rootId) {
  const root = readId(rootId);
  if (root === undefined) return [];
  const ordered = [root];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const childId of sortedChildrenOf(index, current)) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      ordered.push(childId);
      queue.push(childId);
    }
  }
  return ordered;
}

/** 把 live 快照归一成集合（接受 Set / 数组 / 任意可迭代）。 */
function liveSetOf(liveSessionIds) {
  if (liveSessionIds instanceof Set) return liveSessionIds;
  const live = new Set();
  for (const sessionId of liveSessionIds ?? []) {
    const id = readId(sessionId);
    if (id !== undefined) live.add(id);
  }
  return live;
}

/** 在子树里找第一个 live 成员：根本身命中即 live，其余位置命中即 live-descendant。 */
function findLiveBlocker(subtree, live) {
  for (const sessionId of subtree) {
    if (!live.has(sessionId)) continue;
    return {
      kind: sessionId === subtree[0] ? DELETE_BLOCK_REASONS.LIVE : DELETE_BLOCK_REASONS.LIVE_DESCENDANT,
      sessionId,
    };
  }
  return null;
}

/**
 * 在某个会话的整棵子树里找第一个 live 成员（候选查询用，**纯函数**）。
 *
 * 与作业期共用同一套判定：子树展开用 {@link collectSessionSubtree}，命中优先级用
 * {@link findLiveBlocker}（根本身 → `live`，后代 → `live-descendant`）。区别只在取事实的
 * 方式：作业期先拿一份 live 快照集合，候选查询逐会话问宿主（`isLive` 回调）。
 *
 * `isLive` 抛错时**原样上抛**：候选查询拿不到「是否被占用」这个事实就只能整体失败
 * （客户端据此把入口置为不可用），绝不把读不通当成「没被占用」。
 *
 * @param {object} index - {@link buildSessionChildIndex} 的结果。
 * @param {string} rootId - 候选会话 ID。
 * @param {(sessionId: string) => boolean} isLive - 判活回调（返回 true 表示仍被宿主占用）。
 * @returns {{kind: string, sessionId: string}|null} 阻塞者；可处理时返回 null。
 */
export function findLiveBlockerInSubtree(index, rootId, isLive) {
  const root = readId(rootId);
  if (root === undefined) return null;
  // 用 has() 适配器把逐会话判活接到同一个 findLiveBlocker 上：判定规则只有一份实现。
  const live = { has: (sessionId) => typeof isLive === "function" && isLive(sessionId) === true };
  return findLiveBlocker(collectSessionSubtree(index, root), live);
}

/** 请求集合去重并保持输入顺序（空串与重复项直接丢弃）。 */
function uniqueRootIds(rootSessionIds) {
  const roots = [];
  const seen = new Set();
  for (const sessionId of rootSessionIds ?? []) {
    const id = readId(sessionId);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    roots.push(id);
  }
  return roots;
}

/**
 * 后序遍历成员图：后代先发、祖先后发；兄弟按 ID 升序；每个成员只发一次。
 *
 * 用显式栈而不是递归：闭包深度由用户选择决定，进程栈不该成为它的上限。
 *
 * @param {object} index - 血缘索引。
 * @param {Set<string>} memberSet - 本次作业的成员集合。
 * @param {string[]} rootIds - 生效的根（按用户选择顺序）。
 * @returns {string[]} 执行顺序。
 */
function orderMembers(index, memberSet, rootIds) {
  const ordered = [];
  const emitted = new Set();
  for (const rootId of rootIds) {
    if (emitted.has(rootId) || !memberSet.has(rootId)) continue;
    const stack = [{ id: rootId, expanded: false }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.expanded === true) {
        stack.pop();
        if (emitted.has(top.id)) continue;
        emitted.add(top.id);
        ordered.push(top.id);
        continue;
      }
      top.expanded = true;
      const children = sortedChildrenOf(index, top.id);
      for (let cursor = children.length - 1; cursor >= 0; cursor -= 1) {
        const childId = children[cursor];
        if (!memberSet.has(childId) || emitted.has(childId)) continue;
        stack.push({ id: childId, expanded: false });
      }
    }
  }
  return ordered;
}

/** 某个成员在成员集合内的全部后代（BFS 顺序，不含自己）。 */
function membersBelow(index, sessionId, memberSet) {
  const descendants = [];
  const seen = new Set([sessionId]);
  const queue = [sessionId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const childId of sortedChildrenOf(index, current)) {
      if (seen.has(childId) || !memberSet.has(childId)) continue;
      seen.add(childId);
      descendants.push(childId);
      queue.push(childId);
    }
  }
  return descendants;
}

/**
 * 在确认时刻冻结本次删除作业的计划（**纯函数**）。
 *
 * 三种输入事实各自说明一件事：
 * - `headers`：哪些会话还有日志（同时提供权威血缘与 cwd）；
 * - `degChildren`：header 已消失的子会话；
 * - `liveSessionIds`：**确认时刻**的 live 快照。
 *
 * 判定顺序固定：先看目标自己是否 live（原因 `live`），再看闭包里是否有 live 后代
 * （原因 `live-descendant`，并指名最近的那个阻塞者）。被阻塞目标的整个闭包都退出本次
 * 作业：闭包内被单独选中的其他目标也一并跳过（`collateral`），这是规格决策 3 的级联
 * 粒度——阻塞不是按会话而是按闭包生效。
 *
 * @param {object} params
 * @param {Iterable<string>} params.rootSessionIds - 用户选中的会话 ID（保持选择顺序）。
 * @param {Array<object>} params.headers - 持久化清单 header（可含已消失子会话时缺失）。
 * @param {Array<{childId: string, parentId: string}>} params.degChildren - DEG 子会话连线。
 * @param {Iterable<string>} params.liveSessionIds - 确认时刻的 live 会话 ID 快照。
 * @param {(sessionId: string) => (string|undefined)} [params.titleOf] - 标题解析（可缺省）。
 * @returns {object} 冻结计划：
 *   - `targets`：本次要处理的成员（执行顺序，子先父后），每项带 `descendantIds`；
 *   - `targetCount`：守恒式里的 T；
 *   - `roots`：生效的根（去掉被阻塞与被连坐的）；
 *   - `blocked`：确认时不可处理的根（`blockedBy` 带会话 ID 与标题）；
 *   - `collateral`：被父目标闭包连坐跳过的单独选中目标；
 *   - `members`：冻结成员集合（执行顺序）；
 *   - `blockedMembers`：因父目标阻塞而未进入作业的成员。
 */
export function evaluateDeletePlan({ rootSessionIds, headers, degChildren, liveSessionIds, titleOf }) {
  const index = buildSessionChildIndex(headers, degChildren);
  const live = liveSetOf(liveSessionIds);
  const resolveTitle = (sessionId) => {
    const resolved = typeof titleOf === "function" ? titleOf(sessionId) : undefined;
    return readId(resolved) ?? readId(index.headerOf.get(sessionId)?.title);
  };
  const roots = uniqueRootIds(rootSessionIds);
  const subtrees = new Map();
  const blocked = [];
  const blockedOwnerOf = new Map();
  const actionableRootIds = [];
  for (const rootId of roots) {
    const subtree = collectSessionSubtree(index, rootId);
    subtrees.set(rootId, subtree);
    const blocker = findLiveBlocker(subtree, live);
    if (blocker === null) {
      actionableRootIds.push(rootId);
      continue;
    }
    blocked.push({
      sessionId: rootId,
      title: resolveTitle(rootId),
      blockedBy: {
        kind: blocker.kind,
        sessionId: blocker.sessionId,
        title: resolveTitle(blocker.sessionId),
      },
    });
    // 闭包内每个成员都记下第一个把它挡住的根：它决定了「连坐跳过」的归属。
    for (const memberId of subtree) {
      if (!blockedOwnerOf.has(memberId)) blockedOwnerOf.set(memberId, rootId);
    }
  }
  const collateral = [];
  const effectiveRootIds = [];
  for (const rootId of actionableRootIds) {
    const owner = blockedOwnerOf.get(rootId);
    if (owner === undefined) {
      effectiveRootIds.push(rootId);
      continue;
    }
    // 自己可处理，但落在某个被阻塞目标的闭包里：按决策 3 一并跳过。
    const ownerEntry = blocked.find((entry) => entry.sessionId === owner);
    collateral.push({
      sessionId: rootId,
      title: resolveTitle(rootId),
      viaSessionId: owner,
      blockedBy: {
        kind: DELETE_BLOCK_REASONS.LIVE_DESCENDANT,
        sessionId: ownerEntry?.blockedBy?.sessionId,
        title: ownerEntry?.blockedBy?.title,
      },
    });
  }
  const memberSet = new Set();
  for (const rootId of effectiveRootIds) {
    for (const memberId of subtrees.get(rootId) ?? []) {
      if (blockedOwnerOf.has(memberId)) continue;
      memberSet.add(memberId);
    }
  }
  const members = orderMembers(index, memberSet, effectiveRootIds);
  const targets = members.map((sessionId) => ({
    sessionId,
    title: resolveTitle(sessionId),
    parentSessionId: index.parentOf.get(sessionId),
    // 冻结的后代集合是执行期「live-descendant」判定的唯一依据：确认后新增的子会话
    // 不在这里，因此既不会进作业，也不会产生 skipped（规格决策 6）。
    descendantIds: membersBelow(index, sessionId, memberSet),
  }));
  return {
    roots: effectiveRootIds,
    blocked,
    collateral,
    targets,
    targetCount: targets.length,
    members,
    blockedMembers: [...blockedOwnerOf.keys()],
  };
}

/**
 * 统计「确认后新增、未纳入本次作业」的下游会话数量（只进结算备注）。
 *
 * 用**当前**快照重新展开每个生效根的子树，与冻结成员集合求差集。差集只计数，绝不生成
 * skipped 结果——新增子会话不是「不可处理」，它只是没被这次确认覆盖（规格决策 6）。
 *
 * @param {object} params
 * @param {Iterable<string>} params.rootSessionIds - 生效根（计划里的 `roots`）。
 * @param {Array<object>} params.headers - 当前快照。
 * @param {Array<{childId: string, parentId: string}>} params.degChildren - 当前 DEG 连线。
 * @param {Iterable<string>} params.frozenMembers - 冻结成员集合（计划里的 `members`）。
 * @returns {number} 新增会话数（同一次会话只计一次）。
 */
export function countNewDescendants({ rootSessionIds, headers, degChildren, frozenMembers }) {
  const index = buildSessionChildIndex(headers, degChildren);
  const frozen = new Set();
  for (const sessionId of frozenMembers ?? []) {
    const id = readId(sessionId);
    if (id !== undefined) frozen.add(id);
  }
  const fresh = new Set();
  for (const rootId of uniqueRootIds(rootSessionIds)) {
    for (const memberId of collectSessionSubtree(index, rootId)) fresh.add(memberId);
  }
  let added = 0;
  for (const sessionId of fresh) {
    if (!frozen.has(sessionId)) added += 1;
  }
  return added;
}

/**
 * 聚合五态结果并给出守恒结论（**纯函数**）。
 *
 * `conserved` 为假的两种可能都被如实报出：未知状态（`unknown` 列出其会话 ID）与数量
 * 不符（作业漏处理或多处理）。诚实报错优于把差额悄悄算进某个状态。
 *
 * @param {Array<{state: string, sessionId?: string}>} results - 逐目标结果。
 * @param {number} targetCount - 冻结计划里的 T。
 * @returns {{counts: object, total: number, targetCount: number, conserved: boolean, unknown: string[]}}
 *   聚合结果；`total` 是五个状态计数之和。
 */
export function summarizeDeleteResults(results, targetCount) {
  const list = Array.isArray(results) ? results : [];
  const counts = {};
  for (const state of RESULT_STATES) counts[state] = 0;
  const unknown = [];
  for (const result of list) {
    const state = result?.state;
    if (typeof state === "string" && Object.hasOwn(counts, state)) {
      counts[state] += 1;
      continue;
    }
    const sessionId = readId(result?.sessionId);
    unknown.push(sessionId ?? "<unknown>");
  }
  const total = RESULT_STATES.reduce((sum, state) => sum + counts[state], 0);
  const expected = Number.isInteger(targetCount) && targetCount >= 0 ? targetCount : 0;
  return { counts, total, targetCount: expected, conserved: total === expected && unknown.length === 0, unknown };
}
