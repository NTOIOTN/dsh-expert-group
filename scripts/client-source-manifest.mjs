/**
 * 客户端装配源清单（manifest）：R0 票据 03 建立的**四语义单一事实源**。
 *
 * ## 为什么需要这份清单
 * 一次客户端装配涉及四种"文件集合"，它们过去散落在四个不同位置，各自维护：
 * 1. **装配顺序**：`scripts/assemble-client.mjs` 的模块局部常量（IIFE_SOURCES /
 *    FRESHNESS_SOURCE / DESCRIPTOR_SOURCE）；
 * 2. **语法检查集合**：`scripts/build.mjs` 的 `node --check` 名单（来自 client-sources.mjs）；
 * 3. **通知 marker 扫描集合**：`test/notification-popup-channel.test.mjs` 的 CLIENT_FILES；
 * 4. **IIFE 依赖边**：`scripts/check-dependency-graph.mjs` 只能靠扫描源码反推。
 *
 * 四份"各写一份"的代价在拆分批次里立刻显现：新拆出一个客户端 IIFE 时，只要漏改其中一份，
 * source 模式的测试替身就不会加载它（测试假绿或全红），依赖图门禁也看不到它的依赖边。
 * 因此本模块把四语义集中到一处，其余消费者**只允许派生、不允许复制**。
 *
 * ## 无副作用约束
 * 本模块**只导出冻结数据**：不读文件系统、不写文件、不执行构建、不 import
 * `scripts/build.mjs` 或 `scripts/assemble-client.mjs`（那两个模块顶层会真的跑一次装配/构建）。
 * 依赖方向是单向的：manifest → `scripts/client-sources.mjs`，反向不允许（否则成环）。
 *
 * ## 新增客户端模块时的登记顺序（plan §10.2）
 * 1. `assemblyOrder` 按**执行顺序**插入（descriptor 恒为最后一项）；
 * 2. `syntaxCheckSources` / `scanSources` 同步（前者复用 client-sources.mjs，会自动跟随）；
 * 3. `iifeDependencies` 声明它 provides/requires 的 `Symbol.for("dsh-expert-group/<name>")` 边。
 */
import { CLIENT_SOURCE_FILES } from "./client-sources.mjs";

/**
 * 装配顺序里**必须先于唯一 descriptor 执行**的浏览器安全 classic IIFE。
 *
 * 每一项形如 `(function install...(global) { ... })(globalThis)`，执行后把实现挂到
 * `globalThis[Symbol.for("dsh-expert-group/<name>")]`；`client.js` 的 factory 只从那里取回实现。
 * 数组顺序 = 发布 bundle 里的段顺序 = 执行顺序（顺序本身是装载契约，不是"集合"）。
 */
