/**
 * 工具回执里的「时段 / 层 / 跨层回退」增量字段（票据 06 · B 段）。
 *
 * ## 为什么单独成模块
 * 回执字段只从**派发期冻结快照**读取，且「没有可读快照就不新增任何键」这条边界必须与读取
 * 口径收在一处：工具面（host/index-expert-tools-role.js）只负责展开结果，不自己判断快照
 * 形态。fan-out 任务面与手动派发随 fan-out 物理删除后，本模块只剩 role 工具这一个消费方。
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
