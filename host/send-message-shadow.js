/**
 * 组合根顶层的第 S8 段（R1 票据 06）：自 index.js 第 1197–1449 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { compositionErrorMessage } from "./expert-guards.js";

/** 宿主 guidance 判定读取的工具名：DEG 在 child 自身作用域遮蔽同名全局定义。 */
const EXPERT_SHADOW_SEND_MESSAGE_NAME = "send_message";

/**
 * shadow 生效性判定结果。取值集合同时是 child_models 里 [SHADOW_MARKER] 的合法值
 * （durable schema 用同一个显式枚举约束），不要再新增其它取值。
 * - verified    ：child 视图解析到的正是本次注册的遮蔽定义 → 宿主 guidance 判定不命中
 * - absent      ：child 视图解析不到任何 send_message → 宿主判定同样不命中
 * - foreign     ：child 视图解析到的是**别人的**定义 → 宿主可能追加引导段 → fail loud
 * - unavailable ：宿主没有 tools.register 能力 → 兼容层保持 no-op（不抛错）
 * - unverified  ：无法判定（没有 tools.get、没有 scope，或 get 抛错）→ 只记录（不抛错）
 */
export const SHADOW_STATUS = Object.freeze({
  VERIFIED: "verified",
  ABSENT: "absent",
  FOREIGN: "foreign",
  UNAVAILABLE: "unavailable",
  UNVERIFIED: "unverified",
});

/** shadow 判定结果的 durable marker 名（与 __degExpertDeny/__degExpertPersona 同层风格）。 */
export const SHADOW_MARKER = "__degSendMessageShadow";

/**
 * Agent -> { status, reason }：shadow 判定的详细信息。
 *
 * WeakMap 以 Agent 对象为键，Agent 回收即随之消失，不跨 child 保留。
 * 键必须是显式传入的 child Agent（spec.scope），绝不从 childCtx 读未注入的懒 agent getter。
 */
const expertShadowStatusByAgent = new WeakMap();

/**
 * childId -> status：供 child_models 快照（writeChildModel / writeChildModelPatch）读取。
 *
 * 只在 child 存活期间保留：composition disposer 释放时删除，避免跨 child 泄漏；
 * admission 被拒（foreign）的 child 不会写快照，因此那条映射在抛错前删除。
 */
const expertShadowStatusByChildId = new Map();

/** 供持久化路径读取的 marker 片段；没有判定结果（非 DEG child / 未安装 shadow）时返回空对象。 */
export function shadowMarkerFields(childId) {
  const status = typeof childId === "string" ? expertShadowStatusByChildId.get(childId) : void 0;
  return status === void 0 ? {} : { [SHADOW_MARKER]: status };
}

/** 删除某 child 的进程内状态映射（disposer 释放、或 admission 被拒时调用）。 */
export function forgetExpertShadowStatus(childId) {
  if (typeof childId === "string" && childId.length > 0) expertShadowStatusByChildId.delete(childId);
}

/**
 * 用**对象身份**判定 child 实际会解析到哪个 send_message 定义。
 *
 * 为什么不读宿主的 adjacent symbol：DEG 既不 import 宿主 internal，也不构造该 symbol；
 * 而 dsh-tools 的 get(name, scope) 返回注册时存进去的**同一个对象**（不做克隆），因此
 * 「解析结果 === 本次注册的定义」这一身份比对与「宿主 guidance 判定不会命中」严格等价，
 * 不需要任何宿主私有标记。own 层条目覆盖同名 inherited（view() 语义），所以 shadow 生效时
 * 必然相等。
 *
 * 三态与「是否可判定」分开：拿不到判据（没有 get、没有 scope、get 抛错）时返回 unverified，
 * 调用方只记录、不抛错；只有确证解析到**别人的**定义时才是 foreign。
 *
 * @param {object|undefined} definition - 本次注册的定义；宿主没有 register 能力时为 undefined。
 * @param {object} toolService - 宿主 tools 服务。
 * @param {object} [scope] - child Agent（显式传入，绝不从 childCtx 读懒 getter）。
 * @returns {{status:string, reason:string}} 判定结果与人类可读原因。
 */
