/**
 * 主代理（orchestrator）提示词与注册面回归。
 *
 * 本文件只通过公开 seam 断言：
 * - orchestrator.js / prompt-contracts.js 的模块导出；
 * - plugin.Config：DSH 在 apply 前用它填充默认组合配置；
 * - 真实 plugin.apply 注册出的 system section 文本、角色工具 definition 与 execute；
 * - root 结构化路径 guard、root-only 恢复工具与角色 admission 的真实行为。
 * 不读取 index.js 源码文本，不做源码正则抽取、源码切片或 new Function 重建。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildOrchestratorPrompt,
  clearOrchestratorPromptCache,
  getOrchestratorPromptCacheStats,
  inspectOrchestratorPrompt,
  isRootAgentContext,
  measureOrchestratorPrompt,
  ORCHESTRATOR_PROMPT_CACHE_LIMIT,
  ORCHESTRATOR_ROLES,
  ORCHESTRATOR_SECTION_MARKERS,
} from "../orchestrator.js";
import { getRole } from "../role-registry.js";
import {
  buildRoleToolDescription,
  DEFAULT_EXPERT_PERSONA,
  FIXED_EXPERT_DISCIPLINE,
  resolveExpertPersona,
  ROLE_TOOL_ADMISSION_CONTRACT,
} from "../prompt-contracts.js";
import { createPluginHost, flushAsyncWork } from "../test-support/plugin-host.mjs";

const ORCHESTRATOR_SECTION = "dsh-expert-group:orchestrator";
const ROUTING_SECTION = "dsh-expert-group:routing";
/** 发布契约：package.json files 白名单必须包含生产依赖的提示词契约模块。 */
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** 每个用例独立 apply 一个真实 Host；不做跨用例共享，避免 fiber 状态串扰。 */
function appliedHost(options = {}) {
  const host = createPluginHost(options);
  host.apply();
  return host;
}

/** 通过公开 section.text(assemblyContext) 读取真实注册文本；assemblyContext 只用 { agent } 形状。 */
function sectionText(host, name, agent) {
  const definition = host.sections.get(name);
  assert.ok(definition, "缺少 system section: " + name);
  assert.equal(typeof definition.text, "function", name + " 的 text 必须是组装上下文函数");
  return definition.text(agent === undefined ? {} : { agent });
}

/** 非 live root 的调用方：child agent 带 parentSession，永远拿不到 root 代际。 */
function childAgent(id = "child-caller", parentId = "root-caller") {
  return { id, options: {}, session: { id, header: { id, parentSession: parentId } } };
}

/** root-only 工具需要的公开 execution 形状。 */
function execution(agent) {
  return { agent, signal: new AbortController().signal, concludeTurn: () => {} };
}

/** 命中真实拦截的那个 guard；插件按 scope 注册多个 guard，用例不依赖注册顺序。 */
function guardWarning(guards, guardedExecution) {
  for (const guard of guards) {
    const outcome = guard(guardedExecution);
    if (typeof outcome === "string" && outcome.length > 0) return outcome;
  }
  return undefined;
}

test("主代理提示词覆盖全部专家职责和 DSH 工具名", () => {
  const prompt = buildOrchestratorPrompt();
  for (const role of ORCHESTRATOR_ROLES) {
    assert.match(prompt, new RegExp("@" + role));
    assert.match(prompt, new RegExp(`\\b${role}\\b`));
  }
  assert.match(prompt, /primary workflow manager/);
  assert.match(prompt, /run_in_background/);
  // 多 child 语义：同一个 parent session + role 下可以并存多个独立 child；
  // 旧文案「每个 parent 每 role 只有一个活动 child」必须退役。
  assert.match(prompt, /Independent tasks own independent children/);
  assert.match(prompt, /the same parent session and role may hold several continuable children at once/);
  assert.match(prompt, /Continue an existing child only by passing that child's explicit childId/);
  // finalize/等待契约收敛到 Workflow 第 4 步后，取消句只保留一处权威表述（「cancel one only by」）。
  assert.match(prompt, /cancel one only by passing cancelChildId for that exact child/);
  assert.doesNotMatch(prompt, /Keep at most one active continuable child per parent session per role/);
  assert.doesNotMatch(prompt, /uses the same role tool with a different prompt/);
  assert.match(prompt, /non-overlapping/);
  assert.match(prompt, /root must also avoid direct work whose affected paths intersect an active expert task/i);
  assert.match(prompt, /compressed result/);
  assert.match(prompt, /read-only/);
  assert.match(prompt, /verify proportionately/);
  assert.match(prompt, /queue=true applies only to an explicit childId continuation, is delivered by public subagents\.sendMessage/);
  assert.match(prompt, /provider cancellation or teardown can affect delivery/);
});

test("主代理提示词按判断需求、劳动量与可验证性默认派发", () => {
  const prompt = buildOrchestratorPrompt();
  // 分工口径：按角色适配面派发，判断留在主代理；旧的"非平凡或不确定才委派 /
  // isolated clear low-risk 可直做"只拿任务属性当开关，必须整体替换。
  assert.match(prompt, /Delegate to the enabled role that fits: explorer or librarian for evidence, oracle for architecture, risk, debugging and review, designer for frontend work, fixer for non-frontend implementation\. The root retains cross-task decisions\./);
  assert.doesNotMatch(prompt, /non-trivial or uncertain work, default to delegating/);
  assert.doesNotMatch(prompt, /default to delegating a bounded lane/);
  assert.doesNotMatch(prompt, /Handle work directly only when it is isolated, clear, low-risk/);

  // 能做、单文件、方案清楚都不是跳过派发的理由；直做按整个工作单元判断，
  // 不能靠拆小重复动作豁免。
  assert.match(prompt, /Your own ability, a single file, or an already-clear approach is not by itself a reason to skip delegation/);
  assert.match(prompt, /Judge the whole work unit, not action by action/);
  assert.match(prompt, /do not break work into repeated tiny actions to avoid delegation/);
  assert.match(prompt, /Line or file counts are not evidence of low risk/);

  // 整合与验收有明确边界：不得借整合接管实现，也不得借验收重做全部劳动。
  assert.match(prompt, /Integration means assembling expert results, not redoing their work/);
  assert.match(prompt, /verify acceptance criteria, not the whole body of labor/);

  // 兜底：只在确无合适启用角色时直做；角色忙碌/范围冲突不算不可用，且不得绕过权限与专业判断。
  assert.match(prompt, /Otherwise fall back to doing it yourself only when no enabled, available role fits/);
  assert.match(prompt, /a busy role or overlapping scope is not unavailability/);
  assert.match(prompt, /no fallback bypasses permission, scope, or required professional judgment/);

  // 先派发纪律：最小必要检查足以划定任务就先派发，不先完成同类劳动。
  assert.match(prompt, /dispatch it before completing that same labor yourself/);
});

test("主代理提示词规定独立可验收工作单元与验证证据的复用边界", () => {
  const prompt = buildOrchestratorPrompt();
  // 执行前检查角色路由，按可独立验收工作单元分配，并保证事实→判断→实施依赖顺序。
  assert.match(prompt, /Check the role routing before executing and allocate independently verifiable work units/);
  assert.match(prompt, /order facts → judgment → implementation as dependencies/);
  assert.match(prompt, /dispatch the fact-gathering step first whenever the judgment or implementation depends on it/);
  // 验证策略与最终验收属于主代理，专家可以执行局部验证。
  assert.match(prompt, /the root owns the verification strategy and final acceptance while experts may run bounded unit verification/);
  // 只有与当前变更和环境对应、给出命令与结果并说明覆盖的证据才可复用。
  assert.match(prompt, /Reuse verification evidence only when it corresponds to the current change and environment and states the command, its result or exit status, and what it covered/);
  assert.match(prompt, /re-verify when a later change invalidates it, its coverage is insufficient, or the result is doubtful/);
  // 技能方法与角色执行衔接，需 root 能力的阶段仍由主代理负责。
  assert.match(prompt, /Skills define the method; delegate suitable work units within that method/);
  assert.match(prompt, /Keep stages needing root permissions, user confirmation, or further delegation with the root/);
});

test("fanout 指引要求真实 affectedPaths，且不把重复 role 调用当并行", () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /declare each genuinely independent unit one shard instead of repeating role calls/);
  assert.match(prompt, /truthful affectedPaths for conflict checks/);
  // 既有 fanout 事实（parentTaskId、并发、wait-all）保持不变。
  assert.match(prompt, /the call returns a parentTaskId immediately/);
  assert.match(prompt, /bounded concurrency, wait-all, cancellation and manual retry/);
});

