/**
 * 用量账本的有界状态机（票据 25；票据 08 / R2 拆出投影纯函数库）。
 *
 * 归一、投影、聚合与单价规则全部来自 `host/usage-projection.js`（纯函数库）；本文件只
 * 保留**有状态**部分：per-session 累积、LRU 淘汰、去抖刷盘、失败重试与唯一 timer。
 * 刷盘 / 去抖 / 重试阶段提为同文件内的 module-private helper（`createFlushHelper`），
 * owner 只向它交**冻结写入票据**，因此 `createUsageLedger` 工厂本体守住 400 行。
 *
 * 状态机有界性（owner = 本工厂；不新增跨文件状态模块）：
 * - 每个 session 只保留一个累积值 + lastSeq 水位（不保存事件集合/明细）；
 * - session 数超过 maxSessions 时按 LRU 淘汰（淘汰前把脏条目刷盘）；
 * - 聚合组数 / 条目数 / 文本长度上限由投影纯函数库负责；
 * - 写失败按有界退避重试，预算耗尽后保留 dirty，等下一次事件或显式 flush。
 *
 * 写入票据（票据 08 §窄能力契约）：
 * - `prepareWrite(sessionId, state)` 是 **owner-only**：用 owner 局部 state 制备
 *   `Frozen<{ sessionId, usage, version, commitSuccess(), commitFailure(error) }>`；
 *   它**不查** `sessions` 判定 state 是否存在（LRU 淘汰路径就是在 delete 之后刷脏）；
 * - flush helper 只见冻结票据与 `persist` / `isDisposed` / `scheduleFlush` 三条能力；
 * - 每张票据只结算一次，success / failure 闭包不逃逸当前 write 调用。
 */
import {
  DEFAULT_USAGE_FLUSH_MS,
  MAX_LEDGER_SESSIONS,
  MAX_USAGE_RETRY_DELAY_MS,
  MAX_USAGE_WRITE_RETRIES,
  applyAttribution,
  finalizeUsage,
  hasUsageMetrics,
  isCount,
  isPlainObject,
  isTime,
  maxOrNull,
  mergeSampleIntoAggregate,
  minOrNull,
  normalizeTokenUsage,
  projectUsage,
  retryKeyOf,
  textOrNull,
  usageOf,
} from "./usage-projection.js";

// ── 有界状态机 ──────────────────────────────────────────────────────────────

/**
 * 账本诊断计数器的初值。
 *
 * 每次 `createUsageLedger` 都返回**一份新对象**（没有模块级共享状态）：计数器仍由该
 * 工厂独占，本函数只负责给出初值，不是第二个 owner。
 */
function createLedgerStats() {
  return {
    observedEvents: 0,
    acceptedEvents: 0,
    duplicateEvents: 0,
    lateEvents: 0,
    missingSeqEvents: 0,
    inheritedEvents: 0,
    gapEvents: 0,
    invalidSamples: 0,
    unmeteredSamples: 0,
    validSamples: 0,
    writes: 0,
    writeFailures: 0,
    // 自动重试与「重试预算耗尽」分开计数：诊断能区分瞬时抖动与持续故障。
    writeRetries: 0,
    writeRetriesExhausted: 0,
    evictions: 0,
    lastWriteAt: null,
    lastError: null,
  };
}

/**
 * 单 session 有界状态的初值（Map 插入序即 LRU 序）。
 *
 * 同样每次调用返回新对象；状态本身仍由账本工厂独占（本函数只是构造器）。
 * `writeVersion` 是单调递增的写入代次：只有覆盖当前代次的成功才允许清 dirty。
 */
function createSessionState() {
  return {
    lastSeq: -1,
    usage: null,
    dirty: false,
    retryKeys: new Set(),
    writeVersion: 0,
    retryCount: 0,
  };
}

/**
 * 某次失败后的退避时长：base 起翻倍，封顶 MAX_USAGE_RETRY_DELAY_MS。
 *
 * 纯函数（原工厂内的 retryDelayMs）：base 取工厂的 flushDelay，0 时回落到默认窗口，
 * 避免 0ms 退避把失败放大成定时器风暴。
 */
