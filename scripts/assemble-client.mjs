#!/usr/bin/env node
/**
 * 发布 client bundle 的确定性装配（构建边界）。
 *
 * 背景：DSH 的客户端模块图只加载 package exports["./client"] 指向的**一个 classic
 * bundle**，浏览器 classic script 又不支持 `import`/`export`，所以 freshness/RPC 的
 * ESM 权威实现（client-freshness.js）不能直接出现在发布产物里，必须由本脚本在构建期
 * 投影成 classic 片段。
 *
 * 本脚本是唯一的构建边界，做三件事：
 * 1. **生成**：把 client-freshness.js 投影成 classic 片段（去掉行首 `export ` 前缀 +
 *    追加"检查点 + ModuleLoader 登记"尾部），排在唯一 descriptor 之前执行。投影不改写
 *    任何函数体，遇到无法识别的 ESM 语法直接抛错，绝不产出"半投影"。
 * 2. **门禁**：校验发布 bundle 的装载契约（投影位置、登记语句、client.js 的转发 seam、
 *    descriptor 里不得再有第二份实现）与 classic script 语法（用 Script 目标编译一次，
 *    浏览器就是按这个目标解析它的）。
 * 3. **行为核对**：把刚生成的投影片段放进最小 global 替身真实执行一次，用同一份一致性
 *    脚本（`probeFreshnessFace`）逐项比对 RPC envelope、错误映射、取消、session 切换、
 *    revision 与 dispose 的行为；漂移会让 `pnpm build` 直接失败，而不是留到运行期。
 *
 * ## client.js 内联 freshness 回退的评估结论（2026-10 审核 · ticket 13）
 *
 * client.js 曾经内联一份与 client-freshness.js 同语义的 fallback（函数体约 12KB），
 * 投影存在之后它只剩"宿主没有该模块"这一条路径。评估结论：**在最低宿主契约下不需要，
 * 已删除**，理由与收益：
 *
 * 1. **契约**：package.json peerDependencies 下限是 `@deepseek-ai/dsh-client-modules`
 *    `^0.2.0-rc.1`，README 声明的目标运行时同为 `0.2.0-rc.1`；宿主只加载
 *    exports["./client"] 指向的装配产物，而该产物恒含本脚本生成的投影片段，且投影排在
 *    唯一 descriptor 之前执行，因此 `require("dsh-expert-group/client-freshness")`
 *    必然命中同一张模块表——fallback 在生产路径上不可达。
 * 2. **服务对象**：只有"直载 client.js"这一契约外用法会走到 fallback（client.js 只是
 *    装配输入，没有任何宿主会单独 serve 它）；包内测试替身
 *    （test-support/client-bundle.mjs）本来就登记同一份共享实现。
 * 3. **风险取舍**：唯一真实风险是"投影缺失时静默降级成另一套实现"——那正是双份代码
 *    各自漂移的来源。因此 client.js 改成 fail-closed 的转发壳：共享模块缺失直接抛
 *    `freshness 共享模块未装载`，由门禁（DESCRIPTOR_SEAM_MARKERS）与行为核对兜住。
 * 4. **收益**：client.js 及其内联于 bundle 的副本各减约 10KB（安装面不再双份），
 *    freshness 行为仍由唯一实现 + 构建期行为核对 + test/client-shared-boundary.test.mjs
 *    共同守住。
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

/**
 * 浏览器安全的 classic IIFE 源，按数组顺序执行。
 * 这些片段各自把实现挂到 `globalThis[Symbol.for("dsh-expert-group/<name>")]`，
 * client.js 的 factory 只从那里取回实现，因此必须排在唯一 descriptor 之前。
 */
const IIFE_SOURCES = Object.freeze([
  "client-expert-group-model.js",
  "client-expert-group-sidebar.js",
  // 通知协调模块必须与其它浏览器安全 IIFE 一起先于唯一 descriptor 执行：
  // client.js 的 factory 只从 globalThis 取回这份实现，不再自带通知队列/轮询逻辑。
  "client-notifications.js",
  // 「模型配置」区域的唯一纯数据流实现（provider 目录装配、草稿/路径操作、
  // 七档 reasoningEfforts 映射、继承/恢复默认、revision 冲突与角色联动守卫）。
  // 同样先于 descriptor 执行：client.js 只从 globalThis 取回它并负责渲染。
  "client-model-config.js",
]);

