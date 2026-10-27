/**
 * 会话删除作业（票据 02 · 阶段一）：把「用户点删除」变成五态结果。
 *
 * ## 作业期只做一件会立刻改变可见性的事
 * 把会话日志**原子改名**进隔离区。工作区记账、归档/置顶集合、派生缓存与 DEG 数据的清理
 * 全部推迟到下一次启动的收敛期（规格决策 13–16）——作业期碰它们只会制造「删了一半」的
 * 中间态，而单文件改名没有中间态：原始路径上的日志在或不在，就是唯一的可见性判据。
 *
 * ## 六步流水线（外加一个前置闸门，规格决策 11）
 * | 步骤 | 动作 | 失败/命中时的结果 |
 * |---|---|---|
 * | S0 | 闸门查询（隔离目录在 **或** 队列条目在） | `skipped(pending-cleanup)`，不写意图、不动文件 |
 * | S1 | 写 `intent` 条目（宿主写入口原子落盘） | `failed`，什么都没动 |
 * | S2 | 判活 | `skipped(live / live-descendant)`，删除自己刚写的条目（幂等） |
 * | S3 | 紧贴改动前再判活 | 同上 |
 * | S4 | 把日志原子改名进 `<隔离根>/<会话ID>/` | 目标已不存在 → `absent`（登记 cleanup）；改名失败 → 先移除本次 mkdir 出来的空隔离目录，**成功后才**撤销意图条目，然后 `failed`（日志原地不动、可立即重试） |
 * | S5 | 改名后判活（竞态） | 命中 → 状态改 `race` 并尝试回位；结果 `raced` |
 * | S6 | 状态推进到 `cleanup` | 状态写失败仍算 `deleted`（收敛期按「日志不存在」照样能处理） |
 *
 * ## 为什么 S2/S3 要判「后代也 live」
 * 闭包在确认时刻冻结，执行期状态会变：一个后代会话可能在用户点确认之后被重新打开。此时
 * 它的父目标已经不能删了（删了父不删子等于留下孤儿）。所以每次判活都按**冻结的后代集合**
 * 逐个检查，命中即 `live-descendant` 并指名阻塞者。
 *
 * ## 失败后队列条目的去留
 * - S2/S3 的 live 命中：**删除**条目——本次作业什么都没发生，留着只会把下一次尝试挡在闸门外；
 * - **S4 改名失败：先移除空隔离目录，成功后才删除条目**（顺序见下）——改名失败意味着什么都没
 *   变，保留条目只会让该会话在重启前一直被闸门判成 `pending-cleanup`，用户连重试都做不到；
 *   删除前必须先复原本次 `mkdir` 建出来的空隔离目录，失败路径因此是**零副作用**的；
 * - S1 之后、动文件之前的其它失败（路径解析失败等）：**保留 `intent`**——判不了路径就不能
 *   假定没有日志，留记录让收敛期按「日志是否存在」继续裁决。
 *
 * ## S4 失败分支的复原顺序（修正票据 10 的回滚顺序）
 * 固定为「**先移除空隔离目录 → 成功后再删除意图条目**」。反过来的顺序（先删条目再删目录）有
 * 两个不可接受的中间态：
 * 1. 目录移除失败：条目已经没了，而目录还在 → S0 闸门因为「隔离目录存在」永久阻塞，收敛期
 *    又只遍历队列键，永远找不到这个目录 —— 该会话在重启后也删不掉；
 * 2. 两步之间崩溃：同样留下「无条目引用的空目录」。
 *
 * 改成新顺序后，中途崩溃的两种顺序都有确定归宿（都由收敛期的 `intent + 日志存在` 分支
 * 收尾，见 host/session-delete-convergence 的 SETTLE_ONLY）：
 * - 目录已删 + 条目还在 → 收敛期按「隔离目录缺失即成功」收尾目录，然后丢弃条目；
 * - 目录还在 + 条目还在 → 收敛期先收尾目录（删掉它），再丢弃条目。
 *
 * ## 作业前的实例锁复核（修正票据 10）
 * 每次作业开始时先问实例锁「锁文件里的 token 还是你的吗」（`verifyOwnership`）。不是则视为
 * 丢失锁：本次作业 **fail-closed 拒绝**（零写入、零文件变动），并通过 `reportUnavailable`
 * 把删除能力整体置为不可用——另一个实例可能已经在删同一批日志，任何重试都只会制造第二次删除。
 *
 * ## 串行化与防重入
 * 同一时刻只跑一个作业：第二个请求立即返回 `{accepted:false, busy:true}`，**不排队**。
 * 排队会把「用户点了两次删除」变成两次真实删除，而第二次往往针对已经变化的状态；直接拒绝
 * 让调用方重新拉候选、重新确认（规格决策 20）。
 *
 * ## 执行前的二次授权（TOCTOU 收敛）
 * 授权（谁能删）与作业（实际删谁）读的是**两次不同的事实快照**：RPC 在作业之前用一份
 * 成员/清单快照判定目标归属，而作业在另一个时刻重新捕获事实并重算冻结计划。两次读取之间
 * 工作区成员关系可能变化，于是「被授权的集合」与「真正被删的集合」可能不是同一个。
 *
 * 因此 `run({authorize})` 可以带一个授权回调：作业在 **evaluateDeletePlan 之后、任何删除
 * 动作之前**调用一次 `authorize({members, roots})`——授权方拿到的是**实际计划**，可以按
 * 新鲜事实复核它，而不是复核一份已经过期的请求快照。
 *
 * 失败口径：回调抛错时整个 run **直接 reject**（不吞、不降级成某个目标的结果），本次作业
 * **零删除**；`finally` 照常清理在途状态，下一次请求可以立即重试。
 *
 * 剩余窗口（**不声称消除竞态**）：authorize 返回后，作业还要对每个目标走完 **S0 闸门查询 →
 * S1 意图条目落盘 → S2/S3 两次判活**，之后才轮到 S4 的隔离区改名。所以「检查之后世界又变」
 * 的窗口不是一个瞬间，而是**一次闸门读 + 一次队列写入 + 两次判活**的量级；并且这些步骤按目标
 * 串行重复，越靠后的目标离授权点越远（前面目标的迁移也会改变磁盘状态）。
 *
 * 这里不声称消除竞态，只做到两件事：被检查的对象就是**将要被删的对象**（实际冻结计划，而不是
 * 请求快照），且检查点位于第一处真正副作用（意图落盘与隔离改名）之前、中间不插入任何额外的
 * 判定分支。换句话说，窗口的量级是确定的（每个目标一次闸门读 + 一次写 + 两次判活），不是
 * 「检查完立刻删」那种理想化说法。
 *
 * ## 端口注入
 * 会话事实、存储、闸门、隔离区都从参数进来（见 {@link installSessionDeleteJob}）。本模块不
 * 读 `ctx`、不拼隔离区路径、不做任何真实文件系统调用——这样作业期「只改名日志、不碰共享
 * 附件」可以在结构上被保证，而不是靠自觉（票据 E3 边界）。
 *
 * @module dsh-expert-group/host/session-delete-job
 */
