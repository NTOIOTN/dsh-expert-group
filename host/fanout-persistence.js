/**
 * Host 关注点模块：fan-out 快照持久化投影、落盘旁路与显式回收。
 *
 * 本模块是「磁盘上应该有什么」的唯一 owner：`persistenceBlocked` / `lastPersistOutcome`（Host 层
 * 闸门与最近结果）、`durableReclaimOmit`（落盘必须排除的已回收 id，有界）、`persistenceHealth`。
 * 两条硬约束（票据 11）：**先 persist 成功才 commit**（任一步失败走 abort / 补偿，绝不部分提交）；
 * **重试必须重新投影**（绝不回退写旧 payload——它可能含已回收任务，重放即复活）。
 * @module dsh-expert-group/host/fanout-persistence
 */
import { createPersistenceHealth } from "./persistence-health.js";

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** JSON 安全的只读拷贝；诊断面绝不能把内部对象引用交给调用方。 */
function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/** 默认退避节奏：第 1 次失败后等 50ms，此后翻倍，封顶 2s。 */
const DEFAULT_RETRY_BACKOFF = Object.freeze({ baseDelayMs: 50, maxDelayMs: 2000 });

/**
 * 第 attempt 次持久化尝试失败后的退避等待时长：baseDelayMs * 2^(attempt-1)，受 maxDelayMs 封顶。
 * 纯函数（不读时钟、不 sleep、不持有状态），退避节奏可被确定性断言；真实等待由注入的 sleep 完成。
 */
function retryDelayForAttempt(attempt, baseDelayMs, maxDelayMs) {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  const base = Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : DEFAULT_RETRY_BACKOFF.baseDelayMs;
  const cap = Number.isFinite(maxDelayMs) && maxDelayMs >= base ? maxDelayMs : base;
  const raw = base * 2 ** (safeAttempt - 1);
  return Number.isFinite(raw) ? Math.min(cap, raw) : cap;
}

/** 生产用的退避等待：真实定时器；delayMs <= 0 时立即返回，不占用事件循环。 */
function defaultRetrySleep(delayMs) {
  if (!(delayMs > 0)) return Promise.resolve();
  return new Promise((resolve) => { setTimeout(resolve, delayMs); });
}

/** 排除集合上限：与已回收归属提示同阶，远大于单次回收批量（maxTasks=64）。 */
const DURABLE_RECLAIM_OMIT_LIMIT = 256;

/** 最终快照写后对账的最大轮数：避免「恢复 × 写入」无限交错。 */
const RECLAIM_FINAL_RECONCILE_ROUNDS = 2;

/** 回收拒绝的统一形状：reclaimed 空、durable 恒 false（拒绝路径没有产生任何耐久变更）。 */
function reclaimRejected(code, reason, skipped = []) {
  return { accepted: false, changed: false, code, reason, reclaimed: [], skipped, count: 0, durable: false };
}

/**
 * 回收提交成功后的「最终快照 + 写后对账」阶段（模块内无状态 helper，只拿命令与 id 列表）。
 *
 * 最终快照**必写**且**不带固定 omit**：关闭路径的旧快照排在本笔之前（FIFO），投影只由动态排除
 * 集合决定，写入那一刻已恢复的同 id 任务会正常进入快照。对账先记下「此刻仍在内存的同 id 任务」，
 * 再补写并 await 真实结果：成功 → 覆盖到的 id 已落盘、写入期间才出现的进入下一轮；失败 →
 * durable:false（保留动态 omit）。只有确认耐久成功才对「已不在内存」的 id 撤销登记。
 *
 * @param {{manager: object, persist: Function, forgetDurableReclaimOmit: Function, warn: Function,
 *   reclaimed: string[]}} deps
 * @returns {Promise<boolean>} 是否确认耐久收敛（false 绝不降级为 true）。
 */