function retryDelay(base, retryCount) {
  const effectiveBase = base > 0 ? base : DEFAULT_USAGE_FLUSH_MS;
  const exponent = Math.max(0, (Number.isSafeInteger(retryCount) ? retryCount : 1) - 1);
  return Math.min(MAX_USAGE_RETRY_DELAY_MS, effectiveBase * 2 ** exponent);
}

/**
 * 记录并输出一条账本告警（**不**持有状态：stats / logger 由 owner 传入）。
 *
 * 顺序固定：先写 `stats.lastError`（诊断读面立即可见），再经 `logger.warn` 输出；
 * logger 自身抛错被就地隔离，绝不能因为告警失败影响账本写入路径。
 */
function recordWarning(stats, logger, message, error) {
  stats.lastError = message;
  if (logger !== null && typeof logger?.warn === "function") {
    try { logger.warn("dsh-expert-group: usage ledger " + message + (error === undefined ? "" : ": " + (error instanceof Error ? error.message : String(error)))); } catch {}
  }
}

/**
 * 安全读取一次归属（原工厂内的 safeAttribution）：异常收敛为 undefined 并交给 onError。
 *
 * 归属读取失败不应打断事件处理：账本宁可少一份归属，也不能丢一条真实用量。
 */
function readAttribution(attributionFn, sessionId, onError) {
  try {
    const value = attributionFn(sessionId);
    return isPlainObject(value) ? value : undefined;
  } catch (error) {
    onError("attribution read failed", error);
    return undefined;
  }
}

/**
 * 深冻结 usage 快照（票据要求：与 state **无别名**且**深度不可变**）。
 *
 * `projectUsage` 的输出是扁平白名单（值只有数字/字符串），所以本可以只冻结顶层；这里
 * 仍递归一次，防止将来投影引入嵌套结构时悄悄退化成浅冻结。深度冻结让 helper 与调用方
 * 都无法通过票据改写账本状态。
 *
 * @param {object} value - 待冻结的投影对象。
 * @returns {object} 同一个（已冻结的）对象。
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * 刷盘 helper（module-private）：只接收冻结写入票据与三条窄命令能力。
 *
 * 边界（票据 08 §窄能力契约）：
 * - 不接收也不返回 `sessions` / `stats` / per-session state，因此 helper 无法绕过 owner
 *   读写账本状态；`prepareWrite` 只留在 owner 内，helper 既不接收也不调用它。
 * - `persist` / `isDisposed` / `scheduleFlush` 是创建时一次性传入的不可变依赖；timer 与
 *   scheduleFlush 由账本工厂唯一持有，helper 只能调用这一条调度通道。
 *
 * @param {{persist:Function, isDisposed:()=>boolean, scheduleFlush:(delayMs:number)=>void}} deps
 * @returns {{write:(ticket:object)=>Promise<unknown>}} 冻结的命令面。
 */
function createFlushHelper({ persist, isDisposed, scheduleFlush }) {
  return Object.freeze({
    /**
     * 启动一次写入并返回结算 Promise（**永不 reject**，调用方都是 fire-and-forget /
     * allSettled）。
     *
     * 固定顺序 3：在返回 Promise **之前同步调用** `persist`，不推迟到微任务。这样
     * `dispose()` 先 flush 再置 `disposed` 的既有顺序仍会真正发出最后一次写入，同步
     * throw 也保留「同一调用栈上即可观察」的原有语义。
     * 固定顺序 4：同步 throw 与 Promise rejection 合流到同一个 `commitFailure`。
     * 固定顺序 6：只消费 `commitFailure` 返回的 `retryDelayMs`；非 null 时才调用
     * `scheduleFlush` 复用唯一 timer（已有 timer 时 scheduleFlush 自己会跳过）。
     */
    write(ticket) {
      if (isDisposed()) return Promise.resolve(undefined);
      let result;
      try {
        result = persist(ticket.sessionId, ticket.usage);
      } catch (error) {
        const retryDelayMs = ticket.commitFailure(error);
        if (retryDelayMs !== null) scheduleFlush(retryDelayMs);
        return Promise.resolve(undefined);
      }
      return Promise.resolve(result).then(
        () => { ticket.commitSuccess(); },
        (error) => {
          const retryDelayMs = ticket.commitFailure(error);
          if (retryDelayMs !== null) scheduleFlush(retryDelayMs);
        },
      );
    },
  });
}

