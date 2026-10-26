/**
 * root admission 的显式 epoch 与批次收口判定（R4；从 host/index-recovery.js 拆出）。
 *
 * role tool 只登记并返回 token；finalize 以「当前 root 的开放批次 + epoch」定位整批并
 * 收口。pending-close 期间新接受的 admission 同步进入等待集，收口结论的 acceptedCount
 * 因此取收口时刻的完整集合。
 *
 * 无状态工厂：批次表由本模块独占（WeakMap），对外只暴露命令与只读查询。
 *
 * @module dsh-expert-group/host/index-admission-batches
 */
import { isSubagentCapacityError } from "../shared/capacity-errors.js";
import { createAdmissionBatchCoordinator } from "../shared/delegation-cohort.js";
import { CONTEXT_INHERITANCE_ERROR_CODES, MODEL_CANDIDATES_EXHAUSTED } from "../shared/model-route.js";
import { OUTPUT_SCHEMA_ERROR_CODES } from "../shared/structured.js";

/**
 * R4：root admission 的显式 epoch 与批次收口判定。
 *
 * role tool 只登记并返回 token；finalize 以「当前 root 的开放批次 + epoch」
 * 定位整批并收口。pending-close 期间新接受的 admission 同步进入等待集，
 * 收口结论的 acceptedCount 因此取收口时刻的完整集合。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} admission 批次能力面。
 */
