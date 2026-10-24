/**
 * Browserless release gate：用真实 plugin.apply 注册面替代浏览器页面 smoke。
 *
 * 覆盖宿主与协议边界：工具/route/settings 注册、Connection 优先与 legacy fallback、
 * settings revision 提交、abort、fan-out 创建/取消/retry、图片 main-first 与 PNG durable
 * 副本、请求级数量限制，以及 dispose 幂等清理。页面实际渲染和浏览器注入不在本文件
 * 的能力范围内，不能由这些测试冒充验证。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPluginHost,
  flushAsyncWork,
  RPC_ENDPOINT,
  RPC_PATH,
} from "../test-support/plugin-host.mjs";

const ROLE_TOOLS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
const ROOT_TOOLS = ["dsh_expert_group_finalize", "dsh_expert_group_done", "dsh_expert_group_release_scope", "dsh_expert_group_abandon_wait"];
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function appliedHost(options = {}) {
  const host = createPluginHost({
    settings: { value: { defaults: { fixer: { provider: "mock", model: "mock" } } } },
    ...options,
  });
  host.apply();
  return host;
}

function imageItem(name = "draft.png") {
  return { type: "image", mediaType: "image/png", data: TINY_PNG, name };
}

function createAttachmentStore() {
  const saved = [];
  return {
    saved,
    async saveImage(input) {
      saved.push(input);
      return {
        attachmentId: "sha256:release-" + saved.length,
        mediaType: input.mediaType,
        name: input.name,
        bytes: input.data.byteLength,
      };
    },
    async readImage() {
      return undefined;
    },
  };
}

test("browserless release gate：注册、settings commit、Connection fallback、abort 与 dispose", async () => {
  const host = appliedHost();
  try {
    assert.deepEqual(host.toolNames().sort(), [...ROLE_TOOLS, "fanout", ...ROOT_TOOLS].sort());
    assert.equal(host.routes.has(RPC_PATH), true);
    assert.deepEqual(host.connectionChannels(), ["/dsh-expert-group"]);
    // 新契约：settings 不再注册 namespace；由 Config volatile 字段投影 + 关闭自动配置页。
    assert.equal(host.settingsAutoGenerate(), false, "必须关闭宿主自动配置页");
    assert.ok(host.listenerCount("settings/document-updated") >= 1);

    const root = host.registerRootAgent("release-root");
    const committed = await host.invokeConnection(RPC_ENDPOINT, {
      action: "commit",
      sessionId: root.id,
      scope: "session",
      changes: [{ role: "fixer", selection: { provider: "mock", model: "release-model" } }],
    });
    assert.equal(committed.ok, true);
    assert.equal(committed.value.overrides.fixer.model, "release-model");
    assert.equal(host.settingsSnapshot().revision, 0, "session override 不应修改全局 settings revision");
    assert.deepEqual(host.storage.entries("session_overrides"), [
      ["release-root", { fixer: { provider: "mock", model: "release-model" } }],
    ]);

    const settingsCommitted = await host.invokeConnection(RPC_ENDPOINT, {
      action: "settings-commit",
      settings: { ...host.settingsSnapshot().value, provider: "mock" },
      expectedRevision: 0,
    });
    assert.equal(settingsCommitted.ok, true);
    assert.equal(host.settingsSnapshot().revision, 1);

    // 旧通知工具已删除；root 终止状态改由 Host 权威快照提供。
    assert.equal(host.toolNames().includes("dsh_expert_group_notify"), false);
    const snapshot = await host.invokeConnection(RPC_ENDPOINT, {
      action: "notification-snapshot",
      sessionId: root.id,
    });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.value.snapshot, null, "没有终止事件时快照必须为空视图");

    const legacy = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
    assert.equal(legacy.status, 404);
    assert.equal(legacy.body.error.code, "connection-required");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await host.invokeConnection(RPC_ENDPOINT, {
      action: "commit",
      sessionId: root.id,
      scope: "session",
      changes: [{ role: "fixer", selection: { provider: "mock", model: "cancelled" } }],
    }, { signal: controller.signal });
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, "gateway/cancelled");
    // settings-commit 已把 revision 推到 1；被取消的提交不得再推进它。
    assert.equal(host.settingsSnapshot().revision, 1, "abort 不得触发 settings 写入");
  } finally {
    await host.dispose();
    await host.dispose();
  }
  assert.equal(host.routes.size, 0);
  assert.deepEqual(host.connectionChannels(), []);
  assert.deepEqual(host.toolNames(), []);
  assert.equal(host.listenerCount("settings/document-updated"), 0);
  assert.equal(host.storage.closeCount, 1);
});

test("browserless release gate：Connection 缺失时 legacy fallback 仍服务 meta", async () => {
  const host = appliedHost({ connection: "missing" });
  try {
    assert.deepEqual(host.connectionChannels(), []);
    const response = await host.invokeRoute(RPC_PATH, { body: { action: "meta" } });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
  } finally {
    await host.dispose();
  }
});

test("browserless release gate：fan-out 创建、取消、child 终态收敛与手工 retry", async () => {
  const requests = [];
  const childIds = [];
  const host = appliedHost({
    subagents: {
      startContinuable: async ({ request }) => {
        requests.push(request);
        const childId = "release-child-" + requests.length;
        childIds.push(childId);
        return { childId, messageId: "release-message-" + requests.length };
      },
    },
  });
  try {
    const root = host.registerRootAgent("fanout-release-root");
    const accepted = await host.toolDefinition("fanout").execute({
      role: "fixer",
      basePrompt: "browserless release gate",
      shards: [{ shardId: "release-shard", prompt: "执行 release gate" }],
    }, { agent: root, signal: new AbortController().signal, concludeTurn: () => {} });
    assert.equal(accepted.accepted, true);
    assert.deepEqual(accepted.shardIds, ["release-shard"]);
    await flushAsyncWork();
    assert.equal(requests.length, 1);

    const cancelled = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-cancel-shard",
      sessionId: root.id,
      parentTaskId: accepted.parentTaskId,
      shardId: "release-shard",
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.value.accepted, true);

    const childSession = { id: childIds[0], snapshotEvents: () => [] };
    host.emit("session/event", childSession, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "aborted" } },
    });
    await flushAsyncWork();
    const cancelledTask = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: root.id,
      parentTaskId: accepted.parentTaskId,
    });
    assert.equal(cancelledTask.ok, true);
    assert.equal(cancelledTask.value.task.shards[0].status, "cancelled");

    const retried = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-retry-shard",
      sessionId: root.id,
      parentTaskId: accepted.parentTaskId,
      shardId: "release-shard",
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.value.accepted, true);
    assert.equal(retried.value.task.shards[0].attempts.length, 2);
    await flushAsyncWork();
    assert.equal(requests.length, 2);
    const retriedTask = await host.invokeConnection(RPC_ENDPOINT, {
      action: "fanout-get",
      sessionId: root.id,
      parentTaskId: accepted.parentTaskId,
    });
    assert.equal(retriedTask.value.task.shards[0].status, "running");
  } finally {
    await host.dispose();
  }
});

test("browserless release gate：图片 main-first、PNG durable 副本与数量边界", async () => {
  const attachments = createAttachmentStore();
  const host = appliedHost({
    attachments,
    subagents: { startContinuable: async () => ({ childId: "image-release-child", messageId: "image-release-message" }) },
  });
  try {
    const root = host.registerRootAgent("image-release-root");
    const accepted = await host.invokeConnection(RPC_ENDPOINT, {
      action: "image-route",
      sessionId: root.id,
      text: "分析这张图片",
      images: [imageItem("release.png")],
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value.target, "main", "main 支持 image 时必须保持 main-first");
    assert.equal(attachments.saved.length, 1);
    assert.equal(attachments.saved[0].mediaType, "image/png");
    assert.equal(attachments.saved[0].name.endsWith(".png"), true);
    assert.ok(attachments.saved[0].data instanceof Uint8Array);

    const tooMany = await host.invokeConnection(RPC_ENDPOINT, {
      action: "image-route",
      sessionId: root.id,
      text: "数量边界",
      images: Array.from({ length: 17 }, (_, index) => imageItem("too-many-" + index + ".png")),
    });
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.code, "invalid-selection");
    assert.match(tooMany.error.message, /1-16/);
    assert.equal(attachments.saved.length, 1, "数量校验失败不得创建额外 durable 副本");
  } finally {
    await host.dispose();
  }
});

// 这个门禁使用 browserless Host/RPC seam；页面渲染、真实浏览器注入和用户登录仍需单独验证。

// ---------------------------------------------------------------------------
// 发布工程化门槛：release 命令串联、tgz 不入库（只认 git 受版本控制集合）、
// 版本同步脚本无 cwd 依赖。
//
// 本段**不执行** `pnpm release` 全链：链路里含 build（client bundle 产物在并发分片下可能暂时
// 滞后）与全量测试，测试内递归跑全量测试会造成嵌套与严重放大。因此这里只做两类检查：
// 对 package.json scripts 的静态断言，以及对 sync 脚本的临时目录沙箱验证。
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

function runNode(args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/**
 * 把 release 脚本按 npm 的串联分隔符（&& / ;）拆成步骤序列：断言顺序时必须按步骤比较，
 * 而不是在整串文本里找子串位置——否则 "… && pnpm run test" 这类步骤永远匹配不到。
 */
