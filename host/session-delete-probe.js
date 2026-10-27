/**
 * 会话删除的启动探测（票据 01/规格决策 35）。
 *
 * 五项全过才启用删除能力；任一失败给出稳定原因码并让删除入口整体不可用（fail-closed）：
 * 1. **持久化服务可用**：`sessionPersistence` 存在且暴露 `list` / `stat`；
 * 2. **会话根可解析**：`dshHomePath('sessions')` 能解析出绝对路径；
 * 3. **记账写入口可用**：`workspaceRegistry` 存在、`list()` 可调用，且（有工作区时）
 *    首个 entity 暴露 `detachSession` 写入口；
 * 4. **实例锁可获取**：实例锁状态为 `acquired`（被占用/无法验证都算失败）。实例锁**不做
 *    自动接管**：锁文件已存在且不是本进程的就一律不可用，并把锁文件绝对路径带进诊断
 *    （`lockPath`），提示用户「请删除该文件后重启 DSH」；
 * 5. **收敛文档可解析**：两张删除表都读得出来。这一项失败同时意味着**本轮收敛整体暂停**
 *    （读不懂文档就拿不到任何一条记录，不存在「继续处理其他条目」这回事）。
 *
 * 探测结果只缓存在内存（诊断投影），不落盘：它不是用户偏好，每次启动都必须重新探测。
 *
 * ## 按需重算（refresh）
 * 启动只跑一次会漏掉「宿主服务晚就绪」的真实场景（典型：另一个插件晚于 DEG 激活
 * `workspaceRegistry`，第三项被永久缓存成不可用）。因此能力面额外提供**同步**的
 * `refresh()`：消费方（闸门的可用性读取面）只在缓存结论为不可用时重算一次，可用时零额外
 * 开销。重算与启动执行共用同一份检查实现，因此原因码、检查明细与判定完全一致；真正的故障
 * 重算后仍不可用（fail-closed），锁丢失仍是永久禁用（不重算、不恢复）。
 *
 * @module dsh-expert-group/host/session-delete-probe
 */
import { isAbsolute } from "node:path";

/** 启动探测的稳定原因码（可展示、可断言；不包含路径与进程细节）。 */
export const STARTUP_PROBE_REASONS = Object.freeze({
  /** 探测尚未完成：删除能力按不可用处理（fail-closed）。 */
  PROBE_PENDING: "delete-probe-pending",
  /** 持久化服务不可用。 */
  PERSISTENCE_UNAVAILABLE: "delete-persistence-unavailable",
  /** 会话根无法解析。 */
  SESSION_ROOT_UNRESOLVED: "delete-session-root-unresolved",
  /** 工作区记账写入口不可用。 */
  WORKSPACE_BOOKKEEPING_UNAVAILABLE: "delete-workspace-bookkeeping-unavailable",
  /** 实例锁被另一个**存活**实例持有。 */
  INSTANCE_LOCK_HELD: "delete-instance-lock-held",
  /** 实例锁属于另一个**已经退出**的实例（不自动接管，需要用户删掉锁文件后重启）。 */
  INSTANCE_LOCK_STALE: "delete-instance-lock-stale",
  /** 锁记录字段缺失或 JSON 不可解析。 */
  INSTANCE_LOCK_MALFORMED: "delete-instance-lock-malformed",
  /** 锁文件读不出来（权限/IO）。 */
  INSTANCE_LOCK_UNREADABLE: "delete-instance-lock-unreadable",
  /** 实例锁机制整体不可用（home 解析不出来、写入失败等）。 */
  INSTANCE_LOCK_UNAVAILABLE: "delete-instance-lock-unavailable",
  /**
   * 持锁方在作业开始前复核时发现锁已被替换（另一个实例接管了）：删除能力**永久**不可用，
   * 不再重试。由删除作业在 fail-closed 拒绝时通过探测的 `markUnavailable` 上报。
   */
  INSTANCE_LOCK_LOST: "delete-instance-lock-lost",
  /** 收敛文档不可解析：删除入口不可用，且本轮收敛整体暂停。 */
  QUEUE_UNREADABLE: "delete-queue-unreadable",
});

/** 探测项名称（顺序 = 规格书列举顺序，诊断按此顺序输出）。 */
const PROBE_ITEM_NAMES = Object.freeze(["persistence", "session-root", "bookkeeping", "instance-lock", "queue-document"]);

/**
 * 纯判定：把五项检查结果合成本轮删除能力结论。
 *
 * @param {Array<{ok: boolean, reason?: string}>} results - 按 {@link PROBE_ITEM_NAMES} 顺序的检查结果。
 * @returns {{available: boolean, reasons: string[], convergencePaused: boolean}} 能力结论。
 */
