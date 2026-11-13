/**
 * 会话删除实例锁（票据 01；票据 12：pid 已死可接管；复审修正：pid 存活仅在跨启动证明 + 本地固定盘时接管）。
 *
 * ## 为什么允许 stale 接管（宿主单实例保证）
 * 纯文件系统没有 compare-and-swap：两个进程可能在同一瞬间都判定「对方已死」，因此**无条件**
 * 自动接管不可证明安全。这里的安全前提是宿主保证同一台机器只有**一个桌面实例**——Electron
 * 主进程调用 `requestSingleInstanceLock`，同一个 `~/.dsh` 不会被两个进程同时使用。
 * 在这个前提下，「锁属于已退出的进程」只剩一种成因：上次非正常退出留下的残锁。不接管会让
 * 删除功能每次异常退出后**永久失效**（当前实现正是如此），代价远大于下面描述的残余风险。
 *
 * ## 锁文件
 * `<DSH home>/session-delete.lock.json`，内容 `{ pid, startedAt, token }`：
 * - `pid`：持有者进程 ID；
 * - `startedAt`：持有者进程启动时刻（毫秒，由 `Date.now() - process.uptime()` 估计）；
 * - `token`：本进程唯一的随机身份串。三者一起才能确认「这把锁是不是本进程写的」。
 *
 * ## 获取时的判定
 * | 现场 | 结果 |
 * |---|---|
 * | 锁文件不存在 | 独占创建（`wx`）→ 写全落盘 → 读回逐字节复核 → `acquired` |
 * | 已存在，且 pid/启动时间/token 都是本进程的 | `acquired`（`adopted:true`，同进程重入） |
 * | 已存在，是别人的，其 **pid 仍存活** | 默认 `held` + `instance-lock-held`；仅当通过「跨启动会话证明」时按 stale 接管（见下） |
 * | 已存在，是别人的，其 **pid 已死** | 走下面的「接管三步」→ `acquired`（成功）或 `held` + `instance-lock-takeover-lost` |
 * | 字段缺失 / JSON 不可解析 | `unavailable` + `instance-lock-malformed` |
 * | 读不出来 | `unavailable` + `instance-lock-unreadable` |
 * | 写入失败（mkdir / 写盘 / 读回复核不符） | `unavailable` + `instance-lock-write-failed` |
 * | home 解析不出来 | `unavailable` + `instance-lock-home-unresolved` |
 *
 * ## 接管三步（**没有任何 rename 以锁路径为目标**）
 * 1. 把读到的锁原文记为**身份基线**，再把锁文件 `rename` 到唯一旁路名
 *    （`<锁>.takeover-<token>-<n>`；原子操作，同一时刻只有一个进程能移走它）；
 * 2. 读回旁路文件并与基线**逐字节比对**：
 *    - 不一致（移走的是别人刚建的新锁）→ 用**独占创建（`wx`）把旁路文件原字节写回**；
 *      写回撞车（`EEXIST`）或失败 → 保留旁路文件、放弃接管；
 *    - 读不回来（旁路文件不可读）→ 保留旁路文件、放弃接管；
 * 3. 一致（确认移走的就是那把 stale 锁）→ 独占创建新锁（`wx`）；`EEXIST` 说明别人抢先
 *    建了锁 → 放弃接管。创建成功后旁路副本已无引用，尽力删除。
 * 任一步放弃都按 `held` + `instance-lock-takeover-lost` 收尾（并带锁文件路径）。
 *
 * **禁止 rename 放回**：POSIX 的 `rename` 会静默覆盖目标，「先确认不存在再 rename」之间
 * 仍有窗口；把原字节用 `wx` 写回才是原子的「不存在才创建」。
 *
 * ## 跨启动会话证明（pid 被复用但写锁进程已随上次重启消失）
 * pid 会被操作系统复用。真机现场：锁记录是 `{pid: 3048, startedAt: …}`，写锁进程早已退出，
 * 但同一个 pid 被 Windows 复用给一个仍存活的系统进程（svchost.exe），于是 `kill(pid, 0)`
 * 永久报「活着」，锁再也不会自愈。
 *
 * 不能凭 mtime 与 `startedAt` 的时间关系、进程 imageName 或 System32 存在性判定「写锁进程
 * 已随重启消失」——时钟回拨、进程重命名都能同时骗过这些判据。可靠的事实是**启动会话锚点**：
 * Windows 的 System 进程（PID 4）CreationDate 由内核记录，之后改时钟不会改写它；同一启动
 * 会话内所有存活进程的创建时间都晚于这个锚点。
 *
 * 因此当且仅当下列条件**全部**成立时才判 stale 并复用上面的接管三步：
 * ① 记录属于他人；② pid 仍存活（`kill(pid, 0)` 认为在）；③ 锚点查询有效；
 * ④ 记录 `startedAt` 与锁文件 mtime **都**严格早于 `anchor - 10000ms`；
 * ⑤ 时间一致性护栏通过（见 {@link evaluatePreBootStale}）；⑥ 锁文件在可信本地路径（非 UNC）。
 * 其余情况（非 Windows、锚点查询失败/超时/输出非法、mtime 读不到、路径不可信、护栏不过）
 * 一律保持 held：证明不了就不接管。
 *
 * **已知残余风险**：若在「启动完成」与「持锁进程创建/写锁」之间发生超过 10 秒的系统时钟
 * 回拨，一个真实活跃的锁可能被误判为 pre-boot 并被接管。固定 10 秒余量是工程折中，无法防
 * 任意时钟跳变；兜底是宿主单实例保证与作业前的 `verifyOwnership`（真出现误判时，另一方仍会
 * 在作业前发现锁内容不是自己的 token 并 fail-closed）。
 *
 * ## 残余风险
 * 两个进程在同一瞬间都判定「锁属于已死进程」时，各自 rename 到自己的旁路名——只有一个能
 * 成功（另一个 `ENOENT`）。成功者若在创建前被第三者抢先，会放弃接管；被移走的若是别人
 * 刚建的新锁，会按原字节独占写回。窗口里 canonical 路径会短暂为空，因此本实现仍然依赖
 * 「单实例宿主」这一前提；作业前 `verifyOwnership` 是第二道保险（锁内容不是自己的 token
 * 就整体禁用删除能力）。
 *
 * ## 运维出口：lockPath
 * 除 home 解析不出来（拿不到路径）之外，每个不可用结果都带 `lockPath`（锁文件绝对路径）。
 * 启动探测把它透传进诊断（`snapshot().lockPath` 与 instance-lock 检查项）；pid 仍存活、
 * 接管被抢先、记录损坏这些**无法自动处理**的情形，用户据此看到「请删除该文件后重启 DSH」。
 *
 * ## 作业前复核
 * 持锁方在**每次删除作业开始前**复核锁内容仍是自己的 token（`verifyOwnership`）。不是自己
 * 的一律视为丢失锁：作业 fail-closed 拒绝，删除能力整体不可用，且不再重试——另一个实例可能
 * 已经在删同一批日志，任何重试都只是在制造第二次删除。
 *
 * ## 释放
 * 只有 token + pid + 启动时间都匹配时才删除文件：否则会把另一个实例刚拿到的锁删掉。
 * 释放返回**结构化结论**（`{released:true}` / `{released:false, reason:"not-held"}` /
 * `{released:false, reason:"release-failed"}`）：卸载诊断据此区分「本来就没持有」与
 * 「真的没删掉（权限/IO）」，后者才需要运维查磁盘。
 *
 * @module dsh-expert-group/host/session-delete-lock
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, win32 } from "node:path";

/** 锁文件名（DSH home 下）。 */
export const INSTANCE_LOCK_FILE_NAME = "session-delete.lock.json";

