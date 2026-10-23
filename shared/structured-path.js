/**
 * 结构化工具路径 guard 与委派键。
 *
 * root 结构化文件工具的活动范围拦截、委派 task/scope 键，以及 durable session 同一性判定。
 * 本文件由原 `shared.js` 的 711–832 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/structured-path
 */
import { affectedPathEntriesOverlap, normalizeAffectedPathsForWorkspace } from "./affected-paths.js";

/**
 * 判断 cold-resume 前后的 Session 是否仍是同一个 durable child。DSH 会为新
 * Activation 创建不同的 Session/Agent 对象，因此不能使用对象引用；同时要求
 * durable id 与当前 child id 一致，避免错误 record 被复用。
 */
export function sameDurableSessionId(left, right, childId) {
  try {
    return typeof left?.id === "string" && left.id.length > 0
      && typeof right?.id === "string" && right.id.length > 0
      && left.id === right.id
      && (childId === void 0 || left.id === childId);
  } catch {
    return false;
  }
}


/**
 * 从结构化 ToolExecution 读取 root 文件操作目标。DSH PTC 的每个结构化
 * 内层 dispatch 同样经过工具 guard，并直接呈现内层 name/arguments；因此这里只
 * 读取已解析的 arguments.file_path/path，绝不解析 PTC transport、bash 或 pwsh 文本。
 * @param {object} [execution] - ToolExecution 或结构化内层执行对象。
 * @returns {{toolName:string, path:string|null, workspaceWide:boolean}|undefined}
 */
export function structuredToolTarget(execution) {
  const toolName = execution?.name;
  if (!["read", "edit", "write", "glob", "grep"].includes(toolName)) return void 0;
  const args = execution?.arguments;
  const field = toolName === "glob" || toolName === "grep" ? "path" : "file_path";
  const value = args !== null && typeof args === "object" && typeof args[field] === "string"
    ? args[field].trim()
    : "";
  if (value.length > 0) return { toolName, path: value, workspaceWide: false };
  if (toolName === "glob" || toolName === "grep") return { toolName, path: null, workspaceWide: true };
  return void 0;
}

function activeTaskPathsForGuard(task, workspaceRoot) {
  if (!Array.isArray(task?.affectedPaths)) return [];
  return normalizeAffectedPathsForWorkspace(task.affectedPaths, workspaceRoot);
}

function activeTaskGuardLabel(task) {
  const role = typeof task?.role === "string" && task.role.length > 0 ? task.role : "unknown role";
  const description = typeof task?.description === "string" && task.description.length > 0
    ? task.description
    : typeof task?.taskKey === "string" && task.taskKey.length > 0 ? task.taskKey : "unnamed task";
  return role + " (" + description + ")";
}

/**
 * 检查 root 自身结构化文件操作是否会碰到活动专家范围。
 * 返回值遵循 tools.guard 的约定：字符串表示拒绝，undefined 表示放行。
 * - 任一活动任务没有 affectedPaths 时先拒绝，避免把未知范围误当作安全；
 * - glob/grep 无 path 视为 workspace-wide 未知范围；
 * - 明确路径只比较 normalizeAffectedPaths 与活动范围的交集；
 * - rootAgentId 与 execution.agent.id 不一致时直接放行，防止 root guard 影响 child。
 * @param {object} [execution] - 当前 ToolExecution（也可能是 PTC transport 内层执行）。
 * @param {Array} [activeTasks] - 当前 root 的 tracker.listActiveTasks 快照。
 * @param {string} [rootAgentId] - 安装 guard 的 root session id。
 * @param {string|object} [workspaceRootOrOptions] - 稳定 workspace root；也接受
 *   {workspaceRoot} 选项以便调用方显式传参。
 * @returns {string|undefined} 拒绝原因或 undefined。
 */
export function rootStructuredPathGuard(execution, activeTasks, rootAgentId, workspaceRootOrOptions) {
  const workspaceRoot = typeof workspaceRootOrOptions === "string"
    ? workspaceRootOrOptions
    : workspaceRootOrOptions?.workspaceRoot;
  if (typeof rootAgentId === "string" && execution?.agent?.id !== rootAgentId) return void 0;
  const target = structuredToolTarget(execution);
  if (target === void 0) return void 0;
  const tasks = Array.isArray(activeTasks) ? activeTasks : [];
  if (tasks.length === 0) return void 0;
  const missing = tasks.filter((task) => activeTaskPathsForGuard(task, workspaceRoot).length === 0);
  if (missing.length > 0) {
    const labels = missing.map(activeTaskGuardLabel).join(", ");
    return "Root structured file operation cannot safely continue because affectedPaths is missing for active expert task(s): " + labels + ".";
  }
  if (target.workspaceWide) {
    const labels = tasks.map(activeTaskGuardLabel).join(", ");
    return "Root structured file operation cannot safely continue because " + target.toolName + " has an unknown/workspace-wide path that may overlap active expert task(s): " + labels + ".";
  }
  const targetPaths = normalizeAffectedPathsForWorkspace([target.path], workspaceRoot);
  const conflicts = [];
  for (const task of tasks) {
    const activePaths = activeTaskPathsForGuard(task, workspaceRoot);
    const overlaps = [];
    for (const incoming of targetPaths) {
      for (const active of activePaths) {
        if (affectedPathEntriesOverlap(incoming, active)) overlaps.push({ incoming, active });
      }
    }
    if (overlaps.length > 0) conflicts.push({ task, overlaps });
  }
  if (conflicts.length === 0) return void 0;
  const details = conflicts.map(({ task, overlaps }) =>
    activeTaskGuardLabel(task) + " (" + overlaps.map(({ incoming, active }) => incoming.value + " <-> " + active.value).join(", ") + ")",
  ).join("; ");
  return "Root structured file operation " + target.toolName + " on " + target.path + " is blocked because it overlaps active expert work: " + details + ".";
}

/**
 * 把一次委派的 prompt 文本归一化为稳定的任务 key：
 * NFKC（全角→半角）→ trim → 连续空白折叠为单个空格 → 英文小写。
 * 归一化后完全相同的任务会被识别为重复，触发「复用」而不是重复启动。
 */
export function delegationTaskKey(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * 同一父代理 + 同一角色的临界区/复用 scope key。
 * parentId 是 session id（UUID），role 是英文字母，用 "::" 分隔不会冲突。
 */
export function delegationScopeKey(parentId, role) {
  return `${String(parentId)}::${String(role)}`;
}
