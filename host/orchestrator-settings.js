/**
 * 主代理（Orchestrator）模型配置的**纯语义**模块（批次 A 地基）。
 *
 * ## 它负责什么
 * 1. **读取归一**（normalizeOrchestratorForRead）：把历史文档、外部写入、旧客户端留下的
 *    `settings.orchestrator` / `settings.peakValley.{peak,valley}.orchestrator` 收敛成形状
 *    固定的对象；非法部分丢弃并产生有界诊断，**绝不**让一份坏文档把整份设置文档解析失败
 *    （设置页因此永远打得开）；
 * 2. **写入合并**（mergeOrchestratorDraft）：字段粒度合并面——未提供的子字段保持基线，
 *    显式 `defaults: null` 表示"清空主选择"（与缺字段语义不同）；
 * 3. **候选链**（orchestratorPlanOf）：复用 shared/model-route 的 buildModelRoutePlan，
 *    **不复制**去重/effort-only 跳过/上限裁剪的规则；
 * 4. **时段与层级解析**（orchestratorPeriodOf / orchestratorLayerOf）：给出当前时段与
 *    「覆盖 > 时段 > 全局 > 不干预」的胜出层；时段判定仍只来自 shared/peak-valley-time；
 * 5. **下一个边界时刻**（orchestratorNextBoundaryDelayMs）：只算出"多久之后该重新判定"，
 *    不持有定时器（定时器属于运行期 manager）。
 *
 * ## 边界（刻意的）
 * - 本模块**无状态**：没有模块级可变变量，不读时钟、不读 settings 服务、不碰 DOM/文件；
 *   错误构造函数由调用方注入（`makeError(message)`），保证抛出的 ValidationError 与组合根
 *   是同一个类身份，RPC 层才能把客户端输入问题映射成 400 而不是 500。
 * - 保留键 `orchestrator` **不是**专家角色：它不属于 STATUS_ROLE_IDS，也不进入
 *   defaults / candidates 这两个「角色 -> 值」映射；它在 settings 顶层与峰谷 profile 内
 *   各是一个独立对象 `{ defaults, candidates, fallbackLimit }`。
 * - reasoningEffort 缺省 = 使用模型默认档。归一结果**删除**该键（不写空串），
 *   否则 adapter 的默认档会被固化成用户配置。
 *
 * @module dsh-expert-group/host/orchestrator-settings
 */
import {
  DEFAULT_MODEL_FALLBACK_LIMIT,
  MAX_MODEL_CANDIDATES_PER_ROLE,
  ORCHESTRATOR_SELECTION_KEY,
  buildModelRoutePlan,
  modelSelectionKeyOf,
  normalizeModelFallbackLimit,
  normalizeModelSelection,
} from "../shared/model-route.js";
import { peakValleyAtDate } from "../shared/peak-valley-time.js";

/**
 * 主代理在设置文档里的**保留键**。
 *
 * 它不是专家角色 id：不要把它加入 STATUS_ROLE_IDS、activeRoles() 或 defaults/candidates
 * 这两个角色映射。写入 / 读取边界只按"键恰好等于该常量"放行，因此保留键不会扩散成
 * 第七个角色，也不会参与角色工具的挂载与统计。
 */
export const ORCHESTRATOR_ID = ORCHESTRATOR_SELECTION_KEY;

/** 读取期诊断条数上限：诊断只服务设置页与 meta，绝不随用户写坏多少键而增长。 */
const DIAGNOSTIC_LIMIT = 16;

/** 普通对象判定（数组与 null 都不算对象）。 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 构造一份空的主代理配置。
 *
 * 每次调用返回新对象：read / write / schema 默认值各取一份，绝不共享引用
 * （共享会让"改一份影响另一份"直接出现在用户设置里）。
 *
 * @returns {{defaults: null, candidates: object[], fallbackLimit: number}} 空配置。
 */
export function defaultOrchestratorConfig() {
  return { defaults: null, candidates: [], fallbackLimit: DEFAULT_MODEL_FALLBACK_LIMIT };
}

