/**
 * 主代理（Orchestrator）模型配置的**运行期**管理器（批次 A 地基）。
 *
 * ## 职责
 * 在三个（且只有三个）**自动**触发点上，把"当前应生效的主代理模型"写到根会话的 DSH
 * 原生模型上：
 * 1. **新建会话**（agent/created，且能证明是本次新建）；
 * 2. **峰谷时段边界**（定时器到点后重新判定时段）；
 * 3. **设置页保存**——本管理器只推进"未来新会话的配置修订"并重排定时器，
 *    **绝不遍历、绝不改写已存在会话**（产品语义：保存只影响之后新建的会话）。
 *
 * 另有**显式**写入（用户自己点的）：会话模型弹窗的 set/clear 会由 RPC 端点在本管理器上
 * 调用 applyOverride / applyOverrideCleared；主界面 picker 的手动改动（model/selection
 * 事件）会把该值持久化成会话覆盖。三类显式写入都走同一条「预检 -> 自写令牌 ->
 * selectModel」管线（管线本体在 host/orchestrator-write），绝不旁路。
 *
 * ## 优先级（与 host/orchestrator-settings.js 的 orchestratorLayerOf 同一实现）
 * 会话覆盖 > 当前时段 > 全局配置 > 不干预。没有配置时**什么都不做**，
 * 绝不替用户挑选任何默认模型。
 *
 * ## 并发模型（B5）
 * - 每个 sessionId 一条**串行任务链**：同一会话的 preflight + selectModel 不会并发执行。
 * - 保证是「**写入开始前可合并，写入开始后不取消在途调用，但不会再为同一意图发起第二次**」：
 *   写入开始前到达的新意图通过 intentEpoch 让旧意图在下一个检查点自弃（合并成一次写入）；
 *   写入开始（已调用 selectModel）后不取消在途调用，而是在 await 返回后重新校验——
 *   被取代就丢弃结果；补写由排队中的新意图自己完成，且因为每个意图只排一次队、
 *   旧意图在检查点自弃，最多补一次。
 * - **预检返回后、写入返回后都必须重新检查 intent**：目录解析与 selectModel 都是异步的，
 *   期间用户可能已经手动切换模型（manualLocked）或时段又变了（新 intent）。
 * - **手动接管的持久化走同一条串行链**（H1）：每条 model/selection 事件不再各自启动一条
 *   异步持久化链，而是把「预检 + 落盘」整体排进该会话的队列；链内再按意图代次过新鲜度
 *   栅栏（见 scheduleManualPersist），因此"先选的旧值"绝不会覆盖"后选的新值"。
 *
 * ## 防回环（自写令牌）与"不吞手动事件"（B4）
 * 调用 selectModel **之前**（同一同步块内）登记自写令牌（规范化选择键 + 单调 writeSeq）
 * 与在途目标 pendingTarget；收到 session/event 的 model/selection 时**一次性**消费匹配
 * 的令牌并忽略。令牌只在"写入发起后、对应事件到达前"有效：登记与 selectModel 调用之间
 * 没有 await，因此事件不可能插到登记之前——登记之前到达的同值事件不会被令牌吞掉，
 * 它按"与目标/最后一次写入值比较"的普通规则判定（不同即手动接管）。
 *
 * ## 失败处理（"配置未生效"而不是"静默换模型"）
 * - 服务缺失 / 未就绪 => 不写、插件照常运行，读面通过 hostReady / applyState 体现；
 * - catalog 预检失败 => 按候选顺序切下一个；全部失败则 applied 保持不变（维持现状）；
 * - selectModel 抛错 => 清令牌、保持 applied 不变，只记诊断。
 *
 * ## 判据保守性（B3）
 * "新建会话"必须同时满足：根 agent（无 parentSession / 无 PARENT_MARKER，由注入的
 * isRootAgent 判定）、**会话头 createdAt >= 功能启用切点 orchestratorEpoch**、
 * session.requestHeader() === undefined、DEG 无该会话的 applied 记录。
 * 切点由 host/orchestrator-epoch 在首次初始化时落盘（只写一次，重启后不变）。
 * 拿不到 createdAt、或请求头判据歧义（方法缺失 / 抛错 / 返回 null）一律**不套用**并记录
 * 诊断——宁可不生效，也不改用户历史会话的模型。恢复的历史会话（已有请求头）同理。
 *
 * **诊断形态（H2）**：判据放弃只记录**安全原因码**（createdAt-missing / createdAt-not-number /
 * createdAt-before-epoch / request-header-unknown），绝不复述 createdAt 的原始值——它可能是
 * 大整数时间戳，也可能被宿主塞进路径或凭据等敏感内容。运行时确认宿主 createdAt 的真实
 * 类型与单位（毫秒/秒、数字/字符串）属于后续验收项：本模块**不做猜测式归一**，
 * ISO 字符串等非数字一律按"不是可用时刻"保守跳过并给出对应原因码。
 *
 * ## 读面 applyState（客户端批次用）
 * 由 host 判定，客户端**不得**用 effective 自己猜：
 *
 * | 优先级 | 条件 | applyState | 含义 |
 * |---|---|---|---|
 * | 1 | 宿主没有可用的 selectModel | host-not-ready | 宿主未就绪，运行期无法写入 |
 * | 2 | 用户手动接管（manualLocked） | manual | 手动优先，直到会话结束 |
 * | 3 | 当前没有任何应生效配置（effective 为 null） | none | 不干预 |
 * | 4 | 有排队/在途写入 | pending | 正在应用 |
 * | 5 | 最后一次写入的目标 == 当前应生效目标 | applied | 已应用（可能已降级到候选） |
 * | 6 | 其余（历史会话 / 预检失败 / 写入失败 / 目标已变） | unapplied | 配置未生效 |
 *
 * @module dsh-expert-group/host/orchestrator-model
 */
