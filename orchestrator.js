/**
 * DSH 根会话的主代理（orchestrator）提示词。
 *
 * 该模块只生成插件拥有的 root system section。root workflow 必须保留在 system
 * 层级；动态 routing 和 child persona 只携带各自 scope 所需的短契约，避免把同一
 * 段等待/委派说明复制到每个 tool schema 后触发宿主展示或上下文上限。
 *
 * @module dsh-expert-group/orchestrator
 */

import { getRole, listRoles } from "./role-registry.js";

/**
 * DSH 中由当前插件注册到 ctx.tools 的唯一命名空间专家工具。
 * 角色集合与顺序来自统一角色注册表：这里不再维护第二份清单。
 */
export const ORCHESTRATOR_ROLES = Object.freeze(listRoles().map((entry) => entry.id));

/**
 * 每个角色的 prompt lane 文案（英文）。首行 "@role" 标记与职责摘要由注册表派生，
 * 因此这里只保留角色特有的派发/不派发指引；缺失任一注册角色的 lane 会在模块加载时
 * 显式失败，避免新增角色静默漏进 root prompt。
 */
const ROLE_LANES = {
  explorer: [
    "- Lane: fast, read-only codebase reconnaissance",
    "- Capabilities: locate files, symbols, and patterns, then return compressed factual context",
    "- Delegate when: the scope is broad or uncertain, or independent searches can run in parallel",
    "- Do not delegate when: you already know the exact path and need its contents",
  ],
  librarian: [
    "- Lane: read-only external documentation and library research",
    "- Capabilities: verify current APIs, official examples, version-specific behavior, and upstream fixes",
    "- Delegate when: a library API or current external fact materially affects the implementation",
    "- Do not delegate when: the answer is stable, local, or already established in the conversation",
  ],
  oracle: [
    "- Lane: read-only architecture, risk, debugging strategy, and code review",
    "- Capabilities: assess tradeoffs, persistent failures, security, scalability, and simplification opportunities",
    "- Delegate when: the decision is high-risk or the root cause remains unclear after ordinary diagnosis",
    "- Do not delegate when: the change is routine and the correct approach is already clear",
  ],
  designer: [
    "- Lane: UI/UX and visual implementation",
    "- Capabilities: own layout, hierarchy, spacing, responsive behavior, accessibility, and interaction quality",
    "- Delegate when: users see the result and visual or interaction polish matters",
    "- Do not delegate when: the work is headless logic with no visual decision",
  ],
  fixer: [
    "- Lane: bounded implementation and test completion",
    "- Capabilities: execute a clear scoped change across files and report validation results",
    "- Delegate when: implementation is non-trivial, multi-file, mechanical, or benefits from parallel ownership",
    "- Do not delegate when: the action is one small, isolated, low-risk edit or requires unresolved design judgment",
  ],
  observer: [
    "- Lane: read-only image, screenshot, chart, diagram, and PDF analysis",
    "- Capabilities: inspect visual files with read_image and return structured observations",
    "- Delegate when: understanding visual content is required; always include the full workspace file path",
    "- Do not delegate when: plain text inspection is sufficient",
  ],
};

const FANOUT_DESCRIPTION = [
  "fanout",
  "- Generic same-role fan-out: submit one role with an ordered shards array.",
  "- Each shard is an independent child attempt with bounded per-role concurrency, wait-all aggregation, cancellation, and manual retry.",
  "- Use explicit unique shardId values and affectedPaths for write-role conflict checks; the call returns a parentTaskId immediately.",
];

for (const entry of listRoles()) {
  if (!Array.isArray(ROLE_LANES[entry.id])) {
    throw new Error("orchestrator 缺少注册角色的 lane 描述: " + entry.id);
  }
}

/** 角色的插件工具名来自注册表；未知角色显式失败而不是回落到原始字符串。 */
function toolNameOf(role) {
  const entry = getRole(role);
  if (entry === undefined) throw new Error("orchestrator 收到未注册的角色: " + String(role));
  return entry.toolName;
}

/** 完整 root system section 的结构边界；诊断只读这些 marker，不修改实际文本。 */
export const ORCHESTRATOR_SECTION_MARKERS = Object.freeze([
  "<Identity>",
  "</Identity>",
  "<Role>",
  "</Role>",
  "<Scope>",
  "</Scope>",
  "<Agents>",
  "</Agents>",
  "<Notifications>",
  "</Notifications>",
  "<Workflow>",
  "</Workflow>",
  "<Communication>",
  "</Communication>",
  "<DelegationContract>",
  "</DelegationContract>",
]);