/** 实例锁状态（**没有 stale 状态**：stale 只是 held 的一个更具体的原因码）。 */
export const INSTANCE_LOCK_STATES = Object.freeze({
  /** 本进程持有锁（`adopted:true` 表示锁本来就是本进程写的、本次只是认领）。 */
  ACQUIRED: "acquired",
  /** 别人的锁**仍然无法处理**：对方存活，或 stale 接管被抢先/失败。删除能力不可用。 */
  HELD: "held",
  /** 现场无法解释（读写失败 / 字段缺失 / home 未解析）：保守不可用。 */
  UNAVAILABLE: "unavailable",
});

/**
 * 释放锁的结论原因码（**只用于区分「本来就没持有」与「真的没删掉」**）。
 *
 * 卸载诊断直接照抄这个结论：把权限/IO 失败记成「not-held」会误导运维去查「谁拿了锁」，
 * 而真正该查的是磁盘/权限。
 */
export const INSTANCE_LOCK_RELEASE_REASONS = Object.freeze({
  /** 锁文件不存在，或内容不是本进程的（pid/启动时间/token 不匹配）：本进程本来就不持有。 */
  NOT_HELD: "not-held",
  /** 读锁文件抛错（ENOENT 除外）或 unlink 抛错：**锁可能还在**，必须按故障上报。 */
  RELEASE_FAILED: "release-failed",
});

/** 实例锁的稳定原因码（可展示、可断言）。 */
export const INSTANCE_LOCK_REASONS = Object.freeze({
  HOME_UNRESOLVED: "instance-lock-home-unresolved",
  /** 记录字段缺失或 JSON 不可解析（**不改动文件**）。 */
  MALFORMED: "instance-lock-malformed",
  /** 锁文件读不出来（权限/IO，**不改动文件**）。 */
  UNREADABLE: "instance-lock-unreadable",
  /** 写不进去（mkdir / 写盘 / 读回复核不符）。 */
  WRITE_FAILED: "instance-lock-write-failed",
  /** 锁属于另一个**仍存活**的实例：默认删除能力不可用；只有跨启动证明成立时才按 stale 接管。 */
  HELD: "instance-lock-held",
  /**
   * 锁属于另一个**已经退出**的实例（stale）：这是**接管候选**，不是最终结论。
   *
   * 接管成功时 acquire 返回 `acquired`；被抢先/移走的不是 stale 锁时返回
   * `held` + {@link INSTANCE_LOCK_REASONS.TAKEOVER_LOST}。该码本身只会出现在
   * `evaluateInstanceLock` 的纯判定结果里。
   */
  STALE: "instance-lock-stale",
  /**
   * 接管竞态失手（移走的是别人刚建的新锁且写回失败 / 创建被抢先）：保守按「另一个实例在场」
   * 处理，删除能力不可用，并带上锁文件路径。
   */
  TAKEOVER_LOST: "instance-lock-takeover-lost",
  /** 持锁方在作业前复核时发现锁已被替换：删除能力永久不可用（不再重试）。 */
  LOCK_LOST: "instance-lock-lost",
  /** 本进程从未持有锁（或已经释放）。 */
  NOT_HELD: "instance-lock-not-held",
});

/**
 * 启动时间比较容差（毫秒）。
 *
 * 只用于「这条记录是不是**本进程**写的」：同一进程里两次装配各自估算 `startedAt` 会有
 * 几毫秒抖动（`Date.now() - process.uptime()`），2 秒足以覆盖它；而 token 已经保证
 * 两个不同进程不可能写出相同记录，因此容差不会把「别人的锁」误认成自己的。
 */
export const INSTANCE_LOCK_START_TOLERANCE_MS = 2000;

/**
 * pre-boot 判定余量（毫秒）：记录与锁文件 mtime 都必须**严格早于**启动锚点 10 秒以上。
 *
 * 为什么不是 0：`startedAt` 是 `Date.now() - process.uptime()` 的估算值，锁文件 mtime 由文件
 * 系统时钟给出，两者与锚点之间都可能存在秒级抖动；留 10 秒吸收这些正常误差，同时仍能把
 * 「上一个启动会话里的写锁进程」与「本启动会话里刚写的锁」明确分开。
 */
const PRE_BOOT_MARGIN_MS = 10000;

/**
 * `startedAt` 与锁文件 mtime 之间允许的偏差（毫秒）。
 *
 * 写锁必然发生在「进程启动」之后，因此记录里的启动时刻不应显著晚于锁文件 mtime。反过来
 * （mtime 被改早、或写锁前系统时钟回拨）会让「早于锚点」的判断失去意义，只能保持 held。
 */
const PRE_BOOT_CLOCK_SKEW_TOLERANCE_MS = 10000;

/** 启动锚点允许晚于当前时钟的容差（毫秒）：锚点在未来说明时钟被回拨过，不能据此判 stale。 */
const PRE_BOOT_FUTURE_TOLERANCE_MS = 5000;

/** PID 0（System Idle Process）与 PID 4（System）CreationDate 允许的偏差（毫秒）。 */
const PRE_BOOT_PID0_TOLERANCE_MS = 10000;

/** 跨启动接管的证据短码（写进 `acquired` 状态的 `recoveredBy`，供诊断与断言）。 */
const PRE_BOOT_EVIDENCE = "stale-by-pre-boot";

/** PowerShell 锚点探针的超时（毫秒）：探测失败只是「不能自愈」，不得拖慢启动。 */
const BOOT_ANCHOR_TIMEOUT_MS = 5000;

/** FILETIME（自 1601-01-01 起的 100ns 计数）转 Unix 毫秒的固定偏移。 */
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11644473600000n;

