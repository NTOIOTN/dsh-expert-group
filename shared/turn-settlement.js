/**
 * turn 文本与任务结算。
 *
 * turn 内文本/消息 id 提取、任务绑定结算、取消语义与恢复重建判定。
 * 本文件由原 `shared.js` 的 1895–2289 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/turn-settlement
 */
import { delegationTaskKey, rootStructuredPathGuard } from "./structured-path.js";
import { isSubagentCapacityError } from "./capacity-errors.js";
import { AUTO_RECOVERY_LIMIT } from "./recovery-ledger.js";
import { isPermanentPiAiFailure, recoveryOpIsAccepted, recoveryOpIsPending } from "./retry-policy.js";

/**
 * 收集某 turn 内所有 assistant/message 事件中的非空文本块。
 * 纯函数：只依赖事件日志结构（{type:"assistant/message", data:{turn, message:{content}}}），
 * 不依赖 DOM / Node 服务。
 * @param {Array} events - session.events（不可变事件日志）。
 * @param {number} turn - turn 号。
 * @returns {Array<{type:"text", text:string}>} 该 turn 的非空文本块（保持出现顺序）。
 */
export function turnTextBlocks(events, turn) {
  const blocks = [];
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return blocks;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    if (event?.data?.turn !== turn) continue;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      // 纯空白文本不算有效输出：trim 后为空则跳过。
      if (block?.type === "text" && typeof block?.text === "string" && block.text.trim().length > 0) {
        blocks.push({ type: "text", text: block.text });
      }
    }
  }
  return blocks;
}

/**
 * 某 turn 内是否有非空 assistant 文本输出（「空返回」判定）。
 * @param {Array} events - session.events。
 * @param {number} turn - turn 号。
 * @returns {boolean} 有非空文本输出返回 true。
 */
export function turnHasNonEmptyText(events, turn) {
  return turnTextBlocks(events, turn).length > 0;
}

/**
 * 读取一条 user/message 事件的消息 id。
 * 生产 DSH 契约是 SessionEventMap['user/message'] = UserMessage：id/role/content/
 * source **平铺在 event.data 上**，因此必须优先读 event.data.id。历史日志与旧测试
 * 夹具曾把消息包在 event.data.message 里，保留该形状作为回退（只在平铺 id 缺失或
 * 为空串时使用），避免回归旧数据；两种形状都没有可用字符串 id 时返回 undefined。
 * 注意：这里只读取 id，不改变 assistant/message（其 payload 确实是
 * { turn, step, message }）与 tool/result 的既有语义。
 * @param {object} [event] - 单条 SessionEvent。
 * @returns {string|undefined} 可用消息 id。
 */
function messageIdOfEvent(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return void 0;
  if (typeof data.id === "string" && data.id.length > 0) return data.id;
  const legacy = data.message;
  if (legacy !== null && typeof legacy === "object"
    && typeof legacy.id === "string" && legacy.id.length > 0) return legacy.id;
  return void 0;
}

/**
 * 收集某 turn 内所有 user/message 的消息 id。
 * 用于按消息归属判定 turn：turn/end 的 data.reason 不携带消息 id，需要回看该
 * turn 的 user/message 事件才能确认「这个 turn 是哪次委派/恢复指令触发的」。
 * 读到的 id 直接决定活动 affectedPaths 的终态释放能否命中本 turn：拿不到 id 时
 * rootStructuredPathGuard 会永久阻塞与已结束专家任务重叠的 root 结构化文件操作。
 * @param {Array} events - session.events。
 * @param {number} turn - turn 号。
 * @returns {Set<string>} 该 turn 内的消息 id 集合。
 */
export function messageIdsOfTurn(events, turn) {
  const ids = new Set();
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return ids;
  let started = false;
  for (const event of events) {
    if (event?.type === "turn/start") {
      if (event?.data?.turn === turn) started = true;
      else if (started) break; // 已越过该 turn 的边界（turn/start 按 turn 号顺序追加）
      continue;
    }
    if (started && event?.type === "user/message") {
      const id = messageIdOfEvent(event);
      if (id !== void 0) ids.add(id);
    }
  }
  return ids;
}

