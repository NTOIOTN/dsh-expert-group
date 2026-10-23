#!/usr/bin/env node
/**
 * 模块行数门禁（R0）：按规格书 §行数门禁的统计范围报告超限项。
 *
 * ## 统计范围（与规格书逐条对齐）
 * 统计范围 = 产品源码，由两部分**并集**构成：
 *   1. `package.json` `files` 中所有 `.js` / `.mjs` 源文件（Host / Shared / Fanout / 客户端
 *      运行时模块），排除构建产物 `client-bundle.js`；
 *   2. `scripts/client-sources.mjs` 的 `CLIENT_SOURCE_FILES`（客户端装配输入）。
 * 为什么必须有第 2 部分：客户端装配输入按体积收敛策略**不发布**，只按 `files` 枚举会漏掉
 * 4 个超限客户端文件（`client.js`、`client-expert-group-sidebar.js`、
 * `client-expert-group-model.js`、`client-model-config.js`）。
 *
 * 明确不计入：
 * - `test/` 下的测试文件（本轮门禁不覆盖测试可读性；`test/model-config.test.mjs`、
 *   `test/root-turn-wait.test.mjs` 虽然超过 1,500 行也不报）；
 * - `client-bundle.js`（构建产物，只受 `scripts/assemble-client.mjs` 的体积门禁约束）；
 * - `node_modules/`、`.git/`、`.scratch/` 等非源码目录；
 * - `files` 里的非源码项（`assets/*.wav`、`icon.svg`、`cordis.patch.yml`、`*.md`、`LICENSE`）
 *   按扩展名自然排除。
 *
 * ## 五项阈值（规格书 §阈值，硬上限）
 * - 文件行数（含注释空行）：1,500，按**逻辑行**计（`\n` 个数；末尾无换行时末行同样计入）；
 * - 函数 / 方法：200 行；React 组件：500 行；工厂 / installer：400 行；
 * - 单闭包内函数数：40 个。
 *
 * ## 命名分类规则（与测试一一对应，改动需同步改测试）
 * - **工厂优先**：名字以 `create` 或 `install` 开头的函数按「工厂 ≤400」计；
 * - **组件**：其余函数中，名字首字母大写的（PascalCase，函数声明名或 `const`/`let` 绑定名）
 *   按「React 组件 ≤500」计；
 * - **函数**：剩下的按「函数 ≤200」计。
 * 三条互斥，判定顺序固定为 工厂 → 组件 → 函数，所以 `createPanel` 是工厂而不是组件。
 *
 * ## 单闭包内函数数
 * 对每个函数跨度统计**其内部（任意深度）包含的全部函数数**；只报告最外层违规闭包：
 * 父闭包已经超限时不再重复报告子闭包（否则一个巨型工厂会淹掉整份报告）。
 *
 * ## 跨度口径（票据 38 补记）
 * 带花括号体的函数 / 方法 / 箭头与**表达式体箭头**（`x => x + 1`、`() => [ … ]`）同等计入
 * 函数行数与单闭包函数数——规格的「单函数 ≤200」没有为表达式体开口子。表达式体的结束位置
 * 由 `scripts/js-source-scan.mjs` 的 `findExpressionEnd` 按「括号配平 + 语句边界」近似。
 *
 * ## AST 交叉校验（票据 44，默认关闭）
 * `--ast-cross-check` 会用 acorn 解析同一批文件，与词法器的跨度集合比对，打印：
 * 「AST 函数数 / 词法器函数数 / 仅 AST 有 / 仅词法器有」，并**逐个列出「仅 AST 有且行数
 * 超阈值」的条目**。为什么要有它：词法器判断不了『正则字面量 vs 除号』，票据 42/43 每轮
 * 都在补它的边界；交叉校验让"词法器漏了一个真超限函数"从"不可知"变成"红灯"。
 * 判据**不切换**：朴素 AST 计数会一次冒出大量超限（`install*` 模块包装与组件/工厂类别
 * 差异），切换会引发超出本票的连锁重构——这是票据 44 的明确边界。
 * 交叉校验发现「仅 AST 有且超限（且不属于既有的模块作用域包装豁免）」时，脚本以
 * `process.exitCode = 1` 失败（`--report` 下仍只报告）。
 *
 * ## 退出码
 * 默认（`node scripts/check-module-size.mjs`）有违规就 `process.exitCode = 1`；
 * 加 `--report` 只打印、不失败（当前代码大面积超限，R9 之前用它做量测）。
 * 本脚本**不接入** `scripts/build.mjs`：门禁在 R9 之前必然是红的，接进构建会立刻把构建打红。
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_SOURCE_FILES } from "./client-sources.mjs";
import { countLogicalLines, scanFunctionSpans } from "./js-source-scan.mjs";
// 票据 44：行数门禁的**判据仍是词法器**（跨度的类别差异不适合在本票切换），
// 但新增 AST 交叉校验（--ast-cross-check）：真实解析器看见而词法器看不见的函数，
// 如果行数超阈值，就说明词法器漏了真实超限——这类才是必须修的。
import { collectFunctionNodes, parseSource } from "./js-ast-scan.mjs";

/** 五项硬上限（规格书 §阈值）。测试与报告都读这一份常量，不重复字面量。 */
export const MODULE_SIZE_LIMITS = Object.freeze({
  file: 1500,
  function: 200,
  component: 500,
  factory: 400,
  closure: 40,
});