/**
 * freshness/RPC 的 ESM 权威实现。构建期投影成 classic 片段，让真实发布 bundle 也通过
 * ModuleLoader seam 装载共享实现；必须排在唯一 descriptor 之前，登记才来得及生效。
 */
const FRESHNESS_SOURCE = "client-freshness.js";

/** 唯一 ModuleLoader descriptor（client.js）始终最后执行，避免 HMR 留下重复子模块工厂。 */
const DESCRIPTOR_SOURCE = "client.js";

const sourceNames = Object.freeze([...IIFE_SOURCES, FRESHNESS_SOURCE, DESCRIPTOR_SOURCE]);
const outputName = "client-bundle.js";
const banner = "/* 此文件由 scripts/assemble-client.mjs 生成，请勿手工编辑。 */\n";

/** 字符串形式的投影尾部语句：生成与校验共用同一份常量，避免两边写法漂移。 */
const CHECKPOINT_STATEMENT = "global[Symbol.for(CLIENT_FRESHNESS_GLOBAL_KEY)] = __DEG_CLIENT_FRESHNESS_DESCRIPTOR__.factory();";
const REGISTER_STATEMENT = "registerClientFreshnessModule(global.__ModuleLoader__);";

/**
 * 投影必须保留的顶层导出：客户端装载路径依赖它们，缺一个就说明权威实现改了契约。
 * （descriptor 与登记函数是投影尾部直接引用的名字，模块 id / 检查点键是相邻契约。）
 */
const REQUIRED_FRESHNESS_EXPORTS = Object.freeze([
  "CLIENT_FRESHNESS_MODULE_ID",
  "CLIENT_FRESHNESS_GLOBAL_KEY",
  "__DEG_CLIENT_FRESHNESS_DESCRIPTOR__",
  "registerClientFreshnessModule",
]);

/**
 * 与 client-freshness.js 的 CLIENT_FRESHNESS_MODULE_ID 导出值一致的模块表 id：
 * descriptor 的 require 契约与投影的登记 id 都必须是它（两处都由此常量门禁）。
 */
const FRESHNESS_MODULE_ID = "dsh-expert-group/client-freshness";

/**
 * client.js 必须保留的转发 seam 标记：共享实现只存在于 client-freshness.js，
 * 客户端只许转发。标记消失说明装载路径被改坏（例如有人又写回内联实现或删掉
 * fail-closed 分支），构建必须直接失败。
 */
const DESCRIPTOR_SEAM_MARKERS = Object.freeze([
  "function requireFreshnessSurface() {",
  // fail-closed 文案：共享模块缺失时必须显式抛错，绝不退回第二份实现。
  "freshness 共享模块未装载",
]);

/**
 * descriptor 里禁止再次出现的 freshness 实现声明（内联副本已随 ticket 13 删除）。
 * 匹配"声明"而不是裸名字，避免注释里提到历史函数名就误报。
 */
const FORBIDDEN_INLINE_DECLARATIONS = Object.freeze([
  "function createInlineFreshnessBoundary(",
  "async function readSettingsCommitOutcomeInline(",
]);

/** 与 client.js / client-freshness.js 发布值一致的 RPC 路由常量（行为核对脚本注入用）。 */
const RPC_TARGET = Object.freeze({
  path: "/api/dsh-expert-group",
  channel: "/dsh-expert-group",
  endpoint: "rpc",
});

/** 行为核对脚本的兜底草稿归一：真实调用方注入角色表相关实现，这里只需要同一份恒等函数。 */
const identityDraft = (value) => value;

/**
 * 把 ESM 权威实现投影成 classic 片段。
 *
 * 只做逐行的机械改写：行首 `export ` 前缀去掉，其余字节保持不变。任何其它 ESM 语法
 * （`export default`、`export {}`、`import ...`）都无法在 classic script 里表达，
 * 直接抛错让构建失败，而不是产出一个宿主解析不了、只会静默回落 fallback 的 bundle。
 *
 * @param {string} source - client-freshness.js 的源码文本。
 * @returns {{ body: string, exports: readonly string[] }}
 */
