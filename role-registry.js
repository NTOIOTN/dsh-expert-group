/**
 * 统一角色注册表：插件角色元数据的唯一来源。
 *
 * 设计约束（与任务书 02 一致）：
 * - 记录覆盖角色 id、显示名（label）、职责（description）、可选性（optional）、
 *   只读性（readOnly）、默认配置（defaultSelection）与工具名（toolName）。
 * - 只读性必须显式声明：缺失或非法一律 fail-closed 抛错，绝不把未声明角色当可写。
 * - 不内置角色模型默认值，defaultSelection 固定为 null；非 null 视为注册数据错误。
 * - 返回的记录与数组全部冻结；调用方修改不会污染注册表内部状态。
 * - 本模块无任何 import，纯数据 + 纯函数，可被 Host、shared 与双面 bundle 复用。
 *
 * 自定义角色（票据 27）：
 * - 自定义角色不是第二套实现：它们先被归一成与内置角色**同形**的记录，再走
 *   createRoleRegistry 的同一条校验与冻结路径，因此权限、工具 deny、persona、
 *   模型解析与恢复语义全部与内置角色同源。
 * - 自定义角色的扩展字段只有在提供时才出现在记录上（内置记录保持原有 8 个键，
 *   历史消费者按 Object.keys 做断言的契约不变）：
 *   - custom: true           —— 标记来自设置的自定义角色；
 *   - toolDeny: string[]     —— 角色自身的工具拒绝扩展（必须显式提供，可为空数组）；
 *   - persona: string        —— 可选的自定义人格文本（缺失时由 description 兜底）。
 * - 读取面（normalizeCustomRoleDefinitions）对非法条目**丢弃并诊断**，绝不阻塞设置读取；
 *   写入面（assertCustomRoleDefinitions）对同一批规则**显式拒绝**，绝不默认放开。
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

/** 自定义角色定义允许的字段；出现任何其它字段都视为非法（fail-closed）。 */
const CUSTOM_DEFINITION_FIELDS = Object.freeze(["label", "statusLabel", "description", "readOnly", "toolDeny", "persona"]);

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

// ── 自定义角色的字段契约 ────────────────────────────────────────────────────

/**
 * 自定义角色的硬限制（读、写、|UI 上限共用同一份数字）。
 *
 * maxRoles 取 16：工具面与 root 提示词的成本随角色数线性增长，16 已能覆盖真实团队分工，
 * 同时避免一次误配置把宿主工具 schema 撑爆。
 */
export const CUSTOM_ROLE_LIMITS = Object.freeze({
  maxRoles: 16,
  minIdLength: 2,
  maxIdLength: 32,
  maxLabelLength: 64,
  maxStatusLabelLength: 32,
  maxDescriptionLength: 500,
  maxPersonaLength: 8000,
  maxToolDenyEntries: 64,
  maxToolNameLength: 128,
});

/**
 * 自定义角色 id 规则：小写字母开头，仅小写字母/数字/连字符，长度 2..32。
 * 与保留工具名一起构成「不得与插件工具面冲突」的边界。
 */
export const CUSTOM_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * 保留的工具名：这些名字属于插件/宿主工具面，不能成为角色 id。
 * 角色 id 同时就是角色工具名（toolName === id），因此与工具名冲突会直接覆盖工具。
 */
export const RESERVED_ROLE_TOOL_NAMES = Object.freeze([
  "fanout",
  "send_message",
  "report",
  "run_code",
  "workflow",
  "ralph",
  "goal",
  "create_goal",
  "update_goal",
  "get_goal",
  "subagent",
  "subagent_fork",
  "interrupt_agent",
  "todo_write",
  "read",
  "write",
  "edit",
  "bash",
  "pwsh",
  "grep",
  "glob",
  "ask_user_question",
  "exit_plan_mode",
  "present",
  "skill",
  "job_list",
  "job_output",
  "job_kill",
  "session",
  "settings",
  "agent",
  "agents",
  "tools",
  "mcp",
]);

/** 保留的前缀：动态 MCP 工具、DEG root-only 工具与 Harness 外层入口。 */
const RESERVED_ROLE_ID_PREFIXES = Object.freeze(["mcp__", "dsh_expert_group_", "subagent_"]);

