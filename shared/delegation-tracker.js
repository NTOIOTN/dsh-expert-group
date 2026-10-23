/**
 * 委派任务追踪器。
 *
 * 按 parent+role 维护任务记忆的 LRU 与 TTL，并提供范围预检、活动任务与快照能力。
 * 本文件由原 `shared.js` 的 1111–1683 区段拆出（R1 票据 05）；R2.5-B 补票再把
 * 状态容器与无状态判定分开，使 `createDelegationTracker` 工厂守住 400 行硬上限。
 *
 * ## 三段分工（状态仍然只有一个 owner，全部留在本文件内）
 * 1. **模块级纯函数**（不导出）：`normalizeTrackerOptions`、`copyActiveTask`、
 *    `stringSet`、`scopeWarningFor`、`listTasksForParent`、
 *    `matchingActiveTaskIdsForTurn`、`evaluateActiveTaskScope`、
 *    `taskRecordExpired`、`buildTaskBinding`、`shouldKeepTaskRecord`、
 *    `countActiveTasks`、`summarizeDetachedTasks`。它们不读也不写任何模块级变量，
 *    输入全部显式给出（`activeTasks` 只以**值 / 条目迭代器**传入，不接收 Map 本身）。
 * 2. **`createTrackerState`**：唯一状态容器，独占 `scopes` / `parentQueues` /
 *    `activeTasks` / `activeTaskSeq`，对外只交「命令」与「只读投影」，不交出 Map / Set。
 * 3. **`createDelegationTracker`**：公开工厂，只做参数归一与装配转发。
 *
 * ## 状态形状
 * - `scope -> { childId, routeKey, tasks: Map(key -> { childId?, routeKey?, at }), queue }`；
 *   `tasks` 的插入序就是 LRU 序（重复 `rememberTask` 先删后插刷新位置）。
 * - `scope.childId` 只表示「本 scope 最近一次新建/恢复的 child」，用于诊断、快照恢复
 *   与 route 变更判定，**不再**表示「本 scope 唯一的可复用 child」：同一 parent+role 下
 *   允许多个独立 child 并存，每个任务 key 通过 `tasks` 表绑定到它自己的 child。
 * - `parentQueues`：只保护「范围预检 + 登记 + 绑定」这个短临界区，不串行专家执行。
 * - `activeTasks`：`activityId -> 活动任务范围`；仅当前插件进程内存，不写入 settings
 *   或跨会话存储。
 *
 * ## 活动项与 detached 规则（票据 07）
 * root 销毁 / 根代际退休都不是停止证据：活动项保留并标记 `detached`、移除 `parentAgent`
 * 强引用（`parentId` 保留），继续按同一 parentId 阻塞同路径新任务，直到该 child 自己的
 * 权威停止证据（child turn/end 或 child disposal）到达。
 * owner 过滤：只有当两边都能给出 owner 且**不是同一个**时才拒绝释放；detached 项已经
 * 没有 parentAgent，不能据此判为「别的 generation」而永久拒绝释放。
 *
 * @module dsh-expert-group/shared/delegation-tracker
 */
import { affectedPathEntriesOverlap, normalizeAffectedPaths } from "./affected-paths.js";
import { TASK_TTL_DEFAULT_MS, taskRecordAt, taskRecordChildId } from "./pending-creation.js";
import { isSubagentCapacityError } from "./capacity-errors.js";

// ── 模块级纯函数（无状态判定与只读投影；均为 module-private，不导出） ──────

/**
 * 归一跟踪器配置（纯函数：只返回新对象，不读任何模块级状态）。
 *
 * - `taskLimit`：任务记忆 LRU 上限；非正安全整数回落到 32，防止长期运行的内存增长；
 * - `taskTtlMs`：任务指纹 TTL；非正有限毫秒回落到 `TASK_TTL_DEFAULT_MS`（10 分钟）；
 * - `now`：时钟注入，默认真实时钟；测试传 `now()` 伪造时钟即可验证过期，无需真实等待。
 *
 * @param {object} [options] - 可选配置。
 * @returns {{taskLimit:number, taskTtlMs:number, now:()=>number}} 归一后的配置。
 */