/**
 * 某 turn 的消息 id 归属：事件日志中的 user/message 与 claimed 认领映射
 * （message.id -> turn）的**并集**。claimed 覆盖「消息已被 inbox 认领但
 * user/message 未落盘」的缺口（pre-step reject / 取消 / 异常），保证消息
 * 恢复 op 完结与任务绑定都能找到归属（B2 路径 B）。
 * @param {Map<string, number>} [claimed] - message.id -> turn 认领映射。
 * @param {Array} [events] - session.events。
 * @param {number} turn - turn 号。
 * @returns {Set<string>} 该 turn 的消息 id 集合。
 */
export function messageIdsOfTurnWithClaimed(claimed, events, turn) {
  const ids = messageIdsOfTurn(events, turn);
  if (claimed instanceof Map && Number.isSafeInteger(turn)) {
    for (const [messageId, claimedTurn] of claimed) {
      if (claimedTurn === turn && typeof messageId === "string") ids.add(messageId);
    }
  }
  return ids;
}

/**
 * 提取消息 content 中的文本块拼接（S1-D claimed 补绑按任务文本匹配用）。
 * 与 turnTextBlocks 同构：只取 {type:"text", text} 块，保持出现顺序。
 * @param {object} [message] - user 消息（含 content 块数组）。
 * @returns {string} 拼接后的文本。
 */
export function messageTextOf(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block?.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 恢复消息 id 的 claimed 占位写入（P2）：manager 投递成功后把
 * message.id -> null 记入 claimed 占位（null = 尚未绑定 turn，后续
 * agent/inbox/claimed 用真实 turn 覆盖）。
 * **已有条目绝不覆盖**：promise resolve 可能晚于 inbox 认领事件，若已写入
 * 真实 turn，直接 set(null) 会把真实归属抹掉——先查 has 再写。
 * @param {Map<string, number|null>} claimed - message.id -> turn 认领映射。
 * @param {string} messageId - 恢复消息 id。
 * @returns {boolean} 确实写入占位返回 true；已存在条目（不覆盖）或非法输入返回 false。
 */
export function rememberClaimedPlaceholder(claimed, messageId) {
  if (!(claimed instanceof Map) || typeof messageId !== "string" || messageId.length === 0) return false;
  if (claimed.has(messageId)) return false;
  claimed.set(messageId, null);
  return true;
}

/**
 * claimed 补绑 pendingMessage 任务（S1-D 任务 binding 的 acceptance 竞态）：
 * 当 claimed 消息 id 在 record.tasks 中找不到 binding 时（正常路径的
 * steer/startContinuable admission 回调晚于 inbox 认领事件），用消息文本
 * 的归一化任务 key 匹配 binding 表中「pendingMessage === true 且
 * messageId === null」的项；匹配则回填 binding.messageId = claimed 消息 id
 * 并清 pendingMessage。只处理待回填的项，已确定的绑定绝不被覆盖。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {object} [message] - 被 inbox 认领的消息（含 id 与 content 文本块）。
 * @returns {boolean} 发生补绑返回 true。
 */
export function rebindPendingTaskByClaimed(tasks, message) {
  if (!(tasks instanceof Map) || message === null || typeof message !== "object") return false;
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0) return false;
  // 消息 id 已落在某个 binding 上：正常路径已回填，无需补绑。
  for (const binding of tasks.values()) {
    if (binding?.messageId === messageId) return false;
  }
  const taskKey = delegationTaskKey(messageTextOf(message));
  if (taskKey.length === 0) return false;
  const binding = tasks.get(taskKey);
  if (binding === void 0 || binding.pendingMessage !== true || binding.messageId !== null) return false;
  binding.messageId = messageId;
  binding.pendingMessage = false;
  return true;
}

