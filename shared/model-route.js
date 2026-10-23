/**
 * 模型候选与路由。
 *
 * 角色模型候选计划、启动前 fallback、路由 marker 归一与路由错误分类。
 * 本文件由原 `shared.js` 的 3892–4353 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/model-route
 */
import { ROLES } from "./protocol.js";
import { REQUEST_RETRYABLE_FAILURE_CODES } from "./retry-policy.js";

// ── 模型候选与启动前 fallback（票据 24）────────────────────────────────────
//
// 这一节只放**纯函数/常量**：设置归一、候选计划与错误分类都不依赖 Host 服务，
// 因此组合根、Host 投影模块与测试可以共用同一套判定，避免出现第二份实现。
// 任何函数都不得读取凭据或 prompt；错误分类只返回稳定 code，绝不返回原始 message。

/** 自动降级默认上限（每任务每角色最多 2 次降级）。 */
export const DEFAULT_MODEL_FALLBACK_LIMIT = 2;
/** 自动降级上限的硬上限：防止链式降级放大成本。 */
export const MAX_MODEL_FALLBACK_LIMIT = 4;
/**
 * 每个角色允许配置的候选模型数量上限。
 *
 * 这是**唯一**来源：设置读取归一（裁剪）、写入校验（拒绝）与路由计划共用同一个值，
 * 客户端设置页也从同一语义取上限（客户端常量需与这里保持一致）。
 *
 * 3 是设置页按角色分页签后的可用范围：
 * - 写入面：超过上限必须整次拒绝保存（不做静默丢弃，否则用户以为配置已生效）；
 * - 读取面：旧版本允许配置到 8 条，升级后存量文档必须**静默裁剪**为前 N 条
 *   （保持原顺序），绝不因为存量超限让设置页打不开。
 */
export const MAX_MODEL_CANDIDATES_PER_ROLE = 3;

/** 全部候选都不可用时使用的稳定错误码（ValidationError.code）。 */
export const MODEL_CANDIDATES_EXHAUSTED = "MODEL_CANDIDATES_EXHAUSTED";
/** 预检成功的稳定状态码（只用于 RPC 投影，不写入子代理快照）。 */
export const MODEL_ROUTE_OK = "OK";
/** 角色尚未配置主模型时预检 RPC 的状态码。 */
export const MODEL_ROUTE_NOT_CONFIGURED = "NOT_CONFIGURED";

/**
 * 模型解析失败的稳定分类码。
 *
 * 只有预检类失败允许触发启动前 fallback；运行期错误（429/5xx/超时/取消）绝不进入
 * 这里的分类集合，必须原样上抛。
 */
export const MODEL_ROUTE_ERROR_CODES = Object.freeze({
  INVALID_SELECTION: "INVALID_SELECTION",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  CREDENTIAL_UNAVAILABLE: "CREDENTIAL_UNAVAILABLE",
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE",
  UNSUPPORTED_REASONING_EFFORT: "UNSUPPORTED_REASONING_EFFORT",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  /**
   * 提供方限流（HTTP 429 / rate limit / 配额）的稳定原因码（票据 26）。
   *
   * 为什么单独一个码：429 在「派发前」与「运行中」两个阶段都**不得**触发自动换模型
   * ——派发前由 provider 名额排队承担，运行中由宿主请求级退避重试承担。因此它必须
   * 与 ROUTE_RESOLUTION_FAILED（未知解析失败）区分开，才能让诊断、快照
   * （lastRouteErrorCode）与 shard 错误投影如实说明「这是限流，不是模型不可用」。
   *
   * 它**不在** PRECHECK_MODEL_ROUTE_ERROR_CODE_SET 里：isPrecheckModelRouteFailure()
   * 对它恒为 false，executeModelRoutePlan 因此立即上抛、绝不尝试下一个候选。
   */
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  ROUTE_RESOLUTION_FAILED: "ROUTE_RESOLUTION_FAILED",
});

const MODEL_ROUTE_ERROR_CODE_SET = new Set(Object.values(MODEL_ROUTE_ERROR_CODES));