function normalizeTrackerOptions(options = {}) {
  return {
    taskLimit: Number.isSafeInteger(options?.taskLimit) && options.taskLimit > 0 ? options.taskLimit : 32,
    taskTtlMs: Number.isFinite(options?.taskTtlMs) && options.taskTtlMs > 0 ? options.taskTtlMs : TASK_TTL_DEFAULT_MS,
    now: typeof options?.now === "function" ? options.now : () => Date.now(),
  };
}

/**
 * 复制活动项快照（纯函数）。
 *
 * 副本**不携带** parentAgent：它是 live root Agent 的强引用，只用于内部 owner 过滤
 * （completeActiveTasksForChild），不得经 listActiveTasks / 诊断 / 工具回执外泄。
 * detached 统一归一为布尔值，保证「是否已脱离 root」在快照里始终可读。
 *
 * @param {object} task - 内部活动项。
 * @returns {object} 可外泄的快照副本。
 */
function copyActiveTask(task) {
  const { parentAgent: _parentAgent, ...rest } = task;
  return {
    ...rest,
    detached: task.detached === true,
    affectedPaths: task.affectedPaths.map((path) => ({ ...path })),
  };
}

/**
 * 把可迭代的任务 key 或活动 id 归一为字符串 Set（纯函数），供终态关联复用。
 * 非可迭代输入（null / undefined / 标量）返回空 Set，调用方无需自己判空。
 *
 * @param {Iterable<string>|null|undefined} values - 待归一的集合。
 * @returns {Set<string>} 只含字符串的新 Set。
 */
function stringSet(values) {
  const result = new Set();
  if (values === null || values === void 0 || typeof values[Symbol.iterator] !== "function") return result;
  for (const value of values) {
    if (typeof value === "string") result.add(value);
  }
  return result;
}

/**
 * 生成受影响路径冲突的 advisory 文案（纯函数）。
 *
 * 只给建议、不做判定：缺少范围（新任务或既有任务）时如实说明「检查无法完成」，
 * 存在交集时说明是否因 allowOverlap=true 才继续。
 *
 * @param {Array<{task: object, overlaps: Array<object>}>} conflicts - 冲突项。
 * @param {Array<object>} missing - 缺少 affectedPaths 的活动任务。
 * @param {boolean} allowOverlap - 调用方是否显式允许重叠。
 * @param {boolean} [missingIncoming] - 新任务自身是否缺少 affectedPaths 声明。
 * @returns {string} 以空格拼接的 advisory；无内容时为空串。
 */
function scopeWarningFor(conflicts, missing, allowOverlap, missingIncoming = false) {
  const parts = [];
  if (conflicts.length > 0) {
    const details = conflicts.map(({ task, overlaps }) => {
      const label = task.description.length > 0 ? task.description : task.taskKey;
      const ranges = overlaps.map(({ incoming, active }) => incoming.value + " <-> " + active.value).join(", ");
      return task.role + " (" + label + "): " + ranges;
    }).join("; ");
    parts.push("Affected-path conflict advisory: this task overlaps active expert work: " + details + "." + (allowOverlap === true
      ? " Continuing only because allowOverlap=true was explicitly set."
      : " It was not started; set allowOverlap=true only after explicitly deciding that the overlap is safe."));
  }
  if (missingIncoming === true) {
    parts.push("Affected-path conflict check cannot be completed because the new task is missing affectedPaths.");
  }
  if (missing.length > 0) {
    const labels = missing.map((task) => task.role + " (" + (task.description.length > 0 ? task.description : task.taskKey) + ")").join(", ");
    parts.push("Affected-path conflict check cannot be completed because affectedPaths is missing for " + labels + ".");
  }
  return parts.join(" ");
}

/**
 * 只读投影：某个父代理的活动任务（保持 activeTasks 的插入序）。
 *
 * 接收的是**任务值迭代器**而不是 Map 本身：调用方（owner）决定迭代范围，
 * 纯函数不持有也不返回状态容器。
 *
 * @param {Iterable<object>} tasks - 任务值迭代器。
 * @param {string} parentId - 父代理 id（内部按 String 归一比较）。
 * @returns {Array<object>} 命中的内部活动项（未复制）。
 */
function listTasksForParent(tasks, parentId) {
  const id = String(parentId);
  const result = [];
  for (const task of tasks) {
    if (task.parentId === id) result.push(task);
  }
  return result;
}