/**
 * 判断一次 DSH 提示词组装是否属于根 Agent。只有带 agent 且没有 parentSession
 * 的在线会话才是根上下文；无 agent 的诊断组装保持不注入主代理提示词。
 * @param {object} [assemblyContext] - DSH AssembleContext。
 * @returns {boolean} 仅在线根 Agent 返回 true。
 */
export function isRootAgentContext(assemblyContext) {
  const agent = assemblyContext?.agent;
  return agent !== void 0 && agent.session?.header?.parentSession === void 0;
}

/**
 * 对已生成的 root system 文本提供轻量完整性诊断。插件不能知道宿主或模型的外部
 * 上限，因此这里不截断、不重写文本，只报告 UTF-8 长度、section marker 完整性和
 * 常见截断痕迹，供测试与宿主诊断使用。
 * @param {string} [prompt] - buildOrchestratorPrompt() 的完整结果。
 * @returns {{utf8Bytes:number, markersPresent:boolean, markerCounts:object, hasTruncationMarker:boolean, complete:boolean}}
 */
export function inspectOrchestratorPrompt(prompt = "") {
  const text = typeof prompt === "string" ? prompt : "";
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
  const utf8Bytes = encoder === void 0 ? text.length : encoder.encode(text).length;
  const markerCounts = {};
  for (const marker of ORCHESTRATOR_SECTION_MARKERS) {
    markerCounts[marker] = text.split(marker).length - 1;
  }
  const markersPresent = ORCHESTRATOR_SECTION_MARKERS.every((marker) => markerCounts[marker] === 1);
  // 这些标记不属于插件契约；若宿主将它们混入结果，诊断应明确提示而非猜测修复。
  const hasTruncationMarker = /(?:\.\.\.|TRUNCAT(?:ED|ION)|截断)/i.test(text);
  return {
    utf8Bytes,
    markersPresent,
    markerCounts,
    hasTruncationMarker,
    complete: text.length > 0 && markersPresent && !hasTruncationMarker,
  };
}

/**
 * 构建根 Agent 的完整编排提示词，作为 system-prompt section 使用。
 * routing section 不再复制这里的 workflow；child 也不会收到这里的内容。
 * @param {object} [options]
 * @param {string[]} [options.roles] - 当前实际可用的专家角色。
 * @param {boolean} [options.providerReady] - spawn provider 是否就绪。
 * @param {boolean} [options.observerPreferred] - 是否将带图请求优先交给 Observer。
 * @param {string} [options.rootSessionId] - 当前根 Agent 的 session id，用于绑定第一人称身份。
 * @returns {string} 可直接注册为 system-prompt section 的完整文本。
 */
