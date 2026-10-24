/**
 * DEG 左侧栏入口与全页设置面板（客户端装配段）。
 *
 * 背景：DEG 的设置页原本只挂在设置 Shell 的 settings.section ledger 上（必须先打开设置才能看到），
 * 缺少侧栏常驻入口。本模块按已裁决的方案注册两件事：
 * 1. `sidebar.panellist` 列表项（id 与设置分区 id 同值、order = 5），点击后由宿主自己完成
 *    「选中该行 → 主区域渲染同名 main 面板」；插件侧不做 DOM 注入、不调用设置弹窗内部句柄、
 *    不改宿主 CSS 类，折叠态 tooltip 也由宿主按 label 处理；
 * 2. keyed `main` 面板（key 与行 id 相同），内容 = 现有设置页组件外包一层全页滚动容器。
 *
 * 语义要点：
 * - 主面板**始终注册**：取消勾选「左侧栏入口」只卸载侧栏行，用户不会被踢出当前页面，
 *   未保存草稿随组件保留；
 * - 侧栏行按设置动态注册/卸载，读面与「任务管理」同款宽松语义（字段缺失/读取失败 = 开启）；
 * - react 不能在模块求值期解引用：本 IIFE 先于 descriptor 执行，react 由 deps 在运行期传入。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-entry")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientSidebarEntryModule(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-entry");

  /** 侧栏行与主面板的 slot 名：两者成对出现，改一处必须同步另一处。 */
  const DEG_MAIN_SLOT_NAME = "main";
  const DEG_SIDEBAR_PANELLIST_SLOT_NAME = "sidebar.panellist";
  /** 侧栏行顺序：排在宿主内置入口之后、DEG 设置分区（order 25）之前。 */
  const DEG_SIDEBAR_ENTRY_ORDER = 5;
  /** 全页容器的稳定标记：样式规则与测试都读它，不使用宿主 CSS module 的哈希类名。 */
  const DEG_MAIN_PAGE_CLASS = "deg_main_page";
  const DEG_MAIN_PAGE_ATTR = "data-deg-panel-page";
  /** 图标默认边长：宿主侧栏图标与设置页导航同为 16px。 */
  const DEG_PANEL_ICON_SIZE = 16;
  /** 描边宽度：与设置页导航栏其它 Medium 图标一致。 */
  const DEG_PANEL_ICON_STROKE = "1.3";

  /** 幂等 no-op：缺依赖时返回它；重复调用不产生任何副作用。 */
  const noop = () => {};

  /**
   * 安装侧栏入口与主面板。
   *
   * @param {object} ctx 插件上下文（只读取 `slots` 与 `effect`）。
   * @param {object} deps 运行期依赖：`react` / `id` / `iconPaths` / `settingsComponent` /
   *   `settingsForm` / `modelCatalog` / `modelConfigHost`。由 descriptor 在运行期传入，
   *   本模块（先于 descriptor 执行）绝不在求值阶段解引用 react。
   * @returns {() => void} 恒为幂等 no-op：注册生命周期由 slot 声明与 effect 管理，
   *   安装方不需要（也不应该）把返回值当成可复用的 disposer。
   */
  function installDegSidebarEntry(ctx, deps) {
    const react = deps?.react;
    // 任何一步不可用都退化为 no-op（不注册、不抛错）：插件入口还有其它装配段，
    // 不能因为侧栏 slot 缺失就让整条客户端入口失败。
    if (react === null || react === undefined || typeof react.createElement !== "function") return noop;
    const slots = ctx?.slots;
    if (slots === null || slots === undefined
      || typeof slots.inject !== "function" || typeof slots.register !== "function") return noop;
    if (typeof ctx.effect !== "function") return noop;

    const id = deps.id;
    // 只接受字符串路径：形状不对时按空数组处理，DegPanelIcon 仍返回一个合法（空）svg。
    const iconPaths = Array.isArray(deps.iconPaths)
      ? deps.iconPaths.filter((path) => typeof path === "string")
      : [];
    const { settingsComponent, settingsForm, modelCatalog, modelConfigHost } = deps;

    /**
     * 侧栏行图标：与设置页导航同一套双人 users artwork（4 条 path、stroke 1.3、viewBox 16）。
     * 只负责 svg 本身；折叠态与 title/tooltip 由宿主按 label 处理，这里不注入任何提示。
     * iconPaths 为空时返回一个空 svg（仍然合法，渲染不抛错）。
     */
    function DegPanelIcon(props) {
      const size = props?.size ?? DEG_PANEL_ICON_SIZE;
      return react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: DEG_PANEL_ICON_STROKE,
        "aria-hidden": "true",
      }, iconPaths.map((path) => react.createElement("path", {
        key: path,
        d: path,
        stroke: "currentColor",
        fill: "none",
      })));
    }

    /**
     * 全页设置页：外层只负责滚动与留白（.deg_main_page），内层仍是同一个设置页组件，
     * 不复制任何设置页实现；组件挂载/卸载由宿主主区域的生命周期决定。
     */
    function DegSettingsPage(props) {
      return react.createElement("div", {
        className: DEG_MAIN_PAGE_CLASS,
        [DEG_MAIN_PAGE_ATTR]: "true",
      }, react.createElement(props.settingsComponent, {
        settingsForm: props.settingsForm,
        modelCatalog: props.modelCatalog,
        modelConfigHost: props.modelConfigHost,
        ctx: props.ctx,
      }));
    }

    /**
     * 读取「左侧栏入口」开关：唯一来源是配置表单当前快照。
     *
     * 只有显式 false 才算关闭——字段缺失、旧文档、非布尔值与读取异常全部按开启处理，
     * 默认行为因此与引入该开关之前逐字节一致（入口始终可见）。
     */
    function readSidebarEntryEnabled() {
      try {
        const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
        return snapshot?.value?.sidebarEntryEnabled !== false;
      } catch {
        // 读取配置表单异常（服务缺失/未就绪 store）不能让入口消失：按默认开启处理。
        return true;
      }
    }

    // 主面板注册是否已就绪：宿主 selectPanel 对未注册的 main key 会同步抛错，
    // 因此侧栏行必须在 main 注册成功之后才可点击（两个 slot 的声明顺序由宿主决定）。
    let mainReady = false;
    let notifyMainReady = noop;

    // 主面板**始终注册**：取消勾选只是隐藏侧栏入口，用户当前页面与未保存草稿必须保留。
    // 外层 slots.inject 把注册绑定到 slot 声明生命周期；内层 ctx.effect 让测试替身的
    // ctx.dispose() 能真正清理（真实宿主的 slots.inject 会在回调上再包一层 effect）。
    try {
      slots.inject(DEG_MAIN_SLOT_NAME, () => ctx.effect(() => {
        const release = slots.register({
          name: DEG_MAIN_SLOT_NAME,
          key: id,
          inject: () => ({ settingsComponent, settingsForm, modelCatalog, modelConfigHost, ctx }),
        }, DegSettingsPage);
        mainReady = true;
        notifyMainReady();
        return () => {
          mainReady = false;
          notifyMainReady();
          if (typeof release === "function") release();
        };
      }, "dsh-expert-group: settings panel"));
    } catch {
      // 宿主未声明该 slot（或被裁剪的宿主替身）：主面板缺失不影响其余装配段。
    }

    // 侧栏行按设置动态注册/卸载：同一时刻最多一条注册，关闭时调用上次注册返回的 disposer。
    try {
      slots.inject(DEG_SIDEBAR_PANELLIST_SLOT_NAME, () => ctx.effect(() => {
        /** 当前注册返回的释放函数；null = 当前没有注册行（同一时刻最多一次 register）。 */
        let releaseRow = null;
        const installRow = () => {
          if (releaseRow !== null) return;
          const release = slots.register({
            name: DEG_SIDEBAR_PANELLIST_SLOT_NAME,
            id,
            order: DEG_SIDEBAR_ENTRY_ORDER,
            // 宿主把 label 的返回值当作行文本与折叠态 tooltip；这里固定投影成同一个 id。
            label: () => id,
          }, DegPanelIcon);
          releaseRow = typeof release === "function" ? release : noop;
        };
        const uninstallRow = () => {
          const release = releaseRow;
          releaseRow = null;
          if (release === null) return;
          try {
            release();
          } catch {
            // 释放失败不能阻断退订与后续重新注册。
          }
        };
        const sync = () => {
          // main 尚未注册时绝不显示可点击的行：宿主 selectPanel 会对未注册 key 抛错。
          if (mainReady && readSidebarEntryEnabled()) installRow();
          else uninstallRow();
        };
        // main 注册/注销时回推一次，保证「行可点击」与「面板已注册」原子一致。
        notifyMainReady = sync;
        // 初始化先同步读一次快照：缺字段/开启时必须在同步栈内完成注册（与任务管理一致）。
        sync();
        let unsubscribe = noop;
        if (typeof settingsForm?.subscribe === "function") {
          try {
            const release = settingsForm.subscribe(() => {
              try {
                sync();
              } catch {
                // 通知回调抛错不得污染配置表单；保持当前注册状态。
              }
            });
            if (typeof release === "function") unsubscribe = release;
          } catch {
            // 订阅不可用时保持首次快照决定的注册状态。
          }
        }
        return () => {
          if (notifyMainReady === sync) notifyMainReady = noop;
          try {
            unsubscribe();
          } catch {
            // 取消订阅失败不影响卸载入口行。
          }
          unsubscribe = noop;
          uninstallRow();
        };
      }, "dsh-expert-group: sidebar entry"));
    } catch {
      // 宿主未声明该 slot：侧栏入口缺失，其余装配段继续（设置分区仍可打开全页设置页）。
    }

    return noop;
  }

  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    installDegSidebarEntry,
  });
})(globalThis);