function resolveShadowStatus(definition, toolService, scope) {
  if (definition === void 0) {
    // 用词刻意避开 "unavailable" 之外的同义描述：该词只在 unavailable 分支出现，
    // 保证日志按 "unavailable" grep 时不会同时命中 unverified。
    return { status: SHADOW_STATUS.UNAVAILABLE, reason: "the host child tool scope provides no tools.register" };
  }
  const scopeUsable = scope !== null && scope !== undefined
    && (typeof scope === "object" || typeof scope === "function");
  if (!scopeUsable) {
    return { status: SHADOW_STATUS.UNVERIFIED, reason: "no child scope (Agent) was provided for verification" };
  }
  if (typeof toolService?.get !== "function") {
    return { status: SHADOW_STATUS.UNVERIFIED, reason: "the host child tool scope provides no tools.get" };
  }
  let resolved;
  try {
    resolved = toolService.get(EXPERT_SHADOW_SEND_MESSAGE_NAME, scope);
  } catch (error) {
    return { status: SHADOW_STATUS.UNVERIFIED, reason: "tools.get threw: " + compositionErrorMessage(error) };
  }
  if (resolved === void 0 || resolved === null) {
    return { status: SHADOW_STATUS.ABSENT, reason: "the child scope resolves no send_message at all" };
  }
  if (resolved === definition) {
    return { status: SHADOW_STATUS.VERIFIED, reason: "the child scope resolves the DEG fail-closed shadow" };
  }
  return { status: SHADOW_STATUS.FOREIGN, reason: "the child scope resolves a different send_message definition" };
}

/**
 * 记录 shadow 判定结果：Agent 键（WeakMap）保存详情，childId 键（Map）供 child_models 快照读取。
 *
 * @param {object} [scope] - child Agent。
 * @param {string} status - SHADOW_STATUS 之一。
 * @param {string} reason - 人类可读原因。
 * @returns {string|undefined} 该 child 的 session id（用于后续清理）。
 */
export function recordExpertShadowStatus(scope, status, reason) {
  if (scope !== null && scope !== undefined && (typeof scope === "object" || typeof scope === "function")) {
    expertShadowStatusByAgent.set(scope, { status, reason });
  }
  let childId;
  try {
    childId = typeof scope?.id === "string" && scope.id.length > 0 ? scope.id : void 0;
  } catch {
    // 严格 Context / 懒 getter 抛错时按「没有 childId」处理：状态仍记在 Agent 键上。
    childId = void 0;
  }
  if (childId !== void 0) expertShadowStatusByChildId.set(childId, status);
  return childId;
}

/**
 * child scope -> 已安装 shadow 的记录（定义对象 + disposer + 判定结果）。
 *
 * own 层同层重名会让宿主 register() 抛错，因此同一 child scope 只允许注册一次：
 * 重复 agent/created / 重复安装 composition 在这里直接短路（幂等，不产生第二个 disposer，
 * 也不产生告警噪声），但判定结果仍会被复用。disposer 释放后删除表项，允许后续重新安装。
 */
const expertShadowSendMessageDisposers = new WeakMap();

/**
 * 构造 child 自身作用域里的 send_message 遮蔽定义。
 *
 * 为什么需要：宿主在提交首条任务消息前读取 `tools.get("send_message", child)`，只有解析到的
 * 定义带 adjacent 标记（Symbol.for("dsh.subagent.adjacentAgentSendMessageTool")）时，才把
 * 「Your parent agent id … send_message …」引导段追加进首条任务消息。dsh-tools 的语义是
 * own 层注册遮蔽 inherited（全局/祖先）定义、且 restriction 不影响 own 层注册，因此在 child
 * 作用域注册同名定义即可让该判定解析到本定义，引导段不再污染 buildExpertTaskPrompt 的两段结构。
 *
 * 形状与宿主 tool-subagent-control 的全局 send_message 完全一致（参数、输出 schema、render），
 * 让模型可见的工具契约不漂移；但本定义刻意**不带** adjacent 标记 —— 既不 import 宿主的
 * internal 模块，也不自己构造该 symbol。
 *
 * execute 是纯 fail-closed：本定义不持有任何服务引用（连 ctx 都没有），绝不转发
 * ctx.subagents.sendMessage 或任何其它投递通道，也不产生消息投递副作用，直接抛错。
 * 已知代价：child 的 schema 里仍会出现一个不可用的 send_message，由 child guard 与本定义
 * 的拒绝共同兜底。
 *
 * @returns {object} 可直接交给宿主 tools.register() 的工具定义。
 */
function createShadowedExpertSendMessageDefinition() {
  return defineTool({
    name: EXPERT_SHADOW_SEND_MESSAGE_NAME,
    description: "Unavailable in this expert child: dsh-expert-group replaces send_message with a fail-closed definition, so every call is rejected. Never call it; deliver your result only in your final assistant output, using the five fixed headings required by your discipline.",
    parameters: {
      agent_id: {
        type: "string",
        required: true,
        description: "Ignored: this definition always rejects. The agent id of your direct continuable child, or your direct parent when you are a resident continuable child.",
      },
      message: {
        type: "string",
        required: true,
        description: "Ignored: this definition always rejects. The message that would have been delivered.",
      },
    },
    output: {
      // 输出 schema 与宿主标准 send_message 保持同一形状，避免工具契约在 child 内漂移；
      // 这里永远只会抛错，因此 render 只是形状占位。
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { messageId: { type: "string", required: true } },
      },
      render(_args, _value) {
        return [{ type: "text", text: "send_message is unavailable in this expert child (dsh-expert-group)" }];
      },
    },
    isConcurrencySafe: () => false,
    execute() {
      throw new Error("dsh-expert-group: send_message 对专家 child 不可用；结果只在最终 assistant 输出中按固定标题交付，不走任何投递通道");
    },
  });
}

