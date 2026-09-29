/**
 * 统一角色注册表：插件角色元数据的唯一来源。
 *
 * 设计约束（与任务书 02 一致）：
 * - 记录覆盖角色 id、显示名（label）、职责（description）、可选性（optional）、
 *   只读性（readOnly）、默认配置（defaultSelection）与工具名（toolName）。
 * - 只读性必须显式声明：缺失或非法一律 fail-closed 抛错，绝不把未声明角色当可写。
 * - v0.2.4 起不内置角色模型默认值，defaultSelection 固定为 null；非 null 视为注册数据错误。
 * - 返回的记录与数组全部冻结；调用方修改不会污染注册表内部状态。
 * - 本模块无任何 import，纯数据 + 纯函数，可被 Host、shared 与双面 bundle 复用。
 */

/** 注册数据错误的稳定错误类型；调用方可用 code 精确分支。 */
export class RoleRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoleRegistryError";
    this.code = code;
    Object.assign(this, details);
  }
}

const RECORD_FIELDS = Object.freeze(["id", "label", "statusLabel", "description", "optional", "readOnly", "defaultSelection", "toolName"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 深冻结注册数据，保证返回的嵌套值也不能被调用方改写。 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function normalizeText(value, field, id) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RoleRegistryError("INVALID_ROLE_RECORD", "角色记录字段 " + field + " 必须是非空字符串", { role: id, field });
  }
  return value;
}

function normalizeFlag(value, field, id) {
  if (typeof value !== "boolean") {
    // 只读性缺失/非法时 fail-closed：宁可拒绝注册，也不默认给出更宽权限。
    throw new RoleRegistryError("INVALID_ROLE_RECORD", "角色记录字段 " + field + " 必须是布尔值（不得缺省）", { role: id, field });
  }
  return value;
}

/** 校验并冻结单条角色记录；缺字段、类型错误或非法默认配置都显式失败。 */
function normalizeRecord(input) {
  if (!isPlainObject(input)) {
    throw new RoleRegistryError("INVALID_ROLE_RECORD", "角色记录必须是普通对象");
  }
  for (const field of RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) {
      throw new RoleRegistryError("INVALID_ROLE_RECORD", "角色记录缺少字段 " + field, { role: input.id, field });
    }
  }
  const id = normalizeText(input.id, "id", input.id);
  const label = normalizeText(input.label, "label", id);
  // statusLabel 是页面运行状态文案使用的英文标签（"Explorer running..."），与中文
  // 显示名分离；浏览器 bundle 无法 import 本模块，因此这里是唯一权威来源。
  const statusLabel = normalizeText(input.statusLabel, "statusLabel", id);
  const description = normalizeText(input.description, "description", id);
  const toolName = normalizeText(input.toolName, "toolName", id);
  const optional = normalizeFlag(input.optional, "optional", id);
  const readOnly = normalizeFlag(input.readOnly, "readOnly", id);
  if (input.defaultSelection !== null) {
    throw new RoleRegistryError(
      "INVALID_ROLE_RECORD",
      "角色记录 defaultSelection 必须为 null（v0.2.4 起不内置角色模型默认值）",
      { role: id, field: "defaultSelection" },
    );
  }
  return Object.freeze({ id, label, statusLabel, description, optional, readOnly, defaultSelection: null, toolName });
}

/** 是否按当前配置启用：默认角色恒启用；可选角色只在显式启用时进入投影。 */
function isEnabled(entry, options) {
  if (entry.optional !== true) return true;
  if (options?.enableObserver === true && entry.id === "observer") return true;
  if (Array.isArray(options?.enableOptional) && options.enableOptional.includes(entry.id)) return true;
  return false;
}

/**
 * 建立只读注册表。
 * @param {object[]} records - 按期望顺序排列的角色记录。
 * @returns {object} 冻结的注册表；所有返回值都是冻结快照。
 */
