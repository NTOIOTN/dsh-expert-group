/**
 * 会话删除隔离区（票据 01，票据 02 补两个同级操作，票据 03 补收尾）：解析隔离根、
 * 按会话 ID 建目录、同卷判定、原子改名，以及竞态回位、空目录复原与收敛期收尾。
 *
 * ## 布局与位置
 * 隔离根固定在 DSH home 下（`<DSH home>/session-delete-quarantine`），每个会话一个目录：
 * `<隔离根>/<会话 ID 的编码段>/`。会话 ID 一律走 `encodePathSegment`，因此非法 ID
 * （含 `../`、绝对路径、NUL）永远不会逃出隔离根。
 *
 * ## 为什么改名必须能被识别为「跨卷失败」
 * 宿主可能把 `$DSH_HOME` 配到另一个卷，而会话根仍在原卷：此时 `rename(2)` 直接报
 * `EXDEV`。删除作业的语义是「没有任何可见变动」（规格决策 11 的 S4），所以跨卷不是
 * 「尽力而为」，而是必须先判定再失败的确定结果。这里提供两级识别：
 * 1. 改名前的同卷预判（比较 `stat.dev`，Windows 上是卷序列号）；
 * 2. 改名时捕获 `EXDEV`（预判未知时仍能识别）。
 *
 * ## 端口注入
 * 文件系统操作以 `io` 注入（默认 node:fs 的同步实现）：测试用「抛 EXDEV 的 rename」或
 * 「dev 不同的 stat」模拟跨卷，而不必真的准备第二个卷。
 *
 * @module dsh-expert-group/host/session-delete-quarantine
 */
