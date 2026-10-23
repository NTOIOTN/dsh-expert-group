/**
 * fan-out 显式回收（R3-14：从 fanout/state.js 的回收段整段迁出，成为屏障的唯一 owner）。
 *
 * ## 职责与状态所有权（C5）
 * 独占**回收屏障**：进行中的屏障对象（token / 待回收 parentTaskIds / 候选快照 / 字节数）
 * 与 token 序号。三段语义与迁移前逐行一致：
 * - prepare：先立屏障再序列化候选，屏障期间公开写入口全部被拒绝；
 * - commit：唯一的任务删除点，删除后收敛 requestId / 续作索引与 role 轮转游标，
 *   再补发 tasks_reclaimed 事件、落盘并恢复派发（关闭后一律跳过）；
 * - abort：只清屏障并恢复派发，任务表不变。
 *
 * 屏障对象与 Set 容器不出本模块：对外只有 port 的只读投影（current / inProgress）与三段命令。
 * 生命周期闸门（closed）仍归 state owner，本模块只经注入的 isClosed() 读它。
 *
 * ## 迁移说明（R3-14）
 * 纯搬迁：s.reclaimState / s.reclaimSequence 变成模块私有的 current / sequence，
 * s.closed 变成 isClosed()；store / snapshot / persistence / boundScheduler / boundCommands
 * 的调用形式与错误码、返回形状逐行不变。
 *
 * @module dsh-expert-group/fanout/reclaim
 */
import { FANOUT_BUDGET } from "../resource-budget.js";

/**
 * 创建回收屏障 owner。
 *
 * @param {{isClosed: () => boolean}} options - isClosed 是生命周期闸门的只读探针
 *   （延迟求值：state owner 的 gate 在构造期之后仍会变化）。
 * @returns {Readonly<{port: object, prepare: Function, commit: Function, abort: Function}>}
 *   port 只暴露只读投影；三段命令是屏障的唯一写点。
 */