const IIFE_EXECUTION_ORDER = Object.freeze([
  // ── R8（票据 29）：专家组模型拆为 normalize / format 两个子模块 + 原公开门面 ──────────
  // 顺序由真实依赖边决定：normalize 是原语与归一/状态推导层、不读任何兄弟 IIFE；format 读
  // normalize 的检查点（原语、归一函数与同源常量）；client-expert-group-model.js 作为门面读
  // 两者并按原键顺序重组同一份公开导出面，因此必须最后执行。三者都先于唯一 descriptor
  // 与所有读取方（client-sidebar-pure.js / client-text.js / client.js）。
  "client-expert-group-model-normalize.js",
  "client-expert-group-model-format.js",
  // 「专家组模型」的公开检查点（薄门面，只重组两个子模块的导出面）。
  "client-expert-group-model.js",
  // ── R5：侧栏辅助服务 5 个 IIFE（票据 21）────────────────────────────────────
  // 顺序由真实依赖边决定，不是业务直觉：pure 的宽度偏好归一调用 ledger 的
  // sidebarLocalStorage，因此 ledger 必须最先执行；dom / poll / layout 只依赖 pure
  // （layout 另依赖 dom），主 sidebar IIFE 最后执行并从 5 个检查点取回实现。
  //
  "client-sidebar-auto-ledger.js",
  "client-sidebar-pure.js",
  "client-sidebar-dom.js",
  "client-sidebar-poll.js",
  "client-sidebar-layout.js",
  // ── R6：Panel 状态 / 缓存 / tab 记账（票据 22）─────────────────────────────
  // 顺序仍由**真实依赖边**决定，不是业务直觉：
  // - panel-cache 不依赖任何兄弟 IIFE（纯 Map + 数字），只需先于主 sidebar；
  // - split-sync 依赖 pure（text/object/常量）与 dom（panel/pane 读面），必须排在两者之后；
  // 二者都必须先于主 sidebar——主 IIFE 在 createExpertGroupPanel / Panel 里经检查点取回实现。
  "client-sidebar-panel-cache.js",
  "client-sidebar-split-sync.js",
  "client-sidebar-tab-state.js",
  "client-sidebar-panel-state-a.js",
  "client-sidebar-panel-state-b.js",
  // ── R6：Panel 视图层（票据 23）─────────────────────────────────────────────
  // 三组视图按依赖方向排列：a 提供行内控件/用量视图，b 在其上加投影与摘要条，
  // c 复用 a/b 组成专家/分片/fan-out/弹窗；overlay 只依赖 DOM，但必须在主 sidebar
  // 之前执行——主 IIFE 在加载期就从检查点取回 createNativeRightbarContinuityOverlay。
  "client-sidebar-views-a.js",
  "client-sidebar-views-b.js",
  "client-sidebar-views-c.js",
  // ── R6：Panel 动作面（票据 24）──────────────────────────────────────────────
  // 顺序由真实依赖边决定：两者都只读 pure / dom / auto-ledger（actions 另经主 IIFE 的窄命令
  // 间接使用 tab-state 的转移函数），并且都必须在主 sidebar 之前——主 IIFE 在加载期就从检查点
  // 取回 createSidebarAutoController / createSidebarActions 两个工厂。
  // auto-controller 排在 actions 之前：actions 的「先关闭后打开」判据依赖前者已装载。
  "client-sidebar-auto-controller.js",
  "client-sidebar-actions.js",
  "client-sidebar-overlay.js",
  // ── R7：install 编排与四个安装面（票据 25）──────────────────────────────────
  // 顺序由真实依赖边决定：layout（状态容器 + 访问记账）→ width（宽度命令）→ expand（展开/打开）
  // → target（目标同步 + 分栏事务）→ resources（coordinator）。前四个各提供检查点给 resources，
  // resources 只提供 coordinator 给主 sidebar；主 sidebar 因此必须排在它们之后。
  "client-sidebar-install-layout.js",
  "client-sidebar-install-width.js",
  "client-sidebar-install-expand.js",
  "client-sidebar-install-target.js",
  "client-sidebar-install-resources.js",
  // ── R6.5（票据 26b）：Panel 组件本体与 4 个自定义 Hook ------------------------------
  // 顺序由真实依赖边决定：4 个 Hook 模块各自只读 pure / dom / poll / 状态与视图的检查点；
  // panel 依次读 4 个 Hook 模块 + 视图层 + Panel 状态；主 sidebar 只读 panel 与 install resources。
  "client-sidebar-panel-hooks-state.js",
  "client-sidebar-panel-hooks-effects.js",
  "client-sidebar-panel-hooks-tabs.js",
  "client-sidebar-panel-hooks-actions.js",
  "client-sidebar-panel.js",
  "client-expert-group-sidebar.js",
  // 通知协调模块必须与其它浏览器安全 IIFE 一起先于唯一 descriptor 执行：
  // client.js 的 factory 只从 globalThis 取回这份实现，不再自带通知队列/轮询逻辑。
  "client-notifications.js",
  // ── R8（票据 28）：「模型配置」区域拆为 paths / rows 两个子模块 + 门面 ─────────────
  // 顺序由真实依赖边决定：paths 是纯 draft/path 原语、不读任何兄弟 IIFE；rows 读 paths 的
  // 检查点（模型行/effort/input/容量与校验族）；client-model-config.js 作为门面读两者并按
  // 原顺序重组同一份公开导出面，因此必须最后执行。三者都先于唯一 descriptor。
  "client-model-config-paths.js",
  "client-model-config-rows.js",
  // 「模型配置」区域的公开门面 + install/自定义 provider 创建面（provider 目录装配、草稿/
  // 路径操作编排、七档 reasoningEfforts 映射、继承/恢复默认、revision 冲突与角色联动守卫）。
  // 同样先于 descriptor 执行：client.js 只从 globalThis 取回它并负责渲染。
  "client-model-config.js",
  // ── R8（票据 26）：client.js 的 descriptor 工厂作用域外移出的 9 个客户端模块 ──────────
  // 顺序由真实依赖边决定：text 只读模型检查点；native-status 提供 STATUS_ROLE_* 给
  // settings-normalize 与 subagent-metadata；main-b 提供 renderSettingsTail 给 main-a。
  // 全部先于唯一 descriptor 执行——descriptor 只从各自检查点取回实现。
  "client-text.js",
  "client-styles.js",
  "client-fanout-normalize.js",
  "client-native-status.js",
  "client-settings-normalize.js",
  "client-model-config-host.js",
  "client-subagent-metadata.js",
  "client-settings-main-b.js",
  "client-settings-main-a.js",
  // ── R8（票据 27）：模型视图、焦点归还、conversation 适配、导航图标与插件详情 ─────────────
  // 顺序由真实依赖边决定：views-b（候选弹窗与选择纯函数）先于 views-a（provider 卡片引用弹窗）、
  // provider-card（创建卡片引用同一弹窗）与 model-section（区域引用三者 + focus 归还）；
  // nav-icon 提供 settings section id 给 plugin-detail 与 descriptor。
  "client-model-views-b.js",
  "client-model-views-a.js",
  "client-provider-card.js",
  "client-focus-return.js",
  "client-model-section.js",
  "client-conversation-adapters.js",
  "client-nav-icon.js",
  "client-plugin-detail.js",
]);

