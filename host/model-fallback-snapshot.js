/**
 * 运行期降级的「冻结快照链」与进度持久化（票据 03；从 host/index-recovery.js 拆出）。
 *
 * 该文件把三件事收敛到一处，避免 host/index-recovery.js 继续膨胀：
 * 1. **链构造**（chainFromRouteSnapshot）：把派发时冻结的快照翻译成运行期候选链，
 *    只读快照、不读当前 settings / 不读时钟；
 * 2. **跨层回退**（switchToOrdinaryLayer）：时段层耗尽时切到普通层，写 ordinaryFallback；
 * 3. **进度持久化**（writeModelRouteSnapshotWith）：把新候选与快照新索引写回 child_models。
 *
 * 纯逻辑 + 一个注入的写命令：模块自身不持有状态，也不缓存设置。
 *
 * @module dsh-expert-group/host/model-fallback-snapshot
 */
import { MODEL_CANDIDATES_EXHAUSTED, modelRouteKeyOf } from "../shared/model-route.js";
import { advanceRouteSnapshot, normalizeRouteSnapshot } from "../shared/route-snapshot.js";

/**
 * 快照「当前活动层」在扁平 plan 里的边界（票据 03）。
 *
 * 与 shared/route-snapshot.js 的层标保持同一语义：时段层是 [0, tierPlanLength)，
 * 普通层是 [tierPlanLength, plan.length)；normal-override 整份计划都是普通配置。
 *
 * @param {object} snapshot - 已归一的快照。
 * @returns {{begin:number, end:number}}
 */
export function layerBoundsOfRouteSnapshot(snapshot) {
  if (snapshot.tier === "normal-fallback") {
    return { begin: snapshot.tierPlanLength, end: snapshot.plan.length };
  }
  if (snapshot.tier === "peak" || snapshot.tier === "valley") {
    return { begin: 0, end: snapshot.tierPlanLength };
  }
  return { begin: 0, end: snapshot.plan.length };
}

/**
 * 把冻结快照翻译成运行期候选链（票据 03）。
 *
 * - plan 来自快照，不读当前 settings；candidateIndex 是层内索引，跨层时归零；
 * - index 是扁平计划里的绝对位置（= 层起点 + 层内索引）；
 * - triedRoutes 预置「当前层起点到当前位置」的全部模型：它们要么在派发预检里失败过、
 *   要么就是当前路由，绝不允许被再次选中；
 * - baselineFallbacks 沿用持久化 fallbackCount；但普通层使用层内索引（全局计数包含时段层
 *   的失败次数，直接沿用会提前耗尽普通层预算）。
 *
 * @param {string} role - 角色 id。
 * @param {object} snapshot - 已归一的快照。
 * @param {object|undefined} currentRoute - admission 写入的当前路由。
 * @param {number|undefined} persistedFallbackCount - child_models/marker 的降级次数。
 * @returns {object} 运行期候选链状态。
 */
export function chainFromRouteSnapshot(role, snapshot, currentRoute, persistedFallbackCount) {
  const layer = layerBoundsOfRouteSnapshot(snapshot);
  const plan = snapshot.plan.map((selection, index) => ({
    selection,
    candidateIndex: index < snapshot.tierPlanLength ? index : index - snapshot.tierPlanLength,
  }));
  const index = layer.begin + snapshot.candidateIndex;
  const triedRoutes = new Set();
  for (let cursor = layer.begin; cursor <= index && cursor < plan.length; cursor += 1) {
    const key = modelRouteKeyOf(plan[cursor]?.selection);
    if (key.length > 0) triedRoutes.add(key);
  }
  if (currentRoute !== void 0) {
    const currentKey = modelRouteKeyOf(currentRoute);
    if (currentKey.length > 0) triedRoutes.add(currentKey);
  }
  const baseline = Number.isSafeInteger(persistedFallbackCount) && persistedFallbackCount >= 0
    ? (snapshot.tier === "normal-fallback" ? snapshot.candidateIndex : persistedFallbackCount)
    : snapshot.candidateIndex;
  return {
    role,
    plan,
    index,
    triedRoutes,
    override: void 0,
    switches: 0,
    fallbackLimit: snapshot.fallbackLimit,
    baselineFallbacks: baseline,
    layerBegin: layer.begin,
    layerEnd: layer.end,
    ordinaryFallbackLimit: snapshot.ordinaryFallbackLimit,
    ordinaryFallback: snapshot.ordinaryFallback,
    baseSnapshot: snapshot,
    snapshotBacked: true,
  };
}

