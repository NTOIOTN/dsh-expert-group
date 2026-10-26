/**
 * 峰谷时段派发选路与路由快照冻结（票据 03）。
 *
 * 从 host/index-model-route.js 拆出：该文件已到 1,500 行门禁，而「按时段选路」本身是
 * 一个独立关注点（读设置快照、判时段、拼两层计划、冻结快照、fail-closed）。
 *
 * 本模块**不持有状态**：时钟、设置快照、ValidationError 构造器与 executeModelRoutePlan
 * 都由调用方作为上下文传入，因此它既能被组合根使用，也不会在模块级缓存任何设置。
 *
 * ## 语义（规格书决策 1 / 5 / 6 / 7）
 * - 未启用峰谷：调用方根本不进入本模块（旧行为逐字保持）；
 * - 会话覆盖命中：tier=normal-override，直接用普通配置候选链，period 仍记录当时墙钟；
 * - 无覆盖：tier=period，使用该时段 profile 的计划；时段层之后拼接普通层作为**显式**
 *   跨层回退源，角色缺配时直接从普通层开始并写 PEAK_VALLEY_ROLE_MISSING；
 * - 两条路径共用同一个快照形状（shared/route-snapshot.js），candidateIndex 始终层内索引。
 *
 * @module dsh-expert-group/host/peak-valley-route
 */
import { peakValleyAtDate } from "../shared/peak-valley-time.js";
import {
  MODEL_CANDIDATES_EXHAUSTED,
  buildModelRoutePlan,
  modelRouteKeyOf,
  normalizeModelFallbackLimit,
  normalizeModelSelection,
} from "../shared/model-route.js";
import {
  PEAK_VALLEY_ROLE_MISSING,
  ROUTE_SNAPSHOT_INVALID,
  buildRouteSnapshot,
  routeSnapshotActiveSelection,
} from "../shared/route-snapshot.js";
import { PEAK_VALLEY_ERROR_CODES, PEAK_VALLEY_STATE_INVALID } from "./peak-valley-settings.js";
import { noteRouteOrdinaryFallback } from "./route-diagnostics.js";

/**
 * 峰谷 profile 的只读内部视图（provider / defaults / candidates / fallbackLimit）。
 *
 * 与普通配置的读取面同形，因此计划构造可以复用同一个 buildModelRoutePlan——**不复制**
 * 候选链语义（去重、effort-only 跳过、candidateIndex 原始位置都由它决定）。
 *
 * @param {unknown} profile - settings.peakValley.peak / .valley。
 * @returns {{provider:string, defaults:object, candidates:object, fallbackLimit:number}}
 */
function profileRouteViewOf(profile) {
  const source = profile !== null && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  return {
    provider: typeof source.provider === "string" ? source.provider : "",
    defaults: isMap(source.defaults) ? source.defaults : {},
    candidates: isMap(source.candidates) ? source.candidates : {},
    fallbackLimit: normalizeModelFallbackLimit(source.fallbackLimit),
  };
}

/**
 * 峰谷配置的「启用但非法」稳定码（票据 02 的读取归一写入 invalidCode）。
 *
 * 两条件并列：只有 enabled === true 时才可能走到这里；invalidCode 非空即表示时段/profile
 * 结构非法。派发路径必须据此 fail-closed，绝不静默降级成普通配置。
 *
 * @param {unknown} peakValley - settings.peakValley 的归一快照。
 * @returns {string|undefined} 稳定错误码；合法或缺失时 undefined。
 */
function peakValleyInvalidCodeOf(peakValley) {
  const code = peakValley?.invalidCode;
  if (typeof code !== "string" || code.length === 0) return undefined;
  // 协议面只接受封闭枚举（LOW 回归）：历史/外部文档可能写进任意 invalidCode，而它会被
  // 原样写进 ValidationError.code 与 fanout 的 {ok:false, code}。未知值统一收敛为
  // PEAK_VALLEY_STATE_INVALID，派发仍然 fail-closed，但客户端只见到可分支的稳定码。
  return PEAK_VALLEY_ERROR_CODES.includes(code) ? code : PEAK_VALLEY_STATE_INVALID;
}

