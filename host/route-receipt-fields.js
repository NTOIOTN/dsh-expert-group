/**
 * 工具回执里的「时段 / 层 / 跨层回退」增量字段（票据 06 · B 段）。
 *
 * ## 为什么单独成模块
 * role 工具与 fanout 工具（含手动派发）需要**同一套**读取口径，但两者的输入形状不同：
 * role 工具拿到的是本次派发的 `route`（含冻结快照），fanout 拿到的是任务快照（每个 shard
 * 的最新 attempt 才可能带快照）。把口径收在一处，避免两个入口各写一份「怎么读快照」。
 *
 * ## 红线
 * - **只增字段**：没有可读快照时返回空对象，调用方展开后回执形状逐字不变；
 * - **不推断**：绝不读 settings、绝不取时钟，也绝不从 primary/候选列表倒推时段或层——
 *   提交阶段的 precheck 路由不是「实际派发」的冻结快照，因此不能拿它冒充；
 * - **不泄漏**：只输出 routePeriod/routeTier/ordinaryFallback（含稳定原因码与角色 id），
 *   绝不输出 plan、provider/model 候选清单或任何凭据。
 *
 * @module dsh-expert-group/host/route-receipt-fields
 */
import { projectRouteSnapshotFields } from "../shared/route-snapshot.js";

/**
 * role 工具回执字段：本次派发结果里的冻结快照 → 三个增量字段。
 *
 * 未启用峰谷或旧路径时 `route.snapshot` 不存在，函数返回空对象（回执不新增任何键）。
 *
 * @param {object|undefined|null} route - resolveRoleModelRoute 的返回值。
 * @param {unknown} role - 本次派发的角色 id（跨层回退时随 ordinaryFallback 一起透出）。
 * @returns {object} 可展开的回执字段，或空对象。
 */
export function roleRouteReceiptFields(route, role) {
  // resolveRoleModelRoute 的返回值是「扁平路由 + snapshot」：时段/层只能从快照读，
  // 因此这里显式取 snapshot（缺失时把入参本身当快照候选，非法即返回空对象）。
  const snapshot = route !== null && typeof route === "object" && route.snapshot !== void 0
    ? route.snapshot
    : route;
  return projectRouteSnapshotFields(snapshot, role);
}

/**
 * fanout 任务回执字段：全部 shard 的最新 attempt 必须都带**可读且一致**的冻结快照。
 *
 * 为什么要求「全部一致」而不是取第一片：回执描述的是**一次派发**的时段/层。不同分片可能
 * 落在不同时段（例如跨峰谷边界的任务），此时任何单一取值都会对另一半说谎；而缺快照的分片
 * 说明它还没派发（提交那一刻必然如此），也不能推断成「和别的分片一样」。
 * 两种情况下函数都返回空对象，让回执保持既有形状。
 *
 * @param {object|undefined|null} task - manager 的只读任务快照（含 shards[].attempts[]）。
 * @param {unknown} role - 父任务角色 id。
 * @returns {object} 可展开的回执字段，或空对象。
 */
export function fanoutTaskRouteReceiptFields(task, role) {
  const shards = Array.isArray(task?.shards) ? task.shards : [];
  if (shards.length === 0) return {};
  let agreedFields = null;
  let agreedKey = null;
  for (const shard of shards) {
    const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
    const latest = attempts[attempts.length - 1];
    const fields = projectRouteSnapshotFields(latest, role);
    // 任一分片没有可读快照（尚未派发 / 旧快照 / 非法快照）→ 整组省略，绝不补默认值。
    if (Object.keys(fields).length === 0) return {};
    const fallback = fields.ordinaryFallback ?? null;
    const key = JSON.stringify([
      fields.routePeriod,
      fields.routeTier,
      fallback === null ? null : fallback.fromTier,
      fallback === null ? null : fallback.toTier,
      fallback === null ? null : fallback.reasonCode,
    ]);
    if (agreedFields === null) {
      agreedFields = fields;
      agreedKey = key;
      continue;
    }
    // 分片之间不一致：不存在一个能代表「这次派发」的时段/层，整组省略。
    if (key !== agreedKey) return {};
  }
  return agreedFields ?? {};
}