/** 门禁不覆盖的目录（相对仓库根，统一用 `/` 分隔）。 */
const EXCLUDED_PATH_PREFIXES = Object.freeze(["test/", "node_modules/", ".git/", ".scratch/"]);

/** 白名单：构建产物只受体积门禁约束，不参与行数门禁。 */
const WHITELISTED_FILES = Object.freeze(["client-bundle.js"]);

/** 参与统计的源码扩展名。 */
const SOURCE_FILE_PATTERN = /\.(?:js|mjs)$/i;

/** 工厂名：以 create / install 开头（优先级最高）。 */
const FACTORY_NAME_PATTERN = /^(?:create|install)/;

/** 组件名：PascalCase（首字母大写）。 */
const COMPONENT_NAME_PATTERN = /^[A-Z]/;

/** 违规项在报告里的排序权重：文件级排最前，其余按行号。 */
const KIND_ORDER = Object.freeze({ file: 0, component: 1, factory: 2, function: 3, closure: 4 });

/** 统一成 `/` 分隔、去掉 `./` 前缀的相对路径，保证跨平台与去重稳定。 */
export function normalizeModulePath(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 是否属于门禁不覆盖的路径（测试、依赖目录、构建产物白名单）。 */
export function isExcludedModulePath(file) {
  const normalized = normalizeModulePath(file);
  if (WHITELISTED_FILES.includes(normalized)) return true;
  return EXCLUDED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 按命名规则给函数分类，返回 `"factory" | "component" | "function"`。
 * 优先级：工厂 → 组件 → 函数（见文件头注释）。
 */
export function classifyModuleFunction(name) {
  if (FACTORY_NAME_PATTERN.test(name)) return "factory";
  if (COMPONENT_NAME_PATTERN.test(name)) return "component";
  return "function";
}

/**
 * 计算门禁的统计范围（相对仓库根的文件清单，已排序、已去重、已排除白名单与测试目录）。
 * 两部分并集：`package.json` `files` 的 JS/MJS 源码 ∪ `CLIENT_SOURCE_FILES`。
 */
export async function collectModuleSourceFiles(root) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const files = new Set();
  const add = (entry) => {
    if (typeof entry !== "string" || entry.length === 0) return;
    const normalized = normalizeModulePath(entry);
    if (!SOURCE_FILE_PATTERN.test(normalized)) return;
    if (isExcludedModulePath(normalized)) return;
    files.add(normalized);
  };
  for (const entry of packageJson.files ?? []) add(entry);
  // 并集第 2 部分：不发布的客户端装配输入（单一事实源，不复制清单）。
  for (const entry of CLIENT_SOURCE_FILES) add(entry);
  return [...files].sort();
}

/**
 * 纯函数式收集违规项：输入显式给出，不读全局状态（单测可传临时夹具）。
 *
 * @param {object} options
 * @param {string} options.root 仓库根（或夹具根）的绝对/相对路径。
 * @param {string[]} [options.files] 相对 root 的文件清单；省略时按 `collectModuleSourceFiles` 计算。
 * @returns {Promise<Array<{file: string, kind: string, name: string, line: number, value: number, limit: number}>>}
 */
export async function collectModuleSizeViolations({ root, files } = {}) {
  const list = (files ?? (await collectModuleSourceFiles(root)))
    .map(normalizeModulePath)
    .filter((file) => !isExcludedModulePath(file));
  const violations = [];
  for (const file of [...new Set(list)].sort()) {
    const source = await readFile(join(root, file), "utf8");
    const lineCount = countLogicalLines(source);
    if (lineCount > MODULE_SIZE_LIMITS.file) {
      violations.push({ file, kind: "file", name: file, line: 1, value: lineCount, limit: MODULE_SIZE_LIMITS.file });
    }
    let spans;
    try {
      // 票据 42：把文件名交给遮蔽器，结构校验失准时错误信息能直接指出是哪个文件。
      spans = scanFunctionSpans(source, { file });
    } catch (error) {
      throw new Error(file + " 扫描失败：" + (error instanceof Error ? error.message : String(error)));
    }
    for (const span of spans) {
      const name = span.name || "<anonymous>";
      // 模块级 IIFE 包装（`(function installX(global) { ... })(globalThis)`）不是工厂 /
      // installer，而是**模块作用域本身**：它几乎覆盖整个文件、且以 `install` 命名。
      // 若把它当工厂，就等于把「文件行数」再报一次（同一事实两次违规），而模块作用域的
      // 规模已经被 file ≤1,500 约束；闭包函数数同理（它是模块作用域的函数总数，不是嵌套闭包）。
      // 真正的内部 installer（如 installExpertGroupSidebar 的内层实现）不会被此规则跳过：
      // 它不覆盖整个文件。
      if (!isModuleLevelIifeWrapper(span, name, lineCount, source)) {
        const kind = classifyModuleFunction(name);
        const value = span.endLine - span.startLine + 1;
        if (value > MODULE_SIZE_LIMITS[kind]) {
          violations.push({ file, kind, name, line: span.startLine, value, limit: MODULE_SIZE_LIMITS[kind] });
        }
      }
      // 单闭包内函数数：只报告最外层违规闭包（父闭包已违规就不再重复报告子闭包）。
      if (!isModuleLevelIifeWrapper(span, name, lineCount, source)
        && span.containedFunctionCount > MODULE_SIZE_LIMITS.closure
        && !hasViolatingAncestor(span, { logicalLines: lineCount, source })) {
        violations.push({
          file,
          kind: "closure",
          name,
          line: span.startLine,
          value: span.containedFunctionCount,
          limit: MODULE_SIZE_LIMITS.closure,
        });
      }
    }
  }
  return violations.sort(compareViolations);
}

/** 声明一个跨度记录（交叉校验两侧共用的字段形状）。 */
function spanRecord(file, name, startLine, endLine) {
  return { file, name, startLine, endLine, lines: Math.max(endLine - startLine + 1, 0) };
}

/** 按 key 分组：Map<key, 记录数组>（同名同跨度可能出现多次，必须按重数配对）。 */
function groupByKey(records, keyOf) {
  const groups = new Map();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

/**
 * AST 与词法器的**函数跨度交叉校验**（票据 44）。
 *
 * 三段式配对（顺序固定，保证结果可解释）：
 * 1. **跨度 + 名字全等**：直接视为一致（matchedExact）；
 * 2. **跨度相同、名字不同**：两侧对同一个函数给出不同名字（nameMismatches）。词法器的命名
 *    是启发式的（向前找 = / : / 参数列表），AST 侧按 id / 声明符 / 属性键取值——差异本身
 *    不影响"有没有这个函数"，但会影响类别判定（create* 才算工厂），所以必须可见；
 * 3. **只剩一侧**：onlyAst / onlyLexer。
 *
 * 对 onlyAst 再算一次**行数判据**：按 AST 的名字分类（工厂/组件/函数），与门禁阈值比较，
 * 得到 overLimitOnlyAst —— 这正是"词法器漏了真实超限"的证据。同时标记 moduleWrapper：
 * 覆盖整文件的 IIFE 包装本来就被既有规则豁免（规模由 file ≤1500 约束），
 * 因此"必须修"的集合是 overLimitOnlyAstUnexempt（扣除该豁免后）。
 *
 * @param {{root?: string, files?: string[]}} [options] 与 collectModuleSizeViolations 同口径。
 * @returns {Promise<object>} 交叉校验结果。
 */
export async function crossCheckFunctionSpans({ root, files } = {}) {
  const list = (files ?? (await collectModuleSourceFiles(root)))
    .map(normalizeModulePath)
    .filter((file) => !isExcludedModulePath(file));
  const astEntries = [];
  const lexerEntries = [];
  /** 文件上下文（moduleWrapper 判定需要原文与逻辑行数）。 */
  const contextByFile = new Map();
  for (const file of [...new Set(list)].sort()) {
    const source = await readFile(join(root, file), "utf8");
    const logicalLines = countLogicalLines(source);
    contextByFile.set(file, { source, logicalLines });
    // fail-closed：解析失败带文件名与行列抛出，不把"看不懂"降级成"没有函数"。
    const ast = parseSource(source, file);
    for (const node of collectFunctionNodes(ast)) {
      astEntries.push(spanRecord(file, node.name, node.startLine, node.endLine));
    }
    let spans;
    try {
      spans = scanFunctionSpans(source, { file });
    } catch (error) {
      throw new Error(file + " 扫描失败：" + (error instanceof Error ? error.message : String(error)));
    }
    for (const span of spans) {
      lexerEntries.push(spanRecord(file, span.name || "", span.startLine, span.endLine));
    }
  }

  // ── 第 1 段：跨度 + 名字全等 ────────────────────────────────────────────────
  const keyExact = (record) => record.file + "\u0000" + record.startLine + ":" + record.endLine + ":" + record.name;
  const keySpan = (record) => record.file + "\u0000" + record.startLine + ":" + record.endLine;
  const astByExact = groupByKey(astEntries, keyExact);
  const lexerByExact = groupByKey(lexerEntries, keyExact);
  const remainingAst = [];
  const remainingLexer = [];
  let matchedExact = 0;
  for (const [key, bucket] of astByExact) {
    const counterpart = lexerByExact.get(key) ?? [];
    const paired = Math.min(bucket.length, counterpart.length);
    matchedExact += paired;
    for (let index = paired; index < bucket.length; index++) remainingAst.push(bucket[index]);
    for (let index = paired; index < counterpart.length; index++) remainingLexer.push(counterpart[index]);
  }
  for (const [key, bucket] of lexerByExact) {
    if (astByExact.has(key)) continue;
    for (const record of bucket) remainingLexer.push(record);
  }

  // ── 第 2 段：跨度相同、名字不同 ─────────────────────────────────────────────
  const astBySpan = groupByKey(remainingAst, keySpan);
  const lexerBySpan = groupByKey(remainingLexer, keySpan);
  const nameMismatches = [];
  const leftoverAst = [];
  const leftoverLexer = [];
  for (const [key, bucket] of astBySpan) {
    const counterpart = lexerBySpan.get(key) ?? [];
    const paired = Math.min(bucket.length, counterpart.length);
    for (let index = 0; index < paired; index++) {
      nameMismatches.push({
        file: bucket[index].file,
        startLine: bucket[index].startLine,
        endLine: bucket[index].endLine,
        astName: bucket[index].name,
        lexerName: counterpart[index].name,
      });
    }
    for (let index = paired; index < bucket.length; index++) leftoverAst.push(bucket[index]);
    for (let index = paired; index < counterpart.length; index++) leftoverLexer.push(counterpart[index]);
  }
  for (const [key, bucket] of lexerBySpan) {
    if (astBySpan.has(key)) continue;
    for (const record of bucket) leftoverLexer.push(record);
  }

  /** 给跨度补上类别 / 阈值 / 是否超限 / 是否属于被豁免的模块作用域包装。 */
  const describe = (record) => {
    const name = record.name === "" ? "<anonymous>" : record.name;
    const kind = classifyModuleFunction(record.name);
    const limit = MODULE_SIZE_LIMITS[kind];
    const context = contextByFile.get(record.file);
    const moduleWrapper = context === undefined
      ? false
      : isModuleLevelIifeWrapper(record, record.name, context.logicalLines, context.source);
    // `line` 是 `compareViolations` 的排序键（file → 行号 → kind → 名字）；复制自 startLine，
    // 让"仅 AST 有"的清单与门禁违规清单用同一套排序，人工复核时行号单调递增。
    return {
      ...record,
      line: record.startLine,
      displayName: name,
      kind,
      limit,
      overLimit: record.lines > limit,
      moduleWrapper,
    };
  };
  const onlyAst = leftoverAst.map(describe).sort(compareViolations);
  const onlyLexer = leftoverLexer.map(describe).sort(compareViolations);
  const overLimitOnlyAst = onlyAst.filter((entry) => entry.overLimit);
  const overLimitOnlyAstUnexempt = overLimitOnlyAst.filter((entry) => !entry.moduleWrapper);
  nameMismatches.sort((left, right) => (left.file === right.file
    ? left.startLine - right.startLine
    : (left.file < right.file ? -1 : 1)));
  return {
    files: [...new Set(list)].length,
    astCount: astEntries.length,
    lexerCount: lexerEntries.length,
    matchedExact,
    nameMismatches,
    onlyAst,
    onlyLexer,
    overLimitOnlyAst,
    overLimitOnlyAstUnexempt,
  };
}

/**
 * 把交叉校验结果格式化成可打印的文本行（CLI 与测试共用同一份措辞）。
 *
 * 第一行固定为票据 44 要求的形状：「AST 函数数 / 词法器函数数 / 仅 AST 有 / 仅词法器有」。
 * 随后逐个列出「仅 AST 有且行数超阈值」的条目——若存在且不属于既有的模块作用域包装
 * 豁免，就是词法器漏掉的真超限，必须修。
 *
 * @param {object} crossCheck crossCheckFunctionSpans 的返回值。
 * @returns {string[]} 每项一行。
 */
export function formatFunctionSpanCrossCheck(crossCheck) {
  const lines = [
    "AST 函数数 " + crossCheck.astCount + " / 词法器函数数 " + crossCheck.lexerCount
      + " / 仅 AST 有 " + crossCheck.onlyAst.length + " / 仅词法器有 " + crossCheck.onlyLexer.length,
    "  跨度与名字全等 " + crossCheck.matchedExact + " 个；跨度相同但命名不同 "
      + crossCheck.nameMismatches.length + " 个",
  ];
  if (crossCheck.onlyAst.length > 0) {
    lines.push("  仅 AST 有（词法器完全没看见的函数）：");
    for (const entry of crossCheck.onlyAst) {
      lines.push("    + " + entry.file + ":" + entry.startLine + " " + entry.displayName
        + "（" + entry.lines + " 行，按 " + entry.kind + " 阈值 " + entry.limit + "）");
    }
  }
  if (crossCheck.onlyLexer.length > 0) {
    lines.push("  仅词法器有（AST 无对应节点，属词法器误报）：");
    for (const entry of crossCheck.onlyLexer) {
      lines.push("    - " + entry.file + ":" + entry.startLine + " " + entry.displayName
        + "（" + entry.lines + " 行）");
    }
  }
  const overLimit = crossCheck.overLimitOnlyAst ?? [];
  if (overLimit.length === 0) {
    lines.push("  仅 AST 有且行数超阈值：无（词法器没有漏掉真实超限）");
    return lines;
  }
  lines.push("  仅 AST 有且行数超阈值：" + overLimit.length + " 条");
  for (const entry of overLimit) {
    const exempt = entry.moduleWrapper ? "（模块作用域包装，行数门禁按既有规则豁免）" : "";
    lines.push("    ! " + entry.file + ":" + entry.startLine + " " + entry.displayName
      + " — " + entry.lines + " 行 > 上限 " + entry.limit + "（" + entry.kind + "）" + exempt);
  }
  const unexempt = crossCheck.overLimitOnlyAstUnexempt ?? [];
  lines.push(unexempt.length === 0
    ? "  其中需要修的：0 条（超限项全部属于既有的模块作用域包装豁免）"
    : "  其中需要修的：" + unexempt.length + " 条（词法器漏了真实超限，必须修）");
  return lines;
}

/**
 * 是否是「模块作用域包装」——`(function installX(global){…})(globalThis)` 或
 * `__ModuleLoader__.load({ factory: (require) => {…} })` 的 descriptor factory。
 *
 * 这类包装**就是模块本身**（一个文件 = 一个包装函数），规模已被 `file ≤1,500`
 * 精确约束；再按 function/factory/closure 报一次等于把同一事实报两遍。
 *
 * **判定必须验证真实形态，不能只看名字**（2026-10-23 代码审查指出的漏报风险）：
 * 一个恰好叫 `installXxx` 的普通大函数若只看名字就会被错误豁免。因此要求：
 * 1. 覆盖 ≥90% 文件且结束于文件末尾附近；
 * 2. **起始行真的以 `(function <name>(` / `(async function <name>(` 开头**（IIFE 形态），
 *    或 descriptor 的 `factory: (require) =>` 且文件内真有 `__ModuleLoader__.load(`；
 * 3. **紧接着函数体的 `}` 之后必须有调用形态 `)(`**（结束行或下一行）。
 *
 * 三条同时成立才算模块作用域；普通大函数（哪怕叫 `installFoo`）会照常报出。
 * 正反例夹具见 `test/module-size-gate.test.mjs`。
 */
function isModuleLevelIifeWrapper(span, name, logicalLines, source) {
  const covered = span.endLine - span.startLine + 1;
  const coversFile = span.endLine >= logicalLines - 2 && covered >= logicalLines * 0.9;
  if (!coversFile) return false;

  const lines = source.split("\n");
  const startText = lines[span.startLine - 1] ?? "";
  const endText = lines[span.endLine - 1] ?? "";
  const nextText = lines[span.endLine] ?? "";

  // 形态 A：具名 IIFE —— `(function installX(...)` / `(async function installX(...)`
  const startsAsNamedIife = new RegExp(
    "(^|[^\\w$.])\\(\\s*(async\\s+)?function\\s+" + name.replace(/\$/g, "\\$") + "\\s*\\(",
  ).test(startText);

  // 形态 B：ModuleLoader descriptor —— `factory: (require) => {`
  const startsAsDescriptorFactory = name === "factory"
    && /factory\s*:\s*\(/.test(startText)
    && source.includes("__ModuleLoader__.load(");

  if (!startsAsNamedIife && !startsAsDescriptorFactory) return false;

  // 紧接函数体之后必须是调用形态：
  // - 具名 IIFE：`})(globalThis)`（同行）或 `})` + 下一行以 `(` 开头；
  // - descriptor：函数体 `}` 之后是 `})`（先关 load 的选项对象，再关调用括号）。
  const endsAsInvocation = /\}\s*\)\s*\(/.test(endText)
    || (/\}\s*\)\s*;?\s*$/.test(endText) && /^\s*\(/.test(nextText))
    || (startsAsDescriptorFactory && /^\s*\}\s*\)/.test(nextText));
  return endsAsInvocation;
}

