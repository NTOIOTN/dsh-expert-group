/**
 * 轻量 JavaScript 词法扫描器（只服务模块行数门禁，不是通用解析器）。
 *
 * 为什么自己写：仓库的 node_modules 里没有 acorn / espree / typescript 之类的 JS 解析器，
 * 而门禁脚本属于「仅构建/测试工具」，不允许为此新增依赖（见规格书 §文件登记）。因此这里
 * 实现一个**够用且可复核**的扫描器：它不构建完整 AST，只做两件事——
 *   1. 把注释 / 字符串 / 模板串 / 正则字面量**等长遮蔽**成空格（换行与下标完全不变）；
 *   2. 在遮蔽串上做括号配对，定位函数声明、方法、箭头函数的花括号跨度。
 *
 * ## 遮蔽为什么必须等长
 * 违规项要报「文件:行」。只有让遮蔽串的每个下标与原文一一对应、且换行位置不变，
 * 才能把遮蔽串上算出来的跨度直接映射回原文件行号，而不需要额外的偏移表。
 *
 * ## 模板插值（票据 37：只遮蔽文本段，插值内部按代码递归扫描）
 * 模板字面量**不再整段遮蔽**：文本段（含定界反引号与 `${`）照旧等长抹成空格，
 * 而 `${` … `}` 插值内部按**普通代码递归扫描**——插值里的注释 / 字符串 / 正则 /
 * 嵌套模板仍被遮蔽，可执行代码则保留下来。因此插值里真正的 `create*` 声明能被 C3 的
 * 收集器看见（旧实现把插值整段抹掉，等于给「源码声明 − 登记 ∪ 例外」的差集开了一条
 * 越狱通道：插值里的工厂既不进清单、也不进差集）。
 *
 * 插值的收尾**不靠猜**：递归的代码扫描自己维护花括号深度，只有与 `${` 配对的
 * `}` 才收尾；字符串、嵌套模板、注释与正则都在配对过程中被整体跳过，所以插值里出现
 * `}`、反引号、引号或正则都不会让它提前收尾。
 *
 * ## 已知边界
 * - 模板**文本段**里的写法一律不参与代码判定（伪声明零收集）；
 * - 正则字面量判定（票据 42 反转）：**默认按正则处理**，只有「前一个 token 是值结尾」
 *   时才按除号处理。值结尾 = `OPERAND_EXPECTING_KEYWORDS` 之外的标识符、数字 / 字符串 /
 *   模板 / 正则字面量、`)`、`]`、`}`、后缀 `++` / `--`。
 *   **为什么反转**：票据 38/41 的白名单路线是长尾——`return` / `typeof` 补完，
 *   oracle 第九轮又用合法 JS 的 `throw /[}]/` 复现漏报（`do` / `else` / `for await` /
 *   普通块之后同理）。白名单要穷举「哪些位置允许正则」，而**除号只出现在值之后**
 *   是更小的集合：反转后这些写法自动落入默认允许，不需要再逐个补关键字。
 *   保留票据 41 的**控制条件右括号例外**：`if` / `for` / `while` / `switch` / `catch` /
 *   `with`（含 `for await`）后面那个 `(` 配对的 `)` 之后是语句起始位置，允许正则。
 *   判定靠**圆括号上下文栈**，而不是把 `)` 一律当非值——否则 `(a + b) / c`、
 *   `foo() / bar` 的除号会被当正则，双斜杠写法（`/ c / d`）被整段吞掉（错误遮蔽）。
 * - **`}` 之后的取舍（票据 43）**：对象字面量之后是除号，块 / 类体 / static 块之后是
 *   正则，两者都真实存在。票据 42 只按「`}` 是值结尾」一律当除号，于是「`}` 之后的正则」
 *   在插值内部会提前收尾；当被截断的前缀**仍然配平**时（`class { static { {} /}}}` 这类），
 *   结构校验不触发、收集器**静默返回空集**。票据 43 改为在 `{` 处登记上下文、在 `}`
 *   出栈时判定（见下面 `## 花括号上下文栈（票据 43）`）。
 * - 计算属性名方法（`[Symbol.iterator]() {}`）、对象字面量里的属性值箭头（`foo: () => {}`）
 *   只在能推出名字时才计入；无法推出名字的匿名函数以 `<anonymous>` 上报。
 * - 表达式体箭头（`x => x + 1`）的跨度用「括号配平 + 语句边界」近似（票据 38，见
 *   `findExpressionEnd`）：覆盖数组 / 对象 / 链式调用 / 三元表达式，但**跨多行的模板文本
 *   体**（`() => \`…\``）在文本段被遮蔽后可能只算到第一行——仍是「少报」，不会错报。
 *   表达式体箭头计入函数总数与「单闭包内函数数」，口径与块体箭头一致。
 *
 * ## 结构完整性 fail-closed（票据 42）
 * `maskJavaScriptSource` 返回前对**遮蔽后仍可见的代码区**做 `{}` / `()` / `[]` 配平校验
 * （被遮蔽的文本段已抹成空格，天然不参与）。正则 / 模板判定失准的最典型后果就是
 * 「正则里的 `}` 被当代码」或「代码被当文本」，两者都会打破配平——现在直接抛错并
 * 指出文件与行号，而不是让门禁拿到一份少了声明的遮蔽串后依然全绿。
 * 已知不覆盖的方向：插值**提前收尾**时，被截断的前缀本身仍可能配平（`throw /[}]/` 的
 * 旧复现就属于这一类），那一类靠反转判定消除、靠消费者级用例（C3 声明收集）兜住。
 * 票据 43 又堵了两条**配平型**漏报：`async` 被当非值关键字（见
 * `## 上下文关键字 async（票据 43）`）与 `}` 一律按除号（见
 * `## 花括号上下文栈（票据 43）`）。
 *
 * ## 上下文关键字 async（票据 43）
 * `async` **不是**无条件的关键字：`let async = 20; async / 3` 里它是普通标识符。
 * 旧实现把它放进非值表，`async /` 于是被判成正则起始：同一行内存在第二个 `/` 时，
 * 两者之间的代码（例如整个函数体）被整段遮蔽——而前缀仍可能配平，fail-closed 不触发，
 * 收集器静默返回空集。实测口径：**单行**写法 `async / function helper() { function
 * createHidden() {} } / 3` 在旧实现里 collect=[]；多行写法因为 `findRegexEnd` 找不到
 * 同行收尾只吞一个斜杠，声明侥幸留下（仍属误遮蔽，只是没漏报）。票据 43 后两种排版都正确。
 *
 * 现在的判定（见 `asyncIntroducesFunctionOrArrow`）：只有当 `async` 后面紧跟
 * `function` 或 `(`（即 `async function` / `async (…) =>`）时才按「非值」处理，
 * 其余位置（后跟 `/`、运算符、`)`、`,` 等）一律按**值结尾**（标识符）处理 → 除号。
 * 成员访问后的 `async`（`obj.async / 2`）本来就走「属性名是值」那条路，不受影响。
 *
 * ## 花括号上下文栈（票据 43）
 * `}` 之后既可能是除号（对象字面量结束）也可能是正则（块 / 类体 / static 块结束），
 * 只靠「`}` 是值结尾」无法区分。扫描器因此维护一个**花括号上下文栈**：遇到可见 `{`
 * 时按前一个 token 判定它属于哪一类，并把布尔值压栈；配对的 `}` 出栈时把该布尔值挂在
 * `}` token 的 `closesBlockBody` 上，供 `isValueEndToken` 判定其后是正则还是除号。
 *
 * - **块 / 类体**（`}` 之后是语句位置 → **允许正则**）：前一个 token 是 `)`、`else`、
 *   `try`、`finally`、`do`、`=>`（在 token 流里是 `=` + `>`，故按 `>` 判）、
 *   `;`、`{`、`}`、块类关键字（`class`、`static`、`switch` …）或文件 / 插值起始；
 * - **对象字面量**（`}` 之后是表达式位置 → **除号**）：前一个 token 是 `=`、`(`、`[`、
 *   `,`、`:`、`return`、运算符等；
 * - **无法确定时取「块」（允许正则）**：这条路的失败是 loud 的（误把除法当正则时，正则
 *   找不到同行收尾只吞一个斜杠，双斜杠写法则会破坏配平 → 抛错；或产生幻影声明 → C3 对账
 *   报红），而取「除号」的失败是**静默**的（本次修复的两个反例）。**宁可炸，不可静默漏。**
 *
 * 已知取舍（都写进测试）：
 * - `=>` 同时出现在块侧与对象侧清单里：直接跟在 `=>` 后面的 `{` 只能是**块体**
 *   （对象字面量必须写成 `=> ({`），故归「块」；
 * - **表达式形态**的 `class {}` / `function () {}` 的 `}` 同样按「块」处理（`{` 前的
 *   token 是 `)` 或类名 / `class`）：`const C = class {} / 2`、`const f = function () {} / 2`
 *   这类写法会被当正则起始。代价是单个斜杠被抹掉（操作数仍在），属于「宁可炸」的一侧；
 * - `case x: {` / `default: {` 的 `{` 前是 `:`（对象侧），会被判成对象字面量：
 *   同样只影响「`}` 紧跟 `/`」这一个判定，`/` 找不到同行收尾时只吞一个斜杠。
 *
 * ## 函数跨度口径
 * - `function name(...) { ... }`（含 async / generator / 匿名函数表达式）；
 * - 方法：`name(...) { ... }`，要求前面是 `{`、`,`、`;`、`}`、`)` 或
 *   `static`/`async`/`get`/`set`/`*` 这类修饰符，且名字不是控制流关键字
 *   （if / for / while / switch / catch / with ...），也不是 `obj.name(` 这种调用；
 * - **私有方法**（票据 42）：`#name(...) { ... }`，同上规则；`#field = …` 赋值与
 *   `this.#name()` 调用不算方法（名字以 `#` 前缀上报，例如 `#createHidden`）；
 * - 箭头函数：`(...) => { ... }` 与 `x => { ... }`，只统计**带花括号体**的。
 * - 行数按起止行号跨度计（含首尾行）。
 */

