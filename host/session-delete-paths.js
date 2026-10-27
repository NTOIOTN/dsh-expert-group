/**
 * 会话日志定位（票据 01）：复刻宿主 `dsh-session-persistence-jsonl` 的目录命名规则，
 * 并把「会话 ID + header」解析成绝对会话目录与其中的日志文件。
 *
 * ## 为什么复刻宿主内部布局
 * 宿主没有公开「会话日志路径」查询：`sessionPersistence` 的公开 seam 只有
 * create/open/stat/list/flush，`locate(header)` 是 jsonl 后端私有扩展。删除必须把日志
 * **原子改名**，因此只能走两级策略（规格决策 34）：优先 `locate`（鸭子类型，缺失不报错），
 * 否则复刻目录命名并做两项校验（目录内确有会话日志、目录名与 id 编码一致）。
 *
 * ## 复刻口径（与宿主 `projectKey` / `encodeSegment` 逐条一致）
 * - 安全码元：`[A-Za-z0-9._-]`；其余码元（含 `~`）一律编码成 `~XXXX`（**大写** 4 位
 *   UTF-16 码元十六进制）。宿主按码元而非码点处理，因此孤立代理项也能无损编码；
 * - 会话 ID 段：`.` / `..` 特殊处理为 `~002E` / `~002E~002E`，空串非法；
 * - 项目目录名：`/`、`\\`、`:` 视作分隔符统一变成 `-` 且**连续分隔符合并**；首部 `-` 剥离；
 *   结果为空时回落 `root`；正文截断到 **251** 字符（加上 `--` 前缀/后缀正好 255 的文件名上限）；
 *   目录形如 `--<body>--`；
 * - 没有 cwd 的会话落在 `_no-cwd` 项目目录。
 *
 * ## 日志文件名刻意不复刻
 * 日志文件名带格式代次与压缩后缀（当前是 `session.v4.jsonl.zstd`，历史代次可能是
 * `session.v3.jsonl` 或未压缩的 `session.jsonl`）。复刻文件名会把「宿主升级格式」变成
 * 删除能力的硬依赖，所以定位只解析到**会话目录**，再列目录取匹配 `session*.jsonl*` 的文件。
 *
 * @module dsh-expert-group/host/session-delete-paths
 */
import { dirname, isAbsolute, join } from "node:path";
import { readdir } from "node:fs/promises";

/** 无 cwd 的会话所在项目目录名（与宿主 `projectDir` 一致）。 */
const NO_CWD_PROJECT_DIRECTORY = "_no-cwd";

/** 项目目录名正文的最大长度：`--` + 251 + `--` = 255（常见文件名字节上限）。 */
const MAX_PROJECT_DIRECTORY_BODY = 251;

/** 单个安全码元：除 `~` 之外的 ASCII 字母数字与 `._-`。 */
const SAFE_SEGMENT_CODE_UNIT = /^[A-Za-z0-9._-]$/u;

/**
 * 日志文件名匹配：宿主各代次都叫 `session[.vN].jsonl[.zstd]`。
 *
 * 刻意放宽成「以 session 开头、含 .jsonl、可带后缀」：格式代次与压缩算法属于宿主内部细节，
 * 删除只需要「目录里确实有日志」这一事实。隐藏文件（`.` 开头）与目录不会被误命中。
 */
const SESSION_LOG_FILE_NAME = /^session[^/\\]*\.jsonl(?:\..+)?$/iu;

/** 带格式代次的日志文件名：`session.v4.jsonl.zstd`；无代次的旧名字按 0 计。 */
const SESSION_LOG_VERSION = /^session(?:\.v(\d+))?\.jsonl(?:\..+)?$/iu;

/**
 * 日志定位的稳定失败原因码（可展示、可断言，不含任何路径细节）。
 */