export function projectClientFreshnessSource(source) {
  const exported = [];
  const lines = [];
  for (const line of source.split("\n")) {
    if (!line.startsWith("export ")) {
      lines.push(line);
      continue;
    }
    const declaration = line.slice("export ".length);
    exported.push(declaredNameOf(declaration));
    lines.push(declaration);
  }
  const body = lines.join("\n");
  // 注释/字符串里出现 import/export 不算违规，所以按"行首 ESM 关键字"判定。
  const leftover = /(?:^|\n)[ \t]*(?:import|export)\b/.exec(body);
  if (leftover !== null) {
    throw new Error("client-freshness.js 投影后仍残留 ESM 语法: " + leftover[0].trim());
  }
  for (const name of REQUIRED_FRESHNESS_EXPORTS) {
    if (!exported.includes(name)) {
      throw new Error("client-freshness.js 缺少必需导出 " + name + "（client.js 的装载路径依赖它）");
    }
  }
  return Object.freeze({ body, exports: Object.freeze(exported) });
}

/** 从 `const X = ...` / `async function X(...)` 这类声明文本里取出声明的名字。 */
function declaredNameOf(declaration) {
  const match = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(declaration);
  if (match === null) throw new Error("无法解析导出声明，请改用可投影的导出形式: " + declaration.trim());
  return match[1];
}

/**
 * 渲染 freshness 的 classic 投影片段。
 *
 * 尾部两条语句是发布 bundle 的真实装载路径：
 * - 检查点：把同一份导出面挂到 globalThis 的公开 Symbol，测试与相邻片段据此证明
 *   "真实 bundle 里跑的就是权威实现"，而不是 client.js 的内联副本；
 * - 登记：`registerClientFreshnessModule` 内部按加载器实例幂等（DSH 的 register 对重复
 *   id 是抛错语义），因此 HMR 只失效主插件 id 后重新执行同一份 bundle 不会打断装载。
 *
 * @param {{ name: string, source: string }} options
 */
export function renderClientFreshnessSegment({ name, source }) {
  const projection = projectClientFreshnessSource(source);
  return [
    "/* source: " + name + " */",
    "/* classic 投影：来自源文件的机械导出改写，权威实现仍是 " + name + "。 */",
    "(function installClientFreshness(global) {",
    '"use strict";',
    projection.body.trimEnd(),
    "",
    "/** 投影尾部（构建期生成）：公开检查点 + ModuleLoader 登记。 */",
    CHECKPOINT_STATEMENT,
    REGISTER_STATEMENT,
    "})(globalThis);",
    "",
  ].join("\n");
}

/** 把值收敛成可 JSON 比较的快照：undefined / 函数 / 循环引用换成显式标记，对象键排序。 */
function freezeForCompare(value, seen = new WeakSet()) {
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "function") return { $type: "function" };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { $type: "cycle" };
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => freezeForCompare(item, seen));
  const snapshot = {};
  for (const key of Object.keys(value).sort()) snapshot[key] = freezeForCompare(value[key], seen);
  return snapshot;
}

/** 收敛抛出的错误：只保留可比较的字段（message/name/code/status/currentRevision）。 */
function describeError(error) {
  return {
    name: typeof error?.name === "string" ? error.name : null,
    message: typeof error?.message === "string" ? error.message : null,
    code: error?.code ?? null,
    status: error?.status ?? null,
    currentRevision: error?.currentRevision ?? null,
  };
}

/** 收敛 AbortSignal：只记录是否已被取消，不把宿主对象带进比较。 */
function describeSignal(signal) {
  return { aborted: signal?.aborted === true };
}

/** 收敛 fetch-like 响应：ok / status / body；json() 抛错时记录错误而不是让脚本中断。 */
async function describeResponse(response) {
  if (response === null || typeof response !== "object") return { $type: "invalid-response", value: String(response) };
  let body;
  try {
    body = await response.json();
  } catch (error) {
    body = { $invalidJson: describeError(error) };
  }
  return { ok: response.ok === true, status: response.status, body: freezeForCompare(body) };
}

/** 收敛 Connection rpc.call 的实参：channel/endpoint/request/signal 与实参个数。 */
function describeChannelCall(args) {
  return {
    channel: args[0],
    endpoint: args[1],
    request: args[2],
    signal: describeSignal(args[3]),
    argumentCount: args.length,
  };
}