function releaseChain(script) {
  return script.split(/&&|;/).map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * 发布门禁的 .tgz 扫描策略：只认 git 受版本控制的文件集合（git 索引）。
 *
 * 为什么不再递归工作区：本地构建/发布目录（.scratch/、.market-submission/ 等）、依赖目录
 * 与并发测试创建的临时目录都位于仓库根的未跟踪区域，工作区递归会把它们误判成"构建产物入库"。
 * 真正危险的情况只有一个——打包产物被 git add -f 之类强行纳入版本控制，所以门禁只读索引：
 * 未跟踪与被忽略的文件天然不在集合内，不需要再维护第二条"按 gitignore 排除"的规则。
 */

/** 失败信息里必须解释的"被跳过范围"：让读者知道未跟踪/忽略目录为什么不参与。 */
const TGZ_SCOPE_NOTE = "未跟踪文件与被 .gitignore / .git/info/exclude 忽略的目录、文件不参与本检查"
  + "（如 .scratch/、.market-submission/、node_modules/、并发测试临时目录）；"
  + "只有被 git add -f 等操作强行纳入版本控制的 .tgz 才会命中。";

/**
 * 默认 git 执行器：以 root 为 cwd 执行只读 git 命令，返回原始 stdout（-z 输出需要 Buffer）。
 *
 * 启动失败（例如 PATH 里没有 git）必须 reject，由扫描函数转成显式门禁错误；
 * 绝不能把异常吞掉当成"没有发现 tgz"。执行器做成注入点，测试无需改 PATH 即可模拟该分支。
 */
function runGitDefault(root, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrChunks.push(chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({
      code,
      signal,
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    }));
  });
}

