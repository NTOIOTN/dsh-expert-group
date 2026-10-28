#!/usr/bin/env node
/**
 * 发布 client bundle 的确定性装配（构建边界）。
 *
 * 背景：DSH 的客户端模块图只加载 package exports["./client"] 指向的**一个 classic
 * bundle**，浏览器 classic script 又不支持 `import`/`export`，所以 freshness/RPC 的
 * ESM 权威实现（client-freshness.js）不能直接出现在发布产物里，必须由本脚本在构建期
 * 投影成 classic 片段。
 *
 * 本脚本是唯一的构建边界，做四件事：
 * 1. **生成**：把 client-freshness.js 投影成 classic 片段（去掉行首 `export ` 前缀 +
 *    追加"检查点 + ModuleLoader 登记"尾部），排在唯一 descriptor 之前执行。投影不改写
 *    任何函数体，遇到无法识别的 ESM 语法直接抛错，绝不产出"半投影"。
 * 2. **压缩**：每个源文件先剥离整行注释（`stripWholeLineComments`），再由纯函数
 *    `compactClientCode` 删除代码区的行首缩进、纯空白行、行尾空白，以及**保守的
 *    token 边界空白**（只在删除不会改变词法 token 序列的位置删，保留位收敛为一个空格）。
 *    压缩发生在段结构/语法/行为校验**之前**，因此"被校验的正文"就是"写盘正文"；字符串、
 *    模板文本、正则、注释与 `/* source: <name> *\/` 段标记逐字节保留，换行一个不删，
 *    产物仍是可调试的 classic script（不做标识符改名 / token 合并 / AST 重写）。
 * 3. **门禁**：校验发布 bundle 的装载契约（投影位置、登记语句、client.js 的转发 seam、
 *    descriptor 里不得再有第二份实现）与 classic script 语法（用 Script 目标编译一次，
 *    浏览器就是按这个目标解析它的）。
 * 4. **行为核对**：把刚生成的投影片段放进最小 global 替身真实执行一次，用同一份一致性
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
 *    `>=0.2.1-rc.1`，README 声明的目标运行时同为 `0.2.1-rc.1` / `0.2.1-rc.2`；宿主只加载
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
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
// 装配顺序的**唯一事实源**是 manifest（R0 票据 03）：本脚本只派生、不复制。
// manifest 只导出冻结数据（不读文件、不跑构建），因此在这里 import 不会产生副作用。
import {
  assemblyOrder as MANIFEST_ASSEMBLY_ORDER,
  descriptorSource as MANIFEST_DESCRIPTOR_SOURCE,
  freshnessSource as MANIFEST_FRESHNESS_SOURCE,
  iifeSources as MANIFEST_IIFE_SOURCES,
  projectedSources as MANIFEST_PROJECTED_SOURCES,
} from "./client-source-manifest.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

/**
 * 浏览器安全的 classic IIFE 源，按数组顺序执行（顺序来自 manifest）。
 * 这些片段各自把实现挂到 `globalThis[Symbol.for("dsh-expert-group/<name>")]`，
 * client.js 的 factory 只从那里取回实现，因此必须排在唯一 descriptor 之前。
 */
const IIFE_SOURCES = MANIFEST_IIFE_SOURCES;

/**
 * freshness/RPC 的 ESM 权威实现（来自 manifest）。构建期投影成 classic 片段，让真实发布
 * bundle 也通过 ModuleLoader seam 装载共享实现；必须排在唯一 descriptor 之前，登记才来得及生效。
 */
const FRESHNESS_SOURCE = MANIFEST_FRESHNESS_SOURCE;

/** 唯一 ModuleLoader descriptor（client.js，来自 manifest）始终最后执行，避免 HMR 留下重复子模块工厂。 */
const DESCRIPTOR_SOURCE = MANIFEST_DESCRIPTOR_SOURCE;

/**
 * 可投影 ESM 源（来自 manifest，票据 01 第二单元）：每项 `{ source, checkpointKey, exports }`。
 * 这些模块只有一份 ESM 权威实现，装配器按清单**逐行机械投影**成 classic 片段，
 * 仓库里不保留、也不接受第二份手写实现。
 */
const PROJECTED_SOURCES = MANIFEST_PROJECTED_SOURCES;

/** 源名 → 投影描述：段渲染按名字分派，避免每段线性查找。 */
const PROJECTED_BY_SOURCE = new Map(PROJECTED_SOURCES.map((entry) => [entry.source, entry]));

/** 装配顺序本身（manifest 已冻结；这里不再二次复制成新数组，保持"唯一事实源"可追溯）。 */
const sourceNames = MANIFEST_ASSEMBLY_ORDER;
const outputName = "client-bundle.js";
/** 新版宿主（DSH 0.2.x web boot）约定的客户端入口文件名。 */
const entryOutputName = "client.js";
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
 * 整行注释剥离（构建期压缩，ticket 17）。
 *
 * 为什么只剥"整行注释"而不做标识符改名/空白折叠：发布 bundle 同时是**可调试产物**
 * （仓库内保留未压缩源，见 ticket 17 决策），而且大量既有回归用例通过
 * `content.includes("代码行原文")` 锁定实现契约——保留代码行原文让这些断言继续有效，
 * 只删除注释就足以达到体积硬指标（实测注释占源文件约 46%）。
 *
 * 判定规则（全部只影响"整行"注释，绝不改写代码行）：
 * 1. 物理行去掉首尾空白后以 `//` 开头 ⇒ 整行删除（含行尾换行）；
 * 2. 物理行以 `/*` 开头、且注释在同一行或后续行闭合后**该行剩余只有空白** ⇒ 整段行删除；
 * 3. 其它情况（行内注释、代码后注释、注释后还有代码）一律原样保留。
 *
 * 字符串 / 模板字符串 / 正则字面量里的 `//` 与 `/*` 不是注释，必须保持原样：因此用
 * 一个最小词法状态机（模板 `${}` 嵌套、引号转义、正则字符类）决定"当前是否处于代码
 * 模式"，而不是按行做正则匹配。构建末尾还有 classic 语法校验与行为核对兜底。
 *
 * @param {string} source - 源文件原文。
 * @returns {{ text: string, removedCharacters: number, removedLines: number }}
 */
