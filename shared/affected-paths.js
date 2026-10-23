/**
 * 受影响范围归一与重叠检测。
 *
 * 专家任务声明的 affectedPaths 归一（file/dir/symbol 前缀、工作区相对路径）与跨任务重叠判定。
 * 本文件由原 `shared.js` 的 833–1006 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/affected-paths
 */

/**
 * 归一化专家任务声明的影响范围。未带类型前缀的字符串按路径处理，末尾斜杠
 * 明确表示目录；file:/dir:/directory:/symbol: 前缀可消除歧义。路径统一使用
 * 小写正斜杠，符号保留大小写，避免把大小写敏感语言的不同符号误判为相同范围。
 * @param {unknown} affectedPaths - 工具输入的字符串数组。
 * @returns {Array<{kind:"path"|"file"|"directory"|"symbol", value:string}>} 去重后的范围。
 */
export function normalizeAffectedPaths(affectedPaths) {
  if (!Array.isArray(affectedPaths)) return [];
  const result = [];
  const seen = new Set();
  for (const item of affectedPaths) {
    if (typeof item !== "string") continue;
    const raw = item.normalize("NFKC").trim();
    if (raw.length === 0) continue;
    const typed = /^(file|dir|directory|symbol)\s*:(.*)$/i.exec(raw);
    const type = typed?.[1]?.toLowerCase();
    if (type === "symbol") {
      const value = String(typed?.[2] ?? "").trim();
      if (value.length === 0) continue;
      const entry = { kind: "symbol", value };
      const key = `${entry.kind}:${entry.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
      continue;
    }
    const hadTrailingSlash = /[\\/]$/.test(raw);
    let value = String(typed?.[2] ?? raw)
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");
    while (value.startsWith("./")) value = value.slice(2);
    value = value.replace(/\/+$/, "").toLowerCase();
    if (value.length === 0) continue;
    const entry = {
      kind: type === "file" ? "file" : type === "dir" || type === "directory" || hadTrailingSlash ? "directory" : "path",
      value,
    };
    const key = `${entry.kind}:${entry.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function canonicalWorkspacePath(value) {
  if (typeof value !== "string") return "";
  let raw = value.normalize("NFKC").trim().replace(/\\/g, "/");
  if (raw.length === 0) return "";
  const unc = raw.startsWith("//");
  raw = raw.replace(/\/{2,}/g, "/");
  let prefix = "";
  let rest = raw;
  let absolute = false;
  const drive = /^([A-Za-z]):\//.exec(raw);
  if (drive !== null) {
    prefix = drive[1].toLowerCase() + ":/";
    rest = raw.slice(3);
    absolute = true;
  } else if (unc) {
    prefix = "//";
    rest = raw.replace(/^\/+/, "");
    absolute = true;
  } else if (raw.startsWith("/")) {
    prefix = "/";
    rest = raw.replace(/^\/+/, "");
    absolute = true;
  }
  const segments = [];
  for (const segment of rest.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  const joined = segments.join("/");
  if (prefix === "/") return joined.length > 0 ? "/" + joined : "/";
  if (prefix === "//") return joined.length > 0 ? "//" + joined : "//";
  if (prefix.length > 0) return prefix + joined;
  return joined.length > 0 ? joined : ".";
}

/**
 * 将路径统一到可选 workspace root 下的稳定形式。相对路径只在传入 workspaceRoot
 * 时解析，绝不读取 process.cwd；绝对路径直接规范化。Windows 分隔符、大小写、
 * 重复分隔符和 . / .. 片段使用同一规则处理，便于 root 与专家声明相互比较。
 * @param {unknown} value - 文件或目录路径。
 * @param {unknown} workspaceRoot - 可选稳定工作区根目录。
 * @returns {string} 规范化后的路径；非法/空输入返回空字符串。
 */
export function normalizeWorkspacePath(value, workspaceRoot) {
  if (typeof value !== "string") return "";
  const path = value.normalize("NFKC").trim().replace(/\\/g, "/");
  if (path.length === 0) return "";
  const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
  if (absolute || typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    return canonicalWorkspacePath(path);
  }
  const root = canonicalWorkspacePath(workspaceRoot);
  return canonicalWorkspacePath(root.length === 0 || root === "." ? path : root + "/" + path);
}

/**
 * 统一一组专家影响范围；除字符串外也接受 tracker 快照中的已归一化范围对象，
 * 这样 root guard 可在不改变既有 tracker API 的前提下重新绑定 workspace root。
 * symbol 不做路径解析，只保持原有精确相等语义。
 * @param {unknown} affectedPaths - 字符串或 {kind,value} 范围数组。
 * @param {unknown} workspaceRoot - 可选稳定工作区根目录。
 * @returns {Array<{kind:string,value:string}>} 统一后的范围。
 */
export function normalizeAffectedPathsForWorkspace(affectedPaths, workspaceRoot) {
  if (!Array.isArray(affectedPaths)) return [];
  const raw = [];
  for (const item of affectedPaths) {
    if (typeof item === "string") {
      raw.push(item);
      continue;
    }
    if (item === null || typeof item !== "object" || typeof item.value !== "string") continue;
    if (item.kind === "symbol") raw.push("symbol:" + item.value);
    else if (item.kind === "file") raw.push("file:" + item.value);
    else if (item.kind === "directory") raw.push("dir:" + item.value);
    else raw.push(item.value);
  }
  return normalizeAffectedPaths(raw).map((entry) => entry.kind === "symbol"
    ? entry
    : { ...entry, value: normalizeWorkspacePath(entry.value, workspaceRoot) },
  ).filter((entry) => entry.value.length > 0);
}

/**
 * 判断两个已归一化影响范围是否相交。符号只在完全相同时相交；文件不会被
 * 当作祖先，目录和未显式标记类型的路径则会与其后代相交。
 * @param {object} left - normalizeAffectedPaths 返回的单个范围。
 * @param {object} right - normalizeAffectedPaths 返回的单个范围。
 * @returns {boolean} 存在相交范围返回 true。
 */
export function affectedPathEntriesOverlap(left, right) {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false;
  if (typeof left.value !== "string" || typeof right.value !== "string") return false;
  if (left.kind === "symbol" || right.kind === "symbol") {
    return left.kind === "symbol" && right.kind === "symbol" && left.value === right.value;
  }
  if (left.value === right.value) return true;
  if (left.value.startsWith(`${right.value}/`)) return right.kind !== "file";
  if (right.value.startsWith(`${left.value}/`)) return left.kind !== "file";
  return false;
}

/**
 * 返回两组影响范围的全部交集对，供活动任务登记和单元测试复用。
 * @param {unknown} left - 第一组范围。
 * @param {unknown} right - 第二组范围。
 * @returns {Array<{left:object, right:object}>} 每一项是一对相交范围。
 */
export function findAffectedPathOverlaps(left, right) {
  const leftEntries = normalizeAffectedPaths(left);
  const rightEntries = normalizeAffectedPaths(right);
  const overlaps = [];
  for (const leftEntry of leftEntries) {
    for (const rightEntry of rightEntries) {
      if (affectedPathEntriesOverlap(leftEntry, rightEntry)) overlaps.push({ left: leftEntry, right: rightEntry });
    }
  }
  return overlaps;
}