/**
 * 读取归一：把任意历史/外部值收敛成 `{ defaults, candidates, fallbackLimit }`。
 *
 * 宽容原则（与 defaults / peakValley 的读取面一致）：
 * - 缺字段 / null / 非对象 => 空配置 + （非对象时）一条诊断，**不是**错误；
 * - defaults 非法（缺 provider/model、类型错误）=> null + 诊断；
 * - candidates 非数组 => 空数组 + 诊断；非法项与重复项丢弃并诊断，最多保留
 *   MAX_MODEL_CANDIDATES_PER_ROLE 条（与写面上限一致）；
 * - fallbackLimit 非法 => 默认值 + 诊断。
 *
 * 读取面**永不抛错**：设置页读坏值必须仍能打开，用户才能把它改回来。
 *
 * @param {unknown} value - settings.orchestrator 或 profile.orchestrator 原始值。
 * @returns {{config: object, diagnostics: object[]}} 归一配置与有界诊断。
 */
export function normalizeOrchestratorForRead(value) {
  const config = defaultOrchestratorConfig();
  const diagnostics = [];
  const report = (entry) => {
    if (diagnostics.length < DIAGNOSTIC_LIMIT) diagnostics.push(entry);
  };
  if (value === void 0 || value === null) return { config, diagnostics };
  if (!isPlainObject(value)) {
    report({ field: "orchestrator", reason: "invalid_shape" });
    return { config, diagnostics };
  }
  if (value.defaults !== void 0 && value.defaults !== null) {
    const normalized = normalizeModelSelection(value.defaults);
    if (normalized === undefined) report({ field: "orchestrator.defaults", reason: "invalid_selection" });
    else config.defaults = normalized;
  }
  if (value.candidates !== void 0) {
    if (!Array.isArray(value.candidates)) {
      report({ field: "orchestrator.candidates", reason: "invalid_shape" });
    } else {
      const seen = new Set();
      for (const entry of value.candidates) {
        if (config.candidates.length >= MAX_MODEL_CANDIDATES_PER_ROLE) {
          report({ field: "orchestrator.candidates", reason: "too_many_candidates" });
          break;
        }
        const normalized = normalizeModelSelection(entry);
        if (normalized === undefined) {
          report({ field: "orchestrator.candidates", reason: "invalid_selection" });
          continue;
        }
        const key = modelSelectionKeyOf(normalized);
        if (seen.has(key)) {
          report({ field: "orchestrator.candidates", reason: "duplicate_candidate" });
          continue;
        }
        seen.add(key);
        config.candidates.push(normalized);
      }
    }
  }
  if (value.fallbackLimit !== void 0) {
    const limit = normalizeModelFallbackLimit(value.fallbackLimit);
    if (limit !== value.fallbackLimit) report({ field: "orchestrator.fallbackLimit", reason: "invalid_fallback_limit" });
    config.fallbackLimit = limit;
  }
  return { config, diagnostics };
}

/**
 * 写入面的严格校验：候选列表（失败即整次保存拒绝，绝不静默丢条目）。
 *
 * 与读取面相反：客户端**显式提交**的候选必须完整、不重复、不超过上限。静默丢弃会让
 * 用户以为已经配好，实际仍走旧配置。
 *
 * @param {unknown} value - draft.candidates。
 * @param {(message: string) => Error} makeError - ValidationError 构造器。
 * @returns {object[]} 归一后的候选数组（新数组）。
 */
function readCandidatesCandidate(value, makeError) {
  if (!Array.isArray(value)) throw makeError("设置 orchestrator.candidates 必须是数组");
  if (value.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
    throw makeError("设置 orchestrator.candidates 最多 " + MAX_MODEL_CANDIDATES_PER_ROLE + " 个");
  }
  const seen = new Set();
  const candidates = [];
  for (const entry of value) {
    const normalized = normalizeModelSelection(entry);
    if (normalized === undefined) throw makeError("设置 orchestrator.candidates 含不完整条目（需要 provider 与 model）");
    const key = modelSelectionKeyOf(normalized);
    if (seen.has(key)) {
      throw makeError("设置 orchestrator.candidates 重复: " + normalized.provider + "/" + normalized.model);
    }
    seen.add(key);
    candidates.push(normalized);
  }
  return candidates;
}

