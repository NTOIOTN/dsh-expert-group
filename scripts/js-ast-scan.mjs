/**
 * 基于 acorn 的 JavaScript 源码事实扫描（票据 44）。
 *
 * ## 为什么需要它
 * 手写词法器 `scripts/js-source-scan.mjs` 无法被证明完备：『正则字面量 vs 除号』在 JS 里
 * 无法局部判定，oracle 连续多轮用**语法合法但刁钻**的写法找到静默漏报（`throw /[}]/`、
 * `async` 当标识符、class static 块内的 `}` 等）。票据 42 / 43 每轮都在给词法器补边界，
 * 这本身就是「修补不完」的证据。
 *
 * 票据 44 的裁定是**引入真实解析器**：凡属"声明 / 依赖事实"（C3 对账、C1/C2 边所需的
 * 模块说明符、IIFE `Symbol.for` 键）改用 AST；行数门禁的跨度判据**暂不切换**（朴素 AST
 * 计数会一次冒出大量超限，其中绝大多数是 `install*` 模块包装与组件/工厂类别差异），
 * 但新增 AST **交叉校验**（`scripts/check-module-size.mjs --ast-cross-check`）。
 *
 * ## 边界（刻意不做的）
 * - 不做作用域分析、不做类型推断、不做代码生成；只回答"源码里有哪些声明/说明符"。
 * - 不修改传入的 AST（父节点通过回调参数传递，不写回 `node.parent`），避免二次遍历
 *   时踩到自引用。
 * - 不吞解析错误：解析失败一律**带文件名与行列**抛出（fail-closed），因为"解析器看不懂"
 *   与"源码里没有"必须能被区分开——这正是词法器做不到的事。
 *
 * ## 导出（票据 44 的五个 + 票据 45 的基础件）
 * 1. `parseSource(source, file)` —— 先 `module` 再 `script`（客户端 sidecar 是经典脚本）；
 * 2. `collectFunctionNodes(ast)` —— 全部函数节点（声明 / 表达式 / 箭头）与命名、跨度、父节点；
 * 3. `collectCreateDeclarations(ast, file)` —— 语义对齐 C3 收集器的 `create*` 声明清单；
 * 4. `collectModuleSpecifiers(ast)` —— 静态 import / export 的来源与导出名（供 C1/C2/C4/C8）；
 * 5. `collectSymbolForCalls(ast)` —— `Symbol.for("…")` 的字面量键与非字面量参数
 *    （后者供 fail-closed：解析不出的键不能被静默当成"没有这条依赖边"）；
 * 6. `collectDynamicImports(ast, {source})` —— 动态 `import()` 的字面量说明符与非字面量片段
 *    （票据 45：C1 的「动态 import 必须是字面量」判据用它）；
 * 7. `walkAst(ast, visit)` —— 通用先序遍历基础件（票据 45 导出）：仓库约定的判定
 *    （IIFE 的 `globalThis[Symbol.for(...)]` 读写）放在门禁脚本里，用同一套遍历实现。
 */
import * as acorn from "acorn";

/**
 * 解析选项（单一事实源）。
 *
 * - `ecmaVersion: "latest"`：产品源码用到 class 私有字段 / static 块 / 顶层 await 等新语法；
 * - `locations: true`：所有导出都按**行号**对外记账（行号是人工复核的锚点）；
 * - `allowHashBang: true`：`bin/prompt-inspector.mjs` 首行是 `#!/usr/bin/env node`，
 *   不开启会直接解析失败（该文件在统计范围内，实测必须开）。
 */
const PARSE_OPTIONS = Object.freeze({
  ecmaVersion: "latest",
  locations: true,
  allowHashBang: true,
});

/** 解析模式顺序：先 ESM，再经典脚本（客户端 sidecar 是 IIFE 经典脚本）。 */
const SOURCE_TYPE_ORDER = Object.freeze(["module", "script"]);

/**
 * 遍历 AST 时**必须跳过**的字段：
 * - `loc` / `start` / `end` 是元数据，不是子节点；
 * - `parent` 是本模块自己的脚手架字段（若外部注入过），跳过可避免自引用死循环。
 */
