// ─────────────────────────────────────────────────────────────────────────────
// R1-07（模块拆分）：本文件从 fanout.js 前段外移而来，承接原始源行 334–488
// （R1-05 后为 336–490）。内容是 shard/父任务状态词表、停止证据状态与来源、
// 进程身份、快照版本与终态判定；本模块不 import 任何 fan-out 子模块。
// 为让 fanout.js 的 manager 复用词表与版本号，原本私有的常量改为导出；它们
// 不在 fanout.js 再导出，公共导出面仍是原来的 38 个名字。
// ─────────────────────────────────────────────────────────────────────────────
/** shard 的四类终态（interrupted 只由 restore 产生，见下）。 */
export const SHARD_TERMINAL_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

/**
 * 可手工重试的 shard 终态（与 retryShard 的判定同一集合）。
 *
 * 单独成表是为了让能力投影与真实写入口共用同一份词表：任何一侧新增/删减状态，
 * 另一侧都不会悄悄漂移成「界面允许但 manager 拒绝」。
 */
export const RETRYABLE_SHARD_STATUSES = new Set(["failed", "timed_out", "cancelled", "interrupted"]);

/** 父任务聚合状态。pending 表示仍有未终态 shard。 */
export const FANOUT_TASK_STATUSES = Object.freeze([
  "pending",
  "completed",
  "completed_with_errors",
  "cancelled",
]);

/** 会出现在 counts 中的全部 shard 状态。 */
export const SHARD_STATUS_KEYS = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
export const SHARD_STATUS_SET = new Set(SHARD_STATUS_KEYS);

/**
 * 停止证据（stopEvidence）的状态与来源（票据 07）。
 *
 * 状态机只有两个状态：
 * - unknown：默认。管理器知道"这个 attempt 逻辑上结束了/被要求停止了"，但**无法证明**
 *   对应的执行体（child 进程/会话轮次）真的停了；
 * - observed：收到了权威停止信号。只允许 unknown -> observed，永不可逆。
 *
 * source 的取值必须来自下面这张表。表分两层：
 * - 管理器自己可判定的（child_completion / admission_not_created / not-started）：
 *   child_completion 指该 attempt 自己绑定的 completion 回调落地（成功、失败或取消后的
 *   迟到回调都算），它证明这一轮执行已经结束；admission_not_created 指启动器抛错/reject，
 *   按既有契约等于没有创建 child；not-started 指 queued 阶段被取消、从未 admission。
 * - Host 提交的权威信号（child_turn_end / child_disposal / admission_not_created /
 *   fencing）：必须严格归属到该 attempt，由 observeStopEvidence 入口校验。
 * - process-restart：只由 restore 的 stopEvidenceBoundary="process-restart" 使用。
 *
 * 管理器自己发出的 cancel/interrupt、超时到期、close、root 结束、代次更新都**不是**
 * 停止证据，对应 attempt 的 stopEvidence 保持 unknown。
 */
export const STOP_EVIDENCE_STATE_UNKNOWN = "unknown";
export const STOP_EVIDENCE_STATE_OBSERVED = "observed";
export const STOP_EVIDENCE_SOURCES = Object.freeze([
  "child_completion",
  "admission_not_created",
  "not-started",
  "child_turn_end",
  "child_disposal",
  "fencing",
  "process-restart",
]);
/** observeStopEvidence 接受的外部来源（管理器内部来源不允许由 Host 冒充）。 */
export const HOST_STOP_EVIDENCE_SOURCES = Object.freeze([
  "child_turn_end",
  "child_disposal",
  "admission_not_created",
  "fencing",
]);
/**
 * 停止宽限期（毫秒）：从"请求停止"到"看门狗判定未确认"的默认预算。
 *
 * 它不改变任何逻辑状态，只决定何时发布一次 attempt_stop_unconfirmed 诊断。15 秒足够覆盖
 * 一次 interrupt 的进程清理，又远小于超时量级，避免诊断被无限推迟；可通过
 * createFanoutManager({ stopGraceMs }) 注入（测试用假时钟驱动同一个定时器 seam）。
 */
