/**
 * Host 关注点模块：root turn 等待登记表（wait ledger / 单状态机）。
 *
 * 背景（用户确认的改造 A）：子代理派发后 root 必须**保持当前 turn 打开**，直到精确
 * 关联的工作真正结束。DSH 会完整 await 工具 execute 的返回，期间 root 的
 * `agent.status` 保持 `running`，而 goal round driver 只在 root `idle` 时才推进
 * 下一轮——因此「保持 turn」本身就等价于旧实现里「pause durable goal」想要达到的
 * 效果，却不需要调用任何 goal API。
 *
 * 本模块是**唯一**的等待账本与状态机：`dsh_expert_group_finalize` 与
 * `agent/turn-stopping` 兜底共用同一份实现，绝不维护两套。
 *
 * ## 释放条件（缺一不可，全部为「明确成立」而非「无法证明」）
 * 1. 该 root 名下没有任何未结算的登记工作（role admission / fan-out attempt）；
 * 2. root-scoped 的后代查询**明确**返回「没有 running 后代」
 *    （`snapshotDescendants` 返回 `known:true` 且 `running` 为空）。
 *
 * 查询失败、返回结构非法、`known !== true`、后代状态未知时一律**继续等待**：
 * unknown 绝不能被当成「无人运行」。本模块**不提供也不接受任何超时**。
 *
 * ## 竞态保护
 * 每次登记/结算/外部活动都会推进 `version`。一次静止判定只有在「异步查询期间
 * version 未变、且登记集仍为空」时才成立；判定成立后仍会在同一同步临界区里
 * 复查一次 version，因此「判定通过」与「真正释放」之间不可能插入新的 dispatch、
 * child 创建或 fanout retry。
 *
 * ## 记录生命周期（单次静止 = 记录销毁）
 * 一条记录在一次**静止收口**后立即被销毁（从登记表移除、监听解除、等待者收口、
 * 对 exact Agent 的强引用清空）。同一 root 之后再次 engage/track/wait 时会建立
 * **全新记录**并重新订阅监听、重新查询——因此第二轮（尤其是
 * `continue_parent_turn` 建立第二个 child）不会因为「旧记录已 released」而永久
 * 悬挂。销毁是不可逆的：在途查询的落地回调看到 `destroyed` 后只做丢弃，绝不会把
 * 已退休记录重新挂回登记表。
 *
 * ## 代际与生命周期
 * 记录以 **exact root Agent 对象**为键（同 id 的 replacement root 无法继承），并
 * 绑定创建时的 generation token。root dispose、代际替换或插件卸载时调用
 * `retire()`：该 root 的等待者立即以 `released:false` 收口、监听器移除、记录删除、
 * Agent 强引用清空；旧代际的迟到事件不会释放新 waiter（记录已不存在，事件只会命中
 * 新对象的新记录）。
 *
 * @module dsh-expert-group/host/turn-wait
 */

/** 工作键的稳定编码：同一逻辑工作重复登记是幂等的。 */
export function turnWaitWorkKey(work) {
  if (work === null || typeof work !== "object") return void 0;
  if (work.kind === "admission") {
    return typeof work.token === "string" && work.token.length > 0 ? "admission:" + work.token : void 0;
  }
  if (work.kind === "fanout") {
    if (typeof work.parentTaskId !== "string" || work.parentTaskId.length === 0) return void 0;
    const attempt = work.attempt;
    return Number.isSafeInteger(attempt) && attempt > 0
      ? "fanout:" + work.parentTaskId + ":" + attempt
      : "fanout:" + work.parentTaskId;
  }
  return void 0;
}