const NON_CHILD_KEYS = new Set(["loc", "start", "end", "parent", "leadingComments", "trailingComments"]);

/** 函数节点类型（唯一的三类）。 */
const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** C3 的声明名口径：名字以 `create` 开头。与词法器同一正则（`^create\w*`）。 */
const CREATE_NAME_PATTERN = /^create\w*/;

/** 是否为函数节点（供外部判断父节点形状时复用）。 */
function isFunctionNode(node) {
  return Boolean(node) && FUNCTION_NODE_TYPES.has(node.type);
}

/**
 * 深度优先遍历（前序），回调拿到 `(node, parent)`。
 *
 * 为什么用显式栈而不是递归：`client-bundle.js` 这类深嵌套产物虽被排除，但源码里
 * 长链式的三元 / 回调仍可能到几十层；显式栈让"深度"不再是隐含约束。
 * 逆序压栈保证**先序 = 源码顺序**，顺序稳定对"逐条对账输出"很重要。
 *
 * 子节点判定用"对象且有 string 类型的 `type`"，而不是维护一张完整子节点白名单——
 * acorn 的所有节点都满足该形状，白名单只会随着 ECMAScript 版本漂移。
 * `NON_CHILD_KEYS` 里的字段是元数据/脚手架，跳过它们才能避免自引用与无谓遍历。
 *
 * **票据 45 起对外导出**：IIFE 依赖边的判定属于仓库约定（`globalThis[Symbol.for(...)]`、
 * `dsh-expert-group/` 前缀），不适合塞进本模块的通用采集面；因此把"怎么走树"作为
 * 基础件导出，让 `scripts/check-dependency-graph.mjs` 用同一套遍历实现自己的语义。
 *
 * @param {object} root 根节点（通常是 Program）。
 * @param {(node: object, parent: object|null) => void} visit 先序回调。
 */
export function walkAst(root, visit) {
  const stack = [{ node: root, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop();
    if (!node || typeof node.type !== "string") continue;
    visit(node, parent);
    // 逆序压栈：数组子节点按源码顺序被弹出（先序 = 源码顺序）。
    const children = [];
    for (const key of Object.keys(node)) {
      if (NON_CHILD_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && typeof item.type === "string") children.push(item);
        }
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        children.push(value);
      }
    }
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], parent: node });
    }
  }
}

/** acorn 错误的 `line:column`（column 是 0 基，对外报告统一转成 1 基，便于人工定位）。 */
function describeParseError(error) {
  const loc = error?.loc;
  if (loc && Number.isSafeInteger(loc.line) && Number.isSafeInteger(loc.column)) {
    return { line: loc.line, column: loc.column + 1, message: String(error.message ?? error) };
  }
  return { line: 0, column: 0, message: String(error?.message ?? error) };
}

/**
 * 解析源码，返回 acorn AST。
 *
 * 顺序：先 `sourceType: "module"`，失败再 `"script"`。
 * 为什么需要两遍：客户端 sidecar（`client*.js`）是**经典脚本**形态（IIFE + `globalThis`），
 * 而 Host / Shared / Fanout 是 ESM；同一个门禁要覆盖两者，就不能假定单一模式。
 * 顺序不能反过来：script 模式会把 `import` / `export` 直接判成语法错误，
 * 而 module 模式对经典脚本的兼容面更大（顶层 `return` 与 `with` 是仅有的分歧点）。
 *
 * 两种模式都失败 → 抛出**带文件名与行列**的错误（fail-closed）。绝不返回 `null`：
 * "解析器看不懂"和"源码里没有"是两件事，前者必须响亮。
 *
 * **票据 45 补记（多一道 fail-closed 收益）**：acorn 在 module 模式下会校验
 * `export { x }` 引用的绑定必须存在（`Export 'x' is not defined` 是 ECMAScript 的
 * early error）。词法器会把这种源码当成"3 个导出"照单全收，AST 则直接拒绝——
 * 导出名指向不存在的绑定本身就是死代码，拒绝比计数更正确。
 *
 * @param {string} source 源码。
 * @param {string} [file] 文件名（只用于错误定位与 `sourceFile`；可为相对路径）。
 * @returns {object} acorn AST（Program 节点）。
 */
