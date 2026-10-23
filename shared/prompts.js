/**
 * 提示词覆盖配置与状态角色文案。
 *
 * 提示词覆盖的 settings 键、grapheme 上限、归一化，以及页面状态角色的标签/身份映射。
 * 本文件由原 `shared.js` 的 2735–2897 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/prompts
 */
import { OPTIONAL_ROLES, ROLES } from "./protocol.js";
import { roleStatusLabels } from "../role-registry.js";

/**
 * 当前页面状态文案允许使用的英文专家 role id。根会话不属于 role 列表，
 * 由 resolveRunningStatusText 固定映射为 Orchestrator。
 */
export const STATUS_ROLE_IDS = [...ROLES, ...OPTIONAL_ROLES];

// ── 专家提示词覆盖的共享配置边界 ──────────────────────────────────────────
// Host 与客户端必须使用同一份角色集合、同一上限与同一「空白即无效」语义，
// 否则设置页会显示一份可保存、Host 却拒绝（或反之）的草稿。这里是唯一来源；
// 客户端 bundle 通过同目录复制使用同样的字面量。
// 本模块保持无 Node 依赖：只做字符串/对象归一，不读取 settings 或任何 Host 状态。

/** dsh-expert-group settings namespace 中承载六角色自定义提示词的字段名。 */
export const PROMPT_OVERRIDES_SETTINGS_KEY = "promptOverrides";

/**
 * 单个专家提示词的最大 Unicode grapheme 数量（32,000）。
 *
 * 用 grapheme 而不是 UTF-16 code unit：中文、emoji 与组合字符的显示计数必须与
 * 用户直觉一致；组合字符（例如带连接符的 emoji）算一个字符，不会被重复计数。
 *
 * 注意这是**显示/校验口径**，与传输体积是两件独立的事：grapheme 与 UTF-8 字节
 * 不成固定比例（ASCII 1 字节、CJK/emoji 基础码位最多 4 字节，而 ZWJ 组合簇的字节
 * 数没有固定上界）。整份候选的字节预算由 host/rpc-transport 的
 * RPC_SETTINGS_COMMIT_BODY_LIMIT 独立负责，超限是结构化 413 而不是截断。
 */
export const PROMPT_OVERRIDE_MAX_GRAPHEMES = 32000;

/** 提示词覆盖的稳定错误 code：保存候选在写入边界被拒绝时返回。 */
export const PROMPT_OVERRIDE_INVALID_CODE = "INVALID_PROMPT_OVERRIDE";

/**
 * 未注册角色被写入覆盖时的稳定错误 code。
 *
 * 与「非法角色」分开：未知角色键是调用方拼错了角色集合，而不是提示词内容问题。
 */
export const PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE = "UNKNOWN_PROMPT_ROLE";

/**
 * 按用户可感知的 Unicode 字符计数。
 *
 * 优先使用 Intl.Segmenter（Node 与目标浏览器都提供）；只有不可用时才回退到
 * [...text] 的 code point 计数——回退会低估组合字符（用户看到 1 个字符，这里算 N 个），
 * 因此上限判定只会更宽松，绝不会因为环境差异拒绝用户能看到的合法长度。
 *
 * @param {unknown} text - 待计数文本；非字符串按空字符串处理。
 * @returns {number} grapheme 数量（非负安全整数）。
 */
