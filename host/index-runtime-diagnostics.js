/**
 * 入口运行时诊断投影域（R4e · 票据 19）。
 *
 * 全部是**只读投影**：只输出计数、固定状态枚举与结构化错误类别——没有会话/agent id、
 * 没有 prompt 或原始请求体、没有 token/Cookie/authorization、没有任何文件系统路径。
 * 所有数组都有固定上限（RPC 错误类别 8 条、rootTurnWait roots 8 条、provider 32 条），
 * 因此报告大小不随任务或历史增长。
 *
 * 三段投影：
 * - 系统 Toast（ADR 0005）：逐字段重建白名单结构，绝不解构 describe() 原对象；
 * - root turn 等待账本（票据 11）：未结算总量/最早等待/能力等级/最近收口投递；
 * - 运行时摘要：fanout 队列与停止边界、持久化/恢复、委派范围、设置代次、storage 与 RPC。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册、不持状态：所有状态都经各域的命令/只读投影获取。
 *
 * @module dsh-expert-group/host/index-runtime-diagnostics
 */
import { SYSTEM_TOAST_REASONS } from "./system-toast.js";
import {
  CAPABILITY_REPORT_VERSION,
  RPC_ERROR_CATEGORY_LIMIT,
  diagnosticCount,
  diagnosticMessage,
  diagnosticTime,
  diagnosticToken,
  projectThrottleDiagnostics,
} from "./runtime-diagnostics.js";
import { AUTO_RECOVERY_LIMIT } from "../shared/recovery-ledger.js";
import { lastOrdinaryFallbackDiagnostics } from "./route-diagnostics.js";

/**
 * 创建运行时诊断投影能力面。
 *
 * @param {object} deps - 窄能力面（8 组）。
 * @param {object} deps.host - host 组合门面（同一关注点：host 子服务只读 describe）：
 *   `lineage.describe()`、`handoff.describe()`、`notifications.describe()`。
 * @param {object} deps.settings - settings runtime：`describe()`。
 * @param {object} deps.storage - settings/storage 域：`describe()` 与
 *   `readLastEventRestore()`（冷启动事件历史恢复结论）。
 * @param {object} deps.recovery - 恢复域：`describe()`、`activationCount()`、`recordCount()`。
 * @param {object} deps.fanout - fan-out Host 晚绑定：`getFanoutHost()`。
 * @param {object} deps.roles - 角色目录投影：`activeRoles()`（只用于限制启用角色的上限投影）。
 * @param {object} deps.delegation - 委派跟踪器 + 范围释放诊断：`activeTaskCounts()`、
 *   `readLastRefusedScopeRelease()`。
 * @param {object} deps.observability - 只读诊断源（同一关注点：诊断输入）：
 *   `rpcErrors()`、`systemToast()`（返回适配器或 undefined）、
 *   `rootWait.describeAll()`、`rootWait.diagnostics()`。
 * @returns {{describeRuntimeDiagnostics: () => object}} 诊断投影。
 */

// ── 模块级只读投影（无状态、可单测；工厂只做装配与组合）─────────────────

/**
 * 系统 Toast 诊断的固定 token 白名单。
 *
 * 为什么不复用 diagnosticToken：它的字符面允许 a/b、x.log 这类形如相对路径的字符串，
 * 而系统 Toast 的可用性只需要模块声明的固定类别。白名单保证注入实现返回的自由文本
 * （错误消息、AUMID、命令行片段）一律进不了诊断面。
 */
const systemToastTokenSet = new Set(Object.values(SYSTEM_TOAST_REASONS));
function systemToastDiagnosticToken(value) {
  return typeof value === "string" && systemToastTokenSet.has(value) ? value : null;
}

/**
 * 系统 Toast 的只读诊断投影（ADR 0005）。
 *
 * 逐字段重建白名单结构，绝不解构 describe() 原对象：注入实现即使返回正文、AUMID、
 * 命令行或绝对路径也不会进入诊断。计数一律归一为非负安全整数，平台只保留两个固定
 * 枚举，reason 只保留模块声明的 token；适配器缺失或 describe() 抛错时显式
 * status="absent"，不用伪造的计数冒充可用。
 */