/** 角色 id 是否命中保留名前缀。 */
function hasReservedPrefix(id) {
  return RESERVED_ROLE_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 状态标签默认值：角色 id 首字母大写（"reviewer" → "Reviewer"），可被显式覆盖。 */
function defaultStatusLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function customRoleError(code, message, details) {
  return new RoleRegistryError(code, message, details);
}

function assertCustomRoleId(id) {
  if (typeof id !== "string" || !CUSTOM_ROLE_ID_PATTERN.test(id)) {
    throw customRoleError(
      "INVALID_CUSTOM_ROLE_ID",
      "自定义角色 id 必须以小写字母开头、仅含小写字母/数字/连字符，长度 2..32: " + String(id),
      { role: id },
    );
  }
  // 内置角色 id 由 ROLE_REGISTRY 持有；这里只在模块初始化完成后调用，因此不存在 TDZ。
  if (ROLE_REGISTRY.has(id)) {
    throw customRoleError("CUSTOM_ROLE_BUILTIN_ID", "自定义角色 id 不得覆盖内置角色: " + id, { role: id });
  }
  if (RESERVED_ROLE_TOOL_NAMES.includes(id) || hasReservedPrefix(id)) {
    throw customRoleError("CUSTOM_ROLE_RESERVED_ID", "自定义角色 id 不得使用保留工具名: " + id, { role: id });
  }
}

function definitionText(value, field, id, maxLength, { trim = false } = {}) {
  if (typeof value !== "string") {
    throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的 " + field + " 必须是字符串", { role: id, field });
  }
  const text = trim ? value.trim() : value;
  if (text.length === 0) {
    throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的 " + field + " 不能为空", { role: id, field });
  }
  if (text.length > maxLength) {
    throw customRoleError(
      "INVALID_CUSTOM_ROLE",
      "自定义角色 " + id + " 的 " + field + " 超过 " + maxLength + " 字符上限",
      { role: id, field },
    );
  }
  return text;
}

/** 工具拒绝扩展的严格归一：字符串数组、去重、单条非空且有长度上限。 */
function normalizeToolDenyList(value, id) {
  if (!Array.isArray(value)) {
    // 缺失或非数组一律拒绝：toolDeny 是权限声明，绝不能默认成空数组放行。
    throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的 toolDeny 必须是字符串数组（不得缺省）", { role: id, field: "toolDeny" });
  }
  if (value.length > CUSTOM_ROLE_LIMITS.maxToolDenyEntries) {
    throw customRoleError(
      "INVALID_CUSTOM_ROLE",
      "自定义角色 " + id + " 的 toolDeny 最多 " + CUSTOM_ROLE_LIMITS.maxToolDenyEntries + " 条",
      { role: id, field: "toolDeny" },
    );
  }
  const names = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > CUSTOM_ROLE_LIMITS.maxToolNameLength) {
      throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的 toolDeny 必须是合法工具名", { role: id, field: "toolDeny" });
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    names.push(entry);
  }
  return names;
}

/**
 * 校验并归一单个自定义角色定义（严格模式，fail-closed）。
 *
 * 规则：
 * - 定义必须是普通对象，**只允许** label/statusLabel/description/readOnly/toolDeny/persona；
 *   出现任何其它字段（例如额外写权限的 allow 语义）一律拒绝，绝不忽略。
 * - readOnly 必须显式布尔；toolDeny 必须显式字符串数组（允许空数组）。
 * - statusLabel 缺省时由 id 派生；persona 可选，缺失时由调用方用 description 兜底。
 *
 * @param {string} id - 设置里的角色键。
 * @param {unknown} definition - 设置里的角色定义。
 * @returns {object} 冻结的定义（含派生后的 statusLabel）。
 */