export function stripWholeLineComments(source) {
  if (typeof source !== "string") {
    throw new TypeError("stripWholeLineComments 只接受源码字符串，收到 " + typeof source);
  }
  const length = source.length;
  const pieces = [];
  let emitFrom = 0;
  let removedCharacters = 0;
  let removedLines = 0;

  // 词法栈：栈顶是 "template" 时处于模板文本；"brace" 代表代码模式里的花括号层级
  // （模板里的 `${ ... }` 也压一层 "brace"，闭合后自然回到模板文本）。
  const stack = [];
  let index = 0;
  // 当前物理行起点，以及本行是否已经出现过代码 token（决定"整行"判定）。
  let lineStart = 0;
  let lineHasCode = false;

  /** 把 [start, end) 这段物理行标记为待删除；区间按扫描顺序单调递增。 */
  const markRemovable = (start, end) => {
    const from = start < emitFrom ? emitFrom : start;
    if (end <= from) return;
    pieces.push(source.slice(emitFrom, from));
    removedCharacters += end - from;
    for (let at = from; at < end; at += 1) if (source[at] === "\n") removedLines += 1;
    emitFrom = end;
  };

  /** 跳过一段非注释 token 后，把行状态同步到 token 末尾所在行。 */
  const syncLineState = () => {
    const newline = source.lastIndexOf("\n", index - 1);
    if (newline >= lineStart) {
      lineStart = newline + 1;
      // token 里出现换行只可能是字符串续行/块注释，行内必然已有代码。
      lineHasCode = true;
    }
  };

  while (index < length) {
    const ch = source[index];
    if (stack.length > 0 && stack[stack.length - 1] === "template") {
      // ── 模板文本：只有 ` 结束、${ 进入代码，其余字节（含 // 与 /*）全是普通字符 ──
      if (ch === "\\") { index += 2; syncLineState(); continue; }
      if (ch === "`") { stack.pop(); index += 1; lineHasCode = true; continue; }
      if (ch === "$" && source[index + 1] === "{") { stack.push("brace"); index += 2; lineHasCode = true; continue; }
      if (ch === "\n") { lineStart = index + 1; lineHasCode = false; }
      index += 1;
      continue;
    }

    // ── 代码模式 ──
    if (ch === "\n") { lineStart = index + 1; lineHasCode = false; index += 1; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { index += 1; continue; }

    if (ch === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      const lineEnd = newline === -1 ? length : newline + 1;
      // 本行此前只有空白 ⇒ 整行都是注释，可以整行删除（行尾换行一并删除）。
      if (!lineHasCode) markRemovable(lineStart, lineEnd);
      index = lineEnd;
      lineStart = lineEnd;
      lineHasCode = false;
      continue;
    }

    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw new Error("源码存在未闭合的块注释（偏移 " + index + "）");
      const afterComment = close + 2;
      if (!lineHasCode) {
        const newline = source.indexOf("\n", afterComment);
        const lineEnd = newline === -1 ? length : newline + 1;
        // 注释闭合后本行只剩空白才算"整段整行注释"；否则保留（行内注释）。
        if (source.slice(afterComment, newline === -1 ? length : newline).trim() === "") {
          markRemovable(lineStart, lineEnd);
          index = lineEnd;
          lineStart = lineEnd;
          lineHasCode = false;
          continue;
        }
      }
      index = afterComment;
      syncLineState();
      lineHasCode = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      index = skipQuotedString(source, index, ch);
      syncLineState();
      lineHasCode = true;
      continue;
    }

    if (ch === "`") {
      stack.push("template");
      index += 1;
      lineHasCode = true;
      continue;
    }

    if (ch === "/" && isRegexLiteralStart(source, index)) {
      index = skipRegexLiteral(source, index);
      syncLineState();
      lineHasCode = true;
      continue;
    }

    if (ch === "{") { stack.push("brace"); index += 1; lineHasCode = true; continue; }
    if (ch === "}") {
      if (stack.length > 0 && stack[stack.length - 1] === "brace") stack.pop();
      index += 1;
      lineHasCode = true;
      continue;
    }

    index += 1;
    lineHasCode = true;
  }

  pieces.push(source.slice(emitFrom));
  return Object.freeze({ text: pieces.join(""), removedCharacters, removedLines });
}

/**
 * 段标记行的唯一形态（装配器自己生成的那种）：整行只有 `/* source: <name> *\/`。
 * 压缩必须逐字节保留它——段边界是装配契约，被改写（哪怕只删缩进）就等于换了产物格式。
 */
const SEGMENT_MARKER_LINE = /^\/\* source: [^\n]*\*\/[ \t]*$/;

/**
 * 字词字符：标识符/数字/Unicode 标识符字符、私有名 `#`、标识符转义 `\` 与 ZWNJ/ZWJ。
 * 两个这样的字符相邻时中间必须有空白，否则会被词法器读成同一个 token。
 */
const WORD_CHARACTER = /[\p{L}\p{N}\p{Mn}\p{Mc}\p{Pc}_$#\\\u200C\u200D]/u;

/** 判断单个字符是否属于"字词字符"集合（空串不算）。 */
function isWordCharacter(character) {
  return character !== "" && WORD_CHARACTER.test(character);
}

/** 取 index 之前的一个完整字符（跨代理对）；行首返回空串。 */
function characterBefore(source, index) {
  if (index <= 0) return "";
  const low = source.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = source.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return source.slice(index - 2, index);
  }
  return source[index - 1];
}

/** 取 index 处的一个完整字符（跨代理对）；越界返回 undefined。 */
function characterAt(source, index) {
  if (index >= source.length) return undefined;
  return String.fromCodePoint(source.codePointAt(index));
}

/**
 * 判断把 previous 与 next 直接拼在一起会不会得到不同的词法 token。
 *
 * 只覆盖"两个独立 token 相邻后会粘成另一个 token / 注释 / 数字"的真实风险：
 * punctuator 的最大吞噬、注释起始（`//`、`/*`）、HTML 注释起始（`<!--`）、
 * 可选链（`?.`）与数字后紧跟 `.` 的字面量歧义。
 * 这里刻意宁多勿少：多保留一个空格不改变语义，少保留一个可能悄悄改变程序。
 *
 * @param {string} previous - run 前一个字符（非空白）。
 * @param {string} next - run 后一个字符（非空白）。
 * @returns {boolean}
 */
function wouldMergeIntoDifferentToken(previous, next) {
  if (previous === "+" && next === "+") return true;
  // `- -` 会变自减；`- >` 参与 `-->`（Annex B 的 HTML 关闭注释）风险，一并保留。
  if (previous === "-" && (next === "-" || next === ">")) return true;
  // `/ /` 与 `/ *` 会变注释；`/=` 会变复合赋值（防御性覆盖）。
  if (previous === "/" && (next === "/" || next === "*" || next === "=")) return true;
  if (previous === "*" && (next === "*" || next === "=")) return true;
  if (previous === "%" && next === "=") return true;
  if (previous === "&" && (next === "&" || next === "=")) return true;
  if (previous === "|" && (next === "|" || next === "=")) return true;
  if (previous === "^" && next === "=") return true;
  if (previous === "=" && (next === "=" || next === ">")) return true;
  if (previous === "!" && next === "=") return true;
  // `< !` 会开始 `<!--`（HTML 开放注释），不能再合并。
  if (previous === "<" && (next === "<" || next === "=" || next === "!")) return true;
  if (previous === ">" && (next === ">" || next === "=")) return true;
  if (previous === "?" && (next === "?" || next === ".")) return true;
  if (previous === "." && next === ".") return true;
  // 数字字面量与点相邻：`1 .toString()` 合法，`1.toString()` 是语法错误；`.5` 是数字。
  if (/[0-9]/.test(previous) && next === ".") return true;
  if (previous === "." && /[0-9]/.test(next)) return true;
  return false;
}

/**
 * 判断 token 边界上的空白 run 是否可以整体删除。
 *
 * 两个条件必须同时满足才允许删除：
 * 1. 两侧不同时是字词字符（否则会合并成一个标识符/数字）；
 * 2. 两侧不会因为相邻而合成更长的 token / 注释 / 数字（见
 *    {@link wouldMergeIntoDifferentToken}）。
 * 其余情况保留一个空格——这是"可证明安全"的保守子集，不追求极限压缩。
 */
function canDropTokenSpace(previous, next) {
  if (previous === "" || next === undefined) return false;
  if (isWordCharacter(previous) && isWordCharacter(next)) return false;
  return !wouldMergeIntoDifferentToken(previous, next);
}

/**
 * 把一段"契约片段"按产物同一套规则压缩。
 *
 * 门禁/生成共用同一份常量（CHECKPOINT_STATEMENT 等），但产物正文是压缩后的形态；
 * 比较双方都套一层压缩，既保留常量可读的书写形式，又不会因为压缩规则而误报。
 */
function compactBundleFragment(fragment) {
  return compactClientCode(fragment).text;
}