export function evaluateStartupProbe(results) {
  const reasons = [];
  for (const result of Array.isArray(results) ? results : []) {
    if (result?.ok === true) continue;
    const reason = typeof result?.reason === "string" && result.reason.length > 0
      ? result.reason
      : STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE;
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  return {
    available: reasons.length === 0,
    reasons,
    convergencePaused: reasons.includes(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE),
  };
}

/** 从锁快照里取诊断用路径（没有就是没有，绝不伪造）。 */
function readLockPath(snapshot) {
  const lockPath = snapshot?.lockPath;
  return typeof lockPath === "string" && lockPath.length > 0 ? lockPath : undefined;
}

/**
 * 实例锁快照 → 探测结论（**纯函数**）。
 *
 * 原因码优先按锁模块的**具体原因**映射（stale / held / malformed / unreadable / lost），
 * 认不出来才退回「机制不可用」。无论哪种失败，只要快照里带 `lockPath` 就原样透传——
 * 它是用户动手删文件的唯一线索。
 *
 * @param {object|undefined} snapshot - `lock.snapshot()` 的返回值。
 * @returns {{ok: boolean, reason?: string, lockPath?: string}} 该检查项结论。
 */
export function evaluateInstanceLockProbe(snapshot) {
  const lockPath = readLockPath(snapshot);
  const withPath = lockPath === undefined ? {} : { lockPath };
  if (snapshot?.status === "acquired") return { ok: true };
  const reason = snapshot?.reason;
  if (reason === "instance-lock-stale") {
    return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_STALE, ...withPath };
  }
  if (reason === "instance-lock-held") {
    return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_HELD, ...withPath };
  }
  if (reason === "instance-lock-malformed") {
    return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_MALFORMED, ...withPath };
  }
  if (reason === "instance-lock-unreadable") {
    return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_UNREADABLE, ...withPath };
  }
  if (reason === "instance-lock-lost") {
    return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_LOST, ...withPath };
  }
  return { ok: false, reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_UNAVAILABLE, ...withPath };
}

/** 从宿主服务名读取器里安全取服务（读取失败等价于「宿主没有该服务」）。 */
function readService(readHostService, name) {
  try {
    return readHostService?.(name);
  } catch {
    return undefined;
  }
}

/** 检查项子原因里附带异常 message 时的字符上限：诊断要能贴进错误消息，不能无限长。 */
const PROBE_DETAIL_MESSAGE_LIMIT = 120;

/**
 * 把「子原因短码 + 异常 message」拼成 detail（message 截断到上限）。
 *
 * 子原因短码是稳定词表（调用方/测试可断言）；异常 message 只做后缀，用于区分「同一子原因
 * 下的不同具体报错」，绝不改变原因码与判定。
 */
function detailWithMessage(detail, error) {
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.length === 0) return detail;
  const truncated = message.length > PROBE_DETAIL_MESSAGE_LIMIT
    ? message.slice(0, PROBE_DETAIL_MESSAGE_LIMIT)
    : message;
  return detail + ": " + truncated;
}

/** 构造一条失败检查结论（子原因 detail 是稳定短码，只用于诊断，不参与判定）。 */
function probeFailure(reason, detail) {
  return { ok: false, reason, detail };
}

/**
 * 构造五项检查（每项返回 `{ok, reason?, detail?, lockPath?}`，永不抛错）。
 *
 * `detail` 是**可诊断子原因**：原因码 `reason` 决定可用性与对外错误，`detail` 只回答
 * 「同一个原因码下具体是哪一步失败」（服务缺失 / 读面抛错 / 形状不符…）。它不参与任何判定，
 * 只在失败时出现，成功项不带该字段。
 *
 * @param {object} deps - 见 {@link installStartupProbe}。
 * @returns {Array<{name: string, run: Function}>} 检查列表。
 */
