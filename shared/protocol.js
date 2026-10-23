/**
 * 共享协议常量与角色 deny 组合。
 *
 * RPC 端点、角色列表、deny 组合与注册表投影只在这里定义，Host 工具面、guard 与 RPC 元数据共用同一份规则。
 * 本文件由原 `shared.js` 的 1–164 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/protocol
 */
import { listOptionalRoles, listRoles, roleStatusLabels } from "../role-registry.js";

/** 旧版 Host 的兼容 HTTP 路由（同源、仅 POST JSON）。 */
export const RPC_PATH = "/api/dsh-expert-group";

/** DSH Connection 的独立认证逻辑频道；不能占用 Gateway 独占的 /api interceptor。 */
export const RPC_CHANNEL = "/dsh-expert-group";
export const RPC_ENDPOINT = "rpc";

/** 已启用角色的插件工具名（role-named）；顺序与元数据来自统一角色注册表。 */
export const ROLES = listRoles().filter((role) => role.optional !== true).map((role) => role.id);

/** observer 默认禁用，按配置启用；可选角色同样来自统一角色注册表。 */
export const OPTIONAL_ROLES = listOptionalRoles().map((role) => role.id);

/**
 * 注意：插件不再内置任何角色默认模型——新安装后所有角色为空，
 * 由用户在侧边栏从「设置 → 模型」已配置的模型中自行选择，并通过
 * 「保存」（全局持久）或「应用」（仅当前会话）提交。
 */

/**
 * 所有专家角色（含可写的 designer/fixer）一律禁止的再委派工具。
 * 父代理是唯一编排者：专家是叶子工作者，不得再创建子代理/孙代理，
 * 也不得调用 workflow/ralph/goal 等任何多代理编排能力。
 */
export const EXPERT_DELEGATION_DENY = [
  // 专家只能通过最终 assistant 输出交付结果，禁止主动发送中间 report。
  "report",
  "subagent",
  // Harness 外层入口：专家 child 即使看见这些名字也不得绕过插件。
  "subagent_fork",
  ...listRoles().map((role) => "subagent_" + role.toolName),
  // dsh-expert-group 的唯一插件命名空间：叶子专家不得再次调用。
  // 角色工具名来自注册表：注册表新增角色会自动进入 deny，不会因漏改清单而扩大权限。
  ...listRoles().map((role) => role.toolName),
  "run_code",
  "workflow",
  "ralph",
  "create_goal",
  "update_goal",
  "send_message",
  "interrupt_agent",
  "todo_write",
];

/**
 * 所有专家 child 还需过滤仅属于当前 live root 的工具。此处独立于历史
 * EXPERT_DELEGATION_DENY，避免破坏外部对旧再委派清单的兼容契约。
 */
export const ROOT_ONLY_TOOL_DENY = [
  "dsh_expert_group_finalize",
  "dsh_expert_group_release_scope",
  // 票据 11：人工逃生只属于 root；专家 child 绝不能关闭等待账本。
  "dsh_expert_group_abandon_wait",
];

/**
 * 只读角色（explorer/librarian/oracle/observer）禁止的写操作与命令，
 * 并展开组合覆盖全部 EXPERT_DELEGATION_DENY，保证只读角色同样不能再委派。
 */
export const READONLY_DENY = [
  "write",
  "edit",
  "bash",
  "pwsh",
  ...EXPERT_DELEGATION_DENY,
  ...ROOT_ONLY_TOOL_DENY,
];

/**
 * 单个内置角色的完整 deny 候选。
 *
 * - 只读角色：READONLY_DENY（已含委派与 root-only）；
 * - 可写角色：EXPERT_DELEGATION_DENY + ROOT_ONLY_TOOL_DENY。
 * 未知角色由调用方按只读处理（fail-closed），这里不提供默认分支。
 *
 * @param {object|undefined} entry - 注册表记录。
 * @returns {string[]} 去重后的 deny 候选（仍需按宿主可见性过滤）。
 */
export function expertDenyCandidates(entry) {
  // 未知/缺失记录一律按只读处理（fail-closed）：绝不能因为查询不到角色就给出更宽的集合。
  const base = entry === void 0 || entry === null || entry.readOnly === true
    ? READONLY_DENY
    : [...EXPERT_DELEGATION_DENY, ...ROOT_ONLY_TOOL_DENY];
  return [...new Set(base)];
}

/** 注册表记录 → 显示名映射（冻结副本）。 */
export function roleLabelsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.label;
  }
  return Object.freeze(map);
}

/** 注册表记录 → 状态标签映射（冻结副本，供页面 "Xxx running" 文案）。 */
export function roleStatusLabelsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.statusLabel;
  }
  return Object.freeze(map);
}

/** 注册表记录 → 职责描述映射（冻结副本）。 */
export function roleDescriptionsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.description;
  }
  return Object.freeze(map);
}

/**
 * PTC 的 run_code 是展示传输，不是可交给 tools.restrict() 的全局工具。
 * 过滤器保留静态 deny 清单的完整性，同时只返回当前视图中真正可限制的名称。
 * @param {string[]} denyList - 静态候选 deny 工具名。
 * @param {(name: string) => boolean} isVisible - 当前父代理视图可见性判断。
 * @returns {string[]} 去重后的可限制工具名。
 */
/**
 * 将当前父代理可见的动态 MCP 工具并入只读 deny 候选。
 * MCP 工具名由宿主动态提供，静态清单无法覆盖；缺少公开 schema 时不猜测
 * 其读写语义，调用方应保持 fail-closed（至少拒绝 mcp__ 前缀工具）。
 * @param {string[]} denyList - 静态 deny 候选。
 * @param {unknown[]} visibleSchemas - tools.schemas(parent) 返回的当前视图。
 * @returns {string[]} 合并并去重后的 deny 候选。
 */
export function isReadonlyDynamicMcpName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

export function readonlyDenyCandidates(denyList, visibleSchemas) {
  const candidates = Array.isArray(denyList) ? denyList.slice() : [];
  if (!Array.isArray(visibleSchemas)) return candidates;
  for (const schema of visibleSchemas) {
    const name = schema?.name;
    if (isReadonlyDynamicMcpName(name)) candidates.push(name);
  }
  return candidates;
}

export function restrictableDenyNames(denyList, isVisible) {
  if (!Array.isArray(denyList) || typeof isVisible !== "function") return [];
  const result = [];
  const seen = new Set();
  for (const name of denyList) {
    if (name === "run_code" || seen.has(name) || !isVisible(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}