/**
 * 代码区空白压缩（构建期第二步，把发布体积拉回门禁富余之内）。
 *
 * 与 {@link stripWholeLineComments} 的分工：那一步只删"整行注释"，这一步只动**代码区**的
 * 空白。压缩分两类：结构空白（行首缩进、纯空白行、行尾空白）与**token 边界空白**
 * （相邻 token 之间、删掉不会改变词法的那一个空格）。产物仍是可解析、可调试的 classic
 * script——没有标识符改名、没有 token 合并、没有 AST 重写。
 *
 * 允许删除的字节（全部只在代码模式生效）：
 * 1. 代码行的**行首缩进**（行首空格/制表符）；
 * 2. **纯空白行**（整行只有空格/制表符，连同该行的换行一起删除）；
 * 3. **行尾空白**（换行/EOF 之前的空格与制表符）；
 * 4. **token 边界空白**：逗号/分号/冒号/括号/方括号/大括号、属性访问点、比较/相等/
 *    逻辑/算术运算符、问号/冒号与箭头两侧的空格；只有 {@link canDropTokenSpace}
 *    判定"删掉也不会改变词法"时才删，保留位收敛为一个空格。
 *
 * 保留空格的唯一判据（保守优先，拿不准就保留一个空格）：
 * - 两侧都是字词字符（标识符/数字/Unicode 标识符字符、`_`、`$`、`#`、`\`）时保留，
 *   因此 `return x`、`new Foo`、`typeof x`、`let x`、`a in b`、`async function`
 *   不会被拼成 `returnx` 这类新 token；
 * - 两侧字符拼接后可能形成更长的 punctuator、注释起始或数字字面量时保留：
 *   `+ +` / `- -`（不能变 `++` / `--`）、`/ /`、`/ *`（不能变注释）、`< <`、
 *   `= =`、`? .`（不能变可选链）、数字与 `.`（`1 .toString()` 不能被拼成
 *   `1.toString()`）等，完整清单见 {@link wouldMergeIntoDifferentToken}。
 * 其余位置的空白 run 整段删除；保留的 run 收敛为一个空格 ⇒ 输出幂等。
 *
 * 绝不能动的区域（沿用剥离注释的同一套最小词法状态机判定，而不是按行做正则匹配）：
 * - 单/双引号字符串（含反斜杠续行里的缩进，整段 token 原样拷贝）；
 * - 模板字符串的**文本部分**：多行缩进、空行、`//`、`/*` 全是内容，逐字节保留；
 *   `${` 之内是代码，可以按代码规则压缩（表达式语义不变）；
 * - 正则字面量（字符类、转义、内部的 `//` 与 `/*` 都是内容）；
 * - 注释文本（行内注释/块注释）原样拷贝，绝不把 `//` 之后的内容当代码压缩；
 * - {@link SEGMENT_MARKER_LINE} 段标记行：连行首缩进一起整行原样保留；
 * - 所有换行（只删"整行本来就是空白"的那一行）：ASI / 正则/除号判定与压缩前一致。
 *
 * 安全边界（为什么不会改变行为）：
 * - 只删空白字符，从不删代码 token；换行只在"整行本来就是空白"时被删，因此不存在
 *   把两行代码拼到同一行的路径；
 * - token 边界判定只做保守的"能删吗"：删除后的相邻字符不可能组成新的标识符、数字、
 *   punctuator 或注释起始，所以词法 token 序列与压缩前一致；
 * - 字符串、模板文本、正则的内容逐字节不变 ⇒ 字面量值与选择器常量不变；
 * - 幂等：对压缩结果再压一次逐字节相同且 removedCharacters === 0，构建才能维持
 *   "校验对象 = 写盘内容"（否则二次压缩会让校验文本与落盘文本分叉）。
 *
 * @param {string} source - 源码文本（构建里是 stripWholeLineComments 的产物）。
 * @returns {{ text: string, removedCharacters: number, removedIndentCharacters: number, removedBlankLines: number, removedTokenSpaces: number }}
 */
export function compactClientCode(source) {
  if (typeof source !== "string") {
    throw new TypeError("compactClientCode 只接受源码字符串，收到 " + typeof source);
  }
  const length = source.length;
  const pieces = [];
  // 词法栈与 stripWholeLineComments 同构：栈顶是 "template" 表示模板文本；
  // 其余（空栈或 "brace"）都是代码区，模板里的 `${` 也压一层 "brace"。
  const stack = [];
  let index = 0;
  let atLineStart = true;
  let removedCharacters = 0;
  let removedIndentCharacters = 0;
  let removedBlankLines = 0;
  // token 边界空白（行内两个 token 之间）删掉/收敛掉的字符数：构建日志单独报账。
  let removedTokenSpaces = 0;

  const emit = (text) => pieces.push(text);

  /** 返回 at 处的换行序列长度（"\n" 或 "\r\n"），不是换行返回 0。 */
  const newlineAt = (at) => {
    if (source[at] === "\n") return 1;
    if (source[at] === "\r" && source[at + 1] === "\n") return 2;
    return 0;
  };

  /**
   * 处理"行首"：段标记行整行保留；纯空白行整行删除；普通代码行只删行首缩进。
   * 返回后 index 一定停在"本行尚未输出的第一个字节"上，调用方据此判断是否继续扫。
   */
  const consumeLineStart = () => {
    let probe = index;
    while (probe < length && (source[probe] === " " || source[probe] === "\t")) probe += 1;
    // ── 段标记行：连行首缩进与换行一起逐字节保留（装配契约，不接受任何改写）──
    if (source.startsWith("/* source: ", probe)) {
      let lineEnd = probe;
      while (lineEnd < length && newlineAt(lineEnd) === 0) lineEnd += 1;
      if (SEGMENT_MARKER_LINE.test(source.slice(probe, lineEnd))) {
        const newlineLength = newlineAt(lineEnd);
        emit(source.slice(index, lineEnd + newlineLength));
        index = lineEnd + newlineLength;
        atLineStart = true;
        return;
      }
    }
    const indent = probe - index;
    const newlineLength = newlineAt(probe);
    if (newlineLength > 0) {
      // ── 纯空白行（含完全空行）：整行删除 ──
      // 删除的只是一个"没有 token 的行"，相邻两行之间仍各自带着自己的换行，
      // 因此不存在把两行代码拼到一起的路径（ASI 安全性依赖的正是这一点）。
      removedBlankLines += 1;
      removedCharacters += indent + newlineLength;
      removedIndentCharacters += indent;
      index = probe + newlineLength;
      atLineStart = true;
      return;
    }
    if (probe >= length) {
      // 文件末尾的纯空白尾巴：删掉（不会产生空行，也不需要补换行）。
      removedCharacters += indent;
      removedIndentCharacters += indent;
      index = length;
      atLineStart = false;
      return;
    }
    // ── 普通代码行：删除行首缩进，其余字节保持原样 ──
    removedCharacters += indent;
    removedIndentCharacters += indent;
    index = probe;
    atLineStart = false;
  };

  while (index < length) {
    if (stack.length > 0 && stack[stack.length - 1] === "template") {
      // ── 模板文本：逐字节原样输出（缩进、空行、//、/* 都是模板内容）──
      const ch = source[index];
      if (ch === "\\") { emit(source.slice(index, index + 2)); index += 2; continue; }
      if (ch === "`") { emit("`"); stack.pop(); index += 1; atLineStart = false; continue; }
      if (ch === "$" && source[index + 1] === "{") { emit("${"); stack.push("brace"); index += 2; atLineStart = false; continue; }
      const newlineLength = newlineAt(index);
      if (newlineLength > 0) { emit(source.slice(index, index + newlineLength)); index += newlineLength; atLineStart = true; continue; }
      emit(ch);
      index += 1;
      continue;
    }

    // ── 代码区 ──
    if (atLineStart) {
      consumeLineStart();
      // 纯空白行/段标记行已经整行消费完；普通代码行则落到下面继续扫本行内容。
      if (atLineStart || index >= length) continue;
    }

    const ch = source[index];
    const newlineLength = newlineAt(index);
    if (newlineLength > 0) { emit(source.slice(index, index + newlineLength)); index += newlineLength; atLineStart = true; continue; }

    if (ch === " " || ch === "\t") {
      // 行内空白 run：先处理"行尾空白"（后面就是换行或 EOF）——这类只删不保留。
      let probe = index;
      while (probe < length && (source[probe] === " " || source[probe] === "\t")) probe += 1;
      const runLength = probe - index;
      if (probe >= length || newlineAt(probe) > 0) {
        removedCharacters += runLength;
        index = probe;
        continue;
      }
      // token 边界：两侧字符决定这个 run 是"可删的分隔"还是"必需的词法分隔"。
      // 前一个字符一定是非空白（run 是连续消费的），后一个字符也一定不是换行。
      const previousCharacter = characterBefore(source, index);
      const nextCharacter = characterAt(source, probe);
      if (canDropTokenSpace(previousCharacter, nextCharacter)) {
        removedCharacters += runLength;
        removedTokenSpaces += runLength;
        index = probe;
        continue;
      }
      // 必须保留词法分隔：收敛成一个空格（多空格归一也是幂等性的一部分）。
      if (runLength > 1) {
        removedCharacters += runLength - 1;
        removedTokenSpaces += runLength - 1;
      }
      emit(" ");
      index = probe;
      continue;
    }

    if (ch === "/" && source[index + 1] === "/") {
      // 行内注释：注释文本原样保留（不折叠、不改写），只把整行交给扫描器跳过。
      let end = source.indexOf("\n", index);
      if (end === -1) end = length;
      emit(source.slice(index, end));
      index = end;
      continue;
    }

    if (ch === "/" && source[index + 1] === "*") {
      // 块注释：整段原样保留（可能跨行，内部缩进属于注释文本，不做压缩）。
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw new Error("源码存在未闭合的块注释（偏移 " + index + "）");
      emit(source.slice(index, close + 2));
      index = close + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      // 字符串 token 整体拷贝：单行字符串、反斜杠续行里的缩进都逐字节保留。
      const end = skipQuotedString(source, index, ch);
      emit(source.slice(index, end));
      index = end;
      continue;
    }

    if (ch === "`") { emit("`"); stack.push("template"); index += 1; continue; }

    if (ch === "/" && isRegexLiteralStart(source, index)) {
      // 正则整体拷贝：字符类、转义、内部的 // 与 /* 都属于字面量内容。
      const end = skipRegexLiteral(source, index);
      emit(source.slice(index, end));
      index = end;
      continue;
    }

    if (ch === "{") { stack.push("brace"); emit("{"); index += 1; continue; }
    if (ch === "}") {
      if (stack.length > 0 && stack[stack.length - 1] === "brace") stack.pop();
      emit("}");
      index += 1;
      continue;
    }

    emit(ch);
    index += 1;
  }

  return Object.freeze({
    text: pieces.join(""),
    removedCharacters,
    removedIndentCharacters,
    removedBlankLines,
    removedTokenSpaces,
  });
}