/**
 * 返回 root 下被 git 跟踪的 .tgz 相对路径（POSIX 风格，按 git 输出排序）。
 *
 * - root 参数化：门禁传仓库根，用例传临时 git 仓库，两侧共用同一实现；
 * - 路径规格用 :(icase) 保持旧实现的大小写不敏感语义（*.TGZ 同样命中）；
 * - 只读索引，因此"索引里有、工作区已删"的 tgz 仍算入库并会让门禁失败（符合票据语义）；
 * - git 不可用或非零退出一律显式抛错：fixtures 原则不允许依赖缺失时静默放行。
 */
async function findTrackedTarballs(root, { runGit = runGitDefault } = {}) {
  const args = ["ls-files", "-z", "--", ":(icase)*.tgz"];
  let result;
  try {
    result = await runGit(root, args);
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "找不到 git 可执行文件" : String(error?.message ?? error);
    throw new Error(
      "发布门禁无法扫描 git 受版本控制文件（扫描根：" + root + "）：" + reason + "。"
      + "本门禁必须基于 git 索引判断 .tgz 是否入库；git 不可用时必须显式失败，不得静默放行。",
      { cause: error },
    );
  }
  if (result.code !== 0) {
    const detail = String(result.stderr ?? "").trim();
    throw new Error(
      "发布门禁的 git 扫描失败（扫描根：" + root + "）：git " + args.join(" ")
      + " 退出码 " + result.code + (detail === "" ? "" : "：" + detail)
      + "。必须修复 git 环境后重跑，不得跳过 .tgz 检查。",
    );
  }
  const output = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout ?? "");
  return output
    .split("\0")
    .filter((entry) => entry !== "")
    // Windows 上 git 通常已输出 "/"，这里统一归一化，保证失败信息与跨平台断言一致。
    .map((entry) => entry.replaceAll("\\", "/"));
}

/**
 * 门禁失败信息：必须同时给出扫描根、被跳过的非受控范围（未跟踪/忽略不参与）与命中文件，
 * 否则读者无法判断该清理本地产物还是该从版本控制里移除 tgz。
 */
function formatTrackedTarballFailure(root, tarballs) {
  return [
    "发布门禁失败：git 受版本控制文件集合中出现了 .tgz 打包产物。",
    "扫描根：" + root,
    "跳过范围：" + TGZ_SCOPE_NOTE,
    "命中文件：",
    ...tarballs.map((file) => "  - " + file),
  ].join("\n");
}

/**
 * 测试夹具专用的 git 写操作：仅用于临时仓库（init/add），绝不指向当前工作区仓库。
 * 依赖缺失（git 不在 PATH）时直接断言失败，不 skip——与门禁本身"显式失败"的约定一致。
 */
async function runGitOrThrow(root, args) {
  const result = await runGitDefault(root, args);
  assert.equal(result.code, 0, "git " + args.join(" ") + " 必须成功：" + result.stderr);
  return result;
}

/** 最小但真实的 lockfile importer 片段：sync 脚本的一致性检查作用于含 dsh-* specifier 的文本。 */
function lockfileContent(specifier) {
  return "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    peerDependencies:\n"
    + "      '@deepseek-ai/dsh-tools':\n        specifier: " + specifier + "\n        version: 0.1.5-rc.1\n";
}

/**
 * sync 脚本沙箱：把真实的 scripts/sync-dsh-version.mjs 复制进临时仓库副本（连同合法的
 * package.json），让它按自身位置解析仓库根。绝不触碰工作区里的真实 package.json。
 * 返回副本根目录。
 */
async function createSyncSandbox(root, { dshPeerRange = "^0.0.1" } = {}) {
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(repoRoot, "scripts", "sync-dsh-version.mjs"), join(root, "scripts", "sync-dsh-version.mjs"));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "release-gate-sync-fixture",
    version: "9.9.9",
    type: "module",
    peerDependencies: {
      // 默认就是「脚本尚未同步过」的初始值；个别探针需要「已被默认值路径写过」的初始状态时显式覆盖。
      "@deepseek-ai/dsh-tools": dshPeerRange,
      "react": "^18.2.0",
    },
  }, null, 2) + "\n", "utf8");
  return root;
}