/** 锚点脚本允许出现的两个 PID 与它们必须的进程名（键是逐字的 PID 文本，确名大小写不敏感）。 */
const BOOT_ANCHOR_PIDS = new Map([["4", "system"], ["0", "system idle process"]]);

/** 随机 token 的字节数（十六进制后 16 个字符，足够避免任何实际碰撞）。 */
const LOCK_TOKEN_RANDOM_BYTES = 8;

/** 获取时的最大尝试次数（只覆盖「创建时存在、读时又消失」的释放竞态，绝不重试接管）。 */
const ACQUIRE_ATTEMPTS = 2;

/** 读一个「有限正数」：其他一切（缺失 / NaN / Infinity / 0 / 负数 / 非数值）都返回 undefined。 */
function readPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 独占创建配置文件（`wx` + 写全 + fsync + close）。
 *
 * 为什么不用 `writeFileSync`：它在返回时只保证「写进了内核页缓存」，进程崩溃或掉电后文件
 * 可能是空的/半截的。锁文件是**跨进程身份**，读回时必须已经落盘。
 *
 * @param {string} filePath - 目标路径。
 * @param {string} text - 内容。
 * @param {{flag?: string}} [options] - 只认 `flag`（默认 `w`；创建锁时传 `wx`）。
 */
function writeFileDurably(filePath, text, options = {}) {
  const flag = typeof options.flag === "string" ? options.flag : "w";
  const handle = openSync(filePath, flag, 0o600);
  try {
    writeSync(handle, text);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/** 默认文件系统端口（生产实现）。 */
const DEFAULT_IO = Object.freeze({
  readFile: readFileSync,
  writeFile: writeFileDurably,
  unlink: unlinkSync,
  mkdir: mkdirSync,
  // 只用于接管第一步「把锁移开到旁路名」；任何 rename 都不以锁路径为目标。
  rename: renameSync,
  // 只用于 pre-boot 判定读锁文件 mtime；缺失/抛错时该判定整体跳过（保持 held）。
  stat: statSync,
});

/** 默认存活探针：`kill(pid, 0)` 抛 ESRCH 才算死；EPERM 表示进程存在但无权发信号。 */
function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** 本进程的启动时刻（毫秒）。只用于身份比对，精度足够。 */
function currentProcessStartedAtMs() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * 生成本进程唯一的锁 token（`pid-startedAt-随机串`）。
 *
 * @param {number} pid - 进程 ID。
 * @param {number} startedAt - 进程启动时刻（毫秒）。
 * @returns {string} 身份串。
 */
function buildLockToken(pid, startedAt) {
  return pid + "-" + startedAt + "-" + randomBytes(LOCK_TOKEN_RANDOM_BYTES).toString("hex");
}

/**
 * 解析锁文件文本（**纯函数**）。
 *
 * @param {string} text - 文件内容。
 * @returns {{kind: "absent"}|{kind: "malformed"}|{kind: "record", record: object}} 解析结果。
 */
export function parseInstanceLockRecord(text) {
  if (typeof text !== "string" || text.length === 0) return { kind: "malformed" };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "malformed" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "malformed" };
  return { kind: "record", record: parsed };
}

/** 记录是否具备完整的身份三要素（缺一即按「字段缺失」处理）。 */
function isCompleteLockRecord(record) {
  return record !== null
    && typeof record === "object"
    && !Array.isArray(record)
    && Number.isInteger(record.pid)
    && record.pid > 0
    && Number.isFinite(record.startedAt)
    && record.startedAt > 0
    && typeof record.token === "string"
    && record.token.length > 0;
}

/** 这条记录是不是本进程写的（token + pid + 启动时间三者全等才算）。 */
function isSelfLockRecord(record, facts) {
  if (record.token !== facts.token) return false;
  if (record.pid !== facts.pid) return false;
  if (!Number.isFinite(facts.startedAt)) return false;
  return Math.abs(record.startedAt - facts.startedAt) <= facts.toleranceMs;
}

/**
 * 判定一条已解析的锁记录与**本进程身份**的关系（**纯函数**）。
 *
 * 不判「对方启动时间是否被 pid 重用」：既然不接管，别人的锁无论来自哪个进程都只能是 held，
 * 唯一有价值的细分是「对方 pid 是否还活着」（stale 比 held 更能指导用户动手删文件）。
 *
 * @param {object|null} record - 锁记录；null/非对象/字段缺失都按 malformed 处理。
 * @param {object} facts - 判定所需事实。
 * @param {number} facts.pid - 本进程 pid。
 * @param {number} facts.startedAt - 本进程启动时刻（毫秒）。
 * @param {string} facts.token - 本进程身份串。
 * @param {(pid: number) => boolean} facts.isProcessAlive - 存活探针。
 * @param {number} [facts.toleranceMs] - 启动时间容差。
 * @returns {{status: string, reason?: string, adopted?: boolean, holder?: object}} 判定结果
 *   （不含 `lockPath`：路径由调用方补上，纯函数不碰环境）。
 */
export function evaluateInstanceLock(record, facts) {
  if (!isCompleteLockRecord(record)) {
    return { status: INSTANCE_LOCK_STATES.UNAVAILABLE, reason: INSTANCE_LOCK_REASONS.MALFORMED };
  }
  const toleranceMs = Number.isFinite(facts?.toleranceMs)
    ? facts.toleranceMs
    : INSTANCE_LOCK_START_TOLERANCE_MS;
  if (isSelfLockRecord(record, { ...facts, toleranceMs })) {
    return { status: INSTANCE_LOCK_STATES.ACQUIRED, adopted: true };
  }
  let alive;
  let aliveUnknown = false;
  try {
    alive = facts.isProcessAlive(record.pid) === true;
  } catch {
    // 判不了存活就按「活着」保守处理（结论同样是 held，只是原因码更保守）。
    // aliveUnknown 让 acquire 知道「连存活都证明不了」：此时不得做任何接管取证。
    alive = true;
    aliveUnknown = true;
  }
  return {
    status: INSTANCE_LOCK_STATES.HELD,
    reason: alive ? INSTANCE_LOCK_REASONS.HELD : INSTANCE_LOCK_REASONS.STALE,
    ...(aliveUnknown === true ? { aliveUnknown: true } : {}),
    holder: { pid: record.pid, startedAt: record.startedAt },
  };
}

/**
 * 跨启动会话证明的**纯判定**（导出以便直接测试：不读环境、不 spawn 进程）。
 *
 * 只有在「锁记录属于他人 + pid 仍存活」时才会被调用；它回答一个问题：**能不能证明写锁
 * 进程属于上一个启动会话、并且已经不存在了**。答不了就返回 `{stale:false}`，调用方按既有
 * held 收尾——绝不因为「时间看起来很久远」就接管。
 *
 * 判定顺序与理由：
 * 1. 字段必须齐全且是有限正数（缺失/NaN/0/负数都不可解释）；
 * 2. `startedAt` 不得显著晚于锁文件 mtime：写锁在启动之后发生，反过来说明现场被改过或写锁前
 *    发生过时钟回拨，「早于锚点」不可信；
 * 3. 锚点不得晚于当前时钟（+5 秒容差）：锚点在未来说明当前时钟被回拨，任何比较都不可信；
 * 4. PID 0 与 PID 4 的创建时间必须一致（±10 秒）：两者矛盾说明输出不可信；
 * 5. 只有 `startedAt` 与 mtime **都**严格早于 `anchor - 10 秒` 才判 stale。
 *
 * @param {object} [input] - 判定所需事实。
 * @param {number} input.startedAt - 锁记录里的持有者启动时刻（毫秒）。
 * @param {number} input.lockMtimeMs - 锁文件 mtime（毫秒）。
 * @param {number} input.anchorMs - 启动会话锚点（PID 4 CreationDate，毫秒）。
 * @param {number} [input.pid0Ms] - PID 0 CreationDate（毫秒，可缺失）。
 * @param {number} input.nowMs - 当前时钟（毫秒）。
 * @param {number} [input.marginMs] - 余量，默认 10000。
 * @param {number} [input.clockSkewToleranceMs] - 启动时刻与 mtime 的容差，默认 10000。
 * @param {number} [input.futureToleranceMs] - 锚点允许晚于当前时钟的容差，默认 5000。
 * @param {number} [input.pid0ToleranceMs] - PID 0 与锚点的容差，默认 10000。
 * @returns {{stale: boolean, evidence?: string, detail?: string}} 结论：`stale:true` 只在全部
 *   前置条件成立时出现；`detail` 是稳定短码，便于诊断「为什么没有自愈」。
 */
export function evaluatePreBootStale(input = {}) {
  const startedAt = readPositiveNumber(input?.startedAt);
  const lockMtimeMs = readPositiveNumber(input?.lockMtimeMs);
  const anchorMs = readPositiveNumber(input?.anchorMs);
  const nowMs = readPositiveNumber(input?.nowMs);
  const marginMs = input?.marginMs === undefined ? PRE_BOOT_MARGIN_MS : readPositiveNumber(input.marginMs);
  const clockSkewToleranceMs = input?.clockSkewToleranceMs === undefined
    ? PRE_BOOT_CLOCK_SKEW_TOLERANCE_MS
    : readPositiveNumber(input.clockSkewToleranceMs);
  const futureToleranceMs = input?.futureToleranceMs === undefined
    ? PRE_BOOT_FUTURE_TOLERANCE_MS
    : readPositiveNumber(input.futureToleranceMs);
  const pid0ToleranceMs = input?.pid0ToleranceMs === undefined
    ? PRE_BOOT_PID0_TOLERANCE_MS
    : readPositiveNumber(input.pid0ToleranceMs);
  if (startedAt === undefined
    || lockMtimeMs === undefined
    || anchorMs === undefined
    || nowMs === undefined
    || marginMs === undefined
    || clockSkewToleranceMs === undefined
    || futureToleranceMs === undefined
    || pid0ToleranceMs === undefined) {
    return { stale: false, detail: "inputs-invalid" };
  }
  let pid0Ms;
  if (input?.pid0Ms !== undefined) {
    pid0Ms = readPositiveNumber(input.pid0Ms);
    if (pid0Ms === undefined) return { stale: false, detail: "pid0-invalid" };
  }
  // 护栏 1：写锁发生在进程启动之后，记录里的启动时刻不应显著晚于锁文件 mtime。
  if (startedAt > lockMtimeMs + clockSkewToleranceMs) {
    return { stale: false, detail: "started-after-lock-mtime" };
  }
  // 护栏 2：锚点在未来 = 当前时钟被回拨过，任何「早于锚点」的比较都不可信。
  if (anchorMs > nowMs + futureToleranceMs) {
    return { stale: false, detail: "anchor-in-future" };
  }
  // 护栏 3：两个锚点互相矛盾 = 输出不可信（脚本异常 / 系统记录异常），不能据此接管。
  if (pid0Ms !== undefined && Math.abs(pid0Ms - anchorMs) > pid0ToleranceMs) {
    return { stale: false, detail: "pid0-mismatch" };
  }
  if (startedAt < anchorMs - marginMs && lockMtimeMs < anchorMs - marginMs) {
    return { stale: true, evidence: PRE_BOOT_EVIDENCE, detail: "before-boot-anchor" };
  }
  return { stale: false, detail: "not-before-boot-anchor" };
}

/**
 * 解析锚点脚本输出（**纯函数**）：每行 `<pid>|<name>|<FILETIME>` 或 `VOL|<盘符>`。
 *
 * 严格解析的理由：这段输出是接管别人锁的**唯一证据**，多一个字符都不该被容忍。
 * - PID 段必须**逐字等于**脚本固定查询的 `4` 或 `0`（前导零等任何其它写法一律非法），
 *   进程名必须逐字匹配（大小写不敏感）；
 * - FILETIME 必须是十进制整数，用 BigInt 转毫秒（`ft / 10000 - 11644473600000`）；
 * - `VOL|C:` 行来自 `Win32_LogicalDisk` 的 `DriveType=3` 查询（本地固定盘）：盘符必须
 *   形如 `C:`（字母 + 冒号），重复盘符只保留一份；
 * - PID 4 必需；PID 0 可以缺失，但**出现却不合法**时整次解析失败；`VOL` 行至少要有一条
 *   （没有卷列表就无法证明锁文件在本地固定盘上，宁可不可自愈也不猜）；
 * - 重复 PID、未知前缀、空行以外的多余内容一律视为非法输出。
 *
 * @param {string} text - 脚本 stdout。
 * @returns {{anchorMs: number, pid0Ms?: number, localFixedDrives: string[]}|undefined}
 *   解析结果；任何不合法都返回 undefined。
 */
export function parseBootAnchorOutput(text) {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const found = new Map();
  const localFixedDrives = new Set();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split("|");
    if (parts.length === 2 && parts[0].trim() === "VOL") {
      // 本地固定盘列表：盘符必须形如 `C:`（字母 + 冒号），大小写归一后去重。
      const deviceId = parts[1].trim();
      if (/^[A-Za-z]:$/u.test(deviceId) !== true) return undefined;
      localFixedDrives.add(deviceId.toUpperCase());
      continue;
    }
    if (parts.length !== 3) return undefined;
    const pidText = parts[0].trim();
    const nameText = parts[1].trim().toLowerCase();
    const fileTimeText = parts[2].trim();
    if (/^\d+$/u.test(fileTimeText) !== true) return undefined;
    // PID 段必须逐字等于脚本固定查询的 4 或 0（前导零等写法一律视为非法输出）。
    const expectedName = BOOT_ANCHOR_PIDS.get(pidText);
    if (expectedName === undefined || expectedName !== nameText) return undefined;
    const pid = Number(pidText);
    if (found.has(pid)) return undefined;
    const fileTime = BigInt(fileTimeText);
    const ms = Number(fileTime / 10000n - FILETIME_UNIX_EPOCH_OFFSET_MS);
    if (Number.isFinite(ms) !== true || ms <= 0) return undefined;
    found.set(pid, ms);
  }
  const anchorMs = found.get(4);
  if (anchorMs === undefined) return undefined;
  // 没有卷列表就无法证明锁文件在本地固定盘上：整次解析失败（fail-closed）。
  if (localFixedDrives.size === 0) return undefined;
  const pid0Ms = found.get(0);
  const drives = [...localFixedDrives].sort();
  return pid0Ms === undefined
    ? { anchorMs, localFixedDrives: drives }
    : { anchorMs, pid0Ms, localFixedDrives: drives };
}

