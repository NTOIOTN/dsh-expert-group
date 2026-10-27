/**
 * 会话删除的可见层（票据 06/07）：文案选择、图标与全部渲染片段。
 *
 * ## 边界
 * 本模块**只有纯渲染**：输入是「已经算好的视图数据 + 文案函数 + 回调」，输出是 React 元素。
 * 它不持有状态、不订阅任何 store、不发 RPC、不注册插槽——那些都在
 * client-session-delete-ui.js。这样拆是为了让「长什么样」与「什么时候是什么状态」各自
 * 可测：渲染用例只比对可见文本/属性/禁用态，状态机用例只比对状态转移。
 *
 * ## 复用既有视觉语言（不另造弹窗样式）
 * 三种弹窗（确认 / 不可删除说明 / 一次性结果）共用 client-model-section.js 的破坏性确认骨架：
 * deg_prompt_dialog_backdrop / deg_prompt_dialog / deg_btn、data-deg-dialog-action、
 * 默认焦点落在弹窗的首个按钮（确认框是「取消」，说明与结果弹窗是「关闭」）、
 * Escape/遮罩/取消三路守卫、in-flight 禁用、错误行 role=alert。
 * 焦点环复用 client-model-views-b.js 的 focusableDialogControls（同一份可聚焦判定）。
 *
 * ## 执行后不留常驻反馈（票据 09 口径）
 * 本模块没有任何「结算条 / 结果提示卡 / 常驻通知」的渲染路径：成功一律静默。只有「有目标没
 * 删掉」（failed / skipped / raced）或「请求本身失败」时，才渲染一次性结果弹窗（同一套弹窗
 * 骨架，只有「关闭」一个按钮，看过即关、没有重试）。
 *
 * ## 文案
 * 全部用户可见文案来自 shared/i18n.js 的 MESSAGE_CATALOG（本模块经
 * client-expert-group-model 检查点的 translateMessage 读取同一张表），键前缀统一为
 * sidebar.sessionDelete.*。缺失键由消息表回退，绝不渲染键名。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-session-delete-view")]。
 */
