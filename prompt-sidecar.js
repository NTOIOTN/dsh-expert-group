/**
 * Prompt Inspector sidecar writer/reader。
 * 只读 session.jsonl，完整 prompt 写入受控 UTF-8 分块；manifest 不保存 raw event 或 prompt。
 */
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildAgentTree,
  chunkUtf8,
  classifyTruncation,
  extractPromptRecords,
  hashUtf8,
  parseJsonlEvents,
  reassembleUtf8Chunks,
  utf8Length,
} from "./prompt-inspector.js";

export const SIDECAR_FORMAT = "dsh-prompt-sidecar-v1";
export const DEFAULT_MAX_BYTES = 1800;
const MANIFEST_NAME = "manifest.json";
const SAFE_FILE_NAME = /^[a-zA-Z0-9._-]+$/;
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|credential|encrypted|cipher|private|api.?key|access.?token|refresh.?token)/i;
const SENSITIVE_VALUE = /(?:authorization|cookie|password|secret|credential|encrypted|cipher|private|bearer|basic\s+|access.?token|refresh.?token|api.?key|\btoken\b|\bkey\b)/i;
const SAFE_DIAGNOSTIC_STRING = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_STRING_LENGTH = 256;

function asError(error, prefix) {
  if (error instanceof Error) return new Error(prefix + ": " + error.message, { cause: error });
  return new Error(prefix + ": " + String(error));
}

function ensureRelativeSafePath(root, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0 || isAbsolute(candidate)) {
    throw new Error("manifest 含有无效相对路径");
  }
  const target = resolve(root, candidate);
  const rootPath = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(rootPath)) throw new Error("manifest 路径越界");
  if (relative(root, target).split(sep).some((part) => part === "..")) throw new Error("manifest 路径含有 ..");
  return target;
}

function normalizeComparablePath(path) {
  const normalized = resolve(path).replace(/[\\/]+/g, "\\");
  return normalized.replace(/\\+$/, "").toLowerCase();
}

function pathsOverlap(left, right) {
  const a = normalizeComparablePath(left);
  const b = normalizeComparablePath(right);
  return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
}

async function pathKind(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function rejectSymlinkPath(path, label) {
  let current = resolve(path);
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      info = undefined;
    }
    if (info?.isSymbolicLink()) throw new Error(label + " 含有 symlink/junction: " + current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function rejectSymlinkTree(path, label) {
  await rejectSymlinkPath(path, label);
  let rootInfo;
  try {
    rootInfo = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!rootInfo.isDirectory()) return;
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(label + " 含有 symlink/junction: " + child);
      if (entry.isDirectory()) await walk(child);
    }
  };
  await walk(resolve(path));
}

async function canonicalComparablePath(path) {
  let current = resolve(path);
  const missing = [];
  while (true) {
    try {
      const canonical = await realpath(current);
      return normalizeComparablePath(join(canonical, ...missing.reverse()));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return normalizeComparablePath(path);
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function rejectOverlappingPaths(inputPath, outputPath) {
  // 先检查现有树及所有祖先；输出临时目录随后只会创建在已验证的父目录中。
  await rejectSymlinkTree(inputPath, "输入路径");
  await rejectSymlinkTree(outputPath, "输出路径");
  if ((await pathKind(outputPath)) !== "missing" && (await pathKind(outputPath)) !== "directory") {
    throw new Error("输出路径必须是目录");
  }
  const [inputCanonical, outputCanonical] = await Promise.all([
    canonicalComparablePath(inputPath),
    canonicalComparablePath(outputPath),
  ]);
  if (pathsOverlap(inputCanonical, outputCanonical)) {
    throw new Error("输入与输出路径重叠，已拒绝以保护原始 session/sidecar");
  }
}

async function resolveSidecarPaths(sidecarDirOrManifest) {
  const candidate = resolve(sidecarDirOrManifest);
  // lstat 之前先检查 candidate 本身和所有祖先，避免 stat 跟随 root/manifest symlink。
  await rejectSymlinkPath(candidate, "sidecar 根");
  let info;
  try {
    info = await lstat(candidate);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const root = info?.isDirectory() === true ? candidate : dirname(candidate);
  const manifestPath = info?.isDirectory() === true ? join(candidate, MANIFEST_NAME) : candidate;
  await rejectSymlinkPath(root, "sidecar 根");
  await rejectSymlinkPath(manifestPath, "sidecar manifest");
  return { root, manifestPath };
}

function safeSourceFile(root, file) {
  const value = relative(root, file).split(sep).join("/");
  assertSafeRelativeMetadataPath(value, "sourceFile");
  return value;
}

function assertSafeRelativeMetadataPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)
    || /^[a-zA-Z]:[\\/]/.test(value) || value.includes("\\")
    || value.split("/").some((part) => part === ".." || part.length === 0)) {
    throw new Error(label + " 不是规范相对路径");
  }
  return value;
}

async function collectSessionFiles(inputPath) {
  const input = resolve(inputPath);
  const inputStat = await lstat(input);
  if (inputStat.isSymbolicLink()) throw new Error("输入路径含有 symlink/junction: " + input);
  if (inputStat.isFile()) {
    return { root: dirname(input), files: [input] };
  }
  if (!inputStat.isDirectory()) throw new Error("输入路径不是文件或目录: " + input);
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("输入树含有 symlink/junction: " + child);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name === "session.jsonl") files.push(child);
    }
  };
  await walk(input);
  files.sort((left, right) => relative(input, left).localeCompare(relative(input, right)));
  return { root: input, files };
}