export function normalizeCustomRoleDefinition(id, definition) {
  assertCustomRoleId(id);
  if (!isPlainObject(definition)) {
    throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的定义必须是普通对象", { role: id });
  }
  for (const field of Object.keys(definition)) {
    if (!CUSTOM_DEFINITION_FIELDS.includes(field)) {
      throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 含未知字段: " + field, { role: id, field });
    }
  }
  const label = definitionText(definition.label, "label", id, CUSTOM_ROLE_LIMITS.maxLabelLength, { trim: true });
  const statusLabel = definition.statusLabel === undefined
    ? defaultStatusLabel(id)
    : definitionText(definition.statusLabel, "statusLabel", id, CUSTOM_ROLE_LIMITS.maxStatusLabelLength, { trim: true });
  const description = definitionText(definition.description, "description", id, CUSTOM_ROLE_LIMITS.maxDescriptionLength);
  const readOnly = normalizeFlag(definition.readOnly, "readOnly", id);
  const toolDeny = Object.freeze(normalizeToolDenyList(definition.toolDeny, id));
  const normalized = {
    id,
    label,
    statusLabel,
    description,
    readOnly,
    toolDeny,
    ...(definition.persona === undefined
      ? {}
      : { persona: definitionText(definition.persona, "persona", id, CUSTOM_ROLE_LIMITS.maxPersonaLength) }),
  };
  return Object.freeze(normalized);
}

/**
 * 读取面归一：非法条目丢弃并产生结构化诊断（不抛错、不阻塞设置读取）。
 *
 * 角色按 id 字典序输出，与设置对象键序无关：同一份定义总得到同一顺序，
 * root 提示词模板缓存与工具注册顺序因此稳定。
 *
 * @param {unknown} value - settings 文档里的 customRoles 原始值。
 * @returns {{definitions: Record<string, object>, diagnostics: Array<{role:string, code:string, message:string}>}}
 */