export const SESSION_LOG_RESOLVE_FAILURES = Object.freeze({
  /** header 自身不可用：没有非空 id，或 cwd 不是字符串。 */
  INVALID_HEADER: "session-log-invalid-header",
  /** 连会话根都没解析出来（调用方负责给出 dshHomePath('sessions')）。 */
  ROOT_UNRESOLVED: "session-log-root-unresolved",
  /** 目标会话目录不存在。 */
  DIRECTORY_MISSING: "session-log-directory-missing",
  /** 目录存在但没有任何会话日志文件。 */
  LOG_MISSING: "session-log-missing",
  /** 目录名与「会话 ID 的编码段」不一致：说明这份目录不属于这个 ID（归属校验失败）。 */
  SEGMENT_MISMATCH: "session-log-segment-mismatch",
  /** 列目录失败（权限、IO 等非 ENOENT 错误）。 */
  LIST_FAILED: "session-log-list-failed",
});

/**
 * 把任意字符串编码成单个安全路径段（宿主 `encodeSegment` 的等价实现）。
 *
 * @param {string} raw - 待编码字符串（非空）。
 * @returns {string} 安全路径段。
 * @throws {Error} 空串（与宿主一致：空串无法成为路径段）。
 */
export function encodePathSegment(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("cannot encode an empty path segment");
  }
  // `.` / `..` 整段特殊处理：它们是路径穿越语义，必须比「安全码元」规则更严格。
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== "~" && SAFE_SEGMENT_CODE_UNIT.test(character)) encoded += character;
    else encoded += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return encoded;
}

/**
 * 把会话 cwd 编码成项目目录名（宿主 `projectKey` 的等价实现）。
 *
 * @param {string|undefined} cwd - 会话 header 的 cwd；`undefined` 表示没有 cwd。
 * @returns {string} 形如 `--<body>--` 的项目目录名，或 `_no-cwd`。
 * @throws {Error} cwd 为空串（宿主同样拒绝）。
 */
export function projectDirectoryName(cwd) {
  if (cwd === undefined) return NO_CWD_PROJECT_DIRECTORY;
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  // 连续分隔符只产出一个 `-`：Windows 的 `C:\\a` 与 POSIX 的 `/a` 都收敛成同一个可读名字。
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    if (character !== "~" && SAFE_SEGMENT_CODE_UNIT.test(character)) readable += character;
    else readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  const body = readable.replace(/^-+/u, "") || "root";
  return "--" + body.slice(0, MAX_PROJECT_DIRECTORY_BODY) + "--";
}

/**
 * 会话日志所在目录（宿主 `sessionDir` 的等价实现）。
 *
 * @param {string} sessionsRoot - 会话根目录（`dshHomePath('sessions')`）。
 * @param {string|undefined} cwd - 会话 cwd。
 * @param {string} sessionId - 会话 ID。
 * @returns {string} 绝对会话目录。
 */
export function sessionLogDirectory(sessionsRoot, cwd, sessionId) {
  if (typeof sessionsRoot !== "string" || sessionsRoot.length === 0 || !isAbsolute(sessionsRoot)) {
    throw new Error("sessions root must be an absolute path");
  }
  return join(sessionsRoot, projectDirectoryName(cwd), encodePathSegment(sessionId));
}

/**
 * 解析日志文件名的格式代次（无代次按 0；非日志名返回 -1）。
 *
 * @param {string} name - 目录项名。
 * @returns {number} 代次或 -1。
 */
export function sessionLogVersionOf(name) {
  const match = typeof name === "string" ? SESSION_LOG_VERSION.exec(name) : null;
  if (match === null) return -1;
  return match[1] === undefined ? 0 : Number(match[1]);
}

/**
 * 从目录项里筛出会话日志文件，并按「代次降序、同名升序」稳定排序。
 *
 * @param {Iterable<string>} names - 目录项名。
 * @returns {string[]} 匹配到的文件名（不含路径）。
 */
export function matchSessionLogFiles(names) {
  const files = [];
  for (const name of names ?? []) {
    if (typeof name !== "string") continue;
    if (!SESSION_LOG_FILE_NAME.test(name)) continue;
    files.push(name);
  }
  return files.sort((left, right) => {
    const delta = sessionLogVersionOf(right) - sessionLogVersionOf(left);
    return delta !== 0 ? delta : (left < right ? -1 : left > right ? 1 : 0);
  });
}