function stableRecordId(record, sourceFile, occurrence) {
  const seed = [sourceFile, record.kind, record.sessionId ?? "", record.lineNumber ?? "", occurrence, hashUtf8(record.text)].join("\0");
  return hashUtf8(seed).slice(0, 24);
}

function safeManifestValue(value) {
  if (typeof value === "string") {
    return SAFE_DIAGNOSTIC_STRING.test(value) && !SENSITIVE_VALUE.test(value) ? value : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  return undefined;
}

function safeManifestSeq(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function safeManifestTime(value) {
  return typeof value === "string" && SAFE_DIAGNOSTIC_STRING.test(value) && !SENSITIVE_VALUE.test(value)
    ? value
    : undefined;
}

function safeManifestMetadata(metadata) {
  const result = {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return result;
  // 仅保留明确的模型与 lineage 诊断字段，且限制内容长度、控制字符和敏感值。
  const allowed = new Set([
    "provider", "model", "reasoningEffort", "maxTokens", "temperature", "topP",
    "sessionId", "parentSession", "origin", "delegationDepth", "status",
  ]);
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key) || SENSITIVE_KEY.test(key)) continue;
    const safeValue = safeManifestValue(value);
    if (safeValue !== undefined) result[key] = safeValue;
  }
  return result;
}

function publicTree(tree) {
  const flatNode = (node) => ({
    sessionId: safeManifestValue(node.sessionId),
    parentSession: safeManifestValue(node.parentSession),
    origin: safeManifestValue(node.origin),
    delegationDepth: safeManifestValue(node.delegationDepth),
    dangling: node.dangling,
    external: node.external,
    parentConflict: node.parentConflict,
    cycle: node.cycle,
    corruptLineage: node.corruptLineage,
    recordIds: node.records.map((record) => record.recordId).filter(Boolean),
  });
  const visit = (node) => ({
    ...flatNode(node),
    children: node.children.map(visit),
  });
  return {
    roots: tree.roots.map(visit),
    dangling: tree.dangling.map(visit),
    external: tree.external.map(visit),
    cycles: tree.cycles.map((cycle) => cycle.map(flatNode)),
    corruptLineage: tree.corruptLineage.map(flatNode),
    // 平铺完整节点集合，保证 cycle 或其下游节点不会因树不可递归而静默丢失。
    nodes: tree.nodes.map(flatNode),
    unattachedRecordCount: tree.unattachedRecords.length,
  };
}

async function replaceDirectory(tempDir, outputDir) {
  const backup = outputDir + ".old-" + randomUUID();
  const hadOld = await pathExists(outputDir);
  if (hadOld) await rename(outputDir, backup);
  try {
    await rename(tempDir, outputDir);
  } catch (error) {
    if (hadOld && !(await pathExists(outputDir)) && (await pathExists(backup))) {
      try {
        await rename(backup, outputDir);
      } catch (restoreError) {
        throw new Error(
          "sidecar 原子替换失败，恢复旧输出也失败；backup 保留于 " + backup,
          { cause: new AggregateError([error, restoreError], "替换/恢复均失败") },
        );
      }
    }
    throw error;
  }
  if (hadOld) {
    try {
      await rm(backup, { recursive: true, force: false });
    } catch (cleanupError) {
      throw new Error("sidecar 已替换，但旧输出 backup 清理失败，路径: " + backup, { cause: cleanupError });
    }
  }
}

