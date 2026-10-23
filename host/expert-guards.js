/**
 * 组合根顶层的第 S7 段（R1 票据 06）：自 index.js 第 856–1196 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { ROLE_REGISTRY } from "../role-registry.js";
import { PROMPT_OVERRIDE_MAX_GRAPHEMES } from "../shared/prompts.js";
import {
  READONLY_DENY,
  EXPERT_DELEGATION_DENY,
  ROOT_ONLY_TOOL_DENY,
  isReadonlyDynamicMcpName,
} from "../shared/protocol.js";

/**
 * 给专家 child 的工具过滤补上 scope-local send_message。它不能只走
 * effectiveDeny/tools.restrict，因为该工具不一定出现在父代理的全局工具视图中。
 * @param {object|undefined} toolFilter - 已计算的工具过滤。
 * @returns {string[]} 保留已有 deny 并保证隐藏 send_message。
 */
export function ensureExpertSendMessageDenied(toolFilter) {
  const existing = Array.isArray(toolFilter)
    ? toolFilter
    : Array.isArray(toolFilter?.deny) ? toolFilter.deny : [];
  return [...new Set([...existing, "send_message"])];
}

/**
 * 当前生效的角色目录：内置六角色注册表（模块常量）。
 *
 * 自定义角色能力已删除，角色集合不再随设置变化；模块级 guard 与身份判定
 * （它们不持有 apply 闭包）仍统一读这一份目录，未知角色按 fail-closed 处理。
 */
function currentRoleCatalog() {
  return ROLE_REGISTRY;
}

/** 角色记录查询；未知角色返回 undefined。 */
export function roleCatalogEntry(role) {
  return currentRoleCatalog().get(role);
}

/** 子代理 child.options 上携带的推理深度 marker，避免依赖未公开的 AgentOptions.reasoningEffort。 */
export const EFFORT_MARKER = "__degExpertEffort";

/** 子代理 child.options 上携带的角色 marker：用于按 parentId+role+route 恢复可复用 child。 */
export const ROLE_MARKER = "__degExpertRole";

/** 子代理 child.options 上携带的父代理 marker：记录创建它的父代理 session id。 */
export const PARENT_MARKER = "__degExpertParent";

/** 子代理 child.options 上携带的 continuable 标记：所有专家委派
 *  统一走可续接（continuable）子代理，无条件写入 true；agent/created 据此
 *  持久化，重启恢复只接受带本标记的 child（旧版 one-shot 与无标记记录
 *  不可 steer，恢复时忽略）。 */
export const CONTINUABLE_MARKER = "__degExpertContinuable";

/** 子代理 child.options 上携带 admission 时计算出的完整 deny 清单，供 RC1 runtime guard 使用。 */
export const DENY_MARKER = "__degExpertDeny";

/**
 * 子代理 child.options 上携带 admission 时解析出的完整 persona（专家专属部分 + 固定纪律）。
 *
 * 与 deny marker 同源同形：Host recovery 不持久化 RC1 agentOptions，因此该值会随
 * child_models 快照一起落盘，供冷恢复的 composition 兜底重建系统提示词——那时 settings
 * 覆盖可能已经被改过，既有 child 必须继续使用它创建时的人格。它只是内部快照，
 * 绝不进入任务 prompt，也不出现在任何用户可见文案里。
 */
export const PERSONA_MARKER = "__degExpertPersona";

/**
 * persona marker 的长度上限（UTF-16 code unit）。
 *
 * 自定义专家提示词的写入上限是 PROMPT_OVERRIDE_MAX_GRAPHEMES（grapheme 口径），固定执行
 * 纪律再由 resolveExpertPersona 追加一次；grapheme 与 code unit 不是 1:1（星平面字符占
 * 2 个 code unit），因此按 2 倍上限再加纪律余量。marker 是 durable 快照，超限一律视为
 * malformed 并回退到当前 admission 解析，不让异常逃逸到 child 创建路径。
 */
export const MAX_EXPERT_PERSONA_MARKER_CHARS = PROMPT_OVERRIDE_MAX_GRAPHEMES * 2 + 2048;

/**
 * 校验 persona marker 的形状。
 *
 * 快照可能来自旧版本、被外部改写的 durable 数据或第三方写入，因此只接受明确合法的
 * 非空字符串；其余（undefined/null/数字/对象/超限字符串）一律返回 undefined，
 * 让调用方回退到 recorded 快照或当前 admission 解析，而不是把任意值注册成系统提示词。
 *
 * @param {unknown} value - 待校验的 marker 值。
 * @returns {string|undefined} 合法 persona 文本；不合法时 undefined。
 */
export function validPersonaMarker(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_EXPERT_PERSONA_MARKER_CHARS
    ? value
    : void 0;
}