/** 收敛 legacy fetch 的实参：url 与 init 的关键字段（含 signal 透传）。 */
function describeFetchCall(url, init) {
  return {
    url,
    method: init?.method,
    credentials: init?.credentials,
    headers: init?.headers,
    body: init?.body,
    signal: describeSignal(init?.signal),
  };
}

/**
 * freshness 面的一致性脚本（构建门禁与测试共用的唯一实现）。
 *
 * 用固定输入依次驱动一个"实现面"上的公共入口，并把每步结果收敛成可 JSON 比较的快照：
 * RPC envelope 归一、错误 code 映射、取消（AbortSignal 透传与错误传播）、
 * session 切换、revision/cursor 单调性、dispose 后的迟到响应。
 * 脚本不读写外部状态、不使用时间与随机数，因此同一实现在任何一次运行里的日志逐字节相同。
 *
 * @param {object} face - 至少提供 rpcErrorStatus / normalizePluginRpcResult / requestPluginRpc /
 *   createClientFreshnessBoundary / readSettingsCommitOutcome。
 * @returns {Promise<Array<{ label: string, value: unknown }>>}
 */
export async function probeFreshnessFace(face) {
  const log = [];
  const record = (label, value) => { log.push({ label, value: freezeForCompare(value) }); };
  const recordRun = async (label, run) => {
    try {
      record(label, { resolved: await run() });
    } catch (error) {
      record(label, { rejected: describeError(error) });
    }
  };

  // ── 1. 错误 code → status 映射 ─────────────────────────────────────────────
  const codes = ["settings-conflict", "session-not-found", "not-found", "forbidden", "connection-required", "gateway/cancelled", "bad-request", "internal", "", undefined];
  record("error-status-map", codes.map((code) => [String(code), face.rpcErrorStatus({ code })]));
  record("error-status-map:no-error", face.rpcErrorStatus());

  // ── 2. Connection envelope 归一（两条传输的错误字段必须一致）───────────────
  const envelopes = [
    { ok: true, value: { ok: true, settings: { provider: "p" }, revision: 3 } },
    { ok: false, error: { code: "settings-conflict", message: "冲突", details: { revision: 4 } } },
    { ok: false, error: { code: "gateway/cancelled", message: "已取消" }, status: 499 },
    { ok: false, error: { code: "unknown-code", message: "未知" } },
    { ok: true },
    {},
  ];
  for (const [index, envelope] of envelopes.entries()) {
    await recordRun("envelope#" + index, async () => await describeResponse(face.normalizePluginRpcResult(envelope)));
  }

  // ── 3. requestPluginRpc：Connection channel / legacy fetch / 取消 ──────────
  const channelCalls = [];
  const channelConnection = {
    rpc: {
      async call(...args) {
        channelCalls.push(describeChannelCall(args));
        return envelopes[0];
      },
    },
  };
  const controller = new AbortController();
  await recordRun("request:channel", async () => await describeResponse(
    await face.requestPluginRpc(channelConnection, { action: "meta" }, { signal: controller.signal }, null, RPC_TARGET),
  ));
  record("request:channel-calls", channelCalls);

  const fetchCalls = [];
  const legacyFetch = async (url, init) => {
    fetchCalls.push(describeFetchCall(url, init));
    return { ok: false, status: 409, async json() { return { ok: false, error: { code: "settings-conflict" } }; } };
  };
  await recordRun("request:legacy-fetch", async () => await describeResponse(
    await face.requestPluginRpc(undefined, { action: "meta" }, { signal: controller.signal }, legacyFetch, RPC_TARGET),
  ));
  record("request:legacy-fetch-calls", fetchCalls);

  // 没有 fetch 实现（旧宿主且没有 Connection）时必须抛出明确错误；显式传 null 避免
  // 落到默认实现上真的发请求。
  await recordRun("request:no-transport", async () => await face.requestPluginRpc(undefined, { action: "meta" }, {}, null, RPC_TARGET));

  // 取消：传输层 reject 必须原样传播，不能被包成 envelope 或吞掉。
  const cancelController = new AbortController();
  const cancellingConnection = {
    rpc: {
      async call() {
        cancelController.abort();
        const error = new Error("已取消");
        error.name = "AbortError";
        error.code = "gateway/cancelled";
        throw error;
      },
    },
  };
  await recordRun("request:cancel-rejects", async () => await describeResponse(
    await face.requestPluginRpc(cancellingConnection, { action: "meta" }, { signal: cancelController.signal }, null, RPC_TARGET),
  ));

  // ── 4. freshness boundary：session / revision / cursor / dispose ───────────
  const updates = [];
  const boundary = face.createClientFreshnessBoundary({
    sessionId: "root-1",
    onUpdate: (state) => updates.push({ kind: state.kind, state: state.state }),
  });
  record("boundary:initial", boundary.snapshot());

  const settingsFirst = boundary.beginRequest("settings", "global");
  const settingsLatest = boundary.beginRequest("settings", "global");
  record("settings:latest", boundary.acceptSettingsSnapshot({ revision: 2, value: { provider: "new" }, requestToken: settingsLatest }));
  record("settings:superseded", boundary.acceptSettingsSnapshot({ revision: 3, value: { provider: "stale" }, requestToken: settingsFirst }));
  record("settings:older-revision", boundary.acceptSettingsSnapshot({ revision: 1, value: { provider: "older" } }));
  record("settings:duplicate", boundary.acceptSettingsSnapshot({ revision: 2, value: { provider: "new" } }));
  record("settings:invalid-revision", boundary.acceptSettingsSnapshot({ revision: 1.5, value: { provider: "fraction" } }));
  record("settings:is-current", [
    boundary.isCurrent(settingsLatest),
    boundary.isCurrent(settingsFirst),
    boundary.isCurrent(undefined),
    boundary.isCurrent(42),
  ]);

  const catalogFirst = boundary.beginRequest("catalog", "global");
  const catalogLatest = boundary.beginRequest("catalog", "global");
  record("catalog:latest", boundary.acceptCatalogResponse({ generation: 2, groups: [{ id: "new" }], requestToken: catalogLatest }));
  record("catalog:superseded", boundary.acceptCatalogResponse({ generation: 3, groups: [{ id: "stale" }], requestToken: catalogFirst }));
  record("catalog:older-generation", boundary.acceptCatalogResponse({ generation: 1, groups: [{ id: "older" }] }));
  record("catalog:value-overrides-groups", boundary.acceptCatalogResponse({ generation: 3, value: { groups: [{ id: "explicit" }] } }));

  const fanoutFirst = boundary.beginRequest("fanout", "root-1");
  record("fanout:first", boundary.acceptFanoutSnapshot({ sessionId: "root-1", generation: 1, cursor: 5, snapshot: { tasks: ["new"] }, requestToken: fanoutFirst }));
  const fanoutEvents = boundary.beginRequest("fanout", "root-1");
  record("fanout:events-newer", boundary.acceptFanoutEvents({ sessionId: "root-1", generation: 2, cursor: 6, events: ["event"], requestToken: fanoutEvents }));
  const fanoutStale = boundary.beginRequest("fanout", "root-1");
  record("fanout:older-cursor", boundary.acceptFanoutSnapshot({ sessionId: "root-1", generation: 2, cursor: 4, snapshot: { tasks: ["old"] }, requestToken: fanoutStale }));
  const fanoutInvalid = boundary.beginRequest("fanout", "root-1");
  record("fanout:invalid-generation", boundary.acceptFanoutSnapshot({ sessionId: "root-1", generation: -1, cursor: 7, requestToken: fanoutInvalid }));
  record("fanout:action-fresh", boundary.acceptFanoutAction({ sessionId: "root-1", generation: 2, requestToken: boundary.beginRequest("fanout-action", "root-1") }));
  record("fanout:action-stale-generation", boundary.acceptFanoutAction({ sessionId: "root-1", generation: 1, requestToken: boundary.beginRequest("fanout-action", "root-1") }));
  record("fanout:action-stale-session", boundary.acceptFanoutAction({ sessionId: "root-2", generation: 2, requestToken: boundary.beginRequest("fanout-action", "root-2") }));

  // session 切换：旧 session 的迟到响应一律拒绝，且新 session 的游标从零重新开始。
  const lateToken = boundary.beginRequest("fanout", "root-1");
  record("session:switch", boundary.beginSession("root-2"));
  record("session:late-old-session", boundary.acceptFanoutSnapshot({ sessionId: "root-1", generation: 9, cursor: 99, snapshot: { tasks: ["late"] }, requestToken: lateToken }));
  record("session:is-session-current", [boundary.isSessionCurrent(lateToken), boundary.isCurrent(lateToken)]);
  record("session:new-session-fresh", boundary.acceptFanoutSnapshot({ sessionId: "root-2", generation: 0, cursor: 0, snapshot: { tasks: [] }, requestToken: boundary.beginRequest("fanout", "root-2") }));
  record("session:snapshot", boundary.snapshot());

  // dispose：所有迟到响应一律拒绝，且不再通知订阅者。
  record("dispose", boundary.dispose());
  record("dispose:again", boundary.dispose());
  const disposedToken = boundary.beginRequest("settings", "global");
  record("disposed:begin-request", disposedToken);
  record("disposed:accept", boundary.acceptSettingsSnapshot({ revision: 9, value: { provider: "late" }, requestToken: disposedToken }));
  record("disposed:accept-without-token", boundary.acceptSettingsSnapshot({ revision: 9, value: { provider: "late" } }));
  record("disposed:snapshot", boundary.snapshot());
  record("boundary:updates", updates);

  // ── 5. settings 提交响应解析（冲突 revision 兼容三种回传位置）───────────────
  const commitResponses = {
    accepted: { ok: true, status: 200, async json() { return { ok: true, settings: { provider: "p" }, revision: 8 }; } },
    acceptedArraySettings: { ok: true, status: 200, async json() { return { ok: true, settings: [], revision: 8 }; } },
    acceptedMissingRevision: { ok: true, status: 200, async json() { return { ok: true, settings: { provider: "p" } }; } },
    conflictDetailsRevision: { ok: false, status: 409, async json() { return { ok: false, error: { code: "settings-conflict", message: "冲突", details: { revision: 4 } } }; } },
    conflictCurrentRevision: { ok: false, status: 409, async json() { return { ok: false, error: { code: "settings-conflict", message: "冲突", details: { currentRevision: 5 } } }; } },
    conflictPayloadRevision: { ok: false, status: 409, async json() { return { ok: false, error: { code: "settings-conflict", message: "冲突" }, revision: 6 }; } },
    conflictBare: { ok: false, status: 409, async json() { return { ok: false, error: { code: "settings-conflict", message: "冲突" } }; } },
    conflictTopLevelMessage: { ok: false, status: 500, async json() { return { ok: false, message: "保存失败" }; } },
    invalidJson: { ok: false, status: 500, async json() { throw new Error("响应不是 JSON"); } },
    notOkWithoutError: { ok: false, status: 500, async json() { return { ok: true, settings: { provider: "p" }, revision: 8 }; } },
  };
  for (const [name, response] of Object.entries(commitResponses)) {
    await recordRun("commit-outcome:" + name, async () => await face.readSettingsCommitOutcome(response, identityDraft, ["fixer"]));
  }

  return log;
}

