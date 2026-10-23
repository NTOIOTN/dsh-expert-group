/**
 * 入口专家委派核心域（R4d · 票据 18）。
 *
 * 这一域承载 role 工具与 fan-out 工具共用的**纯能力面**：
 * - 结构化输出声明（outputSchema 校验、provider 能力断言）与结构化结果捕获/落盘重试；
 * - 上下文继承通道解析（fork provider 能力位、父日志已完成 turn 判定）与启动适配器；
 * - admission 事实：spawn provider 就绪判定、deny 边界收窄、route key、快照恢复、
 *   图片参数归一与 PNG durable 副本。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**、不做任何注册：`ctx.tool` / `ctx.effect` / `ctx.on` 与 disposer
 * 顺序仍由 `index.js` 在原注册点执行。域只返回 handler 与已构造的定义对象。
 *
 * ## 状态唯一 owner
 * 本模块独占：`structuredRequestMeta`（WeakMap）、`pendingStructuredPatches`、
 * `structuredRetryTimers`、`structuredRetryPatches`。对外只暴露命令
 * （writeStructuredPatch / flushPendingStructuredPatch / clearAllStructuredRetries /
 * clearPendingStructuredPatches）与只读谓词（structuredRequestedOfRequest），
 * 不交出容器本体。`index.js` 只在卸载 effect 里调用一次清理命令。
 *
 * ## 行为等价
 * 校验顺序（形状 → assertObjectJsonSchema → 深拷贝 → UTF-8 64KiB）、错误 code、重试预算
 * （3 次、200ms 起指数退避、封顶 2s）、上下文继承的 fail-closed 判定与启动参数剥离
 * 全部与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-expert-tools-core
 */
import { assertObjectJsonSchema } from "@deepseek-ai/dsh-tools";
import { expertDenyCandidates, readonlyDenyCandidates } from "../shared/protocol.js";
import { restrictableDenyNamesInScope, restrictableScopeNames } from "./expert-guards.js";
import {
  CONTEXT_INHERITANCE_ERROR_CODES,
  CONTEXT_INHERITANCE_ROLE_IDS,
  EXPERT_INHERIT_CONTEXT_MARKER,
} from "../shared/model-route.js";
import {
  OUTPUT_SCHEMA_ERROR_CODES,
  OUTPUT_SCHEMA_MAX_BYTES,
  OUTPUT_SCHEMA_REQUESTED_MARKER,
  STRUCTURED_RESULT_FALLBACK_REASONS,
  utf8ByteLength,
} from "../shared/structured.js";
import { isFanoutIdentity } from "../fanout-host.js";
import { normalizeImageToPng } from "../image-routing.js";
import { transcodeImageToPng } from "./image-transcode.js";

/**
 * 结构化输出声明校验（schema 形状 / 宿主同一套子集断言 / 64KiB 字节上限）。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} deps.subagents - subagent 服务（provider 能力位探测）。
 * @returns {object} 声明校验能力面。
 */
export function createExpertOutputSchemaSupport({ subagents }) {
  /**
   * 构造结构化声明错误：稳定 code + 有界 violations/字节数，绝不回显 schema 原文。
   *
   * 三种错误都带 validation=true，角色工具会把它映射成无凭据的 rejected 回执，
   * fanout 工具则直接抛出并保留 code；错误消息只包含固定文案与路径/字节数。
   */
  function outputSchemaError(code, message, details = {}) {
    const error = new Error(message);
    error.name = "OutputSchemaError";
    error.code = code;
    error.validation = true;
    error.details = details;
    return error;
  }

  /**
   * 校验并归一调用方给出的 outputSchema（票据 30）。
   *
   * 顺序固定：形状 -> 宿主同一套 assertObjectJsonSchema -> 深拷贝 -> UTF-8 64KiB。
   * 深拷贝保证后续派发使用的是此刻校验过的纯 JSON 对象，调用方之后修改原对象不会
   * 改变实际 schema；同时让字节数口径与真正发给宿主的内容一致。
   *
   * @param {unknown} raw - 工具入参上的 outputSchema。
   * @param {string} label - 错误消息里的调用点标签（角色名/分片）。
   * @returns {{schema: object, bytes: number}|undefined} 未声明时 undefined。
   */
  function normalizeOutputSchemaDeclaration(raw, label) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.INVALID,
        label + " 的 outputSchema 必须是 JSON Schema 对象",
        { violations: ["schema must be an object"] },
      );
    }
    try {
      assertObjectJsonSchema(raw);
    } catch (error) {
      const violations = Array.isArray(error?.violations) && error.violations.length > 0
        ? error.violations.slice(0, 32).map((entry) => String(entry).slice(0, 256))
        : ["schema is not a supported object-rooted JSON Schema"];
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.INVALID,
        label + " 的 outputSchema 不合法：" + violations.join("; "),
        { violations },
      );
    }
    let schema;
    try {
      schema = JSON.parse(JSON.stringify(raw));
    } catch {
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.INVALID,
        label + " 的 outputSchema 不是无损 JSON",
        { violations: ["schema must be lossless JSON"] },
      );
    }
    const bytes = utf8ByteLength(JSON.stringify(schema));
    if (bytes > OUTPUT_SCHEMA_MAX_BYTES) {
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.TOO_LARGE,
        label + " 的 outputSchema 序列化后为 " + bytes + " bytes，超过 " + OUTPUT_SCHEMA_MAX_BYTES + " 上限",
        { bytes, maxBytes: OUTPUT_SCHEMA_MAX_BYTES },
      );
    }
    return { schema, bytes };
  }

  /**
   * 目标 subagent provider 必须显式声明 capabilities.outputSchema === true。
   *
   * 宿主在 assertCapabilities 阶段会拒绝不支持该能力的请求且不会创建 child；DEG 在
   * 派发前先做同一判定，返回自己的稳定 code，绝不静默把结构化请求降级成纯文本。
   * legacy startContinuable 没有 outputSchema 契约，同样视为不支持。
   */
  function assertOutputSchemaProviderSupport(providerName, label) {
    if (typeof subagents?.startActivation !== "function") {
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.UNSUPPORTED,
        label + " 的 outputSchema 无法声明：当前宿主只有 legacy startContinuable，没有结构化输出契约",
      );
    }
    let provider;
    try { provider = subagents.getProvider(providerName); } catch { provider = undefined; }
    if (provider === undefined || provider === null || provider.capabilities?.outputSchema !== true) {
      throw outputSchemaError(
        OUTPUT_SCHEMA_ERROR_CODES.UNSUPPORTED,
        label + " 的 outputSchema 无法声明：subagent provider \"" + String(providerName)
          + "\" 不支持结构化输出；请移除 schema 或改用支持 outputSchema 的 provider",
      );
    }
  }

  return { outputSchemaError, normalizeOutputSchemaDeclaration, assertOutputSchemaProviderSupport };
}

