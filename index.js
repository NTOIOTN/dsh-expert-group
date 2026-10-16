import z from "@deepseek-ai/schemastery";
import { z as domainZ } from "zod";
import { randomUUID } from "node:crypto";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import {
  CHILD_LRU_LIMIT,
  createBindingController,
  createInitializationGate,
  persistDomainEntry,
  persistLruEntry,
  readDomainSnapshot,
} from "./storage.js";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildObserverVisualTask, buildRoleToolDescription, DEFAULT_EXPERT_PERSONA, resolveExpertPersona } from "./prompt-contracts.js";
import {
  createFanoutRuntime,
  FANOUT_MARKER,
  FANOUT_PARENT_TASK_MARKER,
  FANOUT_PARENT_AGENT_MARKER,
  FANOUT_SHARD_MARKER,
  FANOUT_ATTEMPT_MARKER,
  isFanoutAgent,
  isFanoutIdentity,
} from "./fanout-host.js";

import {
  RPC_PATH, RPC_CHANNEL, RPC_ENDPOINT, READONLY_DENY, EXPERT_DELEGATION_DENY, ROOT_ONLY_TOOL_DENY,
  TASK_BINDING_LIMIT, CLAIMED_LIMIT, AUTO_RECOVERY_LIMIT, FEEDBACK_DELIVERY_LIMIT, createFeedbackIdentityLedger,
  createRequestRetryState, resetRequestRetryState, markRequestRetryEvent,
  isTransientRequestFailure, recoveryDelayForCount, requestRetryPolicyCoversFailure,
  appendRecoveryRetryCount, buildRecoveryMessage, classifyTurnOutcome, lastTurnErrorMessage,
  subagentFeedbackChildId, createAdmissionBatchCoordinator, createHandoffAdmissionCohort,
  rootStructuredPathGuard, snapshotRunningRootDescendants, collectRuntimeRootDescendants,
  messageIdsOfTurnWithClaimed, shouldAutoRecover, turnHasNonEmptyText,
  createDelegationTracker, delegationScopeKey, delegationTaskKey,
  createRecoveryOp, clearRecoveryOpTimer, scheduleRecoveryOpTimer, findRecoveryOpByMessage, recoveryOpPendingForTurn, recoveryOpIsPending,
  recoveryDispatchCanStart, recoveryOpIsAccepted, recoveryOpCanBeSuperseded, interruptFailureCanFallback,
  isSubagentCapacityError, createSubagentCapacityError, describeSubagentCapacityFailure, SUBAGENT_CAPACITY_MESSAGE,
  applyTurnToTasks, taskKeysForTurn, supersedeTaskBindings, rebindPendingTaskByClaimed, evictOldestEntries,
  shouldRebuildRecoveryChild, shouldInstallRebuiltChild, recoveryRebuildCanCommit, sameDurableSessionId, createSessionGenerationState, createHandoffFailureRegistry, restrictableDenyNames, readonlyDenyCandidates, isReadonlyDynamicMcpName,
  rememberClaimedPlaceholder, takePendingCreation, rollbackCreatedChildAcceptance, shouldForgetTask,
  STATUS_ROLE_IDS, PROMPT_OVERRIDES_SETTINGS_KEY, PROMPT_OVERRIDE_MAX_GRAPHEMES,
  PROMPT_OVERRIDE_INVALID_CODE, PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE,
  normalizePromptOverrides, promptOverrideFor, countPromptGraphemes,
} from "./shared.js";
import { getRole, listEnabledRoles, listRoles, requireRole } from "./role-registry.js";
import {
  channelEndpointFromPath,
  createConnectionRpcHandler,
  readClientRequestEnvelope,
  rpcIdFromEnvelopeText,
  writeServerResponseEnvelope,
} from "./rpc-host.js";
import { createHostComposition } from "./host/composition.js";
import { createSettingsRuntimeModule, SettingsDirectoryChangedError } from "./host/settings-runtime.js";
import { createRecoveryModule } from "./host/recovery.js";
import { createRootTurnWaitRegistry } from "./host/turn-wait.js";
import { createFanoutRuntimeModule } from "./host/fanout-runtime.js";
import { createExpertGroupRuntime, rootNotificationLabel } from "./host/expert-group-runtime.js";
import { createPersistenceHealth } from "./host/persistence-health.js";
import { DEFAULT_NOTIFICATION_VOLUME, SYSTEM_TOAST_REASONS, createSystemToastModule, normalizeToastVolume, terminationToastText, userWaitToastText } from "./host/system-toast.js";
import { FANOUT_BUDGET, truncateFeedbackText } from "./resource-budget.js";
import { buildOrchestratorPrompt, isRootAgentContext } from "./orchestrator.js";
import { buildImageContent, decideImageRoute, effectiveModelRoute, imageCapability, normalizeImageToPng, pngCopyName, toPngBytes } from "./image-routing.js";
/**
 * 为 RPC 请求创建可传给公开 subagents.startContinuable 的 AbortSignal。
 * 请求 body 读完后仍保留响应断开监听；正常完成时由 handleRpc 的 finally 移除监听。
 */
export function createRpcRequestLifecycle(req, res) {
  const controller = new AbortController();
  let disposed = false;
  const removers = [];
  const abort = () => {
    if (!disposed && !controller.signal.aborted) controller.abort();
  };
  const listenOnce = (target, event, handler) => {
    if (!target || typeof target.once !== "function") return;
    target.once(event, handler);
    removers.push(() => {
      if (typeof target.removeListener === "function") target.removeListener(event, handler);
      else if (typeof target.off === "function") target.off(event, handler);
    });
  };
  if (req?.aborted === true) abort();
  if (res?.destroyed === true) abort();
  listenOnce(req, "aborted", abort);
  listenOnce(req, "error", abort);
  listenOnce(req, "close", () => {
    // close 也会在正常 body 完成后触发；只有未完整解析或明确 aborted 才取消。
    if (req?.aborted === true || req?.complete !== true) abort();
  });
  listenOnce(res, "error", abort);
  listenOnce(res, "close", () => {
    // writableFinished 表示响应已经正常写完；否则是客户端提前断开。
    if (res?.writableFinished !== true) abort();
  });
  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of removers.splice(0)) remove();
    },
  };
}

function createAbortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

/**
 * 图片路由在异步边界上的 fail-fast：请求级 signal 已取消时立即抛出取消错误。
 *
 * 用于 normalize、能力查询前后、route claim 校验前后与 Observer admission 前后 ——
 * 取消必须保持 AbortError/ABORT_ERR 身份，由 mapRpcError 统一映射为 499
 * gateway/cancelled，绝不能被"能力查询失败保持 unknown"之类的兜底吞掉。
 * @param {AbortSignal|undefined} signal - 请求级取消信号。
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw createAbortError();
}

/**
 * 把一次异步失败归一成取消错误（若它属于取消）。
 *
 * `llm.resolveModelInfo` 等适配器可能抛出 AbortError/ABORT_ERR，也可能在 signal 已取消
 * 时抛出普通错误；两种都必须按取消处理。返回 undefined 表示"这是真正的非取消失败"，
 * 调用方可以继续按 unknown/main-first 兜底。
 * @param {unknown} error - 被捕获的异常。
 * @param {AbortSignal|undefined} signal - 请求级取消信号。
 * @returns {Error|undefined} 归一后的取消错误，或 undefined。
 */
function abortErrorFor(error, signal) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return error;
  return signal?.aborted === true ? createAbortError() : void 0;
}

/**
 * 判断 remote GoalService 的返回值是否为 thenable。
 *
 * shared.js 的 handoff helper 允许 service 返回 Promise 或同步结果，组合根需要在
 * 决定「等待 / 直接读结果」前做同一判定；损坏 adapter 的 then getter 也按不可兼容的
 * 异步服务处理（fail closed，绝不假装同步成功）。
 */
function isThenable(value) {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
  } catch {
    return true;
  }
}

/**
 * 等待 request fallback 的公开退避窗口。只监听 payload.signal，并在 timer 到期时
 * 再检查 Agent/Session 代次；dispose/replacement 不会把已失效 Agent 伪装成 retry 成功。
 */
function waitForRequestRetryDelay(delay, signals, isActive) {
  const setTimeoutFn = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout : void 0;
  const clearTimeoutFn = typeof globalThis.clearTimeout === "function" ? globalThis.clearTimeout : void 0;
  const signalList = Array.isArray(signals) ? signals.filter((signal) => signal !== void 0 && signal !== null) : [];
  if (!Number.isSafeInteger(delay) || delay <= 0 || signalList.some((signal) => signal.aborted === true) || !isActive()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      for (const signal of signalList) signal.removeEventListener?.("abort", onAbort);
      resolve(ready === true);
    };
    const onAbort = () => finish(false);
    for (const signal of signalList) signal.addEventListener?.("abort", onAbort, { once: true });
    timer = setTimeoutFn(() => finish(signalList.every((signal) => signal.aborted !== true) && isActive()), delay);
    if (settled && typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  });
}

/**
 * sharp 是可选依赖（package.json optionalDependencies，约 30MB 原生二进制的 libvips 绑定）：
 * 默认安装不再强制下载；需要非 PNG 图片转码（如 JPEG/WebP/GIF 上传）的用户显式安装后自动启用。
 * 未安装时图像增强禁用，但降级必须是"明确失败且不伪造 PNG"，绝不静默把原字节改名成 .png。
 *
 * 该文案同时是 RPC 层识别能力缺失的依据（见 mapRpcError），因此抽成常量，避免两处文案漂移
 * 导致 503 image-transcoder-unavailable 退化成 500 internal。
 */
const IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE = "当前 Host 没有可用的真实 PNG 转码器（sharp 为可选依赖，未安装时图像增强禁用，安装后自动启用）";

let sharpLoader;
async function transcodeImageToPng(data) {
  if (sharpLoader === void 0) {
    sharpLoader = import("sharp").then((loaded) => loaded.default ?? loaded).catch((error) => {
      // 转码器缺失时清空 rejected Promise，允许安装/热载入后重试，并向 RPC 返回可理解的能力错误。
      // 并发语义：import 进行中的调用共享同一个在途 Promise（不会重复触发加载）；一旦失败就立刻
      // 清空缓存，使"安装 sharp 后无需重启"成立——下一次调用会重新 import，成功即恢复图像增强。
      sharpLoader = void 0;
      throw new Error(IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE, { cause: error });
    });
  }
  const sharp = await sharpLoader;
  try {
    return new Uint8Array(await sharp(data, { failOn: "error" }).png().toBuffer());
  } catch (error) {
    throw new Error("图片无法真实转换为 PNG", { cause: error });
  }
}

/**
 * Host 半：dsh-expert-group 专家子代理工具，加按父会话 + 角色保存的
 * 模型覆盖，以及一个同源、仅 POST JSON 的私有 RPC 路由，供 Web 右侧侧边栏读写当前会话配置。
 * 本插件不修改 DSH 核心源码；只通过现有 Host 服务注册能力。
 * @module dsh-expert-group
 */

const name = "dsh-expert-group";
/**
 * DEG 注入会话消息时使用的生产者自有 source kind。
 *
 * 会话格式 V4 拒绝精确的 `kind: "plugin"`（旧插件包装语法），要求消息来源属于
 * 生产者自有 kind 集合。0.1.7 对未知插件的规范形式是 `plugin:<插件名>`，因此这里
 * 复用同一派生规则，而不是冒用 `subagent-*` 等第一方身份。集中定义以便源码契约
 * 测试锁定该形状，避免回归到被拒的旧写法。
 */
const PRODUCER_SOURCE_KIND = "plugin:" + name;
// RPC_ENDPOINT 只用于独立 Connection channel；旧 HTTP 路径仍由 RPC_PATH 保持兼容。

// Cordis FiberState 的稳定数值镜像。插件不导入 settings helper，避免 optional peer
// 缺失时模块加载失败；仍需区分 settings provider 脱离和插件自身卸载。
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;

function isSettingsConsumerUnloading(ctx) {
  try {
    const state = ctx.fiber?.state;
    return state === FIBER_DISPOSED || state === FIBER_UNLOADING;
  } catch {
    return false;
  }
}

// ── root turn 等待：后代查询的 sentinel ─────────────────────────────────────
/**
 * `workspace/session-activity` waterfall 的**无 provider sentinel**。
 *
 * 为什么必须有它（P0）：Cordis 的 `waterfall` 实现在**没有任何 listener** 时是
 * `(cbs.shift() ?? inner)(...args)`——即直接调用调用方传入的最内层回调。而宿主的
 * subagent provider 在「没有 running 后代」时是 `return rest`（**原样透传**最内层
 * 返回值）。因此若最内层返回 `[]`，「topic 没有 provider」与「provider 明确报告空」
 * 的返回值完全同形，会被误判成「可证明没有 running 后代」。
 *
 * 语义（模块唯一、对象身份相等才算命中）：
 * - 结果 **=== 本 sentinel** ⟹ 没有任何 listener 产出新数组 ⟹ 链路没有贡献任何事实
 *   （没有 provider，或 provider 原样透传）⟹ **无法证明**静止 ⟹ `known:false`；
 * - 结果 **不是** sentinel 的数组 ⟹ 至少有一个 listener 产出了新数组（provider 只有
 *   在真的贡献自己的族时才 `[own, ...rest]`）⟹ 链路确实跑过，可以按族解析。
 *
 * **sentinel 不足以覆盖的第二个洞（P1）**：`workspace/session-activity` 是**非专属**
 * 扩展点，任何第三方 listener 都可以返回一个**新的空数组**（既不 spread 最内层值，也
 * 不检查 subagent 血缘）。这种结果与「provider 明确报告没有 running 后代」在返回值上
 * 依旧同形，而 sentinel 只能识别「链路完全没有贡献」，识别不了「贡献者是谁」。因此
 * 判定层**不得**把任何空数组当作静止证明：waterfall 只能提供**正向**证据（确有
 * `kind === "subagent"` 的 running 条目），静止证明只来自权威 listing。
 *
 * 冻结空数组既保证 spread 安全（`[own, ...sentinel]` 不会抛错、也不会引入假条目），
 * 又保证身份唯一（`Object.freeze` 后的模块级单例不可能被外部复制）。
 */
const SESSION_ACTIVITY_NO_PROVIDER = Object.freeze([]);

// ── 只读能力矩阵与运行时诊断 ────────────────────────────────────────────────
/**
 * 诊断报告 schema 版本。
 *
 * capabilities / diagnostics 是给用户与维护者看的只读投影，不参与任何业务判定。
 * 字段语义变化时递增版本；客户端遇到未知版本必须整体忽略，绝不猜测字段含义。
 */
const CAPABILITY_REPORT_VERSION = 2;

/** 最近 RPC 错误类别的保留上限；记录有界，绝不随失败次数增长。 */
const RPC_ERROR_CATEGORY_LIMIT = 8;

/**
 * 诊断短标识符允许的字符面。
 *
 * 诊断字段只应来自插件自身固定的结构化 code（如 invalid-selection）或固定的能力名。
 * 任何超出该字符面的输入都无法证明是结构化类别，一律归一为 other，避免把错误消息、
 * 文件系统路径、会话标识或认证信息带进可读诊断面。
 */
const DIAGNOSTIC_TOKEN_PATTERN = /^[A-Za-z0-9_./-]{1,40}$/;

/** 把任意输入归一为可安全展示的诊断 token；长度与字符面双重限制。 */
function diagnosticToken(value, fallback = "other") {
  return typeof value === "string" && DIAGNOSTIC_TOKEN_PATTERN.test(value) ? value : fallback;
}

/** 只接受非负安全整数计数；其它输入按 0 处理，诊断绝不返回 NaN/负数。 */
function diagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * 有界 RPC 错误类别记录器（只读诊断）。
 *
 * legacy HTTP 与 Connection 两条传输共用同一个 mapRpcError，因此这里记录的是同一份
 * "最近失败类别"视图。记录内容只有结构化 code、出现次数与最近一次时间戳：绝不保存
 * 错误消息、原始请求体、prompt、路径或认证信息，避免可观测性扩大泄露面。
 *
 * @param {object} [options]
 * @param {number} [options.limit] - 类别上限；超出后淘汰最久未出现的类别。
 */
function createRpcErrorTracker({ limit = RPC_ERROR_CATEGORY_LIMIT } = {}) {
  const max = Number.isSafeInteger(limit) && limit > 0 ? limit : RPC_ERROR_CATEGORY_LIMIT;
  const categories = new Map();
  return Object.freeze({
    /** 记录一次已映射的错误类别；非法输入归一为 other，且绝不抛出。 */
    note(code) {
      const key = diagnosticToken(code);
      const current = categories.get(key);
      if (current === undefined) {
        categories.set(key, { code: key, count: 1, lastAt: Date.now() });
        if (categories.size > max) {
          // 淘汰最久未出现的类别；Map 迭代顺序即插入顺序，最旧的候选在队首附近。
          let oldestKey;
          let oldestAt = Infinity;
          for (const [candidate, entry] of categories) {
            if (entry.lastAt < oldestAt) {
              oldestAt = entry.lastAt;
              oldestKey = candidate;
            }
          }
          if (oldestKey !== undefined) categories.delete(oldestKey);
        }
        return;
      }
      current.count += 1;
      current.lastAt = Date.now();
      // 重新插入把该类别移到队尾，保证上限淘汰的是真正最久未出现的类别。
      categories.delete(key);
      categories.set(key, current);
    },
    /** 只读快照：按最近出现时间倒序，条数固定上限。 */
    snapshot() {
      return Object.freeze([...categories.values()]
        .sort((left, right) => right.lastAt - left.lastAt)
        .map((entry) => Object.freeze({ code: entry.code, count: entry.count, lastAt: entry.lastAt })));
    },
    clear() {
      categories.clear();
    },
  });
}

/**
 * 探测一个（可能是 Cordis 服务代理的）宿主服务能力。
 *
 * 只做 `typeof` 判定，绝不调用任何业务方法；Cordis 对未声明服务的属性读取会抛错，
 * 因此每个成员单独 try/catch。状态语义：
 * - available：服务存在且所需方法齐全；
 * - incomplete：服务存在但缺少方法（插件保持加载，只禁用受影响能力）；
 * - absent：服务未注入或为 null。
 *
 * @param {unknown} service
 * @param {string[]} methods
 * @returns {{status:string, methods:object}}
 */
function probeServiceCapability(service, methods) {
  const list = Array.isArray(methods) ? methods : [];
  if (service === undefined || service === null) {
    return { status: "absent", methods: Object.freeze(Object.fromEntries(list.map((method) => [method, false]))) };
  }
  const present = {};
  for (const method of list) {
    try {
      present[method] = typeof service[method] === "function";
    } catch {
      present[method] = false;
    }
  }
  return {
    status: list.every((method) => present[method] === true) ? "available" : "incomplete",
    methods: Object.freeze(present),
  };
}

/**
 * settings 读源接线入口（新契约）。
 *
 * 行为由 host/settings-source 持有：关闭宿主自动配置页、从 describe() 读取本条目
 * 当前值、在 document-updated 时刷新读源。这里只保留组合根投影名，便于源码契约
 * 测试与后续票据定位接线点。
 */
function installSettingsSection(settingsSource, ctx, namespace, schema, entry, hooks) {
  return settingsSource.install(ctx, { namespace, schema, entry, hooks });
}

/**
 * 专家 child 的固定编排纪律，由 persona 注入，不重复写入任务 prompt。
 *
 * 文本与拼接规则集中定义在 prompt-contracts.js（与专家专属 persona 同处一个模块，
 * 保证"用户可覆盖的部分"和"代码固定追加的部分"只有一个分层来源），本文件只从那里导入，
 * 不再保留第二份副本。
 */

/** 仅用于 recovery/rebuild 兼容旧版本首条 prompt，不会进入新的任务正文。 */
const LEGACY_EXPERT_TASK_DISPATCH_RULE = "这是主代理派发的任务。请使用中文完成任务并用中文给出最终回复，代码标识符、路径和协议字段可保留原文。";
const LEGACY_EXPERT_TASK_LEAF_RULE = "你是叶子子代理，禁止委派或创建其他代理；禁止调用 send_message，也不得通过 run_code 间接调用 send_message；不要主动向父代理发送消息。完成后结果只在最终 assistant 输出中返回。";
// 只匹配行首完整身份句；正文中出现“你是……子代理”普通文字时不删除。
const EXPERT_TASK_IDENTITY_SENTENCE = /^(?:你是\s*[^\n。！？]*子代理|You are\s+[^\n.!?]*\bsubagent)\s*(?:[。！？.!?]|(?=\r?\n)|$)[ \t\r\n]*/iu;
const EXPERT_TASK_BODY_MARKER = "任务内容：";

/** 识别完整的历史纪律句；带任务特有后缀的相似引用不能命中。 */
function isLegacyExpertTaskDisciplineLine(line) {
  const text = typeof line === "string" ? line.trim() : "";
  return LEGACY_EXPERT_TASK_EXACT_LINES.has(text);
}

/**
 * 清理旧 root contract 已经拼入任务正文的固定纪律。
 * 只删除插件历史生成的完整短语，保留同一任务中的 workspace、范围和验证内容。
 */
const LEGACY_EXPERT_TASK_INLINE_RULES = Object.freeze([
  "禁止调用 send_message，禁止通过 run_code 间接调用 send_message，不要主动向父代理发送消息；结果只在最终 assistant 输出中返回。",
  "你是叶子 worker，不得再次派发子代理。",
  LEGACY_EXPERT_TASK_LEAF_RULE,
]);

// 只接受完整历史句，避免把“固定短语 + 任务说明”的合法内容当作纪律删除。
const LEGACY_EXPERT_TASK_EXACT_LINES = new Set([
  LEGACY_EXPERT_TASK_LEAF_RULE,
  LEGACY_EXPERT_TASK_INLINE_RULES[0],
  LEGACY_EXPERT_TASK_INLINE_RULES[0] + LEGACY_EXPERT_TASK_INLINE_RULES[1],
  "完成后只在最终回复中交付结果。",
  "请使用中文完成任务并用中文给出最终回复，代码标识符、路径和协议字段可保留原文。",
  "禁止调用 send_message",
  "不得通过 run_code 间接调用 send_message",
  "不要主动向父代理发送消息",
  "完成后结果只在最终 assistant 输出中返回。",
  "完成后结果只在最终 assistant 输出中返回",
  "You are a leaf worker: do not delegate or create child agents; do not call send_message or report; return only in the final assistant response.",
  "Do not call report or send_message; return only in the final assistant response.",
]);

// 只有完整 inline 纪律链位于行尾、且下一行就是完整叶子纪律时，才允许删除。
// 以行尾边界匹配，避免把固定片段后面的任务特有文字一并吞掉。
const LEGACY_EXPERT_TASK_INLINE_CHAIN_CANDIDATES = Object.freeze([
  LEGACY_EXPERT_TASK_INLINE_RULES[0] + LEGACY_EXPERT_TASK_INLINE_RULES[1],
  LEGACY_EXPERT_TASK_INLINE_RULES[0] + " " + LEGACY_EXPERT_TASK_INLINE_RULES[1],
]);

function stripInlineLegacyExpertTaskChain(lines, end) {
  let removed = false;
  for (let index = 0; index + 1 < end; index += 1) {
    if (lines[index + 1].trim() !== LEGACY_EXPERT_TASK_LEAF_RULE) continue;
    const line = lines[index].replace(/[ \t]+$/u, "");
    const chain = LEGACY_EXPERT_TASK_INLINE_CHAIN_CANDIDATES.find((candidate) => {
      const start = line.length - candidate.length;
      return start >= 0 && line.slice(start) === candidate;
    });
    if (chain === undefined) continue;

    const prefix = line.slice(0, line.length - chain.length).trimEnd();
    if (prefix.length > 0) {
      lines[index] = prefix;
      lines.splice(index + 1, 1);
      end -= 1;
    } else {
      lines.splice(index, 2);
      end -= 2;
      index -= 1;
    }
    removed = true;
  }
  return { end, removed };
}

function stripLegacyExpertTaskDiscipline(text, hasLegacyWrapperEvidence = false) {
  const lines = (typeof text === "string" ? text : "").split(/\r?\n/u);
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;

  // 真实旧会话可能把任务正文和完整 inline 纪律链拼在同一行；只在下一行紧邻
  // 完整叶子纪律时剥离固定链，确保 workspace、范围、验证和等待字段原样保留。
  const inlineResult = stripInlineLegacyExpertTaskChain(lines, end);
  end = inlineResult.end;
  let leadingChainRemoved = inlineResult.removed;
  const lastLineIsLeaf = end > 0 && lines[end - 1].trim() === LEGACY_EXPERT_TASK_LEAF_RULE;
  const leadingChain = LEGACY_EXPERT_TASK_INLINE_CHAIN_CANDIDATES.find((candidate) => {
    const firstLine = lines[0] ?? "";
    return firstLine.slice(0, candidate.length) === candidate;
  });
  if (lastLineIsLeaf && leadingChain !== undefined) {
    const remainder = (lines[0] ?? "").slice(leadingChain.length).trimStart();
    if (remainder.length > 0) lines[0] = remainder;
    else lines.splice(0, 1);
    end -= 1;
    leadingChainRemoved = true;
  } else if (lastLineIsLeaf && lines[0]?.trim() === LEGACY_EXPERT_TASK_INLINE_RULES[0]
    && lines[1]?.trim() === LEGACY_EXPERT_TASK_INLINE_RULES[1]) {
    lines.splice(0, 2);
    end -= 2;
    leadingChainRemoved = true;
  }

  // 只清理末尾连续的完整纪律后缀；任务正文中间或带额外文字的相似行必须保留。
  let suffixStart = end;
  while (suffixStart > 0 && isLegacyExpertTaskDisciplineLine(lines[suffixStart - 1])) suffixStart -= 1;
  const suffix = lines.slice(suffixStart, end);
  const hasLegacyChainEvidence = suffix.some((line) => line.trim() === LEGACY_EXPERT_TASK_LEAF_RULE)
    && ((suffix.length >= 2 && suffix.some((line) => /send_message|最终 assistant|最终回复/iu.test(line)))
      || leadingChainRemoved
      || (hasLegacyWrapperEvidence && suffix.length === 1));
  if (!hasLegacyChainEvidence) return lines.slice(0, end).join("\n").trim();
  return lines.slice(0, suffixStart).join("\n").trim();
}

/**
 * 统一构造专家收到的精简首条任务消息，只保留身份行和任务正文段。
 * 旧版本的派发说明、任务 marker 包装和叶子纪律仅在此处兼容剥离，
 * 固定执行纪律由 persona、toolFilter 和 runtime guard 负责。
 * @param {string} role - 当前专家角色。
 * @param {unknown} prompt - 主代理传入的原始任务。
 * @returns {string} 规范化后的两段式中文任务提示。
 */
export function buildExpertTaskPrompt(role, prompt) {
  const raw = typeof prompt === "string" ? prompt.trim() : "";
  const identity = "你是 " + role + " 子代理。";
  let task = raw;

  // 连续的开头身份句（包括错误角色和旧英文身份句）属于包装，不是任务正文。
  // 只匹配完整句子，避免删除正文中普通的身份相关文字。
  while (EXPERT_TASK_IDENTITY_SENTENCE.test(task)) {
    task = task.replace(EXPERT_TASK_IDENTITY_SENTENCE, "").trimStart();
  }

  let taskLines = task.split(/\r?\n/u);
  const hasDispatchWrapper = taskLines[0] === LEGACY_EXPERT_TASK_DISPATCH_RULE
    || taskLines[0]?.startsWith("这是主代理派发的任务。") === true
    || /^This is the task dispatched by (?:the parent|the main agent)/iu.test(taskLines[0] ?? "");
  if (hasDispatchWrapper) taskLines = taskLines.slice(1);

  // 新 prompt 与旧 prompt 都可能以任务内容 marker 开始；只有固定首行 wrapper
  // 或 marker 位于首行时才解析，避免删除任务正文中间出现的同名文字。
  const markerLineIndex = taskLines.findIndex((line) => line.startsWith(EXPERT_TASK_BODY_MARKER));
  const markerIsWrapper = markerLineIndex === 0 || (hasDispatchWrapper && markerLineIndex >= 0);
  if (markerIsWrapper) {
    taskLines = taskLines.slice(markerLineIndex);
    taskLines[0] = taskLines[0].slice(EXPERT_TASK_BODY_MARKER.length).trimStart();
    task = taskLines.join("\n").trim();
  } else {
    task = taskLines.join("\n").trim();
  }
  task = stripLegacyExpertTaskDiscipline(task, hasDispatchWrapper);
  return [
    identity,
    EXPERT_TASK_BODY_MARKER + (task || "请按你的角色职责完成主代理交付的范围。"),
  ].join("\n");
}

/**
 * 给专家 child 的工具过滤补上 scope-local send_message。它不能只走
 * effectiveDeny/tools.restrict，因为该工具不一定出现在父代理的全局工具视图中。
 * @param {object|undefined} toolFilter - 已计算的工具过滤。
 * @returns {string[]} 保留已有 deny 并保证隐藏 send_message。
 */
function ensureExpertSendMessageDenied(toolFilter) {
  const existing = Array.isArray(toolFilter)
    ? toolFilter
    : Array.isArray(toolFilter?.deny) ? toolFilter.deny : [];
  return [...new Set([...existing, "send_message"])];
}

/**
 * 角色元数据投影：中文显示名与职责摘要来自统一角色注册表，默认 persona 来自
 * prompt-contracts 的专家专属 persona 表（不含固定执行纪律）。注册表新增角色却
 * 缺少 persona 时在模块加载期显式失败，避免用空人格启动专家。
 *
 * persona 字段保留为"默认专家专属 persona"的兼容投影；需要真正启动 child 的调用点
 * 必须使用 resolveExpertPersona(...) 解析当前 settings 覆盖。
 */
const ROLE_META = Object.fromEntries(listRoles().map((entry) => [entry.id, {
  label: entry.label,
  description: entry.description,
  persona: DEFAULT_EXPERT_PERSONA[entry.id],
}]));

/** 子代理 child.options 上携带的推理深度 marker，避免依赖未公开的 AgentOptions.reasoningEffort。 */
const EFFORT_MARKER = "__degExpertEffort";

/** 子代理 child.options 上携带的角色 marker：用于按 parentId+role+route 恢复可复用 child。 */
const ROLE_MARKER = "__degExpertRole";

/** 子代理 child.options 上携带的父代理 marker：记录创建它的父代理 session id。 */
const PARENT_MARKER = "__degExpertParent";

/** 子代理 child.options 上携带的 continuable 标记：所有专家委派
 *  统一走可续接（continuable）子代理，无条件写入 true；agent/created 据此
 *  持久化，重启恢复只接受带本标记的 child（旧版 one-shot 与无标记记录
 *  不可 steer，恢复时忽略）。 */
const CONTINUABLE_MARKER = "__degExpertContinuable";

/** 只有同时带插件角色与父会话 marker 的有效专家 child 才安装 report/send_message guard。 */
const EXPERT_ROLES = new Set(listRoles().map((entry) => entry.id));
const EXPERT_REPORT_GUARD_REASON = "插件专家 child 不允许调用 report；请在最终 assistant 输出中按五个固定标题交付结果。";
const EXPERT_SEND_MESSAGE_GUARD_REASON = "插件专家 child 不允许调用 send_message；最终结果由 DSH subagent-settled 自动交付，请仅在最终 assistant 输出中按五个固定标题交付结果。";

// 全局 guard 只信任插件在实际 acceptance/agent 生命周期中登记的 Agent 对象。
// marker、parentSession 和 origin 都是 Host 可复制的 metadata，不能单独证明 child 来自本插件。
const registeredPluginExpertChildren = new WeakSet();
function registerPluginExpertChildAgent(agent) {
  if (agent !== null && (typeof agent === "object" || typeof agent === "function")) registeredPluginExpertChildren.add(agent);
}
function isRegisteredPluginExpertChild(agent) {
  return agent !== null
    && (typeof agent === "object" || typeof agent === "function")
    && registeredPluginExpertChildren.has(agent);
}

function isPluginExpertChildOptions(options) {
  const role = options?.[ROLE_MARKER];
  const parentId = options?.[PARENT_MARKER];
  return typeof role === "string"
    && EXPERT_ROLES.has(role)
    && typeof parentId === "string"
    && parentId.length > 0;
}

function isPluginExpertChildRecord(record) {
  return record !== null
    && typeof record === "object"
    && !Array.isArray(record)
    && typeof record.role === "string"
    && EXPERT_ROLES.has(record.role)
    && typeof record.parentId === "string"
    && record.parentId.length > 0
    && record.continuable === true;
}

/**
 * 解析 setup 当下的插件专家身份：新建/重建优先使用 marker，cold-resume
 * 的 child.options 只有 provider/model 时按精确 child id 读取当前快照。
 * marker 只要出现但不完整就保守回退，不用快照猜测，避免 stale 记录误判。
 */
export function resolveExpertReportIdentity(options, childId, readChildModel) {
  if (isPluginExpertChildOptions(options)) {
    return { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER], source: "marker" };
  }
  const markerPresent = options?.[ROLE_MARKER] !== void 0 || options?.[PARENT_MARKER] !== void 0;
  if (markerPresent || typeof childId !== "string" || childId.length === 0 || typeof readChildModel !== "function") return void 0;
  let record;
  try {
    record = readChildModel(childId);
  } catch {
    return void 0;
  }
  if (!isPluginExpertChildRecord(record)) return void 0;
  return { role: record.role, parentId: record.parentId, source: "snapshot" };
}

function isPluginExpertChildIdentity(identity) {
  return identity !== null
    && typeof identity === "object"
    && EXPERT_ROLES.has(identity.role)
    && typeof identity.parentId === "string"
    && identity.parentId.length > 0;
}

/** 返回 report 硬防线的拒绝理由；供契约测试验证 marker 与快照身份边界。 */
export function shouldBlockExpertReport(options, execution, identity) {
  const resolved = identity ?? (isPluginExpertChildOptions(options)
    ? { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER] }
    : void 0);
  if (!isPluginExpertChildIdentity(resolved) || execution?.name !== "report") return void 0;
  return EXPERT_REPORT_GUARD_REASON;
}

/** 插件专家 child 只能由 DSH 自动 subagent-settled 交付，禁止 scope-local send_message。 */
export function shouldBlockExpertSendMessage(options, execution, identity) {
  const resolved = identity ?? (isPluginExpertChildOptions(options)
    ? { role: options[ROLE_MARKER], parentId: options[PARENT_MARKER] }
    : void 0);
  if (!isPluginExpertChildIdentity(resolved) || execution?.name !== "send_message") return void 0;
  return EXPERT_SEND_MESSAGE_GUARD_REASON;
}

/**
 * PTC nested dispatch 会复制外层 execution.agent；全局 guard 因而必须按当前 Agent
 * 的内部登记、marker 与真实 parentSession 做精确 lineage 校验。这里不读取 snapshot，避免把
 * 已替换或已销毁的 child 误判为当前调用者；Host 侧 subagents.sendMessage 不经过此层。
 */
export function shouldBlockGlobalExpertSendMessage(execution) {
  if (execution?.name !== "send_message") return void 0;
  const agent = execution?.agent;
  let options;
  let parentSession;
  try {
    options = agent?.options;
    parentSession = agent?.session?.header?.parentSession;
  } catch {
    return void 0;
  }
  // marker 只是复制来的 metadata；必须先命中插件登记的 exact Agent 对象。
  // origin 缺失在不同 DSH 版本中是合法情况，因此不把它当作认证凭据。
  if (!isRegisteredPluginExpertChild(agent)
    || !isPluginExpertChildOptions(options)
    || options[CONTINUABLE_MARKER] !== true
    || parentSession !== options[PARENT_MARKER]) return void 0;
  return shouldBlockExpertSendMessage(options, execution, {
    role: options[ROLE_MARKER],
    parentId: options[PARENT_MARKER],
    source: "registered-agent",
  });
}

/**
 * 维护 Host root 的可序列化 generation。generation 使用插件实例级单调序号，
 * 因而即使清理了某个 root id 的当前 Map 项，同 id 后续重建也不会得到旧版本。
 * 只保留当前 live root 的对象引用，避免 registry 持有已销毁 Agent；retire 对旧
 * 对象做精确匹配，迟到的旧 disposed 事件不会删除新 root 的 generation。
 */
export function createRootGenerationRegistry() {
  let nextGeneration = 0;
  const current = new Map();
  return {
    activate(rootId, agent) {
      if (typeof rootId !== "string" || rootId.length === 0 || agent === void 0) return void 0;
      const existing = current.get(rootId);
      if (existing?.agent === agent) return existing.generation;
      const generation = ++nextGeneration;
      current.set(rootId, { agent, generation });
      return generation;
    },
    retire(rootId, agent) {
      const existing = current.get(rootId);
      if (existing?.agent !== agent) return false;
      current.delete(rootId);
      return true;
    },
    generationOf(rootId) {
      return current.get(rootId)?.generation;
    },
    isCurrent(rootId, agent) {
      return current.get(rootId)?.agent === agent;
    },
    clear() {
      current.clear();
    },
  };
}

/**
 * 把 report/send_message 的交付硬防线安装到 continuable child 自有工具层。
 * 非插件 child 返回 no-op，根代理不会经过此 child setup 接缝；快照只在
 * setup 执行时读取，不修改 DSH 的 agent.options。
 */
function installExpertReportGuard(childCtx, readChildModel, resolvedIdentity, childAgent) {
  // childCtx 只提供该 child 自有的 tools guard；Agent 身份从调用方显式传入，
  // 避免读取未注入的 childCtx.agent 懒 getter。
  const options = childAgent?.options;
  const identity = resolvedIdentity ?? resolveExpertReportIdentity(options, childAgent?.id, readChildModel);
  if (!isPluginExpertChildIdentity(identity)) return () => {};
  return childCtx.tools.guard((execution) => {
    const reportReason = shouldBlockExpertReport(options, execution, identity);
    if (reportReason !== void 0) return reportReason;
    const sendMessageReason = shouldBlockExpertSendMessage(options, execution, identity);
    if (sendMessageReason !== void 0) return sendMessageReason;
    // 只读性来自注册表；未知角色按只读处理（fail-closed），避免历史/外部角色
    // 因注册表缺项而获得动态 MCP 访问权。
    const roleEntry = getRole(identity.role);
    if ((roleEntry === void 0 || roleEntry.readOnly === true) && isReadonlyDynamicMcpName(execution?.name)) {
      return "只读专家 child 禁止调用动态 MCP 工具";
    }
    return void 0;
  });
}

const ROLE_SELECTION = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
});

/** settings 保存统一 provider、各专家 defaults 和通知偏好；插件运行数据仍属于 storage domain。 */
const NOTIFICATION_HOLD_MS_OPTIONS = Object.freeze([5000, 10000, 30000, 60000, 300000, 600000, 0]);
const DEFAULT_NOTIFICATION_HOLD_MS = 5000;
/**
 * 默认通知音量（0..100）：100 = 不做任何衰减，只受 Windows 主音量影响。
 * 常量与归一函数都来自 host/system-toast.js，保证设置读取面与投递面用的是同一套规则。
 */
const DEFAULT_NOTIFICATION_VOLUME_SETTING = DEFAULT_NOTIFICATION_VOLUME;
const DEFAULT_ROLE_CONCURRENCY_LIMIT = 10;

/** 角色并发上限必须是 1 到 64 的安全整数；旧配置或非法值回退到默认值。 */
function normalizeRoleConcurrencyLimit(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 64
    ? value
    : DEFAULT_ROLE_CONCURRENCY_LIMIT;
}

/** 只接受设置页提供的固定停留时长；旧配置或非法值回退到 10 秒。 */
function normalizeNotificationHoldMs(value) {
  const number = typeof value === "number" ? value : NaN;
  return NOTIFICATION_HOLD_MS_OPTIONS.includes(number) ? number : DEFAULT_NOTIFICATION_HOLD_MS;
}

/**
 * 插件组合 Config。
 *
 * 前两个字段是插件启停配置（普通 Config）：它们是部署期行为，不是设置页的即时偏好。
 * 其余九个字段是设置页可即时修改的偏好，必须标记 `.volatile()`：DSH 0.1.7 的
 * `ctx.settings` 只把「本条目 Config 上的 volatile 字段」投影成可编辑表单，并且
 * **只有声明了 volatile 字段的条目才会出现在 `describe()` 中**；写入非 volatile
 * 路径会被宿主直接拒绝。
 *
 * 字段语义与默认值必须与设置页的读取面一致：`describe()` 返回的 value 是
 * defaults resolved 后的结果（provider 空字符串表示用户尚未选择 provider，
 * promptOverrides 空对象表示全部跟随代码默认 persona）。运行期读源由
 * host/settings-source 从 describe() 取得，提交端点只写这九个字段。
 */
const Config = z.object({
  // 主代理能力默认启用；false 可用于仅使用专家工具的兼容部署。
  enableOrchestrator: z.boolean().default(true),
  enableObserver: z.boolean().default(false),
  // 空字符串表示用户尚未选择 provider，不为新用户填充模型。
  provider: z.string().default("").volatile(),
  defaults: z.dict(ROLE_SELECTION).default({}).volatile(),
  notificationEnabled: z.boolean().default(true).volatile(),
  notificationVolume: z.number().step(1).min(0).max(100).default(100).volatile(),
  notificationHoldMs: z.number().step(1).min(0).max(600000).default(DEFAULT_NOTIFICATION_HOLD_MS).volatile(),
  roleConcurrencyLimit: z.number().step(1).min(1).max(64).default(DEFAULT_ROLE_CONCURRENCY_LIMIT).volatile(),
  // 旧 settings 文档可能没有该字段；schema 与归一边界都提供关闭默认值。
  observerPreferred: z.boolean().default(false).volatile(),
  // 「任务管理」开关默认开启：旧文档缺字段时维持 Expert Group 注册到侧边栏的历史行为。
  taskManagementEnabled: z.boolean().default(true).volatile(),
  // 六个角色的专家专属提示词覆盖（角色 id -> 自定义文本）。缺失或空对象表示全部
  // 使用代码里的默认 persona；这里只做类型层（角色键与长度）校验，写入边界的
  // 语义校验在 DEG 自有提交端点内（宿主新契约没有 validate 钩子）。
  promptOverrides: z.dict(z.string()).default({}).volatile(),
});

/** settings namespace 仅保存全局 defaults；session 与 child 运行数据属于 storage domain。 */
const SETTINGS_NAMESPACE = "dsh-expert-group";
/** domain child record 保留恢复字段；缺失的 lruSequence 由稳定 key 规则兼容。 */
export const DOMAIN_ROLE_SELECTION = domainZ.object({
  provider: domainZ.string(),
  model: domainZ.string(),
  reasoningEffort: domainZ.string().optional(),
});
/** session_overrides 的 value 是“角色名 -> selection”字典，不是单个 selection。 */
export const DOMAIN_SESSION_OVERRIDES = domainZ.record(domainZ.string(), DOMAIN_ROLE_SELECTION);
const DOMAIN_CHILD_MODEL_RECORD = domainZ.object({
  provider: domainZ.string(),
  model: domainZ.string(),
  reasoningEffort: domainZ.string().optional(),
  role: domainZ.string().optional(),
  parentId: domainZ.string().optional(),
  continuable: domainZ.boolean().optional(),
  // 最近一次 accepted dispatch 的短描述用于冷会话侧栏；它不是第二套任务数据库。
  lastDispatch: domainZ.object({
    description: domainZ.string().optional(),
    prompt: domainZ.string().optional(),
    messageId: domainZ.string().optional(),
    acceptedAt: domainZ.number().int().nonnegative().optional(),
  }).optional(),
  // fan-out child 必须持久化完整来源身份；普通 child 只有 role/parentId 时不能被误路由。
  fanout: domainZ.boolean().optional(),
  fanoutParentTaskId: domainZ.string().optional(),
  fanoutParentAgentId: domainZ.string().optional(),
  fanoutShardId: domainZ.string().optional(),
  fanoutAttempt: domainZ.number().int().positive().optional(),
  // 内部 LRU 序号；历史 domain 记录没有该字段时按稳定 key 规则补齐。
  lruSequence: domainZ.number().int().nonnegative().optional(),
});
// fan-out 快照的详细 task/result 字段由 fanout.js 负责版本化；domain 只保证
// 它是 JSON 对象并把运行数据放在独立表中，绝不借用 settings。
const DOMAIN_FANOUT_SNAPSHOT = domainZ.object({
  version: domainZ.number().int().nonnegative(),
  tasks: domainZ.array(domainZ.unknown()),
}).passthrough();
const EXPERT_STORAGE_DOMAIN_SPEC = defineDomain({
  // storage-domain 0.1.0-rc.8 的 unit 名称约束使用下划线；domain 格式保持 version 1。
  name: "dsh_expert_group",
  version: 1,
  tables: {
    session_overrides: domainTable(DOMAIN_SESSION_OVERRIDES),
    child_models: domainTable(DOMAIN_CHILD_MODEL_RECORD),
    fanout_tasks: domainTable(DOMAIN_FANOUT_SNAPSHOT),
  },
});

/**
 * 把「与当前默认 persona 逐字相同」的覆盖折算成"没有覆盖"。
 *
 * 「与默认逐字相同」在写入边界（插件自持 settings-commit）就是**删除键**语义：
 * 该角色必须继续跟随未来的默认 persona 更新，而不是在文档里冻结一份默认副本。
 * 读取归一在这里做等价折算——写入面与读取面对同一份候选给出完全相同的结论。
 *
 * 比较是**逐字精确比较**，不做 trim 或空白折叠：首尾空白不同的文本仍算自定义覆盖。
 *
 * @param {Record<string,string>} overrides - 已归一（角色键合法、非空白、未超上限）的覆盖映射。
 * @returns {Record<string,string>} 删除默认副本后的映射。
 */
function pruneDefaultPromptOverrides(overrides) {
  const result = {};
  for (const [role, text] of Object.entries(overrides)) {
    if (text === DEFAULT_EXPERT_PERSONA[role]) continue;
    result[role] = text;
  }
  return result;
}

/** 把一份 settings 快照归一为普通对象（不回填任何内置默认模型）。 */
function normalizeSnapshot(snapshot, visibleRoles) {
  const defaults = {};
  for (const role of Object.keys(snapshot?.defaults ?? {})) {
    const value = snapshot.defaults[role];
    if (value && typeof value === "object") defaults[role] = { ...value };
  }
  const hasProvider = typeof snapshot?.provider === "string";
  const legacyProvider = hasProvider && snapshot.provider.length > 0 ? snapshot.provider : "";
  const roles = Array.isArray(visibleRoles) && visibleRoles.length > 0
    ? visibleRoles
    : Object.keys(defaults);
  const hadVisibleRowProvider = roles.some((role) => {
    const provider = defaults[role]?.provider;
    return typeof provider === "string" && provider.length > 0;
  });
  if (!hadVisibleRowProvider && legacyProvider.length > 0) {
    // 只迁移仍然合法的旧 selection；不存在的角色和隐藏 Observer 保持原样，
    // 且只在迁移前完全没有行级 provider 时执行，避免覆盖或拼接部分行级配置。
    for (const role of roles) {
      const value = defaults[role];
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.model !== "string" || value.model.length === 0
        || (typeof value.provider === "string" && value.provider.length > 0)) continue;
      defaults[role] = { ...value, provider: legacyProvider };
    }
  }
  const providers = roles.map((role) => {
    const provider = defaults[role]?.provider;
    return typeof provider === "string" && provider.length > 0 ? provider : "";
  });
  const configuredProviders = providers.filter((provider) => provider.length > 0);
  // 行级 provider 优先于旧顶层值；迁移前无行级 provider 时保留历史顶层 provider。
  const inferredProvider = configuredProviders.length > 0
    && configuredProviders.length === roles.length
    && configuredProviders.every((provider) => provider === configuredProviders[0])
    ? configuredProviders[0]
    : "";
  const provider = hadVisibleRowProvider
    ? inferredProvider
    : legacyProvider;
  const volume = Number(snapshot?.notificationVolume);
  return {
    provider,
    defaults,
    // 只保留六个合法角色、非空白且在 grapheme 上限内的覆盖；未知角色键、非字符串值、
    // 纯空白与超长文本在**DEG 自有提交端点**（settings-commit）内已被结构化拒绝。
    // 注意 0.1.7 的宿主没有 validate 钩子，因此宿主通用写入路径（settings.update /
    // mutate，例如模型配置区）不经过 DEG 校验：这里的丢弃是对外部编辑、历史文档与
    // 通用写入的读取安全网，正常提交路径不会走到它。
    // 与默认逐字相同的覆盖进一步折算为"没有覆盖"（等价删除键）。
    // 用户文本保留原始首尾空白与换行：归一绝不 trim 已接受的覆盖。
    promptOverrides: pruneDefaultPromptOverrides(normalizePromptOverrides(snapshot?.[PROMPT_OVERRIDES_SETTINGS_KEY])),
    notificationEnabled: snapshot?.notificationEnabled !== false,
    notificationVolume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : 100,
    notificationHoldMs: normalizeNotificationHoldMs(snapshot?.notificationHoldMs),
    roleConcurrencyLimit: normalizeRoleConcurrencyLimit(snapshot?.roleConcurrencyLimit),
    observerPreferred: snapshot?.observerPreferred === true,
    // 只有显式 false 才关闭侧边栏注册；缺字段（旧配置/旧客户端）按历史行为保持开启。
    taskManagementEnabled: snapshot?.taskManagementEnabled !== false,
  };
}

export default {
  name,
  Config,
  inject: ["tools", "subagents", "systemPrompt", "llm", "agents", "settings", "webServer"],
  apply(ctx, config) {
    const tools = ctx.tools;
    // RC1 PTC 的 nested dispatch 仍携带外层 execution.agent；全局 guard 必须在工具
    // body 前拦截 scope-local send_message，但只针对 lineage 匹配的插件专家 child。
    if (typeof tools?.guard === "function") {
      ctx.effect(() => {
        const disposeGuard = tools.guard((execution) => shouldBlockGlobalExpertSendMessage(execution));
        return () => disposeGuard?.();
      }, "dsh-expert-group: expert child send_message guard");
    }
    const subagents = ctx.subagents;
    const systemPrompt = ctx.systemPrompt;
    const llm = ctx.llm;
    /**
     * settings 运行时状态（目录代次、document revision 去重、提交串行链）
     * 由 host/settings-runtime 持有；组合根只做事件接线与生命周期注册。
     */
    const settingsRuntime = createSettingsRuntimeModule({ settings: ctx.settings, namespace: SETTINGS_NAMESPACE });
    for (const event of ["llm/adapters-updated", "credentials/reference-updated"]) {
      ctx.on(event, () => settingsRuntime.bumpGeneration());
    }
    // 目录代次观察点：0.1.7 的 `settings/document-updated` **只有 (ns, revision)
    // 两个参数**，注册世代事件 `settings/registration-updated` 已从宿主删除。任何
    // 外部 settings 文档变化都会推进代际，使进行中的提交在写入前复核时过期——
    // 这就是「提交前可检测的变化」这一降级保证的来源。
    ctx.on("settings/document-updated", (namespace, revision) => {
      // 本插件自己的 settings 写入不改变 LLM 目录，不能让它把本提交误判为过期。
      if (namespace === SETTINGS_NAMESPACE) return;
      settingsRuntime.noteDocumentUpdate(namespace, revision);
    });
    ctx.effect(() => () => settingsRuntime.dispose(), "dsh-expert-group: model directory registration state");

    /** settings 提交边界：目录代次栅栏与提交串行链由 host/settings-runtime 持有。 */
    const updateSettingsAtGeneration = (patch, expectedRevision, generation) =>
      settingsRuntime.updateAtGeneration(patch, expectedRevision, generation);
    const agents = ctx.agents;
    const settings = ctx.settings;
    const webServer = ctx.webServer;
    // 注意：本插件**不再调用 goals.pause / goals.resume**（旧 goal handoff 已整体删除）。
    // root 等待语义完全由「保持当前 turn 打开」实现（见 host/turn-wait.js）。
    // 这里读取的 goals 服务只用于**只读**快照投影：Expert Group 侧边栏展示每个 root 的
    // 目标阶段（host/expert-group-runtime.js 的 goals.get 读取）。它不参与任何等待、
    // 收口或状态变更，缺失时投影为空，绝不影响派发与等待语义。
    const goals = ctx.get("goals");
    /**
     * 最近 RPC 错误类别记录器：两条传输共用 mapRpcError，因此这里是同一份只读视图。
     * 记录只有结构化 code / 次数 / 时间戳，不含消息、请求体、prompt 或认证信息。
     */
    const rpcErrorTracker = createRpcErrorTracker({ limit: RPC_ERROR_CATEGORY_LIMIT });
    // 生命周期清理：卸载后不再保留任何错误类别记录（诊断只是内存投影，不落盘）。
    ctx.effect(() => () => rpcErrorTracker.clear(), "dsh-expert-group: rpc error diagnostics");

    /**
     * 当前已启用的角色名：默认角色 + 显式启用的可选角色，单一来源是统一角色注册表。
     * Observer 的裸 Config 默认禁用（Config.enableObserver 默认 false），
     * bundle patch 可以把它覆盖为 true。
     */
    const activeRoles = () => listEnabledRoles({ enableObserver: config.enableObserver === true }).map((entry) => entry.id);
    /** 只读性来自注册表；未注册角色显式失败，绝不默认按可写放宽权限。 */
    const readOnly = (role) => requireRole(role).readOnly;

    /** 同父代理 + 同角色的委派跟踪器：串行临界区 / child 复用 / 任务去重（LRU 32）。 */
    const delegationTracker = createDelegationTracker({ taskLimit: 32 });

    // 注意：旧的 root goal handoff 记录表（goalHandoffs）已整体删除。等待原因与
    // 静止判定由 host/turn-wait.js 的登记表按 exact root Agent 对象持有。
    // child turn/end 可能早于父 inbox feedback；先保存终态，等 exact settlement 到达后再消费。
    // 这些状态以 exact root Agent 为键；同 id 的新旧 root 不共享 generation。
    const pendingChildTurnEnds = new Map();
    // 自动恢复期间，DSH 仍会先把异常 settlement/report 插进父 inbox。每个
    // recovery record 自己持有已同步撤回的消息，绝不能按 childId 全局合并：
    // replacement、cold Session 与同 child 的后续任务都可能在同一父代理下并存。
    // 每个 accepted admission 独立保留 token/messageId/feedbackSeen，直到该 token 的
    // settlement 状态已确定；不会因另一个同 child admission 完成而提前删除。
    // pending admission 由 host/handoff 持有；下列调用为兼容投影。
    // Host admission 复用共享 helper 的 token/turn-group 状态；数组只作为本地 owner 索引。
    const handoffAdmissionCohort = createHandoffAdmissionCohort();
    /**
     * C：session/event 的**插件内部单调接收序号**。
     *
     * 宿主可以在同一个同步批次里连续发布多条 session/event（先 child turn/end、后
     * agent/inbox/spliced，或相反）。插件对这两类事件的处理都在 queueMicrotask 之后，
     * 因此「处理时刻看到的状态」不能代表「接收顺序」：notice 先发布、turn/end 随后发布时，
     * notice 的处理微任务可能已经看到 turnEnded=true，从而错误消费未来的终态证据。
     *
     * 唯一可靠的顺序权威是**同步回调第一次进入时的序号**：它随宿主发布顺序单调递增，
     * 与 event.seq 无关（不同 Session 的 seq 不可比较，seq 仍只作为 delivery 去重身份）。
     * 序号只是进程内小整数，不持久化、不进入任何快照或日志。
     */
    let sessionEventReceiptSeq = 0;
    function nextSessionEventReceipt() {
      sessionEventReceiptSeq += 1;
      return sessionEventReceiptSeq;
    }
    // resume/CAS 失败只禁止对应 exact root 的自动恢复，不能影响同 id 的新 root。
    const failedHandoffChildren = createHandoffFailureRegistry();
    // WeakSet 不持有 root；迟到 microtask 仍可按 exact 对象识别已销毁代际。
    const disposedRootAgents = new WeakSet();

    /**
     * Host 模块装配（expand 阶段）：六个关注点各自持有真实状态与行为，旧组合根
     * 通过它们接线；未迁移的旧逻辑仍保留在原处，任务 06 再收缩。
     */
    const host = createHostComposition({
      rpc: { path: RPC_PATH, channel: RPC_CHANNEL, endpoint: RPC_ENDPOINT },
      settings: {},
      storage: {},
      lineage: {
        disposedRoots: disposedRootAgents,
        isRootAgent: isRootAgentIdentity,
        getAgent: (id) => agents.get(id),
        getTask: (id) => fanoutHost?.getTask(id) ?? null,
        listTasks: () => fanoutHost?.listTasks() ?? [],
        isGenerationBlocked: () => turnWaitStopping,
      },
      notifications: {
        // 终止快照状态由 host/notifications 持有；Host 只注入 live Agent 查询，
        // 递归后代门控与 fail closed 判定都在模块内部完成。
        listAgents: () => agents.list(),
      },
      handoff: {},
    });
    const notificationHost = host.notifications;
    /**
     * Windows 系统 Toast 适配器（ADR 0005：系统通知是唯一通知界面）。
     *
     * 为什么由组合根直接持有、而不是组合层的新槽位：权威状态（每个 root run 的终止快照）
     * 仍由 host/notifications 持有，组合层的模块边界与释放顺序不变；适配器只负责把**已经
     * 发布的结论**交给 Windows，因此与 host 生命周期绑定在同一处释放。
     * config.createSystemToast 是可注入 seam（与 createPersistenceHealth 同一模式）：
     * 受控 Host/测试用它替换真实子进程，测试绝不真弹 Toast。
     */
    const systemToast = typeof config.createSystemToast === "function"
      ? config.createSystemToast()
      : createSystemToastModule({ logger: ctx.logger });
    ctx.effect(() => () => {
      if (typeof systemToast?.dispose === "function") void systemToast.dispose();
    }, "dsh-expert-group: windows system toast");

    /**
     * 系统通知开关：与设置页写的是同一个值；缺失/读不到（含 settings 尚未就绪）一律按开启。
     * 关闭时不发送、不补发——开关只影响投递，不影响任何快照、admission 或等待语义。
     */
    function systemToastEnabled() {
      try {
        return settingsSource()?.notificationEnabled !== false;
      } catch {
        return true;
      }
    }

    /**
     * 系统通知音量：与设置页写的是同一个值（0..100），只缩放 DEG 自己的提示音播放流。
     *
     * 与 systemToastEnabled 同形的安全读取：合法安全整数 0..100 原样返回；缺失、非法
     * （小数/越界/非数字）或读取异常一律回退 100（= 只受系统主音量影响）。读设置失败绝不静音，
     * 也绝不改动 Windows 主音量——音量只是个尽力而为的播放参数，不影响投递语义。
     */
    function systemToastVolume() {
      let value;
      try {
        value = settingsSource()?.notificationVolume;
      } catch {
        return DEFAULT_NOTIFICATION_VOLUME_SETTING;
      }
      return normalizeToastVolume(value);
    }

    /** 失败只记固定类别与错误名：通知正文、命令行与路径绝不出现在日志里。 */
    function logSystemToastFailure(error) {
      const name = typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error";
      ctx.logger.warn("dsh-expert-group: system toast delivery failed (" + name + ")");
    }

    /**
     * 发送一次系统通知。
     *
     * 适配器自身绝不抛出（失败收口为固定 reason），这里再兜一层同步异常与 rejected
     * promise：通知失败绝不能影响快照、handoff 或任务语义，也绝不回退成应用内卡片。
     */
    function sendSystemToast(text) {
      if (text === null || text === void 0) return;
      if (systemToastEnabled() !== true) return;
      let pending;
      try {
        pending = systemToast.show({
          title: text.title,
          taskName: text.taskName,
          body: text.body,
          // 音量是扁平字段：文案对象仍只有 title/taskName/body，音量不进入通知文本与诊断。
          volume: systemToastVolume(),
        });
      } catch (error) {
        logSystemToastFailure(error);
        return;
      }
      Promise.resolve(pending).catch((error) => { logSystemToastFailure(error); });
    }

    const storageBinding = host.storage;
    /**
     * 共享持久化健康状态：fan-out 快照走 manager sequence 的有界重试，session/child
     * 写入走独立观察通道（observeStorageWrite）。两者共用同一个内存状态对象，但通道
     * 互不覆盖，因此 session/child 失败不会改变 fan-out 的重试判定。
     * 只读投影：健康状态不写入 settings，也不写入任何 domain 快照。
     * config.createPersistenceHealth 是可选注入 seam（默认创建），供受控 Host/测试
     * 在执行任何写入前捕获同一个实例；未注入时行为与历史完全一致。
     */
    const persistenceHealth = typeof config.createPersistenceHealth === "function"
      ? config.createPersistenceHealth()
      : createPersistenceHealth();
    ctx.effect(() => () => { void host.dispose(); }, "dsh-expert-group: host module composition");
    // root 代际表（known/current/token）由 host/lineage 持有。

    // Host RPC 需要可序列化且单调的 root generation；Map 只保存当前 Agent，序号不回退。
    const rootGenerationRegistry = createRootGenerationRegistry();
    ctx.effect(() => () => rootGenerationRegistry.clear(), "dsh-expert-group: root generation state");
    // 每个 root Agent 拥有不可转移的 generation token；await 返回后必须仍由该
    // token 持有者提交状态，same-id 新 root 不能被旧回调复活或清理。

    // 自动完成通知只在 post-boundary 成功 turn/end 处提交；状态机由
    // host/notifications 持有并按 root generation 隔离。
    // 用户问题/计划确认在返回前可能长期等待；按 exact root/session/generation 保留其门控。
    const pendingUserWaits = new WeakMap();
    /**
     * 插件卸载闩：置位后所有等待登记/监听安装/结算路径一律 no-op，避免在
     * fiber 正在清理时又建立新的等待或监听。
     */
    let turnWaitStopping = false;
    /** 等待登记表的统一异常记录（只记错误名与固定前缀，不泄漏工作负载）。 */
    function logTurnWaitError(action, error) {
      ctx.logger.warn("dsh-expert-group: root turn wait " + action + " failed: "
        + (error instanceof Error ? error.message : String(error)));
    }
    function isRootAgentIdentity(agent) {
      return agent !== void 0
        && typeof agent.id === "string"
        && agent.session?.header?.parentSession === void 0
        && agent.options?.[PARENT_MARKER] === void 0;
    }

    function isLiveRootAgent(agent) {
      return host.lineage.isLiveRoot(agent);
    }

    // ── root turn 等待：root-scoped 后代查询与活动监听 ────────────────────────
    /**
     * rootId -> 该 root 等待记录的「作废」回调集合。
     *
     * 用一张按 root id 索引的表而不是「每个 root 装三份监听器」：全局监听只装一次，
     * 事件到达时按血缘链向上找出真正受影响的 root，因此 N 个并发 root 也只有一份监听。
     */
    const rootWaitInvalidators = new Map();
    let rootWaitActivityListenersInstalled = false;

    /** 通知某个 id 上登记的全部作废回调；回调异常不影响事件派发。 */
    function invalidateRootWaitId(id) {
      const listeners = rootWaitInvalidators.get(id);
      if (listeners === void 0) return;
      for (const listener of [...listeners]) {
        try { listener(); } catch (error) { logTurnWaitError("invalidate", error); }
      }
    }

    /**
     * 某个 live Agent 上发生活动（创建 / 转入 running / 销毁）时，作废**它自己及其
     * 全部祖先 root** 的等待结论。
     *
     * 为什么按血缘链向上而不是只看 id：child 的 parentSession 可能指向另一个 child
     * （fan-out 分片、嵌套委派），真正需要重新判定的是整条链上仍在等待的 root。
     * 链上出现环或父级不可解析时按 id 逐级命中后停止，绝不无限回溯。
     */
    function invalidateWaitersForAgentActivity(agent) {
      if (rootWaitInvalidators.size === 0) return;
      const visited = new Set();
      let currentId = typeof agent?.id === "string" ? agent.id : void 0;
      let parentId = agent?.session?.header?.parentSession;
      // 起点自身也要作废：root 自己的记录同样可能已经放行，需要重新判定。
      while (typeof currentId === "string" && currentId.length > 0 && !visited.has(currentId)) {
        visited.add(currentId);
        invalidateRootWaitId(currentId);
        if (typeof parentId !== "string" || parentId.length === 0) break;
        const parent = agents.get(parentId);
        currentId = parentId;
        parentId = parent?.session?.header?.parentSession;
      }
    }

    /**
     * 安装本 root 的活动监听（登记表的 subscribe 契约：必须在首次状态查询**之前**
     * 同步完成）。
     *
     * 监听面（全部是宿主公开事件）：
     * - `agent/created`：新 child 出现即作废静止结论；
     * - `agent/status`：转入 running 即作废（状态转 idle/ready 不产生新工作，但同样
     *   作废一次是安全且廉价的——判定会重新读 root-scoped 事实）；
     * - `agent/disposed`：child 消失后重新判定。
     *
     * @returns {() => void} 移除本次订阅（不动全局监听器：它们由插件 effect 统一释放）。
     */
    function subscribeRootActivity(agent, invalidate) {
      if (turnWaitStopping || typeof agent?.id !== "string" || agent.id.length === 0) return () => {};
      const rootId = agent.id;
      let listeners = rootWaitInvalidators.get(rootId);
      if (listeners === void 0) {
        listeners = new Set();
        rootWaitInvalidators.set(rootId, listeners);
      }
      listeners.add(invalidate);
      installRootWaitActivityListeners();
      return () => {
        const current = rootWaitInvalidators.get(rootId);
        if (current === undefined) return;
        current.delete(invalidate);
        if (current.size === 0) rootWaitInvalidators.delete(rootId);
      };
    }

    /**
     * 新建子代理时把它的祖先 root 登记进等待体系。
     *
     * 只沿 `session.header.parentSession` 血缘链向上找**最近的一个 root 身份 Agent**；
     * 链上出现环、父级不在 live registry 或链条结束都直接停止（绝不臆造归属）。
     * root 自身不 engage 自己（root 创建不意味着有子代理在跑）。
     *
     * @param {object} agent - 刚创建的 Agent。
     */
    function engageRootTurnWaitForCreatedAgent(agent) {
      if (turnWaitStopping) return;
      if (agent === null || typeof agent !== "object") return;
      if (isRootAgentIdentity(agent)) return;
      const visited = new Set();
      let parentId = agent.session?.header?.parentSession;
      while (typeof parentId === "string" && parentId.length > 0 && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = agents.get(parentId);
        if (parent === void 0) return;
        if (isRootAgentIdentity(parent)) {
          if (isLiveRootAgent(parent)) rootTurnWaits.engage(parent);
          return;
        }
        parentId = parent.session?.header?.parentSession;
      }
    }

    /** 全局活动监听只装一次；由插件 effect 在卸载时释放。 */
    function installRootWaitActivityListeners() {
      if (rootWaitActivityListenersInstalled || turnWaitStopping) return;
      rootWaitActivityListenersInstalled = true;
      ctx.effect(() => {
        const stopCreated = ctx.on("agent/created", ({ agent }) => {
          invalidateWaitersForAgentActivity(agent);
        });
        const stopStatus = ctx.on("agent/status", ({ agent }) => {
          invalidateWaitersForAgentActivity(agent);
        });
        const stopDisposed = ctx.on("agent/disposed", ({ agent }) => {
          invalidateWaitersForAgentActivity(agent);
        });
        return () => {
          rootWaitActivityListenersInstalled = false;
          stopDisposed?.();
          stopStatus?.();
          stopCreated?.();
        };
      }, "dsh-expert-group: root turn wait activity listeners");
    }

    /**
     * root-scoped 的 running 后代查询（等待释放的唯一外部事实来源）。
     *
     * 两条 seam，优先级严格：**权威 listing 优先，waterfall 仅作降级回退**。
     *
     * ### 1) 权威 seam：`subagents.listDescendants(rootSessionId)`
     * `@deepseek-ai/dsh-subagent` 在 `SubagentService` 上公开的递归后代枚举
     * （`listChildren`/`listDescendants`）：按 durable parent catalog 递归遍历，
     * child 行的必填字段是 `kind`、`id`、`mode: "one-shot" | "continuable"`、
     * `activity: "running" | "inactive"`、`hasChildren`、`parentId`、`depth`
     * （`mode: "continuable"` 时另有必填的 `label`）。
     * 它天然只覆盖被询问的 root，并且**失败语义是显式的**：
     * - 整条 listing reject（root catalog 不可读 / 缺少 sessionQuery、sessions、
     *   projection / 被取消）→ 未知；
     * - 某个分支不可读或 catalog 里 `mode: "unknown"` → 该行是
     *   `kind: "diagnostic"` → 无法证明那条分支里没有 running 后代 → 未知
     *   （fail-closed）；未知 `kind` 同样未知；
     * - child 行**不满足公开必填契约**（缺 `mode` / `mode` 非法 / 缺
     *   `hasChildren`、`parentId`、`depth` / continuable 行缺 `label`）→ 整次
     *   listing 不可信 → 未知（fail-closed）；
     * - 正常 resolve、行全部合法且没有任何 diagnostic 行 → `known:true`，此时
     *   「没有 running 后代」是**可证明**的结论。
     *
     * 为什么它是权威 seam：它是唯一一个「没有 provider」与「provider 明确报告空」
     * 在返回结构上就不同（reject / diagnostic vs. 干净的空列表）的公开 API。
     *
     * ### 2) 降级 seam：`workspace/session-activity` waterfall + 独特 sentinel
     * 宿主没有 listing 时退回 waterfall。这条链路**只能提供正向证据，永远不能证明静止**，
     * 两个独立原因都必须处理：
     *
     * **(a) 无 provider（P0）**：Cordis 的 `waterfall` 在**没有任何 listener** 时会
     * 直接调用调用方传入的最内层回调（`(cbs.shift() ?? inner)(...args)`），而宿主
     * subagent provider 在「没有 running 后代」时是 `return rest`（**原样透传**最内层
     * 返回值）。因此「没有 provider」与「provider 报告空」在返回值上完全同形——传空数组
     * 做兜底会把前者误判成 `known:true`。这里用**模块唯一的 sentinel**
     * （`SESSION_ACTIVITY_NO_PROVIDER`，冻结空数组）作为最内层返回值：
     * - 结果 **是** sentinel（对象身份相等）⟹ 没有任何 listener 产生新数组，即
     *   「链路没有贡献任何事实」——既可能是 topic 没有 provider，也可能是 provider
     *   原样透传。两者都无法证明「没有 running 后代」，一律 `known:false`；
     * - 结果 **不是** sentinel 的数组 ⟹ 至少有一个 listener 产出了新数组。注意：解析时
     *   必须跳过 sentinel 自身的元素（它可能被 spread 进结果）。
     *
     * **(b) 其他 listener 的空数组（P1）**：`workspace/session-activity` 是**非专属**
     * 扩展点，任何第三方 listener 都可以返回一个全新的空数组（既不 spread 最内层值，也
     * 不检查 subagent 血缘）。sentinel 只能识别「链路完全没有贡献」，识别不了「是谁贡献
     * 的」，因此非 sentinel 的空数组同样**不能**证明静止。判定层的口径必须是：
     * **任何**空数组（含 fresh `[]`）⟹ `known:false`。
     *
     * 综合结论（不夸大）：waterfall 回退只可能给出「known + running 非空」这一种明确
     * 结论，其余所有形状（sentinel、任意空数组、非空但无 subagent 族、malformed）都是
     * `known:false`。真正可证明的静止**只**来自权威 listing 的干净完整回答。
     *
     * @param {string} rootId - exact root session id。
     * @returns {Promise<{known:boolean,running:object[],runningIds?:Set<string>,reason:string}>}
     */
    /**
     * rc.2 的 Agent.status 只有 `idle` / `running`：只有 `idle` 表示「当前未运行」。
     * `ready` 等历史/非法状态一律走 shared.js 的「状态非法」分支 → `known:false`。
     */
    const TURN_WAIT_RUNTIME_STATUS_OPTIONS = Object.freeze({ idleStatuses: ["idle"] });

    /**
     * runtime agents.list() 的严格 fallback。它只在权威 listDescendants seam 不可用时
     * 使用，并沿用 shared.js 的完整血缘/状态校验；空数组只有在校验明确成功时才是
     * known:true，缺失父链、重复 id 或未知状态仍保持 fail-closed。
     */
    function snapshotRootTurnDescendantsFromRuntimeAgents(rootId) {
      let list;
      try {
        list = agents?.list;
      } catch {
        return void 0;
      }
      if (typeof list !== "function") return void 0;
      const snapshot = snapshotRunningRootDescendants(() => list.call(agents), rootId, TURN_WAIT_RUNTIME_STATUS_OPTIONS);
      return snapshot.known === true
        ? {
          known: true,
          running: snapshot.runningDescendants,
          // 复用既有 child settlement 回退：严格 runtime 快照不仅要告诉等待门控
          // 是否阻塞，还要提供 exact child id 集，才能在缺失完成通知时结算 admission。
          runningIds: new Set(snapshot.runningDescendants.map((agent) => agent.id)),
          ...(snapshot.reason === void 0 ? {} : { reason: snapshot.reason }),
        }
        : {
          known: false,
          running: [],
          reason: snapshot.reason ?? "runtime-descendant-query-unknown",
        };
    }

    async function snapshotRootTurnDescendants(rootId) {
      if (typeof rootId !== "string" || rootId.length === 0) {
        return { known: false, running: [], reason: "root-id-unknown" };
      }
      const listed = await snapshotRootTurnDescendantsFromListing(rootId);
      if (listed !== void 0) return listed;
      const runtime = snapshotRootTurnDescendantsFromRuntimeAgents(rootId);
      if (runtime !== void 0) return runtime;
      return snapshotRootTurnDescendantsFromActivity(rootId);
    }

    /**
     * `kind: "child"` 行是否满足公开契约（`SubagentDescendantListEntry`）。
     *
     * 公开 schema 定义在 `@deepseek-ai/dsh-subagent` 的 `control-types` 与
     * `list-children`：child 行 = `SubagentCatalogRow`（`id`、`mode`、`activity`，
     * 以及 `mode:"continuable"` 时**必填**的 `label`）
     * `& { kind:"child"; hasChildren:boolean }` `& { parentId; depth }`。因此这里只校验
     * **必填**字段，可选字段（`one-shot` 的 `label`）出现时必须是字符串，其余扩展字段
     * 一概不参与判定——避免把合法 listing 误判成非法而永久等待。
     *
     * **为什么 `mode` 必须校验（P2）**：`mode` 是这条行的生命周期判别字段
     * （`one-shot` | `continuable`）。真实 `listDescendants` 会把 catalog 里
     * `mode:"unknown"` 的条目转成 `kind:"diagnostic"`，所以 child 行出现**缺失**或
     * **非法** `mode` 只可能说明这份 listing 不是公开契约的形状（伪造 / 截断 / 跨版本
     * 错配）。此时 `activity:"inactive"` **不能**作为静止证据：整次结果按未知处理，
     * 等待继续。
     *
     * @param {object} row - listing 里 `kind:"child"` 的一行。
     * @returns {boolean} 满足必填字段契约时为 true。
     */
    function isContractChildRow(row) {
      if (typeof row.id !== "string" || row.id.length === 0) return false;
      // mode 枚举：只有这两个取值属于公开契约；缺失 / "unknown" / 任意字符串都非法。
      if (row.mode !== "one-shot" && row.mode !== "continuable") return false;
      // activity 是二值枚举；任何其他取值都说明契约不成立。
      if (row.activity !== "running" && row.activity !== "inactive") return false;
      // label：continuable 行必填；one-shot 行可选，但出现时必须是字符串。
      if (row.mode === "continuable") {
        if (typeof row.label !== "string") return false;
      } else if (row.label !== void 0 && typeof row.label !== "string") {
        return false;
      }
      if (typeof row.hasChildren !== "boolean") return false;
      if (typeof row.parentId !== "string" || row.parentId.length === 0) return false;
      // depth 是从被询问 root 起算的边距离；直接子代为 1，因此必须是正整数。
      if (!Number.isInteger(row.depth) || row.depth < 1) return false;
      return true;
    }

    /**
     * 权威 seam：`subagents.listDescendants`。
     *
     * @returns {Promise<object|undefined>} 明确回答；seam 不可用时返回 undefined
     *   让调用方回退到 waterfall。
     */
    /**
     * 读取 runtime 侧的后代索引（rc.2 严格状态：只有 idle 表示「当前未运行」）。
     *
     * - `agents.list()` 可用：返回同一份 exact runtime 快照里被 shared.js 严格校验过的
     *   后代索引（id → { parentSession, status, node }），逐行 status 判定与 live 后代
     *   覆盖校验都用它；
     * - 该 seam 缺失：`available:false`。此时**无法**用逐行 `agents.get()` 之类的方式补出
     *   等价事实（既拿不到同一份快照，也无法验证 runtime live descendants 是否被 catalog
     *   完整覆盖），调用方必须 fail-closed。真实 rc.2 宿主始终提供 `agents.list()`。
     *
     * @returns {{available:boolean, known?:boolean, reason?:string, descendants?:Map<string,object>}}
     */
    function readTurnWaitRuntimeDescendants(rootId) {
      let list;
      try {
        list = agents?.list;
      } catch {
        return { available: false };
      }
      if (typeof list !== "function") return { available: false };
      let snapshot;
      try {
        snapshot = list.call(agents);
      } catch (error) {
        // 列表查询失败：未知，绝不当作「没有 running 后代」。
        logTurnWaitError("runtime-descendant-query", error);
        return { available: true, known: false, reason: "runtime-descendant-query-unknown" };
      }
      const collected = collectRuntimeRootDescendants(snapshot, rootId, TURN_WAIT_RUNTIME_STATUS_OPTIONS);
      return collected.known === true
        ? { available: true, known: true, descendants: collected.descendants }
        : { available: true, known: false, reason: collected.reason ?? "runtime-descendant-identity-unknown" };
    }

    async function snapshotRootTurnDescendantsFromListing(rootId) {
      let listing;
      try {
        listing = subagents?.listDescendants;
      } catch (error) {
        logTurnWaitError("descendant-listing-probe", error);
        return void 0;
      }
      if (typeof listing !== "function") return void 0;
      let rows;
      try {
        rows = await listing.call(subagents, rootId);
      } catch (error) {
        // root catalog 不可读 / 缺少依赖 / 被取消：**未知**，绝不当作「没人跑」。
        logTurnWaitError("descendant-listing", error);
        return { known: false, running: [], reason: "descendant-listing-failed" };
      }
      if (!Array.isArray(rows)) {
        return { known: false, running: [], reason: "descendant-listing-malformed" };
      }
      // ① 行级公开契约校验 + catalog 树自洽性（重复 id、parentId/depth 链）。
      const catalog = new Map();
      for (const row of rows) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          return { known: false, running: [], reason: "descendant-listing-malformed" };
        }
        // 分支不可读 / catalog 里 mode 未知：那条分支里是否有 running 后代无法证明
        // → 未知（fail-closed）。未知 kind 同样按 malformed 处理。
        if (row.kind === "diagnostic") {
          return { known: false, running: [], reason: "descendant-listing-diagnostic" };
        }
        if (row.kind !== "child") {
          return { known: false, running: [], reason: "descendant-listing-malformed" };
        }
        // child 行的公开契约校验（含 mode 枚举）：任一必填字段不成立 ⟹ 整次 listing
        // 都不可信，绝不能拿其中某行的 activity 当静止/运行证据。
        if (!isContractChildRow(row)) {
          return { known: false, running: [], reason: "descendant-listing-malformed" };
        }
        // 同一 child id 出现两次：无法区分代际，整次 listing 不可信。
        if (catalog.has(row.id)) {
          return { known: false, running: [], reason: "descendant-listing-duplicate-id" };
        }
        catalog.set(row.id, row);
      }
      for (const row of catalog.values()) {
        if (row.parentId === rootId) {
          if (row.depth !== 1) {
            return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
          }
          continue;
        }
        const parent = catalog.get(row.parentId);
        // 父级不在本次 listing 里（catalog 不完整）或 depth 与父级不衔接：血缘冲突 → 未知。
        if (parent === void 0 || parent.depth + 1 !== row.depth) {
          return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
        }
      }
      // ② 运行判定交叉校验：同一份 exact runtime 快照（rc.2 严格状态）。
      // runtime 必须提供**完整**的 agents.list() 快照：listing 只证明 residency，运行判定与
      // 「live 后代是否被 catalog 完整覆盖」都只能用同一份 exact runtime 快照验证。缺该 seam
      // 时不存在安全的兼容回退（逐行 agents.get() 拿不到同一份快照、也做不了覆盖校验）⇒ 未知。
      const runtime = readTurnWaitRuntimeDescendants(rootId);
      if (runtime.available !== true || runtime.known !== true) {
        return {
          known: false,
          running: [],
          reason: runtime.available === true
            ? (runtime.reason ?? "runtime-descendant-identity-unknown")
            : "runtime-agent-listing-unavailable",
        };
      }
      const running = [];
      const runningIds = new Set();
      for (const row of catalog.values()) {
        const live = runtime.descendants.get(row.id);
        if (row.activity === "running") {
          // 声称驻留：运行判定只认同一份 runtime 快照里的 rc.2 `Agent.status`。
          if (live === void 0) {
            return { known: false, running: [], reason: "descendant-listing-runtime-agent-missing" };
          }
          // catalog 血缘必须与 runtime 的直接父会话一致（任一侧缺失同样按冲突处理）。
          if (live.parentSession !== row.parentId) {
            return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
          }
          if (live.status === "running") {
            running.push({ id: row.id });
            runningIds.add(row.id);
            continue;
          }
          if (live.status === "idle") continue;
          // 缺失 / `ready` / 非字符串等非法状态：既不能当成空闲，也不能当成运行 ⇒ 未知。
          return { known: false, running: [], reason: "descendant-listing-runtime-status-invalid" };
        }
        // 自报非驻留（activity:"inactive"）：上游语义是 `sessions.get(id) === undefined`，
        // 即「没有 live Session」——这种 durable 历史行是**合法**的，按「当前未运行」接受。
        // 但只要 runtime 里存在任何 exact live Agent（idle 或 running），residency 就自相矛盾
        // ⇒ 未知（绝不提前放行）。
        if (live !== void 0) {
          return { known: false, running: [], reason: "descendant-listing-activity-conflict" };
        }
      }
      // ③ runtime 里仍 live 的后代必须被 catalog 完整覆盖、必须自报驻留，且血缘一致。
      for (const [id, live] of runtime.descendants) {
        const row = catalog.get(id);
        if (row === void 0) {
          return { known: false, running: [], reason: "descendant-listing-missing-live-descendant" };
        }
        if (row.activity !== "running") {
          return { known: false, running: [], reason: "descendant-listing-activity-conflict" };
        }
        if (row.parentId !== live.parentSession) {
          return { known: false, running: [], reason: "descendant-listing-lineage-conflict" };
        }
      }
      return {
        known: true,
        running,
        runningIds,
        reason: running.length > 0 ? "running-descendants" : "no-running-descendants",
      };
    }

    /**
     * 降级 seam：`workspace/session-activity` waterfall + 独特 sentinel。
     *
     * **本路径只做正向证据**：唯一可能返回的明确结论是「确有 running 的 subagent 后代」
     * （`known:true` 且 `running` 非空），调用方据此**继续等待**。它**永远不返回**
     * `known:true` + 空 `running`——即永远不会证明静止：
     * - 结果 === sentinel ⟹ 链路没有贡献任何事实（无 provider / provider 原样透传）；
     * - 结果是非 sentinel 的**任意空数组** ⟹ 非专属扩展点上无法识别贡献者，可能是任何
     *   第三方 listener 返回的全新 `[]`，它并不保证检查过 subagent 血缘；
     * - 结果非空但没有 `kind === "subagent"` 的 running 条目 ⟹ 贡献事实的是别的族，
     *   或 subagent 族本身为空；
     * - 结果不是数组、或条目结构不合法 ⟹ malformed。
     * 以上四种一律 `known:false`（fail-closed，继续等待）。
     *
     * @returns {Promise<object>} 只有「known + running 非空」或 `known:false` 两种可能。
     */
    async function snapshotRootTurnDescendantsFromActivity(rootId) {
      // 严格 Cordis Context 对未声明属性直接抛错，因此这里的读取也必须包在 try 内：
      // 「读取 waterfall 失败」与「宿主没有该服务」是同一件事（未知），一律继续等待。
      let waterfall;
      try {
        waterfall = ctx.waterfall;
      } catch {
        return { known: false, running: [], reason: "session-activity-unavailable" };
      }
      if (typeof waterfall !== "function") {
        return { known: false, running: [], reason: "session-activity-unavailable" };
      }
      let activity;
      try {
        activity = await waterfall.call(ctx, "workspace/session-activity", { sessionId: rootId }, () => SESSION_ACTIVITY_NO_PROVIDER);
      } catch (error) {
        // 任一 provider 抛错都会让整条 waterfall reject：这是**未知**，不是「没人跑」。
        logTurnWaitError("descendant-query", error);
        return { known: false, running: [], reason: "session-activity-failed" };
      }
      if (activity === SESSION_ACTIVITY_NO_PROVIDER) {
        // P0：没有任何 listener 贡献事实——既可能是没有 provider，也可能是 provider
        // 原样透传。两者都无法证明「没有 running 后代」，必须继续等待。
        return { known: false, running: [], reason: "session-activity-no-provider" };
      }
      if (!Array.isArray(activity)) {
        return { known: false, running: [], reason: "session-activity-malformed" };
      }
      if (activity.length === 0) {
        // P1：**任何**非 sentinel 的空数组都不能证明静止。`workspace/session-activity`
        // 是非专属扩展点，任意第三方 listener 都可以返回一个全新的 `[]`（既不 spread
        // 最内层值，也不检查 subagent 血缘）；sentinel 只能识别「链路没有贡献」，识别不了
        // 「贡献者是谁」。因此这里与 sentinel 同档 fail-closed，绝不能放行等待。
        return { known: false, running: [], reason: "session-activity-empty-not-authoritative" };
      }
      const running = [];
      for (const entry of activity) {
        // 数组同样不是合法的族条目：与权威 listing 的结构校验保持同一严格度。
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          return { known: false, running: [], reason: "session-activity-malformed" };
        }
        // 只消费 subagent 族；其他族（job/schedule/turn）不属于专家后代判定范围。
        if (entry.kind !== "subagent") continue;
        const items = entry.items;
        if (!Array.isArray(items)) {
          return { known: false, running: [], reason: "session-activity-malformed" };
        }
        for (const item of items) {
          if (item === null || typeof item !== "object"
            || typeof item.id !== "string" || item.id.length === 0) {
            return { known: false, running: [], reason: "session-activity-malformed" };
          }
          running.push(item);
        }
      }
      if (running.length > 0) {
        // 确有 running 后代：这是**正向**事实，可以放心作为「继续等待」的依据。
        // 注意这里只用于「继续等待」，绝不用作静止证明。
        const runningIds = new Set();
        for (const item of running) runningIds.add(item.id);
        return { known: true, running, runningIds, reason: "running-descendants" };
      }
      // 非空、但没有任何 running 的 subagent 条目：贡献事实的是别的族
      // （turn/job/schedule…），或者 subagent 族本身是空 items。由于 subagent provider
      // 在空闲时是**原样透传**，这里既无法证明它装载过，也无法证明它报告了空——
      // 必须 fail-closed 继续等待。
      return { known: false, running: [], reason: "session-activity-foreign-families" };
    }


    /**
     * 唯一的 root turn 等待登记表：finalize 与 agent/turn-stopping 兜底共用。
     *
     * 释放条件见 host/turn-wait.js 的模块文档；本处只负责把宿主事实接进来。
     */
    const rootTurnWaits = createRootTurnWaitRegistry({
      isLiveRoot: (agent) => isLiveRootAgent(agent),
      snapshotDescendants: (rootId) => snapshotRootTurnDescendants(rootId),
      subscribe: (agent, invalidate) => subscribeRootActivity(agent, invalidate),
      onKnownSnapshot: (agent, snapshot) => settleFinishedChildTurnWaits(agent, snapshot),
      onError: (error) => logTurnWaitError("check", error),
    });

    /**
     * 真实用户输入会打断当前 root 的等待，但不退休 root 记录，也不清除专家工作。
     * 这样新消息能立即进入下一轮，旧 admission 仍由后续 turn 负责收口。
     */
    function cancelRootTurnWaitForUserInput(agent, reason = "user-message") {
      if (!isRootAgentIdentity(agent) || !isLiveRootAgent(agent)) return false;
      return rootTurnWaits.cancelWaiters(agent, reason);
    }

    /**
     * 释放一个已收到终态 feedback 但没有成功关联到 turn/messageId 的活动范围。
     *
     * DSH 的 durable child 在完成后会进入 ready；ready 不是新的 child turn，
     * 也不应要求 root 通过 notify/finalize 去“结束”它。这里按 parent + child
     * 精确清理插件登记的 activity，保留 child/recovery record，避免把可复用 child
     * 当作已销毁对象处理。role 过滤用于防止同一 childId 的历史 route 误清理。
     */
    function releaseActiveExpertScope(parent, { childId, role } = {}) {
      if (!isRootAgentIdentity(parent) || typeof childId !== "string" || childId.length === 0) return 0;
      const tasks = delegationTracker.listActiveTasks(parent.id).filter((task) =>
        task.childId === childId && (role === void 0 || task.role === role));
      return delegationTracker.completeActiveTasksByIds(tasks.map((task) => task.id));
    }

    function pendingRootUserWait(agent, generation) {
      const wait = pendingUserWaits.get(agent);
      return wait?.agent === agent && wait.session === agent.session && wait.generation === generation
        ? [wait] : [];
    }

    function clearRootUserWait(agent, session) {
      const wait = pendingUserWaits.get(agent);
      if (wait?.agent !== agent || (session !== void 0 && wait.session !== session)) return false;
      pendingUserWaits.delete(agent);
      return true;
    }

    /**
     * authoritative root turn/end 之后提交终止快照。
     *
     * Host 是生命周期权威：递归后代是否仍在运行、live Agent 查询是否可信，全部由
     * host/notifications 内部判定并 fail closed（查询缺失/异常时绝不写入快照）。
     * 这里只负责把 exact root generation/turn 与 turn/end 的 reason 交给模块，
     * 因此 completed/blocked/error/aborted/interrupted/max-tokens 都会各自成为快照原因，
     * 不会再把异常折叠成"任务已完成"。
     */
    function commitRootTerminationSnapshot(agent, session, event) {
      if (!isLiveRootAgent(agent) || agent.session !== session) return;
      const generation = rootGenerationRegistry.generationOf(agent.id);
      if (!Number.isSafeInteger(generation)) return;
      const data = event?.data;
      // 非成功终止同样意味着本次用户等待已经结束；与旧实现保持一致，不留悬挂等待。
      if (data?.reason?.kind !== "completed") clearRootUserWait(agent, session);
      const published = notificationHost.recordTermination({
        rootId: agent.id,
        generation,
        reason: data?.reason,
        turn: data?.turn,
      });
      // 只有权威发布（published === true）才发送一次终态系统通知：
      // 身份未知 / 后代仍在运行 / 已发布 / 已释放等拒绝路径一律不发送，也不补发。
      // 文案只用固定 reason 类别（completed/blocked/error/aborted/interrupted/
      // max-tokens/unknown），异常正文与工具输出永不进入通知。
      if (published?.published === true) {
        sendSystemToast(terminationToastText(published.snapshot?.reason, rootNotificationLabel(session)));
      }
    }
    for (const root of typeof agents?.roots === "function" ? agents.roots() : []) {
      if (isRootAgentIdentity(root) && typeof root.id === "string") {
        host.lineage.activateRoot(root);
        host.lineage.tokenFor(root);
        rootGenerationRegistry.activate(root.id, root);
        // 恢复出的 root 只建立空状态：不能继承同 id 旧 root 遗留的终止快照。
        notificationHost.activateRoot({ rootId: root.id, generation: rootGenerationRegistry.generationOf(root.id) });
      }
    }
    function failureDescriptorForAdmission(parent, admission) {
      const record = recoveryRecords.get(admission?.childId);
      const terminal = pendingChildTurnEnds.get(parent)?.find((item) => item.admission === admission);
      const messageId = messageIdForHandoffAdmission(admission, record);
      return {
        token: admission?.token,
        childId: admission?.childId,
        session: admission?.session ?? record?.session,
        sessionId: admission?.session?.id ?? record?.session?.id,
        messageId,
        turn: terminal?.event?.data?.turn,
      };
    }
    function rememberFailedHandoffChildren(parent, admissions) {
      if (!isRootAgentIdentity(parent) || !Array.isArray(admissions)) return;
      failedHandoffChildren.remember(parent, admissions.map((entry) => failureDescriptorForAdmission(parent, entry)));
    }
    function consumeFailedHandoffChild(parent, childId, admission, context = {}) {
      const query = admission === void 0 ? context : { ...context, token: admission.token };
      return failedHandoffChildren.consume(parent, childId, query);
    }
    function registerPendingHandoffAdmission(parent, role, childId, taskKey) {
      if (!isLiveRootAgent(parent) || typeof role !== "string" || role.length === 0) return void 0;
      // 每个 accepted admission 都必须独占 token；taskKey 只用于绑定 message，不能
      // 合并同 child 的不同 admission（同 task 的重入也可能已被宿主接受）。
      const record = recoveryRecords.get(childId);
      const entry = handoffAdmissionCohort.register(parent, childId, record?.agent);
      // 记录当前 durable Session，失败 tombstone 与 replacement activation 都可精确绑定。
      Object.assign(entry, { parent, parentId: parent.id, role, taskKey, childId, record, session: record?.session, releaseQueued: false });
      host.handoff.add(entry);
      return entry;
    }
    function bindPendingHandoffAdmission(entry, childId, messageId) {
      if (entry === void 0 || !host.handoff.contains(entry) || typeof childId !== "string" || childId.length === 0) return;
      handoffAdmissionCohort.bind(entry, childId, messageId);
      entry.childId = childId;
      if (typeof messageId === "string" && messageId.length > 0) entry.messageId = messageId;
    }
    function bindHandoffAdmissionFromClaimed(agent, messageId) {
      if (typeof agent?.id !== "string" || typeof messageId !== "string" || messageId.length === 0) return;
      for (const entry of host.handoff.entries()) {
        if (entry.childId !== agent.id || entry.parent?.id !== entry.parentId) continue;
        const record = recoveryRecords.get(agent.id);
        if (record?.agent !== agent || record.parentAgent !== entry.parent) continue;
        const binding = record.tasks?.get(entry.taskKey);
        if (binding?.messageId === messageId && entry.messageId === void 0) entry.messageId = messageId;
      }
    }
    /**
     * 摘除一个 pending admission，并把它对应的等待工作**精确结算**。
     *
     * 结算边界就是「exact admission 真正离开 host.handoff」：无论它是被相关
     * settlement 释放、被 fail-closed 清理，还是被 root 退休路径摘除，都只有这一次
     * 真实的移除。等待登记表按 token 精确结算，因此重复调用与迟到事件都是幂等空操作
     * （登记表只认未结算项），绝不会释放别的 admission。
     */
    function removePendingHandoffAdmission(entry) {
      if (entry === void 0) return;
      if (!host.handoff.remove(entry)) return;
      handoffAdmissionCohort.remove(entry);
      const parent = entry.parent;
      const token = typeof entry.token === "string" && entry.token.length > 0 ? entry.token : void 0;
      if (parent !== void 0 && token !== void 0) {
        rootTurnWaits.settle(parent, { kind: "admission", token });
      }
    }
    /**
     * admission 投递失败时只标记当前 token。若 turn/end 已经暂存，立即用该
     * token 结算；若消息仍可能晚到，则保留 tombstone 让 claimed/turn 事件仍能
     * 命中同一 admission，而不是把失败误归给后续同 child admission。
     */
    function failPendingHandoffAdmission(parent, entry, record) {
      if (entry === void 0 || !host.handoff.contains(entry)) return;
      entry.failed = true;
      entry.feedbackSeen = true;
      entry.releaseQueued = true;
      const queued = pendingChildTurnEnds.get(parent)?.some((item) => item.admission === entry) === true;
      const messageId = messageIdForHandoffAdmission(entry, record);
      if (queued || messageId !== void 0) rememberFailedHandoffChildren(parent, [entry]);
      if (queued) settlePendingChildTurnEnds(parent, false, entry);
      // admission 失败不会产生新的 messageId；没有已暂存 turn 时直接删除 token，
      // 避免 failedHandoffChildren 留下永远无法消费的 fallback。
      if (!queued && messageId === void 0) removePendingHandoffAdmission(entry);
    }
    function clearPendingHandoffAdmissions(parent) {
      // 统一走 removePendingHandoffAdmission：它同时负责等待工作的精确结算。
      for (const entry of host.handoff.filter((item) => item.parent === parent)) {
        removePendingHandoffAdmission(entry);
      }
      // 失败路径先把可反查 descriptor 写入 registry；这里仅移除无法按
      // messageId/turn 反查的非终态记录，绝不删除仍可能迟到的 exact tombstone。
      failedHandoffChildren.pruneUnmatchable(parent);
    }
    function pendingHandoffAdmissionFor(parent, childId, admission) {
      if (admission !== void 0) return host.handoff.contains(admission) && admission.parent === parent ? admission : void 0;
      return host.handoff.find((item) => item.parent === parent && item.childId === childId);
    }
    function hasPendingHandoffAdmission(record, childId) {
      return host.handoff.some((item) =>
        item.parent === record?.parentAgent
        && item.role === record?.role
        && item.childId === childId,
      );
    }
    function admissionForTurn(record, session, event, receipt = void 0) {
      const turn = event?.data?.turn;
      if (!Number.isSafeInteger(turn) || record?.session !== session) return void 0;
      const events = Array.isArray(session.events) ? session.events : [];
      const turnMessageIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
      for (const [messageId, claimedTurn] of record.claimed ?? []) {
        if (claimedTurn === turn) turnMessageIds.add(messageId);
      }
      const matches = host.handoff.filter((item) => {
        if (item.parent !== record.parentAgent || item.childId !== session.id || item.failed === true) return false;
        const messageId = messageIdForHandoffAdmission(item, record);
        return typeof messageId === "string" && turnMessageIds.has(messageId);
      });
      if (matches.length === 0) {
        // pause/resume 失败可能已经移除了 cohort entry；迟到 terminal 仍须
        // 通过 exact tombstone 进入 allowRecovery=false 收口。
        const failed = failedHandoffChildren.lookup(record.parentAgent, session.id, {
          session, sessionId: session.id, turn, messageIds: turnMessageIds,
        });
        return failed === void 0 ? void 0 : { ...failed, failed: true, parent: record.parentAgent };
      }
      const group = handoffAdmissionCohort.ensureTurnGroup(record.parentAgent, session.id, turn, record.agent, turnMessageIds);
      // P1 + A：recoverable failure 的 turn/end 不是最终可消费边界。这里必须在 markTurnEnd
      // **之前**判定，并把判定结果传下去：markTurnEnd 仍要记录 turnEnded/turn/group
      // （后续合法 settlement 的消费判定依赖它），但不得按 activation 级 snapshot 把
      // 本轮 token 直接标成 feedbackSeen——那会在 recovery operation 尚未完成时消耗掉
      // token，父 inbox 之后到达的合法 UUID settlement 就再也找不到未消费 entry，child
      // token 永不结算（root 永久等待）。
      //
      // A：判定只用**当前这一个 event/turn** 的 reason/output，不扫描 session.events 的
      // 最新 turn/end（同一同步批次里更晚的普通 turn/end 会让 gate 误判为关闭）。
      const recoveryGateOpen = recoveryFailureGateOpen(record, {
        turn,
        reason: event?.data?.reason ?? {},
        hasOutput: turnHasNonEmptyText(Array.isArray(session.events) ? session.events : [], turn),
      });
      for (const entry of matches) {
        const messageId = messageIdForHandoffAdmission(entry, record);
        handoffAdmissionCohort.markTurnEnd(entry, messageId, turn, record.agent, group, {
          deferSnapshotFeedback: recoveryGateOpen,
        });
        entry.turnEnded = true;
        entry.turn = turn;
        entry.activation = record.agent;
        recordTurnEndEvidence(entry, { session, activation: record.agent, turn, event, receipt });
      }
      // feedback 可能在 turn/end microtask 之前到达；先记录 exact activation，
      // 再在本 turn 的全部 entry 标记 turnEnded 后一次性标记所有已结束 groups。
      //
      // item 2/P1：recoverable failure 的 gate 尚未关闭时，本 turn/end **不是**终态边界：
      // 已排队的 marker（包含无 message.id 的 early delivery）绝不能在这里消费 token，
      // 否则 recovery operation 尚未建立/完成就消费 token 并提前放行 root。marker 保留到 recovery
      // 完成后的真实终态边界（或由 releaseGatedRecoveryFeedback 重新投递的带 UUID 最终
      // 通知走 exact/wildcard 正常路径消费）。
      if (recoveryGateOpen) {
        return matches[0];
      }
      //
      // A3：本 turn 消费**所有**可归属于它的 pending marker（exact 与 wildcard 混存时
      // 不能只摘掉第一个），并只摘掉本次确实消费/确认失效的 marker——既不能把合法下一轮
      // 的 marker 删掉，也不能让已消费的 marker 残留到后续 turn/end 再次消费新 token。
      const pendingFeedbacks = Array.isArray(record.pendingFeedbacks) ? record.pendingFeedbacks : [];
      const consumedMarkers = [];
      for (const marker of pendingFeedbacks) {
        if (marker === null || typeof marker !== "object") {
          // 非法项直接清理，避免后续读字段抛错。
          consumedMarkers.push(marker);
          continue;
        }
        if (marker.activation !== void 0 && marker.activation !== record.agent) {
          // A4 第二道防线：activation 已经换代（replacement / cold resume）的 marker 永不
          // 可能再匹配（cohort 与下面的消费判定都按当前 activation 过滤）。这里直接回收，
          // 避免旧代际 marker 长期滞留；wildcard 的跨代消费在 bindRecoverySession 已被禁止。
          consumedMarkers.push(marker);
          continue;
        }
        // A4：marker 绑定的 Session generation 已经改变时，这条 marker 的关联证据失效。
        if (marker.sessionId !== void 0 && marker.sessionId !== session.id) {
          consumedMarkers.push(marker);
          continue;
        }
        if (marker.admissionId !== void 0) {
          const exact = group.entries.find((entry) => entry.token === marker.admissionId
            || entry.messageId === marker.admissionId);
          // 未命中本 turn 的 exact marker 属于后续轮次，必须保留。
          if (exact === void 0) continue;
          exact.feedbackSeen = true;
          exact.feedbackExact = true;
          consumedMarkers.push(marker);
          continue;
        }
        // wildcard：只有它的到达快照与本 turn 的 group 有交集时才算「关联到本 turn」。
        // 没有快照的旧形态退化为 turn 绑定判定（turn === undefined 视为可消费一次）。
        const restrict = marker.tokens instanceof Set ? marker.tokens : void 0;
        if (restrict !== void 0) {
          // 死 marker 回收：到达快照里的 token 全部已被消费（或被释放）时，这条 marker
          // 已经不可能消费任何未来的 token（restrict 是它的覆盖上界），只能清理。
          const alive = [...restrict].some((token) => host.handoff.some((item) =>
            item.parent === record.parentAgent
            && item.childId === session.id
            && item.token === token
            && item.feedbackSeen !== true
            && item.failed !== true));
          if (!alive) {
            consumedMarkers.push(marker);
            continue;
          }
        }
        const relevant = restrict === void 0
          ? (marker.turn === void 0 || marker.turn === turn)
          : group.entries.some((entry) => restrict.has(entry.token));
        if (!relevant) continue;
        handoffAdmissionCohort.markFeedback(record.parentAgent, session.id, void 0, record.agent, restrict);
        consumedMarkers.push(marker);
      }
      if (consumedMarkers.length > 0) {
        record.pendingFeedbacks = pendingFeedbacks.filter((item) => !consumedMarkers.includes(item));
      }
      // feedback 可能已经在本 turn/end 前到达：本 turn/end 边界本身也可能让 cohort 就绪，
      // 因此这里重新检查一次精确结算（不改变任何 release/清理语义）。
      settleFinishedChildTurnWaits(record.parentAgent);
      // 一个 turn 的所有 admission 共用一次 deferred recovery 结算。
      return matches[0];
    }
    function messageIdForHandoffAdmission(entry, record) {
      if (typeof entry?.messageId === "string" && entry.messageId.length > 0) return entry.messageId;
      const binding = record?.tasks?.get(entry?.taskKey);
      if (typeof binding?.messageId === "string" && binding.messageId.length > 0) {
        entry.messageId = binding.messageId;
        return binding.messageId;
      }
      return void 0;
    }
    function admissionHasEndedTurn(entry, record) {
      const messageId = messageIdForHandoffAdmission(entry, record);
      const events = Array.isArray(record?.session?.events) ? record.session.events : [];
      if (messageId === void 0) return false;
      for (const event of events) {
        const turn = event?.data?.turn;
        if (event?.type !== "turn/end" || !Number.isSafeInteger(turn)) continue;
        if (messageIdsOfTurnWithClaimed(record.claimed, events, turn).has(messageId)) return true;
      }
      return false;
    }
    function feedbackAdmissionId(message) {
      const source = message?.source;
      for (const value of [source?.handoffAdmissionId, source?.admissionId, source?.childMessageId, message?.handoffAdmissionId, message?.admissionId]) {
        if (typeof value === "string" && value.length > 0) return value;
      }
      return void 0;
    }
    /**
     * 父 inbox settlement 的身份账本（A1）。
     *
     * 宿主会以**同一个 message.id** 重复投递同一条 child settlement（重放/重入的 inserted）。
     * 这条副本不是新结论：它一旦进入 cohort 消费/排队，就会用上一轮早已结算的 feedback 去
     * 消费本轮新登记的 token，把本轮 token 的 feedbackSeen 提前置 true → cohort.ready()
     * 提前成立 → root 在本轮结果真正回来之前提前放行。
     *
     * 账本生命周期与 child recovery record 一致（record 被 drop/owner 变更时随之丢弃）：
     * message.id 是 DSH 为每条消息新铸的 UUID，不存在「同 id 被合法复用为下一轮真实
     * settlement」的情况，因此在 record 生命周期内保留 id 是**可证明完备**的去重。
     * 达到 FEEDBACK_DELIVERY_LIMIT 时**不做插入序淘汰**（淘汰会让旧副本重新变成新
     * settlement），改为 fail-closed 饱和：不再记账并置 saturated，使后续无稳定身份的
     * settlement 只能走保守队列路径（见 markPendingHandoffFeedback）。
     */
    function feedbackIdentityLedger(record) {
      if (record.feedbackIdentityLedger === void 0) {
        record.feedbackIdentityLedger = createFeedbackIdentityLedger({ limit: FEEDBACK_DELIVERY_LIMIT });
      }
      return record.feedbackIdentityLedger;
    }

    /**
     * 认领一条 settlement 身份。
     * @returns {{duplicate:boolean, unproven:boolean}} duplicate 表示同 id 副本重投（必须
     *   完全跳过消费与排队）；unproven 表示没有稳定 message.id 或账本已饱和，调用方只能
     *   使用保守路径。
     */
    function claimFeedbackIdentity(record, feedbackMessageId, deliveryId) {
      const wasSaturated = record.feedbackIdentityLedger?.saturated === true;
      // session.id + event.seq 只是本次宿主 delivery 的去重身份，不能冒充 admission id。
      const identityKey = feedbackMessageId !== void 0
        ? feedbackMessageId
        : (typeof deliveryId === "string" && deliveryId.length > 0 ? deliveryId : void 0);
      const identity = feedbackIdentityLedger(record).claim(identityKey);
      if (record.feedbackIdentityLedger.saturated === true && wasSaturated !== true) {
        ctx.logger.warn("dsh-expert-group: feedback identity ledger saturated for child " + record.childId
          + "; further unproven settlements take the conservative queue path");
      }
      return identity;
    }

    /**
     * 到达时刻该 child/activation 上仍未被消费的 admission token 快照。
     *
     * 这是 wildcard（activation 级，无 admissionId）settlement 的**覆盖上界**：一条
     * feedback 只能覆盖它在到达时已经看到的未完成 admission（「关联到当前未完成
     * turn/admission」）。之后 steer 出来的新 token 不在快照里，只能由下一次 feedback
     * 消费——这保证过期的 pending marker 不会在后续 turn/end 把覆盖范围扩展到新轮次。
     */
    function arrivalHandoffTokens(agent, childId, activation) {
      const tokens = new Set();
      for (const item of host.handoff.entries()) {
        if (item.parent !== agent || item.childId !== childId) continue;
        if (item.activation !== void 0 && item.activation !== activation) continue;
        if (item.failed === true || item.feedbackSeen === true) continue;
        if (typeof item.token === "string" && item.token.length > 0) tokens.add(item.token);
      }
      return tokens;
    }

    /**
     * C：source-less Host 完成通知的**同步接收边界快照**。
     *
     * 为什么需要它：通知与 child turn/end 都可能走 session/event 并被延迟到 microtask，
     * 消费时刻重建的快照可能包含「在本通知之后才到达的终态证据」。因此快照必须在
     * **同步入口**（第一次进入 session/event 回调时）固化：
     * - agent/session：接收时的 exact root Agent 与 Session 对象；
     * - childId/activation/record：接收时该 child 的 exact 恢复记录与 Activation；
     * - tokens：接收时刻仍未被消费的 admission token 快照（覆盖上界）；
     * - receipt：本条 session/event 的单调接收序号；
     * - deliveryId：session.id + event.seq 组成的纯 delivery 身份（只用于去重）。
     *
     * 后续异步消费只能**收紧**：token 只能取该快照的子集、activation/session/record 必须
     * 不变、且对应 turn/end 的接收序号必须严格小于本通知的序号。
     */
    function captureSourceLessNoticeReceipt(agent, session, message, deliveryId, receipt) {
      if (message === null || typeof message !== "object" || message.source !== void 0) return void 0;
      if (typeof deliveryId !== "string" || deliveryId.length === 0) return void 0;
      if (!Number.isSafeInteger(receipt) || !isLiveRootAgent(agent) || agent.session !== session) return void 0;
      const childId = subagentFeedbackChildId(message, { allowSourceLess: true });
      if (childId === void 0) return void 0;
      const record = recoveryRecords.get(childId);
      if (record?.parentAgent !== agent || !isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return void 0;
      return {
        agent,
        session,
        childId,
        record,
        activation: record.agent,
        tokens: arrivalHandoffTokens(agent, childId, record.agent),
        receipt,
        deliveryId,
      };
    }

    /**
     * 事件级接收边界快照：只对「当前 live root 的 next-step spliced 注入」建立，返回与
     * `inserted` 数组同下标对齐的 receipt 列表（不匹配的项为 undefined）。
     */
    function captureSourceLessNoticeReceipts(agent, session, event, receipt) {
      if (event?.type !== "agent/inbox/spliced" || event.data?.target !== "next-step") return void 0;
      if (!Array.isArray(event.data?.inserted)) return void 0;
      if (!isLiveRootAgent(agent) || agent.session !== session) return void 0;
      const deliveryId = Number.isSafeInteger(event.seq)
        ? "session-event:" + session.id + ":" + String(event.seq) : void 0;
      if (deliveryId === void 0) return void 0;
      const receipts = [];
      for (const inserted of event.data.inserted) {
        const message = inserted?.message !== undefined ? inserted.message : inserted;
        receipts.push(captureSourceLessNoticeReceipt(agent, session, message, deliveryId, receipt));
      }
      return receipts.some((item) => item !== void 0) ? receipts : void 0;
    }

    /** C：同步快照在消费时刻是否仍然成立（只允许收紧：activation/session/record 必须不变）。 */
    function sourceLessNoticeReceiptIsCurrent(agent, childId, record, receipt, deliveryId) {
      if (receipt === null || typeof receipt !== "object") return false;
      if (receipt.agent !== agent || receipt.session !== agent.session) return false;
      if (receipt.childId !== childId || receipt.record !== record) return false;
      // 快照必须属于**当前这条 delivery**：同一 child 上的其他通知不能借用它的到达位置。
      if (receipt.deliveryId !== deliveryId) return false;
      // activation 换代（replacement / cold resume）后旧快照表达的是旧代际事实，必须整体失效。
      if (receipt.activation !== record.agent) return false;
      if (!Number.isSafeInteger(receipt.receipt) || !(receipt.tokens instanceof Set)) return false;
      return true;
    }

    /**
     * C：记录 entry 当前终态证据的**首次接收顺序**与 exact 身份。
     *
     * 为什么同一终态只保留首次 receipt：宿主可能在同一同步批次里重投递同一条 turn/end
     * （重放/重入，携带的是同一个 event 对象）。若每次都覆盖 receipt，重投递会把 receipt
     * 推到合法通知之后，使这条**身份已被 claim** 的合法通知被错误拒绝，且没有新事件能救回
     * → finalize 永久等待（Oracle P2）。
     *
     * 身份判定 = 同一 exact Session 对象 + 同一 exact child Activation + 同一 turn + 同一
     * 终态证据（同一 event 对象，或在既有 event.seq 契约下同一 seq）。任一维度不同都表示
     * **新终态**（不同 turn / 不同 terminal event / 换代），必须重置到新 receipt——绝不跨
     * turn 取全局最早序号，也绝不复用旧终态给未来通知错配。
     *
     * 附属身份只占 entry 上的**一个槽位**，随 entry 同生命周期；迁移/replacement 时清除，
     * 不建立任何历史列表。
     *
     * @returns {number|undefined} 该 entry 当前生效的接收序号。
     */
    function recordTurnEndEvidence(entry, { session, activation, turn, event, receipt }) {
      const previous = entry.turnEndEvidence;
      const sameEvidence = previous !== void 0
        && previous.session === session
        && previous.activation === activation
        && previous.turn === turn
        && (previous.event === event
          || (Number.isSafeInteger(previous.seq) && Number.isSafeInteger(event?.seq)
            && previous.seq === event.seq));
      // 同一终态的重投递：保留首次 receipt，不推进、不重置。
      if (sameEvidence) return previous.receipt;
      if (!Number.isSafeInteger(receipt)) {
        delete entry.turnEndEvidence;
        return void 0;
      }
      entry.turnEndEvidence = {
        session,
        activation,
        turn,
        event,
        seq: Number.isSafeInteger(event?.seq) ? event.seq : void 0,
        receipt,
      };
      return receipt;
    }

    /**
     * C：source-less notice 允许消费的 token 集合 =
     * 同步接收快照 ∩ 「exact turn/end 的接收顺序严格更早」。
     *
     * 任一条件不成立都不消费、不排队（fail-closed，等真正的结算）：
     * - 通知之后才登记的 token 不在快照里；
     * - 通知之后才发布的 turn/end（同一同步批次里的「notice 先、turn/end 后」）序号更大，
     *   因而属于**未来证据**，本条通知无权消费；
     * - 终态证据的 receipt 是「该 exact 终态（同一 Session/activation/turn/evidence）**首次**
     *   被接收」的序号（见 recordTurnEndEvidence）：同一终态的重投递不会把它推迟，不同
     *   turn/terminal 或换代后的新终态则各自重置——因此这里比较的永远是**当前终态**的首次
     *   到达位置，既不会漏掉合法通知，也不会让未来终态借用旧序号。
     */
    function sourceLessNoticeEligibleTokens(agent, childId, record, receipt) {
      const tokens = new Set();
      for (const token of receipt.tokens) {
        const item = host.handoff.find((entry) => entry.parent === agent
          && entry.childId === childId
          && entry.token === token);
        if (item === void 0 || item.failed === true || item.feedbackSeen === true) continue;
        if (item.activation !== void 0 && item.activation !== record.agent) continue;
        // 终态证据必须属于当前 exact Session/activation，且其接收顺序严格早于本通知。
        // 不同 turn/terminal 或换代后的新终态各有自己的 receipt，绝不复用最早值。
        const evidence = item.turnEndEvidence;
        if (evidence === void 0 || evidence.session !== record.session
          || evidence.activation !== record.agent) continue;
        if (!Number.isSafeInteger(evidence.receipt) || evidence.receipt >= receipt.receipt) continue;
        tokens.add(token);
      }
      return tokens;
    }

    /** 该 child/activation 上是否还有「已登记但 turn 尚未结束」的 admission。 */
    function hasUnendedHandoffAdmission(agent, childId, activation) {
      return host.handoff.some((item) =>
        item.parent === agent
        && item.childId === childId
        && item.failed !== true
        && item.feedbackSeen !== true
        && item.turnEnded !== true
        && (item.activation === void 0 || item.activation === activation));
    }

    /**
     * 每个 child record 的**结算投递账本**（item 1 的无身份保守策略）。
     *
     * 生命周期：绑定 exact child Activation；activation 换代（replacement / cold resume）
     * 即重置——旧代际的投递事实不能约束新代际。
     *
     * 字段语义：
     * - idlessConsumed：本代际是否已经用**无 message.id** 的 delivery 进入过投递管线。
     *   无 id 时协议无法给出任何 delivery identity，第二条无 id delivery 既可能是旧副本
     *   也可能是新一轮真实结算；由于无法证明它属于新轮次，一律不再消费（保守方向：
     *   宁可多等一条带 UUID 的 settlement，也不提前 resume）。
     *   DSH 的真 settlement 由 createUserMessage 铸 UUID，因此线上 `queue=true` steer
     *   的第二轮始终走带身份路径，不受该限制影响。
     *
     * 为什么**没有** relay/notice 形态计数（曾短暂存在，已移除）：
     * DSH core 只铸一种 child 结算通知——`createSettlementMessage()` 产出
     * `source.kind = "subagent-settled"` + `form = "notice"` 且经 createUserMessage 铸 UUID；
     * `subagent-report`(form=relay) 只存在于 legacy session-format 的 payload 校验/迁移里，
     * runtime 不会为同一逻辑结算双投递。按「计数领先即副本」做全局配对没有身份证据，反而会把
     * 真正新一轮的 notice 误判成副本丢弃（该轮 token 永不结算 → root 永久等待）。
     * 因此跨形态去重只保留可证明的部分：message.id 去重（A1）、到达快照收紧（A2/A3）与
     * 无 id fail-closed（item 1）。legacy relay 仍按独立结算通道接受，但不与 notice 配对。
     */
    function settlementDeliveryLedger(record, activation) {
      const current = record.settlementDeliveries;
      if (current !== void 0 && current.activation === activation
        && typeof current.idlessConsumed === "boolean") {
        return current;
      }
      const next = { activation, idlessConsumed: false };
      record.settlementDeliveries = next;
      return next;
    }

    /**
     * A5：只清理**本次 settlement 确切消费/确认失效**的 pending marker。
     *
     * 旧实现对 admissionId === undefined 的 marker 按 activation 宽删，会把另一轮
     * 合法 wildcard marker 一起删掉（随后那一轮永久等不到 feedback → 永久 paused）。
     * 这里改为按 marker 对象身份精确摘除：调用方只传入本次消费/失效的那些项，其他
     * child/activation/turn 的排队不受影响。
     */
    function clearConsumedPendingHandoffFeedbacks(record, matches) {
      if (!Array.isArray(record?.pendingFeedbacks) || typeof matches !== "function") return 0;
      const before = record.pendingFeedbacks.length;
      record.pendingFeedbacks = record.pendingFeedbacks.filter((item) => !matches(item));
      return before - record.pendingFeedbacks.length;
    }

    /**
     * 排队一个「等 turn/end 消费」的 marker，并做身份去重。
     *
     * 去重规则（顺序与旧实现一致，只把 activation 级去重扩展到带身份的快照 marker）：
     * - 同 admissionId 已排队 → 不再入队（exact 身份唯一）；
     * - 同 messageId 已排队 → 不再入队（同一条消息不排两次）；
     * - 无 admissionId 且无 messageId 时，同一 activation 最多保留一个 wildcard marker
     *   （F2：重复排队会让同一条 feedback 在多个 turn/end 各消费一次）。
     *
     * @returns {object} 实际入队的 marker（已存在时返回已有项）。
     */
    function queuePendingHandoffFeedback(record, { admissionId, turn, messageId, activation, sessionId, tokens }) {
      if (!Array.isArray(record.pendingFeedbacks)) record.pendingFeedbacks = [];
      const list = record.pendingFeedbacks;
      if (admissionId !== void 0) {
        const existing = list.find((item) => item?.admissionId === admissionId);
        if (existing !== void 0) return existing;
      } else if (messageId !== void 0) {
        const existing = list.find((item) => item?.messageId === messageId);
        if (existing !== void 0) return existing;
      } else {
        const existing = list.find((item) => item?.admissionId === void 0
          && (item.activation === void 0 || item.activation === activation));
        if (existing !== void 0) return existing;
      }
      const marker = {
        admissionId,
        turn,
        messageId,
        // activation 是到达时的 exact 代际身份；只有 exact marker 允许在 activation
        // replacement 时随 entry 一起迁移，wildcard 跨代即失效（A4）。
        activation,
        sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : void 0,
        tokens: tokens instanceof Set ? new Set(tokens) : void 0,
      };
      list.push(marker);
      return marker;
    }

    function markPendingHandoffFeedback(agent, childId, message, deliveryId, sourceLessHostNotice = false, receipt = void 0) {
      if (!isLiveRootAgent(agent) || typeof childId !== "string" || childId.length === 0) return void 0;
      const record = recoveryRecords.get(childId);
      if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return void 0;
      const feedbackMessageId = typeof message?.id === "string" && message.id.length > 0 ? message.id : void 0;
      const identity = claimFeedbackIdentity(record, feedbackMessageId, deliveryId);
      // 同 id 副本：不消费、不排队。调用方（inbox/inserted microtask）随后仍会走一次
      // 「已就绪 admission 的精确结算」检查，但副本不会让任何 token 就绪，因此是安全空操作。
      if (identity.duplicate) return void 0;
      // B（Oracle 复现）：source-less Host notice 与 unproven 身份的组合必须 fail-closed。
      // unproven = 账本已饱和（或没有稳定身份），此时协议层无法区分「旧副本」与「下一轮真实
      // 结算」。下面的通用无身份分支会按「到达时仍有未结束 admission」把通知排队成 wildcard
      // marker，让这条无法证明属于本轮的通知在**未来** turn/end 消费 future entry，从而凭空
      // 结算 work 并提前放行 root。因此在认领身份之后、任何 admission/marker 操作之前直接
      // 拒绝：不消费、不排队、不写账本（结构化通知仍各自按既有语义处理）。
      if (sourceLessHostNotice && identity.unproven) return void 0;
      // C：source-less notice 必须携带**同步接收边界**快照（exact activation/session/record
      // 与接收序号）。快照缺失或已失效时同样 fail-closed：绝不能退化成「消费时刻重建快照」
      // 的通配消费，那会把晚到的终态证据算进本条通知的覆盖范围。
      if (sourceLessHostNotice && !sourceLessNoticeReceiptIsCurrent(agent, childId, record, receipt, deliveryId)) return void 0;
      const admissionId = feedbackAdmissionId(message);
      const candidates = host.handoff.filter((item) =>
        item.parent === agent
        && item.childId === childId
        && (item.activation === void 0 || item.activation === record.agent)
        && item.feedbackSeen !== true
        && item.failed !== true,
      );
      const entry = candidates.find((item) => admissionId === void 0
        || item.messageId === admissionId || item.token === admissionId);
      // 无 admission 的 settlement 只能在确实命中当前 exact activation 的
      // pending admission 后进入 shared cohort；零 admission 时不创建任何 marker。
      // 这也覆盖 A2 的「首次消费并清理后再次到达」形态：那时没有未消费 admission，
      // 迟到的无身份副本不会重新进入 wildcard union 路径。
      if (entry === void 0) return void 0;
      // 到达快照限制 wildcard 的覆盖上界；shared cohort 仅匹配已结束 turn，
      // 且 activation snapshot 不会把晚到通知之后新增的 token 纳入消费范围。
      const arrivalTokens = arrivalHandoffTokens(agent, childId, record.agent);
      // 无 id 保守策略（item 1）：账本绑定 exact activation，换代即重置。
      const ledger = settlementDeliveryLedger(record, record.agent);
      if (admissionId !== void 0) {
        // 扩展 source 明确携带 admission id 时只消费该 token；通常 DSH source
        // 没有该字段，下面按同一已认领 turn 的 group 消费全部 token。
        const sharedExact = handoffAdmissionCohort.markFeedback(agent, childId, admissionId, record.agent);
        if (sharedExact !== void 0) {
          entry.feedbackSeen = true;
          entry.feedbackExact = true;
          clearConsumedPendingHandoffFeedbacks(record, (item) =>
            item !== null && typeof item === "object"
            && (item.admissionId === admissionId
              || (feedbackMessageId !== void 0 && item.messageId === feedbackMessageId)));
          return entry;
        }
        queuePendingHandoffFeedback(record, {
          admissionId,
          messageId: feedbackMessageId,
          activation: record.agent,
          sessionId: record.session?.id,
        });
        return entry;
      }
      // ── A2 + item 1：无稳定身份的 settlement 只能消费「当前未完成」的 admission ──
      // 没有 message.id（或身份账本已饱和）时，协议层无法区分「旧副本」与「下一轮真实
      // settlement」：两者的 payload 形状完全相同。因此这里采用保守语义：
      // 1. 本 activation 已经用无 id delivery 消费过一次结算 → 后续无 id delivery 无法
      //    证明属于新轮次（Oracle 复现：第一轮的旧副本在第二轮 token 已登记、turn 未结束
      //    时再次到达，会排队并在第二轮 turn/end 把第二轮标成 feedbackSeen 从而提前
      //    release）→ 永久 fail-closed，不消费也不排队；
      // 2. 到达时仍存在未完成（turn 未结束）的 admission → 这是本 activation 的**首次**
      //    无 id 结算，明确关联到当前未完成 turn，允许排入 marker，由该 turn/end 边界消费；
      // 3. 到达时所有 admission 都已结束 → 无法证明它不是早已消费过的旧副本 → 不消费、
      //    不排队（旧实现会立即消费已结束的 group，从而可能提前 release 下一轮）。
      // 方向选择：宁可多等一条带身份的 settlement，也不提前 resume。DSH 的真实
      // settlement 由 createUserMessage 铸 UUID，因此线上路径始终有稳定身份。
      if (identity.unproven) {
        if (ledger.idlessConsumed === true) return entry;
        // 走到这里的只剩普通无 id delivery（inbox/inserted 或没有稳定身份的结算）。
        // source-less Host notice 的 unproven 组合已在上面直接拒绝（它无法证明属于本轮，
        // 不能进入任何 future 队列）。普通 no-id delivery 保持旧的保守规则：必须先观察到
        // 未结束 admission，再延迟到该 turn/end 边界消费。
        if (!hasUnendedHandoffAdmission(agent, childId, record.agent)) return entry;
        // 记账点选在「进入投递管线」而不是「真正消费」：即使该 marker 最终没有消费任何
        // token（例如 turn 从未结束），后续无 id delivery 仍无法证明自己是新结算，
        // 保守方向不变量必须由投递时刻决定，而不是由消费结果决定。
        ledger.idlessConsumed = true;
        queuePendingHandoffFeedback(record, {
          admissionId: void 0,
          messageId: feedbackMessageId,
          activation: record.agent,
          sessionId: record.session?.id,
          tokens: arrivalTokens,
        });
        return entry;
      }
      // 已结束 group 可精确消费（restrict = 到达快照，只覆盖到达时已存在的 token）；
      // 尚未建立 group 时先排队，等 turn/end 绑定全部 messageId 后再标记整组，
      // 不能把多个不同 turn 粗暴合并。
      // C：source-less notice 的候选上界还必须叠加「exact turn/end 的接收顺序更早」这一
      // 条件（同步快照 ∩ 接收顺序）。其他 delivery 保持原样：到达时刻重建的 token 快照。
      const wildcardTokens = sourceLessHostNotice
        ? sourceLessNoticeEligibleTokens(agent, childId, record, receipt)
        : arrivalTokens;
      const sharedGroup = handoffAdmissionCohort.markFeedback(agent, childId, void 0, record.agent, wildcardTokens);
      if (sharedGroup !== void 0) {
        // A（Oracle 复现）：这里**不再镜像**标记 entry.feedbackSeen。handoff entry 与 cohort
        // entry 是同一个对象，sharedGroup 已经把「真正 ended 且命中 restrict 的项」标记完毕；
        // 如果再按 candidates 首项标记一次，就会把一个尚未结束的 future entry 提前标成
        // 「已收到反馈」，使它在本轮 turn/end 之后无需任何通知就被准确结算（提前放行）。
        //
        // 本次消费已经把该 activation 当前全部「到达快照内已结束」的候选标记完毕。
        // 同 activation 的 wildcard marker 再被后续 turn/end 消费只会用**重建的快照**
        // 覆盖当时新登记的 token（提前 release 的直接成因），因此按身份精确摘除：
        // 只删 admissionId === undefined 且 activation 匹配的项，exact marker 与其他
        // 轮次/child 的排队一律保留（A5：不能宽删合法下一轮 marker）。
        clearConsumedPendingHandoffFeedbacks(record, (item) =>
          item !== null && typeof item === "object"
          && item.admissionId === void 0
          && (item.activation === void 0 || item.activation === record.agent)
          && (feedbackMessageId === void 0 || item.messageId === void 0 || item.messageId === feedbackMessageId));
        return entry;
      }
      // source-less Host notice 到达早于匹配 turn/end 时不能排队为未来通配证据；
      // 它只能消费 arrival snapshot 中已经结束的当前 activation cohort。
      if (sourceLessHostNotice) return entry;
      // 不绑定某一个 turn：marker 记录到达快照，turn/end 消费时以此为候选上界，
      // 因此 T1/T2 等多个已结束 turn 各自按自己的结算消费，future token 不受影响。
      queuePendingHandoffFeedback(record, {
        admissionId: void 0,
        messageId: feedbackMessageId,
        activation: record.agent,
        sessionId: record.session?.id,
        tokens: arrivalTokens,
      });
      return entry;
    }
    /**
     * 把 cohort 已就绪的 admission 从等待登记表里**精确结算**。
     *
     * 就绪 = 该 admission 的 turn 已经结束（child turn/end 边界）且收到了精确关联的
     * 父 inbox settlement（cohort.ready 的判定）。这是「exact 完成通知」这条释放通道：
     * 只有精确关联的通知才结算对应的 token，重复/错误/他 root/旧代际的通知都不会命中
     * 未结算项，因此是安全的幂等空操作。
     *
     * entry 本身**不**在这里摘除：它仍由既有的 release/清理路径负责，保证「同一 child
     * 的后续 admission 不会绕过 cohort」的既有语义不变。
     */
    /** 精确结算一个 admission 的等待工作（token 非法 / 已结算时是安全空操作）。 */
    function settleAdmissionTurnWait(agent, entry) {
      const token = typeof entry?.token === "string" && entry.token.length > 0 ? entry.token : void 0;
      if (token === void 0) return false;
      return rootTurnWaits.settle(agent, { kind: "admission", token });
    }

    /**
     * 把已经真正结束的 admission 从等待登记表里**精确结算**。
     *
     * 两条结算通道，严格区分「精确」与「猜测」：
     * 1. **exact 完成通知**：该 admission 的 child turn 已结束，且收到了精确关联的父
     *    inbox settlement（cohort.ready 的判定）。重复 / 错误 / 他 root / 旧代际的通知
     *    都不会让任何 token 就绪，因此是安全的幂等空操作；
     * 2. **完成通知缺失时的回退**（只在拿到**明确**快照时可用）：该 admission 的 turn
     *    已结束，且它的 exact child 明确不在 running 后代列表里。unknown / 查询失败 /
     *    血缘无法确定时绝不会走到这里——调用方只在 `known === true` 的快照上调用。
     *
     * entry 本身**不**在这里摘除：它仍由既有的 release/清理路径负责，保证「同一 child
     * 的后续 admission 不会绕过 cohort」的既有语义不变。
     *
     * @param {object} agent - exact root Agent。
     * @param {{known:boolean,runningIds?:Set<string>}} [snapshot] - 明确的后代快照；
     *   省略时只走通道 1（不启用回退）。
     */
    function settleFinishedChildTurnWaits(agent, snapshot) {
      if (!isLiveRootAgent(agent)) return;
      const known = snapshot?.known === true;
      const runningIds = known && snapshot.runningIds instanceof Set ? snapshot.runningIds : void 0;
      for (const entry of host.handoff.entries()) {
        if (entry.parent !== agent || entry.failed === true) continue;
        if (handoffAdmissionCohort.ready(agent, entry)) {
          settleAdmissionTurnWait(agent, entry);
          continue;
        }
        if (runningIds === void 0) continue;
        if (entry.turnEnded !== true) continue;
        const childId = entry.childId;
        if (typeof childId !== "string" || childId.length === 0) continue;
        if (runningIds.has(childId)) continue;
        settleAdmissionTurnWait(agent, entry);
      }
    }

    /**
     * session/event 和 parent feedback 共用的 exact durable generation 门控。child dispose
     * 后 core 仍可能把已经发布的 event/settlement 送到这里；此时 registry/activation
     * 缺失只表示 exact child 已销毁，record 中保留的 Agent/Session 仍足以继续结算。
     * 但 replacement 若已占据任一当前映射，必须拒绝，不能仅凭 childId 接管旧 generation。
     */
    function isCurrentRecoverySessionIdentity(agent, record, session) {
      const childId = session?.id;
      if (!isLiveRootAgent(agent) || record?.parentAgent !== agent
        || typeof childId !== "string" || record.childId !== childId
        || record.agent === void 0 || record.session === void 0
        || record.session !== session || session.id !== childId
        || record.agent.session !== record.session) return false;
      const currentChild = agents.get(childId);
      if (currentChild !== void 0 && currentChild !== record.agent) return false;
      const activation = childActivationStates.get(session.id);
      return activation === void 0 || activation.agent === record.agent;
    }
    function isCurrentRecoveryFeedbackIdentity(agent, record, childId) {
      return record?.childId === childId
        && isCurrentRecoverySessionIdentity(agent, record, record?.session);
    }
    function currentGatedRecoveryFeedbacks(record) {
      if (!Array.isArray(record?.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks = [];
      const sessionId = record?.session?.id;
      return record.gatedRecoveryFeedbacks.filter((item) =>
        item?.parent === record.parentAgent
        && item.childId === record.childId
        && item.sessionId === sessionId
        && item.activation === record.agent,
      );
    }
    function wasGatedRecoveryFeedback(agent, childId, messageId, message) {
      const record = recoveryRecords.get(childId);
      if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return false;
      const deliveries = record.recoveryFeedbackDeliveries;
      // inject 的同步 inserted 仍需走普通 feedback 处理；只放行这一次 exact message
      // 对象，之后同 id 的迟到副本由 finalized tombstone 拦截。
      if (deliveries instanceof Set && deliveries.has(message)) {
        deliveries.delete(message);
        return false;
      }
      // item 2：无 message.id 的 delivery 没有可比较的 id；此时**只能**用 exact message
      // 对象身份判定（对象身份 tombstone 或 gated 列表里的同对象）。绝不能用
      // `item.messageId === undefined` 去匹配——那会把任意无 id 的合法消息都误判成
      // 「已门控」而永久阻断释放路径。
      if (typeof messageId !== "string" || messageId.length === 0) {
        if (record.recoveryFeedbackObjectTombstones instanceof WeakSet
          && record.recoveryFeedbackObjectTombstones.has(message)) return true;
        return Array.isArray(record.gatedRecoveryFeedbacks)
          && record.gatedRecoveryFeedbacks.some((item) =>
            item.parent === agent && item.childId === childId
            && item.sessionId === record.session?.id
            && item.activation === record.agent
            && item.message === message);
      }
      return (record.recoveryFeedbackTombstones instanceof Map
        && record.recoveryFeedbackTombstones.has(messageId))
        || (Array.isArray(record.gatedRecoveryFeedbacks)
          && record.gatedRecoveryFeedbacks.some((item) =>
            item.parent === agent && item.childId === childId
            && item.sessionId === record.session?.id
            && item.activation === record.agent
            && item.messageId === messageId));
    }
    function hasUnendedCurrentRecoveryAdmission(record) {
      if (!isCurrentRecoveryFeedbackIdentity(record?.parentAgent, record, record?.childId)) return false;
      return host.handoff.some((entry) =>
        entry.parent === record.parentAgent
        && entry.childId === record.childId
        && entry.failed !== true
        && entry.turnEnded !== true
        // entry 在 child acceptance 之前可能尚未回填 activation/session；上面的
        // current record identity 已锁定本次 root/child/generation，不能因此放弃同步门控。
        && (entry.activation === void 0 || entry.activation === record.agent)
        && (entry.session === void 0 || entry.session === record.session),
      );
    }
    /**
     * recoverable failure 链是否仍占用 gate（item 2 的 fail-closed 条件）。
     *
     * 与 recoveryFeedbackGateOpen 的区别：这里**只**看「可恢复失败 / 待决 recovery op」，
     * 不看「admission 已 accepted 但 turn 未结束」。后者对带 id 的 delivery 是撤回理由
     * （可以先 remove 再在最终边界重投递），但无 id delivery 根本无法撤回；此时把它挡在
     * 普通队列外只会让该轮结算永久丢失（token 永远等不到 feedbackSeen）。因此无 id
     * delivery 只在**真正的 recovery 链**打开时被门控；「turn 未结束」由 marker 队列
     * 绑定到达快照、在该 turn/end 精确消费来保证安全。
     *
     * A（Oracle 阻断）：判定必须基于**调用方正在处理的 event/turn 上下文**，绝不能反向扫描
     * `session.events` 的最新 turn/end。session/event 监听器用 queueMicrotask 延迟处理，host
     * 可能在同一同步批次里先发布 recoverable 的 T、再发布普通的 T+1，最后才轮到 T 的
     * microtask；此时扫描 events 会读到 T+1（普通终态）→ gate 误判为关闭 → `markTurnEnd`
     * 回放 activation snapshot 把 T 的 token 提前消费 → 恢复完成后的合法 settlement 再也找不到
     * 未消费 entry（提前 release 或永久 paused）。
     *
     * @param {object} record - child recovery record。
     * @param {{turn:number,reason:object,hasOutput:boolean}} [context] - 当前待处理的 turn/end
     *   上下文；事件处理路径（admissionForTurn）必须显式传入。省略时走「无上下文」分支：
     *   只回答「是否仍有未被 recovery 链终态覆盖的可恢复失败」，不判断 token 归属。
     */
    function recoveryFailureGateOpen(record, context) {
      // 待决 recovery op 与事件发布顺序无关：链未完成就是打开。
      if (record?.pendingRecoveries instanceof Map && record.pendingRecoveries.size > 0) return true;
      if (context !== void 0) {
        const turn = context.turn;
        if (!Number.isSafeInteger(turn)) return false;
        // 该 turn 已经是 recovery 链的合法终态边界（插件已重投递最终通知）→ 关闭。
        if (record.recoveryFeedbackTerminal === true && record.recoveryFeedbackTerminalTurn === turn) return false;
        const reason = context.reason ?? {};
        const hasOutput = context.hasOutput === true;
        return classifyTurnOutcome(reason, hasOutput) === "recoverable"
          && recovery.canAutoRecover(record, reason, hasOutput);
      }
      // 无事件上下文的调用点（父 inbox delivery）：这里不判断「哪一轮 token 归谁」，只判断
      // 「该 child 是否还有**未被 recovery 链终态覆盖**的可恢复失败」。因此：
      // 1. 已处理过的链未完成（recoveryFeedbackActive）→ 打开；
      // 2. 否则回看事件日志中**尚未被 recovery 终态边界覆盖**的 turn/end：只要存在一个
      //    recoverable 且仍有自动恢复预算的 turn/end 就打开。**不能**因为最新的 turn/end
      //    是普通终态就提前返回 false——那正是 A 的缺陷形态（未来普通事件覆盖更早的
      //    recoverable 失败）；也不能读取尚未由 host 发布的 turn（只回看日志中已有的项）。
      // 父 inbox delivery 没有 turn/admission 关联，无法证明自己属于哪一轮；打开 gate 只会
      // 让它先撤回/排队（fail-closed），不会提前消费 token。
      if (record?.recoveryFeedbackActive === true) return true;
      const session = record?.session;
      const events = Array.isArray(session?.events) ? session.events : [];
      const terminalTurn = record?.recoveryFeedbackTerminal === true ? record.recoveryFeedbackTerminalTurn : void 0;
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index];
        const turn = event?.data?.turn;
        if (event?.type !== "turn/end" || !Number.isSafeInteger(turn)) continue;
        // 该 turn 及其之前的所有失败都已被 recovery 链终态覆盖 → 后面的 turn/end 更早，
        // 同样被覆盖，可以直接关闭。
        if (Number.isSafeInteger(terminalTurn) && terminalTurn >= turn) return false;
        const reason = event.data?.reason ?? {};
        const hasOutput = turnHasNonEmptyText(events, turn);
        if (classifyTurnOutcome(reason, hasOutput) === "recoverable"
          && recovery.canAutoRecover(record, reason, hasOutput)) return true;
      }
      return false;
    }
    function recoveryFeedbackGateOpen(record) {
      // admission 已 accepted 但还没有 exact turn/end 时，feedback 也必须先撤回；
      // 不能因 session.events 尚无终态而让 root cohort 误判 ready。
      // 注：无事件上下文的调用点同样只读记录事实（见 recoveryFailureGateOpen 的 A 说明），
      // 不扫描 session.events。
      if (hasUnendedCurrentRecoveryAdmission(record)) return true;
      return recoveryFailureGateOpen(record);
    }
    /**
     * core 在 inserted 回调返回后才可能 wake parent；这里必须同步 remove。若 remove
     * 返回 false 或抛错，消息可能已经被 claim/dispose；仍登记 gated marker 并跳过
     * markPendingHandoffFeedback，保持 fail closed，但不把该消息伪造为可重投递项。每个
     * id 只保存一次，重复 inserted 也必须再次尝试撤回，不能让第二份残留。
     *
     * item 2：**无 message.id 的 delivery 同样必须被门控**。旧实现在缺 id 时直接返回
     * false，于是它继续走普通队列，可能在 recoverable failure 的 recovery operation
     * 尚未建立/完成时就消费 token 并提前放行 root。无 id 时协议不提供任何可寻址身份：
     * - 不能用 inbox.remove(id) 撤回（没有 id）；
     * - 只能用 **exact message 对象身份**登记 gated marker，并把该对象写入对象身份
     *   tombstone（WeakSet，随 GC 回收，不做无界 Set）；
     * - 该 delivery 永远不会被选作最终通知（`removed === true` 是唯一资格），因此
     *   recovery 完成后由插件重新 inject 的**带 UUID**最终通知才是合法结算；
     * - 若 gate 已关闭（无 recovery 待决），无 id delivery 仍可走普通路径（不破坏
     *   正常/兼容通道）。
     */
    function gateRecoverableHandoffFeedback(agent, record, childId, message) {
      if (!isCurrentRecoveryFeedbackIdentity(agent, record, childId)) return false;
      const messageId = typeof message?.id === "string" && message.id.length > 0 ? message.id : void 0;
      const tombstones = record.recoveryFeedbackTombstones instanceof Map
        ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
      const deliveries = record.recoveryFeedbackDeliveries instanceof Set
        ? record.recoveryFeedbackDeliveries : (record.recoveryFeedbackDeliveries = new Set());
      // release 后由 parent.inject 同步触发 inserted；该 exact 对象必须放行一次，
      // 否则自己的最终通知会被 tombstone 拦回，后续同 id 副本才应继续拦截。
      if (deliveries.has(message)) return false;
      if (messageId !== void 0 && tombstones.has(messageId)) {
        try { agent.inbox?.remove?.(messageId); } catch {}
        return true;
      }
      const objectTombstones = record.recoveryFeedbackObjectTombstones instanceof WeakSet
        ? record.recoveryFeedbackObjectTombstones
        : (record.recoveryFeedbackObjectTombstones = new WeakSet());
      if (messageId === void 0) {
        // 同一无 id delivery 重复 inserted：按对象身份识别，必须继续拦截。
        if (objectTombstones.has(message)) return true;
        if (Array.isArray(record.gatedRecoveryFeedbacks)
          && record.gatedRecoveryFeedbacks.some((item) => item.parent === agent && item.childId === childId
            && item.activation === record.agent && item.message === message)) return true;
        // 无 id delivery 只在**真正的 recovery 链**打开时门控（见 recoveryFailureGateOpen 的无
        // 上下文分支：只读已经处理过的记录事实，不扫描 session.events）；
        // 「admission 尚未 turn/end」不构成门控理由（无法撤回，交给 marker 队列在 turn/end 消费）。
        if (!recoveryFailureGateOpen(record)) return false;
      } else if (!recoveryFeedbackGateOpen(record)) {
        return false;
      }
      const queued = Array.isArray(record.gatedRecoveryFeedbacks)
        ? record.gatedRecoveryFeedbacks : (record.gatedRecoveryFeedbacks = []);
      const existing = queued.find((item) => item.parent === agent && item.childId === childId
        && (messageId === void 0 ? item.message === message : item.messageId === messageId));
      if (existing !== void 0) {
        try {
          if (messageId !== void 0) {
            existing.removed = agent.inbox?.remove?.(messageId) === true || existing.removed === true;
          }
        } catch (error) {
          ctx.logger.warn("dsh-expert-group: recovery feedback duplicate remove failed: " + (error instanceof Error ? error.message : String(error)));
        }
        return true;
      }
      if (messageId === void 0) {
        // 无 id：无法 remove，只能登记 removed:false 的 gated marker + 对象身份 tombstone。
        // marker 在 gate 关闭（release/discard/换代/新 turn）时随列表一起丢弃，绝不进入
        // 普通 handoff 队列；恢复完成后由带 UUID 的重新 inject 通知完成合法交接。
        objectTombstones.add(message);
        queued.push({
          messageId: void 0,
          message,
          parent: agent,
          childId,
          sessionId: record.session?.id,
          activation: record.agent,
          removed: false,
        });
        ctx.logger.warn("dsh-expert-group: id-less recovery feedback cannot be retracted; gated until recovery settles");
        return true;
      }
      let removed = false;
      try {
        // Inbox.remove 必须同步返回 true；Promise/false/缺失都不能当作撤回成功。
        removed = agent.inbox?.remove?.(messageId) === true;
      } catch (error) {
        ctx.logger.warn("dsh-expert-group: recovery feedback gate remove failed: " + (error instanceof Error ? error.message : String(error)));
      }
      if (!removed) {
        // 撤回失败的消息不能保存成可重投递项；留下 finalized tombstone，防止
        // 重复 inserted 再走普通 markPending 并错误 resume root handoff。
        tombstones.set(messageId, "blocked");
        return true;
      }
      queued.push({
        messageId,
        message,
        parent: agent,
        childId,
        sessionId: record.session?.id,
        activation: record.agent,
        removed: true,
      });
      return true;
    }
    /**
     * 恢复成功或达到第 6 次失败时，历史异常 feedback 只能留下当前 generation 的一个
     * **标准 settlement**（`subagent-settled`/notice）作为最终交接。先从队列摘除再 inject，
     * 避免 inject 的同步 inserted 回调把同一 message 再门控；投递失败保持 handoff 暂停，
     * 不伪造 parent 已收到最终结论，也不会重复投递或遗留活动范围。
     *
     * B：不再为 legacy `subagent-report`(relay) 保留 fallback——relay 没有 correlation id，
     * 不能证明属于哪一轮，已由 inbox handler 整体 fail-closed（不撤回、不排队、不消费），
     * 因此永远不会出现在 gated 队列里；这里也不允许任何 relay 形态触发交接。
     */
    function tombstoneGatedRecoveryFeedbacks(record, items = currentGatedRecoveryFeedbacks(record)) {
      const tombstones = record.recoveryFeedbackTombstones instanceof Map
        ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
      for (const item of items) {
        if (typeof item?.messageId === "string") tombstones.set(item.messageId, "blocked");
      }
    }
    function releaseGatedRecoveryFeedback(record, terminalTurn) {
      const queued = currentGatedRecoveryFeedbacks(record);
      const tombstones = record.recoveryFeedbackTombstones instanceof Map
        ? record.recoveryFeedbackTombstones : (record.recoveryFeedbackTombstones = new Map());
      const deliveries = record.recoveryFeedbackDeliveries instanceof Set
        ? record.recoveryFeedbackDeliveries : (record.recoveryFeedbackDeliveries = new Set());
      // 先给所有已撤回消息留下 finalized marker；只有确实 remove===true 的最新标准
      // settlement 才有资格作为最终通知。remove 失败项不能伪造交接。
      for (const item of queued) {
        if (typeof item?.messageId === "string") tombstones.set(item.messageId, "blocked");
      }
      if (Array.isArray(record?.gatedRecoveryFeedbacks)) {
        record.gatedRecoveryFeedbacks = record.gatedRecoveryFeedbacks.filter((item) => !queued.includes(item));
      }
      record.recoveryFeedbackTerminal = true;
      record.recoveryFeedbackTerminalTurn = terminalTurn;
      const finalNotice = [...queued].reverse().find((item) => item.removed === true
        && item.message?.source?.kind === "subagent-settled");
      if (finalNotice === void 0) return false;
      tombstones.set(finalNotice.messageId, "delivering");
      deliveries.add(finalNotice.message);
      try {
        if (typeof record.parentAgent?.inject !== "function") {
          deliveries.delete(finalNotice.message);
          tombstones.set(finalNotice.messageId, "blocked");
          ctx.logger.warn("dsh-expert-group: recovery feedback final delivery unavailable");
          return false;
        }
        record.parentAgent.inject(finalNotice.message);
        tombstones.set(finalNotice.messageId, "delivered");
        return true;
      } catch (error) {
        deliveries.delete(finalNotice.message);
        tombstones.set(finalNotice.messageId, "blocked");
        ctx.logger.warn("dsh-expert-group: recovery feedback final delivery failed: " + (error instanceof Error ? error.message : String(error)));
        return false;
      }
    }
    function discardGatedRecoveryFeedbacks(record, terminalTurn) {
      tombstoneGatedRecoveryFeedbacks(record);
      if (Array.isArray(record?.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
      record.recoveryFeedbackTerminal = true;
      record.recoveryFeedbackTerminalTurn = terminalTurn;
    }
    function resetRecoveryFeedbackGateForNewTurn(record, session, turn) {
      if (record?.recoveryFeedbackTerminal !== true || record.recoveryFeedbackTerminalTurn === turn
        || record.session !== session) return;
      // 同一 Session 的新 turn 是下一项任务；此前终态的重投递已经结束，可重新门控。
      record.recoveryFeedbackTerminal = false;
      record.recoveryFeedbackTerminalTurn = void 0;
      tombstoneGatedRecoveryFeedbacks(record);
      record.recoveryFeedbackDeliveries?.clear?.();
      if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
    }

    function childTurnNeedsImmediateRecovery(record, session, event) {
      const turn = event?.data?.turn;
      const events = Array.isArray(session?.events) ? session.events : [];
      if (!Number.isSafeInteger(turn)) return false;
      const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
      if (record.pendingRecoveries instanceof Map
        && findRecoveryOpByMessage(record.pendingRecoveries, turnMsgIds) !== void 0) return true;
      const reason = event?.data?.reason ?? {};
      const hasOutput = turnHasNonEmptyText(events, turn);
      return classifyTurnOutcome(reason, hasOutput) === "recoverable"
          && recovery.canAutoRecover(record, reason, hasOutput);
    }

    /**
     * 已确认属于当前 child/session/turn 的正常终态，不能因父 inbox 尚未收到 settlement
     * 而继续占用 root 的文件范围。通常 admission 是 exact token；mixed admission 时当前
     * turn 可能是 continue_parent_turn（没有 admission token），仍按该 turn 的稳定
     * messageId/taskKey 精确释放 activity。这里只释放 activity，不消费 pending turn/end、
     * 不改变 admission；可恢复异常仍保留 activity，交给恢复链终态处理。
     */
    function releaseTerminalActivitiesBeforeHandoffFeedback(record, session, event, admission) {
      if (admission?.failed === true || record?.session !== session) return;
      // handleChildTurnEnd 之后仍会用 sessionState.claimTurn 去重；提前释放在它
      // 之前发生，因此 exact admission 自身也要记住首次判定，避免迟到旧 event
      // 在 recoveryCount 改变后把原本 recoverable 的 activity 误判为终态。
      if (admission?.terminalActivityOutcome !== void 0) return;
      const turn = event?.data?.turn;
      const events = Array.isArray(session?.events) ? session.events : [];
      if (!Number.isSafeInteger(turn)) return;
      const reason = event?.data?.reason ?? {};
      const hasOutput = turnHasNonEmptyText(events, turn);
      const outcome = classifyTurnOutcome(reason, hasOutput);
      const recoveryCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
        ? record.recoveryCount : 0;
      const willRecover = outcome === "recoverable" && shouldAutoRecover(reason, hasOutput, recoveryCount);
      if (admission !== void 0) admission.terminalActivityOutcome = willRecover ? "recoverable" : outcome;
      if (willRecover) return;

      // admissionForTurn 已按 exact child/session/messageId 认领；mixed admission 没有
      // handoff token 时也只能使用当前 turn 的 messageId/taskKey。不能按 childId 粗暴
      // 清理替代 child 或同 child 的其他活动任务。
      const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
      const admissionMessageId = admission === void 0 ? void 0 : messageIdForHandoffAdmission(admission, record);
      if (typeof admissionMessageId === "string") turnMsgIds.add(admissionMessageId);
      const taskKeys = taskKeysForTurn(record.tasks, turnMsgIds);
      const activityIds = delegationTracker.activeTaskIdsForTurn({
        parentId: record.parentId,
        role: record.role,
        childId: record.childId,
        turnMsgIds,
        taskKeys,
      });
      delegationTracker.completeActiveTasksByIds(activityIds);
    }

    function deferChildTurnEnd(record, session, event, admission) {
      const parent = record?.parentAgent;
      if (!isRootAgentIdentity(parent)) return;
      const entries = pendingChildTurnEnds.get(parent) ?? [];
      const turn = event?.data?.turn;
      if (!entries.some((entry) => entry.record === record && entry.session === session && entry.event?.data?.turn === turn)) {
        entries.push({ record, session, event, childId: session?.id, admission, parent });
      }
      pendingChildTurnEnds.set(parent, entries);
    }
    function isCurrentChildRecord(record, session) {
      const childId = session?.id;
      const current = typeof childId === "string" ? agents.get(childId) : void 0;
      const activation = typeof childId === "string" ? childActivationStates.get(childId) : void 0;
      return recoveryRecords.get(childId) === record
        && record?.agent === current
        && activation?.agent === record.agent
        && record?.session === session;
    }
    function consumeChildTurnEnd(parent, record, session, event, admission) {
      const turn = event?.data?.turn;
      const events = Array.isArray(session?.events) ? session.events : [];
      const messageIds = messageIdsOfTurnWithClaimed(record?.claimed, events, turn);
      const failed = consumeFailedHandoffChild(parent, session?.id, admission, {
        session,
        sessionId: session?.id,
        turn,
        messageIds,
      });
      handleChildTurnEnd(record, session, event, { allowRecovery: !failed });
    }
    function settlePendingChildTurnEnds(parent, allowRecovery, admission) {
      const entries = pendingChildTurnEnds.get(parent);
      if (entries === void 0) return;
      const selected = admission === void 0 ? entries : entries.filter((entry) => entry.admission === admission);
      if (selected.length === 0) return;
      const selectedSet = new Set(selected);
      const remaining = entries.filter((entry) => !selectedSet.has(entry));
      if (remaining.length === 0) pendingChildTurnEnds.delete(parent);
      else pendingChildTurnEnds.set(parent, remaining);
      for (const entry of selected) {
        if (!isCurrentChildRecord(entry.record, entry.session)) continue;
        try {
          const turn = entry.event?.data?.turn;
          const events = Array.isArray(entry.session?.events) ? entry.session.events : [];
          const messageIds = messageIdsOfTurnWithClaimed(entry.record?.claimed, events, turn);
          const failed = consumeFailedHandoffChild(parent, entry.childId, entry.admission, {
            session: entry.session, sessionId: entry.session?.id, turn, messageIds,
          });
          handleChildTurnEnd(entry.record, entry.session, entry.event, { allowRecovery: allowRecovery === true && !failed });
        } catch (error) {
          ctx.logger.warn("dsh-expert-group: pending child turn/end handler failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
    }
    function clearPendingChildTurnEnds(parent, record) {
      const entries = pendingChildTurnEnds.get(parent);
      if (entries === void 0) return;
      const remaining = record === void 0 ? [] : entries.filter((entry) => entry.record !== record);
      if (remaining.length === 0) pendingChildTurnEnds.delete(parent);
      else pendingChildTurnEnds.set(parent, remaining);
    }
    function migrateChildHandoff(parent, previousChildId, nextChildId, nextActivation, previousActivation) {
      if (!isRootAgentIdentity(parent) || previousChildId === nextChildId) return;
      for (const entry of host.handoff.entries()) {
        if (entry.parent === parent && entry.childId === previousChildId) {
          handoffAdmissionCohort.rebindChild(entry, nextChildId);
          entry.childId = nextChildId;
          entry.messageId = void 0;
          entry.turnEnded = false;
          entry.feedbackSeen = false;
          entry.feedbackExact = false;
          entry.releaseQueued = false;
          // C：replacement 迁移后旧代际的终态身份与接收顺序不再成立；新 child 的首个终态
          // 必须重新登记（receipt 与其附属 exact 身份同生命周期，随迁移一起清除）。
          delete entry.turnEndEvidence;
          // replacement child 开启新的 turn 归属判断；不能沿用旧 activation 已记录的
          // terminal/recoverable 结果，否则新 child 的首次终态会被提前返回跳过。
          entry.terminalActivityOutcome = void 0;
        }
      }
      if (nextActivation !== void 0) {
        handoffAdmissionCohort.updateActivation(parent, nextChildId, nextActivation, {
          previousActivation, nextSession: nextActivation?.session,
        });
      }
    }
    /**
     * root 用户等待（ask_user_question / exit_plan_mode）的同步 guard。
     *
     * 改造后的职责边界：
     * - **不再**暂停/恢复任何 durable goal。用户等待本身由宿主保持 root turn 打开
     *   （宿主完整 await 工具 execute 的返回），goal round driver 只在 root idle 时
     *   推进，因此这里没有任何 goal API 调用，也不需要 barrier；
     * - 保留非 goal 的 pending-user-wait 记账与一次性提示音：按 exact root Agent 记录
     *   当前等待的工具名，同一次等待重复进入 guard（重试/重复调用）不重复提示，
     *   等待被清理后再次登记才再提示一次；
     * - root 已销毁 / 代际被替换 / 插件卸载中一律拒绝：此时不能开始一个没有归属的等待。
     *
     * @param {object} agent - guard 所属的 exact root Agent。
     * @param {object} execution - 待执行的 ToolExecution。
     * @returns {string|undefined} 拒绝原因；undefined 表示放行。
     */
    function rootUserWaitGuard(agent, execution) {
      if (execution?.agent !== agent || (execution?.name !== "ask_user_question" && execution?.name !== "exit_plan_mode")) return void 0;
      if (turnWaitStopping || !isLiveRootAgent(agent)) return "Cannot start user wait because the exact root Agent is no longer live.";
      // 统一登记点：root 用户等待只有这一处写入，因此通知也接在这里，避免出现第二份登记。
      const previousWait = pendingUserWaits.get(agent);
      pendingUserWaits.set(agent, {
        agent,
        session: agent.session,
        generation: rootGenerationRegistry.generationOf(agent.id),
        tool: execution.name,
      });
      // 同一次等待里重复进入 guard（重试/重复调用）不重复提示；等待被清理后再次登记才再提示一次。
      if (previousWait === void 0 || previousWait.tool !== execution.name) {
        sendSystemToast(userWaitToastText(execution.name, rootNotificationLabel(agent.session)));
      }
      return void 0;
    }

    /**
     * 把一批已 settle 的 accepted admission 登记进唯一的 root turn 等待登记表。
     *
     * 判定必须与 finalize 的 acceptedEntries 完全一致：reused / continue_parent_turn
     * 的 admission 不产生"未结算工作"，但它们**仍然可能留下正在运行的子代理**
     * （continue_parent_turn 的 child 就是典型的后台运行），因此这里对它们只做
     * `engage`（保证该 root 已进入等待体系，让 turn-stopping 兜底参与判定），
     * 不登记工作项。
     *
     * @param {object} parent - exact root Agent。
     * @param {object[]} entries - 开放批次里的 accepted admission entry。
     * @returns {{tracked:number, engaged:number, invalid:number}} 登记统计。
     */
    function registerRootTurnWaitWork(parent, entries) {
      let tracked = 0;
      let engaged = 0;
      let invalid = 0;
      for (const entry of entries) {
        const outcome = entry?.outcome;
        if (outcome?.kind !== "continuable") continue;
        if (outcome.reused === true || outcome.continueParentTurn === true) {
          if (rootTurnWaits.engage(parent)) engaged += 1;
          continue;
        }
        const admission = outcome.handoffAdmission;
        // admission 已失效（被其他路径释放/清理）：没有可结算的工作，也不登记——
        // 登记一个永远不会结算的键会让 root 永久等待。
        if (admission === void 0 || host.handoff.contains(admission) !== true || admission.parent !== parent) {
          invalid += 1;
          continue;
        }
        const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
        if (token === void 0) {
          invalid += 1;
          continue;
        }
        if (rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0) {
          // 等待登记成功即「该 admission 的等待屏障已建立」——这正是 cohort 的 pauseDone
          // 在旧实现里表达的语义（字段名来自 goal pause 时代，这里保留以免扩大改动面）。
          handoffAdmissionCohort.markPauseDone(admission);
          tracked += 1;
        }
      }
      return { tracked, engaged, invalid };
    }

    /**
     * root-only 显式收口：登记调用方明确列出的、已经返回结果的 admission，然后**立即**
     * 返回非终态 waiting 回执（两阶段语义）。
     *
     * 1. 校验阶段与旧实现完全一致（token 集完整性、outcome 已 settle、
     *    continue_parent_turn / safeParallelWork 等拒绝条件、root generation）；
     * 2. 把每个 accepted admission **一次性**登记进唯一的 root turn 等待登记表，并把批次
     *    标为 pending-close（保存 exact admission 凭据）；
     * 3. **立即**返回 `{kind:"waiting", admissionEpoch, acceptedCount, reason:"experts-running"}`。
     *    工具调用绝不在 run_code 内等待专家结束，也绝不使用 `exec.signal` 等待——PTC 的
     *    600000ms 墙钟因此不再能截断收口；
     * 4. 继续等待由 root turn 的 `agent/turn-stopping` serial 边界承担（见
     *    awaitRootTurnWaitFallback）：它用**本次 root turn 的 signal** 等待同一张账本，
     *    释放条件仍是 host/turn-wait.js 的 fail-closed 静止判定（无未结算工作 + root-scoped
     *    查询明确无 running 后代；unknown / 查询失败一律继续等待，**不设任何超时**）；
     * 5. 等待明确释放后，插件以同步 `Agent.steer` 向同一 run 的下一 step 投递**一次**
     *    DEG 来源的终态结论，然后一次性关闭批次。
     *
     * 与旧实现的关键差异：
     * - **不再在工具调用内等待**：waiting 是非终态回执，终态结论通过后续模型 step 交付；
     * - **不再调用 exec.concludeTurn()**：turn 由宿主在工具返回后自然关闭；
     * - **不再暂停/恢复任何 goal**：不再有 paused/concluded 之类的回执字段；
     * - 相同批次的重复合法 finalize 返回**稳定** waiting（不重复登记、不关闭、不投递）；
     *   回执里的 acceptedCount 报告该批次当前的完整 accepted 集（含 pending-close 期间
     *   新接受的 admission）。
     */
    async function finalizeRootAdmissionBatch(parent, exec, args, rootToken) {
      const epoch = args?.admissionEpoch;
      const tokens = args?.admissionTokens;
      const base = {
        admissionEpoch: Number.isSafeInteger(epoch) ? epoch : 0,
        acceptedCount: 0,
      };
      if (args?.summaryCompleted !== true || args?.outcomesChecked !== true) {
        return { kind: "rejected", ...base, reason: "summary-or-outcome-check-required" };
      }
      if (args?.safeParallelWork === true) {
        return { kind: "rejected", ...base, reason: "safe-parallel-work-remains" };
      }
      if (!Number.isSafeInteger(epoch) || !Array.isArray(tokens)) {
        return { kind: "rejected", ...base, reason: "invalid-admission-token-set" };
      }
      // 拒绝/不完整回执必须带上可自诊断的 message。reason 仍是稳定机器码（契约与既有
      // 测试都按 reason 断言），message 只补充「当前真实状态是什么」，让模型不必再靠猜
      // 去补齐 admissionTokens / admissionEpoch。
      const batch = rootAdmissionBatches.get(parent);
      if (batch === void 0) {
        if (epoch === 0 && tokens.length === 0) return { kind: "noop", ...base, reason: "no-admission" };
        return {
          kind: "rejected",
          ...base,
          reason: "stale-admission-epoch",
          message: "no open admission batch",
        };
      }
      // 已关闭批次上的「无 admission」调用（epoch 0 + 空 token 集）是幂等 no-admission，
      // 不是 stale：模型在没有调用任何 role 工具时被要求用这个凭据收口，重复调用必须与
      // 首次调用（没有开放批次时的 no-admission）得到同一个结论。这个判定必须早于 epoch
      // 比较——0 永远不等于任何真实 epoch，放在后面会被 stale 分支抢先。**非零** epoch
      // 仍然按 stale-admission-epoch 拒绝（那是真的过期凭据）。
      if (batch.closed === true && epoch === 0 && tokens.length === 0) {
        return { kind: "noop", ...base, reason: "no-admission" };
      }
      if (batch.epoch !== epoch) {
        return {
          kind: "rejected",
          ...base,
          reason: batch.closed ? "stale-admission-epoch" : "admission-epoch-mismatch",
          message: "current open admissionEpoch is " + batch.epoch,
        };
      }
      if (batch.closed === true) return { kind: "noop", ...base, reason: "already-finalized" };
      if (batch.finalizing === true) return { kind: "rejected", ...base, reason: "finalization-in-progress" };
      const uniqueTokens = [...new Set(tokens)];
      const expectedTokens = [...batch.entries.keys()];
      if (uniqueTokens.length !== tokens.length || uniqueTokens.length !== expectedTokens.length
        || expectedTokens.some((token) => !uniqueTokens.includes(token))) {
        return {
          kind: "rejected",
          ...base,
          reason: "incomplete-admission-token-set",
          message: "expected " + expectedTokens.length + " admissionToken(s) in epoch " + batch.epoch
            + "（含 accepted/advisory/failure/reused 全部结果）",
        };
      }
      const entries = expectedTokens.map((token) => batch.entries.get(token));
      if (entries.some((entry) => entry?.settled !== true || entry.outcome === void 0)) {
        return { kind: "rejected", ...base, reason: "admission-outcome-pending" };
      }
      // continue_parent_turn 的 admission 仍必须纳入完整 token 检查，但它本身没有
      // handoff。若同一开放批次后续已没有安全并行工作，仍应只收口普通 accepted admission；
      // 只有纯 continue 批次才拒绝 finalize，避免安全并行任务把批次永久锁死。
      const acceptedEntries = entries.filter((entry) => entry.outcome?.kind === "continuable"
        && entry.outcome.reused !== true && entry.outcome.continueParentTurn !== true);
      if (acceptedEntries.length === 0 && entries.some((entry) => entry.outcome?.continueParentTurn === true)) {
        return { kind: "rejected", ...base, reason: "continue-parent-turn" };
      }
      if (acceptedEntries.some((entry) => entry.outcome.handoffAdmission === void 0)) {
        return { kind: "rejected", ...base, reason: "accepted-handoff-missing" };
      }
      if (acceptedEntries.length === 0) {
        batch.closed = true;
        return { kind: "noop", ...base, reason: "no-accepted-admission" };
      }
      // 同一批次的重复**合法** finalize（同样的 epoch 与完整 token 集）必须得到稳定的
      // waiting：既不重复登记 work，也不重复关闭或投递。这项判定放在全部校验之后，因此
      // 错误/陈旧凭据仍会按上面的分支立即 rejected。
      if (batch.pendingClose !== void 0) {
        return {
          kind: "waiting",
          ...base,
          // 批次仍开放时可能有 pending-close 期间新接受的 admission；回执报告批次当前的
          // 完整 accepted 集（初始那次回执是已返回的快照，不追写）。
          acceptedCount: pendingCloseAcceptedCount(parent),
          reason: "experts-running",
        };
      }
      // 两阶段收口：① 登记等待工作并标记 pending-close（同步、无任何 await）；
      // ② 立即返回非终态 waiting。登记必须在返回前完成，否则「登记前到达的 child 完成
      // 通知」会找不到工作项而变成空操作；而工具调用本身绝不等待。
      batch.finalizing = true;
      try {
        if (!host.lineage.isLiveGeneration(parent, rootToken)) {
          batch.closed = true;
          return { kind: "rejected", ...base, acceptedCount: acceptedEntries.length, reason: "root-generation-retired" };
        }
        registerRootTurnWaitWork(parent, acceptedEntries);
        // pending-close 保存 exact admission 对象：等待账本的记录会在一次静止收口后被
        // 销毁（此时 isEngaged() 为 false），后续 turn-stopping 只能靠这份凭据重新登记
        // 尚未结算的 work —— 它绝不重新登记已结算项（登记键会永远等不到结算）。
        //
        // 这里**不**缓存 acceptedCount：批次在收口前始终开放（pending-close 期间新接受的
        // admission 会被原地追加进 admissions），任何数量都必须在使用点现算（见
        // pendingCloseAcceptedCount），否则旧快照会漏掉新工作。
        batch.pendingClose = {
          admissionEpoch: epoch,
          admissions: acceptedEntries.map((entry) => entry.outcome.handoffAdmission),
        };
        return {
          kind: "waiting",
          ...base,
          acceptedCount: acceptedEntries.length,
          reason: "experts-running",
        };
      } finally {
        batch.finalizing = false;
      }
    }

    /**
     * 取 pending-close 批次的**同步快照**（未关闭、且确实登记过收口）。
     *
     * 只返回已保存的状态对象本身：它由 finalize 一次性写入，之后只能**原地**追加
     * pending-close 期间新接受的 exact admission（见 notePendingCloseAdmission），绝不
     * 重建或拷贝——拷贝会让投递前的身份校验失去意义。
     *
     * @returns {object|undefined} pending-close 状态；无待收口批次时为 undefined。
     */
    function pendingCloseBatchFor(parent) {
      const batch = rootAdmissionBatches.get(parent);
      if (batch === void 0 || batch.closed === true || batch.pendingClose === void 0) return void 0;
      return batch.pendingClose;
    }

    /**
     * 取开放批次里**当前**已接受的 exact 工作（活视图，不是冻结快照）。
     *
     * why 必须是活视图：pending-close 是**批次级** latch，批次在收口前始终开放——用户插话
     * 后的后续 root turn 仍会通过 beginRootAdmission 把新的 role admission 加进**同一个**
     * epoch。冻结在 finalize 时刻的 admission 列表会漏掉这些新工作：重新等待会少等一项，
     * 收口结论的 acceptedCount 也会停在旧值。
     *
     * 判定与 finalizeRootAdmissionBatch 的 acceptedEntries 完全一致：reused /
     * continueParentTurn 不产生「未结算工作」（它们留下的运行中 child 由 root-scoped
     * 后代查询负责挡住）。
     *
     * @param {object} parent - exact root Agent。
     * @returns {{token:string, admission:object, released:boolean}[]} 已接受工作；
     *   `released` 为 true 表示该 admission 已离开 host.handoff（已结算 / 已释放）。
     */
    function acceptedBatchWorks(parent) {
      const batch = rootAdmissionBatches.get(parent);
      if (batch === void 0) return [];
      const works = [];
      for (const entry of batch.entries.values()) {
        const outcome = entry?.outcome;
        if (entry?.settled !== true || outcome === void 0) continue;
        if (outcome.kind !== "continuable" || outcome.reused === true || outcome.continueParentTurn === true) continue;
        const admission = outcome.handoffAdmission;
        if (admission === void 0 || admission.parent !== parent) continue;
        const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
        if (token === void 0) continue;
        works.push({ token, admission, released: host.handoff.contains(admission) !== true });
      }
      return works;
    }

    /**
     * 批次当前**完整 accepted 集**的规模。
     *
     * 收口结论与重复的 waiting 回执都用它现算：pending-close 期间新接受的 admission 也是
     * 这个批次的一部分，回放 finalize 时刻的旧快照会让模型看到与实际收口集合不符的数量。
     * 初始那次 waiting 回执是已返回的快照，不做追写。
     */
    function pendingCloseAcceptedCount(parent) {
      return acceptedBatchWorks(parent).length;
    }

    /**
     * 把 pending-close 期间**新接受**的 role admission 立即归入同一次收口的 exact work 集。
     *
     * why 需要这个写入口：该批次的收口等待可能正在飞（被打断的 turn 之后，模型在新 step
     * 里又拉起一个专家）。只依赖 turn-stopping 起点的一次性重新登记时，这段等待里新接受
     * 的工作就不在等待账本上，静止判定只剩「查不到 running 后代」这条启发式依据——一旦新
     * child 恰好不在 running 列表里（例如它已经结束 turn、精确结算尚未到达），批次就会在
     * exact work 未释放时提前收口并投递终态结论。
     *
     * 登记键必须与精确结算用的键完全一致（admission 自己的 token）；已经离开 host.handoff
     * 的凭据绝不登记，否则会留下一个永远等不到结算的键，让 root 永久悬挂。
     *
     * @param {object} parent - exact root Agent。
     * @param {object} admission - 新接受的 exact handoff admission。
     * @returns {boolean} 是否成功进入等待账本（诊断用；判定不依赖它）。
     */
    function notePendingCloseAdmission(parent, admission) {
      const pendingClose = pendingCloseBatchFor(parent);
      if (pendingClose === void 0 || admission === void 0 || admission.parent !== parent) return false;
      if (host.handoff.contains(admission) !== true) return false;
      const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
      if (token === void 0) return false;
      // 归入 exact work 集：只把同一个 exact admission 对象追加进快照数组，绝不重建该对象
      // ——deliverRootFinalizationConclusion 依赖 pendingClose 的对象身份做重复投递复查。
      if (!pendingClose.admissions.includes(admission)) pendingClose.admissions.push(admission);
      const tracked = rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0;
      // 与 finalize / turn-stopping 的登记路径一致：登记成功即「等待屏障已建立」，
      // cohort 才会把该 admission 判定为可精确结算。
      if (tracked) handoffAdmissionCohort.markPauseDone(admission);
      return tracked;
    }

    /**
     * 依据 pending-close 保存的 exact admission 信息**以及开放批次当前的已接受工作活视图**，
     * 重新登记**尚未结算**的 work 并把该 root engage 进同一张等待账本。
     *
     * 为什么必须能「重新登记」：等待账本的一条记录在一次静止收口后立即销毁，此后
     * `track`/`settle` 都找不到它，`isEngaged()` 也为 false。若只依赖账本现状，
     * pending-close 批次就会在「child 先静止、turn-stopping 后到」的合法时序里既收不了口、
     * 也投递不了结论（登记键必须与精确结算用的键完全一致，因此这里用 admission 自己的
     * token，而不是 batch/ticket token）。
     *
     * 只登记仍在 handoff 里的 admission：已结算/已释放的凭据再登记会得到一个永远等不到
     * 结算的键，让 root 永久悬挂（fail-closed 的另一面）。
     *
     * @returns {number} 本次成功登记的 work 数（诊断用；判定不依赖它）。
     */
    function reengagePendingCloseWorks(parent, pendingClose) {
      // 并集：① finalize 快照里保存的 exact admission；② 开放批次当前的已接受工作活视图
      // （含 pending-close 期间新接受的 admission——它们必须被本次等待一并覆盖）。
      const candidates = [
        ...pendingClose.admissions,
        ...acceptedBatchWorks(parent).map((work) => work.admission),
      ];
      const seen = new Set();
      let tracked = 0;
      for (const admission of candidates) {
        if (admission === void 0 || admission.parent !== parent) continue;
        if (host.handoff.contains(admission) !== true) continue;
        const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
        if (token === void 0 || seen.has(token)) continue;
        seen.add(token);
        if (rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0) {
          handoffAdmissionCohort.markPauseDone(admission);
          tracked += 1;
        }
      }
      // 即使没有可登记的工作（reused/continue 批次或已全部结算），也必须 engage：静止
      // 判定要由同一状态机给出**明确**结论，而不是「从未参与」这种无法证明的默认。
      rootTurnWaits.engage(parent);
      return tracked;
    }

    /**
     * 构造一次收口结论的模型可见正文。
     *
     * 只表达「收口已完成 + admissionEpoch + acceptedCount」这三项**插件自己拥有**的事实：
     * 专家的具体结果由 DSH 的结算通知各自提供，插件消息不复制、不改写任何专家收尾文本，
     * 也刻意不与 Host 自动完成通知的固定前缀同形（避免被当作 child settlement）。
     */
    function rootFinalizationConclusionText(admissionEpoch, acceptedCount) {
      return "Expert group finalization: the expert batch you finalized is finalized"
        + " (admissionEpoch " + admissionEpoch
        + ", acceptedCount " + acceptedCount + ")."
        + " Every expert task accepted in that batch has actually finished;"
        + " each expert's own closing output arrived separately as a subagent settlement message,"
        + " which this notice deliberately does not repeat."
        + " Do not call dsh_expert_group_finalize again for this batch and do not poll for status;"
        + " continue the task from here.";
    }

    /**
     * 一次性投递某批次的终态收口结论，并关闭该批次。
     *
     * 前置条件（缺一不可，全部在**同一同步临界区**内复查）：
     * 1. 该 exact 批次仍是同一个、仍未关闭、且 pendingClose 仍是本次持有的那个对象
     *    （重复 turn-stopping / 竞态下不会二次投递）；
     * 2. 本次 waiter 的 signal 未被取消（取消不是专家完成）；
     * 3. exact root Agent 仍是当前 live root，且 generation token 仍 live（root 退休、
     *    代际替换或插件卸载期间绝不由旧 root 投递）；
     * 4. runtime 提供 rc.2 的公开 `Agent.steer`。**不**降级为 `inject`：inject 不保证
     *    唤醒后续模型 step，静默降级会让模型永远收不到收口结论；此处保留 pending-close，
     *    留给具备该能力的 runtime 或后续 turn（只记一次告警，不刷日志）。
     *
     * @returns {boolean} 是否完成投递并关闭。
     */
    function deliverRootFinalizationConclusion(parent, pendingClose, signal) {
      const batch = rootAdmissionBatches.get(parent);
      if (batch === void 0 || batch.closed === true || batch.pendingClose !== pendingClose) return false;
      if (signal?.aborted === true) return false;
      if (!isLiveRootAgent(parent)) return false;
      const rootToken = host.lineage.tokenFor(parent);
      if (!host.lineage.isLiveGeneration(parent, rootToken)) return false;
      if (typeof parent?.steer !== "function") {
        if (batch.steerUnavailableLogged !== true) {
          batch.steerUnavailableLogged = true;
          ctx.logger.warn("dsh-expert-group: root Agent.steer is unavailable; the finalization conclusion was not delivered");
        }
        return false;
      }
      // 收口时刻的完整 accepted 集：pending-close 期间新接受的 admission 也在其中，
      // 因此这里必须**现算**，而不是回放 finalize 时的快照值。判定与身份复查处于同一
      // 同步临界区，结论里的数量与真正被释放的 exact work 集一致。
      const acceptedCount = pendingCloseAcceptedCount(parent);
      let message;
      try {
        message = createUserMessage({
          content: [{ type: "text", text: rootFinalizationConclusionText(pendingClose.admissionEpoch, acceptedCount) }],
          source: { kind: PRODUCER_SOURCE_KIND },
        });
      } catch (error) {
        ctx.logger.warn("dsh-expert-group: root finalization message construction failed: "
          + (error instanceof Error ? error.name : "Error"));
        return false;
      }
      try {
        parent.steer(message);
      } catch (error) {
        // 投递失败保持 pending-close：结论还没有进入模型上下文，批次不能算收口完成。
        ctx.logger.warn("dsh-expert-group: root finalization steer failed: "
          + (error instanceof Error ? error.name : "Error"));
        return false;
      }
      batch.closed = true;
      batch.pendingClose = void 0;
      return true;
    }



    ctx.effect(() => tools.register(defineTool({
      name: "dsh_expert_group_finalize",
      description: "Finalize the current root turn only after every role-tool admission result named by admissionTokens has returned, the root agent has completed its summary and integration/review/verification check, and no safe non-overlapping parallel work remains. This root-only action validates that batch against the open admission epoch, registers every accepted expert task on the root turn wait ledger, and returns immediately with a non-terminal waiting receipt carrying admissionEpoch and acceptedCount: it never waits inside the tool call, because the root turn lifecycle keeps waiting at the agent/turn-stopping boundary on that same ledger, with no timeout, as an expert may legitimately run for hours. A waiting receipt means the wait is registered, not that any expert finished; it is not an asynchronous task handle and there is no status to poll. Do not call finalize again for that batch and do not poll for status: once every accepted task has actually finished, the plugin closes the batch and steers one DEG-sourced finalization message into your next step automatically. Do not call it while safe parallel work remains; a pure continue_parent_turn batch has no accepted admission to finalize, while a later ordinary admission may finalize the complete checked token set.",
      parameters: {
        admissionEpoch: {
          type: "number",
          required: true,
          description: "The admissionEpoch returned by the role tools for the batch being checked; use 0 with an empty token list when no role tool was called.",
        },
        admissionTokens: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "Every unique admissionToken returned by the role tools in this open batch, including accepted, advisory, and failure outcomes.",
        },
        summaryCompleted: {
          type: "boolean",
          required: true,
          description: "Set true only after stating the accepted tasks and planned integration, review, and verification work in the root response.",
        },
        outcomesChecked: {
          type: "boolean",
          required: true,
          description: "Set true only after checking every listed role outcome, including rejected, advisory, and failure results.",
        },
        safeParallelWork: {
          type: "boolean",
          required: true,
          description: "Set true when any safe, non-overlapping, non-duplicate parallel work remains; finalize rejects that value.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            // waiting 是登记完成但非终态；收口结论只通过后续 root 上下文消息表达。
            kind: { type: "string", required: true, enum: ["waiting", "noop", "rejected"] },
            admissionEpoch: { type: "number", required: true },
            acceptedCount: { type: "number", required: true },
            reason: { type: "string", required: true },
            message: { type: "string" },
          },
        },
        render(_args, value) {
          // render 必须带上 message，否则 rejected 的 self-diagnosis 文案在模型可见的
          // 工具输出里被丢弃（reason 是机器码，message 才是可执行提示）。
          const base = "root finalization: " + value.reason + (value.message ? " — " + value.message : "");
          // waiting 是非终态回执：模型必须看到「等待已登记、不要重试、不要轮询」，
          // 否则会把 waiting 误当成最终结论，或者反复调用 finalize。
          if (value.kind === "waiting") {
            return [{ type: "text", text: base
              + " — waiting registered for " + value.acceptedCount + " accepted expert task(s) in admissionEpoch "
              + value.admissionEpoch
              + "; do not call finalize again and do not poll for status" }];
          }
          return [{ type: "text", text: base }];
        },
      },
      isConcurrencySafe: () => false,
      execute(args, exec) {
        const parent = exec?.agent;
        if (!isLiveRootAgent(parent)) throw new Error("dsh_expert_group_finalize is root-only and requires the current live root agent");
        const rootToken = host.lineage.tokenFor(parent);
        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        return finalizeRootAdmissionBatch(parent, exec, args, rootToken);
      },
    })), "dsh-expert-group: root finalization tool");

    ctx.effect(() => tools.register(defineTool({
      name: "dsh_expert_group_release_scope",
      description: "Release the DEG plugin's stale active scope for one exact child. This root-only recovery action clears only the plugin's file-range guard; it does not stop, resume, notify, or conclude the child or the current root turn. Use it only after terminal child feedback has arrived and the child is ready, when normal turn/message correlation did not release the scope.",
      parameters: {
        childId: {
          type: "string",
          required: true,
          description: "The exact durable child session id from the terminal feedback or agent list.",
        },
        role: {
          type: "string",
          description: "Optional exact role filter; use it when the same child id has historical route records.",
        },
        reason: {
          type: "string",
          required: true,
          description: "Short explanation confirming terminal feedback was received and this is stale-scope recovery.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", required: true, const: "scope-released" },
            childId: { type: "string", required: true },
            releasedCount: { type: "number", required: true },
            reason: { type: "string", required: true },
          },
        },
        render(_args, value) {
          return [{ type: "text", text: "DEG scope released for " + value.childId + ": " + value.releasedCount }];
        },
      },
      isConcurrencySafe: () => false,
      execute(args, exec) {
        const parent = exec?.agent;
        if (!isLiveRootAgent(parent)) throw new Error("dsh_expert_group_release_scope is root-only and requires the current live root agent");
        const childId = typeof args?.childId === "string" ? args.childId.trim() : "";
        const role = typeof args?.role === "string" && args.role.trim().length > 0 ? args.role.trim() : void 0;
        const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
        if (childId.length === 0) throw new Error("dsh_expert_group_release_scope childId must be non-empty");
        if (reason.length === 0) throw new Error("dsh_expert_group_release_scope reason must be non-empty");
        const releasedCount = releaseActiveExpertScope(parent, { childId, role });
        return { kind: "scope-released", childId, releasedCount, reason };
      },
    })), "dsh-expert-group: stale scope release tool");

    /**
     * 收集「已接受、但还没有被 finalize 收口」的 role admission。
     *
     * 判定必须与 finalizeRootAdmissionBatch 的 acceptedEntries 完全一致（同一个
     * outcome 形状），否则兜底会漏掉或多算：reused/continueParentTurn 不需要工作项，
     * 未 settle 的 admission 还在执行中、不能提前登记。
     *
     * 额外过滤：host.handoff 里已经没有这个 exact admission（典型是 release 成功后的
     * 清理）时不能登记——登记一个永远不会结算的键会让 root 永久等待。
     */
    function pendingRootAutomaticAdmissions(parent) {
      const batch = rootAdmissionBatches.get(parent);
      // finalize 已经在收口（finalizing）或已收口（closed）时一律让路：那是模型必需
      // 路径，等待结论都由它负责，兜底重复介入只会产生竞争。
      if (batch === void 0 || batch.closed === true || batch.finalizing === true) return [];
      // 活视图：包含 pending-close 期间新接受的 admission（同一开放批次的 exact work 集）。
      // 工作键必须与「精确结算」用的键完全一致：结算走 handoff admission 自己的 token
      // （见 settleAdmissionTurnWait / registerRootTurnWaitWork / acceptedBatchWorks）。
      // 用 batch/ticket token 登记会得到一个永远不会被结算的键 —— 模型遗漏 finalize 时
      // 兜底就会永久挂住 turn。
      return acceptedBatchWorks(parent)
        .filter((work) => work.released !== true)
        .map((work) => ({ token: work.token, admission: work.admission }));
    }

    /**
     * root turn 即将关闭时的等待兜底（与 finalize 共用**同一个**等待账本/状态机）。
     *
     * 为什么需要它：`dsh_expert_group_finalize` 仍是模型必需路径（prompt 契约要求模型
     * 调用它登记等待），但模型可能遗漏它；纯 `continue_parent_turn` 批次与 fan-out 也可能
     * 在 turn 结束时仍有子代理在跑。此时若直接关闭 turn，root 会变 idle。
     *
     * 本函数**不**暂停/恢复任何 goal，也不主动结束 turn：它把「本 turn 已接受、但还没被
     * finalize 登记的 admission」补登记进同一张等待表，然后等同一张表的静止判定成立。
     * DSH 的 `agent/turn-stopping` 是 serial 事件且会 await 监听器返回的 Promise，
     * 因此等待期间 turn 保持打开，其他 agent 事件照常推进。
     *
     * 对**未 finalize** 的批次只做「补登记 + 等」：不清理 admission、不写任何终态结论——
     * 那些都属于正常的 feedback/release 路径。
     *
     * ## pending-close 批次的接续（两阶段收口的后半段）
     * finalize 已经登记并返回 waiting 的批次由本函数完成收口：
     * - **重新登记**：等待账本的记录可能已在一次静止收口后销毁（此时 `isEngaged()` 为
     *   false、登记集为空），因此这里按 pending-close 保存的 exact admission **以及开放
     *   批次当前的已接受工作活视图**重新登记尚未结算的 work 并 engage，保证「child 先静止、
     *   turn-stopping 后到」以及「pending-close 期间又接受了新 admission」都能被本次等待
     *   完整覆盖；等待在飞期间新接受的 admission 由接受时刻的登记负责（同一个账本）；
     * - **本 turn 的 signal**：等待使用 `payload.signal`（root turn 生命周期），而不是
     *   run_code 子执行的 exec.signal；
     * - **取消不是完成**：等待被取消（用户插话 / abort / root 退休 / 卸载）时批次保持
     *   pending-close，不关闭、不投递，留给后续 root turn 重建等待；
     * - **一次性投递**：等待明确 released 且 signal 未取消、exact root/generation 仍 live
     *   时，才投递一次终态结论并关闭批次。
     *
     * @param {object} parent - exact live root Agent。
     * @param {AbortSignal} [signal] - 本次 root turn 的 signal。
     * @returns {Promise<void>} 静止、收口完成或等待被取消后返回。
     */
    async function awaitRootTurnWaitFallback(parent, signal) {
      // 同步取一次 pending-close 快照：等待期间批次可能被其它边界关闭或代际退休，
      // 投递前的身份复查（deliverRootFinalizationConclusion）据此拒绝过期投递。
      const pendingClose = pendingCloseBatchFor(parent);
      for (const candidate of pendingRootAutomaticAdmissions(parent)) {
        // candidate 来自当前开放 batch 且仍在 handoff；只有真实 token 成功进入等待账本后，
        // 才标记其真实 cohort entry 的 pauseDone，绝不为缺失 admission 伪造完成。
        const tracked = rootTurnWaits.track(parent, { kind: "admission", token: candidate.token });
        if (tracked !== void 0) handoffAdmissionCohort.markPauseDone(candidate.admission);
      }
      if (pendingClose !== void 0) reengagePendingCloseWorks(parent, pendingClose);
      // 即使没有补登记的工作项，只要该 root 曾经 engage 过等待体系（例如纯
      // continue_parent_turn 留下的正在运行的 child），也必须让同一状态机判定一次。
      if (!rootTurnWaits.isEngaged(parent)) return;
      const outcome = await rootTurnWaits.wait(parent, signal);
      if (outcome.released !== true) {
        // 取消（用户插话 / abort / root 退休 / 插件卸载）不是专家完成：pending-close 批次
        // 保持开放，既不关闭也不投递，后续 root turn 可以重建等待继续收口。
        ctx.logger.warn("dsh-expert-group: root turn wait fallback was cancelled (" + outcome.reason + ")");
        return;
      }
      if (pendingClose === void 0) return;
      deliverRootFinalizationConclusion(parent, pendingClose, signal);
    }

    /**
     * DSH 的 agent/turn-stopping 是 serial 事件：监听器可以返回 Promise，loop 会 await
     * 后再关闭 turn，因此这里可以安全地保持 turn 打开直到专家真正结束。监听器自身绝不
     * 抛错——DSH 会把 turn-stopping 的异常变成 turn 错误，兜底必须 fail-open。
     */
    ctx.on("agent/turn-stopping", (payload) => {
      const parent = payload?.agent;
      if (turnWaitStopping || !isRootAgentIdentity(parent) || !isLiveRootAgent(parent)) return;
      // 同步前置判定：既没有进入等待体系、也没有可补登记的 admission、也没有待收口的
      // pending-close 批次时直接放行——绝不为了「形式上返回 Promise」而在每个 turn 边界
      // 插入一次多余的异步查询。pending-close 必须参与：它的等待账本记录可能已被销毁
      // （isEngaged() 为 false），只看账本现状会漏掉整条收口链路。
      if (pendingCloseBatchFor(parent) === void 0
        && !rootTurnWaits.isEngaged(parent)
        && pendingRootAutomaticAdmissions(parent).length === 0) return;
      return awaitRootTurnWaitFallback(parent, payload?.signal).catch((error) => {
        ctx.logger.warn("dsh-expert-group: root turn wait fallback failed: " + (error instanceof Error ? error.message : String(error)));
      });
    });


    /**
     * root 专属结构化文件工具 guard 的 owner cleanup。必须挂在每个 root Agent
     * 自身的 ctx 上，不能调用全局 ctx.tools.guard，否则会把 child 也挡住；guard
     * 快照实时读取 tracker，活动专家结束后自然放行后续 root 文件操作。
     */
    const rootStructuredGuardDisposers = new Map();
    // 每个 child 的 guard 绑定到其 scoped tools；Map 还负责插件卸载时的显式清理。
    const expertReportGuardDisposers = new Map();
    let rootStructuredGuardStopping = false;
    function isRootAgentForStructuredGuard(agent) {
      return typeof ctx.agents?.roots === "function" && ctx.agents.roots().includes(agent);
    }
    /**
     * 返回 root 结构化工具 guard 可用的 workspace root。
     * 当前插件生命周期没有安全的 cwd 注入；禁止读取 ctx.cwd 或
     * agent.session.header.cwd 这类懒注入 getter，否则会中断 SessionRuntime.create。
     * 缺少 root 时，guard 仍会校验绝对路径和 workspace-wide 范围，
     * 但不对相对影响范围做隐式 rebasing。
     */
    function workspaceRootForStructuredGuard() {
      return void 0;
    }
    function installRootStructuredPathGuard(agent) {
      if (rootStructuredGuardStopping || !isRootAgentForStructuredGuard(agent) || rootStructuredGuardDisposers.has(agent)) return;
      disposedRootAgents.delete(agent);
      if (typeof agent?.ctx?.effect !== "function" || typeof agent?.ctx?.tools?.guard !== "function") return;
      const workspaceRoot = workspaceRootForStructuredGuard(agent);
      let ownerCleanup;
      ownerCleanup = agent.ctx.effect(() => {
        const disposeGuard = agent.ctx.tools.guard((execution) => {
          const handoffRejection = rootUserWaitGuard(agent, execution);
           if (handoffRejection !== void 0) return handoffRejection;
          return rootStructuredPathGuard(execution, delegationTracker.listActiveTasks(agent.id), agent.id, workspaceRoot);
        });
        return () => {
          try { disposeGuard?.(); } finally {
            if (rootStructuredGuardDisposers.get(agent) === ownerCleanup) rootStructuredGuardDisposers.delete(agent);
          }
        };
      }, "dsh-expert-group: root structured path guard");
      rootStructuredGuardDisposers.set(agent, ownerCleanup);
    }
    function installExpertReportGuardForAgent(agent, resolvedIdentity) {
      if (isRootAgentForStructuredGuard(agent)
        || expertReportGuardDisposers.has(agent)
        || typeof agent?.ctx?.tools?.guard !== "function") return;
      // 先在安装函数外确认身份，避免 installExpertReportGuard 返回的 no-op 被当成
      // 已安装并永久记录；身份监听器稍后可用已解析 role/parentId 重试。
      const identity = resolvedIdentity ?? resolveExpertReportIdentity(
        agent?.options,
        agent?.id,
        (childId) => source().childModels?.[childId],
      );
      if (!isPluginExpertChildIdentity(identity)) return;
      const dispose = installExpertReportGuard(agent.ctx, (childId) => source().childModels?.[childId], identity, agent);
      if (typeof dispose === "function") expertReportGuardDisposers.set(agent, dispose);
    }
    // 既有 root 在插件加载早于/晚于 agent 创建两种时序都要覆盖；agent.ctx.effect
    // 负责随 root 生命周期释放 guard，插件 effect 负责卸载时撤销创建监听与残余 owner。
    ctx.effect(() => {
      const stopCreated = ctx.on("agent/created", ({ agent }) => {
        installRootStructuredPathGuard(agent);
        installExpertReportGuardForAgent(agent);
      });
      for (const agent of typeof ctx.agents?.roots === "function" ? ctx.agents.roots() : []) {
        installRootStructuredPathGuard(agent);
      }
      return () => {
        rootStructuredGuardStopping = true;
        stopCreated?.();
        for (const cleanup of rootStructuredGuardDisposers.values()) {
          try { cleanup?.(); } catch (error) {
            ctx.logger.warn("dsh-expert-group: root structured guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
          }
        }
        rootStructuredGuardDisposers.clear();
        for (const cleanup of expertReportGuardDisposers.values()) {
          try { cleanup?.(); } catch (error) {
            ctx.logger.warn("dsh-expert-group: expert report guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
          }
        }
        expertReportGuardDisposers.clear();
      };
    }, "dsh-expert-group: root structured guard lifecycle");

    // ── 自动恢复（自愈监督）登记表 ──────────────────────────────────────────
    /** childId -> 恢复记录：连续恢复计数 + 恢复 op 表 + 任务绑定。
     *  记录是 durable 的：continuable child 每次 idle 后 Activation 释放
      *  （agent/disposed）**不**删除记录；只在父代理真销毁、插件卸载或惰性替换清理时
      *  删除（防泄漏）。 */
    const recoveryRecords = new Map();
    /**
     * 普通专家自动恢复的上下文存储、重建意图队列、失败文案与预算判定由
     * host/recovery 持有；recovery record 本身仍由组合根按事件路径读写。
     */
    const recovery = createRecoveryModule({ limit: AUTO_RECOVERY_LIMIT, taskBindingLimit: TASK_BINDING_LIMIT });
    // recovery 自己持有重建上下文，但恢复 op 的 timer/controller 仍由入口调度层创建；
    // 通过统一 hook 在插件卸载时先取消这些外部资源，再让迟到 promise 观察到 disposed。
    recovery.addDisposeHook(() => {
      for (const record of recoveryRecords.values()) {
        for (const op of record.pendingRecoveries?.values?.() ?? []) {
          clearRecoveryOpTimer(op);
          try { op.controller?.abort?.(); } catch { /* 取消是幂等的，忽略迟到 controller 异常。 */ }
        }
        record.pendingRecoveries?.clear?.();
      }
      recoveryRecords.clear();
    });
    ctx.effect(() => () => recovery.dispose(), "dsh-expert-group: recovery lifecycle");
    /**
     * childId -> 当前 Activation 的身份与生命周期。DSH 没有公开的 closing 状态，
     * 因此只把 agent/created 标记为 live；收到匹配对象的 agent/disposed 后删除
     * 状态表项。helper 对未知/已释放状态保守交给公开 sendMessage，由 manager
     * 重新处理 admission，避免把 agents.get() 返回的 teardown 中 Agent 当作仍可直接投递目标。
     */
    const childActivationStates = new Map();
    /**
     * Agent 对象 -> 当前 Session/turn/step 的模型请求重试状态。这里使用 WeakMap，
     * 让被替换或销毁的 Agent 不会被迟到 request-error 事件复活；每个状态只存
     * 运行时去重信息，不写入专家任务的 durable recovery record。
     */
    const requestRetryStates = new WeakMap();

    function requestRetryStateFor(agent, session, turn, step) {
      if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) return void 0;
      let state = requestRetryStates.get(agent);
      if (state === void 0) {
        state = createRequestRetryState(session);
        requestRetryStates.set(agent, state);
      }
      const sessionChanged = state.session !== session;
      const turnChanged = state.turn !== void 0 && state.turn !== turn;
      const stepChanged = state.step !== void 0 && state.step !== step;
      if (sessionChanged || turnChanged || stepChanged) {
        resetRequestRetryState(state, session, turn, step);
      } else {
        state.session = session;
        if (state.turn === void 0) state.turn = turn;
        if (state.step === void 0) state.step = step;
      }
      return state;
    }

    function invalidateRequestRetryState(agent) {
      const state = requestRetryStates.get(agent);
      if (state?.waitController instanceof AbortController) state.waitController.abort();
      requestRetryStates.delete(agent);
    }

    function requestRetryStateIsCurrent(agent, session, turn, step, state, generation) {
      return requestRetryStates.get(agent) === state
        && state.session === session
        && state.turn === turn
        && state.step === step
        && state.generation === generation
        && requestRetryTarget(agent) !== void 0;
    }

    function requestRetryTarget(agent) {
      if (isLiveRootAgent(agent)) return { agent, record: void 0 };
      if (typeof agent?.id !== "string") return void 0;
      const record = recoveryRecords.get(agent.id);
      const activation = childActivationStates.get(agent.id);
      const isPluginChildRecord = record !== null
        && typeof record === "object"
        && typeof record.role === "string"
        && EXPERT_ROLES.has(record.role)
        && typeof record.parentId === "string"
        && record.parentId.length > 0
        && (agent?.options?.[CONTINUABLE_MARKER] === true || record.continuable === true);
      if (!isPluginChildRecord
        || record.agent !== agent
        || activation?.agent !== agent
        || activation.status !== "live"
        || !isLiveRootAgent(record.parentAgent)) return void 0;
      if (record.session !== void 0 && agent.session !== void 0 && record.session !== agent.session) return void 0;
      return { agent, record };
    }

    function hostRetryCountFor(session, turn, step) {
      const events = Array.isArray(session?.events) ? session.events : [];
      let count = 0;
      for (const event of events) {
        if (event?.type !== "llm/retry"
          || event.data?.turn !== turn
          || event.data?.step !== step) continue;
        const retry = event.data?.retry;
        if (Number.isSafeInteger(retry) && retry > count) count = retry;
      }
      return count;
    }

    function requestRetryStateIsExhausted(agent, session, turn) {
      const state = requestRetryStates.get(agent);
      return state?.session === session && state.turn === turn && state.exhausted === true;
    }

    function clearRequestRetryStateForSessionEvent(session, event) {
      if (typeof session?.id !== "string") return;
      const liveAgent = agents.get(session.id);
      const record = recoveryRecords.get(session.id);
      const agent = liveAgent?.session === session ? liveAgent
        : record?.session === session ? record.agent : void 0;
      if (agent === void 0) return;
      const state = requestRetryStates.get(agent);
      if (state?.session !== session) return;
      const type = event?.type;
      if (type === "turn/start" || type === "step/start") {
        resetRequestRetryState(state, session, event.data?.turn, event.data?.step);
      } else if (type === "turn/end" || (type === "step/end" && state.exhausted !== true)) {
        requestRetryStates.delete(agent);
      }
    }

    /**
     * root admission 的显式 epoch。role tool 只负责登记并返回 token；finalize
     * 收到完整 token 集合后关闭当前 epoch，后续 admission 会创建新 epoch，
     * 不会把迟到调用或下一轮调用并入已经收口的批次。
     */
    const rootAdmissionBatches = new WeakMap();
    let rootAdmissionEpoch = 0;
    function createRootAdmissionBatch() {
      return {
        epoch: ++rootAdmissionEpoch,
        coordinator: createAdmissionBatchCoordinator(),
        entries: new Map(),
        sequence: 0,
        closed: false,
        finalizing: false,
        /**
         * 两阶段收口的 pending-close 登记（见 finalizeRootAdmissionBatch）。
         *
         * finalize 在登记完成后把本批次标为 pending-close：工具立即返回 waiting，等待
         * 职责移交给 root turn 的 `agent/turn-stopping` serial 边界。这里保存的是
         * **exact admission 对象**（而不是 token 或 id），因为等待账本的记录会在一次静止
         * 收口后被销毁，后续 turn 只能靠这份精确凭据重新登记尚未结算的 work；用 id/token
         * 猜身份会重新登记一个永远不会结算的键。
         *
         * `admissions` 是**批次级**闩锁的一部分，而不是冻结的快照：批次在收口前始终开放，
         * pending-close 期间新接受的 admission 会在接受时刻被追加进来（并同步登记进等待
         * 账本），因此「重新等待」与「收口结论的 acceptedCount」看到的都是该批次收口
         * 时刻的完整 accepted 集。
         */
        pendingClose: void 0,
        /** steer 不可用的告警只记一次（不影响批次状态）。 */
        steerUnavailableLogged: false,
      };
    }
    function beginRootAdmission(parent) {
      if (parent === null || (typeof parent !== "object" && typeof parent !== "function")) return void 0;
      let batch = rootAdmissionBatches.get(parent);
      if (batch === void 0 || batch.closed === true) {
        batch = createRootAdmissionBatch();
        rootAdmissionBatches.set(parent, batch);
      }
      const ticket = batch.coordinator.begin();
      const token = batch.epoch + ":" + (++batch.sequence);
      const entry = { token, epoch: batch.epoch, settled: false, outcome: void 0, ticket };
      batch.entries.set(token, entry);
      return {
        ...ticket,
        token,
        epoch: batch.epoch,
        entry,
        // outcome 记录点需要 exact root 才能把「pending-close 期间新接受的 work」写进
        // 同一批次的等待集（见 recordRootAdmissionOutcome / notePendingCloseAdmission）。
        parent,
        settle() {
          const settled = ticket.settle();
          if (settled) entry.settled = true;
          return settled;
        },
        whenReady: () => ticket.whenReady(),
      };
    }
    function recordRootAdmissionOutcome(admission, outcome) {
      if (admission?.entry === void 0) return;
      admission.entry.outcome = outcome;
      admission.entry.settled = true;
      // pending-close 批次仍开放时，新接受的 exact work 必须在**接受时刻**就进入
      // pending-close 的 work 集与等待账本（见 notePendingCloseAdmission）：否则批次级
      // 闩锁与「该批次的 exact 工作集」会脱节，收口等待可能少等这一项、结论里的
      // acceptedCount 也会停在旧值。判定与 finalize 的 acceptedEntries 完全一致：
      // reused / continueParentTurn 不产生未结算工作。
      if (outcome?.kind === "continuable" && outcome.reused !== true && outcome.continueParentTurn !== true
        && outcome.handoffAdmission !== void 0) {
        notePendingCloseAdmission(admission.parent, outcome.handoffAdmission);
      }
    }
    function roleAdmissionFailure(phase, error) {
      const message = error instanceof Error ? error.message : String(error);
      if (phase === "provider") return { reason: "provider", code: "PROVIDER_UNAVAILABLE", message };
      if (phase === "selection") return { reason: "selection", code: "MODEL_SELECTION_INVALID", message };
      // 容量耗尽：结构化 code 优先于文案启发式（它已由 DEG 翻译成可读提示，不再匹配
      // steer/messageId 等英文关键词），归入可重试的 steer 失败并保留可读文案。
      if (isSubagentCapacityError(error)) {
        return { reason: "capacity", code: "SUBAGENT_CAPACITY_REACHED", message };
      }
      if (/startContinuable|child admission returned an invalid childId/i.test(message)) {
        return { reason: "start", code: "START_FAILED", message };
      }
      if (/steer|followup|messageId/i.test(message)) return { reason: "steer", code: "STEER_FAILED", message };
      return { reason: "admission", code: "ADMISSION_FAILED", message };
    }


    /** 自动恢复 op 的单调递增 id（B4：每个触发恢复的 turn 一个独立 op）。 */
    let recoveryOpSeq = 0;

    /** P3：startContinuable 新建路径的 binding acceptance 竞态预登记 FIFO 队列。
     *  元素 { taskKey, parentId, role }——在 delegateBackground 调用
     *  startContinuable **之前**推入；agent/created（同步触发且早于 promise
     *  resolve）按 parentId+role 取第一个匹配项并立即写入 pendingMessage 绑定，
     *  消除「inbox 已认领消息但 record.tasks 尚无绑定」的竞态。父+角色串行
     *  （delegationTracker.serialize）保证同 scope 最多一个待创建项；不同角色
     *  互不干扰。startContinuable 返回/抛错后若仍未消费则清理残留。 */
    const pendingCreations = [];
    /**
     * 新建 child 的 acceptance 事务。agent/created 可能在 startContinuable 返回前
     * 同步消费 pendingCreation，因此 catch 不能只看 pendingCreation 队列；事务记录
     * exact Agent、record、taskKey、activity 和 handoff admission 的所有权。
     */
    function rollbackCreationTransaction(transaction, message) {
      if (transaction === void 0) return;
      const { parent, handoffAdmission } = transaction;
      if (handoffAdmission !== void 0) {
        failPendingHandoffAdmission(parent, handoffAdmission, transaction.record);
        settlePendingChildTurnEnds(parent, false, handoffAdmission);
        removePendingHandoffAdmission(handoffAdmission);
      }
      rollbackCreatedChildAcceptance({
        recoveryRecords,
        transaction,
        releaseActivity: (activityIdToRelease) => delegationTracker.releaseActiveTask(activityIdToRelease),
        dropRecord: (childId, reason, record) => dropRecoveryRecord(childId, reason, record),
        message,
      });
    }
    /** recovery child 重建的短暂预登记：让同步 agent/created 复用原 recovery record，
     * 保留 pending op、任务绑定和连续恢复计数，不建立第二条恢复链。 */

    // ── settings 接线（DSH 0.1.7-alpha.2 契约）────────────────────────────
    // 用户可改字段已声明为插件 Config 上的 volatile 字段，由宿主 settings 服务投影成
    // 可编辑表单。这里只做三件事：关闭宿主自动配置页、从 describe() 读取本条目当前值、
    // 在 document-updated 时刷新读源。旧契约的 settings.register / scope.get / scope.watch
    // 已从宿主删除，因此不再出现在任何调用路径上。
    let settingsSource = () => ({
      provider: "",
      defaults: {},
      promptOverrides: {},
      notificationEnabled: true,
      notificationVolume: 100,
      notificationHoldMs: DEFAULT_NOTIFICATION_HOLD_MS,
      roleConcurrencyLimit: DEFAULT_ROLE_CONCURRENCY_LIMIT,
      observerPreferred: false,
      taskManagementEnabled: true,
    });
    // binding 生成器由 host/storage-binding 持有；storageBinding.* 调用为兼容投影。
    // ready 前和服务重载期间保留最后一次成功读取的快照，避免空快照覆盖已加载数据。
    // domain 快照缓存由 host/storage-binding 持有（storageBinding.snapshots()）。
    // fan-out 任务快照单独存放在 domain.fanout_tasks/current；这些索引只保存任务
    // 与根 Agent 的寻址关系，不复制 task/result 数据，完整状态仍由 manager 持有。
    // fan-out 快照缓存由 host/storage-binding 持有（storageBinding.fanoutSnapshot()）。
    // fan-out 父任务 ownership 索引由 host/lineage 持有。
    let fanoutHost;
    /**
     * root replacement/dispose 后移除旧 Agent 的 fan-out 所有权索引。task/result
     * 历史仍由 manager 保留；只有 ownership 被摘除，避免同 id 新 root 复用旧任务。
     */
    function tableEntries(table) {
      if (table === void 0) return void 0;
      try { return [...table.entries()]; } catch { return void 0; }
    }

    /** source() 只读最后一次成功读取的 domain；没有 ready domain 时不覆盖既有快照。 */
    function readStorageSnapshot() {
      const settingsSnapshot = normalizeSnapshot(settingsSource(), activeRoles());
      const binding = host.storage.active();
      if (binding !== void 0) {
        const sessionEntries = tableEntries(binding.sessionTable);
        const childEntries = tableEntries(binding.childTable);
        const fanoutEntries = tableEntries(binding.fanoutTable);
        if (sessionEntries !== void 0 && childEntries !== void 0 && fanoutEntries !== void 0) {
          storageBinding.setDomainSnapshot(readDomainSnapshot(sessionEntries, childEntries));
          storageBinding.setFanoutSnapshot(fanoutEntries.find(([key]) => key === "current")?.[1]);
        } else {
          host.storage.invalidate(binding);
        }
      }
      return {
        provider: settingsSnapshot.provider,
        defaults: settingsSnapshot.defaults,
        // 自定义专家提示词属于全局 settings，必须随同一份快照进入 source()：
        // restore/重载期间缺失它会让运行时静默回落到默认 persona。
        promptOverrides: settingsSnapshot.promptOverrides,
        notificationEnabled: settingsSnapshot.notificationEnabled,
        notificationVolume: settingsSnapshot.notificationVolume,
        notificationHoldMs: settingsSnapshot.notificationHoldMs,
        roleConcurrencyLimit: settingsSnapshot.roleConcurrencyLimit,
        observerPreferred: settingsSnapshot.observerPreferred,
        taskManagementEnabled: settingsSnapshot.taskManagementEnabled,
        ...storageBinding.snapshots(),
      };
    }
    let source = readStorageSnapshot;
    // 冷根会话没有 live Agent；可选 sessionQuery 让 Expert Group 精确读取该会话日志。
    // 绑定跟随提供服务的 fiber 释放，getter 让后创建的 runtime 始终看到当前 generation。
    let expertGroupSessionQuery;
    ctx.inject(["sessionQuery"], (queryCtx) => {
      let service;
      try { service = queryCtx?.sessionQuery; } catch { return; }
      if (service === void 0 || service === null) return;
      expertGroupSessionQuery = service;
      const bindEffect = typeof queryCtx?.effect === "function" ? queryCtx.effect.bind(queryCtx) : ctx.effect.bind(ctx);
      bindEffect(() => () => {
        if (expertGroupSessionQuery === service) expertGroupSessionQuery = void 0;
      }, "dsh-expert-group: session query binding");
    });
    // 附件服务是可选组合能力：没有挂载时不影响文本专家加载，但无扩展名图片
    // 必须在真正投递前明确失败，不能把原始 ref 伪装成 PNG。
    let attachmentStore;
    // 客户端图片提交的 32MiB JSON 上限由 host/rpc-transport 的传输预算统一持有
    // （bodyLimits.image），dispatch 通过 host.rpc.limitFor 读取，不再复制第二个数字：
    // 上限要覆盖 base64 膨胀，同时仍由附件服务的图片限制兜底。
    const IMAGE_RPC_MAX_COUNT = 16;
    ctx.inject(["attachments"], (attachmentCtx) => {
      // 严格/旧 Host 可能以可选注入回调传入没有该服务的 context；
      // 读取失败只代表能力缺失，不能让文本专家和设置页加载失败。
      let store;
      try { store = attachmentCtx?.attachments; } catch { return; }
      if (store === void 0 || store === null) return;
      attachmentStore = store;
      attachmentCtx.effect(() => () => {
        if (attachmentStore === store) attachmentStore = void 0;
      }, "dsh-expert-group: attachment service binding");
    });
    let writeChain = Promise.resolve();
    // settings 提交与 domain 写入各自串行；settings 不等待可能永久 pending 的 domain gate。
    // ctx.inject 可能在插件 setup 之后才回调；首次回调前写入必须保持 pending。
    const storageInitializationGate = createInitializationGate();
    // 没有任何写入者时也消费拒绝结果，避免未提供服务时产生未处理 rejection；写入者仍收到原错误。
    storageInitializationGate.promise.catch(() => {});
    ctx.effect(() => () => {
      storageInitializationGate.reject(new Error("storage domain service was never provided"));
    }, "dsh-expert-group: storage initialization gate");
    let domainInitialization = storageInitializationGate.promise;

    /**
     * settings 读源接线（新契约）。
     *
     * `host.settings`（host/settings-source）负责：
     * - `configure({ auto: false }, ctx.fiber)`：关闭宿主自动生成配置页（DEG 有自己的
     *   设置页）；owner 必须是插件自己的 fiber。
     * - 当前值从 `describe()` 读取（找 ns === SETTINGS_NAMESPACE 的条目）。describe()
     *   的 value 是 defaults resolved 后的结果，因此 provider 空串、promptOverrides
     *   空对象等“未配置”语义都能直接由归一逻辑处理。
     * - 条目读不到（宿主未投影本条目 / 条目被重命名）时回落到插件默认 entry，不崩溃。
     * - 运行期变更观察（票据 02）：`loader/volatile-update` 为主观察点、
     *   `app-boot/config-reload` 为兜底，`settings/document-updated(ns, revision)` 保留；
     *   三者收敛到同一入口，先重读 describe() 再按 revision 幂等通知，因此保存后
     *   读取面立即跟随且不会产生刷新风暴。观察点注册在插件顶层 ctx（volatile 事件
     *   带 fiber 过滤，注入子 ctx 的独立 fiber 收不到）。
     *
     * 宿主新契约没有 validate 钩子：语义校验全部在 DEG 自有提交端点的
     * commitSettingsCandidate 内完成（见下方）。
     */
    installSettingsSection(host.settings, ctx, SETTINGS_NAMESPACE, Config, {
      provider: "",
      defaults: {},
      promptOverrides: {},
      notificationEnabled: true,
      notificationVolume: 100,
      notificationHoldMs: DEFAULT_NOTIFICATION_HOLD_MS,
      roleConcurrencyLimit: DEFAULT_ROLE_CONCURRENCY_LIMIT,
      observerPreferred: false,
      taskManagementEnabled: true,
    }, {
      setSource(next) {
        settingsSource = () => normalizeSnapshot(next(), activeRoles());
        source = readStorageSnapshot;
      },
      onChange() {},
    });

    /**
     * 只读提示词自定义投影。
     *
     * 对六个注册角色（含当前未启用的 observer）返回：角色 id、代码维护的默认专家专属
     * persona、已保存的自定义覆盖（没有时字段缺失）与是否已自定义。设置页据此渲染
     * 角色按钮、编辑器初值和"已自定义"标识；运行时 persona 仍由 resolvePersonaForAdmission
     * 现算，投影只描述配置，不是运行期人格缓存。
     *
     * 投影里刻意不含固定执行纪律文本：那段纪律由代码追加，不是用户可编辑内容。
     *
     * @param {object} snapshot - 已归一的 settings 快照。
     * @returns {{roles: string[], maxGraphemes: number, customizable: boolean,
     *   entries: Array<{role: string, defaultPersona: string, override: (string|undefined), customized: boolean}>}}
     */
    function describeRolePrompts(snapshot) {
      const roles = listRoles();
      const overrides = snapshot?.[PROMPT_OVERRIDES_SETTINGS_KEY];
      const entries = roles.map((entry) => {
        const override = promptOverrideFor(overrides, entry.id);
        return {
          role: entry.id,
          defaultPersona: DEFAULT_EXPERT_PERSONA[entry.id],
          ...(override === void 0 ? {} : { override }),
          customized: override !== void 0,
        };
      });
      return {
        roles: roles.map((entry) => entry.id),
        maxGraphemes: PROMPT_OVERRIDE_MAX_GRAPHEMES,
        // 固定执行纪律始终由代码追加，用户只能覆盖专家专属部分。
        customizable: true,
        entries,
      };
    }

    /**
     * 解析一次专家 child 应使用的完整 persona（专家专属部分 + 固定执行纪律）。
     *
     * 必须在 **admission 边界**调用，而不是在模块加载期或工具注册期缓存结果：
     * settings 覆盖由设置页在运行期修改，缓存任何快照都会让保存后的第一次新建
     * child 继续使用旧 persona。读取走 settingsSource()——已归一化的当前权威快照，
     * 因此读取路径与设置页显示的是同一份配置。
     *
     * 只影响之后新建的 child：已存在的 running/idle/ready child 的 persona 由
     * DSH subagent 持久化在 continuation descriptor 上，保存设置不会改写它，
     * 也不会触发 steer/interrupt/销毁。
     *
     * @param {string} role - 专家角色 id。
     * @returns {string} 最终 persona（固定纪律恰好追加一次）。
     */
    function resolvePersonaForAdmission(role) {
      return resolveExpertPersona(role, promptOverrideFor(settingsSource()?.[PROMPT_OVERRIDES_SETTINGS_KEY], role));
    }

    /**
     * storageDomain 是插件运行所需能力。每次回调建立独立 generation；失效先脱离旧
     * handle，再等待 open/close，迟到 Promise 不能安装或修改替代 binding。
     */
    ctx.inject(["storageDomain"], (domainCtx) => {
      let storageDomain;
      try { storageDomain = domainCtx?.storageDomain; } catch (error) {
        storageInitializationGate.reject(new Error("storage domain injection failed", { cause: error }));
        return;
      }
      if (storageDomain === void 0 || storageDomain === null || typeof storageDomain.open !== "function") {
        storageInitializationGate.reject(new Error("storage domain service is unavailable"));
        return;
      }
      const binding = storageBinding.begin();
      let cancelInitialization;
      let closed = false;
      let closePromise;
      binding.cancelInitialization = () => cancelInitialization?.();
      const cancelled = new Promise((_, reject) => {
        cancelInitialization = () => reject(new Error("storage domain binding was invalidated before ready"));
      });
      binding.onInvalidate = () => {
        // 快照缓存由 host/storage-binding 在 invalidate/begin 时清空。
        cancelInitialization?.();
      };
      const opened = Promise.resolve().then(() => storageDomain.open(EXPERT_STORAGE_DOMAIN_SPEC));
      const closeOpened = async () => {
        if (closePromise !== void 0) return closePromise;
        closePromise = opened.then(async (domain) => {
          if (!closed) {
            closed = true;
            try { await domain.close(); } catch (error) {
              ctx.logger.warn("dsh-expert-group: stale storage domain close failed: " + (error instanceof Error ? error.message : String(error)));
            }
          }
        }).catch(() => {});
        return closePromise;
      };
      const initialize = opened.then(async (domain) => {
        if (!storageBinding.isCurrent(binding)) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        const sessionTable = domain.table("session_overrides");
        const childTable = domain.table("child_models");
        const fanoutTable = domain.table("fanout_tasks");
        const sessionEntries = tableEntries(sessionTable);
        const childEntries = tableEntries(childTable);
        const fanoutEntries = tableEntries(fanoutTable);
        if (sessionEntries === void 0 || childEntries === void 0 || fanoutEntries === void 0) throw new Error("storage domain table read failed");
        if (!storageBinding.isCurrent(binding)) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        const installed = storageBinding.install(binding, { domain, sessionTable, childTable, fanoutTable, sessionAuthoritative: true, childAuthoritative: true, fanoutAuthoritative: true });
        if (!installed) {
          await closeOpened();
          throw new Error("storage domain binding was replaced before ready");
        }
        storageBinding.setDomainSnapshot(readDomainSnapshot(sessionEntries, childEntries));
        storageBinding.setFanoutSnapshot(fanoutEntries.find(([key]) => key === "current")?.[1]);
        // 事件历史与任务快照同代持久化；Host 自有查询缓存也必须先水合，避免冷启动 cursor 从 0 重置。
        fanoutHost.restoreEvents(storageBinding.fanoutSnapshot()?.events);
        host.lineage.restoreParentSessions(storageBinding.fanoutSnapshot());
        fanoutHost.restore();
        // 冷恢复：restore 之后为「已在运行、但本进程还没有登记」的 fan-out 父任务补登记
        // 等待工作。终态任务只标记已释放，绝不登记（它们不会再产生 task_settled）。
        reconcileFanoutGoalHandoffs();
      });
      domainInitialization = Promise.race([initialize, cancelled]).catch(async (error) => {
        if (storageBinding.isCurrent(binding)) {
          ctx.logger.warn("dsh-expert-group: storage domain initialization failed: " + (error instanceof Error ? error.message : String(error)));
          host.storage.invalidate(binding);
        }
        await closeOpened();
        throw error;
      });
      storageInitializationGate.resolve(domainInitialization);
      ctx.effect(() => async () => {
        // 先让读写观察到 pending，再等待已开始的写入 drain/close；不能反过来。
        host.storage.invalidate(binding);
        await writeChain.catch(() => {});
        await closeOpened();
      }, "dsh-expert-group: storage domain lifecycle");
    });

    // RC1 不再暴露 continuable setup 注册 seam。专家 child 的自有工具层
    // guard 在 agent/created 事件中安装，事件发布时 child.ctx 已属于该 Agent，
    // 因而不会把 report/MCP 防线错误挂到全局 root tools。

    /**
     * 记录一次 session/child domain 写入的健康结果。
     *
     * 只更新内存健康状态：不写 storage、不触发回调，因此失败记录不会形成
     * persistence feedback loop。generation 取当前 binding（未 ready 时为 undefined）。
     * 分类由 host/persistence-health 统一负责：同步 throw、异步 reject、generation
     * detached 都是同一批结构化错误，会落到 transient/generation-stale/capacity/permanent。
     */
    function observeStorageWrite(ok, error, source) {
      try {
        persistenceHealth.observeStorageWrite({
          ok: ok === true,
          error,
          generation: host.storage.active()?.generation,
          source,
        });
      } catch { /* 健康记录失败不得影响真实写入结果。 */ }
    }

    /** domain 写入串行，并在执行前等待当前 storage-domain generation ready。 */
    function enqueueWrite(fn) {
      // 首次 ctx.inject 回调前等待 gate；之后再等待当前 generation 的 domain 初始化。
      const run = writeChain
        .then(() => storageInitializationGate.settled ? domainInitialization : storageInitializationGate.promise)
        .then(fn);
      writeChain = run.catch(() => {});
      return run;
    }

    function persistFanoutSnapshot(stored) {
      return enqueueWrite(async () => {
        const binding = host.storage.active();
        if (binding?.fanoutAuthoritative !== true || binding.fanoutTable === void 0) {
          throw new Error("storage domain is not ready for fan-out snapshot write");
        }
        const result = await persistDomainEntry({
          table: binding.fanoutTable,
          key: "current",
          value: stored,
          isCurrent: () => storageBinding.isCurrent(binding),
        });
        if (result.detached === true) {
          const error = new Error("storage domain binding was replaced during fan-out snapshot write");
          error.code = "PERSISTENCE_GENERATION_STALE";
          error.category = "generation-stale";
          throw error;
        }
        storageBinding.setFanoutSnapshot(stored);
        return true;
      }).catch((error) => {
        ctx.logger.warn("dsh-expert-group: fan-out snapshot persistence failed: " + (error instanceof Error ? error.message : String(error)));
        // 日志是旁路；必须继续 reject，让 runtime 的 health seam 记录真实失败类别。
        throw error;
      });
    }

    /** 对 domain 表先 durable put，再按显式 lru 序号裁剪。 */
    async function putChildDomain(binding, childId, record) {
      if (!storageBinding.isCurrent(binding) || binding.childAuthoritative !== true) {
        throw new Error("storage domain binding is not ready for child model write");
      }
      const result = await persistLruEntry({
        table: binding.childTable,
        key: childId,
        value: record,
        limit: CHILD_LRU_LIMIT,
        isCurrent: () => storageBinding.isCurrent(binding),
      });
      if (result.error !== void 0) throw result.error;
      if (result.detached === true) throw new Error("storage domain binding was replaced during child model write");
      return true;
    }

    /** domain 未 ready 时显式失败，不创建 settings/进程内运行数据副本。 */
    function writeChildModel(childId, record) {
      return enqueueWrite(async () => {
        const binding = host.storage.active();
        if (binding?.childAuthoritative !== true) {
          throw new Error("storage domain is not ready for child model write");
        }
        await putChildDomain(binding, childId, record);
      }).then(() => {
        observeStorageWrite(true, void 0, "child_models");
      }, (error) => {
        // 记录后仍然吞掉：child 模型快照是旁路持久化，不能把失败升级成调用方异常。
        observeStorageWrite(false, error, "child_models");
        ctx.logger.warn("dsh-expert-group: child model persistence failed: " + (error instanceof Error ? error.message : String(error)));
      });
    }

    let dispatchAcceptedClock = 0;

    /** 在同一 domain 写临界区内合并 child_models 当前记录，避免迟到写入覆盖模型字段。 */
    function writeChildModelPatch(childId, patch) {
      return enqueueWrite(async () => {
        const binding = host.storage.active();
        if (binding?.childAuthoritative !== true) throw new Error("storage domain is not ready for child model write");
        const current = tableEntries(binding.childTable)?.find(([key]) => key === childId)?.[1] ?? {};
        const incomingAt = patch?.lastDispatch?.acceptedAt;
        const currentAt = current?.lastDispatch?.acceptedAt;
        if (Number.isSafeInteger(incomingAt) && Number.isSafeInteger(currentAt) && currentAt > incomingAt) return;
        await putChildDomain(binding, childId, { ...current, ...patch });
      }).then(() => {
        observeStorageWrite(true, void 0, "child_models");
      }, (error) => {
        observeStorageWrite(false, error, "child_models");
        ctx.logger.warn("dsh-expert-group: child dispatch persistence failed: " + (error instanceof Error ? error.message : String(error)));
      });
    }

    /**
     * 在 admission 已成功后把最新 dispatch 描述旁路写回既有 child_models 记录。
     * 写入读取与合并均在串行临界区内完成，不建立第二套任务表。
     */
    function persistChildDispatch(childId, record, request, label, messageId) {
      if (typeof childId !== "string" || childId.length === 0) return;
      const pickText = (...values) => {
        for (const value of values) if (typeof value === "string" && value.trim().length > 0) return value.trim();
        return null;
      };
      let agent = record?.agent;
      if (agent === void 0) {
        try { agent = agents?.get?.(childId); } catch { agent = void 0; }
      }
      const provider = pickText(agent?.options?.provider);
      const model = pickText(agent?.options?.model);
      if (provider === null || model === null) return;
      const prompt = request?.prompt?.[0]?.text;
      const acceptedAt = Math.max(Date.now(), dispatchAcceptedClock + 1);
      dispatchAcceptedClock = acceptedAt;
      writeChildModelPatch(childId, {
        provider,
        model,
        ...(typeof agent?.options?.[EFFORT_MARKER] === "string" ? { reasoningEffort: agent.options[EFFORT_MARKER] } : {}),
        ...(pickText(record?.role, agent?.options?.[ROLE_MARKER]) !== null ? { role: pickText(record?.role, agent?.options?.[ROLE_MARKER]) } : {}),
        ...(pickText(record?.parentId, agent?.options?.[PARENT_MARKER]) !== null ? { parentId: pickText(record?.parentId, agent?.options?.[PARENT_MARKER]) } : {}),
        continuable: true,
        lastDispatch: {
          description: typeof label === "string" ? label : void 0,
          prompt: typeof prompt === "string" ? prompt : void 0,
          messageId: typeof messageId === "string" ? messageId : void 0,
          acceptedAt,
        },
      });
    }

    /** 读取某会话某角色解析后的模型选择：会话覆盖优先，其次全局默认；均未配置返回 null。 */
    function resolveRole(sessionId, role) {
      const snap = source();
      const selection = snap.sessionOverrides?.[sessionId]?.[role] ?? snap.defaults?.[role];
      if (selection == null) return null;
      return {
        provider: String(selection.provider ?? ""),
        model: String(selection.model ?? ""),
        reasoningEffort: selection.reasoningEffort === void 0 ? void 0 : String(selection.reasoningEffort),
      };
    }

    /**
     * 校验 provider/model 在当前模型目录内，并用 resolveCallConfig 校验/归一 effort。
     * 关键语义：只有调用方**显式**传了 reasoningEffort 时，才把 effort 持久化到返回值；
     * 未显式传时保持 undefined，绝不把 adapter 的默认档固化进 settings（否则会覆盖模型的默认档演进）。
     */
    async function validateSelection(selection) {
      return validateSelectionWithSignal(selection, arguments[1]);
    }

    async function validateSelectionWithSignal(selection, signal) {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)
        || typeof selection.provider !== "string" || selection.provider.length === 0
        || typeof selection.model !== "string" || selection.model.length === 0) {
        throw new ValidationError("模型选择不完整或类型无效：需要字符串 provider 与 model");
      }
      const rawEffort = selection.reasoningEffort;
      if (rawEffort !== void 0 && rawEffort !== null && rawEffort !== "" && typeof rawEffort !== "string") {
        throw new ValidationError("reasoningEffort 必须是字符串，或使用 undefined/null/空字符串表示未指定");
      }
      const explicitEffort = rawEffort === void 0 || rawEffort === null || rawEffort === "" ? void 0 : rawEffort;
      // provider/model catalog 只用于提示；目录缺项、延迟或查询失败不能替代精确解析。
      // RC1 的目录 API 没有 AbortSignal 参数，因此查询完成后必须再次检查请求生命周期。
      // 目录查询是 advisory：失败仍交给后续 exact resolveCallConfig 判定。
      if (signal?.aborted === true) throw createAbortError();
      try { if (typeof llm.listProviders === "function") await llm.listProviders(); } catch {}
      if (signal?.aborted === true) throw createAbortError();
      try { if (typeof llm.listModels === "function") await llm.listModels(selection.provider); } catch {}
      if (signal?.aborted === true) throw createAbortError();
      let resolved;
      try {
        const config = {
          provider: selection.provider,
          model: selection.model,
          ...(explicitEffort === void 0 ? {} : { reasoningEffort: explicitEffort }),
        };
        resolved = signal === void 0
          ? await llm.resolveCallConfig(config)
          : await llm.resolveCallConfig(config, signal);
      } catch (error) {
        // resolveCallConfig 是可取消的 exact 解析；不能把请求取消包装成用户输入错误，
        // 否则 RPC 层无法映射为 499，且底层 adapter 会继续占用已关闭请求的资源。
        if (signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
          throw error?.name === "AbortError" || error?.code === "ABORT_ERR" ? error : createAbortError();
        }
        if (error?.code === "UNSUPPORTED_REASONING_EFFORT") {
          throw new ValidationError(`reasoningEffort "${explicitEffort}" 不受 model "${selection.model}" 支持`);
        }
        throw new ValidationError("当前模型不接受该 reasoningEffort");
      }
      if (!resolved || typeof resolved !== "object" || typeof resolved.provider !== "string" || typeof resolved.model !== "string") {
        throw new ValidationError("模型解析结果无效");
      }
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(explicitEffort === void 0 ? {} : { reasoningEffort: String(explicitEffort) }),
      };
    }

    /**
     * 构造一条提示词覆盖校验错误。
     *
     * 外层仍是既有 ValidationError（RPC 层映射为 400 invalid-selection，客户端错误
     * 分类不变），并显式带上 validation 标记；附加 code 只用于测试与诊断精确区分
     * 「角色键错了」与「文本内容不合法」，绝不携带任何提示词正文。
     *
     * @param {string} message - 用户可读的中文错误。
     * @param {string} code - PROMPT_OVERRIDE_* 稳定 code。
     * @returns {Error} 带 code/validation 标记的 ValidationError。
     */
    function promptOverrideError(message, code) {
      const error = new ValidationError(message);
      error.code = code;
      error.validation = true;
      return error;
    }

    /**
     * settings 写入边界上的专家提示词覆盖校验。
     *
     * 与读取归一（normalizePromptOverrides）共用同一批规则，但语义是"显式拒绝"而不是
     * "静默丢弃"：客户端提交的候选有问题时必须拿到结构化错误，不能让它以为保存成功。
     * 候选必须是普通对象；未知角色键、非字符串值、纯空白文本与超过 grapheme 上限的
     * 文本都抛 ValidationError（RPC 层映射为 400 invalid-selection）。
     *
     * 已接受的非空文本按原样返回：不 trim、不压缩空白、不截断，也不做任何模板替换。
     *
     * 「与默认逐字相同」是唯一的删除规则（恢复默认语义）：Host 拥有 DEFAULT_EXPERT_PERSONA，
     * 因此在写入边界自己判定，而不是要求客户端先做一次可能过期的比较。比较是**逐字
     * 精确比较**，不做 trim 或空白折叠——因此首尾空白不同的文本仍然算自定义覆盖并被保留。
     * 删除键而不是保存一份默认副本，是为了让该角色继续跟随未来默认 persona 更新。
     *
     * @param {unknown} value - candidate.promptOverrides。
     * @returns {Record<string,string>} 归一后的覆盖映射（含 0 个键表示清空全部覆盖）。
     */
    function normalizePromptOverrideCandidate(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw promptOverrideError("设置 promptOverrides 无效", PROMPT_OVERRIDE_INVALID_CODE);
      }
      const unknownRole = Object.keys(value).find((role) => !STATUS_ROLE_IDS.includes(role));
      if (unknownRole !== void 0) {
        throw promptOverrideError("未知专家角色: " + unknownRole, PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE);
      }
      const normalized = {};
      for (const [role, text] of Object.entries(value)) {
        if (typeof text !== "string") {
          throw promptOverrideError(role + " 提示词必须是字符串", PROMPT_OVERRIDE_INVALID_CODE);
        }
        if (text.trim().length === 0) {
          throw promptOverrideError(role + " 提示词不能为空", PROMPT_OVERRIDE_INVALID_CODE);
        }
        if (countPromptGraphemes(text) > PROMPT_OVERRIDE_MAX_GRAPHEMES) {
          throw promptOverrideError(role + " 提示词超过 " + PROMPT_OVERRIDE_MAX_GRAPHEMES + " 字符上限", PROMPT_OVERRIDE_INVALID_CODE);
        }
        // 逐字相同 => 删除键（不保存冗余覆盖）；只要有一个字符不同就必须保留，
        // 包括只差首尾空白这种用户有意保留的格式。
        if (text === DEFAULT_EXPERT_PERSONA[role]) continue;
        normalized[role] = text;
      }
      return normalized;
    }

    /**
     * 公开 settings 写入入口（settings.update / settings.replace / mutate）与插件
     * 自持 settings-commit 共用的提示词覆盖语义断言。
     *
     * 直接复用 normalizePromptOverrideCandidate：未知角色键、非字符串、纯空白与超过
     * grapheme 上限都拿到同一个结构化错误（ValidationError + 稳定 code），
     * 「与默认逐字相同」与「空对象」按合法输入放行。缺字段（旧文档 / 旧客户端）没有
     * 可校验的映射，保持兼容、不拒绝写入。
     *
     * @param {unknown} value - 解析后 settings 值里的 promptOverrides。
     */
    function assertPromptOverridesCandidate(value) {
      if (value === void 0) return;
      normalizePromptOverrideCandidate(value);
    }

    /** 使用当前 Host 目录校验完整候选；串行提交边界负责最后的代次检查。 */
    async function validateSettingsCandidate(candidate, signal) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new ValidationError("设置候选值无效");
      }
      if (typeof candidate.provider !== "string") throw new ValidationError("设置 provider 无效");
      if (!candidate.defaults || typeof candidate.defaults !== "object" || Array.isArray(candidate.defaults)) {
        throw new ValidationError("设置 defaults 无效");
      }
      if (typeof candidate.notificationEnabled !== "boolean") throw new ValidationError("设置 notificationEnabled 无效");
      if (!Number.isSafeInteger(candidate.notificationVolume) || candidate.notificationVolume < 0 || candidate.notificationVolume > 100) {
        throw new ValidationError("设置 notificationVolume 无效");
      }
      const hasNotificationHoldMs = candidate.notificationHoldMs !== void 0;
      const notificationHoldMs = hasNotificationHoldMs ? normalizeNotificationHoldMs(candidate.notificationHoldMs) : void 0;
      if (hasNotificationHoldMs && notificationHoldMs !== candidate.notificationHoldMs) {
        throw new ValidationError("设置 notificationHoldMs 无效");
      }
      // 旧客户端没有该字段时保持缺省语义，并在提交 patch 中省略它；显式提供时严格要求安全整数。
      const hasRoleConcurrencyLimit = candidate.roleConcurrencyLimit !== void 0;
      const roleConcurrencyLimit = hasRoleConcurrencyLimit
        ? normalizeRoleConcurrencyLimit(candidate.roleConcurrencyLimit)
        : void 0;
      if (hasRoleConcurrencyLimit && roleConcurrencyLimit !== candidate.roleConcurrencyLimit) {
        throw new ValidationError("设置 roleConcurrencyLimit 无效");
      }
      if (candidate.observerPreferred !== void 0 && typeof candidate.observerPreferred !== "boolean") {
        throw new ValidationError("设置 observerPreferred 无效");
      }
      // 任务管理开关沿用旧字段的兼容语义：缺字段表示旧客户端，不写 patch；
      // 显式提供时严格要求布尔，绝不用 truthy 值隐式关闭侧边栏注册。
      const hasTaskManagementEnabled = candidate.taskManagementEnabled !== void 0;
      if (hasTaskManagementEnabled && typeof candidate.taskManagementEnabled !== "boolean") {
        throw new ValidationError("设置 taskManagementEnabled 无效");
      }
      // 提示词覆盖沿用同一"缺字段即不覆盖"兼容语义：旧客户端提交的候选被原样放行，
      // 已有的自定义提示词不会被一次无关的通知设置保存清空。
      const hasPromptOverrides = candidate[PROMPT_OVERRIDES_SETTINGS_KEY] !== void 0;
      const promptOverrides = hasPromptOverrides
        ? normalizePromptOverrideCandidate(candidate[PROMPT_OVERRIDES_SETTINGS_KEY])
        : void 0;
      // provider catalog 是 advisory；每个启用角色的默认模型最终由 resolveCallConfig 精确验证。
      // 未启用角色（尤其是关闭 Observer 后遗留的 defaults.observer）按原值保留，
      // 避免无关的通知设置保存因已失效的隐藏运行配置失败。
      const defaults = {};
      const enabledRoles = new Set(activeRoles());
      for (const [role, selection] of Object.entries(candidate.defaults)) {
        defaults[role] = enabledRoles.has(role)
          ? await validateSelectionWithSignal(selection, signal)
          : selection;
      }
      return {
        ...candidate,
        defaults,
        ...(hasNotificationHoldMs ? { notificationHoldMs } : {}),
        ...(hasPromptOverrides ? { [PROMPT_OVERRIDES_SETTINGS_KEY]: promptOverrides } : {}),
        observerPreferred: candidate.observerPreferred === true,
        // 缺字段（旧客户端/旧文档）按开启归一：默认必须维持侧边栏注册的历史行为。
        taskManagementEnabled: candidate.taskManagementEnabled !== false,
      };
    }

    /**
     * 校验完成后立即写入宿主配置（DEG 自有提交端点的唯一写入边界）。
     *
     * 新契约下宿主**没有** validate 钩子，因此本方法就是唯一的写入前语义边界，
     * 顺序固定为：
     * 1. 提示词覆盖的完整语义校验（未知角色键、非字符串、纯空白、超 grapheme 上限）
     *    ——在任何 await 之前同步执行，非法候选绝不进入宿主写入；
     * 2. `validateSettingsCandidate`：provider/defaults/通知/并发/开关的类型与范围校验，
     *    以及每个启用角色的模型目录解析；
     * 3. 目录代次复核：校验完成到写入之间目录代次变化则拒绝；
     * 4. `updateAtGeneration` 在串行链内带 expectedRevision 写入宿主配置，并在调用
     *    宿主写入前再复核一次代次。
     *
     * **保证边界（规格书记录的降级）**：上述代次复核只覆盖 DEG 自己的提交路径，且只
     * 覆盖到宿主写入调用之前。DEG 不承诺通用宿主写入路径（settings.update / mutate，
     * 例如模型配置区）也保证模型目录有效，也不封住宿主异步落盘期间的竞态——宿主没有
     * 提供验证接缝，DEG 的锁无法协调外部写入。
     *
     * revision 冲突由宿主写入的 expectedRevision 栅栏返回（串行链保证后一条提交看到
     * 前一条落盘后的 revision）。
     *
     * 读取面语义：0.1.7 的 `describe().value` 是 defaults resolved 结果，因此
     * provider 空串、promptOverrides 空对象等“未配置”值都会出现；归一逻辑按
     * 缺失字段回退默认值处理，与旧 `scope.get()` 的解析结果同形。
     */
    function commitSettingsCandidate(candidate, expectedRevision, signal) {
      // 旧客户端缺少任务管理字段时既不写 patch，也不在响应里新增字段（保持历史形状）。
      const hasTaskManagementEnabled = candidate?.taskManagementEnabled !== void 0;
      // 提示词覆盖同理：缺字段不写 patch，避免旧客户端的保存顺带清空已有自定义提示词。
      const hasPromptOverrides = candidate?.[PROMPT_OVERRIDES_SETTINGS_KEY] !== void 0;
      return settingsRuntime.enqueueCommit(async () => {
        const generation = settingsRuntime.generation;
        // 写入前的第一道语义边界：与 validateSettingsCandidate 内部同一批规则，
        // 但这里先于任何 await 运行，保证非法覆盖不会在异步校验期间进入宿主写入路径。
        assertPromptOverridesCandidate(candidate?.[PROMPT_OVERRIDES_SETTINGS_KEY]);
        const validated = await validateSettingsCandidate(candidate, signal);
        if (!settingsRuntime.isCurrentGeneration(generation)) {
          throw new ValidationError("模型目录在保存期间发生变化，请刷新目录后重试");
        }
        const patch = {
          provider: validated.provider,
          defaults: validated.defaults,
          notificationEnabled: validated.notificationEnabled,
          notificationVolume: validated.notificationVolume,
          ...(candidate.notificationHoldMs === void 0 ? {} : { notificationHoldMs: validated.notificationHoldMs }),
          ...(candidate.roleConcurrencyLimit === void 0 ? {} : { roleConcurrencyLimit: validated.roleConcurrencyLimit }),
          // 旧客户端缺失该字段时不覆盖已有值；新客户端显式提交 true/false。
          ...(candidate.observerPreferred === void 0 ? {} : { observerPreferred: validated.observerPreferred }),
          // 任务管理同样是「缺字段即不覆盖」：旧客户端保存通知设置不得顺带重置侧边栏注册。
          ...(hasTaskManagementEnabled ? { taskManagementEnabled: validated.taskManagementEnabled } : {}),
          // 提示词覆盖按整份映射提交（不做键级合并）：空对象显式清空全部自定义提示词。
          ...(hasPromptOverrides ? { [PROMPT_OVERRIDES_SETTINGS_KEY]: validated[PROMPT_OVERRIDES_SETTINGS_KEY] } : {}),
        };
        await updateSettingsAtGeneration({ ...patch }, expectedRevision, generation);
        const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE);
        // 提交后基线改从 describe() 读取（旧 settings.get 已从宿主删除）；value 是
        // defaults resolved 结果，与读取面同一份权威值。
        const committedSettings = { ...normalizeSnapshot(descriptor?.value, activeRoles()) };
        // 旧客户端没有这些字段；它的提交/返回保持历史形状，新客户端会在 normalize 后显式携带值。
        if (candidate.observerPreferred === void 0) delete committedSettings.observerPreferred;
        if (candidate.roleConcurrencyLimit === void 0) delete committedSettings.roleConcurrencyLimit;
        if (!hasTaskManagementEnabled) delete committedSettings.taskManagementEnabled;
        if (!hasPromptOverrides) delete committedSettings[PROMPT_OVERRIDES_SETTINGS_KEY];
        return {
          settings: committedSettings,
          // 保存成功后直接回传最新只读投影：客户端据此更新基线、dirty 与"已自定义"
          // 标识，不必再发一次 meta 往返，也不需要自己重算默认 persona。
          rolePrompts: describeRolePrompts(committedSettings),
          revision: descriptor?.revision,
        };
      });
    }

    // ── 子代理推理深度注入 + 模型快照持久化 ──────────────────────────────
    const effortDisposers = new WeakMap();

    /**
     * 解析子代理应注入的推理深度（B5）：优先 child.options 上的 EFFORT_MARKER；
     * cold-resume 的专家 child 不带 marker（dsh-subagent 冷恢复只还原
     * provider/model），回落持久化 childModels 快照的 reasoningEffort。
     * 无显式 effort 返回 undefined（绝不把 adapter 的默认档固化进 settings）。
     * @param {object} agent - 被创建的 Agent 对象。
     * @param {object} [recordedExpert] - 已校验的专家快照记录（含 role/parentId/
     *   continuable），仅对 cold-resume 专家 child 传入。
     * @returns {*} 显式 effort 或 undefined。
     */
    function resolveEffortOf(agent, recordedExpert) {
      const marked = agent?.options?.[EFFORT_MARKER];
      if (marked !== void 0) return marked;
      if (recordedExpert !== void 0) return recordedExpert.reasoningEffort;
      return void 0;
    }

    /**
     * 安装 agent/request waterfall 注入推理深度（幂等：同一 agent 只装一次；
     * 请求本身已带 effort 时不覆盖）。不修改 agent.options 原对象（B5）。
     * @param {object} agent - 被创建的 Agent 对象。
     * @param {*} effort - 要注入的显式推理深度。
     * @returns {boolean} 已安装（或已装过）返回 true。
     */
    function installEffortInjection(agent, effort) {
      if (effort === void 0 || typeof agent?.ctx?.on !== "function") return false;
      if (effortDisposers.has(agent)) return true;
      const dispose = agent.ctx.on("agent/request", async (_payload, next) => {
        const resolved = await next();
        if (resolved.reasoningEffort !== void 0) return resolved;
        return { ...resolved, reasoningEffort: effort };
      });
      effortDisposers.set(agent, dispose);
      return true;
    }

    /**
     * root 代际退休时摘除它持有的 fan-out 等待登记。
     *
     * 为什么必须做：登记记录的归属凭据是注册当时捕获的 exact Agent 对象。旧代际退休后
     * 它的分片会随 agent/disposed 一起收敛，**不会再产生 task_settled**；若记录仍留在表里
     * 并保持 active，补建路径就可能（在极端的同 id replacement 场景下）被误导。这里统一
     * 标记 released 并删除：等待本身由 rootTurnWaits.retire 取消，登记表只负责「这个
     * parentTaskId 的当前代次是谁」，绝不继承旧代际的等待原因。
     *
     * @param {object} previous - 正在退休的 exact root Agent。
     */
    function releaseFanoutHandoffRecordsForRetiredRoot(previous) {
      for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
        if (record?.agent !== previous) continue;
        record.state = "released";
        fanoutTurnWaitRecords.delete(parentTaskId);
      }
    }

    function retireRootGeneration(previous) {
      if (!isRootAgentIdentity(previous) || typeof previous.id !== "string") return;
      const previousGeneration = rootGenerationRegistry.generationOf(previous.id);
      // 终止快照按旧 root 的 exact generation 退休；迟到旧事件不能删除同 id 新代际。
      notificationHost.retireRoot(previous.id, previousGeneration);
      // 同 id 的 R2 出现时先切断 R1 的所有可恢复边界；WeakSet 只保留对象
      // 身份用于迟到 microtask 判定，不把已销毁 root 长期挂在容器里。
      disposedRootAgents.add(previous);
      host.lineage.releaseAgent(previous);
      pendingUserWaits.delete(previous);
      const previousToken = host.lineage.tokenOf(previous);
      if (previousToken !== void 0) previousToken.active = false;
      // 代际退休：取消该 root 的全部等待（等待者以 released:false 收口）、移除监听与引用。
      // 旧代际的迟到事件不会再命中任何记录，因此无法释放新 waiter。
      rootTurnWaits.retire(previous, "root-generation-retired");
      // 旧代际的分片不会再产生 task_settled：必须同时摘除它持有的 fan-out 登记，
      // 否则那些「永远等不到结算」的登记会让后续补建路径被误导。
      releaseFanoutHandoffRecordsForRetiredRoot(previous);
      pendingChildTurnEnds.delete(previous);
      failedHandoffChildren.delete(previous);
      clearPendingHandoffAdmissions(previous);
      delegationTracker.dropParent(previous.id);
      rootGenerationRegistry.retire(previous.id, previous);
      for (let index = pendingCreations.length - 1; index >= 0; index--) {
        if (pendingCreations[index].parent === previous) pendingCreations.splice(index, 1);
      }
      recovery.dropRebuildsFor(previous);
      dropParentRecoveryRecords(previous);
    }
    ctx.on("agent/created", ({ agent }) => {
      // root turn 等待的介入点：任何在某个 live root 之下新建的子代理（角色 child、fan-out
      // 分片、嵌套后代）都意味着「该 root 的当前 turn 可能还有工作没结束」。这里只登记
      // 「该 root 已进入等待体系」，是否真的等待仍由 host/turn-wait.js 的静止判定决定；
      // 因此纯 continue_parent_turn 与模型遗漏 finalize 的路径也能被 agent/turn-stopping
      // 兜底覆盖，而不需要为它们各写一套账本。
      engageRootTurnWaitForCreatedAgent(agent);
      // fan-out child 必须先于旧 recovery 分支路由；marker 缺失的 cold child
      // 只能在精确 child_models 记录具备完整 fan-out identity 时走同一条路径。
      const recordedFanoutChild = typeof agent?.id === "string" ? source().childModels?.[agent.id] : void 0;
      const fanoutChild = isFanoutAgent(agent) || isFanoutIdentity(recordedFanoutChild);
      if (fanoutChild) {
        fanoutHost?.handleAgentCreated(agent, recordedFanoutChild);
        fanoutHost.restore();
        return;
      }
      fanoutHost.restore();
      if (typeof agent?.id === "string") {
        const registered = agents.get(agent.id);
        const currentChildRecord = recoveryRecords.get(agent.id);
        // registry 已指向另一个 Agent 时，这是迟到旧 Activation；不能让它
        // 覆盖当前 child/root generation。cold resume 的新 Agent 必须已成为 registry 当前值。
        if (registered !== void 0 && registered !== agent && currentChildRecord?.agent !== void 0) return;
      }
      if (isRootAgentIdentity(agent) && typeof agent?.id === "string") {
        // root generation 以 exact Agent 对象识别；同 id 的新 root 覆盖当前代际。
        const previous = host.lineage.activeRoot(agent.id);
        if (previous !== void 0 && previous !== agent) retireRootGeneration(previous);
        host.lineage.activateRoot(agent);
        host.lineage.tokenFor(agent);
        rootGenerationRegistry.activate(agent.id, agent);
        notificationHost.activateRoot({ rootId: agent.id, generation: rootGenerationRegistry.generationOf(agent.id) });
        // root 重新出现（上面的 restore() 已把 deferred 任务恢复回来）且 lineage 绑定刚刚
        // 建立，此刻才能按 root 归属补登记 fan-out 等待工作。
        reconcileFanoutGoalHandoffs();
      }
      if (typeof agent?.id === "string") {
        // replacement 先取消旧 Agent 的 request fallback，再覆盖 Activation 身份。
        const previousActivation = childActivationStates.get(agent.id);
        if (previousActivation?.agent !== void 0 && previousActivation.agent !== agent) {
          invalidateRequestRetryState(previousActivation.agent);
        }
        childActivationStates.set(agent.id, { agent, status: "live" });
      }
      let role = agent?.options?.[ROLE_MARKER];
      let parentId = agent?.options?.[PARENT_MARKER];
      // 所有专家委派统一走 continuable child：agentOptions 无条件
      // 写入 CONTINUABLE_MARKER=true，agent/created 据此持久化；重启恢复只接受
      // 带标记的 child（旧版 one-shot 与无标记记录不可 steer，恢复时忽略）。
      let isContinuable = agent?.options?.[CONTINUABLE_MARKER] === true;
      // B5：cold-resume 的专家 child 不带 marker（dsh-subagent 冷恢复只还原
      // provider/model），从持久化 childModels 快照补 role/parentId/continuable，
      // 据此补登记恢复记录并保留快照里的推理深度。
      let recordedExpert;
      if ((typeof role !== "string" || typeof parentId !== "string") && typeof agent?.id === "string") {
        const recorded = source().childModels?.[agent.id];
        if (typeof recorded?.role === "string" && typeof recorded?.parentId === "string" && recorded?.continuable === true) {
          role = recorded.role;
          parentId = recorded.parentId;
          isContinuable = true;
          recordedExpert = recorded;
        }
      }
      const effort = resolveEffortOf(agent, recordedExpert);
      // 专家 child（带 ROLE/PARENT marker 或 cold-resume 快照补全）登记自动恢复
      // 记录：turn/end 失败/空返回时以父代理身份自动续跑；父会话与其他子代理
      // 无 marker，不受影响。
      // P2：startContinuable 的 agent/created 与其 Promise resolve 之间，父代理
      // 销毁或插件卸载可能已经 dropRecoveryRecord。此时迟到 child 不得把旧 record
      // 重新插回 Map，更不得复活 任务/活动；只让该 child 自然收敛。
      let ignoredLateRecoveryChild = false;
      let pluginChildAuthenticated = false;
      if (typeof role === "string" && typeof parentId === "string" && typeof agent?.id === "string") {
        const rebuilding = recovery.takeRebuild(host.lineage.activeRoot(parentId), parentId, role);
        const currentParent = host.lineage.activeRoot(parentId);
        const pendingCreationForCurrentRoot = pendingCreations.some((item) => item.parent === currentParent
          && item.rootToken === host.lineage.tokenOf(currentParent)
          && item.parentId === parentId && item.role === role);
        const existingRecord = recoveryRecords.get(agent.id);
        let record;
        const hasCreationMarkers = typeof agent?.options?.[ROLE_MARKER] === "string"
          && typeof agent?.options?.[PARENT_MARKER] === "string";
        const isColdResumeSnapshot = recordedExpert !== void 0 && !hasCreationMarkers;
        if (rebuilding === void 0 && (existingRecord !== void 0 || pendingCreationForCurrentRoot || isColdResumeSnapshot)) {
          pluginChildAuthenticated = true;
          record = ensureRecoveryRecord(agent.id, parentId, role, currentParent, agent, isContinuable);
        } else if (rebuilding === void 0) {
          // marker child 没有当前 root 的 pending creation，也没有 durable snapshot/record，
          // 只能是已退休 root await 的迟到 accepted child；禁止它复活插件状态。
          ignoredLateRecoveryChild = true;
        } else if (recoveryRebuildCanCommit(recoveryRecords, rebuilding.record, rebuilding.op)) {
          pluginChildAuthenticated = true;
          moveRecoveryRecordToChild(rebuilding.record, agent.id, agent);
          record = rebuilding.record;
        } else {
          ignoredLateRecoveryChild = true;
          ctx.logger.warn(`dsh-expert-group: ignoring late recovery rebuild child ${agent.id} after its record was cleared`);
        }
        if (record !== void 0) {
          // 记录当前 Activation 的 exact 身份；同 id 的旧 Session 事件不得接管新记录。
          const previousActivation = record.agent;
          record.agent = agent;
          if (agent.session !== void 0) bindRecoverySession(record, agent.session, previousActivation);
          else if (record.parentAgent !== void 0) {
            handoffAdmissionCohort.updateActivation(record.parentAgent, agent.id, agent, { previousActivation });
          }
        }
        // P3：新建路径（delegateBackground → startContinuable）的 binding
        // acceptance 竞态预登记——只消费带 ROLE/PARENT marker 的新建 child
        // （cold-resume 快照补全的旧 child 不参与）：agent/created 同步触发
        // 且早于 startContinuable resolve，立即写入 pendingMessage 绑定
        // （messageId 尚不确定），让 inbox claimed 补绑与 reused 反查都能命中；
        // startContinuable 返回后回填 messageId 并清 pendingMessage。
        if (record !== void 0 && rebuilding === void 0 && typeof agent?.options?.[ROLE_MARKER] === "string" && typeof agent?.options?.[PARENT_MARKER] === "string") {
          const pending = pendingCreations.find((item) => item.parent === host.lineage.activeRoot(parentId)
            && item.rootToken === host.lineage.tokenOf(host.lineage.activeRoot(parentId))
            && item.parentId === parentId && item.role === role);
          if (pending !== void 0) pendingCreations.splice(pendingCreations.indexOf(pending), 1);
          if (pending !== void 0 && typeof pending.taskKey === "string") {
            const transaction = pending.transaction;
            if (transaction !== void 0) {
              transaction.agent = agent;
              transaction.childId = agent.id;
              transaction.record = record;
              transaction.recordOwned = existingRecord === void 0;
            }
            const previousBinding = record.tasks.get(pending.taskKey);
            const nextBinding = { messageId: null, childId: agent.id, pendingMessage: true };
            record.tasks.set(pending.taskKey, nextBinding);
            if (transaction !== void 0) {
              transaction.previousBinding = previousBinding;
              transaction.binding = nextBinding;
              // 即使覆盖了同 key 的旧 binding，nextBinding 仍是本事务写入；
              // rollback helper 会按 previousBinding 精确恢复旧 durable 状态。
              transaction.taskBindingOwned = true;
            }
            if (pending.activityId !== void 0) delegationTracker.bindActiveTask(pending.activityId, agent.id);
            if (pending.handoffExpected === true) bindPendingHandoffAdmission(pending.handoffAdmission, agent.id, pending.messageId);
            evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
          }
        }
      }
      // 子代理创建即持久化其实际模型配置：即使子代理随后结束/进程重启，
      // 侧边栏仍能只读显示它当时使用的 provider/model/思考深度。
      // 专家子代理（带 ROLE/PARENT marker 或 cold-resume 补全）无条件记录并携带
      // role/parentId 与 continuable:true，供重启后按 parentId+role+route 恢复。
      // P2：已清理 record 的迟到 rebuild child 不写入快照，避免后续 cold-resume
      // 把一个父代理已放弃的 child 当成可复用任务重新登记。
      const isExpertChild = typeof role === "string" && typeof parentId === "string" && !ignoredLateRecoveryChild;
      if (pluginChildAuthenticated) registerPluginExpertChildAgent(agent);
      if (isExpertChild) {
        // 该监听器在早期 guard listener 之后运行；此时 role/parentId 已从 marker、
        // cold-resume 快照或 recovery record 建立，必须再次尝试 child scoped guard。
        installExpertReportGuardForAgent(agent, { role, parentId, source: recordedExpert === void 0 ? "marker" : "snapshot" });
      }
      if (typeof agent?.options?.provider === "string" && typeof agent?.options?.model === "string" && (isExpertChild || effort !== void 0)) {
        writeChildModel(agent.id, {
          provider: agent.options.provider,
          model: agent.options.model,
          reasoningEffort: effort === void 0 ? void 0 : String(effort),
          ...(isExpertChild ? { role, parentId, ...(isContinuable ? { continuable: true } : {}) } : {}),
        });
      }
      installEffortInjection(agent, effort);
    });
    ctx.on("agent/disposed", ({ agent }) => {
      const expertGuardCleanup = expertReportGuardDisposers.get(agent);
      if (expertGuardCleanup !== void 0) {
        try { expertGuardCleanup(); } catch (error) {
          ctx.logger.warn("dsh-expert-group: expert report guard cleanup failed: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          expertReportGuardDisposers.delete(agent);
        }
      }
      const recordedFanoutChild = typeof agent?.id === "string" ? source().childModels?.[agent.id] : void 0;
      if (isFanoutAgent(agent) || isFanoutIdentity(recordedFanoutChild)) {
        // cold-resume child 可能没有 creation marker；disposed 仍必须让同一 attempt 收敛。
        fanoutHost?.handleAgentDisposed(agent, recordedFanoutChild);
        if (typeof agent?.id === "string") {
          const current = childActivationStates.get(agent.id);
          if (current?.agent === agent) childActivationStates.delete(agent.id);
        }
        invalidateRequestRetryState(agent);
        const dispose = effortDisposers.get(agent);
        if (dispose !== void 0) {
          effortDisposers.delete(agent);
          try { dispose(); } catch {}
        }
        return;
      }
      const rootDisposed = isRootAgentIdentity(agent) && host.lineage.isKnownRoot(agent);
      const isCurrentRootGeneration = rootDisposed && rootGenerationRegistry.isCurrent(agent.id, agent);
      // 先读取当前 exact Agent 的 generation，再退休完成状态；旧 disposed 事件不触碰新代次。
      const disposedGeneration = rootGenerationRegistry.generationOf(agent.id);
      const hasRootState = rootDisposed && (
        host.handoff.some((entry) => entry.parent === agent)
        || pendingChildTurnEnds.has(agent)
        || failedHandoffChildren.has(agent)
      );
      if (rootDisposed) {
        disposedRootAgents.add(agent);
        pendingUserWaits.delete(agent);
        const token = host.lineage.tokenOf(agent);
        if (token !== void 0) token.active = false;
        if (isCurrentRootGeneration && Number.isSafeInteger(disposedGeneration)) {
          // root dispose 立即丢弃终止快照：没有新 run 就不可能再补发。
          notificationHost.retireRoot(agent.id, disposedGeneration);
        }
        rootGenerationRegistry.retire(agent.id, agent);
      }
      // 与 retireRootGeneration 同一语义：root dispose 后它的分片不会再产生
      // task_settled。取消该 root 的全部等待，并摘除它的 fan-out 登记（旧代际的登记
      // 绝不能被新代际继承）。
      if (agent !== void 0) rootTurnWaits.retire(agent, "root-disposed");
      if (rootDisposed) releaseFanoutHandoffRecordsForRetiredRoot(agent);
      if (typeof agent?.id === "string") {
        const current = childActivationStates.get(agent.id);
        // 只释放当前对象；旧 Activation 的迟到 disposed 不得删除新对象。
        if (current?.agent === agent) childActivationStates.delete(agent.id);
      }
      if (rootDisposed) {
        const ownsCurrentRoot = host.lineage.activeRoot(agent.id) === agent;
        if (ownsCurrentRoot) {
          host.lineage.releaseAgent(agent);
          host.lineage.releaseRoot(agent);
        }
        // 只有当前 root generation 才能清理 tracker、admission 和 recovery record；
        // child disposed 不得按 id 误删父状态，R1 迟到事件也不能污染 R2。
        if (agents.get(agent.id) === agent) delegationTracker.dropParent(agent.id);
        dropParentRecoveryRecords(agent);
      }
      // child Activation 的 disposed 不删除 durable recovery record；自动恢复仍需它。
      // 请求级状态只绑定当前 Agent 对象，销毁时必须立即摘除，迟到 hook 不能复活。
      invalidateRequestRetryState(agent);
      const dispose = effortDisposers.get(agent);
      if (dispose !== void 0) {
        effortDisposers.delete(agent);
        try { dispose(); } catch {}
      }
    });

    /**
     * 在公开 agent/request-error waterfall 上接管插件 root 与专家 child 的结构化
     * 瞬态错误。使用 prepend 保证该边界先于 Host listener：Host 已有 llm/retry
     * 负责退避时只复用其返回值；Host 未处理的 code 由公开 async hook 使用
     * payload.signal 等待有界退避。这里绝不调用 prompt、私有 steer 或内部 API。
     */
    ctx.on("agent/request-error", async (payload, next) => {
      const agent = payload?.agent;
      const target = requestRetryTarget(agent);
      if (target === void 0) return typeof next === "function" ? next() : void 0;
      const session = agent?.session;
      const turn = payload?.turn;
      const step = payload?.step;
      if (session === null || (typeof session !== "object" && typeof session !== "function")
        || !Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) return void 0;

      const state = requestRetryStateFor(agent, session, turn, step);
      const hostCount = hostRetryCountFor(session, turn, step);
      if (hostCount > state.retryCount) state.retryCount = Math.min(hostCount, AUTO_RECOVERY_LIMIT);
      const failure = payload?.failure;
      if (state.exhausted === true) return void 0;
      if (markRequestRetryEvent(state, payload, failure)) return void 0;

      // 同一 open step 不应并发处理两次错误；真正的下一次请求会在本 hook
      // 返回后才由 agent loop 发起，因此 activeKey 释放后仍可继续消耗预算。
      const activeKey = String(turn) + ":" + String(step);
      if (state.activeKey === activeKey) return void 0;
      state.activeKey = activeKey;
      try {
        if (payload?.signal?.aborted === true) {
          if (state.retryCount > 0) state.exhausted = true;
          return void 0;
        }
        if (!isTransientRequestFailure(failure)) {
          // 已经发生过请求级重试后又出现永久/未知失败时，不能再落入 child
          // continuation，把同一失败计两遍；没有前置请求重试则保留既有终态语义。
          if (state.retryCount > 0) state.exhausted = true;
          return void 0;
        }

        const hostOwnsCode = requestRetryPolicyCoversFailure(payload?.retryPolicy, failure);
        let delegated;
        if (typeof next === "function") {
          try {
            delegated = await next();
          } catch (error) {
            // 下游 Host listener 的异常不改变 failure.code 的 fail-closed 边界；
            // 只要当前 Agent/Session 仍然存活，就继续使用本插件的最小预算。
            ctx.logger.warn("dsh-expert-group: request retry downstream listener failed: " + (error instanceof Error ? error.message : String(error)));
          }
        }
        const currentTarget = requestRetryTarget(agent);
        if (currentTarget === void 0 || requestRetryStates.get(agent) !== state
          || state.session !== session || payload?.signal?.aborted === true) return void 0;

        if (delegated?.kind === "retry") {
          // Host 已完成 durable llm/retry 记录与退避；只同步总预算，绝不再发第二次。
          state.retryCount = Math.min(Math.max(state.retryCount + 1, hostRetryCountFor(session, turn, step)), AUTO_RECOVERY_LIMIT);
          return delegated;
        }

        if (hostOwnsCode) {
          // retryPolicy 明确声明该 code 归 Host 管理时，undefined 表示 Host
          // 已拒绝/耗尽 retry；插件不得补发 action 突破 Host maxRetries。
          state.exhausted = true;
          return void 0;
        }

        const nextRetry = state.retryCount + 1;
        if (!Number.isSafeInteger(nextRetry) || nextRetry > AUTO_RECOVERY_LIMIT) {
          state.exhausted = true;
          return void 0;
        }
        const providerDelay = Number.isSafeInteger(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0
          ? failure.providerRetryAfterMs
          : Number.isSafeInteger(failure?.retryAfterMs) && failure.retryAfterMs > 0
            ? failure.retryAfterMs
            : void 0;
        const delay = providerDelay !== void 0
          ? Math.min(providerDelay, recoveryDelayForCount(nextRetry) ?? providerDelay)
          : recoveryDelayForCount(nextRetry);
        if (!Number.isSafeInteger(delay) || delay <= 0) {
          state.exhausted = true;
          return void 0;
        }
        const generation = state.generation;
        const waitController = new AbortController();
        state.waitController = waitController;
        const active = () => requestRetryStateIsCurrent(agent, session, turn, step, state, generation);
        const ready = await waitForRequestRetryDelay(delay, [payload?.signal, waitController.signal], active);
        if (state.waitController === waitController) state.waitController = void 0;
        if (!ready || !active()) {
          if (requestRetryStates.get(agent) === state && state.generation === generation) state.exhausted = true;
          return void 0;
        }
        state.retryCount = nextRetry;
        return { kind: "retry" };
      } finally {
        if (state.activeKey === activeKey) state.activeKey = void 0;
      }
    }, { prepend: true });

    // ── 自动恢复（自愈监督） ──────────────────────────────────────
    // 每个专家 continuable child 的 turn/end 失败/空返回时，插件以父代理身份经
    // manager sendMessage 投递一条中文「继续执行」指令（同一 child 连续最多 5 次）；
    // 非阻塞 admission 只登记恢复链；子代理结果通过 DSH 后续 feedback 交付。

    /**
     * 把 recovery record 绑定到当前 Session generation，并切换 transient 状态。
      * cold resume/replacement 会产生新的 Session 对象；新对象必须拥有新的 turn
      * 去重集合和 claimed 映射，但 durable tasks/op/activity 保持在 record。
      */
     function bindRecoverySession(record, session, previousActivation) {
       if (record === void 0 || session === null
         || (typeof session !== "object" && typeof session !== "function")) return void 0;
       const previousSession = record.session;
       if (!(record.sessionState?.get instanceof Function)) {
         const previousHandled = record.handledTurnEnds instanceof Set ? [...record.handledTurnEnds] : [];
         const previousClaimed = record.claimed instanceof Map ? [...record.claimed] : [];
         record.sessionState = createSessionGenerationState();
         if (previousSession !== void 0) {
           const previousState = record.sessionState.get(previousSession);
           for (const turn of previousHandled) previousState.handledTurnEnds.add(turn);
           for (const pair of previousClaimed) previousState.claimed.set(pair[0], pair[1]);
         }
       }
       if (previousSession !== void 0 && previousSession !== session) {
         record.sessionState.reset(previousSession);
         // Session/Activation generation 变化后，旧 child 的撤回消息不能被新
         // generation 当作最终 feedback 重投递；恢复 op/activity 仍由 durable record 保留。
         tombstoneGatedRecoveryFeedbacks(record);
         record.recoveryFeedbackDeliveries?.clear?.();
         if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
       }
       const nextActivation = record.agent;
       if (previousActivation !== void 0 && previousActivation !== nextActivation
         && Array.isArray(record.gatedRecoveryFeedbacks)) {
         tombstoneGatedRecoveryFeedbacks(record);
         record.recoveryFeedbackDeliveries?.clear?.();
         record.gatedRecoveryFeedbacks.length = 0;
       }
       if (record.parentAgent !== void 0 && typeof record.childId === "string"
         && nextActivation !== void 0) {
         handoffAdmissionCohort.updateActivation(record.parentAgent, record.childId, nextActivation, {
           previousActivation, nextSession: session,
         });
       }
       if (Array.isArray(record.pendingFeedbacks) && nextActivation !== void 0) {
         // A4：activation replacement / cold-resume 会产生新的 Agent/Session generation。
         // pending marker 的关联证据是「到达时刻的 activation + Session generation」，
         // 迁移必须保证它不能被新代际消费：
         // - wildcard（admissionId === undefined）是 activation 级结论，跨代即失效 →
         //   直接丢弃。否则旧代际的 union 会把新代际登记的 token 提前标记成 feedbackSeen
         //   → 提前 release；丢弃后新代际会用自己的 settlement 重建快照消费（不会死锁）。
         // - exact marker 的身份是 admission token/messageId，不随代际漂移：保留并更新
         //   activation，让它在后续 turn/end 仍能精确命中同一 token。
         const generationChanged = (previousActivation !== void 0 && previousActivation !== nextActivation)
           || (previousSession !== void 0 && previousSession !== session);
         record.pendingFeedbacks = record.pendingFeedbacks.filter((pendingFeedback) => {
           if (pendingFeedback === null || typeof pendingFeedback !== "object") return false;
           if (pendingFeedback.activation !== void 0 && previousActivation !== void 0
             && pendingFeedback.activation !== previousActivation) return false;
           if (pendingFeedback.admissionId === void 0 && generationChanged) return false;
           pendingFeedback.activation = nextActivation;
           return true;
         });
       }
       record.session = session;
       const state = record.sessionState.get(session);
       record.handledTurnEnds = state.handledTurnEnds;
       record.claimed = state.claimed;
       return state;
     }

     /**
      * replacement child 不得继承旧 child/session 的 transient turn 归属。
      * durable recovery 数据仍留在同一 record，供新 Activation 接续。
      */
     function resetRecoverySession(record) {
       if (record === void 0) return;
       if (record.sessionState?.reset instanceof Function) record.sessionState.reset(record.session);
       record.session = void 0;
       record.handledTurnEnds = new Set();
       record.claimed = new Map();
     }

     /**
      * 取得（或创建）某专家 child 的 durable recovery record。
     * cold resume 会创建新的 Agent wrapper，但只要它仍挂载同一个 Session 且
     * parentAgent exact 相同，就必须接管原 record，而不是丢弃 tasks/op。
     * 不同 Session 或不同 owner 才使用 expectedRecord 做 owner-scoped drop。
     */
    function ensureRecoveryRecord(childId, parentId, role, parentAgent, childAgent, continuable = false) {
      let record = recoveryRecords.get(childId);
      const parentMismatch = record !== void 0
        && ((parentAgent !== void 0 && record.parentAgent !== void 0 && record.parentAgent !== parentAgent)
          || (record.parentId !== void 0 && record.parentId !== parentId)
          || (record.role !== void 0 && record.role !== role));
      if (parentMismatch) {
        // expectedRecord 身份保护：并发 cold Activation 不能删除已经被另一条
        // generation 原子接管的 record。
        dropRecoveryRecord(childId, "recovery child owner or role changed", record);
        record = void 0;
      }
      if (record !== void 0 && childAgent !== void 0) {
        // Agent wrapper 可因 cold resume 改变；只要任一侧已有 activation/session
        // 身份，就必须通过 durable Session id 校验，避免不同 child 误接管 record。
        const comparable = record.agent !== void 0 || record.session !== void 0 || childAgent.session !== void 0;
        const sameDurableSession = sameDurableSessionId(record.session, childAgent.session, childId);
        if (comparable && !sameDurableSession) {
          dropRecoveryRecord(childId, "recovery child session generation changed", record);
          record = void 0;
        }
      }
      if (record !== void 0 && record.parentAgent === void 0 && parentAgent !== void 0) {
        record.parentAgent = parentAgent;
      }
      // marker 和 cold-resume 快照都只能由插件专家路径传入 true；把可信身份
      // 落到运行时 record，避免冷恢复 Agent.options 缺失 marker 时被忽略。
      if (record !== void 0 && continuable === true) record.continuable = true;
      if (record === void 0) {
        record = {
          childId,
          parentId,
          role,
          // 记录父 root 的 exact generation；同 id 的替代 root 不得接管此 record。
          parentAgent,
          continuable: continuable === true,
          /** 连续自动恢复次数：仅在插件自动发送恢复指令时 +1；成功 turn 清零。 */
          recoveryCount: 0,
          /** 进行中的自动恢复 op 表（B4）：opId -> op，每个触发恢复的 turn 一个
           *  独立 op，互不串链、互不重复恢复；取代旧的单一恢复槽位。 */
          pendingRecoveries: new Map(),
          /**
           * 恢复未决时从父 inbox 同步撤回的 DSH feedback。每项保存 parent/child/
           * durable Session/Activation 快照；只允许当前精确 generation 在最终边界
           * 重投递，旧 replacement 的通知只能丢弃。
           */
          gatedRecoveryFeedbacks: [],
          // finalized feedback id 持久化为 blocked/delivered，防止重复 inserted 越过门控。
          recoveryFeedbackTombstones: new Map(),
          recoveryFeedbackDeliveries: new Set(),
          /**
           * 无 message.id delivery 的对象身份 tombstone（item 2）。
           *
           * 无 id 时协议不提供可寻址身份，inbox.remove 也无从调用；只能用 exact message
           * 对象身份把「已被 recovery gate 拦下的 delivery」钉住，避免 gate 关闭后同一
           * 对象再走普通 handoff 队列。WeakSet 不持有消息，随 GC 自动回收，不做无界 Set。
           */
          recoveryFeedbackObjectTombstones: new WeakSet(),
          /**
           * 已消费过的父 inbox feedback message.id 账本（A1，createFeedbackIdentityLedger）。
           *
           * 宿主会以同一 message.id 重复投递同一条 child settlement；副本不能被当作新结论
           * 去消费 cohort 里的 token，否则会把本轮 token 的 feedbackSeen 提前置 true，
           * 导致 root 在结果真正回来之前提前放行。
           *
           * 生命周期与 record 一致，**不做插入序淘汰**（淘汰会让旧副本重新变成新
           * settlement）；达到 FEEDBACK_DELIVERY_LIMIT 时进入 fail-closed 饱和，
           * 无身份 settlement 只能走保守队列路径。
           */
          feedbackIdentityLedger: createFeedbackIdentityLedger({ limit: FEEDBACK_DELIVERY_LIMIT }),
          // terminal=true 表示当前 generation 已经决定交接；后续同一终态的重复
          // inserted 不得再次撤回，新 turn 的 claim/turn 会显式打开下一代 gate。
          recoveryFeedbackActive: false,
          recoveryFeedbackTerminal: false,
          recoveryFeedbackTerminalTurn: void 0,

          /** B1：最近一次 session 引用缓存——跨 Activation 存活，事件处理不再依赖
           *  事件不再依赖 agents.get(childId) 是否 live（Activation 释放后仍可读）。 */
          session: void 0,
          // transient turn/claimed 状态按 Session generation 隔离；其余字段保持 durable。
          sessionState: createSessionGenerationState(),
          /** 当前 child Activation 的 exact Agent；同 id 的旧对象事件不得接管记录。 */
          agent: void 0,
          handledTurnEnds: new Set(),
          /** B2：message.id -> turn 认领映射（agent/inbox/claimed 写入）。
           *  覆盖「消息被 inbox 认领但 user/message 未落盘」（pre-step reject/
           *  取消/异常）的归属缺口；record 生命周期内不清空，按 messageId 覆盖。 */
          claimed: new Map(),
          /** B3：任务绑定表 taskKey -> { messageId, childId, outcome?, blocks?,
           *  failureMessage?, pendingMessage? }——供成功输出缓存、
           *  确定失败记录与 forgetTask 反查。
           *  S1-D：steer/startContinuable admission 前以 pendingMessage:true
           *  预登记（messageId 尚不确定），admission 返回后回填 messageId 并清
           *  标记；claimed 补绑只处理 pendingMessage === true && messageId ===
           *  null 且任务文本匹配的项。S2：上限 TASK_BINDING_LIMIT 条，超限按
           *  插入序淘汰最旧。 */
          tasks: new Map(),
        };
        recoveryRecords.set(childId, record);
      }
      return record;
    }

    /** 从 recovery 重建预登记中消费匹配 parent+role 的原记录。 */
    /**
     * 将 durable recovery record 原子迁移到替代 child。旧 child 的迟到事件因 map
     * 中不再有旧 id 而被忽略；未完成的 root handoff 原因同步迁移到新 child。
     */
    function moveRecoveryRecordToChild(record, childId, childAgent) {
      const previousChildId = record.childId;
      if (previousChildId !== childId) {
        // child replacement 会复用数字 turn；清空旧 Session 的 transient 映射，
        // 但不动 durable tasks/pendingRecoveries/activity/cohort。
        resetRecoverySession(record);
        // 旧 child 的 settlement 不能成为 replacement child 新任务的反馈；即使
        // 同一 parent 仍处于 handoff，也只能由新 generation 自己产生最终通知。
        tombstoneGatedRecoveryFeedbacks(record);
        record.recoveryFeedbackDeliveries?.clear?.();
        if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
        record.recoveryFeedbackTerminal = false;
        record.recoveryFeedbackTerminalTurn = void 0;
        recoveryRecords.delete(previousChildId);
        migrateChildHandoff(record.parentAgent, previousChildId, childId, childAgent, record.agent);
      }
      const provisional = recoveryRecords.get(childId);
      if (provisional !== void 0 && provisional !== record) recoveryRecords.delete(childId);
      record.childId = childId;
      recoveryRecords.set(childId, record);
      return previousChildId;
    }

    /**
     * 删除某 child 的恢复记录（父代理真销毁/插件卸载时防泄漏）。
     * 先清理所有 pending op，保留 accepted/messageId 事实并终止其投递信号。
     */
    function dropRecoveryRecord(childId, message, expectedRecord) {
      const record = recoveryRecords.get(childId);
      if (expectedRecord !== void 0 && record !== expectedRecord) return;
      if (record === void 0) return;
      recoveryRecords.delete(childId);
      // record 已不再有可验证的 current generation，撤回消息不可重投递，避免
      // 已替换/已销毁 child 的旧异常把父代理重新唤醒。
      if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
      clearPendingChildTurnEnds(record.parentAgent, record);
      for (const entry of host.handoff.filter((item) => item.parent === record.parentAgent && item.childId === childId)) {
        handoffAdmissionCohort.remove(entry);
        host.handoff.remove(entry);
      }
      failedHandoffChildren.clearChild(record.parentAgent, childId);
      // 此记录已被确定丢弃，不能再留下会永久阻塞后续委派的活动范围。
      delegationTracker.completeActiveTasksForChild(childId, record.parentId, record.parentAgent);
      for (const op of [...record.pendingRecoveries.values()]) {
        // 先同步终结状态：已排入 microtask 或正等待 sendMessage 的迟到回调必须观察到
        // done/非 dispatching。先清理该 op 的 timer；保留 accepted/messageId，
        // 避免抹掉 manager 已接受消息的事实。
        clearRecoveryOpTimer(op);
        op.dispatching = false;
        op.done = true;
        if (op.controller !== void 0) op.controller.abort();
      }
      record.pendingRecoveries.clear();
    }

    /** 删除某父代理名下全部恢复记录（父代理销毁时防内存泄漏）。 */
    function dropParentRecoveryRecords(parent) {
      if (!isRootAgentIdentity(parent)) return;
      pendingChildTurnEnds.delete(parent);
      failedHandoffChildren.delete(parent);
      clearPendingHandoffAdmissions(parent);
      for (const childId of [...recoveryRecords.keys()]) {
        const record = recoveryRecords.get(childId);
        if (record?.parentAgent === parent) {
          dropRecoveryRecord(childId, "父代理已销毁，等待被中止", record);
        }
      }
    }

    /** 统一安排恢复消息的退避 timer；timer 失败仍按确定的调度终态收口。 */
    function scheduleRecoveryDispatchTimer(record, session, reason, op) {
      const scheduled = scheduleRecoveryOpTimer(op, record.recoveryCount, () => {
        // timer callback 已先清句柄；这里再排 microtask，保留原有 append 重入保护。
        queueMicrotask(() => {
          // 父销毁/插件卸载可在 timer 或 microtask 排队后同步删除 record。serialize()
          // 的 entryOf 会为不存在的 scope 重建空项，因此两层都必须做生命周期 guard。
          if (!recoveryDispatchCanStart(recoveryRecords, session.id, record, op)) return;
          const recoveryScope = delegationScopeKey(record.parentId, record.role);
          void delegationTracker.serialize(recoveryScope, async () => {
            try {
              await dispatchRecovery(op, record, session, reason);
            } catch (error) {
              // 仅在 op 尚未 acceptance 时终结；已接受 op 的 ancillary 异常不能
              // 把 manager 已接收的消息误删。该兜底仍在同 scope 锁内执行。
              if (recoveryOpIsPending(record.pendingRecoveries, op) && !recoveryOpIsAccepted(op)) {
                failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：" + (error instanceof Error ? error.message : String(error)));
              }
              throw error;
            }
          }).catch((error) => {
            // dispatchRecovery 已处理可重试投递失败；这里只记录未预见的锁级异常。
            ctx.logger.warn("dsh-expert-group: auto-recovery dispatch failed: " + (error instanceof Error ? error.message : String(error)));
          });
        });
      }, {
        // timer callback 前的 guard；queueMicrotask 内仍重复校验，覆盖 timer/append 竞态。
        isActive: () => recoveryDispatchCanStart(recoveryRecords, session.id, record, op),
        onError: (error) => {
          if (recoveryOpIsPending(record.pendingRecoveries, op) && !recoveryOpIsAccepted(op)) {
            failPendingRecoveryOp(op, record, reason, "自动恢复计时器失败：" + (error instanceof Error ? error.message : String(error)));
          }
          ctx.logger.warn("dsh-expert-group: auto-recovery timer failed: " + (error instanceof Error ? error.message : String(error)));
        },
      });
      if (!scheduled && recoveryOpIsPending(record.pendingRecoveries, op)) {
        // 非法/越界 count 或 scheduler 不可用时不尝试无退避 dispatch，直接走原失败收口。
        failPendingRecoveryOp(op, record, reason, "自动恢复计时器未安排");
      }
    }

    /**
     * 处理一次专家 child 的 turn/end（仅 session/event 监听器调用）：自动恢复链、
     * 任务绑定结局回写与活动范围清理。
     * 同一 turn/end 只会被监听器处理一次；恢复 turn 按消息 id 完结对应 op，
     * 后续失败时创建新 op 并继承 taskKeys。
     */
    function handleChildTurnEnd(record, session, event, { allowRecovery = true } = {}) {
      const turn = event?.data?.turn;
      const reason = event?.data?.reason ?? {};
      const events = session?.events;
      if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return;
      const sessionState = bindRecoverySession(record, session);
      if (sessionState === void 0 || !record.sessionState.claimTurn(session, turn)) return;
      resetRecoveryFeedbackGateForNewTurn(record, session, turn);
      const hadRecoveryFeedback = record.recoveryFeedbackActive === true
        || (record.pendingRecoveries instanceof Map && record.pendingRecoveries.size > 0)
        || (Array.isArray(record.gatedRecoveryFeedbacks) && record.gatedRecoveryFeedbacks.length > 0);
      const hasOutput = turnHasNonEmptyText(events, turn);
      const outcome = classifyTurnOutcome(reason, hasOutput);
      // B2：turn 消息归属 = 事件日志 user/message ∪ claimed 认领映射（并集）。
      const turnMsgIds = messageIdsOfTurnWithClaimed(record.claimed, events, turn);
      // 该 turn 是恢复指令触发的 turn（turn 内包含恢复消息）：找到对应 op 并
      // 完结（done）。恢复 turn 再次失败时，下面按正常规则创建新 op 并继承
      // 已完结 op 的 taskKeys。
      let finishedOp;
      if (record.pendingRecoveries.size > 0) {
        finishedOp = findRecoveryOpByMessage(record.pendingRecoveries, turnMsgIds);
        if (finishedOp !== void 0) {
          // 成功/失败 turn 完结对应 op 时先清掉残留 timer；clear helper 只触碰
          // 该 op，迟到 callback 还会因取消标记与 pending guard 双重失效。
          clearRecoveryOpTimer(finishedOp);
          record.pendingRecoveries.delete(finishedOp.id);
          finishedOp.done = true;
        }
      }
      // 非法历史值按 0 次保守归一，避免字符串拼接或越界 count 产生无策略 timer。
      const currentRecoveryCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
        ? record.recoveryCount : 0;
      // 请求级 retry 已耗尽时，turn/end 只是同一次模型失败的终态；不能再把
      // child continuation 当成另一轮失败计数，否则一次故障会消耗两套预算。
      const requestRetryExhausted = requestRetryStateIsExhausted(record.agent, session, turn);
      // 等待被取消时仍需清理任务/范围，但不得给原 child 再投递自动恢复。
      const willRecover = allowRecovery === true
        && requestRetryExhausted !== true
        && outcome === "recoverable"
        && shouldAutoRecover(reason, hasOutput, currentRecoveryCount);
      if (outcome === "success") {
        // 任一成功 turn：连续恢复计数清零（父代理正常 steer 的新任务同样适用）。
        record.recoveryCount = 0;
      } else if (willRecover) {
        record.recoveryFeedbackActive = true;
        record.recoveryFeedbackTerminal = false;
        record.recoveryFeedbackTerminalTurn = void 0;
        record.recoveryCount = currentRecoveryCount + 1;
      }
      // S1-C：把本次 turn 的结局回写到任务绑定。恢复 turn（有 finishedOp）用
      // 其继承的 taskKeys 定位原任务；普通 turn 按消息 id 反查。确定失败返回
      // 的 taskKey 立即 forgetTask（相同 prompt 可重新排队而非永久 reused）；
      // P5：forget 必须带 child 身份保护（route 切换后旧 child 的失败不误删
      // 新 route 同名任务指纹）。
      const failedKeys = applyTurnToTasks(
        record.tasks, events, turn, turnMsgIds,
        outcome === "success" ? "success" : willRecover ? "recoverable" : "failed",
        reason,
        recovery.failureMessage(record, reason, session),
        finishedOp !== void 0 ? [...finishedOp.taskKeys] : void 0,
      );
      for (const key of failedKeys) forgetTaskIfCurrentChild(record, key);
      // 成功或确定失败才撤销活动范围；可恢复 turn 必须保留登记直到恢复链终态。
      const terminalTaskKeys = outcome === "success"
        ? taskKeysForTurn(record.tasks, turnMsgIds, finishedOp !== void 0 ? [...finishedOp.taskKeys] : void 0)
        : willRecover ? [] : failedKeys;
      // P1：按独立 admission messageId 优先匹配，不再依赖 record.tasks 是否尚未
      // 被 TASK_BINDING_LIMIT 淘汰；taskKey 只用于消息关联尚未回填时的兜底。
      if (outcome === "success" || !willRecover) {
        delegationTracker.completeActiveTasksForTurn({
          parentId: record.parentId,
          role: record.role,
          childId: record.childId,
          turnMsgIds,
          taskKeys: terminalTaskKeys,
        });
      }
      if (!willRecover && hadRecoveryFeedback) {
        // 活动范围已在最终分支先终态化；现在才允许唯一 settlement 交接，旧
        // recoverable 失败通知已经由 releaseGatedRecoveryFeedback 丢弃。
        record.recoveryFeedbackActive = false;
        releaseGatedRecoveryFeedback(record, turn);
      }
      if (willRecover) {
        // B4：为本次恢复创建独立 op，把绑定到该 turn 且进入 waitingRecovery 的
        // 记录恢复 op 后再 dispatch——并发恢复互不串链、互不重复。
        // 普通新任务与自动恢复交错时都经统一 helper 投递；恢复保持 interrupt=false。
        const op = createRecoveryOp(++recoveryOpSeq, turn);
        // S1-C：恢复链传播——新 op 继承已完结 op 的 taskKeys（不要丢）；
        // 首个 op 从触发 turn 的消息 id 反查 record.tasks 填入原任务 key。
        if (finishedOp !== void 0) {
          for (const key of finishedOp.taskKeys) op.taskKeys.add(key);
          // 前一个 recovery op 已把活动项关联到当前恢复消息；显式继承其 id，
          // 即使当前 Session 日志或 record.tasks 已被淘汰也不丢范围生命周期。
          for (const activityId of finishedOp.activityIds ?? []) op.activityIds.add(activityId);
        } else {
          for (const [key, binding] of record.tasks) {
            if (typeof binding?.messageId === "string" && turnMsgIds.has(binding.messageId)) op.taskKeys.add(key);
          }
        }
        // P1：从当前 turn 的 stable messageId 捕获活动项。taskKeys 只补早期
        // admission/claimed 竞态尚未写入 messageId 的少数情况。
        for (const activityId of delegationTracker.activeTaskIdsForTurn({
          parentId: record.parentId,
          role: record.role,
          childId: record.childId,
          turnMsgIds,
          taskKeys: op.taskKeys,
        })) op.activityIds.add(activityId);
        record.pendingRecoveries.set(op.id, op);
        // P1：恢复 timer 到期后仍经 queueMicrotask，避开当前 Session append 发布栈。
        // timer 只负责等待与一次性唤醒；manager sendMessage、admission 和 scope barrier
        // 继续由原 dispatchRecovery 处理，不阻塞 session/event 监听器。
        scheduleRecoveryDispatchTimer(record, session, reason, op);
      }
    }

    /**
     * 安全 forgetTask（P5）：全文唯一允许调用 delegationTracker.forgetTask 的
     * 入口——仅当 scope 当前记录的 child 仍是 record 所属 child（childId 一致）
     * 时才 forget：旧 route child 的迟到失败不得删除新 route 同名任务指纹
     * （route 切换后 delegationTracker 的 child 已换成新 child、tasks 已重建）。
     * @param {object} record - 恢复记录（含 childId/parentId/role）。
     * @param {string} taskKey - 要 forget 的归一化任务 key。
     * @returns {boolean} 确实 forget 返回 true；身份不匹配或非法输入返回 false。
     */
    function forgetTaskIfCurrentChild(record, taskKey) {
      if (record === null || typeof record !== "object") return false;
      const scope = delegationScopeKey(record.parentId, record.role);
      // 多 child 语义：归属判定优先看「这个任务 key 绑定的 child」，而不是「本 scope
      // 最近一个 child」——同 route 下并存的独立 child 各自持有自己的任务指纹，较早
      // child 的确定失败同样必须能 forget 它自己的任务（否则相同 prompt 会被永久
      // 判为 reused 并等一个永远不会结算的 turn）。
      const bound = delegationTracker.getTaskChild(scope, taskKey);
      const owner = bound !== void 0 ? bound.childId : delegationTracker.getChild(scope)?.childId;
      if (!shouldForgetTask(owner, record.childId)) return false;
      return delegationTracker.forgetTask(scope, taskKey);
    }

    /**
     * 恢复投递失败时把 op 对应的原任务写成确定失败并安全 forgetTask（P4）：
     * 任务绑定也必须终态化（outcome:"failed"
     * + 投递失败文案），否则后续相同 prompt 会被判定 reused 并等待一个永远
     * 不会结算的 turn；forget 走 forgetTaskIfCurrentChild（P5 身份保护）。
     * 只处理 op.taskKeys 继承的原任务（恢复链跨 op 传播，S1-C）；op 无继承
     * key 时（绑定已被上限淘汰等）为 no-op。
     */
    function failRecoveryOpTasks(op, record, reason, message) {
      const failedKeys = op?.taskKeys instanceof Set
        ? applyTurnToTasks(record.tasks, void 0, 0, void 0, "failed", reason, message, [...op.taskKeys])
        : [];
      for (const key of failedKeys) {
        forgetTaskIfCurrentChild(record, key);
      }
      // P1：恢复 op 创建时已捕获精确 activityIds。即使同 child 又出现相同
      // taskKey 的新任务，也只能清理本恢复链指向的旧活动项；不再按 key 扩大删除。
      delegationTracker.completeActiveTasksByIds(op?.activityIds);
    }

    const RECOVERY_SUPERSEDED_MESSAGE = "自动恢复已被新任务取代 (superseded by a newer task)";

    /**
     * 新任务到达时失效尚未被 manager 接受的自动恢复 op。只有 op 尚未
     * dispatching 且 accepted/messageId 均为空时才可取代；同 scope 的
     * dispatchRecovery 会在同一 tracker 临界区内把 sendMessage 返回的 messageId
     * 同步写入 accepted，因而不会留下「已接受但回调尚未来得及写回」窗口。
     * 先从 pending 表摘除并标记 done，再 abort controller，令迟到回调通过
     * pending 检查自然丢弃。调用方必须只在新消息/新 child 已成功 admission
     * 后调用本函数；signal 或 admission 失败不得提前取代旧 recovery。
     */
    function supersedePendingRecoveryOps(record) {
      if (record?.pendingRecoveries instanceof Map === false) return 0;
      let count = 0;
      for (const op of [...record.pendingRecoveries.values()]) {
        if (!recoveryOpCanBeSuperseded(op)) continue;
        // 关闭 pending admission 之后再 abort；先清 timer，迟到 callback 不能复活 op。
        clearRecoveryOpTimer(op);
        op.done = true;
        record.pendingRecoveries.delete(op.id);
        if (op.controller !== void 0) op.controller.abort();
        const supersededKeys = supersedeTaskBindings(
          record.tasks,
          op.taskKeys,
          RECOVERY_SUPERSEDED_MESSAGE,
        );
        for (const key of supersededKeys) {
          forgetTaskIfCurrentChild(record, key);
        }
        // 任务 binding 已淘汰时 supersededKeys 为空，仍必须清掉该 op 所有稳定
        // 活动关联；activityIds 是唯一清理依据，避免同 key 新活动被误删。
        delegationTracker.completeActiveTasksByIds(op.activityIds);

        count += 1;
      }
      return count;
    }

    /**
     * 向既有 child 投递一条父代理消息。RC1 的公开 continuation seam 是
     * subagents.sendMessage；interrupt 只负责请求取消当前轮次，不能替代消息 admission。
     * 因此 running、idle、cold 三种状态都由 manager 统一处理 parent admission、lineage、
     * disposal 与 signal cutoff，插件不直接操作 child Agent 的内部 steer/whenIdle。
     * @param {object} options - 投递参数。
     * @param {object} options.parent - 确切的在线父代理。
     * @param {string} options.childId - 目标 child session id。
     * @param {Array} options.content - 要投递的消息内容块。
     * @param {AbortSignal} [options.signal] - 调用方取消信号。
     * @param {boolean} options.interrupt - 是否先请求中断 child 当前轮次。
     * @param {boolean} [options.queue=false] - 保留兼容输入；消息始终经公开 sendMessage admission。
     * @returns {Promise<string>} 被接受消息的 id。
     */
    async function sendMessageToExistingChild({ parent, childId, content, signal, interrupt, queue = false, rootToken }) {
       const assertLiveRoot = () => {
         if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
       };
       assertLiveRoot();
      // 在任何 interrupt 或消息构造之前检查取消，避免取消后的副作用投递。
      if (signal?.aborted === true) {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }
      const send = async () => {
        assertLiveRoot();
        const messageId = await subagents.sendMessage(parent, childId, content, { signal });
        assertLiveRoot();
        if (typeof messageId !== "string" || messageId.length === 0) throw new Error("existing child sendMessage returned an invalid messageId");
        return messageId;
      };
      if (interrupt === true) {
        // interrupt 只请求取消，不等待内部 Agent 状态；后续消息仍必须经公开
        // sendMessage，让 RC1 manager 负责 admission、lineage、cold resume 与 disposal。
        try {
          subagents.interrupt(childId, { kind: "ancestor", agent: parent });
        } catch (error) {
          // 目标已失活时允许 manager 接管；权限、排空、取消和未知错误仍原样传播。
          if (interruptFailureCanFallback(error)) return send();
          throw error;
        }
      }
      return send();
    }

    /**
     * 结束一个未被 manager 接受的 recovery op，并结算其原任务。
     * 调用方位于 scope 临界区内；先摘除 pending，再标记 done，避免 abort 或
     * 迟到回调重入时把失败 op 当作仍可用。
     */
    function failPendingRecoveryOp(op, record, reason, message) {
      if (!recoveryOpIsPending(record?.pendingRecoveries, op)) return false;
      // sendMessage/rebuild/admission 失败都走同一清理点；重复 clear 是幂等的。
      clearRecoveryOpTimer(op);
      op.dispatching = false;
      record.pendingRecoveries.delete(op.id);
      op.done = true;
      // 失败收口也终止 manager sendMessage 的 signal；正常 rejection 时虽已结算，
      // 该调用仍保证意外残留的异步工作不会继续占用恢复记录。
      if (op.controller !== void 0) op.controller.abort();
      // 所有恢复投递/重建失败入口统一在这里附加累计次数。message 保留调用方
      // 的底层 detail，formatter 幂等，嵌套失败收口不会重复写「已自动重试」。
      const failureMessage = appendRecoveryRetryCount(message, record.recoveryCount);
      failRecoveryOpTasks(op, record, reason, failureMessage);
      if (record.recoveryFeedbackActive === true
        || (Array.isArray(record.gatedRecoveryFeedbacks) && record.gatedRecoveryFeedbacks.length > 0)) {
        // sendMessage/rebuild 失败没有新的 child turn 可触发终态；op 已释放 activity 后，
        // 仍要把恢复链收口到最多一个已撤回 settlement。
        record.recoveryFeedbackActive = false;
        releaseGatedRecoveryFeedback(record, void 0);
      }

      return true;
    }

    /**
     * 原 child 不可续接或 route 已改变时，按原 parent/role/模型路由重建一个
     * continuable child。只迁移触发本次恢复 op 的任务绑定；其他 host/权限错误
     * 不会进入此路径，仍由 dispatchRecovery 的既有失败收口反馈给调用方。
     */
    async function rebuildRecoveryChild(op, record, parent, reason) {
      const rootToken = host.lineage.tokenOf(parent);
      if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      const source = recovery.contextFor(record, op);
      const promptText = recovery.promptFor(record, op);
      if (source === void 0 || typeof promptText !== "string" || promptText.length === 0) {
        throw new Error("cannot rebuild recovery child because the original task context is unavailable");
      }
      if (typeof source.provider !== "string" || typeof source.model !== "string") {
        throw new Error("cannot rebuild recovery child because its original model route is unavailable");
      }
      // 角色必须已注册：未注册角色连默认 persona 都没有，重建出来的 child 会失去
      // 全部角色约束，因此这里 fail-closed，而不是回落到某个通用人格。
      if (ROLE_META[record.role] === void 0) throw new Error("cannot rebuild recovery child because its expert role is unavailable");
      const oldChildId = record.childId;
      const request = {
        label: source.label,
        prompt: [{ type: "text", text: buildExpertTaskPrompt(record.role, promptText) }],
        parent,
        agentOptions: {
          provider: source.provider,
          model: source.model,
          [EFFORT_MARKER]: source.reasoningEffort,
          [ROLE_MARKER]: record.role,
          [PARENT_MARKER]: record.parentId,
          [CONTINUABLE_MARKER]: true,
        },
        // 路由仍沿用 source 的 provider/model，但 persona 必须在 admission 边界重新解析：
        // 恢复是"新建 child"的一条路径，因此既不能复用旧快照，也不能跳过用户覆盖
        // 与固定纪律的分层（纪律升级后同样必须立刻生效）。
        persona: resolvePersonaForAdmission(record.role),
        toolFilter: { deny: ensureExpertSendMessageDenied(source.toolFilter) },
        maxDepth: source.maxDepth ?? 1,
      };
      const pending = { parent: record.parentAgent, parentId: record.parentId, role: record.role, record, op };
      recovery.queueRebuild(pending);
      let childId;
      let messageId;
      try {
        ({ childId, messageId } = await subagents.startContinuable({
          provider: "spawn",
          label: source.label,
          request,
          signal: op.controller?.signal,
        }));
        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      } catch (error) {
        recovery.removeRebuild(pending);
        throw error;
      }
      recovery.removeRebuild(pending);
      // P2：agent/created 或 startContinuable resolve 都可能晚于父销毁/插件卸载。
      // 在任何 record 迁移、scope 写回、任务/activity 绑定前再次验证生命周期；
      // manager 已接受的迟到 child 保持宿主侧终态，不允许插件复活已清理状态。
      if (!recoveryRebuildCanCommit(recoveryRecords, record, op)) {
        ctx.logger.warn(`dsh-expert-group: ignoring late recovery rebuild result for child ${oldChildId}`);
        return void 0;
      }
      if (typeof childId !== "string" || childId.length === 0 || typeof messageId !== "string" || messageId.length === 0) {
        throw new Error("replacement continuable child did not return a valid childId and messageId");
      }
      // agent/created 通常已迁移 record；若宿主事件未同步发出，返回后兜底迁移。
      // acceptance 返回的 Agent 仍是插件实际创建的对象，必须登记到 global guard 身份表。
      registerPluginExpertChildAgent(agents.get(childId));
      if (record.childId !== childId) moveRecoveryRecordToChild(record, childId);
      const scope = delegationScopeKey(record.parentId, record.role);
      const current = delegationTracker.getChild(scope);
      // cold-resume 可能从未写入 tracker scope（current === undefined）；应把成功
      // 替代 child 安装为当前 child。若并发新任务已安全改为别的 child，则保持它。
      if (shouldInstallRebuiltChild(current?.childId, oldChildId)) {
        delegationTracker.setChild(scope, { childId, routeKey: source.routeKey });
      }
      const taskKeys = [...op.taskKeys];
      delegationTracker.rebindActiveTasks({
        parentId: record.parentId,
        role: record.role,
        oldChildId,
        newChildId: childId,
        messageId,
        taskKeys,
        activityIds: op.activityIds,
      });
      for (const taskKey of taskKeys) {
        const binding = record.tasks.get(taskKey);
        if (binding !== void 0) {
          binding.childId = childId;
          binding.messageId = messageId;
          binding.pendingMessage = false;
        }
      }
      return messageId;
    }

    function retryRecoveryDispatchAfterFailure(op, record, session, reason, error) {
      if (!recoveryOpIsPending(record?.pendingRecoveries, op) || recoveryOpIsAccepted(op)) return false;
      const parent = record.parentAgent;
      const rootToken = host.lineage.tokenOf(parent);
      if (!host.lineage.isLiveGeneration(parent, rootToken) || recovery.isTerminalDispatchError(error)) return false;
      const currentCount = Number.isSafeInteger(record.recoveryCount) && record.recoveryCount >= 0
        ? record.recoveryCount : 0;
      if (currentCount >= AUTO_RECOVERY_LIMIT) return false;
      clearRecoveryOpTimer(op);
      op.dispatching = false;
      op.done = true;
      record.pendingRecoveries.delete(op.id);
      if (op.controller !== void 0) op.controller.abort();
      const retry = createRecoveryOp(++recoveryOpSeq, op.triggerTurn);
      for (const key of op.taskKeys ?? []) retry.taskKeys.add(key);
      for (const activityId of op.activityIds ?? []) retry.activityIds.add(activityId);
      record.recoveryCount = currentCount + 1;
      record.recoveryFeedbackActive = true;
      record.pendingRecoveries.set(retry.id, retry);
      ctx.logger.warn("dsh-expert-group: transient recovery delivery failure; retrying: " + (error instanceof Error ? error.message : String(error)));
      scheduleRecoveryDispatchTimer(record, session, reason, retry);
      return true;
    }


    /**
     * 以父代理身份发出一条自动恢复指令。该函数只由同一 parent+role 的
     * delegationTracker.serialize 临界区调用，且会等待 manager sendMessage 返回
     * accepted messageId 后才结束临界区。这样普通新任务不能在消息已接受、
     * 但旧 .then 回调尚未运行的窗口 supersede 该 op。
     */
    async function dispatchRecovery(op, record, session, reason) {
      // turn/end 后通过 queueMicrotask 延迟到这里时，记录可能已经因卸载、父销毁
      // 或 route 清理而被移除；此时不得再向 child 发送无任务归属的幽灵消息。
      if (!recoveryOpIsPending(record.pendingRecoveries, op) || recoveryOpIsAccepted(op)) return;
      const parent = record.parentAgent;
      if (!isLiveRootAgent(parent) || agents.get(record.parentId) !== parent) {
        ctx.logger.warn(`dsh-expert-group: auto-recovery skipped for child ${session.id}: parent ${record.parentId} is not live`);
        failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：父代理已不可用");
        return;
      }
      const controller = new AbortController();
      op.controller = controller;
      op.dispatching = true;
      let messageId;
      const scope = delegationScopeKey(record.parentId, record.role);
      const current = delegationTracker.getChild(scope);
      // 多 child 语义：scope.current 只是「本 scope 最近一次新建/恢复的 child」，它可能
      // 是另一个独立任务的 child。同一个 route 下另一个 child 的自动恢复**不是**route
      // 变更，必须继续向 record 自己的 child 投递恢复消息；只有 route 真的变了（或记录
      // 没有 route 信息、只能退回 child 身份比较的旧记录）才走重建。
      const routeChanged = current !== void 0
        && (record.routeKey !== void 0 ? current.routeKey !== record.routeKey : current.childId !== record.childId);
      try {
        if (shouldRebuildRecoveryChild(void 0, { routeChanged })) {
          // route 改变时不再向旧 child sendMessage，直接以保存的原 route 重建。
          messageId = await rebuildRecoveryChild(op, record, parent, reason);
        } else {
          // 此 await 必须发生在 scope 锁内：sendMessage resolve 即 manager acceptance 边界。
          messageId = await sendMessageToExistingChild({
            parent,
            childId: session.id,
            content: [{ type: "text", text: buildRecoveryMessage(reason) }],
            signal: controller.signal,
            rootToken: host.lineage.tokenFor(parent),
            // 自动恢复交给 manager sendMessage，统一处理 admission/lineage/disposal。
            interrupt: false,
            queue: false,
          });
        }
      } catch (error) {
        if (!recoveryOpIsPending(record.pendingRecoveries, op)) {
          op.dispatching = false;
          return;
        }
        // 容量耗尽：不重建（撞上限时重建必然再失败），也不按原样上抛原始码。
        // 这是暂态条件——等某个子代理结束后重试即可成功，因此仍走既有带预算的
        // 重试通道，只是把用户可见文案换成可读提示。
        if (isSubagentCapacityError(error)) {
          ctx.logger.warn(`dsh-expert-group: auto-recovery deferred for child ${session.id}: subagent capacity reached`);
          if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, error)) {
            failPendingRecoveryOp(op, record, reason, `自动恢复指令投递失败：${SUBAGENT_CAPACITY_MESSAGE}`);
          }
          return;
        }
        if (!routeChanged && shouldRebuildRecoveryChild(error)) {
          try {
            messageId = await rebuildRecoveryChild(op, record, parent, reason);
          } catch (rebuildError) {
            const detail = rebuildError instanceof Error ? rebuildError.message : String(rebuildError);
            ctx.logger.warn(`dsh-expert-group: auto-recovery rebuild failed for child ${session.id}: ${detail}`);
            if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, rebuildError)) {
              failPendingRecoveryOp(op, record, reason, `自动恢复 child 重建失败：${detail}`);
            }
            return;
          }
        } else {
          const detail = error instanceof Error ? error.message : String(error);
          ctx.logger.warn(`dsh-expert-group: auto-recovery sendMessage failed for child ${session.id}: ${detail}`);
          if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, error)) {
            failPendingRecoveryOp(op, record, reason, `自动恢复指令投递失败：${detail}`);
          }
          return;
        }
      }
      // 下面没有 await：在释放同 scope 锁前原子记录 acceptance 和 claimed 占位。
      if (!recoveryOpIsPending(record.pendingRecoveries, op)) {
        op.dispatching = false;
        return;
      }
      if (typeof messageId !== "string" || messageId.length === 0) {
        const invalidMessageError = new Error("manager 未返回有效 messageId");
        if (!retryRecoveryDispatchAfterFailure(op, record, session, reason, invalidMessageError)) {
          failPendingRecoveryOp(op, record, reason, "自动恢复指令投递失败：manager 未返回有效 messageId");
        }
        return;
      }
      op.accepted = true;
      op.messageId = messageId;
      op.dispatching = false;
      // P1：恢复消息成为同一活动项新的稳定终态关联。sendMessage 仍在同
      // child，rebuild 已改为替代 child；二者都通过 activityIds 精确更新。
      delegationTracker.rebindActiveTasks({
        parentId: record.parentId,
        role: record.role,
        oldChildId: record.childId,
        newChildId: record.childId,
        messageId,
        taskKeys: op.taskKeys,
        activityIds: op.activityIds,
      });
      rememberClaimedPlaceholder(record.claimed, messageId);
      evictOldestEntries(record.claimed, CLAIMED_LIMIT);
    }

    /** legacy relay 诊断去重集合（B）：按 child 去重，上限防止 legacy host 刷日志。 */
    const relayFeedbackWarnings = new Set();
    const RELAY_FEEDBACK_WARN_LIMIT = 64;

    /**
     * legacy relay（`subagent-report`）fail-closed 的诊断出口（B）。
     *
     * 每个 child 只 warn 一次，并用集合上限兜底，避免 legacy host 每轮投递都刷日志。
     * 只做诊断，不参与任何 handoff 决策。
     *
     * @param {string|undefined} childId - relay 的 senderSessionId（仅用于归因）。
     */
    function warnLegacyRelayFailClosed(childId) {
      if (relayFeedbackWarnings.size >= RELAY_FEEDBACK_WARN_LIMIT) return;
      const key = typeof childId === "string" && childId.length > 0 ? childId : "<unknown-child>";
      if (relayFeedbackWarnings.has(key)) return;
      relayFeedbackWarnings.add(key);
      ctx.logger.warn("dsh-expert-group: legacy subagent-report feedback has no settlement correlation id"
        + " (child " + key + "); keeping the admission fail-closed and treating it as an ordinary message");
    }

    // 触发通道 1：父 Agent 的 inbox 注入是精确完成通知的到达边界。
    // DSH 先处理 child turn/end，随后把 subagent-settled feedback 注入父 inbox；
    // 只有 exact root Agent 收到匹配 senderSessionId 的**标准 notice** 才释放对应 child 原因。
    //
    // B：legacy `subagent-report`(form=relay) 没有 correlation id（不同 message.id、无
    // turn/admission 关联），无法证明它属于哪一轮 admission。Oracle 已确认 core 当前只铸
    // `subagent-settled`(form=notice) 的 UUID settlement，relay 仅来自 legacy session-format
    // 迁移。若把 relay 当作合法 handoff feedback 消费，迟到的 relay 会绑定**下一轮**的
    // arrival snapshot，等下一轮 turn/end 时提前 resume（跨轮误释放）。因此在没有可靠
    // correlation id 之前一律 fail-closed：不撤回、不排队、不消费、不释放 handoff，
    // 只留一条按 child 去重的可诊断 warn；消息本身仍作为普通注入消息留在父 inbox
    // （不伪造交接，也不改变正文）。
    /**
     * 处理一条父 inbox 反馈。agent/inbox/inserted 与 session/event 的
     * agent/inbox/spliced 都必须进入同一条路径，避免只覆盖测试夹具能合成的事件。
     * 文本宿主通知仅作为 child 身份线索；后续仍由当前 root、activation、turn/end
     * 和 cohort 的既有门控决定是否可以结算，绝不凭正文直接释放等待。
     */
    function handleInboxFeedback(agent, message, sourceEvent = "agent/inbox/inserted", deliveryId, receipt = void 0) {
      // inserted 是 core 唤醒 root 前的同步边界；spliced 在 session/event 中已脱离该
      // 发布栈，因此仍先做相同的 user / recovery 身份检查，再把 handoff 写入 microtask。
      // spliced 是已进入 next-step 的注入项，不是新的用户输入边界；其中即使带 user
      // source 也不能被当作 waiter 取消信号。
      if (message?.source?.kind === "user" && sourceEvent === "agent/inbox/inserted") cancelRootTurnWaitForUserInput(agent);
      if (message?.source?.kind === "subagent-report") {
        const relayChildId = message.source.senderSessionId;
        warnLegacyRelayFailClosed(typeof relayChildId === "string" ? relayChildId : void 0);
        return;
      }
      const childId = subagentFeedbackChildId(message, {
        allowSourceLess: sourceEvent === "agent/inbox/spliced" && typeof deliveryId === "string",
      });
      if (childId !== void 0) {
        const record = recoveryRecords.get(childId);
        if (record?.parentAgent === agent) {
          if (isCurrentRecoveryFeedbackIdentity(agent, record, childId)) {
            if (gateRecoverableHandoffFeedback(agent, record, childId, message)) return;
            // terminal feedback 可能对应一个已完成但未绑定到 turn/messageId 的 child turn。
            // 只有没有待恢复 op 时才释放，避免把可恢复失败的 activity 提前清掉。
            const sourceLessHostNotice = sourceEvent === "agent/inbox/spliced"
              && message?.source === void 0 && typeof deliveryId === "string";
            if (!sourceLessHostNotice && record.pendingRecoveries?.size === 0
              && record.recoveryFeedbackActive !== true
              && (record.gatedRecoveryFeedbacks?.length ?? 0) === 0) {
              releaseActiveExpertScope(agent, { childId, role: record.role });
            }
          } else {
            // 当前 registry/activation 已指向 replacement 时，这是一条无法证明属于
            // 当前 generation 的旧 notice；不能进入普通 handoff release 路径。
            return;
          }
        }
      }
      queueMicrotask(() => {
        try {
          if (!isLiveRootAgent(agent)) return;
          const gatedChildId = subagentFeedbackChildId(message, {
            allowSourceLess: sourceEvent === "agent/inbox/spliced" && typeof deliveryId === "string",
          });
          if (gatedChildId === void 0 || wasGatedRecoveryFeedback(agent, gatedChildId, message?.id, message)) return;
          const childId = gatedChildId;
          const sourceLessHostNotice = sourceEvent === "agent/inbox/spliced"
            && message?.source === void 0 && typeof deliveryId === "string";
          markPendingHandoffFeedback(agent, childId, message, deliveryId, sourceLessHostNotice, receipt);
          // 命中与否都重跑精确结算；未命中时只是幂等空操作，不会结算其他 token。
          settleFinishedChildTurnWaits(agent);
        } catch (error) {
          ctx.logger.warn("dsh-expert-group: " + sourceEvent + " handoff handler failed: " + (error instanceof Error ? error.message : String(error)));
        }
      });
    }

    ctx.on("agent/inbox/inserted", ({ agent, message }) => {
      handleInboxFeedback(agent, message);
    });

    // 触发通道 2：session/event 的 child turn/end 仍只负责终态结算；root turn/end 才是
    // 终止快照的唯一提交点。microtask 避开 Session.append 发布重入，并在执行前校验
    // exact root Agent/Session/generation 身份。
    ctx.on("session/event", (session, event) => {
      // C：在**同步入口**取得本次事件的接收序号。它是插件内部唯一的到达顺序权威，
      // 后续所有 microtask 处理只能使用这个快照（见 nextSessionEventReceipt）。
      const receipt = nextSessionEventReceipt();
      // 某些宿主只发布 session/event 而不经过 inbox/inserted；在进入 microtask 前同步
      // 取消 root waiter，保证 user/message 与 ask_user_question 的 role=user 都能打断旧 turn。
      const immediateAgent = typeof session?.id === "string" ? agents.get(session.id) : void 0;
      const isUserInput = (event?.type === "user/message" && event.data?.source?.kind === "user")
        || (event?.type === "tool/result" && event.data?.message?.role === "user");
      if (isUserInput && immediateAgent?.session === session) cancelRootTurnWaitForUserInput(immediateAgent);
      // C：source-less 完成通知的同步接收边界快照（exact root/session、child activation、
      // 未消费 token 快照、接收序号）。异步消费只允许使用这个快照的交集，且必须满足
      // 「exact turn/end 接收顺序更早」——后续只能收紧，不能扩大。
      const noticeReceipts = typeof session?.id === "string"
        ? captureSourceLessNoticeReceipts(immediateAgent, session, event, receipt) : void 0;
      queueMicrotask(() => {
        try {
        if (typeof session?.id !== "string") return;
        // completion 事件先交给 fan-out；未识别的 fan-out marker 不应落入旧
        // recoveryRecords 路径，避免同一 child 被双重结算或自动续跑。
        if (fanoutHost?.handleSessionEvent(session, event) === true) return;
        const liveAgent = agents.get(session.id);
        const record = recoveryRecords.get(session.id);
        if (record !== void 0) {
          // dispose 后 liveAgent/activation 可能已缺失，由 helper 依据 record 的 exact
          // Agent/Session 继续处理；若 replacement 仍在任一映射中则严格拒绝旧 event。
          if (!isCurrentRecoverySessionIdentity(record.parentAgent, record, session)) return;
          // 首个 exact event 建立 session 引用；之后旧 Session 事件不得接管 record。
          bindRecoverySession(record, session);
        }
        if (event?.type === "agent/inbox/spliced"
          && event.data?.target === "next-step"
          && liveAgent?.session === session
          && isLiveRootAgent(liveAgent)
          && Array.isArray(event.data?.inserted)) {
          // 真实 Host 将自动完成消息作为 root session event 发布，而不是 guaranteed 的
          // agent/inbox/inserted。只桥接 next-step 的 inserted 消息，并复用同一 exact
          // feedback 状态机；固定文本本身绝不构成释放条件。
          // seq 缺失时 source-less 通知必须 fail-closed；它不能借正文冒充 admission。
          const deliveryId = Number.isSafeInteger(event.seq)
            ? "session-event:" + session.id + ":" + String(event.seq) : void 0;
          for (let index = 0; index < event.data.inserted.length; index += 1) {
            const inserted = event.data.inserted[index];
            const message = inserted?.message !== undefined ? inserted.message : inserted;
            // receipt 与 inserted 同下标对齐：同步入口为每条 source-less 注入固化的到达快照。
            handleInboxFeedback(liveAgent, message, "agent/inbox/spliced", deliveryId, noticeReceipts?.[index]);
          }
          return;
        }
        if (event?.type === "step/start" && liveAgent?.session === session && isLiveRootAgent(liveAgent)) {
          // turn/end 之后同一 turn 又开始新 step，说明 listener 通过 steer 续接了本次运行：
          // 刚写入的终止快照并不成立，必须撤销，否则会误报"已中断/已完成"。
          // generation 显式声明后，notifications 侧会强校验代际：旧代际 root 的迟到
          // step/start 无法撤销新代际刚发布的终止快照（上游的 exact Agent/Session
          // 守卫之外的第二道防线）；generationOf 未登记时返回 undefined，保持兼容语义。
          notificationHost.revokeTermination({
            rootId: liveAgent.id,
            turn: event.data?.turn,
            generation: rootGenerationRegistry.generationOf(liveAgent.id),
          });
          return;
        }
        if (event?.type === "turn/end" && liveAgent?.session === session && isLiveRootAgent(liveAgent)) {
          commitRootTerminationSnapshot(liveAgent, session, event);
          return;
        }
        if (event?.type === "tool/result" && liveAgent?.session === session && isLiveRootAgent(liveAgent)
          && event.data?.message?.role === "user" && pendingRootUserWait(liveAgent, rootGenerationRegistry.generationOf(liveAgent.id)).length > 0) {
          // ask_user_question/exit_plan_mode 的回答落在 tool/result（role=user），不是普通 user/message。
          // 用户的这次回答同样是新的用户运行边界：释放等待并开启新的 root run。
          notificationHost.beginRootRun({
            rootId: liveAgent.id,
            generation: rootGenerationRegistry.generationOf(liveAgent.id),
          });
          clearRootUserWait(liveAgent, session);
          return;
        }
        if (event?.type === "user/message") {
          // 只把真实 user source 当作回答；插件/manager 注入的 user/message
          // 不能误释放 ask_user_question/exit_plan_mode 的等待原因。
          const sourceKind = event.data?.source?.kind;
          if (sourceKind === "user"
            && liveAgent?.session === session
            && isLiveRootAgent(liveAgent)) {
            // 延迟 microtask 中必须确认事件仍属于当前 root Session；同 id 新 root
            // 不能被旧代际 user/message 误当作本次等待的用户回答。
            clearRootUserWait(liveAgent, session);
            // 真实用户输入开启新的 root run：为「已在运行、但本进程还没有登记等待」的
            // fan-out 任务补登记。判定完全基于当前事实，重复触发是幂等的。
            reconcileUnbarrieredFanoutHandoffs();
            // 真实用户输入开启新的 root run：只有这里会重置"本 run 至多一次"的终止
            // 通知资格。subagent-settled/agent-message 等注入消息不进入该分支，
            // 因此子代理结算回唤出的续接 turn 仍然属于同一 run，不会重复提示。
            notificationHost.beginRootRun({
              rootId: liveAgent.id,
              generation: rootGenerationRegistry.generationOf(liveAgent.id),
            });
          }
          return;
        }
        if (event?.type !== "turn/end" || record === void 0) return;
        if (recoveryRecords.get(session.id) !== record
          || !isCurrentRecoverySessionIdentity(record.parentAgent, record, session)) return;
        const admission = admissionForTurn(record, session, event, receipt);
        if (admission?.failed === true) {
          // 失败 admission 只结算自己的 turn，不能被同 child 的其他 token 拦截。
          consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
          removePendingHandoffAdmission(admission);
          return;
        }
        const immediateRecovery = childTurnNeedsImmediateRecovery(record, session, event);
        if (immediateRecovery) {
          // 原始 recoverable failure 与自动恢复 turn 都必须在此处立即进入现有
          // handleChildTurnEnd，创建/完结 recovery op；只把原 admission 的 handoff
          // bookkeeping 留在 pending，不能等待 parent feedback 才推进恢复链。
          consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
          if (admission !== void 0) deferChildTurnEnd(record, session, event, admission);
          return;
        }
        if (admission !== void 0) {
          // DSH 的 report/feedback 发布仍按原顺序交给 admission bookkeeping；
          // 但成功/确定失败的 exact activity 在此窗口先释放，避免 root guard
          // 因父 inbox 尚未消费而错误拦截同范围读取。
          releaseTerminalActivitiesBeforeHandoffFeedback(record, session, event, admission);
          deferChildTurnEnd(record, session, event, admission);
          return;
        }
        consumeChildTurnEnd(record.parentAgent, record, session, event, admission);
        } catch (error) {
          ctx.logger.warn("dsh-expert-group: turn/end recovery handler failed: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          // 成功 step/end 立即归零；请求预算耗尽则保留到 child turn/end 完成，
          // 让 handleChildTurnEnd 能抑制重复 continuation，随后由 turn/end 清除。
          clearRequestRetryStateForSessionEvent(session, event);
        }
      });
    });

    // 触发通道 2（B2 路径 B）：消息被 inbox 认领（claim）即记录 message.id -> turn。
    // 覆盖「user/message 落盘前发生 pre-step reject/取消/异常」的归属缺口——
    // 该 turn 里没有目标 user/message，messageIdsOfTurn 永远找不到归属。
    // payload 由 dsh-agent-loop 提供 { message, turn } 并附加 agent。
    // child 新 Activation 的 claimed 会重新写入，旧值按 messageId 覆盖即可；
    // record 生命周期内不清空（S2：上限 CLAIMED_LIMIT 条，超限按插入序淘汰最旧）。
    ctx.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      // claimed 可能在 Session.append 发布栈内到达；所有状态绑定延后处理。
      queueMicrotask(() => {
        try {
        if (typeof agent?.id !== "string" || typeof message?.id !== "string" || !Number.isSafeInteger(turn)) return;
        const record = recoveryRecords.get(agent.id);
        const activation = childActivationStates.get(agent.id);
        if (record === void 0 || record.agent !== agent || activation?.agent !== agent
          || (record.session !== void 0 && agent.session !== void 0
            && !sameDurableSessionId(record.session, agent.session, agent.id))) return;
        if (agent.session !== void 0) bindRecoverySession(record, agent.session);
        record.claimed.set(message.id, turn);
        evictOldestEntries(record.claimed, CLAIMED_LIMIT);
        // S1-D：任务 binding 的 acceptance 竞态补绑——当 claimed 消息 id 在
        // record.tasks 中找不到 binding 时（正常路径的 admission 回调晚于
        // inbox 认领事件），按消息文本归一化 key 匹配 pendingMessage 且
        // messageId 尚未确定的项并回填，保证 reused 能找到原任务。
        rebindPendingTaskByClaimed(record.tasks, message);
        bindHandoffAdmissionFromClaimed(agent, message.id);
        // P1：claim 可能早于 start/steer admission Promise 返回。把已经由 binding
        // 确认的 messageId 同步写入独立 activeTasks，后续 record.tasks 的 LRU
        // 淘汰不会影响按 turn/end 清理 affectedPaths 范围登记。
        for (const [taskKey, binding] of record.tasks) {
          if (binding?.messageId !== message.id) continue;
          delegationTracker.bindActiveTasksByTaskKey({
            parentId: record.parentId,
            role: record.role,
            childId: agent.id,
            taskKey,
            messageId: message.id,
          });
        }
        } catch (error) {
          ctx.logger.warn(`dsh-expert-group: inbox/claimed recovery handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    });

    // 插件卸载：清理恢复状态与全部活动范围，防止状态泄漏；
    // dropRecoveryRecord 内部会清理所有 pending op（B7）。
    ctx.effect(() => () => {
      turnWaitStopping = true;
      // 卸载：取消全部 root 的等待（等待者以 released:false 收口）、移除监听与引用。
      rootTurnWaits.dispose();
      rootWaitInvalidators.clear();
      fanoutTurnWaitRecords.clear();
      pendingChildTurnEnds.clear();
      // pendingHandoffAdmissions 只是 host 索引；cohort 另外持有 root/entry 引用，
      // 卸载时必须先遍历所有 known root 并清空共享 entries，再丢弃数组索引。
      for (const root of handoffAdmissionCohort.roots()) {
        handoffAdmissionCohort.clearRoot(root);
      }
      host.handoff.clear();
      failedHandoffChildren.clear();
      // WeakSet 无需强制 clear；不保留 root 强引用。


      childActivationStates.clear();
      for (const childId of [...recoveryRecords.keys()]) {
        dropRecoveryRecord(childId, "插件已卸载，等待被中止");
      }
    }, "dsh-expert-group: recovery registry");

    // ── 专家委派工具 ────────────────────────────────────────────────────────
    /** 已挂载角色对应的工具注销器；注册必须归当前 ctx Fiber 所有。 */
    const toolDisposers = new Map();

    /** spawn provider 是否具备本工具用到的全部能力：
     *  depthLimit（maxDepth 上限）、prepareContinuable（后台可继续）、
     *  persona 与 toolFilter（角色人格与只读约束）。 */
    function spawnProviderReady() {
      const provider = subagents.getProvider("spawn");
      if (provider === void 0) return false;
      const caps = provider.capabilities ?? {};
      return caps.depthLimit === true && caps.toolFilter === true && caps.persona === true && typeof provider.prepareContinuable === "function";
    }

    /**
     * 计算此刻应拒绝的工具名。
     * tools.restrict() 对“未知全局工具名”直接抛错，而 bash/pwsh 按平台门控、
     * workflow 属 agent preset（隔离域）注册，任何一项都可能不在当前组合里。
     * 因此这里动态过滤：只允许当前全局工具视图中的名称进入 deny；scope-local
     * 工具虽然可能出现在父代理视图中，但 tools.restrict() 不接受这类名称。
     * 这能避免子代理创建窗口把 scope-local 工具误传给全局限制校验。
     * @param parent - 调用工具的子代理父代理（Agent 对象）。
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
        return restrictableDenyNames(readonlyDenyCandidates(denyList, visibleSchemas), isVisible);
      }
      return restrictableDenyNames(denyList, isVisible);
    }

    /**
     * route 的稳定序列化 key：provider/model/reasoningEffort 三者任一变化
     * 都视为 route 改变（例如用户在侧边栏换了模型），既有 child 不可再复用。
     */
    function routeKeyOf(selection) {
      return JSON.stringify({
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort === void 0 ? null : selection.reasoningEffort,
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

    function buildFanoutFeedback(task) {
      const results = task.shards.map((shard) => {
        const attempt = shard.attempts[shard.attempts.length - 1] ?? {};
        return {
          shardId: shard.shardId,
          status: shard.status,
          attempt: attempt.attempt,
          ...(attempt.result === undefined ? {} : { result: attempt.result }),
          ...(attempt.error === undefined ? {} : { error: attempt.error }),
        };
      });
      const payload = { parentTaskId: task.parentTaskId, role: task.role, status: task.status, counts: task.counts, results };
      let serialized;
      try { serialized = JSON.stringify(payload, null, 2); } catch {
        // 结果理论上已按 attempt 预算校验过；这里仍兜底，避免反馈构造自身抛异常。
        serialized = JSON.stringify({ parentTaskId: task.parentTaskId, status: task.status });
      }
      // 只按 UTF-8 字节预算截断；不能先按字符切掉 source，否则 receivedBytes 会失真，
      // 也会让中文/emoji 在两个预算之间产生不可见的丢失。truncateFeedbackText 会保留
      // 原始输入字节数，并在截断结果中附带可按 parentTaskId 查询完整快照的提示。
      const head = "Fan-out 父任务已完成（wait-all）：\n";
      const trimmed = truncateFeedbackText(
        { parentTaskId: task.parentTaskId, text: serialized },
        { maxBytes: FANOUT_BUDGET.maxFeedbackBytes - Buffer.byteLength(head, "utf8") },
      );
      return head + trimmed.text;
    }

    /**
     * fan-out 是否处于终态（manager 权威状态）。restore 与登记路径共用同一判定。
     */
    function fanoutTaskIsTerminal(task) {
      return task !== null && typeof task === "object"
        && (typeof task.settledAt === "number" || (typeof task.status === "string" && task.status !== "pending"));
    }

    /**
     * fan-out 等待登记表：parentTaskId -> { attempt, agent, state }。
     *
     * 为什么需要**登记代次**：manager 的 retryShard / continuation 会把已终态任务带回
     * pending，而首次 settle 已经结算过旧代次的工作项。若 retry 复用同一个键，等待登记表
     * 会把「retry 期间的新工作」误认为「旧工作仍未结算」，从而在分片跑完前就放行。
     * 因此每次登记取**独立代次**，键编码为 fanout:<id>:<attempt>；旧代次的迟到结算只命中
     * 旧键，绝不会结算新代次。
     *
     * state 三态：pending（刚登记，尚未确认任务仍在跑）→ active（任务确实非终态，工作项已登记）
     * → released（已结算，不可复活）。用三态而不是 boolean：异步窗口里的迟到回调不能把已经
     * 释放的记录重新置回 active。
     */
    const fanoutTurnWaitRecords = new Map();
    let fanoutTurnWaitSequence = 0;
    // 24 是纯资源上界（只淘汰已释放记录）；代次分配不依赖本表，因此小上限不影响正确性。
    const FANOUT_HANDOFF_LIMIT = 24;

    /** 分配一个**不可复用**的全局登记代次。 */
    function nextFanoutHandoffSequence() {
      fanoutTurnWaitSequence += 1;
      return fanoutTurnWaitSequence;
    }

    /** 释放后按资源边界清理：只淘汰「已释放且 manager 已无该任务」的旧记录。 */
    function pruneFanoutHandoffRecords() {
      if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
      for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
        if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
        if (record?.state !== "released") continue;
        if (fanoutHost?.getTask(parentTaskId) !== null) continue;
        fanoutTurnWaitRecords.delete(parentTaskId);
      }
      // 极端情况（全部任务都还在 manager 表里且都是已释放记录）下仍按插入序淘汰最旧的
      // 已释放项。淘汰是安全的：代次来自全局序号（不复用），被淘汰记录的迟到 settle 只会
      // 走安全 no-op。
      for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
        if (fanoutTurnWaitRecords.size <= FANOUT_HANDOFF_LIMIT) return;
        if (record?.state !== "released") continue;
        fanoutTurnWaitRecords.delete(parentTaskId);
      }
    }

    /**
     * 该 parentTaskId 的当前登记是否仍由 **exact live root** 持有。
     *
     * 三个条件缺一不可：record.agent 是注册当时捕获的 exact Agent 对象（对象身份无法被
     * 同 id 伪造）；它仍是当前 live root；fanoutHost.ownsTask 能证明「活动绑定 + 绑定代际
     * token 仍 live」。记录的三态不参与身份判定。
     */
    function fanoutHandoffRecordIsOwnedByLiveRoot(agent, parentTaskId) {
      if (turnWaitStopping || !isLiveRootAgent(agent)) return void 0;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return void 0;
      const record = fanoutTurnWaitRecords.get(parentTaskId);
      if (record === void 0 || record.agent !== agent) return void 0;
      if (typeof fanoutHost?.ownsTask !== "function" || fanoutHost.ownsTask(agent, parentTaskId) !== true) return void 0;
      return record;
    }

    /**
     * 为一个 fan-out 父任务登记等待工作。
     *
     * @param {object} parent - exact live root Agent。
     * @param {{parentTaskId?:string,task?:object,accepted?:boolean,duplicate?:boolean}} result - submit/retry 结果。
     * @returns {boolean} 是否登记成功。
     */
    function registerFanoutGoalHandoff(parent, result) {
      if (turnWaitStopping || !isLiveRootAgent(parent)) return false;
      if (result?.accepted === false || result?.duplicate === true) return false;
      const parentTaskId = result?.parentTaskId;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      // 已终态快照：未来不会再有 task_settled，登记等待工作会永远无法结算。
      if (fanoutTaskIsTerminal(result?.task)) return false;
      const existing = fanoutTurnWaitRecords.get(parentTaskId);
      // 未释放的既有登记（pending/active）幂等短路：duplicate submit 或 restore 竞争都不得重复登记。
      if (existing !== void 0 && existing.state !== "released") return true;
      const attempt = nextFanoutHandoffSequence();
      fanoutTurnWaitRecords.set(parentTaskId, { attempt, agent: parent, state: "active" });
      pruneFanoutHandoffRecords();
      return rootTurnWaits.track(parent, { kind: "fanout", parentTaskId, attempt }) !== void 0;
    }

    /**
     * fan-out 父任务真实终态时**精确结算**它的等待工作。
     *
     * 只结算当前登记的代次：旧代次的迟到结算命中的键与新代次不同，因此不会提前放行仍在
     * retry 的任务。没有登记记录时为安全 no-op。
     *
     * @returns {boolean} 是否确实结算。
     */
    function releaseFanoutGoalHandoff(agent, parentTaskId) {
      if (turnWaitStopping) return false;
      const record = fanoutTurnWaitRecords.get(parentTaskId);
      // exact Agent 身份必须先于任何状态写入校验；旧代回调不得污染当前记录。
      if (record === void 0 || record.state === "released" || record.agent !== agent) return false;
      record.state = "released";
      return rootTurnWaits.settle(agent, { kind: "fanout", parentTaskId, attempt: record.attempt });
    }

    /**
     * fan-out 任务「重新回到 pending」时的等待工作再登记入口。
     *
     * 两个触发源共用同一语义（任务重新变成 pending，root 必须继续等待）：
     * - 手工重试（RPC fanout-retry-shard / fanout-retry）；
     * - 多轮复用（fanout 工具的 continuation 参数，同一 parentTaskId 的新一轮）。
     */
    function registerFanoutRetryGoalHandoff(parent, parentTaskId, task) {
      if (turnWaitStopping || !isLiveRootAgent(parent)) return false;
      if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
      return registerFanoutGoalHandoff(parent, { accepted: true, parentTaskId, task });
    }

    /**
     * fan-out 提交入口：只调用 manager 并登记 root turn 等待工作。
     *
     * 改造后这里**不再暂停 durable goal**：任务在后台按自己的调度推进，root 的当前
     * turn 由 finalize 保持打开（见 host/turn-wait.js），因此「任务运行期间 root 不会
     * 抢跑」这一语义由等待登记表承担。
     *
     * @param {object} parent - exact live root Agent。
     * @param {object} args - fanout 工具的已校验入参（含 role）。
     * @returns {object} manager 的提交结果。
     */
    function submitFanoutTask(parent, args) {
      const result = fanoutHost.submit(parent, args);
      registerFanoutGoalHandoff(parent, result);
      return result;
    }

    /**
     * 构造 continuation 句柄（工具回执/模型可见的「下一次怎么调用」契约）。
     *
     * 必须完整、稳定、可照抄：parentTaskId/role/round、父级状态与是否可继续、每个分片的
     * shardId/childId/当前 attempt/attemptCount、以及下一次调用所需字段。主代理据此决定
     * 是否续作同一逻辑任务，不需要读源码猜用法。
     *
     * @param {object} task - manager 的只读任务快照。
     * @returns {object|undefined} continuation 句柄；非法输入返回 undefined。
     */
    function buildFanoutContinuationHandle(task) {
      if (task === null || typeof task !== "object") return undefined;
      const shards = Array.isArray(task.shards) ? task.shards : [];
      const round = Number.isSafeInteger(task.round) && task.round >= 1 ? task.round : 1;
      // 父级聚合按用户确认规则：任一分片仍有未终态 attempt → running；全部结束 → ready。
      // manager 的 task.status 已经是最新 attempt 聚合（pending / completed / ...），
      // 这里只把它翻译成侧边栏与回执共用的 running|ready 词表。
      const running = task.status === "pending";
      const shardHandles = shards.map((shard) => {
        const attempts = Array.isArray(shard.attempts) ? shard.attempts : [];
        const latest = attempts[attempts.length - 1];
        const attempt = Number.isSafeInteger(latest?.attempt) ? latest.attempt : 0;
        return {
          shardId: shard.shardId,
          ...(typeof shard.name === "string" && shard.name.length > 0 ? { name: shard.name } : {}),
          childId: typeof latest?.childId === "string" ? latest.childId : null,
          attempt,
          attemptCount: attempts.length,
          status: shard.status ?? null,
          nextAttempt: attempt + 1,
        };
      });
      const nextAttemptByShard = {};
      for (const shard of shardHandles) nextAttemptByShard[shard.shardId] = shard.nextAttempt;
      return {
        parentTaskId: task.parentTaskId,
        role: task.role,
        round,
        status: task.status,
        running,
        // reusable：本轮 wait-all 已完成、任务未取消、manager 未关闭时才可以续作。
        reusable: task.continuable === true,
        shardIds: shardHandles.map((shard) => shard.shardId),
        shards: shardHandles,
        nextAttemptByShard,
        // 下一次调用所需字段：模型可直接照抄，只替换 prompt 文案。
        resumeWith: {
          tool: "fanout",
          arguments: {
            role: task.role,
            basePrompt: "<本轮共享目标>",
            shards: shardHandles.map((shard) => ({ shardId: shard.shardId, prompt: "<本轮该分片指令>" })),
            continuation: { parentTaskId: task.parentTaskId },
          },
        },
      };
    }

    /**
     * 多轮复用入口（fanout 工具的 continuation 参数）。
     *
     * 语义：
     * - 复用判定由主代理发起；插件校验 role / 分片数量 / shardId 结构一致、任务属于本 root、
     *   上一轮 wait-all 已完成，任一不满足即结构化拒绝（不改状态、不建 attempt）；
     * - 每个既有 shard 追加一个新 attempt，保留原 childId，旧 attempt 历史原样保留；
     * - 提交成功后任务立即回到 pending（投影 = running，侧边栏不再显示上一轮 stale ready），
     *   并**重新登记 root turn 等待工作**（新一轮运行期间 root 不会抢跑）。
     *
     * 失败一律抛带 code/reason 的错误：工具调用方（主代理）能直接读到拒绝原因，而 manager
     * 侧已经保证「校验先于任何状态修改」，因此不存在半写。
     *
     * @param {object} parent - 调用方 exact root Agent。
     * @param {{parentTaskId:string, role:string, basePrompt:string, shards:object[], requestId?:string}} args
     * @returns {object} 续作结果（含 manager 任务快照）。
     */
    function continueFanoutTask(parent, args) {
      const result = fanoutHost.continueTask(parent, args);
      if (result?.accepted !== true) {
        const reason = typeof result?.reason === "string" && result.reason.length > 0
          ? result.reason
          : (typeof result?.code === "string" && result.code.length > 0 ? result.code : "continuation_rejected");
        const error = new Error(describeFanoutContinuationRejection(reason, result));
        error.name = "FanoutContinuationError";
        error.code = result?.code ?? "FANOUT_CONTINUATION_REJECTED";
        error.reason = reason;
        error.detail = result;
        throw error;
      }
      // 任务重新 pending：立刻重新登记等待工作（新代次），与 retry 同一语义。
      // 幂等重放（duplicate=true）不改变任何状态，因此绝不能重新登记——
      // 那会把一个已经结算的轮次又挂成等待项。
      if (result.duplicate !== true) {
        registerFanoutRetryGoalHandoff(parent, result.parentTaskId, result.task);
      }
      return result;
    }

    /** 续作拒绝的中文说明：每种拒绝都给出可操作的下一步，而不是只抛 reason 字面量。 */
    function describeFanoutContinuationRejection(reason, detail = {}) {
      switch (reason) {
        case "unknown_parent_task":
          return "fan-out continuation 被拒绝：parentTaskId 不存在（" + String(detail.parentTaskId) + "）";
        case "not_owned_by_root":
          return "fan-out continuation 被拒绝：parentTaskId 不属于当前 root 的当前代际（" + String(detail.parentTaskId)
            + "，ownership: " + String(detail.ownership ?? "unproven") + "）";
        case "not_live_root":
          return "fan-out continuation 被拒绝：调用方不是当前代际的 live root（root 已销毁或被同 id 新代际替换）";
        case "child_session_unavailable":
          return "fan-out continuation 被拒绝：分片既有 child 的会话不可解析（"
            + (Array.isArray(detail.shardIds) ? detail.shardIds.join(", ") : "") + "），请改用 fanout-retry-shard 或提交新任务";
        case "continue_route_unavailable":
          return "fan-out continuation 被拒绝：Host 未接线续作投递路由（continueMessage）";
        case "request_budget_exceeded":
          return "fan-out continuation 被拒绝：该父任务的续作 requestId 记录已达预算，请提交新的 fan-out 任务";
        case "role_mismatch":
          return "fan-out continuation 被拒绝：role 必须与原任务一致（期望 " + String(detail.expectedRole) + "，收到 " + String(detail.role) + "）";
        case "shard_count_mismatch":
          return "fan-out continuation 被拒绝：分片数量必须与原任务一致（期望 " + String(detail.expected) + "，收到 " + String(detail.received) + "）";
        case "shard_ids_mismatch":
          return "fan-out continuation 被拒绝：shardId 结构必须与原任务一致（缺少 " + String(detail.missing) + "）";
        case "task_not_ready":
          return "fan-out continuation 被拒绝：上一轮 wait-all 尚未完成（分片 " + String(detail.shardId) + " 仍是 " + String(detail.shardStatus) + "）";
        case "parent_cancelled":
          return "fan-out continuation 被拒绝：该父任务已被取消，请提交新的 fan-out 任务";
        case "attempt_budget_exceeded":
          return "fan-out continuation 被拒绝：分片 " + String(detail.shardId) + " 已耗尽 attempt 预算，请提交新的 fan-out 任务";
        case "duplicate_request_id":
          return "fan-out continuation 被拒绝：requestId 已用于另一个父任务的续作";
        case "missing_parent_task_id":
          return "fan-out continuation 被拒绝：continuation.parentTaskId 必须是非空字符串";
        case "manager_closed":
        case "runtime_closed":
          return "fan-out continuation 被拒绝：fan-out runtime 已关闭";
        default:
          return "fan-out continuation 被拒绝：" + reason;
      }
    }

    /**
     * 冷恢复/重启后为「已在运行、但本进程还没有登记」的 fan-out 任务补登记等待工作。
     *
     * 判定完全基于当前事实（manager 权威任务 + exact live root 归属），因此可重入、
     * 可合并：registerFanoutGoalHandoff 自己对未释放记录幂等短路。
     *
     * 只处理本进程尚无活动登记的父任务；owner 已销毁时跳过（不凭空为不存在的 root 登记）。
     *
     * @returns {number} 本次补登记的任务数。
     */
    function reconcileFanoutGoalHandoffs() {
      if (turnWaitStopping || !fanoutHost) return 0;
      let reconciled = 0;
      for (const task of fanoutHost.listTasks()) {
        const parentTaskId = task?.parentTaskId;
        if (typeof parentTaskId !== "string" || parentTaskId.length === 0) continue;
        const existing = fanoutTurnWaitRecords.get(parentTaskId);
        if (existing !== void 0 && existing.state !== "released") continue;
        const ownerId = fanoutHost.ownerOf(parentTaskId);
        if (typeof ownerId !== "string" || ownerId.length === 0) continue;
        const agent = agents.get(ownerId);
        // root 已销毁：不凭空恢复不存在的 root。
        if (agent === void 0 || !isLiveRootAgent(agent)) continue;
        // 终态任务不会再有 task_settled：只标记已释放，绝不登记等待工作。
        if (fanoutTaskIsTerminal(task)) {
          if (existing !== void 0) existing.state = "released";
          continue;
        }
        if (registerFanoutGoalHandoff(agent, { accepted: true, parentTaskId, task })) reconciled += 1;
      }
      return reconciled;
    }

    /**
     * 为「已在运行、但还没有任何等待登记」的 fan-out 任务补登记（兜底路径）。
     *
     * 触发方式刻意做成「最小、可重入、可合并」：本函数不做任何自己的状态记账，只把当前
     * 事实合起来判定，因此可以被 root run 边界事件反复调用而不产生副作用放大。
     *
     * 归属边界：只处理本进程真实登记过的 parentTaskId（没有 record 就不猜）；record.agent
     * 必须是 exact live root 对象，且 fanoutHost.ownsTask 能证明活动绑定与绑定代际 token
     * 仍 live；任务必须是 manager 的**非终态**任务。
     *
     * @returns {number} 本次补登记的任务数。
     */
    function reconcileUnbarrieredFanoutHandoffs() {
      if (turnWaitStopping || !fanoutHost) return 0;
      if (fanoutTurnWaitRecords.size === 0) return 0;
      let reconciled = 0;
      for (const [parentTaskId, record] of [...fanoutTurnWaitRecords]) {
        if (record?.state !== "pending" && record?.state !== "released") continue;
        const agent = record.agent;
        const owned = fanoutHandoffRecordIsOwnedByLiveRoot(agent, parentTaskId);
        if (owned === void 0 || owned !== record) continue;
        const task = fanoutHost.getTask(parentTaskId);
        if (task === null || fanoutTaskIsTerminal(task)) continue;
        // 复用提交路径的登记入口：记录已被标记 released 时不会被幂等短路，因此这是一次
        // 真实的新代次登记。传入**权威任务快照**而不是伪造的 pending 视图。
        if (record.state === "released") fanoutTurnWaitRecords.delete(parentTaskId);
        if (registerFanoutGoalHandoff(agent, { accepted: true, parentTaskId, task })) reconciled += 1;
      }
      return reconciled;
    }


    fanoutHost = createFanoutRuntimeModule({
      createRuntime: (options) => createFanoutRuntime(options),
      runtimeOptions: {
        writeRoles: ["designer", "fixer"],
      },
      /**
       * 角色级并发上限的角色级共享池：唯一权威来源是插件 settings.roleConcurrencyLimit。
       *
       * 传解析函数而不是快照值有两个原因：
       * 1. settings 在插件装配之后才通过 ctx.inject 绑定，函数让 scheduler 每次派发都读到
       *    当前设置（设置页保存后无需重新装配，之后创建的 fan-out 任务立即生效）；
       * 2. 角色级上限描述的是"该角色共享的并发池"，池子是全局的，因此按当前设置解析，
       *    而不是在创建任务时复制一份到任务上。
       *
       * 任务级显式 concurrencyLimit（fanout 工具入参）仍然优先，并且会在任务快照里固化，
       * 恢复后不变；这两层优先级必须与工具描述、RPC meta 和设置页文案保持一致。
       * settingsSource() 已归一化（1~64 整数，非法/缺失回退 10），manager 侧还有一道
       * 校验兜底，scheduler 不会拿到 NaN/负数/越界值。
       */
      concurrencyLimit: () => normalizeRoleConcurrencyLimit(settingsSource()?.roleConcurrencyLimit),
      buildRequest: async (input, signal) => {
        const parent = host.lineage.parentAgentOf(input.parentTaskId);
        if (parent === void 0) throw new Error("fan-out parent root is unavailable: " + input.parentTaskId);
        const selection = resolveRole(parent.id, input.role);
        if (selection === null) throw new Error(input.role + " 专家尚未配置模型");
        const validatedSelection = await validateSelectionWithSignal(selection, signal);
        const deny = readOnly(input.role)
          ? effectiveDeny(parent, READONLY_DENY, true)
          : [...effectiveDeny(parent, EXPERT_DELEGATION_DENY), ...effectiveDeny(parent, ROOT_ONLY_TOOL_DENY)];
        // 分片任务名称是展示层短标签：有名称时子代理的 dispatch label 与任务正文都
        // 显示"分片代号 + 任务名称"，让专家自己知道这一片在整体目标里叫什么；没有名称
        // 时保持旧文案（只有分片代号与 attempt 序号）。
        // manager 已把名称归一化（非空 + 已 trim）；这里再 trim 一次只是防御运行期
        // 二次装配带来的差异，语义与校验侧完全一致。
        const shardName = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : undefined;
        const taskText = [
          input.basePrompt,
          "",
          "当前分片（shardId: " + input.shardId + ", attempt: " + input.attempt + "）：",
          ...(shardName === undefined ? [] : ["任务名称：" + shardName]),
          input.prompt,
        ].join("\n");
        const request = {
          label: "fan-out " + input.role + "/" + input.shardId + (shardName === undefined ? "" : " · " + shardName) + " #" + input.attempt,
          prompt: [{ type: "text", text: buildExpertTaskPrompt(input.role, taskText) }],
          parent,
          agentOptions: {
            provider: validatedSelection.provider,
            model: validatedSelection.model,
            [EFFORT_MARKER]: validatedSelection.reasoningEffort,
            [ROLE_MARKER]: input.role,
            [PARENT_MARKER]: parent.id,
            [CONTINUABLE_MARKER]: true,
            [FANOUT_MARKER]: true,
            [FANOUT_PARENT_TASK_MARKER]: input.parentTaskId,
            [FANOUT_PARENT_AGENT_MARKER]: parent.id,
            [FANOUT_SHARD_MARKER]: input.shardId,
            [FANOUT_ATTEMPT_MARKER]: input.attempt,
          },
          // 分片任务同样在 admission 边界解析当前权威 persona：设置页保存后，
          // 之后新建的 fan-out child 使用新覆盖，正在运行的分片不受影响。
          persona: resolvePersonaForAdmission(input.role),
          toolFilter: { deny: ensureExpertSendMessageDenied(deny) },
          maxDepth: 1,
        };
        return { request, parentAgent: parent, parentId: parent.id, role: input.role };
      },
      startContinuable: ({ request, signal }) => subagents.startContinuable({
        provider: "spawn",
        label: request.label,
        request,
        signal,
      }),
      /**
       * 多轮复用：把本轮 prompt 投递给**同一 child**（不新建 child、不新建父任务）。
       *
       * 走既有公开 continuation seam（sendMessageToExistingChild → subagents.sendMessage）：
       * lineage/root generation 校验、message admission 与 disposal 都由 Host 负责；插件
       * 不直接操作 child 内部状态。本轮正文与首轮 buildRequest 同构（basePrompt + 分片标识 +
       * 本轮 prompt，并显式标注 round/attempt），persona 已绑定在该 child 上、无需重复注入。
       * 返回的新 messageId 会被 runtime 记为「本轮应该结算的 turn」，用于拒绝上一轮迟到
       * turn/end 覆盖新一轮 attempt。
       */
      continueMessage: ({ childId, parentAgent, input, signal }) => {
        if (parentAgent === void 0) throw new Error("fan-out continuation parent root is unavailable: " + childId);
        const shardName = typeof input?.name === "string" && input.name.trim().length > 0 ? input.name.trim() : undefined;
        const taskText = [
          typeof input?.basePrompt === "string" ? input.basePrompt : "",
          "",
          "当前分片续作（shardId: " + input?.shardId + ", attempt: " + input?.attempt
            + (Number.isSafeInteger(input?.round) ? ", round: " + input.round : "") + "）：",
          ...(shardName === undefined ? [] : ["任务名称：" + shardName]),
          typeof input?.prompt === "string" ? input.prompt : "",
        ].join("\n");
        return sendMessageToExistingChild({
          parent: parentAgent,
          childId,
          content: [{ type: "text", text: buildExpertTaskPrompt(input?.role, taskText) }],
          signal,
          interrupt: false,
          rootToken: host.lineage.tokenFor(parentAgent),
        });
      },
      /**
       * 解析既有 child 的 session：多轮复用需要把本轮 attempt 绑定到上一轮同一个 child 的
       * session，才能由它的 turn/end 结算本轮。cold-resume 后 session 实例可能已更换，
       * 因此每次按 id 现读；拿不到时 runtime 会 fail-closed 本轮 attempt。
       */
      resolveChildSession: (childId) => agents.get(childId)?.session,
      interrupt: ({ childId, parentAgent }) => {
        // DSH interrupt 需要 exact parent authority；活动 attempt 在 admission 时已经
        // 保存 parentAgent，缺失时只等待 child dispose/turn-end 自然收敛。
        if (parentAgent === void 0) return;
        return subagents.interrupt(childId, { kind: "ancestor", agent: parentAgent });
      },
      onAgentCreated: ({ agent, role, parentId, parentTaskId, parentAgentId, shardId, attempt }) => {
        registerPluginExpertChildAgent(agent);
        installExpertReportGuardForAgent(agent, { role, parentId, source: "fanout" });
        installEffortInjection(agent, resolveEffortOf(agent));
        if (typeof agent?.id === "string") childActivationStates.set(agent.id, { agent, status: "live" });
        const childId = typeof agent?.id === "string" ? agent.id : void 0;
        const provider = agent?.options?.provider;
        const model = agent?.options?.model;
        const fanoutIdentity = typeof parentTaskId === "string"
          && parentTaskId.length > 0
          && typeof shardId === "string"
          && shardId.length > 0
          && Number.isSafeInteger(attempt)
          && attempt > 0;
        if (childId !== void 0 && typeof provider === "string" && typeof model === "string") {
          void writeChildModel(childId, {
            provider,
            model,
            ...(typeof agent.options?.[EFFORT_MARKER] === "string" ? { reasoningEffort: agent.options[EFFORT_MARKER] } : {}),
            ...(typeof role === "string" ? { role } : {}),
            ...(typeof parentId === "string" ? { parentId } : {}),
            continuable: true,
            ...(fanoutIdentity ? {
              fanout: true,
              fanoutParentTaskId: parentTaskId,
              fanoutParentAgentId: typeof parentAgentId === "string" ? parentAgentId : parentId,
              fanoutShardId: shardId,
              fanoutAttempt: attempt,
            } : {}),
          });
        }
      },
      lineage: host.lineage,
      getAgent: (id) => agents.get(id),
      buildFeedback: buildFanoutFeedback,
      /**
       * fan-out 父任务真实终态时的等待结算入口。
       *
       * 任务整体 settle（completed / completed_with_errors / cancelled）时按**当前登记
       * 代次**结算 "fanout:<parentTaskId>:<attempt>" 工作项。回调是在 manager 的状态写入
       * 路径里同步触发的，因此这里只做同步的精确结算（登记表内部会按需重新判定静止）。
       *
       * exact Agent 优先用 fanout-runtime 在释放 lineage 绑定前捕获的对象：登记记录的
       * 归属校验是对象身份，按 id 重新解析可能拿到 replacement 代际。只有 exact 对象
       * 不可用时才退回 id，交由对象身份校验 fail-closed。
       */
      onParentSettled: (parentTaskId, parentAgent, parentAgentId) => {
        if (turnWaitStopping) return;
        const agent = parentAgent ?? (typeof parentAgentId === "string" ? agents.get(parentAgentId) : void 0);
        if (agent === void 0) return;
        releaseFanoutGoalHandoff(agent, parentTaskId);
      },
      /**
       * fan-out 反馈注入（父任务可见的生产者自有消息来源）。
       *
       * 会话格式 V4 在写入边界**精确拒绝** `kind: "plugin"`（旧插件包装语法）：
       * `agent/inbox/spliced` 是受校验的事件类型之一，因此沿用旧写法会让父任务
       * 完全收不到反馈（或写入直接抛错）。
       *
       * 0.1.7 对「未知插件」的规范 kind 由 `producerKind()` 机械派生为
       * `plugin:<plugin>`（已知第一方插件才按改名表/同名表映射）；V4 只拒绝精确的
       * `"plugin"`，`plugin:` 前缀形式不受影响，客户端对未识别 kind 走 default
       * 分支——消息仍正常可见，只是不归属特定身份语气，语义安全。
       *
       * 因此这里使用生产者自有 kind `plugin:dsh-expert-group`，并**不再携带** `plugin`
       * 字段（V4 的生产者自有 source 只有 kind，旧字段在转换时会被丢弃）。
       * 这里刻意**不**套用任何第一方 kind：DEG 是外部插件，冒用 `subagent-*` 之类的
       * 第一方身份会让客户端把反馈误归属到 DSH 自身机制上。
       */
      injectFeedback: (parent, text) => {
        const message = createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: PRODUCER_SOURCE_KIND },
        });
        parent.inject(message);
      },
      writeSnapshot: (snapshot) => persistFanoutSnapshot(snapshot),
      getPersistenceGeneration: () => host.storage.active()?.generation,
      readSnapshot: () => storageBinding.fanoutSnapshot(),
      persistenceHealth,
      logger: ctx.logger,
    });
    fanoutHost.restore();
    ctx.effect(() => () => fanoutHost?.close(), "dsh-expert-group: fan-out runtime");

    // Expert Group 只投影现有状态；它不订阅或改变任务生命周期，RPC 调用时按需生成快照。
    const expertGroupRuntime = createExpertGroupRuntime({
      agents,
      goals,
      lineage: host.lineage,
      fanoutHost,
      recovery,
      recoveryRecords,
      source,
      sessionQuery: () => expertGroupSessionQuery,
    });

    let routeImageToObserver;
    function mountRole(role) {
      // 对齐 dsh-tool-subagent：provider 缺失或能力不足时不注册工具，等 provider-added 再挂载。
      if (toolDisposers.has(role)) return;
      if (!spawnProviderReady()) return;
      // 未注册角色不挂载工具（注册表是唯一角色来源）；persona 在 admission 边界解析，
      // 因此这里不再缓存角色人格快照。
      if (ROLE_META[role] === void 0) return;

      /**
       * 校验显式续作句柄（role tool 的 childId）：必须存在、属于当前 root，
       * 并且是本 scope 记录过的 expert child。
       *
       * 只接受显式传入的 childId —— 没有任何输入时绝不把「当前 scope 最近一个
       * child」当成续作目标，避免不同 prompt 被静默当成旧任务的续作。
       * @returns {{target:object|undefined, warning:string}} 校验结果。
       */
      function resolveContinueTarget({ childId, parent, scope, taskKey, currentRouteKey }) {
        if (typeof childId !== "string" || childId.length === 0) {
          return { target: void 0, warning: role + " 续作需要显式 childId" };
        }
        if (!trackerChildIdsForScope(scope, taskKey, { parent }).includes(childId)) {
          return {
            target: void 0,
            warning: role + " 续作被拒绝：childId 「" + childId + "」不是本 root(" + parent.id + ") 下该角色的已知专家 child；"
              + "请使用 role 工具返回的 subagentId，或省略 childId 派发一个新任务",
          };
        }
        const record = recoveryRecords.get(childId);
        // 记录存在时进一步校验 owner：跨父代理/跨角色的 childId 不得被当作续作目标。
        if (record !== void 0 && (record.parentId !== parent.id || (record.role !== void 0 && record.role !== role))) {
          return {
            target: void 0,
            warning: role + " 续作被拒绝：childId 「" + childId + "」不属于当前 root 的该角色专家 child",
          };
        }
        const bound = delegationTracker.getTaskChild(scope, taskKey);
        return {
          target: {
            childId,
            record,
            routeKey: bound?.childId === childId && typeof bound.routeKey === "string" ? bound.routeKey : currentRouteKey,
          },
          warning: "",
        };
      }

      /**
       * 本 scope 已知的 expert child id（最近 child + 任务绑定指向的 child +
       * 本父代理该角色尚未结算的活动任务指向的 child）。
       *
       * 覆盖面刻意完整：显式 childId 的归属校验会拒绝任何不在此集合中的 id，
       * 因此这里必须包含所有**本 root 该角色**真实创建过的 child，同时绝不包含
       * 其他父代理、fan-out 或不属于该角色的 child。
       * @param {string} scope - delegationScopeKey(parentId, role)。
       * @param {string} [candidateTaskKey] - 可选的归一化任务 key（其绑定 child 也算已知）。
       * @param {{parent?:object}} [owner] - 可选的 exact root Agent：给出时额外要求 recovery
       *   record 的 parentAgent 与它一致（同 id 的另一代 root 不得接管该 record）。
       * @returns {Array<string>} 去重后的 child id 列表。
       */
      function trackerChildIdsForScope(scope, candidateTaskKey, owner) {
        const ids = new Set(delegationTracker.listChildIds(scope));
        const bound = delegationTracker.getChild(scope);
        if (bound !== void 0) ids.add(bound.childId);
        if (typeof candidateTaskKey === "string" && candidateTaskKey.length > 0) {
          const taskChild = delegationTracker.getTaskChild(scope, candidateTaskKey);
          if (taskChild !== void 0) ids.add(taskChild.childId);
        }
        // 活动任务指向的 child：任务绑定可能已被上限淘汰/结算，但 child 仍属于本 scope。
        const separator = String(scope ?? "").lastIndexOf("::");
        const parentId = separator === -1 ? void 0 : String(scope).slice(0, separator);
        if (parentId === void 0) return [...ids];
        for (const task of delegationTracker.listActiveTasks(parentId)) {
          if (task.role !== role) continue;
          if (typeof task.childId === "string" && task.childId.length > 0) ids.add(task.childId);
        }
        // 仍存活的 recovery record 持有的 expert child：task 记忆被 LRU 淘汰、route 切换
        // 清表、记录重建或活动范围已结算后，receipt 里的 childId 仍必须能被显式续作/取消
        // 定位；否则 root 只能改派新任务，而旧 child 还在跑（变成无人收口的孤儿任务）。
        // route 刻意不作为识别过滤条件：record.routeKey 是「创建时那条 route」，切换 route
        // 之后 receipt 句柄必须继续有效；route 的校验留在投递与恢复路径（续作使用当前
        // route、恢复按 routeChanged 判定重建），识别阶段只认 root+role 归属与有效性。
        const parentAgent = owner?.parent;
        for (const [recordChildId, record] of recoveryRecords) {
          if (record === null || typeof record !== "object") continue;
          // 归属：只认本 parent+role 的 record；同 id 的另一代 root generation 不得接管。
          if (record.parentId !== parentId || record.role !== role) continue;
          if (parentAgent !== void 0 && record.parentAgent !== void 0 && record.parentAgent !== parentAgent) continue;
          // 有效性：只有可续接、且确实成功 acceptance 过的专家 child 才是合法目标。
          if (record.continuable !== true || record.invalidAcceptance === true) continue;
          // fan-out child 属于另一条恢复链：普通 role 工具绝不显式续作/取消它。
          if (isFanoutChildId(recordChildId)) continue;
          ids.add(recordChildId);
        }
        return [...ids];
      }

      /**
       * childId 是否属于 fan-out 链路：内存 Agent 与持久化 child_models 快照任一侧命中
       * 即算（与 agent/created 的 fan-out 判定同源），fan-out 目标永不由普通 role 工具续作。
       */
      function isFanoutChildId(childId) {
        return isFanoutAgent(agents.get(childId)) || isFanoutIdentity(source().childModels?.[childId]);
      }

      /**
       * 读取显式句柄参数（childId / cancelChildId）。
       *
       * 约定：字段**完全缺省**（undefined）才算「没有提供」；只要字段存在，就必须是
       * 非空且非纯空白的字符串。空串、纯空白与非字符串一律 fail-closed，绝不被当作
       * 「未提供」而继续普通派发/新建 child —— 那会让 root 以为在续作或取消，实际却
       * 启动了新任务（线上最危险的静默分叉）。
       *
       * 非字符串输入通常已被 DSH 工具入参校验（defineTool → INVALID_ARGS）拦在 handler
       * 之外；这里保留同一判定作为 handler 边界的第二道防线。合法的非空白字符串**不做
       * trim**：childId 是 opaque id，精确匹配失败会走 CHILD_NOT_FOUND 的可读拒绝，
       * 不扩大匹配面。
       * @returns {{present:boolean, value:string|undefined, invalid:boolean}}
       */
      function readExplicitHandle(args, name) {
        const raw = args === null || typeof args !== "object" ? void 0 : args[name];
        if (raw === void 0) return { present: false, value: void 0, invalid: false };
        if (typeof raw !== "string" || raw.trim().length === 0) return { present: true, value: void 0, invalid: true };
        return { present: true, value: raw, invalid: false };
      }

      /** 非法句柄的简短类型描述：只报类型/形态，绝不复述可能很长的原始内容。 */
      function describeHandleValue(value) {
        if (value === null) return "null";
        if (typeof value === "string") return value.length === 0 ? "空字符串" : "仅含空白的字符串";
        return typeof value;
      }

      /**
       * 构造「显式句柄在 admission 之前被拒绝」的公开结果。
       *
       * 该结果**不携带** admissionEpoch/admissionToken：被拒绝的句柄没有登记新 admission、
       * 没有创建或投递任何 child，凭据会伪造出「真实 child admission」的假象并让模型把它
       * 拿去 finalize。因此使用独立 kind `rejected`（输出 schema 中的无凭据变体），与带凭据
       * 的 advisory/continuable 明确区分；同时保持 fail-closed：绝不 interrupt、绝不派发。
       */
      function rejectedHandleResult(reason, code, warning) {
        return { kind: "rejected", started: false, accepted: false, reason, code, warning };
      }

      /**
       * 显式续作：向指定 child 投递本轮 prompt。
       *
       * 走既有公开 continuation seam（reuseOrSteer → subagents.sendMessage/interrupt）：
       * lineage/root generation 校验、message admission 与 disposal 都由 Host 负责。
       * 语义保留既有边界：
       * - queue=true 只排队（公开 sendMessage 投递，不请求 cancel）；
       * - queue=false 允许先请求公开 interrupt（用户显式要求暂停/重定向才由 root 显式续作）；
       * - 投递失败不得回落到新建 child，只有 NOT_RESUMABLE 才由既有重建路径处理。
       * @returns {Promise<object>} admission 结果（continuable/reused）。
       */
      async function continueExplicitChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken, target }) {
        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        let outcome;
        try {
          outcome = await reuseOrSteer({
            scope,
            childId: target.childId,
            taskKey,
            promptText: request.prompt[0].text,
            promptContent: request.prompt,
            parent,
            signal,
            queue,
            handoffExpected,
            rootToken,
            explicit: true,
            continuationRouteKey: routeKey,
          });
        } catch (error) {
          // 容量耗尽必须在这里就带上 DEG 自有稳定 code：后续的 lineage 检查会抛普通
          // 错误，那会覆盖分类信息，让上层把「容量」误判成泛化 admission 失败。
          const capacityError = createSubagentCapacityError(error);
          if (capacityError !== undefined) throw capacityError;
          throw error;
        }
        if (!host.lineage.isLiveGeneration(parent, rootToken)) {
          const lateRecord = recoveryRecords.get(target.childId);
          if (lateRecord?.parentAgent === parent) dropRecoveryRecord(target.childId, "root generation retired", lateRecord);
          throw new Error("root generation is no longer live");
        }
        if (outcome !== null) {
          recovery.rememberContext(recoveryRecords.get(outcome.subagentId), { routeKey, request, label, taskKey });
          return outcome;
        }
        // 显式续作遇到 NOT_RESUMABLE：按既有恢复语义重建一个 continuable child，
        // 原 child 的 pending recovery 由此接管（与自动恢复的 rebuild 同一路径）。
        return rebuildExistingChildForContinuation({
          record: target.record,
          childId: target.childId,
          parent,
          scope,
          routeKey,
          request,
          label,
          taskKey,
          rootToken,
        });
      }

      /**
       * 显式续作触发的 child 重建：把原 child 的任务绑定迁移到替代 child。
       * 只接受仍可验证的 exact record（parent/role/owner 一致），其他情况 fail-closed
       * 上抛，绝不静默新建一个与旧任务无关的 child。
       */
      async function rebuildExistingChildForContinuation({ record, childId, parent, scope, routeKey, request, label, taskKey, rootToken }) {
        if (record === void 0 || record.parentId !== parent.id || record.role !== role) {
          throw new Error(role + " 续作失败：child " + childId + " 已不可恢复且缺少可验证的恢复记录");
        }
        const durableSession = record.agent?.session ?? record.session;
        if (durableSession === void 0) {
          // 既没有 durable Session 也没有 live Activation 时，Host 无法冷恢复同一任务链，
          // 重建出的 child 只会拿到「本轮 follow-up 文本」而丢掉原任务上下文；此时明确
          // 失败并请 root 改派新任务，绝不静默把旧任务替换成一个内容不完整的 child。
          throw new Error(role + " 续作失败：child " + childId + " 已不可恢复且缺少 durable Session，请作为新任务重新派发");
        }
        let rebuiltChildId;
        let messageId;
        try {
          ({ childId: rebuiltChildId, messageId } = await subagents.startContinuable({
            provider: "spawn",
            label,
            request,
            signal: void 0,
          }));
        } catch (error) {
          const capacityError = createSubagentCapacityError(error);
          if (capacityError !== undefined) throw capacityError;
          throw error;
        }
        if (!host.lineage.isLiveGeneration(parent, rootToken)) {
          const lateRecord = recoveryRecords.get(rebuiltChildId);
          if (lateRecord?.parentAgent === parent) dropRecoveryRecord(rebuiltChildId, "root generation retired", lateRecord);
          throw new Error("root generation is no longer live");
        }
        if (typeof rebuiltChildId !== "string" || rebuiltChildId.length === 0
          || typeof messageId !== "string" || messageId.length === 0) {
          throw new Error("startContinuable returned an invalid acceptance");
        }
        // 旧 child 的未接受 recovery 由此被替代；旧 Agent 的迟到事件按 id 自然忽略。
        supersedePendingRecoveryOps(record);
        const replacement = ensureRecoveryRecord(rebuiltChildId, parent.id, role, parent, void 0, true);
        delegationTracker.setChild(scope, { childId: rebuiltChildId, routeKey });
        delegationTracker.rememberTask(scope, taskKey, { childId: rebuiltChildId, routeKey });
        delegationTracker.rebindActiveTasks({
          parentId: parent.id,
          role,
          oldChildId: childId,
          newChildId: rebuiltChildId,
          messageId,
          taskKeys: [taskKey],
        });
        replacement.tasks.set(taskKey, { messageId, childId: rebuiltChildId });
        evictOldestEntries(replacement.tasks, TASK_BINDING_LIMIT);
        delete replacement.invalidAcceptance;
        recovery.rememberContext(replacement, { routeKey, request, label, taskKey });
        persistChildDispatch(rebuiltChildId, replacement, request, label, messageId);
        return { kind: "continuable", subagentId: rebuiltChildId, messageId };
      }

      /**
       * 显式取消（role tool 的 cancelChildId）：按 childId 精确定位，只请求该 child
       * 的取消，不派发新任务、不投递消息。
       *
       * 严格边界：不接受「按 parent+role 猜目标」，因此同 scope 的其他独立 child
       * 不会被误取消。使用公开 subagents.interrupt(childId, { kind: "ancestor", agent })。
       */
      async function cancelExplicitChild({ childId, parent, scope }) {
        const resolved = resolveContinueTarget({ childId, parent, scope, taskKey: "" });
        if (resolved.target === void 0) return { ok: false, warning: resolved.warning };
        if (typeof subagents?.interrupt !== "function") {
          return { ok: false, warning: role + " 取消失败：当前 Host 未提供公开 subagents.interrupt" };
        }
        await subagents.interrupt(childId, { kind: "ancestor", agent: parent });
        return { ok: true, childId };
      }
      /**
       * 复用或投递到既有 child；判定为需要新建时返回 null。
       * 复用（reused）时不发送任何新 prompt；续作（queued）时返回同一 childId。
       *
       * 调用边界（多 child 语义）：本函数只处理**已经确定目标 child** 的两种情形——
       * 归一化后完全相同的任务复用其原 child，或 root 显式给出 childId 的续作
       * （explicit=true）。不同 prompt 的普通派发不再走到这里，而是新建独立 child，
       * 因此本函数不会因为没有 childId 就把新任务静默当成旧任务的续作。
       * NOT_RESUMABLE 走新建分支；容量耗尽抛可读提示（不重建：撞上限时重建必然
       * 再失败），其他错误（UNAUTHORIZED/DRAINING 等）必须原样上抛，不能吞掉。
       * B3/S1-D：投递成功后写任务绑定 record.tasks（taskKey -> { messageId,
       * childId }）；reused 分支返回原绑定（含 messageId），供任务终态关联原 turn
       * 的最终结果或命中成功缓存。binding 在 admission **之前**以
       * pendingMessage:true 预登记（消息 id 未知），admission 返回后回填
       * messageId 并清标记——claimed 补绑可覆盖回调晚于认领事件的竞态。
       */
      async function reuseOrSteer({ scope, childId, taskKey, promptText, promptContent, parent, signal, activityId, queue = false, handoffExpected = false, rootToken, explicit = false, continuationRouteKey }) {
         if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        if (delegationTracker.hasTask(scope, taskKey)) {
          // 归一化后完全相同的任务已记录：默认不发送新 prompt，直接复用同一 child。
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          const record = recoveryRecords.get(childId);
          if (record?.invalidAcceptance === true) return null;
          const binding = record?.tasks?.get(taskKey);
          // 显式续作（root 给出 childId）必须真的把本轮 prompt 投递给**那个** child：
          // 该 child 上没有本任务绑定、或绑定指向别的 child 时都不能静默「复用」——
          // 否则回执的 subagentId/messageId 与请求矛盾，root 以为已投递却发给了别的 child。
          // 只有「绑定正好就是这个 child」才复用；不带 childId 的普通重复派发保持旧语义
          // （复用其绑定 child；没有绑定时返回无 messageId 的 reused）。
          const boundHere = binding !== void 0 && binding.childId === childId;
          if (explicit !== true || boundHere) {
            if (binding !== void 0) {
              return { kind: "continuable", subagentId: binding.childId, reused: true, messageId: binding.messageId };
            }
            // 没有任务绑定（旧版记录/记录已被上限淘汰）：保持旧行为，无 messageId。
            return { kind: "continuable", subagentId: childId, reused: true };
          }
        }

        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        const record = ensureRecoveryRecord(childId, parent.id, role, parent, void 0, true);
        const pendingAdmission = handoffExpected === true
          ? registerPendingHandoffAdmission(parent, role, childId, taskKey)
          : void 0;
        // 已通过父会话级范围预检的任务在 steer 前绑定到已知 child；若后续
        // NOT_RESUMABLE 而重建，new-child 路径会改写该绑定。
        if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId);
        // S1-D：admission 前先登记 pendingMessage 绑定（messageId 尚不确定），
        // claimed 补绑可据此按任务文本匹配回填。
        record.tasks.set(taskKey, { messageId: null, childId, pendingMessage: true });
        evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
        let messageId;
        try {
          // 同 route 的既有 child：queue=true 也由公开 manager sendMessage 投递；
          // queue=false 才先请求 interrupt。RC1 sendMessage 对 live/cold 统一负责 admission。
          messageId = await sendMessageToExistingChild({
            parent,
            childId,
            content: Array.isArray(promptContent) ? promptContent : [{ type: "text", text: promptText }],
            signal,
            rootToken,
            // 只有「显式续作且未要求排队」才允许先请求公开 interrupt（用户显式要求
            // 暂停/重定向）。普通新任务永远不会走到这里；即使走到也不得取消既有 child。
            interrupt: explicit === true && queue !== true,
            queue: queue === true,
          });
          if (typeof messageId !== "string" || messageId.length === 0) throw new Error("existing child admission returned an invalid messageId");
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          if (pendingAdmission !== void 0) {
            pendingAdmission.activation = record.agent;
            pendingAdmission.messageId = messageId;
          }
        } catch (error) {
          if (!host.lineage.isLiveGeneration(parent, rootToken)) {
            if (pendingAdmission !== void 0) {
              failPendingHandoffAdmission(parent, pendingAdmission, record);
              settlePendingChildTurnEnds(parent, false, pendingAdmission);
              removePendingHandoffAdmission(pendingAdmission);
            }
            if (activityId !== void 0) delegationTracker.releaseActiveTask(activityId);
            const lateRecord = recoveryRecords.get(childId);
            if (lateRecord?.parentAgent === parent) dropRecoveryRecord(childId, "root generation retired", lateRecord);
            throw error;
          }
          // existing-child admission 失败只消费同一 token 暂存的 turn/end，不得 drain 其他 admission。
          if (pendingAdmission !== void 0) {
            failPendingHandoffAdmission(parent, pendingAdmission, record);
            settlePendingChildTurnEnds(parent, false, pendingAdmission);
          }
          removePendingHandoffAdmission(pendingAdmission);
          // 只有 helper admission 失败才清理 pending binding；此处尚无新任务
          // acceptance，因此绝不能提前 supersede 旧 recovery。若 claimed 已先观察到消息，则保留那条已接受消息的绑定，避免把真实任务误删。
          const binding = record.tasks.get(taskKey);
          if (binding !== void 0 && binding.pendingMessage === true && binding.messageId === null) {
            record.tasks.delete(taskKey);
          }
          // 容量耗尽（等待子代理完成，或继续使用现有子代理）不是「child 已损坏」：
          // 重建只会立刻再次撞上限，因此这里不落 NOT_RESUMABLE 的新建分支。抛出的是
          // 携带 DEG 自有稳定 code 的可读错误（不含宿主原始码/英文文案），上层分类表
          // 据此归入可重试的 steer 失败，而不是伪装成成功或原样透传宿主错误。
          const capacityError = createSubagentCapacityError(error);
          if (capacityError !== undefined) throw capacityError;
          if (error?.code !== "NOT_RESUMABLE") throw error;
          return null;
        }

        // messageId 已返回即新任务 admission 边界：此后才允许取代旧 recovery。
        // 先 supersede 再重写当前 binding，避免旧 op 恰好拥有相同 taskKey 时把
        // 刚接受的新消息标成 superseded；accepted recovery op 会被 helper 跳过。
        // 取代与任务记忆都只针对本次续作的目标 child：其他独立 child 的 recovery
        // 和任务绑定不受影响（多 child 语义）。
        supersedePendingRecoveryOps(record);
        delegationTracker.rememberTask(scope, taskKey, { childId, routeKey: continuationRouteKey });
        record.tasks.set(taskKey, { messageId, childId });
        evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
        if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId, messageId);
        return { kind: "continuable", subagentId: childId, queued: true, messageId, handoffAdmission: pendingAdmission };
      }

      /**
       * scope 临界区内执行后台委派（唯一入口，保证同父同角色串行）：
       * 判定顺序（多 child 语义）：
       * 0. root 显式给出 childId → 只向该 child 续作（找不到目标由上层 advisory 拒绝）；
       * 1. 任务 key 已绑定到本 scope 的某个 child（归一化后完全相同的任务）→ 复用它，
       *    不新建、不投递；绑定的不是最近 child 时同样按绑定续作；
       *    ⚠ 没有该任务绑定时**不再**投向「最近一个 child」——不同 prompt 必须新建独立
       *    child，绝不隐式 steer；
       * 2. 内存无 child：尝试从持久化 childModels 恢复同 parentId+role+route 的
       *    continuable child（重启恢复；旧记录无标记时忽略），恢复后走统一投递分支；
       * 3. 其余情况（不同 prompt / route 已变 / 恢复失败 / NOT_RESUMABLE）→ 新建独立
       *    child，并记录「本任务 key -> 新 child」绑定；新建不再清空同 route 其他 child
       *    的任务记忆，也不再取代它们的 recovery。
       */
      async function delegateBackground({ scope, taskKey, routeKey, request, parent, signal, label, queue = false, activityId, handoffExpected = false, rootToken, explicitChildId, continuationChildId }) {
        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        // 只有「指向既有 child 的路径」才允许取代该 child 未接受的 recovery；
        // 新建独立 child 必须保留其他 child 的自愈链（多 child 语义）。
        const explicitContinue = explicitChildId !== void 0 || continuationChildId !== void 0;
        const current = delegationTracker.getChild(scope);
        // 记录可能被替换的旧 child；只有新 child 的 startContinuable 返回
        // accepted messageId 后，才会对其未接受 recovery 做 supersede。
        // 显式续作/相同任务复用不新建 child，因此不会取代任何其他 child 的 recovery。
        let retiredChildId = explicitChildId ?? continuationChildId ?? current?.childId;
        let retiredRecord = retiredChildId === void 0 ? void 0 : recoveryRecords.get(retiredChildId);
        if (explicitChildId !== void 0) {
          // root 显式指定 childId：续作只发给该 child，绝不落到新建分支。
          const continued = await continueExplicitChild({ scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken, target: { childId: explicitChildId, record: retiredRecord, routeKey } });
          if (continued !== null) return continued;
        } else if (continuationChildId !== void 0) {
          // 相同 prompt 复用它自己的 child（可能是同 scope 下更早的独立 child，也可能
          // 就是最近一个 child）：两种情况都必须先解析出那个 child，绝不新建。
          const boundRecord = recoveryRecords.get(continuationChildId);
          const boundRouteKey = delegationTracker.getTaskChild(scope, taskKey)?.routeKey ?? routeKey;
          const reusedEarlier = await continueExplicitChild({ scope, taskKey, routeKey: boundRouteKey, request, parent, signal, label, queue, handoffExpected, rootToken, target: { childId: continuationChildId, record: boundRecord, routeKey: boundRouteKey } });
          if (reusedEarlier !== null) return reusedEarlier;
        } else if (current === void 0) {
          // 重启后内存为空：从持久化快照按 parentId+role+route 恢复可复用 child。
          const restored = restoreChildFromSnapshot(parent.id, role, routeKey);
          if (restored !== void 0) {
            retiredChildId = restored;
            retiredRecord = recoveryRecords.get(restored);
            // 只恢复 child 与 route，不恢复任务记录：重启后无法确认旧任务是否已执行，
            // 相同任务也走 steer 排队（明确告知父代理），而不是静默复用。
            delegationTracker.setChild(scope, { childId: restored, routeKey });
            const reused = await reuseOrSteer({ scope, childId: restored, taskKey, promptText: request.prompt[0].text, promptContent: request.prompt, parent, signal, queue, activityId, handoffExpected, rootToken, continuationRouteKey: routeKey });
            if (reused !== null) {
              if (!host.lineage.isLiveGeneration(parent, rootToken)) {
                if (activityId !== void 0) delegationTracker.releaseActiveTask(activityId);
                const lateRecord = recoveryRecords.get(reused.subagentId);
                if (lateRecord?.parentAgent === parent) dropRecoveryRecord(reused.subagentId, "root generation retired", lateRecord);
                throw new Error("root generation is no longer live");
              }
              const restoredRecord = recoveryRecords.get(reused.subagentId);
              recovery.rememberContext(restoredRecord, { routeKey, request, label, taskKey });
              if (reused.reused !== true) persistChildDispatch(reused.subagentId, restoredRecord, request, label, reused.messageId);
              return reused;
            }
          }
        }
        // 新建 child（route 已变 / 快照恢复失败 / NOT_RESUMABLE 重试）。
        // P3：在 startContinuable **之前**预登记 pendingCreations——agent/created
        // 在创建过程中同步触发（早于 promise resolve），inbox claimed 可能在此
        // 之前按任务文本补绑 binding；预登记让 agent/created 立即写入
        // pendingMessage 绑定，消除「消息已认领但 record.tasks 尚无绑定」的
        // acceptance 竞态。父+角色在 scope 临界区内串行，同 scope 最多一项。
        const pendingHandoffAdmission = handoffExpected === true
          ? registerPendingHandoffAdmission(parent, role, void 0, taskKey)
          : void 0;
        const creationTransaction = {
          parent, rootToken, taskKey, activityId, handoffAdmission: pendingHandoffAdmission,
          childId: void 0, agent: void 0, record: void 0, recordOwned: false, taskBindingOwned: false,
        };
        const pendingCreation = { parent, rootToken, taskKey, parentId: parent.id, role, activityId, handoffExpected, handoffAdmission: pendingHandoffAdmission, transaction: creationTransaction };
        pendingCreations.push(pendingCreation);
        let acceptedChildId;
        try {
          let childId;
          let messageId;
          try {
            ({ childId, messageId } = await subagents.startContinuable({
              provider: "spawn",
              label,
              request,
              signal,
            }));
          } catch (error) {
            // 容量耗尽在 admission 边界就翻译成 DEG 自有可读错误：后续清理/回滚错误
            // 一旦覆盖原始 code，上层就无法再归入「可重试的容量」而是泛化失败。
            const capacityError = createSubagentCapacityError(error);
            if (capacityError !== undefined) throw capacityError;
            throw error;
          }
          acceptedChildId = childId;
          if (typeof childId !== "string" || childId.length === 0 || typeof messageId !== "string" || messageId.length === 0) throw new Error("startContinuable returned an invalid acceptance");
          if (!host.lineage.isLiveGeneration(parent, rootToken)) {
            if (pendingHandoffAdmission !== void 0) {
              failPendingHandoffAdmission(parent, pendingHandoffAdmission, recoveryRecords.get(childId));
              removePendingHandoffAdmission(pendingHandoffAdmission);
            }
            const lateRecord = recoveryRecords.get(childId);
            if (lateRecord?.parentAgent === parent) dropRecoveryRecord(childId, "root generation retired", lateRecord);
            throw new Error("root generation is no longer live");
          }
          if (pendingHandoffAdmission !== void 0) bindPendingHandoffAdmission(pendingHandoffAdmission, childId, messageId);
          // 多 child 边界：不同任务的独立 child 并存，因此**只有显式指定/复用同一
          // child 的路径**才取代该 child 未 acceptance 的 recovery。新建独立 child
          // 绝不 supersede 其他 child 的 recovery（否则会打断那个 child 的自愈链）。
          // 复用/续作路径由 reuseOrSteer / continueExplicitChild 自己完成取代。
          if (explicitContinue === true && retiredChildId !== void 0 && retiredChildId !== childId) {
            supersedePendingRecoveryOps(retiredRecord ?? recoveryRecords.get(retiredChildId));
          }
          delegationTracker.setChild(scope, { childId, routeKey });
          if (activityId !== void 0) delegationTracker.bindActiveTask(activityId, childId, messageId);
          // 任务记忆必须带上它自己的 child：相同 prompt 之后复用的是这个 child，
          // 而不是本 scope 最近一次新建的 child。
          delegationTracker.rememberTask(scope, taskKey, { childId, routeKey });
          // P3 防御：agent/created 应已消费预登记项；异常路径（未命中）时清理
          // 残留，防止下次同 scope 新建误匹配旧 taskKey。
          const staleIdx = pendingCreations.indexOf(pendingCreation);
          if (staleIdx !== -1) pendingCreations.splice(staleIdx, 1);
          // 确保恢复记录存在（事件处理据此关联 turn；重启后冷恢复的 child 也在此登记）。
          // startContinuable 返回时消息 id 已确定：回填 agent/created 预登记的
          // pendingMessage 绑定（claimed 补绑可能已先行回填）；找不到绑定（预登记
          // 未命中/已被上限淘汰）则直接写完整绑定，保持幂等。
          // S2：route 切换**不**删除旧 child 的 record——records 随父代理销毁/插件
          // 卸载清理，数量以 child 计，可接受（惰性清理函数已移除）。
          const existingRecord = recoveryRecords.get(childId);
          const record = ensureRecoveryRecord(childId, parent.id, role, parent, void 0, true);
          creationTransaction.childId = childId;
          if (creationTransaction.record === void 0) {
            // agent/created 可能已同步消费 pendingCreation；此时必须保留它
            // 已记录的 recordOwned=true，不能因本阶段再次 get 到同一 record
            // 就把新建事务误判为 durable 旧 record。
            creationTransaction.record = record;
            creationTransaction.recordOwned = existingRecord === void 0;
          }
          creationTransaction.agent = record.agent;
          registerPluginExpertChildAgent(agents.get(childId) ?? creationTransaction.agent);
          const binding = record.tasks.get(taskKey);
          if (binding !== void 0 && binding.pendingMessage === true && binding.messageId === null) {
            if (creationTransaction.binding === void 0) {
              creationTransaction.binding = binding;
              creationTransaction.taskBindingOwned = false;
            }
            binding.messageId = messageId;
            binding.pendingMessage = false;
          } else {
            const previousBinding = binding;
            const nextBinding = { messageId, childId };
            record.tasks.set(taskKey, nextBinding);
            creationTransaction.previousBinding = previousBinding;
            creationTransaction.binding = nextBinding;
            // fallback binding 同样是本 acceptance 写入；有旧值时由 helper 恢复，
            // 无旧值时由 helper 删除。
            creationTransaction.taskBindingOwned = true;
            evictOldestEntries(record.tasks, TASK_BINDING_LIMIT);
          }
          delete record.invalidAcceptance;
          recovery.rememberContext(record, { routeKey, request, label, taskKey });
          persistChildDispatch(childId, record, request, label, messageId);
          return { kind: "continuable", subagentId: childId, messageId, handoffAdmission: pendingHandoffAdmission };
        } catch (error) {
          // 事务所有权覆盖 agent/created 已同步消费 pendingCreation 的情况；
          // 先解绑 exact admission/activity/task，再处理 root 代际的迟到 child。
          rollbackCreationTransaction(creationTransaction, "startContinuable acceptance failed");
          if (!host.lineage.isLiveGeneration(parent, rootToken) && acceptedChildId !== void 0) {
            const lateRecord = recoveryRecords.get(acceptedChildId);
            if (lateRecord?.parentAgent === parent) dropRecoveryRecord(acceptedChildId, "root generation retired", lateRecord);
          }
          // startContinuable 抛错：删除对应 pending 项（agent/created 未消费时
          // 清理残留，防泄漏；被消费过则 indexOf 为 -1，无操作）。
          const pendingIdx = pendingCreations.indexOf(pendingCreation);
          if (pendingIdx !== -1) pendingCreations.splice(pendingIdx, 1);
          throw error;
        }
      }

      /**
       * 在同父代理的短临界区内完成范围预检和活动登记，再释放该锁执行实际
       * start/sendMessage。这样不同角色的独立任务仍并行，但相交范围无法
       * 同时穿过空登记表。同一任务（或显式 childId 续作）沿用既有复用/续作语义，
       * 不再登记第二个活动项；**不同任务**则各自登记独立活动项并新建独立 child，
       * 因此多个独立 child 的范围冲突仍由 affectedPaths 预检覆盖。
       * admission 失败会立即释放本次预登记。
       */
      async function delegateWithScopeAdmission({ scope, taskKey, routeKey, request, parent, signal, label, queue = false, affectedPaths, allowOverlap = false, handoffExpected = false, rootToken, explicitChildId }) {
        if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        const current = delegationTracker.getChild(scope);
        // 显式 childId 在上层已经校验过归属，因此它天然是「已存在目标」；其余情况
        // 只有「同一归一化任务仍绑定到本 scope 的 child」才算重复任务。绑定指向的
        // child 已从本 scope 退出（重建/清理过）时按新任务处理，避免对消失的 child
        // 反复返回无法续作的 advisory。
        const bound = delegationTracker.getTaskChild(scope, taskKey);
        const boundIsLive = bound !== void 0 && trackerChildIdsForScope(scope, taskKey, { parent }).includes(bound.childId);
        const knownDuplicate = explicitChildId !== void 0
          || (boundIsLive && bound.routeKey === routeKey);
        if (knownDuplicate) {
          return delegateBackground({
            scope, taskKey, routeKey, request, parent, signal, label, queue, handoffExpected, rootToken,
            explicitChildId,
            // 相同任务一律按「它自己绑定的 child」续作（可能就是最近 child）。
            continuationChildId: explicitChildId === void 0 && boundIsLive ? bound.childId : void 0,
          });
        }
        const admission = await delegationTracker.serializeParent(parent.id, () => {
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          const check = delegationTracker.checkActiveTaskScope({ parentId: parent.id, affectedPaths, allowOverlap });
          if (check.blocked === true) return { kind: "advisory", started: false, accepted: false, reason: "scope-conflict", code: "SCOPE_CONFLICT", warning: check.warning };
          const activity = delegationTracker.registerActiveTask({
            parentId: parent.id,
            parentAgent: parent,
            role,
            taskKey,
            description: label,
            affectedPaths,
          });
          return {
            activityId: activity.id,
            ...(typeof check.warning === "string" && check.warning.length > 0 ? { scopeWarning: check.warning } : {}),
          };
        });
        if (admission.kind === "advisory") return admission;
        if (!host.lineage.isLiveGeneration(parent, rootToken)) {
          delegationTracker.releaseActiveTask(admission.activityId);
          throw new Error("root generation is no longer live");
        }
        try {
          const outcome = await delegateBackground({
            scope, taskKey, routeKey, request, parent, signal, label, queue, activityId: admission.activityId, handoffExpected, rootToken, explicitChildId,
          });
          if (!host.lineage.isLiveGeneration(parent, rootToken)) {
            delegationTracker.releaseActiveTask(admission.activityId);
            const lateRecord = recoveryRecords.get(outcome?.subagentId);
            if (lateRecord?.parentAgent === parent) dropRecoveryRecord(outcome.subagentId, "root generation retired", lateRecord);
            removePendingHandoffAdmission(outcome?.handoffAdmission);
            throw new Error("root generation is no longer live");
          }
          return {
            ...outcome,
            ...(admission.scopeWarning === void 0 ? {} : { scopeWarning: admission.scopeWarning }),
          };
        } catch (error) {
          delegationTracker.releaseActiveTask(admission.activityId);
          throw error;
        }
      }

      // 浏览器原生提交会通过私有的 sendSession 进入这里的 Host RPC；Observer
      // 路由复用与 role tool 相同的 selection、PNG 预处理和 child admission，避免
      // 自动图片入口另起一套未经持久化/去重的子代理生命周期。
      if (role === "observer") {
        // 注意：这里**刻意不接收** text —— 自动图片入口不得把用户原始文本（可能是主任务、
        // 路径、秘密或提示注入载荷）交给 Observer。需要用户视觉问题的场景只能走 role tool
        // 手工调用路径（由主代理显式构造 prompt），自动入口只派发固定纯视觉任务。
        // onAccepted 是 admission 边界的只读回执：两阶段 commit 需要 childId 做失败清理。
        routeImageToObserver = async ({ parent, image, images, signal, preparedAttachments, onAccepted }) => {
          throwIfAborted(signal);
          const rootToken = host.lineage.tokenFor(parent);
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          const resolvedRole = resolveRole(parent.id, role);
          if (resolvedRole == null) throw new Error("Observer 专家尚未配置模型，请先在设置页选择 Observer 模型");
          const selection = await validateSelectionWithSignal(resolvedRole, signal);
          throwIfAborted(signal);
          let targetInfo;
          try {
            targetInfo = await llm.resolveModelInfo(selection.provider, selection.model, signal);
          } catch (error) {
            // 取消不能被"能力查询失败"兜底吞掉：原样上抛，由 mapRpcError 映射为 499。
            const aborted = abortErrorFor(error, signal);
            if (aborted !== void 0) throw aborted;
            throw new Error("Observer 模型 image 能力查询失败，无法安全投递图片；原始输入已保留", { cause: error });
          }
          throwIfAborted(signal);
          if (imageCapability(targetInfo) !== "supported") {
            throw new Error("Observer 模型未明确声明 image 输入能力，无法安全投递图片；原始输入已保留");
          }
          const inputImages = Array.isArray(images) && images.length > 0 ? images : [image];
          const imageAttachments = Array.isArray(preparedAttachments)
            ? preparedAttachments.slice()
            : await Promise.all(inputImages.map((inputImage) => prepareRoleImage({ attachment: inputImage }, signal, "Observer")));
          throwIfAborted(signal);
          if (imageAttachments.length === 0) throw new Error("Observer 图片输入不能为空；原始输入已保留");
          // 自动图片入口只给 Observer 派发**纯视觉子任务**：正文固定为视觉契约 + 无用户
          // 文字上下文说明（函数不接受任何用户输入），主任务仍由主代理持有并综合。
          const observerTaskPrompt = buildExpertTaskPrompt("observer", buildObserverVisualTask());
          const promptContent = buildImageContent({ attachments: imageAttachments, text: observerTaskPrompt, role: "Observer" });
          const request = {
            label: "用户图片",
            prompt: promptContent,
            parent,
            agentOptions: {
              provider: selection.provider,
              model: selection.model,
              [EFFORT_MARKER]: selection.reasoningEffort,
              [ROLE_MARKER]: role,
              [PARENT_MARKER]: parent.id,
              [CONTINUABLE_MARKER]: true,
            },
            persona: resolvePersonaForAdmission("observer"),
            toolFilter: { deny: ensureExpertSendMessageDenied(effectiveDeny(parent, READONLY_DENY, true)) },
            maxDepth: 1,
          };
          const scope = delegationScopeKey(parent.id, role);
          // 去重必须使用与真实 child prompt 相同的规范化 Observer 任务，兼容旧/新包装复用。
          const taskKey = delegationTaskKey(observerTaskPrompt + "\n[images:" + imageAttachments.map((attachment) => attachment.attachmentId).join(",") + "]");
          const routeKey = routeKeyOf(selection);
          throwIfAborted(signal);
          const outcome = await delegationTracker.serialize(scope, () => delegateWithScopeAdmission({
            scope,
            taskKey,
            routeKey,
            request,
            parent,
            signal,
            label: "用户图片",
            affectedPaths: [],
            allowOverlap: false,
            handoffExpected: false,
            rootToken,
          }));
          // 先把已接受的 child 上报给调用方（admission 之后仍可能因为取消/路由变化失败，
          // 调用方需要 childId 才能用公开 subagents.interrupt 尽力清理这个已创建的 child）。
          if (typeof onAccepted === "function" && outcome?.kind === "continuable" && typeof outcome.subagentId === "string") {
            onAccepted(outcome.subagentId);
          }
          // admission 之后再次 fail-fast：客户端已取消时不得把已启动的 Observer 当成功返回
          // （child 已创建无法撤回，但结果必须保持 gateway/cancelled 语义）。
          throwIfAborted(signal);
          if (outcome?.kind !== "continuable" || typeof outcome.subagentId !== "string") {
            throw new Error(outcome?.warning ?? outcome?.reason ?? "Observer 图片 admission 未接受");
          }
          return { childId: outcome.subagentId, attachments: imageAttachments, reused: outcome.reused === true };
        };
      }

      const disposeTool = ctx.effect(() => tools.register(defineTool({
        name: role,
        description: buildRoleToolDescription(role),
        parameters: {
          description: {
            type: "string",
            required: true,
            description: "A 3-5 word task label.",
          },
          prompt: {
            type: "string",
            required: true,
            description: "A complete self-contained task for the expert child.",
          },
          affectedPaths: {
            type: "array",
            items: { type: "string" },
            description: "Optional files, directories (trailing slash or dir:), or symbols (symbol:). Omit only when scope cannot be checked.",
          },
          image: {
            type: "object",
            additionalProperties: false,
            description: "Optional image attachment. Provide this parameter ONLY when forwarding a real image attachment from the current conversation; omit it entirely when there is no image and never fabricate or placeholder-fill attachment metadata. The Host makes a real PNG durable copy for extensionless names. Do not guess a path.",
            properties: {
              attachment: {
                type: "object",
                required: true,
                additionalProperties: false,
                properties: {
                  attachmentId: { type: "string", required: true },
                  mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"], required: true },
                  bytes: { type: "integer", required: true },
                  width: { type: "integer", required: true },
                  height: { type: "integer", required: true },
                  name: { type: "string" },
                },
              },
            },
          },
          allowOverlap: {
            type: "boolean",
            default: false,
            description: "Set true only when an affected-path overlap is explicitly safe; otherwise a conflict returns an advisory without child action.",
          },
          run_in_background: {
            type: "boolean",
            description: "Compatibility input only: omitted, true, and false all use non-blocking admission; false never waits for child output or feedback.",
          },
          continue_parent_turn: {
            type: "boolean",
            default: false,
            description: "Set true only for explicitly confirmed immediate independent work with non-overlapping affectedPaths; otherwise leave false and inspect outcomes before root-only finalize.",
          },
          queue: {
            type: "boolean",
            default: false,
            description: "Only meaningful together with childId (an explicit continuation): queue=true delivers the follow-up through the public subagents.sendMessage path and never requests a cancel; queue=false may first request a public interrupt for an explicit pause/redirect. Without childId the value is ignored because a different prompt always starts an independent child. This is not a waiting mechanism; DSH delivers feedback later.",
          },
          childId: {
            type: "string",
            description: "Optional explicit continuation handle: the subagentId returned by an earlier role-tool admission. When set, this prompt is delivered to exactly that child. Omit it to dispatch a brand-new independent task: a different prompt never continues or redirects an existing child on its own.",
          },
          cancelChildId: {
            type: "string",
            description: "Optional explicit cancel handle: request cancellation of exactly this child (public subagents.interrupt) without dispatching a task or sending any message. Takes precedence over childId. Cancelling is always addressed by an exact childId; this tool never guesses a target from the parent session and role, so other independent children stay running.",
          },
        },
        output: {
          schema: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "continuable" },
                  started: { type: "boolean" },
                  accepted: { type: "boolean" },
                  admissionEpoch: { type: "number", required: true },
                  admissionToken: { type: "string", required: true },
                  subagentId: { type: "string", required: true },
                  // startContinuable/sendMessage 的 admission messageId 是调用方关联 turn 的公开结果。
                  // 旧快照复用且没有任务绑定时可能没有新消息，因此保持可选。
                  messageId: { type: "string" },
                  // 可选标志：reused = 重复任务复用既有 child（未排队）；
                  // queued = 已排队到既有 child。二者都保持 started 文案兼容。
                  reused: { type: "boolean" },
                  queued: { type: "boolean" },
                  scopeWarning: { type: "string" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "advisory" },
                  started: { type: "boolean", required: true, const: false },
                  accepted: { type: "boolean", required: true, const: false },
                  admissionEpoch: { type: "number", required: true },
                  admissionToken: { type: "string", required: true },
                  reason: { type: "string", required: true },
                  code: { type: "string", required: true },
                  warning: { type: "string", required: true },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "failure" },
                  started: { type: "boolean", required: true, const: false },
                  accepted: { type: "boolean", required: true, const: false },
                  admissionEpoch: { type: "number", required: true },
                  admissionToken: { type: "string", required: true },
                  reason: { type: "string", required: true },
                  code: { type: "string", required: true },
                  message: { type: "string", required: true },
                },
              },
              {
                // 显式句柄（childId / cancelChildId）在 admission 之前被拒绝：没有登记新
                // admission、没有创建或投递任何 child，因此**不带** admissionEpoch/
                // admissionToken。用独立 kind 与带凭据的 advisory/continuable 明确区分：
                // 伪造凭据会让模型把它当成真实 child admission 并拿去 finalize。
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "rejected" },
                  started: { type: "boolean", required: true, const: false },
                  accepted: { type: "boolean", required: true, const: false },
                  reason: { type: "string", required: true },
                  code: { type: "string", required: true },
                  warning: { type: "string", required: true },
                },
              },
              {
                // 显式取消（cancelChildId）的结果：只报告按 childId 定位的取消请求，
                // 既不是新 admission 也不是失败，因此保持独立变体。
                type: "object",
                additionalProperties: false,
                properties: {
                  kind: { type: "string", required: true, const: "cancelled" },
                  started: { type: "boolean", required: true, const: false },
                  accepted: { type: "boolean", required: true, const: true },
                  cancelled: { type: "boolean", required: true, const: true },
                  childId: { type: "string", required: true },
                },
              },
            ],
          },
          render(_args, value) {
            // admissionEpoch/admissionToken 是 root-only finalize 收口必需的公开凭据，必须
            // 出现在模型可见的 render 文本里：epoch 是模块级单调计数器（跨会话累计、重启
            // 归零），模型既无法从其他工具返回中读到、也无法推断；schema 的 continuable/
            // advisory/failure 三个变体都把它们标注为 required，但只渲染人性化文案会让模型
            // 只能靠猜 token 反复调用 finalize
            // （线上实测：连续 5 次匹配失败）。这里统一追加，保持单行紧凑文本。
            // 取消结果不携带 admission 凭据（它不进 admission 批次），因此只在凭据
            // 确实存在时追加后缀；其余变体保持既有文案与凭据位置不变。
            const admission = Number.isSafeInteger(value.admissionEpoch)
              ? ' (admissionEpoch: ' + value.admissionEpoch + ', admissionToken: "' + value.admissionToken + '")'
              : "";
            if (value.kind === "advisory") return [{ type: "text", text: value.warning + admission }];
            // 显式句柄在 admission 之前被拒绝：没有 admission 凭据可渲染，只报可读原因。
            if (value.kind === "rejected") return [{ type: "text", text: value.warning }];
            if (value.kind === "failure") return [{ type: "text", text: `${role} admission failed: ${value.message}${admission}` }];
            // 取消是按 childId 定位的独立动作：文案必须点名被取消的 child，避免模型
            // 以为这是对「当前角色」的批量操作。
            if (value.kind === "cancelled") return [{ type: "text", text: `cancelled ${role} subagent ${value.childId}: cancel requested for the exact childId${admission}` }];
            const notice = typeof value.scopeWarning === "string" && value.scopeWarning.length > 0
              ? [{ type: "text", text: value.scopeWarning }]
              : [];
            // 复用/排队与新建使用不同的明确文案；保持原有 started 文案兼容。
            if (value.reused === true) {
              return [...notice, { type: "text", text: `reused ${role} subagent ${value.subagentId}: duplicate task detected, no new prompt queued${admission}` }];
            }
            if (value.queued === true) {
              return [...notice, { type: "text", text: `steered ${role} subagent ${value.subagentId} at next-step${admission}` }];
            }
            return [...notice, { type: "text", text: `started ${role} subagent ${value.subagentId}${admission}` }];
          },
        },
        // 角色工具会修改 admission、handoff、recovery、settings 和 storage 状态。
        // 不声明 isConcurrencySafe，让 DSH 以默认 exclusive 模式调度，避免把这些
        // 共享状态写入误判为可与兄弟工具并行执行。
        async execute(args, exec) {
          const parent = exec?.agent;
          const signal = exec?.signal;
          if (!parent) throw new Error(`${role} subagent tool requires a calling agent (exec.agent was undefined)`);
          const rootToken = host.lineage.tokenFor(parent);
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          // 插件委派工具只属于根/父代理。子代理即使因运行时工具合并而看见
          // role-named expert tools，也必须在执行边界被拒绝，避免再次自我委派或绕过父代理编排。
          if (parent.session?.header?.parentSession !== void 0) {
            throw new Error(`${role} is root-only; child agents are leaf workers and must report to their parent`);
          }
          // 显式句柄（cancelChildId / childId）的输入边界：字段只要**存在**就必须是合法的
          // 非空、非纯空白字符串。空串/纯空白/非字符串一律 fail-closed，绝不被当作「未提供」
          // 而继续普通派发或新建 child。校验发生在 beginRootAdmission 之前：被拒绝的句柄不
          // 登记任何 admission、不产生凭据、也绝不 interrupt 或派发（见 rejectedHandleResult）。
          const cancelHandle = readExplicitHandle(args, "cancelChildId");
          if (cancelHandle.invalid === true) {
            return rejectedHandleResult(
              "invalid-child-id",
              "INVALID_CANCEL_CHILD_ID",
              role + " 取消被拒绝：cancelChildId 必须是非空字符串（收到 " + describeHandleValue(args?.cancelChildId)
                + "）；本次调用没有取消任何 child、也没有派发任何任务。要取消请传入此前回执里的 subagentId，"
                + "或者完全省略 cancelChildId",
            );
          }
          const continueHandle = readExplicitHandle(args, "childId");
          if (continueHandle.invalid === true) {
            return rejectedHandleResult(
              "invalid-child-id",
              "INVALID_CHILD_ID",
              role + " 续作被拒绝：childId 必须是非空字符串（收到 " + describeHandleValue(args?.childId)
                + "）；本条 prompt 没有派发。要续作请传入此前回执里的 subagentId，或完全省略 childId 派发新任务",
            );
          }
          // 显式取消（cancelChildId）优先于续作 childId，并且在 beginRootAdmission **之前**
          // 处理：它只按 childId 精确定位并请求取消，不派发任务、不投递消息、不登记新
          // admission，因此既不产生 finalize 需要收口的 token，也不会把 root 的当前
          // admission 批次留成未结算状态。缺少前置条件时 fail-closed。
          // 未知/越权目标返回无凭据的 rejected：它同样没有登记 admission，用带凭据的
          // advisory 会伪造出「已为这个 child 开了一批要 finalize 的 admission」的假象。
          if (cancelHandle.present === true) {
            if (!spawnProviderReady()) {
              throw new Error(`subagent provider "spawn" is not available (missing depthLimit/toolFilter/persona/prepareContinuable); the ${role} expert tool cannot cancel a child`);
            }
            const cancelled = await cancelExplicitChild({
              childId: cancelHandle.value,
              parent,
              scope: delegationScopeKey(parent.id, role),
            });
            return cancelled.ok === true
              ? { kind: "cancelled", started: false, accepted: true, cancelled: true, childId: cancelled.childId }
              : rejectedHandleResult("child-not-found", "CHILD_NOT_FOUND", cancelled.warning);
          }
          const admissionTicket = beginRootAdmission(parent);
          let failurePhase = "provider";
          try {
          if (!spawnProviderReady()) {
            throw new Error(`subagent provider "spawn" is not available (missing depthLimit/toolFilter/persona/prepareContinuable); the ${role} expert tool cannot start a child`);
          }
          failurePhase = "selection";
          const resolvedRole = resolveRole(parent.id, role);
          if (resolvedRole == null) {
            throw new Error(`${role} 专家尚未配置模型：请在“dsh-expert-group”设置页为该角色选择模型（候选来自设置中已添加的模型）；右侧「专家模型」侧边栏仅用于当前会话点击“应用”`);
          }
          const selection = await validateSelectionWithSignal(resolvedRole, signal);
          if (!host.lineage.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
          // 所有专家（含 designer/fixer）都禁止再委派（防孙代理）；只读角色再叠加
          // 写/命令限制。deny 列表必须按“当前组合里实际可见的工具”动态计算：
          // 平台门控的 bash/pwsh 与 preset 域内的 workflow 可能不存在，
          // 静态全量列入会在子代理创建窗口触发 tools.restrict 的未知工具错误。
          const deny = readOnly(role)
            ? effectiveDeny(parent, READONLY_DENY, true)
            // 保留历史再委派 deny 的调用边界，再叠加只属于 root 的通知工具。
            : [...effectiveDeny(parent, EXPERT_DELEGATION_DENY), ...effectiveDeny(parent, ROOT_ONLY_TOOL_DENY)];
          // send_message 是 scope-local 工具，不能依赖 effectiveDeny 的全局可见性判断；
          // 显式加入 child filter 后，DSH 不会再向专家追加英文通信指令。
          const childDeny = ensureExpertSendMessageDenied(deny);
          const taskPrompt = buildExpertTaskPrompt(role, args.prompt);
          failurePhase = "admission";
          let promptContent = [{ type: "text", text: taskPrompt }];
          let imageAttachment;
          // 主代理在没有真实图片时也可能构造 image 参数（attachmentId 为空串/全零
          // 尺寸，或显式命名为 "placeholder"）。这类输入不代表任何真实图片，按
          // “无图片”处理：忽略该参数、正常拉起子代理，并在返回中附带 scopeWarning
          // 提醒模型下次完全省略，而不是让整个 admission 失败导致子代理拉不起来。
          let ignoredImageWarning = "";
          if (args.image !== void 0) {
            const imageRole = role === "observer" ? "Observer" : role;
            if (Object.prototype.hasOwnProperty.call(args.image, "pngPath")
              && typeof args.image.pngPath === "string" && args.image.pngPath.length > 0) {
              throw new Error(`${imageRole} image 不接受客户端提供的 pngPath；原始输入已保留`);
            }
            // 空值/非对象输入不携带任何图片信息，同样按无图片处理。
            const looksEmpty = args.image === null || typeof args.image !== "object" || Array.isArray(args.image)
              || isEmptyImagePlaceholderMeta(args.image.attachment);
            if (looksEmpty) {
              ignoredImageWarning = `${imageRole} image 参数为空或占位元数据，已按“无图片”处理并忽略该参数；之后没有图片时请完全省略（omit）image 参数，不要构造占位 attachment 元数据`;
            } else {
              // 直接图片 admission 必须建立在目标 role 的模型明确声明 image 能力上；unknown 也拒绝，
              // 避免把图片交给可能只支持文本的 child。
            let targetInfo;
            try {
              targetInfo = await llm.resolveModelInfo(selection.provider, selection.model, signal);
            } catch (error) {
              throw new Error(`${imageRole} 模型 image 能力查询失败，无法安全投递图片；原始输入已保留`, { cause: error });
            }
            const imageRoute = decideImageRoute({
              // 直接 role tool 使用同一三态路由函数作为严格能力断言；返回的 target
              // 只用于判断是否可安全投递，不会把图片改路由到 Observer。
              mainImage: "unsupported",
              observerImage: imageCapability(targetInfo),
              observerPreferred: true,
            });
            if (imageRoute.target === "error") {
              const message = role === "observer"
                ? imageRoute.message
                : `${imageRole} 模型未明确声明 image 输入能力，无法安全投递图片；`;
              throw new Error(`${message} 原始输入已保留`);
            }
            imageAttachment = await prepareRoleImage(args.image, signal, imageRole);
            promptContent = buildImageContent({
              attachment: imageAttachment,
              text: taskPrompt,
               role: imageRole,
            });
            }
          }
          const request = {
            label: args.description,
            prompt: promptContent,
            parent,
            agentOptions: {
              provider: selection.provider,
              model: selection.model,
              [EFFORT_MARKER]: selection.reasoningEffort,
              // 角色/父代理 marker：agent/created 时与模型快照一同持久化，
              // 供重启后按 parentId+role+route 恢复可复用 child。
              [ROLE_MARKER]: role,
              [PARENT_MARKER]: parent.id,
            },
            // persona 在 admission 边界解析：设置页保存的自定义提示词只影响之后
            // 新建的 child，既有 running/idle/ready child 保持创建时的 persona。
            persona: resolvePersonaForAdmission(role),
            toolFilter: { deny: childDeny },
            // 第二道硬防线：专家是叶子工作者，maxDepth 1 禁止其再创建孙代理
            // （子代理 depth 为 1，再委派 depth 2 会触发 SubagentDepthError）。
            maxDepth: 1,
          };
          // 所有专家委派统一走可续接（continuable）子代理：
          // 无条件写入 continuable 标记，agent/created 据此持久化，重启恢复
          // 只接受带标记的 child（无 one-shot 路径）。
          request.agentOptions[CONTINUABLE_MARKER] = true;
          // 按 parent.id + role 进入临界区做去重与复用（所有模式共用，不绕过）。
          const scope = delegationScopeKey(parent.id, role);
          const taskInput = imageAttachment?.attachmentId
            ? `${taskPrompt}\n[image:${imageAttachment.attachmentId}]`
            : taskPrompt;
          const taskKey = delegationTaskKey(taskInput);
          const routeKey = routeKeyOf(selection);
          // run_in_background 只保留为兼容输入；省略、true、false 都统一走
          // 非阻塞 admission。是否结束当前 root turn 只由 continue_parent_turn 决定。
          const handoffExpected = args.continue_parent_turn !== true;
          // 显式续作句柄：只接受本 root 该角色已登记的 childId。校验失败直接返回
          // advisory，绝不回落到「当前 scope 最近 child」或新建 child。
          // 续作句柄的存在性/合法性已在上面的 pre-admission 边界判定：这里 present 即
          // 一定是合法的非空字符串，非法形态永远不会走到这一步（不会静默变成新建）。
          const continueRequested = continueHandle.present === true;
          const resolvedContinue = continueRequested
            ? resolveContinueTarget({ childId: continueHandle.value, parent, scope, taskKey, currentRouteKey: routeKey })
            : { target: void 0, warning: "" };
          if (continueRequested && resolvedContinue.target === void 0) {
            const warning = resolvedContinue.warning;
            return {
              kind: "advisory",
              started: false,
              accepted: false,
              reason: "child-not-found",
              code: "CHILD_NOT_FOUND",
              warning,
              admissionEpoch: admissionTicket.epoch,
              admissionToken: admissionTicket.token,
            };
          }

          // 所有输入形态都只等待 scope/admission、必要的 child 投递和 Goal pause CAS，
          // 绝不等待 child 的最终文本、turn/end、自动恢复或 feedback。
          return delegationTracker.serialize(scope, () =>
            delegateWithScopeAdmission({
              scope, taskKey, routeKey, request, parent, signal: exec.signal, label: args.description,
              queue: args.queue === true, affectedPaths: args.affectedPaths, allowOverlap: args.allowOverlap === true,
              handoffExpected, rootToken,
              explicitChildId: resolvedContinue.target?.childId,
            })
          ).then((outcome) => {
            // role tool 只返回 admission 结果；root turn 等待由显式 finalize 处理。
            const admissionFields = { admissionEpoch: admissionTicket.epoch, admissionToken: admissionTicket.token };
            const visibleOutcome = outcome.kind === "advisory"
              ? { ...outcome, ...admissionFields }
              : {
                kind: "continuable",
                started: true,
                accepted: true,
                ...admissionFields,
                subagentId: outcome.subagentId,
                ...(typeof outcome.messageId === "string" ? { messageId: outcome.messageId } : {}),
                ...(outcome.reused === true ? { reused: true } : {}),
                ...(outcome.queued === true ? { queued: true } : {}),
                // 两个 scopeWarning 来源（delegationTracker 的范围软警告 + 忽略占位 image
                // 的提示）必须拼接而不是互相覆盖：对象展开的后者覆盖前者会让范围软警告
                // 对模型不可见（审核发现的既有缺陷）。任一为空时保持另一段原文。
                ...(mergeScopeWarnings(outcome.scopeWarning, ignoredImageWarning).length === 0
                  ? {}
                  : { scopeWarning: mergeScopeWarnings(outcome.scopeWarning, ignoredImageWarning) }),
              };
            recordRootAdmissionOutcome(admissionTicket, {
              ...outcome,
              continueParentTurn: args.continue_parent_turn === true,
            });
            admissionTicket.settle();
            return visibleOutcome;
          }).catch((error) => {
            const failure = roleAdmissionFailure(failurePhase, error);
            const visibleFailure = {
              kind: "failure",
              started: false,
              accepted: false,
              admissionEpoch: admissionTicket.epoch,
              admissionToken: admissionTicket.token,
              ...failure,
            };
            recordRootAdmissionOutcome(admissionTicket, visibleFailure);
            admissionTicket.settle();
            return visibleFailure;
          });
          } catch (error) {
            const failure = roleAdmissionFailure(failurePhase, error);
            const visibleFailure = {
              kind: "failure",
              started: false,
              accepted: false,
              admissionEpoch: admissionTicket.epoch,
              admissionToken: admissionTicket.token,
              ...failure,
            };
            recordRootAdmissionOutcome(admissionTicket, visibleFailure);
            admissionTicket.settle();
            return visibleFailure;
          }
        },
      })), "dsh-expert-group: tool " + role);


      toolDisposers.set(role, disposeTool);
    }

    /** 卸载某角色工具及其 effect；幂等。 */
    function unmountRole(role) {
      if (role === "observer") routeImageToObserver = void 0;
      const dispose = toolDisposers.get(role);
      if (dispose === void 0) return;
      toolDisposers.delete(role);
      try { dispose(); } catch (error) {
        ctx.logger.warn(`dsh-expert-group: dispose tool ${role} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    /**
     * 通用 fan-out 工具只注册一个入口，role 由参数选择；它与旧的 role-named 工具
     * 共享 provider 能力检测，但不进入 delegationTracker 的单 child 去重路径。
     */
    function mountFanoutTool() {
      if (toolDisposers.has("fanout") || !spawnProviderReady()) return;
      const disposeTool = ctx.effect(() => tools.register(defineTool({
        name: "fanout",
        description: "向一个专用 role 提交多个独立 shard 的 fan-out 任务；原子校验、per-role 并发、wait-all、取消与手工重试由 Host 管理，调用立即返回 parentTaskId。"
          + "同一逻辑任务需要多轮续作（例如按上一轮结果继续修）时，不要重复提交新任务：带 continuation.parentTaskId 再调用本工具即可复用同一个父任务与同一批 child，"
          + "每个分片会新增一个 attempt（保留原 childId、保留历史 attempt），提交后父任务立即回到 running，本轮全部分片结束后回到 ready 并可继续下一轮。"
          + "工具回执里的 continuation 字段给出 parentTaskId/shardId/childId/attempt/父级状态/reusable 以及下一轮调用所需字段。",
        parameters: {
          role: { type: "string", enum: activeRoles(), required: true, description: "One enabled expert role shared by all shards. 复用时必须与原任务的 role 一致。" },
          basePrompt: { type: "string", required: true, description: "Shared public goal delivered to every shard child. 复用时它是**本轮**的共享目标。" },
          shards: {
            type: "array",
            required: true,
            description: "Ordered non-empty shard list; every item needs a unique shardId and prompt. Optional name is the human-readable shard task name shown after the shard id in the Expert Group sidebar (shard id stays the stable key for cancel/retry). 复用时必须与原任务的分片数量与 shardId 结构完全一致，prompt 是本轮该分片的指令。",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                shardId: { type: "string", required: true },
                name: {
                  type: "string",
                  description: "Optional human-readable shard task name, e.g. 实现添加任务名称. Trimmed, non-blank and at most 256 UTF-8 bytes; omitted names fall back to shardId in the sidebar.",
                },
                prompt: { type: "string", required: true },
                affectedPaths: { type: "array", items: { type: "string" } },
              },
            },
          },
          continuation: {
            type: "object",
            additionalProperties: false,
            description: "可选：把本次调用作为**同一逻辑 fan-out 任务的下一轮续作**。给出上一轮回执里的 parentTaskId，并用 role/basePrompt/shards 描述本轮指令；role 与 shardId 结构必须与原任务一致。要求上一轮 wait-all 已完成（回执 continuation.reusable=true）。",
            properties: {
              parentTaskId: { type: "string", required: true, description: "上一轮回执里的 parentTaskId（必须属于当前 root）。" },
              requestId: { type: "string", description: "可选幂等键：同一 requestId 的重复续作不会重复追加 attempt。" },
            },
          },
          requestId: { type: "string", description: "Optional idempotency key for a new task (ignored when continuation is present; use continuation.requestId there)." },
          allowOverlap: { type: "boolean", default: false, description: "Explicitly allow write-role affectedPaths overlap." },
          concurrencyLimit: {
            type: "integer",
            description: "Optional per-task running-child limit from 1 to 64, counted against this task's own running shards only. Dispatch requires BOTH this task-level limit AND the per-role shared pool (settings roleConcurrencyLimit, current value, plugin default 10) to allow the shard; the two caps are enforced independently. The per-role pool is a shared cap for the whole role and follows the current setting, so it may grow or shrink for later dispatches; a task-level value is frozen into the task snapshot and survives restore.",
          },
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", const: "fanout", required: true },
              accepted: { type: "boolean", required: true },
              parentTaskId: { type: "string", required: true },
              role: { type: "string", required: true },
              status: { type: "string", required: true },
              duplicate: { type: "boolean" },
              reopened: { type: "boolean" },
              round: { type: "integer" },
              shardIds: { type: "array", items: { type: "string" }, required: true },
              // continuation 句柄：parentTaskId/shardId/childId/attempt/父级状态/reusable 与
              // 下一轮调用字段；内容随状态机扩展，这里允许额外字段。
              continuation: { type: "object", additionalProperties: true },
              // task 是 manager 的只读快照，字段随状态机版本扩展；这里明确允许额外字段。
              task: { type: "object", additionalProperties: true },
            },
          },
          render(_args, value) {
            const continuation = value?.continuation;
            const suffix = continuation === undefined
              ? ""
              : "; continuation: round " + continuation.round + " " + (continuation.running ? "running" : "ready")
                + ", reusable=" + (continuation.reusable === true)
                + ", nextAttemptByShard=" + JSON.stringify(continuation.nextAttemptByShard ?? {});
            const verb = value?.reopened === true ? " continued" : " accepted";
            return [{
              type: "text",
              text: "fan-out " + value.parentTaskId + verb + " (" + value.status + "); shards: "
                + (value.shardIds ?? []).join(", ") + suffix,
            }];
          },
        },
        async execute(args, exec) {
          const parent = exec?.agent;
          if (parent === void 0) throw new Error("fanout tool requires a calling root agent");
          if (parent.session?.header?.parentSession !== void 0) throw new Error("fanout is root-only; child agents cannot create fan-out tasks");
          if (!host.lineage.isLiveGeneration(parent, host.lineage.tokenFor(parent))) throw new Error("root generation is no longer live");
          if (!spawnProviderReady()) throw new Error("subagent provider spawn is not ready");
          const role = typeof args?.role === "string" ? args.role.trim() : "";
          if (!activeRoles().includes(role)) throw new Error("未启用的 fan-out role: " + role);

          // 多轮复用：复用判定由主代理发起，插件负责校验 + 执行 + 回执。复用时不再解析模型
          // （不新建 child），但仍要求 role 属于当前启用的 role 集合，避免对被禁用的 role 续作。
          const continuation = args?.continuation;
          if (continuation !== void 0 && continuation !== null) {
            if (typeof continuation !== "object" || Array.isArray(continuation)) {
              throw new Error("continuation 必须是对象（{ parentTaskId, requestId? }）");
            }
            const parentTaskId = typeof continuation.parentTaskId === "string" ? continuation.parentTaskId.trim() : "";
            if (parentTaskId.length === 0) throw new Error("continuation.parentTaskId 必须是非空字符串");
            if (exec?.signal?.aborted === true) throw createAbortError();
            const result = continueFanoutTask(parent, {
              parentTaskId,
              role,
              basePrompt: args?.basePrompt,
              shards: args?.shards,
              requestId: continuation.requestId,
            });
            const continuationHandle = buildFanoutContinuationHandle(result.task);
            return {
              kind: "fanout",
              accepted: true,
              parentTaskId: result.parentTaskId,
              role: result.role,
              status: result.status,
              reopened: true,
              // 幂等命中：同一 requestId 的重复续作不追加 attempt，回执显式标注 duplicate，
              // 让主代理知道这一轮已经提交过（避免误以为又开了一轮）。
              ...(result.duplicate === true ? { duplicate: true } : {}),
              ...(Number.isSafeInteger(result.round) ? { round: result.round } : {}),
              shardIds: result.shardIds,
              ...(continuationHandle === void 0 ? {} : { continuation: continuationHandle }),
              task: result.task,
            };
          }

          const selection = resolveRole(parent.id, role);
          if (selection === null) throw new Error(role + " 专家尚未配置模型");
          await validateSelectionWithSignal(selection, exec?.signal);
          if (exec?.signal?.aborted === true) throw createAbortError();
          const result = submitFanoutTask(parent, { ...args, role });
          const continuationHandle = buildFanoutContinuationHandle(result.task);
          return {
            kind: "fanout",
            accepted: true,
            parentTaskId: result.parentTaskId,
            role: result.role,
            status: result.status,
            ...(result.duplicate === true ? { duplicate: true } : {}),
            ...(Number.isSafeInteger(result.task?.round) ? { round: result.task.round } : {}),
            shardIds: result.shardIds,
            ...(continuationHandle === void 0 ? {} : { continuation: continuationHandle }),
            task: result.task,
          };
        },
      })), "dsh-expert-group: tool fanout");
      toolDisposers.set("fanout", disposeTool);
    }

    function unmountFanoutTool() {
      const dispose = toolDisposers.get("fanout");
      if (dispose === void 0) return;
      toolDisposers.delete("fanout");
      try { dispose(); } catch (error) { ctx.logger.warn("dsh-expert-group: dispose fanout tool failed: " + (error instanceof Error ? error.message : String(error))); }
    }

    /** 根据 provider 可用性与已挂载角色，动态重建编排提示词；provider 不可用时绝不声称工具可用。 */
    let routingDisposer;
    let orchestratorDisposer;
    function rootPromptText(text) {
      return (assemblyContext) => isRootAgentContext(assemblyContext) ? text : "";
    }
    function refreshRoutingPrompt() {
      if (routingDisposer !== void 0) {
        try { routingDisposer(); } catch {}
        routingDisposer = void 0;
      }
      if (orchestratorDisposer !== void 0) {
        try { orchestratorDisposer(); } catch {}
        orchestratorDisposer = void 0;
      }
      const providerReady = spawnProviderReady();
      const roles = activeRoles();
      if (config.enableOrchestrator === true) {
        orchestratorDisposer = systemPrompt.section({
          name: "dsh-expert-group:orchestrator",
          order: 1,
          text: (assemblyContext) => isRootAgentContext(assemblyContext)
            ? buildOrchestratorPrompt({
              roles,
              providerReady,
              observerPreferred: source().observerPreferred === true,
              rootSessionId: assemblyContext.agent.id,
            })
            : "",
        });
      }
      if (!providerReady) {
        const text = "The expert subagent team is currently unavailable because the \"spawn\" subagent provider is not ready" +
          (config.enableObserver === true ? " (observer would also be unavailable in this state)" : "") + ".";
        routingDisposer = systemPrompt.section({ name: "dsh-expert-group:routing", order: 117, text: rootPromptText(text) });
        return;
      }
      // 保留旧 routing 的稳定 role 列表，并在独立字段中追加通用 fanout 能力。
      const toolsText = roles.map((role) => `${role}`).join(", ");
      const routingToolsText = [...roles, "fanout"].join(", ");
      // routing 只提供 provider、角色和图片路由等动态事实；完整 workflow 已在 root
      // orchestrator system section 中出现一次，避免同一等待/收口契约再次膨胀 system 输入。
      const text = [
        `Enabled expert tools: ${routingToolsText || "none"}.`,
        ...(config.enableObserver === true ? [
          "Image tasks may use observer only when the current image routing policy allows it, and observer accepts only the Host-provided durable image attachment for that task; a client file path is never a substitute. Automatic image routing follows the fixed visual-only task contract; any role tool may receive a direct image attachment when its selected model explicitly supports image; preserve durable PNG attachment boundaries. Only pass the image parameter when forwarding a real image attachment; omit it entirely otherwise and never fabricate placeholder attachment metadata.",
        ] : []),
      ].join(" ");
      routingDisposer = systemPrompt.section({ name: "dsh-expert-group:routing", order: 117, text: rootPromptText(text) });
    }

    for (const role of activeRoles()) mountRole(role);
    mountFanoutTool();
    refreshRoutingPrompt();

    ctx.on("subagent/provider-added", (provider) => {
      if (provider?.name !== "spawn") return;
      for (const role of activeRoles()) mountRole(role);
      mountFanoutTool();
      refreshRoutingPrompt();
    });

    // provider-removed 载荷是 provider 名字符串；清理对应工具并让提示词如实反映不可用状态。
    ctx.on("subagent/provider-removed", (providerName) => {
      if (providerName !== "spawn") return;
      for (const role of activeRoles()) unmountRole(role);
      unmountFanoutTool();
      refreshRoutingPrompt();
    });

    // ── 私有 RPC（同源、仅 POST JSON）──────────────────────────────────────
    function sendJson(res, status, value) {
      return host.rpc.finalizeResponse(res, status, value);
    }
    function sendText(res, status, value) {
      return host.rpc.finalizeResponse(res, status, value);
    }
    /**
     * legacy HTTP 错误信封。details 只在确有结构化附加信息时携带（当前只有 settings
     * 冲突的权威 revision），因此其它错误形状与历史完全一致。
     */
    function sendError(res, status, code, message, details) {
      // 传输层与业务层的结构化失败都经由这里写响应：只在收口点记一次类别，
      // 记录只有 code/次数/时间戳，不含 message、请求体或路径。
      rpcErrorTracker.note(code);
      sendJson(res, status, {
        ok: false,
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
        },
      });
    }

    /** 解析 Host 头：返回 { hostname, port }；非法或缺省端口返回 null。 */
    function parseHost(host) {
      if (typeof host !== "string" || host.length === 0) return null;
      let rest = host.trim();
      // IPv6 字面量：[::1]:3080
      if (rest.startsWith("[")) {
        const close = rest.indexOf("]");
        if (close === -1) return null;
        const hostname = rest.slice(1, close);
        const after = rest.slice(close + 1);
        if (after === "") return { hostname, port: 80 };
        if (!after.startsWith(":")) return null;
        const port = Number(after.slice(1));
        if (!Number.isInteger(port)) return null;
        return { hostname, port };
      }
      const parts = rest.split(":");
      if (parts.length === 1) return { hostname: parts[0], port: 80 };
      if (parts.length === 2) {
        const port = Number(parts[1]);
        if (!Number.isInteger(port)) return null;
        return { hostname: parts[0], port };
      }
      return null;
    }

    /** 仅允许 loopback 主机名，防止 DNS rebinding 把本机私有 RPC 打到远程站点。 */
    function isLoopbackHostname(hostname) {
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
    }

    /** 严格同源校验：Origin 必须等于当前请求的 http(s)://host，且 host 为 loopback、端口等于当前 webServer.port。 */
    function sameOrigin(req) {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || origin.length === 0) return false;
      const hostInfo = parseHost(req.headers.host);
      if (hostInfo === null) return false;
      if (!isLoopbackHostname(hostInfo.hostname)) return false;
      if (hostInfo.port !== webServer.port) return false;
      let originUrl;
      try {
        originUrl = new URL(origin);
      } catch {
        return false;
      }
      const originHost = originUrl.hostname;
      if (!isLoopbackHostname(originHost)) return false;
      // 严格比较：Origin 必须精确等于 http(s)://Host（协议 + 主机 + 端口三者一致）。
      const expected = (originUrl.protocol === "https:" ? "https://" : "http://") + req.headers.host;
      return origin === expected;
    }

    /** 仅接受 application/json（可带 charset）。 */
    function contentTypeAllowed(req) {
      const raw = req.headers["content-type"];
      if (typeof raw !== "string" || raw.length === 0) return false;
      const mediaType = raw.split(";", 1)[0].trim().toLowerCase();
      return mediaType === "application/json";
    }

    class ValidationError extends Error {}
    class PayloadTooLargeError extends Error {}
    class BadJsonError extends Error {}

    /** 读请求体；普通设置请求限制 16KB，图片提交使用更大的专用上限。 */
    function readBody(req, maxBytes = 16384) {
      // connection.rpc.intercept 已经完成 JSON 解码；保留同一 dispatch 逻辑时直接
      // 消费 payload，并仍执行大小边界检查，避免绕过旧 HTTP 路径的限制。
      if (Object.prototype.hasOwnProperty.call(req ?? {}, "body")) {
        const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
        if (new TextEncoder().encode(raw).byteLength > maxBytes) return Promise.reject(new PayloadTooLargeError("请求体超过大小限制"));
        return Promise.resolve(raw);
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const once = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        const length = Number(req.headers["content-length"]);
        if (Number.isFinite(length) && length > maxBytes) {
          // Content-Length 已判定超限：立即拒绝以尽快返回 413，同时挂最小 drain listener
          // 并 resume 消费剩余请求体，避免未读字节残留在 socket 中破坏 keep-alive。
          // 不使用 destroy：让连接可安全复用。
          req.on("data", () => {});
          req.on("end", () => {});
          req.on("error", () => {});
          req.resume();
          once(reject, new PayloadTooLargeError("payload too large"));
          return;
        }
        const chunks = [];
        let total = 0;
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          if (settled) return;
          total += Buffer.byteLength(chunk);
          if (total > maxBytes) {
            once(reject, new PayloadTooLargeError("payload too large"));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => once(resolve, chunks.join("")));
        req.on("error", (error) => once(reject, error));
      });
    }

    /** 严格解码客户端上传的 canonical base64，避免宽松 Buffer 解码接收脏数据。 */
    function decodeImageBase64(value) {
      if (typeof value !== "string" || value.length === 0 || value.length % 4 === 1
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new ValidationError("图片 data 不是合法 base64");
      }
      const bytes = Buffer.from(value, "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== value) {
        throw new ValidationError("图片 data 必须是 canonical base64");
      }
      return new Uint8Array(bytes);
    }

    /**
     * 校验一个 image-route 上传项的完整 wire shape。图片上传只接受 client
     * serializer 产生的四个字段，尤其拒绝 pngPath、data URL 和未知扩展字段；
     * 路径永远不能由客户端指定，PNG durable copy 只能由 Host 的 attachments 服务创建。
     */
    function validateEncodedImageInput(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        throw new ValidationError("图片上传项必须是对象");
      }
      const keys = Object.keys(input);
      if (keys.some((key) => !["type", "mediaType", "data", "name"].includes(key))) {
        throw new ValidationError("图片上传项包含不支持的字段");
      }
      if (input.type !== "image") throw new ValidationError("图片上传项 type 必须为 image");
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mediaType)) {
        throw new ValidationError("图片 mediaType 不受支持");
      }
      if (input.name !== void 0 && (typeof input.name !== "string" || input.name.length > 255
        || /[\x00-\x1f\x7f]/.test(input.name))) {
        throw new ValidationError("图片 name 无效");
      }
      return {
        mediaType: input.mediaType,
        data: decodeImageBase64(input.data),
        name: input.name,
      };
    }

    /** image-route 自身也采用严格对象契约，避免 pngPath 等旁路字段被静默忽略。 */
    function validateImageRouteBody(body) {
      const keys = Object.keys(body);
      if (keys.some((key) => !["action", "sessionId", "text", "images"].includes(key))) {
        throw new ValidationError("图片路由请求包含不支持的字段");
      }
      if (body.text !== void 0 && typeof body.text !== "string") {
        throw new ValidationError("图片路由 text 必须是字符串");
      }
      if (!Array.isArray(body.images)) throw new ValidationError("图片路由 images 必须是数组");
    }

    /**
     * image-route-validate / image-route-observer-commit 的严格对象契约：
     * 只接受 action/sessionId/routeClaim 三个字段，routeClaim 必须是非空字符串。
     * 长度/归属/是否过期由 claim 表结构校验负责，这里只保证 wire 形状，
     * 避免任意字段被静默忽略。
     * @param {object} body - 已解码的请求体。
     * @param {string} label - 用于错误文案的动作名（中文可读）。
     */
    function validateImageRouteClaimBody(body, label) {
      const keys = Object.keys(body);
      if (keys.some((key) => !["action", "sessionId", "routeClaim"].includes(key))) {
        throw new ValidationError(label + "请求包含不支持的字段");
      }
      if (typeof body.routeClaim !== "string" || body.routeClaim.length === 0) {
        throw new ValidationError(label + "缺少 routeClaim");
      }
    }

    /** image-route-validate 的 wire 契约。 */
    function validateImageRouteValidateBody(body) {
      validateImageRouteClaimBody(body, "图片路由校验");
    }

    /**
     * image-route-observer-commit 的 wire 契约。
     *
     * 与 image-route-validate 同形（action/sessionId/routeClaim），因此两条传输上的
     * 错误结构完全一致：route-changed → 409、route-claim-invalid/route-commit-in-progress → 409/400，
     * 客户端只需按同一套规则 abandon。
     */
    function validateImageRouteCommitBody(body) {
      validateImageRouteClaimBody(body, "图片路由提交");
    }

    /**
     * image-route-observer-cancel / image-route-observer-release 的严格 wire 契约：
     * 只接受 action/sessionId/childId/cleanupToken。与 claim 相关动作一样严格：
     * 未知字段与缺失字段都是 400，不做静默忽略。
     */
    function validateImageRouteTokenBody(body, label) {
      const keys = Object.keys(body);
      if (keys.some((key) => !["action", "sessionId", "childId", "cleanupToken"].includes(key))) {
        throw new ValidationError(label + "请求包含不支持的字段");
      }
      if (typeof body.childId !== "string" || body.childId.length === 0) {
        throw new ValidationError(label + "缺少 childId");
      }
      if (typeof body.cleanupToken !== "string" || body.cleanupToken.length === 0) {
        throw new ValidationError(label + "缺少 cleanupToken");
      }
    }

    /** 失败/取消路径的清理请求契约（会中断 child）。 */
    function validateImageRouteCancelBody(body) {
      validateImageRouteTokenBody(body, "图片路由清理");
    }

    /** 成功 observed 后的凭据释放请求契约（只释放 token，绝不中断 child）。 */
    function validateImageRouteReleaseBody(body) {
      validateImageRouteTokenBody(body, "图片路由释放");
    }

    /**
     * 读取"下一个请求将使用的模型路由"，供图片能力判定使用。
     *
     * 不能直接用 `parent.session.requestHeader()` 判定能力：它是**已发出请求**的模型。
     * 用户切换模型后立即发图时新模型还没进入 prompt assembly，header 仍指向旧模型，
     * 按旧能力路由就会把图片错误地交给 Observer（或错误地留在不支持 image 的主模型）。
     *
     * 公开 seam：DSH Session 的 `snapshotEvents()` 给出 `model/selection`（已校验、待生效）
     * 与 `request/header`（已发出请求）两类事件，取 seq 更大的那个即下一个请求的模型；
     * `effectiveModelRoute` 负责该判定。旧宿主没有事件快照时退回 requestHeader 语义。
     *
     * fail-safe：存在更新的 `model/selection` 但结构不可用时（staleHeaderIgnored），
     * 既不用旧 header 也不用 agent.options —— 二者都可能属于被取代的模型，一律按
     * unknown 保守处理（main-first 不会把图片误判给 Observer）。
     *
     * @param {object} parent - 根会话的在线 agent。
     * @returns {{provider?: string, model?: string, source: string, staleHeaderIgnored: boolean}} 路由证据。
     */
    function resolveMainImageRoute(parent) {
      let headerConfig;
      try {
        headerConfig = parent?.session?.requestHeader?.()?.config;
      } catch {
        headerConfig = void 0;
      }
      let events;
      if (typeof parent?.session?.snapshotEvents === "function") {
        try {
          // 只读公开方法；旧宿主/测试替身可能不实现，返回非数组时同样按"无事件面"处理。
          const snapshot = parent.session.snapshotEvents();
          if (Array.isArray(snapshot)) events = snapshot;
        } catch {
          events = void 0;
        }
      }
      const evidence = effectiveModelRoute({ events, headerConfig });
      if (evidence.provider !== void 0 && evidence.model !== void 0) return evidence;
      if (evidence.staleHeaderIgnored === true) return evidence;
      const options = parent?.options;
      if (typeof options?.provider === "string" && options.provider.length > 0
        && typeof options?.model === "string" && options.model.length > 0) {
        return { provider: options.provider, model: options.model, source: "agent-options", staleHeaderIgnored: false };
      }
      return evidence;
    }

    /**
     * 一次 image-route 的"路由声明"（route claim），用于消除 TOCTOU：
     * Host 判定能力后，client 才真正 `session.prompt`，期间模型可能再次切换。
     *
     * 设计约束：
     * - **不可猜测**：claim id 由 Node 内置 `randomUUID()` 生成，客户端只能回传自己收到的 id；
     * - **不泄露**：真实 fingerprint（provider/model 摘要）只留在 Host 内存，响应只回传 id；
     * - **绑定会话与代际**：claim 绑定签发它的 root sessionId + exact root generation token，
     *   跨会话回放、同 id root replacement 后的旧 claim 都必定失败；
     * - **有界**：容量上限 + TTL 惰性淘汰（无定时器），校验成功后立即消费，避免无界增长。
     */
    const ROUTE_CLAIM_LIMIT = 64;
    const ROUTE_CLAIM_TTL_MS = 5 * 60 * 1000;
    /**
     * claim id -> {
     *   sessionId, fingerprint, rootToken, target: "main"|"observer",
     *   state: "issued"|"committing", observerAttachments?: object[], capability?: object, expiresAt
     * }
     *
     * 只保存 Host 创建的 durable PNG attachment ref + 能力三态投影 + exact root token 引用：
     * 图片字节与用户文本都不进入 claim 表（Observer 也无从拿到用户原文）。
     * 每个 claim 的 refs 数量受图片上限约束（1-16），整表容量上限 64，因此有界。
     */
    const routeClaims = new Map();
    ctx.effect(() => () => routeClaims.clear(), "dsh-expert-group: image route claims");

    /**
     * Observer commit 成功后签发的一次性清理 token：客户端在 root prompt 失败/取消时用它
     * 请求 Host 中断刚创建的 child，避免孤儿 child 向 root 反馈。
     *
     * 表同样是进程内、有界 + TTL：只存 `{ sessionId, rootToken, childId, expiresAt }`，
     * 不含 provider/model/用户文本；无论 interrupt 成功与否都在校验后消费。
     *
     * 容量策略（关键）：**只淘汰过期项**。表满时绝不淘汰仍可能活跃的 token ——
     * 那会让客户端 finalizer 拿到 404 并把对应 child 变成孤儿。正确做法是在 commit
     * 启动 Observer **之前**做容量预占：见 reserveObserverCleanupSlot。
     */
    const OBSERVER_CLEANUP_LIMIT = 64;
    const observerCleanupTokens = new Map();
    /** 已预占但尚未签发的槽位数（并发 commit 的原子容量预占）。 */
    let pendingCleanupReservations = 0;
    ctx.effect(() => () => {
      observerCleanupTokens.clear();
      pendingCleanupReservations = 0;
    }, "dsh-expert-group: observer cleanup tokens");

    /**
     * 判断一次 `send` 是否真的把响应交给了调用方。
     *
     * Connection 的收集器在"已有响应/未接受"时返回 false；legacy 的收尾函数返回
     * `{ written, reason }`，socket 竞态下 `written === false`（写入异常已被传输层吸收，
     * 不会抛出）。两种情况都表示客户端拿不到响应，因此 claim 不能算已交付。
     * @param {unknown} result - respond/send 的返回值。
     * @returns {boolean} 是否已交付。
     */
    function responseDelivered(result) {
      if (result === false) return false;
      if (result !== null && typeof result === "object" && result.written === false) return false;
      return true;
    }

    /** 路由证据的稳定摘要：只用于 Host 内部比较，绝不回传客户端。 */
    function routeFingerprint(route) {
      if (route === null || typeof route !== "object") return "";
      const provider = typeof route.provider === "string" ? route.provider : "";
      const model = typeof route.model === "string" ? route.model : "";
      if (provider.length === 0 || model.length === 0) return "";
      return provider + "\u0000" + model;
    }

    /**
     * claim/清理 token 是否仍属于签发时的 exact root generation。
     *
     * 同 id 的 root 被重建/替换（或已销毁、卸载阻塞）后，旧 token 必须立即失效：
     * 插件对 `host.lineage` 是硬依赖，因此这里 fail-closed —— 查询异常、缺少 token
     * 或 lineage 能力缺失都返回 false，绝不猜测"还是同一个 root"。
     * @param {object} parent - 当前 agents.get(sessionId) 解析出的根 agent。
     * @param {{rootToken?: unknown}} entry - 签发时记录的 root token。
     * @returns {boolean} 是否仍是同一代 live root。
     */
    function isEntryGenerationLive(parent, entry) {
      if (parent === void 0 || entry === null || typeof entry !== "object") return false;
      if (typeof entry.rootToken !== "string" && (entry.rootToken === null || typeof entry.rootToken !== "object")) return false;
      try {
        if (typeof host.lineage?.isLiveGeneration !== "function") return false;
        return host.lineage.isLiveGeneration(parent, entry.rootToken) === true;
      } catch {
        return false;
      }
    }

    /** 惰性淘汰：先清过期项，再按插入顺序淘汰最旧项，保证 claim 表容量有界。 */
    function pruneRouteClaims(now) {
      for (const [id, entry] of routeClaims) {
        if (entry.expiresAt <= now) routeClaims.delete(id);
      }
      while (routeClaims.size >= ROUTE_CLAIM_LIMIT) {
        const oldest = routeClaims.keys().next();
        if (oldest.done === true) break;
        routeClaims.delete(oldest.value);
      }
    }

    /**
     * 清理 token 的惰性淘汰：**只删除过期项**，绝不淘汰容量上限内的活跃 token。
     *
     * 淘汰活跃 token 会让对应 Observer child 失去客户端补偿通道（client finalizer 404），
     * 从而退化成孤儿 child。真正的容量控制在 commitment 之前用预占完成。
     */
    function pruneObserverCleanupTokens(now) {
      for (const [id, entry] of observerCleanupTokens) {
        if (entry.expiresAt <= now) observerCleanupTokens.delete(id);
      }
    }

    /**
     * 在启动 Observer **之前**原子预占一个 cleanup token 槽位。
     *
     * 先清理过期项，再判断 `已签发 + 已预占 >= 上限`：检查与自增之间没有 await，
     * 因此并发 commit 不可能超发（同一时刻只有一个调用栈能完成 check+increment）。
     * @returns {boolean} 是否预占成功；false 表示容量已满，调用方必须拒绝本次 commit 且不启动 child。
     */
    function reserveObserverCleanupSlot() {
      pruneObserverCleanupTokens(Date.now());
      if (observerCleanupTokens.size + pendingCleanupReservations >= OBSERVER_CLEANUP_LIMIT) return false;
      pendingCleanupReservations += 1;
      return true;
    }

    /** 释放未被消费的预占（admission 失败、后置检查失败等路径）。 */
    function releaseObserverCleanupSlot() {
      if (pendingCleanupReservations > 0) pendingCleanupReservations -= 1;
    }

    /**
     * 为刚接受 admission 的 Observer child 签发一次性清理 token。
     *
     * 调用方**必须**先成功 `reserveObserverCleanupSlot()`：这里把预占转成真实 token，
     * 净占用保持不变（-1 预占 / +1 token），因此签发后仍不可能超过上限。
     * @param {{sessionId: string, rootToken: unknown, childId: string}} input - 绑定信息。
     * @returns {string} 不透明 token（只在 commit 成功响应中回传客户端）。
     */
    function issueObserverCleanupToken({ sessionId, rootToken, childId }) {
      if (pendingCleanupReservations > 0) pendingCleanupReservations -= 1;
      pruneObserverCleanupTokens(Date.now());
      const id = randomUUID();
      observerCleanupTokens.set(id, { sessionId, rootToken, childId, expiresAt: Date.now() + ROUTE_CLAIM_TTL_MS });
      return id;
    }

    /** 删除一个刚签发、但最终没有交付给客户端的 cleanup token。 */
    function revokeObserverCleanupToken(token) {
      if (typeof token !== "string" || token.length === 0) return;
      observerCleanupTokens.delete(token);
    }

    /**
     * 校验并**消费**一个 Observer 清理 token。
     *
     * 结构化校验：token 必须是非空有界字符串、必须查到记录、必须属于同一 root session、
     * 必须绑定同一个 childId、且必须是同一 exact root generation。任何一项不满足都返回
     * ok:false 并给出稳定的内部 reason（对外只映射成 404，不泄露是哪一项）。
     * 无论 interrupt 是否成功，校验通过后 token 都会被删除（一次性语义）。
     *
     * @param {{token?: unknown, sessionId?: string, childId?: unknown}} input - 校验输入。
     * @returns {{ok: boolean, reason?: string, parent?: object, childId?: string}} 校验结果。
     */
    function consumeObserverCleanupToken({ token, sessionId, childId }) {
      if (typeof token !== "string" || token.length === 0 || token.length > 128) return { ok: false, reason: "unknown-token" };
      const entry = observerCleanupTokens.get(token);
      if (entry === void 0) return { ok: false, reason: "unknown-token" };
      if (entry.expiresAt <= Date.now()) {
        observerCleanupTokens.delete(token);
        return { ok: false, reason: "expired-token" };
      }
      if (entry.sessionId !== sessionId) return { ok: false, reason: "session-mismatch" };
      if (typeof childId !== "string" || childId.length === 0 || entry.childId !== childId) return { ok: false, reason: "child-mismatch" };
      const parent = agents.get(sessionId);
      if (parent === void 0 || !isEntryGenerationLive(parent, entry)) return { ok: false, reason: "generation-mismatch" };
      // 全部校验通过才消费：伪造/跨会话/串 child 的请求不能把合法客户端的 token 烧掉。
      // 此后无论 interrupt 成功与否，token 都不再可重放（一次性语义）。
      observerCleanupTokens.delete(token);
      return { ok: true, parent, childId: entry.childId };
    }

    /**
     * 为当前 root session 的待生效路由签发一个 claim。
     *
     * target=observer 的 claim 会暂存 Host 创建的 durable PNG refs（不含字节、不含用户文本），
     * 供两阶段提交时使用；main 的 claim 只保存路由摘要。两者都绑定 exact root generation。
     *
     * @param {object} input - 签发输入。
     * @param {string} input.sessionId - 签发该 claim 的根会话 id。
     * @param {{provider?: string, model?: string}} input.route - 能力判定所依据的路由证据。
     * @param {"main"|"observer"} input.target - 该 claim 允许被哪一种消费动作使用。
     * @param {unknown} input.rootToken - `host.lineage.tokenFor(parent)` 的 exact 代际 token。
     * @param {object[]} [input.observerAttachments] - 仅 observer：Host 侧 durable PNG refs。
     * @param {object} [input.capability] - 只读能力三态投影，供 commit 响应复用。
     * @returns {{id: string, fingerprint: string}} claim id（可回传）与内部摘要（不回传）。
     */
    function issueRouteClaim({ sessionId, route, target, rootToken, observerAttachments, capability }) {
      const now = Date.now();
      pruneRouteClaims(now);
      const id = randomUUID();
      const fingerprint = routeFingerprint(route);
      routeClaims.set(id, {
        sessionId,
        fingerprint,
        rootToken,
        target,
        state: "issued",
        ...(Array.isArray(observerAttachments) ? { observerAttachments: observerAttachments.slice() } : {}),
        ...(capability === void 0 ? {} : { capability }),
        expiresAt: now + ROUTE_CLAIM_TTL_MS,
      });
      return { id, fingerprint };
    }

    /**
     * 校验（可选消费）一个 route claim 是否仍与当前待生效路由一致。
     *
     * 结构化校验：claim 必须是字符串、长度有界、必须查到记录、必须属于同一 root session、
     * 必须是同一 exact root generation（同 id 重建/替换后旧 claim 立即失效）、且当前
     * effective route 摘要必须与签发时完全相同。任何一项不满足都返回 ok:false ——
     * 绝不把任意字符串当作成功。
     *
     * 消费语义（两阶段 Observer 的关键）：
     * - "always"：成功即删除（commit 与 main 的复用场景）；
     * - "main-only"：只有 target=main 的 claim 成功即删除；observer 的 claim **只验证不消费**，
     *   因为它还要交给 image-route-observer-commit 一次性消费；
     * - "never"：只读复核，不改变 claim 生命周期（Host 自检与 admission 后核对）。
     *
     * @param {{claim?: unknown, sessionId?: string, consume?: "always"|"main-only"|"never"}} input - 校验输入。
     * @returns {{ok: boolean, reason?: "unknown-claim"|"session-mismatch"|"generation-mismatch"|"route-changed", target?: string, entry?: object}} 校验结果。
     */
    function verifyRouteClaim({ claim, sessionId, consume = "never" }) {
      if (typeof claim !== "string" || claim.length === 0 || claim.length > 128) return { ok: false, reason: "unknown-claim" };
      const entry = routeClaims.get(claim);
      if (entry === void 0 || entry.expiresAt <= Date.now()) {
        routeClaims.delete(claim);
        return { ok: false, reason: "unknown-claim" };
      }
      if (entry.sessionId !== sessionId) return { ok: false, reason: "session-mismatch" };
      const parent = agents.get(sessionId);
      if (parent === void 0) return { ok: false, reason: "session-mismatch" };
      if (isEntryGenerationLive(parent, entry) !== true) {
        // 同一 sessionId 的 root 已被重建/替换/销毁：旧 claim 一律失效并清理。
        routeClaims.delete(claim);
        return { ok: false, reason: "generation-mismatch" };
      }
      const current = routeFingerprint(resolveMainImageRoute(parent));
      const changed = current !== entry.fingerprint;
      // 摘要相等即视为未变化；两边都为空表示"签发时与现在都无法确定路由"，此时
      // unknown → main-first 语义仍然一致，同样允许校验通过（不能因为无法确定就把
      // 每一次图片提交都判失败）。路由已变化时无论消费策略如何都保持 claim 可诊断：
      // 调用方（validate/commit）会显式删除它。
      if (changed === false && (consume === "always" || (consume === "main-only" && entry.target === "main"))) {
        routeClaims.delete(claim);
      }
      return changed ? { ok: false, reason: "route-changed", target: entry.target } : { ok: true, target: entry.target, entry };
    }

    /** route claim 失败的结构化错误：非 validation，避免被映射为 400 客户端输入错误。 */
    function routeClaimError(reason) {
      const messages = {
        "route-changed": "模型路由在图片提交期间发生变化，已放弃本次提交；请重新发送图片",
        "route-commit-in-progress": "该图片提交正在处理中，请勿重复提交",
      };
      const error = new Error(messages[reason] ?? "图片路由声明无效或已过期，请重新发送图片");
      error.code = reason === "route-changed" || reason === "route-commit-in-progress" ? reason : "route-claim-invalid";
      return error;
    }

    /**
     * 尽力清理已创建的 Observer child（admission 已接受但 commit 后续检测失败/取消时）。
     *
     * 只用现有公开 `subagents.interrupt(childId, { kind: "ancestor", agent: parent })` 契约：
     * 清理失败不能掩盖原始错误，也不重试；不记录 child id。
     * @param {unknown} childId - 已接受的 child id（非字符串时直接返回）。
     * @param {object} parent - 该 child 的父代理。
     */
    async function interruptObserverChild(childId, parent) {
      if (typeof childId !== "string" || childId.length === 0) return;
      try {
        if (typeof subagents?.interrupt !== "function") return;
        await subagents.interrupt(childId, { kind: "ancestor", agent: parent });
      } catch {
        // best-effort：孤儿 child 的清理失败不改变本请求的错误结果。
      }
    }

    /**
     * 图片路由的只读能力诊断投影：三态能力 + 路由证据来源，不含 provider/model 明文。
     * 客户端与测试据此区分"按待生效模型判定"和"退回旧请求头"的路径。
     */
    function imageRouteDiagnostics({ mainImage, observerImage, mainRoute }) {
      return {
        main: mainImage,
        mainSource: mainRoute.source,
        mainRouteStaleHeader: mainRoute.staleHeaderIgnored === true,
        observer: observerImage,
      };
    }

    /**
     * 客户端草稿图片先在 Host 侧统一落成 PNG durable ref。输出同时保留真实 PNG
     * 字节，供主代理走原生 prompt 的 encoded image；Observer 只接收这个新 ref。
     * 此函数在任何能力决策前执行，保证拒绝/切换路由也不会让识别输入绕过 PNG 边界。
     */
    async function normalizeUploadedImages(images, signal) {
      if (!Array.isArray(images) || images.length === 0 || images.length > IMAGE_RPC_MAX_COUNT) {
        throw new ValidationError("图片数量必须在 1-" + IMAGE_RPC_MAX_COUNT + " 张之间");
      }
      if (attachmentStore === void 0 || typeof attachmentStore.saveImage !== "function") {
        throw new ValidationError("当前 Host 未挂载公开附件服务，无法创建 PNG 副本");
      }
      // 先完成全部字节级校验/转码，再按公开 saveImage API 顺序创建副本；能力查询始终在此之后。
      const prepared = [];
      for (const rawInput of images) {
        if (signal?.aborted === true) throw createAbortError();
        const input = validateEncodedImageInput(rawInput);
        const png = await toPngBytes({
          mediaType: input.mediaType,
          data: input.data,
          transcodeToPng: (source) => transcodeImageToPng(source),
        });
        prepared.push({ data: png, mediaType: "image/png", name: pngCopyName(input.name) });
      }
      const attachments = [];
      for (const input of prepared) {
        if (signal?.aborted === true) throw createAbortError();
        attachments.push(await attachmentStore.saveImage(input));
      }
      return prepared.map((input, index) => {
        const attachment = attachments[index];
        if (!attachment || typeof attachment !== "object"
          || attachment.mediaType !== "image/png"
          || typeof attachment.attachmentId !== "string"
          || attachment.attachmentId.length === 0) {
          throw new Error("附件服务没有返回有效的 image/png durable reference");
        }
        return {
          attachment,
          data: Buffer.from(input.data).toString("base64"),
          mediaType: "image/png",
          name: typeof attachment.name === "string" && attachment.name.length > 0
            ? attachment.name
            : input.name,
        };
      });
    }

    function fanoutRpcRootSession(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
      const agent = agents.get(sessionId);
      if (agent?.session?.header?.parentSession !== void 0) return void 0;
      const recorded = source().childModels?.[sessionId];
      if (recorded !== void 0) return void 0;
      return agent;
    }

    function fanoutRpcSessionId(body) {
      return typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    }

    function fanoutRpcTaskFor(sessionId, parentTaskId) {
      if (host.lineage.resolveOwner(parentTaskId) !== sessionId) return null;
      return fanoutHost.getTask(parentTaskId);
    }

    function fanoutRpcAfter(value) {
      if (value === undefined) return 0;
      if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError("after 必须是非负整数");
      return value;
    }

    /**
     * Connection adapter：只负责 endpoint 校验、payload/abort signal 传递与 Connection
     * envelope 转换；业务结果与 legacy 完全共用 dispatchRpcAction。
     */
    const connectionRpcAdapter = createConnectionRpcHandler({ endpoint: RPC_ENDPOINT, dispatch: dispatchRpcAction });
    async function handleRpc(req, res) {
      const requestLifecycle = createRpcRequestLifecycle(req, res);
      try {
        if (req.method !== "POST") { sendError(res, 405, "method-not-allowed", "仅支持 POST"); return; }
        if (!sameOrigin(req)) { sendError(res, 403, "forbidden", "仅允许 loopback 同源请求（Origin 与 Host 不一致或非 loopback）"); return; }
        if (!contentTypeAllowed(req)) { sendError(res, 415, "unsupported-media-type", "仅支持 application/json"); return; }

        const imageRequest = req.headers["x-dsh-expert-group-image"] === "1";
        const raw = await host.rpc.readBody(req, { imageRequest });
        let body;
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          throw new BadJsonError("请求体不是合法 JSON");
        }
        await dispatchRpcAction(body, requestLifecycle.signal, (status, value) => sendJson(res, status, value), { imageRequest });
      } catch (error) {
        const mapped = mapRpcError(error, requestLifecycle.signal);
        sendError(res, mapped.status, mapped.code, mapped.message, mapped.details);
      } finally {
        requestLifecycle.dispose();
      }
    }

    /**
     * 传输无关的业务 dispatch：只接收已解码的 JSON body、取消信号与一个响应收集器。
     * legacy HTTP 与 DSH Connection 都调用它，因此认证之外的结果、结构化错误 code、
     * ownership 判定与大小限制天然一致；method/origin/content-type/读 body 仍留在 HTTP adapter。
     * @param {object} body - 已解码的请求体。
     * @param {AbortSignal|undefined} signal - 请求取消信号。
     * @param {(status:number, body:object)=>void} respond - 传输层响应收集器。
     * @param {{imageRequest?:boolean}} [options] - 图片路由标记（HTTP 取专用头，Connection 由 action 推导）。
     *   请求体预算按 action 选择（普通 JSON / settings-commit / image-route 三档），
     *   具体字节数由 host/rpc-transport 的 limitFor 单点持有，本文件不复制数字。
     */
    async function dispatchRpcAction(body, signal, respond, { imageRequest = false } = {}) {
      const send = (status, value) => respond(status, value);
      /**
       * 统一错误信封。details 只在确有结构化附加信息时携带（当前只有 settings 冲突的
       * 权威 revision），其它错误保持 `{ code, message }` 原形状不变。
       */
      const fail = (status, code, message, details) => {
        // 业务/校验失败的收口点；与 sendError 一样只记录结构化类别。
        rpcErrorTracker.note(code);
        send(status, {
          ok: false,
          error: {
            code,
            message,
            ...(details === undefined ? {} : { details }),
          },
        });
      };
      try {
        // 取消在业务动作之前就收敛，避免客户端已断开时仍进入 settings/storage 写路径。
        // 对 claim 相关动作额外释放 Host 暂存的路由声明（含 observer 的 durable refs）：
        // 已取消的提交不会再有合法消费者，留下 pending claim 只会占用有界表直到 TTL。
        if (signal?.aborted === true) {
          if ((body?.action === "image-route-validate" || body?.action === "image-route-observer-commit")
            && typeof body?.routeClaim === "string") {
            routeClaims.delete(body.routeClaim);
          }
          throw createAbortError();
        }
        if (typeof body !== "object" || body === null) { fail(400, "bad-request", "请求体必须是 JSON 对象"); return; }
        // 两条传输共用同一字节上限：HTTP 在读 body 时快速拒绝，Connection 直接投递
        // 已解码 payload，这里补上同一限制，避免绕过普通 / settings-commit / 图片三档边界。
        // 预算选择复用 host/rpc.transport 的同一函数，两条传输不会各自硬编码数字。
        if (Buffer.byteLength(JSON.stringify(body)) > host.rpc.limitFor({ imageRequest, action: body.action })) {
          fail(413, "payload-too-large", "请求体超过允许上限");
          return;
        }
        if (body.action === "image-route") {
          if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
          validateImageRouteBody(body);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const parent = agents.get(sessionId);
          if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
            fail(404, "session-not-found", "根会话不存在或尚未恢复");
            return;
          }
          // 先把全部上传项验证并落成 Host-owned PNG durable refs，再读取模型能力；
          // 无论最终走主模型、Observer 还是能力拒绝，识别边界都不会接触原始格式。
          // const normalized = await normalizeUploadedImages(body.images);
          // const normalized = await normalizeUploadedImages(body.images);
          const normalized = await normalizeUploadedImages(body.images, signal);
          throwIfAborted(signal);
          const snapshot = source();
          const mainRoute = resolveMainImageRoute(parent);
          let mainImage = "unknown";
          if (mainRoute.provider !== undefined && mainRoute.model !== undefined) {
            try {
              mainImage = imageCapability(await llm.resolveModelInfo(mainRoute.provider, mainRoute.model, signal));
            } catch (error) {
              // 取消必须原样上抛；只有真正的非取消失败才保持 unknown（main-first）。
              const aborted = abortErrorFor(error, signal);
              if (aborted !== void 0) throw aborted;
            }
          }
          throwIfAborted(signal);
          let observerImage = "unknown";
          let observerSelection;
          const shouldProbeObserver = snapshot.observerPreferred === true || mainImage === "unsupported";
          if (shouldProbeObserver && config.enableObserver === true && routeImageToObserver !== void 0) {
            observerSelection = resolveRole(sessionId, "observer");
            if (observerSelection !== null) {
              try {
                observerImage = imageCapability(await llm.resolveModelInfo(observerSelection.provider, observerSelection.model, signal));
              } catch (error) {
                const aborted = abortErrorFor(error, signal);
                if (aborted !== void 0) throw aborted;
                observerImage = "unknown";
              }
            }
          }
          throwIfAborted(signal);
          const decision = decideImageRoute({
            mainImage,
            observerImage,
            observerPreferred: snapshot.observerPreferred === true,
          });
          if (decision.target === "error") throw new ValidationError(decision.message);
          const capability = imageRouteDiagnostics({ mainImage, observerImage, mainRoute });
          // TOCTOU 保护（签发）：把"能力判定所依据的路由"固化成不透明 claim 回传客户端。
          // 客户端在真正 session.prompt 之前必须用它做一次校验，避免能力判定模型与实际
          // prompt 模型不一致（插件不改 DSH 核心，也不存在原子 generation API）。
          //
          // Observer 走**两阶段**：这一步只签发 claim 并暂存 Host 创建的 durable PNG refs，
          // **不**启动 Observer。否则一旦 claim 校验失败/模型切换/请求取消，客户端不 prompt
          // 而 child 已创建，就会留下向 root 反馈的孤儿 child。真正的 admission 只发生在
          // image-route-observer-commit。
          const observerRefs = decision.target === "observer"
            ? normalized.map(({ attachment }) => attachment)
            : void 0;
          const claim = issueRouteClaim({
            sessionId,
            route: mainRoute,
            target: decision.target === "observer" ? "observer" : "main",
            // exact root generation：同 id 的 root 被重建/替换后，这个 claim 必须失效，
            // 否则旧代际的图片提交会落到新 root 上。
            rootToken: host.lineage.tokenFor(parent),
            observerAttachments: observerRefs,
            capability,
          });
          // 签发之后只有"成功把 claim 交给客户端"才允许保留它；任何自检失败、取消、
          // 结构化错误或响应发送异常都必须回收，避免留下 pending claim（含暂存 refs）。
          // main 成功返回时同样保留 claim（它的生命周期由 image-route-validate 消费）。
          let claimHandedOff = false;
          try {
            // TOCTOU 保护（Host 自检）：能力查询是异步的，期间模型可能再次切换。这里在
            // 返回成功之前重新读取当前路由并与 claim 摘要核对，避免明显窗口。
            const recheck = verifyRouteClaim({ claim: claim.id, sessionId, consume: "never" });
            throwIfAborted(signal);
            if (recheck.ok !== true) throw routeClaimError(recheck.reason);
            if (decision.target === "main") {
              const delivery = send(200, {
                ok: true,
                target: "main",
                images: normalized.map(({ data, mediaType, name }) => ({ data, mediaType, name })),
                capability,
                routeClaim: claim.id,
              });
              // 只有响应真的写出去了才算交付；写入被传输层吸收（socket 竞态）时立即回收 claim。
              claimHandedOff = responseDelivered(delivery);
              return;
            }
            // Observer 分支只回传 claim 与三态能力：没有 childId，也就没有孤儿 child。
            // 这里刻意不回传用户 text —— 自动入口的 Observer admission 不含任何用户原文。
            const observerDelivery = send(200, { ok: true, target: "observer", capability, routeClaim: claim.id });
            claimHandedOff = responseDelivered(observerDelivery);
            return;
          } finally {
            if (claimHandedOff !== true) routeClaims.delete(claim.id);
          }
        }
        if (body.action === "image-route-validate") {
          // 客户端在真正 session.prompt 之前的 TOCTOU 复核：Host 重新读取当前 effective
          // model route，并与签发时的摘要比较。claim 必须是本插件签发、绑定同一 root
          // session 的不透明 id；任意字符串、跨会话回放、过期或路由已变化都显式失败。
          //
          // 消费语义：main 的 claim 校验成功即消费；Observer 的 claim **只验证不消费**，
          // 因为它还要交给 image-route-observer-commit 一次性消费（防止重复 commit）。
          if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
          validateImageRouteValidateBody(body);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const parent = agents.get(sessionId);
          if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
            fail(404, "session-not-found", "根会话不存在或尚未恢复");
            return;
          }
          throwIfAborted(signal);
          const verified = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "main-only" });
          throwIfAborted(signal);
          if (verified.ok !== true) {
            // 路由已变化的 claim 不再可用：显式删除，避免留下悬挂的 observer refs。
            routeClaims.delete(body.routeClaim);
            throw routeClaimError(verified.reason);
          }
          const validateDelivery = send(200, { ok: true, target: verified.target === "observer" ? "observer" : "main" });
          if (responseDelivered(validateDelivery) !== true) {
            // 响应没有真正交付：客户端拿不到复核结果，也就不会进入 commit。
            // observer 的 claim 仍被"只验证不消费"地保留着，这里必须显式删除（连同暂存的
            // durable refs），否则它既无法被消费又占容量。main 的 claim 已在成功校验时消费，
            // 重复删除是无副作用的 no-op。
            routeClaims.delete(body.routeClaim);
          }
          return;
        }
        if (body.action === "image-route-observer-commit") {
          // Observer 两阶段的第二阶段：claim 当前路由复核 → Observer admission → 消费 claim。
          // commit 失败绝不启动 child；admission 已接受但后续检测失败（取消/路由变化）时，
          // 用公开 subagents.interrupt 尽力清理，避免孤儿 child 向 root 反馈。
          if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
          validateImageRouteCommitBody(body);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const parent = agents.get(sessionId);
          if (parent === void 0 || parent?.session?.header?.parentSession !== void 0) {
            fail(404, "session-not-found", "根会话不存在或尚未恢复");
            return;
          }
          throwIfAborted(signal);
          const peeked = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "never" });
          if (peeked.ok !== true) {
            // 路由已变化/claim 失效：显式清理，连暂存的 durable refs 一起丢弃。
            routeClaims.delete(body.routeClaim);
            throw routeClaimError(peeked.reason);
          }
          if (peeked.target !== "observer" || peeked.entry === void 0) {
            // 目标不匹配（例如 main 的 claim 被误发到 commit）：拒绝这次 commit，但不改动
            // 那个 claim 的生命周期 —— 它的合法消费动作是 image-route-validate。
            throw routeClaimError("unknown-claim");
          }
          const entry = peeked.entry;
          if (entry.state !== "issued") {
            // 一次性语义：同一 claim 不允许并发/重复 commit。
            throw routeClaimError("route-commit-in-progress");
          }
          if (routeImageToObserver === void 0) {
            routeClaims.delete(body.routeClaim);
            throw new ValidationError("Observer 专家当前未启用或尚未挂载，无法提交图片；原始输入已保留");
          }
          entry.state = "committing";
          // 容量预占：必须在启动 Observer **之前**完成。表满时宁可拒绝本次 commit
          // （结构化 503），也绝不为新 child 淘汰仍可能活跃的旧 token —— 否则旧 child
          // 会失去客户端补偿通道并退化成孤儿。
          if (reserveObserverCleanupSlot() !== true) {
            routeClaims.delete(body.routeClaim);
            const error = new Error("Observer 图片清理凭据已满，暂时无法启动新的图片分析；请稍后重试");
            error.code = "observer-cleanup-capacity";
            throw error;
          }
          let reservationHeld = true;
          let issuedCleanupToken;
          let childId;
          try {
            throwIfAborted(signal);
            const observerResult = await routeImageToObserver({
              parent,
              preparedAttachments: Array.isArray(entry.observerAttachments) ? entry.observerAttachments : [],
              signal: signal,
              // admission 的 childId 必须在 routeImageToObserver 内部的后置检查之前回传，
              // 否则"已接受但随后取消"的路径拿不到 childId，就无法尽力中断孤儿 child。
              onAccepted: (acceptedChildId) => { childId = acceptedChildId; },
            });
            if (typeof observerResult?.childId === "string") childId = observerResult.childId;
            // admission 之后：取消或路由再次变化都必须清理刚创建的 child。
            const post = verifyRouteClaim({ claim: body.routeClaim, sessionId, consume: "never" });
            throwIfAborted(signal);
            if (post.ok !== true) throw routeClaimError(post.reason);
            routeClaims.delete(body.routeClaim);
            // 关键窗口：commit 已经把 childId 交给客户端，但客户端接下来的 session.prompt
            // 仍可能失败/取消。把预占转成一次性、进程内、有界的 cleanup token，绑定
            // {sessionId, exact root generation, childId}，客户端据此可请求 Host 中断该 child。
            issuedCleanupToken = typeof childId === "string" && childId.length > 0
              ? issueObserverCleanupToken({ sessionId, rootToken: entry.rootToken, childId })
              : void 0;
            // 预占已转成 token（净占用不变），失败路径不再重复释放。
            reservationHeld = false;
            const delivery = send(200, {
              ok: true,
              target: "observer",
              childId: typeof childId === "string" ? childId : void 0,
              ...(issuedCleanupToken === void 0 ? {} : { cleanupToken: issuedCleanupToken }),
              capability: entry.capability,
            });
            if (responseDelivered(delivery) !== true) {
              // 响应没有真正交付（socket 竞态被传输层吸收）：客户端永远拿不到 childId/
              // cleanupToken，因此必须立即撤销凭据并尽力中断 child，绝不能把这种竞态
              // 当成成功交付，留下一个无凭据的 Observer child。
              revokeObserverCleanupToken(issuedCleanupToken);
              issuedCleanupToken = void 0;
              await interruptObserverChild(childId, parent);
              return;
            }
            return;
          } catch (error) {
            // 失败路径同样删除 claim（连同暂存的 durable refs）：撤销未交付的 token、
            // 释放未消费的预占，并尽力中断已创建的 child。
            routeClaims.delete(body.routeClaim);
            revokeObserverCleanupToken(issuedCleanupToken);
            if (reservationHeld) releaseObserverCleanupSlot();
            await interruptObserverChild(childId, parent);
            throw error;
          }
        }
        if (body.action === "image-route-observer-release") {
          // 成功 observed 后的凭据释放：Observer child 已由 DSH 正常收口，客户端不再需要
          // 清理凭据。校验同 cancel（session + exact root generation + childId）后消费 token，
          // 但**绝不调用 interrupt** —— release 误中断会把已交付的视觉分析打掉。
          // 消费后容量立即释放，连续成功提交不会再累积到上限。
          if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
          validateImageRouteReleaseBody(body);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const released = consumeObserverCleanupToken({
            token: body.cleanupToken,
            sessionId,
            childId: body.childId,
          });
          if (released.ok !== true) {
            const error = new Error("图片提交清理凭据无效或已过期");
            error.code = "route-cleanup-invalid";
            throw error;
          }
          send(200, { ok: true });
          return;
        }
        if (body.action === "image-route-observer-cancel") {
          // Observer commit 成功后客户端提交 root prompt 失败/取消时的补偿动作：
          // 校验一次性 cleanup token（session + child + exact root generation）后中断 child。
          // 这不是新的 DSH API，只是对现有公开 subagents.interrupt 的受控封装：
          // token 一旦校验通过就消费（无论 interrupt 成功与否），对外失败统一 404，
          // 不泄露究竟是哪一项校验失败。
          if (!imageRequest) { fail(400, "bad-request", "图片路由请求缺少专用请求标记"); return; }
          validateImageRouteCancelBody(body);
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const consumed = consumeObserverCleanupToken({
            token: body.cleanupToken,
            sessionId,
            childId: body.childId,
          });
          if (consumed.ok !== true) {
            const error = new Error("图片提交清理凭据无效或已过期");
            error.code = "route-cleanup-invalid";
            throw error;
          }
          try {
            if (typeof subagents?.interrupt === "function") {
              await subagents.interrupt(consumed.childId, { kind: "ancestor", agent: consumed.parent });
            }
          } catch {
            // interrupt 失败不影响 token 已消费的一次性语义；也不向客户端泄露内部原因。
          }
          send(200, { ok: true });
          return;
        }
        if (body.action === "meta") {
          // 设置页不绑定具体会话：角色状态必须来自 Host 配置，避免 child/no-session 误判 Observer。
          const roles = activeRoles();
          const snap = source();
          // budget 是只读投影（用量 / 冻结上限 / 最近一次违规）：客户端与诊断据此判断
          // 是否接近数据资源预算；不携带任何任务负载，也不写入 settings/domain。
          // 先用 typeof 判定标识符本身：'service?.x' 仍会对未声明标识符抛 ReferenceError，
          // 而旧测试替身可能没有 fanoutHost。typeof 对未声明标识符是安全的。
          const budget = typeof fanoutHost !== "undefined" && typeof fanoutHost.budget === "function"
            ? fanoutHost.budget()
            : void 0;
          send(200, {
            ok: true,
            roles,
            activeRoles: roles,
            enableObserver: config.enableObserver === true,
            observerPreferred: snap.observerPreferred === true,
            roleConcurrencyLimit: snap.roleConcurrencyLimit,
            // 任务管理默认开启：meta 只回传归一后的生效值，供设置页与诊断读取。
            taskManagementEnabled: snap.taskManagementEnabled !== false,
            // 只读提示词自定义投影：六个角色（含未启用的 observer）、各自当前生效的
            // 专家专属 persona 与 grapheme 上限。设置页据此渲染编辑器与"恢复默认"，
            // 不需要也不允许自己猜测 Host 状态。这里不含固定执行纪律副本。
            rolePrompts: describeRolePrompts(snap),
            ...(budget === void 0 ? {} : { budget }),
            // 只读能力矩阵与运行时诊断：只有固定状态枚举、计数与结构化错误类别，
            // 不含 prompt、原始请求体、token、Cookie、authorization、会话/agent id
            // 或任何完整路径；两者都由本文件内的投影函数构造，结构固定且有界。
            capabilities: describeHostCapabilities(),
            diagnostics: describeRuntimeDiagnostics(),
          });
          return;
        }
        if (body.action === "expert-group-snapshot") {
          const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          send(200, { ok: true, snapshot: await expertGroupRuntime.snapshotForSession(sessionId) });
          return;
        }

        if (body.action === "fanout-list" || body.action === "fanout-get" || body.action === "fanout-events"
          || body.action === "fanout-cancel-shard" || body.action === "fanout-cancel-parent"
          || body.action === "fanout-retry-shard" || body.action === "fanout-retry") {
          const sessionId = fanoutRpcSessionId(body);
          if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }
          const parent = fanoutRpcRootSession(sessionId);
          if (parent === void 0) {
            fail(404, "session-not-found", "根会话不存在或尚未恢复");
            return;
          }
          if (body.action === "fanout-list") {
            const tasks = host.lineage.tasksOwnedBy(sessionId);
            const eventBatch = fanoutHost.getEvents({ after: 0 });
            send(200, { ok: true, sessionId, tasks, cursor: eventBatch.nextSequence });
            return;
          }
          if (body.action === "fanout-events") {
            const after = fanoutRpcAfter(body.after);
            const hasParentTaskId = body.parentTaskId !== undefined;
            const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId.trim() : "";
            if (hasParentTaskId && parentTaskId.length === 0) {
              fail(400, "bad-request", "parentTaskId 无效");
              return;
            }
            // root-wide 查询不要求 parentTaskId；指定父任务时先做同一 ownership
            // 校验，不能用事件自身字段绕过旧 root/new root 隔离。
            if (hasParentTaskId && fanoutRpcTaskFor(sessionId, parentTaskId) === null) {
              fail(404, "not-found", "fan-out 父任务不存在或不属于当前根会话");
              return;
            }
            const batch = fanoutHost.getEvents({
              after,
              ...(hasParentTaskId ? { parentTaskId } : {}),
            });
            const events = hasParentTaskId
              ? batch.events
              : batch.events.filter((event) => host.lineage.resolveOwner(event.parentTaskId) === sessionId);
            send(200, { ok: true, events, cursor: batch.nextSequence });
            return;
          }
          const parentTaskId = typeof body.parentTaskId === "string" ? body.parentTaskId.trim() : "";
          if (parentTaskId.length === 0) { fail(400, "bad-request", "缺少 parentTaskId"); return; }
          const task = fanoutRpcTaskFor(sessionId, parentTaskId);
          if (task === null) {
            fail(404, "not-found", "fan-out 父任务不存在或不属于当前根会话");
            return;
          }
          if (body.action === "fanout-get") {
            send(200, { ok: true, task });
            return;
          }
          let result;
          if (body.action === "fanout-cancel-parent") {
            result = fanoutHost.cancelParent(parentTaskId);
          } else {
            const shardId = typeof body.shardId === "string" ? body.shardId.trim() : "";
            if (shardId.length === 0) { fail(400, "bad-request", "缺少 shardId"); return; }
            result = body.action === "fanout-cancel-shard"
              ? fanoutHost.cancelShard(parentTaskId, shardId)
              : fanoutHost.retryShard(parentTaskId, shardId);
          }
          const retriedTask = fanoutHost.getTask(parentTaskId);
          // 手工重试会把已终态任务带回 pending（fanout.js 的 retryShard 是唯一入口，
          // 只有本 RPC 调用它），而首次 settle 时该父任务**上一代次**的等待工作已经结算。
          // 若这里不重新登记，root turn 就没有任何等待依据，会在重试的分片跑完前收口。
          //
          // 登记走**新代次**（fanout:<parentTaskId>:<attempt+1>），而不是复用旧键：复用旧键
          // 会让「retry 期间的新工作」与「已结算的旧工作」无法区分，从而在分片跑完前放行。
          // retry 成功后的任务是 pending，不会被终态守卫跳过；同 root 的 duplicate submit
          // 仍由 records 的未释放状态幂等短路。retry 任务成功/失败/取消都会由 manager 聚合
          // 出 task_settled → releaseFanoutGoalHandoff 结算它自己的代次。
          if (result?.accepted === true && (body.action === "fanout-retry-shard" || body.action === "fanout-retry")) {
            registerFanoutRetryGoalHandoff(parent, parentTaskId, retriedTask);
          }
          send(200, { ok: true, ...result, task: retriedTask });
          return;
        }
        if (body.action === "settings-commit") {
          const expectedRevision = body.expectedRevision;
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
            fail(400, "bad-request", "expectedRevision 无效");
            return;
          }
          // 兼容旧 Host 的调用形状：commitSettingsCandidate(body.settings, expectedRevision);
          const committed = await commitSettingsCandidate(body.settings, expectedRevision, signal);
          send(200, { ok: true, ...committed });
          return;
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
        if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return; }

        const agent = agents.get(sessionId);
        // 子代理判定优先级：
        // 1. 客户端提示（来自 sessions 列表的 parentId/origin，可靠且与 agent 是否在线无关）；
        // 2. 在线 agent 的会话头；
        // 3. 持久化的 childModels 记录（子代理已结束后仍能识别）。
        const childHint = body.childHint === true;
        const liveChild = agent?.session?.header?.origin === "subagent" || agent?.session?.header?.parentSession !== void 0;
        const recorded = source().childModels?.[sessionId];
        const isChild = childHint || liveChild || recorded !== void 0;

        if (body.action === "notification-snapshot") {
          // 终止快照按 root session 隔离；child 无论在线与否都不能读取父会话的权威状态。
          if (isChild) { fail(400, "bad-request", "notification-snapshot 只能查询根会话"); return; }
          // 只读动作：不接受 after/cursor 之类的轮询参数，读取结果与"上次读到哪"无关，
          // 因此客户端轮询频率不会影响投递正确性（快照一直保留到新 run 或 root dispose）。
          const view = notificationHost.snapshotOf(sessionId);
          // 只读提示词投影与 meta / get / settings-commit 同源：同一个 describeRolePrompts
          // 作用在同一份归一 settings 快照上，因此六角色默认 persona、覆盖与"已自定义"
          // 结论完全一致，客户端不必再发一次 meta 往返，也不会按缺失字段自行退化。
          // 这里刻意只读 settingsSource()：通知轮询每 2 秒一次，投影只描述配置、
          // 与"谁在运行"无关，不需要为它读 storage domain 的全量快照。
          send(200, {
            ok: true,
            rootId: sessionId,
            rootGeneration: rootGenerationRegistry.generationOf(sessionId) ?? null,
            runSeq: view.runSeq,
            snapshot: view.snapshot,
            rolePrompts: describeRolePrompts(settingsSource()),
          });
          return;
        }

        if (body.action === "get") {
          if (isChild) {
            // 优先在线 agent 的实际请求头，其次在线 agent 的 options，
            // 最后落到持久化记录——保证子代理结束后仍能显示当时使用的模型与思考深度。
            const header = agent?.session?.requestHeader?.();
            const config = header?.config;
            send(200, {
              ok: true,
              kind: "child",
              child: {
                provider: config?.provider ?? agent?.options?.provider ?? recorded?.provider ?? "",
                model: config?.model ?? agent?.options?.model ?? recorded?.model ?? "",
                reasoningEffort: config?.reasoningEffort ?? agent?.options?.[EFFORT_MARKER] ?? recorded?.reasoningEffort,
                // 子代理角色：优先在线 agent 的 options marker，其次持久化记录；
                // 缺失时留空（客户端隐藏角色前缀，显示与旧版一致）。
                role: agent?.options?.[ROLE_MARKER] ?? recorded?.role,
              },
            });
            return;
          }
          // 根会话：返回角色/全局默认/会话覆盖，不依赖 agent 是否已恢复——消除
          // 重启后“会话不存在或尚未恢复”的开机竞态。
          const snap = source();
          const roles = activeRoles();
          const defaults = {};
          const overrides = {};
          for (const role of roles) {
            defaults[role] = snap.defaults?.[role] ?? null;
            overrides[role] = snap.sessionOverrides?.[sessionId]?.[role] ?? null;
          }
          // 全局提示词覆盖与角色模型配置同源：都来自 settings，与会话无关，
          // 因此这里只返回已保存的有效覆盖（缺失键表示该角色跟随默认 persona）。
          const promptOverrides = {};
          for (const entry of listRoles()) {
            const value = promptOverrideFor(snap[PROMPT_OVERRIDES_SETTINGS_KEY], entry.id);
            if (value !== void 0) promptOverrides[entry.id] = value;
          }
          // 主代理实际生效的模型元数据：只取在线 agent 的真实请求头/options，
          // 与 child 分支同源同口径；agent 不在线或字段缺失时留空字段，由
          // 客户端静默隐藏——绝不用 defaults/overrides 猜测当前主模型，那只是
          // 角色配置，不是实际生效值。
          const rootHeader = agent?.session?.requestHeader?.();
          const rootConfig = rootHeader?.config;
          send(200, {
            ok: true,
            kind: "root",
            roles, defaults, overrides,
            rolePrompts: describeRolePrompts(snap),
            promptOverrides,
            provider: snap.provider ?? "",
            enableObserver: config.enableObserver === true,
            observerPreferred: snap.observerPreferred === true,
            agent: {
              provider: rootConfig?.provider ?? agent?.options?.provider ?? "",
              model: rootConfig?.model ?? agent?.options?.model ?? "",
              reasoningEffort: rootConfig?.reasoningEffort ?? agent?.options?.[EFFORT_MARKER],
            },
          });
          return;
        }

        if (body.action === "commit") {
          // 写操作从严：客户端提示或在线会话头表明是子代理，一律拒绝；
          // 子代理已结束且提示缺失（历史会话）时仍会被持久化记录识别为子代理。
          if (isChild) { fail(400, "read-only", "子代理会话只读，不能修改角色模型"); return; }
          if (agent === void 0) { fail(404, "session-not-found", "会话不存在或尚未恢复"); return; }
          // scope：defaults 保留旧 RPC 的全局兼容写入；全局配置入口是“dsh-expert-group”设置页，session 仅当前会话。
          const scope = body.scope === "defaults" ? "defaults" : "session";
          let legacyExpectedRevision;
          if (scope === "defaults") {
            // 旧调用方没有 revision 字段时由 Host 在请求入口捕获快照；队列前端
            // 再由 settings service 比较它，避免完整 defaults 静默覆盖并发修改。
            const suppliedRevision = body.expectedRevision;
            if (suppliedRevision !== void 0 && (!Number.isSafeInteger(suppliedRevision) || suppliedRevision < 0)) {
              fail(400, "bad-request", "expectedRevision 无效");
              return;
            }
            const descriptor = typeof settings.describe === "function"
              ? settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
              : void 0;
            const currentRevision = suppliedRevision === void 0 ? descriptor?.revision : suppliedRevision;
            if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
              fail(409, "settings-conflict", "无法安全确认 settings revision，请刷新后重试");
              return;
            }
            legacyExpectedRevision = currentRevision;
          }
          const changes = Array.isArray(body.changes) ? body.changes : null;
          if (changes === null || changes.length === 0) {
            fail(400, "bad-request", "changes 需要至少一个 { role, selection }");
            return;
          }
          const changeInputs = [];
          for (const change of changes) {
            const role = typeof change?.role === "string" ? change.role : "";
            if (!activeRoles().includes(role)) { fail(400, "invalid-role", `未启用的角色: ${role}`); return; }
            const selection = typeof change?.selection === "object" && change.selection !== null ? change.selection : null;
            if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") {
              fail(400, "bad-request", "selection 需要 provider 与 model");
              return;
            }
            changeInputs.push({ role, selection });
          }
          if (scope === "defaults") {
            // 旧全局路由的动态校验也必须在 settings 队列内；代次检查紧邻 update，
            // 目录事件不能插入校验完成与 settings 写入之间。
            await settingsRuntime.enqueueCommit(async () => {
              const generation = settingsRuntime.generation;
              const normalizedChanges = [];
              for (const change of changeInputs) {
                normalizedChanges.push({ role: change.role, selection: await validateSelectionWithSignal(change.selection, signal) });
              }
              if (!settingsRuntime.isCurrentGeneration(generation)) throw new SettingsDirectoryChangedError();
              const current = source();
              const defaults = { ...(current.defaults ?? {}) };
              for (const change of normalizedChanges) defaults[change.role] = change.selection;
              // settings 只保存全局配置，局部 update 不携带 domain 运行数据；
              // 与新 settings-commit 共用实际写入边界和 captured revision。
              await updateSettingsAtGeneration({ defaults }, legacyExpectedRevision, generation);
            });
          } else {
            const normalizedChanges = [];
            for (const change of changeInputs) {
              normalizedChanges.push({ role: change.role, selection: await validateSelection(change.selection, signal) });
            }
            await enqueueWrite(async () => {
              const binding = host.storage.active();
              if (binding?.sessionAuthoritative !== true) {
                throw new Error("storage domain is not ready for session override write");
              }
              const current = source();
              const next = { ...(current.sessionOverrides?.[sessionId] ?? {}) };
              for (const change of normalizedChanges) next[change.role] = change.selection;
              if (!storageBinding.isCurrent(binding)) throw new Error("storage domain binding was replaced");
              const result = await persistDomainEntry({
                table: binding.sessionTable,
                key: sessionId,
                value: next,
                isCurrent: () => storageBinding.isCurrent(binding),
              });
              if (result.detached) {
                const detached = new Error("storage domain binding was replaced");
                detached.code = "PERSISTENCE_GENERATION_STALE";
                detached.category = "generation-stale";
                throw detached;
              }
            }).then(() => {
              observeStorageWrite(true, void 0, "session_overrides");
            }, (error) => {
              // 记录健康状态后继续 reject：RPC 仍必须把失败显式返回给调用方。
              observeStorageWrite(false, error, "session_overrides");
              throw error;
            });
          }
          const snap = source();
          send(200, { ok: true, scope, defaults: snap.defaults ?? {}, overrides: snap.sessionOverrides?.[sessionId] ?? {} });
          return;
        }

        fail(400, "bad-request", "未知 action");
      } catch (error) {
        const mapped = mapRpcError(error, signal);
        fail(mapped.status, mapped.code, mapped.message, mapped.details);
      }
    }

    /**
     * 共享错误契约：两条传输都通过它把同一批结构化错误映射为 (status, code, message)。
     * 结构化错误类别的诊断记录发生在实际写响应的收口点（fail / sendError / channel 早停），
     * 因此同一请求只会被记录一次，且记录内容里不含错误消息。
     */
    function mapRpcError(error, signal) {
      // DSH Gateway 使用 gateway/cancelled 表示远端主动取消；保留同一身份，
      // 避免 Connection/客户端把取消误判为可重试的 500 internal。
      if (signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
        return { status: 499, code: "gateway/cancelled", message: "请求已取消" };
      }
      if (error instanceof PayloadTooLargeError || host.rpc.isBodyTooLarge(error)) {
        return { status: 413, code: "payload-too-large", message: "请求体超过允许上限" };
      }
      if (error instanceof BadJsonError) {
        return { status: 400, code: "bad-request", message: error.message };
      }
      if (error?.code === "MODEL_DIRECTORY_CHANGED") {
        // 写入边界发现目录已变化：让客户端保留 dirty 草稿并重新校验。
        return { status: 400, code: "invalid-selection", message: error.message };
      }
      if (error?.message === IMAGE_TRANSCODER_UNAVAILABLE_MESSAGE
        || error?.message === "图片无法真实转换为 PNG") {
        return { status: 503, code: "image-transcoder-unavailable", message: error.message };
      }
      if (error?.code === "session-not-found") {
        return { status: 404, code: "session-not-found", message: "根会话不存在或尚未恢复" };
      }
      if (error?.code === "route-changed") {
        // 模型在图片提交期间被切换：这是可重试的状态冲突（409），不是客户端输入错误，
        // 也不是 500 内部错误；客户端据此 abandon 本次提交且不调用 session.prompt。
        return { status: 409, code: "route-changed", message: error.message };
      }
      if (error?.code === "route-commit-in-progress") {
        // 同一 Observer claim 的重复/并发 commit：一次性语义，保持 409 状态冲突。
        return { status: 409, code: "route-commit-in-progress", message: error.message };
      }
      if (error?.code === "route-claim-invalid") {
        // 任意/过期/跨会话/跨代际的 claim：显式 400，绝不把它当作校验成功。
        return { status: 400, code: "route-claim-invalid", message: error.message };
      }
      if (error?.code === "route-cleanup-invalid") {
        // 清理凭据无效/已消费/跨会话/跨代际：404（资源已不存在语义），
        // 且不区分是哪一项校验失败。客户端只做尽力清理，保留原始 prompt 错误。
        return { status: 404, code: "route-cleanup-invalid", message: error.message };
      }
      if (error?.code === "observer-cleanup-capacity") {
        // cleanup token 容量已满：拒绝启动新的 Observer child（503 服务暂不可用语义），
        // 而不是淘汰仍可能活跃的旧 token 把旧 child 变成孤儿。
        return { status: 503, code: "observer-cleanup-capacity", message: error.message };
      }
      if (error?.name === "FanoutValidationError") {
        return { status: 400, code: typeof error.code === "string" ? error.code : "invalid-fanout", message: error.message };
      }
      if (error instanceof ValidationError) {
        // 角色/模型目录校验失败是客户端输入问题，返回 400 而非 500。
        return { status: 400, code: "invalid-selection", message: error.message };
      }
      if (error?.validation === true) {
        // 结构化客户端输入错误（如图片声明的 mediaType 与真实字节不符）：
        // 必须返回 400，而不是把客户端问题伪装成 500 internal。
        return { status: 400, code: "invalid-selection", message: error.message };
      }
      if (error?.code === "SETTINGS_CONFLICT") {
        // 冲突必须携带 Host 的权威 revision：客户端据此只推进本地 revision 并保留 dirty
        // 草稿。revision 优先取错误的显式字段（adapter 可提供），否则实时读取当前描述符；
        // 两条传输（legacy HTTP 与 Connection）共用本函数，因此形状天然一致。
        let revision = Number.isSafeInteger(error?.currentRevision) && error.currentRevision >= 0 ? error.currentRevision : void 0;
        if (revision === void 0) {
          // 部分宿主/替身没有 settings.describe；此时只知道"冲突"，不能伪造 revision。
          try { revision = settings.describe?.().find((entry) => entry.ns === SETTINGS_NAMESPACE)?.revision; } catch { revision = void 0; }
        }
        return {
          status: 409,
          code: "settings-conflict",
          message: error.message,
          ...(Number.isSafeInteger(revision) && revision >= 0 ? { details: { revision } } : {}),
        };
      }
      // 原始内部错误只记日志，不向客户端回传（可能含路径/密钥等敏感信息）。
      ctx.logger.warn("dsh-expert-group rpc failed: " + (error instanceof Error ? error.message : String(error)));
      return { status: 500, code: "internal", message: "内部错误，请查看服务端日志" };
    }

    /**
     * Connection 传输入口：业务 dispatch 与 legacy 完全共用；envelope 转换由
     * rpc-host.js 的 adapter 负责，这里不再伪造 HTTP request/response。
     */
    async function handleConnectionRpc(endpoint, payload, signal) {
      return connectionRpcAdapter(endpoint, payload, signal);
    }

    /**
     * 自持 channel 路由的 HTTP handler：当宿主缺少 rpc.handle，或 handle 注册因宿主
     * Connection context 缺陷失败时，提供插件侧兼容传输。后者是当前 DSH 版本的实际
     * 兼容边界：插件不能修改 DSH，因此在仍具备公开 requestRejection fence 时接管路由。
     * 如果备用 route 自身也注册失败，外层仍会 fail-closed 到 503。
     *
     * 通道本身只用公开 seam 复刻：connection.requestRejection 提供与 /api 完全相同的
     * Host/Origin + browser-auth fence，wire 形状仍是公开的 client-request /
     * server-response，客户端无需区分两条传输，回退也不会降低认证强度。
     */
    async function handleChannelRequest(req, res, connection) {
      const requestLifecycle = createRpcRequestLifecycle(req, res);
      let channelRpcId;
      try {
        // fence 必须先于任何解析：未通过信任/认证的请求不进入 envelope，也读不到 body。
        const rejection = connection.requestRejection(req);
        if (rejection !== undefined) {
          sendText(res, rejection, rejection === 401 ? "unauthorized" : "forbidden");
          return;
        }
        const endpoint = channelEndpointFromPath(RPC_CHANNEL, new URL(req.url ?? "/", "http://dsh.internal").pathname);
        // 与宿主 rpcFetchHandler 一致：非 POST 或未声明的 endpoint 一律 404，不暴露内部形状。
        if (req.method !== "POST" || endpoint === undefined) { sendText(res, 404, "not found"); return; }
        if (!contentTypeAllowed(req)) { sendText(res, 415, "content type must be application/json"); return; }
        const raw = await host.rpc.readBody(req);
        let envelope;
        try {
          envelope = JSON.parse(raw || "{}");
        } catch {
          sendText(res, 400, "body is not JSON"); return;
        }
        const parsed = readClientRequestEnvelope(envelope, endpoint);
        channelRpcId = parsed.rpcId;
        if (parsed.ok !== true) {
          // envelope 形状错误同样是传输级拒绝入口：类别进入诊断，消息仍只回给该请求。
          rpcErrorTracker.note(parsed.code);
          sendJson(res, 200, writeServerResponseEnvelope(parsed.rpcId, {
            ok: false,
            error: { code: parsed.code, message: parsed.message, details: {} },
          }));
          return;
        }
        const result = await connectionRpcAdapter(endpoint, parsed.payload, requestLifecycle.signal);
        sendJson(res, 200, writeServerResponseEnvelope(parsed.rpcId, result));
      } catch (error) {
        // 自持 channel 超限仍需返回 200 server-response，保持客户端 envelope 关联；
        // rpcId 从传输层保留的有界前缀恢复，不能退化成 transport-failure。
        if (host.rpc.isBodyTooLarge(error) || requestLifecycle.signal.aborted === true
          || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
          let rpcId = channelRpcId;
          if (rpcId === undefined) {
            let fallbackPrefix = error?.prefix;
            if (typeof fallbackPrefix !== "string") {
              try { fallbackPrefix = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}); }
              catch { fallbackPrefix = ""; }
            }
            rpcId = rpcIdFromEnvelopeText(fallbackPrefix);
          }
          const mapped = host.rpc.isBodyTooLarge(error)
            ? { code: "payload-too-large", message: "请求体超过允许上限", details: {} }
            : { code: "gateway/cancelled", message: "请求已取消", details: {} };
          // 自持 channel 的早停路径也记类别：诊断面因此覆盖两条传输的全部拒绝入口，
          // 仍然只保存结构化 code，不保存读取到的前缀或错误消息。
          rpcErrorTracker.note(mapped.code);
          sendJson(res, 200, writeServerResponseEnvelope(rpcId, { ok: false, error: mapped }));
          return;
        }
        ctx.logger.warn("dsh-expert-group channel route failed: " + (error instanceof Error ? error.message : String(error)));
        sendText(res, 500, "handler failure");
      } finally {
        requestLifecycle.dispose();
      }
    }

    let connectionRpcActive = false;
    let connectionRpcRegistrationFailed = false;
    /**
     * 只读能力矩阵的连接状态（诊断专用，不参与任何判定）：
     * - connectionProbeStatus：Connection 服务探测结果 absent / unsupported / available；
     * - connectionChannelTransport：最终承载通道 "handle"（宿主独立 channel）、
     *   "route"（插件自持同名前缀路由）或 "none"；
     * - connectionFailureCode：固定枚举的失败原因。绝不写入宿主错误消息——那可能包含
     *   内部实现细节，诊断面只暴露可解释的类别。
     */
    let connectionProbeStatus = "absent";
    let connectionChannelTransport = "none";
    let connectionFailureCode = null;
    const CONNECTION_CHANNEL_EFFECT = "dsh-expert-group: connection rpc channel";
    if (typeof ctx.inject === "function") ctx.inject(["connection"], (connectionCtx) => {
      // 由组合模块统一判定 Connection 是否注入、是否支持 handle。三种结果的边界：
      // absent   → 保持 legacy exact route 服务（兼容旧宿主，与 fence 无关）。
      // handle API 缺失，或 handle 注册失败 → 有 fence 时自持同名前缀 route，无 fence 时
      //   fail-closed；备用 route 注册失败时同样 fail-closed。
      const transport = host.rpc;
      const probe = transport.probe(connectionCtx);
      connectionProbeStatus = probe.status;
      if (probe.status === "absent") return;
      if (probe.status === "unsupported") {
        connectionFailureCode = "probe-unsupported";
        ctx.logger.warn("dsh-expert-group " + probe.reason);
      }
      let connection;
      try {
        connection = connectionCtx?.connection;
      } catch (error) {
        connectionRpcRegistrationFailed = true;
        connectionFailureCode = "connection-unavailable";
        ctx.logger.warn("dsh-expert-group connection rpc unavailable: " + (error instanceof Error ? error.message : String(error)));
        return;
      }
      const rpc = probe.rpc;
      // 宿主 Connection 上是否真的存在 handle API。handle 缺失和注册失败都可在
      // requestRejection fence 可用时走插件备用 route；最终 route 注册失败仍会 fail-closed。
      const handleAvailable = typeof rpc?.handle === "function";
      // 已经建立的注册按后进先出释放；卸载或重新注入时不会把通道泄漏给下一个实例。
      const releases = [];
      const release = () => {
        connectionRpcActive = false;
        connectionChannelTransport = "none";
        while (releases.length > 0) {
          const dispose = releases.pop();
          try { void dispose(); } catch { /* 释放失败只影响该注册，不能阻塞卸载。 */ }
        }
      };
      // 首选宿主独立 channel：认证、envelope 与 node↔Fetch bridge 全由 Connection 完成。
      // 宿主 handle 缺失或注册失败时，再由插件使用同一公开 fence 自持路由；不抢占
      // Gateway 已注册的 /api interceptor，也不绕过 requestRejection。
      if (handleAvailable) {
        try {
          const removeHandle = rpc.handle(RPC_CHANNEL, handleConnectionRpc);
          releases.push(() => removeHandle?.());
          connectionRpcActive = true;
          connectionChannelTransport = "handle";
        } catch (error) {
          // 当前 DSH 版本的 handle 注册可能因 Connection 自身 context 缺少 webServer 而失败。
          // 插件不能修改 DSH 本体，因此保留告警并继续尝试带 requestRejection fence 的
          // 插件自持 route；只有备用 route 也失败时才置为 fail-closed。
          connectionFailureCode = "handle-registration-failed";
          ctx.logger.warn("dsh-expert-group connection rpc channel unavailable, trying plugin route: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      // handle 缺失或 handle 注册失败时走此兼容回退；requestRejection 是必须的
      // 安全前提，不能在没有公开认证 fence 的情况下自行暴露 channel。
      if (connectionRpcActive !== true && connectionRpcRegistrationFailed !== true
        && typeof connection?.requestRejection === "function") {
        try {
          const removeRoute = webServer.register({
            kind: "prefix",
            path: RPC_CHANNEL,
            handler: (req, res) => handleChannelRequest(req, res, connection),
          });
          releases.push(() => removeRoute?.());
          connectionRpcActive = true;
          connectionChannelTransport = "route";
          ctx.logger.info("dsh-expert-group connection channel served by plugin-hosted route");
        } catch (error) {
          connectionRpcRegistrationFailed = true;
          connectionFailureCode = "route-registration-failed";
          ctx.logger.warn("dsh-expert-group connection channel route registration failed: " + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (connectionRpcActive !== true) {
        // Connection 存在但通道建立不起来（handle API 缺失、handle 注册失败或自持 route
        // 注册失败）：legacy route 必须保持拒绝并返回 503，不能把版本不匹配或宿主缺陷变成
        // browser-auth/token fence 的认证旁路。
        connectionRpcRegistrationFailed = true;
        connectionChannelTransport = "none";
        if (connectionFailureCode === null) {
          connectionFailureCode = handleAvailable !== true ? "handle-api-unavailable" : "channel-unavailable";
        }
        if (handleAvailable !== true) {
          ctx.logger.warn("dsh-expert-group connection rpc handle API unavailable");
        }
        return;
      }
      try {
        // 生命周期绑定统一由 host.rpc 组合模块完成：优先跟随 Connection 服务，
        // 宿主未提供 effect 时才回落到插件 fiber，且 release 本身保持幂等。
        const registration = host.rpc.createRegistration({
          connectionCtx,
          fallbackEffect: ctx.effect,
          release,
          label: CONNECTION_CHANNEL_EFFECT,
        });
        registration.attach();
      } catch (error) {
        release();
        connectionRpcRegistrationFailed = true;
        connectionFailureCode = "effect-registration-failed";
        ctx.logger.warn("dsh-expert-group connection channel effect registration failed: " + (error instanceof Error ? error.message : String(error)));
      }
    });

    // ── 只读能力矩阵与运行时诊断（meta 动作的投影） ────────────────────────
    /** 硬依赖服务的只读回执：inject 声明决定插件能否加载，这里只反映实际可达性。 */
    const hardDependencyCapability = (service) => ({
      required: true,
      status: service === undefined || service === null ? "unknown" : "available",
    });

    /**
     * 宿主能力矩阵。
     *
     * - rootTurnWait 描述 root turn 等待所依赖的宿主 seam：权威档是
     *   `subagents.listDescendants` **加上**同一份 exact runtime `agents.list()` 快照
     *   （catalog 只证明 session residency；运行判定必须用 runtime Agent.status 交叉校验，
     *   并用 runtime 快照验证 live 后代已被 catalog 完整覆盖——缺任何一半都不能证明静止），
     *   降级档是 `workspace/session-activity` waterfall（只能报告 activity，不能证明
     *   quiet）。两档都无法证明静止时一律继续等待（fail-closed，绝不把未知当成无人
     *   运行）；专家派发与设置页继续可用，降级由 status/degradation 字段显式说明。
     *   因此投影是四档：
     *   1. listing + 可调用的 `agents.list()` 都在 → `available` / degradation `null`
     *      （完整 catalog 与 runtime 交叉校验，可证明静止）；
     *   2. 只有 listing（缺 runtime 快照，等待实际 fail-closed）→ `degraded` +
     *      `root-turn-wait-runtime-agent-listing-unavailable`；
     *   3. 缺完整 catalog，但 `agents.list()` 可调用（strict runtime-only fallback，仍能
     *      给出可证明的状态）或只有 waterfall（只能提供正向 running 证据）→ `degraded` +
     *      `root-turn-wait-descendant-listing-unavailable`；
     *   4. 三者都不可用 → `unavailable` + `root-turn-wait-descendant-query-unavailable`。
     * - Connection RPC 是**可选能力**：缺失时回落 legacy exact route，无法建立通道时
     *   fail-closed（legacy 拒绝并返回 503），状态与失败类别都从固定枚举取值。
     * - storageDomain 是运行期硬依赖；attachments / sessionQuery 是可选能力，缺失时
     *   只禁用图片规范化 / 冷会话精确读取。
     *
     * 只读：不调用任何业务方法、不触发注册、不写入任何状态。
     */
    function describeHostCapabilities() {
      const storageState = storageBinding.describe();
      // root turn 等待的后代查询能力**分两档**，绝不能只把「ctx.waterfall 是函数」当成
      // provider 可用（那只能证明 Cordis 事件服务在，不能证明有任何 provider）：
      // - `available`：`subagents.listDescendants` 存在——权威、可证明「没有 running 后代」；
      // - `degraded`：只有 waterfall——它**只能报告 activity，不能证明 quiet**：
      //   唯一可用的明确结论是「确有 running 后代」（用于继续等待）；sentinel、任何
      //   空数组（含其他 listener 返回的 fresh `[]`）、无 subagent 族与 malformed 都
      //   是未知，等待继续；
      // - `unavailable`：两者都没有，等待一律 fail-closed。
      // 严格 Context 对未声明属性抛错，因此读取本身也要 fail-closed。
      let descendantListingAvailable = false;
      try {
        descendantListingAvailable = typeof subagents?.listDescendants === "function";
      } catch {
        descendantListingAvailable = false;
      }
      let sessionActivityAvailable = false;
      try {
        sessionActivityAvailable = typeof ctx.waterfall === "function";
      } catch {
        sessionActivityAvailable = false;
      }
      // 权威静止证明的另一半：**可调用且返回数组**的 agents.list()。只看到 listing 就报
      // available 会误报——缺 runtime 快照时等待实际 fail-closed（无法校验运行判定与覆盖
      // 关系）；可调用但返回非数组同样不能当快照用（等待侧对此也 fail-closed）。
      // 这里只做只读可用性探测：读取属性并在 try 内调用一次，绝不触发注册或写入状态。
      let runtimeAgentListingAvailable = false;
      try {
        const listAgents = agents?.list;
        if (typeof listAgents === "function") {
          runtimeAgentListingAvailable = Array.isArray(listAgents.call(agents));
        }
      } catch {
        runtimeAgentListingAvailable = false;
      }
      const connectionStatus = connectionChannelTransport === "handle"
        ? "available"
        : connectionChannelTransport === "route"
          ? "degraded"
          : connectionRpcRegistrationFailed === true
            ? "fail-closed"
            : connectionProbeStatus === "absent" ? "legacy" : "pending";
      return {
        version: CAPABILITY_REPORT_VERSION,
        host: {
          // 声明于 inject 的硬依赖：缺任何一个插件都不加载（最低宿主契约）。
          tools: hardDependencyCapability(tools),
          subagents: hardDependencyCapability(subagents),
          agents: hardDependencyCapability(agents),
          settings: hardDependencyCapability(settings),
          webServer: hardDependencyCapability(webServer),
          systemPrompt: hardDependencyCapability(systemPrompt),
          llm: hardDependencyCapability(llm),
          // rootTurnWait：可选宿主 seam；缺失时等待判定一律 fail-closed（继续等待）。
          rootTurnWait: {
            required: false,
            status: descendantListingAvailable && runtimeAgentListingAvailable
              ? "available"
              : descendantListingAvailable || runtimeAgentListingAvailable || sessionActivityAvailable
                ? "degraded"
                : "unavailable",
            degradation: descendantListingAvailable && runtimeAgentListingAvailable
              ? null
              : descendantListingAvailable
                // 完整 catalog 在、runtime 快照不可用：等待 fail-closed，诊断必须如实降级。
                ? "root-turn-wait-runtime-agent-listing-unavailable"
                : runtimeAgentListingAvailable || sessionActivityAvailable
                  // 缺完整 catalog，但仍有可证明的查询路径：strict runtime-only fallback
                  // （agents.list() + 严格血缘/状态校验）或 waterfall-only（只能正向 running）。
                  ? "root-turn-wait-descendant-listing-unavailable"
                  : "root-turn-wait-descendant-query-unavailable",
          },
          // Connection RPC：可选能力，缺失时回落 legacy route。
          connectionRpc: {
            required: false,
            status: connectionStatus,
            probe: connectionProbeStatus,
            transport: connectionChannelTransport,
            failure: connectionFailureCode,
          },
          storageDomain: {
            required: true,
            status: storageState.hasBinding === true ? "available" : "pending",
            binding: typeof storageState.status === "string" ? storageState.status : "none",
          },
          attachments: {
            required: false,
            status: attachmentStore === undefined ? "absent" : "available",
            degradation: attachmentStore === undefined ? "image-normalization-disabled" : null,
          },
          sessionQuery: {
            required: false,
            status: expertGroupSessionQuery === undefined ? "absent" : "available",
            degradation: expertGroupSessionQuery === undefined ? "cold-session-read-disabled" : null,
          },
        },
      };
    }

    /**
     * 系统 Toast 诊断的固定 token 白名单。
     *
     * 为什么不复用 diagnosticToken：它的字符面允许 a/b、x.log 这类形如相对路径的字符串，
     * 而系统 Toast 的可用性只需要模块声明的固定类别。白名单保证注入实现返回的自由文本
     * （错误消息、AUMID、命令行片段）一律进不了诊断面。
     */
    const systemToastTokenSet = new Set(Object.values(SYSTEM_TOAST_REASONS));
    function systemToastDiagnosticToken(value) {
      return typeof value === "string" && systemToastTokenSet.has(value) ? value : null;
    }

    /**
     * 系统 Toast 的只读诊断投影（ADR 0005）。
     *
     * 逐字段重建白名单结构，绝不解构 describe() 原对象：注入实现即使返回正文、AUMID、
     * 命令行或绝对路径也不会进入诊断。计数一律归一为非负安全整数，平台只保留两个固定
     * 枚举，reason 只保留模块声明的 token；适配器缺失或 describe() 抛错时显式
     * status="absent"，不用伪造的计数冒充可用。
     */
    function describeSystemToastDiagnostics() {
      let state = null;
      try {
        state = typeof systemToast?.describe === "function" ? systemToast.describe() : null;
      } catch {
        state = null;
      }
      if (state === null || typeof state !== "object") {
        return {
          status: "absent",
          version: 0,
          platform: "unknown",
          aumidResolved: false,
          aumidReason: null,
          inflight: 0,
          queued: 0,
          sent: 0,
          failed: 0,
          dropped: 0,
          lastReason: null,
        };
      }
      return {
        status: "available",
        version: diagnosticCount(state.version),
        platform: state.platform === "windows" ? "windows" : "unsupported",
        aumidResolved: state.aumidResolved === true,
        // 只暴露"解析结果类别/是否已解析"，绝不暴露 AUMID 本身：
        // aumidReason=ok 表示已从与 process.execPath 匹配的快捷方式派生出身份。
        aumidReason: systemToastDiagnosticToken(state.aumidReason),
        inflight: diagnosticCount(state.inflight),
        queued: diagnosticCount(state.queued),
        sent: diagnosticCount(state.sent),
        failed: diagnosticCount(state.failed),
        dropped: diagnosticCount(state.dropped),
        lastReason: systemToastDiagnosticToken(state.lastReason),
      };
    }

    /**
     * 运行时诊断摘要。
     *
     * 只输出计数、固定状态枚举与结构化错误类别：没有会话/agent id、没有 prompt 或原始
     * 请求体、没有 token/Cookie/authorization、没有任何文件系统路径。所有数组都有固定
     * 上限（RPC 错误类别 8 条），因此报告大小不随任务或历史增长。
     */
    function describeRuntimeDiagnostics() {
      const settingsState = settingsRuntime.describe();
      const storageState = storageBinding.describe();
      const lineageState = host.lineage.describe();
      const notificationState = host.notifications.describe();
      const handoffState = host.handoff.describe();
      const recoveryState = recovery.describe();
      const fanoutState = typeof fanoutHost?.describe === "function" ? fanoutHost.describe() : {};
      const tasks = typeof fanoutHost?.listTasks === "function" ? fanoutHost.listTasks() : [];
      // 队列深度按 shard 聚合：maxTasks 有上界（resource-budget），因此这里是常数级工作。
      let queuedShards = 0;
      let runningShards = 0;
      let activeParents = 0;
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const counts = task?.counts ?? {};
        queuedShards += diagnosticCount(counts.queued);
        runningShards += diagnosticCount(counts.running);
        if (diagnosticCount(counts.pending) > 0) activeParents += 1;
      }
      const concurrency = fanoutState.concurrencyLimits;
      const roleLimits = concurrency?.roles;
      const roleOverrides = {};
      if (roleLimits !== null && typeof roleLimits === "object") {
        // 只保留启用角色的上限：角色名是公开契约，不携带任何会话数据。
        for (const role of activeRoles()) {
          if (Number.isSafeInteger(roleLimits[role])) roleOverrides[role] = roleLimits[role];
        }
      }
      return {
        version: CAPABILITY_REPORT_VERSION,
        // 时间戳只用于"诊断新鲜度"判断，不参与业务判定。
        generatedAt: Date.now(),
        children: {
          // 活动/已登记 child 的数量（不含 id）。
          active: diagnosticCount(childActivationStates.size),
          tracked: diagnosticCount(recoveryRecords.size),
        },
        fanout: {
          tasks: diagnosticCount(fanoutState.tasks),
          activeAttempts: diagnosticCount(fanoutState.activeAttempts),
          settledTasks: diagnosticCount(fanoutState.settledTasks),
          activeParents,
          queuedShards,
          runningShards,
          restorePending: fanoutState.restorePending === true,
          closed: fanoutState.closed === true,
          concurrency: {
            default: diagnosticCount(concurrency?.default),
            roles: roleOverrides,
            // 解析来源与最近一次非法上限只保留固定枚举/类型，不含设置原文。
            source: diagnosticToken(concurrency?.source, "unknown"),
            invalidKind: concurrency?.invalid === undefined ? null : diagnosticToken(concurrency.invalid.kind),
          },
        },
        recovery: {
          rebuilds: diagnosticCount(recoveryState.rebuilds),
          trackedContexts: diagnosticCount(recoveryState.trackedContexts),
          disposed: recoveryState.disposed === true,
          limit: diagnosticCount(AUTO_RECOVERY_LIMIT),
        },
        // 两阶段图片路由的只读计数（纯数字，不含 claim id / child id / provider / model）：
        // 客户端与测试据此证明签发/提交/取消/失败路径都会回收 claim 与 cleanup token。
        imageRoutes: {
          claims: diagnosticCount(routeClaims.size),
          cleanupTokens: diagnosticCount(observerCleanupTokens.size),
          cleanupReservations: diagnosticCount(pendingCleanupReservations),
          claimLimit: diagnosticCount(ROUTE_CLAIM_LIMIT),
          cleanupTokenLimit: diagnosticCount(OBSERVER_CLEANUP_LIMIT),
        },
        settings: {
          // 模型目录代次、在途写入与已跟踪的目录 namespace 数（settings 提交诊断面）。
          generation: diagnosticCount(settingsState.generation),
          pendingWrites: diagnosticCount(settingsState.pendingWrites),
          trackedNamespaces: diagnosticCount(settingsState.trackedNamespaces),
        },
        storage: {
          hasBinding: storageState.hasBinding === true,
          status: typeof storageState.status === "string" ? diagnosticToken(storageState.status, "none") : "none",
          generation: diagnosticCount(storageState.generation),
          tables: Array.isArray(storageState.tableNames) ? diagnosticCount(storageState.tableNames.length) : 0,
        },
        lineage: {
          currentRoots: diagnosticCount(lineageState.currentRoots),
          parentTasks: diagnosticCount(lineageState.parentTasks),
          deferredTasks: diagnosticCount(lineageState.deferredTasks),
        },
        handoff: {
          pending: diagnosticCount(handoffState.pending),
          disposed: handoffState.disposed === true,
        },
        notifications: {
          roots: diagnosticCount(notificationState.roots),
          hasAgentQuery: notificationState.hasAgentQuery === true,
          disposed: notificationState.disposed === true,
          // Windows 系统 Toast 适配器的可用性投影：与既有字段同级共存，
          // notifications.roots 等语义与形状保持不变（客户端按白名单只读 roots）。
          systemToast: describeSystemToastDiagnostics(),
        },
        rpc: {
          // 只保留结构化错误类别：没有消息、请求体、路径或认证信息。
          recentErrors: rpcErrorTracker.snapshot(),
          categoryLimit: RPC_ERROR_CATEGORY_LIMIT,
        },
      };
    }

    ctx.effect(() => webServer.register({
      kind: "exact",
      path: RPC_PATH,
      // Connection 已安装或安装失败时均拒绝 legacy route，避免旁路 browser-auth/token fence。
      handler: (req, res) => (connectionRpcActive || connectionRpcRegistrationFailed)
        ? sendError(res, connectionRpcRegistrationFailed ? 503 : 404, "connection-required", "请通过 DSH Connection RPC 调用此 endpoint")
        : handleRpc(req, res),
    }), "dsh-expert-group: rpc route");
  },
};