import { modelSelectionKeyOf, normalizeModelSelection } from "../shared/model-route.js";
import { orchestratorNextBoundaryDelayMs, orchestratorLayerOf, orchestratorPeriodOf } from "./orchestrator-settings.js";
import { createOrchestratorWriter } from "./orchestrator-write.js";

/**
 * 新建会话判据的三种请求头结论。
 *
 * - "new"：没有过请求头 —— 还要再过"切点"判据；
 * - "legacy"：已有请求头（恢复的历史会话）—— 永不自动套用；
 * - "unknown"：无法确认（没有 requestHeader 方法 / 抛错 / 返回 null）—— 保守不套用。
 */
const REQUEST_HEADER_NEW = "new";
const REQUEST_HEADER_LEGACY = "legacy";
const REQUEST_HEADER_UNKNOWN = "unknown";

/** 读面 applyState 的六个稳定取值（客户端批次据此显示状态，不由 effective 猜测）。 */
const APPLY_STATE = Object.freeze({
  APPLIED: "applied",
  PENDING: "pending",
  UNAPPLIED: "unapplied",
  MANUAL: "manual",
  NONE: "none",
  HOST_NOT_READY: "host-not-ready",
});

/**
 * 读取会话的请求头判据（只读、不产生副作用）。
 *
 * 为什么只认 === undefined：DSH 的 requestHeader() 返回"已发出请求"的历史配置；
 * 返回 undefined 才表示这个会话从未发出过请求（本次新建）。null 属于未知形态，
 * 按保守方向处理（不套用），避免把某些宿主的内部表示误判成新会话。
 *
 * 注意它**只是附加证据**：无请求头不能证明"会话产生于功能启用之后"（历史会话同样可能
 * 从未发过请求），因此必须与 createdAt >= orchestratorEpoch 同时成立（见 B3）。
 *
 * @param {object} agent - exact Agent 对象。
 * @returns {"new"|"legacy"|"unknown"} 判据结论。
 */
function requestHeaderVerdictOf(agent) {
  const session = agent?.session;
  if (session === null || typeof session !== "object") return REQUEST_HEADER_UNKNOWN;
  if (typeof session.requestHeader !== "function") return REQUEST_HEADER_UNKNOWN;
  let header;
  try {
    header = session.requestHeader.call(session);
  } catch {
    return REQUEST_HEADER_UNKNOWN;
  }
  if (header === undefined) return REQUEST_HEADER_NEW;
  if (header === null) return REQUEST_HEADER_UNKNOWN;
  return REQUEST_HEADER_LEGACY;
}

/**
 * 新建会话判据的**放弃原因码**（H2：诊断必须能指出具体原因）。
 *
 * 全部是固定枚举字符串：日志里只出现原因码，**绝不携带 createdAt 的原始值**——
 * 它可能是大整数时间戳，也可能被宿主塞进路径或凭据等敏感内容。
 * 前三个与"创建时刻"判据对应，第四个与"请求头"判据对应。
 */
const JUDGE_REASON = Object.freeze({
  /** 会话没有任何创建时刻字段（session 缺失，或 header.createdAt / session.createdAt 都是 null/undefined）。 */
  CREATED_AT_MISSING: "createdAt-missing",
  /** 有值但不是可用时刻：非数字（例如 ISO 字符串 / 布尔）或非有限数（NaN / ±Infinity）。 */
  CREATED_AT_NOT_NUMBER: "createdAt-not-number",
  /** 是合法毫秒时刻，但早于功能启用切点（B3 的核心判据）。 */
  CREATED_AT_BEFORE_EPOCH: "createdAt-before-epoch",
  /** 请求头判据无法确认（没有 requestHeader 方法 / 抛错 / 返回 null）。 */
  REQUEST_HEADER_UNKNOWN: "request-header-unknown",
});

