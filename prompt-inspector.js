/**
 * 本地 session.jsonl 的 Prompt Inspector 纯函数。
 *
 * 该模块不依赖 DSH runtime，也不会修改输入事件；只保留提示词诊断所需的
 * 稳定元数据。完整 prompt 仅在返回记录的 text/prompt 字段中保留，sidecar
 * manifest 只保存长度、hash 与分块引用。
 */
import { createHash } from "node:crypto";

const UTF8 = new TextEncoder();
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });
// 记录层保留 descriptor 的可诊断元数据；写入 manifest 前由 sidecar 再做严格白名单过滤。
const SAFE_METADATA_KEYS = new Set([
  "provider",
  "model",
  "reasoningEffort",
  "maxTokens",
  "temperature",
  "topP",
  "role",
  "label",
  "name",
  "taskId",
  "agentId",
  "sessionId",
  "parentSession",
  "origin",
  "delegationDepth",
  "route",
  "routeKey",
  "status",
]);
const SENSITIVE_KEY = /(?:authorization|cookie|password|secret|credential|encrypted|cipher|private|api.?key|access.?token|refresh.?token)/i;
const DISPLAY_TRUNCATION = /(?:\(\s*(?:line|output|content|read)\s+truncated(?:\s+to)?[^)]*\)|\[\s*(?:line|output|content|read)\s+truncated[^\]]*\])/i;
const EXPLICIT_TRUNCATION = /(?:\bTRUNCAT(?:ED|ION)\b|\[\s*截断\s*\]|\bPROMPT\s+TRUNCATED\b|内容已截断|提示词已截断|已截断)/iu;
const ELLIPSIS = /(?:\.{3}|…{1,3})/u;
const GRAPHEME_SEGMENTER = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function asBytes(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") return Buffer.from(input, "utf8");
  throw new TypeError("parseJsonlEvents(input) 只接受 Buffer 或 string");
}

function decodeLine(bytes) {
  try {
    return FATAL_UTF8.decode(bytes);
  } catch (error) {
    // 保留可诊断 raw；同时把非法 UTF-8 作为该行 parseError，不吞掉后续行。
    return { raw: new TextDecoder().decode(bytes), error };
  }
}

/**
 * 按 UTF-8 字节逐行解析 JSONL。byteLength 不包含换行符，byteOffset 指向该行起点。
 * 每一行都返回，即使 JSON.parse 失败也不会影响后续行。
 */
export function parseJsonlEvents(input) {
  const bytes = asBytes(input);
  if (bytes.length === 0) return [];
  const events = [];
  let lineStart = 0;
  let lineNumber = 1;

  const consume = (lineEnd) => {
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && bytes[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const lineBytes = bytes.subarray(lineStart, contentEnd);
    const decoded = decodeLine(lineBytes);
    let raw;
    let parseError;
    let value;
    if (typeof decoded === "string") {
      raw = decoded;
      if (raw.length > 0) {
        try {
          value = JSON.parse(raw);
        } catch (error) {
          parseError = error;
        }
      } else {
        parseError = new SyntaxError("空 JSONL 行");
      }
    } else {
      raw = decoded.raw;
      parseError = new SyntaxError("该 JSONL 行不是合法 UTF-8", { cause: decoded.error });
    }
    events.push({
      lineNumber,
      byteOffset: lineStart,
      byteLength: lineBytes.length,
      raw,
      value,
      parseError,
    });
    lineStart = lineEnd + 1;
    lineNumber += 1;
  };

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) consume(index);
  }
  if (lineStart < bytes.length) consume(bytes.length);
  return events;
}

function eventValue(event) {
  if (event !== null && typeof event === "object" && Object.prototype.hasOwnProperty.call(event, "value")) {
    return event.value;
  }
  return event;
}

function objectOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function eventType(value) {
  return String(firstValue(value?.type, value?.eventType, value?.event, value?.kind, ""))
    .replaceAll("\\", "/")
    .toLowerCase();
}

function sessionObject(value) {
  return objectOf(firstValue(value?.session, value?.agent?.session, value?.data?.session));
}