/**
 * 用稳定 admission messageId 优先定位某 child 在本 turn 的活动任务（纯函数）。
 *
 * taskKey 只在消息关联不可用或恢复 op 显式携带 key 时作为辅助：活动登记独立于
 * scope.tasks 的 TTL/LRU 和 recovery record.tasks 的上限，因此任务绑定被淘汰后
 * 仍可按 childId + messageId 精确终态清理。
 *
 * @param {Iterable<[string, object]>} entries - `activeTasks` 的条目迭代器。
 * @param {{parentId?:string, role?:string, childId?:string, turnMsgIds?:Iterable<string>, taskKeys?:Iterable<string>}} [options]
 * @returns {string[]} 命中的 activityId（消息命中优先，否则返回 key 兜底集合）。
 */
function matchingActiveTaskIdsForTurn(entries, { parentId, role, childId, turnMsgIds, taskKeys } = {}) {
  const messageIds = stringSet(turnMsgIds);
  const keys = stringSet(taskKeys);
  const messageMatches = [];
  const keyFallbacks = [];
  for (const [activityId, task] of entries) {
    if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.childId !== childId) continue;
    if (typeof task.messageId === "string" && messageIds.has(task.messageId)) {
      messageMatches.push(activityId);
    } else if (typeof task.messageId !== "string" && keys.has(task.taskKey)) {
      // taskKey 只能兜底尚未获得 admission messageId 的早期竞态。若同 child
      // 已有任何稳定消息命中，绝不按 key 扩大集合，避免 TTL 后同 key 新任务
      // 被旧 turn 误删。
      keyFallbacks.push(activityId);
    }
  }
  return messageMatches.length > 0 ? messageMatches : keyFallbacks;
}

/**
 * 范围预检的**纯判定**：给定父代理的活动任务快照与新任务范围，算出 advisory 结果。
 *
 * 缺少新任务或既有任务范围时只给出 unchecked advisory，不阻止；存在明确交集时
 * 默认 blocked，除非 allowOverlap。判定不触碰状态容器，快照由 owner 传入。
 *
 * @param {Array<object>} activeTasksForParent - 同一父代理的活动任务。
 * @param {{affectedPaths?:Array<object>, allowOverlap?:boolean}} [request] - 新任务范围与放行开关。
 * @returns {object} 含 status / blocked / warning / conflicts / missing 的结果对象。
 */
function evaluateActiveTaskScope(activeTasksForParent, { affectedPaths, allowOverlap = false } = {}) {
  const normalizedAffectedPaths = normalizeAffectedPaths(affectedPaths);
  const missing = [];
  const conflicts = [];
  if (normalizedAffectedPaths.length === 0) {
    // 当前任务没有可比范围：这是新任务自身缺少声明，不能把已声明范围的
    // 活动任务误报为缺失；仍只返回 unchecked advisory，不阻断派发。
    return {
      status: "unchecked",
      blocked: false,
      warning: scopeWarningFor([], [], allowOverlap, true),
      affectedPaths: normalizedAffectedPaths,
      conflicts: [],
      missing: [],
      missingIncoming: true,
    };
  }
  for (const task of activeTasksForParent) {
    if (task.affectedPaths.length === 0) {
      missing.push(task);
      continue;
    }
    const overlaps = [];
    for (const incoming of normalizedAffectedPaths) {
      for (const activePath of task.affectedPaths) {
        if (affectedPathEntriesOverlap(incoming, activePath)) overlaps.push({ incoming, active: activePath });
      }
    }
    if (overlaps.length > 0) conflicts.push({ task, overlaps });
  }
  const blocked = conflicts.length > 0 && allowOverlap !== true;
  return {
    status: conflicts.length > 0 ? "conflict" : missing.length > 0 ? "unchecked" : "clear",
    blocked,
    warning: scopeWarningFor(conflicts, missing, allowOverlap),
    affectedPaths: normalizedAffectedPaths,
    conflicts: conflicts.map(({ task, overlaps }) => ({
      task: copyActiveTask(task),
      overlaps: overlaps.map(({ incoming, active }) => ({ incoming: { ...incoming }, active: { ...active } })),
    })),
    missing: missing.map(copyActiveTask),
  };
}

/**
 * 任务记录是否已过期（纯函数）：`now - at >= ttl` 即过期（相等按过期处理）。
 *
 * @param {object} record - 任务记录（含 `at`）。
 * @param {number} nowMs - 当前时刻。
 * @param {number} ttlMs - TTL 毫秒。
 * @returns {boolean} 过期返回 true。
 */