/** 允许在启动前触发降级的错误码集合（模型/provider/凭据/目录/能力/形状）。 */
const PRECHECK_MODEL_ROUTE_ERROR_CODE_SET = new Set([
  MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION,
  MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND,
  MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND,
  MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
  MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE,
  MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT,
  MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY,
]);

/**
 * 运行期模型失败中「重试无意义」的确定性错误码集合（运行期降级的触发分类）。
 *
 * 与 REQUEST_RETRYABLE_FAILURE_CODES 的关系：后者回答「值不值得再发一次请求」，
 * 这里回答「是不是换一个模型才可能成功」。两个集合**刻意重叠**（AUTH/UNAUTHORIZED/
 * FORBIDDEN/INVALID_REQUEST/NO_PROVIDER/NO_ADAPTER/UNKNOWN_MODEL/MODEL_NOT_FOUND
 * 既在宿主重试白名单里，又是确定性失败），因此运行期降级判定必须先看本集合：
 * 有候选可切时立即切换，不把当前模型的 5 次预算浪费在必然复现的错误上；
 * 没有候选可切时才退回既有请求级重试/终态语义（保持 root 与「未配置候选」的行为）。
 *
 * QUOTA/INVALID_CREDENTIAL 等未列入：用户确认的确定性集合只包含下列码，
 * 其余错误一律按现有瞬态/未知语义处理，避免擅自扩大「换模型」的触发面。
 */
export const DETERMINISTIC_MODEL_FAILURE_CODES = Object.freeze([
  "MODEL_NOT_FOUND",
  "UNKNOWN_MODEL",
  "NO_PROVIDER",
  "NO_ADAPTER",
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  /**
   * 上下文窗口超限（dsh-llm 的 provider-neutral 稳定码）。
   *
   * 只认**结构化码**，绝不解析 message 文本：上下文超限在换到上下文窗口更大的
   * 候选后确实可能成功，但它也可能来自单个超长工具结果——因此仍按「确定性失败」
   * 立即换候选，最终由候选链耗尽后的既有失败语义收口。
   */
  "CONTEXT_WINDOW_EXCEEDED",
]);

/**
 * 判断一次 request-error 的结构化 failure 是否属于确定性失败（运行期降级触发）。
 * @param {object} [failure] - 公开 agent/request-error payload 的 failure。
 * @returns {boolean} code 明确属于确定性集合时返回 true。
 */
export function isDeterministicModelFailure(failure) {
  return failure !== null
    && typeof failure === "object"
    && typeof failure.code === "string"
    && DETERMINISTIC_MODEL_FAILURE_CODES.includes(failure.code);
}

/**
 * agentOptions 上的实际路由 marker。
 *
 * 与其它 marker 一样只存在于 agent options / child_models，不进入任务 prompt；
 * 冷恢复时 Host 不还原 agentOptions，因此真正权威的来源仍是 child_models 的扁平字段。
 */
export const EXPERT_ROUTE_MARKER = "__degExpertRoute";

/**
 * agentOptions 上的目标 subagent provider marker（票据 29）。
 *
 * 记录本次 child 实际使用的 subagent provider 名（"spawn" 或继承型 fork provider）。
 * 与其它 marker 一样只存在于 agent options / child_models，不进入任务 prompt；
 * 冷恢复时 Host 不还原 agentOptions，因此权威来源仍是 child_models 的扁平字段
 * `subagentProvider`。它的作用有二：
 * 1. agent/created 在持久化前就能读到本次派发选择的 provider；
 * 2. 恢复/重建路径只读该快照，不按当前设置重新选择（绝不把继承型 child 静默改回 spawn）。
 */
export const EXPERT_SUBAGENT_PROVIDER_MARKER = "__degExpertSubagentProvider";

/**
 * agentOptions 上的上下文继承 marker（票据 29）。
 *
 * 只有布尔值才是合法快照：true 表示该 child 使用继承型 provider（seed 来自父日志的
 * 已完成 turn 前缀），false/缺失表示普通 spawn。投影侧缺失时省略字段，绝不伪造 false。
 */
