/**
 * 入口 handoff 域（R4a · 票据 15）：admission 登记、feedback 身份与队列、恢复门控、child turn 结算。
 * 状态唯一 owner：pendingChildTurnEnds / handoffAdmissionCohort / failedHandoffChildren /
 * sessionEventReceiptSeq；域外只经下方命令与只读投影协作。本域无 ctx 注册点，跨域依赖全部
 * 以窄能力面注入（不接收 ctx）。
 *
 * @module dsh-expert-group/host/index-handoff
 */
import { createHandoffAdmissionCohort } from "../shared/delegation-cohort.js";
import { createHandoffFailureRegistry } from "../shared/session-generation.js";
import { createFeedbackIdentityLedger, FEEDBACK_DELIVERY_LIMIT } from "../shared/recovery-ledger.js";
import { subagentFeedbackChildId } from "../shared/feedback-identity.js";
import { findRecoveryOpByMessage } from "../shared/retry-policy.js";
import {
  classifyTurnOutcome,
  messageIdsOfTurnWithClaimed,
  shouldAutoRecover,
  taskKeysForTurn,
  turnHasNonEmptyText,
} from "../shared/turn-settlement.js";
/**
 * 创建 handoff 域能力面。
 *
 * 注入形态（票据 32 · C3 收窄：14 项 → 7 组）：参数按**能力组**组织、每组单一关注点；
 * 收窄只改注入形态，五个 installer 读到的扁平字段名与全部语义逐字不变。
 * ①`host` Host 组合；②`agents` live Agent 表；③`diagnostics` logger；
 * ④`recovery` 自动恢复域只读 seam（记录/激活/门控判定，同一 owner 同一关注点）；
 * ⑤`admission` `rootTurnWaits`：admission 工作项结算写面（只写账本）；
 * ⑥`turnEnd` child turn/end 后续处理（释放活动范围 + 恢复域统一入口，同一处依次触达）；⑦`identity` root 身份判定（结构身份 + live 代次）。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx），字段见上。
 * @returns {object} handoff 域能力面（含四个状态对象的只读投影，见文件末尾）。
 */
export function createHandoffDomain(deps) {
  // ── 域状态（唯一 owner 在本模块）────────────────────────────────────────
  // child turn/end 可能早于父 inbox feedback；先保存终态，等 exact settlement 到达后再消费。
  // 这些状态以 exact root Agent 为键；同 id 的新旧 root 不共享 generation。
  const pendingChildTurnEnds = new Map();
  // 自动恢复期间 DSH 仍会先把异常 settlement/report 插进父 inbox；每个 recovery record
  // 自己持有已同步撤回的消息，绝不能按 childId 全局合并。
  const handoffAdmissionCohort = createHandoffAdmissionCohort();
  /**
   * session/event 的插件内部单调接收序号（同步回调第一次进入时的序号，与 event.seq 无关）。
   * 只用于同批次事件的处理顺序，不持久化、不进入任何快照或日志。
   */
  let sessionEventReceiptSeq = 0;
  function nextSessionEventReceipt() {
    sessionEventReceiptSeq += 1;
    return sessionEventReceiptSeq;
  }
  // resume/CAS 失败只禁止对应 exact root 的自动恢复，不能影响同 id 的新 root。
  const failedHandoffChildren = createHandoffFailureRegistry();

  // 命名空间 → 扁平依赖袋（收窄只改域工厂注入面；H1–H5 装配层字段名与语义一字不变）。
  const flat = {
    host: deps.host.host, agents: deps.agents.agents, logger: deps.diagnostics.logger,
    getRecoveryRecord: deps.recovery.getRecoveryRecord, readChildActivation: deps.recovery.readChildActivation,
    canAutoRecover: deps.recovery.canAutoRecover, rootTurnWaits: deps.admission.rootTurnWaits,
    delegationTracker: deps.turnEnd.delegationTracker, handleChildTurnEnd: deps.turnEnd.handleChildTurnEnd,
    isRootAgentIdentity: deps.identity.isRootAgentIdentity, isLiveRootAgent: deps.identity.isLiveRootAgent,
  };
  const api = {};
  const shared = { ...flat, pendingChildTurnEnds, handoffAdmissionCohort, failedHandoffChildren, nextSessionEventReceipt };

  Object.assign(api, installHandoffAdmissions(shared, api));
  Object.assign(api, installHandoffFeedback(shared, api));
  Object.assign(api, installHandoffFeedbackQueue(shared, api));
  Object.assign(api, installRecoveryFeedbackGates(shared, api));
  Object.assign(api, installChildTurnSettlement(shared, api));

  // ── 状态命令面（铁律 3：域外只经命令/只读投影协作，绝不持有容器本体）──────────
  /** 删除某父代理名下「已到达未消费」的 child turn/end 队列（root 退休/销毁/卸载）。 */
  function forgetParentTurnEnds(parent) {
    pendingChildTurnEnds.delete(parent);
  }

  /** 只读判定：该父代理名下是否仍有未消费的 child turn/end。 */
  function hasParentTurnEnds(parent) {
    return pendingChildTurnEnds.has(parent);
  }

  /** 只读：某 record 是否仍有未结算 child turn/end；键恒为 record.parentAgent，形状异常 fail-closed 返回 true。 */
  function hasPendingChildTurnEndsForRecord(record) {
    const entries = pendingChildTurnEnds.get(record?.parentAgent);
    return entries === void 0 ? false : !Array.isArray(entries) || entries.some((entry) => entry?.record === record);
  }

  /** 卸载时清空全部未消费 child turn/end（不保留 root 强引用）。 */
  function clearAllParentTurnEnds() {
    pendingChildTurnEnds.clear();
  }

  /** 删除某父代理的 resume/CAS 失败登记（root 退休/销毁）。 */
  function forgetFailedHandoffParent(parent) {
    failedHandoffChildren.delete(parent);
  }

  /** 只读判定：该父代理是否有 resume/CAS 失败登记。 */
  function hasFailedHandoffParent(parent) {
    return failedHandoffChildren.has(parent);
  }

  /** 删除单个 child 的失败登记（该 child 重新取得可用 activation 时）。 */
  function clearChildHandoffFailure(parent, childId) {
    failedHandoffChildren.clearChild(parent, childId);
  }

  /** 卸载时清空全部失败登记。 */
  function clearAllHandoffFailures() {
    failedHandoffChildren.clear();
  }

  /** admission cohort：标记该 admission 的 pause 已完成（等待登记成功后的唯一写点）。 */
  function markHandoffAdmissionPaused(admission) {
    handoffAdmissionCohort.markPauseDone(admission);
  }

  /** admission cohort：admission 迁移到新 activation（child replacement / 冷恢复）。 */
  function retargetHandoffAdmissionActivation(parentAgent, childId, activation, extra) {
    handoffAdmissionCohort.updateActivation(parentAgent, childId, activation, extra);
  }

  /** admission cohort：移除一个 admission 并释放其 turn-group 记账。 */
  function releaseHandoffAdmission(entry) {
    handoffAdmissionCohort.remove(entry);
  }

  /** admission cohort：枚举当前登记的 root（卸载清理用；不交出 cohort 本体）。 */
  function listHandoffAdmissionRoots() {
    return handoffAdmissionCohort.roots();
  }

  /** admission cohort：清空单个 root 的全部 admission 记账。 */
  function clearHandoffAdmissionRoot(root) {
    handoffAdmissionCohort.clearRoot(root);
  }

  return {
    ...api,
    nextSessionEventReceipt, forgetParentTurnEnds,
    hasParentTurnEnds, hasPendingChildTurnEndsForRecord,
    clearAllParentTurnEnds, forgetFailedHandoffParent,
    hasFailedHandoffParent, clearChildHandoffFailure,
    clearAllHandoffFailures, markHandoffAdmissionPaused,
    retargetHandoffAdmissionActivation, releaseHandoffAdmission,
    listHandoffAdmissionRoots, clearHandoffAdmissionRoot,
  };
}
/**
 * H1：admission 登记与失败登记（handoff 索引的薄门面）。
 *
 * @param {object} deps - 见 `createHandoffDomain`。
 * @param {object} api - 域内能力面（跨组调用在运行期解析）。
 * @returns {object} H1 能力面。
 */