/**
 * 锚点脚本：一次调用里查固定 PID（4 与 0）与本地固定盘（DriveType=3），只读系统信息。
 *
 * - 进程行输出 `<pid>|<name>|<FILETIME>`；
 * - 卷行输出 `VOL|<DeviceID>`（如 `VOL|C:`）：只有本地固定盘才允许 pre-boot 接管，UNC /
 *   映射盘 / 可移动盘都不在这个列表里，调用方据此保持 held。
 */
const BOOT_ANCHOR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process -Filter 'ProcessId=4 or ProcessId=0' | ForEach-Object {",
  "  if ($null -ne $_.CreationDate) {",
  "    '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, $_.CreationDate.ToFileTimeUtc()",
  "  }",
  "}",
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {",
  "  'VOL|' + $_.DeviceID",
  "}",
].join("\n");

/**
 * 构造 Windows 启动会话锚点读取器（非 Windows / 拿不到 SystemRoot 时永远返回 undefined）。
 *
 * 为什么用绝对 PowerShell 路径：插件运行在宿主进程里，PATH 可能被裁剪或劫持；这条查询直接
 * 决定「是否接管别人的锁」，命令解析必须固定，不能依赖名字查找。脚本只执行一次、有固定
 * 超时、窗口隐藏，且只读系统信息。
 *
 * ## 卷类型闸门（复审修复）
 * 仅凭锚点无法判断锁文件所在文件系统是否可信：UNC、映射网络盘、可移动盘上的锁可能由**另一台
 * 机器**写入，用本机启动锚点去证明「写锁进程已随本机重启消失」是无效推理。因此脚本在同一次
 * 调用里同时查询 `Win32_LogicalDisk -Filter 'DriveType=3'`（本地固定盘），读取器按
 * `lockPath` 的盘符做白名单校验：不是本地固定盘就返回 undefined（调用方保持 held）。
 *
 * 读取器签名是 `readBootAnchor(lockPath) -> {anchorMs, pid0Ms?} | undefined`；任何失败
 * （spawn 抛错、超时、非零退出、输出非法、盘符不可信、查询失败）都返回 undefined。
 *
 * @param {object} [deps] - 端口注入（测试用它替换 spawnSync / platform / env，不 spawn 真进程）。
 * @param {Function} [deps.spawnSync] - `node:child_process.spawnSync`。
 * @param {string} [deps.platform] - 平台（默认 `process.platform`）。
 * @param {object} [deps.env] - 环境变量（只读 `SystemRoot`）。
 * @returns {(lockPath: string) => ({anchorMs: number, pid0Ms?: number}|undefined)} 锚点读取器。
 */
export function makeWindowsBootAnchorReader({
  spawnSync: spawn = spawnSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  const systemRoot = typeof env?.SystemRoot === "string" && env.SystemRoot.length > 0
    ? env.SystemRoot
    : undefined;
  if (platform !== "win32" || systemRoot === undefined) return () => undefined;
  const powerShellPath = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return (lockPath) => {
    // 先判盘符：UNC / 相对路径 / 非本地固定盘连脚本都不执行（查询失败与不可信等价：held）。
    const driveRoot = readLocalDriveRoot(lockPath);
    if (driveRoot === undefined) return undefined;
    let result;
    try {
      result = spawn(powerShellPath, ["-NoProfile", "-NonInteractive", "-Command", BOOT_ANCHOR_SCRIPT], {
        timeout: BOOT_ANCHOR_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
      });
    } catch {
      return undefined;
    }
    if (result === null || typeof result !== "object") return undefined;
    // 超时/启动失败带 error 且 status 为 null；两者都不能当成「查询有效」。
    if (result.error !== undefined && result.error !== null) return undefined;
    if (result.status !== 0) return undefined;
    const parsed = parseBootAnchorOutput(result.stdout);
    if (parsed === undefined) return undefined;
    // 盘符必须真的出现在本地固定盘列表里（映射盘不在其中）。
    if (parsed.localFixedDrives.includes(driveRoot) !== true) return undefined;
    return parsed.pid0Ms === undefined
      ? { anchorMs: parsed.anchorMs }
      : { anchorMs: parsed.anchorMs, pid0Ms: parsed.pid0Ms };
  };
}

/** 锁文件 mtime（毫秒）；端口缺失 / 读不到 / 形状非法一律 undefined（= 不能做 pre-boot 判定）。 */
function readLockFileMtimeMs(io, lockPath) {
  if (typeof io?.stat !== "function") return undefined;
  try {
    const stats = io.stat(lockPath);
    return readPositiveNumber(stats?.mtimeMs);
  } catch {
    return undefined;
  }
}

/** UNC 路径与 `\\?\` 扩展前缀路径（扩展格式的本地路径也暂不接管）：pre-boot 取证前直接跳过，保持不可用（映射盘/可移动盘由锚点读取器的卷类型查询负责）。 */
function isNetworkLockPath(lockPath) {
  return typeof lockPath === "string" && (lockPath.startsWith("\\\\") || lockPath.startsWith("//"));
}


/**
 * 锁文件所在卷的盘符（大写、带冒号，如 C:）；UNC / 相对路径 / 无盘符一律 undefined。
 *
 * 用 win32.parse 而不是当前平台的 parse：lockPath 是 Windows 路径，即使在别的平台上跑单测
 * 也必须按 Windows 卷语义解释（在 win32 上两者本来就是同一个实现）。盘符是否属于
 * 「本地固定盘」由锚点读取器按 DriveType=3 查询结果判定。
 */
function readLocalDriveRoot(lockPath) {
  if (typeof lockPath !== "string" || lockPath.length === 0) return undefined;
  if (isNetworkLockPath(lockPath)) return undefined;
  if (win32.isAbsolute(lockPath) !== true) return undefined;
  let root;
  try {
    root = win32.parse(lockPath).root;
  } catch {
    return undefined;
  }
  if (typeof root !== "string") return undefined;
  let normalized = root.toUpperCase();
  while (normalized.endsWith("\\") || normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return /^[A-Z]:$/u.test(normalized) ? normalized : undefined;
}

/**
 * 创建实例锁。
 *
 * @param {object} deps - 端口注入（测试用它替换 home、pid、时钟、存活探针与文件系统）。
 * @param {string|Function} deps.homeDirectory - DSH home，或返回它的函数（服务可能晚提供）。
 * @param {number} [deps.pid] - 本进程 pid（默认 `process.pid`）。
 * @param {number} [deps.startedAt] - 本进程启动时刻（默认按 uptime 估计）。
 * @param {number} [deps.toleranceMs] - 启动时间容差。
 * @param {string} [deps.token] - 本进程身份串（默认随机生成；测试可注入固定值）。
 * @param {object} [deps.io] - 文件系统端口（`readFile / writeFile / unlink / mkdir / rename / stat`）。
 * @param {(pid: number) => boolean} [deps.isProcessAlive] - 存活探针。
 * @param {(lockPath: string) => ({anchorMs: number, pid0Ms?: number}|undefined)} [deps.readBootAnchor]
 *   启动会话锚点读取器（按锁文件路径判「本地固定盘」）；**默认不注入**（= 不启用 pre-boot
 *   接管，现有单测不会 spawn 外部进程）。生产装配注入 {@link makeWindowsBootAnchorReader}，
 *   测试可用替身直接给结论（可忽略 lockPath 参数）。
 * @param {() => number} [deps.now] - 只读时钟（pre-boot 判定需要「当前时刻」这个事实）。
 * @returns {{path: Function, acquire: Function, verifyOwnership: Function, release: Function,
 *   snapshot: Function}} 锁能力面。
 */
export function installInstanceLock({
  homeDirectory,
  pid = process.pid,
  startedAt = currentProcessStartedAtMs(),
  toleranceMs = INSTANCE_LOCK_START_TOLERANCE_MS,
  token = buildLockToken(pid, startedAt),
  io = DEFAULT_IO,
  isProcessAlive = defaultIsProcessAlive,
  readBootAnchor,
  now = () => Date.now(),
}) {
  /** 最近一次判定结论（不可用结果里带 `lockPath`，供探测诊断透传）。 */
  let state = { status: INSTANCE_LOCK_STATES.UNAVAILABLE, reason: INSTANCE_LOCK_REASONS.HOME_UNRESOLVED };
  let ownsLock = false;
  /** 一旦确认锁被替换：锁死（删除能力永久不可用，不再重新竞争）。 */
  let lostReason = null;
  /** 旁路名自增序号：同一个进程多次接管也不会重名。 */
  let takeoverSequence = 0;

  /** 解析锁文件绝对路径（home 未就绪时抛错，由 acquire 收敛成 UNAVAILABLE）。 */
  function lockFilePath() {
    const home = typeof homeDirectory === "function" ? homeDirectory() : homeDirectory;
    if (typeof home !== "string" || home.length === 0) {
      throw Object.assign(new Error("dsh home is unresolved"), { code: INSTANCE_LOCK_REASONS.HOME_UNRESOLVED });
    }
    return join(home, INSTANCE_LOCK_FILE_NAME);
  }

  /** 尽力取锁路径（只为给诊断带上 `lockPath`，取不到就不带）。 */
  function readableLockPath() {
    try {
      return lockFilePath();
    } catch {
      return undefined;
    }
  }

  /** 不可用结论的统一构造点：一律带 `lockPath`（拿不到路径时才省略）。 */
  function unavailableState(reason) {
    const lockPath = readableLockPath();
    state = {
      status: INSTANCE_LOCK_STATES.UNAVAILABLE,
      reason,
      ...(lockPath === undefined ? {} : { lockPath }),
    };
    return state;
  }

  /** HELD 结论的统一构造点：带 `lockPath` 与（已知时）持有者信息。 */
  function heldState(reason, extra = {}) {
    const lockPath = readableLockPath();
    state = {
      status: INSTANCE_LOCK_STATES.HELD,
      reason,
      ...extra,
      ...(lockPath === undefined ? {} : { lockPath }),
    };
    return state;
  }

  /** 本进程要写入的锁文件内容（身份 = 这段文本的逐字节取值）。 */
  function serializeLockRecord() {
    return JSON.stringify({ pid, startedAt, token });
  }

  /** 读取现场：absent / malformed / unreadable / record（record 额外带原文）。 */
  function readLockFile(path) {
    let text;
    try {
      text = io.readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable" };
    }
    const parsed = parseInstanceLockRecord(text);
    if (parsed.kind === "malformed") return { kind: "malformed", text };
    return { kind: "record", record: parsed.record, text };
  }

  /** 记一次「锁已丢失」并锁死后续尝试（此后 acquire 一律返回 held/lock-lost）。 */
  function markLost() {
    lostReason = INSTANCE_LOCK_REASONS.LOCK_LOST;
    ownsLock = false;
    heldState(INSTANCE_LOCK_REASONS.LOCK_LOST);
    return { ok: false, reason: INSTANCE_LOCK_REASONS.LOCK_LOST };
  }

  /** 删除文件（尽力而为；不存在或删不掉都只是「没删成」）。 */
  function removeFileQuietly(path) {
    try {
      io.unlink(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 独占创建 + 写全 + 落盘 + 读回**逐字节**复核。
   *
   * `wx` 是内核级的「不存在才创建」：目标已存在时原子失败，因此它同时是
   * 「创建本进程的锁」与「把被误移走的锁按原字节写回」两种场合的唯一手段。
   *
   * @param {string} path - 目标路径。
   * @param {string} [text] - 要写入的完整内容（默认本进程的锁记录）。
   * @returns {{ok: true}|{ok: false, reason: "exists"|"write-failed"}} 结果。
   */
  function writeExclusiveLock(path, text = serializeLockRecord()) {
    try {
      io.mkdir(dirname(path), { recursive: true });
    } catch {
      return { ok: false, reason: "write-failed" };
    }
    try {
      io.writeFile(path, text, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error?.code === "EEXIST") return { ok: false, reason: "exists" };
      // 写失败时尽力删掉可能留下的半截文件：一个不可解析的锁文件会让**所有**实例永久判成
      // unreadable（删除能力全灭），而此刻删除能力在本进程已经不可用了。
      try {
        io.unlink(path);
      } catch {
        // 删不掉也只是残留；本次结论已经是不可用。
      }
      return { ok: false, reason: "write-failed" };
    }
    const written = readLockFile(path);
    if (written.text !== text) {
      // 读不回来或内容不符：无法证明落盘的就是本进程的身份 → 不算持有。
      return { ok: false, reason: "write-failed" };
    }
    return { ok: true };
  }

  /**
   * stale 接管：**移开 → 身份复核 → 独占创建**（任何 rename 都不以锁路径为目标）。
   *
   * 三步与失败处置（全部 fail-closed，放弃一律 `held/takeover-lost` 并带锁路径）：
   * 1. 锁文件 rename 到唯一旁路名（原子：同一时刻只有一个进程能移走它）；
   * 2. 读回旁路文件并与基线逐字节比对——
   *    - 不一致（移走的是别人刚建的新锁）→ 用**独占创建**把旁路文件原字节写回；写回撞车
   *      （`EEXIST`）或失败 → 保留旁路文件、放弃接管；
   *    - 读不回来 → 保留旁路文件、放弃接管；
   * 3. 一致 → 独占创建新锁（`wx`）；`EEXIST` 说明别人抢先 → 放弃接管。
   *
   * @param {string} path - 锁文件路径。
   * @param {string} observedText - 接管前读到的锁原文（身份基线）。
   * @returns {object} 本次 acquire 的结论（acquired，或 held + instance-lock-takeover-lost）。
   */
  function takeOver(path, observedText) {
    takeoverSequence += 1;
    const sidePath = path + ".takeover-" + token + "-" + takeoverSequence;
    try {
      io.rename(path, sidePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // 观察与移开之间锁消失了（持有者释放 / 另一个接管者先移走）：再抢一次独占创建，
        // 抢不到就放弃（不是接管失败，而是「有人比我先动」）。
        const retry = writeExclusiveLock(path);
        if (retry.ok === true) {
          ownsLock = true;
          state = { status: INSTANCE_LOCK_STATES.ACQUIRED, adopted: false };
          return state;
        }
        return heldState(INSTANCE_LOCK_REASONS.TAKEOVER_LOST);
      }
      // 移不开就动不了现场：保守不可用（连判定都做不了，不能假装接管理由充分）。
      return unavailableState(INSTANCE_LOCK_REASONS.UNREADABLE);
    }
    const moved = readLockFile(sidePath);
    if (moved.kind === "absent" || moved.kind === "unreadable") {
      // 移开后读不回来：判不了移走的是谁 → 保留旁路文件、放弃接管。
      return heldState(INSTANCE_LOCK_REASONS.TAKEOVER_LOST);
    }
    if (moved.kind !== "record" || moved.text !== observedText) {
      // 身份复核失败：移走的是别人刚建的新锁（或已损坏）。按**原字节**独占写回，绝不覆盖。
      const restored = writeExclusiveLock(path, moved.text);
      if (restored.ok === true) removeFileQuietly(sidePath);
      // 写回撞车（EEXIST）/写失败：保留旁路文件（不猜、不销毁现场），放弃接管。
      return heldState(INSTANCE_LOCK_REASONS.TAKEOVER_LOST);
    }
    // 身份一致：确认移走的就是那把 stale 锁 → 独占创建新锁。
    const attempt = writeExclusiveLock(path);
    // 旧锁副本已无引用（刚逐字节确认过），尽力删除；删不掉也只是残留。
    removeFileQuietly(sidePath);
    if (attempt.ok === true) {
      ownsLock = true;
      state = { status: INSTANCE_LOCK_STATES.ACQUIRED, adopted: false };
      return state;
    }
    // EEXIST：别人抢先建了锁；写失败同样放弃。
    return heldState(INSTANCE_LOCK_REASONS.TAKEOVER_LOST);
  }

  /**
   * 收集「跨启动会话证明」的结论（只在「记录属于他人 + pid 仍存活 + 存活判定可信」时调用）。
   *
   * 任一前置条件不成立都返回 `{stale:false}`，调用方按既有 held 收尾：未注入锚点端口、
   * 锁文件在 UNC/网络路径、mtime 读不到、锚点查询抛错/返回非法（含卷类型不可信）、
   * 当前时钟读不出来。
   *
   * @param {string} lockPath - 锁文件路径（锚点读取器据此判「本地固定盘」）。
   * @param {object} record - 锁记录。
   * @returns {{stale: boolean, detail?: string}} 判定结论（`stale:true` 时还带 `evidence`）。
   */
  function readPreBootVerdict(lockPath, record) {
    if (typeof readBootAnchor !== "function") return { stale: false };
    // 记录声称与本进程同一身份（同 pid + 同启动时刻）却 token 不同：本进程此刻就活着，
    // 不存在「上一个启动会话」的解释，按身份不符 held —— 连锚点都不查。
    if (record.pid === pid && Math.abs(record.startedAt - startedAt) <= toleranceMs) {
      return { stale: false, detail: "self-identity-mismatch" };
    }
    if (isNetworkLockPath(lockPath)) return { stale: false, detail: "network-path" };
    const lockMtimeMs = readLockFileMtimeMs(io, lockPath);
    if (lockMtimeMs === undefined) return { stale: false, detail: "mtime-unreadable" };
    let anchor;
    try {
      anchor = readBootAnchor(lockPath);
    } catch {
      return { stale: false, detail: "anchor-read-failed" };
    }
    if (anchor === null || typeof anchor !== "object") return { stale: false, detail: "anchor-unavailable" };
    let nowMs;
    try {
      nowMs = now();
    } catch {
      // 时钟读不出来就证明不了「锚点在当前时刻之前」：保持 held。
      return { stale: false, detail: "now-unreadable" };
    }
    return evaluatePreBootStale({
      startedAt: record.startedAt,
      lockMtimeMs,
      anchorMs: anchor.anchorMs,
      pid0Ms: anchor.pid0Ms,
      nowMs,
    });
  }

  /**
   * 获取锁：**独占创建**是唯一判据；已存在就判定，默认不接管（仅在可证明写锁进程已消失时接管）。
   *
   * @returns {object} 本次判定结论（见 {@link INSTANCE_LOCK_STATES}；不可用结果带 lockPath）。
   */
  function acquire() {
    if (lostReason !== null) {
      // 锁已经丢失过：删除能力在本进程内永久不可用，绝不重新竞争。
      ownsLock = false;
      return heldState(INSTANCE_LOCK_REASONS.LOCK_LOST);
    }
    let path;
    try {
      path = lockFilePath();
    } catch {
      ownsLock = false;
      return unavailableState(INSTANCE_LOCK_REASONS.HOME_UNRESOLVED);
    }
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      const attempt = writeExclusiveLock(path);
      if (attempt.ok === true) {
        ownsLock = true;
        state = { status: INSTANCE_LOCK_STATES.ACQUIRED, adopted: false };
        return state;
      }
      if (attempt.reason !== "exists") {
        ownsLock = false;
        return unavailableState(INSTANCE_LOCK_REASONS.WRITE_FAILED);
      }
      const current = readLockFile(path);
      if (current.kind === "absent") {
        // 释放竞态：文件在「创建失败」与「读取」之间被持有者删掉了。再抢一次（不涉及任何接管）。
        continue;
      }
      ownsLock = false;
      if (current.kind === "unreadable") return unavailableState(INSTANCE_LOCK_REASONS.UNREADABLE);
      if (current.kind === "malformed") return unavailableState(INSTANCE_LOCK_REASONS.MALFORMED);
      const verdict = evaluateInstanceLock(current.record, { pid, startedAt, token, toleranceMs, isProcessAlive });
      if (verdict.status === INSTANCE_LOCK_STATES.ACQUIRED) {
        ownsLock = true;
        state = verdict;
        return state;
      }
      if (verdict.status === INSTANCE_LOCK_STATES.UNAVAILABLE) {
        // 记录能解析但字段不全：同样按「不可用」处理，绝不把它当成别人的锁去猜。
        ownsLock = false;
        return unavailableState(verdict.reason ?? INSTANCE_LOCK_REASONS.MALFORMED);
      }
      if (verdict.reason === INSTANCE_LOCK_REASONS.STALE) {
        // pid 已死：这是唯一允许自动接管的现场（宿主单实例保证，见模块头注释）。
        ownsLock = false;
        return takeOver(path, current.text);
      }
      // 对方的 pid 仍存活：pid 可能只是被复用。只有「跨启动会话证明」成立时才按 stale 接管，
      // 否则一律 held——证明不了写锁进程属于上一个启动会话，就不能动别人的锁。
      // 存活探针抛错时 verdict.aliveUnknown 为真：连「对方是否存活」都证明不了，绝不取证。
      if (verdict.aliveUnknown === true) {
        return heldState(verdict.reason, verdict.holder === undefined ? {} : { holder: verdict.holder });
      }
      const preBoot = readPreBootVerdict(path, current.record);
      if (preBoot.stale === true) {
        const takeover = takeOver(path, current.text);
        if (takeover.status === INSTANCE_LOCK_STATES.ACQUIRED) {
          // adopted 语义不变（仍是新建自己的锁），只额外记录接管依据供诊断。
          state = { ...takeover, recoveredBy: PRE_BOOT_EVIDENCE };
        }
        return state;
      }
      // 没有 pre-boot 证据：原因码与锁路径都带回给诊断。
      return heldState(verdict.reason, verdict.holder === undefined ? {} : { holder: verdict.holder });
    }
    // 反复撞上「创建时存在、读时又消失」的抖动：保守不可用，绝不循环重试。
    ownsLock = false;
    return unavailableState(INSTANCE_LOCK_REASONS.WRITE_FAILED);
  }

  /**
   * 作业前复核：锁文件内容必须仍是本进程的 token。
   *
   * 任何不一致（文件消失、换成别人的锁、读不出来）都视为**丢失锁**：返回
   * `{ok:false, reason:"instance-lock-lost"}` 并锁死本实例的锁能力，调用方据此 fail-closed。
   *
   * @returns {{ok: boolean, reason?: string}} 复核结论。
   */
  function verifyOwnership() {
    if (lostReason !== null) return { ok: false, reason: INSTANCE_LOCK_REASONS.LOCK_LOST };
    if (!ownsLock) return { ok: false, reason: INSTANCE_LOCK_REASONS.NOT_HELD };
    let path;
    try {
      path = lockFilePath();
    } catch {
      return markLost();
    }
    const current = readLockFile(path);
    if (current.kind !== "record") return markLost();
    const record = current.record;
    const mine = record.token === token
      && record.pid === pid
      && Number.isFinite(record.startedAt)
      && Math.abs(record.startedAt - startedAt) <= toleranceMs;
    return mine ? { ok: true } : markLost();
  }

  /**
   * 释放锁：只有确认仍属于本进程（token + pid + 启动时间）时才删除文件。
   *
   * 三种结论（**结构性区分**，调用方据此决定诊断）：
   * - `{released:true}`：自己的锁已删除；
   * - `{released:false, reason:"not-held"}`：锁文件不存在 / 内容不是本进程的（本来就没持有）；
   * - `{released:false, reason:"release-failed"}`：读文件抛错、或 unlink 抛错（ENOENT 除外）
   *   ——**锁可能还在**，属于故障而非「没持有」。
   *
   * @returns {{released: boolean, reason?: string}} 释放结论。
   */
  function release() {
    if (!ownsLock) return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.NOT_HELD };
    ownsLock = false;
    let path;
    try {
      path = lockFilePath();
    } catch {
      // 连路径都拼不出来（home 在运行期变得不可解析）：这是故障，不是「没持有」。
      return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.RELEASE_FAILED };
    }
    // readLockFile 自己把「读抛错」折成 unreadable（ENOENT 折成 absent），两者结论不同。
    const current = readLockFile(path);
    if (current.kind === "unreadable") {
      return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.RELEASE_FAILED };
    }
    if (current.kind !== "record") {
      return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.NOT_HELD };
    }
    const record = current.record;
    const mine = record.token === token
      && record.pid === pid
      && Number.isFinite(record.startedAt)
      && Math.abs(record.startedAt - startedAt) <= toleranceMs;
    if (!mine) return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.NOT_HELD };
    try {
      io.unlink(path);
      return { released: true };
    } catch (error) {
      // 文件在复核与删除之间被别人删掉了：本进程没有「释放失败」，只是本来就不再持有。
      if (error?.code === "ENOENT") {
        return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.NOT_HELD };
      }
      return { released: false, reason: INSTANCE_LOCK_RELEASE_REASONS.RELEASE_FAILED };
    }
  }

  return Object.freeze({
    /** 锁文件绝对路径（诊断用；home 未解析时返回 undefined）。 */
    path: readableLockPath,
    acquire,
    verifyOwnership,
    release,
    /** 最近一次判定的只读快照（供启动探测消费；不可用结论里带 lockPath）。 */
    snapshot: () => ({ ...state }),
  });
}
