/**
 * 派发路由冻结快照（票据 03）。
 *
 * 本模块是「一次派发的路由决定」的**唯一形状来源**：派发时构造、持久化、恢复与运行期
 * 降级都只读写这里的形状。它刻意不读 settings、不读时钟、不碰任何宿主服务——时钟由调用方
 * 取一次后以 `decidedAt` 传入（见 host/index-model-route.js），因此「派发那一刻」的语义
 * 不会被第二次取时偷偷改写。
 *
 * ## 为什么快照要扩展规格书 §5 的形状
 * 规格书 §5 把 `plan` 定义为「该层完整有序候选计划」，但同一份规格又要求「时段层候选链
 * 用尽后以普通配置作为第二层继续」（决策 7），并且「跨层回退不得把普通层候选伪装成时段层
 * 的下一个候选」（决策 6）。只给一个 `plan` 无法同时表达这三件事：拼接后的扁平计划里，
 * 时段层与普通层条目混在一起，谁也无法从数组本身判断某个下标属于哪一层。因此这里在
 * **不改变任何既有字段语义**的前提下增加两个字段：
 *
 * - `tierPlanLength`：扁平 `plan` 中属于**时段层**的条目数（时段层条目在前、普通回退层
 *   条目在后）。`normal-override` 时它等于 `plan.length`（整份计划都是普通配置）；
 *   角色缺配直接跨层（`PEAK_VALLEY_ROLE_MISSING`）时它是 0（`plan` 只有普通层）。
 * - `ordinaryFallbackLimit`：普通回退层自己的降级上限。两层各有独立预算，若只保存一个
 *   `fallbackLimit`，「切层后预算」就只能靠当前 settings 猜——那正是本票据要消除的重建面。
 *
 * 另有两个**语义澄清**（不是新增字段，但必须写清）：
 * 1. `candidateIndex` 永远是**当前活动层内**的索引；跨层时归零。因此「活动选择」不是
 *    `plan[candidateIndex]`，而是 `plan[layerOffset + candidateIndex]`，其中
 *    `layerOffset = tier === "normal-fallback" ? tierPlanLength : 0`。
 * 2. `provider` 是当前活动层当前候选的 provider（名额归属），因此它必须与上面那条
 *    「活动选择」一致；快照校验把它当作不变量而不是独立输入。
 *
 * ## 长度上限
 * 每层计划 = 1 个主模型 + 最多 3 个候选 = 4 项（`MAX_MODEL_CANDIDATES_PER_ROLE`），
 * 时段层叠加普通回退层，因此扁平 `plan` 的上限是 **8 项**。超限一律判非法并 fail-closed，
 * 绝不截断、绝不重排——截断会让「第 5 个候选」悄悄变成另一个模型。
 *
 * 纯函数、无状态、无宿主依赖；不提供 `create*` 工厂。
 *
 * @module dsh-expert-group/shared/route-snapshot
 */
import { MAX_MODEL_FALLBACK_LIMIT, normalizeModelSelection } from "./model-route.js";

/** 派发时刻的墙钟时段；未启用峰谷时为 "none"。 */
export const ROUTE_PERIODS = Object.freeze(["peak", "valley", "none"]);

/** 实际使用的层：峰时层 / 谷时层 / 会话覆盖（普通配置）/ 跨层回退到普通配置。 */
export const ROUTE_TIERS = Object.freeze(["peak", "valley", "normal-override", "normal-fallback"]);

/** 扁平候选计划长度上限（时段层 4 项 + 普通回退层 4 项）。 */
export const ROUTE_PLAN_LIMIT = 8;

/** 快照形状非法时的稳定错误码（恢复/运行期据此 fail-closed，不静默重选）。 */
export const ROUTE_SNAPSHOT_INVALID = "ROUTE_SNAPSHOT_INVALID";

/**
 * 时段层没有该角色的主模型时直接跨层的稳定原因码。
 *
 * 与 `MODEL_CANDIDATES_EXHAUSTED`（层内候选真的试过并且都失败）区分：前者是「这一层根本
 * 没配」，后者是「配了但都不可用」，诊断与排障路径不同。
 */