/**
 * 是否存在**会自己上报的**超限祖先闭包（祖先闭包超限时子闭包不重复上报）。
 *
 * 票据 39 修掉的盲区：模块作用域包装（IIFE 形态的 install 包装、descriptor 的 factory）
 * 本身被豁免、不产生违规行，但它仍然覆盖整份文件、函数总数必然很大。旧实现只要看到
 * 「祖先 >40」就抑制子闭包，于是**父不报（被豁免）、子也不报（被抑制）**，形成双盲区：
 * 模块包装内部真正超限的组件闭包完全不可见。
 *
 * 因此这里跳过被豁免的模块作用域祖先——它不会上报，也就不该抑制别人；子闭包按自身
 * 规模独立判定。真正的内部工厂 / 组件祖先（非模块包装）仍然照旧抑制，避免一个巨型
 * 父闭包淹掉整份报告。
 *
 * context 提供 isModuleLevelIifeWrapper 做形态判定所需的 logicalLines 与 source。
 */
function hasViolatingAncestor(span, context) {
  let parent = span.parent;
  while (parent) {
    const parentIsModuleWrapper = isModuleLevelIifeWrapper(
      parent, parent.name || "<anonymous>", context.logicalLines, context.source,
    );
    if (!parentIsModuleWrapper && parent.containedFunctionCount > MODULE_SIZE_LIMITS.closure) return true;
    parent = parent.parent;
  }
  return false;
}