/**
 * 读取会话的创建时刻（毫秒），并给出**安全原因码**。
 *
 * 真实宿主把创建时刻放在**会话头** session.header.createdAt（与 host/expert-group-stage 的
 * createdAtOf 同一条事实来源）；部分宿主形态把它平铺在 session.createdAt。两者都是
 * "会话创建时刻"，因此按同一优先级读取。
 *
 * **只接受有限的数字**（不做 ISO 字符串解析、不做单位换算）：宿主的真实类型与单位属于
 * 运行时验收项，猜测式归一（例如把 10 位数字当年/秒自动乘 1000）会把未知变成错误答案。
 * 取不到可用毫秒数时返回 null + 原因码，由调用方按"保守跳过"处理——绝不拿"现在"顶替
 * （那会把功能上线前的历史会话当成新会话）。
 *
 * 负数按"合法数字、但必然早于切点"处理：判据统一由调用方的 epoch 比较决定，
 * 这里不再单独否决，避免同一事实出现两个判据。
 *
 * @param {object} agent - exact Agent 对象。
 * @returns {{ms: number|null, reason: string|null}} ms 为创建时刻（未知时 null）；
 *   reason 为 null（取到时刻）或 JUDGE_REASON 中的安全原因码。
 */
function sessionCreatedAtOf(agent) {
  const session = agent?.session;
  if (session === null || typeof session !== "object") {
    return { ms: null, reason: JUDGE_REASON.CREATED_AT_MISSING };
  }
  let sawValue = false;
  for (const candidate of [session.header?.createdAt, session.createdAt]) {
    if (candidate === undefined || candidate === null) continue;
    sawValue = true;
    // 非数字（ISO 字符串等）与非有限数都不是可用的毫秒时刻：保守跳过，交给原因码解释。
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    return { ms: candidate, reason: null };
  }
  return {
    ms: null,
    reason: sawValue ? JUDGE_REASON.CREATED_AT_NOT_NUMBER : JUDGE_REASON.CREATED_AT_MISSING,
  };
}

/**
 * 记录一次**按判据主动放弃**（不是失败），只写动作标签与安全原因码（H2）。
 *
 * 与 logFailure 的分工：失败只表达"错误类别"（Error.name），放弃要表达"哪一条判据
 * 不成立"。两者都**不输出原始值**——判据输入里可能有会话路径、模型名或敏感配置。
 *
 * 放在模块级而不是管理器闭包里：管理器工厂已贴住「单工厂 ≤400 行」门禁，而这里
 * 只依赖一个窄能力（logger），没有任何运行期状态需要独占。
 *
 * @param {object} logger - 日志器（可缺省）。
 * @param {string} action - 动作标签（如 new-session-judge）。
 * @param {string} reason - JUDGE_REASON 中的固定原因码。
 * @returns {void}
 */
function logSkipOf(logger, action, reason) {
  try {
    logger?.warn?.("dsh-expert-group: orchestrator model " + action + " skipped: " + reason);
  } catch {
    // 日志失败绝不影响主流程。
  }
}

/**
 * 把一次手动接管的**持久化**（目录预检 + 落 session_overrides）排进该会话的串行链（H1）。
 *
 * ## 为什么不能直接起一条异步链
 * 以前每条 model/selection 事件各自 `void writer.persistManualOverride(...)`：两条持久化
 * 并行跑预检，谁先落盘取决于目录解析快慢。用户先选 A、后选 B，若 A 的解析更慢，就会
 * B 先写、A 最后覆盖 —— 重启后恢复到用户早就改掉的旧值 A。
 *
 * ## 两条保证
 * 1. **串行**：预检与落盘整体排进该会话既有的任务链（与自动套用同一条），同一会话的
 *    手动持久化因此不会并发；
 * 2. **新鲜度栅栏**：链内仍按**意图代次**判断是否已被取代——代次在每次手动选择或显式
 *    配置写入时前进（noteSessionEvent / requestApply），因此排队期间来了更新的选择时，
 *    本次落盘直接放弃（不写、不改状态、只记一条安全原因码）。
 *
 * 判据读取的是登记时的 state 引用而不是会话表：会话被释放（agent/disposed）后，已排队的
 * 持久化仍按当时的事实判定（释放本身不是"更新的意图"，不能借它丢弃用户最后一次选择）。
 *
 * 放在模块级而不是管理器闭包里：管理器工厂已贴住「单工厂 ≤400 行」门禁，而这里只依赖
 * 两个窄能力（本会话的任务队列 + 写入管线），没有运行期状态需要独占。
 *
 * @param {Function} enqueue - 会话串行链入队命令 (sessionId, task) => Promise。
 * @param {object} writer - 写入管线（persistManualOverride）。
 * @param {string} sessionId - 根会话 id。
 * @param {object} state - 登记时的运行期记录（栅栏读它的 intentEpoch）。
 * @param {number} epoch - 登记时的意图代次（栅栏基线）。
 * @param {object} selection - 用户手动选择的模型（已归一）。
 * @returns {void} 完成与否由持久化自己记诊断（best-effort）。
 */
function scheduleManualPersist(enqueue, writer, sessionId, state, epoch, selection) {
  void enqueue(sessionId, () => writer.persistManualOverride(
    sessionId,
    selection,
    () => state.intentEpoch !== epoch,
  ));
}

/**
 * 运行期会话记录的初值（每次返回新对象，绝不共享引用）。
 *
 * @param {string} sessionId - 根会话 id。
 * @returns {object} 会话记录。
 */
