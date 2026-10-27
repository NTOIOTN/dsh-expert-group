#!/usr/bin/env node
/**
 * 依赖图门禁（R0 票据 02 / 票据 32）：C1 / C2 / C3 / C4 / C8。
 *
 * ## 为什么需要它
 * 规格书 §门禁与装配 要求「ESM 依赖图无环、Host/Shared/Fanout 不反向 import `index.js`」；
 * §低耦合判据 C1/C2/C4/C8 把四项要求写成机器可查的门禁。在此之前仓库只有装配、构建、
 * 体积与版本同步脚本，拆分是否「真的拆开」无法证明——拆分后只要有人把 `shared.js` 又
 * import 回 `index.js`，或者新模块之间绕成环，没有任何自动化会拦住。
 *
 * ## 四条判据（口径与规格书逐条对齐）
 * - **C1** ESM 依赖图无环：静态解析 `import ... from`、`import "..."`、`export ... from`、
 *   `export * from`、`export * as ns from`；**动态 `import()` 必须是字面量**，非字面量单独报出
 *   （命中显式白名单可豁免）。**票据 45 起这些事实全部来自 acorn AST**
 *   （`collectModuleSpecifiers` / `collectDynamicImports`），多行 import、`import{a as b}`、
 *   说明符之间夹注释等写法不再依赖词法运气；词法器实现（`parseEsmRelationsLexer`）保留为
 *   对照侧，差异由报告打印。**客户端 IIFE 的 requires/provides 依赖边同样入图**——否则
 *   客户端的「无环」是假绿（票据 02 的关键要求）。票据 03 起，IIFE 边的**事实源**是
 *   `scripts/client-source-manifest.mjs` 的 `iifeDependencies`（显式声明）；
 *   `collectIifeDependencyEdges`（扫描源码 Symbol 读写）保留为同一输入的**等价性证据**，
 *   两者的逐项相等由 `test/dependency-graph-gate.test.mjs` 持续校验。
 * - **C2** `host/`、`shared/`、`fanout/` 下的模块不得 import 入口 `index.js`。相对路径
 *   解析 + `posix.normalize` 归一化之后再判定，所以 `../index.js`、`./index.js` 都会被识别。
 *   兼容 R1 之前的文件形态：`shared.js`、`fanout.js` 同样在 C2 范围内（R1 之后它们分别
 *   变成 `shared/`、`fanout/` 目录，前缀规则已覆盖）。
 * - **C4** 内部模块导出数 ≤12：票据 45 起按 **AST 的导出名个数**计（`countModuleExports`）：
 *   `export { a, b }` / `export { a, b } from "…"` 按名字个数计；`export const A = 1, B = 2`
 *   按**声明名个数**计（2——词法器只数 `export` 关键字、会漏成 1）；`export * from`（含
 *   `export * as ns from`）无法静态展开名字，按 1 计；`export default` 按 1 计；空 `export {}`
 *   取保守下界 1。
 *   **豁免三类**（口径见规格书 §C4 导出数豁免，2026-10-22 用户裁决）：
 *   1. **组合根**：文件与 `package.json` `exports["."]` 的目标一致（机械判定）；
 *   2. **兼容门面**：文件内容只有 `import` / `export ... from` 再导出与注释，没有任何实现体
 *      （机械判定，见 `isReExportFacade`）；`shared.js` 现在仍是真实实现，所以**照实报出**，
 *      R1 把它改成纯 re-export 门面后自动转入豁免，不需要登记；
 *   3. **凝聚纯函数库**：单一关注点、无模块级可变状态、全部导出为函数或不可变常量。
 *      这一类**必须逐条登记**在 `PURE_FUNCTION_LIBRARY_EXEMPTIONS` 与
 *      `docs/specs/module-owner-ledger.md` §「C4 导出数豁免登记」里，且**登记不等于免检**：
 *      门禁仍做机械校验，出现模块级可变状态或非函数/非常量导出时即使登记了也报错。
 * - **C8** 单模块本地 import ≤12（相对路径的 import / re-export **语句数**，票据 45 起来自
 *   AST 的说明符记录：一条多行 import 仍算 1 条）；**豁免**组合根 `index.js`。
 *   动态 `import()` 不计入 C8（它不是 import 语句，且 C1 已单独约束）。
 * - **C3**（票据 32 新增，票据 34 补对账，票据 35 补箭头工厂）内部工厂能力组 ≤8：数据源是
 *   显式登记的 `C3_FACTORY_REGISTRY`。三层校验：①**存在性**——登记的 `{file, name}` 必须真的
 *   出现在源码里（`function <name>` 或 `const/let <name> =`），否则报「清单过期」；
 *   ②**组数上限 + 明细**——
 *   `groups > 8` 且没有 `reason` 报违规；`groups >= 6` 的条目必须给出 `faces`
 *   （逐组 `{ name, capability }` 能力面，长度必须等于 `groups`），缺失报 `missing-faces`
 *   ——组数必须能被人复算，否则 C3=0 只证明
 *   「数字没变」；③**对账**（票据 34）——扫描产品源码里全部
 *   `^[ \t]*(export\s+)?(async\s+)?function\s+(create\w*)\s*\(` 声明，与「登记表 ∪ 例外表」求差集，
 *   任何未分类项报 `unclassified-factory`；例外表 `C3_NON_FACTORY_EXCLUSIONS` 同样做存在性校验
 *   （`stale-exclusion`）且不得与登记表重叠。**组数刻意不做自动推导**：即使有了真实解析器
 *   （票据 44 的 acorn），AST 也只能数出"读了哪些标识符"，数不清"哪些字段属于同一关注点"，
 *   自动推导只会给出假精度；但对账解决的是另一个问题——
 *   「源码里到底有多少个 create* 声明」是可静态枚举的，否则台账漏记会表现为绿灯（票据 34 前
 *   152 条登记 vs 207 个声明，55 个工厂从未受检），见 `C3_FACTORY_REGISTRY` 的注释。
 *   票据 35 把声明扫描扩到 `const/let createX = …`（此前 14 条箭头/变量声明全部不可见）；
 *   票据 36 进一步把两种形态统一为**全深度收集**（含函数体内的嵌套声明），基线从
 *   207 变成 221 条声明（220 个 file+name 键）= 登记 208 + 例外 12。
 *   票据 37 修掉三处边界：①生成器形态（`function* createX` / `async function* createX`）
 *   此前完全不进清单；②模板插值 `${ … }` 内的声明此前被遮蔽器整段抹掉，既不收集也不进
 *   差集；③存在性校验此前对**原始源码**跑正则（`// function createGhost() {}` 就能让
 *   过期登记通过），现改为复用收集器的同一套遮蔽串 + 识别结果。
 *
 *   **票据 44 起对账改用真实解析器（acorn）**：词法器无法被证明完备（『正则字面量 vs
 *   除号』在 JS 里不可局部判定），票据 42 / 43 连续两轮都在补它的边界。现在
 *   `collectFactoryDeclarations` 的**正判据是 AST**（`scripts/js-ast-scan.mjs`），词法器
 *   实现降级为 `collectLexerFactoryDeclarations`，只作为对照侧参与**交叉校验**：
 *   C3 报告会打印「AST 与词法器声明集合差异：N 条」并逐条列出，`N = 0` 才打印「一致」。
 *   实测差异为 4 条（2 个词法器完全看不见的对象字面量方法声明 + 2 处同名出现次数差异），
 *   两者都已逐条分类；基线因此从 221 / 220 = 208 + 12 变为 **225 / 222 = 208 + 14**。
 *   行数门禁的跨度判据**没有切换**（票据 44 明确：朴素 AST 计数会一次冒出大量超限，
 *   绝大多数是 `install*` 模块包装与类别差异），只在 `check-module-size.mjs` 增加
 *   `--ast-cross-check` 做对照。
 *
 * ## 统计范围（与 01 的门禁完全一致，不复制第二份口径）
 * 复用 `collectModuleSourceFiles`：`package.json` `files` 的 `.js`/`.mjs` 源文件（排除构建
 * 产物 `client-bundle.js`）∪ `CLIENT_SOURCE_FILES`；排除 `test/`、`node_modules/`、`.git/`、
 * `.scratch/`。因此本脚本只看**产品源码**，不看自身与其它 `scripts/*.mjs`。
 *
 * ## 边的方向（全图统一）
 * 每条边 `from -> to` 表示「`from` 是被依赖方，`to` 是依赖方」：
 * - ESM：`to` import 了 `from`（即 `import "./from.js"` 写在 `to` 里）；
 * - IIFE：`to` 读取了 `from` provides 的 `Symbol.for` 命名空间。
 * 这样 ESM 与 IIFE 共用同一套方向语义，环检测与报告都不需要做方向翻译（环本身与方向无关）。
 *
 * ## 静态扫描的实现方式
 * **票据 45 起，C1/C2/C4/C8 的依赖事实由 acorn AST 提供**（`scripts/js-ast-scan.mjs`）：
 * import/export 的来源与导出名来自 `collectModuleSpecifiers`，动态 import 来自
 * `collectDynamicImports`，IIFE 的 Symbol 读写来自 `collectSymbolForCalls` + AST 的
 * `MemberExpression` / `AssignmentExpression` 结构。词法器的对应实现
 * （`parseEsmRelationsLexer` / `collectLexerIifeDependencyEdges`）**只作为对照侧**，
 * 由 `crossCheckDependencyFacts` 逐项比对并在报告里打印差异（0 差异打印「一致」）。
 *
 * 等长遮蔽（`scripts/js-source-scan.mjs`）仍然保留，但只服务于**C4 豁免的机械校验**
 * （`isReExportFacade` / `inspectPureFunctionLibrary` 的顶层语句形状判定）——那里判的是
 * "有没有实现体 / 有没有模块级副作用"，属于语句形态问题，不是依赖事实。
 *
 * ## 已知边界（只会少报，不会错报成别的东西）
 * - `export * from` 无法静态展开导出名，C4 按 1 个导出计；
 * - IIFE 扫描只认 `globalThis[...]` / `global[...]` 索引访问，以及 `Symbol.for("...")` 与
 *   同文件内 `const NAME = Symbol.for("...")` / `const NAME = "dsh-expert-group/..."` 的绑定
 *   （含字符串常量别名，例如 `const KEY = "dsh-expert-group/client-model-config"` 后
 *   `Symbol.for(KEY)`）；票据 45 起这些形态由 AST 判定，换行 / 注释 / 等价空白都不再影响识别；
 * - 识别不出提供方的 requires 会被保留在返回值里但不构成边；
 * - **无法静态解析的全局键 fail-closed（票据 38）**：`globalThis[Symbol.for(动态表达式)]` /
 *   `global[运行期变量]` 这类访问不再被静默忽略——它意味着一条 IIFE 依赖边**不存在**，
 *   环检测会因此少一条路径。现在它被记为 `unresolved` 并由 C1 报成
 *   `unresolved-iife-symbol` 违规（显式失败，而不是格式正确的绿灯）。
 *
 * ## 退出码
 * 默认（`node scripts/check-dependency-graph.mjs`）有违规就 `process.exitCode = 1`；
 * 加 `--report` 只打印、不失败。本脚本**不接入** `scripts/build.mjs`：C4 的既有超限在
 * R1 之前必然是红的，接进构建会立刻把构建打红（规格书只要求它作为 R0 门禁独立可跑）。
 */
import { readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLIENT_SOURCE_FILES } from "./client-sources.mjs";
// 客户端装配的四语义清单（R0 票据 03）：IIFE 依赖边的事实源是 manifest 的显式声明，
// 扫描实现（collectIifeDependencyEdges）降级为「等价性证据的另一侧」。
import {
  assemblyOrder as CLIENT_MANIFEST_ASSEMBLY_ORDER,
  iifeDependencies as CLIENT_MANIFEST_IIFE_DEPENDENCIES,
} from "./client-source-manifest.mjs";
import { collectModuleSourceFiles, normalizeModulePath } from "./check-module-size.mjs";
import { maskJavaScriptSource } from "./js-source-scan.mjs";
// 票据 44：声明 / 依赖事实改用真实解析器（acorn）。词法器保留为**交叉校验**的另一侧，
// 不再是判据本身——它无法被证明完备（票据 42/43 连续两轮都在补它的边界）。
// 票据 45：C1/C2/C4/C8 的依赖事实（ESM 边、动态 import、IIFE Symbol 边、导出数、
// 本地 import 数）也统一走这套 AST 采集，词法器实现降级为同一判据的对照侧。
import {
  collectCreateDeclarations,
  collectDynamicImports,
  collectModuleSpecifiers,
  collectSymbolForCalls,
  parseSource,
  walkAst,
} from "./js-ast-scan.mjs";

/** C4 / C8 的硬上限（规格书 §低耦合判据 C4/C8）。 */
export const DEPENDENCY_GRAPH_LIMITS = Object.freeze({
  /** 内部模块导出数上限。 */
  exports: 12,
  /** 单模块本地（相对路径）import 语句数上限。 */
  localImports: 12,
});

/** 组合根（入口）模块：C2 的反向 import 目标，C4 / C8 的豁免对象。 */
export const ENTRY_MODULE = "index.js";

/**
 * C2 的作用域：这些模块不得 import 入口。
 * - 目录前缀覆盖 R1 之后的 `shared/`、`fanout/` 与既有的 `host/`；
 * - `shared.js`、`fanout.js` 是 R1 之前的文件形态（R1 会把它们拆成目录 + 门面）。
 * 注意：规格书 C2 只声明这三处；`fanout-host.js` 等根目录模块不在判据范围内，故不纳入。
 */
const ENTRY_DEPENDENT_PREFIXES = Object.freeze(["host/", "shared/", "fanout/"]);
const ENTRY_DEPENDENT_FILES = Object.freeze(["shared.js", "fanout.js"]);

/**
 * C4 豁免第 3 类「凝聚纯函数库」的**显式登记表**（规格书 §C4 导出数豁免）。
 *
 * 为什么必须显式登记而不做启发式放行：按 plan §6 切分后 `model-route`、`retry-policy`、
 * `turn-settlement`、`protocol`、`fanout/contracts` 等模块的导出数必然超过 12，它们本身是
 * 单一关注点的纯函数/常量集合；但「看起来像纯函数库」无法自动证明，所以登记必须由人完成，
 * 并且**登记后仍要通过机械校验**（见 `inspectPureFunctionLibrary`）。
 *
 * 每项形如 `{ file, concern, reason }`：
 * - `file`：相对仓库根的路径；
 * - `concern`：该库的单一关注点；
 * - `reason`：为什么它是纯函数库（与台账 §「C4 导出数豁免登记」逐条对应）。
 *
 * 当前登记 11 项，分两批：
 * 1. **7 个不会被任何拆分批次改动的单关注点领域库**（用户 2026-10-22 裁决）；
 * 2. **R1-05 拆出的 4 个导出 >12 的 shared 叶子**（`protocol` 15 / `turn-settlement` 19 /
 *    `retry-policy` 23 / `model-route` 29），它们的导出数由已批准的 plan §6 切分**决定**，
 *    再切碎只会增加模块数而不降低耦合——主代理 2026-10-22 按台账 §3 登记。
 * `shared.js` 已转为纯 re-export 门面（C4 走 facade 机械豁免）、`fanout.js`（R3 拆 manager）、
 * `host/usage-ledger.js`（R2 拆 usage-projection）**故意不登记**，保留它们被 C4 报出，
 * 作为后续批次的可见目标。
 */