function sessionIdOf(value) {
  const session = sessionObject(value);
  const data = objectOf(value?.data);
  const header = objectOf(data?.header) ?? objectOf(value?.header) ?? objectOf(session?.header);
  const descriptor = objectOf(firstValue(data?.descriptor, value?.descriptor));
  const candidate = firstValue(
    value?.sessionId,
    session?.id,
    data?.sessionId,
    data?.id,
    value?.id,
    header?.sessionId,
    header?.id,
    descriptor?.sessionId,
    descriptor?.id,
  );
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function headerOf(value, data) {
  const session = sessionObject(value);
  return objectOf(firstValue(data?.header, value?.header, session?.header));
}

function descriptorOf(value, data) {
  // 兼容顶层 descriptor、data.descriptor 和 descriptor 事件直接 data 三种导出形状。
  return objectOf(firstValue(data?.descriptor, value?.descriptor, data));
}

function textValue(value) {
  return typeof value === "string" ? value : undefined;
}

function scalarMetadataValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function safeMetadata(sources) {
  const metadata = {};
  for (const source of sources) {
    const object = objectOf(source);
    if (object === undefined) continue;
    for (const [key, rawValue] of Object.entries(object)) {
      if (!SAFE_METADATA_KEYS.has(key) || SENSITIVE_KEY.test(key)) continue;
      const value = scalarMetadataValue(rawValue);
      if (value !== undefined && metadata[key] === undefined) metadata[key] = value;
    }
  }
  return metadata;
}

function promptRecord({ event, value, data, kind, text, sourceFile }) {
  const session = sessionObject(value);
  const header = headerOf(value, data);
  const descriptor = descriptorOf(value, data);
  const sessionId = sessionIdOf(value);
  const parentSession = firstString(
    value?.parentSession,
    session?.parentSession,
    header?.parentSession,
    data?.parentSession,
    descriptor?.parentSession,
  );
  const origin = firstString(value?.origin, session?.origin, header?.origin, data?.origin, descriptor?.origin);
  const delegationDepth = firstValue(
    value?.delegationDepth,
    session?.delegationDepth,
    header?.delegationDepth,
    data?.delegationDepth,
    descriptor?.delegationDepth,
  );
  const seq = firstValue(value?.seq, value?.sequence, data?.seq, header?.seq, descriptor?.seq, event?.seq);
  const time = firstValue(value?.time, value?.timestamp, data?.time, header?.time, descriptor?.time, event?.time);
  const metadata = safeMetadata([value, session, header, data, descriptor]);
  if (sessionId !== undefined) metadata.sessionId = sessionId;
  if (parentSession !== undefined) metadata.parentSession = parentSession;
  if (origin !== undefined) metadata.origin = origin;
  if (delegationDepth !== undefined) metadata.delegationDepth = delegationDepth;
  return {
    kind,
    text,
    prompt: text,
    sourceFile: sourceFile ?? event?.sourceFile,
    lineNumber: event?.lineNumber,
    byteOffset: event?.byteOffset,
    byteLength: event?.byteLength,
    sessionId,
    parentSession,
    origin,
    delegationDepth,
    seq,
    time,
    metadata,
  };
}

/**
 * 从 request/header 的 data.header.system 与 subagent/descriptor 的 data.persona 提取完整文本。
 * sourceFile 可通过第二参数提供；不会把原始 event/raw 带入返回记录。
 */
export function extractPromptRecords(events, { sourceFile } = {}) {
  if (!Array.isArray(events)) throw new TypeError("extractPromptRecords(events) 需要事件数组");
  const records = [];
  const contexts = new Map();
  let defaultSessionId;

  const explicitContext = (value, data, header, descriptor, session) => ({
    parentSession: firstString(value?.parentSession, session?.parentSession, data?.parentSession, header?.parentSession, descriptor?.parentSession),
    origin: firstString(value?.origin, session?.origin, data?.origin, header?.origin, descriptor?.origin),
    delegationDepth: firstValue(value?.delegationDepth, session?.delegationDepth, data?.delegationDepth, header?.delegationDepth, descriptor?.delegationDepth),
  });

  for (const event of events) {
    if (event?.parseError) continue;
    const originalValue = eventValue(event);
    const data = objectOf(originalValue?.data) ?? {};
    const type = eventType(originalValue);
    const header = headerOf(originalValue, data);
    const descriptor = descriptorOf(originalValue, data);
    const system = textValue(header?.system);
    const persona = textValue(data.persona) ?? textValue(descriptor?.persona);
    const ownSessionId = sessionIdOf(originalValue);
    const session = sessionObject(originalValue);
    const isSessionEvent = type === "session" || type.startsWith("session/");
    const explicit = explicitContext(originalValue, data, header, descriptor, session);

    // 文件首个 session 事件定义默认上下文；后续每个有 id 的事件独立维护自己的上下文。
    if (isSessionEvent && ownSessionId !== undefined) {
      if (defaultSessionId === undefined) defaultSessionId = ownSessionId;
      const previous = contexts.get(ownSessionId) ?? { sessionId: ownSessionId };
      contexts.set(ownSessionId, {
        sessionId: ownSessionId,
        parentSession: explicit.parentSession ?? previous.parentSession,
        origin: explicit.origin ?? previous.origin,
        delegationDepth: explicit.delegationDepth ?? previous.delegationDepth,
      });
    } else if (ownSessionId !== undefined) {
      const previous = contexts.get(ownSessionId) ?? { sessionId: ownSessionId };
      contexts.set(ownSessionId, {
        sessionId: ownSessionId,
        parentSession: explicit.parentSession ?? previous.parentSession,
        origin: explicit.origin ?? previous.origin,
        delegationDepth: explicit.delegationDepth ?? previous.delegationDepth,
      });
    }

    const selectedSessionId = ownSessionId ?? defaultSessionId;
    const selectedContext = selectedSessionId === undefined
      ? undefined
      : (contexts.get(selectedSessionId) ?? { sessionId: selectedSessionId });
    const inherited = {
      sessionId: selectedContext?.sessionId,
      parentSession: explicit.parentSession ?? selectedContext?.parentSession,
      origin: explicit.origin ?? selectedContext?.origin,
      delegationDepth: explicit.delegationDepth ?? selectedContext?.delegationDepth,
    };
    // 合并只用于当前 record；无 id 的 child 事件不会写回默认 root context。
    const value = { ...originalValue, ...inherited };
    const requestEvent = type === "request/header" || type.endsWith("/request/header") || (type === "request" && system !== undefined);
    const descriptorEvent = type === "subagent/descriptor" || type.endsWith("/subagent/descriptor") || (type === "subagent" && persona !== undefined) || (persona !== undefined && type.includes("descriptor"));
    if (requestEvent && system !== undefined) {
      records.push(promptRecord({ event, value, data, kind: "system", text: system, sourceFile }));
    }
    if (descriptorEvent && persona !== undefined) {
      records.push(promptRecord({ event, value, data, kind: "persona", text: persona, sourceFile }));
    }
  }
  return records;
}

function normalizedSessionId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 按 sessionId 建树。父节点缺失、self-parent 和 parent cycle 都保留为异常信息，
 * 不把 origin=subagent 猜成某个父节点，也不让异常关系触发无限递归。
 */
export function buildAgentTree(records) {
  if (!Array.isArray(records)) throw new TypeError("buildAgentTree(records) 需要记录数组");
  const bySession = new Map();
  const unattachedRecords = [];
  for (const record of records) {
    const sessionId = normalizedSessionId(record?.sessionId);
    if (sessionId === undefined) {
      unattachedRecords.push(record);
      continue;
    }
    let node = bySession.get(sessionId);
    if (node === undefined) {
      node = {
        sessionId,
        parentSession: undefined,
        origin: undefined,
        delegationDepth: undefined,
        records: [],
        children: [],
        dangling: false,
        external: false,
        parentConflict: false,
        cycle: false,
        corruptLineage: false,
      };
      bySession.set(sessionId, node);
    }
    node.records.push(record);
    const parent = normalizedSessionId(record.parentSession);
    if (node.parentSession === undefined && parent !== undefined) node.parentSession = parent;
    else if (parent !== undefined && node.parentSession !== parent) node.parentConflict = true;
    if (node.origin === undefined && typeof record.origin === "string") node.origin = record.origin;
    if (node.delegationDepth === undefined && record.delegationDepth !== undefined) node.delegationDepth = record.delegationDepth;
  }

  const nodes = [...bySession.values()];
  const cycles = [];
  const completed = new Set();
  for (const start of nodes) {
    if (completed.has(start.sessionId)) continue;
    const path = [];
    const positions = new Map();
    let cursor = start;
    while (cursor !== undefined && !completed.has(cursor.sessionId)) {
      const previous = positions.get(cursor.sessionId);
      if (previous !== undefined) {
        const cycleNodes = path.slice(previous);
        for (const cycleNode of cycleNodes) {
          cycleNode.cycle = true;
          cycleNode.corruptLineage = true;
        }
        cycles.push(cycleNodes);
        break;
      }
      positions.set(cursor.sessionId, path.length);
      path.push(cursor);
      cursor = cursor.parentSession === undefined ? undefined : bySession.get(cursor.parentSession);
    }
    for (const node of path) completed.add(node.sessionId);
  }

  const roots = [];
  const dangling = [];
  const external = [];
  for (const node of nodes) {
    if (node.parentSession === undefined) {
      // 没有 parentSession 且 origin=subagent 的会话身份不完整，不能冒充主代理。
      if (node.origin === "subagent") {
        node.external = true;
        external.push(node);
      } else {
        roots.push(node);
      }
      continue;
    }
    const parent = bySession.get(node.parentSession);
    if (parent === undefined) {
      node.dangling = true;
      node.external = true;
      node.corruptLineage = true;
      dangling.push(node);
    } else if (node.cycle || parent.cycle) {
      // Cycle 边及其下游不挂载，避免 publicTree 递归；平铺异常集合仍完整保留。
      if (!node.cycle) node.corruptLineage = true;
    } else {
      parent.children.push(node);
    }
  }
  for (const node of nodes) {
    if (node.parentConflict) node.corruptLineage = true;
    node.records.sort((left, right) => (left.lineNumber ?? 0) - (right.lineNumber ?? 0));
    node.children.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }
  roots.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  dangling.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  external.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const corruptLineage = nodes.filter((node) => node.corruptLineage);
  return { roots, nodes, bySession, dangling, external, cycles, corruptLineage, unattachedRecords };
}

function ensureUtf8Text(text, label = "text") {
  if (typeof text !== "string") throw new TypeError(label + " 必须是 string");
  // TextEncoder 会把孤立代理编码成替换字符，无法保证重组后得到原始 JS 字符串。
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new TypeError(label + " 包含未配对 surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(label + " 包含未配对 surrogate");
    }
  }
}

