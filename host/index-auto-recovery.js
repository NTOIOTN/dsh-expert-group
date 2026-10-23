/**
 * 入口自动恢复执行域（R4c · 票据 17）。
 *
 * 这一域负责「专家 child 的 turn/end 失败后如何自愈」的**执行**部分：
 * - B1 流控：turn/end 结算、恢复计数、op 创建/取代/失败收口与退避 timer 调度；
 * - B2 重建：原 child 不可续接或 route 改变时，按原 parent/role/路由重建 continuable child；
 * - B3 投递：父代理身份经 manager sendMessage 投递「继续执行」；容量/暂态失败带预算重试；
 * - B4 事件桥：父 inbox feedback（inserted/spliced）与 session 事件（turn/end、user/message、
 *   step/start、tool/result）的 handler。
 *
 * ## 与 R4c 记录注册表的分工（票据 17 §2.5）
 * recovery record 子树（容器与记录生命周期）的 owner 是 `host/index-recovery.js`：
 * 本模块**不持有也不搜索容器**，只接收注册表命令给出的 record 对象与只读投影
 * （getRecord / recordsView / bindRecoverySession / moveRecoveryRecordToChild / nextRecoveryOpId）。
 * 记录上的 feedback 门控（gate/tombstone/release）仍由 handoff 域（R4a，票据 15）提供的
 * 三个窄命令实现，本模块只调用它们，不自行改写 tombstone/delivery 容器。
 *
 * ## 组合根保留的职责（铁律 1/2）
 * `ctx.on("agent/inbox/inserted")`、`ctx.on("session/event")`、`ctx.on("agent/inbox/claimed")`
 * 与卸载用的 `ctx.effect` 注册语句与 disposer 顺序仍留在 `index.js` 的原注册点：
 * 本模块只返回 handler（onInboxInserted / onSessionEvent / onInboxClaimed）。
 * 域服务**不接收 ctx**。
 *
 * ## 行为等价
 * 恢复计数与预算、op 的生命周期与取代判定、投递重试时点、事件到达顺序、handoff 门控
 * 与最终结算全部与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-auto-recovery
 */