/**
 * 在 child 自身作用域注册 send_message 遮蔽定义，并校验它是否真的生效。
 *
 * 幂等：同一 child scope 已处理过就直接复用记录（不重复注册、不抛错、不产生第二个 disposer）。
 * 降级：宿主没有 tools.register（精简替身）→ unavailable，不抛错；register() 抛错
 * （同层重名、形状校验失败）→ 保留既有 warning 文案后继续判定。
 *
 * 判定永远发生在注册尝试**之后**（注册抛错时也要判定：那时 child 很可能解析到别人的定义）：
 * 用 tools.get("send_message", scope) 取回 child 实际会解析到的定义，与本次注册的定义做
 * 身份比对，得到 verified / absent / foreign / unavailable / unverified。
 * 只有 foreign 由调用方 fail loud；其余状态只记录。
 *
 * 释放：返回的 disposer 与其它 composition disposer 一样由调用方统一释放，释放后清理幂等表项。
 *
 * @param {object} childCtx - child Agent 的 scoped context。
 * @param {Function} warn - 非致命告警回调。
 * @param {object} [scope] - child Agent（视图作用域）；显式传入，绝不从 childCtx 读懒 getter。
 * @returns {{dispose:(() => void)|undefined, status:string, reason:string}} 安装结果与判定。
 */
export function installShadowedExpertSendMessage(childCtx, warn, scope) {
  const toolService = childCtx?.tools;
  const cacheable = childCtx !== null && childCtx !== undefined
    && (typeof childCtx === "object" || typeof childCtx === "function");
  const cached = cacheable ? expertShadowSendMessageDisposers.get(childCtx) : void 0;
  if (cached !== void 0) {
    // 幂等：本 scope 只注册一次；判定结果沿用首次记录（宿主视图变化由宿主自己负责）。
    return { dispose: void 0, status: cached.status, reason: cached.reason };
  }

  let definition;
  let dispose;
  if (typeof toolService?.register === "function") {
    definition = createShadowedExpertSendMessageDefinition();
    try {
      const registered = toolService.register(definition);
      if (typeof registered === "function") dispose = registered;
    } catch (error) {
      // 既有告警前缀保持不变（可 grep）；注册失败本身不抛错，是否 fail loud 由下面的判定决定。
      warn("dsh-expert-group: expert child composition fallback could not shadow send_message: " + compositionErrorMessage(error));
    }
  }

  const verdict = resolveShadowStatus(definition, toolService, scope);
  if (verdict.status === SHADOW_STATUS.UNVERIFIED) {
    // 可 grep 的专用告警：无法证明 shadow 生效，只能记录（既不拒绝 child，也不静默）。
    warn("dsh-expert-group: expert child send_message shadow could not be verified (unverified): " + verdict.reason);
  }
  if (verdict.status === SHADOW_STATUS.UNAVAILABLE) {
    // 可 grep 的专用告警：宿主的 child 作用域没有 tools.register 能力，DEG 无法注册遮蔽定义；
    // 若宿主仍能看到全局相邻 Agent 的 send_message，它就会照常追加 parent/send_message 引导段。
    // 这仍然**非致命**：精简替身/能力缺失保持兼容层 no-op 语义，绝不因此拒绝 child。
    // 告警词与 unverified 明确区分，便于区分「能力缺失的兼容性退化」与「无法判定」。
    // 文案自带全部事实（不追加 reason：unavailable 的 reason 是固定串，追加只会重复同一句）。
    warn("dsh-expert-group: expert child send_message shadow is unavailable (unavailable): "
      + "the host child tool scope has no tools.register capability, so DEG cannot register its fail-closed send_message shadow; "
      + "the host may therefore append the parent/send_message return guidance paragraph to this child's first task message.");
  }

  const record = { definition, status: verdict.status, reason: verdict.reason };
  const owned = dispose === void 0 ? void 0 : () => {
    try {
      dispose();
    } finally {
      if (cacheable && expertShadowSendMessageDisposers.get(childCtx) === record) expertShadowSendMessageDisposers.delete(childCtx);
    }
  };
  if (cacheable) expertShadowSendMessageDisposers.set(childCtx, record);
  return { dispose: owned, status: verdict.status, reason: verdict.reason };
}