function describeSystemToastDiagnostics(systemToast) {
  let state = null;
  try {
    state = typeof systemToast?.describe === "function" ? systemToast.describe() : null;
  } catch {
    state = null;
  }
  if (state === null || typeof state !== "object") {
    return {
      status: "absent",
      version: 0,
      platform: "unknown",
      aumidResolved: false,
      aumidReason: null,
      inflight: 0,
      queued: 0,
      sent: 0,
      failed: 0,
      dropped: 0,
      lastReason: null,
    };
  }
  return {
    status: "available",
    version: diagnosticCount(state.version),
    platform: state.platform === "windows" ? "windows" : "unsupported",
    aumidResolved: state.aumidResolved === true,
    // 只暴露"解析结果类别/是否已解析"，绝不暴露 AUMID 本身：
    // aumidReason=ok 表示已从与 process.execPath 匹配的快捷方式派生出身份。
    aumidReason: systemToastDiagnosticToken(state.aumidReason),
    inflight: diagnosticCount(state.inflight),
    queued: diagnosticCount(state.queued),
    sent: diagnosticCount(state.sent),
    failed: diagnosticCount(state.failed),
    dropped: diagnosticCount(state.dropped),
    lastReason: systemToastDiagnosticToken(state.lastReason),
  };
}

/** rootTurnWait 诊断里 roots 摘要数组的固定上限（避免诊断随 root 数量增长）。 */
const ROOT_TURN_WAIT_DIAGNOSTIC_ROOT_LIMIT = 8;

/**
 * root turn 等待账本的只读诊断投影（票据 11）。
 *
 * 只回答「还有多少未结算工作、最早等了多久、后代查询能力如何、最近一次收口投递是否
 * 成功、有没有人工关闭过账本」。所有字段都是计数/固定枚举/时间戳：roots 摘要不含
 * root/session id、agent 引用、work 键、prompt 或任何专家输出，因此可直接进入 meta。
 */
function describeRootTurnWaitDiagnostics(rootWait) {
  let summaries = [];
  try {
    summaries = typeof rootWait.describeAll === "function" ? rootWait.describeAll() : [];
  } catch {
    // 诊断自身绝不因为账本读取失败而让 meta 失败：退化为空视图。
    summaries = [];
  }
  let outstandingTotal = 0;
  let oldestWaitedMs = 0;
  const capability = { available: 0, degraded: 0, unavailable: 0 };
  const roots = [];
  for (const summary of summaries) {
    if (summary === null || typeof summary !== "object") continue;
    const outstanding = diagnosticCount(summary.outstanding);
    const waitedMs = diagnosticCount(summary.waitedMs);
    outstandingTotal += outstanding;
    if (waitedMs > oldestWaitedMs) oldestWaitedMs = waitedMs;
    // capabilityLevel 由账本从 lastSnapshot 导出；非法/缺失一律按 unavailable（未知不可用）。
    const level = summary.capabilityLevel === "available" || summary.capabilityLevel === "degraded"
      ? summary.capabilityLevel
      : "unavailable";
    capability[level] += 1;
    if (roots.length < ROOT_TURN_WAIT_DIAGNOSTIC_ROOT_LIMIT) {
      roots.push({ waitedMs, outstanding, capability: level });
    }
  }
  // 等待账本诊断走域服务的只读投影：本文件不再持有 lastRootWaitDelivery /
  // rootWaitAbandonCount 的可写引用（票据 15：状态唯一 owner）。
  const waitDiagnostics = rootWait.diagnostics();
  const lastDelivery = waitDiagnostics.lastDelivery;
  return {
    outstandingTotal: diagnosticCount(outstandingTotal),
    // 账本的 describeAll 本身有 16 条上限，因此 rootCount 与下面聚合都是同界样本。
    rootCount: diagnosticCount(summaries.length),
    oldestWaitedMs: diagnosticCount(oldestWaitedMs),
    abandonedCount: diagnosticCount(waitDiagnostics.abandonedCount),
    // 最近一次收口投递：at/ok/固定原因码；从未投递过为 null。
    lastDelivery: lastDelivery === null
      ? null
      : {
        at: diagnosticTime(lastDelivery.at),
        ok: lastDelivery.ok === true,
        reason: diagnosticToken(lastDelivery.reason, null),
      },
    capability,
    roots,
  };
}

