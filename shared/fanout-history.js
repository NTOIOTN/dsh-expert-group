/**
 * 历史 fan-out 子记录判定（历史数据兼容，不是 fan-out 功能残留）。
 *
 * fan-out 子系统已从本插件整体物理删除，但用户磁盘上的 `child_models` 表里仍可能留着
 * 旧版本写入的 fan-out child 记录。domain schema 继续保留这些可选身份字段，正是为了让
 * 既有磁盘数据仍然可读；本模块只回答一个问题：**这条记录是否来自已不存在的 fan-out
 * 写入路径**。
 *
 * 为什么必须收敛成唯一来源：同一个判定有两个消费方——
 * 1. 普通恢复选择器（`host/index-expert-tools-core.js`）：历史记录不得被当作可复用 child；
 * 2. 快照投影（`host/expert-group-stage.js`）：历史记录不得出现在普通专家树里。
 * 两处曾经各写一份判定，而投影那份只判 `fanout === true`，于是「只带 `fanoutAttempt` /
 * `fanoutParentAgentId`、没有 `fanout: true`」的旧记录被恢复路径排除、却仍出现在任务树里。
 * 判定只在这里写一次，两端 import 同一函数，避免再次漂移。
 *
 * 判定语义（与既有恢复过滤器逐字一致）：
 * - `fanout === true`：旧写入路径的显式身份标记；
 * - `fanoutParentTaskId` / `fanoutParentAgentId` / `fanoutShardId` / `fanoutAttempt`：
 *   旧写入路径随 fan-out 任务 / 分片身份一起落盘的字段，**任一存在**（值为 `null` 也算：
 *   字段出现本身就证明写入方认识 fan-out 身份）即视为历史记录；普通写入路径从不写这些键；
 * - 只有 `fanout: false` 而没有任何身份字段时**不算**历史记录：它只是显式的「不是 fan-out」
 *   标记，普通写入路径同样可能留下。
 *
 * 本函数是纯函数：只判定，不依赖任何已删除的 fan-out runtime，也**不改写、不删除**记录本身。
 *
 * @module dsh-expert-group/shared/fanout-history
 */

/**
 * 判断一条 child_models 快照是否属于已被物理删除的 fan-out 子系统。
 *
 * 调用方（恢复选择器 / 快照投影）拿到 true 时必须跳过该记录，但仍保留记录原样：
 * 它是用户的既有数据，兼容判定不是「清理」。
 *
 * @param {unknown} record - childModels 里的一条记录；任意形状（含 null / undefined / 非对象）。
 * @returns {boolean} true 表示该记录属于历史 fan-out 生命周期，普通恢复与普通专家树都必须跳过。
 */
export function isHistoricalFanoutChildRecord(record) {
  // 非对象输入按「没有身份证据」处理：调用方可能传入缺失的持久化快照（persisted[childId]）。
  if (record === null || typeof record !== "object") return false;
  if (record.fanout === true) return true;
  // `!== undefined` 才是既有语义：字段存在（哪怕值是 null）即为旧写入路径的证据。
  return record.fanoutParentTaskId !== undefined
    || record.fanoutParentAgentId !== undefined
    || record.fanoutShardId !== undefined
    || record.fanoutAttempt !== undefined;
}