export const PEAK_VALLEY_ROLE_MISSING = "PEAK_VALLEY_ROLE_MISSING";

/** 单层条目上限（1 主模型 + 3 候选）；用于校验两层各自的边界。 */
const LAYER_PLAN_LIMIT = 4;

/** 当前活动层在扁平 plan 里的起点：只有「跨层回退」态才需要跳过时段层条目。 */
function layerOffsetOf(tier, tierPlanLength) {
  return tier === "normal-fallback" ? tierPlanLength : 0;
}

/** 稳定错误码结果（每次新建对象，调用方可安全持有）。 */
function invalidSnapshot(reason) {
  return { ok: false, code: ROUTE_SNAPSHOT_INVALID, reason };
}

/**
 * 校验层级布局：`tierPlanLength` 必须与 tier 自洽，且两层各自不超过 4 项。
 *
 * @returns {{ok:true, offset:number, layerLength:number}|{ok:false, reason:string}}
 */
function readLayerLayout(tier, tierPlanLength, planLength) {
  if (!Number.isSafeInteger(tierPlanLength) || tierPlanLength < 0 || tierPlanLength > planLength) {
    return { ok: false, reason: "tierPlanLength 必须是 0..plan.length 的整数" };
  }
  const ordinaryLength = planLength - tierPlanLength;
  if (tier === "peak" || tier === "valley") {
    if (tierPlanLength < 1) return { ok: false, reason: "时段层计划不能为空" };
    if (tierPlanLength > LAYER_PLAN_LIMIT) return { ok: false, reason: "时段层计划不得超过 4 项" };
    if (ordinaryLength > LAYER_PLAN_LIMIT) return { ok: false, reason: "普通回退层计划不得超过 4 项" };
    return { ok: true, offset: 0, layerLength: tierPlanLength };
  }
  if (tier === "normal-override") {
    // 会话覆盖完全不进入时段层：整份计划都是普通配置，tierPlanLength 必须等于 plan.length。
    if (tierPlanLength !== planLength) return { ok: false, reason: "normal-override 的 tierPlanLength 必须等于 plan.length" };
    if (planLength > LAYER_PLAN_LIMIT) return { ok: false, reason: "normal-override 计划不得超过 4 项" };
    return { ok: true, offset: 0, layerLength: planLength };
  }
  // normal-fallback：活动层是普通层。tierPlanLength 记录扁平 plan 里前置的时段层条目数
  // （角色缺配直接跨层时为 0，运行期切层时等于时段层实际长度）。
  if (ordinaryLength < 1) return { ok: false, reason: "normal-fallback 必须至少有一个普通层条目" };
  if (ordinaryLength > LAYER_PLAN_LIMIT) return { ok: false, reason: "普通回退层计划不得超过 4 项" };
  if (tierPlanLength > LAYER_PLAN_LIMIT) return { ok: false, reason: "时段层计划不得超过 4 项" };
  return { ok: true, offset: tierPlanLength, layerLength: ordinaryLength };
}

/**
 * 归一 `ordinaryFallback`：只有值确实存在时才接受对象，字段封闭。
 *
 * `fromTier` 只允许 peak / valley：这条回退信息描述的是「从哪一个时段层掉下来」，
 * 未启用峰谷（period "none"）时根本不会产生跨层回退。
 *
 * @returns {{ok:true, value:object|null}|{ok:false, reason:string}}
 */
function readOrdinaryFallback(value) {
  if (value === void 0 || value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "ordinaryFallback 必须是对象或 null" };
  const fromTier = value.fromTier;
  if (fromTier !== "peak" && fromTier !== "valley") {
    return { ok: false, reason: "ordinaryFallback.fromTier 必须是 peak/valley" };
  }
  if (value.toTier !== "normal-fallback") {
    return { ok: false, reason: "ordinaryFallback.toTier 必须是 normal-fallback" };
  }
  const reasonCode = value.reasonCode;
  if (typeof reasonCode !== "string" || reasonCode.length === 0 || reasonCode.length > 64) {
    return { ok: false, reason: "ordinaryFallback.reasonCode 必须是长度 1..64 的字符串" };
  }
  return { ok: true, value: Object.freeze({ fromTier, toTier: "normal-fallback", reasonCode }) };
}