import { SESSION_DELETE_STATUS } from "./session-delete-contract.js";
import { INSTANCE_LOCK_RELEASE_REASONS } from "./session-delete-lock.js";
import { DELETE_GATE_REASONS } from "./session-delete-gate.js";
import { QUARANTINE_FAILURES } from "./session-delete-quarantine.js";
import { SESSION_LOG_RESOLVE_FAILURES } from "./session-delete-paths.js";
import {
  DELETE_BLOCK_REASONS,
  SESSION_DELETE_STATES,
  countNewDescendants,
  evaluateDeletePlan,
  normalizeDegChildLinks,
  normalizeSessionHeaders,
  summarizeDeleteResults,
} from "./session-delete-closure.js";

/** 作业期的稳定原因码（可展示、可断言，不含路径与堆栈）。 */
export const DELETE_JOB_REASONS = Object.freeze({
  /** 已有作业在跑：本次请求被拒绝（不排队）。 */
  JOB_IN_PROGRESS: "delete-job-in-progress",
  /** 取不到会话快照（清单/DEG 子会话读失败）：无法冻结闭包，直接拒绝。 */
  SNAPSHOT_UNAVAILABLE: "delete-session-snapshot-unavailable",
  /** 删除能力整体不可用（启动探测未过 / 队列不可读）：fail-closed，什么都没动。 */
  CAPABILITY_UNAVAILABLE: "delete-capability-unavailable",
  /** S1 写意图失败：没有任何变动。 */
  INTENT_WRITE_FAILED: "delete-intent-write-failed",
  /** 日志定位失败（locate 与编码复刻都不成立）：判不了路径就不能动文件。 */
  LOG_PATH_UNRESOLVED: "delete-log-path-unresolved",
  /** 原子改名失败（跨卷、占用、权限）：日志原地未动。 */
  LOG_RENAME_FAILED: "delete-log-rename-failed",
  /** 队列状态推进失败（保留原状态，由收敛期兜底）。 */
  STATUS_WRITE_FAILED: "delete-status-write-failed",
  /** 判活命中后删除自己刚写的条目失败（条目残留，会挡住下一次尝试）。 */
  QUEUE_ENTRY_CLEANUP_FAILED: "delete-queue-entry-cleanup-failed",
  /** 竞态回位被占用的新日志挡住：两份都保留（预期结局，不是故障）。 */
  QUARANTINE_RESTORE_BLOCKED: "delete-quarantine-restore-blocked",
  /**
   * 作业开始前复核实例锁失败（锁已被另一个实例接管）：本次 fail-closed 拒绝，零写入。
   *
   * 它与「能力不可用」是两件事：能力不可用是启动探测的结论（本次启动就没启用），锁丢失是
   * **运行期**发现的资格丧失——发现时还要把删除能力整体置为不可用（{@link reportUnavailable}）。
   */
  LOCK_LOST: "delete-instance-lock-lost",
});

/**
 * 崩溃注入钩子名（测试专用）。
 *
 * 生产装配不提供任何钩子；测试用它们把进程「按死在某一步」——抛错即等同于进程在那一刻
 * 消失，之后的断言只针对磁盘与队列表的真实状态。钩子抛出的错误**不会被吞掉**，这是刻意的：
 * 吞掉就等于让「中断」变成「优雅失败」，两者在收敛期的处理分支不同。
 */
export const DELETE_JOB_HOOKS = Object.freeze({
  /** S4 之前（写意图、两次判活都已通过）。 */
  BEFORE_RENAME: "beforeRename",
  /** S4 成功之后、S5 之前。 */
  AFTER_RENAME: "afterRename",
  /** S4 失败分支：空隔离目录移除**之前**（在此抛错 = 崩在「目录还在 + 条目还在」）。 */
  BEFORE_QUARANTINE_SWEEP: "beforeQuarantineSweep",
  /** S4 失败分支：空隔离目录已移除、意图条目尚未撤销（在此抛错 = 崩在「目录已删 + 条目还在」）。 */
  AFTER_QUARANTINE_SWEEP: "afterQuarantineSweep",
});

