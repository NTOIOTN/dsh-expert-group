/**
 * 组合根顶层的第 S10 段（R1 票据 06）：自 index.js 第 1710–2000 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import z from "@deepseek-ai/schemastery";
import { DEFAULT_NOTIFICATION_VOLUME } from "./system-toast.js";
import { STATUS_ROLE_IDS } from "../shared/prompts.js";
import {
  MIN_CONCURRENCY_LIMIT,
  MAX_CONCURRENCY_LIMIT,
  MIN_PROVIDER_LIMIT,
  MAX_PROVIDER_LIMIT,
  validateTimeoutMs,
  TIMEOUT_STEP_MS,
  MAX_TIMEOUT_MS,
} from "../fanout.js";
import { MAX_MODEL_FALLBACK_LIMIT, DEFAULT_MODEL_FALLBACK_LIMIT } from "../shared/model-route.js";

const ROLE_SELECTION = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
});

/** settings 保存统一 provider、各专家 defaults 和通知偏好；插件运行数据仍属于 storage domain。 */
/**
 * 通知事件类型（票据 14）：设置页只允许这三种语义化类别，Host 在**投递前**按设置过滤。
 *
 * 为什么不是直接暴露 turn/end 的 reason.kind：reason.kind 是宿主生命周期枚举
 * （completed/blocked/error/aborted/interrupted/max-tokens/unknown），对用户没有稳定意义，
 * 且未来可能新增 kind。这里把它收口成三个用户能决策的选项，默认全部开启以保持既有行为。
 */
export const NOTIFICATION_EVENT_TYPES = Object.freeze(["completed", "waiting", "failed"]);
/** 默认全部开启：旧配置缺字段、旧客户端不提交该字段时行为与历史完全一致。 */
export const DEFAULT_NOTIFICATION_EVENTS = Object.freeze({ completed: true, waiting: true, failed: true });
/**
 * 默认通知音量（0..100）：100 = 不做任何衰减，只受 Windows 主音量影响。
 * 常量与归一函数都来自 host/system-toast.js，保证设置读取面与投递面用的是同一套规则。
 */
export const DEFAULT_NOTIFICATION_VOLUME_SETTING = DEFAULT_NOTIFICATION_VOLUME;
/**
 * per-role 并发上限的默认值（未显式保存 `roleConcurrencyLimit` 时使用）。
 *
 * 与客户端展示/归一（client.js 的 normalizeRoleConcurrencyLimit）和设置页 title 文案
 * 保持同一数值；只影响没有该字段的历史配置，已显式保存的旧值仍按原值生效。
 */
export const DEFAULT_ROLE_CONCURRENCY_LIMIT = 20;
/**
 * 内部配置迁移目标版本（持久化在 settings.configMigrationVersion）。
 *
 * 版本 1 = 「旧默认并发上限 10 → 20」的**读取别名 + 首次保存落标记**方案：
 * - 标记缺失/小于该版本时，读取面把恰好等于旧默认值 10 的配置按 20 展示与调度；
 * - 第一次 settings-commit 会把标记与其它字段写进同一份 patch；
 * - 标记落盘后 10 原样保留，用户可随时手动改回 10。
 */
export const CONFIG_MIGRATION_VERSION = 1;
/** 旧默认并发上限：只有恰好等于该值的配置才会被读取别名按 20 解释。 */
const LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT = 10;
/**
 * 角色级默认超时（毫秒，票据 06）：默认 10 小时，显式 0 = 不启用。
 *
 * 与管理器的三级优先级（shard > 父任务 > 角色 > 未启用）共用同一语义；
 * 设置读取面必须总能给出一个合法值，所以非法/缺失回退到默认 10 小时。
 */
export const DEFAULT_ROLE_TIMEOUT_MS = 36000000;

/** 角色并发上限必须是 1 到 64 的安全整数；旧配置或非法值回退到默认值。 */
export function normalizeRoleConcurrencyLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 64
    ? value
    : DEFAULT_ROLE_CONCURRENCY_LIMIT;
}

/** 读取面归一：内部迁移版本（缺省/非法按 0 处理，与 Host 首次保存的补写规则一致）。 */
export function normalizeConfigMigrationVersion(snapshot) {
  const rawVersion = snapshot?.configMigrationVersion;
  return Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
}

/**
 * 读取面归一：把「旧默认值 10 + 尚未落迁移标记」解释为新默认值 20。
 *
 * 背景：默认值从 10 调整为 20 后，旧 profile 里显式保存的 10 在标记缺失时必须按 20
 * 展示与调度，否则用户升级后仍会看到/使用旧默认值。标记只在**首次保存**时随 patch
 * 落盘（不依赖启动期 describe 可见性）；标记落盘后 10 原样保留，用户之后手动改回
 * 10 不会被再次改写。
 *
 * 这是纯读取别名：绝不改写写入值，用户自定义的其它合法值完全不受影响。
 *
 * @param {object|undefined} snapshot - 已保存的 settings 文档（或已归一快照）。
 * @returns {number} 1~64 的生效并发上限。
 */
