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
 *    角色级/default 两层描述"该角色的共享并发池"，可以注入解析函数并按当前设置动态
 *    取值（设置页保存后立即约束后续派发）；任务级显式限制会随任务快照固化，恢复后不变。
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
 *
 * @module dsh-expert-group/fanout
 */
import {
  BUDGET_EXCEEDED_CODE,
  FANOUT_BUDGET,
  checkAttemptPayloadBudget,
  checkBudget,
  checkEventBudget,
  checkEventHistoryBudget,
  checkRestoreBudget,
  checkTaskInputBudget,
  describeBudgetViolation,
  measureJsonBytes,
  measureUtf8Bytes,
} from "./resource-budget.js";
import { describeSubagentCapacityFailure } from "./shared.js";

/** per-role 并发上限的默认值。 */
export const DEFAULT_CONCURRENCY_LIMIT = 10;
/** per-role 并发上限的下界。 */
export const MIN_CONCURRENCY_LIMIT = 1;
/** per-role 并发上限的上界。 */
export const MAX_CONCURRENCY_LIMIT = 64;

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

/** 快照格式版本；restore 只接受同版本快照。 */
const SNAPSHOT_VERSION = 1;

/** 判断 shard 是否已进入终态（含恢复态 interrupted）。 */
export function isTerminalShardStatus(status) {
  return SHARD_TERMINAL_STATUSES.includes(status);
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

/** 把任意启动结果规范化为结构化错误。 */
function normalizeLaunchError(error) {
  // 容量耗尽：用户看到可读提示（等待子代理完成 / 继续使用现有子代理），
  // 而不是宿主原始错误码。code 用自有稳定值，保持 structured error 契约。
  const capacity = describeSubagentCapacityFailure(error);
  if (capacity !== undefined) {
    return { name: "SubagentCapacityError", code: capacity.code, message: capacity.message };
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
 * @returns {{ok:true, role:string, basePrompt:string, shards:object[], requestId?:string, concurrencyLimit?:number, allowOverlap:boolean} | {ok:false, code:string, message:string, field?:string, conflict?:object}}
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
    let timeoutMs;
    if (rawShard.timeoutMs !== undefined && rawShard.timeoutMs !== null) {
      if (typeof rawShard.timeoutMs !== "number" || !Number.isFinite(rawShard.timeoutMs) || rawShard.timeoutMs <= 0) {
        return { ok: false, code: "INVALID_TIMEOUT", message: field + ".timeoutMs 必须是正有限数", field: field + ".timeoutMs" };
      }
      timeoutMs = rawShard.timeoutMs;
    }
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
  });
}

/**
 * 把预算违规翻译成 submit 校验失败结果。
 * 输入超限不能截断后继续执行，因此这里走"整体拒绝"通道（不登记任务、不建 child）。
 */
