/**
 * Host 侧多语言文案。
 *
 * zh/en 消息表、locale 归一与原生运行状态前缀（客户端持有一份逐键投影）。
 * 本文件由原 `shared.js` 的 3319–3609 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/i18n
 */

/**
 * 文案层（票据 19）：集中消息表 + locale 解析。
 *
 * 设计边界：
 * - 本文件是 Host 与客户端共享语义的**权威副本**；浏览器无法 import 本模块，因此
 *   client-expert-group-model.js 里有一份逐键同值的投影（构建期由装配脚本排在其前执行）。
 *   两份漂移由 test/expert-group-model.test.mjs 的键值对比守住。
 * - 默认语言是 zh；支持 zh / en 两种语言。缺失键回退 zh，zh 也缺失时返回中性占位符，
 *   绝不让空串或键名出现在界面上。
 * - 变量插值只支持 {name} 形式；缺失变量保留原占位符（便于发现调用方漏传），绝不输出 undefined。
 */
export const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);
export const DEFAULT_LOCALE = "zh";
/** 两份语言表都缺键时的唯一中性占位：绝不显示空串，也绝不把内部键名暴露给用户。 */
export const MISSING_MESSAGE_TEXT = "—";

/**
 * 消息表：扁平点分键 → 各语言文案。
 *
 * 覆盖面（票据 19 范围）：侧栏关键路径、设置页核心控件、系统通知标题/正文、运行状态播报。
 * 角色 persona/提示词与长诊断行不在本表范围（不在本期翻译范围）。
 */
