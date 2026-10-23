/**
 * 结构化交付常量与只读投影。
 *
 * outputSchema 字节上限、稳定错误码、回退原因与 structured 结果的只读投影。
 * 本文件由原 `shared.js` 的 4354–4465 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/structured
 */

// ── 结构化交付（票据 30） ──────────────────────────────────────────────────

/**
 * 结构化输出声明（outputSchema）序列化后的 UTF-8 字节上限。
 *
 * 宿主本身没有这个上限（见 docs/specs/03-host-contract-report.md §4.4），这是 DEG
 * 在派发前自管的策略：超限拒绝派发，且 schema 原文永远不进入事件历史/快照。
 */
export const OUTPUT_SCHEMA_MAX_BYTES = 64 * 1024;

/** 结构化声明被拒绝时的稳定错误码（工具回执/RPC 都只回传这些 token）。 */
export const OUTPUT_SCHEMA_ERROR_CODES = Object.freeze({
  INVALID: "OUTPUT_SCHEMA_INVALID",
  TOO_LARGE: "OUTPUT_SCHEMA_TOO_LARGE",
  UNSUPPORTED: "OUTPUT_SCHEMA_UNSUPPORTED",
});

/**
 * 「本次 activation 请求了结构化输出」的内部 marker。
 *
 * 它只存在于内存里的 request.agentOptions（Host 不持久化 agentOptions），值只是布尔，
 * 绝不携带 schema 原文；child_models 只据此保存 outputSchemaRequested。
 */
export const OUTPUT_SCHEMA_REQUESTED_MARKER = "__degOutputSchemaRequested";

/**
 * 结构化结果回退原因（稳定枚举）。
 *
 * - missing_structured：请求了 schema，但宿主结果没有 structured（通常 stopReason=error，
 *   文本 output 仍在）；不得因此把已结束的 child/task 判为失败。
 * - result_unavailable：activation.result 拒绝，或 structured 不是无损 JSON。
 * - result_too_large：结构化结果序列化后超过 64 KiB，只记录字节数，不保存值。
 * - schema_not_restored：冷恢复/重建创建了新 activation，但宿主 descriptor 不保存
 *   outputSchema，本轮没有重新声明契约。
 */
export const STRUCTURED_RESULT_FALLBACK_REASONS = Object.freeze({
  MISSING_STRUCTURED: "missing_structured",
  RESULT_UNAVAILABLE: "result_unavailable",
  RESULT_TOO_LARGE: "result_too_large",
  SCHEMA_NOT_RESTORED: "schema_not_restored",
});

const STRUCTURED_FALLBACK_REASON_SET = new Set(Object.values(STRUCTURED_RESULT_FALLBACK_REASONS));

/** UTF-8 字节数：schema 与 structured 结果共用的唯一口径。 */
export function utf8ByteLength(text) {
  return typeof text === "string" ? new TextEncoder().encode(text).byteLength : 0;
}

/**
 * 归一结构化结果投影（只读、有界）。
 *
 * 输入是 child_models.structured 或 runtime 组装出的同形对象；输出只保留白名单字段：
 * - value：仅当它仍是无损 JSON 且序列化后 <= 64 KiB 时保留；
 * - bytes/receivedAt：安全非负整数；
 * - fallback：布尔；reason：本模块声明的稳定枚举。
 *
 * 旧记录/被篡改的记录即使携带超大或非 JSON 的值，也不会原样进入快照/RPC：此时降级为
 * fallback=true + result_too_large/result_unavailable，并且不输出 value。
 */
export function projectStructuredResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let projectedValue;
  let bytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : undefined;
  let fallback = value.fallback === true;
  let reason = STRUCTURED_FALLBACK_REASON_SET.has(value.reason) ? value.reason : undefined;
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    let serialized;
    try {
      serialized = JSON.stringify(value.value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      fallback = true;
      if (reason === undefined) reason = STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE;
    } else {
      const measured = utf8ByteLength(serialized);
      if (measured > OUTPUT_SCHEMA_MAX_BYTES) {
        fallback = true;
        reason = STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_TOO_LARGE;
        bytes = measured;
      } else {
        // 深拷贝一份纯 JSON 值，避免投影把调用方对象引用带进快照。
        try { projectedValue = JSON.parse(serialized); } catch { projectedValue = undefined; }
        bytes = measured;
      }
    }
  }
  const projected = {
    ...(projectedValue === undefined ? {} : { value: projectedValue }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(Number.isSafeInteger(value.receivedAt) && value.receivedAt >= 0 ? { receivedAt: value.receivedAt } : {}),
    ...(fallback ? { fallback: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
  return Object.keys(projected).length === 0 ? null : projected;
}

/**
 * child_models/attempt 记录上的结构化投影字段。
 *
 * 缺失时整体省略（不伪造 false）；outputSchemaRequested 只在记录真的写了布尔值时输出。
 */
export function structuredProjectionFields(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const structured = projectStructuredResult(source.structured);
  return {
    ...(structured === null ? {} : { structured }),
    ...(typeof source.outputSchemaRequested === "boolean" ? { outputSchemaRequested: source.outputSchemaRequested } : {}),
  };
}