// ---------------------------------------------------------------------------
// 发布工程化门槛的装载期并行预热
//
// 下面四条用例的真实执行（git / node 子进程）彼此独立：每条只依赖自己的临时目录，或只读
// 仓库的 git 索引，没有任何先后顺序。Windows 上每次 spawn 固定要 90–100ms，串行叠加就是
// 这份套件最贵的固定延迟（约 1.1s），而这段时间测试进程只是在等子进程。
//
// 所以在模块装载期（用例开始执行之前）就把它们并发启动：用例仍然执行全部真实 git / node
// 调用、仍然断言同一批结果、失败分类照旧；改变的只是「等待被重叠起来」，绝没有用缓存结果
// 或替身替代任何一次真实执行——每个探针依然是一个独立进程，真的读写自己的临时仓库。
//
// 每条预热 promise 都挂了 catch(() => {})：拒绝只在用例里 await 时抛出，不会在用例开始前
// 变成未处理拒绝；临时目录另外注册 exit 兜底清理，即使用例被 --test-name-pattern 过滤掉、
// finally 没执行，也不会在系统临时目录里留下垃圾。
// ---------------------------------------------------------------------------

/** 临时目录兜底清理：正常路径由用例 finally 删除，这里只兜住「用例未执行」的形状。 */
function cleanupOnExit(directory) {
  process.once("exit", () => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* 退出期无法清理（句柄仍被占用等）时静默：不能因此影响测试结论。 */
    }
  });
}

/**
 * 仓库根的 .tgz 只读扫描：只读 git 索引、不依赖任何用例状态，因此装载期取一次即可。
 * 真实执行仍然只有一次，失败（git 缺失、非零退出）照旧在用例里以同一错误浮现。
 */
function startTrackedTarballsAtRepoRoot() {
  const scan = findTrackedTarballs(repoRoot);
  scan.catch(() => {});
  return scan;
}

/**
 * tgz 扫描范围夹具：临时仓库 + 「未跟踪 / 被忽略」与「add -f 强制入库」两侧的真实扫描结果。
 *
 * 目录建立、git init、写文件、git add、两次 findTrackedTarballs 全是真实调用，只是提前到
 * 装载期执行；两侧顺序（先干净、再 add -f、后命中）与串行版本逐字一致。
 */
function startTrackedTarballScopeFixture() {
  const fixture = (async () => {
    const directory = await mkdtemp(join(tmpdir(), "deg-tgz-scope-"));
    cleanupOnExit(directory);
    const sandbox = join(directory, "repo");
    await mkdir(sandbox, { recursive: true });
    // 临时仓库只需要表达"索引里的文件 = 受版本控制"：git init + add 即可，无需 commit，
    // 因而也不依赖 user.name/user.email 等本机身份配置。
    await runGitOrThrow(sandbox, ["init", "-q"]);

    // 两个非受控面：build/ 是纯未跟踪目录，.scratch/ 被 .gitignore 忽略（复刻真实仓库场景）。
    await mkdir(join(sandbox, "build"), { recursive: true });
    await mkdir(join(sandbox, ".scratch"), { recursive: true });
    await writeFile(join(sandbox, ".gitignore"), ".scratch/\n", "utf8");
    await writeFile(join(sandbox, "README.md"), "# tgz scope fixture\n", "utf8");
    await writeFile(join(sandbox, "build", "pkg-0.1.7.tgz"), "not really a tarball\n", "utf8");
    await writeFile(join(sandbox, ".scratch", "pkg-0.1.7.tgz"), "not really a tarball\n", "utf8");
    // 先让索引里有普通受控文件，保证"扫描为空"不是因为索引整体为空。
    await runGitOrThrow(sandbox, ["add", "README.md", ".gitignore"]);

    // 一侧：未跟踪与被忽略的 tgz 都不参与，门禁通过。
    const clean = await findTrackedTarballs(sandbox);
    // 另一侧：同一个被忽略的 tgz 被强制入库后必须命中；未被 add 的 build/ 产物仍不参与。
    await runGitOrThrow(sandbox, ["add", "-f", ".scratch/pkg-0.1.7.tgz"]);
    const forced = await findTrackedTarballs(sandbox);
    return { directory, sandbox, clean, forced };
  })();
  fixture.catch(() => {});
  return fixture;
}

/**
 * 「sync 脚本无 cwd 依赖」夹具：三条探针各自一个沙箱，真实 CLI 调用并发执行。
 *
 * 每条探针只读自己的 package.json / lockfile，因此不必靠「上一条写好的状态」串行传递；
 * 初始状态刻意与串行版本完全一致：
 * - versioned：初始 peerDep ^0.0.1 + lockfile 已同步到目标版本（显式版本参数）；
 * - defaulted：同上的初始状态（不带参数，必须回退脚本内置默认值）；
 * - invalid：初始 peerDep 已是 >=默认目标值（串行版本走到这一步时，package.json 已被默认值
 *   路径写过），非法参数被拒绝后必须原样保留。
 */