/** 正则字面量前允许出现的关键字：这些 token 之后一个 `/` 一定是正则而不是除号。 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/**
 * 判断某个 `/` 是正则字面量的开始还是除号。
 *
 * 词法上只有"此处允许表达式开始"才是正则；这里用最小回溯：前一个非空白字符若属于
 * 运算符/开括号集合，或前一个单词是关键字，就是正则；标识符、`)`、`]`、数字之后是除号。
 */
function isRegexLiteralStart(source, slashIndex) {
  let at = slashIndex - 1;
  while (at >= 0 && /\s/.test(source[at])) at -= 1;
  if (at < 0) return true;
  const previous = source[at];
  if (previous === ")" || previous === "]") return false;
  if (/[A-Za-z0-9_$]/.test(previous)) {
    let wordStart = at;
    while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
    return REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, at + 1));
  }
  return true;
}

/** 跳过单/双引号字符串（含转义与续行），返回结束引号之后的偏移。 */
function skipQuotedString(source, startIndex, quote) {
  let at = startIndex + 1;
  while (at < source.length) {
    const ch = source[at];
    if (ch === "\\") { at += 2; continue; }
    if (ch === quote) return at + 1;
    at += 1;
  }
  return at;
}

/** 跳过正则字面量（含字符类里的 `/` 与转义），返回 flags 之后的偏移。 */
function skipRegexLiteral(source, startIndex) {
  let at = startIndex + 1;
  let inClass = false;
  while (at < source.length) {
    const ch = source[at];
    if (ch === "\\") { at += 2; continue; }
    if (ch === "[") { inClass = true; at += 1; continue; }
    if (ch === "]") { inClass = false; at += 1; continue; }
    if (ch === "/" && !inClass) { at += 1; break; }
    if (ch === "\n") return at; // 未闭合的正则：就地放弃，绝不吞掉后续行
    at += 1;
  }
  while (at < source.length && /[a-z]/i.test(source[at])) at += 1;
  return at;
}

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
  // 段尾的包装行（`(function ...(global) {`）与装载语句都是装配器现场生成的；
  // 它们同样要过 compactClientCode，否则产物里会残留"可压缩但没压缩"的空格，
  // 第二次压缩就会改动写盘正文，破坏"校验对象 = 写盘内容"的不动点契约。
  return compactBundleFragment([
    "/* source: " + name + " */",
    "/* classic 投影：来自源文件的机械导出改写，权威实现仍是 " + name + "。 */",
    "(function installClientFreshness(global) {",
    '"use strict";',
    projection.body.trimEnd(),
    // 不插入空白行：生成段同样要满足"产物是压缩不动点"（compactClientCode 会删纯空白行）。
    "/** 投影尾部（构建期生成）：公开检查点 + ModuleLoader 登记。 */",
    // 生成的装载语句同样要过压缩：否则产物就不是 compactClientCode 的不动点
    // （"校验对象 = 写盘内容"要求压缩必须覆盖到每一段正文）。
    compactBundleFragment(CHECKPOINT_STATEMENT),
    compactBundleFragment(REGISTER_STATEMENT),
    "})(globalThis);",
    "",
  ].join("\n"));
}

/**
 * 通用 ESM → classic 机械投影（票据 01 第二单元）。
 *
 * 与 {@link projectClientFreshnessSource} 的分工：那个是 freshness 的**专用**投影（尾部还要
 * 登记 ModuleLoader，属装配契约的一部分，本函数不复用也不改写它）；本函数只处理 manifest
 * `projectedSources` 登记的共享模块——逐行剥掉行首 `export ` 前缀，其它字节原样保留。
 *
 * 为什么必须"机械"：这些模块的语义由 ESM 权威实现独占（Host 校验、客户端界面、投影段
 * 共用同一份规则）。任何"顺手优化/改写成 classic 风格"的投影都会重新制造两份实现，
 * 而两份实现只会在后续提交里各自漂移。因此这里只做三类判定，全部失败即抛错：
 * 1. 行首 ESM 关键字残留（`import` / `export default` / `export {}` / 缩进的 export）；
 * 2. 无法解析的导出声明形式（只接受 `[async] function|const|let|var|class <name>`）；
 * 3. 缺少 manifest 声明为必需的导出名。
 *
 * @param {string} source - 权威实现的源码文本（构建里已剥离注释并压缩空格）。
 * @param {{ name?: string, requiredExports?: readonly string[] }} [options] - name 用于报错定位；
 *   requiredExports 缺一即失败（由 manifest.projectedSources[].exports 决定）。
 * @returns {{ body: string, exports: readonly string[] }} 去掉 `export ` 前缀的正文与实际导出名。
 */
export function projectEsmSource(source, { name, requiredExports } = {}) {
  if (typeof source !== "string") {
    throw new TypeError("projectEsmSource 只接受源码字符串，收到 " + typeof source);
  }
  const label = typeof name === "string" && name.length > 0 ? name : "<未命名源>";
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
  // 注释/字符串里出现 import/export 不算违规，所以只判定"行首 ESM 关键字"。
  const leftover = /(?:^|\n)[ \t]*(?:import|export)\b/.exec(body);
  if (leftover !== null) {
    throw new Error(label + " 投影后仍残留 ESM 语法: " + leftover[0].trim());
  }
  for (const required of requiredExports ?? []) {
    if (!exported.includes(required)) {
      throw new Error(label + " 缺少必需导出 " + required + "（检查点与使用方都依赖同一份实现）");
    }
  }
  return Object.freeze({ body, exports: Object.freeze(exported) });
}

/**
 * 生成投影段尾部的检查点赋值语句。
 *
 * 渲染与门禁共用同一份书写形式（两侧再各自过 compactBundleFragment 收敛空白），
 * 避免"渲染写了一种形态、门禁按另一种形态去搜"这种两边一起漂的假绿灯。
 *
 * @param {string} checkpointKey - `Symbol.for(<key>)` 的键（manifest.projectedSources）。
 * @param {readonly string[]} exportNames - 检查点对象上的键（与 ESM 导出同名，简写属性）。
 */
function projectedCheckpointStatement(checkpointKey, exportNames) {
  return "globalThis[Symbol.for(" + JSON.stringify(checkpointKey) + ")] = Object.freeze({ "
    + exportNames.join(", ") + " });";
}

/**
 * 投影源 IIFE 的安装函数名：只由源路径派生。
 *
 * 不引入时间/随机数/计数器，保证同一份源码每次构建得到逐字节相同的产物（SHA 可复现）。
 *
 * @param {string} name - 源文件仓库相对路径。
 */
function projectedInstallerName(name) {
  const sanitized = String(name).replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return "installProjectedSource" + (sanitized.length > 0 ? "_" + sanitized : "");
}