/**
 * 写入边界的主代理配置合并（字段粒度，不整份覆盖）。
 *
 * 规则：
 * - 基线先归一（历史坏档案不会被"合并"放大成新写入）；
 * - 未提供的子字段保持基线值（旧客户端只改 fallbackLimit 不会清掉主选择）；
 * - `defaults: null` 是**显式清空**（与缺字段不同）；
 * - candidates 提交即整值替换（空数组 = 清空候选链）；
 * - reasoningEffort 缺省时结果里没有该键（归一已经删除空串/null）。
 *
 * 未知字段一律忽略：草稿白名单只含这三个键，任何旁路键都不得进入落盘状态。
 *
 * @param {object} options - 合并入参。
 * @param {unknown} options.base - 已保存的权威旧值（内部再归一一次）。
 * @param {unknown} options.draft - 本次提交的草稿（可缺字段）。
 * @param {(message: string) => Error} options.makeError - ValidationError 构造器。
 * @returns {{defaults: object|null, candidates: object[], fallbackLimit: number}} 合并结果。
 */
export function mergeOrchestratorDraft({ base, draft, makeError }) {
  if (typeof makeError !== "function") throw new TypeError("mergeOrchestratorDraft 需要 makeError(message)");
  const merged = normalizeOrchestratorForRead(base).config;
  if (draft === void 0) return merged;
  if (!isPlainObject(draft)) throw makeError("设置 orchestrator 无效");
  if (draft.defaults !== void 0) {
    if (draft.defaults === null) {
      merged.defaults = null;
    } else {
      const normalized = normalizeModelSelection(draft.defaults);
      if (normalized === undefined) throw makeError("设置 orchestrator.defaults 不完整（需要 provider 与 model）");
      merged.defaults = normalized;
    }
  }
  if (draft.candidates !== void 0) merged.candidates = readCandidatesCandidate(draft.candidates, makeError);
  if (draft.fallbackLimit !== void 0) {
    const limit = normalizeModelFallbackLimit(draft.fallbackLimit);
    if (limit !== draft.fallbackLimit) throw makeError("设置 orchestrator.fallbackLimit 无效");
    merged.fallbackLimit = limit;
  }
  return merged;
}

/**
 * 由一份主代理配置构造有序候选计划（主选择 + 候选链，受 fallbackLimit 约束）。
 *
 * 复用 shared/model-route 的 buildModelRoutePlan：去重、候选索引口径与专家角色完全一致，
 * 因此"预检失败切下一个"不需要第二套规则。主选择缺失时返回 null（"没有配置"与
 * "所有候选都不可用"是两种不同状态，调用方必须区分）。
 *
 * @param {unknown} config - 主代理配置（可为未归一的历史值）。
 * @returns {{plan: Array<{selection: object, candidateIndex: number}>, requestedPrimary: object|undefined,
 *   fallbackLimit: number}|null} 计划，或 null（未配置主选择）。
 */
export function orchestratorPlanOf(config) {
  if (config === null || config === void 0) return null;
  const { config: normalized } = normalizeOrchestratorForRead(config);
  const primary = normalized.defaults;
  if (primary === null) return null;
  return buildModelRoutePlan(primary, normalized.candidates, normalized.fallbackLimit);
}

/**
 * 读取当前峰谷时段（"peak" | "valley" | "none"）。
 *
 * 语义与派发路径同源（shared/peak-valley-time 是唯一判定实现）：
 * - 未启用 / 结构不是对象 => "none"（不干预）；
 * - 已启用但读取面给出 invalidCode => "none"：配置坏掉时**维持现状**，绝不用坏时段猜一个层
 *   去改用户的主代理模型（宁可不动，也不静默换模型）；
 * - 其余情况按墙钟分钟判定，0 条时段 = 全天谷时（既有语义）。
 *
 * @param {object} snapshot - 已归一 settings 快照。
 * @param {number} nowMs - 判定时刻（毫秒；来自宿主时钟探针，绝不二次取时）。
 * @returns {"peak"|"valley"|"none"} 当前时段。
 */
export function orchestratorPeriodOf(snapshot, nowMs) {
  const peakValley = snapshot?.peakValley;
  if (!isPlainObject(peakValley) || peakValley.enabled !== true) return "none";
  if (typeof peakValley.invalidCode === "string" && peakValley.invalidCode.length > 0) return "none";
  const periods = Array.isArray(peakValley.periods) ? peakValley.periods : [];
  const date = new Date(nowMs);
  if (Number.isNaN(date.getTime())) return "none";
  return peakValleyAtDate(periods, date);
}