/** 逻辑行计数：\n 的个数；末尾无换行时末行同样计入（即 `wc -l` + 1 的口径）。 */
export function countLogicalLines(source) {
  let newlines = 0;
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) === 10) newlines++;
  }
  if (source.length > 0 && !source.endsWith("\n")) newlines++;
  return newlines;
}

/**
 * 票据 42：**值结尾**判定里唯一的「例外表」——这些词是关键字 / 运算符 / 语句头，
 * 它们之后只能开始一个新表达式或新语句，因此**不是**值结尾（`/` 默认按正则处理）。
 *
 * 为什么用「非值关键字表」而不是「允许正则的关键字表」：反转之后默认允许，
 * 只有标识符是值结尾时才需要逐个判断；而标识符里只有关键字不是值，
 * 于是枚举成本从「所有可能允许正则的位置（长尾）」缩小到「JS 关键字全集（封闭）」。
 *
 * 注意 `this` / `super` / `true` / `false` / `null` / `undefined` **不在**本表：
 * 它们本身就是值，其后紧跟的 `/` 是除号。
 * `get` / `set` / `static` / `of` / `from` / `as` 是上下文关键字，
 * 只影响方法修饰符位置；把它们当「非值」不会造成误吞（`obj.of / 2` 会先被成员访问判成值）。
 *
 * 票据 43：`async` **已从本表移出**。它是上下文关键字，只有 `async function` /
 * `async (…) =>` 才按非值处理；`let async = 20; async / 3` 里它是标识符，其后是除号。
 * 无条件把 `async` 当非值会让 `async / function helper() { … } / 3` 的斜杠被判成正则；
 * 同一行内出现第二个 `/` 时函数体整段被遮蔽，且**前缀仍然配平**（结构性 fail-closed
 * 看不见），收集器静默返回空集（实测：单行写法 old collect=[]）。
 * 上下文判定见 `asyncIntroducesFunctionOrArrow`（被 `previousEndsValue` 调用）。
 */
const OPERAND_EXPECTING_KEYWORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "export", "extends", "finally", "for", "function", "if",
  "import", "in", "instanceof", "let", "new", "return", "static", "switch", "throw",
  "try", "typeof", "var", "void", "while", "with", "yield", "await",
  "get", "set", "of", "from", "as",
]);

/**
 * 票据 42：判断一个 token 是否是「值结尾」——只有它是值结尾时，紧跟的 `/` 才是除号。
 *
 * 为什么要按 token 而不是前一个字符：`return /[}]/` 的 `/` 前一个字符是字母 `n`，
 * 只看字符会判成除号，正则里的 `}` 随即被当代码，插值提前收尾、其后的声明被遮蔽。
 * 反转成「默认允许」后，`throw` / `do` / `else` / `for await` / 块之后都不需要单独登记。
 *
 * 票据 43：`}` 不再是**无条件**值结尾——它是否算值取决于配对 `{` 的上下文
 * （块 / 类体之后是语句位置 → 允许正则；对象字面量之后是表达式位置 → 除号）。
 * 该布尔值由 `scanCodeRange` 的花括号上下文栈在出栈时写到 token 的
 * `closesBlockBody` 上；缺省（未写）按「块」处理，即允许正则（宁可 loud 不可静默）。
 *
 * @param {{kind: string, value: string, memberAccess?: boolean, prefix?: boolean,
 *   closesBlockBody?: boolean}|null} token
 */
function isValueEndToken(token) {
  if (token === null || token === undefined) return false;
  // 数字 / 字符串 / 模板 / 正则字面量都是操作数：其后是除号。
  if (token.kind === "literal") return true;
  if (token.kind === "punctuator") {
    if (token.value === "}") return token.closesBlockBody !== true;
    if (token.value === ")" || token.value === "]") return true;
    // 后缀 ++/-- 的表达式仍然是值；前缀 ++/-- 之后才是新的操作数。
    if (token.value === "++" || token.value === "--") return token.prefix !== true;
    return false;
  }
  // 成员访问里的属性名一律是值：`obj.return / 2` 的 return 不是关键字。
  if (token.memberAccess === true) return true;
  return !OPERAND_EXPECTING_KEYWORDS.has(token.value);
}