test("角色 lane 契约：事实搜集、专业判断与实施各自有默认触发面", () => {
  const prompt = buildOrchestratorPrompt({ roles: ["explorer", "librarian", "oracle", "designer", "fixer", "observer"] });
  const laneOf = (role) => {
    const match = prompt.match(new RegExp("@" + role + "\n([\\s\\S]*?)(?=\n\n|$)"));
    assert.ok(match, "缺少角色 lane: " + role);
    return match[1];
  };

  // explorer/librarian 承担可验证的事实劳动，且不要求主代理先给出完整判断。
  for (const role of ["explorer", "librarian"]) {
    const lane = laneOf(role);
    assert.match(lane, /Delegate when:/, role + " 必须有默认触发条件");
    assert.doesNotMatch(lane, /write the complete solution|resolve the answer first/, role + " 不得要求主代理先给出完整解决方案");
  }
  assert.match(laneOf("explorer"), /symbols, callers, patterns or tests/);
  assert.match(laneOf("explorer"), /return file locations, separating facts from inferences/);
  assert.match(laneOf("librarian"), /official docs|upstream evidence/);
  assert.match(laneOf("librarian"), /cite sources and versions/);

  // fixer：已定方案的非前端实现劳动，单文件的大量工作同样适合。
  assert.match(laneOf("fixer"), /an agreed approach is already fixed/);
  assert.match(laneOf("fixer"), /one large single-file change/);
  assert.match(laneOf("fixer"), /non-frontend approach/);

  // oracle：高风险决策与疑难调试要提前参与，不只等"普通诊断失败之后"。
  assert.match(laneOf("oracle"), /early architecture, high-risk or hard-debugging judgment can steer the work/);
  assert.match(laneOf("oracle"), /a user-asked review always triggers it, even for a routine change; a large or high-risk implementation is finished/);
  // 负面 lane 必须限定在"未命中上述触发条件的常规工作"：用户明确要求审查时，即使改动
  // 常规也必须优先满足，不能被"改动常规且方案清楚"反过来压过。
  assert.match(laneOf("oracle"), /Do not delegate when: the change is routine and the approach is clear, unless a review was asked/);
  assert.doesNotMatch(laneOf("oracle"), /- Do not delegate when: a change is routine and the correct approach is already clear/);

  // designer：前端/用户可见实现一律由 designer 承接，不再有「已定设计的微小文案」豁免。
  assert.match(laneOf("designer"), /layout, interaction, hierarchy, spacing, responsive behavior, accessibility, web UI/);
  assert.match(laneOf("designer"), /mandatory for frontend work, with no size or already-specified exception/);
  assert.doesNotMatch(laneOf("designer"), /already-fixed design/);
});

test("root prompt 强制前端路由：前端/用户可见实现只能由 designer 承接", () => {
  const prompt = buildOrchestratorPrompt({
    roles: ORCHESTRATOR_ROLES,
    providerReady: true,
    observerPreferred: false,
    rootSessionId: "root-session-routing",
  });
  // 1) 顶层强制规则存在，且覆盖 UI/UX、交互、web、PPT 等用户可见产物
  assert.ok(prompt.includes("Frontend and user-visible work is ALWAYS designer's, never the root's or fixer's"));
  assert.ok(prompt.includes("web UI/HTML"));
  assert.ok(prompt.includes("PPT/decks"));
  // 2) 旧的两条逃生门必须消失：不再把 designer 归为「早期判断」、不再有「已定设计可豁免」
  assert.ok(!prompt.includes("designer early for judgment"));
  assert.ok(!prompt.includes("already-fixed design"));
  // 3) fixer lane 明确排除前端，并在 Do not delegate 里点名 designer
  assert.ok(prompt.includes("non-frontend approach"));
  assert.ok(prompt.includes("the change is frontend or user-visible (designer's job)"));
  // 4) designer lane 明确「无尺寸/无已定设计豁免」
  assert.ok(prompt.includes("no size or already-specified exception"));
  assert.ok(prompt.includes("never fixer's"));
});

test("Observer lane 与真实附件事实一致，不提供本地路径读取入口", async () => {
  const prompt = buildOrchestratorPrompt({ roles: ["observer"] });
  const lane = prompt.match(/@observer\n([\s\S]*?)(?=\n\n|$)/)[1];
  // 当前 persona 只接受 Host durable 图片附件；lane 不得再要求完整文件路径或 read_image。
  assert.doesNotMatch(lane, /read_image/);
  assert.doesNotMatch(lane, /full workspace file path/);
  assert.match(lane, /Host-owned durable image attachment/);
  assert.match(lane, /a client-supplied path is never valid input/);
  assert.match(lane, /the image-routing policy permits it/);
  assert.match(lane, /automatic routing uses its fixed visual-only task/);
  // PDF 只能在已按合法图片形式呈现时分析，不新增任意 PDF/本地路径入口。
  assert.match(lane, /PDFs only when already a legal image form/);

  // 真实 plugin.apply 注册出的 routing section 不得再提供客户端文件路径 / read_image 入口：
  // 它与 root prompt 的 Observer lane 必须同时只承认 Host 提供的真实 durable 图片附件。
  const routingHost = appliedHost({ config: { enableOrchestrator: true, enableObserver: true } });
  const routingRoot = routingHost.registerRootAgent("root-observer-routing");
  const routingText = sectionText(routingHost, ROUTING_SECTION, routingRoot);
  assert.match(routingText, /Enabled expert tools: /);
  assert.doesNotMatch(routingText, /workspace file paths/, "routing 不得要求以客户端文件路径投递图片");
  assert.doesNotMatch(routingText, /read_image/, "routing 不得指向 read_image 入口");
  assert.match(routingText, /Host-provided durable image attachment/, "routing 必须只承认 Host 提供的真实 durable 图片附件");
  assert.match(routingText, /when the current image routing policy allows it/, "Observer 必须限定在当前图片路由策略允许时");
  assert.match(routingText, /fixed visual-only task contract/, "自动图片路由必须遵守固定纯视觉子任务契约");
  assert.match(routingText, /any role tool may receive a direct image attachment when its selected model explicitly supports image/, "其他支持图片角色的真实接图语义保持原样");
  // 同一 Host 的 root prompt 与 routing 口径一致：两处都不再出现路径 / read_image 说法。
  const registeredRootPrompt = sectionText(routingHost, ORCHESTRATOR_SECTION, routingRoot);
  for (const text of [registeredRootPrompt, routingText]) {
    assert.doesNotMatch(text, /read_image/);
    assert.doesNotMatch(text, /workspace file paths/);
  }
  assert.match(registeredRootPrompt, /Host-owned durable image attachment/, "root prompt 与 routing 都必须只承认 Host durable 附件");
  await routingHost.dispose();

  // observerPreferred 两个分支与图片路由契约保持不变。
  assert.match(buildOrchestratorPrompt({ observerPreferred: true }), /Observer优先 is enabled/);
  assert.match(buildOrchestratorPrompt({ observerPreferred: false }), /Observer优先 is disabled/);
  assert.doesNotMatch(buildOrchestratorPrompt({ roles: ["explorer", "fixer"] }), /Image routing:/, "未启用 observer 时不得注入任何图片路由分支");
  assert.match(prompt, /Image routing: Observer优先 is disabled/, "启用 observer 时保留既有路由分支");
});