/**
 * 结构化结果捕获与 child_models 落盘（含失败的有界退避重试）。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} deps.storage - settings/storage 域的读写投影。
 * @param {Function} deps.storage.readSnapshot - 读合并快照（child_models 记录来源）。
 * @param {Function} deps.storage.writeChildModelPatch - child_models 合并写命令。
 * @param {object} deps.logger - 告警出口。
 * @returns {object} 结构化结果能力面。
 */
export function createExpertStructuredResults({ storage, logger }) {
  // childModels 记录读取走 storage 读投影；写入走 storage 合并写命令。
  const source = () => storage.readSnapshot();
  const writeChildModelPatch = (...args) => storage.writeChildModelPatch(...args);
  /**
   * request -> 结构化派发元数据的进程内映射（绝不写入 request 字段）。
   *
   * request.outputSchema 会原样透传给宿主；notRestored 只用于恢复路径：本轮新建
   * activation 时无法重新声明 schema，结果标记为 schema_not_restored。
   */
  const structuredRequestMeta = new WeakMap();

  function markStructuredRequest(request, meta) {
    if (request !== null && typeof request === "object") structuredRequestMeta.set(request, meta);
  }

  /** request 是否声明过结构化输出（schema 本身或布尔 marker）。 */
  function structuredRequestedOfRequest(request) {
    if (request === null || typeof request !== "object") return false;
    if (request.outputSchema !== undefined) return true;
    const marker = request.agentOptions?.[OUTPUT_SCHEMA_REQUESTED_MARKER];
    return marker === true;
  }

  /** 待写 structured 补丁：child_models 记录尚未建立 provider/model 时先留在内存。 */
  const pendingStructuredPatches = new Map();
  const PENDING_STRUCTURED_LIMIT = 256;
  /**
   * 结构化结果落盘失败后的有界重试状态（票据 30 × 25 的持久化健壮性）。
   *
   * - retryTimers：childId -> 定时器；同一 child 只保留一个，失败风暴不会线性放大；
   * - retryPatches：childId -> 合并后的最新补丁；重试成功/放弃时一起清掉。
   *
   * 上限与 pending 表同阶：childId 来自 DEG 自己的 child 记录，不会无限增长。
   */
  const structuredRetryTimers = new Map();
  const structuredRetryPatches = new Map();
  const STRUCTURED_WRITE_RETRY_LIMIT = 3;
  const STRUCTURED_WRITE_RETRY_DELAY_MS = 200;

  function childModelRecordOf(childId) {
    if (typeof childId !== "string" || childId.length === 0) return undefined;
    try { return source()?.childModels?.[childId]; } catch { return undefined; }
  }

  /** 清掉某 child 的重试定时器与待重试补丁（成功、放弃、卸载时调用）。 */
  function clearStructuredRetry(childId) {
    const timer = structuredRetryTimers.get(childId);
    if (timer !== undefined) {
      try { clearTimeout(timer); } catch { /* 清理失败不影响后续流程 */ }
      structuredRetryTimers.delete(childId);
    }
    structuredRetryPatches.delete(childId);
  }

  function clearAllStructuredRetries() {
    for (const timer of structuredRetryTimers.values()) {
      try { clearTimeout(timer); } catch { /* 同上 */ }
    }
    structuredRetryTimers.clear();
    structuredRetryPatches.clear();
  }

  /**
   * 安排一次有界重试（指数退避，200ms 起、封顶 2s，最多 3 次）。
   *
   * 预算用尽后只告警并放弃自动重试；补丁本身已经写到内存/磁盘的其他入口，
   * 下一次同 child 的新结果仍会重新尝试。绝不无限高频重试同一条失败写入。
   */
  function scheduleStructuredRetry(childId, patch, attempt) {
    if (attempt > STRUCTURED_WRITE_RETRY_LIMIT) {
      clearStructuredRetry(childId);
      logger.warn("dsh-expert-group: structured result persistence retry budget exhausted for child " + childId);
      return;
    }
    // 合并同一 child 的最新补丁；旧补丁已被新结果替代，没必要分别重试。
    if (!structuredRetryPatches.has(childId) && structuredRetryPatches.size >= PENDING_STRUCTURED_LIMIT) {
      const oldest = structuredRetryPatches.keys().next().value;
      if (oldest !== undefined) clearStructuredRetry(oldest);
    }
    structuredRetryPatches.set(childId, { ...(structuredRetryPatches.get(childId) ?? {}), ...patch });
    if (structuredRetryTimers.has(childId)) return;
    const delay = STRUCTURED_WRITE_RETRY_DELAY_MS * 2 ** (attempt - 1);
    const timer = setTimeout(() => {
      structuredRetryTimers.delete(childId);
      const pending = structuredRetryPatches.get(childId);
      if (pending === undefined) return;
      structuredRetryPatches.delete(childId);
      writeStructuredPatch(childId, pending, attempt);
    }, delay);
    try { timer?.unref?.(); } catch {}
    structuredRetryTimers.set(childId, timer);
  }

  /**
   * 写入结构化结果补丁（与 usage/route 共用同一合并写入口）。
   *
   * - 记录已存在 provider/model：直接合并写 child_models.structured/outputSchemaRequested；
   * - 记录尚未落盘：先放有界内存表，等 agent/created / persistChildDispatch 完成基础记录
   *   写入后再补，避免写出缺少 provider/model 的非法 domain 记录；
   * - 写失败：保留补丁并在有界预算内退避重试（而不是像旧实现那样只告警一次就丢失），
   *   但绝不把失败升级成 child/task 结算异常；
   * - attempt 只由重试路径传入：>0 表示这是重试，不再重复清零既有重试状态。
   */
  function writeStructuredPatch(childId, patch, attempt = 0) {
    if (typeof childId !== "string" || childId.length === 0) return;
    if (attempt === 0) clearStructuredRetry(childId);
    const record = childModelRecordOf(childId);
    if (typeof record?.provider === "string" && record.provider.length > 0
      && typeof record?.model === "string" && record.model.length > 0) {
      void writeChildModelPatch(childId, patch, { rethrow: true }).then(
        () => { clearStructuredRetry(childId); },
        (error) => {
          logger.warn("dsh-expert-group: structured result persistence failed: " + (error instanceof Error ? error.message : String(error)));
          scheduleStructuredRetry(childId, patch, attempt + 1);
        },
      ).catch((error) => {
        // 兜底：重试调度自身抛错也不能产生未处理 rejection（旁路持久化绝不升级异常）。
        logger.warn("dsh-expert-group: structured result retry scheduling failed: " + (error instanceof Error ? error.message : String(error)));
      });
      return;
    }
    if (!pendingStructuredPatches.has(childId) && pendingStructuredPatches.size >= PENDING_STRUCTURED_LIMIT) {
      const oldest = pendingStructuredPatches.keys().next().value;
      if (oldest !== undefined) pendingStructuredPatches.delete(oldest);
    }
    pendingStructuredPatches.set(childId, { ...(pendingStructuredPatches.get(childId) ?? {}), ...patch });
  }

  /** 基础 child_models 记录写入完成后补写待处理的 structured 补丁。 */
  function flushPendingStructuredPatch(childId) {
    if (!pendingStructuredPatches.has(childId)) return;
    const record = childModelRecordOf(childId);
    if (typeof record?.provider !== "string" || record.provider.length === 0
      || typeof record?.model !== "string" || record.model.length === 0) return;
    const patch = pendingStructuredPatches.get(childId);
    pendingStructuredPatches.delete(childId);
    // 复写入口而不是直接写：基础记录已存在 → 走带重试的直接写入分支。
    writeStructuredPatch(childId, patch);
  }

  /** 结构化结果回退补丁（只带 fallback/reason/可选 bytes，不保存 value）。 */
  function structuredFallbackPatch(reason, bytes) {
    return {
      structured: {
        fallback: true,
        reason,
        ...(Number.isSafeInteger(bytes) && bytes >= 0 ? { bytes } : {}),
      },
      outputSchemaRequested: true,
    };
  }

  /**
   * 把 activation.result 归一成持久化补丁（票据 30）。
   *
   * - 无 structured：missing_structured（宿主可能把 stopReason 改 error，但文本仍有效）；
   * - structured 非无损 JSON：result_unavailable；
   * - 序列化 > 64KiB：result_too_large，只记字节数；
   * - 正常：value + bytes + receivedAt。
   */
  function structuredPatchFromActivationResult(result) {
    if (result === null || typeof result !== "object" || !Object.prototype.hasOwnProperty.call(result, "structured")
      || result.structured === undefined) {
      return structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.MISSING_STRUCTURED);
    }
    let serialized;
    try {
      serialized = JSON.stringify(result.structured);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      return structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE);
    }
    const bytes = utf8ByteLength(serialized);
    if (bytes > OUTPUT_SCHEMA_MAX_BYTES) {
      return structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_TOO_LARGE, bytes);
    }
    let value;
    try { value = JSON.parse(serialized); } catch {
      return structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE, bytes);
    }
    return { structured: { value, bytes, receivedAt: Date.now() }, outputSchemaRequested: true };
  }

  /**
   * 启动成功后**立即**挂接 result，绝不 await（票据 30）。
   *
   * 工具 execute 只返回 admission；结果在后台按 Promise 回调写入 child_models。
   * rejection 被显式消费，因此不会产生未处理 rejection，也不改写 child 的既有结算。
   */
  function armStructuredResultCapture(activation, request) {
    if (!structuredRequestedOfRequest(request)) return;
    const childId = activation?.childId;
    if (typeof childId !== "string" || childId.length === 0) return;
    const meta = structuredRequestMeta.get(request);
    if (meta?.notRestored === true) {
      writeStructuredPatch(childId, structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.SCHEMA_NOT_RESTORED));
      return;
    }
    const result = activation?.result;
    if (result === null || typeof result !== "object" || typeof result.then !== "function") {
      writeStructuredPatch(childId, structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE));
      return;
    }
    Promise.resolve(result).then(
      (value) => { writeStructuredPatch(childId, structuredPatchFromActivationResult(value)); },
      () => { writeStructuredPatch(childId, structuredFallbackPatch(STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE)); },
    ).catch((error) => {
      logger.warn("dsh-expert-group: structured result capture failed: " + (error instanceof Error ? error.message : String(error)));
    });
  }

  /** 卸载清理：结构化结果待写补丁表（容器本体不出模块）。 */
  function clearPendingStructuredPatches() {
    pendingStructuredPatches.clear();
  }

  return {
    markStructuredRequest,
    structuredRequestedOfRequest,
    armStructuredResultCapture,
    writeStructuredPatch,
    flushPendingStructuredPatch,
    clearAllStructuredRetries,
    clearPendingStructuredPatches,
  };
}

