/**
 * 组合根顶层的第 S6 段（R1 票据 06）：自 index.js 第 693–855 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

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