export const MESSAGE_CATALOG = Object.freeze({
  "sidebar.title": { zh: "Expert Group", en: "Expert Group" },
  "sidebar.empty": { zh: "暂无 Expert Group 任务", en: "No Expert Group tasks yet" },
  "sidebar.error.snapshot": { zh: "快照读取失败", en: "Snapshot read failed" },
  "sidebar.error.action": { zh: "操作失败", en: "Action failed" },
  "sidebar.error.rpc": { zh: "请求失败", en: "Request failed" },
  "sidebar.refresh": { zh: "刷新", en: "Refresh" },
  "sidebar.retry": { zh: "重试", en: "Retry" },
  "sidebar.idleGroup": { zh: "空闲子代理（{count}）", en: "Idle subagents ({count})" },
  "sidebar.idleGroup.name": { zh: "空闲子代理", en: "Idle subagents" },
  "sidebar.search.label": { zh: "任务过滤", en: "Filter tasks" },
  "sidebar.search.aria": { zh: "搜索任务", en: "Search tasks" },
  "sidebar.search.placeholder": { zh: "搜索任务名 / 角色 / 模型", en: "Search task name / role / model" },
  "sidebar.filter.role": { zh: "按角色筛选", en: "Filter by role" },
  "sidebar.filter.status": { zh: "按状态筛选", en: "Filter by status" },
  "sidebar.filter.allRoles": { zh: "全部角色", en: "All roles" },
  "sidebar.filter.allStatuses": { zh: "全部状态", en: "All statuses" },
  "sidebar.filter.empty": { zh: "没有匹配的任务", en: "No matching tasks" },
  "sidebar.collapse": { zh: "收起", en: "Collapse" },
  "sidebar.expand": { zh: "展开", en: "Expand" },
  "sidebar.recovery.retry": { zh: "重试恢复", en: "Retry recovery" },
  "sidebar.recovery.retrying": { zh: "重试中…", en: "Retrying…" },
  "sidebar.sessionModel.open": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.title": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.hint": {
    zh: "只影响本会话的专家派发，不改变全局默认；清除后恢复跟随当前默认。",
    en: "Affects expert dispatch in this session only; global defaults are unchanged. Clear an override to follow the current default again.",
  },
  "sidebar.sessionModel.openTitle": {
    zh: "按会话修改专家模型，不影响全局默认",
    en: "Change expert models for this session; global defaults are unchanged",
  },
  "sidebar.sessionModel.close": { zh: "关闭", en: "Close" },
  // 底部「恢复默认」：清除本会话全部角色覆盖（不是把当前值写成覆盖），左邻「关闭」。
  "sidebar.sessionModel.restore": { zh: "恢复默认", en: "Restore defaults" },
  "sidebar.sessionModel.noSession": {
    zh: "未打开会话：打开一个会话后可在此临时覆盖角色模型。",
    en: "No open session: open a session to temporarily override role models here.",
  },
  "sidebar.sessionModel.child": {
    zh: "当前是子代理会话，会话级模型覆盖只读。",
    en: "This is a subagent session; session model overrides are read-only.",
  },
  "sidebar.sessionModel.loading": { zh: "正在读取本会话覆盖…", en: "Loading session overrides…" },
  "sidebar.sessionModel.unavailable": {
    zh: "本会话覆盖读取失败，请稍后重试。",
    en: "Failed to read session overrides; please retry later.",
  },
  "sidebar.sessionModel.unsupported": {
    zh: "当前宿主版本不支持会话级模型覆盖。",
    en: "This host version does not support session model overrides.",
  },
  "sidebar.sessionModel.offline": {
    zh: "会话未运行：会话级覆盖只读。",
    en: "The session is not running; session overrides are read-only.",
  },
  "sidebar.sessionModel.revision": { zh: "代次 {revision}", en: "Revision {revision}" },
  "sidebar.sessionModel.provider": { zh: "供应商", en: "Provider" },
  "sidebar.sessionModel.effort": { zh: "思考深度", en: "Reasoning effort" },
  "sidebar.sessionModel.effortDefault": { zh: "模型默认", en: "Model default" },
  "sidebar.sessionModel.save": { zh: "保存覆盖", en: "Save override" },
  "sidebar.sessionModel.clear": { zh: "清除", en: "Clear" },
  "sidebar.sessionModel.saved": { zh: "已保存本会话覆盖", en: "Session override saved" },
  "sidebar.sessionModel.cleared": { zh: "已清除，恢复全局默认", en: "Cleared; global default restored" },
  "sidebar.sessionModel.conflict": {
    zh: "其他页面已修改本会话覆盖（当前代次 {revision}）；你的输入已保留，请确认后重试。",
    en: "Another page changed this session's overrides (current revision {revision}); your input was kept, please review and retry.",
  },
  "sidebar.sessionModel.failed": { zh: "保存失败：{message}", en: "Save failed: {message}" },
  "sidebar.sessionModel.retry": { zh: "重新读取", en: "Reload" },
  "sidebar.sessionModel.emptyRoles": { zh: "没有可配置的专家角色。", en: "No configurable expert roles." },
  "sidebar.sessionModel.columnRole": { zh: "专家", en: "Expert" },
  "sidebar.sessionModel.columnModel": { zh: "模型选择", en: "Model" },
  "sidebar.sessionModel.tableLabel": { zh: "会话模型覆盖", en: "Session model overrides" },
  "sidebar.sessionModel.saveChanges": { zh: "保存", en: "Save" },
  "sidebar.sessionModel.invalidDraft": {
    zh: "请为已修改的角色选择供应商和模型。",
    en: "Choose a provider and model for every edited role.",
  },
  "sidebar.sessionModel.clearRole": {
    zh: "清除{role}的本会话覆盖",
    en: "Clear the session override for {role}",
  },
  // 主代理（Orchestrator）行（侧栏「会话模型」弹窗第一行）：值、来源与状态标记。
  // 状态键名与 Host 的 get().orchestrator.applyState **六态一一对应**：判定在 Host
  // （host/orchestrator-model.js 的判定表），客户端只按状态选文案，绝不用 effective 猜。
  "sidebar.sessionModel.orchestrator.applied": {
    zh: "实际生效：{value}（{source}）",
    en: "Applied: {value} ({source})",
  },
  "sidebar.sessionModel.orchestrator.pending": {
    zh: "正在应用：{value}（{source}）",
    en: "Applying: {value} ({source})",
  },
  "sidebar.sessionModel.orchestrator.unapplied": {
    zh: "配置未生效：{value}（{source}）",
    en: "Not applied: {value} ({source})",
  },
  "sidebar.sessionModel.orchestrator.manual": { zh: "本会话已手动接管", en: "Manually taken over in this session" },
  "sidebar.sessionModel.orchestrator.none": { zh: "不干预", en: "Not configured" },
  "sidebar.sessionModel.orchestrator.host-not-ready": { zh: "宿主未就绪", en: "Host not ready" },
  "sidebar.sessionModel.orchestrator.degraded": { zh: "已降级到候选 {index}", en: "Degraded to candidate {index}" },
  "sidebar.sessionModel.orchestrator.saved": {
    zh: "已保存，主代理模型下一轮生效",
    en: "Saved; the orchestrator model applies from the next turn",
  },
  "sidebar.sessionModel.orchestrator.source.override": { zh: "会话覆盖", en: "Session override" },
  "sidebar.sessionModel.orchestrator.source.period": { zh: "当前时段", en: "Current period" },
  "sidebar.sessionModel.orchestrator.source.global": { zh: "全局配置", en: "Global config" },
  "sidebar.sessionModel.orchestrator.source.none": { zh: "不干预", en: "Not configured" },
  "settings.orchestrator.empty": {
    zh: "未配置（不干预主代理模型）",
    en: "Not configured (orchestrator model untouched)",
  },
  "settings.title": { zh: "dsh-expert-group", en: "dsh-expert-group" },
  "settings.hint": {
    zh: "专家模型使用 DSH 当前已配置的 provider 和模型目录。",
    en: "Expert models use the providers and model catalog configured in DSH.",
  },
  "settings.taskManagement": { zh: "任务管理", en: "Task management" },
  "settings.auto": { zh: "Auto", en: "Auto" },
  "settings.autoTitle": {
    zh: "自动打开运行中的子代理侧栏会话",
    en: "Automatically open running subagent sidebar sessions",
  },
  "settings.sidebarEntry": { zh: "左侧栏入口", en: "Sidebar entry" },
  "settings.notifications": { zh: "通知弹窗", en: "Notifications" },
  "settings.notificationVolume": { zh: "通知音量", en: "Notification volume" },
  "settings.notificationEvents": { zh: "通知事件", en: "Notification events" },
  "settings.notificationVolume.range": { zh: "通知音量滑块", en: "Notification volume slider" },
  "settings.notificationVolume.number": { zh: "通知音量数值", en: "Notification volume value" },
  "settings.notificationEvent.completed": { zh: "任务完成", en: "Task completed" },
  "settings.roleTimeout.aria": { zh: "角色默认超时", en: "Default role timeout" },
  "settings.notificationEvent.completed.aria": { zh: "通知任务完成", en: "Notify on task completed" },
  "settings.notificationEvent.waiting.aria": { zh: "通知等待用户", en: "Notify on waiting for user" },
  "settings.notificationEvent.failed.aria": { zh: "通知任务失败", en: "Notify on task failed" },

  "settings.notificationEvent.waiting": { zh: "等待用户", en: "Waiting for user" },
  "settings.notificationEvent.failed": { zh: "任务失败", en: "Task failed" },

  "settings.unifiedProvider": { zh: "统一供应商", en: "Unified provider" },
  "settings.noProvider": { zh: "无", en: "None" },
  "settings.observerPreferred": { zh: "Observer优先", en: "Prefer Observer" },
  "settings.concurrencyLimit": { zh: "单个角色并发上限", en: "Per-role concurrency limit" },
  "settings.concurrencyLimit.title": {
    zh: "取值范围 1–64 的整数；默认 20；保存后生效",
    en: "An integer from 1–64; defaults to 20; takes effect after saving",
  },
  "settings.roleTimeout": { zh: "角色默认超时 (s)", en: "Default role timeout (s)" },
  "settings.roleTimeout.title": {
    zh: "默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
    en: "Defaults to 10 hours (36000 s); 0 disables it; enabled values are 1–86400 s (integer, 1 s precision). Applies only to attempts created after saving; running shards are unchanged.",
  },
  "settings.save": { zh: "保存", en: "Save" },
  "settings.saving": { zh: "保存中…", en: "Saving…" },
  "settings.discard": { zh: "放弃修改", en: "Discard changes" },
  "settings.saved": { zh: "已保存", en: "Saved" },
  "settings.unsaved": { zh: "有未保存的修改", en: "Unsaved changes" },
  "announce.start": { zh: "任务开始：{name}", en: "Task started: {name}" },
  "announce.finish": { zh: "任务完成：{name}", en: "Task finished: {name}" },
  "announce.fail": { zh: "任务失败：{name}", en: "Task failed: {name}" },
  "announce.cancel": { zh: "任务取消：{name}", en: "Task cancelled: {name}" },
  "announce.more": { zh: "等 {count} 项", en: "and {count} more" },
  "notify.termination.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.termination.completed": { zh: "任务已完成。", en: "Task completed." },
  "notify.termination.blocked": { zh: "任务被阻塞，需要你处理。", en: "Task blocked; your input is needed." },
  "notify.termination.error": { zh: "任务因错误终止。", en: "Task terminated with an error." },
  "notify.termination.aborted": { zh: "任务已中止。", en: "Task aborted." },
  "notify.termination.interrupted": { zh: "任务被中断。", en: "Task interrupted." },
  "notify.termination.max-tokens": { zh: "任务达到 token 上限。", en: "Task reached the token limit." },
  "notify.termination.unknown": { zh: "任务已终止。", en: "Task terminated." },
  "notify.test.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.body": { zh: "需要你操作", en: "Your action is required" },
  "notify.test.body": {
    zh: "测试通知：系统通知通道可用。",
    en: "Test notification: the system notification channel is available.",
  },
  // 说明：长等待与后代查询降级两条文案（原 waitLong / waitQueryDegraded 键）按产品要求
  // 随系统通知一并移除；账本侧的定时器、issue 与诊断字段保持不变。
  "notify.waitDeliveryFailed.body": {
    zh: "专家批次已静止，但收口结论投递失败；批次保持待收口，插件会在后续 root turn 重试。",
    en: "The expert batch is quiescent but delivering the finalization result failed; the batch remains pending and the plugin retries on later root turns.",
  },
  // ── 会话删除（票据 06/07）──────────────────────────────────────────────────
  // 键前缀统一为 sidebar.sessionDelete.*：两个删除入口、多选操作条、确认框、「不可删除」
  // 说明、一次性结果弹窗与入口级失败。中英双语成对，客户端字典逐键同值。
  // 取消/删除/关闭直接复用既有 sidebar.* 键，不新增同义文案。
  "sidebar.sessionDelete.row.aria": { zh: "删除「{title}」", en: "Delete \"{title}\"" },
  "sidebar.sessionDelete.menu": { zh: "删除会话", en: "Delete session" },
  "sidebar.sessionDelete.multi": { zh: "删除多选会话", en: "Delete multiple sessions" },
  "sidebar.sessionDelete.bar.selectAll": { zh: "全选", en: "Select all" },
  "sidebar.sessionDelete.bar.deselectAll": { zh: "取消全选", en: "Deselect all" },
  "sidebar.sessionDelete.bar.selected": { zh: "已选 {count}", en: "{count} selected" },
  "sidebar.sessionDelete.bar.blocked": { zh: "{count} 个被占用", en: "{count} in use" },
  "sidebar.sessionDelete.checkbox.aria": { zh: "选择「{title}」", en: "Select \"{title}\"" },
  "sidebar.sessionDelete.dialog.cancel": { zh: "取消", en: "Cancel" },
  "sidebar.sessionDelete.dialog.confirm": { zh: "删除", en: "Delete" },
  "sidebar.sessionDelete.dialog.running": { zh: "删除中…", en: "Deleting…" },
  "sidebar.sessionDelete.dialog.title": { zh: "删除会话", en: "Delete session" },
  "sidebar.sessionDelete.dialog.single": { zh: "确定删除「{title}」？", en: "Delete \"{title}\"?" },
  "sidebar.sessionDelete.dialog.batch": { zh: "将处理 {count} 个会话。", en: "Processes {count} sessions." },
  "sidebar.sessionDelete.dialog.absent": { zh: "其中 {count} 个仅清理残留配置。", en: "{count} are leftover-only." },
  "sidebar.sessionDelete.dialog.blocked": { zh: "另有 {count} 个被占用，不会删除。", en: "{count} are in use and skipped." },
  "sidebar.sessionDelete.dialog.first": { zh: "前 {count} 个：{titles}", en: "First {count}: {titles}" },
  "sidebar.sessionDelete.dialog.irreversible": { zh: "此操作不可恢复。", en: "This cannot be undone." },
  "sidebar.sessionDelete.blocked.title": { zh: "不可删除", en: "Cannot delete" },
  "sidebar.sessionDelete.blocked.live": { zh: "该会话仍被 DSH 占用，重启 DSH 后可删除。", en: "In use by DSH; restart DSH to delete." },
  "sidebar.sessionDelete.blocked.liveDescendant": { zh: "子会话「{title}」仍被占用，重启 DSH 后可删除。", en: "Sub-session \"{title}\" is in use; restart DSH." },
  "sidebar.sessionDelete.blocked.pending": { zh: "上次删除的清理未完成，重启 DSH 后再试。", en: "Previous cleanup unfinished; restart DSH." },
  "sidebar.sessionDelete.blocked.missing": { zh: "该会话不在本工作区可删除范围内。", en: "Not in this workspace's deletable set." },
  // 原因文案（skipped / failed / raced）与结果弹窗的一句话共用同一批短句。
  "sidebar.sessionDelete.reason.skipped": { zh: "仍被占用", en: "still in use" },
  "sidebar.sessionDelete.reason.failed": { zh: "删除失败", en: "delete failed" },
  "sidebar.sessionDelete.reason.raced": { zh: "未完成（会话被重新打开，内容已保留）", en: "not deleted (reopened, kept)" },
  "sidebar.sessionDelete.outcome.deleted": { zh: "已删除 {count} 个", en: "{count} deleted" },
  "sidebar.sessionDelete.outcome.absent": { zh: "清理残留 {count} 个", en: "{count} leftover cleaned" },
  "sidebar.sessionDelete.outcome.kept": { zh: "{count} 个未删除：{reasons}", en: "{count} not deleted: {reasons}" },
  "sidebar.sessionDelete.outcome.join": { zh: "，", en: ", " },
  "sidebar.sessionDelete.outcome.reasonJoin": { zh: "、", en: ", " },
  "sidebar.sessionDelete.error.candidates": { zh: "读取可删除会话失败：{message}", en: "Cannot list deletable sessions: {message}" },
  "sidebar.sessionDelete.error.delete": { zh: "删除失败：{message}", en: "Delete failed: {message}" },
});


