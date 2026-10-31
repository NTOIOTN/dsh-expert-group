#!/usr/bin/env node
/**
 * 基线报告（只读）：用一条命令打印当前基线事实，供 AGENTS.md / 规格书引用，而不是在文档里
 * 内嵌一份必然过期的数字快照。
 *
 * ## 为什么要有这个脚本
 * 手写进文档的基线数字（产品源文件数、bundle 体积、门禁条数、用例数）一旦漂移，文档就从
 * 「事实」变成「误导」。改法是：文档只写命令，数字由命令现算。本脚本因此**只读**——不写
 * 任何文件、不触发构建、不改变任何门禁判据，只把已有事实汇总成可直接贴进文档的文本。
 *
 * ## 口径（全部复用门禁模块，绝不另写一套枚举）
 * - **产品源文件数**：collectModuleSourceFiles（scripts/check-module-size.mjs），与行数门禁的
 *   统计范围逐字同源（package.json files 的 JS/MJS ∪ CLIENT_SOURCE_FILES）；
 * - **测试文件数 / 测试代码行数**：按 test/*.test.mjs 实际枚举，行数用 countLogicalLines
 *   （与门禁同一「逻辑行」口径：换行符个数，末行无换行时同样计入）；
 * - **bundle 三种体积**：measureBundleSizes（scripts/assemble-client.mjs），读**现有**
 *   client-bundle.js 后再测，不触发构建（gzip -9 / brotli quality 11，与门禁同参数）；
 * - **两套门禁摘要**：行数门禁用 collectModuleSizeViolations + summarizeViolations，
 *   依赖图门禁用 evaluateRepository（C1/C2/C3/C4/C8），bundle 门禁用
 *   evaluateBundleSizeGate；三者都是门禁自己的判据函数，报告不重新实现判定。
 *
 * ## 刻意不做的事
 * - **不给出测试用例数**：用例数只有真的跑过 node --test "test/*.test.mjs" 才知道；
 *   让脚本估一个数等于在文档里塞第二份会过期的事实。输出里明确写「以最近一次全量运行为准」。
 * - **不复制任何阈值 / 体积比例 / 历史基线**：阈值一律从权威模块 import
 *   （MODULE_SIZE_LIMITS / DEPENDENCY_GRAPH_LIMITS / BUNDLE_SIZE_LIMITS），脚本正文里没有
 *   任何体积数字常量，改阈值只改权威模块，报告自动跟随。
 * - **不因门禁红灯而失败**：本脚本是「体检报告」而不是门禁。门禁判据仍以
 *   node scripts/check-module-size.mjs / node scripts/check-dependency-graph.mjs 的退出码为准；
 *   这里只在摘要里如实标出通过与否与条数，不设置失败退出码。
 *
 * 用法：node scripts/report-baseline.mjs
 * 退出码：0 = 报告成功（与门禁是否红灯无关）；非 0 = 读不到输入（缺 client-bundle.js 等）。
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_SIZE_LIMITS,
  evaluateBundleSizeGate,
  measureBundleSizes,
} from "./assemble-client.mjs";
import {
  MODULE_SIZE_LIMITS,
  collectModuleSizeViolations,
  collectModuleSourceFiles,
  summarizeViolations,
} from "./check-module-size.mjs";
import {
  DEPENDENCY_GRAPH_LIMITS,
  evaluateRepository,
} from "./check-dependency-graph.mjs";
import { countLogicalLines } from "./js-source-scan.mjs";

/** 测试目录与其文件名后缀：测试文件数与行数的唯一枚举口径。 */
const TEST_DIRECTORY = "test";
const TEST_FILE_SUFFIX = ".test.mjs";

/** 发布产物路径（相对仓库根）：体积只测它，不触发构建。 */
const BUNDLE_FILE = "client-bundle.js";

/**
 * 枚举 test/*.test.mjs：与 node --test "test/*.test.mjs" 的文件集合一致。
 *
 * 只认测试目录下的普通文件（不递归子目录），排序后返回，保证输出可复现。
 *
 * @param {string} root 仓库根。
 * @returns {Promise<string[]>} 相对仓库根的测试文件清单（/ 分隔）。
 */
export async function collectTestFiles(root) {
  const entries = await readdir(join(root, TEST_DIRECTORY), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX))
    .map((entry) => TEST_DIRECTORY + "/" + entry.name)
    .sort();
}

/**
 * 统计测试代码行数：逐个文件按 countLogicalLines 计逻辑行后求和。
 *
 * 复用门禁的行数口径而不是 split("\\n").length：后者对末尾无换行的文件会少算一行，
 * 两处口径不一致时「测试行数」和「源码行数」就不可比。
 *
 * @param {string} root 仓库根。
 * @param {string[]} files 相对仓库根的测试文件清单。
 * @returns {Promise<number>} 逻辑行合计。
 */
export async function countTestLines(root, files) {
  const sources = await Promise.all(files.map((file) => readFile(join(root, file), "utf8")));
  let total = 0;
  for (const source of sources) total += countLogicalLines(source);
  return total;
}

/**
 * 收集一次基线报告的全部事实（纯读数，不写盘）。
 *
 * 调用顺序按「便宜的先算、错误先暴露」排：先读 bundle（缺产物立刻失败），再跑两套门禁。
 * 两套门禁各自读一遍源码，这里不替它们缓存源码文本——判据函数要的是自己的输入，
 * 替它们缓存等于绕开门禁的读入路径。
 *
 * @param {string} root 仓库根。
 * @returns {Promise<object>} 报告数据。
 */
