/**
 * provider 名额归属（票据 05）：**一次执行（attempt）** 的派发快照是计数键的唯一来源。
 *
 * ## 为什么必须收敛成唯一入口
 * 名额的占用与释放必须是同一把钥匙：占用时按「这次执行实际使用的 provider」归桶，释放时
 * 也必须回到同一个桶。只要两处各自推导（一处读 `task.provider`、一处读快照），跨峰谷
 * 边界的任务就会把名额记到别的 provider 名下：一边多占、另一边永远释放不掉。因此
 * store / scheduler / restore / 诊断一律调用本函数，**禁止在别处自行推导 provider**。
 *
 * ## 三种输入与 fail-closed 边界
 * 1. `attempt.route` 存在且通过 `normalizeRouteSnapshot` → 取快照里**活动候选**的
 *    provider（`plan[layerOffset + candidateIndex].provider`，由快照构造侧派生）；
 * 2. `attempt.route` 存在但非法 → 返回 null（fail-closed）。**绝不回退**
 *    `task.provider`：那等于把「快照坏了」静默翻译成「换了另一个 provider」，与票据 03
 *    的失败语义直接冲突；
 * 3. `attempt.route` 完全缺失（旧快照 / 未启用峰谷）→ 仅此时回退 `task.provider`，
 *    这是旧路径的兼容语义，也是唯一允许回退的分支。
 *
 * 返回 null 表示「这次执行没有可归属的 provider」。调用方必须按「不占任何 provider 名额」
 * 处理：派发方向 fail-closed 拒绝启动，释放方向只记录异常诊断（名额不会凭空生成或变负）。
 *
 * 纯函数、无状态、无宿主依赖；不提供 `create*` 工厂。
 *
 * @module dsh-expert-group/fanout/provider-attribution
 */
import { normalizeRouteSnapshot } from "../shared/route-snapshot.js";

/**
 * 释放异常的稳定 code：诊断分区 `fanout.concurrency.providerRelease.code`。
 *
 * 触发语义是「释放了一个从未计数的桶」（桶缺失或计数已为 0），它说明某次执行的占用与
 * 释放没有配对——必须可观察，而不是让名额静默泄漏或变成负数。
 */
export const PROVIDER_RELEASE_MISMATCH = "PROVIDER_RELEASE_MISMATCH";

/**
 * 一次执行（attempt）的 provider 归属。
 *
 * @param {object|undefined} task - 父任务（只在「没有快照」的旧路径上参与推导）。
 * @param {object|undefined} attempt - 这次执行的 attempt 记录（含可选的 route 快照）。
 * @returns {string|null} provider 名；null 表示不可归属（调用方必须 fail-closed）。
 */
export function providerOfAttempt(task, attempt) {
  const route = attempt === null || typeof attempt !== "object" ? undefined : attempt.route;
  if (route === undefined) {
    // 旧快照兼容：完全没有冻结快照时才允许用父任务的单一归属。
    const legacy = typeof task?.provider === "string" ? task.provider : "";
    return legacy.length === 0 ? null : legacy;
  }
  // 存在但非法：严格校验失败即 null，绝不静默回退 task.provider（fail-closed）。
  const normalized = normalizeRouteSnapshot(route);
  if (normalized.ok !== true) return null;
  const provider = normalized.snapshot.provider;
  return typeof provider === "string" && provider.length > 0 ? provider : null;
}