function utf8Bytes(text) {
  ensureUtf8Text(text);
  return UTF8.encode(text);
}

function validateMaxBytes(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes 必须是大于 0 的安全整数");
  }
}

/** 按完整 UTF-8 code point 切分，byteOffset/byteLength 均以 UTF-8 字节计。 */
export function chunkUtf8(text, maxBytes) {
  ensureUtf8Text(text);
  validateMaxBytes(maxBytes);
  if (text.length === 0) return [];
  const chunks = [];
  let currentText = "";
  let currentBytes = 0;
  let byteOffset = 0;
  const graphemes = GRAPHEME_SEGMENTER === undefined
    ? [...text]
    : [...GRAPHEME_SEGMENTER.segment(text)].map((segment) => segment.segment);
  // grapheme cluster 可能由多个 code point 组成；超预算时退回 code point 粒度，
  // 只有单个 code point 本身超预算才报错。
  const segments = [];
  for (const grapheme of graphemes) {
    if (UTF8.encode(grapheme).length <= maxBytes) segments.push(grapheme);
    else segments.push(...grapheme);
  }
  for (const segment of segments) {
    const pointBytes = UTF8.encode(segment);
    if (pointBytes.length > maxBytes) {
      throw new RangeError("maxBytes 小于单个 UTF-8 code point（需要 " + pointBytes.length + " 字节）");
    }
    if (currentBytes > 0 && currentBytes + pointBytes.length > maxBytes) {
      chunks.push({ index: chunks.length, byteOffset, byteLength: currentBytes, text: currentText });
      byteOffset += currentBytes;
      currentText = "";
      currentBytes = 0;
    }
    currentText += segment;
    currentBytes += pointBytes.length;
  }
  if (currentBytes > 0) chunks.push({ index: chunks.length, byteOffset, byteLength: currentBytes, text: currentText });
  return chunks;
}