export async function collectBaselineReport(root) {
  // 产品源文件清单与行数门禁同源：报告的产品文件数就是门禁的统计范围大小。
  const productFiles = await collectModuleSourceFiles(root);
  const testFiles = await collectTestFiles(root);
  const testLineCount = await countTestLines(root, testFiles);

  // bundle 只读现有产物：报告随时可跑，不需要先 build（构建由 pnpm run build 负责）。
  const bundleContent = await readFile(join(root, BUNDLE_FILE), "utf8");
  const bundle = measureBundleSizes(bundleContent);

  // 行数门禁：把上面那份清单直接交给判定函数，避免再枚举一次（口径不会分叉）。
  const moduleViolations = await collectModuleSizeViolations({ root, files: productFiles });
  const moduleSummary = summarizeViolations(moduleViolations);

  // 依赖图门禁：evaluateRepository 自己完成读入 + 五条判据（C1/C2/C3/C4/C8）。
  const dependencyGraph = await evaluateRepository(root);

  return {
    productFileCount: productFiles.length,
    testFileCount: testFiles.length,
    testLineCount,
    bundle,
    bundleViolations: evaluateBundleSizeGate(bundle),
    moduleViolations,
    moduleSummary,
    dependencyGraph,
  };
}

/** 行数门禁摘要行：阈值来自 MODULE_SIZE_LIMITS，报告不写死任何一个数字。 */
function formatModuleGateLine(report) {
  const { counts, fileCount } = report.moduleSummary;
  return "模块行数门禁（node scripts/check-module-size.mjs）："
    + (report.moduleViolations.length === 0 ? "通过" : "未通过")
    + "；违规 " + report.moduleViolations.length + " 条，涉及 " + fileCount + " 个文件"
    + "（file=" + counts.file + " / function=" + counts.function + " / component=" + counts.component
    + " / factory=" + counts.factory + " / closure=" + counts.closure + "）"
    + "；阈值 文件 ≤" + MODULE_SIZE_LIMITS.file + " 行 / 函数 ≤" + MODULE_SIZE_LIMITS.function
    + " 行 / 组件 ≤" + MODULE_SIZE_LIMITS.component + " 行 / 工厂 ≤" + MODULE_SIZE_LIMITS.factory
    + " 行 / 单闭包内函数数 ≤" + MODULE_SIZE_LIMITS.closure;
}

/** 依赖图门禁摘要行：判据条数取自 evaluateRepository 的结果，阈值取自 DEPENDENCY_GRAPH_LIMITS。 */
function formatDependencyGateLine(report) {
  const { counts, violations } = report.dependencyGraph;
  return "依赖图门禁（node scripts/check-dependency-graph.mjs）："
    + (violations.length === 0 ? "通过" : "未通过")
    + "；C1=" + counts.C1 + " / C2=" + counts.C2 + " / C3=" + counts.C3
    + " / C4=" + counts.C4 + " / C8=" + counts.C8
    + "，合计 " + violations.length + " 条"
    + "；阈值 导出数 ≤" + DEPENDENCY_GRAPH_LIMITS.exports
    + " / 本地 import ≤" + DEPENDENCY_GRAPH_LIMITS.localImports;
}

/** bundle 体积门禁摘要行：上限来自 assemble-client.mjs 的权威常量，brotli 无门槛。 */
function formatBundleGateLine(report) {
  return "bundle 体积门禁（上限来自 scripts/assemble-client.mjs 的权威常量）："
    + (report.bundleViolations.length === 0 ? "通过" : "未通过")
    + "；raw " + report.bundle.raw + " B ≤ " + BUNDLE_SIZE_LIMITS.raw + " B"
    + " / gzip " + report.bundle.gzip + " B ≤ " + BUNDLE_SIZE_LIMITS.gzip + " B"
    + "（brotli 仅参考，无门槛）";
}

/**
 * 把报告数据格式化成可直接贴进文档的文本。
 *
 * 固定「一行一个字段」：文档引用者可以只摘其中几行，测试也能按字段名断言齐全性。
 *
 * @param {object} report collectBaselineReport 的返回值。
 * @returns {string} 多行文本（不带结尾换行）。
 */
export function formatBaselineReport(report) {
  return [
    "DEG 基线报告（只读；口径与门禁脚本同源，不写任何文件）",
    "  产品源文件 = package.json files 的 JS/MJS ∪ CLIENT_SOURCE_FILES（scripts/check-module-size.mjs）",
    "  测试文件 = test/*.test.mjs 实际枚举；测试行数 = 逻辑行合计（与门禁同一口径）",
    "  bundle = 现有 client-bundle.js（不触发构建；gzip -9 / brotli quality 11）",
    '  测试用例数不由本脚本给出：以最近一次 node --test "test/*.test.mjs" 的输出为准',
    "",
    "产品源文件数：" + report.productFileCount,
    "测试文件数：" + report.testFileCount,
    "测试代码行数：" + report.testLineCount,
    "",
    "client-bundle.js raw（字节）：" + report.bundle.raw,
    "client-bundle.js gzip（字节，gzip -9）：" + report.bundle.gzip,
    "client-bundle.js brotli（字节，quality 11，仅参考）：" + report.bundle.brotli,
    "",
    "── 门禁摘要（判据以门禁脚本退出码为准；本报告不设失败退出码）──",
    formatModuleGateLine(report),
    formatDependencyGateLine(report),
    formatBundleGateLine(report),
  ].join("\n");
}

/** CLI 主流程：算一次、打印一次；不写盘、不设置失败退出码。 */
async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const report = await collectBaselineReport(root);
  console.log(formatBaselineReport(report));
}

// 只有被当作脚本直接执行时才跑 CLI；被测试 import 时不产生打印等副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