export function normalizeRoleConcurrencyLimitForRead(snapshot) {
  const limit = normalizeRoleConcurrencyLimit(snapshot?.roleConcurrencyLimit);
  return normalizeConfigMigrationVersion(snapshot) < CONFIG_MIGRATION_VERSION
    && limit === LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT
    ? DEFAULT_ROLE_CONCURRENCY_LIMIT
    : limit;
}

/**
 * 读取面诊断条数上限（票据 26）：非法 roleLimits/providerLimits 条目只保留有界摘要，
 * 诊断面因此不随用户写坏多少键而增长。
 */
export const LIMIT_DIAGNOSTIC_LIMIT = 16;

/**
 * 读取面归一：roleLimits（逐角色并发上限映射，票据 26）。
 *
 * 语义与其它设置读取面一致：
 * - 缺字段（旧配置/旧客户端）= 空映射，不是错误；
 * - 非法/越界值、未知角色键**丢弃并诊断**，绝不让设置页因一份坏文档打不开；
 * - 写入面（settings-commit）仍严格拒绝整份候选，读取面的宽容只服务历史文档
 *   与宿主通用写入路径。
 *
 * @param {unknown} value - settings.roleLimits 原始值。
 * @param {readonly string[]} allowedRoles - 当前候选设置自己的角色集（内置 + 自定义）。
 * @returns {{limits: Record<string, number>, diagnostics: Array<object>}}
 */
export function normalizeRoleLimitsForRead(value, allowedRoles) {
  const limits = {};
  const diagnostics = [];
  if (value === undefined || value === null) return { limits, diagnostics };
  if (typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ field: "roleLimits", reason: "invalid_shape" });
    return { limits, diagnostics };
  }
  const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
  for (const [role, limit] of Object.entries(value)) {
    // 先判值的合法性再判键：一个"未知角色 + 非法值"的条目最需要说明的是值坏了
    // （invalid_limit 是可操作的提示），而不是角色表里没有它。
    if (!Number.isSafeInteger(limit) || limit < MIN_CONCURRENCY_LIMIT || limit > MAX_CONCURRENCY_LIMIT) {
      if (diagnostics.length < LIMIT_DIAGNOSTIC_LIMIT) diagnostics.push({ field: "roleLimits", role: role.slice(0, 64), reason: "invalid_limit" });
      continue;
    }
    if (role.trim().length === 0 || !allowed.has(role)) {
      if (diagnostics.length < LIMIT_DIAGNOSTIC_LIMIT) diagnostics.push({ field: "roleLimits", role: role.slice(0, 64), reason: "unknown_role" });
      continue;
    }
    limits[role] = limit;
  }
  return { limits, diagnostics };
}

/**
 * 读取面归一：providerLimits（逐 provider 并发上限映射，票据 26）。
 *
 * 与 roleLimits 的区别（都是刻意的）：
 * - 键只要求非空字符串：provider 集合来自模型目录，插件不应在读取面替用户判定
 *   "这个 provider 是否存在"（目录可能暂时不可用）；
 * - 0 是合法值（显式不限制），只有越界/非整数才丢弃。
 *
 * @param {unknown} value - settings.providerLimits 原始值。
 * @returns {{limits: Record<string, number>, diagnostics: Array<object>}}
 */
export function normalizeProviderLimitsForRead(value) {
  const limits = {};
  const diagnostics = [];
  if (value === undefined || value === null) return { limits, diagnostics };
  if (typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({ field: "providerLimits", reason: "invalid_shape" });
    return { limits, diagnostics };
  }
  for (const [provider, limit] of Object.entries(value)) {
    if (provider.trim().length === 0) {
      if (diagnostics.length < LIMIT_DIAGNOSTIC_LIMIT) diagnostics.push({ field: "providerLimits", reason: "invalid_key" });
      continue;
    }
    if (!Number.isSafeInteger(limit) || limit < MIN_PROVIDER_LIMIT || limit > MAX_PROVIDER_LIMIT) {
      if (diagnostics.length < LIMIT_DIAGNOSTIC_LIMIT) diagnostics.push({ field: "providerLimits", provider: provider.slice(0, 64), reason: "invalid_limit" });
      continue;
    }
    limits[provider] = limit;
  }
  return { limits, diagnostics };
}