/**
 * 比较两份一致性日志，返回逐项差异；空数组表示零漂移。
 * 长度或标签不一致同样视为漂移（脚本步骤被增删也是行为契约变化）。
 */
export function diffFreshnessLogs(left, right) {
  const differences = [];
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry === undefined || rightEntry === undefined) {
      differences.push({ label: (leftEntry ?? rightEntry)?.label ?? "#" + index, left: leftEntry ?? null, right: rightEntry ?? null });
      continue;
    }
    if (leftEntry.label !== rightEntry.label
      || JSON.stringify(leftEntry.value) !== JSON.stringify(rightEntry.value)) {
      differences.push({ label: leftEntry.label, left: leftEntry.value, right: rightEntry.value });
    }
  }
  return differences;
}

/**
 * 构建期投影行为核对：把刚生成的 classic 投影片段放进最小 global 替身里真实执行一次，
 * 再用一致性脚本与 ESM 权威实现逐项比对。
 *
 * 核对三件事，任何一件不成立都让 `pnpm build` 直接失败：
 * 1. 投影尾部真的把导出面落到 `globalThis[Symbol.for(CLIENT_FRESHNESS_GLOBAL_KEY)]`；
 * 2. 投影尾部真的通过 `__ModuleLoader__.load` 登记了契约 id（替身加载器捕获回执）；
 * 3. 检查点取到的实现面与登记 descriptor 的 factory 是同一份导出，且与权威实现零漂移。
 *
 * @param {{ segment: string, freshnessModule?: object }} options - segment 是
 *   renderClientFreshnessSegment 的产物；freshnessModule 仅供测试注入替身。
 * @returns {Promise<{ steps: number, moduleId: string }>}
 */
