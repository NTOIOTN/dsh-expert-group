// ─────────────────────────────────────────────────────────────────────────────
// R1-07（模块拆分）：本文件从 fanout.js 前段外移而来，承接原始源行 489–1045
// （R1-05 后为 491–1047）。内容是 attempt 身份/停止证据判定、结构化错误构造与
// 归一、数值/名称/提交输入的校验与预算裁决。
// 依赖方向：validation -> contracts + errors（单向，无环）。为让 manager 复用
// 私有 helper，本文件把原本私有的 helper 改为导出，但不在 fanout.js 再导出。
// ─────────────────────────────────────────────────────────────────────────────
import {
  BUDGET_EXCEEDED_CODE,
  FANOUT_BUDGET,
  checkBudget,
  checkTaskInputBudget,
  measureUtf8Bytes,
} from "../resource-budget.js";
import {
  MODEL_ROUTE_ERROR_CODES,
  classifyModelRouteError,
} from "../shared/model-route.js";
import {
  describeSubagentCapacityFailure,
} from "../shared/capacity-errors.js";
import {
  MAX_CONCURRENCY_LIMIT,
  MAX_PROVIDER_LIMIT,
  MAX_SHARD_NAME_BYTES,
  MIN_CONCURRENCY_LIMIT,
  MIN_PROVIDER_LIMIT,
  PROVIDER_ROUTE_CHANGED,
  validateTimeoutMs,
} from "./contracts.js";
import { STOP_EVIDENCE_STATE_OBSERVED } from "./errors.js";

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
export function defaultTerminalReason(status) {
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
export function budgetShardError(violation) {
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
export function toShardError(error, fallbackMessage) {
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
export function normalizeLaunchError(error) {
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
export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizeText(value) {
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
export function normalizeIdSet(value) {
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

export function normalizeWriteRoles(writeRoles) {
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
export function validateShardName(value, field) {
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
export function normalizeConflict(verdict) {
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
export function validationError(verdict) {
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
export function budgetVerdict(resource, limit, receivedBytes, field, hint, extra) {
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
