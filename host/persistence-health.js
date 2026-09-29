/**
 * 持久化旁路健康状态。
 *
 * 该模块只维护内存中的可观察状态，不写 storage、不触发回调，也不持有 manager 句柄。
 * 失败记录因此不会重新进入持久化链；Host 可以在外层使用 retryDecision 做有界重试。
 */

export const PERSISTENCE_FAILURE_CATEGORIES = Object.freeze([
  "transient",
  "generation-stale",
  "capacity",
  "permanent",
]);

const CATEGORY_SET = new Set(PERSISTENCE_FAILURE_CATEGORIES);
const CATEGORY_CODES = Object.freeze({
  transient: "PERSISTENCE_TRANSIENT",
  "generation-stale": "PERSISTENCE_GENERATION_STALE",
  capacity: "PERSISTENCE_CAPACITY",
  permanent: "PERSISTENCE_PERMANENT",
});

function isRecord(value) {
  return value !== null && typeof value === "object";
}

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function attemptNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function categoryOf(value) {
  if (CATEGORY_SET.has(value)) return value;
  if (value === "generation_stale" || value === "generation-stale") return "generation-stale";
  return undefined;
}

function errorSource(input) {
  if (isRecord(input) && isRecord(input.error)) return input.error;
  return input;
}

/**
 * 把 storage adapter 的错误归一为稳定类别和 code。
 * 未知错误默认按 permanent 处理，只有明确声明 retryable/transient 的错误才会重试。
 */
export function classifyFailure(input) {
  const source = errorSource(input);
  const explicit = categoryOf(input?.category) ?? categoryOf(source?.category);
  if (explicit !== undefined) {
    return {
      category: explicit,
      code: CATEGORY_CODES[explicit],
      retryable: explicit === "transient" || explicit === "generation-stale",
    };
  }

  const code = textOf(source?.code).toLowerCase();
  const name = textOf(source?.name).toLowerCase();
  const message = textOf(source?.message).toLowerCase();
  const reason = textOf(source?.reason).toLowerCase();
  const detached = input?.detached === true || source?.detached === true;
  if (detached
    || code.includes("generation")
    || code.includes("detached")
    || code.includes("binding_replaced")
    || code.includes("binding-replaced")
    || code.includes("stale")
    || reason.includes("generation")
    || reason.includes("detached")
    || message.includes("binding was replaced")
    || message.includes("generation stale")
    || message.includes("generation changed")) {
    return { category: "generation-stale", code: CATEGORY_CODES["generation-stale"], retryable: true };
  }

  if (name === "quotaexceedederror"
    || code.includes("quota")
    || code.includes("capacity")
    || code.includes("enospc")
    || code.includes("efbig")
    || code.includes("payload_too_large")
    || code.includes("payload-too-large")
    || message.includes("quota")
    || message.includes("capacity")
    || message.includes("out of space")
    || message.includes("storage full")
    || message.includes("too large")) {
    return { category: "capacity", code: CATEGORY_CODES.capacity, retryable: false };
  }

  if (source?.retryable === true
    || source?.transient === true
    || code === "etimedout"
    || code === "econnreset"
    || code === "eagain"
    || code === "ebusy"
    || code.includes("transient")
    || code.includes("temporary")
    || message.includes("timed out")
    || message.includes("temporarily unavailable")
    || message.includes("try again")) {
    return { category: "transient", code: CATEGORY_CODES.transient, retryable: true };
  }

  return { category: "permanent", code: CATEGORY_CODES.permanent, retryable: false };
}

/** 保留上一轮失败轮次使用的命名，供现有 Host adapter 兼容调用。 */
export function classifyPersistenceFailure(input) {
  return classifyFailure(input);
}

function positionOf({ sequence, generation } = {}) {
  const position = {
    sequence: nonNegativeInteger(sequence),
    generation: nonNegativeInteger(generation),
  };
  return position.sequence === null && position.generation === null ? null : position;
}

/**
 * generation 优先，随后比较同一 generation 内的 event sequence。
 *
 * 前置不变式：唯一调用方 staleAgainstLatest 已把「任一侧档位缺失」的输入提前返回
 * （接受，不判 stale），因此这里只会收到「双侧都有 generation 与 sequence」或
 * 「双侧都是 null」两种输入。函数内部仍保留单侧缺失分支，作为独立可读的比较器契约，
 * 不依赖调用方的不变式才能正确。
 */
function comparePosition(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (left.generation !== null || right.generation !== null) {
    if (left.generation === null) return -1;
    if (right.generation === null) return 1;
    if (left.generation !== right.generation) return left.generation - right.generation;
  }
  if (left.sequence === null && right.sequence === null) return 0;
  if (left.sequence === null) return -1;
  if (right.sequence === null) return 1;
  return left.sequence - right.sequence;
}