/**
 * provider 名的安全投影（票据 05 · F4）。
 *
 * provider 名是用户在设置里写的公开配置（不是会话数据），但仍做两步归一：去掉控制字符
 * 并截断到 64 字符，保证诊断面不会被伪造的多行文本或超长配置污染。
 */
function diagnosticProviderName(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return cleaned.length === 0 ? null : cleaned.slice(0, 64);
}

/**
 * fan-out 段投影（队列/事件/停止边界/并发与限流）。
 * @param {object} diagnosticsState - describeRuntimeDiagnostics 已计算的只读局部量。
 * @returns {object} fanout 投影。
 */
function projectFanoutDiagnostics(diagnosticsState) {
  const {
    fanoutState,
    managerEventHistory,
    activeParents,
    queuedShards,
    runningShards,
    concurrency,
    roleOverrides,
    providerOverrides,
    providerRelease,
    stopState,
    stopAging,
  } = diagnosticsState;
  return {
    tasks: diagnosticCount(fanoutState.tasks),
    activeAttempts: diagnosticCount(fanoutState.activeAttempts),
    settledTasks: diagnosticCount(fanoutState.settledTasks),
    activeParents,
    queuedShards,
    runningShards,
    restorePending: fanoutState.restorePending === true,
    closed: fanoutState.closed === true,
    /**
     * 事件历史窗口（票据 04）：
     * - retained/bytes：当前保留的历史规模；
     * - dropped/earliestSequence：已被裁剪的累计条数与最早可用序号（gap 判定）；
     * - restore：冷启动 restoreEvents 的布尔结果（过去被丢弃）。
     */
    events: {
      retained: diagnosticCount(fanoutState.budget?.events),
      bytes: diagnosticCount(fanoutState.budget?.eventBytes),
      dropped: diagnosticCount(managerEventHistory?.dropped),
      earliestSequence: diagnosticTime(managerEventHistory?.earliestSequence),
      restore: (() => {
        // 冷启动事件历史恢复的结论由 settings/storage 域持有，这里只读一次投影。
        const lastEventRestore = diagnosticsState.readLastEventRestore();
        return lastEventRestore === null
          ? null
          : {
            accepted: lastEventRestore.accepted === true,
            attempted: lastEventRestore.attempted === true,
            at: diagnosticTime(lastEventRestore.at),
          };
      })(),
      // Host 自有查询日志（服务 RPC fanout-events）的保留窗口状态；与 manager 的
      // 持久化事件历史分开计数，两者都只暴露计数/序号。
      log: fanoutState.eventLog === null || fanoutState.eventLog === undefined
        ? null
        : {
          retained: diagnosticCount(fanoutState.eventLog.count),
          dropped: diagnosticCount(fanoutState.eventLog.dropped),
          earliestSequence: diagnosticTime(fanoutState.eventLog.earliestSequence),
          restoreAccepted: fanoutState.eventLog.restoreAccepted === true,
        },
    },
    /**
     * 真实停止边界（票据 07）：
     * - stopPending/legacy：聚合阻塞源与旧快照派生身份的规模；
     * - boundary/boundarySource：最近一次恢复使用的边界（显式或按进程身份自动）；
     * - watchdogExpired/attributedAged/needsAttention：宽限/老化/需人工处理的计数。
     * 这些字段回答"任务为什么还没结算"，不暴露任何任务负载。
     */
    stop: {
      stopPending: diagnosticCount(stopState?.stopPending),
      unobserved: diagnosticCount(stopState?.unobserved),
      requested: diagnosticCount(stopState?.requested),
      watchdogExpired: diagnosticCount(stopState?.watchdogExpired),
      legacy: diagnosticCount(stopState?.legacy),
      attributedAged: diagnosticCount(stopState?.attributedAged),
      needsAttention: diagnosticCount(stopState?.needsAttention),
      boundary: diagnosticToken(stopState?.boundary, "unknown"),
      boundarySource: diagnosticToken(stopState?.boundarySource, "unknown"),
      lastWatchdogAt: diagnosticTime(stopState?.lastWatchdog?.at),
      aging: stopAging === null || stopAging === undefined
        ? null
        : {
          enabled: stopAging.enabled === true,
          windowMs: diagnosticCount(stopAging.windowMs),
          pending: diagnosticCount(stopAging.pending),
          aged: diagnosticCount(stopAging.aged),
          skipped: diagnosticCount(stopAging.skipped),
          lastAgedAt: diagnosticTime(stopAging.lastAged?.at),
          lastAgedReason: diagnosticToken(stopAging.lastAged?.reason, null),
        },
    },
    concurrency: {
      default: diagnosticCount(concurrency?.default),
      roles: roleOverrides,
      /**
       * provider 级上限（票据 26）：0 = 显式不限制，未出现 = 未配置（同样不限制）。
       * 与 roles 一样只投影归一后的生效值。
       */
      providers: providerOverrides,
      /**
       * 限流/排队诊断（票据 26）：按 role 与 provider 的 limit/running/queued/
       * lastThrottledAt/etaMs。数据源是 manager 的同一套 running 计数与 shard
       * 状态（没有第二套计数器）；etaMs 在样本不足时显式为 null + "unknown"。
       */
      throttle: fanoutState.throttle === null || fanoutState.throttle === undefined
        ? null
        : projectThrottleDiagnostics(fanoutState.throttle),
      /**
       * provider 名额释放异常（票据 05 · F4）：最近一条 `PROVIDER_RELEASE_MISMATCH`。
       *
       * 只在「释放了一个从未计数的桶」（桶缺失或计数已为 0）时出现，回答"某次执行的名额
       * 为什么没有归还"。字段只有稳定 code / provider 名 / 时间戳 / 释放来源，null 表示
       * 本进程内从未发生——不记任务正文、prompt 或任何凭据。
       */
      providerRelease: providerRelease === null || providerRelease === undefined
        ? null
        : {
          code: diagnosticToken(providerRelease.code, "unknown"),
          provider: diagnosticProviderName(providerRelease.provider),
          at: diagnosticTime(providerRelease.at),
          source: diagnosticToken(providerRelease.source, "unknown"),
        },
      // 解析来源（live / snapshot / fallback）与最近一次非法上限只保留固定
      // 枚举/类型；message 是插件内部固定文案（不含设置原文或原始返回值），
      // 经长度与控制字符归一再透出，让用户能解释"设置页=3、实际并发=20"。
      source: diagnosticToken(concurrency?.source, "unknown"),
      invalidKind: concurrency?.invalid === undefined ? null : diagnosticToken(concurrency.invalid.kind),
      invalidValueType: concurrency?.invalid === undefined
        ? null
        : diagnosticToken(concurrency.invalid.valueType, "unknown"),
      invalidMessage: diagnosticMessage(concurrency?.invalid?.message),
    },
    /**
     * 时段/层/跨层回退诊断（票据 06）：只投影「最近一次跨层回退」的稳定事实。
     *
     * 数据源是 host/route-diagnostics.js 的进程内单值——派发期「时段层缺该角色 → 直接跨层」
     * 与运行期「时段层耗尽 → 切普通层」都会写它；本投影只读副本，不读 settings、不读时钟，
     * 因此诊断面永远不会按当前配置推断一次历史回退。
     *
     * 字段只有 role / fromTier / toTier / reasonCode / at（角色与原因码都经过长度与字符面
     * 归一），null 表示本进程从未发生；不含候选清单、prompt 或任何凭据。
     */
    route: {
      lastOrdinaryFallback: lastOrdinaryFallbackDiagnostics(),
    },
  };
}

