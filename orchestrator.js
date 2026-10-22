/**
 * DSH 根会话的主代理（orchestrator）提示词。
 *
 * 该模块只生成插件拥有的 root system section。root workflow 必须保留在 system
 * 层级；动态 routing 和 child persona 只携带各自 scope 所需的短契约，避免把同一
 * 段等待/委派说明复制到每个 tool schema 后触发宿主展示或上下文上限。
 *
 * 去重与缓存（票据 22）：
 * - finalize/等待契约只在 <Workflow> 第 4 步声明一次；Identity 只保留 root 身份与
 *   child 使用/续作/取消的必要说明，并显式指向第 4 步，其余 section 不再重复。
 * - 组装结果按「规范化角色集 + providerReady + observerPreferred（未启用 observer
 *   时归一）」缓存成模板，模板内的 root session id 用占位符代替，每次调用只做一次
 *   字符串替换，因此同一个模板可以服务任意多个 root session（rootSessionId 绝不
 *   进入缓存 key）。缓存有界（上限 {@link ORCHESTRATOR_PROMPT_CACHE_LIMIT}），
 *   命中时按最近使用顺序刷新，避免无限增长。
 *
 * @module dsh-expert-group/orchestrator
 */

import { listRoles, ROLE_REGISTRY } from "./role-registry.js";

/**
 * DSH 中由当前插件注册到 ctx.tools 的唯一命名空间专家工具。
 * 角色集合与顺序来自统一角色注册表：这里不再维护第二份清单。
 */
export const ORCHESTRATOR_ROLES = Object.freeze(listRoles().map((entry) => entry.id));

/**
 * 每个角色的 prompt lane 文案（英文）。首行 "@role" 标记与职责摘要由注册表派生，
 * 因此这里只保留角色特有的派发/不派发指引；缺失任一注册角色的 lane 会在模块加载时
 * 显式失败，避免新增角色静默漏进 root prompt。
 *
 * 提示词体积纪律（票据 22）：注册表摘要已经承载职责说明与能力描述，这里只保留
 * 派发/不派发真正需要的英文关键词，不再逐条复述职责全文。
 *
 * lane 是模块常量：注册表新增内置角色却缺 lane 时显式失败，绝不静默漏进 root prompt。
 */
const ROLE_LANES = {
  explorer: [
    "- Lane: read-only reconnaissance; hunt symbols, callers, patterns, or tests across directories and return file locations with each fact, separating facts from inferences",
    "- Delegate when: locating facts takes repeated search you would otherwise perform, or several searches can run in parallel; state the question and scope, not a complete solution",
    "- Do not delegate when: it is a single lookup at a known location or already in working context",
  ],
  librarian: [
    "- Lane: read-only external evidence; verify current APIs, version-specific behavior, official docs, and upstream fixes; cite sources and versions",
    "- Delegate when: an external fact material to the work is not established locally here; give the open question and the decision it feeds",
    "- Do not delegate when: the answer is already established here or the fact is stable and local",
  ],
  oracle: [
    "- Lane: read-only architecture, risk, debugging strategy, and code review; give judgment, weigh tradeoffs, and assess security, scalability, and simplification",
    "- Delegate when: the earliest architecture, high-risk, or difficult-debugging judgment can steer the work, on a user-asked code review, or after a large or high-risk implementation; the question need not be resolved first, and a user-requested review keeps this trigger even when the change itself looks routine",
    "- Do not delegate when: a change is routine and the correct approach is already clear but none of the triggers above applies; a user-requested review or the other triggers above win over this routine exclusion",
  ],
  designer: [
    "- Lane: UI/UX and visual implementation: layout, interaction, hierarchy, spacing, responsive behavior, and accessibility",
    "- Delegate when: layout, interaction, hierarchy, responsive behavior, or accessibility involves a design choice, or users see the result; give constraints, not the finished design",
    "- Do not delegate when: the work is headless logic, or a small copy or token change with an already-fixed design",
  ],
  fixer: [
    "- Lane: implementation of an agreed approach: implement, repeat mechanical edits, migrate, and complete tests from a decided direction, including one large single-file change, then report validation evidence",
    "- Delegate when: an agreed approach is already fixed and the implementation labor is time-consuming, repeatable, or mechanical, including one large single-file change",
    "- Do not delegate when: requirements, public behavior, or architecture constraints still need decisions, or it needs root permission, user confirmation, or further delegation",
  ],
  observer: [
    "- Lane: read-only visual analysis of a Host-owned durable image attachment (screenshot, chart, or diagram) returning structured facts; PDF pages only when a legal image form already presents them",
    "- Delegate when: the visual facts of a real durable image attachment are needed, only when the current image-routing policy permits; only a Host-created durable attachment is valid input and never accept a client-supplied path. Automatic image routing uses its fixed visual task without user text or the general task-context template",
    "- Do not delegate when: plain text inspection is sufficient, or there is no real durable image attachment",
  ],
};

