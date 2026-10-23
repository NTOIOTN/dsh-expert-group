/**
 * 子代理反馈消息的身份解析。
 *
 * 从 DSH inbox / session 事件里解析 subagent feedback 的 child session 身份，对缺少 source 的消息 fail-closed。
 * 本文件由原 `shared.js` 的 165–202 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/feedback-identity
 */

/**
 * 从父 inbox 注入的 DSH 消息提取专家反馈 child id。
 *
 * 结构化通知仍只接受 subagent-settled/subagent-report，且 senderSessionId 必须是非空字符串。
 * 真实宿主在部分路径不会附带 source，只会把固定的自动完成前缀写入多个 text block；
 * 此处只接受该完整固定前缀和 canonical UUID，避免从普通正文、代码块或用户消息猜测 child。
 * 解析只是身份归类，调用方仍必须通过 exact activation、turnEnded 和 cohort 结算保护。
 *
 * B（兼容边界）：本 helper 只做**身份归类**，不代表该形态可以释放 handoff。core 当前只铸
 * `subagent-settled`(form=notice) 的 UUID settlement；`subagent-report`(form=relay) 没有
 * correlation id（不同 message.id、无 turn/admission 关联），无法证明属于哪一轮 admission。
 * 调用方必须对 relay fail-closed，不得让它进入 markPendingHandoffFeedback / 通配 release
 * 路径（见 index.js 的 agent/inbox/inserted handler）。
 * @param {object} [message] - DSH inbox 消息。
 * @param {{allowSourceLess?:boolean}} [options] - 仅 session/event/spliced 可打开无 source 解析。
 * @returns {string|undefined} 匹配的 child session id。
 */
export function subagentFeedbackChildId(message, options = {}) {
  const source = message?.source;
  if (source?.kind === "subagent-settled" || source?.kind === "subagent-report") {
    return typeof source.senderSessionId === "string" && source.senderSessionId.length > 0
      ? source.senderSessionId
      : void 0;
  }
  // 无 source 的文本形态默认拒绝；只有 root session/event/spliced 显式打开时才解析。
  // 普通 agent/inbox/inserted 不能仅凭正文猜测 child，避免用户文本伪造 settlement。
  if (options?.allowSourceLess !== true
    || source !== void 0 || message === null || typeof message !== "object") return void 0;
  const content = message.content;
  if (!Array.isArray(content)) return void 0;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const match = /^Background subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) finished and will do no further work unless you send it more\./i.exec(text);
  return match?.[1];
}
