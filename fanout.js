// ─────────────────────────────────────────────────────────────────────────────
// R3 票据 14（模块拆分）：fan-out 兼容门面。
//
// 本文件在 R3-14 之后**没有任何实现体**：只有注释与 `export ... from` 再导出。
// 这样它会命中依赖图门禁的「兼容门面」机械豁免（C4 不再把 38 个导出名算作超限），
// 同时保持 38 个公共导出名逐项不变（index.js / host/settings-schema.js / 测试都只认这些名字）。
//
// 实现已按状态所有权拆分到 fanout/ 目录：
//   contracts.js / errors.js / validation.js  契约常量与纯函数（R1-06 拆出）
//   store.js        任务表与派生索引（容器不出模块）
//   limits.js       role/provider/默认并发与超时解析
//   events.js       事件总线（序号 / 历史记账 / 订阅者）
//   snapshot.js     快照序列化（内容与体积同源）
//   persistence.js  落盘批合并与落盘诊断
//   state.js        生命周期闸门 owner + 三个原子能力
//   reclaim.js      显式回收屏障 owner（prepare / commit / abort）
//   restore.js      恢复计划组装 + 原子提交
//   scheduler.js    派发、drain、预约、attempt 生命周期与限流诊断
//   task-commands.js 任务命令与结算/聚合
//   public-api.js   manager 装配、close 与诊断投影（对外门面）
//
// 依赖无环：store -> events -> limits -> snapshot -> persistence -> state -> scheduler -> commands。
// ─────────────────────────────────────────────────────────────────────────────

export {
  DEFAULT_CONCURRENCY_LIMIT,
  MIN_CONCURRENCY_LIMIT,
  MAX_CONCURRENCY_LIMIT,
  MIN_PROVIDER_LIMIT,
  MAX_PROVIDER_LIMIT,
  THROTTLE_ETA_MIN_SAMPLES,
  THROTTLE_STATS_LIMIT,
  RECLAIM_IN_PROGRESS_CODE,
  TASK_RECLAIMED_CODE,
  PROVIDER_ROUTE_CHANGED,
  MAX_RECLAIM_BATCH,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TIMEOUT_STEP_MS,
  validateTimeoutMs,
  normalizeTimeoutMs,
  MAX_SHARD_NAME_BYTES,
} from "./fanout/contracts.js";

export {
  SHARD_TERMINAL_STATUSES,
  FANOUT_TASK_STATUSES,
  STOP_EVIDENCE_STATE_UNKNOWN,
  STOP_EVIDENCE_STATE_OBSERVED,
  STOP_EVIDENCE_SOURCES,
  HOST_STOP_EVIDENCE_SOURCES,
  STOP_GRACE_MS,
  STOP_EVIDENCE_BOUNDARIES,
  resolveProcessInstance,
  PROCESS_INSTANCE,
  isTerminalShardStatus,
} from "./fanout/errors.js";

export {
  deriveAttemptId,
  isStopObserved,
  FanoutValidationError,
  validateConcurrencyLimit,
  validateProviderLimit,
  normalizeProviderLimits,
  normalizeRoleLimits,
  createWriteRoleConflictChecker,
  validateSubmitInput,
} from "./fanout/validation.js";

export { createFanoutManager } from "./fanout/public-api.js";