function startSyncCwdFixture() {
  const fixture = (async () => {
    // 静态守卫要读脚本源文本：只读一次，三条探针与断言共用同一份。
    const source = await readFile(join(repoRoot, "scripts", "sync-dsh-version.mjs"), "utf8");
    const targetVersion = "0.9.9-rc.1";
    const defaultTarget = /const DEFAULT_DSH_VERSION = ['"]([^'"]+)['"]/.exec(source)[1];
    const directory = await mkdtemp(join(tmpdir(), "deg-sync-cwd-"));
    cleanupOnExit(directory);
    // 沙箱仓库与"调用方目录"刻意分家：脚本必须写入沙箱副本的 package.json，
    // 写入调用方目录（或被 cwd 影响）都会让下面的断言失败。
    const callerDir = join(directory, "elsewhere");
    await mkdir(callerDir, { recursive: true });

    const versionedSandbox = await createSyncSandbox(join(directory, "versioned"));
    const defaultedSandbox = await createSyncSandbox(join(directory, "defaulted"));
    const invalidSandbox = await createSyncSandbox(join(directory, "invalid"), {
      dshPeerRange: ">=" + defaultTarget,
    });
    // lockfile 夹具必须用同步脚本真正写入的下界形式：caret 会被其保守逻辑判成过期（此处虽只断言退出码）。
    const syncedLockfile = lockfileContent(">=" + targetVersion);
    await writeFile(join(versionedSandbox, "pnpm-lock.yaml"), syncedLockfile, "utf8");
    await writeFile(join(defaultedSandbox, "pnpm-lock.yaml"), syncedLockfile, "utf8");

    const syncScriptOf = (sandbox) => join(sandbox, "scripts", "sync-dsh-version.mjs");
    const readPackageJson = async (sandbox) => JSON.parse(await readFile(join(sandbox, "package.json"), "utf8"));
    const [versioned, noArgument, invalid] = await Promise.all([
      runNode([syncScriptOf(versionedSandbox), targetVersion], callerDir)
        .then(async (run) => ({ run, updated: await readPackageJson(versionedSandbox) })),
      runNode([syncScriptOf(defaultedSandbox)], callerDir)
        .then(async (run) => ({ run, defaulted: await readPackageJson(defaultedSandbox) })),
      runNode([syncScriptOf(invalidSandbox), "not-a-version"], callerDir)
        .then(async (run) => ({ run, afterInvalid: await readPackageJson(invalidSandbox) })),
    ]);
    const callerDirEntries = await readdir(callerDir);
    return { source, targetVersion, defaultTarget, versioned, noArgument, invalid, callerDirEntries };
  })();
  fixture.catch(() => {});
  return fixture;
}

/**
 * lockfile 提示夹具：三个初始 lockfile 状态（过期 / 已同步 / 缺失）各用一个沙箱，真实 CLI
 * 调用并发执行；每条探针只读自己的沙箱，因此互相之间没有顺序依赖。
 */
function startSyncLockfileFixture() {
  const fixture = (async () => {
    const directory = await mkdtemp(join(tmpdir(), "deg-sync-lockfile-"));
    cleanupOnExit(directory);
    const callerDir = join(directory, "elsewhere");
    await mkdir(callerDir, { recursive: true });
    const targetVersion = "0.9.9-rc.2";

    const staleSandbox = await createSyncSandbox(join(directory, "stale"));
    const syncedSandbox = await createSyncSandbox(join(directory, "synced"));
    const missingSandbox = await createSyncSandbox(join(directory, "missing"));
    // 反向探针一：lockfile 仍钉着旧 specifier。
    const staleLockfile = lockfileContent("^0.0.1");
    await writeFile(join(staleSandbox, "pnpm-lock.yaml"), staleLockfile, "utf8");
    // 反向探针二：lockfile 已与新目标一致。夹具必须写同步脚本真正落盘的 `>=` 下界：
    // 写成 caret 会被保守逻辑判成过期而误报重建。
    await writeFile(join(syncedSandbox, "pnpm-lock.yaml"), lockfileContent(">=" + targetVersion), "utf8");
    // 反向探针三：missing 沙箱刻意不写 lockfile —— 缺失即「无法判定」，必须按需要重建处理。

    const syncScriptOf = (sandbox) => join(sandbox, "scripts", "sync-dsh-version.mjs");
    const [stale, synced, missing] = await Promise.all([
      runNode([syncScriptOf(staleSandbox), targetVersion], callerDir)
        .then(async (run) => ({ run, lockfileAfter: await readFile(join(staleSandbox, "pnpm-lock.yaml"), "utf8") })),
      runNode([syncScriptOf(syncedSandbox), targetVersion], callerDir),
      runNode([syncScriptOf(missingSandbox), targetVersion], callerDir),
    ]);
    return { targetVersion, stale, synced, missing };
  })();
  fixture.catch(() => {});
  return fixture;
}