export async function verifyFreshnessProjection({ segment, freshnessModule } = {}) {
  if (typeof segment !== "string" || segment.length === 0) throw new Error("缺少待核对的 classic 投影片段");
  const authority = freshnessModule ?? await import("../client-freshness.js");
  const moduleId = authority.CLIENT_FRESHNESS_MODULE_ID;
  // 门禁里的 client.js 字面量与权威实现的导出必须一致，否则 require 契约已经断了。
  if (moduleId !== FRESHNESS_MODULE_ID) {
    throw new Error("client-freshness.js 的模块 id 与装配契约不一致: " + JSON.stringify(moduleId));
  }
  const projected = evaluateFreshnessSegment(segment, { globalKey: authority.CLIENT_FRESHNESS_GLOBAL_KEY, moduleId });
  const authorityLog = await probeFreshnessFace(authority);
  const projectedLog = await probeFreshnessFace(projected.face);
  const differences = diffFreshnessLogs(authorityLog, projectedLog);
  if (differences.length > 0) {
    const detail = differences.slice(0, 5).map((diff) => {
      return "- " + diff.label + "\n  权威: " + JSON.stringify(diff.left) + "\n  投影: " + JSON.stringify(diff.right);
    }).join("\n");
    throw new Error("freshness classic 投影与权威实现已漂移（共 " + differences.length + " 项）:\n" + detail);
  }
  return Object.freeze({ steps: authorityLog.length, moduleId });
}