import { basename, dirname, join } from "node:path";
import { mkdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { encodePathSegment } from "./session-delete-paths.js";

/** 隔离根目录名（在 DSH home 下）。 */
export const QUARANTINE_ROOT_DIR_NAME = "session-delete-quarantine";

/** 隔离操作的稳定失败原因码（可展示、可断言）。 */
export const QUARANTINE_FAILURES = Object.freeze({
  /** 源日志不存在：调用方应走 absent 路径，而不是把它当成改名失败。 */
  SOURCE_MISSING: "quarantine-source-missing",
  /** 源日志存在但读不到（权限/IO）。 */
  SOURCE_UNREADABLE: "quarantine-source-unreadable",
  /** 建会话隔离目录失败。 */
  MKDIR_FAILED: "quarantine-mkdir-failed",
  /** 源与隔离区不在同一个卷：改名必然失败，且不允许留下任何变动。 */
  CROSS_VOLUME: "quarantine-cross-volume",
  /** 其他改名失败（占用、权限、目标已存在等）。 */
  RENAME_FAILED: "quarantine-rename-failed",
  /**
   * 回位时原路径已被新日志占用（票据 02 的 S5 竞态）。
   *
   * 这是**预期结局**而不是故障：会话在改名之后被重新打开，宿主在原路径写了新日志。
   * 此时绝不能回位——POSIX 的 rename(2) 会静默覆盖目标，把用户的新内容删掉。
   */
  RESTORE_OCCUPIED: "quarantine-restore-occupied",
});

/** 默认文件系统端口（生产实现）。 */
const DEFAULT_IO = Object.freeze({
  stat: statSync,
  mkdir: mkdirSync,
  rename: renameSync,
  rmdir: rmdirSync,
  // 票据 03：收敛期的收尾要删掉整个会话隔离目录（含文件），因此需要 rm。
  rm: rmSync,
});

/**
 * 计算隔离根绝对路径。
 *
 * @param {string} homeDirectory - DSH home 绝对路径。
 * @returns {string} `<home>/session-delete-quarantine`。
 * @throws {Error} home 不是非空字符串。
 */
export function quarantineRootPath(homeDirectory) {
  if (typeof homeDirectory !== "string" || homeDirectory.length === 0) {
    throw new Error("dsh home is required to resolve the quarantine root");
  }
  return join(homeDirectory, QUARANTINE_ROOT_DIR_NAME);
}

/**
 * 计算某个会话的隔离目录（会话 ID 编码成单个安全路径段）。
 *
 * @param {string} root - 隔离根。
 * @param {string} sessionId - 会话 ID（非空）。
 * @returns {string} `<root>/<encoded id>`。
 * @throws {Error} 隔离根缺失或会话 ID 为空。
 */
export function sessionQuarantineDirectory(root, sessionId) {
  if (typeof root !== "string" || root.length === 0) throw new Error("quarantine root is required");
  return join(root, encodePathSegment(sessionId));
}

/**
 * 查询某个会话的隔离目录是否存在（闸门的第一条判据）。
 *
 * 读取失败（非 ENOENT）**保守算作存在**：宁可拒绝一次新的删除作业，也不能在无法证明
 * 「上一代隔离文件已收尾」的情况下覆盖它。
 *
 * @param {string} root - 隔离根。
 * @param {string} sessionId - 会话 ID。
 * @param {object} [io] - 文件系统端口（`stat`）。
 * @returns {{exists: boolean, directory: string, degraded?: boolean}} 查询结果。
 */
export function sessionQuarantineExists(root, sessionId, io = DEFAULT_IO) {
  const directory = sessionQuarantineDirectory(root, sessionId);
  try {
    io.stat(directory);
    return { exists: true, directory };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { exists: false, directory };
    return { exists: true, directory, degraded: true };
  }
}

/**
 * 读取路径所在卷标识（`stat.dev`）。无法判定时返回 `{known:false}`。
 *
 * @param {string} targetPath - 任意已存在路径。
 * @param {object} [io] - 文件系统端口（`stat`）。
 * @returns {{known: boolean, device?: unknown}} 卷标识。
 */
export function volumeIdentityOf(targetPath, io = DEFAULT_IO) {
  try {
    const stats = io.stat(targetPath);
    if (stats === null || typeof stats !== "object" || stats.dev === undefined) return { known: false };
    return { known: true, device: stats.dev };
  } catch {
    return { known: false };
  }
}

/**
 * 判定两个路径是否在同一卷。
 *
 * 返回 `determined:false` 表示无法判定（路径不存在、平台不给 dev），此时**不得**据此
 * 拒绝改名：交给真正的 `rename` 去失败，并靠 `EXDEV` 分类。
 *
 * @param {string} leftPath - 左路径（通常是源日志）。
 * @param {string} rightPath - 右路径（通常是隔离目录）。
 * @param {object} [io] - 文件系统端口（`stat`）。
 * @returns {{determined: boolean, sameVolume?: boolean}} 判定结果。
 */
export function compareVolumes(leftPath, rightPath, io = DEFAULT_IO) {
  const left = volumeIdentityOf(leftPath, io);
  const right = volumeIdentityOf(rightPath, io);
  if (left.known !== true || right.known !== true) return { determined: false };
  return { determined: true, sameVolume: left.device === right.device };
}

/**
 * 把会话日志原子改名进隔离区（`<隔离根>/<会话 ID>/<原文件名>.<时间戳>`）。
 *
 * 顺序刻意固定：先证明源存在 → 建会话目录 → 同卷预判 → 改名。任何一步失败都**不留下
 * 可见变动**（源文件原地不动）；改名本身是单文件操作，不存在「删了一半」的中间态。
 *
 * @param {object} params
 * @param {string} params.sessionDirectory - 该会话的隔离目录（绝对路径）。
 * @param {string} params.sourcePath - 原始会话日志的绝对路径。
 * @param {number} params.timestamp - 改名时间戳（毫秒，非负有限数）。
 * @param {object} [params.io] - 文件系统端口（`stat` / `mkdir` / `rename`）。
 * @returns {{ok: true, sourcePath: string, targetPath: string}|{ok: false, reason: string}}
 *   成功返回目标路径，失败返回稳定原因码。
 */
export function renameSessionLogIntoQuarantine({ sessionDirectory, sourcePath, timestamp, io = DEFAULT_IO }) {
  if (typeof sessionDirectory !== "string" || sessionDirectory.length === 0) {
    return { ok: false, reason: QUARANTINE_FAILURES.MKDIR_FAILED };
  }
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return { ok: false, reason: QUARANTINE_FAILURES.SOURCE_MISSING };
  }
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return { ok: false, reason: QUARANTINE_FAILURES.RENAME_FAILED };
  }
  try {
    io.stat(sourcePath);
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return { ok: false, reason: missing ? QUARANTINE_FAILURES.SOURCE_MISSING : QUARANTINE_FAILURES.SOURCE_UNREADABLE };
  }
  try {
    io.mkdir(sessionDirectory, { recursive: true });
  } catch {
    return { ok: false, reason: QUARANTINE_FAILURES.MKDIR_FAILED };
  }
  const volumes = compareVolumes(sourcePath, sessionDirectory, io);
  if (volumes.determined === true && volumes.sameVolume !== true) {
    return { ok: false, reason: QUARANTINE_FAILURES.CROSS_VOLUME };
  }
  const targetPath = join(sessionDirectory, basename(sourcePath) + "." + Math.floor(timestamp));
  try {
    io.rename(sourcePath, targetPath);
  } catch (error) {
    // EXDEV 是跨卷的唯一可靠证据：预判可能因为路径还不存在而未知，改名失败则一定可见。
    return {
      ok: false,
      reason: error?.code === "EXDEV" ? QUARANTINE_FAILURES.CROSS_VOLUME : QUARANTINE_FAILURES.RENAME_FAILED,
    };
  }
  return { ok: true, sourcePath, targetPath };
}