function buildProbeChecks({ readHostService, lock, store }) {
  return [
    {
      name: PROBE_ITEM_NAMES[0],
      reason: STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE,
      run() {
        const persistence = readService(readHostService, "sessionPersistence");
        if (persistence === null || typeof persistence !== "object") {
          return probeFailure(STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE, "service-missing");
        }
        if (typeof persistence.list !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE, "list-missing");
        }
        if (typeof persistence.stat !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE, "stat-missing");
        }
        return { ok: true };
      },
    },
    {
      name: PROBE_ITEM_NAMES[1],
      reason: STARTUP_PROBE_REASONS.SESSION_ROOT_UNRESOLVED,
      run() {
        const dshHomePath = readService(readHostService, "dshHomePath");
        if (typeof dshHomePath !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.SESSION_ROOT_UNRESOLVED, "service-missing");
        }
        let root;
        try {
          root = dshHomePath("sessions");
        } catch {
          return probeFailure(STARTUP_PROBE_REASONS.SESSION_ROOT_UNRESOLVED, "threw");
        }
        const resolved = typeof root === "string" && root.length > 0 && isAbsolute(root);
        return resolved
          ? { ok: true }
          : probeFailure(STARTUP_PROBE_REASONS.SESSION_ROOT_UNRESOLVED, "not-absolute");
      },
    },
    {
      name: PROBE_ITEM_NAMES[2],
      reason: STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE,
      run() {
        const registry = readService(readHostService, "workspaceRegistry");
        if (registry === null || typeof registry !== "object") {
          return probeFailure(STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE, "service-missing");
        }
        if (typeof registry.get !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE, "get-missing");
        }
        if (typeof registry.list !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE, "list-missing");
        }
        let entities;
        try {
          entities = registry.list();
        } catch (error) {
          // 抛错时把 message 截断后作为后缀：真机上「registry 抛了什么」是定位关键。
          return probeFailure(
            STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE,
            detailWithMessage("list-threw", error),
          );
        }
        if (!Array.isArray(entities)) {
          return probeFailure(STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE, "not-array");
        }
        // 空注册表是合法状态（还没有工作区）：只验证读面可用；有 entity 时再验证写入口。
        if (entities.length === 0) return { ok: true };
        const writer = entities[0];
        if (writer === null || typeof writer !== "object" || typeof writer.detachSession !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.WORKSPACE_BOOKKEEPING_UNAVAILABLE, "detach-missing");
        }
        return { ok: true };
      },
    },
    {
      name: PROBE_ITEM_NAMES[3],
      reason: STARTUP_PROBE_REASONS.INSTANCE_LOCK_UNAVAILABLE,
      run() {
        // 实例锁沿用既有锁原因码，不引入子原因（锁诊断的权威信息是 lockPath 与锁原因码本身）。
        return evaluateInstanceLockProbe(lock.snapshot());
      },
    },
    {
      name: PROBE_ITEM_NAMES[4],
      reason: STARTUP_PROBE_REASONS.QUEUE_UNREADABLE,
      run() {
        if (store === null || typeof store !== "object" || typeof store.describeDocument !== "function") {
          return probeFailure(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE, "store-missing");
        }
        let document;
        try {
          document = store.describeDocument();
        } catch {
          // 读文档抛错与「读到了但不可解析」同义：都拿不到收敛事实 → 同一原因码。
          return probeFailure(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE, "unreadable");
        }
        return document?.readable === true
          ? { ok: true }
          : probeFailure(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE, "unreadable");
      },
    },
  ];
}

/**
 * 创建启动探测。
 *
 * @param {object} deps
 * @param {(name: string) => unknown} deps.readHostService - 宿主服务读取器（组合根注入）。
 * @param {{snapshot: Function}} deps.lock - 实例锁能力面。
 * @param {{describeDocument: Function}} deps.store - 收敛日志读写原语。
 * @param {{now: Function}} [deps.clock] - 只读时钟（记录 checkedAt）。
 * @param {{warn?: Function}} [deps.logger] - 诊断日志（只记原因码）。
 * @returns {{run: Function, refresh: Function, snapshot: Function, markUnavailable: Function,
 *   dispose: Function}} 探测能力面。
 */
