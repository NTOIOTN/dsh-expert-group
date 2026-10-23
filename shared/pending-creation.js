/**
 * pending creation 队列操作。
 *
 * 按 parent+role 取用/回滚待创建条目，以及任务指纹读取与 TTL。
 * 本文件由原 `shared.js` 的 1007–1110 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/pending-creation
 */

/**
 * 从新建预登记 FIFO 队列取第一个匹配 parentId+role 的待创建项（P3，
 * startContinuable 新建路径的 binding acceptance 竞态预登记）：
 * agent/created 同步触发且早于 startContinuable resolve，需要按
 * parentId+role 找到本次新建的预登记项并立即写入 pendingMessage 绑定。
 * 父+角色串行（delegationTracker.serialize）保证同 scope 最多一个匹配项；
 * 不同角色互不干扰。匹配即从队列删除并返回；无匹配返回 undefined。
 * @param {Array} list - pendingCreations 队列（元素 { taskKey, parentId, role }）。
 * @param {string} parentId - 父代理 session id。
 * @param {string} role - 角色名。
 * @param {object} [parent] - 可选的 exact root Agent；提供时拒绝同 id 旧代际。
 * @returns {object|undefined} 匹配项（已从队列移除）；无匹配返回 undefined。
 */
export function takePendingCreation(list, parentId, role, parent) {
  if (!Array.isArray(list)) return void 0;
  const idx = list.findIndex(
    (item) => item !== null && typeof item === "object" && item.parentId === parentId && item.role === role
      && (parent === void 0 || item.parent === parent),
  );
  if (idx === -1) return void 0;
  return list.splice(idx, 1)[0];
}

/**
 * 回滚已被 agent/created 同步消费、但 startContinuable 未返回有效 messageId 的
 * 新建 acceptance。通过 transaction.record/childId/taskKey 做 exact ownership 判断，
 * 不触碰既有 recovery op 或其他 task；保留 durable record 时标记失效，
 * 让调用方禁止后续错误 reused。
 */
export function rollbackCreatedChildAcceptance({ recoveryRecords, transaction, releaseActivity, dropRecord, message = "child acceptance failed" } = {}) {
  if (!(recoveryRecords instanceof Map) || transaction === null || typeof transaction !== "object") {
    return { activityReleased: false, bindingRemoved: false, recordRemoved: false };
  }
  let activityReleased = false;
  if (transaction.activityId !== void 0 && typeof releaseActivity === "function") {
    try { activityReleased = releaseActivity(transaction.activityId) === true; } catch {}
  }
  const childId = transaction.childId;
  const record = transaction.record;
  if (!validStringValue(childId) || record === void 0 || recoveryRecords.get(childId) !== record) {
    return { activityReleased, bindingRemoved: false, recordRemoved: false };
  }
  let bindingRemoved = false;
  const binding = record.tasks?.get(transaction.taskKey);
  if (transaction.taskBindingOwned === true && binding === transaction.binding
    && binding?.childId === childId) {
    if (transaction.previousBinding === void 0) record.tasks.delete(transaction.taskKey);
    else record.tasks.set(transaction.taskKey, transaction.previousBinding);
    record.taskRecoveryContexts?.delete(transaction.taskKey);
    bindingRemoved = true;
  }
  if (transaction.recordOwned !== true) {
    record.invalidAcceptance = true;
    return { activityReleased, bindingRemoved, recordRemoved: false };
  }
  const noDurableState = (record.tasks?.size ?? 0) === 0
    && (record.pendingRecoveries?.size ?? 0) === 0;
  if (!noDurableState) {
    // 事务创建后若又出现 durable task/op，也不能删除 record；同时
    // 禁止这次失败 acceptance 让 reuseOrSteer 静默复用该 child。
    record.invalidAcceptance = true;
    return { activityReleased, bindingRemoved, recordRemoved: false };
  }
  let recordRemoved = false;
  if (typeof dropRecord === "function") {
    try { dropRecord(childId, message, record); recordRemoved = recoveryRecords.get(childId) !== record; } catch {}
  }
  // callback 异常或 no-op 时也必须再次校验 record identity；不能把同 childId
  // 的并发替代 record 当作本事务目标删除。
  if (!recordRemoved && recoveryRecords.get(childId) === record) recordRemoved = recoveryRecords.delete(childId);
  return { activityReleased, bindingRemoved, recordRemoved };
}

function validStringValue(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * 任务指纹默认 TTL：10 分钟。同一归一化 prompt 只在此窗口内视为「重复任务」，
 * 到期后惰性删除，相同 prompt 可再次进入复用判定——
 * 避免相同任务在父会话整个生命周期内永久失效（例如修复后重试同一 prompt）。
 */
export const TASK_TTL_DEFAULT_MS = 10 * 60 * 1000;

/**
 * 读取任务记忆条目记录的时刻。旧版本把值直接存成时间戳，新版本存
 * { childId, routeKey, at }；两种格式都要能读出时间，避免升级后旧条目被误判过期。
 * @param {unknown} record - scope.tasks 的值。
 * @returns {number} 记住时刻；非法输入返回 0（视为最旧）。
 */
export function taskRecordAt(record) {
  if (typeof record === "number" && Number.isFinite(record)) return record;
  return Number.isFinite(record?.at) ? record.at : 0;
}

/**
 * 读取任务记忆条目绑定的 childId（旧格式没有绑定）。
 * @param {unknown} record - scope.tasks 的值。
 * @returns {string|undefined} 非空 childId；无绑定返回 undefined。
 */
export function taskRecordChildId(record) {
  return typeof record?.childId === "string" && record.childId.length > 0 ? record.childId : void 0;
}