export function parseSource(source, file) {
  const text = typeof source === "string" ? source : String(source ?? "");
  const label = file === undefined || file === null || file === "" ? "<anonymous>" : String(file);
  const failures = [];
  for (const sourceType of SOURCE_TYPE_ORDER) {
    try {
      return acorn.parse(text, { ...PARSE_OPTIONS, sourceType, sourceFile: label });
    } catch (error) {
      failures.push({ sourceType, ...describeParseError(error) });
    }
  }
  // 两种模式都失败：报告两处位置。module 是主口径（绝大多数产品源码是 ESM），
  // script 的信息作为补充——它对经典脚本的失败点往往更有解释力。
  const primary = failures[0];
  const secondary = failures[1];
  const detail = secondary
    ? "（script 模式：第 " + secondary.line + " 行第 " + secondary.column + " 列：" + secondary.message + "）"
    : "";
  const error = new Error(
    "无法解析 " + label + "：第 " + primary.line + " 行第 " + primary.column + " 列："
    + primary.message + detail,
  );
  // 结构化字段：测试与上层报告可以直接读取，不必再解析错误文本。
  error.file = label;
  error.line = primary.line;
  error.column = primary.column;
  error.failures = failures;
  throw error;
}

/** 把一个 key 节点（Identifier / PrivateIdentifier / 字面量 / 静态模板字面量）转成名字；
 * 动态计算键（含插值模板、变量表达式）返回空串——由 `collectCreateDeclarations` 的
 * `dynamicKeys` 单独暴露（票据 46）。 */
function keyNameOf(key) {
  if (!key || typeof key !== "object") return "";
  if (key.type === "Identifier") return key.name;
  // 私有成员：`#createHidden()` → `#createHidden`（与词法器票据 42 的口径一致）。
  if (key.type === "PrivateIdentifier") return "#" + key.name;
  // 字面量键（`"createFoo": () => {}`）：字符串/数字值本身就是名字。
  if (key.type === "Literal" && (typeof key.value === "string" || typeof key.value === "number")) {
    return String(key.value);
  }
  // 票据 46：**无插值**的模板字面量键（`{ [`createForward`]: fn }`）就是静态名字。
  // 为什么是盲区：词法器只认 `"…"` / `'…'`，AST 侧此前只认 Literal，两边都看不见它，
  // 于是"两侧一致的空结果"把 C3 的漏报伪装成了绿灯。
  // 有插值（`{ [`create${suffix}`]: fn }`）的键无法静态定名 → 返回空串，
  // 由 `collectCreateDeclarations` 记入 `dynamicKeys`（票据 46 的 fail-visible 通道）。
  if (key.type === "TemplateLiteral") {
    if (key.quasis.length === 1 && key.expressions.length === 0) {
      const quasi = key.quasis[0];
      // cooked 在含非法转义序列时为 undefined（tagged template 才合法，普通键不会），回退 raw。
      return quasi.value.cooked ?? quasi.value.raw;
    }
    return "";
  }
  return "";
}

/**
 * 函数节点的名字（票据 44 规定的**固定来源顺序**）。
 *
 * 1. `id.name` —— 具名函数声明 / 具名函数表达式；
 * 2. `VariableDeclarator.id.name` —— `const createX = () => {}` 这类绑定；
 * 3. `Property.key.name` —— 对象字面量方法 / 函数值属性（`{ createX: () => {} }`）；
 * 4. `MethodDefinition.key` —— class 方法（`PrivateIdentifier` 记为 `#name`）。
 *
 * 为什么顺序如此：`const createX = function inner() {}` 里 **id 更接近"这个东西叫什么"**
 * （源码作者显式命名的函数），绑定名只是它被挂到哪个变量上；而行数门禁要的是
 * "这个函数本体叫什么"，因此 id 优先。
 *
 * 返回空串表示"匿名"（调用方会显示为 `<anonymous>` 或按 `function` 分类）。
 *
 * @param {object} node 函数节点。
 * @param {object|null} parent 其父节点（由遍历提供）。
 */