/**
 * forgetTask 的 child 身份保护判定（P5）：仅当 scope 当前记录的 child 与
 * record 的 childId 一致时才允许 forget——旧 route child 的迟到失败不得
 * 删除新 route 同名任务指纹（route 切换后 delegationTracker 的 child 已
 * 换成新 child，tasks 记录也已清空重建）。
 * @param {string|undefined} currentChildId - delegationTracker.getChild(scope) 的 childId。
 * @param {string|undefined} recordChildId - 恢复记录所属 child 的 session id。
 * @returns {boolean} childId 一致（且 recordChildId 非空）返回 true。
 */
export function shouldForgetTask(currentChildId, recordChildId) {
  return typeof recordChildId === "string" && recordChildId.length > 0 && currentChildId === recordChildId;
}

/**
 * 收集一个 turn 应结算的任务 key：恢复 op 继承的 taskKeys 与消息 id 反查结果
 * 取并集。handleChildTurnEnd 用它清理活动范围登记，applyTurnToTasks 用同一
 * 规则回写绑定，避免恢复消息替换原消息 id 后丢失原任务归属。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Set<string>} [turnMsgIds] - 该 turn 的消息 id 并集。
 * @param {Array|Set} [taskKeys] - 恢复 op 继承的原任务 key。
 * @returns {Array<string>} 去重后的命中任务 key。
 */
export function taskKeysForTurn(tasks, turnMsgIds, taskKeys) {
  const targets = new Set();
  if (taskKeys !== void 0 && taskKeys !== null) {
    for (const key of taskKeys) {
      if (typeof key === "string") targets.add(key);
    }
  }
  if (tasks instanceof Map && turnMsgIds instanceof Set) {
    for (const [key, binding] of tasks) {
      if (typeof binding?.messageId === "string" && turnMsgIds.has(binding.messageId)) targets.add(key);
    }
  }
  return [...targets];
}

/**
 * 把一次 turn/end 的结局回写到任务绑定表（S1-C，B3 任务绑定跨恢复链传播）。
 * handleChildTurnEnd 与恢复失败收口共用本纯函数：
 * - outcome === "success"：命中绑定写入 outcome:"success" 与 blocks（该 turn
 *   的非空文本块），messageId 保留原消息 id（供 reused 识别原任务）；
 * - outcome === "failed"：命中绑定写入 outcome:"failed" 与 failureMessage
 *   （确定失败，含恢复链达上限），返回被写终态的 taskKey 列表——调用方据此
 *   delegationTracker.forgetTask（相同 prompt 可重新排队而非永久 reused）；
 * - outcome === "recoverable"：不写终态（恢复链继续，由调用方创建新 op 并
 *   继承 taskKeys，不要丢）。
 * 命中范围：显式 taskKeys（恢复 turn 经 op 继承的原任务 key）∪ 按 turnMsgIds
 * 反查 binding.messageId 的项；taskKeys 缺省时仅按 turnMsgIds 反查。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Array} [events] - session.events（成功时取输出文本块）。
 * @param {number} turn - turn 号。
 * @param {Set<string>} [turnMsgIds] - 该 turn 消息 id 并集（事件 ∪ claimed）。
 * @param {"success"|"failed"|"recoverable"} outcome - 任务结局。
 * @param {object} [reason] - turn/end 的 data.reason（failureMessage 缺省兜底）。
 * @param {string} [failureMessage] - 确定失败的完整错误文案（调用方已格式化）。
 * @param {Array|Set} [taskKeys] - 恢复 op 继承的任务 key 列表（可选）。
 * @returns {Array<string>} 被写为确定失败的 taskKey 列表（调用方 forgetTask）。
 */