/**
 * 持久化与恢复可见性段投影（落盘结果/失败分类/恢复与预算拒绝）。
 * @param {object} diagnosticsState - describeRuntimeDiagnostics 已计算的只读局部量。
 * @returns {object} persistence 投影。
 */
function projectPersistenceDiagnostics(diagnosticsState) {
  const {
    primaryPersist,
    primaryCategory,
    persistenceHealthState,
    healthSuccess,
    healthFailure,
    blockedPersistence,
    lastRestoreState,
    lastBudgetViolation,
    fanoutState,
  } = diagnosticsState;
  return {
    lastResult: primaryPersist === null ? null : diagnosticToken(primaryPersist.status, "unknown"),
    reason: primaryPersist === null ? null : diagnosticToken(primaryPersist.reason, null),
    bytes: primaryPersist === null ? null : diagnosticTime(primaryPersist.bytes),
    // 分类权威是 Host persistence-health；manager 自带 category 只作为回退。
    category: diagnosticToken(primaryCategory, null),
    consecutiveFailures: diagnosticCount(persistenceHealthState.consecutiveFailures),
    lastSuccessAt: diagnosticTime(healthSuccess?.at),
    lastFailureAt: diagnosticTime(healthFailure?.at),
    blocked: blockedPersistence === null ? null : diagnosticToken(blockedPersistence.reason, "unknown"),
    restore: lastRestoreState === null
      ? null
      : {
        ok: lastRestoreState.ok === true,
        code: diagnosticToken(lastRestoreState.error?.code, null),
        field: diagnosticToken(lastRestoreState.error?.field, null),
        message: diagnosticMessage(lastRestoreState.error?.message),
        at: diagnosticTime(lastRestoreState.at),
        restored: diagnosticCount(lastRestoreState.restored),
        deferred: diagnosticCount(lastRestoreState.deferred),
        pending: lastRestoreState.pending === true,
      },
    lastBudgetViolation: lastBudgetViolation === null
      ? null
      : {
        code: diagnosticToken(lastBudgetViolation.code, null),
        resource: diagnosticToken(lastBudgetViolation.resource, null),
        phase: diagnosticToken(fanoutState.budget?.lastViolationPhase, null),
        limit: diagnosticTime(lastBudgetViolation.limit),
        receivedBytes: diagnosticTime(lastBudgetViolation.receivedBytes),
        recoverable: lastBudgetViolation.recoverable === true,
        complete: lastBudgetViolation.complete === true,
      },
  };
}