/**
 * 票据 41：这些控制关键字后面的 `(` 是**语句头部条件**，其配对 `)` 之后是
 * **语句起始位置**（允许正则）。
 *
 * 票据 42 的「默认允许」让普通 `)`（表达式 / 调用）只能按值结尾处理；只有这里的
 * 控制条件 `)` 被排除在值结尾之外。为什么不用字符白名单一律放行 `)`：`)` 本身不
 * 携带"闭合的是条件还是表达式"的信息，一律放行会把 `(a + b) / c`、`foo() / bar` 的
 * 除号当成正则——双斜杠写法（`/ c / d`）被整段吞掉，连后面的声明一起消失（错误遮蔽）。
 *
 * 只收这六个关键字：它们在语法上**只能**以 `(` 引出条件，且条件 `)` 之后必然开始
 * 一条新语句。`do` / `else` 之后没有条件括号，故不在列（票据 42 起它们靠默认允许
 * 覆盖）。`for await (` 由 `opensControlCondition` 里额外的两 token 判定处理。
 */
const CONTROL_CONDITION_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

/**
 * 票据 43：`{` 前一个 token 是这些**标点**时，`{` 必然开始**块 / 类体 / 静态块**
 * （其配对 `}` 之后是**语句位置** → 允许正则）。
 *
 * - `)`：`if (x) {`、`function f() {`、`class A { m() {`——条件 / 参数表 / 方法签名之后；
 * - `;` / `{` / `}`：语句序列中的普通块；
 * - `>`：即 `=>` 的第二个 token（`=` 与 `>` 是两个 token）。**箭头函数的 `{` 只能是
 *   块体**（对象字面量必须写成 `=> ({`，那时 `{` 前一个是 `(`），故归块侧。
 */
const BLOCK_OPENING_PUNCTUATORS = new Set([")", ";", "{", "}", ">"]);

/**
 * 票据 43：`{` 前一个 token 是这些**标点**时，`{` 是**对象字面量**
 * （其配对 `}` 之后是**表达式位置** → 除号）。
 *
 * 覆盖赋值、实参 / 数组元素、属性值、三元分支与各类运算符之后。
 * 注意 `/`：`a / {}` 不合法，但正则之后的对象同理按表达式处理，归入本侧无害。
 */
const OBJECT_LITERAL_OPENING_PUNCTUATORS = new Set([
  "=", "(", "[", ",", ":", "?", "+", "-", "*", "%", "&", "|", "^", "!", "~", "<", "/",
]);

/**
 * 票据 43：`{` 前一个 token 是这些**关键字**时，`{` 是对象字面量
 * （`return {` / `throw {` / `x = typeof {}` … 其后都是表达式）。
 *
 * 只列「后面必然跟表达式」的关键字；`class` / `static` / `else` / `try` / `do`
 * / `finally` 等块侧关键字**不在**本表，因此落入下面的「默认块」分支。
 */
const OBJECT_LITERAL_OPENING_KEYWORDS = new Set([
  "return", "typeof", "delete", "void", "new", "in", "instanceof", "of", "await",
  "yield", "throw", "case", "extends", "default",
]);

/**
 * 票据 43：`async` 是否为**修饰符**（而非标识符）——只有 `async function` 与
 * `async (…) =>` 两种形态才按「非值」处理，其余位置按值结尾处理（其后 `/` 是除号）。
 *
 * `from` 是「当前判定的位置」（`/` 或 `++` / `--` 的下标），先跳过空白与注释，
 * 再看下一个记号：整词 `function` 或 `(` 才算修饰符。`async / 3` 在这里读到 `/`
 * → 返回 false → 按标识符（值结尾）→ 除号。
 *
 * 为什么不能只写「`async` 一律按值」：`async function f() {}` 之后若紧跟 `/`，
 * 前一个 token 会是 `}` 而不是 `async`，所以本函数只在「`/` 紧贴 `async`」时才有
 * 判别作用；保留 `function` / `(` 的判定是为了让规则与语义一致，并覆盖 `++` / `--`
 * 前缀判定的同类路径。
 *
 * @param {string} source 原文（未被遮蔽，注释 / 空白要原样跳过）。
 * @param {number} from 判定起点（通常是 `/` 的下标）。
 * @returns {boolean} true 表示 `async` 后面紧跟 `function` 或 `(`。
 */
function asyncIntroducesFunctionOrArrow(source, from) {
  let cursor = from;
  while (cursor < source.length) {
    const character = source[cursor];
    if (isWhitespaceAt(source, cursor)) { cursor++; continue; }
    // 块注释整体跳过：`async /* 修饰符 */ function`。
    if (character === "/" && source[cursor + 1] === "*") {
      cursor += 2;
      while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor++;
      cursor = Math.min(cursor + 2, source.length);
      continue;
    }
    // 行注释：跳到行尾（换行本身由上面的空白分支处理）。
    if (character === "/" && source[cursor + 1] === "/") {
      while (cursor < source.length && source[cursor] !== "\n") cursor++;
      continue;
    }
    break;
  }
  if (cursor >= source.length) return false;
  if (source[cursor] === "(") return true;
  if (!isIdentifierStartAt(source, cursor)) return false;
  return readIdentifierForward(source, cursor).value === "function";
}

/** 这些名字后面跟 `(` 时不是方法定义，而是控制流/运算符表达式。 */
const NON_METHOD_NAMES = new Set([
  "if", "for", "while", "switch", "catch", "with", "return", "typeof", "instanceof",
  "new", "delete", "void", "in", "of", "do", "else", "case", "yield", "await", "throw",
  "function", "class", "import", "export", "extends", "super", "this", "try", "finally",
]);

/** 这些关键字只是方法的修饰符，出现时仍应把后面的 `name(` 当作方法。 */
const METHOD_MODIFIERS = new Set(["static", "async", "get", "set"]);

const ID_START_REGEX = /[\p{ID_Start}$_]/u;
const ID_PART_REGEX = /[\p{ID_Continue}$\u200c\u200d]/u;

/** ASCII 快路径：避免对每个字符都跑一次 Unicode 正则。 */
function isIdentifierStartAt(text, index) {
  const code = text.charCodeAt(index);
  if (code < 128) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;
  }
  return ID_START_REGEX.test(text[index]);
}

function isIdentifierPartAt(text, index) {
  const code = text.charCodeAt(index);
  if (code < 128) {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 36 || code === 95;
  }
  return ID_PART_REGEX.test(text[index]);
}

function isWhitespaceAt(text, index) {
  const code = text.charCodeAt(index);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isDigitAt(text, index) {
  const code = text.charCodeAt(index);
  return code >= 48 && code <= 57;
}

/**
 * 数字字面量（票据 42）。为什么要单独读：`10 / 2` 里的 `/` 也必须判成除号。
 * 不读数字时数字字符会退化成一个个标点 token，默认允许的规则就会把 `/ 2` 当正则起始，
 * 同一行再出现一个 `/` 时整段被吞（`const r = 10 / 2 / 5`）。
 *
 * 用 sticky 正则一次吃掉整段：十进制（含小数 / 指数 / `_` 分隔符 / `n` 后缀）与
 * `0x` / `0b` / `0o`。读不出时只前进 1，避免死循环。
 */
const NUMBER_LITERAL_PATTERN =
  /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?\d[\d_]*)?)n?/y;