/**
 * 角色默认超时归一：需与 fanout.js 的 validateTimeoutMs 同源（只接受 0 或
 * 1000~86,400,000 的整秒毫秒数）。缺失/非法值回退默认 10 小时，保证读取面与
 * 调度器永远拿不到越界值；写入面仍由 validateSettingsCandidate 严格拒绝。
 *
 * @param {unknown} value - 待归一的 settings 值。
 * @returns {number} 0 或合法启用值。
 */
export function normalizeRoleTimeoutMs(value) {
  const check = validateTimeoutMs(value);
  return check.ok && typeof check.value === "number" ? check.value : DEFAULT_ROLE_TIMEOUT_MS;
}

/**
 * 通知事件开关归一：只读取三个声明过的类别，缺失/非法一律按开启处理。
 *
 * 为什么非法值按开启而不是按关闭：该字段只影响"要不要打扰用户"，历史行为是全部投递；
 * 读到一个坏值就静默关闭通知会让用户更难发现通知链路问题。写入面仍由
 * normalizeNotificationEventCandidate 严格拒绝非法候选，读取面的宽容只服务旧配置。
 *
 * @param {unknown} value - settings 里的 notificationEvents。
 * @returns {{completed: boolean, waiting: boolean, failed: boolean}} 冻结前的普通对象。
 */
export function normalizeNotificationEvents(value) {
  const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const type of NOTIFICATION_EVENT_TYPES) normalized[type] = source[type] !== false;
  return normalized;
}

/**
 * 插件组合 Config。
 *
 * 前两个字段是插件启停配置（普通 Config）：它们是部署期行为，不是设置页的即时偏好。
 * 其余字段是设置页可即时修改的偏好，必须标记 `.volatile()`：DSH 0.1.7 的
 * `ctx.settings` 只把「本条目 Config 上的 volatile 字段」投影成可编辑表单，并且
 * **只有声明了 volatile 字段的条目才会出现在 `describe()` 中**；写入非 volatile
 * 路径会被宿主直接拒绝。
 *
 * 字段语义与默认值必须与设置页的读取面一致：`describe()` 返回的 value 是
 * defaults resolved 后的结果（provider 空字符串表示用户尚未选择 provider，
 * promptOverrides 空对象表示全部跟随代码默认 persona）。运行期读源由
 * host/settings-source 从 describe() 取得，提交端点只写设置页可改的偏好字段
 * （`configMigrationVersion` 例外：它是内部迁移版本，不对用户展示、也不在提交端点写入面内）。
 */
