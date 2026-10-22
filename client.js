window.__ModuleLoader__.load({
  id: "dsh-expert-group",
  factory: (require) => {
    /**
     * freshness/RPC 纯逻辑的唯一实现位于 client-freshness.js（浏览器安全 ES 模块）。
     * 本文件是 Host 直接原样下发的 classic bundle，浏览器 classic script 解析不支持
     * import/export，因此这里只保留一个 ModuleLoader adapter：先用 client-freshness
     * 模块自己的登记函数把它放进同一张模块表，再按模块 id 取回唯一实现。
     * 宿主只加载包 exports["./client"] 指向的装配产物（scripts/assemble-client.mjs），
     * 该产物恒含 classic 投影片段，因此共享模块一定先于本 descriptor 登记；client.js
     * 不再内联第二份同语义实现（那份副本让安装体积双份，且两份代码会各自漂移）。
     * 取 specifier 时不做路径归一：DSH 的 require 命中同一张 id 表，只有
     * `<id>/client` 这种 exports 子路径会被 stripClientSuffix 归一。
     */
    const FRESHNESS_MODULE_ID = "dsh-expert-group/client-freshness";
    const freshnessModule = (() => {
      if (typeof require !== "function") return void 0;
      for (const specifier of [FRESHNESS_MODULE_ID, "./" + FRESHNESS_MODULE_ID, "./client-freshness.js"]) {
        try {
          const loaded = require(specifier);
          if (loaded !== null && typeof loaded === "object") return loaded;
        } catch { /* 未登记，尝试下一个 specifier 形式。 */ }
      }
      return void 0;
    })();
    if (typeof freshnessModule?.registerClientFreshnessModule === "function"
      && typeof globalThis !== "undefined" && globalThis.__ModuleLoader__ !== void 0) {
      // 由本模块把自己的 descriptor 登记回同一张表：client-freshness.js 不能被单独
      // serve（bundle 路由只服务 package exports["./client"]），登记是它进入运行期的唯一路径。
      freshnessModule.registerClientFreshnessModule(globalThis.__ModuleLoader__);
    }
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // assembler 保证两个浏览器安全 IIFE 先于唯一 ModuleLoader descriptor 执行；
    // 直接加载 client.js 的旧 Host/测试没有这些 Symbol 时保持无侧栏降级。
    const expertGroupModel = globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
    const expertGroupSidebar = globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];

    // ── 文案层（票据 19）──────────────────────────────────────────────────
    //
    // 消息表的权威实现语义在 shared.js；浏览器侧由 client-expert-group-model.js 投影。
    // 设置页只使用模型暴露的 resolveClientLocale / translateMessage（缺失时保持安全占位）。
    const localeModelApi = () => globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")] ?? expertGroupModel;
    /**
     * 设置页 locale 解析顺序：ctx.locale → ctx.i18n.locale → document.documentElement.lang
     * → navigator.language → zh。纯读，不写回任何宿主状态。
     */
    function resolveSettingsLocale(ctx) {
      const model = localeModelApi();
      const sources = {
        ctxLocale: (() => { try { return ctx?.locale; } catch { return undefined; } })(),
        i18nLocale: (() => { try { return ctx?.i18n?.locale; } catch { return undefined; } })(),
        documentLang: (() => { try { return globalThis.document?.documentElement?.lang; } catch { return undefined; } })(),
        navigatorLanguage: (() => { try { return globalThis.navigator?.language; } catch { return undefined; } })(),
      };
      if (typeof model?.resolveClientLocale === "function") return model.resolveClientLocale(sources);
      const candidates = [sources.ctxLocale, sources.i18nLocale, sources.documentLang, sources.navigatorLanguage];
      return candidates.some((value) => typeof value === "string" && value.trim().toLowerCase().startsWith("en")) ? "en" : "zh";
    }
    /**
     * 设置页 zh 文案的**降级回退表**（票据 19）。
     *
     * 生产 bundle 恒先执行 client-expert-group-model.js（消息表投影），设置页因此总是走
     * model.translateMessage。只有「契约外直接加载 client.js」的旧宿主/测试拿不到模型，
     * 这里用一份只含 settings.* 的中文回退保证：绝不渲染空串或内部键名，也绝不改变
     * 默认 zh 下的既有文案。回退表与权威表的 zh 值由 settings 契约测试逐键对比。
     */
    const SETTINGS_ZH_FALLBACK = Object.freeze({
      "settings.title": "dsh-expert-group",
      "settings.hint": "专家模型使用 DSH 当前已配置的 provider 和模型目录。",
      "settings.taskManagement": "任务管理",
      "settings.auto": "Auto",
      "settings.autoTitle": "自动打开运行中的子代理侧栏会话",
      "settings.notifications": "通知弹窗",
      "settings.notificationVolume": "通知音量",
      "settings.notificationEvents": "通知事件",
      "settings.notificationVolume.range": "通知音量滑块",
      "settings.notificationVolume.number": "通知音量数值",
      "settings.notificationEvent.completed": "任务完成",
      "settings.roleTimeout.aria": "角色默认超时",
      "settings.notificationEvent.completed.aria": "通知任务完成",
      "settings.notificationEvent.waiting.aria": "通知等待用户",
      "settings.notificationEvent.failed.aria": "通知任务失败",
      "settings.notificationEvent.waiting": "等待用户",
      "settings.notificationEvent.failed": "任务失败",
      "settings.unifiedProvider": "统一供应商",
      "settings.noProvider": "无",
      "settings.observerPreferred": "Observer优先",
      "settings.concurrencyLimit": "单个角色并发上限",
      "settings.concurrencyLimit.title": "取值范围 1–64 的整数；默认 20；保存后生效",
      "settings.roleTimeout": "角色默认超时 (s)",
      "settings.roleTimeout.title": "默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
      "settings.save": "保存",
      "settings.saving": "保存中…",
      "settings.discard": "放弃修改",
      "settings.saved": "已保存",
      "settings.unsaved": "有未保存的修改",
    });
    /** 取一条设置页文案：模型可用时走权威投影；缺失时用 zh 回退表插值（绝不显示键名）。 */
    function settingsText(locale, key, vars) {
      const model = localeModelApi();
      if (typeof model?.translateMessage === "function") return model.translateMessage(locale, key, vars);
      const template = SETTINGS_ZH_FALLBACK[key];
      if (template === undefined) return "—";
      const values = vars !== null && typeof vars === "object" ? vars : {};
      return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
        const value = values[name];
        return value === void 0 || value === null ? match : String(value);
      });
    }
    /**
     * 票据 24 新增设置区块的**本地**文案表（zh/en 成对）。
     *
     * 为什么不在 shared.js：本票据的文件边界禁止修改权威消息表；但直接复用
     * settingsText 会让新键在真实 bundle 里渲染成中性占位（MISSING_MESSAGE_TEXT）。
     * 因此这里只承载本控件组自己的键：取值顺序是 locale → zh，任何缺失都回退中文，
     * 绝不渲染键名或空串；默认 zh 与既有文案逐字不变。
     */
    const SETTINGS_EXTRA_MESSAGES = Object.freeze({
      "settings.modelCandidates.fallbackLimit": { zh: "自动降级上限" },
      "settings.modelCandidates.fallbackLimit.title": { zh: "0 = 不降级；默认 2；最多 4。只影响保存之后创建的尝试。" },
      // 模型页签：页签名称只由位置推导（第一页恒为「主模型」），拖动只改层的顺序、不改名称。
      "settings.modelTabs.primary": { zh: "主模型" },
      "settings.modelTabs.candidate": { zh: "候选{index}" },
      "settings.modelTabs.add": { zh: "添加候选页" },
      "settings.modelTabs.add.title": { zh: "把主模型页六个角色的选择复制到新的候选页" },
      "settings.modelTabs.limit": { zh: "最多 3 个候选页（共 4 页）" },
      "settings.modelTabs.remove": { zh: "删除这个候选页" },
      "settings.modelTabs.remove.title": { zh: "删除候选页" },
      "settings.modelTabs.remove.message": { zh: "删除「候选{index}」会同时删除六个专家在该层的模型配置；保存后生效。" },
      "settings.modelCandidates.limit": { zh: "每个角色最多 3 个候选" },
      "settings.modelCandidates.error.incomplete": { zh: "候选第 {index} 行需要同时填写供应商和模型" },
      "settings.modelCandidates.error.duplicate": { zh: "候选第 {index} 行与前面的候选重复" },
    });
    /** 取本票据新增控件的文案：locale 缺失或该语言无译文时回退 zh，绝不渲染键名。 */
    function settingsExtraText(locale, key, vars) {
      const entry = SETTINGS_EXTRA_MESSAGES[key];
      if (entry === void 0) return settingsText(locale, key, vars);
      const template = typeof entry[locale] === "string" && entry[locale].length > 0 ? entry[locale] : entry.zh;
      const values = vars !== null && typeof vars === "object" ? vars : {};
      return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
        const value = values[name];
        return value === void 0 || value === null ? match : String(value);
      });
    }

    // ── 设置页样式：仅保留 dsh-expert-group settings section 使用的规则。
    const css = "" +
      ".deg_settings{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary)}" +
      ".deg_settings_title{font-size:20px;font-weight:600;line-height:28px;margin:0}" +
      ".deg_settings_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}" +
      ".deg_settings_row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,280px);align-items:center;gap:20px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      // 任务管理与自动侧栏开关放在模型配置之后、通知之前，始终可见且共享标准设置行间距。
      // 允许换行只为极窄屏兜底：宽屏下两个复选框仍是单排、列间距 28px，排布不变。
      ".deg_settings_task_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:28px;row-gap:12px;min-height:29px}" +
      ".deg_settings_task_row>.deg_settings_checkbox{flex:0 0 auto;white-space:nowrap;height:29px;box-sizing:border-box}" +
      // 统一供应商与自动降级上限合成一行：两组左对齐排列、组间距 32px（刻意不用 space-between 把降级上限推到最右）；
      // 组内标签紧贴控件 10px，下拉框 176px 且允许收缩，不再撑满行尾。
      ".deg_settings_unified_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:32px;row-gap:12px;min-width:0}" +
      ".deg_settings_provider_group,.deg_settings_fallback_group{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto}" +
      ".deg_settings_provider_group>.deg_settings_label,.deg_settings_fallback_group>.deg_settings_label{flex:0 0 auto;white-space:nowrap}" +
      ".deg_settings_provider_group>.deg_settings_control{flex:0 1 auto;min-width:0}" +
      ".deg_settings_provider_group select.deg_settings_provider_select{flex:0 1 176px;width:176px;min-width:0;max-width:200px}" +
      // 520px 以下两组各占一整排（标签不拆行、下拉不撑破容器），不产生横向滚动。
      "@media (max-width:520px){.deg_settings_unified_row{column-gap:20px;row-gap:12px}.deg_settings_provider_group{flex:1 1 100%}}" +
      // 底部管理行与上方任务行/统一行同一节奏：三个部分直接并排、统一 32px 列间距并左对齐，
      // 不再用 space-between 把两个数值组推到行尾。
      ".deg_settings_management_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:32px;row-gap:12px;min-width:0}" +
      ".deg_settings_management_row>.deg_settings_checkbox{flex:0 0 auto;white-space:nowrap;height:29px;box-sizing:border-box}" +
      // 每个数值部分仍是「标签 + 输入框」紧凑组：组内沿用 .deg_settings_control 的 10px 间距，
      // 标签不换行、数字框固定 72px；整组不缩窄，空间不足时整组换行。
      ".deg_settings_management_row>.deg_settings_control{flex:0 0 auto;min-width:max-content;white-space:nowrap;height:29px;box-sizing:border-box}" +
      // 520px 以下三个部分允许换行并保持左对齐，行距 12px。
      "@media (max-width:520px){.deg_settings_management_row{column-gap:20px;row-gap:12px}}" +
      ".deg_settings_label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
      ".deg_settings_control{display:flex;align-items:center;gap:10px;min-width:0}" +
      ".deg_settings_control input[type=range]{width:100%;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      ".deg_settings_control input[type=number]{width:72px;box-sizing:border-box;padding:6px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}" +
      ".deg_settings_control select{width:100%;min-width:0;box-sizing:border-box;padding:7px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}" +
      ".deg_settings_control select:disabled,.deg_settings_control input:disabled{opacity:.5;cursor:not-allowed}" +
      ".deg_settings_checkbox{display:flex;align-items:center;gap:8px;cursor:pointer}" +
      ".deg_settings_checkbox input{width:16px;height:16px;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      ".deg_settings_table_wrap{width:100%;min-width:0;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}" +
      // 模型名称通常最长；压缩角色、供应商和思考深度列，把可用空间优先留给模型选择。
      ".deg_settings_table{display:grid;min-width:540px;grid-template-columns:minmax(84px,.6fr) minmax(132px,.82fr) minmax(210px,1.5fr) minmax(96px,.62fr);border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".deg_settings_table_head,.deg_settings_table_cell{min-width:0;padding:10px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".deg_settings_table_head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:600}" +
      ".deg_settings_table_cell{display:flex;align-items:center;font-size:13px;line-height:20px}" +
      ".deg_settings_table_cell select{width:100%;min-width:0;box-sizing:border-box;padding:6px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}" +
      ".deg_settings_table_cell select.deg_settings_provider_select{max-width:170px}" +
      ".deg_settings_table_cell select.deg_settings_model_select{max-width:260px}" +
      ".deg_settings_table_cell select.deg_settings_effort_select{max-width:112px}" +
      ".deg_settings_table_cell select:disabled{opacity:.5;cursor:not-allowed}" +
      ".deg_settings_role_cell{padding:0;align-items:center}" +
      ".deg_settings_role_button{display:flex;align-items:center;justify-content:center;gap:7px;flex:0 0 74px;width:74px;height:28px;min-height:28px;padding:4px 6px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;line-height:20px;cursor:pointer;text-align:center}" +
      ".deg_settings_role_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-secondary)}" +
      ".deg_settings_role_button:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}" +
      ".deg_settings_role_button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-secondary,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}" +
      ".deg_settings_role_button:disabled{opacity:.45;cursor:not-allowed}" +
      ".deg_settings_prompt_customized_dot{display:inline-block;width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}" +
      ".deg_settings_prompt_editor{display:flex;flex-direction:column;gap:14px;min-width:0}" +
      ".deg_prompt_header{display:flex;align-items:center;justify-content:center;min-width:0}" +
      ".deg_prompt_header .deg_settings_title{margin:0;overflow-wrap:anywhere;text-align:center}" +
      ".deg_prompt_back{flex:0 0 auto}" +
      ".deg_prompt_label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:600}" +
      ".deg_prompt_textarea{display:block;width:100%;min-height:320px;max-height:60vh;box-sizing:border-box;resize:vertical;overflow:auto;padding:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:13px/20px var(--ds-font-family-code,var(--ds-font-family-sans));white-space:pre-wrap}" +
      ".deg_prompt_textarea:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}" +
      ".deg_prompt_textarea:disabled{opacity:.55;cursor:not-allowed}" +
      ".deg_prompt_counter{display:flex;justify-content:flex-end;margin-top:-8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".deg_prompt_counter_warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}" +
      ".deg_prompt_counter_error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}" +
      ".deg_prompt_status{min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".deg_prompt_footer{display:flex;align-items:center;gap:8px;padding-top:4px}" +
      ".deg_prompt_footer .deg_btn{flex:0 0 auto;min-width:88px}" +
      ".deg_prompt_footer .deg_prompt_status{margin-right:auto}" +
      ".deg_btn_primary{color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      ".deg_btn_primary:hover:not(:disabled){filter:brightness(1.08)}" +
      ".deg_settings_table_cell .deg_settings_role_button + *{min-width:0}" +
      ".deg_settings_footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:4px}" +
      ".deg_settings_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:auto}" +
      ".deg_settings_error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));white-space:pre-wrap}" +
      ".deg_btn{flex:1;box-sizing:border-box;min-height:32px;padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer}" +
      ".deg_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".deg_btn:disabled{opacity:.45;cursor:not-allowed}" +
      ".deg_btn.deg_btn_primary{color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      ".deg_prompt_dialog_backdrop{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.45)}" +
      ".deg_prompt_dialog{width:min(100%,440px);box-sizing:border-box;padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;box-shadow:0 12px 28px rgba(0,0,0,.28)}" +
      ".deg_prompt_dialog h3{margin:0 0 8px;font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary)}" +
      ".deg_prompt_dialog p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}" +
      ".deg_prompt_dialog_actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:18px}" +
      // 通知设置是紧凑工具条：通知弹窗 / 通知音量 / 通知事件下拉同处一行（停留时长字段已按票据 14 移除）。
      // 音量组吸收剩余空间并保持 160px 最小宽；事件下拉按内容宽度，两个复选框以外的部分不再占整行。
      ".deg_settings_notification_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:24px;row-gap:12px;min-width:0;white-space:nowrap}" +
      ".deg_settings_notification_row>.deg_settings_checkbox{flex:0 0 auto}" +
      ".deg_settings_notification_row>.deg_settings_control{flex:1 1 220px;min-width:160px}" +
      ".deg_settings_notification_row>.deg_settings_control .deg_settings_label{flex:0 0 auto;white-space:nowrap}" +
      ".deg_settings_notification_row>.deg_settings_control input[type=range]{flex:1 1 auto;min-width:48px}" +
      ".deg_settings_notification_row>.deg_settings_control input[type=number]{flex:0 0 72px;width:72px}" +
      // 「通知事件」多选下拉：触发按钮保持 29px 紧凑高度；面板绝对定位在按钮下方并右对齐，
      // 避免在设置页右边缘溢出（窄屏改为独占一行 + 左对齐）。
      ".deg_settings_events_dropdown{position:relative;flex:0 0 auto;min-width:0}" +
      ".deg_settings_events_trigger{display:inline-flex;align-items:center;gap:6px;height:29px;box-sizing:border-box;padding:0 10px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}" +
      ".deg_settings_events_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".deg_settings_events_trigger:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}" +
      ".deg_settings_events_trigger:disabled{opacity:.45;cursor:not-allowed}" +
      ".deg_settings_events_count{color:var(--dsw-alias-label-secondary)}" +
      ".deg_settings_events_caret{display:inline-block;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;transform:translateY(1px)}" +
      // 面板背景/边框/圆角走主题变量；DSH 主题没有阴影变量，轻阴影沿用对话框的 rgba 先例。
      ".deg_settings_events_panel{position:absolute;top:calc(100% + 6px);right:0;z-index:20;display:flex;flex-direction:column;gap:8px;min-width:180px;box-sizing:border-box;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.16)}" +
      ".deg_settings_events_panel .deg_settings_checkbox{height:20px}" +
      // 520px 以下：音量组与事件下拉各占一整排，面板从按钮左侧改为左对齐，避免横向溢出。
      "@media (max-width:520px){.deg_settings_notification_row{flex-wrap:wrap;row-gap:12px}.deg_settings_notification_row>.deg_settings_control{flex-basis:100%}.deg_settings_events_dropdown{flex:1 1 100%}.deg_settings_events_panel{left:0;right:auto}}" +
      ".deg_subagent_metadata{display:block;box-sizing:border-box;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-size:11px;line-height:16px}" +
      ".deg_full_system_prompt_root[data-open]{padding-bottom:4px}" +
      ".deg_full_system_prompt_chevron{color:var(--dsw-alias-label-secondary)}" +
      ".deg_full_system_prompt_body{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta, 0px));margin:4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px));max-height:141px;overflow:auto;padding:10px 16px 12px 12px;border:none;border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code)}" +
      ".deg_full_system_prompt{box-sizing:border-box;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}" +
      // ── 「模型配置」区域：默认折叠的 section + 按需展开的 provider 卡片 ──────────
      ".deg_mc_section{display:flex;flex-direction:column;gap:10px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".deg_mc_header{display:flex;align-items:center;gap:8px;min-width:0}" +
      ".deg_mc_toggle{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:0;color:var(--dsw-alias-label-primary);background:transparent;border:none;font:inherit;font-size:13px;line-height:20px;font-weight:600;text-align:left;cursor:pointer}" +
      ".deg_mc_toggle:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}" +
      ".deg_mc_chevron{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}" +
      ".deg_mc_body{display:flex;flex-direction:column;gap:10px;min-width:0}" +
      ".deg_mc_cards{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}" +
      ".deg_mc_card{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}" +
      ".deg_mc_card_head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}" +
      ".deg_mc_card_name{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}" +
      ".deg_mc_card_route{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,inherit)}" +
      ".deg_mc_card_actions{display:flex;align-items:center;gap:8px;margin-left:auto}" +
      ".deg_mc_card_actions .deg_btn{flex:0 0 auto;min-width:64px}" +
       ".deg_mc_card_actions .deg_mc_delete_btn{color:var(--dsw-alias-state-error-primary,#ef4444)}" +
       ".deg_mc_dot[data-state=available]{background:var(--dsw-alias-state-success-primary,#22c55e)}" +
      ".deg_mc_dot{display:inline-block;width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}" +
      ".deg_mc_badge{font-size:11px;line-height:16px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary)}" +
      ".deg_mc_field{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,240px);align-items:center;gap:12px}" +
      ".deg_mc_field_label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}" +
      ".deg_mc_input,.deg_mc_select{box-sizing:border-box;width:100%;min-width:0;padding:6px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}" +
      ".deg_mc_input:disabled,.deg_mc_select:disabled{opacity:.5;cursor:not-allowed}" +
      ".deg_mc_input:focus-visible,.deg_mc_select:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}" +
      ".deg_mc_models{display:flex;flex-direction:column;gap:8px;min-width:0;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".deg_mc_models_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}" +
      ".deg_mc_models_title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".deg_mc_models_meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}" +
      ".deg_mc_models_head .deg_btn{margin-left:auto;flex:0 0 auto;min-width:auto}" +
      ".deg_mc_model{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}" +
      ".deg_mc_model_main{display:flex;align-items:center;gap:6px;min-width:0}" +
      ".deg_mc_model_main .deg_mc_input{flex:1 1 0;min-width:0}" +
      ".deg_mc_icon_btn{flex:0 0 auto;min-width:auto;width:26px;height:26px;padding:0;line-height:1}" +
      ".deg_mc_model_advanced{display:grid;grid-template-columns:max-content minmax(64px,1fr) max-content minmax(64px,1fr);column-gap:8px;row-gap:8px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2)}" +
       ".deg_mc_model_advanced>.deg_mc_field{display:contents}" +
       ".deg_mc_model_advanced>.deg_mc_field .deg_mc_field_label{align-self:center;min-width:0}" +
       ".deg_mc_model_advanced>.deg_mc_field .deg_mc_input{min-width:0;text-align:center}" +
       ".deg_mc_model_advanced>.deg_mc_efforts{grid-column:1 / -1}" +
       "@media (max-width:640px){.deg_mc_model_advanced{grid-template-columns:max-content minmax(64px,1fr)}.deg_mc_model_advanced>.deg_mc_efforts{grid-column:1 / -1}}" +
      ".deg_mc_efforts{margin:0;padding:0;border:none;min-width:0}" +
      ".deg_mc_efforts_label{padding:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}" +
      ".deg_mc_efforts_row{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}" +
      ".deg_mc_effort{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}" +
      ".deg_mc_effort input{width:14px;height:14px;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      ".deg_mc_input_types{display:flex;flex-wrap:wrap;gap:10px}" +
      ".deg_mc_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}" +
      // 删除确认弹窗内的失败文本与卡片错误共用同一条规则（同一个错误视觉，不新增样式规则）。
      ".deg_mc_error,.deg_remove_confirm_error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));white-space:pre-wrap}" +
      ".deg_mc_card_footer{display:flex;align-items:center;gap:8px;padding-top:2px}" +
      ".deg_mc_card_footer .deg_mc_status{margin-right:auto}" +
      ".deg_mc_card_footer .deg_btn{flex:0 0 auto;min-width:76px}" +
      ".deg_mc_conflict{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}" +
      ".deg_mc_conflict_actions{display:flex;gap:8px}" +
      ".deg_mc_conflict_actions .deg_btn{flex:0 0 auto;min-width:96px}" +
      ".deg_mc_add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%}" +
      ".deg_mc_add .deg_mc_select{width:auto;min-width:160px;flex:0 1 auto}" +
      // 两个 provider 入口与原生模型设置页同级、等宽、同风格。
      ".deg_mc_entries{display:flex;align-items:center;gap:8px;flex:1 1 100%;width:100%;min-width:0}" +
      ".deg_mc_entries>.deg_btn{flex:1 1 0;min-width:0;border-style:dashed}" +
       ".deg_mc_entries>.deg_btn::before{content:\"+\";display:inline-block;margin-right:4px;font-size:16px;line-height:1}" +
      ".deg_mc_create{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}" +
      ".deg_mc_create_head{display:flex;align-items:center;gap:8px;min-width:0}" +
      ".deg_mc_create_title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".deg_mc_field_error{border-color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}" +
      ".deg_mc_field_row{display:flex;flex-direction:column;gap:4px;min-width:0}" +
      ".deg_mc_field_message{font-size:11px;line-height:16px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}" +
      ".deg_mc_create_footer{display:flex;align-items:center;gap:8px;padding-top:2px}" +
      ".deg_mc_create_footer .deg_mc_status{margin-right:auto}" +
      ".deg_mc_create_footer .deg_btn{flex:0 0 auto;min-width:88px}" +
      ".deg_mc_fetch_list{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto;margin:6px 0 0;padding:0;list-style:none}" +
      ".deg_mc_fetch_item{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}" +
       ".deg_mc_modal_backdrop{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.45)}" +
       ".deg_mc_modal{display:flex;flex-direction:column;gap:12px;width:min(100%,380px);max-height:min(80vh,420px);box-sizing:border-box;padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 12px 28px rgba(0,0,0,.28)}" +
       ".deg_mc_modal_header{display:flex;align-items:center;gap:8px;min-width:0}" +
       ".deg_mc_modal_title{flex:1 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary)}" +
       ".deg_mc_modal_close{flex:0 0 auto;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:28px;cursor:pointer}" +
       ".deg_mc_modal_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
       ".deg_mc_modal_description{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}" +
       ".deg_mc_candidate_toolbar{display:flex;align-items:center;gap:8px;min-width:0}" +
       ".deg_mc_candidate_search{flex:1 1 auto;min-width:0}" +
       ".deg_mc_candidate_toolbar .deg_btn{flex:0 0 auto;min-width:auto;white-space:nowrap}" +
       ".deg_mc_candidate_list{display:flex;flex-direction:column;gap:2px;max-height:240px;margin:0;overflow:auto;padding:0;list-style:none}" +
       ".deg_mc_candidate_item{border-radius:6px}" +
       ".deg_mc_candidate_label{display:flex;align-items:center;gap:8px;padding:6px 8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}" +
       ".deg_mc_candidate_id{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,inherit)}" +
       ".deg_mc_candidate_empty{margin:18px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}" +
       ".deg_mc_modal_footer{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}" +
       ".deg_mc_modal_footer .deg_btn{flex:0 0 auto;min-width:76px}" +
       // 设置页导航行的品牌图标适配：宿主按 section id 硬编码 navIcon，未知 id 回退齿轮，
       // 插件无法在注册字段里声明图标，因此只能在其 DOM 上做适配——
       // 隐藏宿主原生 svg（不替换它的内容，React 重渲染会按 fiber 位置回写 path），
       // 并让 DEG 自己插入的 svg 只占图标列（不参与伸缩），label 位置因此不变。
       "[data-deg-settings-nav-native]{display:none}" +
       "[data-deg-settings-nav-icon]{flex:none}" +
       // ── 插件详情摘要（DSH 插件管理器的组合包页）────────────────────────────
       // 全部规则都以 deg_pd_ 前缀命名，且只用宿主已有的 CSS 变量，不依赖宿主 CSS module 的哈希类名。
       ".deg_pd{display:flex;flex-direction:column;gap:12px;width:min(100%,760px);min-width:0;box-sizing:border-box;color:var(--dsw-alias-label-primary)}" +
       ".deg_pd_title{font-size:14px;line-height:22px;font-weight:600;margin:0}" +
       ".deg_pd_roles{display:flex;flex-direction:column;gap:0;list-style:none;margin:0;padding:0}" +
       ".deg_pd_roles_header{display:grid;grid-template-columns:minmax(84px,.7fr) minmax(0,1.6fr) auto;gap:10px;padding:6px 0 2px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}" +
       ".deg_pd_roles_header span{min-width:0}" +
       ".deg_pd_roles_header span:last-child{text-align:right}" +
       ".deg_pd_role{display:grid;grid-template-columns:minmax(84px,.7fr) minmax(0,1.6fr) auto;align-items:center;gap:10px;min-height:30px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
       ".deg_pd_role:last-child{border-bottom:0}" +
       ".deg_pd_role_name{min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}" +
       ".deg_pd_role_value{min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
       ".deg_pd_role_value[title]{cursor:help}" +
       ".deg_pd_role_state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;text-align:right}" +
       ".deg_pd_role[data-deg-role-state=configured] .deg_pd_role_state{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}" +
       ".deg_pd_role[data-deg-role-state=disabled] .deg_pd_role_name,.deg_pd_role[data-deg-role-state=disabled] .deg_pd_role_value{color:var(--dsw-alias-label-secondary)}" +
       // 不完整配置（provider 已选、model 未选）用警示色表达"还没配完"，绝不与已配置同色。
       ".deg_pd_role[data-deg-role-state=incomplete] .deg_pd_role_state{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}" +
       ".deg_pd_providers{display:flex;align-items:flex-start;gap:10px;min-width:0;flex-wrap:wrap}" +
       ".deg_pd_label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}" +
       ".deg_pd_providers_list{display:flex;align-items:flex-start;gap:6px;flex:1 1 auto;flex-wrap:wrap;min-width:0;max-width:100%}" +
       ".deg_pd_tag{max-width:100%;box-sizing:border-box;font-size:11px;line-height:16px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}" +
       ".deg_pd_tag[data-deg-provider-known=false]{border-style:dashed;color:var(--dsw-alias-label-secondary)}" +
       ".deg_pd_empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
       ".deg_pd_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0;overflow-wrap:anywhere}" +
       ".deg_pd_actions{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding-top:2px}" +
       ".deg_pd_actions .deg_pd_open{flex:0 0 auto;min-width:auto}" +
       ".deg_pd_actions .deg_pd_open:hover:not(:disabled),.deg_pd_actions .deg_pd_open:focus-visible:not(:disabled){color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));filter:brightness(1.08)}" +
       ".deg_pd_actions .deg_pd_open:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}" +
       ".deg_pd_actions .deg_pd_open:disabled{opacity:1;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));background:transparent;border-color:var(--dsw-alias-border-l2)}" +
       ".deg_pd_note{min-width:0;flex:1 1 220px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}" +
       // 窄屏将状态移到 Provider/模型下一行，避免六角色被三列硬挤成不可读的省略号。
       "@media (max-width:480px){.deg_pd_roles_header,.deg_pd_role{grid-template-columns:minmax(72px,auto) minmax(0,1fr);column-gap:8px}.deg_pd_roles_header{padding-top:5px}.deg_pd_roles_header span:last-child{grid-column:2;text-align:left}.deg_pd_role{align-items:start;row-gap:2px;padding:7px 0}.deg_pd_role_name{grid-row:1 / span 2;align-self:start}.deg_pd_role_value{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}.deg_pd_role_state{grid-column:2;justify-self:start;text-align:left}}" +
      // ── 模型页签（主模型 / 候选1..3）：页签名只由位置推导，拖动排序只改本地草稿 ──────
      ".deg_settings_model_tabs{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;padding:0 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      // 页签本体是 div[role=tab]（内部还有 × 按钮，不能嵌套 button）；touch-action 让触屏拖动不被滚动抢走。
      ".deg_settings_model_tab{display:inline-flex;align-items:center;gap:6px;height:28px;box-sizing:border-box;padding:0 10px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;user-select:none;touch-action:none}" +
      ".deg_settings_model_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".deg_settings_model_tab:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}" +
      ".deg_settings_model_tab[aria-selected=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-secondary,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}" +
      // 拖动中的页签半透明，明确「这一页正被拿走」而不是选中态。
      ".deg_settings_model_tab[data-dragging=true]{opacity:.55;cursor:grabbing}" +
      ".deg_settings_model_tab_remove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}" +
      ".deg_settings_model_tab_remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
      ".deg_settings_model_tab_remove:disabled{opacity:.45;cursor:not-allowed}" +
      ".deg_settings_model_tab_add{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;line-height:1;cursor:pointer}" +
      ".deg_settings_model_tab_add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}" +
      ".deg_settings_model_tab_add:disabled{opacity:.45;cursor:not-allowed}" +
      // 落点指示：拖动时在插入边界画一条 2px 竖条，松手前就能看出新位置。
      ".deg_settings_model_tab_drop{flex:0 0 2px;align-self:stretch;min-height:24px;border-radius:1px;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}" +
      "@media (max-width:520px){.deg_settings_model_tabs{gap:4px}}";


    const cssTagId = "dsh-expert-group/settings.module.css";
    /** 已注入过样式表的 document：同一 document 只注入一次，设置页适配样式不会重复注入。 */
    const cssInjectedDocuments = typeof WeakSet === "function" ? new WeakSet() : null;

    /**
     * 幂等注入插件样式表。
     * 模块求值可能早于 document 可用（测试替身、SSR、装配期求值），此时首次注入会被跳过；
     * 设置页导航和模型配置需要的样式在运行期补注入；只写 DEG 自己的 style 标签，
     * 不触碰 DSH 宿主样式。
     */
    function ensurePluginStylesheet() {
      const doc = typeof document !== "undefined" ? document : null;
      if (doc === null || typeof doc !== "object") return false;
      if (cssInjectedDocuments?.has(doc) === true) return true;
      const selector = "style[data-plugin-css=" + JSON.stringify(cssTagId) + "]";
      if (typeof doc.querySelector === "function" && doc.querySelector(selector) !== null) {
        cssInjectedDocuments?.add(doc);
        return true;
      }
      if (typeof doc.createElement !== "function" || typeof doc.head?.appendChild !== "function") return false;
      const tag = doc.createElement("style");
      tag.dataset.plugin = "dsh-expert-group";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = css;
      doc.head.appendChild(tag);
      cssInjectedDocuments?.add(doc);
      return true;
    }
    ensurePluginStylesheet();

    // 路由路径是插件固定接口，供 Host 与 Client 共享；纯内部标识，用户不可见。
    const RPC_PATH = "/api/dsh-expert-group";
    const RPC_CHANNEL = "/dsh-expert-group";
    const RPC_ENDPOINT = "rpc";

    /** RPC 路由常量打包成 seam，交由 client-freshness.js 使用（不在两处硬编码路径）。 */
    const RPC_TARGET = Object.freeze({ path: RPC_PATH, channel: RPC_CHANNEL, endpoint: RPC_ENDPOINT });

    /**
     * freshness/RPC 共享缝的**唯一实现**在 client-freshness.js（浏览器安全 ES 模块）。
     * 构建期投影片段已把同一份实现登记进本 bundle 的模块表，因此下面只保留转发壳：
     * 不再内联第二份同语义实现——那份副本既让安装体积双份，又会与权威实现各自漂移。
     * 共享模块缺失意味着契约外直载 client.js 或装配产物被裁剪（宿主只加载
     * exports["./client"] 的装配结果，其中投影恒在本 descriptor 之前执行），此时必须
     * 显式失败：静默降级成"看起来能用"的另一套实现，正是本波要消除的漂移风险。
     *
     * 每次调用都重新经过模块表解析（`require` 是 DSH 模块表的唯一入口）：HMR 换掉
     * client-freshness 的登记工厂后，本插件必须转发到**新的**那份实现，而不是记住
     * factory 执行瞬间的那一份。
     */
    function resolveFreshnessSurface() {
      if (typeof require === "function") {
        for (const specifier of [FRESHNESS_MODULE_ID, "./" + FRESHNESS_MODULE_ID, "./client-freshness.js"]) {
          try {
            const loaded = require(specifier);
            if (loaded !== null && typeof loaded === "object") return loaded;
          } catch { /* 未登记，尝试下一个 specifier 形式。 */ }
        }
      }
      return freshnessModule;
    }

    function requireFreshnessSurface() {
      const surface = resolveFreshnessSurface();
      if (surface === void 0) {
        throw new Error("dsh-expert-group: freshness 共享模块未装载（发布 bundle 缺少 client-freshness 投影片段）");
      }
      return surface;
    }

    /** 错误 code → status 映射由共享实现统一（Connection envelope 与 legacy fetch 同一份判定）。 */
    function rpcErrorStatus(error) {
      return requireFreshnessSurface().rpcErrorStatus(error);
    }

    /** 将 Connection envelope 归一为 fetch-like Response，保持两条传输的错误字段一致。 */
    function normalizePluginRpcResult(result) {
      return requireFreshnessSurface().normalizePluginRpcResult(result);
    }

    /**
     * 优先使用 DSH Connection 的独立插件 channel，认证和 envelope 由 Connection 统一处理；
     * 没有新 Connection 的旧 Host 才回落到同源 fetch，路由常量由这里注入（不在两处硬编码）。
     */
    async function requestPluginRpc(connection, request, init = {}, fetchImpl = globalThis.fetch) {
      return requireFreshnessSurface().requestPluginRpc(connection, request, init, fetchImpl, RPC_TARGET);
    }

    /**
     * Client 双面共享的 freshness seam：唯一实现位于 client-freshness.js，
     * 这里只做 ModuleLoader 投影转发（共享实现已在 bundle 内登记）。
     */
    function createClientFreshnessBoundary(options = {}) {
      return requireFreshnessSurface().createClientFreshnessBoundary(options);
    }

    // ── Fan-out 客户端快照纯函数 ───────────────────────────────────────────
    // 这些函数只处理 JSON 兼容数据，不读取 React/DOM，既可供面板使用也可供契约测试复用。
    const FANOUT_SHARD_STATUS_KEYS = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out", "interrupted"];
    const FANOUT_TERMINAL_SHARD_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
    const FANOUT_RETRYABLE_SHARD_STATUSES = new Set(["failed", "timed_out", "cancelled", "interrupted"]);
    const FANOUT_STATUS_LABELS = {
      queued: "排队中",
      running: "运行中",
      succeeded: "成功",
      failed: "失败",
      cancelled: "已取消",
      timed_out: "已超时",
      interrupted: "已中断",
      pending: "等待中",
      completed: "已完成",
      completed_with_errors: "部分失败",
    };

    function fanoutIsObject(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** 深拷贝 RPC JSON，避免旧快照中的 result/error 被后续事件引用污染。 */
    function cloneFanoutValue(value, seen = new WeakMap()) {
      if (value === null || typeof value !== "object") return value;
      if (seen.has(value)) return seen.get(value);
      if (Array.isArray(value)) {
        const clone = [];
        seen.set(value, clone);
        for (const item of value) clone.push(cloneFanoutValue(item, seen));
        return clone;
      }
      const clone = {};
      seen.set(value, clone);
      for (const key of Object.keys(value)) clone[key] = cloneFanoutValue(value[key], seen);
      return clone;
    }

    function fanoutString(value, fallback = void 0) {
      if (typeof value !== "string") return fallback;
      const text = value.trim();
      return text.length > 0 ? text : fallback;
    }

    function fanoutStatusOf(value, fallback) {
      return fanoutString(value, fallback) ?? fallback;
    }

    function fanoutTimestampOf(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    function fanoutCountOf(value, fallback = 0) {
      return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    }

    function normalizeFanoutAttempt(rawAttempt, index, fallbackStatus) {
      const source = fanoutIsObject(rawAttempt) ? rawAttempt : {};
      const attempt = Number.isSafeInteger(source.attempt) && source.attempt > 0
        ? source.attempt
        : index + 1;
      const normalized = {
        attempt,
        status: fanoutStatusOf(source.status, fallbackStatus),
      };
      for (const field of ["error", "result", "childId", "messageId"]) {
        if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === void 0) continue;
        normalized[field] = cloneFanoutValue(source[field]);
      }
      return normalized;
    }

    function normalizeFanoutShard(rawShard) {
      if (!fanoutIsObject(rawShard)) return null;
      const shardId = fanoutString(rawShard.shardId);
      if (shardId === void 0) return null;
      const status = fanoutStatusOf(rawShard.status, "queued");
      const attempts = Array.isArray(rawShard.attempts)
        ? rawShard.attempts.map((attempt, index) => normalizeFanoutAttempt(attempt, index, status))
        : [];
      return {
        shardId,
        prompt: typeof rawShard.prompt === "string" ? rawShard.prompt : "",
        status,
        attempts,
      };
    }

    function deriveFanoutCounts(shards) {
      const counts = {};
      for (const key of FANOUT_SHARD_STATUS_KEYS) counts[key] = 0;
      for (const shard of Array.isArray(shards) ? shards : []) {
        if (Object.prototype.hasOwnProperty.call(counts, shard?.status)) counts[shard.status] += 1;
      }
      counts.pending = counts.queued + counts.running;
      return counts;
    }

    function normalizeFanoutCounts(rawCounts, shards) {
      const derived = deriveFanoutCounts(shards);
      const source = fanoutIsObject(rawCounts) ? rawCounts : {};
      const counts = {};
      for (const key of FANOUT_SHARD_STATUS_KEYS) counts[key] = fanoutCountOf(source[key], derived[key]);
      counts.pending = fanoutCountOf(source.pending, counts.queued + counts.running);
      return counts;
    }

    /** 将 Host 快照裁成稳定的、只含面板所需字段的不可变视图。 */
    function normalizeFanoutTask(rawTask) {
      if (!fanoutIsObject(rawTask)) return null;
      const parentTaskId = fanoutString(rawTask.parentTaskId);
      if (parentTaskId === void 0) return null;
      const shards = (Array.isArray(rawTask.shards) ? rawTask.shards : [])
        .map(normalizeFanoutShard)
        .filter((shard) => shard !== null);
      return {
        parentTaskId,
        role: fanoutString(rawTask.role, "unknown"),
        basePrompt: typeof rawTask.basePrompt === "string" ? rawTask.basePrompt : "",
        status: fanoutStatusOf(rawTask.status, "pending"),
        createdAt: fanoutTimestampOf(rawTask.createdAt),
        updatedAt: fanoutTimestampOf(rawTask.updatedAt),
        settledAt: fanoutTimestampOf(rawTask.settledAt),
        counts: normalizeFanoutCounts(rawTask.counts, shards),
        shards,
      };
    }

    function fanoutTaskLabel(task) {
      const role = fanoutString(task?.role, "unknown");
      const parentTaskId = fanoutString(task?.parentTaskId, "unknown");
      return role + " · " + parentTaskId;
    }

    function fanoutStatusLabel(status) {
      return FANOUT_STATUS_LABELS[status] ?? fanoutString(status, "未知状态");
    }

    function fanoutTerminalCount(task) {
      return (Array.isArray(task?.shards) ? task.shards : [])
        .filter((shard) => FANOUT_TERMINAL_SHARD_STATUSES.has(shard?.status)).length;
    }

    function fanoutCanCancelShard(shard) {
      const status = typeof shard === "string" ? shard : shard?.status;
      return !FANOUT_TERMINAL_SHARD_STATUSES.has(status);
    }

    function fanoutCanRetryShard(shard) {
      const status = typeof shard === "string" ? shard : shard?.status;
      return FANOUT_RETRYABLE_SHARD_STATUSES.has(status);
    }

    function fanoutCanCancelParent(task) {
      return (Array.isArray(task?.shards) ? task.shards : []).some(fanoutCanCancelShard);
    }

    /** 失败/非契约响应直接返回原 state，保证旧快照不会被错误响应清空或半更新。 */
    function normalizeFanoutListResponse(payload, previousState = { tasks: [], cursor: 0, loaded: false }) {
      const previous = fanoutIsObject(previousState)
        ? previousState
        : { tasks: [], cursor: 0, loaded: false };
      if (payload?.ok !== true || !Array.isArray(payload.tasks)) return previous;
      const tasks = payload.tasks.map(normalizeFanoutTask).filter((task) => task !== null);
      const cursor = Number.isSafeInteger(payload.cursor) && payload.cursor >= 0
        ? payload.cursor
        : fanoutCountOf(previous.cursor, 0);
      return { ...previous, tasks, cursor, loaded: true };
    }

    /**
     * 合并可选 fanout-events 事件。事件只通过 parentTaskId/shardId 定位，绝不按数组下标；
     * 事件字段不完整时保留旧 prompt、attempt 历史，下一次 list 刷新仍是权威快照。
     */
    function mergeFanoutEvent(task, event) {
      const current = normalizeFanoutTask(task);
      if (current === null || !fanoutIsObject(event) || event.parentTaskId !== current.parentTaskId) return current;
      const updates = Array.isArray(event.shards)
        ? event.shards.filter((shard) => fanoutString(shard?.shardId) !== void 0)
        : fanoutString(event.shardId) === void 0 ? [] : [event];
      const updateByShardId = new Map(updates.map((shard) => [fanoutString(shard.shardId), shard]));
      const shards = current.shards.map((shard) => {
        const update = updateByShardId.get(shard.shardId);
        if (!fanoutIsObject(update)) return shard;
        const nextStatus = fanoutStatusOf(update.status, shard.status);
        const attempts = shard.attempts.map((attempt) => ({ ...attempt }));
        const eventAttempt = Number.isSafeInteger(update.attempt) && update.attempt > 0 ? update.attempt : void 0;
        const declaredAttempts = Number.isSafeInteger(update.attempts) && update.attempts >= 0 ? update.attempts : 0;
        if (eventAttempt !== void 0) {
          while (attempts.length < eventAttempt) {
            attempts.push({ attempt: attempts.length + 1, status: "queued" });
          }
          const attemptIndex = attempts.findIndex((attempt) => attempt.attempt === eventAttempt);
          const baseAttempt = attemptIndex >= 0 ? attempts[attemptIndex] : { attempt: eventAttempt, status: nextStatus };
          const mergedAttempt = normalizeFanoutAttempt({ ...baseAttempt, ...update, attempt: eventAttempt, status: nextStatus }, attemptIndex >= 0 ? attemptIndex : attempts.length, nextStatus);
          if (attemptIndex >= 0) attempts[attemptIndex] = mergedAttempt;
          else attempts.push(mergedAttempt);
        }
        while (attempts.length < declaredAttempts) {
          attempts.push({ attempt: attempts.length + 1, status: nextStatus });
        }
        return { ...shard, status: nextStatus, attempts };
      });
      const next = {
        ...current,
        shards,
        counts: normalizeFanoutCounts(event.counts, shards),
        updatedAt: fanoutTimestampOf(event.at) ?? current.updatedAt,
      };
      if (event.type === "task_settled") {
        next.status = fanoutStatusOf(event.status, current.status);
        next.settledAt = fanoutTimestampOf(event.at) ?? current.settledAt;
      } else if (updates.some((update) => update.status === "queued" || update.status === "running")) {
        next.status = "pending";
        next.settledAt = null;
      }
      return normalizeFanoutTask(next);
    }

    /**
     * 只应用 sequence 严格晚于当前 cursor 的事件；旧事件和缺失序号事件都忽略，
     * 防止 list 请求与事件请求竞态时把较新的 shard 状态回退。
     */
    function mergeFanoutEvents(previousState, payload) {
      if (!fanoutIsObject(previousState) || payload?.ok !== true || !Array.isArray(payload.events)) return previousState;
      const currentCursor = fanoutCountOf(previousState.cursor, 0);
      const events = payload.events
        .filter((event) => Number.isSafeInteger(event?.sequence) && event.sequence > currentCursor)
        .sort((left, right) => left.sequence - right.sequence);
      const tasksById = new Map((Array.isArray(previousState.tasks) ? previousState.tasks : [])
        .map((task) => [task.parentTaskId, task]));
      for (const event of events) {
        const current = tasksById.get(event.parentTaskId);
        if (current !== undefined) tasksById.set(event.parentTaskId, mergeFanoutEvent(current, event));
      }
      const reportedCursor = Number.isSafeInteger(payload.cursor) && payload.cursor >= currentCursor
        ? payload.cursor
        : currentCursor;
      if (events.length === 0 && reportedCursor === currentCursor) return previousState;
      return {
        ...previousState,
        tasks: [...tasksById.values()],
        cursor: reportedCursor,
      };
    }

    // ── 当前页面运行状态桥：只读取当前会话的 running 与插件 role，并复用 DSH 原生状态行。
    //    DEG 不创建第二个状态容器，只在宿主原生主文本节点存在且前缀匹配时替换角色文案；
    //    宿主自己的鲸鱼动画、计时器、class、style 和 aria 始终由 DSH 保持。 ───────────────
    // 浏览器 bundle 通过 window.__ModuleLoader__ 加载，运行期不能 import role-registry.js，
    // 因此这里保留唯一一份"协议适配"投影：role id 列表 + 英文状态标签。
    // 权威来源是 role-registry.js 的 id/statusLabel；新增或改名角色必须同时更新这里，
    // 并由 test/role-registry.test.mjs（注册表侧）与既有客户端契约测试（页面侧）共同锁定。
    const STATUS_ROLE_IDS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
    // role id 始终保持小写用于身份匹配；页面显示只使用这里的固定英文标签。
    const STATUS_ROLE_LABELS = {
      explorer: "Explorer",
      librarian: "Librarian",
      oracle: "Oracle",
      designer: "Designer",
      fixer: "Fixer",
      observer: "Observer",
    };
    const STATUS_ROLE_MARKER = "__degExpertRole";

    /** 只接受插件定义的英文 role id；未知/外部角色不参与文案替换。 */
    function normalizeStatusRole(role) {
      if (typeof role !== "string") return void 0;
      const normalized = role.trim().toLowerCase();
      return STATUS_ROLE_IDS.includes(normalized) ? normalized : void 0;
    }

    /** 只有 DSH 明确给出 parentId、subagent origin 或 session snapshot subagent 时才判定为 child。 */
    function isPluginChildSession(session) {
      return session !== null
        && typeof session === "object"
        && ((typeof session.parentId === "string" && session.parentId.length > 0)
          || (typeof session.parentSessionId === "string" && session.parentSessionId.length > 0)
          || session.origin === "subagent"
          || (session.subagent !== null && typeof session.subagent === "object"));
    }

    /** 从当前 session 绑定的 RPC 响应解析 child kind 与英文 role；未知响应不猜测身份。 */
    function resolveStatusIdentity({ sessionId, responseSessionId, response } = {}) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const reportedSessionId = response?.sessionId ?? responseSessionId;
      if (reportedSessionId !== sessionId) return null;
      if (response?.ok === false) return { sessionId, kind: "unknown", role: void 0 };
      if (response?.kind === "child") {
        return { sessionId, kind: "child", role: normalizeStatusRole(response?.child?.role) };
      }
      if (response?.kind === "root") return { sessionId, kind: "root", role: void 0 };
      return { sessionId, kind: "unknown", role: void 0 };
    }

    /**
     * 当前会话状态文案的唯一决策点：running-only、单一当前角色、未知回退。
     * 已有插件 marker 优先确认 child；无 marker 的旧 child 再由 RPC kind=child 补足。
     *
     * 返回值是**不带末尾省略号**的前缀文案（"Explorer running" / "Orchestrator running"）：
     * 它与 shared.js 的同名实现语义同步，用来替换宿主原生文案里的运行前缀
     * （见 replaceNativeStatusPrefix）；逗号、用时与末尾省略号仍由宿主自己的文本提供。
     */
    function resolveRunningStatusText({ sessionId, currentSessionId, running, session, kind, role } = {}) {
      if (sessionId === void 0 || sessionId === null || sessionId !== currentSessionId || running !== true) return null;
      const markedChild = isPluginChildSession(session);
      const normalizedRole = normalizeStatusRole(role);
      const roleText = normalizedRole === void 0 ? null : STATUS_ROLE_LABELS[normalizedRole] + " running";
      if (kind === "pending") return markedChild ? roleText : null;
      if (kind === "unknown") return markedChild ? roleText : null;
      if (kind === "child") return roleText;
      if (kind === "root") return markedChild ? null : "Orchestrator running";
      if (kind !== void 0 && kind !== null) return null;
      if (markedChild) return roleText;
      return "Orchestrator running";
    }

    /**
     * DSH 会话边界可能使用任一公开 data-* 属性；状态行自身没有属性时还要沿祖先查找。
     * markerless DOM 只能在所有已发现属性都精确指向当前会话时写入，否则保持原生文案。
     */
    const NATIVE_SESSION_ATTRIBUTES = [
      "data-session-id",
      "data-conversation-session-id",
      "data-conversation-session",
      "data-session",
    ];

    function nativeStatusSessionValues(node, boundary) {
      const values = [];
      let current = node;
      while (current !== null && current !== void 0) {
        if (typeof current.getAttribute === "function") {
          for (const name of NATIVE_SESSION_ATTRIBUTES) {
            const value = current.getAttribute(name);
            if (typeof value === "string" && value.length > 0) values.push(value);
          }
        }
        if (boundary !== void 0 && current === boundary) break;
        current = current.parentNode;
      }
      return values;
    }

    /**
     * 按指定边界校验候选节点：markerless 需要至少一条当前会话证据；已有 scope 时即使
     * 只靠 scope 证明归属，也必须拒绝节点自身或祖先携带的冲突 session 属性。
     */
    function nativeStatusNodeMatchesSession(node, sessionId, boundary, requireEvidence) {
      if (sessionId === void 0 || sessionId === null || String(sessionId).length === 0) return false;
      const values = nativeStatusSessionValues(node, boundary);
      const expected = String(sessionId);
      return (!requireEvidence || values.length > 0) && values.every((value) => value === expected);
    }

    /**
     * 优先使用 session-scoped bridge 自身的 DOM anchor；右侧 subagentchat 与主视图可同时存在
     * 多棵可见 conversation scope，此 anchor 是唯一不依赖可见性猜测的归属证据。
     * 没有 scope marker 时仍监听 root，但实际写入必须由原生状态节点或祖先的精确会话属性证明归属。
     */
    function findNativeConversationScope(root, sessionId, anchor) {
      const anchoredScope = anchor?.closest?.("[data-conversation-scroll]");
      if (anchoredScope !== null && anchoredScope !== void 0) return anchoredScope;

      const scopes = [];
      if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
      for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      if (scopes.length === 0) {
        // DSH RC1 的 ChatView 真实 DOM 没有稳定的 conversation scope marker。
        // 即使 TurnStatus 尚未创建，也必须监听 root；节点出现后 observer 才能即时接管首帧。
        // findNativeStatusTextNode 会再要求候选节点沿祖先链提供精确会话属性。
        return root;
      }

      // 会话证据与候选边界共用同一份定义：RC1 的会话标记在 scroll 的
      // [data-conversation-content] 外层，只读 scope 自身会把当前会话判成"无标记"。
      const scopeIds = (scope) => nativeStatusScopeIds(scope);
      const exact = sessionId === void 0 || sessionId === null
        ? []
        : scopes.filter((scope) => scopeIds(scope).includes(String(sessionId)));
      const tagged = scopes.filter((scope) => scopeIds(scope).length > 0);
      let candidates = [];
      if (exact.length === 1) {
        candidates = exact;
      } else if (exact.length > 1) {
        const visible = exact.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
        if (visible.length === 1) candidates = visible;
      } else if (tagged.length === 0 && scopes.length === 1) {
        candidates = scopes;
      } else if (tagged.length === 0) {
        const visible = scopes.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
        if (visible.length === 1) candidates = visible;
      }
      return candidates.length === 1 ? candidates[0] : void 0;
    }

    /**
     * CSS Module 稳定局部名匹配：只认局部名本身，不绑定构建 hash 形态。
     * Vite 默认产物是 `_label_hash_line`，旧夹具/其它工具链是 `hash_label`；两种形状都只
     * 依赖 "label" 这一个稳定局部名，因此既不能硬编码完整 hash，也不能只认某一种拼接。
     */
    const localClassTokenPatterns = new Map();
    function hasLocalClassToken(className, localName) {
      if (typeof className !== "string") return false;
      // 局部名只来自本文件的常量；缓存两个正则是因为这段代码在每次 observer 通知里对
      // 每个候选元素都会跑一遍，热路径上不值得反复编译同一个正则。
      let patterns = localClassTokenPatterns.get(localName);
      if (patterns === void 0) {
        patterns = [new RegExp("(?:^|_)" + localName + "$"), new RegExp("^_" + localName + "(?:_|$)")];
        localClassTokenPatterns.set(localName, patterns);
      }
      return className.split(/\s+/).some((token) => patterns[0].test(token) || patterns[1].test(token));
    }

    /**
     * DSH 0.1.7 的隐藏 announcement 语义。aria-atomic=true 是它最稳定的标记，
     * visuallyHidden 局部名 / hidden / aria-hidden=true 是等价的隐藏形状。
     * 只按属性语义判断，不读布局：CSS Module hash 变化不会影响判定，隐藏节点永远不会被写成可见文案。
     */
    function isHiddenStatusCandidate(node) {
      if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
      if (node.getAttribute("aria-atomic") === "true") return true;
      if (node.getAttribute("aria-hidden") === "true") return true;
      const hidden = node.getAttribute("hidden");
      if (hidden !== null && hidden !== void 0) return true;
      return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
    }

    /**
     * 唯一主文本节点：恰好一个 trim 后非空的直接 Text，其余子节点只能是 aria-hidden=true 计时器。
     * 新旧两种形状共用同一形状约束，避免命中拼装状态、notice 或带额外子节点的容器。
     */
    function singleNativeStatusTextNode(node) {
      const childNodes = Array.from(node?.childNodes ?? []);
      const textNodes = childNodes.filter((child) => child?.nodeType === 3);
      const accessoryNodes = childNodes.filter((child) => child?.nodeType !== 3);
      const hasOnlyAriaHiddenAccessories = accessoryNodes.every((child) =>
        child?.nodeType === 1 && typeof child?.getAttribute === "function" && child.getAttribute("aria-hidden") === "true"
      );
      if (textNodes.length !== 1 || typeof textNodes[0].nodeValue !== "string" || textNodes[0].nodeValue.trim().length === 0 || !hasOnlyAriaHiddenAccessories) return void 0;
      return textNodes[0];
    }

    /** 深度优先收集后代元素；label 查找只在 button 子树内做，范围固定且很小。 */
    function collectDescendantElements(node, out = []) {
      for (const child of Array.from(node?.childNodes ?? [])) {
        if (child?.nodeType !== 1) continue;
        out.push(child);
        collectDescendantElements(child, out);
      }
      return out;
    }

    /**
     * DSH 0.1.7 的可见状态目标是 span，不是任意带 label 局部名的元素：
     * 按钮内部的图标/计时器容器或嵌套控件同样可能叫 label，但只有 span 承担可见文案。
     * 大小写不敏感（真实 DOM 给 SPAN，fake DOM 给 span），缺失 tagName 时保守拒绝。
     */
    function isSpanStatusLabelElement(element) {
      return typeof element?.tagName === "string" && element.tagName.toLowerCase() === "span";
    }

    /** 读取节点自身携带的全部公开会话属性值（空值忽略）。 */
    function sessionValuesOf(node) {
      const values = [];
      if (typeof node?.getAttribute === "function") {
        for (const name of NATIVE_SESSION_ATTRIBUTES) {
          const value = node.getAttribute(name);
          if (typeof value === "string" && value.length > 0) values.push(value);
        }
      }
      return values;
    }

    /**
     * 定位 DSH 0.2.0-rc1 的会话证据容器。
     *
     * RC1 的 data-conversation-session 不在 [data-conversation-scroll] 上，而在它的
     * [data-conversation-content] 外层容器上；只读 scroll 自身会把当前会话判定成"无标记"，
     * 于是两棵 conversation 并存时整体放弃，新运行行完全漏掉。
     *
     * 语义边界（与 shared.js 同名实现同步）：
     * - 没有 [data-conversation-content] 祖先时返回 undefined：绝不越过 scroll 向上猜证据，
     *   既有 legacy 形态（会话属性直接落在 scope 或状态节点上）语义完全不变；
     * - 有 content 祖先时，就近取它或它最近带会话属性的祖先作为证据容器；冲突属性仍由
     *   nativeStatusNodeMatchesSession 的"链上所有已发现属性必须一致"兜住。
     */
    function nativeConversationEvidenceOwner(scope) {
      let content;
      let current = scope;
      while (current !== null && current !== void 0) {
        if (typeof current.getAttribute === "function" && current.getAttribute("data-conversation-content") !== null) {
          content = current;
          break;
        }
        current = current.parentNode;
      }
      if (content === void 0) return void 0;
      let node = content;
      while (node !== null && node !== void 0) {
        if (typeof node.getAttribute === "function" && sessionValuesOf(node).length > 0) return node;
        node = node.parentNode;
      }
      return content;
    }

    /** scope 的会话证据：scope 自身的会话属性 + RC1 content 外层的会话属性。 */
    function nativeStatusScopeIds(scope) {
      return [...sessionValuesOf(scope), ...sessionValuesOf(nativeConversationEvidenceOwner(scope))];
    }

    /** 候选节点的会话证据边界：RC1 用 content 外层，legacy 用 scope 自身。 */
    function nativeStatusSessionBoundary(scope) {
      return nativeConversationEvidenceOwner(scope) ?? scope;
    }

    /**
     * RC1 装饰子树判定：aria-hidden=true / inert / hidden / visuallyHidden 局部名都属于
     * "不承载可见文案"的动画副本（TextShimmer 的扫光副本就在这里）。
     *
     * 与 isHiddenStatusCandidate 分开：后者还要把 aria-atomic 的隐藏 announcement 视为不可见
     * 候选，而这里只用于"在跑马灯里找真实可见文案"。
     */
    function isDecorativeNativeStatusNode(node) {
      if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
      if (node.getAttribute("aria-hidden") === "true") return true;
      const hidden = node.getAttribute("hidden");
      if (hidden !== null && hidden !== void 0) return true;
      const inert = node.getAttribute("inert");
      if (inert !== null && inert !== void 0) return true;
      return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
    }

    /**
     * 收集非装饰子树里的可见 Text（深度优先）。
     * 装饰子树整棵跳过：它的文字与真实可见文案相同，但属于宿主动画的一部分。
     */
    function collectVisibleStatusTextNodes(node, out = [], hidden = false) {
      const hiddenHere = hidden || isDecorativeNativeStatusNode(node);
      for (const child of Array.from(node?.childNodes ?? [])) {
        if (child?.nodeType === 3) {
          if (!hiddenHere && typeof child.nodeValue === "string" && child.nodeValue.trim().length > 0) out.push(child);
          continue;
        }
        if (child?.nodeType !== 1) continue;
        collectVisibleStatusTextNodes(child, out, hiddenHere);
      }
      return out;
    }

    /**
     * DSH 0.2.0-rc1 官方运行行的字段集合（与 shared.js 同名实现同步）。
     *
     * 结构（实测 DOM）：
     * conversation[data-conversation-content][data-conversation-session]
     *   > [data-conversation-scroll] > [data-chat-running]
     *     ├─ role=status/aria-live=polite/aria-atomic=true 的隐藏 announcement
     *     ├─ 鲸鱼尾巴等 aria-hidden 装饰
     *     └─ [data-shimmer="true"]
     *         ├─ 可见子树：唯一的真实文案 Text（含"深度求索中，用时8分12秒..."）
     *         └─ aria-hidden/inert 装饰副本：data-shimmer-text 保存同一份完整标签
     *
     * fail-closed：行、跑马灯容器、可见 Text 任一项不是恰好一个就整体放弃，绝不猜可见性；
     * 归属由行到会话边界的属性链证明（冲突或缺证据时放弃）。
     */
    function findNativeRunningRowParts(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
      if (scope == null) return void 0;
      const rows = [];
      if (scope?.matches?.("[data-chat-running]")) rows.push(scope);
      for (const row of Array.from(scope?.querySelectorAll?.("[data-chat-running]") ?? [])) {
        if (!rows.includes(row)) rows.push(row);
      }
      if (rows.length !== 1) return void 0;
      const row = rows[0];
      if (!nativeStatusNodeMatchesSession(row, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

      const shimmers = collectDescendantElements(row).filter((element) => element?.getAttribute?.("data-shimmer") === "true");
      if (shimmers.length !== 1) return void 0;
      const visibleTexts = collectVisibleStatusTextNodes(shimmers[0]);
      if (visibleTexts.length !== 1) return void 0;
      const visibleText = visibleTexts[0];
      // 不只校验 running row：实际被写入的 Text 和属性节点也可能带冲突会话标记。
      if (!nativeStatusNodeMatchesSession(visibleText, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

      const shimmerTextNodes = collectDescendantElements(row).filter((element) => {
        const value = element?.getAttribute?.("data-shimmer-text");
        return value !== null && value !== void 0;
      });
      if (shimmerTextNodes.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
      const announcementTexts = [];
      for (const element of collectDescendantElements(row)) {
        if (element?.getAttribute?.("role") !== "status") continue;
        if (element?.getAttribute?.("aria-live") !== "polite") continue;
        if (element?.getAttribute?.("aria-atomic") !== "true") continue;
        const textNode = singleNativeStatusTextNode(element);
        if (textNode !== void 0) announcementTexts.push(textNode);
      }
      if (announcementTexts.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
      return { visibleText, shimmerTextNodes, announcementTexts };
    }

    /**
     * DSH 0.1.7 把可见运行状态放进 button[data-turn-process] 内的 span.label。
     * 只有可见、且恰好唯一命中的 label 才是候选：隐藏 announcement 永不入选，非 span 元素
     * 与多义候选（同 scope 多个可见 label，例如历史 turn 的按钮）一律放弃，交由 legacy 兜底而不是猜。
     */
    function findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
      if (scope == null) return void 0;
      const matches = [];
      for (const button of Array.from(scope?.querySelectorAll?.("button[data-turn-process]") ?? [])) {
        if (button?.getAttribute?.("data-turn-process") === null || button?.getAttribute?.("data-turn-process") === void 0) continue;
        if (isHiddenStatusCandidate(button)) continue;
        for (const candidate of collectDescendantElements(button)) {
          if (!isSpanStatusLabelElement(candidate)) continue;
          if (!hasLocalClassToken(candidate?.getAttribute?.("class"), "label")) continue;
          if (isHiddenStatusCandidate(candidate)) continue;
          const textNode = singleNativeStatusTextNode(candidate);
          if (textNode === void 0) continue;
          if ((requireSessionEvidence || sessionBoundary !== void 0)
            && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
          matches.push(textNode);
        }
      }
      return matches.length === 1 ? matches[0] : void 0;
    }

    /**
     * 在已确定的会话 scope 内定位 legacy（非 RC1）形态的运行状态主文本节点。
     * 文案只检查为非空 Text，不绑定任何 locale；候选优先级为 DSH 0.1.7 的可见 turn-process
     * label，其次是 0.1.6 的 legacy turnStatus。新版缺失或多义时回退 legacy，legacy 自身多义
     * 仍保持"不改"的保守语义；两种形状的隐藏 announcement 都永不作为目标。
     * RC1 的 [data-chat-running] 行由 resolveNativeStatusTargets 优先处理，不在这里兜底。
     */
    function findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
      if (scope == null) return void 0;
      const labelNode = findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
      if (labelNode !== void 0) return labelNode;

      const statuses = [];
      if (scope?.matches?.('[role="status"]')) statuses.push(scope);
      for (const status of Array.from(scope?.querySelectorAll?.('[role="status"]') ?? [])) {
        if (!statuses.includes(status)) statuses.push(status);
      }
      let match;
      for (const status of statuses) {
        if (status?.getAttribute?.("role") !== "status" || status?.getAttribute?.("aria-live") !== "polite") continue;
        if (isHiddenStatusCandidate(status)) continue;
        if (!hasLocalClassToken(status?.getAttribute?.("class"), "turnStatus")) continue;
        const textNode = singleNativeStatusTextNode(status);
        if (textNode === void 0) continue;
        if ((requireSessionEvidence || sessionBoundary !== void 0)
          && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
        if (match !== void 0) return void 0;
        match = textNode;
      }
      return match;
    }


    /** 文档中所有原生 conversation scope（含 root 自身）：多 scope 并存时的最小遍历单位。 */
    function collectNativeConversationScopes(root) {
      const scopes = [];
      if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
      for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      return scopes;
    }

    /**
     * 一个 scope 的会话身份：scope 自身与 RC1 content 外层的全部会话属性必须一致地指向
     * 同一个会话；缺失（0 个值）或冲突（多个不同值）都不提供身份。
     *
     * 这是多 scope（主视图 + 右侧 sidebar.chat）并存的归属依据：每个 scope 自己证明自己
     * 属于哪个会话，插件不需要、也不允许再依赖"单个主视图会话"去猜侧栏目标。
     */
    function nativeScopeSessionId(scope) {
      const values = new Set(nativeStatusScopeIds(scope));
      if (values.size !== 1) return void 0;
      for (const value of values) return value;
      return void 0;
    }

    /** legacy 状态节点（没有 conversation scope）的会话身份：同样要求祖先链上唯一。 */
    function nativeStatusNodeSessionId(node) {
      const values = new Set(nativeStatusSessionValues(node, void 0));
      if (values.size !== 1) return void 0;
      for (const value of values) return value;
      return void 0;
    }

    /**
     * 收集当前文档里所有"身份可验证"的原生状态目标所属的会话 id（每个会话 id 对应一条
     * 独立 lane）。判定规则与写入规则同源，因此 lane 候选本身就 fail-closed：
     * - 有 conversation scope 时逐个 scope 取唯一会话身份；缺失/冲突的 scope 不产生 lane；
     * - 没有 scope（legacy 形态）时按状态节点自身的唯一会话属性归并；冲突节点被忽略。
     * 真实会话是否存在、是否 running、身份是什么，仍由调用方按 session snapshot 与 RPC 决定。
     */
    function collectNativeStatusSessionIds(root) {
      const ids = new Set();
      const scopes = collectNativeConversationScopes(root);
      if (scopes.length > 0) {
        for (const scope of scopes) {
          const sessionId = nativeScopeSessionId(scope);
          if (sessionId !== void 0) ids.add(sessionId);
        }
        return ids;
      }
      const statuses = [];
      if (root?.matches?.('[role="status"]')) statuses.push(root);
      for (const status of Array.from(root?.querySelectorAll?.('[role="status"]') ?? [])) {
        if (!statuses.includes(status)) statuses.push(status);
      }
      for (const status of statuses) {
        if (status?.getAttribute?.("aria-live") !== "polite") continue;
        const sessionId = nativeStatusNodeSessionId(status);
        if (sessionId !== void 0) ids.add(sessionId);
      }
      for (const button of Array.from(root?.querySelectorAll?.("button[data-turn-process]") ?? [])) {
        const sessionId = nativeStatusNodeSessionId(button);
        if (sessionId !== void 0) ids.add(sessionId);
      }
      return ids;
    }

    /**
     * 解析当前会话的原生运行状态**全字段**目标（纯 DOM 选择，不写入；与 shared.js 同名实现同步）：
     * - RC1：返回 { visibleText, shimmerAttributes, announcements } 三项完整字段；
     * - legacy（0.1.7 label / 0.1.6 turnStatus）：只返回可见 Text，另外两项为空。
     *
     * 会话判定：优先 data-conversation-scroll 边界；RC1 的会话标记在它的
     * [data-conversation-content] 外层，因此证据与候选边界都按 nativeStatusScopeIds /
     * nativeStatusSessionBoundary 取；没有 scope marker 时扫描 root 并强制要求祖先会话证据。
     * 任何冲突、歧义或缺少证据的情况都返回 undefined，让调用方保持宿主原文。
     */
    function resolveNativeStatusScopeTargets(scope, sessionId) {
      const requireSessionEvidence = nativeStatusScopeIds(scope).includes(String(sessionId));
      const sessionBoundary = nativeStatusSessionBoundary(scope);
      const parts = findNativeRunningRowParts(scope, sessionId, requireSessionEvidence, sessionBoundary);
      if (parts !== void 0) {
        return {
          visibleText: parts.visibleText,
          shimmerAttributes: parts.shimmerTextNodes,
          announcements: parts.announcementTexts,
        };
      }
      const textNode = findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
      return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
    }

    function resolveNativeStatusTargets(root, sessionId, includeSameSessionScopes = false) {
      const scopes = collectNativeConversationScopes(root);

      if (scopes.length === 0) {
        const textNode = findNativeTurnStatusTextNode(root, sessionId, true);
        return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
      }

      const exact = sessionId === void 0 || sessionId === null
        ? []
        : scopes.filter((scope) => nativeStatusScopeIds(scope).includes(String(sessionId)));
      const tagged = scopes.filter((scope) => nativeStatusScopeIds(scope).length > 0);
      if (includeSameSessionScopes && exact.length > 1) {
        const resolved = exact
          .filter((scope) => nativeScopeSessionId(scope) === String(sessionId))
          .map((scope) => resolveNativeStatusScopeTargets(scope, sessionId))
          .filter((targets) => targets !== void 0);
        if (resolved.length === 0) return void 0;
        return {
          visibleTexts: resolved.map((targets) => targets.visibleText).filter((node) => node != null),
          shimmerAttributes: resolved.flatMap((targets) => targets.shimmerAttributes),
          announcements: resolved.flatMap((targets) => targets.announcements),
        };
      }
      let candidates = [];
      if (exact.length === 1) {
        candidates = exact;
      } else if (exact.length > 1) {
        const visible = exact.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
        if (visible.length === 1) candidates = visible;
      } else if (tagged.length === 0 && scopes.length === 1) {
        candidates = scopes;
      } else if (tagged.length === 0) {
        const visible = scopes.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
        if (visible.length === 1) candidates = visible;
      }
      if (candidates.length !== 1) return void 0;

      return resolveNativeStatusScopeTargets(candidates[0], sessionId);
    }

    /**
     * 选择当前页面会话的原生运行状态**可见**主文本节点（公开只读 seam）。
     * RC1 返回 [data-shimmer="true"] 非装饰子树里的真实可见 Text；legacy 形态继续返回
     * 各自唯一的可见 Text。选择与会话判定语义与 shared.js 的同名导出同步。
     */
    function findNativeStatusTextNode(root, sessionId) {
      return resolveNativeStatusTargets(root, sessionId)?.visibleText;
    }

    /**
     * 原生运行状态文案的可替换前缀候选（票据 19：中英文 locale 都生效）。
     *
     * DSH 0.2.0-rc1 在输入区上方渲染宿主自己的运行状态行：中文 locale 形如
     * 「深度求索中，用时8分12秒...」，英文 locale 可能是 "Deep diving..." / "Deep thinking..." /
     * "Thinking..."。插件只拥有这一段前缀：替换它就能把当前会话的角色投影到宿主原生行上，
     * 而逗号、用时、末尾省略号以及前后兄弟节点/动画全部保持宿主原样。
     *
     * 投影同步：权威列表在 shared.js 的 NATIVE_RUNNING_STATUS_PREFIXES，classic bundle 无法
     * import ESM，因此这里是手写投影；两处必须逐项同值（测试同时覆盖两侧）。
     */
    const NATIVE_RUNNING_STATUS_PREFIXES = Object.freeze([
      "深度求索中",
      "Deep diving",
      "Deep thinking",
      "Thinking",
    ]);
    /** 向后兼容：旧导出名继续指中文主前缀；新代码只用候选列表。 */
    const NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIXES[0];

    /**
     * 只替换原生运行前缀的纯函数（fail-closed）。本实现与 shared.js 的同名导出语义同步
     * （classic bundle 无法 import ESM 权威实现，两处只允许逐字保持同一份语义）。
     *
     * 边界语义：
     * - 原文里没有任何候选前缀时返回 null：调用方必须保持宿主原文案，绝不猜测或整行重建；
     * - 只替换**第一处**出现（中英文候选混排时取原文最靠前的那个；同位置优先更长候选），
     *   其余内容逐字节保留（分隔逗号、用时、末尾省略号、空白与大小写）；
     * - 原文或替换文案不是非空字符串时返回 null。
     * @param {unknown} currentText - 宿主当前渲染的原生文案。
     * @param {unknown} replacementText - 角色文案（例如 "Explorer running"，不带省略号）。
     * @returns {string|null} 替换后的完整文案；没有可替换前缀时返回 null。
     */
    function replaceNativeStatusPrefix(currentText, replacementText) {
      if (typeof currentText !== "string" || currentText.length === 0) return null;
      if (typeof replacementText !== "string" || replacementText.length === 0) return null;
      let match = null;
      for (const prefix of NATIVE_RUNNING_STATUS_PREFIXES) {
        const at = currentText.indexOf(prefix);
        if (at === -1) continue;
        if (match === null || at < match.at || (at === match.at && prefix.length > match.prefix.length)) {
          match = { at, prefix };
        }
      }
      if (match === null) return null;
      return currentText.slice(0, match.at) + replacementText + currentText.slice(match.at + match.prefix.length);
    }

    /**
     * 只保存/替换/恢复一个原生主文本节点的**前缀**；不触碰 class/style、计时器或 aria，
     * 也不重建整行。DOM 适配、MutationObserver 与 React 生命周期由调用方持有；本函数只处理
     * 「原生前缀 → 角色文案」的保存/替换/恢复，因此可在无 DOM 的 node:test 中用最小 mock 验证。
     *
     * 原文跟进规则（同一个 Text 节点上的内容随时可能被宿主改写）：
     * - 角色变化：只换前缀，逗号/用时/末尾省略号继续沿用宿主最新原文；
     * - 宿主重渲染、locale 切换或用时刷新：当前值不再是本插件写入的那一份时，把宿主最新值
     *   认定为原文，清理时恢复它——绝不把旧语言或旧用时写回去；
     * - 原文没有原生前缀（例如英文 locale 的 "Deep diving..."）时不做任何写入。
     *
     * 可选 decorate/undecorate 钩子仅用于调用方管理附加生命周期；当前原生状态桥不传入
     * 任何装饰钩子，因此不会向宿主节点添加 marker、样式或动画。rewriter 仍保证换目标和
     * 清理时先处理旧目标，避免调用方留下 stale 状态。
     */
    function createNativeTextRewriter(options = {}) {
      const findNode = typeof options.findNode === "function" ? options.findNode : () => void 0;
      const getText = typeof options.getText === "function" ? options.getText : (node) => node?.nodeValue;
      const setText = typeof options.setText === "function" ? options.setText : (node, value) => { node.nodeValue = value; };
      const isConnected = typeof options.isConnected === "function" ? options.isConnected : (node) => node?.isConnected !== false;
      const decorate = typeof options.decorate === "function" ? options.decorate : () => {};
      const undecorate = typeof options.undecorate === "function" ? options.undecorate : () => {};
      let activeNode;
      let originalText;
      let rewrittenText;

      function restore() {
        // 只在"当前值仍是我们写入的那一份"时回写：宿主已自行改写内容时保持宿主最新值，
        // 避免把旧语言、旧用时或旧角色文案盖回去。
        if (activeNode !== void 0 && isConnected(activeNode) && getText(activeNode) === rewrittenText) {
          setText(activeNode, originalText);
        }
        activeNode = void 0;
        originalText = void 0;
        rewrittenText = void 0;
        undecorate();
      }

      function apply(text) {
        if (typeof text !== "string" || text.length === 0) {
          restore();
          return;
        }
        const candidate = findNode();
        if (candidate === null || candidate === void 0) {
          restore();
          return;
        }
        const currentText = getText(candidate);
        if (activeNode !== candidate) {
          restore();
          activeNode = candidate;
          originalText = currentText;
        } else if (currentText !== rewrittenText) {
          // 同一 Text 节点上的原文被宿主更新（locale 切换、用时刷新、React 重写）；
          // 跟进外部值，清理时恢复的必须是最新原文。
          originalText = currentText;
        }
        const next = replaceNativeStatusPrefix(originalText, text);
        // 没有可替换的原生前缀（英文 locale、宿主已换成完成文案等）时保持原文，不做任何写入。
        rewrittenText = next === null ? currentText : next;
        if (next !== null && currentText !== next) setText(activeNode, next);
        // 装饰放在文本写入之后：无论首次接管、节点替换还是重复通知，装饰都针对当前目标。
        decorate(activeNode);
      }

      return { apply, restore };
    }

    /**
     * 原生状态行上的字段清单：可见 Text、data-shimmer-text 装饰属性、隐藏 announcement Text。
     * legacy 形态只有一个可见 Text 字段。同一 (节点, 属性) 组合只保留一份，避免重复写入。
     */
    function nativeStatusFieldDescriptors(targets) {
      const fields = [];
      if (targets?.visibleText != null) fields.push({ node: targets.visibleText, attribute: void 0 });
      for (const node of targets?.visibleTexts ?? []) {
        if (node != null) fields.push({ node, attribute: void 0 });
      }
      for (const node of targets?.shimmerAttributes ?? []) {
        if (node != null) fields.push({ node, attribute: "data-shimmer-text" });
      }
      for (const node of targets?.announcements ?? []) {
        if (node != null) fields.push({ node, attribute: void 0 });
      }
      return fields.filter((field, index) => fields.findIndex(
        (other) => other.node === field.node && other.attribute === field.attribute,
      ) === index);
    }

    /**
     * 原生运行行的多字段重写器。
     *
     * 为什么不复用"整行一个 createNativeTextRewriter"：RC1 的同一行里，可见文案、装饰副本的
     * data-shimmer-text、隐藏 announcement 是三个互相独立的宿主字段，宿主（计时器刷新、locale
     * 切换、React 重渲染）会分别更新它们。每个字段交给一个独立的 createNativeTextRewriter
     * 处理，就同时得到既有语义：各自保存原文、各自跟进最新值、各自只在"值仍是我们写入的那
     * 一份"时才恢复——既不写回旧后缀，也不碰从未覆盖过的字段、节点与动画。
     *
     * 目标集合在本轮变小时（会话切换、停止、节点重建、announcement 消失），旧字段立即恢复；
     * apply(null/空) 等价于 restore()。
     */
    function createNativeStatusRowRewriter(options = {}) {
      const resolveTargets = typeof options.resolveTargets === "function" ? options.resolveTargets : () => void 0;
      let entries = [];

      /** 单个字段的读写适配：Text 用 nodeValue，装饰副本用 data-shimmer-text 属性。 */
      const createFieldRewriter = (node, attribute) => {
        const read = () => (attribute === void 0 ? node?.nodeValue : node?.getAttribute?.(attribute));
        const write = (value) => {
          if (attribute === void 0) {
            node.nodeValue = value;
            return;
          }
          node?.setAttribute?.(attribute, value);
        };
        return createNativeTextRewriter({
          findNode: () => node,
          getText: () => read(),
          setText: (_candidate, value) => write(value),
          isConnected: () => node?.isConnected !== false,
        });
      };

      const restoreEntries = (list) => {
        for (const entry of list) entry.rewriter.restore();
      };

      function restore() {
        restoreEntries(entries);
        entries = [];
      }

      function apply(text) {
        const targets = typeof text === "string" && text.length > 0 ? resolveTargets() : void 0;
        const fields = targets === void 0 ? [] : nativeStatusFieldDescriptors(targets);
        if (fields.length === 0) {
          restore();
          return;
        }
        const next = [];
        for (const field of fields) {
          let entry = entries.find((candidate) => candidate.node === field.node && candidate.attribute === field.attribute);
          if (entry === void 0) {
            entry = { node: field.node, attribute: field.attribute, rewriter: createFieldRewriter(field.node, field.attribute) };
          }
          entry.rewriter.apply(text);
          next.push(entry);
        }
        // 本轮不再覆盖的字段必须立刻恢复：只回写插件确实写过的那一份值。
        restoreEntries(entries.filter((entry) => !next.includes(entry)));
        entries = next;
      }

      return { apply, restore };
    }

    /** 使用 shell.overlay 注入的全局 useSessions；旧 slot 则使用现有 sessions.list。 */
    function useSessionList(ctx, useSessions) {
      if (typeof useSessions === "function") return useSessions((snapshot) => snapshot);
      return react.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot);
    }

    const EMPTY_PENDING_INTERACTIONS = () => null;
    const IDENTITY_SELECTOR = (snapshot) => snapshot;
    const PENDING_KIND_LABELS = {
      approval: "审批确认",
      "plan-review": "计划确认",
      question: "问题待答",
    };

    /** 将 sessions.byId 和 pending interaction 统一成可遍历条目；异常快照按空集合处理。 */
    function readEntries(value) {
      if (value == null) return [];
      // Map.entries() 的物化结果本身也是数组；保留 [key, value]，不能再次读取数组索引。
      if (Array.isArray(value)) {
        if (value.every((entry) => Array.isArray(entry) && entry.length === 2)) return value;
        return value.map((entry, index) => [String(index), entry]);
      }
      if (typeof value.entries === "function") {
        try { return Array.from(value.entries()); } catch { return []; }
      }
      if (typeof value === "object") return Object.entries(value);
      return [];
    }

    /**
     * 旧版 slot owner 不提供标准 pending hook 时，从会话条目的兼容字段读取待处理操作。
     * DSH 会话快照中的 pendingInteraction 既可能是对象，也可能直接是 kind 字符串；
     * 两者都保留到 Map，后续统一生成稳定键并做严格 kind 过滤。
     */
    function readSessionPendingInteractions(sessionList) {
      const pending = new Map();
      for (const [fallbackId, session] of readEntries(sessionList?.byId)) {
        const interaction = session?.pendingInteraction;
        const sessionId = sessionIdOf(interaction, sessionIdOf(session, fallbackId));
        if (sessionId !== void 0 && interaction !== null && (typeof interaction === "object" || typeof interaction === "string")) {
          pending.set(sessionId, interaction);
        }
      }
      return pending;
    }

    /** 标准 hook 优先；缺少 hook 时回退到当前会话列表的 pendingInteraction 字段。 */
    function useOptionalSessionPendingInteraction(useSessionPendingInteraction, sessionList) {
      const hook = typeof useSessionPendingInteraction === "function"
        ? useSessionPendingInteraction
        : EMPTY_PENDING_INTERACTIONS;
      if (typeof useSessionPendingInteraction === "function") return hook(IDENTITY_SELECTOR);
      return readSessionPendingInteractions(sessionList);
    }

    function sessionIdOf(session, fallbackId) {
      const id = session?.sessionId ?? session?.id ?? fallbackId;
      return typeof id === "string" && id.length > 0 ? id : void 0;
    }

    /**
     * 解析 DSH 当前主视图会话。
     *
     * RC2 移除了 session-list 快照里的 current 字段，当前主视图改由会话行的
     * retainedBy.mainView 持有计数表达；旧宿主仍优先使用 current。readEntries 让
     * 两代宿主及测试替身的 object/Map/entry-array 形状保持同一套 fail-closed 语义。
     */
    function currentSessionIdOf(sessionList) {
      const legacyCurrent = metadataString(sessionList?.current);
      if (legacyCurrent !== void 0) return legacyCurrent;
      for (const [fallbackId, session] of readEntries(sessionList?.byId)) {
        if (!(Number(session?.retainedBy?.mainView) > 0)) continue;
        const currentId = sessionIdOf(session, fallbackId);
        if (currentId !== void 0) return currentId;
      }
      return void 0;
    }

    /** 从任意兼容形状的 session-list 快照中读取一个明确的会话条目。 */
    function sessionEntryOf(sessionList, sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
      for (const [fallbackId, session] of readEntries(sessionList?.byId)) {
        if (sessionIdOf(session, fallbackId) === sessionId) return session;
      }
      return void 0;
    }

    /** 当前选中 child 需沿 parentId/parentSessionId 找到所属 root，循环或缺失快照均安全停止。 */
    function rootSessionIdOf(sessionEntries, currentSessionId) {
      if (typeof currentSessionId !== "string" || currentSessionId.length === 0) return void 0;
      const sessions = new Map();
      for (const [fallbackId, session] of sessionEntries) {
        const sessionId = sessionIdOf(session, fallbackId);
        if (sessionId !== void 0) sessions.set(sessionId, session);
      }
      if (!sessions.has(currentSessionId)) return void 0;
      let rootSessionId = currentSessionId;
      let candidate = currentSessionId;
      const visited = new Set();
      while (!visited.has(candidate)) {
        visited.add(candidate);
        const parentId = sessions.get(candidate)?.parentId ?? sessions.get(candidate)?.parentSessionId;
        if (typeof parentId !== "string" || parentId.length === 0 || parentId === candidate) break;
        rootSessionId = parentId;
        if (!sessions.has(parentId)) break;
        candidate = parentId;
      }
      return rootSessionId;
    }

    /** 把任意 DSH session-list 快照变成 rootSessionIdOf 接受的稳定 entries。 */
    function expertGroupRootSessionIdOf(sessionId, _session, snapshot) {
      const entries = readEntries(snapshot?.byId ?? snapshot?.sessions ?? snapshot);
      return rootSessionIdOf(entries, sessionId) ?? sessionId;
    }

    function sessionRoleOf(session) {
      return normalizeStatusRole(
        session?.[STATUS_ROLE_MARKER]
          ?? session?.metadata?.[STATUS_ROLE_MARKER]
          ?? session?.role
          ?? session?.metadata?.role
          ?? session?.child?.role,
      );
    }

    const SUBAGENT_METADATA_MARKER = "data-deg-subagent-metadata";
    const SUBAGENT_METADATA_CLASS = "deg_subagent_metadata";

    /** 元数据只接受非空字符串；这样 RPC 或快照中的对象、数字不会进入用户可见文案。 */
    function metadataString(value) {
      if (typeof value !== "string") return void 0;
      const text = value.trim();
      return text.length > 0 ? text : void 0;
    }

    function readSubagentMetadataField(value, field) {
      const sources = [value, value?.child, value?.metadata];
      for (const source of sources) {
        const text = metadataString(source?.[field]);
        if (text !== void 0) return text;
      }
      return void 0;
    }

    /**
     * 统一快照和 RPC 的 child 字段。没有完整的 role/provider/model/reasoningEffort
     * 时保留空对象，由 formatSubagentMetadata 决定不渲染半截文案。
     */
    function normalizeSubagentMetadata(value) {
      const source = value && typeof value === "object" ? value : {};
      const normalized = {};
      const role = sessionRoleOf(source) ?? normalizeStatusRole(readSubagentMetadataField(source, "role"));
      if (role !== void 0) normalized.role = role;
      for (const field of ["provider", "model", "reasoningEffort"]) {
        const text = readSubagentMetadataField(source, field);
        if (text !== void 0) normalized[field] = text;
      }
      return normalized;
    }

    /** 角色显示名是固定映射，未知角色、模型或思考深度都不产生 DOM 文案。 */
    function formatSubagentMetadata(value) {
      const metadata = normalizeSubagentMetadata(value);
      const label = metadata.role === void 0 ? void 0 : STATUS_ROLE_LABELS[metadata.role];
      // provider 用于确认 RPC 返回的是完整 child 配置，但问题5只展示模型与思考深度。
      if (label === void 0 || metadata.provider === void 0 || metadata.model === void 0 || metadata.reasoningEffort === void 0) return null;
      return [label, metadata.model, metadata.reasoningEffort].join(" · ");
    }

    function subagentTaskNameOf(value) {
      const sources = [value, value?.child, value?.metadata];
      for (const field of ["taskName", "task", "title", "displayTitle", "label", "name"]) {
        for (const source of sources) {
          const text = metadataString(source?.[field]);
          if (text !== void 0) return text;
        }
      }
      return void 0;
    }

    function subagentParentIdOf(session) {
      const direct = metadataString(session?.parentId) ?? metadataString(session?.parentSessionId);
      if (direct !== void 0) return direct;
      const origin = session?.origin;
      if (origin && typeof origin === "object") {
        return metadataString(origin.parentId)
          ?? metadataString(origin.parentSessionId)
          ?? sessionIdOf(origin);
      }
      // origin="subagent" 只说明类型，不能据此猜测它属于哪个 root。
      return origin !== "subagent" ? metadataString(origin) : void 0;
    }

    /**
     * 读取一份子代理目录投影值（`projectionsBySession[sessionId].values.subagentCatalog`）。
     *
     * 0.1.7-alpha.2 的子代理目录是按会话 id 索引的投影值，目录项固定为数组，只保证身份类
     * 字段（id/createdAt/mode/label）。非数组（缺失、旧形状、读取异常）一律按空目录处理。
     */
    function subagentCatalogEntries(value) {
      return Array.isArray(value) ? value : [];
    }

    /**
     * 把会话投影 `projectionsBySession` 转成有序父子关系。
     *
     * 每个会话的 `values.subagentCatalog` 是该会话的直系子代理；递归层级与父子树由
     * collectSubagentCatalog 在该关系上从 root 做 DFS 重建。目录项只提供身份/时间/模式/标签：
     * 任务标题与运行状态一律继续从 byId 投影与 DEG 自己的元数据读取，绝不用目录项冒充展示数据。
     */
    function readSubagentCatalogRelations(projectionsBySession) {
      const relations = [];
      for (const [fallbackParentId, projection] of readEntries(projectionsBySession)) {
        const parentId = metadataString(fallbackParentId) ?? sessionIdOf(fallbackParentId);
        if (parentId === void 0) continue;
        const snapshot = projection && typeof projection === "object" ? projection : {};
        for (const rawEntry of subagentCatalogEntries(snapshot.values?.subagentCatalog)) {
          const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
          const childId = sessionIdOf(entry);
          if (childId === void 0) continue;
          relations.push({
            parentId,
            childId,
            child: entry,
            taskName: metadataString(entry.label),
          });
        }
      }
      return relations;
    }

    /**
     * 当前会话所属 root：byId 的父子字段优先，投影目录作为补充证据。
     *
     * 目录只提供父子关系（身份/层级），因此这里只沿投影里的 parent 链上溯，
     * 不读取任何展示字段。
     */
    function resolveSubagentRootSessionId(sessionEntries, currentSessionId, projectionsBySession) {
      if (typeof currentSessionId !== "string" || currentSessionId.length === 0) return void 0;
      const fromSessions = rootSessionIdOf(sessionEntries, currentSessionId);
      if (fromSessions !== void 0) return fromSessions;
      const parents = new Map();
      for (const relation of readSubagentCatalogRelations(projectionsBySession)) {
        if (!parents.has(relation.childId)) parents.set(relation.childId, relation.parentId);
      }
      let candidate = currentSessionId;
      const visited = new Set();
      while (!visited.has(candidate)) {
        visited.add(candidate);
        const parentId = parents.get(candidate);
        if (parentId === void 0 || parentId === candidate) break;
        candidate = parentId;
      }
      return candidate;
    }

    /**
     * 目录顺序优先于 byId 枚举顺序；从 root 做 DFS，既覆盖直接 child，也覆盖递归 child。
     * 不把 root 本身放入结果，因而不会猜测根会话的模型或思考深度。
     *
     * 目录来源固定为会话投影 `projectionsBySession[sessionId].values.subagentCatalog`：
     * 它只提供身份/时间/模式/标签，因此任务名与运行状态仍从 byId 投影与 DEG 元数据读取。
     */
    function collectSubagentCatalog(sessionList, currentRootSessionId) {
      const sessionEntries = readEntries(sessionList?.byId);
      const sessions = new Map();
      for (const [fallbackId, session] of sessionEntries) {
        const sessionId = sessionIdOf(session, fallbackId);
        if (sessionId !== void 0) sessions.set(sessionId, session);
      }
      const childrenByParent = new Map();
      const addChild = (parentId, childId, child, taskName) => {
        if (typeof parentId !== "string" || typeof childId !== "string" || parentId === childId) return;
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        const children = childrenByParent.get(parentId);
        if (children.some((entry) => entry.childId === childId)) return;
        children.push({ childId, child, taskName: metadataString(taskName) });
        if (!sessions.has(childId) && child && typeof child === "object") sessions.set(childId, child);
      };
      // 会话投影目录是显式顺序来源，先加入它，再用 byId 的父子字段补齐投影尚未落地的 child。
      for (const relation of readSubagentCatalogRelations(sessionList?.projectionsBySession)) {
        addChild(relation.parentId, relation.childId, relation.child, relation.taskName);
      }
      for (const [sessionId, session] of sessions) {
        const parentId = subagentParentIdOf(session);
        if (parentId !== void 0) addChild(parentId, sessionId, session, void 0);
      }
      if (typeof currentRootSessionId !== "string" || currentRootSessionId.length === 0) return [];

      const result = [];
      const visited = new Set([currentRootSessionId]);
      const visit = (parentId) => {
        for (const { childId, child, taskName: catalogTaskName } of childrenByParent.get(parentId) ?? []) {
          if (visited.has(childId)) continue;
          visited.add(childId);
          const session = sessions.get(childId) ?? child;
          const metadata = normalizeSubagentMetadata(session);
          result.push({
            sessionId: childId,
            // catalog entry.label 是原生菜单任务名的直接来源，byId 字段只作 fallback。
            taskName: catalogTaskName ?? subagentTaskNameOf(session),
            ...metadata,
            metadata,
          });
          visit(childId);
        }
      };
      visit(currentRootSessionId);
      return result;
    }

    /** 同源 Host RPC 的唯一 child 元数据读取入口；失败和非 child 响应都安全返回 null。 */
    async function requestSubagentMetadata(sessionId, request = globalThis?.fetch, signal, connection) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      if (typeof request !== "function" && typeof connection?.rpc?.call !== "function") return null;
      try {
        const rpc = connection?.rpc;
        const response = typeof rpc?.call === "function"
          ? await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { action: "get", sessionId, childHint: true }, signal)
          : await request(RPC_PATH, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            ...(signal === void 0 ? {} : { signal }),
            body: JSON.stringify({ action: "get", sessionId, childHint: true }),
          });
        if (response?.ok !== true) return null;
        const payload = typeof response?.json === "function" ? await response.json() : response?.value;
        if (payload?.ok !== true || payload?.kind !== "child") return null;
        return normalizeSubagentMetadata(payload.child);
      } catch {
        return null;
      }
    }

    function nativeElementChildren(node) {
      return Array.from(node?.childNodes ?? []).filter((child) => child?.nodeType === 1);
    }

    function nativeElements(root) {
      if (root == null) return [];
      const elements = root?.nodeType === 1 ? [root] : [];
      try {
        for (const element of Array.from(root.querySelectorAll?.("*") ?? [])) {
          if (!elements.includes(element)) elements.push(element);
        }
      } catch {}
      return elements;
    }

    /** 只遍历当前 treeitem 自己的 row；嵌套 treeitem 由独立循环处理。 */
    function nativeRowElements(root) {
      if (root == null) return [];
      const elements = root?.nodeType === 1 ? [root] : [];
      const visit = (node) => {
        for (const child of Array.from(node?.childNodes ?? [])) {
          if (child?.nodeType !== 1 || hasNativeRole(child, "treeitem")) continue;
          elements.push(child);
          visit(child);
        }
      };
      visit(root);
      return elements;
    }

    function hasNativeRole(node, role) {
      return node?.getAttribute?.("role") === role;
    }

    function hasLocalClass(node, localName) {
      const className = node?.getAttribute?.("class");
      if (typeof className !== "string") return false;
      // CSS Module 常见形态是 label_hash/label__hash；不把 not-label 拆分成 label。
      return className.split(/\s+/).some((token) => {
        if (token.startsWith("not-" + localName) || token.startsWith("not_" + localName)) return false;
        return token === localName
          || token.startsWith(localName + "_")
          || token.startsWith(localName + "-")
          || token.endsWith("_" + localName)
          || token.includes("_" + localName + "_");
      });
    }

    function findNativeTrees(root) {
      const trees = [];
      if (hasNativeRole(root, "tree")) trees.push(root);
      try {
        for (const tree of Array.from(root?.querySelectorAll?.('[role="tree"]') ?? [])) {
          if (!trees.includes(tree)) trees.push(tree);
        }
      } catch {}
      return trees;
    }

    function findTreeItems(tree) {
      const items = [];
      if (hasNativeRole(tree, "treeitem")) items.push(tree);
      try {
        for (const item of Array.from(tree?.querySelectorAll?.('[role="treeitem"]') ?? [])) {
          if (!items.includes(item)) items.push(item);
        }
      } catch {}
      return items;
    }

    function isSubagentTreeAriaLabel(value) {
      const label = metadataString(value);
      return label !== void 0 && /(subagent|child[ -]?agent|子代理)/i.test(label);
    }

    function nativeTreeHasCatalogTask(tree, taskNames) {
      return findTreeItems(tree).some((item) => {
        const parts = findNativeSubagentRowParts(item);
        return taskNames.has(metadataString(parts.label?.textContent));
      });
    }

    /**
     * aria-label 能明确表明子代理菜单时只接受唯一候选；否则用目录任务名匹配，
     * 多个候选树视为歧义并 fail closed，避免污染其他 tree。
     */
    function findNativeSubagentTrees(root, catalog) {
      const trees = findNativeTrees(root);
      if (!Array.isArray(catalog) || trees.length === 0) return [];
      const ariaTrees = trees.filter((tree) => isSubagentTreeAriaLabel(tree?.getAttribute?.("aria-label")));
      if (ariaTrees.length > 1) return [];
      if (ariaTrees.length === 1) return ariaTrees;
      const taskNames = new Set(catalog
        .map((record) => metadataString(record?.taskName))
        .filter((taskName) => taskName !== void 0));
      if (taskNames.size === 0) return [];
      const matchingTrees = trees.filter((tree) => nativeTreeHasCatalogTask(tree, taskNames));
      return matchingTrees.length === 1 ? matchingTrees : [];
    }

    function findNativeSubagentTreeItems(root, catalog) {
      const items = [];
      for (const tree of findNativeSubagentTrees(root, catalog)) {
        for (const item of findTreeItems(tree)) {
          if (!items.includes(item)) items.push(item);
        }
      }
      return items;
    }

    function nativeContains(parent, child) {
      if (parent === child) return true;
      if (typeof parent?.contains === "function") return parent.contains(child);
      let current = child?.parentNode;
      while (current != null) {
        if (current === parent) return true;
        current = current.parentNode;
      }
      return false;
    }

    /** class hash 不稳定，所以只按 token 局部名识别；没有局部名时退回 row 的稳定子节点顺序。 */
    function findNativeSubagentRowParts(item) {
      const elements = nativeRowElements(item).filter((element) => !isSubagentMetadataNode(element));
      const labelNodes = elements.filter((element) => hasLocalClass(element, "label"));
      const summaryNodes = elements.filter((element) => hasLocalClass(element, "summary"));
      let label = labelNodes.length === 1 ? labelNodes[0] : void 0;
      let summary = summaryNodes.length === 1 ? summaryNodes[0] : void 0;
      const contentNodes = elements.filter((element) => hasLocalClass(element, "content"));
      if (contentNodes.length > 1 || labelNodes.length > 1 || summaryNodes.length > 1) {
        return { label: void 0, summary: void 0 };
      }
      const content = contentNodes.length === 1 ? contentNodes[0] : void 0;
      const containers = [];
      // 无 content class 时仅把 row 自身的恰好两个子块视为结构 fallback。
      for (const container of content !== void 0 ? [content] : contentNodes.length === 0 ? [item] : []) {
        if (container != null && !containers.includes(container)) containers.push(container);
      }
      for (const container of containers) {
        const children = nativeElementChildren(container).filter((element) => !isSubagentMetadataNode(element));
        // 只有恰好两个稳定 row 子块时才使用结构 fallback，避免猜测任意节点。
        if (children.length !== 2) continue;
        if (label === void 0 && labelNodes.length === 0) label = children[0];
        if (summary === void 0 && summaryNodes.length === 0) summary = children.find((element) => element !== label);
        if (label !== void 0 && summary !== void 0) break;
      }
      if (label === summary) return { label: void 0, summary: void 0 };
      return { label, summary };
    }

    function isSubagentMetadataNode(node) {
      return typeof node?.getAttribute === "function" && node.getAttribute(SUBAGENT_METADATA_MARKER) !== null;
    }

    function findSubagentMetadataNodes(root) {
      return (root?.getAttribute?.("role") === "treeitem" ? nativeRowElements(root) : nativeElements(root))
        .filter(isSubagentMetadataNode);
    }

    function removeSubagentMetadataNode(node) {
      try {
        if (typeof node?.remove === "function") node.remove();
        else node?.parentNode?.removeChild?.(node);
      } catch {}
    }

    function removeSubagentMetadata(root) {
      const nodes = findSubagentMetadataNodes(root);
      for (const node of nodes) removeSubagentMetadataNode(node);
      return nodes.length;
    }

    function rpcMetadataFor(rpcMetadata, sessionId) {
      if (rpcMetadata instanceof Map) return rpcMetadata.get(sessionId);
      return rpcMetadata?.[sessionId];
    }

    function metadataForSubagentRecord(record, rpcMetadata) {
      const rpc = rpcMetadataFor(rpcMetadata, record?.sessionId);
      return normalizeSubagentMetadata({ ...(record?.metadata ?? {}), ...record, ...(rpc ?? {}) });
    }

    /**
     * 只处理已选定子代理 tree 中能按任务名匹配目录的 treeitem。
     * 唯一 label 可直接匹配；重复 label 必须有稳定 session id，否则保守跳过。
     */
    function nativeSubagentSessionIdOf(item) {
      for (const name of ["data-session-id", "data-subagent-id", "data-id"]) {
        const value = metadataString(item?.getAttribute?.(name));
        if (value !== void 0) return value;
      }
      return void 0;
    }

    function applySubagentMetadata(root, catalog, rpcMetadata) {
      const records = Array.isArray(catalog) ? catalog : [];
      const items = findNativeSubagentTreeItems(root, records);
      const recordsByTask = new Map();
      const recordsBySession = new Map();
      for (const record of records) {
        const taskName = metadataString(record?.taskName);
        if (taskName === void 0 || typeof record?.sessionId !== "string") continue;
        if (!recordsByTask.has(taskName)) recordsByTask.set(taskName, []);
        recordsByTask.get(taskName).push(record);
        if (recordsBySession.has(record.sessionId)) recordsBySession.set(record.sessionId, null);
        else recordsBySession.set(record.sessionId, record);
      }
      const rowLabelCounts = new Map();
      const rowParts = new Map();
      for (const item of items) {
        const parts = findNativeSubagentRowParts(item);
        rowParts.set(item, parts);
        const taskName = metadataString(parts.label?.textContent);
        if (taskName !== void 0) rowLabelCounts.set(taskName, (rowLabelCounts.get(taskName) ?? 0) + 1);
      }
      for (const item of items) {
        const parts = rowParts.get(item) ?? { label: void 0, summary: void 0 };
        const existing = findSubagentMetadataNodes(item);
        const taskName = metadataString(parts.label?.textContent);
        const candidates = taskName === void 0 ? [] : recordsByTask.get(taskName) ?? [];
        const rowSessionId = nativeSubagentSessionIdOf(item);
        let record;
        if (rowSessionId !== void 0) {
          const candidate = recordsBySession.get(rowSessionId);
          if (candidate !== null && candidate?.taskName === taskName) record = candidate;
        } else if (taskName !== void 0 && rowLabelCounts.get(taskName) === 1 && candidates.length === 1) {
          // 唯一任务名可直接匹配；重复 label 没有稳定 id 时必须保持不注入。
          record = candidates[0];
        }
        const text = parts.summary == null || record === void 0
          ? null
          : formatSubagentMetadata(metadataForSubagentRecord(record, rpcMetadata));
        if (text === null || parts.summary?.parentNode == null) {
          for (const node of existing) removeSubagentMetadataNode(node);
          continue;
        }
        const node = existing[0] ?? parts.summary.ownerDocument?.createElement?.("span") ?? parts.summary.parentNode?.ownerDocument?.createElement?.("span");
        if (node == null) continue;
        if (existing.length > 1) {
          for (const duplicate of existing.slice(1)) removeSubagentMetadataNode(duplicate);
        }
        if (!isSubagentMetadataNode(node)) {
          node.setAttribute?.(SUBAGENT_METADATA_MARKER, "");
          node.className = SUBAGENT_METADATA_CLASS;
        }
        if (node.textContent !== text) node.textContent = text;
        if (node.parentNode !== parts.summary.parentNode || node.nextSibling !== parts.summary) {
          parts.summary.parentNode.insertBefore(node, parts.summary);
        }
      }
      // 菜单重建后旧 marker 可能暂时落在 tree 外；它们也属于插件所有权，必须立即清掉。
      for (const node of findSubagentMetadataNodes(root)) {
        if (!items.some((item) => nativeContains(item, node))) removeSubagentMetadataNode(node);
      }
      return findSubagentMetadataNodes(root).length;
    }

    /**
     * 安装 DSH 宿主原生运行状态桥。插件只观察并替换宿主已经渲染的主文本节点，
     * 不创建自己的状态行，不写入 class/style/aria，也不触碰宿主的鲸鱼动画和计时器。
     *
     * 多 scope 语义：主视图与右侧 sidebar.chat 会同时渲染同构的 conversation scope，
     * 各自绑定自己的 session。因此桥不再只挑"一个当前会话"，而是为文档中每个身份可验证的
     * 原生状态目标建立一条独立 lane（按 sessionId 归并）：
     * - lane 归属来自 scope 自己的会话证据（scope 自身 + [data-conversation-content] 外层）；
     *   多个 scope 若都唯一证明属于同一会话则共享 lane 并一起更新，缺失或冲突证据仍 fail-closed；
     * - 每条 lane 用自己的 session 快照（running / 插件 marker）与自己的 RPC 身份
     *   （kind / role）决定文案，异步请求带 per-lane serial + AbortController：
     *   旧响应、被取消的响应和其他会话的响应都不能写进本 lane；
     * - 会话离开快照、停止运行或插件卸载时，只恢复该 lane 覆盖过的字段，
     *   其他 lane（例如仍在运行的主视图）保持自己的角色文案。
     */
    function installNativeStatusBridge(ctx) {
      const doc = typeof document !== "undefined" ? document : null;
      const root = doc?.body ?? doc?.documentElement;
      const sessionStore = ctx?.sessions?.list;
      if (root == null || typeof sessionStore?.getSnapshot !== "function" || typeof sessionStore?.subscribe !== "function") return () => {};

      let disposed = false;
      let sessionList = {};
      let observer = null;
      /** sessionId -> lane：每个会话拥有自己的重写器、身份缓存与在途请求。 */
      const lanes = new Map();

      /**
       * 建立一条会话 lane。lane 只改写自己会话的目标：row rewriter 决定"改哪几个字段"，
       * lane 决定"这个会话现在是什么身份、该显示什么文案"。
       */
      const createLane = (sessionId) => ({
        sessionId,
        rewriter: createNativeStatusRowRewriter({
          resolveTargets: () => resolveNativeStatusTargets(root, sessionId, true),
        }),
        identityKey: null,
        rpcState: { sessionId: void 0, kind: "pending", role: void 0 },
        requestSerial: 0,
        controller: null,
      });

      /** 快照里该会话的最新条目：异步响应回来时要看最新 running，而不是发起请求时的快照。 */
      const currentEntryOf = (sessionId) => sessionEntryOf(sessionList, sessionId);

      /**
       * 用本 lane 自己的快照与 RPC 身份决定文案。身份态只在 rpcState.sessionId 等于本 lane
       * 会话时生效，因此任何跨会话残留都退化成 pending（fail-closed），不会借用别人的角色。
       */
      const renderLane = (lane, entry) => {
        if (disposed) return;
        const statusText = resolveRunningStatusText({
          sessionId: lane.sessionId,
          currentSessionId: lane.sessionId,
          running: entry?.running,
          session: entry,
          kind: lane.rpcState.sessionId === lane.sessionId ? lane.rpcState.kind : "pending",
          role: lane.rpcState.sessionId === lane.sessionId ? lane.rpcState.role : void 0,
        });
        lane.rewriter.apply(statusText);
      };

      /**
       * 同步一条 lane 的身份并立即渲染一次。身份键必须同时包含**运行状态**：
       * - 空闲时挂载的 lane 没有发过身份查询，会话真正开始生成时必须走一次转换去查询，
       *   否则会一直停留在"没有身份"的 pending 分支，永远保留宿主原文；
       * - 运行 → 停止也必须走同一条转换路径：中止在途请求并按 serial 让迟到响应失效，
       *   随后同一会话重新运行时可以再次查询（不复用停止前的缓存或在途状态）。
       * 只有身份形状与运行状态都没变时才提前返回，避免重复请求（例如宿主重渲染）。
       */
      const refreshLane = (lane, entry) => {
        const markedRole = normalizeStatusRole(entry?.[STATUS_ROLE_MARKER] ?? entry?.metadata?.[STATUS_ROLE_MARKER]);
        const childSession = isPluginChildSession(entry);
        const nextKey = [lane.sessionId, childSession ? "child" : "root", markedRole ?? "", entry?.running === true ? "running" : "idle"].join("\u0000");
        if (nextKey === lane.identityKey) {
          renderLane(lane, entry);
          return;
        }
        lane.identityKey = nextKey;
        lane.requestSerial += 1;
        lane.controller?.abort();
        lane.controller = null;
        lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "pending", role: markedRole };
        renderLane(lane, entry);
        // 非运行态不需要身份确认：不为后台/已停止会话发无谓请求。
        if (entry?.running !== true) return;
        const requestToken = lane.requestSerial;
        lane.controller = typeof AbortController === "function" ? new AbortController() : null;
        (async () => {
          try {
            const response = await requestPluginRpc(ctx.connection, {
              action: "get", sessionId: lane.sessionId, childHint: childSession,
            }, lane.controller === null ? {} : { signal: lane.controller.signal });
            // stale / 跨会话守卫：serial、lane 归属或插件生命周期任一变化都不得写 DOM。
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane) return;
            if (!response?.ok) {
              lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "unknown", role: markedRole };
              renderLane(lane, currentEntryOf(lane.sessionId));
              return;
            }
            const json = await response.json();
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane) return;
            const identity = resolveStatusIdentity({ sessionId: lane.sessionId, responseSessionId: lane.sessionId, response: json });
            if (identity === null) return;
            const markerFallbackKind = markedRole !== void 0 && identity.kind === "unknown" ? "child" : identity.kind;
            lane.rpcState = { sessionId: lane.sessionId, kind: markerFallbackKind, role: identity.role ?? markedRole };
            renderLane(lane, currentEntryOf(lane.sessionId));
          } catch (error) {
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane || error?.name === "AbortError") return;
            lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "unknown", role: markedRole };
            renderLane(lane, currentEntryOf(lane.sessionId));
          }
        })();
      };

      /** 丢弃一条 lane：取消在途请求并恢复它覆盖过的字段（只恢复插件确实写过的值）。 */
      const dropLane = (lane) => {
        lane.requestSerial += 1;
        lane.controller?.abort();
        lane.controller = null;
        lane.rewriter.restore();
        lanes.delete(lane.sessionId);
      };

      const sync = () => {
        if (disposed) return;
        try {
          sessionList = sessionStore.getSnapshot() ?? {};
        } catch {
          sessionList = {};
        }
        // DOM 决定候选会话：每个有唯一会话证据的 scope/状态行对应自己的 lane，
        // 因此主视图与侧栏各自绑定自己的 session，不再依赖"当前主视图会话"。
        const candidates = collectNativeStatusSessionIds(root);
        const candidateIds = new Set(candidates);
        for (const sessionId of candidates) {
          const entry = currentEntryOf(sessionId);
          // 快照里没有这个会话（例如其他会话的历史 DOM）时不建立 lane，保持宿主原文。
          if (entry === void 0) continue;
          const lane = lanes.get(sessionId) ?? createLane(sessionId);
          lanes.set(sessionId, lane);
          refreshLane(lane, entry);
        }
        // 会话从快照移除，或其 DOM scope 整体卸载时，都释放 lane 与旧节点引用；
        // scope 重建后会建立新 lane 并重新确认身份，避免 detached DOM 被长期保留。
        for (const lane of [...lanes.values()]) {
          if (currentEntryOf(lane.sessionId) === void 0 || !candidateIds.has(lane.sessionId)) {
            dropLane(lane);
          }
        }
      };

      let unsubscribe = () => {};
      try {
        const cleanup = sessionStore.subscribe(sync);
        if (typeof cleanup === "function") unsubscribe = cleanup;
      } catch {
        // 会话服务拒绝订阅时仍保留一次初始渲染，并由原生文案安全降级。
      }
      sync();

      const Observer = doc?.defaultView?.MutationObserver
        ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
      if (typeof Observer === "function") {
        try {
          // DOM 变化同样走完整 sync：宿主可能先建行、后建 scope，只重渲染会漏掉刚出现的
          // lane；同一身份不会重复发 RPC（identityKey 未变时只做一次幂等渲染）。
          observer = new Observer(() => sync());
          observer.observe(root, { childList: true, subtree: true, characterData: true });
        } catch {
          observer = null;
        }
      }
      return () => {
        if (disposed) return;
        disposed = true;
        try { unsubscribe(); } catch {}
        try { observer?.disconnect(); } catch {}
        observer = null;
        // 卸载必须让每条 lane 都恢复宿主原文，并取消全部在途身份请求。
        for (const lane of [...lanes.values()]) dropLane(lane);
      };
    }

    /**
     * shell.overlay 中的独立元数据桥：仅为原生子代理菜单插入一行文本，始终返回 null。
     * 会话快照变化时重建目录；RPC 和 observer 各自拥有 cleanup，旧响应不能污染新 root。
     */
    function SubagentMetadataBridge({ ctx, useSessions }) {
      const sessionList = useSessionList(ctx, useSessions) ?? {};
      const sessionEntries = react.useMemo(() => readEntries(sessionList.byId), [sessionList]);
      const currentSessionId = currentSessionIdOf(sessionList);
      const projectionsBySession = sessionList.projectionsBySession;
      const currentRootSessionId = react.useMemo(
        () => resolveSubagentRootSessionId(sessionEntries, currentSessionId, projectionsBySession),
        [currentSessionId, sessionEntries, projectionsBySession],
      );
      const catalog = react.useMemo(
        () => collectSubagentCatalog({ byId: sessionEntries, projectionsBySession }, currentRootSessionId),
        [currentRootSessionId, sessionEntries, projectionsBySession],
      );
      const catalogRef = react.useRef(catalog);
      catalogRef.current = catalog;
      // 只把 root、身份、任务名和可用元数据纳入 key；activity 变化不应重启相同 RPC。
      const catalogKey = JSON.stringify({
        root: currentRootSessionId ?? null,
        records: catalog.map((record) => ({
          sessionId: record.sessionId,
          taskName: record.taskName,
          role: record.role,
          provider: record.provider,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
        })),
      });
      const [rpcState, setRpcState] = react.useState(() => ({ catalogKey: "", values: new Map() }));
      const rpcMetadata = rpcState.catalogKey === catalogKey ? rpcState.values : null;

      react.useEffect(() => {
        let cancelled = false;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        setRpcState({ catalogKey, values: new Map() });
        const unresolved = catalogRef.current.filter((record) => formatSubagentMetadata(record) === null);
        if (unresolved.length > 0) {
          void Promise.all(unresolved.map(async (record) => [
            record.sessionId,
            await requestSubagentMetadata(record.sessionId, globalThis?.fetch, controller?.signal, ctx.connection),
          ])).then((results) => {
            if (cancelled) return;
            const values = new Map();
            for (const [sessionId, metadata] of results) {
              if (typeof sessionId === "string" && metadata !== null) values.set(sessionId, metadata);
            }
            setRpcState((previous) => previous.catalogKey === catalogKey
              ? { catalogKey, values }
              : previous);
          }).catch(() => {});
        }
        return () => {
          cancelled = true;
          controller?.abort();
        };
      }, [catalogKey]);

      react.useEffect(() => {
        const doc = typeof document !== "undefined" ? document : null;
        const root = doc?.body ?? doc?.documentElement;
        let disposed = false;
        if (root == null) return () => {};
        const render = () => {
          if (!disposed) applySubagentMetadata(root, catalogRef.current, rpcMetadata);
        };
        render();
        const Observer = doc?.defaultView?.MutationObserver
          ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
        if (typeof Observer !== "function") return () => {
          disposed = true;
          removeSubagentMetadata(root);
        };
        const observer = new Observer(() => {
          // applySubagentMetadata 只在文案或位置变化时写 DOM，observer 不会因自身更新循环触发。
          render();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        return () => {
          disposed = true;
          observer.disconnect();
          removeSubagentMetadata(root);
        };
      }, [catalogKey, rpcMetadata]);
      return null;
    }

    /**
     * 设置页使用当前 Host 目录；每行 provider 独立决定模型和思考深度。
     * 角色清单与标签复用上面的同一份浏览器投影，不再维护第二份重复清单；
     * 实际展示的角色仍以 RPC meta 的 activeRoles 为准（Observer 关闭时隐藏）。
     */
    const SETTINGS_ROLE_IDS = STATUS_ROLE_IDS;
    const SETTINGS_ROLE_LABELS = STATUS_ROLE_LABELS;
    // meta 尚未返回时的初始行：只含默认角色，可选角色（observer）由 meta 决定是否展示。
    const SETTINGS_REQUIRED_ROLE_IDS = SETTINGS_ROLE_IDS.filter((role) => role !== "observer");


    // 提示词入口始终使用完整角色表，与模型配置的 activeRoles 读取路径刻意分离；
    // 因此 Observer 未启用时仍可配置提示词，但不会参与统一 provider 选择。
    const PROMPT_ROLE_IDS = SETTINGS_ROLE_IDS;
    const DEFAULT_PROMPT_MAX_GRAPHEMES = 32000;
    const PROMPT_WARNING_RATIO = 0.9;

    /**
     * grapheme 分段器按「locale + granularity」缓存。
     *
     * 计数位于提示词编辑器的实时校验路径上（每次按键都会重新校验草稿），而 Intl.Segmenter
     * 的构造成本远高于一次遍历，因此在工厂作用域里复用实例。缓存键包含构造参数：切分语义
     * 由 locale 与 granularity 共同决定，不同参数不能共用一个实例，所以是「按参数缓存」
     * 而不是全局唯一单例。
     * 构造失败（嵌入式 WebView 的残缺 Intl、polyfill 装到一半）不做负缓存：保持与旧实现
     * 一致的「每次调用重试构造」，失败时由调用方回退到代理项级计数。
     */
    const GRAPHEME_SEGMENTER_CACHE = new Map();
    function graphemeSegmenterOf(locale, granularity) {
      const key = (locale === undefined ? "" : String(locale)) + "\u0000" + String(granularity);
      const cached = GRAPHEME_SEGMENTER_CACHE.get(key);
      if (cached !== undefined) return cached;
      try {
        const Segmenter = globalThis?.Intl?.Segmenter;
        if (typeof Segmenter !== "function") return null;
        const segmenter = new Segmenter(locale, { granularity });
        GRAPHEME_SEGMENTER_CACHE.set(key, segmenter);
        return segmenter;
      } catch {
        return null;
      }
    }

    /**
     * 按 Unicode grapheme 统计文本长度。Intl.Segmenter 是浏览器与 Node 的标准实现，
     * 退回 Array.from 只用于极旧运行时，至少仍能把代理项当作一个字符而不截断原文。
     */
    function countUnicodeGraphemes(value) {
      if (typeof value !== "string" || value.length === 0) return 0;
      const segmenter = graphemeSegmenterOf(undefined, "grapheme");
      if (segmenter !== null) {
        try {
          let count = 0;
          for (const unused of segmenter.segment(value)) {
            void unused;
            count += 1;
          }
          return count;
        } catch {
          // 某些嵌入式 WebView 暴露了不完整的 Intl：segment() 本身也可能抛错，
          // 回退计数不能阻断编辑器（异常处理范围与旧实现完全一致）。
        }
      }
      return Array.from(value).length;
    }

    /**
     * 校验提示词草稿但不修改原文：空白只影响非空判断，首尾空格和换行仍按原样保存。
     */
    function validatePromptText(value, maxGraphemes = DEFAULT_PROMPT_MAX_GRAPHEMES) {
      const text = typeof value === "string" ? value : "";
      const max = Number.isSafeInteger(maxGraphemes) && maxGraphemes > 0
        ? maxGraphemes
        : DEFAULT_PROMPT_MAX_GRAPHEMES;
      const count = countUnicodeGraphemes(text);
      if (text.trim().length === 0) {
        return { ok: false, code: "prompt-empty", message: "提示词不能为空", count, maxGraphemes: max };
      }
      if (count > max) {
        return { ok: false, code: "prompt-too-long", message: "提示词不能超过 " + max + " 个字符", count, maxGraphemes: max };
      }
      return { ok: true, code: null, message: null, count, maxGraphemes: max };
    }

    /**
     * 只从 settings 快照保留已知角色的字符串覆盖，避免脏 wire 数据进入编辑器。
     *
     * 角色集合可由调用方显式传入（Host rolePrompts.roles，只应是内置角色）；
     * 缺省仍是内置六角色，纯函数调用与旧 Host 语义不变。
     */
    function normalizePromptOverrides(value, maxGraphemes = DEFAULT_PROMPT_MAX_GRAPHEMES, roleIds = PROMPT_ROLE_IDS) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
      const normalized = {};
      const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : PROMPT_ROLE_IDS;
      for (const role of roles) {
        const text = value[role];
        if (typeof text !== "string") continue;
        if (!validatePromptText(text, maxGraphemes).ok) continue;
        normalized[role] = text;
      }
      return normalized;
    }

    function promptOverridesEqual(left, right) {
      const leftValue = left && typeof left === "object" ? left : {};
      const rightValue = right && typeof right === "object" ? right : {};
      const roles = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort();
      return roles.every((role) => leftValue[role] === rightValue[role]);
    }

    /**
     * 将 Host rolePrompts 投影归一为固定六角色顺序。投影未完整到达时返回 null，
     * 编辑页据此显示加载而不是先用空文本冒充一个可保存的提示词。
     */
    function normalizeRolePromptProjection(projection, settingsValue, snapshotOverridesAuthoritative = false, roleIds = PROMPT_ROLE_IDS) {
      if (projection === null || typeof projection !== "object" || Array.isArray(projection)
        || !Array.isArray(projection.entries)) return null;
      // 角色集合以 Host 投影自己声明的 roles 为准（只应是内置角色）；缺省仍是
      // 内置六角色，因此旧 Host 与纯函数调用的行为完全不变。
      const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : PROMPT_ROLE_IDS;
      const fallbackOverrides = normalizePromptOverrides(settingsValue?.promptOverrides, projection.maxGraphemes, roles);
      const settingsHasOverrides = settingsValue !== null && typeof settingsValue === "object"
        && Object.prototype.hasOwnProperty.call(settingsValue, "promptOverrides");
      // 纯函数两参数调用保留旧 Host 投影语义；只有设置组件在接收到完整 snapshot
      // 后显式启用该开关，才让空映射表达“覆盖已被删除”，以抵抗滞后的 meta 响应。
      const byRole = new Map(projection.entries
        .filter((entry) => entry && typeof entry.role === "string")
        .map((entry) => [entry.role, entry]));
      const entries = [];
      for (const role of roles) {
        const source = byRole.get(role);
        if (typeof source?.defaultPersona !== "string") return null;
        // settings snapshot 到达后比一次 meta 更权威：meta 可能仍是组件首次读取的旧投影，
        // 不能把已删除的覆盖重新渲染回来。旧 Host 没有该字段时才回退 meta 自身状态。
        const snapshotControlsOverride = snapshotOverridesAuthoritative && settingsHasOverrides;
        const settingsHasRoleOverride = snapshotControlsOverride && Object.prototype.hasOwnProperty.call(fallbackOverrides, role);
        const override = snapshotControlsOverride
          ? fallbackOverrides[role]
          : (typeof source.override === "string" ? source.override : fallbackOverrides[role]);
        const customized = snapshotControlsOverride
          ? settingsHasRoleOverride
          : source.customized === true;
        entries.push({
          role,
          defaultPersona: source.defaultPersona,
          ...(customized && typeof override === "string" ? { override } : {}),
          customized,
          effective: customized && typeof override === "string" ? override : source.defaultPersona,
        });
      }
      const maxGraphemes = Number.isSafeInteger(projection.maxGraphemes) && projection.maxGraphemes > 0
        ? projection.maxGraphemes
        : DEFAULT_PROMPT_MAX_GRAPHEMES;
      return {
        roles,
        maxGraphemes,
        customizable: projection.customizable === true,
        entries,
      };
    }

    function promptEntryOf(projection, role) {
      return projection?.entries?.find((entry) => entry.role === role) ?? null;
    }

    /** 保存成功后只更新本地只读投影，已自定义圆点不会跟随临时草稿变化。 */
    function updateRolePromptProjection(projection, role, text) {
      if (projection === null || typeof projection !== "object") return projection;
      return {
        ...projection,
        entries: projection.entries.map((entry) => {
          if (entry.role !== role) return entry;
          const customized = text !== entry.defaultPersona;
          const next = { ...entry, customized, effective: text };
          if (customized) next.override = text;
          else delete next.override;
          return next;
        }),
      };
    }

    /**
     * 统一供应商只观察设置页实际展示的角色；Observer 未启用时，其旧配置不能污染选择器。
     * 未传角色列表时沿用旧版五个必选专家，供纯函数调用和旧 Host 兼容。
     *
     * 角色集合不在这里二次过滤——meta.activeRoles 是运行期目录的唯一读取面，
     * Host 已只投影内置角色。
     */
    function settingsRolesForProvider(roles) {
      const candidates = Array.isArray(roles) ? roles : SETTINGS_REQUIRED_ROLE_IDS;
      return [...new Set(candidates.filter((role) => typeof role === "string" && role.length > 0))];
    }

    /**
     * 返回当前展示角色的共同 provider。空字符串同时表示没有可统一的 provider 和混合状态；
     * 只有完全没有行内 provider 时才回退到旧的全局 provider，保持历史 settings 可见且可迁移。
     */
    function unifiedProviderOf(defaults, roles, legacyProvider = "") {
      const activeRoles = settingsRolesForProvider(roles);
      if (activeRoles.length === 0) return "";
      const providers = activeRoles.map((role) => {
        const provider = defaults?.[role]?.provider;
        return typeof provider === "string" && provider.length > 0 ? provider : "";
      });
      const configured = providers.filter((provider) => provider.length > 0);
      if (configured.length === 0) return typeof legacyProvider === "string" ? legacyProvider : "";
      if (configured.length !== activeRoles.length) return "";
      const first = configured[0];
      return configured.every((provider) => provider === first) ? first : "";
    }

    /**
     * 通知事件类型（票据 14）：设置页与 Host 使用同一组稳定 id。
     * 标签只用于展示，不属于持久化字段。
     */
    const NOTIFICATION_EVENT_TYPES = Object.freeze(["completed", "waiting", "failed"]);
    // 事件标签已迁到消息表（settings.notificationEvent.*，见渲染层 t(...)）。

    /**
     * 通知事件开关归一：缺失/非法一律按开启，只有显式 false 才关闭。
     *
     * 与 Host 读取面同一语义：旧配置没有该字段时保持历史行为（全部投递），
     * 读到一个坏值也不会静默关掉通知；写入面的严格校验在 Host 提交端点。
     */
    function normalizeNotificationEvents(value) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const type of NOTIFICATION_EVENT_TYPES) normalized[type] = source[type] !== false;
      return normalized;
    }

    function clampNotificationVolume(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 100;
    }

    /** 旧默认并发上限、新默认值与迁移标记版本：与 Host（index.js）保持同一语义。 */
    const DEFAULT_ROLE_CONCURRENCY_LIMIT = 20;
    const LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT = 10;
    const CONFIG_MIGRATION_VERSION = 1;

    /**
     * 共享每个 role 的 running shard 上限：只接受 1~64 的整数，旧配置或非法值回退到默认 20。
     * 与 Host 的 DEFAULT_ROLE_CONCURRENCY_LIMIT、设置页 title 文案保持同一数值。
     */
    function normalizeRoleConcurrencyLimit(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= 64
        ? value
        : DEFAULT_ROLE_CONCURRENCY_LIMIT;
    }

    /**
     * 读取面别名（与 Host 的 normalizeRoleConcurrencyLimitForRead 同一规则）。
     *
     * 默认值从 10 调整为 20 后，旧 profile 里显式保存的 10 在迁移标记落盘前按 20
     * 展示；首次保存由 Host 写入标记，之后用户手动改回 10 时原样保留。
     * 只影响读取展示，不改变用户输入的其它合法值。
     *
     * @param {object|undefined} source - settings 快照。
     * @returns {number} 1~64 的生效并发上限。
     */
    function effectiveRoleConcurrencyLimit(source) {
      const limit = normalizeRoleConcurrencyLimit(source?.roleConcurrencyLimit);
      const rawVersion = source?.configMigrationVersion;
      const version = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
      return version < CONFIG_MIGRATION_VERSION && limit === LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT
        ? DEFAULT_ROLE_CONCURRENCY_LIMIT
        : limit;
    }

    // 与 Host 的默认值保持一致：10 小时；显式 0 仍表示禁用，不被默认值覆盖。
    const DEFAULT_ROLE_TIMEOUT_MS = 36000000;

    /**
     * 角色默认超时（毫秒，票据 06）只接受 0（不启用）或
     * 1000~86,400,000 的整秒毫秒数；缺失或非法值回退默认 10 小时。
     *
     * 客户端只做读取/草稿归一，权威拒绝仍在 Host 的 settings-commit
     * （与 fanout.js validateTimeoutMs 同一语义）：这里不能把越界值渲染成“已保存”。
     *
     * @param {unknown} value - settings 中的超时值。
     * @returns {number} 0 或合法启用值。
     */
    function normalizeRoleTimeoutMs(value) {
      if (value === 0) return 0;
      return Number.isSafeInteger(value) && value >= 1000 && value <= 86400000 && value % 1000 === 0
        ? value
        : DEFAULT_ROLE_TIMEOUT_MS;
    }

    // ── 票据 24：候选模型与降级上限的归一、校验（设置页草稿与提交共用）──────────
    //
    // 候选上限 3 与「主模型 + 3 个候选页」的页签上限一一对应，降级上限 4（默认 2）。
    // 这些常量只用于客户端预校验与 UI 限制，权威拒绝仍在 Host 的 settings-commit。
    const MAX_MODEL_CANDIDATES_PER_ROLE = 3;
    const MAX_MODEL_FALLBACK_LIMIT = 4;
    const DEFAULT_MODEL_FALLBACK_LIMIT = 2;
    /** 页签页数上限：主模型页 + 最多 3 个候选页 = 4 页。 */
    const MAX_MODEL_PAGES = MAX_MODEL_CANDIDATES_PER_ROLE + 1;

    /** 降级上限只接受 0..4 的安全整数；缺失/非法按默认 2 归一（与 Host 读取面一致）。 */
    function normalizeModelFallbackLimitDraft(value) {
      return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MODEL_FALLBACK_LIMIT ? value : DEFAULT_MODEL_FALLBACK_LIMIT;
    }
    /**
     * 单条候选归一：只保留 provider/model 字符串与可选非空 effort。
     *
     * 与 defaults 的读取归一不同，这里**不丢弃空串**：页签里的候选层在用户填写前
     * 就是 {provider:"", model:""}，读取归一若丢掉它，草稿与源看起来相同（页数会塌陷，
     * 保存按钮也会错误地保持禁用）。空行 = 未配置，提交前由 compactModelCandidatesDraft 裁掉。
     */
    function normalizeModelCandidateSelection(entry) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (typeof entry.provider !== "string" || typeof entry.model !== "string") return null;
      const reasoningEffort = typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "";
      return { provider: entry.provider, model: entry.model, ...(reasoningEffort.length > 0 ? { reasoningEffort } : {}) };
    }
    /**
     * 角色 -> 有序候选映射归一；只保留内置角色键，每角色最多 3 条（与页签上限一致）。
     *
     * 旧文档里可能残留已删除的自定义角色键；Host 的 settings-commit 对未知角色键严格
     * 拒绝（整次 400），因此读取面就先丢弃，保证升级后保存旧候选不会把设置写坏。
     */
    function normalizeModelCandidatesDraft(value) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const candidates = {};
      for (const [role, list] of Object.entries(source)) {
        if (typeof role !== "string" || role.length === 0 || !Array.isArray(list)) continue;
        // 未知角色键（旧自定义角色）在读取面丢弃：Host 写面只接受内置角色。
        if (!SETTINGS_ROLE_IDS.includes(role)) continue;
        const normalized = [];
        for (const entry of list.slice(0, MAX_MODEL_CANDIDATES_PER_ROLE)) {
          const selection = normalizeModelCandidateSelection(entry);
          if (selection !== null) normalized.push(selection);
        }
        if (normalized.length > 0) candidates[role] = normalized;
      }
      return candidates;
    }
    /** 候选去重键：provider + model + 规范化 effort（空 effort 与缺省等价）。 */
    function modelCandidateKeyOf(selection) {
      return (selection?.provider ?? "") + "\u0000" + (selection?.model ?? "") + "\u0000" + (typeof selection?.reasoningEffort === "string" ? selection.reasoningEffort : "");
    }
    /**
     * 模型页签的「页 → 层」映射（票据 24 重排的唯一数据语义）。
     *
     * - 页 0 = defaults[role]；页 i（i >= 1）= candidates[role][i - 1]；
     * - 页数完全由草稿推导（不落盘、不额外存 UI 状态），删除/裁剪候选后页签自动收敛；
     * - 页签名称只由位置推导，拖动重排改变的是「整层」的顺序，不是某一行的数据。
     */
    function modelPageCountOf(draft) {
      let longest = 0;
      for (const role of SETTINGS_ROLE_IDS) {
        const list = draft?.candidates?.[role];
        if (Array.isArray(list)) longest = Math.max(longest, list.length);
      }
      return Math.min(MAX_MODEL_PAGES, Math.max(1, 1 + longest));
    }
    /**
     * 参与层重排的角色集合：内置六角色 + 草稿里已经存在的其它键。
     *
     * 内置角色必须在列，否则「拖动重排」会漏掉当前没有任何配置的角色，导致层的边界错位；
     * 历史文档里的未知角色键一并保留，重排不得顺手丢掉用户已有的数据。
     */
    function modelLayerRolesOf(draft) {
      const roles = [...SETTINGS_ROLE_IDS];
      for (const source of [draft?.defaults, draft?.candidates]) {
        if (source === null || source === void 0 || typeof source !== "object") continue;
        for (const role of Object.keys(source)) if (!roles.includes(role)) roles.push(role);
      }
      return roles;
    }
    /** 读某一层某角色的选择：页 0 读 defaults，页 i 读 candidates[i - 1]；未配置返回 null。 */
    function modelLayerSelectionOf(draft, role, page) {
      if (!Number.isSafeInteger(page) || page < 0) return null;
      const source = page === 0
        ? draft?.defaults?.[role]
        : (Array.isArray(draft?.candidates?.[role]) ? draft.candidates[role][page - 1] : void 0);
      return source !== null && source !== void 0 && typeof source === "object" && !Array.isArray(source) ? source : null;
    }
    /**
     * 写某一层某角色的选择：页 0 写 defaults（空值 = 删掉该行），页 i 写 candidates[i - 1]。
     *
     * 候选层必须把数组补到目标索引（中间层用空行占位），否则读写会落在不同的页上；
     * 空行只是**草稿**占位，提交前由 compactModelCandidatesDraft 按「未配置不写入」裁掉，
     * 因此 Host 永远不会收到空 selection（Host 的写面会整次拒绝空条目）。
     */
    function setModelLayerSelection(draft, role, page, selection) {
      if (!Number.isSafeInteger(page) || page < 0) return draft;
      const normalized = selection !== null && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
      if (page === 0) {
        const defaults = { ...(draft?.defaults ?? {}) };
        if (normalized === null) delete defaults[role];
        else defaults[role] = normalized;
        return { ...draft, defaults };
      }
      const candidates = { ...(draft?.candidates ?? {}) };
      const list = Array.isArray(candidates[role]) ? candidates[role].slice() : [];
      while (list.length < page - 1) list.push({ provider: "", model: "" });
      list[page - 1] = normalized === null ? { provider: "", model: "" } : normalized;
      candidates[role] = list;
      return { ...draft, candidates };
    }
    /** 当前层的「角色 → 选择」映射：统一供应商与整层重排都基于它计算。 */
    function modelLayerMapOf(draft, page) {
      const map = {};
      for (const role of modelLayerRolesOf(draft)) {
        const selection = modelLayerSelectionOf(draft, role, page);
        if (selection !== null) map[role] = selection;
      }
      return map;
    }
    /**
     * 按「层数组」整体写回草稿（拖动排序的唯一写入口）。
     *
     * 第 0 层写 defaults；候选层保持页与索引一一对应：最后一个有内容的层决定数组长度，
     * 中间缺口用空行占位（提交前再裁剪）。写入的都是深拷贝，避免新旧层共享同一个对象。
     */
    function writeModelLayers(draft, layers) {
      const defaults = {};
      const candidates = {};
      for (const role of modelLayerRolesOf(draft)) {
        const primary = layers[0]?.[role] ?? null;
        if (primary !== null && primary !== void 0) defaults[role] = { ...primary };
        let last = 0;
        for (let page = 1; page < layers.length; page += 1) {
          const selection = layers[page]?.[role];
          if (selection !== null && selection !== void 0) last = page;
        }
        if (last >= 1) {
          const list = [];
          for (let page = 1; page <= last; page += 1) {
            const selection = layers[page]?.[role] ?? null;
            list.push(selection === null ? { provider: "", model: "" } : { ...selection });
          }
          candidates[role] = list;
        }
      }
      return { ...draft, defaults, candidates };
    }
    /** 拖动页签：把 from 层整层移动到 to 位置，其余层顺移（主模型页也可以移动）。 */
    function reorderModelLayers(draft, from, to) {
      const count = modelPageCountOf(draft);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return draft;
      if (from < 0 || from >= count || to < 0 || to >= count || from === to) return draft;
      const layers = [];
      for (let page = 0; page < count; page += 1) layers.push(modelLayerMapOf(draft, page));
      const [moved] = layers.splice(from, 1);
      layers.splice(to, 0, moved);
      return writeModelLayers(draft, layers);
    }
    /**
     * 「+」新建候选页：深拷贝主模型页六个角色的选择（provider/model/reasoningEffort）。
     *
     * 达到 MAX_MODEL_PAGES 后不再新增（按钮同时禁用）；拷贝是深拷贝，新页与主模型页
     * 互不影响。主模型页空着的角色写空行占位，保证新页在草稿里立刻出现（保存时按未配置裁掉）。
     */
    function addModelCandidatePage(draft) {
      const count = modelPageCountOf(draft);
      if (count >= MAX_MODEL_PAGES) return draft;
      const candidates = { ...(draft?.candidates ?? {}) };
      for (const role of modelLayerRolesOf(draft)) {
        const primary = modelLayerSelectionOf(draft, role, 0);
        const list = Array.isArray(candidates[role]) ? candidates[role].slice() : [];
        while (list.length < count - 1) list.push({ provider: "", model: "" });
        list[count - 1] = primary === null ? { provider: "", model: "" } : { ...primary };
        candidates[role] = list;
      }
      return { ...draft, candidates };
    }
    /**
     * 删除一个候选页：所有角色同步删掉该索引项（页与层始终一一对应）。
     *
     * 主模型页不可删除（页签上没有 ×），由调用方保证 page >= 1；某角色在该层没有配置时跳过。
     */
    function removeModelCandidatePage(draft, page) {
      if (!Number.isSafeInteger(page) || page < 1) return draft;
      const candidates = { ...(draft?.candidates ?? {}) };
      for (const [role, value] of Object.entries(candidates)) {
        if (!Array.isArray(value)) continue;
        const list = value.slice();
        if (list.length >= page) list.splice(page - 1, 1);
        if (list.length > 0) candidates[role] = list;
        else delete candidates[role];
      }
      return { ...draft, candidates };
    }
    /**
     * 提交前裁剪候选：provider 与 model 皆空的行 = 该层该角色未配置，整行不写入。
     *
     * 为什么必须裁掉而不是留给 Host：Host 的 settings-commit 会对变更角色的每一条候选做
     * 目录解析，空 selection 会被整次拒绝（400）；「空行允许保存」因此只能在客户端表达成
     * 「不写这一条」。行序保持稳定，剩下的都是真正的配置。
     */
    function compactModelCandidatesDraft(candidates) {
      const source = candidates !== null && typeof candidates === "object" && !Array.isArray(candidates) ? candidates : {};
      const compacted = {};
      for (const [role, list] of Object.entries(source)) {
        if (!Array.isArray(list)) continue;
        const rows = [];
        for (const entry of list) {
          const selection = normalizeModelCandidateSelection(entry);
          if (selection === null) continue;
          // 全空行 = 未配置：该层该角色不写入。
          if (selection.provider.length === 0 && selection.model.length === 0) continue;
          rows.push(selection);
        }
        if (rows.length > 0) compacted[role] = rows;
      }
      return compacted;
    }
    /**
     * 候选草稿的保存前校验（fail-closed，绝不静默丢弃用户输入）。
     *
     * - 全空行 = 未配置：允许保存（提交前会被裁掉，该层该角色不写入）；
     * - 半填行（只有 provider 或只有 model）仍然报错：写进 Host 只会换来一次整保存失败，
     *   这里提前给出可读原因；
     * - 同一角色内已配置的候选不得重复；角色级最多 MAX_MODEL_CANDIDATES_PER_ROLE 条。
     */
    function validateModelCandidateRows(candidates) {
      const source = candidates !== null && typeof candidates === "object" ? candidates : {};
      for (const [role, list] of Object.entries(source)) {
        if (!Array.isArray(list)) continue;
        if (list.length > MAX_MODEL_CANDIDATES_PER_ROLE) return { ok: false, code: "limit", role, index: 0 };
        const seen = new Set();
        for (let index = 0; index < list.length; index += 1) {
          const selection = normalizeModelCandidateSelection(list[index]);
          if (selection === null) return { ok: false, code: "incomplete", role, index: index + 1 };
          if (selection.provider.length === 0 && selection.model.length === 0) continue;
          if (selection.provider.length === 0 || selection.model.length === 0) return { ok: false, code: "incomplete", role, index: index + 1 };
          const key = modelCandidateKeyOf(selection);
          if (seen.has(key)) return { ok: false, code: "duplicate", role, index: index + 1 };
          seen.add(key);
        }
      }
      return { ok: true, code: null, role: null, index: 0 };
    }
    /** 候选校验结果 -> 可读中文原因（角色显示名优先，索引从 1 开始）。 */
    function modelCandidatesErrorMessage(t, roleLabelOf, validation) {
      if (validation.code === "limit") return t("settings.modelCandidates.limit");
      return (typeof roleLabelOf === "function" ? roleLabelOf(validation.role) : validation.role) + "：" + t("settings.modelCandidates.error." + (validation.code ?? "incomplete"), { index: validation.index });
    }

    function normalizeSettingsDraft(value, roles, allowLegacyProviderFallback = true) {
      const source = value && typeof value === "object" ? value : {};
      const configuredProvider = typeof source.provider === "string" ? source.provider : "";
      const activeRoles = settingsRolesForProvider(roles);
      const entries = [];
      for (const [role, selection] of Object.entries(source.defaults ?? {})) {
        if (!selection || typeof selection !== "object"
          || typeof selection.model !== "string" || selection.model.length === 0) continue;
        const provider = typeof selection.provider === "string" && selection.provider.length > 0
          ? selection.provider
          : "";
        entries.push({ role, selection, provider });
      }
      const hasVisibleRowProvider = entries.some(({ role, provider }) => activeRoles.includes(role) && provider.length > 0);
      const defaults = {};
      for (const { role, selection, provider: explicitProvider } of entries) {
        const provider = explicitProvider.length > 0
          ? explicitProvider
          : (allowLegacyProviderFallback && !hasVisibleRowProvider && activeRoles.includes(role)
            ? configuredProvider
            : "");
        if (provider.length === 0) continue;
        defaults[role] = { provider, model: selection.model };
        if (typeof selection.reasoningEffort === "string") defaults[role].reasoningEffort = selection.reasoningEffort;
      }
      const visibleProviders = activeRoles
        .map((role) => defaults[role]?.provider)
        .filter((provider) => typeof provider === "string" && provider.length > 0);
      const inferredProvider = visibleProviders.length > 0
        && visibleProviders.length === activeRoles.length
        && visibleProviders.every((provider) => provider === visibleProviders[0])
        ? visibleProviders[0]
        : "";
      return {
        // 行级 provider 一旦存在就拥有优先权；只有可见行完全没有 provider 时才保留旧顶层值。
        provider: hasVisibleRowProvider
          ? inferredProvider
          : (allowLegacyProviderFallback ? configuredProvider : ""),
        defaults,
        notificationEnabled: source.notificationEnabled !== false,
        notificationVolume: clampNotificationVolume(source.notificationVolume),
        notificationEvents: normalizeNotificationEvents(source.notificationEvents),
        // 读取别名：旧默认值 10 + 标记缺失 => 显示/保存为 20；标记落盘后 10 原样保留。
        roleConcurrencyLimit: effectiveRoleConcurrencyLimit(source),
        // 角色默认超时缺失或非法时使用默认 10 小时；显式 0 保留为不启用。
        roleTimeoutMs: normalizeRoleTimeoutMs(source.roleTimeoutMs),
        // 旧客户端/Host 缺少字段时保持关闭，避免升级后改变图片路由。
        observerPreferred: source.observerPreferred === true,
        // 任务管理缺字段时保持开启：默认必须维持 Expert Group 注册到侧边栏的历史行为。
        taskManagementEnabled: source.taskManagementEnabled !== false,
        // 自动打开缺字段/非法值时一律按关闭归一：默认不做任何自动 open/close。
        autoOpenSubagentSidebar: source.autoOpenSubagentSidebar === true,
        // 票据 24：候选与降级上限**只在源文档显式存在时**进入草稿/提交形状。
        // 缺字段 = 旧客户端/旧文档：不凭空写回默认值，Host 因此可以保持已有配置。
        ...(Object.prototype.hasOwnProperty.call(source, "candidates")
          ? { candidates: normalizeModelCandidatesDraft(source.candidates) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(source, "fallbackLimit")
          ? { fallbackLimit: normalizeModelFallbackLimitDraft(source.fallbackLimit) }
          : {}),
      };
    }

    function settingsDraftEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    /**
     * 详情页保存时参与"本地差异"合并的顶层字段（票据 24 重排 / 审查修复）。
     *
     * 与 normalizeSettingsDraft 的输出保持一一对应（promptOverrides 不在此列：提示词有
     * 独立的覆盖/恢复默认合并逻辑，不能按整份映射覆盖）。新增字段时必须同步这里，
     * 否则该字段的本地修改会在详情页保存时被当作"未修改"而丢失。
     */
    const SETTINGS_DRAFT_MERGE_FIELDS = Object.freeze([
      "provider",
      "defaults",
      "notificationEnabled",
      "notificationVolume",
      "notificationEvents",
      "roleConcurrencyLimit",
      "roleTimeoutMs",
      "observerPreferred",
      "taskManagementEnabled",
      "autoOpenSubagentSidebar",
      "candidates",
      "fallbackLimit",
    ]);

    /**
     * 详情页保存的合成草稿：**最新 source + 本地相对编辑基线的差异**。
     *
     * source 是 Host 当前权威配置，local 是当前草稿的归一结果，baseline 是进入编辑器
     * （或上次成功保存）时的归一快照。只有 local 与 baseline 不同的字段才覆盖到 source：
     * - 外部提交推进 revision 后，未修改的字段一律沿用 source，绝不重放旧值；
     * - 本地真实修改（提示词以外的候选、降级上限、通知、模型等）全部保留；
     * - 本地"整段删除"（local 缺字段而 baseline 有）同样表达为删除；
     * - 只改提示词时合成结果与 source 相同，冲突重试仍以最新完整配置为基底。
     */
    function mergeSettingsDraftOverSource(source, local, baseline) {
      const merged = { ...source };
      for (const field of SETTINGS_DRAFT_MERGE_FIELDS) {
        const hasLocal = Object.prototype.hasOwnProperty.call(local, field);
        const hasBaseline = Object.prototype.hasOwnProperty.call(baseline, field);
        if (hasLocal !== hasBaseline) {
          // 字段是本次新出现的（例如旧文档没有 candidates）或被整段删除。
          if (hasLocal) merged[field] = local[field];
          else delete merged[field];
          continue;
        }
        if (!hasLocal) continue;
        if (settingsDraftEqual(local[field], baseline[field])) continue;
        merged[field] = local[field];
      }
      return merged;
    }

    function createSettingsModelCatalog(ctx) {
      let state = { groups: [], status: "idle", error: null };
      // 目录刷新协调：同一时刻最多一个在途请求（单飞），在途期间到达的刷新事件只记账
      // 一个尾随刷新（queued），由在途请求收尾时启动。这样一串宿主事件（新增 provider 后
      // 立即删除会同时触发目录、文档与凭据事件）只会合并成"一个在途 + 一个最新"两次请求，
      // 而不是每个事件各发一次、互相把对方判成过期。
      let inflight = null;
      let queued = false;
      // 销毁标记：cleanup 第一步就置位，之后任何入口都不得再发起远端目录调用。
      // 只依赖 freshness.dispose() 不够：在途请求的收尾路径（.finally）按 promise 身份
      // 判断"收尾责任"，销毁时若仍持有 inflight / queued 账本，它会把排队中的尾随刷新
      // 真的发出去——插件已经销毁，却仍触发一次远端目录 RPC。
      let disposed = false;
      const freshness = createClientFreshnessBoundary();
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of listeners) listener();
      };
      /**
       * 启动一次目录请求。只有"当前没有在途请求"时才会被调用（load / refresh / 尾随刷新），
       * 因此这里不需要再做并发判断。
       */
      const startRequest = () => {
        // 销毁后绝不发起远端调用（也不改写状态）：正常路径由 cleanup 清账本拦住尾随刷新，
        // 这里再兜一层，覆盖 connection/reset 处理器等销毁后才到达的迟到入口。
        if (disposed) return Promise.resolve();
        const requestToken = freshness.beginRequest("catalog", "settings");
        // 保留上一次已知目录：加载中只换状态，不清空下拉已经能用的选项。
        publish({ ...state, status: "loading", error: null });
        const promise = Promise.resolve().then(() => ctx.remote.session.modelCatalog()).then((response) => {
          const catalog = response?.ok === true ? response.value : response;
          if (!catalog || !Array.isArray(catalog.groups)) throw new Error("模型目录不可用");
          const normalizedGroups = normalizeSettingsModelGroups(catalog.groups);
          const accepted = freshness.acceptCatalogResponse({
            generation: requestToken.sequence,
            groups: normalizedGroups,
            requestToken,
          });
          // 过期响应（期间又来了刷新事件）由 freshness 拒绝：旧目录绝不覆盖新目录，
          // 也绝不把角色下拉提前解锁。
          if (accepted.accepted) publish({ groups: normalizedGroups, status: "ready", error: null });
        }).catch((cause) => {
          if (freshness.isCurrent(requestToken)) {
            publish({ ...state, status: "error", error: cause instanceof Error ? cause.message : String(cause) });
          }
        }).finally(() => {
          // 用 promise 身份而不是 freshness 令牌判断收尾责任：在途期间到达的刷新事件会
          // 刻意作废本请求的令牌（见 refresh），那时令牌已不再"当前"，但释放 inflight 与
          // 启动尾随刷新的责任仍然在本请求，否则 store 会永久停在 loading。
          if (inflight !== promise) return;
          inflight = null;
          if (!queued) return;
          queued = false;
          startRequest();
        });
        inflight = promise;
        return promise;
      };
      /**
       * 幂等读取：已有在途请求时复用它，不再并发第二次。
       * 销毁后返回一个已完成的 Promise：调用方（设置页挂载 effect）不会被悬挂的等待卡住，
       * 但 store 不会因此向远端发请求。
       */
      const load = () => {
        if (disposed) return Promise.resolve();
        if (inflight !== null) return inflight;
        return startRequest();
      };
      const refresh = (clear) => {
        // 销毁后刷新事件没有任何意义（监听已摘除）；迟到的 connection/reset 也必须被丢弃，
        // 否则会在插件销毁后启动一次远端目录调用。
        if (disposed) return;
        // connection/reset 的 clear 语义：在途请求属于旧连接，它的结算与响应都不可再用，
        // 因此放弃它（收尾里的身份检查会让它的 finally 变成空操作，startRequest 的新令牌
        // 也会让它的迟到响应被拒绝）并立刻重新读取——绝不等待一个可能永远不会结算的旧请求。
        if (clear) {
          inflight = null;
          queued = false;
          publish({ groups: [], status: "idle", error: null });
          startRequest();
          return;
        }
        if (inflight !== null) {
          // 单飞：在途期间的刷新事件合并为一个尾随刷新，并立刻作废在途请求的令牌：
          // 它的响应属于旧目录，必须由 client-freshness 拒绝，不能覆盖即将到来的最新目录。
          if (!queued) freshness.beginRequest("catalog", "settings");
          queued = true;
          return;
        }
        startRequest();
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const getSnapshot = () => state;
      const eventStops = [];
      for (const event of ["llm/adapters-updated", "settings/document-updated", "credentials/reference-updated"]) {
        eventStops.push(ctx.remote.$on(event, () => refresh(false)));
      }
      ctx.on("connection/reset", () => refresh(true));
      ctx.effect(() => () => {
        // 顺序是语义的一部分：
        // ① 先置销毁标记，封锁所有入口（load / refresh / startRequest / 尾随刷新）；
        disposed = true;
        // ② 清掉逻辑账本：在途请求的 .finally 用 promise 身份判断收尾责任，账本清空后
        //    它只会直接返回，不会再把 queued 的尾随刷新发出去；
        inflight = null;
        queued = false;
        // ③ 最后才摘监听并 dispose freshness：在途请求的迟到响应仍会被 freshness
        //    拒绝（dispose 后 isCurrent 恒为 false），绝不覆盖目录或把角色下拉解锁。
        for (const stop of eventStops) if (typeof stop === "function") stop();
        freshness.dispose();
      }, "dsh-expert-group: settings catalog events");
      return { load, subscribe, getSnapshot };
    }

    // 将 Host 目录归一化为设置页可安全消费的 provider / model / effort 结构。
    function normalizeSettingsModelGroups(groups) {
      return (Array.isArray(groups) ? groups : []).flatMap((group) => {
        if (!group || typeof group.id !== "string" || group.id.length === 0) return [];
        const models = (Array.isArray(group.models) ? group.models : [])
          .filter((model) => model && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
          .map((model) => {
            const normalized = {
              ...model,
              name: typeof model.name === "string" && model.name.trim().length > 0 ? model.name : model.id,
            };
            const reasoning = model.reasoning;
            if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
              delete normalized.reasoning;
              return normalized;
            }
            const efforts = (Array.isArray(reasoning.efforts) ? reasoning.efforts : [])
              .flatMap((effort) => {
                if (!effort || typeof effort !== "object" || typeof effort.id !== "string" || effort.id.length === 0) return [];
                return [{
                  ...effort,
                  name: typeof effort.name === "string" && effort.name.trim().length > 0 ? effort.name : effort.id,
                }];
              });
            const defaultEffort = typeof reasoning.defaultEffort === "string"
              && reasoning.defaultEffort.trim().length > 0
              && efforts.some((effort) => effort.id === reasoning.defaultEffort)
              ? reasoning.defaultEffort
              : void 0;
            normalized.reasoning = {
              efforts,
              ...(defaultEffort === void 0 ? {} : { defaultEffort }),
            };
            return normalized;
          });
        return [{
          ...group,
          name: typeof group.name === "string" && group.name.trim().length > 0 ? group.name : group.id,
          models,
        }];
      });
    }

    /** 从模型目录条目读取用户可见的显示名称；缺失时沿用模型 ID 作为归一后的回退名称。 */
    function modelDisplayNameOf(model) {
      if (!model || typeof model !== "object") return "";
      if (typeof model.name === "string" && model.name.trim().length > 0) return model.name;
      return typeof model.id === "string" && model.id.length > 0 ? model.id : "";
    }

    /** 按目标 provider 的显示名称迁移一项选择；不兼容时返回 null，调用方负责清理。 */
    function migrateSettingsSelection(selection, provider, groups) {
      if (typeof provider !== "string" || provider.length === 0) return null;
      const providerGroups = Array.isArray(groups) ? groups : [];
      const providerGroup = providerGroups.find((group) => group?.id === provider);
      if (!providerGroup) return null;
      if (!selection || typeof selection !== "object"
        || typeof selection.model !== "string" || selection.model.length === 0) return null;

      // 必须先从源 provider 解析显示名称：目标 provider 的模型 ID 可能完全不同，
      // 只有用户自定义的 name（或目录归一后的 ID 回退名称）一致时才视为同一选择。
      const sourceGroup = typeof selection.provider === "string" && selection.provider.length > 0
        ? providerGroups.find((group) => group?.id === selection.provider)
        : void 0;
      const sourceModel = Array.isArray(sourceGroup?.models)
        ? sourceGroup.models.find((candidate) => candidate?.id === selection.model)
        : void 0;
      const sourceDisplayName = modelDisplayNameOf(sourceModel);
      if (sourceDisplayName.length === 0) return null;

      const model = Array.isArray(providerGroup.models)
        ? providerGroup.models.find((candidate) => modelDisplayNameOf(candidate) === sourceDisplayName)
        : void 0;
      if (!model) return null;
      const next = { provider: providerGroup.id, model: model.id };
      const reasoning = model.reasoning;
      if (typeof selection.reasoningEffort === "string"
        && Array.isArray(reasoning?.efforts)
        && reasoning.efforts.some((effort) => effort?.id === selection.reasoningEffort)) {
        next.reasoningEffort = selection.reasoningEffort;
      }
      return next;
    }

    /** 按目标 provider 的同名模型迁移 defaults；不兼容的角色沿用清理语义丢弃。 */
    function migrateSettingsDefaults(defaults, provider, groups) {
      if (typeof provider !== "string" || provider.length === 0) return {};
      const providerGroup = (Array.isArray(groups) ? groups : []).find((group) => group?.id === provider);
      if (!providerGroup) return {};
      const migrated = {};
      for (const [role, selection] of Object.entries(defaults ?? {})) {
        const next = migrateSettingsSelection(selection, provider, groups);
        if (next !== null) migrated[role] = next;
      }
      return migrated;
    }

    /**
     * 只同步设置页当前可见角色。没有已有模型时暂存 provider + 空 model，
     * 让用户仍能先选 provider 再选模型；保存前 normalizeSettingsDraft 会丢弃空 model。
     */
    function syncSettingsDefaultsProvider(defaults, provider, groups, roles) {
      const next = { ...(defaults && typeof defaults === "object" ? defaults : {}) };
      if (typeof provider !== "string" || provider.length === 0) return next;
      for (const role of settingsRolesForProvider(roles)) {
        const migrated = migrateSettingsSelection(next[role], provider, groups);
        next[role] = migrated ?? { provider, model: "" };
      }
      return next;
    }

    /**
     * 提交响应归一：保留已有 settings 草稿形状，同时仅在 wire 明确携带时保留提示词覆盖。
     * 这样旧 Host/旧测试的返回结构不凭空新增 promptOverrides，新 Host 则不会丢失覆盖。
     */
    function normalizeSettingsCommitDraft(value, roles) {
      const normalized = normalizeSettingsDraft(value, roles);
      if (value !== null && typeof value === "object"
        && Object.prototype.hasOwnProperty.call(value, "promptOverrides")) {
        normalized.promptOverrides = normalizePromptOverrides(value.promptOverrides);
      }
      return normalized;
    }

    /**
     * 通过 Host 动态校验并提交完整 settings 候选，失败时不改变本地 dirty 草稿。
     * 唯一实现位于 client-freshness.js（本文件只注入 RPC 路由常量与草稿归一函数）；
     * 响应解析（含 code/status/currentRevision 结构化错误）同样由共享实现负责，
     * 这里不再保留第二份提交/解析逻辑。
     *
     * 票据 20：新客户端还要随请求上报变更集 `changed`（哪些字段真的变了）。共享实现的
     * 请求体是固定的历史形状（action/settings/expectedRevision），因此只在**提供了变更集**
     * 时用同一份共享原语（requestPluginRpc + readSettingsCommitOutcome，错误归一与
     * currentRevision 解析完全一致）组一条带 `changed` 的请求；未提供变更集的调用
     * （旧调用形状、其它使用方）逐字节保持原样。候选仍是完整值，replace 语义不变。
     */
    async function commitSettingsCandidate(settings, revision, request = globalThis.fetch, connection, roles, changed) {
      const surface = requireFreshnessSurface();
      if (changed === void 0) {
        return surface.commitSettingsCandidate(settings, revision, {
          request,
          connection,
          normalizeSettingsDraft: normalizeSettingsCommitDraft,
          roles,
          rpcTarget: RPC_TARGET,
        });
      }
      const body = {
        action: "settings-commit",
        settings,
        expectedRevision: revision,
        // 变更集只描述「哪些字段变了」，不是 patch 协议：settings 仍提交完整候选。
        changed,
      };
      const response = await requestPluginRpc(connection, body, {}, request);
      return surface.readSettingsCommitOutcome(response, normalizeSettingsCommitDraft, roles);
    }

    /**
     * 宿主 meta 只读读取（生命周期一次 + 用户显式刷新）。
     *
     * 角色表、提示词投影与运行诊断共用同一次请求：因此**不新增任何
     * RPC、定时器或轮询**，也不会因为打开设置页而触碰通知权限或专家任务。
     * body: JSON.stringify({ action: "meta" }) is retained as the legacy HTTP payload contract.
     */
    function useHostMeta(ctx) {
      const [meta, setMeta] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [version, setVersion] = react.useState(0);
      react.useEffect(() => {
        let cancelled = false;
        setError(null);
        void requestPluginRpc(ctx?.connection, { action: "meta" }).then((response) => (
          response.ok === true ? response.json() : null
        )).then((json) => {
          if (cancelled) return;
          if (json !== null && json?.ok === true) {
            setMeta(json);
            setError(null);
          } else {
            setMeta(null);
            setError("提示词配置读取失败");
          }
        }).catch((cause) => {
          if (cancelled) return;
          setMeta(null);
          setError(cause instanceof Error ? cause.message : "提示词配置读取失败");
        });
        return () => { cancelled = true; };
      }, [ctx, version]);
      return [meta, () => setVersion((value) => value + 1), error];
    }

    /**
     * 从 meta 投影出启用角色；meta 缺失/不可用时沿用历史默认角色表。
     *
     * 角色集合仍以 Host 的 meta.activeRoles/roles 为准，但客户端只接受内置角色表里的 id：
     * Host 已不再支持自定义角色，旧文档/旧 meta 里的未知 id 必须在读取面就被过滤掉。
     */
    function useEnabledSettingsRoles(hostMeta) {
      return react.useMemo(() => {
        const configuredRoles = Array.isArray(hostMeta?.activeRoles) ? hostMeta.activeRoles : hostMeta?.roles;
        if (!Array.isArray(configuredRoles)) return SETTINGS_REQUIRED_ROLE_IDS;
        const enabled = configuredRoles.filter((role) => typeof role === "string" && role.length > 0
          && SETTINGS_ROLE_IDS.includes(role));
        if (hostMeta?.enableObserver === true && !enabled.includes("observer")) enabled.push("observer");
        return enabled.filter((role, index) => enabled.indexOf(role) === index);
      }, [hostMeta]);
    }

    // ── 「模型配置」区域：默认折叠，provider 卡片按需展开且独立应用/取消 ───────────
    /** 装配期侧车模块的检查点键（与相邻 IIFE 模块的 Symbol 约定一致）。 */
    const MODEL_CONFIG_GLOBAL_KEY = "dsh-expert-group/client-model-config";

    /**
     * 自定义 provider 的 settings 命名空间与 profile 基路径。
     *
     * `llm-pi-ai` 是 DSH 中唯一支持手写 route 的 adapter family（它的 schema 也是唯一
     * 暴露协议联合类型的），因此自定义 provider 只能落在它下面。
     */
    const CUSTOM_PROVIDER_NS = "llm-pi-ai";
    const CUSTOM_PROFILE_BASE_PATH = Object.freeze(["providers"]);
    /**
     * 读取协议词表用的探针 route。
     *
     * `api` 字段是 `providers` 字典里的固定形状，因此任何 route 名都能走到同一个 union 节点；
     * 用下划线前缀声明一个不可能与真实 route 冲突、也不符合 route 词表的探针名。
     */
    const CUSTOM_ROUTE_PROBE = "_probe";

    /**
     * 解析「模型配置」的唯一纯数据流实现。
     *
     * 正常路径从 `globalThis` 的检查点取回（装配期先于本 descriptor 执行的 IIFE 已写入）；
     * 测试替身/宿主注入路径允许把同一份实现作为可选客户端服务传入，两条路径取到的是
     * 同一个对象，不存在第二份实现。
     *
     * 注意：这里的宿主上下文只能来自参数——绝不能闭包引用 apply 作用域里的 `ctx`，
     * 否则会命中暂时性死区并让整个区域静默消失。
     */
    function resolveModelConfig(hostCtx, sidecar) {
      if (sidecar !== null && sidecar !== undefined) return sidecar;
      try {
        const fromCtx = typeof hostCtx?.get === "function" ? hostCtx.get(MODEL_CONFIG_GLOBAL_KEY) : null;
        if (fromCtx !== null && fromCtx !== undefined) return fromCtx;
      } catch { /* 服务未安装或代理拒答。 */ }
      try {
        return globalThis[Symbol.for(MODEL_CONFIG_GLOBAL_KEY)];
      } catch {
        return undefined;
      }
    }

    /**
     * 模型配置的数据流与宿主面适配层。
     *
     * 唯一纯函数实现在 client-model-config.js（装配期先于本 descriptor 执行的 IIFE）；
     * 这里只负责把它接到公开 API 上：`remote.llm`（provider 目录与"获取模型"）、
     * `remote.credentials`（API Key 只写不读明文）、`remote.settings`（按 namespace revision
     * 提交路径操作）与 `configForms.describe()`（命名空间视图与 schema，与旧 binder describe 同形状）。
     *
     * 直接调用 `remote.settings.mutate` 而不是配置表单的 `mutate`：后者不返回结果，
     * 无法把 schema 拒绝与 revision 冲突如实报给用户，而需求要求"拒绝时显示错误且不落盘"。
     */
    function createModelConfigHost(hostCtx, describeSource, sidecar) {
      const config = resolveModelConfig(hostCtx, sidecar);
      if (config === undefined) return null;
      /**
       * 读取一个宿主服务或 Remote 命名空间。
       *
       * 两条路径缺一不可：
       * 1. `ctx.get(name)` —— 真实宿主的正确入口。gateway 把每个命名空间注册成**独立的
       *    Cordis 服务** `remote.<namespace>`，而 `ctx.get` 不带 inject 门控。直接写
       *    `ctx.remote.llm` 会命中 traceable 代理的 inject 校验并抛
       *    `cannot get property "remote.llm" without inject`，让整个客户端 fiber FAILED
       *    （真实宿主表现为启动页 “dsh-expert-group: failed”，入口未能激活）。
       * 2. 逐段属性回退 —— 兼容把命名空间挂在其父服务对象上的旧宿主与测试替身
       *    （`ctx.remote.llm` 是普通属性，不存在 traceable 门控）。
       *
       * 任何一层缺失或代理拒答都返回 null：模型配置是可选能力，缺失时只降级为只读提示，
       * 绝不让整条客户端入口失败。
       */
      const readService = (name) => {
        if (typeof hostCtx?.get === "function") {
          try {
            const value = hostCtx.get(name);
            if (value !== undefined && value !== null) return value;
          } catch { /* 服务未安装或代理拒答，继续尝试属性回退。 */ }
        }
        let current = hostCtx;
        for (const segment of String(name).split(".")) {
          if (segment.length === 0) continue;
          if (current === undefined || current === null) return null;
          try {
            current = current[segment];
          } catch {
            return null;
          }
        }
        return current === undefined ? null : current;
      };
      const readMethod = (target, name) => {
        try {
          const value = target?.[name];
          return typeof value === "function" ? value : null;
        } catch {
          return null;
        }
      };
      // 统一经 readService 解析：缺失时整段模型配置降级为只读提示，不影响角色配置与侧边栏。
      const llm = readService("remote.llm");
      const credentials = readService("remote.credentials");
      const settingsRemote = readService("remote.settings");
      // describe 面唯一来源是 `configForms.describe()`（0.1.7-alpha.2 的 settings 服务公开面，
      // 与旧 binder describe 同形状：getSnapshot/subscribe/ensure/acceptView）。
      // 已删除的 settingsScope binder 与 bound scope 双回退链一并移除：宿主没有这个面时
      // 模型配置的区域视图降级为 null（不崩溃、不影响角色配置与侧边栏）。
      const describeFace = (() => {
        try {
          return typeof describeSource?.describe === "function" ? describeSource.describe() : null;
        } catch {
          return null;
        }
      })();
      // 每个 schema 信封只 rehydrate 一次：React 每次渲染都会读同一份视图，
      // 按信封对象缓存既避免重复构造，也让派生值保持稳定引用。
      const schemaCache = new WeakMap();
      const adapter = (() => {
        const schemaService = readService("settingsSchema");
        return config.createSchemaAdapter({
          rehydrate: (() => {
            const rehydrate = readMethod(schemaService, "rehydrate");
            if (rehydrate === null) return null;
            return (serialized) => {
              // 每个 schema 信封只 rehydrate 一次：React 每次渲染都会读同一份视图，
              // 按信封对象缓存既避免重复构造，也让派生值保持稳定引用。
              if (serialized !== null && typeof serialized === "object") {
                const cached = schemaCache.get(serialized);
                if (cached !== undefined) return cached;
                const node = rehydrate(serialized);
                schemaCache.set(serialized, node);
                return node;
              }
              return rehydrate(serialized);
            };
          })(),
          validate: (() => {
            const validate = readMethod(schemaService, "validate");
            return validate === null ? null : (schema, draft) => validate(schema, draft);
          })(),
          nodeAtPath: (() => {
            const nodeAtPath = readMethod(schemaService, "nodeAtPath");
            return nodeAtPath === null ? null : (root, path) => nodeAtPath(root, path);
          })(),
        });
      })();
      let views = [];
      let writable = false;
      let credentialStates = {};
      let describeError = null;
      // 宿主视图版本与"外部失效"版本必须分开，否则会形成无限刷新环。
      //
      // 宿主对象自身不触发渲染，所以这里维护两个单调递增计数：
      // - `hostRevision`：**任何**视图前进都递增（包括本组件自己 load 触发的重读）。它只用于
      //   memo 依赖，让卡片在重读后拿到新的 user 层与 revision。
      // - `hostInvalidation`：只有**外部**事件（settings mirror、连接重置）才递增。区域的加载
      //   effect 只依赖它，因此"load -> refresh -> notify -> load"不会自激；一次外部失效
      //   恰好触发一次重新加载。
      let hostRevision = 0;
      let hostInvalidation = 0;
      const hostListeners = new Set();
      const notifyHostChange = (external) => {
        hostRevision += 1;
        if (external === true) hostInvalidation += 1;
        for (const listener of [...hostListeners]) {
          try {
            listener();
          } catch { /* 单个订阅者抛错不得影响其它订阅者与 settings 视图。 */ }
        }
      };
      const subscribeHost = (listener) => {
        if (typeof listener !== "function") return () => {};
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      };

      const operations = {
        listProviderDirectory: async () => {
          const listProviders = readMethod(llm, "listProviders");
          const listConfigurable = readMethod(llm, "listConfigurableProviders");
          if (listConfigurable === null) throw new Error("当前宿主没有提供 provider 配置目录接口");
          const [registered, declared] = await Promise.all([
            listProviders === null ? Promise.resolve({ ok: true, value: [] }) : listProviders.call(llm),
            listConfigurable.call(llm),
          ]);
          if (declared?.ok !== true) throw new Error(declared?.error?.message ?? "provider 目录读取失败");
          if (registered !== null && registered?.ok !== true) throw new Error(registered?.error?.message ?? "provider 列表读取失败");
          return config.joinProviderDirectory(
            registered === null ? [] : registered.value,
            Array.isArray(declared.value) ? declared.value : [],
          );
        },
        describeCredentials: async (refs) => {
          const describe = readMethod(credentials, "describe");
          const wanted = [...new Set((Array.isArray(refs) ? refs : []).filter((ref) => typeof ref === "string" && ref.length > 0))];
          if (describe === null || wanted.length === 0) {
            credentialStates = {};
            return {};
          }
          const response = await describe.call(credentials, wanted);
          credentialStates = response?.ok === true && response.value !== null && typeof response.value === "object" ? response.value : {};
          return credentialStates;
        },
        credentialState: (ref) => (typeof ref === "string" ? credentialStates[ref] : undefined),
        /** API Key 只走 credentials 服务：明文既不进入 settings，也不进入客户端状态快照。 */
        storeKey: async (ref, value) => {
          const set = readMethod(credentials, "set");
          if (set === null) return "当前宿主没有提供凭据写入接口";
          try {
            const response = await set.call(credentials, ref, value);
            return response?.ok === true ? null : (response?.error?.message ?? "API Key 保存失败");
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        removeKey: async (ref) => {
          const unset = readMethod(credentials, "unset");
          if (unset === null) return "当前宿主没有提供凭据写入接口";
          try {
            const response = await unset.call(credentials, ref);
            return response?.ok === true ? null : (response?.error?.message ?? "API Key 删除失败");
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        discoverModels: async (namespace, request) => {
          const discover = readMethod(llm, "discoverModels");
          if (discover === null) return { kind: "refused", message: "当前宿主没有提供「获取模型」接口" };
          try {
            const response = await discover.call(llm, namespace, request);
            if (response?.ok !== true) return { kind: "refused", message: response?.error?.message ?? "获取模型失败" };
            return { kind: "found", models: Array.isArray(response.value) ? response.value : [] };
          } catch (error) {
            return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
          }
        },
      };

      const refreshSettingsView = async () => {
        describeError = null;
        if (describeFace === null) {
          describeError = "当前宿主没有提供 settings namespace 视图";
          views = [];
          writable = false;
          return;
        }
        try {
          await describeFace.ensure();
        } catch { /* 读取失败由下面的一致性检查报错。 */ }
        const snapshot = describeFace.getSnapshot?.() ?? {};
        const view = snapshot.view;
        if (view === undefined) {
          describeError = snapshot.error ?? "settings 命名空间不可用";
          views = [];
          // 视图缺失时必须显式落回只读：否则一次成功的读取会把 writable 留在 true，
          // 后续读取失败时写入按钮仍然可点，最终只会在宿主边界失败。
          writable = false;
          return;
        }
        views = Array.isArray(view.namespaces) ? view.namespaces : [];
        // 写入权限是**整页**事实：DSH 的 settings describe 只在 view 上给出 writable，
        // namespace 条目本身不保证重复携带该字段。缺失时绝不能让可写页面降级为只读。
        writable = view.writable !== false;
        // 主动重读也通知一次（外部失效=false）：memo 依赖据此前进，但加载 effect 不受影响。
        notifyHostChange(false);
      };
      const invalidationStops = [];
      const remote = readService("remote");
      const remoteOn = readMethod(remote, "$on");
      if (remoteOn !== null) {
        for (const event of ["llm/adapters-updated", "settings/document-updated", "credentials/reference-updated"]) {
          try {
            invalidationStops.push(remoteOn.call(remote, event, () => notifyHostChange(true)));
          } catch { /* 旧宿主不支持该事件时保持设置页可用。 */ }
        }
      }
      const hostOn = readMethod(hostCtx, "on");
      if (hostOn !== null) {
        try {
          invalidationStops.push(hostOn.call(hostCtx, "connection/reset", () => notifyHostChange(true)));
        } catch { /* 旧宿主没有连接事件面时无需额外刷新。 */ }
      }
      if (typeof hostCtx?.effect === "function") {
        hostCtx.effect(() => () => {
          for (const stop of invalidationStops) if (typeof stop === "function") stop();
          hostListeners.clear();
        }, "dsh-expert-group: model config settings mirror events");
      }

      const namespaceView = (ns) => {
        if (describeFace !== null) return config.namespaceViewOf({ namespaces: views }, ns);
        return undefined;
      };
      const settingsSchemaInfo = (ns) => {
        const view = namespaceView(ns);
        return config.namespaceSchemaInfo(view ?? {}, adapter);
      };
      /**
       * 一次原子提交：本地 schema 先拦，正式 settings API 再拦。
       *
       * 任一拒绝都不写盘，并把宿主诊断原样回传；冲突只按 revision 语义判定，
       * 绝不把 schema 拒绝伪装成冲突（那样会让用户以为重新加载就能解决）。
       */
      const writeNamespace = async ({ ns, ops, expectedRevision }) => {
        const mutate = readMethod(settingsRemote, "mutate");
        if (mutate === null) return { ok: false, conflict: false, message: "当前宿主没有提供 settings 写入接口" };
        if (!config.hasOps(ops)) return { ok: true, view: namespaceView(ns) };
        const current = namespaceView(ns)?.revision;
        if (config.revisionConflictOf(expectedRevision, current)) {
          return { ok: false, conflict: true, message: "配置已被其它会话或页面修改，本卡片的修改未提交；请重新打开该 provider 卡片后再试。" };
        }
        let response;
        try {
          response = await mutate.call(settingsRemote, ns, ops, expectedRevision);
        } catch (error) {
          return { ok: false, conflict: false, message: error instanceof Error ? error.message : String(error) };
        }
        if (response?.ok === true) {
          const view = response.value;
          // 提交边界已经落到宿主权威视图上：把它折叠回共享镜像，界面无需额外读取。
          try {
            describeFace?.acceptView?.(view);
          } catch { /* 镜像折叠失败不影响本次提交结果。 */ }
          views = Array.isArray(view?.namespaces)
            ? view.namespaces
            : views.map((entry) => (entry?.ns === ns ? view : entry));
          return { ok: true, view };
        }
        const code = response?.error?.code;
        const message = response?.error?.message ?? "保存失败";
        if (code === "settings/conflict" || code === "settings-conflict") {
          return { ok: false, conflict: true, message: `配置已被其它会话或页面修改：${message}。请重新打开该 provider 卡片后再试。` };
        }
        return { ok: false, conflict: false, message };
      };

      return {
        config,
        adapter,
        operations,
        refreshSettingsView,
        namespaceView,
        settingsSchemaInfo,
        writeNamespace,
        subscribe: subscribeHost,
        getSnapshot: () => hostRevision,
        /** 外部失效计数：只有 mirror 事件与连接重置会推进它（主动重读不会）。 */
        getInvalidation: () => hostInvalidation,
        describeError: () => describeError,
        readView: () => ({ namespaces: views, writable }),
      };
    }

    /** 折叠区标题行：整个标题是可点击按钮，展开状态由 aria-expanded 表达。 */
    function ModelConfigDisclosure({ section, onToggle, extra }) {
      return react.createElement("div", { className: "deg_mc_header" },
        react.createElement("button", {
          type: "button",
          className: "deg_mc_toggle",
          "aria-expanded": section.disclosure.expanded,
          "aria-controls": section.disclosure.bodyId,
          "data-deg-model-config-toggle": "true",
          onClick: onToggle,
        },
          react.createElement("span", { className: "deg_mc_chevron", "aria-hidden": "true" }, section.disclosure.expanded ? "▾" : "▸"),
          react.createElement("span", null, section.title)),
        extra);
    }

    /**
     * 一张 provider 卡片的编辑手感：草稿与"应用/取消"完全属于卡片自己。
     *
     * 进入编辑态时固定 baseline（user 层的 profile 子树 + revision），应用时先算最小路径操作，
     * 再做角色联动守卫与 revision 复核；任何拒绝都只更新卡片自己的错误行，不落盘、不改动其它卡片。
     */
/**
     * 一张 provider 卡片：草稿、应用/取消与凭据输入全部属于卡片自己。
     *
     * 所有判定都走 client-model-config.js 的纯函数面（`createCardSession` / `cardModel(…)`）：
     * 会话持有草稿、进入编辑态时固定的 user 基线、revision 栅栏与凭据输入，`plan()` 给出
     * 要提交的路径操作与守卫结论，`accept()` 接受宿主返回的权威视图作为新基线。
     * 因此"每个卡片独立应用/取消 + revision 冲突保护 + 角色联动守卫"与测试断言的是同一份实现。
     */
    function ModelProviderCard({ row, namespace, host, roleLabels, onSaved, onRemove }) {
      const config = host.config;
      const profilePath = Array.isArray(row.settingsPath) ? row.settingsPath : [];
      const [open, setOpen] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const [conflict, setConflict] = react.useState(false);
      const [expandedRows, setExpandedRows] = react.useState(() => new Set());
      const [fetchState, setFetchState] = react.useState(null);
      const [candidateQuery, setCandidateQuery] = react.useState("");
      const [keyDraft, setKeyDraft] = react.useState("");
      // createCardSession 是可变会话；版本号把会话草稿变化桥接到 React 渲染。
      const [, setDraftRevision] = react.useState(0);
      // 会话在卡片挂载时创建一次：revision 栅栏与 user 基线必须固定，外部提交只能被拒绝。
      const [session] = react.useState(() => config.createCardSession({
        provider: row.provider,
        settingsNs: namespace?.ns,
        profilePath,
        storedUser: namespace?.user,
        base: namespace?.base,
        value: namespace?.value,
        revision: namespace?.revision,
        roleDefaults: roleLabels.defaults,
      }));
      const schemaInfo = react.useMemo(() => {
        const info = host.settingsSchemaInfo(namespace?.ns);
        return {
          ...info,
          protocols: config.protocolChoices(info.root, row.provider, host.adapter, profilePath),
        };
      }, [host, namespace, row.provider, profilePath, config]);
      const credentialRef = config.credentialRefOf(row, namespace);
      // 写入权限继承模型配置宿主的**整页** writable：namespace 条目只提供 schema、
      // user/base/value、revision 与路径，不承担整页权限字段。
      const pageWritable = host.readView().writable === true;
      const card = session.cardModel({
        protocols: schemaInfo.protocols,
        defaultInput: schemaInfo.defaultInput,
        credentialRef,
        credential: host.operations.credentialState(credentialRef),
        typed: keyDraft,
        readOnly: !pageWritable,
        expandedRows,
        draft: session.draft,
      });
      const disabled = card.readOnly || saving;
      const removable = config.providerRemovable(row, namespace);
      const removeAction = removable && typeof onRemove === "function"
         ? react.createElement("button", {
           type: "button",
           className: "deg_btn deg_mc_delete_btn",
           disabled: saving || card.readOnly,
           "aria-label": card.displayName + " 删除",
           // 事件的 `currentTarget`（真实按钮）只在**同步派发期间**有效，因此原样交给父区域：
           // 删除成功后要按"点击那一刻的焦点归属 + 点击时捕获的区域作用域"决定是否把焦点还回
           // DEG 区域内的稳定控件（详见 REMOVE_FOCUS_TARGET_SELECTORS 上方的边界说明）。
           onClick: (event) => { void onRemove(event); },
         }, "删除")
         : null;

      const edit = (update) => {
        session.edit(update);
        setDraftRevision((value) => value + 1);
        setSaved(false);
        setError(null);
      };
      const patchRow = (index, patch) => {
        edit((draft) => ({
          ...draft,
          models: session.modelRows.map((model, at) => (
            at === index ? config.patchModelDraft(model, patch) : model
          )),
        }));
      };
      const toggleEffort = (index, level) => {
        edit((draft) => {
          const rows = session.modelRows;
          const selection = config.effortSelectionFor(rows[index]);
          return { ...draft, models: config.setModelEffortSelection(rows, index, { ...selection, [level]: selection[level] !== true }) };
        });
      };
      const toggleInput = (index, modality) => {
        edit((draft) => {
          const rows = session.modelRows;
          const selected = config.modelInputOf(rows[index], schemaInfo.defaultInput);
          const next = selected.includes(modality) ? selected.filter((value) => value !== modality) : [...selected, modality];
          return { ...draft, models: config.setModelInputSelection(rows, index, next) };
        });
      };
      const toggleRow = (index) => {
        setExpandedRows((previous) => {
          const next = new Set(previous);
          if (!next.delete(index)) next.add(index);
          return next;
        });
      };
      const cancel = () => {
        session.cancel();
        setExpandedRows(new Set());
        setFetchState(null);
        setCandidateQuery("");
        setError(null);
        setSaved(false);
        setConflict(false);
        setKeyDraft("");
      };
      const apply = async () => {
        if (disabled) return false;
        setSaving(true);
        setError(null);
        setSaved(false);
        setConflict(false);
        try {
          const plan = session.plan();
          if (plan.ok !== true) {
            setError(plan.error);
            return false;
          }
          if (config.hasOps(plan.ops)) {
            const schemaNode = profilePath.length === 0
              ? host.adapter.rehydrate(namespace?.schema)
              : host.adapter.nodeAtPath(host.adapter.rehydrate(namespace?.schema), profilePath);
            if (schemaNode !== undefined) {
              // 本地 schema 先拦一道；正式 settings API 仍会在持久化边界再校验一次。
              const failure = host.adapter.validate(schemaNode, session.draft);
              if (failure !== undefined) {
                setError("设置校验未通过，已拒绝写入：" + failure);
                return false;
              }
            }
            const written = await host.writeNamespace({
              ns: namespace.ns,
              ops: plan.ops,
              expectedRevision: plan.expectedRevision,
            });
            if (!written.ok) {
              setConflict(written.conflict === true);
              setError(written.message);
              return false;
            }
            // 提交边界把权威用户层与 revision 交回来：卡片立即接受它作为新基线，
            // 因此下一次应用是"相对权威状态"的最小 diff，而不是重放旧基线。
            if (written.view !== undefined) session.accept(written.view);
          }
          if (plan.keyValue !== undefined) {
            const stored = await host.operations.storeKey(credentialRef, plan.keyValue);
            if (stored !== null) {
              setError(stored);
              return false;
            }
            session.typeKey("");
            setKeyDraft("");
          }
          await host.refreshSettingsView();
          setSaved(true);
          onSaved();
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        } finally {
          setSaving(false);
        }
      };
      const fetchModels = async () => {
        // 手动意图必须在 await 之前同步置位：正在途中的自动探测回调据此放弃写草稿，
        // 否则自动结果可能晚于这次点击返回，把完整目录直接写进草稿绕过用户选择。
        discoveryIntent.manualIntent = true;
        setSaving(true);
        setError(null);
        setFetchState(null);
        setCandidateQuery("");
        try {
          const draft = session.draft;
          const baseURL = typeof draft.baseURL === "string" && draft.baseURL.length > 0 ? draft.baseURL : undefined;
          const api = typeof draft.api === "string" && draft.api.length > 0 ? draft.api : undefined;
          const typed = session.keyValue;
          const answer = await host.operations.discoverModels(namespace.ns, {
            provider: row.provider,
            ...(baseURL === undefined ? {} : { baseURL }),
            ...(api === undefined ? {} : { api }),
            ...(typed.length === 0 ? {} : { apiKey: typed }),
          });
          if (answer.kind === "refused") {
            setFetchState({ error: answer.message, candidates: null });
            return;
          }
          if (answer.models.length === 0) {
            setFetchState({ error: "该端点没有返回任何模型", candidates: null });
            return;
          }
          // 手动候选到达后先清掉"自动 fallback 写入且用户没改过"的行：这次手动发现
          // 取得候选选择权，自动填充的目录不得继续留在草稿里绕过用户勾选。
          // 用户在自动行上做过的修改（行内容已与快照不同）与其它手工行一律保留。
          const pruned = pruneUneditedAutoFallbackRows();
          if (pruned !== null) {
            session.edit((draft) => ({ ...draft, models: pruned }));
            setDraftRevision((value) => value + 1);
            setSaved(false);
          }
          // known 按清理后的草稿计算：被清掉的自动行不再算"已存在"，手动候选里同 id 的条目
          // 因此会作为可勾选候选出现，而不是被当成已有行静默跳过。
          const known = new Set(session.modelRows
            .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
            .filter((id) => id.length > 0));
          setFetchState({
            error: null,
            candidates: answer.models.map((model) => ({
              ...model,
              // 手动发现的候选默认只勾选"草稿里还没有"的模型；自动 fallback 已先写入的行
              // 在手动发现命中后（除非用户改过）已被上面清掉，因此这里会重新作为候选出现，
              // 由用户显式勾选决定是否保留，而不是被自动目录静默带入。
              picked: typeof model.id === "string" && model.id.trim().length > 0
                && !known.has(model.id.trim()),
            })),
          });
        } finally {
          setSaving(false);
        }
      };
      /**
       * 自动 fallback 探测与手动「获取模型」之间的共享意图状态。
       *
       * 挂在稳定的 `session` 依赖的 useMemo 上：卡片重渲染不会重建它，因此晚到的自动探测
       * 回调看到的是**同一次**手动意图，而不是快照里的旧值。两个字段各司其职：
       * - `manualIntent`：用户点过「获取模型」就置位。自动探测晚于点击返回时必须放弃，
       *   绝不能把完整目录直接写进草稿（否则用户还没选模型就被隐式写入了目录）。
       * - `autoFallback`：最近一次自动探测写进草稿的行快照。手动候选到达后据此只清掉
       *   "仍与该快照完全相同"的未编辑行，用户在自动 fallback 上做过的修改一律保留。
       */
      const discoveryIntent = react.useMemo(() => ({ manualIntent: false, autoFallback: null }), [session]);
      /** 记录自动 fallback 快照（同一批自动行只记一次，供之后的手动探测做"未编辑"判定）。 */
      const noteAutoFallback = (models) => {
        if (discoveryIntent.autoFallback !== null) return;
        discoveryIntent.autoFallback = Array.isArray(models) ? models.map((model) => ({ ...model })) : [];
      };
      /** 草稿行是否与自动 fallback 快照里同 id 的行逐字段相同（即"未编辑的自动填充行"）。 */
      const isUneditedAutoFallbackRow = (row) => {
        const snapshot = discoveryIntent.autoFallback;
        if (!Array.isArray(snapshot) || !config.isPlainObject(row)) return false;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (id.length === 0) return false;
        return snapshot.some((entry) => {
          if (!config.isPlainObject(entry)) return false;
          const entryId = typeof entry.id === "string" ? entry.id.trim() : "";
          return entryId === id && config.jsonEqual(entry, row);
        });
      };
      /**
       * 手动候选到达后清理草稿：只移除仍与自动 fallback 快照完全相同的未编辑行。
       * 返回新行数组；没有任何行被移除时返回 null，调用方据此跳过无谓的草稿改写。
       */
      const pruneUneditedAutoFallbackRows = () => {
        const snapshot = discoveryIntent.autoFallback;
        if (!Array.isArray(snapshot) || snapshot.length === 0) return null;
        const rows = session.modelRows;
        const kept = rows.filter((row) => !isUneditedAutoFallbackRow(row));
        return kept.length === rows.length ? null : kept;
      };
      react.useEffect(() => {
        if (!open || row.declared === true || namespace?.ns === "llm-deepseek") return undefined;
        let active = true;
        // 每一轮自动探测都重置快照：新的自动结果必须重新记录，否则手动清理会拿旧快照做判定。
        discoveryIntent.autoFallback = null;
        // 手动意图只屏蔽"当前打开周期"：走到这里说明已通过守卫、确定要发起一次全新的自动探测，
        // 所以清掉上一周期遗留的手动标记，卡片折叠后再展开才能恢复自动目录增强。
        // 同一打开周期内晚于手动点击返回的自动请求，仍会观察到 true 并放弃写草稿。
        discoveryIntent.manualIntent = false;
        void host.operations.discoverModels(namespace.ns, { provider: row.provider }).then((answer) => {
          // 手动意图优先：用户已经点过「获取模型」时，这次自动结果不得写入草稿，
          // 由手动候选的选择流程独占草稿的模型目录。
          if (discoveryIntent.manualIntent) return;
          if (!active || answer.kind !== "found" || answer.models.length === 0 || session.modelRows.length > 0) return;
          session.setFallbackModels(answer.models);
          noteAutoFallback(session.modelRows);
          setDraftRevision((value) => value + 1);
        }).catch(() => {
          // 自动目录探测是增强能力，失败时保留 settings 中的模型与手工编辑入口。
        });
        return () => { active = false; };
      }, [host, namespace?.ns, open, row.declared, row.provider, session]);

      const toggleCandidate = (id) => {
        setFetchState((previous) => previous === null || !Array.isArray(previous.candidates)
          ? previous
          : {
            ...previous,
            candidates: previous.candidates.map((candidate) => candidate.id === id
              ? { ...candidate, picked: candidate.picked !== true }
              : candidate),
          });
      };
      /**
       * 弹窗「全选/取消全选」的唯一实现（弹窗按钮文案也走同一个纯函数判定）。
       *
       * - 可见项已全选 → 清空**全部**选择（含被搜索隐藏的候选），与 DSH 模型页一致；
       * - 否则只把可见项追加为已选，隐藏候选保留原选择。
       */
      const toggleVisibleCandidates = (ids) => {
        const wanted = new Set(Array.isArray(ids) ? ids : []);
        setFetchState((previous) => {
          if (previous === null || !Array.isArray(previous.candidates)) return previous;
          if (clearsAllCandidateSelection(previous.candidates, wanted)) {
            return { ...previous, candidates: previous.candidates.map((candidate) => ({ ...candidate, picked: false })) };
          }
          return {
            ...previous,
            candidates: previous.candidates.map((candidate) => wanted.has(candidate.id)
              ? { ...candidate, picked: true }
              : candidate),
          };
        });
      };
      const closeModelPicker = () => {
        setFetchState(null);
        setCandidateQuery("");
      };
      const adoptPicked = () => {
        const picked = (fetchState?.candidates ?? []).filter((candidate) => candidate.picked === true);
        if (picked.length === 0) return;
        edit((draft) => ({
          ...draft,
          models: config.adoptModels(session.modelRows, picked),
        }));
        closeModelPicker();
      };

      if (!config.providerEditable(row, namespace)) return null;

      if (!open) {
        return react.createElement("li", { className: "deg_mc_card" },
          react.createElement("div", { className: "deg_mc_card_head" },
            react.createElement("span", { className: "deg_mc_card_name" }, card.displayName),
            card.provider === card.displayName ? null : react.createElement("span", { className: "deg_mc_card_route" }, card.provider),
            card.apiKey.placeholder === "已配置（留空表示不修改）"
              ? react.createElement("span", {
                className: "deg_mc_dot",
                role: "img",
                "aria-label": "API Key 已配置",
                title: "API Key 已配置",
                "data-state": "available",
                 style: { background: "var(--dsw-alias-state-success-primary,#22c55e)" },
              })
              : null,
            react.createElement("span", { className: "deg_mc_card_actions" },
              react.createElement("button", {
                type: "button",
                className: "deg_btn",
                "aria-label": card.displayName + " 编辑",
                onClick: () => { setOpen(true); setError(null); setSaved(false); setConflict(false); },
              }, "编辑"), removeAction)),
          row.error === undefined ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, row.error));
      }

      /**
       * 一条模型条目的高级设置：容量、七个思考档位与输入类型。
       *
       * 七档始终按 REASONING_EFFORTS 的顺序渲染，与当前目录是否声明支持无关；已有映射
       * 恢复勾选，新模型全部不勾选（`buildModelCardModel` 已经算好每一档的勾选状态）。
       */
      const advancedSectionOf = (model) => (!model.advancedOpen ? null : react.createElement("div", { className: "deg_mc_model_advanced" },
        react.createElement("label", { className: "deg_mc_field" },
          react.createElement("span", { className: "deg_mc_field_label" }, "上下文窗口"),
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            inputMode: "numeric",
            value: model.contextWindow.value,
            placeholder: model.contextWindow.placeholder,
            "aria-label": "上下文窗口 " + String(model.position),
            disabled,
            onChange: (event) => patchRow(model.index, { contextWindow: config.parseCapacity(event.target.value) }),
          })),
        react.createElement("label", { className: "deg_mc_field" },
          react.createElement("span", { className: "deg_mc_field_label" }, "最大输出 token"),
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            inputMode: "numeric",
            value: model.maxTokens.value,
            placeholder: model.maxTokens.placeholder,
            "aria-label": "最大输出 token " + String(model.position),
            disabled,
            onChange: (event) => patchRow(model.index, { maxTokens: config.parseCapacity(event.target.value) }),
          })),
        react.createElement("fieldset", { className: "deg_mc_efforts" },
          react.createElement("legend", { className: "deg_mc_efforts_label" }, "思考档位（可多选）"),
          react.createElement("div", { className: "deg_mc_efforts_row" },
            model.efforts.map((effort) => react.createElement("label", {
              key: effort.level,
              className: "deg_mc_effort",
            }, react.createElement("input", {
              type: "checkbox",
              checked: effort.checked,
              disabled,
              "data-deg-effort": effort.level,
              "data-deg-model-index": model.index,
              "aria-label": "模型 " + String(model.position) + " 思考档位 " + effort.level,
              onChange: () => toggleEffort(model.index, effort.level),
            }), react.createElement("span", null, effort.level))))),
        react.createElement("fieldset", { className: "deg_mc_efforts" },
          react.createElement("legend", { className: "deg_mc_efforts_label" }, "输入类型"),
          react.createElement("div", { className: "deg_mc_input_types" },
            model.inputs.map((input) => react.createElement("label", {
              key: input.modality,
              className: "deg_mc_effort",
            }, react.createElement("input", {
              type: "checkbox",
              checked: input.checked,
              disabled: disabled || input.locked === true,
              "data-deg-input": input.modality,
              "data-deg-model-index": model.index,
              "aria-label": "模型 " + String(model.position) + " 输入类型 " + input.modality,
              onChange: () => toggleInput(model.index, input.modality),
            }), react.createElement("span", null, input.modality)))))));

      const modelRows = card.models.map((model) => react.createElement("div", {
        key: "model-" + String(model.index),
        className: "deg_mc_model",
        "data-deg-model-index": model.index,
      }, react.createElement("div", { className: "deg_mc_model_main" },
        react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            value: model.id.value,
            placeholder: "模型 ID",
            "aria-label": "模型 ID " + String(model.position),
            disabled,
            onChange: (event) => patchRow(model.index, { id: event.target.value }),
          }),
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            value: model.name.value,
            placeholder: "显示名",
            "aria-label": "模型显示名 " + String(model.position),
            disabled,
            onChange: (event) => patchRow(model.index, { name: event.target.value }),
          }),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_mc_icon_btn",
            "aria-label": "模型高级设置 " + String(model.position),
            "aria-expanded": model.advancedOpen,
            onClick: () => toggleRow(model.index),
          }, model.advancedOpen ? "▾" : "▸"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_mc_icon_btn",
            "aria-label": "删除模型 " + String(model.position),
            disabled,
            onClick: () => edit((draft) => ({ ...draft, models: config.removeModelRow(session.modelRows, model.index) })),
          }, "✕")), advancedSectionOf(model)));



      return react.createElement("li", { className: "deg_mc_card", "data-deg-provider": row.provider },
        react.createElement("div", { className: "deg_mc_card_head" },
          react.createElement("span", { className: "deg_mc_card_name" }, card.displayName),
          card.provider === card.displayName ? null : react.createElement("span", { className: "deg_mc_card_route" }, card.provider)),
        row.error === undefined ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, row.error),
        react.createElement("label", { className: "deg_mc_field" },
          react.createElement("span", { className: "deg_mc_field_label" }, "API Key"),
          react.createElement("input", {
            className: "deg_mc_input",
            type: card.apiKey.type,
            autoComplete: card.apiKey.autoComplete,
            value: keyDraft,
            disabled: disabled || card.apiKey.disabled,
            "data-deg-api-key": row.provider,
            "aria-label": card.displayName + " API Key",
            placeholder: card.apiKey.placeholder,
            onChange: (event) => { setKeyDraft(event.target.value); session.typeKey(event.target.value); },
          })),
        react.createElement("p", { className: "deg_mc_hint" }, card.apiKey.hint),
        react.createElement("label", { className: "deg_mc_field" },
          react.createElement("span", { className: "deg_mc_field_label" }, "Base URL"),
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            value: card.baseUrl.value,
            disabled,
            placeholder: card.baseUrl.placeholder,
            "data-deg-base-url": row.provider,
            "aria-label": card.displayName + " Base URL",
            onChange: (event) => {
              const value = event.target.value;
              edit((draft) => {
                const next = { ...draft };
                if (value.trim().length === 0) Reflect.deleteProperty(next, "baseURL");
                else next.baseURL = value;
                return next;
              });
            },
          })),
        react.createElement("label", { className: "deg_mc_field" },
          react.createElement("span", { className: "deg_mc_field_label" }, "协议"),
          react.createElement("select", {
            className: "deg_mc_select",
            value: card.protocol.value,
            disabled,
            "data-deg-protocol": row.provider,
            "aria-label": card.displayName + " 协议",
            onChange: (event) => {
              const value = event.target.value;
              edit((draft) => {
                const next = { ...draft };
                if (value.length === 0) Reflect.deleteProperty(next, "api");
                else next.api = value;
                return next;
              });
            },
          }, card.protocol.options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label)))),

        react.createElement("div", { className: "deg_mc_models" },
          react.createElement("div", { className: "deg_mc_models_head" },
            react.createElement("span", { className: "deg_mc_models_title" }, "模型"),
            react.createElement("span", { className: "deg_mc_models_meta" }, card.modelCatalog.label),
            card.modelCatalog.canReset
              ? react.createElement("button", {
                type: "button",
                className: "deg_btn",
                disabled,
                "data-deg-reset-models": row.provider,
                onClick: () => {
                  session.resetModels();
                  setDraftRevision((value) => value + 1);
                  setExpandedRows(new Set());
                  setFetchState(null);
                  setSaved(false);
                  setError(null);
                },
              }, "恢复默认")
              : null,
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              disabled: disabled || card.actions.fetchModels === "disabled",
              "data-deg-fetch-models": row.provider,
              onClick: () => { void fetchModels(); },
            }, "获取模型")),
          card.models.length === 0
            ? react.createElement("p", { className: "deg_mc_hint" }, card.modelCatalog.emptyHint)
            : react.createElement("div", { className: "deg_mc_model" }, modelRows),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled,
            "data-deg-add-model": row.provider,
            onClick: () => edit((draft) => ({ ...draft, models: config.appendModelRow(session.modelRows) })),
          }, "添加模型"),
          fetchState?.error === null || fetchState?.error === undefined
            ? null
            : react.createElement("p", { className: "deg_mc_error", role: "alert" }, fetchState.error)
          ),
        error === null ? null : react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-card-error": row.provider }, error),
        conflict
          ? react.createElement("div", { className: "deg_mc_conflict" },
            react.createElement("p", { className: "deg_mc_error" }, "配置冲突：本卡片的修改未提交。"),
            react.createElement("div", { className: "deg_mc_conflict_actions" },
              react.createElement("button", {
                type: "button",
                className: "deg_btn",
                disabled: saving,
                onClick: async () => {
                  await host.refreshSettingsView();
                  cancel();
                },
              }, "重新打开（加载最新配置）")))
          : null,
        react.createElement("div", { className: "deg_mc_card_footer" },
          react.createElement("span", { className: "deg_mc_status deg_settings_status", role: "status" }, saved ? "已保存" : ""),
          react.createElement("button", { type: "button", className: "deg_btn", disabled: saving, onClick: () => { setOpen(false); cancel(); } }, "取消"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            disabled,
            "data-deg-apply": row.provider,
            onClick: () => { void apply(); },
          }, saving ? "应用中…" : "应用")),
        fetchState !== null && Array.isArray(fetchState.candidates)
          ? react.createElement(ModelDiscoveryDialog, {
            candidates: fetchState.candidates,
            query: candidateQuery,
            onQueryChange: setCandidateQuery,
            onToggle: toggleCandidate,
            onToggleVisible: toggleVisibleCandidates,
            onClose: closeModelPicker,
            onAdopt: adoptPicked,
          })
          : null);
    }
    /**
     * 弹窗标题 id 的自增序号。
     *
     * 同一个设置页可以同时挂载多个候选弹窗（例如两张 provider 卡片各自探测），
     * 每个实例的 `aria-labelledby` 必须指向**自己**的标题；共用一个字面量 id 会让
     * 后挂载的弹窗把无障碍名称解析到别人的标题上。
     *
     * 用模块级计数器 + 组件内惰性初始化，而不是 `react.useId`：本插件的 react 面
     * 在嵌入宿主与测试替身里都可能缺少 `useId`，计数器只依赖 useState/useRef 这类
     * 一直存在的 API。
     */
    let modelDiscoveryTitleSeq = 0;

    /**
     * 删除确认弹窗的身份序号。
     *
     * 一次确认从"待确认"到"进行中"、失败回退、成功关闭会经历多次状态更新；每次都按这个
     * 序号配对当前弹窗，**绝不**用一个会被自身更新换掉的旧对象引用来做身份比较——那样
     * 失败回退与成功关闭都会静默失效（弹窗永远停在"删除中…"），并发的后来者也会被误伤。
     */
    let removeConfirmSeq = 0;

    /**
     * 弹窗焦点环的候选控件：只保留真正可聚焦（启用且可见）的对话框控件。
     *
     * 判定只用声明式属性，不做布局测量（offsetParent 之类在嵌入宿主里不可靠）：
     * - `disabled` / `aria-disabled="true"` 的控件浏览器会忽略 focus 调用；
     * - `hidden` / `aria-hidden="true"` 的控件不参与 Tab 顺序。
     * 两者都必须从焦点环里剔除——否则 handler 先 preventDefault 再 focus 一个被忽略的
     * 元素，焦点会原地卡死或漏到背景页面。
     *
     * @param {unknown} scope 弹窗根节点（任何提供 querySelectorAll 的元素）
     * @returns {Array<{focus?: Function}>} 按 DOM 顺序排列的可聚焦控件
     */
    function focusableDialogControls(scope) {
      const nodes = Array.from(scope?.querySelectorAll?.("[data-deg-dialog-action]") ?? []);
      return nodes.filter((node) => {
        if (node === null || typeof node !== "object") return false;
        if (node.disabled === true) return false;
        if (node.hidden === true) return false;
        if (typeof node.getAttribute !== "function") return true;
        if (node.getAttribute("aria-disabled") === "true") return false;
        if (node.getAttribute("aria-hidden") === "true") return false;
        return true;
      });
    }

    /**
     * 候选弹窗「全选/取消全选」的纯函数语义（与 DSH 模型页的可见项切换一致）。
     *
     * 关键边界（不是"只动可见项"那么简单）：
     * - 当前可见候选**已全部勾选**时，切换等价于清空**全部**选择（含被搜索隐藏的候选）；
     * - 否则只把当前可见候选**追加**为已选，隐藏候选保留原有选择。
     *
     * 弹窗按钮文案与父卡片的实际改写都取自这一个判定，避免两处各自推断出不同语义。
     *
     * @param {Array<{id?: unknown, picked?: unknown}>} candidates 全部候选
     * @param {Set<unknown>} visibleIds 当前可见候选 id
     * @returns {boolean} true 表示"清空全部选择"，false 表示"只追加可见项"
     */
    function clearsAllCandidateSelection(candidates, visibleIds) {
      const list = Array.isArray(candidates) ? candidates : [];
      const wanted = visibleIds instanceof Set ? visibleIds : new Set();
      const visible = list.filter((candidate) => wanted.has(candidate?.id));
      return visible.length > 0 && visible.every((candidate) => candidate.picked === true);
    }

    /**
     * 自定义 provider 的可用模型选择弹窗：候选只进入当前草稿，不在探测成功时自动写 settings。
     *
     * 交互与 DSH 原生模型页保持一致：搜索当前候选、当前结果全选/取消全选、逐项勾选，
     * 最后由“添加所选”调用父卡片的 adoptModels 合并。弹窗关闭不会丢弃卡片里已有模型。
     *
     * 模态契约（与 DSH 内置 picker 的 Modal/useModalLayer 对齐）：
     * - 关闭按钮、点击遮罩、Escape 三条路径都只**关闭**弹窗（走 onClose），不改草稿、不采纳；
     * - 弹窗内 Tab / Shift+Tab 只在**真正可聚焦**（启用且可见）的控件之间循环，不把焦点
     *   漏到背景页面，也不会把焦点交给 disabled 的「添加所选」或空结果时的「全选」；
     * - 关闭（卸载）后把焦点还给打开弹窗前的那个元素；
     * - 标题 id 每个实例唯一，多个弹窗同时挂载时各自指向自己的标题。
     *
     * 焦点相关调用全部做能力探测：嵌入宿主（或测试替身）没有 document/focus 时静默跳过，
     * 绝不因为焦点不可用而让弹窗不可关闭。
     */
    function ModelDiscoveryDialog({ candidates, query, onQueryChange, onToggle, onToggleVisible, onClose, onAdopt }) {
      const source = Array.isArray(candidates) ? candidates : [];
      // 标题 id 每个实例唯一（惰性初始化只在首次渲染执行一次），dialog 的 aria-labelledby
      // 因此始终指向本实例自己的 h3。
      const [titleId] = react.useState(() => {
        modelDiscoveryTitleSeq += 1;
        return "deg-model-discovery-title-" + String(modelDiscoveryTitleSeq);
      });
      const dialogRef = react.useRef(null);
      // 打开前的焦点归属：只在挂载时读一次，卸载时原样还回去。
      const restoreTargetRef = react.useRef(typeof document === "undefined" ? null : document.activeElement ?? null);
      react.useEffect(() => () => {
        // 关闭（卸载）时恢复先前焦点；元素可能已从页面移除，因此 focus 缺失时直接跳过。
        const target = restoreTargetRef.current;
        try {
          if (target !== null && typeof target?.focus === "function") target.focus();
        } catch { /* 焦点不可用时保持弹窗关闭语义，不抛出。 */ }
      }, []);
      const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
      const visible = normalizedQuery.length === 0
        ? source
        : source.filter((candidate) => {
          const id = typeof candidate?.id === "string" ? candidate.id : "";
          const name = typeof candidate?.name === "string" ? candidate.name : "";
          return id.toLowerCase().includes(normalizedQuery) || name.toLowerCase().includes(normalizedQuery);
        });
      const visibleIds = new Set(visible.map((candidate) => candidate?.id));
      // 按钮文案与父卡片的改写必须同源：这里只用纯函数判定"这次切换是否清空全部选择"。
      const clearsAll = clearsAllCandidateSelection(source, visibleIds);
      const pickedCount = source.filter((candidate) => candidate.picked === true).length;
      const handleKeyDown = (event) => {
        if (event?.key === "Escape") {
          // 关闭是模态层的独占语义：阻止默认行为并停止冒泡，避免外层再处理同一个 Escape。
          event.preventDefault?.();
          event.stopPropagation?.();
          onClose();
          return;
        }
        if (event?.key !== "Tab") return;
        // 焦点环：与提示词弹窗同一套 data 标记与循环算法（首尾相接，Shift+Tab 反向），
        // 但候选集只取**真正可聚焦**的控件：disabled 的「添加所选」与无结果时的「全选」
        // 必须跳过，否则 preventDefault 之后 focus 一个被浏览器忽略的元素会让焦点卡死。
        const controls = focusableDialogControls(dialogRef.current);
        // 没有任何可聚焦控件时不拦截 Tab：宁可让焦点按浏览器默认行为走，也不把焦点锁死。
        if (controls.length === 0) return;
        const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
        const nextIndex = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current >= controls.length - 1 ? 0 : current + 1);
        event.preventDefault?.();
        try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击控件。 */ }
      };
      const list = visible.length === 0
        ? react.createElement("p", { className: "deg_mc_candidate_empty", role: "status" }, "没有匹配的模型")
        : react.createElement("ul", { className: "deg_mc_candidate_list" }, visible.map((candidate) => (
          react.createElement("li", { key: candidate.id, className: "deg_mc_candidate_item" },
            react.createElement("label", { className: "deg_mc_candidate_label" },
              react.createElement("input", {
                type: "checkbox",
                checked: candidate.picked === true,
                "data-deg-create-candidate": candidate.id,
                "data-deg-dialog-action": "candidate",
                "aria-label": "选择模型 " + candidate.id,
                onChange: () => onToggle(candidate.id),
              }),
              react.createElement("span", { className: "deg_mc_candidate_id" }, candidate.id))))));
      return react.createElement("div", {
        className: "deg_mc_modal_backdrop",
        // 点遮罩只关闭：候选状态与草稿都不受影响（采纳只能由“添加所选”触发）。
        onClick: () => onClose(),
      },
        react.createElement("div", {
          className: "deg_mc_modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": titleId,
          ref: dialogRef,
          onKeyDown: handleKeyDown,
          // 点弹窗内部不应冒泡到遮罩，避免误关。
          onClick: (event) => event?.stopPropagation?.(),
        },
          react.createElement("div", { className: "deg_mc_modal_header" },
            react.createElement("h3", { className: "deg_mc_modal_title", id: titleId }, "选择要添加的模型"),
            react.createElement("button", {
              type: "button",
              className: "deg_mc_modal_close",
              "aria-label": "关闭",
              "data-deg-dialog-action": "close",
              autoFocus: true,
              onClick: onClose,
            }, "×")),
          react.createElement("p", { className: "deg_mc_modal_description" }, "以下是模型提供方的可用模型，勾选要添加的模型。"),
          react.createElement("div", { className: "deg_mc_candidate_toolbar" },
            react.createElement("input", {
              className: "deg_mc_input deg_mc_candidate_search",
              type: "search",
              value: query,
              placeholder: "搜索模型",
              "aria-label": "搜索模型",
              "data-deg-dialog-action": "search",
              onChange: (event) => onQueryChange(event.target.value),
            }),
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              disabled: visible.length === 0,
              "data-deg-dialog-action": "toggle-visible",
              onClick: () => onToggleVisible(visible.map((candidate) => candidate.id)),
            }, clearsAll ? "取消全选" : "全选")),
          list,
          react.createElement("div", { className: "deg_mc_modal_footer" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              onClick: onClose,
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              disabled: pickedCount === 0,
              "data-deg-dialog-action": "adopt",
              onClick: onAdopt,
            }, "添加所选"))));
    }

    /**
     * 自定义 provider 创建卡片。
     *
     * 与 DSH 原生模型页的 CustomProviderCard 同层、同字段顺序（route id → 显示名 → Base URL
     * → 协议 → API Key → 模型），但不复制 DSH 源码：模型行复用 DEG 已有的模型草稿、容量、
     * 输入类型与七档 reasoning effort 语义。
     *
     * 提交是二阶段的：settings（profile）先写，API Key 再单独写 credentials。settings 成功后
     * 状态机把"profile 已写入"固定下来，因此 credentials 失败后的重试只重试 credentials。
     */
    function CustomProviderCard({ draft, protocols, host, onClose, onCreated, pageWritable, profileBasePath, directoryRows, liveRevision, fenceState }) {
      const [fetching, setFetching] = react.useState(false);
      const config = host.config;
      const [expandedRows, setExpandedRows] = react.useState(() => new Set());
      const [, setDraftRevision] = react.useState(0);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [errors, setErrors] = react.useState({});
      const [fetchState, setFetchState] = react.useState(null);
      const [candidateQuery, setCandidateQuery] = react.useState("");
      const schemaInfo = react.useMemo(() => {
        const info = host.settingsSchemaInfo("llm-pi-ai");
        return {
          ...info,
          protocols: config.protocolChoices(info.root, CUSTOM_ROUTE_PROBE, host.adapter, []),
        };
      }, [host, config]);
      const card = config.buildCustomCardModel({
        draft: draft.draft,
        protocols: Array.isArray(protocols) && protocols.length > 0 ? protocols : schemaInfo.protocols,
        errors,
        error,
        readOnly: pageWritable !== true,
        saving,
        submitted: draft.settingsCommitted,
        // 已提交时用状态机固定的引用，保证界面展示的引用与真正写凭据的一致。
        credentialRef: draft.credentialRef,
        defaultInput: schemaInfo.defaultInput,
        expandedRows,
      });
      const disabled = card.readOnly || saving;
      // 已提交后只允许重试 API Key：route 与凭据引用已经落盘，继续编辑会导致
      // "旧 profile + 新 route 的凭据"错配。其余字段与模型编辑统一禁用。
      //
      // fetching 一并锁定 profile：候选是用**点击那一刻**的 endpoint 参数探测出来的，
      // 请求在途时改 Base URL / 协议 / 模型行（或收起卡片丢弃草稿），就会让旧参数的
      // 结果被采纳进新配置。已有 provider 卡片用 saving 覆盖同一段窗口，这里保持同语义。
      const profileDisabled = card.profileLocked || saving || fetching;
      // 只同步已占用 route 词表；revision 由状态机一次性固定（rebase 内部只在 undefined 时初始化）。
      react.useEffect(() => {
        draft.rebase({
          takenRoutes: (Array.isArray(directoryRows) ? directoryRows : [])
            .map((row) => row.provider)
            .filter((id) => typeof id === "string"),
        });
      }, [draft, directoryRows]);

      // 一次提交前的栅栏处理：未贴出时用最新的 revision 纠正（覆盖"打开时 Describe 视图还没
      // 更新"）；贴出之后（用户已编辑或已有外部失效）保持陈旧栅栏，让宿主按 revision 语义拒绝。
      // 回调由父区域持有，卡片只负责在合适的时机通知。
      const fence = fenceState ?? { settled: true, external: true, epoch: 0 };
      const edit = (patch) => {
        draft.edit(patch);
        setDraftRevision((value) => value + 1);
        setErrors({});
        setError(null);
      };
      const modelRows = config.modelDraftsOf(draft.draft.models);
      const setModels = (models) => edit({ models });
       const customBaseURL = typeof draft.draft.baseURL === "string" ? draft.draft.baseURL.trim() : "";
       const canFetchModels = !card.readOnly && !profileDisabled && config.validateBaseUrl(customBaseURL) === null;
      const patchRow = (index, patch) => setModels(modelRows.map((model, at) => (
        at === index ? config.patchModelDraft(model, patch) : model
      )));
      const toggleRow = (index) => {
        setExpandedRows((previous) => {
          const next = new Set(previous);
          if (!next.delete(index)) next.add(index);
          return next;
        });
      };
      const closeModelPicker = () => {
         setFetchState(null);
         setCandidateQuery("");
       };
       const fetchModels = async () => {
         if (card.readOnly || profileDisabled) return;
         const current = draft.draft;
         const baseURL = typeof current.baseURL === "string" ? current.baseURL.trim() : "";
         if (config.validateBaseUrl(baseURL) !== null) {
           setFetchState({ error: "请先填写有效的 Base URL", candidates: null });
           return;
         }
         setFetching(true);
         setFetchState(null);
         setCandidateQuery("");
         try {
           const api = typeof current.api === "string" && current.api.length > 0 ? current.api : undefined;
           const apiKey = typeof current.apiKey === "string" ? current.apiKey.trim() : "";
           const answer = await host.operations.discoverModels(draft.settingsNs, {
             baseURL,
             ...(api === undefined ? {} : { api }),
             ...(apiKey.length === 0 ? {} : { apiKey }),
           });
           if (answer.kind === "refused") {
             setFetchState({ error: answer.message, candidates: null });
             return;
           }
           if (answer.models.length === 0) {
             setFetchState({ error: "该端点没有返回任何模型", candidates: null });
             return;
           }
           const known = new Set(config.modelDraftsOf(draft.draft.models)
             .map((model) => (typeof model.id === "string" ? model.id.trim() : ""))
             .filter((id) => id.length > 0));
           setFetchState({
             error: null,
             candidates: answer.models.map((model) => ({
               ...model,
               picked: typeof model.id === "string" && model.id.length > 0 && !known.has(model.id),
             })),
           });
         } finally {
           setFetching(false);
         }
       };
       const toggleCandidate = (id) => {
         setFetchState((previous) => previous === null || !Array.isArray(previous.candidates)
           ? previous
           : {
             ...previous,
             candidates: previous.candidates.map((candidate) => candidate.id === id
               ? { ...candidate, picked: candidate.picked !== true }
               : candidate),
           });
       };
       /**
        * 弹窗「全选/取消全选」的唯一实现（弹窗按钮文案也走同一个纯函数判定）。
        *
        * - 可见项已全选 → 清空**全部**选择（含被搜索隐藏的候选），与 DSH 模型页一致；
        * - 否则只把可见项追加为已选，隐藏候选保留原选择。
        */
       const toggleVisibleCandidates = (ids) => {
         const wanted = new Set(Array.isArray(ids) ? ids : []);
         setFetchState((previous) => {
           if (previous === null || !Array.isArray(previous.candidates)) return previous;
           if (clearsAllCandidateSelection(previous.candidates, wanted)) {
             return { ...previous, candidates: previous.candidates.map((candidate) => ({ ...candidate, picked: false })) };
           }
           return {
             ...previous,
             candidates: previous.candidates.map((candidate) => wanted.has(candidate.id)
               ? { ...candidate, picked: true }
               : candidate),
           };
         });
       };
       const adoptFetchedModels = () => {
         const candidates = fetchState?.candidates;
         const picked = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate.picked === true);
         edit({ models: config.adoptModels(config.modelDraftsOf(draft.draft.models), picked) });
         closeModelPicker();
       };

       const submit = async () => {
        if (disabled) return false;
        setSaving(true);
        setError(null);
        setErrors({});
        try {
          // 栅栏定稿：只在"还没定稿、也还没写盘"时用父区域读到的最新 revision 纠正一次。
          // 定稿之后（用户开始编辑、或第一次提交之后）mirror/load 的推进都不再改写它，
          // 因此并发写入仍然由宿主的 revision 语义拒绝，而不是被静默覆盖。
          // 栅栏纠正：只在还没有外部并发失效时，用父区域读到的最新 revision 纠正一次
          // （覆盖"打开时 Describe 视图还没更新"）。栅栏贴出之后到达的外部写入必须保持
          // 陈旧栅栏，让宿主按 revision 语义拒绝，绝不静默覆盖别人的写入。
          if (fence.external !== true && !draft.settingsCommitted && Number.isSafeInteger(liveRevision)) {
            draft.rebase({ revision: liveRevision });
          }
          // 首次提交即定稿：此后再来的 mirror/load 都不允许改写栅栏。
          draft.rebase({ frozen: true });
          fence.settled = true;
          const plan = draft.plan();
          if (plan.ok !== true) {
            setErrors(plan.errors ?? {});
            setError(plan.error);
            return false;
          }
          if (plan.phase === "settings") {
            // 本地 schema 先拦一道：把新 profile 放进它自己的路径下，用命名空间 schema
            // 校验整段候选（`{ providers: { <route>: profile } }`），正式 settings API 仍会
            // 在持久化边界再校验一次。
            const op = Array.isArray(plan.ops) ? plan.ops[0] : undefined;
            if (op !== undefined) {
              const sectionCandidate = config.setPath({}, profileBasePath, {
                [op.path[op.path.length - 1]]: op.value,
              });
              const failure = host.adapter.validate(schemaInfo.root, sectionCandidate);
              if (failure !== undefined) {
                setError("设置校验未通过，已拒绝写入：" + failure);
                return false;
              }
            }
            const written = await host.writeNamespace({
              ns: draft.settingsNs,
              ops: plan.ops,
              expectedRevision: plan.expectedRevision,
            });
            if (!written.ok) {
              setError(written.message);
              return false;
            }
            draft.acceptSettings(written.view, plan.credentialRef);
            setDraftRevision((value) => value + 1);
          }
          if (plan.keyValue !== undefined && plan.phase !== "done") {
            const stored = await host.operations.storeKey(plan.credentialRef, plan.keyValue);
            if (stored !== null) {
              // settings 已经写成功；这里只报告凭据失败，重试只重试 credentials。
              setError("provider 配置已保存，但 API Key 写入失败：" + stored);
              return false;
            }
            draft.acceptCredential();
            setDraftRevision((value) => value + 1);
          }
          await host.refreshSettingsView();
          onCreated();
          return true;
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        } finally {
          setSaving(false);
        }
      };

      const fieldMessage = (key) => (config.isNonEmptyString(card[key]?.error) ? react.createElement(
        "span",
        { className: "deg_mc_field_message", role: "alert", "data-deg-create-error": key },
        card[key].error,
      ) : null);

      return react.createElement("div", { className: "deg_mc_create", "data-deg-custom-provider": "true" },
        react.createElement("div", { className: "deg_mc_create_head" },
          react.createElement("span", { className: "deg_mc_create_title" }, card.title)),
        react.createElement("label", { className: "deg_mc_field_row" },
          react.createElement("span", { className: "deg_mc_field_label" }, "路由 ID"),
          react.createElement("input", {
            className: "deg_mc_input" + (card.routeId.error === null ? "" : " deg_mc_field_error"),
            type: "text",
            value: card.routeId.value,
            disabled: profileDisabled,
            placeholder: "例如 my-gateway",
            "data-deg-create-route": "true",
            "aria-label": "自定义 provider 路由 ID",
            onChange: (event) => edit({ routeId: event.target.value }),
          }),
          card.routeId.credentialRef.length === 0
            ? null
            : react.createElement("span", { className: "deg_mc_hint" }, "凭据引用：" + card.routeId.credentialRef),
          fieldMessage("routeId")),
        react.createElement("label", { className: "deg_mc_field_row" },
          react.createElement("span", { className: "deg_mc_field_label" }, "显示名"),
          react.createElement("input", {
            className: "deg_mc_input" + (card.displayName.error === null ? "" : " deg_mc_field_error"),
            type: "text",
            value: card.displayName.value,
            disabled: profileDisabled,
            placeholder: "留空则使用路由 ID",
            "data-deg-create-name": "true",
            "aria-label": "自定义 provider 显示名",
            onChange: (event) => edit({ displayName: event.target.value }),
          }),
          fieldMessage("displayName")),
        react.createElement("label", { className: "deg_mc_field_row" },
          react.createElement("span", { className: "deg_mc_field_label" }, "Base URL"),
          react.createElement("input", {
            className: "deg_mc_input" + (card.baseUrl.error === null ? "" : " deg_mc_field_error"),
            type: "text",
            value: card.baseUrl.value,
            disabled: profileDisabled,
            placeholder: card.baseUrl.placeholder,
            "data-deg-create-base-url": "true",
            "aria-label": "自定义 provider Base URL",
            onChange: (event) => edit({ baseURL: event.target.value }),
          }),
          fieldMessage("baseUrl")),
        react.createElement("label", { className: "deg_mc_field_row" },
          react.createElement("span", { className: "deg_mc_field_label" }, "协议"),
          react.createElement("select", {
            className: "deg_mc_select" + (card.protocol.error === null ? "" : " deg_mc_field_error"),
            value: card.protocol.value,
            disabled: profileDisabled,
            "data-deg-create-protocol": "true",
            "aria-label": "自定义 provider 协议",
            onChange: (event) => edit({ api: event.target.value }),
          },
            react.createElement("option", { value: "" }, "选择协议"),
            card.protocol.options.map((option) => react.createElement("option", { key: option.value, value: option.value }, option.label))),
          fieldMessage("api")),
        react.createElement("label", { className: "deg_mc_field_row" },
          react.createElement("span", { className: "deg_mc_field_label" }, "API Key"),
          react.createElement("input", {
            className: "deg_mc_input",
            type: card.apiKey.type,
            autoComplete: card.apiKey.autoComplete,
            value: card.apiKey.value,
            disabled: disabled || card.apiKey.disabled,
            placeholder: card.apiKey.placeholder,
            "data-deg-create-api-key": "true",
            "aria-label": "自定义 provider API Key",
            onChange: (event) => edit({ apiKey: event.target.value }),
          }),
          react.createElement("span", { className: "deg_mc_hint" }, "API Key 只写入 credentials 服务，不进入 settings 快照，保存后不回显明文。")),
        react.createElement("div", { className: "deg_mc_models" },
          react.createElement("div", { className: "deg_mc_models_head" },
            react.createElement("span", { className: "deg_mc_models_title" }, "模型"),
            react.createElement("span", { className: "deg_mc_models_meta" }, "至少配置一个模型"),
             react.createElement("button", {
               type: "button",
               className: "deg_btn",
               disabled: !canFetchModels || fetching,
               "data-deg-create-fetch-models": "true",
               onClick: () => { void fetchModels(); },
             }, fetching ? "获取中…" : "获取可用模型")),
          card.models.length === 0
            ? react.createElement("p", { className: "deg_mc_hint" }, "还没有模型。")
            : react.createElement("div", { className: "deg_mc_model" }, card.models.map((model) => react.createElement("div", {
              key: "create-model-" + String(model.index),
              className: "deg_mc_model",
              "data-deg-create-model-index": model.index,
            },
              react.createElement("div", { className: "deg_mc_model_main" },
                react.createElement("input", {
                  className: "deg_mc_input",
                  type: "text",
                  value: model.id.value,
                  placeholder: "模型 ID",
                  disabled: profileDisabled,
                  "data-deg-create-model-id": model.index,
                  "aria-label": "自定义 provider 模型 ID " + String(model.position),
                  onChange: (event) => patchRow(model.index, { id: event.target.value }),
                }),
                react.createElement("input", {
                  className: "deg_mc_input",
                  type: "text",
                  value: model.name.value,
                  placeholder: "显示名",
                  disabled: profileDisabled,
                  "aria-label": "自定义 provider 模型显示名 " + String(model.position),
                  onChange: (event) => patchRow(model.index, { name: event.target.value }),
                }),
                react.createElement("button", {
                  type: "button",
                  className: "deg_btn deg_mc_icon_btn",
                  "aria-label": "模型高级设置 " + String(model.position),
                  "aria-expanded": model.advancedOpen,
                  onClick: () => toggleRow(model.index),
                }, model.advancedOpen ? "▾" : "▸"),
                react.createElement("button", {
                  type: "button",
                  className: "deg_btn deg_mc_icon_btn",
                  "aria-label": "删除模型 " + String(model.position),
                  disabled: profileDisabled,
                  onClick: () => setModels(config.removeModelRow(modelRows, model.index)),
                }, "✕")),
              model.advancedOpen ? react.createElement("div", { className: "deg_mc_model_advanced" },
                react.createElement("label", { className: "deg_mc_field" },
                  react.createElement("span", { className: "deg_mc_field_label" }, "上下文窗口"),
                  react.createElement("input", {
                    className: "deg_mc_input",
                    type: "text",
                    inputMode: "numeric",
                    value: model.contextWindow.value,
                    placeholder: model.contextWindow.placeholder,
                    disabled: profileDisabled,
                    "aria-label": "上下文窗口 " + String(model.position),
                    onChange: (event) => patchRow(model.index, { contextWindow: config.parseCapacity(event.target.value) }),
                  })),
                react.createElement("label", { className: "deg_mc_field" },
                  react.createElement("span", { className: "deg_mc_field_label" }, "最大输出 token"),
                  react.createElement("input", {
                    className: "deg_mc_input",
                    type: "text",
                    inputMode: "numeric",
                    value: model.maxTokens.value,
                    placeholder: model.maxTokens.placeholder,
                    disabled: profileDisabled,
                    "aria-label": "最大输出 token " + String(model.position),
                    onChange: (event) => patchRow(model.index, { maxTokens: config.parseCapacity(event.target.value) }),
                  })),
                react.createElement("fieldset", { className: "deg_mc_efforts" },
                  react.createElement("legend", { className: "deg_mc_efforts_label" }, "思考档位（可多选）"),
                  react.createElement("div", { className: "deg_mc_efforts_row" },
                    model.efforts.map((effort) => react.createElement("label", {
                      key: effort.level,
                      className: "deg_mc_effort",
                    }, react.createElement("input", {
                      type: "checkbox",
                      checked: effort.checked,
                      disabled: profileDisabled,
                      "data-deg-effort": effort.level,
                      "data-deg-model-index": model.index,
                      "aria-label": "模型 " + String(model.position) + " 思考档位 " + effort.level,
                      onChange: () => {
                        const selection = config.effortSelectionFor(modelRows[model.index]);
                        setModels(config.setModelEffortSelection(
                          modelRows,
                          model.index,
                          { ...selection, [effort.level]: selection[effort.level] !== true },
                        ));
                      },
                    }), react.createElement("span", null, effort.level))))),
                react.createElement("fieldset", { className: "deg_mc_efforts" },
                  react.createElement("legend", { className: "deg_mc_efforts_label" }, "输入类型"),
                  react.createElement("div", { className: "deg_mc_input_types" },
                    model.inputs.map((input) => react.createElement("label", {
                      key: input.modality,
                      className: "deg_mc_effort",
                    }, react.createElement("input", {
                      type: "checkbox",
                      checked: input.checked,
                      disabled: profileDisabled || input.locked === true,
                      "data-deg-input": input.modality,
                      "data-deg-model-index": model.index,
                      "aria-label": "模型 " + String(model.position) + " 输入类型 " + input.modality,
                      onChange: () => {
                        const selected = config.modelInputOf(modelRows[model.index], schemaInfo.defaultInput);
                        const next = selected.includes(input.modality)
                          ? selected.filter((value) => value !== input.modality)
                          : [...selected, input.modality];
                        setModels(config.setModelInputSelection(modelRows, model.index, next));
                      },
                    }), react.createElement("span", null, input.modality))))))
                : null))),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: profileDisabled,
            "data-deg-create-add-model": "true",
            onClick: () => setModels(config.appendModelRow(modelRows)),
          }, "添加模型"),
          config.isNonEmptyString(card.modelsError)
            ? react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-error": "models" }, card.modelsError)
            : null),
        config.isNonEmptyString(fetchState?.error)
           ? react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-fetch-error": "true" }, fetchState.error)
           : null,
         card.error === null || card.modelsError === card.error
          ? null
          : react.createElement("p", { className: "deg_mc_error", role: "alert", "data-deg-create-card-error": "true" }, card.error),
        react.createElement("div", { className: "deg_mc_create_footer" },
          react.createElement("span", { className: "deg_mc_status deg_settings_status", role: "status" },
            card.submitted ? "配置已保存" : ""),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            // 发现请求在途时同样禁止取消：取消会丢弃草稿并收起卡片，而响应仍会回来，
            // 与 profile 锁定一起构成"在途期间不改变 endpoint 与草稿归属"的同一条边界。
            disabled: saving || fetching,
            "data-deg-create-cancel": "true",
            onClick: () => { onClose(draft.settingsCommitted); },
          }, "取消"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            disabled,
            "data-deg-create-submit": "true",
            onClick: () => { void submit(); },
          }, saving ? "创建中…" : (card.submitted ? "重试保存 API Key" : "创建")),
         fetchState !== null && Array.isArray(fetchState.candidates)
           ? react.createElement(ModelDiscoveryDialog, {
             candidates: fetchState.candidates,
             query: candidateQuery,
             onQueryChange: setCandidateQuery,
             onToggle: toggleCandidate,
             onToggleVisible: toggleVisibleCandidates,
             onClose: closeModelPicker,
             onAdopt: adoptFetchedModels,
           })
           : null));
    }

    // ── 删除 provider 之后的「区域内」焦点归还 ─────────────────────────────────
    //
    // 用户报告：在设置页删除一张 provider 卡片后，键盘焦点落回页面根，紧随其后的 DSH
    // 主输入框光标也随之消失。修复的边界是**只把焦点还给 DEG 区域内的稳定控件**。
    //
    // 这些边界是修复的一部分，不是实现细节：
    // - DEG **绝不**访问、也绝不 focus 宿主的任何控件（尤其是 DSH 主输入框）：那是宿主
    //   自己的焦点管理，插件越界只会制造新的抢焦点问题；
    // - 只有四个条件同时成立才尝试一次自己的恢复：
    //   ① 点击删除按钮那一刻焦点就在这个按钮上（这次交互确实来自 DEG 卡片），且这次读取
    //      **成功**——读面抛错只是"归属未知"，未知不得 arm；
    //   ② 用户接受了原生 confirm；
    //   ③ settings 里的 provider 配置删除成功（凭据阶段与写入阶段的失败都不算）；
    //   ④ 删除成功后的目录/视图刷新**整个加载事务**已经结算：`await load()` 等到的不只是
    //      自己那一轮，还包括在同一轮里被合并进来的所有尾随重跑。早一步恢复，随后的尾随
    //      React 更新就会把焦点又打回根节点（这正是本波修掉的时序缺陷）。
    //   于是"确认取消""角色联动守卫拦截""凭据删除失败""settings 写入失败"四条路径都不
    //   恢复焦点，与既有语义完全一致；
    // - 异步窗口（凭据 / settings / 刷新都可能长时间 pending）里在 document 捕获阶段观察
    //   pointerdown / keydown / focusin：任何用户或宿主动作把意图移走（例如用户点回 DSH
    //   输入框继续打字）都会把本次恢复标记为 abandoned，收尾时不再抢焦点；
    // - 恢复目标只在**点击时捕获的作用域**内查询（`trigger.closest(".deg_mc_section")`），
    //   绝不 document 全局查询：宿主输入框不可能被这里选中；
    // - 作用域或目标缺失、DOM 读面失败、目标已断开、hidden/disabled/aria-disabled、没有
    //   渲染矩形时静默跳过（并继续尝试下一个候选）：焦点问题绝不影响删除结果（删除已经
    //   写盘，不能因为焦点读面异常而变成失败）。

    /** 恢复目标优先级：「添加提供方」入口优先，回退到稳定的折叠区标题。 */
    const REMOVE_FOCUS_TARGET_SELECTORS = Object.freeze([
      '[data-deg-add-provider="true"]',
      '[data-deg-model-config-toggle="true"]',
    ]);

    /** 运行期 document；没有 DOM（Node、裁剪过的宿主替身）时返回 null。 */
    function removeFocusDocument() {
      return typeof document === "undefined" ? null : (document ?? null);
    }

    /**
     * 读取当前持有焦点的元素。
     *
     * 读面的**三个状态必须分开表达**，只有中间那一种是"成功"：
     * - `activeElement` 明确返回 **null**：这是**已知的空焦点**（浏览器在没有焦点、或焦点
     *   落到 body / 页面根时给出的就是 null）。`ok === true`，收尾按"焦点仍停在原处"继续；
     * - 属性**不存在**，或 getter 返回 **undefined**：读面没有给出答案，是**未知**，
     *   `ok === false`。这**不是**空焦点：宿主替身 / 被裁剪的宿主压根没有这个读面时，
     *   `undefined` 只说明"读不到"；
     * - getter **抛错**：同样是未知，`ok === false`。
     *
     * 后两种曾被 `documentStub.activeElement ?? null` 折叠成"成功读到 null"：同一次删除流程
     * 里点击那一刻读到真实删除按钮、收尾时读面退化成 undefined 的非标准宿主，因此会在收尾
     * 把**未知**当成**已知的空焦点**，把焦点抢回 DEG 区域——正是"插件越过自己边界动焦点"
     * 那类事故。所以这里不能再做 nullish 合并，只有显式 null 才允许收尾继续。
     * 同一次删除里点击那一刻的读取失败也必须阻止 arm，否则一条无法证明归属的流程会在收尾
     * 时把焦点搬走。因此这里返回读结果对象，失败用 `ok === false` 显式表达，调用方各自决定跳过。
     */
    function readFocusedElement(documentStub) {
      if (documentStub === null || documentStub === undefined) return { ok: false, element: null };
      try {
        // 用 `in` 走**原型链**探测"这个宿主到底有没有焦点读面"：真实 document 的
        // activeElement 是 Document.prototype 上的继承访问器，任何 own-property 限定
        // （hasOwnProperty / 只认数据属性）都会把真实 DOM 判成"没有读面"，让整条恢复路径
        // 静默失效。Proxy / 被裁剪的宿主连 `in` 都可能抛错：那属于"读面归属未知"，
        // 与"读面存在但没有答案"同样按失败处理（宁可不恢复，也不猜）。
        if (!("activeElement" in documentStub)) return { ok: false, element: null };
        const element = documentStub.activeElement;
        // 读面给出 undefined = 没有答案（未知），绝不能当作空焦点。
        if (element === undefined) return { ok: false, element: null };
        return { ok: true, element };
      } catch {
        return { ok: false, element: null };
      }
    }

    /**
     * 捕获作用域：删除按钮所在的 DEG 区域。
     *
     * 必须在**点击时**捕获而不是收尾时再算：删除成功的刷新会给所有卡片换 key，原按钮
     * 届时已从页面摘除，它的祖先链随之断开，事后再 closest 只会得到 null。
     */
    function closestRemoveFocusScope(trigger) {
      if (trigger === null || typeof trigger.closest !== "function") return null;
      try {
        return trigger.closest(".deg_mc_section") ?? null;
      } catch {
        return null;
      }
    }

    /**
     * 布局可见性的保守判定：读得到就读，读不到就不猜。
     *
     * 这里**不能**再用 `hasOwnProperty("offsetParent")`：真实浏览器里 offsetParent 定义在
     * `HTMLElement.prototype` 上，own property 探测恒为 false——这条判定在真实 DOM 上从未
     * 生效过；而换成 `offsetParent !== null` 又会把 fixed 定位元素（offsetParent 本来就是
     * null）误杀。两个真实可用的读面都按"有读面才判定"处理：
     * - `checkVisibility({ visibilityProperty: true })`：一次覆盖 display:none、visibility 与
     *   content-visibility。options 必须显式给出：`checkVisibility()` 的默认语义**只**看元素
     *   是否渲染，被 CSS `visibility: hidden` 藏起来的控件仍然参与排版、仍然会被判为可见，
     *   恢复焦点就会交给一个用户看不见的控件。宿主实现若不认识 options 而抛错，异常会被
     *   下面的 catch 吞掉并退到 getClientRects，不会连累删除结果；
     * - `getClientRects()`：零渲染矩形（未排版 / display:none）说明元素没有盒子，
     *   而 fixed 定位元素同样有渲染矩形，因此合法目标不会被误杀。
     * 无布局引擎的替身/宿主两个读面都读不到时保持"不做无根据的判定"，避免整体误杀恢复能力。
     */
    function isLaidOutRemoveFocusTarget(element) {
      if (typeof element.checkVisibility === "function") {
        try {
          // 必须带 options：默认调用不看 CSS visibility 属性（见上方边界说明）。
          if (element.checkVisibility({ visibilityProperty: true }) === false) return false;
        } catch { /* 读面抛错：交给下一个读面，不做无根据的判定。 */ }
      }
      if (typeof element.getClientRects === "function") {
        try {
          const rects = element.getClientRects();
          // DOMRectList 与数组都有 length；读面给出非列表值时同样不做无根据的判定。
          if (rects !== null && rects !== undefined && typeof rects.length === "number" && rects.length === 0) return false;
        } catch { /* 同上。 */ }
      }
      return true;
    }

    /**
     * 目标可用性的保守判定：断开、隐藏、disabled、aria-disabled 或没有渲染矩形一律不可用。
     */
    function isUsableRemoveFocusTarget(element) {
      if (element === null || typeof element !== "object") return false;
      // focus() 缺失（裁剪过的元素替身）时不尝试：恢复焦点绝不允许抛错。
      if (typeof element.focus !== "function") return false;
      // isConnected 在真实 DOM 上恒为布尔；读面缺失时按"不可用"处理，宁可不恢复也不猜。
      if (element.isConnected !== true) return false;
      if (element.hidden === true) return false;
      if (element.disabled === true) return false;
      const ariaDisabled = typeof element.getAttribute === "function"
        ? element.getAttribute("aria-disabled")
        : element["aria-disabled"];
      if (ariaDisabled === "true" || ariaDisabled === true) return false;
      if (!isLaidOutRemoveFocusTarget(element)) return false;
      return true;
    }

    /** 在作用域内按优先级挑一个恢复目标；一个都不可用时返回 null。 */
    function pickRemoveFocusTarget(scope) {
      if (scope === null || typeof scope.querySelector !== "function") return null;
      for (const selector of REMOVE_FOCUS_TARGET_SELECTORS) {
        let candidate = null;
        try {
          candidate = scope.querySelector(selector);
        } catch {
          candidate = null;
        }
        if (isUsableRemoveFocusTarget(candidate)) return candidate;
      }
      return null;
    }

    /**
     * 一次删除期间的"焦点意图"观察器。
     *
     * document 捕获阶段的 pointerdown / keydown / focusin 任一命中即把本次恢复标记为
     * abandoned（用户或宿主已经把意图移到别处）。`dispose()` 幂等：调用方必须在提前返回、
     * 异常与成功路径上都调用它，ModelConfigSection 卸载时还会再兜一次——删除流程里有多个
     * await，远端 Promise 可能长时间不结算，全局监听绝不能留在页面上。
     */
    function observeRemoveFocusIntent(documentStub) {
      const events = ["pointerdown", "keydown", "focusin"];
      const registered = [];
      let abandoned = false;
      let disposed = false;
      const markAbandoned = () => { abandoned = true; };
      if (documentStub !== null && typeof documentStub.addEventListener === "function") {
        for (const type of events) {
          try {
            // capture=true：即使宿主在冒泡阶段 stopPropagation，也必须看到这次操作。
            documentStub.addEventListener(type, markAbandoned, true);
            registered.push(type);
          } catch { /* 登记失败：少观察一类事件，不影响删除语义。 */ }
        }
      }
      return {
        isAbandoned: () => abandoned,
        dispose() {
          if (disposed) return;
          disposed = true;
          if (documentStub === null || typeof documentStub.removeEventListener !== "function") return;
          for (const type of registered) {
            try {
              documentStub.removeEventListener(type, markAbandoned, true);
            } catch { /* 摘监听失败：监听随页面销毁一起消失，不影响删除结果。 */ }
          }
          registered.length = 0;
        },
      };
    }

    /**
     * 在途焦点意图观察器的账本（每个删除流程各拥有自己那一条）。
     *
     * 为什么必须由组件持有而不是各流程自己记：删除流程里有多个 await，远端 Promise 可能
     * 长时间不结算，捕获监听绝不能留在页面上，所以卸载时必须有一个统一的兜底口。
     *
     * 三条不变量：
     * ① 集合在**首个渲染期**（useRef 初始化）就建立，绝不等到 passive effect 才赋值——
     *    真实 React 的 passive effect 在提交之后异步执行，删除流程完全可能在它之前就登记，
     *    那样的登记会落进 null 而永远无人清理（等价于把捕获监听永久留在 document 上）；
     * ② 重叠的删除各自只移除自己那一条（`delete` 按对象身份，与顺序无关），单槽位账本
     *    会在双击删除时漏掉先发起的那条；
     * ③ 卸载即 `close()`：关闭后到达的登记**当场自我清理**，绝不允许再出现无人认领的监听。
     *    因此 `delete`/`close` 与 `dispose` 一样必须幂等。
     */
    function createRemoveFocusObservationLedger() {
      const observations = new Set();
      let closed = false;
      return {
        add(observation) {
          if (observation === null || observation === undefined) return;
          if (closed) {
            // 账本已随卸载关闭：这条登记没有任何人去摘它，只能当场清理。
            observation.dispose();
            return;
          }
          observations.add(observation);
        },
        /** 某次流程自己认领的观察器收尾：与卸载兜底摘的是同一条，dispose 幂等。 */
        delete(observation) {
          observations.delete(observation);
        },
        close() {
          if (closed) return;
          closed = true;
          for (const observation of observations) observation.dispose();
          observations.clear();
        },
      };
    }

    /**
     * 成功路径的收尾：先摘观察器，再按优先级还一次焦点。
     *
     * 前置条件缺一不可——作用域仍在页面上、意图没被移走、焦点仍停在原处（原按钮 / body /
     * 空）。任何读面缺失或 focus() 抛错都只让这次恢复静默跳过：删除已经写盘，焦点问题
     * 绝不允许改变删除结果。
     */
    function restoreRemoveFocus({ documentStub, trigger, scope, observation }) {
      // 整段包在 try 里：焦点读面/写面（activeElement、getAttribute、focus）在任何宿主
      // 实现上都可能抛错，而删除已经写盘——焦点问题绝不允许改变删除结果。
      try {
        if (documentStub === null || trigger === null || scope === null) return;
        if (observation?.isAbandoned?.() === true) return;
        // 区域必须仍挂在页面上：整块设置页被卸载或替换时不再恢复任何焦点。
        if (scope.isConnected !== true) return;
        // 收尾这一次读取失败 = 当前焦点归属**未知**：安全跳过，绝不猜测。
        const focusRead = readFocusedElement(documentStub);
        if (focusRead.ok !== true) return;
        const active = focusRead.element;
        const body = documentStub.body ?? null;
        // 只有焦点仍"停在原处"（原按钮 / body / 已知的空焦点）才恢复：用户已经点/切到
        // 别处（例如 DSH 输入框）时绝不抢回来。
        if (active !== null && active !== trigger && active !== body) return;
        const target = pickRemoveFocusTarget(scope);
        if (target === null) return;
        target.focus();
      } catch { /* 焦点不可用时保持删除结果不变。 */ }
    }

    /**
     * 折叠的「模型配置」区域。
     *
     * 默认折叠时不读取 provider 目录；展开后读取 provider 目录、凭据状态与 settings 命名空间；
     * 卡片各自独立应用/取消，区域本身不提供任何保存按钮，角色配置的保存按钮与既有行为不变。
     * 组件由设置页标题后立即挂载，模型配置先于下方角色表显示。
     */
    function ModelConfigSection({ host, roleDefaults, roleLabelOf }) {
      const config = host.config;
      const [open, setOpen] = react.useState(false);
      const [directory, setDirectory] = react.useState({ status: "idle", rows: [], error: null });
      const [adding, setAdding] = react.useState(false);
      const [addChoice, setAddChoice] = react.useState("");
      const [settingsError, setSettingsError] = react.useState(null);
      /**
       * 删除确认状态（DEG 自渲染的非阻塞弹窗，见 openRemoveConfirm / removeConfirmDialog）。
       *
       * 为什么不是原生 confirm：同步 `globalThis.confirm()` 会阻塞浏览器事件循环，弹窗存续
       * 期间页面脚本、遮罩与宿主（DSH 会话输入框）的输入处理全部停摆，用户看到的就是
       * "设置页与 DSH 会话输入框随后都不可用，重启才恢复"。DEG 因此自己渲染确认层，
       * 任何阶段都不再调用同步原生 confirm。
       */
      const [removeIntent, setRemoveIntent] = react.useState(null);
      // 宿主替身/host 对象自身不触发渲染，因此每次重新读取宿主视图时手动推进一个版本号，
      // 让 provider 卡片拿到最新的 user 层与 revision（而不是首次渲染时的那一份）。
      const [viewRevision, setViewRevision] = react.useState(0);
      const [hostRevision, setHostRevision] = react.useState(() => (
        typeof host.getSnapshot === "function" ? host.getSnapshot() : 0
      ));
      // 外部失效版本单独保存：区域的加载 effect 只依赖它。主动 load 会重读宿主视图并推进
      // hostRevision（memo 需要），但绝不再推进这里的计数，因此刷新不会自激。
      const [hostInvalidation, setHostInvalidation] = react.useState(() => (
        typeof host.getInvalidation === "function" ? host.getInvalidation() : 0
      ));
      react.useEffect(() => {
        if (typeof host.subscribe !== "function") return undefined;
        return host.subscribe(() => {
          setHostRevision((previous) => (
            typeof host.getSnapshot === "function" ? host.getSnapshot() : previous + 1
          ));
          setHostInvalidation((previous) => (
            typeof host.getInvalidation === "function" ? host.getInvalidation() : previous + 1
          ));
        });
      }, [host]);
      // 「已配置 / 可添加」的划分走同一份纯函数（用户层存在该 profile 才算已配置）；
      // viewRevision 让宿主视图刷新后重新划分。
      const providerSections = react.useMemo(() => config.providerListSections(
        directory.rows,
        (ns) => host.namespaceView(ns),
      ), [config, host, directory.rows, viewRevision, hostRevision]);
      // 自定义 provider 的协议来自宿主 schema 的 `providers.<route>.api` 联合类型；
      // 用一个探针 route 读出词表（DSH 的设置页也是从同一份 schema 读协议选项）。
      const customNamespace = host.namespaceView(CUSTOM_PROVIDER_NS);
      const customSchemaInfo = react.useMemo(
        () => host.settingsSchemaInfo(CUSTOM_PROVIDER_NS),
        [host, hostRevision],
      );
      const customProtocols = react.useMemo(
        () => (config.isPlainObject(customNamespace)
          ? config.protocolChoices(customSchemaInfo.root, CUSTOM_ROUTE_PROBE, host.adapter, [])
          : []),
        [config, customSchemaInfo, host.adapter, customNamespace],
      );
      const pageWritable = host.readView().writable === true;
      // 创建卡片的状态机与卡片本身同生命周期：打开入口时读一次 namespace，并用那一刻的
      // revision 作为 CAS 栅栏新建草稿；route 候选词表则随时刷新。
      //
      // revision 的漂移规则（两个方向都必须防）：
      // - Describe 视图在打开那一刻可能还没读到/已经过期（refreshSettingsView 是异步的），
      //   用陈旧栅栏会让每一次正常提交都被宿主误判成并发冲突；因此在**第一次提交之前**，
      //   允许用父区域读到的最新 revision 纠正一次。
      // - 栅栏贴出之后才到达的外部写入（mirror 事件）是真正的并发：此时绝不能自动跟随，
      //   否则会静默覆盖别人的写入。这种情况保持陈旧栅栏，由宿主按 revision 语义拒绝。
      const [customOpen, setCustomOpen] = react.useState(false);
      const [customDraft, setCustomDraft] = react.useState(null);
      const customFence = react.useRef({ settled: false, external: false, epoch: 0, openedAt: 0 });
      const openCustomProvider = () => {
        customFence.current = {
          settled: false,
          external: false,
          epoch: 0,
          openedAt: typeof host.getInvalidation === "function" ? host.getInvalidation() : 0,
        };
        if (typeof host.refreshSettingsView === "function") void host.refreshSettingsView();
        const namespace = host.namespaceView(CUSTOM_PROVIDER_NS);
        if (!config.isPlainObject(namespace) || !pageWritable) return;
        setAdding(false);
        setAddChoice("");
        setCustomDraft(config.createCustomProviderDraft({
          settingsNs: CUSTOM_PROVIDER_NS,
          profileBasePath: [...CUSTOM_PROFILE_BASE_PATH],
          revision: namespace.revision,
          protocols: config.protocolChoices(
            host.settingsSchemaInfo(CUSTOM_PROVIDER_NS).root,
            CUSTOM_ROUTE_PROBE,
            host.adapter,
          ),
          takenRoutes: directory.rows.map((row) => row.provider).filter((id) => typeof id === "string"),
          models: [],
        }));
        setCustomOpen(true);
      };
      // 栅栏打开之后到达的每一次外部失效才记一笔：提交时据此判断"revision 变化是不是并发"。
      // 打开那一刻的计数是基线，因此卡片刚挂载时不会误判成并发。
      react.useEffect(() => {
        if (!customOpen || customDraft === null) return;
        if (hostInvalidation <= customFence.current.openedAt) return;
        customFence.current.external = true;
        customFence.current.epoch += 1;
      }, [customOpen, customDraft, hostInvalidation]);
      // 栅栏尚未贴出（打开时 namespace 还没读到）：补一次初始化，之后按上面的规则冻结。
      react.useEffect(() => {
        if (!customOpen || customDraft === null) return;
        if (typeof customDraft.revision === "number") return;
        const namespace = host.namespaceView(CUSTOM_PROVIDER_NS);
        if (config.isPlainObject(namespace)) customDraft.rebase({ revision: namespace.revision });
      }, [config, customOpen, customDraft, customNamespace, hostRevision]);
      // 折叠区的渲染面由纯函数给出（标题、默认折叠、动作可用性）：界面与测试共用同一份判定。
      const section = config.buildSectionModel({
        open,
        status: directory.status,
        error: settingsError ?? directory.error,
        writable: pageWritable,
        configured: providerSections.configured,
        addable: providerSections.addable,
        protocols: customProtocols,
        canCreateCustom: config.canCreateCustomProvider({
          namespace: customNamespace,
          protocols: customProtocols,
          writable: pageWritable,
        }),
      });
      // 加载 effect 只依赖 open 与**外部失效**版本：主动 load 内部会 refreshSettingsView()，
      // 若这里依赖"任意视图版本"就会形成 load -> refresh -> notify -> load 的无限环。
      //
      // 并发用一个"尾随重跑"标记收口：正在加载时到来的请求不会并发跑两次，但一定会在
      // 当前这轮结束后再跑一轮，因此调用方（例如取消半完成创建的卡片）拿到的始终是新视图。
      //
      // 事务语义（删除后的焦点归还依赖它）：`running` 期间到达的每一次调用都返回**同一个**
      // 覆盖「当前轮 + 所有 again 尾随重跑」的 Promise。删除流程 `await load()` 因此会一直
      // 等到最后一轮结算，焦点恢复不会落在尾随轮次的 React 更新之前（那会把焦点又打回根节点）。
      // 少返回一次这个 Promise（例如直接 `return Promise.resolve()`）就等于把"刷新完成"提前
      // 宣布，这正是本波要修掉的时序缺陷。
      const loadStateRef = react.useRef({ running: false, again: false, promise: null });
      const runLoad = react.useCallback(async () => {
        setDirectory((previous) => ({ ...previous, status: "loading", error: null }));
        setSettingsError(null);
        try {
          const rows = await host.operations.listProviderDirectory();
          await host.refreshSettingsView();
          const refs = rows
            .filter((row) => config.providerEditable(row, host.namespaceView(row.settingsNs)))
            .map((row) => config.credentialRefOf(row, host.namespaceView(row.settingsNs)));
          await host.operations.describeCredentials(refs);
          setDirectory({ status: "ready", rows, error: null });
          setSettingsError(host.describeError());
        } catch (error) {
          setDirectory({ status: "error", rows: [], error: error instanceof Error ? error.message : String(error) });
        } finally {
          setViewRevision((value) => value + 1);
        }
      }, [config, host]);

      const load = react.useCallback(() => {
        const state = loadStateRef.current;
        if (state.running) {
          // 加入同一个事务：只置尾随标记（多个并发调用合并成**一个**尾随轮次），并把当前
          // 事务的 Promise 原样交回调用方——它覆盖到最后一次尾随重跑为止。
          state.again = true;
          return state.promise;
        }
        state.running = true;
        const transaction = (async () => {
          try {
            do {
              state.again = false;
              await runLoad();
            } while (state.again);
          } finally {
            // 任何出口（正常结束、runLoad 抛错）都必须同时清掉两个账本字段：
            // running 卡住会让后续调用永远只置一遍 again，promise 不清空则会让新调用拿到
            // 一个已经结算（甚至已经拒绝）的旧 Promise——两者都会变成静默的永久挂起。
            // 从"循环条件不成立"到这里的整段是同步的，因此不存在"刚好在收尾期间置 again
            // 却被丢弃"的窗口：那个窗口之外的新调用一定会开启一个新事务。
            state.running = false;
            state.again = false;
            state.promise = null;
          }
        })();
        // 赋值发生在事务体的第一个 await 之前（事务体只能在 await 之后进入 finally），
        // 因此 running 为真时 promise 一定已就绪。
        state.promise = transaction;
        return transaction;
      }, [runLoad]);

      react.useEffect(() => {
        if (!open) return;
        void load();
      }, [open, load, hostInvalidation]);

      // 删除后的焦点归还：在途观察器由账本统一记账（见 createRemoveFocusObservationLedger）。
      //
      // 账本在**渲染期**建立（useRef 初始化 + 惰性赋值），不放在 passive effect 里：真实
      // React 的 passive effect 在提交之后才异步执行，删除流程可能在那之前就登记，那条登记
      // 会落进 null 而永远无人清理。卸载时统一 close()——删除流程里有多个 await，远端
      // Promise 可能长时间不结算，捕获监听绝不能留在页面上（常规路径仍由
      // confirmRemoveProvider 的 finally 自己收尾，这里是额外的一层兜底）。
      const removeFocusObservations = react.useRef(null);
      if (removeFocusObservations.current === null) {
        removeFocusObservations.current = createRemoveFocusObservationLedger();
      }
      // 确认弹窗的根节点：Tab 焦点环只在这个子树里取控件（绝不用 document 全局查询）。
      const removeDialogRef = react.useRef(null);
      react.useEffect(() => () => {
        removeFocusObservations.current?.close();
      }, []);

      react.useEffect(() => {
        // 区域折叠（body 不再渲染）时清掉**待确认**状态：快照里挂着的是此刻已经不在页面上的
        // 删除按钮，重新展开时不得把它当成仍然有效的待确认操作弹出来。
        // 两个边界：
        // - 只在**折叠**方向清理，展开方向什么都不做（否则"折叠期间结算成失败"的状态会在
        //   重新展开的那一刻被自己抹掉）；
        // - **running 绝不清**：异步删除（凭据 / 写入 / 刷新）仍在继续，清掉它只会让进行中、
        //   失败与重试的可见入口永久消失——用户可以折叠，但这次删除的结果必须找得回来。
        if (open) return;
        setRemoveIntent((previous) => (previous !== null && previous.phase === "confirming" ? null : previous));
      }, [open]);

      const editableRows = directory.rows.filter((row) => config.providerEditable(row, host.namespaceView(row.settingsNs)));
      const configured = providerSections.configured.map((entry) => entry.row);
      const addable = providerSections.addable.map((entry) => entry.row);
      /**
       * 点击卡片「删除」：**只**捕获这次交互的上下文并打开 DEG 自渲染的确认弹窗。
       *
       * 这一阶段绝不能有任何远端副作用：确认前的凭据删除、settings 写入与目录刷新都必须为 0。
       * 也绝不能再调用同步原生 `confirm()`：它阻塞浏览器事件循环，弹窗存续期间页面脚本、
       * 遮罩与宿主（DSH 会话输入框）的输入处理全部停摆——这正是"删除后设置页与会话输入框
       * 都不可用、重启才恢复"的事故面。
       *
       * trigger / scope / ownsFocus 必须在**点击那一刻**捕获：删除成功的刷新会给卡片换 key，
       * 原按钮届时已从页面摘除，事后再算只能得到 null。
       */
      const openRemoveConfirm = (row, event) => {
        const label = typeof row.displayName === "string" && row.displayName.length > 0 ? row.displayName : row.provider;
        // `currentTarget` 只在同步派发期间有效：在这里读一次并存进确认状态。
        const trigger = event?.currentTarget ?? null;
        const documentStub = removeFocusDocument();
        // ① 只有"点击删除按钮那一刻焦点确实在这个按钮上"才登记恢复意图：否则这次交互的
        //    焦点不属于 DEG 卡片（宿主替身没有真实 DOM 焦点），绝不猜测、绝不抢焦点。
        //    读面失败（ok=false）时焦点归属**未知**，同样不得 arm：一条无法证明归属的流程
        //    在收尾时把焦点搬走，恰恰是"插件越过自己边界动焦点"的那类事故。
        const triggerFocusRead = readFocusedElement(documentStub);
        const ownsFocus = trigger !== null
          && triggerFocusRead.ok === true
          && triggerFocusRead.element === trigger;
        // 作用域必须在点击时捕获（见 closestRemoveFocusScope 的说明）。
        const scope = ownsFocus ? closestRemoveFocusScope(trigger) : null;
        removeConfirmSeq += 1;
        setRemoveIntent({ token: removeConfirmSeq, row, label, trigger, scope, ownsFocus, phase: "confirming", error: null });
      };

      /**
       * 取消确认：只关弹窗，并把焦点还给**仍可用**的已捕获删除按钮，或同一 DEG 区域内的
       * 安全回退目标。
       *
       * 取消路径不得读取当前 `document.activeElement` 去另找一个恢复目标：那是"把全局焦点
       * 当恢复目标"的错误做法，正好会把焦点交给宿主输入框。按钮与作用域都来自打开弹窗那一刻
       * 的快照，因此这条路径在结构上不可能触及 DEG 之外的控件。
       */
      const cancelRemoveConfirm = () => {
        const intent = removeIntent;
        // 进行中一律拒绝取消：此刻凭据与 settings 可能已经写盘，"取消"在语义上已经不存在，
        // 关掉弹窗只会把进行中 / 失败 / 重试的可见入口一起卸载，而异步删除仍在继续。
        // 遮罩、Escape 与「取消」按钮三条入口共用这一个守卫，任何一条都不得绕过它。
        if (intent !== null && intent.phase === "running") return;
        setRemoveIntent(null);
        if (intent === null || intent.ownsFocus !== true) return;
        try {
          // 删除按钮仍在页面上且可用 → 优先还给它（按 Escape / 取消后的直觉位置）。
          if (isUsableRemoveFocusTarget(intent.trigger)) {
            intent.trigger.focus();
            return;
          }
          // 按钮已不可用（断开 / 隐藏 / 禁用）→ 只在点击时捕获的 DEG 区域内找安全回退目标。
          if (intent.scope !== null && intent.scope.isConnected === true) {
            const target = pickRemoveFocusTarget(intent.scope);
            if (target !== null) target.focus();
          }
        } catch { /* 焦点不可用不影响"取消"语义：弹窗已经关掉。 */ }
      };

      /**
       * 用户点击弹窗「删除」：**从这里**才开始真正的删除链路。
       *
       * 顺序与错误语义与既有实现完全一致：角色联动守卫 → 凭据删除 → settings unset →
       * 完整 load 事务（含并发合并进来的尾随轮次）→ 区域内焦点恢复策略。唯一变化是它由 DEG
       * 自己的弹窗按钮触发，因此不再有同步原生 confirm 阻塞事件循环。
       *
       * 失败（守卫拦截 / 凭据失败 / 写入失败 / 异常）保留弹窗：错误同时留在弹窗内（role=alert）
       * 与区域级错误里，用户可以直接取消或重试；失败路径不做任何焦点恢复，也绝不把删除
       * 结果伪装成成功。删除进行中（phase === "running"）按钮禁用，防止重复提交。
       */
      const confirmRemoveProvider = async () => {
        const intent = removeIntent;
        if (intent === null || intent.phase !== "confirming") return;
        const { row, trigger, scope, ownsFocus } = intent;
        // 立刻转 running：此刻凭据与 settings 可能已经写盘，关掉弹窗只会掩盖真实结果，
        // 因此按钮禁用、取消/Escape 不再受理（见 removeConfirmDialog 的键位处理）。
        // 所有后续更新都按 token 配对：同一次确认换了对象也认得自己，后来者则不受影响。
        setRemoveIntent((previous) => (previous !== null && previous.token === intent.token
          ? { ...previous, phase: "running", error: null }
          : previous));
        const documentStub = removeFocusDocument();
        // ② 确认之后、任何 await 之前登记观察器：异步窗口里用户/宿主的任何操作都可能把
        //    意图移走，收尾时据 abandoned 决定是否还焦点。
        const observation = ownsFocus && scope !== null ? observeRemoveFocusIntent(documentStub) : null;
        if (observation !== null) removeFocusObservations.current?.add(observation);
        // 失败出口：区域级错误保持既有语义，同时在弹窗内可见（身份比较，绝不动后来者）。
        const fail = (message) => {
          setSettingsError(message);
          setRemoveIntent((previous) => (previous !== null && previous.token === intent.token
            ? { ...previous, phase: "confirming", error: message }
            : previous));
        };
        try {
          const affected = config.rolesAffectedByChange(roleDefaults, { provider: row.provider, removeProvider: true });
          if (affected.length > 0) {
            fail(config.reasoningGuardMessage(["（整个 provider）"], affected, roleLabelOf));
            return;
          }
          const namespace = host.namespaceView(row.settingsNs);
          const credentialRef = config.credentialRefOf(row, namespace);
          if (host.operations.credentialState(credentialRef)?.configured === true) {
            const removed = await host.operations.removeKey(credentialRef);
            if (removed !== null) {
              fail(removed);
              return;
            }
          }
          const written = await host.writeNamespace({
            ns: row.settingsNs,
            ops: [{ op: "unset", path: [...row.settingsPath] }],
            expectedRevision: namespace?.revision,
          });
          if (!written.ok) {
            fail(written.message);
            return;
          }
          // ③ + ④ 写入成功，且**整个加载事务**（当前轮 + 所有尾随重跑）已经结算：先摘观察器
          //    （自己的 focus 不该被自己记成"意图移走"），再按优先级把焦点还回区域内
          //    （目标不可用时静默跳过）。`await load()` 拿到的是共享事务的 Promise，
          //    不是"立刻结算的空壳"——见 loadStateRef 上方的时序说明。
          await load();
          observation?.dispose();
          // 成功：先关掉自己这一轮弹窗（按 token 配对：并发的后来者不受影响），再恢复焦点。
          setRemoveIntent((previous) => (previous !== null && previous.token === intent.token ? null : previous));
          restoreRemoveFocus({ documentStub, trigger, scope, observation });
        } catch (cause) {
          // 任何读面/写面抛错都必须可见，而不是静默变成一次"看起来成功"的删除。
          fail(cause instanceof Error ? cause.message : String(cause));
        } finally {
          // 所有出口（守卫拦截、凭据失败、写入失败、异常、成功）都在这里摘掉观察器；
          // 摘监听本身幂等，卸载兜底再摘一次也不会重复移除。
          observation?.dispose();
          removeFocusObservations.current?.delete(observation);
        }
      };

      const body = section.open ? react.createElement("div", { className: "deg_mc_body", id: section.disclosure.bodyId },
        react.createElement("p", { className: "deg_settings_hint" }, section.hint),
        directory.status === "error" ? react.createElement("p", { className: "deg_mc_error", role: "alert" }, directory.error) : null,
        settingsError === null ? null : react.createElement("p", { className: "deg_mc_error", role: "alert" }, settingsError),
        directory.status === "ready" && editableRows.length === 0
          ? react.createElement("p", { className: "deg_mc_hint" }, "当前宿主没有可配置的 provider。")
          : null,
        react.createElement("ul", { className: "deg_mc_cards", "data-deg-view-revision": viewRevision },
          configured.map((row) => react.createElement(ModelProviderCard, {
            // 每次重新读取宿主视图都换 key：卡片用新的 user 层与 revision 重建基线，
            // 不会带着上一轮的旧草稿/旧栅栏继续编辑。
            key: row.provider + "#" + String(viewRevision),
            row,
            namespace: host.namespaceView(row.settingsNs),
            host,
            roleLabels: { defaults: roleDefaults, labelOf: roleLabelOf },
            onSaved: () => { void load(); },
            // 事件原样透传：openRemoveConfirm 只读取同步有效的 `currentTarget`（删除按钮本身），
            // 打开 DEG 自己的确认弹窗——确认之前不删凭据、不写 settings、不刷目录。
            onRemove: (event) => openRemoveConfirm(row, event),
          }))),
        react.createElement("div", { className: "deg_mc_add" },
          adding
            ? react.createElement(react.Fragment, null,
              react.createElement("select", {
                className: "deg_mc_select",
                value: addChoice,
                "aria-label": "选择要添加的 provider",
                disabled: directory.status !== "ready",
                onChange: (event) => setAddChoice(event.target.value),
              },
                react.createElement("option", { value: "" }, "选择 provider"),
                addable.map((row) => react.createElement("option", { key: row.provider, value: row.provider }, row.displayName))),
              react.createElement("button", {
                type: "button",
                className: "deg_btn deg_btn_primary",
                disabled: addChoice === "" || directory.status !== "ready",
                "data-deg-confirm-add-provider": "true",
                onClick: async () => {
                  const row = addable.find((candidate) => candidate.provider === addChoice);
                  if (row === undefined) return;
                  const written = await host.writeNamespace({
                    ns: row.settingsNs,
                    ops: [{ op: "set", path: [...row.settingsPath], value: {} }],
                    expectedRevision: host.namespaceView(row.settingsNs)?.revision,
                  });
                  if (!written.ok) {
                    setSettingsError(written.message);
                    return;
                  }
                  setAdding(false);
                  setAddChoice("");
                  await load();
                },
              }, "添加"),
              react.createElement("button", {
                type: "button",
                className: "deg_btn",
                onClick: () => { setAdding(false); setAddChoice(""); },
              }, "取消"))
            : react.createElement("div", { className: "deg_mc_entries" },
              react.createElement("button", {
                type: "button",
                className: "deg_btn",
                disabled: section.actions.addProvider === "disabled",
                "data-deg-add-provider": "true",
                onClick: () => { setAdding(true); setCustomOpen(false); },
              }, section.entries.addProvider.label),
              react.createElement("button", {
                type: "button",
                className: "deg_btn",
                disabled: section.actions.addCustom === "disabled",
                "data-deg-add-custom-provider": "true",
                onClick: openCustomProvider,
              }, section.entries.addCustom.label))),
        customOpen && customDraft !== null
          ? react.createElement(CustomProviderCard, {
            draft: customDraft,
            protocols: customProtocols,
            host,
            pageWritable,
            profileBasePath: [...CUSTOM_PROFILE_BASE_PATH],
            directoryRows: directory.rows,
            // 父区域每次渲染都从宿主视图读到的 revision：只用于"尚未贴出栅栏"时的纠正。
            liveRevision: customNamespace?.revision,
            fenceState: customFence.current,
            // settings 已经落盘的半完成 provider 必须立刻可见：取消时也主动重读目录。
            // 未提交的草稿取消不产生任何写入，重读只是幂等的视图刷新。
            onClose: (committed) => {
              setCustomOpen(false);
              setCustomDraft(null);
              if (committed === true) void load();
            },
            onCreated: () => {
              setCustomOpen(false);
              setCustomDraft(null);
              void load();
            },
          })
          : null,
        react.createElement("button", {
          type: "button",
          className: "deg_btn",
          disabled: section.actions.reload === "disabled",
          "data-deg-reload-providers": "true",
          onClick: () => { void load(); },
        }, directory.status === "loading" ? "读取中…" : "重新读取 provider 目录"))
        : null;

      /**
       * 删除确认弹窗：复用提示词弹窗的 `deg_prompt_dialog_backdrop` / `deg_prompt_dialog`
       * 样式与 `data-deg-dialog-action` / focusableDialogControls 的键位模式，但**非阻塞**：
       * 渲染在 React 树里，事件循环照常运转。
       *
       * 边界（每条都是修复的一部分）：
       * - 只显示 provider 名称与「确认 / 取消」两个操作；
       * - 打开后焦点落在「取消」（破坏性动作绝不能是默认焦点）；
       * - 取消、Escape、点击遮罩**本身**三条路径都只关弹窗：不删凭据、不写 settings、不刷目录；
       * - Tab / Shift+Tab 只在弹窗内**真正可聚焦**的控件之间循环，不漏到背景页面；
       * - 删除进行中（phase === "running"）按钮禁用、Escape 与 Tab 都不再受理：此刻写盘可能
       *   已经发生，关掉弹窗只会掩盖真实结果；
       * - 失败时弹窗保留，错误在弹窗内以 role=alert 可见，用户可以取消或重试。
       */
      const removeConfirmDialog = removeIntent === null ? null : react.createElement("div", {
        className: "deg_prompt_dialog_backdrop",
        // 点遮罩本身只取消（弹窗内部的点击在下面 stopPropagation，不会误触发）；
        // 删除进行中由 cancelRemoveConfirm 自己的守卫拒绝——这里绝不另写一套 phase 判断，
        // 三条关闭入口（遮罩 / Escape / 取消按钮）必须共用同一个守卫。
        onClick: () => cancelRemoveConfirm(),
      },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "删除 provider 确认",
          ref: removeDialogRef,
          onClick: (event) => event?.stopPropagation?.(),
          onKeyDown: (event) => {
            // 删除进行中：不再受理取消与焦点环，避免用户以为"取消掉了"而实际已经写盘。
            if (removeIntent.phase === "running") return;
            if (event?.key === "Escape") {
              // 独占模态语义：阻止默认行为并停止冒泡，避免外层再处理同一个 Escape。
              event.preventDefault?.();
              event.stopPropagation?.();
              cancelRemoveConfirm();
              return;
            }
            if (event?.key !== "Tab") return;
            // 与候选弹窗同一套焦点环：只取真正可聚焦（启用且可见）的控件，disabled 的
            // 「删除 / 取消」不能被 preventDefault 之后 focus 一个被忽略的元素而卡死焦点。
            const controls = focusableDialogControls(removeDialogRef.current ?? event?.currentTarget ?? null);
            // 没有任何可聚焦控件时不拦截 Tab：宁可让浏览器默认行为走，也不把焦点锁死。
            if (controls.length === 0) return;
            const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
            const nextIndex = event.shiftKey
              ? (current <= 0 ? controls.length - 1 : current - 1)
              : (current >= controls.length - 1 ? 0 : current + 1);
            event.preventDefault?.();
            try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
          },
        },
          react.createElement("h3", null, "删除 provider"),
          react.createElement("p", null, "确定删除 provider「" + removeIntent.label + "」及其配置吗？"),
          removeIntent.error === null ? null : react.createElement("p", {
            className: "deg_remove_confirm_error",
            role: "alert",
            "aria-live": "assertive",
          }, removeIntent.error),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              "data-deg-remove-cancel": "true",
              // 打开弹窗后焦点落在「取消」：破坏性动作不抢默认焦点。
              autoFocus: true,
              disabled: removeIntent.phase === "running",
              onClick: () => cancelRemoveConfirm(),
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              "data-deg-dialog-action": "confirm",
              "data-deg-remove-confirm": "true",
              disabled: removeIntent.phase === "running",
              onClick: () => { void confirmRemoveProvider(); },
            }, removeIntent.phase === "running" ? "删除中…" : "删除"))));

      return react.createElement("div", { className: "deg_mc_section" },
        react.createElement(ModelConfigDisclosure, { section, onToggle: () => setOpen((value) => !value) }),
        body,
        // 折叠时删除按钮已不在页面上，弹窗一并不渲染（确认状态由 open 的 effect 清掉）。
        open ? removeConfirmDialog : null);
    }

    /**
     * 专家设置页。
     *
     * `settingsForm` 是 `configForms.get("dsh-expert-group")` 返回的配置表单：与旧 scope 快照
     * 同形状（status/value/base/user/revision/writable/mode），只用于**读取与订阅**。
     * 角色配置的保存一律走 DEG 自有提交端点（settings-commit → Host commitSettingsCandidate），
     * 绝不调用表单的 set/unset/mutate：那会绕过 DEG 的语义校验与目录代次检测。
     */
    function DshExpertGroupSettings({ settingsForm, modelCatalog, modelConfigHost, ctx }) {
      const subscribe = react.useMemo(() => settingsForm.subscribe.bind(settingsForm), [settingsForm]);
      const getSnapshot = react.useMemo(() => settingsForm.getSnapshot.bind(settingsForm), [settingsForm]);
      const settingsSnapshot = react.useSyncExternalStore(subscribe, getSnapshot);
      const catalogSubscribe = react.useMemo(() => modelCatalog.subscribe.bind(modelCatalog), [modelCatalog]);
      const catalogGetSnapshot = react.useMemo(() => modelCatalog.getSnapshot.bind(modelCatalog), [modelCatalog]);
      const directoryState = react.useSyncExternalStore(catalogSubscribe, catalogGetSnapshot);
      // 宿主 meta 同时提供角色表、提示词投影与运行诊断；因此这里不新增
      // 任何 RPC/轮询，也不会因为打开设置页而触碰通知权限或专家任务。
      const [hostMeta, refreshHostMeta, hostMetaError] = useHostMeta(ctx);
      const roles = useEnabledSettingsRoles(hostMeta);
      // 文案层（票据 19）：语言按宿主注入面解析一次；同一渲染内所有核心控件共用。
      const uiLocale = resolveSettingsLocale(ctx);
      const t = (key, vars) => settingsText(uiLocale, key, vars);
      // 票据 24 新增区块的文案：本地 zh/en 表（权威消息表不在本票据的文件边界内）。
      const tExtra = (key, vars) => settingsExtraText(uiLocale, key, vars);
      // 角色显示名以 Host meta.roleLabels 为准；缺失时回落内置静态表。
      const roleLabelOf = (role) => {
        const label = hostMeta?.roleLabels?.[role];
        return typeof label === "string" && label.length > 0 ? label : (SETTINGS_ROLE_LABELS[role] ?? role);
      };
      /**
       * 提示词编辑器的角色集合：Host 投影自己声明的 roles（只应是内置六角色）。
       * 未拿到投影时沿用内置六角色；因此旧 Host/旧夹具的按钮集合与语义完全不变。
       */
      const promptRoleIds = react.useMemo(() => {
        const declared = hostMeta?.rolePrompts?.roles;
        if (!Array.isArray(declared)) return PROMPT_ROLE_IDS;
        const roles = declared.filter((role) => typeof role === "string" && role.length > 0);
        return roles.length > 0 ? roles : PROMPT_ROLE_IDS;
      }, [hostMeta]);
      const hostPromptProjection = react.useMemo(
        () => normalizeRolePromptProjection(hostMeta?.rolePrompts, settingsSnapshot.value, true, promptRoleIds),
        [hostMeta, settingsSnapshot.value, promptRoleIds],
      );
      react.useEffect(() => {
        void modelCatalog.load();
      }, [modelCatalog]);
      const [draft, setDraft] = react.useState(() => normalizeSettingsDraft(settingsSnapshot.value, roles));
      const [candidatesError, setCandidatesError] = react.useState(null);
      /**
       * 模型页签的纯 UI 状态（绝不落盘）。
       *
       * - selectedModelPage：当前页（默认 0 = 主模型页），刷新/重挂载后回到主模型页；
       * - modelTabDrag：拖动反馈（是否在拖 + 插入边界），只影响渲染；
       * - modelPageDeleteIntent：删除候选页的确认框目标页，null = 未打开；
       * - 指针会话的原始数据放 ref：pointermove 高频，且拖动期间的中间值不参与渲染；
       * - modelTabSuppressClickRef：拖动结束后抑制一次 click，避免"松手同时切页"。
       */
      const [selectedModelPage, setSelectedModelPage] = react.useState(0);
      const [modelTabDrag, setModelTabDrag] = react.useState(null);
      const [modelPageDeleteIntent, setModelPageDeleteIntent] = react.useState(null);
      const modelTabRefs = react.useRef({});
      const modelTabDragRef = react.useRef(null);
      const modelTabSuppressClickRef = react.useRef(false);
      const modelPageDeleteCancelRef = react.useRef(null);
      const [dirty, setDirty] = react.useState(false);
      const [saving, setSaving] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const [selectedPromptRole, setSelectedPromptRole] = react.useState(null);
      const [promptDrafts, setPromptDrafts] = react.useState(() => ({}));
      const [promptTouched, setPromptTouched] = react.useState({});
      const [promptError, setPromptError] = react.useState(null);
      // 成功提交后共享镜像可能短暂滞后，临时投影只在其 revision 更高时生效；
      // snapshot 追上后立即回到 Host/meta + snapshot 的派生视图，绝不永久缓存旧结果。
      const [localPromptProjection, setLocalPromptProjection] = react.useState(null);
      const [editorBaseline, setEditorBaseline] = react.useState(null);
      const [settingsConflict, setSettingsConflict] = react.useState(null);
      const [externalSettingsChanged, setExternalSettingsChanged] = react.useState(false);
      const [leaveIntent, setLeaveIntent] = react.useState(null);
      const leaveTriggerRef = react.useRef(null);
      const leaveCancelRef = react.useRef(null);
      /**
       * 「通知事件」多选下拉的展开态（布局调整）：三个类别固定，展开只影响菜单可见性，
       * 绝不写入草稿；勾选变化仍只走 editDraft → draft.notificationEvents。
       * root/trigger/panel 三个 ref 分别用于"点击外部"判定、关闭后还焦点、打开后聚焦首项。
       */
      const [notificationEventsOpen, setNotificationEventsOpen] = react.useState(false);
      const notificationEventsRootRef = react.useRef(null);
      const notificationEventsTriggerRef = react.useRef(null);
      const notificationEventsPanelRef = react.useRef(null);
      const promptProjection = localPromptProjection !== null
        && Number.isSafeInteger(localPromptProjection.revision)
        && localPromptProjection.revision > settingsSnapshot.revision
        ? localPromptProjection.projection
        : hostPromptProjection;
      // 编辑期间固定 rolePrompts + settings revision：外部快照只能提示变化，不能悄悄
      // 改写正在编辑的默认值或把首次 CAS 提交升级为最新 revision。
      const baselineProjection = editorBaseline?.role === selectedPromptRole
        ? editorBaseline.projection
        : promptProjection;
      const promptMaxGraphemes = baselineProjection?.maxGraphemes ?? DEFAULT_PROMPT_MAX_GRAPHEMES;
      // 整页写权限的唯一来源是快照的 writable（远端 memory 模式永远不可写）。
      // 旧 scope 时代的 `status === "readonly"` 分支已删除：新契约的 status 只有
      // loading/ready/unavailable 三个取值，readonly 语义已由 writable 完整表达。
      const settingsReadOnly = settingsSnapshot.writable !== true;
      // meta 尚未返回才是加载中；meta 已返回但 rolePrompts 缺失属于 wire 不兼容，
      // 必须显示错误而不能让用户永久等待空编辑器。
      const promptLoading = hostMeta === null && hostMetaError === null;
      const promptTextOf = (role) => {
        if (Object.prototype.hasOwnProperty.call(promptDrafts, role)) return promptDrafts[role];
        return promptEntryOf(baselineProjection, role)?.effective ?? "";
      };
      const promptTouchedRoles = Object.keys(promptTouched).filter((role) => promptRoleIds.includes(role));
      const promptDirty = baselineProjection !== null && promptRoleIds.some((role) => {
        if (!Object.prototype.hasOwnProperty.call(promptTouched, role)) return false;
        const entry = promptEntryOf(baselineProjection, role);
        return entry !== null && promptTextOf(role) !== entry.effective;
      });
      /**
       * 保存成功但共享镜像尚未追上时的权威值（审查修复 P2）。
       *
       * 共享镜像（settings/document-updated）可能滞后：此时若继续拿旧 snapshot 比较或
       * 重建草稿，刚保存的候选会被重置回去、页面也会立刻重新变脏。这里只记录最近一次
       * 成功提交的 revision 与 accepted 归一草稿，snapshot 追上后自动让位。
       */
      const committedAuthorityRef = react.useRef(null);
      const committedSnapshotLagging = committedAuthorityRef.current !== null
        && Number.isSafeInteger(committedAuthorityRef.current.revision)
        && (!Number.isSafeInteger(settingsSnapshot.revision)
          || settingsSnapshot.revision < committedAuthorityRef.current.revision);
      const authorityValue = committedSnapshotLagging ? committedAuthorityRef.current.value : settingsSnapshot.value;
      // 提示词覆盖同样以权威值为基底：保存成功后快照滞后时，旧 snapshot 的覆盖会把
      // 上一次刚提交的覆盖写回旧值（promptOverrides 是整份映射 replace）。
      const sourcePromptOverrides = normalizePromptOverrides(authorityValue?.promptOverrides, promptMaxGraphemes, promptRoleIds);
      // 共享一个 saved dirty 判定：模型/通知的既有草稿与提示词草稿可以独立变回基线，
      // 不把“曾经编辑过”误判为仍需提交，也不影响任务管理等历史控件的保存语义。
      // 比较对象是 authorityValue：刚提交而快照滞后时，用 accepted 草稿而不是旧快照，
      // 否则保存成功后会立刻被判成"仍有未保存修改"。
      const localDraft = normalizeSettingsDraft(draft, roles, false);
      const sourceDraftForDirty = normalizeSettingsDraft(authorityValue, roles, false);
      const settingsDirty = !settingsDraftEqual(localDraft, sourceDraftForDirty);
      const hasUnsavedChanges = settingsDirty || promptDirty;
      /**
       * 详情页与列表页共用同一份"有未保存修改"判定（审查修复 P1）。
       *
       * 详情页里的候选、降级上限、通知、模型等任何本地草稿都算修改：保存按钮、应用内
       * 离开确认与 beforeunload 因此不会漏掉提示词以外的字段。
       */
      const editorHasUnsavedChanges = hasUnsavedChanges;
      /**
       * 详情页保存的合成草稿（审查修复 P1）：最新 source + 本地相对编辑基线的差异。
       *
       * 详情页保存不再整份提交旧草稿，也不再用 source 整份替换：只有相对进入编辑器
       * （或上次成功保存）确实变化的字段才覆盖到最新 source，外部已改、本次未动的字段
       * 一律沿用 source。列表页保持既有整份草稿语义不变。
       */
      const sourceDraftForSave = normalizeSettingsDraft(authorityValue, roles);
      const editorEntryValue = selectedPromptRole !== null && editorBaseline?.role === selectedPromptRole
        ? editorBaseline.value
        : authorityValue;
      const editorEntryDraft = normalizeSettingsDraft(editorEntryValue, roles, false);
      // 详情页保存用「最新 source + 本地相对编辑基线的差异」合成草稿；列表页保持整份草稿语义。
      const effectiveDraft = selectedPromptRole !== null
        ? mergeSettingsDraftOverSource(sourceDraftForSave, localDraft, editorEntryDraft)
        : localDraft;
      /**
       * 本次草稿是否要改动「模型字段」（统一供应商 / 角色默认模型）——票据 20。
       *
       * 保存守卫、保存按钮与 settings-commit 的变更集共用**同一个**判定，避免出现
       * 「按钮禁用但 save() 允许」这类分裂：
       * - 判定对象是最终要提交的合成草稿（effectiveDraft）：只改提示词/候选时模型字段
       *   等于最新 source，因此不算模型字段变更；
       * - 顶层统一供应商或任一角色行级 defaults 与已保存快照不同即为变更；
       * - 模型目录不可用时**只有它为真**才阻断保存：通知、任务开关、提示词、并发/超时
       *   等与模型无关的字段必须照常保存。模型下拉本身已按目录可用性禁用，用户不可能
       *   在没有目录的情况下做出新的模型草稿，因此这里判定草稿差异而不是操作来源。
       */
      const modelFieldsChanged = react.useMemo(() => {
        if (!settingsDraftEqual(effectiveDraft.defaults, sourceDraftForSave.defaults)) return true;
        // 两侧都用各自草稿里的顶层 provider 作遗留回退，避免"本地未改 provider"被
        // 误判成模型字段变更（详情页合并后 effectiveDraft.provider 就是最新 source 的值）。
        return unifiedProviderOf(effectiveDraft.defaults, roles, effectiveDraft.provider)
          !== unifiedProviderOf(sourceDraftForSave.defaults, roles, sourceDraftForSave.provider);
      }, [effectiveDraft, sourceDraftForSave, roles]);

      react.useEffect(() => {
        if (dirty) return;
        // 已提交但共享镜像尚未追上：accepted 草稿才是权威，绝不用旧 snapshot 覆盖它
        // （否则候选会短暂消失、通知/降级等刚保存的值也会回退）。
        if (committedSnapshotLagging) return;
        setDraft(normalizeSettingsDraft(authorityValue, roles));
        // 未编辑角色必须继续从 Host rolePrompts 读 effective 值；不能仅按 settings
        // snapshot 填空对象，否则无覆盖时会把默认 persona 显示成空文本。
        setPromptDrafts({});
        setPromptTouched({});
        setPromptError(null);
        setCandidatesError(null);
      }, [dirty, settingsSnapshot.value, settingsSnapshot.revision, roles, promptMaxGraphemes, committedSnapshotLagging, authorityValue]);

      react.useEffect(() => {
        if (selectedPromptRole === null || editorBaseline?.role !== selectedPromptRole) return;
        if (editorBaseline.projection === null && hostPromptProjection !== null) {
          // 只补齐进入编辑器后异步返回的投影，保留 captureEditorBaseline 锁定的
          // settings value/revision，防止 meta 延迟期间的外部提交绕过首次 CAS。
          setEditorBaseline((previous) => previous?.role === selectedPromptRole && previous.projection === null
            ? { ...previous, projection: hostPromptProjection }
            : previous);
          return;
        }
        // 提交响应的 revision 高于滞后镜像时，响应是当前权威基线；
        // 不能被旧 meta 投影再次回写。
        if (Number.isSafeInteger(localPromptProjection?.revision)
          && localPromptProjection.revision > settingsSnapshot.revision) return;
        if (!Number.isSafeInteger(settingsSnapshot.revision)) return;
        if (settingsSnapshot.revision === editorBaseline.revision) return;
        // 快照落后于编辑基线（刚提交、共享镜像还在路上）：等它追上，绝不用旧快照重建。
        if (Number.isSafeInteger(editorBaseline.revision) && settingsSnapshot.revision < editorBaseline.revision) return;
        if (hasUnsavedChanges || dirty) {
          // 本地有未保存修改（提示词、候选或任何列表草稿）：只提示外部版本变化，
          // 绝不重建 draft/清 dirty，否则候选或提示词以外的草稿会被静默丢弃。
          setExternalSettingsChanged(true);
          return;
        }
        const refreshedProjection = hostPromptProjection;
        if (refreshedProjection === null) {
          setExternalSettingsChanged(true);
          return;
        }
        // 没有本地草稿时以最新完整 snapshot 重建编辑基线，圆点与有效内容同步更新。
        setLocalPromptProjection(null);
        setEditorBaseline({
          role: selectedPromptRole,
          value: settingsSnapshot.value,
          revision: settingsSnapshot.revision,
          projection: refreshedProjection,
        });
        setDraft(normalizeSettingsDraft(settingsSnapshot.value, roles));
        setPromptDrafts({});
        setPromptTouched({});
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      }, [selectedPromptRole, editorBaseline, localPromptProjection, settingsSnapshot.revision, settingsSnapshot.value, hostPromptProjection, hasUnsavedChanges, dirty, roles]);

      react.useEffect(() => {
        if (selectedPromptRole === null || !editorHasUnsavedChanges) return;
        // 同文档的角色/列表切换由上面的应用内确认处理；这里仅覆盖刷新、关闭和浏览器
        // 返回等跨文档离开。浏览器决定原生提示文案，且可能不拦截某些生命周期终止路径。
        const target = typeof globalThis?.addEventListener === "function"
          ? globalThis
          : (typeof globalThis?.window?.addEventListener === "function" ? globalThis.window : null);
        if (target === null) return;
        const onBeforeUnload = (event) => {
          event.preventDefault?.();
          event.returnValue = "";
          return "";
        };
        target.addEventListener("beforeunload", onBeforeUnload);
        return () => target.removeEventListener?.("beforeunload", onBeforeUnload);
      }, [selectedPromptRole, editorHasUnsavedChanges]);

      /**
       * 「通知事件」下拉的关闭面：Escape、点击面板外部（文档级 mousedown）与再次点击触发按钮。
       *
       * 只在展开期间注册监听；嵌入宿主或测试环境没有 document 时不注册、不抛错。
       * 关闭后把焦点还给触发按钮，键盘用户不会掉到页面开头。
       */
      react.useEffect(() => {
        if (!notificationEventsOpen) return undefined;
        const restoreTriggerFocus = () => {
          try { notificationEventsTriggerRef.current?.focus?.(); } catch { /* 无 DOM 的宿主忽略 */ }
        };
        const closeAndRestoreFocus = () => {
          setNotificationEventsOpen(false);
          restoreTriggerFocus();
        };
        const onPointerDown = (event) => {
          const root = notificationEventsRootRef.current;
          const target = event?.target;
          // 面板与触发按钮都在 root 内；点它们不关闭（按钮自身的 onClick 负责切换）。
          if (root !== null && root !== void 0 && typeof root.contains === "function"
            && target !== null && target !== void 0 && root.contains(target)) return;
          closeAndRestoreFocus();
        };
        const onKeyDown = (event) => {
          if (event?.key !== "Escape") return;
          event.preventDefault?.();
          closeAndRestoreFocus();
        };
        const doc = typeof document === "undefined" ? null : document;
        if (doc === null || typeof doc.addEventListener !== "function") return undefined;
        doc.addEventListener("mousedown", onPointerDown);
        doc.addEventListener("keydown", onKeyDown);
        return () => {
          doc.removeEventListener?.("mousedown", onPointerDown);
          doc.removeEventListener?.("keydown", onKeyDown);
        };
      }, [notificationEventsOpen]);

      // 打开后焦点落到第一个选项；无 DOM（测试/嵌入替身）时 ref 为空，静默跳过。
      react.useEffect(() => {
        if (!notificationEventsOpen) return;
        const panel = notificationEventsPanelRef.current;
        if (panel === null || panel === void 0 || typeof panel.querySelector !== "function") return;
        try { panel.querySelector("input[type=checkbox]")?.focus?.(); } catch { /* 忽略不可聚焦的宿主 */ }
      }, [notificationEventsOpen]);

      const editDraft = (update) => {
        setDirty(true);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setDraft((previous) => update(previous));
      };

      const captureEditorBaseline = (role) => {
        if (role === null) return null;
        // 即使 rolePrompts 仍在加载，也必须先锁定进入编辑器时的 revision；
        // 投影稍后到达时只能补齐内容，不能把首次 CAS 偷换成实时 revision。
        return {
          role,
          value: settingsSnapshot.value,
          revision: Number.isSafeInteger(settingsSnapshot.revision) && settingsSnapshot.revision >= 0
            ? settingsSnapshot.revision
            : null,
          projection: promptProjection,
        };
      };
      const applyPromptNavigation = (role) => {
        setSelectedPromptRole(role);
        setEditorBaseline(captureEditorBaseline(role));
        setPromptDrafts({});
        setPromptTouched({});
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
      };
      const requestPromptNavigation = (role, trigger) => {
        if (editorHasUnsavedChanges) {
          // 对话框关闭后返回触发控件；无法取得 DOM 焦点时安全降级，不影响导航语义。
          leaveTriggerRef.current = trigger?.currentTarget ?? (typeof document === "undefined" ? null : document.activeElement);
          setLeaveIntent({ kind: "navigate", role });
          return;
        }
        applyPromptNavigation(role);
      };
      const openPrompt = (role, event) => {
        if (!promptRoleIds.includes(role)) return;
        if (selectedPromptRole !== null && selectedPromptRole !== role) {
          requestPromptNavigation(role, event);
          return;
        }
        setSelectedPromptRole(role);
        setEditorBaseline(captureEditorBaseline(role));
        setPromptError(null);
        setError(null);
      };
      const closePrompt = (event) => requestPromptNavigation(null, event);
      const dismissLeaveDialog = () => {
        setLeaveIntent(null);
        const trigger = leaveTriggerRef.current;
        leaveTriggerRef.current = null;
        try { trigger?.focus?.(); } catch { /* 焦点恢复失败不应阻断编辑器。 */ }
      };
      const editPromptText = (role, text) => {
        const nextPromptDirty = baselineProjection !== null && promptRoleIds.some((candidate) => {
          const entry = promptEntryOf(baselineProjection, candidate);
          if (entry === null) return false;
          return (candidate === role ? text : promptTextOf(candidate)) !== entry.effective;
        });
        setPromptDrafts((previous) => ({ ...previous, [role]: text }));
        setPromptTouched((previous) => ({ ...previous, [role]: true }));
        // 仅提示词被改回已保存文本时要撤销 dirty；否则保存按钮会错误保持可用。
        setDirty(settingsDirty || nextPromptDirty);
        setSaved(false);
        setError(null);
        setPromptError(null);
      };

      const groups = Array.isArray(directoryState.groups) ? directoryState.groups : [];
      const providerGroups = groups.filter((group) => group && typeof group.id === "string");
      /**
       * 角色模型表的行集合：内置六角色（含未启用的 Observer，提示词入口历史行为）
       * + meta.activeRoles 里启用的内置角色。
       */
      const modelRowRoles = react.useMemo(() => {
        const next = [...PROMPT_ROLE_IDS];
        for (const role of roles) if (!next.includes(role)) next.push(role);
        return next;
      }, [roles]);

      /**
       * 目录可用性：`status === "ready"`，或**已有成功目录缓存**（groups 非空）。
       *
       * 角色的选择与保存只依赖目录**内容**，不依赖"此刻有没有在途刷新"：
       * - `startRequest` 每次只把 status 推到 loading、**刻意保留**上一次已知目录（见
       *   createSettingsModelCatalog 的注释），最新一次请求失败也只把 status 推到 error；
       *   这两种状态下下拉里的选项仍然完整可用，若按 status 硬门控就会出现"用户看得见选项
       *   却选不了、更保存不了"的死锁——"新增 provider 后立即删除"的刷新突发正是这个时序；
       * - 首次挂载还没有过任何成功目录（groups 为空）时仍然禁用：没有目录就没有合法选项；
       * - `connection/reset` 的 clear 语义会**立刻清空** groups（refresh(true)），清空期间
       *   同样必须禁用，直到新连接上的目录返回。缓存可用的判定因此只看"有没有目录"，
       *   绝不能用"曾经 ready 过"这类会跨 reset 残留的记忆。
       */
      const catalogAvailable = directoryState.status === "ready" || groups.length > 0;
      /**
       * 页签与当前层的派生视图（票据 24 重排：候选与子代理模型选择合并成多页签）。
       *
       * 页数由草稿推导，`currentModelPage` 永远收敛到合法页：删除最后一页或保存后数组变短时
       * 界面自动回落到主模型页，绝不去渲染一个不存在的层。
       */
      const modelPageCount = modelPageCountOf(draft);
      const currentModelPage = Math.min(selectedModelPage, modelPageCount - 1);
      const currentModelLayer = modelLayerMapOf(draft, currentModelPage);
      // 统一选择器只反映**当前页**的共同 provider；候选页没有历史顶层 provider 可回退。
      const unifiedProvider = unifiedProviderOf(currentModelLayer, roles, currentModelPage === 0 ? draft.provider : "");
      /** 页签名称只由位置推导：第一页恒为「主模型」，其余按候选序号。 */
      const modelPageLabelOf = (page) => (page === 0
        ? tExtra("settings.modelTabs.primary")
        : tExtra("settings.modelTabs.candidate", { index: page }));

      /** 切换页签：纯 UI 状态（不写草稿、不落盘）。 */
      const selectModelPage = (page) => {
        if (modelTabSuppressClickRef.current === true) return;
        if (!Number.isSafeInteger(page) || page < 0 || page >= modelPageCount) return;
        setSelectedModelPage(page);
      };
      /** 「+」新建候选页：深拷贝主模型页的选择，并立刻切到新页。 */
      const addModelPage = () => {
        if (saving || settingsReadOnly || modelPageCount >= MAX_MODEL_PAGES) return;
        const nextIndex = modelPageCount;
        editDraft((previous) => addModelCandidatePage(previous));
        setSelectedModelPage(nextIndex);
      };
      /** 打开删除确认框：只有候选页有 ×，主模型页不可删除。 */
      const requestModelPageDelete = (page) => {
        if (saving || settingsReadOnly || !Number.isSafeInteger(page) || page < 1) return;
        setModelPageDeleteIntent({ page });
      };
      const cancelModelPageDelete = () => {
        setModelPageDeleteIntent(null);
      };
      /** 确认删除：所有角色同步删掉该索引项；删除当前页后回到主模型页。 */
      const confirmModelPageDelete = () => {
        const intent = modelPageDeleteIntent;
        if (intent === null) return;
        setModelPageDeleteIntent(null);
        editDraft((previous) => removeModelCandidatePage(previous, intent.page));
        setSelectedModelPage((previous) => (previous === intent.page
          ? 0
          : previous > intent.page ? previous - 1 : previous));
      };

      /**
       * 页签拖动的指针手势（自研 pointer 事件，不引入第三方依赖）。
       *
       * 交互边界：
       * - 指针移动超过 4px 才进入拖拽，pointerdown 本身仍是普通点击；
       * - 拖动期间只更新落点指示，**不**切换当前页（切页只由 click 触发）；
       * - 松手时按插入边界整层重排：主模型页也能拖，落点决定新位置，其余页顺移；
       * - pointercancel 或卸载一律取消本次拖动，不写草稿。
       */
      const MODEL_TAB_DRAG_THRESHOLD = 4;
      /** 指针 x → 插入边界（0..页数）：落在某个页签前半区就插在它前面。 */
      const modelTabDropIndexOf = (clientX) => {
        const refs = modelTabRefs.current ?? {};
        for (let page = 0; page < modelPageCount; page += 1) {
          const element = refs[page];
          const rect = typeof element?.getBoundingClientRect === "function" ? element.getBoundingClientRect() : null;
          if (rect === null || rect === void 0) continue;
          const left = Number(rect.left);
          const width = Number(rect.width);
          // 无布局信息（测试替身/隐藏容器）时跳过：落点退化为"不移动"，绝不猜一个位置。
          if (!Number.isFinite(left) || !Number.isFinite(width) || width <= 0) continue;
          if (Number(clientX) < left + width / 2) return page;
        }
        return modelPageCount;
      };
      const beginModelTabDrag = (page, event) => {
        if (saving || settingsReadOnly) return;
        if (event === null || typeof event !== "object") return;
        // 只响应主键：右键/中键不进入拖拽，也不抢浏览器菜单。
        if (typeof event.button === "number" && event.button !== 0) return;
        const doc = typeof document === "undefined" ? null : document;
        if (doc === null || typeof doc.addEventListener !== "function") return;
        const startX = Number(event.clientX);
        const startY = Number(event.clientY);
        if (!Number.isFinite(startX) || !Number.isFinite(startY)) return;
        const session = { page, startX, startY, active: false, dropIndex: page, detach: null };
        const onMove = (moveEvent) => {
          const current = modelTabDragRef.current;
          if (current === null) return;
          const x = Number(moveEvent?.clientX);
          const y = Number(moveEvent?.clientY);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (current.active !== true) {
            // 阈值内仍算点击：不 preventDefault，页签的 click 事件照常到达。
            if (Math.abs(x - current.startX) + Math.abs(y - current.startY) < MODEL_TAB_DRAG_THRESHOLD) return;
            current.active = true;
            modelTabSuppressClickRef.current = true;
          }
          // 只有真正进入拖拽后才阻止默认行为（文本选择/触屏滚动）。
          moveEvent?.preventDefault?.();
          current.dropIndex = modelTabDropIndexOf(x);
          setModelTabDrag({ page: current.page, dropIndex: current.dropIndex, active: true });
        };
        const onEnd = (endEvent) => {
          const current = modelTabDragRef.current;
          modelTabDragRef.current = null;
          try {
            doc.removeEventListener("pointermove", onMove);
            doc.removeEventListener("pointerup", onEnd);
            doc.removeEventListener("pointercancel", onEnd);
          } catch { /* 监听清理失败不影响后续手势。 */ }
          setModelTabDrag(null);
          if (current === null || current.active !== true) {
            // 未越过阈值：这是一次点击，交给 click 处理（绝不写草稿）。
            modelTabSuppressClickRef.current = false;
            return;
          }
          endEvent?.preventDefault?.();
          const from = current.page;
          // 插入边界 → 目标页：移走自己后，右侧边界整体左移一位；取消手势落回原页。
          const target = endEvent?.type === "pointercancel"
            ? from
            : (current.dropIndex > from ? current.dropIndex - 1 : current.dropIndex);
          if (target !== from) {
            editDraft((previous) => reorderModelLayers(previous, from, target));
            setSelectedModelPage(target);
          }
          // click 在 pointerup 之后派发：用一次宏任务清掉抑制标记，避免误切页签。
          if (typeof globalThis?.setTimeout === "function") globalThis.setTimeout(() => { modelTabSuppressClickRef.current = false; }, 0);
          else modelTabSuppressClickRef.current = false;
        };
        doc.addEventListener("pointermove", onMove);
        doc.addEventListener("pointerup", onEnd);
        doc.addEventListener("pointercancel", onEnd);
        session.detach = () => {
          doc.removeEventListener("pointermove", onMove);
          doc.removeEventListener("pointerup", onEnd);
          doc.removeEventListener("pointercancel", onEnd);
        };
        modelTabDragRef.current = session;
      };
      // 卸载时摘掉可能仍在监听中的指针监听（拖动中切 section / 关闭设置页）。
      react.useEffect(() => () => {
        const session = modelTabDragRef.current;
        modelTabDragRef.current = null;
        try { session?.detach?.(); } catch { /* 卸载路径不抛错。 */ }
      }, []);
      // 删除确认打开后焦点落在「取消」：破坏性动作不抢默认焦点（与删除 provider 同一模式）。
      react.useEffect(() => {
        if (modelPageDeleteIntent === null) return;
        try { modelPageDeleteCancelRef.current?.focus?.(); } catch { /* 不支持 focus 的嵌入宿主仍可键盘点击。 */ }
      }, [modelPageDeleteIntent]);

      const save = async ({ retry = false } = {}) => {
        if (!hasUnsavedChanges || saving || settingsSnapshot.writable !== true) return false;
        // 票据 20：模型目录不可用只阻断「这次确实要改模型字段」的保存。与模型无关的
        // 字段（通知、任务开关、提示词、并发/超时）不依赖目录，必须照常保存——否则一次
        // 目录刷新失败就会让整页设置不可写。
        if (modelFieldsChanged && !catalogAvailable) return false;
        // 最新权威配置：快照滞后时用刚提交的 accepted（见 committedAuthorityRef）。
        const source = sourceDraftForSave;
        /**
         * 审查修复 P1：详情页提交「最新 source + 本地实际修改」，列表页保持整份草稿语义。
         *
         * 旧实现用 promptOnly 二分法：一旦提示词以外也有改动，就整份提交旧草稿，重试时
         * 还可能把外部已改的通知/降级/provider 写回旧值。合成草稿只在本地确实改过的
         * 字段上覆盖 source，因此提示词、候选、降级等修改都会保留，未修改字段沿用 source。
         */
        const normalizedDraft = effectiveDraft;
        const sourceProvider = unifiedProviderOf(source.defaults, roles, source.provider);
        // 顶层 provider 的遗留回退取自**合成草稿**（与 modelFieldsChanged 同一侧）：
        // 外部 provider 变化而本地只改了 defaults 时，绝不能拿旧 draft.provider 当回退。
        const draftProviderIntent = typeof effectiveDraft.provider === "string" ? effectiveDraft.provider : "";
        const draftProvider = unifiedProviderOf(normalizedDraft.defaults, roles, draftProviderIntent);
        // provider 的模型变化由行级 defaults 差异或用户明确改变统一选择器决定；通知字段单独
        // 保存时 draftProviderIntent 与 sourceProvider 相同，因此不会把旧顶层 provider 强行
        // 写回行级配置。目录门控与下拉同源（catalogAvailable）：缓存在手时用户从缓存里选出的
        // provider+model 是合法候选，必须能随这次保存一起提交，否则就成了"能选不能存"；
        // 反之没有任何目录时这里仍然不写，绝不凭空写入一个无法校验的 provider。
        // 判定与保存守卫/保存按钮同源（见 modelFieldsChanged），因此不存在"按钮可用但
        // save() 静默丢弃模型草稿"的分裂。
        const modelChanged = modelFieldsChanged && catalogAvailable;

        // 提示词是完整 settings 候选中的一个全局映射。只有被编辑过的角色才会从草稿
        // 覆盖 source；恢复默认通过删除对应键表达，避免把默认文本固化成冗余覆盖。
        const candidatePromptOverrides = { ...sourcePromptOverrides };
        if (promptTouchedRoles.length > 0) {
          if (promptProjection === null) {
            setPromptError(hostMetaError ?? "提示词配置加载中，请稍后重试");
            return false;
          }
          if (promptProjection.customizable !== true) {
            setPromptError("当前提示词设置为只读");
            return false;
          }
          for (const role of promptTouchedRoles) {
            const entry = promptEntryOf(baselineProjection, role);
            const text = promptTextOf(role);
            const validation = validatePromptText(text, promptMaxGraphemes);
            if (!validation.ok) {
              setPromptError(roleLabelOf(role) + "：" + validation.message);
              return false;
            }
            if (entry === null || typeof entry.defaultPersona !== "string") {
              setPromptError("提示词默认配置不可用，请刷新后重试");
              return false;
            }
            if (text === entry.defaultPersona) delete candidatePromptOverrides[role];
            else candidatePromptOverrides[role] = text;
          }
        }
        const sourceHasPromptOverrides = authorityValue !== null && authorityValue !== void 0
          && typeof authorityValue === "object"
          && Object.prototype.hasOwnProperty.call(authorityValue, "promptOverrides");
        const promptChanged = !promptOverridesEqual(candidatePromptOverrides, sourcePromptOverrides);
        const includePromptOverrides = sourceHasPromptOverrides || promptTouchedRoles.length > 0;
        /**
         * 票据 24：候选与降级上限只在**真正变化**时进入候选；校验也只覆盖本次变更
         * （未编辑角色的存量失效候选不得阻塞其它字段保存）。
         *
         * 页签草稿里的「空行」只是占位（中间层对齐用），提交前必须由
         * compactModelCandidatesDraft 按「该层该角色未配置 = 不写入」裁掉：
         * Host 会对变更角色的每一条候选做目录解析，空 selection 会被整次拒绝。
         */
        const sourceCandidates = normalizeModelCandidatesDraft(authorityValue?.candidates);
        const candidateCandidates = compactModelCandidatesDraft(normalizeModelCandidatesDraft(normalizedDraft.candidates));
        const candidatesChanged = !settingsDraftEqual(candidateCandidates, sourceCandidates);
        if (candidatesChanged) {
          const validation = validateModelCandidateRows(candidateCandidates);
          if (validation.ok !== true) { setCandidatesError(modelCandidatesErrorMessage(tExtra, roleLabelOf, validation)); return false; }
        }
        const sourceFallbackLimit = source.fallbackLimit;
        const candidateFallbackLimit = normalizedDraft.fallbackLimit;
        const fallbackLimitChanged = candidateFallbackLimit !== void 0 && candidateFallbackLimit !== sourceFallbackLimit;
        const candidate = {
          ...normalizedDraft,
          provider: modelChanged ? draftProvider : sourceProvider,
          ...(modelChanged ? {} : { defaults: source.defaults }),
          ...(includePromptOverrides ? { promptOverrides: candidatePromptOverrides } : {}),
          // 未变化的字段一律不提交：缺字段 = Host 保持已有值（旧客户端兼容语义）。
          ...(candidatesChanged ? { candidates: candidateCandidates } : {}),
          ...(fallbackLimitChanged
            ? { fallbackLimit: typeof candidateFallbackLimit === "number" ? candidateFallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT }
            : {}),
        };
        if (!candidatesChanged) delete candidate.candidates;
        if (!fallbackLimitChanged) delete candidate.fallbackLimit;
        const ops = [];
        if (modelChanged) {
          ops.push({ op: "set", path: ["provider"], value: candidate.provider });
          ops.push({ op: "set", path: ["defaults"], value: candidate.defaults });
        }
        if (candidate.notificationEnabled !== source.notificationEnabled) {
          ops.push({ op: "set", path: ["notificationEnabled"], value: candidate.notificationEnabled });
        }
        if (candidate.notificationVolume !== source.notificationVolume) {
          ops.push({ op: "set", path: ["notificationVolume"], value: candidate.notificationVolume });
        }
        // 通知事件过滤（票据 14）：三个类别是一组完整设置，只有真正变化才写 op；
        // 旧 Host 不认识该字段时会被提交端点按"未知字段"忽略，不会影响其它字段。
        if (!settingsDraftEqual(candidate.notificationEvents, source.notificationEvents)) {
          ops.push({ op: "set", path: ["notificationEvents"], value: candidate.notificationEvents });
        }
        if (candidate.observerPreferred !== source.observerPreferred) {
          ops.push({ op: "set", path: ["observerPreferred"], value: candidate.observerPreferred });
        }
        if (candidate.roleConcurrencyLimit !== source.roleConcurrencyLimit) {
          ops.push({ op: "set", path: ["roleConcurrencyLimit"], value: candidate.roleConcurrencyLimit });
        }
        // 角色默认超时（票据 06）：只有真正变化才写 op，避免一次无关保存把
        // 用户已保存的值重置回 0。
        if (candidate.roleTimeoutMs !== source.roleTimeoutMs) {
          ops.push({ op: "set", path: ["roleTimeoutMs"], value: candidate.roleTimeoutMs });
        }
        // 任务管理开关单独成一个保存 op，只用于判定「是否真的需要提交」；
        // 新客户端的完整候选始终显式携带该字段，Host 按「显式字段才写 patch」处理。
        if (candidate.taskManagementEnabled !== source.taskManagementEnabled) {
          ops.push({ op: "set", path: ["taskManagementEnabled"], value: candidate.taskManagementEnabled });
        }
        // 自动打开与任务管理同一形状：新客户端的完整候选始终显式携带该字段，
        // Host 按「显式字段才写 patch」处理，旧客户端缺字段因此不可能覆盖它。
        if (candidate.autoOpenSubagentSidebar !== source.autoOpenSubagentSidebar) {
          ops.push({ op: "set", path: ["autoOpenSubagentSidebar"], value: candidate.autoOpenSubagentSidebar });
        }
        if (promptChanged) {
          ops.push({ op: "set", path: ["promptOverrides"], value: candidatePromptOverrides });
        }
        /**
         * 变更集（票据 20，settings-commit 的可选协议字段 `changed`）。
         *
         * 顶层字段直接由 ops 推导（只有真的变化才会产生 op）；模型字段进一步细化到
         * 角色级 `defaults.<role>`，让 Host 只对真正变化的角色做真实目录解析，而不是把
         * 整份 defaults 重新解析一遍（存量失效模型因此不再阻塞无关字段的保存）。
         * 候选本身仍是**完整值**：`changed` 只描述"哪些字段变了"，不改变 replace 语义。
         */
        const changed = [];
        if (modelChanged) {
          // 顶层统一供应商只在值真的变了时报出（模型解析本身不需要它，它只是模型字段）。
          if (candidate.provider !== sourceProvider) changed.push("provider");
          for (const role of Object.keys(candidate.defaults)) {
            if (!settingsDraftEqual(candidate.defaults[role], source.defaults[role])) changed.push("defaults." + role);
          }
          // 被删除的角色默认行同样是一次模型变更（defaults 是整份映射替换）：列出来才能让
          // Host 区分「没有模型变更」与「删掉了一行」。
          for (const role of Object.keys(source.defaults)) {
            if (!Object.prototype.hasOwnProperty.call(candidate.defaults, role)) changed.push("defaults." + role);
          }
        }
        for (const op of ops) {
          const field = op.path[0];
          // provider/defaults 已按上面的模型字段粒度上报，避免同一变更重复出现。
          if (field === "defaults" || field === "provider") continue;
          changed.push(field);
        }
        // 票据 24：候选变更按角色上报（candidates + candidates.<role>），Host 因此只解析
        // 真正变化的角色；fallbackLimit 只在值真的变了才上报。
        if (candidatesChanged) {
          changed.push("candidates");
          for (const role of new Set([...Object.keys(candidateCandidates), ...Object.keys(sourceCandidates)])) {
            if (!settingsDraftEqual(candidateCandidates[role] ?? null, sourceCandidates[role] ?? null)) changed.push("candidates." + role);
          }
        }
        if (fallbackLimitChanged) changed.push("fallbackLimit");
        /**
         * 详情页的首次提交固定使用进入编辑器的 revision（审查修复 P1），不再只对提示词生效。
         *
         * 这样外部 revision 推进一定会先触发 CAS 冲突，而不是被实时 revision「追上」后
         * 静默覆盖外部修改；明确重试时才使用当前 snapshot revision（用户已看到冲突）。
         */
        const expectedRevision = retry === true || selectedPromptRole === null || !Number.isSafeInteger(editorBaseline?.revision)
          ? settingsSnapshot.revision
          : editorBaseline.revision;
        setSaving(true);
        setSaved(false);
        setError(null);
        setPromptError(null);
        try {
          let accepted;
          let committed = null;
          // 票据 24：候选/降级不在 ops 里（它们不是默认值 op），但同样需要真实提交；
          // 任一特殊字段变化都必须走 settings-commit，而不是只把快照当成已保存。
          if (ops.length > 0 || candidatesChanged || fallbackLimitChanged) {
            // 角色配置唯一写入路径：DEG 自有提交端点（Host commitSettingsCandidate 完成
            // schema、语义与 revision CAS 校验）。绝不调用配置表单的 set/unset/mutate：
            // 那会绕过 DEG 的提示词语义校验与模型目录代次检测。
            // 共享镜像会随 settings/document-updated 自行刷新，无需本地推进 revision。
            committed = await commitSettingsCandidate(candidate, expectedRevision, globalThis.fetch, ctx?.connection, roles, changed);
            accepted = committed.settings;
          } else {
            accepted = normalizeSettingsCommitDraft(settingsForm.getSnapshot().value, roles);
          }
          // Host 已在同一提交边界完成 schema、模型和 revision 校验；200 响应中的
          // committed settings 是权威归一结果，不再与客户端草稿做易误报的 JSON 全量比较。
          // 响应里的 promptOverrides 可能被归一函数按**旧角色表**裁剪过：
          // 以本次候选为基底合并，保证刚保存的提示词覆盖不被丢弃。
          const acceptedPromptOverrides = normalizePromptOverrides(
            Object.prototype.hasOwnProperty.call(accepted ?? {}, "promptOverrides")
              ? { ...candidatePromptOverrides, ...accepted.promptOverrides }
              : candidatePromptOverrides,
            promptMaxGraphemes,
            promptRoleIds,
          );
          /**
           * Host 只回显本次真正写入的字段（未变化的字段被删掉），
           * 因此保存成功后要为新字段回落本次候选/源值，避免控件在下一次 settings
           * 快照到达前短暂变空——那会让用户以为自己的配置被抹掉了。
           */
          const acceptedDraft = accepted !== null && typeof accepted === "object" ? { ...accepted } : accepted;
          if (acceptedDraft !== null && typeof acceptedDraft === "object") {
            const keepNewField = (field, hadField, value) => {
              if (Object.prototype.hasOwnProperty.call(acceptedDraft, field)) return;
              if (hadField !== true) return;
              acceptedDraft[field] = value;
            };
            // 候选与降级上限（票据 24）：Host 只回显本次真正写入的字段，详情页的候选
            // 不能因此在快照追上之前短暂清空（沿用上面同一个 keepNewField 模式）。
            keepNewField("candidates",
              candidatesChanged || Object.prototype.hasOwnProperty.call(source, "candidates"),
              candidatesChanged ? candidateCandidates : sourceCandidates);
            keepNewField("fallbackLimit",
              fallbackLimitChanged || Object.prototype.hasOwnProperty.call(source, "fallbackLimit"),
              fallbackLimitChanged
                ? (typeof candidateFallbackLimit === "number" ? candidateFallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT)
                : sourceFallbackLimit);
          }
          setDraft(acceptedDraft);
          setPromptDrafts({});
          setPromptTouched({});
          setCandidatesError(null);
          const committedRevision = Number.isSafeInteger(committed?.revision)
            ? committed.revision
            : settingsSnapshot.revision;
          /**
           * 审查修复 P2：记录本次成功提交的权威文档。
           *
           * 共享镜像可能滞后于提交响应；滞后期间 dirty 比较、保存按钮与同步 effect
           * 都以这份 accepted 草稿为准，避免"刚保存就重新变脏"或旧快照把草稿重置。
           */
          committedAuthorityRef.current = { revision: committedRevision, value: acceptedDraft };
          const responseProjection = normalizeRolePromptProjection(committed?.rolePrompts, accepted, true, promptRoleIds);
          let acceptedProjection = responseProjection ?? promptProjection;
          if (acceptedProjection !== null) {
            for (const role of promptTouchedRoles) {
              const entry = promptEntryOf(acceptedProjection, role);
              const text = Object.prototype.hasOwnProperty.call(acceptedPromptOverrides, role)
                ? acceptedPromptOverrides[role]
                : entry?.defaultPersona ?? promptTextOf(role);
              acceptedProjection = updateRolePromptProjection(acceptedProjection, role, text);
            }
            setLocalPromptProjection({ revision: committedRevision, projection: acceptedProjection });
          }
          if (selectedPromptRole !== null) {
            // 提交响应已经是 Host 权威状态，立即更新编辑基线；共享镜像随后自行刷新，
            // 直到更高或相等的外部 snapshot 到达后再自然让位。不依赖投影是否可用：
            // 投影缺失时提示词区只读，但候选/降级等草稿仍需要正确的比较基线。
            setEditorBaseline({
              role: selectedPromptRole,
              // 与 setDraft 用同一份文档：keepNewField 补齐的字段也属于基线，
              // 否则"刚保存的候选"会被基线与草稿比较误判成本地改动。
              value: acceptedDraft,
              revision: committedRevision,
              projection: acceptedProjection ?? editorBaseline?.projection ?? null,
            });
          }
          setSettingsConflict(null);
          setExternalSettingsChanged(false);
          setDirty(false);
          setSaved(true);
          return true;
        } catch (cause) {
          // 冲突后绝不伪装“已同步”：必须等待共享镜像提供最新完整 snapshot，
          // 再由用户选择加载或明确重试，避免 revision 已变而候选仍是旧文档。
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message);
          if (cause?.code === "settings-conflict") {
            setSettingsConflict({ revision: cause.currentRevision, message });
          }
          if (promptTouchedRoles.length > 0) setPromptError(message);
          return false;
        } finally {
          setSaving(false);
        }
      };

      const discard = () => {
        const snapshot = settingsForm.getSnapshot();
        // 放弃修改要回到"已保存"的状态：快照滞后时 authorityValue 才是刚提交的 accepted。
        const refreshedProjection = normalizeRolePromptProjection(hostMeta?.rolePrompts, authorityValue, true, promptRoleIds) ?? promptProjection;
        setDraft(normalizeSettingsDraft(authorityValue, roles));
        setCandidatesError(null);
        // 重新加载时清空局部草稿，让 Host 当前 effective/default 成为编辑初值。
        setPromptDrafts({});
        setPromptTouched({});
        if (selectedPromptRole !== null && refreshedProjection !== null) {
          setEditorBaseline({
            role: selectedPromptRole,
            value: authorityValue,
            revision: Number.isSafeInteger(committedAuthorityRef.current?.revision) && committedSnapshotLagging
              ? committedAuthorityRef.current.revision
              : (Number.isSafeInteger(snapshot.revision) ? snapshot.revision : null),
            projection: refreshedProjection,
          });
        }
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      };

      const loadLatestPromptSettings = () => {
        const snapshot = settingsForm.getSnapshot();
        if (settingsConflict?.revision !== undefined
          && (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < settingsConflict.revision)) {
          setPromptError("最新配置尚未到达，请稍后再加载");
          return;
        }
        const projection = normalizeRolePromptProjection(hostMeta?.rolePrompts, snapshot.value, true, promptRoleIds) ?? promptProjection;
        if (selectedPromptRole === null || projection === null) {
          setPromptError("最新提示词配置不可用，请稍后重试");
          return;
        }
        setLocalPromptProjection(null);
        setDraft(normalizeSettingsDraft(snapshot.value, roles));
        setPromptDrafts({});
        setPromptTouched({});
        setEditorBaseline({ role: selectedPromptRole, value: snapshot.value, revision: snapshot.revision, projection });
        setDirty(false);
        setSaved(false);
        setError(null);
        setPromptError(null);
        setSettingsConflict(null);
        setExternalSettingsChanged(false);
      };

      const retryPromptSave = async () => {
        if (settingsConflict?.revision !== undefined
          && (!Number.isSafeInteger(settingsSnapshot.revision) || settingsSnapshot.revision < settingsConflict.revision)) {
          setPromptError("最新配置尚未到达，请先加载最新配置");
          return false;
        }
        return save({ retry: true });
      };

      const restorePromptDefault = () => {
        const role = selectedPromptRole;
        const entry = promptEntryOf(baselineProjection, role);
        if (role === null || entry === null || settingsReadOnly || saving || baselineProjection?.customizable !== true) return;
        if (promptDirty) {
          leaveTriggerRef.current = typeof document === "undefined" ? null : document.activeElement;
          setLeaveIntent({ kind: "restore-default", role });
          return;
        }
        editPromptText(role, entry.defaultPersona);
      };

      // 三态渲染（0.1.7-alpha.2 的 ConfigFormSnapshot.status）：
      // - `loading`：首次读取尚未落定（value 仍是 undefined），只给可读的加载提示，
      //   绝不用空值渲染整张表单（否则会把「还没读到」显示成「配置为空」）；
      // - `unavailable`：条目未暴露给本客户端或远端 memory 模式，给可读的不可用提示；
      // - `ready`（含远端 memory 但已读到值）：渲染完整表单，写权限由整页 writable 决定。
      if (settingsSnapshot.status === "loading") {
        return react.createElement("div", { className: "deg_settings" },
          selectedPromptRole === null ? null : react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("p", { className: "deg_settings_status", role: "status", "aria-live": "polite" }, "正在读取设置…"));
      }

      if (settingsSnapshot.status === "unavailable") {
        return react.createElement("div", { className: "deg_settings" },
          selectedPromptRole === null ? null : react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("p", { className: "deg_settings_error", role: "status" }, "设置 namespace 不可用"));
      }

      const selectedPromptEntry = promptEntryOf(promptProjection, selectedPromptRole);
      const selectedPromptText = selectedPromptRole === null ? "" : promptTextOf(selectedPromptRole);
      const promptValidation = validatePromptText(selectedPromptText, promptMaxGraphemes);
      const promptCounterClass = promptValidation.count > promptMaxGraphemes
        ? " deg_prompt_counter_error"
        : promptValidation.count >= promptMaxGraphemes * PROMPT_WARNING_RATIO
          ? " deg_prompt_counter_warning"
          : "";
      const promptMetaMessage = hostMetaError
        ?? (promptProjection === null && !promptLoading ? "提示词配置不可用，请刷新后重试" : null);
      const promptStatusMessage = promptMetaMessage
        ?? (settingsReadOnly ? "当前设置为只读，可查看提示词但不能编辑或保存。" : null);
      // 文本变化即校验，不必点击保存才让辅助技术得知空值或超长输入。
      const promptValidationMessage = selectedPromptRole !== null && !promptValidation.ok ? promptValidation.message : null;
      const promptErrorMessage = promptError ?? promptValidationMessage ?? error ?? promptMetaMessage;
      const promptLabel = selectedPromptRole === null
        ? "专家"
        : roleLabelOf(selectedPromptRole);
      const promptEditor = selectedPromptRole === null ? null : react.createElement("div", { className: "deg_settings deg_settings_prompt_editor" },
        react.createElement("div", { className: "deg_prompt_header" },
          react.createElement("h2", { className: "deg_settings_title" }, promptLabel)),
        react.createElement("label", { className: "deg_prompt_label", htmlFor: "deg-prompt-textarea-" + selectedPromptRole }, "提示词"),
        promptProjection === null
          ? react.createElement(react.Fragment, null,
            react.createElement("p", { className: "deg_prompt_status", role: "status", "aria-live": "polite" }, promptStatusMessage ?? "提示词配置加载中…"),
            promptLoading ? null : react.createElement("button", {
              type: "button",
              className: "deg_btn",
              disabled: saving,
              onClick: refreshHostMeta,
            }, "重试加载提示词配置"))
          : react.createElement(react.Fragment, null,
            react.createElement("textarea", {
              id: "deg-prompt-textarea-" + selectedPromptRole,
              className: "deg_prompt_textarea",
              "data-deg-prompt-role": selectedPromptRole,
              "aria-label": promptLabel + "提示词",
              "aria-describedby": "deg-prompt-counter-" + selectedPromptRole
                + (promptErrorMessage === null ? "" : " deg-prompt-error-" + selectedPromptRole),
              "aria-invalid": !promptValidation.ok || promptErrorMessage !== null,
              value: selectedPromptText,
              disabled: settingsReadOnly || saving || promptProjection.customizable !== true,
              onChange: (event) => {
                const text = typeof event?.target?.value === "string" ? event.target.value : "";
                editPromptText(selectedPromptRole, text);
              },
            }),
            react.createElement("div", {
              id: "deg-prompt-counter-" + selectedPromptRole,
              className: "deg_prompt_counter" + promptCounterClass,
              role: "status",
              "aria-live": "polite",
            }, String(promptValidation.count) + " / " + String(promptMaxGraphemes)),
            promptStatusMessage === null ? null : react.createElement("p", { className: "deg_prompt_status", role: "status" }, promptStatusMessage)),
        // 候选区块按要求整块删除：详情页只保留提示词编辑，候选统一在设置页页签里维护。
        promptErrorMessage === null ? null : react.createElement("p", {
          id: "deg-prompt-error-" + selectedPromptRole,
          className: "deg_settings_error",
          role: "alert",
          "aria-live": "assertive",
        }, promptErrorMessage),
        externalSettingsChanged ? react.createElement("p", {
          className: "deg_prompt_status",
          role: "status",
          "aria-live": "polite",
        }, "配置已发生外部变化") : null,
        settingsConflict === null ? null : react.createElement("div", { className: "deg_prompt_conflict", role: "alert" },
          react.createElement("p", { className: "deg_settings_error" }, "保存遇到配置冲突，请选择下一步。"),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", { type: "button", className: "deg_btn", disabled: saving, onClick: loadLatestPromptSettings }, "加载最新配置"),
            react.createElement("button", { type: "button", className: "deg_btn deg_btn_primary", disabled: saving, onClick: retryPromptSave }, "继续使用当前修改重试"))),
        react.createElement("div", { className: "deg_prompt_footer" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_prompt_back",
            "aria-label": "返回专家列表",
            disabled: saving,
            onClick: closePrompt,
          }, "返回专家列表"),
          react.createElement("span", { className: "deg_prompt_status", role: "status", "aria-live": "polite" }, saved ? "已保存" : hasUnsavedChanges ? "有未保存的修改" : ""),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary",
            // 详情页与列表页共用"有未保存修改"判定（提示词/候选/降级/通知等），其余门控不变。
            disabled: !hasUnsavedChanges || !promptValidation.ok || saving
              || settingsReadOnly || promptLoading || baselineProjection?.customizable !== true,
            onClick: save,
          }, saving ? "保存中…" : "保存"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn",
            disabled: saving || settingsReadOnly || promptLoading || promptProjection?.customizable !== true
              || selectedPromptEntry === null || selectedPromptText === selectedPromptEntry.defaultPersona,
            onClick: restorePromptDefault,
          }, "恢复默认")));
      const leaveDialog = leaveIntent === null ? null : react.createElement("div", { className: "deg_prompt_dialog_backdrop" },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "未保存的修改",
          onKeyDown: (event) => {
            if (event.key === "Escape") {
              event.preventDefault?.();
              dismissLeaveDialog();
              return;
            }
            if (event.key !== "Tab") return;
            const controls = Array.from(event.currentTarget?.querySelectorAll?.("[data-deg-dialog-action]") ?? []);
            if (controls.length === 0) return;
            const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
            const nextIndex = event.shiftKey
              ? (current <= 0 ? controls.length - 1 : current - 1)
              : (current >= controls.length - 1 ? 0 : current + 1);
            event.preventDefault?.();
            try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
          },
        },
          react.createElement("h3", null, "未保存的修改"),
          react.createElement("p", null, "离开前请选择如何处理当前草稿。"),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            leaveIntent.kind === "restore-default"
              ? react.createElement("button", {
                type: "button",
                className: "deg_btn deg_btn_primary",
                "data-deg-dialog-action": "restore",
                disabled: saving,
                onClick: () => {
                  const role = leaveIntent.role;
                  const entry = promptEntryOf(baselineProjection, role);
                  dismissLeaveDialog();
                  if (entry !== null) editPromptText(role, entry.defaultPersona);
                },
              }, "恢复默认")
              : react.createElement("button", {
                type: "button",
                className: "deg_btn deg_btn_primary",
                "data-deg-dialog-action": "save",
                disabled: saving,
                onClick: async () => {
                  const savedNow = await save();
                  if (savedNow !== true) return;
                  const intent = leaveIntent;
                  dismissLeaveDialog();
                  applyPromptNavigation(intent?.role ?? null);
                },
              }, saving ? "保存中…" : "保存并离开"),
            leaveIntent.kind === "restore-default" ? null : react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "discard",
              disabled: saving,
              onClick: () => {
                const intent = leaveIntent;
                discard();
                dismissLeaveDialog();
                applyPromptNavigation(intent?.role ?? null);
              },
            }, "放弃修改"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              autoFocus: true,
              ref: leaveCancelRef,
              onClick: dismissLeaveDialog,
            }, "取消"))));
      react.useEffect(() => {
        if (leaveIntent === null) return;
        try { leaveCancelRef.current?.focus?.(); } catch { /* 不支持 focus 的嵌入宿主仍可键盘点击。 */ }
      }, [leaveIntent]);
      if (selectedPromptRole !== null) return react.createElement(react.Fragment, null, promptEditor, leaveDialog);

      const header = react.createElement(react.Fragment, null,
        react.createElement("span", { className: "deg_settings_table_head" }, "专家"),
        react.createElement("span", { className: "deg_settings_table_head" }, "供应商"),
        react.createElement("span", { className: "deg_settings_table_head" }, "模型选择"),
        react.createElement("span", { className: "deg_settings_table_head" }, "思考深度"));
      // 行级三个下拉的**目录门控**统一走 catalogAvailable（ready 或已有缓存目录）：
      // 刷新中的 loading、以及最新一次刷新失败后的 error，都只代表"内容可能不是最新"，
      // 只要缓存目录还在，里面的 provider/model/思考深度就仍然是用户可选的合法值；
      // 而首次挂载（还没有任何成功目录）与 connection/reset 清空目录之后 groups 为空，
      // catalogAvailable 为 false，三个下拉和保存按钮一并禁用。
      // 业务禁用条件（saving / roleEnabled / 没有 provider、model、reasoning）保持不变。
      const rows = modelRowRoles.map((role) => {
        const roleLabel = roleLabelOf(role);
        const roleEnabled = roles.includes(role);
        // 单元格一律读写**当前页**对应的层：主模型页 → defaults，候选页 → candidates[i - 1]。
        const selection = modelLayerSelectionOf(draft, role, currentModelPage);
        const rowProvider = typeof selection?.provider === "string" ? selection.provider : "";
        const rowProviderGroup = providerGroups.find((group) => group.id === rowProvider);
        const rowModels = rowProviderGroup?.models ?? [];
        const currentModel = rowModels.find((model) => model.id === selection?.model);
        const providerOptions = [
          react.createElement("option", { key: "__empty-provider", value: "" }, "未选择供应商"),
          ...(rowProvider && rowProviderGroup === undefined
            ? [react.createElement("option", { key: "__unavailable-provider", value: rowProvider, disabled: true }, rowProvider + "（不可用）")]
            : []),
          ...providerGroups.map((group) => react.createElement("option", { key: group.id, value: group.id }, group.name ?? group.id)),
        ];
        const modelOptions = [];
        if (!rowProvider) {
          modelOptions.push(react.createElement("option", { key: "__provider", value: "" }, "先选择供应商"));
        } else {
          modelOptions.push(react.createElement("option", { key: "__empty", value: "" }, "未选择模型"));
          if (selection?.model && currentModel === undefined) {
            modelOptions.push(react.createElement("option", { key: "__unavailable", value: selection.model, disabled: true }, selection.model + "（不可用）"));
          }
          for (const model of rowModels) {
            modelOptions.push(react.createElement("option", { key: model.id, value: model.id }, model.name ?? model.id));
          }
        }
        const reasoning = currentModel?.reasoning;
        const effortOptions = [];
        if (reasoning) {
          effortOptions.push(react.createElement("option", { key: "__default", value: "" }, "模型默认"));
          for (const effort of reasoning.efforts ?? []) {
            effortOptions.push(react.createElement("option", { key: effort.id, value: effort.id }, effort.name ?? effort.id));
          }
        } else {
          effortOptions.push(react.createElement("option", { key: "__unsupported", value: "" }, rowProvider ? "模型无思考深度" : "先选择模型"));
        }
        const updateProvider = (event) => {
          const provider = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            const currentProvider = typeof current?.provider === "string" ? current.provider : "";
            // 选中同一个供应商 = 没有变化：不制造脏值。
            if (provider === currentProvider) return previous;
            if (currentModelPage === 0) {
              // 主模型页：沿用历史语义——空值删掉该行，换供应商按显示名迁移同名模型。
              const next = !provider
                ? null
                : (migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" });
              // 行级 provider 一旦存在就拥有优先权，顶层统一值顺带清空。
              return { ...setModelLayerSelection(previous, role, 0, next), provider: "" };
            }
            // 候选页：与主模型页同一套联动，只作用于当前层；空值 = 清空该层该角色。
            const next = !provider
              ? { provider: "", model: "" }
              : (migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" });
            return setModelLayerSelection(previous, role, currentModelPage, next);
          });
        };
        const updateModel = (event) => {
          const modelId = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            const provider = typeof current?.provider === "string" ? current.provider : "";
            if (!provider) return previous;
            if (!modelId) {
              // 清空模型保留 provider（用户可以先选供应商再选模型）。
              if (typeof current?.model === "string" && current.model.length === 0) return previous;
              return setModelLayerSelection(previous, role, currentModelPage, { provider, model: "" });
            }
            const model = providerGroups.find((group) => group.id === provider)?.models?.find((candidate) => candidate.id === modelId);
            if (!model) return previous;
            const selected = { provider, model: model.id };
            // 与既有角色表一致：目录声明 defaultEffort 时才带思考深度，否则保持未指定。
            if (typeof model.reasoning?.defaultEffort === "string") selected.reasoningEffort = model.reasoning.defaultEffort;
            return setModelLayerSelection(previous, role, currentModelPage, selected);
          });
        };
        const updateReasoning = (event) => {
          const effort = event.target.value;
          editDraft((previous) => {
            const current = modelLayerSelectionOf(previous, role, currentModelPage);
            if (current === null || typeof current.model !== "string" || current.model.length === 0) return previous;
            const next = { ...current };
            // 空值 = 删除字段（模型默认），与既有角色表一致。
            if (effort) next.reasoningEffort = effort;
            else delete next.reasoningEffort;
            if (next.reasoningEffort === current.reasoningEffort) return previous;
            return setModelLayerSelection(previous, role, currentModelPage, next);
          });
        };
        // 提示词入口只对 Host 投影声明的角色开放（只应是内置角色）；投影缺失时
        // 仍是内置六角色，历史行为不变。
        const promptEntryAvailable = promptRoleIds.includes(role);
        return react.createElement(react.Fragment, { key: role },
          react.createElement("div", { className: "deg_settings_table_cell deg_settings_role_cell" },
            promptEntryAvailable
              ? react.createElement("button", {
                type: "button",
                className: "deg_settings_role_button",
                "data-deg-prompt-role": role,
                "aria-label": roleLabel + "提示词"
                  + (promptEntryOf(promptProjection, role)?.customized === true ? "（已自定义提示词）" : ""),
                "aria-pressed": selectedPromptRole === role,
                // 读取失败仍可进入错误页并重试；只有正在提交时才锁住入口，避免永久死锁。
                disabled: saving,
                onClick: (event) => openPrompt(role, event),
              },
                react.createElement("span", null, roleLabel),
                promptEntryOf(promptProjection, role)?.customized === true
                  ? react.createElement("span", {
                    className: "deg_settings_prompt_customized_dot",
                    "aria-hidden": "true",
                  })
                  : null)
              : react.createElement("span", { className: "deg_settings_label", "data-deg-role-label": role }, roleLabel),
          ),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_provider_select",
              "aria-label": roleLabel + " 供应商",
              value: rowProvider,
              disabled: saving || !catalogAvailable || !roleEnabled,
              onChange: updateProvider,
            }, providerOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_model_select",
              "aria-label": roleLabel + " 模型选择",
              value: selection?.model ?? "",
              disabled: saving || !catalogAvailable || !roleEnabled || !rowProvider || rowProviderGroup === undefined,
              onChange: updateModel,
            }, modelOptions)),
          react.createElement("div", { className: "deg_settings_table_cell" },
            react.createElement("select", {
              className: "deg_settings_effort_select",
              "aria-label": roleLabel + " 思考深度",
              value: selection?.reasoningEffort ?? "",
              disabled: saving || !catalogAvailable || !roleEnabled || reasoning === undefined || !selection?.model,
              onChange: updateReasoning,
            }, effortOptions)));
      });

      const modelConfigSection = typeof modelConfigHost === "undefined" || modelConfigHost === null
        ? null
        : react.createElement(ModelConfigSection, {
          host: modelConfigHost,
          roleDefaults: normalizeSettingsDraft(settingsSnapshot.value, roles).defaults,
          roleLabelOf,
        });
      // 自动降级上限的展示值：草稿有合法整数就用草稿，否则显示默认 2（与草稿归一同一口径）。
      const fallbackLimitDraft = Number.isSafeInteger(draft.fallbackLimit) ? draft.fallbackLimit : DEFAULT_MODEL_FALLBACK_LIMIT;
      // 「通知事件」下拉的实时计数与可访问名称：数字语言无关，只随勾选变化；展开/收起不参与计算。
      const notificationEventsEnabledCount = NOTIFICATION_EVENT_TYPES.filter(
        (type) => draft.notificationEvents[type] === true,
      ).length;
      const notificationEventsTriggerLabel = t("settings.notificationEvents") + " (" + notificationEventsEnabledCount + ")";
      /**
       * 页签行（票据 24 重排）：主模型 / 候选1..3 / +。
       *
       * - 页签名只由位置推导，拖动重排不会改名；
       * - 候选页页签带 ×（主模型页不显示 ×），点击打开确认框；
       * - 拖动时在插入边界渲染一条 2px 落点竖条（data-deg-model-tab-drop）；
       * - 达到 4 页后 + 禁用（title 说明上限），与 MAX_MODEL_PAGES 同一口径。
       */
      const modelTabChildren = [];
      for (let page = 0; page < modelPageCount; page += 1) {
        if (modelTabDrag?.active === true && modelTabDrag.dropIndex === page) {
          modelTabChildren.push(react.createElement("span", {
            key: "drop-" + page,
            className: "deg_settings_model_tab_drop",
            "data-deg-model-tab-drop": String(page),
            "aria-hidden": "true",
          }));
        }
        const label = modelPageLabelOf(page);
        const selected = page === currentModelPage;
        const dragging = modelTabDrag?.active === true && modelTabDrag.page === page;
        modelTabChildren.push(react.createElement("div", {
          key: "page-" + page,
          ref: (node) => { modelTabRefs.current[page] = node; },
          className: "deg_settings_model_tab",
          role: "tab",
          // 页签是 div[role=tab]（内部还有 × 按钮，不能嵌套 button）；键盘用 Enter/Space 切换。
          tabIndex: selected ? 0 : -1,
          "aria-selected": selected,
          "data-deg-model-tab": page,
          "data-dragging": dragging ? "true" : void 0,
          title: label,
          onPointerDown: (event) => beginModelTabDrag(page, event),
          onClick: () => selectModelPage(page),
          onKeyDown: (event) => {
            if (event?.key !== "Enter" && event?.key !== " ") return;
            event.preventDefault?.();
            selectModelPage(page);
          },
        },
          react.createElement("span", { className: "deg_settings_model_tab_label" }, label),
          page === 0 ? null : react.createElement("button", {
            type: "button",
            className: "deg_settings_model_tab_remove",
            "data-deg-model-tab-remove": page,
            "aria-label": label + " " + tExtra("settings.modelTabs.remove"),
            disabled: saving || settingsReadOnly,
            // × 自己处理点击，绝不触发页签切换/拖动。
            onPointerDown: (event) => event?.stopPropagation?.(),
            onClick: (event) => {
              event?.stopPropagation?.();
              requestModelPageDelete(page);
            },
          }, "×")));
      }
      if (modelTabDrag?.active === true && modelTabDrag.dropIndex === modelPageCount) {
        modelTabChildren.push(react.createElement("span", {
          key: "drop-end",
          className: "deg_settings_model_tab_drop",
          "data-deg-model-tab-drop": String(modelPageCount),
          "aria-hidden": "true",
        }));
      }
      modelTabChildren.push(react.createElement("button", {
        key: "add-page",
        type: "button",
        className: "deg_settings_model_tab_add",
        "data-deg-model-tab-add": "true",
        "aria-label": tExtra("settings.modelTabs.add"),
        title: modelPageCount >= MAX_MODEL_PAGES ? tExtra("settings.modelTabs.limit") : tExtra("settings.modelTabs.add.title"),
        disabled: saving || settingsReadOnly || modelPageCount >= MAX_MODEL_PAGES,
        onClick: () => addModelPage(),
      }, "+"));
      const modelTabRow = react.createElement("div", {
        className: "deg_settings_model_tabs",
        "data-deg-model-tabs": "true",
        role: "tablist",
        "aria-label": tExtra("settings.modelTabs.primary") + " / " + tExtra("settings.modelTabs.candidate", { index: MAX_MODEL_CANDIDATES_PER_ROLE }),
      }, modelTabChildren);
      /**
       * 删除候选页确认框：复用未保存弹窗的 `deg_prompt_dialog_backdrop` / `deg_prompt_dialog`
       * 与 `data-deg-dialog-action` 键位模式；打开后焦点落在「取消」。
       * 文案说明会影响六个角色在该层的配置，避免用户以为只删一个角色。
       */
      const modelPageDeleteDialog = modelPageDeleteIntent === null ? null : react.createElement("div", {
        className: "deg_prompt_dialog_backdrop",
        onClick: () => cancelModelPageDelete(),
      },
        react.createElement("div", {
          className: "deg_prompt_dialog",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": tExtra("settings.modelTabs.remove.title"),
          onClick: (event) => event?.stopPropagation?.(),
          onKeyDown: (event) => {
            if (event?.key === "Escape") {
              event.preventDefault?.();
              event.stopPropagation?.();
              cancelModelPageDelete();
              return;
            }
            if (event?.key !== "Tab") return;
            const controls = Array.from(event.currentTarget?.querySelectorAll?.("[data-deg-dialog-action]") ?? []);
            if (controls.length === 0) return;
            const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
            const nextIndex = event.shiftKey
              ? (current <= 0 ? controls.length - 1 : current - 1)
              : (current >= controls.length - 1 ? 0 : current + 1);
            event.preventDefault?.();
            try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击按钮。 */ }
          },
        },
          react.createElement("h3", null, tExtra("settings.modelTabs.remove.title")),
          react.createElement("p", null, tExtra("settings.modelTabs.remove.message", { index: modelPageDeleteIntent.page })),
          react.createElement("div", { className: "deg_prompt_dialog_actions" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              "data-deg-model-tab-delete-cancel": "true",
              // 破坏性动作不抢默认焦点。
              autoFocus: true,
              ref: modelPageDeleteCancelRef,
              disabled: saving,
              onClick: () => cancelModelPageDelete(),
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              "data-deg-dialog-action": "confirm",
              "data-deg-model-tab-delete-confirm": "true",
              disabled: saving,
              onClick: () => confirmModelPageDelete(),
            }, "删除"))));
      return react.createElement("div", { className: "deg_settings" },
        react.createElement("h2", { className: "deg_settings_title" }, t("settings.title")),
        react.createElement("p", { className: "deg_settings_hint" }, t("settings.hint")),
        modelConfigSection,
        react.createElement("div", { className: "deg_settings_row deg_settings_task_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": t("settings.taskManagement"),
              checked: draft.taskManagementEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, taskManagementEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.taskManagement"))),
          // 「Auto」自动打开运行中的子代理右侧栏会话；维持原悬浮说明与保存绑定。
          react.createElement("label", { className: "deg_settings_checkbox", title: t("settings.autoTitle") },
            react.createElement("input", {
              type: "checkbox",
              "aria-label": t("settings.auto"),
              checked: draft.autoOpenSubagentSidebar,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, autoOpenSubagentSidebar: event.target.checked === true })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.auto")))),
        react.createElement("div", { className: "deg_settings_row deg_settings_notification_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", {
              type: "checkbox",
              checked: draft.notificationEnabled,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationEnabled: event.target.checked })),
            }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.notifications"))),
          // 停留时长字段已按票据 14 移除：Windows Toast 的展示时长由系统策略决定，
          // 旧配置里的该字段在读取/提交边界被忽略，不迁移、不报错。
          // 两个输入控件分别提供可访问名称，避免一个 label 同时包裹多个可标记控件。
          react.createElement("div", { className: "deg_settings_control" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.notificationVolume")),
            react.createElement("input", {
              id: "deg-settings-notification-volume-range",
              type: "range", min: 0, max: 100, step: 1,
              "aria-label": t("settings.notificationVolume.range"),
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            }),
            react.createElement("input", {
              id: "deg-settings-notification-volume-number",
              type: "number", min: 0, max: 100, step: 1,
              "aria-label": t("settings.notificationVolume.number"),
              value: draft.notificationVolume,
              disabled: saving,
              onChange: (event) => editDraft((previous) => ({ ...previous, notificationVolume: clampNotificationVolume(event.target.value) })),
            })),
          // 「通知事件」多选下拉（布局调整）：三个类别固定，展开后才渲染复选框。
          // 勾选只写 draft.notificationEvents；展开/收起不触碰草稿，也不触发保存。
          react.createElement("div", { className: "deg_settings_events_dropdown", ref: notificationEventsRootRef },
            react.createElement("button", {
              type: "button",
              className: "deg_settings_events_trigger",
              id: "deg-settings-notification-events-trigger",
              ref: notificationEventsTriggerRef,
              // 可访问名称与可见文字一致（含实时计数）；面板展开状态与归属用 ARIA 表达。
              "aria-label": notificationEventsTriggerLabel,
              "aria-haspopup": "true",
              "aria-expanded": notificationEventsOpen ? "true" : "false",
              "aria-controls": "deg-settings-notification-events-panel",
              disabled: saving,
              onClick: () => setNotificationEventsOpen((previous) => !previous),
            },
              react.createElement("span", { className: "deg_settings_events_label" }, t("settings.notificationEvents")),
              react.createElement("span", { className: "deg_settings_events_count", "aria-hidden": "true" }, "(" + notificationEventsEnabledCount + ")"),
              react.createElement("span", { className: "deg_settings_events_caret", "aria-hidden": "true" }, "▾")),
            notificationEventsOpen
              ? react.createElement("div", {
                className: "deg_settings_events_panel",
                id: "deg-settings-notification-events-panel",
                ref: notificationEventsPanelRef,
                role: "group",
                "aria-label": t("settings.notificationEvents"),
              }, NOTIFICATION_EVENT_TYPES.map((type) => react.createElement("label", { key: type, className: "deg_settings_checkbox" },
                react.createElement("input", {
                  type: "checkbox",
                  "aria-label": t("settings.notificationEvent." + type + ".aria"),
                  checked: draft.notificationEvents[type] === true,
                  disabled: saving,
                  onChange: (event) => editDraft((previous) => ({
                    ...previous,
                    notificationEvents: { ...previous.notificationEvents, [type]: event.target.checked === true },
                  })),
                }),
                react.createElement("span", { className: "deg_settings_label" }, t("settings.notificationEvent." + type)))))
              : null)),
        // 统一供应商与自动降级上限合为一行：两组左对齐、组间距 32px，标签紧贴各自控件。
        // 统一供应商只作用于**当前显示页**；说明文案已按要求整段删除，行后直接是页签行。
        react.createElement("div", { className: "deg_settings_row deg_settings_unified_row" },
          react.createElement("div", { className: "deg_settings_provider_group" },
            react.createElement("label", { className: "deg_settings_label", htmlFor: "deg-settings-provider" }, t("settings.unifiedProvider")),
            react.createElement("div", { className: "deg_settings_control" },
              react.createElement("select", {
                id: "deg-settings-provider",
                className: "deg_settings_provider_select",
                value: unifiedProvider,
                disabled: saving || !catalogAvailable,
                onChange: (event) => editDraft((previous) => {
                  const provider = event.target.value;
                  if (currentModelPage !== 0) {
                    // 候选页：统一供应商只改**当前层**六个可见角色的 provider，绝不碰 defaults。
                    // 「无」只表示当前页没有统一值：既不删行也不写草稿（与主模型页的“无”同语义）。
                    if (!provider) return previous;
                    let next = previous;
                    for (const role of settingsRolesForProvider(roles)) {
                      const current = modelLayerSelectionOf(next, role, currentModelPage);
                      // 与单元格换供应商同一套显示名迁移规则；迁移不到就保留 provider、清空模型。
                      const migrated = migrateSettingsSelection(current, provider, providerGroups) ?? { provider, model: "" };
                      next = setModelLayerSelection(next, role, currentModelPage, migrated);
                    }
                    return next;
                  }
                  if (!provider) {
                    // “无”仅表示未统一/混合状态，不删除任何专家行的 provider；旧文档只有顶层
                    // provider 且没有可见行时也保留它，避免选择器动作破坏迁移来源。
                    const hasVisibleProvider = settingsRolesForProvider(roles).some((role) => {
                      const value = previous.defaults?.[role]?.provider;
                      return typeof value === "string" && value.length > 0;
                    });
                    return hasVisibleProvider ? { ...previous, provider: "" } : previous;
                  }
                  return {
                    ...previous,
                    provider,
                    defaults: syncSettingsDefaultsProvider(previous.defaults, provider, providerGroups, roles),
                  };
                }),
              },
                react.createElement("option", { value: "" }, t("settings.noProvider")),
                providerGroups.map((group) => react.createElement("option", { key: group.id, value: group.id }, group.name ?? group.id))))),
          // 自动降级上限（票据 24 重排）：候选改在页签里按层维护，这里只保留启动失败时的
          // 全局降级次数上限；草稿/保存字段与校验语义保持原样。
          react.createElement("div", { className: "deg_settings_fallback_group" },
            react.createElement("label", { className: "deg_settings_label", htmlFor: "deg-settings-model-fallback-limit" }, tExtra("settings.modelCandidates.fallbackLimit")),
            react.createElement("div", { className: "deg_settings_control" },
              react.createElement("input", {
                id: "deg-settings-model-fallback-limit",
                type: "number", min: 0, max: MAX_MODEL_FALLBACK_LIMIT, step: 1, inputMode: "numeric",
                "aria-label": tExtra("settings.modelCandidates.fallbackLimit"),
                title: tExtra("settings.modelCandidates.fallbackLimit.title"),
                value: draft.fallbackLimit === void 0 ? fallbackLimitDraft : draft.fallbackLimit,
                disabled: saving || settingsReadOnly,
                onChange: (event) => {
                  const raw = event.target.value;
                  const number = raw === "" ? null : Number(raw);
                  editDraft((previous) => ({ ...previous, fallbackLimit: raw === "" ? "" : Number.isFinite(number) ? Math.round(number) : previous.fallbackLimit }));
                },
              })))),
        // 说明文案按用户要求整段删除（不加替代说明）：统一行之后直接是页签行，再往下是角色表格。
        modelTabRow,
        react.createElement("div", { className: "deg_settings_table_wrap" },
          react.createElement("div", { className: "deg_settings_table" }, header, rows)),
        react.createElement("div", { className: "deg_settings_row deg_settings_management_row" },
          react.createElement("label", { className: "deg_settings_checkbox" },
            react.createElement("input", { type: "checkbox", "aria-label": t("settings.observerPreferred"), checked: draft.observerPreferred, disabled: saving, onChange: (event) => editDraft((previous) => ({ ...previous, observerPreferred: event.target.checked })) }),
            react.createElement("span", { className: "deg_settings_label" }, t("settings.observerPreferred"))),
          // 管理行三个部分都是直接子节点，间距由容器统一给出（与任务行/统一行同节奏）。
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-role-concurrency-limit" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.concurrencyLimit")),
            react.createElement("input", {
              id: "deg-settings-role-concurrency-limit",
              type: "number",
              "aria-label": t("settings.concurrencyLimit"),
              // 与相邻「角色默认超时」输入框一致：原生 title 说明取值范围与默认值（悬停可见）。
              title: t("settings.concurrencyLimit.title"),
              min: 1,
              max: 64,
              step: 1,
              inputMode: "numeric",
              value: draft.roleConcurrencyLimit,
              disabled: saving,
              onChange: (event) => {
                const raw = event.target.value;
                const number = raw === "" ? null : Number(raw);
                editDraft((previous) => ({
                  ...previous,
                  roleConcurrencyLimit: raw === ""
                    ? ""
                    : Number.isFinite(number) ? number : previous.roleConcurrencyLimit,
                }));
              },
            })),
          // 角色级默认超时（票据 06）：设置页以**秒**展示与编辑（0 = 不启用），提交时换算成
          // Host 的毫秒字段 roleTimeoutMs；与并发上限同一行的紧凑布局。
          // 精度与边界由 Host 与管理器共同保证；这里只提供步进与可访问名称。
          react.createElement("label", { className: "deg_settings_control", htmlFor: "deg-settings-role-timeout-ms" },
            react.createElement("span", { className: "deg_settings_label" }, t("settings.roleTimeout")),
            react.createElement("input", {
              id: "deg-settings-role-timeout-ms",
              type: "number",
              "aria-label": t("settings.roleTimeout.aria"),
              title: t("settings.roleTimeout.title"),
              min: 0,
              max: 86400,
              step: 1,
              inputMode: "numeric",
              value: draft.roleTimeoutMs === "" ? "" : draft.roleTimeoutMs / 1000,
              disabled: saving,
              onChange: (event) => {
                const raw = event.target.value;
                const seconds = raw === "" ? null : Number(raw);
                editDraft((previous) => ({
                  ...previous,
                  // 草稿与 Host 字段保持毫秒；UI 只做秒 ↔ 毫秒换算，整秒取整。
                  roleTimeoutMs: raw === ""
                    ? ""
                    : Number.isFinite(seconds) ? Math.round(seconds) * 1000 : previous.roleTimeoutMs,
                }));
              },
            }))),
        // 候选校验错误（半填行等）：候选改在页签里编辑后，错误必须在这里可见，否则用户看不到原因。
        candidatesError === null || candidatesError === void 0 ? null : react.createElement("p", {
          className: "deg_settings_error",
          role: "alert",
          "data-deg-model-candidates-error": "true",
        }, candidatesError),
        directoryState.error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, directoryState.error) : null,
        error ? react.createElement("p", { className: "deg_settings_error", role: "status" }, error) : null,
        // 删除候选页的确认框（未打开时为 null，与未保存弹窗同一渲染方式）。
        modelPageDeleteDialog,
        react.createElement("div", { className: "deg_settings_footer" },
          react.createElement("span", { className: "deg_settings_status", role: "status" }, saved ? t("settings.saved") : hasUnsavedChanges ? t("settings.unsaved") : ""),
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving, onClick: discard }, t("settings.discard")),
          // 票据 20：目录不可用只在本次草稿含模型字段变更时禁用保存；通知、任务开关、
          // 提示词、并发/超时等与模型无关的字段必须照常可保存。
          react.createElement("button", { type: "button", className: "deg_btn", disabled: !hasUnsavedChanges || saving || (modelFieldsChanged && !catalogAvailable) || settingsSnapshot.writable !== true, onClick: save }, saving ? t("settings.saving") : t("settings.save"))));
    }
    /**
     * 浏览器 FileReader 的等价字节编码：File.arrayBuffer() 取得原始字节，btoa()
     * 生成与 DSH 原生 serializer 相同的无换行 canonical base64。此处不依赖
     * ConversationController 的 private 方法，也不改变 File 的 MIME/name 元数据。
     */
    async function encodeImageFileForRoute(file) {
      const mediaType = file?.type;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
        throw new Error("conversation.sendSession: unsupported image media type");
      }
      if (typeof file?.arrayBuffer !== "function") {
        throw new Error("conversation.sendSession: image File.arrayBuffer is unavailable");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      // 分块避免大图片展开参数超过浏览器调用栈限制；字节顺序仍与 FileReader 完全一致。
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const encode = globalThis?.btoa;
      if (typeof encode !== "function") throw new Error("conversation.sendSession: btoa is unavailable");
      return {
        type: "image",
        mediaType,
        data: encode(binary),
        ...(typeof file.name === "string" && file.name !== "" ? { name: file.name } : {}),
      };
    }

    async function encodeImagesForRoute(attachments) {
      return Promise.all(attachments.map((attachment) => encodeImageFileForRoute(attachment.file)));
    }

    /** Host 返回值也必须经过 PNG MIME、canonical base64 与签名校验，才可进入 prompt。 */
    function isPngRouteImage(image) {
      if (!image || typeof image !== "object" || image.mediaType !== "image/png" || typeof image.data !== "string") return false;
      if (image.name !== undefined && typeof image.name !== "string") return false;
      try {
        const decode = globalThis?.atob;
        const encode = globalThis?.btoa;
        if (typeof decode !== "function" || typeof encode !== "function") return false;
        const binary = decode(image.data);
        if (encode(binary) !== image.data || binary.length < 8) return false;
        return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => binary.charCodeAt(index) === byte);
      } catch {
        return false;
      }
    }

    /**
     * 安全读取运行时方法。DSH 的 traceable Proxy 可能在读取某个兼容 API 时抛错；
     * 单独隔离每次读取，才能让新 API 的 getter 异常继续回退到其他候选方法。
     */
    function readRuntimeMethod(runtime, name) {
      if (runtime === null || runtime === void 0) return undefined;
      try {
        const method = runtime[name];
        return typeof method === "function" ? method : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 按有序 id 数组解析草稿附件：先查新 API，再查旧 API；同一顺序同时覆盖
     * sendSession 的 this 与注入的 conversation。返回实际运行时与解析结果，供退休回调
     * 使用同一接收者释放草稿；方法使用 call 保留真实接收者，实际方法抛出的业务异常
     * 不会被误判成能力缺失而再次调用其他 API。
     */
    function resolveDraftAttachmentsCompat(primaryRuntime, fallbackRuntime, ids) {
      const candidates = [
        [primaryRuntime, "resolveDraftAttachments"],
        [fallbackRuntime, "resolveDraftAttachments"],
        [primaryRuntime, "draftImages"],
        [fallbackRuntime, "draftImages"],
      ];
      for (const [runtime, name] of candidates) {
        const method = readRuntimeMethod(runtime, name);
        if (method !== undefined) return { runtime, attachments: method.call(runtime, ids) };
      }
      throw new Error(
        "dsh-expert-group: 当前 DSH 运行时未暴露草稿附件解析 API（resolveDraftAttachments / draftImages），无法提交图片草稿",
      );
    }

    function releaseObservedDraftImages(runtime, attachments, settlement) {
      if (settlement?.reason !== "observed") return;
      if (runtime === null || runtime === void 0) return;
      // 只调用 ConversationController 的公开释放面，且严格按各自契约传参，绝不混用参数形态：
      // - 批量方法（新 releaseDraftAttachments / 旧 releaseDraftImages）接收附件描述符数组；
      // - 单项方法（新 releaseDraftAttachment / 旧 releaseDraftImage）接收单个草稿 id。
      // 释放优先级固定为新批量、新单项、旧批量、旧单项；四种释放面都缺失时静默跳过，
      // 因为此处位于 retirement 回调内，抛出只会在提交结果之后制造二次失败。
      const releaseDraftAttachments = readRuntimeMethod(runtime, "releaseDraftAttachments");
      if (releaseDraftAttachments !== undefined) {
        releaseDraftAttachments.call(runtime, attachments);
        return;
      }
      const releaseDraftAttachment = readRuntimeMethod(runtime, "releaseDraftAttachment");
      if (releaseDraftAttachment !== undefined) {
        attachments.forEach((attachment) => releaseDraftAttachment.call(runtime, attachment.id));
        return;
      }
      const releaseDraftImages = readRuntimeMethod(runtime, "releaseDraftImages");
      if (releaseDraftImages !== undefined) {
        releaseDraftImages.call(runtime, attachments);
        return;
      }
      const releaseDraftImage = readRuntimeMethod(runtime, "releaseDraftImage");
      if (releaseDraftImage !== undefined) {
        attachments.forEach((attachment) => releaseDraftImage.call(runtime, attachment.id));
      }
    }

    function waitForImageSubmissionPaint() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    // Cordis traceable Proxy 每次读取方法都可能产生新的函数代理；生命周期状态因此放在
    // 跨 HMR 的全局 WeakMap 中，cleanup 只比较自己的 state，不读取 sendSession 做身份判断。
    const IMAGE_ROUTE_STATES_KEY = Symbol.for("dsh-expert-group.image-submission-route-states");
    function imageSubmissionRouteStates() {
      const root = globalThis;
      const existing = root[IMAGE_ROUTE_STATES_KEY];
      if (existing instanceof WeakMap) return existing;
      const states = new WeakMap();
      Object.defineProperty(root, IMAGE_ROUTE_STATES_KEY, {
        value: states,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      return states;
    }

    /**
     * 原生 Composer 没有公开 submit hook，因此在 concrete ConversationController
     * 的 sendSession 边界做幂等包装。只拦截根会话图片；child 仍使用原生路径。
     * Host 先返回真实 PNG encoded image 或完成 Observer 投递，再通过公开
     * Session.beginSubmission/prompt 维护 request id、回显、模式和退休生命周期。
     */
    function installImageSubmissionRoute(ctx) {
      let conversation;
      try { conversation = ctx.get("conversation"); } catch { return () => {}; }
      if (!conversation || typeof conversation.sendSession !== "function") return () => {};
      const states = imageSubmissionRouteStates();
      const existing = states.get(conversation);
      if (existing !== void 0) return existing.cleanup;
      // 只保存一次原生引用；后续 cleanup 不读取 traceable Proxy 的方法身份。
      const original = conversation.sendSession;
      // helper 内联于 route 安装函数，旧测试/旧 Host 即使只提取该函数也能工作。
      const rpcRequest = async (request, init = {}) => {
        const rpc = ctx.connection?.rpc;
        if (typeof rpc?.call === "function") {
          const result = await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, request, init.signal);
          return {
            ok: result?.ok === true,
            status: result?.ok === true ? 200 : 500,
            async json() { return result?.ok === true ? result.value : { ok: false, error: result?.error }; },
          };
        }
        return fetch(RPC_PATH, {
          ...init,
          method: init.method ?? "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...(init.headers ?? {}),
            "x-dsh-expert-group-image": "1",
          },
          body: JSON.stringify(request),
        });
      };
      const state = { original, cleanup: void 0, active: true, observerFinalizers: new Set() };
      const wrapped = async function sendSessionWithImageRoute(session, text, imageIds, mode, signal) {
        const sessionSnapshot = session?.getSnapshot?.();
        if (!Array.isArray(imageIds) || imageIds.length === 0 || sessionSnapshot === undefined || sessionSnapshot.subagent != null) {
          return original.call(this, session, text, imageIds, mode, signal);
        }
        // 先在 this 与注入服务中寻找新 API，再寻找旧 API；helper 会保留实际方法接收者，
        // 两者都不具备时给出插件自身的明确错误。
        const resolved = resolveDraftAttachmentsCompat(this, conversation, imageIds);
        const runtime = resolved.runtime;
        const attachments = resolved.attachments;
        if (!Array.isArray(attachments) || attachments.length !== imageIds.length) {
          throw new Error("conversation.sendSession: one or more draft images are no longer available");
        }
        let finishRetirement;
        const retirement = new Promise((resolve) => { finishRetirement = resolve; });
        // DSH 的回显协议使用 mode + attachments；每个图片附件必须包在 type/value
        // 中。这里不能沿用旧的 images 平铺字段，否则非法回显会在聊天槽位读取
        // submission.attachments.map 时让当前会话渲染退化为空白。
        const submission = session.beginSubmission({
          mode,
          text,
          attachments: attachments.map((attachment) => ({
            type: "image",
            value: {
              previewUrl: attachment.previewUrl,
              ...(typeof attachment.file?.name === "string" && attachment.file.name !== "" ? { name: attachment.file.name } : {}),
              ...(attachment.width === undefined ? {} : { width: attachment.width }),
              ...(attachment.height === undefined ? {} : { height: attachment.height }),
            },
          })),
          onRetire: (settlement) => {
            try {
              releaseObservedDraftImages(runtime, attachments, settlement);
            } finally {
              finishRetirement?.(settlement);
            }
          },
        });
        // Observer commit 成功后 Host 会随响应给出一次性 cleanupToken（绑定 session +
        // childId + exact root generation）。这里在 try 之外声明状态与收尾函数，保证
        // prompt 失败返回、抛错、取消以及插件卸载的 catch/cleanup 路径都能看到它。
        let observerCleanup;
        /**
         * 消费 Host 侧的 Observer cleanup token。
         *
         * cancel：失败/取消路径，让 Host 中断刚创建的 child；
         * release：成功 observed 路径，只释放凭据（Host 绝不 interrupt），否则 token 会一直
         * 占到 TTL，连续成功提交 64 次后新的 Observer commit 会被容量拒绝。
         *
         * 两种请求都不复用调用方可能已 aborted 的 signal，且都是尽力而为：失败不改变已经
         * 成功或已经失败的 prompt 结果。
         * @param {string} action - image-route-observer-cancel 或 ...-release。
         */
        const finishObserverChild = (action) => {
          if (observerCleanup === undefined) return;
          const pending = observerCleanup;
          observerCleanup = undefined;
          state.observerFinalizers.delete(pending.finalizer);
          void rpcRequest({
            action,
            sessionId: pending.sessionId,
            childId: pending.childId,
            cleanupToken: pending.cleanupToken,
          }, {}).catch(() => {});
        };
        const cancelObserverChild = () => finishObserverChild("image-route-observer-cancel");
        const releaseObserverChild = () => finishObserverChild("image-route-observer-release");
        try {
          await waitForImageSubmissionPaint();
          const encoded = await encodeImagesForRoute(attachments);
          const response = await rpcRequest({
            action: "image-route", sessionId: session.sessionId, text, images: encoded,
          }, { signal });
          let payload;
          try { payload = await response.json(); } catch { payload = null; }
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error?.message ?? ("图片路由失败（HTTP " + response.status + "）"));
          }
          // TOCTOU 复核：Host 判定能力后我们才 session.prompt，期间用户可能再次切换模型，
          // 导致"能力判定模型"与"实际 prompt 模型"不一致。Host 回传一个不泄露 provider/model
          // 的不透明 routeClaim；任何复核/提交失败都必须 abandon 本次提交（绝不 session.prompt）。
          //
          // main 路径：旧宿主没有 routeClaim 字段时保持既有提交行为（不发校验请求，也不静默
          // 假设"校验通过"）；有 claim 时先校验一次（Host 对 main 的成功校验会消费 claim）。
          //
          // observer 路径是**两阶段**：Host 在 image-route 阶段只签发 claim + 暂存 durable refs，
          // 不会启动 child。客户端必须先 validate（只验证不消费），再 observer-commit
          // （Host 复核当前路由后才真正 admission 并消费 claim）。因此旧宿主（没有 claim 的
          // observer 响应）无法安全提交，必须 fail-closed 而不是退回旧行为。
          const routeClaim = typeof payload.routeClaim === "string" ? payload.routeClaim : "";
          /** 调用一次 Host 的 claim 复核；失败时抛出可诊断错误（不返回成功）。 */
          const assertRouteClaim = async (action) => {
            const checked = await rpcRequest({
              action, sessionId: session.sessionId, routeClaim,
            }, { signal });
            let body;
            try { body = await checked.json(); } catch { body = null; }
            if (!checked.ok || body?.ok !== true) {
              throw new Error(body?.error?.message
                ?? "模型路由在图片提交期间发生变化，已放弃本次图片提交；请重新发送");
            }
          };
          // Observer commit 成功但后续 root prompt 失败/取消时的补偿：commit 响应里的
          // childId/cleanupToken 已在上面登记，这里只需要构造 content。
          let content;
          if (payload.target === "main") {
            if (routeClaim.length > 0) await assertRouteClaim("image-route-validate");
            const images = Array.isArray(payload.images) ? payload.images : [];
            if (images.length !== encoded.length || !images.every(isPngRouteImage)) {
              throw new Error("Host 必须返回与提交数量一致的真实 PNG 图片");
            }
            content = [
              ...images.map((image) => ({ type: "image", mediaType: image.mediaType, data: image.data, name: image.name })),
              ...(text === "" ? [] : [{ type: "text", text }]),
            ];
          } else if (payload.target === "observer") {
            if (routeClaim.length === 0) {
              // 旧 Host 的 observer 响应没有 claim：它会立刻启动 Observer，因此无法保证
              // "能力判定模型 == 实际 prompt 模型"，也无法在提交失败时避免孤儿 child。
              throw new Error("Host 不支持安全的 Observer 图片提交，请升级插件/Host 后重试");
            }
            await assertRouteClaim("image-route-validate");
            // 第二阶段：Host 复核当前路由 → Observer admission → 一次性消费 claim。
            // 失败（路由变化/claim 失效/重复提交/取消）时 Host 不会启动 child，或尽力中断它。
            const committed = await rpcRequest({
              action: "image-route-observer-commit", sessionId: session.sessionId, routeClaim,
            }, { signal });
            let commitBody;
            try { commitBody = await committed.json(); } catch { commitBody = null; }
            if (!committed.ok || commitBody?.ok !== true) {
              throw new Error(commitBody?.error?.message
                ?? "Observer 图片提交未完成，已放弃本次提交；请重新发送");
            }
            // commit 成功即存在真实 child：登记清理 finalizer（成功 observed 时会撤销）。
            const childId = typeof commitBody.childId === "string" ? commitBody.childId : "";
            const cleanupToken = typeof commitBody.cleanupToken === "string" ? commitBody.cleanupToken : "";
            if (childId.length > 0 && cleanupToken.length > 0) {
              const finalizer = () => cancelObserverChild();
              observerCleanup = { sessionId: session.sessionId, childId, cleanupToken, finalizer };
              state.observerFinalizers.add(finalizer);
            }
            // Observer 只收到图片本身并只做视觉分析（自动入口不传用户文字）；根会话提交文字
            // 通知，让原生 retirement 释放浏览器草稿，同时明确告诉主代理：原始用户任务仍在
            // 自己手里，视觉报告会作为上下文反馈回来（由 DSH 的 child 反馈通道送达），不要
            // 把这次提交当成任务已完成。
            const notice = "用户图片已交由 Observer 做纯视觉分析（仅描述图片内容、可见文字、布局、状态与异常；未向 Observer 传递任何用户文字）。Observer 的视觉报告会作为主代理上下文反馈回本会话；请保留用户的原始任务并继续处理，收到视觉报告后再综合，不要把本次提交当作任务已完成。";
            content = [{ type: "text", text: text === "" ? notice : text + "\n" + notice }];
          } else {
            throw new Error("Host 返回了未知的图片路由目标");
          }
          const result = await session.prompt(content, mode, signal, submission.requestId);
          if (!result?.ok) {
            // prompt 未被接受：尽力中断刚创建的 Observer child，避免孤儿反馈。
            cancelObserverChild();
            return { kind: "error" };
          }
          if ((await retirement).reason !== "observed") {
            cancelObserverChild();
            return { kind: "error" };
          }
          // 成功 observed：Observer child 已由 DSH 正常收口，撤销 finalizer 并**释放**
          // Host 侧 cleanup token（release 只释放凭据、绝不 interrupt）。不释放会让 token
          // 一直占到 TTL，连续成功提交填满容量后新的 Observer commit 会被拒绝。
          releaseObserverChild();
          return { kind: "success" };
        } catch (error) {
          // 抛错/取消路径同样尽力中断 Observer child，但保留原始错误语义。
          try { cancelObserverChild(); } catch { /* 尽力而为 */ }
          submission.abandon();
          throw error;
        }
      };
      const cleanup = () => {
        if (!state.active) return;
        state.active = false;
        // 卸载时先尽力中断仍在等待 root prompt 的 Observer child，再恢复原生 sendSession。
        for (const finalizer of [...state.observerFinalizers]) {
          state.observerFinalizers.delete(finalizer);
          try { finalizer(); } catch { /* 尽力而为 */ }
        }
        if (states.get(conversation) !== state) return;
        states.delete(conversation);
        // state 是本次安装的稳定所有权标记；恢复时不比较每次读取都会变化的代理函数。
        conversation.sendSession = original;
      };
      state.cleanup = cleanup;
      states.set(conversation, state);
      conversation.sendSession = wrapped;
      return cleanup;
    }



    /**
     * keyed conversation renderer 只接管 system-prompt，并将原始文本作为 React children 保持完整显示。
     */
    function FullSystemPromptNode(props) {
      const [open, setOpen] = react.useState(false);
      const text = props?.node?.data?.text;
      if (typeof text !== "string") return null;
      return react.createElement(
        primitives.DisclosureRow,
        {
          // 0.1.7-alpha.2 起图标后缀编码的是描边粗细（Regular=1px），渲染尺寸只由 size prop 承载，
          // 因此旧 `*16` 后缀名一律改为 `*Regular`，并保持原有的显式 size。
          icon: react.createElement(primitives.IconBrowseOutlineRegular, { size: 14 }),
          title: "系统提示词",
          open,
          expandable: true,
          expandOnRowClick: true,
          onToggle: () => setOpen((value) => !value),
          className: "deg_full_system_prompt_root",
          chevronClassName: "deg_full_system_prompt_chevron",
        },
        react.createElement(
          "div",
          { className: "deg_full_system_prompt_body" },
          react.createElement("pre", { className: "deg_full_system_prompt" }, text),
        ),
      );
    }

    // ── 设置页导航行的品牌图标（DOM 适配）──────────────────────────────────────
    /**
     * DEG 在宿主 settings.section ledger 里的条目 id，同时也是导航行显示的 label
     * （注册时的 label 固定回投射成这个 id）。设置页导航图标适配靠它定位目标行，因此提升到
     * 模块作用域：与 apply 内的注册共用同一个来源，不出现第二份字面量。
     */
    const DEG_SETTINGS_SECTION_ID = "dsh-expert-group";
    /** 适配标记：按钮 / 宿主原生 svg / DEG 自有 svg 各一个（同时被 CSS 选择器使用）。 */
    const DEG_SETTINGS_NAV_ATTR = "data-deg-settings-nav";
    const DEG_SETTINGS_NAV_NATIVE_ATTR = "data-deg-settings-nav-native";
    const DEG_SETTINGS_NAV_ICON_ATTR = "data-deg-settings-nav-icon";
    /** 设置页导航栏里其它行都是 1.3px 描边的 Medium 图标；宿主未给出描边宽度时按它回落。 */
    const DEG_SETTINGS_NAV_STROKE_FALLBACK = "1.3";

    /**
     * 品牌图标路径数据的兜底副本（双人 users 图标，与宿主「智能体团队」入口同源）。
     *
     * 运行期优先取 client-expert-group-sidebar.js 导出的 BRAND_ICON_PATHS（唯一一份 artwork，
     * 侧栏 tab / guide 图标与这里共用），只有侧栏 IIFE 缺失（契约外直接加载 client.js、被裁剪的
     * 装配产物）时才用这份逐字节同值的字面量，保证设置页图标不因缺模块而消失。
     * 两处一致性由 test/expert-group-sidebar-contract.test.mjs 断言。
     */
    const DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS = Object.freeze([
      "M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
      "M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
      "M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
      "M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
    ]);
    const DEG_SETTINGS_NAV_ICON_PATHS = (() => {
      const shared = expertGroupSidebar?.BRAND_ICON_PATHS;
      if (Array.isArray(shared) && shared.length > 0 && shared.every((item) => typeof item === "string")) return shared;
      return DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
    })();

    /**
     * 这个元素是不是 DEG 在设置面板里的导航行？
     *
     * 只认「可见文本严格等于 DEG 注册的 label，且含 svg 子元素」的节点：
     * - 文本取自 textContent.trim()（label 是按钮内 span 的文本，真实 DOM 的 textContent 会
     *   把后代文本拼起来），严格相等因此能排除 "dsh-expert-group-status" 之类的近似行；
     * - svg 的存在保证「有图标可换」——没有图标的行不动，避免给非目标行插图标；
     * - 绝不使用宿主 CSS module 的哈希类名（构建产物一变就失配）。
     *
     * 任何读取失败（节点代理抛错、querySelector 不可用）都按「不是目标行」处理。
     */
    function isDegSettingsNavRow(element) {
      if (element === null || typeof element !== "object") return false;
      try {
        if (typeof element.textContent !== "string" || element.textContent.trim() !== DEG_SETTINGS_SECTION_ID) return false;
        if (typeof element.querySelector !== "function") return false;
        const native = element.querySelector("svg");
        return native !== null && native !== void 0;
      } catch {
        return false;
      }
    }

    /**
     * 构造 DEG 自有的品牌 svg（与侧栏图标同一组 4 条 path）。
     *
     * 描边宽度沿用宿主原图标的值（宿主 Medium 图标为 1.3px），缺失时回落到同一数值：
     * 换掉图标后视觉重量必须与同一导航栏里其它行一致，不能变成明显更细或更粗的一行。
     */
    function createDegSettingsNavIcon(doc, strokeWidth) {
      const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute(DEG_SETTINGS_NAV_ICON_ATTR, "");
      svg.setAttribute("width", "16");
      svg.setAttribute("height", "16");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", strokeWidth);
      svg.setAttribute("aria-hidden", "true");
      for (const d of DEG_SETTINGS_NAV_ICON_PATHS) {
        const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("fill", "none");
        svg.appendChild(path);
      }
      return svg;
    }

    /**
     * 设置页导航行的品牌图标适配（宿主设置面板由 DSH 渲染，导航行图标来自 SettingsRoot 里按
     * section id 硬编码的 navIcon(id)，未知 id 回退齿轮；`settings.section` 注册只投影
     * id/order/label，插件无法用注册字段声明图标，因此只能在客户端做 DOM 适配）。
     *
     * 做法与边界：
     * 1. 定位：`[role="dialog"]` 内的按钮里，可见文本严格等于 "dsh-expert-group" 且含 svg 的那一行；
     * 2. **不替换**宿主 svg 的内容，只给它加标记交给 CSS 隐藏——React 重新渲染该行时会按 fiber
     *    位置回写自己那些 path 节点，改写宿主 svg 的内部结构会被下一次提交覆盖回去；
     * 3. 自造 svg 插到按钮第一个子节点之前：按钮是 display:flex;gap:8px，图标在最左，
     *    label 的位置与宿主自己的布局语义都不受影响；
     * 4. 幂等：sync 会先把行内**所有**非自有 svg 重新标成原生图标（宿主重渲染后标记可能丢失，
     *    这正是自愈路径），自有图标已在位就只补标记，绝不重复插入；
     * 5. 健壮性：DOM / observer / createElementNS / 选择器任何一步不可用都静默 no-op——
     *    设置页图标只是外观，绝不能影响插件入口、设置页或侧边栏本身的功能。
     *
     * 成本：observer 观察整个 body 子树（与 SubagentMetadataBridge 同一策略）。每次回调只做
     * 一次 `[role="dialog"]` 查询；设置面板关闭时该查询直接返回空集合，因此普通会话的 DOM
     * 变更不产生可见开销。
     *
     * @returns {() => void} disposer：断开 observer 并清掉全部标记与自有 svg。
     */
    function installDegSettingsNavIcon() {
      const doc = typeof document !== "undefined" ? document : null;
      const root = doc?.body ?? doc?.documentElement ?? null;
      if (doc === null || root === null || typeof doc.querySelectorAll !== "function") return () => {};
      let observer = null;
      let disposed = false;

      /** 单个候选行的适配（幂等 + 自愈，见上面的第 2/4 条）。 */
      const syncRow = (row) => {
        if (typeof row.querySelectorAll !== "function" || typeof row.setAttribute !== "function") return;
        const nativeSvgs = [];
        let ownIcon = null;
        for (const svg of row.querySelectorAll("svg")) {
          if (typeof svg.getAttribute !== "function") continue;
          if (svg.getAttribute(DEG_SETTINGS_NAV_ICON_ATTR) !== null) ownIcon = svg;
          else nativeSvgs.push(svg);
        }
        if (ownIcon === null) {
          // 首次适配：缺少 SVG 构造/插入能力（极旧的替身 DOM）时整行保持原样。
          if (typeof doc.createElementNS !== "function" || typeof row.insertBefore !== "function") return;
          const native = nativeSvgs[0];
          const inherited = native === undefined ? null : native.getAttribute("stroke-width");
          const strokeWidth = typeof inherited === "string" && inherited.trim() !== ""
            ? inherited
            : DEG_SETTINGS_NAV_STROKE_FALLBACK;
          ownIcon = createDegSettingsNavIcon(doc, strokeWidth);
          // 插到第一个子节点之前：图标列在最左，label 与宿主后续插入的节点位置不变。
          row.insertBefore(ownIcon, row.firstChild ?? null);
        }
        for (const svg of nativeSvgs) svg.setAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR, "");
        row.setAttribute(DEG_SETTINGS_NAV_ATTR, "");
      };

      /** 幂等同步：命中一行的条件是「label 严格相等 + 含 svg」，已适配的行只补标记。 */
      const sync = () => {
        if (disposed) return;
        try {
          for (const dialog of doc.querySelectorAll('[role="dialog"]')) {
            if (typeof dialog?.querySelectorAll !== "function") continue;
            for (const row of dialog.querySelectorAll("button")) {
              if (isDegSettingsNavRow(row) !== true) continue;
              syncRow(row);
            }
          }
        } catch {
          // 选择器或宿主节点代理抛错：保持 no-op，下一次 observer 回调再试，绝不外泄异常。
        }
      };

      /** dispose 清理：全量清掉标记与自有 svg；宿主重渲染后已断开的节点同样安全跳过。 */
      const cleanup = () => {
        try {
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_ATTR + "]")) node.removeAttribute(DEG_SETTINGS_NAV_ATTR);
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_NATIVE_ATTR + "]")) node.removeAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR);
          for (const node of doc.querySelectorAll("[" + DEG_SETTINGS_NAV_ICON_ATTR + "]")) {
            // 移除自己插入的节点；节点已游离时 remove() 是安全的空操作。
            if (typeof node.remove === "function") node.remove();
          }
        } catch {
          // 清理失败不能阻断卸载（标记属性本身无害，下次挂载会重新适配）。
        }
      };

      sync();
      const Observer = doc?.defaultView?.MutationObserver
        ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
      if (typeof Observer === "function") {
        try {
          observer = new Observer(() => { sync(); });
          observer.observe(root, { childList: true, subtree: true });
        } catch {
          // observer 装不上（宿主替身/权限异常）：保留已经完成的一次性适配，不再跟进重渲染。
          observer = null;
        }
      }
      return () => {
        if (disposed) return;
        disposed = true;
        try {
          observer?.disconnect();
        } catch {
          // 断开失败不阻断清理。
        }
        observer = null;
        cleanup();
      };
    }

    // ── 插件详情（DSH 插件管理器的组合包页）上的 DEG 配置摘要 ────────────────
    /**
     * 组合包详情页的配置 slot 名与 key。
     *
     * DSH 的 ui-plugin-manager 把 `plugins.bundle.config` 声明为 keyed slot，以组合包的
     * **npm 包名**为 key，并把 `view: 'page'` 渲染在组合包页面的描述与行之间——这正是
     * 本插件详情摘要的落点。key 与 settings 分区 id 同值（profile 条目 id 就是包名），
     * 因此复用同一份字面量，不新增第二处硬编码。
     */
    const DEG_PLUGIN_DETAIL_SLOT_NAME = "plugins.bundle.config";
    const DEG_PLUGIN_DETAIL_ENTRY_KEY = DEG_SETTINGS_SECTION_ID;
    /** 设置 Shell 的侧栏席位：openSection 能力句柄的唯一来源。 */
    const DEG_SETTINGS_SIDEBAR_SLOT_NAME = "sidebar.settings";
    /** DEG 自己注册的设置分区所在的 slot。 */
    const DEG_SETTINGS_SECTION_SLOT_NAME = "settings.section";

    /**
     * 「打开 DEG 设置」各失败原因的用户可见提示。
     *
     * 每条都表达「为什么不能跳转」，且都不包含宿主异常原文（异常只按 open-failed 归类），
     * 避免把宿主内部信息回显到界面上。
     */
    const DEG_SETTINGS_OPEN_FAILURE_TEXT = Object.freeze({
      "slots-unavailable": "宿主未提供 slot 账本读取面，暂时无法跳转到 DEG 设置",
      "sidebar-entry-missing": "未找到设置侧栏入口，暂时无法跳转到 DEG 设置",
      "sidebar-entry-ambiguous": "设置侧栏入口不唯一，已停用跳转",
      "store-missing": "设置侧栏入口缺少顶层导航 store，已停用跳转",
      "open-section-missing": "设置侧栏入口缺少 openSection 动作，已停用跳转",
      "section-missing": "DEG 设置分区尚未注册，暂时无法跳转",
      "section-ambiguous": "DEG 设置分区注册重复，已停用跳转",
      // 账本条目上的属性读取（entry/options/store/actions/create/instance.actions 的 getter）抛错：
      // 归到同一类泛化提示，既不回显宿主异常原文，也不假装能力可用。
      "ledger-unreadable": "Slot 账本读取异常，已停用跳转",
      "open-failed": "打开 DEG 设置失败，请手动打开设置页",
    });

    /** 读一个 slot 的账本；宿主没有该读面或读面抛错时返回 null（调用方 fail-closed）。 */
    function readSlotLedger(slots, name) {
      try {
        if (slots === null || typeof slots !== "object" || typeof slots.entries !== "function") return null;
        const entries = slots.entries(name);
        return Array.isArray(entries) ? entries : [];
      } catch {
        // 宿主替身 / 代理拒答：按"读不到账本"处理，绝不让摘要或设置页因此崩溃。
        return null;
      }
    }

    /**
     * 从设置侧栏条目的 store 句柄里解析 openSection。
     *
     * DSH 的 ui-settings-general 用 `defineStore` 造 shell store，再以
     * `{ ...handle, create: () => instance }` 的形式注册到 `sidebar.settings` 席位；DSH
     * 0.2.0-rc.2 把它投影为条目的**顶层 `store`**（不是 `entry.options.store`）。句柄本身
     * 没有 actions，实例（`create()` 的返回值，且恒为同一份壳实例）才带 `actions`。
     * 因此这里按「句柄 → 实例 → actions」解析，并兼容直接把 actions 挂在 store 上的形态。
     * 只有 `store.create()` 的**调用**在本函数内捕获（返回 null → open-section-missing）；
     * 属性 getter 抛错（store.actions / store.create / instance.actions / actions.openSection）
     * 刻意向外抛出，由调用方归到 ledger-unreadable 这一类——两种失败类别不能混为一谈。
     * 任一环节缺失都不猜、不回退到别的动作。
     */
    function resolveSettingsShellOpenSection(store) {
      if (store === null || typeof store !== "object") return null;
      const direct = store.actions;
      if (direct !== null && typeof direct === "object" && typeof direct.openSection === "function") {
        return direct.openSection.bind(direct);
      }
      if (typeof store.create !== "function") return null;
      let instance = null;
      try {
        instance = store.create();
      } catch {
        return null;
      }
      const actions = instance?.actions;
      if (actions === null || typeof actions !== "object" || typeof actions.openSection !== "function") return null;
      return actions.openSection.bind(actions);
    }

    /**
     * 「打开 DEG 设置」的严格能力适配器。
     *
     * 当前 DSH 不提供公开的设置分区跳转 API，唯一可达的链路是设置 Shell 注册在
     * `sidebar.settings` 席位上的 store 句柄（**未文档化的宿主内部句柄**，用户已确认接受
     * 该兼容风险）。本函数是本插件里**唯一**接触该句柄的地方，调用方只拿到一个已经验证过的
     * openSection 函数。
     *
     * 每次调用都重新读取账本（组件每帧渲染、每次点击都会再读一次），因此 HMR 或面板重挂载
     * 换掉 store 后不会继续调用旧句柄；任何一项校验不过都 fail-closed 并给出原因：
     * - 宿主缺少 `slots.entries` 读面 / 读面抛错 → slots-unavailable；
     * - 账本条目属性 getter 抛错（entry.options / **entry.store** / store.actions / store.create /
     *   instance.actions / actions.openSection）→ ledger-unreadable（同一类泛化提示）；
     * - `sidebar.settings` 没有条目 → sidebar-entry-missing；多于一条 → sidebar-entry-ambiguous；
     * - 条目**顶层**缺少 store（entry.store 非对象）→ store-missing；
     *   store 解不出 openSection → open-section-missing
     *   （含 `store.create()` 调用抛错这一既有覆盖）；
     * - DEG 自己的 `settings.section` 注册缺失 → section-missing；重复 → section-ambiguous。
     * 最后一项保证按钮不会把用户送到一个不存在的分区。
     *
     * @param {object} ctx 客户端插件上下文。
     * @returns {{available: boolean, reason: string|null, message: string|null, openSection: (Function|null)}}
     */
    function resolveDegSettingsSectionOpener(ctx) {
      const unavailable = (reason) => ({
        available: false,
        reason,
        message: DEG_SETTINGS_OPEN_FAILURE_TEXT[reason],
        openSection: null,
      });
      let slots = null;
      try {
        slots = ctx?.slots ?? null;
      } catch {
        slots = null;
      }
      const sectionEntries = readSlotLedger(slots, DEG_SETTINGS_SECTION_SLOT_NAME);
      const sidebarEntries = readSlotLedger(slots, DEG_SETTINGS_SIDEBAR_SLOT_NAME);
      if (sectionEntries === null || sidebarEntries === null) return unavailable("slots-unavailable");
      // 账本读取整段护栏：Host 的账本条目可能是代理对象，甚至 slots.entries 可以返回
      // Array.isArray 为真的**数组代理**。因此不只是 entry.options / entry.store 的 getter，
      // 数组自身的 length 与下标读取也可能抛错——它们必须一起归到同一类 fail-closed，
      // 绝不让一次渲染或一次点击把摘要打崩。
      let ownSectionCount = 0;
      let sidebarLength = 0;
      try {
        ownSectionCount = sectionEntries.filter((entry) => entry?.options?.id === DEG_SETTINGS_SECTION_ID).length;
        sidebarLength = sidebarEntries.length;
      } catch {
        return unavailable("ledger-unreadable");
      }
      if (ownSectionCount === 0) return unavailable("section-missing");
      if (ownSectionCount > 1) return unavailable("section-ambiguous");
      if (sidebarLength === 0) return unavailable("sidebar-entry-missing");
      if (sidebarLength > 1) return unavailable("sidebar-entry-ambiguous");
      let store = null;
      let openSection = null;
      try {
        // DSH 0.2.0-rc.2 的 StoredEntry 把 store 放在**条目顶层**（entry.store）；
        // entry.options 只承载 key/order/label/priority，读 options.store 只会拿到 undefined。
        store = sidebarEntries[0]?.store;
        if (store !== null && store !== undefined && typeof store === "object") {
          openSection = resolveSettingsShellOpenSection(store);
        }
      } catch {
        // entry.store / actions / create / instance.actions 的 getter 抛错：与"字段缺失"分开，
        // 统一报账本读取异常（泛化提示，不回显宿主异常原文）。
        return unavailable("ledger-unreadable");
      }
      if (store === null || store === undefined || typeof store !== "object") return unavailable("store-missing");
      if (openSection === null) return unavailable("open-section-missing");
      return { available: true, reason: null, message: null, openSection };
    }

    /**
     * 插件详情摘要的角色状态投影（与设置页的 `useEnabledSettingsRoles` **刻意分离**）。
     *
     * 设置页在 meta 缺失时回退历史默认五角色是既有行为，摘要不能借它：meta 没读到就不知道谁在跑，
     * 猜错会把未启用角色的 provider 写进"活跃 Provider"汇总，比留白更糟。因此只在 Host meta
     * **成功返回且带有效 activeRoles/roles 数组**时才认定启用角色；Observer 仍按 enableObserver
     * 合并（与设置页同一规则）。返回的 status 只表达"读到/读取中/不可用"三种事实。
     *
     * @param {object|null} hostMeta Host meta 响应体（useHostMeta 只在 ok:true 时落值）。
     * @param {string|null} hostMetaError 读取失败原因；仅用于区分"读取中"与"不可用"，不回显。
     * @returns {{status: "loading"|"ready"|"unavailable", roles: string[]|null}}
     */
    function resolvePluginDetailRoleStatus(hostMeta, hostMetaError) {
      if (hostMeta === null && hostMetaError === null) return { status: "loading", roles: null };
      const configured = hostMeta !== null && typeof hostMeta === "object"
        ? (Array.isArray(hostMeta.activeRoles) ? hostMeta.activeRoles : (Array.isArray(hostMeta.roles) ? hostMeta.roles : null))
        : null;
      if (configured === null) return { status: "unavailable", roles: null };
      const enabled = configured.filter((role) => STATUS_ROLE_IDS.includes(role));
      if (hostMeta.enableObserver === true && !enabled.includes("observer")) enabled.push("observer");
      return { status: "ready", roles: enabled.filter((role, index) => enabled.indexOf(role) === index) };
    }

    /**
     * 插件详情摘要的纯投影（界面与测试共用同一实现）。
     *
     * 输入只有已经读到的快照，不触发任何请求：
     * @param {object} [input]
     * @param {"ready"|"loading"|"unavailable"} [input.settingsStatus] 配置表单快照状态。
     * @param {object} [input.settingsValue] 配置表单值（`defaults[role] = { provider, model }`）。
     * @param {string} [input.catalogStatus] 模型目录状态（ready 之外的取值一律按"目录不可用"）。
     * @param {object[]} [input.catalogGroups] 模型目录 groups（`{ id, name }`）。
     * @param {string[]|null} [input.enabledRoles] 当前启用角色；null 表示角色表尚未读到。
     * @param {"ready"|"loading"|"unavailable"} [input.roleStatus] 角色表读取结论（见
     *   resolvePluginDetailRoleStatus）；缺省时按 enabledRoles 是否为数组推断。
     * @returns {{settingsStatus: string, roleStatus: string, statusText: string|null, roles: object[], activeProviders: object[], providerIds: string[], activeProviderText: string}}
     *
     * 角色状态判定顺序（前者优先）：
     * 1. 配置未就绪 → loading（文案区分"配置不可用"与"读取中"）；
     * 2. 角色表仍在读取 → loading；
     * 3. 角色表不可用（meta 失败/缺字段）→ unknown，不猜启用状态；
     * 4. 角色未启用 → disabled；
     * 5. 没有 provider 选择 → unconfigured；
     * 6. provider 已选但 model 为空（不完整配置）→ incomplete，不算"正在使用"；
     * 7. 其余（provider + model 都非空）→ configured。
     * 活跃 provider 只取「启用角色且 provider、model 都非空」的集合，按角色顺序去重；目录缺失或
     * 目录里没有该 id 时保留原始 id 并标记 `known: false`，绝不用目录里的其它 provider 冒充。
     */
    function describeDegPluginDetailSummary(input = {}) {
      const settingsStatus = typeof input.settingsStatus === "string" ? input.settingsStatus : "loading";
      const settingsValue = input.settingsValue;
      const catalogReady = input.catalogStatus === "ready";
      const catalogGroups = catalogReady && Array.isArray(input.catalogGroups) ? input.catalogGroups : [];
      const enabledRoles = Array.isArray(input.enabledRoles) ? input.enabledRoles : null;
      const requestedRoleStatus = input.roleStatus === "ready" || input.roleStatus === "unavailable" || input.roleStatus === "loading"
        ? input.roleStatus
        : (enabledRoles === null ? "loading" : "ready");
      // "已读到"却没有角色数组是矛盾输入（调用方读错了面）：按不可用处理，
      // 绝不当成"全部未启用"——后者会把未确认的默认角色配置从汇总里静默剔除。
      const roleStatus = requestedRoleStatus === "ready" && enabledRoles === null ? "unavailable" : requestedRoleStatus;
      const settingsPending = settingsStatus !== "ready";
      const defaults = settingsValue !== null && typeof settingsValue === "object" ? settingsValue.defaults : null;

      const providerInfoOf = (providerId) => {
        if (providerId.length === 0) return { label: "", known: false };
        const group = catalogGroups.find((candidate) => candidate?.id === providerId);
        const name = typeof group?.name === "string" && group.name.trim().length > 0 ? group.name : "";
        // 目录拿不到显示名（目录缺失 / 目录不含该 id / name 为空）时保留原始 id 并标注未知。
        return name.length > 0 ? { label: name, known: true } : { label: providerId, known: false };
      };

      const roles = [];
      const activeProviders = [];
      const seenProviders = new Set();
      for (const role of STATUS_ROLE_IDS) {
        const selection = defaults !== null && typeof defaults === "object" ? defaults[role] : null;
        const provider = typeof selection?.provider === "string" && selection.provider.length > 0 ? selection.provider : "";
        const model = typeof selection?.model === "string" ? selection.model : "";
        const { label: providerLabel, known: providerKnown } = providerInfoOf(provider);
        const enabledKnown = roleStatus === "ready";
        const enabled = enabledKnown && enabledRoles.includes(role) === true;
        let state;
        if (settingsPending || roleStatus === "loading") state = "loading";
        else if (roleStatus === "unavailable") state = "unknown";
        else if (enabled !== true) state = "disabled";
        else if (provider.length === 0) state = "unconfigured";
        else if (model.length === 0) state = "incomplete";
        else state = "configured";
        let stateText;
        if (state === "loading") stateText = settingsStatus === "unavailable" ? "配置不可用" : "读取中";
        else if (state === "unknown") stateText = "角色状态未知";
        else if (state === "disabled") stateText = "未启用";
        else if (state === "unconfigured") stateText = "未配置";
        else if (state === "incomplete") stateText = "待选模型";
        else stateText = "已配置";
        if (state === "configured" && seenProviders.has(provider) !== true) {
          seenProviders.add(provider);
          activeProviders.push({ id: provider, label: providerLabel, known: providerKnown });
        }
        roles.push({
          role,
          label: STATUS_ROLE_LABELS[role] ?? role,
          enabled,
          state,
          stateText,
          provider,
          providerLabel,
          providerKnown,
          model,
          // 角色行的 provider/model 展示面：没有 provider 时留空，由状态文案表达未配置。
          valueText: provider.length === 0 ? "" : (model.length > 0 ? providerLabel + " / " + model : providerLabel),
        });
      }
      // 卡片级状态行：只表达"读到/读取中/不可用"，绝不回显 Host 或 RPC 的错误原文。
      const statusText = settingsStatus === "unavailable"
        ? "配置表单不可用，无法读取角色配置。"
        : (settingsStatus !== "ready"
          ? "配置读取中…"
          : (roleStatus === "loading"
            ? "角色状态读取中…"
            : (roleStatus === "unavailable" ? "角色状态不可用，已停用活跃角色判定。" : null)));
      const providerIds = activeProviders.map((provider) => provider.id);
      return {
        settingsStatus,
        roleStatus,
        statusText,
        roles,
        activeProviders,
        providerIds,
        activeProviderText: activeProviders.length === 0
          ? "无"
          : activeProviders.map((provider) => provider.label).join("、"),
      };
    }

    /**
     * 插件详情摘要卡片：六角色表 + 活跃 provider + 真实设置跳转入口。
     *
     * 数据面全部来自公开 seam：配置表单（只读订阅）、模型目录（显示名），以及 Host meta
     * （活跃角色，与设置页同一个只读请求）。跳转能力每帧重算（见
     * resolveDegSettingsSectionOpener），点击时再算一次；调用抛异常时立即翻转成禁用，
     * 绝不把失败显示成成功，也绝不改成打开组合包详情。
     */
    function DegPluginDetailSummary({ settingsForm, modelCatalog, ctx }) {
      const subscribeSettings = react.useMemo(
        () => (typeof settingsForm?.subscribe === "function" ? settingsForm.subscribe.bind(settingsForm) : () => () => {}),
        [settingsForm],
      );
      const readSettings = react.useMemo(
        () => (typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot.bind(settingsForm) : () => void 0),
        [settingsForm],
      );
      const settingsSnapshot = react.useSyncExternalStore(subscribeSettings, readSettings);
      const subscribeCatalog = react.useMemo(
        () => (typeof modelCatalog?.subscribe === "function" ? modelCatalog.subscribe.bind(modelCatalog) : () => () => {}),
        [modelCatalog],
      );
      const readCatalog = react.useMemo(
        () => (typeof modelCatalog?.getSnapshot === "function" ? modelCatalog.getSnapshot.bind(modelCatalog) : () => void 0),
        [modelCatalog],
      );
      const catalogState = react.useSyncExternalStore(subscribeCatalog, readCatalog);
      // 只读一次 meta：活跃角色与设置页共用同一个请求，摘要不额外新增 RPC 形状。
      // 摘要刻意**不用**设置页的 useEnabledSettingsRoles：那条路径在 meta 缺失时会回退历史默认
      // 五角色（设置页既有行为，保持不变），而摘要一旦跟着回退就会把未确认启用角色的 provider
      // 写进"活跃 Provider"。这里只认 meta 的成功响应，其余情况显式标未知。
      const [hostMeta, , hostMetaError] = useHostMeta(ctx);
      const roleStatus = react.useMemo(
        () => resolvePluginDetailRoleStatus(hostMeta, hostMetaError),
        [hostMeta, hostMetaError],
      );
      const [failure, setFailure] = react.useState(null);
      react.useEffect(() => {
        // 目录调用是幂等的单飞请求，且与设置页共享同一实例：这里只为拿到 provider 显示名。
        try {
          void modelCatalog?.load?.();
        } catch {
          // 目录读取失败只影响显示名：原始 id 的回退路径照常工作。
        }
      }, [modelCatalog]);
      const model = describeDegPluginDetailSummary({
        settingsStatus: typeof settingsSnapshot?.status === "string" ? settingsSnapshot.status : "loading",
        settingsValue: settingsSnapshot?.value,
        catalogStatus: typeof catalogState?.status === "string" ? catalogState.status : "idle",
        catalogGroups: catalogState?.groups,
        roleStatus: roleStatus.status,
        enabledRoles: roleStatus.roles,
      });
      const capability = resolveDegSettingsSectionOpener(ctx);
      const noteText = failure?.message ?? (capability.available === true ? null : capability.message);
      const noteReason = failure?.reason ?? (capability.available === true ? null : capability.reason);
      /**
       * 点击处理：同步异常与异步拒绝都必须 fail-closed（禁用 + open-failed 提示）。
       *
       * 三段路径的边界：
       * 1. **同步返回**（当前 Host 的真实形态）：调用后立刻清提示并返回 undefined——
       *    绝不把同步路径包进 `Promise.resolve().then(...)`，那会给非 Promise 返回值平白加一次
       *    微任务延迟，也让点击的返回类型从 undefined 变成 Promise；
       * 2. **同步抛错**：按 open-failed 处理；
       * 3. **thenable（Promise/rejected Promise）**：只有真正的 thenable 才挂结算回调，且**在同一个
       *    tick 内**挂上 rejection 处理——否则未处理的 rejection 会冒到宿主页面，按钮还会错误地
       *    停在"看起来可用"的状态。成功结算不清提示：成功路径已经在第 1 步清过，而"后到的拒绝
       *    覆盖先到的成功"必须保持（fail-closed 只允许更保守，不允许被迟到的成功解锁）。
       * 任何一步失败都绝不回退到 openBundle 之类的替代动作。
       */
      const openSettings = () => {
        // 点击时重新读取：首帧渲染之后账本可能已经变化（HMR / 面板重挂载）。
        const current = resolveDegSettingsSectionOpener(ctx);
        if (current.available !== true) {
          setFailure({ reason: current.reason, message: current.message });
          return;
        }
        const failClosed = () => {
          setFailure({ reason: "open-failed", message: DEG_SETTINGS_OPEN_FAILURE_TEXT["open-failed"] });
        };
        let result;
        try {
          result = current.openSection(DEG_SETTINGS_SECTION_ID);
        } catch {
          failClosed();
          return;
        }
        setFailure(null);
        // 只对对象/函数探 then：原始值（undefined/void 返回值）连属性读取都不需要。
        if (result === null || (typeof result !== "object" && typeof result !== "function")) return;
        let then = null;
        try {
          then = result.then;
        } catch {
          // then 读取本身抛错的畸形 thenable：按调用失败处理，不当成功。
          failClosed();
          return;
        }
        if (typeof then !== "function") return;
        try {
          then.call(result, undefined, failClosed);
        } catch {
          failClosed();
        }
      };
      return react.createElement(
        "section",
        { className: "deg_pd", "data-deg-plugin-summary": "true", "aria-label": "DEG 配置摘要" },
        react.createElement("h4", { className: "deg_pd_title" }, "DEG 配置摘要"),
        react.createElement(
          "div",
          { className: "deg_pd_providers" },
          react.createElement("span", { className: "deg_pd_label" }, "活跃角色使用的 Provider"),
          react.createElement("span", {
            className: "deg_pd_providers_list",
            "data-deg-active-providers": model.providerIds.join("|"),
          }, model.activeProviders.length === 0
            ? react.createElement("span", { className: "deg_pd_empty" }, model.activeProviderText)
            : model.activeProviders.map((provider) => react.createElement("span", {
              key: provider.id,
              className: "deg_pd_tag",
              "data-deg-active-provider": provider.id,
              "data-deg-provider-known": provider.known ? "true" : "false",
              // 目录缺失或目录不含该 id 时的状态标注：保留原始 id，并说明为什么没有显示名。
              title: provider.known ? undefined : "模型目录未提供该 provider 的显示名，显示原始 id",
              "aria-label": provider.known ? undefined : provider.label + "（未知 Provider）",
            }, provider.label))),
        ),
        react.createElement("div", {
          className: "deg_pd_roles_header",
          "aria-hidden": "true",
        },
          react.createElement("span", null, "角色"),
          react.createElement("span", null, "Provider / 模型"),
          react.createElement("span", null, "状态"),
        ),
        react.createElement("ul", {
          className: "deg_pd_roles",
          "aria-label": "六个角色的 Provider、模型和配置状态",
          "data-deg-roles": model.roles.map((role) => role.role).join(","),
        }, model.roles.map((role) => react.createElement(
          "li",
          {
            key: role.role,
            className: "deg_pd_role",
            "data-deg-role": role.role,
            "data-deg-role-state": role.state,
            "data-deg-role-provider": role.provider,
            "data-deg-role-model": role.model,
          },
          react.createElement("span", { className: "deg_pd_role_name" }, role.label),
          react.createElement("span", { className: "deg_pd_role_value", title: role.valueText || undefined }, role.valueText),
          react.createElement("span", { className: "deg_pd_role_state" }, role.stateText),
        ))),
        model.statusText === null ? null : react.createElement("p", {
          className: "deg_pd_status",
          role: "status",
          // 角色状态结论（loading/ready/unavailable）的稳定标记：文案是可读面，这里给测试与自动化。
          "data-deg-role-status": model.roleStatus,
        }, model.statusText),
        react.createElement(
          "div",
          { className: "deg_pd_actions" },
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_btn_primary deg_pd_open",
            "data-deg-open-settings": "true",
            disabled: capability.available !== true || failure !== null,
            "aria-describedby": noteText === null ? undefined : "deg-pd-open-note",
            onClick: openSettings,
          }, "打开 DEG 设置"),
          noteText === null ? null : react.createElement("span", {
            id: "deg-pd-open-note",
            className: "deg_pd_note",
            role: "status",
            "data-deg-open-note": noteReason,
          }, noteText),
        ),
      );
    }


    // ── 插件主体：注册设置页与状态/元数据桥（通知由 Host 投递，客户端不挂载通知组件）。
    function apply(ctx) {
      ctx.effect(() => installImageSubmissionRoute(ctx), "dsh-expert-group: image submission route");
      // 设置页导航行的图标由宿主按 section id 硬编码（未知 id 回退齿轮），插件侧只能做 DOM 适配。
      ctx.effect(() => installDegSettingsNavIcon(), "dsh-expert-group: settings nav brand icon");
      ctx.effect(() => installNativeStatusBridge(ctx), "dsh-expert-group: native status bridge");
      const slots = ctx.slots;
      // 原生 system-prompt renderer 会通过 boundedText 截断；该 keyed renderer 只替换显示层，注册生命周期由 slots.inject 绑定到插件上下文。
      slots.inject("conversation.chat.node", () => slots.register({
        name: "conversation.chat.node",
        key: "system-prompt",
        priority: -1,
      }, FullSystemPromptNode));
      /**
       * 设置表单服务的安全解析（0.1.7-alpha.2 契约）。
       *
       * 唯一来源是 `ctx.configForms`（已删除的 `settingsScope` 不再存在，不做任何回退）：
       * 宿主没提供该服务、或服务代理拒答时返回 null，调用方据此走「不可用」降级，
       * 绝不让整条客户端入口失败（插件仍需注册设置页、侧边栏与通知桥）。
       */
      const resolveConfigForms = () => {
        try {
          const service = typeof ctx?.get === "function" ? ctx.get("configForms") : ctx?.configForms;
          return service !== undefined && service !== null ? service : null;
        } catch {
          // 未声明服务读取即抛错（Cordis 门控）：按宿主没有该服务处理。
          return null;
        }
      };
      const configForms = resolveConfigForms();
      /**
       * 取本插件 profile 条目的配置表单；条目 id 由 bundle 补丁固定为 `dsh-expert-group`。
       *
       * 表单由宿主（settings 提供者）持有，DEG 只读取与订阅，绝不销毁、也绝不调用它的
       * set/unset/mutate。服务缺失或 `get` 抛错时返回一个**不可用替身**：快照形状与真实表单
       * 完全一致（status: unavailable），设置页因此显示可读的不可用提示而不是崩溃。
       */
      const SETTINGS_ENTRY_ID = DEG_SETTINGS_SECTION_ID;
      const UNAVAILABLE_SETTINGS_SNAPSHOT = Object.freeze({
        status: "unavailable",
        value: undefined,
        base: undefined,
        user: undefined,
        revision: undefined,
        writable: false,
        mode: "memory",
      });
      const settingsForm = (() => {
        if (configForms === null || typeof configForms.get !== "function") {
          return {
            getSnapshot: () => UNAVAILABLE_SETTINGS_SNAPSHOT,
            subscribe: () => () => {},
          };
        }
        try {
          const form = configForms.get(SETTINGS_ENTRY_ID);
          if (form !== null && form !== undefined
            && typeof form.getSnapshot === "function" && typeof form.subscribe === "function") return form;
        } catch { /* 服务代理拒答或条目读取失败：按不可用降级。 */ }
        return {
          getSnapshot: () => UNAVAILABLE_SETTINGS_SNAPSHOT,
          subscribe: () => () => {},
        };
      })();
      const modelCatalog = createSettingsModelCatalog(ctx);
      // 「模型配置」区域的数据流与宿主面适配层：唯一纯函数实现位于 client-model-config.js
      // （装配期先于本 descriptor 执行的 IIFE），这里只做公开 API 接线。
      // describe 面唯一来源是 configForms.describe()；服务缺失时传 null，该区域降级为只读提示。
      const modelConfigHost = createModelConfigHost(ctx, configForms);
      // 独立设置页由插件注册到 Host 的 settings.section ledger，导航和生命周期仍由设置 Shell 管理。
      slots.inject(DEG_SETTINGS_SECTION_SLOT_NAME, () => slots.register({
        name: DEG_SETTINGS_SECTION_SLOT_NAME,
        id: SETTINGS_ENTRY_ID,
        order: 25,
        label: () => SETTINGS_ENTRY_ID,
        inject: () => ({ settingsForm, modelCatalog, modelConfigHost, ctx }),
      }, DshExpertGroupSettings));

      // 插件详情摘要挂在插件管理器的组合包页上：keyed slot，key 必须是组合包的 npm 包名。
      // 摘要只读（配置表单 + 模型目录 + meta），入口按钮走严格能力适配器真实跳转设置分区。
      slots.inject(DEG_PLUGIN_DETAIL_SLOT_NAME, () => slots.register({
        name: DEG_PLUGIN_DETAIL_SLOT_NAME,
        key: DEG_PLUGIN_DETAIL_ENTRY_KEY,
        inject: () => ({ settingsForm, modelCatalog, ctx }),
      }, DegPluginDetailSummary));

      // shell.overlay 只保留原生子代理行元数据；
      // fan-out 的可见控制面迁入 Expert Group，避免固定浮层与右侧任务树重复。
      // 通知不再占用 overlay：**系统通知（Windows 右下角 Toast）是唯一通知界面**，由 Host 侧
      // 负责投递；客户端既不渲染页面内卡片，也不创建浏览器 Notification，更不轮询通知快照，
      // 因此这里没有任何通知组件，也不再声明 inject（设置表单只服务设置页）。
      // 注册账本（同一 slot、同一个 descriptor id）保持不变。
      slots.inject("shell.overlay", () => slots.register({
        name: "shell.overlay",
        id: "dsh-expert-group-overlay",
        order: 0,
      }, (props) => react.createElement(
        react.Fragment,
        null,
        react.createElement(SubagentMetadataBridge, { ...props, ctx }),
      )));

      if (typeof expertGroupSidebar?.installExpertGroupSidebar === "function") {
        /**
         * settings 的「任务管理」开关控制 Expert Group 是否注册到侧边栏。
         *
         * - 缺字段/读取失败一律按开启处理：默认必须是历史行为（插件注册自己的侧边栏页面，
         *   DSH 或 dsh-better-sidebar 的默认侧栏保持不变）；
         * - 关闭时调用当前 install 返回的 disposer 释放已有注册（不回退、不改动 better-sidebar
         *   的 tabsEnabled 偏好，也不新增 DSH 本体注册）；
         * - install 返回的 disposer 不可复用，重新开启必须重新 install；
         * - 插件销毁时取消 settings 订阅并释放当前 disposer。
         */
        const sidebarDeps = {
          react,
          primitives,
          requestPluginRpc,
          resolveRootSessionId: expertGroupRootSessionIdOf,
          sessions: ctx.sessions,
          slots: ctx.slots,
          /**
           * 侧边栏「会话模型」复用设置页**同一份**模型目录 store（provider/model 的 datalist
           * 与思考深度档位都来自它）。目录的加载/刷新仍由该 store 单飞管理，侧栏只读
           * getSnapshot/subscribe，绝不自己再建一份目录或发额外请求。
           */
          modelCatalog,
          // 浏览器 confirm 是同步 API，Panel 以 Promise/boolean 双兼容方式消费。
          confirm: (message) => typeof globalThis.confirm === "function" && globalThis.confirm(message) === true,
          /**
           * 「自动打开」的实时读面：面板每次同步都现读配置表单快照。
           *
           * 不在这里读取一次再当常量传下去：设置页保存后必须立刻生效，而重装整个侧边栏
           * （disposer 不可复用）只为跟随一个偏好是过度且会打断侧栏状态的做法。
           * 读取失败/字段缺失一律按关闭（历史行为）。
           */
          getAutoOpenSubagentSidebar: () => readAutoOpenSubagentSidebar(),
          /** 面板标题栏 Auto 开关的写面：必须显式提交布尔值，否则设置页会一直显示旧值。 */
          setAutoOpenSubagentSidebar: (next) => commitAutoOpenSubagentSidebar(next),
        };
        /**
         * 「自动打开运行中的子代理侧栏」读面：唯一来源是配置表单当前快照。
         *
         * 只有显式 true 才算开启——旧文档缺字段、非布尔值与读取异常全部按关闭处理，
         * 保证默认行为与历史逐字节一致（不做任何自动 open/close）。
         */
        const readAutoOpenSubagentSidebar = () => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            return snapshot?.value?.autoOpenSubagentSidebar === true;
          } catch {
            return false;
          }
        };
        /**
         * 写面：把表单快照原样作为整体候选，只翻转 autoOpenSubagentSidebar 一个字段。
         *
         * 走的是设置页同一条 settings-commit（完整候选 + expectedRevision CAS），因此
         * 宿主的语义校验与并发栅栏照常生效；这里**不**重放设置页草稿，避免把未保存的
         * 编辑顺带提交。只读文档、快照不可用、校验失败或传输失败都返回 false，面板据此
         * 回退到权威读面（开关不会停在错误状态）。
         */
        const commitAutoOpenSubagentSidebar = async (next) => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            if (snapshot?.writable !== true) return false;
            const value = snapshot.value;
            if (value === null || typeof value !== "object") return false;
            await commitSettingsCandidate(
              { ...value, autoOpenSubagentSidebar: next === true },
              snapshot.revision,
              globalThis.fetch,
              ctx?.connection,
              PROMPT_ROLE_IDS,
            );
            return true;
          } catch {
            // 失败原因（只读/目录校验/修订冲突）由设置页承担呈现；面板只回退开关状态。
            return false;
          }
        };
        const readTaskManagementEnabled = () => {
          try {
            const snapshot = typeof settingsForm?.getSnapshot === "function" ? settingsForm.getSnapshot() : void 0;
            return snapshot?.value?.taskManagementEnabled !== false;
          } catch {
            // 读取配置表单异常（服务缺失/未就绪 store）不能导致侧边栏消失：按默认开启处理。
            return true;
          }
        };
        ctx.effect(() => {
          let disposer = null;
          const install = () => {
            if (disposer !== null) return;
            if (readTaskManagementEnabled() !== true) return;
            const release = expertGroupSidebar.installExpertGroupSidebar(ctx, {
              ...sidebarDeps,
              taskManagementEnabled: true,
            });
            disposer = typeof release === "function" ? release : null;
          };
          const uninstall = () => {
            const release = disposer;
            disposer = null;
            if (release === null) return;
            try {
              release();
            } catch {
              // 释放失败不能阻断后续重新安装，也不能让 settings 订阅清理失败。
            }
          };
          const sync = () => {
            if (readTaskManagementEnabled()) install();
            else uninstall();
          };
          // 初始化先同步读一次快照：缺字段/开启时必须在同步栈内完成注册，与历史行为一致。
          sync();
          let unsubscribe = () => {};
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
            try {
              unsubscribe();
            } catch {
              // 取消订阅失败不影响释放侧边栏注册。
            }
            unsubscribe = () => {};
            uninstall();
          };
        }, "dsh-expert-group-sidebar");
      }
    }

    exports.normalizeSettingsModelGroups = normalizeSettingsModelGroups;
    exports.normalizeSettingsDraft = normalizeSettingsDraft;
    // 票据 24：设置页候选/降级上限的公开纯函数面（界面与测试共用同一实现）。
    exports.normalizeModelCandidatesDraft = normalizeModelCandidatesDraft;
    exports.normalizeModelFallbackLimitDraft = normalizeModelFallbackLimitDraft;
    exports.validateModelCandidateRows = validateModelCandidateRows;
    // 模型页签的「页 → 层」纯函数面（界面与测试共用同一实现，不复制数据语义）。
    exports.modelPageCountOf = modelPageCountOf;
    exports.modelLayerSelectionOf = modelLayerSelectionOf;
    exports.setModelLayerSelection = setModelLayerSelection;
    exports.reorderModelLayers = reorderModelLayers;
    exports.addModelCandidatePage = addModelCandidatePage;
    exports.removeModelCandidatePage = removeModelCandidatePage;
    exports.compactModelCandidatesDraft = compactModelCandidatesDraft;
    exports.SETTINGS_EXTRA_MESSAGES = SETTINGS_EXTRA_MESSAGES;
    exports.settingsExtraText = settingsExtraText;
    exports.countUnicodeGraphemes = countUnicodeGraphemes;
    exports.validatePromptText = validatePromptText;
    exports.normalizePromptOverrides = normalizePromptOverrides;
    exports.normalizeRolePromptProjection = normalizeRolePromptProjection;
    exports.unifiedProviderOf = unifiedProviderOf;
    exports.migrateSettingsSelection = migrateSettingsSelection;
    exports.syncSettingsDefaultsProvider = syncSettingsDefaultsProvider;
    exports.migrateSettingsDefaults = migrateSettingsDefaults;
    exports.commitSettingsCandidate = commitSettingsCandidate;
    exports.formatSubagentMetadata = formatSubagentMetadata;
    exports.normalizeSubagentMetadata = normalizeSubagentMetadata;
    exports.collectSubagentCatalog = collectSubagentCatalog;
    exports.requestSubagentMetadata = requestSubagentMetadata;
    exports.findNativeSubagentTrees = findNativeSubagentTrees;
    exports.findNativeSubagentTreeItems = findNativeSubagentTreeItems;
    exports.findNativeSubagentRowParts = findNativeSubagentRowParts;
    exports.applySubagentMetadata = applySubagentMetadata;
    exports.removeSubagentMetadata = removeSubagentMetadata;
    exports.findNativeConversationScope = findNativeConversationScope;
    /**
     * 原生运行状态投影的公开面（与 shared.js 的同名导出语义同步）：
     * - NATIVE_RUNNING_STATUS_PREFIX / replaceNativeStatusPrefix：只替换宿主文案里的运行前缀，
     *   逗号、用时与末尾省略号仍来自宿主原文；
     * - resolveRunningStatusText：当前会话 running + 角色已知时的前缀文案（不带省略号）；
     * - createNativeTextRewriter：单个字段前缀重写器的保存/替换/恢复语义；
     * - findNativeStatusTextNode：当前会话的可见主文本节点（RC1 返回 data-shimmer 非装饰子树
     *   的真实可见 Text，legacy 形态返回各自的可见 Text），与 shared.js 的选择语义一致；
     * - installNativeStatusBridge：把上面这些接进 DSH 原生运行行的 observer 生命周期。
     * 测试跨这些公开 seam 验证行为，不读取生产源码文本。
     */
    // 票据 19：设置页 zh 回退表（仅供契约测试对比权威消息表，不参与运行期业务判断）。
    exports.SETTINGS_ZH_FALLBACK = SETTINGS_ZH_FALLBACK;
    exports.NATIVE_RUNNING_STATUS_PREFIXES = NATIVE_RUNNING_STATUS_PREFIXES;
    exports.NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIX;
    exports.replaceNativeStatusPrefix = replaceNativeStatusPrefix;
    exports.resolveRunningStatusText = resolveRunningStatusText;
    exports.createNativeTextRewriter = createNativeTextRewriter;
    exports.findNativeStatusTextNode = findNativeStatusTextNode;
    exports.installNativeStatusBridge = installNativeStatusBridge;
    exports.normalizeFanoutTask = normalizeFanoutTask;
    exports.mergeFanoutEvent = mergeFanoutEvent;
    exports.fanoutTaskLabel = fanoutTaskLabel;
    exports.fanoutStatusLabel = fanoutStatusLabel;
    exports.fanoutCanCancelShard = fanoutCanCancelShard;
    exports.fanoutCanRetryShard = fanoutCanRetryShard;
    exports.fanoutCanCancelParent = fanoutCanCancelParent;
    exports.normalizeFanoutListResponse = normalizeFanoutListResponse;
    exports.createClientFreshnessBoundary = createClientFreshnessBoundary;
    exports.normalizePluginRpcResult = normalizePluginRpcResult;
    exports.requestPluginRpc = requestPluginRpc;
    exports.expertGroupModel = expertGroupModel;
    exports.expertGroupSidebar = expertGroupSidebar;
    /**
     * 「模型配置」区域的纯数据流实现（provider 目录装配、草稿/路径操作、七档
     * reasoningEfforts 映射、继承与恢复默认、revision 冲突与角色联动守卫）。
     *
     * 唯一实现位于 client-model-config.js（装配期先于本 descriptor 执行的 IIFE）；
     * 共享实现未装载时保持 undefined，设置页随即跳过整个区域，不影响角色配置。
     */
    exports.modelConfig = globalThis[Symbol.for("dsh-expert-group/client-model-config")];
    /**
     * 用公开 API 装配「模型配置」宿主面（remote.llm / remote.credentials / remote.settings，
     * 以及 configForms.describe()）。导出给设置页与测试共用同一实现，不复制数据流。
     */
    exports.createModelConfigHost = createModelConfigHost;
    exports.MODEL_REASONING_EFFORTS = Object.freeze([
      "off", "minimal", "low", "medium", "high", "xhigh", "max",
    ]);
    /**
     * 设置页导航行品牌图标（DOM 适配）的公开面：
     * - DEG_SETTINGS_NAV_ICON_PATHS / DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS：artwork 常量，
     *   测试据此断言与 client-expert-group-sidebar.js 的 BRAND_ICON_PATHS 同值；
     * - isDegSettingsNavRow：导航行的匹配纯逻辑（label 严格相等 + 含 svg）；
     * - installDegSettingsNavIcon：observer 生命周期，apply 用 ctx.effect 绑定它。
     */
    /**
     * 插件详情摘要的公开面：
     * - describeDegPluginDetailSummary：六角色 / 活跃 provider 的纯投影（界面与测试共用同一实现）；
     * - resolveDegSettingsSectionOpener：唯一一处接触 Host 内部 sidebar.settings store 句柄的
     *   严格能力适配器（未文档化方案，用户已确认接受兼容风险）；
     * - DEG_PLUGIN_DETAIL_SLOT_NAME / DEG_PLUGIN_DETAIL_ENTRY_KEY：注册契约常量。
     */
    exports.describeDegPluginDetailSummary = describeDegPluginDetailSummary;
    exports.resolveDegSettingsSectionOpener = resolveDegSettingsSectionOpener;
    exports.DEG_PLUGIN_DETAIL_SLOT_NAME = DEG_PLUGIN_DETAIL_SLOT_NAME;
    exports.DEG_PLUGIN_DETAIL_ENTRY_KEY = DEG_PLUGIN_DETAIL_ENTRY_KEY;
    exports.DEG_SETTINGS_NAV_ICON_PATHS = DEG_SETTINGS_NAV_ICON_PATHS;
    exports.DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS = DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
    exports.isDegSettingsNavRow = isDegSettingsNavRow;
    exports.installDegSettingsNavIcon = installDegSettingsNavIcon;
    exports.apply = apply;
    exports.inject = [
      "slots", "sessions", "configForms", "remote", "remote.session", "remote.llm", "remote.credentials", "remote.settings", "conversation", "connection",
      // 「模型配置」区域使用公开的 settings schema 服务（rehydrate/validate/nodeAtPath）；
      // 未安装时该区域降级为"不本地校验"，仍由正式 settings API 做 schema 校验。
      "settingsSchema",
    ];
    return module.exports;
  }
});