// 预热在模块装载期启动；用例体内的 await 只等待结果，不改变任何断言。
// 之所以放在装载期而不是各用例内部：5 次串行 git 与 6 次 node CLI 的等待因此彼此重叠，
// 而每条预热仍然只执行一次真实调用（没有替身、没有缓存结果）。
const trackedTarballScopeFixture = startTrackedTarballScopeFixture();
let trackedTarballsAtRepoRootPromise = null;
/** 仓库根只读扫描（真实执行只有一次）：错开一个宏任务再启动，别和 tgz 链抢第一次 spawn。 */
function trackedTarballsAtRepoRoot() {
  trackedTarballsAtRepoRootPromise ??= new Promise((resolve) => {
    setImmediate(() => resolve(startTrackedTarballsAtRepoRoot()));
  });
  return trackedTarballsAtRepoRootPromise;
}
let syncCwdFixture = null;
let syncLockfileFixture = null;
/** 幂等启动两条版本同步脚本预热；单跑某条用例（--test-name-pattern）时同样能拿到。 */
function startSyncFixtures() {
  syncCwdFixture ??= startSyncCwdFixture();
  syncLockfileFixture ??= startSyncLockfileFixture();
  return { cwd: syncCwdFixture, lockfile: syncLockfileFixture };
}
setImmediate(() => { startSyncFixtures(); });

test("release 命令静态串联：sync → build → test → 发布门槛检查", async () => {
  const scripts = packageJson.scripts ?? {};
  assert.ok(scripts.release, "package.json 必须提供聚合 release 命令");
  assert.ok(scripts.build, "release 链依赖的 build 脚本必须存在");
  assert.ok(scripts.test, "release 链依赖的 test 脚本必须存在");

  const chain = releaseChain(scripts.release);
  const indexOf = (pattern) => chain.findIndex((step) => pattern.test(step));

  // 顺序断言（而不是"包含"）：任一步骤被挪位或删除都必须让门槛失败。
  const syncIndex = indexOf(/sync-dsh-version\.mjs/);
  const buildIndex = indexOf(/build/);
  const testIndex = indexOf(/\btest\b/);
  const gateIndex = indexOf(/release-gate/);
  assert.ok(syncIndex >= 0, "release 必须以版本同步（sync-dsh-version.mjs）开头: " + scripts.release);
  assert.ok(buildIndex > syncIndex, "release 必须在版本同步之后执行构建: " + scripts.release);
  assert.ok(testIndex > buildIndex, "release 必须在构建之后执行全量测试: " + scripts.release);
  assert.ok(gateIndex > testIndex, "release 必须在测试之后执行发布门槛检查: " + scripts.release);

  // release 不再硬编码 DSH 版本：目标版本由 sync 脚本的内置默认值（唯一维护点）提供，
  // 发布链因此不会在宿主升级后把 peer range 钉回旧 minor。这里钉住两件事：
  // 1）release 步骤只调用脚本本身，不带任何写死的版本实参；
  // 2）脚本内置默认值与当前 dsh-* peer 版本线一致。
  const syncStep = chain[syncIndex];
  assert.match(syncStep, /sync-dsh-version\.mjs/, "release 必须在第一步同步 DSH 版本: " + syncStep);
  assert.doesNotMatch(syncStep, /sync-dsh-version\.mjs\s+\S+/, "release 不得硬编码 DSH 目标版本: " + syncStep);

  // 同步目标必须仍是仓库当前使用的 DSH 宿主版本线之一：插件版本（packageJson.version）
  // 与 DSH 版本相互独立，因此不能断言两者相等；但 release 的目标一旦没跟着宿主升级一起更新，
  // 就会把 peer range 钉到不存在的版本上——这里用现有 peer 声明兜住这一漂移。
  const scriptSource = await readFile(join(repoRoot, "scripts", "sync-dsh-version.mjs"), "utf8");
  const defaultTarget = /const DEFAULT_DSH_VERSION = ['"]([^'"]+)['"]/.exec(scriptSource);
  assert.ok(defaultTarget, "sync 脚本必须以内置默认值提供目标版本（release 不再传参）: " + scriptSource.slice(0, 200));
  const targetVersion = defaultTarget[1];
  assert.match(targetVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "sync 默认目标版本必须是 semver: " + targetVersion);
  const dshVersions = Object.entries(packageJson.peerDependencies ?? {})
    .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
    // peer range 现统一为下界（floor）形式 `>=<version>`：剥离前缀后只留纯版本；caret/tilde 仅作兼容保留。
    .map(([, range]) => range.replace(/^(?:[\^~]|>=)/, ""));
  assert.ok(dshVersions.includes(targetVersion),
    "sync 的默认目标版本（" + targetVersion + "）不在当前 dsh-* peer 版本线内（"
    + [...new Set(dshVersions)].join(", ") + "）：宿主升级后请同步更新 sync 脚本的默认值");

  // 发布门槛步骤必须覆盖两个发布面测试文件；test 的 glob 已经包含它们，所以门槛脚本不被
  // release 重复执行，门禁的独立条目只声明"门槛范围"。允许门槛步骤直接执行测试文件或委托给
  // release-gate 脚本，因此这里对"步骤 + 被委托脚本定义"合并后的文本断言，而不是钉死写法。
  assert.ok(scripts["release-gate"], "package.json 必须提供独立的 release-gate 门槛脚本");
  const gateText = [chain[gateIndex], scripts["release-gate"]].join(" ");
  assert.ok(/\brelease-gate\b/.test(gateText), "门槛步骤必须运行 release-gate 门槛（测试文件或脚本）: " + gateText);
  assert.match(gateText, /release-gate\.test\.mjs/, "门槛必须包含 release-gate.test.mjs: " + gateText);
  assert.match(gateText, /package-portability\.test\.mjs/, "门槛必须包含 package-portability.test.mjs: " + gateText);
});