export function applyTurnToTasks(tasks, events, turn, turnMsgIds, outcome, reason, failureMessage, taskKeys) {
  const written = [];
  if (!(tasks instanceof Map) || (outcome !== "success" && outcome !== "failed")) return written;
  // 与活动范围终态清理共用同一归属规则，避免恢复消息换 id 后失去原任务 key。
  const targets = taskKeysForTurn(tasks, turnMsgIds, taskKeys);
  if (outcome === "success") {
    const blocks = turnTextBlocks(events, turn);
    for (const key of targets) {
      const binding = tasks.get(key);
      if (binding === void 0 || typeof binding !== "object") continue;
      binding.outcome = "success";
      binding.blocks = blocks;
    }
  } else {
    const message = typeof failureMessage === "string" && failureMessage.length > 0
      ? failureMessage
      : `subagent run failed${reason?.kind !== void 0 ? ` (${String(reason.kind)})` : ""}`;
    for (const key of targets) {
      const binding = tasks.get(key);
      if (binding === void 0 || typeof binding !== "object") continue;
      binding.outcome = "failed";
      binding.failureMessage = message;
      written.push(key);
    }
  }
  return written;
}

/**
 * 将尚未投递的自动恢复任务标记为被新任务取代（纯函数契约）：
 * - 只处理显式 taskKeys，保持恢复 op 的任务归属，不触碰消息/事件日志；
 * - 写入明确的 outcome:"superseded" 与 failureMessage，供后续复用识别；
 * - 将 pendingMessage 清除，防止迟到 claimed 事件重新绑定已失效任务。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Array|Set} taskKeys - 要失效化的任务 key 集合。
 * @param {string} message - 面向任务记录的取代原因。
 * @returns {Array<string>} 实际写入为 superseded 的 taskKey 列表。
 */
export function supersedeTaskBindings(tasks, taskKeys, message) {
  const written = [];
  if (!(tasks instanceof Map) || taskKeys === void 0 || taskKeys === null) return written;
  for (const key of taskKeys) {
    if (typeof key !== "string") continue;
    const binding = tasks.get(key);
    if (binding === void 0 || typeof binding !== "object") continue;
    binding.outcome = "superseded";
    binding.failureMessage = typeof message === "string" && message.length > 0
      ? message
      : "task was superseded by a newer task";
    if (binding.pendingMessage === true) binding.pendingMessage = false;
    written.push(key);
  }
  return written;
}

/**
 * 只有 DSH 明确标注由根/父代理或用户发起的取消，才是用户意图明确的终态。
 * hook、disposed、legacy 或缺少来源的 aborted 都可能是宿主短暂故障，必须走
 * 自动继续而不是静默放弃原任务。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {boolean} 明确 parent/user 取消返回 true。
 */
export function hasExplicitParentOrUserCancellation(reason) {
  return reason?.kind === "aborted" && (reason?.reason?.kind === "parent" || reason?.reason?.kind === "user");
}

/**
 * DSH 结构化 turn/end 错误中明确不可通过自动 continuation 修复的错误码。
 * 未知 code 保持旧的 recoverable 策略；只有已知的认证、权限、配置、路由、
 * 非法请求和上下文限制错误才 fail-closed，绝不解析错误文本。
 */
export const PERMANENT_TURN_ERROR_CODES = Object.freeze([
  "AUTHORIZATION",
  "UNAUTHENTICATED",
  "ACCESS_DENIED",
  "PERMISSION",
  "PERMISSION_DENIED",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "CONFIGURATION",
  "CONFIG_ERROR",
  "INVALID_CONFIGURATION",
  "INVALID_CONFIG",
  "INVALID_ARGUMENT",
  "INVALID_ARGS",
  "REQUEST_EXTENSION",
  "CONTEXT_WINDOW_EXCEEDED",
  "QUOTA",
  "ABORTED",
  "CANCELLED",
  "CANCELED",
]);

/**
 * 判断 turn/end 是否携带已知永久错误。只读取结构化 reason.error.code。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {boolean} 已知永久错误返回 true。
 */
