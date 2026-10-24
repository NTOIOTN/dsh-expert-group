/**
 * 客户端装配源清单的**单一事实源**（R0）。
 *
 * 背景（沿用 build.mjs 原有注释语义）：package.json `files` 不再发布 client.js / client-*.js
 * 这些**装配输入**（体积收敛，安装面只需要装配产物），但"没发布"不等于"可以不检查"——
 * 它们仍然是构建的输入。之前 `node --check` 的覆盖面来自 files+exports+bin 的并集，
 * 收敛 files 后覆盖面会悄悄缩水，所以需要一份显式清单把不发布、但必须保持可解析的文件
 * 列出来。
 *
 * 为什么单独成模块：这份清单现在有两个消费者——
 *   1. `scripts/build.mjs`：决定哪些"不发布但参与装配"的源文件要过 `node --check`；
 *   2. `scripts/check-module-size.mjs`：行数门禁的统计范围并集（客户端装配输入按体积
 *      收敛策略不发布，只按 package.json `files` 枚举会漏掉 4 个超限客户端文件）。
 * 规格书 §行数门禁的统计范围要求两者**共同导入同一份清单**，不得各复制一份。
 *
 * 为什么不能直接 import `scripts/build.mjs`：那个模块顶层会执行真实构建（装配、体积门禁、
 * CLI smoke），import 它就是跑一次构建。本模块因此**只导出一个冻结数组**：没有顶层副作用、
 * 不 import 任何会触发构建的模块、不读文件系统、不写文件。
 *
 * 修改约束：新增/删除装配源时必须同步改这里；数组顺序不参与装配（装配顺序由
 * `scripts/client-source-manifest.mjs` 的 `assemblyOrder` 决定，本模块经它的
 * `syntaxCheckSources` 间接提供给构建），这里保持与构建脚本语法检查集合一致的可读顺序。
 *
 * 依赖方向固定为 **manifest -> client-sources**：本模块不得 import manifest（否则成环），
 * 装配顺序的新增/调整只在 manifest 里做。
 */
export const CLIENT_SOURCE_FILES = Object.freeze([
  "client-entry.js",
  "client-notifications.js",
  // R8（票据 29）：专家组模型拆出的 normalize / format 两个子模块（门面 client-expert-group-model.js
  // 保留）。三者都是装配输入：既要有 node --check，也要进入行数门禁的统计范围。
  "client-expert-group-model-normalize.js",
  "client-expert-group-model-format.js",
  "client-expert-group-model.js",
  // R5（票据 21）：侧栏辅助服务拆出的 5 个 IIFE 也是装配输入，必须进来，
  // 否则它们既不参与 node --check，也不进行数门禁的统计范围（"没发布≠不检查"）。
  "client-sidebar-auto-ledger.js",
  "client-sidebar-pure.js",
  "client-sidebar-dom.js",
  "client-sidebar-poll.js",
  "client-sidebar-layout.js",
  // R6（票据 22）：Panel 状态、工厂级快照缓存、tab 记账与 split 同步拆出的 IIFE。
  "client-sidebar-panel-cache.js",
  "client-sidebar-split-sync.js",
  "client-sidebar-tab-state.js",
  "client-sidebar-panel-state-a.js",
  "client-sidebar-panel-state-b.js",
  // R6（票据 23）：Panel 视图层三组子视图 + 原生右栏连续性遮罩拆出的 IIFE。
  "client-sidebar-views-a.js",
  "client-sidebar-views-b.js",
  "client-sidebar-views-c.js",
  // R6（票据 24）：Panel 自动打开 / 预算 / 关闭租约，以及手动开关与副作用复核拆出的 IIFE。
  "client-sidebar-auto-controller.js",
  "client-sidebar-actions.js",
  "client-sidebar-overlay.js",
  // R7（票据 25）：install 段拆出的 5 个 IIFE（layout / width / expand / target / resources）。
  // 它们同样是装配输入：既要有 node --check，也要进入行数门禁的统计范围。
  "client-sidebar-install-layout.js",
  "client-sidebar-install-width.js",
  "client-sidebar-install-expand.js",
  "client-sidebar-install-target.js",
  "client-sidebar-install-resources.js",
  // R6.5（票据 26b）：Panel 组件本体与 4 个自定义 Hook 模块也是装配输入。
  "client-sidebar-panel-hooks-state.js",
  "client-sidebar-panel-hooks-effects.js",
  "client-sidebar-panel-hooks-tabs.js",
  "client-sidebar-panel-hooks-actions.js",
  "client-sidebar-panel.js",
  "client-expert-group-sidebar.js",
  // R8（票据 28）：「模型配置」区域拆出的 paths / rows 子模块同样是装配输入
  // （既要有 node --check，也要进入行数门禁的统计范围；门面 client-model-config.js 保留）。
  "client-model-config-paths.js",
  "client-model-config-rows.js",
  "client-model-config.js",
  // R8（票据 26）：client.js 的 descriptor 工厂作用域外移出的 9 个客户端模块。
  // 它们是装配输入（descriptor 从各自检查点取回实现），必须参与 node --check 与行数门禁。
  "client-text.js",
  "client-styles.js",
  "client-fanout-normalize.js",
  "client-native-status.js",
  "client-settings-normalize.js",
  "client-model-config-host.js",
  "client-subagent-metadata.js",
  "client-settings-main-b.js",
  "client-settings-main-a.js",
  // R8（票据 27）：模型视图、provider 卡片、焦点归还、模型区域、conversation 适配、
  // 导航图标与插件详情拆出的 8 个 IIFE。它们同样是装配输入（既过 node --check，也进行数门禁）。
  "client-model-views-b.js",
  "client-model-views-a.js",
  "client-provider-card.js",
  "client-focus-return.js",
  "client-model-section.js",
  "client-conversation-adapters.js",
  "client-nav-icon.js",
  "client-plugin-detail.js",
  // client-freshness.js 仍是公开导出的运行时模块（exports["./client-freshness"]），
  // 出现在这里是为了让"装配源全集"只有一处清单，避免再按 files 推断。
  "client-freshness.js",
]);