export function createReclaimBarrier({ isClosed }) {
  const budgetPolicy = FANOUT_BUDGET;
  /** 进行中的屏障：{ token, parentTaskIds: Set<string>, candidate, bytes }，null = 空闲。 */
  let current = null;
  /** 单调 token 序号（只增不减，跨多次回收不复用）。 */
  let sequence = 0;

function prepare(deps, parentTaskIds) {
  if (isClosed()) {
    return { accepted: false, code: "MANAGER_CLOSED", reason: "manager_closed", parentTaskIds: [], skipped: [] };
  }
  if (current !== null) {
    return { ...deps.boundCommands.reclaimInProgressResult(), parentTaskIds: [], skipped: [] };
  }
  if (!Array.isArray(parentTaskIds)) {
    return {
      accepted: false,
      code: "INVALID_RECLAIM_INPUT",
      reason: "invalid_parent_task_ids",
      message: "parentTaskIds 必须是非空字符串数组",
      parentTaskIds: [],
      skipped: [],
    };
  }
  const ids = [];
  const seen = new Set();
  for (const raw of parentTaskIds) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (id.length === 0) {
      return {
        accepted: false,
        code: "INVALID_RECLAIM_INPUT",
        reason: "invalid_parent_task_ids",
        message: "parentTaskIds 只能包含非空字符串",
        parentTaskIds: [],
        skipped: [],
      };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    return {
      accepted: false,
      code: "INVALID_RECLAIM_INPUT",
      reason: "invalid_parent_task_ids",
      message: "parentTaskIds 不能为空",
      parentTaskIds: [],
      skipped: [],
    };
  }
  if (ids.length > budgetPolicy.maxTasks) {
    return {
      accepted: false,
      code: "INVALID_RECLAIM_INPUT",
      reason: "invalid_parent_task_ids",
      message: "单次最多回收 " + budgetPolicy.maxTasks + " 个父任务",
      parentTaskIds: [],
      skipped: [],
    };
  }
  const skipped = [];
  const eligible = [];
  for (const id of ids) {
    const blockReason = deps.store.reclaimBlockReason(deps.store.taskById(id));
    if (blockReason === null) {
      eligible.push(id);
    } else {
      skipped.push({ parentTaskId: id, reason: blockReason });
    }
  }
  if (eligible.length === 0) {
    return {
      accepted: false,
      code: "NO_RECLAIMABLE_TASKS",
      reason: "no_reclaimable_tasks",
      parentTaskIds: [],
      skipped,
    };
  }
  const token = "reclaim-" + (++sequence);
  // 先立屏障再序列化：候选快照从这一刻起就是"唯一权威的待落盘状态"，
  // 序列化期间不可能有公开写入口插入状态变化（同步临界区 + 屏障双重保证）。
  current = { token, parentTaskIds: new Set(eligible), candidate: null, bytes: null };
  const envelope = deps.snapshot.serializeSnapshotEnvelope({ omitParentTaskIds: eligible });
  if (envelope.degraded === true || envelope.bytes === null) {
    current = null;
    return {
      accepted: false,
      code: "RECLAIM_SNAPSHOT_DEGRADED",
      reason: "reclaim_snapshot_degraded",
      message: "候选快照含不可 JSON 序列化负载，已中止回收",
      parentTaskIds: [],
      skipped,
      ...(envelope.degraded === true && envelope.payload?.violation ? { violation: envelope.payload.violation } : {}),
    };
  }
  const sizeVerdict = deps.persistence.snapshotSizeVerdict(envelope.bytes);
  if (!sizeVerdict.ok) {
    current = null;
    return {
      accepted: false,
      code: "RECLAIM_SNAPSHOT_OVERSIZE",
      reason: "reclaim_snapshot_oversize",
      message: sizeVerdict.violation.message,
      parentTaskIds: [],
      skipped,
      violation: sizeVerdict.violation,
    };
  }
  current.candidate = envelope.payload;
  current.bytes = envelope.bytes;
  return {
    accepted: true,
    token,
    parentTaskIds: eligible,
    candidate: envelope.payload,
    bytes: envelope.bytes,
    skipped,
  };
}

function commit(deps, token) {
  if (current === null) {
    return { accepted: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_not_prepared", reclaimed: [], count: 0 };
  }
  if (typeof token !== "string" || token !== current.token) {
    return { accepted: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_token_invalid", reclaimed: [], count: 0 };
  }
  // 局部别名：回收屏障对象。**不能**叫 state，否则会遮蔽唯一状态 owner 的 state。
  const barrier = current;
  const reclaimed = [...barrier.parentTaskIds];
  for (const parentTaskId of reclaimed) {
    const task = deps.store.taskById(parentTaskId);
    if (task === undefined) {
      // 防御性路径：屏障期间公开写入口全部拒绝，任务不可能消失；真发生时只跳过，
      // 不中断整批回收（其余任务的状态仍是权威的）。
      deps.store.rememberReclaimedTask(parentTaskId);
      continue;
    }
    deps.store.dropTask(parentTaskId);
    // requestId 去重索引随任务删除：之后同 requestId 视为新任务（票据 05/09 裁决）。
    if (task.requestId !== undefined && deps.store.requestOwner(task.requestId) === parentTaskId) {
      deps.store.dropRequestOwner(task.requestId);
    }
    for (const [requestId, ownerId] of [...deps.store.continuationOwnerEntries()]) {
      if (ownerId === parentTaskId) deps.store.dropContinuationOwner(requestId);
    }
    deps.store.removeTaskIndex(task);
    // 迟到回调识别标记：任务对象上留标记，迟到回调持有的是这个对象引用。
    task.reclaimed = true;
    deps.store.rememberReclaimedTask(parentTaskId);
  }
  // 轮转游标必须随 role 索引一起收敛：role 已被整批回收时删游标，否则取模夹紧，
  // 保证下一次派发不会越界（dispatchAvailable 还会再兜一次，但索引本身应保持有效）。
  for (const [role, cursor] of [...deps.store.rotationCursorEntries()]) {
    const parents = deps.store.parentsForRole(role);
    if (parents === undefined || parents.length === 0) {
      deps.store.dropRotationCursor(role);
    } else if (!Number.isInteger(cursor) || cursor < 0) {
      deps.store.setRotationCursor(role, 0);
    } else if (cursor >= parents.length) {
      deps.store.setRotationCursor(role, cursor % parents.length);
    }
  }
  current = null;
  // 关闭后不再有调度/持久化/事件语义：任务移除已按磁盘候选完成，但补发事件、触发落盘
  // 或重新调度都属于关闭之后的新语义，必须全部跳过（fail-closed，不伪造关闭后的活动）。
  if (!isClosed()) {
    deps.events.emit({
      type: "tasks_reclaimed",
      parentTaskIds: reclaimed,
      count: reclaimed.length,
    });
    deps.persistence.notifyPersistence();
    // 屏障期间被暂停的排队工作恢复派发（被回收任务本身已不在索引里）。
    deps.boundScheduler.schedule();
  }
  return { accepted: true, changed: true, reclaimed, count: reclaimed.length };
}

function abort(deps, token) {
  if (current === null) {
    return { accepted: false, changed: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_not_prepared" };
  }
  if (typeof token !== "string" || token !== current.token) {
    return { accepted: false, changed: false, code: "RECLAIM_TOKEN_INVALID", reason: "reclaim_token_invalid" };
  }
  current = null;
  // 屏障期间调度被暂停：中止后必须恢复，否则排队任务会永久停摆。
  // 关闭后没有调度语义：屏障仍要清（否则 token 永远悬挂），但绝不再排一次 drain。
  if (!isClosed()) deps.boundScheduler.schedule();
  return { accepted: true, changed: false, reason: "reclaim_aborted" };
}

  /** 屏障只读投影：容器与候选快照不额外解构，调用方只判「是否进行中」或读 token。 */
  const port = Object.freeze({
    get current() { return current; },
    get inProgress() { return current !== null; },
  });

  return Object.freeze({ port, prepare, commit, abort });
}