function installHandoffAdmissions(deps, api) {
  const {
    host,
    agents,
    logger,
    getRecoveryRecord,
    pendingChildTurnEnds,
    failedHandoffChildren,
    handoffAdmissionCohort,
    isRootAgentIdentity,
    isLiveRootAgent,
    rootTurnWaits,
  } = deps;

  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const settlePendingChildTurnEnds = (...args) => api.settlePendingChildTurnEnds(...args);
  const recoveryFailureGateOpen = (...args) => api.recoveryFailureGateOpen(...args);
  const recordTurnEndEvidence = (...args) => api.recordTurnEndEvidence(...args);
  const settleFinishedChildTurnWaits = (...args) => api.settleFinishedChildTurnWaits(...args);

function failureDescriptorForAdmission(parent, admission) {
  const record = getRecoveryRecord(admission?.childId);
  const terminal = pendingChildTurnEnds.get(parent)?.find((item) => item.admission === admission);
  const messageId = messageIdForHandoffAdmission(admission, record);
  return {
    token: admission?.token,
    childId: admission?.childId,
    session: admission?.session ?? record?.session,
    sessionId: admission?.session?.id ?? record?.session?.id,
    messageId,
    turn: terminal?.event?.data?.turn,
  };
}
function rememberFailedHandoffChildren(parent, admissions) {
  if (!isRootAgentIdentity(parent) || !Array.isArray(admissions)) return;
  failedHandoffChildren.remember(parent, admissions.map((entry) => failureDescriptorForAdmission(parent, entry)));
}
function consumeFailedHandoffChild(parent, childId, admission, context = {}) {
  const query = admission === void 0 ? context : { ...context, token: admission.token };
  return failedHandoffChildren.consume(parent, childId, query);
}
function registerPendingHandoffAdmission(parent, role, childId, taskKey) {
  if (!isLiveRootAgent(parent) || typeof role !== "string" || role.length === 0) return void 0;
  // 每个 accepted admission 都必须独占 token；taskKey 只用于绑定 message，不能
  // 合并同 child 的不同 admission（同 task 的重入也可能已被宿主接受）。
  const record = getRecoveryRecord(childId);
  const entry = handoffAdmissionCohort.register(parent, childId, record?.agent);
  // 记录当前 durable Session，失败 tombstone 与 replacement activation 都可精确绑定。
  Object.assign(entry, { parent, parentId: parent.id, role, taskKey, childId, record, session: record?.session, releaseQueued: false });
  host.handoff.add(entry);
  return entry;
}
function bindPendingHandoffAdmission(entry, childId, messageId) {
  if (entry === void 0 || !host.handoff.contains(entry) || typeof childId !== "string" || childId.length === 0) return;
  handoffAdmissionCohort.bind(entry, childId, messageId);
  entry.childId = childId;
  if (typeof messageId === "string" && messageId.length > 0) entry.messageId = messageId;
}
function bindHandoffAdmissionFromClaimed(agent, messageId) {
  if (typeof agent?.id !== "string" || typeof messageId !== "string" || messageId.length === 0) return;
  for (const entry of host.handoff.entries()) {
    if (entry.childId !== agent.id || entry.parent?.id !== entry.parentId) continue;
    const record = getRecoveryRecord(agent.id);
    if (record?.agent !== agent || record.parentAgent !== entry.parent) continue;
    const binding = record.tasks?.get(entry.taskKey);
    if (binding?.messageId === messageId && entry.messageId === void 0) entry.messageId = messageId;
  }
}
/**
 * 摘除一个 pending admission，并把它对应的等待工作**精确结算**。
 *
 * 结算边界就是「exact admission 真正离开 host.handoff」：无论它是被相关
 * settlement 释放、被 fail-closed 清理，还是被 root 退休路径摘除，都只有这一次
 * 真实的移除。等待登记表按 token 精确结算，因此重复调用与迟到事件都是幂等空操作
 * （登记表只认未结算项），绝不会释放别的 admission。
 */
function removePendingHandoffAdmission(entry) {
  if (entry === void 0) return;
  if (!host.handoff.remove(entry)) return;
  handoffAdmissionCohort.remove(entry);
  const parent = entry.parent;
  const token = typeof entry.token === "string" && entry.token.length > 0 ? entry.token : void 0;
  if (parent !== void 0 && token !== void 0) {
    rootTurnWaits.settle(parent, { kind: "admission", token });
  }
}
/**
 * 由 turn/end 事件推导出它所属的 admission（含 receipt 序号与 recovered 标记）。
 * 只做只读推导：不登记、不写状态；无法证明归属时返回 undefined（fail-closed）。
 */
function failPendingHandoffAdmission(parent, entry, record) {
  if (entry === void 0 || !host.handoff.contains(entry)) return;
  entry.failed = true;
  entry.feedbackSeen = true;
  entry.releaseQueued = true;
  const queued = pendingChildTurnEnds.get(parent)?.some((item) => item.admission === entry) === true;
  const messageId = messageIdForHandoffAdmission(entry, record);
  if (queued || messageId !== void 0) rememberFailedHandoffChildren(parent, [entry]);
  if (queued) settlePendingChildTurnEnds(parent, false, entry);
  // admission 失败不会产生新的 messageId；没有已暂存 turn 时直接删除 token，
  // 避免 failedHandoffChildren 留下永远无法消费的 fallback。
  if (!queued && messageId === void 0) removePendingHandoffAdmission(entry);
}
function clearPendingHandoffAdmissions(parent) {
  // 统一走 removePendingHandoffAdmission：它同时负责等待工作的精确结算。
  for (const entry of host.handoff.filter((item) => item.parent === parent)) {
    removePendingHandoffAdmission(entry);
  }
  // 失败路径先把可反查 descriptor 写入 registry；这里仅移除无法按
  // messageId/turn 反查的非终态记录，绝不删除仍可能迟到的 exact tombstone。
  failedHandoffChildren.pruneUnmatchable(parent);
}
function pendingHandoffAdmissionFor(parent, childId, admission) {
  if (admission !== void 0) return host.handoff.contains(admission) && admission.parent === parent ? admission : void 0;
  return host.handoff.find((item) => item.parent === parent && item.childId === childId);
}
function hasPendingHandoffAdmission(record, childId) {
  return host.handoff.some((item) =>
    item.parent === record?.parentAgent
    && item.role === record?.role
    && item.childId === childId,
  );
}
function admissionForTurn(record, session, event, receipt = void 0) {
  const turn = event?.data?.turn;
  if (!Number.isSafeInteger(turn) || record?.session !== session) return void 0;
  const events = Array.isArray(session.events) ? session.events : [];
  const turnMessageIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
  for (const [messageId, claimedTurn] of record.claimed ?? []) {
    if (claimedTurn === turn) turnMessageIds.add(messageId);
  }
  const matches = host.handoff.filter((item) => {
    if (item.parent !== record.parentAgent || item.childId !== session.id || item.failed === true) return false;
    const messageId = messageIdForHandoffAdmission(item, record);
    return typeof messageId === "string" && turnMessageIds.has(messageId);
  });
  if (matches.length === 0) {
    // pause/resume 失败可能已经移除了 cohort entry；迟到 terminal 仍须
    // 通过 exact tombstone 进入 allowRecovery=false 收口。
    const failed = failedHandoffChildren.lookup(record.parentAgent, session.id, {
      session, sessionId: session.id, turn, messageIds: turnMessageIds,
    });
    return failed === void 0 ? void 0 : { ...failed, failed: true, parent: record.parentAgent };
  }
  const group = handoffAdmissionCohort.ensureTurnGroup(record.parentAgent, session.id, turn, record.agent, turnMessageIds);
  // P1 + A：recoverable failure 的 turn/end 不是最终可消费边界。这里必须在 markTurnEnd
  // **之前**判定，并把判定结果传下去：markTurnEnd 仍要记录 turnEnded/turn/group
  // （后续合法 settlement 的消费判定依赖它），但不得按 activation 级 snapshot 把
  // 本轮 token 直接标成 feedbackSeen——那会在 recovery operation 尚未完成时消耗掉
  // token，父 inbox 之后到达的合法 UUID settlement 就再也找不到未消费 entry，child
  // token 永不结算（root 永久等待）。
  //
  // A：判定只用**当前这一个 event/turn** 的 reason/output，不扫描 session.events 的
  // 最新 turn/end（同一同步批次里更晚的普通 turn/end 会让 gate 误判为关闭）。
  const recoveryGateOpen = recoveryFailureGateOpen(record, {
    turn,
    reason: event?.data?.reason ?? {},
    hasOutput: turnHasNonEmptyText(Array.isArray(session.events) ? session.events : [], turn),
  });
  for (const entry of matches) {
    const messageId = messageIdForHandoffAdmission(entry, record);
    handoffAdmissionCohort.markTurnEnd(entry, messageId, turn, record.agent, group, {
      deferSnapshotFeedback: recoveryGateOpen,
    });
    entry.turnEnded = true;
    entry.turn = turn;
    entry.activation = record.agent;
    recordTurnEndEvidence(entry, { session, activation: record.agent, turn, event, receipt });
  }
  // feedback 可能在 turn/end microtask 之前到达；先记录 exact activation，
  // 再在本 turn 的全部 entry 标记 turnEnded 后一次性标记所有已结束 groups。
  //
  // item 2/P1：recoverable failure 的 gate 尚未关闭时，本 turn/end **不是**终态边界：
  // 已排队的 marker（包含无 message.id 的 early delivery）绝不能在这里消费 token，
  // 否则 recovery operation 尚未建立/完成就消费 token 并提前放行 root。marker 保留到 recovery
  // 完成后的真实终态边界（或由 releaseGatedRecoveryFeedback 重新投递的带 UUID 最终
  // 通知走 exact/wildcard 正常路径消费）。
  if (recoveryGateOpen) {
    return matches[0];
  }
  //
  // A3：本 turn 消费**所有**可归属于它的 pending marker（exact 与 wildcard 混存时
  // 不能只摘掉第一个），并只摘掉本次确实消费/确认失效的 marker——既不能把合法下一轮
  // 的 marker 删掉，也不能让已消费的 marker 残留到后续 turn/end 再次消费新 token。
  const pendingFeedbacks = Array.isArray(record.pendingFeedbacks) ? record.pendingFeedbacks : [];
  const consumedMarkers = [];
  for (const marker of pendingFeedbacks) {
    if (marker === null || typeof marker !== "object") {
      // 非法项直接清理，避免后续读字段抛错。
      consumedMarkers.push(marker);
      continue;
    }
    if (marker.activation !== void 0 && marker.activation !== record.agent) {
      // A4 第二道防线：activation 已经换代（replacement / cold resume）的 marker 永不
      // 可能再匹配（cohort 与下面的消费判定都按当前 activation 过滤）。这里直接回收，
      // 避免旧代际 marker 长期滞留；wildcard 的跨代消费在 bindRecoverySession 已被禁止。
      consumedMarkers.push(marker);
      continue;
    }
    // A4：marker 绑定的 Session generation 已经改变时，这条 marker 的关联证据失效。
    if (marker.sessionId !== void 0 && marker.sessionId !== session.id) {
      consumedMarkers.push(marker);
      continue;
    }
    if (marker.admissionId !== void 0) {
      const exact = group.entries.find((entry) => entry.token === marker.admissionId
        || entry.messageId === marker.admissionId);
      // 未命中本 turn 的 exact marker 属于后续轮次，必须保留。
      if (exact === void 0) continue;
      exact.feedbackSeen = true;
      exact.feedbackExact = true;
      consumedMarkers.push(marker);
      continue;
    }
    // wildcard：只有它的到达快照与本 turn 的 group 有交集时才算「关联到本 turn」。
    // 没有快照的旧形态退化为 turn 绑定判定（turn === undefined 视为可消费一次）。
    const restrict = marker.tokens instanceof Set ? marker.tokens : void 0;
    if (restrict !== void 0) {
      // 死 marker 回收：到达快照里的 token 全部已被消费（或被释放）时，这条 marker
      // 已经不可能消费任何未来的 token（restrict 是它的覆盖上界），只能清理。
      const alive = [...restrict].some((token) => host.handoff.some((item) =>
        item.parent === record.parentAgent
        && item.childId === session.id
        && item.token === token
        && item.feedbackSeen !== true
        && item.failed !== true));
      if (!alive) {
        consumedMarkers.push(marker);
        continue;
      }
    }
    const relevant = restrict === void 0
      ? (marker.turn === void 0 || marker.turn === turn)
      : group.entries.some((entry) => restrict.has(entry.token));
    if (!relevant) continue;
    handoffAdmissionCohort.markFeedback(record.parentAgent, session.id, void 0, record.agent, restrict);
    consumedMarkers.push(marker);
  }
  if (consumedMarkers.length > 0) {
    record.pendingFeedbacks = pendingFeedbacks.filter((item) => !consumedMarkers.includes(item));
  }
  // feedback 可能已经在本 turn/end 前到达：本 turn/end 边界本身也可能让 cohort 就绪，
  // 因此这里重新检查一次精确结算（不改变任何 release/清理语义）。
  settleFinishedChildTurnWaits(record.parentAgent);
  // 一个 turn 的所有 admission 共用一次 deferred recovery 结算。
  return matches[0];
}
function messageIdForHandoffAdmission(entry, record) {
  if (typeof entry?.messageId === "string" && entry.messageId.length > 0) return entry.messageId;
  const binding = record?.tasks?.get(entry?.taskKey);
  if (typeof binding?.messageId === "string" && binding.messageId.length > 0) {
    entry.messageId = binding.messageId;
    return binding.messageId;
  }
  return void 0;
}
function admissionHasEndedTurn(entry, record) {
  const messageId = messageIdForHandoffAdmission(entry, record);
  const events = Array.isArray(record?.session?.events) ? record.session.events : [];
  if (messageId === void 0) return false;
  for (const event of events) {
    const turn = event?.data?.turn;
    if (event?.type !== "turn/end" || !Number.isSafeInteger(turn)) continue;
    if (messageIdsOfTurnWithClaimed(record.claimed, events, turn).has(messageId)) return true;
  }
  return false;
}
  return {
    failureDescriptorForAdmission,
    rememberFailedHandoffChildren,
    consumeFailedHandoffChild,
    registerPendingHandoffAdmission,
    bindPendingHandoffAdmission,
    bindHandoffAdmissionFromClaimed,
    removePendingHandoffAdmission,
    failPendingHandoffAdmission,
    clearPendingHandoffAdmissions,
    pendingHandoffAdmissionFor,
    hasPendingHandoffAdmission,
    admissionForTurn,
    messageIdForHandoffAdmission,
    admissionHasEndedTurn,
  };
}
/**
 * H2：feedback 身份、到达 token、source-less notice 回执与 turn/end 证据。
 *
 * @param {object} deps - 见 `createHandoffDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} H2 能力面。
 */
