/**
 * 组合根顶层的第 S12 段（R1 票据 06）：自 index.js 第 2171–2506 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { DEFAULT_EXPERT_PERSONA } from "../prompt-contracts.js";
import {
  STATUS_ROLE_IDS,
  normalizePromptOverrides,
  PROMPT_OVERRIDES_SETTINGS_KEY,
} from "../shared/prompts.js";
import {
  normalizeModelSelection,
  MAX_MODEL_CANDIDATES_PER_ROLE,
  CONTEXT_INHERITANCE_ROLE_IDS,
  normalizeModelFallbackLimit,
} from "../shared/model-route.js";
import { normalizeModelPrices } from "./usage-projection.js";
import {
  LIMIT_DIAGNOSTIC_LIMIT,
  normalizeRoleLimitsForRead,
  normalizeProviderLimitsForRead,
  normalizeNotificationEvents,
  normalizeRoleConcurrencyLimitForRead,
  normalizeConfigMigrationVersion,
  normalizeRoleTimeoutMs,
} from "./settings-schema.js";

/**
 * 把「与当前默认 persona 逐字相同」的覆盖折算成"没有覆盖"。
 *
 * 「与默认逐字相同」在写入边界（插件自持 settings-commit）就是**删除键**语义：
 * 该角色必须继续跟随未来的默认 persona 更新，而不是在文档里冻结一份默认副本。
 * 读取归一在这里做等价折算——写入面与读取面对同一份候选给出完全相同的结论。
 *
 * 比较是**逐字精确比较**，不做 trim 或空白折叠：首尾空白不同的文本仍算自定义覆盖。
 *
 * @param {Record<string,string>} overrides - 已归一（角色键合法、非空白、未超上限）的覆盖映射。
 * @param {(role: string) => string|undefined} [defaultPersonaOf] - 角色默认 persona 解析。
 * @returns {Record<string,string>} 删除默认副本后的映射。
 */
function pruneDefaultPromptOverrides(overrides, defaultPersonaOf = (role) => DEFAULT_EXPERT_PERSONA[role]) {
  const result = {};
  for (const [role, text] of Object.entries(overrides)) {
    if (text === defaultPersonaOf(role)) continue;
    result[role] = text;
  }
  return result;
}

/**
 * 模型候选的读取归一（票据 24）。
 *
 * 设置读取面必须对所有历史/外部写入保持宽容：非对象、未知角色、非数组、非法
 * selection 一律丢弃；单角色候选截到 MAX_MODEL_CANDIDATES_PER_ROLE（当前 3）条。
 * 写入面的严格拒绝不在这里，而在 DEG 自有 settings-commit 内——读坏值不得让设置页打不开。
 *
 * 向后兼容：旧版本允许每个角色配置到 8 条候选。升级后读取这类存量文档时，这里
 * 只保留**前 N 条（保持原顺序）**并静默丢弃其余，不抛错、不产生诊断——读取面一旦
 * 报错，用户连设置页都打不开，也就无法把配置改回合法状态。真正的拒绝只发生在
 * 用户下一次显式保存时（assertModelCandidatesCandidate）。
 */
function normalizeModelCandidatesForRead(value, allowedRoles = STATUS_ROLE_IDS) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const candidates = {};
  const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
  for (const [role, list] of Object.entries(value)) {
    if (!allowed.has(role) || !Array.isArray(list)) continue;
    const selections = [];
    for (const entry of list) {
      const selection = normalizeModelSelection(entry);
      if (selection === undefined) continue;
      selections.push(selection);
      if (selections.length >= MAX_MODEL_CANDIDATES_PER_ROLE) break;
    }
    candidates[role] = selections;
  }
  return candidates;
}

/**
 * 上下文继承映射的读取归一（票据 29，fail-soft）。
 *
 * 读取面必须对历史文档、外部写入与旧客户端保持宽容：非法键（Observer、未知角色）
 * 与非布尔值一律丢弃并返回稳定诊断；合法值只保留显式 true（显式 false
 * 与缺失同义，都是“关闭”）。缺字段 = 空映射 = 全部关闭（旧配置兼容）。
 *
 * 写入面（assertInheritContextCandidate）对同一批规则显式拒绝，绝不静默丢键。
 *
 * @param {unknown} value - settings 里的 inheritContext 原始值。
 * @returns {{value: Record<string, boolean>, diagnostics: Array<object>}} 归一结果。
 */