function atOf(value, now) {
  return value === undefined || value === null ? now() : value;
}

function normalizeDrainState(value) {
  if (typeof value === "string") {
    return { status: value, pending: value === "draining" ? 1 : 0 };
  }
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === "string" ? value.status : "idle";
  const pending = Number.isSafeInteger(value.pending) && value.pending >= 0
    ? value.pending
    : status === "draining" ? 1 : 0;
  return { status, pending };
}

/**
 * 创建健康状态。maxRetries 表示同一次提交最多允许追加的 retry 次数；它不限制之后
 * 由新的 manager sequence 发起的独立提交。
 */
export function createPersistenceHealth({ now = () => Date.now(), maxRetries = 2 } = {}) {
  const retryLimit = Number.isSafeInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 2;
  let tokenSequence = 0;
  const pendingTokens = new Set();
  let explicitDrain = { status: "idle", pending: 0 };
  let lastSuccess = null;
  let lastFailure = null;
  let consecutiveFailures = 0;
  let latestPosition = null;
  let latestKind;
  /**
   * session/child domain 写入的独立观察通道。
   *
   * 这两类写入没有 fanout 快照的 manager sequence，若复用 recordFailure 会覆盖
   * latestPosition/latestKind，从而把 fanout 的有界重试判定（retryDecision）与
   * "已成功"的陈旧判定一起污染。因此这里单独计数与记录：它是纯内存状态，不触发
   * 任何持久化回调，失败记录不可能形成 persistence feedback loop。
   * 成功也不清除 fanout 的 lastFailure——两个通道各自表达自己的最近结果。
   */
  let storageObserved = 0;
  let storageFailures = 0;
  let lastStorageFailure = null;
  let lastStorageSuccess = null;

  function drainState() {
    if (pendingTokens.size > 0) return { status: "draining", pending: pendingTokens.size };
    return { ...explicitDrain };
  }

  function applyDrainState(value) {
    const normalized = normalizeDrainState(value);
    if (normalized !== undefined) explicitDrain = normalized;
  }

  function stateSnapshot() {
    return clone({
      drain: drainState(),
      lastSuccess,
      consecutiveFailures,
      failureCategory: lastFailure?.category ?? null,
      failureCode: lastFailure?.code ?? null,
      lastFailure,
      maxRetries: retryLimit,
      // session/child 写入通道：只读投影，不参与 fanout 的 latestPosition 比较。
      storage: {
        observed: storageObserved,
        failures: storageFailures,
        lastFailure: lastStorageFailure,
        lastSuccess: lastStorageSuccess,
      },
    });
  }

  /**
   * 判定一次记录是否相对最近一次被采纳的记录过时（stale）。
   *
   * 无 position（null 档位）的显式语义：**任一侧为 null 时不判 stale，一律接受**。
   * 理由：null 档位只表示「缺少游标信息」，不携带「更旧」这一事实证明。
   *   - null-position 成功必须能清零 lastFailure/consecutiveFailures，否则该次失败会
   *     在健康视图里永不清零（审核发现 03 的主症状）；
   *   - null-position 失败必须照常计数，否则真实故障被静默丢弃。
   * 该规则同时覆盖「单侧 null」：例如 generation 可用但 sequence 非安全整数时，
   * position 为 {generation: n, sequence: null}，与前沿比较时 sequence 一侧缺失，
   * 同样不得凭空判旧。
   * 两侧都有 position 时保持既有规则：generation 优先、同 generation 比 sequence，
   * 并且同 position 上「成功之后紧跟失败」仍被抑制（order === 0 分支）。
   */
  function staleAgainstLatest(position, kind) {
    if (position === null || latestPosition === null) return false;
    if (position.generation === null || latestPosition.generation === null) return false;
    if (position.sequence === null || latestPosition.sequence === null) return false;
    const order = comparePosition(position, latestPosition);
    if (order < 0) return true;
    return order === 0 && kind === "failure" && latestKind === "success";
  }

  /**
   * 采纳一次记录后推进档位前沿：kind 始终更新，position 原样写入（null 也写入）。
   *
   * 保持修复前「前沿 = 最近一次被采纳记录」的语义：一次缺信息的记录会把前沿降级为
   * 缺信息，之后的记录不再与更早的档位比较。取舍是宁可不做推断，也不能把「缺少游标」
   * 当成「已知更旧」——后者会把迟到的正常记录永久丢进 stale，正是本次修复要消除的失效模式。
   */
  function advancePosition(position, kind) {
    latestPosition = position;
    latestKind = kind;
  }

  const api = {
    beginDrain({ generation, sequence, drainState: suppliedDrainState } = {}) {
      const token = Object.freeze({
        id: ++tokenSequence,
        generation: nonNegativeInteger(generation),
        sequence: nonNegativeInteger(sequence),
      });
      pendingTokens.add(token.id);
      explicitDrain = { status: "draining", pending: pendingTokens.size };
      applyDrainState(suppliedDrainState);
      return token;
    },

    endDrain(token) {
      if (!isRecord(token) || !pendingTokens.has(token.id)) return false;
      pendingTokens.delete(token.id);
      explicitDrain = {
        status: pendingTokens.size > 0 ? "draining" : "idle",
        pending: pendingTokens.size,
      };
      return true;
    },

    recordSuccess({ sequence, generation, at, drainState: suppliedDrainState } = {}) {
      // 无 position 的成功同样被采纳：它必须能清零失败计数（见 staleAgainstLatest 注释）。
      const position = positionOf({ sequence, generation });
      if (staleAgainstLatest(position, "success")) return stateSnapshot();
      advancePosition(position, "success");
      lastSuccess = {
        sequence: nonNegativeInteger(sequence),
        generation: nonNegativeInteger(generation),
        at: atOf(at, now),
      };
      lastFailure = null;
      consecutiveFailures = 0;
      applyDrainState(suppliedDrainState);
      return stateSnapshot();
    },

    recordFailure({ error, category, sequence, generation, at, drainState: suppliedDrainState, attempt = 1 } = {}) {
      const normalized = classifyFailure({ error, category });
      // 无 position 的失败照常计数（accepted: true），只有明确更旧的档位才返回 stale 丢弃。
      const position = positionOf({ sequence, generation });
      if (staleAgainstLatest(position, "failure")) {
        return { ...normalized, accepted: false, stale: true, health: stateSnapshot() };
      }
      advancePosition(position, "failure");
      const failure = {
        category: normalized.category,
        code: normalized.code,
        sequence: nonNegativeInteger(sequence),
        generation: nonNegativeInteger(generation),
        at: atOf(at, now),
        attempt: attemptNumber(attempt),
        message: textOf(error?.message ?? error),
      };
      lastFailure = failure;
      consecutiveFailures += 1;
      applyDrainState(suppliedDrainState);
      return { ...normalized, accepted: true, failure, health: stateSnapshot() };
    },

    retryDecision(categoryOrOptions = {}, suppliedAttempt = 1) {
      const input = typeof categoryOrOptions === "string"
        ? { category: categoryOrOptions, attempt: suppliedAttempt }
        : categoryOrOptions;
      const normalized = classifyFailure(input);
      const attempt = attemptNumber(input?.attempt);
      if (normalized.category !== "transient" && normalized.category !== "generation-stale") {
        return { retry: false, merge: false, nextAttempt: null, reason: normalized.category };
      }
      if (attempt > retryLimit) {
        return { retry: false, merge: false, nextAttempt: null, reason: "retry-exhausted" };
      }
      return {
        retry: true,
        merge: normalized.category === "generation-stale",
        nextAttempt: attempt + 1,
        reason: normalized.category,
      };
    },

    shouldRetry(category, attempt = 1) {
      return api.retryDecision(category, attempt);
    },

    /**
     * 记录一次 session/child domain 写入的结果（同步 throw 或异步 reject 都归一到这里）。
     *
     * - 失败：分类为 transient/generation-stale/capacity/permanent 并只更新本通道；
     *   不触碰 fanout 的 lastFailure/latestPosition，因此不会改变其重试判定；
     * - 成功：只更新本通道的 lastSuccess，不掩盖 fanout 自己的失败状态。
     *
     * @param {object} input - { ok, error, generation, at, source }
     * @returns {{ok:boolean, category:string|null, code:string|null, health:object}}
     */
    observeStorageWrite({ ok = false, error, generation, at, source } = {}) {
      const position = nonNegativeInteger(generation);
      const observedAt = atOf(at, now);
      if (ok === true) {
        storageObserved += 1;
        lastStorageSuccess = { generation: position, at: observedAt, source: textOf(source) };
        return { ok: true, category: null, code: null, health: stateSnapshot() };
      }
      const normalized = classifyFailure({ error });
      storageObserved += 1;
      storageFailures += 1;
      lastStorageFailure = {
        category: normalized.category,
        code: normalized.code,
        generation: position,
        at: observedAt,
        source: textOf(source),
        message: textOf(error?.message ?? error),
      };
      return { ok: false, category: normalized.category, code: normalized.code, health: stateSnapshot() };
    },

    classifyFailure,
    snapshot: stateSnapshot,
    describe: stateSnapshot,
  };

  return Object.freeze(api);
}