function normalizeOptions(options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes 必须是大于 0 的安全整数");
  return { maxBytes };
}

/**
 * 解析单个 session.jsonl 或目录下所有 session.jsonl，原子写入 sidecar 目录。
 */
export async function writePromptSidecar(inputPathOrDir, outputDir, options = {}) {
  if (typeof inputPathOrDir !== "string" || inputPathOrDir.length === 0) throw new TypeError("必须提供输入路径");
  if (typeof outputDir !== "string" || outputDir.length === 0) throw new TypeError("必须提供输出目录");
  const { maxBytes } = normalizeOptions(options);
  // 必须在扫描输入和创建父目录前拒绝相等、祖先/后代和 symlink/junction 路径。
  const inputPath = resolve(inputPathOrDir);
  const output = resolve(outputDir);
  await rejectOverlappingPaths(inputPath, output);
  const { root, files } = await collectSessionFiles(inputPath);
  if (files.length === 0) throw new Error("未找到 session.jsonl: " + inputPath);
  await mkdir(dirname(output), { recursive: true });
  const temp = output + ".tmp-" + randomUUID();
  const records = [];
  const sourceFiles = [];
  let totalChunks = 0;
  try {
    await mkdir(temp, { recursive: true });
    for (const file of files) {
      const sourceFile = safeSourceFile(root, file);
      sourceFiles.push(sourceFile);
      const input = await readFile(file);
      const events = parseJsonlEvents(input);
      const parseErrors = events.filter((event) => event.parseError);
      if (parseErrors.length > 0) {
        throw new Error(sourceFile + " 包含 " + parseErrors.length + " 个 JSONL 解析失败行（首个: " + parseErrors[0].lineNumber + "）");
      }
      const extracted = extractPromptRecords(events, { sourceFile });
      for (const record of extracted) records.push(record);
    }

    const tree = buildAgentTree(records);
    const usedIds = new Set();
    for (let occurrence = 0; occurrence < records.length; occurrence += 1) {
      const record = records[occurrence];
      let recordId = stableRecordId(record, record.sourceFile ?? "", occurrence);
      while (usedIds.has(recordId)) recordId = hashUtf8(recordId + "\0" + occurrence).slice(0, 24);
      usedIds.add(recordId);
      record.recordId = recordId;
      const chunks = chunkUtf8(record.text, maxBytes);
      const chunkDirectory = join("records", recordId);
      const chunkAbsoluteDirectory = join(temp, chunkDirectory);
      await mkdir(chunkAbsoluteDirectory, { recursive: true });
      const manifestChunks = [];
      for (const chunk of chunks) {
        const fileName = String(chunk.index).padStart(6, "0") + ".txt";
        const relativePath = join(chunkDirectory, fileName).split(sep).join("/");
        const absolutePath = join(temp, chunkDirectory, fileName);
        await writeFile(absolutePath, chunk.text, { encoding: "utf8", flag: "wx" });
        manifestChunks.push({
          index: chunk.index,
          byteOffset: chunk.byteOffset,
          byteLength: chunk.byteLength,
          path: relativePath,
        });
        totalChunks += 1;
      }
      record.sidecar = {
        recordId,
        chunkDir: chunkDirectory.split(sep).join("/"),
        chunkCount: chunks.length,
        chunks: manifestChunks,
        charLength: record.text.length,
        utf8ByteLength: utf8Length(record.text),
        sha256: hashUtf8(record.text),
      };
    }

    const manifest = {
      format: SIDECAR_FORMAT,
      createdAt: new Date().toISOString(),
      maxBytes,
      sourceFiles,
      sessionIds: [...new Set(records.map((record) => safeManifestValue(record.sessionId)).filter((id) => id !== undefined))],
      agentTree: publicTree(tree),
      records: records.map((record) => ({
        recordId: record.recordId,
        kind: record.kind,
        sourceFile: record.sourceFile,
        lineNumber: record.lineNumber,
        // 这是原始 JSONL 行的定位信息，不是 chunk 的 byteOffset/byteLength。
        byteOffset: record.byteOffset,
        byteLength: record.byteLength,
        seq: safeManifestSeq(record.seq),
        time: safeManifestTime(record.time),
        sessionId: safeManifestValue(record.sessionId),
        parentSession: safeManifestValue(record.parentSession),
        origin: safeManifestValue(record.origin),
        delegationDepth: safeManifestValue(record.delegationDepth),
        metadata: safeManifestMetadata(record.metadata),
        truncation: (() => {
          const classification = classifyTruncation(record);
          return { kind: classification.kind, truncated: classification.truncated };
        })(),
        charLength: record.sidecar.charLength,
        utf8ByteLength: record.sidecar.utf8ByteLength,
        sha256: record.sidecar.sha256,
        chunkCount: record.sidecar.chunkCount,
        chunkDir: record.sidecar.chunkDir,
        chunks: record.sidecar.chunks,
      })),
      summary: {
        fileCount: files.length,
        recordCount: records.length,
        chunkCount: totalChunks,
      },
    };
    await writeFile(join(temp, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    const verification = await verifyPromptSidecar(temp);
    if (!verification.ok) throw new Error("生成的 sidecar 校验失败: " + verification.errors.join("；"));
    await replaceDirectory(temp, output);
    return {
      format: SIDECAR_FORMAT,
      sourceFiles: files.length,
      recordCount: records.length,
      chunkCount: totalChunks,
      outputDir: output,
      verification,
    };
  } catch (error) {
    let cleanupError;
    try {
      await rm(temp, { recursive: true, force: true });
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError;
    }
    if (cleanupError !== undefined) {
      throw new Error(
        "写入 Prompt sidecar 失败；临时目录清理失败，仍需人工处理: " + temp,
        { cause: new AggregateError([error, cleanupError], "sidecar 写入和清理均失败") },
      );
    }
    throw asError(error, "写入 Prompt sidecar 失败");
  }
}

function assertManifestInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(label + " 必须是非负安全整数");
}

function assertManifestTime(value, label) {
  if (typeof value !== "string" || value.length > MAX_MANIFEST_STRING_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value) || SENSITIVE_VALUE.test(value)) {
    throw new Error(label + " 必须是安全时间字符串");
  }
}