function readNumberLiteral(text, index) {
  NUMBER_LITERAL_PATTERN.lastIndex = index;
  const match = NUMBER_LITERAL_PATTERN.exec(text);
  if (match === null) return index + 1;
  return index + match[0].length;
}

function skipWhitespaceForward(text, index) {
  let cursor = index;
  while (cursor < text.length && isWhitespaceAt(text, cursor)) cursor++;
  return cursor;
}

function skipWhitespaceBackward(text, index) {
  let cursor = index;
  while (cursor >= 0 && isWhitespaceAt(text, cursor)) cursor--;
  return cursor;
}

/** 从引号开始跳到闭合引号之后；未闭合（遇到换行）时停在换行处，避免吞掉后续代码。 */
function findQuotedEnd(source, index) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") { cursor += 2; continue; }
    if (character === quote) return cursor + 1;
    if (character === "\n") return cursor;
    cursor++;
  }
  return source.length;
}

/** 等长遮蔽一个区间：[from, to) 内的字符换成空格，但保留 \n / \r（下标映射不变）。 */
function blankRange(source, masked, from, to) {
  const end = Math.min(to, masked.length);
  for (let index = Math.max(from, 0); index < end; index++) {
    const character = source[index];
    if (character !== "\n" && character !== "\r") masked[index] = " ";
  }
}

/**
 * 递归扫描并遮蔽一段**代码**（文件顶层，或模板插值内部）。
 *
 * 票据 37 的关键改动：模板字面量不再整段遮蔽，${ … } 插值内部重新进入本函数按普通代码
 * 扫描——插值里的注释 / 字符串 / 正则 / 嵌套模板照常被抹掉，而**可执行代码保留**，
 * 这样 C3 的声明收集才能看见插值里真正的工厂声明。
 *
 * @param {string} source 原文。
 * @param {string[]} masked 等长遮蔽缓冲（就地写空格）。
 * @param {number} from 起始下标（含）。
 * @param {number} end 扫描上界（不含）：递归时用它把范围限制在外层结构内。
 * @param {boolean} insideInterpolation 当前区间是否位于 ${ … } 内部。为 true 时，
 *   深度为 0 的 `}` 表示插值收尾：停在该 `}` 之前（不遮蔽它——它属于模板语法，
 *   由 maskTemplate 负责抹掉）。
 * @returns {{next: number, closing: number}} next 为扫描停止位置；closing 为收尾 `}`
 *   的下标（-1 表示一直扫到上界仍未找到配对）。
 */