/**
 * 把隔离区里的会话日志改名回原路径（票据 02 的 S5 竞态回位）。
 *
 * ## 为什么必须先 stat 原路径
 * POSIX 的 `rename(2)` **会静默覆盖**已存在的目标；Windows 才会以 EEXIST/EPERM 失败。
 * 竞态场景下原路径上很可能是宿主刚写入的**新一代日志**，直接 rename 会把用户的新内容删掉。
 * 因此回位前先确认原路径不存在：存在即返回 {@link QUARANTINE_FAILURES.RESTORE_OCCUPIED}，
 * 两份文件都保留（调用方按 raced 处理并记诊断），交给收敛期按「日志仍存在」分支收尾。
 *
 * ## 其余失败都按「回位失败」返回，不尝试补救
 * 隔离文件已不存在（{@link QUARANTINE_FAILURES.SOURCE_MISSING}）或改名本身失败时，
 * 作业期不做任何进一步动作：条目状态已推进到 `race`（或仍是 `intent`），收敛期按
 * 「日志是否存在」继续处理，两份文件都不会丢。
 *
 * @param {object} params
 * @param {string} params.targetPath - 隔离区里的文件名（rename 时返回的目标路径）。
 * @param {string} params.sourcePath - 原始会话日志路径。
 * @param {object} [params.io] - 文件系统端口（`stat` / `mkdir` / `rename`）。
 * @returns {{ok: true, restoredPath: string}|{ok: false, reason: string}} 回位结果。
 */
export function restoreSessionLogFromQuarantine({ targetPath, sourcePath, io = DEFAULT_IO }) {
  if (typeof targetPath !== "string" || targetPath.length === 0) {
    return { ok: false, reason: QUARANTINE_FAILURES.SOURCE_MISSING };
  }
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    return { ok: false, reason: QUARANTINE_FAILURES.RENAME_FAILED };
  }
  // 原路径已被新日志占用：这是预期结局，绝不覆盖。
  try {
    io.stat(sourcePath);
    return { ok: false, reason: QUARANTINE_FAILURES.RESTORE_OCCUPIED };
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    if (!missing) return { ok: false, reason: QUARANTINE_FAILURES.SOURCE_UNREADABLE };
  }
  try {
    io.stat(targetPath);
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return {
      ok: false,
      reason: missing ? QUARANTINE_FAILURES.SOURCE_MISSING : QUARANTINE_FAILURES.SOURCE_UNREADABLE,
    };
  }
  // 原路径的父目录理论上还在（改名只动了文件），重建它对残缺目录布局是无害的兜底。
  try {
    io.mkdir(dirname(sourcePath), { recursive: true });
  } catch {
    return { ok: false, reason: QUARANTINE_FAILURES.MKDIR_FAILED };
  }
  try {
    io.rename(targetPath, sourcePath);
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === "EXDEV" ? QUARANTINE_FAILURES.CROSS_VOLUME : QUARANTINE_FAILURES.RENAME_FAILED,
    };
  }
  return { ok: true, restoredPath: sourcePath };
}