/** S2/S3 的判活次数（两次：分别对应「判活」与「紧贴改动前再判活」）。 */
const LIVENESS_CHECKS = 2;

/** 诊断条目的上限：作业是用户同步等待的操作，诊断只需要能解释失败，不做审计日志。 */
const MAX_DIAGNOSTICS = 64;

/**
 * 卸载期排空的最大等待（毫秒）。
 *
 * 宿主清理不能被插件无限拖住：5 秒足够覆盖「一次改名 + 一次状态写」的收尾，又不至于让热重载
 * 或退出明显卡顿。超时一律**不释放锁**（保留残锁，下次启动按「锁存在即不可用」处理并提示用户）。
 */
export const SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS = 5000;

/** 卸载期诊断的稳定原因码（只进日志与测试断言，不改变任何作业结果）。 */
export const SESSION_DELETE_UNLOAD_REASONS = Object.freeze({
  /** 在途作业未在预算内排空：**保留残锁**。 */
  DRAIN_TIMEOUT: "session-delete-drain-timeout",
  /** 排空成功但释放锁失败（权限/IO）。 */
  LOCK_RELEASE_FAILED: "session-delete-lock-release-failed",
  /** 排空成功但锁并不属于本进程（已被替换/从未持有）：不需要释放。 */
  LOCK_NOT_HELD: "session-delete-lock-not-held",
});

/**
 * 进程内已装配的作业能力面（**卸载期排空用**）。
 *
 * 为什么需要它：宿主按**逆序**清理 effect——作业 effect 先于实例锁 effect 被清理，它的清理会
 * 把 `state.sessionDeleteJob` 置空，而此刻在途的 run() 仍在跑。锁的清理必须还能找到这个作业，
 * 否则会在作业未结束时放锁（另一个实例立刻取得锁并开工 = 两个实例并发删除）。
 * 装配新作业时顺手摘掉已经空闲的旧面，避免热重载反复装配时无限增长。
 */
const installedJobFaces = new Set();

/** 结果里的会话 ID 归一（空串/非字符串一律丢弃）。 */
function readSessionId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 读时钟：只接受有限非负数，否则退回系统时间（记录时间不承担安全性）。 */
function readNow(clock) {
  try {
    const now = clock?.now?.();
    return Number.isFinite(now) && now >= 0 ? now : Date.now();
  } catch {
    return Date.now();
  }
}

/** 只取错误码：绝不把异常消息（可能带绝对路径）带进结果或诊断。 */
function readErrorCode(error) {
  return typeof error?.code === "string" && error.code.length > 0 ? error.code : "unknown-error";
}

/** 队列条目（写入边界由 store 的严格 schema 再校验一次）。 */
function queueEntryOf(status, registeredAt) {
  return { status, registeredAt, attempts: 0 };
}

/** 五态全零计数（与 summarizeDeleteResults 的键集合一致）。 */
function zeroCounts() {
  const counts = {};
  for (const state of Object.values(SESSION_DELETE_STATES)) counts[state] = 0;
  return counts;
}

/** 请求里的会话 ID 归一：去空、去重、保持顺序。 */
function normalizeRequestedIds(sessionIds) {
  const requested = [];
  const seen = new Set();
  for (const entry of sessionIds ?? []) {
    const id = readSessionId(entry);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    requested.push(id);
  }
  return requested;
}

/** 结果对象的唯一构造点：保证每个结果都带 sessionId/title/state。 */
function resultOf(target, state, extra = {}) {
  return {
    sessionId: target.sessionId,
    title: target.title,
    state,
    ...extra,
  };
}

/** skipped 结果：原因是 live / live-descendant / pending-cleanup 三者之一。 */
function skippedResult(target, reason, extra = {}) {
  return resultOf(target, SESSION_DELETE_STATES.SKIPPED, { reason, ...extra });
}