export function countPromptGraphemes(text) {
  const value = typeof text === "string" ? text : "";
  if (value.length === 0) return 0;
  try {
    const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
    if (segmenter !== null) {
      let count = 0;
      for (const _segment of segmenter.segment(value)) count += 1;
      return count;
    }
  } catch { /* 环境不支持 Segmenter：回退到 code point 计数 */ }
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

/**
 * 归一化一份提示词覆盖候选。
 *
 * 归一规则（Host 写入校验与客户端草稿必须一致）：
 * - 未知角色键、非字符串值与纯空白文本被丢弃（等价于该角色没有覆盖）；
 * - 非空文本保留首尾空白与换行，绝不 trim、压缩空白或截断；
 * - 超过 grapheme 上限的文本被丢弃（Host 在写入边界会显式拒绝，这里只保证读取安全）。
 *
 * @param {unknown} value - settings 文档里的 promptOverrides 原始值。
 * @param {readonly string[]} [allowedRoles] - 允许的角色集合；运行期目录由调用方传入，
 *   缺省为内置六角色。
 * @returns {Record<string,string>} 归一后的普通对象（含 0 个键表示无覆盖）。
 */
export function normalizePromptOverrides(value, allowedRoles = STATUS_ROLE_IDS) {
  const result = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
  for (const [role, text] of Object.entries(value)) {
    if (!allowed.has(role)) continue;
    if (typeof text !== "string") continue;
    if (text.trim().length === 0) continue;
    if (countPromptGraphemes(text) > PROMPT_OVERRIDE_MAX_GRAPHEMES) continue;
    result[role] = text;
  }
  return result;
}

/**
 * 读取一个角色的有效自定义覆盖。
 *
 * @param {unknown} value - settings 文档里的 promptOverrides 原始值。
 * @param {string} role - 专家角色 id。
 * @returns {string|undefined} 有效覆盖文本；没有覆盖（或值不合法）时返回 undefined。
 */
export function promptOverrideFor(value, role) {
  if (typeof role !== "string" || role.length === 0) return void 0;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const text = value[role];
  if (typeof text !== "string" || text.trim().length === 0) return void 0;
  return text;
}

/**
 * role id 保持小写用于身份匹配；页面显示只使用注册表提供的英文状态标签。
 * 这里包含可选角色：历史会话或已关闭 Observer 的 child 仍需要正确的状态文案。
 */
export const STATUS_ROLE_LABELS = roleStatusLabels({ enableObserver: true });

/**
 * 归一化插件角色元数据；未知、空值和外部角色都返回 undefined，避免客户端
 * 猜测历史/外部会话的身份。大小写归一只用于可靠匹配，不改变持久化数据。
 * @param {unknown} role - RPC/marker 提供的角色值。
 * @param {readonly string[]} [allowedRoles] - 允许的角色集合；运行期目录（内置 + 自定义）
 *   由 Host 传入，缺省为内置六角色（客户端 bundle 的静态副本与之一致）。
 * @returns {string|undefined} 已验证的英文 role id。
 */
export function normalizeStatusRole(role, allowedRoles = STATUS_ROLE_IDS) {
  if (typeof role !== "string") return void 0;
  const normalized = role.trim().toLowerCase();
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS;
  return allowed.includes(normalized) ? normalized : void 0;
}

/**
 * 判断会话摘要是否明确表示专家 child。只有 parentId 或 DSH 的 subagent origin
 * 存在时才视为 child；普通根会话不会因缺失插件 metadata 而被误判为未知 child。
 * @param {object} [session] - useSessions 当前快照中的 SessionSummary。
 * @returns {boolean} 明确为 child 返回 true。
 */
export function isPluginChildSession(session) {
  return session !== null
    && typeof session === "object"
    && ((typeof session.parentId === "string" && session.parentId.length > 0) || session.origin === "subagent");
}

/**
 * 从插件 RPC 响应中解析与 sessionId 绑定的状态身份。响应没有当前 session 的
 * 身份时直接丢弃；未知 kind 返回 unknown，客户端因此保持原生文案而不猜测 root/child。
 * @param {object} input - 当前请求 sessionId、响应所属 sessionId 与 JSON 响应。
 * @returns {{sessionId:string, kind:"child"|"root"|"unknown", role:string|undefined}|null}
 */
export function resolveStatusIdentity({ sessionId, responseSessionId, response } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const reportedSessionId = response?.sessionId ?? responseSessionId;
  if (reportedSessionId !== sessionId) return null;
  if (response?.ok === false) return { sessionId, kind: "unknown", role: void 0 };
  if (response?.kind === "child") {
    return {
      sessionId,
      kind: "child",
      role: normalizeStatusRole(response?.child?.role),
    };
  }
  if (response?.kind === "root") return { sessionId, kind: "root", role: void 0 };
  return { sessionId, kind: "unknown", role: void 0 };
}
