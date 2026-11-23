/**
 * 组合根顶层的第 S10 段（R1 票据 06）：自 index.js 第 1710–2000 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import z from "@deepseek-ai/schemastery";
import { DEFAULT_NOTIFICATION_VOLUME } from "./system-toast.js";
import { MAX_MODEL_FALLBACK_LIMIT, DEFAULT_MODEL_FALLBACK_LIMIT } from "../shared/model-route.js";

/**
 * 惰性兼容输入（fan-out 物理删除后这四个设置项的唯一残留语义）。
 *
 * 旧 settings 文档里可能仍保存着 `roleConcurrencyLimit` / `roleLimits` /
 * `providerLimits` / `roleTimeoutMs` 四个键（它们只服务已删除的 fan-out 调度器）。
 * 本模块**不再声明**它们：
 * - 不进入 Config schema、不进入读取归一，因此设置读面（describe / meta / settings 快照）
 *   永远不会出现这四个键；
 * - 也不进入任何提交 patch：旧文档保存其它设置时既不报错，也不改写、不删除磁盘上的旧值
 *   （写入面只按显式候选构造 patch，未声明的键天然不会被写）。
 *
 * 曾只为它们存在的常量与归一（并发/超时边界、默认值、读取别名、读取诊断上限与校验
 * helper）已一并删除。宿主通用子代理名额（`maxActiveSubagents` / hostConcurrencyCap）
 * 与它们无关，继续保留在 settings-source 的读面里。
 */

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
 * host/settings-source 从 describe() 取得，提交端点只写设置页可改的偏好字段。
 *
 * 注意：fan-out 时代遗留的 `roleConcurrencyLimit` / `roleLimits` / `providerLimits` /
 * `roleTimeoutMs` 已从本 schema 移除（见文件顶部的「惰性兼容输入」说明）。旧文档里的
 * 这些键既不会出现在 describe() 的 value 里，也不会被任何 patch 改写或删除。
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
  // 模型候选与启动前 fallback（票据 24）：候选是全局配置，按角色有序排列；
  // 会话覆盖只替换主选择（defaults/session_overrides），绝不修改这里。
  // 读取面把非法值归一为空映射/默认 2，不阻塞设置读取；严格拒绝落在 DEG 提交端点。
  // 注意：这里刻意**不**声明每角色长度上限（MAX_MODEL_CANDIDATES_PER_ROLE）——
  // 旧文档可能存着超过上限的候选，schema 一旦收紧会让整份设置文档解析失败；
  // 上限只由写面校验与读取裁剪共同负责。
  candidates: z.dict(z.array(ROLE_SELECTION)).default({}).volatile(),
  fallbackLimit: z.number().step(1).min(0).max(MAX_MODEL_FALLBACK_LIMIT).default(DEFAULT_MODEL_FALLBACK_LIMIT).volatile(),
  /**
   * 主代理（Orchestrator）模型配置（批次 A）：**独立对象**，刻意不放进 defaults 映射，
   * 也不进 activeRoles —— 它不是专家角色，只是根会话的 DSH 原生模型选择。
   *
   * 形状：`{ defaults: ROLE_SELECTION|null, candidates: ROLE_SELECTION[], fallbackLimit }`
   * - defaults 为 null = 用户没有配置主代理模型 => 不干预（绝不回填任何"默认模型"）；
   * - **读取侧 schema 对整个字段一律宽容**（z.any()）：字段语义、逐条/去重/上限/越界
   *   校验属于读取归一（host/orchestrator-settings 的 normalizeOrchestratorForRead）与
   *   DEG 自有提交端点（mergeOrchestratorDraft）。schema 一旦收紧（例如把 candidates
   *   声明成 z.array(...)、给 fallbackLimit 加 .min/.max、或要求整个值是对象），一份被
   *   宿主通用写入路径或历史版本写坏的文档就会让**整份设置文档**解析失败，设置页再也
   *   打不开——这正是读取归一要避免的失败模式（B7：严格拒绝只放在提交端点）。
   * - 读取归一保证"缺字段 / null / 非对象 => 空配置 + 诊断"，fallbackLimit 越界回退默认 2。
   *
   * 峰谷 profile 内的两份独立配置（peakValley.peak.orchestrator / .valley.orchestrator）
   * 走 z.any()，由 host/peak-valley-settings 的归一与合并负责（与本字段同一套语义）。
   */
  orchestrator: z.any().default({}).volatile(),
  /**
   * 峰谷模式（票据 02）：enabled / initialized / periods / peak / valley。
   *
   * 这是一组"要按时段切哪套模型"的状态，因此用嵌套对象而不是七个新的顶层字段；
   * peak / valley 与普通配置**同构**（provider、defaults、candidates、fallbackLimit）。
   *
   * 这里刻意只声明外壳，periods 与两套 profile 都用 z.any()：
   * - 时段的形状/数量/start===end 的唯一权威是 shared/peak-valley-time.js 的归一函数；
   * - 两套 profile 的写入面校验在 DEG 自有提交端点（host/peak-valley-settings），
   *   读取面由同一模块做宽容归一 + 有界诊断 + invalidCode；
   * - schema 一旦收紧（例如要求 profile.defaults 里 model 必填），一份被宿主通用写入
   *   路径或历史版本写坏的文档就会让**整份设置文档**解析失败，设置页再也打不开——这正是
   *   读取归一要避免的失败模式。代价是坏值能进文档，但读取面对它们 fail-closed。
   *
   * initialized 是 **Host 派生字段**：客户端提交的值在提交端点被忽略，只由首次启用的
   * 克隆写入 true（schema 默认 false 供旧文档/旧客户端读取）。
   * 缺字段 = 旧文档 / 旧客户端：读取面归一为未启用，普通配置字段完全不变。
   */
  peakValley: z.object({
    enabled: z.boolean().default(false),
    initialized: z.boolean().default(false),
    periods: z.array(z.any()).default([]),
    peak: z.any().default({}),
    valley: z.any().default({}),
  }).default({}).volatile(),
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