function functionNameOf(node, parent) {
  // 1. id.name（含私有方法名不会走这里——class 私有方法的 id 不存在）。
  if (node.id && node.id.type === "Identifier") return node.id.name;
  if (!parent) return "";
  // 2. 变量绑定：`const/let/var NAME = <fn>`。
  if (parent.type === "VariableDeclarator" && parent.init === node
    && parent.id && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  // 3./4. 对象属性 / class 方法（含私有方法 `#name`）。
  if (parent.type === "Property" && parent.value === node) return keyNameOf(parent.key);
  if (parent.type === "MethodDefinition" && parent.value === node) return keyNameOf(parent.key);
  // 票据 44 未列、但语义等价的形态：class 字段的函数值（`class C { createX = () => {} }`）。
  // 记录在此而非沉默跳过——否则"class 字段里的工厂"又是一条看不见的路径。
  if (parent.type === "PropertyDefinition" && parent.value === node) return keyNameOf(parent.key);
  return "";
}

/**
 * 收集全部函数节点（`FunctionDeclaration` / `FunctionExpression` / `ArrowFunctionExpression`）。
 *
 * 每项：`{ name, kind, startLine, endLine, lines, node, parent }`
 * - `kind`：`"declaration" | "expression" | "arrow"`（按节点类型，不按名字猜测）；
 * - `lines`：`endLine - startLine + 1`（**含首尾行**，与行数门禁的跨度口径一致）；
 * - `node` / `parent`：原始 AST 节点（供调用方继续读取参数、方法、注释等）。
 *
 * 顺序：按 `startLine` 升序；同一行内按 `endLine` 降序（外层在前），使
 * "父闭包先于子闭包"的直觉与 `scanFunctionSpans` 一致。
 *
 * @param {object} ast `parseSource` 的返回值。
 * @returns {Array<{name: string, kind: string, startLine: number, endLine: number, lines: number,
 *   node: object, parent: object|null}>}
 */
export function collectFunctionNodes(ast) {
  const nodes = [];
  walkAst(ast, (node, parent) => {
    if (!isFunctionNode(node)) return;
    const startLine = node.loc?.start?.line ?? 0;
    const endLine = node.loc?.end?.line ?? startLine;
    const kind = node.type === "FunctionDeclaration"
      ? "declaration"
      : node.type === "FunctionExpression" ? "expression" : "arrow";
    nodes.push({
      name: functionNameOf(node, parent),
      kind,
      startLine,
      endLine,
      lines: Math.max(endLine - startLine + 1, 0),
      node,
      parent,
    });
  });
  // 先序已是源码顺序；排序只为"同一行内父闭包在前"（结束行更晚的排前面）。
  nodes.sort((left, right) => left.startLine - right.startLine
    || right.endLine - left.endLine);
  return nodes;
}

/**
 * 收集 `create*` 声明（C3 对账的 AST 侧）。
 *
 * **语义对齐现有 C3 收集器**（`collectFactoryDeclarations` 自票据 34/35/36 以来的口径）：
 * - **命名 function 声明**：`function createX()`、`function* createX()`、
 *   `async function* createX()`（任意深度）；
 * - **变量绑定**：`const/let createX = <任意初始值>`（任意深度；数据值 / `null` 注入位也算，
 *   是否算工厂由登记表/例外表裁决）；
 * - **方法**：对象字面量里**函数值**的 `createX` 属性与 class 的 `createX()` 方法
 *   （票据 44 明确列入；词法器的"变量 / function 关键字"两条规则原本看不见它们）。
 *
 * **票据 46：静态模板字面量键**。`{ [`createForward`]: (x) => x }` 的无插值模板键现在能定名
 * 并进入声明清单（此前 `keyNameOf` 只认 Identifier / PrivateIdentifier / Literal，返回空串，
 * 而词法器同样看不见——"两侧一致的空结果"把漏报伪装成了绿灯）。
 *
 * **票据 46：动态计算键**。有插值模板（`[`create${suffix}`]`）与变量表达式（`[expr]`）无法
 * 静态定名，**不静默略过**：它们进 `dynamicKeys`（`{ file, line, raw }`），由 C3 对账打印
 * 告警（不进违规——运行期才知道是不是工厂，但"看不见"必须变成"看得见的不确定"）。
 * 只登记**声明形态**（函数值属性 / class 方法 / class 函数值字段）的动态键：数据属性
 * （`{ [expr]: 5 }`）本来就不是声明，登记它只会制造噪音。
 *
 * 与词法器的两处**有意差异**（都在返回值里如实体现，不做静默归一）：
 * 1. 每个函数节点只产生**一条**记录：`const createA = function createB() {}` 在词法器里
 *    会同时命中"function createB("与"const createA ="，产生两条；AST 侧按节点记账，
 *    `createB` 记 `function`、声明符名 `createA` 记 `variable`——两者都真实存在，不算重复。
 * 2. 对象字面量的**非函数**属性（`{ createTaskFilter }` 这种引用式简写、
 *    `{ createdAt: 5 }` 这种数据属性）不算声明：它们是引用/数据，不是"用 create 命名的声明"。
 * 3. `for (const createX of …)` / `for (const createX in …)` 这类**循环绑定**会被收集为
 *    `variable`：它们是真实声明，词法器因为要求名字后面紧跟 `=` 而看不见。
 *
 * @param {object} ast `parseSource` 的返回值。
 * @param {string} [file] 文件名（写入每条记录，供对账按键 `file\0name` 去重）。
 * @param {{source?: string}} [options] 传入原文时可为 `dynamicKeys` 提供 `raw` 片段；
 *   不传也能收集声明，只是动态键的 `raw` 为空串。
 * @returns {{declarations: Array<{file: string, name: string, line: number,
 *   kind: "function"|"variable"|"method"}>,
 *   dynamicKeys: Array<{file: string, line: number, raw: string}>}}
 *   声明清单按 (line, name) 排序；动态键按 (line, raw) 排序。
 */
export function collectCreateDeclarations(ast, file, options = {}) {
  const label = file === undefined || file === null || file === "" ? "<anonymous>" : String(file);
  const source = typeof options.source === "string" ? options.source : null;
  const declarations = [];
  /** 无法静态定名的计算属性键（票据 46）：只由声明形态登记，供 C3 告警。 */
  const dynamicKeys = [];
  /**
   * 登记一条声明。
   *
   * `matchName` 与 `name` 分开是**私有方法**的需要：私有方法的对外名字是 `#createHidden`
   * （与跨度统计同一口径），但按 C3 的「名字以 create 开头」判据应当**去掉前导 # 再匹配**——
   * 否则 `#createHidden` 这类真工厂会因为前缀符被静默排除，正是票据 44 要消灭的盲区。
   */
  const push = (name, kind, line, matchName = name) => {
    if (!CREATE_NAME_PATTERN.test(matchName)) return;
    declarations.push({ file: label, name, line, kind });
  };
  /** 私有方法名 `#createX` → 匹配用 `createX`；其它形态原样返回。 */
  const matchNameOfMethod = (name) => (name.startsWith("#") ? name.slice(1) : name);
  /**
   * 计算键是否**静态可定名**：非 computed，或 computed 但键是字面量 / 无插值模板字面量。
   *
   * 为什么 `[WRITE_SET]` 这类计算标识符也算"动态"：它的运行期值是那个常量的**值**
   * （可能是 Symbol，也可能是字符串 "createX"），静态上只知道"键表达式叫 WRITE_SET"。
   * C3 需要的是**声明名**，不是表达式名——把表达式名当成声明名会同时造成两种错误：
   * 假阴性（`[KEY]` 运行期是 createX 却看不见）与假阳性（`{ [createX]: … }` 被当成
   * 名为 createX 的声明）。因此这里只认"字面量 / 无插值模板"。
   */
  const isStaticKey = (owner) => {
    if (owner.computed !== true) return true;
    const key = owner.key;
    if (!key) return false;
    if (key.type === "Literal") return typeof key.value === "string" || typeof key.value === "number";
    if (key.type === "TemplateLiteral") return key.quasis.length === 1 && key.expressions.length === 0;
    return false;
  };
  /** 登记一个无法静态定名的计算属性键（票据 46）：`raw` 取原文切片首行，便于人工复核。 */
  const pushDynamicKey = (owner) => {
    const key = owner.key;
    const line = key?.loc?.start?.line ?? owner?.loc?.start?.line ?? 0;
    const raw = source && Number.isSafeInteger(key?.start) && Number.isSafeInteger(key?.end)
      ? source.slice(key.start, key.end).split("\n")[0]
      : "";
    dynamicKeys.push({ file: label, line, raw });
  };
  /**
   * 声明形态的成员（对象字面量函数值属性 / class 方法 / class 函数值字段）：
   * 静态键 → 声明；动态键 → `dynamicKeys`。两条路径都"看得见"，只是后者无法定名。
   */
  const pushMember = (owner) => {
    if (!isStaticKey(owner)) {
      pushDynamicKey(owner);
      return;
    }
    const name = keyNameOf(owner.key);
    push(name, "method", owner.key?.loc?.start?.line ?? 0, matchNameOfMethod(name));
  };

  walkAst(ast, (node, parent) => {
    // ── 变量绑定：声明符名字才是"声明的名字" ────────────────────────────────
    // 任意初始值都算（对齐词法器 `const|let createX =` 的超集口径）。
    // `var` 也被收集：词法器只认 const/let 是它的口径缺口，AST 侧没有理由跟着漏。
    if (node.type === "VariableDeclarator" && node.id && node.id.type === "Identifier") {
      push(node.id.name, "variable", node.id.loc?.start?.line ?? 0);
      return;
    }
    if (!isFunctionNode(node)) return;
    // ── 具名函数：function 声明与具名函数表达式同口径 ──────────────────────
    const hasOwnCreateName = node.id && node.id.type === "Identifier" && CREATE_NAME_PATTERN.test(node.id.name);
    if (hasOwnCreateName) {
      push(node.id.name, "function", node.loc?.start?.line ?? 0);
      // 具名函数表达式同时被变量绑定（`const createA = function createB() {}`）时，
      // 声明符侧由上面的 VariableDeclarator 分支负责，两条都真实存在。
      return;
    }
    // 变量绑定形态：裸箭头 / 匿名函数表达式的名字来自声明符，已由 VariableDeclarator 记过。
    if (parent && parent.type === "VariableDeclarator" && parent.init === node) return;
    // ── 方法形态：对象字面量函数值属性 / class 方法 / class 函数值字段 ──────
    // 三者的键规则完全一致：静态键（含无插值模板）→ 声明；动态键 → dynamicKeys 告警。
    if (parent && ((parent.type === "Property" && parent.value === node)
      || (parent.type === "MethodDefinition" && parent.value === node)
      || (parent.type === "PropertyDefinition" && parent.value === node))) {
      pushMember(parent);
    }
  });

  declarations.sort((left, right) => {
    if (left.line !== right.line) return left.line - right.line;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  dynamicKeys.sort((left, right) => left.line - right.line
    || (left.raw < right.raw ? -1 : left.raw > right.raw ? 1 : 0));
  return { declarations, dynamicKeys };
}

/** import 说明符的 `imported` 名字：default → "default"，命名空间 → "*"，其余取 imported。 */
function importedNameOf(specifier) {
  if (specifier.type === "ImportDefaultSpecifier") return "default";
  if (specifier.type === "ImportNamespaceSpecifier") return "*";
  const imported = specifier.imported;
  if (!imported) return "";
  return imported.type === "Identifier" ? imported.name : String(imported.value ?? "");
}

/** export 说明符的 `exported` 名字（`export { x as y }` 里的 y）。 */
function exportedNameOf(specifier) {
  const exported = specifier.exported;
  if (!exported) return "";
  return exported.type === "Identifier" ? exported.name : String(exported.value ?? "");
}

/** 声明节点上被导出的名字（`export const a = 1, b = 2` → ["a","b"]）。 */
function declaredNamesOf(declaration) {
  if (!declaration) return [];
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations
      .map((declarator) => (declarator.id && declarator.id.type === "Identifier" ? declarator.id.name : ""))
      .filter((name) => name !== "");
  }
  if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
    return declaration.id && declaration.id.type === "Identifier" ? [declaration.id.name] : [];
  }
  return [];
}

/**
 * 收集**静态** import / export 说明符（供 C1 / C2 / C4 / C8 使用）。
 *
 * 只处理顶层静态形态（`import` / `export ... from` / `export *` / `export default`）；
 * 动态 `import()` 不由本函数负责（它属于 C1 的"非字面量动态 import"判据，词法器侧已有
 * 独立证据）。返回值是**扁平的记录数组**，每条都带 `line`，便于门禁把违规钉到行：
 *
 * - `{ type: "import", source, line, specifiers: [{ imported, local }] }`
 * - `{ type: "export-named", source, line, specifiers: [{ imported, exported }] }`（`from` 再导出）
 * - `{ type: "export-local", source: null, line, exported: [名字...] }`（本地导出，无来源）
 * - `{ type: "export-all", source, line, exported: 名字|null }`（`export * [as ns] from`）
 * - `{ type: "export-default", source: null, line, exported: 名字|null }`
 *
 * @param {object} ast `parseSource` 的返回值。
 * @returns {Array<object>}
 */
export function collectModuleSpecifiers(ast) {
  const records = [];
  walkAst(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      records.push({
        type: "import",
        source: String(node.source?.value ?? ""),
        line: node.loc?.start?.line ?? 0,
        specifiers: node.specifiers.map((specifier) => ({
          imported: importedNameOf(specifier),
          local: specifier.local?.name ?? "",
        })),
      });
      return;
    }
    if (node.type === "ExportNamedDeclaration") {
      const line = node.loc?.start?.line ?? 0;
      if (node.source) {
        records.push({
          type: "export-named",
          source: String(node.source.value ?? ""),
          line,
          specifiers: node.specifiers.map((specifier) => ({
            imported: specifier.local?.name ?? "",
            exported: exportedNameOf(specifier),
          })),
        });
        return;
      }
      // 本地导出：`export { a, b as c }` 与 `export const x = 1` / `export function f() {}` 两种。
      const exported = [];
      for (const specifier of node.specifiers) exported.push(exportedNameOf(specifier));
      for (const name of declaredNamesOf(node.declaration)) exported.push(name);
      records.push({ type: "export-local", source: null, line, exported });
      return;
    }
    if (node.type === "ExportAllDeclaration") {
      const exported = node.exported
        ? (node.exported.type === "Identifier" ? node.exported.name : String(node.exported.value ?? ""))
        : null;
      records.push({
        type: "export-all",
        source: String(node.source?.value ?? ""),
        line: node.loc?.start?.line ?? 0,
        exported,
      });
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      const exported = declaration && declaration.id && declaration.id.type === "Identifier"
        ? declaration.id.name
        : null;
      records.push({
        type: "export-default",
        source: null,
        line: node.loc?.start?.line ?? 0,
        exported,
      });
    }
  });
  return records;
}