/**
 * 上下文继承通道解析（fork provider 能力位、父日志已完成 turn、持久化目标复解析）。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} deps.subagents - subagent 服务（provider 注册名与能力位）。
 * @param {object} deps.storage - settings 读投影（inheritContext 配置）。
 * @param {Function} deps.storage.readSettingsSource - 读 settings 快照。
 * @returns {object} 上下文继承能力面。
 */
export function createExpertChannelResolver({ subagents, storage }) {
  const settingsSource = () => storage.readSettingsSource();
  /**
   * 构造上下文继承的结构化错误（票据 29）。
   *
   * 错误同时带 `code` 与 `validation` 之外的显式标记；消息只含用户可读原因与
   * “重新派发”指引，不包含 prompt、会话内容或宿主原始错误正文。
   *
   * @param {string} message - 用户可读原因。
   * @param {string} code - CONTEXT_INHERITANCE_ERROR_CODES 之一。
   * @returns {Error} 带稳定 code 的错误。
   */
  function contextInheritanceError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.validation = true;
    return error;
  }

  /** 目标 subagent provider 名：只接受非空字符串（配置/注册面可能给出任意值）。 */
  function validSubagentProviderName(value) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 128
      ? value.trim()
      : void 0;
  }

  /**
   * 宿主当前注册的 provider 名列表。
   *
   * rc.2 的 SubagentService 公开 `list()`（返回注册名、插入顺序）；旧替身可能没有
   * 该 seam，此时返回 undefined，调用方只按默认名探测。绝不用私有 map 或猜测
   * provider 名。
   *
   * @returns {string[]|undefined} 注册名数组；seam 缺失/抛错/形状非法时 undefined。
   */
  function registeredSubagentProviderNames() {
    if (typeof subagents.list !== "function") return void 0;
    try {
      const names = subagents.list();
      if (!Array.isArray(names)) return void 0;
      return names.filter((name) => typeof name === "string" && name.trim().length > 0);
    } catch {
      return void 0;
    }
  }

  /**
   * provider 是否具备“继承父上下文”的全部能力位（票据 29 / 契约报告 §3.1）。
   *
   * 判定只看公开形状：
   * - inheritsParentContext === true（描述性字段，但必须由 provider 自己声明）；
   * - prepareContinuable 是函数（local/continuable 路径）；
   * - capabilities.agentOptions / depthLimit 都为 true。
   *
   * 刻意不要求 agentPreset：官方 fork provider 的 agentPreset=false，且 DEG 从不为
   * 继承型 child 传 preset。也不在这里调用 prepareContinuable（那属于宿主 manager
   * 的启动路径，DEG 只做只读能力探测）。
   *
   * @param {object|undefined} provider - 已注册 provider。
   * @returns {boolean} 是否可用于上下文继承。
   */
  function providerInheritsParentContext(provider) {
    if (provider === void 0 || provider === null) return false;
    const caps = provider.capabilities ?? {};
    return provider.inheritsParentContext === true
      && typeof provider.prepareContinuable === "function"
      && caps.agentOptions === true
      && caps.depthLimit === true;
  }

  /**
   * 解析继承型 subagent provider 的注册名（票据 29）。
   *
   * 规则（绝不猜）：
   * 1. 若名为 "fork" 的 provider 满足全部能力位 → 用它（官方默认名）；
   * 2. 否则按能力位收集全部候选：
   *    - 恰好一个 → 用它（宿主可能自定义了 providerName）；
   *    - 多个 → 仅当恰好一个名字包含 "fork"（不区分大小写）时用它；
   *    - 其余情况（无候选 / 多个 fork 命名 / 多个无 fork 命名）→ 显式不可用。
   *
   * @returns {string} 可用的继承型 provider 名。
   * @throws {Error} code=CONTEXT_INHERITANCE_UNAVAILABLE。
   */
  function resolveInheritingSubagentProviderName() {
    const preferred = "fork";
    const providerOf = (name) => {
      try { return subagents.getProvider(name); } catch { return void 0; }
    };
    if (providerInheritsParentContext(providerOf(preferred))) return preferred;
    const registered = registeredSubagentProviderNames();
    const names = registered === void 0 ? [preferred] : registered;
    const candidates = [];
    for (const name of names) {
      if (name === preferred) continue;
      if (providerInheritsParentContext(providerOf(name))) candidates.push(name);
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const forkish = candidates.filter((name) => /fork/i.test(name));
      if (forkish.length === 1) return forkish[0];
    }
    throw contextInheritanceError(
      "当前宿主没有可用的上下文继承 provider（需要 inheritsParentContext=true、"
        + "prepareContinuable 以及 agentOptions/depthLimit 能力位）；"
        + "请改用普通专家或重新派发",
      CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
    );
  }

  /**
   * 读取父会话的完整事件日志（与宿主 fork provider 的 `completedTurnPrefix` 同源）。
   *
   * 优先使用 Session.snapshotEvents()（rc.2 上 fork provider 读的就是它）；没有该
   * 方法时回落到公开的 `session.events` 数组。只读，不复制事件、不构造 seed。
   *
   * @param {object|undefined} parent - 调用派发的父代理。
   * @returns {Array|undefined} 事件数组；日志不可读时 undefined。
   */
  function parentSessionEvents(parent) {
    const session = parent?.session;
    if (session === null || typeof session !== "object") return void 0;
    if (typeof session.snapshotEvents === "function") {
      try {
        const events = session.snapshotEvents();
        return Array.isArray(events) ? events : void 0;
      } catch {
        return void 0;
      }
    }
    return Array.isArray(session.events) ? session.events : void 0;
  }

  /**
   * 派发前检查父会话是否已有“已完成的 turn”（票据 29）。
   *
   * 宿主 fork provider 找不到 turn/end 时会静默返回空 seed，子代理按 fresh 启动；
   * 因此 DEG 必须在派发前用同一日志来源确认存在最后一个 turn/end。检查只读：
   * 不切边界、不调用 buildForkSeed、不复制父历史——边界与 seed 完全交给 provider。
   *
   * 进行中的 turn 不影响本检查：最后一个 turn/end（含）之后的 tail 由 provider 排除；
   * 只要存在任何一个 turn/end 就可以安全继承。
   *
   * @param {object|undefined} parent - 父代理。
   * @throws {Error} code=CONTEXT_INHERITANCE_EMPTY（无已完成 turn）或
   *   CONTEXT_INHERITANCE_UNAVAILABLE（日志不可读）。
   */
  function assertParentHasCompletedTurn(parent) {
    const events = parentSessionEvents(parent);
    if (events === void 0) {
      throw contextInheritanceError(
        "当前会话无法读取已完成 turn 日志，无法继承上下文；请改用普通专家或重新派发",
        CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
      );
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn/end") return;
    }
    throw contextInheritanceError(
      "当前会话还没有已完成的 turn，无法继承上下文；请先完成一轮对话后重新派发",
      CONTEXT_INHERITANCE_ERROR_CODES.EMPTY,
    );
  }

  /**
   * 角色是否开启了上下文继承（票据 29）。
   *
   * 读取面已丢弃 Observer/未知角色键与非法值；这里再显式排除 Observer，
   * 即便设置被外部写成 true 也强制关闭（Observer 的安全边界不依赖设置校验）。
   *
   * @param {string} role - 角色 id。
   * @returns {boolean} 是否继承父上下文。
   */
  function roleInheritsContext(role) {
    if (typeof role !== "string" || role.length === 0) return false;
    if (role === "observer") return false;
    if (!CONTEXT_INHERITANCE_ROLE_IDS.includes(role)) return false;
    let snapshot;
    try { snapshot = settingsSource(); } catch { return false; }
    return snapshot?.inheritContext?.[role] === true;
  }

  /**
   * 解析一次派发应使用的 subagent provider 与继承开关（票据 29）。
   *
   * - Observer 永远 spawn（即使设置被外部写成 true）；
   * - 未开启继承的角色继续使用既有 spawn provider（保留 spawnProviderReady 语义）；
   * - 开启继承的角色必须使用合格的继承型 provider，并在派发前确认父日志存在
   *   已完成 turn；任何一项不成立都显式失败，绝不静默回退 spawn。
   *
   * @param {string} role - 角色 id。
   * @param {object} parent - 实际父代理（seed 来源）。
   * @returns {{provider: string, inheritContext: boolean}} 目标 provider 与继承标记。
   */
  function resolveSubagentProviderForRole(role, parent) {
    if (!roleInheritsContext(role)) return { provider: "spawn", inheritContext: false };
    // 先确认 provider 可用再检查 seed：宿主没有继承能力时应报告“不可用”，
    // 而不是先要求用户完成一轮对话（两件事的修复动作不同）。
    const provider = resolveInheritingSubagentProviderName();
    assertParentHasCompletedTurn(parent);
    return { provider, inheritContext: true };
  }

  /**
   * 按已持久化的 child_models 快照解析恢复/重建目标（票据 29）。
   *
   * 恢复路径**只读**快照，绝不按当前设置重新选择：
   * - 普通 spawn child 继续用它记录的非继承 provider（旧记录缺失时按 "spawn"）；
   * - 原继承型 child 必须重新拿到合格的继承 provider；记录里的 provider 已不可用时
   *   显式失败并提示重新派发，绝不静默改成 spawn（那会丢失已继承的上下文）；
   * - Observer 永远是非继承通道（即使记录被外部篡改为 true）。
   *
   * @param {string} role - 角色 id。
   * @param {object} parent - 恢复时的父代理（seed 来源）。
   * @param {object|undefined} persisted - child_models 记录（可含 subagentProvider/inheritContext）。
   * @returns {{provider: string, inheritContext: boolean}} 目标 provider 与继承标记。
   */
  function resolvePersistedSubagentTarget(role, parent, persisted) {
    const recordedProvider = validSubagentProviderName(persisted?.subagentProvider);
    if (role === "observer") return { provider: "spawn", inheritContext: false };
    if (persisted?.inheritContext !== true) {
      return { provider: recordedProvider ?? "spawn", inheritContext: false };
    }
    if (!CONTEXT_INHERITANCE_ROLE_IDS.includes(role)) {
      throw contextInheritanceError(
        "无法恢复继承型专家：角色 " + String(role) + " 不允许继承上下文；请重新派发普通专家",
        CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
      );
    }
    let provider;
    if (recordedProvider !== void 0) {
      let recorded;
      try { recorded = subagents.getProvider(recordedProvider); } catch { recorded = void 0; }
      if (!providerInheritsParentContext(recorded)) {
        throw contextInheritanceError(
          "无法恢复继承型专家：原 provider \"" + recordedProvider + "\" 已不可用（宿主未注册或不支持继承）；"
            + "请重新派发该任务以重新选择继承通道",
          CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
        );
      }
      provider = recordedProvider;
    } else {
      // 理论上的旧/手工记录：没有 provider 名但有继承标记时，只能按能力位重新解析。
      provider = resolveInheritingSubagentProviderName();
    }
    assertParentHasCompletedTurn(parent);
    return { provider, inheritContext: true };
  }

  return {
    contextInheritanceError,
    validSubagentProviderName,
    providerInheritsParentContext,
    resolveSubagentProviderForRole,
    resolvePersistedSubagentTarget,
  };
}