test("主代理提示词把 role lane 与注册表摘要暴露在派发工具门面上", () => {
  const host = appliedHost();
  const root = host.registerRootAgent("root-lane-facade");
  const orchestrator = sectionText(host, ORCHESTRATOR_SECTION, root);
  // 派发工具门面复用注册表摘要：主提示词里的"- Role:"行与工具描述同源。
  for (const role of ["explorer", "librarian", "oracle", "designer", "fixer"]) {
    const entry = getRole(role);
    assert.ok(orchestrator.includes("- Role: " + entry.label + " — " + entry.description), role + " 主提示词必须复用注册表摘要");
    assert.ok(host.toolDefinition(role).description.includes(entry.description), role + " 工具描述必须复用注册表摘要");
  }
  // lane 只出现在 root 提示词里，不复制进 tool description。
  assert.match(orchestrator, /@fixer\n- Role: Fixer/);
  assert.doesNotMatch(host.toolDefinition("fixer").description, /Delegate when:/);
  host.dispose();
});

test("新默认 persona 经真实 admission 到达新建 child，并保留固定纪律", async () => {
  const requests = [];
  const host = appliedHost({
    settings: { value: { defaults: { oracle: { provider: "mock", model: "mock" }, designer: { provider: "mock", model: "mock" } } } },
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        return { childId: "lane-child-" + requests.length, messageId: "lane-message-" + requests.length };
      },
    },
  });
  const root = host.registerRootAgent("root-lane-persona");
  for (const role of ["oracle", "designer"]) {
    const admitted = await host.toolDefinition(role).execute(
      { description: role + " persona", prompt: role + " 任务" },
      execution(root),
    );
    assert.equal(admitted.kind, "continuable", role + " 必须接受 admission");
  }
  await flushAsyncWork();
  assert.equal(requests.length, 2, "两个角色各自新建一个 child");
  for (const [index, role] of ["oracle", "designer"].entries()) {
    const persona = requests[index].persona;
    const disciplineAt = persona.indexOf(FIXED_EXPERT_DISCIPLINE);
    assert.ok(disciplineAt > 0, role + " 必须由默认 persona 加固定纪律组成");
    assert.equal(persona.slice(0, disciplineAt), DEFAULT_EXPERT_PERSONA[role], role + " 新建 child 必须收到当前默认 persona");
  }
  assert.match(DEFAULT_EXPERT_PERSONA.oracle, /Answer the decision question that was asked/);
  assert.match(DEFAULT_EXPERT_PERSONA.designer, /own the visual and interaction judgment within the stated constraints/);
  assert.match(DEFAULT_EXPERT_PERSONA.explorer, /Separate facts from inferences/);
  assert.match(DEFAULT_EXPERT_PERSONA.librarian, /sources with versions/);
  assert.match(DEFAULT_EXPERT_PERSONA.librarian, /version-specific behavior/);
  assert.match(DEFAULT_EXPERT_PERSONA.fixer, /read local code context, follow existing patterns, and add or adjust tests/);
  assert.match(DEFAULT_EXPERT_PERSONA.fixer, /stop implementing on that premise and report the evidence, the impact, and the unfinished work/);
  // override 语义保持不变：覆盖只替换专家专属部分。
  assert.equal(resolveExpertPersona("fixer", "自定义"), "自定义" + FIXED_EXPERT_DISCIPLINE);
  host.dispose();
});