/**
 * 在最小 global 替身里执行投影片段，返回检查点导出面与登记回执。
 *
 * 用参数遮蔽 `globalThis`：片段收尾是 `})(globalThis)`，被遮蔽后检查点赋值与
 * client-freshness.js 的"已登记加载器"记账都落在替身上，既不污染构建进程的全局，
 * 也不影响真实装载。替身加载器只实现 DSH 的 `load({ id, factory })` 契约。
 *
 * @param {string} segment - classic 投影片段文本。
 * @param {{ globalKey: string, moduleId: string }} contract - 检查点 Symbol 键与期望登记 id。
 */
function evaluateFreshnessSegment(segment, { globalKey, moduleId }) {
  if (typeof globalKey !== "string" || globalKey.length === 0) {
    throw new Error("权威实现未导出 CLIENT_FRESHNESS_GLOBAL_KEY，无法定位投影检查点");
  }
  const registrations = [];
  const sandboxGlobal = {
    __ModuleLoader__: { load: (registration) => { registrations.push(registration); } },
  };
  // 只执行刚生成的片段本身；返回替身以便在宿主 realm 里读取 Symbol 检查点。
  const run = new Function("globalThis", segment + "\nreturn globalThis;");
  const executed = run(sandboxGlobal);
  const face = executed[Symbol.for(globalKey)];
  if (face === null || typeof face !== "object") {
    throw new Error("投影片段未落地 freshness 检查点（globalThis Symbol 上没有导出面）");
  }
  if (registrations.length !== 1 || registrations[0]?.id !== moduleId) {
    throw new Error("投影片段的 ModuleLoader 登记尾部未按契约执行（期望 " + moduleId
      + "，实际 " + JSON.stringify(registrations.map((registration) => registration?.id)) + "）");
  }
  // 登记出去的就是 client.js 的 require 契约：descriptor.factory() 必须给出同一份导出面。
  const registeredFace = registrations[0].factory();
  if (Object.isFrozen(registeredFace) !== true || registeredFace.createClientFreshnessBoundary !== face.createClientFreshnessBoundary) {
    throw new Error("投影片段的检查点与登记 descriptor 不是同一份导出面");
  }
  return { face, descriptor: registrations[0] };
}