/**
 * 构造并冻结一份路由快照（派发期与运行期写进度的唯一构造入口）。
 *
 * - `plan` 逐项走 `normalizeModelSelection` 归一；任一项非法则整体返回 null（不截断、
 *   不丢弃坏项）；顺序与内容原样保留。
 * - `provider` 由调用方忽略输入，一律从「活动层活动候选」派生：名额归属必须与快照里
 *   真正会被使用的模型一致，否则 provider 限流会记到另一个模型名下。
 * - `ordinaryFallback` 与 tier 必须自洽（见 readOrdinaryFallback / readLayerLayout）。
 *
 * @param {object} input - { period, tier, plan, tierPlanLength, candidateIndex?, fallbackLimit,
 *   ordinaryFallbackLimit?, ordinaryFallback?, decidedAt }（`provider` 由本函数派生）。
 * @returns {object|null} 冻结快照；任一边界不成立时返回 null（调用方应按 fail-closed 处理）。
 */
export function buildRouteSnapshot(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const { period, tier, decidedAt } = input;
  if (!ROUTE_PERIODS.includes(period)) return null;
  if (!ROUTE_TIERS.includes(tier)) return null;
  if (typeof decidedAt !== "number" || !Number.isFinite(decidedAt) || decidedAt < 0) return null;
  const rawPlan = input.plan;
  if (!Array.isArray(rawPlan) || rawPlan.length === 0 || rawPlan.length > ROUTE_PLAN_LIMIT) return null;
  const plan = [];
  for (const entry of rawPlan) {
    const normalized = normalizeModelSelection(entry);
    if (normalized === undefined) return null;
    plan.push(Object.freeze({ ...normalized }));
  }
  const layout = readLayerLayout(tier, input.tierPlanLength, plan.length);
  if (layout.ok !== true) return null;
  const candidateIndex = input.candidateIndex === void 0 ? 0 : input.candidateIndex;
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= layout.layerLength) {
    return null;
  }
  const fallbackLimit = input.fallbackLimit;
  const ordinaryFallbackLimit = input.ordinaryFallbackLimit === void 0 ? fallbackLimit : input.ordinaryFallbackLimit;
  if (!Number.isSafeInteger(fallbackLimit) || fallbackLimit < 0 || fallbackLimit > MAX_MODEL_FALLBACK_LIMIT) return null;
  if (!Number.isSafeInteger(ordinaryFallbackLimit) || ordinaryFallbackLimit < 0 || ordinaryFallbackLimit > MAX_MODEL_FALLBACK_LIMIT) {
    return null;
  }
  const fallback = readOrdinaryFallback(input.ordinaryFallback);
  if (fallback.ok !== true) return null;
  if (tier === "normal-fallback" && fallback.value === null) return null;
  if (tier !== "normal-fallback" && fallback.value !== null) return null;
  const activeSelection = plan[layout.offset + candidateIndex];
  return Object.freeze({
    period,
    tier,
    plan: Object.freeze(plan),
    // 时段层长度（扁平 plan 的前缀长度）；普通层的起点由它派生，见模块头注释。
    tierPlanLength: input.tierPlanLength,
    candidateIndex,
    fallbackLimit,
    ordinaryFallbackLimit,
    ordinaryFallback: fallback.value,
    provider: activeSelection.provider,
    decidedAt,
  });
}

/**
 * 严格校验一份快照（持久化读回、agentOptions marker、fanout attempt 三处共用）。
 *
 * 与 buildRouteSnapshot 的差别只在**入口语义**：这里不修复、不归一任何越界字段，任何
 * 结构/枚举/边界不成立都返回稳定错误码。调用方必须把 `ok:false` 当作 fail-closed
 * （不降级、不静默按当前配置重选），而不是「当成缺失」继续走旧重建路径。
 *
 * @param {unknown} value - 待校验值。
 * @returns {{ok:true, snapshot:object}|{ok:false, code:string, reason:string}}
 */