/**
 * 渲染一个"可投影 ESM 源"的 classic 投影片段。
 *
 * 与 freshness 投影的差别只有尾部：这里**不登记** ModuleLoader，只把同一份导出面挂到
 * `globalThis[Symbol.for(checkpointKey)]`。因此段本身是纯赋值 IIFE，重复执行幂等
 * （HMR 重放同一份 bundle 只会覆盖同一个 Symbol，不会像重复登记那样抛错）。
 *
 * @param {{ name: string, source: string, checkpointKey: string, exports: readonly string[] }} options
 *   checkpointKey / exports 来自 manifest；source 是已剥离注释并压缩过空白的正文。
 */
export function renderProjectedSourceSegment({ name, source, checkpointKey, exports }) {
  if (typeof checkpointKey !== "string" || checkpointKey.length === 0) {
    throw new Error(name + " 缺少检查点键（必须由 manifest.projectedSources 声明）");
  }
  if (!Array.isArray(exports) || exports.length === 0) {
    throw new Error(name + " 缺少导出清单（必须由 manifest.projectedSources 声明）");
  }
  const projection = projectEsmSource(source, { name, requiredExports: exports });
  // 段尾的包装行与检查点语句都是装配器现场生成的：它们同样要过 compactClientCode，
  // 否则产物会残留"可压缩但没压缩"的空白，第二次压缩就会改动写盘正文，破坏
  // "校验对象 = 写盘内容"的不动点契约（与 freshness 段同一处理）。
  return compactBundleFragment([
    "/* source: " + name + " */",
    "/* classic 投影：来自 " + name + " 的机械导出改写，权威实现仍是该 ESM 文件。 */",
    "(function " + projectedInstallerName(name) + "() {",
    '"use strict";',
    projection.body.trimEnd(),
    "/** 投影尾部（构建期生成）：公开检查点（与 ESM 导出面同形）。 */",
    compactBundleFragment(projectedCheckpointStatement(checkpointKey, exports)),
    "})();",
    "",
  ].join("\n"));
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
 * 固定探针输入：全部是不可变常量；Date 在每次运行探针时新建（不跨探针共享可变对象）。
 * 时间段形状覆盖"单段 / 跨午夜 / 并集覆盖全天 / 中间有缺口"四类真实配置。
 */
const PROJECTED_PROBE_PERIODS = Object.freeze({
  earlyPeak: Object.freeze([Object.freeze({ start: "08:00", end: "10:00" })]),
  crossMidnight: Object.freeze([Object.freeze({ start: "23:00", end: "02:00" })]),
  fullDay: Object.freeze([
    Object.freeze({ start: "00:00", end: "12:00" }),
    Object.freeze({ start: "12:00", end: "00:00" }),
  ]),
  gapped: Object.freeze([
    Object.freeze({ start: "00:00", end: "11:00" }),
    Object.freeze({ start: "12:00", end: "00:00" }),
  ]),
});

/**
 * 投影源行为探针（票据 01 第二单元）：输入固定、输出可 JSON 比较。
 *
 * 覆盖判定的全部口径：归一化的合法/非法、左闭右开（09:59 / 10:00）、跨午夜、
 * 0 段、覆盖全天 true/false、固定 Date 的本地墙钟判定、非法 Date 的 fail-closed
 * （含回调恰好一次）。每条探针只读导出面，确保"投影段与权威实现逐项相等"这件事
 * 不依赖任何宿主状态。
 */
const PROJECTED_SOURCE_PROBES = Object.freeze([
  Object.freeze({ label: "常量 MAX_PEAK_VALLEY_PERIODS", run: (face) => face.MAX_PEAK_VALLEY_PERIODS }),
  Object.freeze({ label: "常量 PEAK_VALLEY_PERIODS_INVALID", run: (face) => face.PEAK_VALLEY_PERIODS_INVALID }),
  Object.freeze({
    label: "归一化：合法输入（含跨午夜）保持原始顺序",
    run: (face) => face.normalizePeakValleyPeriods([
      { start: "23:00", end: "02:00" },
      { start: "08:00", end: "10:00" },
      { start: "09:00", end: "11:00" },
    ]),
  }),
  Object.freeze({
    label: "归一化：任一项非法即整体拒绝",
    run: (face) => face.normalizePeakValleyPeriods([
      { start: "08:00", end: "10:00" },
      { start: "8:00", end: "09:00" },
    ]),
  }),
  Object.freeze({ label: "归一化：缺省表示 0 条", run: (face) => face.normalizePeakValleyPeriods(undefined) }),
  Object.freeze({
    label: "判定：08:00–10:00 在 09:59 与 10:00（左闭右开）",
    run: (face) => [9 * 60 + 59, 10 * 60].map((minutes) => face.peakValleyAtMinutes(PROJECTED_PROBE_PERIODS.earlyPeak, minutes)),
  }),
  Object.freeze({
    label: "判定：非法 minutes 一律 fail-closed 为谷时（不抛异常）",
    run: (face) => [-1, 1440, 1.5, Number.NaN, "540", null].map(
      (minutes) => face.peakValleyAtMinutes(PROJECTED_PROBE_PERIODS.earlyPeak, minutes),
    ),
  }),
  Object.freeze({
    label: "判定：23:00–02:00 跨午夜（23:30 / 01:30 / 02:00）",
    run: (face) => [23 * 60 + 30, 60 + 30, 2 * 60].map((minutes) => face.peakValleyAtMinutes(PROJECTED_PROBE_PERIODS.crossMidnight, minutes)),
  }),
  Object.freeze({ label: "判定：0 条配置恒为谷时", run: (face) => face.peakValleyAtMinutes([], 9 * 60 + 30) }),
  Object.freeze({
    label: "覆盖全天：完整并集 true / 中间缺一段 false",
    run: (face) => [
      face.peakValleyPeriodsCoverFullDay(PROJECTED_PROBE_PERIODS.fullDay),
      face.peakValleyPeriodsCoverFullDay(PROJECTED_PROBE_PERIODS.gapped),
    ],
  }),
  Object.freeze({
    label: "Date：固定本地墙钟 09:30 / 10:00",
    run: (face) => [
      face.peakValleyAtDate(PROJECTED_PROBE_PERIODS.earlyPeak, new Date(2026, 0, 5, 9, 30, 0)),
      face.peakValleyAtDate(PROJECTED_PROBE_PERIODS.earlyPeak, new Date(2026, 0, 5, 10, 0, 0)),
    ],
  }),
  Object.freeze({
    label: "Date：非法 Date fail-closed 且回调恰好一次",
    run: (face) => {
      const calls = [];
      const result = face.peakValleyAtDate(PROJECTED_PROBE_PERIODS.earlyPeak, new Date(Number.NaN), {
        onInvalidDate: (value) => calls.push(Object.prototype.toString.call(value)),
      });
      return { result, calls };
    },
  }),
]);

/**
 * 构建期行为对照：在最小 global 替身里执行刚生成的投影片段，取回检查点导出面，
 * 与 ESM 权威实现在同一组固定探针上逐项比较，任何差异让构建失败。
 *
 * 与 {@link verifyFreshnessProjection} 同构：被执行的正是**要写盘的那一段**（不是重新渲染
 * 的副本），所以"通过对照的文本"与"发布出去的文本"始终是同一份。
 *
 * @param {{ segment: string, authorityModule: object, checkpointKey: string }} options
 *   authorityModule 是 ESM 权威实现的命名空间（由调用方 import；测试可注入替身）。
 * @returns {Promise<{ steps: number, checkpointKey: string }>}
 */
export async function verifyProjectedSourceProjection({ segment, authorityModule, checkpointKey } = {}) {
  if (typeof segment !== "string" || segment.length === 0) throw new Error("缺少待核对的 classic 投影片段");
  if (authorityModule === null || typeof authorityModule !== "object") {
    throw new Error("缺少 ESM 权威实现模块（无法做投影源对照）");
  }
  if (typeof checkpointKey !== "string" || checkpointKey.length === 0) throw new Error("缺少投影检查点键");
  const face = evaluateProjectedSegment(segment, checkpointKey);
  const differences = [];
  for (const probe of PROJECTED_SOURCE_PROBES) {
    // freezeForCompare：把 undefined / 函数 / 循环引用显式标记，并排序对象键，
    // 这样"两侧是同构结果"可以被一次 JSON 比较证明，而不依赖键序运气。
    const expected = freezeForCompare(probe.run(authorityModule));
    const actual = freezeForCompare(probe.run(face));
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      differences.push({ label: probe.label, left: expected, right: actual });
    }
  }
  if (differences.length > 0) {
    const detail = differences.slice(0, 5).map((difference) => {
      return "- " + difference.label + "\n  权威: " + JSON.stringify(difference.left)
        + "\n  投影: " + JSON.stringify(difference.right);
    }).join("\n");
    throw new Error("投影源 " + checkpointKey + " 与 ESM 权威实现已漂移（共 " + differences.length + " 项）:\n" + detail);
  }
  return Object.freeze({ steps: PROJECTED_SOURCE_PROBES.length, checkpointKey });
}