export function installStartupProbe({ readHostService, lock, store, clock, logger }) {
  const pending = Object.freeze({
    available: false,
    reasons: Object.freeze([STARTUP_PROBE_REASONS.PROBE_PENDING]),
    convergencePaused: false,
    checkedAt: undefined,
    checks: Object.freeze([]),
  });
  let result = pending;
  let running;
  let disposed = false;

  /**
   * 记录一次不可用结论（供「探测根本没跑起来」与「运行期发现锁丢失」的路径使用）。
   *
   * @param {string} reason - {@link STARTUP_PROBE_REASONS} 之一。
   * @param {{lockPath?: string}} [options] - 已知锁文件路径时一并带上（供 UI/日志展示）。
   */
  function markUnavailable(reason, options = {}) {
    if (disposed) return result;
    const normalized = typeof reason === "string" && reason.length > 0
      ? reason
      : STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE;
    const evaluation = evaluateStartupProbe([{ ok: false, reason: normalized }]);
    const lockPath = readLockPath(options);
    result = {
      ...evaluation,
      checkedAt: currentTime(),
      ...(lockPath === undefined ? {} : { lockPath }),
      checks: [],
    };
    return result;
  }

  function currentTime() {
    try {
      const now = clock?.now?.();
      return Number.isFinite(now) ? now : undefined;
    } catch {
      return undefined;
    }
  }

  /** 读回检查项给出的子原因（只认非空字符串；成功项不产出 detail）。 */
  function readDetail(outcome) {
    const detail = outcome?.detail;
    return typeof detail === "string" && detail.length > 0 ? detail : undefined;
  }

  /**
   * 同步执行五项检查并返回原始结果（**永不抛出**）。
   *
   * 检查项按契约是同步的：单项抛错按该项的规范原因码 fail-closed，不影响其余检查。
   * 启动执行（execute）与按需重算（refresh）共用这一份实现，两条路径的语义因此不会分叉。
   */
  function runChecks() {
    const checks = buildProbeChecks({ readHostService, lock, store });
    const results = [];
    const details = [];
    /** 实例锁检查项报出的锁文件路径（顶层透传，供闸门/诊断读取）。 */
    let instanceLockPath;
    for (const check of checks) {
      let outcome;
      try {
        outcome = check.run();
      } catch {
        // 检查自身抛错等于不可证明：按该项的规范原因码失败处理（fail-closed）。
        outcome = { ok: false, reason: check.reason };
      }
      const entry = outcome?.ok === true
        ? { ok: true }
        : { ok: false, reason: outcome?.reason };
      // 实例锁的检查项会把锁文件路径带出来：诊断（checks[] 与结果顶层）都要能让用户看到它。
      const lockPath = readLockPath(outcome);
      if (lockPath !== undefined) instanceLockPath = lockPath;
      // 子原因只在失败项出现；成功项不带 detail（快照形状与既有断言保持一致）。
      const detail = entry.ok === false ? readDetail(outcome) : undefined;
      results.push(entry);
      details.push({
        name: check.name,
        ok: entry.ok,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(detail === undefined ? {} : { detail }),
        ...(lockPath === undefined ? {} : { lockPath }),
      });
    }
    return { evaluation: evaluateStartupProbe(results), instanceLockPath, details };
  }

  /** 把一次检查结果写入快照（execute 与 refresh 共用，避免两份赋值分叉）。 */
  function applyChecks({ evaluation, instanceLockPath, details }) {
    result = {
      ...evaluation,
      checkedAt: currentTime(),
      ...(instanceLockPath === undefined ? {} : { lockPath: instanceLockPath }),
      checks: details,
    };
    return evaluation;
  }

  /** 执行五项检查并缓存结论（并发调用共享同一次执行）。 */
  async function execute() {
    const evaluation = applyChecks(runChecks());
    if (evaluation.available !== true) {
      // 用 info 而不是 warn：删除能力不可用是**能力状态**，不是本次操作的故障，权威读面是
      // 探测快照（由 RPC 诊断投影给用户）。宿主 logger 的 warn 会被无关用例当成「有告警」，
      // 而逐次启动都打一条只会制造噪声，反而淹没真正的删除失败。
      try {
        logger?.info?.("dsh-expert-group: session delete unavailable [" + evaluation.reasons.join(",") + "]");
      } catch {
        // 诊断日志失败不得影响探测结论。
      }
    }
    return snapshot();
  }

  /**
   * **按需重算**五项检查并更新快照（同步、**永不抛出**）。
   *
   * 消费方（闸门的可用性读取面）只在缓存结论为「不可用」时调用它：启动期还没就绪的宿主
   * 服务（典型：另一个插件晚于 DEG 激活 `workspaceRegistry`）因此可以自愈，而真正的故障
   * 重算之后仍然不可用——fail-closed 不变。三条边界：
   * - **卸载后不重算**：保留最后一次结论（与 run 的语义一致）；
   * - **锁丢失是永久禁用**（与 markUnavailable 的语义一致）：缓存里已有该原因时不重算、
   *   不恢复，绝不把「已被别的实例接管」翻回可用；
   * - 检查项自身抛错按该项规范原因码失败，整次重算绝不向调用方抛出。
   *
   * @returns {object} 重算后的快照（与 {@link snapshot} 同形）。
   */
  function refresh() {
    if (disposed) return snapshot();
    if (result.reasons.includes(STARTUP_PROBE_REASONS.INSTANCE_LOCK_LOST)) return snapshot();
    try {
      applyChecks(runChecks());
    } catch {
      // 连检查列表都构建不出来：退化为「持久化不可用」，调用方继续 fail-closed。
      markUnavailable(STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE);
    }
    return snapshot();
  }

  function snapshot() {
    return {
      ...result,
      reasons: [...result.reasons],
      checks: result.checks.map((check) => ({ ...check })),
    };
  }

  return Object.freeze({
    /** 执行检测（只跑一次；并发调用共享同一个 Promise）。 */
    run() {
      if (disposed) return Promise.resolve(snapshot());
      running ??= execute().catch(() => markUnavailable(STARTUP_PROBE_REASONS.PERSISTENCE_UNAVAILABLE));
      return running.then(() => snapshot());
    },
    /** 按需重算（同步、永不抛出）：供消费方在缓存不可用时自愈，见 {@link refresh} 的边界说明。 */
    refresh,
    snapshot,
    markUnavailable,
    /** 卸载：保留最后一次结论（诊断仍可读），只拒绝后续执行。 */
    dispose() {
      disposed = true;
    },
  });
}
