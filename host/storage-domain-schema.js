/**
 * 组合根顶层的第 S11 段（R1 票据 06）：自 index.js 第 2001–2170 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { z as domainZ } from "zod";
import { MAX_MODEL_FALLBACK_LIMIT, MODEL_ROUTE_ERROR_CODES } from "../shared/model-route.js";
import { ROUTE_PERIODS, ROUTE_PLAN_LIMIT, ROUTE_TIERS } from "../shared/route-snapshot.js";
import { STRUCTURED_RESULT_FALLBACK_REASONS } from "../shared/structured.js";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import {
  DENY_MARKER,
  MAX_EXPERT_DENY_MARKER_ENTRIES,
  PERSONA_MARKER,
  MAX_EXPERT_PERSONA_MARKER_CHARS,
} from "./expert-guards.js";
import { SHADOW_MARKER, SHADOW_STATUS } from "./send-message-shadow.js";
import { ORCHESTRATOR_STATE_TABLE } from "./orchestrator-epoch.js";
import {
  DOMAIN_SESSION_DELETE_RECORD,
  SESSION_DELETE_QUEUE_TABLE,
  SESSION_DELETE_RESIDUE_TABLE,
} from "./session-delete-contract.js";

/** domain child record 保留恢复字段；缺失的 lruSequence 由稳定 key 规则兼容。 */
export const DOMAIN_ROLE_SELECTION = domainZ.object({
  provider: domainZ.string(),
  model: domainZ.string(),
  reasoningEffort: domainZ.string().optional(),
});
/**
 * child_models 的实际路由字段（票据 24）。
 *
 * requestedPrimary 记录本次派发时生效的主选择（可能是会话覆盖），candidateIndex 使用
 * 原始候选位置（0=primary），fallbackCount 是实际降级次数，lastRouteErrorCode 只允许
 * 稳定分类码。字段全部可选：旧记录/旧进程快照继续可读，投影侧缺失即省略，绝不补 0。
 */
const DOMAIN_MODEL_ROUTE_FIELDS = {
  requestedPrimary: DOMAIN_ROLE_SELECTION.optional(),
  candidateIndex: domainZ.number().int().nonnegative().optional(),
  fallbackCount: domainZ.number().int().nonnegative().optional(),
  lastRouteErrorCode: domainZ.enum(Object.values(MODEL_ROUTE_ERROR_CODES)).optional(),
};
/**
 * 派发路由冻结快照（票据 03）：child_models 上的**可选**只读投影字段。
 *
 * 形状与 shared/route-snapshot.js 严格一致，并且这里只做**有界校验**（不做归一/修复）：
 * plan 数组 ≤ 8、period/tier 封闭枚举、tierPlanLength ≤ 8、层内索引 0..7、层预算 0..4、
 * provider 非空、decidedAt 非负。取舍与 persona marker 相同：**写入边界先归一**
 * （host/index-agent-snapshot.js 的 persistChildModel 只写 normalizeRouteSnapshot 通过的
 * 快照），schema 不承担修复职责；因此任何绕过写入边界的非法值都会被 domain 拒绝，
 * 而不是被静默截断成「看起来能跑」的第二个真相。历史记录里的 malformed route 由写入
 * 面显式删除（removeKeys），保证一条坏字段不会永久阻塞整条记录。
 */