function newSessionRecord(sessionId) {
  return {
    sessionId,
    // 历史会话 / 判据歧义 / 切点之前：一旦为 true，本进程内不再**自动**套用
    // （用户显式设置会话覆盖时会被 requestApply 的 explicit 分支解除）。
    legacy: false,
    // 本进程内最近一次成功写入的选择与时刻（读面 applied / appliedAt 的唯一来源）。
    applied: null,
    appliedAt: null,
    // 最近一次成功写入的**目标**比较键：applyState 用它判断"当前应生效目标是否已应用"，
    // 因此降级到候选的场景仍算已应用（降级位置由 degradedCandidate 单独表达）。
    targetKey: null,
    // 非 null 表示"主选择预检失败、降级到第 N 个候选"（口径同 route snapshot 的 candidateIndex）。
    degradedCandidate: null,
    // 用户手动接管：本会话退出自动管理，直到会话结束（agent/disposed）。
    manualLocked: false,
    // 自写令牌：调用 selectModel 之前登记，收到匹配的 model/selection 后一次性消费。
    selfWrite: null,
    // 在途写入目标：await selectModel 期间的宿主回显据此忽略（令牌只消费一次）。
    pendingTarget: null,
    // 最近一次手动接管的比较键：同值回显（尤其覆盖尚未落盘时）不得重复触发持久化。
    manualKey: null,
    // 意图代次：每次（自动或显式）套用 +1；旧意图在检查点发现代次变了就放弃写入。
    intentEpoch: 0,
    // 排队/在途的写入条数：只服务读面的 pending 判定，写入结束（含自弃）后必减回。
    pendingWrites: 0,
    // 套用时的时段（边界触发只重算"时段真的变了"的会话）。
    period: "none",
    // 最近一次尝试的结果（诊断用；不进入读面契约字段，避免协议面漂移）。
    lastOutcome: "idle",
  };
}

/**
 * 计算读面 applyState（判定表见模块头注释）。
 *
 * 纯函数：只读会话记录的运行期事实与已解析的 effective，不读时钟/设置。
 *
 * @param {object|undefined} state - 运行期会话记录。
 * @param {object|null} effective - 当前应生效的选择（未考虑手动）。
 * @param {boolean} hostReady - 宿主是否提供可用的 selectModel。
 * @returns {string} 六个稳定取值之一。
 */
function applyStateOf(state, effective, hostReady) {
  if (hostReady !== true) return APPLY_STATE.HOST_NOT_READY;
  if (state?.manualLocked === true) return APPLY_STATE.MANUAL;
  if (effective === null || effective === void 0) return APPLY_STATE.NONE;
  if (state === void 0) return APPLY_STATE.UNAPPLIED;
  if (state.pendingWrites > 0) return APPLY_STATE.PENDING;
  if (state.appliedAt === null) return APPLY_STATE.UNAPPLIED;
  return state.targetKey === modelSelectionKeyOf(effective) ? APPLY_STATE.APPLIED : APPLY_STATE.UNAPPLIED;
}

/**
 * 读面状态投影（root get 的 orchestrator 字段）。
 *
 * 字段形状是后续 UI 批次的读写契约，**不要改名**：configured / period / effective /
 * source / applied / appliedAt / degradedCandidate / manualLocked / hostReady；
 * applyState 是本期新增的第十个字段（六态判定由 host 负责，客户端不得自己猜）。
 *
 * effective 是"当前应生效值（未考虑手动）"：只做层级解析，不做 catalog 预检
 * （读面必须同步返回，不能等目录）；实际套用值与降级位置由 applied / degradedCandidate
 * 单独表达。
 *
 * @param {object} params - 投影入参。
 * @param {object} params.snapshot - 已归一 settings 快照。
 * @param {number} params.nowMs - 判定时刻。
 * @param {string} params.sessionId - 根会话 id。
 * @param {object|undefined} params.state - 运行期会话记录。
 * @param {boolean} params.hostReady - 宿主是否提供可用的 selectModel。
 * @returns {object} 十字段读面。
 */
function statusOf({ snapshot, nowMs, sessionId, state, hostReady }) {
  const period = orchestratorPeriodOf(snapshot, nowMs);
  const layer = orchestratorLayerOf(snapshot, sessionId, period);
  const configured = normalizeModelSelection(snapshot?.orchestrator?.defaults) ?? null;
  const effective = layer.config === null ? null : (normalizeModelSelection(layer.config.defaults) ?? null);
  return {
    configured,
    period,
    effective,
    source: layer.source,
    applied: state?.applied ?? null,
    appliedAt: state?.appliedAt ?? null,
    degradedCandidate: state?.degradedCandidate ?? null,
    manualLocked: state?.manualLocked === true,
    hostReady,
    applyState: applyStateOf(state, effective, hostReady),
  };
}

/**
 * 新建会话判定（B3）：先取功能启用切点，再逐条检查三个判据。
 *
 * 异步是因为切点可能尚未落盘；期间会话可能已经被释放、手动接管或已经写入，
 * 因此每一步之后都要重新检查。context 由 manager 交出（commit / log / 会话查询）。
 *
 * @param {object} context - { ensureEpoch, now, isCurrent, requestApply, logFailure, logSkip }。
 * @param {object} agent - exact root Agent。
 * @param {string} sessionId - 根会话 id。
 * @param {object} state - 该会话的运行期记录。
 * @returns {Promise<void>} 判定完成后无返回值。
 */
