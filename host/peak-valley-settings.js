/**
 * 峰谷设置的读取归一与写入合并（票据 02）。
 *
 * 本模块是「峰谷状态」在 Host 侧的唯一实现点，负责三件事：
 * 1. **读取归一**（normalizePeakValleyForRead）：把历史文档、外部写入与旧客户端留下的
 *    `settings.peakValley` 收敛成一个形状固定的只读状态；非法部分丢弃并产生有界诊断，
 *    启用状态下仍非法时给出稳定 invalidCode（供派发路径 fail-closed，见票 03）；
 * 2. **写入合并**（mergePeakValleyDraft）：字段粒度 CAS 的合并面——先以权威旧值为基线，
 *    再按客户端**显式提供**的子字段覆盖；首次启用时从已归一的普通配置克隆两份独立 profile；
 * 3. **变更角色推导**（peakValleyChangedRoles）：供模型目录 generation 守卫使用，覆盖
 *    `peak.defaults.*` / `peak.candidates.*` / `valley.*`，结果**按层分组**（峰/谷是
 *    两套独立 profile，同角色名在两层里互不相干）。
 *
 * ## 为什么独立成模块
 * 峰谷状态横跨 schema、读取投影与提交边界三个落点，且同时被读取面与写入面消费。
 * 把归一/合并写成一份实现，三处调用方就不会各自演化出「同一份配置、两套判定」的漂移面
 * （时段判定本身仍然只来自 shared/peak-valley-time.js，本模块不复制任何时段语义）。
 *
 * ## 无状态
 * 本模块没有任何模块级可变状态，也不读取 settings/DOM/时钟；错误构造函数由调用方注入
 * （`makeError(message, code)`），保证抛出的 ValidationError 与组合根是同一个类身份，
 * RPC 层才能把稳定错误码映射成 400。
 *
 * @module dsh-expert-group/host/peak-valley-settings
 */
import {
  normalizePeakValleyPeriods,
  peakValleyAtDate,
  PEAK_VALLEY_PERIODS_INVALID,
} from "../shared/peak-valley-time.js";
import {
  DEFAULT_MODEL_FALLBACK_LIMIT,
  MAX_MODEL_CANDIDATES_PER_ROLE,
  modelSelectionKeyOf,
  normalizeModelFallbackLimit,
  normalizeModelSelection,
} from "../shared/model-route.js";
import { STATUS_ROLE_IDS } from "../shared/prompts.js";

/** 某套 profile 的模型配置不完整/重复/越界时的稳定错误码（fail-closed，400）。 */
export const PEAK_VALLEY_PROFILE_INVALID = "PEAK_VALLEY_PROFILE_INVALID";
/** 峰谷状态结构本身非法（不是对象、缺 profile 容器、enabled 非布尔）时的稳定错误码。 */
export const PEAK_VALLEY_STATE_INVALID = "PEAK_VALLEY_STATE_INVALID";
/**
 * 允许直达客户端的峰谷错误码集合（mapRpcError 的白名单来源）。
 *
 * 三者都映射成 400 + 同值 code；其余 ValidationError 仍是 invalid-selection，
 * 因此这里必须是**封闭枚举**，不能按前缀放行任意 error.code。
 */
export const PEAK_VALLEY_ERROR_CODES = Object.freeze([
  PEAK_VALLEY_PERIODS_INVALID,
  PEAK_VALLEY_PROFILE_INVALID,
  PEAK_VALLEY_STATE_INVALID,
]);

/**
 * 把「历史/外部写入里出现的 invalidCode」收敛到封闭枚举（LOW 回归）。
 *
 * 为什么必须收敛：invalidCode 会原样进入派发路径（ValidationError.code 与 fanout 的
 * `{ok:false, code}`），那条面对客户端是**协议码**。历史文档、旧版本插件或手工编辑都可以
 * 写进任意字符串，若原样透传，协议面就出现了一个不可枚举、客户端无法分支的错误码。
 * 因此未知值一律收敛为 PEAK_VALLEY_STATE_INVALID（"状态本身不可信"），读取面仍保留
 * 一条有界诊断说明原值被判为未知，但绝不把它当作协议码。
 *
 * @param {unknown} value - 待判定的候选码。
 * @returns {string|undefined} 稳定码；非字符串/空串返回 undefined。
 */
function normalizePeakValleyErrorCode(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return PEAK_VALLEY_ERROR_CODES.includes(value) ? value : PEAK_VALLEY_STATE_INVALID;
}

/**
 * 「已保存状态非法、本次提交没有给出完整修复面」时的固定文案。
 *
 * 只说明需要用户做什么，不回显旧文档里的任何值（模型名/时段都不进错误体）。
 */
const PEAK_VALLEY_REPAIR_REQUIRED_MESSAGE = "已有峰谷配置非法，需同时提交时段与两套模型配置以修复";

/**
 * 本次草稿是否给出了完整修复面（periods + peak + valley 三块都显式提供）。
 *
 * 为什么要求"同时提供"：已保存状态非法时，读取归一已经把坏条目**丢弃/裁剪**过了，
 * 只合并其中一块会把"丢弃后的残缺状态"当作新基线写回——用户看到的是一次无关保存
 * 之后坏档案"变成"了全天谷时（时段被清空）却没有任何提示。要求三块同时提供，
 * 才能区分「用户显式重配」与「顺带被修好」。
 *
 * @param {unknown} draft - 客户端提交的 candidate.peakValley。
 * @returns {boolean} 是否提供了完整修复面。
 */