export function createRoleRegistry(records) {
  if (!Array.isArray(records)) {
    throw new RoleRegistryError("INVALID_ROLE_REGISTRY", "角色注册表需要记录数组");
  }
  const ordered = [];
  const byId = new Map();
  for (const input of records) {
    const entry = normalizeRecord(input);
    if (byId.has(entry.id)) {
      throw new RoleRegistryError("DUPLICATE_ROLE_ID", "角色 id 重复: " + entry.id, { role: entry.id });
    }
    byId.set(entry.id, entry);
    ordered.push(entry);
  }
  const allRecords = Object.freeze(ordered.slice());
  const allIds = Object.freeze(ordered.map((entry) => entry.id));
  const optionalRecords = Object.freeze(ordered.filter((entry) => entry.optional === true).slice());
  const optionalIds = Object.freeze(optionalRecords.map((entry) => entry.id));
  const readOnlyAllIds = Object.freeze(ordered.filter((entry) => entry.readOnly === true).map((entry) => entry.id));
  const enabledCache = new Map();

  function enabledEntries(options) {
    const key = options?.enableObserver === true ? "observer" : Array.isArray(options?.enableOptional) ? options.enableOptional.join(",") : "";
    if (enabledCache.has(key)) return enabledCache.get(key);
    const selected = Object.freeze(ordered.filter((entry) => isEnabled(entry, options)).slice());
    enabledCache.set(key, selected);
    return selected;
  }

  const registry = {
    /** 注册表声明的角色总数。 */
    get size() { return allIds.length; },
    /** 未知、空值与非字符串一律返回 false，不做大小写猜测。 */
    has(id) { return typeof id === "string" && byId.has(id); },
    /** 未知角色返回 undefined（查询契约，不抛错）。 */
    get(id) { return typeof id === "string" ? byId.get(id) : undefined; },
    /** 未知角色抛 RoleRegistryError("UNKNOWN_ROLE")（必需读取契约，fail-closed）。 */
    require(id) {
      const entry = registry.get(id);
      if (entry === undefined) {
        throw new RoleRegistryError("UNKNOWN_ROLE", "未知角色: " + String(id), { role: id });
      }
      return entry;
    },
    /** 全部声明角色 id（含可选角色），顺序稳定。 */
    ids() { return allIds; },
    /** 全部声明角色记录（含可选角色），顺序稳定。 */
    records() { return allRecords; },
    /** 可选角色 id。 */
    optionalIds() { return optionalIds; },
    /** 可选角色记录。 */
    optionalRecords() { return optionalRecords; },
    /** 按配置启用的角色 id。 */
    enabledIds(options) { return Object.freeze(enabledEntries(options).map((entry) => entry.id)); },
    /** 按配置启用的角色记录。 */
    enabledRecords(options) { return enabledEntries(options); },
    /** 按配置启用的只读角色记录。 */
    readOnlyRecords(options) { return Object.freeze(enabledEntries(options).filter((entry) => entry.readOnly === true).slice()); },
    /** 按配置启用的只读角色 id。 */
    readOnlyIds(options) { return Object.freeze(registry.readOnlyRecords(options).map((entry) => entry.id)); },
    /** 全部声明角色中的只读角色 id（与启用配置无关，供权限判定使用）。 */
    declaredReadOnlyIds() { return readOnlyAllIds; },
    /** 按配置启用的角色英文状态标签映射（冻结副本）。 */
    statusLabels(options) {
      const map = {};
      for (const entry of enabledEntries(options)) map[entry.id] = entry.statusLabel;
      return Object.freeze(map);
    },
    /** 按配置启用的角色描述映射（冻结副本）。 */
    descriptions(options) {
      const map = {};
      for (const entry of enabledEntries(options)) map[entry.id] = entry.description;
      return Object.freeze(map);
    },
    /** 按配置启用的角色工具名（与角色 id 一致，顺序稳定）。 */
    toolNames(options) { return Object.freeze(enabledEntries(options).map((entry) => entry.toolName)); },
  };
  return Object.freeze(registry);
}

/**
 * 内置角色注册表。
 * 顺序与历史 ROLES/OPTIONAL_ROLES 完全一致：explorer、librarian、oracle、
 * designer、fixer 为默认角色，observer 为可选角色且默认禁用。
 * 只读角色为 explorer、librarian、oracle、observer（与历史 readOnly 判定一致）。
 */
export const ROLE_REGISTRY = createRoleRegistry([
  {
    id: "explorer",
    statusLabel: "Explorer",
    label: "侦察员 (Explorer)",
    description: "只读代码库侦察：定位文件、符号与模式，输出压缩的事实报告。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "explorer",
  },
  {
    id: "librarian",
    statusLabel: "Librarian",
    label: "资料员 (Librarian)",
    description: "只读外部文档调研：查证库 API 与上游真实用法，输出带来源的结论。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "librarian",
  },
  {
    id: "oracle",
    statusLabel: "Oracle",
    label: "先知 (Oracle)",
    description: "只读架构与调试顾问：分析架构取舍、疑难缺陷与代码审查。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "oracle",
  },
  {
    id: "designer",
    statusLabel: "Designer",
    label: "设计师 (Designer)",
    description: "UI/UX 与视觉实现专家：产出可访问、打磨过的界面实现。",
    optional: false,
    readOnly: false,
    defaultSelection: null,
    toolName: "designer",
  },
  {
    id: "fixer",
    statusLabel: "Fixer",
    label: "修理工 (Fixer)",
    description: "边界清晰的多文件实现与测试补齐：只实现，不重新调研或设计。",
    optional: false,
    readOnly: false,
    defaultSelection: null,
    toolName: "fixer",
  },
  {
    id: "observer",
    statusLabel: "Observer",
    label: "观察员 (Observer)",
    description: "只读视觉分析：分析图片、截图、图表、图示与 PDF，输出结构化视觉报告。",
    optional: true,
    readOnly: true,
    defaultSelection: null,
    toolName: "observer",
  },
]);

/** 全部声明角色记录（含可选角色）。 */
export function listRoles() {
  return ROLE_REGISTRY.records();
}

/** 按配置启用的角色记录；默认只含默认角色。 */
export function listEnabledRoles(options) {
  return ROLE_REGISTRY.enabledRecords(options);
}

/** 可选角色记录。 */
export function listOptionalRoles() {
  return ROLE_REGISTRY.optionalRecords();
}

/** 按配置启用的只读角色记录。 */
export function listReadOnlyRoles(options) {
  return ROLE_REGISTRY.readOnlyRecords(options);
}

/** 按配置启用的角色英文状态标签映射（页面 "Xxx running..." 文案）。 */
export function roleStatusLabels(options) {
  return ROLE_REGISTRY.statusLabels(options);
}

/** 按配置启用的角色职责映射。 */
export function roleDescriptions(options) {
  return ROLE_REGISTRY.descriptions(options);
}

/** 按配置启用的角色工具名。 */
export function roleToolNames(options) {
  return ROLE_REGISTRY.toolNames(options);
}

/** 查询角色记录；未知角色返回 undefined。 */
export function getRole(id) {
  return ROLE_REGISTRY.get(id);
}

/** 读取角色记录；未知角色抛 RoleRegistryError("UNKNOWN_ROLE")。 */
export function requireRole(id) {
  return ROLE_REGISTRY.require(id);
}