/**
 * 校验一个候选会话目录并列出其中的日志文件（两项校验的唯一实现）。
 *
 * @param {string} directory - 候选会话目录（绝对路径）。
 * @param {string} sessionId - 会话 ID（用于归属校验）。
 * @param {"locate"|"encoded"} source - 目录来源（诊断用）。
 * @param {(directory: string) => Promise<string[]>} listDirectory - 列目录端口。
 * @returns {Promise<object>} 成功 `{ok:true, directory, source, files, names}`；失败 `{ok:false, reason, directory}`。
 */
async function inspectSessionDirectory(directory, sessionId, source, listDirectory) {
  let names;
  try {
    names = await listDirectory(directory);
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return {
      ok: false,
      reason: missing ? SESSION_LOG_RESOLVE_FAILURES.DIRECTORY_MISSING : SESSION_LOG_RESOLVE_FAILURES.LIST_FAILED,
      directory,
    };
  }
  const matched = matchSessionLogFiles(names);
  if (matched.length === 0) {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.LOG_MISSING, directory };
  }
  // 归属校验：目录名必须正好是会话 ID 的编码段。locate 给出的路径也要过这一关：它可能是
  // 旧布局或其他会话的目录，把别的会话目录当成这个会话的隔离源会造成跨会话搬家。
  const leaf = directory.split(/[\\/]+/u).filter((segment) => segment.length > 0).at(-1) ?? "";
  if (leaf !== encodePathSegment(sessionId)) {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.SEGMENT_MISMATCH, directory };
  }
  return {
    ok: true,
    directory,
    source,
    names: matched,
    files: matched.map((name) => join(directory, name)),
  };
}

/**
 * 解析会话日志位置（**永不抛错**，两级策略）。
 *
 * 1. 优先 `locate(header)`：仅当它是函数、返回 `{path}`（或字符串）且为绝对路径时使用；
 *    locate 缺失/抛出/给出非法路径都**不算失败**，静默退化到第二级；
 * 2. 复刻目录命名：`<sessionsRoot>/<projectDirectoryName(cwd)>/<encodePathSegment(id)>`。
 *
 * 两级都要求「目录内确有会话日志」与「目录名等于 id 的编码段」。
 *
 * @param {object} params
 * @param {Function|undefined} params.locate - 持久化后端的私有 `locate`（鸭子类型）。
 * @param {{id?: unknown, cwd?: unknown}} params.header - 会话 header（`sessionPersistence.list()` 的形状）。
 * @param {string|undefined} params.sessionsRoot - 会话根目录。
 * @param {(directory: string) => Promise<string[]>} [params.listDirectory] - 列目录端口（注入用）。
 * @returns {Promise<object>} 见 {@link inspectSessionDirectory}。
 */
export async function resolveSessionLogLocation({ locate, header, sessionsRoot, listDirectory = readdir }) {
  const sessionId = header !== null && typeof header === "object" && typeof header.id === "string"
    ? header.id
    : undefined;
  if (sessionId === undefined || sessionId.length === 0) {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.INVALID_HEADER };
  }
  if (header.cwd !== undefined && typeof header.cwd !== "string") {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.INVALID_HEADER };
  }
  if (typeof locate === "function") {
    let located;
    try {
      located = locate(header);
    } catch {
      // locate 是后端私有扩展：它抛错只意味着「这一级不可用」，不是定位失败。
      located = undefined;
    }
    const locatedPath = typeof located === "string" ? located : located?.path;
    if (typeof locatedPath === "string" && locatedPath.length > 0 && isAbsolute(locatedPath)) {
      const inspected = await inspectSessionDirectory(dirname(locatedPath), sessionId, "locate", listDirectory);
      // locate 给的是合法绝对路径但目录/日志对不上时直接失败：退回复刻只会掩盖后端与磁盘
      // 之间的不一致（例如后端指向了另一个根），那正是应该 fail-closed 的情形。
      return inspected;
    }
  }
  if (typeof sessionsRoot !== "string" || sessionsRoot.length === 0 || !isAbsolute(sessionsRoot)) {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.ROOT_UNRESOLVED };
  }
  let directory;
  try {
    directory = sessionLogDirectory(sessionsRoot, header.cwd, sessionId);
  } catch {
    return { ok: false, reason: SESSION_LOG_RESOLVE_FAILURES.INVALID_HEADER };
  }
  return inspectSessionDirectory(directory, sessionId, "encoded", listDirectory);
}
