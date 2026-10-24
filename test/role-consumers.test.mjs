/**
 * 角色消费者迁移行为回归：Host 工具/meta、只读 deny、orchestrator 提示词、
 * shared 状态投影与 prompt 工具描述都必须来自统一角色注册表。
 *
 * 测试只通过公开注册面与公开导出断言：不读取生产源码文本，不使用源码切片或
 * new Function 重建内部实现。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createPluginHost, flushAsyncWork, RPC_ENDPOINT } from "../test-support/plugin-host.mjs";
import {
  getRole,
  listEnabledRoles,
  listReadOnlyRoles,
  listRoles,
  requireRole,
  roleStatusLabels,
  roleToolNames,
} from "../role-registry.js";
import {
  buildRoleToolDescription,
  DEFAULT_EXPERT_PERSONA,
  FIXED_EXPERT_DISCIPLINE,
  resolveExpertPersona,
  ROLE_TOOL_ADMISSION_CONTRACT,
} from "../prompt-contracts.js";
import { buildOrchestratorPrompt, ORCHESTRATOR_ROLES } from "../orchestrator.js";
import {
  EXPERT_DELEGATION_DENY,
  READONLY_DENY,
  ROOT_ONLY_TOOL_DENY,
  STATUS_ROLE_IDS,
  STATUS_ROLE_LABELS,
  normalizeStatusRole,
  resolveRunningStatusText,
} from "../shared.js";

const ALL_ROLE_IDS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const READ_ONLY_ROLE_IDS = ["explorer", "librarian", "oracle", "observer"];
const WRITE_ROLE_IDS = ["designer", "fixer"];
const ROOT_TOOL_NAMES = ["dsh_expert_group_finalize", "dsh_expert_group_done", "dsh_expert_group_release_scope", "dsh_expert_group_abandon_wait"];

function enabledIds(options) {
  return listEnabledRoles(options).map((entry) => entry.id);
}

function appliedHost(options = {}) {
  const host = createPluginHost(options);
  host.apply();
  return host;
}

test("Host 工具与 RPC meta 的启用角色来自注册表", async () => {
  const host = appliedHost();
  const enabled = enabledIds({ enableObserver: true });

  assert.deepEqual(host.toolNames().sort(), [...enabled, "fanout", ...ROOT_TOOL_NAMES].sort());
  const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.equal(meta.ok, true);
  assert.deepEqual(meta.value.roles, enabled);
  assert.deepEqual(meta.value.activeRoles, enabled);
  assert.equal(meta.value.enableObserver, true);
});

test("Observer 关闭时工具、meta 与只读投影同步收缩", async () => {
  const host = appliedHost({ config: { enableOrchestrator: true, enableObserver: false } });

  assert.equal(host.toolNames().includes("observer"), false);
  assert.deepEqual(host.toolNames().sort(), [...enabledIds(), "fanout", ...ROOT_TOOL_NAMES].sort());
  const meta = await host.invokeConnection(RPC_ENDPOINT, { action: "meta" });
  assert.deepEqual(meta.value.roles, enabledIds());
  assert.equal(meta.value.enableObserver, false);
  assert.deepEqual(roleToolNames(), enabledIds());
  assert.deepEqual(listReadOnlyRoles().map((entry) => entry.id), ["explorer", "librarian", "oracle"]);
  assert.deepEqual(listReadOnlyRoles({ enableObserver: true }).map((entry) => entry.id), READ_ONLY_ROLE_IDS);
});

test("只读角色与可写角色的 deny 列表由注册表只读性派生", async () => {
  const requests = [];
  const host = appliedHost({
    visibleTools: [...READONLY_DENY, ...EXPERT_DELEGATION_DENY, ...ROOT_ONLY_TOOL_DENY],
    settings: {
      value: {
        defaults: {
          explorer: { provider: "mock", model: "mock" },
          fixer: { provider: "mock", model: "mock" },
        },
      },
    },
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        return { childId: "child-" + requests.length, messageId: "message-" + requests.length };
      },
    },
  });
  const root = host.registerRootAgent("root-1");
  const fanout = host.toolDefinition("fanout");
  const exec = { agent: root, signal: new AbortController().signal, concludeTurn: () => {} };

  for (const [index, role] of ["explorer", "fixer"].entries()) {
    const accepted = await fanout.execute({
      role,
      basePrompt: "shared goal",
      shards: [{ shardId: "shard-" + role, prompt: "inspect " + role }],
    }, exec);
    assert.equal(accepted.accepted, true);
    await flushAsyncWork();
    assert.equal(requests.length, index + 1, role + " 必须发起一次 child admission");
  }

  const readOnlyDeny = requests[0].toolFilter.deny;
  const writeDeny = requests[1].toolFilter.deny;
  for (const name of ["write", "edit", "bash", "pwsh"]) {
    assert.ok(readOnlyDeny.includes(name), "只读角色必须拒绝 " + name);
    assert.equal(writeDeny.includes(name), false, "可写角色不应拒绝 " + name);
  }
  for (const name of ["report", "subagent", "send_message"]) {
    assert.ok(readOnlyDeny.includes(name), "只读角色必须拒绝 " + name);
    assert.ok(writeDeny.includes(name), "可写角色必须拒绝 " + name);
  }
  // PTC 的 run_code 是展示传输，不是可交给 tools.restrict() 的全局工具名；
  // 两种角色都必须把它排除在 deny 列表之外（既有契约）。
  assert.equal(readOnlyDeny.includes("run_code"), false);
  assert.equal(writeDeny.includes("run_code"), false);
  for (const name of ROOT_ONLY_TOOL_DENY) {
    assert.ok(readOnlyDeny.includes(name), "只读角色必须拒绝 " + name);
    assert.ok(writeDeny.includes(name), "可写角色必须拒绝 " + name);
  }
});

test("委派 deny 清单覆盖注册表的每个角色工具，只读 deny 覆盖全部委派限制", () => {
  for (const entry of listRoles()) {
    assert.ok(EXPERT_DELEGATION_DENY.includes(entry.toolName), "委派 deny 缺少角色工具 " + entry.toolName);
    assert.ok(EXPERT_DELEGATION_DENY.includes("subagent_" + entry.toolName), "委派 deny 缺少外层入口 subagent_" + entry.toolName);
    assert.ok(READONLY_DENY.includes(entry.toolName), "只读 deny 缺少角色工具 " + entry.toolName);
  }
  for (const name of EXPERT_DELEGATION_DENY) {
    assert.ok(READONLY_DENY.includes(name), "只读 deny 必须覆盖委派限制 " + name);
  }
});

test("未知角色在注册表与工具描述边界都 fail-closed", () => {
  for (const value of ["intruder", "", "EXPLORER", 42, null, undefined]) {
    assert.equal(getRole(value), undefined);
    assert.throws(() => requireRole(value), (error) => error.code === "UNKNOWN_ROLE");
    assert.throws(() => buildRoleToolDescription(value), (error) => error.code === "UNKNOWN_ROLE");
  }
});

test("角色工具描述携带注册表的显示名与职责摘要", () => {
  for (const entry of listRoles()) {
    const description = buildRoleToolDescription(entry.id);
    assert.ok(description.includes(entry.label), entry.id + " 必须包含注册表显示名");
    assert.ok(description.includes(entry.description), entry.id + " 必须包含注册表职责摘要");
  }
});

test("注册表职责摘要承担角色触发任务，工具门面与主代理提示词同源复用", () => {
  const prompts = buildOrchestratorPrompt({ roles: enabledIds({ enableObserver: true }) });
  const descriptionOf = (role) => buildRoleToolDescription(role);

  // fixer 摘要保留"单文件的大量工作"，且不得出现"仅限/只有多文件"这类限制词；
  // 但正常提及"多文件"（例如"单文件或多文件"）是合法描述，不在排除范围内。
  const fixerSummary = getRole("fixer").description;
  // 只排除"仅限/只有多文件"这类明确限制词；正常提及多文件（单文件或多文件）是合法描述。
  const ONLY_MULTI_FILE = /(?:仅|只|唯一|限定)[^。；，,]{0,6}多文件|多文件(?:才|仅|只|以外)|only multi-file|multi-file only/i;
  assert.match(fixerSummary, /单文件/, "fixer 摘要必须明确单文件的大量工作同样适合");
  assert.doesNotMatch(fixerSummary, ONLY_MULTI_FILE, "fixer 摘要不得把适用面限制为只有多文件");
  // 该排除规则本身必须有判别力：真正写死"仅限多文件/多文件以外都不做"的摘要会被它拦下。
  for (const onlyMultiFile of ["只做多文件改动，单文件不接。", "仅限多文件实现。", "多文件以外的实现不接。"]) {
    assert.match(onlyMultiFile, ONLY_MULTI_FILE, "排除规则必须能识别把适用面写死的摘要: " + onlyMultiFile);
  }
  for (const legitimate of [
    "已定方案的实现（单文件或多文件）与测试补齐。",
    "可实现单文件的大量工作，也可跨多文件。",
    "多文件与单文件实现均可。",
    "边界清晰的多文件实现与测试补齐：不做调研。",
  ]) {
    assert.doesNotMatch(legitimate, ONLY_MULTI_FILE, "排除规则不得误伤合法提及多文件的摘要: " + legitimate);
  }
  assert.match(fixerSummary, /可验证/, "fixer 摘要必须说明它产出可验证的结果");
  for (const role of enabledIds({ enableObserver: true })) {
    const description = descriptionOf(role);
    assert.ok(prompts.includes(getRole(role).description), role + " 的主提示词必须复用注册表摘要");
    assert.ok(description.includes(getRole(role).description), role + " 的工具门面必须复用注册表摘要");
  }
  // 职责摘要只说明角色承担什么，不复制 root workflow。
  for (const role of enabledIds({ enableObserver: true })) {
    assert.doesNotMatch(getRole(role).description, /after every role-tool batch returns|finalize/i, role + " 摘要不得复制 root workflow");
  }
});

test("派发说明按任务类型区分已定方向与待解问题", () => {
  // 实施任务才需要已定方向；只读与设计角色给待解问题与判断范围即可。
  const fixerDescription = buildRoleToolDescription("fixer");
  assert.match(fixerDescription, /任务信息：实施任务必须给已定方向/);
  for (const role of ["explorer", "librarian", "oracle", "designer"]) {
    assert.match(buildRoleToolDescription(role), /任务信息：[^。]*待解问题与判断范围/, role + " 派发说明必须允许只给待解问题");
    assert.doesNotMatch(buildRoleToolDescription(role), /实施任务必须给已定方向/, role + " 不得要求实施级方向");
  }
  // 任务信息形态来自注册表摘要：恰好出现一次，不额外追加第二份清单。
  for (const role of enabledIds({ enableObserver: true })) {
    assert.equal(getRole(role).description.split("任务信息：").length - 1, 1, role + " 摘要必须声明一次任务信息形态");
    assert.equal(buildRoleToolDescription(role).split("任务信息：").length - 1, 1, role + " 工具描述不得重复任务信息契约");
  }
  // 固定 admission 契约必须短而稳定：只声明五项派发要求，不复制 child 固定纪律。
  assert.match(ROLE_TOOL_ADMISSION_CONTRACT, /must be self-contained/);
  assert.match(ROLE_TOOL_ADMISSION_CONTRACT, /the workspace path, the allowed scope, the expected verification, and the affectedPaths/);
  assert.doesNotMatch(ROLE_TOOL_ADMISSION_CONTRACT, /任务信息：/, "任务信息契约不得改写固定 admission 纪律文本");
  assert.doesNotMatch(ROLE_TOOL_ADMISSION_CONTRACT, /send_message|leaf worker|assistant output/,
    "child 固定纪律不得被复制进 role tool description");
  assert.equal(fixerDescription.endsWith(ROLE_TOOL_ADMISSION_CONTRACT), true, "工具门面必须原样复用权威派发说明");
  assert.doesNotMatch(fixerDescription, /<Workflow>/, "派发说明不得复制 root workflow");
});

test("orchestrator 提示词覆盖每个启用角色且无重复或缺失", () => {
  assert.deepEqual(ORCHESTRATOR_ROLES, ALL_ROLE_IDS);

  const enabled = enabledIds({ enableObserver: true });
  const prompt = buildOrchestratorPrompt({ roles: enabled, providerReady: true });
  for (const id of enabled) {
    assert.equal(prompt.split("@" + id).length - 1, 1, id + " 必须恰好出现一次");
    assert.ok(prompt.includes(getRole(id).description), id + " 必须携带注册表职责摘要");
  }
  // fanout 是通用入口，provider 就绪时排在启用角色之后。
  assert.ok(prompt.includes("Available expert tools: " + [...enabled, "fanout"].join(", ") + "."));

  const withoutObserver = buildOrchestratorPrompt({ roles: enabledIds(), providerReady: true });
  assert.equal(withoutObserver.includes("@observer"), false);
  for (const id of enabledIds()) {
    assert.equal(withoutObserver.split("@" + id).length - 1, 1, id + " 必须恰好出现一次");
  }
});

test("shared 状态角色投影与注册表一致，未知角色不渲染", () => {
  assert.deepEqual(STATUS_ROLE_IDS, ALL_ROLE_IDS);
  assert.deepEqual(STATUS_ROLE_LABELS, roleStatusLabels({ enableObserver: true }));

  for (const entry of listRoles()) {
    assert.equal(STATUS_ROLE_LABELS[entry.id], entry.statusLabel);
    assert.equal(normalizeStatusRole(entry.id), entry.id);
    assert.equal(normalizeStatusRole(entry.statusLabel), entry.id);
    assert.equal(
      resolveRunningStatusText({ sessionId: "child", currentSessionId: "child", running: true, session: { parentId: "root" }, role: entry.id }),
      entry.statusLabel + " running",
    );
  }
  assert.equal(normalizeStatusRole("intruder"), undefined);
  assert.equal(normalizeStatusRole(null), undefined);
  assert.equal(
    resolveRunningStatusText({ sessionId: "child", currentSessionId: "child", running: true, session: { origin: "subagent" }, role: "intruder" }),
    null,
  );
});

test("可写角色不进入只读投影，注册表新增角色必须显式声明只读性", () => {
  for (const id of WRITE_ROLE_IDS) {
    assert.equal(getRole(id).readOnly, false);
    assert.equal(listReadOnlyRoles({ enableObserver: true }).some((entry) => entry.id === id), false);
  }
  assert.deepEqual(listReadOnlyRoles({ enableObserver: true }).map((entry) => entry.id), READ_ONLY_ROLE_IDS);
});

// ── 专家提示词契约：角色身份、默认 persona 与 admission 解析同源 ──────────────

/** 可编辑的默认专家专属 persona 与固定执行纪律必须分层，且六角色都非空。 */
test("默认专家 persona 与固定执行纪律分层，六角色都有可编辑默认值", () => {
  assert.deepEqual(Object.keys(DEFAULT_EXPERT_PERSONA).sort(), [...ALL_ROLE_IDS].sort());
  assert.equal(Object.isFrozen(DEFAULT_EXPERT_PERSONA), true, "默认 persona 表必须冻结");
  for (const id of ALL_ROLE_IDS) {
    const base = DEFAULT_EXPERT_PERSONA[id];
    assert.equal(typeof base, "string");
    assert.ok(base.trim().length > 0, id + " 必须有非空默认 persona");
    assert.equal(base.includes(FIXED_EXPERT_DISCIPLINE), false,
      id + " 的可编辑默认值不得包含固定执行纪律（否则恢复默认会把它复制进草稿）");
  }

  for (const id of ALL_ROLE_IDS) {
    const persona = resolveExpertPersona(id, undefined);
    assert.equal(persona, DEFAULT_EXPERT_PERSONA[id] + FIXED_EXPERT_DISCIPLINE, id + " 无覆盖时必须由默认值加固定纪律组成");
    assert.equal(persona.split(FIXED_EXPERT_DISCIPLINE).length - 1, 1, id + " 固定纪律必须恰好追加一次");

    const overridden = resolveExpertPersona(id, "自定义 " + id);
    assert.equal(overridden, "自定义 " + id + FIXED_EXPERT_DISCIPLINE, id + " 覆盖只能替换专家专属部分");
    assert.ok(overridden.includes(FIXED_EXPERT_DISCIPLINE), id + " 覆盖不得删除固定纪律");
  }
});