function assertManifestSummary(manifest) {
  if (!manifest.summary || typeof manifest.summary !== "object" || Array.isArray(manifest.summary)) {
    throw new Error("manifest.summary 不是对象");
  }
  assertManifestInteger(manifest.summary.fileCount, "summary.fileCount");
  assertManifestInteger(manifest.summary.recordCount, "summary.recordCount");
  assertManifestInteger(manifest.summary.chunkCount, "summary.chunkCount");
  if (manifest.summary.fileCount !== manifest.sourceFiles.length) throw new Error("summary.fileCount 与 sourceFiles.length 不一致");
  if (manifest.summary.recordCount !== manifest.records.length) throw new Error("summary.recordCount 与 records.length 不一致");
}

function validateManifestShape(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("manifest 不是对象");
  if (manifest.format !== SIDECAR_FORMAT) throw new Error("不支持的 sidecar manifest format");
  if (!Array.isArray(manifest.sourceFiles)) throw new Error("manifest.sourceFiles 不是数组");
  for (const sourceFile of manifest.sourceFiles) assertSafeRelativeMetadataPath(sourceFile, "sourceFile");
  if (!Array.isArray(manifest.records)) throw new Error("manifest.records 不是数组");
  for (const [index, record] of manifest.records.entries()) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("record[" + index + "] 不是对象");
    }
    if (typeof record.recordId !== "string" || record.recordId.length === 0 || !SAFE_FILE_NAME.test(record.recordId) || record.recordId.includes("..")) {
      throw new Error("record[" + index + "].recordId 缺失或不安全");
    }
    if (record.sourceFile !== undefined) assertSafeRelativeMetadataPath(record.sourceFile, "record[" + index + "].sourceFile");
    if (record.seq !== undefined) {
      if (!Number.isSafeInteger(record.seq)) throw new Error("record[" + index + "].seq 必须是有限安全整数");
    }
    if (record.time !== undefined) assertManifestTime(record.time, "record[" + index + "].time");
    assertManifestInteger(record.charLength, "record[" + index + "].charLength");
    assertManifestInteger(record.utf8ByteLength, "record[" + index + "].utf8ByteLength");
    if (typeof record.sha256 !== "string" || !SHA256_HEX.test(record.sha256)) {
      throw new Error("record[" + index + "].sha256 缺失或格式无效");
    }
    if (!Array.isArray(record.chunks)) throw new Error("record[" + index + "].chunks 不是数组");
    if (!Number.isSafeInteger(record.chunkCount) || record.chunkCount < 0 || record.chunkCount !== record.chunks.length) {
      throw new Error("record[" + index + "].chunkCount 与 chunks 不一致");
    }
    for (const [chunkIndex, chunk] of record.chunks.entries()) {
      if (chunk === null || typeof chunk !== "object" || Array.isArray(chunk)) {
        throw new Error("record[" + index + "].chunks[" + chunkIndex + "] 不是对象");
      }
      if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index !== chunkIndex) {
        throw new Error("record[" + index + "].chunks[" + chunkIndex + "].index 无效");
      }
      assertManifestInteger(chunk.byteOffset, "record[" + index + "].chunks[" + chunkIndex + "].byteOffset");
      assertManifestInteger(chunk.byteLength, "record[" + index + "].chunks[" + chunkIndex + "].byteLength");
      if (typeof chunk.path !== "string" || chunk.path.length === 0) {
        throw new Error("record[" + index + "].chunks[" + chunkIndex + "].path 缺失");
      }
      assertSafeRelativeMetadataPath(chunk.path, "record[" + index + "].chunks[" + chunkIndex + "].path");
    }
  }
  assertManifestSummary(manifest);
}