function taskRecordExpired(record, nowMs, ttlMs) {
  return nowMs - taskRecordAt(record) >= ttlMs;
}

/**
 * 构造一条任务记忆（纯函数）。
 *
 * childId / routeKey 缺省时沿用既有绑定：重复记忆只刷新时间，不丢归属；
 * 两条绑定都缺省时只记时间（沿用旧的 scope 级去重语义）。
 *
 * @param {object|undefined} previous - 该 key 上一条记录。
 * @param {{childId?:string, routeKey?:string}} [request] - 本次显式给出的绑定。
 * @param {number} at - 记住时刻。
 * @returns {{at:number, childId?:string, routeKey?:string}} 新记录（新对象）。
 */
function buildTaskBinding(previous, { childId, routeKey } = {}, at) {
  const binding = { at };
  const boundChildId = typeof childId === "string" && childId.length > 0 ? childId : taskRecordChildId(previous);
  if (boundChildId !== void 0) binding.childId = boundChildId;
  const boundRouteKey = typeof routeKey === "string" && routeKey.length > 0
    ? routeKey
    : (typeof previous?.routeKey === "string" ? previous.routeKey : void 0);
  if (boundRouteKey !== void 0) binding.routeKey = boundRouteKey;
  return binding;
}

/**
 * route/child 变更后是否保留一条任务记忆（纯谓词；删除循环仍留在 owner 内）。
 *
 * 保留条件一：仍绑定到本 route 上某个具体 child —— 同 route 下并存的其他独立 child
 * （以及被替换 child 自己的任务）都必须能被相同 prompt 复用。
 * 保留条件二：同 route 且绑定信息不完整（旧格式/旧写入点）—— route 没有变化，
 * 旧语义的任务去重仍然成立。
 * 其余情况（route 已变、或记录指向别的不再可验证的 child）一律清理。
 *
 * @param {object} record - 任务记录。
 * @param {string} routeKey - 当前 route。
 * @param {boolean} sameRoute - 新 route 是否与旧 route 相同。
 * @returns {boolean} 保留返回 true。
 */
function shouldKeepTaskRecord(record, routeKey, sameRoute) {
  const owner = taskRecordChildId(record);
  const ownerRoute = typeof record?.routeKey === "string" ? record.routeKey : void 0;
  if (owner !== void 0 && ownerRoute === routeKey) return true;
  return sameRoute && ownerRoute === void 0;
}

/**
 * 只读计数（纯函数）：活动范围总数与其中已脱离 root 的数量（运行时诊断用）。
 *
 * @param {Iterable<object>} tasks - 任务值迭代器。
 * @returns {{total:number, detached:number}} 计数结果（新对象）。
 */
function countActiveTasks(tasks) {
  let total = 0;
  let detached = 0;
  for (const task of tasks) {
    total += 1;
    if (task.detached === true) detached += 1;
  }
  return { total, detached };
}

/**
 * 只读诊断投影（纯函数）：列出已脱离 root 的活动范围。
 *
 * 刻意不返回 parentAgent、description、prompt 或 affectedPaths 原文：这里只回答
 * 「哪个 child / 角色 / 任务仍持有保护、是否已脱离 root」，供诊断与人工排查使用。
 *
 * @param {Iterable<object>} tasks - 任务值迭代器。
 * @returns {Array<{activityId:string, parentId:string, role:string, taskKey:string, childId?:string, messageId?:string, detached:true}>}
 */
function summarizeDetachedTasks(tasks) {
  const result = [];
  for (const task of tasks) {
    if (task.detached !== true) continue;
    result.push({
      activityId: task.id,
      parentId: task.parentId,
      role: task.role,
      taskKey: task.taskKey,
      ...(typeof task.childId === "string" ? { childId: task.childId } : {}),
      ...(typeof task.messageId === "string" ? { messageId: task.messageId } : {}),
      detached: true,
    });
  }
  return result;
}

// ── 状态容器（本文件唯一 owner） ──────────────────────────────────────────