/**
 * DEG-only 的双契约启动适配器（RC1 startActivation / legacy startContinuable）。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} deps.subagents - subagent 服务。
 * @param {object} deps.channel - 上下文继承能力面（provider 名归一与继承错误构造）。
 * @param {object} deps.structured - 结构化结果能力面（启动后挂接 result）。
 * @returns {object} 启动能力面。
 */
export function createExpertActivationStarter({ subagents, channel, structured }) {
  const { contextInheritanceError, validSubagentProviderName } = channel;
  const { armStructuredResultCapture } = structured;
  /**
   * DEG-only 的双契约启动适配器。
   *
   * startActivation 存在时只组装 RC1 公共字段：request 仅剥离顶层 label 与 signal
   * （label 走 spec.label、signal 走 spec.signal），其余字段原样透传。persona 与
   * toolFilter 是 RC1 的 child composition 注入字段——宿主在 child scope 上应用
   * 它们（persona → child 系统提示词 section，toolFilter → childCtx.tools.restrict），
   * 因此既不能剥离，也不能把 persona 拼进首条任务消息：任务消息只保留
   * buildExpertTaskPrompt 生成的「身份行 + 任务内容」两段。delivery 固定为 parent，
   * 让 DSH manager 负责 parent notification 和 activation 生命周期。
   * startActivation 本身抛错时原样上抛，只有方法不存在才回退旧 startContinuable，
   * 避免把 admission 错误伪装成兼容路径。
   */
  async function startExpertActivation({ request, label, signal }) {
    // 目标 subagent provider（票据 29）：唯一来源是请求上的内部字段，所有调用点
    // （角色工具、fan-out 分片、恢复重建）在组装请求时写入同一份值。它只用于选择
    // 宿主 provider，必须在调用宿主前剥离，绝不作为 SubagentStartRequest 字段透传。
    const targetProvider = validSubagentProviderName(request?.subagentProvider) ?? "spawn";
    // 继承型 provider 由 provider 自己按父日志构造 seed；DEG 只选择 provider、
    // 传入 shard/persona/toolFilter 等既有字段，绝不添加 agentPreset（官方 fork 的
    // agentPreset 能力位为 false），也绝不自行调用 prepareContinuable/buildForkSeed。
    if (typeof subagents.startActivation === "function") {
      // RC1 manager 会在 admission 前直接调用 signal.throwIfAborted()；缺失或不完整的 signal
      // 必须在 DEG 边界 fail-closed，不能把 RC1 合同错误伪装成 legacy fallback。
      if (signal === void 0 || signal === null || typeof signal.throwIfAborted !== "function") {
        throw new TypeError("RC1 startActivation requires an AbortSignal");
      }
      const {
        label: _requestLabel,
        signal: _requestSignal,
        subagentProvider: _requestProvider,
        ...activationRequest
      } = request ?? {};
      const activation = await subagents.startActivation({
        provider: targetProvider,
        label: typeof label === "string" ? label : request?.label,
        request: activationRequest,
        signal,
        delivery: "parent",
      });
      // 结构化交付（票据 30）：启动成功即挂接 result，绝不在这里 await 完整结果。
      // request 上的 outputSchema 原样透传给宿主；child_models 只写 structured/标记。
      armStructuredResultCapture(activation, request);
      return activation;
    }
    if (typeof subagents.startContinuable === "function") {
      // legacy 路径只支持 spawn：它没有 provider 级 seed 语义，把它用于 fork
      // 等于静默丢失上下文。请求了继承（或目标 provider 不是 spawn）时明确失败。
      if (targetProvider !== "spawn" || request?.agentOptions?.[EXPERT_INHERIT_CONTEXT_MARKER] === true) {
        throw contextInheritanceError(
          "当前宿主只有 legacy startContinuable 启动路径，不支持上下文继承（provider=" + targetProvider
            + "）；请改用普通专家或重新派发",
          CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE,
        );
      }
      // legacy 宿主同样不能看到 DEG 的内部 provider 选择字段；其余既有字段
      // （label/signal/persona/toolFilter/maxDepth）保持原样，兼容旧契约。
      const { subagentProvider: _legacyProvider, ...legacyRequest } = request ?? {};
      return subagents.startContinuable({
        provider: targetProvider,
        label: typeof label === "string" ? label : request?.label,
        request: legacyRequest,
        signal,
      });
    }
    throw new Error("subagent provider \"" + targetProvider + "\" has no supported activation method");
  }

  return { startExpertActivation };
}