async function judgeCreatedSession(context, agent, sessionId, state) {
  const epoch = await context.ensureEpoch(context.now());
  if (context.isCurrent(sessionId, state) !== true) return;
  if (state.legacy === true || state.manualLocked === true || state.appliedAt !== null) return;
  const verdict = requestHeaderVerdictOf(agent);
  if (verdict !== REQUEST_HEADER_NEW) {
    // 恢复的历史会话（legacy）或无法确认（unknown）：永不自动套用，只留诊断。
    state.legacy = true;
    state.lastOutcome = "skipped:" + verdict;
    // unknown 才是"判据不可用"，必须留下可定位的原因码；legacy 是正常的恢复路径。
    if (verdict === REQUEST_HEADER_UNKNOWN) {
      context.logSkip("new-session-judge", JUDGE_REASON.REQUEST_HEADER_UNKNOWN);
    }
    return;
  }
  // 变量名刻意不含 create* 前缀：C3 对账把 create* 声明当工厂候选（门禁口径）。
  const stamp = sessionCreatedAtOf(agent);
  if (stamp.ms === null) {
    // 拿不到可用创建时刻（缺失 / 非数字）=> 无法证明产生于切点之后：保守跳过，
    // 并把会话固定为不自动套用。诊断只写原因码，不复述原始值。
    state.legacy = true;
    state.lastOutcome = "skipped:" + stamp.reason;
    context.logSkip("new-session-judge", stamp.reason);
    return;
  }
  if (!(stamp.ms >= epoch)) {
    // 切点之前创建的会话：即使没有请求头也**不是**本次新建（B3 的核心判据）。
    // 这里同样记原因码：它是"历史会话未被接管"的唯一可观测证据。
    state.legacy = true;
    state.lastOutcome = "skipped:" + JUDGE_REASON.CREATED_AT_BEFORE_EPOCH;
    context.logSkip("new-session-judge", JUDGE_REASON.CREATED_AT_BEFORE_EPOCH);
    return;
  }
  context.requestApply(sessionId);
}

/**
 * 创建主代理模型运行期管理器。
 *
 * 注入面按能力组分 6 组（C3 登记为 6 组）：
 * 1. settings：已归一的设置快照读取（调用期解析，绝不缓存快照）；
 * 2. host：根会话判定 + 晚绑定的 sessionController 服务读取；
 * 3. models：catalog 预检（复用 validateSelectionWithSignal，不复制目录规则）；
 * 4. clock：now + setTimeout/clearTimeout（与 fanout 同一"折叠成一组时钟能力"口径）；
 * 5. logger：只记固定类别与安全错误名；
 * 6. persistence：DEG 持久化域（功能启用切点的确保 + 手动接管的会话覆盖写入）。
 *
 * @param {object} deps - 见上。
 * @returns {object} 命令面（事件入口 / 读面 / 服务绑定 / 释放 / 显式写入）。
 */