/** 可外部驱动的 promise；只在本模块内部使用。 */
function createDeferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * 创建 root turn 等待登记表。
 *
 * @param {object} options
 * @param {(agent:object)=>boolean} options.isLiveRoot - exact root Agent 是否仍是当前
 *   live root（对象身份 + generation 双重校验由调用方提供）。
 * @param {(rootId:string)=>Promise<{known:boolean,running?:unknown[],runningIds?:Set<string>,reason?:string}>} options.snapshotDescendants
 *   root-scoped 后代查询。**必须**是「明确回答」语义：查询失败/结构非法返回
 *   `known:false`，绝不能返回「空的 running 列表」来冒充已知。
 * @param {(agent:object, snapshot:object)=>void} [options.onKnownSnapshot]
 *   拿到**明确**快照后的可选回调（`known === true` 时）。调用方用它做「完成通知缺失」
 *   的回退结算：只有在明确知道「某个 admission 的 exact child 已不在 running 列表里」
 *   时才允许结算，因此绝不会凭未知状态放行。回调只能**减少**未结算工作；它在
 *   version 复查之后、同一同步临界区内被调用，因此不会与新的登记交错。
 * @param {(agent:object, invalidate:()=>void)=>()=>void} options.subscribe
 *   安装本 root 的活动监听（child 创建 / 状态转 running / dispose），返回移除函数。
 *   调用方必须在**首次状态查询之前**同步安装（本模块保证 subscribe 在第一次
 *   `scheduleCheck` 之前完成）。记录销毁后本模块必定调用返回的移除函数，因此监听
 *   不会跨记录泄漏。
 * @param {(error:unknown)=>void} [options.onError] - 异常记录回调；不得抛出。
 * @returns {object} 登记表 API。
 */
