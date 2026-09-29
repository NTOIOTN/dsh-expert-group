/**
 * Host 关注点模块：root/child 血缘与 fan-out 父任务 ownership。
 *
 * 接管原先散落在 apply 里的 root 代际表（current/known/generation token）、
 * fan-out 父任务 -> 父会话/父 Agent 映射、deferred 任务索引与父任务 id 分配。
 * 这些索引只保存寻址关系，不复制 task/result 数据；完整状态仍由 fan-out manager 持有。
 *
 * 依赖全部注入，模块不读取 index.js 的闭包变量，也不创建 DSH 服务。
 *
 * @module dsh-expert-group/host/lineage
 */

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * @param {object} options
 * @param {WeakSet} [options.disposedRoots] - 已销毁 root 的 exact 对象集合（由组合根持有）。
 * @param {Function} options.isRootAgent - 判断对象是否是根 Agent 身份。
 * @param {Function} options.getAgent - agents.get(id)。
 * @param {Function} [options.getTask] - fan-out manager.getTask(id)（用于 id 冲突检测）。
 * @param {Function} [options.listTasks] - fan-out manager.listTasks()。
 * @param {Function} [options.now] - 时钟，默认 Date.now。
 */
export function createLineageModule({
  disposedRoots,
  isRootAgent,
  getAgent,
  getTask = () => null,
  listTasks = () => [],
  now = Date.now,
  isGenerationBlocked = () => false,
} = {}) {
  if (typeof isRootAgent !== "function") throw new TypeError("createLineageModule 需要 isRootAgent");
  if (typeof getAgent !== "function") throw new TypeError("createLineageModule 需要 getAgent");
  if (typeof now !== "function") throw new TypeError("createLineageModule 需要 now");

  const knownRoots = new WeakSet();
  const currentRoots = new Map();
  const generationTokens = new WeakMap();
  const parentSessions = new Map();
  const parentAgents = new Map();
  /**
   * parentTaskId -> 绑定时父 Agent 的 generation token（exact 对象 + 活跃代际证据）。
   *
   * 为什么需要它：`parentSessions/parentAgents` 只回答「这个任务属于哪个会话/哪个对象」，
   * 无法区分「绑定时的那一代 root」与「同 id 的 replacement」。续作（continuation）是**写**
   * 权限，只能在「当前调用者就是绑定时那一代 live root」时才授予：
   * - 同一 root 存活：token.agent === 调用者 且 isLiveGeneration(token) 为真；
   * - root 被销毁/替换：token.active 被置 false 或 isLiveRoot 失败 → 拒绝；
   * - 冷恢复后只从持久化 parentSessions 重建（restoreParentSessions）时不铸 token →
   *   没有 exact 代际证据 → 续作 fail-closed（只允许寻址/读取）。
   */
  const parentTokens = new Map();
  const deferredTasks = new Map();
  const deferredParents = new Map();
  let sequence = 0;
  let disposed = false;

  const isDisposed = (agent) => disposedRoots !== undefined && disposedRoots !== null && disposedRoots.has(agent);

  const api = {
    // ── root 代际 ──────────────────────────────────────────────────────────
    /** 登记 root 为当前代际，并分配（或复用）其 generation token。 */
    activateRoot(agent) {
      if (!isRootAgent(agent) || !isNonEmptyString(agent?.id)) return void 0;
      knownRoots.add(agent);
      currentRoots.set(agent.id, agent);
      return api.tokenFor(agent);
    },
    /** 当前代际的 exact root 对象。 */
    activeRoot(id) {
      return isNonEmptyString(id) ? currentRoots.get(id) : void 0;
    },
    /** 该对象是否是当前代际 root（同 id 的新 root 会取代旧对象）。 */
    isCurrentRoot(agent) {
      return isRootAgent(agent) && isNonEmptyString(agent?.id) && currentRoots.get(agent.id) === agent;
    },
    /** root replacement/dispose 时移除当前代际映射。 */
    releaseRoot(agent) {
      if (!isNonEmptyString(agent?.id)) return false;
      if (currentRoots.get(agent.id) !== agent) return false;
      currentRoots.delete(agent.id);
      return true;
    },
    /** 是否曾经是本插件的 root（用于 dispose 判定）。 */
    isKnownRoot: (agent) => knownRoots.has(agent),
    /** exact root 对象的 generation token；非 root 返回 undefined。 */
    tokenFor(agent) {
      if (!isRootAgent(agent)) return void 0;
      let token = generationTokens.get(agent);
      if (token === void 0) {
        token = { agent, active: true };
        generationTokens.set(agent, token);
      }
      return token;
    },
    /** 只读查询：不创建 token。 */
    tokenOf(agent) {
      return generationTokens.get(agent);
    },
    /** token 仍是该 exact root 的活跃代际。 */
    isLiveGeneration(agent, token) {
      // 组合根可注入阻塞谓词（卸载/handoff 停止）；一旦阻塞，旧 token 立即失效。
      if (isGenerationBlocked()) return false;
      return token !== void 0 && token.agent === agent && token.active === true
        && generationTokens.get(agent) === token && api.isLiveRoot(agent);
    },
    /** root 仍在当前代际且未被销毁（与 index.js 旧 isLiveRootAgent 等价）。 */
    isLiveRoot(agent) {
      return isRootAgent(agent)
        && !isDisposed(agent)
        && isNonEmptyString(agent?.id)
        && currentRoots.get(agent.id) === agent
        && getAgent(agent.id) === agent;
    },
    isDisposed,
    /** 标记 exact 对象已销毁；token 同时失活。 */
    markDisposed(agent) {
      if (agent === null || typeof agent !== "object") return false;
      disposedRoots?.add?.(agent);
      const token = generationTokens.get(agent);
      if (token !== void 0) token.active = false;
      return true;
    },
    knownRootCount: () => currentRoots.size,

    // ── fan-out 父任务 ownership ────────────────────────────────────────────
    /**
     * 绑定父任务到父会话/父 Agent，并记录绑定时的 generation token。
     *
     * token 只在**绑定当时**由该 exact parentAgent 铸造（或外部显式传入），之后不再刷新：
     * 只有它仍然 `isLiveGeneration` 时，这个任务的可写权限（续作）才成立。这样同 id 的
     * replacement 即使让 `getAgent(id)` 指向新对象，也拿不到旧任务的可写权限。
     */
    bindParentTask({ parentTaskId, parentId, parentAgent, token } = {}) {
      if (!isNonEmptyString(parentTaskId) || !isNonEmptyString(parentId)) return false;
      parentSessions.set(parentTaskId, parentId);
      if (parentAgent !== undefined && parentAgent !== null) {
        parentAgents.set(parentTaskId, parentAgent);
        const recorded = token !== undefined && token !== null ? token : api.tokenFor(parentAgent);
        if (recorded !== undefined && recorded !== null) parentTokens.set(parentTaskId, recorded);
        else parentTokens.delete(parentTaskId);
      }
      deferredTasks.delete(parentTaskId);
      deferredParents.delete(parentTaskId);
      return true;
    },
    /** 绑定时的 exact generation token；无证据（未绑定/只从快照恢复寻址）返回 undefined。 */
    parentTokenOf: (parentTaskId) => (isNonEmptyString(parentTaskId) ? parentTokens.get(parentTaskId) : void 0),
    /** 父 Agent：缓存失效（被替换）时按 parentId 重新解析。 */
    parentAgentOf(parentTaskId) {
      const cached = parentAgents.get(parentTaskId);
      if (cached !== undefined && getAgent(cached.id) === cached) return cached;
      const parentId = parentSessions.get(parentTaskId);
      if (!isNonEmptyString(parentId)) return void 0;
      const parent = getAgent(parentId);
      if (parent !== void 0) parentAgents.set(parentTaskId, parent);
      return parent;
    },
    /** 为父任务分配稳定、单调、与既有任务不冲突的 id。 */
    allocateParentTaskId(parent) {
      if (!isNonEmptyString(parent?.id)) throw new TypeError("allocateParentTaskId 需要带 id 的父 Agent");
      let candidate;
      do {
        sequence += 1;
        candidate = "fanout-" + parent.id + "-" + now().toString(36) + "-" + sequence.toString(36);
      } while (getTask(candidate) !== null);
      return candidate;
    },
    /** 释放单个父任务的全部寻址关系（历史仍由 manager 保留）。 */
    releaseParentTask(parentTaskId) {
      const removed = parentSessions.delete(parentTaskId);
      parentAgents.delete(parentTaskId);
      parentTokens.delete(parentTaskId);
      deferredTasks.delete(parentTaskId);
      deferredParents.delete(parentTaskId);
      return removed;
    },
    /** root replacement/dispose 后摘除该 Agent 的 fan-out ownership。 */
    releaseAgent(agent) {
      if (agent === undefined || agent === null || !isNonEmptyString(agent.id)) return 0;
      let removed = 0;
      for (const [parentTaskId, recordedAgent] of [...parentAgents]) {
        if (recordedAgent === agent) {
          api.releaseParentTask(parentTaskId);
          removed += 1;
        }
      }
      for (const [parentTaskId, parentId] of [...parentSessions]) {
        if (parentId === agent.id && !parentAgents.has(parentTaskId)) {
          api.releaseParentTask(parentTaskId);
          removed += 1;
        }
      }
      for (const [parentTaskId, parentId] of [...deferredParents]) {
        if (parentId === agent.id) {
          api.releaseParentTask(parentTaskId);
          removed += 1;
        }
      }
      return removed;
    },
    /**
     * 从持久化快照恢复 parentSessions 索引（只接受非空字符串对）。
     *
     * 这里**只恢复寻址**（读路径/RPC 归属过滤），不铸造 generation token：冷恢复后的
     * 任务是否可写（续作）必须由后续的真实绑定（`bindParentTask`，带 live root 的 exact
     * token）决定，否则同 id replacement 会继承旧任务的可写权限。
     */
    restoreParentSessions(snapshot) {
      const source = snapshot?.parentSessions;
      if (source === null || typeof source !== "object" || Array.isArray(source)) return 0;
      let restored = 0;
      for (const [parentTaskId, parentId] of Object.entries(source)) {
        if (!isNonEmptyString(parentTaskId) || !isNonEmptyString(parentId)) continue;
        parentSessions.set(parentTaskId, parentId);
        const parent = getAgent(parentId);
        if (parent !== void 0) parentAgents.set(parentTaskId, parent);
        // 不设置 parentTokens：没有绑定当时的 exact 代际证据 → 续作 fail-closed。
        parentTokens.delete(parentTaskId);
        restored += 1;
      }
      return restored;
    },
    /** 快照投影：parentTaskId -> parentSessionId。 */
    parentSessionsSnapshot() {
      const result = {};
      for (const [parentTaskId, parentId] of parentSessions) {
        if (isNonEmptyString(parentTaskId) && isNonEmptyString(parentId)) result[parentTaskId] = parentId;
      }
      return result;
    },
    parentSessionOf: (parentTaskId) => parentSessions.get(parentTaskId),
    /** 缺失 root 的 queued 任务：独立保留，不阻塞其它任务。 */
    deferTask({ parentTaskId, parentId, task } = {}) {
      if (!isNonEmptyString(parentTaskId)) return false;
      deferredTasks.set(parentTaskId, task);
      if (isNonEmptyString(parentId)) deferredParents.set(parentTaskId, parentId);
      return true;
    },
    deferredTaskOf: (parentTaskId) => deferredTasks.get(parentTaskId),
    deferredTasks: () => [...deferredTasks.values()],
    deferredParentOf: (parentTaskId) => deferredParents.get(parentTaskId),
    /** RPC/反馈使用的 ownership 查询：只有当前代际映射才算归属。 */
    resolveOwner(parentTaskId) {
      return isNonEmptyString(parentTaskId) ? parentSessions.get(parentTaskId) : void 0;
    },
    tasksOwnedBy(sessionId) {
      if (!isNonEmptyString(sessionId)) return [];
      return listTasks().filter((task) => api.resolveOwner(task?.parentTaskId) === sessionId);
    },
    describe() {
      return {
        currentRoots: currentRoots.size,
        parentTasks: parentSessions.size,
        deferredTasks: deferredTasks.size,
        disposed,
      };
    },
    dispose() {
      disposed = true;
      currentRoots.clear();
      parentSessions.clear();
      parentAgents.clear();
      parentTokens.clear();
      deferredTasks.clear();
      deferredParents.clear();
      sequence = 0;
    },
  };
  return Object.freeze(api);
}