export const PURE_FUNCTION_LIBRARY_EXEMPTIONS = Object.freeze([
  {
    file: "host/system-toast.js",
    concern: "系统 Toast 的投递脚本、音量归一与模块工厂",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "host/rpc-transport.js",
    concern: "RPC 传输层（响应吸收/终结簿记、body 上限）",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "host/expert-group-snapshot.js",
    concern: "专家组快照投影与状态/失败归一",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "image-routing.js",
    concern: "图片路由判定、能力探测与 PNG 归一",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "resource-budget.js",
    concern: "fan-out 预算常量与文本截断",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "role-registry.js",
    concern: "角色注册表数据与查询",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  {
    file: "storage.js",
    concern: "storage domain 绑定与持久化原语",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态由 C5 台账登记",
  },
  // ── R1-05 拆出的 shared 叶子（导出数由 plan §6 切分决定，见台账 §3）─────────
  {
    file: "shared/protocol.js",
    concern: "RPC 端点常量、角色 deny 组合与注册表投影",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "shared/turn-settlement.js",
    concern: "turn 文本/消息 id、任务结算、取消与恢复判定",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "shared/retry-policy.js",
    concern: "请求重试策略、失败分类与 recovery op 状态机",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "shared/model-route.js",
    concern: "模型候选计划、路由 marker 归一与路由错误分类",
    reason: "单一关注点 + 导出全为函数/常量 + 内部状态仅两个只读查找 Set（见 C5 台账）",
  },
  // ── R1-06 / R1-07 从入口与 fanout 前段拆出的领域库（导出数由已批准的切分边界决定）──
  {
    file: "fanout/contracts.js",
    concern: "fan-out 契约常量、停止证据校验与恢复字段校验",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "fanout/errors.js",
    concern: "shard/父任务状态词表、停止证据状态与终态判定",
    reason: "单一关注点 + 导出全为函数/常量 + 内部状态仅两个只读查找 Set（见 C5 台账）",
  },
  {
    file: "fanout/validation.js",
    concern: "attempt 身份、错误构造归一与 submit/limit 校验",
    reason: "单一关注点 + 导出全为函数/类/常量 + 无模块级内部可变状态",
  },
  {
    file: "host/expert-guards.js",
    concern: "专家报告/发送拦截、persona marker 与 deny 收窄",
    reason: "单一关注点 + 导出全为函数/常量 + 内部状态仅一个 registeredPluginExpertChildren WeakSet（见 C5 台账）",
  },
  {
    file: "host/settings-schema.js",
    concern: "settings schema 常量与读侧归一函数（含 Config）",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "host/usage-projection.js",
    concern: "用量事件的归一、聚合、成本估算与模型单价投影",
    reason: "单一关注点 + 导出全为函数/常量 + 无模块级内部可变状态",
  },
  {
    file: "host/expert-group-projection.js",
    concern: "专家组快照的纯投影与 child 归属判定（含 per-build resolver 工厂）",
    reason: "单一关注点 + 导出全为函数/类/常量 + 内部状态仅一个只读 Set（PERMANENT_RESTORE_CODES）",
  },
]);

/** C3 能力组上限（规格书 §能力组（C3））。超过它的登记项**必须**带 `reason`。 */
export const FACTORY_GROUP_LIMIT = 8;

/**
 * 从这一组数起，登记项**必须**同时给出 `faces` 明细（票据 34 收尾；票据 35 起每项是
 * `{ name, capability }`：名字对应参数/命名空间，capability 说明这个面提供什么能力）。
 *
 * 为什么设门槛而不是全部强制：低组数（1–5 组）的条目逐条列 faces 只是噪音，
 * 复核者看一眼参数就能数出来；6 组以上则「数字不可复核」的风险陡增——票据 34 的
 * 审计意见正是「只有数字、没有这 8 组分别是哪 8 组」，等于又回到人工拍板。
 */
export const C3_FACES_REQUIRED_MIN = 6;

/**
 * C3 能力组台账：显式登记的工厂清单（票据 32）。
 *
 * ## 为什么是显式清单而不是自动推导
 * 仓库没有引入 JS parser 依赖，靠正则猜「这个 deps 对象里哪几个字段属于同一关注点」只能给出
 * **假精度**：它数得清参数个数，数不清聚合关系，而 C3 的口径恰恰是「能力组」——同一个协作方
 * 拆成 3 个参数要算 3 组（规格书 §能力组），3 个同源协作方打包成 1 个命名空间要算 1 组。
 * 两者都无法从文本形态判定。因此这里刻意选择「人工评审登记 + 机械存在性校验」：
 *
 * - **存在性**：每个 {file, name} 必须真的在源码里出现（`function <name>` 或
 *   `export function <name>`），否则报「清单过期」——工厂改名/删文件/搬家都会立刻红灯，
 *   清单不可能悄悄失真；
 * - **组数上限**：`groups > FACTORY_GROUP_LIMIT` 且没有 `reason` → 违规；有 `reason` 的必须
 *   写真实理由（组合根豁免 / 待收窄偏差），不接受「历史原因」这类空话。
 *
 * 组数本身仍由人评审（数值来自 owner 台账 §2 的签核值与票据 32/33 的实测），门禁只保证
 * **登记过的工厂不会悄悄增长**且**清单不会悄悄过期**——这已能消除「台账漏记导致漏检」的
 * 主要风险。
 *
 * ## 登记范围
 * 产品源码里**全部** `function create*` 具名工厂，以及 `const/let createX = …` 变量绑定
 * 声明——票据 36（第四轮复审）起两种形态**同规则、全深度**收集（含函数体内的嵌套声明），
 * 再由本清单 ∪ 例外表逐条分类。嵌套声明只要是**真工厂**（返回命令面 / 持有状态）就登记，
 * 哪怕它的协作方全部来自闭包（此时组数为 0）；`createdAtOf` 这类纯投影 helper / 局部
 * 变量不是工厂，登记在 `C3_NON_FACTORY_EXCLUSIONS` 并写明宿主函数。
 *
 * 对账基线（票据 36）：源码声明 221 条（按 file+name 去重 220 个键）= 登记 208 + 例外 12，
 * 其中 function 形态 207（票据 34 基线不变）、变量形态 14（票据 36 从「模块级 2 条」
 * 扩到「全深度 14 条」）。`assembleXxx(state, caps)` 与 `installXxx` 这类
 * **installer** 不在本清单：它们只接收同文件/同段的装配状态袋（≤3 组），注入面由所属工厂
 * 条目约束，台账 §2 也只按工厂登记。`groups` 的口径是**注入的能力组数**：
 * - 扁平解构袋按「一个协作方 = 一组」计（同一协作方拆成多个参数就按多个计，见规格书）；
 * - 数据构造函数（参数全是数据、不注入协作方）记 0；
 * - 组数已由台账签核的条目沿用台账值（例如 `createFanoutRuntime` 24、`createUsageLedger` 6、
 *   `createSnapshotCache` 5），票据 32/33 收窄过的条目用**收窄后**的实测值；
 * - 命名空间化的工厂（票据 32/33 收窄后）按命名空间个数计：`createRootTurnWaitRegistry` 8、
 *   `createRootWaitDomain` 8、`createHandoffDomain` 7、`createFinalizeDomain` 7、
 *   `createSystemToastModule` 3、`createExpertGroupRuntime` 8。
 *
 * ## 超上限的 2 条（都是组合根豁免，每条必须有 reason）
 * `createFanoutRuntime`（20）、`createFanoutRuntimeModule`（25）：fanout 子系统的组合根，
 * 与 `index.js` 同类，规格书 §C3 与组合根条款明确豁免。
 *
 * 票据 33 已把此前如实登记的三个「待收窄偏差」收掉（`createFinalizeDomain` 18→7、
 * `createSystemToastModule` 14→3、`createExpertGroupRuntime` 13→8），它们的 `reason`
 * 随之删除——**≤8 的条目不需要理由**，理由只服务真正的豁免。
 */
export const C3_FACTORY_REGISTRY = Object.freeze([
  { file: "client-freshness.js", name: "createClientFreshnessBoundary", groups: 2 },
  {
    file: "fanout-host.js",
    name: "createFanoutRuntime",
    // 票据 34 复核：此前的 24 是从 createFanoutRuntimeModule 的形参数直接沿用过来的。
    // 票据 36（第四轮复审）按源码实际读取重算：本函数读 **22 个 option keys**，其中
    // clock / now / setTimeout / clearTimeout 四个 key 在函数体内被折叠成**同一组**时钟能力
    // （clock 对象承载 now/setTimeout/clearTimeout），所以能力组 = 22 − 4 + 1 = **19 组**。
    // 票据 03 增补 prepareAttempt（派发前路由冻结 seam）→ 23 个 key、**20 组**。
    // 模块侧的 24 个形参里有 5 个（createRuntime / lineage / getAgent / buildFeedback /
    // writeSnapshot / readSnapshot / getPersistenceGeneration 等）只被模块层消费，
    // 不会被转发给 runtime，因此不在本条目里计数。
    groups: 20,
    faces: [
      { name: "allowOverlap", capability: "并发重叠提交策略开关" },
      { name: "prepareAttempt", capability: "派发前路由冻结：attempt 进入 running 之前同步构造快照" },
      { name: "attributionAgingMs", capability: "归属老化阈值：配置" },
      { name: "buildRequest", capability: "子 agent 请求构建" },
      { name: "clock", capability: "时间与定时器控制：Date.now / setTimeout / clearTimeout" },
      { name: "concurrencyLimit", capability: "并发上限：配置" },
      { name: "conflictChecker", capability: "写角色冲突检查器" },
      { name: "continueMessage", capability: "续作消息投递" },
      { name: "interrupt", capability: "中断请求投递" },
      { name: "log", capability: "日志函数" },
      { name: "onAgentCreated", capability: "agent 创建钩子" },
      { name: "onEvent", capability: "fan-out 事件回调" },
      { name: "parentAgentOf", capability: "父 agent 解析" },
      { name: "persistence", capability: "快照持久化读写" },
      { name: "providerLimits", capability: "提供商并发上限：配置" },
      { name: "resolveChildSession", capability: "子会话解析" },
      { name: "roleLimits", capability: "角色限额：配置" },
      { name: "roleTimeoutMs", capability: "角色超时：配置" },
      { name: "startContinuable", capability: "可续作子 agent 启动" },
      { name: "writeRoles", capability: "写角色冲突策略：写角色集合" },
    ],
    reason: "【组合根豁免】fanout 子系统的组合根（与 index.js 同类）：读 23 个 option keys，其中 clock/now/setTimeout/clearTimeout 折叠为 1 组时钟能力 → 20 个能力组（模块侧 createFanoutRuntimeModule 是 25 个形参，其中 5 个只在模块层消费、不转发给 runtime），规格书 §C3 与组合根条款明确豁免，收窄需改 fanout 子系统装配面",
  },
  { file: "fanout/events.js", name: "createFanoutEventBus", groups: 3 },
  { file: "fanout/limits.js", name: "createLimitResolver", groups: 2 },
  { file: "fanout/persistence.js", name: "createFanoutPersistence", groups: 5 },
  { file: "fanout/public-api.js", name: "createFanoutManager", groups: 3 },
  { file: "fanout/reclaim.js", name: "createReclaimBarrier", groups: 1 },
  { file: "fanout/scheduler.js", name: "createAttempt", groups: 1 },
  { file: "fanout/scheduler.js", name: "createScheduler", groups: 7, faces: [
    { name: "store", capability: "分片/父任务存储端口" },
    { name: "limits", capability: "角色/提供商并发与超时限额" },
    { name: "events", capability: "fan-out 事件总线" },
    { name: "persistence", capability: "快照持久化读写" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "ownerGate", capability: "owner 闸门：并发准入" },
  ] },
  { file: "fanout/snapshot.js", name: "createFanoutSerializer", groups: 5 },
  { file: "fanout/state.js", name: "createFanoutState", groups: 8, faces: [
    { name: "store", capability: "分片/父任务存储端口" },
    { name: "limits", capability: "角色/提供商并发与超时限额" },
    { name: "events", capability: "fan-out 事件总线" },
    { name: "persistence", capability: "快照持久化读写" },
    { name: "snapshot", capability: "fan-out 快照序列化" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "budget", capability: "资源预算与文本截断" },
    { name: "config", capability: "插件配置读面：Config" },
  ] },
  { file: "fanout/store.js", name: "createTaskStore", groups: 1 },
  { file: "fanout/task-commands.js", name: "createTaskCommands", groups: 8, faces: [
    { name: "store", capability: "分片/父任务存储端口" },
    { name: "limits", capability: "角色/提供商并发与超时限额" },
    { name: "scheduler", capability: "尝试调度器" },
    { name: "events", capability: "fan-out 事件总线" },
    { name: "persistence", capability: "快照持久化读写" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "ownerGate", capability: "owner 闸门：并发准入" },
  ] },
  { file: "fanout/validation.js", name: "createWriteRoleConflictChecker", groups: 1 },
  { file: "host/composition.js", name: "createHostComposition", groups: 7, faces: [
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "rpc", capability: "RPC 传输/分发" },
    { name: "settings", capability: "设置读写服务" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "notifications", capability: "通知服务：Toast/系统通知" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
  ] },
  { file: "host/expert-child-composition.js", name: "createRootGenerationRegistry", groups: 0 },
  { file: "host/expert-group-projection.js", name: "createChildOwnershipResolver", groups: 6, faces: [
    { name: "rootId", capability: "根会话 id 读面" },
    { name: "persisted", capability: "持久化快照读面" },
    { name: "coordinator", capability: "admission 批次协调器" },
    { name: "fast", capability: "快速路径读数：缓存" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
  ] },
  { file: "host/expert-group-projection.js", name: "createColdReadCoordinator", groups: 1 },
  { file: "host/expert-group-projection.js", name: "createExpertProjectionContext", groups: 3 },
  { file: "host/expert-group-projection.js", name: "createProjectionTitleReader", groups: 1 },
  { file: "host/expert-group-projection.js", name: "createRoleLabelReader", groups: 1 },
  { file: "host/expert-group-runtime.js", name: "createExpertGroupRuntime", groups: 8, faces: [
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "goals", capability: "专家目标读面" },
    { name: "ownership", capability: "child 归属索引" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "sources", capability: "上下文来源投影" },
    { name: "labels", capability: "角色标签读面" },
    { name: "diagnostics", capability: "运行诊断投影" },
    { name: "clock", capability: "时间源：Date.now 注入" },
  ] },
  { file: "host/fanout-attribution.js", name: "createAttributionAging", groups: 1 },
  { file: "host/fanout-attribution.js", name: "createAttributionRegistry", groups: 1 },
  { file: "host/fanout-attribution.js", name: "createAttributionState", groups: 7, faces: [
    { name: "log", capability: "日志函数" },
    { name: "managerPort", capability: "fan-out 管理器端口" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "attributionAgingMs", capability: "归属老化阈值：配置" },
    { name: "resolveChildSession", capability: "子会话解析" },
    { name: "parentAgentOf", capability: "父 agent 解析" },
    { name: "hasContinueRoute", capability: "续作路由判定" },
  ] },
  { file: "host/fanout-attribution.js", name: "createAttributionVerdicts", groups: 2 },
  { file: "host/fanout-attribution.js", name: "createFanoutAttribution", groups: 7, faces: [
    { name: "log", capability: "日志函数" },
    { name: "managerPort", capability: "fan-out 管理器端口" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "attributionAgingMs", capability: "归属老化阈值：配置" },
    { name: "resolveChildSession", capability: "子会话解析" },
    { name: "parentAgentOf", capability: "父 agent 解析" },
    { name: "hasContinueRoute", capability: "续作路由判定" },
  ] },
  { file: "host/fanout-event-log.js", name: "createFanoutEventLog", groups: 0 },
  { file: "host/fanout-lifecycle.js", name: "createAdmissionHandle", groups: 0 },
  { file: "host/fanout-lifecycle.js", name: "createAgentHandlers", groups: 4 },
  { file: "host/fanout-lifecycle.js", name: "createAttemptAdmission", groups: 7, faces: [
    { name: "log", capability: "日志函数" },
    { name: "attribution", capability: "fan-out 归属判定与 aging" },
    { name: "buildRequest", capability: "子 agent 请求构建" },
    { name: "startContinuable", capability: "可续作子 agent 启动" },
    { name: "continueMessage", capability: "续作消息投递" },
    { name: "settlement", capability: "任务结算记录" },
    { name: "requestInterrupt", capability: "中断请求回调" },
  ] },
  { file: "host/fanout-lifecycle.js", name: "createAttemptInterrupt", groups: 3 },
  { file: "host/fanout-lifecycle.js", name: "createDeferred", groups: 0 },
  { file: "host/fanout-lifecycle.js", name: "createFanoutLifecycle", groups: 8, faces: [
    { name: "log", capability: "日志函数" },
    { name: "attribution", capability: "fan-out 归属判定与 aging" },
    { name: "managerPort", capability: "fan-out 管理器端口" },
    { name: "buildRequest", capability: "子 agent 请求构建" },
    { name: "startContinuable", capability: "可续作子 agent 启动" },
    { name: "continueMessage", capability: "续作消息投递" },
    { name: "interrupt", capability: "中断请求投递" },
    { name: "onAgentCreated", capability: "agent 创建钩子" },
  ] },
  { file: "host/fanout-lifecycle.js", name: "createRecordSettlement", groups: 1 },
  { file: "host/fanout-lifecycle.js", name: "createRuntimeClose", groups: 5 },
  { file: "host/fanout-ownership.js", name: "createFanoutOwnershipService", groups: 6, faces: [
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "getAgent", capability: "宿主 agent 查询" },
    { name: "getManager", capability: "fan-out 管理器获取" },
    { name: "continuationReadiness", capability: "续作就绪判定" },
    { name: "isClosed", capability: "会话关闭判定" },
    { name: "warn", capability: "告警日志" },
  ] },
  { file: "host/fanout-ownership.js", name: "createOwnershipIndex", groups: 2 },
  { file: "host/fanout-persistence.js", name: "createFanoutPersistenceService", groups: 7, faces: [
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "getManager", capability: "fan-out 管理器获取" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "persistenceHealth", capability: "持久化健康检查" },
    { name: "retryBackoff", capability: "持久化重试退避" },
    { name: "warn", capability: "告警日志" },
    { name: "ownership", capability: "child 归属索引" },
  ] },
  { file: "host/fanout-restore.js", name: "createFanoutRestoreService", groups: 7, faces: [
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "getAgent", capability: "宿主 agent 查询" },
    { name: "getManager", capability: "fan-out 管理器获取" },
    { name: "readSnapshot", capability: "快照读取" },
    { name: "ownership", capability: "child 归属索引" },
    { name: "persistence", capability: "快照持久化读写" },
    { name: "warn", capability: "告警日志" },
  ] },
  {
    file: "host/fanout-runtime.js",
    name: "createFanoutRuntimeModule",
    // 票据 03：新增 prepareAttempt（派发前路由冻结 seam）→ 25 个形参。
    groups: 25,
    faces: [
      { name: "createRuntime", capability: "runtime 构造回调" },
      { name: "runtimeOptions", capability: "runtime 选项袋" },
      { name: "concurrencyLimit", capability: "并发上限：配置" },
      { name: "roleLimits", capability: "角色限额：配置" },
      { name: "providerLimits", capability: "提供商并发上限：配置" },
      { name: "roleTimeoutMs", capability: "角色超时：配置" },
      { name: "onFanoutEvent", capability: "fan-out 事件回调" },
      { name: "buildRequest", capability: "子 agent 请求构建" },
      { name: "startContinuable", capability: "可续作子 agent 启动" },
      { name: "continueMessage", capability: "续作消息投递" },
      { name: "resolveChildSession", capability: "子会话解析" },
      { name: "interrupt", capability: "中断请求投递" },
      { name: "onAgentCreated", capability: "agent 创建钩子" },
      { name: "prepareAttempt", capability: "派发前路由冻结：attempt 进入 running 之前同步构造快照" },
      { name: "lineage", capability: "agent 血缘与任务记录" },
      { name: "getAgent", capability: "宿主 agent 查询" },
      { name: "buildFeedback", capability: "父任务反馈构建" },
      { name: "injectFeedback", capability: "父任务反馈注入" },
      { name: "onParentSettled", capability: "父任务结算回调" },
      { name: "writeSnapshot", capability: "快照写入" },
      { name: "readSnapshot", capability: "快照读取" },
      { name: "persistenceHealth", capability: "持久化健康检查" },
      { name: "retryBackoff", capability: "持久化重试退避" },
      { name: "getPersistenceGeneration", capability: "持久化代次读取" },
      { name: "logger", capability: "日志器" },
    ],
    reason: "【组合根豁免】fanout 子系统的中心组合根（与 createFanoutRuntime 同一注入面，但多 5 个只在模块层消费的 seam）：装配全部执行 seam，规格书 §C3 与组合根条款明确豁免",
  },
  { file: "host/handoff.js", name: "createHandoffRegistryModule", groups: 0 },
  { file: "host/index-agent-created.js", name: "createAgentCreatedHandler", groups: 8, faces: [
    { name: "logger", capability: "日志器" },
    { name: "rootWait", capability: "root turn 等待注册表" },
    { name: "fanout", capability: "fan-out 管理器端口" },
    { name: "roots", capability: "根集合与根存活判定" },
    { name: "guards", capability: "专家发送/报告拦截" },
    { name: "effort", capability: "思考深度：effort标记" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "snapshot", capability: "fan-out 快照序列化" },
  ] },
  { file: "host/index-agent-disposed.js", name: "createAgentDisposedHandler", groups: 8, faces: [
    { name: "logger", capability: "日志器" },
    { name: "roots", capability: "根集合与根存活判定" },
    { name: "fanout", capability: "fan-out 管理器端口" },
    { name: "guards", capability: "专家发送/报告拦截" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "effort", capability: "思考深度：effort标记" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "snapshot", capability: "fan-out 快照序列化" },
  ] },
  { file: "host/index-agent-records.js", name: "createAgentRecordRegistration", groups: 5 },
  { file: "host/index-agent-request-error.js", name: "createAgentRequestErrorHandler", groups: 2 },
  { file: "host/index-agent-snapshot.js", name: "createAgentSnapshotDomain", groups: 5 },
  { file: "host/index-auto-recovery.js", name: "createAutoRecoveryDispatch", groups: 6, faces: [
    { name: "logger", capability: "日志器" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "subagents", capability: "子 agent 服务：启动/续作" },
    { name: "flow", capability: "自动恢复流程" },
    { name: "rebuild", capability: "child 重建闭包" },
  ] },
  { file: "host/index-auto-recovery.js", name: "createAutoRecoveryFlow", groups: 7, faces: [
    { name: "logger", capability: "日志器" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "dispatch", capability: "通知/事件分发" },
  ] },
  { file: "host/index-auto-recovery.js", name: "createRecoveryChildRebuild", groups: 8, faces: [
    { name: "records", capability: "agent 记录注册表" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "experts", capability: "专家组运行态读面" },
    { name: "structured", capability: "结构化结果封装" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
  ] },
  { file: "host/index-auto-recovery.js", name: "createRecoveryEventBridge", groups: 8, faces: [
    { name: "logger", capability: "日志器" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "rootWait", capability: "root turn 等待注册表" },
    { name: "notifications", capability: "通知服务：Toast/系统通知" },
    { name: "fanout", capability: "fan-out 管理器端口" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
  ] },
  { file: "host/index-capability-report.js", name: "createHostCapabilityReport", groups: 6, faces: [
    { name: "services", capability: "宿主服务集合：ctx.services" },
    { name: "ctxProbe", capability: "Context 能力探针：locale/waterfall" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "attachments", capability: "附件服务：存储与配额" },
    { name: "sessionQuery", capability: "会话查询服务" },
    { name: "connection", capability: "DSH Connection 通道" },
  ] },
  { file: "host/index-connection-channel.js", name: "createConnectionChannel", groups: 8, faces: [
    { name: "logger", capability: "日志器" },
    { name: "hostRpc", capability: "宿主 RPC 通道" },
    { name: "webServer", capability: "宿主 HTTP web server" },
    { name: "http", capability: "HTTP 路由注册" },
    { name: "errorTracker", capability: "RPC 错误追踪器" },
    { name: "lifecycle", capability: "连接生命周期" },
    { name: "dispatch", capability: "通知/事件分发" },
    { name: "fallbackEffect", capability: "Connection 回落 effect" },
  ] },
  { file: "host/index-effort-retire.js", name: "createEffortRetireDomain", groups: 7, faces: [
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "prelude", capability: "入口前置装配：config/logger" },
    { name: "rootWait", capability: "root turn 等待注册表" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "fanout", capability: "fan-out 管理器端口" },
  ] },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolClosures", groups: 8, faces: [
    { name: "handles", capability: "child 显式句柄" },
    { name: "rebuild", capability: "child 重建闭包" },
    { name: "steer", capability: "child 续作引导闭包" },
    { name: "continuation", capability: "续作判定与消息构造" },
    { name: "newChild", capability: "新建 child 闭包" },
    { name: "restoreChild", capability: "child 快照恢复闭包" },
    { name: "delegatePaths", capability: "委派路径策略" },
    { name: "scopeAdmission", capability: "scope 准入闭包" },
  ] },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolContinue", groups: 3 },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolDelegatePaths", groups: 3 },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolHandles", groups: 5 },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolNewChild", groups: 8, faces: [
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "recoveryFlow", capability: "自动恢复流程" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "usage", capability: "用量账本" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
  ] },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolRebuild", groups: 8, faces: [
    { name: "records", capability: "agent 记录注册表" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "recoveryFlow", capability: "自动恢复流程" },
    { name: "usage", capability: "用量账本" },
    { name: "storage", capability: "存储服务：持久化域读写" },
  ] },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolRestoreChild", groups: 6, faces: [
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "usage", capability: "用量账本" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
  ] },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolScopeAdmission", groups: 4 },
  { file: "host/index-expert-tools-admission.js", name: "createRoleToolSteer", groups: 6, faces: [
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "recoveryFlow", capability: "自动恢复流程" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "childIo", capability: "child 会话 IO：发送/续作" },
  ] },
  { file: "host/index-expert-tools-core.js", name: "createExpertActivationStarter", groups: 3 },
  { file: "host/index-expert-tools-core.js", name: "createExpertAdmissionFacts", groups: 5 },
  { file: "host/index-expert-tools-core.js", name: "createExpertChannelResolver", groups: 2 },
  { file: "host/index-expert-tools-core.js", name: "createExpertOutputSchemaSupport", groups: 1 },
  { file: "host/index-expert-tools-core.js", name: "createExpertStructuredResults", groups: 2 },
  { file: "host/index-expert-tools-core.js", name: "createIndexExpertToolsCore", groups: 5 },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutChildHandlers", groups: 5 },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutDeclarationCaches", groups: 2 },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutRequestBuilder", groups: 6, faces: [
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "models", capability: "模型目录/选择读面" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "caches", capability: "fan-out 声明缓存" },
  ] },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutRuntimeWiring", groups: 8, faces: [
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "waits", capability: "shard 等待登记" },
    { name: "caches", capability: "fan-out 声明缓存" },
    { name: "hooks", capability: "工具挂载 hooks" },
    { name: "commands", capability: "任务命令：取消/重试/停止" },
    { name: "logger", capability: "日志器" },
  ] },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutShardWaits", groups: 3 },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutTaskCommands", groups: 5 },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutToolHooks", groups: 7, faces: [
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "childIo", capability: "child 会话 IO：发送/续作" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "waits", capability: "shard 等待登记" },
    { name: "requestBuilder", capability: "子请求构建器" },
    { name: "childHandlers", capability: "child 工具处理器集合" },
    { name: "dispatch", capability: "派发期只读读面：设置快照 + 时钟" },
  ] },
  { file: "host/index-expert-tools-fanout.js", name: "createFanoutWaitLedger", groups: 5 },
  { file: "host/index-expert-tools-role.js", name: "createIndexExpertRoleTools", groups: 6, faces: [
    { name: "closures", capability: "role 工具闭包集合" },
    { name: "definition", capability: "工具定义注册面" },
    { name: "observerRoute", capability: "Observer 路由" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "logger", capability: "日志器" },
  ] },
  { file: "host/index-expert-tools-role.js", name: "createRoleToolDefinition", groups: 2 },
  { file: "host/index-expert-tools-role.js", name: "createRoleToolDispatch", groups: 6, faces: [
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "models", capability: "模型目录/选择读面" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
  ] },
  { file: "host/index-expert-tools-role.js", name: "createRoleToolExecute", groups: 4 },
  { file: "host/index-expert-tools-role.js", name: "createRoleToolObserverRoute", groups: 4 },
  { file: "host/index-expert-tools-surface.js", name: "createFanoutToolSurface", groups: 6, faces: [
    { name: "commands", capability: "任务命令：取消/重试/停止" },
    { name: "models", capability: "模型目录/选择读面" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "toolMount", capability: "工具挂载面" },
  ] },
  { file: "host/index-expert-tools-surface.js", name: "createRoutingPrompt", groups: 5 },
  { file: "host/index-fanout-rpc.js", name: "createFanoutRpcReads", groups: 4 },
  { file: "host/index-finalize.js", name: "createFinalizeDomain", groups: 7, faces: [
    { name: "host", capability: "宿主装配状态袋" },
    { name: "rootWait", capability: "root turn 等待注册表" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "diagnostics", capability: "运行诊断投影" },
    { name: "admission", capability: "admission 域：pending 登记与退休记录" },
    { name: "notification", capability: "通知投递" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
  ] },
  { file: "host/index-handoff.js", name: "createHandoffDomain", groups: 7, faces: [
    { name: "host", capability: "宿主装配状态袋" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "diagnostics", capability: "运行诊断投影" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "admission", capability: "admission 域：pending 登记与退休记录" },
    { name: "turnEnd", capability: "turn 结束事件" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
  ] },
  { file: "host/index-image-claims.js", name: "createImageRouteClaims", groups: 4 },
  { file: "host/index-image-route.js", name: "createImageRouteWire", groups: 2 },
  { file: "host/index-manual-dispatch.js", name: "createManualFanoutDispatch", groups: 7, faces: [
    { name: "failures", capability: "失败记录与重试判定" },
    { name: "routing", capability: "故障转交路由" },
    { name: "commands", capability: "任务命令：取消/重试/停止" },
    { name: "core", capability: "专家工具核心域句柄" },
    { name: "abort", capability: "请求中止信号/AbortSignal 读面" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "reads", capability: "RPC 只读投影" },
  ] },
  // 主代理（Orchestrator）模型配置运行期（批次 A）：6 个能力组
  // （settings 快照读面 / 根会话判定与 sessionController 读取 / catalog 预检 / 时钟 / logger /
  // DEG 持久化域）。时钟组按仓接口径把 now + setTimeout + clearTimeout 折叠成 1 组
  // （与 createFanoutRuntime 同款）；持久化组把"功能启用切点"与"手动接管的会话覆盖写入"
  // 折叠成 1 组，因为它们同属 DEG 自己的 storage domain。
  { file: "host/orchestrator-model.js", name: "createOrchestratorModelManager", groups: 6, faces: [
    { name: "settings", capability: "设置快照读取" },
    { name: "host", capability: "根 agent 判定与宿主服务读取" },
    { name: "models", capability: "模型目录预检" },
    { name: "clock", capability: "时钟能力：now 与边界定时器" },
    { name: "logger", capability: "日志器" },
    { name: "persistence", capability: "持久化域：功能启用切点与会话覆盖写入" },
  ] },
  // 主代理写入管线（批次 A）：设置快照 / catalog 预检 / 时钟 / logger / 持久化域（手动接管写入）。
  { file: "host/orchestrator-write.js", name: "createOrchestratorWriter", groups: 5 },
  // 主代理功能启用切点（B3）：storage binding 读面 + 持久化原语（+ 只记类别的 logger）。
  { file: "host/orchestrator-epoch.js", name: "createOrchestratorEpochStore", groups: 3 },
  // 会话覆盖的 durable 写入（RPC 与运行期共用）：存储写面 / 读投影 / 冲突构造器。
  { file: "host/session-override-store.js", name: "createSessionOverrideStore", groups: 3 },
  { file: "host/index-model-route.js", name: "createIndexModelRouteDomain", groups: 8, faces: [
    { name: "settings", capability: "设置读写服务" },
    { name: "settingsRuntime", capability: "设置运行期：派生/缓存" },
    { name: "settingsRead", capability: "设置只读投影" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "getFanoutHost", capability: "fan-out 宿主句柄获取" },
    { name: "normalizeSubagentProvider", capability: "子代理 provider 归一" },
    { name: "llm", capability: "LLM 服务：模型调用" },
    { name: "ValidationError", capability: "参数校验错误构造器：ValidationError 类" },
  ] },
  { file: "host/index-prelude.js", name: "createIndexPrelude", groups: 7, faces: [
    { name: "config", capability: "插件配置读面：Config" },
    { name: "logger", capability: "日志器" },
    { name: "settings", capability: "设置读写服务" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "isRootAgent", capability: "根 agent 判定" },
    { name: "getFanoutHost", capability: "fan-out 宿主句柄获取" },
    { name: "isTurnWaitStopping", capability: "turn 等待停止判定" },
  ] },
  { file: "host/index-recovery.js", name: "createIndexRecoveryDomain", groups: 8, faces: [
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "ensureModelRouteOverride", capability: "模型路由覆盖安装" },
    { name: "finalize", capability: "任务结收域" },
    { name: "handoff", capability: "handoff 服务：pending 交接" },
    { name: "host", capability: "宿主装配状态袋" },
    { name: "identity", capability: "根/会话身份归一：lineage" },
    { name: "storage", capability: "存储服务：持久化域读写" },
  ] },
  { file: "host/index-root-wait.js", name: "createRootWaitDomain", groups: 8, faces: [
    { name: "config", capability: "插件配置读面：Config" },
    { name: "host", capability: "宿主装配状态袋" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "diagnostics", capability: "运行诊断投影" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "notification", capability: "通知投递" },
    { name: "hostEvents", capability: "宿主事件订阅" },
    { name: "waterfall", capability: "宿主 waterfall 中间件" },
  ] },
  { file: "host/index-rpc-action-core.js", name: "createIndexRpcActionCore", groups: 8, faces: [
    { name: "runtime", capability: "fan-out runtime 句柄" },
    { name: "session", capability: "宿主会话快照/当前会话袋" },
    { name: "settings", capability: "设置读写服务" },
    { name: "subagents", capability: "子 agent 服务：启动/续作" },
    { name: "image", capability: "图片路由服务" },
    { name: "manualDispatch", capability: "手动派发服务" },
    { name: "notifications", capability: "通知服务：Toast/系统通知" },
    { name: "reads", capability: "RPC 只读投影" },
  ] },
  { file: "host/index-rpc-action-core.js", name: "createRpcActionResponder", groups: 2 },
  { file: "host/index-rpc-action-session.js", name: "createIndexRpcActionSession", groups: 4 },
  { file: "host/index-rpc-http.js", name: "createRpcHttpSurface", groups: 3 },
  { file: "host/index-runtime-diagnostics.js", name: "createRuntimeDiagnostics", groups: 8, faces: [
    { name: "host", capability: "宿主装配状态袋" },
    { name: "settings", capability: "设置读写服务" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "recovery", capability: "恢复服务：checkpoint/重建" },
    { name: "fanout", capability: "fan-out 管理器端口" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "delegation", capability: "委派服务：任务清单/次数/预算" },
    { name: "observability", capability: "turn 等待可观测记录" },
  ] },
  { file: "host/index-settings-storage.js", name: "createIndexSettingsStorageDomain", groups: 7, faces: [
    { name: "storageBinding", capability: "存储绑定：waitReady" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "logger", capability: "日志器" },
    { name: "persistenceHealth", capability: "持久化健康检查" },
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "getFanoutHost", capability: "fan-out 宿主句柄获取" },
    { name: "onStorageRestored", capability: "存储恢复回调" },
  ] },
  { file: "host/index-template-plan.js", name: "createFanoutTemplatePlanner", groups: 3 },
  { file: "host/index-template-store.js", name: "createFanoutTemplateStore", groups: 2 },
  { file: "host/index-toast.js", name: "createSystemToastChannel", groups: 5 },
  { file: "host/index-upload-normalize.js", name: "createUploadNormalizer", groups: 6, faces: [
    { name: "ValidationError", capability: "参数校验错误构造器：ValidationError 类" },
    { name: "attachmentAccess", capability: "附件读取/落盘能力" },
    { name: "wire", capability: "上传请求 wire 解析" },
    { name: "imagePipeline", capability: "图片转码管线" },
    { name: "abort", capability: "请求中止信号/AbortSignal 读面" },
    { name: "limits", capability: "角色/提供商并发与超时限额" },
  ] },
  { file: "host/index-usage-attribution.js", name: "createIndexUsageAttributionDomain", groups: 7, faces: [
    { name: "logger", capability: "日志器" },
    { name: "records", capability: "agent 记录注册表" },
    { name: "storage", capability: "存储服务：持久化域读写" },
    { name: "agents", capability: "宿主 agent 查询：getAgent/list" },
    { name: "lineage", capability: "agent 血缘与任务记录" },
    { name: "roles", capability: "角色注册表与启用态" },
    { name: "childModelPatch", capability: "子会话模型覆盖补丁" },
  ] },
  { file: "host/lineage.js", name: "createLineageModule", groups: 7, faces: [
    { name: "disposedRoots", capability: "已销毁根集合" },
    { name: "isRootAgent", capability: "根 agent 判定" },
    { name: "getAgent", capability: "宿主 agent 查询" },
    { name: "getTask", capability: "任务记录读取" },
    { name: "listTasks", capability: "任务列表查询" },
    { name: "now", capability: "时间源函数" },
    { name: "isGenerationBlocked", capability: "代次阻塞判定" },
  ] },
  { file: "host/notifications.js", name: "createNotificationModule", groups: 2 },
  { file: "host/persistence-health.js", name: "createPersistenceHealth", groups: 2 },
  { file: "host/recovery.js", name: "createRecoveryModule", groups: 6, faces: [
    { name: "limit", capability: "恢复记录上限：配置" },
    { name: "taskBindingLimit", capability: "任务绑定上限：配置" },
    { name: "effortMarker", capability: "effort 标记键" },
    { name: "subagentProviderMarker", capability: "子代理 provider 标记键" },
    { name: "inheritContextMarker", capability: "继承上下文标记键" },
    { name: "disposeHooks", capability: "agent 销毁钩子" },
  ] },
  { file: "host/rpc-request-lifecycle.js", name: "createAbortError", groups: 0 },
  { file: "host/rpc-request-lifecycle.js", name: "createRpcRequestLifecycle", groups: 2 },
  { file: "host/rpc-transport.js", name: "createConnectionRegistration", groups: 4 },
  { file: "host/rpc-transport.js", name: "createRpcAbortError", groups: 0 },
  { file: "host/rpc-transport.js", name: "createRpcTransportModule", groups: 3 },
  { file: "host/runtime-diagnostics.js", name: "createRpcErrorTracker", groups: 1 },
  { file: "host/send-message-shadow.js", name: "createShadowedExpertSendMessageDefinition", groups: 0 },
  { file: "host/settings-runtime.js", name: "createSettingsRuntimeModule", groups: 2 },
  { file: "host/settings-source.js", name: "createSettingsSourceModule", groups: 1 },
  { file: "host/snapshot-cache.js", name: "createCacheEntry", groups: 0 },
  { file: "host/snapshot-cache.js", name: "createSnapshotCache", groups: 5 },
  { file: "host/snapshot-cache.js", name: "createSortAnchorQuery", groups: 0 },
  { file: "host/storage-binding.js", name: "createStorageBindingModule", groups: 1 },
  { file: "host/system-toast.js", name: "createSystemToastModule", groups: 3 },
  { file: "host/turn-wait.js", name: "createDeferred", groups: 0 },
  { file: "host/turn-wait.js", name: "createRootTurnWaitRegistry", groups: 8, faces: [
    { name: "isLiveRoot", capability: "根存活判定" },
    { name: "snapshotDescendants", capability: "后代订阅快照" },
    { name: "subscribe", capability: "事件订阅注册" },
    { name: "onKnownSnapshot", capability: "已登记快照回调" },
    { name: "onError", capability: "错误回调" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "notifications", capability: "通知服务：Toast/系统通知" },
    { name: "config", capability: "插件配置读面：Config" },
  ] },
  { file: "host/turn-wait.js", name: "createTurnWaitCommands", groups: 3 },
  { file: "host/turn-wait.js", name: "createTurnWaitLifecycle", groups: 2 },
  { file: "host/turn-wait.js", name: "createTurnWaitObservability", groups: 1 },
  { file: "host/turn-wait.js", name: "createTurnWaitRecord", groups: 0 },
  { file: "host/turn-wait.js", name: "createTurnWaitState", groups: 8, faces: [
    { name: "isLiveRoot", capability: "根存活判定" },
    { name: "snapshotDescendants", capability: "后代订阅快照" },
    { name: "subscribe", capability: "事件订阅注册" },
    { name: "onKnownSnapshot", capability: "已登记快照回调" },
    { name: "onError", capability: "错误回调" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "notifications", capability: "通知服务：Toast/系统通知" },
    { name: "config", capability: "插件配置读面：Config" },
  ] },
  { file: "host/usage-ledger.js", name: "createFlushHelper", groups: 3 },
  { file: "host/usage-ledger.js", name: "createLedgerStats", groups: 0 },
  { file: "host/usage-ledger.js", name: "createSessionState", groups: 0 },
  { file: "host/usage-ledger.js", name: "createUsageLedger", groups: 6, faces: [
    { name: "persist", capability: "用量持久化写面" },
    { name: "attributionOf", capability: "用量归属函数：按会话/根" },
    { name: "clock", capability: "时间源：Date.now 注入" },
    { name: "debounceMs", capability: "用量落盘防抖：配置" },
    { name: "maxSessions", capability: "用量账本会话上限：配置" },
    { name: "logger", capability: "日志器" },
  ] },
  { file: "index.js", name: "createAssemblyCapabilities", groups: 2 },
  { file: "index.js", name: "createAssemblyState", groups: 4 },
  { file: "resource-budget.js", name: "createEventHistoryAccounting", groups: 1 },
  { file: "role-registry.js", name: "createRoleRegistry", groups: 1 },
  { file: "rpc-host.js", name: "createConnectionRpcHandler", groups: 2 },
  { file: "shared/capacity-errors.js", name: "createSubagentCapacityError", groups: 2 },
  { file: "shared/delegation-cohort.js", name: "createAdmissionBatchCoordinator", groups: 0 },
  { file: "shared/delegation-cohort.js", name: "createHandoffAdmissionCohort", groups: 0 },
  { file: "shared/delegation-tracker.js", name: "createDelegationTracker", groups: 2 },
  { file: "shared/delegation-tracker.js", name: "createTrackerState", groups: 3 },
  { file: "shared/native-text.js", name: "createNativeTextRewriter", groups: 6, faces: [
    { name: "findNode", capability: "目标节点查找" },
    { name: "getText", capability: "字段文本读取" },
    { name: "setText", capability: "字段文本写入" },
    { name: "isConnected", capability: "节点连接态判定" },
    { name: "decorate", capability: "DOM 文本装饰写入" },
    { name: "undecorate", capability: "DOM 装饰撤销/还原" },
  ] },
  { file: "shared/recovery-ledger.js", name: "createFeedbackIdentityLedger", groups: 1 },
  { file: "shared/retry-policy.js", name: "createRecoveryOp", groups: 0 },
  { file: "shared/retry-policy.js", name: "createRequestRetryState", groups: 1 },
  { file: "shared/session-generation.js", name: "createHandoffFailureRegistry", groups: 0 },
  { file: "shared/session-generation.js", name: "createSessionGenerationState", groups: 0 },
  { file: "storage.js", name: "createBindingController", groups: 0 },
  { file: "storage.js", name: "createInitializationGate", groups: 0 },
  // ── 票据 34 补齐：oracle 第二轮发现的 55 项差集里 52 个**真工厂** ────────────
  // 差集来源：按 `^[ \t]*(export\s+)?(async\s+)?function\s+(create\w*)\s*\(` 扫全部产品源码，
  // 与「登记表 ∪ 例外表」求差集（见 inspectFactoryRegistry 的 reconcile 分支）。此前的清单
  // 只覆盖 host/、fanout/、shared/ 与少量根模块，客户端 R5–R8 拆分产物（client-*.js）整批漏记。
  //
  // 组数口径（与台账 §2.1 一致，逐条按关注点归并，不按字段数）：
  // - 一个**外部协作面**（宿主服务/端口、宿主 RPC 命令、DOM 或 React 运行时、UI 原语库、
  //   同帧下层工厂句柄、共享容器）各算 1 组；
  // - 同一个 owner 自己的状态袋（React state/ref/setter、组件每轮渲染的 view/scope/frame 袋）
  //   属同源，归 1 组——这与台账 §2.10 已签核的 `assembleXxx(state, caps) = 2` 同一口径；
  // - 纯数据入参（id、布尔开关、快照值）不单独成组；
  // - 工厂内部当场构造的子单元（如 createSidebarAutoController 里 new 出来的 4 个子面）
  //   不是注入，计 0 组。
  // 也就是说：这些条目的组数 = 「这段代码真正从外面拿到的能力面个数」，不是解构字段数。
  { file: "client-expert-group-model-format.js", name: "createTaskFilter", groups: 0 },
  { file: "client-expert-group-model-format.js", name: "createExpansionStore", groups: 1 },
  { file: "client-expert-group-sidebar.js", name: "createExpertGroupPanel", groups: 3 },
  { file: "client-focus-return.js", name: "createRemoveFocusObservationLedger", groups: 0 },
  { file: "client-model-config-host.js", name: "createModelConfigHost", groups: 3 },
  { file: "client-model-config-rows.js", name: "createSchemaAdapter", groups: 2 },
  { file: "client-model-config-rows.js", name: "createCardSession", groups: 0 },
  { file: "client-model-config.js", name: "createCustomProviderDraft", groups: 0 },
  { file: "client-native-status.js", name: "createNativeTextRewriter", groups: 6, faces: [
    { name: "findNode", capability: "目标节点查找" },
    { name: "getText", capability: "字段文本读取" },
    { name: "setText", capability: "字段文本写入" },
    { name: "isConnected", capability: "节点连接态判定" },
    { name: "decorate", capability: "DOM 文本装饰写入" },
    { name: "undecorate", capability: "DOM 装饰撤销/还原" },
  ] },
  { file: "client-native-status.js", name: "createNativeStatusRowRewriter", groups: 1 },
  { file: "client-nav-icon.js", name: "createDegSettingsNavIcon", groups: 2 },
  { file: "client-settings-main-a.js", name: "createSettingsSaveAction", groups: 4 },
  { file: "client-settings-main-a.js", name: "createModelPageActions", groups: 1 },
  { file: "client-settings-main-a.js", name: "createModelTabDragController", groups: 1 },
  { file: "client-settings-main-b.js", name: "createSettingsTailActions", groups: 3 },
  { file: "client-settings-normalize.js", name: "createSettingsModelCatalog", groups: 2 },
  { file: "client-sidebar-actions.js", name: "createSidebarActions", groups: 8, faces: [
    { name: "frame", capability: "面板每帧渲染袋" },
    { name: "session", capability: "宿主会话快照/当前会话袋" },
    { name: "actions", capability: "侧栏动作集合：展开/折叠/切换" },
    { name: "dom", capability: "DOM 读写：面板根节点" },
    { name: "tabs", capability: "宿主右栏标签集合" },
    { name: "auto", capability: "Sidebar Auto 控制器" },
    { name: "dedupe", capability: "重复自愈的去重判定" },
    { name: "split", capability: "侧栏分栏控制" },
  ] },
  { file: "client-sidebar-auto-controller.js", name: "createSidebarTabClosePort", groups: 3 },
  { file: "client-sidebar-auto-controller.js", name: "createSidebarAutoBookkeeping", groups: 2 },
  { file: "client-sidebar-auto-controller.js", name: "createSidebarCloseVerification", groups: 6, faces: [
    { name: "hostSidebar", capability: "宿主右栏 tabs 服务" },
    { name: "tabs", capability: "宿主右栏标签集合" },
    { name: "autoLedger", capability: "共享 Auto 账本：八份 Map" },
    { name: "surface", capability: "面板可写 surface：DOM/状态" },
    { name: "session", capability: "宿主会话快照/当前会话袋" },
    { name: "tabClosePort", capability: "标签关闭端口" },
  ] },
  { file: "client-sidebar-auto-controller.js", name: "createSidebarAutoCandidates", groups: 8, faces: [
    { name: "hostSidebar", capability: "宿主右栏 tabs 服务" },
    { name: "autoLedger", capability: "共享 Auto 账本：八份 Map" },
    { name: "manual", capability: "手动派发标记" },
    { name: "dedupe", capability: "重复自愈的去重判定" },
    { name: "ui", capability: "面板 UI 状态袋" },
    { name: "session", capability: "宿主会话快照/当前会话袋" },
    { name: "tabClosePort", capability: "标签关闭端口" },
    { name: "bookkeeping", capability: "宽度/布局簿记" },
  ] },
  { file: "client-sidebar-auto-controller.js", name: "createSidebarAutoController", groups: 1 },
  { file: "client-sidebar-dom.js", name: "createCatalogLookup", groups: 0 },
  { file: "client-sidebar-dom.js", name: "createBrandIcon", groups: 2 },
  { file: "client-sidebar-install-expand.js", name: "createRightbarExpand", groups: 4 },
  { file: "client-sidebar-install-expand.js", name: "createRightbarComposition", groups: 6, faces: [
    { name: "config", capability: "插件配置读面：Config" },
    { name: "sessions", capability: "宿主会话列表服务" },
    { name: "nativeSidebar", capability: "原生侧栏宿主 API" },
    { name: "layout", capability: "右栏布局：宽度/分栏" },
    { name: "ctx", capability: "Cordis 宿主 Context" },
    { name: "better", capability: "BetterSidebar 宿主基座" },
  ] },
  { file: "client-sidebar-install-expand.js", name: "createSurfaceOpen", groups: 4 },
  { file: "client-sidebar-install-layout.js", name: "createInstantRestoreScheduler", groups: 0 },
  { file: "client-sidebar-install-layout.js", name: "createSidebarInstallLayout", groups: 4 },
  { file: "client-sidebar-install-resources.js", name: "createSidebarInstallCoordinator", groups: 3 },
  { file: "client-sidebar-install-target.js", name: "createSidebarInstallTarget", groups: 8, faces: [
    { name: "config", capability: "插件配置读面：Config" },
    { name: "ctx", capability: "Cordis 宿主 Context" },
    { name: "sessions", capability: "宿主会话列表服务" },
    { name: "better", capability: "BetterSidebar 宿主基座" },
    { name: "nativeSidebar", capability: "原生侧栏宿主 API" },
    { name: "layout", capability: "右栏布局：宽度/分栏" },
    { name: "width", capability: "右栏宽度记账" },
    { name: "expand", capability: "右栏展开态控制" },
  ] },
  { file: "client-sidebar-install-target.js", name: "createSidebarSplitTransactions", groups: 4 },
  { file: "client-sidebar-install-width.js", name: "createWidthBookkeeping", groups: 3 },
  { file: "client-sidebar-install-width.js", name: "createRightbarWidthWriter", groups: 5 },
  { file: "client-sidebar-layout.js", name: "createRightbarDragLock", groups: 0 },
  { file: "client-sidebar-layout.js", name: "createSplitTrackRatio", groups: 0 },
  { file: "client-sidebar-overlay.js", name: "createNativeRightbarContinuityOverlay", groups: 0 },
  { file: "client-sidebar-panel-cache.js", name: "createPanelSnapshotCache", groups: 1 },
  { file: "client-sidebar-panel-hooks-actions.js", name: "createSidebarActionContext", groups: 3 },
  { file: "client-sidebar-panel-hooks-effects.js", name: "createPanelRefreshAction", groups: 4 },
  { file: "client-sidebar-panel-hooks-effects.js", name: "createPanelPollCycle", groups: 5 },
  { file: "client-sidebar-panel-hooks-effects.js", name: "createPanelPollScheduler", groups: 4 },
  { file: "client-sidebar-panel-state-a.js", name: "createPanelTranslator", groups: 2 },
  { file: "client-sidebar-panel.js", name: "createSidebarPanelShared", groups: 3 },
  { file: "client-sidebar-panel.js", name: "createSidebarPanelFrame", groups: 2 },
  { file: "client-sidebar-panel.js", name: "createSidebarPanel", groups: 3 },
  { file: "client-sidebar-views-a.js", name: "createSidebarViewsA", groups: 1 },
  { file: "client-sidebar-views-b.js", name: "createSidebarViewsB", groups: 2 },
  { file: "client-sidebar-views-c.js", name: "createSidebarViewsC", groups: 3 },
  { file: "client-entry.js", name: "createClientFreshnessBoundary", groups: 2 },
  { file: "host/index-expert-tools-admission.js", name: "createNewChild", groups: 4 },
  // 票据 03：root admission 批次从 host/index-recovery.js 迁到独立模块（文件行数门禁），
  // 工厂本身不变（0 组：批次表是本模块私有 WeakMap，没有外部协作面）。
  { file: "host/index-admission-batches.js", name: "createRootAdmissionBatch", groups: 0 },
  // ── 票据 35/36：变量绑定声明（全深度收集后逐条分类）────────────────────────
  // 票据 35 首次把 `const/let createX = …` 纳入对账；票据 36（第四轮复审）把两种形态
  // 统一成「全深度收集 + 逐条分类」。实测产品源码共 14 条变量声明（其中 2 条模块级、
  // 12 条嵌套），分类如下：
  // - 模块级真工厂 1 条 → 本清单（createSidebarSharedAutoLedger）；
  // - 模块级运行期注入位 1 条 → C3_NON_FACTORY_EXCLUSIONS（createClientFreshnessBoundary）；
  // - 嵌套的**函数值**声明 3 条 → 本清单（下面三条：返回命令面 / 持有状态，属真工厂）；
  // - 嵌套的**值形态**局部变量 9 条（createdAt / created）→ C3_NON_FACTORY_EXCLUSIONS，
  //   理由里写明宿主函数名。
  //
  // 组数口径：
  // - `createSidebarSharedAutoLedger()` 不接受任何协作方，只按常量表建出 8 份 Map 的
  //   共享账本数据结构（与 createSessionState / createCacheEntry / createTurnWaitRecord
  //   同一口径：零注入的数据容器工厂记 0 组）；
  // - 下面三条嵌套工厂的协作方**全部来自闭包**（外层工厂/Hook 的帧），没有注入参数，
  //   因此同样记 0 组；它们的宿主函数写在各自条目上方，便于复核"归谁管"。
  { file: "client-sidebar-auto-ledger.js", name: "createSidebarSharedAutoLedger", groups: 0 },
  // 宿主函数 createNativeStatusRowRewriter：单个字段的读写适配器（返回
  // createNativeTextRewriter 的 apply/restore 命令面），协作方全部来自闭包 → 0 组。
  { file: "client-native-status.js", name: "createFieldRewriter", groups: 0 },
  // 宿主函数 useSidebarPanelStoreAndMeta：展开态 store 的 memo 构造（返回 store 句柄），
  // model / config.storage / rootSessionId 都来自外层 Hook 的 frame → 0 组。
  { file: "client-sidebar-panel-hooks-state.js", name: "createStore", groups: 0 },
  // 宿主函数 installNativeStatusBridge：单会话 lane（持有 rewriter + 身份/RPC 状态 +
  // AbortController），会话 id 是纯数据、其余来自闭包 → 0 组。
  { file: "client-subagent-metadata.js", name: "createLane", groups: 0 },
]);
/**
 * C3 例外表：**名字形如 `create*` 但不是工厂**的纯数据构造 / 纯 helper（票据 34）。
 *
 * 为什么需要它：`inspectFactoryRegistry` 的对账会把「源码里所有 `function create*` 声明
 * **与全深度的 `const/let createX = …` 声明**」与「登记表 ∪ 例外表」求差集，未分类项报
 * `unclassified-factory`。没有例外表，纯数据构造就只能被迫登记成「0 组的工厂」，等于用
 * 假条目污染登记表——C3 的口径从此失去可复核性。
 *
 * 票据 36 起，**嵌套的局部 helper / 局部变量**也走这张表（全深度收集的必然结果），
 * reason 里**必须写明宿主函数名**（例如「嵌套在 createNativeStatusRowRewriter 内」），
 * 否则复核者无法判断这条例外属于谁的内部实现。
 *
 * 准入条件（两条都必须满足，否则应当登记进 C3_FACTORY_REGISTRY）：
 * 1. **不接收任何协作方**：形参全是纯数据（值/快照/路径），没有服务、端口、回调、运行时；
 * 2. **返回纯值**：返回的是数据对象或数据投影，不持有协作方句柄、不暴露有生命周期的命令面。
 *
 * 例外表同样受门禁约束（防它变成垃圾抽屉）：`file`/`name` 必须在源码里真实存在
 * （`stale-exclusion`），`reason` 必须非空，且**不得与登记表重叠**（同一 {file,name} 只能属于
 * 一侧，重叠直接抛错）。
 */