/** failed 结果：日志仍在原地，什么都没动。 */
function failedResult(target, reason, detail) {
  return resultOf(target, SESSION_DELETE_STATES.FAILED, {
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

/** 当前 live 结论：目标自己 live 优先，其次冻结后代里最近的 live 会话。 */
function readLiveState(target, deps) {
  const isLive = (sessionId) => {
    try {
      return deps.sessions.isLive(sessionId) === true;
    } catch {
      // 读不通就按 live 处理：不能证明未被占用的会话一律不删（规格决策 2）。
      return true;
    }
  };
  if (isLive(target.sessionId)) {
    return { kind: DELETE_BLOCK_REASONS.LIVE, sessionId: target.sessionId, title: target.title };
  }
  for (const sessionId of target.descendantIds ?? []) {
    if (!isLive(sessionId)) continue;
    let title;
    try {
      title = deps.titleOf?.(sessionId);
    } catch {
      title = undefined;
    }
    return { kind: DELETE_BLOCK_REASONS.LIVE_DESCENDANT, sessionId, title };
  }
  return null;
}

/** 闸门查询；抛错/形状非法都按「能力不可用」fail-closed（不动文件）。 */
async function readGate(deps, sessionId) {
  try {
    const outcome = await deps.gate.check(sessionId);
    if (outcome !== null && typeof outcome === "object") return outcome;
  } catch {
    // 落到下面的 fail-closed 返回。
  }
  return { blocked: true, blockedBy: DELETE_GATE_REASONS.DELETE_UNAVAILABLE };
}

/** 日志定位端口；抛错按「定位失败」而不是 absent（判不了路径就不能假定没有日志）。 */
async function resolveTargetLog(deps, header) {
  try {
    return await deps.sessions.resolveLog(header);
  } catch {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.LIST_FAILED };
  }
}

/** 「目录不存在 / 目录里没有日志」= 日志确实不在，走 absent；其余都是定位失败。 */
function isAbsentResolutionReason(reason) {
  return reason === SESSION_LOG_RESOLVE_FAILURES.DIRECTORY_MISSING
    || reason === SESSION_LOG_RESOLVE_FAILURES.LOG_MISSING;
}

/** 推进一步队列状态；失败只记诊断并返回 false（调用方据此决定结果的附带字段）。 */
async function advanceStatusQuietly(deps, sessionId, status, diagnostics) {
  try {
    await deps.store.writeQueueEntry(sessionId, queueEntryOf(status, readNow(deps.clock)));
    return true;
  } catch (error) {
    diagnostics.push({
      sessionId,
      code: DELETE_JOB_REASONS.STATUS_WRITE_FAILED,
      detail: readErrorCode(error),
    });
    return false;
  }
}

/** 删除自己刚写的条目（判活命中后的幂等撤销）；失败只记诊断。 */
async function dropQueueEntryQuietly(deps, sessionId, diagnostics) {
  try {
    await deps.store.deleteQueueEntry(sessionId);
  } catch (error) {
    diagnostics.push({
      sessionId,
      code: DELETE_JOB_REASONS.QUEUE_ENTRY_CLEANUP_FAILED,
      detail: readErrorCode(error),
    });
  }
}

/** 调用崩溃注入钩子；钩子抛错原样上抛（模拟进程在这一点消失）。 */
function invokeHook(deps, stage, context) {
  const hook = deps.hooks?.[stage];
  if (typeof hook !== "function") return;
  hook(context);
}

/** absent：登记 cleanup 后返回；状态写失败仍报 absent（收敛期按日志不存在处理）。 */
async function settleAbsent(deps, target, diagnostics) {
  const written = await advanceStatusQuietly(deps, target.sessionId, SESSION_DELETE_STATUS.CLEANUP, diagnostics);
  return resultOf(target, SESSION_DELETE_STATES.ABSENT, {
    queueStatus: written ? SESSION_DELETE_STATUS.CLEANUP : SESSION_DELETE_STATUS.INTENT,
  });
}

/** deleted：登记 cleanup 后返回；状态写失败仍报 deleted（条目留在 intent，收敛期可处理）。 */
async function settleDeleted(deps, target, diagnostics) {
  const written = await advanceStatusQuietly(deps, target.sessionId, SESSION_DELETE_STATUS.CLEANUP, diagnostics);
  return resultOf(target, SESSION_DELETE_STATES.DELETED, {
    queueStatus: written ? SESSION_DELETE_STATUS.CLEANUP : SESSION_DELETE_STATUS.INTENT,
  });
}

/**
 * 改名失败后的第一步复原：只删本次失败留下的**空**会话隔离目录（非空一律不动）。
 *
 * 返回值是「下一步（撤销意图条目）是否安全」：
 * - `true`：目录已删除，或本来就不存在（失败发生在 mkdir 之前）——没有留下任何需要收敛的
 *   现场，可以撤销条目，本次失败因此是零副作用的；
 * - `false`：目录还在（非空 / 删不掉 / 路径判不了）——**必须保留条目**，交给下次启动的收敛期
 *   按「intent + 日志存在」把目录与条目一起收尾。
 *
 * @returns {boolean} 是否可以继续撤销意图条目。
 */
function sweepEmptyQuarantineDirectory(deps, sessionId, diagnostics) {
  try {
    const outcome = deps.quarantine.removeEmptyDirectory(sessionId);
    if (outcome?.removed === true) return true;
    // 「目录不存在」= 本次失败没有留下空壳（某些失败发生在 mkdir 之前）：同样安全。
    if (outcome?.skipped === "missing") return true;
    diagnostics.push({ sessionId, code: DELETE_JOB_REASONS.LOG_RENAME_FAILED, detail: "quarantine-cleanup-failed" });
    return false;
  } catch {
    diagnostics.push({ sessionId, code: DELETE_JOB_REASONS.LOG_RENAME_FAILED, detail: "quarantine-cleanup-failed" });
    return false;
  }
}

/**
 * 作业前的实例锁复核（端口未注入时跳过：作业本身不承担锁的装配责任）。
 *
 * @returns {{reason: string}|undefined} 丢失锁时返回原因码，否则 undefined。
 */
function readLockLoss(deps) {
  const verify = deps.lock?.verifyOwnership;
  if (typeof verify !== "function") return undefined;
  let outcome;
  try {
    outcome = verify();
  } catch (error) {
    return { reason: readErrorCode(error) };
  }
  if (outcome?.ok === true) return undefined;
  const reason = typeof outcome?.reason === "string" && outcome.reason.length > 0
    ? outcome.reason
    : DELETE_JOB_REASONS.LOCK_LOST;
  return { reason };
}

/** 把「删除能力不可用」上报给装配段（探测快照）；上报失败绝不改变本次拒绝结论。 */
function reportUnavailable(deps, reason) {
  try {
    deps.reportUnavailable?.(reason);
  } catch {
    // 上报只是诊断：吞掉异常，拒绝结论已经确定。
  }
}

/**
 * 推进单个目标的六步流水线。
 *
 * 返回 `{result, diagnostics}`：结果是五态之一，诊断只解释失败（不含路径与堆栈）。钩子抛出的
 * 错误会直接上抛——那是「进程中断」，不是一次作业结果。
 *
 * @param {object} target - 冻结计划里的一个目标（含 `descendantIds`）。
 * @param {object} context - `{deps, headerOf}`。
 * @returns {Promise<{result: object, diagnostics: object[]}>} 单目标结果。
 */
async function runDeleteTarget(target, context) {
  const { deps, headerOf } = context;
  const sessionId = target.sessionId;
  const diagnostics = [];

  // ── S0 闸门：上一次删除的收尾没做完就不接新作业 ────────────────────────────
  const gate = await readGate(deps, sessionId);
  if (gate.blocked === true) {
    if (gate.blockedBy === DELETE_GATE_REASONS.PENDING_CLEANUP) {
      return {
        result: skippedResult(target, DELETE_BLOCK_REASONS.PENDING_CLEANUP, {
          detail: Array.isArray(gate.reasons) ? gate.reasons : undefined,
        }),
        diagnostics,
      };
    }
    return {
      result: failedResult(target, DELETE_JOB_REASONS.CAPABILITY_UNAVAILABLE, String(gate.blockedBy ?? "unknown")),
      diagnostics,
    };
  }

  // ── S1 写意图（原子落盘；失败 = 什么都没动）────────────────────────────────
  try {
    await deps.store.writeQueueEntry(sessionId, queueEntryOf(SESSION_DELETE_STATUS.INTENT, readNow(deps.clock)));
  } catch (error) {
    return { result: failedResult(target, DELETE_JOB_REASONS.INTENT_WRITE_FAILED, readErrorCode(error)), diagnostics };
  }

  // ── S2 / S3 两次判活 ──────────────────────────────────────────────────────
  for (let attempt = 0; attempt < LIVENESS_CHECKS; attempt += 1) {
    const live = readLiveState(target, deps);
    if (live === null) continue;
    await dropQueueEntryQuietly(deps, sessionId, diagnostics);
    return { result: skippedResult(target, live.kind, { blockedBy: live }), diagnostics };
  }

  // ── S4 原子改名进隔离区 ───────────────────────────────────────────────────
  const header = headerOf.get(sessionId);
  // 清单里没有这个会话 = 它没有可改名的日志：清单本身就是「有日志」的权威读面。
  if (header === undefined) {
    return { result: await settleAbsent(deps, target, diagnostics), diagnostics };
  }
  const resolution = await resolveTargetLog(deps, header);
  if (resolution?.ok !== true) {
    if (isAbsentResolutionReason(resolution?.reason)) {
      return { result: await settleAbsent(deps, target, diagnostics), diagnostics };
    }
    return {
      result: failedResult(target, DELETE_JOB_REASONS.LOG_PATH_UNRESOLVED, String(resolution?.reason ?? "unknown")),
      diagnostics,
    };
  }
  // 多份日志（历史代次）时只搬**当前代次**（版本最高、由定位器排在第一位）。
  const sourcePath = Array.isArray(resolution.files) ? resolution.files[0] : undefined;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return {
      result: failedResult(target, DELETE_JOB_REASONS.LOG_PATH_UNRESOLVED, SESSION_LOG_RESOLVE_FAILURES.LOG_MISSING),
      diagnostics,
    };
  }

  invokeHook(deps, DELETE_JOB_HOOKS.BEFORE_RENAME, { sessionId, sourcePath });
  let quarantineOutcome;
  try {
    quarantineOutcome = deps.quarantine.renameIntoQuarantine({
      sessionDirectory: deps.quarantine.directoryOf(sessionId),
      sourcePath,
      timestamp: readNow(deps.clock),
    });
  } catch (error) {
    quarantineOutcome = { ok: false, reason: readErrorCode(error) };
  }
  if (quarantineOutcome?.ok !== true) {
    if (quarantineOutcome?.reason === QUARANTINE_FAILURES.SOURCE_MISSING) {
      return { result: await settleAbsent(deps, target, diagnostics), diagnostics };
    }
    // 改名失败必须真的「没有任何可见变动」。复原顺序**固定**为：
    //   1. 先移除本次 mkdir 刚建出来的空隔离目录；
    //   2. 成功（或目录本来就不存在）之后，才撤销本次刚写的意图条目。
    // 反过来的顺序会在「目录删不掉 / 两步之间崩溃」时留下**无条目引用的空目录**：S0 闸门会
    // 因为它永久阻塞，而收敛期只遍历队列键，永远看不到这个目录（该会话再也删不掉）。
    // 保留条目时，收敛期按「intent + 日志存在」把目录与条目一起收尾（SETTLE_ONLY）。
    invokeHook(deps, DELETE_JOB_HOOKS.BEFORE_QUARANTINE_SWEEP, { sessionId });
    const swept = sweepEmptyQuarantineDirectory(deps, sessionId, diagnostics);
    // 这个钩子刻意排在「撤销条目」之前：它模拟的正是「目录已删、条目还没删」这个崩溃窗口。
    invokeHook(deps, DELETE_JOB_HOOKS.AFTER_QUARANTINE_SWEEP, { sessionId, swept });
    if (swept === true) await dropQueueEntryQuietly(deps, sessionId, diagnostics);
    return {
      result: failedResult(target, DELETE_JOB_REASONS.LOG_RENAME_FAILED, String(quarantineOutcome?.reason ?? "unknown")),
      diagnostics,
    };
  }
  invokeHook(deps, DELETE_JOB_HOOKS.AFTER_RENAME, {
    sessionId,
    sourcePath,
    targetPath: quarantineOutcome.targetPath,
  });

  // ── S5 改名后判活（竞态）──────────────────────────────────────────────────
  const contested = readLiveState(target, deps);
  if (contested === null) {
    return { result: await settleDeleted(deps, target, diagnostics), diagnostics };
  }
  // 竞态：先把状态推进到 race（失败则保留 intent，收敛期按「日志是否存在」兜底）。
  const statusWritten = await advanceStatusQuietly(deps, sessionId, SESSION_DELETE_STATUS.RACE, diagnostics);
  let restore;
  try {
    restore = deps.quarantine.restore({ targetPath: quarantineOutcome.targetPath, sourcePath });
  } catch (error) {
    restore = { ok: false, reason: readErrorCode(error) };
  }
  if (restore?.ok !== true) {
    diagnostics.push({
      sessionId,
      code: DELETE_JOB_REASONS.QUARANTINE_RESTORE_BLOCKED,
      detail: String(restore?.reason ?? "unknown"),
    });
  }
  return {
    result: resultOf(target, SESSION_DELETE_STATES.RACED, {
      blockedBy: contested,
      queueStatus: statusWritten ? SESSION_DELETE_STATUS.RACE : SESSION_DELETE_STATUS.INTENT,
      restored: restore?.ok === true,
    }),
    diagnostics,
  };
}

/**
 * 冻结闭包所需的两份会话快照。
 *
 * `readLiveSessionIds` 只用于**确认时刻**的冻结判定；执行期的判活一律走 `isLive`，这样
 * 「确认之后会话被重新打开」这个窗口才是可观测、可测试的（规格决策 6 / 测试 D5）。
 */
async function captureSessionFacts(deps) {
  const headers = normalizeSessionHeaders(await deps.sessions.readHeaders());
  const degChildren = normalizeDegChildLinks(await deps.sessions.readDegChildren());
  const liveEntries = await deps.sessions.readLiveSessionIds();
  const liveSessionIds = [];
  for (const entry of liveEntries ?? []) {
    const id = readSessionId(typeof entry === "string" ? entry : entry?.id);
    if (id !== undefined) liveSessionIds.push(id);
  }
  const headerOf = new Map();
  for (const header of headers) headerOf.set(header.id, header);
  return { headers, degChildren, liveSessionIds, headerOf };
}

/** 结算备注里的「期间新增 N 个下游会话」（只计数，绝不生成 skipped）。 */
async function readNewDescendantNote(deps, plan) {
  if (plan.roots.length === 0) return { newDescendants: 0 };
  try {
    const fresh = await captureSessionFacts(deps);
    const newDescendants = countNewDescendants({
      rootSessionIds: plan.roots,
      headers: fresh.headers,
      degChildren: fresh.degChildren,
      frozenMembers: plan.members,
    });
    return { newDescendants };
  } catch {
    return { newDescendants: 0, degraded: true };
  }
}

/** 请求被拒（并发 / 快照不可用）时的统一回执：零计数且没有目标。 */
function rejectedSummary(requestedSessionIds, reason, extra = {}) {
  return {
    accepted: false,
    busy: false,
    reason,
    requestedSessionIds,
    targetCount: 0,
    counts: zeroCounts(),
    total: 0,
    conserved: true,
    results: [],
    blocked: [],
    collateral: [],
    note: { newDescendants: 0 },
    diagnostics: [],
    ...extra,
  };
}

/** 空请求（没有选中任何会话）：合法空作业。 */
function emptySummary() {
  return { ...rejectedSummary([], undefined), accepted: true, reason: undefined };
}

/**
 * 执行一次已冻结的作业。
 *
 * @param {object} deps - 见 {@link installSessionDeleteJob}。
 * @param {string[]} requestedSessionIds - 归一后的会话 ID。
 * @param {(plan: {members: string[], roots: string[]}) => Promise<void>|void} [authorize] -
 *   **执行前二次授权**：拿到刚冻结的实际计划（成员 + 所选根），在**任何删除动作之前**按新鲜
 *   事实复核。抛错 = 整个作业 reject、零删除（见模块头「执行前的二次授权」）。
 * @returns {Promise<object>} 五态聚合 + 守恒结论。
 */
async function executeDeleteJob(deps, requestedSessionIds, authorize) {
  let captured;
  try {
    captured = await captureSessionFacts(deps);
  } catch (error) {
    return rejectedSummary(requestedSessionIds, DELETE_JOB_REASONS.SNAPSHOT_UNAVAILABLE, {
      diagnostics: [{ code: DELETE_JOB_REASONS.SNAPSHOT_UNAVAILABLE, detail: readErrorCode(error) }],
    });
  }
  const plan = evaluateDeletePlan({
    rootSessionIds: requestedSessionIds,
    headers: captured.headers,
    degChildren: captured.degChildren,
    liveSessionIds: captured.liveSessionIds,
    titleOf: deps.titleOf,
  });
  // ── 执行前二次授权（位于第一处真正副作用之前；其后仍有闸门读、意图写与两次判活）──────
  // 授权方校验的是**这份实际计划**，不是作业之前的那份请求快照。这里刻意不 try/catch：
  // 授权失败必须在删除任何目标之前终止整个作业（异常原样上抛，由 run 的 finally 收尾）。
  // 复制数组是边界防护：授权方拿到的是快照，改它不会影响本次执行。
  if (typeof authorize === "function") {
    await authorize({ members: [...plan.members], roots: [...plan.roots] });
  }
  const results = [];
  const diagnostics = [];
  for (const target of plan.targets) {
    const outcome = await runDeleteTarget(target, { deps, headerOf: captured.headerOf });
    results.push(outcome.result);
    for (const entry of outcome.diagnostics) {
      if (diagnostics.length >= MAX_DIAGNOSTICS) break;
      diagnostics.push(entry);
    }
  }
  const note = await readNewDescendantNote(deps, plan);
  const summary = summarizeDeleteResults(results, plan.targetCount);
  return {
    accepted: true,
    busy: false,
    requestedSessionIds,
    ...summary,
    results,
    blocked: plan.blocked,
    collateral: plan.collateral,
    note,
    diagnostics,
  };
}

/**
 * 创建删除作业能力面。
 *
 * @param {object} deps - 窄能力面（本模块不读 ctx、不读全局状态）。作业的 `run(request)` 也可以
 *   带 `request.titleOf` 覆盖标题解析（候选查询注入展示名），带 `request.authorize` 启用
 *   **执行前二次授权**（见模块头「执行前的二次授权」；不传则行为不变）。
 * @param {object} deps.store - 票据 01 的收敛日志读写原语（单条读/写/删）。
 * @param {{check: (sessionId: string) => Promise<object>}} deps.gate - 票据 01 的闸门查询。
 * @param {object} deps.sessions - 会话事实端口：
 *   `{readHeaders, readDegChildren, readLiveSessionIds, isLive, resolveLog}`。
 * @param {(sessionId: string) => (string|undefined)} [deps.titleOf] - 标题解析（候选查询注入）。
 * @param {object} deps.quarantine - 票据 01 的隔离区适配器：
 *   `{directoryOf, renameIntoQuarantine, restore, removeEmptyDirectory}`。
 * @param {{now: Function}} [deps.clock] - 只读时钟（记录 registeredAt）。
 * @param {object} [deps.hooks] - 崩溃注入钩子（生产装配不提供）。
 * @param {{verifyOwnership: Function}} [deps.lock] - 实例锁能力面：每次作业开始前复核锁归属
 *   （未注入时跳过这一层复核——作业不负责装配锁）。
 * @param {(reason: string) => void} [deps.reportUnavailable] - 锁丢失时把删除能力置为不可用的
 *   上报口（装配段接到启动探测的 `markUnavailable`）。
 * @returns {{run: Function, snapshot: Function}} 作业能力面。
 */
export function installSessionDeleteJob({
  store,
  gate,
  sessions,
  titleOf,
  quarantine,
  clock,
  hooks,
  lock,
  reportUnavailable: report,
}) {
  const deps = {
    store,
    gate,
    sessions,
    titleOf,
    quarantine,
    clock,
    hooks,
    lock,
    reportUnavailable: report,
  };
  /** 当前在途作业（同一时刻最多一个）。 */
  let active = null;
  /** 当前在途 run() 的 promise（卸载期排空要等它）。 */
  let inFlight = null;

  async function run(request) {
    const requestedSessionIds = normalizeRequestedIds(request?.sessionIds);
    if (requestedSessionIds.length === 0) return emptySummary();
    // 每次作业开始前复核实例锁：锁被另一个实例接管 → 本次 fail-closed 拒绝（零写入、零变动），
    // 并把删除能力整体置为不可用（不再重试）。复核必须先于忙碌判定：资格丧失优先于重试语义。
    const lockLoss = readLockLoss(deps);
    if (lockLoss !== undefined) {
      reportUnavailable(deps, lockLoss.reason);
      return rejectedSummary(requestedSessionIds, DELETE_JOB_REASONS.LOCK_LOST, {
        diagnostics: [{ code: DELETE_JOB_REASONS.LOCK_LOST, detail: lockLoss.reason }],
      });
    }
    if (active !== null) {
      // 串行化 + 同会话防重入：不排队第二次（排队会把一次确认变成两次真实删除）。
      return rejectedSummary(requestedSessionIds, DELETE_JOB_REASONS.JOB_IN_PROGRESS, {
        busy: true,
        inFlightSessionIds: [...active.sessionIds],
      });
    }
    const token = { sessionIds: new Set(requestedSessionIds), startedAt: readNow(clock) };
    active = token;
    // 标题解析可以按请求覆盖：候选查询（票据 04）才知道每个会话的展示名，而作业只需要
    // 「被阻塞时指名是谁」。不传就沿用装配段给的默认解析器（可能是空的）。
    const runDeps = typeof request?.titleOf === "function" ? { ...deps, titleOf: request.titleOf } : deps;
    // 执行前二次授权只在实际调用方提供时启用：不提供 = 行为与引入该参数之前逐字节一致
    // （旧调用方与既有回归用例不受影响）。
    const authorize = typeof request?.authorize === "function" ? request.authorize : undefined;
    const task = executeDeleteJob(runDeps, requestedSessionIds, authorize);
    inFlight = task;
    try {
      return await task;
    } finally {
      if (active === token) active = null;
      if (inFlight === task) inFlight = null;
    }
  }

  function snapshot() {
    if (active === null) return { running: false };
    return { running: true, sessionIds: [...active.sessionIds], startedAt: active.startedAt };
  }

  /** 只读：是否有作业正在执行（不改变任何状态）。 */
  function isBusy() {
    return active !== null || inFlight !== null;
  }

  /**
   * 有界排空：等待当前在途 run() 结束（**不改动作业语义**，只是让卸载能等到它）。
   *
   * 三种结局：没有在途作业 → true；在途作业在预算内结束（成功或抛错都算结束）→ true；
   * 超时或预算非法 → false。调用方**只能在 true 时**认为「可以安全放锁」。
   *
   * @param {number} [timeoutMs] - 有界等待（毫秒）。0 或非法值 = 不等待（有在途作业即 false）。
   * @returns {Promise<boolean>} 是否已排空。
   */
  function drain(timeoutMs = SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS) {
    const pending = inFlight;
    if (pending === null) return Promise.resolve(true);
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    if (budget === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(false), budget);
      // 作业抛错也算「已结束」：这里等的是「不再有新副作用」，不是「成功」。
      Promise.resolve(pending).then(() => finish(true), () => finish(true));
    });
  }

  const face = Object.freeze({ run, snapshot, drain, isBusy });
  // 登记给卸载期排空用；顺手摘掉上一次装配遗留的空闲面（热重载不会让登记表无限增长）。
  for (const other of installedJobFaces) {
    if (other === face) continue;
    if (other.isBusy() !== true) installedJobFaces.delete(other);
  }
  installedJobFaces.add(face);
  return face;
}