function scanCodeRange(source, masked, from, end, insideInterpolation) {
  let cursor = from;
  let depth = 0;
  /**
   * 票据 42：只保留最近两个 token。
   * - `previousToken`：紧邻的前一个标记（`{ kind, value, memberAccess, ... }`）；
   * - `tokenBeforePrevious`：再往前一个，只用于 `for await (` 的识别。
   *
   * `memberAccess` 在这里一次算好（`obj.return` 的属性名不是关键字，其后仍是除号），
   * 避免每个判定点都回看一下标点；`#` 也按标点参与，`this.#return` 同样能识别成成员访问。
   */
  let previousToken = null;
  let tokenBeforePrevious = null;
  const rememberToken = (kind, value, extra = {}) => {
    // 紧邻的前一个 token 是 `.`（或 `.#` 里的 `#`）→ 当前 token 是属性名而不是关键字。
    const memberAccess = previousToken !== null
      && previousToken.kind === "punctuator"
      && (previousToken.value === "."
        || (previousToken.value === "#" && previousToken.memberAccess === true));
    tokenBeforePrevious = previousToken;
    previousToken = {
      kind,
      value,
      memberAccess,
      closesControlCondition: false,
      prefix: false,
      ...extra,
    };
  };
  /**
   * 票据 41（票据 42 保留）：圆括号上下文栈，每遇到 `(` 压入「这个 `(` 是否紧跟控制关键字」。
   *
   * 用**配对**而不是"记录最近一个 `)` 是谁"：`if ((a) && (b)) /re/` 里内层 `(a)`、
   * `(b)` 的右括号都不能放行正则，只有最外层闭合条件的那一个可以；栈天然给出正确配对。
   * 栈内不存下标是因为扫描是单向的（不需要回填），只需要出栈时的布尔值。
   */
  const parenStack = [];
  /**
   * 当前 `(` 是否开始一条控制语句的条件：前一个 token 是控制关键字（或 `for await` 的 await），
   * 且不是成员访问。
   */
  const opensControlCondition = () => {
    if (previousToken === null || previousToken.kind !== "identifier") return false;
    if (previousToken.memberAccess === true) return false;
    if (CONTROL_CONDITION_KEYWORDS.has(previousToken.value)) return true;
    // `for await (`：`(` 前是 `await`，再往前才是 `for`（票据 42 补；票据 41 只认紧邻的 for）。
    return previousToken.value === "await"
      && tokenBeforePrevious !== null
      && tokenBeforePrevious.kind === "identifier"
      && tokenBeforePrevious.value === "for"
      && tokenBeforePrevious.memberAccess !== true;
  };

  /**
   * 票据 42（反转判定）：前一个 token 是否**以值结尾**——只有值结尾时的 `/` 才是除号；
   * 其余一律按正则处理（默认允许）。
   *
   * 保留票据 41 的控制条件右括号例外：`if (x) /re/` 的 `)` 虽然"看起来是值结尾"，
   * 但它闭合的是语句头条件，其后开始一条新语句。
   *
   * 票据 43：`async` 按上下文判定——只有后面紧跟 `function` 或 `(` 才按「非值」处理，
   * 其余位置（后跟 `/`、运算符、`)`、`,` 等）按标识符（值结尾）→ 除号。
   * 不这样判时 `let async = 20; async / function helper() { … } / 3` 会把 `/` 当正则起始，
   * 中间函数体整段被遮蔽，而前缀仍然配平（fail-closed 看不见）→ 收集器静默返回空集。
   *
   * @param {number} index 当前判定位置（`/` 或 `++` / `--` 的下标），只用于 `async` 的前看。
   */
  const previousEndsValue = (index) => {
    if (previousToken === null) return false; // 文件 / 插值起始：默认允许正则
    if (previousToken.kind === "punctuator"
      && previousToken.value === ")"
      && previousToken.closesControlCondition) {
      return false;
    }
    // 票据 43：上下文关键字 async。成员访问（`obj.async / 2`）走不到这里——
    // 属性名由 isValueEndToken 的 memberAccess 分支按值结尾处理。
    if (previousToken.kind === "identifier"
      && previousToken.value === "async"
      && previousToken.memberAccess !== true) {
      return !asyncIntroducesFunctionOrArrow(source, index);
    }
    return isValueEndToken(previousToken);
  };

  /**
   * 票据 43：花括号上下文栈——每遇到可见 `{` 压入「它是块 / 类体吗」，配对 `}` 出栈。
   * 出栈值写到 `}` token 的 `closesBlockBody` 上：
   * - true（块 / 类体 / 无法判定）→ `}` 之后按**语句位置**处理，允许正则；
   * - false（对象字面量）→ `}` 之后按**表达式位置**处理，`/` 是除号。
   * 只影响「`}` 紧跟 `/`」这一个判定，其它标点不受影响。
   */
  const braceStack = [];
  /**
   * 当前 `{` 是否开始**块 / 类体**（true）还是**对象字面量**（false）。
   *
   * 判定表（票据 43 要求）：
   * - 前一个 token 是 `)` / `;` / `{` / `}` / `>`（即 `=>`）→ 块；
   * - 前一个 token 是 `=` / `(` / `[` / `,` / `:` / 运算符 → 对象字面量；
   * - 前一个 token 是 `return` / `typeof` / `throw` … → 对象字面量；
   * - 前一个 token 是 `class` / `static` / `else` / `try` / 普通标识符 → 块；
   * - **无法确定 → 块（允许正则）**。为什么取这一侧：取块的失败是 loud 的（误把除法
   *   当正则 → 可能破坏配平抛错，或产生幻影声明 → C3 对账报红），取除号的失败是
   *   静默的（本票据修复的反例）。宁可炸，不可静默漏。
   */
  const opensBlockBody = () => {
    if (previousToken === null) return true; // 文件 / 插值起始按块
    if (previousToken.kind === "punctuator") {
      if (BLOCK_OPENING_PUNCTUATORS.has(previousToken.value)) return true;
      if (OBJECT_LITERAL_OPENING_PUNCTUATORS.has(previousToken.value)) return false;
      return true; // 其它标点无法确定 → 块（宁可 loud）
    }
    if (previousToken.kind === "identifier"
      && previousToken.memberAccess !== true
      && OBJECT_LITERAL_OPENING_KEYWORDS.has(previousToken.value)) {
      return false;
    }
    // 其它标识符（含 `class A {` 的类名）、字面量等：无法确定 → 块。
    return true;
  };
  /** 最近一个 `}` 出栈得到的布尔值；只有 `}` token 会读它（见下面 punctuator 分支）。 */
  let closingBlockBody = true;

  while (cursor < end) {
    const character = source[cursor];
    const nextCharacter = source[cursor + 1];

    // 标识符**整词**读取：只有把 `return` 当成一个 token 才能判定「其后允许正则」。
    // 逐字符读会把前一个标记退化成字母 `n`，`return /re/` 于是被误判成除号（票据 38）。
    // 这里只推进游标、不遮蔽任何字符——遮蔽只针对注释 / 字符串 / 模板文本 / 正则。
    if (isIdentifierStartAt(source, cursor)) {
      const identifier = readIdentifierForward(source, cursor);
      rememberToken("identifier", identifier.value);
      cursor = identifier.end;
      continue;
    }

    // shebang 行（`#!/usr/bin/env node`）按整行注释处理，避免 `#` 影响后续判定。
    if (cursor === 0 && character === "#" && nextCharacter === "!") {
      const start = cursor;
      while (cursor < end && source[cursor] !== "\n") cursor++;
      blankRange(source, masked, start, cursor);
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      const start = cursor;
      while (cursor < end && source[cursor] !== "\n") cursor++;
      blankRange(source, masked, start, cursor);
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      const start = cursor;
      cursor += 2;
      while (cursor < end && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor++;
      cursor = Math.min(cursor + 2, end);
      blankRange(source, masked, start, cursor);
      continue;
    }
    if (character === "'" || character === '"') {
      const start = cursor;
      cursor = Math.min(findQuotedEnd(source, cursor), end);
      blankRange(source, masked, start, cursor);
      rememberToken("literal", '"');
      continue;
    }
    if (character === "`") {
      cursor = maskTemplate(source, masked, cursor, end);
      rememberToken("literal", "`");
      continue;
    }
    // 票据 42：数字字面量也是「值结尾」——`10 / 2` 的斜杠必须判成除号。
    // 不单独读数字时，`/` 的前一个 token 会是某一数字字符的标点，默认允许正则，
    // 于是 `10 / 2 / 3` 里的 ` 2 /` 会被当成正则字面量整段吞掉。
    if (isDigitAt(source, cursor) || (character === "." && isDigitAt(source, cursor + 1))) {
      cursor = readNumberLiteral(source, cursor);
      rememberToken("literal", "number");
      continue;
    }
    // 票据 42（反转）：`//` 与 `/*` 已在上面按注释处理，这里只剩真正的正则 / 除号判定。
    // **默认允许正则**；只有前一个 token 以值结尾时才是除号（见 previousEndsValue）。
    // 票据 43：把当前下标传进去——`async` 的上下文判定要看紧随其后的记号。
    if (character === "/" && nextCharacter !== "/" && nextCharacter !== "*" && !previousEndsValue(cursor)) {
      const start = cursor;
      cursor = Math.min(findRegexEnd(source, cursor), end);
      blankRange(source, masked, start, cursor);
      rememberToken("literal", "/");
      continue;
    }
    // 票据 43：`{` 按前一个 token 登记上下文；配对的 `}` 出栈，决定其后是正则还是除号。
    // 插值收尾的 `}`（深度 0）不是代码里的花括号：它不参与出栈，直接交给 maskTemplate。
    if (character === "{") {
      depth++;
      braceStack.push(opensBlockBody());
    } else if (character === "}") {
      if (depth === 0 && insideInterpolation) return { next: cursor + 1, closing: cursor };
      if (depth > 0) depth--;
      // 未配对（栈空）时按「块」处理：与「无法确定取块」一致，宁可 loud 不可静默。
      closingBlockBody = braceStack.length > 0 ? braceStack.pop() : true;
    }
    if (!isWhitespaceAt(source, cursor)) {
      // 票据 42：`++` / `--` 必须合并成**一个** token。逐字符看时 `x++ / 2` 的
      // 前一个 token 是普通 `+`（非值结尾），`/` 就被当成正则起始而吞掉 ` 2 /`。
      // 前缀 / 后缀由「前一个 token 是否值结尾」决定：值之后是后缀（仍是值），否则是前缀。
      if ((character === "+" && nextCharacter === "+") || (character === "-" && nextCharacter === "-")) {
        rememberToken("punctuator", character + character, { prefix: !previousEndsValue(cursor) });
        cursor += 2;
        continue;
      }
      // 票据 41：`(` / `)` 需要额外的上下文信息（是否控制条件），其余 punctuator 照旧。
      if (character === "(") {
        // 必须在 rememberToken 之前判定：那一刻的 previousToken 才是 `(` 前面的 token。
        parenStack.push(opensControlCondition());
        rememberToken("punctuator", character);
      } else if (character === ")") {
        // 配对的 `(` 曾由控制关键字引出 → 这个 `)` 之后是语句起始位置。
        const closesControlCondition = parenStack.length > 0 ? parenStack.pop() : false;
        rememberToken("punctuator", character, { closesControlCondition });
      } else if (character === "}") {
        // 票据 43：把出栈得到的上下文挂到 token 上，供 isValueEndToken 判定其后是正则。
        rememberToken("punctuator", character, { closesBlockBody: closingBlockBody });
      } else {
        rememberToken("punctuator", character);
      }
    }
    cursor++;
  }
  return { next: end, closing: -1 };
}

/**
 * 从反引号开始遮蔽一个模板字面量：**文本段**（含定界反引号与插值起始符）等长抹成空格，
 * ${ … } 插值内部交给 scanCodeRange 递归处理（票据 37）。
 *
 * 结构性判定全部复用同一套代码扫描：字符串、嵌套模板、注释与正则先被整体跳过，因此
 * 文本里的转义写法、插值里的 `}` / 反引号 / 引号 / 正则都不会让插值提前收尾。
 *
 * @returns {number} 模板结束后的下标（未闭合时为上界）。
 */
function maskTemplate(source, masked, index, end) {
  let cursor = index + 1;
  let textStart = index;
  while (cursor < end) {
    const character = source[cursor];
    // 文本里的转义序列整体跳过（转义反引号不是模板结束，转义美元符不是插值开始）。
    if (character === "\\") { cursor += 2; continue; }
    if (character === "`") {
      blankRange(source, masked, textStart, Math.min(cursor + 1, end));
      return Math.min(cursor + 1, end);
    }
    if (character === "$" && source[cursor + 1] === "{") {
      blankRange(source, masked, textStart, cursor + 2);
      const interpolation = scanCodeRange(source, masked, cursor + 2, end, true);
      if (interpolation.closing < 0) {
        // 插值未闭合（源码本身不合法）：剩余部分按模板文本处理，避免死循环或越界。
        blankRange(source, masked, cursor + 2, end);
        return end;
      }
      // 收尾的 `}` 属于模板语法（不参与代码侧括号配对），同样遮蔽。
      blankRange(source, masked, interpolation.closing, interpolation.closing + 1);
      cursor = interpolation.next;
      textStart = cursor;
      continue;
    }
    cursor++;
  }
  blankRange(source, masked, textStart, end);
  return end;
}

/**
 * 正则字面量收尾位置。若同一行内找不到闭合的 `/`，说明按启发式误判（其实是除号），
 * 只吞掉这一个斜杠，把后续字符留给主循环。
 */
function findRegexEnd(source, index) {
  let cursor = index + 1;
  let inCharacterClass = false;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") { cursor += 2; continue; }
    if (character === "\n") return index + 1;
    if (inCharacterClass) {
      if (character === "]") inCharacterClass = false;
      cursor++;
      continue;
    }
    if (character === "[") { inCharacterClass = true; cursor++; continue; }
    if (character === "/") {
      cursor++;
      while (cursor < source.length && isIdentifierPartAt(source, cursor)) cursor++;
      return cursor;
    }
    cursor++;
  }
  return index + 1;
}