test("主代理提示词规定同角色 child 控制和结果直接消费", () => {
  const prompt = buildOrchestratorPrompt();
  // 多 child 语义：不同 prompt 新建独立 child；续作与取消都必须给显式 childId/cancelChildId。
  assert.match(prompt, /Each role-tool call with a different prompt starts its own independent child/);
  assert.match(prompt, /never auto-continued to, steered into, or cancelled against an existing plugin-managed child/);
  assert.match(prompt, /Continue an existing child only by passing that child's explicit childId/);
  assert.match(prompt, /cancel one only by passing cancelChildId for that exact child/);
  assert.match(prompt, /never infer the target from the parent session and role/);
  assert.doesNotMatch(prompt, /invoke the same role-named plugin tool again with a different prompt/);
  assert.match(prompt, /queue=false/);
  assert.match(prompt, /subagents\.interrupt/);
  assert.match(prompt, /subagents\.sendMessage/);
  assert.match(prompt, /do not await whenIdle/);
  assert.match(prompt, /do not claim an unpublished FIFO queue/);
  assert.match(prompt, /manager sendMessage/);
  assert.match(prompt, /tools\.send_message/);
  assert.match(prompt, /\binterrupt_agent\b/);
  assert.match(prompt, /generic subagent tool/);
  assert.match(prompt, /Harness outer subagent_<role>/);
  assert.match(prompt, /raw Agent messages/);
  assert.match(prompt, /prompt 必须统一使用中文/);
  assert.match(prompt, /第一句必须是“你是 XXX 子代理。”/);
  assert.match(prompt, /任务正文必须自包含/);
  assert.match(prompt, /workspace 路径、允许范围和预期验证/);
  assert.match(prompt, /固定 child 纪律由 persona、toolFilter 和 runtime guard 注入和执行/);
  assert.match(prompt, /主代理不要在任务正文重复写入 send_message、叶子 worker 或最终 assistant 输出规则/);
  assert.doesNotMatch(prompt, /任务必须明确禁止调用 send_message/);
  assert.doesNotMatch(prompt, /wait first/);
  assert.match(prompt, /Never use the subagent message\/interrupt control path merely to wait for a background result/);
  assert.match(prompt, /run_in_background is a compatibility input only: omitted, true, and false all use non-blocking admission/);
  assert.match(prompt, /normal later-turn feedback mechanism/);
  assert.match(prompt, /Do not call the same role-named tool again merely to wait, confirm, or restate the same result/);
  assert.match(prompt, /queue=true applies only to an explicit childId continuation.*not a waiting mechanism/s);
  assert.doesNotMatch(prompt, /\batomic\b|\burgent\b|interruptAndSteer/);
});

test("根、子代理和无 Agent 组装上下文的作用域判定正确", () => {
  const rootAgent = { session: { header: {} } };
  const childAgentContext = { session: { header: { parentSession: "root-session" } } };
  assert.equal(isRootAgentContext({ agent: rootAgent }), true);
  assert.equal(isRootAgentContext({ agent: childAgentContext }), false);
  assert.equal(isRootAgentContext({ agent: undefined }), false);
  assert.equal(isRootAgentContext({}), false);
});

test("主代理提示词注入当前根会话身份并禁止向自己发送 session.prompt", () => {
  const prompt = buildOrchestratorPrompt({ rootSessionId: "session-root-identity-test" });
  assert.match(prompt, /YOU are the current root\/parent orchestrator/);
  assert.match(prompt, /There is no separate outer main agent above you/);
  assert.match(prompt, /session-root-identity-test/);
  assert.match(prompt, /主代理.*parent.*root agent.*YOU/s);
  assert.match(prompt, /session\.prompt/);
  assert.match(prompt, /self-messaging/);
  assert.match(prompt, /Each role-tool call with a different prompt starts its own independent child/);
  assert.match(prompt, /passing that child's explicit childId from an earlier receipt/);

  // 真实注册的 orchestrator section 必须绑定组装上下文里的 exact root 身份，
  // 而不是固定字符串：换一个 root id 必须得到另一个 session id。
  const host = appliedHost();
  const firstRoot = host.registerRootAgent("session-root-identity-test");
  const secondRoot = host.registerRootAgent("session-root-identity-other");
  const firstText = sectionText(host, ORCHESTRATOR_SECTION, firstRoot);
  const secondText = sectionText(host, ORCHESTRATOR_SECTION, secondRoot);
  assert.ok(firstText.includes("session-root-identity-test"), "section 必须注入当前 root session id");
  assert.equal(firstText.includes("session-root-identity-other"), false);
  assert.ok(secondText.includes("session-root-identity-other"));
  assert.equal(secondText.includes("session-root-identity-test"), false);
  host.dispose();
});

test("provider 不可用时不列出不存在的 subagent 工具", () => {
  const prompt = buildOrchestratorPrompt({ providerReady: false });
  assert.match(prompt, /spawn provider is not ready/);
  assert.doesNotMatch(prompt, /Available expert tools:/);
  assert.doesNotMatch(prompt, /Available expert tools:.*explorer/);
  assert.doesNotMatch(prompt, /Available expert tools:.*observer/);

  // 真实 apply：provider 不可用时角色工具不注册，routing 如实报告不可用。
  const host = appliedHost({ providerReady: false });
  const root = host.registerRootAgent("root-provider-unavailable");
  assert.equal(host.toolNames().includes("explorer"), false, "provider 不可用时不得注册角色工具");
  assert.equal(host.toolNames().includes("fanout"), false, "provider 不可用时不得注册 fanout");
  const routing = sectionText(host, ROUTING_SECTION, root);
  assert.match(routing, /provider is not ready/);
  assert.doesNotMatch(routing, /Enabled expert tools:/);
  const orchestrator = sectionText(host, ORCHESTRATOR_SECTION, root);
  assert.match(orchestrator, /spawn provider is not ready/);
  assert.doesNotMatch(orchestrator, /Available expert tools:/);
  host.dispose();
});

test("observer 关闭时不暴露 observer lane", () => {
  const prompt = buildOrchestratorPrompt({ roles: ["explorer", "fixer"] });
  assert.match(prompt, /@explorer/);
  assert.match(prompt, /@fixer/);
  assert.doesNotMatch(prompt, /@observer/);
  assert.doesNotMatch(prompt, /Available expert tools:.*observer/);

  // 真实 apply + 真实开关：关闭 observer 后工具、routing、orchestrator 同步收缩。
  const host = appliedHost({ config: { enableOrchestrator: true, enableObserver: false } });
  const root = host.registerRootAgent("root-observer-disabled");
  assert.equal(host.toolNames().includes("observer"), false);
  assert.ok(host.toolNames().includes("explorer"));
  assert.ok(host.toolNames().includes("fixer"));
  const orchestrator = sectionText(host, ORCHESTRATOR_SECTION, root);
  assert.match(orchestrator, /@explorer/);
  assert.match(orchestrator, /@fixer/);
  assert.doesNotMatch(orchestrator, /@observer/);
  assert.doesNotMatch(sectionText(host, ROUTING_SECTION, root), /observer/);
  host.dispose();
});

test("主代理提示词不依赖 OpenCode 专属委派 API", () => {
  const prompt = buildOrchestratorPrompt();
  assert.doesNotMatch(prompt, /task_[a-z_]+/);
  assert.doesNotMatch(prompt, /wait_for_user/);
  assert.doesNotMatch(prompt, /mode:\s*(primary|subagent)/);
});

test("真实 apply 把 orchestrator 配置与 section 限定到根 Agent", () => {
  // Config 是插件的公开导出，DSH 在 apply 前用它补齐默认组合配置。
  const host = appliedHost();
  assert.equal(host.plugin.Config({}).enableOrchestrator, true, "orchestrator 默认启用");
  assert.equal(host.plugin.Config({}).enableObserver, false, "裸 Config 默认关闭 observer");
  assert.equal(host.plugin.Config({ enableOrchestrator: false }).enableOrchestrator, false, "显式 false 必须保留");

  const definition = host.sections.get(ORCHESTRATOR_SECTION);
  assert.ok(definition, "根编排 section 必须由真实 apply 注册");
  assert.equal(definition.order, 1);
  const root = host.registerRootAgent("root-only-scope");
  assert.ok(sectionText(host, ORCHESTRATOR_SECTION, root).length > 0, "根上下文必须收到编排提示词");
  // 根限定：child 组装上下文与无 agent 的诊断组装都不得注入根编排文本。
  assert.equal(sectionText(host, ORCHESTRATOR_SECTION, childAgent("child-scope", root.id)), "");
  assert.equal(sectionText(host, ORCHESTRATOR_SECTION, undefined), "");
  assert.match(sectionText(host, ROUTING_SECTION, root), /Enabled expert tools:/);
  host.dispose();

  // 配置门：关闭 orchestrator 只移除根编排 section，routing 仍如实报告可用工具。
  const disabled = appliedHost({ config: { enableOrchestrator: false, enableObserver: true } });
  disabled.registerRootAgent("root-orchestrator-disabled");
  assert.equal(disabled.sections.has(ORCHESTRATOR_SECTION), false);
  assert.equal(disabled.sections.has(ROUTING_SECTION), true);
  disabled.dispose();
});

test("插件工具使用唯一命名空间并声明 root/parent owner 边界", async () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /\bexplorer\b/);
  assert.match(prompt, /Harness outer subagent_<role>/);
  assert.match(prompt, /run_code/);
  assert.match(prompt, /leaf worker and must not delegate/);

  const host = appliedHost();
  for (const role of ORCHESTRATOR_ROLES) {
    assert.ok(host.toolNames().includes(role), "角色工具必须使用短角色名: " + role);
    assert.equal(host.toolNames().includes("subagent_" + role), false, "不得注册外层 subagent_<role> 名称");
    assert.equal(host.toolDefinition(role).name, role);
  }

  // root/parent owner 边界：child 拿不到 root 代际，角色工具必须 fail-closed。
  await assert.rejects(
    () => host.toolDefinition("explorer").execute(
      { description: "child caller", prompt: "child 不得委派" },
      execution(childAgent("child-owner", "root-owner")),
    ),
    /root generation is no longer live|is root-only/,
    "child agent 调用角色工具必须被拒绝",
  );
  await host.dispose();
});

