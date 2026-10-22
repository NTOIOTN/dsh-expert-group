/**
 * dsh-expert-group 的 fan-out 领域模块。
 *
 * 该模块把「一个父任务拆成多个 shard、按 role 限流并发执行、wait-all 聚合」这套
 * 逻辑收敛成纯 Node ESM 工厂，不依赖任何 DSH runtime。Host 只需通过依赖注入提供：
 *
 * - launcher：启动一个 shard 对应的 child（可适配现有 startContinuable）；
 * - canceller：取消/中断一个正在运行的 child（可适配 subagents.interrupt）；
 * - clock：now/setTimeout/clearTimeout（可注入假时钟做确定性超时测试）；
 * - persistence：状态变化后的快照落盘回调；
 * - conflictChecker：affectedPaths 冲突判定（模块不自带路径解析器）。
 *
 * 设计要点（状态机、队列、公平性、竞态与错误处理）：
 *
 * 1. 状态机：shard 逻辑状态只有 queued / running / 四类终态
 *    (succeeded、failed、cancelled、timed_out)，外加恢复态 interrupted（只在
 *    restore 出现，表示原运行时句柄已丢失）。终态写入必须一次性且幂等，取消与完成
 *    竞态采用「先写入终态者胜出」，迟到结果只记录不覆盖。
 * 2. 队列：每个 shard 是独立调度单元，按输入顺序保留；并发上限只约束 running 数量，
 *    不限制登记总量，排队中的 shard 不计入 running。
 *    并发约束是**两层独立判定的与关系**，不是覆盖关系：
 *    - 任务级显式 concurrencyLimit（fanout 工具入参）：只统计该父任务**自身**的 running
 *      分片数，代表"这个父任务最多同时跑几个分片"；未显式给出（含快照恢复出的任务级值
 *      缺失）时这一层不设限。
 *    - role 级 roleLimits（Host 接入插件 settings.roleConcurrencyLimit），缺失时落到
 *      插件默认值：代表"整个 role 共享的并发池"，统计该 role 下**所有**父任务的 running
 *      分片数。
 *    派发一个 shard 必须同时满足「任务自身 running < 任务级上限」与「role 共享 running <
 *    role 池上限」。若只按单层覆盖，低任务级上限的父任务会被其它父任务占用的 role 槽位
 *    饿死，而高任务级上限的父任务又能单任务越过 role 共享池。
 *    - provider 级 providerLimits（票据 26，{provider: 0..64}，0/未设置 = 不限制）：
 *      统计该 provider 下**所有**父任务的 running 分片数，名额只在分片真正进入 running
 *      时占用，排队不占名额也不预留；判定顺序固定为「先 provider、后 role」，释放顺序
 *      相反（分片终态时同时归还两个池），因此不存在交叉等待导致死锁的可能。任务没有
 *      provider 归属（角色未配置主模型）时不进入任何 provider 池。
 *    角色级/default 两层描述"该角色的共享并发池"，可以注入解析函数并按当前设置动态
 *    取值（设置页保存后立即约束后续派发）；任务级显式限制会随任务快照固化，恢复后不变。
 *    并发来源优先级：当前设置解析值（live）> 快照中的显式角色级映射 > 安全默认值。
 *    restore 不会把 live 来源冻结成快照值；只有读不到当前设置的进程才冻结并标注 source=snapshot。
 * 3. 公平性：多个父任务共享同一 role 槽位时，按父任务轮转（round-robin cursor）
 *    派发，避免大型父任务用排队 shard 饿死后来的小任务。
 * 4. 竞态：启动器可能同步返回、异步返回，也可能启动后永不结束（只能靠超时或取消
 *    收敛）；取消可能发生在 queued、running 或已经终态之后，全部路径都收敛到同一
 *    个 settle() 入口。
 * 5. 错误处理：启动失败（同步抛错或 Promise reject）记为 failed，不自动重试，兄弟
 *    shard 继续；手工重试只通过 retryShard 显式触发，并在原父任务内追加 attempt，
 *    保留全部历史。
 *
 * 6. 数据资源预算：prompt / result / error / 事件 / 快照 / task/shard/attempt 数量
 *    全部有界，超限一律结构化拒绝或显式失败（见 resource-budget.js）。输入超限在
 *    submit 阶段整体拒绝；result/error 超限把该 shard 收敛为 failed 并携带
 *    complete=false 的违规元数据；快照超限不落盘。
 * 7. 超时（票据 06）：三级来源 shard 显式 > 父任务默认 > 角色默认，含「0 = 显式禁用」
 *    与「未设置 = 交给下一级」两种语义（合法启用值：1000~86,400,000 毫秒，精度 1 秒）。
 *    超时只在**创建 attempt 时**解析一次并写入 attempt.timeoutMs，因此不会改写运行中的分片；
 *    计时起点是 attempt 进入 running，超时把最新 attempt 收敛为 timed_out（可手工重试、
 *    绝不自动重试）。
 * 8. 真实停止边界（票据 07，manager 层）：**逻辑终态**与**执行确已停止**是两件事。
 *    - 逻辑状态一旦进入 succeeded/failed/cancelled/timed_out/interrupted 就一定性且不可被
 *      迟到结果改写；stopEvidence 只允许 unknown -> observed；
 *    - 影响范围（affectedPaths 预留）按 **attempt** 建索引，从 queued 起就占用，只有
 *      「attempt 已终态 且 stopEvidence 已 observed」才释放；
 *    - 聚合 gate：任务只有在 counts.pending===0 且 counts.stop_pending===0 时才结算、
 *      写 settledAt、发 task_settled；逻辑终态但停止未确认时任务保持 pending；
 *    - 重试/续作/恢复续跑在创建新 attempt 前必须确认该 shard 的历史 attempt 全部 observed，
 *      否则结构化拒绝 reason=stop_unconfirmed；
 *    - 超时/取消只写逻辑终态并请求停止（stopRequestedAt/stopDeadlineAt + 看门狗），
 *      宽限到期只记 stopWatchdogExpiredAt 并发布一次 attempt_stop_unconfirmed 诊断，
 *      不释放范围、不重试、不聚合、不发完成通知；
 *    - 权威停止证据由 Host 经 observeStopEvidence 提交（严格 attempt 身份匹配）；管理器
 *      自身只承认「自己的完成回调」「admission 明确未创建 child」「queued 从未 admission」
 *      与恢复边界（process-restart）。
 * 9. 显式任务回收（票据 05）：根会话可以回收**已结算**的父任务，让容量不再被历史任务永久
 *    占满。回收是两阶段提交：prepareReclaim 先按统一前置条件筛选、生成"排除待回收任务"的
 *    候选快照并立起回收屏障（barrier）；Host 必须先把候选快照**真实落盘成功**，才允许
 *    commitReclaim 从内存与索引中移除。落盘失败只能 abortReclaim，内存状态不变。
 *    - 屏障期间所有公开写入口返回结构化 reclaim_in_progress（commit/abort 除外），
 *      调度暂停但既有 child 的 completion/超时仍可收敛，绝不丢收敛事件；
 *    - 回收不保留任务墓碑：快照/列表/查询只看得到 task_not_found，重启也不会复活；
 *    - 关闭竞态：close 不清回收屏障、也不删除已结算任务；已 prepare 的回收在 close 后
 *      仍可 commit/abort（token + 屏障是唯一门槛），关闭后的 commit 只做内存/索引移除，
 *      不再 emit tasks_reclaimed、不 notifyPersistence、不 schedule；
 *    - 已被回收任务对象上的迟到回调（completion/证据/归属老化）只做结构化 no-op
 *      （reason=task_reclaimed），不改统计、不写事件与快照；
 *    - 容量拒绝结构携带 current / reclaimable 与指向回收入口的可执行提示，
 *      且 requestId 幂等判定先于容量判定（满额时重复 requestId 仍返回 duplicate）。
 *
 * @module dsh-expert-group/fanout
 */
import {
  BUDGET_EXCEEDED_CODE,
  FANOUT_BUDGET,
  checkAttemptPayloadBudget,
  checkBudget,
  checkRestoreBudget,
  checkTaskInputBudget,
  createEventHistoryAccounting,
  describeBudgetViolation,
  measureJsonBytes,
  measureUtf8Bytes,
} from "./resource-budget.js";
import {
  MODEL_ROUTE_ERROR_CODES,
  classifyModelRouteError,
  describeSubagentCapacityFailure,
} from "./shared.js";

/**
 * per-role 并发上限的默认值。
 *
 * 与插件 settings 的 DEFAULT_ROLE_CONCURRENCY_LIMIT（index.js）、客户端归一/设置页
 * title 文案保持一致；这里同时是解析函数抛错或返回非法值时的安全回退值。
 */
export const DEFAULT_CONCURRENCY_LIMIT = 20;
/** per-role 并发上限的下界。 */
export const MIN_CONCURRENCY_LIMIT = 1;
/** per-role 并发上限的上界。 */
export const MAX_CONCURRENCY_LIMIT = 64;
/**
 * provider 级并发上限的下界（0 = 不限制）。
 *
 * 与 role 级上限不同，provider 上限允许多一个「0」取值：规格书把 0 定义为
 * 「显式不限制」，用于表达「这里没有名额约束」，而不是「配置缺失」。
 */
export const MIN_PROVIDER_LIMIT = 0;
/** provider 并发上限的上界：与 role 级共享同一个数量级上界。 */
export const MAX_PROVIDER_LIMIT = MAX_CONCURRENCY_LIMIT;
/**
 * 限流预计等待（etaMs）所需的最小历史样本数。
 *
 * 样本来自「一次限流窗口 → 真正派发成功」的时长。单一样本噪声太大，不足以支撑
 * 一个用户可以据此安排工作的数字，因此少于该数量时诊断必须显式返回 null +
 * etaSource:"unknown"，绝不伪造精确等待时间。
 */
export const THROTTLE_ETA_MIN_SAMPLES = 2;
/** 限流统计的键上界：角色/provider 键来自设置，仍必须有界，避免诊断面无限增长。 */
export const THROTTLE_STATS_LIMIT = 128;

/**
 * 回收进行中的统一拒绝码（Host/RPC/客户端与测试共用，避免字符串漂移）。
 *
 * 语义：manager 正在等待一次回收的候选快照落盘，此时任何公开写入口都不得插入状态变化，
 * 否则"落盘的候选"与"内存状态"会不一致。调用方拿到本码应稍后重试。
 */
export const RECLAIM_IN_PROGRESS_CODE = "RECLAIM_IN_PROGRESS";

/** 已回收任务的迟到回调统一拒绝码（结构化 no-op，不复活任务）。 */
export const TASK_RECLAIMED_CODE = "TASK_RECLAIMED";

/**
 * 派发前 provider 路由改变的统一拒绝码（票据 26 与票据 24 的交叉边界）。
 *
 * 为什么需要它：任务的 provider 归属在**提交时**固化（用于 provider 级并发名额），
 * 而候选 fallback 可能在 admission 时解析出另一个 provider。若二者不一致，继续启动
 * child 就会把运行名额记到错误的 provider 名下（provider A 未被占用、provider B 却超发），
 * 因此必须 fail-closed 拒绝本次 admission，让任务以稳定原因失败，而不是悄悄错记名额。
 *
 * Host 的 buildRequest 抛出本码；fanout.js 的启动错误归一保留该码与固定文案，
 * 不把 provider/模型配置或原始错误正文写进事件历史。
 */
export const PROVIDER_ROUTE_CHANGED = "PROVIDER_ROUTE_CHANGED";

/** 单次显式回收的父任务数上限：与 maxTasks 同源（不允许一次回收超过容量本身）。 */
export const MAX_RECLAIM_BATCH = FANOUT_BUDGET.maxTasks;

/**
 * shard / 父任务 / 角色默认超时（毫秒）的边界与精度（票据 06「超时能力暴露」）。
 *
 * 语义只有三种：
 * - 未设置（undefined/null）：表示「这一层没有配置」，交给下一层优先级；
 * - 0：显式禁用超时（可以用它覆盖上级默认值）；
 * - 1000 ～ 86,400,000 且为 1000 的整数倍：真正启用。
 *
 * 上限 24 小时：足够覆盖长任务，同时避免把「超时」写成事实上的无限等待；
 * 精度 1 秒的理由是设置页与工具参数都不应引入毫秒级噪声（超时肯定是人工决定的粗粒度阈值）。
 */
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 86400000;
export const TIMEOUT_STEP_MS = 1000;

/**
 * 校验超时取值并返回归一结果：工具层、settings 层与 manager 层共用同一语义。
 *
 * 返回 {ok:true, value} 时 value 可能是 undefined（未设置）或 0（显式禁用）：
 * 两者都合法，但语义不同——前者把决定权交给下一层优先级，后者截断下层默认值。
 *
 * 非法输入（非数、NaN/Infinity、负数、1～999、超上限、非整秒）
 * 一律返回同一个结构化错误 code=INVALID_TIMEOUT，并带准确字段路径。
 *
 * @param {unknown} value - 待校验值。
 * @param {string} [field] - 出错时的字段路径（如 "shards[0].timeoutMs"）。
 * @returns {{ok:true, value:(number|undefined)} | {ok:false, code:string, message:string, field:string}}
 */
export function validateTimeoutMs(value, field = "timeoutMs") {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, code: "INVALID_TIMEOUT", message: field + " 必须是毫秒数", field };
  }
  if (value === 0) return { ok: true, value: 0 };
  if (!Number.isInteger(value)) {
    return { ok: false, code: "INVALID_TIMEOUT", message: field + " 必须是整数毫秒", field };
  }
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return {
      ok: false,
      code: "INVALID_TIMEOUT",
      message: field + " 必须是 0（禁用）或 " + MIN_TIMEOUT_MS + "~" + MAX_TIMEOUT_MS + " 毫秒",
      field,
    };
  }
  if (value % TIMEOUT_STEP_MS !== 0) {
    return {
      ok: false,
      code: "INVALID_TIMEOUT",
      message: field + " 必须是 " + TIMEOUT_STEP_MS + " 毫秒的整数倍（精度 1 秒）",
      field,
    };
  }
  return { ok: true, value };
}

/**
 * 把任意超时取值归一成可直接使用的值：非法/未设置 → undefined（不启用）。
 *
 * 只用于**读取面**（settings 归一、注入解析函数的返回值）：配置写错
 * 不能让调度抛错，写入口仍必须走 validateTimeoutMs 拿到结构化拒绝。
 * 注意 0 是显式禁用，会原样保留。
 *
 * @param {unknown} value - 待归一值。
 * @returns {number|undefined}
 */
export function normalizeTimeoutMs(value) {
  const check = validateTimeoutMs(value);
  return check.ok ? check.value : undefined;
}

/**
 * 恢复路径的超时校验：只要求「0 或正有限数」，**不**套用新写入的
 * 精度 / 上下界规则（票据 06 的恢复兼容约束）。
 *
 * 为什么放宽：旧快照里的 timeoutMs 由旧版管理器的校验产生（任意正有限数，
 * 例如 1500 毫秒）；1 秒精度与 24 小时上限只约束**新写入**。用新规则整体拒绝
 * 一份历史快照，等于让升级后无法恢复任何旧任务。0（显式禁用）同样必须可恢复。
 *
 * @param {unknown} value - 快照中的超时值。
 * @param {string} field - 出错时的字段路径。
 * @returns {{ok:true, value:(number|undefined)} | {ok:false, code:string, message:string, field:string}}
 */
/**
 * 恢复路径的停止证据字段校验（票据 07）。
 *
 * 结构非法必须整体拒绝，不能静默丢弃：把"已观察"降级成"未知"会让任务永远不结算，
 * 把"未知"升级成"已观察"更危险——它会凭空释放影响范围。因此这里只做形状校验，
 * 语义（unknown -> observed、进程重启边界）由 restore 的边界选项决定。
 *
 * @param {object} rawAttempt - 快照中的 attempt。
 * @param {string} field - 字段路径（错误定位用）。
 * @returns {{ok:true} | {ok:false, code:string, message:string, field:string}}
 */
function validateRestoredStopFields(rawAttempt, field) {
  const fail = (message, at = field) => ({ ok: false, code: "INVALID_SNAPSHOT_STOP_EVIDENCE", message, field: at });
  if (rawAttempt.attemptId !== undefined
    && (typeof rawAttempt.attemptId !== "string" || rawAttempt.attemptId.trim().length === 0)) {
    return fail("快照 attempt.attemptId 必须是非空字符串", field + ".attemptId");
  }
  if (rawAttempt.executionGeneration !== undefined
    && (!Number.isSafeInteger(rawAttempt.executionGeneration) || rawAttempt.executionGeneration < 1)) {
    return fail("快照 attempt.executionGeneration 必须是正整数", field + ".executionGeneration");
  }
  for (const key of ["stopRequestedAt", "stopDeadlineAt", "stopWatchdogExpiredAt"]) {
    const value = rawAttempt[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return fail("快照 attempt." + key + " 必须是非负有限数", field + "." + key);
    }
  }
  if (rawAttempt.terminalReason !== undefined
    && (typeof rawAttempt.terminalReason !== "string" || rawAttempt.terminalReason.length === 0)) {
    return fail("快照 attempt.terminalReason 必须是非空字符串", field + ".terminalReason");
  }
  if (rawAttempt.legacy !== undefined && typeof rawAttempt.legacy !== "boolean") {
    return fail("快照 attempt.legacy 必须是布尔值", field + ".legacy");
  }
  if (rawAttempt.stopEvidence === undefined) return { ok: true };
  const evidence = rawAttempt.stopEvidence;
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return fail("快照 attempt.stopEvidence 必须是对象", field + ".stopEvidence");
  }
  if (evidence.state !== STOP_EVIDENCE_STATE_UNKNOWN && evidence.state !== STOP_EVIDENCE_STATE_OBSERVED) {
    return fail("快照 attempt.stopEvidence.state 必须是 unknown/observed", field + ".stopEvidence.state");
  }
  if (evidence.state === STOP_EVIDENCE_STATE_UNKNOWN) return { ok: true };
  if (typeof evidence.source !== "string" || evidence.source.trim().length === 0) {
    return fail("已观察的 stopEvidence 必须带 source", field + ".stopEvidence.source");
  }
  if (evidence.observedAt !== undefined
    && (typeof evidence.observedAt !== "number" || !Number.isFinite(evidence.observedAt) || evidence.observedAt < 0)) {
    return fail("stopEvidence.observedAt 必须是非负有限数", field + ".stopEvidence.observedAt");
  }
  for (const key of ["childId", "messageId", "sessionId"]) {
    if (evidence[key] === undefined) continue;
    if (typeof evidence[key] !== "string" || evidence[key].trim().length === 0) {
      return fail("stopEvidence." + key + " 必须是非空字符串", field + ".stopEvidence." + key);
    }
  }
  if (evidence.turn !== undefined && (!Number.isSafeInteger(evidence.turn) || evidence.turn < 0)) {
    return fail("stopEvidence.turn 必须是非负整数", field + ".stopEvidence.turn");
  }
  return { ok: true };
}

function validateRestoredTimeoutMs(value, field) {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, code: "INVALID_TIMEOUT", message: field + " 必须是 0 或正有限数", field };
  }
  return { ok: true, value };
}

/**
 * shard 可选任务名称的 UTF-8 字节上限。
 *
 * 名称是"给人看的短标签"，会随任务快照、事件与 Expert Group 投影一路传递并展示在
 * 右栏第一行，因此必须有界：无界名称会让单条投影行被超长文本撑爆（视觉截断只解决
 * 显示，不解决传输与落盘体积）。256 字节足够容纳一句话级的中文任务名（约 85 个汉字），
 * 同时又远小于单个 shard prompt 的预算，超限一律结构化拒绝而不是静默截断。
 *
 * 常量留在本模块而不是 resource-budget.js：它是本模块的输入形状约束，不属于 fan-out
 * 的字节资源预算族（最大快照/事件/输入体积），混进预算表反而会让人误以为它参与
 * 全局满载测量。
 */
export const MAX_SHARD_NAME_BYTES = 256;

/** shard 的四类终态（interrupted 只由 restore 产生，见下）。 */
export const SHARD_TERMINAL_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/**
 * 可手工重试的 shard 终态（与 retryShard 的判定同一集合）。
 *
 * 单独成表是为了让能力投影与真实写入口共用同一份词表：任何一侧新增/删减状态，
 * 另一侧都不会悄悄漂移成「界面允许但 manager 拒绝」。
 */
const RETRYABLE_SHARD_STATUSES = new Set(["failed", "timed_out", "cancelled", "interrupted"]);

/** 父任务聚合状态。pending 表示仍有未终态 shard。 */
export const FANOUT_TASK_STATUSES = Object.freeze([
  "pending",
  "completed",
  "completed_with_errors",
  "cancelled",
]);

/** 会出现在 counts 中的全部 shard 状态。 */
const SHARD_STATUS_KEYS = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const SHARD_STATUS_SET = new Set(SHARD_STATUS_KEYS);

/**
 * 停止证据（stopEvidence）的状态与来源（票据 07）。
 *
 * 状态机只有两个状态：
 * - unknown：默认。管理器知道"这个 attempt 逻辑上结束了/被要求停止了"，但**无法证明**
 *   对应的执行体（child 进程/会话轮次）真的停了；
 * - observed：收到了权威停止信号。只允许 unknown -> observed，永不可逆。
 *
 * source 的取值必须来自下面这张表。表分两层：
 * - 管理器自己可判定的（child_completion / admission_not_created / not-started）：
 *   child_completion 指该 attempt 自己绑定的 completion 回调落地（成功、失败或取消后的
 *   迟到回调都算），它证明这一轮执行已经结束；admission_not_created 指启动器抛错/reject，
 *   按既有契约等于没有创建 child；not-started 指 queued 阶段被取消、从未 admission。
 * - Host 提交的权威信号（child_turn_end / child_disposal / admission_not_created /
 *   fencing）：必须严格归属到该 attempt，由 observeStopEvidence 入口校验。
 * - process-restart：只由 restore 的 stopEvidenceBoundary="process-restart" 使用。
 *
 * 管理器自己发出的 cancel/interrupt、超时到期、close、root 结束、代次更新都**不是**
 * 停止证据，对应 attempt 的 stopEvidence 保持 unknown。
 */
export const STOP_EVIDENCE_STATE_UNKNOWN = "unknown";
export const STOP_EVIDENCE_STATE_OBSERVED = "observed";
export const STOP_EVIDENCE_SOURCES = Object.freeze([
  "child_completion",
  "admission_not_created",
  "not-started",
  "child_turn_end",
  "child_disposal",
  "fencing",
  "process-restart",
]);
/** observeStopEvidence 接受的外部来源（管理器内部来源不允许由 Host 冒充）。 */
export const HOST_STOP_EVIDENCE_SOURCES = Object.freeze([
  "child_turn_end",
  "child_disposal",
  "admission_not_created",
  "fencing",
]);
/**
 * 停止宽限期（毫秒）：从"请求停止"到"看门狗判定未确认"的默认预算。
 *
 * 它不改变任何逻辑状态，只决定何时发布一次 attempt_stop_unconfirmed 诊断。15 秒足够覆盖
 * 一次 interrupt 的进程清理，又远小于超时量级，避免诊断被无限推迟；可通过
 * createFanoutManager({ stopGraceMs }) 注入（测试用假时钟驱动同一个定时器 seam）。
 */
export const STOP_GRACE_MS = 15000;
/** restore 的停止证据边界取值。 */
export const STOP_EVIDENCE_BOUNDARIES = Object.freeze(["unknown", "process-restart"]);

/**
 * 稳定进程身份（票据 07）：pid + 进程启动时间，用于自动判定恢复边界。
 *
 * 为什么需要它：restore 的默认边界不能靠猜——同一个进程内重建 manager（例如插件重载、
 * defer 后再次 restore）时，旧 child 可能仍在写盘，此时必须保持 unknown；而新进程启动时，
 * 上一个进程的执行体确实已随进程终止，这是规格允许的 process-restart 边界。
 *
 * 缓存策略：第一次计算后写进 globalThis 的 Symbol 槽位（同一进程内所有模块实例共享，
 * Symbol.for 保证跨模块重载仍是同一个键）。因此模块被重新求值（插件热重载）时身份不变；
 * 只有真正的进程重启才会得到新值。启动时间用 Date.now()-process.uptime()*1000 反推，
 * 取整到毫秒；全局缓存避免了两次求值之间的时钟采样噪声。
 */
const PROCESS_INSTANCE_SYMBOL = Symbol.for("dsh-expert-group:process-instance");

/**
 * 解析当前进程身份（只计算一次并全局缓存）。
 *
 * @returns {string} "proc:<pid>@<startedAtMs>"；无法读取 process 时返回稳定占位值。
 */
export function resolveProcessInstance() {
  const globalObject = typeof globalThis === "object" && globalThis !== null ? globalThis : undefined;
  const cached = globalObject?.[PROCESS_INSTANCE_SYMBOL];
  if (typeof cached === "string" && cached.length > 0) return cached;
  let value;
  try {
    const startedAt = Math.round(Date.now() - process.uptime() * 1000);
    value = "proc:" + process.pid + "@" + startedAt;
  } catch {
    // 退化值也必须稳定（模块重载不能改变它），否则会把同进程误判成重启。
    value = "proc:unknown@0";
  }
  if (globalObject !== undefined) {
    try {
      Object.defineProperty(globalObject, PROCESS_INSTANCE_SYMBOL, {
        value,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } catch {
      try { globalObject[PROCESS_INSTANCE_SYMBOL] = value; } catch { /* 只读宿主：保持局部值 */ }
    }
  }
  return value;
}

/** 当前进程身份（快照持久化与自动恢复边界的唯一来源）。 */
export const PROCESS_INSTANCE = resolveProcessInstance();

/** 快照格式版本；restore 只接受同版本快照。 */
const SNAPSHOT_VERSION = 1;

/**
 * 超时投影版本（票据 06）：新快照会在分片上写入 shard.timeoutMs（仅显式值）。
 *
 * 为什么需要它：旧快照的 buildSnapshotPayload **从来没有**写过 shard.timeoutMs，
 * 当年的恢复靠「最新 attempt 的 timeoutMs」反推分片覆盖（旧语义下两者恒等）。
 * 新语义下 attempt.timeoutMs 可能来自父任务/角色默认值，再反推就会把默认值
 * 伪造成分片覆盖。因此用一个显式标记区分两种投影：缺标记 = 旧快照（保持
 * 反推兼容），标记匹配 = 新快照（只认 rawShard.timeoutMs）。
 * 它不改变 SNAPSHOT_VERSION：两种快照都可恢复，不能因标记存在与否而整体拒绝。
 */
const TIMEOUT_PROJECTION_VERSION = 1;

/** 判断 shard 是否已进入终态（含恢复态 interrupted）。 */
export function isTerminalShardStatus(status) {
  return SHARD_TERMINAL_STATUSES.includes(status);
}

/**
 * 确定性的 attempt 标识（旧快照缺字段时的派生规则，新 attempt 复用同一格式）。
 *
 * 为什么用确定性字符串而不是随机 id：attempt 身份必须跨进程重启稳定（快照里持久化），
 * 并且旧快照（没有 attemptId 字段）也要能被 Host 用同一规则寻址——两套规则会让"恢复后
 * 提交停止证据"永远对不上。三元组 parentTaskId+shardId+attempt 在管理器内天然唯一
 * （parentTaskId 唯一、shardId 在任务内唯一、attempt 序号单调递增），因此派生是安全的。
 *
 * @param {string} parentTaskId - 父任务标识。
 * @param {string} shardId - 分片标识。
 * @param {number} attemptNumber - attempt 序号（从 1 开始）。
 * @returns {string}
 */
export function deriveAttemptId(parentTaskId, shardId, attemptNumber) {
  return "attempt:" + String(parentTaskId) + "/" + String(shardId) + "#" + String(attemptNumber);
}

/** attempt 的停止证据是否已确认为 observed（缺字段一律按 unknown 处理）。 */
export function isStopObserved(attempt) {
  return attempt?.stopEvidence?.state === STOP_EVIDENCE_STATE_OBSERVED;
}

/** 各逻辑终态对应的默认终止原因码（调用方可覆盖成更精确的原因）。 */
function defaultTerminalReason(status) {
  switch (status) {
    case "succeeded": return "completed";
    case "timed_out": return "timeout";
    case "interrupted": return "restore";
    case "cancelled": return "cancelled";
    default: return "failed";
  }
}

/** 结构化校验错误：调用方可用 code/field 做精确分支，不需要解析文案。 */
export class FanoutValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FanoutValidationError";
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * 预算违规的 shard 错误：结构化、可 JSON 序列化，且不携带超限原始负载。
 * complete/recoverable/receivedBytes/maxBytes 与 describeBudgetViolation 完全一致。
 */
function budgetShardError(violation) {
  return {
    name: "BudgetExceededError",
    reason: "budget_exceeded",
    code: BUDGET_EXCEEDED_CODE,
    resource: violation.resource,
    message: violation.message,
    receivedBytes: violation.receivedBytes,
    maxBytes: violation.maxBytes,
    limit: violation.limit,
    complete: false,
    recoverable: violation.recoverable === true,
    subject: violation.subject,
    ...(violation.hint === undefined ? {} : { hint: violation.hint }),
  };
}

/** 结构化 shard 错误：保留 reason 便于 Host 区分 timeout/cancel/启动失败。 */
function toShardError(error, fallbackMessage) {
  if (error === null || error === undefined) return { name: "Error", message: fallbackMessage };
  if (typeof error === "object" && !Array.isArray(error)) {
    const record = { ...error };
    if (typeof record.message !== "string" || record.message.length === 0) record.message = fallbackMessage;
    if (typeof record.name !== "string") record.name = "Error";
    return record;
  }
  return { name: "Error", message: String(error) };
}

/**
 * 该错误是否是 provider 限流（429 / rate limit / 配额）。
 *
 * 复用 shared.js 的唯一分类器，不在这里写第二套正则：路由层与 fanout 层的
 * 「什么算限流」必须同源，否则会出现「路由不肯降级、fanout 却把它当普通失败」的裂缝。
 *
 * @param {unknown} error - 启动/admission/completion 的原始错误。
 * @returns {boolean}
 */
function isProviderRateLimitedError(error) {
  if (error === null || typeof error !== "object") return false;
  return classifyModelRouteError(error) === MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
}

/** 把任意启动结果规范化为结构化错误。 */
function normalizeLaunchError(error) {
  // 容量耗尽：用户看到可读提示（等待子代理完成 / 继续使用现有子代理），
  // 而不是宿主原始错误码。code 用自有稳定值，保持 structured error 契约。
  const capacity = describeSubagentCapacityFailure(error);
  if (capacity !== undefined) {
    return { name: "SubagentCapacityError", code: capacity.code, message: capacity.message };
  }
  /**
   * provider 限流（票据 26）：给出稳定原因码，且**不**伪装成可 fallback 的预检错误。
   *
   * 两阶段策略都要求不换候选：
   * - 派发前名额已满 → 由调度器的 provider 名额排队承担（根本不进入本函数）；
   * - 运行中/启动时的 429 → 由宿主请求级退避重试处理，重试耗尽后 attempt 失败；
   *   这里只负责把失败归一成可检索的原因码，供 RPC/侧栏/诊断区分「限流」与「未知失败」。
   *
   * 不携带 provider/model 或原始错误正文：错误会进事件历史与快照，限流正文常含
   * 请求 id 与配额细节，属于不应落盘的外部负载。
   */
  if (isProviderRateLimitedError(error)) {
    return {
      name: "ProviderRateLimitedError",
      code: MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED,
      reason: "provider_rate_limited",
      // retryable 只表达「这是一次可退避重试的失败」，不表示插件会自动重试。
      retryable: true,
      message: "provider 返回 429/限流：由宿主退避重试处理，本 attempt 不切换模型",
    };
  }
  /**
   * provider 路由在派发前改变（票据 24 fallback × 票据 26 provider 名额）。
   *
   * Host 的 buildRequest 已按提交时固化的 provider 做过一致性校验；这里只负责把
   * 结构化错误投影进 attempt 快照，**保留稳定 code**（普通 Error 的 name/message
   * 投影会丢掉自定义 code，诊断就只能看到一个普通启动失败）。
   *
   * 不携带任务/provider/model 配置与原始错误正文：错误会进入事件历史与快照。
   */
  if (error?.code === PROVIDER_ROUTE_CHANGED) {
    return {
      name: "ProviderRouteChangedError",
      code: PROVIDER_ROUTE_CHANGED,
      reason: "provider_route_changed",
      // 不可重试：重新解析同一个任务仍可能得到不同 provider，必须由调用方重新提交。
      retryable: false,
      message: "fan-out provider 路由在派发前发生变化：任务提交时固化的 provider 与实际解析不一致，已拒绝启动 child",
    };
  }
  if (error instanceof Error) {
    return toShardError({ name: error.name, message: error.message, stack: error.stack }, "shard 启动失败");
  }
  return toShardError(error, "shard 启动失败");
}

/**
 * 深拷贝快照数据。模块只处理 JSON 安全数据（prompt/结果/错误/时间戳），
 * 因此用 JSON 往返即可，既不引入依赖，也天然隔离外部修改。
 */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

/**
 * 把可选的 id 集合归一成 Set（用于快照投影的排除集合）。
 *
 * 只接受数组或 Set；其它形态视为"没有排除集合"（null）。空集合同样归一成 null，
 * 让热路径可以只做一次 null 判定，而不必区分"空集合"与"未提供"。
 *
 * @param {unknown} value - 数组 / Set / undefined。
 * @returns {Set<string>|null}
 */
function normalizeIdSet(value) {
  if (value === null || value === undefined) return null;
  const source = value instanceof Set ? value : (Array.isArray(value) ? value : null);
  if (source === null) return null;
  const set = new Set();
  for (const entry of source) {
    if (typeof entry === "string" && entry.length > 0) set.add(entry);
  }
  return set.size === 0 ? null : set;
}

/**
 * 校验 per-role 并发上限。必须是对 1~64 范围内的整数。
 * @param {unknown} value - 待校验值。
 * @returns {{ok:boolean, value?:number, code?:string, message?:string}}
 */
export function validateConcurrencyLimit(value) {
  if (value === undefined || value === null) {
    return { ok: false, code: "INVALID_CONCURRENCY_LIMIT", message: "concurrencyLimit 必须是 1~" + MAX_CONCURRENCY_LIMIT + " 的整数" };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, code: "INVALID_CONCURRENCY_LIMIT", message: "concurrencyLimit 必须是整数" };
  }
  if (value < MIN_CONCURRENCY_LIMIT || value > MAX_CONCURRENCY_LIMIT) {
    return { ok: false, code: "INVALID_CONCURRENCY_LIMIT", message: "concurrencyLimit 必须在 " + MIN_CONCURRENCY_LIMIT + "~" + MAX_CONCURRENCY_LIMIT + " 之间" };
  }
  return { ok: true, value };
}

/**
 * 把 roleLimits 配置规范化为干净的 role -> limit 映射。
 * 非法条目直接抛错，避免把错误的并发上限静默降级成默认值。
 * @param {Record<string, number>} [roleLimits]
 * @returns {Record<string, number>}
 */
/**
 * 校验 provider 级并发上限：0（不限制）或 1~64 的整数。
 *
 * 与 validateConcurrencyLimit 的差别只有一个：0 是合法值。用独立函数而不是给
 * 旧函数加参数，是为了让「任务/角色上限不允许 0」这条既有契约保持逐字不变。
 *
 * @param {unknown} value - 待校验值。
 * @returns {{ok:boolean, value?:number, code?:string, message?:string}}
 */
export function validateProviderLimit(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, code: "INVALID_PROVIDER_LIMIT", message: "providerLimits 必须是 " + MIN_PROVIDER_LIMIT + "~" + MAX_PROVIDER_LIMIT + " 的整数" };
  }
  if (value < MIN_PROVIDER_LIMIT || value > MAX_PROVIDER_LIMIT) {
    return { ok: false, code: "INVALID_PROVIDER_LIMIT", message: "providerLimits 必须在 " + MIN_PROVIDER_LIMIT + "~" + MAX_PROVIDER_LIMIT + " 之间" };
  }
  return { ok: true, value };
}

/**
 * 把 providerLimits 配置规范化为干净的 provider -> limit 映射（票据 26）。
 *
 * 语义与 normalizeRoleLimits 一致：函数形式原样透传（每次派发读一次当前设置），
 * 静态映射逐条校验，非法条目抛错而不是静默降级成「不限制」——把写错的凭据式
 * 配置悄悄放开是比启动失败更糟的故障。
 *
 * @param {Record<string, number>|Function} [providerLimits] - provider 级上限映射。
 * @returns {Record<string, number>|Function}
 */
export function normalizeProviderLimits(providerLimits) {
  if (providerLimits === undefined || providerLimits === null) return {};
  if (typeof providerLimits === "function") return providerLimits;
  if (typeof providerLimits !== "object" || Array.isArray(providerLimits)) {
    throw new FanoutValidationError("INVALID_PROVIDER_LIMITS", "providerLimits 必须是 provider -> limit 的映射", { field: "providerLimits" });
  }
  const normalized = {};
  for (const [provider, limit] of Object.entries(providerLimits)) {
    if (provider.trim().length === 0) {
      throw new FanoutValidationError("INVALID_PROVIDER_LIMITS", "providerLimits 的 provider 键必须是非空字符串", { field: "providerLimits" });
    }
    const check = validateProviderLimit(limit);
    if (!check.ok) {
      throw new FanoutValidationError("INVALID_PROVIDER_LIMITS", "providerLimits." + provider + " 非法: " + check.message, { field: "providerLimits." + provider });
    }
    normalized[provider] = limit;
  }
  return normalized;
}

export function normalizeRoleLimits(roleLimits) {
  if (roleLimits === undefined || roleLimits === null) return {};
  // 函数形式是"每次新建父任务时读取当前 settings"的解析回调（见 createFanoutManager）。
  // 这里只校验形状，值本身由 normalizer 在提交/取用时归一化。
  if (typeof roleLimits === "function") return roleLimits;
  if (typeof roleLimits !== "object" || Array.isArray(roleLimits)) {
    throw new FanoutValidationError("INVALID_ROLE_LIMITS", "roleLimits 必须是 role -> limit 的映射", { field: "roleLimits" });
  }
  const normalized = {};
  for (const [role, limit] of Object.entries(roleLimits)) {
    const check = validateConcurrencyLimit(limit);
    if (!check.ok) {
      throw new FanoutValidationError("INVALID_ROLE_LIMITS", "roleLimits." + role + " 非法: " + check.message, { field: "roleLimits." + role });
    }
    normalized[role] = limit;
  }
  return normalized;
}