/**
 * 删除某个会话的**空**隔离目录（作业期改名失败后的复原动作）。
 *
 * 只在「会话作业刚开始、S0 闸门已证明该目录不存在」之后失败时使用：那时目录是本次
 * `renameSessionLogIntoQuarantine` 的 `mkdir` 刚建出来的空壳，留着只会让下一次作业被
 * 自己的 S0 闸门挡成 `pending-cleanup`。非空目录（ENOTEMPTY）不会被删除——目录里有文件
 * 就说明它不是本次失败留下的空壳，必须原样交给收敛期。
 *
 * 收尾整个目录（含文件）属于收敛期（票据 03），本函数刻意**不**做递归删除。
 *
 * @param {string} root - 隔离根。
 * @param {string} sessionId - 会话 ID。
 * @param {object} [io] - 文件系统端口（`rmdir`）。
 * @returns {{removed: boolean, skipped?: string}} 结果；目录不空或不存在都按 `removed:false`。
 */
export function removeEmptySessionQuarantineDirectory(root, sessionId, io = DEFAULT_IO) {
  let directory;
  try {
    directory = sessionQuarantineDirectory(root, sessionId);
  } catch {
    return { removed: false, skipped: "path-unresolved" };
  }
  try {
    io.rmdir(directory);
    return { removed: true };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { removed: false, skipped: "missing" };
    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return { removed: false, skipped: "not-empty" };
    return { removed: false, skipped: "failed" };
  }
}


/**
 * 删除某个会话的**整个**隔离目录（收敛期的收尾动作，票据 03 · 规格决策 9/14/16）。
 *
 * 隔离区布局是「一个会话一个目录」，因此收尾就是删掉 *<隔离根>/<会话 ID>/* 整个目录：
 * - **缺失即成功**（幂等）：目录不在意味着上一轮收敛已经收尾过，或者这份条目从来没搬过文件；
 * - **不按前缀通配、不跨会话目录**：只拼本次条目对应的会话目录，路径段由
 *   `sessionQuarantineDirectory` 的编码保证不越界；
 * - **这里是唯一的隔离文件收尾步骤**：两类分支（完整清理 / 只收尾）共用它，不存在第二份
 *   处理不同文件集合的实现。
 *
 * 与 `removeEmptySessionQuarantineDirectory` 的分工：那个只删**空**目录（作业期改名失败后的
 * 复原），非空一律不动；本函数是真收尾，目录里有旧代际日志也要一起删掉——否则日志仍存在
 * 的收敛分支会留下无人引用的磁盘残留（决策 14 的「隔离文件的终态」）。
 *
 * @param {string} root - 隔离根。
 * @param {string} sessionId - 会话 ID。
 * @param {object} [io] - 文件系统端口（`rm`）。
 * @returns {{settled: boolean, reason?: string}} 收尾结果；`settled:false` 表示需要转残渣并保留条目。
 */
export function discardSessionQuarantineDirectory(root, sessionId, io = DEFAULT_IO) {
  let directory;
  try {
    directory = sessionQuarantineDirectory(root, sessionId);
  } catch {
    // 路径拼不出来（隔离根缺失或会话 ID 为空）：不猜路径，按失败处理让收敛保留条目。
    return { settled: false, reason: "path-unresolved" };
  }
  try {
    io.rm(directory, { recursive: true, force: true });
    return { settled: true };
  } catch (error) {
    // force 理论上吞掉 ENOENT；自定义端口仍可能抛它——两种都按「已收尾」处理。
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { settled: true };
    return { settled: false, reason: "failed" };
  }
}