test("主代理提示词锁定依赖、范围冲突与 turn 纪律契约", () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /affectedPaths/);
  assert.match(prompt, /allowOverlap:true/);
  assert.match(prompt, /dispatch the prerequisite first/);
  assert.match(prompt, /dispatch the dependent task/);
  assert.match(prompt, /prerequisite and dependent work may not share a round or run in parallel/);
  // 旧文案「没有可做的事就返回 DSH ready」已退役：它教会模型用一段纯文本结束 turn。
  assert.match(prompt, /every turn must end by calling dsh_expert_group_done as the last tool call/);
  assert.match(prompt, /Never poll/);
  // finalize 的两阶段契约：工具只做校验与等待登记并立即返回非终态 waiting，继续等待
  // 属于 root turn 的 turn-stopping 生命周期；旧文案「finalize 工具调用自身保持 root
  // turn 打开且没有超时 / 它是唯一等待机制」必须整体退役（完整矩阵见下一个用例）。
  // 去重后「唯一等待机制」与「登记后立即返回 waiting / turn-stopping 无超时」分处同一权威块的两句；
  // 完整语义矩阵见下一个用例。
  assert.match(prompt, /finalize is the only waiting mechanism you call/);
  assert.doesNotMatch(prompt, /finalize is the only waiting mechanism and it has no timeout/);
  assert.doesNotMatch(prompt, /pauses the root goal/i, "不得再声称 finalize 会暂停 root goal");
  // turn 纪律必须写成模型可见的硬约束：**每个 turn** 都必须把 dsh_expert_group_done 作为
  // 最后一个工具调用，缺少该调用（包括纯文本收尾）会被 turn-stopping 边界视为未完成并继续。
  // 旧文案「没有工具调用的消息会结束 turn / 请求全部交付后才结束 turn」已退役（判定不看文本，
  // 也不区分本 turn 是否调用过工具）。
  assert.match(prompt, /Turn discipline: every turn must end by calling dsh_expert_group_done as the last tool call/);
  assert.match(prompt, /a turn that closes without that call is treated as unfinished and continued/);
  assert.match(prompt, /Never end a turn with a plan, progress note, or promise/);
  assert.match(prompt, /Expert settlements and finalization notices are inputs to continue from, not stop signals/);
  assert.equal(prompt.split("dsh_expert_group_done").length - 1, 1, "完成标记工具名只允许出现一次");
  assert.doesNotMatch(prompt, /reassess work and return DSH ready again/i, "旧文案必须退役：它鼓励用纯文本收尾");
  assert.match(prompt, /dsh_expert_group_finalize/);
  assert.match(prompt, /continue_parent_turn:true/);
  assert.match(prompt, /immediate safe non-overlapping work/);
  assert.match(prompt, /feedback.*later turn/s);
  assert.match(prompt, /the same parent session and role may hold several continuable children at once/);
  assert.match(prompt, /cancel one only by passing cancelChildId for that exact child/);
});

test("root 编排提示词：finalize 登记等待后立即返回 waiting，root turn 在 turn-stopping 边界继续等待且无超时", async () => {
  const prompt = buildOrchestratorPrompt({ rootSessionId: "finalize-waiting-contract" });

  // 1. finalize 只做校验 + 等待登记，登记完成后立即返回非终态 waiting 回执；
  //    waiting 表示"等待已登记"，不是完成，也不是可轮询的异步 task handle。
  assert.match(prompt, /Finalize validates that batch and registers every accepted expert on the root wait ledger, then returns immediately with its non-terminal waiting receipt/);
  assert.match(prompt, /waiting receipt carrying admissionEpoch and acceptedCount/);
  assert.match(prompt, /waiting means the wait is registered, not that any expert finished/);
  assert.match(prompt, /it is not an asynchronous task handle, and there is no status to poll/);

  // 2. 继续等待由 root turn 的 agent/turn-stopping 生命周期承担，而不是 finalize 调用本身；
  //    该生命周期等待没有超时（专家可能合法地运行数小时）。
  assert.match(prompt, /The current root turn then keeps waiting at the agent\/turn-stopping lifecycle boundary on that same ledger, with no timeout/);
  assert.match(prompt, /with no timeout, because an expert may legitimately run for hours/);

  // 3. 模型拿到 waiting 后不得重试 finalize、不得轮询状态；批次收口与结论投递由插件自动完成。
  //    但等待期间仍然允许（并要求）继续做其他独立工作，绝不能用一段纯文本回复结束 turn。
  assert.match(prompt, /After that waiting receipt, do not call finalize again for that batch and do not poll for status/);
  assert.match(prompt, /keep doing other independent work with tool calls/);
  assert.match(prompt, /steers one finalization message into your next step automatically/);
  assert.match(prompt, /once the accepted work is actually still/);
  assert.match(prompt, /waiting happens at that boundary, not in a message/);

  // 4. 保留既有纪律：模型仍不得直接调用 Agent.steer/Agent.whenIdle；插件在生命周期边界
  //    的内部 steer 是插件行为，不是模型操作。
  assert.match(prompt, /Do not call Agent\.whenIdle\/Agent\.steer directly/);
  assert.match(prompt, /that plugin-internal steer at the lifecycle boundary is not a model action/);

  // 5. 旧说法必须退役：finalize 工具调用不再"保持 root turn 打开直到专家结束"且不再无限等待。
  assert.doesNotMatch(prompt, /keeps the current root turn open until every expert it accepted has actually finished/);
  assert.doesNotMatch(prompt, /then returns; it has no timeout/);
  assert.doesNotMatch(prompt, /never waits with a timeout/i);
  assert.doesNotMatch(prompt, /pauses the root goal/i);

  // 真实注册的 root section 必须同样表达新契约，而不只对构造器成立。
  const host = appliedHost();
  const root = host.registerRootAgent("root-finalize-waiting-contract");
  const registered = sectionText(host, ORCHESTRATOR_SECTION, root);
  assert.match(registered, /non-terminal waiting receipt/);
  assert.match(registered, /agent\/turn-stopping lifecycle boundary/);
  assert.match(registered, /do not call finalize again for that batch and do not poll for status/);
  assert.match(registered, /keep doing other independent work with tool calls/);
  await host.dispose();
});