/**
 * admission 事实面：provider 就绪、deny 边界收窄、route key、快照恢复、图片归一。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} deps.tools - 工具服务（可见性与 restrictable 名称）。
 * @param {object} deps.subagents - subagent 服务。
 * @param {object} deps.storage - settings/storage 读投影（快照恢复来源）。
 * @param {Function} deps.getAttachmentStore - 附件服务晚绑定句柄。
 * @param {object} deps.channel - 上下文继承能力面（route key 的 provider 归一）。
 * @returns {object} admission 事实能力面。
 */
export function createExpertAdmissionFacts({ tools, subagents, storage, getAttachmentStore, channel }) {
  const source = () => storage.readSnapshot();
  const { validSubagentProviderName } = channel;
  /**
   * spawn provider 是否具备本工具用到的全部能力。
   *
   * RC1 把角色人格和工具过滤从 provider capability 中移除，并由公开
   * subagents.startActivation 负责 admission；旧 Host/测试替身仍可能只提供
   * startContinuable + persona/toolFilter。两套契约都必须严格按其自身字段判断，
   * 不能因为 RC1 已有 prepareContinuable 就误把缺少启动 seam 的 provider 当成可用。
   */
  function spawnProviderReady() {
    const provider = subagents.getProvider("spawn");
    if (provider === void 0) return false;
    const caps = provider.capabilities ?? {};
    // startActivation 一旦存在即是 RC1 实际 seam；即使 legacy 能力完整，
    // RC1 capability 不完整也必须 fail-closed，不能报告 ready 后再误走 RC1。
    if (typeof subagents.startActivation === "function") {
      return typeof provider.prepareContinuable === "function"
        && caps.agentOptions === true
        && caps.depthLimit === true;
    }
    return typeof provider.prepareContinuable === "function"
      && caps.depthLimit === true
      && caps.toolFilter === true
      && caps.persona === true
      && typeof subagents.startContinuable === "function";
  }

  /**
   * 计算此刻应拒绝的工具名。
   *
   * tools.restrict() 对「未知工具名」直接抛错，而 bash/pwsh 按平台门控、workflow 属
   * agent preset（隔离域）注册，任何一项都可能不在当前组合里。因此这里必须按宿主自己的
   * 准入判据过滤：优先使用父 agent scope 视图的 restrictableNames（与 restrict() 内部
   * 同一集合：全局层 + 祖先层，own 层名称会被排除）；宿主没有 view() 时回退到全局
   * 可见性探针（tools.get 无作用域即全局视图）。两条路径都不把 run_code 交给 restrict。
   *
   * @param parent - 调用工具的子代理父代理（Agent 对象），同时作为视图作用域。
   * @param denyList - 静态候选列表（EXPERT_DELEGATION_DENY 或 READONLY_DENY）。
   */
  function effectiveDeny(parent, denyList, includeDynamicMcp = false) {
    const isVisible = (toolName) => {
      try {
        return typeof tools.get === "function" && tools.get(toolName) !== void 0;
      } catch {
        return false;
      }
    };
    const restrictableNames = restrictableScopeNames(tools, parent);
    if (includeDynamicMcp) {
      // DSH restriction 只支持精确名称；只读 child 必须先取得完整可见 schema，
      // 否则无法证明动态 MCP 工具已被覆盖，直接拒绝 admission。child 自有
      // guard 还会在后续执行边界拒绝新注册的 mcp__ 名称。
      if (typeof tools.schemas !== "function") {
        throw new Error("只读专家无法取得工具 schema，已拒绝启动以保持动态 MCP fail-closed");
      }
      let visibleSchemas;
      try {
        visibleSchemas = tools.schemas(parent);
      } catch (error) {
        throw new Error("只读专家工具 schema 查询失败，已拒绝启动以保持动态 MCP fail-closed", { cause: error });
      }
      if (!Array.isArray(visibleSchemas) || visibleSchemas.some((schema) => typeof schema?.name !== "string" || schema.name.length === 0)) {
        throw new Error("只读专家工具 schema 不完整，已拒绝启动以保持动态 MCP fail-closed");
      }
      return restrictableDenyNamesInScope(readonlyDenyCandidates(denyList, visibleSchemas), restrictableNames, isVisible);
    }
    return restrictableDenyNamesInScope(denyList, restrictableNames, isVisible);
  }

  /**
   * 专家 admission 的完整 deny 边界。
   *
   * - 只读角色（含未知角色）：READONLY_DENY，并并入全部动态 MCP 工具
   *   （includeDynamicMcp=true，fail-closed）；
   * - 可写角色：EXPERT_DELEGATION_DENY + ROOT_ONLY_TOOL_DENY。
   *
   * @param {object} parent - 调用工具的子代理父代理（Agent 对象）。
   * @param {object|undefined} roleEntry - 角色目录里的记录（未知按只读）。
   * @returns {string[]} 可交给 tools.restrict() 的 deny 名单。
   */
  function expertDenyForAdmission(parent, roleEntry) {
    const candidates = expertDenyCandidates(roleEntry);
    const readOnlyRole = roleEntry === void 0 || roleEntry.readOnly === true;
    return effectiveDeny(parent, candidates, readOnlyRole);
  }

  /**
   * route 的稳定序列化 key：provider/model/reasoningEffort 三者任一变化
   * 都视为 route 改变（例如用户在侧边栏换了模型），既有 child 不可再复用。
   */
  function routeKeyOf(selection) {
    // 上下文继承（票据 29）：目标 subagent provider 与继承开关也属于 route 的一部分。
    // 旧 child_models 记录没有这两个字段时按 "spawn"/false 归一，保证升级前创建的
    // spawn child 仍能被同 route 复用；继承开关一旦改变就必然产生新 key，旧 child
    // 不会被静默续作（其 seed 语义与新派发不同）。
    return JSON.stringify({
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort === void 0 ? null : selection.reasoningEffort,
      subagentProvider: validSubagentProviderName(selection.subagentProvider) ?? "spawn",
      inheritContext: selection.inheritContext === true,
    });
  }

  /**
   * 重启恢复：从 domain childModels 中按 parentId + role + route 找可复用的
   * continuable child。显式 lruSequence 决定新旧；历史缺失序号的记录按 key
   * 稳定排序，绝不依赖 JSON/SQLite 的 entries 插入顺序。
   */
  function restoreChildFromSnapshot(parentId, roleName, routeKey) {
    const models = source().childModels ?? {};
    const entries = Object.entries(models).sort(([leftId, left], [rightId, right]) => {
      const leftSequence = Number.isInteger(left?.lruSequence) && left.lruSequence >= 0 ? left.lruSequence : void 0;
      const rightSequence = Number.isInteger(right?.lruSequence) && right.lruSequence >= 0 ? right.lruSequence : void 0;
      if (leftSequence !== void 0 && rightSequence !== void 0 && leftSequence !== rightSequence) return leftSequence - rightSequence;
      if (leftSequence === void 0 && rightSequence !== void 0) return -1;
      if (leftSequence !== void 0 && rightSequence === void 0) return 1;
      const leftKey = String(leftId);
      const rightKey = String(rightId);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    for (let i = entries.length - 1; i >= 0; i--) {
      const [childId, record] = entries[i];
      if (typeof record !== "object" || record === null) continue;
      // fan-out child 的 parentTask/shard/attempt 是另一条恢复链；即使 role、
      // parentId 和 route 相同，也绝不能被普通专家 recovery 复用。
      if (isFanoutIdentity(record)) continue;
      if (record.continuable !== true) continue;
      if (record.role !== roleName || record.parentId !== parentId) continue;
      if (routeKeyOf(record) === routeKey) return childId;
    }
    return void 0;
  }

  /**
   * 判断 image.attachment 元数据是否为“空/占位”输入（主代理没有真实图片时
   * 仍构造出来的假 attachment）。判定标准：
   * - attachment 缺失或不是对象；
   * - attachmentId 不是字符串或 trim 后为空（真实 durable ref 一定是非空 id）；
   * - bytes/width/height 不是正的安全整数（真实图片不可能是 0 或负尺寸）；
   * - attachmentId 或 name 显式使用 "placeholder"（模型自造的占位命名，
   *   真实附件 id 是 Host 生成的 sha/ref 形式）。
   * 命中任一条件即视为“没有图片”，调用方应忽略 image 参数并按纯文本任务
   * 继续，而不是让 admission 失败导致子代理无法拉起。
   */
  function isEmptyImagePlaceholderMeta(meta) {
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return true;
    const id = typeof meta.attachmentId === "string" ? meta.attachmentId.trim() : "";
    if (id.length === 0) return true;
    if (!Number.isSafeInteger(meta.bytes) || meta.bytes <= 0) return true;
    if (!Number.isSafeInteger(meta.width) || meta.width <= 0) return true;
    if (!Number.isSafeInteger(meta.height) || meta.height <= 0) return true;
    if (id.toLowerCase() === "placeholder") return true;
    const name = typeof meta.name === "string" ? meta.name.trim().toLowerCase() : "";
    if (name === "placeholder" || name === "placeholder.png" || name.startsWith("placeholder.")) return true;
    return false;
  }

  /**
   * 从 role tool 的 image 参数推导路由阶段的输入类型要求（票据 24）。
   *
   * 只有“真实图片”才要求 image 能力：
   * - undefined/null/非对象/数组/空占位 attachment → 无要求（与 admission 的
   *   “按无图片处理并给出 scopeWarning”完全一致，绝不把占位参数泄漏成 image 路由）；
   * - 非空 pngPath → 无要求（后续 admission 仍按既有错误拒绝客户端指定的路径，
   *   路由阶段不需要为一张会被拒绝的输入换模型）；
   * - 其它 → { inputModalities: ["image"] }，由 executeModelRoutePlan 要求
   *   image === "supported" 才选中该候选。
   */
  function imageRequirementsOf(image) {
    if (image === void 0 || image === null || typeof image !== "object" || Array.isArray(image)) return undefined;
    if (typeof image.pngPath === "string" && image.pngPath.length > 0) return undefined;
    if (isEmptyImagePlaceholderMeta(image.attachment)) return undefined;
    return { inputModalities: ["image"] };
  }

  /**
   * 拼接两段 scopeWarning 来源（delegationTracker 范围软警告 + 忽略占位 image 的提示）。
   * 空串/undefined 一律忽略；两段都在时以单个空格连接，保证任一来源的警告都不会被
   * 另一来源的对象展开覆盖丢失。
   */
  function mergeScopeWarnings(scopeWarning, ignoredImageWarning) {
    const parts = [];
    if (typeof scopeWarning === "string" && scopeWarning.length > 0) parts.push(scopeWarning);
    if (typeof ignoredImageWarning === "string" && ignoredImageWarning.length > 0) parts.push(ignoredImageWarning);
    return parts.length === 0 ? "" : parts.length === 1 ? parts[0] : parts[0] + " " + parts[1];
  }

  /**
   * 准备任意专家 role 的图片引用。DSH 本地对象路径没有扩展名，显示名只是元数据，
   * 因此无论 name 是否带后缀，都先读回真实字节并保存新的 PNG durable ref。
   * 原始 ref 不被修改；没有公开附件服务或真实转码器时明确失败并保留输入。
   *
   * 图片能力校验在 admission 调用方完成；这里专注于 Host-owned 字节读取、签名校验
   * 和 durable 副本创建，保证 role tool 与浏览器 Observer 路由共享同一安全边界。
   */
  async function prepareRoleImage(image, signal, role = "专家") {
    const label = typeof role === "string" && role.trim().length > 0 ? role.trim() : "专家";
    const original = image?.attachment;
    // 附件服务是可选注入：每次调用现读同一晚绑定句柄（与迁移前同一闭包语义）。
    const attachmentStore = getAttachmentStore();
    if (!original || typeof original !== "object") throw new Error(`${label} 图片输入缺少 attachment ref；原始输入已保留`);
    if (attachmentStore === void 0 || typeof attachmentStore.readImage !== "function" || typeof attachmentStore.saveImage !== "function") {
      throw new Error(`${label} 图片缺少公开附件服务，无法安全创建 PNG 副本；原始输入已保留`);
    }
    const stored = await attachmentStore.readImage(original, signal);
    if (!stored || !(stored.data instanceof Uint8Array) || !stored.ref) {
      throw new Error("附件服务没有返回可验证的图片字节；原始输入已保留");
    }
    const normalized = await normalizeImageToPng({
      attachment: { ...stored.ref, name: original.name },
      data: stored.data,
      transcodeToPng: (data) => transcodeImageToPng(data),
      savePng: (input) => attachmentStore.saveImage(input),
      forceCopy: true,
    });
    return normalized.attachment;
  }

  return {
    spawnProviderReady,
    effectiveDeny,
    expertDenyForAdmission,
    routeKeyOf,
    restoreChildFromSnapshot,
    isEmptyImagePlaceholderMeta,
    imageRequirementsOf,
    mergeScopeWarnings,
    prepareRoleImage,
  };
}

/**
 * 委派核心域装配：组合上面四组能力面，交出 role / fan-out 工具共用的扁平 API。
 *
 * 组合本身不持有状态，也不做注册；参数按**协作方**计 5 组（tools / subagents /
 * storage / attachments / logger），低于 C3 硬上限 8。
 *
 * @param {object} deps - 组合根窄能力面。
 * @returns {object} 委派核心域能力面。
 */
export function createIndexExpertToolsCore(deps) {
  const { tools, subagents, storage, getAttachmentStore, logger } = deps;
  const schemas = createExpertOutputSchemaSupport({ subagents });
  const structured = createExpertStructuredResults({ storage, logger });
  const channel = createExpertChannelResolver({ subagents, storage });
  const activation = createExpertActivationStarter({ subagents, channel, structured });
  const facts = createExpertAdmissionFacts({ tools, subagents, storage, getAttachmentStore, channel });
  return { ...schemas, ...structured, ...channel, ...activation, ...facts };
}