async function settleFinalSnapshot({ manager, persist, forgetDurableReclaimOmit, warn, reclaimed }) {
  const writeFinalSnapshot = async (phase) => {
    try {
      return (await persist(manager.snapshot())) === true;
    } catch (error) {
      warn("dsh-expert-group: fan-out reclaim " + phase + " failed: " + describeError(error));
      return false;
    }
  };
  /** 某个 reclaimed id 是否仍在内存；读取失败按"仍然存在"处理（宁可 durable:false）。 */
  const reclaimedIsLive = (parentTaskId) => {
    try {
      return manager.getTask(parentTaskId) !== null;
    } catch (error) {
      warn("dsh-expert-group: fan-out reclaim liveness check failed: " + describeError(error));
      return true;
    }
  };
  /** 当前仍在内存里的 reclaimed id 列表。 */
  const liveReclaimedIds = () => reclaimed.filter((parentTaskId) => reclaimedIsLive(parentTaskId));

  let durable = await writeFinalSnapshot("final snapshot");
  if (durable !== true) {
    warn("dsh-expert-group: fan-out reclaim final snapshot write was not confirmed");
  }
  let pending = durable === true ? liveReclaimedIds() : [];
  let reconcileWriteFailed = false;
  for (let round = 1; round <= RECLAIM_FINAL_RECONCILE_ROUNDS && pending.length > 0; round += 1) {
    // 这些 id 此刻在内存 → 本次投影会包含它们（动态集合已撤销，显式 omit 已移除）。
    const covered = new Set(pending);
    const confirmed = await writeFinalSnapshot("final snapshot reconciliation");
    if (confirmed !== true) {
      warn("dsh-expert-group: fan-out reclaim final snapshot reconciliation write was not confirmed");
      durable = false;
      reconcileWriteFailed = true;
      break;
    }
    // 只关心"本笔写入期间才出现、因此没有被它覆盖"的同 id 任务。
    pending = liveReclaimedIds().filter((parentTaskId) => !covered.has(parentTaskId));
  }
  if (reconcileWriteFailed === false && pending.length > 0) {
    // 两轮对账后仍有未被最后写入覆盖的同 id 任务：无法确认磁盘耐久收敛。
    warn("dsh-expert-group: fan-out reclaim final snapshot reconciliation did not converge");
    durable = false;
  }
  if (durable === true) {
    for (const parentTaskId of reclaimed) {
      // 写后重新存在的同 id 任务必须留在快照里：登记已在它出现时同步撤销，这里不再清理。
      if (reclaimedIsLive(parentTaskId)) continue;
      forgetDurableReclaimOmit(parentTaskId);
    }
  } else {
    // 保留排除登记：关闭期旧快照已经/即将落盘时，后续写入继续排除这些 id，防止复活。
    warn("dsh-expert-group: fan-out reclaim committed without a durable final snapshot");
  }
  return durable;
}

/**
 * 落盘旁路（模块内无状态 helper）：有界重试；**每次重试都在写入前重新投影**——退避期间回收
 * 可能已完成，重放首轮 payload 会把已回收任务写回磁盘（重启后复活）。投影失败**绝不回退写旧
 * payload**，按既有失败分类返回 false（fail-closed）。健康记录用本次实际写入的 payload.sequence。
 */