/** 排空单个作业面（内部用；任何异常都折算成「没排空」）。 */
async function drainJobFace(face, timeoutMs) {
  try {
    return (await face.drain(timeoutMs)) === true;
  } catch {
    return false;
  }
}

/**
 * 排空进程内所有仍登记的作业面（卸载期兜底：当前作业面已被宿主清掉时使用）。
 *
 * @param {number} [timeoutMs] - 有界等待（毫秒）。
 * @returns {Promise<boolean>} 全部排空返回 true；任一超时/抛错返回 false。
 */
export async function drainInstalledJobs(timeoutMs = SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS) {
  const faces = [...installedJobFaces];
  if (faces.length === 0) return true;
  const outcomes = await Promise.all(faces.map((face) => drainJobFace(face, timeoutMs)));
  return outcomes.every((value) => value === true);
}

/** 诊断上报（只记原因码；上报本身失败绝不影响清理结论）。 */
function reportUnloadDiagnostic(report, reason) {
  try {
    report?.(reason);
  } catch {
    // 诊断失败不影响卸载。
  }
}

/** 排空当前作业面；作业面已不可见（宿主逆序清理）时退回模块级登记表。 */
async function drainForUnload(job, timeoutMs) {
  if (job !== null && typeof job === "object" && typeof job.drain === "function") {
    return (await job.drain(timeoutMs)) === true;
  }
  return await drainInstalledJobs(timeoutMs);
}