export function createOrchestratorModelManager({ settings, host, models, clock, logger, persistence }) {
  /** sessionId -> 运行期会话状态（进程内唯一事实源，序列化数据仍在 session_overrides）。 */
  const sessions = new Map();
  /** sessionId -> 串行任务链尾（保证同一会话的写入串行；结束后自清理）。 */
  const queues = new Map();
  /** 写入管线（预检 + 目标解析 + 手动接管持久化）：无状态，运行期状态仍只在本闭包。 */
  const writer = createOrchestratorWriter({ settings, models, clock, logger, persistence });
  /** 晚绑定的 sessionController（宿主可能完全没有该服务）。 */
  let service;
  /** 边界定时器句柄（没有宿主定时器能力时恒为 null，功能降级但不抛错）。 */
  let timerHandle = null;
  /** 自写令牌的单调序号：只用于诊断，不参与匹配。 */
  let writeSeq = 0;
  /** 未来新会话的配置修订：设置页保存成功一次 +1；仅用于诊断与幂等观察。 */
  let configRevision = 0;

  // 首次初始化就把"功能启用切点"固定下来：越早取值越贴近"本功能开始生效"，且首个
  // agent/created 判定不必等一次冷启动落盘（ensureEpoch 内部仍保证只写一次）。
  try {
    void persistence.ensureEpoch(clock.now()).catch(() => {});
  } catch {
    // 切点初始化失败不影响装配：判定时会再次 ensure（失败即按本次进程的保守切点）。
  }

  /** 只记固定前缀与安全错误名：绝不输出 message 原文（可能含路径/凭据）。 */
  function logFailure(action, error) {
    try {
      const label = error instanceof Error ? error.name : typeof error;
      logger?.warn?.("dsh-expert-group: orchestrator model " + action + " failed: " + label);
    } catch {
      // 日志失败绝不影响主流程。
    }
  }

  /** 取当前可用的 sessionController（只有 selectModel 可调用时才算就绪）。 */
  function selectModelOf() {
    return service !== undefined && service !== null && typeof service.selectModel === "function"
      ? service.selectModel.bind(service)
      : null;
  }

  /** 会话状态惰性创建：读面也可能在 agent/created 之前被调用（如设置页打开旧会话）。 */
  function ensureSession(sessionId) {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const record = newSessionRecord(sessionId);
    sessions.set(sessionId, record);
    return record;
  }

  /**
   * 把任务排到该会话串行链的尾部。
   *
   * 链尾自身**永不 reject**（错误在这里收口并记诊断）：否则一个失败的任务会让后续
   * 所有任务跟着 reject，自动管理从此静默失效。
   */
  function enqueue(sessionId, task) {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => task()).catch((error) => {
      logFailure("apply", error);
    });
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  }

  /**
   * 意图是否已被取代。
   *
   * - 会话记录被释放 / 意图代次已变 => 一定被取代（显式写入也不例外：更新的用户操作接手）；
   * - 手动接管 / legacy 只约束**自动**意图：显式写入正是用户用来重新接管本会话的动作，
   *   因此 explicit 时不受这两条限制（否则清除覆盖后永远不会回落到时段/全局）。
   */
  function supersededOf(sessionId, state, intent, explicit) {
    if (sessions.get(sessionId) !== state) return true;
    if (state.intentEpoch !== intent) return true;
    if (explicit !== true && (state.manualLocked === true || state.legacy === true)) return true;
    return false;
  }

  /**
   * 一次套用的完整流程（解析目标 -> 预检 -> 写入 -> 重新校验 -> 记账），全程在串行链内。
   *
   * 放弃条件（任一命中即 return，不产生任何写入）：会话已被释放 / 意图代次已变 /
   * 自动意图遇到手动接管、legacy 或会话覆盖胜出 / 没有配置 / sessionController 不可用。
   */
  async function runIntent(sessionId, state, intent, explicit) {
    const isSuperseded = () => supersededOf(sessionId, state, intent, explicit);
    if (isSuperseded()) return;
    const target = writer.resolveTarget(sessionId, explicit);
    if (target.outcome !== "ready") {
      state.lastOutcome = target.outcome;
      return;
    }
    const selectModel = selectModelOf();
    if (selectModel === null) {
      state.lastOutcome = "host-not-ready";
      return;
    }
    const chosen = await writer.chooseCandidate(target.plan, isSuperseded);
    if (chosen === null) {
      // 被取代（预检期间来了新意图/手动接管）或全部候选都不可用：两种都不写。
      state.lastOutcome = isSuperseded() ? "superseded" : "preflight-failed";
      return;
    }
    if (isSuperseded()) return;
    const targetKey = modelSelectionKeyOf(chosen.selection);
    // 先登记自写令牌与在途目标再调用：宿主可能在 selectModel 内部同步派发 model/selection。
    // 登记与调用之间**没有 await**，因此"登记之前到达的同值事件"不可能被令牌吞掉。
    writeSeq += 1;
    state.selfWrite = { key: targetKey, seq: writeSeq };
    state.pendingTarget = { key: targetKey };
    const written = await writer.writeSelection(selectModel, sessionId, chosen.selection);
    state.pendingTarget = null;
    if (written.ok !== true) {
      // 写入失败：清令牌（不能让它继续吞掉用户后续的真实手动选择），applied 保持不变。
      state.selfWrite = null;
      state.lastOutcome = written.outcome;
      return;
    }
    /**
     * B4：await 返回后必须重新校验。若期间到达了新意图或手动接管，本次写入"已被取代"：
     * 结果丢弃（不更新 applied / appliedAt / targetKey）。DSH 侧的模型此刻可能已经被改过，
     * 但那一份事实不再代表我们的配置——读面因此如实显示 manual / unapplied。
     * B5：这里不取消在途调用，也不在此重发；补写由排队中的新意图完成后自行决定，最多一次。
     */
    if (isSuperseded()) {
      state.lastOutcome = "superseded";
      return;
    }
    state.applied = { ...chosen.selection };
    state.appliedAt = clock.now();
    state.targetKey = targetKey;
    state.degradedCandidate = chosen.candidateIndex > 0 ? chosen.candidateIndex : null;
    state.period = target.period;
    state.lastOutcome = "applied";
  }

  /**
   * 登记一次套用意图（同一会话的旧意图会在下一个检查点自弃）。
   *
   * @param {string} sessionId - 根会话 id。
   * @param {string} reason - 诊断用触发源（created / period / override-set / override-clear）。
   * @param {{explicit?: boolean}} [options] - explicit=true 是用户在弹窗里的显式配置写入：
   *   它解除手动锁与 legacy 标记（用户明确要求 DEG 的配置重新生效），并允许写"胜出层就是
   *   会话覆盖"的目标。
   * @returns {boolean} 是否真的登记了意图（会话未被跟踪时为 false）。
   */
  function requestApply(sessionId, reason, options) {
    const explicit = options?.explicit === true;
    const state = sessions.get(sessionId);
    if (state === undefined) return false;
    if (explicit !== true && (state.manualLocked === true || state.legacy === true)) return false;
    if (explicit === true) {
      state.manualLocked = false;
      state.legacy = false;
    }
    state.intentEpoch += 1;
    state.pendingWrites += 1;
    state.lastOutcome = "queued:" + reason;
    const intent = state.intentEpoch;
    const task = async () => {
      try {
        await runIntent(sessionId, state, intent, explicit);
      } finally {
        // 自弃也必须减回：pendingWrites 只表达"还有写入在排队/在途"。
        state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      }
    };
    void enqueue(sessionId, task);
    return true;
  }

  /**
   * 重排边界定时器：只算"下一次需要重新判定时段"的时刻，不遍历任何会话。
   *
   * 宿主没有提供 setTimeout / 清理函数时静默降级（不抛错）；宿主时钟只有 now 时同样
   * 如此——功能退化为"只在新建会话 / 设置保存时判定"，读面仍给出当前时段。
   */
  function armTimer() {
    if (timerHandle !== null && typeof clock.clearTimeout === "function") clock.clearTimeout(timerHandle);
    timerHandle = null;
    if (typeof clock.setTimeout !== "function") return;
    const delay = orchestratorNextBoundaryDelayMs(settings.snapshot(), clock.now());
    if (delay === null) return;
    timerHandle = clock.setTimeout(() => {
      timerHandle = null;
      // 到点后必须重新判定（算术只用来定闹钟，不用来决定时段）。
      refreshPeriod();
    }, delay);
  }

  /**
   * 时段边界处理：对"已有 applied 记录、未手动接管、非 legacy"的会话重算目标并套用。
   *
   * 只处理已 applied 的会话：从未套用过的会话（含恢复的历史会话）永远不在边界上被激活，
   * 否则一次时段切换就会把历史会话一把改掉。
   */
  function refreshPeriod() {
    for (const [sessionId, state] of sessions) {
      if (state.manualLocked === true || state.legacy === true) continue;
      if (state.appliedAt === null) continue;
      const period = orchestratorPeriodOf(settings.snapshot(), clock.now());
      if (period === state.period) continue;
      requestApply(sessionId, "period");
    }
    armTimer();
  }

  /** 新建会话判定的上下文（交出一组窄命令，绝不让模块级函数碰到闭包状态）。 */
  const sessionJudge = {
    ensureEpoch: (nowMs) => persistence.ensureEpoch(nowMs),
    now: () => clock.now(),
    isCurrent: (sessionId, state) => sessions.get(sessionId) === state,
    requestApply: (sessionId) => requestApply(sessionId, "created"),
    logFailure,
    // 判据放弃只记原因码（H2）：绑定本实例的 logger，模块级函数不碰闭包状态。
    logSkip: (action, reason) => logSkipOf(logger, action, reason),
  };

  /**
   * agent/created 入口：只接管"能证明是本次新建"的根会话。
   *
   * 判据四条同时成立（见模块头注释）：根 agent、会话头 createdAt >= 切点、无请求头、
   * DEG 无 applied 记录。任何一条不成立都**不自动套用**；恢复的历史会话与歧义判据记成
   * legacy，之后的边界触发也不会把它捡回来。
   */
  function noteAgentCreated(agent) {
    const sessionId = typeof agent?.id === "string" ? agent.id : "";
    if (sessionId.length === 0) return;
    if (host.isRootAgent(agent) !== true) return;
    const existing = sessions.get(sessionId);
    if (existing !== undefined && existing.appliedAt !== null) return;
    const state = ensureSession(sessionId);
    if (state.legacy === true) return;
    void judgeCreatedSession(sessionJudge, agent, sessionId, state)
      .catch((error) => logFailure("new-session-judge", error));
  }

  /** agent/disposed：会话结束，释放全部运行期状态（含排队中的意图与自写令牌）。 */
  function noteAgentDisposed(agent) {
    const sessionId = typeof agent?.id === "string" ? agent.id : "";
    if (sessionId.length === 0) return;
    sessions.delete(sessionId);
    queues.delete(sessionId);
  }

  /**
   * session/event 入口：只消费 model/selection（用户选择 / 待生效模型）。
   *
   * 判定顺序（B4）：
   * 1. 不是本管理器接管的会话 => 忽略（本插件没有对该会话做过任何写入）；
   * 2. 选择形状非法 => 忽略并记诊断（无法比较，不能据此判定手动）；
   * 3. 命中自写令牌 => 一次性消费并忽略（这是我们自己写入的回声）；
   * 4. 命中在途写入目标 => 忽略（宿主可能在 await selectModel 返回前就回显）；
   * 5. 与"我们最后一次写入值"一致 => 忽略（产品定义：**不同才算**手动）；
   * 6. 其余：与当前目标（在途目标 / 应生效目标）不同 => 手动接管。
   *    **首次应用期间（appliedAt === null）同样成立**：以前会因为没有 applied 记录直接
   *    忽略，结果用户在我们第一次写入期间的选择被悄悄覆盖。
   */
  function noteSessionEvent(session, event) {
    if (event?.type !== "model/selection") return;
    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (sessionId.length === 0) return;
    const state = sessions.get(sessionId);
    if (state === undefined) return;
    const selection = normalizeModelSelection(event.data);
    if (selection === undefined) {
      logFailure("model-selection-event", new TypeError("invalid selection payload"));
      return;
    }
    const key = modelSelectionKeyOf(selection);
    // 0. 已经因同一个值手动接管过：同值回显不得再触发一次持久化（覆盖可能还在落盘途中）。
    if (state.manualLocked === true && state.manualKey === key) return;
    if (state.selfWrite !== null && state.selfWrite.key === key) {
      state.selfWrite = null;
      return;
    }
    if (state.pendingTarget !== null && state.pendingTarget.key === key) return;
    const appliedKey = modelSelectionKeyOf(state.applied);
    if (appliedKey.length > 0 && appliedKey === key) return;
    // 目标 = 在途写入目标 > 当前应生效目标；没有目标（未配置）时不构成"接管"。
    const targetKey = state.pendingTarget?.key ?? state.selfWrite?.key ?? writer.effectiveKeyOf(sessionId);
    if (targetKey.length === 0 || targetKey === key) return;
    state.manualLocked = true;
    state.manualKey = key;
    state.selfWrite = null;
    state.pendingTarget = null;
    state.intentEpoch += 1;
    state.lastOutcome = "manual-locked";
    // 手动接管是既成事实：持久化只影响"重启后该会话仍用这个模型"，失败不回滚事实。
    // 落盘排进本会话的串行链（H1），链内仍按意图代次过新鲜度栅栏：
    // 同一会话的手动持久化不并发，慢的旧值绝不可能覆盖快的新值。
    scheduleManualPersist(enqueue, writer, sessionId, state, state.intentEpoch, selection);
  }

  /**
   * 设置页保存成功后的唯一动作：推进"未来新会话的配置修订"并重排定时器。
   *
   * 刻意**不遍历会话**：产品语义要求保存只影响之后新建的会话。已存在会话的模型不会因为
   * 一次保存被改动（连"重新套用同样的值"都不做，避免无意义的 model/selection 事件）。
   */
  function noteSettingsCommit() {
    configRevision += 1;
    armTimer();
  }

  /** 读面投影（root get 的 orchestrator 字段）：形状与判定表见模块头与 statusOf。 */
  function getStatus(sessionId) {
    return statusOf({
      snapshot: settings.snapshot(),
      nowMs: clock.now(),
      sessionId,
      state: sessions.get(sessionId),
      hostReady: selectModelOf() !== null,
    });
  }

  /**
   * 显式写入入口（会话模型弹窗的 session-override-set）。
   *
   * 只登记意图：真正的 selection 由管线从**已落盘的覆盖**重新解析（层解析是唯一事实源），
   * 因此这里不接收 selection，避免出现"内存里的目标"与"落盘覆盖"两份真相。
   *
   * @param {string} sessionId - 根会话 id。
   * @returns {boolean} 是否登记成功（会话未被跟踪时仍会先登记会话，恒为 true）。
   */
  function applyOverride(sessionId) {
    ensureSession(sessionId);
    return requestApply(sessionId, "override-set", { explicit: true });
  }

  /**
   * 显式写入入口（会话模型弹窗的 session-override-clear）。
   *
   * 清除后按优先级重算 effective：有可用目标（时段/全局）就套用；没有（不干预）则
   * runIntent 走 not-configured 分支，保持现状不写。
   *
   * @param {string} sessionId - 根会话 id。
   * @returns {boolean} 是否登记成功。
   */
  function applyOverrideCleared(sessionId) {
    ensureSession(sessionId);
    return requestApply(sessionId, "override-clear", { explicit: true });
  }

  /**
   * 晚绑定 sessionController（由入口的 ctx.inject 回调调用）。
   *
   * 服务缺失 / 未就绪时不做任何自动套用：只在读面里把 hostReady 暴露成 false。
   * 这里**不重放**此前因服务缺失而跳过的会话——"未就绪就不套用"是明确的产品边界，
   * 延后补写会在用户已经开始输入之后突然改模型。
   */
  function bindService(nextService) {
    service = nextService ?? undefined;
    armTimer();
  }

  /** 服务释放：只解除绑定，不清理会话状态（会话本身仍归 agent 生命周期管理）。 */
  function unbindService(released) {
    if (service === undefined) return;
    if (released !== undefined && released !== service) return;
    service = undefined;
  }

  /** 插件卸载：清定时器与会话状态，避免 effect 泄漏与跨实例污染。 */
  function dispose() {
    if (timerHandle !== null && typeof clock.clearTimeout === "function") clock.clearTimeout(timerHandle);
    timerHandle = null;
    sessions.clear();
    queues.clear();
    service = undefined;
  }

  return {
    noteAgentCreated,
    noteAgentDisposed,
    noteSessionEvent,
    noteSettingsCommit,
    getStatus,
    bindService,
    unbindService,
    // 显式配置写入（会话覆盖 set/clear 的 RPC 端点在落盘成功后调用）。
    applyOverride,
    applyOverrideCleared,
    // 时段边界的显式入口（定时器回调与测试诊断共用同一实现）。
    refreshPeriod,
    dispose,
    /** 只读诊断（不进协议面）：配置修订与已跟踪会话数。 */
    diagnosticsOf: () => ({ configRevision, trackedSessions: sessions.size, armed: timerHandle !== null }),
  };
}
