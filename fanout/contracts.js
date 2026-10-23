// ─────────────────────────────────────────────────────────────────────────────
// R1-07（模块拆分）：本文件从 fanout.js 前段外移而来，承接原始源行 1–333
// （R1-05 改成叶子 import 后为 1–335）。内容是领域总览注释、并发/超时/回收上限
// 常量、超时与恢复字段校验；只含常量与无状态纯函数，不持有模块级可变状态。
// 依赖方向：contracts -> errors（只取停止证据状态常量），errors 不反向依赖。
// ─────────────────────────────────────────────────────────────────────────────
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

import { FANOUT_BUDGET } from "../resource-budget.js";
// 恢复路径的停止证据字段校验需要「state 只能是 unknown/observed」这两个常量；
// 它们与 source 词表一起属于 errors.js 的停止证据契约，故从该模块取。
import {
  STOP_EVIDENCE_STATE_OBSERVED,
  STOP_EVIDENCE_STATE_UNKNOWN,
} from "./errors.js";


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
export function validateRestoredStopFields(rawAttempt, field) {
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

export function validateRestoredTimeoutMs(value, field) {
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