async function runPersist(deps, snapshot, options) {

    if (typeof deps.storage?.write !== "function") {
      deps.recordPersistOutcome({ status: "skipped", reason: "no_writer" });
      return false;
    }
    /** 恢复失败后的 fail-closed 闸门：绝不能把当前（可能为空/不完整）的快照写回磁盘——
     * 一次失败恢复会覆盖磁盘上的原快照，重试无从读起。只有成功恢复才清除。 */
    if (deps.isBlocked()) {
      deps.recordPersistOutcome({ status: "skipped", reason: "restore_failed" });
      return false;
    }
    // payload 必须可重新赋值：重试会在**写入前**用最新内存状态重建它；
    // 首次尝试仍使用调用方传入的 snapshot，保持既有 API/测试语义。
    let payload = deps.snapshotForStorage(snapshot, options);
    const token = deps.persistenceHealth.beginDrain({
      generation: typeof deps.storage?.generation === "function" ? deps.storage.generation() : payload.generation,
      sequence: payload.sequence,
    });
    let attempt = 1;
    try {
      while (true) {
        const generation = typeof deps.storage?.generation === "function" ? deps.storage.generation() : payload.generation;
        try {
          const written = await deps.storage.write(payload);
          if (written !== true && written?.ok !== true) {
            const writeError = written?.ok === false ? written.error : written;
            if (writeError instanceof Error) throw writeError;
            if (writeError !== null && typeof writeError === "object" && !Array.isArray(writeError)) throw writeError;
            throw { category: "permanent", message: "持久化写入未返回成功确认" };
          }
          deps.persistenceHealth.recordSuccess({ generation, sequence: payload.sequence });
          deps.recordPersistOutcome({ status: "saved", sequence: payload.sequence });
          return true;
        } catch (error) {
          const failure = deps.persistenceHealth.recordFailure({ error, generation, sequence: payload.sequence, attempt });
          const decision = deps.persistenceHealth.retryDecision({ category: failure.category, attempt });
          if (!decision.retry) {
            deps.warn("dsh-expert-group: fan-out snapshot persistence failed [" + failure.category + "]: " + describeError(error));
            // 分类以 persistenceHealth 为权威；lastPersistOutcome 只做只读投影。
            deps.recordPersistOutcome({
              status: "failed",
              reason: "save_failed",
              category: failure.category,
              sequence: payload.sequence,
            });
            return false;
          }
          // 容量/永久失败在上面的分支直接收口；sleep 可注入记录器以便确定性断言退避节奏。
          const backoffMs = retryDelayForAttempt(attempt, deps.retryBackoff.baseDelayMs, deps.retryBackoff.maxDelayMs);
          try {
            await deps.retryBackoff.sleep(backoffMs);
          } catch (waitError) {
            // 注入的等待实现异常不能让持久化旁路变成未处理拒绝：退避失败等价于立即重试。
            deps.warn("dsh-expert-group: fan-out persistence retry backoff failed: " + describeError(waitError));
          }
          attempt = decision.nextAttempt;
          /** 重新投影：每次重试写入前都从当前内存状态重建 payload。必须放在退避**之后**
           * （回收正是在退避期间完成），options 原样透传以合并**当前**排除集合。 */
          try {
            const manager = deps.getManager();
            const managerSnapshot = typeof manager?.snapshot === "function" ? manager.snapshot() : null;
            if (managerSnapshot === null || typeof managerSnapshot !== "object" || Array.isArray(managerSnapshot)) {
              throw Object.assign(new Error("fan-out manager snapshot unavailable for persistence retry"), {
                code: "PERSIST_RETRY_SNAPSHOT_UNAVAILABLE",
              });
            }
            payload = deps.snapshotForStorage(managerSnapshot, options);
          } catch (reprojectError) {
            /** fail-closed：宁可失败也**绝不回退写旧 payload**——它可能仍含已回收任务。 */
            const reprojectFailure = deps.persistenceHealth.recordFailure({
              error: reprojectError,
              generation: typeof deps.storage?.generation === "function" ? deps.storage.generation() : payload?.generation,
              sequence: payload?.sequence,
              attempt,
            });
            deps.warn("dsh-expert-group: fan-out snapshot reprojection failed ["
              + reprojectFailure.category + "]: " + describeError(reprojectError));
            deps.recordPersistOutcome({
              status: "failed",
              reason: "reproject_failed",
              category: reprojectFailure.category,
              sequence: payload?.sequence,
            });
            return false;
          }
        }
      }
    } finally {
      deps.persistenceHealth.endDrain(token);
    }
  }

/**
 * 创建 persistence + reclaim 服务（唯一持有落盘结果、失败闸门与回收排除集合）。
 *
 * @param {object} deps
 * @param {object} deps.lineage - 归属/延迟任务读面（parentSessionsSnapshot / deferredTasks）。
 * @param {Function} deps.getManager - () => 唯一 manager（快照、回收三阶段与任务读面）。
 * @param {{write?: Function, generation?: Function}} deps.storage - 同一条存储绑定：落盘与读代次。
 * @param {object} [deps.persistenceHealth] - 持久化健康注入 seam；缺省时自建。
 * @param {object} [deps.retryBackoff] - 退避节奏与等待实现（同源只读配置，算一个协作方）。
 * @param {Function} deps.warn - 日志旁路，异常不得影响落盘语义。
 * @param {object} deps.ownership - ownership 服务：读已结算归属投影、回收后清理归属。
 * @returns {Readonly<object>}
 */