const DOMAIN_ROUTE_SNAPSHOT = domainZ.object({
  period: domainZ.enum(ROUTE_PERIODS),
  tier: domainZ.enum(ROUTE_TIERS),
  plan: domainZ.array(DOMAIN_ROLE_SELECTION).min(1).max(ROUTE_PLAN_LIMIT),
  tierPlanLength: domainZ.number().int().nonnegative().max(ROUTE_PLAN_LIMIT),
  candidateIndex: domainZ.number().int().nonnegative().max(ROUTE_PLAN_LIMIT - 1),
  fallbackLimit: domainZ.number().int().nonnegative().max(MAX_MODEL_FALLBACK_LIMIT),
  ordinaryFallbackLimit: domainZ.number().int().nonnegative().max(MAX_MODEL_FALLBACK_LIMIT),
  ordinaryFallback: domainZ.object({
    fromTier: domainZ.enum(["peak", "valley"]),
    toTier: domainZ.literal("normal-fallback"),
    reasonCode: domainZ.string().min(1).max(64),
  }).nullable(),
  provider: domainZ.string().min(1).max(128),
  decidedAt: domainZ.number().nonnegative(),
}).optional();
/** session_overrides 的 value 是“角色名 -> selection”字典，不是单个 selection。 */
export const DOMAIN_SESSION_OVERRIDES = domainZ.record(domainZ.string(), DOMAIN_ROLE_SELECTION);
/**
 * session_override_meta：会话覆盖的**代次**（票据 21）。
 *
 * 为什么不把 revision 塞进 session_overrides：那张表的 value 是“角色名 -> selection”
 * 的平铺字典，混入 revision 这类保留键会让旧读者（以及客户端读取面）把元数据当成
 * 一个角色名泄漏出去。独立表让旧记录继续按原形状可读（缺 meta = revision 0），
 * 也让代次栅栏与内容写入各自有明确的 durable schema。
 *
 * 只保存单调递增的代次；不保存作者、时间戳或任何决策依据。
 */