/**
 * freshness/RPC 的 ESM 权威实现。构建期投影成 classic 片段（去 `export` 前缀 + 追加
 * "检查点 + ModuleLoader 登记"尾部），必须排在唯一 descriptor 之前，登记才来得及生效。
 *
 * 注意它不是 IIFE：`test-support/client-bundle.mjs` 的 source 模式由 client.js 的 require
 * 取回同一份 ESM 模块，**不得**再当 IIFE 执行第二遍（否则同一实现被求值/登记两次）。
 */
const FRESHNESS_EXECUTION_SOURCE = "client-freshness.js";

/** 唯一 ModuleLoader descriptor（client.js）恒为装配顺序的最后一项，避免 HMR 留下重复子模块工厂。 */
const DESCRIPTOR_EXECUTION_SOURCE = "client-entry.js";

/**
 * ① 装配顺序：51 个 IIFE → freshness 投影 → 唯一 descriptor。
 *
 * 消费者：`scripts/assemble-client.mjs`（决定段序与 sourceNames）、
 * `test/bundle-size-gate.test.mjs`（段序断言的期望值）、
 * `test-support/client-bundle.mjs` 的 source 模式（按此顺序依次加载各 IIFE）。
 *
 * 为什么固定成"完整数组"而不是"三份局部常量"：装配顺序是**唯一**的装载契约，
 * 任何一处局部重排都会让产物与 source 模式替身分叉，而分叉只会在后续批次里以
 * "某个模块的 globalThis 检查点不存在"这种间接症状暴露。
 */
export const assemblyOrder = Object.freeze([
  ...IIFE_EXECUTION_ORDER,
  FRESHNESS_EXECUTION_SOURCE,
  DESCRIPTOR_EXECUTION_SOURCE,
]);

/** 装配顺序的前半段（IIFE 执行顺序：模型 / 侧栏辅助服务 / Panel 状态、视图与动作面 / install 编排 / 通知 / 模型配置 / R8 客户端模块），供 source 模式与段序校验按语义取值，而不是按下标切片。 */
export const iifeSources = IIFE_EXECUTION_ORDER;