/**
 * 语言标识归一：`zh-CN` / `zh_TW` / `EN-us` 都归一为主语言子标签；不支持的返回 null。
 * @param {unknown} value
 * @returns {"zh"|"en"|null}
 */
export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "zh") return "zh";
  if (primary === "en") return "en";
  return null;
}

/**
 * 按候选顺序解析语言：返回第一个受支持的 locale，全部不可识别时回退默认 zh。
 * 纯函数（不读环境），便于测试注入。
 */
export function resolveLocale(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = normalizeLocale(candidate);
    if (normalized !== null) return normalized;
  }
  return DEFAULT_LOCALE;
}

/**
 * 取一条文案并做变量插值（缺失键回退 zh；两份都缺失返回中性占位，绝不显示空串或键名）。
 * @param {string} locale - zh / en（其它值按默认 zh 处理）。
 * @param {string} key - 消息表键。
 * @param {Record<string, unknown>} [vars] - {name} 形式的插值变量。
 */
export function translateMessage(locale, key, vars = {}) {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const entry = MESSAGE_CATALOG[key];
  if (entry === void 0 || entry === null) return MISSING_MESSAGE_TEXT;
  const template = typeof entry[normalized] === "string" && entry[normalized].length > 0
    ? entry[normalized]
    : (typeof entry[DEFAULT_LOCALE] === "string" ? entry[DEFAULT_LOCALE] : "");
  if (template.length === 0) return MISSING_MESSAGE_TEXT;
  const values = vars !== null && typeof vars === "object" ? vars : {};
  return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
    const value = values[name];
    return value === void 0 || value === null ? match : String(value);
  });
}

