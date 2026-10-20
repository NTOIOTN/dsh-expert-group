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
 * ## 可观测性与人工逃生（票据 11）
 * 记录额外保存 startedAt / lastSnapshot / lastDelivery / capabilityLevel 与长等待提醒状态：
 * - 后代查询的成功与失败都会落一条 lastSnapshot（reason 原样保留），降级（known!==true）
 *   只产生一次性 onIssue，绝不改变等待语义；
 * - 等待持续到 longWaitMs（默认 30 分钟）边界且有 works/waiters 时回调一次 onLongWait，
 *   之后每个边界至多一次；提醒**绝不**释放等待、也绝不改动 works；
 * - `abandon()` 是唯一的人工逃生写入面：它只收口 waiter 并销毁记录，不触碰 child、
 *   manager、影响范围或后代查询（不调用 onKnownSnapshot）。是否允许关闭批次由调用方
 *   依据权威后代查询决定。
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

/** 长等待提醒的默认间隔：30 分钟。可由 options.longWaitMs 覆盖（测试用假时钟/短间隔）。 */
const DEFAULT_LONG_WAIT_MS = 30 * 60 * 1000;
/** describeAll 的返回上限：诊断面绝不随 root 数量增长。 */
const DESCRIBE_ALL_LIMIT = 16;
/** 投递失败提示的去重上限（按 rootId+reason）；只保留固定条数，避免无界增长。 */
const DELIVERY_ISSUE_LIMIT = 64;

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
  // 时钟与定时器全部可注入：长等待提醒与 waitedMs 断言必须能在假时钟下确定性地覆盖，
  // 默认实现延迟读取全局对象，因此测试即使在创建登记表之后安装假时钟也仍然生效。
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const setTimer = typeof options.setTimeout === "function"
    ? options.setTimeout
    : (callback, delay) => globalThis.setTimeout(callback, delay);
  const clearTimer = typeof options.clearTimeout === "function"
    ? options.clearTimeout
    : (timer) => globalThis.clearTimeout(timer);
  const onLongWait = typeof options.onLongWait === "function" ? options.onLongWait : () => {};
  const onIssue = typeof options.onIssue === "function" ? options.onIssue : () => {};
  const longWaitMs = Number.isSafeInteger(options.longWaitMs) && options.longWaitMs > 0
    ? options.longWaitMs
    : DEFAULT_LONG_WAIT_MS;

  /** exact root Agent -> record。Map 会强引用 root，因此 destroy 必须显式删除。 */
  const records = new Map();
  let disposed = false;
  /**
   * 已通知过的投递失败（key = rootId + ":" + reason）。
   *
   * 为什么去重不能只放在记录上：投递发生在静止收口之后，此时等待记录已被销毁；若只看
   * 记录，下一次 turn-stopping 重建记录后会把同一个失败再次提示给用户。这里只保存
   * rootId 字符串与固定原因码，不持有 Agent 引用，且有固定上限。
   */
  const deliveryIssueNotified = new Set();

  function report(error) {
    try { onError(error); } catch { /* 记录回调自身异常不得改变等待语义 */ }
  }

  /**
   * 一次性 issue 通知：同一记录、同一 kind+reason 至多一次。
   *
   * 只做可观测性：回调异常被吞掉，绝不改变等待语义；原因码由调用方保证是固定枚举。
   */
  function notifyIssue(record, kind, reason) {
    if (record.destroyed === true) return;
    const key = kind + ":" + reason;
    if (record.issueNotified.has(key)) return;
    record.issueNotified.add(key);
    try {
      onIssue({ kind, reason, rootId: record.rootId, at: now() });
    } catch (error) {
      report(error);
    }
  }

  /**
   * 收口结论投递失败的一次性通知（跨记录去重）。
   *
   * 与 notifyIssue 分开的原因见 deliveryIssueNotified 的注释：投递失败通常发生在记录
   * 销毁之后，必须用稳定的 rootId+reason 做跨记录限流。
   */
  function notifyDeliveryIssue(agent, reason) {
    const rootId = typeof agent?.id === "string" ? agent.id : "";
    const key = rootId + ":" + reason;
    if (deliveryIssueNotified.has(key)) return;
    deliveryIssueNotified.add(key);
    while (deliveryIssueNotified.size > DELIVERY_ISSUE_LIMIT) {
      const oldest = deliveryIssueNotified.values().next().value;
      deliveryIssueNotified.delete(oldest);
    }
    try {
      onIssue({ kind: "finalization-delivery-failed", reason, rootId, at: now() });
    } catch (error) {
      report(error);
    }
  }

  /**
   * 记录一次后代查询的落地结论（成功与失败共用）。
   *
   * capabilityLevel 是 lastSnapshot 的纯导出：
   * - 查询抛错 → unavailable（连结论都没有）；
   * - known !== true（listing 缺依赖、waterfall 无 provider、结构非法等）→ degraded；
   * - known === true → available。
   *
   * known !== true 时同时产生一次降级 issue；同一 reason 每记录只通知一次，绝不因此
   * 改变等待（未知仍然继续等待）。
   */
  function noteSnapshot(record, known, reason, failed) {
    const resolvedReason = typeof reason === "string" && reason.length > 0 ? reason : null;
    record.lastSnapshot = { known: known === true, reason: resolvedReason, at: now() };
    record.capabilityLevel = failed === true ? "unavailable" : known === true ? "available" : "degraded";
    if (known !== true) {
      notifyIssue(record, "descendant-query-degraded", resolvedReason ?? "descendant-query-unknown");
    }
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

  // 查询结果未知或仍发现运行中的后代时，使用无期限的退避复查。timer 只服务于
  // 当前仍有 waiter 的活动记录；记录退休或最后一个 waiter 取消时必须清除它。
  const RETRY_INITIAL_DELAY = 10;
  const RETRY_MAX_DELAY = 1000;
  function clearRetryTimer(record) {
    if (record.retryTimer === void 0) return;
    const timer = record.retryTimer;
    record.retryTimer = void 0;
    try { clearTimer(timer); } catch (error) { report(error); }
  }

  function scheduleRetry(record) {
    if (disposed || record.destroyed === true || record.released === true
      || record.waiters.size === 0 || record.retryTimer !== void 0) return;
    const delay = record.retryDelay;
    const timer = setTimer(() => {
      if (record.retryTimer !== timer) return;
      record.retryTimer = void 0;
      if (disposed || record.destroyed === true || record.released === true
        || record.waiters.size === 0) return;
      scheduleCheck(record);
    }, delay);
    record.retryTimer = timer;
    // unref 只避免测试/宿主进程因一个永不超时的等待记录被强行保持；进程仍活跃时 timer 正常执行。
    timer?.unref?.();
    record.retryDelay = Math.min(RETRY_MAX_DELAY, delay * 2);
  }

  /** 清除长等待提醒定时器；幂等，绝不改动 works/waiters。 */
  function clearLongWaitTimer(record) {
    if (record.longWaitTimer === void 0) return;
    const timer = record.longWaitTimer;
    record.longWaitTimer = void 0;
    try { clearTimer(timer); } catch (error) { report(error); }
  }

  /**
   * 武装下一次长等待提醒（按 startedAt 的时间桶对齐）。
   *
   * - 只有记录存活且仍有 works/waiters 时才会被 track/wait/到期回调调用；
   * - 延迟计算到「下一个 longWaitMs 边界」，因此 30/60/90 分钟各至多一次；
   * - timer 必须 unref：等待本身永不超时，提醒绝不能把宿主进程钉住。
   */
  function armLongWaitTimer(record) {
    if (disposed || record.destroyed === true || record.longWaitTimer !== void 0) return;
    if (record.works.size === 0 && record.waiters.size === 0) return;
    const elapsed = Math.max(0, now() - record.startedAt);
    const bucket = Math.floor(elapsed / longWaitMs);
    // 已经跨过某个 30 分钟边界、但该桶还没提醒过（例如记录先空闲、之后才出现工作）：
    // 立即补一次当前桶的提醒，而不是再等一个完整周期。时间桶去重保证不会重复。
    const overdueBucket = bucket >= 1 && bucket > record.lastReminderBucket;
    const delay = overdueBucket
      ? 1
      : Math.max(1, (bucket + 1) * longWaitMs - elapsed);
    const timer = setTimer(() => {
      if (record.longWaitTimer !== timer) return;
      record.longWaitTimer = void 0;
      handleLongWaitTick(record);
    }, delay);
    record.longWaitTimer = timer;
    timer?.unref?.();
  }

  /**
   * 长等待提醒到期：只在记录仍存活且仍有未结算工作/等待者时回调一次。
   *
   * 按 waitedMs 的时间桶去重：即使 timer 被延迟、跨过多个边界，也只提示一次；
   * 提醒绝不释放等待、绝不改动 works（票据 11 的硬边界）。
   */
  function handleLongWaitTick(record) {
    if (disposed || record.destroyed === true) return;
    if (record.works.size === 0 && record.waiters.size === 0) return;
    const waitedMs = Math.max(0, now() - record.startedAt);
    const bucket = Math.floor(waitedMs / longWaitMs);
    if (bucket >= 1 && bucket > record.lastReminderBucket) {
      record.lastReminderBucket = bucket;
      record.lastReminderAt = now();
      record.reminderCount += 1;
      try {
        onLongWait({
          rootId: record.rootId,
          outstanding: record.works.size,
          waitedMs,
          at: now(),
        });
      } catch (error) {
        report(error);
      }
    }
    // 重新武装到下一个边界；记录已空时 armLongWaitTimer 直接早退，等下次 track/wait 再武装。
    armLongWaitTimer(record);
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
    clearRetryTimer(record);
    clearLongWaitTimer(record);
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
    // 显式活动事件或新 waiter 优先于退避 timer，避免同一记录并发发起重复查询。
    clearRetryTimer(record);
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
   * 事件驱动的 `recheck` 只在**已有查询在飞**时被置位，而置位者只能是事件
   * （track/settle/invalidate 都会推进 version）或新到达的 waiter。每次 rejection
   * 最多消费一个 `recheck`；没有事件时不会同步自旋，unknown 结果改由退避 timer 异步复查。
   */
  function handleQuerySettled(record, queryId, version, result, error) {
    if (record.activeQueryId !== queryId) return;
    record.activeQueryId = 0;
    record.checking = false;
    if (disposed || record.destroyed === true) return;

    if (error !== void 0) {
      report(error);
      // 查询失败也落一条观测事实：没有已知结论 → capabilityLevel=unavailable，
      // 并产生一次（每记录每原因码）降级提示；等待语义保持 fail-closed。
      noteSnapshot(record, false, "descendant-query-failed", true);
      // 查询失败仍是 unknown：保留 fail-closed，并在有 waiter 时退避重查。
      if (record.recheck === true) {
        record.recheck = false;
        scheduleCheck(record);
      } else {
        scheduleRetry(record);
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
    // 只有真正被本次判定采用的查询结果才落 lastSnapshot：version 已变化的陈旧结论会在
    // 上面直接重跑，不能覆盖更新的观测事实。
    noteSnapshot(
      record,
      known,
      typeof result?.reason === "string" && result.reason.length > 0
        ? result.reason
        : (known ? (running.length > 0 ? "running-descendants" : "no-running-descendants") : "descendant-query-unknown"),
      false,
    );
    if (!known) {
      // 未知（结构非法 / 状态无法确定）：继续等待，**绝不**当成无人运行。
      if (record.recheck === true) {
        record.recheck = false;
        scheduleCheck(record);
      } else {
        scheduleRetry(record);
      }
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
      if (record.recheck === true) {
        record.recheck = false;
        scheduleCheck(record);
      } else if (record.works.size === 0 && running.length > 0) {
        // 登记工作已清空后，后代仍可能静默转为非运行，不能依赖 agent/status/disposed
        // 事件才能再次观察；工作尚未结算时仍由其精确 settlement 触发复查。
        scheduleRetry(record);
      }
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
      retryTimer: void 0,
      retryDelay: RETRY_INITIAL_DELAY,
      unlisten: void 0,
      /**
       * 可观测性与人工逃生状态（票据 11）。
       *
       * 全部只保存固定枚举/时间戳/计数：不保存 prompt、任务正文或任何 agent 引用。
       * longWaitTimer 只是内存句柄，绝不进入任何快照。
       */
      startedAt: now(),
      lastSnapshot: void 0,
      lastDelivery: void 0,
      capabilityLevel: "unavailable",
      lastReminderAt: void 0,
      reminderCount: 0,
      lastReminderBucket: 0,
      issueNotified: new Set(),
      longWaitTimer: void 0,
      abandoned: false,
      abandonReason: void 0,
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
    armLongWaitTimer(record);
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
    // 工作与等待者都为空时提醒已无意义；有 waiter 仍在（等待静止确认）则保留。
    if (record.works.size === 0 && record.waiters.size === 0) clearLongWaitTimer(record);
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
   * 取消当前 root 的所有 waiter，但保留未结算工作与监听。
   *
   * 用户插话只应打断上一轮 root 的等待，让新一轮消息立即进入处理；专家 child
   * 仍可能运行，admission 也必须继续保留，后续 turn 才能再次等待同一批工作。
   *
   * @param {object} agent - exact root Agent。
   * @param {string} reason - 取消原因码。
   * @returns {boolean} 是否至少取消了一个 waiter。
   */
  function cancelWaiters(agent, reason = "cancelled") {
    const record = records.get(agent);
    if (record === void 0 || record.destroyed === true || record.waiters.size === 0) return false;
    settleWaiters(record, false, reason);
    clearRetryTimer(record);
    // 票据 11：取消 waiter 后必须清理长等待提醒；后续新 waiter/track 会从当前时间桶
    // 重新武装，不会留下旧定时器继续刷屏。
    clearLongWaitTimer(record);
    // 让已经在飞的查询失效；它的迟到结果只能复位内部状态，不能重新收口旧 waiter。
    if (record.checking) {
      record.activeQueryId = ++record.querySequence;
      record.checking = false;
      record.recheck = false;
    }
    return true;
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
    armLongWaitTimer(record);
    if (typeof signal?.addEventListener === "function") {
      const onAbort = () => {
        if (!record.waiters.delete(waiter)) return;
        waiter.cleanup?.();
        waiter.cleanup = void 0;
        waiter.resolve({ released: false, reason: "signal-aborted" });
        if (record.waiters.size === 0) clearRetryTimer(record);
        if (record.waiters.size === 0 && record.works.size === 0) clearLongWaitTimer(record);
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

  /**
   * 记录的只读摘要。
   *
   * 只含计数、固定枚举与时间戳；不包含 Agent 引用、root/session id、work 键或任何正文。
   * lastSnapshot/lastDelivery 都是浅拷贝，调用方无法通过返回值改写内部观测状态。
   */
  function summarize(record) {
    return {
      outstanding: record.works.size,
      waiters: record.waiters.size,
      version: record.version,
      released: record.released === true,
      cancelled: record.cancelled === true,
      reason: record.releaseReason ?? null,
      startedAt: record.startedAt,
      waitedMs: Math.max(0, now() - record.startedAt),
      lastSnapshot: record.lastSnapshot === void 0 ? null : { ...record.lastSnapshot },
      capabilityLevel: record.capabilityLevel,
      lastDelivery: record.lastDelivery === void 0 ? null : { ...record.lastDelivery },
      reminderCount: record.reminderCount,
      lastReminderAt: record.lastReminderAt ?? null,
      abandoned: record.abandoned === true,
    };
  }

  /** 只读诊断投影（不含任何工作负载，也不暴露 Agent 引用）。 */
  function describe(agent) {
    const record = records.get(agent);
    if (record === void 0 || record.destroyed === true) return void 0;
    return summarize(record);
  }

  /**
   * 全部存活记录的有界只读摘要（最多 `DESCRIBE_ALL_LIMIT` 条）。
   *
   * 供诊断使用：条目只含 waitedMs/outstanding/capability 等计数与固定枚举，不含 Agent
   * 引用、root/session id、work 键或会话正文，因此不可能把任务数据带进 RPC 投影。
   */
  function describeAll() {
    const summaries = [];
    for (const record of records.values()) {
      if (record.destroyed === true) continue;
      if (summaries.length >= DESCRIBE_ALL_LIMIT) break;
      summaries.push(summarize(record));
    }
    return summaries;
  }

  /**
   * 记录一次收口结论投递结果（票据 11）。
   *
   * 只在记录仍存活时写入 lastDelivery；失败还会触发**跨记录**一次性提示（投递通常发生在
   * 静止收口、记录销毁之后，仅靠记录去重挡不住下一个 turn 的重复提示）。
   * 本方法绝不抛错：诊断写入失败不得影响收口或等待语义。
   *
   * @param {object} agent - exact root Agent。
   * @param {{ok:boolean, reason?:string}} delivery - 投递结论（reason 是固定原因码）。
   * @returns {boolean} 是否成功记录（输入非法/记录已销毁也算已处理，仅回调异常返回 false）。
   */
  function noteDelivery(agent, delivery) {
    try {
      const ok = delivery?.ok === true;
      const reason = typeof delivery?.reason === "string" && delivery.reason.length > 0
        ? delivery.reason
        : (ok ? "delivered" : "delivery-failed");
      const at = now();
      const record = records.get(agent);
      if (record !== void 0 && record.destroyed !== true) {
        record.lastDelivery = { ok, reason, at };
      }
      if (!ok) notifyDeliveryIssue(agent, reason);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  /**
   * 人工关闭该 root 的等待账本（票据 11 的唯一逃生写入面）。
   *
   * 语义边界（必须由调用方先用权威后代查询确认「没有运行中的后代」）：
   * - 全部 waiter 以 `released:false, reason:"manual-abandon"` 收口；
   * - 清空 works、标记 abandoned 并销毁记录（不可逆）；
   * - **绝不**触碰 child / manager / 影响范围，**绝不**调用 onKnownSnapshot，
   *   也绝不发起新的后代查询或投递。
   *
   * @param {object} agent - exact root Agent。
   * @param {string} [reason] - 人工动作原因码（诊断用；默认 "abandoned"）。
   * @returns {{outstanding:number, waiters:number}} 关闭前的未结算工作数与等待者数。
   */
  function abandon(agent, reason = "abandoned") {
    const record = records.get(agent);
    if (record === void 0 || record.destroyed === true) return { outstanding: 0, waiters: 0 };
    const outstanding = record.works.size;
    const waiters = record.waiters.size;
    record.abandoned = true;
    record.abandonReason = typeof reason === "string" && reason.length > 0 ? reason : "abandoned";
    record.works.clear();
    record.version += 1;
    // 走唯一销毁路径：清 timer/监听、收口 waiter、清引用并从登记表移除。
    destroyRecord(record, false, "manual-abandon");
    return { outstanding, waiters };
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
    cancelWaiters,
    engage,
    isEngaged,
    wait,
    hasOutstanding,
    outstandingCount,
    describe,
    describeAll,
    noteDelivery,
    abandon,
    retire,
    dispose,
    get size() { return records.size; },
  });
}