export const EXPERT_INHERIT_CONTEXT_MARKER = "__degExpertInheritContext";

/**
 * 上下文继承的稳定错误码（票据 29）。
 *
 * - `UNAVAILABLE`：宿主没有可用的继承型 provider（未注册、缺 prepareContinuable、
 *   inheritsParentContext !== true 或能力位不足），或 legacy 路径不支持 fork；
 * - `EMPTY`：父会话日志可读但没有任何已完成 turn，无法构造继承 seed。
 *
 * 两者都必须显式失败，绝不静默回退 spawn（那会把“继承上下文”降级成“无上下文”）。
 */
export const CONTEXT_INHERITANCE_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "CONTEXT_INHERITANCE_UNAVAILABLE",
  EMPTY: "CONTEXT_INHERITANCE_EMPTY",
});

/**
 * 允许开启上下文继承的内置角色集合（票据 29）。
 *
 * 只包含内置非 Observer 角色：Observer 的安全边界是“只接收视觉任务、不接收用户上下文”，
 * 因此不允许出现在设置映射里。
 */
export const CONTEXT_INHERITANCE_ROLE_IDS = Object.freeze(ROLES.slice());

/** 自动降级上限归一：只接受 0..4 的安全整数，非法/缺失回退默认 2。 */
export function normalizeModelFallbackLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MODEL_FALLBACK_LIMIT
    ? value
    : DEFAULT_MODEL_FALLBACK_LIMIT;
}

/**
 * 单条模型选择的严格形状归一。
 *
 * provider/model 必须是非空字符串；reasoningEffort 只接受字符串或缺省（undefined/null/
 * 空串都表示未指定）。非法形状返回 undefined，由调用方决定是拒绝保存还是跳过候选。
 * 该函数**不做 trim**：与既有 settings/defaults 语义保持一致，模型名逐字匹配。
 */
