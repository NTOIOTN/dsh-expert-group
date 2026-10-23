/**
 * 客户端侧栏 · Panel 实例级状态（第一段，R6 / sidebar-panel-state-a）
 *
 * ## 职责边界（R6 票据 22）
 * Panel 的**实例级**状态机械的一半：宿主语言/文案解析、本地过滤派生、宽度拖拽比例换算、
 * fanout 事件游标推进、surface 身份令牌派生、任务状态播报差异。
 *
 * ## 三种生命周期（规格书 §状态所有权(3)）中本文件的位置
 * 这里全部是**实例级**派生：每次挂载重建、卸载即弃。本文件**不**持有任何容器：
 * - 没有模块级 Map/缓存（工厂级快照缓存归 client-sidebar-panel-cache.js）；
 * - 没有跨 bundle 共享账本（归 client-sidebar-auto-ledger.js）；
 * - 调用方把「本帧的 ref 当前值 / state 值」作为参数传进来，返回值再由调用方写回自己的 ref/state。
 * 因此 React Hook 的调用顺序与相对位置完全不受影响：本文件里没有任何 Hook。
 *
 * ## 纯函数口径
 * 每个函数都是「输入 → 输出」的确定性映射（唯一的例外是 passesFilter 返回的闭包，它只是把
 * 已算好的 filterActive 与 taskFilter 绑定起来）。副作用（setState / ref 写入 / DOM 事件注册）
 * 一律留在 Panel 里，本文件不 import react、不读 globalThis 的宿主服务。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-panel-state-a")]
 * 装配：只从 globalThis 检查点取回 pure 依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarPanelStateA(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    ANNOUNCEMENT_MAX_ITEMS, RIGHTBAR_WIDTH_RATIO, RIGHTBAR_WIDTH_RATIO_MAX, RIGHTBAR_WIDTH_RATIO_MIN,
    announcementEventsOf, clampRightbarWidthRatio, modelFunction,
  } = PURE;

  /** 空过滤（冻结）：rootSessionId 为 null 表示「不属于任何 root」，任何 root 都按空过滤处理。 */
  const EMPTY_TASK_FILTER = Object.freeze({ rootSessionId: null, query: "", role: "", status: "" });

  /** 键盘调整的固定步长（2%），与拖拽共用同一条 clamp 通道。 */
  const WIDTH_RATIO_KEY_STEP = 0.02;

  /**
   * 宿主语言解析（票据 19）：ctx.locale → ctx.i18n.locale → useTabInfo().locale →
   * document.documentElement.lang → navigator.language → 默认 zh。
   *
   * 解析集中在挂载/渲染期做一次纯读；候选值只从注入面与环境读取，绝不写回。
   * 模型缺失（契约外直载、未装 model 模块）时退回 zh，保证既有中文断言不变。
   */
  function resolvePanelLocale(model, ctx, tabInfo) {
    const sources = {
      ctxLocale: (() => { try { return ctx?.locale; } catch { return undefined; } })(),
      i18nLocale: (() => { try { return ctx?.i18n?.locale; } catch { return undefined; } })(),
      tabInfo,
      documentLang: (() => {
        try { return globalThis.document?.documentElement?.lang; } catch { return undefined; }
      })(),
      navigatorLanguage: (() => {
        try { return globalThis.navigator?.language; } catch { return undefined; }
      })(),
    };
    if (typeof model?.resolveClientLocale === "function") return model.resolveClientLocale(sources);
    // 模型缺失的降级：只识别 en 前缀，其余一律 zh（与默认语言一致）。
    const candidates = [sources.ctxLocale, sources.i18nLocale, sources.tabInfo?.locale, sources.documentLang, sources.navigatorLanguage];
    return candidates.some((value) => typeof value === "string" && value.trim().toLowerCase().startsWith("en")) ? "en" : "zh";
  }

  /**
   * 文案查询入口：所有用户可见的核心文案都经它取消息表。
   * 缺失键由模型回退默认语言；模型缺失时最后退回空串以外的中性占位（不暴露键名）。
   */
  function createPanelTranslator(model, locale) {
    return function translate(key, vars) {
      if (typeof model?.translateMessage === "function") return model.translateMessage(locale, key, vars);
      return "—";
    };
  }

  /**
   * 错误槽短文案（票据 13 的来源分类 × 票据 19 的消息表）：
   * 只接受 snapshot / action / rpc 三个稳定来源；未知来源一律按 action 呈现，
   * 完整 message 仍只放在 title 属性里。
   */
  function errorLabelOf(t, source) {
    return t("sidebar.error." + (source === "snapshot" || source === "rpc" ? source : "action"));
  }

  /**
   * 客户端本地过滤（票据 12）的派生部分：只读内存快照，不新增 RPC、不写任何持久化。
   *
   * 三条语义：
   * - 过滤状态绑定 root：切换会话后旧搜索词/角色/状态不会把新会话的树整棵隐藏；
   * - 祖先路径保留：父级用 isVisible（自身命中，或任一子节点/分片命中）决定整棵子树是否展示；
   * - 批量 slot 在过滤期间隐藏：批量关闭作用于整棵树，不能让用户在「看不见候选」时误关。
   *
   * @returns {{ filterSource: any, taskFilter: any, filterActive: boolean, passesFilter: (node: any) => boolean }}
   */
  function selectTaskFilter(model, filterState, rootSessionId, emptyFilter = EMPTY_TASK_FILTER) {
    const filterSource = filterState.rootSessionId === rootSessionId ? filterState : emptyFilter;
    const filterFactory = modelFunction("createTaskFilter");
    let taskFilter = null;
    if (filterFactory !== null) {
      try { taskFilter = filterFactory(filterSource); } catch { taskFilter = null; }
    }
    const filterActive = taskFilter !== null && taskFilter.active === true;
    const passesFilter = (node) => (filterActive !== true || taskFilter.isVisible(node) === true);
    return { filterSource, taskFilter, filterActive, passesFilter };
  }

  /** 过滤输入的唯一写入形状：永远带当前 root，避免跨 root 串用搜索词。 */
  function nextFilterPatch(filterSource, patch, rootSessionId) {
    return { ...filterSource, ...patch, rootSessionId };
  }

  /**
   * 拖拽中的下一档比例：手柄在右栏左缘，指针向左拖 → 右栏更宽 → 比例增大。
   * 只做几何换算与 clamp；真正的写入（setRightbar / 持久化）由调用方通过 apply 注入面负责。
   *
   * @returns {number | null} null 表示这一帧没有可用的换算输入（viewport/坐标缺失）
   */
  function nextWidthRatioFromDrag(options) {
    const startX = Number(options?.startX);
    const clientX = Number(options?.clientX);
    const viewport = Number(options?.viewport);
    const startRatio = Number(options?.startRatio);
    if (Number.isFinite(startX) !== true || Number.isFinite(clientX) !== true) return null;
    if (Number.isFinite(viewport) !== true || viewport <= 0) return null;
    if (Number.isFinite(startRatio) !== true) return null;
    return clampRightbarWidthRatio(startRatio + (startX - clientX) / viewport);
  }

  /**
   * 键盘调整：Left 缩窄 / Right 加宽（每次 2%），Home/End 直达边界。
   * 与拖拽共用同一条 commit 路径（调用方负责持久化）。
   *
   * @returns {number | null} null 表示这个键不参与比例调整
   */
  function nextWidthRatioFromKey(key, current) {
    const base = clampRightbarWidthRatio(current) ?? RIGHTBAR_WIDTH_RATIO;
    if (key === "Home") return RIGHTBAR_WIDTH_RATIO_MIN;
    if (key === "End") return RIGHTBAR_WIDTH_RATIO_MAX;
    if (key === "ArrowLeft") return base - WIDTH_RATIO_KEY_STEP;
    if (key === "ArrowRight") return base + WIDTH_RATIO_KEY_STEP;
    return null;
  }
  /**
   * fanout 事件游标的 root 归属规整：root 变了就重开一份 { cursor: 0 }（旧 root 的游标对新 root 没有意义）。
   *
   * 返回**同一个对象**表示无需改动，返回新对象表示调用方要写回自己的 ref。
   */
  function normalizeFanoutCursor(cursor, rootSessionId) {
    if (cursor !== null && cursor !== undefined && cursor.rootSessionId === rootSessionId) return cursor;
    return { rootSessionId, cursor: 0 };
  }

  /**
   * 采纳一次快照响应里出现的游标（票据 15 的强制全量路径）。
   *
   * Host 当前的 expert-group-snapshot 响应**不带** cursor（契约只有 snapshot + revision），
   * 因此这里按「有就采纳、没有就保持」处理：
   * - 返回 null 时调用方什么都不做，下一轮 fanout-events 继续用当前游标（绝不伪造一个进度）；
   * - 只接受本 root 的响应：旧 root 的迟到响应不得改写新 root 的游标。
   */
  function adoptFanoutCursor(cursor, requestRoot, envelope) {
    const next = Number.isSafeInteger(envelope?.cursor) && envelope.cursor >= 0 ? envelope.cursor : null;
    if (next === null) return null;
    if (cursor.rootSessionId !== requestRoot) return null;
    return { rootSessionId: requestRoot, cursor: Math.max(cursor.cursor, next) };
  }

  /**
   * 把事件游标推进到 max(当前, 给定值)（票据 15）：null/非法值表示 Host 没给游标 ⇒ 原地不动，
   * 绝不伪造一个进度；只接受本 root 的推进（旧 root 的迟到结果不得改写新 root 的游标）。
   */
  function advanceFanoutCursor(cursor, rootSessionId, nextCursor) {
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0) return null;
    if (cursor.rootSessionId !== rootSessionId) return null;
    if (nextCursor <= cursor.cursor) return null;
    return { rootSessionId, cursor: nextCursor };
  }

  /**
   * surface 身份令牌：给每一条「跨 await 的异步动作」用的**不可复用**身份。
   *
   * 症状与根因：异步动作在 await 之后只用 mountedRef + currentRootRef + currentSidebarSessionRef
   * 复核「当前 surface」。这三条判据比较的是**当前字符串值**，于是同一次快速 root/session
   * A→B→A 之后，旧闭包捕获的字符串会与当前值**重新相等**——旧动作由此把自己的迟到收尾当成
   * 当前 surface 的收尾继续执行。字符串判据挡得住「切走了没回来」，挡不住「切走又切回」。
   *
   * 因此每个 Panel 实例在挂载时生成一份唯一身份，并在 sidebarSessionId / rootSessionId 每一次
   * 变化时换成**新对象**（A→B→A 两次都换）：异步动作启动时捕获自己那一份，await 之后只回答
   * 「还是不是我出发时那一份」。令牌必须比较对象身份，绝不能只比较当前字符串值。
   *
   * @returns {{ scope: any, token: any }} 两个 ref 各自要写回的值（未变化时返回原对象）
   */
  function deriveSurfaceToken(scope, token, rootSessionId, sidebarSessionId) {
    if (scope === null || scope === undefined
      || scope.rootSessionId !== rootSessionId
      || scope.sidebarSessionId !== sidebarSessionId) {
      return {
        scope: { rootSessionId, sidebarSessionId },
        token: { rootSessionId, sidebarSessionId },
      };
    }
    return { scope, token };
  }

  /**
   * 任务状态播报（票据 18）的基线推进与差异计算。
   *
   * 语义边界：
   * - 首次挂载 / 切换 root 时只建立基线，**绝不播报历史任务**（包括缓存首屏与重挂载）；
   * - 每次快照变化按 collectAnnouncementTasks + 本函数求差异，同内容轮询没有差异；
   * - 返回的 baseline 由调用方写回 ref（本函数不持有 ref）。
   */
  function nextAnnouncementBaseline(previous, rootSessionId, tasks) {
    const baseline = { rootSessionId, tasks };
    // 首次挂载或切换 root：只建立基线，绝不把已有任务补播成「开始/完成」。
    if (previous === null || previous === undefined || previous.rootSessionId !== rootSessionId) {
      return { baseline, events: [] };
    }
    return { baseline, events: announcementEventsOf(previous.tasks, tasks) };
  }

  /**
   * 播报文本：只在确实有事件时生成（同一帧最多一次 setState，aria-live 不会因轮询反复重读）。
   * 超过上限时追加一条「还有 N 条」；分隔符随语言切换（en 用分号+空格，中文用全角分号）。
   */
  function announcementTextOf(options) {
    const events = Array.isArray(options?.events) ? options.events : [];
    const t = options?.t;
    const maxItems = Number.isSafeInteger(options?.maxItems) ? options.maxItems : ANNOUNCEMENT_MAX_ITEMS;
    if (events.length === 0 || typeof t !== "function") return "";
    const visible = events.slice(0, maxItems).map((event) => t("announce." + event.kind, { name: event.name }));
    if (events.length > maxItems) visible.push(t("announce.more", { count: events.length }));
    return visible.join(options?.locale === "en" ? "; " : "；");
  }

  // 只暴露主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    EMPTY_TASK_FILTER,
    adoptFanoutCursor,
    advanceFanoutCursor,
    announcementTextOf,
    createPanelTranslator,
    deriveSurfaceToken,
    errorLabelOf,
    nextAnnouncementBaseline,
    nextFilterPatch,
    nextWidthRatioFromDrag,
    nextWidthRatioFromKey,
    normalizeFanoutCursor,
    resolvePanelLocale,
    selectTaskFilter,
  });
})(globalThis);