/**
 * 解析"当前应生效的主代理配置"及其来源（优先级：覆盖 > 时段 > 全局 > 不干预）。
 *
 * 语义细节（刻意的）：
 * - **会话覆盖**只替换主选择，不带候选链：用户显式指定了模型，就不再用全局候选去替换它；
 *   自动套用因此也不重复写它（见 orchestrator-model 的运行期说明）；
 * - **时段层**只有在该层确实配置了 defaults 时才胜出；只配了候选没有主选择的时段配置
 *   视为"这一层没配置"，回退全局（与专家角色跨层回退的口径一致）；
 * - **全局层**是兜底；仍未配置 => "none"，调用方必须不干预（绝不挑选任何默认模型）。
 *
 * @param {object} snapshot - 已归一 settings 快照。
 * @param {string} sessionId - 根会话 id。
 * @param {"peak"|"valley"|"none"} period - 当前时段（orchestratorPeriodOf 的结果）。
 * @returns {{source: "override"|"period"|"global"|"none", config: object|null}} 胜出层与配置。
 */
export function orchestratorLayerOf(snapshot, sessionId, period) {
  const override = normalizeModelSelection(snapshot?.sessionOverrides?.[sessionId]?.[ORCHESTRATOR_ID]);
  if (override !== undefined) {
    // 覆盖层没有候选链：fallbackLimit 0 + 空候选 => 计划里只有主选择一条。
    return { source: "override", config: { defaults: override, candidates: [], fallbackLimit: 0 } };
  }
  if (period === "peak" || period === "valley") {
    const profile = snapshot?.peakValley?.[period];
    const profileConfig = isPlainObject(profile) ? profile.orchestrator : void 0;
    const normalized = normalizeOrchestratorForRead(profileConfig).config;
    if (normalized.defaults !== null) return { source: "period", config: normalized };
  }
  const globalConfig = normalizeOrchestratorForRead(snapshot?.orchestrator).config;
  if (globalConfig.defaults !== null) return { source: "global", config: globalConfig };
  return { source: "none", config: null };
}

/**
 * 时段边界分钟集合（去重、升序）：每个时段段的 start 与 end 都是"峰谷翻转"的候选时刻。
 *
 * 只接受严格 HH:mm（与 shared/peak-valley-time 同一形状）；非法条目跳过而不是抛错——
 * 这是定时器侧的计算，坏配置不允许把定时器打崩（读取面已单独 fail-closed）。
 *
 * @param {unknown} periods - 归一化后的时段数组。
 * @returns {number[]} 分钟数（0..1439）升序去重数组。
 */
function boundaryMinutesOf(periods) {
  const minutes = new Set();
  if (!Array.isArray(periods)) return [];
  for (const period of periods) {
    if (!isPlainObject(period)) continue;
    for (const key of ["start", "end"]) {
      const text = period[key];
      if (typeof text !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) continue;
      minutes.add(Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5)));
    }
  }
  return [...minutes].sort((left, right) => left - right);
}

/**
 * 距离下一个峰谷边界还有多少毫秒（没有边界时返回 null）。
 *
 * 只用本地墙钟做算术（与时段判定同一坐标系），并在结果上做两点保守处理：
 * - 最小 1000ms：避免"正好卡在边界前一毫秒"造成的忙循环；
 * - 定时器触发后调用方必须**重新判定**（而不是信任这次算术）：夏时制地区跨 00:00 的
 *   边界可能让 24 小时算术漂移一小时，重算会让它自愈。
 *
 * @param {object} snapshot - 已归一 settings 快照。
 * @param {number} nowMs - 当前时刻（毫秒）。
 * @returns {number|null} 毫秒延迟；未启用/非法/无时段时 null。
 */
export function orchestratorNextBoundaryDelayMs(snapshot, nowMs) {
  const peakValley = snapshot?.peakValley;
  if (!isPlainObject(peakValley) || peakValley.enabled !== true) return null;
  if (typeof peakValley.invalidCode === "string" && peakValley.invalidCode.length > 0) return null;
  const boundaries = boundaryMinutesOf(peakValley.periods);
  if (boundaries.length === 0) return null;
  const now = new Date(nowMs);
  if (Number.isNaN(now.getTime())) return null;
  const wallMinutes = now.getHours() * 60 + now.getMinutes();
  const secondsMs = now.getSeconds() * 1000 + now.getMilliseconds();
  let best = Number.POSITIVE_INFINITY;
  for (const minute of boundaries) {
    let delay = (minute - wallMinutes) * 60000 - secondsMs;
    if (delay <= 0) delay += 86400000;
    if (delay < best) best = delay;
  }
  if (!Number.isFinite(best)) return null;
  return Math.max(1000, best);
}