export const C3_NON_FACTORY_EXCLUSIONS = Object.freeze([
  {
    file: "client-model-config-paths.js",
    name: "createEditorBaseline",
    reason: "纯数据构造：入参是 settings 快照与路径，返回 {revision,userSubtree,effectiveSubtree,inherited} 四个深拷贝字段；不注入协作方、不持有状态",
  },
  {
    file: "client-model-config-rows.js",
    name: "createModelRow",
    reason: "纯数据构造：只有一个 id 字符串，返回 {id} 行载体；没有协作方、没有命令面",
  },
  {
    file: "host/expert-group-projection.js",
    name: "createdAtOf",
    reason: "纯 helper（名字以 create 开头但不构造任何东西）：在若干候选时间戳里返回第一个有限非负值，纯函数、无入参协作方",
  },
  {
    file: "client-settings-normalize.js",
    name: "createClientFreshnessBoundary",
    reason: "运行期注入位而非工厂声明（票据 35）：模块级 `let … = null` 只是承接 descriptor 经 bindClientRuntime 注入的工厂引用，本文件不构造它；真正的工厂实现在 client-freshness.js 与 client.js，两处都已按 2 组登记",
  },
  // ── 票据 36：全深度收集后，函数体内的**值形态**局部变量逐条归入例外 ──────────
  // 它们名字以 create 开头，但值是数据（时间戳、集合、容器、别名），不构造任何东西；
  // 宿主函数名逐条写在 reason 里，便于复核"这是谁内部的局部变量"。
  {
    file: "client-expert-group-model-normalize.js",
    name: "createdAt",
    reason: "纯 helper / 局部变量（不是工厂）：= numberOrNull(source.createdAt)，只做时间戳归一，不接收协作方也不返回命令面；嵌套在客户端函数 normalizeSessionNode 内",
  },
  {
    file: "client-freshness.js",
    name: "created",
    reason: "纯 helper / 局部变量（不是工厂）：= new WeakSet()，只做 loader 登记簿的局部集合，无协作方、无命令面；嵌套在函数 registeredLoaderSet 内",
  },
  {
    file: "client-sidebar-auto-ledger.js",
    name: "created",
    reason: "纯 helper / 局部变量（不是工厂）：本文件两处分别为 = createSidebarSharedAutoLedger() 的局部别名与 = { entries, loaded } 的局部记忆容器，均无协作方注入；分别嵌套在 resolveSidebarSharedAutoLedger 与 sidebarOwnershipMemory 内",
  },
  {
    file: "client-sidebar-overlay.js",
    name: "created",
    reason: "纯 helper / 局部变量（不是工厂）：= null 的局部标记，随后在函数体内被重新赋值，不构造对象、不持有协作方；嵌套在函数 capture 内",
  },
  {
    file: "host/expert-group-snapshot.js",
    name: "createdAt",
    reason: "纯 helper / 局部变量（不是工厂）：= numberOrNull(source?.createdAt)，只做时间戳归一，纯值投影；嵌套在函数 projectShardTimeline 内",
  },
  {
    file: "host/notifications.js",
    name: "created",
    reason: "纯 helper / 局部变量（不是工厂）：= { generation, runSeq: 0, publishedRunSeq: null, snapshot: null } 的局部状态袋，由宿主函数内部使用，不注入协作方；嵌套在函数 stateOf 内",
  },
  {
    file: "host/snapshot-cache.js",
    name: "createdAt",
    reason: "纯 helper / 局部变量（不是工厂）：= node.createdAt，只做字段读取，无协作方、无命令面；嵌套在函数 rememberSortAnchor 内",
  },
  {
    file: "host/usage-ledger.js",
    name: "created",
    reason: "纯 helper / 局部变量（不是工厂）：= createSessionState() 的局部别名，真正的会话状态工厂已按 0 组登记；嵌套在函数 stateOf 内",
  },
  // ── 票据 44：AST 让词法器看不见的两处**描述符转发属性**进对账 ────────────────
  // 这两个名字此前完全不在声明清单里：词法器只认 `function createX(` 与 `const/let createX =`，
  // 而它们是**对象字面量里函数值的属性**（`createX: (options) => 真实工厂(options)`）。
  // AST 侧按"方法"形态收集后，差集暴露出这 2 个键；它们不是独立工厂——只是把已登记的
  // 工厂暴露成模块描述符上的端口，因此归入例外而不是登记（否则同一家工厂的能力组会被
  // 数第二遍，C3 的组数口径就被污染了）。
  {
    file: "host/index-expert-tools-fanout.js",
    name: "createRuntime",
    reason: "模块描述符的**转发属性**而非独立工厂：`createRuntime: (options) => createFanoutRuntime(options)` 只是把已登记的 createFanoutRuntime（fanout-host.js，19 组组合根豁免）暴露成 host 端口；函数体里没有自己的协作方集合，若登记会把同一批能力组重复计数。票据 44：词法器看不见对象字面量方法，故此前不在对账范围内",
  },
  {
    file: "host/rpc-transport.js",
    name: "createRegistration",
    reason: "模块描述符的**转发属性**而非独立工厂：`createRegistration: (options) => createConnectionRegistration(options)` 只是把本文件已登记的 createConnectionRegistration（4 组）暴露成 transport 端口；自身不持有状态、不新增能力面。票据 44：词法器看不见对象字面量方法，故此前不在对账范围内",
  },
]);