/**
 * 两阶段图片路由的只读计数投影（纯数字，不含 claim id / child id / provider / model）。
 *
 * 提到模块级是为了让 describeRuntimeDiagnostics 保持在其行数预算内；投影本身无状态。
 *
 * @param {object} state - claim 域只读状态。
 * @returns {{claims:number, cleanupTokens:number, cleanupReservations:number,
 *   claimLimit:number, cleanupTokenLimit:number}} 计数投影。
 */
function projectImageRoutes(state) {
  return {
    claims: diagnosticCount(state.claims),
    cleanupTokens: diagnosticCount(state.cleanupTokens),
    cleanupReservations: diagnosticCount(state.cleanupReservations),
    claimLimit: diagnosticCount(state.claimLimit),
    cleanupTokenLimit: diagnosticCount(state.cleanupTokenLimit),
  };
}

export function createRuntimeDiagnostics({ host, settings, storage, recovery, fanout, roles, delegation, observability }) {
  function describeRuntimeDiagnostics() {
    const settingsState = settings.describe();
    const storageState = storage.describe();
    const lineageState = host.lineage.describe();
    const notificationState = host.notifications.describe();
    const handoffState = host.handoff.describe();
    const recoveryState = recovery.describe();
    const fanoutHost = fanout.getFanoutHost();
    const fanoutState = typeof fanoutHost?.describe === "function" ? fanoutHost.describe() : {};
    const tasks = typeof fanoutHost?.listTasks === "function" ? fanoutHost.listTasks() : [];
    // 队列深度按 shard 聚合：maxTasks 有上界（resource-budget），因此这里是常数级工作。
    let queuedShards = 0, runningShards = 0, activeParents = 0;
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const counts = task?.counts ?? {};
      queuedShards += diagnosticCount(counts.queued);
      runningShards += diagnosticCount(counts.running);
      if (diagnosticCount(counts.pending) > 0) activeParents += 1;
    }
    const concurrency = fanoutState.concurrencyLimits;
    const roleLimits = concurrency?.roles;
    const roleOverrides = {};
    if (roleLimits !== null && typeof roleLimits === "object") {
      // 只保留启用角色的上限：角色名是公开契约，不携带任何会话数据。
      for (const role of roles.activeRoles()) {
        if (Number.isSafeInteger(roleLimits[role])) roleOverrides[role] = roleLimits[role];
      }
    }
    /**
     * provider 级上限投影（票据 26）：provider 名是用户在设置里写的公开配置，
     * 不是会话数据；仍然做条数/长度上限，保证诊断大小不随配置无界增长。
     */
    const providerOverrides = {};
    const providerLimitsState = concurrency?.providers;
    if (providerLimitsState !== null && typeof providerLimitsState === "object") {
      for (const provider of Object.keys(providerLimitsState).slice(0, 32)) {
        const limit = providerLimitsState[provider];
        if (Number.isSafeInteger(limit)) providerOverrides[provider.slice(0, 64)] = limit;
      }
    }
    /**
     * 持久化/恢复诊断投影（票据 04）。
     *
     * 分类权威是 host/persistence-health（failureCategory/consecutiveFailures/时间戳），
     * manager 只提供它亲眼观察到的落盘结果（saved/skipped(reason)/failed(bytes)）。
     * 两者合并，但绝不把快照正文、任务负载或错误堆栈放进诊断。
     */
    const persistenceState = fanoutState.persistence ?? {};
    const managerPersistence = persistenceState.manager ?? {};
    const managerPersist = managerPersistence.lastResult ?? null;
    const hostPersist = persistenceState.lastResult ?? null;
    const blockedPersistence = persistenceState.blocked ?? null;
    const persistenceHealthState = fanoutState.persistenceHealth ?? {};
    const healthFailure = persistenceHealthState.lastFailure ?? null;
    const healthSuccess = persistenceHealthState.lastSuccess ?? null;
    const lastBudgetViolation = fanoutState.budget?.lastViolation ?? null;
    const managerEventHistory = persistenceState.eventHistory ?? null;
    const lastRestoreState = persistenceState.restore ?? null;
    /**
     * 停止边界诊断（票据 07）：manager 的未确认停止视图 + Host 的归属老化窗口。
     * 只投影计数/固定枚举/时间戳，绝不透出 prompt、结果或会话正文。
     */
    const stopState = fanoutState.stop ?? null;
    const stopAging = stopState?.aging ?? null;
    /**
     * 委派影响范围诊断（票据 07）：只回答「还有多少活动范围、其中多少已脱离 root」与
     * 最近一次 release_scope 被拒绝的摘要（时间/条数/固定原因码）。活动项只计数，
     * 不含 child/agent id、prompt、任务正文或路径。
     */
    const delegationCounts = delegation.activeTaskCounts();
    // 恢复失败 fail-closed 时以 Host 的 restore_failed 跳过原因为准；否则 Host 的
    // skipped/failed 优先（它是真实写入结果），Host 成功时再取 manager 的投影
    // （manager 额外带 skipped 原因与实测字节）。
    const primaryPersist = blockedPersistence !== null
      ? {
        status: "skipped",
        reason: typeof blockedPersistence.reason === "string" ? blockedPersistence.reason : "restore_failed",
        bytes: managerPersist?.bytes ?? null,
        category: null,
      }
      : (hostPersist !== null && hostPersist.status !== "saved"
        ? { ...hostPersist, bytes: managerPersist?.bytes ?? null }
        : (managerPersist ?? hostPersist));
    const primaryCategory = persistenceHealthState.failureCategory ?? primaryPersist?.category ?? null;
    // 两段投影共享同一份只读局部量：避免各自重复读取 host/manager（读取顺序与迁移前一致）。
    const diagnosticsState = {
      fanoutState,
      managerEventHistory,
      activeParents,
      queuedShards,
      runningShards,
      concurrency,
      roleOverrides,
      providerOverrides,
      providerRelease: fanoutState.providerRelease ?? null,
      stopState,
      stopAging,
      primaryPersist,
      primaryCategory,
      persistenceHealthState,
      healthSuccess,
      healthFailure,
      blockedPersistence,
      lastRestoreState,
      lastBudgetViolation,
      readLastEventRestore: () => storage.readLastEventRestore(),
    };
    return {
      version: CAPABILITY_REPORT_VERSION,
      // 时间戳只用于"诊断新鲜度"判断，不参与业务判定。
      generatedAt: Date.now(),
      children: {
        // 活动/已登记 child 的数量（不含 id）。
        active: diagnosticCount(recovery.activationCount()),
        tracked: diagnosticCount(recovery.recordCount()),
      },
      /**
       * 影响范围保护的只读投影（票据 07）：activeScopeCount 是仍持有 affectedPaths
       * 保护的活动项总数，detachedScopeCount 是其中所属 root 已销毁/代际退休的部分
       * （保护仍在，等待该 child 自己的权威停止证据）。
       */
      delegation: {
        activeScopeCount: diagnosticCount(delegationCounts.total),
        detachedScopeCount: diagnosticCount(delegationCounts.detached),
        lastRefusedRelease: delegation.readLastRefusedScopeRelease() === null
          ? null
          : {
            at: diagnosticTime(delegation.readLastRefusedScopeRelease().at),
            activeCount: diagnosticCount(delegation.readLastRefusedScopeRelease().activeCount),
            reason: diagnosticToken(delegation.readLastRefusedScopeRelease().reason, null),
          },
      },
      /**
       * root turn 等待账本（票据 11）：未结算总量、最早等待、能力等级计数、最近一次
       * 收口投递与有界 roots 摘要。只含计数/固定枚举/时间戳，不含任何 id 或正文。
       */
      rootTurnWait: describeRootTurnWaitDiagnostics(observability.rootWait),
      fanout: projectFanoutDiagnostics(diagnosticsState),
      recovery: {
        rebuilds: diagnosticCount(recoveryState.rebuilds),
        trackedContexts: diagnosticCount(recoveryState.trackedContexts),
        disposed: recoveryState.disposed === true,
        limit: diagnosticCount(AUTO_RECOVERY_LIMIT),
      },
      // 两阶段图片路由的只读计数（纯数字，不含 claim id / child id / provider / model）：
      // 客户端与测试据此证明签发/提交/取消/失败路径都会回收 claim 与 cleanup token。
      // 两阶段图片路由的只读计数由 claim 域投影（纯数字，不含 id/provider/model）。
      imageRoutes: projectImageRoutes(observability.imageRoutes()),
      settings: {
        // 模型目录代次、在途写入与已跟踪的目录 namespace 数（settings 提交诊断面）。
        generation: diagnosticCount(settingsState.generation),
        pendingWrites: diagnosticCount(settingsState.pendingWrites),
        trackedNamespaces: diagnosticCount(settingsState.trackedNamespaces),
      },
      storage: {
        hasBinding: storageState.hasBinding === true,
        status: typeof storageState.status === "string" ? diagnosticToken(storageState.status, "none") : "none",
        generation: diagnosticCount(storageState.generation),
        tables: Array.isArray(storageState.tableNames) ? diagnosticCount(storageState.tableNames.length) : 0,
      },
      /**
       * 持久化与恢复可见性（票据 04）。
       *
       * 只回答"最近一次落盘是什么结果、失败属于哪一类、恢复是否失败/被阻塞、最近一次
       * 预算拒绝是什么"，字段全部是固定枚举/计数/时间戳；不含快照正文、prompt、结果
       * 或错误堆栈。侧栏错误态与恢复重试 RPC 由后续任务在这块只读投影之上实现。
       */
      persistence: projectPersistenceDiagnostics(diagnosticsState),
      lineage: {
        currentRoots: diagnosticCount(lineageState.currentRoots),
        parentTasks: diagnosticCount(lineageState.parentTasks),
        deferredTasks: diagnosticCount(lineageState.deferredTasks),
      },
      handoff: {
        pending: diagnosticCount(handoffState.pending),
        disposed: handoffState.disposed === true,
      },
      notifications: {
        roots: diagnosticCount(notificationState.roots),
        hasAgentQuery: notificationState.hasAgentQuery === true,
        disposed: notificationState.disposed === true,
        // Windows 系统 Toast 适配器的可用性投影：与既有字段同级共存，
        // notifications.roots 等语义与形状保持不变（客户端按白名单只读 roots）。
        systemToast: describeSystemToastDiagnostics(observability.systemToast()),
      },
      rpc: {
        // 只保留结构化错误类别：没有消息、请求体、路径或认证信息。
        recentErrors: observability.rpcErrors(),
        categoryLimit: RPC_ERROR_CATEGORY_LIMIT,
      },
    };
  }

  // systemToastDiagnosticToken 同时服务 notification-test 回执（固定 token 白名单）。
  return { describeRuntimeDiagnostics, systemToastDiagnosticToken };
}