test("构建产物 tgz 不入库：受版本控制文件集合中不存在 .tgz，且 ignore 规则覆盖", async () => {
  // 门禁只认 git 索引：.scratch/pkg-0.1.7.tgz 这类未跟踪产物不再让门禁变红；
  // 被 git add -f 强行入库的 .tgz 仍会命中（两侧行为由后续临时仓库用例钉住）。
  // 装载期已并发启动的只读扫描（真实执行只有一次，git 缺失/非零退出照旧在这里抛错）。
  const tarballs = await trackedTarballsAtRepoRoot();
  assert.deepEqual(tarballs, [], formatTrackedTarballFailure(repoRoot, tarballs));

  const gitignore = await readFile(join(repoRoot, ".gitignore"), "utf8");
  const patterns = gitignore.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.ok(patterns.some((pattern) => pattern === "*.tgz" || pattern === "*.TGZ" || pattern === "**/*.tgz"),
    "dsh-expert-group/.gitignore 必须包含 *.tgz 规则");
});

test("tgz 门禁只认受版本控制集合：未跟踪/被忽略的产物通过，git add -f 后失败", async () => {
  // 临时仓库、git init/add、两侧扫描都是真实调用，只是已在装载期并发跑完（见上文预热说明）；
  // 装载期失败时目录由 exit 兜底清理，这里直接以夹具的原始错误失败。
  const { directory, sandbox, clean, forced } = await trackedTarballScopeFixture;
  try {
    // 一侧：未跟踪与被忽略的 tgz 都不参与，门禁通过。
    assert.deepEqual(clean, [], formatTrackedTarballFailure(sandbox, clean));

    // 另一侧：同一个被忽略的 tgz 被强制入库后必须命中；未被 add 的 build/ 产物仍不参与。
    assert.deepEqual(forced, [".scratch/pkg-0.1.7.tgz"],
      "被 git add -f 纳入版本控制的 .tgz 必须被扫描到");

    const message = formatTrackedTarballFailure(sandbox, forced);
    assert.ok(message.includes(sandbox), "失败信息必须包含扫描根: " + message);
    assert.match(message, /未跟踪/, "失败信息必须说明未跟踪文件不参与: " + message);
    assert.match(message, /忽略/, "失败信息必须说明被忽略范围不参与: " + message);
    assert.ok(message.includes(".scratch/pkg-0.1.7.tgz"), "失败信息必须列出命中文件: " + message);
    assert.equal(message.includes("build/pkg-0.1.7.tgz"), false,
      "未跟踪目录中的 .tgz 不得出现在失败信息里: " + message);

    // 直接复刻门禁的最终断言：同一断言在 add -f 前通过，之后必须失败——这就是"两侧"的落点。
    assert.throws(
      () => assert.deepEqual(forced, [], formatTrackedTarballFailure(sandbox, forced)),
      /.scratch\/pkg-0\.1\.7\.tgz/,
      "被强制纳入版本控制的 .tgz 必须让门禁的最终断言失败",
    );
  } finally {
    // 临时仓库在系统临时目录内，测试结束必须清理；Windows 上 git 可能短暂占用句柄，故带重试。
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("git 不可用时发布门禁显式失败：不静默放行 .tgz 检查", async () => {
  // 通过注入执行器模拟 ENOENT：比改 PATH 更确定，也不会影响同进程内其它 git 调用。
  const commands = [];
  await assert.rejects(
    () => findTrackedTarballs(repoRoot, {
      runGit: async (root, args) => {
        commands.push({ root, args });
        const error = new Error("spawn git ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    }),
    (error) => {
      assert.match(error.message, /git/, "git 缺失错误必须提到 git: " + error.message);
      assert.match(error.message, /找不到 git 可执行文件/, "必须给出 git 缺失原因: " + error.message);
      assert.ok(error.message.includes(repoRoot), "git 缺失错误必须包含扫描根: " + error.message);
      return true;
    },
  );
  assert.equal(commands.length, 1);
  assert.equal(commands[0].root, repoRoot);
  assert.deepEqual(commands[0].args, ["ls-files", "-z", "--", ":(icase)*.tgz"],
    "扫描必须基于 git 索引，而不是工作区递归");

  // 非零退出（例如扫描根不是 git 工作树）同样必须显式失败，并带上 git 的 stderr 便于定位。
  await assert.rejects(
    () => findTrackedTarballs(repoRoot, {
      runGit: async () => ({
        code: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git",
      }),
    }),
    (error) => {
      assert.match(error.message, /退出码 128/, "必须报告 git 退出码: " + error.message);
      assert.match(error.message, /not a git repository/, "必须透传 git stderr: " + error.message);
      assert.ok(error.message.includes(repoRoot), "git 失败错误必须包含扫描根: " + error.message);
      return true;
    },
  );
});

test("版本同步脚本无 cwd 依赖：从任意工作目录调用都作用于脚本自身所在仓库", async () => {
  // 三条真实 CLI 探针（显式版本 / 无参数 / 非法版本）已在装载期并发执行完，各自一个沙箱；
  // 这里断言同一批结果：每条探针仍是真的子进程，真的跑 scripts/sync-dsh-version.mjs。
  const fixture = await startSyncFixtures().cwd;
  const { source, targetVersion, defaultTarget } = fixture;

  // 静态守卫：源文本必须钉住"从模块自身位置定位仓库根"，并且不出现 cwd 语义。
  // 用 /\s*\.\s*cwd\b/ 这种按字符分隔的写法，避免把「不依赖 cwd」这类说明性注释误判成违规。
  assert.match(source, /import\.meta\.url/, "sync 脚本必须以 import.meta.url 定位仓库根");
  assert.doesNotMatch(source, /process\s*\.\s*cwd\b/, "sync 脚本不得依赖当前工作目录");
  assert.doesNotMatch(source, /['"]\.\/package\.json['"]/, "sync 脚本不得用相对路径定位 package.json");

  const versioned = fixture.versioned.run;
  assert.equal(versioned.code, 0, "从任意 cwd 调用 sync 必须成功: " + versioned.stderr.trim());

  const updated = fixture.versioned.updated;
  assert.equal(updated.peerDependencies["@deepseek-ai/dsh-tools"], ">=" + targetVersion,
    "sync 必须更新脚本自身所在仓库的 package.json");
  assert.equal(updated.peerDependencies.react, "^18.2.0",
    "sync 只能改 @deepseek-ai/dsh-* 版本，非 dsh 依赖必须原样保留");
  assert.equal(fixture.callerDirEntries.length, 0, "调用方目录不得被写入任何文件");

  // 省略版本参数时必须回退到脚本内置默认值（而不是报错），这样 release 链不需要
  // 硬编码 DSH 版本；同时默认值必须真的写进 package.json。
  const noArgument = fixture.noArgument.run;
  assert.equal(noArgument.code, 0, "缺少版本参数必须回退内置默认值而不是报错: " + noArgument.stderr.trim());
  const defaulted = fixture.noArgument.defaulted;
  assert.equal(defaulted.peerDependencies["@deepseek-ai/dsh-tools"], ">=" + defaultTarget,
    "无参数调用必须写入内置默认版本");
  assert.equal(defaulted.peerDependencies.react, "^18.2.0",
    "默认值路径同样只能改 @deepseek-ai/dsh-* 版本");

  // 非法版本（显式给出但不是 semver）仍必须非零退出，避免把坏值写进 peer range。
  const invalid = fixture.invalid.run;
  assert.equal(invalid.code, 1, "非法版本参数必须非零退出: " + invalid.stdout);
  assert.match(invalid.stderr, /semver/);
  const afterInvalid = fixture.invalid.afterInvalid;
  assert.equal(afterInvalid.peerDependencies["@deepseek-ai/dsh-tools"], ">=" + defaultTarget,
    "非法版本被拒绝时不得改动 package.json");
});

test("版本同步脚本的 lockfile 提示：过期时明确要求重建，已同步时保持静默", async () => {
  // 三个初始 lockfile 状态（过期 / 已同步 / 缺失）各用一个沙箱，真实 CLI 调用已在装载期并发
  // 执行完；断言仍是「过期要提示、已同步要静默、缺失按过期处理」这三条反向探针。
  const fixture = await startSyncFixtures().lockfile;

  // 反向探针一：lockfile 仍钉着旧 specifier —— 必须提示、且必须说清"不自动改写"。
  const stale = fixture.stale.run;
  assert.equal(stale.code, 0, "lockfile 过期不是致命错误: " + stale.stderr.trim());
  assert.match(stale.stdout, /pnpm-lock\.yaml/, "过期提示必须指明 pnpm-lock.yaml: " + stale.stdout);
  assert.match(stale.stdout, /pnpm install/, "过期提示必须给出 pnpm install 重建指引: " + stale.stdout);
  assert.match(stale.stdout, /不会自动改写|不自动改写|由包管理器重建/,
    "过期提示必须说明 lockfile 不自动改写: " + stale.stdout);
  assert.equal(fixture.stale.lockfileAfter, lockfileContent("^0.0.1"),
    "sync 不得改动 lockfile，只提示");

  // 反向探针二：lockfile 已与新目标一致 —— 不得误报需要重建。
  // 夹具写的是同步脚本真正落盘的 `>=` 下界：写成 caret 会被保守逻辑判成过期而误报重建。
  const synced = fixture.synced;
  assert.equal(synced.code, 0, "lockfile 已同步时必须成功退出: " + synced.stderr.trim());
  assert.doesNotMatch(synced.stdout, /pnpm install --lockfile-only/,
    "lockfile 已同步时不得提示重建: " + synced.stdout);

  // 反向探针三：lockfile 缺失 —— 无法判定时按"需要重建"处理，不得静默走过。
  const missing = fixture.missing;
  assert.equal(missing.code, 0, "缺少 lockfile 不改变退出码: " + missing.stderr.trim());
  assert.match(missing.stdout, /pnpm install --lockfile-only/,
    "缺少 lockfile 时必须提示重建（无法判定按过期处理）: " + missing.stdout);
});