/**
 * 读取 agent 上的冻结快照并构造运行期链（票据 03 的唯一入口）。
 *
 * 返回三种明确结果：
 * - 快照合法：{chain}，按快照建链；
 * - 快照**存在但非法**：{invalid:true}，调用方必须 fail-closed（不降级、不按当前配置
 *   重建），绝不把它当成"缺失"；
 * - 完全没有快照（开启峰谷前的 child / 旧记录）：null，调用方走既有重建路径。
 *
 * @param {string} role - 角色 id。
 * @param {unknown} markerSnapshot - agentOptions 上的快照 marker。
 * @param {unknown} storedSnapshot - child_models 的 route 字段。
 * @param {object|undefined} currentRoute - admission 写入的当前路由。
 * @param {number|undefined} persistedFallbackCount - 持久化降级次数。
 * @returns {{chain:object}|{invalid:true}|null}
 */
export function snapshotFallbackChainFor(role, markerSnapshot, storedSnapshot, currentRoute, persistedFallbackCount) {
  const raw = markerSnapshot !== void 0 ? markerSnapshot : storedSnapshot;
  if (raw === void 0) return null;
  const normalized = normalizeRouteSnapshot(raw);
  if (normalized.ok !== true) return { invalid: true };
  return { chain: chainFromRouteSnapshot(role, normalized.snapshot, currentRoute, persistedFallbackCount) };
}

/**
 * 时段层耗尽时切换到普通回退层（票据 03 的跨层回退）。
 *
 * 只在快照链上生效；切换会生成新快照（tier=normal-fallback + ordinaryFallback）、
 * 移动层边界、把索引回到层起点前一位、切到普通层预算并归零本层已消耗计数。
 *
 * @param {object} chain - 运行期候选链状态（就地修改）。
 * @returns {boolean} 是否已切到普通层。
 */
export function switchToOrdinaryLayer(chain) {
  const base = chain?.baseSnapshot;
  if (chain?.snapshotBacked !== true || base === null || typeof base !== "object") return false;
  if (base.tier !== "peak" && base.tier !== "valley") return false;
  if (base.plan.length <= base.tierPlanLength) return false;
  const advanced = advanceRouteSnapshot(base, {
    candidateIndex: 0,
    ordinaryFallback: {
      fromTier: base.period,
      toTier: "normal-fallback",
      reasonCode: MODEL_CANDIDATES_EXHAUSTED,
    },
  });
  if (advanced === null) return false;
  chain.baseSnapshot = advanced;
  chain.layerBegin = base.tierPlanLength;
  chain.layerEnd = base.plan.length;
  chain.index = chain.layerBegin - 1;
  chain.fallbackLimit = base.ordinaryFallbackLimit;
  chain.ordinaryFallback = advanced.ordinaryFallback;
  chain.baselineFallbacks = 0;
  chain.switches = 0;
  return true;
}

/**
 * 把候选切换写进 child_models 快照（侧栏/用量统计的可见性来源）。
 *
 * 旁路持久化：写入失败只由 writeChildModelPatch 内部告警，绝不让「快照没写上」把一次
 * 已经生效的降级回滚成失败。刻意省略 lastRouteErrorCode（运行期失败码不在稳定枚举里）。
 *
 * @param {Function} writeChildModelPatch - storage 的浅合并写命令。
 * @param {object} agent - exact Agent。
 * @param {object} chain - 链状态。
 * @param {{index:number, candidateIndex:number, selection:object}} next - 选中的候选。
 */
export function writeModelRouteSnapshotWith(writeChildModelPatch, agent, chain, next) {
  if (typeof agent?.id !== "string") return;
  const effort = typeof next.selection.reasoningEffort === "string" && next.selection.reasoningEffort.length > 0
    ? next.selection.reasoningEffort
    : void 0;
  // 冻结快照写进度（票据 03）：只推进层内索引（切层时 tier/ordinaryFallback 一起变），
  // 计划与 decidedAt 不变。旧重建链（snapshotBacked=false）不写 route，历史行为不变。
  const routeSnapshot = chain?.snapshotBacked === true && chain.baseSnapshot !== void 0
    ? advanceRouteSnapshot(chain.baseSnapshot, { candidateIndex: next.candidateIndex })
    : undefined;
  void writeChildModelPatch(agent.id, {
    provider: next.selection.provider,
    model: next.selection.model,
    ...(effort === void 0 ? {} : { reasoningEffort: effort }),
    candidateIndex: next.candidateIndex,
    fallbackCount: chain.baselineFallbacks + chain.switches,
    ...(routeSnapshot === null || routeSnapshot === undefined ? {} : { route: routeSnapshot }),
  }, effort === void 0
    // 候选未声明 effort：显式删除旧档位（浅合并会保留主模型/上一个候选的档位）。
    ? { remove: ["reasoningEffort"] }
    : undefined).catch(() => { /* 旁路持久化失败已由 writeChildModelPatch 记录，绝不向上抛。 */ });
}