/**
 * Host 侧 locale 解析顺序：config.locale → 环境 LANG/LC_ALL/LC_MESSAGES → Intl 运行时 locale → zh。
 *
 * 「无法可靠获取」= 所有候选都无法归一成受支持语言（缺失、空串、fr 等）。此时回退 zh 并调用
 * onFallback（组合根用它记一条 warn），绝不静默切换到 en 或抛出。
 * @param {{configLocale?:unknown, env?:Record<string,unknown>, intl?:{DateTimeFormat?:Function}, onFallback?:Function}} [options]
 */
export function resolveHostLocale(options = {}) {
  const env = options.env ?? {};
  const candidates = [options.configLocale, env.LC_ALL, env.LC_MESSAGES, env.LANG];
  const recognized = candidates.filter((candidate) => normalizeLocale(candidate) !== null);
  if (recognized.length === 0) {
    let intlLocale = null;
    try {
      const intl = options.intl ?? (typeof Intl !== "undefined" ? Intl : null);
      intlLocale = intl?.DateTimeFormat?.().resolvedOptions?.().locale ?? null;
    } catch { intlLocale = null; }
    if (normalizeLocale(intlLocale) === null) {
      try { options.onFallback?.({ reason: "locale-unresolved" }); } catch { /* 记录失败不影响通知。 */ }
      return DEFAULT_LOCALE;
    }
    return normalizeLocale(intlLocale);
  }
  return resolveLocale(recognized);
}

/**
 * 原生运行状态行的可替换前缀候选（票据 19：中文/英文 locale 都生效）。
 *
 * 顺序即匹配优先级：中文宿主用「深度求索中」，英文宿主可能是 "Deep diving" / "Deep thinking" /
 * "Thinking"。只替换原文中**最早出现**的候选中第一个（同一位置优先更长的候选），未知前缀仍
 * fail-closed（返回 null，保持宿主原文）。
 */
export const NATIVE_RUNNING_STATUS_PREFIXES = Object.freeze([
  "深度求索中",
  "Deep diving",
  "Deep thinking",
  "Thinking",
]);

/**
 * 向后兼容的单一前缀导出：保留旧名字给既有消费方读取，值仍是中文主前缀。
 * 新代码必须使用 NATIVE_RUNNING_STATUS_PREFIXES（中英文都生效）。
 */
export const NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIXES[0];