/**
 * 角色是否是内置目录里的专家角色。
 *
 * 这里不会把未知角色当成专家（避免为无关 child 安装 guard）。
 */
export function isRegisteredExpertRole(role) {
  return typeof role === "string" && role.length > 0 && currentRoleCatalog().has(role);
}

/**
 * 持久化 child_models 记录上的插件 admission 证据。
 *
 * 用途：历史 child 的冷恢复无法再从当前目录重建人格/deny 边界时，只有**插件写入**的
 * deny/persona 快照才能作为证据（live marker 上的任意 role 字符串不算），因此
 * spoof metadata 仍然无效。
 *
 * @param {unknown} record - child_models 快照记录。
 * @returns {boolean} 该记录是否带有 DEG admission 写入的边界快照。
 */
export function hasPluginAdmissionProof(record) {
  return record !== null
    && typeof record === "object"
    && (Array.isArray(record[DENY_MARKER]) || validPersonaMarker(record[PERSONA_MARKER]) !== void 0);
}
const EXPERT_REPORT_GUARD_REASON = "插件专家 child 不允许调用 report；请在最终 assistant 输出中按五个固定标题交付结果。";
const EXPERT_SEND_MESSAGE_GUARD_REASON = "插件专家 child 不允许调用 send_message；最终结果由 DSH subagent-settled 自动交付，请仅在最终 assistant 输出中按五个固定标题交付结果。";

// 全局 guard 只信任插件在实际 acceptance/agent 生命周期中登记的 Agent 对象。
// marker、parentSession 和 origin 都是 Host 可复制的 metadata，不能单独证明 child 来自本插件。
const registeredPluginExpertChildren = new WeakSet();
export function registerPluginExpertChildAgent(agent) {
  if (agent !== null && (typeof agent === "object" || typeof agent === "function")) registeredPluginExpertChildren.add(agent);
}
export function isRegisteredPluginExpertChild(agent) {
  return agent !== null
    && (typeof agent === "object" || typeof agent === "function")
    && registeredPluginExpertChildren.has(agent);
}

export function isPluginExpertChildOptions(options) {
  const role = options?.[ROLE_MARKER];
  const parentId = options?.[PARENT_MARKER];
  return typeof role === "string"
    && isRegisteredExpertRole(role)
    && typeof parentId === "string"
    && parentId.length > 0;
}

function isPluginExpertChildRecord(record) {
  return record !== null
    && typeof record === "object"
    && !Array.isArray(record)
    && typeof record.role === "string"
    // 角色仍在内置目录，或记录带有插件 admission 写入的 deny/persona 快照
    // （冷恢复路径）。两者都不满足时不是插件专家身份。
    && (isRegisteredExpertRole(record.role) || hasPluginAdmissionProof(record))
    && typeof record.parentId === "string"
    && record.parentId.length > 0
    && record.continuable === true;
}

/**
 * 解析 setup 当下的插件专家身份：新建/重建优先使用 marker，cold-resume
 * 的 child.options 只有 provider/model 时按精确 child id 读取当前快照。
 * marker 只要出现但不完整就保守回退，不用快照猜测，避免 stale 记录误判。
 */
export function resolveExpertReportIdentity(options, childId, readChildModel) {
  if (isPluginExpertChildOptions(options)) {
    return { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER], source: "marker" };
  }
  const markerPresent = options?.[ROLE_MARKER] !== void 0 || options?.[PARENT_MARKER] !== void 0;
  if (markerPresent || typeof childId !== "string" || childId.length === 0 || typeof readChildModel !== "function") return void 0;
  let record;
  try {
    record = readChildModel(childId);
  } catch {
    return void 0;
  }
  if (!isPluginExpertChildRecord(record)) return void 0;
  return {
    role: record.role,
    parentId: record.parentId,
    source: "snapshot",
    // 冷恢复：记录里的 deny/persona 快照证明它曾通过 DEG admission。
    // 只有 true 才写入，保持既有身份形状（历史测试逐键断言）。
    ...(hasPluginAdmissionProof(record) ? { admissionProof: true } : {}),
  };
}

export function isPluginExpertChildIdentity(identity) {
  // admissionProof 只由插件写入的快照派生（见 resolveExpertReportIdentity），
  // live marker 上的任意 role 字符串仍然必须命中运行期目录。
  return identity !== null
    && typeof identity === "object"
    && (isRegisteredExpertRole(identity.role) || identity.admissionProof === true)
    && typeof identity.parentId === "string"
    && identity.parentId.length > 0;
}

