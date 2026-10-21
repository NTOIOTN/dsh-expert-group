#!/usr/bin/env node
/**
 * 体积复测入口（ticket 17）：把 checked-in 的 client-bundle.js 按门禁同一组参数重新测一遍。
 *
 * 存在的理由：构建日志给出的三个数值必须是**可复现**的，而不是只有构建当次才知道。
 * 这里刻意复用 scripts/assemble-client.mjs 的 measureBundleSizes / evaluateBundleSizeGate，
 * 避免"测量命令"和"门禁"各写一份压缩参数。
 *
 * 用法：node scripts/measure-bundle.mjs
 * 退出码：0 = 通过硬门禁；1 = 超出上限（同时打印超限项）。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLE_SIZE_BASELINE,
  BUNDLE_SIZE_LIMITS,
  evaluateBundleSizeGate,
  measureBundleSizes,
} from "./assemble-client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "client-bundle.js");
const content = await readFile(outputPath, "utf8");
const sizes = measureBundleSizes(content);

console.log("client-bundle.js 体积复测：" + outputPath);
console.log("  raw    " + sizes.raw + " B（上限 " + BUNDLE_SIZE_LIMITS.raw + " B）");
console.log("  gzip   " + sizes.gzip + " B（上限 " + BUNDLE_SIZE_LIMITS.gzip + " B，gzip -9）");
console.log("  brotli " + sizes.brotli + " B（仅参考，无门槛，quality 11）");
console.log("基线 v" + BUNDLE_SIZE_BASELINE.version + "：raw=" + BUNDLE_SIZE_BASELINE.raw
  + " B / gzip=" + BUNDLE_SIZE_BASELINE.gzip + " B");

const violations = evaluateBundleSizeGate(sizes);
if (violations.length > 0) {
  for (const violation of violations) {
    console.error("体积超限：" + violation.metric + "=" + violation.actual + " B > " + violation.limit + " B");
  }
  process.exitCode = 1;
} else {
  console.log("体积硬门禁：通过");
}