/**
 * 普通配置（全局 defaults/candidates/fallbackLimit）在某角色上的只读视图。
 *
 * 与 profile 视图同形，因此两层可以共用 buildModelRoutePlan——会话覆盖的候选链、跨层回退
 * 的计划都来自同一处语义，不出现第二份候选规则。async 路径与同步冻结路径共用本函数。
 *
 * @param {object} settingsSnapshot - 同一代读的设置快照。
 * @param {string} role - 角色 id。
 * @returns {{defaults:object, candidates:object, fallbackLimit:number}} profile 视图。
 */
function ordinaryRouteViewOf(settingsSnapshot, role) {
  return {
    defaults: { [role]: settingsSnapshot?.defaults?.[role] },
    candidates: {
      [role]: Array.isArray(settingsSnapshot?.candidates?.[role]) ? settingsSnapshot.candidates[role] : [],
    },
    fallbackLimit: normalizeModelFallbackLimit(settingsSnapshot?.fallbackLimit),
  };
}

/**
 * 按一套 profile 构造某角色的有序计划；该 profile 没有配置该角色主模型时返回 null。
 *
 * 返回 null 而不是「用空计划继续跑」：空计划在下游会被当成「所有候选都不可用」，
 * 而这里的真实含义是「这一层根本没配」，两者必须区分（见 PEAK_VALLEY_ROLE_MISSING）。
 *
 * @param {object} view - profileRouteViewOf 的结果。
 * @param {string} role - 角色 id。
 * @returns {{plan:Array<object>, requestedPrimary:object|undefined, fallbackLimit:number}|null}
 */
function profileModelPlanOf(view, role) {
  const primary = view.defaults[role];
  if (normalizeModelSelection(primary) === undefined) return null;
  const candidates = Array.isArray(view.candidates[role]) ? view.candidates[role] : [];
  return buildModelRoutePlan(primary, candidates, view.fallbackLimit);
}

/**
 * 把「本次派发已跨层」这一事实写进诊断单值（票据 06）。
 *
 * 只读快照里的 ordinaryFallback：没有跨层就什么都不写（覆盖语义要求「只有真的回退过才更新」）。
 * role 来自调用方的派发入参，绝不从计划或快照里猜。
 *
 * @param {unknown} role - 本次派发的角色 id。
 * @param {object} snapshot - 已确认有效的冻结快照。
 * @param {number} decidedAt - 快照的派发判定时刻（诊断 at 用同一时间，天然有界）。
 * @returns {void}
 */
function recordOrdinaryFallback(role, snapshot, decidedAt) {
  const fallback = snapshot?.ordinaryFallback;
  if (fallback === null || fallback === undefined) return;
  noteRouteOrdinaryFallback({
    role,
    fromTier: fallback.fromTier,
    toTier: fallback.toTier,
    reasonCode: fallback.reasonCode,
    at: decidedAt,
  });
}

/**
 * 把执行结果里的**原始候选位置**映射成当前活动层内的紧凑位置（票据 03 / HIGH-1）。
 *
 * 为什么必须映射：`buildModelRoutePlan` 的 `candidateIndex` 是「候选在原始配置里的位置」
 * （primary=0、第一个候选=1），而 effort-only 重复项会被**跳过**且不占位，于是原始位置会
 * 出现空洞（例如 0、2）。快照的 `candidateIndex` 语义完全不同：它是**当前活动层内**的紧凑
 * 索引（0..layerLength-1），跨层时以 `layerOffset` 为基准。直接把原始位置写进快照，会让
 * 合法的备用候选被 `buildRouteSnapshot` 判成越界，从而把整次派发 fail-closed 掉。
 *
 * 匹配口径是 `modelRouteKeyOf`（provider+model，刻意忽略 effort），与「候选链只按模型切换」
 * 同一身份键；`buildModelRoutePlan` 的同键去重保证层内唯一，因此这里的首次命中就是答案。
 * 匹配不到（空键 / 不可能的组合）返回 -1，由 `buildRouteSnapshot` 判非法并 fail-closed，
 * 绝不猜一个位置。
 *
 * @param {Array<{selection: object, tier?: string}>} plan - 扁平计划（时段层在前、普通层在后）。
 * @param {string} tier - 实际命中的层（peak / valley / normal-override / normal-fallback）。
 * @param {number} tierPlanLength - 扁平计划里时段层的条目数（普通层的层内偏移）。
 * @param {unknown} selection - 本次真正选中的模型选择。
 * @returns {number} 层内紧凑索引；无法定位时 -1。
 */