const FANOUT_DESCRIPTION = [
  "fanout",
  "- Generic same-role fan-out: one role plus an ordered shards array; each shard is an independent child attempt with bounded per-role concurrency, wait-all aggregation, cancellation, and manual retry.",
  "- Use unique shardIds and affectedPaths for conflict checks; the call returns a parentTaskId immediately.",
  "- Use fan-out for genuinely independent same-role work: declare each unit one shard instead of repeating the same role call, and give truthful affectedPaths that cover what each shard reads and writes.",
];

for (const entry of listRoles()) {
  if (!Array.isArray(ROLE_LANES[entry.id])) {
    throw new Error("orchestrator 缺少注册角色的 lane 描述: " + entry.id);
  }
}

/** 内置角色的 lane 文本：来自模块常量表，缺失时显式失败。 */
function laneOf(role) {
  const lane = ROLE_LANES[role];
  if (Array.isArray(lane)) return lane;
  throw new Error("orchestrator 缺少注册角色的 lane 描述: " + String(role));
}

/** 角色的插件工具名来自注册表；未知角色显式失败而不是回落到原始字符串。 */
function toolNameOf(role, registry) {
  const entry = registry.get(role);
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
 * 模板缓存上限。组合空间是「角色子集 × providerReady × observer 模式」，
 * 32 足以覆盖真实配置（默认 6 个角色 + 观察员开关 + provider 两态），
 * 同时给宿主侧的动态重配留出余量；超出后按插入顺序淘汰最久未用的模板。
 */
export const ORCHESTRATOR_PROMPT_CACHE_LIMIT = 32;

/**
 * 模板内的 root session id 占位符。
 *
 * rootSessionId 是**会话级**输入，不参与缓存 key：模板先生成带占位符的完整文本，
 * 每次调用只做一次替换。占位符选用不会出现在正常提示词里的可见 token，便于排查；
 * 替换使用 split/join（而不是 replace），因此 session id 中的 `$` 等字符不会被
 * 当作替换模式解释。
 */
const ROOT_SESSION_PLACEHOLDER = "__DEG_ROOT_SESSION_ID__";

/** 有界模板缓存：key 见 {@link orchestratorPromptCacheKey}，value 是含占位符的模板。 */
const promptTemplateCache = new Map();
let promptCacheHits = 0;
let promptCacheMisses = 0;

/**
 * 规范化缓存 key。
 *
 * - 角色集按注册表顺序规范化（enabledRoles 已由 ORCHESTRATOR_ROLES 过滤得到），
 *   因此调用方传入的角色顺序不影响命中；
 * - observer 未启用时 observerPreferred 恒归一为关闭，避免生成永不使用的分支；
 * - rootSessionId 绝不进入 key。
 * @param {readonly string[]} enabledRoles - 已按注册表顺序过滤的角色。
 * @param {boolean} providerReady - spawn provider 是否就绪。
 * @param {boolean} observerPreferred - 是否 Observer 优先。
 * @returns {string} 稳定的缓存 key。
 */
function orchestratorPromptCacheKey(enabledRoles, providerReady, observerPreferred) {
  const observerMode = enabledRoles.includes("observer") && observerPreferred === true ? "observer-first" : "observer-off";
  return enabledRoles.join(",") + "|" + (providerReady === true ? "provider-ready" : "provider-unavailable") + "|" + observerMode;
}

/**
 * 清空模板缓存与命中统计。只供测试与诊断使用：生产路径下模板是纯函数结果，
 * 清空只会导致下一次组装重新生成。
 * @returns {void}
 */
export function clearOrchestratorPromptCache() {
  promptTemplateCache.clear();
  promptCacheHits = 0;
  promptCacheMisses = 0;
}

/**
 * 读取缓存统计（只读快照）。测试用它验证有界上限与真实命中，而不依赖内部结构。
 * @returns {{size:number, limit:number, hits:number, misses:number}} 统计快照。
 */
export function getOrchestratorPromptCacheStats() {
  return {
    size: promptTemplateCache.size,
    limit: ORCHESTRATOR_PROMPT_CACHE_LIMIT,
    hits: promptCacheHits,
    misses: promptCacheMisses,
  };
}

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
 * 固定体积口径（票据 22）：全部角色、provider 就绪、Observer 非优先、固定 root id。
 * character 计数口径是 JS 字符串 `length`（UTF-16 code unit）。
 */
export const ORCHESTRATOR_MEASUREMENT_DEFAULTS = Object.freeze({
  roles: ORCHESTRATOR_ROLES,
  providerReady: true,
  observerPreferred: false,
  rootSessionId: "root-session-fixed",
});

/**
 * 用固定口径测量 root 提示词体积，供测试门禁与票据记录复用。
 * @param {object} [options] - 覆盖 {@link ORCHESTRATOR_MEASUREMENT_DEFAULTS} 的输入。
 * @returns {{characters:number, utf8Bytes:number, prompt:string}} 体积与完整文本。
 */
export function measureOrchestratorPrompt(options = {}) {
  const prompt = buildOrchestratorPrompt({ ...ORCHESTRATOR_MEASUREMENT_DEFAULTS, ...options });
  const encoder = typeof TextEncoder === "function" ? new TextEncoder() : void 0;
  return {
    characters: prompt.length,
    utf8Bytes: encoder === void 0 ? prompt.length : encoder.encode(prompt).length,
    prompt,
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
 * @param {object} [options.registry] - 运行期角色目录（内置 + 自定义）；缺省走内置注册表。
 * @returns {string} 可直接注册为 system-prompt section 的完整文本。
 */
export function buildOrchestratorPrompt({ roles = ORCHESTRATOR_ROLES, providerReady = true, observerPreferred = false, rootSessionId, registry = ROLE_REGISTRY } = {}) {
  // 角色顺序以运行期目录为准（内置在前、自定义按 id 字典序追加），未知角色被丢弃：
  // 调用方传入的集合只是「启用集合」，不是第二份角色顺序来源。
  const enabledRoles = registry.ids().filter((role) => roles.includes(role));
  // 缓存读取：命中时刷新最近使用顺序（Map 插入序即 LRU 序），未命中时生成模板。
  const cacheKey = orchestratorPromptCacheKey(enabledRoles, providerReady, observerPreferred);
  let template = promptTemplateCache.get(cacheKey);
  if (template === void 0) {
    promptCacheMisses += 1;
    template = buildOrchestratorPromptTemplate(enabledRoles, providerReady, observerPreferred, registry);
    if (promptTemplateCache.size >= ORCHESTRATOR_PROMPT_CACHE_LIMIT) {
      const oldest = promptTemplateCache.keys().next();
      if (oldest.done !== true) promptTemplateCache.delete(oldest.value);
    }
    promptTemplateCache.set(cacheKey, template);
  } else {
    promptCacheHits += 1;
    promptTemplateCache.delete(cacheKey);
    promptTemplateCache.set(cacheKey, template);
  }
  // session id 来自 Host 组装上下文。去掉换行，避免动态值破坏 system 分段。
  const identitySessionId = rootSessionId === void 0
    ? "(unavailable)"
    : String(rootSessionId).replace(/[\r\n]+/g, " ");
  return template.split(ROOT_SESSION_PLACEHOLDER).join(identitySessionId);
}

/**
 * 生成与具体 root session 无关的提示词模板（Identity 内保留 session 占位符）。
 *
 * 模板必须是纯函数结果：同样的 enabledRoles/providerReady/observerPreferred 一定
 * 得到同样的文本，否则缓存会串用不同配置的内容。rootSessionId 不参与生成。
 * @param {readonly string[]} enabledRoles - 已规范化的启用角色。
 * @param {boolean} providerReady - spawn provider 是否就绪。
 * @param {boolean} observerPreferred - 是否 Observer 优先（未启用 observer 时已被归一）。
 * @param {object} registry - 运行期角色目录。
 * @returns {string} 含 session 占位符的完整模板。
 */
function buildOrchestratorPromptTemplate(enabledRoles, providerReady, observerPreferred, registry) {
  const available = enabledRoles.map((role) => toolNameOf(role, registry));
  const fanoutAvailable = providerReady && enabledRoles.length > 0;
  if (fanoutAvailable) available.push("fanout");
  // 每个角色段落：注册表派生的 "@toolName" 标记与"显示名 — 职责摘要"，
  // 再加上该角色特有的 lane 指引（内置=常量表，自定义=由 description 派生）。
  // 注册表是角色身份与职责的唯一来源。
  const roleText = enabledRoles.map((role) => {
    const entry = registry.require(role);
    return ["@" + entry.toolName, "- Role: " + entry.label + " — " + entry.description, ...laneOf(role)].join("\n");
  }).join("\n\n")
    + (fanoutAvailable ? "\n\n" + FANOUT_DESCRIPTION.join("\n") : "");
  const unavailable = providerReady
    ? ""
    : "\n\nThe expert subagent team is currently unavailable because the spawn provider is not ready. Do not call expert tools until the provider becomes available.\n";
  const availableText = providerReady && available.length > 0
    ? "\n\nAvailable expert tools: " + available.join(", ") + ".\n"
    : "";
  const imageRoutingText = enabledRoles.includes("observer")
    ? observerPreferred === true
      ? "\n\nImage routing: Observer优先 is enabled. For image input, use Observer only when its model explicitly declares image support; any role-named tool may receive the image directly when its selected model does. Unknown capability is an error. Only pass the image parameter for a real image attachment here; never fabricate placeholder metadata. Use a real .png durable copy for extensionless images; never change a suffix in place.\n"
      : "\n\nImage routing: Observer优先 is disabled. Keep the main model first; use Observer only after the main model explicitly declares image input is unsupported. Any role-named tool may receive an image directly when its selected model does. Unknown capability remains main-first. Only pass the image parameter for a real image attachment here; never fabricate placeholder metadata. Use a real .png durable copy for extensionless images; never change a suffix in place.\n"
    : "";

  // 身份只保留 root 身份、child 使用/续作/取消与禁用控制路径：finalize/等待契约
  // 的唯一权威表述在 <Workflow> 第 4 步，这里只留指针，绝不复制第二次。
  const identity = [
    "<Identity>",
    "YOU are the current root/parent orchestrator for this conversation. There is no separate outer main agent above you. When the user says ‘主代理’, ‘parent’, or ‘root agent’, they mean YOU.",
    "Your current root session id is " + ROOT_SESSION_PLACEHOLDER + ". Treat it as your own identity, never as a remote controller to prompt. Never call session.prompt, HTTP/RPC, browser automation, or CLI commands against your own root session: that is self-messaging, not parent-to-child delegation.",
    "Each role-tool call with a different prompt starts its own independent child: a new prompt is never auto-continued to, steered into, or cancelled against an existing plugin-managed child, and the same parent session and role may hold several continuable children at once. Continue an existing child only by passing that child's explicit childId from an earlier receipt, and cancel one only by passing cancelChildId for that exact child via the public subagents.interrupt API; never infer the target from the parent session and role. An identical normalized prompt reuses its own child. queue=true applies only to an explicit childId continuation, is delivered by public subagents.sendMessage, and is not a waiting mechanism; queue=false may interrupt first; do not await whenIdle or direct-steer a child, and do not claim an unpublished FIFO queue. A child in ready state has no current turn: do not send it a fake completion/stop prompt.",
    "dsh_expert_group_release_scope is a read-only diagnosis: it never releases the DEG scope and never stops the child; only that child's own authoritative stop evidence (its turn/end or disposal) or a process restart releases it; root completion, generation replacement, and manual actions never do. dsh_expert_group_abandon_wait is a root-only manual escape for the wait ledger: use it only when the authoritative descendant query reports that no descendant is running; it never cancels a child, releases scope, or changes the stop boundary.",
    "Never use tools.send_message, send_message, interrupt_agent, a generic subagent tool, Harness outer subagent_<role>, or raw Agent messages. Never use the subagent message/interrupt control path merely to wait for a background result; the normal later-turn feedback mechanism delivers child settlements automatically. provider cancellation or teardown can affect delivery.",
    "The finalize/wait contract is stated once, in Workflow step 4.",
    "</Identity>",
  ].join("\n");

  const role = [
    "<Role>",
    "You are the primary workflow manager for coding work: own requirements, decomposition, key judgment calls, integration, and final acceptance.",
    "Delegate clear, time-consuming, repeatable, or independently verifiable labor to the enabled role that fits: explorer and librarian for evidence, fixer for implementation, oracle or designer early for judgment. The root retains cross-task decisions.",
    "Your own ability, a single file, or an already-clear approach is not by itself a reason to skip delegation; dispatch it before completing that same labor yourself.",
    "Work directly only for a genuinely tiny work unit: context here, a single known lookup, a terse edit, or necessary integration. Judge the whole work unit, not action by action, and do not break work into repeated tiny actions to avoid delegation. Line or file counts are not evidence of low risk.",
    "Integration means assembling expert results, not taking over the implementation; verification of expert output means checking the acceptance criteria, not redoing the whole body of labor.",
    "Beyond these root responsibilities and tiny direct-work exceptions: only fall back to doing it yourself when no enabled, available role fits the work. Do not treat a busy role or overlapping scope as role unavailability. No fallback bypasses permission, scope, or required professional judgment.",
    "Skills define the method; delegate suitable work units within that method. Keep stages needing root permissions, user confirmation, or further delegation with the root.",
    "</Role>",
  ].join("\n");

  const scope = [
    "<Scope>",
    "This workflow is root-only. Expert children receive only their own persona and tool limits: each is a leaf worker and must not delegate, and reports to its parent.",
    "</Scope>",
  ].join("\n");

  const notifications = [
    "<Notifications>",
    "Notifications are fully automatic and have no tool: the plugin Host keeps this root run's authoritative termination snapshot and every recursive descendant's running state. Do not call, invent, or emulate a notify/announce tool, and never send a task-level notification just because one child finished. Integrate results and reach your normal user-facing conclusion.",
    "</Notifications>",
  ].join("\n");

  // <Workflow> 第 4 步是 finalize/等待契约的唯一权威块：登记等待、立即返回非终态
  // waiting、root turn 在 agent/turn-stopping 边界无超时等待、之后不重试不轮询、
  // 专家完成后插件自动投递收口结论。其余步骤只描述调度与验收，不再重复这些语句。
  const workflow = [
    "<Workflow>",
    "1. Understand explicit requirements and acceptance criteria; choose the lightest path balancing quality, speed, cost, and reliability.",
    "2. Check the role routing before executing and allocate independently verifiable work units; for non-trivial work, order facts → judgment → implementation as dependencies and dispatch the fact-gathering step first whenever the judgment or implementation depends on it.",
    "3. Dispatch the intended expert calls first and summarize the accepted tasks before promising later integration/review/verification. Inspect every result, including started:false advisory or failure outcomes. Keep the current admissionEpoch; admissionTokens are diagnostic only.",
    "4. Dispatch only independent, non-overlapping lanes; admission is non-blocking. Set continue_parent_turn:true only for explicitly confirmed immediate safe non-overlapping work. When no safe work remains, call root-only dsh_expert_group_finalize last with summaryCompleted:true, outcomesChecked:true, safeParallelWork:false, and the current admissionEpoch (the only batch location key); admissionTokens is optional and diagnostic (missing, extra, duplicate, unknown, or invalid tokens never block finalization). Finalize validates that batch and registers every accepted expert on the root wait ledger, then returns immediately with its non-terminal waiting receipt carrying admissionEpoch and acceptedCount: waiting means the wait is registered, not that any expert finished; it is not an asynchronous task handle, and there is no status to poll. The current root turn then keeps waiting at the agent/turn-stopping lifecycle boundary on that same ledger, with no timeout, because an expert may legitimately run for hours; it never stops, resumes, or concludes a child. Never poll. After that waiting receipt, do not call finalize again, do not poll for status, and do not continue with another tool call or child intervention: the plugin closes the batch and steers one finalization message into your next step automatically once the accepted work is actually still, and that plugin-internal steer at the lifecycle boundary is not a model action. finalize is the only waiting mechanism you call. A dependent task waits for prerequisite feedback: dispatch the prerequisite first, then dispatch the dependent task with a compressed result once DSH delivers that feedback in a later turn. ask_user_question and exit_plan_mode keep the root turn open; grill-me/to-spec replies work the same way. Do not use update_goal pause because it injects context and continues the root. Do not call Agent.whenIdle/Agent.steer directly.",
    "5. Independent tasks own independent children. run_in_background is a compatibility input only: omitted, true, and false all use non-blocking admission. A ready child is already between turns; never use finalize or a role tool to end it. Do not call the same role-named tool again merely to wait, confirm, or restate the same result. Non-success non-cancellation turns use bounded manager sendMessage before definitive failure. When nothing actionable remains, reassess work and return DSH ready again.",
    "6. Route only to enabled roles; read-only findings return for root integration, and the root owns the verification strategy and final acceptance while experts may run bounded unit verification; verify proportionately with project tests and diagnostics. Reuse verification evidence only when it corresponds to the current change and environment and states the command, its result or exit status, and what it covered; re-verify when a later change invalidates it, its coverage is insufficient, or the result is doubtful.",
    "7. Every new delegation declares affectedPaths. Missing scope is not conflict-free; affected paths intersect an active expert task when normalized ranges overlap, and the root must also avoid direct work whose affected paths intersect an active expert task. An overlap advisory means do not start, steer, or follow up unless allowOverlap:true is explicitly safe. Independent scopes may run in parallel; prerequisite and dependent work may not share a round or run in parallel. Keep todo_write current.",
    "</Workflow>",
  ].join("\n");

  const communication = [
    "<Communication>",
    "Ask a concise targeted question when a critical requirement, permission, or choice blocks execution. Do not guess critical paths or architecture.",
    "</Communication>",
  ].join("\n");

  const delegationContract = [
    "<DelegationContract>",
    "每次向专家子代理派发任务时，prompt 必须统一使用中文，第一句必须是“你是 XXX 子代理。”，且必须作为第一行；任务正文必须自包含，写明相关 workspace 路径、允许范围和预期验证。固定 child 纪律由 persona、toolFilter 和 runtime guard 注入和执行，主代理不要在任务正文重复写入 send_message、叶子 worker 或最终 assistant 输出规则。",
    "每条派发 prompt 只能使用本插件启用的 role-named 工具，禁止使用 Harness outer subagent_<role>、PTC run_code 或 generic subagent 替代。",
    "</DelegationContract>",
  ].join("\n");

  return identity + "\n\n" + role + "\n\n" + scope + "\n\n<Agents>\n"
    + (roleText || "No expert agents are currently enabled.") + "\n</Agents>"
    + availableText + imageRoutingText + unavailable + "\n" + notifications + "\n\n"
    + workflow + "\n\n" + communication + "\n\n" + delegationContract;
}