/**
 * 委派跟踪器的**唯一**状态容器。
 *
 * 独占四份可变状态（`scopes` / `parentQueues` / `activeTasks` / `activeTaskSeq`），
 * 对外只交命令与只读投影：调用方拿不到 Map / Set，也无法绕过命令面直接改状态。
 * 所有改动集中在本闭包内，模块级纯函数只接收值/条目迭代器与显式参数。
 *
 * 多 child 语义：同一 parent+role 下不同任务各自拥有独立 child，相同任务复用
 * 它原来那个 child；因此按任务定位必须走 getTaskChild，而不是 getChild。
 *
 * @param {{taskLimit:number, taskTtlMs:number, now:()=>number}} config - 已归一的配置。
 * @returns {object} 命令 / 只读投影面。
 */
function createTrackerState({ taskLimit, taskTtlMs, now }) {
  /**
   * scope -> { childId, routeKey, tasks: Map(key -> { childId, routeKey, at }, 插入序=LRU), queue: Promise 链 }
   *
   * scope.childId 只表示「本 scope 最近一次新建/恢复的 child」，用于诊断、快照恢复
   * 与 route 变更判定，**不再**表示「本 scope 唯一的可复用 child」：同一 parent+role
   * 下允许多个独立 child 并存，每个任务 key 通过 tasks 表绑定到它自己的 child。
   */
  const scopes = new Map();
  /** parentId -> Promise：只保护范围预检和登记这个短临界区，不串行专家实际执行。 */
  const parentQueues = new Map();
  /** activityId -> 活动任务范围；仅当前插件进程内存，不写入 settings 或跨会话存储。 */
  const activeTasks = new Map();
  let activeTaskSeq = 0;

  /**
   * 取或创建 scope 记录（本文件唯一的 scope 写入口）。
   *
   * 返回值只在 owner 内部使用：调用方拿到的是命令，不是这条记录。
   */
  function entryOf(scope) {
    let entry = scopes.get(scope);
    if (entry === void 0) {
      entry = { childId: void 0, routeKey: void 0, tasks: new Map(), queue: Promise.resolve() };
      scopes.set(scope, entry);
    }
    return entry;
  }

  return {
    /**
     * 同 scope FIFO 串行临界区：callback 依次执行，前一个失败不影响后一个。
     * index.js 在临界区内完成「复用/排队/新建」判定，杜绝并发重复 start。
     */
    async serialize(scope, callback) {
      const entry = entryOf(scope);
      const run = entry.queue.then(callback, callback);
      entry.queue = run.catch(() => {});
      return run;
    },

    /**
     * 按父代理短暂串行范围预检和登记。回调不得在其中 await 专家执行；因此独立
     * 任务完成登记后仍可并行运行，同时不会出现两个角色同时看见空登记表的竞态。
     */
    async serializeParent(parentId, callback) {
      const key = String(parentId);
      const previous = parentQueues.get(key) ?? Promise.resolve();
      const run = previous.then(callback, callback);
      parentQueues.set(key, run.catch(() => {}));
      return run;
    },

    /**
     * 检查新任务与同一父代理下的活动范围。缺少新任务或既有任务范围时只给出
     * unchecked advisory，不阻止；存在明确交集时默认 blocked，除非 allowOverlap。
     * 判定本身是模块级纯函数，本方法只取快照并转发。
     */
    checkActiveTaskScope({ parentId, affectedPaths, allowOverlap = false } = {}) {
      const active = listTasksForParent(activeTasks.values(), parentId);
      return evaluateActiveTaskScope(active, { affectedPaths, allowOverlap });
    },

    /** 将已通过预检的任务登记为活动任务；返回不可变快照。 */
    registerActiveTask({ parentId, parentAgent, role, taskKey, description, affectedPaths, childId } = {}) {
      const task = {
        id: "activity-" + (++activeTaskSeq),
        parentId: String(parentId ?? ""),
        ...(parentAgent !== void 0 ? { parentAgent } : {}),
        role: String(role ?? ""),
        taskKey: String(taskKey ?? ""),
        description: typeof description === "string" ? description : "",
        affectedPaths: normalizeAffectedPaths(affectedPaths),
        ...(typeof childId === "string" && childId.length > 0 ? { childId } : {}),
        // 新登记的活动项仍由当前 root generation 持有；只有 dropParent（root 销毁/
        // 代际退休）会把它转为 detached，且转换本身**不**释放保护。
        detached: false,
      };
      activeTasks.set(task.id, task);
      return copyActiveTask(task);
    },

    /**
     * 在 child/message admission 已知时回填活动登记。messageId 是独立于任务
     * fingerprint 与 record.tasks 的稳定终态关联：两者被 TTL/LRU 淘汰后，turn/end
     * 仍可按 childId + messageId 精确完成这一个活动任务。
     */
    bindActiveTask(activityId, childId, messageId) {
      const task = activeTasks.get(activityId);
      if (task === void 0) return false;
      if (typeof childId === "string" && childId.length > 0) task.childId = childId;
      if (typeof messageId === "string" && messageId.length > 0) task.messageId = messageId;
      return typeof task.childId === "string" && task.childId.length > 0;
    },

    /**
     * inbox claim 早于 admission 返回时，按 taskKey 只补回第一个尚未拥有稳定
     * messageId 的活动项。Map 保持插入序：同 child 同 key 的旧任务已绑定 m_old
     * 时绝不覆盖它；一个 claimed message 也不能绑定多个活动项。
     */
    bindActiveTasksByTaskKey({ parentId, role, childId, taskKey, messageId } = {}) {
      if (typeof childId !== "string" || childId.length === 0 || typeof taskKey !== "string" || typeof messageId !== "string" || messageId.length === 0) return 0;
      for (const task of activeTasks.values()) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.childId !== childId || task.taskKey !== taskKey) continue;
        if (typeof task.messageId === "string" && task.messageId.length > 0) continue;
        task.messageId = messageId;
        return 1;
      }
      return 0;
    },

    /** 返回本 turn 命中的活动 id，供恢复 op 在原绑定被淘汰后仍保留终态关联。 */
    activeTaskIdsForTurn(options) {
      return matchingActiveTaskIdsForTurn(activeTasks.entries(), options);
    },

    /** 通过稳定活动 id 终态清理，避免同 child 的其他活动任务被误删。 */
    completeActiveTasksByIds(activityIds) {
      let count = 0;
      for (const activityId of stringSet(activityIds)) {
        if (activeTasks.delete(activityId)) count += 1;
      }
      return count;
    },

    /** 按 childId + turn message ids（taskKey 仅辅助）终态清理命中的活动项。 */
    completeActiveTasksForTurn(options) {
      let count = 0;
      for (const activityId of matchingActiveTaskIdsForTurn(activeTasks.entries(), options)) {
        if (activeTasks.delete(activityId)) count += 1;
      }
      return count;
    },

    /** 释放尚未 admission 成功的活动登记，避免失败请求留下永久冲突。 */
    releaseActiveTask(activityId) {
      return activeTasks.delete(activityId);
    },

    /** 按任务终态移除精确的活动登记；childId 可选以保护旧 route 的迟到事件。 */
    completeActiveTask({ parentId, role, taskKey, childId } = {}) {
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.taskKey !== String(taskKey ?? "")) continue;
        if (childId !== void 0 && task.childId !== childId) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /** child 或其恢复记录被确定清理时移除该 child 的全部活动登记（owner 过滤见文件头）。 */
    completeActiveTasksForChild(childId, parentId, parentAgent) {
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.childId !== childId || (parentId !== void 0 && task.parentId !== String(parentId))) continue;
        if (parentAgent !== void 0 && task.parentAgent !== void 0 && task.parentAgent !== parentAgent) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /** 只读计数：活动范围总数与其中已脱离 root 的数量（运行时诊断用）。 */
    activeTaskCounts() {
      return countActiveTasks(activeTasks.values());
    },

    /**
     * 只读诊断：列出已脱离 root 的活动范围。
     *
     * 刻意不返回 parentAgent、description、prompt 或 affectedPaths 原文：这里只回答
     * 「哪个 child/角色/任务仍持有保护、是否已脱离 root」，供诊断与人工排查使用。
     */
    listDetachedActiveTasks() {
      return summarizeDetachedTasks(activeTasks.values());
    },

    /**
     * 释放「已脱离 root」的活动范围——root 销毁/代际退休后唯一可用的证据入口。
     *
     * 证据边界（票据 07）：
     * - 提供非空 turnMsgIds：只释放该 child 本 turn 稳定 messageId 命中的活动项
     *   （child turn/end 证据）；
     * - 省略/空 turnMsgIds：释放该 child 的全部 detached 活动项（权威 child disposal）。
     * 未绑定 messageId 的活动项（admission 竞态）不会被 turn/end 误删，只在 disposal
     * 或后续 turn 的 messageId 命中时释放。
     * @param {string} childId - exact child session id。
     * @param {{turnMsgIds?: Iterable<string>}} [options] - 本 turn 的稳定消息 id 集合。
     * @returns {number} 实际释放条数。
     */
    completeDetachedActiveTasksForChild(childId, { turnMsgIds } = {}) {
      if (typeof childId !== "string" || childId.length === 0) return 0;
      const messageIds = stringSet(turnMsgIds);
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.detached !== true || task.childId !== childId) continue;
        if (messageIds.size > 0 && (typeof task.messageId !== "string" || !messageIds.has(task.messageId))) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /**
     * 重建或 followup recovery 后把相关活动项改绑到替代 child/恢复消息。优先
     * 使用 recovery op 保存的 activityIds；taskKeys 仅兼容旧记录或早期竞态。
     */
    rebindActiveTasks({ parentId, role, oldChildId, newChildId, messageId, taskKeys, activityIds } = {}) {
      const keys = stringSet(taskKeys);
      const ids = stringSet(activityIds);
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "")) continue;
        if (task.childId !== oldChildId || (!ids.has(activityId) && !keys.has(task.taskKey))) continue;
        task.childId = newChildId;
        if (typeof messageId === "string" && messageId.length > 0) task.messageId = messageId;
        count += 1;
      }
      return count;
    },

    /** 为 node:test 和可观测告警提供当前父代理的活动任务快照。 */
    listActiveTasks(parentId) {
      return listTasksForParent(activeTasks.values(), parentId).map(copyActiveTask);
    },

    /**
     * 读取本 scope 最近一次新建/恢复的 child（诊断、route 判定与快照恢复用）。
     * **不是**「本 scope 唯一 child」：独立任务可能同时存在多个 child，按任务
     * 定位必须使用 getTaskChild / listChildIds。
     */
    getChild(scope) {
      const entry = scopes.get(scope);
      if (entry === void 0 || entry.childId === void 0) return void 0;
      return { childId: entry.childId, routeKey: entry.routeKey };
    },

    /**
     * 记录 scope 最近一次新建/恢复的 child 与其 route。
     *
     * 任务记忆的清理规则（多 child 语义）：只删除「属于被替换 child」或「route 与
     * 新 route 不同」的任务标记——同一 route 下并存的其他独立 child 仍必须能被
     * 相同 prompt 复用，因此普通的新建 child **不得**清空整张任务表。保留判定由
     * 模块级纯谓词 shouldKeepTaskRecord 给出，删除仍在本 owner 内执行。
     */
    setChild(scope, { childId, routeKey }) {
      const entry = entryOf(scope);
      const sameRoute = entry.routeKey === routeKey;
      const replacedChildId = entry.childId;
      if (replacedChildId !== childId || !sameRoute) {
        for (const [taskKey, record] of [...entry.tasks]) {
          if (shouldKeepTaskRecord(record, routeKey, sameRoute)) continue;
          entry.tasks.delete(taskKey);
        }
      }
      entry.childId = childId;
      entry.routeKey = routeKey;
      return entry;
    },

    /**
     * 读取某任务 key 当前绑定的 child；无绑定、已过期或格式非法时返回 undefined。
     * 相同 prompt（归一化后同一 key）据此复用**它自己的** child，而不是本 scope
     * 最近一次新建的 child。
     */
    getTaskChild(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return void 0;
      const record = entry.tasks.get(taskKey);
      if (record === void 0) return void 0;
      if (taskRecordExpired(record, now(), taskTtlMs)) {
        entry.tasks.delete(taskKey);
        return void 0;
      }
      const childId = taskRecordChildId(record);
      if (childId === void 0) return void 0;
      return {
        childId,
        routeKey: typeof record?.routeKey === "string" ? record.routeKey : void 0,
      };
    },

    /** 列出本 scope 记录到的全部 child（诊断/多 child 展示；去重且保持记忆顺序）。 */
    listChildIds(scope) {
      const entry = scopes.get(scope);
      if (entry === void 0) return [];
      const ids = [];
      const seen = new Set();
      if (typeof entry.childId === "string" && entry.childId.length > 0) {
        ids.push(entry.childId);
        seen.add(entry.childId);
      }
      for (const record of entry.tasks.values()) {
        const childId = taskRecordChildId(record);
        if (childId === void 0 || seen.has(childId)) continue;
        seen.add(childId);
        ids.push(childId);
      }
      return ids;
    },

    /** 清除 scope 的 child 记录（可指定 childId：不匹配时不动）；返回是否清除。 */
    clearChild(scope, childId) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      if (childId !== void 0 && entry.childId !== childId) return false;
      scopes.delete(scope);
      return true;
    },

    /**
     * 该 scope 是否已记录过这个（归一化后的）任务 key；过期记录惰性删除。
     * 任务被记住但没有 child 绑定时同样返回 true（旧格式记录/旧语义）。
     */
    hasTask(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      const record = entry.tasks.get(taskKey);
      if (record === void 0) return false;
      // 超过 TTL 的记录视为过期：删除并返回 false，相同 prompt 到期后可再次复用
      // （例如用户修复问题后重试同一任务，不再被永久判为重复）。
      if (taskRecordExpired(record, now(), taskTtlMs)) {
        entry.tasks.delete(taskKey);
        return false;
      }
      return true;
    },

    /**
     * 记住任务 key（LRU：重复记忆刷新位置；超上限淘汰最旧）。值记录记住时刻、
     * 本任务绑定的 child 与 route，供 TTL 判断、相同 prompt 复用与 route 变更清理。
     * 绑定构造由模块级纯函数 buildTaskBinding 给出，LRU 淘汰仍在本 owner 内执行。
     */
    rememberTask(scope, taskKey, { childId, routeKey } = {}) {
      const entry = entryOf(scope);
      const binding = buildTaskBinding(entry.tasks.get(taskKey), { childId, routeKey }, now());
      if (entry.tasks.has(taskKey)) entry.tasks.delete(taskKey);
      entry.tasks.set(taskKey, binding);
      while (entry.tasks.size > taskLimit) {
        const oldest = entry.tasks.keys().next().value;
        entry.tasks.delete(oldest);
      }
    },

    /**
     * 忘记某 scope 的某个任务 key（任务确定失败后调用）：该任务可重新排队/新建，
     * 而不是在 TTL 窗口内被永久判为 reused。不影响 child 记录与其他任务。
     * @returns {boolean} 确实存在并删除了返回 true；未知 key 返回 false。
     */
    forgetTask(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      return entry.tasks.delete(taskKey);
    },

    /**
     * 父代理销毁/root 代际退休时清理 scope 与短队列，但**不释放**影响范围保护
     * （detached 规则见文件头；同 id 新 generation 不继承释放）。
     *
     * 保护的可观测性由 listDetachedActiveTasks / activeTaskCounts 提供。
     * @param {string} parentId - 正在销毁/退休的父代理 id。
     */
    dropParent(parentId) {
      const id = String(parentId);
      const prefix = `${id}::`;
      for (const scope of scopes.keys()) {
        if (scope.startsWith(prefix)) scopes.delete(scope);
      }
      for (const task of activeTasks.values()) {
        if (task.parentId !== id) continue;
        // 只移除 parentAgent 强引用，保留 parentId/role/taskKey/childId/messageId/
        // affectedPaths：同 parentId 的后续 generation 仍会看到这条保护，该 child
        // 自己的权威停止信号仍能按 childId + messageId 精确命中。
        task.detached = true;
        delete task.parentAgent;
      }
      parentQueues.delete(id);
    },
  };
}

// ── 公开工厂（只做装配与转发） ────────────────────────────────────────────

/**
 * 创建轻量委派跟踪器：按 scope（父代理 + 角色）做 FIFO 串行临界区、
 * 记录最近新建/恢复的 child 与其 route（provider/model/reasoningEffort 组合）、
 * 以及「任务 key → 它自己的 child」绑定表与 LRU 记忆（默认上限 32 条）。
 *
 * 工厂本体只做装配与转发：配置归一回 `normalizeTrackerOptions`，状态与命令面归
 * `createTrackerState`（唯一状态 owner），公开方法集合与签名保持原样。
 *
 * @param {object} [options] - 可选配置：
 *   - taskLimit: 任务记忆 LRU 上限（默认 32）；
 *   - taskTtlMs: 任务指纹有效期（毫秒，默认 TASK_TTL_DEFAULT_MS，10 分钟）；
 *     过期记录在 hasTask 时惰性删除；
 *   - now: 时钟注入函数（默认 () => Date.now()），测试可伪造时间验证 TTL，
 *     无需真实等待。
 */
export function createDelegationTracker(options = {}) {
  return createTrackerState(normalizeTrackerOptions(options));
}
