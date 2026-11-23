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
 * - 运行时摘要：持久化/恢复、委派范围、设置代次、storage 与 RPC。fan-out 父任务 /
 *   分片的队列与停止边界投影已随 fan-out 整体移除，限流样本与名额释放异常因此在诊断面
 *   保留键位、恒为 null（无运行期样本）；并发上限的 default/roles/providers 同样没有
 *   任何运行期来源，固定为中性值（0 / 空对象），只为维持客户端读取形状。
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
  diagnosticTime,
  diagnosticToken,
} from "./runtime-diagnostics.js";
import { AUTO_RECOVERY_LIMIT } from "../shared/recovery-ledger.js";
import { lastOrdinaryFallbackDiagnostics } from "./route-diagnostics.js";

/**
 * 创建运行时诊断投影能力面。
 *
 * @param {object} deps - 窄能力面（7 组）。
 * @param {object} deps.host - host 组合门面（同一关注点：host 子服务只读 describe）：
 *   `lineage.describe()`、`handoff.describe()`、`notifications.describe()`。
 * @param {object} deps.settings - settings 读面：`describe()`（settings runtime 的代次/在途写入）。
 *   惰性兼容输入：fan-out 退役后不再读取任何并发上限派生值。
 * @param {object} deps.storage - settings/storage 域：`describe()`（binding/表清单只读投影）
 *   与 `persistenceHealth()`（普通 session/child 写入的只读健康快照；见 readStorageWriteHealth）。
 * @param {object} deps.recovery - 恢复域：`describe()`、`activationCount()`、`recordCount()`。
 * @param {object} [deps.fanout] - fan-out 宿主读面的历史晚绑定：`getFanoutHost()`。
 *   fan-out 物理删除后装配不再提供该槽位，只剩持久化/预算等历史诊断段的容错读取。
 *   并发上限也不再有任何来源（限流器已随 fan-out 删除）。
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
 * 普通 session/child 写入健康状态的容错读取（只读投影）。
 *
 * 为什么挂在既有 storage 协作面上：session_overrides / child_models 的每次写入都由
 * host/persistence-health 的 storage 观察通道记录（index-settings-storage 与
 * host/session-override-store 在落盘后调用 observeStorageWrite），该状态由组合根唯一持有。
 * fan-out 物理删除后装配不再提供 fan-out 依赖，若继续读 `fanoutState.persistenceHealth`，
 * 投影里的 lastFailure/lastSuccess 会永远是空对象（P2 缺陷）；这里改从 storage 协作面读取
 * 同一份进程内健康状态，不新增能力组、不引入已删除的 fan-out 运行时。
 *
 * 只挑选诊断需要的白名单字段：失败分类（failureCategory）、本通道连续失败计数
 * （consecutiveFailures）、最近失败/成功时间戳（调用方只读 at/category）。
 *
 * **嵌套对象也要逐字段重建**（与系统 Toast 段同一纪律）：`persistence-health` 的
 * `storage.lastFailure` 里还带着 `message`（写入失败时的原始错误正文）、`code`、
 * `source` 等字段，直接透传等于把正文重新放回诊断读面——只要未来任何一处顺手打印
 * 该嵌套对象就会泄露。因此这里只保留分类与时间戳两个键：
 * - `lastFailure: { category, at }`（分类 + 时间戳）；
 * - `lastSuccess: { at }`（只有时间戳）。
 * 原始 `message` 与错误堆栈因此**不存在于**投影结果里，而不是「没人打印它」。
 *
 * 读面缺失、返回非对象或读取抛错时按「没有写入样本」归一（0/null），诊断面因此永远
 * 不会成为 meta 的故障点。
 *
 * @param {object} storage - storage 协作面（`describe()` + 可选 `persistenceHealth()`）。
 * @returns {{failureCategory:string|null, consecutiveFailures:number,
 *   lastFailure:{category:(string|null), at:(number|null)}|null,
 *   lastSuccess:{at:(number|null)}|null}} 只读健康投影。
 */