export function createFanoutPersistenceService({
  lineage,
  getManager,
  storage,
  persistenceHealth: injectedPersistenceHealth,
  retryBackoff,
  warn,
  ownership,
}) {
  const persistenceHealth = injectedPersistenceHealth === undefined
    ? createPersistenceHealth()
    : injectedPersistenceHealth;
  if (persistenceHealth === null || typeof persistenceHealth !== "object"
    || typeof persistenceHealth.beginDrain !== "function"
    || typeof persistenceHealth.endDrain !== "function"
    || typeof persistenceHealth.recordSuccess !== "function"
    || typeof persistenceHealth.recordFailure !== "function"
    || typeof persistenceHealth.retryDecision !== "function"
    || typeof persistenceHealth.snapshot !== "function") {
    throw new TypeError("createFanoutPersistenceService 需要 persistenceHealth 小接口");
  }

  /** 重试参数与等待实现（sleep 可注入）；退避只作用于 transient / generation-stale。 */
  const retryBackoffConfig = {
    baseDelayMs: Number.isFinite(retryBackoff?.baseDelayMs) && retryBackoff.baseDelayMs >= 0
      ? retryBackoff.baseDelayMs
      : DEFAULT_RETRY_BACKOFF.baseDelayMs,
    maxDelayMs: Number.isFinite(retryBackoff?.maxDelayMs) && retryBackoff.maxDelayMs >= 0
      ? retryBackoff.maxDelayMs
      : DEFAULT_RETRY_BACKOFF.maxDelayMs,
    sleep: typeof retryBackoff?.sleep === "function" ? retryBackoff.sleep : defaultRetrySleep,
  };

  /** persistenceBlocked：恢复失败的 fail-closed 闸门；lastPersistOutcome：最近落盘结果（只读）。 */
  let persistenceBlocked = null;
  let lastPersistOutcome = null;

  /** 记录最近一次 Host 层落盘结果（只读诊断；不触发新的持久化回调）。 */
  function recordPersistOutcome(outcome) {
    lastPersistOutcome = Object.freeze({
      status: outcome?.status === "saved" || outcome?.status === "failed" ? outcome.status : "skipped",
      reason: typeof outcome?.reason === "string" ? outcome.reason : null,
      category: typeof outcome?.category === "string" ? outcome.category : null,
      sequence: Number.isSafeInteger(outcome?.sequence) ? outcome.sequence : null,
      at: Date.now(),
    });
    return lastPersistOutcome;
  }

  /**
   * 进程内「回收排除集合」：已进入回收流程、**落盘时必须被排除**的父任务 id（有界）。
   *
   * 关闭路径会在候选落盘的 await 期间再写一份仍含待回收任务的快照（生成于 commit 之前）；登记后
   * **任何**经 persist 的写入都会并入该集合，即使正文生成于 commit 之前也被投影排除。生命周期与
   * 回收三步严格对应：候选 persist 之前登记；候选落盘或 commit 失败 → 撤销 + **绕过**排除的补偿
   * 写入；最终快照成功 → 撤销；最终快照失败 → **保留**继续排除（防关闭期旧快照复活）。
   */
  const durableReclaimOmit = new Set();

  /** 登记一个「落盘时必须排除」的 id（有界，插入序淘汰最旧项）。 */
  function rememberDurableReclaimOmit(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    // 先删后插：重复登记会刷新插入序，淘汰时优先淘汰真正最久未使用的 id。
    durableReclaimOmit.delete(parentTaskId);
    durableReclaimOmit.add(parentTaskId);
    while (durableReclaimOmit.size > DURABLE_RECLAIM_OMIT_LIMIT) {
      const oldest = durableReclaimOmit.values().next().value;
      durableReclaimOmit.delete(oldest);
    }
  }

  /** 撤销一个 id 的落盘排除登记（回收中止/成功，或同 id 被新任务复用）。 */
  function forgetDurableReclaimOmit(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    durableReclaimOmit.delete(parentTaskId);
  }

  function forgetDurableReclaimOmitMany(parentTaskIds) {
    for (const parentTaskId of Array.isArray(parentTaskIds) ? parentTaskIds : []) {
      forgetDurableReclaimOmit(parentTaskId);
    }
  }

  function omitIdSet(options) {
    const raw = options?.omitParentTaskIds;
    if (raw === null || raw === undefined) return null;
    const source = raw instanceof Set ? raw : (Array.isArray(raw) ? raw : null);
    if (source === null) return null;
    const set = new Set();
    for (const entry of source) {
      if (typeof entry === "string" && entry.length > 0) set.add(entry);
    }
    return set.size === 0 ? null : set;
  }

  /**
   * 排除集合的最终裁决：显式 omitParentTaskIds ∪ 进程内回收排除集合。正常写入都必须继承它；
   * `includeReclaimed: true` 是**内部旁路**，只给补偿写入使用（那时任务仍在内存）。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>, includeReclaimed?: boolean}} [options]
   * @returns {Set<string>|null} null 表示不过滤。
   */
  function effectiveOmitSet(options) {
    const explicit = omitIdSet(options);
    if (options?.includeReclaimed === true) return explicit;
    if (durableReclaimOmit.size === 0) return explicit;
    const merged = explicit === null ? new Set() : new Set(explicit);
    for (const parentTaskId of durableReclaimOmit) merged.add(parentTaskId);
    return merged.size === 0 ? null : merged;
  }

  /**
   * 持久化投影：合并 deferred 与已结算任务的 parentSessions，避免丢失不可寻址任务。
   * 排除集合对显式 omit、deferred 合并、已结算归属合并三处同时生效（否则留下脏归属）。
   *
   * @param {object} snapshot @param {{omitParentTaskIds?: string[]|Set<string>, includeReclaimed?: boolean}} [options]
   */
  function snapshotForStorage(snapshot, options) {
    const omitted = effectiveOmitSet(options);
    const parentSessions = lineage.parentSessionsSnapshot();
    if (omitted !== null) {
      for (const key of Object.keys(parentSessions)) {
        if (omitted.has(key)) delete parentSessions[key];
      }
    }
    const tasksById = new Map();
    for (const task of Array.isArray(snapshot?.tasks) ? snapshot.tasks : []) {
      const parentTaskId = task?.parentTaskId;
      if (omitted !== null && omitted.has(parentTaskId)) continue;
      tasksById.set(parentTaskId, task);
    }
    for (const task of lineage.deferredTasks()) {
      const parentTaskId = task?.parentTaskId;
      if (omitted !== null && omitted.has(parentTaskId)) continue;
      if (!tasksById.has(parentTaskId)) tasksById.set(parentTaskId, task);
      const parentId = lineage.deferredParentOf(parentTaskId);
      if (typeof parentId === "string" && parentId.length > 0) parentSessions[parentTaskId] = parentId;
    }
    // 已终态归属是**寻址索引**而非活动 ownership：持久化必须保留它，否则重启后任务从任务树消失。
    for (const [parentTaskId, parentId] of ownership.settledParentSessionEntries()) {
      if (omitted !== null && omitted.has(parentTaskId)) continue;
      if (parentSessions[parentTaskId] === undefined) parentSessions[parentTaskId] = parentId;
    }
    return { ...snapshot, tasks: [...tasksById.values()], parentSessions };
  }

  /** 显式落盘一次当前快照（复用 persist 旁路：合并/退避/健康记录/代次都不复制）。 */
  function flush() {
    try {
      return Promise.resolve(persist(getManager().snapshot())).then((written) => written === true, (error) => {
        warn("dsh-expert-group: fan-out snapshot flush failed: " + describeError(error));
        return false;
      });
    } catch (error) {
      warn("dsh-expert-group: fan-out snapshot flush failed: " + describeError(error));
      return Promise.resolve(false);
    }
  }

  /** 落盘旁路的冻结依赖面（命令/只读配置，不含任何可写集合引用）。 */
  const persistDeps = Object.freeze({ storage, persistenceHealth, retryBackoff: retryBackoffConfig,
    snapshotForStorage, recordPersistOutcome, isBlocked: () => persistenceBlocked !== null, getManager, warn });
  /** 落盘旁路（实现在模块级 runPersist；这里只把 owner 的窄命令面交出去）。 */
  function persist(snapshot, options) { return runPersist(persistDeps, snapshot, options); }


  /** 关闭后的结构化拒绝形状（与正常拒绝路径同形，durable 必须为 false）。 */
  const reclaimClosedResult = () => reclaimRejected("RUNTIME_CLOSED", "runtime_closed");

  /**
   * 显式回收本 root 已结算的父任务（票据 05）：两阶段 + **先落盘成功再移除**。
   *
   * 1. 归属 + live 写绑定过滤（票据 09）：非归属 → not_owner；归属命中但证明不了当前代际写绑定
   *    （冷恢复已结算任务、同 id replacement）→ owner_not_live，跳过且不泄露存在性。
   * 2. 等待 persist 的实际结果（复用重试/健康/代次），只有 true 才 commit，否则 abortReclaim。
   * 3. commit 成功 → 清理全部宿主侧归属索引并释放 lineage 绑定，再写「清理后的最终状态」；
   *    关闭竞态下（候选已真实落盘）仍必须 commit、仍要写最终快照，绝不因关闭而谎称失败。
   * 4. 候选落盘失败 / commit 失败：撤销排除登记 + `includeReclaimed:true` 的补偿写入，再 abort。
   *
   * 并发：manager 的屏障保证回收与 submit/cancel/retry/continue/restore 串行，宿主侧无需第二把锁。
   * @param {object} parent @param {string[]} parentTaskIds
   * @returns {Promise<object>} { accepted, reclaimed, skipped, count, durable }；永不抛错。
   */
  async function reclaimTasks(parent, parentTaskIds) {
    if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") {
      return reclaimRejected("INVALID_RECLAIM_INPUT", "invalid_parent");
    }
    if (!Array.isArray(parentTaskIds)) return reclaimRejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");
    const ids = [];
    const seen = new Set();
    for (const raw of parentTaskIds) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (id.length === 0) return reclaimRejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length === 0) return reclaimRejected("INVALID_RECLAIM_INPUT", "invalid_parent_task_ids");

    const manager = getManager();
    // 归属过滤先于任何任务信息查询：非归属/未知 id 一律 not_owner（不泄露存在性）。
    const skipped = [];
    const owned = [];
    for (const id of ids) {
      const owner = ownership.resolvedOwner(id);
      if (typeof owner !== "string" || owner.length === 0 || owner !== parent.id) {
        skipped.push({ parentTaskId: id, reason: "not_owner" });
        continue;
      }
      /** 防御性 exact live 写绑定校验（票据 09）：回收是删除型写操作，只认 live 写绑定。 */
      if (!ownership.liveWriteBinding(parent, id)) {
        skipped.push({ parentTaskId: id, reason: "owner_not_live" });
        continue;
      }
      owned.push(id);
    }
    if (owned.length === 0) return reclaimRejected("NO_OWNED_TASKS", "no_owned_tasks", skipped);

    const prepared = manager.prepareReclaim(owned);
    if (prepared?.accepted !== true) {
      return reclaimRejected(
        typeof prepared?.code === "string" ? prepared.code : "RECLAIM_NOT_ACCEPTED",
        typeof prepared?.reason === "string" ? prepared.reason : "reclaim_not_accepted",
        [...skipped, ...(Array.isArray(prepared?.skipped) ? prepared.skipped : [])],
      );
    }
    const eligible = prepared.parentTaskIds;
    // 先登记排除集合，**再**发起候选落盘：候选 await 期间关闭路径可能写入一份仍含待回收
    // 任务的快照（生成于 commit 之前），只有落盘投影再过滤一次才不会把任务写回磁盘。
    for (const parentTaskId of eligible) rememberDurableReclaimOmit(parentTaskId);
    const persistOptions = { omitParentTaskIds: eligible };
    let written = false;
    try {
      written = (await persist(prepared.candidate, persistOptions)) === true;
    } catch (error) {
      // persist 自身不抛错；这里只是防御性收口，异常等价于落盘失败。
      warn("dsh-expert-group: fan-out reclaim persist failed: " + describeError(error));
      written = false;
    }
    if (written !== true) {
      // 落盘失败：必须回到"什么都没发生"，否则磁盘与内存会分叉。
      const aborted = manager.abortReclaim(prepared.token);
      const category = typeof manager.persistenceStatus === "function"
        ? manager.persistenceStatus()?.lastResult?.category ?? null
        : null;
      if (aborted?.accepted !== true) {
        warn("dsh-expert-group: fan-out reclaim abort failed: " + String(aborted?.reason));
      }
      // 撤销排除登记：任务仍在内存，之后的任何写入都必须重新包含它们。
      forgetDurableReclaimOmitMany(eligible);
      /** 补偿写入（第三轮 blocking）：`includeReclaimed:true` 绕过排除集合（补偿绝不能继承）。 */
      try {
        const compensated = await persist(manager.snapshot(), { includeReclaimed: true });
        if (compensated !== true) {
          warn("dsh-expert-group: fan-out reclaim abort compensation write was not confirmed");
        }
      } catch (error) {
        warn("dsh-expert-group: fan-out reclaim abort compensation write failed: " + describeError(error));
      }
      return {
        ...reclaimRejected("RECLAIM_PERSIST_FAILED", "persist_failed", [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])]),
        ...(typeof category === "string" && category.length > 0 ? { category } : {}),
      };
    }
    /** 候选快照已真实落盘 → 回收不可回退：即使 closed 也必须 commit（manager 按 token + 屏障移除）。 */
    const committed = manager.commitReclaim(prepared.token);
    if (committed?.accepted !== true) {
      /** 候选已落盘但内存未移除：先用含待回收任务的快照 best-effort 写回，再 abort 并结构化失败。 */
      warn("dsh-expert-group: fan-out reclaim commit failed: " + String(committed?.reason));
      // 撤销排除登记：commit 未成立 → 任务仍在内存，补偿写入必须把它们写回磁盘。
      forgetDurableReclaimOmitMany(eligible);
      try {
        /** `includeReclaimed:true` 是必须的：补偿快照正是"仍含待回收任务"的内存状态。 */
        const compensated = await persist(manager.snapshot(), { includeReclaimed: true });
        if (compensated !== true) {
          warn("dsh-expert-group: fan-out reclaim compensation write was not confirmed");
        }
      } catch (error) {
        warn("dsh-expert-group: fan-out reclaim compensation write failed: " + describeError(error));
      }
      const aborted = manager.abortReclaim(prepared.token);
      if (aborted?.accepted !== true) {
        warn("dsh-expert-group: fan-out reclaim abort after commit failure was not accepted: "
          + String(aborted?.reason));
      }
      return reclaimRejected(
        typeof committed?.code === "string" ? committed.code : "RECLAIM_COMMIT_FAILED",
        typeof committed?.reason === "string" ? committed.reason : "reclaim_commit_failed",
        [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])],
      );
    }
    const reclaimed = Array.isArray(committed.reclaimed) ? committed.reclaimed : eligible;
    for (const parentTaskId of reclaimed) {
      // 归属索引的全部出处都必须清理（命令内部完成），否则重启后任务树/查询仍能寻址到已回收任务。
      ownership.discardReclaimedOwnership(parentTaskId, parent.id);
    }
    // 最终快照 + 写后对账（票据 05 第三/五轮 blocking）：顺序与失败语义见 settleFinalSnapshot。
    const durable = await settleFinalSnapshot({
      manager,
      persist,
      forgetDurableReclaimOmit,
      warn,
      reclaimed,
    });
    return {
      accepted: true,
      changed: true,
      reclaimed: [...reclaimed],
      skipped: [...skipped, ...(Array.isArray(prepared.skipped) ? prepared.skipped : [])],
      count: reclaimed.length,
      durable,
      ...(durable === true ? {} : { durabilityReason: "final_snapshot_failed" }),
    };
  }

  /** 只读落盘状态：Host 层最近结果（分类权威仍在 persistenceHealth）。 */
  function persistenceStatus() {
    return Object.freeze({
      lastResult: lastPersistOutcome === null ? null : cloneJson(lastPersistOutcome),
      blocked: persistenceBlocked === null ? null : cloneJson(persistenceBlocked),
    });
  }

  /** fail-closed 闸门的只读投影（restoreStatus 与本服务共用同一份序列化口径）。 */
  function blockedProjection() {
    return persistenceBlocked === null ? null : cloneJson(persistenceBlocked);
  }

  /** 记录一次恢复失败：从此刻起所有落盘一律 skipped(restore_failed)，直到成功恢复。 */
  function blockRestoreFailure(failure) {
    const code = typeof failure?.code === "string" ? failure.code : "RESTORE_FAILED";
    persistenceBlocked = Object.freeze({ reason: "restore_failed", code, at: Date.now() });
  }

  /** 成功恢复后清除 fail-closed 闸门（只有这一条路径能清除）。 */
  function clearRestoreBlock() {
    persistenceBlocked = null;
  }

  return Object.freeze({
    // ── 落盘（命令）────────────────────────────────────────────────────────
    persist,
    flush,
    reclaimTasks,
    reclaimClosedResult,
    snapshotForStorage,
    // ── 回收排除集合（命令；供 restore / task_registered 同步撤销）───────────
    rememberDurableReclaimOmit,
    forgetDurableReclaimOmit,
    // ── 恢复失败闸门（命令；唯一写者是 restore 服务）────────────────────────
    blockRestoreFailure,
    clearRestoreBlock,
    // ── 只读投影（诊断）────────────────────────────────────────────────────
    persistenceStatus,
    blockedProjection,
    healthSnapshot: () => persistenceHealth.snapshot(),
    diagnostics: () => Object.freeze({
      lastResult: lastPersistOutcome === null ? null : cloneJson(lastPersistOutcome),
      blocked: persistenceBlocked === null ? null : cloneJson(persistenceBlocked),
    }),
  });
}