/** 表达式体换行后**下一行**仍属于本表达式的起始字符（票据 38 的续行近似）。 */
const EXPRESSION_CONTINUATION_START = new Set([
  ".", "?", ":", "(", "[", "+", "-", "*", "/", "%", "&", "|", "^", "=", "<", ">",
]);

/** 表达式体**行尾**尚未结束、必须续行的字符（二元运算符 / 逗号 / 等号 / 未闭合的括号）。 */
const EXPRESSION_CONTINUATION_END = new Set([
  ".", "?", ":", "(", "[", "+", "-", "*", "/", "%", "&", "|", "^", "=", "<", ">", ",",
]);

/**
 * 求表达式体箭头（`=>` 之后不是 `{`）的表达式**结束下标（含）**（票据 38）。
 *
 * 为什么必须有它：`const createHugeFactory = () => [ … ]` 此前完全没有跨度，于是既绕过
 * 工厂 ≤400、也绕过函数 ≤200——规格写的「单函数 ≤200」并没有为表达式体开口子。
 *
 * 判定口径 = **括号配平 + 语句边界近似**（只用遮蔽串，注释 / 字符串 / 正则已抹成空格）：
 * - 深度 0 的 `;`、`,` 结束表达式（逗号是实参 / 数组元素分隔符）；
 * - 深度 0 遇到 `)` / `]` / `}` 时，那个括号属于**外层**结构，表达式在它之前结束；
 * - 深度 0 的换行通常结束表达式，除非两侧有续行信号（行尾是二元运算符 / 逗号 / 未闭合括号，
 *   或下一行以 `.`（链式调用）、`?` / `:`（三元）、运算符 / 括号开头）——这就是
 *   「链式调用 / 三元表达式跨行」能被完整覆盖的原因；
 * - 一直扫到上界（文件末尾 / 传入的 limit）仍未遇到边界时，取最后一个有效字符。
 *
 * 已知少报：表达式体是**跨多行模板文本**时，文本段被遮蔽成空白，可能只算到第一行；
 * 方向仍是「少报」，不会把别的函数算进来。找不到任何有效字符时返回 -1，调用方跳过该跨度。
 *
 * @returns {number} 结束下标（含）；-1 表示这段表达式里没有可定位的有效字符。
 */
function findExpressionEnd(masked, from, limit) {
  let cursor = from;
  let depth = 0;
  let lastSignificantIndex = -1;
  let lastSignificant = "";
  /** 结束时优先取最后一个有效字符；整段都被遮蔽时退回到边界前一个下标。 */
  const finish = (boundaryIndex) => (lastSignificantIndex >= 0 ? lastSignificantIndex : boundaryIndex - 1);

  while (cursor < limit) {
    const character = masked[cursor];
    if (character === "\n" && depth === 0) {
      const next = skipWhitespaceForward(masked, cursor);
      const nextCharacter = next < limit ? masked[next] : "";
      const continues = lastSignificantIndex < 0
        || (nextCharacter !== "" && EXPRESSION_CONTINUATION_START.has(nextCharacter))
        || EXPRESSION_CONTINUATION_END.has(lastSignificant);
      if (!continues) return finish(cursor);
      cursor = next;
      continue;
    }
    if (!isWhitespaceAt(masked, cursor)) {
      if (character === "(" || character === "[" || character === "{") {
        depth++;
      } else if (character === ")" || character === "]" || character === "}") {
        if (depth === 0) return finish(cursor);
        depth--;
      } else if (depth === 0 && (character === ";" || character === ",")) {
        return finish(cursor);
      }
      lastSignificantIndex = cursor;
      lastSignificant = character;
    }
    cursor++;
  }
  return finish(limit);
}

/** 括号配对表：闭合字符 → 它的开启字符。 */
const STRUCTURE_OPENERS = new Map([["}", "{"], [")", "("], ["]", "["]]);

/** 结构化报错里的定位串：文件（可缺省）+ 行号。行号由遮蔽串计算（等长，可直接映射）。 */
function describeMaskPosition(masked, file, index) {
  const label = typeof file === "string" && file !== "" ? file : "<未提供文件名>";
  const line = lineOf(buildLineStarts(masked), Math.max(0, Math.min(index, masked.length - 1)));
  return "文件 " + label + " 第 " + line + " 行";
}