/**
 * 收集**动态** `import(…)` 调用（票据 45 新增；供 C1 的「动态 import 必须是字面量」判据）。
 *
 * 为什么独立于 `collectModuleSpecifiers`：那个导出只处理**静态** import/export 说明符，
 * 而动态 import 是表达式、可能出现在任意深度（函数体、三元、数组元素），语义也不同
 * （它可以不是字面量）。把它混进静态记录会让"静态边"与"动态边"两个判据的输入分不清。
 *
 * 返回 `[{ specifier, raw, line }]`：
 * - 字面量参数 → `specifier` 是字符串值、`raw` 为 null；
 * - 非字面量参数 → `specifier` 为 null、`raw` 是**实参原文片段**（仅传入 `options.source` 时
 *   可取到；AST 本身不携带原文）——C1 据此报 fail-closed，而不是把这条依赖静默丢掉。
 *
 * @param {object} ast `parseSource` 的返回值。
 * @param {{source?: string}} [options] 传入原文时可给出非字面量参数的原始文本。
 * @returns {Array<{specifier: string|null, raw: string|null, line: number}>}
 */
export function collectDynamicImports(ast, options = {}) {
  const source = typeof options.source === "string" ? options.source : null;
  const records = [];
  walkAst(ast, (node) => {
    if (node.type !== "ImportExpression") return;
    const argument = node.source;
    const line = node.loc?.start?.line ?? 0;
    if (argument && argument.type === "Literal" && typeof argument.value === "string") {
      records.push({ specifier: argument.value, raw: null, line });
      return;
    }
    // 非字面量：原文片段只取首行（多行表达式在报告里会撑坏一行一条的格式）。
    const raw = source && Number.isSafeInteger(argument?.start) && Number.isSafeInteger(argument?.end)
      ? source.slice(argument.start, argument.end).split("\n")[0]
      : "";
    records.push({ specifier: null, raw, line });
  });
  // 按行号排序：报告与对账输出必须可复现（遍历顺序已是源码顺序，这里显式钉死）。
  records.sort((left, right) => left.line - right.line);
  return records;
}