export function normalizeModelSelection(selection) {
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return undefined;
  if (typeof selection.provider !== "string" || selection.provider.length === 0) return undefined;
  if (typeof selection.model !== "string" || selection.model.length === 0) return undefined;
  const rawEffort = selection.reasoningEffort;
  if (rawEffort !== undefined && rawEffort !== null && rawEffort !== "" && typeof rawEffort !== "string") return undefined;
  const effort = typeof rawEffort === "string" && rawEffort.length > 0 ? rawEffort : undefined;
  return {
    provider: selection.provider,
    model: selection.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

/**
 * 单条模型选择的比较键：provider + model + 规范化 effort。
 *
 * 规范化 effort 指 undefined/null/空串视为同一档“未指定”；这样重复候选判定不会因为
 * 旧配置里的空串 effort 与缺省字段不同而漏判。非对象/缺 provider/model 返回空串。
 *
 * 注意：这是**设置面**的比较键（含 effort），用于拒绝完全重复的候选行；
 * 运行期「候选链」使用的是 {@link modelRouteKeyOf}（忽略 effort），两者刻意不同。
 */
export function modelSelectionKeyOf(selection) {
  const normalized = normalizeModelSelection(selection);
  if (normalized === undefined) return "";
  return normalized.provider + "\u0000" + normalized.model + "\u0000" + (normalized.reasoningEffort ?? "");
}

/**
 * 运行期路由身份键：provider + model（**刻意忽略 reasoningEffort**）。
 *
 * 为什么忽略 effort：运行期降级的语义是「换模型」。同一 provider+model 只改思考档位
 * 不构成可切换的候选——它既不能占用 fallbackLimit（否则真实备用模型会被截掉），
 * 也不该在运行期被当成「下一个候选」（否则会在同一模型上来回切换、白白消耗预算）。
 * 预检计划（buildModelRoutePlan）与运行期判定（nextModelCandidateOf）共用本键，
 * 保证「配置里能被计划的候选」与「运行期能被切到的候选」是同一集合。
 *
 * 非对象/缺 provider/model 返回空串，调用方必须把空串视为「不可用」。
 */
export function modelRouteKeyOf(selection) {
  const normalized = normalizeModelSelection(selection);
  if (normalized === undefined) return "";
  return normalized.provider + "\u0000" + normalized.model;
}

/** 稳定错误码准入：只接受本模块声明的枚举，拒绝把任意字符串写进快照。 */
export function normalizeModelRouteErrorCode(value) {
  if (typeof value !== "string") return undefined;
  return MODEL_ROUTE_ERROR_CODE_SET.has(value) ? value : undefined;
}

/**
 * 把一次模型解析错误分类为稳定 code。
 *
 * 分类顺序：显式 causeCode → code/name 枚举 → HTTP 状态 → 保守的消息模式。
 * 只有明确的预检类失败会被归类为可降级 code；未知错误、5xx、超时一律是
 * ROUTE_RESOLUTION_FAILED（非预检），限流是 PROVIDER_RATE_LIMITED（同样非预检），
 * 调用方必须原样抛出而不是切换候选。
 */
export function classifyModelRouteError(error) {
  const explicit = normalizeModelRouteErrorCode(error?.causeCode);
  if (explicit !== undefined) return explicit;
  const rawCode = typeof error?.code === "string" ? error.code.trim() : "";
  const rawName = typeof error?.name === "string" ? error.name.trim() : "";
  const token = (rawCode || rawName).toUpperCase().replace(/[\s-]+/g, "_");
  if (token.length > 0) {
    // 限流（票据 26）：单独归类为 PROVIDER_RATE_LIMITED，既保留“非预检、绝不换候选”
    // 的既有判定，又能让诊断区分「provider 限流」与「未知解析失败」。
    if (["RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "RATE_LIMITED", "TOO_MANY_REQUESTS", "PROVIDER_RATE_LIMITED", "QUOTA_EXCEEDED"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    }
    if (["OVERLOADED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "TIMEOUT", "ABORT_ERR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
    }
    if (["UNSUPPORTED_REASONING_EFFORT", "UNSUPPORTEDREASONINGEFFORTERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT;
    }
    if (["MODEL_NOT_FOUND", "ERR_MODEL_NOT_FOUND", "MODELNOTFOUNDERROR", "UNKNOWN_MODEL"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    }
    if (["PROVIDER_NOT_FOUND", "PROVIDERNOTFOUNDERROR", "UNKNOWN_PROVIDER"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND;
    }
    if (["CREDENTIAL_UNAVAILABLE", "MISSING_CREDENTIAL", "MISSING_API_KEY", "NO_API_KEY", "AUTH_FAILED", "AUTHENTICATIONERROR", "CREDENTIALERROR", "UNAUTHORIZED", "INVALID_API_KEY"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    }
    if (["CATALOG_UNAVAILABLE", "MODEL_DIRECTORY_UNAVAILABLE", "DIRECTORY_UNAVAILABLE", "ENOENT"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE;
    }
    if (["UNSUPPORTED_CAPABILITY", "CAPABILITY_INCOMPATIBLE", "UNSUPPORTED_INPUT", "UNSUPPORTED_IMAGE", "UNSUPPORTEDTOOLERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY;
    }
    if (["INVALID_SELECTION", "INVALID_MODEL_SELECTION", "INVALIDSELECTIONERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    }
  }
  const status = Number(error?.statusCode ?? error?.status ?? error?.httpStatus ?? error?.response?.status);
  if (Number.isInteger(status)) {
    if (status === 401 || status === 403) return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    if (status === 404) return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    if (status === 400 || status === 422) return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    // 429 是限流（票据 26 的稳定原因码），5xx 仍是未知解析失败；两者都不可降级。
    if (status === 429) return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    if (status >= 500) return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.length > 0) {
    // 限流文本（429 / rate limit / 限流 / 配额）归 PROVIDER_RATE_LIMITED；
    // 超时与 overload 仍按未知解析失败处理（它们是不同的运行期失败形态）。
    if (/rate.?limit|too many requests|\b429\b|限流|配额/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    }
    if (/overload|超时|timed?\s*out/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
    }
    if (/(model|模型).{0,24}(not found|does not exist|unknown|不存在|未找到|已移除)/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    }
    if (/(provider|提供方).{0,24}(not found|unknown|不存在|未找到)/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND;
    }
    if (/credential|api.?key|unauthor|authenticat|missing key|凭据|密钥|鉴权/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    }
    if (/catalog|directory|模型目录|目录不可用/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE;
    }
    if (/unsupported.{0,24}(reasoning|effort|capabilit|input|image)|not support|不支持.{0,24}(档位|能力|思考|输入)/i.test(message)) {
      return /effort|reasoning|档位|思考/i.test(message)
        ? MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT
        : MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY;
    }
    if (/invalid.{0,16}(selection|model)|模型选择/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    }
  }
  return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
}

/** 读取错误上的稳定 code：优先显式 causeCode，否则按分类器推断。 */
export function modelRouteErrorCodeOf(error) {
  return normalizeModelRouteErrorCode(error?.causeCode) ?? classifyModelRouteError(error);
}

/** 该错误是否属于启动前可降级的预检类失败。 */
export function isPrecheckModelRouteFailure(error) {
  return PRECHECK_MODEL_ROUTE_ERROR_CODE_SET.has(modelRouteErrorCodeOf(error));
}

/** 预检类错误码的只读判定（供投影层拒绝任意字符串进入快照）。 */
export function isModelRouteErrorCode(value) {
  return MODEL_ROUTE_ERROR_CODE_SET.has(value);
}

/** 稳定 code 的中文可读原因（不包含原始 message/凭据/prompt）。 */
export function modelRouteErrorMessage(code) {
  switch (code) {
    case MODEL_ROUTE_OK: return "可用";
    case MODEL_ROUTE_NOT_CONFIGURED: return "尚未配置模型";
    case MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION: return "模型选择不完整或类型无效";
    case MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND: return "模型不存在或已被移除";
    case MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND: return "provider 不存在";
    case MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE: return "provider 凭据不可用";
    case MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE: return "模型目录不可用";
    case MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT: return "模型不支持该思考档位";
    case MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY: return "模型能力不兼容";
    case MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED: return "提供方限流（429/配额），需要退避重试";
    case MODEL_CANDIDATES_EXHAUSTED: return "所有模型候选均不可用";
    default: return "模型解析失败";
  }
}

/**
 * 构造有序路由计划：[primary, candidate1, candidate2, ...]。
 *
 * - 最多 1 + fallbackLimit 个可尝试项；fallbackLimit=0 时只有 primary；
 * - 与 primary 或更早候选**同 provider+model**（忽略 effort）的候选项被跳过，
 *   且不占用降级次数——运行期只按模型切换，effort-only 候选永远不可能被切到，
 *   让它占预算会把真实备用模型挤出计划（见 {@link modelRouteKeyOf}）；
 * - candidateIndex 保留候选在**原始配置里的位置**（primary=0，第一个候选=1），
 *   因此重复项被跳过后，实际使用的候选索引仍然可解释。
 *
 * @param {unknown} primary - 生效主选择（可能是会话覆盖）。
 * @param {unknown[]} candidates - 全局候选列表（有序）。
 * @param {unknown} fallbackLimit - 自动降级上限。
 * @returns {{plan: Array<{selection: unknown, candidateIndex: number}>, requestedPrimary: object|undefined, fallbackLimit: number}}
 */
export function buildModelRoutePlan(primary, candidates, fallbackLimit) {
  const limit = normalizeModelFallbackLimit(fallbackLimit);
  const normalizedPrimary = normalizeModelSelection(primary);
  const plan = [{ selection: normalizedPrimary ?? primary, candidateIndex: 0 }];
  const seen = new Set();
  if (normalizedPrimary !== undefined) seen.add(modelRouteKeyOf(normalizedPrimary));
  const list = Array.isArray(candidates) ? candidates.slice(0, MAX_MODEL_CANDIDATES_PER_ROLE) : [];
  let added = 0;
  for (let index = 0; index < list.length && added < limit; index += 1) {
    const normalized = normalizeModelSelection(list[index]);
    const key = normalized === undefined ? "" : modelRouteKeyOf(normalized);
    if (key.length > 0 && seen.has(key)) continue;
    if (key.length > 0) seen.add(key);
    plan.push({ selection: normalized ?? list[index], candidateIndex: index + 1 });
    added += 1;
  }
  return { plan, requestedPrimary: normalizedPrimary, fallbackLimit: limit };
}

/**
 * 从子代理持久化记录/运行期 marker 投影实际路由字段（票据 24）。
 *
 * 缺失字段直接省略，绝不补 0：只有真正记录过 candidateIndex=0（primary）时才会输出 0。
 * lastRouteErrorCode 只接受本模块声明的稳定码，避免任意字符串进入快照。
 */
export function projectModelRouteFields(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const projected = {};
  if (Number.isSafeInteger(source.candidateIndex) && source.candidateIndex >= 0) projected.candidateIndex = source.candidateIndex;
  if (Number.isSafeInteger(source.fallbackCount) && source.fallbackCount >= 0) projected.fallbackCount = source.fallbackCount;
  const code = normalizeModelRouteErrorCode(source.lastRouteErrorCode);
  if (code !== undefined) projected.lastRouteErrorCode = code;
  return projected;
}

/**
 * 校验并归一 agentOptions 上的路由 marker。
 *
 * candidateIndex/fallbackCount 必须是非负安全整数；requestedPrimary 可选但出现时必须是
 * 合法选择；lastRouteErrorCode 可选但只接受稳定码。形状不合法返回 undefined，调用方
 * 应退回 child_models 记录或干脆不写路由字段（绝不写入半截/malformed marker）。
 */
export function normalizeModelRouteMarker(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Number.isSafeInteger(value.candidateIndex) || value.candidateIndex < 0) return undefined;
  if (!Number.isSafeInteger(value.fallbackCount) || value.fallbackCount < 0) return undefined;
  const requestedPrimary = normalizeModelSelection(value.requestedPrimary);
  const lastRouteErrorCode = normalizeModelRouteErrorCode(value.lastRouteErrorCode);
  if (value.lastRouteErrorCode !== undefined && lastRouteErrorCode === undefined) return undefined;
  return {
    ...(requestedPrimary === undefined ? {} : { requestedPrimary }),
    candidateIndex: value.candidateIndex,
    fallbackCount: value.fallbackCount,
    ...(lastRouteErrorCode === undefined ? {} : { lastRouteErrorCode }),
  };
}

/**
 * 持久化 child_models 记录里的「实际路由快照」是否足以覆盖 live 投影。
 *
 * 判定条件：provider/model 都是非空字符串，且至少有一个路由字段
 * （candidateIndex/fallbackCount/lastRouteErrorCode）。命中时 provider/model/effort
 * 必须**整体**取持久化值，绝不能把 candidateIndex（来自快照）与 provider/model
 * （来自旧 request header / agent.options）混在一行显示——运行期降级只更新持久化
 * 快照，混用会渲染成「候选索引 + 主模型 + 旧 effort」。
 *
 * 旧记录（没有路由字段）返回 false，投影继续沿用既有的 header → options 优先级。
 *
 * @param {unknown} record - child_models 持久化记录。
 * @returns {boolean} 持久化路由快照是否权威。
 */
export function persistedModelRouteIsAuthoritative(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if (typeof record.provider !== "string" || record.provider.length === 0) return false;
  if (typeof record.model !== "string" || record.model.length === 0) return false;
  return Object.keys(projectModelRouteFields(record)).length > 0;
}

/**
 * 从持久化记录（child_models 的扁平字段）读取路由字段。
 *
 * 与 normalizeModelRouteMarker 不同：这里允许只有部分字段（旧记录/旧进程快照），
 * 投影时缺失字段省略；恢复路由时由调用方再要求 provider/model 存在。
 */
export function modelRouteFieldsFromRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return {};
  const requestedPrimary = normalizeModelSelection(record.requestedPrimary);
  const projected = projectModelRouteFields(record);
  return {
    ...(requestedPrimary === undefined ? {} : { requestedPrimary }),
    ...projected,
  };
}