/**
 * 票据 42：结构完整性 fail-closed —— 遮蔽后的**代码区**必须括号配平。
 *
 * 为什么放在遮蔽器返回前：正则 / 模板判定失准的两种方向
 * 1. 「正则里的 `}` 被当代码」→ 多出闭合符；
 * 2. 「代码被当文本吞掉」→ 少了闭合符（或少了开启符）；
 * 都会打破 `{}` / `()` / `[]` 的配平。过去这种失准是**静默**的：门禁拿到一份少了
 * 声明的遮蔽串，照样输出 0 违规（假绿）。现在变成抛错并指出文件与行号。
 *
 * 只校验**遮蔽后仍可见**的代码区：注释 / 字符串 / 模板文本 / 正则已被抹成空格，
 * 它们里面的括号天然不参与（这正是"忽略被遮蔽区域"的实现方式）。
 *
 * 用**栈**而不是只比较计数：`}{ ` 的计数相等但嵌套顺序非法，栈能把两类都抓住。
 *
 * 已知不覆盖的方向：插值**提前收尾**时被截断的前缀仍可能配平（例如 `throw /[}]/`
 * 的旧复现），这一类由反转判定消除，并由消费者级用例（C3 声明收集）兜住。
 */
function assertMaskedStructureBalanced(masked, file) {
  const stack = [];
  for (let index = 0; index < masked.length; index++) {
    const character = masked[index];
    if (character === "{" || character === "(" || character === "[") {
      stack.push({ character, index });
      continue;
    }
    const opener = STRUCTURE_OPENERS.get(character);
    if (opener === undefined) continue;
    const top = stack.pop();
    if (top === undefined || top.character !== opener) {
      const reason = top === undefined
        ? "找不到配对的 “" + opener + "”"
        : "闭合 “" + top.character + "”（第 "
          + lineOf(buildLineStarts(masked), top.index) + " 行）";
      throw new Error("遮蔽后括号不配平（正则 / 模板判定可能失准）："
        + describeMaskPosition(masked, file, index) + " 的 “" + character + "” " + reason);
    }
  }
  if (stack.length > 0) {
    const top = stack[0];
    throw new Error("遮蔽后括号不配平（正则 / 模板判定可能失准）："
      + describeMaskPosition(masked, file, top.index) + " 的 “" + top.character + "” 没有闭合");
  }
}

/**
 * 等长遮蔽：注释、字符串、模板**文本段**与正则字面量替换成空格（保留 \n 与 \r）。
 * 返回字符串长度与原文完全一致，下标可直接映射回原文件。
 *
 * 模板插值 ${ … } 内部**不再整体遮蔽**：其中的可执行代码原样保留（只遮蔽它自己的
 * 注释 / 字符串 / 正则 / 嵌套模板文本），见 scanCodeRange 与 maskTemplate（票据 37）。
 *
 * 票据 42：返回前做**结构完整性校验**（见 assertMaskedStructureBalanced）——正则被误判
 * 时最典型的后果是括号不配平，这里把它变成 loud failure，而不是静默少报。
 *
 * @param {string} source 原文。
 * @param {{file?: string}} [options] `file` 只用于报错定位（不参与判定）。
 */
export function maskJavaScriptSource(source, options = {}) {
  const masked = source.split("");
  scanCodeRange(source, masked, 0, source.length, false);
  const text = masked.join("");
  assertMaskedStructureBalanced(text, options.file);
  return text;
}

/** 为每个 `{` / `(` 找到配对下标（未配对为 -1），数组长度与文本一致。 */
function matchPairs(text, open, close) {
  const pairs = new Int32Array(text.length).fill(-1);
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === open) stack.push(index);
    else if (character === close) {
      const opening = stack.pop();
      if (opening !== undefined) {
        pairs[opening] = index;
        pairs[index] = opening;
      }
    }
  }
  return pairs;
}

/** 行首下标表：用于把字符下标换算成 1 起的行号。 */
function buildLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

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

/** 向后读一个标识符（调用方已确认起点是标识符起始字符）。 */
function readIdentifierForward(text, index) {
  let cursor = index;
  while (cursor < text.length && isIdentifierPartAt(text, cursor)) cursor++;
  return { value: text.slice(index, cursor), end: cursor };
}

/** 向前读一个标识符；返回 null 表示前一个 token 不是标识符。 */
function readIdentifierBackward(text, index) {
  if (index < 0 || !isIdentifierPartAt(text, index)) return null;
  let cursor = index;
  while (cursor >= 0 && isIdentifierPartAt(text, cursor)) cursor--;
  return { value: text.slice(cursor + 1, index + 1), start: cursor + 1 };
}

/**
 * 从 `function` 关键字向左推断绑定名：`const NAME = function () {}`。
 * 返回空串表示推不出来（匿名函数）。
 */
function inferAssignmentName(masked, index) {
  let cursor = skipWhitespaceBackward(masked, index - 1);
  if (masked[cursor] !== "=") return "";
  cursor = skipWhitespaceBackward(masked, cursor - 1);
  const identifier = readIdentifierBackward(masked, cursor);
  if (!identifier) return "";
  const beforeName = skipWhitespaceBackward(masked, identifier.start - 1);
  // `obj.NAME = function` 属于给已有对象的属性赋值，不当成模块内命名函数。
  if (masked[beforeName] === ".") return "";
  return identifier.value;
}

/**
 * 箭头函数名推断：参数列表左侧可能是 `const NAME = (...)`、`NAME = (...)`（类字段）
 * 或 `NAME: (...)`（对象属性）。
 */
function inferNameBeforeParameters(masked, openParenIndex) {
  let cursor = skipWhitespaceBackward(masked, openParenIndex - 1);
  if (isIdentifierPartAt(masked, cursor)) {
    const previous = readIdentifierBackward(masked, cursor);
    // `async (...) =>`：跳过 async 继续向左找绑定名。
    if (previous && previous.value === "async") {
      cursor = skipWhitespaceBackward(masked, previous.start - 1);
    } else {
      return "";
    }
  }
  const separator = masked[cursor];
  if (separator !== "=" && separator !== ":") return "";
  cursor = skipWhitespaceBackward(masked, cursor - 1);
  const identifier = readIdentifierBackward(masked, cursor);
  if (!identifier) return "";
  const beforeName = skipWhitespaceBackward(masked, identifier.start - 1);
  if (masked[beforeName] === ".") return "";
  return identifier.value;
}

/**
 * 方法名判定：`name(...) {` 且前面不是调用点/控制流关键字。
 * 返回 true 表示这是一个方法（类方法或对象字面量方法）。
 */
function isMethodDefinition(masked, nameStart, name) {
  if (NON_METHOD_NAMES.has(name)) return false;
  let cursor = skipWhitespaceBackward(masked, nameStart - 1);
  if (cursor < 0) return true;
  const previousCharacter = masked[cursor];
  if (previousCharacter === "." || previousCharacter === "=" || previousCharacter === "]") return false;
  if (isIdentifierPartAt(masked, cursor)) {
    const previous = readIdentifierBackward(masked, cursor);
    if (!previous) return false;
    if (previous.value === "function") return false;
    if (NON_METHOD_NAMES.has(previous.value)) return false;
    return METHOD_MODIFIERS.has(previous.value);
  }
  if (previousCharacter === "*") return true;
  return previousCharacter === "{" || previousCharacter === "," || previousCharacter === ";"
    || previousCharacter === "}" || previousCharacter === ")";
}