function compactCandidateIndexInLayer(plan, tier, tierPlanLength, selection) {
  if (!Array.isArray(plan)) return -1;
  // 只有跨层回退态的活动层在时段层之后；normal-override 与时段层本身都从 0 开始。
  const layerOffset = tier === "normal-fallback" ? tierPlanLength : 0;
  const key = modelRouteKeyOf(selection);
  if (key.length === 0) return -1;
  const index = plan.slice(layerOffset).findIndex((item) => modelRouteKeyOf(item?.selection) === key);
  return index;
}

/**
 * 执行分层计划并把结果冻结成快照（票据 03 的唯一收口点）。
 *
 * 跨层判定只看「实际成功的条目属于哪一层」：条目在时段层成功 → tier=period；
 * 条目在普通层成功 → tier=normal-fallback 且写入 ordinaryFallback。因此
 * 「时段层耗尽后回退普通层」与「时段层缺配直接回退」共用同一条构造路径。
 *
 * @param {object} input - 计划、时段、历次判定时刻与执行上下文。
 * @returns {Promise<object>} 既有 route 字段 + 冻结快照。
 */
async function finishPeakValleyRoute(input) {
  const executed = await input.executeModelRoutePlan(input.planInfo, input.signal, input.requirements);
  const activeTier = executed.tier;
  const crossLayer = activeTier === "normal-fallback";
  const ordinaryFallback = crossLayer
    ? (input.ordinaryFallback ?? {
      fromTier: input.period,
      toTier: "normal-fallback",
      // 时段层真的试过并全部失败 → 既有「候选耗尽」码；时段层为空 → 缺配码（上一分支已显式给出）。
      reasonCode: input.tierPlanLength > 0 ? MODEL_CANDIDATES_EXHAUSTED : PEAK_VALLEY_ROLE_MISSING,
    })
    : null;
  const fallbackLimit = crossLayer ? input.ordinaryFallbackLimit : input.currentFallbackLimit;
  // HIGH-1：executed.candidateIndex 是**原始配置位置**（见 buildModelRoutePlan），快照要求的是
  // **层内紧凑索引**。这里换取紧凑值，原始值继续留在 executed.candidateIndex 上供扁平
  // 模型路由 marker 使用（两处语义刻意不同，不能互相顶替）。
  const compactCandidateIndex = compactCandidateIndexInLayer(
    input.planInfo.plan,
    activeTier,
    input.tierPlanLength,
    executed.selection,
  );
  const snapshot = buildRouteSnapshot({
    period: input.period,
    tier: activeTier,
    plan: input.planInfo.plan.map((item) => item.selection),
    tierPlanLength: input.tierPlanLength,
    candidateIndex: compactCandidateIndex,
    fallbackLimit,
    ordinaryFallbackLimit: input.ordinaryFallbackLimit,
    ordinaryFallback,
    decidedAt: input.decidedAt,
  });
  // 防御性不变量：快照里的活动候选必须就是本次真正选中的 provider/model。
  // 不成立时 fail-closed（绝不把「快照说 A、实际用 B」带到运行期与持久化）。
  const active = snapshot === null ? undefined : routeSnapshotActiveSelection(snapshot);
  if (active === undefined
    || active.provider !== executed.selection.provider
    || active.model !== executed.selection.model) {
    const error = new input.ValidationError("派发路由快照非法，已拒绝派发");
    error.code = ROUTE_SNAPSHOT_INVALID;
    throw error;
  }
  // 跨层回退诊断（票据 06）：只有快照确认自洽之后才记录——被拒绝的派发不构成「发生过回退」。
  recordOrdinaryFallback(input.role, snapshot, input.decidedAt);
  return { ...executed, fallbackLimit, snapshot };
}

