/**
 * 客户端设置页文案层（locale 解析 + zh 回退表 + 本票据新增控件文案）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-text")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientText(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-text");
  const clientExpertGroupModelSymbol = Symbol.for("dsh-expert-group/client-expert-group-model");
  const expertGroupModel = global[clientExpertGroupModelSymbol];

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
      "settings.sidebarEntry": "左侧栏入口",
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
      "settings.orchestrator.empty": "未配置（不干预主代理模型）",
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
    /**
     * 文案模板插值：把 `{name}` 替换为 vars 里的同名值，缺失/为 null 的占位符**原样保留**。
     *
     * 两个文案入口（settingsText 的 zh 回退表、settingsExtraText 的本地表）原先各写了一份
     * 逐字相同的插值块，这里合并；正则、变量取值口径、String() 转换与"缺失保留占位符"的
     * 语义全部原样不变。
     */
    function interpolateSettingsTemplate(template, vars) {
      const values = vars !== null && typeof vars === "object" ? vars : {};
      return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
        const value = values[name];
        return value === void 0 || value === null ? match : String(value);
      });
    }
    /** 取一条设置页文案：模型可用时走权威投影；缺失时用 zh 回退表插值（绝不显示键名）。 */
    function settingsText(locale, key, vars) {
      const model = localeModelApi();
      if (typeof model?.translateMessage === "function") return model.translateMessage(locale, key, vars);
      const template = SETTINGS_ZH_FALLBACK[key];
      if (template === undefined) return "—";
      return interpolateSettingsTemplate(template, vars);
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
      // 峰谷模式（票据 07）：入口按钮、设置页内子视图与时段编辑的本地文案。
      "settings.pv.entry": { zh: "峰谷模式" },
      "settings.pv.enable": { zh: "启用峰谷模式" },
      // 「已初始化（只读）…」那条只读说明已按 UI 精简要求删除（initialized 时整段不渲染），
      // 键一并移除避免留下永不命中的死文案。
      "settings.pv.uninit": { zh: "首次启用会从普通配置复制峰、谷两套模型" },
      // 峰谷子视图的两个返回入口（左上角「← 返回」与页脚「返回」）共用这一条。
      "settings.pv.back": { zh: "返回" },
      "settings.pv.peak": { zh: "峰时" },
      "settings.pv.valley": { zh: "谷时" },
      // 侧栏标题栏的时段标记（票据 09）：未启用态；峰/谷两态直接复用上面的两个 key，
      // 因此「Auto 右侧的标记」与「设置页入口按钮的后缀」永远同一份文案。
      "settings.pv.disabled": { zh: "峰谷：未启用" },
      // 「峰段时段」标签已按 UI 精简删除（键一并移除，避免死文案）；区块语义改由启用开关承担。
      "settings.pv.add": { zh: "添加峰段" },
      // 可见文字只留「删除」；aria-label 由 remove.aria + 行号拼成「删除峰段N」，
      // 屏幕阅读器与既有自动化仍能按序号定位到具体行。
      "settings.pv.remove": { zh: "删除" },
      "settings.pv.remove.aria": { zh: "删除峰段" },
      "settings.pv.start": { zh: "开始" },
      "settings.pv.end": { zh: "结束" },
      "settings.pv.noValley": { zh: "当前没有谷时" },
      "settings.pv.invalid": { zh: "峰谷时段不合法：{reason}" },
      // 主设置页的「当前时段」视图（票据 08）：锁定的编辑目标与跨边界常驻提示。
      // 损坏档案的修复路径：读取面 invalidCode 非空时只允许「修复并保存」写回峰谷字段。
      "settings.pv.broken": { zh: "峰谷配置损坏，请到峰谷设置页修复" },
      "settings.pv.repairHint": { zh: "峰谷配置已损坏，请修复后保存" },
      "settings.pv.repair": { zh: "修复并保存" },
      "settings.pv.mainScope": { zh: "本页正在编辑{period}模型（打开页面时锁定）" },
      "settings.pv.boundary": { zh: "当前已进入{current}，本页仍在编辑{editing}模型" },
    });
    /** 取本票据新增控件的文案：locale 缺失或该语言无译文时回退 zh，绝不渲染键名。 */
    function settingsExtraText(locale, key, vars) {
      const entry = SETTINGS_EXTRA_MESSAGES[key];
      if (entry === void 0) return settingsText(locale, key, vars);
      const template = typeof entry[locale] === "string" && entry[locale].length > 0 ? entry[locale] : entry.zh;
      return interpolateSettingsTemplate(template, vars);
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    SETTINGS_EXTRA_MESSAGES, SETTINGS_ZH_FALLBACK, resolveSettingsLocale, settingsExtraText, settingsText,
  });
})(globalThis);
