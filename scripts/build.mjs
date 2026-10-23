#!/usr/bin/env node
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_SIZE_BASELINE,
  BUNDLE_SIZE_LIMITS,
  assertBundleSizeGate,
  assembleClientBundle,
  measureBundleSizes,
} from "./assemble-client.mjs";
// 装配源清单已提取为无副作用的共享模块（R0）：门禁脚本必须与构建共用同一份清单，
// 而 import build.mjs 会执行真实构建，所以清单单独成模块、两边共同导入。
// 原先记录在这里的"为什么不发布也要检查"的背景说明，随清单一起移到了 client-sources.mjs。
// R0 票据 03 起，构建不再直接读 client-sources.mjs：四语义清单（manifest）里的
// `syntaxCheckSources` 就取那份冻结数组，构建与其它消费者共用同一个入口。
import { syntaxCheckSources } from "./client-source-manifest.mjs";

/** 构建脚本自身：不发布进 tarball，但每次构建都被执行，必须保持语法有效。 */
const BUILD_SCRIPT_FILES = Object.freeze([
  "scripts/assemble-client.mjs",
  "scripts/build.mjs",
  "scripts/measure-bundle.mjs",
]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// client-bundle.js 是发布入口；先从独立源文件确定性生成，再执行发布面和语法门禁。
const assembled = await assembleClientBundle();

// ── 体积门禁（ticket 17）────────────────────────────────────────────────────
// 每次构建都把三个数值打出来；未压缩/gzip 是硬门槛，brotli 只做参考。
// 复测命令：node scripts/measure-bundle.mjs（读 checked-in 产物，压缩参数与门禁一致）。
// 装配器不再内建体积测量（它被测试反复调用，brotli q11 每次约 850ms）；构建这里显式测一次。
const bundleSizes = measureBundleSizes(assembled.content);
console.log("client bundle 体积：raw=" + bundleSizes.raw + "B（上限 " + BUNDLE_SIZE_LIMITS.raw + "B）"
  + " / gzip=" + bundleSizes.gzip + "B（上限 " + BUNDLE_SIZE_LIMITS.gzip + "B）"
  + " / brotli=" + bundleSizes.brotli + "B（仅参考）");
console.log("体积基线 v" + BUNDLE_SIZE_BASELINE.version + "：raw=" + BUNDLE_SIZE_BASELINE.raw
  + "B / gzip=" + BUNDLE_SIZE_BASELINE.gzip + "B；整行注释剥离 " + assembled.stripStats.removedLines
  + " 行，" + assembled.stripStats.originalBytes + "B → " + assembled.stripStats.strippedBytes + "B；"
  + "代码区空白压缩（行首缩进 " + assembled.stripStats.removedIndentCharacters + " 字符 / 纯空白行 "
  + assembled.stripStats.removedBlankLines + " 行 / token 边界 " + assembled.stripStats.removedTokenSpaces
  + " 字符）→ " + assembled.stripStats.compactedBytes + "B");
console.log("体积复测命令：node scripts/measure-bundle.mjs");
assertBundleSizeGate(bundleSizes);

const packagePath = join(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));

function addTarget(targets, value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(label + " 必须是非空字符串");
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(label + " 不能指向包目录外部: " + value);
  }
  targets.add(normalized);
}

function addExportTargets(targets, value, label) {
  if (typeof value === "string") {
    addTarget(targets, value, label);
    return;
  }
  if (value === null || typeof value !== "object") throw new Error(label + " 的 export 目标无效");
  for (const [condition, nested] of Object.entries(value)) addExportTargets(targets, nested, label + "." + condition);
}

const targets = new Set();
for (const file of packageJson.files ?? []) addTarget(targets, file, "files");
for (const [name, target] of Object.entries(packageJson.exports ?? {})) addExportTargets(targets, target, "exports[" + name + "]");
for (const [name, target] of Object.entries(packageJson.bin ?? {})) addTarget(targets, target, "bin[" + name + "]");