function providesPeakValleyRepairSurface(draft) {
  return isPlainObject(draft)
    && draft.periods !== void 0
    && draft.peak !== void 0
    && draft.valley !== void 0;
}

/**
 * 读取期诊断条数上限：诊断只服务设置页与 meta，绝不随用户写坏多少键而增长。
 * 与 LIMIT_DIAGNOSTIC_LIMIT（票据 26）取同一数量级。
 */
const DIAGNOSTIC_LIMIT = 16;

/** 普通对象判定（数组与 null 都不算对象）。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 构造一份空的峰谷 profile（provider/defaults/candidates/fallbackLimit）。
 *
 * 每次都返回新对象：profile 会被克隆成峰、谷两份，共享引用会让「改一份影响另一份」
 * 直接出现在用户设置里（票据 02 明确禁止）。
 */
function emptyPeakValleyProfile() {
  return { provider: "", defaults: {}, candidates: {}, fallbackLimit: DEFAULT_MODEL_FALLBACK_LIMIT };
}

/**
 * 深拷贝一份 profile（只保留四个白名单字段）。
 *
 * 刻意**不复制未知字段**：历史文档里可能残留旧版本字段，克隆与合并都不能把它们带进
 * 新写入的状态，否则「一份配置」会随保存次数不断漂移。
 */
function clonePeakValleyProfile(profile) {
  const source = isPlainObject(profile) ? profile : {};
  return {
    provider: typeof source.provider === "string" ? source.provider : "",
    defaults: cloneSelectionMap(source.defaults),
    candidates: cloneCandidateMap(source.candidates),
    fallbackLimit: normalizeModelFallbackLimit(source.fallbackLimit),
  };
}

/** 拷贝一份「角色 -> 选择」映射，丢弃形状非法的条目（读取/克隆面的宽容归一）。 */
function cloneSelectionMap(value) {
  const map = {};
  if (!isPlainObject(value)) return map;
  for (const [role, selection] of Object.entries(value)) {
    const normalized = normalizeModelSelection(selection);
    if (normalized === undefined) continue;
    map[role] = normalized;
  }
  return map;
}