/**
 * 启用峰谷时的派发路由与快照冻结（票据 03）。
 *
 * fail-closed：
 * - 已启用但读取归一带回 invalidCode（时段/profile/状态非法）→ 直接抛带稳定 code 的
 *   ValidationError，绝不降级成普通配置（那会让"配置坏了"表现为"悄悄换了一套模型"）；
 * - 组装出的快照非法（理论上不可达，防御性判定）→ 抛 ROUTE_SNAPSHOT_INVALID。
 *
 * @param {object} context - { role, sessionId, signal, requirements, settingsSnapshot,
 *   clock, ValidationError, executeModelRoutePlan }；settingsSnapshot 必须是**同一代读**的设置快照。
 * @returns {Promise<object|null>} 既有 route 字段 + snapshot；两层都没有主模型时返回 null。
 */
export async function resolvePeakValleyRoute(context) {
  const { role, sessionId, signal, requirements, settingsSnapshot, clock, ValidationError, executeModelRoutePlan } = context;
  const peakValley = settingsSnapshot?.peakValley ?? {};
  const invalidCode = peakValleyInvalidCodeOf(peakValley);
  if (invalidCode !== void 0) {
    const error = new ValidationError("峰谷配置无效，已拒绝派发");
    error.code = invalidCode;
    throw error;
  }
  // 一次派发只取一次时钟：同一时间戳既判定 period，又写快照 decidedAt。
  const decidedAt = clock.now();
  const period = peakValleyAtDate(peakValley.periods, new Date(decidedAt));
  const ordinaryView = ordinaryRouteViewOf(settingsSnapshot, role);
  const ordinaryCandidates = ordinaryView.candidates[role];
  const ordinaryFallbackLimit = ordinaryView.fallbackLimit;
  // role 只服务跨层回退诊断（票据 06）：随 execute 一起传给 finishPeakValleyRoute，不进入快照。
  const execute = { role, executeModelRoutePlan, signal, requirements };
  // 会话覆盖命中：完全不进入峰谷层（不得混用峰时候选）。
  const overrideSelection = normalizeModelSelection(settingsSnapshot?.sessionOverrides?.[sessionId]?.[role]);
  if (overrideSelection !== undefined) {
    const overridePlan = buildModelRoutePlan(overrideSelection, ordinaryCandidates, ordinaryFallbackLimit);
    return finishPeakValleyRoute({
      ...execute,
      planInfo: {
        plan: overridePlan.plan.map((item) => ({ ...item, tier: "normal-override" })),
        requestedPrimary: overridePlan.requestedPrimary,
      },
      period,
      decidedAt,
      tierPlanLength: overridePlan.plan.length,
      currentFallbackLimit: overridePlan.fallbackLimit,
      ordinaryFallbackLimit: overridePlan.fallbackLimit,
      ordinaryFallback: null,
      ValidationError,
    });
  }
  const profilePlan = profileModelPlanOf(profileRouteViewOf(peakValley[period]), role);
  const ordinaryPlan = profileModelPlanOf(ordinaryView, role);
  if (profilePlan === null) {
    // 时段层该角色缺配：直接跨层（普通层也没有主模型时保持既有 NOT_CONFIGURED 语义）。
    if (ordinaryPlan === null) return null;
    return finishPeakValleyRoute({
      ...execute,
      planInfo: {
        plan: ordinaryPlan.plan.map((item) => ({ ...item, tier: "normal-fallback" })),
        requestedPrimary: ordinaryPlan.requestedPrimary,
      },
      period,
      decidedAt,
      tierPlanLength: 0,
      currentFallbackLimit: ordinaryPlan.fallbackLimit,
      ordinaryFallbackLimit: ordinaryPlan.fallbackLimit,
      ordinaryFallback: { fromTier: period, toTier: "normal-fallback", reasonCode: PEAK_VALLEY_ROLE_MISSING },
      ValidationError,
    });
  }
  // 时段层条目在前、普通回退层条目在后；两层各自保留层内候选位置（primary=0）。
  const flatPlan = profilePlan.plan.map((item) => ({ ...item, tier: period }));
  if (ordinaryPlan !== null) {
    for (const item of ordinaryPlan.plan) flatPlan.push({ ...item, tier: "normal-fallback" });
  }
  return finishPeakValleyRoute({
    ...execute,
    planInfo: { plan: flatPlan, requestedPrimary: profilePlan.requestedPrimary },
    period,
    decidedAt,
    tierPlanLength: profilePlan.plan.length,
    currentFallbackLimit: profilePlan.fallbackLimit,
    ordinaryFallbackLimit: ordinaryPlan === null ? profilePlan.fallbackLimit : ordinaryPlan.fallbackLimit,
    ordinaryFallback: null,
    ValidationError,
  });
}

