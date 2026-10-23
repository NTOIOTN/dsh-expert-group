/**
 * 客户端侧栏 · 安装入口与公开检查点（R6.5 票据 26b 之后的薄门面）
 *
 * 拆分轨迹：
 * - R5–R7 把辅助服务、Panel 状态 / 视图 / 动作面与 install 编排逐个拆成客户端 IIFE；
 * - 本票把 Panel **组件本体**搬进 client-sidebar-panel.js，组件体内部的连续语句段分别落到
 *   4 个自定义 Hook 模块（hooks-state / hooks-effects / hooks-tabs / hooks-actions）。
 *
 * 本文件现在只剩两件不变的事：
 *   1. `createExpertGroupPanel(deps)`：薄委托给 Panel 工厂（Panel 实现只有一处）；
 *   2. `installExpertGroupSidebar(ctx, deps)`：薄委托给 install coordinator（R7 起如此）。
 * 另外继续提供两个与**品牌图标**有关的公开值（设置页导航图标适配会取用）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")]
 */
(function installExpertGroupSidebar(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-sidebar");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    BRAND_ICON_PATHS,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    createBrandIcon,
  } = DOM;
  // R6.5（票据 26b）：Panel 组件本体与它的 4 个自定义 Hook 都已被拆出；本文件只取回工厂入口。
  const PANEL_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel");
  const PANEL = global[PANEL_SYMBOL] || {};
  const { createSidebarPanel } = PANEL;
  // R7（票据 25）：install coordinator（注册时机与顺序 / disposer 栈 / `disposeAll()` 唯一持有者）。
  const INSTALL_RESOURCES_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-install-resources");
  const INSTALL_RESOURCES = global[INSTALL_RESOURCES_SYMBOL] || {};
  const { createSidebarInstallCoordinator } = INSTALL_RESOURCES;

  /**
   * Panel 工厂：公开契约与拆分前逐字相同（`(deps)` 入参、react 缺失时返回空组件）。
   *
   * 实现完全在 client-sidebar-panel.js；这里只转发，使「Panel 实现」只有一个 owner。
   */
  function createExpertGroupPanel(deps) {
    return createSidebarPanel(deps);
  }

  /**
   * 安装入口：**薄委托**（R7 票据 25）。
   *
   * 安装编排（注册时机与顺序、disposer 栈、`disposeAll()` 的唯一持有者）完全由
   * `client-sidebar-install-resources.js` 承担；公开契约（`(ctx, deps)` 入参、返回值 disposeAll）
   * 与关闭「任务管理」时返回幂等 no-op disposer 的语义逐字不变。
   */
  function installExpertGroupSidebar(ctx, deps) {
    return createSidebarInstallCoordinator(ctx, deps, { createExpertGroupPanel });
  }

  global[SYMBOL] = Object.freeze({
    createExpertGroupPanel,
    installExpertGroupSidebar,
    /**
     * 品牌图标 artwork 的**唯一**运行期来源（双人 users 图标，与宿主「智能体团队」入口同源）。
     * client.js 的设置页导航图标适配优先取用它；侧栏模块缺失时才回落到 client.js 内的同值
     * 兜底字面量，两处一致性由测试断言守住。
     */
    BRAND_ICON_PATHS,
    /** 品牌图标组件解析（宿主导出优先、内联 artwork 回落、react 缺失返回 null）。 */
    createBrandIcon,
  });
})(globalThis);
