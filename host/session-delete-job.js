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
 * | S0 | 闸门查询（隔离目录在 **或** 队列条目/批量意图在，**且**原始路径上的日志已不存在）；**整批一次读队列** | `skipped(pending-cleanup)`，不写意图、不动文件 |
 * | S1 | 写**一条批量写前意图**（覆盖本次全部目标，宿主写入口原子落盘、在任何改名之前） | `failed(STATUS_WRITE_FAILED)`，全部目标都不动文件 |
 * | S2 | 判活 | `skipped(live / live-descendant)`，不写任何条目（批量意图由 S6 收尾） |
 * | S3 | 紧贴改动前再判活 | 同上 |
 * | S4 | 把日志原子改名进 `<隔离根>/<会话ID>/` | 目标已不存在 → `absent`（不写条目）；改名失败 → 先移除本次 mkdir 出来的空隔离目录，删不掉时补一条单会话 `intent`，然后 `failed`（日志原地不动、可立即重试） |
 * | S5 | 改名后判活（竞态） | 命中 → 写单会话 `race` 条目并尝试回位；结果 `raced` |
 * | S6 | 批量意图收尾：没有留下待完整清理的成员才丢弃它 | 丢弃失败只记诊断并保留记录（下次启动照常展开，幂等） |
 *
 * ## 批量写前意图（2026-10-30 真机性能故障修正）
 * 真机上一次删除 160 多个会话要 2~3 分钟。客户端只发 1 次 RPC（批上限 200），所以不是网络
 * 问题：作业期为**每个目标**各写两条记录（S1 的 `intent` 与 S6 的 `cleanup`）。而 storage-json
 * 的 `single` 布局里一次 `table.put` = 整份聚合文档序列化 + 临时文件 + fsync + rename（含全部
 * 9 张表），于是 160 个目标 = 320 次整份文档落盘。
 *
 * 关键事实是：收敛的分支判定**只依赖「原始路径上的日志是否存在」**（见 `decideConvergenceBranch`），
 * 因此成功目标不需要各自持久化状态——只要有一条覆盖它们的**写前意图**，崩溃后就能按日志
 * 存在性逐会话收敛：日志不在 → 完整清理，日志还在 → 仅收尾隔离目录。于是把「每目标两条」
 * 压成「每次作业一条批量意图记录」（键由 `makeBatchQueueKey` 生成，成员写进 `sessions`）。
 *
 * 批量意图的**去留**（S6）严格按「是否还有待办」决定：只要本次有 `deleted` / `absent` 的目标，
 * 它们的 DEG 数据、记账、集合与派生缓存**尚未清理**——完整清理只在收敛期发生，而收敛只遍历
 * 队列键。此时丢弃批量意图等于把这些数据永久泄漏（孤儿清扫只删隔离目录里的文件）。因此批量
 * 意图会留到下次启动，由收敛展开并逐条完整清理后再删除。反过来，整批都是 `skipped` / `failed`
 * 时日志仍在原地，收敛对它们只会走「仅收尾隔离目录」（无事可做），保留记录反而会让闸门留下
 * 误导性的 pending 残留，所以 S6 直接丢弃它。
 *
 * 异常目标仍写**单会话**条目（数量与目标数无关，只在少数现场发生）：
 * - `race`（改名后判活命中）：状态必须推进到 `race` 才能区分「保留会话」与「清理数据」；
 * - 改名失败但空隔离目录删不掉：留下了一个必须由收敛期收尾的目录（B4b 语义）；
 * - 路径判不了 / race 状态没写成：判不了就不能假定日志已不在，留条目让收敛期继续裁决。
 *
 * ## S0 的残留判据为什么还要看「日志是否存在」（2026-10-30 真机故障修正）
 * 闸门的旧语义是「只要有残留就阻塞」，而收敛的几条失败分支（日志状态判不了、隔离目录删除
 * 失败、残渣/条目删除失败）会永久保留条目，旧版本也没有枚举隔离根的入口——于是「日志仍在
 * 原路径、会话仍能打开」的会话被永久判成 pending-cleanup，用户没有重试入口。
 *
 * 因此这里补一次日志存在性判定：闸门报 pending-cleanup 时，**日志仍存在**就照常作业
 * （隔离区里只是旧代际副本，S1 的批量意图会覆盖它、S4 会重新搬一次当前代次，收敛期收尾旧目录）；
 * 日志不存在或判不了时维持 skipped(pending-cleanup)，仍旧不写意图、不动文件。
 *
 * 作业期**不**顺手 settle 旧隔离目录：那是下次启动收敛期的职责，在作业里多做一步只会引入
 * 新的失败面（目录删不掉时该报 failed 还是 deleted 没有安全答案）。
 *
 * ## 为什么 S2/S3 要判「后代也 live」
 * 闭包在确认时刻冻结，执行期状态会变：一个后代会话可能在用户点确认之后被重新打开。此时
 * 它的父目标已经不能删了（删了父不删子等于留下孤儿）。所以每次判活都按**冻结的后代集合**
 * 逐个检查，命中即 `live-descendant` 并指名阻塞者。
 *
 * ## 失败后队列条目的去留（批量意图时代）
 * 成功目标不再写任何单会话条目：批量意图就是它们的写前意图，收敛期按「日志不存在」做完整
 * 清理。因此单会话条目的出现一律意味着**有异常待收尾**（数量与目标数无关）：
 * - S2/S3 的 live 命中：**不写任何条目**——本次作业什么都没发生；若整批都是 skipped / failed，
 *   S6 会把批量意图一起丢弃，闸门因此不会留下误导性的 pending 残留；
 * - S4 改名失败且空隔离目录已移除：**零副作用**，同样不写条目；
 * - S4 改名失败但目录删不掉：补一条单会话 `intent`——那个空目录必须由收敛期收尾；
 * - S1 之后、动文件之前的其它失败（路径解析失败等）：补一条单会话 `intent`——判不了路径就
 *   不能假定没有日志，留记录让收敛期按「日志是否存在」继续裁决；
 * - race 状态写失败：补一条单会话 `intent`（收敛期按 intent + 日志存在收尾隔离区）。
 *
 * ## S4 失败分支的复原顺序（修正票据 10 的回滚顺序）
 * 固定为「**先移除空隔离目录 → 成功后才决定条目的去留**」。反过来的顺序（先动条目再删目录）
 * 有两个不可接受的中间态：
 * 1. 目录移除失败：条目已经没了，而目录还在 → S0 闸门因为「隔离目录存在」永久阻塞，收敛期
 *    又只遍历队列键与批量意图，永远找不到这个目录 —— 该会话在重启后也删不掉；
 * 2. 两步之间崩溃：同样留下「无条目引用的空目录」。
 *
 * 改成新顺序后，中途崩溃的两种顺序都有确定归宿（都由收敛期的 `intent + 日志存在` 分支
 * 收尾，见 host/session-delete-convergence 的 SETTLE_ONLY）：
 * - 目录已删 + 没有条目 → 收敛无事可做（本来就是零副作用）；
 * - 目录还在 + 单会话 `intent` 条目 → 收敛期先收尾目录（删掉它），再丢弃条目。
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
 * 剩余窗口（**不声称消除竞态**）：authorize 返回后，作业还要 **一次批量闸门读 → 一次批量
 * 意图落盘 → 每目标两次判活**，之后才轮到 S4 的隔离区改名。所以「检查之后世界又变」的窗口
 * 不是一个瞬间，而是「一次闸门读 + 一次队列写入 + 两次判活」的量级；步骤按目标串行重复，
 * 越靠后的目标离授权点越远（前面目标的迁移也会改变磁盘状态）。
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
import { SESSION_DELETE_STATUS, makeBatchQueueKey } from "./session-delete-contract.js";
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
  /** 日志定位失败（locate 与编码复刻都不成立）：判不了路径就不能动文件。 */
  LOG_PATH_UNRESOLVED: "delete-log-path-unresolved",
  /** 原子改名失败（跨卷、占用、权限）：日志原地未动。 */
  LOG_RENAME_FAILED: "delete-log-rename-failed",
  /**
   * 队列写入失败：批量写前意图（S1）、race 状态推进、批量意图收尾或异常条目落盘都算。
   *
   * 批量化后不再区分「写意图」与「写状态」：调用方只需要知道「队列写入失败、文件未动」。
   * S1 失败时**全部目标**都按本原因码 failed，且零文件变动（与逐目标时代的语义一致）。
   */
  STATUS_WRITE_FAILED: "delete-status-write-failed",
  /** 竞态回位被占用的新日志挡住：两份都保留（预期结局，不是故障）。 */
  QUARANTINE_RESTORE_BLOCKED: "delete-quarantine-restore-blocked",
  /**
   * S0 发现残留但日志仍在：旧残留被忽略，本次照常作业。
   *
   * 它只是诊断（说明收敛留下了旧代际目录/条目），不改变任何结果；真正的清理由收敛期负责。
   */
  STALE_RESIDUE_IGNORED: "delete-stale-residue-ignored",
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