import { SUBAGENT_CAPACITY_MESSAGE, interruptFailureCanFallback, isSubagentCapacityError } from "../shared/capacity-errors.js";
import { subagentFeedbackChildId } from "../shared/feedback-identity.js";
import { CONTEXT_INHERITANCE_ERROR_CODES } from "../shared/model-route.js";
import { OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";
import { sameDurableSessionId } from "../shared/structured-path.js";
import {
  AUTO_RECOVERY_LIMIT,
  CLAIMED_LIMIT,
  appendRecoveryRetryCount,
  evictOldestEntries,
} from "../shared/recovery-ledger.js";
import {
  buildRecoveryMessage,
  clearRecoveryOpTimer,
  createRecoveryOp,
  findRecoveryOpByMessage,
  recoveryDispatchCanStart,
  recoveryOpCanBeSuperseded,
  recoveryOpIsAccepted,
  recoveryOpIsPending,
  scheduleRecoveryOpTimer,
} from "../shared/retry-policy.js";
import {
  applyTurnToTasks,
  classifyTurnOutcome,
  messageIdsOfTurnWithClaimed,
  rebindPendingTaskByClaimed,
  rememberClaimedPlaceholder,
  recoveryRebuildCanCommit,
  shouldAutoRecover,
  shouldForgetTask,
  shouldInstallRebuiltChild,
  shouldRebuildRecoveryChild,
  supersedeTaskBindings,
  taskKeysForTurn,
  turnHasNonEmptyText,
} from "../shared/turn-settlement.js";
import { delegationScopeKey } from "../shared/structured-path.js";
import { buildExpertTaskPrompt } from "./expert-task-prompt.js";
import {
  CONTINUABLE_MARKER,
  DENY_MARKER,
  EFFORT_MARKER,
  PARENT_MARKER,
  PERSONA_MARKER,
  ROLE_MARKER,
  ensureExpertSendMessageDenied,
  registerPluginExpertChildAgent,
  resolveRecoveryPersona,
  validPersonaMarker,
} from "./expert-guards.js";
import { EXPERT_INHERIT_CONTEXT_MARKER, EXPERT_ROUTE_MARKER, EXPERT_SUBAGENT_PROVIDER_MARKER } from "../shared/model-route.js";

/**
 * 四个工厂分开导出而不是合成一个大工厂：每组的能力面与依赖面都不同，合并会把
 * 参数推到 12 组以上（C3 硬上限 8 组）。组合根按 流控 -> 重建 -> 投递 -> 事件桥
 * 的顺序装配，投递组通过窄回调拿到流控与重建能力。
 */

/**
 * B1：自动恢复的 turn/end 结算与 op 调度（流控组）。
 *
 * 每个 continuable child 的 turn/end 失败/空返回时，插件以父代理身份投递一条中文
 * 「继续执行」指令（同一 child 连续最多 5 次）；非阻塞 admission 只登记恢复链。
 * 本组持有恢复 op 的预算/取代/失败收口与 timer 调度；实际投递在 B3（dispatch）。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 恢复流控能力面。
 */
export function createAutoRecoveryFlow(deps) {
  const { logger, records, delegation, recovery, handoff, identity, dispatch } = deps;
  const { lineage } = identity;
  const { releaseGatedRecoveryFeedback, resetRecoveryFeedbackGateForNewTurn } = handoff;
  const { nextRecoveryOpId, requestRetryStateIsExhausted, recordsView, bindRecoverySession } = records;
  const delegationTracker = delegation;
  // 跨组调用：投递组在组合根后创建，这里只交出调用期解析的窄能力。
  const dispatchRecovery = (...args) => dispatch.dispatchRecovery(...args);

// ── 自动恢复（自愈监督） ──────────────────────────────────────
  // 每个专家 continuable child 的 turn/end 失败/空返回时，插件以父代理身份经
  // manager sendMessage 投递一条中文「继续执行」指令（同一 child 连续最多 5 次）；
  // 非阻塞 admission 只登记恢复链；子代理结果通过 DSH 后续 feedback 交付。


  /** 统一安排恢复消息的退避 timer；timer 失败仍按确定的调度终态收口。 */
  function scheduleRecoveryDispatchTimer(record, session, reason, op) {
    const scheduled = scheduleRecoveryOpTimer(op, record.recoveryCount, () => {
      // timer callback 已先清句柄；这里再排 microtask，保留原有 append 重入保护。
      queueMicrotask(() => {
        // 父销毁/插件卸载可在 timer 或 microtask 排队后同步删除 record。serialize()
        // 的 entryOf 会为不存在的 scope 重建空项，因此两层都必须做生命周期 guard。
        if (!recoveryDispatchCanStart(recordsView, session.id, record, op)) return;
        const recoveryScope = delegationScopeKey(record.parentId, record.role);
        void delegationTracker.serialize(recoveryScope, async () => {
          try {
            await dispatchRecovery(op, record, session, reason);
          } catch (error) {
            // 仅在 op 尚未 acceptance 时终结；已接受 op 的 ancillary 异常不能
            // 把 manager 已接收的消息误删。该兜底仍在同 scope 锁内执行。
            if (recoveryOpIsPending(record.pendingRecoveries, op) && !recoveryOpIsAccepted(op)) {
              failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：" + (error instanceof Error ? error.message : String(error)));
            }
            throw error;
          }
        }).catch((error) => {
          // dispatchRecovery 已处理可重试投递失败；这里只记录未预见的锁级异常。
          logger.warn("dsh-expert-group: auto-recovery dispatch failed: " + (error instanceof Error ? error.message : String(error)));
        });
      });
    }, {
      // timer callback 前的 guard；queueMicrotask 内仍重复校验，覆盖 timer/append 竞态。
      isActive: () => recoveryDispatchCanStart(recordsView, session.id, record, op),
      onError: (error) => {
        if (recoveryOpIsPending(record.pendingRecoveries, op) && !recoveryOpIsAccepted(op)) {
          failPendingRecoveryOp(op, record, reason, "自动恢复计时器失败：" + (error instanceof Error ? error.message : String(error)));
        }
        logger.warn("dsh-expert-group: auto-recovery timer failed: " + (error instanceof Error ? error.message : String(error)));
      },
    });
    if (!scheduled && recoveryOpIsPending(record.pendingRecoveries, op)) {
      // 非法/越界 count 或 scheduler 不可用时不尝试无退避 dispatch，直接走原失败收口。
      failPendingRecoveryOp(op, record, reason, "自动恢复计时器未安排");
    }
  }

  /**
   * 处理一次专家 child 的 turn/end（仅 session/event 监听器调用）：自动恢复链、
   * 任务绑定结局回写与活动范围清理。
   * 同一 turn/end 只会被监听器处理一次；恢复 turn 按消息 id 完结对应 op，
   * 后续失败时创建新 op 并继承 taskKeys。
   */
  function handleChildTurnEnd(record, session, event, { allowRecovery = true } = {}) {
    const turn = event?.data?.turn;
    const reason = event?.data?.reason ?? {};
    const events = session?.events;
    if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return;
    const sessionState = bindRecoverySession(record, session);
    if (sessionState === void 0 || !record.sessionState.claimTurn(session, turn)) return;
    resetRecoveryFeedbackGateForNewTurn(record, session, turn);
    const hadRecoveryFeedback = record.recoveryFeedbackActive === true
      || (record.pendingRecoveries instanceof Map && record.pendingRecoveries.size > 0)
      || (Array.isArray(record.gatedRecoveryFeedbacks) && record.gatedRecoveryFeedbacks.length > 0);
    const hasOutput = turnHasNonEmptyText(events, turn);
    const outcome = classifyTurnOutcome(reason, hasOutput);
    // B2：turn 消息归属 = 事件日志 user/message ∪ claimed 认领映射（并集）。
    const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
    // 该 turn 是恢复指令触发的 turn（turn 内包含恢复消息）：找到对应 op 并
    // 完结（done）。恢复 turn 再次失败时，下面按正常规则创建新 op 并继承
    // 已完结 op 的 taskKeys。
    let finishedOp;
    if (record.pendingRecoveries.size > 0) {
      finishedOp = findRecoveryOpByMessage(record.pendingRecoveries, turnMsgIds);
      if (finishedOp !== void 0) {
        // 成功/失败 turn 完结对应 op 时先清掉残留 timer；clear helper 只触碰
        // 该 op，迟到 callback 还会因取消标记与 pending guard 双重失效。
        clearRecoveryOpTimer(finishedOp);
        record.pendingRecoveries.delete(finishedOp.id);
        finishedOp.done = true;
      }
    }
    // 非法历史值按 0 次保守归一，避免字符串拼接或越界 count 产生无策略 timer。
    const currentRecoveryCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
      ? record.recoveryCount : 0;
    // 请求级 retry 已耗尽时，turn/end 只是同一次模型失败的终态；不能再把
    // child continuation 当成另一轮失败计数，否则一次故障会消耗两套预算。
    const requestRetryExhausted = requestRetryStateIsExhausted(record.agent, session, turn);
    // 等待被取消时仍需清理任务/范围，但不得给原 child 再投递自动恢复。
      const willRecover = allowRecovery === true
      && requestRetryExhausted !== true
      && outcome === "recoverable"
      && shouldAutoRecover(reason, hasOutput, currentRecoveryCount);
    if (outcome === "success") {
      // 任一成功 turn：连续恢复计数清零（父代理正常 steer 的新任务同样适用）。
      record.recoveryCount = 0;
    } else if (willRecover) {
      record.recoveryFeedbackActive = true;
      record.recoveryFeedbackTerminal = false;
      record.recoveryFeedbackTerminalTurn = void 0;
      record.recoveryCount = currentRecoveryCount + 1;
    }
    // S1-C：把本次 turn 的结局回写到任务绑定。恢复 turn（有 finishedOp）用
    // 其继承的 taskKeys 定位原任务；普通 turn 按消息 id 反查。确定失败返回
    // 的 taskKey 立即 forgetTask（相同 prompt 可重新排队而非永久 reused）；
    // P5：forget 必须带 child 身份保护（route 切换后旧 child 的失败不误删
    // 新 route 同名任务指纹）。
    const failedKeys = applyTurnToTasks(
      record.tasks, events, turn, turnMsgIds,
      outcome === "success" ? "success" : willRecover ? "recoverable" : "failed",
      reason,
      recovery.failureMessage(record, reason, session),
      finishedOp !== void 0 ? [...finishedOp.taskKeys] : void 0,
    );
    for (const key of failedKeys) forgetTaskIfCurrentChild(record, key);
    // 成功或确定失败才撤销活动范围；可恢复 turn 必须保留登记直到恢复链终态。
    const terminalTaskKeys = outcome === "success"
      ? taskKeysForTurn(record.tasks, turnMsgIds, finishedOp !== void 0 ? [...finishedOp.taskKeys] : void 0)
      : willRecover ? [] : failedKeys;
    // P1：按独立 admission messageId 优先匹配，不再依赖 record.tasks 是否尚未
    // 被 TASK_BINDING_LIMIT 淘汰；taskKey 只用于消息关联尚未回填时的兜底。
    if (outcome === "success" || !willRecover) {
      delegationTracker.completeActiveTasksForTurn({
        parentId: record.parentId,
        role: record.role,
        childId: record.childId,
        turnMsgIds,
        taskKeys: terminalTaskKeys,
      });
    }
    if (!willRecover && hadRecoveryFeedback) {
      // 活动范围已在最终分支先终态化；现在才允许唯一 settlement 交接，旧
      // recoverable 失败通知已经由 releaseGatedRecoveryFeedback 丢弃。
      record.recoveryFeedbackActive = false;
      releaseGatedRecoveryFeedback(record, turn);
    }
    if (willRecover) {
      // B4：为本次恢复创建独立 op，把绑定到该 turn 且进入 waitingRecovery 的
      // 记录恢复 op 后再 dispatch——并发恢复互不串链、互不重复。
      // 普通新任务与自动恢复交错时都经统一 helper 投递；恢复保持 interrupt=false。
      const op = createRecoveryOp(nextRecoveryOpId(), turn);
      // S1-C：恢复链传播——新 op 继承已完结 op 的 taskKeys（不要丢）；
      // 首个 op 从触发 turn 的消息 id 反查 record.tasks 填入原任务 key。
      if (finishedOp !== void 0) {
        for (const key of finishedOp.taskKeys) op.taskKeys.add(key);
        // 前一个 recovery op 已把活动项关联到当前恢复消息；显式继承其 id，
        // 即使当前 Session 日志或 record.tasks 已被淘汰也不丢范围生命周期。
        for (const activityId of finishedOp.activityIds ?? []) op.activityIds.add(activityId);
      } else {
        for (const [key, binding] of record.tasks) {
          if (typeof binding?.messageId === "string" && turnMsgIds.has(binding.messageId)) op.taskKeys.add(key);
        }
      }
      // P1：从当前 turn 的 stable messageId 捕获活动项。taskKeys 只补早期
      // admission/claimed 竞态尚未写入 messageId 的少数情况。
      for (const activityId of delegationTracker.activeTaskIdsForTurn({
        parentId: record.parentId,
        role: record.role,
        childId: record.childId,
        turnMsgIds,
        taskKeys: op.taskKeys,
      })) op.activityIds.add(activityId);
      record.pendingRecoveries.set(op.id, op);
      // P1：恢复 timer 到期后仍经 queueMicrotask，避开当前 Session append 发布栈。
      // timer 只负责等待与一次性唤醒；manager sendMessage、admission 和 scope barrier
      // 继续由原 dispatchRecovery 处理，不阻塞 session/event 监听器。
      scheduleRecoveryDispatchTimer(record, session, reason, op);
    }
  }

  /**
   * 安全 forgetTask（P5）：全文唯一允许调用 delegationTracker.forgetTask 的
   * 入口——仅当 scope 当前记录的 child 仍是 record 所属 child（childId 一致）
   * 时才 forget：旧 route child 的迟到失败不得删除新 route 同名任务指纹
   * （route 切换后 delegationTracker 的 child 已换成新 child、tasks 已重建）。
   * @param {object} record - 恢复记录（含 childId/parentId/role）。
   * @param {string} taskKey - 要 forget 的归一化任务 key。
   * @returns {boolean} 确实 forget 返回 true；身份不匹配或非法输入返回 false。
   */
  function forgetTaskIfCurrentChild(record, taskKey) {
    if (record === null || typeof record !== "object") return false;
    const scope = delegationScopeKey(record.parentId, record.role);
    // 多 child 语义：归属判定优先看「这个任务 key 绑定的 child」，而不是「本 scope
    // 最近一个 child」——同 route 下并存的独立 child 各自持有自己的任务指纹，较早
    // child 的确定失败同样必须能 forget 它自己的任务（否则相同 prompt 会被永久
    // 判为 reused 并等一个永远不会结算的 turn）。
    const bound = delegationTracker.getTaskChild(scope, taskKey);
    const owner = bound !== void 0 ? bound.childId : delegationTracker.getChild(scope)?.childId;
    if (!shouldForgetTask(owner, record.childId)) return false;
    return delegationTracker.forgetTask(scope, taskKey);
  }

  /**
   * 恢复投递失败时把 op 对应的原任务写成确定失败并安全 forgetTask（P4）：
   * 任务绑定也必须终态化（outcome:"failed"
   * + 投递失败文案），否则后续相同 prompt 会被判定 reused 并等待一个永远
   * 不会结算的 turn；forget 走 forgetTaskIfCurrentChild（P5 身份保护）。
   * 只处理 op.taskKeys 继承的原任务（恢复链跨 op 传播，S1-C）；op 无继承
   * key 时（绑定已被上限淘汰等）为 no-op。
   */
  function failRecoveryOpTasks(op, record, reason, message) {
    const failedKeys = op?.taskKeys instanceof Set
      ? applyTurnToTasks(record.tasks, void 0, 0, void 0, "failed", reason, message, [...op.taskKeys])
      : [];
    for (const key of failedKeys) {
      forgetTaskIfCurrentChild(record, key);
    }
    // P1：恢复 op 创建时已捕获精确 activityIds。即使同 child 又出现相同
    // taskKey 的新任务，也只能清理本恢复链指向的旧活动项；不再按 key 扩大删除。
    // 停止证据（票据 07）：本函数只在恢复指令**未被 manager 接受**（投递确定失败）
    // 时调用；触发恢复的原 turn/end 已经到达，因此这些 activity 没有新的执行在写。
    delegationTracker.completeActiveTasksByIds(op?.activityIds);
  }

  const RECOVERY_SUPERSEDED_MESSAGE = "自动恢复已被新任务取代 (superseded by a newer task)";

  /**
   * 新任务到达时失效尚未被 manager 接受的自动恢复 op。只有 op 尚未
   * dispatching 且 accepted/messageId 均为空时才可取代；同 scope 的
   * dispatchRecovery 会在同一 tracker 临界区内把 sendMessage 返回的 messageId
   * 同步写入 accepted，因而不会留下「已接受但回调尚未来得及写回」窗口。
   * 先从 pending 表摘除并标记 done，再 abort controller，令迟到回调通过
   * pending 检查自然丢弃。调用方必须只在新消息/新 child 已成功 admission
   * 后调用本函数；signal 或 admission 失败不得提前取代旧 recovery。
   */
  function supersedePendingRecoveryOps(record) {
    if (record?.pendingRecoveries instanceof Map === false) return 0;
    let count = 0;
    for (const op of [...record.pendingRecoveries.values()]) {
      if (!recoveryOpCanBeSuperseded(op)) continue;
      // 关闭 pending admission 之后再 abort；先清 timer，迟到 callback 不能复活 op。
      clearRecoveryOpTimer(op);
      op.done = true;
      record.pendingRecoveries.delete(op.id);
      if (op.controller !== void 0) op.controller.abort();
      const supersededKeys = supersedeTaskBindings(
        record.tasks,
        op.taskKeys,
        RECOVERY_SUPERSEDED_MESSAGE,
      );
      for (const key of supersededKeys) {
        forgetTaskIfCurrentChild(record, key);
      }
      // 任务 binding 已淘汰时 supersededKeys 为空，仍必须清掉该 op 所有稳定
      // 活动关联；activityIds 是唯一清理依据，避免同 key 新活动被误删。
      // 停止证据（票据 07）：只有从未 dispatching/acceptance 的 op 才可被取代
      // （recoveryOpCanBeSuperseded），即恢复指令从未投递、没有产生新的 child turn；
      // 触发恢复的原 turn/end 已经到达。已接受/在途 op 绝不在这里释放。
      delegationTracker.completeActiveTasksByIds(op.activityIds);

      count += 1;
    }
    return count;
  }

/**
   * 结束一个未被 manager 接受的 recovery op，并结算其原任务。
   * 调用方位于 scope 临界区内；先摘除 pending，再标记 done，避免 abort 或
   * 迟到回调重入时把失败 op 当作仍可用。
   */
  function failPendingRecoveryOp(op, record, reason, message) {
    if (!recoveryOpIsPending(record?.pendingRecoveries, op)) return false;
    // sendMessage/rebuild/admission 失败都走同一清理点；重复 clear 是幂等的。
    clearRecoveryOpTimer(op);
    op.dispatching = false;
    record.pendingRecoveries.delete(op.id);
    op.done = true;
    // 失败收口也终止 manager sendMessage 的 signal；正常 rejection 时虽已结算，
    // 该调用仍保证意外残留的异步工作不会继续占用恢复记录。
    if (op.controller !== void 0) op.controller.abort();
    // 所有恢复投递/重建失败入口统一在这里附加累计次数。message 保留调用方
    // 的底层 detail，formatter 幂等，嵌套失败收口不会重复写「已自动重试」。
    const failureMessage = appendRecoveryRetryCount(message, record.recoveryCount);
    failRecoveryOpTasks(op, record, reason, failureMessage);
    if (record.recoveryFeedbackActive === true
      || (Array.isArray(record.gatedRecoveryFeedbacks) && record.gatedRecoveryFeedbacks.length > 0)) {
      // sendMessage/rebuild 失败没有新的 child turn 可触发终态；op 已释放 activity 后，
      // 仍要把恢复链收口到最多一个已撤回 settlement。
      record.recoveryFeedbackActive = false;
      releaseGatedRecoveryFeedback(record, void 0);
    }

    return true;
  }

function retryRecoveryDispatchAfterFailure(op, record, session, reason, error) {
    if (!recoveryOpIsPending(record?.pendingRecoveries, op) || recoveryOpIsAccepted(op)) return false;
    const parent = record.parentAgent;
    const rootToken = lineage.tokenOf(parent);
    if (!lineage.isLiveGeneration(parent, rootToken) || recovery.isTerminalDispatchError(error)) return false;
    const currentCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
      ? record.recoveryCount : 0;
    if (currentCount >= AUTO_RECOVERY_LIMIT) return false;
    clearRecoveryOpTimer(op);
    op.dispatching = false;
    op.done = true;
    record.pendingRecoveries.delete(op.id);
    if (op.controller !== void 0) op.controller.abort();
    const retry = createRecoveryOp(nextRecoveryOpId(), op.triggerTurn);
    for (const key of op.taskKeys ?? []) retry.taskKeys.add(key);
    for (const activityId of op.activityIds ?? []) retry.activityIds.add(activityId);
    record.recoveryCount = currentCount + 1;
    record.recoveryFeedbackActive = true;
    record.pendingRecoveries.set(retry.id, retry);
    logger.warn("dsh-expert-group: transient recovery delivery failure; retrying: " + (error instanceof Error ? error.message : String(error)));
    scheduleRecoveryDispatchTimer(record, session, reason, retry);
    return true;
  }

  return {
    handleChildTurnEnd,
    scheduleRecoveryDispatchTimer,
    failPendingRecoveryOp,
    retryRecoveryDispatchAfterFailure,
    supersedePendingRecoveryOps,
    forgetTaskIfCurrentChild,
  };
}

/**
 * B2：原 child 不可续接或 route 已改变时按原 route 重建 continuable child。
 *
 * 只迁移触发本次恢复 op 的任务绑定；persona 优先级、目标 subagent provider 与结构化
 * 回退标记全部保持迁移前语义。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 重建能力面。
 */
export function createRecoveryChildRebuild(deps) {
  const { records, recovery, identity, storage, experts, structured, agents, delegation } = deps;
  const { recordsView, moveRecoveryRecordToChild } = records;
  const { readSnapshot } = storage;
  const {
    roleCatalog,
    resolvePersonaForAdmission,
    resolvePersistedSubagentTarget,
    startExpertActivation,
    contextInheritanceError,
  } = experts;
  const { markStructuredRequest } = structured;
  const { lineage } = identity;
  const delegationTracker = delegation;

/**
   * 原 child 不可续接或 route 已改变时，按原 parent/role/模型路由重建一个
   * continuable child。只迁移触发本次恢复 op 的任务绑定；其他 host/权限错误
   * 不会进入此路径，仍由 dispatchRecovery 的既有失败收口反馈给调用方。
   */
  async function rebuildRecoveryChild(op, record, parent, reason) {
    const rootToken = lineage.tokenOf(parent);
    if (!lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    const source = recovery.contextFor(record, op);
    const promptText = recovery.promptFor(record, op);
    if (source === void 0 || typeof promptText !== "string" || promptText.length === 0) {
      throw new Error("cannot rebuild recovery child because the original task context is unavailable");
    }
    if (typeof source.provider !== "string" || typeof source.model !== "string") {
      throw new Error("cannot rebuild recovery child because its original model route is unavailable");
    }
    // 角色元数据：冷恢复必须使用 child 创建时持久化的 persona，而不是把角色变成未知
    // 或回落到通用人格；两者都没有时 fail-closed（未注册角色连默认 persona 都没有，
    // 重建出来的 child 会失去全部约束）。
    // 注意：本函数内的 `source` 是 recovery 上下文，child_models 读源必须显式走 storage 读源。
    const persistedChild = typeof record.childId === "string" ? readSnapshot()?.childModels?.[record.childId] : void 0;
    const recordedPersona = validPersonaMarker(persistedChild?.[PERSONA_MARKER])
      ?? validPersonaMarker(source?.[PERSONA_MARKER])
      ?? validPersonaMarker(source?.persona);
    const oldChildId = record.childId;
    // recovery record 仍保存旧 request.toolFilter；新版本若已保存 marker，优先沿用
    // admission 的完整结果，再用旧字段兼容历史记录。
    const recoveryDeny = ensureExpertSendMessageDenied(
      source?.[DENY_MARKER] ?? source?.agentOptions?.[DENY_MARKER] ?? source.toolFilter,
    );
    // 路由仍沿用 source 的 provider/model。persona 的优先级（票据 27）：
    // 1. 角色**仍在运行期目录**：与历史行为一致，在 admission 边界重新解析——恢复是
    //    "新建 child"的一条路径，不能跳过用户覆盖与固定纪律的分层（纪律升级后立刻生效）；
    // 2. 角色**已被删除**（不在目录）：使用 child 创建时持久化的 persona 快照，保住人格，
    //    绝不因为角色消失而变成未知角色或通用人格；
    // 3. 两者都没有 → fail-closed（见上）。
    // 解析结果除交给宿主 composition 外同时写入内部 marker，让 agent/created 看到同一个值。
    const childPersona = resolveRecoveryPersona({
      roleKnown: roleCatalog().has(record.role),
      currentPersona: roleCatalog().has(record.role) ? resolvePersonaForAdmission(record.role) : void 0,
      recordedPersona,
    });
    if (typeof childPersona !== "string" || childPersona.length === 0) {
      throw new Error("cannot rebuild recovery child because its expert role is unavailable");
    }
    // 目标 subagent provider（票据 29）：只读原 child_models 快照（缺失字段时回落到
    // 本进程保存的恢复上下文）。原继承型 child 的 fork provider 已不可用、或父日志
    // 不再有已完成 turn 时，明确失败并提示重新派发；绝不静默改成 spawn 丢失上下文。
    // 消息以 Cannot rebuild 开头，让恢复分类器把它当作终止性错误，不无限重试。
    const persistedTarget = {
      subagentProvider: persistedChild?.subagentProvider ?? source?.subagentProvider,
      inheritContext: typeof persistedChild?.inheritContext === "boolean"
        ? persistedChild.inheritContext
        : source?.inheritContext,
    };
    let subagentTarget;
    try {
      subagentTarget = resolvePersistedSubagentTarget(record.role, parent, persistedTarget);
    } catch (error) {
      throw contextInheritanceError(
        "cannot rebuild recovery child because " + (error instanceof Error ? error.message : String(error))
          + "；请重新派发该任务",
        error?.code === CONTEXT_INHERITANCE_ERROR_CODES.EMPTY
          ? CONTEXT_INHERITANCE_ERROR_CODES.EMPTY
          : CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
      );
    }
    const request = {
      label: source.label,
      prompt: [{ type: "text", text: buildExpertTaskPrompt(record.role, promptText) }],
      parent,
      // 内部字段：只供 startExpertActivation 选择宿主 provider，调用宿主前剥离。
      subagentProvider: subagentTarget.provider,
      agentOptions: {
        provider: source.provider,
        model: source.model,
        [EFFORT_MARKER]: source.reasoningEffort,
        [ROLE_MARKER]: record.role,
        [PARENT_MARKER]: record.parentId,
        [CONTINUABLE_MARKER]: true,
        [DENY_MARKER]: recoveryDeny,
        [PERSONA_MARKER]: childPersona,
        [EXPERT_SUBAGENT_PROVIDER_MARKER]: subagentTarget.provider,
        [EXPERT_INHERIT_CONTEXT_MARKER]: subagentTarget.inheritContext,
      },
      persona: childPersona,
      toolFilter: { deny: recoveryDeny },
      maxDepth: source.maxDepth ?? 1,
    };
    // 结构化交付（票据 30）：冷恢复/重建会创建新 activation，但宿主 descriptor
    // 不保存 outputSchema，本轮无法重新声明；只保留“曾声明过”的事实并标记回退。
    if (persistedChild?.outputSchemaRequested === true && request.outputSchema === undefined) {
      request.agentOptions[OUTPUT_SCHEMA_REQUESTED_MARKER] = true;
      markStructuredRequest(request, { requested: true, notRestored: true });
    }
    const pending = { parent: record.parentAgent, parentId: record.parentId, role: record.role, record, op };
    recovery.queueRebuild(pending);
    let childId;
    let messageId;
    try {
      ({ childId, messageId } = await startExpertActivation({
        request,
        label: source.label,
        signal: op.controller?.signal,
      }));
      if (!lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
    } catch (error) {
      recovery.removeRebuild(pending);
      throw error;
    }
    recovery.removeRebuild(pending);
    // P2：agent/created 或 startContinuable resolve 都可能晚于父销毁/插件卸载。
    // 在任何 record 迁移、scope 写回、任务/activity 绑定前再次验证生命周期；
    // manager 已接受的迟到 child 保持宿主侧终态，不允许插件复活已清理状态。
    if (!recoveryRebuildCanCommit(recordsView, record, op)) {
      logger.warn(`dsh-expert-group: ignoring late recovery rebuild result for child ${oldChildId}`);
      return void 0;
    }
    if (typeof childId !== "string" || childId.length === 0 || typeof messageId !== "string" || messageId.length === 0) {
      throw new Error("replacement continuable child did not return a valid childId and messageId");
    }
    // agent/created 通常已迁移 record；若宿主事件未同步发出，返回后兜底迁移。
    // acceptance 返回的 Agent 仍是插件实际创建的对象，必须登记到 global guard 身份表。
    registerPluginExpertChildAgent(agents.get(childId));
    if (record.childId !== childId) moveRecoveryRecordToChild(record, childId);
    const scope = delegationScopeKey(record.parentId, record.role);
    const current = delegationTracker.getChild(scope);
    // cold-resume 可能从未写入 tracker scope（current === undefined）；应把成功
    // 替代 child 安装为当前 child。若并发新任务已安全改为别的 child，则保持它。
    if (shouldInstallRebuiltChild(current?.childId, oldChildId)) {
      delegationTracker.setChild(scope, { childId, routeKey: source.routeKey });
    }
    const taskKeys = [...op.taskKeys];
    delegationTracker.rebindActiveTasks({
      parentId: record.parentId,
      role: record.role,
      oldChildId,
      newChildId: childId,
      messageId,
      taskKeys,
      activityIds: op.activityIds,
    });
    for (const taskKey of taskKeys) {
      const binding = record.tasks.get(taskKey);
      if (binding !== void 0) {
        binding.childId = childId;
        binding.messageId = messageId;
        binding.pendingMessage = false;
      }
    }
    return messageId;
  }

  return { rebuildRecoveryChild };
}

/**
 * B3：自动恢复指令的实际投递（sendMessage / 重建 / 重试收口）。
 *
 * 该组只在同一 parent+role 的 delegationTracker.serialize 临界区内被调用，并等待
 * manager sendMessage 返回 accepted messageId 后才结束临界区。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 投递能力面。
 */
export function createAutoRecoveryDispatch(deps) {
  const { logger, delegation, identity, subagents, flow, rebuild } = deps;
  const { agents, isLiveRootAgent, lineage } = identity;
  const delegationTracker = delegation;
  const retryRecoveryDispatchAfterFailure = (...args) => flow.retryRecoveryDispatchAfterFailure(...args);
  const failPendingRecoveryOp = (...args) => flow.failPendingRecoveryOp(...args);
  const rebuildRecoveryChild = (...args) => rebuild.rebuildRecoveryChild(...args);

/**
   * 向既有 child 投递一条父代理消息。RC1 的公开 continuation seam 是
   * subagents.sendMessage；interrupt 只负责请求取消当前轮次，不能替代消息 admission。
   * 因此 running、idle、cold 三种状态都由 manager 统一处理 parent admission、lineage、
   * disposal 与 signal cutoff，插件不直接操作 child Agent 的内部 steer/whenIdle。
   * @param {object} options - 投递参数。
   * @param {object} options.parent - 确切的在线父代理。
   * @param {string} options.childId - 目标 child session id。
   * @param {Array} options.content - 要投递的消息内容块。
   * @param {AbortSignal} [options.signal] - 调用方取消信号。
   * @param {boolean} options.interrupt - 是否先请求中断 child 当前轮次。
   * @param {boolean} [options.queue=false] - 保留兼容输入；消息始终经公开 sendMessage admission。
   * @returns {Promise<string>} 被接受消息的 id。
   */
  async function sendMessageToExistingChild({ parent, childId, content, signal, interrupt, queue = false, rootToken }) {
     const assertLiveRoot = () => {
       if (!lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
     };
     assertLiveRoot();
    // 在任何 interrupt 或消息构造之前检查取消，避免取消后的副作用投递。
    if (signal?.aborted === true) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    const send = async () => {
      assertLiveRoot();
      const messageId = await subagents.sendMessage(parent, childId, content, { signal });
      assertLiveRoot();
      if (typeof messageId !== "string" || messageId.length === 0) throw new Error("existing child sendMessage returned an invalid messageId");
      return messageId;
    };
    if (interrupt === true) {
      // interrupt 只请求取消，不等待内部 Agent 状态；后续消息仍必须经公开
      // sendMessage，让 RC1 manager 负责 admission、lineage、cold resume 与 disposal。
      try {
        subagents.interrupt(childId, { kind: "ancestor", agent: parent });
      } catch (error) {
        // 目标已失活时允许 manager 接管；权限、排空、取消和未知错误仍原样传播。
        if (interruptFailureCanFallback(error)) return send();
        throw error;
      }
    }
    return send();
  }

/**
   * 以父代理身份发出一条自动恢复指令。该函数只由同一 parent+role 的
   * delegationTracker.serialize 临界区调用，且会等待 manager sendMessage 返回
   * accepted messageId 后才结束临界区。这样普通新任务不能在消息已接受、
   * 但旧 .then 回调尚未运行的窗口 supersede 该 op。
   */
  async function dispatchRecovery(op, record, session, reason) {
    // turn/end 后通过 queueMicrotask 延迟到这里时，记录可能已经因卸载、父销毁
    // 或 route 清理而被移除；此时不得再向 child 发送无任务归属的幽灵消息。
    if (!recoveryOpIsPending(record.pendingRecoveries, op) || recoveryOpIsAccepted(op)) return;
    const parent = record.parentAgent;
    if (!isLiveRootAgent(parent) || agents.get(record.parentId) !== parent) {
      logger.warn(`dsh-expert-group: auto-recovery skipped for child ${session.id}: parent ${record.parentId} is not live`);
      failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：父代理已不可用");
      return;
    }
    const controller = new AbortController();
    op.controller = controller;
    op.dispatching = true;
    let messageId;
    const scope = delegationScopeKey(record.parentId, record.role);
    const current = delegationTracker.getChild(scope);
    // 多 child 语义：scope.current 只是「本 scope 最近一次新建/恢复的 child」，它可能
    // 是另一个独立任务的 child。同一个 route 下另一个 child 的自动恢复**不是**route
    // 变更，必须继续向 record 自己的 child 投递恢复消息；只有 route 真的变了（或记录
    // 没有 route 信息、只能退回 child 身份比较的旧记录）才走重建。
    const routeChanged = current !== void 0
      && (record.routeKey !== void 0 ? current.routeKey !== record.routeKey : current.childId !== record.childId);
    try {
      if (shouldRebuildRecoveryChild(void 0, { routeChanged })) {
        // route 改变时不再向旧 child sendMessage，直接以保存的原 route 重建。
        messageId = await rebuildRecoveryChild(op, record, parent, reason);
      } else {
        // 此 await 必须发生在 scope 锁内：sendMessage resolve 即 manager acceptance 边界。
        messageId = await sendMessageToExistingChild({
          parent,
          childId: session.id,
          content: [{ type: "text", text: buildRecoveryMessage(reason) }],
          signal: controller.signal,
          rootToken: lineage.tokenFor(parent),
          // 自动恢复交给 manager sendMessage，统一处理 admission/lineage/disposal。
          interrupt: false,
          queue: false,
        });
      }
    } catch (error) {
      if (!recoveryOpIsPending(record.pendingRecoveries, op)) {
        op.dispatching = false;
        return;
      }
      // 容量耗尽：不重建（撞上限时重建必然再失败），也不按原样上抛原始码。
      // 这是暂态条件——等某个子代理结束后重试即可成功，因此仍走既有带预算的
      // 重试通道，只是把用户可见文案换成可读提示。
      if (isSubagentCapacityError(error)) {
        logger.warn(`dsh-expert-group: auto-recovery deferred for child ${session.id}: subagent capacity reached`);
        if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, error)) {
          failPendingRecoveryOp(op, record, reason, `自动恢复指令投递失败：${SUBAGENT_CAPACITY_MESSAGE}`);
        }
        return;
      }
      if (!routeChanged && shouldRebuildRecoveryChild(error)) {
        try {
          messageId = await rebuildRecoveryChild(op, record, parent, reason);
        } catch (rebuildError) {
          const detail = rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
          logger.warn(`dsh-expert-group: auto-recovery rebuild failed for child ${session.id}: ${detail}`);
          if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, rebuildError)) {
            failPendingRecoveryOp(op, record, reason, `自动恢复 child 重建失败：${detail}`);
          }
          return;
        }
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(`dsh-expert-group: auto-recovery sendMessage failed for child ${session.id}: ${detail}`);
        if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, error)) {
          failPendingRecoveryOp(op, record, reason, `自动恢复指令投递失败：${detail}`);
        }
        return;
      }
    }
    // 下面没有 await：在释放同 scope 锁前原子记录 acceptance 和 claimed 占位。
    if (!recoveryOpIsPending(record.pendingRecoveries, op)) {
      op.dispatching = false;
      return;
    }
    if (typeof messageId !== "string" || messageId.length === 0) {
      const invalidMessageError = new Error("manager 未返回有效 messageId");
      if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, invalidMessageError)) {
        failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：manager 未返回有效 messageId");
      }
      return;
    }
    op.accepted = true;
    op.messageId = messageId;
    op.dispatching = false;
    // P1：恢复消息成为同一活动项新的稳定终态关联。sendMessage 仍在同
    // child，rebuild 已改为替代 child；二者都通过 activityIds 精确更新。
    delegationTracker.rebindActiveTasks({
      parentId: record.parentId,
      role: record.role,
      oldChildId: record.childId,
      newChildId: record.childId,
      messageId,
      taskKeys: op.taskKeys,
      activityIds: op.activityIds,
    });
    rememberClaimedPlaceholder(record.claimed, messageId);
    evictOldestEntries(record.claimed, CLAIMED_LIMIT);
  }

  return { dispatchRecovery, sendMessageToExistingChild };
}