/**
 * 由一层有序计划构造「派发时刻」的冻结结果（同步路径的唯一收口点）。
 *
 * 与 async 路径的差别只在**入口语义**：这里没有执行结果可读，因此候选位置固定为活动层的
 * 第 0 项（派发就是从该层主模型开始试），层标与计划长度全部来自构造输入。快照形状仍由
 * shared/route-snapshot.js 校验，非法即返回稳定错误码（调用方 fail-closed）。
 *
 * @param {object} input - period / tier / plan / tierPlanLength / fallbackLimit /
 *   ordinaryFallbackLimit / ordinaryFallback / decidedAt。
 * @returns {{ok:true, snapshot:object, selection:object}|{ok:false, code:string}}
 */
function dispatchRouteOf(input) {
  const snapshot = buildRouteSnapshot({
    period: input.period,
    tier: input.tier,
    // buildModelRoutePlan 的条目是 { selection, candidateIndex }；快照只保存选择本身，
    // 层内位置由快照的 candidateIndex 统一表达（派发时刻恒为活动层第 0 项）。
    plan: input.plan.map((item) => item.selection),
    tierPlanLength: input.tierPlanLength,
    candidateIndex: 0,
    fallbackLimit: input.fallbackLimit,
    ordinaryFallbackLimit: input.ordinaryFallbackLimit,
    ordinaryFallback: input.ordinaryFallback,
    decidedAt: input.decidedAt,
  });
  if (snapshot === null) return { ok: false, code: ROUTE_SNAPSHOT_INVALID };
  const selection = routeSnapshotActiveSelection(snapshot);
  if (selection === undefined) return { ok: false, code: ROUTE_SNAPSHOT_INVALID };
  // 跨层回退诊断（票据 06）：同步冻结路径与异步路径共用同一记录口径（见 finishPeakValleyRoute）。
  recordOrdinaryFallback(input.role, snapshot, input.decidedAt);
  return { ok: true, snapshot, selection };
}

/**
 * 同步构造一次派发的冻结路由（fan-out 等不能在派发前 await 的路径，票据 03）。
 *
 * 与 {@link resolvePeakValleyRoute} 的语义一一对应，但**不做任何异步前置**：
 * - 不调用 executeModelRoutePlan、不查模型目录：设置保存时已经校验过模型，派发阶段只
 *   冻结「若此刻开始执行会按什么顺序试」；真正的可用性由运行期降级/宿主重试承担；
 * - provider 预检退化为**同步字符串判断**（计划里第一项的 provider），绝不再触发目录查询。
 *
 * 三个返回分支（调用方必须分别处理，不得混用）：
 * - `null`：峰谷未启用，或（已启用但）两层都没有该角色主模型——调用方保持旧路径
 *   （旧路径本身会给出既有 NOT_CONFIGURED 文案，不能在这里另造错误）；
 * - `{ok:false, code}`：启用但配置非法（invalidCode / 快照构造失败）——调用方必须
 *   fail-closed（fanout 走 queued→failed 终态），绝不降级成普通配置；
 * - `{ok:true, snapshot, selection}`：冻结成功，selection 是活动层第 0 项。
 *
 * @param {object} input - { role, sessionId, settingsSnapshot, clock }。
 *   sessionId 是**发起派发的 root 会话 id**（会话覆盖以此为准），不是任务 id。
 * @param {object} input.settingsSnapshot - 同一代读的设置快照（含 sessionOverrides）。
 * @param {{now:Function}} input.clock - 只读时钟；本次派发只取一次 now()。
 * @returns {null|{ok:false, code:string}|{ok:true, snapshot:object, selection:object}}
 */