/** 返回 report 硬防线的拒绝理由；供契约测试验证 marker 与快照身份边界。 */
export function shouldBlockExpertReport(options, execution, identity) {
  const resolved = identity ?? (isPluginExpertChildOptions(options)
    ? { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER] }
    : void 0);
  if (!isPluginExpertChildIdentity(resolved) || execution?.name !== "report") return void 0;
  return EXPERT_REPORT_GUARD_REASON;
}

/** 插件专家 child 只能由 DSH 自动 subagent-settled 交付，禁止 scope-local send_message。 */
export function shouldBlockExpertSendMessage(options, execution, identity) {
  const resolved = identity ?? (isPluginExpertChildOptions(options)
    ? { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER] }
    : void 0);
  if (!isPluginExpertChildIdentity(resolved) || execution?.name !== "send_message") return void 0;
  return EXPERT_SEND_MESSAGE_GUARD_REASON;
}

/**
 * 恢复重建 child 时的 persona 选择（纯函数，导出供契约测试）。
 *
 * 设计约束（票据 27）：
 * - 角色仍在运行期目录：与历史行为一致，使用**当前** admission 解析结果——恢复是新建
 *   child 的一条路径，不能跳过用户覆盖与固定纪律的分层；
 * - 角色已被删除（不在目录）：使用 child 创建时持久化的 persona 快照，保住人格，绝不
 *   因为角色消失而变成未知角色或通用人格；
 * - 两者都没有：返回 undefined，调用方必须 fail-closed（未注册角色连默认 persona 都没有，
 *   重建出来的 child 会失去全部角色约束）。
 *
 * @param {object} input
 * @param {boolean} input.roleKnown - 角色是否仍在运行期目录。
 * @param {string|undefined} input.currentPersona - 当前 admission 解析结果（含固定纪律）。
 * @param {string|undefined} input.recordedPersona - child 创建时持久化的 persona 快照。
 * @returns {string|undefined} 重建使用的 persona；不可证明时 undefined。
 */
export function resolveRecoveryPersona({ roleKnown, currentPersona, recordedPersona } = {}) {
  const recorded = typeof recordedPersona === "string" && recordedPersona.length > 0 ? recordedPersona : void 0;
  if (roleKnown === true) {
    return typeof currentPersona === "string" && currentPersona.length > 0 ? currentPersona : recorded;
  }
  return recorded;
}

export const MAX_EXPERT_DENY_MARKER_ENTRIES = 512;

/**
 * 解析 child 的完整工具 deny 边界。RC1 会把 request.toolFilter 交给 child composition
 * 执行一次 tools.restrict，但那份 request 不是 DEG 的持久化事实来源（宿主不还原
 * cold-resume 的 request.toolFilter），所以运行期 guard 与冷恢复一律以 admission marker
 * 为权威快照；没有 marker 的旧恢复记录则按角色静态清单兜底，未知角色按只读处理，
 * 避免历史数据缺字段时意外扩大权限。
 *
 * marker 是 admission 时的可见性快照，但静态策略候选仍要在 runtime guard 中合并：
 * parent 的工具视图可能在 child 生命周期内变化，不能因当时不可见而漏拦新增可见的
 * report/delegation/root-only 工具。run_code 是 Code Mode 展示传输，保持既有放行语义。
 */
export function expertGuardDenyNames(options, identity) {
  // 只读性来自内置角色目录；未知角色按只读处理（fail-closed）。
  const roleEntry = roleCatalogEntry(identity?.role);
  const fallback = roleEntry === void 0 || roleEntry.readOnly === true
    ? READONLY_DENY
    : [...EXPERT_DELEGATION_DENY, ...ROOT_ONLY_TOOL_DENY];
  const denyNames = new Set(ensureExpertSendMessageDenied([...fallback]).filter((name) => name !== "run_code"));
  const marked = options?.[DENY_MARKER];
  if (marked === void 0) return denyNames;
  const policyNames = new Set([
    ...EXPERT_DELEGATION_DENY,
    ...ROOT_ONLY_TOOL_DENY,
    ...READONLY_DENY,
    "send_message",
  ]);
  if (!Array.isArray(marked) || marked.length === 0 || marked.length > MAX_EXPERT_DENY_MARKER_ENTRIES) return void 0;
  // 历史 child 的 marker 可能携带 admission 时的 deny 快照：只接受带 admission 证据的身份
  // （插件写入的 deny/persona 快照），并且仍然只**追加** deny —— 多一个拒绝名称不会放大权限，
  // 缺少名称也不会绕过下面的静态 fallback。
  const trustedMarker = identity?.admissionProof === true;
  for (const name of marked) {
    // 动态 MCP 名称由 readonly admission 的 schema 快照产生；其余名称必须属于
    // DEG 已知策略，避免任意未知字符串伪造“合法 marker”并绕过形状审查。
    if (typeof name !== "string" || name.length === 0 || name === "run_code"
      || (!policyNames.has(name) && !isReadonlyDynamicMcpName(name) && trustedMarker !== true)) return void 0;
    denyNames.add(name);
  }
  return denyNames;
}