/**
 * B4：父 inbox feedback / session 事件桥（三个 ctx.on 的 handler）。
 *
 * 注册语句与顺序仍由组合根持有（铁律 1/2）：本组只返回 handler，不接收 ctx。
 * legacy relay 在没有 correlation id 之前一律 fail-closed（只做按 child 去重的告警）。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 事件桥能力面。
 */
export function createRecoveryEventBridge(deps) {
  const { logger, records, handoff, identity, rootWait, notifications, fanout, delegation } = deps;
  const { agents, isLiveRootAgent } = identity;
  const { notificationHost, rootGenerationRegistry } = notifications;
  const { getFanoutHost, reconcileUnbarrieredFanoutHandoffs } = fanout;
  const delegationTracker = delegation;
  const {
    getRecord,
    readChildActivation,
    bindRecoverySession,
    clearRequestRetryStateForSessionEvent,
  } = records;
  const {
    nextSessionEventReceipt,
    captureSourceLessNoticeReceipts,
    isCurrentRecoverySessionIdentity,
    isCurrentRecoveryFeedbackIdentity,
    wasGatedRecoveryFeedback,
    gateRecoverableHandoffFeedback,
    markPendingHandoffFeedback,
    settleFinishedChildTurnWaits,
    admissionForTurn,
    consumeChildTurnEnd,
    deferChildTurnEnd,
    removePendingHandoffAdmission,
    childTurnNeedsImmediateRecovery,
    releaseTerminalActivitiesBeforeHandoffFeedback,
    bindHandoffAdmissionFromClaimed,
  } = handoff;
  const {
    cancelRootTurnWaitForUserInput,
    commitRootTerminationSnapshot,
    pendingRootUserWait,
    clearRootUserWait,
    releaseDetachedActivitiesOnChildTurnEnd,
    releaseActiveExpertScope,
  } = rootWait;

/** legacy relay 诊断去重集合（B）：按 child 去重，上限防止 legacy host 刷日志。 */
  const relayFeedbackWarnings = new Set();
  const RELAY_FEEDBACK_WARN_LIMIT = 64;

  /**
   * legacy relay（`subagent-report`）fail-closed 的诊断出口（B）。
   *
   * 每个 child 只 warn 一次，并用集合上限兜底，避免 legacy host 每轮投递都刷日志。
   * 只做诊断，不参与任何 handoff 决策。
   *
   * @param {string|undefined} childId - relay 的 senderSessionId（仅用于归因）。
   */
  function warnLegacyRelayFailClosed(childId) {
    if (relayFeedbackWarnings.size >= RELAY_FEEDBACK_WARN_LIMIT) return;
    const key = typeof childId === "string" && childId.length > 0 ? childId : "<unknown-child>";
    if (relayFeedbackWarnings.has(key)) return;
    relayFeedbackWarnings.add(key);
    logger.warn("dsh-expert-group: legacy subagent-report feedback has no settlement correlation id"
      + " (child " + key + "); keeping the admission fail-closed and treating it as an ordinary message");
  }

/**
   * 处理一条父 inbox 反馈。agent/inbox/inserted 与 session/event 的
   * agent/inbox/spliced 都必须进入同一条路径，避免只覆盖测试夹具能合成的事件。
   * 文本宿主通知仅作为 child 身份线索；后续仍由当前 root、activation、turn/end
   * 和 cohort 的既有门控决定是否可以结算，绝不凭正文直接释放等待。
   */
  function handleInboxFeedback(agent, message, sourceEvent = "agent/inbox/inserted", deliveryId, receipt = void 0) {
    // inserted 是 core 唤醒 root 前的同步边界；spliced 在 session/event 中已脱离该
    // 发布栈，因此仍先做相同的 user / recovery 身份检查，再把 handoff 写入 microtask。
    // spliced 是已进入 next-step 的注入项，不是新的用户输入边界；其中即使带 user
    // source 也不能被当作 waiter 取消信号。
    if (message?.source?.kind === "user" && sourceEvent === "agent/inbox/inserted") cancelRootTurnWaitForUserInput(agent);
    if (message?.source?.kind === "subagent-report") {
      const relayChildId = message.source.senderSessionId;
      warnLegacyRelayFailClosed(typeof relayChildId === "string" ? relayChildId : void 0);
      return;
    }
    const childId = subagentFeedbackChildId(message, {
      allowSourceLess: sourceEvent === "agent/inbox/spliced" && typeof deliveryId === "string",
    });
    if (childId !== void 0) {
      const record = getRecord(childId);
      if (record?.parentAgent === agent) {
        if (isCurrentRecoveryFeedbackIdentity(agent, record, childId)) {
          if (gateRecoverableHandoffFeedback(agent, record, childId, message)) return;
          // terminal feedback 可能对应一个已完成但未绑定到 turn/messageId 的 child turn。
          // 只有没有待恢复 op 时才释放，避免把可恢复失败的 activity 提前清掉。
          const sourceLessHostNotice = sourceEvent === "agent/inbox/spliced"
            && message?.source === void 0 && typeof deliveryId === "string";
          if (!sourceLessHostNotice && record.pendingRecoveries?.size === 0
            && record.recoveryFeedbackActive !== true
            && (record.gatedRecoveryFeedbacks?.length ?? 0) === 0) {
            releaseActiveExpertScope(agent, { childId, role: record.role });
          }
        } else {
          // 当前 registry/activation 已指向 replacement 时，这是一条无法证明属于
          // 当前 generation 的旧 notice；不能进入普通 handoff release 路径。
          return;
        }
      }
    }
    queueMicrotask(() => {
      try {
        if (!isLiveRootAgent(agent)) return;
        const gatedChildId = subagentFeedbackChildId(message, {
          allowSourceLess: sourceEvent === "agent/inbox/spliced" && typeof deliveryId === "string",
        });
        if (gatedChildId === void 0 || wasGatedRecoveryFeedback(agent, gatedChildId, message?.id, message)) return;
        const childId = gatedChildId;
        const sourceLessHostNotice = sourceEvent === "agent/inbox/spliced"
          && message?.source === void 0 && typeof deliveryId === "string";
        markPendingHandoffFeedback(agent, childId, message, deliveryId, sourceLessHostNotice, receipt);
        // 命中与否都重跑精确结算；未命中时只是幂等空操作，不会结算其他 token。
        settleFinishedChildTurnWaits(agent);
      } catch (error) {
        logger.warn("dsh-expert-group: " + sourceEvent + " handoff handler failed: " + (error instanceof Error ? error.message : String(error)));
      }
    });
  }

function onInboxInserted({ agent, message }) {
    handleInboxFeedback(agent, message);
  }

function onSessionEvent(session, event) {
    // C：在**同步入口**取得本次事件的接收序号。它是插件内部唯一的到达顺序权威，
    // 后续所有 microtask 处理只能使用这个快照（见 nextSessionEventReceipt）。
    const receipt = nextSessionEventReceipt();
    // 某些宿主只发布 session/event 而不经过 inbox/inserted；在进入 microtask 前同步
    // 取消 root waiter，保证 user/message 与 ask_user_question 的 role=user 都能打断旧 turn。
    const immediateAgent = typeof session?.id === "string" ? agents.get(session.id) : void 0;
    const isUserInput = (event?.type === "user/message" && event.data?.source?.kind === "user")
      || (event?.type === "tool/result" && event.data?.message?.role === "user");
    if (isUserInput && immediateAgent?.session === session) cancelRootTurnWaitForUserInput(immediateAgent);
    // C：source-less 完成通知的同步接收边界快照（exact root/session、child activation、
    // 未消费 token 快照、接收序号）。异步消费只允许使用这个快照的交集，且必须满足
    // 「exact turn/end 接收顺序更早」——后续只能收紧，不能扩大。
    const noticeReceipts = typeof session?.id === "string"
      ? captureSourceLessNoticeReceipts(immediateAgent, session, event, receipt) : void 0;
    queueMicrotask(() => {
      try {
      if (typeof session?.id !== "string") return;
      // completion 事件先交给 fan-out；未识别的 fan-out marker 不应落入旧
      // recoveryRecords 路径，避免同一 child 被双重结算或自动续跑。
      if (getFanoutHost()?.handleSessionEvent(session, event) === true) return;
      const liveAgent = agents.get(session.id);
      const record = getRecord(session.id);
      if (record !== void 0) {
        // dispose 后 liveAgent/activation 可能已缺失，由 helper 依据 record 的 exact
        // Agent/Session 继续处理；若 replacement 仍在任一映射中则严格拒绝旧 event。
        if (!isCurrentRecoverySessionIdentity(record.parentAgent, record, session)) return;
        // 首个 exact event 建立 session 引用；之后旧 Session 事件不得接管 record。
        bindRecoverySession(record, session);
      }
      if (event?.type === "agent/inbox/spliced"
        && event.data?.target === "next-step"
        && liveAgent?.session === session
        && isLiveRootAgent(liveAgent)
        && Array.isArray(event.data?.inserted)) {
        // 真实 Host 将自动完成消息作为 root session event 发布，而不是 guaranteed 的
        // agent/inbox/inserted。只桥接 next-step 的 inserted 消息，并复用同一 exact
        // feedback 状态机；固定文本本身绝不构成释放条件。
        // seq 缺失时 source-less 通知必须 fail-closed；它不能借正文冒充 admission。
        const deliveryId = Number.isSafeInteger(event.seq)
          ? "session-event:" + session.id + ":" + String(event.seq) : void 0;
        for (let index = 0; index < event.data.inserted.length; index += 1) {
          const inserted = event.data.inserted[index];
          const message = inserted?.message !== undefined ? inserted.message : inserted;
          // receipt 与 inserted 同下标对齐：同步入口为每条 source-less 注入固化的到达快照。
          handleInboxFeedback(liveAgent, message, "agent/inbox/spliced", deliveryId, noticeReceipts?.[index]);
        }
        return;
      }
      if (event?.type === "step/start" && liveAgent?.session === session && isLiveRootAgent(liveAgent)) {
        // turn/end 之后同一 turn 又开始新 step，说明 listener 通过 steer 续接了本次运行：
        // 刚写入的终止快照并不成立，必须撤销，否则会误报"已中断/已完成"。
        // generation 显式声明后，notifications 侧会强校验代际：旧代际 root 的迟到
        // step/start 无法撤销新代际刚发布的终止快照（上游的 exact Agent/Session
        // 守卫之外的第二道防线）；generationOf 未登记时返回 undefined，保持兼容语义。
        notificationHost.revokeTermination({
          rootId: liveAgent.id,
          turn: event.data?.turn,
          generation: rootGenerationRegistry.generationOf(liveAgent.id),
        });
        return;
      }
      if (event?.type === "turn/end" && liveAgent?.session === session && isLiveRootAgent(liveAgent)) {
        commitRootTerminationSnapshot(liveAgent, session, event);
        return;
      }
      if (event?.type === "tool/result" && liveAgent?.session === session && isLiveRootAgent(liveAgent)
        && event.data?.message?.role === "user" && pendingRootUserWait(liveAgent, rootGenerationRegistry.generationOf(liveAgent.id)).length > 0) {
        // ask_user_question/exit_plan_mode 的回答落在 tool/result（role=user），不是普通 user/message。
        // 用户的这次回答同样是新的用户运行边界：释放等待并开启新的 root run。
        notificationHost.beginRootRun({
          rootId: liveAgent.id,
          generation: rootGenerationRegistry.generationOf(liveAgent.id),
        });
        clearRootUserWait(liveAgent, session);
        return;
      }
      if (event?.type === "user/message") {
        // 只把真实 user source 当作回答；插件/manager 注入的 user/message
        // 不能误释放 ask_user_question/exit_plan_mode 的等待原因。
        const sourceKind = event.data?.source?.kind;
        if (sourceKind === "user"
          && liveAgent?.session === session
          && isLiveRootAgent(liveAgent)) {
          // 延迟 microtask 中必须确认事件仍属于当前 root Session；同 id 新 root
          // 不能被旧代际 user/message 误当作本次等待的用户回答。
          clearRootUserWait(liveAgent, session);
          // 真实用户输入开启新的 root run：为「已在运行、但本进程还没有登记等待」的
          // fan-out 任务补登记。判定完全基于当前事实，重复触发是幂等的。
          reconcileUnbarrieredFanoutHandoffs();
          // 真实用户输入开启新的 root run：只有这里会重置"本 run 至多一次"的终止
          // 通知资格。subagent-settled/agent-message 等注入消息不进入该分支，
          // 因此子代理结算回唤出的续接 turn 仍然属于同一 run，不会重复提示。
          notificationHost.beginRootRun({
            rootId: liveAgent.id,
            generation: rootGenerationRegistry.generationOf(liveAgent.id),
          });
        }
        return;
      }
      if (event?.type !== "turn/end") return;
      if (record === void 0) {
        // root 销毁/代际退休后 record 已被清理，正常 turn/end 处理不再运行；但 detached
        // 活动范围仍持有保护，只能由该 child 自己的 turn/end 释放（票据 07）。
        releaseDetachedActivitiesOnChildTurnEnd(session, event);
        return;
      }
      if (getRecord(session.id) !== record
        || !isCurrentRecoverySessionIdentity(record.parentAgent, record, session)) return;
      const admission = admissionForTurn(record, session, event, receipt);
      if (admission?.failed === true) {
        // 失败 admission 只结算自己的 turn，不能被同 child 的其他 token 拦截。
        consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
        removePendingHandoffAdmission(admission);
        return;
      }
      const immediateRecovery = childTurnNeedsImmediateRecovery(record, session, event);
      if (immediateRecovery) {
        // 原始 recoverable failure 与自动恢复 turn 都必须在此处立即进入现有
        // handleChildTurnEnd，创建/完结 recovery op；只把原 admission 的 handoff
        // bookkeeping 留在 pending，不能等待 parent feedback 才推进恢复链。
        consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
        if (admission !== void 0) deferChildTurnEnd(record, session, event, admission);
        return;
      }
      if (admission !== void 0) {
        // DSH 的 report/feedback 发布仍按原顺序交给 admission bookkeeping；
        // 但成功/确定失败的 exact activity 在此窗口先释放，避免 root guard
        // 因父 inbox 尚未消费而错误拦截同范围读取。
        releaseTerminalActivitiesBeforeHandoffFeedback(record, session, event, admission);
        deferChildTurnEnd(record, session, event, admission);
        return;
      }
      consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
      } catch (error) {
        logger.warn("dsh-expert-group: turn/end recovery handler failed: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        // 成功 step/end 立即归零；请求预算耗尽则保留到 child turn/end 完成，
        // 让 handleChildTurnEnd 能抑制重复 continuation，随后由 turn/end 清除。
        clearRequestRetryStateForSessionEvent(session, event);
      }
    });
  }

function onInboxClaimed({ agent, message, turn }) {
    // claimed 可能在 Session.append 发布栈内到达；所有状态绑定延后处理。
    queueMicrotask(() => {
      try {
      if (typeof agent?.id !== "string" || typeof message?.id !== "string" || !Number.isSafeInteger(turn)) return;
      const record = getRecord(agent.id);
      const activation = readChildActivation(agent.id);
      if (record === void 0 || record.agent !== agent || activation?.agent !== agent
        || (record.session !== void 0 && agent.session !== void 0
          && !sameDurableSessionId(record.session, agent.session, agent.id))) return;
      if (agent.session !== void 0) bindRecoverySession(record, agent.session);
      record.claimed.set(message.id, turn);
      evictOldestEntries(record.claimed, CLAIMED_LIMIT);
      // S1-D：任务 binding 的 acceptance 竞态补绑——当 claimed 消息 id 在
      // record.tasks 中找不到 binding 时（正常路径的 admission 回调晚于
      // inbox 认领事件），按消息文本归一化 key 匹配 pendingMessage 且
      // messageId 尚未确定的项并回填，保证 reused 能找到原任务。
      rebindPendingTaskByClaimed(record.tasks, message);
      bindHandoffAdmissionFromClaimed(agent, message.id);
      // P1：claim 可能早于 start/steer admission Promise 返回。把已经由 binding
      // 确认的 messageId 同步写入独立 activeTasks，后续 record.tasks 的 LRU
      // 淘汰不会影响按 turn/end 清理 affectedPaths 范围登记。
      for (const [taskKey, binding] of record.tasks) {
        if (binding?.messageId !== message.id) continue;
        delegationTracker.bindActiveTasksByTaskKey({
          parentId: record.parentId,
          role: record.role,
          childId: agent.id,
          taskKey,
          messageId: message.id,
        });
      }
      } catch (error) {
        logger.warn(`dsh-expert-group: inbox/claimed recovery handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  return { onInboxInserted, onSessionEvent, onInboxClaimed, handleInboxFeedback };
}