/**
 * **票据 44 起：本正则不再是对账判据**，只服务于 `collectLexerFactoryDeclarations`
 * （交叉校验的对照侧）。正判据是 `collectFactoryDeclarations` 的 AST 实现。
 *
 * C3 对账用的**声明扫描正则**（票据 34 的规格原文，逐字符对上票面）：
 * `^[ \t]*(export\s+)?(async\s+)?function\s+(create\w*)\s*\(`
 *
 * 口径（票据 36 / 第五轮复审起）：**任意位置的具名 function 声明**，不再以行首锚定。
 * 旧口径的 `^[ \t]*` 会漏掉同一行里的内联声明（例如
 * `if (x) { const createInline = () => {}; }`、`return function createNestedInline() {}`），
 * 新增这种声明既不改变基线也不触发差集——一条可复现的假绿路径。
 * - 词法边界用**零宽 lookbehind** `(?<![A-Za-z0-9_$])`：前一个字符不是标识符字符才认，
 *   避免把 `myfunction createX(` 这类长标识符误认成声明；
 * - `function` 与名字之间允许 `*`（票据 37：`function* createX()` / `async function* createX()`
 *   此前**完全不进清单**——生成器形态的工厂既不参与存在性校验，也不进差集）；
 * - `function` 后必须紧跟空白（或 `*`）再跟 `create*` 名字，因此 `functionName createX(` 不会命中；
 * - `export` / `async` 是可选前缀，IIFE 客户端模块里的缩进声明照常命中；
 * - 不再需要 `m` 标志（没有 `^`），行号由匹配下标换算。
 *
 * 票据 35 起，"变量绑定的工厂"由 `FACTORY_VARIABLE_DECLARATION_PATTERN` 单独扫描。
 *
 * 票据 36（第四轮复审）起，两种形态采用**同一条口径**：都收集**全部深度**的声明，
 * 再由登记表 ∪ 例外表逐条分类。这样"源码里到底有多少个 create* 声明"是一个不随排版/嵌套
 * 变化的超集；漏登记只表现为对账差集（红灯），不会表现为扫描看不见（假绿）。此前
 * "function 全深度、变量只模块级"的不对称连续两轮成为审计焦点，这次直接消除。
 */
const FACTORY_DECLARATION_PATTERN = /(?<![A-Za-z0-9_$])(?:export\s+)?(?:async\s+)?function\s*\*?\s*(create\w*)\s*\(/g;

/**
 * 票据 35 引入、票据 36（第四轮复审）统一口径、票据 36（第五轮复审） 去掉行锚的**变量绑定声明**——
 * **任意位置**的 `const/let createX = …`（含 `export` 前缀，**任意初始值形态**）。
 *
 * 为什么必须扫描它：oracle 第三轮发现清单只扫 `function createX(`，仓库里另有 14 处
 * `const/let createX = …`（实测 `grep -nE '^[ \t]*(export )?(const|let) create\w+ ='`），
 * 其中 `client-sidebar-auto-ledger.js` 的 `createSidebarSharedAutoLedger` 是模块级真工厂，
 * 此前完全漏检——"207 个声明"因此不可信。
 *
 * 口径（票据 36 与 function 形态统一后）：
 * - **任意初始值都算声明**：函数值（`= (` / `= function` / `= async`）、`= null` 注入位、
 *   纯数据值（`= numberOrNull(...)` / `= new WeakSet()` / `= { … }`）都进入声明清单；
 * - **全部深度**：函数体内的局部 create* 变量同样是声明（例如
 *   `createNativeStatusRowRewriter` 内的 `createFieldRewriter`），由登记表/例外表逐条分类；
 * - 值形态但名字以 create 开头的普通变量（例如 `createdAt`）在例外表写明"局部变量、非工厂"
 *   与宿主函数，而不是从扫描里消失——"扫描漏掉"与"人工判定不是工厂"是两件事。
 */
const FACTORY_VARIABLE_DECLARATION_PATTERN = /(?<![A-Za-z0-9_$])(?:export\s+)?(?:const|let)\s+(create\w*)\s*=/g;

/**
 * 纯函数：**词法器侧**的声明收集（票据 34–43 的实现，票据 44 起降级为交叉校验的对照侧）。
 *
 * 两种形态、同一口径（票据 36）：
 * - `function createX(`（含 export / async 前缀、生成器 `*`）；
 * - `const/let createX = …`（任意初始值形态，见 `FACTORY_VARIABLE_DECLARATION_PATTERN`）。
 *
 * 收集是**超集**：模块级声明、IIFE / ModuleLoader 包装体里的声明、函数体内的嵌套声明
 * 全部入册。是否算工厂由登记表与例外表逐条裁决——口径不随排版或嵌套变化，
 * 漏登记只会表现为对账差集（红灯），不会表现为"扫描根本看不见"（假绿）。
 *
 * 匹配在**遮蔽串**上跑（注释/字符串里的 `function createX(` 不是声明），下标与原文
 * 一一对应，行号照常回到原文计算。
 *
 * 为什么保留：票据 44 要求保留旧实现做 `crossCheck`，让"两个实现是否看见同一批声明"
 * 成为可打印、可断言的证据。它**不参与任何判定**——判据是 AST 侧。
 *
 * @param {Array<{file, source}>|Map|Record} sources 参与统计的源码。
 * @returns {Array<{file: string, name: string, line: number, kind: "function"|"variable"}>}
 *   声明清单（file 已归一化）。
 */
export function collectLexerFactoryDeclarations(sources) {
  const records = [];
  for (const entry of normalizeSourceEntries(sources)) {
    // 票据 42：结构完整性校验在遮蔽器内部做，文件名只用于报错定位。
    const masked = maskJavaScriptSource(entry.source, { file: entry.file });
    const lineStarts = buildLineStarts(entry.source);
    /** 形态 → 正则：两种形态同一收集口径（全深度），分类交给登记表/例外表。 */
    const patterns = [
      [FACTORY_DECLARATION_PATTERN, "function"],
      [FACTORY_VARIABLE_DECLARATION_PATTERN, "variable"],
    ];
    for (const [pattern, kind] of patterns) {
      // 每次新建正则实例：带 g 标志的正则有 lastIndex 状态，共享实例会跨文件漏匹配。
      const instance = new RegExp(pattern.source, "gm");
      let match;
      while ((match = instance.exec(masked)) !== null) {
        records.push({
          file: entry.file,
          name: match[1],
          line: lineOf(lineStarts, match.index),
          kind,
        });
      }
    }
  }
  return records.sort(compareFactoryDeclarations);
}

/** 声明记录的稳定键（`file\0name`）：登记表、例外表、差集、测试共用同一构造。 */
export function factoryDeclarationKey(declaration) {
  return declaration.file + "\u0000" + declaration.name;
}

/** 声明清单的排序（file → line → name）；AST 与词法器两侧共用，输出可直接逐项比对。 */
function compareFactoryDeclarations(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * 纯函数：收集源码里**全部深度**的 `create*` 声明（票据 44 起这是**正判据**）。
 *
 * 实现是 `scripts/js-ast-scan.mjs` 的 AST 收集器，口径与词法器对齐并**补上词法器看不见的
 * 形态**（对象字面量里函数值的 `createX` 属性、class 的 `createX()` 方法，见
 * `collectCreateDeclarations`）。为什么要换：词法器靠正则判断"正则字面量 vs 除号"，
 * 这在 JS 里**不可局部判定**——票据 42 / 43 连续两轮都在补它的边界（`throw /[}]/`、
 * `async` 当标识符、class static 块内的 `}`），而每补一次都只是让"已知盲区"变小，
 * 无法证明完备。真实解析器没有这个问题。
 *
 * **fail-closed**：解析失败按"带文件名与行列"抛错，绝不返回空清单——"解析器看不懂"与
 * "源码里没有"必须能被区分开（后者会让对账自动平衡，正是票据 34 要修的假绿）。
 *
 * ## `crossCheck` 选项（票据 44）
 * `{ crossCheck: true }` 时**同时**跑旧词法器实现并返回差异对象：
 * `{ declarations, lexerDeclarations, onlyAst, onlyLexer, multiplicity, differenceCount, same,
 *    astCount, lexerCount, dynamicKeys }`。
 * 默认（不传）只返回 AST 侧数组，保持既有调用点（`inspectFactoryRegistry` 的存在性校验、
 * 对账、测试）的签名不变。差异逐条打印见 `formatFactoryDeclarationCrossCheck`。
 *
 * ## `withDynamicKeys` 选项（票据 46）
 * `{ withDynamicKeys: true }` 时返回 `{ declarations, dynamicKeys }`。为什么需要单独开关：
 * 绝大多数调用点（存在性校验、夹具）只关心声明数组，多返回一层对象会让它们全部改写；
 * C3 对账需要把"无法静态定名的计算键"打印成告警，因此显式索取。
 * `dynamicKeys` 是 `[{ file, line, raw }]`，**不进违规**——运行期才知道它是不是 create* 工厂。
 *
 * @param {Array<{file, source}>|Map|Record} sources 参与统计的源码。
 * @param {{crossCheck?: boolean, withDynamicKeys?: boolean}} [options] 是否附带词法器对照侧 /
 *   是否返回动态计算键清单。
 * @returns {Array<{file: string, name: string, line: number,
 *   kind: "function"|"variable"|"method"}>|object} 声明清单或带对照/动态键的对象。
 */
export function collectFactoryDeclarations(sources, options = {}) {
  const entries = normalizeSourceEntries(sources);
  const declarations = [];
  /** 票据 46：无法静态定名的计算属性键（运行期才知道是不是工厂）。 */
  const dynamicKeys = [];
  for (const entry of entries) {
    // 每个文件解析一次；`parseSource` 内部先 module 再 script，两者都失败即抛错。
    const ast = parseSource(entry.source, entry.file);
    // 原文只用于动态键的 raw 片段（AST 不携带原文）。
    const collected = collectCreateDeclarations(ast, entry.file, { source: entry.source });
    for (const declaration of collected.declarations) declarations.push(declaration);
    for (const dynamicKey of collected.dynamicKeys) dynamicKeys.push(dynamicKey);
  }
  declarations.sort(compareFactoryDeclarations);
  dynamicKeys.sort((left, right) => (left.file !== right.file
    ? (left.file < right.file ? -1 : 1)
    : (left.line - right.line || (left.raw < right.raw ? -1 : left.raw > right.raw ? 1 : 0))));
  if (options.crossCheck === true) {
    const lexerDeclarations = collectLexerFactoryDeclarations(entries);
    return {
      declarations,
      lexerDeclarations,
      dynamicKeys,
      ...compareFactoryDeclarationSets(declarations, lexerDeclarations),
    };
  }
  if (options.withDynamicKeys === true) return { declarations, dynamicKeys };
  return declarations;
}

/**
 * 纯函数：比较 AST 侧与词法器侧的声明集合（票据 44 的交叉校验核心）。
 *
 * 三个桶，语义互不重叠：
 * 1. `onlyAst` —— AST 找到、词法器**完全没看见**的声明（词法器盲区：必须逐条分类）；
 * 2. `onlyLexer` —— 词法器找到、AST 没有的声明（词法器的**误报**：必须修正并记录）；
 * 3. `multiplicity` —— 同一个 `file\0name` 在两侧的出现**次数**不同
 *    （例如同一文件里既有 `function createX` 又有 `createX: () => …` 属性）。
 *
 * 为什么把次数差异单列：`file+name` 是**分类位**（一个键占登记表或例外表的一行），
 * 次数差异不改变分类覆盖，但它确实说明"源码里还有一处实现词法器没看见"——审计要能看到。
 *
 * @param {Array<{file, name, line, kind}>} astDeclarations AST 侧声明。
 * @param {Array<{file, name, line, kind}>} lexerDeclarations 词法器侧声明。
 * @returns {{onlyAst: Array, onlyLexer: Array, multiplicity: Array, astCount: number,
 *   lexerCount: number, differenceCount: number, same: boolean}}
 */
export function compareFactoryDeclarationSets(astDeclarations, lexerDeclarations) {
  const keyOf = factoryDeclarationKey;
  const astKeySet = new Set(astDeclarations.map(keyOf));
  const lexerKeySet = new Set(lexerDeclarations.map(keyOf));
  const onlyAst = astDeclarations.filter((declaration) => !lexerKeySet.has(keyOf(declaration)));
  const onlyLexer = lexerDeclarations.filter((declaration) => !astKeySet.has(keyOf(declaration)));
  /** 每个键在某一侧的出现次数。 */
  const countByKey = (list) => {
    const counts = new Map();
    for (const declaration of list) {
      const key = keyOf(declaration);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const astCounts = countByKey(astDeclarations);
  const lexerCounts = countByKey(lexerDeclarations);
  const multiplicity = [];
  for (const key of new Set([...astCounts.keys(), ...lexerCounts.keys()])) {
    const astCount = astCounts.get(key) ?? 0;
    const lexerCount = lexerCounts.get(key) ?? 0;
    if (astCount === lexerCount) continue;
    // 一侧为 0 的键已经计入 onlyAst / onlyLexer，不重复记账。
    if (astCount === 0 || lexerCount === 0) continue;
    const sample = astDeclarations.find((declaration) => keyOf(declaration) === key)
      ?? lexerDeclarations.find((declaration) => keyOf(declaration) === key);
    multiplicity.push({
      file: sample.file,
      name: sample.name,
      line: sample.line,
      ast: astCount,
      lexer: lexerCount,
    });
  }
  multiplicity.sort(compareFactoryDeclarations);
  const differenceCount = onlyAst.length + onlyLexer.length + multiplicity.length;
  return {
    onlyAst,
    onlyLexer,
    multiplicity,
    astCount: astDeclarations.length,
    lexerCount: lexerDeclarations.length,
    differenceCount,
    same: differenceCount === 0,
  };
}

/**
 * 纯函数：把交叉校验结果格式化成**可打印的文本行**（CLI 与测试共用同一份措辞）。
 *
 * 输出第一行固定为票据 44 要求的形状：`AST 与词法器声明集合差异：N 条`；
 * N 为 0 时追加 `（一致）` 并结束——"没有差异"本身就是要打印的结论，不能让读者去猜。
 *
 * @param {object} crossCheck `compareFactoryDeclarationSets` 的返回值。
 * @returns {string[]} 每项一行（不含末尾换行）。
 */
export function formatFactoryDeclarationCrossCheck(crossCheck) {
  const differenceCount = crossCheck?.differenceCount ?? 0;
  const lines = [
    "AST 与词法器声明集合差异：" + differenceCount + " 条" + (differenceCount === 0 ? "（一致）" : ""),
  ];
  if (differenceCount === 0) return lines;
  const onlyAst = crossCheck.onlyAst ?? [];
  const onlyLexer = crossCheck.onlyLexer ?? [];
  const multiplicity = crossCheck.multiplicity ?? [];
  if (onlyAst.length > 0) {
    lines.push("  仅 AST 有（词法器盲区，必须逐条分类）：" + onlyAst.length + " 条");
    for (const declaration of onlyAst) {
      lines.push("    + " + declaration.file + ":" + declaration.line + " " + declaration.name
        + "（" + declaration.kind + "）");
    }
  }
  if (onlyLexer.length > 0) {
    lines.push("  仅词法器有（AST 无此节点，属误报，需修正）：" + onlyLexer.length + " 条");
    for (const declaration of onlyLexer) {
      lines.push("    - " + declaration.file + ":" + declaration.line + " " + declaration.name
        + "（" + declaration.kind + "）");
    }
  }
  if (multiplicity.length > 0) {
    lines.push("  同名出现次数不同：" + multiplicity.length + " 条");
    for (const entry of multiplicity) {
      lines.push("    ≠ " + entry.file + " " + entry.name
        + "（AST " + entry.ast + " 次 / 词法器 " + entry.lexer + " 次；分类位仍是同一行）");
    }
  }
  return lines;
}

/**
 * 源码里是否存在该名字的**工厂声明**（function / generator / 变量绑定 / 方法四种形态）。
 * 存在性校验专用：只回答"登记项在文件里还找不找得到"，不做模块级判定。
 *
 * 票据 44 起输入集合来自 **AST** 收集器（`collectFactoryDeclarations`），
 * 因此注释 / 字符串 / 模板文本里的同名写法天然不可能让登记通过。
 *
 * 票据 37：改为**复用 `collectFactoryDeclarations` 的结果**（同一套遮蔽串 + 同一套识别），
 * 不再对原始源码跑正则。旧实现有三个后果：
 * - 注释里的 `// function createGhost() {}` 能让同名过期登记通过，`stale-registration`
 *   永远报不出来——登记表可以悄悄指向已经不存在的实现；
 * - 字符串 / 模板文本里的同名写法同样能骗过校验；
 * - 识别规则与收集器各写一遍，两侧口径必然漂移（生成器形态就是漏的那一处）。
 *
 * @param {Set<string>} names 该文件已收集到的声明名集合（调用方按文件缓存一次，
 *   避免为每条登记重复遮蔽同一个文件）。
 * @param {string} name 待查的工厂名。
 */
function hasFactoryDeclaration(names, name) {
  return names.has(name);
}

/**
 * 纯函数：校验 C3 工厂清单（存在性 + 组数上限 [+ 例外表 + 对账]），不读文件系统。
 *
 * 与 C4 的 `assertPureFunctionLibraryExemptions` 同一取舍：条目结构非法（缺 file/name、
 * `groups` 不是非负整数、`reason` 是空白串、同一 {file, name} 重复登记）**直接抛错**——
 * 一条悄悄失效的登记等于 C3 少一个受检对象，而"少一个对象"永远只会表现为绿灯。
 *
 * ## 三层校验（票据 32 的存在性/组数上限 + 票据 34 的对账）
 * 1. **存在性**：登记条目必须真的出现在**AST 收集器的声明清单**里（`stale-registration`）。
 *    票据 37 起与 `collectFactoryDeclarations` 共用同一套识别，因此 function / generator /
 *    变量绑定三种形态同口径，注释 / 字符串 / 模板文本里的同名写法不再能让登记通过；
 * 2. **组数上限 + 明细**：`groups > limit` 且没有 `reason`（`factory-groups`）；
 *    `groups >= C3_FACES_REQUIRED_MIN` 的条目必须给出 `faces`
 *    （`{ name, capability }` 对象数组：长度等于 `groups`、name 非空且互不重复、
 *    capability 非空），否则报 `missing-faces`——**组数必须能被复核**，否则门禁只能说
 *    "数字没变"，不能说"数字是对的"；
 * 3. **对账**（`options.reconcile === true` 时）：源码声明 − (登记表 ∪ 例外表) 的差集逐条报
 *    `unclassified-factory`。为什么必须显式开关：`evaluateDependencyGraph` 的默认登记表是**空**的
 *    （夹具只注入自己想验的条目），若对账默认开启，任何夹具源码里的 `create*` 都会被误报。
 *    真实仓库由 `evaluateRepository` 显式开启。
 *
 * **例外表**（`options.exclusions`）：条目结构非法（缺 file/name、reason 空白、重复）或与登记表
 * 重叠 → **抛错**（同一 {file,name} 只能属于一侧，重叠即"两处记账互相掩护"）；条目指向的
 * `function <name>` 不存在 → `stale-exclusion`（例外表同样不许过期，否则它就成了垃圾抽屉）。
 *
 * @param {Array<{file: string, name: string, groups: number, reason?: string}>} registry 工厂清单。
 * @param {Array<{file, source}>|Map|Record} sources 参与统计的源码。
 * @param {{limit?: number, exclusions?: Array<{file: string, name: string, reason: string}>,
 *   reconcile?: boolean}} [options] 组数上限覆盖、例外表、是否做声明对账（测试用）。
 * @returns {Array<{rule: "C3", kind: string, file: string, line: number, name: string,
 *   groups?: number, limit?: number, message: string}>} 违规项。
 */
export function inspectFactoryRegistry(registry, sources, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : FACTORY_GROUP_LIMIT;
  const sourceByFile = new Map(normalizeSourceEntries(sources).map((entry) => [entry.file, entry.source]));
  // 声明索引（票据 44）：存在性校验与收集器共用**同一份** AST 结果——解析一次、同一套命名规则。
  // 按文件懒计算一次：208 条登记分布在约 120 个文件里，重复解析同一个文件没有意义。
  // 找不到源码时返回空集合（调用方已先判 `source === undefined` 报 stale-registration）。
  const declarationNamesByFile = new Map();
  const declarationNamesOf = (file) => {
    let names = declarationNamesByFile.get(file);
    if (names === undefined) {
      const text = sourceByFile.get(file);
      names = new Set(text === undefined
        ? []
        : collectFactoryDeclarations([{ file, source: text }]).map((declaration) => declaration.name));
      declarationNamesByFile.set(file, names);
    }
    return names;
  };
  const violations = [];
  const seen = new Set();
  (registry ?? []).forEach((entry, index) => {
    const file = normalizeModulePath(entry?.file ?? "");
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (file === "" || name === "") {
      throw new Error("C3 工厂登记缺少 file/name（第 " + (index + 1) + " 条）：" + JSON.stringify(entry));
    }
    if (!Number.isSafeInteger(entry.groups) || entry.groups < 0) {
      throw new Error("C3 工厂登记的 groups 必须是非负整数：" + JSON.stringify(entry));
    }
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || entry.reason.trim() === "")) {
      throw new Error("C3 工厂登记的 reason 必须是非空字符串：" + JSON.stringify(entry));
    }
    // faces 明细（票据 35 起是 { name, capability } 对象）：结构非法直接抛错（一条
    // "数不出来 / 说不清能力面"的组数等于 C3 少一个受检对象，与 groups 非法同一严格度；
    // 它只会表现为绿灯，所以必须在加载期就炸掉）。
    if (entry.faces !== undefined) {
      if (!Array.isArray(entry.faces)) {
        throw new Error("C3 工厂登记的 faces 必须是 { name, capability } 对象数组："
          + JSON.stringify(entry));
      }
      if (entry.faces.length !== entry.groups) {
        throw new Error("C3 工厂登记的 faces 长度必须等于 groups（" + entry.faces.length
          + " != " + entry.groups + "）：" + file + " " + name);
      }
      const faceNames = new Set();
      for (const face of entry.faces) {
        if (face === null || typeof face !== "object" || Array.isArray(face)) {
          throw new Error("C3 工厂登记的 faces 项必须是 { name, capability } 对象："
            + file + " " + name + "：" + JSON.stringify(face));
        }
        const faceName = typeof face.name === "string" ? face.name.trim() : "";
        const capability = typeof face.capability === "string" ? face.capability.trim() : "";
        if (faceName === "") {
          throw new Error("C3 工厂登记的 faces 的 name 不得为空白：" + file + " " + name);
        }
        if (capability === "") {
          throw new Error("C3 工厂登记的 faces 的 capability 不得为空白（组数必须能复核到能力面）："
            + file + " " + name + " 的 " + faceName);
        }
        if (faceNames.has(faceName)) {
          throw new Error("C3 工厂登记的 faces 的 name 不得重复（重复项等于少记一组）："
            + file + " " + name + " 的 " + faceName);
        }
        faceNames.add(faceName);
      }
    }
    const key = file + "\u0000" + name;
    if (seen.has(key)) throw new Error("C3 工厂登记重复：" + file + " " + name);
    seen.add(key);
    // 组数达到门槛却没有 faces：报违规而不是抛错——它不是"数据损坏"，而是"待补登记"，
    // 必须能被 fixtures/真实仓库同时观察到（票据 34：缺明细的 groups>=6 条目必须被报出）。
    if (entry.groups >= C3_FACES_REQUIRED_MIN && entry.faces === undefined) {
      violations.push({
        rule: "C3",
        kind: "missing-faces",
        file,
        line: 1,
        name,
        groups: entry.groups,
        message: "能力组 " + entry.groups + " ≥ " + C3_FACES_REQUIRED_MIN
          + "，但未登记 faces 明细（组数无法复核；请逐组列出能力面）",
      });
    }

    const source = sourceByFile.get(file);
    if (source === undefined) {
      violations.push({
        rule: "C3",
        kind: "stale-registration",
        file,
        line: 1,
        name,
        groups: entry.groups,
        message: "清单过期：登记文件 " + file + " 不在统计范围内（疑似改名/删除）",
      });
      return;
    }
    // 存在性（票据 44）：与收集器共用同一份「AST + 命名规则」——function / generator
    // （`function*` / `async function*`）/ 变量绑定（`const/let <name> =`）三种形态，
    // 且注释 / 字符串 / 模板文本里的同名写法不算声明。
    if (!hasFactoryDeclaration(declarationNamesOf(file), name)) {
      violations.push({
        rule: "C3",
        kind: "stale-registration",
        file,
        line: 1,
        name,
        groups: entry.groups,
        message: "清单过期：" + file + " 中找不到 function " + name + " 或 const/let " + name
          + " =（疑似改名/搬迁）",
      });
      return;
    }
    if (entry.groups <= limit) return;
    if (typeof entry.reason === "string" && entry.reason.trim() !== "") return;
    violations.push({
      rule: "C3",
      kind: "factory-groups",
      file,
      line: 1,
      name,
      groups: entry.groups,
      limit,
      message: "能力组 " + entry.groups + " > 上限 " + limit + "，且未登记 reason（组合根豁免或待收窄说明）",
    });
  });

  // ── 例外表：结构 + 存在性（与登记表同一严格度）─────────────────────────────
  const exclusionKeys = new Set();
  (options.exclusions ?? []).forEach((entry, index) => {
    const file = normalizeModulePath(entry?.file ?? "");
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (file === "" || name === "") {
      throw new Error("C3 例外登记缺少 file/name（第 " + (index + 1) + " 条）：" + JSON.stringify(entry));
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error("C3 例外登记必须写明 reason（为什么不构成工厂）：" + JSON.stringify(entry));
    }
    const key = file + "\u0000" + name;
    // 同一 {file,name} 同时出现在两侧 = 记账打架：既被当成工厂受组数约束、又被当成例外放行。
    // 只有一侧可以拥有它，因此这里直接抛错而不是报违规（结构问题，不是"待修"问题）。
    if (seen.has(key)) {
      throw new Error("C3 例外登记与工厂登记重叠：" + file + " " + name + "（只能归入一侧）");
    }
    if (exclusionKeys.has(key)) {
      throw new Error("C3 例外登记重复：" + file + " " + name);
    }
    exclusionKeys.add(key);

    const source = sourceByFile.get(file);
    // 例外表同样接受两种声明形态（票据 35）：`let createX = null` 这类运行期注入位
    // 也必须能被例外表引用，否则例外只能覆盖 function 形态。
    const exists = source !== undefined && hasFactoryDeclaration(declarationNamesOf(file), name);
    if (!exists) {
      violations.push({
        rule: "C3",
        kind: "stale-exclusion",
        file,
        line: 1,
        name,
        message: "例外表过期：" + (source === undefined
          ? "文件 " + file + " 不在统计范围内（疑似改名/删除）"
          : "找不到 function " + name + "（疑似改名/搬迁）"),
      });
    }
  });

  // ── 对账：源码声明 − (登记表 ∪ 例外表) ─────────────────────────────────────
  // 差集为空才说明「源码里没有从未受检的 create* 声明」。这一步就是票据 34 的核心：
  // 在此之前清单只验"登记项仍存在"，不验"源码声明是否全部入册"，55 个工厂因此长期漏检。
  if (options.reconcile === true) {
    for (const declaration of collectFactoryDeclarations(sources)) {
      const key = declaration.file + "\u0000" + declaration.name;
      if (seen.has(key) || exclusionKeys.has(key)) continue;
      violations.push({
        rule: "C3",
        kind: "unclassified-factory",
        file: declaration.file,
        line: declaration.line,
        name: declaration.name,
        message: "未分类的 create* 声明：" + declaration.name
          + "（必须登记进 C3_FACTORY_REGISTRY，或在 C3_NON_FACTORY_EXCLUSIONS 写明不是工厂的理由）",
      });
    }
  }

  return violations;
}

/** C4 豁免类别（报告与测试共用，避免散落字面量）。 */
export const EXPORT_EXEMPTION_KINDS = Object.freeze({
  entry: "entry",
  facade: "facade",
  pureFunctionLibrary: "pure-function-library",
});

/** C8 豁免：只有组合根可以「合法扇出」。 */
const LOCAL_IMPORT_EXEMPT_MODULES = Object.freeze(["index.js"]);

/**
 * 白名单：**只用于真实误报或已评审接受的既有问题**，每条必须写 `reason`。
 * 当前为空——实测 C1 无环、动态 import 全是字面量，没有任何需要豁免的既有问题。
 * 结构保留是为了让未来真出现误报时**有地方登记理由**，而不是放宽判据。
 */
export const DEPENDENCY_GRAPH_WHITELIST = Object.freeze({
  /** `{ files: string[], reason: string }`：整个环被接受（files 与环内文件集合等价）。 */
  cycles: Object.freeze([]),
  /** `{ file: string, line: number, reason: string }`：某条非字面量动态 import 被接受。 */
  dynamicImports: Object.freeze([]),
});

/** 客户端 IIFE 命名空间 Symbol 的固定前缀。 */
const IIFE_SYMBOL_PREFIX = "dsh-expert-group/";

/** 标识符起始/继续：门禁只处理 ASCII 标识符（源码里的键名都是 ASCII）。 */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*/;

/** 空白判定：只按 ASCII 空白处理（源码里的空白就是这些）。 */
function isWhitespaceCharacter(character) {
  return character === " " || character === "\t" || character === "\n"
    || character === "\r" || character === "\f" || character === "\v";
}

/** 在**原文**上跳过空白。遮蔽串里字符串会被抹成空格，所以定位字面量必须用原文。 */
function skipWhitespaceInSource(source, index) {
  let cursor = index;
  while (cursor < source.length && isWhitespaceCharacter(source[cursor])) cursor++;
  return cursor;
}

/** 在**遮蔽串**上跳过空白（用于结构判定，例如 `]` 之后是不是赋值）。 */
function skipWhitespaceInMasked(masked, index) {
  let cursor = index;
  while (cursor < masked.length && isWhitespaceCharacter(masked[cursor])) cursor++;
  return cursor;
}

/** 行首下标表：把字符下标换算成 1 起的行号（与 js-source-scan 同一口径）。 */
function buildLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/** 二分查行号。 */
function lineOf(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/**
 * 从原文 `index`（必须是引号）读一个字符串字面量。
 * 未闭合（遇到换行或文件尾）返回 null，避免吞掉后续代码。
 */
function readStringLiteralAt(source, index) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      value += source[cursor + 1] ?? "";
      cursor += 2;
      continue;
    }
    if (character === quote) return { value, end: cursor + 1 };
    if (character === "\n") return null;
    value += character;
    cursor++;
  }
  return null;
}