export function installAdmissionBatches(deps) {
  const { finalize } = deps;
  const { notePendingCloseAdmission } = finalize;

  /**
   * root admission 的显式 epoch。role tool 只负责登记并返回 token；finalize 以
   * 「当前 root 的开放批次 + admissionEpoch」定位整批并收口后关闭当前 epoch，后续
   * admission 会创建新 epoch，不会把迟到调用或下一轮调用并入已经收口的批次。
   */
  const rootAdmissionBatches = new WeakMap();
  let rootAdmissionEpoch = 0;
  function createRootAdmissionBatch() {
    return {
      epoch: ++rootAdmissionEpoch,
      coordinator: createAdmissionBatchCoordinator(),
      entries: new Map(),
      sequence: 0,
      /**
       * 在途 ticket 计数：begin 时 +1、settle 时 -1。
       *
       * 只用于判定「本批是否已经只剩被丢弃的 ticket」（见 discardRootAdmission），
       * 让「只发生过拒绝」的空批次可以被安全撤下；不参与 finalize 的凭据校验，
       * 也不改变任何已公开的回执语义。
       */
      pendingTickets: 0,
      closed: false,
      finalizing: false,
      /**
       * 两阶段收口的 pending-close 登记（见 finalizeRootAdmissionBatch）。
       *
       * finalize 在登记完成后把本批次标为 pending-close：工具立即返回 waiting，等待
       * 职责移交给 root turn 的 `agent/turn-stopping` serial 边界。这里保存的是
       * **exact admission 对象**（而不是 token 或 id），因为等待账本的记录会在一次静止
       * 收口后被销毁，后续 turn 只能靠这份精确凭据重新登记尚未结算的 work；用 id/token
       * 猜身份会重新登记一个永远不会结算的键。
       *
       * `admissions` 是**批次级**闩锁的一部分，而不是冻结的快照：批次在收口前始终开放，
       * pending-close 期间新接受的 admission 会在接受时刻被追加进来（并同步登记进等待
       * 账本），因此「重新等待」与「收口结论的 acceptedCount」看到的都是该批次收口
       * 时刻的完整 accepted 集。
       */
      pendingClose: void 0,
      /** steer 不可用的告警只记一次（不影响批次状态）。 */
      steerUnavailableLogged: false,
    };
  }
  function beginRootAdmission(parent) {
    if (parent === null || (typeof parent !== "object" && typeof parent !== "function")) return void 0;
    let batch = rootAdmissionBatches.get(parent);
    if (batch === void 0 || batch.closed === true) {
      batch = createRootAdmissionBatch();
      rootAdmissionBatches.set(parent, batch);
    }
    const ticket = batch.coordinator.begin();
    batch.pendingTickets += 1;
    const token = batch.epoch + ":" + (++batch.sequence);
    const entry = { token, epoch: batch.epoch, settled: false, outcome: void 0, discarded: false, ticket };
    batch.entries.set(token, entry);
    return {
      ...ticket,
      token,
      epoch: batch.epoch,
      entry,
      // outcome 记录点需要 exact root 才能把「pending-close 期间新接受的 work」写进
      // 同一批次的等待集（见 recordRootAdmissionOutcome / notePendingCloseAdmission）。
      parent,
      settle() {
        const settled = ticket.settle();
        if (settled) {
          entry.settled = true;
          batch.pendingTickets -= 1;
        }
        return settled;
      },
      whenReady: () => ticket.whenReady(),
    };
  }
  function recordRootAdmissionOutcome(admission, outcome) {
    if (admission?.entry === void 0) return;
    admission.entry.outcome = outcome;
    admission.entry.settled = true;
    // pending-close 批次仍开放时，新接受的 exact work 必须在**接受时刻**就进入
    // pending-close 的 work 集与等待账本（见 notePendingCloseAdmission）：否则批次级
    // 闩锁与「该批次的 exact 工作集」会脱节，收口等待可能少等这一项、结论里的
    // acceptedCount 也会停在旧值。判定与 finalize 的 acceptedEntries 完全一致：
    // reused / continueParentTurn 不产生未结算工作。
    if (outcome?.kind === "continuable" && outcome.reused !== true && outcome.continueParentTurn !== true
      && outcome.handoffAdmission !== void 0) {
      notePendingCloseAdmission(admission.parent, outcome.handoffAdmission);
    }
  }
  /**
   * 丢弃一个**已经 beginRootAdmission**、但最终没有向调用方交出任何 admission 结论的 ticket。
   *
   * 只用于「格式合法但目标未知/越权」的拒绝路径（childId 的 CHILD_NOT_FOUND）：这次调用
   * 没有派发、没有投递、没有 interrupt，也没有产生任何 handoff，因此：
   * 1. 记录 rejected outcome 并 settle 协调器，让本批在途计数归位，批次不会停在
   *    admission-outcome-pending（否则 finalize 永远收不了口）；
   * 2. 把 entry 标记为 discarded —— 收口集合由服务端枚举，只能包含**模型真正收到凭据**
   *    的 admission；把模型永远拿不到的 ticket 留在有效集合里，会让 expected 与
   *    tokenDiagnostics 虚高，也会让批次停在 admission-outcome-pending（这正是
   *    「毒化 root batch」）；
   * 3. 若本批已无在途 ticket、且全部 entry 都是 discarded，就把整批从 map 撤下：之后
   *    「本 turn 没有真实 admission」的 finalize(epoch 0，且不传 token) 仍然回到既有的
   *    no-admission 幂等语义，而不是被一个空批次挡成 admission-epoch-mismatch。
   *
   * 撤批是精确的：只在本批仍是该 root 的当前批次、未 closed、未进入 pending-close/
   * finalizing、且没有任何在途 ticket 时执行，绝不撤掉后续真实 admission 所属的批次。
   */
  function discardRootAdmission(admission, outcome) {
    if (admission?.entry === void 0) return;
    admission.entry.outcome = outcome;
    admission.entry.discarded = true;
    admission.settle();
    admission.entry.settled = true;
    const batch = rootAdmissionBatches.get(admission.parent);
    if (batch === void 0 || batch.closed === true || batch.pendingClose !== void 0 || batch.finalizing === true) return;
    if (batch.pendingTickets !== 0) return;
    for (const entry of batch.entries.values()) {
      if (entry.discarded !== true) return;
    }
    if (rootAdmissionBatches.get(admission.parent) === batch) rootAdmissionBatches.delete(admission.parent);
  }
  function roleAdmissionFailure(phase, error) {
    const message = error instanceof Error ? error.message : String(error);
    // 上下文继承（票据 29）：显式失败必须保留稳定 code，供主代理区分“宿主没有继承
    // provider”“父会话还没有已完成 turn”与普通 admission 失败；绝不归成泛化错误。
    if (error?.code === CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE
      || error?.code === CONTEXT_INHERITANCE_ERROR_CODES.EMPTY) {
      return { reason: "context", code: error.code, message };
    }
    // 结构化声明（票据 30）：非法/超限/不支持都必须保留稳定 code，
    // 不能归成泛化的 ADMISSION_FAILED；schema 原文不在 message 里。
    if (error?.code === OUTPUT_SCHEMA_ERROR_CODES.INVALID
      || error?.code === OUTPUT_SCHEMA_ERROR_CODES.TOO_LARGE
      || error?.code === OUTPUT_SCHEMA_ERROR_CODES.UNSUPPORTED) {
      return { reason: "schema", code: error.code, message };
    }
    if (phase === "provider") return { reason: "provider", code: "PROVIDER_UNAVAILABLE", message };
    if (phase === "selection") {
      // 候选耗尽保留稳定 code，便于主代理区分“没有可用候选”与普通输入错误。
      return {
        reason: "selection",
        code: error?.code === MODEL_CANDIDATES_EXHAUSTED ? MODEL_CANDIDATES_EXHAUSTED : "MODEL_SELECTION_INVALID",
        message,
      };
    }
    // 容量耗尽：结构化 code 优先于文案启发式（它已由 DEG 翻译成可读提示，不再匹配
    // steer/messageId 等英文关键词），归入可重试的 steer 失败并保留可读文案。
    if (isSubagentCapacityError(error)) {
      return { reason: "capacity", code: "SUBAGENT_CAPACITY_REACHED", message };
    }
    if (/startContinuable|child admission returned an invalid childId/i.test(message)) {
      return { reason: "start", code: "START_FAILED", message };
    }
    if (/steer|followup|messageId/i.test(message)) return { reason: "steer", code: "STEER_FAILED", message };
    return { reason: "admission", code: "ADMISSION_FAILED", message };
  }

  return {
    beginRootAdmission,
    recordRootAdmissionOutcome,
    discardRootAdmission,
    roleAdmissionFailure,
    getAdmissionBatch: (parent) => rootAdmissionBatches.get(parent),
  };
}
