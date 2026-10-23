/**
 * fan-out 持久化合并与落盘诊断（R3-14：从组合根 fanout.js 的 "persistence" 工厂整段迁出）。
 *
 * ## 职责与状态所有权（C5）
 * 独占落盘批记账（persistenceBatchDepth/Dirty/Flushing）、落盘序号与最近一次落盘结果。
 * 快照内容由注入的 serialize 能力提供（本工厂不持有任务/事件容器）。
 *
 * ## 迁移说明（R3-14）
 * 只做代码搬迁：函数体与返回面逐行不变，仅补充 import 与 export。
 *
 * @module dsh-expert-group/fanout/persistence
 */
import {
  FANOUT_BUDGET,
  checkBudget,
  describeBudgetViolation,
  measureJsonBytes,
} from "../resource-budget.js";
import { cloneJson } from "./validation.js";

export function createFanoutPersistence({ clock, budget, serialize, save, events }) {
  const { now } = clock;
  const budgetPolicy = budget;
  const persistence = save === undefined || save === null ? undefined : save;
  let lastPersistResult = null;
  let persistSequence = 0;
  let lastPersistResultTicket = 0;
  let persistenceBatchDepth = 0;
  let persistenceDirty = false;
  let persistenceFlushing = false;

  /**
   * 快照体积闸门（接受**已测量**的字节数）。
   *
   * 判定规则与 resource-budget.checkSnapshotBudget 完全一致：上限取
   * budgetPolicy.maxSnapshotBytes（非法时回退 FANOUT_BUDGET.maxSnapshotBytes）、
   * recoverable=false、提示文案同源；区别只是这里复用序列化时量出的字节数。
   *
   * 之所以不能直接调用 checkSnapshotBudget：它内部会再 measureJsonBytes 一次，
   * 即为了体积判定对同一份快照做第二次全量 stringify（审核确认的热点之一）。
   * 上限数值仍然只有 resource-budget.js 一处来源，本函数不新增任何预算常量，
   * 也不改变判定口径（receivedBytes === limit 仍视为合规）。
   */
  function snapshotSizeVerdict(bytes) {
    return checkBudget({
      resource: "snapshot",
      limit: Number.isSafeInteger(budgetPolicy.maxSnapshotBytes) && budgetPolicy.maxSnapshotBytes > 0
        ? budgetPolicy.maxSnapshotBytes
        : FANOUT_BUDGET.maxSnapshotBytes,
      receivedBytes: bytes,
      recoverable: false,
      hint: "快照过大时先让未终态 work 收敛，或清理已结算的历史任务",
    });
  }

  /**
   * 落盘一份快照并返回结构化结果。
   *
   * 落盘闸门（按顺序判定，任何一条不通过都不调用 persistence.save）：
   * 1. degraded 快照：序列化因不可 JSON 序列化而退化出的空 tasks 快照，
   *    绝不能拿去覆盖已有的完整 durable 快照——否则就是用"丢失全部任务"冒充成功落盘；
   * 2. 不可测量快照（JSON.stringify 抛错）：同样拒绝；
   * 3. 字节预算超限：拒绝并记录违规；
   * 4. 没有 persistence：返回 no_persistence。
   *
   * 所有拒绝路径只更新内存健康状态并返回 {saved:false, reason, ...}，绝不抛异常、
   * 绝不改动内存状态机，因此 notifyPersistence 不会被降级路径变成持久化反馈循环。
   *
   * 每次调用都会把结果写入 lastPersistResult（只读诊断）：
   * - saved：bytes 为实测快照字节；
   * - skipped：reason ∈ {degraded_snapshot, unmeasurable_snapshot, oversize_snapshot,
   *   no_persistence}；
   * - failed：save 抛错或异步落盘明确失败，category 取错误自带类别（缺失为 unknown，
   *   Host persistence-health 才是分类权威）。
   *
   * @param {object} [snapshot] - 待落盘快照；缺省时序列化当前状态。
   * @returns {{saved:boolean, bytes:number|null, reason?:string, category?:string, violation?:object}}
   */
  function persistSnapshot(snapshot) {
    return persistSnapshotInternal(snapshot, ++persistSequence);
  }

  /**
   * 记录最近一次持久化结果（只读诊断）。
   *
   * status 三态固定为 saved / skipped / failed：skipped 必须带原因（degraded_snapshot /
   * unmeasurable_snapshot / oversize_snapshot / no_persistence），failed 只来自 save 抛错
   * 或异步落盘明确失败。ticket 单调：异步 save 的迟到回调不得覆盖更晚一次 persist 的结果。
   * 分类的权威仍是 Host 的 persistence-health；这里只在错误自带 category 时透传。
   */
  function recordPersistResult(result, ticket) {
    if (ticket < lastPersistResultTicket) return result;
    lastPersistResultTicket = ticket;
    lastPersistResult = Object.freeze({
      status: result.saved === true ? "saved" : (result.reason === "save_failed" ? "failed" : "skipped"),
      saved: result.saved === true,
      reason: typeof result.reason === "string" ? result.reason : null,
      category: typeof result.category === "string" ? result.category : null,
      bytes: Number.isSafeInteger(result.bytes) ? result.bytes : null,
      at: now(),
    });
    return result;
  }

  /** 从同步/异步落盘错误里提取稳定分类；缺失记 unknown（Host health 仍是分类权威）。 */
  function persistenceCategoryOf(value) {
    const category = value?.category;
    return typeof category === "string" && category.length > 0 ? category : "unknown";
  }

  function persistSnapshotInternal(snapshot, ticket) {
    // 两条路径的差别只在"内容与体积怎么来"：
    // - 内部路径（缺省）：serializeSnapshotEnvelope 只做一次 stringify，payload 与 bytes
    //   同源，闸门不再为测量重复序列化；
    // - 显式 payload 路径（调用方传入快照对象）：对象必须原样交给 persistence.save
    //   （调用方可能持有引用并期望写入的就是它），因此体积仍用 measureJsonBytes 测量。
    //   这条路径不在状态变化热路径上（热路径见 notifyPersistence 的批合并），保持原语义。
    const envelope = snapshot === undefined ? serialize() : null;
    const payload = envelope === null ? snapshot : envelope.payload;
    const measured = envelope === null ? measureJsonBytes(payload) : envelope.bytes;
    // 1. 降级快照：degraded 标记由序列化路径在不可序列化时写入。
    if (payload !== null && typeof payload === "object" && payload.degraded === true) {
      const violation = payload.violation ?? describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "persist",
        hint: "快照不完整（degraded），拒绝落盘以避免覆盖已有的完整快照",
      });
      events.noteBudgetViolation(violation, "persist");
      return recordPersistResult({ saved: false, bytes: null, reason: "degraded_snapshot", violation }, ticket);
    }
    // 2. 不可测量：明确拒绝，不把"未知体积"当合法。
    if (measured === null) {
      const violation = describeBudgetViolation({
        resource: "snapshot",
        limit: budgetPolicy.maxSnapshotBytes,
        receivedBytes: null,
        measured: false,
        recoverable: false,
        subject: "persist",
        hint: "快照不可 JSON 序列化，拒绝落盘",
      });
      events.noteBudgetViolation(violation, "persist");
      return recordPersistResult({ saved: false, bytes: null, reason: "unmeasurable_snapshot", violation }, ticket);
    }
    // 3. 字节预算（复用上面已量出的字节数，不再重新序列化）。
    const verdict = snapshotSizeVerdict(measured);
    if (!verdict.ok) {
      events.noteBudgetViolation(verdict.violation, "snapshot");
      // 旧实现漏掉 reason：超限跳过与其它 skipped 无法区分；这里补齐稳定原因码。
      return recordPersistResult({
        saved: false,
        bytes: verdict.violation.receivedBytes,
        reason: "oversize_snapshot",
        violation: verdict.violation,
      }, ticket);
    }
    // 4. 没有持久化目标。
    if (persistence === undefined || persistence === null) {
      return recordPersistResult({ saved: false, bytes: measured, reason: "no_persistence" }, ticket);
    }
    try {
      const pending = persistence.save(payload);
      if (pending !== null && typeof pending === "object" && typeof pending.then === "function") {
        /**
         * 异步落盘：同步返回时只能确认"已提交"，真实结果以回调为准。
         *
         * - 失败不能变成未处理 rejection（旧实现 result.catch(() => {}) 把事实吞掉）；
         * - 迟到结果不得覆盖更晚一次 persist 的结果（ticket 单调）；
         * - 分类优先取错误自带的 category，Host 的 persistence-health 记录仍是权威。
         */
        pending.then(
          (value) => {
            if (value === false || (value !== null && typeof value === "object" && value.ok === false)) {
              recordPersistResult({
                saved: false,
                bytes: measured,
                reason: "save_failed",
                category: persistenceCategoryOf(value?.ok === false ? value.error : value),
              }, ticket);
            }
          },
          (error) => {
            recordPersistResult({
              saved: false,
              bytes: measured,
              reason: "save_failed",
              category: persistenceCategoryOf(error),
            }, ticket);
          },
        );
      } else if (pending !== null && typeof pending === "object" && typeof pending.catch === "function") {
        // 兼容只有 catch 的 thenable（历史注入 seam 形态）：至少不能留下未处理 rejection。
        pending.catch((error) => {
          recordPersistResult({
            saved: false,
            bytes: measured,
            reason: "save_failed",
            category: persistenceCategoryOf(error),
          }, ticket);
        });
      }
      return recordPersistResult({ saved: true, bytes: measured }, ticket);
    } catch (error) {
      // 持久化是旁路：落盘失败不改变内存状态机，由 Host 自行告警。
      // save 失败不是"预算拒绝"（可能只是 IO 错误），因此不伪造 BUDGET_EXCEEDED 事件；
      // 它通过 lastPersistResult + Host persistence-health 进入诊断。
      return recordPersistResult({
        saved: false,
        bytes: measured,
        reason: "save_failed",
        category: persistenceCategoryOf(error),
        error,
      }, ticket);
    }
  }

  /** 落盘"合并后"的当前状态；没有待落盘变化时是 no-op。 */
  function flushPersistence() {
    if (!persistenceDirty || persistenceFlushing) return;
    persistenceFlushing = true;
    try {
      // while 而非 if：落盘回调可能同步重入（例如 save 里再 submit/close），
      // 重入只会重新置脏，由同一轮 flush 收敛。
      while (persistenceDirty) {
        persistenceDirty = false;
        // 消费并保存落盘结果：persistSnapshot 内部把 saved/skipped(reason)/failed(category)
        // 写入 lastPersistResult（旧实现直接丢弃返回值，跳过/失败因此完全不可见）。
        persistSnapshot();
      }
    } finally {
      persistenceFlushing = false;
    }
  }

  /**
   * 把一段同步状态变化过程包成一个持久化批。
   *
   * 嵌套调用共享最外层批（例如订阅者在 running 事件里重入 close/submit），因此不会在
   * 中间态产生额外写；work 抛错时同样在 finally 落盘，避免已发生的状态变化被吞掉。
   */
  function withPersistenceBatch(work) {
    persistenceBatchDepth += 1;
    try {
      return work();
    } finally {
      persistenceBatchDepth -= 1;
      if (persistenceBatchDepth === 0) flushPersistence();
    }
  }

  /** 每次状态变化后落盘一份深拷贝快照；持久化失败不能中断调度。 */
  function notifyPersistence() {
    if (persistence === undefined || persistence === null) return;
    persistenceDirty = true;
    // 批内合并，由批结束时统一落盘；批外（防御性路径）立即落盘，保持旧行为。
    if (persistenceBatchDepth > 0) return;
    flushPersistence();
  }

  /** 最近一次落盘结果只读投影（失败分类权威仍在 Host persistence-health）。 */
  function lastResult() { return lastPersistResult === null ? null : cloneJson(lastPersistResult); }

  return Object.freeze({
    snapshotSizeVerdict,
    persistSnapshot,
    recordPersistResult,
    persistenceCategoryOf,
    flushPersistence,
    withPersistenceBatch,
    notifyPersistence,
    lastResult,
  });
}