export function buildPeakValleyDispatchRoute(input) {
  const { role, sessionId, settingsSnapshot, clock } = input ?? {};
  const peakValley = settingsSnapshot?.peakValley ?? {};
  // 未启用峰谷：不读时钟、不构造快照，调用方逐字保持旧行为。
  if (peakValley.enabled !== true) return null;
  const invalidCode = peakValleyInvalidCodeOf(peakValley);
  if (invalidCode !== void 0) return { ok: false, code: invalidCode };
  if (clock === null || typeof clock !== "object" || typeof clock.now !== "function") {
    // 时钟是构造冻结快照的必要上下文：缺失是装配错误，不能静默产出「没有判定时刻」的快照。
    throw new TypeError("buildPeakValleyDispatchRoute 需要 clock.now");
  }
  if (typeof role !== "string" || role.length === 0) return null;
  // 与 async 路径同一约束：一次派发只取一次时钟，同一时间戳既判定 period 又写 decidedAt。
  const decidedAt = clock.now();
  const period = peakValleyAtDate(peakValley.periods, new Date(decidedAt));
  const ordinaryView = ordinaryRouteViewOf(settingsSnapshot, role);
  const ordinaryPlan = profileModelPlanOf(ordinaryView, role);
  // 会话覆盖命中：完全不进入时段层，period 仍记录当时墙钟（两者不互相推导）。
  const overrideSelection = normalizeModelSelection(settingsSnapshot?.sessionOverrides?.[sessionId]?.[role]);
  if (overrideSelection !== undefined) {
    const overridePlan = buildModelRoutePlan(overrideSelection, ordinaryView.candidates[role], ordinaryView.fallbackLimit);
    return dispatchRouteOf({
      role,
      period,
      tier: "normal-override",
      plan: overridePlan.plan,
      // 会话覆盖整份计划都属于「普通层」：tierPlanLength 必须等于 plan.length 才自洽。
      tierPlanLength: overridePlan.plan.length,
      fallbackLimit: overridePlan.fallbackLimit,
      ordinaryFallbackLimit: overridePlan.fallbackLimit,
      ordinaryFallback: null,
      decidedAt,
    });
  }
  const profilePlan = profileModelPlanOf(profileRouteViewOf(peakValley[period]), role);
  if (profilePlan === null) {
    // 时段层缺该角色主模型：直接跨层（与 async 路径同一原因码）。
    // 普通层也没有主模型时返回 null，让调用方走既有「尚未配置模型」路径。
    if (ordinaryPlan === null) return null;
    return dispatchRouteOf({
      role,
      period,
      tier: "normal-fallback",
      plan: ordinaryPlan.plan,
      tierPlanLength: 0,
      fallbackLimit: ordinaryPlan.fallbackLimit,
      ordinaryFallbackLimit: ordinaryPlan.fallbackLimit,
      ordinaryFallback: { fromTier: period, toTier: "normal-fallback", reasonCode: PEAK_VALLEY_ROLE_MISSING },
      decidedAt,
    });
  }
  // 时段层条目在前、普通回退层条目在后；层内顺序与既有候选链语义完全一致。
  const plan = [...profilePlan.plan];
  if (ordinaryPlan !== null) plan.push(...ordinaryPlan.plan);
  return dispatchRouteOf({
    role,
    period,
    tier: period,
    plan,
    tierPlanLength: profilePlan.plan.length,
    fallbackLimit: profilePlan.fallbackLimit,
    ordinaryFallbackLimit: ordinaryPlan === null ? profilePlan.fallbackLimit : ordinaryPlan.fallbackLimit,
    ordinaryFallback: null,
    decidedAt,
  });
}