test("动态专家工具与 routing 只保留各自短契约，不复制 root workflow", () => {
  const host = appliedHost();
  const fixerTool = host.toolDefinition("fixer");
  const dynamicToolDescription = fixerTool.description;
  const queueParameterDescription = fixerTool.parameters.properties.queue.description;
  const root = host.registerRootAgent("root-prompt-source");
  const routingPrompt = sectionText(host, ROUTING_SECTION, root);

  assert.notEqual(dynamicToolDescription, "");
  assert.equal(dynamicToolDescription, buildRoleToolDescription("fixer"));
  assert.ok(dynamicToolDescription.endsWith(ROLE_TOOL_ADMISSION_CONTRACT));
  assert.match(dynamicToolDescription, /must be self-contained/);
  assert.match(dynamicToolDescription, /the workspace path, the allowed scope, the expected verification, and the affectedPaths/);
  assert.match(dynamicToolDescription, /The fixed child discipline is injected by the plugin on the child itself/);
  // 长编排协议只留在 root prompt：tool schema 不得复制等待/收口语义。
  assert.doesNotMatch(dynamicToolDescription, /dsh_expert_group_finalize/);
  assert.doesNotMatch(dynamicToolDescription, /continue_parent_turn/);
  assert.doesNotMatch(dynamicToolDescription, /不能把它当作等待机制/);
  assert.doesNotMatch(dynamicToolDescription, /任务必须明确禁止调用 send_message/);
  assert.doesNotMatch(dynamicToolDescription, /<Workflow>/);
  assert.doesNotMatch(dynamicToolDescription, /After every role-tool batch returns/);

  // queue 参数 schema 来自真实注册定义：可选、默认 false，且自带等待语义边界。
  assert.equal(fixerTool.parameters.properties.queue.type, "boolean");
  assert.equal(fixerTool.parameters.properties.queue.default, false);
  assert.notEqual(queueParameterDescription, "");
  // queue 只在带 childId 的显式续作下生效；不带 childId 时不同 prompt 一律新建独立 child。
  assert.match(queueParameterDescription, /Only meaningful together with childId \(an explicit continuation\)/);
  assert.match(queueParameterDescription, /Without childId the value is ignored because a different prompt always starts an independent child/);
  assert.match(queueParameterDescription, /not a waiting mechanism/);
  // childId / cancelChildId 是公开的显式续作与取消句柄：取消绝不按 parent+role 猜目标。
  const childIdDescription = fixerTool.parameters.properties.childId.description;
  const cancelDescription = fixerTool.parameters.properties.cancelChildId.description;
  assert.match(childIdDescription, /never continues or redirects an existing child on its own/);
  assert.match(cancelDescription, /never guesses a target from the parent session and role/);
  assert.match(cancelDescription, /Takes precedence over childId/);

  assert.notEqual(routingPrompt, "");
  assert.match(routingPrompt, /Enabled expert tools/);
  assert.doesNotMatch(routingPrompt, /Current root\/parent routing|non-blocking|affectedPaths|read-only|session\.prompt/);
  assert.doesNotMatch(routingPrompt, /<Workflow>/);
  assert.doesNotMatch(routingPrompt, /After every role-tool batch returns/);
  assert.doesNotMatch(routingPrompt, /dsh_expert_group_finalize/);
  host.dispose();
});

test("提示词来源不重复注入完整编排契约", () => {
  // 旧实现把 root workflow 原样复制到 routing 与每个 role tool；该断言锁定公开
  // 注册面里的来源边界，避免用删 system section 或静默切片掩盖宿主长度问题。
  const host = appliedHost();
  const root = host.registerRootAgent("root-prompt-single-source");
  const routingPrompt = sectionText(host, ROUTING_SECTION, root);
  const dynamicToolDescription = host.toolDefinition("fixer").description;
  assert.doesNotMatch(routingPrompt, /After every role-tool batch returns/);
  assert.doesNotMatch(dynamicToolDescription, /After every role-tool batch returns/);
  host.dispose();
});

test("发布白名单包含生产依赖的提示词契约模块", () => {
  assert.ok(Array.isArray(packageJson.files));
  assert.ok(packageJson.files.includes("prompt-contracts.js"));
});

test("提示词构建保持完整 section 且无静默截断", () => {
  const prompt = buildOrchestratorPrompt({ rootSessionId: "integrity-root" });
  for (const marker of ["<Identity>", "</Identity>", "<Role>", "</Role>", "<Agents>", "</Agents>", "<Workflow>", "</Workflow>", "<DelegationContract>", "</DelegationContract>"]) {
    assert.ok(prompt.includes(marker), `root prompt 缺少完整 marker: ${marker}`);
  }
  assert.equal((prompt.match(/<Identity>/g) ?? []).length, 1);
  assert.equal((prompt.match(/<\/DelegationContract>/g) ?? []).length, 1);
  assert.doesNotMatch(prompt, /(?:\.\.\.|TRUNCAT(?:ED|ION)|截断)/i);

  // 真实注册的 section 文本必须同样完整：诊断对活注册面成立，而不只对构造器成立。
  const host = appliedHost();
  const root = host.registerRootAgent("integrity-root");
  const registered = sectionText(host, ORCHESTRATOR_SECTION, root);
  const diagnostic = inspectOrchestratorPrompt(registered);
  assert.equal(diagnostic.complete, true, "注册的 root section 不得缺 marker 或带截断痕迹");
  assert.equal(diagnostic.utf8Bytes, new TextEncoder().encode(registered).length);
  host.dispose();
});

test("root prompt 诊断使用 UTF-8 长度并确认 section 完整", () => {
  const prompt = buildOrchestratorPrompt({ rootSessionId: "utf8-diagnostic" });
  const diagnostic = inspectOrchestratorPrompt(prompt);
  assert.equal(diagnostic.utf8Bytes, new TextEncoder().encode(prompt).length);
  assert.ok(diagnostic.utf8Bytes > 0);
  assert.equal(diagnostic.markersPresent, true);
  assert.equal(diagnostic.hasTruncationMarker, false);
  assert.equal(diagnostic.complete, true);
  for (const marker of ["<Identity>", "</Identity>", "<Role>", "</Role>", "<Scope>", "</Scope>", "<Agents>", "</Agents>", "<Notifications>", "</Notifications>", "<Workflow>", "</Workflow>", "<Communication>", "</Communication>", "<DelegationContract>", "</DelegationContract>"]) {
    assert.equal(diagnostic.markerCounts[marker], 1, `marker 应只出现一次: ${marker}`);
  }
});

test("root prompt 诊断拒绝缺失、重复和截断标记，并安全处理非字符串", () => {
  const prompt = buildOrchestratorPrompt({ rootSessionId: "diagnostic-negative" });
  const cases = [
    ["missing marker", prompt.replace("<Workflow>", "")],
    ["duplicate marker", prompt + "<Workflow>"],
    ["ellipsis", prompt + "..."],
    ["TRUNCATED", prompt + "TRUNCATED"],
    ["Chinese truncation", prompt + "截断"],
  ];
  for (const [label, candidate] of cases) {
    const diagnostic = inspectOrchestratorPrompt(candidate);
    assert.equal(diagnostic.complete, false, label);
  }
  for (const candidate of ["", undefined, null, 42, {}, []]) {
    const diagnostic = inspectOrchestratorPrompt(candidate);
    assert.equal(diagnostic.utf8Bytes, 0);
    assert.equal(diagnostic.markersPresent, false);
    assert.equal(diagnostic.hasTruncationMarker, false);
    assert.equal(diagnostic.complete, false);
  }
});