export function normalizeRouteSnapshot(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidSnapshot("路由快照必须是对象");
  }
  const rebuilt = buildRouteSnapshot(value);
  if (rebuilt === null) return invalidSnapshot("路由快照字段不合法或超出边界");
  return { ok: true, snapshot: rebuilt };
}

/**
 * 读取快照里**当前活动层当前候选**的选择。
 *
 * @param {object} snapshot - 已归一的快照。
 * @returns {{provider:string, model:string, reasoningEffort?:string}|undefined}
 */
export function routeSnapshotActiveSelection(snapshot) {
  const layout = readLayerLayout(snapshot?.tier, snapshot?.tierPlanLength, Array.isArray(snapshot?.plan) ? snapshot.plan.length : 0);
  if (layout.ok !== true) return undefined;
  const index = snapshot.candidateIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index >= layout.layerLength) return undefined;
  const selection = snapshot.plan[layout.offset + index];
  return selection === void 0 ? undefined : { ...selection };
}

/**
 * agentOptions marker 形状（JSON 安全、深拷贝）。
 *
 * marker 只存在于 agent options 与 child_models，不进入任务 prompt；拷贝是为了让 Host 侧
 * 后续修改不会污染派发期冻结的对象，同时保持「marker 是纯数据」这一既有约定。
 *
 * @param {unknown} snapshot - 待写入 marker 的快照。
 * @returns {object|undefined} 可序列化副本；非法快照返回 undefined（绝不写半截 marker）。
 */
export function routeSnapshotMarkerOf(snapshot) {
  const normalized = normalizeRouteSnapshot(snapshot);
  if (normalized.ok !== true) return undefined;
  const { snapshot: value } = normalized;
  return {
    period: value.period,
    tier: value.tier,
    plan: value.plan.map((entry) => ({ ...entry })),
    tierPlanLength: value.tierPlanLength,
    candidateIndex: value.candidateIndex,
    fallbackLimit: value.fallbackLimit,
    ordinaryFallbackLimit: value.ordinaryFallbackLimit,
    ordinaryFallback: value.ordinaryFallback === null ? null : { ...value.ordinaryFallback },
    provider: value.provider,
    decidedAt: value.decidedAt,
  };
}

/** ordinaryFallback 对外投影允许附带的具体角色 id 的长度上限（角色名属公开配置）。 */
const ROUTE_PROJECTION_ROLE_MAX_LENGTH = 64;

/**
 * 投影面角色 id 归一：只去控制字符、trim 并限长，**不引入字符白名单**。
 *
 * 为什么不用 token 白名单：角色 id 属于用户可见的公开配置（含自定义角色），过滤字符面会
 * 让合法角色在回执里静默消失；这里要防的只有「把多行文本/超长正文塞进投影」。
 *
 * @param {unknown} value - 调用方从记录/工具入参带出的角色 id。
 * @returns {string|undefined} 归一后的角色 id；缺失/空串时 undefined（整字段省略）。
 */
function projectionRoleId(value) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, ROUTE_PROJECTION_ROLE_MAX_LENGTH);
}

/**
 * ordinaryFallback 的对外形状（快照字段 + 可选的具体角色）。
 *
 * 快照本身**不含 role**：角色不是路由决定的一部分，它由投影/回执调用方从记录或工具入参
 * 带出。因此这里只在调用方确实给出角色时附加字段，绝不猜一个角色。
 */
function ordinaryFallbackProjection(fallback, roleId) {
  return {
    fromTier: fallback.fromTier,
    toTier: fallback.toTier,
    reasonCode: fallback.reasonCode,
    ...(roleId === undefined ? {} : { role: roleId }),
  };
}