function readStorageWriteHealth(storage) {
  let snapshot;
  try {
    snapshot = typeof storage?.persistenceHealth === "function" ? storage.persistenceHealth() : undefined;
  } catch {
    snapshot = undefined;
  }
  const observed = snapshot?.storage;
  if (observed === null || typeof observed !== "object") {
    return { failureCategory: null, consecutiveFailures: 0, lastFailure: null, lastSuccess: null };
  }
  const failure = observed.lastFailure !== null && typeof observed.lastFailure === "object"
    ? observed.lastFailure
    : null;
  const success = observed.lastSuccess !== null && typeof observed.lastSuccess === "object"
    ? observed.lastSuccess
    : null;
  return {
    failureCategory: typeof failure?.category === "string" ? failure.category : null,
    consecutiveFailures: observed.consecutiveFailures,
    lastFailure: failure === null
      ? null
      : {
        category: typeof failure.category === "string" ? failure.category : null,
        at: diagnosticTime(failure.at),
      },
    lastSuccess: success === null ? null : { at: diagnosticTime(success.at) },
  };
}

/**
 * 并发上限子投影的固定中性值（**无上限来源**）。
 *
 * 限流器已随 fan-out 物理删除，四个 fan-out 专属设置项（roleConcurrencyLimit /
 * roleLimits / providerLimits / roleTimeoutMs）也从 Host 的活动路径上移除，因此这里
 * 不再有任何真实上限来源：
 * - `default` / `roles` / `providers` 是「无上限配置」的中性值（0 / 空对象），
 *   **不伪造数值**，也不把宿主子代理名额（maxActiveSubagents）塞进来——它属于宿主名额，
 *   另有 `meta.hostConcurrencyCap` 投影；
 * - `throttle` / `providerRelease` 早已无运行期样本，继续保持 null；
 * - `source` 保留键位：旧枚举 live/snapshot/fallback 都表达「本次解析的来源」，现在
 *   没有任何来源，固定 unknown；invalid* 三键同理保持 null（读取期归一已不再产生非法值）。
 *
 * 键位与形状必须原样保留：客户端仍在读 `diagnostics.fanout.concurrency.throttle`。
 *
 * @returns {object} 固定形状的中性并发投影（每次返回新对象，避免调用方改坏共享结构）。
 */
function neutralConcurrencyDiagnostics() {
  return {
    default: 0,
    roles: {},
    providers: {},
    throttle: null,
    providerRelease: null,
    source: "unknown",
    invalidKind: null,
    invalidValueType: null,
    invalidMessage: null,
  };
}

/**
 * 并发与限流段投影（role / provider 配额、限流与名额释放异常）。
 *
 * 历史背景：这一段原先挂在 `fanout` 键下（它当时的唯一样本来源是 fan-out manager 的
 * describe()），因此 RPC 字段名保留了 `diagnostics.fanout`。fan-out 的父任务 / 分片
 * 队列、事件窗口与停止边界投影**已经删除**；由于客户端仍在读
 * `diagnostics.fanout.concurrency.throttle`，键名与该子投影暂时原样保留（后续单独做
 * 命名清理，不在本次物理删除里改协议字段名）。
 *
 * **限流器已随 fan-out 物理删除，不再有任何运行期上限来源**：roleConcurrencyLimit /
 * roleLimits / providerLimits / roleTimeoutMs 四个设置项也从 Host 的活动路径上移除，
 * 因此 `default` / `roles` / `providers` 明确改为「无上限配置」的中性值
 * （0 / 空对象），不再从 settings 派生，也不把宿主子代理名额塞进来（它另有
 * `meta.hostConcurrencyCap` 投影）。此处保留键位只为维持客户端读取形状。
 *
 * @returns {object} 并发与限流投影（形状固定、无运行期样本）。
 */