function installHandoffFeedback(deps, api) {
  const {
    host,
    logger,
    getRecoveryRecord,
    pendingChildTurnEnds,
    handoffAdmissionCohort,
    isLiveRootAgent,
  } = deps;
  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const isCurrentRecoveryFeedbackIdentity = (...args) => api.isCurrentRecoveryFeedbackIdentity(...args);
function feedbackAdmissionId(message) {
  const source = message?.source;
  for (const value of [source?.handoffAdmissionId, source?.admissionId, source?.childMessageId, message?.handoffAdmissionId, message?.admissionId]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return void 0;
}
/**
 * 父 inbox settlement 的身份账本（A1）。
 *
 * 宿主会以**同一个 message.id** 重复投递同一条 child settlement（重放/重入的 inserted）。
 * 这条副本不是新结论：它一旦进入 cohort 消费/排队，就会用上一轮早已结算的 feedback 去
 * 消费本轮新登记的 token，把本轮 token 的 feedbackSeen 提前置 true → cohort.ready()
 * 提前成立 → root 在本轮结果真正回来之前提前放行。
 *
 * 账本生命周期与 child recovery record 一致（record 被 drop/owner 变更时随之丢弃）：
 * message.id 是 DSH 为每条消息新铸的 UUID，不存在「同 id 被合法复用为下一轮真实
 * settlement」的情况，因此在 record 生命周期内保留 id 是**可证明完备**的去重。
 * 达到 FEEDBACK_DELIVERY_LIMIT 时**不做插入序淘汰**（淘汰会让旧副本重新变成新
 * settlement），改为 fail-closed 饱和：不再记账并置 saturated，使后续无稳定身份的
 * settlement 只能走保守队列路径（见 markPendingHandoffFeedback）。
 */
function feedbackIdentityLedger(record) {
  if (record.feedbackIdentityLedger === void 0) {
    record.feedbackIdentityLedger = createFeedbackIdentityLedger({ limit: FEEDBACK_DELIVERY_LIMIT });
  }
  return record.feedbackIdentityLedger;
}
/**
 * 认领一条 settlement 身份。
 * @returns {{duplicate:boolean, unproven:boolean}} duplicate 表示同 id 副本重投（必须
 *   完全跳过消费与排队）；unproven 表示没有稳定 message.id 或账本已饱和，调用方只能
 *   使用保守路径。
 */
function claimFeedbackIdentity(record, feedbackMessageId, deliveryId) {
  const wasSaturated = record.feedbackIdentityLedger?.saturated === true;
  // session.id + event.seq 只是本次宿主 delivery 的去重身份，不能冒充 admission id。
  const identityKey = feedbackMessageId !== void 0
    ? feedbackMessageId
    : (typeof deliveryId === "string" && deliveryId.length > 0 ? deliveryId : void 0);
  const identity = feedbackIdentityLedger(record).claim(identityKey);
  if (record.feedbackIdentityLedger.saturated === true && wasSaturated !== true) {
    logger.warn("dsh-expert-group: feedback identity ledger saturated for child " + record.childId
      + "; further unproven settlements take the conservative queue path");
  }
  return identity;
}
/** 计算一次到达事件涉及的 handoff token 集合（只读推导）。 */
function arrivalHandoffTokens(agent, childId, activation) {
  const tokens = new Set();
  for (const item of host.handoff.entries()) {
    if (item.parent !== agent || item.childId !== childId) continue;
    if (item.activation !== void 0 && item.activation !== activation) continue;
    if (item.failed === true || item.feedbackSeen === true) continue;
    if (typeof item.token === "string" && item.token.length > 0) tokens.add(item.token);
  }
  return tokens;
}
/**
 * C：source-less Host 完成通知的**同步接收边界快照**。
 *
 * 为什么需要它：通知与 child turn/end 都可能走 session/event 并被延迟到 microtask，
 * 消费时刻重建的快照可能包含「在本通知之后才到达的终态证据」。因此快照必须在
 * **同步入口**（第一次进入 session/event 回调时）固化：
 * - agent/session：接收时的 exact root Agent 与 Session 对象；
 * - childId/activation/record：接收时该 child 的 exact 恢复记录与 Activation；
 * - tokens：接收时刻仍未被消费的 admission token 快照（覆盖上界）；
 * - receipt：本条 session/event 的单调接收序号；
 * - deliveryId：session.id + event.seq 组成的纯 delivery 身份（只用于去重）。
 *
 * 后续异步消费只能**收紧**：token 只能取该快照的子集、activation/session/record 必须
 * 不变、且对应 turn/end 的接收序号必须严格小于本通知的序号。
 */
function captureSourceLessNoticeReceipt(agent, session, message, deliveryId, receipt) {
  if (message === null || typeof message !== "object" || message.source !== void 0) return void 0;
  if (typeof deliveryId !== "string" || deliveryId.length === 0) return void 0;
  if (!Number.isSafeInteger(receipt) || !isLiveRootAgent(agent) || agent.session !== session) return void 0;
  const childId = subagentFeedbackChildId(message, { allowSourceLess: true });
  if (childId === void 0) return void 0;
  const record = getRecoveryRecord(childId);
  if (record?.parentAgent !== agent || !isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return void 0;
  return {
    agent,
    session,
    childId,
    record,
    activation: record.agent,
    tokens: arrivalHandoffTokens(agent, childId, record.agent),
    receipt,
    deliveryId,
  };
}
/**
 * 事件级接收边界快照：只对「当前 live root 的 next-step spliced 注入」建立，返回与
 * `inserted` 数组同下标对齐的 receipt 列表（不匹配的项为 undefined）。
 */
function captureSourceLessNoticeReceipts(agent, session, event, receipt) {
  if (event?.type !== "agent/inbox/spliced" || event.data?.target !== "next-step") return void 0;
  if (!Array.isArray(event.data?.inserted)) return void 0;
  if (!isLiveRootAgent(agent) || agent.session !== session) return void 0;
  const deliveryId = Number.isSafeInteger(event.seq)
    ? "session-event:" + session.id + ":" + String(event.seq) : void 0;
  if (deliveryId === void 0) return void 0;
  const receipts = [];
  for (const inserted of event.data.inserted) {
    const message = inserted?.message !== undefined ? inserted.message : inserted;
    receipts.push(captureSourceLessNoticeReceipt(agent, session, message, deliveryId, receipt));
  }
  return receipts.some((item) => item !== void 0) ? receipts : void 0;
}
/** 判断 source-less notice 回执是否仍属于当前 activation/generation。 */
function sourceLessNoticeReceiptIsCurrent(agent, childId, record, receipt, deliveryId) {
  if (receipt === null || typeof receipt !== "object") return false;
  if (receipt.agent !== agent || receipt.session !== agent.session) return false;
  if (receipt.childId !== childId || receipt.record !== record) return false;
  // 快照必须属于**当前这条 delivery**：同一 child 上的其他通知不能借用它的到达位置。
  if (receipt.deliveryId !== deliveryId) return false;
  // activation 换代（replacement / cold resume）后旧快照表达的是旧代际事实，必须整体失效。
  if (receipt.activation !== record.agent) return false;
  if (!Number.isSafeInteger(receipt.receipt) || !(receipt.tokens instanceof Set)) return false;
  return true;
}
/** 记录 turn/end 证据（token/messageId/activation），供 settlement 精确匹配。 */
function recordTurnEndEvidence(entry, { session, activation, turn, event, receipt }) {
  const previous = entry.turnEndEvidence;
  const sameEvidence = previous !== void 0
    && previous.session === session
    && previous.activation === activation
    && previous.turn === turn
    && (previous.event === event
      || (Number.isSafeInteger(previous.seq) && Number.isSafeInteger(event?.seq)
        && previous.seq === event.seq));
  // 同一终态的重投递：保留首次 receipt，不推进、不重置。
  if (sameEvidence) return previous.receipt;
  if (!Number.isSafeInteger(receipt)) {
    delete entry.turnEndEvidence;
    return void 0;
  }
  entry.turnEndEvidence = {
    session,
    activation,
    turn,
    event,
    seq: Number.isSafeInteger(event?.seq) ? event.seq : void 0,
    receipt,
  };
  return receipt;
}
/**
 * C：source-less notice 允许消费的 token 集合 =
 * 同步接收快照 ∩ 「exact turn/end 的接收顺序严格更早」。
 *
 * 任一条件不成立都不消费、不排队（fail-closed，等真正的结算）：
 * - 通知之后才登记的 token 不在快照里；
 * - 通知之后才发布的 turn/end（同一同步批次里的「notice 先、turn/end 后」）序号更大，
 *   因而属于**未来证据**，本条通知无权消费；
 * - 终态证据的 receipt 是「该 exact 终态（同一 Session/activation/turn/evidence）**首次**
 *   被接收」的序号（见 recordTurnEndEvidence）：同一终态的重投递不会把它推迟，不同
 *   turn/terminal 或换代后的新终态则各自重置——因此这里比较的永远是**当前终态**的首次
 *   到达位置，既不会漏掉合法通知，也不会让未来终态借用旧序号。
 */
function sourceLessNoticeEligibleTokens(agent, childId, record, receipt) {
  const tokens = new Set();
  for (const token of receipt.tokens) {
    const item = host.handoff.find((entry) => entry.parent === agent
      && entry.childId === childId
      && entry.token === token);
    if (item === void 0 || item.failed === true || item.feedbackSeen === true) continue;
    if (item.activation !== void 0 && item.activation !== record.agent) continue;
    // 终态证据必须属于当前 exact Session/activation，且其接收顺序严格早于本通知。
    // 不同 turn/terminal 或换代后的新终态各有自己的 receipt，绝不复用最早值。
    const evidence = item.turnEndEvidence;
    if (evidence === void 0 || evidence.session !== record.session
      || evidence.activation !== record.agent) continue;
    if (!Number.isSafeInteger(evidence.receipt) || evidence.receipt >= receipt.receipt) continue;
    tokens.add(token);
  }
  return tokens;
}
/** 该 child/activation 上是否还有「已登记但 turn 尚未结束」的 admission。 */
function hasUnendedHandoffAdmission(agent, childId, activation) {
  return host.handoff.some((item) =>
    item.parent === agent
    && item.childId === childId
    && item.failed !== true
    && item.feedbackSeen !== true
    && item.turnEnded !== true
    && (item.activation === void 0 || item.activation === activation));
}
/**
 * 每个 child record 的**结算投递账本**（item 1 的无身份保守策略）。
 *
 * 生命周期：绑定 exact child Activation；activation 换代（replacement / cold resume）
 * 即重置——旧代际的投递事实不能约束新代际。
 *
 * 字段语义：
 * - idlessConsumed：本代际是否已经用**无 message.id** 的 delivery 进入过投递管线。
 *   无 id 时协议无法给出任何 delivery identity，第二条无 id delivery 既可能是旧副本
 *   也可能是新一轮真实结算；由于无法证明它属于新轮次，一律不再消费（保守方向：
 *   宁可多等一条带 UUID 的 settlement，也不提前 resume）。
 *   DSH 的真 settlement 由 createUserMessage 铸 UUID，因此线上 `queue=true` steer
 *   的第二轮始终走带身份路径，不受该限制影响。
 *
 * 为什么**没有** relay/notice 形态计数（曾短暂存在，已移除）：
 * DSH core 只铸一种 child 结算通知——`createSettlementMessage()` 产出
 * `source.kind = "subagent-settled"` + `form = "notice"` 且经 createUserMessage 铸 UUID；
 * `subagent-report`(form=relay) 只存在于 legacy session-format 的 payload 校验/迁移里，
 * runtime 不会为同一逻辑结算双投递。按「计数领先即副本」做全局配对没有身份证据，反而会把
 * 真正新一轮的 notice 误判成副本丢弃（该轮 token 永不结算 → root 永久等待）。
 * 因此跨形态去重只保留可证明的部分：message.id 去重（A1）、到达快照收紧（A2/A3）与
 * 无 id fail-closed（item 1）。legacy relay 仍按独立结算通道接受，但不与 notice 配对。
 */
function settlementDeliveryLedger(record, activation) {
  const current = record.settlementDeliveries;
  if (current !== void 0 && current.activation === activation
    && typeof current.idlessConsumed === "boolean") {
    return current;
  }
  const next = { activation, idlessConsumed: false };
  record.settlementDeliveries = next;
  return next;
}
/**
 * A5：只清理**本次 settlement 确切消费/确认失效**的 pending marker。
 *
 * 旧实现对 admissionId === undefined 的 marker 按 activation 宽删，会把另一轮
 * 合法 wildcard marker 一起删掉（随后那一轮永久等不到 feedback → 永久 paused）。
 * 这里改为按 marker 对象身份精确摘除：调用方只传入本次消费/失效的那些项，其他
 * child/activation/turn 的排队不受影响。
 */
function clearConsumedPendingHandoffFeedbacks(record, matches) {
  if (!Array.isArray(record?.pendingFeedbacks) || typeof matches !== "function") return 0;
  const before = record.pendingFeedbacks.length;
  record.pendingFeedbacks = record.pendingFeedbacks.filter((item) => !matches(item));
  return before - record.pendingFeedbacks.length;
}
/**
 * 排队一个「等 turn/end 消费」的 marker，并做身份去重。
 *
 * 去重规则（顺序与旧实现一致，只把 activation 级去重扩展到带身份的快照 marker）：
 * - 同 admissionId 已排队 → 不再入队（exact 身份唯一）；
 * - 同 messageId 已排队 → 不再入队（同一条消息不排两次）；
 * - 无 admissionId 且无 messageId 时，同一 activation 最多保留一个 wildcard marker
 *   （F2：重复排队会让同一条 feedback 在多个 turn/end 各消费一次）。
 *
 * @returns {object} 实际入队的 marker（已存在时返回已有项）。
 */
  return {
    feedbackAdmissionId,
    feedbackIdentityLedger,
    claimFeedbackIdentity,
    arrivalHandoffTokens,
    captureSourceLessNoticeReceipt,
    captureSourceLessNoticeReceipts,
    sourceLessNoticeReceiptIsCurrent,
    recordTurnEndEvidence,
    sourceLessNoticeEligibleTokens,
    hasUnendedHandoffAdmission,
    settlementDeliveryLedger,
    clearConsumedPendingHandoffFeedbacks,
  };
}
/**
 * 标记一条 child feedback 的到达语义并推进等待账本（见下方分支注释）。
 * 语义不变：身份账本去重 / source-less 回执 / 队列与结算判定逐条保留。
 */
function installHandoffFeedbackQueue(deps, api) {
  const {
    host,
    getRecoveryRecord,
    pendingChildTurnEnds,
    handoffAdmissionCohort,
    isLiveRootAgent,
    rootTurnWaits,
  } = deps;

  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const isCurrentRecoveryFeedbackIdentity = (...args) => api.isCurrentRecoveryFeedbackIdentity(...args);
  const claimFeedbackIdentity = (...args) => api.claimFeedbackIdentity(...args);
  const sourceLessNoticeReceiptIsCurrent = (...args) => api.sourceLessNoticeReceiptIsCurrent(...args);
  const feedbackAdmissionId = (...args) => api.feedbackAdmissionId(...args);
  const arrivalHandoffTokens = (...args) => api.arrivalHandoffTokens(...args);
  const settlementDeliveryLedger = (...args) => api.settlementDeliveryLedger(...args);
  const clearConsumedPendingHandoffFeedbacks = (...args) => api.clearConsumedPendingHandoffFeedbacks(...args);
  const hasUnendedHandoffAdmission = (...args) => api.hasUnendedHandoffAdmission(...args);
  const sourceLessNoticeEligibleTokens = (...args) => api.sourceLessNoticeEligibleTokens(...args);

function queuePendingHandoffFeedback(record, { admissionId, turn, messageId, activation, sessionId, tokens }) {
  if (!Array.isArray(record.pendingFeedbacks)) record.pendingFeedbacks = [];
  const list = record.pendingFeedbacks;
  if (admissionId !== void 0) {
    const existing = list.find((item) => item?.admissionId === admissionId);
    if (existing !== void 0) return existing;
  } else if (messageId !== void 0) {
    const existing = list.find((item) => item?.messageId === messageId);
    if (existing !== void 0) return existing;
  } else {
    const existing = list.find((item) => item?.admissionId === void 0
      && (item.activation === void 0 || item.activation === activation));
    if (existing !== void 0) return existing;
  }
  const marker = {
    admissionId,
    turn,
    messageId,
    // activation 是到达时的 exact 代际身份；只有 exact marker 允许在 activation
    // replacement 时随 entry 一起迁移，wildcard 跨代即失效（A4）。
    activation,
    sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : void 0,
    tokens: tokens instanceof Set ? new Set(tokens) : void 0,
  };
  list.push(marker);
  return marker;
}

function markPendingHandoffFeedback(agent, childId, message, deliveryId, sourceLessHostNotice = false, receipt = void 0) {
  if (!isLiveRootAgent(agent) || typeof childId !== "string" || childId.length === 0) return void 0;
  const record = getRecoveryRecord(childId);
  if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return void 0;
  const feedbackMessageId = typeof message?.id === "string" && message.id.length > 0 ? message.id : void 0;
  const identity = claimFeedbackIdentity(record, feedbackMessageId, deliveryId);
  // 同 id 副本：不消费、不排队。调用方（inbox/inserted microtask）随后仍会走一次
  // 「已就绪 admission 的精确结算」检查，但副本不会让任何 token 就绪，因此是安全空操作。
  if (identity.duplicate) return void 0;
  // B（Oracle 复现）：source-less Host notice 与 unproven 身份的组合必须 fail-closed。
  // unproven = 账本已饱和（或没有稳定身份），此时协议层无法区分「旧副本」与「下一轮真实
  // 结算」。下面的通用无身份分支会按「到达时仍有未结束 admission」把通知排队成 wildcard
  // marker，让这条无法证明属于本轮的通知在**未来** turn/end 消费 future entry，从而凭空
  // 结算 work 并提前放行 root。因此在认领身份之后、任何 admission/marker 操作之前直接
  // 拒绝：不消费、不排队、不写账本（结构化通知仍各自按既有语义处理）。
  if (sourceLessHostNotice && identity.unproven) return void 0;
  // C：source-less notice 必须携带**同步接收边界**快照（exact activation/session/record
  // 与接收序号）。快照缺失或已失效时同样 fail-closed：绝不能退化成「消费时刻重建快照」
  // 的通配消费，那会把晚到的终态证据算进本条通知的覆盖范围。
  if (sourceLessHostNotice && !sourceLessNoticeReceiptIsCurrent(agent, childId, record, receipt, deliveryId)) return void 0;
  const admissionId = feedbackAdmissionId(message);
  const candidates = host.handoff.filter((item) =>
    item.parent === agent
    && item.childId === childId
    && (item.activation === void 0 || item.activation === record.agent)
    && item.feedbackSeen !== true
    && item.failed !== true,
  );
  const entry = candidates.find((item) => admissionId === void 0
    || item.messageId === admissionId || item.token === admissionId);
  // 无 admission 的 settlement 只能在确实命中当前 exact activation 的
  // pending admission 后进入 shared cohort；零 admission 时不创建任何 marker。
  // 这也覆盖 A2 的「首次消费并清理后再次到达」形态：那时没有未消费 admission，
  // 迟到的无身份副本不会重新进入 wildcard union 路径。
  if (entry === void 0) return void 0;
  // 到达快照限制 wildcard 的覆盖上界；shared cohort 仅匹配已结束 turn，
  // 且 activation snapshot 不会把晚到通知之后新增的 token 纳入消费范围。
  const arrivalTokens = arrivalHandoffTokens(agent, childId, record.agent);
  // 无 id 保守策略（item 1）：账本绑定 exact activation，换代即重置。
  const ledger = settlementDeliveryLedger(record, record.agent);
  if (admissionId !== void 0) {
    // 扩展 source 明确携带 admission id 时只消费该 token；通常 DSH source
    // 没有该字段，下面按同一已认领 turn 的 group 消费全部 token。
    const sharedExact = handoffAdmissionCohort.markFeedback(agent, childId, admissionId, record.agent);
    if (sharedExact !== void 0) {
      entry.feedbackSeen = true;
      entry.feedbackExact = true;
      clearConsumedPendingHandoffFeedbacks(record, (item) =>
        item !== null && typeof item === "object"
        && (item.admissionId === admissionId
          || (feedbackMessageId !== void 0 && item.messageId === feedbackMessageId)));
      return entry;
    }
    queuePendingHandoffFeedback(record, {
      admissionId,
      messageId: feedbackMessageId,
      activation: record.agent,
      sessionId: record.session?.id,
    });
    return entry;
  }
  // ── A2 + item 1：无稳定身份的 settlement 只能消费「当前未完成」的 admission ──
  // 没有 message.id（或身份账本已饱和）时，协议层无法区分「旧副本」与「下一轮真实
  // settlement」：两者的 payload 形状完全相同。因此这里采用保守语义：
  // 1. 本 activation 已经用无 id delivery 消费过一次结算 → 后续无 id delivery 无法
  //    证明属于新轮次（Oracle 复现：第一轮的旧副本在第二轮 token 已登记、turn 未结束
  //    时再次到达，会排队并在第二轮 turn/end 把第二轮标成 feedbackSeen 从而提前
  //    release）→ 永久 fail-closed，不消费也不排队；
  // 2. 到达时仍存在未完成（turn 未结束）的 admission → 这是本 activation 的**首次**
  //    无 id 结算，明确关联到当前未完成 turn，允许排入 marker，由该 turn/end 边界消费；
  // 3. 到达时所有 admission 都已结束 → 无法证明它不是早已消费过的旧副本 → 不消费、
  //    不排队（旧实现会立即消费已结束的 group，从而可能提前 release 下一轮）。
  // 方向选择：宁可多等一条带身份的 settlement，也不提前 resume。DSH 的真实
  // settlement 由 createUserMessage 铸 UUID，因此线上路径始终有稳定身份。
  if (identity.unproven) {
    if (ledger.idlessConsumed === true) return entry;
    // 走到这里的只剩普通无 id delivery（inbox/inserted 或没有稳定身份的结算）。
    // source-less Host notice 的 unproven 组合已在上面直接拒绝（它无法证明属于本轮，
    // 不能进入任何 future 队列）。普通 no-id delivery 保持旧的保守规则：必须先观察到
    // 未结束 admission，再延迟到该 turn/end 边界消费。
    if (!hasUnendedHandoffAdmission(agent, childId, record.agent)) return entry;
    // 记账点选在「进入投递管线」而不是「真正消费」：即使该 marker 最终没有消费任何
    // token（例如 turn 从未结束），后续无 id delivery 仍无法证明自己是新结算，
    // 保守方向不变量必须由投递时刻决定，而不是由消费结果决定。
    ledger.idlessConsumed = true;
    queuePendingHandoffFeedback(record, {
      admissionId: void 0,
      messageId: feedbackMessageId,
      activation: record.agent,
      sessionId: record.session?.id,
      tokens: arrivalTokens,
    });
    return entry;
  }
  // 已结束 group 可精确消费（restrict = 到达快照，只覆盖到达时已存在的 token）；
  // 尚未建立 group 时先排队，等 turn/end 绑定全部 messageId 后再标记整组，
  // 不能把多个不同 turn 粗暴合并。
  // C：source-less notice 的候选上界还必须叠加「exact turn/end 的接收顺序更早」这一
  // 条件（同步快照 ∩ 接收顺序）。其他 delivery 保持原样：到达时刻重建的 token 快照。
  const wildcardTokens = sourceLessHostNotice
    ? sourceLessNoticeEligibleTokens(agent, childId, record, receipt)
    : arrivalTokens;
  const sharedGroup = handoffAdmissionCohort.markFeedback(agent, childId, void 0, record.agent, wildcardTokens);
  if (sharedGroup !== void 0) {
    // A（Oracle 复现）：这里**不再镜像**标记 entry.feedbackSeen。handoff entry 与 cohort
    // entry 是同一个对象，sharedGroup 已经把「真正 ended 且命中 restrict 的项」标记完毕；
    // 如果再按 candidates 首项标记一次，就会把一个尚未结束的 future entry 提前标成
    // 「已收到反馈」，使它在本轮 turn/end 之后无需任何通知就被准确结算（提前放行）。
    //
    // 本次消费已经把该 activation 当前全部「到达快照内已结束」的候选标记完毕。
    // 同 activation 的 wildcard marker 再被后续 turn/end 消费只会用**重建的快照**
    // 覆盖当时新登记的 token（提前 release 的直接成因），因此按身份精确摘除：
    // 只删 admissionId === undefined 且 activation 匹配的项，exact marker 与其他
    // 轮次/child 的排队一律保留（A5：不能宽删合法下一轮 marker）。
    clearConsumedPendingHandoffFeedbacks(record, (item) =>
      item !== null && typeof item === "object"
      && item.admissionId === void 0
      && (item.activation === void 0 || item.activation === record.agent)
      && (feedbackMessageId === void 0 || item.messageId === void 0 || item.messageId === feedbackMessageId));
    return entry;
  }
  // source-less Host notice 到达早于匹配 turn/end 时不能排队为未来通配证据；
  // 它只能消费 arrival snapshot 中已经结束的当前 activation cohort。
  if (sourceLessHostNotice) return entry;
  // 不绑定某一个 turn：marker 记录到达快照，turn/end 消费时以此为候选上界，
  // 因此 T1/T2 等多个已结束 turn 各自按自己的结算消费，future token 不受影响。
  queuePendingHandoffFeedback(record, {
    admissionId: void 0,
    messageId: feedbackMessageId,
    activation: record.agent,
    sessionId: record.session?.id,
    tokens: arrivalTokens,
  });
  return entry;
}
/** 精确结算一个 admission 的等待工作（token 非法 / 已结算时是安全空操作）。
 * options.progress 透传给等待账本，仅精确通道使用（见 settleFinishedChildTurnWaits）。 */
function settleAdmissionTurnWait(agent, entry, options) {
  const token = typeof entry?.token === "string" && entry.token.length > 0 ? entry.token : void 0;
  if (token === void 0) return false;
  return rootTurnWaits.settle(agent, { kind: "admission", token }, options);
}
/**
 * 把已经真正结束的 admission 从等待登记表里**精确结算**。
 *
 * 两条结算通道，严格区分「精确」与「猜测」：
 * 1. **exact 完成通知**：该 admission 的 child turn 已结束，且收到了精确关联的父
 *    inbox settlement（cohort.ready 的判定）。重复 / 错误 / 他 root / 旧代际的通知
 *    都不会让任何 token 就绪，因此是安全的幂等空操作；
 * 2. **完成通知缺失时的回退**（只在拿到**明确**快照时可用）：该 admission 的 turn
 *    已结束，且它的 exact child 明确不在 running 后代列表里。unknown / 查询失败 /
 *    血缘无法确定时绝不会走到这里——调用方只在 `known === true` 的快照上调用。
 *
 * ## 进度放行（**只有精确通道**，一次性资格）
 * 回退通道可能先结算同一 admission（Host 的 turn/end 与 settlement 间隔约 0.5s），但那时
 * settlement **还没进入 root 的 next-step**，放行会让 turn 空转收口（root 进 idle，durable
 * goal round 可能推进）。故回退只结算 work；迟到的精确 settlement 由 turn-wait 补放行。
 *
 * @param {object} agent - exact root Agent。
 * @param {{known:boolean,runningIds?:Set<string>}} [snapshot] - 明确的后代快照；
 *   省略时只走通道 1（不启用回退）。
 */
function settleFinishedChildTurnWaits(agent, snapshot) {
  if (!isLiveRootAgent(agent)) return;
  const known = snapshot?.known === true;
  const runningIds = known && snapshot.runningIds instanceof Set ? snapshot.runningIds : void 0;
  // 只有**精确通道**才申请进度资格（传 snapshot 即回退通道）：回退时 settlement 未进
  // next-step，放行会让 turn 空转收口。
  const allowProgress = snapshot === void 0;
  for (const entry of host.handoff.entries()) {
    if (entry.parent !== agent || entry.failed === true) continue;
    if (handoffAdmissionCohort.ready(agent, entry)) {
      // 精确通道：每个 admission 只有一次进度资格，重放/重复复查不得再放行。
      const grant = allowProgress === true && handoffAdmissionCohort.claimProgress(entry);
      settleAdmissionTurnWait(agent, entry, grant ? { progress: true } : void 0);
      continue;
    }
    if (runningIds === void 0) continue;
    if (entry.turnEnded !== true) continue;
    const childId = entry.childId;
    if (typeof childId !== "string" || childId.length === 0) continue;
    if (runningIds.has(childId)) continue;
    // 回退通道：只结算 work，**不**申请 progress（空放行会让 turn 结束、root 进 idle）；
    // 迟到的精确 settlement 会再进本函数，那时才补放行。
    settleAdmissionTurnWait(agent, entry);
  }
}
/**
 * session/event 和 parent feedback 共用的 exact durable generation 门控。child dispose
 * 后 core 仍可能把已经发布的 event/settlement 送到这里；此时 registry/activation
 * 缺失只表示 exact child 已销毁，record 中保留的 Agent/Session 仍足以继续结算。
 * 但 replacement 若已占据任一当前映射，必须拒绝，不能仅凭 childId 接管旧 generation。
 */
  return {
    queuePendingHandoffFeedback,
    markPendingHandoffFeedback,
    settleAdmissionTurnWait,
    settleFinishedChildTurnWaits,
  };
}
/**
 * H3：恢复 feedback 门控（gate/tombstone/release）。
 *
 * 本组只读写 recovery record 的既有字段，不新增状态，也不直接投递 inbox。
 *
 * @param {object} deps - 见 `createHandoffDomain`。
 * @param {object} api - 域内能力面（本组无跨组调用）。
 * @returns {object} H3 能力面。
 */
function installRecoveryFeedbackGates(deps, api) {
  const {
    host,
    logger,
    agents,
    getRecoveryRecord,
    canAutoRecover,
    readChildActivation,
    isLiveRootAgent,
  } = deps;
function isCurrentRecoverySessionIdentity(agent, record, session) {
  const childId = session?.id;
  if (!isLiveRootAgent(agent) || record?.parentAgent !== agent
    || typeof childId !== "string" || record.childId !== childId
    || record.agent === void 0 || record.session === void 0
    || record.session !== session || session.id !== childId
    || record.agent.session !== record.session) return false;
  const currentChild = agents.get(childId);
  if (currentChild !== void 0 && currentChild !== record.agent) return false;
  const activation = readChildActivation(session.id);
  return activation === void 0 || activation.agent === record.agent;
}
function isCurrentRecoveryFeedbackIdentity(agent, record, childId) {
  return record?.childId === childId
    && isCurrentRecoverySessionIdentity(agent, record, record?.session);
}
function currentGatedRecoveryFeedbacks(record) {
  if (!Array.isArray(record?.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks = [];
  const sessionId = record?.session?.id;
  return record.gatedRecoveryFeedbacks.filter((item) =>
    item?.parent === record.parentAgent
    && item.childId === record.childId
    && item.sessionId === sessionId
    && item.activation === record.agent,
  );
}
function wasGatedRecoveryFeedback(agent, childId, messageId, message) {
  const record = getRecoveryRecord(childId);
  if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return false;
  const deliveries = record.recoveryFeedbackDeliveries;
  // inject 的同步 inserted 仍需走普通 feedback 处理；只放行这一次 exact message
  // 对象，之后同 id 的迟到副本由 finalized tombstone 拦截。
  if (deliveries instanceof Set && deliveries.has(message)) {
    deliveries.delete(message);
    return false;
  }
  // item 2：无 message.id 的 delivery 没有可比较的 id；此时**只能**用 exact message
  // 对象身份判定（对象身份 tombstone 或 gated 列表里的同对象）。绝不能用
  // `item.messageId === undefined` 去匹配——那会把任意无 id 的合法消息都误判成
  // 「已门控」而永久阻断释放路径。
  if (typeof messageId !== "string" || messageId.length === 0) {
    if (record.recoveryFeedbackObjectTombstones instanceof WeakSet
      && record.recoveryFeedbackObjectTombstones.has(message)) return true;
    return Array.isArray(record.gatedRecoveryFeedbacks)
      && record.gatedRecoveryFeedbacks.some((item) =>
        item.parent === agent && item.childId === childId
        && item.sessionId === record.session?.id
        && item.activation === record.agent
        && item.message === message);
  }
  return (record.recoveryFeedbackTombstones instanceof Map
    && record.recoveryFeedbackTombstones.has(messageId))
    || (Array.isArray(record.gatedRecoveryFeedbacks)
      && record.gatedRecoveryFeedbacks.some((item) =>
        item.parent === agent && item.childId === childId
        && item.sessionId === record.session?.id
        && item.activation === record.agent
        && item.messageId === messageId));
}
function hasUnendedCurrentRecoveryAdmission(record) {
  if (!isCurrentRecoveryFeedbackIdentity(record?.parentAgent, record, record?.childId)) return false;
  return host.handoff.some((entry) =>
    entry.parent === record.parentAgent
    && entry.childId === record.childId
    && entry.failed !== true
    && entry.turnEnded !== true
    // entry 在 child acceptance 之前可能尚未回填 activation/session；上面的
    // current record identity 已锁定本次 root/child/generation，不能因此放弃同步门控。
    && (entry.activation === void 0 || entry.activation === record.agent)
    && (entry.session === void 0 || entry.session === record.session),
  );
}
/**
 * recoverable failure 链是否仍占用 gate（item 2 的 fail-closed 条件）。
 *
 * 与 recoveryFeedbackGateOpen 的区别：这里**只**看「可恢复失败 / 待决 recovery op」，
 * 不看「admission 已 accepted 但 turn 未结束」。后者对带 id 的 delivery 是撤回理由
 * （可以先 remove 再在最终边界重投递），但无 id delivery 根本无法撤回；此时把它挡在
 * 普通队列外只会让该轮结算永久丢失（token 永远等不到 feedbackSeen）。因此无 id
 * delivery 只在**真正的 recovery 链**打开时被门控；「turn 未结束」由 marker 队列
 * 绑定到达快照、在该 turn/end 精确消费来保证安全。
 *
 * A（Oracle 阻断）：判定必须基于**调用方正在处理的 event/turn 上下文**，绝不能反向扫描
 * `session.events` 的最新 turn/end。session/event 监听器用 queueMicrotask 延迟处理，host
 * 可能在同一同步批次里先发布 recoverable 的 T、再发布普通的 T+1，最后才轮到 T 的
 * microtask；此时扫描 events 会读到 T+1（普通终态）→ gate 误判为关闭 → `markTurnEnd`
 * 回放 activation snapshot 把 T 的 token 提前消费 → 恢复完成后的合法 settlement 再也找不到
 * 未消费 entry（提前 release 或永久 paused）。
 *
 * @param {object} record - child recovery record。
 * @param {{turn:number,reason:object,hasOutput:boolean}} [context] - 当前待处理的 turn/end
 *   上下文；事件处理路径（admissionForTurn）必须显式传入。省略时走「无上下文」分支：
 *   只回答「是否仍有未被 recovery 链终态覆盖的可恢复失败」，不判断 token 归属。
 */
function recoveryFailureGateOpen(record, context) {
  // 待决 recovery op 与事件发布顺序无关：链未完成就是打开。
  if (record?.pendingRecoveries instanceof Map && record.pendingRecoveries.size > 0) return true;
  if (context !== void 0) {
    const turn = context.turn;
    if (!Number.isSafeInteger(turn)) return false;
    // 该 turn 已经是 recovery 链的合法终态边界（插件已重投递最终通知）→ 关闭。
    if (record.recoveryFeedbackTerminal === true && record.recoveryFeedbackTerminalTurn === turn) return false;
    const reason = context.reason ?? {};
    const hasOutput = context.hasOutput === true;
    return classifyTurnOutcome(reason, hasOutput) === "recoverable"
      && canAutoRecover(record, reason, hasOutput);
  }
  // 无事件上下文的调用点（父 inbox delivery）：这里不判断「哪一轮 token 归谁」，只判断
  // 「该 child 是否还有**未被 recovery 链终态覆盖**的可恢复失败」。因此：
  // 1. 已处理过的链未完成（recoveryFeedbackActive）→ 打开；
  // 2. 否则回看事件日志中**尚未被 recovery 终态边界覆盖**的 turn/end：只要存在一个
  //    recoverable 且仍有自动恢复预算的 turn/end 就打开。**不能**因为最新的 turn/end
  //    是普通终态就提前返回 false——那正是 A 的缺陷形态（未来普通事件覆盖更早的
  //    recoverable 失败）；也不能读取尚未由 host 发布的 turn（只回看日志中已有的项）。
  // 父 inbox delivery 没有 turn/admission 关联，无法证明自己属于哪一轮；打开 gate 只会
  // 让它先撤回/排队（fail-closed），不会提前消费 token。
  if (record?.recoveryFeedbackActive === true) return true;
  const session = record?.session;
  const events = Array.isArray(session?.events) ? session.events : [];
  const terminalTurn = record?.recoveryFeedbackTerminal === true ? record.recoveryFeedbackTerminalTurn : void 0;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const turn = event?.data?.turn;
    if (event?.type !== "turn/end" || !Number.isSafeInteger(turn)) continue;
    // 该 turn 及其之前的所有失败都已被 recovery 链终态覆盖 → 后面的 turn/end 更早，
    // 同样被覆盖，可以直接关闭。
    if (Number.isSafeInteger(terminalTurn) && terminalTurn >= turn) return false;
    const reason = event.data?.reason ?? {};
    const hasOutput = turnHasNonEmptyText(events, turn);
    if (classifyTurnOutcome(reason, hasOutput) === "recoverable"
      && canAutoRecover(record, reason, hasOutput)) return true;
  }
  return false;
}
function recoveryFeedbackGateOpen(record) {
  // admission 已 accepted 但还没有 exact turn/end 时，feedback 也必须先撤回；
  // 不能因 session.events 尚无终态而让 root cohort 误判 ready。
  // 注：无事件上下文的调用点同样只读记录事实（见 recoveryFailureGateOpen 的 A 说明），
  // 不扫描 session.events。
  if (hasUnendedCurrentRecoveryAdmission(record)) return true;
  return recoveryFailureGateOpen(record);
}
/**
 * 可恢复失败期间的反馈门控：满足条件时撤回并排队，等恢复完成后再交接。
 * 语义不变：身份/代际/未完成 admission 的判定逐条保留。
 */
function gateRecoverableHandoffFeedback(agent, record, childId, message) {
  if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return false;
  const messageId = typeof message?.id === "string" && message.id.length > 0 ? message.id : void 0;
  const tombstones = record.recoveryFeedbackTombstones instanceof Map
    ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
  const deliveries = record.recoveryFeedbackDeliveries instanceof Set
    ? record.recoveryFeedbackDeliveries : (record.recoveryFeedbackDeliveries = new Set());
  // release 后由 parent.inject 同步触发 inserted；该 exact 对象必须放行一次，
  // 否则自己的最终通知会被 tombstone 拦回，后续同 id 副本才应继续拦截。
  if (deliveries.has(message)) return false;
  if (messageId !== void 0 && tombstones.has(messageId)) {
    try { agent.inbox?.remove?.(messageId); } catch {}
    return true;
  }
  const objectTombstones = record.recoveryFeedbackObjectTombstones instanceof WeakSet
    ? record.recoveryFeedbackObjectTombstones
    : (record.recoveryFeedbackObjectTombstones = new WeakSet());
  if (messageId === void 0) {
    // 同一无 id delivery 重复 inserted：按对象身份识别，必须继续拦截。
    if (objectTombstones.has(message)) return true;
    if (Array.isArray(record.gatedRecoveryFeedbacks)
      && record.gatedRecoveryFeedbacks.some((item) => item.parent === agent && item.childId === childId
        && item.activation === record.agent && item.message === message)) return true;
    // 无 id delivery 只在**真正的 recovery 链**打开时门控（见 recoveryFailureGateOpen 的无
    // 上下文分支：只读已经处理过的记录事实，不扫描 session.events）；
    // 「admission 尚未 turn/end」不构成门控理由（无法撤回，交给 marker 队列在 turn/end 消费）。
    if (!recoveryFailureGateOpen(record)) return false;
  } else if (!recoveryFeedbackGateOpen(record)) {
    return false;
  }
  const queued = Array.isArray(record.gatedRecoveryFeedbacks)
    ? record.gatedRecoveryFeedbacks : (record.gatedRecoveryFeedbacks = []);
  const existing = queued.find((item) => item.parent === agent && item.childId === childId
    && (messageId === void 0 ? item.message === message : item.messageId === messageId));
  if (existing !== void 0) {
    try {
      if (messageId !== void 0) {
        existing.removed = agent.inbox?.remove?.(messageId) === true || existing.removed === true;
      }
    } catch (error) {
      logger.warn("dsh-expert-group: recovery feedback duplicate remove failed: " + (error instanceof Error ? error.message : String(error)));
    }
    return true;
  }
  if (messageId === void 0) {
    // 无 id：无法 remove，只能登记 removed:false 的 gated marker + 对象身份 tombstone。
    // marker 在 gate 关闭（release/discard/换代/新 turn）时随列表一起丢弃，绝不进入
    // 普通 handoff 队列；恢复完成后由带 UUID 的重新 inject 通知完成合法交接。
    objectTombstones.add(message);
    queued.push({
      messageId: void 0,
      message,
      parent: agent,
      childId,
      sessionId: record.session?.id,
      activation: record.agent,
      removed: false,
    });
    logger.warn("dsh-expert-group: id-less recovery feedback cannot be retracted; gated until recovery settles");
    return true;
  }
  let removed = false;
  try {
    // Inbox.remove 必须同步返回 true；Promise/false/缺失都不能当作撤回成功。
    removed = agent.inbox?.remove?.(messageId) === true;
  } catch (error) {
    logger.warn("dsh-expert-group: recovery feedback gate remove failed: " + (error instanceof Error ? error.message : String(error)));
  }
  if (!removed) {
    // 撤回失败的消息不能保存成可重投递项；留下 finalized tombstone，防止
    // 重复 inserted 再走普通 markPending 并错误 resume root handoff。
    tombstones.set(messageId, "blocked");
    return true;
  }
  queued.push({
    messageId,
    message,
    parent: agent,
    childId,
    sessionId: record.session?.id,
    activation: record.agent,
    removed: true,
  });
  return true;
}
/**
 * 恢复成功或达到第 6 次失败时，历史异常 feedback 只能留下当前 generation 的一个
 * **标准 settlement**（`subagent-settled`/notice）作为最终交接。先从队列摘除再 inject，
 * 避免 inject 的同步 inserted 回调把同一 message 再门控；投递失败保持 handoff 暂停，
 * 不伪造 parent 已收到最终结论，也不会重复投递或遗留活动范围。
 *
 * B：不再为 legacy `subagent-report`(relay) 保留 fallback——relay 没有 correlation id，
 * 不能证明属于哪一轮，已由 inbox handler 整体 fail-closed（不撤回、不排队、不消费），
 * 因此永远不会出现在 gated 队列里；这里也不允许任何 relay 形态触发交接。
 */
function tombstoneGatedRecoveryFeedbacks(record, items = currentGatedRecoveryFeedbacks(record)) {
  const tombstones = record.recoveryFeedbackTombstones instanceof Map
    ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
  for (const item of items) {
    if (typeof item?.messageId === "string") tombstones.set(item.messageId, "blocked");
  }
}
function releaseGatedRecoveryFeedback(record, terminalTurn) {
  const queued = currentGatedRecoveryFeedbacks(record);
  const tombstones = record.recoveryFeedbackTombstones instanceof Map
    ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
  const deliveries = record.recoveryFeedbackDeliveries instanceof Set
    ? record.recoveryFeedbackDeliveries : (record.recoveryFeedbackDeliveries = new Set());
  // 先给所有已撤回消息留下 finalized marker；只有确实 remove===true 的最新标准
  // settlement 才有资格作为最终通知。remove 失败项不能伪造交接。
  for (const item of queued) {
    if (typeof item?.messageId === "string") tombstones.set(item.messageId, "blocked");
  }
  if (Array.isArray(record?.gatedRecoveryFeedbacks)) {
    record.gatedRecoveryFeedbacks = record.gatedRecoveryFeedbacks.filter((item) => !queued.includes(item));
  }
  record.recoveryFeedbackTerminal = true;
  record.recoveryFeedbackTerminalTurn = terminalTurn;
  const finalNotice = [...queued].reverse().find((item) => item.removed === true
    && item.message?.source?.kind === "subagent-settled");
  if (finalNotice === void 0) return false;
  tombstones.set(finalNotice.messageId, "delivering");
  deliveries.add(finalNotice.message);
  try {
    if (typeof record.parentAgent?.inject !== "function") {
      deliveries.delete(finalNotice.message);
      tombstones.set(finalNotice.messageId, "blocked");
      logger.warn("dsh-expert-group: recovery feedback final delivery unavailable");
      return false;
    }
    record.parentAgent.inject(finalNotice.message);
    tombstones.set(finalNotice.messageId, "delivered");
    return true;
  } catch (error) {
    deliveries.delete(finalNotice.message);
    tombstones.set(finalNotice.messageId, "blocked");
    logger.warn("dsh-expert-group: recovery feedback final delivery failed: " + (error instanceof Error ? error.message : String(error)));
    return false;
  }
}
function discardGatedRecoveryFeedbacks(record, terminalTurn) {
  tombstoneGatedRecoveryFeedbacks(record);
  if (Array.isArray(record?.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
  record.recoveryFeedbackTerminal = true;
  record.recoveryFeedbackTerminalTurn = terminalTurn;
}
function resetRecoveryFeedbackGateForNewTurn(record, session, turn) {
  if (record?.recoveryFeedbackTerminal !== true || record.recoveryFeedbackTerminalTurn === turn
    || record.session !== session) return;
  // 同一 Session 的新 turn 是下一项任务；此前终态的重投递已经结束，可重新门控。
  record.recoveryFeedbackTerminal = false;
  record.recoveryFeedbackTerminalTurn = void 0;
  tombstoneGatedRecoveryFeedbacks(record);
  record.recoveryFeedbackDeliveries?.clear?.();
  if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
}

  return {
    isCurrentRecoverySessionIdentity,
    isCurrentRecoveryFeedbackIdentity,
    currentGatedRecoveryFeedbacks,
    wasGatedRecoveryFeedback,
    hasUnendedCurrentRecoveryAdmission,
    recoveryFailureGateOpen,
    recoveryFeedbackGateOpen,
    gateRecoverableHandoffFeedback,
    tombstoneGatedRecoveryFeedbacks,
    releaseGatedRecoveryFeedback,
    discardGatedRecoveryFeedbacks,
    resetRecoveryFeedbackGateForNewTurn,
  };
}
/**
 * H4：child turn 结算与 handoff 迁移。
 *
 * @param {object} deps - 见 `createHandoffDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} H4 能力面。
 */
function installChildTurnSettlement(deps, api) {
  const {
    host,
    logger,
    agents,
    getRecoveryRecord,
    canAutoRecover,
    readChildActivation,
    pendingChildTurnEnds,
    handoffAdmissionCohort,
    delegationTracker,
    isRootAgentIdentity,
    handleChildTurnEnd,
  } = deps;

  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const currentGatedRecoveryFeedbacks = (...args) => api.currentGatedRecoveryFeedbacks(...args);
  const messageIdForHandoffAdmission = (...args) => api.messageIdForHandoffAdmission(...args);
  const consumeFailedHandoffChild = (...args) => api.consumeFailedHandoffChild(...args);

function childTurnNeedsImmediateRecovery(record, session, event) {
  const turn = event?.data?.turn;
  const events = Array.isArray(session?.events) ? session.events : [];
  if (!Number.isSafeInteger(turn)) return false;
  const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
  if (record.pendingRecoveries instanceof Map
    && findRecoveryOpByMessage(record.pendingRecoveries, turnMsgIds) !== void 0) return true;
  const reason = event?.data?.reason ?? {};
  const hasOutput = turnHasNonEmptyText(events, turn);
  return classifyTurnOutcome(reason, hasOutput) === "recoverable"
      && canAutoRecover(record, reason, hasOutput);
}
/** 把 handoff/admission 记账迁移到新 activation（replacement / 冷恢复）。 */
function releaseTerminalActivitiesBeforeHandoffFeedback(record, session, event, admission) {
  if (admission?.failed === true || record?.session !== session) return;
  // handleChildTurnEnd 之后仍会用 sessionState.claimTurn 去重；提前释放在它
  // 之前发生，因此 exact admission 自身也要记住首次判定，避免迟到旧 event
  // 在 recoveryCount 改变后把原本 recoverable 的 activity 误判为终态。
  if (admission?.terminalActivityOutcome !== void 0) return;
  const turn = event?.data?.turn;
  const events = Array.isArray(session?.events) ? session.events : [];
  if (!Number.isSafeInteger(turn)) return;
  const reason = event?.data?.reason ?? {};
  const hasOutput = turnHasNonEmptyText(events, turn);
  const outcome = classifyTurnOutcome(reason, hasOutput);
  const recoveryCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
    ? record.recoveryCount : 0;
  const willRecover = outcome === "recoverable" && shouldAutoRecover(reason, hasOutput, recoveryCount);
  if (admission !== void 0) admission.terminalActivityOutcome = willRecover ? "recoverable" : outcome;
  if (willRecover) return;

  // admissionForTurn 已按 exact child/session/messageId 认领；mixed admission 没有
  // handoff token 时也只能使用当前 turn 的 messageId/taskKey。不能按 childId 粗暴
  // 清理替代 child 或同 child 的其他活动任务。
  const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
  const admissionMessageId = admission === void 0 ? void 0 : messageIdForHandoffAdmission(admission, record);
  if (typeof admissionMessageId === "string") turnMsgIds.add(admissionMessageId);
  const taskKeys = taskKeysForTurn(record.tasks, turnMsgIds);
  const activityIds = delegationTracker.activeTaskIdsForTurn({
    parentId: record.parentId,
    role: record.role,
    childId: record.childId,
    turnMsgIds,
    taskKeys,
  });
  delegationTracker.completeActiveTasksByIds(activityIds);
}

function deferChildTurnEnd(record, session, event, admission) {
  const parent = record?.parentAgent;
  if (!isRootAgentIdentity(parent)) return;
  const entries = pendingChildTurnEnds.get(parent) ?? [];
  const turn = event?.data?.turn;
  if (!entries.some((entry) => entry.record === record && entry.session === session && entry.event?.data?.turn === turn)) {
    entries.push({ record, session, event, childId: session?.id, admission, parent });
  }
  pendingChildTurnEnds.set(parent, entries);
}
function isCurrentChildRecord(record, session) {
  const childId = session?.id;
  const current = typeof childId === "string" ? agents.get(childId) : void 0;
  const activation = typeof childId === "string" ? readChildActivation(childId) : void 0;
  return getRecoveryRecord(childId) === record
    && record?.agent === current
    && activation?.agent === record.agent
    && record?.session === session;
}
function consumeChildTurnEnd(parent, record, session, event, admission) {
  const turn = event?.data?.turn;
  const events = Array.isArray(session?.events) ? session.events : [];
  const messageIds = messageIdsOfTurnWithClaimed(record?.claimed, events, turn);
  const failed = consumeFailedHandoffChild(parent, session?.id, admission, {
    session,
    sessionId: session?.id,
    turn,
    messageIds,
  });
  handleChildTurnEnd(record, session, event, { allowRecovery: !failed });
}
function settlePendingChildTurnEnds(parent, allowRecovery, admission) {
  const entries = pendingChildTurnEnds.get(parent);
  if (entries === void 0) return;
  const selected = admission === void 0 ? entries : entries.filter((entry) => entry.admission === admission);
  if (selected.length === 0) return;
  const selectedSet = new Set(selected);
  const remaining = entries.filter((entry) => !selectedSet.has(entry));
  if (remaining.length === 0) pendingChildTurnEnds.delete(parent);
  else pendingChildTurnEnds.set(parent, remaining);
  for (const entry of selected) {
    if (!isCurrentChildRecord(entry.record, entry.session)) continue;
    try {
      const turn = entry.event?.data?.turn;
      const events = Array.isArray(entry.session?.events) ? entry.session.events : [];
      const messageIds = messageIdsOfTurnWithClaimed(entry.record?.claimed, events, turn);
      const failed = consumeFailedHandoffChild(parent, entry.childId, entry.admission, {
        session: entry.session, sessionId: entry.session?.id, turn, messageIds,
      });
      handleChildTurnEnd(entry.record, entry.session, entry.event, { allowRecovery: allowRecovery === true && !failed });
    } catch (error) {
      logger.warn("dsh-expert-group: pending child turn/end handler failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}
function clearPendingChildTurnEnds(parent, record) {
  const entries = pendingChildTurnEnds.get(parent);
  if (entries === void 0) return;
  const remaining = record === void 0 ? [] : entries.filter((entry) => entry.record !== record);
  if (remaining.length === 0) pendingChildTurnEnds.delete(parent);
  else pendingChildTurnEnds.set(parent, remaining);
}
function migrateChildHandoff(parent, previousChildId, nextChildId, nextActivation, previousActivation) {
  if (!isRootAgentIdentity(parent) || previousChildId === nextChildId) return;
  for (const entry of host.handoff.entries()) {
    if (entry.parent === parent && entry.childId === previousChildId) {
      handoffAdmissionCohort.rebindChild(entry, nextChildId);
      entry.childId = nextChildId;
      entry.messageId = void 0;
      entry.turnEnded = false;
      entry.feedbackSeen = false;
      entry.feedbackExact = false;
      entry.releaseQueued = false;
      // C：replacement 迁移后旧代际的终态身份与接收顺序不再成立；新 child 的首个终态
      // 必须重新登记（receipt 与其附属 exact 身份同生命周期，随迁移一起清除）。
      delete entry.turnEndEvidence;
      // replacement child 开启新的 turn 归属判断；不能沿用旧 activation 已记录的
      // terminal/recoverable 结果，否则新 child 的首次终态会被提前返回跳过。
      entry.terminalActivityOutcome = void 0;
    }
  }
  if (nextActivation !== void 0) {
    handoffAdmissionCohort.updateActivation(parent, nextChildId, nextActivation, {
      previousActivation, nextSession: nextActivation?.session,
    });
  }
}
/**
 * root 用户等待（ask_user_question / exit_plan_mode）的同步 guard。
 *
 * 改造后的职责边界：
 * - **不再**暂停/恢复任何 durable goal。用户等待本身由宿主保持 root turn 打开
 *   （宿主完整 await 工具 execute 的返回），goal round driver 只在 root idle 时
 *   推进，因此这里没有任何 goal API 调用，也不需要 barrier；
 * - 保留非 goal 的 pending-user-wait 记账与一次性提示音：按 exact root Agent 记录
 *   当前等待的工具名，同一次等待重复进入 guard（重试/重复调用）不重复提示，
 *   等待被清理后再次登记才再提示一次；
 * - root 已销毁 / 代际被替换 / 插件卸载中一律拒绝：此时不能开始一个没有归属的等待。
 *
 * @param {object} agent - guard 所属的 exact root Agent。
 * @param {object} execution - 待执行的 ToolExecution。
 * @returns {string|undefined} 拒绝原因；undefined 表示放行。
 */
  return {
    childTurnNeedsImmediateRecovery,
    releaseTerminalActivitiesBeforeHandoffFeedback,
    deferChildTurnEnd,
    isCurrentChildRecord,
    consumeChildTurnEnd,
    settlePendingChildTurnEnds,
    clearPendingChildTurnEnds,
    migrateChildHandoff,
  };
}