export function isPermanentTurnError(reason) {
  if (reason?.kind !== "error" || reason?.error === null || typeof reason?.error !== "object") return false;
  if (typeof reason.error.code === "string" && PERMANENT_TURN_ERROR_CODES.includes(reason.error.code)) return true;
  return isPermanentPiAiFailure(reason.error);
}

/**
 * 一次 turn/end 的结局分类：
 * - "success"：completed 且有非空文本输出（成功，恢复计数清零）；
 * - "terminal"：明确 parent/user 取消，或结构化永久错误；
 * - "recoverable"：其他非成功结果，包括来源不明的 aborted、未知 code 的 error、
 *   max-tokens、空 completed、refusal、blocked、interrupted 与未知 kind。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @param {boolean} hasNonEmptyOutput - 该 turn 是否有非空 assistant 文本输出。
 * @returns {"success"|"recoverable"|"terminal"}
 */
export function classifyTurnOutcome(reason, hasNonEmptyOutput) {
  if (reason?.kind === "completed" && hasNonEmptyOutput === true) return "success";
  if (hasExplicitParentOrUserCancellation(reason) || isPermanentTurnError(reason)) return "terminal";
  return "recoverable";
}

/**
 * 判断原 child 无法继续时是否允许按既有安全边界重建。除明确 NOT_RESUMABLE、
 * child 已销毁或 route 已改变外，宿主、权限和显式取消错误必须保留原错误契约。
 *
 * 容量耗尽**不**允许重建：它表示进程名额已被占满，与 child 是否可用无关，
 * 重建只会立刻再次撞上限（并消耗一份本可用于其他角色的名额），因此必须显式排除。
 *
 * @param {object} [error] - sendMessage/start 失败。
 * @param {object} [state] - childDestroyed / routeChanged 状态。
 * @returns {boolean} 可以创建替代 continuable child 返回 true。
 */
export function shouldRebuildRecoveryChild(error, state = {}) {
  if (isSubagentCapacityError(error)) return false;
  return error?.code === "NOT_RESUMABLE" || state?.childDestroyed === true || state?.routeChanged === true;
}

/**
 * 重建 child 成功后是否可以把它写为当前 parent+role scope：无当前 child 的
 * cold-resume scope 与仍指向被替换 old child 的 scope 都应更新；已经被并发新任务
 * 安全替换成其他 child 时必须保持该新 child，不得覆盖。
 */
export function shouldInstallRebuiltChild(currentChildId, oldChildId) {
  return currentChildId === void 0 || currentChildId === oldChildId;
}

/**
 * startContinuable await 返回后的重建提交 guard。父销毁、插件卸载或 op 被终止
 * 时 record 已从 recoveryRecords 删除，迟到 child 绝不能重新插回记录或
 * 活动范围登记。controller abort 也表示这次 admission 的结果必须被丢弃。
 */
export function recoveryRebuildCanCommit(recoveryRecords, record, op) {
  return recoveryRecords instanceof Map
    && recoveryRecords.get(record?.childId) === record
    && recoveryOpIsPending(record?.pendingRecoveries, op)
    && !recoveryOpIsAccepted(op)
    && op?.controller?.signal?.aborted !== true;
}

/**
 * 是否需要自动恢复：任何非成功且非明确取消的结果，且未达到连续恢复上限。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @param {boolean} hasNonEmptyOutput - 该 turn 是否有非空 assistant 文本输出。
 * @param {number} recoveryCount - 该 child 当前的连续自动恢复次数。
 * @returns {boolean} 需要自动恢复返回 true。
 */
export function shouldAutoRecover(reason, hasNonEmptyOutput, recoveryCount) {
  if (classifyTurnOutcome(reason, hasNonEmptyOutput) !== "recoverable") return false;
  const count = Number.isSafeInteger(recoveryCount) && recoveryCount >= 0 ? recoveryCount : 0;
  return count < AUTO_RECOVERY_LIMIT;
}