function projectFanoutDiagnostics() {
  return {
    concurrency: neutralConcurrencyDiagnostics(),
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
    lastBudgetViolation,
    fanoutState,
  } = diagnosticsState;
  return {
    // manager 落盘结果（saved/skipped(reason)/failed(bytes)）的唯一写入方是已删除的
    // fan-out manager：这里恒为 null，只保留字段形状，不按普通写入推断。
    lastResult: primaryPersist === null ? null : diagnosticToken(primaryPersist.status, "unknown"),
    reason: primaryPersist === null ? null : diagnosticToken(primaryPersist.reason, null),
    bytes: primaryPersist === null ? null : diagnosticTime(primaryPersist.bytes),
    // 分类权威是 Host persistence-health（普通写入的 storage 观察通道）；
    // manager 自带 category 只在历史数据仍存在时作为回退。
    category: diagnosticToken(primaryCategory, null),
    consecutiveFailures: diagnosticCount(persistenceHealthState.consecutiveFailures),
    lastSuccessAt: diagnosticTime(healthSuccess?.at),
    lastFailureAt: diagnosticTime(healthFailure?.at),
    blocked: blockedPersistence === null ? null : diagnosticToken(blockedPersistence.reason, "unknown"),
    // 恢复结果投影：**唯一写入方已随 fan-out 物理删除**（原 fan-out manager 的 restore 结果）。
    // 装配不再提供 `fanout` 读面（host/index-assembly-wire.js 不传该键），因此
    // `fanoutState.persistence` 恒为空对象、`persistence.restore` 永远取不到样本，原投影
    // 分支不可达。这里把键位固定为 null（语义：本进程没有恢复样本），形状不变；
    // 不补 0、不按普通写入推断历史，也不为它保留已无消费方的正文清洗链。
    restore: null,
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

export function createRuntimeDiagnostics({ host, settings, storage, recovery, fanout, delegation, observability }) {
  function describeRuntimeDiagnostics() {
    const settingsState = settings.describe();
    const storageState = storage.describe();
    const lineageState = host.lineage.describe();
    const notificationState = host.notifications.describe();
    const handoffState = host.handoff.describe();
    const recoveryState = recovery.describe();
    // fan-out 宿主读面：只剩持久化/预算等历史诊断段的容错读取（并发上限已无任何来源）；
    // 装配已不提供该晚绑定，缺失时按空投影归一，绝不抛错。
    const fanoutHost = typeof fanout?.getFanoutHost === "function" ? fanout.getFanoutHost() : undefined;
    const fanoutState = typeof fanoutHost?.describe === "function" ? fanoutHost.describe() : {};
    // 惰性兼容输入：fan-out 退役后没有任何运行期并发上限来源，并发子投影因此是
    // 固定中性值（见 neutralConcurrencyDiagnostics），这里不再派生任何配置读值。
    /**
     * 持久化/恢复诊断投影（票据 04）。
     *
     * 分类权威是 host/persistence-health（failureCategory/consecutiveFailures/时间戳），
     * manager 只提供它亲眼观察到的落盘结果（saved/skipped(reason)/failed(bytes)）。
     * 两者合并，但绝不把快照正文、任务负载或错误堆栈放进诊断。
     *
     * 数据来源（fan-out 物理删除后的真实情况）：
     * - lastFailure/lastSuccess/failureCategory/consecutiveFailures：普通 child_models /
     *   session_overrides 写入的 storage 观察通道（readStorageWriteHealth，经既有 storage
     *   协作面读取）。这是唯一仍有运行期写入方的健康来源；
     * - manager 落盘结果（lastResult/reason/bytes）、blocked、budget：原唯一写入方是已删除的
     *   fan-out manager，故继续从空的 `fanoutState.persistence` 取值为 null——保留键位只为
     *   维持客户端可见形状，不补 0、不伪造历史；
     * - restore：唯一写入方同样随 fan-out 物理删除，且装配不再传 `fanout` 读面，取样本的
     *   分支不可达，因此直接固定为 null（见 projectPersistenceDiagnostics 的 restore 注释）。
     */
    const persistenceState = fanoutState.persistence ?? {};
    const managerPersistence = persistenceState.manager ?? {};
    const managerPersist = managerPersistence.lastResult ?? null;
    const hostPersist = persistenceState.lastResult ?? null;
    const blockedPersistence = persistenceState.blocked ?? null;
    const persistenceHealthState = readStorageWriteHealth(storage);
    const healthFailure = persistenceHealthState.lastFailure;
    const healthSuccess = persistenceHealthState.lastSuccess;
    const lastBudgetViolation = fanoutState.budget?.lastViolation ?? null;
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
      primaryPersist,
      primaryCategory,
      persistenceHealthState,
      healthSuccess,
      healthFailure,
      blockedPersistence,
      lastBudgetViolation,
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