function chunkBytes(chunk, index) {
  if (chunk?.bytes !== undefined) {
    if (!(chunk.bytes instanceof Uint8Array) && !Buffer.isBuffer(chunk.bytes)) {
      throw new TypeError("第 " + index + " 块 bytes 必须是 Uint8Array");
    }
    return new Uint8Array(chunk.bytes);
  }
  return utf8Bytes(chunk?.text);
}

/** 严格校验 index、连续 byte offset/length，并以 fatal UTF-8 解码重组。 */
export function reassembleUtf8Chunks(chunks) {
  if (!Array.isArray(chunks)) throw new TypeError("chunks 必须是数组");
  let expectedOffset = 0;
  const parts = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === null || typeof chunk !== "object") throw new TypeError("第 " + index + " 块不是对象");
    if (chunk.index !== index) throw new Error("chunk index 必须从 0 连续递增，发现第 " + index + " 块为 " + chunk.index);
    if (!Number.isSafeInteger(chunk.byteOffset) || chunk.byteOffset !== expectedOffset) {
      throw new Error("chunk byteOffset 不连续：第 " + index + " 块应为 " + expectedOffset);
    }
    const bytes = chunkBytes(chunk, index);
    if (!Number.isSafeInteger(chunk.byteLength) || chunk.byteLength !== bytes.length) {
      throw new Error("chunk byteLength 与 UTF-8 字节数不一致：第 " + index + " 块");
    }
    let decoded;
    try {
      decoded = FATAL_UTF8.decode(bytes);
    } catch (error) {
      throw new Error("chunk 包含非法 UTF-8：第 " + index + " 块", { cause: error });
    }
    if (typeof chunk.text === "string" && decoded !== chunk.text) {
      throw new Error("chunk text 与 UTF-8 bytes 不一致：第 " + index + " 块");
    }
    parts.push(decoded);
    expectedOffset += bytes.length;
  }
  return parts.join("");
}

