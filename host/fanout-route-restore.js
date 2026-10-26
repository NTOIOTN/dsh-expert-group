/**
 * fan-out 恢复/续跑的实际路由提示（票据 24；从 host/index-model-route.js 拆出）。
 *
 * 只有「上一 attempt 是恢复产生的 interrupted，且 child_models 里仍有该 shard 的实际
 * provider/model」时才返回持久化路由；此时 buildRequest **不得**重新跑
 * resolveCallConfig 选择候选。普通新派发（无中断历史）继续走正常路由计划。
 *
 * 无状态：host 读取面与 provider 归一都由调用方在调用期传入。
 *
 * @module dsh-expert-group/host/fanout-route-restore
 */
import { modelRouteFieldsFromRecord, normalizeModelSelection } from "../shared/model-route.js";

/**
 * @param {object} input - { parentTaskId, shardId, attempt }（buildRequest 的输入子集）。
 * @param {object} context - { getFanoutHost, readSnapshot, normalizeSubagentProvider }。
 * @returns {object|null} 持久化路由；不适用时 null。
 */
export function restoredFanoutModelRoute(input, context) {
  const { getFanoutHost, readSnapshot, normalizeSubagentProvider } = context;
  if (!Number.isSafeInteger(input?.attempt) || input.attempt <= 1) return null;
  const task = typeof getFanoutHost()?.getTask === "function" ? getFanoutHost().getTask(input.parentTaskId) : null;
  const shard = Array.isArray(task?.shards)
    ? task.shards.find((entry) => entry?.shardId === input.shardId)
    : undefined;
  const previous = Array.isArray(shard?.attempts)
    ? shard.attempts.find((entry) => entry?.attempt === input.attempt - 1)
    : undefined;
  if (previous?.status !== "interrupted" || typeof previous.childId !== "string") return null;
  const record = readSnapshot().childModels?.[previous.childId];
  if (record === undefined || record === null) return null;
  // 身份反证：只有同一个父任务/分片的记录才能作为本 attempt 的路由依据。
  if (record.fanoutParentTaskId !== input.parentTaskId || record.fanoutShardId !== input.shardId) return null;
  const selection = normalizeModelSelection(record);
  if (selection === undefined) return null;
  // 目标 provider/继承开关（票据 29）同样只读快照：恢复出来的 attempt 必须延续
  // 原 child 的通道，不能按当前设置重新选择（继承开关变化不得静默改变 seed 语义）。
  return {
    selection,
    ...modelRouteFieldsFromRecord(record),
    ...(normalizeSubagentProvider(record.subagentProvider) === void 0
      ? {}
      : { subagentProvider: normalizeSubagentProvider(record.subagentProvider) }),
    ...(typeof record.inheritContext === "boolean" ? { inheritContext: record.inheritContext } : {}),
  };
}