test("child persona 承载英文固定纪律与五标题交付协议，且不带 root workflow", async () => {
  const requests = [];
  const host = appliedHost({
    settings: { value: { defaults: { fixer: { provider: "mock", model: "mock" } } } },
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        return { childId: "persona-child", messageId: "persona-message" };
      },
    },
  });
  const root = host.registerRootAgent("root-persona");
  const admitted = await host.toolDefinition("fixer").execute(
    { description: "persona contract", prompt: "实现 persona 契约" },
    execution(root),
  );
  assert.equal(admitted.kind, "continuable");
  await flushAsyncWork();
  assert.equal(requests.length, 1, "admission 必须把 persona 交给公开 startContinuable request");

  const persona = requests[0].persona;
  assert.equal(typeof persona, "string");
  assert.notEqual(persona, "");
  for (const rule of ["You are a leaf worker: never delegate or create other subagents", "never call workflow, ralph, or goal tools", "Never call send_message directly", "never reach it indirectly through run_code", "do not proactively message your parent", "Do the task in Chinese"]) {
    assert.ok(persona.includes(rule), "child persona 缺少固定纪律：" + rule);
  }
  for (const heading of ["任务结果", "关键发现或修改内容", "实际变更文件", "验证结果", "未完成项或阻塞原因"]) {
    assert.ok(persona.includes(heading), "child persona 缺少最终输出标题：" + heading);
  }
  assert.doesNotMatch(persona, /<Workflow>/, "child persona 不得携带 root workflow");
  assert.doesNotMatch(persona, /After every role-tool batch returns/);
  host.dispose();
});

test("root prompt 区分 ready child、root 收口与 stale scope 只读诊断", async () => {
  const prompt = buildOrchestratorPrompt();
  assert.match(prompt, /A child in ready state has no current turn/);
  // finalize 的 root-only 语义与两阶段等待现在只由 Workflow 第 4 步声明一次。
  assert.match(prompt, /root-only dsh_expert_group_finalize/);
  assert.match(prompt, /non-terminal waiting receipt/);
  assert.match(prompt, /keeps waiting at the agent\/turn-stopping lifecycle boundary/);
  assert.doesNotMatch(prompt, /ends only the current root turn/);
  assert.doesNotMatch(prompt, /Never use this control path merely to wait for a background result/);
  assert.match(prompt, /dsh_expert_group_release_scope/);

  const host = appliedHost({
    settings: { value: { defaults: { fixer: { provider: "mock", model: "mock" } } } },
    subagents: { startContinuable: async () => ({ childId: "stale-scope-child", messageId: "stale-scope-message" }) },
  });
  const root = host.registerRootAgent("root-stale-scope");
  assert.ok(host.toolNames().includes("dsh_expert_group_release_scope"), "stale scope 恢复工具必须真实注册");

  const admitted = await host.toolDefinition("fixer").execute(
    { description: "stale scope", prompt: "实现 stale scope", affectedPaths: ["file:src/stale.js"] },
    execution(root),
  );
  assert.equal(admitted.kind, "continuable");
  const guardedRead = { name: "read", arguments: { file_path: "src/stale.js" }, agent: root };
  assert.match(guardWarning(host.guards, guardedRead) ?? "", /overlaps active expert work/, "活动专家任务期间必须保护 affectedPaths");

  // 票据 07：release_scope 已收紧为只读诊断，人工动作不得释放影响范围保护。
  const inspected = await host.toolDefinition("dsh_expert_group_release_scope").execute(
    { childId: admitted.subagentId, reason: "checking stale scope" },
    execution(root),
  );
  assert.equal(inspected.kind, "scope-release-refused");
  assert.equal(inspected.childId, admitted.subagentId);
  assert.equal(inspected.reason, "authoritative-stop-required");
  assert.equal(inspected.activeCount, 1, "必须精确报告该 child 仍持有的活动范围");
  assert.equal(inspected.active[0].detached, false);
  assert.match(guardWarning(host.guards, guardedRead) ?? "", /overlaps active expert work/, "人工诊断不得释放保护");

  // root-only：child 调用恢复工具必须 fail-closed，且空参数不得静默放行。
  await assert.rejects(
    () => host.toolDefinition("dsh_expert_group_release_scope").execute(
      { childId: admitted.subagentId, reason: "child caller" },
      execution(childAgent("child-release", root.id)),
    ),
    /root-only|root generation is no longer live/,
    "child 调用 root-only 恢复工具必须被拒绝",
  );
  await assert.rejects(
    () => host.toolDefinition("dsh_expert_group_release_scope").execute({ childId: "  ", reason: "empty child" }, execution(root)),
    /childId must be non-empty/,
  );
  await assert.rejects(
    () => host.toolDefinition("dsh_expert_group_release_scope").execute({ childId: admitted.subagentId, reason: "  " }, execution(root)),
    /reason must be non-empty/,
  );
  host.dispose();
});

// ── 票据 22：提示词去重的唯一权威块、模板缓存与体积门禁 ─────────────────────────

test("root prompt 收敛为唯一 finalize/等待契约块，且 section 结构不回归", () => {
  const prompt = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: false, rootSessionId: "root-session-dedupe" });
  // 契约句只出现一次：Identity/Workflow 之间不再各自复述一份。
  assert.equal(prompt.split("dsh_expert_group_finalize").length - 1, 1, "finalize 工具名只允许出现一次");
  assert.equal(prompt.split("agent/turn-stopping").length - 1, 1, "turn-stopping 等待边界只允许出现一次");
  assert.equal(prompt.split("non-terminal waiting receipt").length - 1, 1, "waiting 回执语义只允许出现一次");
  assert.equal(prompt.split("do not poll for status").length - 1, 1, "不轮询只允许声明一次");
  assert.equal(prompt.split("with no timeout").length - 1, 1, "无超时等待只允许声明一次");
  // Identity 只保留指针：finalize 契约的权威位置是 Workflow 第 4 步。
  assert.match(prompt, /stated once, in Workflow step 4/);
  // 16 个 section marker 各出现一次，顺序与既有契约一致。
  const diagnostic = inspectOrchestratorPrompt(prompt);
  assert.equal(diagnostic.complete, true);
  for (const marker of ORCHESTRATOR_SECTION_MARKERS) {
    assert.equal(diagnostic.markerCounts[marker], 1, "marker 必须唯一: " + marker);
  }
  let cursor = -1;
  for (const marker of ORCHESTRATOR_SECTION_MARKERS) {
    const at = prompt.indexOf(marker);
    assert.ok(at > cursor, "section 顺序不得改变: " + marker);
    cursor = at;
  }
});