/** 返回 SHA-256 hex；长度诊断由调用方用 text.length/UTF-8 字节长度记录。 */
export function hashUtf8(text) {
  const bytes = utf8Bytes(text);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 分辨原始 JSONL 错误、提示词显式截断、普通省略号与展示层标记。
 * display marker（例如 read 工具的 line truncated 提示）不会被当作原始截断证据。
 */
export function classifyTruncation(record) {
  if (record?.parseError) {
    return {
      kind: "jsonl-parse-error",
      type: "jsonl-parse-error",
      source: "jsonl",
      truncated: false,
      evidence: [String(record.parseError.message ?? record.parseError)],
    };
  }
  const text = typeof record === "string" ? record : (typeof record?.text === "string" ? record.text : typeof record?.prompt === "string" ? record.prompt : "");
  const display = typeof record?.displayMarker === "string" ? record.displayMarker : "";
  if (display.length > 0 || DISPLAY_TRUNCATION.test(text)) {
    return {
      kind: "display-layer-marker",
      type: "display-layer-marker",
      source: "display",
      truncated: false,
      evidence: [display || text.match(DISPLAY_TRUNCATION)?.[0]],
    };
  }
  const explicit = text.match(EXPLICIT_TRUNCATION);
  if (explicit !== null) {
    return {
      kind: "prompt-explicit-truncation",
      type: "prompt-explicit-truncation",
      source: "prompt",
      truncated: true,
      evidence: [explicit[0]],
    };
  }
  const ellipsis = text.match(ELLIPSIS);
  if (ellipsis !== null) {
    return {
      kind: "ordinary-ellipsis",
      type: "ordinary-ellipsis",
      source: "prompt",
      truncated: false,
      evidence: [ellipsis[0]],
    };
  }
  return { kind: "none", type: "none", source: "none", truncated: false, evidence: [] };
}

export function utf8Length(text) {
  return utf8Bytes(text).length;
}