function normalizeWriteRoles(writeRoles) {
  if (writeRoles === undefined || writeRoles === null) return [];
  const list = Array.isArray(writeRoles) ? writeRoles : [writeRoles];
  return [...new Set(list.filter((role) => typeof role === "string" && role.length > 0))];
}

function normalizeShardId(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

/**
 * 校验并归一化单个 shard 的可选任务名称，失败时给出结构化错误。
 *
 * 名称只在 trim 之后使用，不改内部大小写与标点（避免破坏用户命名）。
 *
 * 语义（与项目其它可选字段一致：undefined/null 视为"未提供"）：
 * - undefined / null：合法，表示主代理没有为该分片命名；
 * - 非字符串（数字、布尔、对象、数组）：显式拒绝，绝不 String() 静默转换；
 * - 纯空白字符串：显式拒绝——分片代号回退只认"字段缺失"，空白名称是写错的输入；
 * - 非空字符串：trim 后按 UTF-8 字节判预算，超限同样以 INVALID_SHARD_NAME 整体拒绝。
 *
 * 全部失败分支统一使用 code=INVALID_SHARD_NAME：调用方按字段分支即可，不需要区分
 * "不是字符串"和"太长"两种拒绝原因；预算违规仍把结构化元数据带在 violation 里。
 *
 * @param {unknown} value - shard.name 原始值。
 * @param {string} field - 出错时回填给调用方的字段路径（如 shards[0].name）。
 * @returns {{ok:true, name?:string} | {ok:false, code:string, message:string, field:string, violation?:object}}
 */
function validateShardName(value, field) {
  const fail = (message) => ({ ok: false, code: "INVALID_SHARD_NAME", message, field });
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return fail(field + " 必须是字符串");
  const name = value.trim();
  if (name.length === 0) return fail(field + " 必须是非空字符串");
  const violation = budgetVerdict(
    "shard_name",
    MAX_SHARD_NAME_BYTES,
    measureUtf8Bytes(name),
    field,
    "把任务名称缩短成一句话级别的短标签",
  );
  // 预算通道的 message 只描述资源与体积，这里把字段路径补进去：多 shard 提交时
  // 光看"实测 N > 上限 M"无法定位是哪个分片的名称超限。
  if (violation !== null) return { ...violation, message: field + " " + violation.message };
  return { ok: true, name };
}

/**
 * 默认的 affectedPaths 冲突检查：只对写入 role 判定重叠。
 *
 * 只读 role（例如 explorer）的同角色分片读取同一批文件是正常并行，默认不判为冲突；
 * 只有出现在 writeRoles 中的 role 才禁止 affectedPaths 重叠。模块不做路径解析，
 * 只按传入的路径字符串做相等比较——需要目录/规范化语义时由 Host 注入自己的
 * conflictChecker。
 *
 * @param {object} [options]
 * @param {string[]} [options.writeRoles] - 需要禁止重叠的写入 role。
 * @returns {(input:{role:string, shard:object, otherShards:object[]}) => {conflict:boolean, shardIds?:string[], paths?:string[]}}
 */
export function createWriteRoleConflictChecker({ writeRoles = [] } = {}) {
  const writeRoleSet = new Set(normalizeWriteRoles(writeRoles));
  return function writeRoleConflictChecker({ role, shard, otherShards = [] } = {}) {
    const paths = Array.isArray(shard?.affectedPaths) ? shard.affectedPaths : [];
    if (!writeRoleSet.has(role) || paths.length === 0) return { conflict: false };
    for (const other of otherShards) {
      const otherPaths = Array.isArray(other?.affectedPaths) ? other.affectedPaths : [];
      if (otherPaths.length === 0) continue;
      const overlap = paths.filter((path) => otherPaths.includes(path));
      if (overlap.length === 0) continue;
      return {
        conflict: true,
        shardIds: [normalizeShardId(other.shardId), normalizeShardId(shard.shardId)].filter((id) => id.length > 0),
        paths: [...new Set(overlap)],
      };
    }
    return { conflict: false };
  };
}

/** 把注入 checker 的返回值（布尔或对象）统一成 {conflict, shardIds, paths}。 */
function normalizeConflict(verdict) {
  if (verdict === true) return { conflict: true };
  if (verdict === false || verdict === undefined || verdict === null) return { conflict: false };
  if (typeof verdict === "object") {
    return {
      conflict: verdict.conflict === true,
      shardIds: Array.isArray(verdict.shardIds) ? verdict.shardIds : undefined,
      paths: Array.isArray(verdict.paths) ? verdict.paths : undefined,
    };
  }
  return { conflict: false };
}

/**
 * 纯函数校验 submit 输入。校验失败返回结构化错误，绝不抛异常；
 * submit() 再把失败结果翻译成 FanoutValidationError，保证「非法输入整体拒绝」。
 *
 * shard 支持可选的 name（人类可读任务名称，如"实现添加任务名称"）：它是展示用的短
 * 标签，不参与受影响路径冲突判定，也不改变调度语义；缺失时保持旧行为（投影回退
 * shardId）。非法 name 与非法 shardId/prompt 一样整体拒绝，避免把写错的输入静默降级。
 *
 * @param {object} input - submit() 的原始入参。
 * @returns {{ok:true, role:string, basePrompt:string, shards:object[], requestId?:string, concurrencyLimit?:number, timeoutMs?:number, allowOverlap:boolean} | {ok:false, code:string, message:string, field?:string, conflict?:object}}
 */
export function validateSubmitInput(input) {
  const raw = input === null || typeof input !== "object" ? {} : input;
  const role = typeof raw.role === "string" ? raw.role.trim() : "";
  if (role.length === 0) {
    return { ok: false, code: "INVALID_ROLE", message: "role 必须是非空字符串", field: "role" };
  }
  const basePrompt = normalizeText(raw.basePrompt);
  if (basePrompt.trim().length === 0) {
    return { ok: false, code: "INVALID_BASE_PROMPT", message: "basePrompt 必须是非空字符串", field: "basePrompt" };
  }
  if (!Array.isArray(raw.shards) || raw.shards.length === 0) {
    return { ok: false, code: "INVALID_SHARDS", message: "shards 必须是非空数组", field: "shards" };
  }
  // 每个 task 的 shard 数必须有界：快照、事件与 attempt 历史都按 shard 线性增长。
  const shardCountViolation = budgetVerdict("shards", FANOUT_BUDGET.maxShardsPerTask, raw.shards.length, "shards");
  if (shardCountViolation !== null) return shardCountViolation;

  const seen = new Set();
  const shards = [];
  for (let index = 0; index < raw.shards.length; index += 1) {
    const rawShard = raw.shards[index];
    const field = "shards[" + index + "]";
    if (rawShard === null || typeof rawShard !== "object" || Array.isArray(rawShard)) {
      return { ok: false, code: "INVALID_SHARD", message: field + " 必须是对象", field };
    }
    const shardId = normalizeShardId(rawShard.shardId);
    if (shardId.length === 0) {
      return { ok: false, code: "INVALID_SHARD_ID", message: field + ".shardId 必须是非空字符串", field: field + ".shardId" };
    }
    // 可选任务名称：分片代号之后立刻判定，保证非法名称与非法 shardId 一样走
    // "整体拒绝、不登记任务、不创建 child"的原子校验路径。
    const nameVerdict = validateShardName(rawShard.name, field + ".name");
    if (!nameVerdict.ok) return nameVerdict;
    if (seen.has(shardId)) {
      return { ok: false, code: "DUPLICATE_SHARD_ID", message: "duplicate shardId: " + shardId, field: field + ".shardId" };
    }
    seen.add(shardId);
    const prompt = normalizeText(rawShard.prompt);
    if (prompt.trim().length === 0) {
      return { ok: false, code: "INVALID_SHARD_PROMPT", message: field + ".prompt 必须是非空字符串", field: field + ".prompt" };
    }
    let affectedPaths;
    if (rawShard.affectedPaths !== undefined) {
      if (!Array.isArray(rawShard.affectedPaths) || rawShard.affectedPaths.some((path) => typeof path !== "string")) {
        return { ok: false, code: "INVALID_AFFECTED_PATHS", message: field + ".affectedPaths 必须是字符串数组", field: field + ".affectedPaths" };
      }
      affectedPaths = [...rawShard.affectedPaths];
    }
    // 分片级超时覆盖（票据 06）：与父任务默认值/角色默认值共用同一校验语义。
    // 0 是合法的「显式禁用」，不能被当成非法输入拒绝（否则无法用分片覆盖父任务的默认超时）。
    const timeoutVerdict = validateTimeoutMs(rawShard.timeoutMs, field + ".timeoutMs");
    if (!timeoutVerdict.ok) return timeoutVerdict;
    const timeoutMs = timeoutVerdict.value;
    shards.push({
      shardId,
      prompt,
      // 名称缺失时完全不出现该字段：旧 Host / 旧快照读取方看到的是原有形状。
      ...(nameVerdict.name === undefined ? {} : { name: nameVerdict.name }),
      ...(affectedPaths === undefined ? {} : { affectedPaths }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  // 输入预算：basePrompt 与每个 shard 的正文共用同一上限。超限必须显式拒绝——
  // 截断后派发会让专家基于不完整目标工作，属于静默丢输入。
  for (let index = 0; index < shards.length; index += 1) {
    const inputCheck = checkTaskInputBudget({
      basePrompt,
      shardPrompt: shards[index].prompt,
      subject: "shards[" + index + "]",
    });
    if (inputCheck.ok) continue;
    return {
      ok: false,
      code: "INVALID_BUDGET",
      message: inputCheck.violation.message,
      field: "shards[" + index + "].prompt",
      violation: inputCheck.violation,
    };
  }

  let concurrencyLimit;
  if (raw.concurrencyLimit !== undefined && raw.concurrencyLimit !== null) {
    const check = validateConcurrencyLimit(raw.concurrencyLimit);
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message, field: "concurrencyLimit" };
    }
    concurrencyLimit = check.value;
  }

  // 父任务默认超时（票据 06）：只固化**显式**给出的值，未设置时
  // 留给角色级默认值动态解析（快照里不出现该字段）。
  const taskTimeoutVerdict = validateTimeoutMs(raw.timeoutMs, "timeoutMs");
  if (!taskTimeoutVerdict.ok) return taskTimeoutVerdict;
  const timeoutMs = taskTimeoutVerdict.value;

  /**
   * 任务级 provider 归属（票据 26 背压）。
   *
   * 由组合根在提交前按「会话覆盖优先、其次全局默认」解析出主选择的 provider 传入，
   * 用来建立 provider 级并发计数（同一任务的所有 running 分片都记到该 provider 名下）。
   *
   * 缺失是**合法**的：角色尚未配置主模型时无法确定 provider，此时 provider 限流不
   * 生效，但角色级/任务级限流照常生效（绝不因为无法归属就把任务拒绝）。
   *
   * 已知边界（规格书记录）：候选 fallback 可能在启动时换成别的 provider，本期仍按
   * 任务提交时的主 provider 记账，不按每次 admission 的实际 provider 重新分摊——
   * 那会需要「运行中迁移名额」的额外语义，属于后续票据范围。
   */
  let provider;
  if (raw.provider !== undefined && raw.provider !== null) {
    if (typeof raw.provider !== "string" || raw.provider.trim().length === 0) {
      return { ok: false, code: "INVALID_PROVIDER", message: "provider 必须是非空字符串", field: "provider" };
    }
    provider = raw.provider.trim();
  }

  let requestId;
  if (raw.requestId !== undefined && raw.requestId !== null) {
    if (typeof raw.requestId !== "string" || raw.requestId.trim().length === 0) {
      return { ok: false, code: "INVALID_REQUEST_ID", message: "requestId 必须是非空字符串", field: "requestId" };
    }
    requestId = raw.requestId;
  }

  return {
    ok: true,
    role,
    basePrompt,
    shards,
    ...(requestId === undefined ? {} : { requestId }),
    ...(concurrencyLimit === undefined ? {} : { concurrencyLimit }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(provider === undefined ? {} : { provider }),
    allowOverlap: raw.allowOverlap === true,
  };
}

/** 把校验失败结果翻译成 FanoutValidationError。 */
function validationError(verdict) {
  return new FanoutValidationError(verdict.code, verdict.message, {
    ...(verdict.field === undefined ? {} : { field: verdict.field }),
    ...(verdict.conflict === undefined ? {} : { conflict: verdict.conflict }),
    // 预算拒绝必须把结构化违规元数据一并带出（code/resource/receivedBytes/maxBytes）。
    ...(verdict.violation === undefined ? {} : { violation: verdict.violation }),
    // 容量拒绝的可执行字段（当前任务数 / 可回收数）同样摊到错误顶层。
    ...(verdict.current === undefined ? {} : { current: verdict.current }),
    ...(verdict.reclaimable === undefined ? {} : { reclaimable: verdict.reclaimable }),
  });
}

/**
 * 把预算违规翻译成 submit 校验失败结果。
 * 输入超限不能截断后继续执行，因此这里走"整体拒绝"通道（不登记任务、不建 child）。
 *
 * @param {string} resource - 预算资源名（tasks / shards / attempts）。
 * @param {number} limit - 上限。
 * @param {number} receivedBytes - 本次实测数量/体积。
 * @param {string} field - 出错的字段路径。
 * @param {string} [hint] - 可执行提示。
 * @param {object} [extra] - 额外合并进 violation 的结构化字段（例如容量拒绝的
 *   current / reclaimable）。违规对象是冻结的，因此这里复制成新对象再合并。
 */
function budgetVerdict(resource, limit, receivedBytes, field, hint, extra) {
  const check = checkBudget({ resource, limit, receivedBytes, subject: field, recoverable: true, hint });
  if (check.ok) return null;
  const violation = extra !== undefined && extra !== null && typeof extra === "object"
    ? Object.freeze({ ...check.violation, ...extra })
    : check.violation;
  return {
    ok: false,
    code: "INVALID_BUDGET",
    // 容量类拒绝把可执行提示并入顶层 message：工具调用方通常只展示 message，
    // 提示必须在那里可见（hint 字段仍保留在 violation 中供结构化消费者使用）。
    message: extra !== undefined && violation.hint !== undefined
      ? violation.message + "（" + violation.hint + "）"
      : violation.message,
    field,
    violation,
    // 容量类拒绝同时把可执行字段摊到错误顶层：工具层/诊断面不必再解析 violation。
    ...(violation.current === undefined ? {} : { current: violation.current }),
    ...(violation.reclaimable === undefined ? {} : { reclaimable: violation.reclaimable }),
  };
}

/**
 * 创建一个 fan-out 管理器。
 *
 * @param {object} options
 * @param {(input:{parentTaskId:string, role:string, basePrompt:string, shardId:string, name?:string, prompt:string, affectedPaths?:string[], timeoutMs?:number, attempt:number}) => (object|Promise<object>)} options.launcher
 *   shard 启动器。返回值可以是 child 句柄（childId/messageId 可选）或直接返回 Promise；
 *   句柄可携带 completion Promise 表示 child 的终态。返回值/句柄都是启动结果，不影响
 *   任务状态归属（状态只存在本模块内，不绑定单个 childId）。
 * @param {(input:{parentTaskId:string, role:string, basePrompt:string, shardId:string, attempt:number, childId:string, prompt:string}) => (object|Promise<object>)} [options.continuer]
 *   多轮 continuation 的续作启动器：与 launcher 同形，但必须把新一轮 prompt 投递给**同一
 *   child**（input.childId），返回值句柄的 completion 表示该轮 child 终态。缺失时
 *   continueTask 一律结构化拒绝（fail-closed，不新建 attempt）。
 * @param {(input:{parentTaskId:string, shardId:string, attempt:number, childId?:string, reason:string, handle?:object}) => (void|Promise<unknown>)} [options.canceller]
 *   取消器。调用后由 child 的 completion 收敛为 cancelled，因此取消是「立即接受 + 异步收敛」。
 * @param {{now:()=>number, setTimeout:(fn:Function,ms:number)=>unknown, clearTimeout:(handle:unknown)=>void}} [options.clock]
 *   可注入时钟；默认使用全局 Date/timers。
 * @param {{save?:(snapshot:object)=>unknown}} [options.persistence]
 *   持久化回调。每次状态变化后收到一份深拷贝、可 JSON 序列化的快照。
 * @param {(input:{role:string, shard:object, otherShards:object[]}) => (boolean|object)} [options.conflictChecker]
 *   冲突检查函数。未提供时使用 createWriteRoleConflictChecker(writeRoles)。
 * @param {(input:{role:string, shard:object, otherShards:object[]}) => void} [options.conflictObserver]
 *   可选的只读观测 seam；异常会被忽略，不参与调度决策，供固定基准记录候选规模。
 * @param {string[]} [options.writeRoles] - 需要禁止 affectedPaths 重叠的写入 role。
 * @param {boolean} [options.allowOverlap] - 全局放行 affectedPaths 重叠（提交级 allowOverlap 优先）。
 * @param {number|Function} [options.concurrencyLimit] - 默认 per-role 并发上限；传函数时按
 *   「每次新建父任务读取一次当前配置」的动态默认值解析（Host 用它接入插件 settings）。
 * @param {Record<string, number>|Function} [options.roleLimits] - role 级并发上限覆盖；函数形式
 *   返回 {role: limit}，缺失 role 落到默认值。函数返回值里的非法条目一律回退默认值，
 *   绝不让 scheduler 拿到 NaN/负数/越界值。
 * @param {Record<string, number>|Function} [options.providerLimits] - provider 级并发上限
 *   （票据 26）：{provider: 1..64}；0 或缺失表示不限制。函数形式按「每次派发读一次当前
 *   设置」解析，用途与 concurrencyLimit/roleLimits 相同（设置保存后立即约束后续派发）。
 *   名额只在分片真正进入 running 时占用，排队不占名额、也不做预留。
 * @param {number|Function} [options.roleTimeoutMs] - 角色级默认超时（毫秒，票据 06）。
 *   传函数时按「每次新建 attempt 读一次当前 settings」动态解析（Host 用它接入
 *   settings.roleTimeoutMs）；0 表示角色级显式禁用。优先级：shard 显式 > 父任务默认
 *   > 本项 > 未启用；只影响之后创建的 attempt。
 * @param {number} [options.maxSnapshotBytes] - 单份快照字节上限覆盖（默认取 FANOUT_BUDGET）。
 * @returns {object} fan-out 管理器公共接口。
 */
export function createFanoutManager(options = {}) {
  if (options === null || typeof options !== "object") {
    throw new FanoutValidationError("INVALID_OPTIONS", "createFanoutManager 需要配置对象");
  }
  const {
    launcher,
    continuer,
    canceller,
    clock,
    persistence,
    conflictChecker: injectedConflictChecker,
    conflictObserver,
    roleLimits: rawRoleLimits,
    providerLimits: rawProviderLimits,
    concurrencyLimit: rawConcurrencyLimit,
    roleTimeoutMs: rawRoleTimeoutMs,
    stopGraceMs: rawStopGraceMs,
  } = options;
  if (typeof launcher !== "function") {
    throw new FanoutValidationError("INVALID_LAUNCHER", "必须注入 launcher 函数");
  }
  if (continuer !== undefined && continuer !== null && typeof continuer !== "function") {
    throw new FanoutValidationError("INVALID_CONTINUER", "continuer 必须是函数");
  }
  if (canceller !== undefined && canceller !== null && typeof canceller !== "function") {
    throw new FanoutValidationError("INVALID_CANCELLER", "canceller 必须是函数");
  }
  if (persistence !== undefined && persistence !== null && typeof persistence.save !== "function") {
    throw new FanoutValidationError("INVALID_PERSISTENCE", "persistence.save 必须是函数");
  }
  if (conflictObserver !== undefined && conflictObserver !== null && typeof conflictObserver !== "function") {
    throw new FanoutValidationError("INVALID_CONFLICT_OBSERVER", "conflictObserver 必须是函数");
  }
  const now = typeof clock?.now === "function" ? clock.now : () => Date.now();
  const setTimeoutFn = typeof clock?.setTimeout === "function" ? clock.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearTimeoutFn = typeof clock?.clearTimeout === "function" ? clock.clearTimeout : (handle) => clearTimeout(handle);

  /**
   * 停止宽限期（票据 07）：只驱动"停止未确认"看门狗，不改变逻辑状态。
   *
   * 非法值必须在构造期显式失败（配置写错不能静默回退），合法值为 0 或正有限数：
   * 0 表示看门狗立即到期（仅测试/极端配置使用）。
   */
  const stopGraceMs = rawStopGraceMs === undefined || rawStopGraceMs === null
    ? STOP_GRACE_MS
    : (() => {
        if (typeof rawStopGraceMs !== "number" || !Number.isFinite(rawStopGraceMs) || rawStopGraceMs < 0) {
          throw new FanoutValidationError("INVALID_STOP_GRACE", "stopGraceMs 必须是 0 或正有限数", { field: "stopGraceMs" });
        }
        return rawStopGraceMs;
      })();

  // 默认并发上限既可以是静态整数，也可以是"每次解析都读取一次"的解析函数。
  // 函数形式接入插件 settings 的 roleConcurrencyLimit：静态非法值必须在构造期显式
  // 失败（配置写错不能静默降级），函数返回值则按归一化规则回退默认值——settings 里
  // 的旧配置/非法值不能污染调度器。
  //
  // 来源模型（票据 03「并发来源修复」）：
  // - 构造期注入函数 ⇒ live：**始终**跟随当前设置，restore 绝不允许把来源改成
  //   snapshot。否则一次重启就会把"当前设置"永久旁路，设置页与真实并发脱节；
  // - 没有注入函数 ⇒ snapshot：使用构造时的静态值或恢复出来的快照值。这类进程读不到
  //   "当前设置"，只能冻结最后一次已知值，并在诊断里如实标注 snapshot。
  // 任务级显式 concurrencyLimit 是另一层，始终优先且随任务快照固化，不受本条影响。
  const hasLiveConcurrencyResolver = typeof rawConcurrencyLimit === "function";
  let defaultConcurrencyLimit = typeof rawConcurrencyLimit === "function"
    ? DEFAULT_CONCURRENCY_LIMIT
    : (rawConcurrencyLimit === undefined
      ? DEFAULT_CONCURRENCY_LIMIT
      : (() => {
          const check = validateConcurrencyLimit(rawConcurrencyLimit);
          if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "concurrencyLimit" });
          return check.value;
        })());
  /**
   * 角色级默认超时（票据 06）：number | 解析函数 | undefined。
   *
   * 与并发上限的模式一致：
   * - 函数形式是「每次新建 attempt 时读一次当前 settings」的动态来源；
   * - 静态值在构造期显式校验（配置写错必须立刻失败）；
   * - 函数返回非法值/抛错时只能降级为「未启用」——超时配置
   *   错误不能让派发抛错；
   * - 0 是合法的「角色级显式禁用」，会原样作为解析结果传递。
   */
  const staticRoleTimeoutMs = typeof rawRoleTimeoutMs === "function" || rawRoleTimeoutMs === undefined || rawRoleTimeoutMs === null
    ? undefined
    : (() => {
        const check = validateTimeoutMs(rawRoleTimeoutMs, "roleTimeoutMs");
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "roleTimeoutMs" });
        return check.value;
      })();
  /**
   * 默认上限的权威来源：live（读取注入的解析函数）或 snapshot（冻结值）。
   *
   * live 一旦存在就永远是 live：restore 绝不会把 live 降级成 snapshot。snapshot 在
   * restore 后仍然是 snapshot（可能换值，但来源不变）——没有解析函数的进程无法凭空
   * 获得"当前设置"。快照里的 defaultConcurrencyLimit 因此只作为诊断负载保留（见
   * buildSnapshotPayload 的 concurrencySource 标记），不再覆盖当前设置。
   */
  let resolverSource = hasLiveConcurrencyResolver ? "live" : "snapshot";
  /**
   * 最近一次解析得到的有效默认上限；从未解析时等于构造/恢复值。
   *
   * 写进快照用于诊断（让外部看到"上次解析出的值"），也用于没有 live resolver 的
   * 消费者恢复到最后一次已知值。它不参与 live 调度决策——live 每次都重新解析，因此
   * 真正的权威值始终由 concurrencyLimits()/调度读取，而不是这个诊断快照字段。
   */
  let lastResolvedDefaultConcurrencyLimit = defaultConcurrencyLimit;
  let roleLimits = normalizeRoleLimits(rawRoleLimits);
  /**
   * provider 级映射（票据 26）：与 roleLimits 完全同构的来源模型。
   * 函数形式 = live（每次派发读当前 settings）；静态映射 = snapshot（恢复时被快照替换）。
   */
  let providerLimits = normalizeProviderLimits(rawProviderLimits);
  /**
   * 恢复出来的显式角色级映射，仅当构造时 roleLimits 是 live 解析函数时作为第二层
   * 回退：当前 settings 解析值 > 快照显式映射 > 安全默认值。静态 roleLimits 不走这里
   * （restore 直接替换静态映射，保持既有语义）。
   */
  let restoredRoleLimitOverrides = Object.freeze({});
  /**
   * 恢复出来的显式 provider 级映射：与 restoredRoleLimitOverrides 同构，
   * 只在 live provider 解析函数没有给出该 provider 的合法值时补位。
   */
  let restoredProviderLimitOverrides = Object.freeze({});
  /**
   * 解析函数返回非法值时的诊断：按 kind 分别保存，**解析成功后清除对应条目**。
   *
   * 用 Map 而不是单个变量：默认上限与角色级映射是两条独立解析路径，其中一条恢复
   * 正常时不能抹掉另一条仍然有效的非法诊断。对外只暴露最近一次记录，保持既有单字段契约。
   */
  const invalidLimitDiagnostics = new Map();
  /** 最近一次被记录的非法 kind；null 表示当前没有非法诊断。 */
  let lastInvalidLimitKind = null;
  let writeRoles = normalizeWriteRoles(options.writeRoles);
  let defaultAllowOverlap = options.allowOverlap === true;
  /**
   * 预算策略：默认全部取自 resource-budget.js 的冻结值；maxSnapshotBytes 可在
   * 组合根/测试里收紧，用于验证"超限不落盘"的显式拒绝路径。
   */
  const budgetPolicy = Object.freeze({
    ...FANOUT_BUDGET,
    ...(Number.isSafeInteger(options.maxSnapshotBytes) && options.maxSnapshotBytes > 0
      ? { maxSnapshotBytes: options.maxSnapshotBytes }
      : {}),
  });
  /**
   * 最近一次预算违规（只读诊断；不参与调度决策）。
   *
   * 违规以"结构化描述 + 发生阶段"两部分保存：violation 与错误/事件/RPC 响应同源，
   * phase 说明是哪条入口拒绝的（submit/retry/continue/attempt/event/snapshot/persist/
   * serialize/restore/feedback），诊断消费者不需要解析文案就能分类。
   */
  let lastBudgetViolation = null;
  let lastBudgetViolationPhase = null;
  /**
   * budget_rejected 事件的递归闸：事件本身超预算时必须只发诊断事件，
   * 绝不再为"预算事件超预算"继续发预算事件（否则就是无限反馈）。
   */
  let budgetEventDepth = 0;
  /** 事件历史累计被裁剪的条数（进程生命周期内，供 gap 诊断）。 */
  let droppedEventCount = 0;
  /**
   * 最近一次落盘结果（只读诊断）：saved / skipped(reason) / failed(category)。
   *
   * 失败分类的权威仍是 Host 的 persistence-health（容量/瞬态/代次/永久）；
   * 这里只记录 manager 能直接观察到的事实（是否调用 save、跳过原因、实测字节），
   * 两者在诊断面合并展示，不互相覆盖。
   */
  let lastPersistResult = null;
  /** persistSnapshot 的调用序号：异步 save 的迟到结果不得覆盖更新的结果。 */
  let persistSequence = 0;
  let lastPersistResultTicket = 0;
  const usesDefaultConflictChecker = typeof injectedConflictChecker !== "function";
  let conflictChecker = usesDefaultConflictChecker
    ? createWriteRoleConflictChecker({ writeRoles })
    : injectedConflictChecker;

  /** 父任务表：parentTaskId -> 内部任务状态。 */
  const tasks = new Map();
  /** requestId 去重索引：requestId -> parentTaskId。 */
  const requestIndex = new Map();
  /**
   * continuation 幂等派生索引：requestId -> parentTaskId。
   *
   * 真相源是**每个任务自己的** `task.continuationRequests`（随快照持久化、restore 时恢复），
   * 这里只是从 tasks 重建出来的查询索引，用来回答「这个 requestId 是否已被**别的**父任务
   * 用过」。因此：
   * - 不做任何淘汰：单任务可记录的 requestId 数受 attempt 预算约束（每成功续作一轮至少消耗
   *   一个 attempt，`maxAttemptsPerShard` 封顶），总量受 maxTasks × 该上限约束；
   * - restore 后由 `rebuildIndexes()` 重建，重启不丢幂等键；
   * - 任务被显式清理（close/释放）时随之消失。
   */
  const continuationRequestOwners = new Map();
  /**
   * 显式回收的两阶段屏障状态（票据 05）：null 表示没有回收在途。
   *
   * 形状：{ token, parentTaskIds:Set<string>, candidate, bytes }。
   * - prepareReclaim 设置它并生成候选快照；
   * - Host 必须先 persist(candidate) 成功，再 commitReclaim；失败只能 abortReclaim；
   * - 屏障期间公开写入口返回 reclaim_in_progress，调度暂停，因此"落盘的候选"与
   *   commit 时的内存状态在任务集合上必然一致；
   * - token 单调递增且不可复用，迟到的 commit/abort 不会命中新的回收；
   * - close 不清空它：候选可能正在 Host 侧 await 落盘，只有保留屏障才能让关闭后的
   *   commit/abort 继续按同一 token 生效（否则磁盘已排除任务、内存仍保留，二者分叉）。
   */
  let reclaimState = null;
  let reclaimSequence = 0;
  /**
   * 已回收任务 id 的有界集合：**只**用于识别迟到回调，不是查询墓碑。
   *
   * 为什么需要它：回收后任务对象已从 tasks 删除，晚到的停止证据/归属老化按 id 查不到
   * 任务；若直接返回 unknown_attempt，调用方无法区分"身份过期"与"任务已回收"。
   * 这里只回答"这个 id 最近被回收过"，不携带任何任务数据、不参与任何查询/权限判定，
   * 且同 id 被重新登记（显式 parentTaskId / restore）时立即移除，避免误伤新任务。
   * 有界：只保留最近 RECLAIMED_TASK_MEMORY 个 id（插入序淘汰）。
   */
  const reclaimedTaskIds = new Set();
  const RECLAIMED_TASK_MEMORY = 256;
  /**
   * 调度热路径索引：保持 tasks Map 的注册顺序，同时避免每轮派发重新 filter 全部父任务。
   * 该索引是派生状态，restore 时从 tasks 重新构建，不写入快照。
   */
  const parentsByRole = new Map();
  /**
   * role 共享池的 running 计数：role -> 该 role 下**所有**父任务的 running 分片数。
   * 受 role 级设置（roleLimits / 默认值）约束，是"共享池"语义的唯一计数来源。
   */
  const runningCountsByRole = new Map();
  /**
   * 任务级 running 计数：key 是任务对象身份，value 是该父任务自身的 running 分片数。
   *
   * 与 runningCountsByRole 并存的第二个计数维度：任务级 concurrencyLimit 只允许约束
   * 「自己这个父任务」的并发，不能拿 role 全局计数去比较，否则一个低上限任务会因为别的
   * 父任务占着 role 槽位而永远派发不出去。
   * key 用对象身份而不是 parentTaskId 字符串：与 activeShardEntries 同理，避免任意字符
   * 拼接碰撞，也免去在任务销毁时按 id 反查的开销（计数随任务对象一起被 GC 回收）。
   * 该索引是派生状态，restore 时由 rebuildIndexes() 从 tasks 重新构建，不写入快照。
   */
  const runningCountsByTask = new Map();
  /**
   * provider 共享池的 running 计数（票据 26）：provider -> 该 provider 下**所有**父任务
   * 的 running 分片数。
   *
   * 与 runningCountsByRole 同源同点更新（唯一调用点 addRunningCount）：provider 是跨
   * 角色的共享资源，多个角色可能同时打爆同一 provider，因此不能按 role 聚合，也不能
   * 复用任务级计数。只统计**任务级 provider 归属**（task.provider）下的 running 分片；
   * 没有归属的任务不进入任何 provider 池（provider 限流对它们不生效）。
   *
   * 该索引是派生状态：restore 时由 rebuildIndexes() 从 tasks 重建，不写入快照。
   */
  const runningCountsByProvider = new Map();
  /**
   * 影响范围索引（票据 07）：key 使用 **attempt 对象身份**，而不是 shard。
   *
   * 为什么必须按 attempt：超时/取消的旧 attempt 可能仍未停止，此时 shard 已经允许重试；
   * 若按 shard 建索引，新 attempt 会覆盖旧 entry，旧 child 的迟到写入就失去了路径保护。
   * 按 attempt 建索引后，每个未确认停止的 attempt 各自占位，直到它自己 observed。
   *
   * 条目标从 shard 进入 queued 起就登记（范围预留先于执行），释放条件只有一个：
   * 该 attempt 已进入逻辑终态 **且** stopEvidence 已 observed。
   * key 用对象身份而不是字符串拼接，避免 parentTaskId/shardId 中的任意字符发生碰撞。
   */
  const activeShardEntries = new Map();
  const activeShardsByPath = new Map();
  let nextActiveOrder = 0;
  /**
   * attempt 执行代次计数器（票据 07）。
   *
   * 每次新建 attempt 递增；它随快照持久化，恢复时取「快照计数器」与「全部 attempt 的最大
   * 代次」中的较大值再加一，因此恢复后新建的代次一定大于所有历史代次。迟到/串代的停止
   * 证据靠它做精确隔离（配合 attemptId，二者任一不匹配就拒绝，且不产生状态变更）。
   */
  let nextExecutionGeneration = 0;
  /** 最近一次停止看门狗到期（只读诊断；不进快照、不影响调度）。 */
  let lastStopWatchdog = null;
  /**
   * 最近一次 restore 使用的停止证据边界（只读诊断）。
   *
   * boundarySource 说明这个值是显式给出（explicit）还是按进程身份自动判定
   * （process-instance），让诊断能区分"Host 明确选择了边界"与"自动推断"。
   */
  const stopDiagnosticsState = {
    boundary: /** @type {"unknown"|"process-restart"} */ ("unknown"),
    boundarySource: /** @type {"explicit"|"process-instance"} */ ("process-instance"),
  };
  /** 最近一次归属老化（只读诊断；不进快照、不影响调度）。 */
  let lastAttributionAged = null;
  /** 事件订阅者。 */
  const subscribers = new Set();
  /** 每个 role 的派发轮转游标，用于父任务间公平轮转。 */
  const rotationCursors = new Map();
  /**
   * 限流统计（票据 26）：kind(role|provider) -> 键 -> 时间戳与历史等待样本。
   *
   * 只服务诊断：名额是否可用始终由 running 计数与 limits 决定，这里的历史平均**不**
   * 参与任何调度决策。样本定义是「一次限流窗口开始（第一次被挡住）→ 该键下真正派发
   * 成功」的墙钟时长；少于 THROTTLE_ETA_MIN_SAMPLES 时不提供 etaMs。
   */
  const throttleStats = {
    role: new Map(),
    provider: new Map(),
  };

  let sequence = 0;
  let nextTaskNumber = 0;
  // 事件与任务快照一起持久化，重启后仍可按 sequence 续读；仅保留 bounded 历史。
  // 条数上限（1000，既有契约）与字节上限都来自 budgetPolicy，见 trimEventHistory()。
  const eventHistory = [];
  /**
   * 事件历史的增量字节记账（与 eventHistory 同序、同长）。
   *
   * 每条事件只在进入历史时测量一次，裁剪时只丢弃最旧一端；不再像旧实现那样每次 emit
   * 都对整段历史逐条 stringify（O(n²)）。判定规则完全复用 resource-budget 的记账器，
   * 与 checkEventHistoryBudget 同源。
   */
  const eventAccounting = createEventHistoryAccounting({
    maxCount: budgetPolicy.maxEventHistory,
    maxBytes: budgetPolicy.maxEventHistoryBytes,
  });
  // 调度器状态：
  // - workRequested：有派发请求还没被 drain 处理完；
  // - drainScheduled：已经排好一次 drain 微任务；
  // - resolveDrain：drainPromise 的 resolve，只在最后一次 drain 结束时调用。
  let workRequested = false;
  let drainScheduled = false;
  // restore 默认只重建状态；直到新的 submit/retry 或 resume 调度显式到来前，
  // 任何已经排队的旧 drain 都不得偷偷启动恢复队列。
  let restoreDispatchSuppressed = false;
  // restore 只重建逻辑状态；禁止 aggregateTask 在恢复时重复发布 task_settled。
  let restoringSnapshot = false;
  let closed = false;
  let resolveDrain;
  let drainPromise = Promise.resolve();

  // -------------------------------------------------------------------------
  // 事件与持久化
  // -------------------------------------------------------------------------

  /**
   * 发布一条事件。监听器抛错只影响自己，不能破坏调度。
   *
   * 单事件字节预算：原始负载过大时只发布"不含负载"的诊断事件，既不让事件历史
   * 无界增长，也不静默丢失事实（诊断保留 type/subject/resource 与实测字节）。
   *
   * 性能：内容与体积来自同一次 stringify；进入历史时把字节数交给增量记账器，
   * 之后不再对整段历史重复测量（旧的 O(n²) 测量已在票据 04 移除）。
   */
  function emit(event) {
    const candidate = { ...event, sequence: ++sequence, at: now() };
    // 单次序列化同时得到"内容"（parse 回来作为历史条目）与"体积"（单事件预算 +
    // 事件历史增量记账）。serialized=null 表示不可 JSON 序列化。
    let serialized;
    try {
      serialized = JSON.stringify(candidate);
    } catch {
      serialized = null;
    }
    const candidateBytes = serialized === null ? null : Buffer.byteLength(serialized, "utf8");
    const verdict = checkBudget({
      resource: "event",
      limit: budgetPolicy.maxEventBytes,
      receivedBytes: candidateBytes,
      subject: candidate.type,
    });
    if (!verdict.ok) {
      // 事件超预算只发布不含原始负载的诊断事件。这里刻意**不**补发 budget_rejected：
      // 事件预算是热路径，"为超预算事件再发一条事件"会递归放大历史。
      noteBudgetViolation(verdict.violation, "event", { emitEvent: false });
      const diagnostic = {
        type: "event_budget_exceeded",
        subject: typeof candidate.type === "string" ? candidate.type : "event",
        parentTaskId: candidate.parentTaskId,
        violation: verdict.violation,
        sequence,
        at: now(),
      };
      appendEvent(diagnostic);
      notifyEventSubscribers(diagnostic);
      return diagnostic;
    }
    const stored = JSON.parse(serialized);
    appendEvent(stored, candidateBytes);
    notifyEventSubscribers(stored);
    return candidate;
  }

  /** 通知事件订阅者；单个订阅者异常必须被隔离，不能破坏调度。 */
  function notifyEventSubscribers(event) {
    for (const listener of [...subscribers]) {
      try {
        listener(cloneJson(event));
      } catch {
        // 订阅者异常必须被隔离：fan-out 的调度语义不依赖任何监听器。
      }
    }
  }

  /**
   * 追加事件并维护历史预算（条数 + 字节）。
   *
   * 事件对象进入历史后不再变更，因此 size 只测一次；trim 只从最旧一端丢弃，
   * 成本与丢弃条数成正比。裁剪本身不发布 budget_rejected（它由每条新事件触发，
   * 发事件会形成"事件→裁剪→事件"的无限反馈）；事实通过 dropped/最早序号暴露。
   */
  function appendEvent(event, knownBytes) {
    const bytes = knownBytes === undefined ? (measureJsonBytes(event) ?? 0) : knownBytes;
    eventHistory.push(event);
    eventAccounting.push(bytes);
    trimEventHistory();
  }

  /**
   * 记录预算违规（只读诊断 + 可选的结构化 budget_rejected 事件）。
   *
   * 统一事件契约（所有运行期入口共用）：
   * - type=budget_rejected、phase、violation（与错误/RPC 同源的结构化描述）；
   * - parentTaskId/subject 可选；sequence/at 由 emit 统一补齐；
   * - 事件只带元数据，绝不复述被拒绝的 prompt/result/error 原文或完整快照。
   *
   * @param {object} violation - describeBudgetViolation 产出的违规描述。
   * @param {string} phase - submit/retry/continue/attempt/event/snapshot/persist/serialize/restore/feedback。
   * @param {{emitEvent?:boolean, parentTaskId?:string}} [options]
   */
  function noteBudgetViolation(violation, phase = "runtime", { emitEvent = true, parentTaskId } = {}) {
    if (violation === null || violation === undefined) return;
    lastBudgetViolation = cloneJson(violation);
    lastBudgetViolationPhase = phase;
    if (!emitEvent) return;
    emitBudgetRejected(violation, phase, parentTaskId);
  }

  /** 发布一条 budget_rejected 事件（带递归闸；裁剪/事件预算路径以 emitEvent:false 跳过）。 */
  function emitBudgetRejected(violation, phase, parentTaskId) {
    if (budgetEventDepth > 0) return;
    budgetEventDepth += 1;
    try {
      emit({
        type: "budget_rejected",
        phase,
        violation: cloneJson(violation),
        ...(typeof parentTaskId === "string" && parentTaskId.length > 0 ? { parentTaskId } : {}),
        ...(typeof violation?.subject === "string" && violation.subject.length > 0 ? { subject: violation.subject } : {}),
      });
    } finally {
      budgetEventDepth -= 1;
    }
  }

  /**
   * 事件历史的条数/字节双预算：条数保留既有 1000 条契约，字节超出时继续丢弃最旧
   * 记录。两条预算同时生效，结果取更小的保留集合。
   */
  function trimEventHistory() {
    const verdict = eventAccounting.trim();
    if (verdict.droppedCount === 0) return;
    eventHistory.splice(0, verdict.droppedCount);
    droppedEventCount += verdict.droppedCount;
    noteBudgetViolation(verdict.violation, "event", { emitEvent: false });
  }

  /** 事件历史中最早仍可读的 sequence；空历史返回 null。 */
  function earliestAvailableSequence() {
    return eventHistory.length === 0 ? null : eventHistory[0].sequence ?? null;
  }

  /**
   * 整体替换事件历史后重建增量记账（restore 冷路径）。
   *
   * 每条事件只在这里测量一次；此后 emit 的增量记账与预算判定仍走同一套记账器，
   * 不会因为恢复而出现第二套字节口径。
   */
  function rebuildEventAccounting() {
    eventAccounting.reset();
    for (const event of eventHistory) eventAccounting.push(measureJsonBytes(event) ?? 0);
  }

  /** 事件历史只读状态：条数/字节/累计丢弃/最早可用序号（gap 判定用）。 */
  function eventHistoryStatus() {
    return Object.freeze({
      count: eventHistory.length,
      bytes: eventAccounting.bytes,
      dropped: droppedEventCount,
      earliestSequence: earliestAvailableSequence(),
    });
  }

  function emitShardStatus(task, shard, status, attempt, extra = {}) {
    return emit({
      type: "shard_status_changed",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt,
      status,
      role: task.role,
      counts: computeCounts(task),
      ...extra,
    });
  }

  /**
   * 记录被状态机拒绝的结算。迟到 completion 不能改变已写终态，但必须留下可检索的
   * 诊断事件；事件本身也进入持久化快照，因此 Host 能按 sequence 观察完整竞态顺序。
   */
  function rejectSettlement(task, shard, attempt, requestedStatus, reason) {
    const event = emit({
      type: "shard_settlement_rejected",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      role: task.role,
      reason,
      currentStatus: attempt.status,
      requestedStatus,
    });
    notifyPersistence();
    return { accepted: false, reason, event };
  }

  /**
   * 快照体积闸门（接受**已测量**的字节数）。
   *
   * 判定规则与 resource-budget.checkSnapshotBudget 完全一致：上限取
   * budgetPolicy.maxSnapshotBytes（非法时回退 FANOUT_BUDGET.maxSnapshotBytes）、
   * recoverable=false、提示文案同源；区别只是这里复用序列化时量出的字节数。
   *
   * 之所以不能直接调用 checkSnapshotBudget：它内部会再 measureJsonBytes 一次，
   * 即为了体积判定对同一份快照做第二次全量 stringify（审核确认的热点之一）。
   * 上限数值仍然只有 resource-budget.js 一处来源，本函数不新增任何预算常量，
   * 也不改变判定口径（receivedBytes === limit 仍视为合规）。
   */
  function snapshotSizeVerdict(bytes) {
    return checkBudget({
      resource: "snapshot",
      limit: Number.isSafeInteger(budgetPolicy.maxSnapshotBytes) && budgetPolicy.maxSnapshotBytes > 0
        ? budgetPolicy.maxSnapshotBytes
        : FANOUT_BUDGET.maxSnapshotBytes,
      receivedBytes: bytes,
      recoverable: false,
      hint: "快照过大时先让未终态 work 收敛，或清理已结算的历史任务",
    });
  }

  /**
   * 落盘一份快照并返回结构化结果。
   *
   * 落盘闸门（按顺序判定，任何一条不通过都不调用 persistence.save）：
   * 1. degraded 快照：序列化因不可 JSON 序列化而退化出的空 tasks 快照，
   *    绝不能拿去覆盖已有的完整 durable 快照——否则就是用"丢失全部任务"冒充成功落盘；
   * 2. 不可测量快照（JSON.stringify 抛错）：同样拒绝；
   * 3. 字节预算超限：拒绝并记录违规；
   * 4. 没有 persistence：返回 no_persistence。
   *
   * 所有拒绝路径只更新内存健康状态并返回 {saved:false, reason, ...}，绝不抛异常、
   * 绝不改动内存状态机，因此 notifyPersistence 不会被降级路径变成持久化反馈循环。
   *
   * 每次调用都会把结果写入 lastPersistResult（只读诊断）：
   * - saved：bytes 为实测快照字节；
   * - skipped：reason ∈ {degraded_snapshot, unmeasurable_snapshot, oversize_snapshot,
   *   no_persistence}；
   * - failed：save 抛错或异步落盘明确失败，category 取错误自带类别（缺失为 unknown，
   *   Host persistence-health 才是分类权威）。
   *
   * @param {object} [snapshot] - 待落盘快照；缺省时序列化当前状态。
   * @returns {{saved:boolean, bytes:number|null, reason?:string, category?:string, violation?:object}}
   */
  function persistSnapshot(snapshot) {
    return persistSnapshotInternal(snapshot, ++persistSequence);
  }

  /**
   * 记录最近一次持久化结果（只读诊断）。
   *
   * status 三态固定为 saved / skipped / failed：skipped 必须带原因（degraded_snapshot /
   * unmeasurable_snapshot / oversize_snapshot / no_persistence），failed 只来自 save 抛错
   * 或异步落盘明确失败。ticket 单调：异步 save 的迟到回调不得覆盖更晚一次 persist 的结果。
   * 分类的权威仍是 Host 的 persistence-health；这里只在错误自带 category 时透传。
   */
  function recordPersistResult(result, ticket) {
    if (ticket < lastPersistResultTicket) return result;
    lastPersistResultTicket = ticket;
    lastPersistResult = Object.freeze({
      status: result.saved === true ? "saved" : (result.reason === "save_failed" ? "failed" : "skipped"),
      saved: result.saved === true,
      reason: typeof result.reason === "string" ? result.reason : null,
      category: typeof result.category === "string" ? result.category : null,
      bytes: Number.isSafeInteger(result.bytes) ? result.bytes : null,
      at: now(),
    });
    return result;
  }

  /** 从同步/异步落盘错误里提取稳定分类；缺失记 unknown（Host health 仍是分类权威）。 */
  function persistenceCategoryOf(value) {
    const category = value?.category;
    return typeof category === "string" && category.length > 0 ? category : "unknown";
  }

  function persistSnapshotInternal(snapshot, ticket) {
    // 两条路径的差别只在"内容与体积怎么来"：
    // - 内部路径（缺省）：serializeSnapshotEnvelope 只做一次 stringify，payload 与 bytes
    //   同源，闸门不再为测量重复序列化；
    // - 显式 payload 路径（调用方传入快照对象）：对象必须原样交给 persistence.save
    //   （调用方可能持有引用并期望写入的就是它），因此体积仍用 measureJsonBytes 测量。
    //   这条路径不在状态变化热路径上（热路径见 notifyPersistence 的批合并），保持原语义。
    const envelope = snapshot === undefined ? serializeSnapshotEnvelope() : null;
    const payload = envelope === null ? snapshot : envelope.payload;
    const measured = envelope === null ? measureJsonBytes(payload) : envelope.bytes;
    // 1. 降级快照：degraded 标记由序列化路径在不可序列化时写入。
    if (payload !== null && typeof payload === "object" && payload.degraded === true) {
      const violation = payload.violation ?? describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "persist",
        hint: "快照不完整（degraded），拒绝落盘以避免覆盖已有的完整快照",
      });
      noteBudgetViolation(violation, "persist");
      return recordPersistResult({ saved: false, bytes: null, reason: "degraded_snapshot", violation }, ticket);
    }
    // 2. 不可测量：明确拒绝，不把"未知体积"当合法。
    if (measured === null) {
      const violation = describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "persist",
        hint: "快照不可 JSON 序列化，拒绝落盘",
      });
      noteBudgetViolation(violation, "persist");
      return recordPersistResult({ saved: false, bytes: null, reason: "unmeasurable_snapshot", violation }, ticket);
    }
    // 3. 字节预算（复用上面已量出的字节数，不再重新序列化）。
    const verdict = snapshotSizeVerdict(measured);
    if (!verdict.ok) {
      noteBudgetViolation(verdict.violation, "snapshot");
      // 旧实现漏掉 reason：超限跳过与其它 skipped 无法区分；这里补齐稳定原因码。
      return recordPersistResult({
        saved: false,
        bytes: verdict.violation.receivedBytes,
        reason: "oversize_snapshot",
        violation: verdict.violation,
      }, ticket);
    }
    // 4. 没有持久化目标。
    if (persistence === undefined || persistence === null) {
      return recordPersistResult({ saved: false, bytes: measured, reason: "no_persistence" }, ticket);
    }
    try {
      const pending = persistence.save(payload);
      if (pending !== null && typeof pending === "object" && typeof pending.then === "function") {
        /**
         * 异步落盘：同步返回时只能确认"已提交"，真实结果以回调为准。
         *
         * - 失败不能变成未处理 rejection（旧实现 result.catch(() => {}) 把事实吞掉）；
         * - 迟到结果不得覆盖更晚一次 persist 的结果（ticket 单调）；
         * - 分类优先取错误自带的 category，Host 的 persistence-health 记录仍是权威。
         */
        pending.then(
          (value) => {
            if (value === false || (value !== null && typeof value === "object" && value.ok === false)) {
              recordPersistResult({
                saved: false,
                bytes: measured,
                reason: "save_failed",
                category: persistenceCategoryOf(value?.ok === false ? value.error : value),
              }, ticket);
            }
          },
          (error) => {
            recordPersistResult({
              saved: false,
              bytes: measured,
              reason: "save_failed",
              category: persistenceCategoryOf(error),
            }, ticket);
          },
        );
      } else if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
        // 兼容只有 catch 的 thenable（历史注入 seam 形态）：至少不能留下未处理 rejection。
        pending.catch((error) => {
          recordPersistResult({
            saved: false,
            bytes: measured,
            reason: "save_failed",
            category: persistenceCategoryOf(error),
          }, ticket);
        });
      }
      return recordPersistResult({ saved: true, bytes: measured }, ticket);
    } catch (error) {
      // 持久化是旁路：落盘失败不改变内存状态机，由 Host 自行告警。
      // save 失败不是"预算拒绝"（可能只是 IO 错误），因此不伪造 BUDGET_EXCEEDED 事件；
      // 它通过 lastPersistResult + Host persistence-health 进入诊断。
      return recordPersistResult({
        saved: false,
        bytes: measured,
        reason: "save_failed",
        category: persistenceCategoryOf(error),
        error,
      }, ticket);
    }
  }

  // -------------------------------------------------------------------------
  // 持久化通知合并（同一同步批内只序列化一次）
  // -------------------------------------------------------------------------

  /**
   * 一个"序列化 tick" = 一次公开写调用 / 一次 drain / 一次异步收敛回调。
   *
   * 为什么需要合并：一次 tick 里可能有多次状态变化（批量派发 N 个 shard、close 收敛
   * 多个任务、cancelParent 结算多个排队 shard），旧实现对每次变化都全量序列化一遍
   * （含全部任务与最多 1000 条事件），高频分片结算的长会话因此出现调度热点。
   * 现在批内只置脏标记，批结束时同步落盘**一次**，批末内容即该批的权威最终状态——
   * 每个被跳过的中间快照都会被更晚的快照取代，因此不丢失任何可观察语义。
   *
   * 语义边界：
   * - 只在同一同步批内合并，**不引入微任务/定时器延迟**：批结束时同步写，所以
   *   "状态变化返回后立即读 persistence 记录即可见"的既有可观察行为不变；
   * - 没有状态变化时 flush 是 no-op（终态后的重复取消不会产生多余 save）；
   * - 落盘回调若同步重入写入口，重入期间的变化留在同一个 flush 循环里继续收敛，
   *   绝不丢写，也不会无限递归。
   */
  let persistenceBatchDepth = 0;
  let persistenceDirty = false;
  let persistenceFlushing = false;

  /** 落盘"合并后"的当前状态；没有待落盘变化时是 no-op。 */
  function flushPersistence() {
    if (!persistenceDirty || persistenceFlushing) return;
    persistenceFlushing = true;
    try {
      // while 而非 if：落盘回调可能同步重入（例如 save 里再 submit/close），
      // 重入只会重新置脏，由同一轮 flush 收敛。
      while (persistenceDirty) {
        persistenceDirty = false;
        // 消费并保存落盘结果：persistSnapshot 内部把 saved/skipped(reason)/failed(category)
        // 写入 lastPersistResult（旧实现直接丢弃返回值，跳过/失败因此完全不可见）。
        persistSnapshot();
      }
    } finally {
      persistenceFlushing = false;
    }
  }

  /**
   * 把一段同步状态变化过程包成一个持久化批。
   *
   * 嵌套调用共享最外层批（例如订阅者在 running 事件里重入 close/submit），因此不会在
   * 中间态产生额外写；work 抛错时同样在 finally 落盘，避免已发生的状态变化被吞掉。
   */
  function withPersistenceBatch(work) {
    persistenceBatchDepth += 1;
    try {
      return work();
    } finally {
      persistenceBatchDepth -= 1;
      if (persistenceBatchDepth === 0) flushPersistence();
    }
  }

  /** 每次状态变化后落盘一份深拷贝快照；持久化失败不能中断调度。 */
  function notifyPersistence() {
    if (persistence === undefined || persistence === null) return;
    persistenceDirty = true;
    // 批内合并，由批结束时统一落盘；批外（防御性路径）立即落盘，保持旧行为。
    if (persistenceBatchDepth > 0) return;
    flushPersistence();
  }

  // -------------------------------------------------------------------------
  // 状态派生
  // -------------------------------------------------------------------------

  function computeCounts(task) {
    const counts = {};
    for (const key of SHARD_STATUS_KEYS) counts[key] = 0;
    for (const shard of task.shards) {
      const status = shard.status ?? "queued";
      counts[status] = (counts[status] ?? 0) + 1;
    }
    // pending 是「尚未终态」的派生计数，方便调用方直接读聚合进度。
    counts.pending = counts.queued + counts.running;
    /**
     * stop_pending（票据 07）：**已逻辑终态但停止未确认**的 attempt 数。
     *
     * 它和 pending 是两个独立的聚合阻塞源：pending 回答"还有分片在跑吗"，stop_pending
     * 回答"有没有分片已经终态、但执行体可能还在写"。只有两者同时为 0 才允许聚合结算，
     * 否则任务保持 pending（不写 settledAt、不发 task_settled）。
     *
     * 非终态 attempt 不计入这里——它们由 pending 覆盖；把两者混在一起会让"停止未确认"
     * 这个诊断字段在正常运行时恒大于 0，失去意义。
     */
    counts.stop_pending = countStopPending(task);
    return counts;
  }

  /**
   * 统计「逻辑终态 && 停止未确认」的 attempt 数。
   *
   * 遍历全部 attempt（不只最新一个）：旧 attempt 的迟到写入同样需要范围保护，因此它的
   * 未确认状态也必须阻塞聚合。attempt 数受 maxAttemptsPerShard 约束，遍历成本有界。
   */
  function countStopPending(task) {
    let total = 0;
    for (const shard of task.shards) {
      for (const attempt of shard.attempts) {
        const status = attempt.status ?? "queued";
        if (!isTerminalShardStatus(status)) continue;
        if (isStopObserved(attempt)) continue;
        total += 1;
      }
    }
    return total;
  }

  function activeShard(shard) {
    return shard.attempts.find((attempt) => attempt.status === "running");
  }

  /**
   * 记录一次动态上限的非法返回：只读诊断 + 一次性结构化事件。
   *
   * 事件必须"一次性而不是每次派发都刷"：解析发生在调度热路径上，同一个坏设置会在每个
   * drain 被反复读到。去重维度是 kind——只有从"没有该 kind 的诊断"进入非法状态时才发布，
   * 解析成功后 clearInvalidDynamicLimit 清空，下一次再坏会重新发布（新的故障窗口）。
   *
   * 事件负载只含 kind / 来源 / 回退值：不含设置原文、原始返回值或任何会话数据，避免
   * 把 journald/事件历史变成敏感信息泄露面。
   *
   * @param {"concurrencyLimit"|"roleLimits"|"providerLimits"} kind - 非法值的解析路径。
   * @param {unknown} value - 原始返回值（只取类型，不落盘）。
   * @param {string} [message] - 覆盖默认诊断文案（按 kind 或"含非法条目"区分）。
   */
  function noteInvalidDynamicLimit(kind, value, message) {
    const firstObservation = !invalidLimitDiagnostics.has(kind);
    invalidLimitDiagnostics.set(kind, {
      kind,
      valueType: value === null ? "null" : typeof value,
      message: message ?? (kind === "concurrencyLimit"
        ? "settings 解析出的并发上限不是 1~" + MAX_CONCURRENCY_LIMIT + " 的整数，已回退默认值 " + DEFAULT_CONCURRENCY_LIMIT
        : kind === "providerLimits"
          ? "settings 解析出的 providerLimits 不是 provider -> limit 映射，已忽略全部 provider 级覆盖"
          : "settings 解析出的 roleLimits 不是 role -> limit 映射，已忽略全部角色级覆盖"),
    });
    lastInvalidLimitKind = kind;
    if (!firstObservation) return;
    emit({
      type: "concurrency_limit_fallback",
      kind,
      source: "fallback",
      // 回退目标必须与真实调度行为一致：默认上限回退数值，role 映射回退默认值，
      // provider 映射回退"不限制"（0 语义），否则诊断会撒谎。
      fallback: kind === "concurrencyLimit"
        ? DEFAULT_CONCURRENCY_LIMIT
        : (kind === "providerLimits" ? "provider-unlimited" : "role-default"),
    });
  }

  /** 解析成功后清除对应 kind 的非法诊断；下次再出现非法值会重新发布一次性事件。 */
  function clearInvalidDynamicLimit(kind) {
    if (!invalidLimitDiagnostics.delete(kind)) return;
    if (lastInvalidLimitKind !== kind) return;
    const kinds = [...invalidLimitDiagnostics.keys()];
    lastInvalidLimitKind = kinds.length === 0 ? null : kinds[kinds.length - 1];
  }

  /** 对外只读投影：最近一次非法诊断的拷贝（不暴露内部 Map）。 */
  function invalidLimitSnapshot() {
    if (lastInvalidLimitKind === null) return null;
    const diagnostic = invalidLimitDiagnostics.get(lastInvalidLimitKind);
    return diagnostic === undefined ? null : Object.freeze({ ...diagnostic });
  }

  /**
   * 解析默认并发上限，并返回**这一次**解析的来源。
   *
   * source 取值：
   * - live：注入的解析函数给出了合法值（当前设置权威）；
   * - snapshot：没有 live resolver，使用冻结值（快照或构造期静态值）；
   * - fallback：解析函数抛错或返回非法值，本次已回退安全默认值。诊断必须如实暴露
   *   fallback，否则用户看到设置页=3、实际并发=20 却无从解释。
   *
   * @returns {{value:number, source:"live"|"snapshot"|"fallback"}}
   */
  function resolveDefaultConcurrencyLimitState() {
    if (resolverSource !== "live" || typeof rawConcurrencyLimit !== "function") {
      lastResolvedDefaultConcurrencyLimit = defaultConcurrencyLimit;
      return { value: defaultConcurrencyLimit, source: "snapshot" };
    }
    let raw;
    try {
      raw = rawConcurrencyLimit();
    } catch {
      // 解析函数读的是外部设置状态：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("concurrencyLimit", undefined);
      lastResolvedDefaultConcurrencyLimit = DEFAULT_CONCURRENCY_LIMIT;
      return { value: DEFAULT_CONCURRENCY_LIMIT, source: "fallback" };
    }
    const check = validateConcurrencyLimit(raw);
    if (check.ok) {
      clearInvalidDynamicLimit("concurrencyLimit");
      lastResolvedDefaultConcurrencyLimit = check.value;
      return { value: check.value, source: "live" };
    }
    noteInvalidDynamicLimit("concurrencyLimit", raw);
    lastResolvedDefaultConcurrencyLimit = DEFAULT_CONCURRENCY_LIMIT;
    return { value: DEFAULT_CONCURRENCY_LIMIT, source: "fallback" };
  }

  /** 只取数值的便捷形式（调度热路径与角色池解析使用）。 */
  function resolveDefaultConcurrencyLimit() {
    return resolveDefaultConcurrencyLimitState().value;
  }

  /**
   * 解析 role 级覆盖，按票据 03 的三级优先级：
   * 当前 settings 解析值（live resolver）> 快照中的显式角色级映射 > 安全默认值。
   *
   * 静态映射在构造/restore 时已完成校验（非法配置直接抛错），不需要第三层回退；
   * 函数形式读取的是"当前设置"，因此：
   * - 每次调用都读一次最新值——设置可能在两次提交之间变化，缓存会把新设置吞掉；
   * - 调度热路径对每个父任务每轮只解析一次，任务级显式限制则完全不走这里；
   * - 返回结构非法时整体忽略 live 角色级覆盖，回退到快照映射/默认值；
   * - 单个角色的非法值只让该 role 回退（live 未给出时由快照映射补位）。
   */
  function resolveRoleLimits() {
    if (typeof roleLimits !== "function") return roleLimits;
    let raw;
    let liveUnavailable = false;
    try {
      raw = roleLimits();
    } catch {
      // 解析函数读的是外部设置状态：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("roleLimits", undefined);
      liveUnavailable = true;
      raw = undefined;
    }
    const normalized = {};
    if (!liveUnavailable) {
      if (raw === undefined || raw === null) {
        // 没有 live 覆盖不是"非法值"：清除诊断，由快照映射/默认值兜底。
        clearInvalidDynamicLimit("roleLimits");
      } else if (typeof raw !== "object" || Array.isArray(raw)) {
        noteInvalidDynamicLimit("roleLimits", raw);
      } else {
        let invalidEntry = false;
        for (const [role, limit] of Object.entries(raw)) {
          const check = validateConcurrencyLimit(limit);
          if (check.ok) normalized[role] = check.value;
          else invalidEntry = true;
        }
        if (invalidEntry) {
          noteInvalidDynamicLimit(
            "roleLimits",
            raw,
            "settings 解析出的 roleLimits 含非法条目，已忽略这些角色级覆盖",
          );
        } else {
          clearInvalidDynamicLimit("roleLimits");
        }
      }
    }
    // 第二层：恢复出来的显式角色级映射。只在 live 没有给出合法值时补位，
    // 因此 live 的合法值永远优先；live 整体不可用时这里给出稳定的快照回退。
    for (const [role, limit] of Object.entries(restoredRoleLimitOverrides)) {
      if (typeof normalized[role] === "number") continue;
      const check = validateConcurrencyLimit(limit);
      if (check.ok) normalized[role] = check.value;
    }
    return Object.freeze(normalized);
  }

  /**
   * 解析 provider 级覆盖（票据 26）：与 resolveRoleLimits 同一套来源模型。
   *
   * - live 解析函数每次调用都重新读取当前设置（设置保存后立即约束后续派发）；
   * - 结构非法时整体忽略 live 覆盖并记录一次性诊断；
   * - 单个 provider 的非法值只让该 provider 回退到快照映射/不限制；
   * - 合法的 0 必须原样保留：它表示「显式不限制」，不能与「未配置」混淆——
   *   虽然两者调度上等价，但诊断必须如实投影用户写了什么。
   *
   * @returns {Readonly<Record<string, number>>} provider -> 0..64 的冻结映射。
   */
  function resolveProviderLimits() {
    if (typeof providerLimits !== "function") return providerLimits;
    let raw;
    let liveUnavailable = false;
    try {
      raw = providerLimits();
    } catch {
      // 解析函数读的是外部 settings：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("providerLimits", undefined);
      liveUnavailable = true;
      raw = undefined;
    }
    const normalized = {};
    if (!liveUnavailable) {
      if (raw === undefined || raw === null) {
        // 没有 live 覆盖不是"非法值"：清除诊断，由快照映射/不限制兜底。
        clearInvalidDynamicLimit("providerLimits");
      } else if (typeof raw !== "object" || Array.isArray(raw)) {
        noteInvalidDynamicLimit("providerLimits", raw);
      } else {
        let invalidEntry = false;
        for (const [provider, limit] of Object.entries(raw)) {
          const check = validateProviderLimit(limit);
          if (check.ok && provider.trim().length > 0) normalized[provider] = check.value;
          else invalidEntry = true;
        }
        if (invalidEntry) {
          noteInvalidDynamicLimit(
            "providerLimits",
            raw,
            "settings 解析出的 providerLimits 含非法条目，已忽略这些 provider 级覆盖",
          );
        } else {
          clearInvalidDynamicLimit("providerLimits");
        }
      }
    }
    // 第二层：恢复出来的显式 provider 级映射，只在 live 没有给出合法值时补位。
    for (const [provider, limit] of Object.entries(restoredProviderLimitOverrides)) {
      if (typeof normalized[provider] === "number") continue;
      const check = validateProviderLimit(limit);
      if (check.ok) normalized[provider] = check.value;
    }
    return Object.freeze(normalized);
  }

  /**
   * 某个任务生效的 provider 名额上限；undefined 表示不受 provider 限流约束。
   *
   * 语义（票据 26）：
   * - 任务没有 provider 归属（角色未配置主模型）→ undefined（不限制）；
   * - provider 未配置、显式 0 → undefined（不限制）；
   * - 1..64 → 该 provider 的并发名额。
   *
   * 接收**已解析**的 provider 映射而不是自己再读一次设置：调度热路径一轮只解析一次，
   * 避免每个候选分片都重复遍历设置对象。
   *
   * @param {object} task - 父任务。
   * @param {Readonly<Record<string, number>>} resolved - 本轮解析出的 provider -> limit。
   * @returns {number|undefined}
   */
  function providerLimitOf(task, resolved) {
    const provider = typeof task?.provider === "string" ? task.provider : "";
    if (provider.length === 0) return undefined;
    const configured = resolved[provider];
    if (typeof configured !== "number" || configured <= 0) return undefined;
    return configured;
  }

  /**
   * 快照里对外暴露的单个任务"有效并发上限"，仅供展示与契约稳定使用。
   *
   * 三级优先级：任务级显式 concurrencyLimit（submit 入参，或快照恢复出来的任务级值）
   * > 角色级设置（roleLimits，即该角色的共享并发池，按当前设置解析，可增可减）
   * > 动态/静态默认值。恢复任务在 restore 时会带上快照里的任务级限制，因此重启不会改变
   * 显式限制的语义；角色级这一层由 resolveRoleLimits 按"live 解析值 > 快照显式映射 >
   * 安全默认值"解析，不会被快照冻结（票据 03）。
   *
   * 注意：调度判定**不能**直接使用本函数。它给出的单值只适用于"某 role 只有一个父任务"
   * 的场景；多父任务并存时任务级上限与 role 共享池必须分别判定（见 rolePoolLimitFor /
   * taskLimitFor 与 dispatchAvailable），否则低上限任务会被别人的 role 占用饿死。
   */
  function roleLimitFor(task) {
    if (typeof task.concurrencyLimit === "number") return task.concurrencyLimit;
    const configured = resolveRoleLimits()[task.role];
    if (typeof configured === "number") return configured;
    return resolveDefaultConcurrencyLimit();
  }

  /**
   * role 共享池上限：该 role 下**所有**父任务合计允许的 running 分片数。
   *
   * 只看 role 级设置与默认值，**不读 task.concurrencyLimit**——任务级显式上限是"这个
   * 父任务最多跑几个"的独立约束，不能把它当成整个 role 的池子大小，否则一个任务级 64
   * 的任务会把同一 role 里别的父任务挤出去。
   */
  function rolePoolLimitFor(task) {
    const configured = resolveRoleLimits()[task.role];
    if (typeof configured === "number") return configured;
    return resolveDefaultConcurrencyLimit();
  }

  /**
   * 任务级上限：显式 concurrencyLimit 才有值；未显式给出时返回 undefined。
   *
   * 返回 undefined 而不是回退默认值，是因为"未设置任务级上限"的语义是**这一层不设限**，
   * 由 role 共享池单独兜底；若这里回退成默认值，一个未设限的任务在同一 role 里就再也
   * 拿不到超过 10 个槽位（即便 role 池允许更多），与工具描述不符。
   */
  function taskLimitFor(task) {
    return typeof task.concurrencyLimit === "number" ? task.concurrencyLimit : undefined;
  }

  /**
   * 只读并发视图：当前有效默认值、各 role 覆盖、来源与最近一次非法值诊断。
   *
   * source 是**本次解析**的来源（live / snapshot / fallback），不是构造期的静态标记：
   * 设置解析函数抛错或返回非法值时，用户必须能看到"这次回退到了安全默认值"。roles 的
   * 解析同样可能刷新非法诊断，因此 invalid 在 roles 之后再取。
   *
   * 不暴露任务负载；invalid.message 只含插件自身固定文案，不含设置原文或原始返回值。
   */
  function concurrencyLimits() {
    const state = resolveDefaultConcurrencyLimitState();
    const roles = resolveRoleLimits();
    // provider 级映射（票据 26）与 role 级同源同点解析：诊断必须与调度读到同一份值。
    const providers = resolveProviderLimits();
    // invalid 必须在两次解析之后取：任一解析路径都可能刷新最近一次非法诊断。
    const invalid = invalidLimitSnapshot();
    return Object.freeze({
      default: state.value,
      roles: Object.freeze({ ...roles }),
      providers: Object.freeze({ ...providers }),
      source: state.source,
      ...(invalid === null ? {} : { invalid }),
    });
  }

  /**
   * 同步一个 shard 的 running 归属：role 共享池、父任务自身与 provider 三个计数一起增减。
   *
   * 三个计数必须同源同点更新（唯一调用点是 setShardStatus）：只要有一处漏改，派发判定
   * 就会读到漂移值，出现超发或永久饿死。计数归零时删除条目，避免空条目长期驻留。
   *
   * 释放语义：进入终态时三个维度在同一个同步调用里一起归还（provider 与 role 的释放
   * 顺序因此天然反向前提中"先 provider 后 role"的获取顺序），不存在交叉等待，也就不
   * 可能因为"持有 role 等 provider"而死锁。
   */
  function addRunningCount(task, delta) {
    const role = task.role;
    const nextRoleCount = (runningCountsByRole.get(role) ?? 0) + delta;
    if (nextRoleCount <= 0) runningCountsByRole.delete(role);
    else runningCountsByRole.set(role, nextRoleCount);
    const nextTaskCount = (runningCountsByTask.get(task) ?? 0) + delta;
    if (nextTaskCount <= 0) runningCountsByTask.delete(task);
    else runningCountsByTask.set(task, nextTaskCount);
    // provider 计数（票据 26）与前两个维度同源同点更新：没有归属的任务不进入任何
    // provider 池（provider 限流对它们不生效），因此也不会在这里凭空创建条目。
    const provider = typeof task.provider === "string" ? task.provider : "";
    if (provider.length === 0) return;
    const nextProviderCount = (runningCountsByProvider.get(provider) ?? 0) + delta;
    if (nextProviderCount <= 0) runningCountsByProvider.delete(provider);
    else runningCountsByProvider.set(provider, nextProviderCount);
  }

  function addTaskToRoleIndex(task, roleIndex) {
    let parents = parentsByRole.get(task.role);
    if (parents === undefined) {
      parents = [];
      parentsByRole.set(task.role, parents);
    }
    if (Number.isInteger(roleIndex) && roleIndex >= 0 && roleIndex <= parents.length) parents.splice(roleIndex, 0, task);
    else parents.push(task);
  }

  /** 从 path index 中摘除一个 attempt entry（保留 order 语义由调用方决定）。 */
  function removeAttemptScope(attempt) {
    const previous = activeShardEntries.get(attempt);
    if (previous === undefined) return;
    for (const path of previous.affectedPaths) {
      const attempts = activeShardsByPath.get(path);
      if (attempts === undefined) continue;
      attempts.delete(attempt);
      if (attempts.size === 0) activeShardsByPath.delete(path);
    }
    activeShardEntries.delete(attempt);
  }

  /**
   * 同步单个 attempt 的影响范围索引（票据 07）。
   *
   * 登记条件：attempt 存在且 affectedPaths 非空——**queued 也登记**，范围预留必须早于执行，
   * 否则两个分片可能在排队期间抢到同一路径。
   *
   * 释放条件（唯一）：attempt 已逻辑终态 **且** stopEvidence 已 observed。逻辑终态只说明
   * 管理器不再改写状态，不说明执行体停止写盘；过早释放会让同路径新任务与未停止的旧 child
   * 并发写。因此超时/取消但无证据的 attempt 会一直占位，直到 observeStopEvidence 到达。
   *
   * 所有状态转移都经由 setShardStatus / observeStopEvidence / restore 进入本函数，避免
   * 取消、超时、迟到完成或证据补录漏掉索引更新。
   */
  function syncAttemptScope(task, shard, attempt) {
    const previous = activeShardEntries.get(attempt);
    const affectedPaths = Array.isArray(attempt?.affectedPaths) ? attempt.affectedPaths : [];
    const released = isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
    if (released) {
      removeAttemptScope(attempt);
      return;
    }
    if (affectedPaths.length === 0) {
      // 没有声明影响范围的 attempt 不占位（与旧语义一致：空路径不参与冲突判定）。
      removeAttemptScope(attempt);
      return;
    }
    const entry = {
      parentTaskId: task.parentTaskId,
      role: task.role,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      status: attempt.status ?? "queued",
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      affectedPaths: [...affectedPaths],
      order: previous?.order ?? nextActiveOrder++,
      // 内部引用只用于"排除自己这个 shard"的冲突判定，绝不进入任何对外视图/快照。
      task,
      shard,
    };
    activeShardEntries.set(attempt, entry);
    for (const path of affectedPaths) {
      let attempts = activeShardsByPath.get(path);
      if (attempts === undefined) {
        attempts = new Set();
        activeShardsByPath.set(path, attempts);
      }
      attempts.add(attempt);
    }
  }

  /** 同步一个 shard 全部 attempt 的范围索引（状态转移后统一调用）。 */
  function syncShardScopes(task, shard) {
    for (const attempt of shard.attempts) syncAttemptScope(task, shard, attempt);
  }

  function setShardStatus(task, shard, status) {
    const previous = shard.status;
    if (previous !== status) {
      if (previous === "running") addRunningCount(task, -1);
      if (status === "running") addRunningCount(task, 1);
    }
    shard.status = status;
    syncShardScopes(task, shard);
  }

  function indexTask(task, roleIndex) {
    addTaskToRoleIndex(task, roleIndex);
    for (const shard of task.shards) {
      if (shard.status === "running") addRunningCount(task, 1);
      syncShardScopes(task, shard);
    }
  }

  function removeTaskIndex(task) {
    const parents = parentsByRole.get(task.role);
    const roleIndex = parents?.indexOf(task) ?? -1;
    if (roleIndex >= 0) {
      parents.splice(roleIndex, 1);
      if (parents.length === 0) parentsByRole.delete(task.role);
    }
    for (const shard of task.shards) {
      if (shard.status === "running") addRunningCount(task, -1);
      for (const attempt of shard.attempts) removeAttemptScope(attempt);
    }
    // 任务级计数以任务对象身份为 key，删除索引后必须回收该条目，否则被销毁的父子任务
    // 会以"零 running 的空条目"形式滞留在 Map 里直到 close。
    runningCountsByTask.delete(task);
    return roleIndex >= 0 ? roleIndex : undefined;
  }

  function rebuildIndexes() {
    parentsByRole.clear();
    runningCountsByRole.clear();
    runningCountsByTask.clear();
    runningCountsByProvider.clear();
    activeShardEntries.clear();
    activeShardsByPath.clear();
    nextActiveOrder = 0;
    // continuation requestId 的跨任务索引同样从任务本体（持久化真相源）重建：
    // restore 后旧 requestId 仍然可查（不会因为进程重启或索引淘汰而丢失幂等性）。
    continuationRequestOwners.clear();
    for (const task of tasks.values()) {
      indexTask(task);
      for (const requestId of Object.keys(task.continuationRequests ?? {})) {
        continuationRequestOwners.set(requestId, task.parentTaskId);
      }
    }
  }

  /** 单任务已记录的 continuation requestId 数量（只读诊断/预算判定）。 */
  function continuationRequestCount(task) {
    return task?.continuationRequests === undefined || task.continuationRequests === null
      ? 0
      : Object.keys(task.continuationRequests).length;
  }

  /**
   * 单任务 continuation requestId 记录预算。
   *
   * 与 attempt 预算同源：每成功续作一轮至少消耗一个 attempt（`maxAttemptsPerShard` 封顶），
   * 因此「记录数 ≥ 该上限」在正常路径上不可能先于 attempt 预算触发；这里保留显式判定是
   * 为了给恢复外部快照/未来改动一个**结构化拒绝**出口——绝不允许用淘汰旧键的方式腾空间。
   */
  function continuationRequestBudgetExceeded(task) {
    return continuationRequestCount(task) >= budgetPolicy.maxAttemptsPerShard;
  }

  function activeShardView(entry) {
    return {
      parentTaskId: entry.parentTaskId,
      role: entry.role,
      shardId: entry.shardId,
      attempt: entry.attempt,
      attemptId: entry.attemptId,
      status: entry.status,
      stopState: entry.stopState,
      ...(entry.affectedPaths.length === 0 ? {} : { affectedPaths: [...entry.affectedPaths] }),
    };
  }

  /**
   * 取当前所有**仍占用影响范围**的 attempt 公共视图，用于冲突判定。
   *
   * 这里不再是"queued/running 的 shard"，而是"逻辑未完成，或已终态但停止未确认"的
   * attempt（票据 07）：超时/取消后未停止的旧 attempt 必须继续参与冲突判定。
   * excludeShard 按 shard 身份排除（同一 shard 的多个历史 attempt 都不算冲突对象），
   * 因为重试/续作复用同一个 child，天然不会与自己的旧 attempt 抢路径。
   */
  function collectActiveShards(excludeShard) {
    const active = [];
    for (const [, entry] of activeShardEntries) {
      if (excludeShard !== undefined && entry.shard === excludeShard) continue;
      active.push(activeShardView(entry));
    }
    return active;
  }

  /**
   * 内置 checker 只按精确 affectedPaths 发生候选收敛；注入 checker 不能走这个过滤，
   * 因为 Host 可能使用目录/规范化/角色等额外冲突语义。
   */
  function collectConflictCandidates(role, shard, excludeShard) {
    if (!usesDefaultConflictChecker) return collectActiveShards(excludeShard);
    if (!writeRoles.includes(role)) return [];
    const paths = Array.isArray(shard?.affectedPaths) ? shard.affectedPaths : [];
    if (paths.length === 0) return [];
    const candidates = new Set();
    for (const path of paths) {
      for (const candidate of activeShardsByPath.get(path) ?? []) {
        const entry = activeShardEntries.get(candidate);
        if (entry === undefined) continue;
        // 按 shard 身份排除自己：同一 shard 的多个历史 attempt 都不算冲突对象
        //（重试/续作复用同一 child，天然不会与自己的旧 attempt 抢路径）。
        if (excludeShard !== undefined && entry.shard === excludeShard) continue;
        candidates.add(entry);
      }
    }
    return [...candidates]
      .sort((left, right) => left.order - right.order)
      .map(activeShardView);
  }

  function filterDefaultConflictCandidates(shard, otherShards) {
    const paths = new Set(Array.isArray(shard?.affectedPaths) ? shard.affectedPaths : []);
    if (paths.size === 0) return [];
    return otherShards.filter((other) => (other.affectedPaths ?? []).some((path) => paths.has(path)));
  }

  /** 对候选 shard 调用注入的冲突检查；返回 null 表示无冲突。 */
  function findConflict(role, shard, otherShards) {
    const candidates = usesDefaultConflictChecker
      ? filterDefaultConflictCandidates(shard, otherShards)
      : otherShards;
    if (typeof conflictObserver === "function") {
      try {
        conflictObserver({ role, shard, otherShards: candidates });
      } catch {
        // 观测器是旁路，不能把诊断代码异常变成调度失败。
      }
    }
    if (candidates.length === 0) return null;
    const verdict = normalizeConflict(conflictChecker({ role, shard, otherShards: candidates }));
    if (!verdict.conflict) return null;
    return {
      ...(verdict.shardIds === undefined ? {} : { shardIds: verdict.shardIds }),
      ...(verdict.paths === undefined ? {} : { paths: verdict.paths }),
      ...(shard.shardId === undefined ? {} : { shardId: shard.shardId }),
      role,
    };
  }

  // -------------------------------------------------------------------------
  // 快照序列化（内部与公共共用）
  // -------------------------------------------------------------------------

  /**
   * attempt 的停止证据投影（票据 07）：JSON 安全，且**绝不包含** timer/handle。
   *
   * timer 只活在内存里：把它写进快照会让恢复后的进程错误地"继承"一个不存在的定时器，
   * 而恢复语义要求"没有执行句柄就没有计时"，未确认的停止只能靠观测/边界收敛。
   */
  function attemptStopSnapshot(attempt) {
    return {
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      stopEvidence: attempt.stopEvidence === undefined
        ? { state: STOP_EVIDENCE_STATE_UNKNOWN }
        : cloneJson(attempt.stopEvidence),
      ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
      ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
      ...(attempt.stopWatchdogExpiredAt === undefined ? {} : { stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt }),
      ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
      ...(attempt.legacy === true ? { legacy: true } : {}),
    };
  }

  function shardSnapshot(task, shard) {
    return {
      shardId: shard.shardId,
      // 可选任务名称：Expert Group 用它作为分片第一行的任务名，缺失时由投影侧回退 shardId。
      ...(shard.name === undefined ? {} : { name: shard.name }),
      prompt: shard.prompt,
      status: shard.status,
      attemptCount: shard.attempts.length,
      createdAt: shard.createdAt,
      updatedAt: shard.updatedAt,
      affectedPaths: [...shard.affectedPaths],
      ...(shard.cancelRequested === true ? { cancelRequested: true } : {}),
      ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
      // 恢复续跑被 attempt 预算拦下时的稳定原因码（票据 08）。只在被拦下时出现，
      // 不含 prompt/结果，供投影与 Host 提示"该分片需手工提交新父任务"。
      ...(shard.resumeBlocked === undefined ? {} : { resumeBlocked: cloneJson(shard.resumeBlocked) }),
      attempts: shard.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        status: attempt.status,
        startedAt: attempt.startedAt ?? null,
        finishedAt: attempt.finishedAt ?? null,
        affectedPaths: [...attempt.affectedPaths],
        ...(attempt.cancelRequested === true ? { cancelRequested: true } : {}),
        ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
        ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
        ...(attempt.messageId === undefined ? {} : { messageId: attempt.messageId }),
        ...(attempt.result === undefined ? {} : { result: attempt.result }),
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
        ...attemptStopSnapshot(attempt),
      })),
    };
  }

  function taskSnapshot(task) {
    const counts = computeCounts(task);
    const shards = task.shards.map((shard) => shardSnapshot(task, shard));
    return {
      parentTaskId: task.parentTaskId,
      ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
      role: task.role,
      basePrompt: task.basePrompt,
      status: task.status,
      // 逻辑轮次与「当前是否可复用续作」：工具回执与侧边栏投影都读这两个字段，
      // 不需要自己遍历 attempt 推断。
      round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
      continuable: !closed && task.parentCancelRequested !== true && allShardsTerminal(task),
      // continuation 幂等记录（requestId -> 本轮结果）：随快照持久化，冷恢复后仍可查，
      // 消费方据此确认「同一个 requestId 曾经续作过哪一轮」。
      ...(continuationRequestCount(task) === 0 ? {} : { continuationRequests: cloneJson(task.continuationRequests) }),
      allowOverlap: task.allowOverlap,
      concurrencyLimit: roleLimitFor(task),
      // 父任务级默认超时（票据 06）：只含**显式**值。它是「分片没有自己的
      // timeoutMs 时用什么」的唯一依据，因此必须在任务视图里如实暴露。
      ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
      // provider 归属（票据 26）：任务视图如实投影，诊断与客户端只读展示据此把
      // 排队/运行分片归到某个 provider 名下（它不改变 prompt 或任何调度输入）。
      ...(task.provider === undefined ? {} : { provider: task.provider }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      settledAt: task.settledAt ?? null,
      parentCancelRequested: task.parentCancelRequested === true,
      counts,
      shards,
      // 结果按输入顺序排列，与 shards 同序；这是 wait-all 的对外主视图。
      results: shards.map((shard, index) => ({
        shardId: shard.shardId,
        status: shard.status,
        attempts: shard.attempts.length,
        ...(shard.attempts[shard.attempts.length - 1]?.result === undefined
          ? {}
          : { result: shard.attempts[shard.attempts.length - 1].result }),
        ...(shard.attempts[shard.attempts.length - 1]?.error === undefined
          ? {}
          : { error: shard.attempts[shard.attempts.length - 1].error }),
        index,
      })),
    };
  }

  /**
   * 构建可序列化快照的**内部投影**：只含逻辑状态，不含 timer/promise/child 句柄。
   *
   * 返回值仍然引用内部状态（result/error/配置对象都是原引用），因此绝不能直接交给
   * 外部：所有对外出口（snapshot() / 持久化）都经过 serializeSnapshotEnvelope() 取
   * 深拷贝。本函数只是把"快照应该长什么样"收敛到唯一一处，避免内容投影出现第二实现。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>}} [options] - 回收候选快照的排除集合
   *   （票据 05）：命中的父任务不进入 tasks 数组。事件历史保持原样——回收不删除历史事件，
   *   但回收后这些事件不再按 parentTaskId 可查询（查询返回 task_not_found）。
   */
  function buildSnapshotPayload(options = {}) {
    const omittedParentTaskIds = normalizeIdSet(options?.omitParentTaskIds);
    return {
      version: SNAPSHOT_VERSION,
      sequence,
      nextTaskNumber,
      /**
       * 进程身份（票据 07）：恢复时据此自动判定停止证据边界。
       *
       * 同一个进程内重建（值相同）只能得到 unknown——旧 child 可能仍然活着；
       * 值不同或缺失（旧版本快照）说明快照来自另一个进程，才允许 process-restart。
       */
      processInstance: PROCESS_INSTANCE,
      // 超时投影版本（票据 06）：告诉恢复路径「本快照的 shard.timeoutMs 是显式覆盖」，
      // 而不是像旧快照那样只能从 attempt.timeoutMs 反推。
      timeoutProjection: TIMEOUT_PROJECTION_VERSION,
      // 写最近一次解析得到的默认上限（未解析时为构造/恢复值），并附带来源标记：
      // - concurrencySource=live：该字段只是诊断，真实权威是恢复进程的当前设置；
      // - concurrencySource=snapshot：本进程没有 live resolver，该字段是冻结值。
      // restore 对有无标记的快照统一按"尽量 live"处理（有解析函数就 live，否则冻结），
      // 标记只服务外部读者与诊断，不改变恢复决策（票据 03）。
      defaultConcurrencyLimit: lastResolvedDefaultConcurrencyLimit,
      concurrencySource: resolverSource,
      roleLimits,
      // provider 级映射（票据 26）：与 roleLimits 同层持久化。函数形式（live）在
      // JSON 序列化时自然消失，因此快照里有值就说明这是一个可冻结的静态映射。
      providerLimits,
      writeRoles,
      defaultAllowOverlap,
      parentRotation: Object.fromEntries(rotationCursors),
      events: eventHistory.map((event) => cloneJson(event)),
      tasks: [...tasks.values()]
        .filter((task) => omittedParentTaskIds === null || !omittedParentTaskIds.has(task.parentTaskId))
        .map((task) => ({
        parentTaskId: task.parentTaskId,
        ...(task.requestId === undefined ? {} : { requestId: task.requestId }),
        role: task.role,
        basePrompt: task.basePrompt,
        status: task.status,
        // 逻辑轮次持久化：冷恢复后仍能区分「第几轮复用」并继续递增。
        round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
        // continuation 幂等记录持久化：重启后同一 requestId 仍然 duplicate=true。
        ...(continuationRequestCount(task) === 0 ? {} : { continuationRequests: cloneJson(task.continuationRequests) }),
        allowOverlap: task.allowOverlap,
        ...(task.concurrencyLimit === undefined ? {} : { concurrencyLimit: task.concurrencyLimit }),
        // 父任务级默认超时必须随快照持久化，否则重启后未显式给出超时的分片
        // 会静默回到角色默认值（票据 06）。
        ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
        // provider 归属随任务快照持久化（票据 26）：重启后 provider 级计数必须还能
        // 按同一归属重建；旧快照没有该字段时保持 undefined（限流不生效，不是错误）。
        ...(task.provider === undefined ? {} : { provider: task.provider }),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        settledAt: task.settledAt ?? null,
        parentCancelRequested: task.parentCancelRequested === true,
        shards: task.shards.map((shard) => ({
          shardId: shard.shardId,
          ...(shard.name === undefined ? {} : { name: shard.name }),
          prompt: shard.prompt,
          status: shard.status,
          createdAt: shard.createdAt,
          updatedAt: shard.updatedAt,
          ...(shard.cancelRequested === true ? { cancelRequested: true } : {}),
          // 分片级超时只写**显式覆盖**（票据 06）：父任务/角色默认值不能被写成
          // 分片覆盖，否则恢复后的超时来源会被永久冻结。
          ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
          // 恢复续跑被 attempt 预算拦下的原因码必须随持久化快照落盘（票据 08），
          // 否则重启后 UI 无法解释"为什么中断分片没有继续"。
          ...(shard.resumeBlocked === undefined ? {} : { resumeBlocked: cloneJson(shard.resumeBlocked) }),
          attempts: shard.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
            ...(attempt.finishedAt === undefined ? {} : { finishedAt: attempt.finishedAt }),
            affectedPaths: [...attempt.affectedPaths],
            ...(attempt.cancelRequested === true ? { cancelRequested: true } : {}),
            ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
            ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
            ...(attempt.messageId === undefined ? {} : { messageId: attempt.messageId }),
            ...(attempt.result === undefined ? {} : { result: attempt.result }),
            ...(attempt.error === undefined ? {} : { error: attempt.error }),
            // 停止证据与 attempt 身份随快照持久化（票据 07）：重启后仍能回答"哪些 attempt
            // 已逻辑终态但执行未确认"，并让恢复后的重试/续作 gate 保持同一判据。
            ...attemptStopSnapshot(attempt),
          })),
        })),
      })),
      // 执行代次计数器随快照持久化：恢复后新建 attempt 的代次必须大于全部历史代次，
      // 否则迟到证据可能"恰好匹配"一个新 attempt。
      nextExecutionGeneration,
    };
  }

  /**
   * 单次序列化快照：**同一份 JSON 文本**同时产出内容与体积。
   *
   * - payload：由该文本 parse 出的深拷贝，与内部状态完全隔离（与旧 cloneJson 语义
   *   一致：丢弃 undefined 字段、断开一切引用），调用方可自由修改；
   * - bytes：同一份文本的 UTF-8 字节数，供体积闸门直接使用。
   *
   * 因此"内容"与"体积测量"同源，不再出现旧实现里「cloneJson 全量克隆 + measureJsonBytes
   * 再 stringify + 闸门内又一次 stringify」的三次全量序列化（审核确认的调度热点），
   * 也不会出现内容与体积来自两次不同序列化的第二事实源。
   *
   * 永不抛异常：正常数据走完整投影；一旦遇到不可 JSON 序列化的负载（循环引用 /
   * BigInt / 抛错 getter，可能来自外部完成句柄），改为记录 budget 违规并返回
   * 只含存活终态的最小安全快照（bytes=null 表示不可测量）——绝不把未处理异常抛给
   * persistence / RPC 路径。
   *
   * @param {{omitParentTaskIds?: string[]|Set<string>}} [options] - 透传给 buildSnapshotPayload
   *   的排除集合（显式回收的候选快照）。
   * @returns {{payload:object, bytes:number|null, degraded:boolean}}
   */
  function serializeSnapshotEnvelope(options = {}) {
    try {
      const text = JSON.stringify(buildSnapshotPayload(options));
      return { payload: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8"), degraded: false };
    } catch (error) {
      const violation = describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "serialize",
        hint: "快照含不可 JSON 序列化的负载，已退化为最小安全快照",
      });
      // serialize 阶段：快照含不可 JSON 序列化负载。记录违规并发布 budget_rejected
      // （事件本身只带 violation 元数据，不回显任何快照负载）。
      noteBudgetViolation(violation, "serialize");
      warn("dsh-expert-group: fan-out snapshot is not JSON-serializable, degraded to minimal snapshot");
      return {
        payload: {
          version: SNAPSHOT_VERSION,
          sequence,
          nextTaskNumber,
          processInstance: PROCESS_INSTANCE,
          degraded: true,
          violation,
          tasks: [],
          events: [],
        },
        bytes: null,
        degraded: true,
      };
    }
  }

  /**
   * 可序列化快照（公开出口）：返回与内部状态隔离的深拷贝，永不抛异常。
   *
   * 与落盘路径共用同一个 envelope：内容与体积来自同一次 stringify，degraded 语义也不
   * 会有第二套实现。读路径虽然用不到 bytes，代价只是一次 O(文本长度) 的字节统计，
   * 远小于 stringify/parse 本身。
   */
  function serializeSnapshot() {
    return serializeSnapshotEnvelope().payload;
  }

  // -------------------------------------------------------------------------
  // 显式任务回收（票据 05：两阶段，先落盘成功再移除）
  // -------------------------------------------------------------------------

  /** 回收屏障期间的统一写入口拒绝（结构固定，Host/RPC 直接透传）。 */
  function reclaimInProgressResult() {
    return {
      accepted: false,
      changed: false,
      code: RECLAIM_IN_PROGRESS_CODE,
      reason: "reclaim_in_progress",
    };
  }

  /** 迟到回调的统一 no-op 结果（不复活、不改统计、不写事件/快照）。 */
  function taskReclaimedResult(parentTaskId) {
    return {
      accepted: false,
      changed: false,
      code: TASK_RECLAIMED_CODE,
      reason: "task_reclaimed",
      ...(typeof parentTaskId === "string" && parentTaskId.length > 0 ? { parentTaskId } : {}),
    };
  }

  /**
   * 记一个已回收任务 id（有界，仅用于迟到回调识别）。
   *
   * 插入序淘汰最旧项：上限 256 远大于单次请求可回收的父任务数（maxTasks=64），
   * 因此同一批回收的 id 不会被自己挤掉。
   */
  function rememberReclaimedTask(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    reclaimedTaskIds.delete(parentTaskId);
    reclaimedTaskIds.add(parentTaskId);
    while (reclaimedTaskIds.size > RECLAIMED_TASK_MEMORY) {
      const oldest = reclaimedTaskIds.values().next().value;
      reclaimedTaskIds.delete(oldest);
    }
  }

  /**
   * 同 id 被重新登记（submit 显式 parentTaskId / restore）时清除回收标记。
   *
   * 不清除会让新任务的迟到回调被误判成"任务已回收"（task_reclaimed no-op），
   * 从而吞掉合法证据。因此回收标记的生命周期严格限制在"id 仍空缺"的窗口内。
   */
  function forgetReclaimedTask(parentTaskId) {
    if (typeof parentTaskId === "string" && parentTaskId.length > 0) reclaimedTaskIds.delete(parentTaskId);
  }

  /**
   * 单个任务的回收前置条件判定（prepareReclaim 与 reclaimable 计数共用唯一实现）。
   *
   * 返回 null 表示可回收；否则返回稳定原因码：
   * - task_not_found：任务已不存在；
   * - task_not_terminal：仍有 queued/running 分片，或任务尚未结算；
   * - stop_unconfirmed：存在"已逻辑终态但停止未确认"的 attempt（执行体可能仍在写盘）。
   *
   * parentCancelRequested 不构成阻塞：cancelled 任务本来就是可回收的终态。
   *
   * @param {object|undefined} task - 内部任务状态。
   * @returns {"task_not_found"|"task_not_terminal"|"stop_unconfirmed"|null}
   */
  function reclaimBlockReason(task) {
    if (task === undefined) return "task_not_found";
    // 仍有未终态分片：任务还会产生状态变化，绝不能在落盘候选里冻结它。
    if (task.shards.some((shard) => shard.status === "queued" || shard.status === "running")) {
      return "task_not_terminal";
    }
    // 停止未确认优先于"未结算"：原因更具体、处置方向明确（补证据或等待看门狗/老化）。
    if (countStopPending(task) !== 0) return "stop_unconfirmed";
    const terminalStatus = task.status === "completed"
      || task.status === "completed_with_errors"
      || task.status === "cancelled";
    if (!terminalStatus || typeof task.settledAt !== "number") return "task_not_terminal";
    return null;
  }

  /** 当前可回收任务数（容量拒绝的 reclaimable 字段与诊断共用）。 */
  function countReclaimableTasks() {
    let total = 0;
    for (const task of tasks.values()) {
      if (reclaimBlockReason(task) === null) total += 1;
    }
    return total;
  }

  /**
   * 第一阶段：筛选可回收任务、立起屏障并生成候选快照。
   *
   * 返回结构（稳定契约）：
   * - 接受：{ accepted:true, token, parentTaskIds, candidate, bytes, skipped }；
   * - 拒绝：{ accepted:false, code, reason, message?, parentTaskIds:[], skipped }。
   *
   * 拒绝码：
   * - RECLAIM_IN_PROGRESS：已有回收在途（同一临界区串行）；
   * - MANAGER_CLOSED：manager 已关闭；
   * - INVALID_RECLAIM_INPUT：入参不是非空字符串数组、含非法项、去重后为空或超过 maxTasks；
   * - NO_RECLAIMABLE_TASKS：所有给定任务都进 skipped（不存在/未结算/停止未确认）；
   * - RECLAIM_SNAPSHOT_DEGRADED / RECLAIM_SNAPSHOT_OVERSIZE：候选快照不过闸门。
   *
   * 任一项不满足前置条件时只进 skipped（逐个原因码），不阻断其它可回收任务；
   * 但"一个都不能回收"时整体拒绝，且不留下屏障。
   *
   * @param {string[]} parentTaskIds - 待回收父任务 id（去重后按输入顺序）。
   * @returns {object}
   */
  function prepareReclaim(parentTaskIds) {
    if (closed) {
      return { accepted: false, code: "MANAGER_CLOSED", reason: "manager_closed", parentTaskIds: [], skipped: [] };
    }
    if (reclaimState !== null) {
      return { ...reclaimInProgressResult(), parentTaskIds: [], skipped: [] };
    }
    if (!Array.isArray(parentTaskIds)) {
      return {
        accepted: false,
        code: "INVALID_RECLAIM_INPUT",
        reason: "invalid_parent_task_ids",
        message: "parentTaskIds 必须是非空字符串数组",
        parentTaskIds: [],
        skipped: [],
      };
    }
    const ids = [];
    const seen = new Set();
    for (const raw of parentTaskIds) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (id.length === 0) {
        return {
          accepted: false,
          code: "INVALID_RECLAIM_INPUT",
          reason: "invalid_parent_task_ids",
          message: "parentTaskIds 只能包含非空字符串",
          parentTaskIds: [],
          skipped: [],
        };
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (ids.length === 0) {
      return {
        accepted: false,
        code: "INVALID_RECLAIM_INPUT",
        reason: "invalid_parent_task_ids",
        message: "parentTaskIds 不能为空",
        parentTaskIds: [],
        skipped: [],
      };
    }
    if (ids.length > budgetPolicy.maxTasks) {
      return {
        accepted: false,
        code: "INVALID_RECLAIM_INPUT",
        reason: "invalid_parent_task_ids",
        message: "单次最多回收 " + budgetPolicy.maxTasks + " 个父任务",
        parentTaskIds: [],
        skipped: [],
      };
    }
    const skipped = [];
    const eligible = [];
    for (const id of ids) {
      const blockReason = reclaimBlockReason(tasks.get(id));
      if (blockReason === null) {
        eligible.push(id);
      } else {
        skipped.push({ parentTaskId: id, reason: blockReason });
      }
    }
    if (eligible.length === 0) {
      return {
        accepted: false,
        code: "NO_RECLAIMABLE_TASKS",
        reason: "no_reclaimable_tasks",
        parentTaskIds: [],
        skipped,
      };
    }
    const token = "reclaim-" + (++reclaimSequence);
    // 先立屏障再序列化：候选快照从这一刻起就是"唯一权威的待落盘状态"，
    // 序列化期间不可能有公开写入口插入状态变化（同步临界区 + 屏障双重保证）。
    reclaimState = { token, parentTaskIds: new Set(eligible), candidate: null, bytes: null };
    const envelope = serializeSnapshotEnvelope({ omitParentTaskIds: eligible });
    if (envelope.degraded === true || envelope.bytes === null) {
      reclaimState = null;
      return {
        accepted: false,
        code: "RECLAIM_SNAPSHOT_DEGRADED",
        reason: "reclaim_snapshot_degraded",
        message: "候选快照含不可 JSON 序列化负载，已中止回收",
        parentTaskIds: [],
        skipped,
        ...(envelope.degraded === true && envelope.payload?.violation ? { violation: envelope.payload.violation } : {}),
      };
    }
    const sizeVerdict = snapshotSizeVerdict(envelope.bytes);
    if (!sizeVerdict.ok) {
      reclaimState = null;
      return {
        accepted: false,
        code: "RECLAIM_SNAPSHOT_OVERSIZE",
        reason: "reclaim_snapshot_oversize",
        message: sizeVerdict.violation.message,
        parentTaskIds: [],
        skipped,
        violation: sizeVerdict.violation,
      };
    }
    reclaimState.candidate = envelope.payload;
    reclaimState.bytes = envelope.bytes;
    return {
      accepted: true,
      token,
      parentTaskIds: eligible,
      candidate: envelope.payload,
      bytes: envelope.bytes,
      skipped,
    };
  }

  /**
   * 第二阶段：把已确认落盘的候选快照对应任务从内存与全部派生索引移除。
   *
   * 前置条件：token 必须与当前屏障一致（迟到的 commit 不得命中新的回收）。
   * 移除范围：tasks / requestIndex / continuationRequestOwners / role 索引 /
   * 影响范围索引 / 任务级计数 / 轮转游标；回收后的同 requestId 再提交视为新任务
   * （去重索引随任务一起删除，不保留任何墓碑）。
   *
   * 关闭竞态（票据 05 修复）：**唯一门槛是 token 与回收屏障，不看 closed**。
   * Host 的回收是「先 await 落盘候选成功、再 commit」，close 可能正好落在这次 await 里；
   * 候选快照已经真实落盘（磁盘已排除待回收任务），此时拒绝 commit 会让磁盘与内存分叉，
   * 重启后任务凭空“消失”。因此关闭后仍照常移除任务、清理索引、写迟到回调标记；
   * 但关闭后没有调度/落盘/事件语义，所以 **不** emit tasks_reclaimed、
   * **不** notifyPersistence、**不** schedule。
   *
   * 打开状态下完成后：清空屏障、发一条只含 id 与数量的 tasks_reclaimed 诊断事件、
   * notifyPersistence 让"回收后的状态 + 屏障期间其它任务的事件"追平磁盘
   * （Host 仍需自行清理归属索引），并恢复被屏障暂停的派发。
   *
   * @param {string} token - prepareReclaim 返回的 token。
   * @returns {object} { accepted, reclaimed, count } 或结构化拒绝。
   */
  function commitReclaim(token) {
    if (reclaimState === null) {
      return { accepted: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_not_prepared", reclaimed: [], count: 0 };
    }
    if (typeof token !== "string" || token !== reclaimState.token) {
      return { accepted: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_token_invalid", reclaimed: [], count: 0 };
    }
    const state = reclaimState;
    const reclaimed = [...state.parentTaskIds];
    for (const parentTaskId of reclaimed) {
      const task = tasks.get(parentTaskId);
      if (task === undefined) {
        // 防御性路径：屏障期间公开写入口全部拒绝，任务不可能消失；真发生时只跳过，
        // 不中断整批回收（其余任务的状态仍是权威的）。
        rememberReclaimedTask(parentTaskId);
        continue;
      }
      tasks.delete(parentTaskId);
      // requestId 去重索引随任务删除：之后同 requestId 视为新任务（票据 05/09 裁决）。
      if (task.requestId !== undefined && requestIndex.get(task.requestId) === parentTaskId) {
        requestIndex.delete(task.requestId);
      }
      for (const [requestId, ownerId] of [...continuationRequestOwners]) {
        if (ownerId === parentTaskId) continuationRequestOwners.delete(requestId);
      }
      removeTaskIndex(task);
      // 迟到回调识别标记：任务对象上留标记，迟到回调持有的是这个对象引用。
      task.reclaimed = true;
      rememberReclaimedTask(parentTaskId);
    }
    // 轮转游标必须随 role 索引一起收敛：role 已被整批回收时删游标，否则取模夹紧，
    // 保证下一次派发不会越界（dispatchAvailable 还会再兜一次，但索引本身应保持有效）。
    for (const [role, cursor] of [...rotationCursors]) {
      const parents = parentsByRole.get(role);
      if (parents === undefined || parents.length === 0) {
        rotationCursors.delete(role);
      } else if (!Number.isInteger(cursor) || cursor < 0) {
        rotationCursors.set(role, 0);
      } else if (cursor >= parents.length) {
        rotationCursors.set(role, cursor % parents.length);
      }
    }
    reclaimState = null;
    // 关闭后不再有调度/持久化/事件语义：任务移除已按磁盘候选完成，但补发事件、触发落盘
    // 或重新调度都属于关闭之后的新语义，必须全部跳过（fail-closed，不伪造关闭后的活动）。
    if (!closed) {
      emit({
        type: "tasks_reclaimed",
        parentTaskIds: reclaimed,
        count: reclaimed.length,
      });
      notifyPersistence();
      // 屏障期间被暂停的排队工作恢复派发（被回收任务本身已不在索引里）。
      schedule();
    }
    return { accepted: true, changed: true, reclaimed, count: reclaimed.length };
  }

  /**
   * 中止回收：只清屏障，不改任何任务状态（落盘失败或候选快照被拒绝时的唯一出口）。
   *
   * 关闭竞态（票据 05 修复）：close() 不再清空屏障，因此关闭后调用方仍能（也必须能）
   * 用同一 token abort；这里不因 closed 拒绝。但关闭后没有调度语义，所以不再 schedule
   * （schedule 自身也会 no-op，这里显式跳过以表达关闭边界，而不是靠副作用兜底）。
   *
   * @param {string} token - prepareReclaim 返回的 token。
   * @returns {{accepted:boolean, changed:false, reason?:string, code?:string}}
   */
  function abortReclaim(token) {
    if (reclaimState === null) {
      return { accepted: false, changed: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_not_prepared" };
    }
    if (typeof token !== "string" || token !== reclaimState.token) {
      return { accepted: false, changed: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_token_invalid" };
    }
    reclaimState = null;
    // 屏障期间调度被暂停：中止后必须恢复，否则排队任务会永久停摆。
    // 关闭后没有调度语义：屏障仍要清（否则 token 永远悬挂），但绝不再排一次 drain。
    if (!closed) schedule();
    return { accepted: true, changed: false, reason: "reclaim_aborted" };
  }

  // -------------------------------------------------------------------------
  // 调度器：per-role 限流 + 父任务轮转
  // -------------------------------------------------------------------------

  function activeCountsByRole() {
    // running 计数在状态转移处同步维护；返回副本避免 dispatch 修改派生索引。
    return new Map(runningCountsByRole);
  }

  function activeCountsByTask() {
    // 同上：任务级计数同样是派生索引，dispatch 只在副本上做本轮预算。
    return new Map(runningCountsByTask);
  }

  function activeCountsByProvider() {
    // provider 份额同样是派生索引：dispatch 在副本上累计本轮派发，避免边派发边改写
    // 权威计数（权威计数仍只在 setShardStatus 处更新）。
    return new Map(runningCountsByProvider);
  }

  /** 取（或创建）某个限流键的统计条目；键数量有硬上界，避免诊断面无限增长。 */
  function throttleStatsFor(kind, key) {
    const map = throttleStats[kind];
    let entry = map.get(key);
    if (entry !== undefined) return entry;
    entry = { lastThrottledAt: undefined, episodeStartedAt: undefined, samples: 0, totalWaitMs: 0 };
    map.set(key, entry);
    while (map.size > THROTTLE_STATS_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === key) break;
      map.delete(oldest);
    }
    return entry;
  }

  /**
   * 记录一次「因名额不足而跳过该候选」的事实。
   *
   * 只写诊断时间戳：episodeStartedAt 只在**一个连续限流窗口的第一帧**设置，后续被
   * 挡住的派发只刷新 lastThrottledAt，不会篡改窗口起点（否则 etaMs 会被无限拉短）。
   */
  function noteThrottled(kind, key) {
    const at = now();
    const entry = throttleStatsFor(kind, key);
    entry.lastThrottledAt = at;
    if (entry.episodeStartedAt === undefined) entry.episodeStartedAt = at;
  }

  /**
   * 某个键下真正派发成功后采样一次「限流窗口时长」。
   *
   * 没有进行中的窗口（从未被挡住，或上一个窗口已经采样）时是 no-op：只在真实发生过
   * 排队的情况下累计样本，绝不把正常直接派发的 0 等待混进平均。
   */
  function noteDispatchReleased(kind, key) {
    const entry = throttleStats[kind]?.get(key);
    if (entry === undefined || entry.episodeStartedAt === undefined) return;
    entry.samples += 1;
    entry.totalWaitMs += Math.max(0, now() - entry.episodeStartedAt);
    entry.episodeStartedAt = undefined;
  }

  /**
   * 限流与排队诊断（票据 26，只读）：按 role 与 provider 投影 limit/running/queued/
   * lastThrottledAt/etaMs。
   *
   * 数据来源只有三处，且都不是新计数器：
   * - running：runningCountsByRole / runningCountsByProvider（与调度同一来源）；
   * - queued：直接数 shard.status === "queued"（排队就是状态，不存在第二套队列）；
   * - limit：resolveRoleLimits/resolveProviderLimits + 默认值。
   *
   * etaMs 只在历史样本 ≥ THROTTLE_ETA_MIN_SAMPLES 时给出简单均值，否则显式
   * null + etaSource:"unknown"——不伪造精确值。
   */
  function throttleDiagnostics() {
    const roles = resolveRoleLimits();
    const providers = resolveProviderLimits();
    const defaultLimit = resolveDefaultConcurrencyLimit();
    const queuedByRole = new Map();
    const queuedByProvider = new Map();
    const roleKeys = new Set([...parentsByRole.keys(), ...Object.keys(roles)]);
    const providerKeys = new Set(Object.keys(providers));
    // 任务数与分片数都有预算上界（resource-budget），因此这里是常数级聚合。
    for (const task of tasks.values()) {
      const provider = typeof task.provider === "string" && task.provider.length > 0 ? task.provider : undefined;
      if (provider !== undefined) providerKeys.add(provider);
      for (const shard of task.shards) {
        if (shard.status !== "queued") continue;
        queuedByRole.set(task.role, (queuedByRole.get(task.role) ?? 0) + 1);
        if (provider !== undefined) queuedByProvider.set(provider, (queuedByProvider.get(provider) ?? 0) + 1);
      }
    }
    const roleRows = {};
    for (const role of roleKeys) {
      roleRows[role] = throttleRow("role", role, {
        limit: typeof roles[role] === "number" ? roles[role] : defaultLimit,
        running: runningCountsByRole.get(role) ?? 0,
        queued: queuedByRole.get(role) ?? 0,
      });
    }
    const providerRows = {};
    for (const provider of providerKeys) {
      providerRows[provider] = throttleRow("provider", provider, {
        // provider 限流用 0 表示「不限制」：诊断如实投影 0，而不是省略或改写成默认值。
        limit: typeof providers[provider] === "number" ? providers[provider] : 0,
        running: runningCountsByProvider.get(provider) ?? 0,
        queued: queuedByProvider.get(provider) ?? 0,
      });
    }
    return Object.freeze({
      roles: Object.freeze(roleRows),
      providers: Object.freeze(providerRows),
      etaMinSamples: THROTTLE_ETA_MIN_SAMPLES,
    });
  }

  /** 单行限流诊断（只含标量/固定枚举，可直接进入 RPC/meta 投影）。 */
  function throttleRow(kind, key, { limit, running, queued }) {
    const entry = throttleStats[kind].get(key);
    const samples = entry?.samples ?? 0;
    const hasEta = samples >= THROTTLE_ETA_MIN_SAMPLES;
    return Object.freeze({
      limit,
      running,
      queued,
      lastThrottledAt: entry?.lastThrottledAt === undefined ? null : entry.lastThrottledAt,
      etaMs: hasEta ? Math.round(entry.totalWaitMs / samples) : null,
      etaSource: hasEta ? "historical-average" : "unknown",
      samples,
    });
  }

  /**
   * 派发一轮：每个 role 在「父任务轮转顺序」上取下一个可派发 shard。
   * 轮转游标按 role 维护，保证后来的父任务不会因为前面有大量排队 shard 而饿死。
   *
   * 并发判定是两层独立约束（见模块头设计要点 2）：role 共享池上限约束整个 role，
   * 任务级上限只约束当前候选父任务自身，两者必须同时满足才允许派发。
   */
  function dispatchAvailable() {
    if (closed || restoreDispatchSuppressed) return false;
    // 回收屏障期间暂停**派发**（不暂停既有 child 的 completion/超时收敛）：
    // 候选快照落盘窗口里不应再启动新的 child，否则候选与 commit 时的任务集合可能发散。
    if (reclaimState !== null) return false;
    const roleActiveCounts = activeCountsByRole();
    const taskActiveCounts = activeCountsByTask();
    // provider 份额同样用本轮副本：权威计数只在 setShardStatus 处更新。
    const providerActiveCounts = activeCountsByProvider();
    // parentsByRole 保持首次注册 role 的顺序，避免每轮遍历整个 tasks 表。
    const roles = [...parentsByRole.keys()];

    let dispatched = false;
    for (const role of roles) {
      // 本轮使用索引快照，避免 running 事件重入 submit 改变本轮公平序列。
      const parents = [...(parentsByRole.get(role) ?? [])];
      if (parents.length === 0) continue;
      let cursor = rotationCursors.get(role) ?? 0;
      if (!Number.isInteger(cursor) || cursor < 0 || cursor >= parents.length) cursor = 0;
      // 本 role 共享池当前已占用的槽位；每派发一个 shard 就 +1，直到达到池上限。
      let used = roleActiveCounts.get(role) ?? 0;
      // provider 级上限同样在一轮开始时解析一次：它是设置级配置，对同 role 下所有
      // 任务都相同；设置保存后下一轮 drain 立即读到新值（不做任何缓存）。
      const resolvedProviderLimits = resolveProviderLimits();
      /**
       * role 池已满的快速短路：本 role 本轮没有任何可派发的候选，直接进入下一个 role。
       *
       * 与「先 provider 后 role」不矛盾：role 名额是候选派发的最后一道闸门，池子已满时
       * 任何候选都不可能通过，因此跳过 provider 判定不改变任何派发决策，也不会占用或
       * 预留任何名额；它只是避免空转，并保留父任务轮转游标不被无意义推进。
       *
       * 必须放在轮转循环之前而不是只放在循环内：否则每次 drain 都会先把游标推进一格
       * 才因为池满 break，多轮 drain 累积下来就破坏了父任务轮转公平性（大型任务会
       * 抢占后来者的槽位）。这里只记录一次 role 限流事实，不推进游标。
       */
      if (used >= rolePoolLimitFor(parents[0])) {
        noteThrottled("role", role);
        continue;
      }
      // 轮转预算：一圈内每个父任务最多贡献一个 shard，保证公平性；
      // 若一圈后仍有空槽位（例如某个父任务已无排队 shard），允许再走一圈补齐，
      // 这样并发上限才真正被填满，而不是每轮只启动一个。
      let budget = parents.length;
      // 连续遇到「本轮无法产出」的父任务计数。只有轮转一整圈都没有任何产出才停止：
      // 某个父任务被**自身任务级上限**或 **provider 名额**卡住时仍有其它父任务可以派发，
      // 因此它只能算"本轮无产出"，不能直接终止整个 role 的派发（否则高上限的任务会被
      // 低上限的邻居饿死）。无排队 shard / 冲突判定失败同样属于"本轮无产出"。
      let blockedInARow = 0;
      while (budget > 0) {
        const task = parents[cursor % parents.length];
        cursor = (cursor + 1) % parents.length;
        budget -= 1;
        /**
         * 名额判定顺序（票据 26 / 规格书 §3）：**先 provider，后 role**。
         *
         * 为什么顺序重要：两者都是非阻塞判定、失败都不占任何名额，但诊断需要如实反映
         * "真正卡住这一帧的是哪个维度"。provider 是跨角色的共享资源，先判定它可以让
         * provider 满时直接跳过该任务（不消耗、也不虚假占用 role 名额），并且不会因为
         * role 池刚好满而把限流原因记到 role 名下。
         *
         * 判定通过后名额仍只在 startShard 真正把分片推进到 running 时才占用——
         * 排队不占名额、不做预留，因此这里读到的 used/usedProvider 可以安全地只用于比较。
         */
        const providerLimit = providerLimitOf(task, resolvedProviderLimits);
        if (providerLimit !== undefined) {
          const usedProvider = providerActiveCounts.get(task.provider) ?? 0;
          if (usedProvider >= providerLimit) {
            // provider 满：跳过该任务并记为"本轮无产出"，绝不启动 child、绝不占 role 名额。
            noteThrottled("provider", task.provider);
            blockedInARow += 1;
            if (blockedInARow >= parents.length) break;
            continue;
          }
        }
        // role 共享池上限只看 role 级设置/默认值，不读任何任务的 concurrencyLimit，
        // 因此同一 role 下所有父任务解析出的池上限必然相同（循环内重复求值成本极低）。
        // 池子满时整个 role 都不可能再派发：直接结束本 role，避免空转一圈。
        if (used >= rolePoolLimitFor(task)) {
          noteThrottled("role", role);
          break;
        }
        // 任务级上限只与**该父任务自身**的 running 数比较：其它父任务占用 role 槽位
        // 不再影响它（旧实现拿 role 全局计数比较，导致低上限任务被别的任务饿死）。
        const taskLimit = taskLimitFor(task);
        if (taskLimit !== undefined && (taskActiveCounts.get(task) ?? 0) >= taskLimit) {
          blockedInARow += 1;
          if (blockedInARow >= parents.length) break;
          continue;
        }
        const shard = task.shards.find((entry) => entry.status === "queued" && (
          entry.cancelRequested !== true
          || entry.attempts[entry.attempts.length - 1]?.attempt > 1
        ));
        if (shard === undefined) {
          // 该父任务已无排队 shard：本轮没有产出，但它的存在不应顺手终结整个 role。
          blockedInARow += 1;
          if (blockedInARow >= parents.length) break;
          continue;
        }
        // retryShard 会重新进入队列；重新 admission 前复用同一 conflictChecker，
        // 只阻止当前候选与其它活动 shard 的明显冲突，不引入路径解析语义。
        const otherShards = collectConflictCandidates(task.role, shard, shard);
        const conflict = findConflict(task.role, shard, otherShards);
        if (conflict !== null && !task.allowOverlap) {
          blockedInARow += 1;
          if (blockedInARow >= parents.length) break;
          continue;
        }
        if (startShard(task, shard)) {
          dispatched = true;
          used += 1;
          // 任务级计数必须在本轮内同步自增：入口快照只是基线（避免 running 事件
          // 重入改变公平序列），但本轮刚派发的 shard 若不立即计入本地计数，同一
          // 次 drain 的内层循环（budget 重置允许连续派发同一任务）会读到过期值，
          // 使任务越过自身任务级上限——快照要等下一次 dispatchAvailable 才刷新。
          taskActiveCounts.set(task, (taskActiveCounts.get(task) ?? 0) + 1);
          // provider 份额同理必须在本轮内同步累计：否则同一 drain 里连续派发多个
          // 同 provider 分片时会读到过期份额，直接超发。
          if (providerLimit !== undefined) {
            providerActiveCounts.set(task.provider, (providerActiveCounts.get(task.provider) ?? 0) + 1);
            // 真正派发成功 = 该 provider 的限流窗口结束，采样一次等待时长（诊断用）。
            noteDispatchReleased("provider", task.provider);
          }
          noteDispatchReleased("role", role);
          blockedInARow = 0;
          if (closed) break;
          // role 共享池在派发过程中可能刚好被填满（例如另一路径同步派发），逐次复核；
          // 一旦填满就停止本 role 的派发，保证 role 全局 running 不越过池上限。
          if (used >= rolePoolLimitFor(task)) break;
          // provider 名额同样逐次复核：填满后本 role 内同 provider 的任务不再尝试。
          if (providerLimit !== undefined && (providerActiveCounts.get(task.provider) ?? 0) >= providerLimit) {
            budget = parents.length;
            continue;
          }
          // 有新 shard 进入 running 后，重新评估其它父任务的排队情况。
          budget = parents.length;
        }
      }
      rotationCursors.set(role, cursor % parents.length);
    }
    return dispatched;
  }

  /**
   * drain 的持久化批包装。
   *
   * 一次 drain 可能在同一个同步批里连续启动多个 shard（每个都发 running 事件并登记
   * 句柄），也可能同步结算 shard；这些状态变化只允许序列化/落盘一次。drain 自身在
   * finally 里可能再排下一轮微任务，那时属于新的批（新的 tick 会带来新的变化）。
   */
  function drainBatch() {
    withPersistenceBatch(drain);
  }

  function drain() {
    try {
      // 派发可能同步完成一个 shard，从而释放槽位并产生新的可派发 shard，
      // 因此循环直到没有新的派发发生为止。
      while (dispatchAvailable()) {
        // 循环体为空：dispatchAvailable 内部完成状态推进。
      }
    } finally {
      // 关键：只要 drain 期间又产生了新的调度请求，就再排一次微任务继续派发，并且不
      // resolve drainPromise。whenIdle() 因此一定等到稳定态，不会让调用方看到中间态。
      if (workRequested) {
        workRequested = false;
        queueMicrotask(drainBatch);
      } else {
        drainScheduled = false;
        const resolve = resolveDrain;
        resolveDrain = undefined;
        if (resolve !== undefined) resolve();
      }
    }
  }

  /**
   * 请求一次调度。
   * - pending 表示「还有派发工作要做」；
   * - drainScheduled 表示「已经排好一次 drain 微任务」；
   * - drainPromise 只在最后一次 drain 结束时 resolve，因此 whenIdle() 一定等到稳定态。
   */
  function schedule() {
    if (closed) return Promise.resolve();
    restoreDispatchSuppressed = false;
    workRequested = true;
    if (!drainScheduled) {
      drainScheduled = true;
      // 进入 drain 前先清掉请求标记；drain 期间再次 schedule() 会重新置位，
      // 由 finally 决定是否再排一轮。
      workRequested = false;
      drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
      queueMicrotask(drainBatch);
    }
    return drainPromise;
  }

  // -------------------------------------------------------------------------
  // shard 生命周期
  // -------------------------------------------------------------------------

  /**
   * 解析角色级默认超时（票据 06 的第三级来源）。
   *
   * 这里只读、不缓存：设置页保存后，之后创建的 attempt 立即使用新值，
   * 而已经在运行的 attempt 不会被改写（它们的超时在创建时已写进 attempt.timeoutMs）。
   *
   * 解析函数抛错或返回非法值一律按「未启用」处理：配置错误不能让派发失败。
   *
   * @returns {number|undefined} 0 表示角色级显式禁用；undefined 表示角色级未配置。
   */
  function resolveRoleTimeoutMs() {
    if (typeof rawRoleTimeoutMs !== "function") return staticRoleTimeoutMs;
    let raw;
    try {
      raw = rawRoleTimeoutMs();
    } catch {
      // 解析函数读的是外部 settings：异常只允许降级，不能让派发抛错。
      return undefined;
    }
    return normalizeTimeoutMs(raw);
  }

  /**
   * 单个 attempt 的超时解析（优先级的唯一实现，票据 06）：
   * shard 显式（含 0）> 父任务默认（含 0）> 角色默认（含 0）> 未启用。
   *
   * 只在**创建 attempt 时**调用一次，结果写入 attempt.timeoutMs：
   * 运行中的超时因此不会因后续设置/父任务默认变化而改变。
   *
   * @param {number|undefined} taskDefaultTimeoutMs - task.timeoutMs（只含显式值）。
   * @param {number|undefined} shardTimeoutMs - shard.timeoutMs（只含显式值）。
   * @returns {number|undefined}
   */
  function resolveAttemptTimeoutMs(taskDefaultTimeoutMs, shardTimeoutMs) {
    if (typeof shardTimeoutMs === "number") return shardTimeoutMs;
    if (typeof taskDefaultTimeoutMs === "number") return taskDefaultTimeoutMs;
    return resolveRoleTimeoutMs();
  }

  /**
   * 新建一个 attempt。
   *
   * 超时在这里解析一次并固化到 attempt.timeoutMs（三级优先级见 resolveAttemptTimeoutMs）。
   *
   * @param {object} task - 所属父任务（提供父任务级默认超时）。
   * @param {object} shard - 所属 shard（继承 affectedPaths/timeoutMs）。
   * @param {number} attemptNumber - attempt 序号（同一 shard 内单调递增，历史不可覆盖）。
   * @param {object} [extra] - 追加字段。多轮 continuation 用 `{ continuation: true, childId }`
   *   标记「复用既有 child」——该标记只存在于内存 attempt 上，**不进快照**：冷恢复后原
   *   child 可能已不存在，恢复派发一律走 launcher 新建 child（与既有 restore 语义一致）。
   */
  function createAttempt(task, shard, attemptNumber, extra = {}) {
    const timeoutMs = resolveAttemptTimeoutMs(task.timeoutMs, shard.timeoutMs);
    return {
      attempt: attemptNumber,
      status: "queued",
      /**
       * attempt 身份（票据 07）：attemptId 跨重启稳定，executionGeneration 单调递增。
       *
       * 二者共同构成停止证据的寻址键：Host 只能提交"父任务 + 分片 + attempt 序号 +
       * attemptId + executionGeneration"全部精确匹配的证据；任一不匹配就是 stale，
       * 不产生任何状态变更。只有 attemptId 是不够的——同一个 attemptId 的旧执行代次
       * 迟到回调仍可能携带旧代次，代次负责把这类迟到隔离在门外。
       */
      attemptId: deriveAttemptId(task.parentTaskId, shard.shardId, attemptNumber),
      executionGeneration: ++nextExecutionGeneration,
      // 默认 unknown：管理器不因为"自己发了取消"就假定执行已停止。
      stopEvidence: { state: STOP_EVIDENCE_STATE_UNKNOWN },
      startedAt: undefined,
      finishedAt: undefined,
      affectedPaths: [...shard.affectedPaths],
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...extra,
    };
  }

  /**
   * attempt 预算的**唯一**判定入口（retry / continue / restore resume 共用）。
   *
   * 判定对象是「新建之后」的 attempt 数（attempts.length + 1）：因此恰好允许
   * maxAttemptsPerShard 个 attempt 存在，只有再多一个才超限。三个入口必须复用本函数，
   * 否则会出现「恢复续跑放宽一档」的语义漂移——一旦写进第 limit+1 个 attempt，
   * 下次 restore 会被 checkRestoreBudget **整体**拒绝，整份快照从此不可恢复。
   *
   * 本函数只读：绝不修改 shard、attempt 或任务状态；拒绝的处置（事件/返回值/原因码）
   * 由各入口按自己的契约决定。
   *
   * @param {object} shard - 目标 shard（读取 attempts.length 与预算上限）。
   * @param {string} field - 违规定位的字段名（如 "attempt" 或 "shard <id>"）。
   * @param {string} hint - 面向调用方的处置建议（不同入口的建议不同）。
   * @returns {null|{reason:string, attempts:number, limit:number, violation:object}}
   *   null 表示仍可新建 attempt；否则 reason 固定为 attempt_budget_exceeded，
   *   attempts 是**当前已有**的 attempt 数（不是新建后的数量）。
   */
  function attemptBudgetVerdict(shard, field, hint) {
    const attempts = shard.attempts.length;
    const limit = budgetPolicy.maxAttemptsPerShard;
    const violation = budgetVerdict("attempts", limit, attempts + 1, field, hint);
    if (violation === null) return null;
    return { reason: "attempt_budget_exceeded", attempts, limit, violation: violation.violation };
  }

  function updateShardStatus(task, shard, status) {
    setShardStatus(task, shard, status);
    shard.updatedAt = now();
    task.updatedAt = shard.updatedAt;
  }

  /**
   * 某 shard 之前各轮已绑定的 messageId 集合（不含最新 attempt）。
   *
   * 只服务 continuation 的严格归属校验：本轮 messageId 必须既非空、也不属于这个集合，
   * 否则「同一 child 的旧轮 turn/end」可以冒充新一轮并提前结算。上限由 attempt 预算约束
   * （≤ maxAttemptsPerShard 条），因此不需要额外裁剪。
   */
  function previousMessageIdsFor(shard) {
    const ids = [];
    for (let index = 0; index < shard.attempts.length - 1; index += 1) {
      const messageId = shard.attempts[index]?.messageId;
      if (typeof messageId === "string" && messageId.length > 0) ids.push(messageId);
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // 停止证据（票据 07）
  // -------------------------------------------------------------------------

  /** 清除 attempt 的停止看门狗定时器（句柄只存内存，不进快照）。 */
  function clearAttemptStopTimer(attempt) {
    if (attempt?.stopTimer === undefined) return;
    clearTimeoutFn(attempt.stopTimer);
    attempt.stopTimer = undefined;
  }

  /**
   * 归一化一条停止证据，校验来源白名单与证据摘要形状。
   *
   * 只接受 JSON 安全的摘要字段（childId/messageId/sessionId/turn），绝不接受任意自由文本：
   * 证据会进事件历史与快照，无界负载会让诊断面变成第二个资源风险。
   *
   * @param {unknown} raw - 原始证据。
   * @param {{allowedSources?: readonly string[], nowMs?: number}} [options]
   * @returns {{ok:true, evidence:object} | {ok:false, code:string, reason:string, message:string}}
   */
  function normalizeStopEvidence(raw, { allowedSources = STOP_EVIDENCE_SOURCES, nowMs } = {}) {
    const invalid = (message) => ({
      ok: false,
      code: "STOP_EVIDENCE_INVALID",
      reason: "stop_evidence_invalid",
      message,
    });
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("停止证据必须是对象");
    const source = typeof raw.source === "string" ? raw.source.trim() : "";
    if (source.length === 0) return invalid("停止证据必须给出 source");
    if (!allowedSources.includes(source)) return invalid("不接受的停止证据来源: " + source);
    const observedAt = typeof raw.observedAt === "number" && Number.isFinite(raw.observedAt) && raw.observedAt >= 0
      ? raw.observedAt
      : (nowMs ?? now());
    const evidence = { state: STOP_EVIDENCE_STATE_OBSERVED, source, observedAt };
    for (const field of ["childId", "messageId", "sessionId"]) {
      const value = raw[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.trim().length === 0) return invalid("停止证据字段 " + field + " 必须是非空字符串");
      evidence[field] = value.trim();
    }
    if (raw.turn !== undefined && raw.turn !== null) {
      if (!Number.isSafeInteger(raw.turn) || raw.turn < 0) return invalid("停止证据字段 turn 必须是非负整数");
      evidence.turn = raw.turn;
    }
    return { ok: true, evidence };
  }

  /**
   * 应用停止证据（唯一写入口）：只允许 unknown -> observed。
   *
   * 明确**不**做的事：不改写 attempt.status/result/error，不发逻辑结算事件，不重复计数。
   * 它只做三件事——写 evidence、清看门狗、刷新该 attempt 的影响范围索引。
   * 聚合由调用方在合适时机触发（settle 路径在 emit 之后统一聚合；观测路径直接聚合），
   * 这样「迟到证据补聚合」与「正常结算」共用同一条 gate。
   *
   * @returns {boolean} 是否真的从 unknown 变成 observed。
   */
  function applyStopEvidence(task, shard, attempt, evidence, { emitEvent = true } = {}) {
    if (isStopObserved(attempt)) return false;
    attempt.stopEvidence = { ...evidence, state: STOP_EVIDENCE_STATE_OBSERVED };
    clearAttemptStopTimer(attempt);
    syncAttemptScope(task, shard, attempt);
    if (emitEvent && !restoringSnapshot) {
      emit({
        type: "attempt_stop_observed",
        parentTaskId: task.parentTaskId,
        shardId: shard.shardId,
        role: task.role,
        attempt: attempt.attempt,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
        status: attempt.status,
        source: attempt.stopEvidence.source,
        released: isTerminalShardStatus(attempt.status),
      });
    }
    return true;
  }

  /**
   * 记录"已请求停止"并挂看门狗（票据 07）。
   *
   * 只写时间戳，不写证据：管理器自己发出的 cancel/timeout 永远不是停止证据。宽限到期时
   * 只由 expireStopWatchdog 记一次诊断，绝不自动释放范围/重试/聚合。
   *
   * @param {object} task - 父任务。
   * @param {object} shard - 分片。
   * @param {object} attempt - 目标 attempt。
   * @param {{watch?:boolean}} [options] - watch=false 用于 close（关闭时清定时器，不留悬挂）。
   */
  function markStopRequested(task, shard, attempt, { watch = true } = {}) {
    if (isStopObserved(attempt)) return;
    if (typeof attempt.stopRequestedAt !== "number") attempt.stopRequestedAt = now();
    attempt.stopDeadlineAt = attempt.stopRequestedAt + stopGraceMs;
    if (!watch) return;
    if (attempt.stopWatchdogExpiredAt !== undefined) return;
    if (attempt.stopTimer !== undefined) return;
    // 定时器回调是独立异步 tick，自成一个持久化批（诊断事件只序列化一次）。
    attempt.stopTimer = setTimeoutFn(
      () => withPersistenceBatch(() => expireStopWatchdog(task, shard, attempt)),
      stopGraceMs,
    );
    // unref：停止宽限只是诊断/看门狗，不是业务 deadline；生产进程不该被它钉住，测试进程
    // 也不该为每个未确认 attempt 多等 15 秒才退出。进程仍活跃时定时器照常触发。
    attempt.stopTimer?.unref?.();
  }

  /**
   * 停止宽限到期：只记 stopWatchdogExpiredAt 并发布**一次** attempt_stop_unconfirmed。
   *
   * 语义边界（票据 07 已裁决）：不释放影响范围、不重试、不聚合、不发完成通知、不改逻辑
   * 状态。它只回答"管理器等了这么久仍未收到权威停止证据"，供 Host 诊断与人工处置。
   */
  function expireStopWatchdog(task, shard, attempt) {
    attempt.stopTimer = undefined;
    if (isStopObserved(attempt)) return;
    if (attempt.stopWatchdogExpiredAt !== undefined) return;
    attempt.stopWatchdogExpiredAt = now();
    // 原因码区分超时与取消：两者的人工处置不同（超时通常重试，取消通常放弃）。
    const reason = attempt.terminalReason === "timeout" ? "timeout" : "cancel";
    lastStopWatchdog = {
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      reason,
      at: attempt.stopWatchdogExpiredAt,
    };
    emit({
      type: "attempt_stop_unconfirmed",
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      role: task.role,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      status: attempt.status,
      terminalReason: attempt.terminalReason,
      reason,
      stopRequestedAt: attempt.stopRequestedAt,
      stopDeadlineAt: attempt.stopDeadlineAt,
      stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt,
    });
    notifyPersistence();
  }

  /** 某 shard 中仍未确认停止的 attempt（重试/续作/恢复续跑 gate 的判定输入）。 */
  function unconfirmedStopAttempts(shard) {
    return shard.attempts.filter((attempt) => !isStopObserved(attempt));
  }

  /** 未确认停止 attempt 的结构化摘要（有界：attempt 预算封顶）。 */
  function unconfirmedStopSummary(attempt) {
    return {
      attempt: attempt.attempt,
      status: attempt.status,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      stopRequestedAt: attempt.stopRequestedAt ?? null,
      stopDeadlineAt: attempt.stopDeadlineAt ?? null,
      stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt ?? null,
      terminalReason: attempt.terminalReason ?? null,
      legacy: attempt.legacy === true,
    };
  }

  /**
   * shard 级停止 gate：只要还有 attempt 未确认停止，就不允许创建新 attempt。
   *
   * 为什么必须 fail-closed：超时 attempt 未停止时重试会覆盖旧 entry（旧实现按 shard 索引
   * 的真实缺陷），旧 child 的迟到写入将与新 attempt 并发写同一路径。因此拒绝时把未确认的
   * attempt 摘要带给调用方，Host 可以据此提交证据或转人工。
   *
   * @returns {null|{reason:string, shardId:string, attempts:object[]}}
   */
  function stopGateVerdict(shard) {
    const unconfirmed = unconfirmedStopAttempts(shard);
    if (unconfirmed.length === 0) return null;
    return {
      reason: "stop_unconfirmed",
      shardId: shard.shardId,
      attempts: unconfirmed.map(unconfirmedStopSummary),
    };
  }

  /**
   * shard 终态写入入口。所有路径（启动失败、child 完成、取消、超时、恢复）都收敛到
   * 这里，保证终态一次性且幂等：已进入终态的 shard 只拒绝并记录诊断，不被改写。
   *
   * 停止证据（票据 07）：
   * - 成功/失败路径由调用方传入可信 evidence（本模块的 completion/admission 回调就是
   *   证据来源），先于终态判定落库，因此迟到 completion 可以"只补证据不改状态"；
   * - 超时/取消路径不传证据，只写逻辑终态 + stopRequestedAt/stopDeadlineAt + 看门狗；
   * - queued 阶段被取消（从未 admission）可直接记 not-started 证据并释放范围。
   *
   * @param {object} task - 父任务。
   * @param {object} shard - 分片。
   * @param {object} attempt - 目标 attempt。
   * @param {string} status - 终态。
   * @param {{result?:unknown, error?:object, violation?:object, evidence?:object, reason?:string, watchStop?:boolean, needsAttention?:boolean}} [options]
   *   evidence：可信停止证据（source 必须在白名单内）；reason：结构化的终止原因码；
   *   watchStop=false 只用于 close（清定时器、不挂看门狗，但保留 unknown 状态）；
   *   needsAttention=true 只用于归属老化（事件带 needs_attention 标记，供 Host/UI 转人工）。
   */
  function settleShard(task, shard, attempt, status, {
    result,
    error,
    violation: presetViolation,
    evidence,
    reason,
    watchStop = true,
    needsAttention = false,
  } = {}) {
    // 已回收任务：任何迟到结算/证据都只做结构化 no-op（不复活、不改统计、不写事件/快照）。
    // 判定必须在预算/证据处理之前，否则迟到负载仍可能污染诊断与持久化。
    if (task?.reclaimed === true) return taskReclaimedResult(task.parentTaskId);
    if (!SHARD_STATUS_SET.has(status) || !isTerminalShardStatus(status)) {
      return rejectSettlement(task, shard, attempt, status, "invalid_status");
    }
    // 结果/错误的字节预算：超限必须显式失败并携带完整元数据，绝不写入被截断的内容，
    // 也不能把超限负载写进 attempt（否则事件、快照都会跟着无界增长）。
    // 判定发生在状态迁移之前，因此违规时该 shard 走同一条终态路径收敛为 failed。
    let payloadViolation = presetViolation ?? null;
    const payloadVerdict = presetViolation === undefined
      ? checkAttemptPayloadBudget({
        result,
        error,
        subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
      })
      : { ok: true };
    if (!payloadVerdict.ok) {
      payloadViolation = payloadVerdict.violation;
      noteBudgetViolation(payloadViolation, "attempt", { parentTaskId: task.parentTaskId });
      status = "failed";
      result = undefined;
      error = budgetShardError(payloadViolation);
    }
    /**
     * 迟到停止证据（票据 07）：attempt 已终态时先补证据、再走拒绝路径。
     *
     * 场景：超时/取消已写终态，child 的 completion 随后才到。状态必须原样保留（迟到的
     * 成功/失败不得改写终态），但证据仍要落库——否则该 attempt 的影响范围永远占位、
     * 任务永远不能聚合。证据应用幂等，重复回调不会重复计数。
     */
    const preStatus = attempt.status;
    if (evidence !== undefined && isTerminalShardStatus(preStatus) && !isStopObserved(attempt)) {
      const verdict = normalizeStopEvidence(evidence);
      // 内部来源（completion/admission）形状异常按"没有证据"处理：不能因为一次归一化
      // 失败就阻断正常的拒绝/诊断路径。
      if (verdict.ok) applyStopEvidence(task, shard, attempt, verdict.evidence);
    }
    if (isTerminalShardStatus(attempt.status)) {
      const outcome = payloadViolation === null
        ? rejectSettlement(task, shard, attempt, status, "already_terminal")
        : rejectSettlement(task, shard, attempt, status, "attempt_budget_exceeded");
      /**
       * 迟到证据可能刚刚解除了聚合阻塞（该 attempt 的影响范围已释放）：补一次聚合，
       * 让"取消/超时 + 迟到 completion"也能正常结算，且 task_settled 仍只发一次。
       */
      if (evidence !== undefined) {
        aggregateTask(task);
        schedule();
      }
      return outcome;
    }
    /**
     * 合法转移：running -> 任意终态；queued -> cancelled（从未 admission）或
     * interrupted（归属老化：这一轮从未真正开始，但也无法证明启动过）。
     */
    if (preStatus !== "running" && !(preStatus === "queued" && (status === "cancelled" || status === "interrupted"))) {
      return payloadViolation === null
        ? rejectSettlement(task, shard, attempt, status, "invalid_transition")
        : rejectSettlement(task, shard, attempt, status, "attempt_budget_exceeded");
    }
    attempt.status = status;
    attempt.finishedAt = now();
    attempt.terminalReason = typeof reason === "string" && reason.length > 0 ? reason : defaultTerminalReason(status);
    if (result !== undefined) attempt.result = result;
    if (error !== undefined) attempt.error = error;
    if (attempt.timer !== undefined) {
      clearTimeoutFn(attempt.timer);
      attempt.timer = undefined;
    }
    /**
     * 正常路径的停止证据（在终态写入之后应用，事件里的 status 才是真实的终态）：
     * - 成功/失败：用调用方给的 completion/admission 证据；
     * - queued 阶段取消：从未 admission，直接记 not-started 证据并释放范围。
     */
    if (!isStopObserved(attempt)) {
      const notStarted = status === "cancelled"
        && preStatus === "queued"
        && attempt.childId === undefined
        && attempt.handle === undefined;
      const finalEvidence = evidence ?? (notStarted
        ? { state: STOP_EVIDENCE_STATE_OBSERVED, source: "not-started", observedAt: now() }
        : undefined);
      if (finalEvidence !== undefined) {
        const verdict = normalizeStopEvidence(finalEvidence);
        if (verdict.ok) applyStopEvidence(task, shard, attempt, verdict.evidence);
      }
    }
    /**
     * 超时/取消进入"已请求停止、等待证据"的状态：
     * - stopEvidence 保持 unknown（管理器自己的取消不算证据）；
     * - 记录 stopRequestedAt/stopDeadlineAt 并按宽限挂看门狗；
     * - close 传 watchStop=false：清内存定时器、保留 unknown（关闭后不再有调度）。
     * 成功/失败路径不会走到这里——它们总能给出 completion/admission 证据。
     */
    if ((status === "timed_out" || status === "cancelled") && !isStopObserved(attempt)) {
      markStopRequested(task, shard, attempt, { watch: watchStop && !closed });
    }
    // 多轮复用安全边界：同一 shard 可以有多个 attempt（手工 retry / continuation），
    // shard 的**当前状态**只能由最新 attempt 决定。非最新 attempt 的迟到结算仍然写入它
    // 自己的 attempt 历史（审计可见）并发布 attempt 级事件，但绝不改写 shard.status，
    // 否则旧轮迟到结算会覆盖新轮状态，并可能重复发布旧轮 task_settled。
    const isLatestAttempt = shard.attempts[shard.attempts.length - 1] === attempt;
    if (isLatestAttempt) setShardStatus(task, shard, status);
    // 非最新 attempt 不改变 shard.status，但它自己的范围索引仍要刷新（终态 + 证据决定释放）。
    else syncAttemptScope(task, shard, attempt);
    shard.updatedAt = attempt.finishedAt;
    task.updatedAt = attempt.finishedAt;
    emitShardStatus(task, shard, status, attempt.attempt, {
      ...(isLatestAttempt ? {} : { staleAttempt: true, shardStatus: shard.status }),
      ...(task.round === undefined ? {} : { round: task.round }),
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
      // 归属老化：终态事件必须显式带"需要人工处理"标记，消费方不能把它当成普通失败。
      ...(needsAttention === true ? { needs_attention: true } : {}),
      ...(result === undefined ? {} : { result: cloneJson(result) }),
      ...(error === undefined ? {} : { error: cloneJson(error) }),
      // 预算违规必须留下可检索的诊断（终态可观察，且不携带超限原始负载）。
      ...(payloadViolation === null ? {} : { violation: payloadViolation }),
    });
    aggregateTask(task);
    notifyPersistence();
    schedule();
    return true;
  }

  /**
   * admission 未创建 child 的证据（启动器抛错/reject 的既有契约就是"没有 child"）。
   *
   * 这是管理器**能自己证明**的停止信号：没有 child 就没有执行体在写盘。注意它只覆盖
   * admission 阶段；已经受理并返回句柄的 child 必须等 completion/disposal 证据。
   */
  function admissionEvidence(attempt) {
    return {
      source: "admission_not_created",
      observedAt: now(),
      ...(typeof attempt.childId === "string" && attempt.childId.length > 0 ? { childId: attempt.childId } : {}),
    };
  }

  /**
   * completion 回调证据：该 attempt 自己绑定的 completion 落地（成功或失败）。
   *
   * 为什么可以作为证据：completion 来自本次 admission 返回的句柄，天然严格归属到本
   * attempt；它落地说明这一轮执行已经结束。取消路径不主动使用它（取消只是"请求停止"，
   * 由 child 自己回报的"取消确认"不证明进程已退出），只有**迟到**的 completion 落到
   * 已终态 attempt 上时才补录。
   */
  function completionEvidence(attempt) {
    return {
      source: "child_completion",
      observedAt: now(),
      ...(typeof attempt.childId === "string" && attempt.childId.length > 0 ? { childId: attempt.childId } : {}),
      ...(typeof attempt.messageId === "string" && attempt.messageId.length > 0 ? { messageId: attempt.messageId } : {}),
    };
  }

  /** 迟到的 completion 证据：只有 attempt 已逻辑终态时才补录（取消路径保持 unknown）。 */
  function lateCompletionEvidence(attempt) {
    return isTerminalShardStatus(attempt.status) ? completionEvidence(attempt) : undefined;
  }

  /**
   * 关闭/卸载产生的 completion 错误是否属于"管理器不再等待"而不是"执行已停止"。
   *
   * 关闭路径（manager.close / runtime.close）会用统一错误拒绝所有在途 completion；这条
   * 拒绝只说明本进程不再持有执行句柄，**不能**证明 child 已停止（它可能仍在另一个运行
   * 实例里写盘）。因此这类错误绝不能附带 completionEvidence——否则 close 会把每个
   * attempt 都误判成 observed，范围被提前释放、任务被错误聚合。
   *
   * @param {unknown} error - completion rejection 的原因。
   * @returns {boolean} true 表示这是关闭/卸载错误，应抑制停止证据。
   */
  function isShutdownCompletionError(error) {
    if (error === null || typeof error !== "object") return false;
    const reason = typeof error.reason === "string" ? error.reason : "";
    const code = typeof error.code === "string" ? error.code : "";
    return reason === "runtime_closed"
      || reason === "manager_closed"
      || code === "RUNTIME_CLOSED"
      || code === "MANAGER_CLOSED"
      || error.name === "FanoutClosedError";
  }

  function launchFailure(task, shard, attempt, error) {
    settleLaunchFailure(task, shard, attempt, error, {
      evidence: admissionEvidence(attempt),
      reason: "launch_failure",
    });
  }

  /**
   * 启动/admission/child 失败的统一入口。
   *
   * 先用未归一化的原始错误判定字节预算：normalizeLaunchError 会丢弃自定义字段
   * （如 error.detail），若只判定归一化后的结果，超限负载会被静默丢弃而不是显式报告。
   * 超限时改写成带完整元数据的 BudgetExceededError（complete=false + 实测/上限字节）。
   *
   * @param {object} task - 父任务。
   * @param {object} shard - 分片。
   * @param {object} attempt - 目标 attempt。
   * @param {unknown} error - 原始错误。
   * @param {{evidence?:object, reason?:string}} [options] - 停止证据与终止原因码
   *   （admission 失败 = admission_not_created / launch_failure；child 失败 =
   *   child_completion / failed）。
   */
  function settleLaunchFailure(task, shard, attempt, error, { evidence, reason = "launch_failure" } = {}) {
    if (task?.reclaimed === true) return;
    const rawVerdict = checkBudget({
      resource: "attempt_error",
      limit: budgetPolicy.maxAttemptErrorBytes,
      receivedBytes: measureJsonBytes(errorInstinctPayload(error)),
      subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
      // 与 checkAttemptPayloadBudget 的 attempt_error 分支保持同一契约：
      // 完整错误仍留在子会话日志里（可恢复），并给出精简错误的可执行提示。
      recoverable: true,
      hint: "错误过大时请让专家回传精简摘要（name/message/关键 stack 帧），完整日志留在子会话",
    });
    if (!rawVerdict.ok) {
      noteBudgetViolation(rawVerdict.violation, "attempt", { parentTaskId: task.parentTaskId });
      // violation 必须作为 preset 传进 settleShard：否则终态事件只带一个"小错误"，
      // 丢失 attempt_error 的超限元数据（票据 04 的可见性缺口）。
      settleShard(task, shard, attempt, "failed", {
        error: budgetShardError(rawVerdict.violation),
        violation: rawVerdict.violation,
        evidence,
        reason,
      });
      return;
    }
    settleShard(task, shard, attempt, "failed", {
      error: normalizeLaunchError(error),
      evidence,
      reason,
    });
  }

  /**
   * 原始错误的可序列化投影：Error 实例只取 name/message/stack（enumerable 字段也带上），
   * 用于在归一化之前测量真实体积。
   */
  function errorInstinctPayload(error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack, ...error };
    }
    return error;
  }

  function requestShardCancellation(task, shard, attempt, reason) {
    if (canceller === undefined || canceller === null) return;
    try {
      const outcome = canceller({
        parentTaskId: task.parentTaskId,
        shardId: shard.shardId,
        attempt: attempt.attempt,
        ...(attempt.childId === undefined ? {} : { childId: attempt.childId }),
        reason,
        handle: attempt.handle,
      });
      if (outcome !== null && typeof outcome === "object" && typeof outcome.catch === "function") {
        outcome.catch(() => {});
      }
    } catch {
      // 取消器异常不能阻断取消状态机：状态仍由 completion/超时收敛。
    }
  }

  /**
   * 启动一个 queued shard。返回 true 表示已经占用一个 running 槽位。
   * 启动器可以是同步也可以是异步；同步抛错与 Promise reject 都记为 failed，
   * 且不自动重试。
   */
  function startShard(task, shard) {
    const attempt = shard.attempts[shard.attempts.length - 1];
    if (attempt === undefined || attempt.status !== "queued") return false;
    // 多轮 continuation：本轮 attempt 复用上一轮的 child，必须走 continuer（把新 prompt
    // 投递给同一 child），不能重新走 launcher 新建 child。
    const isContinuation = attempt.continuation === true;
    const launch = isContinuation ? continuer : launcher;
    attempt.status = "running";
    attempt.startedAt = now();
    setShardStatus(task, shard, "running");
    shard.updatedAt = attempt.startedAt;
    task.updatedAt = attempt.startedAt;
    emitShardStatus(task, shard, "running", attempt.attempt, {
      ...(isContinuation ? { continuation: true } : {}),
      ...(task.round === undefined ? {} : { round: task.round }),
    });
    notifyPersistence();
    // 订阅者可能在 running 事件中重入 close；此时不能再把本次 admission 交给 launcher。
    if (closed || isTerminalShardStatus(attempt.status)) return true;

    const launchInput = {
      parentTaskId: task.parentTaskId,
      role: task.role,
      basePrompt: task.basePrompt,
      shardId: shard.shardId,
      // 名称随派发输入传给 Host：子代理任务标签与提示词都能显示"分片代号 + 任务名称"，
      // 缺失时不出现该字段，保持旧 Host 的输入形状。
      ...(shard.name === undefined ? {} : { name: shard.name }),
      prompt: shard.prompt,
      ...(attempt.affectedPaths.length === 0 ? {} : { affectedPaths: [...attempt.affectedPaths] }),
      ...(attempt.timeoutMs === undefined ? {} : { timeoutMs: attempt.timeoutMs }),
      attempt: attempt.attempt,
      // 逻辑轮次随派发输入传给 Host：续作正文用它标注「这是同一分片的第几轮」。
      ...(Number.isSafeInteger(task.round) && task.round >= 1 ? { round: task.round } : {}),
      // 续作必须带上原 childId：manager 只声明「复用哪个 child」，真正的投递由 continuer 完成。
      ...(isContinuation && typeof attempt.childId === "string" && attempt.childId.length > 0
        ? { childId: attempt.childId }
        : {}),
      /**
       * 续作还要带上该 shard 之前各轮的 messageId：Host 用它们判定本轮 messageId 是否
       * 「新」——缺失、与本 child 旧轮重复都必须在启动阶段 fail-closed，否则一个重复的
       * messageId 会让旧轮 turn/end 直接结算新一轮（提前 task_settled / goal release）。
       */
      ...(isContinuation ? { previousMessageIds: previousMessageIdsFor(shard) } : {}),
    };

    // 0 = 显式禁用超时（票据 06）：只有真正启用的正数才挂定时器。
    // 计时起点是 attempt 进入 running（上面已写入 startedAt），而不是队列等待时间。
    if (typeof attempt.timeoutMs === "number" && attempt.timeoutMs > 0) {
      // 超时通过注入时钟触发取消并标记 timed_out；若在此之前已经终态，
      // settleShard 会因幂等直接忽略这次超时。
      // 定时器回调是独立的异步 tick，自成一个持久化批（取消请求 + 终态写入只序列化一次）。
      attempt.timer = setTimeoutFn(() => withPersistenceBatch(() => {
        attempt.timer = undefined;
        requestShardCancellation(task, shard, attempt, "timeout");
        settleShard(task, shard, attempt, "timed_out", {
          error: toShardError({ name: "ShardTimeoutError", reason: "timeout", timeoutMs: attempt.timeoutMs }, "shard 超时"),
          // 超时只落逻辑终态并请求停止：stopEvidence 保持 unknown，等 Host 的权威证据。
          reason: "timeout",
        });
      }), attempt.timeoutMs);
      // 超时定时器同样只是运行期看门狗：unref 避免测试/宿主进程被单个长超时钉住。
      attempt.timer?.unref?.();
    }

    let launched;
    try {
      // continuation 尝试但 runtime 未接线 continuer 时 fail-closed 为启动失败：绝不静默
      // 换 child 顶替复用。attempt 此时已是 running，因此走既有启动失败通道收敛为 failed
      // （历史一致、shard 不会停留在 queued 造成重复派发）。
      if (typeof launch !== "function") {
        throw new Error("fan-out continuation 未接线 continuer，拒绝复用既有 child: " + shard.shardId);
      }
      launched = launch(launchInput);
    } catch (error) {
      launchFailure(task, shard, attempt, error);
      return true;
    }
    if (launched !== null && typeof launched === "object" && typeof launched.then === "function") {
      // 异步 admission 的每个回调都是独立的异步 tick，各自成批：admission 落地带来的
      // 状态变化（句柄登记 / 启动失败终态）在该批内只序列化一次。
      launched.then(
        (value) => { withPersistenceBatch(() => consumeLaunchResult(task, shard, attempt, value)); },
        (error) => { withPersistenceBatch(() => launchFailure(task, shard, attempt, error)); },
      );
    } else {
      consumeLaunchResult(task, shard, attempt, launched);
    }
    return true;
  }

  /** 消费启动器返回值：登记句柄元数据，并订阅 completion 决定 shard 终态。 */
  function consumeLaunchResult(task, shard, attempt, value) {
    // 回收后才落地的 admission：只丢弃，不登记 childId、不写快照、不订阅 completion。
    if (task?.reclaimed === true) return;
    const handle = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    if (typeof handle.childId === "string") attempt.childId = handle.childId;
    if (typeof handle.messageId === "string") attempt.messageId = handle.messageId;
    attempt.handle = handle;
    notifyPersistence();
    // close 可能在 launcher admission 等待期间完成；晚到的 child 仍要收到一次取消请求，
    // 但不能把已经写入的 cancelled 终态重新变成 running。
    if (closed || isTerminalShardStatus(attempt.status)) {
      requestShardCancellation(task, shard, attempt, closed ? "manager_closed" : "already_terminal");
    }

    const completion = handle.completion !== undefined
      ? handle.completion
      : typeof handle.then === "function"
        ? handle
        : undefined;
    if (completion === undefined) {
      // 启动器只回传句柄：shard 保持 running，等待 cancel/timeout 收敛。
      return;
    }
    // 完成回调是独立的异步 tick：结算（可能连带聚合父任务）在该批内只序列化一次。
    Promise.resolve(completion).then(
      (result) => { withPersistenceBatch(() => completeShard(task, shard, attempt, result)); },
      (error) => { withPersistenceBatch(() => failShard(task, shard, attempt, error)); },
    );
  }

  function completeShard(task, shard, attempt, result) {
    if (task?.reclaimed === true) return;
    // 取消与完成竞态：取消请求先写入终态则完成被忽略，反之完成胜出。
    if (attempt.cancelRequested === true) {
      /**
       * 取消路径的证据边界（票据 07）：attempt 仍在 running 时，取消结算属于"请求停止"，
       * 由 child 回的"我取消了"不证明执行体退出，因此不附带证据；
       * 只有落在一个**已终态** attempt 上的迟到 completion 才补录证据（不改状态、不重复
       * 计数），这正是"取消后 child 真的结束"的可观察收敛。
       */
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
        // 关闭后到达的 completion 不能当作停止证据（见 isShutdownCompletionError）。
        evidence: closed ? undefined : lateCompletionEvidence(attempt),
        reason: "cancelled",
      });
      return;
    }
    const rawResult = result === undefined ? null : result;
    // 不可 JSON 序列化的结果不能被 cloneJson 深拷贝（会抛 TypeError 并逃出 completion
    // 回调），因此在这里提前转成显式的预算失败；超限但仍可序列化的结果交给
    // settleShard 判定，以便它照常发出带 violation 的 shard 终态诊断事件。
    const measured = measureJsonBytes(rawResult);
    if (measured === null) {
      const violation = describeBudgetViolation({
        resource: "attempt_result",
        limit: budgetPolicy.maxAttemptResultBytes,
        receivedBytes: null,
        measured: false,
        recoverable: true,
        subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
        hint: "结果没有 JSON 表示；请让专家只回传可序列化的文本/结构化结果",
      });
      noteBudgetViolation(violation, "attempt", { parentTaskId: task.parentTaskId });
      // completion 已落地（只是结果不可序列化），因此这一轮执行确实结束了：
      // 仍要带上完成证据，否则该 attempt 的影响范围会因"预算失败"而永远占位。
      settleShard(task, shard, attempt, "failed", {
        error: budgetShardError(violation),
        violation,
        // 关闭后的 completion 不证明执行停止；正常路径才是可信证据。
        evidence: closed ? undefined : completionEvidence(attempt),
        reason: "failed",
      });
      return;
    }
    settleShard(task, shard, attempt, "succeeded", {
      result: rawResult === null ? null : cloneJson(rawResult),
      // 成功 = 该 attempt 自己的 completion 落地，这是"这一轮执行已经结束"的证据。
      evidence: closed ? undefined : completionEvidence(attempt),
      reason: "completed",
    });
  }

  function failShard(task, shard, attempt, error) {
    if (task?.reclaimed === true) return;
    if (attempt.cancelRequested === true && !isTerminalShardStatus(attempt.status)) {
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
        reason: "cancelled",
      });
      return;
    }
    // completion 失败同样证明这一轮执行结束；若 attempt 已终态（超时/取消），
    // settleShard 只补证据并保留原状态。
    // 例外：close/runtime_closed/manager_closed 只是"本进程不再等待"，必须保持 unknown，
    // 否则关闭会把所有未确认停止的 attempt 一次性"证明"为已停止。
    const shutdown = closed || isShutdownCompletionError(error);
    settleLaunchFailure(task, shard, attempt, error, {
      evidence: shutdown ? undefined : completionEvidence(attempt),
      reason: "failed",
    });
  }

  // -------------------------------------------------------------------------
  // wait-all 聚合
  // -------------------------------------------------------------------------

  /**
   * 聚合 gate（票据 07）：任务结算需要**同时**满足两个条件。
   *
   * - counts.pending === 0：没有分片还在 queued/running（逻辑进度）；
   * - counts.stop_pending === 0：没有"已终态但执行未确认"的 attempt（真实停止）。
   *
   * 只满足前者时任务保持 pending：不写 settledAt、不发 task_settled、不宣告完成。
   * 迟到证据到达后由 observeStopEvidence 重新调用本函数补聚合，且 task_settled
   * 只会发一次（下面的 wasSettled + previousStatus 判定保证幂等）。
   */
  function aggregateTask(task) {
    const counts = computeCounts(task);
    const allTerminal = counts.pending === 0 && counts.stop_pending === 0;
    const previousStatus = task.status;
    const wasSettled = task.settledAt !== undefined;
    let status = task.status;
    if (!allTerminal) {
      // 逻辑终态但停止未确认：保持 pending，避免"管理器已结算、执行还在写"。
      status = "pending";
    } else if (counts.succeeded === task.shards.length) {
      status = "completed";
    } else if (task.parentCancelRequested === true && counts.succeeded === 0 && counts.failed === 0 && counts.timed_out === 0) {
      // 父级取消且没有任何 shard 成功或异常：未完成的 shard 都是因为父级取消而终止。
      status = "cancelled";
    } else {
      status = "completed_with_errors";
    }
    task.status = status;
    task.updatedAt = now();
    if (!allTerminal) {
      task.settledAt = undefined;
      return;
    }
    task.settledAt = task.updatedAt;
    // 重复 cancel/aggregate 只刷新快照，不重复发布 task_settled；只有从 pending 进入
    // 终态，或终态因显式 retry / continuation 后再次结算，才产生新的聚合结算事件。
    if (restoringSnapshot || (wasSettled && previousStatus === status)) return;
    emit({
      type: "task_settled",
      parentTaskId: task.parentTaskId,
      role: task.role,
      status,
      counts,
      // 轮次随聚合结算一起发布：多轮复用下消费方据此区分「哪一轮的 wait-all 完成」，
      // 旧轮迟到结算（非最新 attempt）不会走到这里（settleShard 已拒绝改写 shard 状态）。
      round: Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1,
      shards: task.shards.map((shard) => ({ shardId: shard.shardId, status: shard.status, attempts: shard.attempts.length })),
    });
  }

  /**
   * 本轮 wait-all 是否真正完成（= 可以复用续作）。
   *
   * 两个条件缺一不可：最新 attempt 全部逻辑终态 **且** 没有任何未确认停止的 attempt。
   * 只按逻辑终态判定会让 UI/工具在 child 仍可能写盘时显示"可续作"，与 continueTask 的
   * stop_unconfirmed 拒绝自相矛盾。
   */
  function allShardsTerminal(task) {
    if (task === undefined || task === null) return false;
    const latestAllTerminal = task.shards.every((shard) => {
      const latest = shard.attempts[shard.attempts.length - 1];
      return latest !== undefined && isTerminalShardStatus(latest.status);
    });
    return latestAllTerminal && countStopPending(task) === 0;
  }

  // -------------------------------------------------------------------------
  // 公共 API
  // -------------------------------------------------------------------------

  /**
   * 登记一个父任务并把 shards 按输入顺序放入队列。
   * 非法输入整体拒绝（不登记任务、不创建任何 child）；requestId 重复时返回原句柄。
   */
  function submit(input) {
    if (closed) {
      return {
        accepted: false,
        changed: false,
        code: "MANAGER_CLOSED",
        reason: "manager_closed",
        shardIds: [],
      };
    }
    // 回收屏障：新增登记会破坏"候选快照 = 待落盘状态"的一致性，一律结构化拒绝。
    if (reclaimState !== null) return { ...reclaimInProgressResult(), shardIds: [] };
    const verdict = validateSubmitInput(input);
    if (!verdict.ok) {
      // 任务输入（basePrompt/shard prompt）与 shards 数量的预算拒绝属于 submit 阶段。
      if (verdict.violation !== undefined) noteBudgetViolation(verdict.violation, "submit");
      throw validationError(verdict);
    }

    /**
     * requestId 幂等判定**先于**容量判定（票据 05 验收项）。
     *
     * 为什么顺序重要：满额时重复提交同一个 requestId 是"重放已知请求"，不是"新增任务"。
     * 若容量判定在前，调用方会收到容量错误并误以为需要先回收/等待——实际上它拿到的
     * 会是与首次完全相同的任务句柄。去重命中永远不占新槽位，因此这里可以安全地提前返回。
     */
    if (verdict.requestId !== undefined) {
      const existingId = requestIndex.get(verdict.requestId);
      if (existingId !== undefined && tasks.has(existingId)) {
        const existing = tasks.get(existingId);
        return {
          parentTaskId: existing.parentTaskId,
          duplicate: true,
          role: existing.role,
          status: existing.status,
          shardIds: existing.shards.map((shard) => shard.shardId),
          requestId: verdict.requestId,
        };
      }
    }

    // task 数量预算：快照里的 tasks 数组与内存表都按 task 线性增长，必须有上界。
    // 判定的是"本候选登记后的数量"，因此 +1。拒绝结构额外携带 current / reclaimable，
    // 提示指向真实可执行入口（RPC fanout-reclaim），而不是含糊的"等待或取消"。
    const taskCountViolation = budgetVerdict(
      "tasks",
      budgetPolicy.maxTasks,
      tasks.size + 1,
      "tasks",
      "调用 fanout-reclaim 回收已结算的父任务，或等待尚未结算的任务收敛 / 调整 maxTasks 后再提交",
      { current: tasks.size, reclaimable: countReclaimableTasks() },
    );
    if (taskCountViolation !== null) {
      noteBudgetViolation(taskCountViolation.violation, "submit");
      throw validationError(taskCountViolation);
    }

    const allowOverlap = verdict.allowOverlap || defaultAllowOverlap;
    {
      // 冲突判定是「整体拒绝」的一部分：任何一个 shard 冲突都不登记任务。
      // allowOverlap 只放行拒绝动作，注入的 checker 仍会被调用，便于 Host 观测重叠。
      const otherShards = collectActiveShards();
      const withinSubmit = [];
      for (const shard of verdict.shards) {
        const conflict = findConflict(verdict.role, shard, [...otherShards, ...withinSubmit]);
        if (conflict !== null && !allowOverlap) {
          throw new FanoutValidationError(
            "AFFECTED_PATHS_CONFLICT",
            "shard " + shard.shardId + " 的 affectedPaths 与活动任务冲突",
            { field: "shards[" + verdict.shards.indexOf(shard) + "].affectedPaths", conflict },
          );
        }
        withinSubmit.push({
          parentTaskId: "(submitting)",
          role: verdict.role,
          shardId: shard.shardId,
          affectedPaths: shard.affectedPaths,
        });
      }
    }

    const timestamp = now();
    nextTaskNumber += 1;
    const explicitParentTaskId = typeof input.parentTaskId === "string" && input.parentTaskId.trim().length > 0
      ? input.parentTaskId.trim()
      : undefined;
    const parentTaskId = explicitParentTaskId ?? "fanout-" + nextTaskNumber;
    if (tasks.has(parentTaskId)) {
      throw new FanoutValidationError("DUPLICATE_PARENT_TASK_ID", "parentTaskId 已存在: " + parentTaskId, { field: "parentTaskId" });
    }
    // 同 id 的旧回收标记必须清除：新任务的迟到回调不能被误判成"任务已回收"。
    forgetReclaimedTask(parentTaskId);
    // 任务级限制只固化**显式**给出的值（submit 入参 / 快照里已有的 concurrencyLimit）。
    // 角色级设置与默认值不在创建时复制到任务上：它们描述的是"该角色的共享并发池"，必须
    // 继续按当前 settings 解析——否则快照生成时那次请求的临时配置（例如 roleLimits=1）
    // 会被写进任务并永久压低该任务，配置缺失时尤其错误。
    const task = {
      parentTaskId,
      ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
      role: verdict.role,
      basePrompt: verdict.basePrompt,
      status: "pending",
      // 逻辑轮次：首次提交 = 第 1 轮，每次 continuation 递增（attempt 序号独立递增）。
      round: 1,
      allowOverlap,
      ...(verdict.concurrencyLimit === undefined ? {} : { concurrencyLimit: verdict.concurrencyLimit }),
      // 父任务级默认超时（票据 06）：只写**显式**值，随任务快照固化。
      // 未设置时不出现该字段，交给角色级默认值动态解析；0 是合法的「显式禁用」。
      ...(verdict.timeoutMs === undefined ? {} : { timeoutMs: verdict.timeoutMs }),
      // provider 归属（票据 26）：提交时得到的稳定归属，随任务快照固化，供 provider
      // 级并发计数使用；缺失表示该角色没有主模型，provider 限流不生效。
      ...(verdict.provider === undefined ? {} : { provider: verdict.provider }),
      createdAt: timestamp,
      updatedAt: timestamp,
      settledAt: undefined,
      parentCancelRequested: false,
      shards: verdict.shards.map((shard) => {
        // 实效超时在创建第一个 attempt 时解析一次：分片 > 父任务 > 角色（含 0）。
        const attemptTimeoutMs = resolveAttemptTimeoutMs(verdict.timeoutMs, shard.timeoutMs);
        return {
          shardId: shard.shardId,
          // 任务名称进入运行时状态：快照投影与恢复都以它为唯一来源，不再从别处推导。
          ...(shard.name === undefined ? {} : { name: shard.name }),
          prompt: shard.prompt,
          status: "queued",
          affectedPaths: shard.affectedPaths ?? [],
          // 分片快照只保留**显式覆盖**：不把父任务/角色默认值复制成分片覆盖，
          // 否则恢复后的新 attempt 会拿到当年冻结的值而绕过当前角色设置。
          ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
          createdAt: timestamp,
          updatedAt: timestamp,
          attempts: [{
            attempt: 1,
            status: "queued",
            /**
             * 首个 attempt 同样携带身份与默认停止证据（票据 07）：
             * 影响的路径从 queued 起就要预留，而预留条目按 attempt 建索引，
             * 因此 attempt 身份必须在登记时就已经稳定存在。
             */
            attemptId: deriveAttemptId(parentTaskId, shard.shardId, 1),
            executionGeneration: ++nextExecutionGeneration,
            stopEvidence: { state: STOP_EVIDENCE_STATE_UNKNOWN },
            startedAt: undefined,
            finishedAt: undefined,
            affectedPaths: shard.affectedPaths ?? [],
            ...(attemptTimeoutMs === undefined ? {} : { timeoutMs: attemptTimeoutMs }),
          }],
        };
      }),
    };
    tasks.set(parentTaskId, task);
    indexTask(task);
    if (verdict.requestId !== undefined) requestIndex.set(verdict.requestId, parentTaskId);

    emit({
      type: "task_registered",
      parentTaskId,
      role: task.role,
      shardIds: task.shards.map((shard) => shard.shardId),
      counts: computeCounts(task),
      ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
    });
    notifyPersistence();
    schedule();
    return {
      parentTaskId,
      duplicate: false,
      role: task.role,
      status: task.status,
      shardIds: task.shards.map((shard) => shard.shardId),
      ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
    };
  }

  /**
   * 多轮复用：对**同一逻辑父任务**续作一轮（continuation）。
   *
   * 语义（已确认规格）：
   * 1. 复用判定由主代理发起，插件负责校验与执行；同一逻辑任务跨 ready/completed 复用，
   *    parentTaskId 不变，不新建父任务、不新建 child；
   * 2. 每个既有 shard 追加一个新 attempt（attempt 序号单调递增），**保留原 childId**，
   *    旧 attempt 历史（状态/时间/结果/错误）原样保留、绝不覆盖；
   * 3. 复用只能发生在**本轮 wait-all 已完成**之后（每个 shard 的最新 attempt 已终态）；
   *    任一 shard 仍在运行时结构化拒绝 `task_not_ready`，不做半写；
   * 4. 结构必须一致：role 相同、shard 数量相同、shardId 集合完全相同（同一个分片结构），
   *    否则结构化拒绝；新 prompt / 新 basePrompt 是本轮的指令；
   * 5. 提交后父任务立即回到 `pending`（投影层 = running），本轮全部新 attempt 终态后
   *    再次聚合，发布带 `round` 的 `task_settled`，父任务可继续下一轮；
   * 6. `requestId` 是幂等键：同一 requestId 的重复续作返回上次结果（duplicate=true），
   *    不追加 attempt；同一 requestId 指向别的父任务则拒绝。
   *
   * 校验全部先于任何状态修改：拒绝路径不改变任务、attempt 历史与事件。
   *
   * @param {{parentTaskId:string, role:string, basePrompt:string, shards:object[], requestId?:string}} input
   * @returns {object} 结构化结果：accepted/changed/reason/round/nextAttemptByShard 等。
   */
  function continueTask(input) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    if (reclaimState !== null) return reclaimInProgressResult();
    const verdict = validateSubmitInput(input);
    if (!verdict.ok) {
      // 续作的输入/shard 数量拒绝与提交共用同一契约，但 phase 必须可区分（continue）。
      if (verdict.violation !== undefined) {
        noteBudgetViolation(verdict.violation, "continue", { parentTaskId: normalizeText(input?.parentTaskId).trim() || undefined });
      }
      throw validationError(verdict);
    }
    const parentTaskId = normalizeText(input?.parentTaskId).trim();
    if (parentTaskId.length === 0) {
      return { accepted: false, changed: false, reason: "missing_parent_task_id" };
    }
    const task = tasks.get(parentTaskId);
    if (task === undefined) {
      return { accepted: false, changed: false, reason: "unknown_parent_task", parentTaskId };
    }
    /**
     * requestId 幂等（**持久化**，不是全局 LRU）：
     * - 命中同一父任务的记录 → 原样返回上次的 continuation result + duplicate=true；
     * - 记录在别的父任务上 → 拒绝（幂等键不能跨任务复用）；
     * - 未命中 → 正常走到下面的校验/写入。
     *
     * 真相源是 task.continuationRequests（随快照持久化 + restore 恢复），因此进程重启、
     * 快照恢复以及大量请求之后旧 requestId 仍然可查，绝不会被淘汰后追加新 attempt。
     */
    if (verdict.requestId !== undefined) {
      const recorded = task.continuationRequests?.[verdict.requestId];
      if (recorded !== undefined && recorded !== null && typeof recorded.result === "object") {
        return { ...cloneJson(recorded.result), duplicate: true };
      }
      const elsewhere = continuationRequestOwners.get(verdict.requestId);
      if (typeof elsewhere === "string" && elsewhere !== parentTaskId) {
        return { accepted: false, changed: false, reason: "duplicate_request_id", parentTaskId, requestId: verdict.requestId };
      }
      if (continuationRequestBudgetExceeded(task)) {
        return { accepted: false, changed: false, reason: "request_budget_exceeded", parentTaskId, requestId: verdict.requestId };
      }
    }
    // 角色一致性：同一逻辑任务只允许同一专家角色续作。
    if (verdict.role !== task.role) {
      return { accepted: false, changed: false, reason: "role_mismatch", parentTaskId, role: verdict.role, expectedRole: task.role };
    }
    // 分片结构一致性：数量 + shardId 集合（顺序可不同，语义按 shardId 对齐）。
    if (verdict.shards.length !== task.shards.length) {
      return {
        accepted: false, changed: false, reason: "shard_count_mismatch", parentTaskId,
        expected: task.shards.length, received: verdict.shards.length,
      };
    }
    const expectedShardIds = task.shards.map((shard) => shard.shardId);
    const provided = new Map(verdict.shards.map((shard) => [shard.shardId, shard]));
    for (const shardId of expectedShardIds) {
      if (!provided.has(shardId)) {
        return { accepted: false, changed: false, reason: "shard_ids_mismatch", parentTaskId, missing: shardId };
      }
    }
    if (task.parentCancelRequested === true) {
      return { accepted: false, changed: false, reason: "parent_cancelled", parentTaskId };
    }
    // 忙碌判定：本轮 wait-all 尚未完成（任一分片最新 attempt 非终态）时拒绝，
    // 避免与运行中的 shard 竞争同一 child 的轮次。
    for (const shard of task.shards) {
      const latest = shard.attempts[shard.attempts.length - 1];
      if (latest === undefined || !isTerminalShardStatus(latest.status)) {
        return {
          accepted: false, changed: false, reason: "task_not_ready", parentTaskId,
          shardId: shard.shardId, shardStatus: shard.status, status: task.status,
        };
      }
    }
    /**
     * 停止 gate（票据 07）：上一轮已有 attempt 逻辑终态但执行未确认时拒绝续作。
     *
     * 续作会把新 prompt 投递给**同一个 child**：如果上一轮的 turn 还没真正结束，新一轮
     * 投递会与旧轮并发写同一路径。因此这里 fail-closed，并把未确认 attempt 摘要返回给
     * 调用方（Host 可据此等待/提交证据）。
     */
    const stopBlocked = [];
    for (const shard of task.shards) {
      const stopGate = stopGateVerdict(shard);
      if (stopGate !== null) stopBlocked.push(stopGate);
    }
    if (stopBlocked.length > 0) {
      return {
        accepted: false,
        changed: false,
        reason: "stop_unconfirmed",
        parentTaskId,
        shardId: stopBlocked[0].shardId,
        attempts: stopBlocked[0].attempts,
        shards: stopBlocked.map((entry) => ({ shardId: entry.shardId, attempts: entry.attempts })),
      };
    }
    // attempt 预算：**整体**判定（任一分片超限即整体拒绝），保证不会出现半写。
    // 判定走 attemptBudgetVerdict：retry / continue / restore resume 共用同一语义，
    // 避免某个入口把边界写成"新建前 >= limit"而放宽一档。
    for (const shard of task.shards) {
      const budget = attemptBudgetVerdict(
        shard,
        "shard " + shard.shardId,
        "该 shard 已耗尽多轮复用预算，请提交新的父任务或拆分工作",
      );
      if (budget !== null) {
        noteBudgetViolation(budget.violation, "continue", { parentTaskId });
        return {
          accepted: false, changed: false, reason: budget.reason, parentTaskId,
          shardId: shard.shardId, violation: budget.violation,
        };
      }
    }

    // 全部校验通过后才修改状态：先构造本轮的全部 attempt，再统一提交（无半写）。
    const round = Number.isSafeInteger(task.round) && task.round >= 1 ? task.round + 1 : 2;
    const timestamp = now();
    // 本轮显式给出的父任务默认超时立即成为任务级默认（票据 06）。
    // 它只影响本轮之后创建的 attempt；缺失时沿用既有默认值，绝不清空。
    if (verdict.timeoutMs !== undefined) task.timeoutMs = verdict.timeoutMs;
    const prepared = task.shards.map((shard) => {
      const previous = shard.attempts[shard.attempts.length - 1];
      const next = provided.get(shard.shardId);
      // 本轮分片规格里的显式超时成为该分片的新覆盖；缺失时保留原覆盖。
      // 新 attempt 的超时在 createAttempt 里按三级优先级重新解析一次。
      if (next.timeoutMs !== undefined) shard.timeoutMs = next.timeoutMs;
      return {
        shard,
        prompt: next.prompt,
        attempt: createAttempt(task, shard, previous.attempt + 1, {
          // 复用标记只存在于内存 attempt：冷恢复后原 child 可能已消失，恢复派发一律
          // 走 launcher 新建 child（既有 restore 语义）。
          continuation: true,
          ...(typeof previous.childId === "string" && previous.childId.length > 0 ? { childId: previous.childId } : {}),
        }),
      };
    });
    for (const item of prepared) {
      item.shard.prompt = item.prompt;
      item.shard.attempts.push(item.attempt);
      // 复用是对取消的显式复活（与 retryShard 同语义）：清除该 shard 的取消标记，
      // 允许新一轮重新 admission。
      delete item.attempt.cancelRequested;
      item.shard.cancelRequested = false;
      setShardStatus(task, item.shard, "queued");
      item.shard.updatedAt = timestamp;
    }
    task.basePrompt = verdict.basePrompt;
    task.round = round;
    task.status = "pending";
    task.settledAt = undefined;
    task.updatedAt = timestamp;
    for (const item of prepared) {
      emitShardStatus(task, item.shard, "queued", item.attempt.attempt, {
        continuation: true,
        round,
        attemptCount: item.shard.attempts.length,
        ...(item.attempt.childId === undefined ? {} : { childId: item.attempt.childId }),
      });
    }
    const nextAttemptByShard = {};
    for (const item of prepared) nextAttemptByShard[item.shard.shardId] = item.attempt.attempt;
    emit({
      type: "task_continued",
      parentTaskId,
      role: task.role,
      round,
      shardIds: expectedShardIds,
      nextAttemptByShard,
      counts: computeCounts(task),
      ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
    });
    const result = {
      accepted: true,
      changed: true,
      parentTaskId,
      role: task.role,
      round,
      status: task.status,
      shardIds: expectedShardIds,
      nextAttemptByShard,
      ...(verdict.requestId === undefined ? {} : { requestId: verdict.requestId }),
    };
    if (verdict.requestId !== undefined) {
      // 幂等记录写进**任务本体**（随快照持久化、restore 恢复）：不淘汰、不丢键。
      // 记录的是本次返回的完整 result 快照（深拷贝），因此重复请求能原样复现同一结果。
      task.continuationRequests = {
        ...(task.continuationRequests ?? {}),
        [verdict.requestId]: { result: cloneJson(result), recordedAt: timestamp },
      };
      continuationRequestOwners.set(verdict.requestId, parentTaskId);
    }
    notifyPersistence();
    schedule();
    return result;
  }

  /**
   * 读取某个 attempt 当前绑定的 messageId（只读，不克隆任务快照）。
   *
   * Host 用它做 continuation 的**严格 turn 归属**校验：turn/end 只能结算 messageId 与该
   * attempt 绑定值完全一致的那一次投递；拿不到（任务/分片/attempt 不存在，或该 attempt
   * 还没有 messageId）时返回 null，由 Host fail-closed（不结算，只记结构化诊断）。
   */
  function attemptMessageIdOf(parentTaskId, shardId, attemptNumber) {
    const task = tasks.get(parentTaskId);
    if (task === undefined) return null;
    const shard = task.shards.find((entry) => entry.shardId === shardId);
    if (shard === undefined) return null;
    const attempt = shard.attempts.find((entry) => entry.attempt === attemptNumber);
    if (attempt === undefined) return null;
    return typeof attempt.messageId === "string" && attempt.messageId.length > 0 ? attempt.messageId : null;
  }

  /**
   * 读取某个 attempt 的严格身份（只读、不克隆任务快照）。
   *
   * Host 在归属老化到期时必须用「manager 权威投影里的 attemptId + executionGeneration」
   * 调用 markAttributionAged；自己按规则拼身份会绕过迟到隔离（旧代次的定时器可能命中新
   * attempt）。因此这里提供一个只读的精确读取入口，语义与 attemptMessageIdOf 相同：
   * 任务/分片/attempt 不存在时返回 null，由 Host fail-closed。
   *
   * @param {string} parentTaskId - 父任务标识。
   * @param {string} shardId - 分片标识。
   * @param {number} attemptNumber - attempt 序号。
   * @returns {{parentTaskId:string, shardId:string, attempt:number, attemptId:string, executionGeneration:number, status:string, terminal:boolean}|null}
   */
  function attemptIdentityOf(parentTaskId, shardId, attemptNumber) {
    const task = tasks.get(parentTaskId);
    if (task === undefined) return null;
    const shard = task.shards.find((entry) => entry.shardId === shardId);
    if (shard === undefined) return null;
    const attempt = shard.attempts.find((entry) => entry.attempt === attemptNumber);
    if (attempt === undefined) return null;
    return {
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
      status: attempt.status,
      terminal: isTerminalShardStatus(attempt.status),
    };
  }

  /**
   * 记录一条「turn 归属无法证明」的结构化诊断（Host 观察到的竞态，不改变任何任务状态）。
   *
   * 语义边界：这不是结算失败（没有 attempt 状态写入），因此不能走 shard_settlement_rejected；
   * 只发布一条带 parentTaskId/shardId/attempt/reason/turn 的事件，让运维与测试都能按
   * sequence 观察「哪个 attempt 的哪一次 turn/end 因为无法证明归属而被忽略」。
   */
  function recordAttributionViolation(input) {
    const parentTaskId = normalizeText(input?.parentTaskId).trim();
    if (parentTaskId.length === 0) return { accepted: false, changed: false, reason: "missing_parent_task_id" };
    // 回收屏障/已回收任务都不得写事件：诊断事件同样会进快照，会打破回收的落盘一致性。
    if (reclaimState !== null) return reclaimInProgressResult();
    if (!tasks.has(parentTaskId) && reclaimedTaskIds.has(parentTaskId)) return taskReclaimedResult(parentTaskId);
    const shardId = normalizeText(input?.shardId).trim();
    const attemptNumber = Number.isSafeInteger(input?.attempt) && input.attempt > 0 ? input.attempt : undefined;
    const reason = normalizeText(input?.reason).trim();
    const turn = Number.isSafeInteger(input?.turn) ? input.turn : undefined;
    const messageId = typeof input?.messageId === "string" && input.messageId.length > 0 ? input.messageId : undefined;
    emit({
      type: "shard_attribution_unproven",
      parentTaskId,
      ...(shardId.length === 0 ? {} : { shardId }),
      ...(attemptNumber === undefined ? {} : { attempt: attemptNumber }),
      reason: reason.length === 0 ? "unproven" : reason,
      ...(turn === undefined ? {} : { turn }),
      ...(messageId === undefined ? {} : { messageId }),
    });
    notifyPersistence();
    return { accepted: true, changed: true, parentTaskId, reason: reason.length === 0 ? "unproven" : reason };
  }

  /**
   * 归一化停止证据的寻址身份（Host 提交入口）。
   *
   * 五个字段缺一不可且必须精确匹配：parentTaskId + shardId + attempt 序号 +
   * attemptId + executionGeneration。少任何一个都会让"旧 attempt 的证据"有机会命中
   * 新 attempt（同一 shard 的 attempt 序号会递增、childId 会复用），因此这里 fail-closed。
   *
   * @param {unknown} identity - 原始身份。
   * @returns {{ok:true, parentTaskId:string, shardId:string, attempt:number, attemptId:string, executionGeneration:number}
   *   | {ok:false, code:string, reason:string, message:string}}
   */
  function normalizeStopIdentity(identity) {
    const invalid = (message) => ({ ok: false, code: "STOP_EVIDENCE_INVALID", reason: "stop_evidence_invalid", message });
    if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
      return invalid("停止证据身份必须是对象");
    }
    const parentTaskId = typeof identity.parentTaskId === "string" ? identity.parentTaskId.trim() : "";
    const shardId = typeof identity.shardId === "string" ? identity.shardId.trim() : "";
    if (parentTaskId.length === 0) return invalid("身份缺少 parentTaskId");
    if (shardId.length === 0) return invalid("身份缺少 shardId");
    if (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1) return invalid("身份中的 attempt 必须是正整数");
    const attemptId = typeof identity.attemptId === "string" ? identity.attemptId.trim() : "";
    if (attemptId.length === 0) return invalid("身份缺少 attemptId");
    if (!Number.isSafeInteger(identity.executionGeneration) || identity.executionGeneration < 1) {
      return invalid("身份中的 executionGeneration 必须是正整数");
    }
    return {
      ok: true,
      parentTaskId,
      shardId,
      attempt: identity.attempt,
      attemptId,
      executionGeneration: identity.executionGeneration,
    };
  }

  /**
   * 提交一条严格归属的停止证据（Host -> manager，票据 07）。
   *
   * 状态机约束：只允许 unknown -> observed。本入口**绝不**改写逻辑 status/result/error，
   * 也不重复发布 shard 结算事件；它只写证据、清看门狗、刷新范围索引，然后重跑聚合
   * （可能有资格补发 task_settled——恰好一次）。
   *
   * 拒绝路径全是结构化码且无副作用：
   * - stop_evidence_unknown_attempt：任务/分片/attempt 不存在；
   * - stop_evidence_stale：attempt 存在但 attemptId 或 executionGeneration 不匹配
   *   （旧执行代次的迟到信号）；
   * - stop_evidence_invalid：身份或证据形状非法 / 来源不在 Host 白名单；
   * - manager_closed：管理器已关闭。
   *
   * @param {object} identity - {parentTaskId, shardId, attempt, attemptId, executionGeneration}
   * @param {object} rawEvidence - {source, observedAt?, childId?, messageId?, sessionId?, turn?}
   * @returns {object} 结构化结果（accepted/changed/reason/stopEvidence/taskStatus/counts）。
   */
  function observeStopEvidence(identity, rawEvidence) {
    if (closed) {
      return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    }
    if (reclaimState !== null) return reclaimInProgressResult();
    const id = normalizeStopIdentity(identity);
    if (!id.ok) {
      return { accepted: false, changed: false, code: id.code, reason: id.reason, message: id.message };
    }
    // 已回收任务的迟到证据：结构化 no-op，绝不复活任务或写事件/快照。
    if (!tasks.has(id.parentTaskId) && reclaimedTaskIds.has(id.parentTaskId)) {
      return taskReclaimedResult(id.parentTaskId);
    }
    const task = tasks.get(id.parentTaskId);
    const shard = task?.shards.find((entry) => entry.shardId === id.shardId);
    const attempt = shard?.attempts.find((entry) => entry.attempt === id.attempt);
    if (task === undefined || shard === undefined || attempt === undefined) {
      return {
        accepted: false,
        changed: false,
        code: "STOP_EVIDENCE_UNKNOWN_ATTEMPT",
        reason: "stop_evidence_unknown_attempt",
        parentTaskId: id.parentTaskId,
        shardId: id.shardId,
        attempt: id.attempt,
      };
    }
    if (attempt.attemptId !== id.attemptId || attempt.executionGeneration !== id.executionGeneration) {
      return {
        accepted: false,
        changed: false,
        code: "STOP_EVIDENCE_STALE",
        reason: "stop_evidence_stale",
        parentTaskId: task.parentTaskId,
        shardId: shard.shardId,
        attempt: attempt.attempt,
        expectedAttemptId: attempt.attemptId,
        expectedExecutionGeneration: attempt.executionGeneration,
        receivedAttemptId: id.attemptId,
        receivedExecutionGeneration: id.executionGeneration,
      };
    }
    const verdict = normalizeStopEvidence(rawEvidence, { allowedSources: HOST_STOP_EVIDENCE_SOURCES });
    if (!verdict.ok) {
      return {
        accepted: false,
        changed: false,
        code: verdict.code,
        reason: verdict.reason,
        message: verdict.message,
        parentTaskId: task.parentTaskId,
        shardId: shard.shardId,
        attempt: attempt.attempt,
        attemptId: attempt.attemptId,
      };
    }
    const base = {
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
    };
    if (isStopObserved(attempt)) {
      return {
        accepted: true,
        changed: false,
        reason: "stop_evidence_already_observed",
        ...base,
        stopEvidence: cloneJson(attempt.stopEvidence),
        taskStatus: task.status,
        counts: computeCounts(task),
      };
    }
    applyStopEvidence(task, shard, attempt, verdict.evidence);
    // 证据到达后补聚合：逻辑终态 + 全部 observed 的任务在这里才真正结算（task_settled 一次）。
    aggregateTask(task);
    notifyPersistence();
    // 释放影响范围可能解开别的任务被冲突挡住的排队分片，因此重新请求一次派发。
    schedule();
    return {
      accepted: true,
      changed: true,
      reason: "observed",
      ...base,
      source: attempt.stopEvidence.source,
      stopEvidence: cloneJson(attempt.stopEvidence),
      // released=true 表示该 attempt 的影响范围已释放（终态 + 证据齐备）。
      released: isTerminalShardStatus(attempt.status),
      taskStatus: task.status,
      counts: computeCounts(task),
    };
  }

  /**
   * 归属老化到期（Host -> manager，票据 07）：把"归属无法证明且超过人工处理宽限"的
   * attempt 收敛为 interrupted，并显式标记需要人工处理。
   *
   * 严格边界（与 observeStopEvidence 完全一致的身份规则）：
   * - 身份必须精确匹配 parentTaskId + shardId + attempt + attemptId + executionGeneration；
   * - **不**写停止证据：归属不明不等于执行已停止，影响范围必须继续占用（stopEvidence
   *   保持 unknown），任务保持 pending，不聚合、不发完成通知、不自动重试；
   * - 已终态 attempt 是 no-op（changed=false），绝不改写既有终态；
   * - closed 后结构化拒绝。
   *
   * 为什么由 Host 驱动：只有 Host 知道"这一轮投递的 turn/end 归属无法证明"已经从何时
   * 开始持续、以及是否存在可用的迟到回调；manager 不持有该观察窗口。
   *
   * @param {object} identity - {parentTaskId, shardId, attempt, attemptId, executionGeneration}
   * @param {{reason?:string}} [options] - 可选诊断原因（缺省固定为 shard_attribution_unproven_aged）。
   * @returns {object} 结构化结果（accepted/changed/reason/status/taskStatus/counts）。
   */
  function markAttributionAged(identity, options = {}) {
    if (closed) {
      return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    }
    if (reclaimState !== null) return reclaimInProgressResult();
    const id = normalizeStopIdentity(identity);
    if (!id.ok) {
      return { accepted: false, changed: false, code: id.code, reason: id.reason, message: id.message };
    }
    if (!tasks.has(id.parentTaskId) && reclaimedTaskIds.has(id.parentTaskId)) {
      return taskReclaimedResult(id.parentTaskId);
    }
    const task = tasks.get(id.parentTaskId);
    const shard = task?.shards.find((entry) => entry.shardId === id.shardId);
    const attempt = shard?.attempts.find((entry) => entry.attempt === id.attempt);
    if (task === undefined || shard === undefined || attempt === undefined) {
      return {
        accepted: false,
        changed: false,
        code: "ATTRIBUTION_AGED_UNKNOWN_ATTEMPT",
        reason: "attribution_aged_unknown_attempt",
        parentTaskId: id.parentTaskId,
        shardId: id.shardId,
        attempt: id.attempt,
      };
    }
    if (attempt.attemptId !== id.attemptId || attempt.executionGeneration !== id.executionGeneration) {
      return {
        accepted: false,
        changed: false,
        code: "ATTRIBUTION_AGED_STALE",
        reason: "attribution_aged_stale",
        parentTaskId: task.parentTaskId,
        shardId: shard.shardId,
        attempt: attempt.attempt,
        expectedAttemptId: attempt.attemptId,
        expectedExecutionGeneration: attempt.executionGeneration,
        receivedAttemptId: id.attemptId,
        receivedExecutionGeneration: id.executionGeneration,
      };
    }
    const base = {
      parentTaskId: task.parentTaskId,
      shardId: shard.shardId,
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
    };
    // 已终态：可能是迟到 completion 已先一步收敛，或证据已到达。老化绝不能改写它。
    if (isTerminalShardStatus(attempt.status)) {
      return {
        accepted: true,
        changed: false,
        reason: "already_terminal",
        ...base,
        status: attempt.status,
        ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
        stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
        taskStatus: task.status,
        counts: computeCounts(task),
      };
    }
    // 原因码可由调用方覆盖，但默认固定值必须与诊断/测试契约一致。
    const reason = typeof options?.reason === "string" && options.reason.length > 0
      ? options.reason
      : "shard_attribution_unproven_aged";
    const settled = settleShard(task, shard, attempt, "interrupted", {
      error: {
        name: "ShardAttributionUnprovenError",
        reason: "shard_attribution_unproven_aged",
        message: "shard 归属无法证明且已超过人工处理宽限，需人工确认执行是否仍在写盘",
      },
      reason,
      // 不给停止证据：范围继续占用，聚合继续被 stop_pending 挡住。
      needsAttention: true,
    });
    if (settled !== true) {
      return {
        accepted: false,
        changed: false,
        reason: "invalid_transition",
        ...base,
        status: attempt.status,
        taskStatus: task.status,
      };
    }
    lastAttributionAged = {
      ...base,
      reason,
      at: attempt.finishedAt ?? now(),
      needsAttention: true,
    };
    return {
      accepted: true,
      changed: true,
      reason: "aged",
      ...base,
      status: attempt.status,
      terminalReason: attempt.terminalReason,
      stopState: STOP_EVIDENCE_STATE_UNKNOWN,
      needsAttention: true,
      taskStatus: task.status,
      counts: computeCounts(task),
    };
  }

  /**
   * 停止证据只读诊断（票据 07）：
   * - 未确认停止的 attempt 数（按"逻辑终态但未观察"统计，这才是聚合阻塞源）；
   * - 按任务/分片的摘要（只列有未确认/已请求/legacy 标记的条目，避免输出无界膨胀）；
   * - legacy 标记（旧快照缺少身份/证据字段而派生出来的 attempt）；
   * - 最近一次看门狗到期（谁在什么时候超过宽限仍未确认）。
   *
   * 不包含 prompt/result/error 等负载，供 Host 诊断投影直接透出。
   */
  function stopDiagnostics() {
    let unconfirmed = 0;
    let unobserved = 0;
    let requested = 0;
    let watchdogExpired = 0;
    let legacyAttempts = 0;
    /** 归属老化导致的 interrupted（理由码固定，独立计数便于诊断面直接展示）。 */
    let attributedAged = 0;
    /** 老化后仍未收到停止证据的 attempt 数（真正"需要人工处理"的活跃集合）。 */
    let needsAttention = 0;
    const summaries = [];
    for (const task of tasks.values()) {
      const attempts = [];
      let taskUnconfirmed = 0;
      for (const shard of task.shards) {
        for (const attempt of shard.attempts) {
          const observed = isStopObserved(attempt);
          const terminal = isTerminalShardStatus(attempt.status);
          if (!observed) unobserved += 1;
          if (terminal && !observed) { unconfirmed += 1; taskUnconfirmed += 1; }
          if (attempt.stopRequestedAt !== undefined) requested += 1;
          if (attempt.stopWatchdogExpiredAt !== undefined) watchdogExpired += 1;
          if (attempt.legacy === true) legacyAttempts += 1;
          const aged = attempt.terminalReason === "shard_attribution_unproven_aged";
          if (aged) attributedAged += 1;
          const attention = aged && !observed;
          if (attention) needsAttention += 1;
          const interesting = !observed
            || attempt.stopRequestedAt !== undefined
            || attempt.stopWatchdogExpiredAt !== undefined
            || attempt.legacy === true
            || aged;
          if (!interesting) continue;
          attempts.push({
            shardId: shard.shardId,
            attempt: attempt.attempt,
            attemptId: attempt.attemptId,
            executionGeneration: attempt.executionGeneration,
            status: attempt.status,
            stopState: observed ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
            ...(observed ? { stopSource: attempt.stopEvidence.source } : {}),
            ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
            ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
            ...(attempt.stopWatchdogExpiredAt === undefined ? {} : { stopWatchdogExpiredAt: attempt.stopWatchdogExpiredAt }),
            ...(attempt.terminalReason === undefined ? {} : { terminalReason: attempt.terminalReason }),
            aged,
            needsAttention: attention,
            legacy: attempt.legacy === true,
          });
        }
      }
      if (attempts.length === 0) continue;
      summaries.push({
        parentTaskId: task.parentTaskId,
        role: task.role,
        status: task.status,
        unconfirmed: taskUnconfirmed,
        counts: { pending: computeCounts(task).pending, stop_pending: countStopPending(task) },
        attempts,
      });
    }
    return {
      processInstance: PROCESS_INSTANCE,
      boundary: stopDiagnosticsState.boundary,
      boundarySource: stopDiagnosticsState.boundarySource,
      // stopPending 是 unconfirmed 的对外别名（Host/meta 诊断按这个名字投影）。
      stopPending: unconfirmed,
      unconfirmed,
      unobserved,
      requested,
      watchdogExpired,
      legacyAttempts,
      legacy: legacyAttempts,
      attributedAged,
      needsAttention,
      lastWatchdog: lastStopWatchdog === null ? null : cloneJson(lastStopWatchdog),
      lastAttributionAged: lastAttributionAged === null ? null : cloneJson(lastAttributionAged),
      tasks: summaries,
    };
  }

  /**
   * 取消单个 shard。立即返回接受结果：
   * - queued：直接进入 cancelled，永不 admission（从未创建 child -> not-started 证据）；
   * - running：调用注入取消器，**立即写逻辑终态 cancelled** 并请求停止（票据 07：
   *   逻辑收敛不依赖 child 回调），stopEvidence 保持 unknown 并挂宽限看门狗；
   * - 已终态：不改写，changed=false（重复取消幂等）。
   *
   * 返回值里的 pending=true 表示"已接受取消且停止未确认"（不是"还在 running"）。
   */
  function cancelShard(parentTaskId, shardId) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    if (reclaimState !== null) return reclaimInProgressResult();
    const task = tasks.get(parentTaskId);
    if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
    const shard = task.shards.find((entry) => entry.shardId === shardId);
    if (shard === undefined) return { accepted: false, changed: false, reason: "unknown_shard" };

    const attempt = activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
    if (isTerminalShardStatus(attempt.status)) {
      return {
        accepted: true,
        changed: false,
        shardStatus: shard.status,
        attempt: attempt.attempt,
        stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      };
    }
    if (attempt.cancelRequested === true) {
      // 已接受过取消请求：幂等返回，不重复调用取消器。
      return {
        accepted: true,
        changed: false,
        shardStatus: shard.status,
        attempt: attempt.attempt,
        pending: true,
        stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
        ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
      };
    }
    attempt.cancelRequested = true;
    if (attempt.status === "queued") {
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 在排队阶段被取消" }, "shard 已取消"),
        reason: "shard_cancelled",
      });
      return {
        accepted: true,
        changed: true,
        shardStatus: shard.status,
        attempt: attempt.attempt,
        stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      };
    }
    // running：先请求停止（把取消意图送达 child），再写逻辑终态；证据保持 unknown。
    requestShardCancellation(task, shard, attempt, "shard_cancelled");
    settleShard(task, shard, attempt, "cancelled", {
      error: toShardError(
        { name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消，等待停止确认" },
        "shard 已取消",
      ),
      reason: "shard_cancelled",
    });
    return {
      accepted: true,
      changed: true,
      shardStatus: shard.status,
      attempt: attempt.attempt,
      pending: true,
      stopState: isStopObserved(attempt) ? STOP_EVIDENCE_STATE_OBSERVED : STOP_EVIDENCE_STATE_UNKNOWN,
      ...(attempt.stopRequestedAt === undefined ? {} : { stopRequestedAt: attempt.stopRequestedAt }),
      ...(attempt.stopDeadlineAt === undefined ? {} : { stopDeadlineAt: attempt.stopDeadlineAt }),
    };
  }

  /**
   * 取消整个父任务。已终态 shard 不受影响，所有未终态 shard 立即停止 admission；
   * 父任务状态在全部 shard 收敛后聚合为 cancelled 或 completed_with_errors。
   */
  function cancelParent(parentTaskId) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    if (reclaimState !== null) return reclaimInProgressResult();
    const task = tasks.get(parentTaskId);
    if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
    /**
     * 只有"逻辑终态 **且** 停止已确认"才算真正结算。
     *
     * 旧判定只看逻辑终态，会把"终态但停止未确认"（任务仍是 pending、仍占着影响范围）
     * 误判为已结算，从而吞掉取消意图；新判定让这类任务继续走下面的取消登记，等证据到达
     * 后由聚合自然收敛为 cancelled。
     */
    const allTerminal = task.shards.every((shard) => {
      const attempt = shard.attempts[shard.attempts.length - 1];
      return attempt !== undefined && isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
    });
    if (allTerminal) {
      // 已结算父任务的取消请求是幂等 no-op，不能再写入 parentCancelRequested 或重复发布聚合事件。
      return {
        accepted: true,
        changed: false,
        taskStatus: task.status,
        cancelledShardIds: [],
        cancellingShardIds: [],
        alreadyTerminalShardIds: task.shards.map((shard) => shard.shardId),
      };
    }
    task.parentCancelRequested = true;
    const cancelledShardIds = [];
    const cancellingShardIds = [];
    const alreadyTerminalShardIds = [];
    for (const shard of task.shards) {
      const attempt = activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
      if (isTerminalShardStatus(attempt.status)) {
        alreadyTerminalShardIds.push(shard.shardId);
        continue;
      }
      if (attempt.cancelRequested === true) {
        // 已经接受过取消请求的 shard 不再重复请求取消器。
        alreadyTerminalShardIds.push(shard.shardId);
        continue;
      }
      attempt.cancelRequested = true;
      // 在 shard 上留父级取消标记：retryShard 只有显式清除它才允许重新 admission。
      shard.cancelRequested = true;
      if (attempt.status === "queued") {
        // queued 直接进入 cancelled，永不 admission。
        cancelledShardIds.push(shard.shardId);
        settleShard(task, shard, attempt, "cancelled", {
          error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "父任务取消，排队 shard 未 admission" }, "shard 已取消"),
          reason: "parent_cancelled",
        });
      } else {
        /**
         * running：先请求停止，再立即写逻辑终态（票据 07）。
         *
         * 与旧实现的关键差异：旧实现只把取消意图传给 child，等 completion 回调才收敛；
         * 一旦 child 永不回调（进程卡死/句柄丢失），父任务会永久停在 running。新语义下
         * 逻辑状态立刻收敛为 cancelled + stopEvidence=unknown，父任务保持 pending 直到
         * 权威停止证据到达——既不阻塞取消语义，也不谎称执行已停止。
         */
        cancellingShardIds.push(shard.shardId);
        requestShardCancellation(task, shard, attempt, "parent_cancelled");
        settleShard(task, shard, attempt, "cancelled", {
          error: toShardError(
            { name: "ShardCancelledError", reason: "cancelled", message: "父任务取消，等待停止确认" },
            "shard 已取消",
          ),
          reason: "parent_cancelled",
        });
      }
    }
    aggregateTask(task);
    notifyPersistence();
    schedule();
    return {
      accepted: true,
      changed: cancelledShardIds.length > 0 || cancellingShardIds.length > 0,
      taskStatus: task.status,
      cancelledShardIds,
      cancellingShardIds,
      alreadyTerminalShardIds,
    };
  }

  /**
   * 手工重试一个 shard。只允许 failed / timed_out / cancelled / interrupted，
   * 在原父任务内追加 attempt 并保留全部历史；最新 attempt 决定当前 shard 状态。
   */
  function retryShard(parentTaskId, shardId) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    if (reclaimState !== null) return reclaimInProgressResult();
    const task = tasks.get(parentTaskId);
    if (task === undefined) return { accepted: false, reason: "unknown_parent_task" };
    const shard = task.shards.find((entry) => entry.shardId === shardId);
    if (shard === undefined) return { accepted: false, reason: "unknown_shard" };
    const previous = shard.attempts[shard.attempts.length - 1];
    const retryable = previous.status === "failed"
      || previous.status === "timed_out"
      || previous.status === "cancelled"
      || previous.status === "interrupted";
    if (!retryable) return { accepted: false, reason: "not_retryable", shardStatus: shard.status, attempt: previous.attempt };

    /**
     * 停止 gate（票据 07）：只要该 shard 还有 attempt 未确认停止，就绝不创建新 attempt。
     *
     * 原因：超时/取消 attempt 未停止时重试，旧 child 仍可能在写同一批路径；新 attempt
     * 一旦开始，两个执行体就会并发写。拒绝路径只读不写——不追加 attempt、不改状态、
     * 不发事件，调用方拿到未确认 attempt 摘要后可以提交证据或转人工。
     *
     * 判定必须先于 attempt 预算：预算耗尽与"停止未确认"同时成立时，真正阻塞执行的是
     * 后者（补预算不会让执行变安全），返回 stop_unconfirmed 才有可操作的处置方向。
     */
    const stopGate = stopGateVerdict(shard);
    if (stopGate !== null) {
      return {
        accepted: false,
        changed: false,
        reason: "stop_unconfirmed",
        shardId: shard.shardId,
        shardStatus: shard.status,
        attempt: previous.attempt,
        attempts: stopGate.attempts,
      };
    }

    // attempt 数量预算：attempt 历史随重试无界增长（每个 attempt 都会进快照与事件），
    // 因此超限必须结构化失败且不新建 attempt。判定走 attemptBudgetVerdict（与
    // continue / restore resume 同源），判定的是"新建后的 attempt 数"（+1），
    // 这样恰好允许 maxAttemptsPerShard 个 attempt 存在。
    const attemptBudget = attemptBudgetVerdict(
      shard,
      "attempt",
      "该 shard 已耗尽重试预算，请提交新的父任务或拆分工作",
    );
    if (attemptBudget !== null) {
      noteBudgetViolation(attemptBudget.violation, "retry", { parentTaskId });
      return {
        accepted: false,
        changed: false,
        reason: attemptBudget.reason,
        shardStatus: shard.status,
        attempt: previous.attempt,
        violation: attemptBudget.violation,
      };
    }

    const nextAttempt = previous.attempt + 1;
    // 重试沿用分片/任务级超时配置，并重新读取一次当前角色默认值（票据 06）：
    // 新 attempt 按三级优先级解析，已经结束的旧 attempt 历史不受影响。
    const attempt = createAttempt(task, shard, nextAttempt);
    shard.attempts.push(attempt);
    // 手工重试是对取消的显式复活：清除该 shard 的取消请求标记，允许重新 admission。
    // 父任务的 parentCancelRequested 保持不变，剩余 queued shard 仍然不会自动派发。
    delete attempt.cancelRequested;
    shard.cancelRequested = false;
    updateShardStatus(task, shard, "queued");
    // 复活了一个非终态 shard，父任务立即回到 pending（不发布 task_settled 之外的新终态事件）。
    task.status = "pending";
    task.settledAt = undefined;
    emitShardStatus(task, shard, "queued", nextAttempt, { retryOf: previous.attempt });
    notifyPersistence();
    schedule();
    return { accepted: true, attempt: nextAttempt, shardStatus: shard.status, previousStatus: previous.status };
  }

  /**
   * shard 级逐动作能力（票据 09）：只读、不改写任何状态、不发事件、不写持久化。
   *
   * 判定顺序刻意与真实写入口一致：先「是否终态/是否可重试终态」，再停止证据 gate，
   * 最后 attempt 预算。这样界面上的按钮与 manager 真会接受的动作共用同一套规则，
   * 不会出现「界面允许、点了却被拒绝」的第二套语义。
   *
   * @param {object} shard - manager 内部 shard（含 attempts 历史）。
   * @returns {{shardId:string|null, cancel:{allowed:boolean,reason?:string}, retry:{allowed:boolean,reason?:string}}}
   */
  function shardCapabilities(shard) {
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    const latest = attempts.length === 0 ? undefined : attempts[attempts.length - 1];
    const shardId = typeof shard?.shardId === "string" && shard.shardId.length > 0 ? shard.shardId : null;
    // 取消：queued/running（含 stop 未确认但已逻辑终态之外的形态）可取消；终态不再提供入口。
    const cancel = latest === undefined
      ? { allowed: false, reason: "not_supported" }
      : isTerminalShardStatus(latest.status)
        ? { allowed: false, reason: "already_terminal" }
        : { allowed: true };
    /**
     * 重试：只允许四类可重试终态。
     * - 未终态 → task_not_terminal（还可能自然结束，不应引导重试）；
     * - 成功 → no_retryable_shard（没有可重试的失败面）；
     * - 停止未确认 → stop_unconfirmed（新 attempt 会与旧执行体并发写）；
     * - attempt 预算耗尽 → attempt_limit（再点只会被 manager 拒绝）。
     */
    let retry;
    if (latest === undefined) {
      retry = { allowed: false, reason: "no_retryable_shard" };
    } else if (!isTerminalShardStatus(latest.status)) {
      retry = { allowed: false, reason: "task_not_terminal" };
    } else if (!RETRYABLE_SHARD_STATUSES.has(latest.status)) {
      retry = { allowed: false, reason: "no_retryable_shard" };
    } else if (stopGateVerdict(shard) !== null) {
      retry = { allowed: false, reason: "stop_unconfirmed" };
    } else if (attemptBudgetVerdict(shard, "attempt", "该 shard 已耗尽重试预算") !== null) {
      retry = { allowed: false, reason: "attempt_limit" };
    } else {
      retry = { allowed: true };
    }
    return { shardId, cancel, retry };
  }

  /**
   * 父任务是否「全部逻辑终态且停止已确认」：与 cancelParent 的 allTerminal 同一判定。
   * 只有这种任务才不需要取消入口；仍在等待停止确认的任务继续保持可取消（幂等 no-op）。
   */
  function taskFullySettled(task) {
    if (task.shards.length === 0) return typeof task.settledAt === "number";
    return task.shards.every((shard) => {
      const attempt = shard.attempts[shard.attempts.length - 1];
      return attempt !== undefined && isTerminalShardStatus(attempt.status) && isStopObserved(attempt);
    });
  }

  /** 任务级取消能力：只有仍会被 manager 处理的父任务才暴露取消入口。 */
  function taskCancelCapability(task) {
    return taskFullySettled(task)
      ? { allowed: false, reason: "already_terminal" }
      : { allowed: true };
  }

  /**
   * 任务级重试能力：任一分片可重试即可。
   *
   * 原因优先级固定（stop_unconfirmed > attempt_limit > task_not_terminal > no_retryable_shard），
   * 保证同一份任务每次投影都得到同一个原因码，客户端不会因遍历顺序不同而抖动。
   */
  function taskRetryCapability(shardCaps) {
    if (shardCaps.some((caps) => caps.retry.allowed === true)) return { allowed: true };
    const reasons = new Set(shardCaps.map((caps) => caps.retry.reason));
    for (const reason of ["stop_unconfirmed", "attempt_limit", "task_not_terminal", "no_retryable_shard"]) {
      if (reasons.has(reason)) return { allowed: false, reason };
    }
    return { allowed: false, reason: "no_retryable_shard" };
  }

  /**
   * 任务级续作能力：判定顺序与 continueTask 的前置条件一致
   * （parent_cancelled → 任一分片未完成 → 停止未确认 → attempt 预算）。
   * role/shard 结构一致性需要调用方输入，无法在这里投影，仍由 manager 在写入口校验。
   */
  function taskContinueCapability(task) {
    if (task.parentCancelRequested === true) return { allowed: false, reason: "parent_cancelled" };
    for (const shard of task.shards) {
      const latest = shard.attempts[shard.attempts.length - 1];
      if (latest === undefined || !isTerminalShardStatus(latest.status)) {
        return { allowed: false, reason: "task_not_terminal" };
      }
    }
    for (const shard of task.shards) {
      if (stopGateVerdict(shard) !== null) return { allowed: false, reason: "stop_unconfirmed" };
    }
    for (const shard of task.shards) {
      if (attemptBudgetVerdict(shard, "attempt", "该 shard 已耗尽多轮复用预算") !== null) {
        return { allowed: false, reason: "attempt_limit" };
      }
    }
    return { allowed: true };
  }

  /**
   * 逐动作能力（票据 09）：manager 侧唯一的只读能力投影。
   *
   * 形状：任务级 { read, cancel, retry, continue } + 按 shard 的 { cancel, retry }；
   * 每项都是 { allowed:boolean, reason?:string }。原因码只使用稳定机器 token：
   * task_not_found / already_terminal / task_not_terminal / stop_unconfirmed /
   * attempt_limit / no_retryable_shard / parent_cancelled / not_supported。
   *
   * 边界：
   * - 不回答归属（归属由 Host 的 capabilitiesOf 先判定），只回答「假设这是你的任务，动作是否可执行」；
   * - 任务不存在或 manager 已关闭 → 全部 task_not_found；
   * - 纯读：不触发聚合、不发事件、不写持久化，可被客户端轮询路径高频调用。
   *
   * @param {string} parentTaskId - fan-out 父任务 id。
   * @returns {object} 结构化能力投影（永远返回对象，不抛错）。
   */
  function taskCapabilities(parentTaskId) {
    const taskId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";
    const missing = () => ({
      parentTaskId: taskId,
      read: { allowed: false, reason: "task_not_found" },
      cancel: { allowed: false, reason: "task_not_found" },
      retry: { allowed: false, reason: "task_not_found" },
      continue: { allowed: false, reason: "task_not_found" },
      shards: {},
    });
    if (closed || taskId.length === 0) return missing();
    const task = tasks.get(taskId);
    if (task === undefined) return missing();
    const shardCaps = task.shards.map(shardCapabilities);
    const shards = {};
    for (const caps of shardCaps) {
      if (caps.shardId === null) continue;
      shards[caps.shardId] = { cancel: caps.cancel, retry: caps.retry };
    }
    return {
      parentTaskId: taskId,
      read: { allowed: true },
      cancel: taskCancelCapability(task),
      retry: taskRetryCapability(shardCaps),
      continue: taskContinueCapability(task),
      shards,
    };
  }

  function getTask(parentTaskId) {
    const task = tasks.get(parentTaskId);
    return task === undefined ? null : cloneJson(taskSnapshot(task));
  }

  function listTasks() {
    return cloneJson([...tasks.values()].map((task) => taskSnapshot(task)));
  }

  function getCounts(parentTaskId) {
    const task = tasks.get(parentTaskId);
    return task === undefined ? null : cloneJson(computeCounts(task));
  }

  /** 订阅状态变化事件；返回退订函数。事件按真实发生顺序同步发布。 */
  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new FanoutValidationError("INVALID_LISTENER", "listener 必须是函数");
    }
    if (closed) return () => {};
    subscribers.add(listener);
    return () => { subscribers.delete(listener); };
  }

  /** 等待当前调度工作全部派发完成（测试与 Host 收尾用）。 */
  function whenIdle() {
    // close 不会遗留新的调度工作；若 close 前已经排了 drain，仍等待该 drain 有界结束。
    return drainScheduled ? drainPromise : Promise.resolve();
  }

  /** 当前调度器是否没有排队中的 drain；running child 仍可继续执行。 */
  function isIdle() {
    return closed || (!drainScheduled && !workRequested);
  }

  /**
   * 从持久化快照恢复已登记任务。
   *
   * 恢复只重建逻辑状态，不复用任何 childId/句柄：快照中处于 running 的 shard 说明
   * 原运行时已经消失，统一标记为 interrupted；若 resume=true，这类 shard 会像
   * retryShard 一样追加一个新 attempt 继续执行（历史 attempt 与结果原样保留）。
   * 快照中仍处于 queued 的 shard 保持原 attempt 重新排队，已终态（succeeded/failed/
   * cancelled/timed_out/interrupted 且无新 attempt）的 shard 一律不重新派发。
   * 所有重派发都经过同一个 dispatchAvailable（per-role 限流、父任务轮转、
   * affectedPaths 冲突判定），restore 不复制任何调度规则。
   *
   * @param {object} snapshot - serializeSnapshot() 产出的快照。
   * @param {{resume?:boolean, merge?:boolean, stopEvidenceBoundary?:"unknown"|"process-restart"}} [restoreOptions]
   *   - resume=true 时显式触发一次重新派发；
   *   - merge=true 时保留当前任务并追加本次快照中的新任务，用于 deferred root 到达后的分批恢复；
   *   - stopEvidenceBoundary（票据 07）决定"快照里未确认停止的 attempt"如何恢复：
   *     "unknown"（默认）保持未知、继续占用影响范围并拒绝自动续跑；
   *     "process-restart" 把快照内 attempt 一律视为 observed(source=process-restart)，
   *     只在"重启确实终止了执行体所属进程"时使用（Host 冷启动接线在后续任务）。
   *   默认（false）只重建状态并让队列在下次调度时机自然派发。
   * @returns {{restored:boolean, tasks:number}}
   */
  function restore(snapshot, restoreOptions = {}) {
    if (closed) {
      return { accepted: false, restored: 0, tasks: 0, code: "MANAGER_CLOSED", reason: "manager_closed" };
    }
    // 回收屏障期间恢复会重建/覆盖任务表，直接破坏候选快照的一致性。
    if (reclaimState !== null) return { ...reclaimInProgressResult(), restored: 0, tasks: 0 };
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new FanoutValidationError("INVALID_SNAPSHOT", "restore 需要快照对象");
    }
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw new FanoutValidationError("UNSUPPORTED_SNAPSHOT_VERSION", "不支持的快照版本: " + String(snapshot.version), { field: "version" });
    }
    if (!Array.isArray(snapshot.tasks)) {
      throw new FanoutValidationError("INVALID_SNAPSHOT", "快照缺少 tasks 数组", { field: "tasks" });
    }
    if (snapshot.events !== undefined && (!Array.isArray(snapshot.events) || snapshot.events.some((event) => (
      event === null || typeof event !== "object" || Array.isArray(event)
      || !Number.isSafeInteger(event.sequence) || event.sequence < 1
    )))) {
      throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 events 必须是带正序列号的对象数组", { field: "events" });
    }
    // 规模预算先于逐项结构校验：超限的恢复输入必须给出 BUDGET_EXCEEDED（可定位到资源），
    // 而不是先被结构/历史转移校验拦成另一个错误。这里仍在任何状态修改与 clone 之前。
    // 外部持久化输入的规模预算：必须在任何状态修改与大规模 clone 之前判定。
    // 超限即原子失败（tasks/eventHistory/配置全部保持不变），并给出可定位的违规。
    const restoreBudget = checkRestoreBudget(snapshot, {
      existingTasks: restoreOptions.merge === true ? tasks.size : 0,
      maxBytes: budgetPolicy.maxSnapshotBytes,
    });
    if (!restoreBudget.ok) {
      // restore 发生在 manager 状态恢复之前，且既有契约要求"超预算恢复原子失败、
      // 不写 eventHistory"。因此这里只记录 lastViolation（emitEvent:false），由 Host
      // 捕获结构化错误后调用 recordBudgetViolation() 补发 budget_rejected(phase=restore)。
      noteBudgetViolation(restoreBudget.violation, "restore", { emitEvent: false });
      throw validationError({
        ok: false,
        code: "INVALID_BUDGET",
        message: restoreBudget.violation.message,
        field: "snapshot",
        violation: restoreBudget.violation,
      });
    }

    /**
     * 停止证据边界（票据 07）：决定"快照里未确认停止的 attempt"在恢复后怎么处理。
     *
     * 解析规则（显式优先，否则按进程身份自动判定）：
     * - 显式 stopEvidenceBoundary：调用方明确知道恢复语义时使用；非法值结构化拒绝。
     * - 自动：快照 processInstance 与当前进程相同 → unknown（进程内重建，不证明旧 child
     *   已停止）；不同或缺失（旧版本/旧进程快照）→ process-restart（规格允许的唯一其他
     *   释放边界）。缺失不能当成"同进程"：旧版本快照没有该字段，其执行体属于未知进程，
     *   只能按进程已终止处理，否则恢复后的任务会永久 pending 且无法自动收敛。
     *
     * 两种边界的语义：
     * - unknown：running -> interrupted/unknown，历史终态但无证据的一律保持 unknown 并
     *   标记 legacy；影响范围继续占用，任务保持 pending，重试/续作/续跑全部被
     *   stop_unconfirmed 挡住，直到 Host 提交证据。
     * - process-restart：快照内 attempt 一律 observed(source="process-restart")。
     */
    const explicitStopEvidenceBoundary = restoreOptions?.stopEvidenceBoundary === undefined
      || restoreOptions?.stopEvidenceBoundary === null
      ? undefined
      : restoreOptions.stopEvidenceBoundary;
    if (explicitStopEvidenceBoundary !== undefined
      && !STOP_EVIDENCE_BOUNDARIES.includes(explicitStopEvidenceBoundary)) {
      throw new FanoutValidationError(
        "INVALID_STOP_EVIDENCE_BOUNDARY",
        "stopEvidenceBoundary 必须是 " + STOP_EVIDENCE_BOUNDARIES.join(" / ") + " 之一",
        { field: "stopEvidenceBoundary" },
      );
    }
    const snapshotProcessInstance = typeof snapshot.processInstance === "string" && snapshot.processInstance.length > 0
      ? snapshot.processInstance
      : undefined;
    const stopEvidenceBoundary = explicitStopEvidenceBoundary ?? (
      snapshotProcessInstance !== undefined && snapshotProcessInstance === PROCESS_INSTANCE
        ? "unknown"
        : "process-restart"
    );
    const stopEvidenceBoundarySource = explicitStopEvidenceBoundary !== undefined
      ? "explicit"
      : "process-instance";
    /**
     * 本次恢复实际落到各任务上的边界集合。
     *
     * 大多数快照的任务边界一致；但 Host 会把"root 未到达"的任务延迟恢复，并在持久化
     * 投影里把旧任务与新进程快照合并。这类被延迟的任务会携带**来源进程**的
     * task.processInstance（见 Host 的 deferTask 投影），因此边界必须按任务解析：
     * 同一个快照里可能同时存在"本进程重建的任务"和"上一进程遗留的任务"。
     */
    const resolvedBoundaries = new Set();
    // 恢复后新建 attempt 的代次必须大于全部历史代次（迟到证据隔离）。
    let restoredMaxGeneration = 0;

    for (const task of snapshot.tasks) {
      if (task === null || typeof task !== "object" || typeof task.parentTaskId !== "string" || task.parentTaskId.length === 0) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 parentTaskId", { field: "tasks" });
      }
      if (typeof task.role !== "string" || !Array.isArray(task.shards)) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 role/shards: " + task.parentTaskId, { field: "tasks" });
      }
      // provider 归属（票据 26）：存在时必须是可用的非空字符串；缺失是合法的（旧快照
      // 或角色未配置主模型），恢复后保持 undefined，provider 限流对它不生效。
      if (task.provider !== undefined && (typeof task.provider !== "string" || task.provider.trim().length === 0)) {
        throw new FanoutValidationError(
          "INVALID_SNAPSHOT",
          "快照任务 provider 必须是非空字符串: " + task.parentTaskId,
          { field: "tasks.provider" },
        );
      }
      if (task.status !== undefined && !FANOUT_TASK_STATUSES.includes(task.status)) {
        throw new FanoutValidationError(
          "INVALID_SNAPSHOT_STATUS",
          "快照任务状态非法: " + String(task.status),
          { field: "tasks.status", status: task.status },
        );
      }
      if (task.concurrencyLimit !== undefined) {
        const check = validateConcurrencyLimit(task.concurrencyLimit);
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "tasks.concurrencyLimit" });
      }
      // 超时（票据 06）：恢复路径对历史正有限值兼容（不做整秒收紧），
      // 但结构上必须是「0 或正有限数」——否则就是一份无法解释的快照。
      if (task.timeoutMs !== undefined) {
        const check = validateRestoredTimeoutMs(task.timeoutMs, "tasks.timeoutMs");
        if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "tasks.timeoutMs" });
      }
      // continuation 幂等记录（外部持久化输入）：结构必须严格合法，否则整体拒绝——
      // 静默丢弃会让「曾经续作过的 requestId」在恢复后被当成新请求而重复追加 attempt。
      if (task.continuationRequests !== undefined) {
        const requests = task.continuationRequests;
        if (requests === null || typeof requests !== "object" || Array.isArray(requests)) {
          throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 continuationRequests 必须是对象: " + task.parentTaskId, { field: "tasks.continuationRequests" });
        }
        const keys = Object.keys(requests);
        if (keys.length > budgetPolicy.maxAttemptsPerShard) {
          // 这条也是预算拒绝：补齐结构化 violation（旧实现只给 code/field），
          // 让 Host 能像其它恢复超限一样补发统一 budget 事件。
          const violation = describeBudgetViolation({
            resource: "attempts",
            limit: budgetPolicy.maxAttemptsPerShard,
            receivedBytes: keys.length,
            recoverable: false,
            subject: task.parentTaskId,
            hint: "快照中的 continuationRequests 条数超过 attempt 预算，请清理该任务的历史请求",
          });
          noteBudgetViolation(violation, "restore", { emitEvent: false });
          throw new FanoutValidationError(
            "INVALID_BUDGET",
            "快照 continuationRequests 条数超过预算: " + task.parentTaskId,
            { field: "tasks.continuationRequests", violation },
          );
        }
        for (const requestId of keys) {
          const entry = requests[requestId];
          if (requestId.length === 0 || entry === null || typeof entry !== "object" || Array.isArray(entry)
            || entry.result === null || typeof entry.result !== "object" || Array.isArray(entry.result)) {
            throw new FanoutValidationError(
              "INVALID_SNAPSHOT",
              "快照 continuationRequests 记录非法: " + task.parentTaskId,
              { field: "tasks.continuationRequests" },
            );
          }
        }
      }
      for (let shardIndex = 0; shardIndex < task.shards.length; shardIndex += 1) {
        const shard = task.shards[shardIndex];
        const shardField = "tasks.shards[" + shardIndex + "]";
        if (shard === null || typeof shard !== "object" || typeof shard.shardId !== "string" || !Array.isArray(shard.attempts)) {
          throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 shard 结构非法: " + task.parentTaskId, { field: shardField });
        }
        const nameVerdict = validateShardName(shard.name, shardField + ".name");
        if (!nameVerdict.ok) throw validationError(nameVerdict);
        if (shard.status !== undefined && !SHARD_STATUS_SET.has(shard.status)) {
          throw new FanoutValidationError(
            "INVALID_SNAPSHOT_STATUS",
            "快照 shard 状态非法: " + String(shard.status),
            { field: shardField + ".status", status: shard.status },
          );
        }
        // 分片级超时同样按恢复语义校验：旧快照的任意正有限值必须可恢复。
        if (shard.timeoutMs !== undefined) {
          const check = validateRestoredTimeoutMs(shard.timeoutMs, shardField + ".timeoutMs");
          if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: shardField + ".timeoutMs" });
        }
        for (let attemptIndex = 0; attemptIndex < shard.attempts.length; attemptIndex += 1) {
          const rawAttempt = shard.attempts[attemptIndex];
          const attemptField = shardField + ".attempts[" + attemptIndex + "]";
          if (rawAttempt === null || typeof rawAttempt !== "object" || Array.isArray(rawAttempt)) {
            throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 attempt 结构非法: " + task.parentTaskId, { field: attemptField });
          }
          if (rawAttempt.status !== undefined && !SHARD_STATUS_SET.has(rawAttempt.status)) {
            throw new FanoutValidationError(
              "INVALID_SNAPSHOT_STATUS",
              "快照 attempt 状态非法: " + String(rawAttempt.status),
              { field: attemptField + ".status", status: rawAttempt.status },
            );
          }
          // 追加 attempt 前，旧 attempt 必须已经终态；否则恢复会把非法历史静默变成可派发队列。
          if (attemptIndex < shard.attempts.length - 1
            && rawAttempt.status !== undefined
            && !isTerminalShardStatus(rawAttempt.status)) {
            throw new FanoutValidationError(
              "INVALID_SNAPSHOT_TRANSITION",
              "快照 attempt 历史包含未终态转移: " + task.parentTaskId,
              { field: attemptField + ".status", status: rawAttempt.status },
            );
          }
          // 停止证据字段（票据 07）：结构非法整体拒绝，绝不静默降级。
          const stopFieldsVerdict = validateRestoredStopFields(rawAttempt, attemptField);
          if (!stopFieldsVerdict.ok) throw validationError(stopFieldsVerdict);
          // 代次种子：即使 attemptId/generation 缺失（旧快照）也要把派生值计入上界，
          // 保证恢复后新建的 attempt 代次严格大于所有历史值。
          const candidateGeneration = Number.isSafeInteger(rawAttempt.executionGeneration)
            ? rawAttempt.executionGeneration
            : (Number.isInteger(rawAttempt.attempt) && rawAttempt.attempt > 0 ? rawAttempt.attempt : attemptIndex + 1);
          if (candidateGeneration > restoredMaxGeneration) restoredMaxGeneration = candidateGeneration;
        }
      }
    }

    // 配置必须沿用创建 manager 时的校验边界；所有字段先完成校验，再一次性替换，
    // 避免半个快照生效后把当前 manager 留在不可用状态。
    //
    // 并发来源模型（票据 03「并发来源修复」）：
    // - 构造期注入了 live 解析函数：resolverSource 永远是 live。快照里的
    //   defaultConcurrencyLimit 只是诊断负载，**不得**覆盖当前设置——否则一次重启就会
    //   把 live settings 永久旁路（本票据修复的缺陷）；
    // - 没有 live resolver：进程读不到"当前设置"，冻结快照值（或构造默认值）并在诊断
    //   里标注 snapshot；
    // - 旧快照没有 concurrencySource 标记时按同一规则"尽量 live"：有 resolver 就 live，
    //   没有才冻结。标记只服务外部读者/诊断，不改变恢复决策。
    // 任务级 concurrencyLimit 不受这里影响：它始终优先，且由 task.concurrencyLimit 固化。
    const restoredDefaultConcurrencyLimit = snapshot.defaultConcurrencyLimit === undefined
      ? defaultConcurrencyLimit
      : (() => {
          const check = validateConcurrencyLimit(snapshot.defaultConcurrencyLimit);
          if (!check.ok) throw new FanoutValidationError(check.code, check.message, { field: "defaultConcurrencyLimit" });
          return check.value;
        })();
    const restoredRoleLimits = snapshot.roleLimits === undefined
      ? roleLimits
      : normalizeRoleLimits(snapshot.roleLimits);
    // provider 级映射与 roleLimits 同一来源模型（票据 26）：结构非法时整体拒绝
    // 快照，绝不静默降级成「不限制」——那会把用户明确配置的名额悄悄放开。
    const restoredProviderLimits = snapshot.providerLimits === undefined
      ? providerLimits
      : normalizeProviderLimits(snapshot.providerLimits);
    if (snapshot.writeRoles !== undefined
      && snapshot.writeRoles !== null
      && !Array.isArray(snapshot.writeRoles)
      && typeof snapshot.writeRoles !== "string") {
      throw new FanoutValidationError("INVALID_WRITE_ROLES", "快照 writeRoles 必须是字符串数组", { field: "writeRoles" });
    }
    if (Array.isArray(snapshot.writeRoles) && snapshot.writeRoles.some((role) => typeof role !== "string")) {
      throw new FanoutValidationError("INVALID_WRITE_ROLES", "快照 writeRoles 必须是字符串数组", { field: "writeRoles" });
    }
    const restoredWriteRoles = snapshot.writeRoles === undefined
      ? writeRoles
      : normalizeWriteRoles(snapshot.writeRoles);
    const restoredDefaultAllowOverlap = snapshot.defaultAllowOverlap === undefined
      ? defaultAllowOverlap
      : (() => {
          if (typeof snapshot.defaultAllowOverlap !== "boolean") {
            throw new FanoutValidationError("INVALID_ALLOW_OVERLAP", "快照 defaultAllowOverlap 必须是布尔值", { field: "defaultAllowOverlap" });
          }
          return snapshot.defaultAllowOverlap;
        })();

    // 校验全部通过后才修改内存状态：非法快照不得破坏现有任务或配置。
    //
    // 默认上限：只有"没有当前设置可读"时才冻结快照值；有 live resolver 时保持 live，
    // 快照值完全不参与调度（它最后一次生效值仍写回快照作诊断）。
    if (!hasLiveConcurrencyResolver) {
      defaultConcurrencyLimit = restoredDefaultConcurrencyLimit;
      lastResolvedDefaultConcurrencyLimit = restoredDefaultConcurrencyLimit;
      resolverSource = "snapshot";
    }
    // 角色级映射：静态映射沿用既有语义（快照替换构造配置）；live 解析函数优先，
    // 快照显式映射只作为第二层回退（见 resolveRoleLimits）。
    if (snapshot.roleLimits !== undefined) {
      if (typeof roleLimits === "function") {
        restoredRoleLimitOverrides = Object.freeze({ ...restoredRoleLimits });
      } else {
        roleLimits = restoredRoleLimits;
      }
    } else if (typeof roleLimits === "function") {
      // 快照没有角色级映射：清空上一轮的第二层回退，避免跨快照残留旧覆盖。
      restoredRoleLimitOverrides = Object.freeze({});
    }
    // provider 级映射复用同一套两层语义（票据 26）：live 解析函数优先，快照映射只作
    // 第二层回退；静态映射沿用「快照替换构造配置」的既有语义。
    if (snapshot.providerLimits !== undefined) {
      if (typeof providerLimits === "function") {
        restoredProviderLimitOverrides = Object.freeze({ ...restoredProviderLimits });
      } else {
        providerLimits = restoredProviderLimits;
      }
    } else if (typeof providerLimits === "function") {
      restoredProviderLimitOverrides = Object.freeze({});
    }
    writeRoles = restoredWriteRoles;
    defaultAllowOverlap = restoredDefaultAllowOverlap;
    if (typeof injectedConflictChecker !== "function") {
      conflictChecker = createWriteRoleConflictChecker({ writeRoles });
    }
    const resume = restoreOptions.resume === true;
    const merge = restoreOptions.merge === true;
    /**
     * 超时投影兼容（票据 06）：
     * - 新快照带 timeoutProjection 标记：分片覆盖只认 rawShard.timeoutMs（缺失 = 无覆盖）；
     * - 旧快照无标记：继续用最新 attempt 的 timeoutMs 反推分片覆盖。
     *   旧语义下 attempt.timeoutMs 恒等于 shard.timeoutMs，因此这是一致的历史恢复；
     *   新语义下 attempt.timeoutMs 可能来自父任务/角色默认值，所以新快照必须禁止反推。
     */
    const projectsShardTimeout = snapshot.timeoutProjection === TIMEOUT_PROJECTION_VERSION;
    if (!merge) {
      tasks.clear();
      requestIndex.clear();
      rotationCursors.clear();
    }
    // restore 在所有任务重建完成后一次性刷新派生索引，确保 merge 替换任务时不留旧引用。
    const restoredEvents = Array.isArray(snapshot.events)
      ? snapshot.events.slice(-budgetPolicy.maxEventHistory).map((event) => cloneJson(event))
      : [];
    // 快照事件数超过条数预算时，slice 丢掉的最旧记录同样属于 gap 事实（不是静默丢失）。
    if (Array.isArray(snapshot.events) && snapshot.events.length > restoredEvents.length) {
      droppedEventCount += snapshot.events.length - restoredEvents.length;
    }
    // 恢复输入可能是乱序（外部磁盘/旧版本）：按 sequence 升序落历史，既保证
    // earliestAvailableSequence 是真正的最旧一条，也让裁剪可以安全地从队首丢弃。
    restoredEvents.sort((left, right) => left.sequence - right.sequence);
    const highestEventSequence = restoredEvents.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    sequence = merge
      ? Math.max(sequence, Number.isInteger(snapshot.sequence) ? snapshot.sequence : 0, highestEventSequence)
      : Math.max(Number.isInteger(snapshot.sequence) ? snapshot.sequence : 0, highestEventSequence);
    if (merge) {
      const knownSequences = new Set(eventHistory.map((event) => event.sequence));
      for (const event of restoredEvents) {
        if (!knownSequences.has(event.sequence)) eventHistory.push(event);
      }
      eventHistory.sort((left, right) => left.sequence - right.sequence);
      rebuildEventAccounting();
      trimEventHistory();
    } else {
      eventHistory.splice(0, eventHistory.length, ...restoredEvents);
      rebuildEventAccounting();
      // 快照已由 checkRestoreBudget 校验过条数/字节，这里仍走同一条裁剪路径：
      // 防御旧快照/直接调用 restore 的输入，同时保持 dropped 统计与运行时一致。
      trimEventHistory();
    }
    nextTaskNumber = merge
      ? Math.max(nextTaskNumber, Number.isInteger(snapshot.nextTaskNumber) ? snapshot.nextTaskNumber : 0)
      : Number.isInteger(snapshot.nextTaskNumber) ? snapshot.nextTaskNumber : 0;
    if (snapshot.parentRotation !== null && typeof snapshot.parentRotation === "object") {
      for (const [role, cursor] of Object.entries(snapshot.parentRotation)) {
        if (Number.isInteger(cursor) && cursor >= 0) rotationCursors.set(role, cursor);
      }
    }
    restoreDispatchSuppressed = !resume;
    workRequested = false;
    // 代次种子：恢复后新建 attempt 的代次必须严格大于全部历史值（见 restoredMaxGeneration）。
    nextExecutionGeneration = Math.max(
      Number.isSafeInteger(snapshot.nextExecutionGeneration) ? snapshot.nextExecutionGeneration : 0,
      restoredMaxGeneration,
      nextExecutionGeneration,
    );
    // 记录本次恢复使用的停止证据边界（只读诊断；不写入快照——边界属于恢复进程的决定）。
    // 多任务混合边界（延迟恢复的旧任务 + 本进程任务）显式投影为 "mixed"。
    const effectiveBoundary = explicitStopEvidenceBoundary !== undefined
      ? explicitStopEvidenceBoundary
      : resolvedBoundaries.size === 0
        ? stopEvidenceBoundary
        : resolvedBoundaries.size === 1
          ? [...resolvedBoundaries][0]
          : "mixed";
    stopDiagnosticsState.boundary = effectiveBoundary;
    stopDiagnosticsState.boundarySource = stopEvidenceBoundarySource;
    const rolesToSchedule = new Set();
    restoringSnapshot = true;
    for (const rawTask of snapshot.tasks) {
      const parentCancelRequested = rawTask.parentCancelRequested === true;
      // 角色在构造 task 之前取出：shards.map 的回调在 task 对象字面量求值期间执行，
      // 此时 `task` 仍处于 TDZ，任何对 task.role 的引用都会抛 ReferenceError
      // （整个 restore 因此静默失败）。用已校验的 rawTask.role 作为本任务的 role 源。
      const taskRole = rawTask.role;
      /**
       * 任务级边界：显式边界优先；否则任务自身携带的来源进程身份优先于快照顶层值。
       * Host 延迟恢复的旧任务靠 task.processInstance 保留真实来源，避免被合并后的
       * 顶层"当前进程"身份误判为同进程重建。
       */
      const taskProcessInstance = typeof rawTask.processInstance === "string" && rawTask.processInstance.length > 0
        ? rawTask.processInstance
        : snapshotProcessInstance;
      const taskBoundary = explicitStopEvidenceBoundary ?? (
        taskProcessInstance !== undefined && taskProcessInstance === PROCESS_INSTANCE
          ? "unknown"
          : "process-restart"
      );
      resolvedBoundaries.add(taskBoundary);
      const task = {
        parentTaskId: rawTask.parentTaskId,
        ...(typeof rawTask.requestId === "string" ? { requestId: rawTask.requestId } : {}),
        role: taskRole,
        basePrompt: typeof rawTask.basePrompt === "string" ? rawTask.basePrompt : "",
        status: "pending",
        // 轮次随快照持久化：旧快照没有该字段时按第 1 轮（首次提交）归一。
        round: Number.isSafeInteger(rawTask.round) && rawTask.round >= 1 ? rawTask.round : 1,
        // continuation 幂等记录恢复：restore 后旧 requestId 仍然 duplicate=true，
        // 且绝不因为索引淘汰而把旧键当成新的一轮（幂等键的生命周期 = 任务生命周期）。
        ...(rawTask.continuationRequests === undefined || rawTask.continuationRequests === null
          ? {}
          : { continuationRequests: cloneJson(rawTask.continuationRequests) }),
        allowOverlap: rawTask.allowOverlap === true,
        ...(typeof rawTask.concurrencyLimit === "number" ? { concurrencyLimit: rawTask.concurrencyLimit } : {}),
        // 父任务级默认超时随快照恢复；缺字段（旧快照）等于「未设置」，
        // 之后创建的 attempt 依然能取到当前角色默认值。
        ...(typeof rawTask.timeoutMs === "number" ? { timeoutMs: rawTask.timeoutMs } : {}),
        // provider 归属随快照恢复（票据 26）；旧快照缺字段时保持 undefined，
        // provider 计数因此不会凭空给该任务建份额。
        ...(typeof rawTask.provider === "string" ? { provider: rawTask.provider.trim() } : {}),
        createdAt: typeof rawTask.createdAt === "number" ? rawTask.createdAt : now(),
        updatedAt: typeof rawTask.updatedAt === "number" ? rawTask.updatedAt : now(),
        settledAt: typeof rawTask.settledAt === "number" ? rawTask.settledAt : undefined,
        parentCancelRequested,
        shards: rawTask.shards.map((rawShard) => {
          const attempts = (rawShard.attempts.length === 0 ? [{ attempt: 1, status: "queued" }] : rawShard.attempts).map((rawAttempt, index) => {
            const attemptNumber = Number.isInteger(rawAttempt.attempt) ? rawAttempt.attempt : index + 1;
            /**
             * attempt 身份与停止证据恢复（票据 07）：
             * - 字段存在则原样使用（身份必须跨重启稳定，否则 Host 无法提交证据）；
             * - 旧快照缺字段时按确定性规则派生（attemptId = 父任务/分片/序号，
             *   executionGeneration = 序号），并标记 legacy=true，让诊断能区分
             *   "派生身份"与"创建身份"。
             */
            const hasAttemptId = typeof rawAttempt.attemptId === "string" && rawAttempt.attemptId.trim().length > 0;
            const hasGeneration = Number.isSafeInteger(rawAttempt.executionGeneration) && rawAttempt.executionGeneration >= 1;
            const hasStopEvidence = rawAttempt.stopEvidence !== undefined;
            const legacy = !hasAttemptId || !hasGeneration || !hasStopEvidence;
            return {
              attempt: attemptNumber,
              status: typeof rawAttempt.status === "string" ? rawAttempt.status : "queued",
              attemptId: hasAttemptId
                ? rawAttempt.attemptId.trim()
                : deriveAttemptId(rawTask.parentTaskId, rawShard.shardId, attemptNumber),
              executionGeneration: hasGeneration ? rawAttempt.executionGeneration : attemptNumber,
              stopEvidence: hasStopEvidence
                ? cloneJson(rawAttempt.stopEvidence)
                : { state: STOP_EVIDENCE_STATE_UNKNOWN },
              ...(typeof rawAttempt.stopRequestedAt === "number" ? { stopRequestedAt: rawAttempt.stopRequestedAt } : {}),
              ...(typeof rawAttempt.stopDeadlineAt === "number" ? { stopDeadlineAt: rawAttempt.stopDeadlineAt } : {}),
              ...(typeof rawAttempt.stopWatchdogExpiredAt === "number" ? { stopWatchdogExpiredAt: rawAttempt.stopWatchdogExpiredAt } : {}),
              ...(typeof rawAttempt.terminalReason === "string" ? { terminalReason: rawAttempt.terminalReason } : {}),
              ...(legacy || rawAttempt.legacy === true ? { legacy: true } : {}),
              startedAt: typeof rawAttempt.startedAt === "number" ? rawAttempt.startedAt : undefined,
              finishedAt: typeof rawAttempt.finishedAt === "number" ? rawAttempt.finishedAt : undefined,
              affectedPaths: Array.isArray(rawAttempt.affectedPaths) ? [...rawAttempt.affectedPaths] : [],
              ...(rawAttempt.cancelRequested === true ? { cancelRequested: true } : {}),
              // attempt 级超时是创建时已解析的**实效值**，恢复后原样使用（不重算）。
              // 对旧快照的非法字段保持旧行为：静默丢弃（不因它整体拒绝快照）。
              ...(typeof rawAttempt.timeoutMs === "number" && Number.isFinite(rawAttempt.timeoutMs) && rawAttempt.timeoutMs >= 0
                ? { timeoutMs: rawAttempt.timeoutMs }
                : {}),
              ...(typeof rawAttempt.childId === "string" ? { childId: rawAttempt.childId } : {}),
              ...(typeof rawAttempt.messageId === "string" ? { messageId: rawAttempt.messageId } : {}),
              ...(rawAttempt.result === undefined ? {} : { result: cloneJson(rawAttempt.result) }),
              ...(rawAttempt.error === undefined ? {} : { error: cloneJson(rawAttempt.error) }),
            };
          });
          // 恢复语义：running 的运行时句柄已经不存在，统一记为 interrupted。
          // 注意：这**不**代表执行已停止——unknown 边界下 stopEvidence 保持 unknown，
          // 影响范围继续占用，等 Host 证据或人工处置。
          for (const attempt of attempts) {
            if (attempt.status === "running") {
              attempt.status = "interrupted";
              attempt.terminalReason = attempt.terminalReason ?? "restore";
              attempt.finishedAt = attempt.finishedAt ?? now();
              attempt.error = attempt.error ?? toShardError(
                { name: "ShardInterruptedError", reason: "restore", message: "运行时恢复后丢失原 child，需手工重试" },
                "shard 因恢复而中断",
              );
            }
          }
          /**
           * 停止证据边界（票据 07）：
           * - process-restart：重启确实终止了执行体所属进程，快照内 attempt 一律 observed；
           * - unknown：保留快照里的证据（新快照可能是 observed，也可能真的是 unknown）。
           *   绝不为"让恢复好看一点"而伪造证据。
           */
          if (taskBoundary === "process-restart") {
            for (const attempt of attempts) {
              if (isStopObserved(attempt)) continue;
              attempt.stopEvidence = {
                state: STOP_EVIDENCE_STATE_OBSERVED,
                source: "process-restart",
                observedAt: now(),
              };
            }
          }
          /**
           * 恢复不重新挂停止看门狗：快照里没有执行句柄，恢复进程无法观察"这次停止是否
           * 在宽限内完成"（宽限属于上一条执行生命线）。未确认的停止交给 Host 证据或
           * 人工处置；stopDeadlineAt 仍随快照恢复，供诊断判断"早已超期"。
           */
          const last = attempts[attempts.length - 1];
          const latestTerminal = isTerminalShardStatus(last.status);
          // 分片覆盖的来源见 projectsShardTimeout：新快照只信 rawShard.timeoutMs，
          // 旧快照才用最新 attempt 的实效值反推（当年两者恒等）。
          const restoredShardTimeoutMs = typeof rawShard.timeoutMs === "number"
            ? rawShard.timeoutMs
            : (projectsShardTimeout ? undefined : last.timeoutMs);
          const shard = {
            shardId: rawShard.shardId,
            // 使用恢复阶段已校验并归一化的名称；旧快照没有该字段时保持"无名称"，
            // 由投影侧回退 shardId。
            ...(typeof rawShard.name === "string" ? { name: rawShard.name.trim() } : {}),
            prompt: typeof rawShard.prompt === "string" ? rawShard.prompt : "",
            status: latestTerminal ? last.status : "queued",
            affectedPaths: last.affectedPaths.length > 0 ? [...last.affectedPaths] : (Array.isArray(rawShard.affectedPaths) ? [...rawShard.affectedPaths] : []),
            ...(rawShard.cancelRequested === true || (parentCancelRequested && rawShard.status === "queued") ? { cancelRequested: true } : {}),
            ...(restoredShardTimeoutMs === undefined ? {} : { timeoutMs: restoredShardTimeoutMs }),
            createdAt: typeof rawShard.createdAt === "number" ? rawShard.createdAt : now(),
            updatedAt: typeof rawShard.updatedAt === "number" ? rawShard.updatedAt : now(),
            attempts,
          };
          // resume 的派发候选只来自"非终态且仍在 queued"的 shard：latestTerminal 的
          // shard 已经结算，重新派发等于重复执行，必须排除。
          if (resume && shard.status === "queued" && !latestTerminal) rolesToSchedule.add(taskRole);
          return shard;
        }),
      };
      // resume 语义：被中断的 running shard 只有换一个新 attempt 才可能继续执行——
      // 原来的 attempt 已经写成 interrupted 终态，调度器只派发 queued attempt。
      // 这里复用 retryShard 的语义（追加 attempt、保留历史、清取消标记），但只在
      // resume 时执行，且不触发 per-shard 事件重放（恢复期不发布实时事件）。
      const blockedResume = [];
      if (resume) {
        for (const shard of task.shards) {
          const last = shard.attempts[shard.attempts.length - 1];
          if (last === undefined || last.status !== "interrupted") continue;
          if (shard.cancelRequested === true) continue;
          /**
           * 恢复续跑的停止 gate（票据 07）：unknown 边界下无法证明原执行体已停止，
           * 绝不自动追加新 attempt——否则旧 child（若仍在另一个进程/会话里）与新 attempt
           * 会并发写同一路径。这里只记录原因，由 Host 用 process-restart 边界或补交证据。
           */
          if (!isStopObserved(last)) {
            const unconfirmed = unconfirmedStopAttempts(shard).map((attempt) => unconfirmedStopSummary(attempt));
            shard.resumeBlocked = { reason: "stop_unconfirmed", attempts: unconfirmed };
            blockedResume.push({ shardId: shard.shardId, reason: "stop_unconfirmed", unconfirmed });
            continue;
          }
          /**
           * 恢复续跑必须先过 attempt 预算（票据 08），判定与 retry/continue 同源。
           *
           * 语义：新建后的 attempt 数超过 maxAttemptsPerShard 就不追加、不派发；
           * 保持最后一个 attempt 的 interrupted 终态与 shard 的终态视图，不自动重试。
           * 绝不能为"让恢复成功"而放宽——写入第 limit+1 个 attempt 后，下次 restore
           * 会被 checkRestoreBudget 整体拒绝，整份快照将永久不可恢复。
           * 原因码放在 shard.resumeBlocked（随 shard 快照持久化），同时发一条结构化
           * 诊断事件，供 Host/UI 提示"需手工提交新父任务"。
           */
          const budget = attemptBudgetVerdict(
            shard,
            "shard " + shard.shardId,
            "该 shard 已耗尽恢复续跑预算，请提交新的父任务或拆分工作",
          );
          if (budget !== null) {
            shard.resumeBlocked = {
              reason: budget.reason,
              attempts: budget.attempts,
              limit: budget.limit,
            };
            // 事件延后到任务登记 + 聚合之后再发（见下方 emit 循环）：订阅者收到
            // shard_resume_blocked 时 getTask() 必须已经能读到一致的终态。
            blockedResume.push({
              shardId: shard.shardId,
              attempts: budget.attempts,
              limit: budget.limit,
              reason: budget.reason,
            });
            continue;
          }
          // 恢复续跑的新 attempt 同样按三级优先级解析超时：快照里的分片/任务级显式值
          // 优先，否则取**当前** settings 的角色默认值（恢复不冻结角色级配置）。
          const attempt = createAttempt(task, shard, last.attempt + 1);
          shard.attempts.push(attempt);
          delete attempt.cancelRequested;
          shard.cancelRequested = false;
          setShardStatus(task, shard, "queued");
          shard.updatedAt = now();
          task.updatedAt = shard.updatedAt;
          rolesToSchedule.add(taskRole);
        }
      }
      tasks.set(task.parentTaskId, task);
      // 快照里重新出现的同 id 任务覆盖旧的回收标记（迟到回调必须归新任务判定）。
      forgetReclaimedTask(task.parentTaskId);
      if (task.requestId !== undefined) requestIndex.set(task.requestId, task.parentTaskId);
      aggregateTask(task);
      // 恢复续跑被预算拦下的诊断事件：只带元数据（不含 prompt/结果），
      // 且必须在任务登记与聚合之后发布——订阅者读 getTask() 时状态已一致。
      for (const blocked of blockedResume) {
        emit({
          type: "shard_resume_blocked",
          parentTaskId: task.parentTaskId,
          shardId: blocked.shardId,
          role: task.role,
          // 预算拒绝带 attempts(数)+limit；停止 gate 带未确认 attempt 摘要（unconfirmed）。
          ...(blocked.limit === undefined ? {} : { attempts: blocked.attempts, limit: blocked.limit }),
          ...(blocked.unconfirmed === undefined ? {} : { unconfirmed: blocked.unconfirmed }),
          reason: blocked.reason,
        });
      }
    }
    rebuildIndexes();
    restoringSnapshot = false;
    notifyPersistence();
    // schedule() 会清除 restoreDispatchSuppressed 并排入一次 drain，因此 resume 的
    // 重派发仍由唯一调度状态机（dispatchAvailable + role concurrency + affectedPaths
    // 冲突判定）决定，restore 不复制任何调度规则。
    if (resume && rolesToSchedule.size > 0) schedule();
    return { restored: true, tasks: tasks.size };
  }

  /**
   * 关闭 manager：先封锁调度入口，再让所有未终态 attempt 以 manager_closed 收敛。
   * running attempt 先调用取消器，随后立即写入 cancelled，避免 whenIdle/关闭流程等待
   * 永不完成的 child；迟到的 admission 或 completion 仍只能走拒绝诊断路径。
   *
   * 关闭**不**删除已结算任务：回收（commitReclaim）是唯一会移除已结算任务的入口，
   * close 只收敛未终态 attempt，任务表与事件历史保持可读（关闭后的诊断/快照仍完整）。
   */
  function close() {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "already_closed" };
    closed = true;
    restoreDispatchSuppressed = true;
    workRequested = false;
    /**
     * 关闭竞态（票据 05 修复）：**不得**在这里清空回收屏障，也不得删除待回收任务。
     *
     * Host 的回收顺序是「prepare（生成排除待回收任务的候选）→ await 落盘成功 → commit」；
     * close 完全可能落在那次 await 里。候选快照已经把任务从磁盘排除，只有让同一 token 的
     * commit/abort 在关闭后继续生效，内存状态才能与磁盘一致；清空屏障会让 commit 得到
     * token 失效，磁盘/内存永久分叉（重启后任务“消失”，或被重新恢复出来）。
     *
     * 关闭后不会因此开启新的回收：prepareReclaim 仍先判 closed 并返回 MANAGER_CLOSED；
     * commit/abort 自身已跳过关闭后的 emit/notifyPersistence/schedule。
     */
    // （保持 reclaimState 原样，见上。）
    let changed = false;
    for (const task of tasks.values()) {
      const activeShards = task.shards.filter((shard) => {
        const attempt = activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
        return attempt !== undefined && !isTerminalShardStatus(attempt.status);
      });
      if (activeShards.length === 0) continue;
      changed = true;
      task.parentCancelRequested = true;
      for (const shard of activeShards) {
        const attempt = activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
        if (attempt === undefined || isTerminalShardStatus(attempt.status)) continue;
        const cancellationAlreadyRequested = attempt.cancelRequested === true;
        attempt.cancelRequested = true;
        shard.cancelRequested = true;
        if (attempt.status === "running" && !cancellationAlreadyRequested) {
          requestShardCancellation(task, shard, attempt, "manager_closed");
        }
        /**
         * close 的停止语义（票据 07）：逻辑终态写 cancelled，但**不**假定执行已停止
         * （watchStop=false：不再挂看门狗，因为 manager 已关闭、不会再有调度与聚合）。
         * stopEvidence 保持 unknown，影响范围随任务一起消失（进程即将结束）。
         */
        settleShard(task, shard, attempt, "cancelled", {
          error: toShardError(
            { name: "FanoutClosedError", reason: "manager_closed", message: "fan-out manager 已关闭" },
            "fan-out manager 已关闭",
          ),
          reason: "manager_closed",
          watchStop: false,
        });
      }
      aggregateTask(task);
      notifyPersistence();
    }
    /**
     * 关闭时清除全部内存定时器（超时 + 停止看门狗），但保留 unknown 状态。
     * 不清理会让进程退出前仍有悬挂句柄（测试用假时钟能直接观察到）。
     */
    for (const task of tasks.values()) {
      for (const shard of task.shards) {
        for (const attempt of shard.attempts) {
          if (attempt.timer !== undefined) {
            clearTimeoutFn(attempt.timer);
            attempt.timer = undefined;
          }
          clearAttemptStopTimer(attempt);
        }
      }
    }
    // 关闭后不再保留实时订阅者；历史诊断仍保留在 eventHistory/快照中。
    subscribers.clear();
    // 不取消既有 drainPromise：已排队的 drain 会看到 closed 并自行结束，调用方可以安全 await。
    return { accepted: true, changed, code: "MANAGER_CLOSED", reason: "manager_closed" };
  }

  // 公开写入口一律包成"一次调用 = 一个持久化批"：调用内的多次状态变化（批量登记、
  // 批量取消、close 收敛多个任务、restore 重建多个任务）只序列化/落盘一次。
  // 注意只包装写入口；读接口（getTask/listTasks/getCounts/whenIdle/snapshot/budget）
  // 不改变状态，保持原样。persistSnapshot 本身就是落盘动作，也不包装。
  return Object.freeze({
    submit: (input) => withPersistenceBatch(() => submit(input)),
    cancelShard: (parentTaskId, shardId) => withPersistenceBatch(() => cancelShard(parentTaskId, shardId)),
    cancelParent: (parentTaskId) => withPersistenceBatch(() => cancelParent(parentTaskId)),
    retryShard: (parentTaskId, shardId) => withPersistenceBatch(() => retryShard(parentTaskId, shardId)),
    continueTask: (input) => withPersistenceBatch(() => continueTask(input)),
    /**
     * 显式回收第一阶段（票据 05）：筛选 + 立屏障 + 生成候选快照。
     *
     * Host 的职责是先把 candidate **真实落盘成功**再调用 commitReclaim；失败必须
     * abortReclaim。manager 不自行落盘（它只有 persistence.save 旁路，无法等待真实结果），
     * 因此"先落盘成功再移除"的判定点必须在 Host。
     */
    prepareReclaim: (parentTaskIds) => prepareReclaim(parentTaskIds),
    /** 显式回收第二阶段：确认落盘后从内存与索引移除（只接受先 prepare 拿到的 token）。 */
    commitReclaim: (token) => withPersistenceBatch(() => commitReclaim(token)),
    /** 放弃一次回收（只清屏障，状态不变）。 */
    abortReclaim: (token) => abortReclaim(token),
    /** 只读：当前满足回收前置条件的任务数（容量拒绝的 reclaimable 与诊断共用）。 */
    reclaimableCount: () => countReclaimableTasks(),
    /** 只读：某 attempt 当前绑定的 messageId（严格 turn 归属校验用，不克隆任务快照）。 */
    attemptMessageIdOf,
    /** 只读：某 attempt 的严格身份（Host 归属老化必须用 manager 权威投影）。 */
    attemptIdentityOf,
    /** Host 观察到的「turn 归属无法证明」结构化诊断（只写事件，不改变任务状态）。 */
    recordAttributionViolation: (input) => withPersistenceBatch(() => recordAttributionViolation(input)),
    /**
     * 提交严格归属的停止证据（票据 07，Host 接线在后续任务）。
     * 只允许 unknown -> observed；不改写逻辑状态、不重复计数；可能补发一次 task_settled。
     */
    observeStopEvidence: (identity, evidence) => withPersistenceBatch(() => observeStopEvidence(identity, evidence)),
    /**
     * 归属老化到期（票据 07，Host 接线）。只把仍非终态的 attempt 收敛为 interrupted 并
     * 标记 needs_attention；绝不写停止证据、不释放范围、不自动重试。
     */
    markAttributionAged: (identity, options) => withPersistenceBatch(() => markAttributionAged(identity, options)),
    /** 停止证据只读诊断：未确认停止的 attempt 数、按任务/分片摘要、legacy 标记与最近看门狗/老化。 */
    stopDiagnostics,
    getTask,
    listTasks,
    getCounts,
    /** 逐动作能力只读投影（票据 09）；不改变任何调度状态。 */
    taskCapabilities,
    subscribe,
    whenIdle,
    isIdle,
    close: () => withPersistenceBatch(() => close()),
    snapshot: () => serializeSnapshot(),
    restore: (snapshot, restoreOptions) => withPersistenceBatch(() => restore(snapshot, restoreOptions)),
    persistSnapshot,
    /**
     * Host 在 manager 状态尚未恢复（restore 抛错）时补发统一预算事件。
     *
     * 为什么需要公开入口：manager.restore 的既有契约是"超预算/非法快照原子失败且
     * 不写 eventHistory"，所以 restore 内部只记录 lastViolation，不自行 emit。
     * Host 捕获结构化错误后调用本方法，把同一条 violation 补发成 budget_rejected。
     * 事件只含元数据；重复调用是幂等的（每次仍是一条可审计事件）。
     *
     * @param {object} violation - describeBudgetViolation 产出的结构化描述。
     * @param {string} phase - 发生阶段（Host 恢复路径传 restore）。
     * @param {{parentTaskId?:string}} [options] - 可选归属（RPC 按根过滤事件时需要）。
     * @returns {{recorded:boolean, phase?:string, reason?:string}}
     */
    recordBudgetViolation: (violation, phase, options = {}) => withPersistenceBatch(() => {
      if (closed) return { recorded: false, reason: "manager_closed" };
      if (violation === null || typeof violation !== "object" || Array.isArray(violation)) {
        return { recorded: false, reason: "invalid_violation" };
      }
      const normalizedPhase = typeof phase === "string" && phase.length > 0 ? phase : "restore";
      noteBudgetViolation(violation, normalizedPhase, {
        ...(typeof options?.parentTaskId === "string" && options.parentTaskId.length > 0
          ? { parentTaskId: options.parentTaskId }
          : {}),
      });
      // 事件写入历史后触发一次落盘（Host 若已 fail-closed，会跳过并记录 restore_failed）。
      notifyPersistence();
      return { recorded: true, phase: normalizedPhase };
    }),
    /**
     * 最近一次落盘结果的只读投影：saved / skipped(reason) / failed(category)。
     * 失败分类的权威仍是 Host 的 persistence-health；本视图只回答"manager 观察到了什么"。
     */
    persistenceStatus: () => Object.freeze({
      lastResult: lastPersistResult === null ? null : cloneJson(lastPersistResult),
    }),
    /** 事件历史只读状态：条数/字节/累计丢弃/最早可用序号（gap 判定用）。 */
    eventHistoryStatus,
    /** 只读并发视图：有效默认值 + 各 role/provider 覆盖 + 解析来源（不泄露任务负载）。 */
    concurrencyLimits,
    /**
     * 只读限流/排队诊断（票据 26）：按 role 与 provider 给出 limit/running/queued/
     * lastThrottledAt 与 etaMs。只读、无副作用，可在 RPC meta 中直接投影。
     */
    throttleDiagnostics,
    /**
     * 只读预算视图：当前用量、冻结上限与最近一次违规。
     * 不暴露任何调度内部状态，宿主/客户端据此判断是否接近预算。
     */
    budget: () => Object.freeze({
      limits: Object.freeze({ ...budgetPolicy }),
      tasks: tasks.size,
      events: eventHistory.length,
      // 增量记账维护的总字节（不再为读诊断重算整段历史）。
      eventBytes: eventAccounting.bytes,
      eventHistory: eventHistoryStatus(),
      lastViolation: lastBudgetViolation === null ? null : cloneJson(lastBudgetViolation),
      lastViolationPhase: lastBudgetViolationPhase,
    }),
  });
}