/**
 * 发布 bundle 的装载契约门禁：投影位置、登记语句、client.js 的转发 seam，以及
 * "descriptor 段里不得再有第二份 freshness 实现"。
 * seam 一旦变化（不再 require 该模块、或又写回内联实现），行为核对与客户端测试都必须同步，
 * 因此这里让构建直接失败，而不是悄悄退化成"两份实现各自漂移"。
 */
function verifyClientBundleContract(content) {
  const freshnessIndex = content.indexOf("/* source: " + FRESHNESS_SOURCE + " */");
  const descriptorIndex = content.indexOf("/* source: " + DESCRIPTOR_SOURCE + " */");
  if (freshnessIndex === -1) throw new Error("发布 bundle 缺少 " + FRESHNESS_SOURCE + " 的 classic 投影段");
  if (descriptorIndex === -1) throw new Error("发布 bundle 缺少 " + DESCRIPTOR_SOURCE + " 的 descriptor 段");
  if (freshnessIndex > descriptorIndex) throw new Error("freshness 投影必须在唯一 ModuleLoader descriptor 之前执行");
  for (const statement of [CHECKPOINT_STATEMENT, REGISTER_STATEMENT]) {
    if (!content.includes(statement)) throw new Error("freshness 投影缺少装载语句: " + statement);
  }
  const descriptorMarkers = [
    "const FRESHNESS_MODULE_ID = " + JSON.stringify(FRESHNESS_MODULE_ID) + ";",
    "freshnessModule.registerClientFreshnessModule(globalThis.__ModuleLoader__);",
    "const RPC_CHANNEL = " + JSON.stringify(RPC_TARGET.channel) + ";",
    ...DESCRIPTOR_SEAM_MARKERS,
  ];
  const descriptorContent = content.slice(descriptorIndex);
  for (const marker of descriptorMarkers) {
    if (!descriptorContent.includes(marker)) {
      throw new Error("client.js 的 freshness 装载 seam 已变化，请同步投影与行为核对: " + marker);
    }
  }
  for (const declaration of FORBIDDEN_INLINE_DECLARATIONS) {
    if (descriptorContent.includes(declaration)) {
      throw new Error("client.js 又出现了 freshness 内联实现 " + declaration
        + "（唯一实现在 client-freshness.js，客户端只许转发；双份实现会让安装体积翻倍并重新引入漂移）");
    }
  }
}

/** classic script 语法门禁：浏览器按 Script 目标解析发布 bundle，残留 ESM 语法必须在这里失败。 */
function verifyClassicScript(content) {
  try {
    // 只编译不执行：整段内容是"注册 + 工厂定义"，编译即可暴露解析期问题。
    new Function(content);
  } catch (error) {
    throw new Error("发布 bundle 不是合法的 classic script（疑似残留 ESM 语法）: " + error.message);
  }
}

/**
 * 确定性装配发布 bundle。
 *
 * @param {{ write?: boolean }} [options] - write=false 时只计算结果（测试与一致性校验使用）。
 */
export async function assembleClientBundle({ write = true } = {}) {
  const sources = await Promise.all(sourceNames.map(async (name) => ({
    name,
    content: await readFile(join(root, name), "utf8"),
  })));
  const segments = sources.map(({ name, content }) => {
    if (name === FRESHNESS_SOURCE) return renderClientFreshnessSegment({ name, source: content });
    return "/* source: " + name + " */\n" + content.trimEnd() + "\n";
  });
  const content = banner + segments.join("\n");
  verifyClientBundleContract(content);
  verifyClassicScript(content);
  // 行为核对直接用刚生成的那一段（而不是重新渲染），确保校验对象就是要写盘的内容。
  const freshnessSegment = segments[sources.findIndex(({ name }) => name === FRESHNESS_SOURCE)];
  const projection = await verifyFreshnessProjection({ segment: freshnessSegment });
  const outputPath = join(root, outputName);
  if (write) await writeFile(outputPath, content, "utf8");
  return Object.freeze({
    outputPath,
    sourceNames,
    content,
    // 行为核对步数是"投影与权威实现逐项一致"的证据，构建日志与测试都据此断言。
    freshnessProbeSteps: projection.steps,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const result = await assembleClientBundle();
  console.log("Generated " + result.outputPath + " from " + result.sourceNames.length + " sources; freshness 投影行为核对 "
    + result.freshnessProbeSteps + " 步零漂移。");
}