/**
 * 卸载期：**先排空在途删除作业，排空成功才释放实例锁**。
 *
 * 顺序是安全要求而不是风格：作业还在跑就 release 锁，另一个实例会立刻取得锁并开始删同一批
 * 日志——两个实例并发删除。因此超时/无法判定时**保留残锁**（下次启动按「锁存在即不可用」
 * 处理，并把锁文件路径提示给用户）。
 *
 * 本函数永不抛错：宿主卸载不能被插件拖死，任何异常都折算成「不释放 / 已记诊断」。
 *
 * @param {object} deps
 * @param {{drain?: Function}} [deps.job] - 当前作业能力面（可能已被宿主清空）。
 * @param {{release?: Function}} [deps.lock] - 实例锁能力面。
 * @param {(reason: string) => void} [deps.report] - 诊断出口（稳定原因码）。
 * @param {number} [deps.timeoutMs] - 有界等待（默认 {@link SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS}）。
 * @returns {Promise<boolean>} 是否真的释放了锁。
 */
export async function releaseLockAfterDrain({
  job,
  lock,
  report,
  timeoutMs = SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS,
} = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? timeoutMs
    : SESSION_DELETE_JOB_DRAIN_TIMEOUT_MS;
  let drained;
  try {
    drained = await drainForUnload(job, budget);
  } catch {
    drained = false;
  }
  if (drained !== true) {
    reportUnloadDiagnostic(report, SESSION_DELETE_UNLOAD_REASONS.DRAIN_TIMEOUT);
    return false;
  }
  try {
    if (lock === null || typeof lock !== "object" || typeof lock.release !== "function") {
      reportUnloadDiagnostic(report, SESSION_DELETE_UNLOAD_REASONS.LOCK_NOT_HELD);
      return false;
    }
    const outcome = lock.release();
    if (outcome?.released === true) return true;
    // 只把「本来就没持有」记成 not-held；其余（release-failed / 未知返回值）一律按「真的没删掉」
    // 上报——宁可让运维多看一眼磁盘/权限，也不要把故障藏进 not-held。
    reportUnloadDiagnostic(
      report,
      outcome?.reason === INSTANCE_LOCK_RELEASE_REASONS.NOT_HELD
        ? SESSION_DELETE_UNLOAD_REASONS.LOCK_NOT_HELD
        : SESSION_DELETE_UNLOAD_REASONS.LOCK_RELEASE_FAILED,
    );
    return false;
  } catch {
    reportUnloadDiagnostic(report, SESSION_DELETE_UNLOAD_REASONS.LOCK_RELEASE_FAILED);
    return false;
  }
}