export const STOP_GRACE_MS = 15000;
/** restore 的停止证据边界取值。 */
export const STOP_EVIDENCE_BOUNDARIES = Object.freeze(["unknown", "process-restart"]);

/**
 * 稳定进程身份（票据 07）：pid + 进程启动时间，用于自动判定恢复边界。
 *
 * 为什么需要它：restore 的默认边界不能靠猜——同一个进程内重建 manager（例如插件重载、
 * defer 后再次 restore）时，旧 child 可能仍在写盘，此时必须保持 unknown；而新进程启动时，
 * 上一个进程的执行体确实已随进程终止，这是规格允许的 process-restart 边界。
 *
 * 缓存策略：第一次计算后写进 globalThis 的 Symbol 槽位（同一进程内所有模块实例共享，
 * Symbol.for 保证跨模块重载仍是同一个键）。因此模块被重新求值（插件热重载）时身份不变；
 * 只有真正的进程重启才会得到新值。启动时间用 Date.now()-process.uptime()*1000 反推，
 * 取整到毫秒；全局缓存避免了两次求值之间的时钟采样噪声。
 */
const PROCESS_INSTANCE_SYMBOL = Symbol.for("dsh-expert-group:process-instance");

/**
 * 解析当前进程身份（只计算一次并全局缓存）。
 *
 * @returns {string} "proc:<pid>@<startedAtMs>"；无法读取 process 时返回稳定占位值。
 */
export function resolveProcessInstance() {
  const globalObject = typeof globalThis === "object" && globalThis !== null ? globalThis : undefined;
  const cached = globalObject?.[PROCESS_INSTANCE_SYMBOL];
  if (typeof cached === "string" && cached.length > 0) return cached;
  let value;
  try {
    const startedAt = Math.round(Date.now() - process.uptime() * 1000);
    value = "proc:" + process.pid + "@" + startedAt;
  } catch {
    // 退化值也必须稳定（模块重载不能改变它），否则会把同进程误判成重启。
    value = "proc:unknown@0";
  }
  if (globalObject !== undefined) {
    try {
      Object.defineProperty(globalObject, PROCESS_INSTANCE_SYMBOL, {
        value,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    } catch {
      try { globalObject[PROCESS_INSTANCE_SYMBOL] = value; } catch { /* 只读宿主：保持局部值 */ }
    }
  }
  return value;
}

/** 当前进程身份（快照持久化与自动恢复边界的唯一来源）。 */
export const PROCESS_INSTANCE = resolveProcessInstance();

/** 快照格式版本；restore 只接受同版本快照。 */
export const SNAPSHOT_VERSION = 1;

/**
 * 超时投影版本（票据 06）：新快照会在分片上写入 shard.timeoutMs（仅显式值）。
 *
 * 为什么需要它：旧快照的 buildSnapshotPayload **从来没有**写过 shard.timeoutMs，
 * 当年的恢复靠「最新 attempt 的 timeoutMs」反推分片覆盖（旧语义下两者恒等）。
 * 新语义下 attempt.timeoutMs 可能来自父任务/角色默认值，再反推就会把默认值
 * 伪造成分片覆盖。因此用一个显式标记区分两种投影：缺标记 = 旧快照（保持
 * 反推兼容），标记匹配 = 新快照（只认 rawShard.timeoutMs）。
 * 它不改变 SNAPSHOT_VERSION：两种快照都可恢复，不能因标记存在与否而整体拒绝。
 */
export const TIMEOUT_PROJECTION_VERSION = 1;

/** 判断 shard 是否已进入终态（含恢复态 interrupted）。 */
export function isTerminalShardStatus(status) {
  return SHARD_TERMINAL_STATUSES.includes(status);
}