async function readManifest(manifestPath) {
  const bytes = await readFile(manifestPath);
  let text;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch (error) {
    throw new Error("manifest 不是合法 UTF-8", { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("manifest 不是合法 JSON", { cause: error });
  }
}

async function reassembleManifestRecord(root, record) {
  const chunks = [];
  for (const chunkMeta of record.chunks) {
    const chunkPath = ensureRelativeSafePath(root, chunkMeta.path);
    if (relative(root, chunkPath).split(sep).join("/") !== chunkMeta.path) {
      throw new Error("chunk 路径非规范");
    }
    await rejectSymlinkPath(chunkPath, "sidecar chunk");
    const bytes = await readFile(chunkPath);
    chunks.push({ ...chunkMeta, bytes });
  }
  const text = reassembleUtf8Chunks(chunks);
  if (text.length !== record.charLength) throw new Error("字符长度不一致");
  if (utf8Length(text) !== record.utf8ByteLength) throw new Error("UTF-8 字节长度不一致");
  if (hashUtf8(text) !== record.sha256) throw new Error("SHA-256 不一致");
  return { ...record, text };
}

async function readAndValidateSidecar(sidecarDirOrManifest) {
  let root;
  let manifestPath;
  let manifest;
  try {
    ({ root, manifestPath } = await resolveSidecarPaths(sidecarDirOrManifest));
    manifest = await readManifest(manifestPath);
    validateManifestShape(manifest);
  } catch (error) {
    return {
      ok: false,
      errors: ["无法读取 sidecar: " + (error instanceof Error ? error.message : String(error))],
      records: [],
      recordCount: 0,
      chunkCount: 0,
    };
  }

  const records = [];
  const errors = [];
  let chunkCount = 0;
  for (const record of manifest.records) {
    try {
      records.push(await reassembleManifestRecord(root, record));
      chunkCount += record.chunks.length;
    } catch (error) {
      errors.push(record.recordId + ": " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (manifest.summary.chunkCount !== chunkCount) errors.push("summary.chunkCount 不一致");
  return { ok: errors.length === 0, errors, manifest, records, recordCount: manifest.records.length, chunkCount };
}

/** 读取 manifest、重组所有 chunk 并校验长度、顺序与 SHA-256。 */
export async function verifyPromptSidecar(sidecarDirOrManifest) {
  const result = await readAndValidateSidecar(sidecarDirOrManifest);
  return {
    ok: result.ok,
    errors: result.errors,
    recordCount: result.recordCount,
    chunkCount: result.chunkCount,
  };
}

export async function readPromptSidecar(sidecarDirOrManifest) {
  const result = await readAndValidateSidecar(sidecarDirOrManifest);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.errors,
      ...(result.manifest === undefined ? {} : { manifest: result.manifest }),
      records: result.records,
    };
  }
  return { ok: true, manifest: result.manifest, records: result.records };
}

export function defaultSidecarPath(inputPathOrDir) {
  // 目录输入也使用同级 sibling，避免默认输出落入输入树而触发重叠保护。
  const input = resolve(inputPathOrDir);
  return join(dirname(input), basename(input) + ".dsh-prompt-sidecar");
}