/** 单会话队列条目（写入边界由 store 的严格 schema 再校验一次）。 */
function queueEntryOf(status, registeredAt) {
  return { status, registeredAt, attempts: 0 };
}

/**
 * 批量写前意图条目的唯一构造点。
 *
 * 状态恒为 `intent`（「这些会话即将 / 已经进入删除」），attempts 恒为 0：批量记录从不被
 * 推进状态，收敛期对它只做两件事——按成员展开、全部成功就丢弃。
 *
 * @param {number} registeredAt - 本次作业的登记时间（只用于诊断）。
 * @param {string[]} sessionIds - 目标会话 ID（调用方已去重，上限 200）。
 * @returns {object} 可交给 store.writeQueueEntry 的记录。
 */
function batchIntentEntryOf(registeredAt, sessionIds) {
  return {
    status: SESSION_DELETE_STATUS.INTENT,
    registeredAt,
    attempts: 0,
    sessions: [...sessionIds],
  };
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

/** 闸门单条查询；抛错/形状非法都按「能力不可用」fail-closed（不动文件）。 */
async function readGate(deps, sessionId, options) {
  try {
    const outcome = await deps.gate.check(sessionId, options);
    if (outcome !== null && typeof outcome === "object") return outcome;
  } catch {
    // 落到下面的 fail-closed 返回。
  }
  return { blocked: true, blockedBy: DELETE_GATE_REASONS.DELETE_UNAVAILABLE };
}

/**
 * S0 的批量闸门查询：**一次**读整份收敛队列文档，再逐目标取结论。
 *
 * 为什么必须批量：`gate.check` 每次都调 `store.readQueueEntry`，而后者每次都重新枚举整份
 * 聚合文档。160 个目标逐条读 = 160 次整份文档读取；这与真机故障里的写放大是同一类问题。
 * 批量入口的判定函数与单条读完全相同（见 host/session-delete-gate），因此结论不会分叉。
 *
 * 失败一律 fail-closed：整个批量查询抛错、返回形状非法、或某个目标没有结论，都按「删除能力
 * 不可用」处理——绝不能把「拿不到结论」当成「可以删」。只有 `check` 没有 `checkMany` 的
 * 闸门替身（旧装配/测试替身）才退回逐条查询。
 *
 * @param {object} deps - 作业依赖（只用到 `gate`）。
 * @param {string[]} sessionIds - 目标会话 ID（保持计划顺序）。
 * @param {{logExistsOf?: Function}} options - 日志存在性判据（只对本来会 pending 的会话询问）。
 * @returns {Promise<Map<string, object>>} 会话 ID → 闸门结论。
 */
async function readGateVerdicts(deps, sessionIds, options) {
  const checkMany = deps.gate?.checkMany;
  if (typeof checkMany !== "function") {
    const verdicts = new Map();
    for (const sessionId of sessionIds) verdicts.set(sessionId, await readGate(deps, sessionId, options));
    return verdicts;
  }
  let outcome;
  try {
    outcome = await checkMany.call(deps.gate, sessionIds, options);
  } catch {
    outcome = undefined;
  }
  const queried = outcome?.verdicts;
  const verdicts = queried instanceof Map ? queried : new Map();
  for (const sessionId of sessionIds) {
    const verdict = verdicts.get(sessionId);
    if (verdict !== null && typeof verdict === "object") continue;
    verdicts.set(sessionId, { blocked: true, blockedBy: DELETE_GATE_REASONS.DELETE_UNAVAILABLE });
  }
  return verdicts;
}

/**
 * 把闸门结论折成「放行 / skipped / failed」三选一（纯函数，S0 的唯一判定点）。
 *
 * - `blocked:false` → 放行（`result` 缺省）；
 * - `pending-cleanup` → 日志仍在时忽略旧残留并记 `delete-stale-residue-ignored`，否则 skipped；
 * - 其它（能力不可用 / 队列不可读）→ failed，且**不写意图、不动文件**。
 *
 * 「日志仍在」这个事实由闸门在批量查询里算好（`staleResidueIgnored`），因为那里才有该会话的
 * 本轮清单快照与日志定位能力；作业不再为每个目标重复定位一次。
 *
 * @param {object} target - 冻结计划里的目标。
 * @param {object} verdict - 闸门结论（形状见 evaluateDeletionGate）。
 * @returns {{result?: object, diagnostics: object[]}} 结论（`result` 缺省 = 继续作业）。
 */
function decideGateOutcome(target, verdict) {
  const diagnostics = [];
  // 判据以「有没有残留」为第一顺位（与闸门自身的 blockedBy 口径一致：有残留时它永远报
  // pending-cleanup，除非残留已被日志存在性忽略）。这样「残留 + 删除能力不可用」仍然落在
  // pending-cleanup 分支（判不了就不动文件），而不是被折成能力不可用的 failed——两者对用户
  // 是不同的建议动作，语义不能因为批量化而漂移。
  const residue = verdict?.quarantinePresent === true || verdict?.queuePending === true;
  if (verdict?.blocked !== true) {
    // 没有阻塞、但残留确实被日志存在性忽略：仍然要留下可诊断的记录（证明收敛留下了旧代际
    // 副本，用户重启后可以据此判断「为什么隔离区里有东西」）。
    if (residue === true && verdict.staleResidueIgnored === true) {
      diagnostics.push({
        sessionId: target.sessionId,
        code: DELETE_JOB_REASONS.STALE_RESIDUE_IGNORED,
        ...residueDetailOf(verdict),
      });
    }
    return { diagnostics };
  }
  if (residue === true) {
    // 只有「纯粹是残留」时才允许按日志存在性放行：能力不可用 / 队列不可读仍然 fail-closed。
    if (verdict.staleResidueIgnored !== true || hasFatalGateReason(verdict) === true) {
      return {
        result: skippedResult(target, DELETE_BLOCK_REASONS.PENDING_CLEANUP, {
          detail: Array.isArray(verdict.reasons) ? verdict.reasons : undefined,
        }),
        diagnostics,
      };
    }
    diagnostics.push({
      sessionId: target.sessionId,
      code: DELETE_JOB_REASONS.STALE_RESIDUE_IGNORED,
      ...residueDetailOf(verdict),
    });
    return { diagnostics };
  }
  return {
    result: failedResult(target, DELETE_JOB_REASONS.CAPABILITY_UNAVAILABLE, String(verdict.blockedBy ?? "unknown")),
    diagnostics,
  };
}

/**
 * 旧残留的诊断细节：报告「哪一类残留被忽略」。
 *
 * 判定层刻意不把「被忽略的残留」塞进 `reasons`（那是阻塞原因列表），所以这里用原始事实
 * （`quarantinePresent` / `queuePending`）重建同一份可读证据。
 */
function residueDetailOf(verdict) {
  const codes = [];
  if (verdict?.quarantinePresent === true) codes.push(DELETE_GATE_REASONS.QUARANTINE_PRESENT);
  if (verdict?.queuePending === true) codes.push(DELETE_GATE_REASONS.QUEUE_PENDING);
  return codes.length === 0 ? {} : { detail: codes.join(",") };
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

/**
 * 闸门结论里是否还有**残留以外**的致命原因（能力不可用 / 队列不可读）。
 *
 * `blockedBy` 只报一个原因码，且残留优先：当残留与「能力不可用」同时成立时它仍是
 * `pending-cleanup`。作业在「日志存在 → 忽略残留」时**不能**顺带绕过 fail-closed 规则，
 * 所以这里把残留原因剔除后重新检查一遍。
 *
 * @param {object} gate - 闸门结论。
 * @returns {boolean} true 表示必须维持 fail-closed。
 */
function hasFatalGateReason(gate) {
  if (!Array.isArray(gate?.reasons)) return true;
  return gate.reasons.some((reason) => reason !== DELETE_GATE_REASONS.QUARANTINE_PRESENT
    && reason !== DELETE_GATE_REASONS.QUEUE_PENDING);
}

/**
 * 判「原始路径上的日志是否存在」（S0 闸门的残留判据，故障 1 修正）。
 *
 * 复用作业已有的定位能力（{@link resolveTargetLog} → 宿主 locate / 编码复刻），三级口径与
 * S4 的 absent 判定同一套事实：
 * 1. 清单里没有这个 header → 没有日志（宿主只能从清单加载会话）；
 * 2. 定位成功 → 有日志；
 * 3. 目录不存在 / 目录里没有日志 → 没有日志；其余定位失败（权限/IO/归属校验失败）→ **判不了**
 *    （返回 undefined），调用方按旧的阻塞语义处理，绝不放行。
 *
 * 代价说明：这会比原来多一次定位（S4 还会再定位一次）。刻意不做缓存：两次定位之间世界可能
 * 变化，缓存只会让 S4 拿到过期路径；而每次定位都是一次目录枚举，代价可控。
 *
 * @param {object} deps - 作业依赖。
 * @param {object|undefined} header - 该会话的 header（来自本轮的清单快照）。
 * @returns {Promise<boolean|undefined>} true / false / 判不了（undefined）。
 */
async function readLogExistenceOf(deps, header) {
  if (header === undefined) return false;
  const resolution = await resolveTargetLog(deps, header);
  if (resolution?.ok === true) return true;
  if (isAbsentResolutionReason(resolution?.reason)) return false;
  return undefined;
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

/**
 * 为单个会话补一条 `intent` 条目（**异常路径专用**，成功目标一律不写）。
 *
 * 三类现场需要它，共同点是「批量意图救不了」：
 * 1. 改名失败但空隔离目录删不掉——目录必须由收敛期收尾，而批量意图会在收尾时被丢弃；
 * 2. 路径判不了——不能假定日志已不在原路径，留条目让收敛期按日志存在性继续裁决；
 * 3. race 状态没写成——至少留一条 intent，收敛期按「intent + 日志存在」收尾隔离区。
 *
 * 写入失败只记诊断：收敛期仍会按批量意图的成员做「仅收尾」，不至于留下无引用的隔离文件。
 */
async function retainIntentQuietly(deps, sessionId, diagnostics) {
  try {
    await deps.store.writeQueueEntry(sessionId, queueEntryOf(SESSION_DELETE_STATUS.INTENT, readNow(deps.clock)));
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

/**
 * S1：写**一条**批量写前意图（在任何改名 / mkdir 之前）。
 *
 * 三种返回：
 * - `{key}`：写成功。S2–S5 之间崩溃时，下次收敛会把成员逐个展开（日志不存在 → 完整清理，
 *   日志存在 → 仅收尾），这就是「批量意图」成立的根据；
 * - `{failure}`：写入失败。此时**什么都没动**，所有目标按 failed(STATUS_WRITE_FAILED) 结算，
 *   绝不改名（与逐目标 S1 失败语义一致）；
 * - `undefined`：本次没有要处理的目标（全部被 S0 挡住），不需要写意图。
 *
 * @param {object} deps - 作业依赖。
 * @param {object[]} pendingTargets - 通过 S0 的目标。
 * @returns {Promise<{key?: string, failure?: string}|undefined>} 见上。
 */
async function writeBatchIntent(deps, pendingTargets) {
  if (pendingTargets.length === 0) return undefined;
  const executedAt = readNow(deps.clock);
  const entry = batchIntentEntryOf(executedAt, pendingTargets.map((target) => target.sessionId));
  const key = makeBatchQueueKey(executedAt, deps.random);
  try {
    await deps.store.writeQueueEntry(key, entry);
    return { key };
  } catch (error) {
    return { failure: readErrorCode(error) };
  }
}

/**
 * 本次作业是否留下了「只能由收敛期收尾」的成员（决定批量意图能不能在 S6 丢弃）。
 *
 * `deleted` / `absent` 的日志已经不在原路径：DEG 数据、记账、归档 / 置顶集合与派生缓存的
 * 清理由收敛期的**完整清理**分支负责，而收敛只遍历队列键。丢弃批量意图等于让这些数据永久
 * 泄漏（孤儿清扫只删隔离目录里的文件，不清理任何 DEG 数据）。
 *
 * 其余结局（skipped / failed / raced）都有各自的归宿：日志仍在原地，或已写了单会话条目，
 * 因此丢弃批量意图不会丢待办。
 */
function needsPostJobConvergence(results) {
  return (Array.isArray(results) ? results : []).some((result) => result?.state === SESSION_DELETE_STATES.DELETED
    || result?.state === SESSION_DELETE_STATES.ABSENT);
}

/**
 * S6：批量意图的收尾。
 *
 * 只在「本次没有留下待完整清理的成员」时丢弃它（见 needsPostJobConvergence）；否则保留到下次
 * 启动，由收敛展开并逐条清理后再删除。丢弃失败只记诊断——记录留下等于下次多展开一轮，
 * 收敛的每一步都幂等。
 *
 * @returns {Promise<boolean>} 是否真的删除了记录。
 */
async function dropBatchIntent(deps, batchKey, results, diagnostics) {
  if (needsPostJobConvergence(results) === true) return false;
  try {
    await deps.store.deleteQueueEntry(batchKey);
    return true;
  } catch (error) {
    diagnostics.push({ code: DELETE_JOB_REASONS.STATUS_WRITE_FAILED, detail: readErrorCode(error) });
    return false;
  }
}

/** 把一条目标的诊断并入总表（总表有上限；超出部分丢弃）。 */
function appendDiagnostics(diagnostics, entries) {
  for (const entry of entries ?? []) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) return;
    diagnostics.push(entry);
  }
}

/** 调用崩溃注入钩子；钩子抛错原样上抛（模拟进程在这一点消失）。 */
function invokeHook(deps, stage, context) {
  const hook = deps.hooks?.[stage];
  if (typeof hook !== "function") return;
  hook(context);
}

/**
 * 成功（deleted）与缺席（absent）的统一回执：**不写任何单会话条目**。
 *
 * 收敛期按「批量意图 + 日志不存在」做完整清理（见模块头「批量写前意图」），因此这里的
 * queueStatus 恒为 intent —— 它报告的是「收敛期会看到的那条记录的状态」，不是「刚刚写成功
 * 的状态」。逐目标时代的 cleanup 推进已经整体删除（那是 2N 次整份文档落盘的来源）。
 *
 * @param {object} target - 目标。
 * @param {string} state - 五态之一（deleted / absent）。
 * @returns {object} 结果对象。
 */
function settledResult(target, state) {
  return resultOf(target, state, { queueStatus: SESSION_DELETE_STATUS.INTENT });
}

/**
 * 改名失败后的第一步复原：只删本次失败留下的**空**会话隔离目录（非空一律不动）。
 *
 * 返回值是「本次失败是否已经零副作用」：
 * - `true`：目录已删除，或本来就不存在（失败发生在 mkdir 之前）——没有留下任何需要收敛的
 *   现场，因此不需要额外的单会话条目；
 * - `false`：目录还在（非空 / 删不掉 / 路径判不了）——调用方**必须**补一条单会话 `intent`
 *   条目，交给下次启动的收敛期按「intent + 日志存在」把目录与条目一起收尾。
 *
 * @returns {boolean} 是否已经零副作用。
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
 * 推进单个目标的 S2–S5（**闸门与写前意图已在批量步骤里完成**）。
 *
 * 返回 `{result, diagnostics}`：结果是五态之一，诊断只解释失败（不含路径与堆栈）。钩子抛出的
 * 错误会直接上抛——那是「进程中断」，不是一次作业结果。
 *
 * 成功目标不写任何单会话条目：批量意图已经覆盖它，收敛期按「日志不存在」做完整清理。
 *
 * @param {object} target - 冻结计划里的一个目标（含 `descendantIds`）。
 * @param {object} context - `{deps, headerOf}`。
 * @returns {Promise<{result: object, diagnostics: object[]}>} 单目标结果。
 */
async function runDeleteTarget(target, context) {
  const { deps, headerOf } = context;
  const sessionId = target.sessionId;
  const diagnostics = [];

  // S0（批量闸门）与 S1（批量写前意图）已在 executeDeleteJob 里完成：这里只跑「已经拿到
  // 写前意图」的目标，因此单个目标不再读队列表、也不再写自己的 intent 条目。

  // ── S2 / S3 两次判活 ──────────────────────────────────────────────────────
  // 判活命中时**不写任何条目**：本次作业什么都没发生，批量意图里的这一条会由 S6 的收尾
  // 决定去留（整批都 skipped 时直接丢弃；若进程在此期间崩溃，收敛对它只走 SETTLE_ONLY，
  // 日志仍在原路径，因此无事可做）。
  for (let attempt = 0; attempt < LIVENESS_CHECKS; attempt += 1) {
    const live = readLiveState(target, deps);
    if (live === null) continue;
    return { result: skippedResult(target, live.kind, { blockedBy: live }), diagnostics };
  }

  // ── S4 原子改名进隔离区 ───────────────────────────────────────────────────
  const header = headerOf.get(sessionId);
  // 清单里没有这个会话 = 它没有可改名的日志：清单本身就是「有日志」的权威读面。
  if (header === undefined) {
    return { result: settledResult(target, SESSION_DELETE_STATES.ABSENT), diagnostics };
  }
  const resolution = await resolveTargetLog(deps, header);
  if (resolution?.ok !== true) {
    if (isAbsentResolutionReason(resolution?.reason)) {
      return { result: settledResult(target, SESSION_DELETE_STATES.ABSENT), diagnostics };
    }
    // 判不了路径：为这个会话补一条单会话 intent（收敛期按「日志是否存在」继续裁决）。
    await retainIntentQuietly(deps, sessionId, diagnostics);
    return {
      result: failedResult(target, DELETE_JOB_REASONS.LOG_PATH_UNRESOLVED, String(resolution?.reason ?? "unknown")),
      diagnostics,
    };
  }
  // 多份日志（历史代次）时只搬**当前代次**（版本最高、由定位器排在第一位）。
  const sourcePath = Array.isArray(resolution.files) ? resolution.files[0] : undefined;
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    await retainIntentQuietly(deps, sessionId, diagnostics);
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
      return { result: settledResult(target, SESSION_DELETE_STATES.ABSENT), diagnostics };
    }
    // 改名失败必须真的「没有任何可见变动」。复原顺序**固定**为：
    //   1. 先移除本次 mkdir 刚建出来的空隔离目录；
    //   2. 成功（或目录本来就不存在）之后，才决定条目的去留。
    // 反过来的顺序会在「目录删不掉 / 两步之间崩溃」时留下**无条目引用的空目录**：S0 闸门会
    // 因为它永久阻塞，而收敛期只遍历队列键与批量意图，永远看不到这个目录（该会话再也删不掉）。
    // 目录删不掉时必须补一条**单会话** intent：批量意图会在 S6 被丢弃，救不了这个旧目录。
    invokeHook(deps, DELETE_JOB_HOOKS.BEFORE_QUARANTINE_SWEEP, { sessionId });
    const swept = sweepEmptyQuarantineDirectory(deps, sessionId, diagnostics);
    // 这个钩子刻意排在「条目去留」之前：它模拟的正是「目录已删、条目还没写」这个崩溃窗口。
    invokeHook(deps, DELETE_JOB_HOOKS.AFTER_QUARANTINE_SWEEP, { sessionId, swept });
    if (swept !== true) await retainIntentQuietly(deps, sessionId, diagnostics);
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
    return { result: settledResult(target, SESSION_DELETE_STATES.DELETED), diagnostics };
  }
  // 竞态：先把状态推进到 race（失败则补一条单会话 intent，收敛期按「日志是否存在」兜底）。
  const statusWritten = await advanceStatusQuietly(deps, sessionId, SESSION_DELETE_STATUS.RACE, diagnostics);
  // race 写不进去时不能什么都不留：日志已被搬走，收敛期必须知道「这个会话还有旧代际文件在
  // 隔离区」。补一条 intent 后，收敛期按「intent + 日志存在」收尾隔离目录（SETTLE_ONLY）。
  if (statusWritten !== true) await retainIntentQuietly(deps, sessionId, diagnostics);
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
 * S0 的整批判定：一次闸门批量查询 + 逐目标折叠结论。
 *
 * 日志存在性端口只对「本来会判成 pending」的会话被闸门询问（闸门内部先判残留），因此 160
 * 个目标里只有旧残留那几条会多做一次定位。
 *
 * @param {object} deps - 作业依赖。
 * @param {object[]} targets - 冻结计划里的目标。
 * @param {Map<string, object>} headerOf - 本轮清单快照（会话 ID → header）。
 * @returns {Promise<Map<string, {result?: object, diagnostics: object[]}>>} 会话 ID → 结论。
 */
async function evaluateTargetGates(deps, targets, headerOf) {
  const outcomes = new Map();
  if (targets.length === 0) return outcomes;
  const verdicts = await readGateVerdicts(
    deps,
    targets.map((target) => target.sessionId),
    { logExistsOf: (sessionId) => readLogExistenceOf(deps, headerOf.get(sessionId)) },
  );
  for (const target of targets) {
    outcomes.set(target.sessionId, decideGateOutcome(target, verdicts.get(target.sessionId)));
  }
  return outcomes;
}

/**
 * 单个目标的最终结果：S0 结论优先，其次是 S1 失败，最后才真正跑 S2–S5。
 *
 * **fail-closed**：只有「批量意图确实写成功了」的目标才允许进入改名流水线。若既没有闸门结论、
 * 也没有成功的写前意图（理论上不可达），这里按 STATUS_WRITE_FAILED 结算，绝不在没有持久化
 * 意图的情况下动文件——那会让崩溃后的收敛完全看不到这个会话。
 *
 * @param {object} target - 目标。
 * @param {object} context - `{deps, headerOf, gated, batch}`。
 * @returns {Promise<{result: object, diagnostics: object[]}>} 单目标结果。
 */
async function readTargetOutcome(target, context) {
  const gateOutcome = context.gated.get(target.sessionId);
  if (gateOutcome?.result !== undefined) return gateOutcome;
  if (typeof context.batch?.key !== "string") {
    const detail = String(context.batch?.failure ?? "batch-intent-missing");
    return {
      result: failedResult(target, DELETE_JOB_REASONS.STATUS_WRITE_FAILED, detail),
      diagnostics: gateOutcome?.diagnostics ?? [],
    };
  }
  const outcome = await runDeleteTarget(target, { deps: context.deps, headerOf: context.headerOf });
  // 闸门阶段已经产生的诊断（例如「旧残留被忽略」）必须一并透传：它是放行这条路径的唯一证据。
  const gateDiagnostics = gateOutcome?.diagnostics ?? [];
  if (gateDiagnostics.length === 0) return outcome;
  return { result: outcome.result, diagnostics: [...gateDiagnostics, ...(outcome.diagnostics ?? [])] };
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
  // ── S0 批量闸门：整批只读一次收敛队列，结论逐目标复用（不再每目标读一次整份文档）──────
  const gated = await evaluateTargetGates(deps, plan.targets, captured.headerOf);
  // 只有闸门放行的目标才会被写进批量意图、才会碰文件；skipped / 能力不可用的目标零副作用。
  const pendingTargets = plan.targets.filter((target) => gated.get(target.sessionId)?.result === undefined);
  // ── S1 批量写前意图：一次落盘覆盖本次全部目标，且**位于任何改名之前** ─────────────────
  const batch = await writeBatchIntent(deps, pendingTargets);
  for (const target of plan.targets) {
    const outcome = await readTargetOutcome(target, { deps, headerOf: captured.headerOf, gated, batch });
    results.push(outcome.result);
    appendDiagnostics(diagnostics, outcome.diagnostics);
  }
  // ── S6 批量意图收尾：没有留下待完整清理的成员才丢弃（见 needsPostJobConvergence）──────
  if (typeof batch?.key === "string") await dropBatchIntent(deps, batch.key, results, diagnostics);
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
 * @param {object} deps.store - 票据 01 的收敛日志读写原语（单条读/写/删；批量意图用的是
 *   同一个写入口，键由 `makeBatchQueueKey` 生成）。
 * @param {{check: Function, checkMany?: Function}} deps.gate - 票据 01 的闸门查询。提供
 *   `checkMany` 时 S0 只读一次整份队列文档；只有 `check` 时退回逐目标查询（行为等价，
 *   代价是 N 次文档读取）。
 * @param {object} deps.sessions - 会话事实端口：
 *   `{readHeaders, readDegChildren, readLiveSessionIds, isLive, resolveLog}`。
 * @param {(sessionId: string) => (string|undefined)} [deps.titleOf] - 标题解析（候选查询注入）。
 * @param {object} deps.quarantine - 票据 01 的隔离区适配器：
 *   `{directoryOf, renameIntoQuarantine, restore, removeEmptyDirectory}`。
 * @param {{now: Function}} [deps.clock] - 只读时钟（记录 registeredAt）。
 * @param {() => string} [deps.random] - 批量意图键的随机段来源（缺省用 Math.random；测试注入
 *   确定值，断言 put/delete 的具体键）。
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
  random,
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
    random,
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