const sourceTargets = [];
/** 已排入语法检查的绝对路径：发布目标与显式清单可能重叠（client-freshness.js），只查一次。 */
const syntaxChecked = new Set();
for (const target of [...targets].sort()) {
  const absolute = resolve(root, target);
  const backToRoot = relative(root, absolute);
  if (backToRoot === ".." || backToRoot.startsWith(".." + "\\") || backToRoot.startsWith(".." + "/") || isAbsolute(backToRoot)) {
    throw new Error("解析后的发布路径越界: " + target);
  }
  await access(absolute, constants.R_OK);
  if (/\.(?:js|mjs|cjs)$/i.test(target) && !syntaxChecked.has(absolute)) {
    syntaxChecked.add(absolute);
    sourceTargets.push(absolute);
  }
}
// 不发布、但参与构建的输入（装配源 + 构建脚本）同样要过 node --check：
// files 收敛后语法覆盖面必须靠显式清单保持，而不是靠"碰巧还被发布"。
for (const extra of [...syntaxCheckSources, ...BUILD_SCRIPT_FILES]) {
  const absolute = resolve(root, extra);
  await access(absolute, constants.R_OK);
  if (syntaxChecked.has(absolute)) continue;
  syntaxChecked.add(absolute);
  sourceTargets.push(absolute);
}

for (const source of sourceTargets) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--check", source], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error("语法检查失败: " + source + (signal ? " (" + signal + ")" : "")));
    });
  });
}

// ── bin 入口 smoke ─────────────────────────────────────────────────────────
// "文件存在 + node --check 通过"发现不了 bin 入口损坏（导出缺失、参数解析回归、
// sidecar 写入失败），所以构建本身也要真实执行一次 Prompt Inspector CLI。
// 夹具形状与 test/package-portability.test.mjs 的同类 smoke 保持一致；临时输入与
// 临时输出都来自 node:os tmpdir 的 mkdtemp，不依赖固定个人路径，结束即清理。
const CLI_SMOKE_EVENT = JSON.stringify({
  type: "request/header",
  id: "build-smoke-session",
  data: { header: { system: "可移植发布门禁 prompt🙂" } },
});

async function smokePromptInspectorCli() {
  const binTarget = packageJson.bin?.["prompt-inspector"];
  if (typeof binTarget !== "string" || binTarget.length === 0) {
    throw new Error("package.json 缺少 bin[prompt-inspector]，无法执行 CLI smoke");
  }
  const cli = resolve(root, binTarget);
  const directory = await mkdtemp(join(tmpdir(), "deg-build-prompt-inspector-"));
  const input = join(directory, "session.jsonl");
  const output = join(directory, "sidecar");
  try {
    await writeFile(input, CLI_SMOKE_EVENT + "\n", "utf8");
    // 同步 spawn（不经 shell）：构建脚本不需要并发，退出码与输出都要拿到。
    const result = spawnSync(process.execPath, [cli, input, "--out", output, "--max-bytes", "32"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw new Error("Prompt Inspector CLI 无法启动: " + result.error.message);
    if (result.status !== 0) {
      throw new Error("Prompt Inspector CLI 退出码 " + result.status + ": " + String(result.stderr ?? "").trim());
    }
    let summary;
    try {
      summary = JSON.parse(result.stdout);
    } catch {
      throw new Error("Prompt Inspector CLI stdout 不是 JSON: " + String(result.stdout ?? "").trim());
    }
    if (summary?.verified !== true) {
      throw new Error("Prompt Inspector CLI 生成的 sidecar 未通过校验: " + JSON.stringify(summary));
    }
    // 输出目录必须留下真实产物：manifest 与至少一个分块文件。
    await access(join(output, "manifest.json"), constants.R_OK);
    const chunkEntries = await readdir(join(output, "records"), { recursive: true });
    if (!chunkEntries.some((entry) => entry.endsWith(".txt"))) {
      throw new Error("Prompt Inspector CLI 未写出分块文件: " + chunkEntries.join(","));
    }
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const cliSummary = await smokePromptInspectorCli();

const dshPeers = Object.entries(packageJson.peerDependencies ?? {})
  .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
  .map(([, version]) => version);
if (dshPeers.length === 0 || new Set(dshPeers).size !== 1) {
  throw new Error("所有 DSH peerDependencies 必须保持同一版本范围");
}

console.log("DEG build verification passed: " + sourceTargets.length + " JavaScript files (含 "
  + (syntaxCheckSources.length + BUILD_SCRIPT_FILES.length) + " 个不发布的装配源/构建脚本), "
  + targets.size + " published targets, prompt-inspector CLI smoke verified=" + cliSummary.verified);