/** 空白覆盖等价于没有覆盖；未知角色 fail-closed，绝不回落到通用人格。 */
test("有效 persona 解析：空白覆盖回落默认，未知角色 fail-closed", () => {
  for (const blank of ["", "   ", "\n\t "]) {
    assert.equal(resolveExpertPersona("fixer", blank), DEFAULT_EXPERT_PERSONA.fixer + FIXED_EXPERT_DISCIPLINE,
      "空白覆盖必须等价于没有覆盖");
  }
  for (const invalid of ["", "intruder", "FIXER", 42, null, undefined, {}]) {
    assert.throws(() => resolveExpertPersona(invalid, "x"), (error) => error.code === "UNKNOWN_ROLE",
      "未知角色必须抛 UNKNOWN_ROLE: " + String(invalid));
  }
});

/** 模板字符必须原样保留：不做变量替换、不转义。 */
test("有效 persona 解析不做模板变量替换", () => {
  const raw = "{{task}} $HOME \${env:VAR} `code` 100%";
  const persona = resolveExpertPersona("designer", raw);
  assert.ok(persona.startsWith(raw), "用户文本必须原样出现在 persona 开头");
  assert.equal(persona, raw + FIXED_EXPERT_DISCIPLINE);
});

/** 提示词配置入口不受 Observer 启用开关影响（未启用也要能配置）。 */
test("提示词配置入口覆盖六个角色，与 Observer 是否启用无关", async () => {
  const enabled = appliedHost();
  const enabledMeta = await enabled.invokeConnection(RPC_ENDPOINT, { action: "meta", sessionId: "root-1" });
  assert.deepEqual(enabledMeta.value.rolePrompts.roles, ALL_ROLE_IDS);
  assert.deepEqual(enabledMeta.value.roles, enabledIds({ enableObserver: true }));
  await enabled.dispose();

  const disabled = appliedHost({ config: { enableOrchestrator: true, enableObserver: false } });
  // 目标会话只用注册表登记即可读取 meta：提示词配置是全局设置，不绑定 root 生命周期。
  disabled.registerRootAgent("root-off", { lifecycle: false });
  assert.equal(disabled.toolNames().includes("observer"), false, "关闭 Observer 时不得注册观察员工具");
  const disabledMeta = await disabled.invokeConnection(RPC_ENDPOINT, { action: "meta", sessionId: "root-off" });
  assert.equal(disabledMeta.value.roles.includes("observer"), false, "禁用角色的运行投影必须收缩");
  assert.deepEqual(disabledMeta.value.rolePrompts.roles, ALL_ROLE_IDS,
    "提示词配置入口不得按 active role 过滤：Observer 未启用时仍可配置");
  for (const entry of disabledMeta.value.rolePrompts.entries) {
    assert.equal(entry.defaultPersona, DEFAULT_EXPERT_PERSONA[entry.role], entry.role + " 默认值不得因禁用而缺失");
  }
  await disabled.dispose();
});