/** deny marker 只在已认证的插件专家 child 上生效，普通 Agent 不受影响。 */
export function shouldBlockExpertDeniedTool(options, execution, identity) {
  if (!isPluginExpertChildIdentity(identity) || typeof execution?.name !== "string") return void 0;
  const denyNames = expertGuardDenyNames(options, identity);
  if (denyNames === void 0) return "插件专家 child deny marker 无效，已拒绝工具调用";
  if (!denyNames.has(execution.name)) return void 0;
  return `插件专家 child 禁止调用工具 ${execution.name}`;
}

/** DSH 的 deployment persona 前缀 section 名：与宿主 applyChildOverrides 同名才能让 scoped 注册遮蔽全局同名项。 */
export const EXPERT_PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
/** DSH SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX 的固定排序值；宿主缺 getSectionOrder 时用它兜底。 */
export const EXPERT_PERSONA_PREFIX_ORDER = 0;

/** 稳定提取 error 文案：日志只接受字符串，避免把任意值拼进告警。 */
export function compositionErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 读取宿主 scope 视图里「可以交给 tools.restrict()」的名称集合。
 *
 * dsh-tools 的 restrict() 只接受 `view(scope).restrictableNames`：它由全局层与祖先层构成，
 * own 层注册不进入该集合（own 层天然豁免于 restriction）。因此这既是 restrict() 的准入判据，
 * 也是「哪些名字交给 restrict 不会让整次调用抛错」的唯一权威来源；注意同名工具可以同时存在于
 * inherited 与 own 两层（例如全局 send_message 与 child 自己的遮蔽定义）。
 * scope 形如 child Agent / 父 Agent（宿主自己就用 `chainLayers(exec.agent)`）；
 * 传 undefined 表示无作用域的全局视图。宿主没有 view() 或返回形状不符时返回 undefined，
 * 让调用方回退到可见性探针。
 *
 * @param {object} toolService - 宿主 tools 服务。
 * @param {object} [scope] - 视图作用域（Agent 对象）；undefined 表示全局视图。
 * @returns {Set<string>|undefined} 可 restrict 名称集合；不可用时 undefined。
 */
export function restrictableScopeNames(toolService, scope) {
  try {
    if (typeof toolService?.view !== "function") return void 0;
    const names = toolService.view(scope)?.restrictableNames;
    return names !== void 0 && names !== null && typeof names.has === "function" ? names : void 0;
  } catch {
    // view() 不可用（宿主版本差异、替身形状不符）只代表判据缺失，不能让 composition 失败。
    return void 0;
  }
}

/**
 * 把 deny 候选收窄为宿主 tools.restrict() 会接受的名称。
 *
 * 优先使用 scope 视图的 restrictableNames（与 restrict() 内部同一判据：全局层 + 祖先层，
 * 含 agent preset 落在祖先层的工具名）；拿不到该 API 时回退到可见性探针（无作用域的
 * tools.get 只看全局层）。两条路径都必须排除 run_code：它是 Code Mode 展示传输，
 * 既不是可 restrict 的工具，restrict() 也会直接拒绝。
 *
 * 为什么必须用宿主自己的判据：探针只回答「当前解析到某个定义」，不回答「能否 restrict」。
 * 凡不在 restrictableNames 里的名字交给 restrict() 都会让**整次** restriction 抛错，
 * 连带丢掉 report 等真实 deny；反之被过滤掉的名称继续由既有执行期防线覆盖
 * （expertGuardDenyNames + shouldBlockExpertDeniedTool / shouldBlockExpertSendMessage），
 * cold-resume 也按同一份 marker/快照恢复同一边界，因此「schema 未隐藏」只是降级，不是权限缺口。
 *
 * @param {string[]} names - admission 的完整 deny 清单。
 * @param {Set<string>|undefined} restrictableNames - 宿主作用域视图的可 restrict 名称。
 * @param {Function} [isVisible] - 没有 restrictableNames 时的可见性探针。
 * @returns {string[]} 可以安全交给 tools.restrict 的名称。
 */
export function restrictableDenyNamesInScope(names, restrictableNames, isVisible) {
  const candidates = names.filter((name) => name !== "run_code");
  if (restrictableNames !== void 0) return candidates.filter((name) => restrictableNames.has(name));
  if (typeof isVisible !== "function") return candidates;
  // 只保留探针明确报告 true 的名称：false 与探针异常同样按"不可 restrict"处理。
  return candidates.filter((name) => {
    try { return isVisible(name) === true; } catch { return false; }
  });
}