function budgetVerdict(resource, limit, receivedBytes, field, hint) {
  const check = checkBudget({ resource, limit, receivedBytes, subject: field, recoverable: true, hint });
  if (check.ok) return null;
  return { ok: false, code: "INVALID_BUDGET", message: check.violation.message, field, violation: check.violation };
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
    concurrencyLimit: rawConcurrencyLimit,
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

  // 默认并发上限既可以是静态整数，也可以是"每次新建父任务读取一次"的解析函数。
  // 函数形式接入插件 settings 的 roleConcurrencyLimit：静态非法值必须在构造期显式
  // 失败（配置写错不能静默降级），函数返回值则按归一化规则回退默认值——settings 里
  // 的旧配置/非法值不能污染调度器。
  // 未被 settings 解析函数提供时先取静态默认值；之后 restore 若带来快照里的
  // defaultConcurrencyLimit，则改由快照值驱动（见 roleLimitFor 的 resolverSource）。
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
   * 默认并发上限的来源：live（读取注入的解析函数，接入 settings）或 snapshot
   * （本快照自带 defaultConcurrencyLimit）。互斥，避免两套默认值互相覆盖。
   *
   * 只有"快照确实带了 defaultConcurrencyLimit"时 restore 才切到 snapshot——旧快照与
   * 不落盘全局配置的场景必须继续跟随注入的当前设置，否则恢复出来的 queued shard 会
   * 使用请求时的临时 roleLimits 残值。任务级（快照固化）上限始终优先于本条。
   */
  let resolverSource = typeof rawConcurrencyLimit === "function" ? "live" : "snapshot";
  let roleLimits = normalizeRoleLimits(rawRoleLimits);
  /** 解析函数返回非法值时的最近一次诊断（只读，不参与调度决策）。 */
  let invalidLimitDiagnostic = null;
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
  /** 最近一次预算违规（只读诊断；不参与调度决策）。 */
  let lastBudgetViolation = null;
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
   * 活动 shard 索引：key 使用 shard 对象身份，避免 parentTaskId/shardId 中的任意字符
   * 发生拼接碰撞；path index 只服务内置 affectedPaths checker。
   */
  const activeShardEntries = new Map();
  const activeShardsByPath = new Map();
  let nextActiveOrder = 0;
  /** 事件订阅者。 */
  const subscribers = new Set();
  /** 每个 role 的派发轮转游标，用于父任务间公平轮转。 */
  const rotationCursors = new Map();

  let sequence = 0;
  let nextTaskNumber = 0;
  // 事件与任务快照一起持久化，重启后仍可按 sequence 续读；仅保留 bounded 历史。
  // 条数上限（1000，既有契约）与字节上限都来自 budgetPolicy，见 trimEventHistory()。
  const eventHistory = [];
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
   * 事件进历史前先记录违规，调用方可通过 budget() 观察。
   */
  function emit(event) {
    const candidate = { ...event, sequence: ++sequence, at: now() };
    const verdict = checkEventBudget(candidate, { subject: candidate.type });
    if (!verdict.ok) {
      noteBudgetViolation(verdict.violation);
      const diagnostic = {
        type: "event_budget_exceeded",
        subject: typeof candidate.type === "string" ? candidate.type : "event",
        parentTaskId: candidate.parentTaskId,
        violation: verdict.violation,
        sequence,
        at: now(),
      };
      eventHistory.push(cloneJson(diagnostic));
      trimEventHistory();
      for (const listener of [...subscribers]) {
        try {
          listener(cloneJson(diagnostic));
        } catch {
          // 订阅者异常必须被隔离。
        }
      }
      return diagnostic;
    }
    eventHistory.push(cloneJson(candidate));
    trimEventHistory();
    for (const listener of [...subscribers]) {
      try {
        listener(cloneJson(candidate));
      } catch {
        // 订阅者异常必须被隔离：fan-out 的调度语义不依赖任何监听器。
      }
    }
    return candidate;
  }

  /** 记录预算违规（只读诊断，不改变调度状态）。 */
  function noteBudgetViolation(violation) {
    if (violation === null || violation === undefined) return;
    lastBudgetViolation = cloneJson(violation);
  }

  /**
   * 事件历史的条数/字节双预算：条数保留既有 1000 条契约，字节超出时继续丢弃最旧
   * 记录。两条预算同时生效，结果取更小的保留集合。
   */
  function trimEventHistory() {
    const verdict = checkEventHistoryBudget(eventHistory, {
      maxCount: budgetPolicy.maxEventHistory,
      maxBytes: budgetPolicy.maxEventHistoryBytes,
    });
    if (verdict.droppedCount === 0) return;
    eventHistory.splice(0, verdict.droppedCount);
    noteBudgetViolation(verdict.violation);
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
   * 所有拒绝路径只更新内存健康状态并返回 {saved:false, ...}，绝不抛异常、绝不改动内存
   * 状态机，因此 notifyPersistence 不会被降级路径变成持久化反馈循环。
   *
   * @param {object} [snapshot] - 待落盘快照；缺省时序列化当前状态。
   * @returns {{saved:boolean, bytes:number|null, reason?:string, violation?:object}}
   */
  function persistSnapshot(snapshot) {
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
      noteBudgetViolation(violation);
      return { saved: false, bytes: null, reason: "degraded_snapshot", violation };
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
      noteBudgetViolation(violation);
      return { saved: false, bytes: null, reason: "unmeasurable_snapshot", violation };
    }
    // 3. 字节预算（复用上面已量出的字节数，不再重新序列化）。
    const verdict = snapshotSizeVerdict(measured);
    if (!verdict.ok) {
      noteBudgetViolation(verdict.violation);
      return { saved: false, bytes: verdict.violation.receivedBytes, violation: verdict.violation };
    }
    // 4. 没有持久化目标。
    if (persistence === undefined || persistence === null) {
      return { saved: false, bytes: measured, reason: "no_persistence" };
    }
    try {
      const result = persistence.save(payload);
      if (result !== null && typeof result === "object" && typeof result.catch === "function") {
        result.catch(() => {});
      }
      return { saved: true, bytes: null };
    } catch (error) {
      // 持久化是旁路：落盘失败不改变内存状态机，由 Host 自行告警。
      return { saved: false, bytes: null, reason: "save_failed", error };
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
    return counts;
  }

  function activeShard(shard) {
    return shard.attempts.find((attempt) => attempt.status === "running");
  }

  /** 记录一次动态上限的非法返回（只读诊断：调度仍然按默认值安全降级）。 */
  function noteInvalidDynamicLimit(kind, value) {
    invalidLimitDiagnostic = {
      kind,
      valueType: value === null ? "null" : typeof value,
      message: kind === "concurrencyLimit"
        ? "settings 解析出的并发上限不是 1~" + MAX_CONCURRENCY_LIMIT + " 的整数，已回退默认值 " + DEFAULT_CONCURRENCY_LIMIT
        : "settings 解析出的 roleLimits 不是 role -> limit 映射，已忽略全部角色级覆盖",
    };
  }

  function resolveDefaultConcurrencyLimit() {
    if (resolverSource !== "live" || typeof rawConcurrencyLimit !== "function") return defaultConcurrencyLimit;
    let raw;
    try {
      raw = rawConcurrencyLimit();
    } catch {
      // 解析函数读的是外部设置状态：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("concurrencyLimit", undefined);
      return DEFAULT_CONCURRENCY_LIMIT;
    }
    const check = validateConcurrencyLimit(raw);
    if (check.ok) return check.value;
    noteInvalidDynamicLimit("concurrencyLimit", raw);
    return DEFAULT_CONCURRENCY_LIMIT;
  }

  /**
   * 解析 role 级覆盖。
   *
   * 静态映射在构造/restore 时已完成校验（非法配置直接抛错）。函数形式读取的是
   * "当前设置"，因此：
   * - 每次调用都读一次最新值——设置可能在两次提交之间变化，缓存会把新设置吞掉；
   * - 调度热路径对每个父任务每轮只解析一次，任务级显式限制则完全不走这里；
   * - 返回结构非法时整体忽略角色级覆盖，单个角色的非法值只回退该 role。
   */
  function resolveRoleLimits() {
    if (typeof roleLimits !== "function") return roleLimits;
    let raw;
    try {
      raw = roleLimits();
    } catch {
      noteInvalidDynamicLimit("roleLimits", undefined);
      return Object.freeze({});
    }
    if (raw === undefined || raw === null) return Object.freeze({});
    if (typeof raw !== "object" || Array.isArray(raw)) {
      noteInvalidDynamicLimit("roleLimits", raw);
      return Object.freeze({});
    }
    const normalized = {};
    for (const [role, limit] of Object.entries(raw)) {
      const check = validateConcurrencyLimit(limit);
      if (check.ok) normalized[role] = limit;
    }
    return Object.freeze(normalized);
  }

  /**
   * 快照里对外暴露的单个任务"有效并发上限"，仅供展示与契约稳定使用。
   *
   * 三级优先级：任务级显式 concurrencyLimit（submit 入参，或快照恢复出来的任务级值）
   * > 角色级设置（roleLimits，即该角色的共享并发池，按当前设置解析，可增可减）
   * > 动态/静态默认值。恢复任务在 restore 时会带上快照里的任务级限制，因此重启不会改变
   * 显式限制的语义。
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

  /** 只读并发视图：当前有效默认值与各 role 覆盖（诊断用，不暴露任务负载）。 */
  function concurrencyLimits() {
    return Object.freeze({
      default: resolveDefaultConcurrencyLimit(),
      roles: Object.freeze({ ...resolveRoleLimits() }),
      source: resolverSource,
      ...(invalidLimitDiagnostic === null ? {} : { invalid: Object.freeze({ ...invalidLimitDiagnostic }) }),
    });
  }

  /**
   * 同步一个 shard 的 running 归属：role 共享池计数与父任务自身计数一起增减。
   *
   * 两个计数必须同源同点更新（唯一调用点是 setShardStatus）：只要有一处漏改，派发判定
   * 就会读到漂移值，出现超发或永久饿死。计数归零时删除条目，避免空条目长期驻留。
   */
  function addRunningCount(task, delta) {
    const role = task.role;
    const nextRoleCount = (runningCountsByRole.get(role) ?? 0) + delta;
    if (nextRoleCount <= 0) runningCountsByRole.delete(role);
    else runningCountsByRole.set(role, nextRoleCount);
    const nextTaskCount = (runningCountsByTask.get(task) ?? 0) + delta;
    if (nextTaskCount <= 0) runningCountsByTask.delete(task);
    else runningCountsByTask.set(task, nextTaskCount);
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

  function removeActiveShardIndex(shard) {
    const previous = activeShardEntries.get(shard);
    if (previous === undefined) return;
    for (const path of previous.affectedPaths) {
      const shards = activeShardsByPath.get(path);
      if (shards === undefined) continue;
      shards.delete(shard);
      if (shards.size === 0) activeShardsByPath.delete(path);
    }
    activeShardEntries.delete(shard);
  }

  /**
   * 同步单个 shard 的活动视图、path index 与 role running 计数。
   * 所有状态转移都经由 setShardStatus 进入，避免取消/超时/迟到完成漏掉索引更新。
   */
  function syncActiveShardIndex(task, shard) {
    const previous = activeShardEntries.get(shard);
    if (previous !== undefined) {
      for (const path of previous.affectedPaths) {
        const shards = activeShardsByPath.get(path);
        if (shards === undefined) continue;
        shards.delete(shard);
        if (shards.size === 0) activeShardsByPath.delete(path);
      }
    }
    if (isTerminalShardStatus(shard.status)) {
      activeShardEntries.delete(shard);
      return;
    }
    const attempt = shard.attempts[shard.attempts.length - 1];
    const affectedPaths = Array.isArray(attempt?.affectedPaths) ? [...attempt.affectedPaths] : [];
    const entry = {
      parentTaskId: task.parentTaskId,
      role: task.role,
      shardId: shard.shardId,
      attempt: attempt?.attempt ?? 1,
      status: shard.status ?? "queued",
      affectedPaths,
      order: previous?.order ?? nextActiveOrder++,
    };
    activeShardEntries.set(shard, entry);
    for (const path of affectedPaths) {
      let shards = activeShardsByPath.get(path);
      if (shards === undefined) {
        shards = new Set();
        activeShardsByPath.set(path, shards);
      }
      shards.add(shard);
    }
  }

  function setShardStatus(task, shard, status) {
    const previous = shard.status;
    if (previous !== status) {
      if (previous === "running") addRunningCount(task, -1);
      if (status === "running") addRunningCount(task, 1);
    }
    shard.status = status;
    syncActiveShardIndex(task, shard);
  }

  function indexTask(task, roleIndex) {
    addTaskToRoleIndex(task, roleIndex);
    for (const shard of task.shards) {
      if (shard.status === "running") addRunningCount(task, 1);
      syncActiveShardIndex(task, shard);
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
      removeActiveShardIndex(shard);
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
      status: entry.status,
      ...(entry.affectedPaths.length === 0 ? {} : { affectedPaths: [...entry.affectedPaths] }),
    };
  }

  /** 取当前所有活动（queued/running）shard 的公共视图，用于冲突判定。 */
  function collectActiveShards(excludeShard) {
    const active = [];
    for (const [shard, entry] of activeShardEntries) {
      if (shard === excludeShard) continue;
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
        if (candidate !== excludeShard) candidates.add(candidate);
      }
    }
    return [...candidates]
      .map((candidate) => activeShardEntries.get(candidate))
      .filter((entry) => entry !== undefined)
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
   */
  function buildSnapshotPayload() {
    return {
      version: SNAPSHOT_VERSION,
      sequence,
      nextTaskNumber,
      defaultConcurrencyLimit,
      roleLimits,
      writeRoles,
      defaultAllowOverlap,
      parentRotation: Object.fromEntries(rotationCursors),
      events: eventHistory.map((event) => cloneJson(event)),
      tasks: [...tasks.values()].map((task) => ({
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
          })),
        })),
      })),
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
   * @returns {{payload:object, bytes:number|null, degraded:boolean}}
   */
  function serializeSnapshotEnvelope() {
    try {
      const text = JSON.stringify(buildSnapshotPayload());
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
      noteBudgetViolation(violation);
      warn("dsh-expert-group: fan-out snapshot is not JSON-serializable, degraded to minimal snapshot");
      return {
        payload: {
          version: SNAPSHOT_VERSION,
          sequence,
          nextTaskNumber,
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

  /**
   * 派发一轮：每个 role 在「父任务轮转顺序」上取下一个可派发 shard。
   * 轮转游标按 role 维护，保证后来的父任务不会因为前面有大量排队 shard 而饿死。
   *
   * 并发判定是两层独立约束（见模块头设计要点 2）：role 共享池上限约束整个 role，
   * 任务级上限只约束当前候选父任务自身，两者必须同时满足才允许派发。
   */
  function dispatchAvailable() {
    if (closed || restoreDispatchSuppressed) return false;
    const roleActiveCounts = activeCountsByRole();
    const taskActiveCounts = activeCountsByTask();
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
      // role 共享池上限只看 role 级设置/默认值，不读任何任务的 concurrencyLimit，因此
      // 同一 role 下所有父任务解析出的池上限必然相同：在循环外算一次，避免热路径重复求值。
      // 池子已满时不能再进入内层循环——否则第一个候选会把 blockedInARow 记成"无法产出"，
      // 看起来像所有父任务都被自身上限卡住，从而提前跳出本 role（语义等价但仍然多做一次
      // 无效遍历）。直接 break 保持与旧实现完全一致的可观测行为。
      if (used >= rolePoolLimitFor(parents[0])) continue;
      // 轮转预算：一圈内每个父任务最多贡献一个 shard，保证公平性；
      // 若一圈后仍有空槽位（例如某个父任务已无排队 shard），允许再走一圈补齐，
      // 这样并发上限才真正被填满，而不是每轮只启动一个。
      let budget = parents.length;
      // 连续遇到「本轮无法产出」的父任务计数。只有轮转一整圈都没有任何产出才停止：
      // 某个父任务被**自身任务级上限**卡住时仍有其它父任务可以派发，因此它只能算
      // "本轮无产出"，不能直接终止整个 role 的派发（否则高上限的任务会被低上限的
      // 邻居饿死）。无排队 shard / 冲突判定失败同样属于"本轮无产出"。
      let blockedInARow = 0;
      while (budget > 0) {
        const task = parents[cursor % parents.length];
        cursor = (cursor + 1) % parents.length;
        budget -= 1;
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
          blockedInARow = 0;
          if (closed) break;
          // role 共享池在派发过程中可能刚好被填满（例如另一路径同步派发），逐次复核；
          // 一旦填满就停止本 role 的派发，保证 role 全局 running 不越过池上限。
          if (used >= rolePoolLimitFor(task)) break;
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
   * 新建一个 attempt。
   *
   * @param {object} shard - 所属 shard（继承 affectedPaths/timeoutMs）。
   * @param {number} attemptNumber - attempt 序号（同一 shard 内单调递增，历史不可覆盖）。
   * @param {object} [extra] - 追加字段。多轮 continuation 用 `{ continuation: true, childId }`
   *   标记「复用既有 child」——该标记只存在于内存 attempt 上，**不进快照**：冷恢复后原
   *   child 可能已不存在，恢复派发一律走 launcher 新建 child（与既有 restore 语义一致）。
   */
  function createAttempt(shard, attemptNumber, extra = {}) {
    return {
      attempt: attemptNumber,
      status: "queued",
      startedAt: undefined,
      finishedAt: undefined,
      affectedPaths: [...shard.affectedPaths],
      ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
      ...extra,
    };
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

  /**
   * shard 终态写入入口。所有路径（启动失败、child 完成、取消、超时、恢复）都收敛到
   * 这里，保证终态一次性且幂等：已进入终态的 shard 只拒绝并记录诊断，不被改写。
   */
  function settleShard(task, shard, attempt, status, { result, error, violation: presetViolation } = {}) {
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
      noteBudgetViolation(payloadViolation);
      status = "failed";
      result = undefined;
      error = budgetShardError(payloadViolation);
    }
    if (isTerminalShardStatus(attempt.status)) {
      return payloadViolation === null
        ? rejectSettlement(task, shard, attempt, status, "already_terminal")
        : rejectSettlement(task, shard, attempt, status, "attempt_budget_exceeded");
    }
    if (attempt.status !== "running" && !(attempt.status === "queued" && status === "cancelled")) {
      return payloadViolation === null
        ? rejectSettlement(task, shard, attempt, status, "invalid_transition")
        : rejectSettlement(task, shard, attempt, status, "attempt_budget_exceeded");
    }
    attempt.status = status;
    attempt.finishedAt = now();
    if (result !== undefined) attempt.result = result;
    if (error !== undefined) attempt.error = error;
    if (attempt.timer !== undefined) {
      clearTimeoutFn(attempt.timer);
      attempt.timer = undefined;
    }
    // 多轮复用安全边界：同一 shard 可以有多个 attempt（手工 retry / continuation），
    // shard 的**当前状态**只能由最新 attempt 决定。非最新 attempt 的迟到结算仍然写入它
    // 自己的 attempt 历史（审计可见）并发布 attempt 级事件，但绝不改写 shard.status，
    // 否则旧轮迟到结算会覆盖新轮状态，并可能重复发布旧轮 task_settled。
    const isLatestAttempt = shard.attempts[shard.attempts.length - 1] === attempt;
    if (isLatestAttempt) setShardStatus(task, shard, status);
    shard.updatedAt = attempt.finishedAt;
    task.updatedAt = attempt.finishedAt;
    emitShardStatus(task, shard, status, attempt.attempt, {
      ...(isLatestAttempt ? {} : { staleAttempt: true, shardStatus: shard.status }),
      ...(task.round === undefined ? {} : { round: task.round }),
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

  function launchFailure(task, shard, attempt, error) {
    settleLaunchFailure(task, shard, attempt, error);
  }

  /**
   * 启动/admission/child 失败的统一入口。
   *
   * 先用未归一化的原始错误判定字节预算：normalizeLaunchError 会丢弃自定义字段
   * （如 error.detail），若只判定归一化后的结果，超限负载会被静默丢弃而不是显式报告。
   * 超限时改写成带完整元数据的 BudgetExceededError（complete=false + 实测/上限字节）。
   */
  function settleLaunchFailure(task, shard, attempt, error) {
    const rawVerdict = checkBudget({
      resource: "attempt_error",
      limit: budgetPolicy.maxAttemptErrorBytes,
      receivedBytes: measureJsonBytes(errorInstinctPayload(error)),
      subject: task.parentTaskId + "/" + shard.shardId + "#" + attempt.attempt,
    });
    if (!rawVerdict.ok) {
      noteBudgetViolation(rawVerdict.violation);
      settleShard(task, shard, attempt, "failed", { error: budgetShardError(rawVerdict.violation) });
      return;
    }
    settleShard(task, shard, attempt, "failed", { error: normalizeLaunchError(error) });
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

    if (attempt.timeoutMs !== undefined) {
      // 超时通过注入时钟触发取消并标记 timed_out；若在此之前已经终态，
      // settleShard 会因幂等直接忽略这次超时。
      // 定时器回调是独立的异步 tick，自成一个持久化批（取消请求 + 终态写入只序列化一次）。
      attempt.timer = setTimeoutFn(() => withPersistenceBatch(() => {
        attempt.timer = undefined;
        requestShardCancellation(task, shard, attempt, "timeout");
        settleShard(task, shard, attempt, "timed_out", {
          error: toShardError({ name: "ShardTimeoutError", reason: "timeout", timeoutMs: attempt.timeoutMs }, "shard 超时"),
        });
      }), attempt.timeoutMs);
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
    // 取消与完成竞态：取消请求先写入终态则完成被忽略，反之完成胜出。
    if (attempt.cancelRequested === true) {
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
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
      noteBudgetViolation(violation);
      settleShard(task, shard, attempt, "failed", { error: budgetShardError(violation), violation });
      return;
    }
    settleShard(task, shard, attempt, "succeeded", { result: rawResult === null ? null : cloneJson(rawResult) });
  }

  function failShard(task, shard, attempt, error) {
    if (attempt.cancelRequested === true && !isTerminalShardStatus(attempt.status)) {
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 已取消" }, "shard 已取消"),
      });
      return;
    }
    settleLaunchFailure(task, shard, attempt, error);
  }

  // -------------------------------------------------------------------------
  // wait-all 聚合
  // -------------------------------------------------------------------------

  function aggregateTask(task) {
    const counts = computeCounts(task);
    const allTerminal = counts.pending === 0;
    const previousStatus = task.status;
    const wasSettled = task.settledAt !== undefined;
    let status = task.status;
    if (!allTerminal) {
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

  /** 是否每个 shard 的最新 attempt 都已终态（= 本轮 wait-all 已完成，可以复用续作）。 */
  function allShardsTerminal(task) {
    if (task === undefined || task === null) return false;
    return task.shards.every((shard) => {
      const latest = shard.attempts[shard.attempts.length - 1];
      return latest !== undefined && isTerminalShardStatus(latest.status);
    });
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
    const verdict = validateSubmitInput(input);
    if (!verdict.ok) throw validationError(verdict);

    // task 数量预算：快照里的 tasks 数组与内存表都按 task 线性增长，必须有上界。
    // 判定的是"本候选登记后的数量"，因此 +1；requestId 去重命中时提前返回，不占新槽位。
    const taskCountViolation = budgetVerdict(
      "tasks",
      budgetPolicy.maxTasks,
      tasks.size + 1,
      "tasks",
      "先等待或取消已结算的父任务再提交新任务",
    );
    if (taskCountViolation !== null) throw validationError(taskCountViolation);

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
      createdAt: timestamp,
      updatedAt: timestamp,
      settledAt: undefined,
      parentCancelRequested: false,
      shards: verdict.shards.map((shard) => ({
        shardId: shard.shardId,
        // 任务名称进入运行时状态：快照投影与恢复都以它为唯一来源，不再从别处推导。
        ...(shard.name === undefined ? {} : { name: shard.name }),
        prompt: shard.prompt,
        status: "queued",
        affectedPaths: shard.affectedPaths ?? [],
        ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: [{
          attempt: 1,
          status: "queued",
          startedAt: undefined,
          finishedAt: undefined,
          affectedPaths: shard.affectedPaths ?? [],
          ...(shard.timeoutMs === undefined ? {} : { timeoutMs: shard.timeoutMs }),
        }],
      })),
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
    const verdict = validateSubmitInput(input);
    if (!verdict.ok) throw validationError(verdict);
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
    // attempt 预算：**整体**判定（任一分片超限即整体拒绝），保证不会出现半写。
    for (const shard of task.shards) {
      const violation = budgetVerdict(
        "attempts",
        budgetPolicy.maxAttemptsPerShard,
        shard.attempts.length + 1,
        "shard " + shard.shardId,
        "该 shard 已耗尽多轮复用预算，请提交新的父任务或拆分工作",
      );
      if (violation !== null) {
        noteBudgetViolation(violation.violation);
        return {
          accepted: false, changed: false, reason: "attempt_budget_exceeded", parentTaskId,
          shardId: shard.shardId, violation: violation.violation,
        };
      }
    }

    // 全部校验通过后才修改状态：先构造本轮的全部 attempt，再统一提交（无半写）。
    const round = Number.isSafeInteger(task.round) && task.round >= 1 ? task.round + 1 : 2;
    const timestamp = now();
    const prepared = task.shards.map((shard) => {
      const previous = shard.attempts[shard.attempts.length - 1];
      const next = provided.get(shard.shardId);
      return {
        shard,
        prompt: next.prompt,
        attempt: createAttempt(shard, previous.attempt + 1, {
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
   * 记录一条「turn 归属无法证明」的结构化诊断（Host 观察到的竞态，不改变任何任务状态）。
   *
   * 语义边界：这不是结算失败（没有 attempt 状态写入），因此不能走 shard_settlement_rejected；
   * 只发布一条带 parentTaskId/shardId/attempt/reason/turn 的事件，让运维与测试都能按
   * sequence 观察「哪个 attempt 的哪一次 turn/end 因为无法证明归属而被忽略」。
   */
  function recordAttributionViolation(input) {
    const parentTaskId = normalizeText(input?.parentTaskId).trim();
    if (parentTaskId.length === 0) return { accepted: false, changed: false, reason: "missing_parent_task_id" };
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
   * 取消单个 shard。立即返回接受结果：
   * - queued：直接进入 cancelled，永不 admission；
   * - running：调用注入取消器并标记取消请求，由 child completion 异步收敛；
   * - 已终态：不改写，changed=false（重复取消幂等）。
   */
  function cancelShard(parentTaskId, shardId) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    const task = tasks.get(parentTaskId);
    if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
    const shard = task.shards.find((entry) => entry.shardId === shardId);
    if (shard === undefined) return { accepted: false, changed: false, reason: "unknown_shard" };

    const attempt = activeShard(shard) ?? shard.attempts[shard.attempts.length - 1];
    if (isTerminalShardStatus(attempt.status)) {
      return { accepted: true, changed: false, shardStatus: shard.status, attempt: attempt.attempt };
    }
    if (attempt.cancelRequested === true) {
      // 已接受过取消请求：幂等返回，不重复调用取消器。
      return { accepted: true, changed: false, shardStatus: shard.status, attempt: attempt.attempt, pending: true };
    }
    attempt.cancelRequested = true;
    if (attempt.status === "queued") {
      settleShard(task, shard, attempt, "cancelled", {
        error: toShardError({ name: "ShardCancelledError", reason: "cancelled", message: "shard 在排队阶段被取消" }, "shard 已取消"),
      });
      return { accepted: true, changed: true, shardStatus: shard.status, attempt: attempt.attempt };
    }
    // running：立即接受取消，但不直接写终态；真正的收敛由 completion 完成。
    requestShardCancellation(task, shard, attempt, "shard_cancelled");
    return { accepted: true, changed: true, shardStatus: shard.status, attempt: attempt.attempt, pending: true };
  }

  /**
   * 取消整个父任务。已终态 shard 不受影响，所有未终态 shard 立即停止 admission；
   * 父任务状态在全部 shard 收敛后聚合为 cancelled 或 completed_with_errors。
   */
  function cancelParent(parentTaskId) {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "manager_closed" };
    const task = tasks.get(parentTaskId);
    if (task === undefined) return { accepted: false, changed: false, reason: "unknown_parent_task" };
    const allTerminal = task.shards.every((shard) => {
      const attempt = shard.attempts[shard.attempts.length - 1];
      return attempt !== undefined && isTerminalShardStatus(attempt.status);
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
        });
      } else {
        // running 只能异步收敛：先接受取消请求，等 child completion 决定终态。
        cancellingShardIds.push(shard.shardId);
        requestShardCancellation(task, shard, attempt, "parent_cancelled");
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

    // attempt 数量预算：attempt 历史随重试无界增长（每个 attempt 都会进快照与事件），
    // 因此超限必须结构化失败且不新建 attempt。判定的是"新建后的 attempt 数"（+1），
    // 这样恰好允许 maxAttemptsPerShard 个 attempt 存在。
    const attemptViolation = budgetVerdict(
      "attempts",
      budgetPolicy.maxAttemptsPerShard,
      shard.attempts.length + 1,
      "attempt",
      "该 shard 已耗尽重试预算，请提交新的父任务或拆分工作",
    );
    if (attemptViolation !== null) {
      noteBudgetViolation(attemptViolation.violation);
      return {
        accepted: false,
        changed: false,
        reason: "attempt_budget_exceeded",
        shardStatus: shard.status,
        attempt: previous.attempt,
        violation: attemptViolation.violation,
      };
    }

    const nextAttempt = previous.attempt + 1;
    const attempt = createAttempt(shard, nextAttempt);
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
   * @param {{resume?:boolean, merge?:boolean}} [restoreOptions] - resume=true 时显式触发一次重新派发；
   *   merge=true 时保留当前任务并追加本次快照中的新任务，用于 deferred root 到达后的分批恢复；
   *   默认（false）只重建状态并让队列在下次调度时机自然派发。
   * @returns {{restored:boolean, tasks:number}}
   */
  function restore(snapshot, restoreOptions = {}) {
    if (closed) {
      return { accepted: false, restored: 0, tasks: 0, code: "MANAGER_CLOSED", reason: "manager_closed" };
    }
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
      noteBudgetViolation(restoreBudget.violation);
      throw validationError({
        ok: false,
        code: "INVALID_BUDGET",
        message: restoreBudget.violation.message,
        field: "snapshot",
        violation: restoreBudget.violation,
      });
    }

    for (const task of snapshot.tasks) {
      if (task === null || typeof task !== "object" || typeof task.parentTaskId !== "string" || task.parentTaskId.length === 0) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 parentTaskId", { field: "tasks" });
      }
      if (typeof task.role !== "string" || !Array.isArray(task.shards)) {
        throw new FanoutValidationError("INVALID_SNAPSHOT", "快照任务缺少 role/shards: " + task.parentTaskId, { field: "tasks" });
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
      // continuation 幂等记录（外部持久化输入）：结构必须严格合法，否则整体拒绝——
      // 静默丢弃会让「曾经续作过的 requestId」在恢复后被当成新请求而重复追加 attempt。
      if (task.continuationRequests !== undefined) {
        const requests = task.continuationRequests;
        if (requests === null || typeof requests !== "object" || Array.isArray(requests)) {
          throw new FanoutValidationError("INVALID_SNAPSHOT", "快照 continuationRequests 必须是对象: " + task.parentTaskId, { field: "tasks.continuationRequests" });
        }
        const keys = Object.keys(requests);
        if (keys.length > budgetPolicy.maxAttemptsPerShard) {
          throw new FanoutValidationError(
            "INVALID_BUDGET",
            "快照 continuationRequests 条数超过预算: " + task.parentTaskId,
            { field: "tasks.continuationRequests" },
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
        }
      }
    }

    // 配置必须沿用创建 manager 时的校验边界；所有字段先完成校验，再一次性替换，
    // 避免半个快照生效后把当前 manager 留在不可用状态。
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
    // 全局配置的恢复边界（与任务级上限区分）：
    // - 快照**自带** defaultConcurrencyLimit 时切到 snapshot 来源，恢复出来的任务按快照
    //   值驱动（重启不改变既有任务语义）；
    // - 快照**没有**这两个字段（旧快照 / 不落盘全局配置）时必须保留构造时注入的解析
    //   函数与 role 覆盖：否则恢复出来的 queued shard 会卡在快照生成时那次请求的临时
    //   配置上（例如 roleLimits=1），而当前 settings 明明允许更多并发。
    // 任务级 concurrencyLimit 不受这里影响：它始终优先，且由 task.concurrencyLimit 固化。
    if (snapshot.defaultConcurrencyLimit !== undefined) {
      defaultConcurrencyLimit = restoredDefaultConcurrencyLimit;
      resolverSource = "snapshot";
    }
    if (snapshot.roleLimits !== undefined) roleLimits = restoredRoleLimits;
    writeRoles = restoredWriteRoles;
    defaultAllowOverlap = restoredDefaultAllowOverlap;
    if (typeof injectedConflictChecker !== "function") {
      conflictChecker = createWriteRoleConflictChecker({ writeRoles });
    }
    const resume = restoreOptions.resume === true;
    const merge = restoreOptions.merge === true;
    if (!merge) {
      tasks.clear();
      requestIndex.clear();
      rotationCursors.clear();
    }
    // restore 在所有任务重建完成后一次性刷新派生索引，确保 merge 替换任务时不留旧引用。
    const restoredEvents = Array.isArray(snapshot.events)
      ? snapshot.events.slice(-budgetPolicy.maxEventHistory).map((event) => cloneJson(event))
      : [];
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
      trimEventHistory();
    } else {
      eventHistory.splice(0, eventHistory.length, ...restoredEvents);
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
    const rolesToSchedule = new Set();
    restoringSnapshot = true;
    for (const rawTask of snapshot.tasks) {
      const parentCancelRequested = rawTask.parentCancelRequested === true;
      // 角色在构造 task 之前取出：shards.map 的回调在 task 对象字面量求值期间执行，
      // 此时 `task` 仍处于 TDZ，任何对 task.role 的引用都会抛 ReferenceError
      // （整个 restore 因此静默失败）。用已校验的 rawTask.role 作为本任务的 role 源。
      const taskRole = rawTask.role;
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
        createdAt: typeof rawTask.createdAt === "number" ? rawTask.createdAt : now(),
        updatedAt: typeof rawTask.updatedAt === "number" ? rawTask.updatedAt : now(),
        settledAt: typeof rawTask.settledAt === "number" ? rawTask.settledAt : undefined,
        parentCancelRequested,
        shards: rawTask.shards.map((rawShard) => {
          const attempts = (rawShard.attempts.length === 0 ? [{ attempt: 1, status: "queued" }] : rawShard.attempts).map((rawAttempt, index) => ({
            attempt: Number.isInteger(rawAttempt.attempt) ? rawAttempt.attempt : index + 1,
            status: typeof rawAttempt.status === "string" ? rawAttempt.status : "queued",
            startedAt: typeof rawAttempt.startedAt === "number" ? rawAttempt.startedAt : undefined,
            finishedAt: typeof rawAttempt.finishedAt === "number" ? rawAttempt.finishedAt : undefined,
            affectedPaths: Array.isArray(rawAttempt.affectedPaths) ? [...rawAttempt.affectedPaths] : [],
            ...(rawAttempt.cancelRequested === true ? { cancelRequested: true } : {}),
            ...(typeof rawAttempt.timeoutMs === "number" ? { timeoutMs: rawAttempt.timeoutMs } : {}),
            ...(typeof rawAttempt.childId === "string" ? { childId: rawAttempt.childId } : {}),
            ...(typeof rawAttempt.messageId === "string" ? { messageId: rawAttempt.messageId } : {}),
            ...(rawAttempt.result === undefined ? {} : { result: cloneJson(rawAttempt.result) }),
            ...(rawAttempt.error === undefined ? {} : { error: cloneJson(rawAttempt.error) }),
          }));
          // 恢复语义：running 的运行时句柄已经不存在，统一记为 interrupted。
          for (const attempt of attempts) {
            if (attempt.status === "running") {
              attempt.status = "interrupted";
              attempt.finishedAt = attempt.finishedAt ?? now();
              attempt.error = attempt.error ?? toShardError(
                { name: "ShardInterruptedError", reason: "restore", message: "运行时恢复后丢失原 child，需手工重试" },
                "shard 因恢复而中断",
              );
            }
          }
          const last = attempts[attempts.length - 1];
          const latestTerminal = isTerminalShardStatus(last.status);
          const shard = {
            shardId: rawShard.shardId,
            // 使用恢复阶段已校验并归一化的名称；旧快照没有该字段时保持"无名称"，
            // 由投影侧回退 shardId。
            ...(typeof rawShard.name === "string" ? { name: rawShard.name.trim() } : {}),
            prompt: typeof rawShard.prompt === "string" ? rawShard.prompt : "",
            status: latestTerminal ? last.status : "queued",
            affectedPaths: last.affectedPaths.length > 0 ? [...last.affectedPaths] : (Array.isArray(rawShard.affectedPaths) ? [...rawShard.affectedPaths] : []),
            ...(rawShard.cancelRequested === true || (parentCancelRequested && rawShard.status === "queued") ? { cancelRequested: true } : {}),
            ...(last.timeoutMs === undefined ? {} : { timeoutMs: last.timeoutMs }),
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
      if (resume) {
        for (const shard of task.shards) {
          const last = shard.attempts[shard.attempts.length - 1];
          if (last === undefined || last.status !== "interrupted") continue;
          if (shard.cancelRequested === true) continue;
          const attempt = createAttempt(shard, last.attempt + 1);
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
      if (task.requestId !== undefined) requestIndex.set(task.requestId, task.parentTaskId);
      aggregateTask(task);
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
   */
  function close() {
    if (closed) return { accepted: false, changed: false, code: "MANAGER_CLOSED", reason: "already_closed" };
    closed = true;
    restoreDispatchSuppressed = true;
    workRequested = false;
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
        settleShard(task, shard, attempt, "cancelled", {
          error: toShardError(
            { name: "FanoutClosedError", reason: "manager_closed", message: "fan-out manager 已关闭" },
            "fan-out manager 已关闭",
          ),
        });
      }
      aggregateTask(task);
      notifyPersistence();
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
    /** 只读：某 attempt 当前绑定的 messageId（严格 turn 归属校验用，不克隆任务快照）。 */
    attemptMessageIdOf,
    /** Host 观察到的「turn 归属无法证明」结构化诊断（只写事件，不改变任务状态）。 */
    recordAttributionViolation: (input) => withPersistenceBatch(() => recordAttributionViolation(input)),
    getTask,
    listTasks,
    getCounts,
    subscribe,
    whenIdle,
    isIdle,
    close: () => withPersistenceBatch(() => close()),
    snapshot: () => serializeSnapshot(),
    restore: (snapshot, restoreOptions) => withPersistenceBatch(() => restore(snapshot, restoreOptions)),
    persistSnapshot,
    /** 只读并发视图：有效默认值 + 各 role 覆盖 + 解析来源（诊断，不泄露任务负载）。 */
    concurrencyLimits,
    /**
     * 只读预算视图：当前用量、冻结上限与最近一次违规。
     * 不暴露任何调度内部状态，宿主/客户端据此判断是否接近预算。
     */
    budget: () => Object.freeze({
      limits: Object.freeze({ ...budgetPolicy }),
      tasks: tasks.size,
      events: eventHistory.length,
      eventBytes: checkEventHistoryBudget(eventHistory, {
        maxCount: budgetPolicy.maxEventHistory,
        maxBytes: budgetPolicy.maxEventHistoryBytes,
      }).bytes,
      lastViolation: lastBudgetViolation === null ? null : cloneJson(lastBudgetViolation),
    }),
  });
}