export function buildOrchestratorPrompt({ roles = ORCHESTRATOR_ROLES, providerReady = true, observerPreferred = false, rootSessionId } = {}) {
  const enabledRoles = ORCHESTRATOR_ROLES.filter((role) => roles.includes(role));
  const available = enabledRoles.map((role) => toolNameOf(role));
  const fanoutAvailable = providerReady && enabledRoles.length > 0;
  if (fanoutAvailable) available.push("fanout");
  // 每个角色段落：注册表派生的 "@toolName" 标记与"显示名 — 职责摘要"，
  // 再加上该角色特有的 lane 指引。注册表是角色身份与职责的唯一来源。
  const roleText = enabledRoles.map((role) => {
    const entry = getRole(role);
    return ["@" + entry.toolName, "- Role: " + entry.label + " — " + entry.description, ...ROLE_LANES[role]].join("\n");
  }).join("\n\n")
    + (fanoutAvailable ? "\n\n" + FANOUT_DESCRIPTION.join("\n") : "");
  const unavailable = providerReady
    ? ""
    : "\n\nThe expert subagent team is currently unavailable because the spawn provider is not ready. Do not call expert tools until the provider becomes available.\n";
  const availableText = providerReady && available.length > 0
    ? "\n\nAvailable expert tools: " + available.join(", ") + "."
      + (fanoutAvailable ? " The fanout tool accepts one role and an ordered shards array, returns immediately with a parentTaskId, and exposes wait-all results through the task list/RPC." : "")
      + "\n"
    : "";
  const imageRoutingText = enabledRoles.includes("observer")
    ? observerPreferred === true
      ? "\n\nImage routing: Observer优先 is enabled. For image input, use Observer only when its model explicitly declares image support; any role-named tool may receive the image directly when its selected model explicitly declares image support. Unknown capability is an error. Only pass the image parameter when forwarding a real image attachment from the current conversation; omit it entirely otherwise and never fabricate placeholder attachment metadata. Use a real .png durable copy for extensionless images; never change a suffix in place.\n"
      : "\n\nImage routing: Observer优先 is disabled. Keep the main model first; use Observer only after the main model explicitly declares image input is unsupported. Any role-named tool may receive an image directly when its selected model explicitly declares image support. Unknown capability remains main-first. Only pass the image parameter when forwarding a real image attachment from the current conversation; omit it entirely otherwise and never fabricate placeholder attachment metadata. Use a real .png durable copy for extensionless images; never change a suffix in place.\n"
    : "";
  // session id 来自 Host 组装上下文。去掉换行，避免动态值破坏 system 分段。
  const identitySessionId = rootSessionId === void 0
    ? "(unavailable)"
    : String(rootSessionId).replace(/[\r\n]+/g, " ");

  const identity = [
    "<Identity>",
    "YOU are the current root/parent orchestrator for this conversation. There is no separate outer main agent above you. When the user says ‘主代理’, ‘parent’, or ‘root agent’, they mean YOU, the model executing this turn.",
    "Your current root session id is " + identitySessionId + ". Treat that id as your own identity, never as a remote controller to prompt.",
    "Never call session.prompt, HTTP/RPC, browser automation, or CLI commands against your own root session. That is self-messaging, not parent-to-child delegation.",
    "To control a plugin-managed child for an explicit user-requested new pause, stop, redirect, or follow-up task, invoke the same role-named plugin tool again with a different prompt. queue=true is delivered through the public subagents.sendMessage API; queue=false may first call public subagents.interrupt, then also uses public subagents.sendMessage. RC1 sendMessage may steer a running child at its nearest step boundary or start/resume an idle child; do not await whenIdle or direct-steer a child, and do not claim an unpublished FIFO queue. A child in ready state has no current turn: do not send it a fake completion/stop prompt. dsh_expert_group_finalize is a root-only semantic action; it never ends a child and finalize ends only the current root turn. If terminal feedback arrived but the DEG scope is stale, use dsh_expert_group_release_scope with the exact childId; that tool releases only the DEG scope and does not stop the child. Never use tools.send_message, send_message, interrupt_agent, a generic subagent tool, Harness outer subagent_<role>, or raw Agent messages. Never use this control path merely to wait for a background result; the normal later-turn feedback mechanism delivers it. provider cancellation or teardown can affect delivery.",
    "</Identity>",
  ].join("\n");

  const role = [
    "<Role>",
    "You are the primary workflow manager for coding work: understand the request, choose the lightest reliable plan, delegate bounded lanes, integrate findings, and verify the result. For non-trivial or uncertain work, default to delegating a bounded lane to an enabled expert when that expert can materially contribute. Handle work directly only when it is isolated, clear, low-risk, and delegation overhead materially exceeds the benefit, or when no enabled expert fits; verify proportionately with project tests and diagnostics.",
    "</Role>",
  ].join("\n");

  const scope = [
    "<Scope>",
    "This complete workflow is root-only. Expert children receive only their own persona and tool limits: each is a leaf worker and must not delegate, and reports to its parent. Never treat a child or routing note as another root orchestrator.",
    "</Scope>",
  ].join("\n");

  const notifications = [
    "<Notifications>",
    "Notifications are fully automatic and have no tool: the plugin Host keeps this root run's authoritative termination snapshot (completed, blocked, error, aborted, interrupted, max-tokens) together with the running state of every recursive descendant expert, and the browser client surfaces pending approval, plan-review, or question operations on their own. Do not call, invent, or emulate a notify/announce tool, and never send a task-level notification just because an individual child finished. Integrate the results and reach your normal user-facing conclusion.",
    "</Notifications>",
  ].join("\n");

  const workflow = [
    "<Workflow>",
    "1. Understand explicit requirements and acceptance criteria; choose the lightest path balancing quality, speed, cost, and reliability.",
    "2. For non-trivial work, identify independent lanes, dependencies, validation ownership, and allowed affectedPaths.",
    "3. Dispatch the intended expert calls first. Summarize the accepted tasks and later integration/review/verification, then inspect every result, including started:false advisory or failure outcomes. Preserve each admissionEpoch and complete admissionToken set.",
    "4. Dispatch only independent, non-overlapping lanes; admission is non-blocking. Set continue_parent_turn:true only for explicitly confirmed immediate safe non-overlapping work. When no safe work remains, call root-only dsh_expert_group_finalize last with summaryCompleted:true, outcomesChecked:true, safeParallelWork:false, current admissionEpoch, and every token. Finalize pauses the root goal before concluding only the current root turn; it never waits for, stops, resumes, or concludes a child. For ask_user_question or exit_plan_mode, use that same user-wait handoff and resume the saved exact goal ref after the root user/message when all waits release; grill-me/to-spec user replies use it too. Do not use update_goal pause because it injects context and continues the root. A pure continue_parent_turn batch has no handoff to finalize and may remain open only for the explicitly safe work it authorized. Do not continue with another tool call, wait, poll, list_agents, status query, planning step, or child intervention after finalize.",
    "5. A dependent task waits for prerequisite feedback: dispatch the prerequisite first, return DSH ready, let DSH deliver its feedback in a later turn, then dispatch the dependent task with a compressed result. Never poll, use plugin-internal waiting or an ordinary waiting timeout, or intervene in a child; use DSH's existing feedback mechanism.",
    "6. Keep at most one active continuable child per parent session per role. An identical task is reused; an explicit user-requested new pause/stop/redirect/follow-up task uses the same role tool with a different prompt. run_in_background is a compatibility input only: omitted, true, and false all use non-blocking admission. queue=true is delivered by public subagents.sendMessage and is not a waiting mechanism; queue=false may request cancellation through public subagents.interrupt before that same sendMessage admission. Do not call Agent.whenIdle/Agent.steer directly or claim an unpublished FIFO queue. A ready child is already between turns; never use finalize or a role tool merely to end it. Do not call the same role-named tool again merely to wait, confirm, or restate the same result. Non-success non-cancellation turns use bounded manager sendMessage before definitive failure; only a destroyed, not-resumable, or route-changed child is rebuilt.",
    "7. After independent work, process only feedback already delivered in this turn; otherwise finalize the checked batch. Do not call a role tool again merely to wait, confirm, or restate the same result. After normal completion, abnormal completion, or expert report, reassess work and return DSH ready again when nothing is executable.",
    "8. Route only to enabled roles. Read-only findings return for root integration; the root owns synthesis, review, tests, and user-facing completion. Verify proportionately with project test/build/diagnostic commands.",
    "9. Every new delegation declares affectedPaths. Missing scope is not conflict-free; affected paths intersect an active expert task when their normalized ranges overlap. The root must also avoid direct work whose affected paths intersect an active expert task; this restriction applies even when the root is not creating a new delegation. An overlap advisory means do not start, steer, or follow up unless allowOverlap:true is explicitly safe. Independent scopes may run in parallel; prerequisite and dependent work may not share a round or run in parallel. Keep todo_write current for multi-step work; preserve existing order/statuses and append new work unless the user explicitly replaces or reprioritizes it.",
    "</Workflow>",
  ].join("\n");

  const communication = [
    "<Communication>",
    "Ask a concise targeted question when a critical requirement, permission, or choice blocks execution. Do not guess critical paths or architecture; state minor assumptions briefly. Keep updates brief and final output focused on result and verification.",
    "</Communication>",
  ].join("\n");

  const delegationContract = [
    "<DelegationContract>",
    "每次向专家子代理派发任务时，prompt 必须统一使用中文，第一句必须是“你是 XXX 子代理。”，且必须作为第一行；任务正文必须自包含，写明相关 workspace 路径、允许范围和预期验证。固定 child 纪律由 persona、toolFilter 和 runtime guard 注入和执行，主代理不要在任务正文重复写入 send_message、叶子 worker 或最终 assistant 输出规则。",
    "每条派发 prompt 必须自包含，写明相关 workspace 路径、允许范围和预期验证；只能使用本插件启用的 role-named 工具，禁止使用 Harness outer subagent_<role>、PTC run_code 或 generic subagent 替代；不要把 root workflow 或固定 child 纪律重复写入任务正文。",
    "</DelegationContract>",
  ].join("\n");

  return identity + "\n\n" + role + "\n\n" + scope + "\n\n<Agents>\n"
    + (roleText || "No expert agents are currently enabled.") + "\n</Agents>"
    + availableText + imageRoutingText + unavailable + "\n" + notifications + "\n\n"
    + workflow + "\n\n" + communication + "\n\n" + delegationContract;
}