/**
 * 扫描函数跨度。返回按起始下标升序的数组，每项：
 * `{ name, kind: "declaration" | "method" | "arrow", start, end, startLine, endLine,
 *    parent, containedFunctionCount }`。
 * `start`/`end` 是函数在遮蔽串上的起止下标（end 指向配对的 `}`）；
 * `containedFunctionCount` 是**递归包含**的全部函数数（不含自身）。
 *
 * 票据 42：私有方法按 `#name` 计入（kind 仍是 `method`）；结构完整性（括号配平）
 * 由 `maskJavaScriptSource` 在遮蔽时校验，失准会带文件名抛错。
 *
 * @param {string} source 原文。
 * @param {{file?: string}} [options] `file` 只用于遮蔽器的报错定位。
 */
export function scanFunctionSpans(source, options = {}) {
  // 票据 42：结构完整性（{}/()/[] 配平）已由 maskJavaScriptSource 在返回前校验，
  // 这里不再重复一套更弱的检查——单一事实源，报错信息里还能带文件名。
  const masked = maskJavaScriptSource(source, options);
  const lineStarts = buildLineStarts(source);
  const bracePairs = matchPairs(masked, "{", "}");
  const parenPairs = matchPairs(masked, "(", ")");

  const spans = [];
  /** 直接按「起止下标（都含）」登记一个跨度；表达式体箭头用它（结束下标来自 findExpressionEnd）。 */
  const pushSpanRange = (name, kind, startIndex, endIndex) => {
    if (endIndex < startIndex) return;
    spans.push({
      name,
      kind,
      start: startIndex,
      end: endIndex,
      startLine: lineOf(lineStarts, startIndex),
      endLine: lineOf(lineStarts, endIndex),
    });
  };
  /** 花括号体：结束下标是配对的那个 `}`。 */
  const pushSpan = (name, kind, startIndex, bodyStart) => {
    const bodyEnd = bracePairs[bodyStart];
    if (bodyEnd < 0) return;
    pushSpanRange(name, kind, startIndex, bodyEnd);
  };

  // 1) `function` 声明与函数表达式。
  const functionPattern = /\bfunction\b/g;
  let match;
  while ((match = functionPattern.exec(masked)) !== null) {
    let cursor = skipWhitespaceForward(masked, match.index + "function".length);
    if (masked[cursor] === "*") cursor = skipWhitespaceForward(masked, cursor + 1);
    let name = "";
    if (isIdentifierStartAt(masked, cursor)) {
      const identifier = readIdentifierForward(masked, cursor);
      name = identifier.value;
      cursor = skipWhitespaceForward(masked, identifier.end);
    }
    if (masked[cursor] !== "(") continue;
    const parametersEnd = parenPairs[cursor];
    if (parametersEnd < 0) continue;
    const bodyStart = skipWhitespaceForward(masked, parametersEnd + 1);
    if (masked[bodyStart] !== "{") continue;
    if (!name) name = inferAssignmentName(masked, match.index);
    pushSpan(name, "declaration", match.index, bodyStart);
  }

  // 2) 箭头函数：花括号体 + 表达式体（票据 38）。
  //
  // 票据 38 之前只统计块体（`=> {`），`const createHugeFactory = () => [ …407 行… ]` 的跨度
  // 是 0，因此既绕过工厂 ≤400 也绕过函数 ≤200；规格的「单函数 ≤200」没有为表达式体开口子。
  // 现在表达式体也算跨度，并**同样计入函数总数与单闭包内函数数**（父链统计见第 4 步，
  // 与块体箭头走同一条路径，口径完全一致）。
  const arrowPattern = /=>/g;
  while ((match = arrowPattern.exec(masked)) !== null) {
    const bodyStart = skipWhitespaceForward(masked, match.index + 2);
    if (bodyStart >= masked.length) continue;
    const hasBlockBody = masked[bodyStart] === "{";
    let cursor = skipWhitespaceBackward(masked, match.index - 1);
    if (cursor < 0) continue;
    let name = "";
    let startIndex = cursor;
    if (masked[cursor] === ")") {
      const parametersStart = parenPairs[cursor];
      if (parametersStart < 0) continue;
      name = inferNameBeforeParameters(masked, parametersStart);
      startIndex = parametersStart;
    } else if (isIdentifierPartAt(masked, cursor)) {
      const identifier = readIdentifierBackward(masked, cursor);
      if (!identifier) continue;
      name = identifier.value;
      startIndex = identifier.start;
    } else {
      continue;
    }
    if (hasBlockBody) {
      pushSpan(name, "arrow", startIndex, bodyStart);
      continue;
    }
    // 表达式体：结束下标由 findExpressionEnd 按「括号配平 + 语句边界」近似求出。
    const expressionEnd = findExpressionEnd(masked, bodyStart, masked.length);
    if (expressionEnd < bodyStart) continue;
    pushSpanRange(name, "arrow", startIndex, expressionEnd);
  }

  // 3) 方法：类方法 / 对象字面量方法 / **私有方法**（`name(...) {` / `#name(...) {`）。
  //
  // 票据 42：私有方法（`class C { #createHidden() { … } }`）此前完全不计跨度——
  // `isIdentifierStartAt` 对 `#` 返回 false，方法循环直接跳过它。
  // 现在把 `#name` 当作一个方法名读取，**但只在它确实是定义形态时才登记**：
  // - 私有字段赋值 `#count = 0`：紧跟的不是 `(`，天然跳过；
  // - 私有成员调用 `this.#m()` / `obj?.#m()`：`isMethodDefinition` 看到前一个字符是 `.`
  //   会拒绝（与普通方法同一条规则）；
  // - 方法体内的 `this.#m({…})` 调用：`)` 之后是 `;` / 换行而不是 `{`，同样跳过。
  let cursor = 0;
  while (cursor < masked.length) {
    const isPrivateName = masked[cursor] === "#";
    if (isPrivateName ? !isIdentifierStartAt(masked, cursor + 1) : !isIdentifierStartAt(masked, cursor)) {
      cursor++;
      continue;
    }
    const nameStart = cursor;
    const identifier = readIdentifierForward(masked, isPrivateName ? cursor + 1 : cursor);
    const name = isPrivateName ? "#" + identifier.value : identifier.value;
    const afterName = skipWhitespaceForward(masked, identifier.end);
    if (masked[afterName] !== "(") { cursor = identifier.end; continue; }
    const parametersEnd = parenPairs[afterName];
    if (parametersEnd < 0) { cursor = identifier.end; continue; }
    const bodyStart = skipWhitespaceForward(masked, parametersEnd + 1);
    if (masked[bodyStart] !== "{" || !isMethodDefinition(masked, nameStart, name)) {
      cursor = identifier.end;
      continue;
    }
    pushSpan(name, "method", nameStart, bodyStart);
    cursor = identifier.end;
  }

  // 4) 建立父子关系并统计子树内函数数（用于「单闭包内函数数」）。
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const stack = [];
  for (const span of spans) {
    while (stack.length > 0 && stack[stack.length - 1].end <= span.start) stack.pop();
    span.parent = stack.length > 0 ? stack[stack.length - 1] : null;
    span.containedFunctionCount = 0;
    if (span.parent) span.parent.containedFunctionCount += 1;
    stack.push(span);
  }
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index];
    if (span.parent) span.parent.containedFunctionCount += span.containedFunctionCount;
  }
  return spans;
}