function compareViolations(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.kind !== right.kind) return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** 人类可复核的一行：`[kind] 文件:行 名称 — 实测值 > 上限`。 */
export function formatViolation(violation) {
  const unit = violation.kind === "closure" ? " 个函数" : " 行";
  return "[" + violation.kind + "] " + violation.file + ":" + violation.line + " " + violation.name
    + " — " + violation.value + unit + " > 上限 " + violation.limit;
}

/** 按 kind 汇总计数，供报告摘要使用。 */
export function summarizeViolations(violations) {
  const counts = { file: 0, function: 0, component: 0, factory: 0, closure: 0 };
  const files = new Set();
  for (const violation of violations) {
    counts[violation.kind] = (counts[violation.kind] ?? 0) + 1;
    if (violation.kind === "file") files.add(violation.file);
  }
  return { counts, fileCount: files.size };
}

/** CLI 主流程：打印清单与摘要；`--report` 只报告不失败。 */
async function main() {
  const reportOnly = process.argv.includes("--report");
  // 票据 44：默认关闭；开启时只做对照（判据仍是词法器），但会把"仅 AST 有且超限"逐个列出。
  const astCrossCheck = process.argv.includes("--ast-cross-check");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = await collectModuleSourceFiles(root);
  const violations = await collectModuleSizeViolations({ root, files });
  const { counts, fileCount } = summarizeViolations(violations);

  console.log("模块行数门禁（R0）");
  console.log("统计范围：" + files.length + " 个产品源码文件 = package.json files 的 JS/MJS 源码 ∪ CLIENT_SOURCE_FILES"
    + "（排除 test/、client-bundle.js、node_modules/、.git/、.scratch/）");
  console.log("阈值：文件 ≤" + MODULE_SIZE_LIMITS.file + " 行（逻辑行）/ 函数 ≤" + MODULE_SIZE_LIMITS.function
    + " 行 / 组件 ≤" + MODULE_SIZE_LIMITS.component + " 行 / 工厂 ≤" + MODULE_SIZE_LIMITS.factory
    + " 行 / 单闭包内函数数 ≤" + MODULE_SIZE_LIMITS.closure);
  console.log("");
  if (violations.length === 0) {
    console.log("未发现超限项。");
  } else {
    for (const violation of violations) console.log(formatViolation(violation));
  }
  console.log("");
  console.log("摘要：违规 " + violations.length + " 条，涉及 " + fileCount + " 个文件；"
    + "file=" + counts.file + " / function=" + counts.function + " / component=" + counts.component
    + " / factory=" + counts.factory + " / closure=" + counts.closure);

  // ── AST 交叉校验（票据 44，默认关闭）──────────────────────────────────────
  // 为什么放在摘要之后：先把「判据自己的结论」讲完，再讲「第二个实现看见了什么」，
  // 读者不会把对照结果误当成门禁判据。判据仍是词法器，这里只负责把盲区照亮。
  let crossCheckFailures = 0;
  if (astCrossCheck) {
    const crossCheck = await crossCheckFunctionSpans({ root, files });
    console.log("");
    console.log("AST 交叉校验（--ast-cross-check：只做对照，不切换判据；阈值与上面相同）");
    for (const line of formatFunctionSpanCrossCheck(crossCheck)) console.log(line);
    crossCheckFailures = crossCheck.overLimitOnlyAstUnexempt.length;
  }

  const reasons = [];
  if (violations.length > 0) reasons.push("行数门禁违规 " + violations.length + " 条");
  if (crossCheckFailures > 0) {
    reasons.push("AST 交叉校验发现词法器漏报的真实超限 " + crossCheckFailures + " 条");
  }
  if (reasons.length === 0) return;
  if (reportOnly) {
    console.log("（--report：仅报告，不设置失败退出码）");
    return;
  }
  console.log("门禁未通过：" + reasons.join("；") + "。请按上面的清单处理，或用 --report 仅查看。");
  process.exitCode = 1;
}

// 只有被当作脚本直接执行时才跑 CLI；被测试 import 时不产生副作用
// （测试 import 本模块只是为了拿纯函数与常量，不应触发打印或退出码）。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