/** 把 `sources` 归一化成 `Array<{file, source}>`（Map / 普通对象 / 数组都接受）。 */
function normalizeSourceEntries(sources) {
  if (sources === null || sources === undefined) return [];
  if (Array.isArray(sources)) {
    return sources.map((entry) => ({
      file: normalizeModulePath(entry.file),
      source: String(entry.source ?? ""),
    }));
  }
  const entries = sources instanceof Map ? [...sources.entries()] : Object.entries(sources);
  return entries.map(([file, source]) => ({ file: normalizeModulePath(file), source: String(source ?? "") }));
}

/** 是否相对 specifier（`./`、`../`）；裸 specifier 与绝对路径都不参与本地图。 */
function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/**
 * 把相对 specifier 归一化成仓库内路径（用 `/` 分隔）。
 * 只做**字符串归一化**，不读文件系统；是否存在于统计范围由 `collectEsmGraph` 判定。
 */
function resolveRelativeSpecifier(fromFile, specifier) {
  if (!isRelativeSpecifier(specifier)) return null;
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier));
}

/** 在遮蔽串上从 `fromIndex` 起找完整关键字（`\bfrom\b`），找不到返回 null。 */
function findKeywordAfter(masked, keyword, fromIndex) {
  const pattern = new RegExp("\\b" + keyword + "\\b", "g");
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(masked);
  return match ? match.index : null;
}

/**
 * 数 `export { ... }` 里的导出名个数。
 * `a` / `a as b` / `default as c` 各算 1；空大括号（语法非法）由调用方兜底为 1。
 */
function countExportedNames(inner) {
  return inner
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .length;
}

/**
 * 纯函数：解析单个源码文件的 ESM 关系（**词法器实现**；票据 45 起降级为交叉校验对照侧）。
 *
 * 返回 `{ imports, dynamicImports, exportCount }`，不读文件系统、不依赖全局状态。
 * 判据是 `parseEsmRelations`（AST）；本函数只回答"旧实现看见了什么"，用于差异报告。
 *
 * - `imports`：静态 import 与 re-export，含 `kind`（`import` / `re-export`）与行号；
 *   **specifier 未解析**（`resolved` / `internal` 由 collectEsmGraph 补）。
 * - `dynamicImports`：`{ line, specifier, raw }`，非字面量的 `specifier` 为 null、
 *   `raw` 为表达式片段（供报告定位）。
 * - `exportCount`：导出声明数（口径见文件头 C4）。
 */
export function parseEsmRelationsLexer(source) {
  const text = String(source ?? "");
  const masked = maskJavaScriptSource(text);
  const lineStarts = buildLineStarts(text);
  const imports = [];
  const dynamicImports = [];
  let exportCount = 0;

  // ── 1. import 关键字：静态 import / 动态 import() / import.meta ─────────────
  const importPattern = /\bimport\b/g;
  let match;
  while ((match = importPattern.exec(masked)) !== null) {
    const previous = match.index > 0 ? text[match.index - 1] : "";
    if (previous === "." || /[A-Za-z0-9_$]/.test(previous)) continue;
    const afterKeyword = skipWhitespaceInSource(text, match.index + "import".length);
    const nextCharacter = text[afterKeyword];
    if (nextCharacter === ".") continue; // import.meta
    if (nextCharacter === "(") {
      const argumentStart = skipWhitespaceInSource(text, afterKeyword + 1);
      const literal = readStringLiteralAt(text, argumentStart);
      dynamicImports.push({
        line: lineOf(lineStarts, match.index),
        specifier: literal ? literal.value : null,
        raw: literal ? null : text.slice(argumentStart, Math.min(text.length, argumentStart + 60)).split("\n")[0],
      });
      continue;
    }
    // 副作用 import：import "./x.js"
    const directLiteral = readStringLiteralAt(text, afterKeyword);
    if (directLiteral) {
      imports.push({ specifier: directLiteral.value, line: lineOf(lineStarts, match.index), kind: "import" });
      continue;
    }
    // 常规 import ... from "./x.js"（可跨行）
    const fromIndex = findKeywordAfter(masked, "from", match.index + "import".length);
    if (fromIndex === null) continue;
    const literal = readStringLiteralAt(text, skipWhitespaceInSource(text, fromIndex + "from".length));
    if (literal) imports.push({ specifier: literal.value, line: lineOf(lineStarts, match.index), kind: "import" });
  }

  // ── 2. export 关键字：数导出声明 + 收集 re-export 依赖边 ────────────────────
  const exportPattern = /\bexport\b/g;
  while ((match = exportPattern.exec(masked)) !== null) {
    const previous = match.index > 0 ? text[match.index - 1] : "";
    if (previous === "." || /[A-Za-z0-9_$]/.test(previous)) continue;
    const afterKeyword = skipWhitespaceInSource(text, match.index + "export".length);
    const nextCharacter = text[afterKeyword];
    if (nextCharacter === "{") {
      // export { a, b } / export { a, b } from "./x.js"
      const closeIndex = masked.indexOf("}", afterKeyword);
      const inner = closeIndex < 0 ? "" : masked.slice(afterKeyword + 1, closeIndex);
      exportCount += Math.max(1, countExportedNames(inner));
    } else if (nextCharacter === "*") {
      // export * from "./x.js" / export * as ns from "./x.js"：名字无法静态展开，按 1 计
      exportCount += 1;
    } else {
      // export const / function / default / class ...：一条声明计 1
      exportCount += 1;
    }
    if (nextCharacter !== "{" && nextCharacter !== "*") continue;
    const fromIndex = findKeywordAfter(masked, "from", afterKeyword + 1);
    if (fromIndex === null) continue;
    const literal = readStringLiteralAt(text, skipWhitespaceInSource(text, fromIndex + "from".length));
    if (literal) imports.push({ specifier: literal.value, line: lineOf(lineStarts, match.index), kind: "re-export" });
  }

  return { imports, dynamicImports, exportCount };
}


/**
 * 纯函数：数一个模块的**导出名个数**（C4 的口径；输入是 `collectModuleSpecifiers` 的记录）。
 *
 * 口径（票据 45 明确化，逐条对应 AST 形态）：
 * - `export { a, b }` / `export { a, b } from "./x"` → 按**名字个数**计（2）；
 * - `export const A = 1, B = 2` → 按**声明名个数**计（2）。旧词法器只数 `export` 关键字
 *   （计 1），这是它的漏数点：C4 约束的是"对外接口宽度"，两个导出名就是两个接口面；
 * - `export function f()` / `export class C` / `export default …` → 各计 1；
 * - `export * from` / `export * as ns from` → 名字无法静态展开，按 1 计（与旧口径一致）；
 * - 空 `export {}`（语法合法但不导出任何名字）→ 下限 1，保持与旧口径同一条"每语句至少 1"的
 *   保守下界（宁可多数、不可漏数）。
 *
 * @param {Array<object>} records `collectModuleSpecifiers` 的返回值。
 * @returns {number} 导出名个数。
 */
function countModuleExports(records) {
  let count = 0;
  for (const record of records) {
    if (record.type === "export-named") {
      count += Math.max(1, record.specifiers.length);
    } else if (record.type === "export-local") {
      count += Math.max(1, record.exported.length);
    } else if (record.type === "export-all" || record.type === "export-default") {
      count += 1;
    }
  }
  return count;
}

/**
 * 纯函数：解析单个源码文件的 ESM 关系（**AST 判据**；票据 45）。
 *
 * 与词法器实现的关系：`parseEsmRelationsLexer` 保留为对照侧（`crossCheck`），用于打印
 * "两个实现看见的依赖事实是否相同"。判据是这一份。
 *
 * 为什么换 AST：词法器要用"找 from 关键字 + 读字符串字面量"的近似，多行 import、
 * `import{ a as b }`（无空格）、注释夹在说明符之间等写法都靠运气；AST 直接给
 * `ImportDeclaration` / `ExportNamedDeclaration` / `ExportAllDeclaration` 的结构，
 * 来源与名字都是字段，不再有"取错字面量"的可能。
 *
 * @param {string} source 源码。
 * @param {string} [file] 文件名（仅用于解析失败时的定位）。
 * @returns {{imports: Array<{specifier: string, line: number, kind: string}>,
 *   dynamicImports: Array<{line: number, specifier: string|null, raw: string|null}>,
 *   exportCount: number}}
 */
export function parseEsmRelations(source, file) {
  const text = typeof source === "string" ? source : String(source ?? "");
  const label = file === undefined || file === null || file === "" ? "<anonymous>" : String(file);
  const ast = parseSource(text, label);
  const records = collectModuleSpecifiers(ast);
  const imports = [];
  for (const record of records) {
    // 静态 import 与两种再导出（带来源）都构成依赖边；本地导出没有来源，不入图。
    if (record.type === "import") {
      imports.push({ specifier: record.source, line: record.line, kind: "import" });
    } else if (record.type === "export-named" || record.type === "export-all") {
      imports.push({ specifier: record.source, line: record.line, kind: "re-export" });
    }
  }
  // 按行号排序：AST 遍历顺序就是源码顺序，但 import 与 re-export 混排时仍显式钉死，
  // 让 `modules.imports` 的输出与文件阅读顺序一致（C2 报违规时按这条顺序扫描）。
  imports.sort((left, right) => left.line - right.line
    || (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0));
  const dynamicImports = collectDynamicImports(ast, { source: text });
  return { imports, dynamicImports, exportCount: countModuleExports(records) };
}
/** 边的稳定排序：from → to → 行号 → kind（保证同一输入的输出可复现）。 */
function compareEdges(left, right) {
  if (left.from !== right.from) return left.from < right.from ? -1 : 1;
  if (left.to !== right.to) return left.to < right.to ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
  return left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0;
}

/**
 * 找一条顶层语句的结束位置（含结尾 `;`，或按 ASI 在行尾收尾）。
 * 只按花括号 / 圆括号 / 方括号深度配对；字符串、注释、模板串已被遮蔽成空格，不会误判。
 */
function findStatementEnd(masked, from) {
  let depth = 0;
  for (let index = from; index < masked.length; index++) {
    const character = masked[index];
    if (character === "{" || character === "(" || character === "[") {
      depth++;
      continue;
    }
    if (character === "}" || character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) continue;
    if (character === ";") return index + 1;
    // 无分号写法（ASI）在行尾收尾。跨行续写的语句（`import x from\n"pkg"`）会被提前切断，
    // 结果只会是「少判一次 facade / 少识别一条导出」，属于 fail-closed，不会造成误放行。
    if (character === "\n") return index + 1;
  }
  return masked.length;
}

/**
 * 列出遮蔽串上的顶层语句：`{ keyword, start, end }`，按出现顺序。
 * 只用于「是否门面」「纯函数库机械校验」两处，不追求完整 AST。
 */
function listTopLevelStatements(masked) {
  const statements = [];
  let cursor = 0;
  while (cursor < masked.length) {
    cursor = skipWhitespaceInMasked(masked, cursor);
    if (cursor >= masked.length) break;
    if (masked[cursor] === ";") {
      cursor++;
      continue;
    }
    const identifier = IDENTIFIER_PATTERN.exec(masked.slice(cursor));
    if (!identifier) {
      cursor++;
      continue;
    }
    const end = findStatementEnd(masked, cursor);
    statements.push({ keyword: identifier[0], start: cursor, end });
    cursor = end;
  }
  return statements;
}

/** 按顶层逗号切分一个声明范围（用于 `export const A = 1, B = 2`）。 */
function splitTopLevelRanges(masked, start, end) {
  const ranges = [];
  let depth = 0;
  let rangeStart = start;
  for (let index = start; index < end; index++) {
    const character = masked[index];
    if (character === "{" || character === "(" || character === "[") depth++;
    else if (character === "}" || character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      ranges.push({ start: rangeStart, end: index });
      rangeStart = index + 1;
    }
  }
  if (rangeStart < end) ranges.push({ start: rangeStart, end });
  return ranges;
}

/** 在范围里找第一个顶层 `=`（区分 `=>`、`==`、`>=` 等），找不到返回 -1。 */
function findTopLevelEquals(masked, start, end) {
  let depth = 0;
  for (let index = start; index < end; index++) {
    const character = masked[index];
    if (character === "{" || character === "(" || character === "[") depth++;
    else if (character === "}" || character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "=" && depth === 0) {
      if (masked[index + 1] === "=" || masked[index + 1] === ">" || masked[index - 1] === "=") continue;
      return index;
    }
  }
  return -1;
}

/** 顶层裸副作用语句判定时必须排除的关键字（声明 / 控制流 / 运算符）。 */
const NON_BARE_STATEMENT_KEYWORDS = new Set([
  "import", "export", "const", "let", "var", "function", "class", "async",
  "if", "for", "while", "do", "switch", "try", "catch", "finally", "return",
  "throw", "break", "continue", "debugger", "with", "new", "delete", "void",
  "typeof", "yield", "await",
]);

/** 顶层裸副作用语句白名单：这两类是把「无副作用调用」包装成语句的惯用写法。 */
const BARE_STATEMENT_ALLOWED_PREFIXES = Object.freeze(["Object.freeze(", "Object.defineProperty("]);

/** 可能承载可变状态的容器构造器（导出面出现且被修改才判否）。 */
const MUTABLE_CONTAINER_CONSTRUCTORS = Object.freeze(["Map", "Set", "WeakMap", "WeakSet"]);