export const DOMAIN_SESSION_OVERRIDE_META = domainZ.object({
  revision: domainZ.number().int().nonnegative(),
});
/** child_models 的公开 schema seam：测试用它验证 domain adapter round-trip 不会 strip deny marker。 */
export const DOMAIN_CHILD_MODEL_RECORD = domainZ.object({
  provider: domainZ.string(),
  model: domainZ.string(),
  reasoningEffort: domainZ.string().optional(),
  // 实际路由元数据（票据 24）：与 provider/model 同层持久化，冷恢复/侧栏只读。
  ...DOMAIN_MODEL_ROUTE_FIELDS,
  // 派发路由冻结快照（票据 03）：完整计划 + 时段 + 层 + 跨层回退。缺失 = 开启峰谷前
  // 的旧记录 / 未启用峰谷的派发；读取面据此走既有重建路径，绝不按当前 settings 补齐。
  route: DOMAIN_ROUTE_SNAPSHOT,
  role: domainZ.string().optional(),
  parentId: domainZ.string().optional(),
  continuable: domainZ.boolean().optional(),
  // 目标 subagent provider（票据 29）：记录本次 child 实际使用的 provider 名
  // （"spawn" 或继承型 fork provider 的注册名）。恢复/重建只读该字段，绝不按当前
  // 设置重新选择；旧记录缺字段时按 "spawn" 处理（兼容升级前的 child）。
  subagentProvider: domainZ.string().min(1).max(128).optional(),
  // 是否继承了父会话上下文（票据 29）：true 表示该 child 必须用继承型 provider 恢复；
  // 旧记录缺字段时按 false（普通 spawn）处理。投影侧缺失时省略，绝不伪造 false。
  inheritContext: domainZ.boolean().optional(),
  // RC1 agentOptions 不由 Host recovery 持久化；保存 DEG admission 的完整 deny 边界，
  // 供 scoped guard 在 cold-resume 时恢复。长度上限与运行期校验保持一致。
  [DENY_MARKER]: domainZ.array(domainZ.string()).max(MAX_EXPERT_DENY_MARKER_ENTRIES).optional(),
  // 与 deny marker 同理：保存 admission 时解析出的完整 persona，供 cold-resume 的
  // composition 兜底重建系统提示词。设置页之后的变化只影响新 child，既有 child 必须
  // 继续使用记录值；长度上限与运行期校验（validPersonaMarker）保持一致。
  [PERSONA_MARKER]: domainZ.string().min(1).max(MAX_EXPERT_PERSONA_MARKER_CHARS).optional(),
  // shadow 生效性判定快照（与 deny/persona 同层 marker）：只用于诊断与冷会话审计，
  // 不参与权限判定。取值集合与运行期 SHADOW_STATUS 完全一致，durable schema 用同一枚举
  // 约束，避免把任意字符串写进快照（真实 storage-domain 会整条拒绝非法取值）。
  [SHADOW_MARKER]: domainZ.enum([
    SHADOW_STATUS.VERIFIED,
    SHADOW_STATUS.ABSENT,
    SHADOW_STATUS.FOREIGN,
    SHADOW_STATUS.UNAVAILABLE,
    SHADOW_STATUS.UNVERIFIED,
  ]).optional(),
  // 最近一次 accepted dispatch 的短描述用于冷会话侧栏；它不是第二套任务数据库。
  lastDispatch: domainZ.object({
    description: domainZ.string().optional(),
    prompt: domainZ.string().optional(),
    messageId: domainZ.string().optional(),
    acceptedAt: domainZ.number().int().nonnegative().optional(),
  }).optional(),
  // 角色显示名快照：历史记录在角色不再可用时仍能显示标签；
  // 与 role 同层持久化，投影只读不改写。缺失时投影回落内置目录或 null。
  roleLabel: domainZ.string().optional(),
  /**
   * 用量账本（票据 25）：可选、有界、只读持久化值。
   *
   * - 字段全部可选：旧记录/旧进程快照继续可读，缺失即省略，投影绝不补 0；
   * - token/计数只接受安全非负整数，时间只接受安全非负整数，标识字符串有长度上限；
   * - 未知字段由 domain 记录归一（zod 默认剥离），不会把任意负载写进快照；
   * - 不保存 prompt/response/凭据/逐请求明细：账本只写聚合值。
   */
  usage: domainZ.object({
    inputTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    outputTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    cacheReadTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    cacheWriteTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    reasoningTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    billedInputTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    totalTokens: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    requests: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    retries: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    fallbacks: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    provider: domainZ.string().max(128).optional(),
    model: domainZ.string().max(128).optional(),
    role: domainZ.string().max(128).optional(),
    roleLabel: domainZ.string().max(128).optional(),
    // 时间/时长允许非整数：事件 time 与派生 runMs 由宿主时钟给出，不能因为一个
    // 亚毫秒时间戳就让整条 child_models 记录在严格 domain schema 上被拒绝。
    startedAt: domainZ.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    finishedAt: domainZ.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    runMs: domainZ.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    updatedAt: domainZ.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    sampleCount: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    invalidSamples: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  /**
   * 结构化交付（票据 30）：可选、有界、只读持久化值。
   *
   * - value 只在结果 <= 64 KiB 时保存；回退时只保留 fallback/reason/bytes，不保存值；
   * - reason 只允许 shared.js 声明的稳定枚举，未知值会让整条记录被 domain 拒绝，
   *   因此写入边界必须先经过 projectStructuredResult 归一；
   * - 旧记录缺失该字段时继续可读，投影侧整体省略，绝不补一个空对象。
   */
  structured: domainZ.object({
    value: domainZ.unknown().optional(),
    bytes: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    receivedAt: domainZ.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    fallback: domainZ.boolean().optional(),
    reason: domainZ.enum(Object.values(STRUCTURED_RESULT_FALLBACK_REASONS)).optional(),
  }).optional(),
  // 是否在派发时声明过 outputSchema；只保存布尔，绝不保存 schema 原文。
  outputSchemaRequested: domainZ.boolean().optional(),
  // fan-out child 必须持久化完整来源身份；普通 child 只有 role/parentId 时不能被误路由。
  fanout: domainZ.boolean().optional(),
  fanoutParentTaskId: domainZ.string().optional(),
  fanoutParentAgentId: domainZ.string().optional(),
  fanoutShardId: domainZ.string().optional(),
  fanoutAttempt: domainZ.number().int().positive().optional(),
  // 内部 LRU 序号；历史 domain 记录没有该字段时按稳定 key 规则补齐。
  lruSequence: domainZ.number().int().nonnegative().optional(),
});
// fan-out 快照的详细 task/result 字段由 fanout.js 负责版本化；domain 只保证
// 它是 JSON 对象并把运行数据放在独立表中，绝不借用 settings。
const DOMAIN_FANOUT_SNAPSHOT = domainZ.object({
  version: domainZ.number().int().nonnegative(),
  tasks: domainZ.array(domainZ.unknown()),
}).passthrough();
/**
 * 手动派发模板（票据 28）的独立表文档。
 *
 * 形状刻意保持最小：只校验版本与“模板是对象数组”，单模板字段由组合根在写入前做
 * 严格校验（名称长度、prompt 预算、schema 64KiB、时间/并发取值）。storage domain
 * 的职责是持久化与版本化，不复制业务规则；读取面再按 {@link normalizeTemplateDocumentEntries}
 * 做有界归一，因此外部篡改不会把无界数据带进 RPC/侧栏。
 */
const DOMAIN_FANOUT_TEMPLATES = domainZ.object({
  version: domainZ.number().int().nonnegative(),
  templates: domainZ.array(domainZ.unknown()),
}).passthrough();
/**
 * 主代理模型配置的功能启用切点（B3）。
 *
 * 形状刻意最小：只有一行、只有一个可选的非负毫秒数。切点是**运行期事实**（"本功能
 * 从什么时候开始生效"），不是用户偏好，因此绝不放进 settings，也不新增文件格式——
 * 就在既有 storage domain 里多一张表（与票据 28 的模板表同一处理方式，domain 仍是 1）。
 *
 * epoch 允许非整数：宿主时钟给出的是毫秒数，但历史手工写入可能带小数；读取面只接受
 * 有限正数，非法值由 host/orchestrator-epoch 当作"还没有切点"重新初始化。
 */
const DOMAIN_ORCHESTRATOR_STATE = domainZ.object({
  epoch: domainZ.number().nonnegative().optional(),
});
export const EXPERT_STORAGE_DOMAIN_SPEC = defineDomain({
  // storage-domain 0.1.0-rc.8 的 unit 名称约束使用下划线；domain 格式保持 version 1。
  name: "dsh_expert_group",
  version: 1,
  tables: {
    session_overrides: domainTable(DOMAIN_SESSION_OVERRIDES),
    // 会话覆盖代次（票据 21 CAS 栅栏）：独立表，绝不混进 session_overrides 的角色键空间。
    session_override_meta: domainTable(DOMAIN_SESSION_OVERRIDE_META),
    child_models: domainTable(DOMAIN_CHILD_MODEL_RECORD),
    fanout_tasks: domainTable(DOMAIN_FANOUT_SNAPSHOT),
    // 手动派发模板（票据 28）：与运行数据同域、独立表，绝不把模板塞进 settings
    // 或 fanout_tasks 快照。domain version 保持 1（新增表不是破坏性变更）。
    fanout_templates: domainTable(DOMAIN_FANOUT_TEMPLATES),
    // 主代理模型配置的功能启用切点（B3）：独立表、固定一行 key="epoch"。
    // 与模板表同理——新增表不是破坏性变更，domain version 仍为 1。
    [ORCHESTRATOR_STATE_TABLE]: domainTable(DOMAIN_ORCHESTRATOR_STATE),
    /**
     * 会话删除（票据 01）的两张表：删除收敛日志与删除残渣。
     *
     * 键都是会话 ID（身份永远取自键，绝不信任记录体内的 ID 字段），值是 JSON 对象。
     * **表值 schema 刻意只约束「JSON 对象」**：宿主的 storage domain 在 open() 时会校验每
     * 一条存储记录，任何一条非法都会让整个 domain（连同 settings、child 模型等无关表）打不开；
     * 而会话删除规格要求严格区分「整份文档不可解析」（整体暂停收敛）与「记录体非法但键可读」
     * （按 intent 处理、其余条目照常）。严格形状由写入边界（host/session-delete-store 的
     * zod 校验）承担，读取面负责显式降级，理由详见 host/session-delete-contract 的模块头注释。
     *
     * 新增表不是破坏性变更：domain version 仍为 1（与 fanout_templates / orchestrator_state
     * 同一处理方式）。
     */
    [SESSION_DELETE_QUEUE_TABLE]: domainTable(DOMAIN_SESSION_DELETE_RECORD),
    [SESSION_DELETE_RESIDUE_TABLE]: domainTable(DOMAIN_SESSION_DELETE_RECORD),
  },
});