export function normalizeCustomRoleDefinitions(value) {
  const diagnostics = [];
  const definitions = {};
  if (value === undefined || value === null) return { definitions, diagnostics };
  if (!isPlainObject(value)) {
    diagnostics.push({ role: "", code: "INVALID_CUSTOM_ROLES", message: "customRoles 必须是普通对象" });
    return { definitions, diagnostics };
  }
  const ids = Object.keys(value).sort();
  let accepted = 0;
  for (const id of ids) {
    try {
      assertCustomRoleId(id);
      if (accepted >= CUSTOM_ROLE_LIMITS.maxRoles) {
        throw customRoleError("CUSTOM_ROLE_LIMIT", "自定义角色最多 " + CUSTOM_ROLE_LIMITS.maxRoles + " 个", { role: id });
      }
      definitions[id] = normalizeCustomRoleDefinition(id, value[id]);
      accepted += 1;
    } catch (error) {
      diagnostics.push({
        role: typeof id === "string" ? id : "",
        code: typeof error?.code === "string" ? error.code : "INVALID_CUSTOM_ROLE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { definitions, diagnostics };
}

/**
 * 写入面校验：同一条规则但显式拒绝（用于 DEG 自有 settings 提交端点）。
 *
 * @param {unknown} value - 候选设置里的 customRoles。
 * @returns {Record<string, object>} 冻结的定义映射（按 id 字典序）。
 * @throws {RoleRegistryError} 任一角色非法、id 冲突、保留名或超过数量上限。
 */
export function assertCustomRoleDefinitions(value) {
  if (!isPlainObject(value)) {
    throw customRoleError("INVALID_CUSTOM_ROLES", "设置 customRoles 必须是普通对象", { field: "customRoles" });
  }
  const ids = Object.keys(value).sort();
  if (ids.length > CUSTOM_ROLE_LIMITS.maxRoles) {
    throw customRoleError(
      "CUSTOM_ROLE_LIMIT",
      "自定义角色最多 " + CUSTOM_ROLE_LIMITS.maxRoles + " 个",
      { field: "customRoles" },
    );
  }
  const definitions = {};
  for (const id of ids) definitions[id] = normalizeCustomRoleDefinition(id, value[id]);
  return Object.freeze(definitions);
}

/**
 * 把已归一的自定义角色定义转成注册表记录（与内置记录同形）。
 *
 * 转换结果仍会经过 createRoleRegistry → normalizeRecord 的同一套 fail-closed 校验，
 * 因此这里只是形状适配，不是第二个校验入口。
 *
 * @param {Record<string, object>} definitions - normalizeCustomRoleDefinitions 的输出。
 * @returns {object[]} 记录数组（顺序 = id 字典序）。
 */
export function customRoleRecords(definitions) {
  const source = isPlainObject(definitions) ? definitions : {};
  const records = [];
  for (const id of Object.keys(source).sort()) {
    const raw = source[id];
    if (!isPlainObject(raw)) {
      throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色 " + id + " 的定义必须是普通对象", { role: id });
    }
    // 再次走完整的 fail-closed 校验：调用方即使直接传入手工拼装的"定义"，缺 readOnly/toolDeny
    // 或含未知字段也必须在注册前被拒绝，绝不被后续的扩展字段校验静默放过。
    // 允许调用方传入带派生 id 的归一结果（id 必须与映射键一致），因此这里剥离它再校验。
    const { id: declaredId, ...definitionInput } = raw;
    if (declaredId !== undefined && declaredId !== id) {
      throw customRoleError("INVALID_CUSTOM_ROLE", "自定义角色定义的 id 与映射键不一致: " + id, { role: id, field: "id" });
    }
    const definition = normalizeCustomRoleDefinition(id, definitionInput);
    records.push({
      id,
      label: definition.label,
      statusLabel: definition.statusLabel,
      description: definition.description,
      optional: false,
      readOnly: definition.readOnly,
      defaultSelection: null,
      toolName: id,
      custom: true,
      toolDeny: [...definition.toolDeny],
      ...(definition.persona === undefined ? {} : { persona: definition.persona }),
    });
  }
  return records;
}

/** 读取面的便捷投影：只返回合法的定义映射（诊断由调用方另行读取）。 */
export function customRoleDefinitionsForRead(value) {
  return normalizeCustomRoleDefinitions(value).definitions;
}

/**
 * 保存用的文档形状：去掉派生字段 id（id 就是映射键），只保留用户可声明的字段。
 *
 * 设置文档里出现 `id` 会在下一次读取时被当作未知字段拒绝，因此写入边界必须剥离它；
 * 读取面保持严格（未知字段 fail-closed），不提供"容忍 id"的宽松分支。
 *
 * @param {Record<string, object>} definitions - normalize/assert 产出的定义映射。
 * @returns {Record<string, object>} 可写入 settings 的冻结文档映射（按 id 字典序）。
 */
export function customRoleDefinitionsDocument(definitions) {
  const source = isPlainObject(definitions) ? definitions : {};
  const document = {};
  for (const id of Object.keys(source).sort()) {
    const definition = source[id];
    if (!isPlainObject(definition)) continue;
    document[id] = Object.freeze({
      label: definition.label,
      statusLabel: definition.statusLabel,
      description: definition.description,
      readOnly: definition.readOnly,
      toolDeny: definition.toolDeny,
      ...(definition.persona === undefined ? {} : { persona: definition.persona }),
    });
  }
  return Object.freeze(document);
}

/**
 * 扩展字段（custom/toolDeny/persona）的注册期校验。
 *
 * 与自定义角色的写入校验同一批规则，但这里对**任何**记录生效：即使调用方手工拼一条
 * 记录（Host 之外的消费者），非法扩展字段也会 fail-closed，绝不被静默丢弃。
 */
function normalizeExtensions(input, id) {
  const extra = {};
  if (input.custom !== undefined) {
    if (typeof input.custom !== "boolean") {
      throw new RoleRegistryError("INVALID_ROLE_RECORD", "角色记录字段 custom 必须是布尔值", { role: id, field: "custom" });
    }
    extra.custom = input.custom;
  }
  if (input.toolDeny !== undefined) {
    extra.toolDeny = Object.freeze(normalizeToolDenyList(input.toolDeny, id));
  }
  if (input.persona !== undefined) {
    if (typeof input.persona !== "string" || input.persona.trim().length === 0
      || input.persona.length > CUSTOM_ROLE_LIMITS.maxPersonaLength) {
      throw new RoleRegistryError(
        "INVALID_ROLE_RECORD",
        "角色记录字段 persona 必须是 1.." + CUSTOM_ROLE_LIMITS.maxPersonaLength + " 字符的非空字符串",
        { role: id, field: "persona" },
      );
    }
    extra.persona = input.persona;
  }
  return extra;
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
      "角色记录 defaultSelection 必须为 null（插件不内置角色模型默认值）",
      { role: id, field: "defaultSelection" },
    );
  }
  const extensions = normalizeExtensions(input, id);
  return Object.freeze({ id, label, statusLabel, description, optional, readOnly, defaultSelection: null, toolName, ...extensions });
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
  const customIds = Object.freeze(ordered.filter((entry) => entry.custom === true).map((entry) => entry.id));
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
    /** 自定义角色 id（顺序稳定）。 */
    customIds() { return customIds; },
    /** 自定义角色记录。 */
    customRecords() { return Object.freeze(ordered.filter((entry) => entry.custom === true).slice()); },
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
    /** 按配置启用的角色显示名映射（冻结副本；侧栏角色标签使用它）。 */
    labels(options) {
      const map = {};
      for (const entry of enabledEntries(options)) map[entry.id] = entry.label;
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
    description: "只读代码库侦察：查清未知入口、跨目录符号/调用方/模式/测试等事实，并给出位置与缺口。任务信息：给待解问题与判断范围即可，不需要先替专家解出完整方案。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "explorer",
  },
  {
    id: "librarian",
    statusLabel: "Librarian",
    label: "资料员 (Librarian)",
    description: "只读外部文档调研：查证库 API、版本差异、官方文档与上游真实用法，给出带来源与版本号的结论。任务信息：给待解问题与判断范围即可，不需要先替专家解出完整方案。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "librarian",
  },
  {
    id: "oracle",
    statusLabel: "Oracle",
    label: "先知 (Oracle)",
    description: "只读架构与调试顾问：在架构、高风险决策与疑难调试前期给出判断，并回答待裁决问题及其理由与风险；用户要求代码审查或重大高风险实现完成后也由它审查。任务信息：给待解问题与判断范围即可，不需要先替专家解出完整方案。",
    optional: false,
    readOnly: true,
    defaultSelection: null,
    toolName: "oracle",
  },
  {
    id: "designer",
    statusLabel: "Designer",
    label: "设计师 (Designer)",
    description: "UI/UX 与视觉实现专家：在约束内拥有布局、交互、视觉层级与响应式/可访问性判断，并产出打磨过的界面实现。任务信息：给待解问题与判断范围即可，不需要先替专家解出完整方案。",
    optional: false,
    readOnly: false,
    defaultSelection: null,
    toolName: "designer",
  },
  {
    id: "fixer",
    statusLabel: "Fixer",
    label: "修理工 (Fixer)",
    description: "已定方案的实现、重复修改、迁移与测试补齐（含单文件的大量工作）：可读取本地上下文并按现有模式作局部实现，交付可验证的结果；需求、公共行为与架构约束的变更由主代理决定。任务信息：实施任务必须给已定方向（既定方案、允许范围与预期验证）。",
    optional: false,
    readOnly: false,
    defaultSelection: null,
    toolName: "fixer",
  },
  {
    id: "observer",
    statusLabel: "Observer",
    label: "观察员 (Observer)",
    description: "只读视觉分析：只对 Host 提供的 durable 图片附件（截图、图表、图示，以及以合法图片形式呈现的 PDF 页面）输出结构化视觉事实报告。任务信息：只给视觉分析目标即可，不需要主任务上下文。",
    optional: true,
    readOnly: true,
    defaultSelection: null,
    toolName: "observer",
  },
]);

/** 内置角色 id（自定义角色不得覆盖；顺序与注册表一致）。 */
export const BUILTIN_ROLE_IDS = Object.freeze(ROLE_REGISTRY.ids().slice());

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

/** 按配置启用的角色显示名映射。 */
export function roleLabels(options) {
  return ROLE_REGISTRY.labels(options);
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

/**
 * 运行期角色目录：内置记录 + 设置里的自定义记录，交给 createRoleRegistry 统一校验。
 *
 * 这是「运行期目录」的唯一构造入口：调用方（index.js）只在设置读取/保存成功后调用它，
 * 再把结果同时用于工具面、fan-out 枚举、RPC meta、编排提示词与权限判定，避免出现
 * 第二份角色清单。
 *
 * @param {unknown} customRoles - settings 文档里的 customRoles 原始值。
 * @returns {object} 冻结的运行期注册表（内置在前，自定义按 id 字典序追加）。
 */
export function createRuntimeRoleRegistry(customRoles) {
  const { definitions } = normalizeCustomRoleDefinitions(customRoles);
  return createRoleRegistry([...ROLE_REGISTRY.records(), ...customRoleRecords(definitions)]);
}