/** descriptor 与 freshness 的显式命名：装配器不得靠"倒数第二/倒数第一"猜角色。 */
export const freshnessSource = FRESHNESS_EXECUTION_SOURCE;
export const descriptorSource = DESCRIPTOR_EXECUTION_SOURCE;

/**
 * ② 语法检查集合：构建时 `node --check` 的客户端装配输入。
 *
 * 值**直接复用** `scripts/client-sources.mjs` 的 `CLIENT_SOURCE_FILES`（同一份冻结数组，
 * 不复制第二份）：那份清单同时被 `scripts/check-module-size.mjs` 的行数统计范围使用。
 * 消费者：`scripts/build.mjs`（与 BUILD_SCRIPT_FILES 合并后逐个 `node --check`）。
 *
 * 为什么不能各写一份：files 收敛（装配输入不发布）之后，语法覆盖面只能靠显式清单维持；
 * 两份清单一旦漂移，某个源文件会在"被检查"与"被统计"之间凭空消失。
 */
export const syntaxCheckSources = CLIENT_SOURCE_FILES;

/**
 * ③ 通知 marker 扫描集合：断言"客户端投递面整体移除"时要逐字扫描的文件。
 *
 * 取值形状与现状一致：6 个装配源（顺序同 CLIENT_SOURCE_FILES）+ 发布产物 `client-bundle.js`。
 * 消费者：`test/notification-popup-channel.test.mjs` 的静态用例（它按此集合逐个读文件、
 * 断言 REMOVED_MARKERS 一个都不出现）。
 *
 * 为什么清单里要含构建产物：只扫源文件会漏掉"压缩/拼接阶段把标记带回来"的路径；
 * 只扫产物又会让失败定位退化成一整份 670KB 文本。两者都要扫。
 */
export const scanSources = Object.freeze([...CLIENT_SOURCE_FILES, "client-bundle.js"]);

/**
 * ④ IIFE 依赖边：显式声明"提供方 -> 读取方"，方向与 `collectIifeDependencyEdges` 一致。
 *
 * - `from`：provides 了 `Symbol.for("dsh-expert-group/<name>")` 的文件（被依赖方）；
 * - `to`：读取同一个 Symbol 的文件（依赖方）；
 * - `symbols`：构成这条边的 Symbol 名（去重升序，与扫描结果同口径）；
 * - `via`：边的来源标记，与扫描实现保持一致，便于"声明 vs 扫描"逐项比较。
 *
 * 消费者：`scripts/check-dependency-graph.mjs` 的 C1（客户端 IIFE 边入图，否则"无环"是假绿）。
 * 这个文件本身**不声明**任何副作用：清单只描述"谁依赖谁"，不做扫描、不读源码。
 *
 * 为什么声明与扫描要并存：声明是装配意图的**可审计事实源**（改装配必须同步改这里），
 * 扫描（`collectIifeDependencyEdges`）是同一意图在源码里留下的**证据**。
 * 两者必须逐项相等——不一致说明"意图"与"实现"打架，这比任何一侧单独通过都更值得失败。
 * 对真实仓库两侧的等价性由 `test/dependency-graph-gate.test.mjs` 持续校验。
 */