/** 拷贝一份「角色 -> 候选列表」映射，按每角色上限截断并丢弃非法/重复条目。 */
function cloneCandidateMap(value) {
  const map = {};
  if (!isPlainObject(value)) return map;
  for (const [role, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const selections = [];
    const seen = new Set();
    for (const entry of list) {
      if (selections.length >= MAX_MODEL_CANDIDATES_PER_ROLE) break;
      const normalized = normalizeModelSelection(entry);
      if (normalized === undefined) continue;
      const key = modelSelectionKeyOf(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      selections.push(normalized);
    }
    map[role] = selections;
  }
  return map;
}

/**
 * 峰谷状态的默认值（未启用、未初始化、0 条时段、两套空 profile）。
 *
 * 每次调用返回全新对象：schema 默认值、读源初值与 defaultSettingsEntry 都各自取一份，
 * 绝不共享引用。0 条时段 = 全天谷时（时段判定的既有语义），不是「配置缺失」。
 */
export function defaultPeakValleyState() {
  return {
    enabled: false,
    initialized: false,
    periods: [],
    peak: emptyPeakValleyProfile(),
    valley: emptyPeakValleyProfile(),
  };
}

/**
 * 按角色 defaults 推导一套 profile 的统一 provider（与普通配置同一规则）。
 *
 * 只在该 profile 自己没有非空 provider 时使用；已配置的角色必须给出**同一个** provider
 * 才算推导成功，否则保持空串（不猜测）。这里不比普通配置的「全部可见角色」条件：
 * 峰谷 profile 允许只有部分角色有默认模型（其余角色落回普通配置）。
 *
 * @param {Record<string, object>} defaults - 已归一的角色选择映射。
 * @returns {string} 统一 provider，或空串。
 */
function inferProfileProvider(defaults) {
  const providers = [];
  for (const selection of Object.values(defaults)) {
    if (typeof selection?.provider === "string" && selection.provider.length > 0) providers.push(selection.provider);
  }
  if (providers.length === 0) return "";
  return providers.every((provider) => provider === providers[0]) ? providers[0] : "";
}

/** 候选列表的稳定比较键（顺序敏感）：每项用 modelSelectionKeyOf，非法项用固定哨兵。 */
function selectionListKeyOf(list) {
  if (!Array.isArray(list)) return "\u0000invalid-list";
  return list.map((entry) => {
    const key = modelSelectionKeyOf(entry);
    return key.length === 0 ? "\u0000invalid" : key;
  }).join("\u0001");
}

/**
 * 读取归一单套 profile。
 *
 * 语义与普通配置的读取面一致：非法条目**丢弃**并诊断，绝不因为一份坏文档让设置页打不开；
 * 同时把「有没有丢过东西」记在 valid 上，启用状态下据此给出 PROFILE_INVALID 的 fail-closed
 * 信号。container 表示「这个 profile 容器本身在不在」——缺失/类型错误属于结构问题，
 * 按口径归到 STATE_INVALID（优先级排在时段与 profile 之后）。
 *
 * @param {unknown} value - settings.peakValley.peak / .valley 原始值。
 * @param {string} layer - "peak" | "valley"（只用于诊断字段名与文案）。
 * @param {(entry: object) => void} report - 有界诊断收集器。
 * @returns {{profile: object, valid: boolean, container: boolean}} 归一结果。
 */
function readPeakValleyProfile(value, layer, report) {
  const profile = emptyPeakValleyProfile();
  // 容器缺失/类型错误属于**结构问题**（STATE），不是"profile 内容非法"（PROFILE）：
  // valid 保持 true，让 invalidCode 的优先级仍然是 时段 → profile → 状态结构。
  if (value === void 0) return { profile, valid: true, container: false };
  if (!isPlainObject(value)) {
    report({ field: "peakValley." + layer, reason: "invalid_shape" });
    return { profile, valid: true, container: false };
  }
  let valid = true;
  if (value.provider !== void 0) {
    if (typeof value.provider === "string") profile.provider = value.provider;
    else {
      valid = false;
      report({ field: "peakValley." + layer + ".provider", reason: "invalid_provider" });
    }
  }
  if (value.defaults !== void 0) {
    const read = readProfileDefaults(value.defaults, layer, report);
    profile.defaults = read.defaults;
    if (!read.valid) valid = false;
  }
  if (value.candidates !== void 0) {
    const read = readProfileCandidates(value.candidates, layer, report);
    profile.candidates = read.candidates;
    if (!read.valid) valid = false;
  }
  if (value.fallbackLimit !== void 0) {
    const limit = normalizeModelFallbackLimit(value.fallbackLimit);
    if (limit !== value.fallbackLimit) {
      valid = false;
      report({ field: "peakValley." + layer + ".fallbackLimit", reason: "invalid_fallback_limit" });
    }
    profile.fallbackLimit = limit;
  }
  if (profile.provider.length === 0) profile.provider = inferProfileProvider(profile.defaults);
  return { profile, valid, container: true };
}

/** 读取归一 profile.defaults：未知角色/非法选择丢弃并诊断（不阻断读取）。 */
function readProfileDefaults(value, layer, report) {
  const defaults = {};
  if (!isPlainObject(value)) {
    report({ field: "peakValley." + layer + ".defaults", reason: "invalid_shape" });
    return { defaults, valid: false };
  }
  const allowed = new Set(STATUS_ROLE_IDS);
  let valid = true;
  for (const [role, selection] of Object.entries(value)) {
    if (!allowed.has(role)) {
      valid = false;
      report({ field: "peakValley." + layer + ".defaults", role, reason: "unknown_role" });
      continue;
    }
    const normalized = normalizeModelSelection(selection);
    if (normalized === undefined) {
      valid = false;
      report({ field: "peakValley." + layer + ".defaults", role, reason: "invalid_selection" });
      continue;
    }
    defaults[role] = normalized;
  }
  return { defaults, valid };
}

/** 读取归一 profile.candidates：越界/重复/非法条目丢弃并诊断（不阻断读取）。 */
function readProfileCandidates(value, layer, report) {
  const candidates = {};
  if (!isPlainObject(value)) {
    report({ field: "peakValley." + layer + ".candidates", reason: "invalid_shape" });
    return { candidates, valid: false };
  }
  const allowed = new Set(STATUS_ROLE_IDS);
  let valid = true;
  for (const [role, list] of Object.entries(value)) {
    if (!allowed.has(role)) {
      valid = false;
      report({ field: "peakValley." + layer + ".candidates", role, reason: "unknown_role" });
      continue;
    }
    if (!Array.isArray(list)) {
      valid = false;
      report({ field: "peakValley." + layer + ".candidates", role, reason: "invalid_shape" });
      continue;
    }
    if (list.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
      valid = false;
      report({ field: "peakValley." + layer + ".candidates", role, reason: "too_many_candidates" });
    }
    const selections = [];
    const seen = new Set();
    for (const entry of list) {
      if (selections.length >= MAX_MODEL_CANDIDATES_PER_ROLE) break;
      const normalized = normalizeModelSelection(entry);
      if (normalized === undefined) {
        valid = false;
        report({ field: "peakValley." + layer + ".candidates", role, reason: "invalid_selection" });
        continue;
      }
      const key = modelSelectionKeyOf(normalized);
      if (seen.has(key)) {
        valid = false;
        report({ field: "peakValley." + layer + ".candidates", role, reason: "duplicate_candidate" });
        continue;
      }
      seen.add(key);
      selections.push(normalized);
    }
    candidates[role] = selections;
  }
  return { candidates, valid };
}

/**
 * 峰谷状态的读取归一（读取投影、meta 与提交基线的唯一入口）。
 *
 * 规则：
 * - 缺字段（旧文档）与 null = 未启用、未初始化、0 条时段、两套空 profile，**不是错误**；
 * - 非对象 = 结构非法：退回默认状态并诊断（无法判断 enabled，因此不产生 invalidCode）；
 * - periods 交给 shared/peak-valley-time.js 的权威归一；失败时**不保留部分时段**；
 * - enabled 为真且仍非法时给出稳定 invalidCode，优先级为 时段 → profile → 状态结构。
 *
 * @param {unknown} value - settings.peakValley 原始值。
 * @returns {{state: object, diagnostics: object[], invalidCode: (string|undefined)}} 归一结果。
 */
export function normalizePeakValleyForRead(value) {
  const diagnostics = [];
  const report = (entry) => {
    if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(entry);
  };
  const state = defaultPeakValleyState();
  /**
   * 二次归一必须幂等：readSnapshot 会对**已归一**的快照再归一一次（防御性收敛）。
   * 第一次归一已经把非法 periods/profile 丢弃成"看起来合法"的默认值，重新计算会得到
   * undefined——于是 fail-closed 信号会在第二次归一里悄悄消失，路由就会误判为可用。
   * 因此把上一轮的 invalidCode 当作一次性事实向下传递；新计算出的码永远优先。
   */
  const rawCarriedInvalidCode = isPlainObject(value) && typeof value.invalidCode === "string"
    && value.invalidCode.length > 0
    ? value.invalidCode
    : void 0;
  // 只接受封闭枚举：未知码收敛为 PEAK_VALLEY_STATE_INVALID（见 normalizePeakValleyErrorCode）。
  const carriedInvalidCode = normalizePeakValleyErrorCode(rawCarriedInvalidCode);
  if (value === void 0 || value === null) return { state, diagnostics, invalidCode: void 0 };
  if (!isPlainObject(value)) {
    report({ field: "peakValley", reason: "invalid_shape" });
    return { state, diagnostics, invalidCode: void 0 };
  }
  state.enabled = value.enabled === true;
  if (value.enabled !== void 0 && typeof value.enabled !== "boolean") {
    // 非布尔 enabled 按未启用解释（只有显式 true 才启用），但必须让用户看见这份文档坏了。
    report({ field: "peakValley.enabled", reason: "invalid_enabled" });
  }
  state.initialized = value.initialized === true;
  const periods = normalizePeakValleyPeriods(value.periods);
  if (periods.ok) state.periods = periods.periods;
  else report({ field: "peakValley.periods", reason: "invalid_periods", code: periods.code });
  const peak = readPeakValleyProfile(value.peak, "peak", report);
  const valley = readPeakValleyProfile(value.valley, "valley", report);
  state.peak = peak.profile;
  state.valley = valley.profile;
  let invalidCode;
  if (state.enabled) {
    if (!periods.ok) invalidCode = PEAK_VALLEY_PERIODS_INVALID;
    else if (!peak.valid || !valley.valid) invalidCode = PEAK_VALLEY_PROFILE_INVALID;
    else if (!peak.container || !valley.container) invalidCode = PEAK_VALLEY_STATE_INVALID;
    // 已启用时才保留上一轮的 fail-closed 信号；未启用状态不对外宣称"非法"。
    if (invalidCode === void 0) invalidCode = carriedInvalidCode;
    // 未知码只作为一次性诊断保留（原始值不回显、不进入协议面）。
    if (rawCarriedInvalidCode !== void 0 && rawCarriedInvalidCode !== carriedInvalidCode) {
      report({ field: "peakValley.invalidCode", reason: "unknown_invalid_code" });
    }
  }
  return { state, diagnostics, invalidCode };
}

/** 普通记录判定：null / 数组 / 非对象一律 false（读面只需「能安全展开」这一条判据）。 */
function isPlainRecordOf(value) {
  return value !== null && typeof value === "object" && Array.isArray(value) !== true;
}

/**
 * 「会话模型」弹窗读面的角色默认：返回**当前生效**的逐角色默认（普通层 + 时段层合并）。
 *
 * 与派发路径的跨层回退同口径（见 host/peak-valley-route.js 的 resolvePeakValleyRoute）：
 * 峰谷启用且合法时，时段层（peakValley[period].defaults）里有的角色用时段层，
 * 缺的角色回退普通层 defaults —— 因此这里必须**逐角色合并**，不能二选一，
 * 否则弹窗会显示一个派发时根本不会用的默认。
 *
 * 边界：读面永不抛错。配置损坏（invalidCode 非空）、未启用、结构不是对象时直接返回普通层；
 * 派发侧仍由 resolvePeakValleyRoute 对同一 invalidCode fail-closed，两处职责不重叠。
 *
 * 放在本模块而不是 meta handler 内：时段判定与「当前生效」的归一口径归峰谷模块所有；
 * meta handler 所在文件已贴「本地 import ≤12」门禁，无法再新增一条 shared 依赖。
 *
 * @param {object} snap - 设置快照（只需要 defaults 与 peakValley 两个字段）。
 * @returns {Record<string, object>} 角色 → 当前生效的模型选择。
 */
export function effectiveRoleDefaultsOf(snap) {
  const defaults = isPlainRecordOf(snap?.defaults) ? snap.defaults : {};
  const pv = snap?.peakValley;
  if (!isPlainRecordOf(pv) || pv.enabled !== true) return defaults;
  if (typeof pv.invalidCode === "string" && pv.invalidCode.length > 0) return defaults;
  const period = peakValleyAtDate(pv.periods, new Date());
  const profileDefaults = isPlainRecordOf(pv[period]?.defaults) ? pv[period].defaults : null;
  if (profileDefaults === null) return defaults;
  return { ...defaults, ...profileDefaults };
}

/** 稳定错误码对应的用户可读文案（只写原因，不回显原始值）。 */
function peakValleyMessageOf(code) {
  if (code === PEAK_VALLEY_PERIODS_INVALID) return "峰谷时段配置无效";
  if (code === PEAK_VALLEY_PROFILE_INVALID) return "峰谷配置的模型字段无效";
  return "峰谷状态无效";
}

/** 抛出调用方构造的 ValidationError（保留同一类身份，RPC 才能映射 400 + 稳定 code）。 */
function fail(makeError, message, code) {
  throw makeError(message, code);
}

/** 写入面判定：一套已经归一/合并的 profile 是否完整可用（不查模型目录）。 */
function profileIsValid(profile) {
  if (!isPlainObject(profile)) return false;
  if (typeof profile.provider !== "string") return false;
  if (!isPlainObject(profile.defaults) || !isPlainObject(profile.candidates)) return false;
  if (normalizeModelFallbackLimit(profile.fallbackLimit) !== profile.fallbackLimit) return false;
  for (const selection of Object.values(profile.defaults)) {
    if (normalizeModelSelection(selection) === undefined) return false;
  }
  for (const list of Object.values(profile.candidates)) {
    if (!Array.isArray(list) || list.length > MAX_MODEL_CANDIDATES_PER_ROLE) return false;
    const seen = new Set();
    for (const entry of list) {
      const key = modelSelectionKeyOf(entry);
      if (key.length === 0 || seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

/**
 * 合并后的峰谷状态是否仍然非法（写入面 fail-closed 判定）。
 *
 * 优先级与读取面一致：时段 → profile → 状态结构。返回值是稳定错误码或 undefined。
 *
 * @param {object} state - mergePeakValleyDraft 产出的合并状态。
 * @returns {string|undefined} 稳定错误码。
 */
function peakValleyInvalidCodeOf(state) {
  if (!isPlainObject(state)) return PEAK_VALLEY_STATE_INVALID;
  if (!normalizePeakValleyPeriods(state.periods).ok) return PEAK_VALLEY_PERIODS_INVALID;
  if (!profileIsValid(state.peak) || !profileIsValid(state.valley)) return PEAK_VALLEY_PROFILE_INVALID;
  return void 0;
}

/**
 * 写入面严格归一 profile.defaults（显式提供的整份映射）。
 *
 * 与读取面的宽容相反：客户端明确提交的 profile 必须完整、角色合法，否则整次保存拒绝
 * （PEAK_VALLEY_PROFILE_INVALID）。静默丢弃会让用户以为某角色已改好，实际仍走旧配置。
 *
 * @param {unknown} value - draft.peak.defaults / draft.valley.defaults。
 * @param {Function} makeError - 错误构造器。
 * @param {string} label - "峰时" / "谷时"（错误文案用）。
 * @returns {Record<string, object>} 归一后的映射。
 */
function readProfileDefaultsCandidate(value, makeError, label) {
  if (!isPlainObject(value)) fail(makeError, label + "配置的 defaults 必须是角色到模型选择的映射", PEAK_VALLEY_PROFILE_INVALID);
  const allowed = new Set(STATUS_ROLE_IDS);
  const defaults = {};
  for (const [role, selection] of Object.entries(value)) {
    if (!allowed.has(role)) fail(makeError, label + "配置的 defaults 含未知角色: " + role, PEAK_VALLEY_PROFILE_INVALID);
    const normalized = normalizeModelSelection(selection);
    if (normalized === undefined) {
      fail(makeError, label + "配置的 " + role + " 模型不完整（需要 provider 与 model）", PEAK_VALLEY_PROFILE_INVALID);
    }
    defaults[role] = normalized;
  }
  return defaults;
}

/**
 * 写入面严格归一 profile.candidates（显式提供的整份映射）。
 *
 * 越界（超过每角色上限）、重复（同一 provider/model/effort）与不完整条目都整次拒绝。
 *
 * @param {unknown} value - draft.peak.candidates / draft.valley.candidates。
 * @param {Function} makeError - 错误构造器。
 * @param {string} label - "峰时" / "谷时"。
 * @returns {Record<string, object[]>} 归一后的候选映射。
 */
function readProfileCandidatesCandidate(value, makeError, label) {
  if (!isPlainObject(value)) fail(makeError, label + "配置的 candidates 必须是角色到候选列表的映射", PEAK_VALLEY_PROFILE_INVALID);
  const allowed = new Set(STATUS_ROLE_IDS);
  const candidates = {};
  for (const [role, list] of Object.entries(value)) {
    if (!allowed.has(role)) fail(makeError, label + "配置的 candidates 含未知角色: " + role, PEAK_VALLEY_PROFILE_INVALID);
    if (!Array.isArray(list)) fail(makeError, label + "配置的 " + role + " 候选必须是数组", PEAK_VALLEY_PROFILE_INVALID);
    if (list.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
      fail(makeError, label + "配置的 " + role + " 候选最多 " + MAX_MODEL_CANDIDATES_PER_ROLE + " 个", PEAK_VALLEY_PROFILE_INVALID);
    }
    const seen = new Set();
    const selections = [];
    for (const entry of list) {
      const normalized = normalizeModelSelection(entry);
      if (normalized === undefined) fail(makeError, label + "配置的 " + role + " 候选不完整", PEAK_VALLEY_PROFILE_INVALID);
      const key = modelSelectionKeyOf(normalized);
      if (seen.has(key)) {
        fail(makeError, label + "配置的 " + role + " 候选重复: " + normalized.provider + "/" + normalized.model, PEAK_VALLEY_PROFILE_INVALID);
      }
      seen.add(key);
      selections.push(normalized);
    }
    candidates[role] = selections;
  }
  return candidates;
}

/**
 * 把本次显式草稿合并到基线上（字段粒度，不整份覆盖）。
 *
 * - 未提供的子字段一律保持基线值；显式 {} 不清理（defaults/candidates 的整值替换语义
 *   由「提供了这个字段」触发，空对象本身就是一次合法的整值替换）；
 * - provider/defaults/candidates/fallbackLimit 沿用普通配置的「整值替换」语义；
 * - initialized 是 Host 派生字段：客户端提交的任何值都被忽略，只由首次启用克隆写 true。
 *
 * @param {object} base - 合并基线（已归一的旧 profile）。
 * @param {unknown} draft - 本次提交的 profile 草稿（可能缺字段）。
 * @param {Function} makeError - 错误构造器。
 * @param {string} label - "峰时" / "谷时"。
 * @returns {object} 合并后的 profile（新对象）。
 */
function applyProfileDraft(base, draft, makeError, label) {
  const profile = clonePeakValleyProfile(base);
  if (draft === void 0) return profile;
  if (!isPlainObject(draft)) fail(makeError, "设置 peakValley 的 " + label + "配置无效", PEAK_VALLEY_STATE_INVALID);
  if (draft.provider !== void 0) {
    if (typeof draft.provider !== "string") fail(makeError, label + "配置的 provider 必须是字符串", PEAK_VALLEY_PROFILE_INVALID);
    profile.provider = draft.provider;
  }
  if (draft.defaults !== void 0) profile.defaults = readProfileDefaultsCandidate(draft.defaults, makeError, label);
  if (draft.candidates !== void 0) profile.candidates = readProfileCandidatesCandidate(draft.candidates, makeError, label);
  if (draft.fallbackLimit !== void 0) {
    const limit = normalizeModelFallbackLimit(draft.fallbackLimit);
    if (limit !== draft.fallbackLimit) fail(makeError, label + "配置的降级上限无效", PEAK_VALLEY_PROFILE_INVALID);
    profile.fallbackLimit = limit;
  }
  return profile;
}

/**
 * 写入边界的峰谷合并（字段粒度 CAS 的核心）。
 *
 * 顺序（任一步失败整次不落盘）：
 * 1. 以**权威旧值**（调用方传入的 schema describe() 当前快照里的 peakValley）为基线；
 * 2. 只合并显式提供的 enabled / periods / peak.* / valley.*；
 * 3. 首次启用（enabled 由假变真且未初始化）时从**已归一的普通配置**克隆两份独立
 *    白名单 profile，再应用本次显式草稿，并把 initialized 写 true；
 * 4. **已保存状态非法**（读取面 invalidCode 非空）时只接受「显式修复」：草稿必须带
 *    `repair: true` 意图位，并同时提供 periods + peak + valley，且合并结果必须真的合法；
 *    否则整次拒绝（code 取旧状态的 invalidCode）。绝不把"读取归一丢弃后的残缺状态"
 *    当作新基线悄悄写回，也不把普通的全量组装候选误判成修复；
 * 5. 启用状态下合并结果仍非法则整次拒绝（时段 → profile 优先级）。
 *
 * @param {object} options - 合并入参。
 * @param {unknown} options.draft - 客户端提交的 candidate.peakValley。
 * @param {unknown} options.saved - 权威旧值（未归一，内部先归一）。
 * @param {unknown} options.ordinary - 已归一的普通配置（provider/defaults/candidates/fallbackLimit）。
 * @param {(message: string, code: string) => Error} options.makeError - 错误构造器。
 * @returns {object} 合并后的完整 peakValley 状态（用于整值写入）。
 */
export function mergePeakValleyDraft(options) {
  const { draft, saved, ordinary, makeError } = options ?? {};
  if (typeof makeError !== "function") throw new TypeError("mergePeakValleyDraft 需要 makeError(message, code)");
  // 旧状态必须**先归一一次再读 invalidCode**：读取面是"启用但非法"的唯一判据来源，
  // 与派发路径（peak-valley-route）消费的是同一个信号，两边不会出现两套判定。
  const savedRead = normalizePeakValleyForRead(saved);
  const savedState = savedRead.state;
  if (!isPlainObject(draft)) fail(makeError, "设置 peakValley 无效", PEAK_VALLEY_STATE_INVALID);
  /**
   * 已保存状态非法时的拒绝码：优先沿用旧状态的稳定码（时段 → profile → 状态结构），
   * 未知码在这里再收敛一次，保证错误体里的 code 永远属于封闭枚举。
   */
  const savedInvalidCode = normalizePeakValleyErrorCode(savedRead.invalidCode);
  /**
   * 修复意图位（只存在于提交候选）：`peakValley.repair === true`。
   *
   * 为什么不能只看字段形状：读取归一会把非法时段变成 0 条、丢弃坏条目，而真实设置页
   * 保存时本来就会把 periods/peak/valley 全量组装进候选——只看"三项都在"就会把用户
   * 只改一层模型的一次普通保存误判成"完整修复"，把坏档案静默写成全天谷时。
   * 因此只有显式 `repair: true` 才被当作"用户在修复这件事"。
   */
  const repairRequested = draft.repair === true;
  if (savedInvalidCode !== void 0 && (!repairRequested || !providesPeakValleyRepairSurface(draft))) {
    // 没有修复意图（或修复面不全）：整次拒绝，绝不把丢弃后的残缺状态写回成"修复结果"。
    fail(makeError, PEAK_VALLEY_REPAIR_REQUIRED_MESSAGE, savedInvalidCode);
  }
  let enabled = savedState.enabled;
  if (draft.enabled !== void 0) {
    if (typeof draft.enabled !== "boolean") fail(makeError, "设置 peakValley.enabled 必须是布尔值", PEAK_VALLEY_STATE_INVALID);
    enabled = draft.enabled;
  }
  let periods = savedState.periods;
  if (draft.periods !== void 0) {
    const read = normalizePeakValleyPeriods(draft.periods);
    if (!read.ok) fail(makeError, "峰谷时段不合法：" + read.reason, PEAK_VALLEY_PERIODS_INVALID);
    periods = read.periods;
  }
  /**
   * 首次启用的判定必须同时满足「这次是关→开」与「从未初始化」两个条件。
   *
   * 只看 initialized 会把历史/外部写入的 `enabled:true, initialized:false` 也当成首次启用，
   * 于是之后任何一次峰谷保存都会从普通配置重新克隆两份 profile，把用户已经配好的
   * 峰/谷配置悄悄覆盖掉（票据 02 / MEDIUM 回归）。这种状态的真实含义是「已启用但
   * 初始化标记缺失」，正确处置是**不克隆、沿用原 profile**，initialized 也保持原值。
   */
  const firstEnable = enabled === true && savedState.enabled !== true && savedState.initialized !== true;
  // 两份基线各自 clone 一次：克隆面只保留四个白名单字段，峰/谷之间、与普通配置之间
  // 都不共享任何对象引用（改一份绝不影响另一份）。
  const state = {
    enabled,
    initialized: firstEnable ? true : savedState.initialized === true,
    periods,
    peak: applyProfileDraft(firstEnable ? clonePeakValleyProfile(ordinary) : savedState.peak, draft.peak, makeError, "峰时"),
    valley: applyProfileDraft(firstEnable ? clonePeakValleyProfile(ordinary) : savedState.valley, draft.valley, makeError, "谷时"),
  };
  // 写入面只接受上面白名单里的五个字段：repair 是**提交侧意图位**，绝不进入落盘状态
  // （state 是显式构造的，因此 patch 与回包里都不会出现它）。
  const mergedInvalidCode = peakValleyInvalidCodeOf(state);
  if (savedInvalidCode !== void 0 && mergedInvalidCode !== void 0) {
    // 防守分支：显式修复但合并结果仍非法时同样整次拒绝。
    // 注意：该分支在「读取归一 + 写入面严格校验」下不可达——旧状态经归一后形状合法，
    // 草稿的 periods/profile 又都走严格校验，合并结果必然通过 peakValleyInvalidCodeOf；
    // 这里保留是为了「将来某天新增字段时不小心放松校验」也不会静默落盘。
    fail(makeError, PEAK_VALLEY_REPAIR_REQUIRED_MESSAGE, savedInvalidCode);
  }
  if (state.enabled === true && mergedInvalidCode !== void 0) {
    fail(makeError, peakValleyMessageOf(mergedInvalidCode), mergedInvalidCode);
  }
  return state;
}

/**
 * 解析峰谷两套 profile 里**变更中**的模型字段（票据 02）。
 *
 * 与普通 defaults 完全同一套规则：只有变更集（声明 ∪ 实际差异）内的启用角色走真实目录
 * 解析，未变更角色沿用草稿/已保存值——存量失效模型不得阻塞无关保存；未启用角色按原值
 * 保留（与本文件既有的"未启用角色沿用原值"取舍一致）。候选列表复用调用方传入的
 * 候选解析器：重复/不完整条目已在上一步的结构校验里以 PEAK_VALLEY_PROFILE_INVALID 拒绝。
 *
 * 解析函数由调用方注入（Host 侧是 validateSelectionWithSignal / validateModelCandidatesCandidate），
 * 因此本模块不依赖模型目录服务，仍是纯数据变换。
 *
 * @param {object} options - 解析入参。
 * @param {object} options.state - 已合并的峰谷状态（尚未做目录解析）。
 * @param {{peak: {defaultRoles: Set<string>, candidateRoles: Set<string>},
 *   valley: {defaultRoles: Set<string>, candidateRoles: Set<string>}}} options.changes -
 *   按层分组的需解析角色集合（见 peakValleyChangedRoles）：每层只消费自己那一组，
 *   另一层的同名角色**不得**被重新解析（HIGH-2）。
 * @param {object} options.savedState - 已归一的旧峰谷状态（未变更角色的候选回退来源）。
 * @param {string[]} options.enabledRoles - 当前启用角色（未启用角色不做解析）。
 * @param {Function} options.resolveSelection - 单条选择的目录解析（可取消）。
 * @param {Function} options.resolveCandidates - 候选列表的目录解析（可取消）。
 * @param {AbortSignal} [options.signal] - 请求生命周期信号。
 * @returns {Promise<{state: object, resolvedRoles: string[]}>} 解析后的状态与角色清单
 *   （角色形如 `peak.fixer`，供诊断与测试观察"这次解析了哪些层角色"）。
 */
export async function resolvePeakValleyProfiles(options) {
  const { state, changes, savedState, enabledRoles, resolveSelection, resolveCandidates, signal } = options ?? {};
  const enabled = new Set(Array.isArray(enabledRoles) ? enabledRoles : []);
  // 浅拷贝到两层各自独立的 profile：解析结果不得回写调用方的合并对象。
  const cloneLayer = (profile) => ({
    provider: profile.provider,
    defaults: { ...profile.defaults },
    candidates: { ...profile.candidates },
    fallbackLimit: profile.fallbackLimit,
  });
  const resolved = { ...state, peak: cloneLayer(state.peak), valley: cloneLayer(state.valley) };
  const resolvedRoles = [];
  for (const layer of ["peak", "valley"]) {
    const profile = resolved[layer];
    // 层内变更集：缺失/形状不符时退化为「本层没有变更」，绝不把另一层的集合拿来顶替。
    const layerChanges = changes?.[layer] ?? {};
    const defaultRoles = layerChanges.defaultRoles instanceof Set ? layerChanges.defaultRoles : new Set();
    const candidateRoles = layerChanges.candidateRoles instanceof Set ? layerChanges.candidateRoles : new Set();
    for (const [role, selection] of Object.entries(profile.defaults)) {
      if (!enabled.has(role) || !defaultRoles.has(role)) continue;
      profile.defaults[role] = await resolveSelection(selection, signal);
      resolvedRoles.push(layer + "." + role);
    }
    profile.candidates = await resolveCandidates(
      profile.candidates,
      candidateRoles,
      savedState?.[layer]?.candidates ?? {},
      signal,
    );
  }
  return { state: resolved, resolvedRoles };
}

/**
 * 本次提交需要做真实模型解析的峰/谷角色集合（模型目录 generation 守卫的输入）。
 *
 * **必须按层分组返回**（HIGH-2）：峰/谷是两套独立 profile，同一角色 id 在两层里是两条
 * 互不相干的配置。若把两层合并成同一个 Set，只改 peak 层时 valley 的同名角色也会被
 * 重新解析——一旦 valley 里留着存量失效模型（例如已被移除的模型），一次无关保存就会被
 * 它整体阻塞。分组之后 `resolvePeakValleyProfiles` 每层只消费自己那一组。
 *
 * 与普通配置同一判定：客户端声明的变更集 ∪ 与已保存值的实际差异；
 * 比较键为空（选择不完整）时强制进入解析，保证非法值一定被结构化拒绝。
 * 角色从映射里被删除时不需要解析（没有可解析的选择）。
 *
 * @param {object} state - 合并后的 peakValley 状态。
 * @param {object} savedState - 已归一的旧 peakValley 状态。
 * @param {object|null} declared - declaredChangedModelRolesOf 的结果（含 peak/valley 子集）。
 * @returns {{peak: {defaultRoles: Set<string>, candidateRoles: Set<string>},
 *   valley: {defaultRoles: Set<string>, candidateRoles: Set<string>}}} 按层分组的需解析角色。
 */
export function peakValleyChangedRoles(state, savedState, declared) {
  const changes = {};
  for (const layer of ["peak", "valley"]) {
    const defaultRoles = new Set();
    const candidateRoles = new Set();
    const layerDeclared = declared?.[layer] ?? {};
    const current = state?.[layer] ?? {};
    const saved = savedState?.[layer] ?? {};
    for (const [role, selection] of Object.entries(current.defaults ?? {})) {
      const candidateKey = modelSelectionKeyOf(selection);
      const savedKey = modelSelectionKeyOf(saved.defaults?.[role]);
      const declaredChanged = layerDeclared.allRoles === true || layerDeclared.roles?.has(role) === true;
      if (candidateKey !== savedKey || candidateKey.length === 0 || declaredChanged) defaultRoles.add(role);
    }
    for (const [role, list] of Object.entries(current.candidates ?? {})) {
      if (!Array.isArray(list)) continue;
      const candidateKey = selectionListKeyOf(list);
      const savedKey = selectionListKeyOf(saved.candidates?.[role]);
      const declaredChanged = layerDeclared.allCandidates === true || layerDeclared.candidateRoles?.has(role) === true;
      if (candidateKey !== savedKey || declaredChanged) candidateRoles.add(role);
    }
    changes[layer] = { defaultRoles, candidateRoles };
  }
  return changes;
}