function normalizeInheritContextForRead(value) {
  const allowed = new Set(CONTEXT_INHERITANCE_ROLE_IDS);
  const diagnostics = [];
  const normalized = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (value !== void 0) diagnostics.push({ role: "", code: "INVALID_INHERIT_CONTEXT", message: "inheritContext 必须是角色到布尔值的映射" });
    return { value: normalized, diagnostics };
  }
  for (const [role, enabled] of Object.entries(value)) {
    if (!allowed.has(role)) {
      diagnostics.push({
        role,
        code: "INHERIT_CONTEXT_ROLE_NOT_ALLOWED",
        message: "只有内置非 Observer 角色可以开启上下文继承",
      });
      continue;
    }
    if (typeof enabled !== "boolean") {
      diagnostics.push({
        role,
        code: "INVALID_INHERIT_CONTEXT_VALUE",
        message: "上下文继承开关必须是布尔值",
      });
      continue;
    }
    if (enabled === true) normalized[role] = true;
  }
  return { value: normalized, diagnostics };
}

/**
 * 上下文继承读取诊断的有界投影（meta 用）。
 *
 * 只保留角色 id、稳定 code 与截断后的人类可读消息；不含原始值或任何会话正文。
 *
 * @param {unknown} value - normalizeSnapshot 的 inheritContextDiagnostics。
 * @returns {ReadonlyArray<object>} 冻结的只读诊断（最多 32 条）。
 */
export function projectInheritContextDiagnostics(value) {
  const projected = [];
  for (const entry of (Array.isArray(value) ? value : []).slice(0, 32)) {
    if (entry === null || typeof entry !== "object") continue;
    projected.push(Object.freeze({
      ...(typeof entry.role === "string" && entry.role.length > 0 ? { role: entry.role.slice(0, 64) } : {}),
      code: typeof entry.code === "string" ? entry.code : "INVALID_INHERIT_CONTEXT",
      message: typeof entry.message === "string" ? entry.message.slice(0, 240) : "",
    }));
  }
  return Object.freeze(projected);
}

/**
 * 上下文继承映射的写入面校验（票据 29，fail-closed）。
 *
 * 规则：
 * - 值必须是普通对象（数组/null 都拒绝）；
 * - 键必须是内置非 Observer 角色：Observer 的安全边界与未知角色一律拒绝；
 * - 值必须是布尔；显式 false 被接受并归一成“关闭”（不写入映射）；
 * - 空对象是合法的“清空全部”，与缺字段（保持原值）语义不同。
 *
 * @param {unknown} value - candidate.inheritContext。
 * @returns {Record<string, true>} 只含已开启角色的归一映射（用于整份 replace 写入）。
 */
export function assertInheritContextCandidate(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("设置 inheritContext 无效");
  }
  const allowed = new Set(CONTEXT_INHERITANCE_ROLE_IDS);
  const normalized = {};
  for (const [role, enabled] of Object.entries(value)) {
    if (!allowed.has(role)) {
      throw new ValidationError(
        role === "observer"
          ? "Observer 不允许继承上下文：该角色只接收视觉任务，必须保持隔离"
          : "设置 inheritContext 含不允许的角色: " + role + "（只允许内置非 Observer 角色）",
      );
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError("设置 inheritContext." + role + " 必须是布尔值");
    }
    if (enabled === true) normalized[role] = true;
  }
  return normalized;
}

/**
 * 读取期并发映射诊断的有界投影（meta 用，票据 26）。
 *
 * 只保留字段名、角色/provider 键（截断）与稳定原因码：不包含原始值、用户正文或
 * 任何会话数据；条数由读取面归一器限制在 LIMIT_DIAGNOSTIC_LIMIT 内，这里再兜一次。
 *
 * @param {unknown} value - normalizeSnapshot 的 limitDiagnostics。
 * @returns {{roleLimits: object[], providerLimits: object[]}} 冻结的只读诊断。
 */
export function projectLimitDiagnostics(value) {
  const project = (list) => {
    const projected = [];
    for (const entry of (Array.isArray(list) ? list : []).slice(0, LIMIT_DIAGNOSTIC_LIMIT)) {
      if (entry === null || typeof entry !== "object") continue;
      projected.push(Object.freeze({
        field: entry.field === "providerLimits" ? "providerLimits" : "roleLimits",
        ...(typeof entry.role === "string" && entry.role.length > 0 ? { role: entry.role.slice(0, 64) } : {}),
        ...(typeof entry.provider === "string" && entry.provider.length > 0 ? { provider: entry.provider.slice(0, 64) } : {}),
        reason: typeof entry.reason === "string" ? entry.reason : "invalid_limit",
      }));
    }
    return Object.freeze(projected);
  };
  const source = value !== null && typeof value === "object" ? value : {};
  return Object.freeze({
    roleLimits: project(source.roleLimits),
    providerLimits: project(source.providerLimits),
  });
}

/**
 * 单价读取期丢弃诊断的有界投影（票据 25，meta 用）。
 *
 * 只保留条目下标、稳定原因码与被截断的 provider/model 标识；不含原始数值、用户正文
 * 或任何路径。读取面本身已限制条数，这里再兜一次，保证 meta 有界。
 *
 * @param {unknown} value - normalizeSnapshot 的 modelPriceDiagnostics。
 * @returns {ReadonlyArray<object>} 冻结的只读诊断（最多 16 条）。
 */