test("root prompt 体积门禁：固定口径下相对全角色基线下降 ≥20%", () => {
  clearOrchestratorPromptCache();
  // 票据 22 记录的全角色基线（token 流水线口径，UTF-16 code unit）。
  const BASELINE_CHARACTERS = 18071;
  const containerBudget = Math.floor(BASELINE_CHARACTERS * 0.8);
  const measured = measureOrchestratorPrompt();
  assert.equal(typeof measured.characters, "number");
  assert.equal(measured.characters, measured.prompt.length, "字符口径必须是同一函数的 UTF-16 length");
  assert.equal(measured.utf8Bytes, new TextEncoder().encode(measured.prompt).length, "UTF-8 字节口径必须与字符口径同源");
  assert.ok(
    measured.characters <= containerBudget,
    "root prompt 体积必须 ≤ " + containerBudget + " 字符（基线 " + BASELINE_CHARACTERS + " 的 80%），实际 " + measured.characters,
  );
  // 运行期 rootSessionId 由构造器注入、长度可变（DSH 的 session-<uuid> 约 44 字符）。
  // 门禁必须覆盖最坏情况：用 64 字符 id 再测一次，判据仍是同一个 14456 基线，不放宽。
  const longIdPrompt = buildOrchestratorPrompt({
    roles: ORCHESTRATOR_ROLES,
    providerReady: true,
    observerPreferred: false,
    rootSessionId: "x".repeat(64),
  });
  assert.ok(
    longIdPrompt.length <= containerBudget,
    "64 字符 rootSessionId 下 root prompt 体积必须 ≤ " + containerBudget + " 字符，实际 " + longIdPrompt.length,
  );
  // 固定口径（全角色 / providerReady=true / observerPreferred=false / 固定 root id）与构造器结果一致。
  assert.equal(
    measured.prompt,
    buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: false, rootSessionId: "root-session-fixed" }),
  );
  assert.deepEqual([...ORCHESTRATOR_ROLES], ["explorer", "librarian", "oracle", "designer", "fixer", "observer"]);
  clearOrchestratorPromptCache();
});

test("root prompt 模板缓存：命中内容一致，rootSessionId 不进入 key", () => {
  clearOrchestratorPromptCache();
  const first = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: false, rootSessionId: "root-cache-a" });
  const afterFirst = getOrchestratorPromptCacheStats();
  assert.equal(afterFirst.size, 1);
  assert.equal(afterFirst.misses, 1);

  // 角色顺序不同但规范化后相同 → 命中同一模板；rootSessionId 变化不产生新模板。
  const second = buildOrchestratorPrompt({ roles: [...ORCHESTRATOR_ROLES].reverse(), providerReady: true, observerPreferred: false, rootSessionId: "root-cache-b" });
  const afterSecond = getOrchestratorPromptCacheStats();
  assert.equal(afterSecond.size, 1, "rootSessionId 不得进入缓存 key");
  assert.equal(afterSecond.hits, 1, "规范化角色集相同的请求必须命中缓存");
  assert.notEqual(first, second);
  assert.ok(first.includes("root-cache-a") && !first.includes("root-cache-b"));
  assert.ok(second.includes("root-cache-b") && !second.includes("root-cache-a"));
  assert.equal(first.split("root-cache-a").join("root-cache-b"), second, "除 session id 外模板必须逐字一致");

  // 同一 root 重复组装同样命中且结果稳定（真实 apply 每个请求都会重新组装）。
  const third = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: false, rootSessionId: "root-cache-a" });
  assert.equal(third, first);
  assert.equal(getOrchestratorPromptCacheStats().hits, 2);
  clearOrchestratorPromptCache();
});

test("root prompt 模板缓存：不同角色集/provider/observer 组合不串用", () => {
  clearOrchestratorPromptCache();
  const all = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: false, rootSessionId: "root-cache-combo" });
  const withoutObserver = buildOrchestratorPrompt({ roles: ["explorer", "librarian", "oracle", "designer", "fixer"], providerReady: true, observerPreferred: false, rootSessionId: "root-cache-combo" });
  const providerDown = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: false, rootSessionId: "root-cache-combo" });
  const observerFirst = buildOrchestratorPrompt({ roles: ORCHESTRATOR_ROLES, providerReady: true, observerPreferred: true, rootSessionId: "root-cache-combo" });
  assert.equal(new Set([all, withoutObserver, providerDown, observerFirst]).size, 4, "四种组合必须是四份不同文本");
  assert.doesNotMatch(withoutObserver, /@observer/, "未启用 observer 的模板不得带 observer lane");
  assert.doesNotMatch(providerDown, /Available expert tools:/, "provider 未就绪时不得声称工具可用");
  assert.match(observerFirst, /Observer优先 is enabled/);
  assert.match(all, /Observer优先 is disabled/);
  assert.equal(getOrchestratorPromptCacheStats().size, 4);

  // observer 未启用时 observerPreferred 归一：不得生成第二份模板。
  const explorerPreferred = buildOrchestratorPrompt({ roles: ["explorer"], providerReady: true, observerPreferred: true, rootSessionId: "root-cache-combo" });
  const explorerPlain = buildOrchestratorPrompt({ roles: ["explorer"], providerReady: true, observerPreferred: false, rootSessionId: "root-cache-combo" });
  assert.equal(explorerPreferred, explorerPlain);
  assert.equal(getOrchestratorPromptCacheStats().size, 5, "observer 未启用时两个开关值必须共用同一模板");
  clearOrchestratorPromptCache();
});

test("root prompt 模板缓存有界：超过上限按最近使用淘汰", () => {
  clearOrchestratorPromptCache();
  assert.equal(ORCHESTRATOR_PROMPT_CACHE_LIMIT, 32);
  // 6 个角色共有 64 种启用子集，足以把有界缓存填满并产生淘汰。
  const subsets = [];
  for (let mask = 0; mask < 64; mask += 1) {
    subsets.push(ORCHESTRATOR_ROLES.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  const inserted = subsets.slice(0, ORCHESTRATOR_PROMPT_CACHE_LIMIT + 4);
  for (const roles of inserted) buildOrchestratorPrompt({ roles, providerReady: true, rootSessionId: "root-cache-bounded" });
  const filled = getOrchestratorPromptCacheStats();
  assert.equal(filled.limit, ORCHESTRATOR_PROMPT_CACHE_LIMIT);
  assert.equal(filled.size, ORCHESTRATOR_PROMPT_CACHE_LIMIT, "缓存条数必须停在上限");
  assert.equal(filled.misses, inserted.length);
  // 最早写入的条目已被淘汰：再次请求会重新生成（miss），且缓存仍然有界。
  buildOrchestratorPrompt({ roles: inserted[0], providerReady: true, rootSessionId: "root-cache-bounded" });
  const afterEviction = getOrchestratorPromptCacheStats();
  assert.equal(afterEviction.misses, inserted.length + 1, "被淘汰的模板必须重新生成");
  assert.equal(afterEviction.size, ORCHESTRATOR_PROMPT_CACHE_LIMIT, "淘汰后不得越过上限");
  assert.deepEqual(clearOrchestratorPromptCache(), undefined);
  assert.deepEqual(getOrchestratorPromptCacheStats(), { size: 0, limit: ORCHESTRATOR_PROMPT_CACHE_LIMIT, hits: 0, misses: 0 });
});