export function createRootTurnWaitRegistry(options = {}) {
  const isLiveRoot = typeof options.isLiveRoot === "function" ? options.isLiveRoot : () => false;
  const snapshotDescendants = typeof options.snapshotDescendants === "function"
    ? options.snapshotDescendants
    : async () => ({ known: false, running: [], reason: "descendant-query-unavailable" });
  const subscribe = typeof options.subscribe === "function" ? options.subscribe : () => () => {};
  const onKnownSnapshot = typeof options.onKnownSnapshot === "function" ? options.onKnownSnapshot : () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};

  /** exact root Agent -> record。Map 会强引用 root，因此 destroy 必须显式删除。 */
  const records = new Map();
  let disposed = false;

  function report(error) {
    try { onError(error); } catch { /* 记录回调自身异常不得改变等待语义 */ }
  }

  /** 释放一条记录的监听器；幂等。 */
  function releaseListeners(record) {
    if (typeof record.unlisten !== "function") return;
    const unlisten = record.unlisten;
    record.unlisten = void 0;
    try { unlisten(); } catch (error) { report(error); }
  }

  /** 以指定结论收口所有等待者；不会重复收口。 */
  function settleWaiters(record, released, reason) {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const waiter of waiters) {
      try {
        waiter.cleanup?.();
        waiter.resolve({ released, reason });
      } catch (error) { report(error); }
    }
  }

  /**
   * **唯一**的记录销毁路径：等待者收口、监听解除、登记表移除、exact Agent 强引用清空。
   *
   * 为什么必须清空引用（问题 4）：`retireRecord` 之后在途的 snapshot Promise 仍持有
   * 这条 record；只要 record 还指向 exact Agent，已退休的 root 就无法被回收。清空
   * `owner`/`agent` 后，任何迟到回调最多只能看到 `destroyed` 并丢弃。
   *
   * 为什么必须从登记表移除（问题 2）：保留「已 released」的记录会让同一 root 的第二轮
   * 等待复用一条监听已解除、且 `scheduleCheck` 会直接早退的记录，从而永久 pending。
   * 销毁后再次 engage/track/wait 会建立全新记录并重新订阅。
   *
   * @param {object} record - 目标记录。
   * @param {boolean} released - 等待结论：静止成立为 true，被取消为 false。
   * @param {string} reason - 稳定原因码（诊断用）。
   */
  function destroyRecord(record, released, reason) {
    if (record.destroyed === true) return;
    record.destroyed = true;
    record.cancelled = released !== true;
    record.released = released === true;
    record.releaseReason = reason;
    record.checking = false;
    record.recheck = false;
    record.inSnapshot = false;
    releaseListeners(record);
    settleWaiters(record, released === true, reason);
    record.works.clear();
    // 先按 owner 摘除，再清空引用：清空后 record 不再能让 Map 保留已退休 Agent。
    const owner = record.owner;
    record.owner = void 0;
    record.agent = void 0;
    if (owner !== void 0 && records.get(owner) === record) records.delete(owner);
  }

  /**
   * 判定一次静止。任何一步不成立都保持等待；查询失败/未知一律不释放。
   *
   * @param {object} record - 目标记录。
   */
  function scheduleCheck(record) {
    if (disposed || record.destroyed === true || record.released === true) return;
    // 正在 onKnownSnapshot 的同步回调里：本次结算由外层判定统一收口，不再嵌套发起查询。
    if (record.inSnapshot === true) return;
    if (record.checking) {
      // 已有判定在飞：它的结论对本轮已陈旧，落地后必须重跑（见 handleQuerySettled）。
      record.recheck = true;
      return;
    }
    record.checking = true;
    const queryId = ++record.querySequence;
    record.activeQueryId = queryId;
    const version = record.version;
    const rootId = record.rootId;
    let outcome;
    try {
      outcome = Promise.resolve(snapshotDescendants(rootId));
    } catch (error) {
      // 同步抛错同样归入「查询失败」的异步收口路径，避免递归重入。
      outcome = Promise.reject(error);
    }
    outcome.then(
      (result) => handleQuerySettled(record, queryId, version, result, void 0),
      (error) => handleQuerySettled(record, queryId, version, void 0, error),
    );
  }

  /**
   * 查询落地后的**唯一**收口点（成功与失败共用），保证 `checking` 一定被复位、
   * 且 `recheck` 一定被消费。
   *
   * 问题 3：查询在飞期间发生的事件会把 `recheck` 置 true；若 rejection 分支只记错
   * 不消费该标志，那次「有新活动，请复查」的意图就被吞掉，等待可能永久悬挂。因此
   * 两条分支都必须消费 `recheck` 并重跑一次查询。
   *
   * 不自旋的保证：`recheck` 只在**已有查询在飞**时被置位，而置位者只能是事件
   * （track/settle/invalidate 都会推进 version）或新到达的 waiter。每次 rejection
   * 最多消费一个 `recheck`，因此「连续 reject 且没有新事件」时第二轮之后不再重跑。
   */
  function handleQuerySettled(record, queryId, version, result, error) {
    if (record.activeQueryId !== queryId) return;
    record.activeQueryId = 0;
    record.checking = false;
    if (disposed || record.destroyed === true) return;

    if (error !== void 0) {
      report(error);
      // unknown：继续等待。仅当在飞期间确有复查意图时才重跑，绝不无条件自旋。
      if (record.recheck === true) {
        record.recheck = false;
        scheduleCheck(record);
      }
      return;
    }

    // 查询期间出现新活动（新登记 / child 创建 / 状态变化）：本轮结论作废，重新判定。
    // 注意：`works.size > 0` **不是**陈旧信号——它就是「仍在等待」的正常状态，
    // 在这里重跑只会造成无休止的重新查询。
    if (record.version !== version) {
      record.recheck = false;
      scheduleCheck(record);
      return;
    }
    const known = result?.known === true;
    const running = known && Array.isArray(result.running) ? result.running : [];
    if (!known) {
      // 未知（查询失败 / 结构非法 / 状态无法确定）：继续等待，**绝不**当成无人运行。
      if (record.recheck === true) { record.recheck = false; scheduleCheck(record); }
      return;
    }
    // 明确快照：先给调用方一次「完成通知缺失」的回退结算机会。回调只减少未结算工作，
    // 且此刻处于同一同步临界区（不可能与新的登记交错）；inSnapshot 阻止回调内的
    // settle 触发嵌套查询，由本回调统一收口。
    record.inSnapshot = true;
    try { onKnownSnapshot(record.agent, result); } catch (callbackError) { report(callbackError); } finally {
      record.inSnapshot = false;
    }
    if (record.destroyed === true) return;
    // 从「快照落地」到「判定静止」之间没有任何 await / 回调边界，因此这里的判定
    // 与释放处于同一同步临界区：「通过」与「释放」之间不可能插入新的 dispatch、
    // child 创建或 fanout retry。
    if (record.works.size > 0 || running.length > 0) {
      // 仍有未结算工作，或确有 running 后代：继续等待。
      if (record.recheck === true) { record.recheck = false; scheduleCheck(record); }
      return;
    }
    if (!isLiveRoot(record.agent)) {
      // root 已不再是 live：由 retire() 负责收口；这里保持等待避免误报静止。
      return;
    }
    record.recheck = false;
    destroyRecord(record, true, "quiescent");
  }

  /**
   * 取得（必要时创建）一个 root 的记录；首次创建时**先**安装监听器，再返回，
   * 因此调用方的第一次状态查询一定发生在监听安装之后。
   *
   * 已销毁的记录不在登记表里，因此这里会为同一 root 建立**全新**记录并重新订阅
   * （问题 2 的第二轮等待就靠这一点）。
   */
  function ensureRecord(agent) {
    if (disposed) return void 0;
    if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) return void 0;
    const existing = records.get(agent);
    if (existing !== void 0) return existing;
    const record = {
      owner: agent,
      agent,
      rootId: typeof agent.id === "string" ? agent.id : void 0,
      works: new Map(),
      waiters: new Set(),
      version: 0,
      querySequence: 0,
      activeQueryId: 0,
      checking: false,
      recheck: false,
      inSnapshot: false,
      released: false,
      cancelled: false,
      destroyed: false,
      releaseReason: void 0,
      unlisten: void 0,
    };
    if (typeof record.rootId !== "string" || record.rootId.length === 0) return void 0;
    records.set(agent, record);
    // 监听必须先于任何状态查询/快照安装。
    try {
      record.unlisten = subscribe(agent, () => invalidate(agent));
    } catch (error) {
      report(error);
      record.unlisten = void 0;
    }
    return record;
  }

  /**
   * 登记一项未结算工作。重复登记同一键幂等。
   *
   * @param {object} agent - exact root Agent。
   * @param {{kind:"admission",token:string}|{kind:"fanout",parentTaskId:string,attempt?:number}} work - 工作描述。
   * @returns {string|undefined} 工作键；非法输入或已卸载时 undefined。
   */
  function track(agent, work) {
    const key = turnWaitWorkKey(work);
    if (key === void 0) return void 0;
    const record = ensureRecord(agent);
    if (record === void 0 || record.destroyed === true) return void 0;
    const existing = record.works.get(key);
    if (existing !== void 0 && existing.settled !== true) return key;
    record.works.set(key, { key, ...work, settled: false });
    record.version += 1;
    scheduleCheck(record);
    return key;
  }

  /**
   * 精确结算一项工作。只有确实命中未结算项时才算结算（幂等）。
   *
   * @returns {boolean} 是否结算成功。
   */
  function settle(agent, work) {
    const key = turnWaitWorkKey(work);
    if (key === void 0) return false;
    const record = records.get(agent);
    if (record === void 0 || record.destroyed === true) return false;
    const entry = record.works.get(key);
    if (entry === void 0 || entry.settled === true) return false;
    record.works.delete(key);
    record.version += 1;
    scheduleCheck(record);
    return true;
  }

  /**
   * 外部活动（child 创建 / 状态转 running / fanout retry）让当前静止结论作废。
   * 只推进 version 并重跑判定，不改变登记集。
   */
  function invalidate(agent) {
    const record = records.get(agent);
    if (record === void 0 || record.destroyed === true) return;
    record.version += 1;
    scheduleCheck(record);
  }

  /**
   * 等待该 root 静止。**永不超时**：只有精确结算 + root-scoped 明确空闲、
   * 或 retire/dispose 才会收口。
   *
   * @param {object} agent - exact root Agent。
   * @param {AbortSignal} [signal] - 只取消本次 waiter，不改变等待记录或工作项。
   * @returns {Promise<{released:boolean,reason:string}>} 释放结论；`released:false`
   *   表示 root 已销毁/代际被替换/插件卸载，或本次 waiter 被取消。
   */
  function wait(agent, signal) {
    if (signal?.aborted === true) return Promise.resolve({ released: false, reason: "signal-aborted" });
    const record = ensureRecord(agent);
    if (record === void 0) return Promise.resolve({ released: false, reason: "root-unknown" });
    if (record.destroyed === true) return Promise.resolve({ released: false, reason: record.releaseReason ?? "cancelled" });
    const deferred = createDeferred();
    const waiter = { resolve: deferred.resolve, cleanup: void 0 };
    record.waiters.add(waiter);
    if (typeof signal?.addEventListener === "function") {
      const onAbort = () => {
        if (!record.waiters.delete(waiter)) return;
        waiter.cleanup?.();
        waiter.cleanup = void 0;
        waiter.resolve({ released: false, reason: "signal-aborted" });
        // 最后一个 waiter 取消后，忽略它启动的在途快照并释放 checking。
        if (record.waiters.size === 0 && record.checking) {
          record.activeQueryId = ++record.querySequence;
          record.checking = false;
          record.recheck = false;
        }
      };
      const cleanup = () => signal.removeEventListener?.("abort", onAbort);
      waiter.cleanup = cleanup;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted === true) onAbort();
    }
    scheduleCheck(record);
    return deferred.promise;
  }

  /**
   * 建立（或复用）该 root 的等待记录但**不登记任何工作**。
   *
   * 用途：`continue_parent_turn` 之类的路径不会产生"未结算工作"，但它确实会留下
   * 正在运行的子代理；只要该 root 曾经委派过专家，`agent/turn-stopping` 兜底就必须
   * 参与判定。engage 只保证记录与监听存在，是否等待仍由静止判定决定。
   *
   * @returns {boolean} 记录是否可用（已卸载/非法 root 为 false）。
   */
  function engage(agent) {
    const record = ensureRecord(agent);
    return record !== void 0 && record.destroyed !== true;
  }

  /** 该 root 是否已有（存活的）等待记录——turn-stopping 兜底的介入条件。 */
  function isEngaged(agent) {
    const record = records.get(agent);
    return record !== void 0 && record.destroyed !== true;
  }

  /** 是否存在未结算工作（turn-stopping 兜底据此决定是否介入）。 */
  function hasOutstanding(agent) {
    const record = records.get(agent);
    return record !== void 0 && record.destroyed !== true && record.works.size > 0;
  }

  /** 未结算工作数。 */
  function outstandingCount(agent) {
    const record = records.get(agent);
    return record === void 0 || record.destroyed === true ? 0 : record.works.size;
  }

  /** 只读诊断投影（不含任何工作负载，也不暴露 Agent 引用）。 */
  function describe(agent) {
    const record = records.get(agent);
    if (record === void 0) return void 0;
    return {
      outstanding: record.works.size,
      waiters: record.waiters.size,
      version: record.version,
      released: record.released,
      cancelled: record.cancelled,
      reason: record.releaseReason,
    };
  }

  /** root dispose / 代际替换：取消该 root 的等待并移除监听与引用。 */
  function retire(agent, reason = "root-retired") {
    const record = records.get(agent);
    if (record === void 0) return false;
    destroyRecord(record, false, reason);
    return true;
  }

  /** 插件卸载：所有 root 一起收口，绝不留下悬空等待或监听。 */
  function dispose() {
    disposed = true;
    for (const record of [...records.values()]) destroyRecord(record, false, "plugin-unloaded");
    records.clear();
  }

  return Object.freeze({
    track,
    settle,
    invalidate,
    engage,
    isEngaged,
    wait,
    hasOutstanding,
    outstandingCount,
    describe,
    retire,
    dispose,
    get size() { return records.size; },
  });
}
