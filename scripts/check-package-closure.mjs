#!/usr/bin/env node
/**
 * 发布包相对导入闭包检查。
 *
 * 背景：`package.json.files` 是手工维护的白名单，历史上新增模块时漏登记，
 * 导致 npm tarball 缺少被静态 import 的文件，宿主 ESM 链接期直接
 * ERR_MODULE_NOT_FOUND，插件「启动时没能加载」。本脚本在发布前对**已登记进
 * files[] 的 JS 文件**做相对 import 闭包校验：任何一个相对导入目标要么必须
 * 也在 files[] 中，要么直接失败；同时反向校验 files[] 中的条目真实存在。
 *
 * 只做静态、只读检查；不依赖宿主 peer 依赖，也不执行被检查模块。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = process.env.DEG_PACKAGE_ROOT ? resolve(process.env.DEG_PACKAGE_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const files = Array.isArray(pkg.files) ? pkg.files : [];
const errors = [];

/** 目录项（以 / 结尾）覆盖其下所有文件；其余按精确路径匹配。 */
function isPublished(rel) {
  return files.some((entry) => entry.endsWith("/") ? rel.startsWith(entry) : entry === rel);
}

/** 把相对说明符解析成真实文件；支持省略扩展名与目录 index.js。 */
function resolveSpecifier(base) {
  const candidates = [base, base + ".js", base + ".mjs", join(base, "index.js")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** 迭代 AST，只关心 import / export-from / 字面量 dynamic import。 */
function collectSpecifiers(node, specs) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
    if (node.source && typeof node.source.value === "string") specs.push(node.source.value);
  } else if (node.type === "ImportExpression" && node.source && node.source.type === "Literal" && typeof node.source.value === "string") {
    specs.push(node.source.value);
  }
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) collectSpecifiers(child, specs);
    } else if (value && typeof value.type === "string") {
      collectSpecifiers(value, specs);
    }
  }
}

// 1) files[] 白名单条目必须真实存在
for (const entry of files) {
  if (!existsSync(join(root, entry))) errors.push("files[] 条目不存在: " + entry);
}

// 2) 从所有已发布 JS/MJS 文件出发做相对导入闭包检查
const publishedScripts = files.filter((entry) => /\.(?:js|mjs)$/u.test(entry) && existsSync(join(root, entry)));
const seen = new Set();
const queue = [...publishedScripts];
let relativeEdges = 0;
while (queue.length > 0) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const source = readFileSync(join(root, rel), "utf8");
  let ast;
  try {
    ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (moduleError) {
    try {
      // client-bundle.js 是 classic script 拼接产物，允许按 script 解析。
      ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
    } catch (scriptError) {
      errors.push("解析失败 " + rel + ": " + moduleError.message);
      continue;
    }
  }
  const specs = [];
  collectSpecifiers(ast, specs);
  for (const spec of specs) {
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
    relativeEdges += 1;
    const target = resolveSpecifier(join(dirname(join(root, rel)), spec));
    if (!target) {
      errors.push(rel + " 的相对导入目标不存在: " + spec);
      continue;
    }
    const targetRel = relative(root, target).replaceAll("\\", "/");
    if (!isPublished(targetRel)) {
      errors.push(rel + " 导入的 " + targetRel + " 不在 package.json files[] 中");
    }
    if (/\.(?:js|mjs)$/u.test(targetRel)) queue.push(targetRel);
  }
}

if (errors.length > 0) {
  console.error("发布包闭包检查失败（" + errors.length + " 条）：");
  for (const error of errors) console.error("  - " + error);
  process.exit(1);
}
console.log("发布包闭包检查通过：files=" + files.length + "，已检查 JS=" + seen.size + "，相对导入边=" + relativeEdges + "。");