/**
 * 共享路由投影的时段/层/跨层回退字段（票据 06 的读面契约来源）。
 *
 * 只输出三个字段，**绝不输出 plan / provider / 凭据**：投影面（侧栏、回执、诊断）只需要
 * 「这次派发落在哪个时段、实际用了哪一层、有没有跨层回退」，完整计划属于执行快照，
 * 不对外泄漏候选清单。
 *
 * 入参接受两种形态，顺序固定：
 * 1. 快照形态：记录里带 `route`（child_models / attempt），或传入的就是快照本身——
 *    走 `normalizeRouteSnapshot` 严格校验，非法快照整体返回空对象；
 * 2. 已展开形态：`routePeriod`/`routeTier`/`ordinaryFallback` 已经在记录上（stage 合并点、
 *    回执副本、旧客户端快照）——逐字段白名单校验，不合法的那一项**直接省略**，绝不补默认值。
 *
 * @param {unknown} source - child_models/attempt 记录（含 `route`）、快照本身或已展开的记录。
 * @param {unknown} [role] - 可选的具体角色 id；只在存在跨层回退时附加到 ordinaryFallback。
 * @returns {object} 投影字段；非法/缺失时返回空对象（绝不补默认值）。
 */
export function projectRouteSnapshotFields(source, role) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const roleId = projectionRoleId(role);
  const candidate = source.route === void 0 ? source : source.route;
  const normalized = normalizeRouteSnapshot(candidate);
  if (normalized.ok === true) {
    const { snapshot } = normalized;
    return {
      routePeriod: snapshot.period,
      routeTier: snapshot.tier,
      ...(snapshot.ordinaryFallback === null
        ? {}
        : { ordinaryFallback: ordinaryFallbackProjection(snapshot.ordinaryFallback, roleId) }),
    };
  }
  const projected = {};
  if (ROUTE_PERIODS.includes(source.routePeriod)) projected.routePeriod = source.routePeriod;
  if (ROUTE_TIERS.includes(source.routeTier)) projected.routeTier = source.routeTier;
  const fallback = readOrdinaryFallback(source.ordinaryFallback);
  if (fallback.ok === true && fallback.value !== null) {
    // 已展开形态可能自己就带着角色（回执副本再投影）：显式入参优先，其次沿用已归一的值。
    const fallbackRole = roleId ?? projectionRoleId(source.ordinaryFallback.role);
    projected.ordinaryFallback = ordinaryFallbackProjection(fallback.value, fallbackRole);
  }
  return projected;
}

/**
 * 生成「写进度的新快照」：运行期降级推进候选/切层时使用。
 *
 * - 传入非空 `ordinaryFallback` 且当前层是时段层时，自动切换到 `normal-fallback`，
 *   这正是「时段层耗尽 → 普通层继续」的唯一表达方式（tier 不是独立参数，避免出现
 *   「tier 已切但 ordinaryFallback 没写」的半套进度）。
 * - `fallbackCount` 由调用方直接写进 child_models 的既有扁平字段；快照形状刻意不新增
 *   该键，保证「降级次数」只有一个事实源（child_models.attempt / 记录扁平字段）。
 * - 非法输入返回 null：调用方必须把它当作不可推进（fail-closed），绝不退化成"按当前配置
 *   重新选一个模型"。
 *
 * @param {unknown} snapshot - 当前快照（已归一的形状）。
 * @param {{candidateIndex?:number, fallbackCount?:number, ordinaryFallback?:object|null}} progress
 * @returns {object|null} 新的冻结快照。
 */
export function advanceRouteSnapshot(snapshot, progress) {
  const normalized = normalizeRouteSnapshot(snapshot);
  if (normalized.ok !== true) return null;
  const base = normalized.snapshot;
  const nextIndex = progress?.candidateIndex === void 0 ? base.candidateIndex : progress.candidateIndex;
  const nextFallback = progress?.ordinaryFallback === void 0 ? base.ordinaryFallback : progress.ordinaryFallback;
  const switchingLayer = nextFallback !== null && nextFallback !== void 0
    && (base.tier === "peak" || base.tier === "valley");
  return buildRouteSnapshot({
    period: base.period,
    tier: switchingLayer ? "normal-fallback" : base.tier,
    plan: base.plan,
    tierPlanLength: base.tierPlanLength,
    candidateIndex: nextIndex,
    fallbackLimit: switchingLayer ? base.ordinaryFallbackLimit : base.fallbackLimit,
    ordinaryFallbackLimit: base.ordinaryFallbackLimit,
    ordinaryFallback: nextFallback,
    decidedAt: base.decidedAt,
  });
}