/**
 * 收集 `Symbol.for("<字面量>")` 调用。
 *
 * 为什么单独抽出来：客户端 IIFE 之间用 `globalThis[Symbol.for("dsh-expert-group/xxx")]`
 * 交换模块，这条**全局键就是依赖边**。词法器（`scanIifeGlobalUsage`）用正则找这些键，
 * 一旦写成拼接/模板/变量（`Symbol.for(PREFIX + name)`），边会静默消失——票据 38 因此
 * 引入 fail-closed。AST 侧把"字面量键"与"非字面量参数"分成两个桶，后者供上层报违规。
 *
 * 返回：
 * - `keys`：`[{ value, line, start, end }]`，按出现顺序；`start`/`end` 是**调用表达式**
 *   在原文中的区间（票据 45 补充：上层要按节点位置把"字面量键"关联回它的使用点）；
 * - `unresolved`：`[{ raw, line, start, end }]`，`raw` 仅在传入 `options.source` 时非空
 *   （AST 不携带原文，切片需要原文）；此处的 `start`/`end` 是**实参表达式**的区间。
 *
 * @param {object} ast `parseSource` 的返回值。
 * @param {{source?: string}} [options] 传入原文时可给出非字面量参数的原始文本（报错定位用）。
 */
export function collectSymbolForCalls(ast, options = {}) {
  const source = typeof options.source === "string" ? options.source : null;
  const keys = [];
  const unresolved = [];
  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (!callee || callee.type !== "MemberExpression" || callee.computed) return;
    if (!callee.object || callee.object.type !== "Identifier" || callee.object.name !== "Symbol") return;
    if (!callee.property || callee.property.type !== "Identifier" || callee.property.name !== "for") return;
    const argument = node.arguments[0];
    const line = node.loc?.start?.line ?? 0;
    // 字面量键：只有字符串字面量才是可静态解析的键（数字等其它字面量不是 Symbol 语义）。
    if (argument && argument.type === "Literal" && typeof argument.value === "string") {
      keys.push({ value: argument.value, line, start: node.start, end: node.end });
      return;
    }
    unresolved.push({
      raw: source && Number.isSafeInteger(argument?.start) && Number.isSafeInteger(argument?.end)
        ? source.slice(argument.start, argument.end)
        : "",
      line,
      start: argument?.start ?? node.start ?? 0,
      end: argument?.end ?? node.end ?? 0,
    });
  });
  return { keys, unresolved };
}