(function installSessionDeleteView(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-session-delete-view");
  const MODEL_SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");
  const FOCUS_SYMBOL = Symbol.for("dsh-expert-group/client-model-views-b");

  /** 确认框标题元素的固定 id：aria-labelledby 与标题元素必须指向同一个节点。 */
  const DIALOG_TITLE_ID = "deg_session_delete_dialog_title";

  /** 阻塞原因 → 文案键（live 之外都要说清「怎么做」）。 */
  const BLOCK_KEYS = Object.freeze({
    live: "sidebar.sessionDelete.blocked.live",
    "live-descendant": "sidebar.sessionDelete.blocked.liveDescendant",
    "pending-cleanup": "sidebar.sessionDelete.blocked.pending",
    missing: "sidebar.sessionDelete.blocked.missing",
  });

  /** 「行仍保留」的三态 → 原因文案键（一次性结果弹窗用它说明为什么没删掉）。 */
  const ROW_REASON_KEYS = Object.freeze({
    skipped: "sidebar.sessionDelete.reason.skipped",
    failed: "sidebar.sessionDelete.reason.failed",
    raced: "sidebar.sessionDelete.reason.raced",
  });

  /** 渲染层读取的运行时依赖：locale 解析与文案表都来自模型检查点（缺失时安全占位）。 */
  function modelApi() {
    return global[MODEL_SYMBOL] ?? {};
  }

  /** 焦点环：与既有确认弹窗共用同一份「真正可聚焦」判定。 */
  function focusApi() {
    return global[FOCUS_SYMBOL] ?? {};
  }

  /**
   * 宿主语言解析顺序：ctx.locale → ctx.i18n.locale → document lang → navigator.language → zh。
   * 与侧栏面板（client-sidebar-panel-state-a.js）同一口径，绝不另写第二套判定。
   */
  function resolveLocale(ctx) {
    const model = modelApi();
    const sources = {
      ctxLocale: (() => { try { return ctx?.locale; } catch { return undefined; } })(),
      i18nLocale: (() => { try { return ctx?.i18n?.locale; } catch { return undefined; } })(),
      documentLang: (() => { try { return globalThis.document?.documentElement?.lang; } catch { return undefined; } })(),
      navigatorLanguage: (() => { try { return globalThis.navigator?.language; } catch { return undefined; } })(),
    };
    if (typeof model.resolveClientLocale === "function") return model.resolveClientLocale(sources);
    return "zh";
  }

  /**
   * 建立文案函数 t(key, vars)。
   *
   * 每次调用现读 locale（语言切换后无需重装界面），模型缺失时返回中性占位而不是键名或空串。
   * 只做一次 ctx 捕获，不缓存 locale 结果——缓存会让语言切换后已挂载的界面停在旧语言。
   */
  function deleteTranslator(ctx) {
    return function translate(key, vars) {
      const model = modelApi();
      if (typeof model.translateMessage !== "function") return "—";
      return model.translateMessage(resolveLocale(ctx), key, vars);
    };
  }

  /**
   * 「不可删除」的原因与做法（用户故事 12/13）。
   *
   * 被占用时指名阻塞者：live-descendant 的阻塞者是某个子会话，标题优先、缺失时退回 ID，
   * 两者都没有就说不指名（绝不编一个会话名）。
   */
  function blockedReasonText(t, blockedBy) {
    const kind = typeof blockedBy?.kind === "string" ? blockedBy.kind : "missing";
    const key = BLOCK_KEYS[kind] ?? BLOCK_KEYS.missing;
    if (kind === "live-descendant") {
      const name = typeof blockedBy?.title === "string" && blockedBy.title.length > 0
        ? blockedBy.title
        : (typeof blockedBy?.sessionId === "string" ? blockedBy.sessionId : "");
      return t(key, { title: name.length > 0 ? name : "—" });
    }
    return t(key);
  }

  /**
   * 一次性结果弹窗的一句话（票据 09 口径）：只说「删掉了几个、还剩几个、为什么」。
   *
   * - 只列**非零**项：成功一律静默，这句话只在「有目标没删掉」或「请求本身失败」时才会被
   *   请求，因此不会出现「已删除 0 个」这类凑数成分；
   * - absent（仅清理残留）单列，绝不并进「已删除」：确认框刚刚才把两者分开说过，
   *   同一轮里的两个界面不能对同一件事各说一套；
   * - 未删除的原因按固定顺序（skipped → failed → raced）列出，同一原因只说一次；
   * - 全部计数都为 0 时返回空串，调用方据此不渲染任何空行。
   *
   * @param {(key: string, vars?: object) => string} t - 文案函数。
   * @param {object} counts - 五态计数（deleted / absent / skipped / failed / raced）。
   * @returns {string} 形如「已删除 3 个，1 个未删除：仍被占用」的一句话。
   */
  function outcomeSentence(t, counts) {
    const parts = [];
    const deleted = Number.isFinite(counts?.deleted) ? counts.deleted : 0;
    const absent = Number.isFinite(counts?.absent) ? counts.absent : 0;
    const reasons = [];
    let kept = 0;
    for (const stateName of ["skipped", "failed", "raced"]) {
      const count = Number.isFinite(counts?.[stateName]) ? counts[stateName] : 0;
      if (count <= 0) continue;
      kept += count;
      reasons.push(t(ROW_REASON_KEYS[stateName]));
    }
    if (deleted > 0) parts.push(t("sidebar.sessionDelete.outcome.deleted", { count: deleted }));
    if (absent > 0) parts.push(t("sidebar.sessionDelete.outcome.absent", { count: absent }));
    if (kept > 0) {
      parts.push(t("sidebar.sessionDelete.outcome.kept", {
        count: kept,
        reasons: reasons.join(t("sidebar.sessionDelete.outcome.reasonJoin")),
      }));
    }
    return parts.join(t("sidebar.sessionDelete.outcome.join"));
  }

  /**
   * 垃圾桶图标：复用宿主 primitives（规格决策 42），颜色由按钮的 CSS 决定。
   * primitives 缺失时返回 null——按钮仍带 aria-label 与 tooltip，语义不依赖图标。
   */
  function trashIcon(create, primitives) {
    const Icon = primitives?.IconTrashOutlineRegular;
    return typeof Icon === "function" ? create(Icon, { className: "deg_sd_icon" }) : null;
  }

  /**
   * 「全选」图标：一个干净的勾。
   *
   * 旧的三勾在方框里只有 13px 的绘制面积，实际渲染出来是三条糊在一起的斜线；单勾在同样
   * 尺寸下仍然锐利，而且「勾 = 选中」比「三笔勾」更直接。方形按钮本身就是那个复选框，
   * 图标只负责说明「点一下会选中」。
   */
  function selectAllIcon(create) {
    return create("svg", {
      className: "deg_sd_icon", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false",
      fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round",
    },
      create("path", { d: "M2.6 8.4 6.2 12 13.4 3.6" }));
  }

  /**
   * 「取消全选」图标：实心方框 + 反色勾。
   *
   * 与「全选」的区别靠**形状**（实心块 + 反色勾 vs 线描单勾），不靠颜色深浅——深色主题下
   * 颜色差异本来就弱，形状差异才是「再点一下会取消」的可靠线索。
   *
   * 反色勾用 --dsw-alias-bg-layer-1（浅色主题是白、深色主题是底层的深色），绝不写死 #fff：
   * 写死会在深色主题里画出「白块 + 白勾」的隐形图标。方块用 currentColor，由按钮的按下态
   * 把颜色提到 label-primary，两种主题下对比度都由宿主变量保证。
   */
  function selectAllActiveIcon(create) {
    return create("svg", {
      className: "deg_sd_icon", viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false",
      fill: "none",
    },
      create("rect", { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2.4, fill: "currentColor" }),
      create("path", {
        d: "M5 8.2 7 10.2 11 5.8", fill: "none",
        stroke: "var(--dsw-alias-bg-layer-1)", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
      }));
  }

  /** 关闭图标：宿主 primitives 优先；缺失时用字符占位（按钮仍有 aria-label）。 */
  function closeIcon(create, primitives) {
    const Icon = primitives?.IconCloseOutlineRegular;
    return typeof Icon === "function" ? create(Icon, { className: "deg_sd_icon" }) : create("span", { "aria-hidden": "true" }, "\u2715");
  }

  /**
   * 行尾悬停按钮（order 300，排在归档 100 / 置顶 200 之后）。
   *
   * 只渲染一个图标按钮：宿主行尾的 rowActions 区自带 hover 显隐，因此「悬停才出现」不需要
   * 我们另写 CSS；tooltip 与 aria-label 用同一句「删除会话「标题」」。
   */
  function renderRowActionButton(create, primitives, t, options) {
    const label = t("sidebar.sessionDelete.row.aria", { title: options.title });
    return create("button", {
      type: "button",
      className: "deg_sd_row_action",
      title: label,
      "aria-label": label,
      disabled: options.disabled === true,
      "data-deg-session-delete-row": "true",
      onClick: options.onClick,
    }, trashIcon(create, primitives));
  }

  /**
   * 会话「⋯」菜单行：单条删除与多选入口共用一份渲染，两者都走危险色 + 垃圾桶图标。
   *
   * 多选入口只是「进入多选模式」，本身不立即删除；视觉上仍与「删除会话」保持同格式，
   * 这是用户明确要求的一致化（不做二次确认，语义仍由后续的确认框承担）。
   * 真实宿主用 primitives 的 MenuItemButton（自带 danger 语义与键盘行走）；缺失时退回一个
   * 等价的 role=menuitem 按钮（同样带图标），保证宿主没有 primitives 时菜单仍可用。
   */
  function renderMenuItem(create, primitives, t, options) {
    const MenuItemButton = primitives?.MenuItemButton;
    if (typeof MenuItemButton === "function") {
      return create(MenuItemButton, {
        ...(options.danger === true ? { danger: true, icon: trashIcon(create, primitives) } : {}),
        disabled: options.disabled === true,
        onSelect: options.onSelect,
      }, options.label);
    }
    return create("button", {
      type: "button",
      role: "menuitem",
      className: options.danger === true ? "deg_sd_menu_item deg_sd_danger" : "deg_sd_menu_item",
      disabled: options.disabled === true,
      [options.attribute]: "true",
      onClick: options.onSelect,
    }, options.danger === true ? trashIcon(create, primitives) : null, options.label);
  }

  /**
   * 行首勾选框（宿主 16px 行首席位）。
   *
   * 用原生 input[type=checkbox]：键盘、读屏与「已勾选」语义都由浏览器提供，不必自造
   * role=checkbox 的键位。点击与按键都在这里 stopPropagation，避免冒泡到行打开会话。
   */
  function renderLeadingCheckbox(create, t, options) {
    const label = t("sidebar.sessionDelete.checkbox.aria", { title: options.title ?? "—" });
    return create("input", {
      type: "checkbox",
      className: "deg_sd_check",
      checked: options.checked === true,
      disabled: options.disabled === true,
      "aria-label": label,
      title: label,
      "data-deg-session-delete-check": "true",
      onClick: (event) => { event?.stopPropagation?.(); },
      onKeyDown: (event) => { event?.stopPropagation?.(); },
      onChange: options.onToggle,
    });
  }

  /**
   * 侧栏顶部的操作条（多选模式）。
   *
   * 层级与密度：一行 22px 控件，分成左右两组——**文字组**（已选 N / 另有 M 个被占用）在左，
   * **按钮组**（全选 · 删除 · 退出）在右，全选紧贴删除左侧。按钮组靠 `.deg_sd_selectall` 的
   * margin-left:auto 整段推到行尾（有被占用文案时那片空白由它吸收），全选因此不再是「文字
   * 旁边的小图标」，而是一眼可点的方形按钮。
   *
   * 全选按钮是**开关**（语义见 client-session-delete-selection.js 的 toggleSelectAllActionable）：
   * 未全选时图标为单勾、文案「全选」；已全选时换实心方框+勾、描边转实线并加浅底、文案
   * 「取消全选」。禁用条件不变：结算中或可处理目标为 0（空工作区点它只是空操作）。
   * 删除按钮在未选中时禁用。操作条**没有第二行**：执行后不再有结算条，失败信息交给一次性
   * 结果弹窗（票据 09 口径）。
   */
  function renderBar(create, primitives, t, view) {
    const counts = view.counts ?? {};
    const blocked = Number.isFinite(counts.blocked) ? counts.blocked : 0;
    const busy = view.busy === true;
    const allSelected = counts.allSelected === true;
    // 文案随状态变化：已全选时按钮的点击语义是「取消全选」，aria-label 与 title 必须同步，
    // 否则读屏/悬浮提示会告诉用户一个与真实行为相反的动作。
    const selectAllLabel = t(allSelected
      ? "sidebar.sessionDelete.bar.deselectAll"
      : "sidebar.sessionDelete.bar.selectAll");
    const deleteLabel = t("sidebar.sessionDelete.menu");
    const exitLabel = t("sidebar.sessionModel.close");
    return create("div", {
      className: "deg_sd_bar",
      role: "toolbar",
      "aria-label": t("sidebar.sessionDelete.menu"),
      "data-deg-session-delete-bar": "true",
      style: view.style,
    },
      create("span", {
        className: "deg_sd_count", "aria-live": "polite", "data-deg-session-delete-count": "true",
      }, t("sidebar.sessionDelete.bar.selected", { count: Number.isFinite(counts.selected) ? counts.selected : 0 })),
      blocked > 0 ? create("span", {
        className: "deg_sd_blocked",
        "data-deg-session-delete-blocked": "true",
      }, t("sidebar.sessionDelete.bar.blocked", { count: blocked })) : null,
      create("button", {
        type: "button",
        className: "deg_sd_btn deg_sd_selectall",
        title: selectAllLabel,
        "aria-label": selectAllLabel,
        "data-deg-session-delete-selectall": "true",
        // 状态属性同时服务两件事：样式钩子（已全选 = 实线描边 + 浅底）与用例断言。
        "data-deg-session-delete-selectall-state": allSelected ? "all" : "idle",
        disabled: busy || !(counts.actionable > 0),
        onClick: view.onSelectAll,
      }, allSelected ? selectAllActiveIcon(create) : selectAllIcon(create)),
      create("button", {
        type: "button", className: "deg_sd_btn deg_sd_danger", "aria-label": deleteLabel,
        "data-deg-session-delete-delete": "true",
        disabled: busy || counts.deletable !== true,
        onClick: view.onDelete,
      }, trashIcon(create, primitives)),
      create("button", {
        type: "button", className: "deg_sd_btn", "aria-label": exitLabel,
        "data-deg-session-delete-exit": "true",
        onClick: view.onExit,
      }, closeIcon(create, primitives)));
  }

  /**
   * 三种弹窗（确认 / 不可删除说明 / 一次性结果）共用同一套骨架与同一套守卫，语义逐条照搬。
   *
   * - 默认焦点在首个按钮（autoFocus）：确认框是「取消」（破坏性动作绝不抢默认焦点），
   *   说明与结果弹窗是「关闭」；
   * - 遮罩、Escape、首按钮三条路径都只关弹窗；请求在途（running）时三条全部拒收；
   * - Tab / Shift+Tab 只在弹窗内真正可聚焦的控件之间循环；
   * - 结果弹窗只有「关闭」一个按钮：它只陈述已经发生的事实，既没有重试也没有常驻入口。
   */
  function renderDialog(create, t, view, handlers) {
    if (view === null) return null;
    const running = view.running === true;
    const onCancel = () => { if (running !== true) handlers.onCancel(); };
    return create("div", {
      className: "deg_prompt_dialog_backdrop",
      onClick: onCancel,
    },
      create("div", {
        className: "deg_prompt_dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": DIALOG_TITLE_ID,
        "data-deg-session-delete-dialog": view.kind,
        ref: handlers.dialogRef,
        onClick: (event) => event?.stopPropagation?.(),
        onKeyDown: (event) => handleDialogKeyDown(event, view, handlers),
      },
        create("h3", { id: DIALOG_TITLE_ID }, view.title),
        create("p", { className: "deg_sd_dialog_line" }, view.lines.join("\n")),
        view.error === null || view.error === undefined ? null : create("p", {
          className: "deg_remove_confirm_error", role: "alert", "aria-live": "assertive",
        }, view.error),
        create("div", { className: "deg_prompt_dialog_actions" },
          create("button", {
            type: "button",
            className: "deg_btn",
            "data-deg-dialog-action": "cancel",
            "data-deg-session-delete-cancel": "true",
            autoFocus: true,
            disabled: running,
            onClick: onCancel,
          }, view.kind === "confirm" ? t("sidebar.sessionDelete.dialog.cancel") : t("sidebar.sessionModel.close")),
          view.kind === "confirm" ? create("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            "data-deg-dialog-action": "confirm",
            "data-deg-session-delete-confirm": "true",
            disabled: running,
            onClick: () => { void handlers.onConfirm(); },
          }, running ? t("sidebar.sessionDelete.dialog.running") : t("sidebar.sessionDelete.dialog.confirm")) : null)));
  }

  /** 弹窗内的键位：请求在途时不受理 Escape 与焦点环（此刻关掉弹窗只会掩盖真实结果）。 */
  function handleDialogKeyDown(event, view, handlers) {
    if (view.running === true) return;
    if (event?.key === "Escape") {
      event.preventDefault?.();
      event.stopPropagation?.();
      handlers.onCancel();
      return;
    }
    if (event?.key !== "Tab") return;
    const focusable = focusApi().focusableDialogControls;
    const controls = typeof focusable === "function"
      ? focusable(handlers.dialogRef?.current ?? event?.currentTarget ?? null)
      : [];
    if (!Array.isArray(controls) || controls.length === 0) return;
    const active = typeof document === "undefined" ? null : document.activeElement;
    const current = controls.indexOf(active);
    const nextIndex = event.shiftKey
      ? (current <= 0 ? controls.length - 1 : current - 1)
      : (current >= controls.length - 1 ? 0 : current + 1);
    event.preventDefault?.();
    try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
  }

  global[SYMBOL] = Object.freeze({
    DIALOG_TITLE_ID,
    blockedReasonText,
    deleteTranslator,
    outcomeSentence,
    renderBar,
    renderDialog,
    renderLeadingCheckbox,
    renderMenuItem,
    renderRowActionButton,
  });
})(globalThis);