/**
 * 创建用量账本（有界状态机 + 去抖持久化）。
 *
 * 只接受 live 事件：调用方在 session/event 监听器里把 child 的 assistant/message、
 * assistant/attempt、turn/end 与可选的 llm/retry-started 交给 observe。账本不做任何
 * 快照/投影回填，因此 fork 子会话的继承前缀不会被重复累计。
 *
 * @param {object} [options]
 * @param {(childId:string, usage:object)=>unknown} [options.persist] - 刷盘回调；
 *   本模块只负责调用，失败由调用方告警（写失败不影响 child 生命周期）。
 * @param {(sessionId:string)=>object|undefined} [options.attributionOf] - 归属读取回退。
 * @param {{now:()=>number,setTimeout:Function,clearTimeout:Function}} [options.clock] - 可注入时钟。
 * @param {number} [options.debounceMs] - 普通事件后的合并写窗口（默认 200ms）。
 * @param {number} [options.maxSessions] - session 状态上限（默认 256）。
 * @param {{warn:Function}} [options.logger] - 可选告警出口。
 */
export function createUsageLedger({
  persist,
  attributionOf,
  clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  debounceMs = DEFAULT_USAGE_FLUSH_MS,
  maxSessions = MAX_LEDGER_SESSIONS,
  logger,
} = {}) {
  if (clock === null || typeof clock !== "object"
    || typeof clock.now !== "function" || typeof clock.setTimeout !== "function" || typeof clock.clearTimeout !== "function") {
    throw new TypeError("createUsageLedger 需要可用的 clock");
  }
  const persistFn = typeof persist === "function" ? persist : null;
  const attributionFn = typeof attributionOf === "function" ? attributionOf : null;
  const sessionLimit = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : MAX_LEDGER_SESSIONS;
  const flushDelay = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : DEFAULT_USAGE_FLUSH_MS;
  /**
   * sessionId → {
   *   lastSeq, usage, dirty, retryKeys,
   *   writeVersion,  // 单调递增的写入代次：只有覆盖当前代次的成功才允许清 dirty
   *   retryCount,    // 连续自动重试次数（成功清零；用于有界退避）
   * }（Map 插入序即 LRU 序）。
   */
  const sessions = new Map();
  const stats = createLedgerStats();
  let timer = null;
  let disposed = false;

  /** 账本告警出口：写 stats.lastError + 可选 logger.warn（异常隔离见 recordWarning）。 */
  function warn(message, error) {
    recordWarning(stats, logger, message, error);
  }

  /** 取/建 session 状态，并维护 LRU 与上限。 */
  function stateOf(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      sessions.delete(sessionId);
      sessions.set(sessionId, existing);
      return existing;
    }
    const created = createSessionState();
    sessions.set(sessionId, created);
    evictIfNeeded();
    return created;
  }

  function evictIfNeeded() {
    while (sessions.size > sessionLimit) {
      const oldestKey = sessions.keys().next().value;
      const oldest = sessions.get(oldestKey);
      sessions.delete(oldestKey);
      stats.evictions += 1;
      // 淘汰前先把脏条目刷盘：每个 session 的累积值仍然保留在持久化记录里。
      if (oldest?.dirty === true) void writeSession(oldestKey, oldest);
    }
  }

  /**
   * 安排一次去抖刷盘；delayMs 只在还没有定时器时生效。
   *
   * 失败重试复用同一个定时器通道（而不是新增第二套定时器）：已有更早的 flush 定时器时
   * 这次失败会被那次 flush 顺带重试，仍是有限的、事件驱动的重试节奏。
   */
  function scheduleFlush(delayMs = flushDelay) {
    if (persistFn === null || disposed || timer !== null) return;
    const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : flushDelay;
    timer = clock.setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
    // 定时器不得阻止进程退出（Node unref 可用时）。
    try { timer?.unref?.(); } catch {}
  }

  // 唯一刷盘 helper：owner 掌握 timer / stats / sessions，helper 只见冻结票据。
  const flushHelper = createFlushHelper({
    persist: persistFn,
    isDisposed: () => disposed,
    scheduleFlush,
  });

  /**
   * owner-only：用 owner 局部 state 制备一张**冻结写入票据**（helper 的唯一输入）。
   *
   * 固定顺序 1：LRU 淘汰路径先 `sessions.delete` 再调本函数（用 owner 局部 state 刷脏），
   * 因此本同步路径不插入 await、也不把 state 交给 helper。
   *
   * 只被 `writeSession` 与 LRU 淘汰路径调用；helper 既不接收也不调用它。这里刻意
   * **不查** `sessions` 判断 state 是否存在：淘汰路径就是在 `sessions.delete` 之后用
   * 局部 state 刷脏，查 Map 会让最后一次写入丢失。
   *
   * usage 由 `projectUsage` 复制成扁平白名单（与 state.usage 无别名），随后深冻结：
   * 票据是 helper 能看到的全部内容，不能有可写引用逃逸出 owner。
   *
   * @param {string} sessionId - child/session id。
   * @param {object} state - owner 局部持有的 per-session 状态（**不传给 helper**）。
   * @returns {object|null} 冻结票据；usage 无可持久化指标或已 disposed 时为 null。
   */
  function prepareWrite(sessionId, state) {
    if (persistFn === null || disposed) return null;
    const usage = projectUsage(state.usage);
    if (usage === null || !hasUsageMetrics(usage)) return null;
    // 固定顺序 2：代次在调用 persist 前递增，成功回调据此判断期间是否有更新事件写入。
    const version = state.writeVersion + 1;
    state.writeVersion = version;
    stats.writes += 1;
    stats.lastWriteAt = clock.now();
    return Object.freeze({
      sessionId,
      usage: deepFreeze(usage),
      version,
      /** 固定顺序 5：旧代次成功不清 dirty，也不清零 retryCount。 */
      commitSuccess() {
        if (state.writeVersion !== version) return;
        state.dirty = false;
        state.retryCount = 0;
      },
      /**
       * 统一失败结算：计数 + 告警 + 保留 dirty + 有界退避判定。
       * 返回 null 表示「不重试」，否则返回唯一调度通道所需的延迟。
       */
      commitFailure(error) {
        stats.writeFailures += 1;
        warn("write failed for a child session", error);
        if (disposed) return null;
        // dirty 必须保留：它表示「内存里有未成功落盘的值」，与是否正在重试无关。
        state.dirty = true;
        // 已有更新事件（代次前进）：那次写入会负责新值，这里不再重复调度。
        if (state.writeVersion !== version) return null;
        // LRU 淘汰后的孤儿状态不再占用定时器/重试预算（值已随条目离开账本）。
        if (sessions.get(sessionId) !== state) return null;
        if (state.retryCount >= MAX_USAGE_WRITE_RETRIES) {
          stats.writeRetriesExhausted += 1;
          return null;
        }
        state.retryCount += 1;
        stats.writeRetries += 1;
        return retryDelay(flushDelay, state.retryCount);
      },
    });
  }

  /**
   * 立即写一个 session 的当前累积值：owner 制备票据，helper 启动 persist 并结算。
   *
   * 返回的 Promise 永不 reject（调用方都是 fire-and-forget / allSettled）：失败由内部
   * 保留 dirty 并调度有界重试，不把持久化故障升级成 child 生命周期异常。
   */
  function writeSession(sessionId, state) {
    const ticket = prepareWrite(sessionId, state);
    return ticket === null ? Promise.resolve(undefined) : flushHelper.write(ticket);
  }

  /**
   * 观察一条 live session 事件。
   *
   * 返回结构化判定供调用方/测试观察，绝不抛错：
   * - accepted：是否计入了账本；
   * - reason：inherited / missing-seq / late / unknown-session（turn/end 没有账本状态时）。
   *
   * @param {object} session - 事件所属 Session（只读 id 与 inheritedEventCount）。
   * @param {object} event - session/event 事件对象。
   * @param {object} [explicitAttribution] - 调用方已解析的归属（role/roleLabel/provider/model/fallbackCount）。
   */
  function observe(session, event, explicitAttribution) {
    if (disposed) return { accepted: false, reason: "disposed" };
    if (!isPlainObject(event) || typeof session?.id !== "string" || session.id.length === 0) {
      return { accepted: false, reason: "invalid-event" };
    }
    const type = event.type;
    const isUsageEvent = type === "assistant/message" || type === "assistant/attempt";
    const isRetryEvent = type === "llm/retry-started";
    const isTurnEnd = type === "turn/end";
    if (!isUsageEvent && !isRetryEvent && !isTurnEnd) return { accepted: false, reason: "ignored-type" };
    stats.observedEvents += 1;

    // fork 子会话的继承前缀可能被外部回放：只接受自有 seq。
    // 真实宿主的 seed 不会发布 session/event，因此这是第二道防线，不是必要条件。
    const inheritedEventCount = Number.isSafeInteger(session.inheritedEventCount) && session.inheritedEventCount > 0
      ? session.inheritedEventCount
      : 0;
    const seq = event.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      stats.missingSeqEvents += 1;
      return { accepted: false, reason: "missing-seq" };
    }
    if (inheritedEventCount > 0 && seq < inheritedEventCount) {
      stats.inheritedEvents += 1;
      return { accepted: false, reason: "inherited" };
    }

    if (isTurnEnd) {
      const state = sessions.get(session.id);
      if (state === undefined) return { accepted: false, reason: "unknown-session" };
      if (seq <= state.lastSeq) {
        stats.lateEvents += 1;
        return { accepted: false, reason: "late" };
      }
      state.lastSeq = seq;
      const time = isTime(event.time) ? event.time : clock.now();
      state.usage = finalizeUsage({
        ...(state.usage ?? {}),
        finishedAt: maxOrNull(state.usage?.finishedAt, time) ?? time,
        updatedAt: clock.now(),
      });
      state.dirty = true;
      // turn/end 是稳定结算边界：立即刷盘，不等待去抖窗口。
      void writeSession(session.id, state);
      return { accepted: true, counted: false };
    }

    const state = stateOf(session.id);
    if (seq <= state.lastSeq) {
      stats.lateEvents += 1;
      return { accepted: false, reason: "late" };
    }
    if (state.lastSeq >= 0 && seq > state.lastSeq + 1) stats.gapEvents += 1;
    state.lastSeq = seq;
    stats.acceptedEvents += 1;

    const attribution = isPlainObject(explicitAttribution)
      ? explicitAttribution
      : (attributionFn === null ? undefined : readAttribution(attributionFn, session.id, warn));
    const time = isTime(event.time) ? event.time : clock.now();
    let usage = state.usage;
    if (usage === null) {
      usage = {
        startedAt: time,
        updatedAt: clock.now(),
      };
    } else {
      usage = {
        ...usage,
        startedAt: minOrNull(usage.startedAt, time) ?? time,
        updatedAt: clock.now(),
      };
    }
    applyAttribution(usage, attribution);

    if (type === "assistant/message") {
      usage.requests = (isCount(usage.requests) ? usage.requests : 0) + 1;
      // 真实路由优先：message.source 是与 usage 同一条请求的权威来源。
      const sourceProvider = textOrNull(event.data?.message?.source?.provider);
      const sourceModel = textOrNull(event.data?.message?.source?.model);
      if (sourceProvider !== null) usage.provider = sourceProvider;
      if (sourceModel !== null) usage.model = sourceModel;
    } else if (type === "assistant/attempt") {
      const key = retryKeyOf(event);
      if (key === null || !state.retryKeys.has(key)) {
        usage.retries = (isCount(usage.retries) ? usage.retries : 0) + 1;
      }
      if (key !== null) state.retryKeys.add(key);
      if (state.retryKeys.size > 256) {
        // 有界：只保留最近的键（Set 插入序即时间序）。
        const oldest = state.retryKeys.values().next().value;
        state.retryKeys.delete(oldest);
      }
    } else if (type === "llm/retry-started") {
      const key = retryKeyOf(event);
      if (key !== null && state.retryKeys.has(key)) {
        state.usage = usage;
        state.dirty = true;
        scheduleFlush();
        return { accepted: true, counted: false };
      }
      if (key !== null) state.retryKeys.add(key);
      usage.retries = (isCount(usage.retries) ? usage.retries : 0) + 1;
    }

    if (isUsageEvent) {
      const found = usageOf(event);
      if (found === undefined) {
        // 有请求但宿主没有给 usage：只累计请求数/重试数，token 字段保持缺失（绝不伪造 0）。
        stats.unmeteredSamples += 1;
      } else {
        const normalized = normalizeTokenUsage(found.usage);
        if (normalized.ok === true) {
          usage = mergeSampleIntoAggregate(usage, normalized.usage);
          stats.validSamples += 1;
        } else {
          usage.invalidSamples = (isCount(usage.invalidSamples) ? usage.invalidSamples : 0) + 1;
          stats.invalidSamples += 1;
        }
      }
    }

    state.usage = finalizeUsage(usage);
    state.dirty = true;
    scheduleFlush();
    return { accepted: true, counted: true };
  }



  /** 立刻刷全部脏 session。返回 Promise（persist 可能异步）。 */
  function flush() {
    const pending = [];
    for (const [sessionId, state] of sessions) {
      if (state.dirty !== true) continue;
      pending.push(writeSession(sessionId, state));
    }
    return Promise.allSettled(pending);
  }

  /** 刷指定 session（agent/disposed、turn/end 或测试显式调用）。 */
  function flushSession(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined || state.dirty !== true) return Promise.resolve(undefined);
    return writeSession(sessionId, state);
  }

  /**
   * 结束一个 child 的计量（agent/disposed）：补 finishedAt（缺失时）并立即刷盘。
   * 不删除内存状态：同一 id 的 replacement Agent 仍应沿用同一累积值（child_models 也是同一键）。
   */
  function finish(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined) return Promise.resolve(undefined);
    if (state.usage !== null) {
      const now = clock.now();
      // finishedAt 用**最后一次观察到的事件时间**（updatedAt），而不是 dispose 的时刻：
      // child 结束后可能很久才被回收，用回收时刻会把 runMs 拉长成空闲时长。
      // 只有完全没有事件时间时才退回到当前时钟。
      const finishedAt = maxOrNull(state.usage.finishedAt, state.usage.updatedAt, state.usage.startedAt) ?? now;
      state.usage = finalizeUsage({
        ...state.usage,
        finishedAt,
        updatedAt: now,
      });
      state.dirty = true;
    }
    return flushSession(sessionId);
  }

  /** 当前累积值的只读投影（RPC get / 快照优先读取 live 值）。 */
  function usageFor(sessionId) {
    const state = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (state === undefined || state.usage === null) return null;
    const usage = projectUsage(state.usage);
    return usage !== null && hasUsageMetrics(usage) ? usage : null;
  }

  /** 只读归属叠加：把既有持久化归属补到当前累积值上（测试/诊断用）。 */
  function entries() {
    const list = [];
    for (const [sessionId, state] of sessions) {
      const usage = usageFor(sessionId);
      if (usage !== null) list.push({ childId: sessionId, usage });
    }
    return list;
  }

  /** 有界诊断（不含 token 明细以外的用户内容）。 */
  function diagnostics() {
    return Object.freeze({
      sessions: sessions.size,
      maxSessions: sessionLimit,
      debounceMs: flushDelay,
      ...stats,
    });
  }

  /**
   * 卸载：先做最后一次 flush，再清定时器并停用后续写入。
   *
   * 固定顺序 7：先 flush 并登记 pending，再置 disposed，最后清 timer。
   * 顺序很重要：writeSession 在 disposed=true 时会直接返回，如果先置位再 flush，
   * 最后一个脏条目（尤其是刚收到的 turn/end / agent/disposed 样本）就永远写不出去。
   * 返回的 Promise 不阻塞卸载流程；flush 失败只按内部重试/保留 dirty 处理。
   */
  function dispose() {
    if (disposed) return Promise.resolve(undefined);
    const pending = flush();
    disposed = true;
    if (timer !== null) {
      try { clock.clearTimeout(timer); } catch {}
      timer = null;
    }
    return pending;
  }

  return Object.freeze({
    observe,
    flush,
    flushSession,
    finish,
    usageFor,
    entries,
    diagnostics,
    dispose,
  });
}