export const iifeDependencies = Object.freeze([
  // R8（票据 29）：专家组模型拆为 normalize / format 两个子模块后新增的真实边（方向仍是
  // 「提供方 -> 读取方」）。normalize 被 format 与门面读取；format 被门面读取；两个子模块都
  // 不读取门面或任何其它兄弟 IIFE，因此客户端 IIFE 图仍无环。原有三条出边
  // （模型 -> sidebar-pure / text / descriptor）保持不变。
  Object.freeze({
    from: "client-expert-group-model-normalize.js",
    to: "client-expert-group-model-format.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-expert-group-model-normalize.js",
    to: "client-expert-group-model.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-expert-group-model-format.js",
    to: "client-expert-group-model.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model-format"]),
    via: "iife-symbol",
  }),
  // R6.5（票据 26b）：Panel 组件本体拆出后，边的事实源重新按「真实读取方」登记。
  // 关键变化（对照 R6-22/23/24 的旧边）：
  // - Panel 状态 / 视图 / 动作面的检查点不再被主 sidebar 读取，改由 client-sidebar-panel.js
  //   或对应的 Hook 模块读取；
  // - 主 sidebar 只剩 4 条入边：pure（BRAND_ICON_PATHS）、dom（createBrandIcon）、panel、
  //   install-resources（coordinator）；
  // - 4 个 Hook 模块各自提供检查点给 panel（panel 在加载期取回 Hook 函数）。
  // 本清单与 collectIifeDependencyEdges 的扫描结果逐项相等，由 test/dependency-graph-gate.test.mjs 校验。
  Object.freeze({
    from: "client-expert-group-model.js",
    to: "client-sidebar-pure.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-expert-group-model.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-expert-group-sidebar.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-sidebar"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-actions.js",
    to: "client-sidebar-panel-hooks-tabs.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-actions"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-controller.js",
    to: "client-sidebar-panel-hooks-tabs.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-controller"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-ledger.js",
    to: "client-sidebar-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-ledger"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-ledger.js",
    to: "client-sidebar-auto-controller.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-ledger"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-ledger.js",
    to: "client-sidebar-panel-hooks-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-ledger"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-ledger.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-ledger"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-auto-ledger.js",
    to: "client-sidebar-pure.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-auto-ledger"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-expert-group-sidebar.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-auto-controller.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-install-expand.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-install-target.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-install-width.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-layout.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-panel-hooks-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-panel-hooks-effects.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-panel-hooks-tabs.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-split-sync.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-tab-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-views-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-views-b.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-dom.js",
    to: "client-sidebar-views-c.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-dom"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-install-expand.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-install-expand"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-install-layout.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-install-layout"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-install-resources.js",
    to: "client-expert-group-sidebar.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-install-resources"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-install-target.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-install-target"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-install-width.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-install-width"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-layout.js",
    to: "client-sidebar-install-layout.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-layout"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-overlay.js",
    to: "client-sidebar-install-layout.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-overlay"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-cache.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-cache"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-hooks-actions.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-hooks-actions"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-hooks-effects.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-hooks-effects"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-hooks-state.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-hooks-state"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-hooks-tabs.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-hooks-tabs"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-state-a.js",
    to: "client-sidebar-panel-hooks-effects.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-state-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-state-a.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-state-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-state-a.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-state-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel-state-b.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel-state-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-panel.js",
    to: "client-expert-group-sidebar.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-panel"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-poll.js",
    to: "client-sidebar-panel-hooks-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-poll"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-poll.js",
    to: "client-sidebar-panel-hooks-effects.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-poll"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-poll.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-poll"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-poll.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-poll"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-expert-group-sidebar.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-auto-controller.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-dom.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-install-expand.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-install-layout.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-install-resources.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-install-target.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-install-width.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-layout.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-hooks-actions.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-hooks-effects.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-hooks-tabs.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-state-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel-state-b.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-poll.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-split-sync.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-tab-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-views-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-views-b.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-pure.js",
    to: "client-sidebar-views-c.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-pure"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-split-sync.js",
    to: "client-sidebar-panel-hooks-state.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-split-sync"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-tab-state.js",
    to: "client-sidebar-panel-hooks-tabs.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-tab-state"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-views-a.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-views-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-views-b.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-views-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-sidebar-views-c.js",
    to: "client-sidebar-panel.js",
    symbols: Object.freeze(["dsh-expert-group/client-sidebar-views-c"]),
    via: "iife-symbol",
  }),
  // R8（票据 26）：client.js 的 descriptor 工厂作用域外移出 9 个客户端模块后新增的真实边。
  // 方向仍是「提供方 -> 读取方」：每个新模块各自提供检查点给 descriptor（descriptor 取回
  // 实现并注入运行期宿主面），另有 text→main-a、normalize→main-a/main-b、native-status→
  // settings-normalize/subagent-metadata、main-b→main-a、model-config→model-config-host 六条
  // 模块之间的真实读取边。声明与扫描逐项相等由 test/dependency-graph-gate.test.mjs 校验。
  Object.freeze({
    from: "client-expert-group-model.js",
    to: "client-text.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-model"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-fanout-normalize.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-fanout-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config-host.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-host"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config.js",
    to: "client-model-config-host.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config"]),
    via: "iife-symbol",
  }),
  // R8（票据 28）：模型配置拆为 paths / rows 后新增的真实边（方向仍是「提供方 -> 读取方」）。
  // paths 被 rows 与门面同时读取；rows 只被门面读取；三者都没有反向边（paths 不读任何兄弟
  // IIFE，rows 不读门面），因此客户端 IIFE 图仍无环。声明与扫描逐项相等由
  // test/dependency-graph-gate.test.mjs 校验。
  Object.freeze({
    from: "client-model-config-paths.js",
    to: "client-model-config-rows.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-paths"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config-paths.js",
    to: "client-model-config.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-paths"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config-rows.js",
    to: "client-model-config.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-rows"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-native-status.js",
    to: "client-settings-normalize.js",
    symbols: Object.freeze(["dsh-expert-group/client-native-status"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-native-status.js",
    to: "client-subagent-metadata.js",
    symbols: Object.freeze(["dsh-expert-group/client-native-status"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-native-status.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-native-status"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-main-a.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-main-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-main-b.js",
    to: "client-settings-main-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-main-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-main-b.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-main-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-normalize.js",
    to: "client-settings-main-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-normalize.js",
    to: "client-settings-main-b.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-normalize.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-styles.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-styles"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-subagent-metadata.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-subagent-metadata"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-text.js",
    to: "client-settings-main-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-text"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-text.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-text"]),
    via: "iife-symbol",
  }),
  // R8（票据 27）：模型视图、焦点归还、conversation 适配、导航图标与插件详情拆出后的真实边。
  // 方向仍是「提供方 -> 读取方」：views-b 提供弹窗组件与候选选择纯函数给 views-a /
  // provider-card / model-section；model-config-host 提供常量给 provider-card 与 model-section；
  // nav-icon 提供 section id 给 plugin-detail；7 个模块各自把检查点提供给 descriptor。
  Object.freeze({
    from: "client-model-views-b.js",
    to: "client-model-views-a.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-views-b.js",
    to: "client-provider-card.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-views-b.js",
    to: "client-model-section.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-views-a.js",
    to: "client-model-section.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-provider-card.js",
    to: "client-model-section.js",
    symbols: Object.freeze(["dsh-expert-group/client-provider-card"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-focus-return.js",
    to: "client-model-section.js",
    symbols: Object.freeze(["dsh-expert-group/client-focus-return"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config-host.js",
    to: "client-provider-card.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-host"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-config-host.js",
    to: "client-model-section.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-config-host"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-expert-group-sidebar.js",
    to: "client-nav-icon.js",
    symbols: Object.freeze(["dsh-expert-group/client-expert-group-sidebar"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-native-status.js",
    to: "client-plugin-detail.js",
    symbols: Object.freeze(["dsh-expert-group/client-native-status"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-settings-normalize.js",
    to: "client-plugin-detail.js",
    symbols: Object.freeze(["dsh-expert-group/client-settings-normalize"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-nav-icon.js",
    to: "client-plugin-detail.js",
    symbols: Object.freeze(["dsh-expert-group/client-nav-icon"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-views-a.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-a"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-views-b.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-views-b"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-provider-card.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-provider-card"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-model-section.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-model-section"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-conversation-adapters.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-conversation-adapters"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-nav-icon.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-nav-icon"]),
    via: "iife-symbol",
  }),
  Object.freeze({
    from: "client-plugin-detail.js",
    to: "client-entry.js",
    symbols: Object.freeze(["dsh-expert-group/client-plugin-detail"]),
    via: "iife-symbol",
  }),
]);