/**
 * 在最小 global 替身里执行投影片段，返回检查点导出面。
 *
 * 用 `new Function` 的参数遮蔽 `globalThis`：片段里的检查点赋值落在替身上，
 * 既不污染构建进程的全局，也不影响真实装载。
 *
 * @param {string} segment - classic 投影片段文本。
 * @param {string} checkpointKey - 检查点 Symbol 键。
 */
function evaluateProjectedSegment(segment, checkpointKey) {
  const sandboxGlobal = {};
  const run = new Function("globalThis", segment + "\nreturn globalThis;");
  const executed = run(sandboxGlobal);
  const face = executed[Symbol.for(checkpointKey)];
  if (face === null || typeof face !== "object") {
    throw new Error("投影片段未落地检查点（globalThis Symbol 上没有导出面）: " + checkpointKey);
  }
  return face;
}

/**
 * 发布 bundle 的装载契约门禁：投影位置、登记语句、client.js 的转发 seam，以及
 * "descriptor 段里不得再有第二份 freshness 实现"。
 * seam 一旦变化（不再 require 该模块、或又写回内联实现），行为核对与客户端测试都必须同步，
 * 因此这里让构建直接失败，而不是悄悄退化成"两份实现各自漂移"。
 *
 * ticket 17 起门禁改吃**结构元数据**（装配器给出的 segments：段名、段序、段文本）而不是
 * 对整份正文做任意字符串搜索：体积压缩会改写注释，但段的存在性/顺序属于装配契约，
 * 必须由生成它的那一方直接说明，而不是事后到 670KB 文本里反查。
 *
 * @param {ReadonlyArray<{ name: string, marker: string, text: string }>} segments - 装配段。
 * @returns {{ freshnessIndex: number, descriptorIndex: number }}
 */