export const Config = z.object({
  // 主代理能力默认启用；false 可用于仅使用专家工具的兼容部署。
  enableOrchestrator: z.boolean().default(true),
  enableObserver: z.boolean().default(false),
  // 空字符串表示用户尚未选择 provider，不为新用户填充模型。
  provider: z.string().default("").volatile(),
  defaults: z.dict(ROLE_SELECTION).default({}).volatile(),
  notificationEnabled: z.boolean().default(true).volatile(),
  notificationVolume: z.number().step(1).min(0).max(100).default(100).volatile(),
  // 通知事件类型（票据 14）：三个类别默认全部开启；缺字段的旧文档读取面按全开归一。
  // 这里用嵌套对象而不是三个顶层布尔：它是一组"要通知哪些事件"的集合，未来新增类别
  // 不需要再改提交端点/设置页的字段命名规则。
  notificationEvents: z.object({
    completed: z.boolean().default(true),
    waiting: z.boolean().default(true),
    failed: z.boolean().default(true),
  }).default({}).volatile(),
  roleConcurrencyLimit: z.number().step(1).min(1).max(64).default(DEFAULT_ROLE_CONCURRENCY_LIMIT).volatile(),
  /**
   * 内部配置迁移版本（volatile 只是让宿主允许插件写入并投影 describe）。
   *
   * 0 = 尚未落下标记；1 = 已落标记（当前只包含旧默认并发上限 10 → 20 的读取别名）。
   * 该字段不在设置页展示，也不进入 settings-commit 的候选；它由 Host 在首次成功
   * 保存时与其它字段写入同一份 patch，用来关闭读取别名：标记落盘后，用户手动把
   * roleConcurrencyLimit 改回 10 会原样保留，绝不会被再次解释成 20。
   */
  configMigrationVersion: z.number().step(1).min(0).default(0).volatile(),
  /**
   * 逐角色并发上限覆盖（票据 26）：roleId -> 1..64。未出现的角色落到 roleConcurrencyLimit。
   *
   * 这里只声明类型层（角色键/范围由 DEG 自有提交端点严格校验，见
   * assertRoleLimitsCandidate）。缺字段 = 旧配置/旧客户端：读取为空映射，保存时保持
   * 已有映射（不写 patch），因此不会把用户已配置的逐角色上限一次无关保存清空。
   */
  roleLimits: z.dict(z.number().step(1).min(1).max(64)).default({}).volatile(),
  /**
   * 逐 provider 并发上限（票据 26）：providerId -> 0..64。
   *
   * 0 或未设置表示不限制（规则见 docs/specs/03 §3）；provider 键只要求非空字符串，
   * 保存时不调用模型目录校验，避免目录暂时不可用时连限流配置都无法保存。
   */
  providerLimits: z.dict(z.number().step(1).min(0).max(64)).default({}).volatile(),
  // 角色级默认超时（毫秒，票据 06）：0 = 不启用；启用值为 1000~86,400,000 且为 1000 的整数倍。
  // 它只影响保存之后创建的 attempt，不会改写运行中的分片（三级优先级见 fanout.js）。
  roleTimeoutMs: z.number().step(TIMEOUT_STEP_MS).min(0).max(MAX_TIMEOUT_MS).default(DEFAULT_ROLE_TIMEOUT_MS).volatile(),
  // 模型候选与启动前 fallback（票据 24）：候选是全局配置，按角色有序排列；
  // 会话覆盖只替换主选择（defaults/session_overrides），绝不修改这里。
  // 读取面把非法值归一为空映射/默认 2，不阻塞设置读取；严格拒绝落在 DEG 提交端点。
  // 注意：这里刻意**不**声明每角色长度上限（MAX_MODEL_CANDIDATES_PER_ROLE）——
  // 旧文档可能存着超过上限的候选，schema 一旦收紧会让整份设置文档解析失败；
  // 上限只由写面校验与读取裁剪共同负责。
  candidates: z.dict(z.array(ROLE_SELECTION)).default({}).volatile(),
  fallbackLimit: z.number().step(1).min(0).max(MAX_MODEL_FALLBACK_LIMIT).default(DEFAULT_MODEL_FALLBACK_LIMIT).volatile(),
  /**
   * 每模型输入/输出单价（每百万 token，票据 25）：数组，最多 64 项。
   *
   * 这里只声明类型层（任意值数组）：字段/范围/未知键/重复条目的 fail-closed 校验由
   * DEG 自有提交端点调用 assertModelPrices 完成；读取面由 normalizeModelPrices 丢弃
   * 非法条目并给出有界诊断。
   * - 缺字段 = 旧配置/旧客户端：读取为空数组，保存时保持已有单价（不写 patch）；
   * - 显式空数组 = 清空全部单价（与缺字段语义不同）。
   */
  modelPrices: z.array(z.any()).default([]).volatile(),
  // 旧 settings 文档可能没有该字段；schema 与归一边界都提供关闭默认值。
  observerPreferred: z.boolean().default(false).volatile(),
  // 「任务管理」开关默认开启：旧文档缺字段时维持 Expert Group 注册到侧边栏的历史行为。
  taskManagementEnabled: z.boolean().default(true).volatile(),
  // 「自动打开运行中的子代理侧栏」默认关闭：这是纯增量体验，旧文档/旧客户端缺字段时
  // 必须保持「不做任何自动 open/close」的历史行为，绝不能按开启解释。
  autoOpenSubagentSidebar: z.boolean().default(false).volatile(),
  // 「左侧栏 DEG 入口」默认开启：缺字段的旧文档/旧客户端必须维持左侧栏入口可见的历史行为，
  // 因此读取面一律用宽松语义（!== false）归一，绝不按关闭解释。
  sidebarEntryEnabled: z.boolean().default(true).volatile(),
  // 六个角色的专家专属提示词覆盖（角色 id -> 自定义文本）。缺失或空对象表示全部
  // 使用代码里的默认 persona；这里只做类型层（角色键与长度）校验，写入边界的
  // 语义校验在 DEG 自有提交端点内（宿主新契约没有 validate 钩子）。
  promptOverrides: z.dict(z.string()).default({}).volatile(),
  /**
   * 角色级上下文继承开关（票据 29）：roleId -> boolean。
   *
   * - 只有内置非 Observer 角色可开启；Observer/未知角色由 DEG 自有提交端点
   *   整次拒绝（fail-closed），读取面对外部坏值丢弃并诊断；
   * - 缺字段 = 旧配置/旧客户端：读取为空映射（全部关闭），保存时保持已有映射；
   * - 显式空对象 = 全部关闭（与缺字段语义不同）。volatile 是设置页可即时修改的前提。
   */
  inheritContext: z.dict(z.boolean()).default({}).volatile(),
});

/** settings namespace 仅保存全局 defaults；session 与 child 运行数据属于 storage domain。 */
export const SETTINGS_NAMESPACE = "dsh-expert-group";