export function projectModelPriceDiagnostics(value) {
  const projected = [];
  for (const entry of (Array.isArray(value) ? value : []).slice(0, 16)) {
    if (entry === null || typeof entry !== "object") continue;
    projected.push(Object.freeze({
      index: Number.isSafeInteger(entry.index) ? entry.index : -1,
      reason: typeof entry.reason === "string" ? entry.reason.slice(0, 64) : "invalid_price",
      ...(typeof entry.provider === "string" && entry.provider.length > 0 ? { provider: entry.provider.slice(0, 128) } : {}),
      ...(typeof entry.model === "string" && entry.model.length > 0 ? { model: entry.model.slice(0, 128) } : {}),
    }));
  }
  return Object.freeze(projected);
}

/** 取第一个非空白字符串（trim 后非空），全部缺失返回 null。 */
export function firstNonEmptyText(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (text.length > 0) return text;
  }
  return null;
}

/** 把一份 settings 快照归一为普通对象（不回填任何内置默认模型）。 */
export function normalizeSnapshot(snapshot, visibleRoles) {
  const defaults = {};
  for (const role of Object.keys(snapshot?.defaults ?? {})) {
    const value = snapshot.defaults[role];
    if (value && typeof value === "object") defaults[role] = { ...value };
  }
  const hasProvider = typeof snapshot?.provider === "string";
  const legacyProvider = hasProvider && snapshot.provider.length > 0 ? snapshot.provider : "";
  const roles = Array.isArray(visibleRoles) && visibleRoles.length > 0
    ? visibleRoles
    : Object.keys(defaults);
  const hadVisibleRowProvider = roles.some((role) => {
    const provider = defaults[role]?.provider;
    return typeof provider === "string" && provider.length > 0;
  });
  if (!hadVisibleRowProvider && legacyProvider.length > 0) {
    // 只迁移仍然合法的旧 selection；不存在的角色和隐藏 Observer 保持原样，
    // 且只在迁移前完全没有行级 provider 时执行，避免覆盖或拼接部分行级配置。
    for (const role of roles) {
      const value = defaults[role];
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.model !== "string" || value.model.length === 0
        || (typeof value.provider === "string" && value.provider.length > 0)) continue;
      defaults[role] = { ...value, provider: legacyProvider };
    }
  }
  const providers = roles.map((role) => {
    const provider = defaults[role]?.provider;
    return typeof provider === "string" && provider.length > 0 ? provider : "";
  });
  const configuredProviders = providers.filter((provider) => provider.length > 0);
  // 行级 provider 优先于旧顶层值；迁移前无行级 provider 时保留历史顶层 provider。
  const inferredProvider = configuredProviders.length > 0
    && configuredProviders.length === roles.length
    && configuredProviders.every((provider) => provider === configuredProviders[0])
    ? configuredProviders[0]
    : "";
  const provider = hadVisibleRowProvider
    ? inferredProvider
    : legacyProvider;
  const volume = Number(snapshot?.notificationVolume);
  // 角色集合固定为内置六角色（自定义角色能力已删除）。
  const knownRoleIds = STATUS_ROLE_IDS;
  /**
   * 并发映射读取面（票据 26）：角色键按内置角色集校验，
   * provider 键只要求非空字符串。非法条目丢弃并诊断，缺字段 = 空映射（旧配置兼容）。
   */
  const roleLimitsRead = normalizeRoleLimitsForRead(snapshot?.roleLimits, knownRoleIds);
  const providerLimitsRead = normalizeProviderLimitsForRead(snapshot?.providerLimits);
  // 上下文继承（票据 29）：只允许内置非 Observer 角色的显式 true；非法键丢弃并诊断。
  // 缺字段（旧配置）=> 空映射 => 全部关闭，内置角色的行为逐字节不变。
  const inheritContextRead = normalizeInheritContextForRead(snapshot?.inheritContext);
  // 单价（票据 25）：读取面丢弃非法/重复/超量条目并诊断；缺字段 = 空数组（旧配置兼容）。
  // 读取面绝不因坏值阻塞设置页；保存面的严格拒绝在 assertModelPrices。
  const modelPricesRead = normalizeModelPrices(snapshot?.modelPrices);
  return {
    provider,
    defaults,
    // 只保留六个合法角色、非空白且在 grapheme 上限内的覆盖；未知角色键、非字符串值、
    // 纯空白与超长文本在**DEG 自有提交端点**（settings-commit）内已被结构化拒绝。
    // 注意 0.1.7 的宿主没有 validate 钩子，因此宿主通用写入路径（settings.update /
    // mutate，例如模型配置区）不经过 DEG 校验：这里的丢弃是对外部编辑、历史文档与
    // 通用写入的读取安全网，正常提交路径不会走到它。
    // 与默认逐字相同的覆盖进一步折算为"没有覆盖"（等价删除键）。
    // 用户文本保留原始首尾空白与换行：归一绝不 trim 已接受的覆盖。
    promptOverrides: pruneDefaultPromptOverrides(
      normalizePromptOverrides(snapshot?.[PROMPT_OVERRIDES_SETTINGS_KEY], knownRoleIds),
      (role) => DEFAULT_EXPERT_PERSONA[role],
    ),
    notificationEnabled: snapshot?.notificationEnabled !== false,
    notificationVolume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : 100,
    // 通知事件类型（票据 14）：旧文档缺字段 => 三个类别全开（历史行为）。
    notificationEvents: normalizeNotificationEvents(snapshot?.notificationEvents),
    // 读取别名：旧默认值 10 + 标记缺失 => 20；标记落盘后 10 原样保留。
    roleConcurrencyLimit: normalizeRoleConcurrencyLimitForRead(snapshot),
    /**
     * 内部迁移标记（只读）：读取别名必须幂等。readStorageSnapshot 会对已归一快照再做
     * 一次防御性归一，如果这里丢掉标记，"标记=1 + 10" 会在第二次归一里被重新解释成
     * 20（meta 与调度器读到的值不一致）。它不是设置页字段，也不进入提交候选。
     */
    configMigrationVersion: normalizeConfigMigrationVersion(snapshot),
    /**
     * 逐角色并发上限（票据 26）：旧配置缺字段 => 空映射（全部落到 roleConcurrencyLimit
     * 默认值），读取面非法条目已被丢弃，调度器因此永远拿不到越界值。
     */
    roleLimits: roleLimitsRead.limits,
    /**
     * 逐 provider 并发上限（票据 26）：0 或缺失 = 不限制。读取面只做结构/范围归一，
     * 不查模型目录（provider 是否存在属于模型配置的职责，不是限流配置的前置条件）。
     */
    providerLimits: providerLimitsRead.limits,
    // 读取期被丢弃条目的只读诊断（有界；RPC meta 投影，客户端只读展示）。
    limitDiagnostics: Object.freeze({
      roleLimits: Object.freeze(roleLimitsRead.diagnostics.map((entry) => Object.freeze({ ...entry }))),
      providerLimits: Object.freeze(providerLimitsRead.diagnostics.map((entry) => Object.freeze({ ...entry }))),
    }),
    /**
     * 角色级上下文继承开关（票据 29）：只含内置非 Observer 角色的显式 true。
     * 缺字段（旧配置）/显式 false 都归一为关闭；空对象表示全部关闭。
     * 是否真正可继承还要看宿主是否有合格的 fork provider（派发时 fail-closed 校验）。
     */
    inheritContext: inheritContextRead.value,
    // 读取期被丢弃键的有界诊断（meta 投影；不是配置，不进入设置响应）。
    inheritContextDiagnostics: Object.freeze(inheritContextRead.diagnostics.map((entry) => Object.freeze({ ...entry }))),
    // 角色默认超时：旧配置/非法值归一为 0（不启用），不阻断读取。
    roleTimeoutMs: normalizeRoleTimeoutMs(snapshot?.roleTimeoutMs),
    // 模型候选（票据 24）：非法读取值回退为空映射；缺字段的旧配置同样为空。
    candidates: normalizeModelCandidatesForRead(snapshot?.candidates, knownRoleIds),
    // 自动降级上限：缺失/非法回退默认 2，读取面永远给出 0..4 的合法整数。
    fallbackLimit: normalizeModelFallbackLimit(snapshot?.fallbackLimit),
    // 单价（票据 25）：只读归一后的数组（每项 provider/model/inputPerMillion/
    // outputPerMillion/currency）；meta 只回传原始单价，估算成本属于客户端展示层。
    modelPrices: modelPricesRead.prices,
    // 读取期被丢弃条目的有界诊断（RPC meta 投影；不是配置，不进入设置响应）。
    modelPriceDiagnostics: Object.freeze(modelPricesRead.diagnostics.map((entry) => Object.freeze({ ...entry }))),
    observerPreferred: snapshot?.observerPreferred === true,
    // 只有显式 false 才关闭侧边栏注册；缺字段（旧配置/旧客户端）按历史行为保持开启。
    taskManagementEnabled: snapshot?.taskManagementEnabled !== false,
    // 只有显式 true 才开启自动打开；缺字段（旧文档/旧客户端/非法值）一律按关闭归一，
    // 历史行为因此逐字节不变：默认不做任何自动 open/close。
    autoOpenSubagentSidebar: snapshot?.autoOpenSubagentSidebar === true,
  };
}