/** 初始化表达式是否是可变容器（`new Map(...)` 等）；是则返回容器名。 */
function matchMutableContainer(initializerMasked) {
  const match = /^\s*new\s+(Map|Set|WeakMap|WeakSet)\s*\(/.exec(initializerMasked);
  return match ? match[1] : null;
}

/** 初始化表达式是否是 class 实例（`new SomeClass(...)`）；是则返回构造器名。 */
function matchClassInstance(initializerMasked) {
  const match = /^\s*new\s+([A-Za-z_$][\w$]*)\s*\(/.exec(initializerMasked);
  if (!match) return null;
  if (MUTABLE_CONTAINER_CONSTRUCTORS.includes(match[1])) return null;
  return match[1];
}

/**
 * 解析一个声明语句（`const` / `let` / `var`，含 `export` 前缀）的 declarator 列表。
 * @param {string} masked 遮蔽串
 * @param {string} text 原文（尾随空白/分号必须用原文判断，见下）
 * @param {number} keywordStart 声明关键字在遮蔽串上的下标
 * @param {number} statementEnd 语句结束下标（含结尾 `;`）
 * @returns {Array<{name: string, initializerMasked: string, initializerRaw: string}>}
 */
function parseDeclarators(masked, text, keywordStart, statementEnd) {
  const keywordMatch = /^(?:const|let|var)\b/.exec(masked.slice(keywordStart));
  if (!keywordMatch) return [];
  const declaratorsStart = skipWhitespaceInMasked(masked, keywordStart + keywordMatch[0].length);
  // 语句尾的分号不属于初始化表达式。必须用**原文**判断尾随空白——遮蔽串里字符串字面量
  // 也是一串空格，用它剥尾会把 `C = 'x'` 的初始化剥成空串。
  let declarationEnd = statementEnd;
  while (declarationEnd > declaratorsStart && /[\s;]/.test(text[declarationEnd - 1])) declarationEnd--;
  const declarators = [];
  for (const range of splitTopLevelRanges(masked, declaratorsStart, declarationEnd)) {
    const equals = findTopLevelEquals(masked, range.start, range.end);
    const name = masked.slice(range.start, equals < 0 ? range.end : equals).trim().split(/\s/)[0];
    if (!name) continue;
    declarators.push({
      name,
      initializerMasked: equals < 0 ? "" : masked.slice(equals + 1, range.end),
      initializerRaw: equals < 0 ? "" : text.slice(equals + 1, range.end),
    });
  }
  return declarators;
}

/** 顶层语句里深度 0 的定时器调用（`setTimeout(` / `setInterval(`）；箭头表达式体内不算模块级定时器。 */
function findModuleLevelTimer(segment) {
  let depth = 0;
  let sawArrowAtDepthZero = false;
  for (let index = 0; index < segment.length; index++) {
    const character = segment[index];
    if (character === "{" || character === "(" || character === "[") {
      depth++;
      continue;
    }
    if (character === "}" || character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (character === "=" && segment[index + 1] === ">" && depth === 0) {
      sawArrowAtDepthZero = true;
      continue;
    }
    if (depth !== 0 || sawArrowAtDepthZero || !/[A-Za-z_$]/.test(character)) continue;
    if (index > 0 && /[A-Za-z0-9_$]/.test(segment[index - 1])) continue;
    const identifier = IDENTIFIER_PATTERN.exec(segment.slice(index));
    if (!identifier) continue;
    const word = identifier[0];
    if (word === "setTimeout" || word === "setInterval") {
      const after = skipWhitespaceInMasked(segment, index + word.length);
      if (segment[after] === "(") return word;
    }
    index += word.length - 1;
  }
  return null;
}

/**
 * 识别「顶层裸副作用语句」：缩进 0、以标识符 / 成员表达式开头、以调用结束的**语句**。
 * `const x = fn()` 是声明（关键字 const），`if (...) {...}` 是控制流，都不算；
 * `Object.freeze(...)` / `Object.defineProperty(...)` 是白名单。
 */
function detectBareSideEffectStatement(statementText, keyword) {
  if (NON_BARE_STATEMENT_KEYWORDS.has(keyword)) return null;
  const trimmed = statementText.trim().replace(/;$/, "").trim();
  if (trimmed === "" || !trimmed.endsWith(")")) return null;
  if (!/^[A-Za-z_$][\w$]*(?:\s*(?:\?\.)?\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/.test(trimmed)) return null;
  if (BARE_STATEMENT_ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return null;
  return trimmed.split("\n")[0].slice(0, 60);
}

/**
 * 把一个模块级声明转成 C5 台账用的「内部状态」条目（不判否，只登记）：
 * 内部 Map/Set/WeakMap/WeakSet、class 实例、模块级 let/var。
 */
function describeModuleState(declarator, keyword, exported) {
  const container = matchMutableContainer(declarator.initializerMasked);
  if (container) return (exported ? "导出 " : "内部 ") + container + ": " + declarator.name;
  const instance = matchClassInstance(declarator.initializerMasked);
  if (instance) return (exported ? "导出" : "内部") + " class 实例: " + declarator.name + " (" + instance + ")";
  if (!exported && (keyword === "let" || keyword === "var")) {
    return "模块级 " + keyword + ": " + declarator.name;
  }
  return null;
}

/**
 * 机械校验「凝聚纯函数库」豁免资格（C4 的**导出面**判据；内部状态归 C5 台账）。
 *
 * ## 为什么只查导出面、不查内部状态
 * C4 的语义是「内部模块导出数 ≤12」，约束的是**模块对外接口的宽度**；未导出的内部缓存、
 * WeakSet 簿记、class 实例属于**状态所有权**问题，判据是 C5（owner 台账 + 写点扫描）。
 * 如果 C4 因为「模块里有一个只读查找表」就否决豁免，真实候选（例如 `host/rpc-transport.js`
 * 的两个 WeakSet 簿记、`host/expert-group-snapshot.js` 的一组只读状态表）会被误伤，而它们
 * 恰恰是单一关注点的领域库。因此这里把内部状态如实列进 `internalState` 交给 C5，不据此判否。
 *
 * ## 拒绝项（规则 1/2/3/4/5）
 * 1. `export let` / `export var`：导出可变绑定，调用方看到的值随时会变；
 * 2. 模块级定时器（顶层语句里深度 0 的 `setTimeout(` / `setInterval(`）；
 * 3. 顶层裸副作用语句（缩进 0、标识符/成员表达式开头、以调用结束），白名单
 *    `Object.freeze(...)` / `Object.defineProperty(...)`；`const x = fn()` 是声明，不算；
 * 4. 导出面必须是 `function` / `class` / `const` 声明——`export { ... }` / `export * from`
 *    属于兼容门面形态，走门面机械豁免，不在本类别里判；
 * 5. 导出常量不得是可变容器：初始化是 `new Map/Set/WeakMap/WeakSet` 且**在初始化之后**被
 *    `.set(` / `.add(` / `.delete(` / `.clear(` 修改 → 判否；只读查找表放行。
 *
 * @returns {{ok: boolean, problems: string[], internalState: string[]}}
 *   `problems` 只放上述 1–5 的违规；`internalState` 是给 C5 台账的状态清单。
 */
export function inspectPureFunctionLibrary(source) {
  const text = String(source ?? "");
  const masked = maskJavaScriptSource(text);
  const statements = listTopLevelStatements(masked);
  const problems = [];
  const internalState = new Set();
  const remember = (entry) => {
    if (entry) internalState.add(entry);
  };

  for (const statement of statements) {
    const statementText = masked.slice(statement.start, statement.end);

    // 规则 2：模块级定时器。
    const timer = findModuleLevelTimer(statementText);
    if (timer) problems.push("存在模块级定时器：" + timer + "(");

    // 规则 3：顶层裸副作用语句。
    const bareStatement = detectBareSideEffectStatement(statementText, statement.keyword);
    if (bareStatement) problems.push("存在顶层裸副作用语句：" + bareStatement);

    // 规则 6：内部状态只登记、不判否（未导出的声明）。
    if (statement.keyword === "const" || statement.keyword === "let" || statement.keyword === "var") {
      for (const declarator of parseDeclarators(masked, text, statement.start, statement.end)) {
        remember(describeModuleState(declarator, statement.keyword, false));
      }
    }
  }

  // 规则 1/4/5：导出面。
  for (const statement of statements) {
    if (statement.keyword !== "export") continue;
    const afterExport = skipWhitespaceInMasked(masked, statement.start + "export".length);
    const rest = masked.slice(afterExport, statement.end);

    if (/^function\b/.test(rest) || /^async\s+function\b/.test(rest) || /^class\b/.test(rest)) continue;

    if (/^const\b/.test(rest)) {
      for (const declarator of parseDeclarators(masked, text, afterExport, statement.end)) {
        const container = matchMutableContainer(declarator.initializerMasked);
        if (container) {
          // 规则 5：导出容器在初始化之后被修改 → 导出可变状态。
          const mutationPattern = new RegExp(
            "\\b" + declarator.name + "\\s*(?:\\?\\.)?\\.\\s*(?:set|add|delete|clear)\\s*\\(",
          );
          if (mutationPattern.test(masked.slice(statement.end))) {
            problems.push("导出可变状态：" + declarator.name
              + "（初始化是 new " + container + "()，且在初始化之后被 set/add/delete/clear 修改）");
          } else {
            remember("导出只读 " + container + ": " + declarator.name + "（本文件内未修改）");
          }
          continue;
        }
        const instance = matchClassInstance(declarator.initializerMasked);
        if (instance) remember("导出 class 实例: " + declarator.name + " (" + instance + ")");
      }
      continue;
    }

    if (/^default\b/.test(rest)) {
      const defaultRest = masked.slice(
        skipWhitespaceInMasked(masked, afterExport + "default".length),
        statement.end,
      );
      if (/^(?:async\s+)?function\b/.test(defaultRest) || /^class\b/.test(defaultRest)) continue;
      problems.push("存在 default 导出（不是函数 / 类声明）");
      continue;
    }

    if (/^(?:let|var)\b/.test(rest)) {
      problems.push("存在导出可变绑定（export " + rest.split(/\s/)[0] + "）");
      continue;
    }

    if (/^\{/.test(rest) || /^\*/.test(rest)) {
      problems.push("存在导出列表 / re-export（export " + rest.trim().slice(0, 20)
        + "），不属于凝聚纯函数库豁免类别（门面走兼容门面机械豁免）");
      continue;
    }

    problems.push("无法识别的 export 形态：" + rest.slice(0, 24));
  }

  return { ok: problems.length === 0, problems, internalState: [...internalState] };
}

/**
 * 机械判定「兼容门面」：遮蔽后只有 `import` 语句与 `export ... from` 再导出（以及 `export { ... }`
 * 这种本地导出列表），没有任何实现体（函数 / 类 / 变量声明 / 其它语句）。
 *
 * 这是 C4 第 2 类豁免的前置条件；`shared.js` 当前仍是真实实现，所以返回 false（门禁照实报出），
 * R1 把它改成纯 re-export 门面后自动返回 true。
 */
export function isReExportFacade(source) {
  const text = String(source ?? "");
  const masked = maskJavaScriptSource(text);
  let cursor = 0;
  let sawStatement = false;
  while (cursor < masked.length) {
    cursor = skipWhitespaceInMasked(masked, cursor);
    if (cursor >= masked.length) break;
    if (masked[cursor] === ";") {
      cursor++;
      continue;
    }
    const identifier = IDENTIFIER_PATTERN.exec(masked.slice(cursor));
    if (!identifier) return false;
    const keyword = identifier[0];
    if (keyword !== "import" && keyword !== "export") return false;
    const afterKeyword = skipWhitespaceInMasked(masked, cursor + keyword.length);
    if (keyword === "import" && (masked[afterKeyword] === "(" || masked[afterKeyword] === ".")) return false;
    if (keyword === "export" && masked[afterKeyword] !== "{" && masked[afterKeyword] !== "*") return false;
    sawStatement = true;
    cursor = findStatementEnd(masked, cursor);
  }
  return sawStatement;
}

/**
 * 读 `package.json` 的 `exports["."]` 目标，作为 C4「组合根」豁免的机械判据。
 * 缺失时回退到 `main`，再回退到 `index.js`（夹具可以不带 package.json）。
 */
export async function readEntryModule(root) {
  try {
    const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    let target = null;
    const exportsField = packageJson.exports;
    if (typeof exportsField === "string") {
      target = exportsField;
    } else if (exportsField !== null && typeof exportsField === "object") {
      const rootExport = exportsField["."];
      if (typeof rootExport === "string") target = rootExport;
      else if (rootExport !== null && typeof rootExport === "object") {
        target = rootExport.default ?? rootExport.import ?? null;
      }
    }
    if (!target && typeof packageJson.main === "string") target = packageJson.main;
    if (typeof target === "string" && target.length > 0) return normalizeModulePath(target);
  } catch {
    // 夹具没有 package.json 时按默认入口处理。
  }
  return ENTRY_MODULE;
}

/**
 * 纯函数：由源码集合构建 ESM 依赖图。不读文件系统。
 *
 * @param {Array<{file: string, source: string}>|Map<string,string>|Record<string,string>} sources
 * @returns {{
 *   files: string[],
 *   modules: Map<string, {file: string, exportCount: number, imports: Array<object>, localImports: number, dynamicImports: Array<object>}>,
 *   edges: Array<{from: string, to: string, kind: string, specifier: string, line: number, via: string}>,
 *   unresolved: Array<{file: string, specifier: string, line: number}>,
 * }}
 *
 * `edges` 只保留**指向统计范围内文件**的边（外部包与范围外路径不入图，否则 C1 会被
 * `node:fs` 这类内建模块干扰）。`unresolved` 收集「相对 import 但落在范围内不存在」的条目，
 * 供报告提示（不作为违规：扩展名省略等写法在本仓库不出现，但门禁不应因此误报）。
 */
export function collectEsmGraph(sources, options = {}) {
  // 票据 45：关系解析器可注入——AST 是判据，词法器是同一份输入的对照侧。
  const parseRelations = options.parseRelations ?? parseEsmRelations;
  const entries = normalizeSourceEntries(sources)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  const fileSet = new Set(entries.map((entry) => entry.file));
  const files = [...fileSet].sort();
  const modules = new Map();
  const edges = [];
  const unresolved = [];

  for (const { file, source } of entries) {
    if (modules.has(file)) continue;
    // 票据 45：AST 判据；文件名只用于解析失败时的定位（fail-closed 带行列）。
    const { imports, dynamicImports, exportCount } = parseRelations(source, file);
    const resolvedImports = imports.map((entry) => {
      const resolved = resolveRelativeSpecifier(file, entry.specifier);
      return {
        specifier: entry.specifier,
        line: entry.line,
        kind: entry.kind,
        resolved,
        internal: resolved !== null && fileSet.has(resolved),
      };
    });
    const localImports = resolvedImports.filter((entry) => isRelativeSpecifier(entry.specifier)).length;
    for (const importEntry of resolvedImports) {
      if (importEntry.resolved === null) continue;
      if (fileSet.has(importEntry.resolved)) {
        edges.push({
          from: importEntry.resolved,
          to: file,
          kind: importEntry.kind,
          specifier: importEntry.specifier,
          line: importEntry.line,
          via: importEntry.kind === "re-export" ? "esm-re-export" : "esm-import",
        });
      } else {
        unresolved.push({ file, specifier: importEntry.specifier, line: importEntry.line });
      }
    }
    // 字面量动态 import 也是真实依赖：入图参与 C1（非字面量无法解析成边，单独由 C1 报出）。
    for (const dynamicEntry of dynamicImports) {
      if (dynamicEntry.specifier === null) continue;
      const resolved = resolveRelativeSpecifier(file, dynamicEntry.specifier);
      if (resolved === null || !fileSet.has(resolved)) continue;
      edges.push({
        from: resolved,
        to: file,
        kind: "dynamic-import",
        specifier: dynamicEntry.specifier,
        line: dynamicEntry.line,
        via: "esm-dynamic-import",
      });
    }
    modules.set(file, { file, exportCount, imports: resolvedImports, localImports, dynamicImports });
  }

  edges.sort(compareEdges);
  return { files, modules, edges, unresolved };
}

/** Symbol 记录的排序：file → line → symbol。 */
function compareSymbolRecords(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
}

/**
 * 扫描单个 IIFE 文件里对 `dsh-expert-group/*` Symbol 的读写（**词法器实现**；
 * 票据 45 起降级为交叉校验对照侧，判据是下面的 AST 版本）。
 * 返回 `{ provides, requires, unresolved }`。
 *
 * **票据 38：动态键 fail-closed**。此前解析不出的键会被静默忽略——那条依赖边就此消失，
 * 而「少一条边」永远以格式正确的绿灯出现（环检测也就少了一条可能成环的路径）。
 * 现在改为**显式记录**到 `unresolved`，由 `evaluateDependencyGraph` 报成违规
 * （kind: `unresolved-iife-symbol`）；只有「解析出来但不是本插件命名空间」的键才按无关忽略。
 *
 * 判定规则：
 * - **provides**：`globalThis[X] = ...` / `global[X] = ...`（赋值，排除 `==` / `=>`）；
 * - **requires**：其余 `globalThis[X]` / `global[X]` 取值；
 * - `X` 可以是 `Symbol.for("dsh-expert-group/...")`、`Symbol.for(同文件常量)`、或同文件内
 *   `const NAME = Symbol.for("...")` / `const NAME = "dsh-expert-group/..."` 绑定的常量名。
 */
function scanIifeGlobalUsageLexer(file, source) {
  const text = String(source ?? "");
  const masked = maskJavaScriptSource(text, { file });
  const lineStarts = buildLineStarts(text);
  const symbolBindings = new Map();

  // 1) const NAME = Symbol.for("dsh-expert-group/...")
  const symbolBindingPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Symbol\s*\.\s*for\s*\(/g;
  let match;
  while ((match = symbolBindingPattern.exec(masked)) !== null) {
    const argumentStart = skipWhitespaceInSource(text, match.index + match[0].length);
    const literal = readStringLiteralAt(text, argumentStart);
    if (literal) symbolBindings.set(match[1], literal.value);
  }

  // 2) const NAME = "dsh-expert-group/..."（字符串常量别名，供 Symbol.for(NAME) 使用）
  const stringBindingPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((match = stringBindingPattern.exec(masked)) !== null) {
    const equalsIndex = match.index + match[0].length - 1;
    const literal = readStringLiteralAt(text, skipWhitespaceInSource(text, equalsIndex + 1));
    if (literal && literal.value.startsWith(IIFE_SYMBOL_PREFIX)) symbolBindings.set(match[1], literal.value);
  }

  /** 解析 `globalThis[X]` 里 X 指向的 Symbol 字符串；解析不出返回 null。 */
  const resolveSymbolAt = (position) => {
    if (text.startsWith("Symbol", position)) {
      const forIndex = text.indexOf("for", position + "Symbol".length);
      if (forIndex < 0) return null;
      const parenIndex = text.indexOf("(", forIndex);
      if (parenIndex < 0) return null;
      const argumentStart = skipWhitespaceInSource(text, parenIndex + 1);
      const literal = readStringLiteralAt(text, argumentStart);
      if (literal) return literal.value;
      const identifier = IDENTIFIER_PATTERN.exec(text.slice(argumentStart));
      return identifier ? (symbolBindings.get(identifier[0]) ?? null) : null;
    }
    const identifier = IDENTIFIER_PATTERN.exec(text.slice(position));
    return identifier ? (symbolBindings.get(identifier[0]) ?? null) : null;
  };

  const provides = [];
  const requires = [];
  const unresolved = [];
  const accessPattern = /\b(?:globalThis|global)\s*\[/g;
  while ((match = accessPattern.exec(masked)) !== null) {
    const valueStart = skipWhitespaceInSource(text, match.index + match[0].length);
    const symbol = resolveSymbolAt(valueStart);
    const closeIndex = masked.indexOf("]", match.index + match[0].length);
    if (symbol === null) {
      // 票据 38：动态键不再静默忽略。原文片段只截到配对的 `]`，够人复核即可。
      const rawEnd = closeIndex < 0 ? Math.min(match.index + 80, text.length) : closeIndex + 1;
      unresolved.push({
        file,
        line: lineOf(lineStarts, match.index),
        raw: text.slice(match.index, rawEnd).replace(/\s+/g, " ").trim(),
      });
      continue;
    }
    // 解析成功但不在本插件命名空间：与 IIFE 依赖无关，按原语义忽略（不是违规）。
    if (!symbol.startsWith(IIFE_SYMBOL_PREFIX)) continue;
    if (closeIndex < 0) continue;
    const afterBracket = skipWhitespaceInMasked(masked, closeIndex + 1);
    // 赋值写作 `global[X] =`；`==` / `=>` 是读取或箭头，不算 provides
    const isAssignment = masked[afterBracket] === "="
      && masked[afterBracket + 1] !== "=" && masked[afterBracket + 1] !== ">";
    const record = { file, symbol, line: lineOf(lineStarts, match.index) };
    if (isAssignment) provides.push(record);
    else requires.push(record);
  }
  return { provides, requires, unresolved };
}

/**
 * 扫描单个 IIFE 文件里对 `dsh-expert-group/*` Symbol 的读写（**AST 判据**；票据 45）。
 *
 * 与词法器版本的关系：判定规则逐条保持（见下），输入换成 AST 结构 + `collectSymbolForCalls`
 * 的"字面量键"事实，词法器实现降级为对照侧（`scanIifeGlobalUsageLexer`）。
 * 为什么换：词法器用正则找 `globalThis[` / `global[`，再用"向前读标识符/字符串"解析键——
 * 一旦键写成换行、注释夹在中间或 `Symbol . for` 这类等价写法，就只能靠补边界；
 * AST 直接给出 `MemberExpression.computed` 与 `CallExpression.callee` 结构，键表达式是节点，
 * 读写点是 `AssignmentExpression.left` 的指针相等判定，不再有"看错字符位置"的空间。
 *
 * 判定规则（与词法器逐条对齐）：
 * - **provides**：`globalThis[X] = …` / `global[X] = …`（`AssignmentExpression`，operator 为 `=`）；
 * - **requires**：其余 `globalThis[X]` / `global[X]` 取值（含 `==` / `=>` 语境，它们不是赋值）；
 * - `X` 可以是 `Symbol.for("dsh-expert-group/…")`（经 `collectSymbolForCalls` 的字面量键）、
 *   `Symbol.for(同文件字符串常量)`、或同文件内 `const NAME = Symbol.for("…")` /
 *   `const NAME = "dsh-expert-group/…"` 绑定的常量名；
 * - **fail-closed**：解析不出的键记入 `unresolved`（`{ file, line, raw }`），由 C1 报
 *   `unresolved-iife-symbol`——"解析不出"绝不能等价于"没有这条边"；
 * - 解析成功但不在本插件命名空间的键按无关忽略（不是违规）。
 *
 * @param {string} file 文件（用于记录与解析错误定位）。
 * @param {string} source 源码。
 * @returns {{provides: Array<{file: string, symbol: string, line: number}>,
 *   requires: Array<{file: string, symbol: string, line: number}>,
 *   unresolved: Array<{file: string, line: number, raw: string}>}}
 */
/**
 * 是否是 `Symbol.for(…)` 调用的节点形态（IIFE 键解析的唯一合法调用形状）。
 * 只认非计算成员的 `Symbol.for`：`Symbol["for"](…)` 在词法器里也解析不出，
 * 保持同一条 fail-closed 口径（写成这种形态会被报成未解析键，而不是猜一个值）。
 */
function isSymbolForCall(node) {
  if (!node || node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (!callee || callee.type !== "MemberExpression" || callee.computed === true) return false;
  return Boolean(callee.object && callee.object.type === "Identifier" && callee.object.name === "Symbol"
    && callee.property && callee.property.type === "Identifier" && callee.property.name === "for");
}

function scanIifeGlobalUsage(file, source) {
  const text = typeof source === "string" ? source : String(source ?? "");
  const ast = parseSource(text, file);
  /** `Symbol.for("字面量")` 调用起点 → 键值（collectSymbolForCalls 是本话题的唯一事实源）。 */
  const literalKeyByCallStart = new Map();
  for (const record of collectSymbolForCalls(ast, { source: text }).keys) {
    if (Number.isSafeInteger(record.start)) literalKeyByCallStart.set(record.start, record.value);
  }

  // ── 1) 同文件 Symbol / 字符串常量绑定（与词法器同口径：全深度、后写覆盖先写） ──────
  const symbolBindings = new Map();
  walkAst(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (!node.id || node.id.type !== "Identifier" || !node.init) return;
    if (node.init.type === "CallExpression") {
      const value = literalKeyByCallStart.get(node.init.start);
      if (value !== undefined) symbolBindings.set(node.id.name, value);
      return;
    }
    // `const KEY = "dsh-expert-group/…"`：字符串常量别名（供 Symbol.for(KEY) 使用）。
    if (node.init.type === "Literal" && typeof node.init.value === "string"
      && node.init.value.startsWith(IIFE_SYMBOL_PREFIX)) {
      symbolBindings.set(node.id.name, node.init.value);
    }
  });

  // ── 2) `globalThis[键]` / `global[键]` 的读写点 ────────────────────────────────
  const provides = [];
  const requires = [];
  const unresolved = [];
  walkAst(ast, (node, parent) => {
    if (node.type !== "MemberExpression" || node.computed !== true) return;
    const object = node.object;
    if (!object || object.type !== "Identifier"
      || (object.name !== "globalThis" && object.name !== "global")) return;
    const line = node.loc?.start?.line ?? 0;
    const property = node.property;
    // 键表达式 → Symbol 字符串：字面量调用 / 同文件常量 / （保持 fail-closed 的）其余形态。
    let symbol = null;
    if (isSymbolForCall(property)) {
      symbol = literalKeyByCallStart.get(property.start) ?? null;
      if (symbol === null) {
        // `Symbol.for(同文件字符串常量)`：实参是标识符时回查绑定表（与词法器同一条规则）。
        const argument = property.arguments?.[0];
        if (argument && argument.type === "Identifier") symbol = symbolBindings.get(argument.name) ?? null;
      }
    } else if (property && property.type === "Identifier") {
      // `globalThis[NAME]` / `global[NAME]`：同一张绑定表。
      symbol = symbolBindings.get(property.name) ?? null;
    }
    if (symbol === null) {
      // 票据 38/45：动态键不再静默忽略。原文片段取整个成员访问（到 `]` 为止），够人复核。
      unresolved.push({
        file,
        line,
        raw: text.slice(node.start, node.end).replace(/\s+/g, " ").trim(),
      });
      return;
    }
    // 解析成功但不在本插件命名空间：与 IIFE 依赖无关，按原语义忽略（不是违规）。
    if (!symbol.startsWith(IIFE_SYMBOL_PREFIX)) return;
    const isAssignment = Boolean(parent)
      && parent.type === "AssignmentExpression"
      && parent.left === node
      && parent.operator === "=";
    const record = { file, symbol, line };
    if (isAssignment) provides.push(record);
    else requires.push(record);
  });
  return { provides, requires, unresolved };
}
/**
 * 纯函数：从客户端 IIFE 的静态声明归纳「文件 → 文件」依赖边（票据 02 的占位读取接口；
 * 票据 45 起是"共享构造器"——扫描器由调用方注入，AST 与词法器两条路径共用同一套边构造）。
 *
 * ## 方向
 * 边 `from -> to`：`from` **provides** 了某个 `Symbol.for("dsh-expert-group/<id>")`，
 * `to` **requires** 它（读取了同一个 Symbol）——与 `collectEsmGraph` 的方向语义一致。
 *
 * ## 输入
 * - `files`：客户端装配源文件清单（当前来自 `scripts/client-sources.mjs` 的
 *   `CLIENT_SOURCE_FILES`）；
 * - `deps`：这些文件的源码，`Map<file, source>` 或普通对象 `{ [file]: source }`。
 *
 * ## 输出
 * `{ files, provides, requires, edges }`：
 * - `provides` / `requires`：逐条 `{ file, symbol, line }`，按 file、line 排序；
 * - `edges`：去重后的 `{ from, to, symbols: string[], via: "iife-symbol" }`，按 from、to 排序，
 *   `symbols` 去重升序。**同一份输入必然产出同一份边集合**（集合语义，顺序也确定）；
 * - `unresolved`（票据 38）：无法静态解析的全局键 `{ file, line, raw }`，按 file、line 排序。
 *   它们**不产生边**，但会被 `evaluateDependencyGraph` 报成违规（fail-closed），
 *   因为「解析不出 = 静默少一条边」是看不见的假绿；
 * - 同一文件读写自己的 Symbol（幂等登记：先读再写）不算跨文件边，直接过滤。
 *
 * ## 与 03 的 manifest 的分工（已落地）
 * 装配依赖的**事实源**是 `scripts/client-source-manifest.mjs` 的 `iifeDependencies`
 * （在清单里显式声明 requires/provides）。**本函数保留**为「从源码静态归纳」的另一侧：
 * 两边对同一份装配输入必须产出同一组边，逐项相等由 `test/dependency-graph-gate.test.mjs`
 * 持续校验。`evaluateDependencyGraph` 只在分析对象是"manifest 未覆盖的自定义客户端集"
 * （夹具）时才退回本函数的扫描结果，真实仓库一律读声明，因此"漏登记"会立刻表现为
 * 等价性用例失败，而不是门禁悄悄少一条边。
 */
function buildIifeDependencyRecords(files, deps, scanFile) {
  const dependencyEntries = new Map();
  if (deps instanceof Map) {
    for (const [file, source] of deps.entries()) {
      dependencyEntries.set(normalizeModulePath(file), String(source ?? ""));
    }
  } else if (deps !== null && typeof deps === "object") {
    for (const [file, source] of Object.entries(deps)) {
      dependencyEntries.set(normalizeModulePath(file), String(source ?? ""));
    }
  }
  const fileList = [...new Set((files ?? []).map(normalizeModulePath))].sort();
  const provides = [];
  const requires = [];
  const unresolved = [];
  for (const file of fileList) {
    const source = dependencyEntries.get(file);
    if (source === undefined) continue;
    // 扫描器由调用方注入：AST 判据（默认）与词法器对照侧（crossCheck）共用这套"记录 → 边"的构造。
    const scanned = scanFile(file, source);
    for (const entry of scanned.provides) provides.push(entry);
    for (const entry of scanned.requires) requires.push(entry);
    for (const entry of scanned.unresolved) unresolved.push(entry);
  }
  provides.sort(compareSymbolRecords);
  requires.sort(compareSymbolRecords);
  // 动态键记录按 file → line 排序（无 symbol 字段，不能复用 compareSymbolRecords）。
  unresolved.sort((left, right) => (left.file !== right.file
    ? (left.file < right.file ? -1 : 1)
    : left.line - right.line));

  /** symbol -> 提供该 symbol 的文件（多个提供方按文件名排序，边全部产出，便于暴露重复提供）。 */
  const providersBySymbol = new Map();
  for (const record of provides) {
    if (!providersBySymbol.has(record.symbol)) providersBySymbol.set(record.symbol, []);
    providersBySymbol.get(record.symbol).push(record.file);
  }
  for (const providers of providersBySymbol.values()) providers.sort();

  const edgeMap = new Map();
  for (const record of requires) {
    const providers = providersBySymbol.get(record.symbol) ?? [];
    for (const provider of providers) {
      if (provider === record.file) continue; // 同文件自读，不构成跨文件依赖
      const key = provider + "\u0000" + record.file;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { from: provider, to: record.file, symbols: new Set(), via: "iife-symbol" });
      }
      edgeMap.get(key).symbols.add(record.symbol);
    }
  }
  const edges = [...edgeMap.values()]
    .map((edge) => ({ from: edge.from, to: edge.to, symbols: [...edge.symbols].sort(), via: edge.via }))
    .sort((left, right) => {
      if (left.from !== right.from) return left.from < right.from ? -1 : 1;
      if (left.to !== right.to) return left.to < right.to ? -1 : 1;
      return 0;
    });
  return { files: fileList, provides, requires, edges, unresolved };
}

/**
 * 纯函数：客户端 IIFE 依赖边（**AST 判据**；票据 45）。输出契约见 `buildIifeDependencyRecords`。
 *
 * 输入输出与票据 02 的读取接口完全一致（`files` / `deps` → `provides` / `requires` / `edges` /
 * `unresolved`），因此消费者（C1、manifest 等价性用例）不需要任何改动；变的只是"事实怎么读"。
 */
export function collectIifeDependencyEdges(files, deps) {
  return buildIifeDependencyRecords(files, deps, scanIifeGlobalUsage);
}

/**
 * 纯函数：同一份输入的**词法器**结果（票据 45 的 crossCheck 对照侧，**不参与判定**）。
 *
 * 保留它的唯一目的是让"两个实现看见的 IIFE 边是否相同"成为可打印、可断言的证据；
 * 与 C3 的 `collectLexerFactoryDeclarations` 同一角色。
 */
export function collectLexerIifeDependencyEdges(files, deps) {
  return buildIifeDependencyRecords(files, deps, scanIifeGlobalUsageLexer);
}

/** ESM 边的对照键：from → to + kind + specifier（行号不参与身份，只用于定位）。 */
function esmEdgeIdentity(edge) {
  return edge.from + "\u0000" + edge.to + "\u0000" + edge.kind + "\u0000" + edge.specifier;
}

/** IIFE 边的对照键：from → to + symbols（符号集合的顺序已归一）。 */
function iifeEdgeIdentity(edge) {
  return edge.from + "\u0000" + edge.to + "\u0000" + edge.symbols.join(",");
}

/**
 * 通用多重集对照：返回"仅 AST 有"与"仅词法器有"的记录（按身份键计数，保留重数）。
 * 结果按身份键排序，保证报告可复现。
 */
function compareRecordSets(astRecords, lexerRecords, identityOf) {
  const countByKey = (records) => {
    const counts = new Map();
    for (const record of records) {
      const key = identityOf(record);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const astCounts = countByKey(astRecords);
  const lexerCounts = countByKey(lexerRecords);
  const onlyAst = [];
  const onlyLexer = [];
  for (const [key, count] of astCounts) {
    const counterpart = lexerCounts.get(key) ?? 0;
    if (count <= counterpart) continue;
    const sample = astRecords.find((record) => identityOf(record) === key);
    for (let index = counterpart; index < count; index++) onlyAst.push(sample);
  }
  for (const [key, count] of lexerCounts) {
    const counterpart = astCounts.get(key) ?? 0;
    if (count <= counterpart) continue;
    const sample = lexerRecords.find((record) => identityOf(record) === key);
    for (let index = counterpart; index < count; index++) onlyLexer.push(sample);
  }
  const compareSamples = (left, right) => {
    const leftKey = identityOf(left);
    const rightKey = identityOf(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  };
  onlyAst.sort(compareSamples);
  onlyLexer.sort(compareSamples);
  return {
    astCount: astRecords.length,
    lexerCount: lexerRecords.length,
    onlyAst,
    onlyLexer,
    differenceCount: onlyAst.length + onlyLexer.length,
    same: onlyAst.length === 0 && onlyLexer.length === 0,
  };
}

/** 逐文件比较某个数值字段（C4 导出数 / C8 本地 import 数）。 */
function compareModuleNumbers(astGraph, lexerGraph, pick) {
  const differences = [];
  for (const file of astGraph.files) {
    const ast = pick(astGraph.modules.get(file) ?? {});
    const lexer = pick(lexerGraph.modules.get(file) ?? {});
    if (ast !== lexer) differences.push({ file, ast, lexer });
  }
  return { files: astGraph.files.length, differences, same: differences.length === 0 };
}

/**
 * 纯函数：依赖事实的 **AST ↔ 词法器** 对照（票据 45；判据是 AST，词法器只是对照侧）。
 *
 * 四组事实分别对照，互不混合（一个实现某类事实读错，不影响另一类结论的可读性）：
 * 1. **ESM 边**：`import` / `export … from` / 字面量动态 import；
 * 2. **IIFE 边**：`Symbol.for` 提供/读取关系（附"解析不出的键"计数）；
 * 3. **C4 导出数**：每文件导出名个数；
 * 4. **C8 本地 import 数**：每文件相对 import 语句数。
 *
 * 为什么要有它：票据 44/45 的判据从词法器换成 AST，换判据不等于结论不变。只有把两侧
 * 逐项对出来，"差异为 0"才是证据，而不是"没人去看"。
 *
 * @param {{sources?: any, clientFiles?: string[]}} [options] 与 evaluateDependencyGraph 同输入。
 * @returns {{esm: object, iife: object, exports: object, localImports: object}}
 */
export function crossCheckDependencyFacts({ sources, clientFiles = [] } = {}) {
  const entries = normalizeSourceEntries(sources);
  const sourceByFile = new Map(entries.map((entry) => [entry.file, entry.source]));
  const astGraph = collectEsmGraph(entries);
  const lexerGraph = collectEsmGraph(entries, { parseRelations: parseEsmRelationsLexer });
  const esm = compareRecordSets(astGraph.edges, lexerGraph.edges, esmEdgeIdentity);
  const clientList = (clientFiles ?? []).map(normalizeModulePath);
  const iifeAst = collectIifeDependencyEdges(clientList, sourceByFile);
  const iifeLexer = collectLexerIifeDependencyEdges(clientList, sourceByFile);
  const iife = {
    ...compareRecordSets(iifeAst.edges, iifeLexer.edges, iifeEdgeIdentity),
    unresolved: compareRecordSets(
      iifeAst.unresolved,
      iifeLexer.unresolved,
      (record) => record.file + "\u0000" + record.line,
    ),
  };
  return {
    esm,
    iife,
    exports: compareModuleNumbers(astGraph, lexerGraph, (module) => module.exportCount),
    localImports: compareModuleNumbers(astGraph, lexerGraph, (module) => module.localImports),
  };
}
/**
 * 纯函数：把 manifest 的**声明边**归一成与扫描结果同形状的记录。
 *
 * 为什么声明也要归一而不是直接信任常量：声明是手写数据，缺字段 / 空 symbols 这类手误必须
 * 在门禁入口直接抛错——一条悄悄消失的边等于 C1 少一条真实依赖，而"少一条边"永远不会
 * 以失败的形式出现（只会让假绿更像真的）。
 *
 * @param {{from?: string, to?: string, symbols?: string[], via?: string}} edge
 * @returns {{from: string, to: string, symbols: string[], via: string}}
 */
export function normalizeDeclaredIifeEdge(edge) {
  if (edge === null || typeof edge !== "object") {
    throw new TypeError("IIFE 依赖声明必须是对象：" + JSON.stringify(edge));
  }
  const from = normalizeModulePath(edge.from ?? "");
  const to = normalizeModulePath(edge.to ?? "");
  if (!from || !to) throw new Error("IIFE 依赖声明缺少 from/to：" + JSON.stringify(edge));
  if (!Array.isArray(edge.symbols) || edge.symbols.length === 0) {
    throw new Error("IIFE 依赖声明缺少 symbols（必须是 Symbol 名字符串数组）：" + JSON.stringify(edge));
  }
  return {
    from,
    to,
    symbols: edge.symbols.map((symbol) => String(symbol)).sort(),
    via: typeof edge.via === "string" && edge.via.length > 0 ? edge.via : "iife-symbol",
  };
}

/** IIFE 边的稳定排序（from → to），与 collectIifeDependencyEdges 的输出顺序一致。 */
function compareIifeEdges(left, right) {
  if (left.from !== right.from) return left.from < right.from ? -1 : 1;
  if (left.to !== right.to) return left.to < right.to ? -1 : 1;
  return 0;
}

/**
 * 两组 IIFE 边是否**逐项相等**：数量、from/to、via、symbols 全部一致。
 * 顺序在比较前已归一（两侧都按 from → to 排序），因此这里只做逐项字段比较。
 */
function iifeEdgeSetsEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((edge, index) => {
    const other = right[index];
    return edge.from === other.from
      && edge.to === other.to
      && edge.via === other.via
      && edge.symbols.length === other.symbols.length
      && edge.symbols.every((symbol, symbolIndex) => symbol === other.symbols[symbolIndex]);
  });
}

/**
 * 纯函数：在有向图上找环。返回**每个强连通分量一条**代表环，按环首排序，结果确定。
 *
 * @param {{files: string[], edges: Array<{from: string, to: string}>}} graph
 * @returns {Array<{files: string[], edges: Array<object>}>} `files` 按环序（首元素不重复追加在末尾，
 *   报告时由调用方补箭头闭合）；`edges` 为相邻对之间的原始边（来自 graph.edges）。
 */
export function findImportCycles(graph) {
  const files = [...new Set((graph?.files ?? []).map(normalizeModulePath))].sort();
  const fileSet = new Set(files);
  const edges = (graph?.edges ?? []).filter((edge) => fileSet.has(edge.from) && fileSet.has(edge.to));
  const adjacency = new Map(files.map((file) => [file, []]));
  for (const edge of edges) adjacency.get(edge.from).push(edge.to);
  for (const targets of adjacency.values()) targets.sort();

  const indexByNode = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const groups = [];
  let nextIndex = 0;

  /** Tarjan：递归深度＝本地模块数（几十），不会爆栈。 */
  const strongConnect = (node) => {
    indexByNode.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indexByNode.has(target)) {
        strongConnect(target);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(target)));
      } else if (onStack.has(target)) {
        lowLink.set(node, Math.min(lowLink.get(node), indexByNode.get(target)));
      }
    }
    if (lowLink.get(node) === indexByNode.get(node)) {
      const group = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        group.push(member);
      } while (member !== node);
      const selfLoop = (adjacency.get(node) ?? []).includes(node);
      if (group.length > 1 || selfLoop) groups.push(group.sort());
    }
  };
  for (const file of files) {
    if (!indexByNode.has(file)) strongConnect(file);
  }

  const cycles = groups.map((group) => representCycle(group, adjacency, edges));
  cycles.sort((left, right) => {
    const leftKey = left.files.join(" -> ");
    const rightKey = right.files.join(" -> ");
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return cycles;
}

/**
 * 从一个强连通分量里取一条代表环：从字典序最小的节点出发做受限 DFS，回到起点即收尾。
 * 自环单独处理（节点本身即是环）。
 */
function representCycle(group, adjacency, edges) {
  const members = new Set(group);
  const start = group[0];
  const neighborsOf = (node) => [...new Set((adjacency.get(node) ?? [])
    .filter((target) => members.has(target)))].sort();
  if (neighborsOf(start).includes(start)) {
    return { files: [start], edges: [pickEdge(edges, start, start)] };
  }
  const path = [start];
  const visited = new Set([start]);
  const walk = (node) => {
    for (const target of neighborsOf(node)) {
      if (target === start) return true;
      if (visited.has(target)) continue;
      visited.add(target);
      path.push(target);
      if (walk(target)) return true;
      path.pop();
    }
    return false;
  };
  walk(start);
  const cycleEdges = path.map((node, index) => pickEdge(edges, node, path[(index + 1) % path.length]));
  return { files: path, edges: cycleEdges };
}

/** 取相邻对之间的原始边（排序稳定的第一条），保证报告里的行号可复现。 */
function pickEdge(edges, from, to) {
  return edges.find((edge) => edge.from === from && edge.to === to)
    ?? { from, to, kind: "unknown", specifier: "", line: 0 };
}

/**
 * 判断模块是否在 C2 的作用域内（`host/`、`shared/`、`fanout/` 前缀，及 R1 前的
 * `shared.js` / `fanout.js`）。
 */
export function isEntryDependentModule(file) {
  const normalized = normalizeModulePath(file);
  if (ENTRY_DEPENDENT_FILES.includes(normalized)) return true;
  return ENTRY_DEPENDENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** 白名单校验：没有理由的豁免等同于悄悄放宽判据，直接抛错。 */
function assertWhitelistEntries(whitelist) {
  for (const entry of whitelist?.cycles ?? []) {
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      throw new Error("依赖图白名单 cycles 条目缺少 reason：" + JSON.stringify(entry));
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error("依赖图白名单 cycles 条目缺少 files：" + JSON.stringify(entry));
    }
  }
  for (const entry of whitelist?.dynamicImports ?? []) {
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      throw new Error("依赖图白名单 dynamicImports 条目缺少 reason：" + JSON.stringify(entry));
    }
    if (typeof entry.file !== "string" || !Number.isFinite(entry.line)) {
      throw new Error("依赖图白名单 dynamicImports 条目缺少 file/line：" + JSON.stringify(entry));
    }
  }
}

/**
 * 纯函数库登记表校验：条目必须带 file / concern / reason 三个字段。
 * 缺字段的登记等同于「悄悄放宽判据」，直接抛错而不是静默忽略。
 */
function assertPureFunctionLibraryExemptions(entries) {
  for (const entry of entries ?? []) {
    if (typeof entry?.file !== "string" || entry.file.trim() === "") {
      throw new Error("C4 纯函数库登记缺少 file：" + JSON.stringify(entry));
    }
    if (typeof entry?.concern !== "string" || entry.concern.trim() === "") {
      throw new Error("C4 纯函数库登记缺少 concern：" + JSON.stringify(entry));
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      throw new Error("C4 纯函数库登记缺少 reason：" + JSON.stringify(entry));
    }
  }
}

/** 环是否命中白名单（按文件集合等价匹配，环序不影响判定）。 */
function cycleIsWhitelisted(cycle, whitelist) {
  const cycleKey = [...new Set(cycle.files)].sort().join("\u0000");
  return (whitelist?.cycles ?? []).some((entry) => {
    const entryKey = [...new Set(entry.files.map(normalizeModulePath))].sort().join("\u0000");
    return entryKey === cycleKey;
  });
}

/** 非字面量动态 import 是否命中白名单（file + line 精确匹配）。 */
function dynamicImportIsWhitelisted(record, whitelist) {
  return (whitelist?.dynamicImports ?? []).some((entry) =>
    normalizeModulePath(entry.file) === record.file && entry.line === record.line);
}

/**
 * 纯函数：跑四条判据并汇总违规项。不读文件系统，夹具可完整注入。
 *
 * @param {object} options
 * @param {Array<{file, source}>|Map|Record} options.sources 参与统计的源码（通常来自
 *   collectModuleSourceFiles）。
 * @param {string[]} [options.clientSources] IIFE 分析对象；省略时取 sources ∩ CLIENT_SOURCE_FILES。
 * @param {object} [options.limits] C4/C8 阈值覆盖（默认 DEPENDENCY_GRAPH_LIMITS）。
 * @param {object} [options.whitelist] 白名单覆盖（默认 DEPENDENCY_GRAPH_WHITELIST）。
 * @param {Array<{file, concern, reason}>} [options.pureFunctionLibraryExemptions] C4 第 3 类
 *   豁免登记表覆盖（默认 PURE_FUNCTION_LIBRARY_EXEMPTIONS；测试用它注入夹具）。
 * @param {Array<{from, to, symbols, via}>} [options.iifeDependencies] 客户端 IIFE 依赖边声明覆盖
 *   （默认 manifest 的 `iifeDependencies`；测试用它注入夹具或验证"声明边参与 C1 环检测"）。
 * @param {Array<{file, name, groups, reason?}>} [options.factoryRegistry] C3 工厂清单。
 *   默认**空**：纯函数入口面对的是调用方给定的源码宇宙（夹具/临时目录），套用真实仓库的
 *   清单只会把它全部判成「清单过期」。真实仓库由 `evaluateRepository` 显式传入
 *   `C3_FACTORY_REGISTRY`；测试用它注入「过期登记」与「超 8 无 reason」夹具。
 * @param {Array<{file, name, reason}>} [options.factoryExclusions] C3 例外表（纯数据构造 /
 *   纯 helper）。默认空；真实仓库由 `evaluateRepository` 传入 `C3_NON_FACTORY_EXCLUSIONS`。
 * @param {boolean} [options.reconcileFactories] 是否做 C3 声明对账（默认 `false`）。
 *   为什么默认关：空登记表 + 开启对账会把**任意**夹具源码里的 `create*` 全判成未分类，
 *   夹具测试因此失去意义。真实仓库由 `evaluateRepository` 显式开启。
 * @param {boolean} [options.factoryCrossCheck] 是否做 C3 的 AST ↔ 词法器声明对照（默认 `false`）。
 * @param {boolean} [options.dependencyCrossCheck] 是否做 C1/C2/C4/C8 的 AST ↔ 词法器事实对照
 *   （默认 `false`；真实仓库由 `evaluateRepository` 开启）。
 * @param {string} [options.entry] 入口模块路径（默认 index.js；仓库内由 `readEntryModule` 从
 *   `package.json` `exports["."]` 读出）。
 * @returns {{ok: boolean, violations: Array<object>, counts: Record<string, number>,
 *   graph: object, modules: Map, iife: object, cycles: Array<object>, unresolved: Array<object>,
 *   entry: string, exemptions: Array<object>}}
 */
export function evaluateDependencyGraph(options = {}) {
  const {
    sources,
    clientSources,
    limits = DEPENDENCY_GRAPH_LIMITS,
    whitelist = DEPENDENCY_GRAPH_WHITELIST,
    pureFunctionLibraryExemptions = PURE_FUNCTION_LIBRARY_EXEMPTIONS,
    iifeDependencies = CLIENT_MANIFEST_IIFE_DEPENDENCIES,
    factoryRegistry = [],
    factoryExclusions = [],
    reconcileFactories = false,
    // 票据 44：AST 与词法器的声明集合交叉校验。默认关闭——纯函数入口（夹具）不需要
    // 承担词法器那次解析；真实仓库由 evaluateRepository 显式开启。
    factoryCrossCheck = false,
    // 票据 45：C1/C2/C4/C8 依赖事实的 AST ↔ 词法器对照。同样默认关闭（夹具不承担双份扫描），
    // 真实仓库由 evaluateRepository 显式开启。
    dependencyCrossCheck = false,
    entry = ENTRY_MODULE,
  } = options;
  assertWhitelistEntries(whitelist);
  assertPureFunctionLibraryExemptions(pureFunctionLibraryExemptions);
  const entryModule = normalizeModulePath(entry);
  const exportLimit = limits.exports ?? DEPENDENCY_GRAPH_LIMITS.exports;
  const localImportLimit = limits.localImports ?? DEPENDENCY_GRAPH_LIMITS.localImports;

  const graph = collectEsmGraph(sources);
  const sourceByFile = new Map(normalizeSourceEntries(sources).map((item) => [item.file, item.source]));
  const clientFiles = (clientSources ?? graph.files.filter((file) => CLIENT_SOURCE_FILES.includes(file)))
    .map(normalizeModulePath)
    .filter((file) => sourceByFile.has(file));

  // ── 客户端 IIFE 边的两侧证据 ────────────────────────────────────────────────
  // - 声明：manifest 的 iifeDependencies（装配意图的唯一事实源，票据 03 起是**入图来源**）；
  // - 扫描：collectIifeDependencyEdges（源码 Symbol 读写证据，保留作等价性校验的另一侧）。
  const iifeScan = collectIifeDependencyEdges(clientFiles, sourceByFile);
  const declaredEdges = iifeDependencies
    .map(normalizeDeclaredIifeEdge)
    .filter((edge) => clientFiles.includes(edge.from) && clientFiles.includes(edge.to))
    .sort(compareIifeEdges);
  // 分析对象是"manifest 覆盖的真实装配输入"时读声明；否则（夹具 / 自定义客户端集）退回扫描。
  // 这条回退规则让门禁对任意注入源码仍是纯函数、仍能报环，同时保证真实仓库只有一处事实源。
  const manifestClientUniverse = new Set(CLIENT_MANIFEST_ASSEMBLY_ORDER.map(normalizeModulePath));
  const useDeclaredEdges = clientFiles.length > 0
    && clientFiles.every((file) => manifestClientUniverse.has(file));
  const iife = Object.freeze({
    files: iifeScan.files,
    provides: iifeScan.provides,
    requires: iifeScan.requires,
    // 票据 38：无法静态解析的动态全局键（fail-closed，下面在 C1 里报违规）。
    unresolved: iifeScan.unresolved,
    // edges 是**入图的那一份**（声明或扫描）；scannedEdges 永远是扫描结果，供等价性对比。
    edges: useDeclaredEdges ? declaredEdges : iifeScan.edges,
    scannedEdges: iifeScan.edges,
    declaredEdges,
    source: useDeclaredEdges ? "manifest" : "scan",
    // 声明与扫描是否逐项相等；对扫描回退（夹具）没有可比对象，记为 null 而不是 false。
    equivalent: useDeclaredEdges
      ? iifeEdgeSetsEqual(declaredEdges, [...iifeScan.edges].sort(compareIifeEdges))
      : null,
  });

  const iifeGraphEdges = iife.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    kind: "iife-symbol",
    specifier: edge.symbols.join(","),
    line: 0,
    via: "iife-symbol",
  }));
  const combinedGraph = {
    files: [...new Set([...graph.files, ...iife.files])].sort(),
    edges: [...graph.edges, ...iifeGraphEdges],
  };
  const cycles = findImportCycles(combinedGraph);

  const violations = [];

  // ── C1：环 + 非字面量动态 import ───────────────────────────────────────────
  for (const cycle of cycles) {
    if (cycleIsWhitelisted(cycle, whitelist)) continue;
    const path = [...cycle.files, cycle.files[0]].join(" -> ");
    violations.push({
      rule: "C1",
      kind: "cycle",
      file: cycle.files[0],
      line: cycle.edges[0]?.line ?? 0,
      files: cycle.files,
      edges: cycle.edges,
      message: "依赖环：" + path,
    });
  }
  for (const file of graph.files) {
    const module = graph.modules.get(file);
    for (const dynamicEntry of module.dynamicImports) {
      if (dynamicEntry.specifier !== null) continue;
      const record = { file, line: dynamicEntry.line };
      if (dynamicImportIsWhitelisted(record, whitelist)) continue;
      violations.push({
        rule: "C1",
        kind: "dynamic-import",
        file,
        line: dynamicEntry.line,
        raw: dynamicEntry.raw,
        message: "动态 import() 必须是字面量；实际表达式：" + (dynamicEntry.raw || "<无法识别的表达式>"),
      });
    }
  }
  // 票据 38：动态 Symbol 键 fail-closed。解析不出的键意味着这条 IIFE 依赖边**不存在**，
  // 环检测会因此少一条可能成环的路径。此处显式报违规，而不是让它静默消失。
  for (const record of iifeScan.unresolved) {
    violations.push({
      rule: "C1",
      kind: "unresolved-iife-symbol",
      file: record.file,
      line: record.line,
      raw: record.raw,
      message: "无法静态解析的全局 Symbol 键（IIFE 依赖边会缺失）：" + (record.raw || "<无法识别的表达式>"),
    });
  }

  // ── C2：反向 import 入口 ──────────────────────────────────────────────────
  for (const file of graph.files) {
    if (!isEntryDependentModule(file)) continue;
    const module = graph.modules.get(file);
    for (const importEntry of module.imports) {
      if (importEntry.resolved !== entryModule) continue;
      violations.push({
        rule: "C2",
        kind: "reverse-import",
        file,
        line: importEntry.line,
        specifier: importEntry.specifier,
        message: "内部模块不得 import 入口 " + entryModule + "（" + importEntry.specifier + "）",
      });
    }
  }

  // ── C4：导出数（三类豁免：组合根 / 兼容门面 / 登记过的凝聚纯函数库） ─────
  //
  // 判定顺序固定：组合根 → 兼容门面 → 纯函数库登记。前两类是机械判定，不依赖任何登记；
  // 第三类必须先登记，登记后仍要通过 inspectPureFunctionLibrary 的机械校验（登记不等于免检）。
  const registeredByFile = new Map(pureFunctionLibraryExemptions.map((item) => [normalizeModulePath(item.file), item]));
  const exemptions = [];
  const invalidRegistrationsByFile = new Map();
  for (const file of graph.files) {
    const module = graph.modules.get(file);
    const exportCount = module.exportCount;
    const overLimit = exportCount > exportLimit;
    if (file === entryModule) {
      exemptions.push({ file, kind: EXPORT_EXEMPTION_KINDS.entry, exportCount, overLimit, reason: "组合根（package.json exports[\".\"] 目标）" });
      continue;
    }
    if (isReExportFacade(sourceByFile.get(file) ?? "")) {
      exemptions.push({ file, kind: EXPORT_EXEMPTION_KINDS.facade, exportCount, overLimit, reason: "兼容门面（只有 import / export ... from，无实现体）" });
      continue;
    }
    const registration = registeredByFile.get(file);
    if (registration) {
      const inspection = inspectPureFunctionLibrary(sourceByFile.get(file) ?? "");
      if (inspection.ok) {
        exemptions.push({
          file,
          kind: EXPORT_EXEMPTION_KINDS.pureFunctionLibrary,
          exportCount,
          overLimit,
          reason: registration.reason,
          concern: registration.concern,
        });
        continue;
      }
      // 登记不等于免检：机械校验失败时即使已登记也必须报错。
      invalidRegistrationsByFile.set(file, inspection.problems);
    }
    if (!overLimit) continue;
    const problems = invalidRegistrationsByFile.get(file);
    violations.push({
      rule: "C4",
      kind: problems ? "invalid-exemption" : "exports",
      file,
      line: 1,
      value: exportCount,
      limit: exportLimit,
      problems: problems ?? null,
      message: problems
        ? "导出数 " + exportCount + " > 上限 " + exportLimit
          + "；已登记为凝聚纯函数库但机械校验失败：" + problems.join("；")
        : "导出数 " + exportCount + " > 上限 " + exportLimit,
    });
  }
  // 登记表里指向统计范围外文件的条目不做单独报错：文件一旦改名/删除，新路径本身就会作为
  // C4 超限被报出（这正是我们要的可见性），再报「陈旧登记」只会给夹具和临时目录制造噪音。

  // ── C8：本地 import 数 ────────────────────────────────────────────────────
  for (const file of graph.files) {
    if (LOCAL_IMPORT_EXEMPT_MODULES.includes(file)) continue;
    // 兼容门面（纯 re-export）的「本地 import 数」没有耦合意义：它必须逐叶再导出，
    // 条数随叶子数线性增长，但对外仍是同一批符号、不引入新的协作方。判定与 C4 的
    // facade 豁免共用同一个机械函数，避免两处口径漂移。
    if (isReExportFacade(sourceByFile.get(file) ?? "")) continue;
    const module = graph.modules.get(file);
    if (module.localImports <= localImportLimit) continue;
    violations.push({
      rule: "C8",
      kind: "local-imports",
      file,
      line: 1,
      value: module.localImports,
      limit: localImportLimit,
      message: "本地 import 语句 " + module.localImports + " 条 > 上限 " + localImportLimit,
    });
  }

  // ── C3：内部工厂能力组（显式清单 + 存在性校验；票据 32） ──────────────────
  // 组数不做自动推导（理由见 C3_FACTORY_REGISTRY 的注释）：门禁只校验「登记过的工厂仍
  // 真实存在」与「超上限者必须写明理由」，避免清单悄悄过期。
  for (const violation of inspectFactoryRegistry(factoryRegistry, sources, {
    exclusions: factoryExclusions,
    reconcile: reconcileFactories,
  })) {
    violations.push(violation);
  }

  /**
   * 声明的事实源只算一次（票据 44）：统计与交叉校验共用同一份 AST 结果。
   * `null` 表示对账未开启（夹具入口），报告据此不声称"已完成对账"。
   */
  // 票据 46：顺带取回"无法静态定名的计算键"，供 C3 报告打印告警（不进违规）。
  const factoryDeclarations = reconcileFactories === true
    ? collectFactoryDeclarations(sources, { withDynamicKeys: true })
    : null;
  const factoryDeclarationList = factoryDeclarations === null ? null : factoryDeclarations.declarations;
  /** 交叉校验结果；未开启对账、或未显式开启交叉校验时为 null。 */
  const factoryDeclarationCrossCheck = factoryDeclarationList === null || factoryCrossCheck !== true
    ? null
    : compareFactoryDeclarationSets(factoryDeclarationList, collectLexerFactoryDeclarations(sources));
  /**
   * 票据 45：依赖事实的对照（ESM 边 / IIFE 边 / C4 导出数 / C8 本地 import 数）。
   * 未开启时为 null——纯函数入口（夹具）不做双份扫描，报告据此跳过该段。
   */
  const dependencyCrossCheckResult = dependencyCrossCheck !== true
    ? null
    : crossCheckDependencyFacts({ sources, clientFiles });

  violations.sort(compareViolations);
  const counts = { C1: 0, C2: 0, C3: 0, C4: 0, C8: 0 };
  for (const violation of violations) counts[violation.rule] += 1;
  exemptions.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  return {
    ok: violations.length === 0,
    violations,
    counts,
    graph: combinedGraph,
    modules: graph.modules,
    iife,
    cycles,
    unresolved: graph.unresolved,
    entry: entryModule,
    exemptions,
    // 报告用：登记表随结果一起返回，避免「测试注入的自定义登记」与 CLI 打印的常量不一致。
    pureFunctionLibraryExemptions: [...pureFunctionLibraryExemptions],
    factoryRegistry: [...factoryRegistry],
    factoryExclusions: [...factoryExclusions],
    /** 对账是否开启；报告的「声明 = 登记 + 例外」一行据此决定是否声称已完成对账。 */
    factoryReconciled: reconcileFactories === true,
    /**
     * 对账两侧的实测规模（票据 36）：CLI 必须用**真实声明数**打印等式，
     * 而不是拿「登记 + 例外」的和冒充「源码声明」——后者在漏登记时会自动平衡，
     * 恰好掩盖了它要证明的东西。
     */
    factoryDeclarationStats: factoryDeclarationList === null
      ? null
      : (() => {
        const counts = new Map();
        for (const declaration of factoryDeclarationList) {
          const key = factoryDeclarationKey(declaration);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return {
          total: factoryDeclarationList.length,
          distinct: counts.size,
          /**
           * 票据 46：无法静态定名的计算属性键（运行期才知道是不是工厂）。
           * 它们**不进违规**，但必须在报告里可见——"看不见的不确定"是 C3 漏报的温床。
           */
          dynamicKeys: [...factoryDeclarations.dynamicKeys],
          /**
           * 重复键明细（票据 44）：此前报告里写死"见 client-sidebar-auto-ledger.js 的 created"，
           * 那是一处只对当时快照成立的注释。AST 侧多出两处"函数声明 + 描述符属性"同名之后，
           * 必须逐条列出，否则读者会以为重复只有一处。
           */
          duplicated: [...counts]
            .filter(([, count]) => count > 1)
            .map(([key, count]) => {
              const sample = factoryDeclarationList.find((declaration) => factoryDeclarationKey(declaration) === key);
              return { file: sample.file, name: sample.name, count };
            })
            .sort((left, right) => (left.file === right.file
              ? (left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
              : (left.file < right.file ? -1 : 1))),
        };
      })(),
    /**
     * 票据 44 交叉校验：`{ astCount, lexerCount, onlyAst, onlyLexer, multiplicity,
     * differenceCount, same }`；未开启时为 null（报告据此跳过该段）。
     */
    factoryDeclarationCrossCheck,
    /**
     * 票据 45 交叉校验：`{ esm, iife, exports, localImports }`，每项含 `same` 与差异明细；
     * 未开启时为 null。
     */
    dependencyFactsCrossCheck: dependencyCrossCheckResult,
  };
}

/** 违规项排序：判据 → 文件 → 行号。 */
function compareViolations(left, right) {
  if (left.rule !== right.rule) return left.rule < right.rule ? -1 : 1;
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return 0;
}

/** 人类可复核的一行。 */
export function formatDependencyViolation(violation) {
  return "[" + violation.rule + ":" + violation.kind + "] " + violation.file
    + (violation.line > 0 ? ":" + violation.line : "") + " " + violation.message;
}

/** 读入统计范围内的源码，供 CLI 与真实仓库回归测试共用。 */
export async function collectDependencyGraphSources(root, files) {
  const list = files ?? await collectModuleSourceFiles(root);
  const sources = [];
  for (const file of list) {
    const source = await readFile(resolve(root, file), "utf8");
    sources.push({ file: normalizeModulePath(file), source });
  }
  return sources;
}

/** 便捷入口：对真实仓库跑一遍四条判据。组合根由 package.json 的 exports["."] 机械确定。 */
export async function evaluateRepository(root, options = {}) {
  const files = options.files ?? await collectModuleSourceFiles(root);
  const sources = options.sources ?? await collectDependencyGraphSources(root, files);
  const entry = options.entry ?? await readEntryModule(root);
  // 真实仓库检查必须带上 C3 工厂清单：纯函数入口默认空清单（见 evaluateDependencyGraph）。
  const factoryRegistry = options.factoryRegistry ?? C3_FACTORY_REGISTRY;
  // 真实仓库默认带例外表并开启对账：这是票据 34 的核心判据（源码声明必须全部入册）。
  const factoryExclusions = options.factoryExclusions ?? C3_NON_FACTORY_EXCLUSIONS;
  const reconcileFactories = options.reconcileFactories ?? true;
  // 票据 44：真实仓库默认开启 AST ↔ 词法器交叉校验（差异必须打印出来，不靠人记得去看）。
  const factoryCrossCheck = options.factoryCrossCheck ?? true;
  // 票据 45：依赖事实的同类对照也默认开启（判据是 AST，差异必须可见）。
  const dependencyCrossCheck = options.dependencyCrossCheck ?? true;
  return evaluateDependencyGraph({
    ...options,
    files: undefined,
    entry,
    sources,
    factoryRegistry,
    factoryExclusions,
    reconcileFactories,
    factoryCrossCheck,
    dependencyCrossCheck,
  });
}

/**
 * 打印 C4 三类豁免的判定结果：各豁免类别、当前命中的文件，以及「因豁免而跳过（超限但不判失败）」。
 * 目的是让复核者能一眼看出**哪条超限被豁免、依据是哪一类**，而不是只看到「违规 N 条」。
 */
function printExportExemptions(result) {
  const exemptions = result.exemptions ?? [];
  const byKind = {
    [EXPORT_EXEMPTION_KINDS.entry]: [],
    [EXPORT_EXEMPTION_KINDS.facade]: [],
    [EXPORT_EXEMPTION_KINDS.pureFunctionLibrary]: [],
  };
  for (const exemption of exemptions) byKind[exemption.kind]?.push(exemption);
  const formatList = (items) => (items.length === 0
    ? "未命中"
    : items.map((item) => item.file + "（" + item.exportCount + " 个导出）").join(", "));
  console.log("  组合根（package.json exports[\".\"] 目标：" + result.entry + "）："
    + formatList(byKind[EXPORT_EXEMPTION_KINDS.entry]));
  const facades = byKind[EXPORT_EXEMPTION_KINDS.facade];
  console.log("  兼容门面（只有 import / export ... from，无实现体）：" + formatList(facades)
    + (facades.length === 0 ? "（shared.js 仍是真实实现，故照实报出）" : ""));
  const pure = byKind[EXPORT_EXEMPTION_KINDS.pureFunctionLibrary];
  console.log("  凝聚纯函数库（显式登记 + 机械校验通过）：" + formatList(pure)
    + "；登记表 " + (result.pureFunctionLibraryExemptions ?? []).length
    + " 条（见 docs/specs/module-owner-ledger.md §3）");
  const skipped = exemptions.filter((exemption) => exemption.overLimit);
  console.log("  因豁免而跳过（超限但不判失败）："
    + (skipped.length === 0
      ? "无"
      : skipped.map((item) => item.file + " " + item.exportCount + "（" + item.kind + "）").join(", ")));
}

/**
 * 把依赖事实对照结果格式化成可打印的文本行（票据 45；CLI 与测试共用同一份措辞）。
 *
 * 每一项差异为 0 时打印「一致」——这是"换判据之后结论没变"的唯一机械证据，不能让读者
 * 自己去猜"没打印就是没问题"。差异逐条列出（边 / 文件 / 两侧数值），便于逐条解释。
 *
 * @param {object} crossCheck `crossCheckDependencyFacts` 的返回值。
 * @returns {string[]} 每项一行。
 */
export function formatDependencyFactsCrossCheck(crossCheck) {
  const lines = ["依赖事实交叉校验（票据 45：判据是 AST，词法器是对照侧）"];
  const describeRecords = (label, bucket, render) => {
    if (bucket.same) {
      lines.push("  " + label + "：AST " + bucket.astCount + " / 词法器 " + bucket.lexerCount + " — 一致");
      return;
    }
    lines.push("  " + label + "：AST " + bucket.astCount + " / 词法器 " + bucket.lexerCount
      + " — 差异 " + bucket.differenceCount + " 条");
    for (const record of bucket.onlyAst) lines.push("    + 仅 AST：" + render(record));
    for (const record of bucket.onlyLexer) lines.push("    - 仅词法器：" + render(record));
  };
  describeRecords("ESM 边", crossCheck.esm, (edge) => edge.from + " -> " + edge.to
    + "（" + edge.kind + " " + edge.specifier + "，第 " + edge.line + " 行）");
  describeRecords("IIFE 边", crossCheck.iife, (edge) => edge.from + " -> " + edge.to
    + "（" + edge.symbols.join(", ") + "）");
  if (crossCheck.iife.unresolved) {
    describeRecords("IIFE 未解析键", crossCheck.iife.unresolved,
      (record) => record.file + ":" + record.line + " " + (record.raw || ""));
  }
  const describeNumbers = (label, bucket) => {
    if (bucket.same) {
      lines.push("  " + label + "：" + bucket.files + " 个文件逐项比较 — 一致");
      return;
    }
    lines.push("  " + label + "：" + bucket.files + " 个文件 — 差异 " + bucket.differences.length + " 个文件");
    for (const entry of bucket.differences) {
      lines.push("    ≠ " + entry.file + "（AST " + entry.ast + " / 词法器 " + entry.lexer + "）");
    }
  };
  describeNumbers("C4 导出数", crossCheck.exports);
  describeNumbers("C8 本地 import 数", crossCheck.localImports);
  return lines;
}

/** 打印某条判据的违规明细（无违规则打印一行确认）。 */
function reportViolations(result, rule) {
  const violations = result.violations.filter((violation) => violation.rule === rule);
  if (violations.length === 0) {
    console.log("  ✓ 未发现违规");
    return;
  }
  for (const violation of violations) console.log("  " + formatDependencyViolation(violation));
}

/** CLI 报告：逐条判据打印口径、实测与违规清单。 */
function printReport(result) {
  const { graph, modules, iife, cycles, unresolved } = result;
  const esmInternalEdges = graph.edges.filter((edge) => edge.kind !== "iife-symbol");
  const dynamicImports = [...modules.values()].flatMap((module) =>
    module.dynamicImports.map((entry) => ({ file: module.file, ...entry })));

  console.log("依赖图门禁（R0 票据 02）：C1 / C2 / C4 / C8");
  console.log("统计范围：" + graph.files.length + " 个产品源码文件（package.json files 的 JS/MJS 源码 ∪ "
    + "CLIENT_SOURCE_FILES；排除 test/、client-bundle.js、node_modules/、.git/、.scratch/）");
  console.log("阈值：导出数 ≤" + DEPENDENCY_GRAPH_LIMITS.exports
    + " / 本地 import ≤" + DEPENDENCY_GRAPH_LIMITS.localImports);
  console.log("");

  console.log("C1 ESM 依赖图无环（含客户端 IIFE 依赖边）");
  const iifeEdgeSource = iife.source === "manifest"
    ? "manifest.iifeDependencies（显式声明）"
    : "静态扫描（manifest 未覆盖该客户端集）";
  console.log("  ESM 内部边 " + esmInternalEdges.length + " 条；IIFE 边 " + iife.edges.length
    + " 条（来源：" + iifeEdgeSource + "）");
  if (iife.source === "manifest") {
    // 等价性只对"声明 vs 扫描"这一对有意义；回退到扫描时没有可比对象。
    console.log("  声明 vs 扫描等价性：" + (iife.equivalent
      ? "逐项一致（" + iife.edges.length + " 条边，符号集合与方向全等）"
      : "不一致（manifest 的 iifeDependencies 与源码证据分叉，请同步清单或修实现）"));
  }
  if (iife.edges.length === 0) {
    console.log("  IIFE 边集合：（无）");
  } else {
    console.log("  IIFE 边集合（提供方 -> 读取方）：");
    for (const edge of iife.edges) {
      console.log("    " + edge.from + " -> " + edge.to + "（" + edge.symbols.join(", ") + "）");
    }
  }
  console.log("  动态 import() " + dynamicImports.length + " 条，其中非字面量 "
    + dynamicImports.filter((entry) => entry.specifier === null).length + " 条");
  console.log("  环 " + cycles.length + " 个；无法静态解析的全局 Symbol 键 " + iife.unresolved.length
    + " 条（fail-closed：会计入 C1 违规）");
  if (unresolved.length > 0) {
    console.log("  相对 import 未落在统计范围内（提示，不计违规）："
      + unresolved.map((entry) => entry.file + ":" + entry.line + " " + entry.specifier).join("；"));
  }
  reportViolations(result, "C1");

  console.log("C2 host/、shared/、fanout/ 不得反向 import 入口 " + ENTRY_MODULE);
  const scoped = graph.files.filter(isEntryDependentModule);
  console.log("  纳入检查的内部模块 " + scoped.length + " 个：" + scoped.join(", "));
  reportViolations(result, "C2");

  console.log("C3 内部工厂能力组 ≤" + FACTORY_GROUP_LIMIT
    + "（显式清单 + 存在性校验 + 声明对账 + faces 明细；组数人工评审却可逐条复核）");
  const factoryRegistry = result.factoryRegistry ?? [];
  const factoryExclusions = result.factoryExclusions ?? [];
  const overLimitFactories = factoryRegistry.filter((entry) => entry.groups > FACTORY_GROUP_LIMIT);
  console.log("  清单 " + factoryRegistry.length + " 条 + 例外 " + factoryExclusions.length
    + " 条；超 " + FACTORY_GROUP_LIMIT + " 组 " + overLimitFactories.length + " 条（均已登记 reason）");
  /**
   * 逐条打印 faces：超上限条目 + 正好等于上限的条目都要打。
   *
   * 为什么连"正好 8 组"也打：8 组是硬上限，任何一条都是"再也不能加"的风险点，
   * 复核者必须能在门禁输出里直接看到它的 8 个面是什么，而不必翻源码或台账。
   *
   * 票据 35 起逐组打印 `name（capability）`：只有名字仍然等于"8 个面里有 8 个名字"，
   * 说不清每个面提供什么能力；能力面进输出后，这 25 条（超 8 的 2 条 + 正好 8 的 23 条）
   * 才能在门禁结果里直接逐组复核，而不用再回台账对照。
   */
  const formatFace = (face) => {
    if (face === null || typeof face !== "object") return String(face);
    return face.name + "（" + face.capability + "）";
  };
  const printFaces = (entry) => {
    console.log("    " + entry.file + " :: " + entry.name + " " + entry.groups + " 组：");
    if (!Array.isArray(entry.faces)) {
      console.log("      （未登记 faces）");
    } else {
      for (const face of entry.faces) console.log("      - " + formatFace(face));
    }
    if (entry.reason !== undefined) console.log("      理由：" + entry.reason);
  };
  if (overLimitFactories.length > 0) {
    console.log("  超 " + FACTORY_GROUP_LIMIT + " 组 " + overLimitFactories.length + " 条：");
    for (const entry of overLimitFactories) printFaces(entry);
  }
  const atLimitFactories = factoryRegistry.filter((entry) => entry.groups === FACTORY_GROUP_LIMIT);
  console.log("  正好 " + FACTORY_GROUP_LIMIT + " 组 " + atLimitFactories.length + " 条：");
  for (const entry of atLimitFactories) printFaces(entry);
  // 对账结果必须显式打印：否则「C3=0」只能证明"登记项还在"，不能证明"源码声明全部入册"——
  // 这正是票据 34 之前 55 个客户端工厂长期漏检的原因。
  if (result.factoryReconciled === true) {
    const stats = result.factoryDeclarationStats ?? { total: 0, distinct: 0 };
    // 等式两侧都来自实测：声明数是 collectFactoryDeclarations 的输出，不是"登记 + 例外"的和。
    console.log("  对账：源码 create* 声明 " + stats.total + " 条（" + stats.distinct
      + " 个 file+name 键）= 登记 " + factoryRegistry.length + " + 例外 " + factoryExclusions.length
      + "；未分类 "
      + result.violations.filter((violation) => violation.kind === "unclassified-factory").length
      + " 条");
    if (stats.total !== stats.distinct) {
      // 逐条列出重复键（票据 44 之前这里写死了一处出处，AST 侧多出同名之后会误导读者）。
      console.log("  同名重复声明（按 file+name 归为一个分类位）："
        + (stats.total - stats.distinct) + " 条");
      for (const entry of stats.duplicated ?? []) {
        console.log("    · " + entry.file + " :: " + entry.name + "（" + entry.count + " 处）");
      }
    }
    // 票据 46：无法静态定名的计算属性键必须**可见**（不进违规）。
    // 为什么不做成违规：`{ [expr]: fn }` 的运行期值由程序决定，静态判据无法说它"一定不是
    // create* 工厂"；但把它静默跳过就等于给 C3 开一条永久盲区。折中是"告警 + 逐条列出，
    // 由人判断"，与 C3 其余部分"看得见的不确定"同一取向。
    const dynamicKeys = stats.dynamicKeys ?? [];
    if (dynamicKeys.length === 0) {
      console.log("  C3 动态计算属性键：0 处（本次对账没有无法静态定名的键）");
    } else {
      console.log("  ⚠ C3 动态计算属性键 " + dynamicKeys.length + " 处：无法静态定名，未计入声明清单"
        + "（请人工确认其运行期值是否 create* 工厂）：");
      for (const entry of dynamicKeys) {
        console.log("    · " + entry.file + ":" + entry.line + " [" + (entry.raw || "<无原文>") + "]");
      }
    }
    // 票据 44：AST 与词法器的集合差异必须显式打印——"换判据"不等于"结论没变"，
    // 差异逐条列出来才能被逐条分类（词法器盲区 → 登记/例外；词法器误报 → 修正）。
    if (result.factoryDeclarationCrossCheck) {
      for (const line of formatFactoryDeclarationCrossCheck(result.factoryDeclarationCrossCheck)) {
        console.log("  " + line);
      }
    } else {
      console.log("  AST 与词法器声明集合差异：未校验（本次未开启 factoryCrossCheck）");
    }
    for (const entry of factoryExclusions) {
      console.log("    例外 " + entry.file + " :: " + entry.name + " —— " + entry.reason);
    }
  } else {
    console.log("  对账：未开启（仅夹具入口会关闭）");
  }
  reportViolations(result, "C3");

  console.log("C4 内部模块导出数 ≤" + DEPENDENCY_GRAPH_LIMITS.exports
    + "（豁免三类：组合根 / 兼容门面 / 登记过的凝聚纯函数库）");
  printExportExemptions(result);
  reportViolations(result, "C4");

  console.log("C8 单模块本地 import ≤" + DEPENDENCY_GRAPH_LIMITS.localImports + "（豁免组合根 index.js）");
  const localImportMax = [...modules.values()]
    .filter((module) => module.file !== ENTRY_MODULE)
    .sort((left, right) => right.localImports - left.localImports)[0];
  if (localImportMax) {
    console.log("  非组合根最高：" + localImportMax.file + " " + localImportMax.localImports
      + " 条；组合根 " + ENTRY_MODULE + " " + (modules.get(ENTRY_MODULE)?.localImports ?? 0) + " 条（豁免）");
  }
  reportViolations(result, "C8");

  // 票据 45：依赖事实的 AST ↔ 词法器对照（判据是 AST；差异必须逐条打印，0 差异打印「一致」）。
  if (result.dependencyFactsCrossCheck) {
    for (const line of formatDependencyFactsCrossCheck(result.dependencyFactsCrossCheck)) {
      console.log(line);
    }
  } else {
    console.log("依赖事实交叉校验（票据 45）：未校验（本次未开启 dependencyCrossCheck）");
  }

  console.log("摘要：C1=" + result.counts.C1 + " / C2=" + result.counts.C2
    + " / C3=" + result.counts.C3 + " / C4=" + result.counts.C4 + " / C8=" + result.counts.C8
    + "，合计 " + result.violations.length + " 条");
}

/** CLI 主流程。 */
async function main() {
  const reportOnly = process.argv.includes("--report");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const result = await evaluateRepository(root);
  printReport(result);
  if (result.violations.length === 0) return;
  if (reportOnly) {
    console.log("（--report：仅报告，不设置失败退出码）");
  } else {
    console.log("门禁未通过：请按上面的清单处理，或用 --report 仅查看。");
    process.exitCode = 1;
  }
}

// 只有被当作脚本直接执行时才跑 CLI；被测试 import 时不产生副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  await main();
}