function verifyClientBundleContract(segments) {
  if (!Array.isArray(segments) || segments.length !== sourceNames.length) {
    throw new Error("装配段的段数与拼接顺序不一致: " + JSON.stringify(segments.map((segment) => segment?.name)));
  }
  const names = segments.map((segment) => segment.name);
  if (names.join(",") !== sourceNames.join(",")) {
    throw new Error("装配段的段序与 sourceNames 不一致: " + names.join(","));
  }
  const freshnessIndex = names.indexOf(FRESHNESS_SOURCE);
  const descriptorIndex = names.indexOf(DESCRIPTOR_SOURCE);
  if (freshnessIndex === -1) throw new Error("发布 bundle 缺少 " + FRESHNESS_SOURCE + " 的 classic 投影段");
  if (descriptorIndex === -1) throw new Error("发布 bundle 缺少 " + DESCRIPTOR_SOURCE + " 的 descriptor 段");
  // manifest 的语义是"唯一 descriptor 恒为最后一项"：descriptor 一旦前移，后面的 IIFE 就
  // 来不及把检查点挂到 globalThis，客户端只会在运行期静默降级成"没有该模块"。门禁直接失败。
  if (descriptorIndex !== names.length - 1) {
    throw new Error("唯一 ModuleLoader descriptor 必须是最后一个装配段（实际在第 "
      + (descriptorIndex + 1) + " 段，共 " + names.length + " 段）");
  }
  if (freshnessIndex > descriptorIndex) throw new Error("freshness 投影必须在唯一 ModuleLoader descriptor 之前执行");
  const freshnessSegment = segments[freshnessIndex];
  const descriptorSegment = segments[descriptorIndex];
  for (const statement of [CHECKPOINT_STATEMENT, REGISTER_STATEMENT]) {
    const compacted = compactBundleFragment(statement);
    if (!freshnessSegment.text.includes(compacted)) throw new Error("freshness 投影缺少装载语句: " + statement);
  }
  // ── 可投影 ESM 源（票据 01 第二单元）──────────────────────────────────────
  // 判据全部由 manifest.projectedSources 派生（不硬编码段名）：段必须存在、位于全部 IIFE 之后、
  // freshness 与唯一 descriptor 之前，正文必须带对应检查点语句且不残留 ESM 语法。
  // 位置判据不只是"好看"：投影段只挂检查点，descriptor 在 factory 里直接取用，
  // 段序一旦后移，客户端只会静默拿到 undefined（缺失检测留给使用方），构建期必须拦住。
  const lastIifeIndex = IIFE_SOURCES.reduce((last, source) => Math.max(last, names.indexOf(source)), -1);
  const projectedIndices = [];
  for (const projected of PROJECTED_SOURCES) {
    const index = names.indexOf(projected.source);
    if (index === -1) throw new Error("发布 bundle 缺少 " + projected.source + " 的 classic 投影段");
    if (index > descriptorIndex) {
      throw new Error(projected.source + " 的投影段必须在唯一 ModuleLoader descriptor 之前执行");
    }
    if (index > freshnessIndex) {
      throw new Error(projected.source + " 的投影段必须排在 freshness 投影之前（manifest.assemblyOrder 的口径）");
    }
    if (index <= lastIifeIndex) {
      throw new Error(projected.source + " 的投影段必须排在全部 IIFE 之后（检查点先由 IIFE 就位，投影再补共享实现）");
    }
    const projectedSegment = segments[index];
    const checkpointStatement = compactBundleFragment(
      projectedCheckpointStatement(projected.checkpointKey, projected.exports),
    );
    if (!projectedSegment.text.includes(checkpointStatement)) {
      throw new Error(projected.source + " 的投影段缺少检查点语句: " + checkpointStatement);
    }
    const leftover = /(?:^|\n)[ \t]*(?:import|export)\b/.exec(projectedSegment.text);
    if (leftover !== null) {
      throw new Error(projected.source + " 的投影段残留 ESM 语法: " + leftover[0].trim());
    }
    projectedIndices.push(index);
  }
  const descriptorMarkers = [
    "const FRESHNESS_MODULE_ID = " + JSON.stringify(FRESHNESS_MODULE_ID) + ";",
    "freshnessModule.registerClientFreshnessModule(globalThis.__ModuleLoader__);",
    "const RPC_CHANNEL = " + JSON.stringify(RPC_TARGET.channel) + ";",
    ...DESCRIPTOR_SEAM_MARKERS,
  ].map(compactBundleFragment);
  for (const marker of descriptorMarkers) {
    if (!descriptorSegment.text.includes(marker)) {
      throw new Error("client.js 的 freshness 装载 seam 已变化，请同步投影与行为核对: " + marker);
    }
  }
  for (const declaration of FORBIDDEN_INLINE_DECLARATIONS) {
    if (descriptorSegment.text.includes(compactBundleFragment(declaration))) {
      throw new Error("client.js 又出现了 freshness 内联实现 " + declaration
        + "（唯一实现在 client-freshness.js，客户端只许转发；双份实现会让安装体积翻倍并重新引入漂移）");
    }
  }
  return Object.freeze({ freshnessIndex, descriptorIndex, projectedIndices: Object.freeze(projectedIndices) });
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
 * 发布 bundle 的体积基线（v0.1.7 实测，基于当时 checked-in 的未压缩产物 client-bundle.js）。
 * 基线与门槛都写死在构建边界，不允许"跟着实现一起漂"。
 */
export const BUNDLE_SIZE_BASELINE = Object.freeze({
  version: "0.1.7",
  raw: 1_236_094,
  gzip: 357_515,
});

/**
 * 体积硬门禁（ticket 17）。计算方式：
 * - 未压缩：floor(1_236_094 × 0.75) = 927_070 B（相对基线下降 ≥ 25%）
 * - gzip -9 ：floor(357_515 × 0.85) = 303_887 B（相对基线下降 ≥ 15%）
 * brotli 只输出、不设门槛：它是"发布面还能再压多少"的参考值，压缩级别由宿主/CDN 决定，
 * 不适合在这里钉死（否则换一条 CDN 策略就会误伤构建）。
 *
 * ## raw 比例为什么在 2026-10-27 由 0.70 放宽到 0.74（第③步，经用户确认）
 *
 * 0.70 的硬上限 865_265 B 被「会话删除」的客户端模块顶穿：新增
 * client-session-delete-selection.js（压缩后 15_991 B）之后构建实测
 * **878_474 B，超硬线 13_209 B**，而后续票据 06/07 两张 UI 票据还要再增客户端代码。
 * 按 AGENTS.md §7 的处置顺序先做前两步，实测都没有可回收量级：
 *
 * - 第①步 清死代码：AST + tokenizer 全仓扫描（覆盖全部 client-*.js 装配源）得**零引用声明
 *   0 个**，56 个 Symbol.for("dsh-expert-group/<name>") 检查点全部有其他文件消费 ⇒
 *   **回收 0 B**；扫出的 15 个零引用声明全在 host/、shared/、test/、test-support/、scripts/（不进 bundle），
 *   与 bundle 体积无关。
 * - 第②步 零风险去重：单文件内逐字重复的字符串只有 24 组、**理论上限 824 B**（不足缺口的
 *   6%），且要在 10 个 UI 文件里改 90 余处 CSS 类名/选择器调用点——不属于「零风险」；
 *   跨 IIFE 的 C1–C4 去重（约 2 KB）按既有评估继续留给独立重构。
 *
 * 因此按第③步改比例。0.74 的余量依据：新硬上限 914_709 B 比当前产物高 **36_235 B**，
 * 约等于 2.2 倍「票据 05 实测增量」——票据 05 的纯状态机 + RPC 封装压缩后 15_991 B，
 * 据此估算票据 06/07 两张 UI 票据（复用既有确认骨架与插槽注册，含中英文案）合计
 * 20–30 KB，落地后仍应留 6–16 KB。软线同步为 floor(914_709 × 0.997) = **911_964 B**
 * （距当前产物 33_490 B，由 test/bundle-size-gate.test.mjs 强制）。gzip 的 0.85 与 5%
 * 富余本轮未动（实测 193_197 B，距硬上限 303_887 B 余量充足）。
 *
 * ## raw 比例为什么又在 2026-10-27 由 0.74 放宽到 0.75（第③步，经用户确认，本功能最后一次）
 *
 * 票据 06/07/08（会话删除的两张 UI 票据与 host 收敛面）全部落地后，构建实测
 * **919_667 B（raw）/ 202_506 B（gzip）/ 156_037 B（brotli）**，超 0.74 硬上限
 * 914_709 B 共 **4_958 B**，3 条体积门禁用例失败。此时功能增量已压到行为下限：再往下
 * 只能删行为（少一个删除入口、少一条结算文案、少一次候选校验），不再有"零风险压缩"空间。
 *
 * 本轮仍按第①/②步复核：① 客户端装配源的零引用声明仍为 0 个（56 个检查点全部有消费方）
 * ⇒ **回收 0 B**；② 零风险去重的理论上限只有 824 B，远小于 4_958 B 的缺口，且要改 90 余处
 * UI 调用点。故按第③步把 raw 比例 0.74 → **0.75**：
 * floor(1_236_094 × 0.75) = **927_070 B**，软线 floor(927_070 × 0.997) = **924_288 B**。
 * 相对当时产物余 **7_403 B**（硬线）/ **4_621 B**（软线）——够覆盖一次小改动的文案与样式
 * 增量，但不够再塞进一整个 UI 模块；后续要再加客户端功能，必须重走第①/②步或先拆模块。
 * gzip 的 0.85（303_887 B）与 5% 富余本轮**不动**（实测 202_506 B，距硬线 101_381 B），
 * 基线（1_236_094 / 357_515）同样未动。这是「会话删除」的第二次、也是最后一次放宽。
 *
 * ## 软线系数为什么在 2026-10-28 由 0.997 放宽到 0.998（第③步，经用户确认）
 *
 * 「统一供应商同步主代理」修复落地后产物 **925_120 B**：硬线 927_070 B 仍通过（余 1_950 B），
 * 但 0.3% 软线 924_288 B 被超 **832 B**。HEAD 产物本就已是 924_234 B（距软线仅 54 B），本次
 * 客户端真实增量 886 B 已在 1–2 KB 的预算内。第①步死代码仍回收 0 B；第②步零风险去重的
 * 理论上限仍为 824 B，即使全做完仍差 8 B，且要改 90 余处 UI 调用点。故按第③步**只**放宽
 * 软线系数：0.997 → **0.998**（0.3% → 0.2%），软线 floor(927_070 × 0.998) = **925_215 B**。
 * 硬线比例 0.75、gzip 的 0.85 与 5% 富余、基线（1_236_094 / 357_515）本轮全部未动。
 *
 * 达标手段是装配期的两步压缩（stripWholeLineComments → compactClientCode）：两步都只删
 * 注释与空白，**不因为"能压"就放宽阈值**；阈值与基线的算术关系由
 * test/bundle-size-gate.test.mjs 锁定（它断言 raw = floor(基线 × 0.75)、gzip = floor(基线 × 0.85)，
 * 手改阈值而不改比例会让门禁用例直接失败）。
 */
export const BUNDLE_SIZE_LIMITS = Object.freeze({
  raw: 927_070,
  gzip: 303_887,
});

/**
 * 测量发布 bundle 的三种体积。
 *
 * gzip 固定 level 9、brotli 固定 quality 11，与门禁基线用同一组参数，避免"参数不同导致
 * 数字不可比"。输出都是确定性字节数（Node 的 zlib 默认不写 mtime）。
 *
 * @param {string} content - 发布 bundle 文本。
 * @returns {{ raw: number, gzip: number, brotli: number }}
 */
export function measureBundleSizes(content) {
  if (typeof content !== "string") throw new TypeError("measureBundleSizes 只接受 bundle 文本");
  const bytes = Buffer.from(content, "utf8");
  return Object.freeze({
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  });
}

/**
 * 体积门禁判定：返回逐项违规（空数组 = 通过）。
 *
 * 单独导出成纯函数，构建（硬门禁）与 test/bundle-size-gate.test.mjs（回归）共用同一判据。
 *
 * @param {{ raw: number, gzip: number }} sizes - measureBundleSizes 的结果。
 */
export function evaluateBundleSizeGate(sizes) {
  const violations = [];
  for (const metric of ["raw", "gzip"]) {
    const limit = BUNDLE_SIZE_LIMITS[metric];
    const actual = sizes?.[metric];
    if (typeof actual !== "number" || !Number.isFinite(actual)) {
      violations.push({ metric, actual: actual ?? null, limit, reason: "missing" });
      continue;
    }
    if (actual > limit) violations.push({ metric, actual, limit, reason: "over-limit" });
  }
  return violations;
}

/**
 * 体积门禁（构建用）：违反任何一项直接抛错，让构建失败。
 *
 * @param {{ raw: number, gzip: number, brotli: number }} sizes
 */
export function assertBundleSizeGate(sizes) {
  const violations = evaluateBundleSizeGate(sizes);
  if (violations.length === 0) return sizes;
  const detail = violations.map((violation) => violation.metric + "=" + String(violation.actual)
    + "B 超过上限 " + violation.limit + "B").join("；");
  throw new Error("发布 bundle 体积硬门禁未通过：" + detail
    + "（基线 v" + BUNDLE_SIZE_BASELINE.version + " raw=" + BUNDLE_SIZE_BASELINE.raw
    + "B / gzip=" + BUNDLE_SIZE_BASELINE.gzip + "B；阈值定义见 BUNDLE_SIZE_LIMITS）");
}

/**
 * 按段名分派段渲染（段结构元数据的唯一生成处）。
 *
 * - freshness 源 → 专用投影：检查点 + ModuleLoader 登记（既有的装载契约，本函数不改写它）；
 * - manifest.projectedSources 登记的源 → 通用投影：只挂检查点，不登记；
 * - 其余（IIFE / descriptor）→ 段标记 + 已压缩正文（逐字节沿用原有形态）。
 *
 * @param {string} name - 段名（仓库相对路径）。
 * @param {string} content - 已剥离注释并压缩空白的正文。
 * @returns {string} 段文本（自带结尾换行，段之间不再插入纯空白行）。
 */
function renderSegmentText(name, content) {
  if (name === FRESHNESS_SOURCE) return renderClientFreshnessSegment({ name, source: content });
  const projected = PROJECTED_BY_SOURCE.get(name);
  if (projected === undefined) return "/* source: " + name + " */\n" + content.trimEnd() + "\n";
  return renderProjectedSourceSegment({
    name,
    source: content,
    checkpointKey: projected.checkpointKey,
    exports: projected.exports,
  });
}

/**
 * 确定性装配发布 bundle。
 *
 * 流程（顺序即门禁顺序）：
 * 1. **剥离**每个源文件的整行注释（只删注释，代码行原文逐字节保留）；
 * 2. **压缩**代码区空白：删行首缩进、纯空白行与行尾空白（compactClientCode；字符串、
 *    模板文本、正则、注释与段标记逐字节保留）；
 * 3. 按固定段序拼装，并同时产出**段结构元数据**（段名 / 段标记 / 段文本）；
 * 4. 用段结构做装载契约校验 → classic 语法校验 → freshness 行为核对；
 * 5. 写盘，并测量三种体积（门禁在 scripts/build.mjs 里执行）。
 *
 * 剥离与压缩都放在"渲染段"之前而不是"行为核对之后"：项目不变量是**校验对象即写盘内容**——
 * 两步都会改写正文（删注释、删空白），因此被校验的必须是压缩后的产物，否则"通过校验的"和
 * "写盘的"是两份文本。两步都只删注释/空白、不改变行为；行为核对跑的正是压缩后的投影片段，
 * 等于顺带验证了这一点。
 *
 * @param {{ write?: boolean }} [options] - write=false 时只计算结果（测试与一致性校验使用）。
 */
export async function assembleClientBundle({ write = true } = {}) {
  const sources = await Promise.all(sourceNames.map(async (name) => {
    const original = await readFile(join(root, name), "utf8");
    const stripped = stripWholeLineComments(original);
    // 压缩紧跟在剥离之后、渲染段/门禁之前：校验对象必须就是最终写盘的那份正文。
    const compacted = compactClientCode(stripped.text);
    return {
      name,
      content: compacted.text,
      originalBytes: Buffer.byteLength(original, "utf8"),
      strippedBytes: Buffer.byteLength(stripped.text, "utf8"),
      compactedBytes: Buffer.byteLength(compacted.text, "utf8"),
      removedLines: stripped.removedLines,
      removedIndentCharacters: compacted.removedIndentCharacters,
      removedBlankLines: compacted.removedBlankLines,
      removedTokenSpaces: compacted.removedTokenSpaces,
    };
  }));
  // 段结构在这里显式生成：段标记是装配器自己的产物，只由装配器声明，不再事后到正文里反查。
  const segments = sources.map(({ name, content }) => Object.freeze({
    name,
    marker: "/* source: " + name + " */",
    text: renderSegmentText(name, content),
  }));
  // 段文本自带结尾换行，这里直接首尾相接：装配器不得再插入纯空白行——否则"压缩后的段"
  // 会在拼装阶段被重新加上空白，产物就不再是压缩不动点（体积也会白白多出几个字节）。
  const content = banner + segments.map((segment) => segment.text).join("");
  const placement = verifyClientBundleContract(segments);
  verifyClassicScript(content);
  // 行为核对直接用刚生成的那一段（而不是重新渲染），确保校验对象就是要写盘的内容。
  const projection = await verifyFreshnessProjection({ segment: segments[placement.freshnessIndex].text });
  // 投影源行为对照（票据 01 第二单元）：与 freshness 同一条纪律——每构建必跑，跑的就是待写盘
  // 的那一段，任何差异让构建失败，而不是留到运行期由"界面提示与 Host 判定不一致"暴露。
  const projectedProbes = [];
  for (const projected of PROJECTED_SOURCES) {
    const index = sourceNames.indexOf(projected.source);
    projectedProbes.push(await verifyProjectedSourceProjection({
      segment: segments[index].text,
      // 权威实现按清单里的仓库相对路径动态 import：路径只由 manifest 决定，不另立映射。
      authorityModule: await import("../" + projected.source),
      checkpointKey: projected.checkpointKey,
    }));
  }
  const outputPath = join(root, outputName);
  // DSH 0.2.x 的 web boot 以固定文件名 client.js 请求插件客户端入口（combo 路由
  // /plugins/<包名>/client.js?rev=...），因此发布面同时产出两份同内容产物：
  // - client.js：新版宿主的约定入口；
  // - client-bundle.js：旧宿主与既有门禁/测试沿用的入口，保持向后兼容。
  const entryOutputPath = join(root, entryOutputName);
  if (write) {
    await writeFile(outputPath, content, "utf8");
    await writeFile(entryOutputPath, content, "utf8");
  }
  return Object.freeze({
    outputPath,
    entryOutputPath,
    sourceNames,
    segments,
    content,
    // 体积**不在这里算**：brotli q11 对 670KB 产物约 850ms，而装配器在测试里被反复调用
    // （test/client-shared-boundary.test.mjs 一次调用 8 遍），把压缩塞进装配会让每个调用点
    // 都付一次这笔钱。构建（scripts/build.mjs）、复测脚本与门禁测试各自显式调用
    // measureBundleSizes()，因此"测出来的"和"卡门槛的"仍是同一组参数。
    // 压缩统计：构建日志用它拆开说明"省下来的字节分别来自注释与空白"，而不是悄悄改了代码。
    stripStats: Object.freeze({
      originalBytes: sources.reduce((total, source) => total + source.originalBytes, 0),
      // strippedBytes = 剥离整行注释之后的字节数；compactedBytes = 再删空白之后（即产物体量）。
      strippedBytes: sources.reduce((total, source) => total + source.strippedBytes, 0),
      compactedBytes: sources.reduce((total, source) => total + source.compactedBytes, 0),
      removedLines: sources.reduce((total, source) => total + source.removedLines, 0),
      removedIndentCharacters: sources.reduce((total, source) => total + source.removedIndentCharacters, 0),
      removedBlankLines: sources.reduce((total, source) => total + source.removedBlankLines, 0),
      removedTokenSpaces: sources.reduce((total, source) => total + source.removedTokenSpaces, 0),
    }),
    // 行为核对步数是"投影与权威实现逐项一致"的证据，构建日志与测试都据此断言。
    freshnessProbeSteps: projection.steps,
    // 投影源行为对照的累计步数（每个投影源各自跑同一组固定探针）。
    projectedProbeSteps: projectedProbes.reduce((total, probe) => total + probe.steps, 0),
  });
}

/** 测量命令（构建日志与票据共用同一行，复制即可复现）：见 scripts/measure-bundle.mjs。 */
const MEASURE_COMMAND = "node scripts/measure-bundle.mjs";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const result = await assembleClientBundle();
  // CLI 直接运行时也要给体积：显式测量一次（装配器本身不测，见 assembleClientBundle 的说明）。
  const sizes = measureBundleSizes(result.content);
  const strip = result.stripStats;
  console.log("Generated " + result.outputPath + " from " + result.sourceNames.length + " sources; freshness 投影行为核对 "
    + result.freshnessProbeSteps + " 步零漂移。");
  console.log("bundle 体积：raw=" + sizes.raw + "B / gzip=" + sizes.gzip + "B / brotli=" + sizes.brotli + "B；"
    + "剥离整行注释 " + strip.removedLines + " 行，" + strip.originalBytes + "B → " + strip.strippedBytes + "B；"
    + "压缩代码区空白（行首缩进 " + strip.removedIndentCharacters + " 字符 / 纯空白行 " + strip.removedBlankLines
    + " 行）→ " + strip.compactedBytes + "B。");
  console.log("复测命令：" + MEASURE_COMMAND);
}
